import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { PostgresEngine } from '../src/core/postgres-engine.ts';
import { runMigrations } from '../src/core/migrate.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const INDEX_NAME = 'idx_code_edges_symbol_resolved_chunk';
const PGLITE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${INDEX_NAME}
  ON code_edges_symbol (source_id, ((edge_metadata->>'resolved_chunk_id')::int));`;
const POSTGRES_INDEX_SQL = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
  ON code_edges_symbol (source_id, ((edge_metadata->>'resolved_chunk_id')::int));`;
const PRE_INDEX_SCHEMA_VERSION = '260';

interface CatalogIndex {
  name: string;
  identity: string;
  valid: boolean;
  unique: boolean;
  key_count: number;
  attribute_count: number;
  access_method: string;
  first_key: string;
  second_key: string;
  definition: string;
  predicate: string | null;
}

async function codeEdgeIndexes(engine: BrainEngine): Promise<CatalogIndex[]> {
  return engine.executeRaw<CatalogIndex>(`
    SELECT index_class.relname AS name,
           index_row.indexrelid::text AS identity,
           index_row.indisvalid AS valid,
           index_row.indisunique AS unique,
           index_row.indnkeyatts AS key_count,
           index_row.indnatts AS attribute_count,
           access_method.amname AS access_method,
           pg_get_indexdef(index_row.indexrelid, 1, true) AS first_key,
           pg_get_indexdef(index_row.indexrelid, 2, true) AS second_key,
           pg_get_indexdef(index_row.indexrelid) AS definition,
           pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate
      FROM pg_index AS index_row
      JOIN pg_class AS table_class ON table_class.oid = index_row.indrelid
      JOIN pg_class AS index_class ON index_class.oid = index_row.indexrelid
      JOIN pg_am AS access_method ON access_method.oid = index_class.relam
     WHERE table_class.oid = to_regclass('code_edges_symbol')
     ORDER BY index_class.relname`);
}

function isResolvedChunkIndex(index: CatalogIndex): boolean {
  const expression = index.second_key.toLowerCase().replace(/\s+/g, ' ');
  return index.first_key.trim().toLowerCase() === 'source_id'
    && expression.includes("edge_metadata ->> 'resolved_chunk_id'")
    && expression.includes('::integer');
}

async function expectResolvedChunkIndex(engine: BrainEngine): Promise<CatalogIndex> {
  const equivalent = (await codeEdgeIndexes(engine)).filter(isResolvedChunkIndex);
  expect(equivalent).toHaveLength(1);
  const index = equivalent[0]!;
  expect(index.name).toBe(INDEX_NAME);
  expect(index.valid).toBe(true);
  expect(index.unique).toBe(false);
  expect(Number(index.key_count)).toBe(2);
  expect(Number(index.attribute_count)).toBe(2);
  expect(index.access_method).toBe('btree');
  expect(index.first_key).toBe('source_id');
  expect(index.second_key.replace(/\s+/g, ' ')).toBe("((edge_metadata ->> 'resolved_chunk_id'::text)::integer)");
  expect(index.predicate).toBeNull();
  expect(index.definition.replace(/\bpublic\./g, '').replace(/\s+/g, ' ').trim()).toBe(
    `CREATE INDEX ${INDEX_NAME} ON code_edges_symbol USING btree (source_id, (((edge_metadata ->> 'resolved_chunk_id'::text))::integer))`,
  );
  return index;
}

async function withEngine<T>(backend: 'pglite' | 'postgres', run: (engine: BrainEngine) => Promise<T>): Promise<T> {
  let engine: BrainEngine | undefined;
  let close: (() => Promise<void>) | undefined;
  try {
    if (backend === 'postgres') {
      const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = isolated.engine;
      close = isolated.close;
    } else {
      const pglite = new PGLiteEngine();
      await pglite.connect({});
      engine = pglite;
      close = () => pglite.disconnect();
      await engine.initSchema();
    }
    if (!engine) throw new Error('test engine setup did not produce an engine');
    return await run(engine);
  } finally {
    await close?.();
  }
}

