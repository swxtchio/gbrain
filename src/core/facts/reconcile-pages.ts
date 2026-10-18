import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../facts-fence.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { overlayCanonicalBodies } from '../page-state/snapshot.ts';
import type { GlobalPurgeMarker, PageWithdrawal } from '../page-state/types.ts';

/** Discovery must keep removed and broken fences eligible without transferring unrelated bodies. */
export async function selectFactsReconcileSlugs(engine: BrainEngine, sourceId: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT p.slug FROM pages p
      WHERE p.source_id = $1 AND p.deleted_at IS NULL
        AND (p.compiled_truth LIKE $2 OR p.compiled_truth LIKE $3
          OR p.timeline LIKE $2 OR p.timeline LIKE $3
          OR EXISTS (SELECT 1 FROM page_body_manifest m
            JOIN page_segment_texts t ON t.source_id = m.source_id AND t.sha256 = m.sha256
            WHERE m.page_id = p.id AND m.source_id = p.source_id
              AND m.gen_to IS NULL AND m.staging_id IS NULL
              AND (m.facts_slots <> '[]'::jsonb
                OR (m.cut_kind = 'forced' AND get_byte(t.body, length(t.body) - 1) <> 10)
                OR position($4::bytea in t.body) > 0 OR position($5::bytea in t.body) > 0))
          OR EXISTS (SELECT 1 FROM facts f
            WHERE f.source_id = p.source_id AND f.source_markdown_slug = p.slug
              AND COALESCE(f.source, '') NOT LIKE 'cli:%'
              AND NOT (f.row_num IS NULL AND f.expired_at IS NOT NULL)))
      ORDER BY p.slug`,
    [sourceId, `%${FACTS_FENCE_BEGIN}%`, `%${FACTS_FENCE_END}%`, Buffer.from(FACTS_FENCE_BEGIN, 'utf8'), Buffer.from(FACTS_FENCE_END, 'utf8')],
  );
  return rows.map(row => row.slug);
}

export interface FactsReconcilePage {
  id: number;
  slug: string;
  source_id: string;
  body_storage: Page['body_storage'] | null;
  content_hash: Page['content_hash'] | null;
  body_bytes: Page['body_bytes'];
  compiled_truth: string | null;
  timeline: string | null;
  frontmatter: Record<string, unknown> | null;
  effective_date: Date | string | null;
  knowledge_revision: string | null;
}

/** Compare the source page and the exact body a reconciliation planned from. */
export function sameFactsReconcileBody(current: FactsReconcilePage, planned: FactsReconcilePage): boolean {
  if (current.id !== planned.id || current.slug !== planned.slug || current.source_id !== planned.source_id) return false;
  if (isSegmentedPage(current) || isSegmentedPage(planned)) {
    return isSegmentedPage(current) && isSegmentedPage(planned)
      && current.content_hash === planned.content_hash && current.body_bytes === planned.body_bytes;
  }
  return current.compiled_truth === planned.compiled_truth && current.timeline === planned.timeline;
}

/** Keep source/page body identity and safety inputs so segmented reconciliation reads its marker segments. */
export async function readFactsReconcilePage(engine: BrainEngine, sourceId: string, slug: string): Promise<FactsReconcilePage | null> {
  const rows = await engine.executeRaw<FactsReconcilePage & {
    withdrawals: PageWithdrawal[] | string; global_purges: GlobalPurgeMarker | string;
  }>(
    `SELECT p.id, p.slug, p.source_id, p.body_storage, p.content_hash, p.body_bytes,
       p.compiled_truth, p.timeline, p.frontmatter, p.effective_date, p.knowledge_revision,
       COALESCE((SELECT jsonb_agg(w) FROM (
         SELECT visibility, fact_hash, min(withdrawn_at) AS withdrawn_at, false AS purged
           FROM fact_withdrawals WHERE source_id = p.source_id AND (subject = '*' OR subject = p.slug)
           GROUP BY visibility, fact_hash
         UNION ALL
         SELECT visibility, fact_hash, min(purged_at) AS withdrawn_at, true AS purged
           FROM fact_purges WHERE source_id = p.source_id AND subject = p.slug
           GROUP BY visibility, fact_hash
       ) w), '[]'::jsonb) AS withdrawals,
       (SELECT jsonb_build_object('count', count(*), 'latest', max(g.purged_at), 'world_only', false)
          FROM fact_purges g WHERE g.source_id = p.source_id AND g.subject = '*') AS global_purges
       FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL`,
    [sourceId, slug],
  );
  if (!rows.length) return null;
  const { withdrawals, global_purges, ...page } = rows[0]!;
  if (isSegmentedPage(page)) return page;
  // Ledger state must override a fence whose physical mirror has not caught up yet.
  const bodies = await overlayCanonicalBodies(engine.executeRaw.bind(engine), page.compiled_truth ?? '', page.timeline ?? '',
    typeof withdrawals === 'string' ? JSON.parse(withdrawals) : withdrawals,
    { sourceId, marker: typeof global_purges === 'string' ? JSON.parse(global_purges) : global_purges });
  return { ...page, ...bodies };
}
