import type { Migration } from './types.ts';
import { buildIndexOnline } from './helpers.ts';

// Postgres replays the schema blob before migrations, so keep this online index migration-owned; PGLite creates code-edge tables in earlier migrations.
const RESOLVED_CHUNK_INDEX = {
  name: 'idx_code_edges_symbol_resolved_chunk',
  table: 'code_edges_symbol',
  sql: `CREATE INDEX IF NOT EXISTS idx_code_edges_symbol_resolved_chunk
    ON code_edges_symbol (source_id, ((edge_metadata->>'resolved_chunk_id')::int));`,
};

export const v261: Migration = {
  version: 261,
  name: 'code_edges_symbol_resolved_chunk_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    await buildIndexOnline(engine, 261, RESOLVED_CHUNK_INDEX);
  },
};
