/**
 * Source retraction cascade (Task #329).
 *
 * When a Source Vault document transitions to a non-active lifecycle status
 * (retracted, unavailable, stale, superseded), this module:
 *
 *   1. Finds every article that cites that source as "evidence" via
 *      article_sources.sourceDocumentId and flags it with retraction_impact_at.
 *   2. Finds every evidence packet whose sources[] JSONB snapshot includes the
 *      document id and marks it stale_packet = true.
 *   3. Finds every glossary concept whose concept_sources grounding URL matches
 *      the document; if the concept has zero remaining active trusted-tier vault
 *      sources, sets concept_retraction_flag = true.
 *   4. Inserts source_retraction_impacts rows (one per article, idempotent via
 *      ON CONFLICT DO NOTHING on the unique (source_document_id, article_id) key).
 *
 * Callers fire-and-forget: cascadeSourceRetraction() catches and logs its own
 * errors and never throws at the call site.
 *
 * Daily rescan (runRetractionRescan):
 *   For each flagged article, checks if it still has at least one active
 *   trusted-tier source in article_sources. If yes → the evidence base is still
 *   solid → clears retraction_impact_cleared_at + records rescan_result = 'cleared'.
 *   If no → records rescan_result = 'still_flagged' for human review.
 */

import { db } from "@workspace/db";
import {
  articlesTable,
  articleSourcesTable,
  evidencePacketsTable,
  conceptsTable,
  conceptSourcesTable,
  sourceDocumentsTable,
  sourceRetractionImpactsTable,
} from "@workspace/db";
import { eq, and, or, isNull, isNotNull, inArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

// Lifecycle statuses that trigger a cascade — anything that removes a source
// from "active" retrieval.
const NON_ACTIVE_STATUSES = new Set(["retracted", "unavailable", "stale", "superseded"]);

// Authority tiers whose presence means an article still has solid evidence.
const TRUSTED_TIERS = ["primary", "firsthand", "wire", "reported"] as const;

/**
 * Cascade a lifecycle transition to dependent articles, evidence packets, and
 * glossary concepts. Fire-and-forget safe: catches all errors internally.
 */
export async function cascadeSourceRetraction(
  docId: string,
  lifecycleStatus: string,
): Promise<void> {
  if (!NON_ACTIVE_STATUSES.has(lifecycleStatus)) return;

  try {
    const now = new Date();

    // ── 1. Articles ──────────────────────────────────────────────────────────
    const affectedArticleRows = await db
      .select({ articleId: articleSourcesTable.articleId })
      .from(articleSourcesTable)
      .where(
        and(
          eq(articleSourcesTable.sourceDocumentId, docId),
          eq(articleSourcesTable.role, "evidence"),
        ),
      );

    if (affectedArticleRows.length > 0) {
      const articleIds = affectedArticleRows.map((r) => r.articleId);

      // Stamp (or re-stamp) retraction_impact_at and clear retraction_impact_cleared_at
      // for articles that are either:
      //   (a) not yet flagged — retractionImpactAt IS NULL, or
      //   (b) previously cleared — retractionImpactClearedAt IS NOT NULL.
      // Articles already actively flagged (impactAt IS NOT NULL, clearedAt IS NULL)
      // are left untouched; they're already surfaced in admin/public notice.
      await db
        .update(articlesTable)
        .set({ retractionImpactAt: now, retractionImpactClearedAt: null })
        .where(
          and(
            inArray(articlesTable.id, articleIds),
            or(
              isNull(articlesTable.retractionImpactAt),
              isNotNull(articlesTable.retractionImpactClearedAt),
            ),
          ),
        );

      // Record impact rows (idempotent).
      await db
        .insert(sourceRetractionImpactsTable)
        .values(
          articleIds.map((articleId) => ({
            sourceDocumentId: docId,
            articleId,
            lifecycleStatus,
          })),
        )
        .onConflictDoNothing();
    }

    // ── 2. Evidence packets (JSONB sources snapshot) ─────────────────────────
    // Each packet row's `sources` column is a JSONB array of PacketSource
    // objects with an `id` field equal to the source_document id.
    const affectedPacketRows = await db
      .select({ id: evidencePacketsTable.id })
      .from(evidencePacketsTable)
      .where(
        sql`${evidencePacketsTable.sources} @> ${JSON.stringify([{ id: docId }])}::jsonb`,
      );

    if (affectedPacketRows.length > 0) {
      await db
        .update(evidencePacketsTable)
        .set({ stalePacket: true })
        .where(
          inArray(
            evidencePacketsTable.id,
            affectedPacketRows.map((r) => r.id),
          ),
        );
    }

    // ── 3. Glossary concepts ─────────────────────────────────────────────────
    // Concepts are grounded by concept_sources which link via URL.
    // Get the document's URL to look up matching concept_sources entries.
    const docRow = await db
      .select({ url: sourceDocumentsTable.url })
      .from(sourceDocumentsTable)
      .where(eq(sourceDocumentsTable.id, docId))
      .limit(1);

    if (docRow.length > 0) {
      const docUrl = docRow[0].url;

      const affectedConceptRows = await db
        .select({ conceptId: conceptSourcesTable.conceptId })
        .from(conceptSourcesTable)
        .where(eq(conceptSourcesTable.sourceUrl, docUrl));

      for (const { conceptId } of affectedConceptRows) {
        // Check if this concept still has any active trusted-tier vault source.
        const remaining = await db
          .select({ cnt: sql<string>`count(*)` })
          .from(conceptSourcesTable)
          .innerJoin(
            sourceDocumentsTable,
            eq(sourceDocumentsTable.url, conceptSourcesTable.sourceUrl),
          )
          .where(
            and(
              eq(conceptSourcesTable.conceptId, conceptId),
              eq(conceptSourcesTable.sourceType, "vault"),
              eq(sourceDocumentsTable.lifecycleStatus, "active"),
              inArray(sourceDocumentsTable.authorityTier, [...TRUSTED_TIERS]),
            ),
          );

        if (Number(remaining[0]?.cnt ?? 0) === 0) {
          await db
            .update(conceptsTable)
            .set({ conceptRetractionFlag: true, updatedAt: new Date() })
            .where(eq(conceptsTable.id, conceptId));
        }
      }
    }

    if (affectedArticleRows.length > 0 || affectedPacketRows.length > 0) {
      logger.info(
        {
          docId,
          lifecycleStatus,
          articles: affectedArticleRows.length,
          packets: affectedPacketRows.length,
        },
        "retractionCascade: cascade complete",
      );
    }
  } catch (err) {
    logger.warn(
      { err, docId, lifecycleStatus },
      "retractionCascade: cascade failed (non-fatal)",
    );
  }
}

/**
 * Rescan a single article: check whether it still has at least one active
 * trusted-tier source. If yes, clear the retraction impact flag.
 */
export async function runSingleArticleRescan(
  articleId: string,
): Promise<{ rescanned: number; cleared: number }> {
  const result = await _rescanArticle(articleId, new Date());
  return { rescanned: 1, cleared: result ? 1 : 0 };
}

/** Internal: rescan one article, return true if cleared. */
async function _rescanArticle(articleId: string, now: Date): Promise<boolean> {
  // Fetch the article's clusterId so we can attempt a packet rebuild for
  // packet-grounded drafts. The rebuild re-screens without the retracted
  // source(s) (they are filtered out by lifecycleStatus='active' in the vault
  // query), upgrades the packet version, and re-runs the editorial screen —
  // producing a fresh decision that reflects the updated evidence base.
  const articleRow = await db
    .select({ clusterId: articlesTable.clusterId })
    .from(articlesTable)
    .where(eq(articlesTable.id, articleId))
    .limit(1);

  const clusterId = articleRow[0]?.clusterId ?? null;

  // Path A: Packet-grounded draft with an active cluster.
  // Rebuild the evidence packet (vault-only research) so retracted sources are
  // excluded automatically; the packet version increments and the editorial
  // screen re-runs. If the rebuild clears the packet (new decision =
  // approve_draft or the source mix no longer requires retraction notice), we
  // clear the impact flags.
  if (clusterId) {
    try {
      const { buildEvidencePacket } = await import("./editorialScreen");
      const result = await buildEvidencePacket(clusterId, {
        research: "vault_only",
        skipIfUnchanged: false,
      });

      const { packet } = result;

      // Clear stale_packet on the new packet version so it no longer shows the
      // retraction warning in the Editor Cockpit.
      if (packet.id) {
        await db
          .update(evidencePacketsTable)
          .set({ stalePacket: false })
          .where(eq(evidencePacketsTable.id, packet.id));
      }

      // If the rebuilt packet passed screening, the evidence base is solid
      // despite the retracted source → clear the article-level impact flags.
      if (packet.decision === "approve_draft" || packet.decision === "needs_human_editor") {
        await db
          .update(articlesTable)
          .set({ retractionImpactClearedAt: now })
          .where(eq(articlesTable.id, articleId));

        await db
          .update(sourceRetractionImpactsTable)
          .set({ rescanAttemptedAt: now, rescanResult: "cleared_via_packet_rebuild" })
          .where(eq(sourceRetractionImpactsTable.articleId, articleId));

        logger.info(
          { articleId, clusterId, decision: packet.decision },
          "retractionCascade: packet rebuilt and impact cleared",
        );
        return true;
      }

      // Packet rebuilt but decision still insufficient — record the attempt.
      await db
        .update(sourceRetractionImpactsTable)
        .set({ rescanAttemptedAt: now, rescanResult: `packet_rebuilt_decision:${packet.decision}` })
        .where(eq(sourceRetractionImpactsTable.articleId, articleId));

      logger.info(
        { articleId, clusterId, decision: packet.decision },
        "retractionCascade: packet rebuilt but decision still requires review",
      );
      return false;
    } catch (err) {
      // Log but don't abort — fall through to the lightweight source-count check
      // so we don't leave the rescan record entirely empty.
      logger.warn(
        { err, articleId, clusterId },
        "retractionCascade: packet rebuild failed; falling back to source-count check",
      );
    }
  }

  // Path B: No cluster (manual idea or older draft) OR packet rebuild failed.
  // Check whether the article still has at least one active trusted-tier source
  // in article_sources. If yes, the evidence base is still solid enough to
  // clear the impact flag without a full packet rebuild.
  const activeRows = await db
    .select({ cnt: sql<string>`count(*)` })
    .from(articleSourcesTable)
    .innerJoin(
      sourceDocumentsTable,
      eq(sourceDocumentsTable.id, articleSourcesTable.sourceDocumentId),
    )
    .where(
      and(
        eq(articleSourcesTable.articleId, articleId),
        eq(articleSourcesTable.role, "evidence"),
        eq(sourceDocumentsTable.lifecycleStatus, "active"),
        inArray(sourceDocumentsTable.authorityTier, [...TRUSTED_TIERS]),
      ),
    );

  const hasActiveTrusted = Number(activeRows[0]?.cnt ?? 0) > 0;

  if (hasActiveTrusted) {
    await db
      .update(articlesTable)
      .set({ retractionImpactClearedAt: now })
      .where(eq(articlesTable.id, articleId));

    await db
      .update(sourceRetractionImpactsTable)
      .set({ rescanAttemptedAt: now, rescanResult: "cleared" })
      .where(eq(sourceRetractionImpactsTable.articleId, articleId));

    return true;
  } else {
    await db
      .update(sourceRetractionImpactsTable)
      .set({ rescanAttemptedAt: now, rescanResult: "still_flagged" })
      .where(
        and(
          eq(sourceRetractionImpactsTable.articleId, articleId),
          isNull(sourceRetractionImpactsTable.rescanResult),
        ),
      );
    return false;
  }
}

/**
 * Daily rescan sweep: for each article with an uncleared retraction impact,
 * check whether it still has at least one active trusted-tier source in its
 * article_sources graph.
 *
 * If yes → evidence base still solid → clear the impact flag automatically.
 * If no  → flag stays → human review needed.
 *
 * Runs a batch of up to `batchSize` articles per call so each cron tick stays
 * fast even with a large backlog.
 */
export async function runRetractionRescan(
  batchSize = 30,
): Promise<{ rescanned: number; cleared: number }> {
  const flagged = await db
    .select({ id: articlesTable.id })
    .from(articlesTable)
    .where(
      and(
        isNotNull(articlesTable.retractionImpactAt),
        isNull(articlesTable.retractionImpactClearedAt),
      ),
    )
    .limit(batchSize);

  let rescanned = 0;
  let cleared = 0;
  const now = new Date();

  for (const { id: articleId } of flagged) {
    try {
      const wasCleared = await _rescanArticle(articleId, now);
      rescanned++;
      if (wasCleared) cleared++;
    } catch (err) {
      logger.warn(
        { err, articleId },
        "retractionCascade: rescan failed for article (non-fatal)",
      );
    }
  }

  return { rescanned, cleared };
}
