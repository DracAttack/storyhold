import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import type { SocialQueueItem } from "@workspace/db";
import {
  listQueueItems,
  getQueueStatus,
  enqueueBackCatalog,
  enqueueArticle,
  testConnection,
  activateQueue,
  pauseQueue,
  resumeQueue,
  postQueueItem,
  skipItem,
  pauseItem,
  resetItem,
  rescheduleItem,
  reorderItem,
  editCaption,
  editFields,
  ensureSocialPack,
  wipeQueue,
  clearPendingCaptionsForRegen,
} from "../../services/socialQueue";

const router: IRouter = Router();

// Serialize a queue row for the admin dashboard. Dates become ISO strings; the
// internal Zernio idempotency key (zernioRequestId) is intentionally NOT exposed.
function serialize(item: SocialQueueItem) {
  return {
    id: item.id,
    articleId: item.articleId,
    articleUrl: item.articleUrl,
    articleTitle: item.articleTitle,
    category: item.category,
    // Unified social-post vocabulary (shared with the meme system).
    mediaType: item.mediaType,
    sourceType: item.sourceType,
    memeId: item.memeId,
    platform: item.platform,
    imageUrl: item.imageUrl,
    socialHook: item.socialHook,
    articleSummary: item.articleSummary,
    callToAction: item.callToAction,
    caption: item.caption,
    selectedPlatformCaption: item.selectedPlatformCaption,
    hashtags: Array.isArray(item.hashtags) ? (item.hashtags as string[]) : [],
    queueStatus: item.queueStatus,
    attemptCount: item.attemptCount,
    scheduledAt: item.scheduledAt ? item.scheduledAt.toISOString() : null,
    scheduledTimezone: item.scheduledTimezone,
    zernioPostId: item.zernioPostId,
    // Unified alias of the external post id (platform-agnostic name).
    platformPostId: item.zernioPostId,
    facebookPostUrl: item.facebookPostUrl,
    postedAt: item.postedAt ? item.postedAt.toISOString() : null,
    postedViaOverride: item.postedViaOverride,
    lastError: item.lastError,
    sortKey: item.sortKey,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

const listQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// List queue items with optional status filter + pagination.
router.get("/social-queue", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters." });
    return;
  }
  const { items, total } = await listQueueItems(parsed.data);
  res.json({ total, items: items.map(serialize) });
});

// Aggregate status counts + global flags for the dashboard header.
router.get("/social-queue/status", async (_req, res) => {
  res.json(await getQueueStatus());
});

// Verify the Zernio connection (never returns the api key or account id).
router.get("/social-queue/connection-test", async (_req, res) => {
  res.json(await testConnection());
});

// Enqueue the published back catalogue (idempotent).
router.post("/social-queue/enqueue", async (_req, res) => {
  res.json(await enqueueBackCatalog());
});

// Enqueue a single article as a complete snapshot with an auto-generated social
// pack. Blocks a duplicate ACTIVE item for the same article unless allowDuplicate.
const enqueueArticleSchema = z.object({
  articleId: z.string().min(1),
  allowDuplicate: z.boolean().optional(),
  platform: z.string().optional(),
});
router.post("/social-queue/enqueue-article", async (req, res) => {
  const parsed = enqueueArticleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "articleId is required." });
    return;
  }
  const result = await enqueueArticle(parsed.data.articleId, {
    ...(parsed.data.allowDuplicate !== undefined ? { allowDuplicate: parsed.data.allowDuplicate } : {}),
    ...(parsed.data.platform ? { platform: parsed.data.platform } : {}),
  });
  if (result.status === "not_found") {
    res.status(404).json(result);
    return;
  }
  if (result.status === "not_publishable") {
    res.status(409).json(result);
    return;
  }
  if (result.status === "duplicate") {
    res.status(409).json(result);
    return;
  }
  res.json(result);
});

// Clear captions for all pending items so they are regenerated with the current
// prompt on the next cron tick. Useful after a prompt update when existing
// stored captions reflect the old phrasing.
router.post("/social-queue/regenerate-all-captions", async (req, res) => {
  const cleared = await clearPendingCaptionsForRegen();
  req.log?.info({ cleared }, "social-queue: cleared pending captions for regen");
  res.json({ cleared });
});

