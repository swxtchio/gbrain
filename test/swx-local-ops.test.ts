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
import { expectedSettings, missingSettings, overriddenSettings, SQL_FILE } from '../deploy/supabase/role-settings.ts';

const OPS = resolve(import.meta.dir, '../deploy/local-ops');
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'gbrain-local-ops-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('deploy/local-ops structure', () => {
  test('every file under deploy/local-ops and deploy/supabase is tracked (no .gitignore trap)', () => {
    // upstream .gitignore ignores any bin/ directory; a shipped file it swallowed
    // would exist in a working tree yet be missing from every clone.
    const root = resolve(import.meta.dir, '..');
    const tracked = new Set(Bun.spawnSync(['git', 'ls-files', 'deploy/local-ops', 'deploy/supabase'], { cwd: root }).stdout.toString().trim().split('\n'));
    for (const dir of [OPS, resolve(import.meta.dir, '../deploy/supabase')]) {
      for (const f of walk(dir)) {
        const rel = f.slice(root.length + 1);
        expect({ rel, tracked: tracked.has(rel) }).toEqual({ rel, tracked: true });
      }
    }
  });

  test('every shipped shell script parses', () => {
    for (const f of walk(OPS).filter((p) => p.endsWith('.sh'))) {
      expect({ f, rc: Bun.spawnSync(['bash', '-n', f]).exitCode }).toEqual({ f, rc: 0 });
    }
  });

  test('no hard-coded home directory (units use %h, scripts use $HOME)', () => {
    for (const f of walk(OPS)) expect({ f, hit: readFileSync(f, 'utf8').includes('/home/byates') }).toEqual({ f, hit: false });
  });

  test('every Key Vault capture is guarded (a failing az must not abort a set -e job)', () => {
    for (const f of walk(join(OPS, 'scripts')).filter((p) => p.endsWith('.sh'))) {
      for (const line of readFileSync(f, 'utf8').split('\n').filter((l) => /=\$\(az /.test(l))) {
        expect({ f, line, guarded: /\|\| true\s*$/.test(line) || /^\s*if ! /.test(line) }).toEqual({ f, line, guarded: true });
      }
    }
  });

  test('every oneshot service declares TimeoutStartSec (the 90s default kills long embeds)', () => {
    for (const f of walk(join(OPS, 'systemd')).filter((p) => p.endsWith('.service'))) {
      const unit = readFileSync(f, 'utf8');
      if (/^Type=oneshot$/m.test(unit)) expect({ f, timeout: /^TimeoutStartSec=/m.test(unit) }).toEqual({ f, timeout: true });
    }
  });

  test('libsrt-refresh refuses to hard-reset a mirror that is dirty or off master', () => {
    const clone = join(base, 'tools', 'libsrt');
    mkdirSync(clone, { recursive: true });
    const g = (...a: string[]) => Bun.spawnSync(['git', '-C', clone, '-c', 'user.email=t@e', '-c', 'user.name=t', ...a]);
    g('init', '-q', '-b', 'master'); writeFileSync(join(clone, 'a.md'), 'a\n'); g('add', '-A'); g('commit', '-qm', 'A');
    g('checkout', '-qb', 'local-work'); writeFileSync(join(clone, 'a.md'), 'edited\n');
    mkdirSync(join(base, '.gbrain'), { recursive: true });
    const r = Bun.spawnSync(['bash', join(OPS, 'scripts', 'libsrt-refresh.sh')], { env: { PATH: '/usr/bin:/bin', HOME: base } });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(base, '.gbrain', 'libsrt-refresh.log'), 'utf8')).toContain('is not a clean master mirror');
    expect(g('symbolic-ref', '--short', 'HEAD').stdout.toString().trim()).toBe('local-work');
    expect(readFileSync(join(clone, 'a.md'), 'utf8')).toBe('edited\n');
  });

  test('libsrt-refresh refuses a clean master mirror that has local commits', () => {
    const seed = join(base, 'seed'), clone = join(base, 'tools', 'libsrt');
    mkdirSync(seed, { recursive: true });
    const g = (dir: string, ...a: string[]) => Bun.spawnSync(['git', '-C', dir, '-c', 'user.email=t@e', '-c', 'user.name=t', ...a]);
    g(seed, 'init', '-q', '-b', 'master'); writeFileSync(join(seed, 'a.md'), 'a\n'); g(seed, 'add', '-A'); g(seed, 'commit', '-qm', 'A');
    mkdirSync(join(base, 'tools'), { recursive: true });
    Bun.spawnSync(['git', 'clone', '-q', seed, clone]);
    writeFileSync(join(clone, 'b.md'), 'local\n'); g(clone, 'add', '-A'); g(clone, 'commit', '-qm', 'local commit');
    const head = g(clone, 'rev-parse', 'HEAD').stdout.toString().trim();
    mkdirSync(join(base, '.gbrain'), { recursive: true });
    expect(Bun.spawnSync(['bash', join(OPS, 'scripts', 'libsrt-refresh.sh')], { env: { PATH: '/usr/bin:/bin', HOME: base } }).exitCode).toBe(0);
    expect(readFileSync(join(base, '.gbrain', 'libsrt-refresh.log'), 'utf8')).toContain('1 local commit(s)); not resetting it');
    expect(g(clone, 'rev-parse', 'HEAD').stdout.toString().trim()).toBe(head);
  });

  test("every unit's ExecStart points at a script shipped in scripts/", () => {
    for (const f of walk(join(OPS, 'systemd')).filter((p) => p.endsWith('.service'))) {
      const exec = readFileSync(f, 'utf8').match(/^ExecStart=%h\/\.gbrain\/(\S+)$/m);
      expect({ f, exec: !!exec }).toEqual({ f, exec: true });
      expect(existsSync(join(OPS, 'scripts', exec![1]!))).toBe(true);
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
    expect(readFileSync(join(base, '.gbrain', 'resync-lib.sh'), 'utf8')).toBe(readFileSync(join(OPS, 'scripts', 'resync-lib.sh'), 'utf8'));
    expect(existsSync(join(base, 'config', 'systemd', 'user', 'gbrain-daily-resync.service.d', 'pool-size.conf'))).toBe(true);
    expect(calls()).toContain('systemctl --user enable --now gbrain-daily-resync.timer');
    expect(calls()).toContain('systemctl --user enable --now gbrain-libsrt-refresh.timer');
    expect(calls()).not.toContain('gbrain-todo-refresh.timer');
    expect(calls()).not.toContain('enable --now gbrain-bulk-refresh.timer');
    const check = run('--check');
    expect(check.exitCode).toBe(0);
    expect(check.stdout.toString()).toContain('no drift');
  });

  test('a script git does not track stops the install before anything is copied', () => {
    // Untracked (or staged for deletion): there's no index mode to install, so
    // guessing 644 would ship a timer target that can't execute.
    const stray = join(OPS, 'scripts', 'zz-untracked-probe.sh');
    writeFileSync(stray, '#!/usr/bin/env bash\n');
    chmodSync(stray, 0o755);
    try {
      const r = run();
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain('zz-untracked-probe.sh');
      expect(existsSync(join(base, '.gbrain'))).toBe(false);
      expect(calls()).toBe('');
    } finally {
      rmSync(stray);
    }
  });

  test.each([
    ['an untracked unit', join('systemd', 'zz-untracked-probe.service')],
    ['an untracked script whose name holds the record delimiter', join('scripts', 'zz|stray.sh')],
  ])('%s also stops the install before anything is copied', (_, rel) => {
    const stray = join(OPS, rel);
    writeFileSync(stray, '[Unit]\n');
    try {
      const r = run();
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain('refusing to install');
      expect(existsSync(join(base, '.gbrain'))).toBe(false);
      expect(existsSync(join(base, 'config'))).toBe(false);
    } finally {
      rmSync(stray);
    }
  });

  test('installs git-tracked modes (755/644), not the checkout filesystem mode', () => {
    // The checkout disagrees with git both ways: a 100644 tool with group-write,
    // and a 100755 script that lost its exec bit. Both install as git tracks them.
    const tool = join(OPS, 'tools', 'suggest-tags.py'), script = join(OPS, 'scripts', 'refresh-watermark.sh');
    const mode = (f: string) => Bun.spawnSync(['stat', '-c', '%a', f]).stdout.toString().trim();
    const was = [mode(tool), mode(script)];
    try {
      chmodSync(tool, 0o664);
      chmodSync(script, 0o644);
      run();
      expect(mode(join(base, '.gbrain', 'suggest-tags.py'))).toBe('644');
      expect(mode(join(base, '.gbrain', 'refresh-watermark.sh'))).toBe('755');
    } finally {
      chmodSync(tool, parseInt(was[0], 8));
      chmodSync(script, parseInt(was[1], 8));
    }
  });

  test('--check reports a script that lost its exec bit; a reinstall restores the mode', () => {
    run();
    const installed = join(base, '.gbrain', 'daily-resync.sh');
    chmodSync(installed, 0o644);
    const check = run('--check');
    expect(check.exitCode).toBe(1);
    expect(check.stdout.toString()).toContain(`drift (mode 644 != 755): ${installed}`);
    run();
    expect((Bun.spawnSync(['stat', '-c', '%a', installed]).stdout.toString().trim())).toBe('755');
  });

  test('--check reports an edited installed copy; a reinstall backs it up and restores it', () => {
    run();
    const installed = join(base, '.gbrain', 'daily-resync.sh');
    writeFileSync(installed, readFileSync(installed, 'utf8') + '\n# local edit\n');
    const check = run('--check');
    expect(check.exitCode).toBe(1);
    expect(check.stdout.toString()).toContain(`drift (changed): ${installed}`);
    expect(run().exitCode).toBe(0);
    expect(readFileSync(installed, 'utf8')).toBe(readFileSync(join(OPS, 'scripts', 'daily-resync.sh'), 'utf8'));
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
. ${join(OPS, 'scripts', 'resync-lib.sh')}
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
  test('staged changes stay staged', () => {
    const { out } = scenario(`mk r; g $T/r checkout -qb feature; echo staged >> $T/r/b.txt; g $T/r add b.txt; echo unstaged >> $T/r/a.txt
sync_on_default_branch s8 code $T/r; echo "ST=[$(g $T/r status --porcelain | tr '\\n' ',')]"`);
    const st = out.match(/ST=\[([^\]]*)\]/)![1]!.split(',').filter(Boolean).sort();
    expect(st).toEqual([' M a.txt', 'M  b.txt'].sort()); // b.txt staged (col 1), a.txt unstaged (col 2)
  });

  test('changes stash cannot hold: repo skipped, an older unrelated stash is left alone', () => {
    const { out, stub } = scenario(`mk r; echo older >> $T/r/a.txt; g $T/r stash push -q -m older-user-stash
git init -q $T/r/nested; echo x > $T/r/nested/f; g $T/r/nested add f; g $T/r/nested commit -qm n
sync_on_default_branch s9 code $T/r; echo "STASHES=[$(g $T/r stash list --format=%s | tr '\\n' '|')] NESTED=$(ls $T/r/nested)"`);
    expect(out).toContain('changes git stash cannot hold');
    expect(stub).toBe('');
    expect(out).toContain('STASHES=[On main: older-user-stash|]');
    expect(out).toContain('NESTED=f');
  });

  test('a failed switch-back keeps the stash instead of popping it on the wrong branch', () => {
    // The sync leaves an untracked file on main that checking out feature would overwrite.
    const { out } = scenario(`mk r; g $T/r checkout -qb feature; echo tracked > $T/r/clash.txt; g $T/r add clash.txt; g $T/r commit -qm feat
echo local >> $T/r/b.txt   # b.txt is untouched upstream, so a wrong-branch pop would apply cleanly
cat > $T/bin/gbrain <<'STUB'
#!/usr/bin/env bash
echo untracked > clash.txt
STUB
chmod +x $T/bin/gbrain
set -e   # daily-resync.sh runs under set -e: a failed switch-back must not abort it
sync_on_default_branch s10 code $T/r; echo "CONTINUED BRANCH=$(g $T/r symbolic-ref --short HEAD) STASHES=$(g $T/r stash list | wc -l | tr -d ' ')"`);
    expect(out).toContain('CONTINUED');
    expect(out).toContain('your changes are safe in stash');
    expect(out).toContain('STASHES=1');
    expect(out).not.toContain('restored local changes');
    expect(out).toContain('BRANCH=main'); // left where the switch-back failed, changes untouched in the stash
  });

  test('SIGTERM right after the stash is made still restores the changes', () => {
    // Wrap _rs_git so the signal lands immediately after `stash push`, before
    // the lib has recorded which stash it made.
    const { out } = scenario(`mk r; g $T/r checkout -qb feature; echo local >> $T/r/b.txt
( export RS_TEST_PID=$BASHPID
  eval "$(declare -f _rs_git | sed '1s/_rs_git/_rs_git_real/')"
  _rs_git() { _rs_git_real "$@"; local rc=$?; [ "$1" = stash ] && [ "\${2:-}" = push ] && kill -TERM "$RS_TEST_PID"; return $rc; }
  sync_on_default_branch s12 code $T/r )
echo "RC=$? BRANCH=$(g $T/r symbolic-ref --short HEAD) B=$(tail -1 $T/r/b.txt) STASHES=$(g $T/r stash list | wc -l | tr -d ' ')"`);
    expect(out).toContain('RC=143 BRANCH=feature B=local STASHES=0');
  });

  test("a signal before our stash exists never adopts another worktree's stash", () => {
    // refs/stash is shared by a repo's worktrees. Another worktree stashes,
    // then the signal lands before our own `stash push` runs.
    const { out } = scenario(`mk r; g $T/r checkout -qb feature; echo local >> $T/r/b.txt
g $T/r worktree add -q $T/wt2 main 2>/dev/null; echo theirs >> $T/wt2/a.txt
( export RS_TEST_PID=$BASHPID
  eval "$(declare -f _rs_git | sed '1s/_rs_git/_rs_git_real/')"
  _rs_git() { if [ "$1" = stash ] && [ "\${2:-}" = push ]; then git -C $T/wt2 stash push -q -m theirs; kill -TERM "$RS_TEST_PID"; fi; _rs_git_real "$@"; }
  sync_on_default_branch s14 code $T/r )
echo "RC=$? BRANCH=$(g $T/r symbolic-ref --short HEAD) B=$(tail -1 $T/r/b.txt) A=$(tail -1 $T/r/a.txt) STASH=$(g $T/r stash list --format=%s)"`);
    expect(out).toContain('RC=143 BRANCH=feature B=local');
    expect(out).not.toContain('A=theirs');
    expect(out).toContain('STASH=On main: theirs');
  });

  test("another worktree's stash pushed mid-restore is neither applied nor dropped", () => {
    // The foreign push lands right before we apply/pop, shifting our stash@{n}.
    const { out } = scenario(`mk r; g $T/r checkout -qb feature; echo local >> $T/r/b.txt
g $T/r worktree add -q $T/wt2 main 2>/dev/null; echo theirs >> $T/wt2/a.txt
eval "$(declare -f _rs_git | sed '1s/_rs_git/_rs_git_real/')"
_rs_git() { if [ "$1" = stash ] && { [ "\${2:-}" = apply ] || [ "\${2:-}" = pop ]; } && [ ! -e $T/pushed ]; then touch $T/pushed; git -C $T/wt2 stash push -q -m theirs; fi; _rs_git_real "$@"; }
sync_on_default_branch s15 code $T/r
echo "BRANCH=$(g $T/r symbolic-ref --short HEAD) B=$(tail -1 $T/r/b.txt) A=$(tail -1 $T/r/a.txt) STASH=$(g $T/r stash list --format=%s | tr '\\n' ,)"`);
    expect(out).toContain('restored local changes on feature');
    expect(out).toContain('BRANCH=feature B=local');
    expect(out).not.toContain('A=theirs');
    expect(out).toContain('STASH=On main: theirs,');
  });

  test("another worktree's stash pushed right before our drop is put back, not lost", () => {
    // git drops only by stash@{n}; the foreign push lands between our lookup
    // and the drop, so the selector names their stash.
    const { out } = scenario(`mk r; g $T/r checkout -qb feature; echo local >> $T/r/b.txt
g $T/r worktree add -q $T/wt2 main 2>/dev/null; echo theirs >> $T/wt2/a.txt
eval "$(declare -f _rs_git | sed '1s/_rs_git/_rs_git_real/')"
_rs_git() { if [ "$1" = stash ] && [ "\${2:-}" = drop ] && [ ! -e $T/pushed ]; then touch $T/pushed; git -C $T/wt2 stash push -q -m theirs; fi; _rs_git_real "$@"; }
sync_on_default_branch s16 code $T/r
echo "BRANCH=$(g $T/r symbolic-ref --short HEAD) B=$(tail -1 $T/r/b.txt) STASH=$(g $T/r stash list --format=%s | tr '\\n' ,) THEIRS=$(g $T/r show stash@{0}:a.txt | tail -1)"`);
    expect(out).toContain('restored local changes on feature');
    expect(out).toContain('BRANCH=feature B=local');
    // Theirs survives with its message and content; ours stays listed (applied, not dropped).
    expect(out).toMatch(/STASH=On main: theirs,On feature: gbrain-daily-resync auto-stash [^,]*,/);
    expect(out).toContain('THEIRS=theirs');
  });

  test('SIGTERM during the final restore neither re-enters it nor misreports the stash', () => {
    // The signal lands right after `stash apply` succeeds, before the drop: a
    // re-entered restore would find the stash still listed and apply it twice.
    const { out } = scenario(`mk r; g $T/r checkout -qb feature; echo local >> $T/r/b.txt
( export RS_TEST_PID=$BASHPID
  eval "$(declare -f _rs_git | sed '1s/_rs_git/_rs_git_real/')"
  _rs_git() { _rs_git_real "$@"; local rc=$?; [ "$1" = stash ] && [ "\${2:-}" = apply ] && kill -TERM "$RS_TEST_PID"; return $rc; }
  sync_on_default_branch s13 code $T/r )
echo "RC=$? BRANCH=$(g $T/r symbolic-ref --short HEAD) B=$(tail -1 $T/r/b.txt) STASHES=$(g $T/r stash list | wc -l | tr -d ' ')"`);
    expect(out).toContain('restored local changes on feature');
    expect(out).not.toMatch(/no longer in|could not restore|not dropped/);
    expect(out).toContain('RC=143 BRANCH=feature B=local STASHES=0');
  });

  test('SIGTERM mid-sync still restores the branch and the changes', () => {
    const { out } = scenario(`mk r; g $T/r checkout -qb feature; echo local >> $T/r/b.txt
cat > $T/bin/gbrain <<'STUB'
#!/usr/bin/env bash
kill -TERM "$RS_TEST_PID"
sleep 1
STUB
chmod +x $T/bin/gbrain
( export RS_TEST_PID=$BASHPID; sync_on_default_branch s11 code $T/r ); echo "RC=$? BRANCH=$(g $T/r symbolic-ref --short HEAD) B=$(tail -1 $T/r/b.txt) STASHES=$(g $T/r stash list | wc -l | tr -d ' ')"`);
    expect(out).toContain('restored local changes on feature');
    expect(out).toContain('RC=143 BRANCH=feature B=local STASHES=0');
  });
});

