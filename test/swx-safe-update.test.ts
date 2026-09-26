/**
 * SWX: scripts/gbrain-safe-update against throwaway git repos.
 *
 * - A fork clone (`origin` = the fork, whose master mirror lags) must track an
 *   `upstream` remote by default, not report the stale mirror as current.
 * - A re-run with nothing to replay must NOT run the build steps (bun install,
 *   gbrain post-upgrade, HTTP service restart): an already-up-to-date rebase
 *   succeeds without moving the branch.
 * - A failed `gbrain post-upgrade` must stop before restarting the live HTTP
 *   server, and the next run must retry the build steps.
 *
 * bun / gbrain / systemctl are PATH stubs that append to a call log, so the
 * real install and the live brain are never touched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, '../scripts/gbrain-safe-update');

let base: string;
let calls: string;
let bin: string;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

const commit = (cwd: string, file: string, body: string, message: string) => {
  writeFileSync(join(cwd, file), body);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
};

const stub = (name: string, exitCode = 0, body = '') => {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\n${body}\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
};

// systemd user unit on UNIT_PORT with MainPID 4242; `ss` reports LISTENER_PID on the port.
const serviceStubs = () => {
  stub('systemctl', 0, [
    'case "$2" in',
    '  cat) echo "# ExecStart=bun gbrain serve --http --port 9999 (stale comment)" ;;',
    '  show) if [ "$4" = MainPID ]; then echo 4242',
    '        elif [ -n "${NO_PORT:-}" ]; then echo "{ path=bun ; argv[]=bun gbrain serve --http ; }"',
    '        else echo "{ path=bun ; argv[]=bun gbrain serve --http --port ${UNIT_PORT:-8787} --bind 127.0.0.1 ; }"; fi ;;',
    'esac',
  ].join('\n'));
  stub('ss', 0, 'echo "LISTEN 0 512 127.0.0.1:${UNIT_PORT:-8787} 0.0.0.0:* users:((\\"bun\\",pid=${LISTENER_PID:-4242},fd=10))"');
  stub('curl');
  stub('sleep');
};

const runUpdate = (install: string, extraEnv: Record<string, string> = {}) =>
  Bun.spawnSync(['bash', SCRIPT], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: join(base, 'home'),
      TMPDIR: base,
      GBRAIN_DIR: install,
      GBRAIN_HOME: join(base, 'home'), // gbrain's convention: the PARENT of .gbrain
      GBRAIN_LINK: '',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
      ...extraEnv,
    },
  });

const callLog = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'gbrain-safe-update-'));
  calls = join(base, 'calls.log');
  bin = join(base, 'bin');
  mkdirSync(bin);
  mkdirSync(join(base, 'home'));
  stub('bun');
  stub('gbrain');
  serviceStubs();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** upstream (A→B), fork (master=A, swxtch=A+S), install = clone of fork + `upstream` remote. */
function forkLayout() {
  const upstream = join(base, 'upstream');
  mkdirSync(upstream);
  git(upstream, 'init', '-q', '-b', 'master');
  const a = commit(upstream, 'VERSION', '1\n', 'A');

  const fork = join(base, 'fork.git');
  git(base, 'clone', '-q', '--bare', upstream, fork);

  const install = join(base, 'install');
  git(base, 'clone', '-q', fork, install);
  git(install, 'checkout', '-q', '-b', 'swxtch');
  commit(install, 'fork.txt', 'swx\n', 'SWX: customization');
  git(install, 'push', '-q', 'origin', 'swxtch');
  git(install, 'remote', 'add', 'upstream', upstream);

  const b = commit(upstream, 'VERSION', '2\n', 'B');
  return { install, a, b };
}

