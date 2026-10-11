/**
 * #6: `gbrain jobs prune --days 7` was accepted. `--days` is legal for SOME
 * jobs subcommand, so cli.ts's jobs-wide flag check passed it; prune's
 * parseFlag(args, '--older-than') then missed and the destructive 30-day
 * default ran. The mutating subcommands (prune, delete, cancel, retry) now
 * refuse any argument their parser would not consume — exit 1, nothing
 * deleted — while the documented forms keep working.
 *
 * Prune/delete cases seed a terminal job aged 60 days, which a default prune
 * (30d) WOULD delete, so "the job survives" proves the refusal happened
 * before any queue work rather than the window happening to miss it. The
 * cancel/retry cases seed a waiting/dead job the documented form DOES mutate
 * (pinned by the controls below), so "status unchanged" means refused.
 *
 * Serial: patches process.exit / console.error / console.log around runJobs.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { runJobs } from '../src/commands/jobs.ts';

const EXIT = '__test_process_exit__';

let engine: PGLiteEngine;
let queue: MinionQueue;
let stderr: string[];
let stdout: string[];
let originalExit: typeof process.exit;
let originalError: typeof console.error;
let originalLog: typeof console.log;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM minion_jobs`, []);
  stderr = [];
  stdout = [];
  originalExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`${EXIT}:${code ?? 0}`);
  }) as typeof process.exit;
  originalError = console.error;
  console.error = (...a: unknown[]) => { stderr.push(a.map(String).join(' ')); };
  originalLog = console.log;
  console.log = (...a: unknown[]) => { stdout.push(a.map(String).join(' ')); };
});

afterEach(() => {
  process.exit = originalExit;
  console.error = originalError;
  console.log = originalLog;
});

/** A completed job last touched 60 days ago — inside the default 30d prune window. */
async function seedOldCompletedJob(): Promise<number> {
  const job = await queue.add('sync', {});
  await engine.executeRaw(
    `UPDATE minion_jobs SET status = 'completed', finished_at = now() - interval '60 days',
            updated_at = now() - interval '60 days' WHERE id = $1`,
    [job.id],
  );
  return job.id;
}

/** A freshly queued job — `jobs cancel <id>` would cancel it. */
async function seedWaitingJob(): Promise<number> {
  return (await queue.add('sync', {})).id;
}

/** A dead job — `jobs retry <id>` would re-queue it. */
async function seedDeadJob(): Promise<number> {
  const job = await queue.add('sync', {});
  await engine.executeRaw(
    `UPDATE minion_jobs SET status = 'dead', finished_at = now() WHERE id = $1`,
    [job.id],
  );
  return job.id;
}

async function jobStatus(id: number): Promise<string | undefined> {
  return (await queue.getJob(id))?.status;
}

async function jobExists(id: number): Promise<boolean> {
  return (await queue.getJob(id)) !== null;
}

/** Runs `gbrain jobs <args>`; returns the exit code (0 when runJobs returned). */
async function run(args: string[]): Promise<number> {
  try {
    await runJobs(engine, args);
    return 0;
  } catch (e) {
    const m = /^__test_process_exit__:(\d+)$/.exec(e instanceof Error ? e.message : '');
    if (!m) throw e;
    return Number(m[1]);
  }
}

