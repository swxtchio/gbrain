/**
 * SWX fork policy (captain's order, 2026-10-14: "ALL agents on this box are
 * allowed to fully read every repo. Limiting gbrain is not useful."): agent
 * callers reach the six code reads through MCP dispatch with the exact trust
 * both transports set (remote: true over stdio and HTTP), and omitted trust
 * (dispatch's remote default) too. Upstream suspends these reads
 * (garrytan/gbrain#5052); this fork intentionally does not, so re-apply on
 * rebase. Each verb must return the seeded, granted-source result as a
 * successful tool result, and a no-grant HTTP token reads every federated
 * source as search does; code-intel-source-scope owns confinement detail.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../src/core/search/safe-chunks.ts';

let engine: PGLiteEngine;

async function seedCode(source: string, slug: string, symbol: string, calls?: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [source]);
  const [page] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, title, type, page_kind, compiled_truth, frontmatter, chunker_version)
     VALUES ($1, $2, $1, 'code', 'code', '', '{}'::jsonb, $3) RETURNING id`,
    [slug, source, String(SAFE_FENCE_CHUNKER_VERSION)],
  );
  const [chunk] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name, symbol_name_qualified, symbol_type)
     VALUES ($1, 0, $2, 'compiled_truth', 'typescript', $3, $3, 'function') RETURNING id`,
    [page!.id, `function ${symbol}() { ${calls ? `${calls}();` : ''} }`, symbol],
  );
  if (calls) {
    await engine.executeRaw(
      `INSERT INTO code_edges_symbol (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, source_id, edge_metadata)
       VALUES ($1, $2, $3, 'calls', $4, '{}'::jsonb)`,
      [chunk!.id, symbol, calls, source],
    );
  }
  await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision WHERE id=$1', [page!.id]);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // granted: grantedEntry → grantedTarget; other mirrors it with the same target name.
  await seedCode('granted', 'src/target.ts', 'grantedTarget');
  await seedCode('granted', 'src/entry.ts', 'grantedEntry', 'grantedTarget');
  await seedCode('other', 'src/other-target.ts', 'grantedTarget');
  await seedCode('other', 'src/other-entry.ts', 'otherEntry', 'grantedTarget');
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

/** Each verb, its arguments, and the granted-source answer it must carry. */
const READS: Array<[string, Record<string, unknown>, (result: any) => unknown, unknown]> = [
  ['code_def', { symbol: 'grantedTarget' }, r => r.defs.map((d: any) => d.slug), ['src/target.ts']],
  ['code_refs', { symbol: 'grantedTarget' }, r => r.refs.map((x: any) => x.slug).sort(), ['src/entry.ts', 'src/target.ts']],
  ['code_callers', { symbol: 'grantedTarget' }, r => r.callers.map((e: any) => e.from_symbol_qualified), ['grantedEntry']],
  ['code_callees', { symbol: 'grantedEntry' }, r => r.callees.map((e: any) => e.to_symbol_qualified), ['grantedTarget']],
  ['code_blast', { symbol: 'grantedTarget', exact: true }, r => r.depth_groups.flatMap((g: any) => g.nodes.map((n: any) => n.symbol)), ['grantedEntry']],
  ['code_flow', { entry_point: 'grantedEntry', exact: true }, r => r.depth_groups.flatMap((g: any) => g.nodes.map((n: any) => n.symbol)), ['grantedTarget']],
];

const TRUST: Array<[string, Parameters<typeof dispatchToolCall>[3]]> = [
  ['stdio (remote: true, scalar source)', { remote: true, transport: 'stdio', sourceId: 'granted' }],
  ['http (remote: true, token grant)', { remote: true, transport: 'http', sourceId: 'granted', auth: { allowedSources: ['granted'] } as never }],
  ['omitted trust (dispatch default)', { transport: 'stdio', sourceId: 'granted' }],
];

describe('SWX fork policy: agent callers read code through MCP dispatch', () => {
  for (const [name, params, project, expected] of READS) {
    for (const [label, opts] of TRUST) {
      test(`${name} over ${label} returns the granted-source result`, async () => {
        const result = await dispatchToolCall(engine, name, params, opts);
        expect(result.isError).toBeFalsy();
        expect(project(JSON.parse(result.content[0]!.text))).toEqual(expected);
      });
    }
    // Local definition/reference reads stay brain-wide, so they may add the
    // ungranted source's rows; the granted answer must still be present.
    test(`${name} on the trusted local CLI still runs`, async () => {
      const ctx = { engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false, sourceId: 'granted' } as OperationContext;
      expect(project(await operationsByName[name]!.handler(ctx, params))).toEqual(expect.arrayContaining(expected as unknown[]));
    });
  }

  test('an HTTP traversal naming a source outside the token grant is refused through dispatch', async () => {
    const result = await dispatchToolCall(engine, 'code_callers', { symbol: 'grantedTarget', source_id: 'other' },
      { remote: true, transport: 'http', sourceId: 'granted', auth: { allowedSources: ['granted'] } as never });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ code: 'permission_denied', message: 'Requested source is outside your granted sources' });
  });

  test('a no-grant HTTP token reads code in the other federated source, as search does', async () => {
    const opts = {
      remote: true, transport: 'http' as const, sourceId: 'granted', localFederatedSourceIds: ['granted', 'other'],
      auth: { token: '', clientId: 'legacy', scopes: ['read'], sourceId: 'granted', hasSourceGrant: false } as never,
    };
    const defs = await dispatchToolCall(engine, 'code_def', { symbol: 'grantedTarget' }, opts);
    expect(defs.isError).toBeFalsy();
    expect(JSON.parse(defs.content[0]!.text).defs.map((d: any) => d.slug).sort())
      .toEqual(['src/other-target.ts', 'src/target.ts']);
    const callers = await dispatchToolCall(engine, 'code_callers', { symbol: 'grantedTarget', source_id: 'other' }, opts);
    expect(callers.isError).toBeFalsy();
    expect(JSON.parse(callers.content[0]!.text).callers.map((e: any) => e.from_symbol_qualified)).toEqual(['otherEntry']);
  });
});
