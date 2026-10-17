/**
 * Scheduled purge must reclaim completed history without manual jobs prune.
 * Queue-only tests never exercised this cycle dispatch. Removing the automatic
 * invocation, configured cutoff, or dependency protection must fail here.
 * Uses real queue producers and engines; no new production testing seam.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { buildJobContext } from '../src/core/minions/job-context.ts';
import { subagentAggregatorHandler } from '../src/core/minions/handlers/subagent-aggregator.ts';
import { runCycle } from '../src/core/cycle.ts';
import { discoverTranscripts } from '../src/core/cycle/transcript-discovery.ts';
import { partitionCompletedSynthesis } from '../src/core/cycle/synthesize-completion.ts';
import { resetPgliteStateNarrow } from './helpers/reset-pglite.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const retentionKey = 'minions.completed_retention_days';

for (const backend of testBackends()) {
  describe(`cycle completed-job retention (${backend})`, () => {
    let engine: BrainEngine;
    let queue: MinionQueue;
    let home: string;
    let closePostgres: (() => Promise<void>) | undefined;

    beforeAll(async () => {
      const scratch = join(import.meta.dir, '.cache');
      mkdirSync(scratch, { recursive: true });
      home = mkdtempSync(join(scratch, 'job-retention-'));
      await withEnv({ GBRAIN_HOME: home }, async () => {
        if (backend === 'pglite') {
          const local = new PGLiteEngine();
          await local.connect({});
          await local.initSchema();
          engine = local;
        } else {
          const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
          engine = isolated.engine;
          closePostgres = isolated.close;
        }
        queue = new MinionQueue(engine);
      });
    }, 120_000);

    afterAll(async () => {
      if (closePostgres) await closePostgres();
      else await engine?.disconnect();
      if (home) rmSync(home, { recursive: true, force: true });
    });

    beforeEach(async () => {
      await resetPgliteStateNarrow(engine, ['minion_jobs', 'dream_synthesis_completions', 'gbrain_cycle_locks']);
      await engine.executeRaw('DELETE FROM config WHERE key = $1', [retentionKey]);
    });

    const complete = async (name = 'retention-example', data = {}, opts = {}) => {
      const job = await queue.add(name, data, opts, { allowProtectedSubmit: true });
      const token = `child-${job.id}`;
      const claimed = await queue.claim(token, 30_000, job.queue, [name]);
      expect(claimed?.id).toBe(job.id);
      const result = { output: `outcome-${job.id}` };
      const done = await queue.completeJob(job.id, token, result);
      expect(done?.finished_at).not.toBeNull();
      return { job: done!, result };
    };
    const age = (id: number, days: number, timestamp: 'finished_at' | 'created_at' | 'updated_at' = 'finished_at') =>
      engine.executeRaw(`UPDATE minion_jobs SET ${timestamp} = now() - ($2 * interval '1 day')
        ${timestamp === 'finished_at' ? ", created_at = LEAST(created_at, now() - ($2 * interval '1 day')), started_at = LEAST(started_at, now() - ($2 * interval '1 day'))" : ''}
        WHERE id = $1`, [id, days]);
    const purge = async (dryRun = false) => {
      const report = await withEnv({ GBRAIN_HOME: home }, () => runCycle(engine, { brainDir: null, phases: ['purge'], dryRun }));
      const phase = report.phases.find(p => p.phase === 'purge');
      expect(phase).toBeDefined();
      return phase!;
    };

    test('default retention converges, preserves recent completion and execution, and dry-run changes nothing', async () => {
      const expired = await complete();
      const recent = await complete();
      const slow = await complete();
      await age(expired.job.id, 15);
      await age(recent.job.id, 13);
      await age(slow.job.id, 40, 'created_at');

      const waiting = await queue.add('waiting-example', {});
      const active = await queue.add('active-example', {});
      await queue.claim('active', 3_600_000, 'default', ['active-example']);
      const delayed = await queue.add('delayed-example', {}, { delay: 3_600_000 });
      const paused = await queue.add('paused-example', {});
      await queue.pauseJob(paused.id);
      const parent = await queue.add('parent-example', {});
      const child = await queue.add('pending-child', {}, { parent_job_id: parent.id });
      const dead = await queue.add('dead-example', {}, { max_attempts: 1 });
      await queue.claim('dead', 30_000, 'default', ['dead-example']);
      await queue.failJob(dead.id, 'dead', 'retryable failure', 'dead');
      const failed = await queue.add('failed-example', {}, { max_attempts: 1 });
      await queue.claim('failed', 30_000, 'default', ['failed-example']);
      await queue.failJob(failed.id, 'failed', 'retryable failure', 'failed');
      const cancelled = await queue.add('cancelled-example', {});
      await queue.cancelJob(cancelled.id);
      const kept = [waiting.id, active.id, delayed.id, paused.id, parent.id, child.id, dead.id, failed.id, cancelled.id];
      for (const id of kept) await age(id, 40, 'updated_at');

      const snapshot = await engine.executeRaw('SELECT * FROM minion_jobs ORDER BY id');
      const archive = await engine.executeRaw('SELECT * FROM dream_synthesis_completions');
      expect((await purge(true)).details.dry_run).toBe(true);
      expect(await engine.executeRaw('SELECT * FROM minion_jobs ORDER BY id')).toEqual(snapshot);
      expect(await engine.executeRaw('SELECT * FROM dream_synthesis_completions')).toEqual(archive);

      const first = await purge();
      expect(await queue.getJob(expired.job.id)).toBeNull();
      expect(first.status).toBe('ok');
      expect(first.details.purged_jobs_count).toBe(1);
      expect(first.details.completed_job_retention_days).toBe(14);
      expect(first.summary).toContain('1 completed job(s)');
      expect(first.details.purged_pages_count).toBe(0);
      expect(first.details.purged_sources_count).toBe(0);
      expect((await queue.getJob(recent.job.id))?.result).toEqual(recent.result);
      expect((await queue.getJob(slow.job.id))?.result).toEqual(slow.result);
      expect((await queue.getJob(parent.id))?.status).toBe('waiting-children');
      expect((await queue.getJob(active.id))?.lock_token).toBe('active');
      for (const id of kept) expect(await queue.getJob(id)).not.toBeNull();
      expect((await queue.retryJob(dead.id))?.status).toBe('waiting');
      expect((await queue.retryJob(failed.id))?.status).toBe('waiting');

      const clean = await purge();
      expect(clean.status).toBe('ok');
      expect(clean.details.purged_jobs_count).toBe(0);
      expect(clean.summary).toContain('0 completed job(s)');
      await age(recent.job.id, 15);
      expect((await purge()).details.purged_jobs_count).toBe(1);
      expect(await queue.getJob(recent.job.id)).toBeNull();
      expect(await queue.getJob(slow.job.id)).not.toBeNull();
    }, 60_000);

    test('operator retention changes which completed jobs survive on each purge', async () => {
      const old = await complete();
      const recent = await complete();
      await age(old.job.id, 8);
      await age(recent.job.id, 6);
      await engine.setConfig(retentionKey, '7');
      const shorter = await purge();
      expect(await queue.getJob(old.job.id)).toBeNull();
      expect(await queue.getJob(recent.job.id)).not.toBeNull();
      expect(shorter.details.purged_jobs_count).toBe(1);
      expect(shorter.details.completed_job_retention_days).toBe(7);
      await engine.setConfig(retentionKey, '30');
      await age(recent.job.id, 20);
      expect((await purge()).details.purged_jobs_count).toBe(0);
      expect(await queue.getJob(recent.job.id)).not.toBeNull();
      await age(recent.job.id, 31);
      expect((await purge()).details.purged_jobs_count).toBe(1);
      expect(await queue.getJob(recent.job.id)).toBeNull();
    }, 60_000);

    test('automatic pruning archives synthesis identity and the surviving parent consumes its published child outcome', async () => {
      const corpus = join(home, 'corpus');
      mkdirSync(corpus, { recursive: true });
      writeFileSync(join(corpus, '2026-07-01-example.txt'), 'Example completed conversation.\n'.repeat(100));
      const [transcript] = await discoverTranscripts({ corpusDir: corpus, minChars: 1 });
      expect(transcript).toBeDefined();
      const key = `dream:synth-v2:default:filename:2026-07-01-example.txt:${transcript!.contentHash.slice(0, 16)}`;
      const parent = await queue.add('subagent_aggregator', {}, {}, { allowProtectedSubmit: true });
      const done = await complete('subagent', { source_id: 'default' }, { parent_job_id: parent.id, idempotency_key: key });
      await engine.executeRaw("UPDATE minion_jobs SET data = jsonb_set(data, '{children_ids}', $1::text::jsonb) WHERE id = $2", [JSON.stringify([done.job.id]), parent.id]);
      await age(done.job.id, 15);
      const phase = await purge();
      expect(await queue.getJob(done.job.id)).toBeNull();
      expect(phase.details.purged_jobs_count).toBe(1);
      const archived = await engine.executeRaw<{ source_id: string; idempotency_key: string }>('SELECT source_id, idempotency_key FROM dream_synthesis_completions');
      expect(archived).toEqual([{ source_id: 'default', idempotency_key: key }]);
      const partition = await partitionCompletedSynthesis(engine, [transcript!], 'default', null, false);
      expect(partition.completed.has(transcript!.filePath)).toBe(true);

      const claimed = await queue.claim('parent', 30_000, 'default', ['subagent_aggregator']);
      expect(claimed?.id).toBe(parent.id);
      const signal = new AbortController().signal;
      const result = await subagentAggregatorHandler(buildJobContext(engine, queue, claimed!, 'parent', signal, signal));
      expect(result.children).toEqual([{ child_id: done.job.id, job_name: 'subagent', outcome: 'complete', error: null, result: done.result }]);
      expect((await queue.completeJob(parent.id, 'parent', { children: result.children }))?.status).toBe('completed');
    }, 60_000);

    test('expired completed parents and private-queue owners survive until outstanding children finish', async () => {
      const parent = await complete();
      const child = await queue.add('outstanding-example', {}, { parent_job_id: parent.job.id });
      const owner = await complete();
      const owned = await queue.add('owned-example', {}, { private_queue_owner_job_id: owner.job.id });
      await age(parent.job.id, 15);
      await age(owner.job.id, 15);
      const phase = await purge();
      expect((await queue.getJob(child.id))?.parent_job_id).toBe(parent.job.id);
      expect((await queue.getJob(owned.id))?.private_queue_owner_job_id).toBe(owner.job.id);
      expect(await queue.getJob(parent.job.id)).not.toBeNull();
      expect(await queue.getJob(owner.job.id)).not.toBeNull();
      expect(phase.details.purged_jobs_count).toBe(0);
      for (const job of [child, owned]) {
        const claimed = await queue.claim(`finish-${job.id}`, 30_000, 'default', [job.name]);
        expect(claimed?.id).toBe(job.id);
        await queue.completeJob(job.id, `finish-${job.id}`, { done: true });
      }
      expect((await purge()).details.purged_jobs_count).toBe(2);
      expect(await queue.getJob(parent.job.id)).toBeNull();
      expect(await queue.getJob(owner.job.id)).toBeNull();
      expect((await queue.getJob(child.id))?.status).toBe('completed');
      expect((await queue.getJob(owned.id))?.status).toBe('completed');
    }, 60_000);

    test('cleanup SQL failure is a failed phase and leaves completed history intact', async () => {
      const done = await complete();
      await age(done.job.id, 15);
      const execute = engine.executeRaw;
      const boundExecute = execute.bind(engine);
      engine.executeRaw = async <T>(...args: Parameters<BrainEngine['executeRaw']>): Promise<T[]> => {
        const [sql] = args;
        if (sql.includes('DELETE FROM minion_jobs') && sql.includes('WITH pruned')) throw new Error('retention cleanup unavailable');
        return boundExecute<T>(...args);
      };
      try {
        const result = await purge();
        expect(result.status).toBe('fail');
        expect(result.error?.message).toContain('retention cleanup unavailable');
        expect(result.details.purged_jobs_count).toBeUndefined();
        expect(await queue.getJob(done.job.id)).not.toBeNull();
      } finally {
        engine.executeRaw = execute;
      }
    }, 60_000);
  });
}
