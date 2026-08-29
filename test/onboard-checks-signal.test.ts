/**
 * SWX — `runAllOnboardChecks` forwards its AbortSignal all the way to the
 * engine, so a caller that bounds the phase cancels the in-flight statements
 * instead of abandoning them.
 *
 * Round-1 review (codex 3 / claude 3, blocking): the doctor bound raced a bare
 * timer with no signal, so a wedged onboard query kept running — and kept its
 * pooler slot — after the WARN was emitted. The whole deploy/local-http design
 * exists because the session pooler caps at 15 clients, so that trades a wedge
 * for slow exhaustion of the exact resource being rationed.
 * `src/core/onboard/checks.ts` documents the required shape verbatim ("Per
 * A20: callers can race this against an AbortSignal-bound timer"), and
 * `PostgresEngine#runUnsafe` already implements real cancellation via
 * postgres.js `.cancel()` plus an already-aborted short-circuit — the signal
 * just never reached it.
 *
 * SCOPE of this file, stated so its name is not read as more: it proves the
 * signal ARRIVES at `engine.executeRaw`, which is the seam the fork's change
 * owns. It does not observe `.cancel()` landing on a live server or a pool
 * slot being released — that is upstream's code, needs a live Postgres and a
 * long-running statement, and upstream itself pins it only by source-text
 * guard (test/connection-resilience.test.ts). PG protocol cancellation is
 * best-effort in any case.
 *
 * MUST stay a plain (non-`.serial`) test file with no `mock.module` of its
 * own, and MUST NOT be merged into `doctor-onboard-timeout.serial.test.ts`.
 * That sibling mocks this exact module path to simulate the hang, and
 * `mock.module` leaks for the life of the PROCESS — `mock.restore()` does not
 * undo it (verified on bun 1.3.11 in both file orders, and with both a static
 * binding and a re-`import()`). The repo's contract is what keeps them apart:
 * scripts/run-serial-tests.sh gives every `*.serial.test.ts` file its own bun
 * process precisely because "files in the same process share the module
 * registry", while plain files run in the parallel shards. Same-process is the
 * one arrangement in which these assertions cannot hold.
 */

import { describe, test, expect } from 'bun:test';

import { runAllOnboardChecks } from '../src/core/onboard/checks.ts';

/** Records the opts every executeRaw call receives; answers count queries with 0. */
function recordingEngine(): { engine: unknown; seen: Array<AbortSignal | undefined> } {
  const seen: Array<AbortSignal | undefined> = [];
  const engine = {
    executeRaw: async (_sql: string, _params?: unknown[], opts?: { signal?: AbortSignal }) => {
      seen.push(opts?.signal);
      return { rows: [{ count: 0, sample_size: 0, matched: 0 }] };
    },
    getConfig: async () => null,
  };
  return { engine, seen };
}

describe('SWX: onboard checks thread cancellation to the engine', () => {
  test('every counting query receives the caller\'s signal', async () => {
    const { engine, seen } = recordingEngine();
    const controller = new AbortController();

    await runAllOnboardChecks(engine as never, { signal: controller.signal });

    // Without threading these are all undefined: the signal stops at the
    // aggregate and the queries never learn they were abandoned.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((sig) => sig === controller.signal).length).toBe(seen.length);
  });

  test('no signal supplied → the engine sees none (upstream callers unchanged)', async () => {
    const { engine, seen } = recordingEngine();

    await runAllOnboardChecks(engine as never);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((sig) => sig === undefined)).toBe(true);
  });

  test('an engine that REJECTS on an aborted signal still yields a full result set', async () => {
    // Round-2 review: the earlier version of this case used an engine that
    // resolved unconditionally and never looked at the signal, so it passed
    // verbatim with safeCount's catch deleted — it proved nothing. This engine
    // behaves the way a real one does under cancellation: PostgresEngine's
    // runUnsafe throws DOMException('aborted','AbortError') when the signal is
    // already aborted, before any round-trip. What is asserted is that the
    // bounded caller still gets a renderable check list rather than an
    // exception, which is what lets doctor's WARN path exist at all.
    const engine = {
      executeRaw: async (_sql: string, _params?: unknown[], opts?: { signal?: AbortSignal }) => {
        if (opts?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return { rows: [{ count: 0, sample_size: 0, matched: 0 }] };
      },
      getConfig: async () => null,
    };
    const controller = new AbortController();
    controller.abort();

    const results = await runAllOnboardChecks(engine as never, { signal: controller.signal });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.check.name).toBeTruthy();
  });
});
