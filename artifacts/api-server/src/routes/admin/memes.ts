import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import type { Meme, MemeTemplate, MemeTextArea } from "@workspace/db";
import {
  createOrLoadMeme,
  getMeme,
  getMemeArticleContext,
  MemeArtworkMissingError,
  generateConceptsForMeme,
  selectConcept,
  regenerateExplainerSummary,
  regenerateVisualPrompt,
  updateMemeFields,
  buildMemePreview,
  autoPlaceMemeText,
  setAttemptOverride,
  listMemes,
  listMemeTemplates,
  deleteMeme,
  uploadMemeOriginalDataUrl,
  regenerateMemeSocialPack,
  selectMemeArtwork,
  deleteMemeArtwork,
  createMemeTemplate,
  saveMemeAsTemplate,
  updateMemeTemplate,
  disableMemeTemplate,
  type MemeEditableFields,
} from "../../services/memes";
import {
  approveMeme,
  postMeme,
  repostMeme,
  MemeNotPostableError,
  listMemeQueue,
  rescheduleMeme,
  unqueueMeme,
} from "../../services/memeQueue";
import { AiFunctionDisabledError } from "../../services/llm";
import { NoImageDataError } from "@workspace/integrations-gemini-ai/image";

const router: IRouter = Router();

// Serialize a meme row for the admin editor. Internal idempotency key
// (zernioRequestId) is intentionally NOT exposed.
function serialize(m: Meme, extra?: { articleDek: string | null; articleHeroImage: string | null }) {
  return {
    id: m.id,
    articleId: m.articleId,
    articleTitle: m.articleTitle,
    articleUrl: m.articleUrl,
    articleDek: extra?.articleDek ?? null,
    articleHeroImage: extra?.articleHeroImage ?? null,
    category: m.category,
    concepts: m.concepts ?? null,
    selectedConceptIndex: m.selectedConceptIndex,
    jokeDescription: m.jokeDescription,
    sourceType: m.sourceType,
    templateId: m.templateId,
    layout: m.layout,
    topText: m.topText,
    bottomText: m.bottomText,
    extraText: m.extraText,
    extraTextPosition: m.extraTextPosition,
    extraTextIdeas: m.extraTextIdeas ?? [],
    captionTopOffsetAdj: m.captionTopOffsetAdj,
    captionBottomOffsetAdj: m.captionBottomOffsetAdj,
    captionTopSizeAdj: m.captionTopSizeAdj,
    captionBottomSizeAdj: m.captionBottomSizeAdj,
    brandLogoCorner: m.brandLogoCorner,
    brandUrlCorner: m.brandUrlCorner,
    brandLogoOffsetXAdj: m.brandLogoOffsetXAdj,
    brandLogoOffsetYAdj: m.brandLogoOffsetYAdj,
    brandUrlOffsetXAdj: m.brandUrlOffsetXAdj,
    brandUrlOffsetYAdj: m.brandUrlOffsetYAdj,
    artStyle: m.artStyle,
    visualPrompt: m.visualPrompt,
    originalImageUrl: m.originalImageUrl,
    composedImageUrl: m.composedImageUrl,
    artworkHistory: m.artworkHistory ?? [],
    socialHook: m.socialHook,
    socialSummary: m.socialSummary,
    socialCta: m.socialCta,
    canonicalUrl: m.canonicalUrl,
    caption: m.caption,
    hashtags: m.hashtags,
    status: m.status,
    attemptCount: m.attemptCount,
    attemptOverride: m.attemptOverride,
    allowPublicFigures: m.allowPublicFigures,
    estimatedCostUsd: m.estimatedCostUsd,
    lastError: m.lastError,
    scheduledAt: m.scheduledAt ? m.scheduledAt.toISOString() : null,
    approvedAt: m.approvedAt ? m.approvedAt.toISOString() : null,
    zernioPostId: m.zernioPostId,
    facebookPostUrl: m.facebookPostUrl,
    postedAt: m.postedAt ? m.postedAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

function serializeTemplate(t: MemeTemplate) {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    imageUrl: t.imageUrl,
    layout: t.layout,
    sourceNotes: t.sourceNotes,
    licenseNotes: t.licenseNotes,
    textAreas: t.textAreas,
    recommendedFieldCount: t.recommendedFieldCount,
    defaultFont: t.defaultFont,
    defaultAlignment: t.defaultAlignment,
    active: t.active,
    isCurated: t.isCurated,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

// Create (or load the existing draft) meme for an article — the "Create Meme" entry.
router.post("/articles/:id/meme", async (req, res) => {
  try {
    const meme = await createOrLoadMeme(req.params.id);
    res.json(serialize(meme));
  } catch {
    res.status(404).json({ error: "Article not found." });
  }
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  articleId: z.string().optional(),
});

router.get("/memes", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  const limit = parsed.success ? parsed.data.limit : undefined;
  const articleId = parsed.success ? parsed.data.articleId : undefined;
  const items = await listMemes(limit, articleId);
  res.json({ total: items.length, items: items.map((m) => serialize(m)) });
});

// Literal /memes/queue must be registered before /memes/:id.
router.get("/memes/queue", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  const limit = parsed.success ? parsed.data.limit : undefined;
  const items = await listMemeQueue(limit);
  res.json({ total: items.length, items: items.map((m) => serialize(m)) });
});

router.get("/memes/:id", async (req, res) => {
  const meme = await getMeme(req.params.id);
  if (!meme) {
    res.status(404).json({ error: "Meme not found." });
    return;
  }
  const context = await getMemeArticleContext(meme);
  res.json(serialize(meme, context));
});

router.delete("/memes/:id", async (req, res) => {
  try {
    const ok = await deleteMeme(req.params.id);
    if (!ok) {
      res.status(404).json({ error: "Meme not found." });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : "Cannot delete meme." });
  }
});