describe('deploy/supabase role settings', () => {
  const expected = expectedSettings(readFileSync(SQL_FILE, 'utf8'));

  test('role-settings.sql sets both backstops on role postgres', () => {
    expect(expected).toEqual({ postgres: { transaction_timeout: '30min', idle_in_transaction_session_timeout: '5min' } });
  });

  test('overriddenSettings flags a database-specific row that differs', () => {
    expect(overriddenSettings(expected.postgres!, ['transaction_timeout=0'])).toEqual(['transaction_timeout=0']);
    expect(overriddenSettings(expected.postgres!, ['transaction_timeout=30min', 'search_path=x'])).toEqual([]);
    expect(overriddenSettings(expected.postgres!, null)).toEqual([]);
  });

  test('missingSettings reports absent or different values only', () => {
    const e = expected.postgres!;
    expect(missingSettings(e, ['search_path="$user", public', 'transaction_timeout=30min', 'idle_in_transaction_session_timeout=5min'])).toEqual([]);
    expect(missingSettings(e, ['transaction_timeout=10min'])).toEqual(['transaction_timeout=30min', 'idle_in_transaction_session_timeout=5min']);
    expect(missingSettings(e, null)).toEqual(['transaction_timeout=30min', 'idle_in_transaction_session_timeout=5min']);
  });
});
