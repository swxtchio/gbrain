/**
 * #6803: a checkout-less connector cycle bounds its source window and keeps Facts reconciliation scoped to that source. The test drives the real handler and cycle against the configured engine arms.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { makeAutopilotCycleHandler } from '../src/core/minions/handlers/autopilot-cycle.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { selectFactsReconcileSlugs } from '../src/core/facts/reconcile-pages.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, googleConfig } from './helpers/connector-fixture.ts';

const fixture = createConnectorFixture();
const { engines, env, source } = fixture;
beforeAll(fixture.setup, 120_000);
afterAll(fixture.teardown);

const OTHER_PAGES = 40;
const factsFence = (claim: string) => `## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|---|---|---|---|---|---|---|---|---|
| 1 | ${claim} | fact | 1 | world | medium | 2024-01-01 | | notes | |
<!--- gbrain:facts:end -->
`;

async function seed(engine: BrainEngine): Promise<{ connector: string; other: string }> {
  const connector = (await source(engine, googleConfig)).id;
  const other = (await source(engine, {})).id;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.putPage('emails/example', { title: 'Synthetic exchange', type: 'email', compiled_truth: 'A synthetic note.' }, { sourceId: connector });
  for (let i = 0; i < OTHER_PAGES; i++) {
    await engine.putPage(`notes/n-${i}`, { title: `Note ${i}`, type: 'note', compiled_truth: `Body ${i}.` }, { sourceId: other });
  }
  return { connector, other };
}

describe('#6803 connector cycle extract_facts scope', () => {
  test('a connector cycle reconciles only its own source, through the bounded drain', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const { connector } = await seed(engine);
      const out = await makeAutopilotCycleHandler(engine)({ id: 1, data: { source_id: connector } } as never) as {
        report: { brain_dir: string | null; phases: Array<{ phase: string; status: string; details: Record<string, unknown> }> };
      };
      expect(out.report.brain_dir).toBeNull();
      const facts = out.report.phases.find(p => p.phase === 'extract_facts');
      expect(facts).toBeDefined();
      expect(Number(facts!.details.pagesScanned)).toBeLessThanOrEqual(1);
      const weight = out.report.phases.find(p => p.phase === 'recompute_emotional_weight');
      expect(weight?.details).toMatchObject({ mode: 'incremental', pages_recomputed: 1 });
      // The next cycle starts from this cycle's stamp: nothing in the source changed since.
      const again = await makeAutopilotCycleHandler(engine)({ id: 2, data: { source_id: connector } } as never) as typeof out;
      expect(again.report.phases.find(p => p.phase === 'recompute_emotional_weight')?.details).toMatchObject({ mode: 'incremental', pages_recomputed: 0 });
      // A page that changed while a cycle ran (after it listed its pages, before its stamp) is picked up by the next one.
      const [stamps] = await engine.executeRaw<{ window_at: string; stamp: string }>(
        "SELECT config->>'last_source_cycle_window_at' AS window_at, config->>'last_source_cycle_at' AS stamp FROM sources WHERE id=$1", [connector]);
      expect(Date.parse(stamps.window_at)).toBeLessThan(Date.parse(stamps.stamp));
      await engine.executeRaw("UPDATE pages SET updated_at=$2::timestamptz + interval '1 millisecond' WHERE source_id=$1 AND slug='emails/example'", [connector, stamps.window_at]);
      expect((await engine.executeRaw<{ before: boolean }>("SELECT updated_at < $2::timestamptz AS before FROM pages WHERE source_id=$1 AND slug='emails/example'", [connector, stamps.stamp]))[0].before).toBe(true);
      const third = await makeAutopilotCycleHandler(engine)({ id: 3, data: { source_id: connector } } as never) as typeof out;
      expect(third.report.phases.find(p => p.phase === 'recompute_emotional_weight')?.details).toMatchObject({ mode: 'incremental', pages_recomputed: 1 });
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  }), 180_000);

  test('with managed persistence (no watermark drain) the cycle still reconciles the source\'s changed pages', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const { connector } = await seed(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const out = await makeAutopilotCycleHandler(engine)({ id: 4, data: { source_id: connector } } as never) as {
        report: { phases: Array<{ phase: string; status: string; details: Record<string, unknown> }> };
      };
      expect(Number(out.report.phases.find(p => p.phase === 'extract_facts')!.details.pagesScanned)).toBe(1);
      await disposePersistenceConsumer(engine);
    }
  }), 180_000);

  test('a source-scoped Facts selection reconciles its own fence and ignores an other-source fence', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const { connector, other } = await seed(engine);
      await engine.putPage('people/connector-facts', { title: 'Connector facts', type: 'person', compiled_truth: factsFence('Connector claim') }, { sourceId: connector });
      await engine.putPage('people/other-facts', { title: 'Other facts', type: 'person', compiled_truth: factsFence('Other claim') }, { sourceId: other });
      expect(await selectFactsReconcileSlugs(engine, connector)).toEqual(['people/connector-facts']);
      const result = await runExtractFacts(engine, { sourceId: connector, drain: {} });
      expect(result.pagesScanned).toBe(1);
      expect(result.factsInserted).toBe(1);
      const rows = await engine.executeRaw<{ source_id: string; slug: string; fact: string }>(
        `SELECT source_id, source_markdown_slug AS slug, fact FROM facts
          WHERE fact IN ('Connector claim', 'Other claim') ORDER BY source_id`,
      );
      expect(rows).toEqual([{ source_id: connector, slug: 'people/connector-facts', fact: 'Connector claim' }]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  }), 180_000);
});
