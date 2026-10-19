/**
 * #5253 + B-NEW-1/2/3: `embedding_disabled` and `schema_pack` report and
 * change the value the runtime uses. Authoring gate: (1) protects the
 * keyless-to-keyed journey through the real CLI (`config unset`, `set
 * true|false`, `init --force --embedding-model`), the effective `schema_pack`
 * in `config get`/`show`, and the one enablement command every keyless hint
 * names; (2) fails when `unset` reports not-found for the init sentinel, when
 * `set false` is shadowed by the file plane, when the enable path leaves a DB
 * row that keeps write-path embedding off, or when `config get schema_pack`
 * reports a value `schema active` does not use; (3) config-get-plane tests
 * use stubs and never cross planes; (4) no production seam (real subprocess,
 * isolated GBRAIN_HOME, no provider keys).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';

const CLI = join(import.meta.dir, '../src/cli.ts');

describe('embedding_disabled and schema_pack config planes', () => {
  let home: string;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-config-planes-'));
    const init = await cli(['init', '--pglite', '--no-embedding']);
    expect(init.code).toBe(0);
  }, 120_000);
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  async function cli(args: string[], extraEnv: Record<string, string | undefined> = {}) {
    const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0',
      GBRAIN_SKIP_UPGRADE_CHECK: '1', GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: undefined, GBRAIN_SCHEMA_PACK: undefined,
      DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined,
      GEMINI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, ...extraEnv };
    const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout: stdout.trim(), stderr, code };
  }
  const fileConfig = () => JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8')) as Record<string, unknown>;

  test('a keyless embed names the one enablement command', async () => {
    const run = await cli(['embed', '--stale']);
    expect(run.stderr).toContain('Turn on semantic search (pages and facts are kept): gbrain init --force --embedding-model');
    expect(run.stderr).not.toContain('set embedding_model via gbrain config');
  }, 60_000);

  test('unset removes the init sentinel', async () => {
    expect(fileConfig().embedding_disabled).toBe(true);
    const run = await cli(['config', 'unset', 'embedding_disabled']);
    expect({ code: run.code, stdout: run.stdout }).toEqual({ code: 0, stdout: 'Unset embedding_disabled (file plane)' });
    expect('embedding_disabled' in fileConfig()).toBe(false);
    expect((await cli(['config', 'get', 'embedding_disabled'])).code).toBe(1);
  }, 60_000);

  test('set true and set false move both planes and get reports the runtime value', async () => {
    expect((await cli(['config', 'set', 'embedding_disabled', 'true'])).code).toBe(0);
    expect(fileConfig().embedding_disabled).toBe(true);
    expect((await cli(['config', 'get', 'embedding_disabled'])).stdout).toBe('true');
    expect((await cli(['config', 'set', 'embedding_disabled', 'false'])).code).toBe(0);
    expect('embedding_disabled' in fileConfig()).toBe(false);
    expect((await cli(['config', 'get', 'embedding_disabled'])).stdout).toBe('false');
    expect((await cli(['config', 'set', 'embedding_disabled', 'maybe'])).code).toBe(1);
  }, 60_000);

  test('refused model write keeps the supported enablement path usable for an empty keyless brain', async () => {
    expect((await cli(['config', 'set', 'embedding_disabled', 'true'])).code).toBe(0);
    expect(fileConfig().embedding_disabled).toBe(true);
    const env = { VOYAGE_API_KEY: 'synthetic-voyage-key' };
    const refused = await cli(['config', 'set', 'embedding_model', 'voyage:voyage-4'], env);
    const dbPath = join(home, '.gbrain', 'brain.pglite');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('This brain has no stored vectors; the supported enablement path keeps the current schema width:');
    expect(refused.stderr).toContain(`gbrain init --force --embedding-model voyage:voyage-4 --embedding-dimensions 1024 --path ${dbPath}`);

    const enabled = await cli(['init', '--force', '--embedding-model', 'voyage:voyage-4', '--embedding-dimensions', '1024', '--path', dbPath], env);
    expect({ code: enabled.code, stderr: enabled.stderr }).toMatchObject({ code: 0 });
    expect(fileConfig()).toMatchObject({ embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024 });
    expect('embedding_disabled' in fileConfig()).toBe(false);
    expect((await cli(['config', 'get', 'embedding_disabled'])).code).toBe(1);
  }, 120_000);

  test('refused width write keeps the enablement recipe at the stored schema width', async () => {
    expect((await cli(['config', 'set', 'embedding_disabled', 'true'])).code).toBe(0);
    const before = await cli(['migrate', 'embeddings', '--status', '--json']);
    expect(before.code).toBe(0);
    expect((JSON.parse(before.stdout) as { column_dims: number }).column_dims).toBe(1024);

    const refused = await cli(['config', 'set', 'embedding_dimensions', '1536'], { VOYAGE_API_KEY: 'synthetic-voyage-key' });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('This brain has no stored vectors; the supported enablement path keeps the current schema width:');
    expect(refused.stderr).toContain(`gbrain init --force --embedding-model voyage:voyage-4 --embedding-dimensions 1024 --path ${join(home, '.gbrain', 'brain.pglite')}`);
    expect(refused.stderr).not.toContain('--embedding-dimensions 1536');

    const after = await cli(['migrate', 'embeddings', '--status', '--json']);
    expect(after.code).toBe(0);
    expect((JSON.parse(after.stdout) as { column_dims: number }).column_dims).toBe(1024);
  }, 120_000);

  test('the enable path clears both planes', async () => {
    expect((await cli(['config', 'set', 'embedding_disabled', 'true'])).code).toBe(0);
    const force = await cli(['init', '--force', '--embedding-model', 'voyage:voyage-4', '--embedding-dimensions', '1024',
      '--path', join(home, '.gbrain', 'brain.pglite')]);
    expect({ code: force.code, stderr: force.stderr }).toMatchObject({ code: 0 });
    expect(fileConfig()).toMatchObject({ embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024 });
    const get = await cli(['config', 'get', 'embedding_disabled']);
    expect({ code: get.code, stdout: get.stdout }).toEqual({ code: 1, stdout: '' });
  }, 120_000);

  test('config get and show report the schema pack the runtime resolves', async () => {
    expect((await cli(['config', 'set', 'schema_pack', 'gbrain-creator'])).code).toBe(0);
    expect(fileConfig().schema_pack).not.toBe('gbrain-creator');
    const active = await cli(['schema', 'active']);
    expect(active.stdout).toContain('Active pack: gbrain-creator');
    const get = await cli(['config', 'get', 'schema_pack']);
    expect(get.stdout).toBe('gbrain-creator');
    expect(get.stderr).toContain('db plane');
    expect((await cli(['config', 'show'])).stdout).toContain('schema_pack: gbrain-creator');
  }, 60_000);

  test('registry-active chunks prevent empty-brain enablement advice', async () => {
    const dbPath = join(home, '.gbrain', 'brain.pglite');
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dbPath, embedding_disabled: true }));
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dbPath });
    try {
      await engine.setConfig('embedding_disabled', 'true');
      await engine.unsetConfig('embedding_model');
      await engine.unsetConfig('embedding_dimensions');
      await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN embedding_review_active vector(1536)');
      await engine.setConfig('embedding_columns', JSON.stringify({
        embedding_review_active: { provider: 'openai:text-embedding-3-large', dimensions: 1536, type: 'vector' },
      }));
      await engine.setConfig('search_embedding_column', 'embedding_review_active');
      await withManagedFixtureWrite(engine, ['default'], async tx => {
        await tx.putPage('notes/registry-active', { type: 'note', title: 'Registry active fixture', compiled_truth: 'Synthetic retained vector.' });
        await tx.executeRaw(
          `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, embedding_review_active)
           SELECT id, 0, 'Synthetic retained vector.', 'compiled_truth', 'openai:text-embedding-3-large',
                  array_fill(0.1::real, ARRAY[1536])::vector
             FROM pages WHERE slug = 'notes/registry-active' AND source_id = 'default'`,
        );
      });
      expect(await engine.executeRaw<{ legacy_empty: boolean; active_present: boolean }>(
        `SELECT embedding IS NULL AS legacy_empty, embedding_review_active IS NOT NULL AS active_present
           FROM content_chunks WHERE page_id = (SELECT id FROM pages WHERE slug = 'notes/registry-active' AND source_id = 'default')`,
      )).toEqual([{ legacy_empty: true, active_present: true }]);
    } finally {
      await engine.disconnect();
    }

    const refused = await cli(['config', 'set', 'embedding_model', 'openai:text-embedding-3-large']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('Embeddings are disabled by choice');
    expect(refused.stderr).toContain('Read-only next step: gbrain migrate embeddings --status --json');
    expect(refused.stderr).not.toContain('This brain has no stored vectors');
    expect(refused.stderr).not.toContain('gbrain init --force');

    const verify = new PGLiteEngine();
    await verify.connect({ database_path: dbPath });
    try {
      expect(await verify.getConfig('embedding_disabled')).toBe('true');
      expect(await verify.getConfig('embedding_model')).toBeNull();
      expect(await verify.executeRaw<{ active_present: boolean }>(
        `SELECT embedding_review_active IS NOT NULL AS active_present FROM content_chunks
          WHERE page_id = (SELECT id FROM pages WHERE slug = 'notes/registry-active' AND source_id = 'default')`,
      )).toEqual([{ active_present: true }]);
    } finally {
      await verify.disconnect();
    }
  }, 120_000);
});
