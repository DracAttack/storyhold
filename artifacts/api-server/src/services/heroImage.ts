import { randomUUID } from "crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { generatePhotoImage, NoImageDataError } from "@workspace/integrations-gemini-ai/image";
import { uploadPublicBuffer, DEFAULT_SHARE_CARD_URL } from "../lib/objectStorage";
import { generateAndStoreShareImage, generateAndStoreFeedImage } from "./shareImage";
import { logger } from "../lib/logger";
import { pickHeroImage } from "../lib/slug";
import { isAiFunctionEnabled, resolveDirective } from "./aiSettings";
import { recordImageUsage } from "./aiUsage";
import type { Author, HeroImageVersion } from "@workspace/db";

export const HERO_IMAGE_HISTORY_CAP = 10;

/**
 * Prepend the current hero + its branded share/feed cards to the version history
 * (newest first), de-duplicated by the stable hero URL and capped. A null/empty
 * current hero is a no-op so a first-ever generation never archives an empty
 * version. Mirrors the meme `archiveArtwork` helper.
 */
export function archiveHeroImage(
  history: HeroImageVersion[],
  current: { heroImage: string | null; shareImage: string | null; feedImage: string | null },
): HeroImageVersion[] {
  if (!current.heroImage) return history;
  const entry: HeroImageVersion = {
    heroImage: current.heroImage,
    shareImage: current.shareImage ?? null,
    feedImage: current.feedImage ?? null,
    createdAt: new Date().toISOString(),
  };
  const deduped = history.filter((h) => h.heroImage !== current.heroImage);
  return [entry, ...deduped].slice(0, HERO_IMAGE_HISTORY_CAP);
}

/**
 * Substitute {{TOKEN}} placeholders in a resolved image directive with per-call
 * dynamic data. The replacement uses the function form so literal `$` sequences
 * in the substituted value are never treated as `String.replace` specials.
 */
function fillPlaceholders(directive: string, values: Record<string, string>): string {
  let out = directive;
  for (const [token, value] of Object.entries(values)) {
    out = out.replaceAll(`{{${token}}}`, () => value);
  }
  return out;
}

const execFileAsync = promisify(execFile);

/**
 * True when an image-model error is a rate-limit / quota rejection (HTTP 429).
 * These are transient under bursty drafting — several drafts kicked off at once
 * (manual clicks, the multi-author pipeline) all hammer the slow image model and
 * trip the per-minute quota. They should be retried with backoff, not dropped to
 * a placeholder. Content refusals (NoImageDataError) are a different failure and
 * bubble straight up to the branded-default-card fallback instead.
 */
function isRateLimitError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    status === 429 ||
    msg.includes("429") ||
    msg.includes("RATELIMIT_EXCEEDED") ||
    msg.toLowerCase().includes("quota") ||
    msg.toLowerCase().includes("rate limit")
  );
}

/**
 * Call the image model, retrying ONLY on rate-limit (429) errors with
 * exponential backoff + jitter. The pro image model is slow (~20-30s/image), so
 * a handful of concurrent drafts easily exceed the quota; spacing retries out
 * (with jitter so colliding drafts desync) lets the burst drain instead of
 * dropping heroes to placeholders. NoImageDataError and all other errors bubble
 * straight up so the caller's branded-card / 422 fallback logic still applies.
 */
