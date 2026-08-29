/**
 * SWX — `deploy/local-http/write-through-probe.ts` answers from the DB plane,
 * which is the plane the runtime reads.
 *
 * The property this exists to establish, and the reason the probe exists at
 * all: `gbrain config get` resolves the FILE plane above the DB plane
 * (src/commands/config.ts), while every runtime disk sink asks
 * `isWriteThroughDisabled`, which reads only `engine.getConfig`
 * (src/core/write-through.ts). A stale `sync.write_through` in
 * ~/.gbrain/config.json therefore makes `config get` print an off value while
 * the brain still mirrors — a check whose whole job is positive confirmation
 * reporting the opposite of the truth.
 *
 * Round-3 review found that property UNGUARDED: every other fixture replaces
 * the probe with a `console.log('<state>')` one-liner, and the one case that
 * ran the real probe pointed it at an empty HOME, so it never reached
 * `isWriteThroughDisabled`. If the probe regressed to `gbrain config get`
 * tomorrow the suite stayed green. This file drives a REAL brain with the two
 * planes deliberately disagreeing.
 *
 * `.serial.test.ts` because it runs `gbrain init` subprocesses against a
 * scratch PGLite brain (seconds each) and mutates process env around them.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..');
const PROBE = join(REPO_ROOT, 'deploy', 'local-http', 'write-through-probe.ts');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');

let home: string;
let configPath: string;

/** Run a command with the scratch brain as GBRAIN_HOME and no ambient brain env. */
function run(cmd: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = { ...process.env, GBRAIN_HOME: home, ...extraEnv } as Record<string, string>;
  delete env.GBRAIN_DATABASE_URL;
  delete env.GBRAIN_DIRECT_DATABASE_URL;
  delete env.GBRAIN_POOL_SIZE;
  return spawnSync(process.execPath, cmd, { encoding: 'utf-8', timeout: 240_000, env });
}

const probe = () => run([PROBE]);

function setFilePlane(value: unknown): void {
  const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  if (value === undefined) {
    delete (cfg as { sync?: Record<string, unknown> }).sync;
  } else {
    (cfg.sync as Record<string, unknown> | undefined) ?? (cfg.sync = {});
    (cfg.sync as Record<string, unknown>).write_through = value;
  }
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

describe('SWX: write-through probe reads the DB plane', () => {
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-wtprobe-'));
    const init = run([CLI, 'init', '--pglite', '--non-interactive', '--no-embedding', '--skip-embed-check']);
    if (init.status !== 0) throw new Error(`init failed (${init.status}):\n${init.stdout}\n${init.stderr}`);
    configPath = join(home, '.gbrain', 'config.json');
    if (!existsSync(configPath)) throw new Error(`no config.json at ${configPath}`);
  }, 300_000);

  afterAll(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test('DB key unset → enabled:unset, exit 1 (upstream fails OPEN)', () => {
    setFilePlane(undefined);
    const r = probe();
    expect(r.stdout.trim()).toBe('enabled:unset');
    expect(r.status).toBe(1);
  }, 120_000);

  test('THE GUARD: file plane says false, DB plane unset → the probe still says enabled', () => {
    // The regression this file exists for. `gbrain config get` answers `false`
    // here — proven in the same case so the two answers are compared on one
    // brain, in one run — while the runtime would still mirror. A probe that
    // regressed to `config get` would print `disabled` and this reddens.
    setFilePlane(false);

    const viaConfigGet = run([CLI, 'config', 'get', 'sync.write_through', '--raw']);
    expect(viaConfigGet.stdout.trim().split('\n').pop()).toBe('false');

    const r = probe();
    expect(
      r.stdout.trim(),
      'the probe answered from the file plane — it must read the plane isWriteThroughDisabled reads',
    ).toBe('enabled:unset');
    expect(r.status).toBe(1);
  }, 120_000);

  test('DB key set to false → disabled, exit 0, even with the file plane disagreeing', () => {
    // The mirror image: file plane says true, DB plane says false. The runtime
    // honours the DB plane, so the probe must too.
    const set = run([CLI, 'config', 'set', 'sync.write_through', 'false']);
    expect(set.status).toBe(0);
    setFilePlane(true);

    const r = probe();
    expect(r.stdout.trim()).toBe('disabled');
    expect(r.status).toBe(0);
  }, 120_000);
});
