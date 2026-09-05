import { db } from "@workspace/db";
import {
  memesTable,
  memeTemplatesTable,
  articlesTable,
  type Meme,
  type MemeArtworkVersion,
  type MemeConcept,
  type MemeLayout,
  type MemeSourceType,
  type MemeExtraTextPosition,
  type MemeArtStyle,
  type MemeBrandCorner,
  type MemeTemplate,
  type MemeTextArea,
  type ArticleBlock,
} from "@workspace/db";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { logger } from "../lib/logger";
import { siteUrl } from "./emailShared";
import { findPublicObject } from "../lib/objectStorage";
import { getDefaultDirective } from "./aiRegistry";
import { resolveDirective, isAiFunctionEnabled } from "./aiSettings";
import { recordImageUsage, IMAGE_USD } from "./aiUsage";
import {
  generateMemeConcepts,
  generateMemeExplainerSummary,
  generateMemeVisualScene,
  generateArticleSocialPost,
  suggestMemeTextPlacement,
  AiFunctionDisabledError,
  type MemeVisualDirection,
} from "./llm";
import { NoImageDataError } from "@workspace/integrations-gemini-ai/image";
import {
  generateMemeArtwork,
  composeMeme,
  uploadMemeOriginal,
  uploadComposedMeme,
  uploadTemplateImage,
} from "./memeImage";
import { MEME_LAYOUTS } from "@workspace/db";

// Paid AI-artwork attempts allowed before an admin must explicitly override. Each
// attempt is a billed Nano Banana Pro generation (~$0.13), so we cap to avoid a
// runaway spend on a meme the model keeps refusing.
const MAX_AI_ATTEMPTS = 3;

const PUBLIC_OBJECT_PREFIX = "/api/storage/public-objects/";

