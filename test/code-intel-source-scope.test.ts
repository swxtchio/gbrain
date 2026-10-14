/**
 * SWX fork policy (captain's order, 2026-10-14: "ALL agents on this box are
 * allowed to fully read every repo"): remote callers reach the six code reads
 * — upstream suspends them (garrytan/gbrain#5052); this fork intentionally
 * does not — and the existing per-caller source resolver plus codeReadFilter
 * still confine what they return. Trusted local behavior is unchanged.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../src/core/search/safe-chunks.ts';
import { NO_SOURCES } from '../src/core/source-id.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

// ─── ctx factory (copied from test/operations-source-isolation-matrix.test.ts) ───

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    dryRun: false,
    remote: true,
    transport: 'stdio',
    ...overrides,
  } as OperationContext;
}
const localAlpha = () => ctxOf({ remote: false, sourceId: 'srcalpha' });

// ─── Fixture seeding (approach reused from test/e2e/code-intel-mcp-ops-pglite.test.ts) ───

async function registerSource(id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, created_at)
     VALUES ($1, $1, $2, '{}'::jsonb, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [id, `/fake/${id}`],
  );
}

async function insertCodePage(sourceId: string, slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (slug, source_id, title, type, page_kind, compiled_truth, frontmatter, updated_at, created_at)
     VALUES ($1, $2, $3, 'code', 'code', '', '{}'::jsonb, NOW(), NOW())
     RETURNING id`,
    [slug, sourceId, slug],
  );
  return rows[0]!.id;
}

async function insertChunk(pageId: number, chunkIndex: number, symbolName: string, symbolType: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name, symbol_name_qualified, symbol_type)
     VALUES ($1, $2, $3, 'compiled_truth', 'typescript', $4, $4, $5)
     RETURNING id`,
    [pageId, chunkIndex, `// ${symbolName} body`, symbolName, symbolType],
  );
  return rows[0]!.id;
}

async function insertUnresolvedEdge(fromChunkId: number, fromSymbol: string, toSymbol: string, sourceId: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO code_edges_symbol (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, source_id, edge_metadata)
     VALUES ($1, $2, $3, 'calls', $4, '{}'::jsonb)`,
    [fromChunkId, fromSymbol, toSymbol, sourceId],
  );
}

/**
 * Two-source code graph:
 *   srcalpha: alphaCallerFn  → alphaTargetFn
 *             sharedCallerFn → alphaTargetFn
 *   srcbeta:  betaCallerFn   → betaSecretFn
 *             sharedCallerFn → betaSecretFn   (same FROM symbol as alpha's)
 *             betaCallerFn   → alphaTargetFn  (cross-source trap: same TO
 *                              symbol as alpha's target, edge owned by beta —
 *                              an alpha-scoped walk must never surface it)
 */
async function seedTwoSourceCodeGraph(): Promise<void> {
  await registerSource('srcalpha');
  await registerSource('srcbeta');

  const alphaLib = await insertCodePage('srcalpha', 'src/alpha-lib.ts');
  const alphaCaller = await insertCodePage('srcalpha', 'src/alpha-caller.ts');
  const alphaShared = await insertCodePage('srcalpha', 'src/shared-caller.ts');
  await insertChunk(alphaLib, 0, 'alphaTargetFn', 'function');
  const alphaCallerChunk = await insertChunk(alphaCaller, 0, 'alphaCallerFn', 'function');
  const alphaSharedChunk = await insertChunk(alphaShared, 0, 'sharedCallerFn', 'function');
  await insertUnresolvedEdge(alphaCallerChunk, 'alphaCallerFn', 'alphaTargetFn', 'srcalpha');
  await insertUnresolvedEdge(alphaSharedChunk, 'sharedCallerFn', 'alphaTargetFn', 'srcalpha');

  const betaLib = await insertCodePage('srcbeta', 'src/beta-lib.ts');
  const betaCaller = await insertCodePage('srcbeta', 'src/beta-caller.ts');
  const betaShared = await insertCodePage('srcbeta', 'src/beta-shared-caller.ts');
  await insertChunk(betaLib, 0, 'betaSecretFn', 'function');
  const betaCallerChunk = await insertChunk(betaCaller, 0, 'betaCallerFn', 'function');
  const betaSharedChunk = await insertChunk(betaShared, 0, 'sharedCallerFn', 'function');
  await insertUnresolvedEdge(betaCallerChunk, 'betaCallerFn', 'betaSecretFn', 'srcbeta');
  await insertUnresolvedEdge(betaSharedChunk, 'sharedCallerFn', 'betaSecretFn', 'srcbeta');
  await insertUnresolvedEdge(betaCallerChunk, 'betaCallerFn', 'alphaTargetFn', 'srcbeta');
  // Current projection + chunks sealed at the safe-fence chunker version: the
  // provenance remote reads require (codeReadFilter / safeChunksFilter).
  await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision, chunker_version=$1', [String(SAFE_FENCE_CHUNKER_VERSION)]);
}