async function runMigrationsWithPostgresStatements(engine: BrainEngine): Promise<{ applied: number; current: number; statements: string[] }> {
  if (engine.kind !== 'postgres') {
    const result = await runMigrations(engine);
    return { ...result, statements: [] };
  }

  const pg = engine as PostgresEngine;
  const original = pg.withReservedConnection.bind(pg) as PostgresEngine['withReservedConnection'];
  const statements: string[] = [];
  type Callback = Parameters<PostgresEngine['withReservedConnection']>[0];
  type Options = Parameters<PostgresEngine['withReservedConnection']>[1];
  pg.withReservedConnection = (async (callback: Callback, options?: Options) => original(async connection => callback({
    executeRaw: async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      statements.push(sql);
      return connection.executeRaw<R>(sql, params);
    },
  }), options)) as PostgresEngine['withReservedConnection'];
  try {
    return { ...(await runMigrations(engine)), statements };
  } finally {
    pg.withReservedConnection = original;
  }
}

async function createHandBuiltIndex(engine: BrainEngine): Promise<void> {
  if (engine.kind === 'postgres') {
    await (engine as PostgresEngine).withReservedConnection(connection => connection.executeRaw(POSTGRES_INDEX_SQL));
  } else {
    await engine.executeRaw(PGLITE_INDEX_SQL);
  }
}

for (const backend of testBackends()) describe(`[${backend}] resolved-chunk code-edge index migration`, () => {
  test('fresh initialization installs the exact valid, non-unique B-tree index', async () => {
    await withEngine(backend, async engine => {
      await expectResolvedChunkIndex(engine);
    });
  }, 120_000);

  test('the migration runner builds the index when a v260 database has none', async () => {
    await withEngine(backend, async engine => {
      await engine.executeRaw(`DROP INDEX ${INDEX_NAME}`);
      await engine.setConfig('version', PRE_INDEX_SCHEMA_VERSION);
      expect((await codeEdgeIndexes(engine)).filter(isResolvedChunkIndex)).toHaveLength(0);

      const migration = await runMigrationsWithPostgresStatements(engine);
      expect(migration.applied).toBeGreaterThan(0);
      expect(migration.current).toBe(261);
      await expectResolvedChunkIndex(engine);

      if (backend === 'postgres') {
        const creates = migration.statements.filter(statement => statement.startsWith('CREATE INDEX CONCURRENTLY IF NOT EXISTS'));
        expect(creates.map(statement => statement.replace(/\s+/g, ' ').trim())).toEqual([
          POSTGRES_INDEX_SQL.replace(/\s+/g, ' ').trim(),
        ]);
        expect(migration.statements.filter(statement => /^(BEGIN|SET|RESET)\b/i.test(statement))).toEqual([]);
      }
    });
  }, 120_000);

  test('the migration adopts an exact hand-built index without changing its identity or adding a duplicate', async () => {
    await withEngine(backend, async engine => {
      await engine.executeRaw(`DROP INDEX ${INDEX_NAME}`);
      await createHandBuiltIndex(engine);
      const before = await expectResolvedChunkIndex(engine);
      await engine.setConfig('version', PRE_INDEX_SCHEMA_VERSION);

      const firstRun = await runMigrationsWithPostgresStatements(engine);
      expect(firstRun.applied).toBeGreaterThan(0);
      expect(firstRun.statements.filter(statement => statement.startsWith('CREATE INDEX CONCURRENTLY IF NOT EXISTS'))).toEqual([]);
      const afterFirstRun = await expectResolvedChunkIndex(engine);
      expect(afterFirstRun.identity).toBe(before.identity);
      expect(afterFirstRun.definition).toBe(before.definition);

      await engine.setConfig('version', PRE_INDEX_SCHEMA_VERSION);
      const secondRun = await runMigrationsWithPostgresStatements(engine);
      expect(secondRun.applied).toBeGreaterThan(0);
      expect(secondRun.statements.filter(statement => statement.startsWith('CREATE INDEX CONCURRENTLY IF NOT EXISTS'))).toEqual([]);
      const afterSecondRun = await expectResolvedChunkIndex(engine);
      expect(afterSecondRun.identity).toBe(before.identity);
      expect(afterSecondRun.definition).toBe(before.definition);
      expect((await codeEdgeIndexes(engine)).filter(isResolvedChunkIndex)).toHaveLength(1);
    });
  }, 120_000);
});
