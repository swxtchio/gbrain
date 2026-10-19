import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { addSource } from '../../src/core/sources-ops.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { buildGatewayConfig } from '../../src/core/ai/build-gateway-config.ts';
import { readContentChunksEmbeddingDim } from '../../src/core/embedding-dim-check.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';

const REPO = join(import.meta.dir, '../..');
const DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';
const SIGNATURE = `${MODEL}:${DIMS}`;
const SOURCE = 'fixture-source';
const FIXTURE_KEY = 'fixture-openai-key';

let home: string | undefined;
let database: Awaited<ReturnType<typeof isolatedPersistencePostgres>> | undefined;
let preloadPath: string | undefined;
let repoPath: string | undefined;
let configPath: string | undefined;
let capturePath: string | undefined;

function markdown(title: string, body: string): string {
  return `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;
}

function runGit(args: string[]): void {
  const result = spawnSync('git', ['-C', repoPath!, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GBRAIN_HOME: home,
    TMPDIR: process.env.TMPDIR,
    GBRAIN_NO_AUTO_SYNC: '1',
    GBRAIN_MODEL_DISCOVERY: 'off',
    OPENAI_API_KEY: FIXTURE_KEY,
    GBRAIN_TEST_EMBEDDING_IDENTITY_CAPTURE: capturePath,
    ...extra,
  };
}

function runGbrain(args: string[]) {
  return spawnSync(process.execPath, ['--preload', preloadPath!, join(REPO, 'src/cli.ts'), ...args], {
    cwd: home,
    env: childEnv(),
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function capturedEmbeds(): Array<{ provider: string; modelId: string }> {
  const contents = readFileSync(capturePath!, 'utf8').trim();
  return contents ? contents.split('\n').map((line) => JSON.parse(line)) : [];
}

function addCommittedNote(slug: string): void {
  writeFileSync(join(repoPath!, `${slug}.md`), markdown(`${slug} fixture`, `Synthetic page ${slug}.`));
  runGit(['add', '--', `${slug}.md`]);
  runGit(['commit', '-q', '-m', `add ${slug} fixture`]);
}

describe.skipIf(!process.env.DATABASE_URL)('Postgres DB-only embedding identity recovery', () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-12-pg-'));
    const configDir = join(home, '.gbrain');
    const baseDatabaseUrl = process.env.DATABASE_URL!;
    repoPath = join(home, 'fixture-repo');
    configPath = join(configDir, 'config.json');
    capturePath = join(home, 'embed-calls.ndjson');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, 'existing.md'), markdown('Existing fixture page', 'Existing Postgres vector provenance must survive recovery.'));
    runGit(['init', '-q']);
    runGit(['config', 'user.name', 'GBrain Fixture']);
    runGit(['config', 'user.email', 'fixture@example.test']);
    runGit(['add', '--', 'existing.md']);
    runGit(['commit', '-q', '-m', 'seed synthetic page']);

    database = await isolatedPersistencePostgres(baseDatabaseUrl);
    const fileConfig = {
      engine: 'postgres',
      database_url: database.databaseUrl,
      embedding_model: MODEL,
      embedding_dimensions: DIMS,
    } as const;
    writeFileSync(configPath, JSON.stringify(fileConfig));
    const gatewayPath = join(REPO, 'src/core/ai/gateway.ts');
    preloadPath = join(home, 'embedding-transport.ts');
    writeFileSync(preloadPath, `
import { appendFileSync } from 'node:fs';
import { __setEmbedTransportForTests } from ${JSON.stringify(gatewayPath)};

__setEmbedTransportForTests(async ({ model, values }) => {
  const provider = model as { provider?: string; modelId?: string };
  appendFileSync(process.env.GBRAIN_TEST_EMBEDDING_IDENTITY_CAPTURE!, JSON.stringify({
    provider: provider.provider,
    modelId: provider.modelId,
  }) + '\\n');
  return { embeddings: values.map(() => new Array(${DIMS}).fill(0.25)), usage: { tokens: values.length } } as never;
});
`);

    const engine = database.engine as PostgresEngine;
    await withEnv({
      GBRAIN_HOME: home,
      GBRAIN_PGLITE_SNAPSHOT: undefined,
      DATABASE_URL: undefined,
      GBRAIN_DATABASE_URL: undefined,
      GBRAIN_EMBEDDING_MODEL: undefined,
      GBRAIN_EMBEDDING_DIMENSIONS: undefined,
      OPENAI_API_KEY: FIXTURE_KEY,
      GBRAIN_MODEL_DISCOVERY: 'off',
    }, async () => {
      configureGateway(buildGatewayConfig(fileConfig));
      await engine.setConfig('embedding_model', MODEL);
      await engine.setConfig('embedding_dimensions', String(DIMS));
      await addSource(engine, { id: SOURCE, localPath: repoPath! });
    });
    await engine.disconnect();

    const seed = runGbrain(['sync', '--source', SOURCE, '--no-pull', '--no-extract', '--json']);
    expect(seed.error).toBeUndefined();
    expect(seed.status, `${seed.stderr}\n${seed.stdout}`).toBe(0);
    expect(capturedEmbeds()).toContainEqual({ provider: 'openai.embedding', modelId: 'text-embedding-3-large' });
    await engine.connect({ database_url: database.databaseUrl });
    expect(await engine.executeRaw<{ embedding_signature: string | null }>(
      `SELECT embedding_signature FROM pages WHERE slug = 'existing' AND source_id = $1`, [SOURCE],
    )).toEqual([{ embedding_signature: SIGNATURE }]);
    await engine.setConfig('embedding_model', MODEL);
    await engine.setConfig('embedding_dimensions', String(DIMS));
    await engine.disconnect();
    writeFileSync(configPath, JSON.stringify({ engine: 'postgres', database_url: database.databaseUrl }));
    writeFileSync(capturePath, '');
  }, 180_000);

  afterAll(async () => {
    resetGateway();
    await database?.close();
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
    database = undefined;
  });

  test.each([
    ['issue spelling', 'text-embedding-3-large', 'postgres-new-legacy'],
    ['provider-qualified spelling', MODEL, 'postgres-new-qualified'],
  ])('ordinary sync recovers the %s DB model and preserves the Postgres vector identity', async (_label, dbModel, slug) => {
    const engine = database!.engine as PostgresEngine;
    await engine.connect({ database_url: database!.databaseUrl });
    await engine.setConfig('embedding_model', dbModel);
    await engine.setConfig('embedding_dimensions', String(DIMS));
    const before = await engine.executeRaw<{ model: string; embedding: string }>(
      `SELECT cc.model, cc.embedding::text AS embedding
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = 'existing' AND cc.embedding IS NOT NULL ORDER BY cc.chunk_index`,
    );
    const beforeSignature = await engine.executeRaw<{ embedding_signature: string | null }>(
      `SELECT embedding_signature FROM pages WHERE slug = 'existing' AND source_id = $1`, [SOURCE],
    );
    await engine.disconnect();
    writeFileSync(capturePath!, '');
    addCommittedNote(slug);

    const synced = runGbrain(['sync', '--source', SOURCE, '--no-pull', '--no-extract', '--json']);
    expect(synced.error).toBeUndefined();
    expect(synced.status, `${synced.stderr}\n${synced.stdout}`).toBe(0);
    expect(capturedEmbeds()).toContainEqual({ provider: 'openai.embedding', modelId: 'text-embedding-3-large' });

    await engine.connect({ database_url: database!.databaseUrl });
    const created = await engine.executeRaw<{ model: string; dimensions: number; signature: string | null }>(
      `SELECT cc.model, vector_dims(cc.embedding)::int AS dimensions, p.embedding_signature AS signature
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = $1 AND cc.embedding IS NOT NULL ORDER BY cc.chunk_index`, [slug],
    );
    expect(created.length).toBeGreaterThan(0);
    expect(created.every((row) => row.model === MODEL && row.dimensions === DIMS && row.signature === SIGNATURE)).toBe(true);
    expect(await readContentChunksEmbeddingDim(engine)).toMatchObject({ exists: true, dims: DIMS });
    expect(await engine.executeRaw<{ model: string; embedding: string }>(
      `SELECT cc.model, cc.embedding::text AS embedding
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = 'existing' AND cc.embedding IS NOT NULL ORDER BY cc.chunk_index`,
    )).toEqual(before);
    expect(await engine.executeRaw<{ embedding_signature: string | null }>(
      `SELECT embedding_signature FROM pages WHERE slug = 'existing' AND source_id = $1`, [SOURCE],
    )).toEqual(beforeSignature);
    expect(await engine.getConfig('embedding_model')).toBe(dbModel);
    expect(await engine.getConfig('embedding_dimensions')).toBe(String(DIMS));
    await engine.disconnect();
  }, 120_000);
});
