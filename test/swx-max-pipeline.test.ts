/**
 * SWX (swxtchio/gbrain#14): postgres.js must not pipeline through a
 * transaction-mode pooler.
 *
 * GOAL: every client pool that resolvePrepare marks as "behind a transaction
 * pooler" (prepare: false) also gets `max_pipeline: 0`, because Supavisor
 * delivers only the first reply of a pipelined batch and the rest of the
 * connection's queries hang forever.
 *
 * Success means: the resolver's precedence holds (env override, then the
 * prepare signal); ConnectionManager's read pool carries the option; the two
 * pools that need a live connection to build are wired to it (source guard,
 * same style as postgres-engine.test.ts's resolvePrepare guard); and, when
 * SWX_TXN_POOLER_URL points at a real transaction pooler, two queries issued
 * concurrently on a one-connection pool both complete.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolveMaxPipeline } from '../src/core/db.ts';
import { ConnectionManager } from '../src/core/connection-manager.ts';
import { withEnv } from './helpers/with-env.ts';

const POOLER = 'postgresql://user:pass@127.0.0.1:6543/db';
const DIRECT = 'postgresql://user:pass@127.0.0.1:5432/db';

// Each case pins both knobs so an operator's shell env can't leak in.
const env = (vars: { GBRAIN_MAX_PIPELINE?: string; GBRAIN_PREPARE?: string }, fn: () => void) =>
  withEnv({ GBRAIN_MAX_PIPELINE: undefined, GBRAIN_PREPARE: undefined, ...vars }, fn);

describe('resolveMaxPipeline', () => {
  test('disables pipelining on the transaction-pooler port', () => env({}, () => {
    expect(resolveMaxPipeline(POOLER)).toBe(0);
  }));

  test('leaves the postgres.js default on a direct/session connection', () => env({}, () => {
    expect(resolveMaxPipeline(DIRECT)).toBeUndefined();
    expect(resolveMaxPipeline('postgresql://user:pass@host/db')).toBeUndefined();
  }));

  test('follows an explicit prepare=false (a pooler on another port)', () => env({}, () => {
    expect(resolveMaxPipeline(`${DIRECT}?prepare=false`)).toBe(0);
  }));

  test('GBRAIN_PREPARE=true on 6543 (session-mode pooler) keeps pipelining', () => env({ GBRAIN_PREPARE: 'true' }, () => {
    expect(resolveMaxPipeline(POOLER)).toBeUndefined();
  }));

  test('GBRAIN_MAX_PIPELINE overrides both ways', async () => {
    await env({ GBRAIN_MAX_PIPELINE: '100' }, () => expect(resolveMaxPipeline(POOLER)).toBe(100));
    await env({ GBRAIN_MAX_PIPELINE: '0' }, () => expect(resolveMaxPipeline(DIRECT)).toBe(0));
  });

  test.each(['-1', 'off', '1.5', ''])('a malformed GBRAIN_MAX_PIPELINE (%p) is ignored', bad => env({ GBRAIN_MAX_PIPELINE: bad }, () => {
    expect(resolveMaxPipeline(POOLER)).toBe(0);
  }));
});

describe('client pools', () => {
  // postgres() connects lazily, so the parsed options are inspectable offline.
  // postgres.js parses max_pipeline but leaves it off its ParsedOptions type.
  const maxPipeline = (sql: { options: object }) => (sql.options as { max_pipeline?: number }).max_pipeline;
  test('ConnectionManager read pool: max_pipeline 0 behind the pooler, default otherwise', () => env({}, async () => {
    const pooled = new ConnectionManager({ url: POOLER });
    const direct = new ConnectionManager({ url: DIRECT });
    try {
      expect(maxPipeline(await pooled.getReadPool())).toBe(0);
      expect(maxPipeline(await direct.getReadPool())).toBe(100);
    } finally {
      await pooled.disconnect();
      await direct.disconnect();
    }
  }));

  // These two pools run `SELECT 1` before returning, so they can't be built
  // offline; guard the wiring at the source instead.
  // test-reads-source-ok: these pools execute SELECT 1 before returning, so a hermetic runtime
  // test cannot reach this ordering; this pins max_pipeline is set before postgres().
  const code = (f: string) => readFileSync(new URL(`../src/core/${f}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  test.each([
    ['db.ts', /resolveMaxPipeline\(url\)[\s\S]*?opts\.max_pipeline\s*=[\s\S]*?sql\s*=\s*postgres\(url,\s*opts\)/],
    ['postgres-engine.ts', /db\.resolveMaxPipeline\(url\)[\s\S]*?opts\.max_pipeline\s*=[\s\S]*?this\._sql\s*=\s*postgres\(url,\s*opts\)/],
  ])('%s sets max_pipeline before building its pool', (file, wiring) => {
    expect(code(file)).toMatch(wiring);
  });
});

// Live regression: needs a real transaction-mode pooler (Supavisor :6543).
// Without the fix, the second of two concurrent queries on a one-connection
// pool never returns.
describe.skipIf(!process.env.SWX_TXN_POOLER_URL)('through a real transaction pooler', () => {
  const url = process.env.SWX_TXN_POOLER_URL ?? '';
  const both = (run: () => Promise<unknown>[]) =>
    Promise.race([Promise.all(run()).then(() => 'ok'), Bun.sleep(15_000).then(() => 'hung')]);

  test('engine instance pool: concurrent queries on one connection all complete', async () => {
    const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
    const engine = new PostgresEngine();
    await engine.connect({ engine: 'postgres', database_url: url, poolSize: 1 });
    try {
      expect(await both(() => [engine.sql`SELECT 1 AS a`, engine.sql`SELECT 2 AS b`, engine.sql`SELECT 3 AS c`])).toBe('ok');
    } finally {
      await engine.disconnect();
    }
  }, 30_000);
});
