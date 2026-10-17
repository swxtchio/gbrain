/**
 * #5183: `embed --stale` wedged (no progress, no error, 0% CPU) when
 * GBRAIN_EMBED_CONCURRENCY (default 20) exceeded the Postgres client pool:
 * every worker holds a connection, so extra workers waited on the pool
 * forever. Embed concurrency is now clamped to the pool on Postgres. Both
 * embed loops' worker counts are exercised in embed.serial.test.ts.
 */

import { describe, test, expect, spyOn } from 'bun:test';

import { _resetEmbedConcurrencyClampWarningForTest, resolveEmbedConcurrency } from '../src/commands/embed.ts';
import { resolvePacedEmbedAdmission } from '../src/core/embed-concurrency.ts';
import { resolvePaceMode } from '../src/core/pace-mode.ts';
import { withEnv } from './helpers/with-env.ts';

describe('#5183 embed concurrency never exceeds the Postgres pool', () => {
  test('an explicit setting above the pool is clamped, with one warning per process', () => {
    _resetEmbedConcurrencyClampWarningForTest();
    const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(resolveEmbedConcurrency('postgres', undefined, { GBRAIN_EMBED_CONCURRENCY: '20' }, 12)).toBe(12);
      expect(resolveEmbedConcurrency('postgres', undefined, { GBRAIN_EMBED_CONCURRENCY: '20' }, 12)).toBe(12);
      const lines = err.mock.calls.map(c => String(c[0])).filter(l => l.includes('[embed]'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('GBRAIN_EMBED_CONCURRENCY=20 is above the connection pool (12); using 12 workers');
      expect(lines[0]).toContain('GBRAIN_POOL_SIZE');
    } finally {
      err.mockRestore();
    }
  });

  test('the default 20 is clamped to the pool silently (the pool-2 guidance case)', () => {
    _resetEmbedConcurrencyClampWarningForTest();
    const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(resolveEmbedConcurrency('postgres', undefined, {}, 2)).toBe(2);
      expect(err.mock.calls.filter(c => String(c[0]).includes('[embed]'))).toHaveLength(0);
    } finally {
      err.mockRestore();
    }
  });

  test('unchanged when the pool is large enough, on PGLite, and for a lower paced cap', () => {
    expect(resolveEmbedConcurrency('postgres', undefined, { GBRAIN_EMBED_CONCURRENCY: '8' }, 12)).toBe(8);
    expect(resolveEmbedConcurrency('pglite', undefined, {}, 2)).toBe(20);
    expect(resolveEmbedConcurrency('postgres', 4, {}, 12)).toBe(4);
    expect(resolveEmbedConcurrency('postgres', undefined, { GBRAIN_EMBED_CONCURRENCY: 'junk' }, 50)).toBe(20);
  });
});

describe('#9 single-pool paced admission diagnostics', () => {
  const pace = resolvePaceMode({ mode: 'balanced' });

  test('reports a binding actual pool without an explicit embed-worker setting, for every run', async () => {
    await withEnv({ GBRAIN_POOL_SIZE: '17' }, () => {
      const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const engine = { kind: 'postgres', getPoolDiagnostics: () => ({ poolMax: 2 }) };
        for (let run = 0; run < 2; run++) {
          expect(resolvePacedEmbedAdmission(engine, pace, { env: {} })).toEqual({ concurrency: 2, effectiveCap: 2, poolCapacity: 2 });
        }
        const lines = err.mock.calls.map(c => String(c[0])).filter(l => l.includes('[pace]'));
        expect(lines).toHaveLength(2);
        for (const line of lines) {
          expect(line).toContain('mode=balanced');
          expect(line).toContain('maxConcurrency=8');
          expect(line).toContain('poolCapacity=2');
          expect(line).toContain('effectiveCap=2');
          expect(line).toContain('GBRAIN_POOL_SIZE');
          expect(line).toMatch(/keep.*small pool/i);
        }
      } finally { err.mockRestore(); }
    });
  });

  test('reports known nonbinding capacity and an independent lower worker ceiling without blaming the pool', () => {
    const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(resolvePacedEmbedAdmission({ kind: 'postgres', getPoolDiagnostics: () => ({ poolMax: 17 }) }, pace, { env: {} }))
        .toEqual({ concurrency: 8, effectiveCap: 8, poolCapacity: 17 });
      expect(resolvePacedEmbedAdmission({ kind: 'postgres', getPoolDiagnostics: () => ({ poolMax: 2 }) }, pace,
        { env: { GBRAIN_EMBED_CONCURRENCY: '1' } })).toEqual({ concurrency: 1, effectiveCap: 1, poolCapacity: 2 });
      expect(err.mock.calls.filter(c => String(c[0]).includes('[pace]'))).toHaveLength(0);
    } finally { err.mockRestore(); }
  });

  test('unavailable, throwing or invalid diagnostics retain the configured worker guard without inventing pool capacity', async () => {
    await withEnv({ GBRAIN_POOL_SIZE: '2' }, () => {
      const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const engines = [
          { kind: 'postgres' },
          { kind: 'postgres', getPoolDiagnostics: () => null },
          { kind: 'postgres', getPoolDiagnostics: () => { throw new Error('diagnostics unavailable'); } },
          ...[null, NaN, Infinity, 0, -1, 0.5].map(poolMax => ({ kind: 'postgres', getPoolDiagnostics: () => ({ poolMax }) })),
        ];
        for (const engine of engines) {
          expect(resolvePacedEmbedAdmission(engine, pace, { env: {} })).toEqual({ concurrency: 2, effectiveCap: 2, poolCapacity: null });
        }
        expect(err.mock.calls.filter(c => String(c[0]).includes('[pace]'))).toHaveLength(0);
      } finally { err.mockRestore(); }
    });
  });

  test('a failed warning write is fail-open and does not change admitted workers', () => {
    const err = spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('stderr unavailable'); });
    try {
      expect(resolvePacedEmbedAdmission({ kind: 'postgres', getPoolDiagnostics: () => ({ poolMax: 2 }) }, pace, { env: {} }))
        .toEqual({ concurrency: 2, effectiveCap: 2, poolCapacity: 2 });
      expect(err.mock.calls).toHaveLength(1);
    } finally { err.mockRestore(); }
  });

  test('PGLite ignores Postgres diagnostics and retains its paced workers', () => {
    let probes = 0;
    const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(resolvePacedEmbedAdmission({ kind: 'pglite', getPoolDiagnostics: () => { probes++; return { poolMax: 2 }; } }, pace, { env: {} }))
        .toEqual({ concurrency: 8, effectiveCap: 8, poolCapacity: null });
      expect(probes).toBe(0);
      expect(err.mock.calls).toHaveLength(0);
    } finally { err.mockRestore(); }
  });
});
