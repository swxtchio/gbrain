/**
 * SWX — a stale `sources.chunker_version` forces a full re-walk even when git
 * HEAD has not moved.
 *
 * This is the delivery mechanism the fork's CHUNKER_VERSION bump depends on:
 * without it the bump changes a constant and nothing else, and an
 * already-synced brain never receives the C/C++ carry or the index.md carry.
 *
 * Round-2 review found nothing anywhere observed it — the round-1 test asserted
 * only that the COST ESTIMATOR moved from "unchanged" to "ceiling", which is a
 * pricing proxy for the walk rather than the walk (`grep -rn chunker_version
 * test/` found no other observer; test/reindex.test.ts covers only
 * pages.chunker_version, the markdown lane). This file observes the sync
 * itself.
 *
 * `.serial.test.ts` because it spawns git subprocesses and shares one PGLite
 * engine across cases.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runSources } from '../src/commands/sources.ts';
import { CHUNKER_VERSION } from '../src/core/chunkers/code.ts';

let engine: PGLiteEngine;
let repoPath: string;

const SYNC = { noPull: true, noEmbed: true, sourceId: 'vault' } as const;

async function storedVersion(): Promise<string | null> {
  const rows = await engine.executeRaw<{ chunker_version: string | null }>(
    `SELECT chunker_version FROM sources WHERE id = 'vault'`,
  );
  const list = (rows as { rows?: Array<{ chunker_version: string | null }> })?.rows
    ?? (rows as unknown as Array<{ chunker_version: string | null }>);
  return list[0]?.chunker_version ?? null;
}

describe('SWX — sources.chunker_version drift forces the walk', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-chunkrewalk-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'topics'), { recursive: true });
    writeFileSync(
      join(repoPath, 'topics/foo.md'),
      ['---', 'type: concept', 'title: Foo', '---', '', 'Baseline content.'].join('\n'),
    );
    execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
    await runSources(engine, ['add', 'vault', '--path', repoPath, '--no-federated']);
  }, 60_000);

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('control: HEAD unchanged and version CURRENT → the sync short-circuits', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, { repoPath, ...SYNC });
    expect(await storedVersion()).toBe(String(CHUNKER_VERSION));

    // Nothing changed on disk and the stamp is current: this is the
    // short-circuit the drift gate has to defeat.
    const second = await performSync(engine, { repoPath, ...SYNC });
    expect(second.status).toBe('up_to_date');
  }, 90_000);

  test('a STALE stored version re-walks the same unchanged tree', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, { repoPath, ...SYNC });

    // Only the stamp changes — same HEAD, same files, same everything else as
    // the control above, so the difference in outcome is the gate.
    await engine.executeRaw(
      `UPDATE sources SET chunker_version = $1 WHERE id = 'vault'`,
      [String(CHUNKER_VERSION - 1)],
    );

    const after = await performSync(engine, { repoPath, ...SYNC });
    expect(after.status).not.toBe('up_to_date');
    // And the walk re-stamps the source, so the next run short-circuits again.
    expect(await storedVersion()).toBe(String(CHUNKER_VERSION));
    const third = await performSync(engine, { repoPath, ...SYNC });
    expect(third.status).toBe('up_to_date');
  }, 90_000);
});
