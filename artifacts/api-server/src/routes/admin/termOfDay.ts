import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import type { TermOfDayPost } from "@workspace/db";
import {
  previewTermOfDay,
  runTermOfDay,
  postTermOfDayDraft,
  listTermOfDayHistory,
  type TermCandidate,
} from "../../services/termOfDay";

const router: IRouter = Router();

// Serialize a history row for the admin dashboard. Dates become ISO strings;
// the internal Zernio idempotency key (zernioRequestId) is intentionally NOT
// exposed.
function serialize(row: TermOfDayPost) {
  return {
    id: row.id,
    conceptId: row.conceptId,
    slug: row.slug,
    term: row.term,
    beatSlug: row.beatSlug,
    postDate: row.postDate,
    caption: row.caption,
    hashtags: Array.isArray(row.hashtags) ? (row.hashtags as string[]) : [],
    trackedUrl: row.trackedUrl,
    imageUrl: row.imageUrl,
    relatedArticleIds: Array.isArray(row.relatedArticleIds)
      ? (row.relatedArticleIds as string[])
      : [],
    selectionWeight: row.selectionWeight,
    weightBreakdown: Array.isArray(row.weightBreakdown) ? row.weightBreakdown : [],
    status: row.status,
    failureReason: row.failureReason,
    zernioPostId: row.zernioPostId,
    facebookPostUrl: row.facebookPostUrl,
    clicks: row.clicks,
    reactions: row.reactions,
    comments: row.comments,
    shares: row.shares,
    totalEngagement: row.totalEngagement,
    selectedAt: row.selectedAt ? row.selectedAt.toISOString() : null,
    scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeCandidate(c: TermCandidate) {
  return {
    conceptId: c.conceptId,
    slug: c.slug,
    term: c.term,
    definition: c.definition,
    hoverDefinition: c.hoverDefinition,
    moduleType: c.moduleType,
    cardImageUrl: c.cardImageUrl ?? null,
    beatSlug: c.beatSlug,
    publishedArticleCount: c.publishedArticleCount,
    lastPostedDate: c.lastPostedDate,
    weight: c.weight,
    breakdown: c.breakdown,
  };
}

const previewQuerySchema = z.object({
  // Comma-separated glossary slugs already seen this session (reroll support).
  exclude: z.string().optional(),
});

// Preview today's pick exactly as the daily run would build it — read-only,
// nothing is written. `exclude` powers reroll: pass previously shown slugs to
// force a fresh term.
router.get("/term-of-day/preview", async (req, res) => {
  const parsed = previewQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters." });
    return;
  }
  const excludeSlugs = (parsed.data.exclude ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const p = await previewTermOfDay(excludeSlugs);
  res.json({
    candidate: p.candidate ? serializeCandidate(p.candidate) : null,
    caption: p.caption,
    hashtags: p.hashtags,
    trackedUrl: p.trackedUrl,
    poolSize: p.poolSize,
    topCandidates: p.topCandidates.map(serializeCandidate),
  });
});

// Run today's Term of the Day immediately (force = bypasses the enabled
// toggle, NOT the date claim — a second run on the same date is rejected).
router.post("/term-of-day/queue-now", async (req, res) => {
  const slug = typeof req.body?.slug === "string" ? req.body.slug : undefined;
  const result = await runTermOfDay(new Date(), { force: true, slug });
  if (result.status === "failed") {
    res.status(502).json(result);
    return;
  }
  if (result.status === "skipped" && result.reason === "already_claimed_today") {
    res.status(409).json(result);
    return;
  }
  res.json(result);
});

// Send an existing draft row to Zernio (atomic draft → posting claim).
router.post("/term-of-day/posts/:id/post", async (req, res) => {
  const id = String(req.params.id ?? "");
  if (!id) {
    res.status(400).json({ error: "id is required." });
    return;
  }
  const force = Boolean(req.body?.force);
  const result = await postTermOfDayDraft(id, { force });
  if (result.status === "failed") {
    res.status(502).json(result);
    return;
  }
  if (result.status === "skipped") {
    res.status(409).json(result);
    return;
  }
  res.json(result);
});

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// Post history, newest first.
router.get("/term-of-day/history", async (req, res) => {
  const parsed = historyQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters." });
    return;
  }
  const { rows, total } = await listTermOfDayHistory(
    parsed.data.limit ?? 30,
    parsed.data.offset ?? 0,
  );
  res.json({ total, items: rows.map(serialize) });
});

export default router;