// Trusted local reads retain their historical source behavior.


type Defs = { count: number; status: string; defs: Array<{ slug: string; symbol_name: string }> };
type Refs = { count: number; status: string; refs: Array<{ slug: string }> };
type Edges = { count: number; callers?: Array<{ from_symbol_qualified: string; source_id: string | null }>; callees?: Array<{ to_symbol_qualified: string; source_id: string | null }> };
type Walk = { result: string; status?: string; depth_groups?: Array<{ nodes: Array<{ symbol: string }> }> };
const walkSymbols = (walk: Walk) => (walk.depth_groups ?? []).flatMap(group => group.nodes.map(node => node.symbol));
const callerNames = (edges: Edges) => (edges.callers ?? []).map(edge => edge.from_symbol_qualified);
const calleeNames = (edges: Edges) => (edges.callees ?? []).map(edge => edge.to_symbol_qualified);

async function denied(run: () => Promise<unknown>): Promise<OperationError> {
  let caught: unknown;
  try { await run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(OperationError);
  return caught as OperationError;
}

describe('SWX fork policy: remote code reads return results within the caller grant', () => {
  // remote:true is what both MCP transports set; undefined is dispatch's
  // fail-closed default for omitted trust. Both must read, both stay confined.
  for (const remote of [true, undefined]) {
    for (const transport of ['stdio', 'http'] as const) {
      const remoteAlpha = () => ctxOf({ remote, transport, sourceId: 'srcalpha' });

      test(`remote=${remote} ${transport}: all six reads return srcalpha hits and never srcbeta's`, async () => {
        await seedTwoSourceCodeGraph();
        const ctx = remoteAlpha();

        const defs = await operationsByName.code_def.handler(ctx, { symbol: 'alphaTargetFn' }) as Defs;
        expect(defs.status).toBe('ready');
        expect(defs.defs.map(d => d.slug)).toEqual(['src/alpha-lib.ts']);
        const hiddenDefs = await operationsByName.code_def.handler(ctx, { symbol: 'betaSecretFn' }) as Defs;
        expect(hiddenDefs.count).toBe(0);

        const refs = await operationsByName.code_refs.handler(ctx, { symbol: 'alphaTargetFn' }) as Refs;
        expect(refs.refs.map(r => r.slug)).toContain('src/alpha-lib.ts');
        const hiddenRefs = await operationsByName.code_refs.handler(ctx, { symbol: 'betaSecretFn' }) as Refs;
        expect(hiddenRefs.count).toBe(0);

        // betaCallerFn → alphaTargetFn is owned by srcbeta: the cross-source trap.
        const callers = await operationsByName.code_callers.handler(ctx, { symbol: 'alphaTargetFn' }) as Edges;
        expect(callerNames(callers).sort()).toEqual(['alphaCallerFn', 'sharedCallerFn']);
        const callees = await operationsByName.code_callees.handler(ctx, { symbol: 'sharedCallerFn' }) as Edges;
        expect(calleeNames(callees)).toEqual(['alphaTargetFn']);

        const blast = await operationsByName.code_blast.handler(ctx, { symbol: 'alphaTargetFn', exact: true }) as Walk;
        expect(blast.result).toBe('ok');
        expect(walkSymbols(blast).sort()).toEqual(['alphaCallerFn', 'sharedCallerFn']);
        const flow = await operationsByName.code_flow.handler(ctx, { entry_point: 'sharedCallerFn', exact: true }) as Walk;
        expect(flow.result).toBe('ok');
        expect(walkSymbols(flow)).toEqual(['alphaTargetFn']);
      });

      test(`remote=${remote} ${transport}: an explicit source_id outside the scalar grant is refused`, async () => {
        await seedTwoSourceCodeGraph();
        for (const [name, params] of [
          ['code_callers', { symbol: 'betaSecretFn' }],
          ['code_callees', { symbol: 'betaCallerFn' }],
          ['code_blast', { symbol: 'betaSecretFn' }],
          ['code_flow', { entry_point: 'betaCallerFn' }],
        ] as const) {
          const error = await denied(() => operationsByName[name].handler(remoteAlpha(), { ...params, source_id: 'srcbeta' }));
          expect(error.code).toBe('permission_denied');
        }
        // __all__ collapses to the grant, never the brain.
        const spanned = await operationsByName.code_callers.handler(remoteAlpha(), { symbol: 'alphaTargetFn', all_sources: true }) as Edges;
        expect(callerNames(spanned).sort()).toEqual(['alphaCallerFn', 'sharedCallerFn']);
      });
    }
  }

  test('a federated grant reads both granted sources, and traversal requires a selected granted source', async () => {
    await seedTwoSourceCodeGraph();
    await registerSource('srcgamma');
    const gammaPage = await insertCodePage('srcgamma', 'src/gamma-lib.ts');
    await insertChunk(gammaPage, 0, 'gammaOnlyFn', 'function');
    await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision, chunker_version=$1', [String(SAFE_FENCE_CHUNKER_VERSION)]);
    const ctx = ctxOf({ auth: { allowedSources: ['srcalpha', 'srcbeta'] } } as unknown as Partial<OperationContext>);

    const beta = await operationsByName.code_def.handler(ctx, { symbol: 'betaSecretFn' }) as Defs;
    expect(beta.defs.map(d => d.slug)).toEqual(['src/beta-lib.ts']);
    const gamma = await operationsByName.code_def.handler(ctx, { symbol: 'gammaOnlyFn' }) as Defs;
    expect(gamma.count).toBe(0);

    for (const [name, params] of [
      ['code_callers', { symbol: 'betaSecretFn' }],
      ['code_callees', { symbol: 'betaCallerFn' }],
      ['code_blast', { symbol: 'betaSecretFn' }],
      ['code_flow', { entry_point: 'betaCallerFn' }],
    ] as const) {
      const unselected = await denied(() => operationsByName[name].handler(ctx, params));
      expect(unselected.code).toBe('invalid_params');
      const ungranted = await denied(() => operationsByName[name].handler(ctx, { ...params, source_id: 'srcgamma' }));
      expect(ungranted.code).toBe('permission_denied');
    }
    const callers = await operationsByName.code_callers.handler(ctx, { symbol: 'betaSecretFn', source_id: 'srcbeta' }) as Edges;
    expect(callerNames(callers).sort()).toEqual(['betaCallerFn', 'sharedCallerFn']);
    const blast = await operationsByName.code_blast.handler(ctx, { symbol: 'betaSecretFn', exact: true, source_id: 'srcbeta' }) as Walk;
    expect(walkSymbols(blast).sort()).toEqual(['betaCallerFn', 'sharedCallerFn']);
    const flow = await operationsByName.code_flow.handler(ctx, { entry_point: 'betaCallerFn', exact: true, source_id: 'srcbeta' }) as Walk;
    expect(walkSymbols(flow).sort()).toEqual(['alphaTargetFn', 'betaSecretFn']);
  });

  test('a single-source federated grant confines definitions and traversal to that source', async () => {
    await seedTwoSourceCodeGraph();
    const ctx = ctxOf({ auth: { allowedSources: ['srcbeta'] } } as unknown as Partial<OperationContext>);
    const beta = await operationsByName.code_def.handler(ctx, { symbol: 'betaSecretFn' }) as Defs;
    expect(beta.count).toBe(1);
    const alpha = await operationsByName.code_def.handler(ctx, { symbol: 'alphaTargetFn' }) as Defs;
    expect(alpha.count).toBe(0);
    const callers = await operationsByName.code_callers.handler(ctx, { symbol: 'alphaTargetFn' }) as Edges;
    expect(callerNames(callers)).toEqual(['betaCallerFn']);
    expect((await denied(() => operationsByName.code_blast.handler(ctx, { symbol: 'alphaTargetFn', source_id: 'srcalpha' }))).code).toBe('permission_denied');
  });

  test('a remote caller with no readable source is refused by every read, not widened', async () => {
    await seedTwoSourceCodeGraph();
    const noGrant = [
      ctxOf({ auth: { allowedSources: [] } } as unknown as Partial<OperationContext>),
      ctxOf({ sourceId: NO_SOURCES }),
    ];
    for (const ctx of noGrant) {
      for (const [name, params] of [
        ['code_def', { symbol: 'alphaTargetFn' }],
        ['code_refs', { symbol: 'alphaTargetFn' }],
        ['code_callers', { symbol: 'alphaTargetFn' }],
        ['code_callees', { symbol: 'alphaCallerFn' }],
        ['code_blast', { symbol: 'alphaTargetFn' }],
        ['code_flow', { entry_point: 'alphaCallerFn' }],
      ] as const) {
        expect((await denied(() => operationsByName[name].handler(ctx, params))).code).toBe('permission_denied');
      }
    }
  });

  test('remote definitions and references keep the row policy: private, unsealed, stale, deleted and archived rows are withheld', async () => {
    await seedTwoSourceCodeGraph();
    const ctx = ctxOf({ sourceId: 'srcalpha' });
    const read = async () => ({
      defs: (await operationsByName.code_def.handler(ctx, { symbol: 'alphaTargetFn' }) as Defs),
      refs: (await operationsByName.code_refs.handler(ctx, { symbol: 'alphaTargetFn' }) as Refs),
    });
    const lib = "slug='src/alpha-lib.ts'";
    // Two statements: the revision trigger bumps knowledge_revision on the
    // first, so the projection is re-sealed against the bumped value.
    const restore = [
      `UPDATE pages SET frontmatter='{}'::jsonb, chunker_version='${SAFE_FENCE_CHUNKER_VERSION}', deleted_at=NULL WHERE ${lib}`,
      `UPDATE pages SET text_projection_revision=knowledge_revision WHERE ${lib}`,
      "UPDATE sources SET archived=false WHERE id='srcalpha'",
    ];
    expect((await read()).defs.count).toBe(1);
    // Every break except the stale one re-seals the projection, so each case
    // is withheld by its own filter rather than by a bumped revision.
    const reseal = `UPDATE pages SET text_projection_revision=knowledge_revision WHERE ${lib}`;
    for (const [label, breakIt, extra] of [
      ['private', [`UPDATE pages SET frontmatter='{"visibility":"private"}'::jsonb WHERE ${lib}`, reseal], undefined],
      ['below the safe-chunk fence', [`UPDATE pages SET chunker_version='${SAFE_FENCE_CHUNKER_VERSION - 1}' WHERE ${lib}`, reseal], undefined],
      ['stale projection', [`UPDATE pages SET text_projection_revision=NULL WHERE ${lib}`], 'projection_pending'],
      ['deleted', [`UPDATE pages SET deleted_at=NOW() WHERE ${lib}`, reseal], undefined],
      ['archived source', ["UPDATE sources SET archived=true WHERE id='srcalpha'"], undefined],
    ] as const) {
      for (const statement of breakIt) await engine.executeRaw(statement);
      const { defs, refs } = await read();
      expect({ label, defs: defs.count, refs: refs.refs.filter(r => r.slug === 'src/alpha-lib.ts').length }).toEqual({ label, defs: 0, refs: 0 });
      if (extra) expect(defs.status).toBe(extra);
      for (const statement of restore) await engine.executeRaw(statement);
      expect((await read()).defs.count).toBe(1);
    }
    // The trusted local CLI still reads the unsealed row (no safe-chunk requirement).
    await engine.executeRaw(`UPDATE pages SET chunker_version='${SAFE_FENCE_CHUNKER_VERSION - 1}' WHERE ${lib}`);
    expect((await operationsByName.code_def.handler(localAlpha(), { symbol: 'alphaTargetFn' }) as Defs).count).toBe(1);
  });
});

describe('trusted local code reads keep their historical source behavior', () => {
  test('trusted local definitions and references retain the brain-wide public contract', async () => {
    await seedTwoSourceCodeGraph();
    const ctx = localAlpha();
    const defs = await operationsByName.code_def.handler(ctx, { symbol: 'betaSecretFn' }) as { count: number; defs: unknown[] };
    const refs = await operationsByName.code_refs.handler(ctx, { symbol: 'betaSecretFn' }) as { count: number; refs: unknown[] };
    expect(defs.count).toBeGreaterThan(0);
    expect(refs.count).toBeGreaterThan(0);
    expect(JSON.stringify(defs.defs)).toContain('beta');
    expect(JSON.stringify(refs.refs)).toContain('beta');
  });

  test('trusted local code_blast and code_flow carry the readiness envelope on a miss', async () => {
    // A bare {result:'not_found'} conflates "graph not built" with "zero
    // callers". The graph IS built for srcalpha (symbol-bearing chunks exist),
    // so a miss on a symbol that lives only in srcbeta must read as a trusted
    // miss: status 'ready', ready true — the same contract the four siblings
    // (code_callers/callees/def/refs) already carry.
    await seedTwoSourceCodeGraph();
    const ctx = localAlpha();
    const blast = await operationsByName.code_blast.handler(ctx, { symbol: 'betaSecretFn' }) as { result: string; status?: string; ready?: boolean };
    const flow = await operationsByName.code_flow.handler(ctx, { entry_point: 'betaSecretFn' }) as { result: string; status?: string; ready?: boolean };
    expect(blast.result).toBe('not_found');
    expect(blast.status).toBe('ready');
    expect(blast.ready).toBe(true);
    expect(flow.result).toBe('not_found');
    expect(flow.status).toBe('ready');
    expect(flow.ready).toBe(true);
  });
});

// ─── attachWalkReadiness branches (src/core/ops/code-intel.ts → code-graph-readiness.ts) ───

type WalkEnvelope = {
  result: string;
  status?: string;
  ready?: boolean;
  scoped_source_id?: string;
  depth_groups?: { nodes: unknown[] }[];
};

describe('code_blast / code_flow readiness envelope distinguishes unbuilt, out-of-scope, and ready graphs', () => {
  test('unseeded brain (no code anywhere) → status not_built, ready false, no scoped_source_id', async () => {
    // Nothing seeded: beforeEach left every table empty. A miss here is NOT
    // a trusted miss — the graph was never built — so the envelope must say
    // so instead of the bare {result:'not_found'} an agent reads as "no callers".
    const ctx = localAlpha();
    const blast = await operationsByName.code_blast.handler(ctx, { symbol: 'alphaTargetFn' }) as WalkEnvelope;
    const flow = await operationsByName.code_flow.handler(ctx, { entry_point: 'alphaCallerFn' }) as WalkEnvelope;
    for (const walk of [blast, flow]) {
      expect(walk.result).toBe('not_found');
      expect(walk.status).toBe('not_built');
      expect(walk.ready).toBe(false);
      expect(walk.scoped_source_id).toBeUndefined();
    }
  });

  test('ctx scoped to a code-less source while code exists elsewhere → status out_of_scope naming the scoped source', async () => {
    // The graph IS built (srcalpha + srcbeta hold code) but the caller's
    // resolved scope is srcgamma, which holds none. That is a scope/grant
    // problem, not an indexing one: the envelope must carry `scoped_source_id`
    // so the hint can name the scope instead of misdirecting to `gbrain sync`.
    await seedTwoSourceCodeGraph();
    await registerSource('srcgamma');
    const ctx = ctxOf({ remote: false, sourceId: 'srcgamma' });
    const blast = await operationsByName.code_blast.handler(ctx, { symbol: 'alphaTargetFn' }) as WalkEnvelope;
    const flow = await operationsByName.code_flow.handler(ctx, { entry_point: 'alphaCallerFn' }) as WalkEnvelope;
    for (const walk of [blast, flow]) {
      expect(walk.result).toBe('not_found');
      expect(walk.status).toBe('out_of_scope');
      expect(walk.ready).toBe(false);
      expect(walk.scoped_source_id).toBe('srcgamma');
    }
  });

  test('a walk that returns nodes → status ready, ready true, no scoped_source_id', async () => {
    await seedTwoSourceCodeGraph();
    const ctx = localAlpha();
    // callers of alphaTargetFn in srcalpha: alphaCallerFn + sharedCallerFn
    const blast = await operationsByName.code_blast.handler(ctx, { symbol: 'alphaTargetFn' }) as WalkEnvelope;
    // callees of alphaCallerFn in srcalpha: alphaTargetFn
    const flow = await operationsByName.code_flow.handler(ctx, { entry_point: 'alphaCallerFn' }) as WalkEnvelope;
    for (const walk of [blast, flow]) {
      expect(walk.result).toBe('ok');
      expect((walk.depth_groups ?? []).reduce((n, g) => n + g.nodes.length, 0)).toBeGreaterThan(0);
      expect(walk.status).toBe('ready');
      expect(walk.ready).toBe(true);
      expect(walk.scoped_source_id).toBeUndefined();
    }
  });
});
