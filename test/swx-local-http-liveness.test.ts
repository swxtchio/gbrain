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
let state: string;

const stub = (name: string, body: string) => {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\n${body}\n`);
  chmodSync(path, 0o755);
};

const ago = (seconds: number) =>
  Bun.spawnSync(['date', '-u', '-d', `@${Math.floor(Date.now() / 1000) - seconds}`, '+%a %Y-%m-%d %H:%M:%S UTC']).stdout.toString().trim();

const probe = (env: Record<string, string> = {}) =>
  Bun.spawnSync(['bash', PROBE], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: base, GBRAIN_HTTP_LIVENESS_STATE: state, ACTIVE_SINCE: ago(600), ...env },
  });

const log = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '');
const failures = () => (existsSync(state) ? readFileSync(state, 'utf8').trim() : '0');

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'gbrain-liveness-'));
  calls = join(base, 'calls.log');
  bin = join(base, 'bin');
  state = join(base, 'state', 'failures');
  mkdirSync(bin);
  stub('systemctl', [
    'case "$2" in',
    '  is-active) exit "${UNIT_ACTIVE:-0}" ;;',
    '  show) case "$4" in',
    '      ActiveEnterTimestamp) echo "$ACTIVE_SINCE" ;;',
    '      ExecStart) echo "{ path=bun ; argv[]=bun gbrain serve --http --port ${UNIT_PORT:-8787} --bind 127.0.0.1 ; }" ;;',
    '      MainPID) echo 4242 ;;',
    '    esac ;;',
    'esac',
    'exit 0',
  ].join('\n'));
  stub('ss', 'echo "LISTEN 0 512 127.0.0.1:${UNIT_PORT:-8787} 0.0.0.0:* users:((\\"bun\\",pid=${LISTENER_PID:-4242},fd=10))"');
  stub('curl', '[ "${HEALTH_OK:-1}" = 1 ] && echo \'{"status":"ok","version":"x","engine":"postgres"}\' && exit 0\nexit 22');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('gbrain-http-liveness.sh', () => {
  test('a healthy unit is left alone and the counter stays at 0', () => {
    expect(probe().exitCode).toBe(0);
    expect(failures()).toBe('0');
    expect(log()).not.toContain('restart');
    expect(log()).toContain('http://127.0.0.1:8787/health');
  });

  test('restarts only after THRESHOLD consecutive failures, then resets', () => {
    for (const expected of ['1', '2']) {
      const r = probe({ HEALTH_OK: '0' });
      expect(r.stdout.toString()).toContain(`check failed (${expected}/3)`);
      expect(failures()).toBe(expected);
      expect(log()).not.toContain('systemctl --user restart');
    }
    const third = probe({ HEALTH_OK: '0' });
    expect(third.stdout.toString()).toContain('restarting gbrain-http.service');
    expect(log()).toContain('systemctl --user restart gbrain-http.service');
    expect(failures()).toBe('0');
  });

  test('a success between failures resets the count', () => {
    probe({ HEALTH_OK: '0' });
    probe({ HEALTH_OK: '0' });
    expect(probe().stdout.toString()).toContain('healthy again');
    expect(failures()).toBe('0');
    probe({ HEALTH_OK: '0' });
    expect(failures()).toBe('1');
    expect(log()).not.toContain('systemctl --user restart');
  });

  test('an orphan answering on the port does not pass for the unit', () => {
    const r = probe({ LISTENER_PID: '999' });
    expect(r.stdout.toString()).toContain('MainPID 4242 does not own :8787');
    expect(failures()).toBe('1');
  });

  test('an inactive unit is not touched (stopped on purpose, or Restart= is on it)', () => {
    writeFileSync(join(base, 'seed'), '');
    mkdirSync(join(base, 'state'), { recursive: true });
    writeFileSync(state, '2\n');
    expect(probe({ UNIT_ACTIVE: '3', HEALTH_OK: '0' }).exitCode).toBe(0);
    expect(log()).not.toContain('restart');
    expect(log()).not.toContain('curl');
    expect(failures()).toBe('0');
  });

  test('does nothing inside the startup grace window', () => {
    expect(probe({ ACTIVE_SINCE: ago(30), HEALTH_OK: '0' }).exitCode).toBe(0);
    expect(failures()).toBe('0');
    expect(log()).not.toContain('curl');
  });

  test('probes the port the installed unit binds', () => {
    probe({ UNIT_PORT: '9000' });
    expect(log()).toContain('http://127.0.0.1:9000/health');
    expect(log()).not.toContain(':8787/health');
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
    expect(service).toContain(`ExecStart=${PROBE}`);
    expect(service).not.toContain('@LIVENESS_SCRIPT@');
    expect(existsSync(join(unitDir, 'gbrain-http-liveness.timer'))).toBe(true);
    expect(log()).toContain('systemctl --user enable --now gbrain-http-liveness.timer');
    expect(readFileSync(join(unitDir, 'gbrain-http.service'), 'utf8')).toContain('GBRAIN_SERVE_STALL_WATCHDOG_MS=60000');
  });
});
