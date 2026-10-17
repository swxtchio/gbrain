/**
 * PR-A: the two surfaces that make a dead autopilot visible.
 *
 *   generateSelfDisableGuard — stops a daemon whose --repo vanished, for real,
 *     under a supervisor that restarts it on every exit.
 *   classifyAutopilotStatus — tri-state verdict + exit code, so `--status` can
 *     no longer answer "installed" for a daemon that died 71 days ago.
 *
 * Both are pure, so no daemon is installed here.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  autopilotDisabledMarkerPath,
  autopilotDisableStrikesPath,
  resolveAutopilotJob,
  type AutopilotJob,
} from '../src/core/autopilot-paths.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  generateSelfDisableGuard,
  crontabIndicatesAutopilotInstall,
  classifyAutopilotStatus,
  autopilotStatusExitCode,
  autopilotLaunchdLabel,
  autopilotEngineIdentity,
  AUTOPILOT_SYSTEMD_UNIT,
} from '../src/commands/autopilot.ts';

interface GuardRig {
  repo: string;
  marker: string;
  strikes: string;
  job: AutopilotJob;
  requests: () => string;
  run: (target: Parameters<typeof generateSelfDisableGuard>[1], supervisorExit?: number) => string;
}

async function withGuardRig(fn: (rig: GuardRig) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-self-disable-'));
  const home = join(root, 'os-home');
  const brainHome = join(root, "brain's home");
  const bin = join(root, 'bin');
  const log = join(root, 'supervisor.log');
  const otherMarker = join(home, '.gbrain', 'autopilot-disabled');
  const otherStrikes = join(home, '.gbrain', 'autopilot-disable-strikes');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(otherMarker, 'another brain is disabled\n');
  writeFileSync(otherStrikes, '17\n');
  for (const command of ['systemctl', 'launchctl']) {
    writeFileSync(join(bin, command), `#!/bin/sh\nprintf '%s\\n' "${command} $*" >> "$SUPERVISOR_LOG"\nexit "$SUPERVISOR_EXIT"\n`, { mode: 0o755 });
  }
  writeFileSync(join(bin, 'id'), '#!/bin/sh\nprintf "4242\\n"\n', { mode: 0o755 });
  try {
    await withEnv({ HOME: home, GBRAIN_HOME: brainHome, GBRAIN_AUTOPILOT_LABEL: undefined }, () => {
      const job = resolveAutopilotJob({ mint: true });
      const repo = join(root, "captured repo's checkout");
      const marker = autopilotDisabledMarkerPath();
      const strikes = autopilotDisableStrikesPath();
      const requests = () => existsSync(log) ? readFileSync(log, 'utf8') : '';
      const run: GuardRig['run'] = (target, supervisorExit = 0) => {
        const shell = generateSelfDisableGuard(repo, target, job) + 'printf "GUARD_DISPATCH\\n"\n';
        const result = spawnSync('bash', ['-c', shell], {
          env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, SUPERVISOR_LOG: log, SUPERVISOR_EXIT: String(supervisorExit) },
          encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL',
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(readFileSync(otherMarker, 'utf8')).toBe('another brain is disabled\n');
        expect(readFileSync(otherStrikes, 'utf8')).toBe('17\n');
        return result.stdout;
      };
      fn({ repo, marker, strikes, job, requests, run });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('generateSelfDisableGuard', () => {
  test('healthy checkout directories dispatch with a .git file or from a checkout subdirectory', async () => {
    for (const shape of ['git-file', 'subdirectory']) {
      await withGuardRig(rig => {
        mkdirSync(rig.repo);
        if (shape === 'git-file') writeFileSync(join(rig.repo, '.git'), 'gitdir: /some/checkout\n');
        else mkdirSync(join(rig.repo, '..', '.git'));
        expect(rig.run('linux-systemd')).toBe('GUARD_DISPATCH\n');
        expect(existsSync(rig.marker)).toBe(false);
        expect(existsSync(rig.strikes)).toBe(false);
        expect(rig.requests()).toBe('');
      });
    }
  });

  test('macOS actually boots the job out — exit 0 alone is a respawn loop', () => {
    // KeepAlive=true means launchd restarts on ANY exit, so "detect and exit"
    // disables nothing; it just makes the failure quieter and more frequent.
    const guard = generateSelfDisableGuard('/data/brain', 'macos');
    expect(guard).toContain('launchctl bootout');
    expect(guard).toContain(autopilotLaunchdLabel());
  });

  test('systemd disables the unit — Restart=always has the same problem', () => {
    const guard = generateSelfDisableGuard('/data/brain', 'linux-systemd');
    expect(guard).toContain('systemctl --user disable --now');
    expect(guard).toContain(AUTOPILOT_SYSTEMD_UNIT);
  });

  test('cron and container just exit — they are periodic/one-shot, not KeepAlive', () => {
    for (const target of ['linux-cron', 'ephemeral-container'] as const) {
      const guard = generateSelfDisableGuard('/data/brain', target);
      expect(guard).toContain('exit 0');
      expect(guard).not.toContain('launchctl bootout');
      expect(guard).not.toContain('systemctl --user disable');
    }
  });

  test('writes a marker so --status can explain WHY it stopped', () => {
    expect(generateSelfDisableGuard('/data/brain', 'macos')).toContain('autopilot-disabled');
  });

  test('single-quotes in the repo path cannot break out of the shell literal', () => {
    const guard = generateSelfDisableGuard("/data/o'brien/brain", 'macos');
    expect(guard).toContain("'/data/o'\\''brien/brain'");
  });

  test('recorded disable is terminal for missing and restored repos on every target', async () => {
    for (const target of ['macos', 'linux-systemd', 'linux-cron', 'ephemeral-container'] as const) {
      await withGuardRig(rig => {
        const reason = 'repo path gone: previously captured checkout\n';
        writeFileSync(rig.marker, reason);
        writeFileSync(rig.strikes, '3\n');
        for (const restored of [false, true]) {
          if (restored) mkdirSync(rig.repo);
          expect(rig.run(target)).toBe('');
          expect(readFileSync(rig.marker, 'utf8')).toBe(reason);
          expect(readFileSync(rig.strikes, 'utf8')).toBe('3\n');
          expect(rig.requests()).toBe('');
        }
      });
    }
  });

  test('consecutive misses retain threshold history and remove only the installed job even if the supervisor fails', async () => {
    for (const target of ['macos', 'linux-systemd'] as const) {
      for (const supervisorExit of [0, 1]) {
        await withGuardRig(rig => {
          expect(rig.job.kind).toBe('suffixed');
          for (const strike of [1, 2]) {
            expect(rig.run(target, supervisorExit)).not.toContain('GUARD_DISPATCH');
            expect(readFileSync(rig.strikes, 'utf8')).toBe(`${strike}\n`);
            expect(existsSync(rig.marker)).toBe(false);
            expect(rig.requests()).toBe('');
          }
          expect(rig.run(target, supervisorExit)).not.toContain('GUARD_DISPATCH');
          expect(readFileSync(rig.marker, 'utf8')).toBe(`repo path gone: ${rig.repo}\n`);
          expect(readFileSync(rig.strikes, 'utf8')).toBe('3\n');
          const expectedRequest = target === 'macos'
            ? `launchctl bootout gui/4242/${rig.job.launchdLabel}\n`
            : `systemctl --user disable --now ${rig.job.systemdUnit}\n`;
          expect(rig.requests()).toBe(expectedRequest);
          expect(rig.run(target, supervisorExit)).toBe('');
          expect(readFileSync(rig.strikes, 'utf8')).toBe('3\n');
          expect(readFileSync(rig.marker, 'utf8')).toBe(`repo path gone: ${rig.repo}\n`);
          expect(rig.requests()).toBe(expectedRequest);
        });
      }
    }
  });

  test('an unmarked successful probe resets misses before the next missing launch', async () => {
    await withGuardRig(rig => {
      rig.run('linux-systemd');
      rig.run('linux-systemd');
      expect(readFileSync(rig.strikes, 'utf8')).toBe('2\n');
      mkdirSync(rig.repo);
      expect(rig.run('linux-systemd')).toBe('GUARD_DISPATCH\n');
      expect(existsSync(rig.strikes)).toBe(false);
      rmSync(rig.repo, { recursive: true });
      expect(rig.run('linux-systemd')).not.toContain('GUARD_DISPATCH');
      expect(readFileSync(rig.strikes, 'utf8')).toBe('1\n');
      expect(existsSync(rig.marker)).toBe(false);
      expect(rig.requests()).toBe('');
    });
  });
});

describe('crontabIndicatesAutopilotInstall', () => {
  test('wrapper line and direct daemon line count as installs', () => {
    expect(crontabIndicatesAutopilotInstall("*/5 * * * * '/h/.gbrain/autopilot-run.sh' >> log 2>&1")).toBe(true);
    expect(crontabIndicatesAutopilotInstall('*/5 * * * * gbrain autopilot --repo /data/brain')).toBe(true);
  });

  test('a status-monitor cron line is NOT an install', () => {
    // docs recommend cron-ing the status command as a health gate; counting
    // it as an install makes a monitor-only machine report installed and
    // never_run with exit 1 forever (adversarial review catch).
    expect(crontabIndicatesAutopilotInstall('*/10 * * * * gbrain autopilot --status --json >> health.log')).toBe(false);
  });

  test('comments and unrelated lines never count', () => {
    expect(crontabIndicatesAutopilotInstall('# gbrain autopilot --repo /data/brain (disabled)')).toBe(false);
    expect(crontabIndicatesAutopilotInstall('0 3 * * * /usr/local/bin/backup.sh')).toBe(false);
    expect(crontabIndicatesAutopilotInstall('')).toBe(false);
  });
});

