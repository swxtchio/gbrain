/**
 * SWX — the lands-code predicate, crossed exhaustively.
 *
 * `scripts/gbrain-safe-update` answers ONE question — will this invocation
 * change the code the box executes — and every consumer reads that one answer
 * (`RUN_LANDS_CODE`, computed once before any mutation; see the CONTRACT block
 * in the script). Four review rounds produced four non-equivalent answers to
 * it, each correct for the inputs its author had in mind and wrong for
 * someone else's, so this file exists to make "correct for the inputs I had in
 * mind" impossible to ship.
 *
 * INDEXING. Cells are indexed by (branch state x mode x posture), because the
 * guard set's blindness three rounds running came from indexing by SITE alone:
 * every arming cell asserted absence, all on real runs; every gate cell
 * launched from the custom branch. Both holes were on axes the round had
 * "added coverage along".
 *
 *   branch states  custom present: current | behind | ahead | diverged |
 *                                   lagging-mirror
 *                  custom ABSENT:   launched on mirror | on a third branch |
 *                                   detached
 *   modes          real | --check | --dry-run  (x with/without the opt-in)
 *   postures       unset | disabled | enabled-explicit
 *
 * Custom-branch PRESENCE and LAUNCH REF are parameters of the fixture, not
 * fixed properties of it. They are the two inputs the predicate reads, and an
 * earlier revision of this file held both constant — creating `swxtch` in
 * every cell and launching from `swxtch` or `master` — while its header
 * claimed to make "correct for the inputs I had in mind" impossible to ship.
 * It shipped exactly that, twice over, in opposite directions.
 *
 * Every production consumer of RUN_LANDS_CODE is asserted: the posture gate,
 * the upgrade block, AND the closing summary. The summary went unasserted for
 * a round, which is why a false "new code landed" was invisible.
 *
 * Each cell asserts the predicate's answer through an observable consequence,
 * and the landing states additionally assert the INVARIANT the contract
 * promises: what --dry-run predicts is what the real run does.
 *
 * `.serial.test.ts` because every cell builds real git repositories and spawns
 * the script.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { execFileSync, spawnSync, type SpawnSyncOptions } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO_ROOT = join(import.meta.dir, '..');
const SAFE_UPDATE = join(REPO_ROOT, 'scripts', 'gbrain-safe-update');

/** Does the run change the code the box executes? */
type Lands = 'lands' | 'no-op';
/** Branch topology at launch, WITH the custom branch present. */
type BranchState = 'current' | 'behind' | 'ahead' | 'diverged' | 'lagging-mirror';
/**
 * Topology with NO custom branch. The rebase block is skipped entirely here,
 * so the only ref that can move is the mirror — a different question, and the
 * axis this file previously held constant while claiming to be exhaustive.
 * The launch ref is what decides the answer, so it is the axis.
 */
type NoCustomState = 'no-custom-on-mirror' | 'no-custom-third-branch' | 'no-custom-detached';
/** DB-plane sync.write_through as the probe would report it. */
type Posture = 'unset' | 'disabled' | 'enabled';

let sandbox: string;
let stubBin: string;
let stubLog: string;
let homeDir: string;

