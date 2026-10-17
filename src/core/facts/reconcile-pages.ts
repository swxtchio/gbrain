import type { BrainEngine } from '../engine.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../facts-fence.ts';

/** Discovery must keep removed and broken fences eligible without transferring unrelated bodies. */
export async function selectFactsReconcileSlugs(engine: BrainEngine, sourceId: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT p.slug FROM pages p
      WHERE p.source_id = $1 AND p.deleted_at IS NULL
        AND (p.compiled_truth LIKE $2 OR p.compiled_truth LIKE $3
          OR p.timeline LIKE $2 OR p.timeline LIKE $3
          OR EXISTS (SELECT 1 FROM facts f
            WHERE f.source_id = p.source_id AND f.source_markdown_slug = p.slug
              AND COALESCE(f.source, '') NOT LIKE 'cli:%'
              AND NOT (f.row_num IS NULL AND f.expired_at IS NOT NULL)))
      ORDER BY p.slug`,
    [sourceId, `%${FACTS_FENCE_BEGIN}%`, `%${FACTS_FENCE_END}%`],
  );
  return rows.map(row => row.slug);
}

export interface FactsReconcilePage {
  id: number;
  compiled_truth: string | null;
  timeline: string | null;
  frontmatter: Record<string, unknown> | null;
  effective_date: Date | string | null;
  knowledge_revision: string | null;
}

/** Keep the reconciliation and safety inputs, without the rest of the page payload. */
export async function readFactsReconcilePage(engine: BrainEngine, sourceId: string, slug: string): Promise<FactsReconcilePage | null> {
  const rows = await engine.executeRaw<FactsReconcilePage>(
    `SELECT id, compiled_truth, timeline, frontmatter, effective_date, knowledge_revision
       FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [sourceId, slug],
  );
  return rows[0] ?? null;
}
