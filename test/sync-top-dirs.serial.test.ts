/**
 * SWX — GBRAIN_TOP_DIRS holds on the INCREMENTAL sync lane, not just on full
 * enumeration.
 *
 * Round-1 review (codex 1 / claude 2 / f5-panel 2, blocking) found the
 * allowlist implemented only inside `collectSyncableFiles`, while
 * `performSyncInner` filters its git-diff manifest through
 * inScope/excluded/isSyncable and never calls that enumerator. So a file under
 * a non-allowlisted top dir was excluded by the first full sync and then
 * imported by the next commit-driven one — the allowlist leaked one commit at
 * a time.
 *
 * The fix moved the gate into `classifySync` (core/sync.ts), which every lane
 * already routes through, so all three file-selection lanes agree by
 * construction. This test is the end-to-end proof of that: a real git repo, a
 * real full sync, a real incremental sync, against PGLite.
 *
 * `.serial.test.ts` because it spawns git subprocesses and mutates
 * process.env.GBRAIN_TOP_DIRS around a shared engine.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let repoPath: string;
let priorTopDirs: string | undefined;

function gitInit(repo: string): void {
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repo, stdio: 'pipe' });
}

function page(title: string, body: string): string {
  return ['---', 'type: concept', `title: ${title}`, '---', '', body].join('\n');
}

describe('SWX — GBRAIN_TOP_DIRS on the incremental sync lane', () => {
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
    priorTopDirs = process.env.GBRAIN_TOP_DIRS;
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-top-dirs-'));
    gitInit(repoPath);
    mkdirSync(join(repoPath, 'allowed'), { recursive: true });
    mkdirSync(join(repoPath, 'blocked'), { recursive: true });
    writeFileSync(join(repoPath, 'allowed/seed.md'), page('Allowed Seed', 'In the allowlist.'));
    writeFileSync(join(repoPath, 'blocked/seed.md'), page('Blocked Seed', 'Outside the allowlist.'));
    execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
  });

  afterEach(() => {
    if (priorTopDirs === undefined) delete process.env.GBRAIN_TOP_DIRS;
    else process.env.GBRAIN_TOP_DIRS = priorTopDirs;
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('a commit under a non-allowlisted top dir is not imported by the incremental lane', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    process.env.GBRAIN_TOP_DIRS = 'allowed';

    const first = await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    expect(['first_sync', 'synced']).toContain(first.status);
    expect(await engine.getPage('allowed/seed')).not.toBeNull();
    expect(await engine.getPage('blocked/seed')).toBeNull();

    // The reported reproduction: a NEW commit under the blocked top dir. The
    // full enumerator never runs on this path — the git-diff manifest does.
    writeFileSync(join(repoPath, 'blocked/later.md'), page('Blocked Later', 'Added after the full sync.'));
    writeFileSync(join(repoPath, 'allowed/later.md'), page('Allowed Later', 'Added after the full sync.'));
    execSync('git add -A && git commit -m "add later files"', { cwd: repoPath, stdio: 'pipe' });

    const second = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(['synced', 'up_to_date', 'blocked_by_failures']).toContain(second.status);

    // The allowlisted sibling in the SAME commit proves the incremental lane
    // actually ran and imported — so the absence below is the allowlist, not
    // a sync that did nothing.
    expect(await engine.getPage('allowed/later')).not.toBeNull();
    expect(await engine.getPage('blocked/later')).toBeNull();
  }, 90_000);

  test('a page under a newly-blocked top dir survives an edit to its file', async () => {
    // The #2404 data-loss class, in the GBRAIN_TOP_DIRS shape: import first
    // with no allowlist, then turn one on and edit the now-blocked file. The
    // unsyncable-modified cleanup loop must NOT read "modified but not
    // syncable" as "stale page" — sync never imports that path any more, so
    // the edit is no evidence at all about the page.
    const { performSync } = await import('../src/commands/sync.ts');
    delete process.env.GBRAIN_TOP_DIRS;
    await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    expect(await engine.getPage('blocked/seed')).not.toBeNull();

    process.env.GBRAIN_TOP_DIRS = 'allowed';
    writeFileSync(join(repoPath, 'blocked/seed.md'), page('Blocked Seed', 'Edited after the allowlist went on.'));
    execSync('git add -A && git commit -m "edit blocked file"', { cwd: repoPath, stdio: 'pipe' });
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });

    const survivor = await engine.getPage('blocked/seed');
    expect(survivor).not.toBeNull();
    expect(survivor?.compiled_truth).toContain('Outside the allowlist');
  }, 90_000);

  test('with the allowlist unset, the same commit imports both (upstream default)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    delete process.env.GBRAIN_TOP_DIRS;

    await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    writeFileSync(join(repoPath, 'blocked/later.md'), page('Blocked Later', 'Added after the full sync.'));
    execSync('git add -A && git commit -m "add later file"', { cwd: repoPath, stdio: 'pipe' });
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });

    expect(await engine.getPage('blocked/seed')).not.toBeNull();
    expect(await engine.getPage('blocked/later')).not.toBeNull();
  }, 90_000);
});