describe('jobs mutating subcommands refuse unconsumed arguments (#6)', () => {
  test('prune --days 7: exit 1, names the flag, prints usage, deletes nothing', async () => {
    const id = await seedOldCompletedJob();
    expect(await run(['prune', '--days', '7'])).toBe(1);
    const err = stderr.join('\n');
    expect(err).toContain('unknown flag --days');
    expect(err).toContain('Usage: gbrain jobs prune [--older-than 30d] [--dry-run]');
    expect(stdout.join('\n')).not.toContain('Pruned');
    expect(await jobExists(id)).toBe(true);
  });

  test('prune --older-than=7d: the = form parseFlag never reads is refused, nothing deleted', async () => {
    const id = await seedOldCompletedJob();
    expect(await run(['prune', '--older-than=7d'])).toBe(1);
    expect(stderr.join('\n')).toContain('unknown flag --older-than=7d');
    expect(await jobExists(id)).toBe(true);
  });

  test('prune --older-than with no value: refused instead of falling back to 30d', async () => {
    const id = await seedOldCompletedJob();
    expect(await run(['prune', '--older-than'])).toBe(1);
    expect(stderr.join('\n')).toContain('--older-than requires a value');
    expect(await jobExists(id)).toBe(true);
  });

  test('prune 7: a stray positional is refused, nothing deleted', async () => {
    const id = await seedOldCompletedJob();
    expect(await run(['prune', '7'])).toBe(1);
    expect(stderr.join('\n')).toContain('unexpected argument 7');
    expect(await jobExists(id)).toBe(true);
  });

  test('delete <id> --force: unknown flag refused, job kept', async () => {
    const id = await seedOldCompletedJob();
    expect(await run(['delete', String(id), '--force'])).toBe(1);
    expect(stderr.join('\n')).toContain('unknown flag --force');
    expect(await jobExists(id)).toBe(true);
  });

  test('prune --older-than 7d --older-than --days: a repeated value flag is refused, nothing deleted', async () => {
    const id = await seedOldCompletedJob();
    expect(await run(['prune', '--older-than', '7d', '--older-than', '--days'])).toBe(1);
    expect(stderr.join('\n')).toContain('--older-than given more than once');
    expect(stdout.join('\n')).not.toContain('Pruned');
    expect(await jobExists(id)).toBe(true);
  });

  test('prune --older-than 7d --older-than 1d: conflicting windows are refused, not first-wins', async () => {
    const id = await seedOldCompletedJob();
    expect(await run(['prune', '--older-than', '7d', '--older-than', '1d'])).toBe(1);
    expect(stderr.join('\n')).toContain('--older-than given more than once');
    expect(await jobExists(id)).toBe(true);
  });

  test('cancel <id> <extra>: refused, and a cancellable job stays waiting', async () => {
    const id = await seedWaitingJob();
    expect(await run(['cancel', String(id), '99'])).toBe(1);
    expect(stderr.join('\n')).toContain(`unexpected argument 99 for 'gbrain jobs cancel'`);
    expect(await jobStatus(id)).toBe('waiting');
  });

  test('retry <id> <extra>: refused, and a retryable dead job stays dead', async () => {
    const id = await seedDeadJob();
    expect(await run(['retry', String(id), '99'])).toBe(1);
    expect(stderr.join('\n')).toContain(`unexpected argument 99 for 'gbrain jobs retry'`);
    expect(await jobStatus(id)).toBe('dead');
  });
});

describe('documented forms keep working (#6)', () => {
  test('prune --older-than 7d --dry-run counts without deleting', async () => {
    const id = await seedOldCompletedJob();
    expect(await run(['prune', '--older-than', '7d', '--dry-run'])).toBe(0);
    expect(stdout.join('\n')).toContain('[dry-run] Would prune 1 jobs older than 7 days.');
    expect(await jobExists(id)).toBe(true);
  });

  test('prune --older-than 7 deletes the aged job', async () => {
    const id = await seedOldCompletedJob();
    expect(await run(['prune', '--older-than', '7'])).toBe(0);
    expect(stdout.join('\n')).toContain('Pruned 1 jobs older than 7 days.');
    expect(await jobExists(id)).toBe(false);
  });

  test('bare prune uses the 30d default', async () => {
    const id = await seedOldCompletedJob();
    expect(await run(['prune'])).toBe(0);
    expect(stdout.join('\n')).toContain('Pruned 1 jobs older than 30 days.');
    expect(await jobExists(id)).toBe(false);
  });

  test('delete <id> deletes a terminal job', async () => {
    const id = await seedOldCompletedJob();
    expect(await run(['delete', String(id)])).toBe(0);
    expect(await jobExists(id)).toBe(false);
  });

  // Controls for the cancel/retry refusal cases: the same fixtures DO mutate
  // when the documented form runs, so "status unchanged" above is the refusal.
  test('cancel <id> cancels the waiting fixture', async () => {
    const id = await seedWaitingJob();
    expect(await run(['cancel', String(id)])).toBe(0);
    expect(await jobStatus(id)).toBe('cancelled');
  });

  test('retry <id> re-queues the dead fixture', async () => {
    const id = await seedDeadJob();
    expect(await run(['retry', String(id)])).toBe(0);
    expect(await jobStatus(id)).toBe('waiting');
  });
});
