import type { BrainEngine } from '../engine.ts';

/** A transient config read failure must not strand default-enabled fence reconciliation. */
export async function cycleExtractFactsEnabled(engine: BrainEngine): Promise<boolean> {
  return !/^\s*(false|0|off|no)\s*$/i.test(await engine.getConfig('cycle.extract_facts.enabled').catch(() => null) ?? '');
}
