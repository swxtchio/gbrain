/**
 * SWX port — bounded onboard phase for `gbrain doctor`.
 *
 * Peeled out of the doctor.ts façade (module-size ratchet: doctor.ts sits
 * exactly at its committed ceiling in scripts/module-size-limits.tsv, and the
 * façade rule sends new code to the module dir regardless). Re-port of the
 * fork commit 3eb9aa4a onto current master.
 *
 * Why the bound exists: the onboard checks wedge forever on some database
 * topologies — observed and A/B-confirmed on the Supabase TRANSACTION pooler
 * (:6543) against the live fleet brain (completes instantly on the :5432
 * session pooler, hangs on :6543; reproduced on v0.42.58). Because every
 * check's result is flushed only after this final phase, a hung onboard
 * phase takes the entire `doctor` run down with it. The bound degrades the
 * phase to a WARN so the other 60+ checks always render. General hardening:
 * one slow or pooler-incompatible check can no longer wedge doctor.
 *
 * Tune/disable via GBRAIN_DOCTOR_ONBOARD_TIMEOUT_MS (default 15000;
 * 0/off = wait unboundedly).
 */

import type { BrainEngine } from '../../core/engine.ts';
import type { Check } from '../doctor.ts';

export async function runOnboardChecksBounded(engine: BrainEngine): Promise<Check[]> {
  const { runAllOnboardChecks } = await import('../../core/onboard/checks.ts');
  const timeoutRaw = process.env.GBRAIN_DOCTOR_ONBOARD_TIMEOUT_MS;
  const timeoutMs =
    timeoutRaw === '0' || timeoutRaw === 'off'
      ? 0
      : Number.isFinite(Number(timeoutRaw)) && Number(timeoutRaw) > 0
        ? Number(timeoutRaw)
        : 15000;
  // Round-1 review: racing a timer without cancelling was a wedge traded for
  // a slow leak. The abandoned query keeps its pooler slot, and the whole
  // deploy/local-http design exists because the session pooler caps at 15
  // clients — so a doctor run that "completes" by walking away from its own
  // queries eats the exact resource being rationed. The controller aborts when
  // the timer wins and `runAllOnboardChecks` forwards the signal to every
  // counting query (see its doc comment for the two steps that take no signal).
  //
  // What is proven by tests, and what is not: the fork's tests cover this
  // wrapper handing down a signal and firing it, and the signal arriving at
  // `engine.executeRaw`. What happens THEN is upstream's
  // `PostgresEngine#runUnsafe` — an already-aborted short-circuit plus
  // postgres.js `.cancel()` on the pending query — and no test in this repo,
  // upstream's included, observes that cancel landing on a live server or the
  // pool slot coming back; upstream pins it by source-text guard
  // (test/connection-resilience.test.ts). Cancellation is best-effort by the
  // PG protocol regardless, which is why the WARN is worded as "did not
  // complete", not "was cancelled".
  const controller = new AbortController();
  const onboardPromise = runAllOnboardChecks(engine, { signal: controller.signal });
  onboardPromise.catch(() => {}); // swallow a late rejection if the timeout already won the race
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results =
      timeoutMs > 0
        ? await Promise.race([
            onboardPromise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => {
                  controller.abort();
                  reject(
                    new Error(
                      // State the observed fact (the phase did not complete in
                      // time); the transaction pooler is one KNOWN possible
                      // cause, not a diagnosis — this fires the same way on any
                      // engine/topology whose checks stall.
                      `timed out after ${timeoutMs}ms — onboard checks did not complete. ` +
                        'One known cause: the Supabase transaction pooler (:6543) wedges these checks; ' +
                        'against it, run `gbrain onboard` checks via the :5432 session pooler for full results.',
                    ),
                  );
                },
                timeoutMs,
              );
            }),
          ])
        : await onboardPromise;
    return results.map(r => r.check);
  } catch (e) {
    return [
      {
        name: 'onboard_checks',
        status: 'warn',
        message: `Onboard checks skipped: ${(e as Error).message}`,
      },
    ];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Also abort on the success path: `Promise.all` settles when the LAST
    // check resolves, and an earlier one may still hold a statement open if
    // a sibling threw. Aborting an already-settled signal is a no-op.
    controller.abort();
  }
}