async function generatePhotoWithRateLimitRetry(
  prompt: string,
  options: { aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4" },
  slugHint: string,
): Promise<{ b64_json: string; mimeType: string }> {
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    try {
      return await generatePhotoImage(prompt, options);
    } catch (err) {
      if (!isRateLimitError(err) || attempt >= maxAttempts) throw err;
      const backoff = Math.min(30_000, 4_000 * 2 ** (attempt - 1));
      const delay = backoff + Math.floor(Math.random() * 1_000);
      logger.warn(
        { slugHint, attempt, delayMs: delay },
        "Image model hit rate limit (429); backing off before retry",
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Re-encode a generated image (typically a 1.5MB PNG from Imagen) into a
 * web-friendly JPEG (~100-200KB) so hero images don't tank page load times.
 * Falls back to the original buffer if magick fails.
 */
async function transcodeToJpeg(buf: Buffer): Promise<{ buf: Buffer; mimeType: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "hero-"));
  const inPath = path.join(dir, "in.png");
  const outPath = path.join(dir, "out.jpg");
  try {
    await writeFile(inPath, buf);
    await execFileAsync("magick", [
      inPath,
      "-resize", "1600x1600>",
      "-strip",
      "-interlace", "Plane",
      "-quality", "82",
      outPath,
    ]);
    const out = await readFile(outPath);
    return { buf: out, mimeType: "image/jpeg" };
  } catch (err) {
    logger.warn({ err }, "Hero image JPEG transcode failed; using original");
    return { buf, mimeType: "image/png" };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

type ArticleSeed = {
  title: string;
  dek: string;
  category: string;
  body?: { type: string; content?: string; items?: string[] }[];
};

/**
 * Concatenate the article's prose (paragraphs + headings) into a single capped
 * string so the image prompt can be driven by the WHOLE story, not just the
 * title or opening line. Capped to keep the prompt a sane length.
 */
function articleText(seed: ArticleSeed): string {
  const text = (seed.body ?? [])
    .filter((b) => b.type === "paragraph" || b.type === "heading")
    .map((b) => b.content)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.split(/\s+/).slice(0, 500).join(" ");
}

/**
 * Imagen prompts work best as a single dense paragraph of photographic
 * description, not a bulleted brief. We construct: subject → camera/lens →
 * lighting → environment → mood → negative cues. The "subject" is the ACTUAL
 * topic of the article (read in full) — domain-matched: depict the real
 * phenomenon for science/nature/space/history topics, and real people for
 * human/social/emotional topics. We avoid both naive metaphor-literalism and
 * the opposite failure of slapping a person-at-a-screen onto every subject.
 */
async function buildPrompt(seed: ArticleSeed, author: Author | null): Promise<string> {
  const fullText = articleText(seed);
  const subjectBrief = [
    `Title: "${seed.title}".`,
    `Subhead: ${seed.dek}.`,
    `Category: ${seed.category}.`,
    fullText ? `Full article (read ALL of it, then decide what to depict): ${fullText}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const moodFromAuthor = author?.tone
    ? ` Let the emotional register echo this writing voice: ${author.tone}.`
    : "";

  const directive = await resolveDirective("hero_image");
  return fillPlaceholders(directive, {
    SUBJECT_BRIEF: subjectBrief,
    AUTHOR_MOOD: moodFromAuthor,
  });
}

/**
 * Generate the article hero photo from the primary (full-context) prompt.
 *
 * The pro image model occasionally returns a text-only refusal (no image part)
 * for sensitive article content. We deliberately do NOT retry with a "safer"
 * body-free prompt: every pro-image generation is billed (~$0.13+ each), and
 * the old fallback fired up to two EXTRA generations on exactly the articles
 * most likely to be refused. On a `NoImageDataError` we log it and bubble it so
 * callers fall straight to the branded default share card. Rate-limit (429)
 * retries are still handled upstream and only ever yield one billed image.
 * Non-refusal errors (network, upstream 5xx) also bubble up.
 */
async function generateArticleHeroPhoto(
  seed: ArticleSeed,
  author: Author | null,
  slugHint: string,
): Promise<{ b64_json: string; mimeType: string }> {
  const prompt = await buildPrompt(seed, author);
  try {
    return await generatePhotoWithRateLimitRetry(prompt, { aspectRatio: "16:9" }, slugHint);
  } catch (err) {
    if (err instanceof NoImageDataError) {
      logger.warn(
        {
          slugHint,
          finishReason: err.finishReason,
          blockReason: err.blockReason,
          modelText: err.modelText?.slice(0, 300),
        },
        "Hero image refused by model; using branded default card (no safe-prompt retry)",
      );
    }
    throw err;
  }
}

/**
 * Generate a 1:1 portrait avatar for an author persona and upload it to public
 * object storage. Returns the served URL path.
 */
export async function generateAndStoreAuthorAvatar(input: {
  name: string;
  bio?: string | null;
  voicePrompt?: string | null;
  tone?: string | null;
  category?: string | null;
  slugHint: string;
}): Promise<string> {
  if (!(await isAiFunctionEnabled("author_avatar"))) {
    return `https://api.dicebear.com/9.x/notionists/svg?seed=${encodeURIComponent(input.slugHint)}`;
  }
  const personaBits = [
    input.bio ? `Bio: ${input.bio}.` : "",
    input.voicePrompt ? `Writing voice: ${input.voicePrompt.slice(0, 400)}.` : "",
    input.tone ? `Tone: ${input.tone}.` : "",
    input.category ? `Beat: ${input.category}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const directive = await resolveDirective("author_avatar");
  const prompt = fillPlaceholders(directive, {
    NAME: input.name,
    PERSONA: personaBits,
  });

  const t0 = Date.now();
  const { b64_json, mimeType } = await generatePhotoWithRateLimitRetry(prompt, { aspectRatio: "1:1" }, input.slugHint);
  // Bill the one successful pro-image generation to the cost meter. Refusals
  // throw above (NoImageDataError) and never reach here, so they cost nothing.
  recordImageUsage({ operation: "generateAndStoreAuthorAvatar", authorSlug: input.slugHint });
  const rawBuf = Buffer.from(b64_json, "base64");
  const { buf, mimeType: outMime } = mimeType.includes("jpeg")
    ? { buf: rawBuf, mimeType }
    : await transcodeToJpeg(rawBuf);
  const ext = outMime.includes("jpeg") ? "jpg" : "png";
  const key = `author-avatars/${input.slugHint}-${randomUUID().slice(0, 8)}.${ext}`;
  await uploadPublicBuffer(key, buf, outMime);
  const url = `/api/storage/public-objects/${key}`;
  logger.info(
    { slugHint: input.slugHint, ms: Date.now() - t0, bytes: buf.length, url },
    "Generated author avatar",
  );
  return url;
}

/**
 * Build a prompt for a category (beat) hero image. Unlike article heroes, a
 * beat hero should evoke the *whole subject area* rather than one literal story
 * — a strong representative scene/object for the beat, photographed with the
 * same editorial gravitas. Built from name + description + editorial slant.
 */
async function buildBeatPrompt(input: { name: string; description?: string | null; slant?: string | null }): Promise<string> {
  const brief = [
    `Category: "${input.name}".`,
    input.description ? `What it covers: ${input.description}` : "",
    input.slant ? `Editorial angle: ${input.slant.slice(0, 600)}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const directive = await resolveDirective("beat_hero_image");
  return fillPlaceholders(directive, { BRIEF: brief });
}

/**
 * Generate a hero image for a category (beat) and upload it to public object
 * storage under `category-heroes/`. Returns the served URL path. Throws on
 * failure — caller decides fallback.
 */
export async function generateAndStoreBeatHeroImage(input: {
  name: string;
  description?: string | null;
  slant?: string | null;
  slugHint: string;
}): Promise<string> {
  if (!(await isAiFunctionEnabled("beat_hero_image"))) {
    return pickHeroImage(input.slugHint);
  }
  const prompt = await buildBeatPrompt(input);
  const t0 = Date.now();
  const { b64_json, mimeType } = await generatePhotoWithRateLimitRetry(prompt, { aspectRatio: "16:9" }, input.slugHint);
  // Bill the one successful pro-image generation to the cost meter. Refusals
  // throw above (NoImageDataError) and never reach here, so they cost nothing.
  recordImageUsage({ operation: "generateAndStoreBeatHeroImage", authorSlug: null });
  const rawBuf = Buffer.from(b64_json, "base64");
  const { buf, mimeType: outMime } = mimeType.includes("jpeg")
    ? { buf: rawBuf, mimeType }
    : await transcodeToJpeg(rawBuf);
  const ext = outMime.includes("jpeg") ? "jpg" : "png";
  const key = `category-heroes/${input.slugHint}-${randomUUID().slice(0, 8)}.${ext}`;
  await uploadPublicBuffer(key, buf, outMime);
  const url = `/api/storage/public-objects/${key}`;
  logger.info(
    { slugHint: input.slugHint, ms: Date.now() - t0, bytes: buf.length, url },
    "Generated beat hero image",
  );
  return url;
}

export interface GeneratedHeroImage {
  /** Served URL path of the raw hero photo (on-page image and og:image fallback). */
  heroImage: string;
  /**
   * Served URL path of the branded composite share card (hero + brand gradient +
   * wordmark + title) for og:image / twitter:image. Null if composition failed,
   * in which case callers fall back to the raw hero.
   */
  shareImage: string | null;
  /**
   * Served URL path of the branded SQUARE (1:1) feed card attached as the photo
   * on Facebook posts. Null if composition failed, in which case Facebook
   * posters fall back to the share card then the raw hero.
   */
  feedImage: string | null;
}

/**
 * Accept a base64 data URL uploaded by an admin, store it as the article's
 * hero image, and compose a branded share card + feed card from the same
 * buffer. Returns the three stored URL paths. Throws on invalid data URL.
 */
export async function uploadHeroImageFromDataUrl(
  dataUrl: string,
  title: string,
  slugHint: string,
): Promise<GeneratedHeroImage> {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) throw new Error("image must be a base64 data URL");
  const contentType = match[1] ?? "image/png";
  const rawBuf = Buffer.from(match[2] ?? "", "base64");
  const { buf, mimeType: outMime } = contentType.includes("jpeg")
    ? { buf: rawBuf, mimeType: contentType }
    : await transcodeToJpeg(rawBuf);
  const ext = outMime.includes("jpeg") ? "jpg" : "png";
  const key = `hero-images/${slugHint}-${randomUUID().slice(0, 8)}.${ext}`;
  await uploadPublicBuffer(key, buf, outMime);
  const heroImageUrl = `/api/storage/public-objects/${key}`;
  logger.info({ slugHint, bytes: buf.length, url: heroImageUrl }, "Uploaded hero image from admin");
  let shareImage: string | null = null;
  try {
    shareImage = await generateAndStoreShareImage(buf, title, slugHint);
  } catch (err) {
    logger.warn({ err, slugHint }, "Share image composition failed after upload; falling back to raw hero");
  }
  let feedImage: string | null = null;
  try {
    feedImage = await generateAndStoreFeedImage(buf, title, slugHint);
  } catch (err) {
    logger.warn({ err, slugHint }, "Feed card composition failed after upload; falling back to share card / raw hero");
  }
  return { heroImage: heroImageUrl, shareImage, feedImage };
}

/**
 * Generate a hero image for an article, upload it to public object storage, and
 * compose a branded share card from the same in-memory buffer. Returns both
 * served URL paths. Throws on hero-generation failure — caller decides fallback.
 * Share-card composition is best-effort: a failure yields `shareImage: null`
 * rather than aborting (the raw hero still works as the share image).
 */
export async function generateAndStoreHeroImage(
  seed: ArticleSeed,
  author: Author | null,
  slugHint: string,
  // `operation` lets admin "regenerate image" calls label their spend
  // distinctly from the once-per-new-article draft-time generation, so the
  // cost meter's per-article average isn't inflated by hero regenerations.
  opts: { operation?: string; articleId?: string | null } = {},
): Promise<GeneratedHeroImage> {
  if (!(await isAiFunctionEnabled("hero_image"))) {
    // AI hero generation is paused: use the branded default card for the
    // on-page hero, og:image share card, and the attached feed photo (never a
    // stock photo).
    return {
      heroImage: DEFAULT_SHARE_CARD_URL,
      shareImage: DEFAULT_SHARE_CARD_URL,
      feedImage: DEFAULT_SHARE_CARD_URL,
    };
  }
  const t0 = Date.now();
  const { b64_json, mimeType } = await generateArticleHeroPhoto(seed, author, slugHint);
  // Bill the one successful pro-image generation to the cost meter. Refusals
  // throw above (NoImageDataError) and never reach here, so they cost nothing.
  recordImageUsage({ operation: opts.operation ?? "generateAndStoreHeroImage", authorSlug: author?.slug ?? null, articleId: opts.articleId });
  const rawBuf = Buffer.from(b64_json, "base64");
  const { buf, mimeType: outMime } = mimeType.includes("jpeg")
    ? { buf: rawBuf, mimeType }
    : await transcodeToJpeg(rawBuf);
  const ext = outMime.includes("jpeg") ? "jpg" : "png";
  const key = `hero-images/${slugHint}-${randomUUID().slice(0, 8)}.${ext}`;
  await uploadPublicBuffer(key, buf, outMime);
  const url = `/api/storage/public-objects/${key}`;
  logger.info(
    { slugHint, ms: Date.now() - t0, bytes: buf.length, url },
    "Generated hero image",
  );
  let shareImage: string | null = null;
  try {
    shareImage = await generateAndStoreShareImage(buf, seed.title, slugHint);
  } catch (err) {
    logger.warn({ err, slugHint }, "Share image generation failed; falling back to raw hero");
  }
  let feedImage: string | null = null;
  try {
    feedImage = await generateAndStoreFeedImage(buf, seed.title, slugHint);
  } catch (err) {
    logger.warn({ err, slugHint }, "Feed card generation failed; falling back to share card / raw hero");
  }
  return { heroImage: url, shareImage, feedImage };
}
