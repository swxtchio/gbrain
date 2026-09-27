/**
 * SWX: deploy/local-http/gbrain-http-liveness.sh — the timer-driven probe that
 * restarts a HUNG gbrain-http.service (Restart=on-failure only reacts to exits;
 * a server silent from 19:29Z to 00:51Z while holding :8787 was never restarted).
 *
 * systemctl / ss / curl are PATH stubs driven by env and appending to a call log.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROBE = resolve(import.meta.dir, '../deploy/local-http/gbrain-http-liveness.sh');
const SETUP = resolve(import.meta.dir, '../deploy/local-http/setup.sh');

let base: string;
let calls: string;
let bin: string;
let stateDir: string;

const stub = (name: string, body: string) => {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\n${body}\n`);
  chmodSync(path, 0o755);
};

const ago = (seconds: number) =>
  Bun.spawnSync(['date', '-u', '-d', `@${Math.floor(Date.now() / 1000) - seconds}`, '+%a %Y-%m-%d %H:%M:%S UTC']).stdout.toString().trim();

// HEALTH: ok | 503 | hang (no answer). MAIN_PID: the unit's process (default 4242).
const probe = (env: Record<string, string> = {}) =>
  Bun.spawnSync(['bash', PROBE], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: base, GBRAIN_HTTP_LIVENESS_STATE: stateDir, ACTIVE_SINCE: ago(600), ACTIVE_CALLS: join(base, 'active-calls'), ...env },
  });

const log = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');
const counts = () => (existsSync(join(stateDir, 'counts')) ? readFileSync(join(stateDir, 'counts'), 'utf8').trim() : '');
const restarts = () => (log().match(/systemctl --user try-restart gbrain-http\.service/g) ?? []).length;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'gbrain-liveness-'));
  calls = join(base, 'calls.log');
  bin = join(base, 'bin');
  stateDir = join(base, 'state');
  mkdirSync(bin);
  stub('systemctl', [
    'case "$2" in',
    '  is-active) n=$(( $(cat "$ACTIVE_CALLS" 2>/dev/null || echo 0) + 1 )); echo $n > "$ACTIVE_CALLS"',
    '    [ -n "${STOP_ON_CALL:-}" ] && [ "$n" -ge "$STOP_ON_CALL" ] && exit 3',
    '    exit "${UNIT_ACTIVE:-0}" ;;',
    '  show) case "$4" in',
    '      ActiveEnterTimestamp) echo "$ACTIVE_SINCE" ;;',
    '      ExecStart) echo "{ path=bun ; argv[]=bun gbrain serve --http --port ${UNIT_PORT:-8787} --bind 127.0.0.1 ; }" ;;',
    '      MainPID) echo "${MAIN_PID:-4242}" ;;',
    '    esac ;;',
    'esac',
    'exit 0',
  ].join('\n'));
  stub('ss', 'echo "LISTEN 0 512 127.0.0.1:${UNIT_PORT:-8787} 0.0.0.0:* users:((\\"bun\\",pid=${LISTENER_PID:-${MAIN_PID:-4242}},fd=10))"');
  stub('curl', [
    'case "${HEALTH:-ok}" in',
    '  ok) printf \'{"status":"ok","version":"x","engine":"postgres"}\\n200\' ;;',
    '  503) printf \'{"error":"service_unavailable"}\\n503\' ;;',
    '  hang) printf \'\\n000\'; exit 28 ;;',
    '  partial) printf \'{"status":"ok"\\n200\'; exit 28 ;;',
    'esac',
  ].join('\n'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('gbrain-http-liveness.sh', () => {
  test('a healthy unit is left alone', () => {
    expect(probe().exitCode).toBe(0);
    expect(counts()).toBe('4242 0 0');
    expect(restarts()).toBe(0);
    expect(log()).toContain('http://127.0.0.1:8787/health');
  });

  test('a hung server is restarted after 3 consecutive checks of the same pid', () => {
    for (const n of [1, 2]) {
      expect(probe({ HEALTH: 'hang' }).stdout.toString()).toContain(`hung check failed (${n}/3)`);
      expect(restarts()).toBe(0);
    }
    expect(probe({ HEALTH: 'hang' }).stdout.toString()).toContain('restarting gbrain-http.service');
    expect(restarts()).toBe(1);
    expect(counts()).toBe('');
  });

  test('a degraded (503) server is NOT restarted on the hung threshold', () => {
    for (let i = 1; i <= 9; i++) {
      expect(probe({ HEALTH: '503' }).stdout.toString()).toContain(`degraded check failed (${i}/10)`);
    }
    expect(restarts()).toBe(0);
    expect(probe({ HEALTH: '503' }).stdout.toString()).toContain('10 consecutive degraded failures');
    expect(restarts()).toBe(1);
  });

  test('restarts are capped per hour, so a sustained outage cannot storm', () => {
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 3; i++) probe({ HEALTH: 'hang', MAIN_PID: String(5000 + round) });
    }
    expect(restarts()).toBe(3);
    expect(probe({ HEALTH: 'hang', MAIN_PID: '5003' }).stdout.toString()).toContain('NOT restarting');
    expect(restarts()).toBe(3);
  });

  test('failures of a previous process do not count against its replacement', () => {
    probe({ HEALTH: 'hang' });
    probe({ HEALTH: 'hang' });
    expect(counts()).toBe('4242 2 0');
    // systemd replaced the process between ticks.
    expect(probe({ HEALTH: 'hang', MAIN_PID: '7777' }).stdout.toString()).toContain('hung check failed (1/3) for pid 7777');
    expect(restarts()).toBe(0);
  });

  test('a success resets the count', () => {
    probe({ HEALTH: 'hang' });
    probe({ HEALTH: 'hang' });
    expect(probe().stdout.toString()).toContain('healthy again');
    expect(counts()).toBe('4242 0 0');
  });

  test('an orphan answering on the port does not pass for the unit', () => {
    const r = probe({ LISTENER_PID: '999' });
    expect(r.stdout.toString()).toContain('MainPID 4242 does not own :8787');
    expect(counts()).toBe('4242 1 0');
  });

  test('an inactive unit is not touched', () => {
    probe({ HEALTH: 'hang' });
    expect(probe({ UNIT_ACTIVE: '3', HEALTH: 'hang' }).exitCode).toBe(0);
    expect(restarts()).toBe(0);
    expect(counts()).toBe('');
  });

  test('does nothing inside the startup grace window, and starts the new pid from zero', () => {
    probe({ HEALTH: 'hang' });
    probe({ HEALTH: 'hang' });
    expect(probe({ ACTIVE_SINCE: ago(30), HEALTH: 'hang', MAIN_PID: '8888' }).exitCode).toBe(0);
    expect(counts()).toBe('8888 0 0');
    expect(restarts()).toBe(0);
  });

  test('probes the port the installed unit binds', () => {
    probe({ UNIT_PORT: '9000' });
    expect(log()).toContain('http://127.0.0.1:9000/health');
    expect(log()).not.toContain(':8787/health');
  });
  test('a 200 whose body stalls past the timeout is a hang, not healthy', () => {
    const r = probe({ HEALTH: 'partial' });
    expect(r.stdout.toString()).toContain('hung check failed (1/3)');
    expect(counts()).toBe('4242 1 0');
  });

  test('a stop that lands during the final check is never undone', () => {
    probe({ HEALTH: 'hang' });
    probe({ HEALTH: 'hang' });
    rmSync(join(base, 'active-calls'), { force: true });
    // is-active passes at the start of this run, then the operator's stop lands.
    const r = probe({ HEALTH: 'hang', STOP_ON_CALL: '2' });
    expect(r.stdout.toString()).toContain('unit stopped during the check; not restarting it');
    expect(restarts()).toBe(0);
    expect(log()).not.toMatch(/systemctl --user (try-)?restart/);
  });
});

describe('setup.sh installs the liveness probe', () => {
  test('renders the script path into the unit and enables the timer', () => {
    stub('systemctl', '[ "$2" = show ] && echo 4242\nexit 0');
    stub('ss', 'echo "LISTEN 0 512 127.0.0.1:8787 0.0.0.0:* users:((\\"bun\\",pid=4242,fd=10))"');
    stub('curl', 'echo \'{"status":"ok"}\'');
    stub('journalctl', 'exit 0');
    const r = Bun.spawnSync(['bash', SETUP], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: base, XDG_CONFIG_HOME: join(base, 'config') } });

    expect(r.exitCode).toBe(0);
    const unitDir = join(base, 'config', 'systemd', 'user');
    const service = readFileSync(join(unitDir, 'gbrain-http-liveness.service'), 'utf8');
    const installed = join(base, '.local', 'share', 'gbrain', 'libexec', 'gbrain-http-liveness.sh');
    expect(service).toContain(`ExecStart=${installed}`);
    expect(service).not.toContain(PROBE); // never runs from the checkout (worktrees get removed)
    expect(readFileSync(installed, 'utf8')).toBe(readFileSync(PROBE, 'utf8'));
    expect(service).not.toContain('@LIVENESS_SCRIPT@');
    expect(existsSync(join(unitDir, 'gbrain-http-liveness.timer'))).toBe(true);
    expect(log()).toContain('systemctl --user enable --now gbrain-http-liveness.timer');
    const unit = readFileSync(join(unitDir, 'gbrain-http.service'), 'utf8');
    expect(unit).toContain('GBRAIN_SERVE_STALL_WATCHDOG_MS=60000');
    // A watchdog SIGTERM can end in a clean exit 0; on-failure would leave it down.
    expect(unit).toContain('Restart=always');
    expect(unit).not.toContain('Restart=on-failure');
  });
});
