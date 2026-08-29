/**
 * SWX fork tooling — hermetic guards for the fork's two shell scripts.
 *
 * Everything is hermetic: temporary git repos with local bare remotes (no
 * network), stubbed bun/gbrain/systemctl on a prepended PATH, and a REAL
 * loopback listener + REAL curl for the service-port test. That last part is
 * the point of the third test: asserting the unit FILE contains the port
 * would pass while the old process keeps serving the old port, so the
 * assertion has to be that the SERVING PROCESS answers on the selected port
 * after a re-run.
 *
 * Fail-without mapping — each verified by reverting ONLY that fix:
 *  1. argv run(): the pre-fix `--dry-run` renderer echoed "$*", which
 *     flattens argv into a space-joined string, so the printed command does
 *     not re-parse into what would actually run -> the stash message comes
 *     back as four bare words -> red.
 *     (NOT a stash-failure guard: the pre-fix `eval "$@"` runner executes the
 *     pre-quoted stash call site correctly — the single quotes survive the
 *     re-parse — so the non-dry-run path is identical either way. Reverting
 *     it was tried and the test stayed green, which is why this test asserts
 *     the dry-run rendering instead.)
 *  2. no-op-rebase gate: pre-fix, REBASED=1 armed the upgrade block on a
 *     no-change run -> the stub log records bun install / post-upgrade ->
 *     red.
 *  3. port templating + re-run: pre-fix setup.sh (a) never templated the
 *     unit (first install on a nondefault port dies at the probe -> red) and
 *     (b) `enable --now` on an already-active unit never restarted the
 *     process, so the re-run probe checked the NEW port against the OLD
 *     process -> red.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync } from 'fs';
import { execFileSync, spawnSync, type SpawnSyncOptions } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO_ROOT = join(import.meta.dir, '..');
const SAFE_UPDATE = join(REPO_ROOT, 'scripts', 'gbrain-safe-update');
const SETUP_SH = join(REPO_ROOT, 'deploy', 'local-http', 'setup.sh');

let sandbox: string;
let stubBin: string;
let stubLog: string;
let homeDir: string;

function writeStub(name: string, body: string): void {
  const p = join(stubBin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

/** Minimal env for the spawned script: stub PATH first, temp HOME, no fleet GBRAIN_* leak. */
function spawnEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${stubBin}:${process.env.PATH ?? ''}`,
    HOME: homeDir,
    TERM: 'dumb',
    // The scripts never see the box's live brain/service coordinates.
    // GBRAIN_HOME is a PARENT dir — gbrain's configDir() appends '.gbrain' —
    // so this must be the home, not the brain dir. (The fixture used to pass
    // the brain dir, which the canonical resolution turns into
    // <home>/.gbrain/.gbrain; caught by the round-2 backup tests.)
    GBRAIN_HOME: homeDir,
    GBRAIN_LINK: join(sandbox, 'self-link'),
    ...extra,
  };
  return env;
}

function runScript(script: string, args: string[], extraEnv: Record<string, string> = {}) {
  const opts: SpawnSyncOptions = { encoding: 'utf-8', timeout: 120_000, env: spawnEnv(extraEnv) };
  return spawnSync('bash', [script, ...args], opts);
}

/**
 * Build the safe-update fixture: bare upstream + install clone with a
 * package.json, `master` tracking origin/master, and a `swxtch` branch one
 * commit ahead. Mirror NOT behind upstream (the no-op-rebase condition).
 */
function buildSafeUpdateFixture(): string {
  const dir = join(sandbox, 'safe-update');
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', join(dir, 'upstream.git')]);
  execFileSync('git', ['clone', '-q', join(dir, 'upstream.git'), join(dir, 'install')]);
  const git = (...args: string[]) => execFileSync('git', ['-C', join(dir, 'install'), ...args]);
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 'T');
  writeFileSync(join(dir, 'install', 'package.json'), '{"version":"0.0.1"}\n');
  git('checkout', '-q', '-b', 'master');
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('push', '-q', '-u', 'origin', 'master');
  git('checkout', '-q', '-b', 'swxtch');
  writeFileSync(join(dir, 'install', 'custom.txt'), 'x\n');
  git('add', '-A');
  git('commit', '-qm', 'SWX custom');
  return join(dir, 'install');
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'swx-fork-tooling-'));
  stubBin = join(sandbox, 'bin');
  homeDir = join(sandbox, 'home');
  stubLog = join(sandbox, 'stub.log');
  mkdirSync(stubBin, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
});

/** Stub bun/gbrain (the safe-update upgrade-block externals). NOT written for
 * the setup.sh tests: the systemctl stub there launches a REAL bun listener. */
function stubSafeUpdateExternals(): void {
  for (const c of ['bun', 'gbrain']) {
    writeStub(c, `echo "${c} $*" >> "${stubLog}"\nexit 0`);
  }
  stubSafeUpdateSystemctl();
}

/**
 * `systemctl` for the safe-update tests. Without it the script reaches the
 * REAL user bus — `systemctl --user cat gbrain-http.service` would find this
 * box's live fleet service and read ITS port. Exits 1 for `cat`, the shape of
 * a machine with no such unit, which is what these fixtures represent.
 */
function stubSafeUpdateSystemctl(): void {
  writeStub('systemctl', `echo "systemctl $*" >> "${stubLog}"\nexit 1`);
}

/**
 * A `gbrain` stub that answers `config get <key>` from a table and logs every
 * invocation. `config get` exits 1 with nothing on stdout for an unset key,
 * which is exactly how the real CLI reports "not found" — the scripts' unset
 * branch depends on that shape.
 */
function stubGbrainConfig(values: Record<string, string>): void {
  const cases = Object.entries(values)
    .map(([k, v]) => `    ${k}) echo "${v}" ;;`)
    .join('\n');
  writeStub('gbrain', `echo "gbrain $*" >> "${stubLog}"
