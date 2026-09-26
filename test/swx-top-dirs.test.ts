/**
 * SWX local patch: GBRAIN_TOP_DIRS scopes a multi-repo brain root to a fixed
 * set of top-level directories. The allowlist must hold on BOTH enumeration
 * routes of collectSyncableFiles: the FS walk (non-git root) and git ls-files
 * (git root). The git route returned early and skipped the allowlist, so a
 * git-tracked brain root imported every sibling directory.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { collectSyncableFiles } from '../src/commands/import.ts';
import { withEnv } from './helpers/with-env.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-top-dirs-'));
  for (const [path, body] of [
    ['allowed/a.md', '# a\n'],
    ['allowed/nested/b.md', '# b\n'],
    ['excluded/c.md', '# c\n'],
    ['root.md', '# root\n'],
  ]) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const collect = () =>
  withEnv({ GBRAIN_TOP_DIRS: 'allowed' }, async () =>
    collectSyncableFiles(root).map((full) => relative(root, full)).sort(),
  );

describe('GBRAIN_TOP_DIRS', () => {
  test('filesystem walk keeps only allowed top-level dirs plus root files', async () => {
    expect(await collect()).toEqual(['allowed/a.md', 'allowed/nested/b.md', 'root.md']);
  });

  test('git-enumerated root applies the same allowlist', async () => {
    const init = Bun.spawnSync(['git', 'init', '-q', root]);
    expect(init.exitCode).toBe(0);
    expect(await collect()).toEqual(['allowed/a.md', 'allowed/nested/b.md', 'root.md']);
  });

  test('unset GBRAIN_TOP_DIRS imports every directory on the git route', async () => {
    Bun.spawnSync(['git', 'init', '-q', root]);
    const all = await withEnv({ GBRAIN_TOP_DIRS: undefined }, async () =>
      collectSyncableFiles(root).map((full) => relative(root, full)).sort(),
    );
    expect(all).toEqual(['allowed/a.md', 'allowed/nested/b.md', 'excluded/c.md', 'root.md']);
  });
});
