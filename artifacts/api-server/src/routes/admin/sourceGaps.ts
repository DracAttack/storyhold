/**
 * Admin — Source Gap routes
 *
 * Scan published article bodies for unsourced claims, then search + ingest
 * the missing sources. All routes require requireAdmin (applied at router
 * level in routes/index.ts).
 */

import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  scanForSourceGaps,
  searchAndEnqueueGap,
  applyGapFill,
  listSourceGaps,
  getGapStats,
  dismissGap,
  markGapSourced,
  type GapListItem,
} from "../../services/sourceGapScanner";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

router.get("/source-gaps/stats", async (_req, res) => {
  res.json(await getGapStats());
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  status: z.string().optional(),
  articleId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

router.get("/source-gaps", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
    return;
  }
  const { items, total } = await listSourceGaps({
    status: parsed.data.status ?? null,
    articleId: parsed.data.articleId ?? null,
    limit: parsed.data.limit,
    offset: parsed.data.offset,
  });
  res.json({ items, total });
});

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

const scanSchema = z.object({
  dryRun: z.boolean().optional(),
  batchSize: z.number().int().min(1).max(50).optional(),
  maxGapsPerArticle: z.number().int().min(1).max(20).optional(),
});

router.post("/source-gaps/scan", async (req, res) => {
  const parsed = scanSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  try {
    const report = await scanForSourceGaps({
      dryRun: parsed.data.dryRun,
      batchSize: parsed.data.batchSize,
      maxGapsPerArticle: parsed.data.maxGapsPerArticle,
    });
    res.json(report);
  } catch (e) {
    req.log?.error({ err: e }, "source-gaps: scan failed");
    res.status(500).json({ error: "internal", message: e instanceof Error ? e.message : String(e) });
  }
});

// ---------------------------------------------------------------------------
// Search & ingest a single gap
// ---------------------------------------------------------------------------

const gapIdSchema = z.object({ id: z.string().uuid() });

router.post("/source-gaps/:id/search", async (req, res) => {
  const parsed = gapIdSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid gap id", issues: parsed.error.issues });
    return;
  }
  try {
    const result = await searchAndEnqueueGap(parsed.data.id);
    res.json(result);
  } catch (e) {
    req.log?.error({ err: e, gapId: parsed.data.id }, "source-gaps: search failed");
    res.status(500).json({ error: "internal", message: e instanceof Error ? e.message : String(e) });
  }
});

// ---------------------------------------------------------------------------
// Apply gap fill — weave link into article body + update trust box
// ---------------------------------------------------------------------------

router.post("/source-gaps/:id/apply", async (req, res) => {
  const parsed = gapIdSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid gap id", issues: parsed.error.issues });
    return;
  }
  try {
    const result = await applyGapFill(parsed.data.id);
    if (!result.applied) {
      const statusCode =
        result.reason === "not_found" || result.reason === "article_not_found" ? 404
        : result.reason === "wrong_status" ? 409
        : 200; // duplicate / phrase_not_in_body — informational, not an error
      res.status(statusCode).json(result);
      return;
    }
    res.json(result);
  } catch (e) {
    req.log?.error({ err: e, gapId: parsed.data.id }, "source-gaps: apply failed");
    res.status(500).json({ error: "internal", message: e instanceof Error ? e.message : String(e) });
  }
});

// ---------------------------------------------------------------------------
// Dismiss
// ---------------------------------------------------------------------------

const dismissSchema = z.object({
  reason: z.string().max(500).optional(),
});

router.post("/source-gaps/:id/dismiss", async (req, res) => {
  const params = gapIdSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid gap id", issues: params.error.issues });
    return;
  }
  const body = dismissSchema.safeParse(req.body ?? {});
  const ok = await dismissGap(params.data.id, body.success ? body.data.reason : undefined);
  if (!ok) {
    res.status(404).json({ error: "gap_not_found" });
    return;
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Mark sourced (link an already-ingested document)
// ---------------------------------------------------------------------------

const sourcedSchema = z.object({
  documentId: z.string().uuid(),
});

router.post("/source-gaps/:id/sourced", async (req, res) => {
  const params = gapIdSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid gap id", issues: params.error.issues });
    return;
  }
  const body = sourcedSchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: "Invalid body", issues: body.error.issues });
    return;
  }
  const ok = await markGapSourced(params.data.id, body.data.documentId);
  if (!ok) {
    res.status(404).json({ error: "gap_not_found" });
    return;
  }
  res.json({ ok: true });
});

export default router;
