/**
 * SWX port — doctor's onboard phase is bounded (re-port of 3eb9aa4a, part 1).
 *
 * `runAllOnboardChecks` hangs on the Supabase TRANSACTION pooler (:6543) —
 * confirmed by A/B at the fork point and reproduced again on v0.42.58 against
 * the live fleet brain (45s, killed by `timeout`). Because every doctor check
 * result flushes only after this final phase, the hang took the whole
 * `gbrain doctor` run down: no monitoring on :6543 at all. The bound
 * (GBRAIN_DOCTOR_ONBOARD_TIMEOUT_MS, default 15000) degrades the phase to a
 * WARN so the other 60+ checks always render. General hardening: one slow or
 * pooler-incompatible check can no longer wedge doctor.
 *
 * Serial because it uses mock.module (R2 isolation rule) to simulate the hang.
 *
 * Round-1 review added the second half of the property: the bound must
 * CANCEL, not merely stop waiting. An abandoned query keeps holding its
 * pooler slot, and the whole deploy/local-http design exists because the
 * session pooler caps at 15 clients — so "doctor completes" bought by walking
 * away from live queries trades a wedge for slow exhaustion of the exact
 * resource being rationed. `runAllOnboardChecks` now takes an AbortSignal and
 * forwards it to every counting query.
 *
 * Fail-without proof: pre-patch, buildChecks awaits the never-resolving
 * onboard promise and this file's first test can only end by bun's per-test
 * timeout (a failure). Post-patch it passes in ~50ms.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildChecks } from '../src/commands/doctor.ts';

const TIMEOUT_ENV = 'GBRAIN_DOCTOR_ONBOARD_TIMEOUT_MS';
let savedTimeoutEnv: string | undefined;

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  savedTimeoutEnv = process.env[TIMEOUT_ENV];
});

afterEach(() => {
  if (savedTimeoutEnv === undefined) delete process.env[TIMEOUT_ENV];
  else process.env[TIMEOUT_ENV] = savedTimeoutEnv;
  mock.restore();
});

describe('SWX: doctor onboard phase is bounded', () => {
  test('a hung runAllOnboardChecks degrades to a warn and doctor still completes', async () => {
    mock.module('../src/core/onboard/checks.ts', () => ({
      runAllOnboardChecks: () => new Promise(() => {}), // the :6543 wedge, simulated
    }));
    process.env[TIMEOUT_ENV] = '50';

    const checks = await buildChecks(engine, []);

    const onboard = checks.find((c) => c.name === 'onboard_checks');
    expect(onboard).toBeDefined();
    expect(onboard!.status).toBe('warn');
    expect(onboard!.message).toMatch(/timed out after 50ms/);
    // The point of the bound: the other checks rendered instead of wedging.
    expect(checks.length).toBeGreaterThan(20);
  });

  test('the bound ABORTS the onboard work rather than abandoning it', async () => {
    // The mock records the signal it was handed and whether it fired. A
    // handle-free "hang" proves only latency; this proves the wedged work is
    // told to stop, which is what frees the pooler slot.
    let seen: AbortSignal | undefined;
    let abortedAt: number | null = null;
    mock.module('../src/core/onboard/checks.ts', () => ({
      runAllOnboardChecks: (_engine: unknown, opts?: { signal?: AbortSignal }) => {
        seen = opts?.signal;
        seen?.addEventListener('abort', () => { abortedAt = Date.now(); }, { once: true });
        return new Promise(() => {});
      },
    }));
    process.env[TIMEOUT_ENV] = '50';

    await buildChecks(engine, []);

    expect(seen, 'the bound passed no AbortSignal to runAllOnboardChecks').toBeDefined();
    expect(seen!.aborted).toBe(true);
    expect(abortedAt).not.toBeNull();
  });

  test('happy path: resolved onboard results pass through the bound unchanged', async () => {
    mock.module('../src/core/onboard/checks.ts', () => ({
      runAllOnboardChecks: async () => [
        { check: { name: 'onboard_stub_ok', status: 'ok', message: 'stubbed' }, remediations: [] },
      ],
    }));
    process.env[TIMEOUT_ENV] = '5000';

    const checks = await buildChecks(engine, []);

    const stub = checks.find((c) => c.name === 'onboard_stub_ok');
    expect(stub).toBeDefined();
    expect(stub!.status).toBe('ok');
    // No spurious warn from the wrapper when the phase succeeds.
    expect(checks.find((c) => c.name === 'onboard_checks')).toBeUndefined();
  });
});