router.post("/memes/:id/concepts", async (req, res) => {
  const meme = await getMeme(req.params.id);
  if (!meme) {
    res.status(404).json({ error: "Meme not found." });
    return;
  }
  try {
    const concepts = await generateConceptsForMeme(req.params.id);
    res.json({ concepts });
  } catch (err) {
    if (err instanceof AiFunctionDisabledError) {
      res.status(409).json({ error: "Concept generation is turned off." });
      return;
    }
    req.log.error({ err }, "meme concept generation failed");
    res.status(409).json({ error: "Concept generation failed. Try again." });
  }
});

const selectConceptSchema = z.object({ index: z.number().int().min(0) });
router.post("/memes/:id/select-concept", async (req, res) => {
  const parsed = selectConceptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "index is required." });
    return;
  }
  try {
    res.json(serialize(await selectConcept(req.params.id, parsed.data.index)));
  } catch {
    res.status(404).json({ error: "Meme not found." });
  }
});

// Switch a meme to the explainer layout and regenerate its bottom text into the
// 1-2 paragraph article summary that layout expects (grounded in the body, kept
// tied to the meme's joke/kicker). Used when an admin picks "explainer" for a
// meme whose bottom text is still a one-line punchline.
router.post("/memes/:id/explainer-summary", async (req, res) => {
  try {
    res.json(serialize(await regenerateExplainerSummary(req.params.id)));
  } catch (err) {
    if (err instanceof AiFunctionDisabledError) {
      res.status(409).json({ error: "Meme summary generation is turned off." });
      return;
    }
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("not found")) {
      res.status(404).json({ error: "Meme not found." });
      return;
    }
    if (msg.includes("can no longer be edited")) {
      res.status(409).json({ error: msg });
      return;
    }
    req.log.error({ err }, "meme explainer summary generation failed");
    res.status(409).json({ error: "Summary generation failed. Try again." });
  }
});

// Regenerate ONLY the meme's visual prompt (text-free background scene), with an
// optional direction slant. Leaves the on-image meme text untouched.
const regenerateVisualPromptSchema = z.object({
  direction: z
    .enum(["realistic", "people", "objects", "cartoon", "political_cartoon"])
    .optional(),
});
router.post("/memes/:id/regenerate-visual-prompt", async (req, res) => {
  const parsed = regenerateVisualPromptSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid direction." });
    return;
  }
  try {
    res.json(serialize(await regenerateVisualPrompt(req.params.id, parsed.data.direction)));
  } catch (err) {
    if (err instanceof AiFunctionDisabledError) {
      res.status(409).json({ error: "Visual prompt generation is turned off." });
      return;
    }
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("not found")) {
      res.status(404).json({ error: "Meme not found." });
      return;
    }
    if (msg.includes("can no longer be edited")) {
      res.status(409).json({ error: msg });
      return;
    }
    req.log.error({ err }, "meme visual prompt generation failed");
    res.status(409).json({ error: "Visual prompt generation failed. Try again." });
  }
});