function writeStub(name: string, body: string): void {
  const p = join(stubBin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8' }).trim();
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'swx-matrix-'));
  stubBin = join(sandbox, 'bin');
  homeDir = join(sandbox, 'home');
  stubLog = join(sandbox, 'stub.log');
  mkdirSync(stubBin, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Build the install fixture in the requested branch state.
 *
 * Baseline: bare upstream + clone, `master` mirroring it, `swxtch` one commit
 * ahead, launched on `swxtch`.
 */
function fixture(state: BranchState | NoCustomState): string {
  const dir = join(sandbox, 'inst');
  mkdirSync(dir, { recursive: true });
  const bare = join(dir, 'upstream.git');
  const install = join(dir, 'install');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['clone', '-q', bare, install]);
  git(install, 'config', 'user.email', 't@t.t');
  git(install, 'config', 'user.name', 'T');
  writeFileSync(join(install, 'package.json'), '{"version":"0.0.1"}\n');
  git(install, 'checkout', '-q', '-b', 'master');
  git(install, 'add', '-A');
  git(install, 'commit', '-qm', 'init');
  git(install, 'push', '-q', '-u', 'origin', 'master');
  // The custom branch is a PARAMETER: the no-custom shapes never create it, so
  // the rebase block is skipped and only the mirror can move.
  const withCustom = !String(state).startsWith('no-custom');
  if (withCustom) {
    git(install, 'checkout', '-q', '-b', 'swxtch');
    writeFileSync(join(install, 'custom.txt'), 'x\n');
    git(install, 'add', '-A');
    git(install, 'commit', '-qm', 'SWX custom');
  }

  /** Push a new commit to origin/master through a second clone. */
  const advanceOrigin = (): void => {
    const pusher = join(dir, `pusher-${Math.random().toString(36).slice(2, 8)}`);
    execFileSync('git', ['clone', '-q', bare, pusher]);
    git(pusher, 'config', 'user.email', 't@t.t');
    git(pusher, 'config', 'user.name', 'T');
    writeFileSync(join(pusher, 'up.txt'), 'upstream work\n');
    git(pusher, 'add', '-A');
    git(pusher, 'commit', '-qm', 'upstream advance');
    git(pusher, 'push', '-q', 'origin', 'HEAD:master');
  };

  switch (state) {
    case 'current':
      // Launched on swxtch, which already contains origin/master. Nothing to do.
      break;
    case 'behind':
      // origin/master advanced; the run will replay swxtch onto it.
      advanceOrigin();
      break;
    case 'ahead':
      // Launched on the MIRROR while swxtch is ahead. The run ends on swxtch,
      // so the served code changes even though nothing is fetched.
      git(install, 'checkout', '-q', 'master');
      break;
    case 'diverged':
      // Mirror current with origin, swxtch BEHIND it: BEHIND=0 yet the rebase
      // replays. The shape a naive `BEHIND=0 -> skip` gets wrong.
      git(install, 'checkout', '-q', 'master');
      writeFileSync(join(install, 'mirror.txt'), 'mirror work\n');
      git(install, 'add', '-A');
      git(install, 'commit', '-qm', 'mirror advance');
      git(install, 'push', '-q', 'origin', 'master');
      git(install, 'checkout', '-q', 'swxtch');
      break;
    case 'no-custom-on-mirror':
      // Launched ON the mirror with upstream ahead: the fast-forward moves the
      // ref under our feet, so code lands. The only no-custom topology the
      // single-arm predicate got right, and only by accident.
      advanceOrigin();
      break;
    case 'no-custom-third-branch': {
      // Launched on an ordinary branch. The mirror advances, but the run
      // returns here untouched — HEAD is identical before and after.
      advanceOrigin();
      git(install, 'checkout', '-q', '-b', 'feature-x');
      break;
    }
    case 'no-custom-detached':
      // Detached launch with upstream ahead. `git checkout HEAD` does NOT
      // restore this after the mirror moves, so the run must return to the
      // COMMIT for "nothing landed" to be true rather than merely claimed.
      advanceOrigin();
      git(install, 'checkout', '-q', '--detach');
      break;
    case 'lagging-mirror':
      // origin advanced and swxtch was already rebased onto it by hand; the
      // LOCAL mirror still lags. BEHIND != 0 yet nothing lands.
      advanceOrigin();
      git(install, 'fetch', '-q', 'origin');
      git(install, 'checkout', '-q', 'swxtch');
      execFileSync('git', ['-C', install, 'rebase', '-q', 'origin/master'], { stdio: 'pipe' });
      break;
  }
  return install;
}

