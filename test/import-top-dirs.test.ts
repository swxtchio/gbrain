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

const ENV = 'GBRAIN_TOP_DIRS';
let savedEnv: string | undefined;
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
  savedEnv = process.env[ENV];
  write('swx-allowed/page.md', '# Allowed\n');
  write('swx-allowed/nested/deep.md', '# Deep\n');
  write('other-repo/page.md', '# Other\n');
  write('future-repo/new.md', '# Future\n');
  write('root-level.md', '# Root\n');
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  rmSync(tmp, { recursive: true, force: true });
});

describe('GBRAIN_TOP_DIRS allowlist (SWX)', () => {
  test('FS-walk path: only allowlisted top dirs descend; root files still collect', () => {
    process.env[ENV] = 'swx-allowed';
    const got = collectedRel();
    expect(got).toEqual(['root-level.md', 'swx-allowed/nested/deep.md', 'swx-allowed/page.md']);
  });

  test('git-fast-path: the allowlist is NOT bypassed inside a work tree', () => {
    execFileSync('git', ['-C', tmp, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', tmp, 'add', '-A'], { stdio: 'ignore' });
    process.env[ENV] = 'swx-allowed';
    const got = collectedRel();
    expect(got).toEqual(['root-level.md', 'swx-allowed/nested/deep.md', 'swx-allowed/page.md']);
  });

  test('comma list with spaces trims; empty entries ignored', () => {
    process.env[ENV] = ' swx-allowed , ,other-repo,';
    const got = collectedRel();
    expect(got).toEqual([
      'other-repo/page.md',
      'root-level.md',
      'swx-allowed/nested/deep.md',
      'swx-allowed/page.md',
    ]);
  });

  test('unset env collects everything (upstream default unchanged)', () => {
    delete process.env[ENV];
    const got = collectedRel();
    expect(got).toContain('other-repo/page.md');
    expect(got).toContain('future-repo/new.md');
    expect(got).toContain('swx-allowed/page.md');
    expect(got).toContain('root-level.md');
  });
});