// Force-rewrite the meme's Facebook caption / social pack (hook, summary, CTA,
// caption, hashtags). Used from the Social Queue to fix memes that reached the
// queue with empty copy. 409 when the social_caption AI function is paused.
router.post("/memes/:id/regenerate-social-pack", async (req, res) => {
  try {
    res.json(serialize(await regenerateMemeSocialPack(req.params.id)));
  } catch (err) {
    if (err instanceof AiFunctionDisabledError) {
      res.status(409).json({ error: "Caption generation is turned off." });
      return;
    }
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("not found")) {
      res.status(404).json({ error: "Meme not found." });
      return;
    }
    if (msg.includes("can no longer be regenerated") || msg.includes("article context unavailable")) {
      res.status(409).json({ error: msg });
      return;
    }
    req.log.error({ err }, "meme social pack regeneration failed");
    res.status(409).json({ error: "Caption generation failed. Try again." });
  }
});

const updateSchema = z.object({
  sourceType: z.string().optional(),
  templateId: z.string().nullable().optional(),
  layout: z.string().optional(),
  topText: z.string().optional(),
  bottomText: z.string().optional(),
  extraText: z.string().optional(),
  extraTextPosition: z.enum(["middle", "bottom"]).optional(),
  captionTopOffsetAdj: z.number().int().min(-200).max(400).optional(),
  captionBottomOffsetAdj: z.number().int().min(-200).max(400).optional(),
  captionTopSizeAdj: z.number().int().min(-60).max(100).optional(),
  captionBottomSizeAdj: z.number().int().min(-60).max(100).optional(),
  brandLogoCorner: z
    .enum(["auto", "top_left", "top_right", "bottom_left", "bottom_right"])
    .optional(),
  brandUrlCorner: z
    .enum(["auto", "top_left", "top_right", "bottom_left", "bottom_right"])
    .optional(),
  brandLogoOffsetXAdj: z.number().int().min(-480).max(480).optional(),
  brandLogoOffsetYAdj: z.number().int().min(-480).max(480).optional(),
  brandUrlOffsetXAdj: z.number().int().min(-480).max(480).optional(),
  brandUrlOffsetYAdj: z.number().int().min(-480).max(480).optional(),
  artStyle: z.enum(["auto", "photographic", "cartoon", "illustration"]).optional(),
  visualPrompt: z.string().optional(),
  socialHook: z.string().optional(),
  socialSummary: z.string().optional(),
  socialCta: z.string().optional(),
  caption: z.string().optional(),
  hashtags: z.array(z.string()).optional(),
  allowPublicFigures: z.boolean().optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
});
router.patch("/memes/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid meme fields." });
    return;
  }
  const { scheduledAt, ...rest } = parsed.data;
  const fields: MemeEditableFields = {
    ...rest,
    sourceType: rest.sourceType as MemeEditableFields["sourceType"],
    layout: rest.layout as MemeEditableFields["layout"],
  };
  if (scheduledAt !== undefined) fields.scheduledAt = scheduledAt ? new Date(scheduledAt) : null;
  try {
    res.json(serialize(await updateMemeFields(req.params.id, fields)));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("not found")) {
      res.status(404).json({ error: "Meme not found." });
      return;
    }
    res.status(409).json({ error: msg || "Meme can no longer be edited." });
  }
});

const uploadSchema = z.object({ dataUrl: z.string().min(1) });
router.post("/memes/:id/upload-image", async (req, res) => {
  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "dataUrl is required." });
    return;
  }
  const meme = await getMeme(req.params.id);
  if (!meme) {
    res.status(404).json({ error: "Meme not found." });
    return;
  }
  try {
    res.json(serialize(await uploadMemeOriginalDataUrl(req.params.id, parsed.data.dataUrl)));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Upload failed." });
  }
});

// View/restore/delete previously-generated artwork versions (the slideshow).
const artworkRefSchema = z.object({ originalImageUrl: z.string().min(1) });

router.post("/memes/:id/select-artwork", async (req, res) => {
  const parsed = artworkRefSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "originalImageUrl is required." });
    return;
  }
  try {
    res.json(serialize(await selectMemeArtwork(req.params.id, parsed.data.originalImageUrl)));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("not found")) {
      res.status(404).json({ error: msg });
      return;
    }
    res.status(409).json({ error: msg || "Could not restore artwork." });
  }
});

