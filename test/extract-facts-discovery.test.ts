/**
 * Protects full-walk source isolation, selective body transfer, fence/index preservation,
 * rewrite eligibility and the supported cycle off switch at runExtractFacts/runCycle.
 * Regressions: brain-wide enumeration, heading-only/current-fence-only discovery,
 * stale eligibility, or dispatch ignoring the setting/phase-local one-shot.
 * Existing phase/drain tests mostly supply explicit slugs and do not observe transfer.
 * No production seam: persisted pages and real engines, with a delegating read observer.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runConfig } from '../src/commands/config.ts';
import { runCycle } from '../src/core/cycle.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { readFactsReconcileBacklog } from '../src/core/facts/reconcile-watermark.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const row = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1 | world | medium | 2024-01-01 | | notes | |`;
const fence = (rows: string) => `## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n${rows}\n<!--- gbrain:facts:end -->\n`;

async function fixture(databaseUrl: string | undefined, run: (engine: BrainEngine, home: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'facts-discovery-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try { await run(engine, home); } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function put(engine: BrainEngine, slug: string, compiled_truth: string, source_id = 'default', timeline = '') {
  return engine.putPage(slug, { title: slug, type: 'person', compiled_truth, timeline, frontmatter: {} }, { sourceId: source_id });
}

async function state(engine: BrainEngine) {
  return engine.executeRaw<{ id: number; source_id: string; slug: string; fact: string; row_num: number | null; expired: boolean }>(
    `SELECT id, source_id, source_markdown_slug AS slug, fact, row_num, expired_at IS NOT NULL AS expired
       FROM facts ORDER BY source_id, source_markdown_slug, id`);
}

function observe(engine: BrainEngine) {
  const bodies: Array<[string, string]> = [];
  const lookups: Array<[string | undefined, string]> = [];
  const discoveries: Array<unknown[]> = [];
  const statements: string[] = [];
  const configReads: string[] = [];
  const observed = new Proxy(engine, {
    get(target, key) {
      if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
        statements.push(sql);
        const rows = await target.executeRaw(sql, params);
        if (/SELECT id, compiled_truth, timeline, frontmatter, effective_date, knowledge_revision/.test(sql)) {
          bodies.push([String(params?.[0]), String(params?.[1])]);
        }
        if (/SELECT p\.slug FROM pages p/.test(sql)) discoveries.push(rows);
        return rows;
      };
      if (key === 'getPage') return async (...args: Parameters<BrainEngine['getPage']>) => {
        lookups.push([args[1]?.sourceId, args[0]]);
        return target.getPage(...args);
      };
      if (key === 'getConfig') return async (name: string) => {
        configReads.push(name);
        return target.getConfig(name);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { engine: observed, bodies, lookups, discoveries, statements, configReads };
}

async function mirror(engine: BrainEngine, root: string, slug: string) {
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  const path = join(root, `${slug}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializePageToMarkdown(snapshot.page, snapshot.tags));
  return path;
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: selective full walk transfers only source-local Facts work, including same-slug collisions`, () => fixture(databaseUrl, async engine => {
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other', 'Other')");
    await put(engine, 'people/shared', fence(row(1, 'Local claim')));
    await put(engine, 'people/shared', fence(row(1, 'Foreign claim')), 'other');
    await put(engine, 'people/foreign-only', fence(row(1, 'Foreign only')), 'other');
    await put(engine, 'people/foreign-fence', 'Plain local page');
    await put(engine, 'people/foreign-fence', fence(row(1, 'Foreign fence')), 'other');
    await put(engine, 'notes/ordinary', 'Ordinary prose');
    const seen = observe(engine);
    const r = await runExtractFacts(seen.engine);
    expect(r.pagesScanned).toBe(1);
    expect(r.factsInserted).toBe(1);
    expect(seen.bodies).toEqual([['default', 'people/shared']]);
    expect(seen.discoveries).toEqual([[{ slug: 'people/shared' }]]);
    expect(seen.lookups.filter(([, slug]) => !slug.startsWith('extractions/'))).toEqual([]);
    expect((await state(engine)).filter(f => !f.expired).map(f => [f.source_id, f.slug, f.fact]))
      .toEqual([['default', 'people/shared', 'Local claim']]);
  }), 60_000);

  test(`${backend}: a fence-less source skips honestly without body reads or per-page lookups`, () => fixture(databaseUrl, async engine => {
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other', 'Other')");
    await put(engine, 'notes/plain', 'Ordinary prose');
    await put(engine, 'people/foreign', fence(row(1, 'Foreign claim')), 'other');
    const seen = observe(engine);
    const report = await runCycle(seen.engine, { brainDir: null, sourceId: 'default', phases: ['extract_facts'] });
    const phase = report.phases.find(p => p.phase === 'extract_facts')!;
    expect(phase.status).toBe('skipped');
    expect(phase.details).toMatchObject({ reason: 'no_facts_work', pagesScanned: 0 });
    expect(phase.summary).toContain('source "default"');
    expect(seen.bodies).toEqual([]);
    expect(seen.lookups).toEqual([]);
    expect(seen.discoveries).toEqual([[]]);
    expect(await state(engine)).toEqual([]);
  }), 60_000);

  test(`${backend}: removed last fence expires and detaches prior identities without touching conversation rows`, () => fixture(databaseUrl, async engine => {
    await put(engine, 'people/removed', fence(row(1, 'Old fence claim')));
    await runExtractFacts(engine);
    const [prior] = await state(engine);
    await engine.insertFacts([{ fact: 'Conversation claim', source: 'cli:session', row_num: 9, source_markdown_slug: 'people/removed' }], { source_id: 'default' });
    await put(engine, 'people/removed', 'The whole fence is gone');
    const seen = observe(engine);
    const r = await runExtractFacts(seen.engine);
    expect(seen.bodies).toEqual([['default', 'people/removed']]);
    expect(r.factsDeleted).toBe(1);
    expect(await state(engine)).toEqual([
      { ...prior!, expired: true, row_num: null },
      expect.objectContaining({ fact: 'Conversation claim', row_num: 9, expired: false }),
    ]);
    const again = observe(engine);
    await runExtractFacts(again.engine);
    expect(again.bodies).toEqual([]);
  }), 60_000);

  test(`${backend}: marker-only, malformed, end-only and misplaced fences stay visible to reconciliation`, () => fixture(databaseUrl, async engine => {
    await put(engine, 'people/markers', fence(row(1, 'Markers claim')).replace('## Facts\n\n', ''));
    await put(engine, 'people/broken', fence(row(1, 'Preserved claim')));
    await runExtractFacts(engine, { slugs: ['people/broken'] });
    const before = await state(engine);
    await put(engine, 'people/broken', fence('| invalid | broken |'));
    await put(engine, 'people/end-only', '# Orphan\n\nProse before lone end marker.\n<!--- gbrain:facts:end -->');
    await put(engine, 'people/misplaced', 'Prose', 'default', fence(row(1, 'Misplaced claim')));
    const seen = observe(engine);
    const r = await runExtractFacts(seen.engine);
    expect(seen.bodies.map(([, slug]) => slug)).toEqual(['people/broken', 'people/end-only', 'people/markers', 'people/misplaced']);
    expect(r.warnings).toContainEqual(expect.stringContaining('people/broken: FACTS_TABLE_MALFORMED'));
    expect(r.warnings).toContainEqual(expect.stringContaining('people/end-only: FACTS_FENCE_UNBALANCED'));
    expect(r.warnings).toContainEqual(expect.stringContaining('people/misplaced: FACTS_FENCE_BELOW_SENTINEL'));
    expect(r.factsDeleted).toBe(0);
    expect(r.factsInserted).toBe(1);
    expect((await state(engine)).filter(f => f.slug === 'people/broken')).toEqual(before);
    expect((await state(engine)).find(f => f.fact === 'Markers claim')).toMatchObject({ expired: false });
  }), 60_000);

  test(`${backend}: rewritten reconciled fences remain discoverable and retain unchanged fact identities`, () => fixture(databaseUrl, async engine => {
    await put(engine, 'people/rewritten', fence(row(1, 'Kept claim')));
    await runExtractFacts(engine);
    const [kept] = await state(engine);
    await put(engine, 'people/rewritten', fence(`${row(1, 'Kept claim')}\n${row(2, 'New claim')}`));
    const seen = observe(engine);
    const r = await runExtractFacts(seen.engine);
    expect(seen.bodies).toEqual([['default', 'people/rewritten']]);
    expect(r.factsInserted).toBe(1);
    expect(await state(engine)).toEqual([kept!, expect.objectContaining({ fact: 'New claim', row_num: 2, expired: false })]);
    expect(await readFactsReconcileBacklog(engine)).toEqual({ pending: 0, invalid: [] });
  }), 60_000);

  test(`${backend}: selected-page reads retain quarantine and effective-date safety inputs`, () => fixture(databaseUrl, async engine => {
    const dated = fence(row(1, 'Dated claim').replace('2024-01-01', ''));
    await importFromContent(engine, 'people/dated', `---\ntitle: Dated\ntype: person\ndate: 2023-06-15\n---\n\n${dated}`, { noEmbed: true });
    await engine.putPage('people/quarantined', { title: 'Quarantined', type: 'person', compiled_truth: fence(row(1, 'Withheld claim')), frontmatter: { quarantine: true } });
    const r = await runExtractFacts(engine);
    expect(r.pagesScanned).toBe(2);
    expect((await state(engine)).map(f => f.fact)).toEqual(['Dated claim']);
    const [fact] = await engine.executeRaw<{ valid_from: Date | string }>("SELECT valid_from FROM facts WHERE fact = 'Dated claim'");
    expect(new Date(fact!.valid_from).toISOString()).toBe('2023-06-15T00:00:00.000Z');
  }), 60_000);

  test(`${backend}: unfenced-row adoption adds an initially fence-less page to an explicit empty run`, () => fixture(databaseUrl, async (engine, home) => {
    const root = join(home, 'repo');
    mkdirSync(root);
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
    await put(engine, 'people/adopted', '# Adopted\n\nProse.');
    const path = await mirror(engine, root, 'people/adopted');
    const [legacy] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, source)
      VALUES ('default', 'people/adopted', 'Adopted claim', 'mcp:remember') RETURNING id`);
    const seen = observe(engine);
    const r = await runExtractFacts(seen.engine, { slugs: [] });
    expect(r.unfencedRowsFenced).toBe(1);
    expect(r.guardTriggered).toBe(false);
    expect(seen.bodies).toEqual([['default', 'people/adopted']]);
    expect(parseFactsFence(readFileSync(path, 'utf8')).facts.map(f => f.claim)).toEqual(['Adopted claim']);
    expect(await state(engine)).toEqual([{ id: legacy!.id, source_id: 'default', slug: 'people/adopted', fact: 'Adopted claim', row_num: 1, expired: false }]);
  }), 60_000);

  test(`${backend}: phantom redirection adds its canonical to an explicit empty run`, () => fixture(databaseUrl, async (engine, home) => {
    const root = join(home, 'repo');
    mkdirSync(root);
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
    await put(engine, 'people/alice-example', '# Alice\n');
    await mirror(engine, root, 'people/alice-example');
    await put(engine, 'alice', `# Alice\n\n${fence(row(1, 'Redirected claim'))}`);
    await mirror(engine, root, 'alice');
    const seen = observe(engine);
    const r = await runExtractFacts(seen.engine, { slugs: [], brainDir: root });
    expect(r.phantomsRedirected).toBe(1);
    expect(seen.bodies).toEqual([['default', 'people/alice-example']]);
    expect((await state(engine)).filter(f => !f.expired).map(f => [f.slug, f.fact])).toEqual([['people/alice-example', 'Redirected claim']]);
  }), 60_000);

  test(`${backend}: discovery failures produce a failed cycle rather than a successful empty phase`, () => fixture(databaseUrl, async engine => {
    await put(engine, 'people/page', fence(row(1, 'Claim')));
    const failing = new Proxy(engine, { get(target, key) {
      if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
        if (/SELECT p\.slug FROM pages p/.test(sql)) throw new Error('discovery unavailable');
        return target.executeRaw(sql, params);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const report = await runCycle(failing, { brainDir: null, sourceId: 'default', phases: ['extract_facts'] });
    expect(report.phases.find(p => p.phase === 'extract_facts')?.status).toBe('fail');
    expect(await state(engine)).toEqual([]);
  }), 60_000);

  test(`${backend}: disabled cycle config prevents phase reads, repairs and writes; only its own one-shot bypasses`, () => fixture(databaseUrl, async (engine, home) => {
    const root = join(home, 'repo');
    mkdirSync(root);
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
    await put(engine, 'people/page', fence(row(1, 'Fence claim')));
    const path = await mirror(engine, root, 'people/page');
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, source)
      VALUES ('default', 'people/page', 'Needs adoption', 'mcp:remember')`);
    const before = await state(engine);
    const bytes = readFileSync(path, 'utf8');
    await runConfig(engine, ['set', 'cycle.extract_facts.enabled', 'false']);
    expect(await engine.getConfig('cycle.extract_facts.enabled')).toBe('false');
    const seen = observe(engine);
    for (const onceForPhase of [undefined, 'lint'] as const) {
      const report = await runCycle(seen.engine, { brainDir: root, sourceId: 'default', phases: ['extract_facts'], onceForPhase });
      const phase = report.phases.find(p => p.phase === 'extract_facts')!;
      expect(phase.status).toBe('skipped');
      expect(phase.details).toMatchObject({ reason: 'disabled', enable_hint: 'gbrain config set cycle.extract_facts.enabled true' });
      expect(phase.summary).toContain('cycle.extract_facts.enabled=false');
    }
    expect(seen.bodies).toEqual([]);
    expect(seen.lookups).toEqual([]);
    expect(seen.discoveries).toEqual([]);
    expect(seen.statements.some(sql => /\b(facts|page_facts_reconcile|extract_run_rollups)\b/.test(sql))).toBe(false);
    expect(await state(engine)).toEqual(before);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    const once = await runCycle(engine, { brainDir: root, sourceId: 'default', phases: ['extract_facts'], onceForPhase: 'extract_facts' });
    expect(once.phases.find(p => p.phase === 'extract_facts')?.details).toMatchObject({ unfencedRowsFenced: 1, pagesScanned: 1 });
    expect((await state(engine)).filter(f => !f.expired).map(f => f.fact).sort()).toEqual(['Fence claim', 'Needs adoption']);
    expect(parseFactsFence(readFileSync(path, 'utf8')).facts).toHaveLength(2);
    expect(await engine.getConfig('cycle.extract_facts.enabled')).toBe('false');
    const again = await runCycle(engine, { brainDir: root, sourceId: 'default', phases: ['extract_facts'] });
    expect(again.phases.find(p => p.phase === 'extract_facts')?.details).toMatchObject({ reason: 'disabled' });
    await runConfig(engine, ['set', 'cycle.extract_facts.enabled', 'true']);
    const on = await runCycle(engine, { brainDir: root, sourceId: 'default', phases: ['extract_facts'] });
    expect(on.phases.find(p => p.phase === 'extract_facts')?.details).toMatchObject({ pagesScanned: 1 });
    await runConfig(engine, ['unset', 'cycle.extract_facts.enabled']);
    await put(engine, 'people/page', fence(row(1, 'Unset gate claim')));
    await mirror(engine, root, 'people/page');
    const unset = await runCycle(engine, { brainDir: root, sourceId: 'default', phases: ['extract_facts'] });
    expect(unset.phases.find(p => p.phase === 'extract_facts')?.details).toMatchObject({ factsInserted: 1 });
  }), 60_000);

  test(`${backend}: phantom pre-pass work is not hidden by a no-work summary`, () => fixture(databaseUrl, async (engine, home) => {
    const root = join(home, 'repo');
    mkdirSync(root);
    await put(engine, 'ordinary', '# Ordinary\n\nReal prose, no phantom stub.');
    const seen = observe(engine);
    const report = await runCycle(seen.engine, { brainDir: root, sourceId: 'default', phases: ['extract_facts'] });
    const phase = report.phases.find(p => p.phase === 'extract_facts')!;
    expect(phase.status).not.toBe('skipped');
    expect(phase.details).toMatchObject({ phantoms_scanned: 1, pagesScanned: 0 });
    expect(phase.summary).toContain('phantom(s) scanned');
    expect(seen.bodies).toEqual([]);
    expect(seen.lookups).toContainEqual(['default', 'ordinary']);
  }), 60_000);
}
