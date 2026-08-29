/**
 * SWX — answer "will this brain mirror pages to disk?" the way the RUNTIME
 * answers it, for the two fork deploy entrypoints.
 *
 * Why a probe and not `gbrain config get sync.write_through`: round-2 review
 * found that `config get` resolves the FILE plane above the DB plane
 * (src/commands/config.ts), while every runtime disk sink asks
 * `isWriteThroughDisabled`, which reads ONLY `engine.getConfig` — the DB
 * plane (src/core/write-through.ts). A stale `sync.write_through` in
 * ~/.gbrain/config.json therefore makes `config get` print an off value while
 * the brain still mirrors, which is precisely the false confirmation a check
 * whose whole job is positive confirmation must not produce.
 *
 * So this calls the predicate itself. Not a proxy for the runtime's answer:
 * the runtime's answer.
 *
 * Output (stdout, one line, machine-readable for the shell callers):
 *   disabled           mirroring is OFF — the DB-only posture this deploy wants
 *   enabled:unset      the DB key is absent; upstream fails OPEN, so mirrors are ON
 *   enabled:<value>    the DB key is present and not an off value
 *   unknown:<reason>   could not determine (no brain, connect failure, …)
 *
 * Exit code mirrors it: 0 disabled, 1 enabled, 2 unknown. Callers gate on the
 * code and print the line.
 */

import { loadConfig, toEngineConfig } from '../../src/core/config.ts';
import { createEngine } from '../../src/core/engine-factory.ts';
import { isWriteThroughDisabled } from '../../src/core/write-through.ts';

async function main(): Promise<number> {
  let engine;
  try {
    const cfg = loadConfig();
    if (!cfg?.engine && !cfg?.database_url && !cfg?.database_path) {
      console.log('unknown:no-brain-configured');
      return 2;
    }
    engine = await createEngine(toEngineConfig(cfg));
    await engine.connect(toEngineConfig(cfg));
  } catch (e) {
    console.log(`unknown:${String((e as Error)?.message ?? e).slice(0, 120).replace(/\s+/g, ' ')}`);
    return 2;
  }
  try {
    // The predicate the disk sinks call. Its own read is DB-plane and
    // fail-open, so a read error here reports enabled — same posture the
    // runtime would take, which is the honest thing for a warning to say.
    const disabled = await isWriteThroughDisabled(engine);
    if (disabled) {
      console.log('disabled');
      return 0;
    }
    // Distinguish "unset" from "explicitly on" so the caller can tell an
    // operator who never decided from one who chose mirrors.
    let raw: string | null = null;
    try { raw = await engine.getConfig('sync.write_through'); } catch { /* keep null */ }
    console.log(raw == null || raw === '' ? 'enabled:unset' : `enabled:${String(raw).slice(0, 40)}`);
    return 1;
  } finally {
    try { await engine.disconnect(); } catch { /* best effort */ }
  }
}

process.exit(await main());