router.post("/memes/:id/delete-artwork", async (req, res) => {
  const parsed = artworkRefSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "originalImageUrl is required." });
    return;
  }
  try {
    res.json(serialize(await deleteMemeArtwork(req.params.id, parsed.data.originalImageUrl)));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("not found")) {
      res.status(404).json({ error: msg });
      return;
    }
    res.status(409).json({ error: msg || "Could not delete artwork." });
  }
});

const saveAsTemplateSchema = z.object({ name: z.string().optional() });

// Save a generated meme's base artwork as a reusable preset/template. Reuses the
// meme's stored base image (no AI re-bill, no client upload round-trip).
router.post("/memes/:id/save-as-template", async (req, res) => {
  const parsed = saveAsTemplateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  const meme = await getMeme(req.params.id);
  if (!meme) {
    res.status(404).json({ error: "Meme not found." });
    return;
  }
  try {
    const tpl = await saveMemeAsTemplate(req.params.id, parsed.data.name);
    res.json(serializeTemplate(tpl));
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : "Could not save as preset." });
  }
});

// Shared error→status mapping for both the free recompose and the paid
// regenerate-artwork endpoints (they call the same orchestrator).
function handleMemeBuildError(req: Request, res: Response, err: unknown): void {
  if (err instanceof AiFunctionDisabledError) {
    res.status(409).json({ error: "Artwork generation is turned off." });
    return;
  }
  if (err instanceof MemeArtworkMissingError) {
    res.status(409).json({ error: "Generate AI artwork before composing." });
    return;
  }
  const msg = err instanceof Error ? err.message : "";
  if (msg.includes("attempt")) {
    res.status(409).json({ error: msg });
    return;
  }
  if (err instanceof NoImageDataError) {
    res.status(422).json({ error: "The model refused to generate this image. Edit the prompt and try again." });
    return;
  }
  req.log.error({ err }, "meme build failed");
  res.status(422).json({ error: msg || "Image generation failed." });
}

// Free recompose — re-renders text onto the existing base image. For AI memes it
// reuses the stored artwork (no model call, no billing). The very first AI build
// must use the regenerate-artwork endpoint.
router.post("/memes/:id/preview", async (req, res) => {
  try {
    const meme = await getMeme(req.params.id);
    if (!meme) {
      res.status(404).json({ error: "Meme not found." });
      return;
    }
    res.json(serialize(await buildMemePreview(req.params.id)));
  } catch (err) {
    handleMemeBuildError(req, res, err);
  }
});

// Paid path — (re)generates the AI artwork, then composes. Only meaningful for
// ai_generated memes; for other sources it behaves like a normal compose.
router.post("/memes/:id/regenerate-artwork", async (req, res) => {
  try {
    const meme = await getMeme(req.params.id);
    if (!meme) {
      res.status(404).json({ error: "Meme not found." });
      return;
    }
    res.json(serialize(await buildMemePreview(req.params.id, { regenerateArtwork: true })));
  } catch (err) {
    handleMemeBuildError(req, res, err);
  }
});

// Smart auto-place — a vision pass over the stored base image writes recommended
// caption offset/size nudges then recomposes for free (no image re-bill). Reuses
// the same error→status mapping as the recompose path.
router.post("/memes/:id/auto-place-text", async (req, res) => {
  try {
    const meme = await getMeme(req.params.id);
    if (!meme) {
      res.status(404).json({ error: "Meme not found." });
      return;
    }
    res.json(serialize(await autoPlaceMemeText(req.params.id)));
  } catch (err) {
    handleMemeBuildError(req, res, err);
  }
});

const overrideSchema = z.object({ override: z.boolean() });
router.post("/memes/:id/attempt-override", async (req, res) => {
  const parsed = overrideSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "override is required." });
    return;
  }
  try {
    res.json(serialize(await setAttemptOverride(req.params.id, parsed.data.override)));
  } catch {
    res.status(404).json({ error: "Meme not found." });
  }
});

const approveSchema = z.object({
  scheduledAt: z.string().datetime().nullable().optional(),
  duplicate: z.boolean().optional(),
});
router.post("/memes/:id/approve", async (req, res) => {
  const parsed = approveSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, reason: "invalid_input" });
    return;
  }
  const when = parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null;
  const result = await approveMeme(req.params.id, {
    scheduledAt: when,
    duplicate: parsed.data.duplicate,
  });
  const body = {
    ok: result.status === "queued" || result.status === "already_queued",
    reason: result.reason,
    meme: result.meme ? serialize(result.meme) : undefined,
  };
  if (result.status === "rejected") {
    res.status(result.reason === "not_found" ? 404 : 409).json(body);
    return;
  }
  res.json(body);
});