describe('classifyAutopilotStatus', () => {
  const base = {
    installed: true,
    installTarget: 'macos' as const,
    disabledReason: null as string | null,
    pausedReason: null as string | null,
    heartbeatAgeSeconds: 10,
    intervalSeconds: 300,
    lastLog: '',
  };

  test('THE INCIDENT: installed with a 71-day-old heartbeat → stale, exit 1', () => {
    // This is the case that reported "Autopilot: installed" and exited 0 for
    // 71 days while the daemon was dead.
    const r = classifyAutopilotStatus({ ...base, heartbeatAgeSeconds: 71 * 86400 });
    expect(r.state).toBe('stale');
    expect(autopilotStatusExitCode(r.state)).toBe(1);
  });

  test('fresh heartbeat → fresh, exit 0', () => {
    const r = classifyAutopilotStatus(base);
    expect(r.state).toBe('fresh');
    expect(autopilotStatusExitCode(r.state)).toBe(0);
  });

  test('nothing installed → exit 0 (nothing claimed, nothing broken)', () => {
    const r = classifyAutopilotStatus({ ...base, installed: false, installTarget: null, heartbeatAgeSeconds: null });
    expect(r.state).toBe('not_installed');
    expect(autopilotStatusExitCode(r.state)).toBe(0);
  });

  test('installed but never ticked → never_run, exit 1', () => {
    const r = classifyAutopilotStatus({ ...base, heartbeatAgeSeconds: null });
    expect(r.state).toBe('never_run');
    expect(autopilotStatusExitCode(r.state)).toBe(1);
  });

  test('self-disabled wins over every other signal, exit 2', () => {
    const r = classifyAutopilotStatus({ ...base, disabledReason: 'repo path gone: /data/brain' });
    expect(r.state).toBe('disabled');
    expect(r.disabled_reason).toContain('/data/brain');
    expect(autopilotStatusExitCode(r.state)).toBe(2);
  });

  test('a healthy adaptive-schedule gap does not flip the verdict — a real outage does', () => {
    // The adaptive scheduler sleeps TWO intervals between ticks on the
    // healthiest brains and the heartbeat only refreshes at tick top, so a
    // normal healthy gap is cycle_duration + 2x interval. Tolerance is 6x —
    // review-army catch: at 3x, the best-behaved installs flapped stale
    // exit-1 alarms in the exact cron gates this exit code ships for.
    expect(classifyAutopilotStatus({ ...base, heartbeatAgeSeconds: 301 }).state).toBe('fresh');
    expect(classifyAutopilotStatus({ ...base, heartbeatAgeSeconds: 1799 }).state).toBe('fresh');
    expect(classifyAutopilotStatus({ ...base, heartbeatAgeSeconds: 1801 }).state).toBe('stale');
  });

  test('tolerance scales with the interval, not a hardcoded constant', () => {
    const slow = classifyAutopilotStatus({ ...base, intervalSeconds: 3600, heartbeatAgeSeconds: 5000 });
    expect(slow.stale_after_seconds).toBe(21600);
    expect(slow.state).toBe('fresh');
  });

  test('a garbage interval cannot silence the alarm — NaN staleAfter would read dead as fresh', () => {
    // Pre-fix: `--interval garbage` parsed to NaN, staleAfter = NaN, and every
    // age comparison came back false — the 71-day-dead daemon reported 'fresh'
    // with exit 0. The pure layer now falls back to the default tolerance.
    const r = classifyAutopilotStatus({ ...base, intervalSeconds: NaN, heartbeatAgeSeconds: 71 * 86400 });
    expect(r.stale_after_seconds).toBe(1800);
    expect(r.state).toBe('stale');
    expect(autopilotStatusExitCode(r.state)).toBe(1);
    expect(classifyAutopilotStatus({ ...base, intervalSeconds: 0 }).stale_after_seconds).toBe(1800);
  });

  test('pause marker → paused, exit 1: a parked daemon must not report running', () => {
    // The tick loop refreshes its heartbeat BEFORE honoring the pause marker,
    // so a quiesced daemon looks 'fresh' by mtime while doing no work. Without
    // this state, a marker orphaned by a dead migrate is invisible — the
    // 71-day incident's shape again, reached through the pause path.
    const r = classifyAutopilotStatus({ ...base, pausedReason: 'paused by gbrain migrate at 2026-08-11T00:00:00Z' });
    expect(r.state).toBe('paused');
    expect(r.paused_reason).toContain('gbrain migrate');
    expect(autopilotStatusExitCode(r.state)).toBe(1);
  });

  test('disabled outranks paused; a leftover marker with nothing installed stays quiet', () => {
    // disabled is the stronger, permanent claim (exit 2). And with no install
    // at all, a stray marker pauses nothing — alarming on it would make a
    // clean machine fail its cron gate forever.
    const both = classifyAutopilotStatus({ ...base, disabledReason: 'repo path gone', pausedReason: 'paused' });
    expect(both.state).toBe('disabled');
    const stray = classifyAutopilotStatus({
      ...base, installed: false, installTarget: null, heartbeatAgeSeconds: null, pausedReason: 'paused',
    });
    expect(stray.state).toBe('not_installed');
    expect(autopilotStatusExitCode(stray.state)).toBe(0);
  });
});

