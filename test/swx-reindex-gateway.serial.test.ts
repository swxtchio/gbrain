/**
 * SWX: `gbrain reindex --markdown` must embed even when its caller skipped
 * cli.ts's engine-connect gateway init. `gbrain post-upgrade`'s chunker-bump
 * sweep calls runReindex that way, and every page failed with "AI gateway is
 * not configured" (then was retried with backoff for days on a large brain).
 *
 * Serial: mutates the process-global gateway and GBRAIN_HOME.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { _clearGatewayForTests, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runReindex } from '../src/commands/reindex.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;
let embedCalls = 0;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-reindex-gateway-'));
  mkdirSync(join(home, '.gbrain'));
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    embedding_model: 'openai:text-embedding-3-small',
    embedding_dimensions: 1536,
  }));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO pages (slug, type, title, compiled_truth, timeline, page_kind, chunker_version)
     VALUES ('notes/old', 'note', 'Old', 'A page chunked by an older chunker.', '', 'markdown', 1)`,
  );
}, 60_000); // a fresh PGLite schema applies 160+ migrations

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

describe('reindex --markdown without a pre-configured gateway', () => {
  test('configures the gateway from config and re-embeds instead of failing every page', async () => {
    // The post-upgrade state: no gateway at all (resetGateway() would restore
    // the test preload's baseline config and hide the bug).
    _clearGatewayForTests();
    // After the clear, which also drops an installed stub.
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
      embedCalls++;
      return { embeddings: values.map(() => new Array(1536).fill(0.01)), usage: { tokens: values.length } };
    }) as never);

    const result = await withEnv({ GBRAIN_HOME: home, OPENAI_API_KEY: 'sk-test' }, () =>
      runReindex(engine, ['--markdown']),
    );

    expect(result.failed).toBe(0);
    expect(result.reindexed).toBe(1);
    expect(embedCalls).toBeGreaterThan(0);
  }, 30_000);
});

describe('post-upgrade re-embed prompt', () => {
  // Structural (same pattern as test/fix-wave-structural.test.ts): the cost
  // estimate must read the CONFIGURED embedding model. Without the gateway
  // initialized first, getEmbeddingModel() throws and the prompt quotes the
  // openai:text-embedding-3-large fallback while runReindex embeds with the
  // configured model at a different price.
  test('initializes the gateway before reading the model for the estimate', async () => {
    const src = await Bun.file('src/commands/upgrade.ts').text();
    const init = src.indexOf('configureGatewayIfUninitialized();');
    const read = src.indexOf('modelString = getEmbeddingModel()');
    const prompt = src.indexOf('runPostUpgradeReembedPrompt(engine, modelString)');
    expect(init).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(init);
    expect(prompt).toBeGreaterThan(read);
  });
});
