import { Router } from "express";
import { db } from "@workspace/db";
import {
  articlesTable,
  sourceRetractionImpactsTable,
  sourceDocumentsTable,
  authorsTable,
} from "@workspace/db";
import { eq, and, isNull, isNotNull, desc } from "drizzle-orm";
import { runRetractionRescan } from "../../services/retractionCascade";

// Admin → Source Health: lists all articles with an uncleared retraction
// impact, plus quick-action endpoints to rescan or clear individual articles.

const router = Router();

// ── GET /admin/source-health ───────────────────────────────────────────────
// List all articles with an uncleared retraction impact, joined to their
// triggering source document, for the admin Source Health table.
router.get("/source-health", async (_req, res) => {
  const rows = await db
    .select({
      impactId: sourceRetractionImpactsTable.id,
      articleId: sourceRetractionImpactsTable.articleId,
      articleTitle: articlesTable.title,
      articleSlug: articlesTable.slug,
      articleStatus: articlesTable.status,
      sourceId: sourceRetractionImpactsTable.sourceDocumentId,
      sourceUrl: sourceDocumentsTable.url,
      sourceDomain: sourceDocumentsTable.domain,
      sourceTitle: sourceDocumentsTable.title,
      lifecycleStatus: sourceRetractionImpactsTable.lifecycleStatus,
      impactedAt: sourceRetractionImpactsTable.impactedAt,
      rescanAttemptedAt: sourceRetractionImpactsTable.rescanAttemptedAt,
      rescanResult: sourceRetractionImpactsTable.rescanResult,
      retractionImpactAt: articlesTable.retractionImpactAt,
      retractionImpactClearedAt: articlesTable.retractionImpactClearedAt,
    })
    .from(sourceRetractionImpactsTable)
    .innerJoin(articlesTable, eq(articlesTable.id, sourceRetractionImpactsTable.articleId))
    .leftJoin(
      sourceDocumentsTable,
      eq(sourceDocumentsTable.id, sourceRetractionImpactsTable.sourceDocumentId),
    )
    .where(isNull(articlesTable.retractionImpactClearedAt))
    .orderBy(desc(sourceRetractionImpactsTable.impactedAt));

  res.json({ impacts: rows });
});

// ── POST /admin/source-health/:articleId/rescan ────────────────────────────
// Trigger an on-demand rescan for a single article: check if it still has
// active trusted-tier sources and clear the flag if so.
router.post("/source-health/:articleId/rescan", async (req, res) => {
  const { articleId } = req.params;

  // Verify the article exists and is flagged.
  const article = await db
    .select({ id: articlesTable.id, retractionImpactClearedAt: articlesTable.retractionImpactClearedAt })
    .from(articlesTable)
    .where(and(eq(articlesTable.id, articleId), isNotNull(articlesTable.retractionImpactAt)))
    .limit(1);

  if (!article.length) {
    res.status(404).json({ error: "Article not found or not flagged" });
    return;
  }

  if (article[0].retractionImpactClearedAt) {
    res.status(409).json({ error: "Impact already cleared" });
    return;
  }

  // Re-use runRetractionRescan with a custom query scoped to this article.
  const { runSingleArticleRescan } = await import("../../services/retractionCascade");
  const result = await runSingleArticleRescan(articleId);

  res.json(result);
});

// ── POST /admin/source-health/:articleId/clear ─────────────────────────────
// Manually clear the retraction impact flag on an article. The editor is
// signing off that the article's evidence base is acceptable despite the
// retracted source.
router.post("/source-health/:articleId/clear", async (req, res) => {
  const { articleId } = req.params;
  const now = new Date();

  const updated = await db
    .update(articlesTable)
    .set({ retractionImpactClearedAt: now })
    .where(
      and(
        eq(articlesTable.id, articleId),
        isNotNull(articlesTable.retractionImpactAt),
        isNull(articlesTable.retractionImpactClearedAt),
      ),
    )
    .returning({ id: articlesTable.id });

  if (!updated.length) {
    res.status(404).json({ error: "Article not found or impact already cleared" });
    return;
  }

  // Record the manual clear on all impact rows for this article.
  await db
    .update(sourceRetractionImpactsTable)
    .set({ rescanAttemptedAt: now, rescanResult: "cleared" })
    .where(eq(sourceRetractionImpactsTable.articleId, articleId));

  res.json({ cleared: true, articleId });
});

export default router;