/** Flatten an article body into plain text for concept grounding. */
function blocksToText(body: ArticleBlock[]): string {
  return body
    .filter((b) => b.type === "paragraph" || b.type === "heading" || b.type === "pullquote")
    .map((b) => b.content)
    .join("\n\n")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Download the bytes of a stored public object given its served URL path
 * (`/api/storage/public-objects/...`). Returns null when the URL is external or
 * the object is missing. Used to reuse the article hero image or a template base
 * as a meme's base image (mirrors the share-card backfill download pattern).
 */
async function downloadPublicObject(url: string): Promise<Buffer | null> {
  if (!url.startsWith(PUBLIC_OBJECT_PREFIX)) return null;
  const rawPath = url.slice(PUBLIC_OBJECT_PREFIX.length).split(/[?#]/)[0] ?? "";
  let filePath = rawPath;
  try {
    filePath = decodeURIComponent(rawPath);
  } catch {
    filePath = rawPath;
  }
  const file = await findPublicObject(filePath);
  if (!file) return null;
  const [buf] = await file.download();
  return buf;
}

interface ArticleContext {
  id: string;
  slug: string;
  title: string;
  dek: string;
  category: string;
  bodyText: string;
  heroImage: string;
}

async function loadArticleContext(articleId: string): Promise<ArticleContext | null> {
  const [a] = await db
    .select({
      id: articlesTable.id,
      slug: articlesTable.slug,
      title: articlesTable.title,
      dek: articlesTable.dek,
      category: articlesTable.category,
      body: articlesTable.body,
      heroImage: articlesTable.heroImage,
    })
    .from(articlesTable)
    .where(eq(articlesTable.id, articleId))
    .limit(1);
  if (!a) return null;
  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    dek: a.dek,
    category: a.category,
    bodyText: blocksToText(a.body),
    heroImage: a.heroImage,
  };
}

/**
 * Create a fresh draft meme for an article, or return the most recent
 * still-editable (draft/generated/failed) meme so re-opening the builder resumes
 * work instead of stacking duplicates. Approved/queued/posted memes are terminal
 * for editing, so those never block a new build.
 */
export async function createOrLoadMeme(articleId: string): Promise<Meme> {
  const article = await loadArticleContext(articleId);
  if (!article) throw new Error("article not found");

  const [existing] = await db
    .select()
    .from(memesTable)
    .where(eq(memesTable.articleId, articleId))
    .orderBy(desc(memesTable.createdAt))
    .limit(1);
  if (existing && (existing.status === "draft" || existing.status === "generated" || existing.status === "failed")) {
    return existing;
  }

  const articleUrl = siteUrl(`/article/${article.slug}`);
  const [created] = await db
    .insert(memesTable)
    .values({
      articleId: article.id,
      articleTitle: article.title,
      articleUrl,
      canonicalUrl: articleUrl,
      category: article.category,
      // Snapshot the article body at build time so post-time caption fallback
      // reads built-from content, not the live (possibly edited) article.
      sourceSnapshot: article.bodyText,
      // Default new memes to a realistic, photographic render ("AI photo") rather
      // than letting the model pick the medium per-scene. Set explicitly here so
      // the default applies on both dev and prod regardless of the column default.
      artStyle: "photographic",
      // Default new memes to AI-generated artwork rather than a curated template.
      // Set explicitly so the default holds on both dev and prod regardless of the
      // column default; admins can still switch to a curated template or upload.
      sourceType: "ai_generated",
      status: "draft",
    })
    .returning();
  if (!created) throw new Error("failed to create meme");
  return created;
}

/** Fetch a single meme by id (or null). */
export async function getMeme(memeId: string): Promise<Meme | null> {
  const [row] = await db.select().from(memesTable).where(eq(memesTable.id, memeId)).limit(1);
  return row ?? null;
}

/**
 * Editor context for a meme's source article — the excerpt (dek) and current
 * hero image — so the builder can show what it's memeing without a second fetch.
 * Returns nulls when the article is gone (memes outlive deleted articles).
 */
export async function getMemeArticleContext(
  meme: Meme,
): Promise<{ articleDek: string | null; articleHeroImage: string | null }> {
  const article = await loadArticleContext(meme.articleId);
  return {
    articleDek: article?.dek ?? null,
    articleHeroImage: article?.heroImage ?? null,
  };
}

/**
 * Generate (and cache) three article-grounded meme concepts for a meme. Returns
 * the concept set. Throws AiFunctionDisabledError when `meme_concepts` is paused
 * so the route reports it instead of silently producing nothing. The generator's
 * recommended template slug is resolved here against the curated library.
 */
export async function generateConceptsForMeme(memeId: string): Promise<MemeConcept[]> {
  const meme = await getMeme(memeId);
  if (!meme) throw new Error("meme not found");
  // Terminal memes are locked (mirrors regenerateVisualPrompt and the UI's
  // readOnly gate) so a direct API call can't mutate a queued/posted/approved meme.
  if (meme.status === "queued" || meme.status === "posted" || meme.status === "approved") {
    throw new Error(`meme is ${meme.status} and can no longer be edited`);
  }
  const article = await loadArticleContext(meme.articleId);
  if (!article) throw new Error("article not found");

  if (!(await isAiFunctionEnabled("meme_concepts"))) {
    throw new AiFunctionDisabledError("meme_concepts");
  }

  const generated = await generateMemeConcepts({
    title: article.title,
    dek: article.dek,
    category: article.category,
    bodyText: article.bodyText,
    // Honor the admin's pre-generation choices: force the chosen layout onto all
    // concepts and steer the visual scene toward the chosen art-style medium.
    preferredLayout: meme.layout,
    artStyle: meme.artStyle,
    memeId: meme.id,
  });

  // Map the generator output onto the stored MemeConcept shape, resolving a
  // recommended curated template for each concept's layout (best-effort).
  const concepts: MemeConcept[] = await Promise.all(
    generated.map(async (g) => ({
      jokeDescription: g.jokeDescription,
      recommendedTemplateSlug: await pickTemplateSlugForLayout(g.recommendedLayout),
      recommendedLayout: g.recommendedLayout,
      topText: g.topText,
      bottomText: g.bottomText,
      extraText: "",
      extraTextIdeas: g.extraTextIdeas,
      visualScene: g.visualScene,
      textPlacement: g.textPlacement,
      socialHook: g.socialHook,
      socialSummary: g.socialSummary,
      socialCta: g.socialCta,
      caption: g.caption,
      hashtags: g.hashtags,
    })),
  );

  await db
    .update(memesTable)
    // Re-snapshot the body here too: concept generation is the true "built-from"
    // moment, so the stored copy matches the article the concepts were grounded
    // in even if the meme row predates this column or the article since changed.
    .set({ concepts, sourceSnapshot: article.bodyText, updatedAt: new Date() })
    .where(eq(memesTable.id, memeId));
  return concepts;
}

/** First active curated template matching a layout, or null. */
async function pickTemplateSlugForLayout(layout: MemeLayout): Promise<string | null> {
  const [tpl] = await db
    .select({ slug: memeTemplatesTable.slug })
    .from(memeTemplatesTable)
    .where(and(eq(memeTemplatesTable.layout, layout), eq(memeTemplatesTable.active, true)))
    .limit(1);
  return tpl?.slug ?? null;
}

/**
 * Copy a cached concept's fields onto the meme row (joke, layout, meme text,
 * social pack) so the editor opens pre-filled. The source type always defaults to
 * AI artwork; any concept-recommended curated template is only pre-resolved into
 * templateId so it's ready if the admin manually switches the source to "Curated".
 */
export async function selectConcept(memeId: string, index: number): Promise<Meme> {
  const meme = await getMeme(memeId);
  if (!meme) throw new Error("meme not found");
  const concepts = meme.concepts ?? [];
  const concept = concepts[index];
  if (!concept) throw new Error("concept index out of range");

  // Always default the source to AI artwork — admins overwhelmingly want generated
  // art, not a curated template, even when one matches the layout. We still
  // pre-resolve the recommended template id so that IF the admin switches the
  // editor's source to "Curated template", a sensible template is already selected.
  let templateId: string | null = null;
  const sourceType: MemeSourceType = "ai_generated";
  if (concept.recommendedTemplateSlug) {
    const [tpl] = await db
      .select({ id: memeTemplatesTable.id })
      .from(memeTemplatesTable)
      .where(eq(memeTemplatesTable.slug, concept.recommendedTemplateSlug))
      .limit(1);
    if (tpl) templateId = tpl.id;
  }

  const [updated] = await db
    .update(memesTable)
    .set({
      selectedConceptIndex: index,
      jokeDescription: concept.jokeDescription,
      layout: concept.recommendedLayout,
      topText: concept.topText,
      bottomText: concept.bottomText,
      extraText: "",
      extraTextIdeas: concept.extraTextIdeas ?? [],
      visualPrompt: concept.visualScene,
      textPlacement: concept.textPlacement ?? null,
      socialHook: concept.socialHook,
      socialSummary: concept.socialSummary,
      socialCta: concept.socialCta,
      caption: concept.caption,
      hashtags: concept.hashtags,
      sourceType,
      templateId,
      updatedAt: new Date(),
    })
    .where(eq(memesTable.id, memeId))
    .returning();
  if (!updated) throw new Error("failed to select concept");
  return updated;
}

/**
 * Switch a meme to the explainer layout AND rewrite its bottom text into the
 * explainer article-summary (1-2 grounded paragraphs), kept tied to the meme's
 * current joke/angle and gold kicker (topText). Used when an admin picks the
 * explainer layout for a meme whose bottom text is still a one-line punchline,
 * so the longer summary the layout expects is generated instead of stretching a
 * one-liner. Throws AiFunctionDisabledError when `meme_concepts` is paused.
 */
export async function regenerateExplainerSummary(memeId: string): Promise<Meme> {
  const meme = await getMeme(memeId);
  if (!meme) throw new Error("meme not found");
  if (meme.status === "queued" || meme.status === "posted" || meme.status === "approved") {
    throw new Error(`meme is ${meme.status} and can no longer be edited`);
  }
  const article = await loadArticleContext(meme.articleId);
  if (!article) throw new Error("article not found");

  const summary = await generateMemeExplainerSummary({
    title: article.title,
    dek: article.dek,
    category: article.category,
    bodyText: article.bodyText,
    jokeDescription: meme.jokeDescription,
    kicker: meme.topText,
    memeId: memeId,
  });

  const [updated] = await db
    .update(memesTable)
    .set({ layout: "explainer", bottomText: summary, updatedAt: new Date() })
    .where(eq(memesTable.id, memeId))
    .returning();
  if (!updated) throw new Error("failed to update explainer summary");
  return updated;
}

/**
 * Regenerate ONLY the meme's visual prompt (the text-free background-image
 * scene), grounded in the article + the meme's joke/angle/on-image text. An
 * optional `direction` slants the scene (realistic, people, objects, cartoon,
 * political cartoon). Leaves all on-image meme text untouched. Throws
 * AiFunctionDisabledError when `meme_concepts` is paused.
 */
export async function regenerateVisualPrompt(
  memeId: string,
  direction?: MemeVisualDirection | null,
): Promise<Meme> {
  const meme = await getMeme(memeId);
  if (!meme) throw new Error("meme not found");
  if (meme.status === "queued" || meme.status === "posted" || meme.status === "approved") {
    throw new Error(`meme is ${meme.status} and can no longer be edited`);
  }
  const article = await loadArticleContext(meme.articleId);
  if (!article) throw new Error("article not found");

  const { scene, textPlacement } = await generateMemeVisualScene({
    title: article.title,
    dek: article.dek,
    category: article.category,
    bodyText: article.bodyText,
    jokeDescription: meme.jokeDescription,
    topText: meme.topText,
    bottomText: meme.bottomText,
    direction,
    layout: meme.layout,
    artStyle: meme.artStyle,
    memeId: memeId,
  });

  const [updated] = await db
    .update(memesTable)
    .set({ visualPrompt: scene, textPlacement, updatedAt: new Date() })
    .where(eq(memesTable.id, memeId))
    .returning();
  if (!updated) throw new Error("failed to update visual prompt");
  return updated;
}

/**
 * Ensure a meme has its AI social pack — hook + summary + CTA — right before it
 * is posted to Facebook from the queue. The pack is normally generated at
 * concept time, but memes built via other paths (custom/uploaded artwork, older
 * rows) can reach the queue without it. So at SEND time we fire the AI to fill
 * any MISSING field, grounded strictly in the article body, then persist it so
 * the caption never falls back to a bare/empty lead.
 *
 * Gated by the `social_caption` AI flag (via `generateArticleSocialPost`); when
 * disabled or on any failure it returns the meme unchanged so posting is never
 * blocked. Existing non-empty fields (incl. admin edits) are preserved.
 */
export async function ensureMemeSocialPack(meme: Meme): Promise<Meme> {
  const hasHook = meme.socialHook.trim().length > 0;
  const hasSummary = meme.socialSummary.trim().length > 0;
  const hasCta = meme.socialCta.trim().length > 0;
  if (hasHook && hasSummary && hasCta) return meme;

  try {
    // Snapshot fidelity: regenerate any missing copy from the body text captured
    // AT BUILD TIME when available, so the posted meme reflects the article it was
    // built from even if that article was later edited or unpublished. Legacy
    // memes (no snapshot) fall back to a live read of the article.
    let src: { title: string; dek: string | null; category: string; bodyText: string } | null;
    if (meme.sourceSnapshot && meme.sourceSnapshot.trim()) {
      src = {
        title: meme.articleTitle,
        dek: null,
        category: meme.category,
        bodyText: meme.sourceSnapshot,
      };
    } else {
      const article = await loadArticleContext(meme.articleId);
      src = article
        ? {
            title: article.title,
            dek: article.dek,
            category: article.category,
            bodyText: article.bodyText,
          }
        : null;
    }
    if (!src) return meme;
    const pack = await generateArticleSocialPost(src);
    const summary = (pack.articleSummary || pack.curiosityDetail).trim();
    const set: Record<string, unknown> = {
      socialHook: hasHook ? meme.socialHook : pack.socialHook,
      socialSummary: hasSummary ? meme.socialSummary : summary,
      socialCta: hasCta ? meme.socialCta : pack.callToAction,
      updatedAt: new Date(),
    };
    // Only fill hashtags when the meme has none, so admin-curated tags survive.
    if ((!meme.hashtags || meme.hashtags.length === 0) && pack.hashtags.length > 0) {
      set.hashtags = pack.hashtags;
    }
    const [updated] = await db
      .update(memesTable)
      .set(set)
      .where(eq(memesTable.id, meme.id))
      .returning();
    if (updated) {
      logger.info({ memeId: meme.id }, "meme: generated social pack at send time");
      return updated;
    }
    return meme;
  } catch (err) {
    if (err instanceof AiFunctionDisabledError) {
      logger.info({ memeId: meme.id }, "meme: social pack generation skipped (social_caption disabled)");
    } else {
      logger.warn({ err, memeId: meme.id }, "meme: social pack generation failed; posting with existing copy");
    }
    return meme;
  }
}

/**
 * Force-(re)generate a meme's Facebook social pack — hook, summary, CTA, caption
 * and hashtags — and persist it, overwriting whatever is there. Unlike
 * {@link ensureMemeSocialPack} (which only fills MISSING fields lazily at send
 * time) this is the admin's explicit "rewrite the caption" action from the
 * Social Queue, so it always rewrites. Grounded in the build-time body snapshot
 * when present, else a live read of the article.
 *
 * Refuses memes that have already left the queue (posting/posted). Propagates
 * {@link AiFunctionDisabledError} so the route can report a 409 when the
 * `social_caption` AI function is paused, rather than silently writing blanks.
 */
export async function regenerateMemeSocialPack(memeId: string): Promise<Meme> {
  const meme = await getMeme(memeId);
  if (!meme) throw new Error("meme not found");
  if (meme.status === "posting" || meme.status === "posted") {
    throw new Error(`meme is ${meme.status} and its caption can no longer be regenerated`);
  }

  let src: { title: string; dek: string | null; category: string; bodyText: string } | null;
  if (meme.sourceSnapshot && meme.sourceSnapshot.trim()) {
    src = {
      title: meme.articleTitle,
      dek: null,
      category: meme.category,
      bodyText: meme.sourceSnapshot,
    };
  } else {
    const article = await loadArticleContext(meme.articleId);
    src = article
      ? { title: article.title, dek: article.dek, category: article.category, bodyText: article.bodyText }
      : null;
  }
  if (!src) throw new Error("article context unavailable for this meme");

  const pack = await generateArticleSocialPost(src);
  const summary = (pack.articleSummary || pack.curiosityDetail).trim();
  const [updated] = await db
    .update(memesTable)
    .set({
      socialHook: pack.socialHook,
      socialSummary: summary,
      socialCta: pack.callToAction,
      caption: pack.caption,
      hashtags: pack.hashtags,
      updatedAt: new Date(),
    })
    .where(eq(memesTable.id, memeId))
    .returning();
  if (!updated) throw new Error("failed to regenerate social pack");
  logger.info({ memeId }, "meme: social pack regenerated by admin");
  return updated;
}

// Fields an admin may edit directly on the meme before composing/approving.
export interface MemeEditableFields {
  sourceType?: MemeSourceType;
  templateId?: string | null;
  layout?: MemeLayout;
  topText?: string;
  bottomText?: string;
  extraText?: string;
  extraTextPosition?: MemeExtraTextPosition;
  artStyle?: MemeArtStyle;
  visualPrompt?: string;
  socialHook?: string;
  socialSummary?: string;
  socialCta?: string;
  caption?: string;
  hashtags?: string[];
  allowPublicFigures?: boolean;
  scheduledAt?: Date | null;
  // Manual caption nudges (pixels) for the classic/split overlay layouts; applied
  // on the next free recompose.
  captionTopOffsetAdj?: number;
  captionBottomOffsetAdj?: number;
  // Manual caption SIZE adjustments (percent delta) for the classic/split overlay
  // layouts; applied on the next free recompose.
  captionTopSizeAdj?: number;
  captionBottomSizeAdj?: number;
  // Per-meme brand-footer placement overrides (logo + brainhook.net mark); applied
  // on the next free recompose.
  brandLogoCorner?: MemeBrandCorner;
  brandUrlCorner?: MemeBrandCorner;
  brandLogoOffsetXAdj?: number;
  brandLogoOffsetYAdj?: number;
  brandUrlOffsetXAdj?: number;
  brandUrlOffsetYAdj?: number;
}

// Keep at most this many archived artwork versions per meme (newest first).
const ARTWORK_HISTORY_CAP = 12;

/**
 * Prepend the given base+composed pair to the artwork history (newest first),
 * de-duplicated by the stable base URL and capped. A null base (no artwork yet)
 * is a no-op so the very first generation never archives an empty version.
 */
function archiveArtwork(
  history: MemeArtworkVersion[],
  original: string | null,
  composed: string | null,
): MemeArtworkVersion[] {
  if (!original) return history;
  const entry: MemeArtworkVersion = {
    originalImageUrl: original,
    composedImageUrl: composed ?? null,
    createdAt: new Date().toISOString(),
  };
  const deduped = history.filter((h) => h.originalImageUrl !== original);
  return [entry, ...deduped].slice(0, ARTWORK_HISTORY_CAP);
}

/** Apply admin edits to an editable (non-terminal) meme. */
export async function updateMemeFields(memeId: string, fields: MemeEditableFields): Promise<Meme> {
  const meme = await getMeme(memeId);
  if (!meme) throw new Error("meme not found");
  if (meme.status === "queued" || meme.status === "posted" || meme.status === "approved") {
    throw new Error(`meme is ${meme.status} and can no longer be edited`);
  }
  const [updated] = await db
    .update(memesTable)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(memesTable.id, memeId))
    .returning();
  if (!updated) throw new Error("failed to update meme");
  return updated;
}

/**
 * Resolve the base image bytes for a meme based on its source type:
 *  - mainstream_template — download the template's base canvas image
 *  - article_hero_image  — download (a copy of) the article hero
 *  - admin_uploaded      — already uploaded; download the stored original
 *  - ai_generated        — generate a fresh text-free square scene (billed)
 *
 * Returns the base bytes plus, for templates, the template's text areas. AI
 * generation enforces the attempt cap and records usage cost.
 */
/** Thrown when a free recompose is attempted on an AI meme that has no stored artwork yet. */
export class MemeArtworkMissingError extends Error {
  constructor() {
    super("Generate AI artwork before composing — no artwork exists yet.");
    this.name = "MemeArtworkMissingError";
  }
}

// Admin-chosen rendering medium for AI artwork. "auto" returns "" (let the model
// pick per the directive); the rest force the medium with an explicit later
// instruction so it wins over any medium hint earlier in the prompt.
const ART_STYLE_PROMPTS: Record<MemeArtStyle, string> = {
  auto: "",
  photographic:
    " RENDER MEDIUM (override): Render this as a realistic, photographic-quality image — real photography with natural lighting and texture. NOT an illustration, cartoon, drawing, painting, or 3D render.",
  cartoon:
    " RENDER MEDIUM (override): Render this in a polished modern digital CARTOON / MEME ILLUSTRATION style — thick clean black outlines, expressive exaggerated faces, rounded character design, saturated colors, smooth cel-shaded lighting with soft gradients, crisp social-media illustration quality, high contrast, readable silhouettes, emotional facial acting, slightly glossy highlights, simple clear backgrounds, dramatic mood lighting that matches the meme. Clean finished viral meme aesthetic. NOT photorealistic, NOT anime, NOT sketchy, NOT 3D render, NOT painterly realism, NOT generic furry convention art, NOT overly realistic animal faces. No text of any kind in the image.",
  illustration:
    " RENDER MEDIUM (override): Render this as a clean, modern editorial ILLUSTRATION — vector/flat or polished digital painting with deliberate shapes and color. NOT a photograph and NOT a rough cartoon.",
};

async function resolveBaseImage(
  meme: Meme,
  opts: { regenerateArtwork: boolean },
): Promise<{ buf: Buffer; textAreas?: MemeTextArea[]; aiGenerated: boolean }> {
  const sourceType = meme.sourceType;

  if (sourceType === "mainstream_template") {
    if (!meme.templateId) throw new Error("template meme has no template selected");
    const [tpl] = await db
      .select()
      .from(memeTemplatesTable)
      .where(eq(memeTemplatesTable.id, meme.templateId))
      .limit(1);
    if (!tpl) throw new Error("selected template not found");
    const buf = await downloadPublicObject(tpl.imageUrl);
    if (!buf) throw new Error("template base image could not be loaded");
    return { buf, textAreas: tpl.textAreas, aiGenerated: false };
  }

  if (sourceType === "article_hero_image") {
    const article = await loadArticleContext(meme.articleId);
    if (!article) throw new Error("article not found");
    const buf = await downloadPublicObject(article.heroImage);
    if (!buf) throw new Error("article hero image could not be loaded for meme base");
    return { buf, aiGenerated: false };
  }

  if (sourceType === "admin_uploaded") {
    if (!meme.originalImageUrl) throw new Error("no uploaded image on this meme");
    const buf = await downloadPublicObject(meme.originalImageUrl);
    if (!buf) throw new Error("uploaded meme image could not be loaded");
    return { buf, aiGenerated: false };
  }

  // ai_generated — a free recompose (regenerateArtwork=false) REUSES the stored
  // artwork so text edits never re-bill the model. Only an explicit regenerate
  // (or the very first generation, when no artwork exists) calls the paid model.
  if (!opts.regenerateArtwork) {
    if (!meme.originalImageUrl) throw new MemeArtworkMissingError();
    const buf = await downloadPublicObject(meme.originalImageUrl);
    if (!buf) throw new Error("stored AI artwork could not be loaded");
    return { buf, aiGenerated: false };
  }

  // Paid regeneration — enforce the attempt cap, then generate a text-free scene.
  if (meme.attemptCount >= MAX_AI_ATTEMPTS && !meme.attemptOverride) {
    throw new Error(
      `AI artwork attempt cap (${MAX_AI_ATTEMPTS}) reached — enable the override to generate again`,
    );
  }
  if (!(await isAiFunctionEnabled("meme_artwork"))) {
    throw new AiFunctionDisabledError("meme_artwork");
  }
  const scene = meme.visualPrompt.trim();
  if (!scene) throw new Error("AI artwork needs a visual scene prompt");
  const directive = await resolveDirective("meme_artwork");
  const figureRule = meme.allowPublicFigures
    ? ""
    : " Do not depict any identifiable real public figures.";
  // The shared meme_artwork directive is comedic ("funny/flashy"); the explainer
  // layout is a serious political/science format, so override that tone at
  // prompt-assembly time (the model follows the explicit later instruction). Kept
  // here rather than as a separate stored directive so it ships in code with no
  // prod DB change.
  const explainerStyleOverride =
    meme.layout === "explainer"
      ? " IMPORTANT STYLE OVERRIDE: This is a SERIOUS editorial explainer image for a political or science story — IGNORE any instruction above to be funny, comic, absurd, or exaggerated. Render a striking, photorealistic or editorial-illustration scene of the ACTUAL subject of this specific story (the real people, place, event, or thing it is about), with one clear focal subject and clean, uncluttered negative space near the bottom for a paragraph of caption text. Use bright, vividly-lit, saturated color — NOT a dim, dark, or murky scene. Do NOT render generic editorial clichés such as towering stacks of documents/folders/paperwork, a lone gavel or scales of justice, an empty podium or chair, charts/data on a screen, or a 'single spotlight in a pitch-dark room.' No text of any kind in the image."
      : "";
  // The split_panel layout overlays a top AND a bottom caption, so the artwork
  // itself must be a genuine two-panel image. Nothing else instructed the model to
  // actually split the frame — and the VISUAL SCENE RULES even forbid splits — so a
  // real split only ever happened by luck, and when it did it tended to drop the
  // chosen medium. Request it explicitly here, but let the model choose the
  // orientation (top/bottom OR left/right) that best fits the two moments. Appended
  // before the art-style line so the medium (e.g. cartoon) still wins and applies
  // consistently across BOTH panels.
  const splitPanelStyleOverride =
    meme.layout === "split_panel"
      ? " IMPORTANT COMPOSITION OVERRIDE: Render this as a SPLIT-PANEL image — TWO panels of equal size showing two contrasting or before/after moments that set up and then pay off the joke. Split the frame whichever way best fits the scene: EITHER a top half and a bottom half (one clean horizontal divider) OR a left half and a right half (one clean vertical divider). Render BOTH panels in the SAME single visual medium and style. Whichever split you choose, keep clean, uncluttered space along the very top edge and the very bottom edge for the caption text. No text of any kind in the image."
      : "";
  // Admin-chosen rendering medium. Appended LAST so it wins over any medium hint
  // in the directive/explainer/split-panel override; "auto" lets the model decide.
  const artStyleOverride = ART_STYLE_PROMPTS[meme.artStyle] ?? "";
  const prompt =
    directive.replace(/\{\{SCENE_BRIEF\}\}/g, scene) +
    explainerStyleOverride +
    splitPanelStyleOverride +
    artStyleOverride +
    figureRule;
  const { buf } = await generateMemeArtwork(prompt, meme.id.slice(0, 8));
  return { buf, aiGenerated: true };
}

/**
 * Whether a failed `buildMemePreview` actually incurred a paid AI image call.
 * Only `ai_generated` memes can bill, and only once execution passed the three
 * pre-generation guards in resolveBaseImage (attempt cap, AI disabled, missing
 * prompt) — those throw before the model runs and must not count as attempts.
 * A refusal or any post-call error means the model ran and was billed.
 */
function memeArtworkWasBilled(meme: Meme, regenerateArtwork: boolean, err: unknown): boolean {
  if (meme.sourceType !== "ai_generated") return false;
  // A free recompose never calls the model, so it can never bill.
  if (!regenerateArtwork) return false;
  if (err instanceof AiFunctionDisabledError) return false;
  if (err instanceof MemeArtworkMissingError) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("attempt cap")) return false;
  if (msg.includes("needs a visual scene prompt")) return false;
  return true;
}