if [ "$1" = "config" ] && [ "$2" = "get" ]; then
  case "$3" in
${cases}
    *) exit 1 ;;
  esac
  exit 0
fi
exit 0`);
  writeStub('bun', `echo "bun $*" >> "${stubLog}"\nexit 0`);
  stubSafeUpdateSystemctl();
}

afterEach(() => {
  // The systemctl stub launches a REAL loopback listener and banks its pid in
  // the sandbox. Only the stub's own next `restart` reaps it, so a run that
  // ends early — a failing assertion, a filtered test — would leave the
  // process listening after the sandbox is gone. Reap it here instead.
  // Path mirrors the stub's `state_dir="${XDG_CONFIG_HOME}/fixture-state"`,
  // with XDG_CONFIG_HOME = <sandbox>/units in the setup.sh tests.
  const pidFile = join(sandbox, 'units', 'fixture-state', 'pid');
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf-8').trim());
    if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid); } catch { /* already gone */ } }
  }
  rmSync(sandbox, { recursive: true, force: true });
});

describe('scripts/gbrain-safe-update', () => {
  test('run() renders --dry-run commands that re-parse to the same argv', () => {
    stubSafeUpdateExternals();
    const install = buildSafeUpdateFixture();
    // Dirty a TRACKED file so `git diff --quiet` fails and the stash path runs.
    writeFileSync(join(install, 'package.json'), '{"version":"0.0.1","dirty":true}\n');
    const r = runScript(SAFE_UPDATE, ['--dry-run', '--no-backup'], { GBRAIN_DIR: install });
    expect({ status: r.status, stderr: r.stderr }).toEqual(expect.objectContaining({ status: 0 }));

    const line = String(r.stdout)
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('[dry-run] git stash push'));
    expect(line, `no dry-run stash line in:\n${r.stdout}`).toBeDefined();

    // The point of --dry-run is that the operator can read (and run) exactly
    // what the real path would execute. Re-parse the rendered line the way a
    // shell would and require it to reproduce the original argv — the stash
    // message must still be ONE argument. The pre-fix runner interpolated
    // "$*", which flattens argv into a space-joined string, so the message
    // re-parses into four bare words (git reads them as pathspecs).
    const argv = JSON.parse(
      execFileSync('bash', ['-c', `printf '%s\\n' ${line!.replace('[dry-run] ', '')} | ` +
        `python3 -c "import sys,json; print(json.dumps(sys.stdin.read().splitlines()))"`],
        { encoding: 'utf-8' }),
    );
    expect(argv).toEqual(['git', 'stash', 'push', '-u', '-m', 'gbrain-safe-update auto-stash']);
  });

  test('an unreadable engine ABORTS instead of silently skipping the backup', () => {
    // The reported defect: `|| echo pglite` turned "cannot determine the
    // engine" into "assume pglite", the pglite arm then matched nothing on a
    // Postgres brain, and the script ran migrations against the live brain
    // with no snapshot. A gbrain stub that cannot answer + no config.json is
    // exactly that state.
    stubGbrainConfig({}); // every `config get` exits 1
    const install = buildSafeUpdateFixture();
    // Force the upgrade block: make the mirror advance so REBASED/BEHIND arm.
    const upstream = join(sandbox, 'safe-update', 'upstream.git');
    const clone = join(sandbox, 'pusher');
    execFileSync('git', ['clone', '-q', upstream, clone]);
    execFileSync('git', ['-C', clone, 'config', 'user.email', 't@t.t']);
    execFileSync('git', ['-C', clone, 'config', 'user.name', 'T']);
    writeFileSync(join(clone, 'upstream.txt'), 'new\n');
    execFileSync('git', ['-C', clone, 'add', '-A']);
    execFileSync('git', ['-C', clone, 'commit', '-qm', 'upstream advance']);
    execFileSync('git', ['-C', clone, 'push', '-q', 'origin', 'HEAD:master']);

    const r = runScript(SAFE_UPDATE, [], { GBRAIN_DIR: install, GBRAIN_HOME: join(sandbox, 'brainhome') });

    expect(r.status).not.toBe(0);
    expect(String(r.stderr)).toContain('Cannot determine the brain engine');
    // And it aborted BEFORE migrations — the whole point of the backup block.
    const calls = existsSync(stubLog) ? readFileSync(stubLog, 'utf-8') : '';
    expect(calls).not.toContain('post-upgrade');
  });

  test('GBRAIN_HOME is a PARENT dir: the brain is read at <home>/.gbrain', () => {
    // gbrain's own configDir() appends '.gbrain' to GBRAIN_HOME. Treating the
    // override as the final directory inspects and backs up the wrong path.
    //
    // ARMED, round 3: this case used to leave the bare upstream un-advanced,
    // so BEHIND=0, the upgrade block never ran, and the engine read it asserts
    // on never executed — it passed with the config.json deleted, and with the
    // file written at the PRE-FIX location. advanceUpstream is what makes the
    // block reachable; the PGLite store makes the backup arm reachable; the
    // assertion is that the engine read SUCCEEDED and migrations ran.
    stubGbrainConfig({}); // both reads must fall through to config.json
    const install = buildSafeUpdateFixture();
    stubWriteThroughProbe(install, 'disabled');
    writeStub('bun', `echo "bun $*" >> "${stubLog}"\nexec ${process.execPath} "$@"`);
    writeStub('systemctl', `echo "systemctl $*" >> "${stubLog}"\nexit 1`);
    const brainHome = join(sandbox, 'brainhome');
    mkdirSync(join(brainHome, '.gbrain'), { recursive: true });
    writeFileSync(join(brainHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
    // The default store, at the CANONICAL location — reachable only if
    // BRAIN_DIR resolved to <home>/.gbrain rather than <home>.
    mkdirSync(join(brainHome, '.gbrain', 'brain.pglite'), { recursive: true });
    writeFileSync(join(brainHome, '.gbrain', 'brain.pglite', 'marker'), 'store\n');
    advanceUpstream('pusher-parentdir');

    const r = runScript(SAFE_UPDATE, [], { GBRAIN_DIR: install, GBRAIN_HOME: brainHome });

    expect({ status: r.status, stderr: r.stderr }).toEqual(expect.objectContaining({ status: 0 }));
    expect(String(r.stderr)).not.toContain('Cannot determine the brain engine');
    // Pre-fix (BRAIN_DIR=$GBRAIN_HOME) the config read finds nothing at
    // <home>/config.json and the run dies before here.
    const calls = existsSync(stubLog) ? readFileSync(stubLog, 'utf-8') : '';
    expect(calls).toContain('post-upgrade');
    // And the backup landed under the canonical dir, not the override itself.
    expect(existsSync(join(brainHome, '.gbrain', 'backups'))).toBe(true);
    expect(existsSync(join(brainHome, 'backups'))).toBe(false);
  });

  /** Advance the bare upstream so BEHIND != 0 and the upgrade block runs. */
  function advanceUpstream(tag: string): void {
    const upstream = join(sandbox, 'safe-update', 'upstream.git');
    const clone = join(sandbox, tag);
    execFileSync('git', ['clone', '-q', upstream, clone]);
    execFileSync('git', ['-C', clone, 'config', 'user.email', 't@t.t']);
    execFileSync('git', ['-C', clone, 'config', 'user.name', 'T']);
    writeFileSync(join(clone, 'upstream.txt'), `new ${tag}\n`);
    execFileSync('git', ['-C', clone, 'add', '-A']);
    execFileSync('git', ['-C', clone, 'commit', '-qm', `upstream advance ${tag}`]);
    execFileSync('git', ['-C', clone, 'push', '-q', 'origin', 'HEAD:master']);
  }

  /**
   * Stand in for deploy/local-http/write-through-probe.ts inside the fixture
   * checkout. The scripts locate the probe relative to their own tree, so the
   * fixture gets its own copy printing the state under test — which is also
   * what keeps these tests off the box's real brain.
   */
  function stubWriteThroughProbe(install: string, state: string): void {
    const dir = join(install, 'deploy', 'local-http');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'write-through-probe.ts'), `console.log('${state}');\n`);
  }

  test('NO unit installed → the gate does not fire at all', () => {
    // The scope predicate. gbrain-http.service being installed is what makes
    // "shared, DB-authoritative brain" true. On a box without it this is an
    // ordinary PGLite/file-authoritative brain, where an unset key is the
    // fork's CORRECT inherited posture — and telling that operator to run
    // `sync.write_through false` would disable the .md mirror that IS the
    // brain's source of truth.
    stubGbrainConfig({ engine: 'pglite' });
    const install = buildSafeUpdateFixture();
    stubWriteThroughProbe(install, 'enabled:unset');
    writeStub('bun', `echo "bun $*" >> "${stubLog}"\nexec ${process.execPath} "$@"`);
    // `cat` exits 1 = no such unit.
    writeStub('systemctl', `echo "systemctl $*" >> "${stubLog}"\nexit 1`);
    advanceUpstream('pusher-no-unit');

    const r = runScript(SAFE_UPDATE, [], { GBRAIN_DIR: install });
    const out = `${r.stdout}${r.stderr}`;

    expect({ status: r.status, stderr: r.stderr }).toEqual(expect.objectContaining({ status: 0 }));
    // No refusal, no advice to turn the mirror off, and the honest no-unit
    // branch is reached instead of being masked by the gate.
    expect(out).not.toContain('refusing to update');
    expect(out).not.toContain('gbrain config set sync.write_through false');
    expect(out).toContain('not installed');
    // The upgrade ran to completion.
    const calls = existsSync(stubLog) ? readFileSync(stubLog, 'utf-8') : '';
    expect(calls).toContain('post-upgrade');
  });

  test('unit installed + undecided posture → ABORTS BEFORE the rebase', () => {
    // The rebase is the irreversible step: the gbrain CLI is bun-linked to
    // this checkout, so every new process on the box runs the new code the
    // instant it lands. Suppressing the later restart establishes nothing —
    // the unit is enabled with Restart=on-failure, so systemd re-activates it
    // anyway. The observable is that the tree is UNTOUCHED.
    stubGbrainConfig({ engine: 'pglite' });
    const install = buildSafeUpdateFixture();
    stubWriteThroughProbe(install, 'enabled:unset');
    writeStub('bun', `echo "bun $*" >> "${stubLog}"\nexec ${process.execPath} "$@"`);
    writeStub('systemctl', `echo "systemctl $*" >> "${stubLog}"\nexit 0`);
    advanceUpstream('pusher-abort');
    const headBefore = execFileSync('git', ['-C', install, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();

    const r = runScript(SAFE_UPDATE, [], { GBRAIN_DIR: install });

    expect(r.status).not.toBe(0);
    expect(String(r.stderr)).toContain('refusing to update');
    // Nothing happened: no rebase, no install, no migrations, no restart.
    expect(execFileSync('git', ['-C', install, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim())
      .toBe(headBefore);
    const calls = existsSync(stubLog) ? readFileSync(stubLog, 'utf-8') : '';
    expect(calls).not.toContain('bun install');
    expect(calls).not.toContain('post-upgrade');
    expect(calls).not.toContain('systemctl --user restart');
  });

  /** Unit present + undecided posture: the shape the gate is written for. */
  function gatedFixture(tag: string): string {
    stubGbrainConfig({ engine: 'pglite' });
    const install = buildSafeUpdateFixture();
    stubWriteThroughProbe(install, 'enabled:unset');
    writeStub('bun', `echo "bun $*" >> "${stubLog}"\nexec ${process.execPath} "$@"`);
    writeStub('systemctl', `echo "systemctl $*" >> "${stubLog}"\nexit 0`);  // unit IS installed
    writeStub('curl', `echo "curl $*" >> "${stubLog}"\nexit 0`);
    void tag;
    return install;
  }

  test('--check is a READ: the gate does not fire, even with the unit installed', () => {
    // The regression the gate move introduced. --check's whole contract is
    // "change nothing", and its documented job is to report. Charging a
    // recorded posture decision as the price of a read also inverts the gate's
    // own principle — the only ways to make the read succeed were to change
    // the brain's config or to declare "keep the mirrors, on purpose".
    const install = gatedFixture('check');
    advanceUpstream('pusher-check');

    const r = runScript(SAFE_UPDATE, ['--check'], { GBRAIN_DIR: install });

    expect({ status: r.status, stderr: r.stderr }).toEqual(expect.objectContaining({ status: 0 }));
    expect(`${r.stdout}${r.stderr}`).not.toContain('refusing to update');
  });

  test('--dry-run REPORTS what a real run would refuse, and exits 0', () => {
    // Dry-run's job is to say what would happen — so the gate speaks, but as a
    // prediction rather than a refusal, and nothing on disk moves.
    const install = gatedFixture('dryrun');
    advanceUpstream('pusher-dryrun');
    const headBefore = execFileSync('git', ['-C', install, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();

    const r = runScript(SAFE_UPDATE, ['--dry-run', '--no-backup'], { GBRAIN_DIR: install });
    const out = `${r.stdout}${r.stderr}`;

    expect({ status: r.status, stderr: r.stderr }).toEqual(expect.objectContaining({ status: 0 }));
    expect(out).toContain('[dry-run]');
    expect(out).toContain('would REFUSE to update');
    expect(execFileSync('git', ['-C', install, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim())
      .toBe(headBefore);
  });

  test('a run that would land no code does not fire the gate', () => {
    // Mirror current AND the custom branch already sitting on it: the rebase
    // below would be a no-op, so there is no posture decision to force.
    const install = gatedFixture('noop');
    // No advanceUpstream, and put swxtch onto master so nothing replays.
    execFileSync('git', ['-C', install, 'checkout', '-q', 'swxtch']);
    execFileSync('git', ['-C', install, 'reset', '--hard', '-q', 'master']);

    const r = runScript(SAFE_UPDATE, [], { GBRAIN_DIR: install });

    expect({ status: r.status, stderr: r.stderr }).toEqual(expect.objectContaining({ status: 0 }));
    expect(`${r.stdout}${r.stderr}`).not.toContain('refusing to update');
  });

  test('HOLE GUARD: BEHIND=0 but the custom branch is behind the mirror → still aborts', () => {
    // A naive `BEHIND=0 → skip` passes the case above and fails here. With the
    // mirror already current, the rebase block STILL replays the custom branch
    // when it does not yet sit on the mirror (a prior aborted run, or a
    // hand-fast-forwarded mirror), and that replay lands new code.
    const install = gatedFixture('hole');
    // Advance the mirror locally WITHOUT advancing origin: BEHIND stays 0
    // while swxtch is left behind master.
    execFileSync('git', ['-C', install, 'checkout', '-q', 'master']);
    writeFileSync(join(install, 'mirror-only.txt'), 'landed via rebase\n');
    execFileSync('git', ['-C', install, 'add', '-A'], { cwd: install });
    execFileSync('git', ['-C', install, 'commit', '-qm', 'mirror advance']);
    execFileSync('git', ['-C', install, 'push', '-q', 'origin', 'master']);
    execFileSync('git', ['-C', install, 'checkout', '-q', 'swxtch']);
    const headBefore = execFileSync('git', ['-C', install, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();

    const r = runScript(SAFE_UPDATE, [], { GBRAIN_DIR: install });

    expect(r.status).not.toBe(0);
    expect(String(r.stderr)).toContain('refusing to update');
    expect(execFileSync('git', ['-C', install, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim())
      .toBe(headBefore);
  });

  test('an unresolvable posture names a remedy a re-run can actually reach', () => {
    // The two undecided shapes are not the same problem: re-running cures
    // neither a missing probe nor bun off PATH, so printing the enabled-arm
    // "config set … then re-run this" there sends the operator nowhere.
    stubGbrainConfig({ engine: 'pglite' });
    const install = buildSafeUpdateFixture();  // no probe file at all
    writeStub('bun', `echo "bun $*" >> "${stubLog}"\nexec ${process.execPath} "$@"`);
    writeStub('systemctl', `echo "systemctl $*" >> "${stubLog}"\nexit 0`);
    advanceUpstream('pusher-remedy');

    const r = runScript(SAFE_UPDATE, [], { GBRAIN_DIR: install });
    const err = String(r.stderr);

    expect(r.status).not.toBe(0);
    expect(err).toContain('unknown:probe-missing');
    expect(err).toContain('restore');
    expect(err, 'the unknown arm printed the enabled arm\'s remedy')
      .not.toContain('gbrain config set sync.write_through false');
  });

  test('GBRAIN_ALLOW_WRITE_THROUGH=1 records the decision and lets the update run', () => {
    stubGbrainConfig({ engine: 'pglite' });
    const install = buildSafeUpdateFixture();
    stubWriteThroughProbe(install, 'enabled:unset');
    writeStub('bun', `echo "bun $*" >> "${stubLog}"\nexec ${process.execPath} "$@"`);
    writeStub('systemctl', `echo "systemctl $*" >> "${stubLog}"\nexit 0`);
    writeStub('curl', `echo "curl $*" >> "${stubLog}"\nexit 0`);
    advanceUpstream('pusher-allow');

    const r = runScript(SAFE_UPDATE, [], { GBRAIN_DIR: install, GBRAIN_ALLOW_WRITE_THROUGH: '1' });

    expect(`${r.stdout}${r.stderr}`).toContain('GBRAIN_ALLOW_WRITE_THROUGH=1');
    const calls = existsSync(stubLog) ? readFileSync(stubLog, 'utf-8') : '';
    expect(calls).toContain('post-upgrade');
    expect(calls).toContain('systemctl --user restart');
  });

  test('unit installed + decided posture → updates without comment', () => {
    stubGbrainConfig({ engine: 'pglite' });
    const install = buildSafeUpdateFixture();
    stubWriteThroughProbe(install, 'disabled');
    writeStub('bun', `echo "bun $*" >> "${stubLog}"\nexec ${process.execPath} "$@"`);
    writeStub('systemctl', `echo "systemctl $*" >> "${stubLog}"\nexit 0`);
    writeStub('curl', `echo "curl $*" >> "${stubLog}"\nexit 0`);
    advanceUpstream('pusher-off');

    const r = runScript(SAFE_UPDATE, [], { GBRAIN_DIR: install });
    const out = `${r.stdout}${r.stderr}`;

    expect(out).toContain('brain stays DB-only');
    expect(out).not.toContain('refusing to update');
    const calls = existsSync(stubLog) ? readFileSync(stubLog, 'utf-8') : '';
    expect(calls).toContain('systemctl --user restart');
  });

  test('unit installed + unresolvable posture also aborts — unverified is not a pass', () => {
    stubGbrainConfig({ engine: 'pglite' });
    const install = buildSafeUpdateFixture();
    // No probe file in the fixture checkout at all.
    writeStub('bun', `echo "bun $*" >> "${stubLog}"\nexec ${process.execPath} "$@"`);
    writeStub('systemctl', `echo "systemctl $*" >> "${stubLog}"\nexit 0`);
    advanceUpstream('pusher-unknown');

    const r = runScript(SAFE_UPDATE, [], { GBRAIN_DIR: install });

    expect(r.status).not.toBe(0);
    expect(String(r.stderr)).toContain('refusing to update');
    const calls = existsSync(stubLog) ? readFileSync(stubLog, 'utf-8') : '';
    expect(calls).not.toContain('post-upgrade');
  });

  test('a custom database_path PGLite store is the one backed up', () => {
    // Round-2: the elif copied the literal <brain>/brain.pglite, so a
    // custom-path brain matched no arm, wrote no snapshot, printed nothing,
    // and reached post-upgrade with no net.
    const brainHome = join(sandbox, 'bh-custom');
    const customStore = join(sandbox, 'elsewhere', 'my-brain.pglite');
    mkdirSync(join(brainHome, '.gbrain'), { recursive: true });
    mkdirSync(customStore, { recursive: true });
    writeFileSync(join(customStore, 'marker'), 'store contents\n');
    writeFileSync(
      join(brainHome, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: customStore }),
    );
    stubGbrainConfig({}); // force the config.json fallback for BOTH reads
    const install = buildSafeUpdateFixture();
    stubWriteThroughProbe(install, 'disabled');
    writeStub('bun', `echo "bun $*" >> "${stubLog}"\nexec ${process.execPath} "$@"`);
    writeStub('systemctl', `echo "systemctl $*" >> "${stubLog}"\nexit 0`);
    writeStub('curl', `echo "curl $*" >> "${stubLog}"\nexit 0`);
    advanceUpstream('pusher-pg-custom');

    const r = runScript(SAFE_UPDATE, [], { GBRAIN_DIR: install, GBRAIN_HOME: brainHome });

    expect({ status: r.status, stderr: r.stderr }).toEqual(expect.objectContaining({ status: 0 }));
    const backups = join(brainHome, '.gbrain', 'backups');
    const made = existsSync(backups) ? readdirSync(backups) : [];
    expect(made.some((f) => f.startsWith('my-brain.pglite.bak-')), `backups: ${made.join(',')}`).toBe(true);
    // And the copy is the real store, not an empty placeholder.
    const copied = made.find((f) => f.startsWith('my-brain.pglite.bak-'))!;
    expect(existsSync(join(backups, copied, 'marker'))).toBe(true);
  });

  test('an unresolvable PGLite store ABORTS rather than skipping the snapshot', () => {
    const brainHome = join(sandbox, 'bh-missing');
    mkdirSync(join(brainHome, '.gbrain'), { recursive: true });
    writeFileSync(
      join(brainHome, '.gbrain', 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: join(sandbox, 'no', 'such', 'store') }),
    );
    stubGbrainConfig({});
    const install = buildSafeUpdateFixture();
    stubWriteThroughProbe(install, 'disabled');
    writeStub('bun', `echo "bun $*" >> "${stubLog}"\nexec ${process.execPath} "$@"`);
    writeStub('systemctl', `echo "systemctl $*" >> "${stubLog}"\nexit 0`);
    advanceUpstream('pusher-pg-missing');

    const r = runScript(SAFE_UPDATE, [], { GBRAIN_DIR: install, GBRAIN_HOME: brainHome });

    expect(r.status).not.toBe(0);
    expect(String(r.stderr)).toContain('PGLite store not found');
    const calls = existsSync(stubLog) ? readFileSync(stubLog, 'utf-8') : '';
    expect(calls, 'migrations ran without a backup').not.toContain('post-upgrade');
  });

  test('the health probe follows the port in the INSTALLED unit, not a literal', () => {
    // One port contract. setup.sh templates GBRAIN_HTTP_PORT into the unit's
    // ExecStart, so a literal 8787 here meant every update of a moved service
    // spent 30s probing a dead port and reported a false "did not pass
    // health". The stub reports a unit on a non-default port and answers
    // is-active, so the script's probe URL is observable in what it prints.
    const movedPort = 39117;
    writeStub('systemctl', `echo "systemctl $*" >> "${stubLog}"
