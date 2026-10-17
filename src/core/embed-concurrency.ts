import { resolvePoolSize } from './db.ts';
import type { ResolvedPaceKnobs } from './pace-mode.ts';
import type { PaceSnapshot } from './db-pacer.ts';

let warnedEmbedConcurrencyClamp = false;

/** Test seam: let the clamp warning print again. */
export function _resetEmbedConcurrencyClampWarningForTest(): void {
  warnedEmbedConcurrencyClamp = false;
}

/**
 * Parallel page-embedding workers: GBRAIN_EMBED_CONCURRENCY (default 20),
 * lowered to a paced run's cap, and on Postgres never above the client pool
 * (#5183). Each worker holds a connection across its read and upsert, so more
 * workers than pool connections left the run waiting on itself: no progress,
 * no error, 0% CPU. An explicit setting that gets lowered is reported once
 * per process; the default is lowered silently.
 */
export function resolveEmbedConcurrency(
  engineKind: string,
  paceMaxConcurrency?: number,
  env: Record<string, string | undefined> = process.env,
  poolSize: number = resolvePoolSize(),
): number {
  const explicit = env.GBRAIN_EMBED_CONCURRENCY;
  const parsed = parseInt(explicit || '20', 10);
  const base = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
  const paced = paceMaxConcurrency ? Math.min(base, paceMaxConcurrency) : base;
  if (engineKind !== 'postgres' || paced <= poolSize) return paced;
  const clamped = Math.max(1, poolSize);
  if (explicit && !warnedEmbedConcurrencyClamp) {
    warnedEmbedConcurrencyClamp = true;
    process.stderr.write(
      `[embed] GBRAIN_EMBED_CONCURRENCY=${explicit} is above the connection pool (${poolSize}); using ${clamped} workers. ` +
      `Raise GBRAIN_POOL_SIZE or lower GBRAIN_EMBED_CONCURRENCY to match.\n`,
    );
  }
  return clamped;
}

export interface PacedEmbedAdmission {
  concurrency: number;
  /** Admission ceiling, including the configured-worker fallback when pool diagnostics are unavailable; not measured utilization. */
  effectiveCap: number;
  poolCapacity: number | null;
}

/** Single-pool admission only: sync's shared permit spans separate worker pools. */
export function resolvePacedEmbedAdmission(
  engine: { kind: string; getPoolDiagnostics?: () => { poolMax: number | null } | null },
  pace: ResolvedPaceKnobs,
  opts: { workerConcurrency?: number; env?: Record<string, string | undefined> } = {},
): PacedEmbedAdmission {
  const env = opts.env ?? process.env;
  let poolCapacity: number | null = null;
  if (engine.kind === 'postgres') {
    try {
      const pool = engine.getPoolDiagnostics?.()?.poolMax;
      if (typeof pool === 'number' && Number.isInteger(pool) && pool > 0) poolCapacity = pool;
    } catch { /* optional diagnostics must never stop embedding */ }
  }
  const requested = Math.max(1, Math.floor(pace.maxConcurrency));
  const workerCeiling = opts.workerConcurrency ?? resolveEmbedConcurrency('pglite', requested, env);
  const concurrency = opts.workerConcurrency ?? resolveEmbedConcurrency(engine.kind, requested, env, poolCapacity ?? resolvePoolSize());
  const effectiveCap = Math.min(concurrency, requested, poolCapacity ?? Infinity);
  if (pace.enabled && poolCapacity !== null && poolCapacity < Math.min(requested, workerCeiling)) {
    try {
      process.stderr.write(
        `[pace] mode=${pace.resolved_mode} maxConcurrency=${requested} poolCapacity=${poolCapacity} effectiveCap=${effectiveCap}: ` +
        `the connection pool limits attainable concurrency. Keep the small pool to retain your connection-limit guard, ` +
        `or deliberately raise GBRAIN_POOL_SIZE for this run if your connection budget allows it. This is a ceiling, not measured parallelism.\n`,
      );
    } catch { /* diagnostic output must never stop embedding */ }
  }
  return { concurrency, effectiveCap, poolCapacity };
}

export function embedPacingTelemetry(snapshot: PaceSnapshot, admission: PacedEmbedAdmission) {
  return {
    maxConcurrency: snapshot.maxConcurrency,
    effectiveCap: admission.effectiveCap,
    poolCapacity: admission.poolCapacity,
    samples: snapshot.sampleCount,
    ewmaMs: snapshot.ewmaMs,
    totalSleptMs: snapshot.totalSleptMs,
    sleeps: snapshot.sleepCount,
    maxWaiters: snapshot.maxWaiters,
  };
}

/**
 * Worker count for an embed-stale drain called without one (#5902): the
 * embed-backfill job unpaced, and the remediation embed step. Each worker
 * holds a connection across its read and upsert, and a worker job shares the
 * engine's pool with the read-lane health probe, so the default leaves half
 * of the engine's real pool (`getPoolDiagnostics().poolMax`, a worker's
 * instance pool included) free: `min(20, max(1, floor(poolMax / 2)))`, or 20
 * without a pool (PGLite). An explicit GBRAIN_EMBED_CONCURRENCY keeps the
 * full-pool clamp and its warning; lowering the default stays silent.
 */
export function resolveStaleEmbedConcurrency(
  engine: { kind: string; getPoolDiagnostics?: () => { poolMax: number | null } | null },
  env: Record<string, string | undefined> = process.env,
): number {
  let poolMax: number | null | undefined;
  try {
    poolMax = engine.getPoolDiagnostics?.()?.poolMax;
  } catch {
    poolMax = null;
  }
  const pool = typeof poolMax === 'number' && poolMax > 0 ? poolMax : null;
  if (env.GBRAIN_EMBED_CONCURRENCY) return resolveEmbedConcurrency(engine.kind, undefined, env, pool ?? resolvePoolSize());
  return pool === null ? 20 : Math.min(20, Math.max(1, Math.floor(pool / 2)));
}