describe('gbrain-safe-update', () => {
  test('a fork clone tracks the upstream remote, not the stale fork mirror', () => {
    const { install, a, b } = forkLayout();
    expect(git(install, 'rev-parse', 'origin/master')).toBe(a);

    const r = runUpdate(install);
    const out = r.stdout.toString();

    expect(r.exitCode).toBe(0);
    expect(out).toContain('upstream=upstream');
    expect(git(install, 'rev-parse', 'master')).toBe(b);
    expect(git(install, 'merge-base', '--is-ancestor', b, 'swxtch') === '').toBe(true);
    expect(git(install, 'log', '-1', '--format=%s', 'swxtch')).toBe('SWX: customization');
    // The branch moved, so the build steps ran and the publish hint names the fork remote.
    expect(callLog()).toContain('bun install');
    expect(callLog()).toContain('gbrain post-upgrade');
    expect(out).toContain('push --force-with-lease origin swxtch');
    // GBRAIN_LINK='' disables the self-link (documented; `:-` used to ignore it).
    expect(existsSync(join(base, 'home', '.local', 'bin', 'gbrain-safe-update'))).toBe(false);
  });

  test('a re-run with nothing to replay skips the build steps', () => {
    const { install } = forkLayout();
    expect(runUpdate(install).exitCode).toBe(0);
    writeFileSync(calls, '');

    const r = runUpdate(install);

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain('nothing to replay');
    expect(callLog()).toBe('');
  });

  test('a failed post-upgrade skips the restart and the next run retries it', () => {
    const { install } = forkLayout();
    stub('gbrain', 1);

    const failed = runUpdate(install);

    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr.toString()).toContain('NOT restarting');
    expect(callLog()).toContain('gbrain post-upgrade');
    expect(callLog()).not.toContain('restart');
    expect(existsSync(join(base, 'home', '.gbrain', 'safe-update-pending'))).toBe(true);

    stub('gbrain');
    writeFileSync(calls, '');
    const retried = runUpdate(install);

    expect(retried.exitCode).toBe(0);
    expect(retried.stdout.toString()).toContain('Resuming build steps');
    expect(callLog()).toContain('gbrain post-upgrade');
    expect(callLog()).toContain('systemctl --user restart gbrain-http.service');
    expect(existsSync(join(base, 'home', '.gbrain', 'safe-update-pending'))).toBe(false);
  });

  test('an unhealthy restart fails the run and keeps the resume marker', () => {
    const { install } = forkLayout();

    // An orphan (pid 999), not the unit's MainPID, owns the port.
    const r = runUpdate(install, { LISTENER_PID: '999' });

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain('did not become healthy');
    expect(r.stdout.toString()).not.toContain('Done');
    expect(existsSync(join(base, 'home', '.gbrain', 'safe-update-pending'))).toBe(true);
  });

  test('probes the port the installed unit binds', () => {
    const { install } = forkLayout();

    const r = runUpdate(install, { UNIT_PORT: '9000' });

    expect(r.exitCode).toBe(0);
    expect(callLog()).toContain('http://127.0.0.1:9000/health');
    expect(callLog()).not.toContain(':8787/health');
  });

  test('a missing customization branch stops before anything changes', () => {
    const { install, a } = forkLayout();
    git(install, 'checkout', '-q', 'master');

    const link = join(base, 'home', '.local', 'bin', 'gbrain-safe-update');
    const r = runUpdate(install, { GBRAIN_CUSTOM: 'no-such-branch', GBRAIN_LINK: link });

    expect(r.exitCode).not.toBe(0);
    // lstat, not existsSync: the self-link would dangle (no script in this repo).
    expect(() => lstatSync(link)).toThrow(); // guard runs before the self-link and fetch
    expect(r.stderr.toString()).toContain("customization branch 'no-such-branch' does not exist");
    expect(git(install, 'rev-parse', 'master')).toBe(a);
    expect(callLog()).toBe('');
  });

  test('a unit without --port falls back to 8787 instead of aborting under pipefail', () => {
    const { install } = forkLayout();

    const r = runUpdate(install, { NO_PORT: '1' });

    expect(r.exitCode).toBe(0);
    expect(callLog()).toContain('http://127.0.0.1:8787/health');
    expect(callLog()).toContain('systemctl --user restart gbrain-http.service');
  });

  test('reads the brain config under GBRAIN_HOME, not ~/.gbrain', () => {
    const { install } = forkLayout();
    // HOME says postgres (would skip the backup); GBRAIN_HOME says pglite.
    mkdirSync(join(base, 'home', '.gbrain'), { recursive: true });
    writeFileSync(join(base, 'home', '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: 'postgres://x' }));
    const brain = join(base, 'brainhome', '.gbrain');
    mkdirSync(join(brain, 'brain.pglite'), { recursive: true });
    writeFileSync(join(brain, 'config.json'), JSON.stringify({ engine: 'pglite' }));

    const r = runUpdate(install, { GBRAIN_HOME: join(base, 'brainhome') });

    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain('Backing up PGLite brain');
    expect(readdirSync(join(brain, 'backups')).some((f) => f.startsWith('brain.pglite.bak-'))).toBe(true);
    expect(existsSync(join(brain, 'just-upgraded-from'))).toBe(true);
  });
});
