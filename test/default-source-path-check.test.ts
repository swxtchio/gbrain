/**
 * default_source_local_path doctor check (#4739, narrowed) +
 * `gbrain sources set-path` repair command.
 *
 * The upstream PR warned on EVERY null default.local_path — but that is the
 * DESIGNED fallback topology (resolvePageWriteTarget nests default under
 * sync.repo_path, and the #2018 leak guard blocks writes into another
 * source's tree), so it would have warned on every fresh init. These tests
 * pin the narrowed contract:
 *
 *   - null local_path + resolvable sync.repo_path (no collision) → ok
 *     (THE discriminator against the upstream over-broad check);
 *   - null local_path + no pages → ok;
 *   - null local_path + pages + sync.repo_path colliding with another
 *     source's own local_path (leak-guarded) → warn;
 *   - null local_path + FILE-BACKED pages + no resolvable root → warn;
 *   - null local_path + born-in-DB pages only + no repo configured → ok
 *     (DB-only by design);
 *   - local_path set → ok; no default row at all → skip / no check row.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { assessDefaultSourcePath } from '../src/core/default-source-path-check.ts';
import { defaultSourceLocalPathCheck } from '../src/commands/doctor/checks/default-source-path.ts';
import { sourceLocalPathCheck } from '../src/commands/doctor/checks/source-local-path.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { onlyNeedsEngine } from '../src/commands/doctor/registry.ts';

// ---------------------------------------------------------------------------
// Pure assessment helper
// ---------------------------------------------------------------------------

const BASE = {
  defaultSource: { local_path: null as string | null },
  livePages: 0,
  fileBackedPages: 0,
  repoPath: null as string | null,
  repoPathIsDir: false,
  collidingSourceId: null as string | null,
};

describe('assessDefaultSourcePath (pure)', () => {
  test('no default row at all → skip', () => {
    const a = assessDefaultSourcePath({ ...BASE, defaultSource: undefined });
    expect(a.status).toBe('skip');
  });

  test('local_path set → ok', () => {
    const a = assessDefaultSourcePath({
      ...BASE,
      defaultSource: { local_path: '/some/dir' },
    });
    expect(a.status).toBe('ok');
    expect(a.message).toContain('/some/dir');
  });

  test('null local_path + no pages → ok (nothing routes through it yet)', () => {
    const a = assessDefaultSourcePath({ ...BASE, livePages: 0 });
    expect(a.status).toBe('ok');
  });

  test('null local_path + pages + RESOLVABLE sync.repo_path → ok (the designed fallback — the upstream check warned here)', () => {
    const a = assessDefaultSourcePath({
      ...BASE,
      livePages: 12,
      repoPath: '/brain/repo',
      repoPathIsDir: true,
    });
    expect(a.status).toBe('ok');
    expect(a.message).toContain('designed fallback');
  });

  test('null local_path + pages + repo_path colliding with another source (leak-guarded) → warn', () => {
    const a = assessDefaultSourcePath({
      ...BASE,
      livePages: 3,
      repoPath: '/other/tree',
      repoPathIsDir: true,
      collidingSourceId: 'wiki',
    });
    expect(a.status).toBe('warn');
    expect(a.message).toContain('wiki');
    expect(a.message).toContain('sources set-path default');
  });

  test('null local_path + FILE-BACKED pages + no resolvable root → warn', () => {
    const a = assessDefaultSourcePath({
      ...BASE,
      livePages: 5,
      fileBackedPages: 4,
      repoPath: null,
    });
    expect(a.status).toBe('warn');
    expect(a.message).toContain('file-backed');
    expect(a.message).toContain('sources set-path default');
  });

  test('null local_path + FILE-BACKED pages + repo_path set but not a dir → warn', () => {
    const a = assessDefaultSourcePath({
      ...BASE,
      livePages: 5,
      fileBackedPages: 1,
      repoPath: '/gone/away',
      repoPathIsDir: false,
    });
    expect(a.status).toBe('warn');
  });

  test('null local_path + born-in-DB pages only + no repo configured → ok (DB-only by design)', () => {
    const a = assessDefaultSourcePath({
      ...BASE,
      livePages: 7,
      fileBackedPages: 0,
      repoPath: null,
    });
    expect(a.status).toBe('ok');
    expect(a.message).toContain('DB-only');
  });
});

// ---------------------------------------------------------------------------
// Engine-level wiring (gathers real rows/config; real in-memory PGLite)
// ---------------------------------------------------------------------------

describe('defaultSourceLocalPathCheck (engine wiring)', () => {
  let engine: PGLiteEngine;
  const tmpDirs: string[] = [];

  function makeDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'gb-dsp-'));
    tmpDirs.push(d);
    return d;
  }

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  test('fresh brain (null local_path, no pages) → ok, not warn', async () => {
    const check = await defaultSourceLocalPathCheck(engine);
    expect(check).not.toBeNull();
    expect(check!.name).toBe('default_source_local_path');
    expect(check!.status).toBe('ok');
  });

  test('pages routing through a resolvable sync.repo_path → ok (fresh-init-like topology)', async () => {
    const repo = makeDir();
    await engine.setConfig('sync.repo_path', repo);
    await engine.putPage('notes/hello', { type: 'note', title: 'hello', compiled_truth: 'body' });
    const check = await defaultSourceLocalPathCheck(engine);
    expect(check!.status).toBe('ok');
  });

  test('file-backed default pages with NO resolvable root → warn', async () => {
    await engine.putPage('notes/filed', { type: 'note', title: 'filed', compiled_truth: 'body' });
    await engine.executeRaw(
      `UPDATE pages SET source_path = 'notes/filed.md' WHERE slug = 'notes/filed' AND source_id = 'default'`,
    );
    const check = await defaultSourceLocalPathCheck(engine);
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain('sources set-path default');
  });

  test('sync.repo_path that is another source\'s own working tree (leak-guarded) → warn', async () => {
    const tree = makeDir();
    await engine.setConfig('sync.repo_path', tree);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config) VALUES ('wiki', 'wiki', $1, '{}'::jsonb)
       ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
      [tree],
    );
    await engine.putPage('notes/leaky', { type: 'note', title: 'leaky', compiled_truth: 'body' });
    const check = await defaultSourceLocalPathCheck(engine);
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain('wiki');
  });

  test('local_path set on default → ok without gathering fallback inputs', async () => {
    const d = makeDir();
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [d]);
    const check = await defaultSourceLocalPathCheck(engine);
    expect(check!.status).toBe('ok');
    expect(check!.message).toContain(d);
  });

  test('registered doctor entry reports every unusable active path beside a healthy default', async () => {
    const defaultRoot = makeDir();
    const healthyRoot = makeDir();
    const missingParent = makeDir();
    const missingPath = join(missingParent, 'missing-checkout');
    const notDirectory = join(makeDir(), 'regular-file');
    const archivedParent = makeDir();
    const archivedPath = join(archivedParent, 'retired-checkout');
    writeFileSync(notDirectory, 'controlled fixture');

    await engine.setConfig('sync.repo_path', defaultRoot);
    await engine.putPage('notes/default', { type: 'note', title: 'default', compiled_truth: 'body' });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived)
       VALUES ($1, $1, $2, '{}'::jsonb, $3)`,
      ['wiki', missingPath, false],
    );
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived)
       VALUES ($1, $1, $2, '{}'::jsonb, $3)`,
      ['research', healthyRoot, false],
    );
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived)
       VALUES ($1, $1, $2, '{}'::jsonb, $3)`,
      ['file-source', notDirectory, false],
    );
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived)
       VALUES ($1, $1, $2, '{}'::jsonb, $3)`,
      ['retired', archivedPath, true],
    );
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived)
       VALUES ($1, $1, NULL, '{}'::jsonb, $2)`,
      ['db-only', false],
    );

    const checks = await buildChecks(engine, [
      '--only',
      'default_source_local_path,source_local_path_resolvable',
      '--json',
    ]);
    const defaultCheck = checks.find((check) => check.name === 'default_source_local_path');
    const sourcePathCheck = checks.find((check) => check.name === 'source_local_path_resolvable');

    expect(defaultCheck?.status).toBe('ok');
    expect(sourcePathCheck?.status).toBe('fail');
    expect(sourcePathCheck?.message).toContain(`wiki (${missingPath})`);
    expect(sourcePathCheck?.message).toContain('directory does not exist on this host');
    expect(sourcePathCheck?.message).toContain('gbrain sources set-path wiki <path>');
    expect(sourcePathCheck?.message).toContain(`file-source (${notDirectory})`);
    expect(sourcePathCheck?.message).toContain('path is not a directory');
    expect(sourcePathCheck?.message).toContain('gbrain sources set-path file-source <path>');
    expect(sourcePathCheck?.message).not.toContain('retired');
    expect(sourcePathCheck?.message).not.toContain('db-only');
    expect(sourcePathCheck?.message).not.toContain('research');
    expect(onlyNeedsEngine(new Set(['source_local_path_resolvable']))).toBe(true);
  });

  test('registered doctor entry treats an empty local_path as absent', async () => {
    const repo = makeDir();
    await engine.executeRaw(`UPDATE sources SET local_path = '' WHERE id = 'default'`);
    await engine.setConfig('sync.repo_path', repo);
    await engine.putPage('notes/default-empty-path', { type: 'note', title: 'default', compiled_truth: 'body' });

    const checks = await buildChecks(engine, [
      '--only',
      'default_source_local_path,source_local_path_resolvable',
      '--json',
    ]);
    const defaultCheck = checks.find((check) => check.name === 'default_source_local_path');
    const sourcePathCheck = checks.find((check) => check.name === 'source_local_path_resolvable');
    expect(defaultCheck?.status).toBe('ok');
    expect(sourcePathCheck?.status).toBe('ok');
    expect(sourcePathCheck?.message).toContain('No active source has an explicit local_path');
  });

  test('registered doctor entry assesses an explicit default local_path', async () => {
    const missingParent = makeDir();
    const missingPath = join(missingParent, 'missing-default-checkout');
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [missingPath]);

    const checks = await buildChecks(engine, [
      '--only',
      'default_source_local_path,source_local_path_resolvable',
      '--json',
    ]);
    const defaultCheck = checks.find((check) => check.name === 'default_source_local_path');
    const sourcePathCheck = checks.find((check) => check.name === 'source_local_path_resolvable');

    expect(defaultCheck?.status).toBe('ok');
    expect(sourcePathCheck?.status).toBe('fail');
    expect(sourcePathCheck?.message).toContain(`default (${missingPath})`);
    expect(sourcePathCheck?.message).toContain('gbrain sources set-path default <path>');
  });

  test('registered doctor entry reports explicit readable directories as healthy', async () => {
    const defaultRoot = makeDir();
    const sourceRoot = makeDir();
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [defaultRoot]);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived)
       VALUES ($1, $1, $2, '{}'::jsonb, false)`,
      ['wiki', sourceRoot],
    );

    const checks = await buildChecks(engine, ['--only', 'source_local_path_resolvable', '--json']);
    const sourcePathCheck = checks.find((check) => check.name === 'source_local_path_resolvable');
    expect(sourcePathCheck?.status).toBe('ok');
    expect(sourcePathCheck?.message).toContain('readable directories');
  });

  test('source path check normalizes an MSYS local_path before filesystem access', async () => {
    const id = `msys-${randomUUID()}`;
    let nativePath: string;
    let storedPath: string;
    if (process.platform === 'win32') {
      nativePath = join(tmpdir(), id);
      const root = parse(nativePath).root;
      const drive = root.slice(0, 1).toLowerCase();
      storedPath = `/${drive}/${nativePath.slice(root.length).replaceAll('\\', '/')}`;
    } else {
      const leaf = `${id}-checkout`;
      nativePath = `C:\\${leaf}`;
      storedPath = `/c/${leaf}`;
    }
    mkdirSync(nativePath, { recursive: true });
    try {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config, archived)
         VALUES ($1, $1, $2, '{}'::jsonb, false)`,
        [id, storedPath],
      );

      const check = await sourceLocalPathCheck(engine, { platform: 'win32' });
      expect(check.status).toBe('ok');
      expect(check.message).toContain('readable directories');
    } finally {
      rmSync(nativePath, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('registered doctor entry fails for an unreadable explicit directory', async () => {
    const unreadable = makeDir();
    chmodSync(unreadable, 0o000);
    try {
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, config, archived)
         VALUES ($1, $1, $2, '{}'::jsonb, false)`,
        ['restricted', unreadable],
      );

      const checks = await buildChecks(engine, ['--only', 'source_local_path_resolvable', '--json']);
      const sourcePathCheck = checks.find((check) => check.name === 'source_local_path_resolvable');
      expect(sourcePathCheck?.status).toBe('fail');
      expect(sourcePathCheck?.message).toContain(`restricted (${unreadable})`);
      expect(sourcePathCheck?.message).toContain('not readable and traversable');
      expect(sourcePathCheck?.message).toContain('gbrain sources set-path restricted <path>');
    } finally {
      chmodSync(unreadable, 0o700);
    }
  });
});