/** Stub the externals. `unit` decides whether the posture gate is in scope. */
function stubExternals(install: string, posture: Posture, unit: boolean): void {
  writeStub('bun', `echo "bun $*" >> "${stubLog}"\nexec ${process.execPath} "$@"`);
  writeStub('gbrain', `echo "gbrain $*" >> "${stubLog}"
if [ "$1" = "config" ] && [ "$2" = "get" ]; then
  case "$3" in engine) echo "pglite" ;; *) exit 1 ;; esac
  exit 0
fi
exit 0`);
  writeStub('systemctl', `echo "systemctl $*" >> "${stubLog}"\nexit ${unit ? 0 : 1}`);
  writeStub('curl', `echo "curl $*" >> "${stubLog}"\nexit 0`);
  const probeDir = join(install, 'deploy', 'local-http');
  mkdirSync(probeDir, { recursive: true });
  const state = posture === 'disabled' ? 'disabled'
    : posture === 'enabled' ? 'enabled:true'
    : 'enabled:unset';
  writeFileSync(join(probeDir, 'write-through-probe.ts'), `console.log('${state}');\n`);
  // A PGLite store at the canonical path, so the backup arm has something real.
  mkdirSync(join(homeDir, '.gbrain', 'brain.pglite'), { recursive: true });
  writeFileSync(join(homeDir, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
}

function runScript(args: string[], install: string, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: `${stubBin}:${process.env.PATH ?? ''}`,
    HOME: homeDir,
    TERM: 'dumb',
    GBRAIN_HOME: homeDir,
    GBRAIN_DIR: install,
    GBRAIN_LINK: join(sandbox, 'self-link'),
    ...extra,
  };
  const opts: SpawnSyncOptions = { encoding: 'utf-8', timeout: 120_000, env };
  const r = spawnSync('bash', [SAFE_UPDATE, ...args], opts);
  return {
    status: r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    calls: existsSync(stubLog) ? readFileSync(stubLog, 'utf-8') : '',
  };
}

/**
 * The closing summary is the THIRD consumer of RUN_LANDS_CODE, and it went
 * unasserted for a round — reverting it to the old version-only wording left
 * all 52 cells green, which is exactly why a false "new code landed" on a
 * no-op run was invisible. Every cell that knows the expected answer now
 * checks it.
 */
function expectSummary(out: string, lands: Lands): void {
  if (lands === 'lands') {
    expect(out, 'summary denied a run that landed code').not.toContain('nothing landed');
    expect(out).toMatch(/Done — (new code landed|upgraded v)/);
  } else {
    expect(out, 'summary claimed code landed on a no-op run').not.toContain('new code landed');
    expect(out, 'summary claimed an upgrade on a no-op run').not.toMatch(/Done — upgraded v/);
    expect(out).toContain('nothing landed');
  }
}

/** What the predicate says, read off the run's observable behaviour. */
const EXPECTED: Record<BranchState | NoCustomState, Lands> = {
  current: 'no-op',
  behind: 'lands',
  ahead: 'lands',
  diverged: 'lands',
  'lagging-mirror': 'no-op',
  // No custom branch: only a run launched ON the mirror is served by its
  // fast-forward. A third branch is returned to untouched; a detached launch
  // is restored to its own commit.
  'no-custom-on-mirror': 'lands',
  'no-custom-third-branch': 'no-op',
  'no-custom-detached': 'no-op',
};

const BRANCH_STATES = Object.keys(EXPECTED) as Array<BranchState | NoCustomState>;
const POSTURES: Posture[] = ['unset', 'disabled', 'enabled'];

describe('SWX: lands-code predicate — branch x mode x posture', () => {
  // ---- REAL RUNS, no unit: the predicate arms the upgrade block ------------
  // No unit means the posture gate is out of scope, so what is observed here
  // is the predicate alone. Posture is crossed to prove it does not leak in.
  for (const state of BRANCH_STATES) {
    for (const posture of POSTURES) {
      test(`real | ${state} | posture=${posture} | no unit → upgrade block ${EXPECTED[state] === 'lands' ? 'arms' : 'stays quiet'}`, () => {
        const install = fixture(state);
        stubExternals(install, posture, false);
        const headBefore = git(install, 'rev-parse', 'HEAD');
        const r = runScript([], install);

        expect({ status: r.status, out: r.out }).toEqual(expect.objectContaining({ status: 0 }));
        // The predicate's answer is a CLAIM about the served code. Check the
        // claim against the served code itself, or "nothing landed" can be
        // true of the variable and false of the checkout — which is exactly
        // how a detached launch ended up attached to the moved mirror while
        // the run announced a no-op.
        const headAfter = git(install, 'rev-parse', 'HEAD');
        if (EXPECTED[state] === 'lands') {
          expect(headAfter, 'claimed to land code but HEAD never moved').not.toBe(headBefore);
        } else {
          expect(headAfter, 'claimed nothing landed but the served commit changed').toBe(headBefore);
        }
        if (EXPECTED[state] === 'lands') {
          expect(r.calls, 'landed code without running the upgrade block').toContain('bun install');
          expect(r.calls).toContain('post-upgrade');
        } else {
          expect(r.calls, 'ran bun install for code already in service').not.toContain('bun install');
          expect(r.calls, 'ran migrations against the live brain for no code change').not.toContain('post-upgrade');
        }
        expectSummary(r.out, EXPECTED[state]);
      }, 120_000);
    }
  }

  // ---- REAL RUNS, unit installed: the gate consumes the same answer --------
  for (const state of BRANCH_STATES) {
    for (const posture of POSTURES) {
      const gateShouldFire = EXPECTED[state] === 'lands' && posture !== 'disabled';
      test(`real | ${state} | posture=${posture} | unit → gate ${gateShouldFire ? 'refuses' : 'allows'}`, () => {
        const install = fixture(state);
        stubExternals(install, posture, true);
        const headBefore = git(install, 'rev-parse', 'HEAD');
        const r = runScript([], install);

        if (gateShouldFire) {
          expect(r.status).not.toBe(0);
          expect(r.out).toContain('refusing to update');
          expect(git(install, 'rev-parse', 'HEAD'), 'refused but still mutated').toBe(headBefore);
          expect(r.calls).not.toContain('post-upgrade');
        } else {
          expect({ status: r.status, out: r.out }).toEqual(expect.objectContaining({ status: 0 }));
          expect(r.out).not.toContain('refusing to update');
          expectSummary(r.out, EXPECTED[state]);
        }
      }, 120_000);
    }
  }

  // ---- --check is a READ in every state and posture ------------------------
  for (const state of BRANCH_STATES) {
    for (const posture of POSTURES) {
      test(`--check | ${state} | posture=${posture} | unit → reports, changes nothing`, () => {
        const install = fixture(state);
        stubExternals(install, posture, true);
        const headBefore = git(install, 'rev-parse', 'HEAD');
        const r = runScript(['--check'], install);

        expect({ status: r.status, out: r.out }).toEqual(expect.objectContaining({ status: 0 }));
        expect(r.out).not.toContain('refusing to update');
        expect(git(install, 'rev-parse', 'HEAD')).toBe(headBefore);
        expect(r.calls).not.toContain('post-upgrade');
      }, 120_000);
    }
  }

  // ---- THE INVARIANT: --dry-run predicts what the real run does ------------
  // Same fixture shape, two invocations: one predicting, one doing. The
  // contract says both read ONE answer, so the destructive half must appear in
  // the prediction exactly when it happens for real.
  for (const state of BRANCH_STATES) {
    test(`INVARIANT | ${state} | --dry-run prediction matches the real run`, () => {
      const dryInstall = fixture(state);
      stubExternals(dryInstall, 'disabled', false);
      const dry = runScript(['--dry-run', '--no-backup'], dryInstall);
      const dryPredictsUpgrade = dry.out.includes('[dry-run] bun install')
        && dry.out.includes('[dry-run] gbrain post-upgrade');

      rmSync(stubLog, { force: true });
      rmSync(join(sandbox, 'inst'), { recursive: true, force: true });

      const realInstall = fixture(state);
      stubExternals(realInstall, 'disabled', false);
      const real = runScript([], realInstall);
      const realDidUpgrade = real.calls.includes('bun install')
        && real.calls.includes('post-upgrade');

      expect(dry.status).toBe(0);
      expect(real.status).toBe(0);
      expect(
        dryPredictsUpgrade,
        `--dry-run predicted upgrade=${dryPredictsUpgrade} but the real run did ${realDidUpgrade}`,
      ).toBe(realDidUpgrade);
      expect(realDidUpgrade, `expected ${EXPECTED[state]}`).toBe(EXPECTED[state] === 'lands');
    }, 180_000);
  }

  // ---- --dry-run x opt-in, both posture families ---------------------------
  for (const posture of ['unset', 'enabled'] as Posture[]) {
    test(`--dry-run + opt-in | behind | posture=${posture} | predicts proceeding, not refusing`, () => {
      const install = fixture('behind');
      stubExternals(install, posture, true);
      const r = runScript(['--dry-run', '--no-backup'], install, { GBRAIN_ALLOW_WRITE_THROUGH: '1' });

      expect({ status: r.status, out: r.out }).toEqual(expect.objectContaining({ status: 0 }));
      expect(r.out).toContain('[dry-run]');
      expect(r.out).toContain('proceeding on GBRAIN_ALLOW_WRITE_THROUGH=1');
      expect(r.out, 'predicted a refusal its own real run would not make').not.toContain('would REFUSE');
    }, 120_000);
  }
});
