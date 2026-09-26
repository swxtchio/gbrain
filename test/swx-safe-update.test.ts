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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const stub = (name: string, exitCode = 0) => {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
};

const runUpdate = (install: string) =>
  Bun.spawnSync(['bash', SCRIPT], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: join(base, 'home'),
      TMPDIR: base,
      GBRAIN_DIR: install,
      GBRAIN_HOME: join(base, 'home', '.gbrain'),
      GBRAIN_LINK: '',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
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
  stub('systemctl'); // unit "installed": `cat` succeeds, restarts are logged
  stub('curl'); // health probe answers
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
});
