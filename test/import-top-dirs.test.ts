/**
 * SWX port — GBRAIN_TOP_DIRS allowlist scoping in collectSyncableFiles.
 *
 * Re-port of the GBRAIN_TOP_DIRS item from 88a02775 onto current master.
 * The review-round-1 panel falsified the p1 crew's RETIRE verdict: the cited
 * replacement (per-source registration + per-source walking) PREDATES the
 * 2026-06-09 fork patch (multi-source landed v0.18.0, 90c5d93f, 2026-04-22),
 * and no post-dating upstream change supplies an allowlist of top-level
 * directory NAMES at a mono-root — `--exclude` (f72de979) is exclusion-only
 * and cannot express deny-all-except. Per the panel's invariant the honest
 * outcome is CARRY.
 *
 * The re-apply trap the p1 plan named: upstream gained a git-aware fast path
 * (gitListSyncableFiles), so a walk-only filter is silently bypassed whenever
 * the brain root is a work tree. These tests pin the allowlist on BOTH
 * enumeration routes.
 *
 * Fail-without proof: pre-patch, GBRAIN_TOP_DIRS is unread by the walker, so
 * dir-b content is collected on both routes and every test below fails.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, relative } from 'path';
import { tmpdir } from 'os';
import { collectSyncableFiles } from '../src/commands/import.ts';
import { withEnv } from './helpers/with-env.ts';

const ENV = 'GBRAIN_TOP_DIRS';
let tmp: string;

function write(relPath: string, content: string): void {
  const full = join(tmp, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function collectedRel(): string[] {
  return collectSyncableFiles(tmp)
    .map(f => relative(tmp, f).split('\\').join('/'))
    .sort();
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-top-dirs-'));
  write('swx-allowed/page.md', '# Allowed\n');
  write('swx-allowed/nested/deep.md', '# Deep\n');
  write('other-repo/page.md', '# Other\n');
  write('future-repo/new.md', '# Future\n');
  write('root-level.md', '# Root\n');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('GBRAIN_TOP_DIRS allowlist (SWX)', () => {
  test('FS-walk path (NON-GIT root): the descent gate is the only enforcement here', async () => {
    // `tmp` is deliberately not a git repo in this case, so the git fast path
    // is skipped and the walk runs. Round-2 review established this matters:
    // the walk emits via isCollectibleForWalker, which never calls isSyncable,
    // and runImport does not re-filter the collected list through it — so the
    // descent gate in collectSyncableFiles is the ONLY thing enforcing the
    // allowlist on a non-git brain root. Deleting it as a "duplicate of
    // classifySync" would silently un-scope every such brain, and this case is
    // what would catch that.
    await withEnv({ [ENV]: 'swx-allowed' }, async () => {
      expect(collectedRel()).toEqual(['root-level.md', 'swx-allowed/nested/deep.md', 'swx-allowed/page.md']);
    });
  });

  test('git-fast-path: the allowlist is NOT bypassed inside a work tree', async () => {
    execFileSync('git', ['-C', tmp, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', tmp, 'add', '-A'], { stdio: 'ignore' });
    await withEnv({ [ENV]: 'swx-allowed' }, async () => {
      expect(collectedRel()).toEqual(['root-level.md', 'swx-allowed/nested/deep.md', 'swx-allowed/page.md']);
    });
  });

  test('comma list with spaces trims; empty entries ignored', async () => {
    await withEnv({ [ENV]: ' swx-allowed , ,other-repo,' }, async () => {
      expect(collectedRel()).toEqual([
        'other-repo/page.md',
        'root-level.md',
        'swx-allowed/nested/deep.md',
        'swx-allowed/page.md',
      ]);
    });
  });

  test('unset env collects everything (upstream default unchanged)', async () => {
    await withEnv({ [ENV]: undefined }, async () => {
      const got = collectedRel();
      expect(got).toContain('other-repo/page.md');
      expect(got).toContain('future-repo/new.md');
      expect(got).toContain('swx-allowed/page.md');
      expect(got).toContain('root-level.md');
    });
  });
});