router.post("/memes/:id/post", async (req, res) => {
  const result = await postMeme(req.params.id, { force: true });
  res.json(result);
});

// Repost an already-built meme: duplicates it (fresh idempotency key) and
// force-posts the copy, so a posted meme can be recirculated to Facebook again
// without disturbing the original. 422 if there's no finished image to repost.
router.post("/memes/:id/repost", async (req, res) => {
  try {
    const { memeId, result } = await repostMeme(req.params.id);
    res.json({ ...result, memeId });
  } catch (err) {
    if (err instanceof MemeNotPostableError) {
      res.status(422).json({ error: err.message });
      return;
    }
    throw err;
  }
});

const rescheduleSchema = z.object({ scheduledAt: z.string().datetime().nullable() });
router.post("/memes/:id/reschedule", async (req, res) => {
  const parsed = rescheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "scheduledAt must be an ISO datetime or null." });
    return;
  }
  const when = parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null;
  const meme = await rescheduleMeme(req.params.id, when);
  if (!meme) {
    res.status(404).json({ error: "Meme not found." });
    return;
  }
  res.json(serialize(meme));
});

// Pull a queued meme back out of the posting queue (reverts to "generated").
router.post("/memes/:id/unqueue", async (req, res) => {
  const meme = await unqueueMeme(req.params.id);
  if (!meme) {
    res.status(409).json({ error: "Meme is not queued and cannot be unqueued." });
    return;
  }
  res.json(serialize(meme));
});

// --- Template library ---

const templateListQuerySchema = z.object({
  includeInactive: z.coerce.boolean().optional(),
});
router.get("/meme-templates", async (req, res) => {
  const parsed = templateListQuerySchema.safeParse(req.query);
  const includeInactive = parsed.success ? parsed.data.includeInactive : false;
  const items = await listMemeTemplates(includeInactive);
  res.json({ total: items.length, items: items.map(serializeTemplate) });
});

const textAreaSchema = z.object({
  key: z.string(),
  label: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  fontSize: z.number(),
  align: z.enum(["left", "center", "right"]),
  valign: z.enum(["top", "middle", "bottom"]),
  color: z.string(),
  outline: z.boolean(),
  uppercase: z.boolean(),
});

const createTemplateSchema = z.object({
  name: z.string().min(1),
  dataUrl: z.string().min(1),
  layout: z.string().optional(),
  sourceNotes: z.string().optional(),
  licenseNotes: z.string().optional(),
  recommendedFieldCount: z.number().int().min(1).max(8).optional(),
  textAreas: z.array(textAreaSchema).optional(),
});
router.post("/meme-templates", async (req, res) => {
  const parsed = createTemplateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "name and dataUrl are required." });
    return;
  }
  try {
    const tpl = await createMemeTemplate({
      ...parsed.data,
      textAreas: parsed.data.textAreas as MemeTextArea[] | undefined,
    });
    res.json(serializeTemplate(tpl));
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : "Could not create template." });
  }
});

const updateTemplateSchema = z.object({
  name: z.string().min(1).optional(),
  dataUrl: z.string().optional(),
  layout: z.string().optional(),
  sourceNotes: z.string().optional(),
  licenseNotes: z.string().optional(),
  recommendedFieldCount: z.number().int().min(1).max(8).optional(),
  active: z.boolean().optional(),
  textAreas: z.array(textAreaSchema).optional(),
});
router.patch("/meme-templates/:id", async (req, res) => {
  const parsed = updateTemplateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid template fields." });
    return;
  }
  const tpl = await updateMemeTemplate(req.params.id, {
    ...parsed.data,
    textAreas: parsed.data.textAreas as MemeTextArea[] | undefined,
  });
  if (!tpl) {
    res.status(404).json({ error: "Template not found." });
    return;
  }
  res.json(serializeTemplate(tpl));
});

router.post("/meme-templates/:id/disable", async (req, res) => {
  const tpl = await disableMemeTemplate(req.params.id);
  if (!tpl) {
    res.status(404).json({ error: "Template not found." });
    return;
  }
  res.json(serializeTemplate(tpl));
});

export default router;
