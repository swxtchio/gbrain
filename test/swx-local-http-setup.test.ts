/**
 * SWX: deploy/local-http/setup.sh is documented as safe to re-run after editing
 * the unit. `systemctl enable --now` only starts an INACTIVE unit, so a re-run
 * against a running service left the old process and settings in place. The
 * script must restart the unit, and only report healthy when that unit is
 * active (not merely when something answers on the port).
 *
 * systemctl / curl are PATH stubs that append to a call log.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SETUP = resolve(import.meta.dir, '../deploy/local-http/setup.sh');

let base: string;
let calls: string;
let bin: string;

const stub = (name: string, body: string) => {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\n${body}\n`);
  chmodSync(path, 0o755);
};

const runSetup = (extraEnv: Record<string, string> = {}) =>
  Bun.spawnSync(['bash', SETUP], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: base, XDG_CONFIG_HOME: join(base, 'config'), ...extraEnv },
  });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'gbrain-local-http-'));
  calls = join(base, 'calls.log');
  bin = join(base, 'bin');
  mkdirSync(bin);
  stub('curl', 'exit 0');
  stub('journalctl', 'exit 0');
  stub('sleep', 'exit 0');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('deploy/local-http/setup.sh', () => {
  test('installs the unit and restarts it so an edited unit takes effect', () => {
    stub('systemctl', 'exit 0');

    const r = runSetup();

    expect(r.exitCode).toBe(0);
    expect(existsSync(join(base, 'config', 'systemd', 'user', 'gbrain-http.service'))).toBe(true);
    const log = readFileSync(calls, 'utf8');
    expect(log).toContain('systemctl --user daemon-reload');
    expect(log).toContain('systemctl --user restart gbrain-http.service');
  });

  test('does not report healthy while the unit is inactive, even if the port answers', () => {
    // is-active fails; everything else succeeds; curl (the port) answers.
    stub('systemctl', '[ "$2" = is-active ] && exit 3\nexit 0');

    const r = runSetup();

    expect(r.exitCode).toBe(1);
    expect(r.stdout.toString()).not.toContain('Healthy');
  });

  test('GBRAIN_HTTP_PORT reaches the installed unit, not just the health probe', () => {
    stub('systemctl', 'exit 0');

    const r = runSetup({ GBRAIN_HTTP_PORT: '9000' });

    expect(r.exitCode).toBe(0);
    const unit = readFileSync(join(base, 'config', 'systemd', 'user', 'gbrain-http.service'), 'utf8');
    expect(unit).toContain('--port 9000 ');
    expect(unit).not.toContain('--port 8787');
    expect(readFileSync(calls, 'utf8')).toContain('http://127.0.0.1:9000/health');
  });
});
