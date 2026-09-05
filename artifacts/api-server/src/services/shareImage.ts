import { randomUUID } from "crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { db, articlesTable } from "@workspace/db";
import { uploadPublicBuffer, DEFAULT_SHARE_CARD_PATH, findPublicObject } from "../lib/objectStorage";
import { logger } from "../lib/logger";

const execFileAsync = promisify(execFile);

// Open Graph / Twitter "summary_large_image" recommended canvas. 1.91:1.
const SHARE_W = 1200;
const SHARE_H = 630;
// Horizontal padding for the title/wordmark from the canvas edge.
const PAD = 64;

// Serif bold face available in the Nix image (mirrors the site's serif headline
// voice closely enough for a share card). Referenced by absolute path so magick
// never falls back to a default sans face.
const SERIF_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf";
// The BrainHook logo lockup (brain mark + terracotta wordmark) as a transparent
// PNG, bundled next to the compiled server (build.mjs copies assets/ into dist/).
// Resolved from this module's own URL so it works in dev and the bundled prod
// output alike (the production cwd is the repo root, not this package dir).
const LOGO_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "brainhook-logo.png");
// Logo badge sizing on the card: the logo is drawn at LOGO_W wide on a dark,
// rounded plate (matching the brand's dark presentation) so it stays legible
// over any hero photo at the top-left, where the bottom-up scrim is transparent.
const LOGO_W = 300;
const PLATE_PAD = 22;
const PLATE_RADIUS = 20;
const PLATE_FILL = "rgba(12,14,20,0.82)";

/**
 * Compose a branded 1200×630 share card from a hero image buffer: the hero
 * photo cropped to fill, a bottom-up dark scrim for legibility, the BrainHook
 * logo lockup on a dark rounded badge (top-left), and the article title
 * (bottom-left, serif, wrapped). Returns a JPEG buffer, or null if magick fails
 * (callers fall back to the raw hero).
 *
 * Each text layer is rendered to its own PNG before compositing. magick's
 * `-size`/`-background` settings persist across `( ... )` groups within a single
 * invocation, so building wordmark/title/base in one command silently bleeds the
 * title's `-size` into the wordmark `label:` (rendering it page-sized). Rendering
 * finished rasters and compositing them keeps every layer independent.
 */
