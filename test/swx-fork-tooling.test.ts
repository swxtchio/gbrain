/**
 * SWX fork tooling — hermetic guards for the round-1 shell fixes.
 *
 * Round-2 blocking item: three round-1 fixes shipped with no test that can
 * fail. These three tests are the guards. Everything is hermetic: temporary
 * git repos with local bare remotes (no network), stubbed bun/gbrain/
 * systemctl on a prepended PATH, and a REAL loopback listener + REAL curl
 * for the service-port test (the round-2 anti-gap: asserting the unit FILE
 * contains the port would pass while the old process keeps serving the old
 * port — the assertion must be that the SERVING PROCESS answers on the
 * selected port after a re-run).
 *
 * Fail-without mapping:
 *  1. argv run(): under the old `eval "$@"` runner, the stash call site's
 *     spaced message ("gbrain-safe-update auto-stash") re-parses into a
 *     pathspec that matches nothing -> nonzero exit under set -e -> red.
 *  2. no-op-rebase gate: pre-fix, REBASED=1 armed the upgrade block on a
 *     no-change run -> the stub log would record bun install / post-upgrade /
 *     systemctl restart -> red.
 *  3. port templating + re-run: pre-fix setup.sh (a) never templated the
 *     unit (first install on a nondefault port dies at the probe -> red) and
 *     (b) `enable --now` on an already-active unit never restarted the
 *     process, so the re-run probe checked the NEW port against the OLD
 *     process -> red.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
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
    GBRAIN_HOME: join(homeDir, '.gbrain'),
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
}

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('scripts/gbrain-safe-update', () => {
  test('run() preserves argv: a spaced stash message round-trips a dirty tree', () => {
    stubSafeUpdateExternals();
    const install = buildSafeUpdateFixture();
    // Dirty a TRACKED file so `git diff --quiet` fails and the stash path runs.
    writeFileSync(join(install, 'package.json'), '{"version":"0.0.1","dirty":true}\n');
    const r = runScript(SAFE_UPDATE, ['--no-backup'], { GBRAIN_DIR: install });
    expect({ status: r.status, stderr: r.stderr, stdout: r.stdout }).toEqual(
      expect.objectContaining({ status: 0 }),
    );
    // The stash was pushed AND popped: the dirty edit is back in the tree.
    expect(readFileSync(join(install, 'package.json'), 'utf-8')).toContain('"dirty":true');
  });

  test('no-op rebase does not arm the upgrade block (no install/migrate/restart)', () => {
    stubSafeUpdateExternals();
    const install = buildSafeUpdateFixture();
    const r = runScript(SAFE_UPDATE, ['--no-backup'], { GBRAIN_DIR: install });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Rebase was a no-op');
    const calls = existsSync(stubLog) ? readFileSync(stubLog, 'utf-8') : '';
    expect(calls).not.toContain('bun install');
    expect(calls).not.toContain('post-upgrade');
    expect(calls).not.toContain('systemctl');
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

  test('after a port-change re-run, the SERVING process answers on the selected port', async () => {
    writeStub('systemctl', SYSTEMCTL_STUB);
    const unitsRoot = join(sandbox, 'units');
    const port1 = freePort();
    const port2 = freePort();
    const env = { XDG_CONFIG_HOME: unitsRoot };

    // First install on a non-default port: the unit file alone passing is not
    // enough — the probe must reach a process on port1.
    const first = runScript(SETUP_SH, [], { ...env, GBRAIN_HTTP_PORT: String(port1) });
    expect({ status: first.status, stderr: first.stderr }).toEqual(expect.objectContaining({ status: 0 }));

    // Re-run with a different port (the upgrade/retemplate path). Pre-fix,
    // enable --now is a no-op on the active unit, the old process keeps
    // port1, and the probe of port2 times out -> exit 1. Post-fix, restart
    // moves the process; the probe reaches it.
    const second = runScript(SETUP_SH, [], { ...env, GBRAIN_HTTP_PORT: String(port2) });
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