if [ "$2" = "cat" ]; then
  echo "[Service]"
  echo "ExecStart=/x/bun /x/gbrain serve --http --port ${movedPort} --bind 127.0.0.1"
  exit 0
fi
exit 0`);
    writeStub('bun', `echo "bun $*" >> "${stubLog}"\nexec ${process.execPath} "$@"`);
    writeStub('gbrain', `echo "gbrain $*" >> "${stubLog}"
if [ "$1" = "config" ] && [ "$2" = "get" ]; then
  case "$3" in
    engine) echo "pglite" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
exit 0`);
    // The curl stub SUCCEEDS so the probe loop breaks on its first iteration:
    // what is asserted is WHICH url the script probed, and a failing stub
    // would spend the full 30s retry budget to prove the same thing.
    writeStub('curl', `echo "curl $*" >> "${stubLog}"\nexit 0`);

    const install = buildSafeUpdateFixture();
    // This test is about the port contract, not the write-through posture —
    // give it a decided one so the gate (which sits above the REBASE, not the
    // restart) lets it through.
    stubWriteThroughProbe(install, 'disabled');
    const upstream = join(sandbox, 'safe-update', 'upstream.git');
    const clone = join(sandbox, 'pusher4');
    execFileSync('git', ['clone', '-q', upstream, clone]);
    execFileSync('git', ['-C', clone, 'config', 'user.email', 't@t.t']);
    execFileSync('git', ['-C', clone, 'config', 'user.name', 'T']);
    writeFileSync(join(clone, 'upstream.txt'), 'new\n');
    execFileSync('git', ['-C', clone, 'add', '-A']);
    execFileSync('git', ['-C', clone, 'commit', '-qm', 'upstream advance']);
    execFileSync('git', ['-C', clone, 'push', '-q', 'origin', 'HEAD:master']);

    runScript(SAFE_UPDATE, [], { GBRAIN_DIR: install });

    const calls = existsSync(stubLog) ? readFileSync(stubLog, 'utf-8') : '';
    expect(calls, 'the script never probed the moved port').toContain(`127.0.0.1:${movedPort}/health`);
    expect(calls).not.toContain('127.0.0.1:8787/health');
  });

  test('no-op rebase does not arm the upgrade block (no install/migrate/restart)', () => {
    stubSafeUpdateExternals();  // systemctl stub exits 1 = no unit, so the gate is out of scope
    const install = buildSafeUpdateFixture();
    const r = runScript(SAFE_UPDATE, ['--no-backup'], { GBRAIN_DIR: install });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Rebase was a no-op');
    const calls = existsSync(stubLog) ? readFileSync(stubLog, 'utf-8') : '';
    expect(calls).not.toContain('bun install');
    expect(calls).not.toContain('post-upgrade');
    // `systemctl --user restart`, not bare 'systemctl': round 3 added a
    // read-only `systemctl --user cat` ahead of everything to decide whether
    // the write-through gate is even in scope. Scope detection is not the
    // upgrade block, which is what this case is about.
    expect(calls).not.toContain('systemctl --user restart');
  });
});

describe('deploy/local-http/setup.sh', () => {
  // A systemctl stub with systemd's actual enable/restart semantics:
  //  - `enable --now` on an already-active unit is a NO-OP (the round-2 gap);
  //  - `restart` (re)launches the serving process from the CURRENT installed
  //  unit file — a REAL loopback listener on the unit's --port, so the
  //  setup probe (real curl) can only pass when the serving process moved.
  const REAL_BUN = process.execPath; // the real bun — PATH's head is the stub dir
  const SYSTEMCTL_STUB = `state_dir="${'$'}{XDG_CONFIG_HOME}/fixture-state"