// Wipe the queue: delete every non-posted item (posted items stay in History).
router.post("/social-queue/wipe", async (_req, res) => {
  res.json(await wipeQueue());
});

// Activate the queue (guarded: needs verified connection + an approved test post).
router.post("/social-queue/activate", async (_req, res) => {
  const result = await activateQueue();
  if (!result.activated) {
    res.status(409).json(result);
    return;
  }
  res.json(result);
});

router.post("/social-queue/pause", async (_req, res) => {
  await pauseQueue();
  res.json({ ok: true });
});

router.post("/social-queue/resume", async (_req, res) => {
  await resumeQueue();
  res.json({ ok: true });
});

// Post a single item right now (force — used for the approved test post + retries).
router.post("/social-queue/:id/post", async (req, res) => {
  const result = await postQueueItem(req.params.id, { force: true });
  res.json(result);
});

router.post("/social-queue/:id/skip", async (req, res) => {
  try {
    res.json(serialize(await skipItem(req.params.id)));
  } catch {
    res.status(404).json({ error: "Queue item not found." });
  }
});

router.post("/social-queue/:id/pause", async (req, res) => {
  try {
    res.json(serialize(await pauseItem(req.params.id)));
  } catch {
    res.status(404).json({ error: "Queue item not found." });
  }
});

router.post("/social-queue/:id/reset", async (req, res) => {
  try {
    res.json(serialize(await resetItem(req.params.id)));
  } catch {
    res.status(404).json({ error: "Queue item not found." });
  }
});

const rescheduleSchema = z.object({ scheduledAt: z.string().datetime().nullable() });
router.post("/social-queue/:id/reschedule", async (req, res) => {
  const parsed = rescheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "scheduledAt must be an ISO datetime or null." });
    return;
  }
  try {
    const when = parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null;
    res.json(serialize(await rescheduleItem(req.params.id, when)));
  } catch {
    res.status(404).json({ error: "Queue item not found." });
  }
});

const reorderSchema = z.object({ sortKey: z.number() });
router.post("/social-queue/:id/reorder", async (req, res) => {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "sortKey must be a number." });
    return;
  }
  try {
    res.json(serialize(await reorderItem(req.params.id, parsed.data.sortKey)));
  } catch {
    res.status(404).json({ error: "Queue item not found." });
  }
});

const captionSchema = z.object({ caption: z.string().min(1).max(2500) });
router.post("/social-queue/:id/caption", async (req, res) => {
  const parsed = captionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "caption is required." });
    return;
  }
  try {
    res.json(serialize(await editCaption(req.params.id, parsed.data.caption.trim())));
  } catch {
    res.status(404).json({ error: "Queue item not found." });
  }
});

// (Re)generate the full social pack from the live article body. Clears the
// existing caption first so this always rewrites. Returns 409 when caption AI is
// paused. The regenerated copy is snapshotted onto the item.
router.post("/social-queue/:id/generate-caption", async (req, res) => {
  try {
    await editCaption(req.params.id, " ");
  } catch {
    res.status(404).json({ error: "Queue item not found." });
    return;
  }
  const caption = await ensureSocialPack(req.params.id);
  if (!caption) {
    res.status(409).json({ error: "Caption generation is unavailable or turned off." });
    return;
  }
  res.json({ caption });
});

// Edit the snapshot social-post fields (hook/summary/CTA/caption/platform
// caption/hashtags/platform). Only provided fields change.
const editFieldsSchema = z
  .object({
    socialHook: z.string().max(500).nullable().optional(),
    articleSummary: z.string().max(2000).nullable().optional(),
    callToAction: z.string().max(500).nullable().optional(),
    caption: z.string().max(2500).nullable().optional(),
    selectedPlatformCaption: z.string().max(2500).nullable().optional(),
    hashtags: z.array(z.string().max(100)).max(30).nullable().optional(),
    platform: z.string().min(1).max(40).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field is required." });
router.post("/social-queue/:id/fields", async (req, res) => {
  const parsed = editFieldsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid fields." });
    return;
  }
  try {
    res.json(serialize(await editFields(req.params.id, parsed.data)));
  } catch {
    res.status(404).json({ error: "Queue item not found." });
  }
});

export default router;
