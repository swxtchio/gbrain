import type { BrainEngine } from '../../../core/engine.ts';
import { runAllOnboardChecks } from '../../../core/onboard/checks.ts';
import type { Check } from '../../doctor.ts';

/** Keep a stalled onboard phase from withholding the rest of the doctor report. */
export async function doctorOnboardChecks(engine: BrainEngine): Promise<Check[]> {
  const raw = process.env.GBRAIN_DOCTOR_ONBOARD_TIMEOUT_MS;
  const timeoutMs = raw === '0' || raw === 'off'
    ? 0
    : Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : 15000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = runAllOnboardChecks(engine);
    const results = timeoutMs > 0
      ? await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(
              `timed out after ${timeoutMs}ms — run \`gbrain onboard --check\` against a session pooler for full results.`,
            )), timeoutMs);
          }),
        ])
      : await pending;
    return results.map(result => result.check);
  } catch (error) {
    return [{ name: 'onboard_checks', status: 'warn', message: `Onboard checks skipped: ${error instanceof Error ? error.message : String(error)}` }];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