mkdir -p "$state_dir"
unit_file="${'$'}{XDG_CONFIG_HOME}/systemd/user/gbrain-http.service"
cmd=""
args=()
for a in "$@"; do
  case "$a" in
    --user) ;;
    daemon-reload) exit 0 ;;
    cat) exit 0 ;;
    enable|restart|status) cmd="$a" ;;
    --now) cmd="enable-now" ;;
    *.service) args+=("$a") ;;
  esac
done
start_listener() {
  local port
  port=$(grep -oP -- '--port \\K[0-9]+' "$unit_file") || exit 1
  if [ -f "$state_dir/pid" ]; then kill "$(cat "$state_dir/pid")" 2>/dev/null; fi
  LP="$port" nohup "${REAL_BUN}" -e 'Bun.serve({ port: Number(process.env.LP), fetch: () => new Response("ok") })' >/dev/null 2>&1 &
  echo $! > "$state_dir/pid"
  echo "$port" > "$state_dir/listening"
}
case "$cmd" in
  enable) touch "$state_dir/enabled" ;;
  enable-now) [ -f "$state_dir/listening" ] || start_listener ;;  # no-op when active
  restart) start_listener ;;
  status) exit 0 ;;
esac
exit 0`;

  function freePort(): number {
    const s = Bun.serve({ port: 0, fetch: () => new Response('x') });
    // `port` is typed optional (a unix-socket server has none); a TCP
    // ephemeral bind always reports one, so treat a missing value as a
    // real failure rather than defaulting to a port we never bound.
    const p = s.port;
    s.stop(true);
    if (typeof p !== 'number') throw new Error('ephemeral bind reported no port');
    return p;
  }

  test('an undecided posture stops before ANY state change (round-3 placement)', () => {
    // Round-1 checked after the restart; round-2 moved it above the restart
    // but left `cp` of the unit and the `sed -i --port` above it, so a refusal
    // still left a rewritten unit on disk naming a port the running process
    // did not use. The assertion is that NOTHING was written or run.
    writeStub('systemctl', `echo "systemctl $*" >> "${stubLog}"\nexit 0`);
    // The real probe runs here (setup.sh finds it beside itself in the repo)
    // and reports unknown:no-brain-configured against the empty sandbox HOME.
    const unitsRoot = join(sandbox, 'units-gate');

    const r = runScript(SETUP_SH, [], { XDG_CONFIG_HOME: unitsRoot });

    expect(r.status).toBe(3);
    expect(String(r.stderr)).toContain('Refusing to install');
    expect(String(r.stderr)).toContain('Nothing has been installed or started');
    const calls = existsSync(stubLog) ? readFileSync(stubLog, 'utf-8') : '';
    expect(calls).not.toContain('systemctl --user restart');
    expect(calls).not.toContain('systemctl --user enable');
    expect(calls).not.toContain('daemon-reload');
    // No unit file on disk: the cp never ran.
    expect(existsSync(join(unitsRoot, 'systemd', 'user', 'gbrain-http.service'))).toBe(false);
  });

  test('the enabled arm refuses too — the condition the gate was written for', () => {
    // claude 7: the `enabled:*` arm — an unset key on a real brain, the actual
    // field condition — had no test. The unknown arm and this one both exit 3,
    // so only a probe reporting `enabled:` distinguishes them.
    writeStub('systemctl', `echo "systemctl $*" >> "${stubLog}"\nexit 0`);
    const unitsRoot = join(sandbox, 'units-enabled');
    // Point setup.sh at a fixture copy of the tree whose probe reports enabled.
    const fakeRepo = join(sandbox, 'fake-deploy', 'deploy', 'local-http');
    mkdirSync(fakeRepo, { recursive: true });
    writeFileSync(join(fakeRepo, 'write-through-probe.ts'), "console.log('enabled:unset');\n");
    writeFileSync(join(fakeRepo, 'gbrain-http.service'), '[Service]\nExecStart=/x --port 8787\n');
    writeFileSync(join(fakeRepo, 'setup.sh'), readFileSync(SETUP_SH, 'utf-8'));

    const r = runScript(join(fakeRepo, 'setup.sh'), [], { XDG_CONFIG_HOME: unitsRoot });

    expect(r.status).toBe(3);
    expect(String(r.stderr)).toContain('disk mirroring would be ON');
    expect(String(r.stderr)).toContain('enabled:unset');
    expect(existsSync(join(unitsRoot, 'systemd', 'user', 'gbrain-http.service'))).toBe(false);
  });

  test('after a port-change re-run, the SERVING process answers on the selected port', async () => {
    writeStub('systemctl', SYSTEMCTL_STUB);
    const unitsRoot = join(sandbox, 'units');
    const port1 = freePort();
    const port2 = freePort();
    const env = { XDG_CONFIG_HOME: unitsRoot };

    // First install on a non-default port: the unit file alone passing is not
    // enough — the probe must reach a process on port1.
    const first = runScript(SETUP_SH, [], { ...env, GBRAIN_HTTP_PORT: String(port1), GBRAIN_ALLOW_WRITE_THROUGH: '1' });
    expect({ status: first.status, stderr: first.stderr }).toEqual(expect.objectContaining({ status: 0 }));

    // Re-run with a different port (the upgrade/retemplate path). Pre-fix,
    // enable --now is a no-op on the active unit, the old process keeps
    // port1, and the probe of port2 times out -> exit 1. Post-fix, restart
    // moves the process; the probe reaches it.
    const second = runScript(SETUP_SH, [], { ...env, GBRAIN_HTTP_PORT: String(port2), GBRAIN_ALLOW_WRITE_THROUGH: '1' });
    expect({ status: second.status, stderr: second.stderr, stdout: second.stdout }).toEqual(
      expect.objectContaining({ status: 0 }),
    );

    // The property, stated against the process and not the file: the selected
    // port answers, and the old one is dead (the process MOVED).
    const onNew = spawnSync('curl', ['-fsS', '--max-time', '3', `http://127.0.0.1:${port2}/health`], { encoding: 'utf-8' });
    expect(onNew.status).toBe(0);
    const onOld = spawnSync('curl', ['-fsS', '--max-time', '3', `http://127.0.0.1:${port1}/health`], { encoding: 'utf-8' });
    expect(onOld.status).not.toBe(0);

    // teardown: kill the fixture listener
    const pidFile = join(unitsRoot, 'fixture-state', 'pid');
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, 'utf-8').trim())); } catch { /* already gone */ }
    }
  }, 120_000);
});
