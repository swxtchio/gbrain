/**
 * SWX: GBRAIN_TOP_DIRS was retired (swxtchio/gbrain#16). It was a process-global
 * top-level allowlist applied to EVERY source's file collection, so a full sync
 * of an unrelated source could drop that source's files from `currentFiles` and
 * soft-delete their pages. Setting it must now filter nothing, on both
 * enumeration routes, so it can never cause a delete.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { collectSyncableFiles } from '../src/commands/import.ts';
import { withEnv } from './helpers/with-env.ts';

let root: string;
const ALL = ['allowed/a.md', 'excluded/c.md', 'root.md'];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-top-dirs-retired-'));
  for (const path of ALL) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), '# page\n');
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const collect = () =>
  withEnv({ GBRAIN_TOP_DIRS: 'allowed' }, async () =>
    collectSyncableFiles(root).map((full) => relative(root, full)).sort(),
  );

describe('GBRAIN_TOP_DIRS (retired)', () => {
  test('filesystem walk ignores it and collects every directory', async () => {
    expect(await collect()).toEqual(ALL);
  });

  test('git-enumerated root ignores it too', async () => {
    expect(Bun.spawnSync(['git', 'init', '-q', root]).exitCode).toBe(0);
    expect(await collect()).toEqual(ALL);
  });
});