describe('autopilotEngineIdentity (post-migration convergence)', () => {
  // Red-team catch: after a clean migration flipped config.json, the daemon
  // never converged — its health probe kept succeeding against the OLD engine
  // (the preserved backup stays alive) and reconnect() deliberately restores
  // the config captured at connect(). The tick loop now compares this
  // identity against its boot value and exits for supervisor relaunch.
  test('changes when the engine kind or connection target changes', () => {
    const pglite = autopilotEngineIdentity({ engine: 'pglite', database_path: '/a/brain.pglite' });
    expect(autopilotEngineIdentity({ engine: 'postgres', database_url: 'postgres://x/db' })).not.toBe(pglite);
    expect(autopilotEngineIdentity({ engine: 'pglite', database_path: '/b/brain.pglite' })).not.toBe(pglite);
  });

  test('ignores everything a migration does not flip — unrelated config edits must not restart the daemon', () => {
    const before = autopilotEngineIdentity({ engine: 'pglite', database_path: '/a/brain.pglite' });
    const after = autopilotEngineIdentity({
      engine: 'pglite', database_path: '/a/brain.pglite',
      embedding_model: 'voyage-3', search: { mode: 'tokenmax' },
    } as Parameters<typeof autopilotEngineIdentity>[0]);
    expect(after).toBe(before);
  });

  test('a missing config file reads as the pglite default, not a crash', () => {
    expect(autopilotEngineIdentity(null)).toBe(autopilotEngineIdentity({ engine: 'pglite' }));
  });
});