// How long a meme may sit in "generating" before the next build is allowed to
// take it over. A live build only runs the model + compositor (tens of seconds),
// so anything older than this means the owning process died mid-flight and the
// row is stuck; without takeover such a meme could never be rebuilt again.
const STALE_GENERATING_MS = 3 * 60 * 1000;

/**
 * Build (or rebuild) the meme: resolve the base image, composite the text, and
 * upload both the base original and the composed meme. Sets status to
 * "generated" on success or "failed" (with lastError) on failure. The paid AI
 * attempt count is incremented for every AI generation, and the running cost
 * estimate is bumped. Returns the updated meme.
 */
export async function buildMemePreview(
  memeId: string,
  opts: { regenerateArtwork?: boolean } = {},
): Promise<Meme> {
  const regenerateArtwork = opts.regenerateArtwork ?? false;
  const meme = await getMeme(memeId);
  if (!meme) throw new Error("meme not found");
  if (meme.status === "queued" || meme.status === "posted" || meme.status === "approved") {
    throw new Error(`meme is ${meme.status} and can no longer be rebuilt`);
  }

  // Atomic claim: flip to "generating" only from a rebuildable state, in one
  // conditional UPDATE, so two concurrent build/regenerate calls can't both run
  // the paid AI artwork generation for the same meme. Whoever wins the UPDATE
  // owns the build; a loser is told it is already generating (mirrors the post
  // claim in memeQueue.postMemeImpl). The pre-check above already rejected the
  // terminal-for-build states (queued/posted/approved) with clearer messages.
  //
  // A meme can also get STUCK in "generating" if a previous build crashed the
  // process mid-flight (the status is never reset), which would otherwise lock
  // the meme out of every future rebuild forever. So the claim ALSO takes over a
  // "generating" row whose updatedAt is older than the stale window — the prior
  // owner is long dead. A genuinely in-flight build keeps updatedAt fresh (it was
  // just set above by the winner), so this never steals an active build.
  const staleBefore = new Date(Date.now() - STALE_GENERATING_MS);
  const [claim] = await db
    .update(memesTable)
    .set({ status: "generating", lastError: null, updatedAt: new Date() })
    .where(
      and(
        eq(memesTable.id, memeId),
        or(
          inArray(memesTable.status, ["draft", "generated", "failed"]),
          and(eq(memesTable.status, "generating"), lt(memesTable.updatedAt, staleBefore)),
        ),
      ),
    )
    .returning({ id: memesTable.id });
  if (!claim) throw new Error("meme is already being generated");

  try {
    const { buf: baseBuf, textAreas, aiGenerated } = await resolveBaseImage(meme, {
      regenerateArtwork,
    });
    const slugHint = meme.id.slice(0, 8);

    // Persist the base original (so a recompose with edited text reuses it
    // without re-billing AI). Uploaded originals are already stored.
    let originalImageUrl = meme.originalImageUrl;
    if (meme.sourceType !== "admin_uploaded") {
      originalImageUrl = await uploadMemeOriginal(baseBuf, "image/png", slugHint);
    }

    const composed = await composeMeme({
      baseBuf,
      layout: meme.layout,
      topText: meme.topText,
      bottomText: meme.bottomText,
      extraText: meme.extraText,
      extraPosition: meme.extraTextPosition,
      textAreas,
      // Only an AI-generated scene's placement hint describes THIS artwork. A
      // meme switched to an uploaded/hero/template source can still carry a stale
      // textPlacement from a previously selected concept, so ignore it for any
      // non-AI source and let the deterministic band analysis drive placement.
      placementHint: meme.sourceType === "ai_generated" ? (meme.textPlacement ?? null) : null,
      topOffsetAdj: meme.captionTopOffsetAdj,
      bottomOffsetAdj: meme.captionBottomOffsetAdj,
      topSizeAdj: meme.captionTopSizeAdj,
      bottomSizeAdj: meme.captionBottomSizeAdj,
      brand: {
        logoCorner: meme.brandLogoCorner,
        urlCorner: meme.brandUrlCorner,
        logoOffsetXAdj: meme.brandLogoOffsetXAdj,
        logoOffsetYAdj: meme.brandLogoOffsetYAdj,
        urlOffsetXAdj: meme.brandUrlOffsetXAdj,
        urlOffsetYAdj: meme.brandUrlOffsetYAdj,
      },
    });
    const composedImageUrl = await uploadComposedMeme(composed, slugHint);

    const attemptCount = meme.attemptCount + (aiGenerated ? 1 : 0);
    const estimatedCostUsd = aiGenerated
      ? (Number(meme.estimatedCostUsd) + IMAGE_USD).toFixed(6)
      : meme.estimatedCostUsd;

    // When a NEW base scene was generated (paid AI artwork), archive the prior
    // active base+composed pair so the admin can review/restore/delete it. A free
    // recompose (same base, new text) keeps history untouched.
    const artworkHistory =
      aiGenerated && meme.originalImageUrl
        ? archiveArtwork(meme.artworkHistory, meme.originalImageUrl, meme.composedImageUrl)
        : meme.artworkHistory;

    const [updated] = await db
      .update(memesTable)
      .set({
        originalImageUrl,
        composedImageUrl,
        artworkHistory,
        status: "generated",
        attemptCount,
        estimatedCostUsd,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(memesTable.id, memeId))
      .returning();
    if (!updated) throw new Error("failed to persist composed meme");
    // Settle the AI image spend exactly once, here on the success path, and only
    // when the paid artwork call actually ran (aiGenerated). The catch path
    // records it for billed failures; the two are mutually exclusive, so an
    // image is metered once and only once — no double-count, no silent drop.
    if (aiGenerated) recordImageUsage({ operation: "generateMemeArtwork", memeId });
    return updated;
  } catch (err) {
    const isRefusal = err instanceof NoImageDataError;
    const message = err instanceof Error ? err.message : String(err);
    // Only bill/count an attempt when the paid AI image call was ACTUALLY made.
    // The pre-generation guards in resolveBaseImage (attempt cap, AI disabled,
    // missing prompt) throw BEFORE generateMemeArtwork, so they must never
    // inflate the attempt count or cost. A refusal (NoImageDataError) IS billed
    // (the model ran), as are network/API errors from the generation call.
    const billed = memeArtworkWasBilled(meme, regenerateArtwork, err);
    // A pre-generation guard bounce (attempt cap, AI paused, no prompt, no
    // artwork yet) means NOTHING ran and the meme's stored artwork is untouched
    // — restore the pre-claim status instead of stamping a perfectly good
    // "generated" meme as "failed" with a guard message as its lastError. The
    // HTTP response still carries the guard reason (409). Real build failures
    // (model error, refusal, compose/upload error) still mark "failed".
    const guardBounce =
      err instanceof AiFunctionDisabledError ||
      err instanceof MemeArtworkMissingError ||
      message.includes("attempt cap") ||
      message.includes("needs a visual scene prompt");
    // Never restore to "generating": the stale-takeover claim path allows
    // claiming from a stuck "generating" row, so restoring that pre-claim
    // status on a guard bounce would re-stick the row. Fall back to "failed"
    // (the pre-takeover run already crashed) so it stays claimable/editable.
    const restoredStatus = meme.status === "generating" ? "failed" : meme.status;
    const [failed] = await db
      .update(memesTable)
      .set({
        status: guardBounce ? restoredStatus : "failed",
        attemptCount: meme.attemptCount + (billed ? 1 : 0),
        estimatedCostUsd: billed
          ? (Number(meme.estimatedCostUsd) + IMAGE_USD).toFixed(6)
          : meme.estimatedCostUsd,
        lastError: isRefusal ? "AI artwork was refused by the model (content safety)." : message,
        updatedAt: new Date(),
      })
      .where(eq(memesTable.id, memeId))
      .returning();
    if (billed) recordImageUsage({ operation: "generateMemeArtwork", memeId });
    logger.warn({ memeId, err: message, isRefusal, billed }, "Meme build failed");
    // The failed state (status/attempt/cost/lastError) is now persisted; rethrow
    // so the route can surface the typed reason (AI disabled → 409, attempt cap →
    // 409, refusal → 422) instead of resolving as a successful preview.
    throw err;
  }
}

/**
 * Smart "auto-place": send the meme's TEXT-FREE base image to a vision model,
 * get recommended caption offset/size nudges, write them into the meme's
 * fine-tune adjustment columns, then recompose for free (no image re-bill — it
 * reuses the stored artwork). Returns the recomposed meme. Only meaningful once
 * base artwork exists; throws MemeArtworkMissingError otherwise.
 */
export async function autoPlaceMemeText(memeId: string): Promise<Meme> {
  const meme = await getMeme(memeId);
  if (!meme) throw new Error("meme not found");
  if (meme.status === "queued" || meme.status === "posted" || meme.status === "approved") {
    throw new Error(`meme is ${meme.status} and can no longer be edited`);
  }
  if (!meme.originalImageUrl) throw new MemeArtworkMissingError();
  const baseBuf = await downloadPublicObject(meme.originalImageUrl);
  if (!baseBuf) throw new Error("stored base image could not be loaded for auto-place");

  const placement = await suggestMemeTextPlacement({
    imageBase64: baseBuf.toString("base64"),
    mimeType: sniffImageMime(baseBuf),
    layout: meme.layout,
    topText: meme.topText,
    bottomText: meme.bottomText,
    memeId: memeId,
  });
  logger.info({ memeId, placement }, "Meme auto-place suggestion");

  await updateMemeFields(memeId, {
    captionTopOffsetAdj: placement.topOffsetAdj,
    captionBottomOffsetAdj: placement.bottomOffsetAdj,
    captionTopSizeAdj: placement.topSizeAdj,
    captionBottomSizeAdj: placement.bottomSizeAdj,
  });
  // Free recompose with the new adjustments (regenerateArtwork defaults to false,
  // so the stored artwork is reused — no model image call, no billing).
  return buildMemePreview(memeId);
}

/** Set or clear the paid-attempt override flag. */
export async function setAttemptOverride(memeId: string, override: boolean): Promise<Meme> {
  const [updated] = await db
    .update(memesTable)
    .set({ attemptOverride: override, updatedAt: new Date() })
    .where(eq(memesTable.id, memeId))
    .returning();
  if (!updated) throw new Error("meme not found");
  return updated;
}

/** Default directive text exposure for callers/tests that need the baseline. */
export function defaultMemeArtworkDirective(): string {
  return getDefaultDirective("meme_artwork");
}

/** List recent memes (admin overview), newest first. */
export async function listMemes(limit = 100, articleId?: string): Promise<Meme[]> {
  return db
    .select()
    .from(memesTable)
    .where(articleId ? eq(memesTable.articleId, articleId) : undefined)
    .orderBy(desc(memesTable.createdAt))
    .limit(limit);
}

/** List the curated/admin meme template library (active first). */
export async function listMemeTemplates(includeInactive = false): Promise<MemeTemplate[]> {
  if (includeInactive) {
    return db.select().from(memeTemplatesTable).orderBy(desc(memeTemplatesTable.createdAt));
  }
  return db
    .select()
    .from(memeTemplatesTable)
    .where(eq(memeTemplatesTable.active, true))
    .orderBy(desc(memeTemplatesTable.createdAt));
}

/**
 * Store an admin-uploaded base image (data URL) as the meme's original, switch
 * the source to admin_uploaded, and reset the composed result so the next
 * preview recomposes on the new base.
 */
export async function uploadMemeOriginalDataUrl(memeId: string, dataUrl: string): Promise<Meme> {
  const meme = await getMeme(memeId);
  if (!meme) throw new Error("meme not found");
  if (meme.status === "queued" || meme.status === "posted" || meme.status === "approved") {
    throw new Error(`meme is ${meme.status} and can no longer be edited`);
  }
  const { buf, contentType } = decodeDataUrl(dataUrl);
  const slugHint = (meme.articleUrl.split("/").pop() || "meme").slice(0, 40);
  const originalImageUrl = await uploadMemeOriginal(buf, contentType, slugHint);
  // Replacing the base unlinks the prior artwork — archive it first so a paid AI
  // scene the admin uploaded over isn't lost.
  const artworkHistory = archiveArtwork(
    meme.artworkHistory,
    meme.originalImageUrl,
    meme.composedImageUrl,
  );
  const [updated] = await db
    .update(memesTable)
    .set({
      sourceType: "admin_uploaded",
      originalImageUrl,
      composedImageUrl: null,
      artworkHistory,
      status: "draft",
      updatedAt: new Date(),
    })
    .where(eq(memesTable.id, memeId))
    .returning();
  if (!updated) throw new Error("failed to store uploaded image");
  return updated;
}

/**
 * Restore a previously-archived artwork version as the active artwork. The chosen
 * version is removed from history and the currently-active base+composed pair is
 * archived in its place, so history always holds exactly the non-active versions.
 * Keyed by the stable base URL. Refuses on terminal memes.
 */
export async function selectMemeArtwork(memeId: string, originalImageUrl: string): Promise<Meme> {
  const meme = await getMeme(memeId);
  if (!meme) throw new Error("meme not found");
  if (meme.status === "queued" || meme.status === "posted" || meme.status === "approved") {
    throw new Error(`meme is ${meme.status} and can no longer be edited`);
  }
  const target = meme.artworkHistory.find((h) => h.originalImageUrl === originalImageUrl);
  if (!target) throw new Error("artwork version not found");
  const rest = meme.artworkHistory.filter((h) => h.originalImageUrl !== originalImageUrl);
  const artworkHistory = archiveArtwork(rest, meme.originalImageUrl, meme.composedImageUrl);
  const [updated] = await db
    .update(memesTable)
    .set({
      originalImageUrl: target.originalImageUrl,
      composedImageUrl: target.composedImageUrl,
      artworkHistory,
      status: "generated",
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(memesTable.id, memeId))
    .returning();
  if (!updated) throw new Error("failed to restore artwork");
  return updated;
}

/**
 * Remove an archived artwork version from history. Only operates on history
 * entries (the active artwork is never in history). The stored object bytes are
 * left in place (the system already keeps orphaned originals); this just unlinks
 * the version from the meme so it no longer appears in the slideshow.
 */
export async function deleteMemeArtwork(memeId: string, originalImageUrl: string): Promise<Meme> {
  const meme = await getMeme(memeId);
  if (!meme) throw new Error("meme not found");
  if (meme.status === "queued" || meme.status === "posted" || meme.status === "approved") {
    throw new Error(`meme is ${meme.status} and can no longer be edited`);
  }
  const artworkHistory = meme.artworkHistory.filter((h) => h.originalImageUrl !== originalImageUrl);
  const [updated] = await db
    .update(memesTable)
    .set({ artworkHistory, updatedAt: new Date() })
    .where(eq(memesTable.id, memeId))
    .returning();
  if (!updated) throw new Error("failed to update meme");
  return updated;
}

/** Delete an editable meme (draft/generated/failed). Terminal memes are kept. */
export async function deleteMeme(memeId: string): Promise<boolean> {
  const meme = await getMeme(memeId);
  if (!meme) return false;
  if (meme.status === "queued" || meme.status === "posted" || meme.status === "approved") {
    throw new Error(`meme is ${meme.status} and cannot be deleted`);
  }
  await db.delete(memesTable).where(eq(memesTable.id, memeId));
  return true;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || `template-${Date.now()}`
  );
}

// Best-effort content type from a stored public-object URL's extension. Used when
// re-uploading already-stored bytes (which carry no MIME) under a new key.
function contentTypeFromUrl(url: string): string {
  const ext = (url.split(/[?#]/)[0] ?? "").split(".").pop()?.toLowerCase();
  if (ext === "webp") return "image/webp";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return "image/png";
}

// Sniff an image's real MIME from its magic bytes (extension/URL can lie — e.g.
// admin-uploaded JPEG/WebP). Falls back to png. Used for the vision auto-place call,
// where a wrong declared media type breaks the model's image decode.
function sniffImageMime(buf: Buffer): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (buf.length >= 6 && buf.toString("ascii", 0, 4) === "GIF8") {
    return "image/gif";
  }
  return "image/png";
}

// Decode a `data:` URL into raw bytes + content type. Throws on a malformed URL.
function decodeDataUrl(dataUrl: string): { buf: Buffer; contentType: string } {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) throw new Error("image must be a base64 data URL");
  const contentType = match[1] ?? "image/png";
  return { buf: Buffer.from(match[2] ?? "", "base64"), contentType };
}

function coerceLayout(layout: string | undefined): MemeLayout {
  return (MEME_LAYOUTS as readonly string[]).includes(layout ?? "")
    ? (layout as MemeLayout)
    : "classic_top_bottom";
}

export interface CreateMemeTemplateInput {
  name: string;
  dataUrl: string;
  layout?: string;
  sourceNotes?: string;
  licenseNotes?: string;
  recommendedFieldCount?: number;
  textAreas?: MemeTextArea[];
}

interface TemplateFromBytesInput {
  name: string;
  buf: Buffer;
  contentType: string;
  layout?: string;
  sourceNotes?: string;
  licenseNotes?: string;
  recommendedFieldCount?: number;
  textAreas?: MemeTextArea[];
}

/**
 * Shared insert path for new (non-curated) meme templates from raw image bytes.
 * Validates + uniquifies the slug, uploads the base image, and inserts the row.
 * Both the admin upload (`createMemeTemplate`, from a data URL) and "save meme as
 * preset" (`saveMemeAsTemplate`, reusing the meme's stored base bytes) funnel
 * through here so there is one source of truth for slug + insert behavior.
 */
async function createTemplateFromBytes(input: TemplateFromBytesInput): Promise<MemeTemplate> {
  const name = input.name.trim();
  if (!name) throw new Error("template name is required");
  let slug = slugify(name);
  const [existing] = await db
    .select({ id: memeTemplatesTable.id })
    .from(memeTemplatesTable)
    .where(eq(memeTemplatesTable.slug, slug))
    .limit(1);
  if (existing) slug = `${slug}-${Date.now().toString(36)}`;

  const imageUrl = await uploadTemplateImage(input.buf, input.contentType, slug);
  const [created] = await db
    .insert(memeTemplatesTable)
    .values({
      name,
      slug,
      imageUrl,
      layout: coerceLayout(input.layout),
      sourceNotes: input.sourceNotes ?? "",
      licenseNotes: input.licenseNotes ?? "",
      textAreas: input.textAreas ?? [],
      recommendedFieldCount: input.recommendedFieldCount ?? 2,
      isCurated: false,
      active: true,
    })
    .returning();
  if (!created) throw new Error("failed to create template");
  return created;
}

/** Create a new (admin-authored) meme template from an uploaded base image. */
export async function createMemeTemplate(input: CreateMemeTemplateInput): Promise<MemeTemplate> {
  const { buf, contentType } = decodeDataUrl(input.dataUrl);
  return createTemplateFromBytes({
    name: input.name,
    buf,
    contentType,
    layout: input.layout,
    sourceNotes: input.sourceNotes,
    licenseNotes: input.licenseNotes,
    recommendedFieldCount: input.recommendedFieldCount,
    textAreas: input.textAreas,
  });
}

/**
 * Save a generated meme's base artwork as a reusable preset/template. Reuses the
 * meme's already-stored base image (originalImageUrl) — it downloads those bytes
 * and re-uploads them under the template prefix, so there is NO AI re-bill and no
 * client base64 round-trip. The new template inherits the meme's layout so it
 * drops straight back into the builder. Falls back to the article title for the
 * name when none is provided.
 */
export async function saveMemeAsTemplate(memeId: string, name?: string): Promise<MemeTemplate> {
  const meme = await getMeme(memeId);
  if (!meme) throw new Error("meme not found");
  if (!meme.originalImageUrl) {
    throw new Error("this meme has no base image yet — build or generate artwork first");
  }
  const buf = await downloadPublicObject(meme.originalImageUrl);
  if (!buf) throw new Error("could not read the meme's base image");
  const contentType = contentTypeFromUrl(meme.originalImageUrl);
  const templateName = (name?.trim() || meme.articleTitle?.trim() || "Saved meme preset").slice(0, 120);
  // Recommend the number of text fields the meme actually used (1–3) so the
  // builder hints sensible slots when the preset is reused.
  const usedFields = [meme.topText, meme.bottomText, meme.extraText].filter(
    (t) => typeof t === "string" && t.trim(),
  ).length;
  return createTemplateFromBytes({
    name: templateName,
    buf,
    contentType,
    layout: meme.layout,
    sourceNotes: meme.articleTitle ? `Saved from meme for "${meme.articleTitle}"` : "Saved from a generated meme",
    recommendedFieldCount: Math.min(3, Math.max(1, usedFields || 2)),
  });
}

export interface UpdateMemeTemplateInput {
  name?: string;
  dataUrl?: string;
  layout?: string;
  sourceNotes?: string;
  licenseNotes?: string;
  recommendedFieldCount?: number;
  active?: boolean;
  textAreas?: MemeTextArea[];
}

/** Update template metadata, text areas, active flag, or replace its image. */
export async function updateMemeTemplate(
  id: string,
  input: UpdateMemeTemplateInput,
): Promise<MemeTemplate | null> {
  const [tpl] = await db
    .select()
    .from(memeTemplatesTable)
    .where(eq(memeTemplatesTable.id, id))
    .limit(1);
  if (!tpl) return null;

  const patch: Partial<typeof memeTemplatesTable.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.layout !== undefined) patch.layout = coerceLayout(input.layout);
  if (input.sourceNotes !== undefined) patch.sourceNotes = input.sourceNotes;
  if (input.licenseNotes !== undefined) patch.licenseNotes = input.licenseNotes;
  if (input.recommendedFieldCount !== undefined)
    patch.recommendedFieldCount = input.recommendedFieldCount;
  if (input.active !== undefined) patch.active = input.active;
  if (input.textAreas !== undefined) patch.textAreas = input.textAreas;
  if (input.dataUrl) {
    const { buf, contentType } = decodeDataUrl(input.dataUrl);
    patch.imageUrl = await uploadTemplateImage(buf, contentType, tpl.slug);
  }

  const [updated] = await db
    .update(memeTemplatesTable)
    .set(patch)
    .where(eq(memeTemplatesTable.id, id))
    .returning();
  return updated ?? null;
}

/** Soft-disable a template (kept for history, no longer offered). */
export async function disableMemeTemplate(id: string): Promise<MemeTemplate | null> {
  const [updated] = await db
    .update(memeTemplatesTable)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(memeTemplatesTable.id, id))
    .returning();
  return updated ?? null;
}
