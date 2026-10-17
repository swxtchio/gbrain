import type { BrainEngine } from '../engine.ts';
import { MinionQueue } from '../minions/queue.ts';

export const COMPLETED_JOB_RETENTION_KEY = 'minions.completed_retention_days';
export const DEFAULT_COMPLETED_JOB_RETENTION_DAYS = 14;

export async function pruneCompletedJobsForCycle(engine: BrainEngine): Promise<{ count: number; retentionDays: number }> {
  const raw = await engine.getConfig(COMPLETED_JOB_RETENTION_KEY);
  const retentionDays = raw === null ? DEFAULT_COMPLETED_JOB_RETENTION_DAYS : Number(raw);
  const olderThan = new Date(Date.now() - retentionDays * 86_400_000);
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0 || !Number.isFinite(olderThan.getTime())) {
    throw new Error(`${COMPLETED_JOB_RETENTION_KEY} must be positive whole days with a representable cutoff; set it with gbrain config set ${COMPLETED_JOB_RETENTION_KEY} <days>`);
  }
  const count = await new MinionQueue(engine).prune({ olderThan, status: ['completed'] });
  return { count, retentionDays };
}
