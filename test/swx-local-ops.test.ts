/**
 * SWX: deploy/local-ops (dev-box ops suite) and deploy/supabase (role settings).
 *
 * - every shipped script parses, no hard-coded /home/<user>, units point at shipped scripts
 * - install.sh installs copies, enables only the default timers, --check detects drift
 * - resync-lib.sh: stash -> default branch -> ff -> sync -> switch back -> unstash,
 *   against throwaway git repos with a stub `gbrain` recording what each sync saw
 * - role-settings.ts parses role-settings.sql and detects missing settings
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expectedSettings, missingSettings, SQL_FILE } from '../deploy/supabase/role-settings.ts';

const OPS = resolve(import.meta.dir, '../deploy/local-ops');
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'gbrain-local-ops-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('deploy/local-ops structure', () => {
  test('every shipped shell script parses', () => {
    for (const f of walk(OPS).filter((p) => p.endsWith('.sh'))) {
      expect({ f, rc: Bun.spawnSync(['bash', '-n', f]).exitCode }).toEqual({ f, rc: 0 });
    }
  });

  test('no hard-coded home directory (units use %h, scripts use $HOME)', () => {
    for (const f of walk(OPS)) expect({ f, hit: readFileSync(f, 'utf8').includes('/home/byates') }).toEqual({ f, hit: false });
  });

  test("every unit's ExecStart points at a script shipped in bin/", () => {
    for (const f of walk(join(OPS, 'systemd')).filter((p) => p.endsWith('.service'))) {
      const exec = readFileSync(f, 'utf8').match(/^ExecStart=%h\/\.gbrain\/(\S+)$/m);
      expect({ f, exec: !!exec }).toEqual({ f, exec: true });
      expect(existsSync(join(OPS, 'bin', exec![1]!))).toBe(true);
    }
  });
});

describe('install.sh', () => {
  const run = (...args: string[]) => {
    const bin = join(base, 'stubbin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'systemctl'), `#!/usr/bin/env bash\necho "systemctl $*" >> "${join(base, 'calls.log')}"\n`);
    chmodSync(join(bin, 'systemctl'), 0o755);
    return Bun.spawnSync(['bash', join(OPS, 'install.sh'), ...args], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: base, XDG_CONFIG_HOME: join(base, 'config') },
    });
  };
  const calls = () => (existsSync(join(base, 'calls.log')) ? readFileSync(join(base, 'calls.log'), 'utf8') : '');

  test('installs copies, enables only the default timers, and --check is clean afterwards', () => {
    expect(run().exitCode).toBe(0);
    expect(readFileSync(join(base, '.gbrain', 'resync-lib.sh'), 'utf8')).toBe(readFileSync(join(OPS, 'bin', 'resync-lib.sh'), 'utf8'));
    expect(existsSync(join(base, 'config', 'systemd', 'user', 'gbrain-daily-resync.service.d', 'pool-size.conf'))).toBe(true);
    expect(calls()).toContain('systemctl --user enable --now gbrain-daily-resync.timer');
    expect(calls()).toContain('systemctl --user enable --now gbrain-libsrt-refresh.timer');
    expect(calls()).not.toContain('gbrain-todo-refresh.timer');
    expect(calls()).not.toContain('enable --now gbrain-bulk-refresh.timer');
    const check = run('--check');
    expect(check.exitCode).toBe(0);
    expect(check.stdout.toString()).toContain('no drift');
  });

  test('--check reports an edited installed copy; a reinstall backs it up and restores it', () => {
    run();
    const installed = join(base, '.gbrain', 'daily-resync.sh');
    writeFileSync(installed, readFileSync(installed, 'utf8') + '\n# local edit\n');
    const check = run('--check');
    expect(check.exitCode).toBe(1);
    expect(check.stdout.toString()).toContain(`drift (changed): ${installed}`);
    expect(run().exitCode).toBe(0);
    expect(readFileSync(installed, 'utf8')).toBe(readFileSync(join(OPS, 'bin', 'daily-resync.sh'), 'utf8'));
    expect(readdirSync(join(base, '.gbrain')).some((f) => f.startsWith('daily-resync.sh.bak-'))).toBe(true);
  });
});

describe('resync-lib.sh sync_on_default_branch', () => {
  // Runs one scenario in bash: builds repos, calls the function, prints state lines.
  const scenario = (setup: string) => {
    const bin = join(base, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'gbrain'), `#!/usr/bin/env bash
echo "SYNC args=[$*] branch=$(git symbolic-ref --short -q HEAD || echo DETACHED) head=$(git rev-parse --short HEAD) dirty=$(git status --porcelain | wc -l | tr -d ' ')" >> "${join(base, 'stub.log')}"
`);
    chmodSync(join(bin, 'gbrain'), 0o755);
    const script = `set -u
T=${base}
. ${join(OPS, 'bin', 'resync-lib.sh')}
g() { git -C "$@"; }
mk() {
  git init -q -b main $T/$1.seed; echo a > $T/$1.seed/a.txt; echo b > $T/$1.seed/b.txt; g $T/$1.seed add -A; g $T/$1.seed commit -qm A
  git clone -q --bare $T/$1.seed $T/$1.git; git clone -q $T/$1.git $T/$1
  echo a2 > $T/$1.seed/a.txt; g $T/$1.seed commit -qam B; g $T/$1.seed push -q $T/$1.git main; rm -rf $T/$1.seed
}
state() { echo "STATE branch=$(g $T/$1 symbolic-ref --short -q HEAD || echo DETACHED) main=$(g $T/$1 rev-parse --short main) origin=$(g $T/$1 rev-parse --short origin/main) dirty=$(g $T/$1 status --porcelain | tr '\\n' ',') stashes=$(g $T/$1 stash list | wc -l | tr -d ' ')"; }
${setup}
`;
    const r = Bun.spawnSync(['bash', '-c', script], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: base, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    const out = r.stdout.toString() + r.stderr.toString();
    const stub = existsSync(join(base, 'stub.log')) ? readFileSync(join(base, 'stub.log'), 'utf8') : '';
    return { out, stub };
  };
  const field = (line: string, key: string) => line.match(new RegExp(`${key}=(\\S*)`))?.[1];
  const lastState = (out: string) => out.split('\n').filter((l) => l.startsWith('STATE')).at(-1) ?? '';

  test('clean main behind origin: fast-forwards and syncs origin/main', () => {
    const { out, stub } = scenario('mk r; sync_on_default_branch s1 code $T/r; state r');
    const s = lastState(out);
    expect(field(s, 'branch')).toBe('main');
    expect(field(s, 'main')).toBe(field(s, 'origin'));
    expect(stub).toContain('args=[sync --source s1 --strategy code --no-pull --yes] branch=main');
  });

  test('dirty feature branch: syncs clean main, then restores the branch and every change', () => {
    const { out, stub } = scenario(`mk r; g $T/r checkout -qb feature; echo local >> $T/r/b.txt; echo new > $T/r/untracked.txt
sync_on_default_branch s2 code $T/r; state r; echo "B=$(tail -1 $T/r/b.txt) U=$(cat $T/r/untracked.txt)"`);
    const s = lastState(out);
    expect(field(s, 'branch')).toBe('feature');
    expect(s).toContain('dirty= M b.txt,?? untracked.txt, '); // exactly the edits we made, restored
    expect(s).toContain('stashes=0');
    expect(out).toContain('B=local U=new');
    expect(stub).toMatch(/branch=main head=\S+ dirty=0/);
  });

  test('detached HEAD: returns to the same commit', () => {
    const { out } = scenario('mk r; g $T/r checkout -q --detach HEAD; D=$(g $T/r rev-parse --short HEAD); sync_on_default_branch s3 code $T/r; echo "WAS=$D NOW=$(g $T/r rev-parse --short HEAD) $(g $T/r symbolic-ref -q HEAD || echo DETACHED)"');
    const m = out.match(/WAS=(\S+) NOW=(\S+) (\S+)/)!;
    expect(m[1]).toBe(m[2]);
    expect(m[3]).toBe('DETACHED');
  });

  test('main checked out in another worktree: syncs detached origin/main, restores the branch', () => {
    const { out, stub } = scenario('mk r; g $T/r checkout -qb feature; g $T/r worktree add -q $T/r-wt main; sync_on_default_branch s4 auto $T/r; state r');
    expect(out).toContain('checked out elsewhere; syncing detached origin/main');
    expect(field(lastState(out), 'branch')).toBe('feature');
    expect(stub).toContain('--strategy auto');
    expect(stub).toContain('branch=DETACHED');
  });

  test('rebase in progress: skipped and untouched', () => {
    const { out, stub } = scenario('mk r; mkdir -p $T/r/.git/rebase-merge; sync_on_default_branch s5 code $T/r; state r');
    expect(out).toContain('rebase/merge/cherry-pick in progress');
    expect(stub).toBe('');
  });

  test('diverged main (unpushed commit): not synced, left as it was', () => {
    const { out, stub } = scenario('mk r; echo x > $T/r/c.txt; g $T/r add c.txt; g $T/r commit -qm local; L=$(g $T/r rev-parse --short HEAD); sync_on_default_branch s7 code $T/r; echo "KEPT=$L NOW=$(g $T/r rev-parse --short HEAD)"');
    expect(out).toContain('not syncing a diverged branch');
    const m = out.match(/KEPT=(\S+) NOW=(\S+)/)!;
    expect(m[1]).toBe(m[2]);
    expect(stub).toBe('');
  });
});

describe('deploy/supabase role settings', () => {
  const expected = expectedSettings(readFileSync(SQL_FILE, 'utf8'));

  test('role-settings.sql sets both backstops', () => {
    expect(expected).toEqual({ transaction_timeout: '30min', idle_in_transaction_session_timeout: '5min' });
  });

  test('missingSettings reports absent or different values only', () => {
    expect(missingSettings(expected, ['search_path="$user", public', 'transaction_timeout=30min', 'idle_in_transaction_session_timeout=5min'])).toEqual([]);
    expect(missingSettings(expected, ['transaction_timeout=10min'])).toEqual(['transaction_timeout=30min', 'idle_in_transaction_session_timeout=5min']);
    expect(missingSettings(expected, null)).toEqual(['transaction_timeout=30min', 'idle_in_transaction_session_timeout=5min']);
  });
});