export async function composeShareImage(heroBuf: Buffer, title: string): Promise<Buffer | null> {
  const dir = await mkdtemp(path.join(tmpdir(), "share-"));
  const inPath = path.join(dir, "in.img");
  const basePath = path.join(dir, "base.png");
  const logoDispPath = path.join(dir, "logo.png");
  const platePath = path.join(dir, "plate.png");
  const badgePath = path.join(dir, "badge.png");
  const titlePath = path.join(dir, "title.png");
  const outPath = path.join(dir, "out.jpg");
  // Titles are plain editorial prose; magick caption/label interpret `%` and a
  // leading `@` as escapes, so neutralize those to render the text literally.
  const safeTitle = title.replace(/%/g, "%%").replace(/^@/, " @").trim();
  try {
    await writeFile(inPath, heroBuf);
    // 1. Base: cover-crop the hero, then lay a bottom-up dark scrim (transparent
    //    at top → near-black at bottom) so the title reads over bright photos.
    await execFileAsync("magick", [
      inPath,
      "-resize", `${SHARE_W}x${SHARE_H}^`,
      "-gravity", "center",
      "-extent", `${SHARE_W}x${SHARE_H}`,
      "(", "-size", `${SHARE_W}x${SHARE_H}`, "gradient:none-rgba(10,12,18,0.94)", ")",
      "-gravity", "south", "-compose", "over", "-composite",
      basePath,
    ]);
    // 2. Brand badge: scale the logo lockup, then center it on a dark, rounded
    //    plate so the terracotta artwork stays legible over any hero photo.
    await execFileAsync("magick", [LOGO_PATH, "-resize", `${LOGO_W}x`, logoDispPath]);
    const { stdout: hOut } = await execFileAsync("magick", ["identify", "-format", "%h", logoDispPath]);
    const logoH = Number.parseInt(hOut.trim(), 10) || Math.round(LOGO_W * 0.34);
    const plateW = LOGO_W + PLATE_PAD * 2;
    const plateH = logoH + PLATE_PAD * 2;
    await execFileAsync("magick", [
      "-size", `${plateW}x${plateH}`, "xc:none",
      "-fill", PLATE_FILL,
      "-draw", `roundrectangle 0,0,${plateW - 1},${plateH - 1},${PLATE_RADIUS},${PLATE_RADIUS}`,
      platePath,
    ]);
    await execFileAsync("magick", [platePath, logoDispPath, "-gravity", "center", "-composite", badgePath]);
    // 3. Article title: serif, white, wrapped to the content width.
    await execFileAsync("magick", [
      "-background", "none", "-fill", "white", "-font", SERIF_BOLD,
      "-pointsize", "58", "-size", `${SHARE_W - PAD * 2}x`,
      `caption:${safeTitle}`,
      titlePath,
    ]);
    // 4. Composite: brand badge top-left, title bottom-left.
    await execFileAsync("magick", [
      basePath,
      badgePath, "-gravity", "northwest", "-geometry", `+${PAD - PLATE_PAD}+40`, "-composite",
      titlePath, "-gravity", "southwest", "-geometry", `+${PAD}+56`, "-composite",
      "-strip", "-interlace", "Plane", "-quality", "86",
      outPath,
    ]);
    return await readFile(outPath);
  } catch (err) {
    logger.warn({ err }, "Share image composition failed; raw hero will be used");
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Compose a branded share card from a hero buffer and upload it to public
 * object storage under `share-images/`. Returns the served URL path, or null if
 * composition fails (callers fall back to the raw hero image for og:image).
 */
export async function generateAndStoreShareImage(
  heroBuf: Buffer,
  title: string,
  slugHint: string,
): Promise<string | null> {
  const t0 = Date.now();
  const buf = await composeShareImage(heroBuf, title);
  if (!buf) return null;
  const key = `share-images/${slugHint}-${randomUUID().slice(0, 8)}.jpg`;
  await uploadPublicBuffer(key, buf, "image/jpeg");
  const url = `/api/storage/public-objects/${key}`;
  logger.info({ slugHint, ms: Date.now() - t0, bytes: buf.length, url }, "Generated share image");
  return url;
}

// Square feed-card canvas (1:1) used as the ATTACHED photo on Facebook posts.
// Facebook renders an uploaded square photo full-width in the feed, whereas the
// 1.91:1 share card posts letterboxed/cropped. og:image keeps using the 1.91:1
// share card; this is a SEPARATE asset purely for the attached feed photo.
const FEED_W = 1080;
const FEED_H = 1080;

/**
 * Compose a branded 1080×1080 SQUARE feed card from a hero image buffer: the
 * hero photo cover-cropped to fill the square, a bottom-up dark scrim, the
 * BrainHook logo badge (top-left), and the article title (bottom-left, serif,
 * wrapped). Mirrors {@link composeShareImage} but at a 1:1 aspect ratio so it
 * renders full-width in the Facebook feed. Returns a JPEG buffer, or null if
 * magick fails (callers fall back to the share card / raw hero).
 */
export async function composeFeedCard(heroBuf: Buffer, title: string): Promise<Buffer | null> {
  const dir = await mkdtemp(path.join(tmpdir(), "feed-"));
  const inPath = path.join(dir, "in.img");
  const basePath = path.join(dir, "base.png");
  const logoDispPath = path.join(dir, "logo.png");
  const platePath = path.join(dir, "plate.png");
  const badgePath = path.join(dir, "badge.png");
  const titlePath = path.join(dir, "title.png");
  const outPath = path.join(dir, "out.jpg");
  const safeTitle = title.replace(/%/g, "%%").replace(/^@/, " @").trim();
  try {
    await writeFile(inPath, heroBuf);
    // 1. Base: cover-crop the hero to the square, then a bottom-up dark scrim.
    await execFileAsync("magick", [
      inPath,
      "-resize", `${FEED_W}x${FEED_H}^`,
      "-gravity", "center",
      "-extent", `${FEED_W}x${FEED_H}`,
      "(", "-size", `${FEED_W}x${FEED_H}`, "gradient:none-rgba(10,12,18,0.94)", ")",
      "-gravity", "south", "-compose", "over", "-composite",
      basePath,
    ]);
    // 2. Brand badge: logo lockup centered on a dark rounded plate.
    await execFileAsync("magick", [LOGO_PATH, "-resize", `${LOGO_W}x`, logoDispPath]);
    const { stdout: hOut } = await execFileAsync("magick", ["identify", "-format", "%h", logoDispPath]);
    const logoH = Number.parseInt(hOut.trim(), 10) || Math.round(LOGO_W * 0.34);
    const plateW = LOGO_W + PLATE_PAD * 2;
    const plateH = logoH + PLATE_PAD * 2;
    await execFileAsync("magick", [
      "-size", `${plateW}x${plateH}`, "xc:none",
      "-fill", PLATE_FILL,
      "-draw", `roundrectangle 0,0,${plateW - 1},${plateH - 1},${PLATE_RADIUS},${PLATE_RADIUS}`,
      platePath,
    ]);
    await execFileAsync("magick", [platePath, logoDispPath, "-gravity", "center", "-composite", badgePath]);
    // 3. Article title: serif, white, wrapped to the content width.
    await execFileAsync("magick", [
      "-background", "none", "-fill", "white", "-font", SERIF_BOLD,
      "-pointsize", "62", "-size", `${FEED_W - PAD * 2}x`,
      `caption:${safeTitle}`,
      titlePath,
    ]);
    // 4. Composite: brand badge top-left, title bottom-left.
    await execFileAsync("magick", [
      basePath,
      badgePath, "-gravity", "northwest", "-geometry", `+${PAD - PLATE_PAD}+48`, "-composite",
      titlePath, "-gravity", "southwest", "-geometry", `+${PAD}+64`, "-composite",
      "-strip", "-interlace", "Plane", "-quality", "86",
      outPath,
    ]);
    return await readFile(outPath);
  } catch (err) {
    logger.warn({ err }, "Feed card composition failed; share card / raw hero will be used");
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Compose a branded square feed card from a hero buffer and upload it to public
 * object storage under `feed-images/`. Returns the served URL path, or null if
 * composition fails (callers fall back to the share card / raw hero).
 */
export async function generateAndStoreFeedImage(
  heroBuf: Buffer,
  title: string,
  slugHint: string,
): Promise<string | null> {
  const t0 = Date.now();
  const buf = await composeFeedCard(heroBuf, title);
  if (!buf) return null;
  const key = `feed-images/${slugHint}-${randomUUID().slice(0, 8)}.jpg`;
  await uploadPublicBuffer(key, buf, "image/jpeg");
  const url = `/api/storage/public-objects/${key}`;
  logger.info({ slugHint, ms: Date.now() - t0, bytes: buf.length, url }, "Generated feed card");
  return url;
}

// Stored hero/card objects are referenced by this public-object URL prefix; only
// such heroes can be re-downloaded to compose a card from on demand.
const PUBLIC_OBJECT_PREFIX = "/api/storage/public-objects/";

/**
 * Resolve the best branded image URL to attach to a Facebook post for an
 * article, composing AND persisting the missing branded card(s) on demand from
 * the article's stored hero when they're absent. Preference: the 1:1 feed card →
 * the 1.91:1 share card → the raw hero.
 *
 * Branded cards are normally composed once, at hero-generation (draft) time. But
 * an article drafted BEFORE a card feature shipped publishes days later with that
 * card missing, so the auto-poster would fall back to the raw, unbranded AI hero.
 * This heals the card from the stored hero BYTES (no AI image regeneration, so it
 * is free) right before posting. The bulk `backfillShareImages` only covers
 * already-published articles; this also covers scheduled drafts that publish and
 * auto-post in the future.
 *
 * Never throws — a composition hiccup must never block the post, so on any error
 * it falls back to the best already-stored image (share card, then raw hero).
 */
export async function ensureArticleSocialCard(articleId: string): Promise<string | null> {
  let row:
    | {
        id: string;
        slug: string;
        title: string;
        heroImage: string | null;
        shareImage: string | null;
        feedImage: string | null;
      }
    | undefined;
  try {
    [row] = await db
      .select({
        id: articlesTable.id,
        slug: articlesTable.slug,
        title: articlesTable.title,
        heroImage: articlesTable.heroImage,
        shareImage: articlesTable.shareImage,
        feedImage: articlesTable.feedImage,
      })
      .from(articlesTable)
      .where(eq(articlesTable.id, articleId))
      .limit(1);
  } catch (err) {
    logger.error({ err, articleId }, "ensureArticleSocialCard: article lookup failed");
    return null;
  }
  if (!row) return null;
  // Already has the square feed card — the ideal attached photo.
  if (row.feedImage) return row.feedImage;

  // Compose-on-demand only works from a stored hero object (not the branded
  // default card or an external URL). When we can't compose, fall through to the
  // best already-stored branded image.
  const hero = row.heroImage ?? "";
  if (hero.startsWith(PUBLIC_OBJECT_PREFIX)) {
    try {
      const rawPath = hero.slice(PUBLIC_OBJECT_PREFIX.length).split(/[?#]/)[0] ?? "";
      let filePath = rawPath;
      try {
        filePath = decodeURIComponent(rawPath);
      } catch {
        filePath = rawPath;
      }
      const file = await findPublicObject(filePath);
      if (file) {
        const [heroBuf] = await file.download();
        // Heal both cards from the one downloaded buffer so og:image (share) is
        // fixed alongside the attached feed photo. share is only (re)built when
        // it's also missing.
        const newFeed = await generateAndStoreFeedImage(heroBuf, row.title, row.slug);
        const newShare = row.shareImage
          ? null
          : await generateAndStoreShareImage(heroBuf, row.title, row.slug);
        const patch: Partial<typeof articlesTable.$inferInsert> = {};
        if (newFeed) patch.feedImage = newFeed;
        if (newShare) patch.shareImage = newShare;
        if (Object.keys(patch).length > 0) {
          patch.updatedAt = new Date();
          // Only write the columns that are still empty so a concurrent writer
          // (another poster or the bulk backfill) that populated them first wins
          // — we don't clobber an already-stored card with our freshly composed one.
          const stillMissing = and(
            eq(articlesTable.id, row.id),
            sql`(${articlesTable.feedImage} IS NULL OR ${articlesTable.feedImage} = '' OR ${articlesTable.shareImage} IS NULL OR ${articlesTable.shareImage} = '')`,
          );
          await db.update(articlesTable).set(patch).where(stillMissing);
        }
        if (newFeed) return newFeed;
        if (newShare) return newShare;
      }
    } catch (err) {
      logger.warn(
        { err, articleId },
        "ensureArticleSocialCard: on-demand card composition failed; using stored image",
      );
    }
  }
  return row.shareImage ?? row.heroImage ?? null;
}

// The committed branded default card (BrainHook lockup + tagline on black),
// bundled next to the compiled server (build.mjs copies assets/ into dist/).
const DEFAULT_CARD_ASSET = path.join(path.dirname(fileURLToPath(import.meta.url)), "default-card.png");

/**
 * Upload the committed branded default card to public object storage at the fixed
 * {@link DEFAULT_SHARE_CARD_PATH} so every picsum-free image fallback resolves to
 * a real, existing object (the on-page hero, og:image, and email all read this
 * URL). Idempotent — re-uploads the same bytes on each boot, healing fresh/reset
 * dev DBs and the separate prod bucket on deploy. Non-fatal: logs and returns on
 * failure so a storage hiccup never blocks startup.
 */
export async function ensureDefaultShareCard(): Promise<void> {
  try {
    const buf = await readFile(DEFAULT_CARD_ASSET);
    await uploadPublicBuffer(DEFAULT_SHARE_CARD_PATH, buf, "image/png");
    logger.info(
      { key: DEFAULT_SHARE_CARD_PATH, bytes: buf.length },
      "Ensured branded default share card in object storage",
    );
  } catch (err) {
    logger.error({ err }, "Failed to ensure branded default share card in object storage");
  }
}
