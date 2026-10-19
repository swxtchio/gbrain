import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { addSource } from '../src/core/sources-ops.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { buildGatewayConfig } from '../src/core/ai/build-gateway-config.ts';
import { withEnv } from './helpers/with-env.ts';

const REPO = join(import.meta.dir, '..');
const DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';
const SIGNATURE = `${MODEL}:${DIMS}`;
const FIXTURE_KEY = 'fixture-openai-key';
const SOURCE = 'fixture-source';

interface Fixture {
  home: string;
  databasePath: string;
  repoPath: string;
  configPath: string;
  capturePath: string;
  preloadPath: string;
}

let fixture: Fixture | undefined;

function markdown(title: string, body: string): string {
  return `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;
}

function runGit(repoPath: string, args: string[]): void {
  const result = spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function childEnv(homePath: string, capturePath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: homePath,
    GBRAIN_HOME: homePath,
    TMPDIR: process.env.TMPDIR,
    GBRAIN_NO_AUTO_SYNC: '1',
    GBRAIN_MODEL_DISCOVERY: 'off',
    OPENAI_API_KEY: FIXTURE_KEY,
    GBRAIN_TEST_EMBEDDING_IDENTITY_CAPTURE: capturePath,
    ...extra,
  };
}

function makePreload(homePath: string): string {
  const path = join(homePath, 'embedding-transport.ts');
  const gateway = join(REPO, 'src/core/ai/gateway.ts');
  const pglite = join(REPO, 'src/core/pglite-engine.ts');
  writeFileSync(path, `
import { appendFileSync } from 'node:fs';
import { __setEmbedTransportForTests } from ${JSON.stringify(gateway)};
import { PGLiteEngine } from ${JSON.stringify(pglite)};

if (process.env.GBRAIN_TEST_FAIL_SIGNATURE_READ === '1') {
  const executeRaw = PGLiteEngine.prototype.executeRaw;
  PGLiteEngine.prototype.executeRaw = function (sql, params, opts) {
    if (sql.includes('p.embedding_signature AS signature')) throw new Error('synthetic signature read failure');
    return executeRaw.call(this, sql, params, opts);
  };
}

__setEmbedTransportForTests(async ({ model, values, providerOptions }) => {
  const provider = model as { provider?: string; modelId?: string };
  appendFileSync(process.env.GBRAIN_TEST_EMBEDDING_IDENTITY_CAPTURE!, JSON.stringify({
    provider: provider.provider,
    modelId: provider.modelId,
    dimensions: providerOptions?.openai?.dimensions ?? null,
  }) + '\\n');
  return { embeddings: values.map(() => new Array(${DIMS}).fill(0.125)), usage: { tokens: values.length } } as never;
});
`);
  return path;
}

function runGbrain(args: string[], extraEnv: Record<string, string> = {}) {
  if (!fixture) throw new Error('Synthetic fixture is not ready.');
  return spawnSync(process.execPath, ['--preload', fixture.preloadPath, join(REPO, 'src/cli.ts'), ...args], {
    cwd: fixture.home,
    env: childEnv(fixture.home, fixture.capturePath, extraEnv),
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function capturedEmbeds(): Array<{ provider: string; modelId: string; dimensions: number | null }> {
  if (!fixture || !existsSync(fixture.capturePath)) return [];
  const contents = readFileSync(fixture.capturePath, 'utf8').trim();
  return contents ? contents.split('\n').map((line) => JSON.parse(line)) : [];
}

async function withFixtureEngine<T>(fn: (engine: PGLiteEngine) => Promise<T>): Promise<T> {
  if (!fixture) throw new Error('Synthetic fixture is not ready.');
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: fixture.databasePath });
  try {
    return await fn(engine);
  } finally {
    await engine.disconnect();
  }
}

function addCommittedNote(slug: string): void {
  if (!fixture) throw new Error('Synthetic fixture is not ready.');
  writeFileSync(join(fixture.repoPath, `${slug}.md`), markdown(`${slug} fixture`, `Synthetic page ${slug}.`));
  runGit(fixture.repoPath, ['add', '--', `${slug}.md`]);
  runGit(fixture.repoPath, ['commit', '-q', '-m', `add ${slug} fixture`]);
}

async function existingVectorSnapshot(): Promise<Array<{ model: string; embedding: string }>> {
  return withFixtureEngine((engine) => engine.executeRaw<{ model: string; embedding: string }>(
    `SELECT cc.model, cc.embedding::text AS embedding
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = 'existing' AND cc.embedding IS NOT NULL ORDER BY cc.chunk_index`,
  ));
}

async function setDbIdentity(model: string): Promise<void> {
  await withFixtureEngine(async (engine) => {
    await engine.setConfig('embedding_model', model);
    await engine.setConfig('embedding_dimensions', String(DIMS));
  });
}

async function setVectorPageSignature(signature: string): Promise<void> {
  await withFixtureEngine((engine) => engine.executeRaw(
    `UPDATE pages SET embedding_signature = $1
      WHERE source_id = $2 AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = pages.id AND cc.embedding IS NOT NULL)`,
    [signature, SOURCE],
  ));
}

async function setVectorChunkModels(model: string): Promise<void> {
  await withFixtureEngine((engine) => engine.executeRaw(
    `UPDATE content_chunks cc SET model = $1
      WHERE cc.embedding IS NOT NULL
        AND EXISTS (SELECT 1 FROM pages p WHERE p.id = cc.page_id AND p.source_id = $2)`,
    [model, SOURCE],
  ));
}

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-12-'));
  const configDir = join(home, '.gbrain');
  const databasePath = join(home, 'brain');
  const repoPath = join(home, 'fixture-repo');
  const configPath = join(configDir, 'config.json');
  const capturePath = join(home, 'embed-calls.ndjson');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(repoPath, 'existing.md'), markdown('Existing fixture page', 'Existing vector provenance must survive startup recovery.'));
  runGit(repoPath, ['init', '-q']);
  runGit(repoPath, ['config', 'user.name', 'GBrain Fixture']);
  runGit(repoPath, ['config', 'user.email', 'fixture@example.test']);
  runGit(repoPath, ['add', '--', 'existing.md']);
  runGit(repoPath, ['commit', '-q', '-m', 'seed synthetic page']);

  fixture = { home, databasePath, repoPath, configPath, capturePath, preloadPath: makePreload(home) };
  const fileConfig = {
    engine: 'pglite',
    database_path: databasePath,
    embedding_model: MODEL,
    embedding_dimensions: DIMS,
  } as const;
  writeFileSync(configPath, JSON.stringify(fileConfig));
  const engine = new PGLiteEngine();
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
    await engine.connect({ database_path: databasePath });
    await engine.initSchema();
    await addSource(engine, { id: SOURCE, localPath: repoPath });
  });
  await engine.disconnect();

  const seedSync = runGbrain(['sync', '--source', SOURCE, '--no-pull', '--no-extract', '--json']);
  expect(seedSync.error).toBeUndefined();
  expect(seedSync.status, `${seedSync.stderr}\n${seedSync.stdout}`).toBe(0);
  expect(capturedEmbeds()).toContainEqual({
    provider: 'openai.embedding', modelId: 'text-embedding-3-large', dimensions: DIMS,
  });
  const seededVectors = await existingVectorSnapshot();
  expect(seededVectors.length).toBeGreaterThan(0);
  expect(seededVectors.every(row => row.model === MODEL)).toBe(true);
  await withFixtureEngine(async (connected) => {
    expect(await connected.executeRaw<{ embedding_signature: string | null }>(
      `SELECT embedding_signature FROM pages WHERE slug = 'existing' AND source_id = $1`, [SOURCE],
    )).toEqual([{ embedding_signature: SIGNATURE }]);
  });
  writeFileSync(configPath, JSON.stringify({ engine: 'pglite', database_path: databasePath }));
  await setDbIdentity(MODEL);
}, 180_000);

beforeEach(async () => {
  if (!fixture) throw new Error('Synthetic fixture is not ready.');
  writeFileSync(fixture.configPath, JSON.stringify({ engine: 'pglite', database_path: fixture.databasePath }));
  writeFileSync(fixture.capturePath, '');
  await withFixtureEngine(async (engine) => {
    await engine.setConfig('embedding_model', MODEL);
    await engine.setConfig('embedding_dimensions', String(DIMS));
    await engine.unsetConfig('embedding_disabled');
    await engine.unsetConfig('openai_api_key');
    await engine.executeRaw(
      `UPDATE content_chunks cc SET model = $1
        WHERE cc.embedding IS NOT NULL
          AND EXISTS (SELECT 1 FROM pages p WHERE p.id = cc.page_id AND p.source_id = $2)`,
      [MODEL, SOURCE],
    );
    await engine.executeRaw(
      `UPDATE pages SET embedding_signature = $1
        WHERE source_id = $2 AND deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = pages.id AND cc.embedding IS NOT NULL)`,
      [SIGNATURE, SOURCE],
    );
  });
});

afterAll(() => {
  resetGateway();
  if (fixture) rmSync(fixture.home, { recursive: true, force: true });
  fixture = undefined;
});

describe('DB-only embedding identity recovery through ordinary sync startup', () => {
  test.each([
    ['issue spelling', 'text-embedding-3-large', 'new-legacy'],
    ['provider-qualified spelling', MODEL, 'new-qualified'],
  ])('%s routes sync through the stored identity and preserves existing vectors', async (_label, dbModel, slug) => {
    await setDbIdentity(dbModel);
    const priorVectors = await existingVectorSnapshot();
    addCommittedNote(slug);

    const synced = runGbrain(['sync', '--source', SOURCE, '--no-pull', '--no-extract', '--json']);
    expect(synced.error).toBeUndefined();
    expect(synced.status, `${synced.stderr}\n${synced.stdout}`).toBe(0);
    expect(capturedEmbeds()).toContainEqual({
      provider: 'openai.embedding', modelId: 'text-embedding-3-large', dimensions: DIMS,
    });

    await withFixtureEngine(async (engine) => {
      const newVectors = await engine.executeRaw<{ model: string; dimensions: number; signature: string | null }>(
        `SELECT cc.model, vector_dims(cc.embedding)::int AS dimensions, p.embedding_signature AS signature
           FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
          WHERE p.slug = $1 AND cc.embedding IS NOT NULL ORDER BY cc.chunk_index`, [slug],
      );
      expect(newVectors.length).toBeGreaterThan(0);
      expect(newVectors.every((row) => row.model === MODEL && row.dimensions === DIMS && row.signature === SIGNATURE)).toBe(true);
      const { readContentChunksEmbeddingDim } = await import('../src/core/embedding-dim-check.ts');
      expect(await readContentChunksEmbeddingDim(engine)).toMatchObject({ exists: true, dims: DIMS });
      expect(await engine.getConfig('embedding_model')).toBe(dbModel);
      expect(await engine.getConfig('embedding_dimensions')).toBe(String(DIMS));
    });
    expect(await existingVectorSnapshot()).toEqual(priorVectors);
  }, 120_000);

  test('a page signature corroborates legacy bare content_chunks model values', async () => {
    await setDbIdentity('text-embedding-3-large');
    await setVectorChunkModels('text-embedding-3-large');
    const priorVectors = await existingVectorSnapshot();
    expect(priorVectors.every(row => row.model === 'text-embedding-3-large')).toBe(true);
    addCommittedNote('legacy-chunk-model');

    const sync = runGbrain(['sync', '--source', SOURCE, '--no-pull', '--no-extract', '--json']);
    expect(sync.error).toBeUndefined();
    expect(sync.status, `${sync.stderr}\n${sync.stdout}`).toBe(0);
    expect(capturedEmbeds()).toContainEqual({
      provider: 'openai.embedding', modelId: 'text-embedding-3-large', dimensions: DIMS,
    });
    const created = await withFixtureEngine((engine) => engine.executeRaw<{ model: string; signature: string | null }>(
      `SELECT cc.model, p.embedding_signature AS signature
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = 'legacy-chunk-model' AND cc.embedding IS NOT NULL`,
    ));
    expect(created.length).toBeGreaterThan(0);
    expect(created.every(row => row.model === MODEL && row.signature === SIGNATURE)).toBe(true);
    expect(await existingVectorSnapshot()).toEqual(priorVectors);
  }, 120_000);

  test('doctor reports the recovered identity without recommending the refused write', async () => {
    await setDbIdentity('text-embedding-3-large');
    const doctor = runGbrain(['doctor', '--only', 'embedding_provider', '--json']);
    expect(doctor.error).toBeUndefined();
    expect(doctor.status, `${doctor.stderr}\n${doctor.stdout}`).toBe(0);
    const report = JSON.parse(doctor.stdout) as { checks: Array<{ name: string; message: string; details?: Record<string, unknown> }> };
    const check = report.checks.find((item) => item.name === 'embedding_provider');
    expect(check).toBeDefined();
    expect(check!.message).toContain(MODEL);
    expect(check!.details).toMatchObject({ model: MODEL, dimensions: DIMS });
    expect(check!.message).not.toContain('config set embedding_model');
    expect(`${doctor.stdout}\n${doctor.stderr}`).not.toContain('zeroentropyai:zembed-1');
  }, 120_000);

  test('doctor keeps DB-merged provider credentials when configuring the recovered identity', async () => {
    await setDbIdentity('text-embedding-3-large');
    await withFixtureEngine((engine) => engine.setConfig('openai_api_key', FIXTURE_KEY));

    const doctor = runGbrain(['doctor', '--only', 'embedding_provider', '--probe', '--yes', '--json'], {
      OPENAI_API_KEY: '',
    });
    expect(doctor.error).toBeUndefined();
    expect(doctor.status, `${doctor.stderr}\n${doctor.stdout}`).toBe(0);
    const report = JSON.parse(doctor.stdout) as { checks: Array<{ name: string; status: string; message: string; details?: Record<string, unknown> }> };
    const check = report.checks.find((item) => item.name === 'embedding_provider');
    expect(check).toMatchObject({ status: 'ok' });
    expect(check?.message).toContain(MODEL);
    expect(check?.message).toContain('DB aligned');
    expect(capturedEmbeds()).toContainEqual({
      provider: 'openai.embedding', modelId: 'text-embedding-3-large', dimensions: DIMS,
    });
  }, 120_000);

  test('doctor reports conflicting vector identity as unverified with read-only status', async () => {
    await setDbIdentity('text-embedding-3-large');
    const conflictSignature = `openai:text-embedding-3-small:${DIMS}`;
    await setVectorPageSignature(conflictSignature);

    const doctor = runGbrain(['doctor', '--only', 'embedding_provider', '--json']);
    expect(doctor.error).toBeUndefined();
    expect(doctor.status, `${doctor.stderr}\n${doctor.stdout}`).toBe(0);
    const report = JSON.parse(doctor.stdout) as { checks: Array<{ name: string; status: string; message: string; fix?: { argv?: string[] } }> };
    const check = report.checks.find((item) => item.name === 'embedding_provider');
    expect(check).toMatchObject({ status: 'warn' });
    expect(check?.message).toContain('conflicts with stored page embedding_signature');
    expect(check?.message).not.toContain('config set embedding_model');
    expect(check?.fix?.argv).toContain('migrate');
    expect(check?.fix?.argv).toContain('--status');
    expect(`${doctor.stdout}\n${doctor.stderr}`).not.toContain('zeroentropyai:zembed-1');
  }, 120_000);

  test('config get reports the recovered identity and width used by sync', async () => {
    await setDbIdentity('text-embedding-3-large');
    const getModel = runGbrain(['config', 'get', 'embedding_model']);
    expect(getModel.error).toBeUndefined();
    expect(getModel.status, getModel.stderr).toBe(0);
    expect(getModel.stdout.trim()).toBe(MODEL);
    const getDimensions = runGbrain(['config', 'get', 'embedding_dimensions']);
    expect(getDimensions.error).toBeUndefined();
    expect(getDimensions.status, getDimensions.stderr).toBe(0);
    expect(getDimensions.stdout.trim()).toBe(String(DIMS));
  }, 120_000);

  test('config show reports the recovered identity and width used by sync', async () => {
    await setDbIdentity('text-embedding-3-large');
    const show = runGbrain(['config', 'show']);
    expect(show.error).toBeUndefined();
    expect(show.status, show.stderr).toBe(0);
    expect(show.stdout).toContain(`embedding_model: ${MODEL}`);
    expect(show.stdout).toContain(`embedding_dimensions: ${DIMS}`);
  }, 120_000);

  test('config get labels an unverified DB value and points to read-only status', async () => {
    await setDbIdentity('text-embedding-3-large');
    await withFixtureEngine((engine) => engine.setPageEmbeddingSignature('existing', {
      sourceId: SOURCE,
      signature: `openai:text-embedding-3-small:${DIMS}`,
    }));

    const getModel = runGbrain(['config', 'get', 'embedding_model']);
    expect(getModel.error).toBeUndefined();
    expect(getModel.status, getModel.stderr).toBe(0);
    expect(getModel.stdout.trim()).toBe('text-embedding-3-large');
    expect(getModel.stderr).toContain('stored value is not a verified runtime identity');
    expect(getModel.stderr).toContain('Read-only check: gbrain migrate embeddings --status --json');
  }, 120_000);

  test('config show reports an unverified identity and points to read-only status', async () => {
    await setDbIdentity('text-embedding-3-large');
    const conflictSignature = `openai:text-embedding-3-small:${DIMS}`;
    await setVectorPageSignature(conflictSignature);
    const show = runGbrain(['config', 'show']);
    expect(show.error).toBeUndefined();
    expect(show.status, show.stderr).toBe(0);
    expect(show.stderr).toContain('Effective embedding identity is unverified');
    expect(show.stderr).toContain('conflicts with stored page embedding_signature');
    expect(show.stderr).toContain('Read-only check: gbrain migrate embeddings --status --json');
    expect(`${show.stdout}\n${show.stderr}`).not.toContain('zeroentropyai:zembed-1');
  }, 120_000);

  test('config refusal names the recovered identity, file surface, and usable verification', async () => {
    await setDbIdentity('text-embedding-3-large');
    const priorVectors = await existingVectorSnapshot();
    const refused = runGbrain(['config', 'set', 'embedding_model', 'text-embedding-3-large']);
    expect(refused.error).toBeUndefined();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`Effective identity: ${MODEL} (${DIMS} dims), recovered from the DB plane and verified by ${SIGNATURE}`);
    expect(refused.stderr).toContain(`{"embedding_model":"${MODEL}","embedding_dimensions":${DIMS}}`);
    expect(refused.stderr).toContain(fixture!.configPath);
    expect(refused.stderr).not.toContain('config set embedding_model');
    expect(refused.stderr).not.toContain('zeroentropyai:zembed-1');

    const getModel = runGbrain(['config', 'get', 'embedding_model']);
    expect(getModel.error).toBeUndefined();
    expect(getModel.status, getModel.stderr).toBe(0);
    expect(getModel.stdout.trim()).toBe(MODEL);
    const getDimensions = runGbrain(['config', 'get', 'embedding_dimensions']);
    expect(getDimensions.error).toBeUndefined();
    expect(getDimensions.status, getDimensions.stderr).toBe(0);
    expect(getDimensions.stdout.trim()).toBe(String(DIMS));

    const status = runGbrain(['migrate', 'embeddings', '--status', '--json', '--brain', 'host']);
    expect(status.error).toBeUndefined();
    expect(status.status, `${status.stderr}\n${status.stdout}`).toBe(0);
    expect(status.stdout).toContain(SIGNATURE);
    expect(status.stdout).toContain('column_dims');
    await withFixtureEngine(async (engine) => {
      expect(await engine.getConfig('embedding_model')).toBe('text-embedding-3-large');
      expect(await engine.getConfig('embedding_dimensions')).toBe(String(DIMS));
    });
    expect(await existingVectorSnapshot()).toEqual(priorVectors);
  }, 120_000);

  test('config set refuses an unverified identity and verifies status without mutating vectors', async () => {
    await setDbIdentity('text-embedding-3-large');
    const conflictSignature = `openai:text-embedding-3-small:${DIMS}`;
    await setVectorPageSignature(conflictSignature);
    const priorVectors = await existingVectorSnapshot();

    const refused = runGbrain(['config', 'set', 'embedding_model', MODEL]);
    expect(refused.error).toBeUndefined();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('Effective identity is unverified');
    expect(refused.stderr).toContain('conflicts with stored page embedding_signature');
    expect(refused.stderr).toContain('Read-only next step: gbrain migrate embeddings --status --json');
    expect(refused.stderr).not.toContain('gbrain init --force');
    expect(refused.stderr).not.toContain('zeroentropyai:zembed-1');

    const status = runGbrain(['migrate', 'embeddings', '--status', '--json', '--brain', 'host']);
    expect(status.error).toBeUndefined();
    expect(status.status, `${status.stderr}\n${status.stdout}`).toBe(0);
    expect(status.stdout).toContain(conflictSignature);
    await withFixtureEngine(async (engine) => {
      expect(await engine.getConfig('embedding_model')).toBe('text-embedding-3-large');
      expect(await engine.getConfig('embedding_dimensions')).toBe(String(DIMS));
    });
    expect(await existingVectorSnapshot()).toEqual(priorVectors);
  }, 120_000);

  test('config set does not offer empty-brain enablement when existing vectors lack an identity', async () => {
    await withFixtureEngine((engine) => engine.unsetConfig('embedding_model'));
    const priorVectors = await existingVectorSnapshot();
    const refused = runGbrain(['config', 'set', 'embedding_model', MODEL]);

    expect(refused.error).toBeUndefined();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('Effective identity is unverified');
    expect(refused.stderr).toContain('No embedding_model is configured in the file/environment or DB plane');
    expect(refused.stderr).toContain('Read-only next step: gbrain migrate embeddings --status --json');
    expect(refused.stderr).not.toContain('gbrain init --force');
    expect(refused.stderr).not.toContain('zeroentropyai:zembed-1');
    expect(await withFixtureEngine(engine => engine.getConfig('embedding_model'))).toBeNull();
    expect(await existingVectorSnapshot()).toEqual(priorVectors);
  }, 120_000);

  test('conflicting signatures refuse sync and preserve vectors with an actionable diagnosis', async () => {
    writeFileSync(fixture!.configPath, JSON.stringify({
      engine: 'pglite', database_path: fixture!.databasePath,
      embedding_model: MODEL, embedding_dimensions: DIMS,
    }));
    addCommittedNote('ambiguous-base');
    const seed = runGbrain(['sync', '--source', SOURCE, '--no-pull', '--no-extract', '--json']);
    expect(seed.error).toBeUndefined();
    expect(seed.status, `${seed.stderr}\n${seed.stdout}`).toBe(0);
    writeFileSync(fixture!.configPath, JSON.stringify({ engine: 'pglite', database_path: fixture!.databasePath }));
    writeFileSync(fixture!.capturePath, '');
    await setDbIdentity('text-embedding-3-large');
    const conflictSignature = `openai:text-embedding-3-small:${DIMS}`;
    const priorVectors = await existingVectorSnapshot();
    await withFixtureEngine((engine) => engine.setPageEmbeddingSignature('existing', {
      sourceId: SOURCE,
      signature: conflictSignature,
    }));
    addCommittedNote('ambiguous-check');

    const ambiguousSync = runGbrain(['sync', '--source', SOURCE, '--no-pull', '--no-extract', '--json']);
    expect(ambiguousSync.error).toBeUndefined();
    expect(ambiguousSync.status).not.toBe(0);
    expect(`${ambiguousSync.stdout}\n${ambiguousSync.stderr}`).toContain('more than one page embedding_signature');
    expect(`${ambiguousSync.stdout}\n${ambiguousSync.stderr}`).toContain('gbrain migrate embeddings --status --json');
    expect(`${ambiguousSync.stdout}\n${ambiguousSync.stderr}`).not.toContain('zeroentropyai:zembed-1');
    expect(capturedEmbeds()).toEqual([]);
    expect(await existingVectorSnapshot()).toEqual(priorVectors);

    await setVectorPageSignature(conflictSignature);
    addCommittedNote('conflict-check');
    const conflictSync = runGbrain(['sync', '--source', SOURCE, '--no-pull', '--no-extract', '--json']);
    expect(conflictSync.error).toBeUndefined();
    expect(conflictSync.status).not.toBe(0);
    expect(`${conflictSync.stdout}\n${conflictSync.stderr}`).toContain('conflicts with stored page embedding_signature');
    expect(`${conflictSync.stdout}\n${conflictSync.stderr}`).toContain('gbrain migrate embeddings --status --json');
    expect(`${conflictSync.stdout}\n${conflictSync.stderr}`).not.toContain('zeroentropyai:zembed-1');
    expect(capturedEmbeds()).toEqual([]);
    expect(await existingVectorSnapshot()).toEqual(priorVectors);
  }, 120_000);

  test('a page signature cannot establish identity when its vector models disagree', async () => {
    await setDbIdentity('text-embedding-3-large');
    await setVectorChunkModels('openai:text-embedding-3-small');
    const priorVectors = await existingVectorSnapshot();
    addCommittedNote('false-stamped-vector-model');

    const sync = runGbrain(['sync', '--source', SOURCE, '--no-pull', '--no-extract', '--json']);
    expect(sync.error).toBeUndefined();
    expect(sync.status).not.toBe(0);
    expect(`${sync.stdout}\n${sync.stderr}`).toContain('content_chunks.model');
    expect(`${sync.stdout}\n${sync.stderr}`).toContain('conflicts with stored page embedding_signature');
    expect(`${sync.stdout}\n${sync.stderr}`).toContain('gbrain migrate embeddings --status --json');
    expect(`${sync.stdout}\n${sync.stderr}`).not.toContain('zeroentropyai:zembed-1');
    expect(capturedEmbeds()).toEqual([]);
    expect(await existingVectorSnapshot()).toEqual(priorVectors);
  }, 120_000);

  test('soft-deleted vector models remain part of identity corroboration', async () => {
    await setDbIdentity('text-embedding-3-large');
    await withFixtureEngine(async (engine) => {
      await engine.executeRaw(
        `UPDATE content_chunks cc SET model = $1
          WHERE cc.embedding IS NOT NULL
            AND cc.page_id = (SELECT id FROM pages WHERE slug = 'existing' AND source_id = $2)`,
        ['openai:text-embedding-3-small', SOURCE],
      );
      await engine.executeRaw(
        `UPDATE pages SET deleted_at = now() WHERE slug = 'existing' AND source_id = $1`, [SOURCE],
      );
    });
    const priorVectors = await existingVectorSnapshot();
    addCommittedNote('soft-deleted-vector-model');

    const sync = runGbrain(['sync', '--source', SOURCE, '--no-pull', '--no-extract', '--json']);
    expect(sync.error).toBeUndefined();
    expect(sync.status).not.toBe(0);
    expect(`${sync.stdout}\n${sync.stderr}`).toContain('content_chunks.model');
    expect(`${sync.stdout}\n${sync.stderr}`).toContain('conflicts with stored page embedding_signature');
    expect(`${sync.stdout}\n${sync.stderr}`).toContain('gbrain migrate embeddings --status --json');
    expect(capturedEmbeds()).toEqual([]);
    expect(await existingVectorSnapshot()).toEqual(priorVectors);
  }, 120_000);

  test('missing DB model does not infer a provider from vector width or signatures', async () => {
    const priorVectors = await existingVectorSnapshot();
    const priorSignature = await withFixtureEngine((engine) => engine.executeRaw<{ embedding_signature: string | null }>(
      `SELECT embedding_signature FROM pages WHERE slug = 'existing' AND source_id = $1`, [SOURCE],
    ));
    await withFixtureEngine((engine) => engine.unsetConfig('embedding_model'));
    addCommittedNote('missing-identity');

    const sync = runGbrain(['sync', '--source', SOURCE, '--no-pull', '--no-extract', '--json']);
    expect(sync.error).toBeUndefined();
    expect(sync.status).not.toBe(0);
    expect(`${sync.stdout}\n${sync.stderr}`).toContain('No embedding_model is configured in the file/environment or DB plane');
    expect(`${sync.stdout}\n${sync.stderr}`).toContain('gbrain migrate embeddings --status --json');
    expect(`${sync.stdout}\n${sync.stderr}`).not.toContain('zeroentropyai:zembed-1');
    expect(capturedEmbeds()).toEqual([]);
    expect(await existingVectorSnapshot()).toEqual(priorVectors);
    expect(await withFixtureEngine((engine) => engine.executeRaw<{ embedding_signature: string | null }>(
      `SELECT embedding_signature FROM pages WHERE slug = 'existing' AND source_id = $1`, [SOURCE],
    ))).toEqual(priorSignature);

    const status = runGbrain(['migrate', 'embeddings', '--status', '--json', '--brain', 'host']);
    expect(status.error).toBeUndefined();
    expect(status.status, `${status.stderr}\n${status.stdout}`).toBe(0);
    expect(status.stdout).toContain(SIGNATURE);
  }, 120_000);

  test('unreadable vector signatures refuse sync without changing stored vectors', async () => {
    await setDbIdentity(MODEL);
    const priorVectors = await existingVectorSnapshot();
    addCommittedNote('unreadable-signature');

    const sync = runGbrain(['sync', '--source', SOURCE, '--no-pull', '--no-extract', '--json'], {
      GBRAIN_TEST_FAIL_SIGNATURE_READ: '1',
    });
    expect(sync.error).toBeUndefined();
    expect(sync.status).not.toBe(0);
    expect(`${sync.stdout}\n${sync.stderr}`).toContain('Stored page embedding signatures could not be read: synthetic signature read failure');
    expect(`${sync.stdout}\n${sync.stderr}`).toContain('gbrain migrate embeddings --status --json');
    expect(`${sync.stdout}\n${sync.stderr}`).not.toContain('zeroentropyai:zembed-1');
    expect(capturedEmbeds()).toEqual([]);
    expect(await existingVectorSnapshot()).toEqual(priorVectors);
  }, 120_000);

  test('file and environment choices keep precedence over a conflicting DB model', async () => {
    const priorVectors = await existingVectorSnapshot();
    await setDbIdentity('openai:text-embedding-3-small');
    writeFileSync(fixture!.configPath, JSON.stringify({
      engine: 'pglite', database_path: fixture!.databasePath,
      embedding_model: MODEL, embedding_dimensions: DIMS,
    }));
    addCommittedNote('file-choice');
    const fileSync = runGbrain(['sync', '--source', SOURCE, '--no-pull', '--no-extract', '--json']);
    expect(fileSync.error).toBeUndefined();
    expect(fileSync.status, `${fileSync.stderr}\n${fileSync.stdout}`).toBe(0);
    expect(capturedEmbeds()).toContainEqual({
      provider: 'openai.embedding', modelId: 'text-embedding-3-large', dimensions: DIMS,
    });
    await withFixtureEngine(async (engine) => {
      expect(await engine.executeRaw<{ model: string; signature: string | null }>(
        `SELECT cc.model, p.embedding_signature AS signature
           FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
          WHERE p.slug = 'file-choice' AND cc.embedding IS NOT NULL`,
      )).toContainEqual({ model: MODEL, signature: SIGNATURE });
    });
    const fileChoice = runGbrain(['doctor', '--only', 'embedding_provider', '--json']);
    expect(fileChoice.error).toBeUndefined();
    expect(fileChoice.status, `${fileChoice.stderr}\n${fileChoice.stdout}`).toBe(0);
    const fileReport = JSON.parse(fileChoice.stdout) as { checks: Array<{ name: string; details?: Record<string, unknown> }> };
    expect(fileReport.checks.find((item) => item.name === 'embedding_provider')?.details)
      .toMatchObject({ model: MODEL, dimensions: DIMS });

    writeFileSync(fixture!.configPath, JSON.stringify({
      engine: 'pglite', database_path: fixture!.databasePath,
      embedding_model: 'voyage:voyage-4', embedding_dimensions: 1024,
    }));
    const envChoice = runGbrain(['doctor', '--only', 'embedding_provider', '--json'], {
      GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-small',
      GBRAIN_EMBEDDING_DIMENSIONS: String(DIMS),
    });
    expect(envChoice.error).toBeUndefined();
    expect(envChoice.status, `${envChoice.stderr}\n${envChoice.stdout}`).toBe(0);
    const envReport = JSON.parse(envChoice.stdout) as { checks: Array<{ name: string; details?: Record<string, unknown> }> };
    expect(envReport.checks.find((item) => item.name === 'embedding_provider')?.details)
      .toMatchObject({ model: 'openai:text-embedding-3-small', dimensions: DIMS });
    expect(await existingVectorSnapshot()).toEqual(priorVectors);
  }, 120_000);

  test('sync keeps the explicit embeddings-disabled choice usable', async () => {
    const priorVectors = await existingVectorSnapshot();
    const disabled = runGbrain(['config', 'set', 'embedding_disabled', 'true']);
    expect(disabled.error).toBeUndefined();
    expect(disabled.status, disabled.stderr).toBe(0);
    const doctor = runGbrain(['doctor', '--only', 'embedding_provider', '--json']);
    expect(doctor.error).toBeUndefined();
    expect(doctor.status, `${doctor.stderr}\n${doctor.stdout}`).toBe(0);
    const report = JSON.parse(doctor.stdout) as { checks: Array<{ name: string; readiness_state?: string; message: string }> };
    const check = report.checks.find((item) => item.name === 'embedding_provider');
    expect(check?.readiness_state).toBe('disabled_by_choice');
    expect(check?.message).toContain('embeddings are disabled');
    addCommittedNote('disabled-check');

    const sync = runGbrain(['sync', '--source', SOURCE, '--no-pull', '--no-extract', '--json']);
    expect(sync.error).toBeUndefined();
    expect(sync.status, `${sync.stderr}\n${sync.stdout}`).toBe(0);
    expect(capturedEmbeds()).toEqual([]);
    await withFixtureEngine(async (engine) => {
      expect(await engine.getConfig('embedding_model')).toBe(MODEL);
      expect(await engine.getConfig('embedding_disabled')).toBe('true');
      const rows = await engine.executeRaw<{ embedded: boolean }>(
        `SELECT cc.embedding IS NOT NULL AS embedded
           FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
          WHERE p.slug = 'disabled-check'`,
      );
      expect(rows.every((row) => !row.embedded)).toBe(true);
    });
    expect(JSON.parse(readFileSync(fixture!.configPath, 'utf8'))).toMatchObject({ embedding_disabled: true });
    expect(await existingVectorSnapshot()).toEqual(priorVectors);
  }, 120_000);
});
