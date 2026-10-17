/**
 * A dependent accepted while retention waits on its owner's row lock must keep
 * that owner. A one-statement DELETE sees the pre-lock snapshot and severs the
 * accepted dependency. Real queue.add transactions and PostgreSQL lock evidence
 * establish the interleaving; no sleeps or production-only testing seam.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import type { MinionJob } from '../../src/core/minions/types.ts';
import { runCycle, type CycleReport } from '../../src/core/cycle.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { waitFor } from '../helpers/wait-for.ts';

const databaseUrl = requirePostgresTestDatabase();

describe('PostgreSQL cycle retention racing accepted dependents', () => {
  let engine: BrainEngine;
  let queue: MinionQueue;
  let close: () => Promise<void>;
  let home: string;

  beforeAll(async () => {
    const scratch = join(import.meta.dir, '..', '.cache');
    mkdirSync(scratch, { recursive: true });
    home = mkdtempSync(join(scratch, 'retention-race-'));
    const isolated = await withEnv({ GBRAIN_HOME: home }, () => isolatedPersistencePostgres(databaseUrl));
    engine = isolated.engine;
    close = isolated.close;
    queue = new MinionQueue(engine);
  }, 120_000);

  afterAll(async () => {
    await close?.();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await engine.executeRaw('TRUNCATE minion_jobs, gbrain_cycle_locks RESTART IDENTITY CASCADE');
  });

  for (const reference of ['parent_job_id', 'private_queue_owner_job_id'] as const) {
    test(`accepted ${reference} survives a purge that waits for its owner`, async () => {
      const owner = await queue.add('race-owner', {});
      expect((await queue.claim('owner', 30_000, 'default', ['race-owner']))?.id).toBe(owner.id);
      expect((await queue.completeJob(owner.id, 'owner', { done: true }))?.status).toBe('completed');
      await engine.executeRaw("UPDATE minion_jobs SET created_at = now() - interval '40 days', started_at = now() - interval '40 days', finished_at = now() - interval '40 days', updated_at = now() - interval '40 days' WHERE id = $1", [owner.id]);

      let release!: () => void;
      const commitGate = new Promise<void>(resolve => { release = resolve; });
      let child: MinionJob | undefined;
      let blockerPid = 0;
      let submissionError: unknown;
      let purgeError: unknown;
      let report: CycleReport | undefined;
      let purging: Promise<void> | undefined;
      const submitting = engine.transaction(async tx => {
        const [row] = await tx.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        blockerPid = row!.pid;
        child = await new MinionQueue(tx).add('race-dependent', {}, { [reference]: owner.id });
        await commitGate;
      }).catch(error => { submissionError = error; });

      try {
        await waitFor(() => {
          if (submissionError) throw submissionError;
          return child !== undefined;
        }, { timeoutMs: 5_000, label: 'real queue.add published its dependent inside the held transaction' });
        purging = withEnv({ GBRAIN_HOME: home }, () => runCycle(engine, { brainDir: null, phases: ['purge'] }))
          .then(value => { report = value; }, error => { purgeError = error; });
        await waitFor(async () => {
          if (purgeError) throw purgeError;
          const rows = await engine.executeRaw<{ blocked: number }>(`SELECT count(*)::int AS blocked FROM pg_stat_activity
            WHERE $1::int = ANY(pg_blocking_pids(pid)) AND query LIKE '%minion_jobs%'`, [blockerPid], { timeoutMs: 2_000 });
          return rows[0]!.blocked > 0;
        }, { timeoutMs: 5_000, label: 'retention is blocked on the accepted dependent owner transaction' });
      } finally {
        release();
        await submitting;
        await purging;
      }

      expect(submissionError).toBeUndefined();
      expect(purgeError).toBeUndefined();
      expect((await queue.getJob(child!.id))?.[reference]).toBe(owner.id);
      expect((await queue.getJob(child!.id))?.status).toBe('waiting');
      expect((await queue.getJob(owner.id))?.status).toBe('completed');
      const phase = report!.phases.find(p => p.phase === 'purge');
      expect(phase?.status).toBe('ok');
      expect(phase?.details.purged_jobs_count).toBe(0);
    }, 60_000);
  }

  for (const ownerKind of ['parent', 'private-queue owner'] as const) {
    for (const reference of ['parent_job_id', 'private_queue_owner_job_id'] as const) {
      test(`accepted retryJob ${reference} keeps its ${ownerKind} after every purge lock wait`, async () => {
        const name = ownerKind === 'parent' ? 'subagent_aggregator' : 'autopilot-global-maintenance';
        const owner = await queue.add(name, {}, {}, { allowProtectedSubmit: true });
        const childQueue = ownerKind === 'parent' ? 'default' : 'dream-inline-retention-retry';
        const child = await queue.add('retry-dependent', {}, { [reference]: owner.id, queue: childQueue, on_child_fail: 'continue', max_attempts: 1 });
        expect((await queue.claim('child', 30_000, childQueue, [child.name]))?.id).toBe(child.id);
        const terminal = ownerKind === 'parent' ? 'failed' : 'dead';
        expect((await queue.failJob(child.id, 'child', 'fixture failure', terminal))?.status).toBe(terminal);
        expect((await queue.claim('owner', 30_000, 'default', [name]))?.id).toBe(owner.id);
        expect((await queue.completeJob(owner.id, 'owner', { children_finished: true }))?.status).toBe('completed');
        await engine.executeRaw("UPDATE minion_jobs SET created_at = now() - interval '40 days', started_at = now() - interval '40 days', finished_at = now() - interval '40 days', updated_at = now() - interval '40 days' WHERE id = $1", [owner.id]);

        let release!: () => void;
        const commitGate = new Promise<void>(resolve => { release = resolve; });
        let retried: MinionJob | null | undefined;
        let blockerPid = 0;
        let retryError: unknown;
        let purgeError: unknown;
        let report: CycleReport | undefined;
        let purging: Promise<void> | undefined;
        const retrying = engine.transaction(async tx => {
          const [row] = await tx.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          blockerPid = row!.pid;
          retried = await new MinionQueue(tx).retryJob(child.id);
          await commitGate;
        }).catch(error => { retryError = error; });

        try {
          await waitFor(() => {
            if (retryError) throw retryError;
            return retried !== undefined;
          }, { timeoutMs: 5_000, label: 'real retryJob returned its waiting row inside the held transaction' });
          expect(retried?.status).toBe('waiting');
          expect(retried?.[reference]).toBe(owner.id);
          purging = withEnv({ GBRAIN_HOME: home }, () => runCycle(engine, { brainDir: null, phases: ['purge'] }))
            .then(value => { report = value; }, error => { purgeError = error; });
          await waitFor(async () => {
            if (purgeError) throw purgeError;
            const rows = await engine.executeRaw<{ blocked: number }>(`SELECT count(*)::int AS blocked FROM pg_stat_activity
              WHERE $1::int = ANY(pg_blocking_pids(pid)) AND query LIKE '%minion_jobs%'`, [blockerPid], { timeoutMs: 2_000 });
            return rows[0]!.blocked > 0;
          }, { timeoutMs: 5_000, label: 'purge is blocked by the held retryJob publication' });
        } finally {
          release();
          await retrying;
          await purging;
        }

        expect(retryError).toBeUndefined();
        expect(purgeError).toBeUndefined();
        expect((await queue.getJob(child.id))?.[reference]).toBe(owner.id);
        expect((await queue.getJob(child.id))?.status).toBe('waiting');
        expect((await queue.getJob(owner.id))?.status).toBe('completed');
        const phase = report!.phases.find(p => p.phase === 'purge');
        expect(phase?.status).toBe('ok');
        expect(phase?.details.purged_jobs_count).toBe(0);
      }, 60_000);
    }
  }
});
