import { randomUUID } from "crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { generatePhotoImage, NoImageDataError } from "@workspace/integrations-gemini-ai/image";
import type {
  MemeLayout,
  MemeTextArea,
  MemeExtraTextPosition,
  MemeTextPlacement,
  MemeTextZone,
  MemeBrandCorner,
} from "@workspace/db";
import { uploadPublicBuffer } from "../lib/objectStorage";
import { logger } from "../lib/logger";
import {
  W,
  PAD,
  renderTextLayer,
  renderParagraph,
  computeHeadlinePanelSlots,
  computeExplainerLayout,
  planOverlayCaption,
  type RenderTextOptions,
  type BandProfile,
} from "./memeRender";

const execFileAsync = promisify(execFile);

// Public object-storage key prefixes for the meme system. These are SEPARATE
// from `hero-images/` and `share-images/` — the meme pipeline must never touch
// hero/share behavior.
export const MEME_ORIGINAL_PREFIX = "meme-originals"; // base image (AI scene / uploaded / hero copy)
export const MEME_COMPOSED_PREFIX = "meme-composed"; // final composited meme
export const MEME_TEMPLATE_PREFIX = "meme-templates"; // reusable template base canvases

// Canvas size (W) and padding (PAD) live in ./memeRender alongside the text
// layer + slot geometry so the composer and the tests share one source of truth.

// Fonts available in the Nix image, referenced by absolute path so magick never
// silently falls back to a default face.
const SANS_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const SERIF_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf";
const SANS = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

// BrainHook logo lockup, bundled next to the compiled server (build.mjs copies
// assets/ into dist/). Resolved from this module's own URL so it works in dev
// and the bundled prod output alike.
const LOGO_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "brainhook-logo.png");

/**
 * Generate a text-free square AI scene for a meme and return the raw bytes.
 * Throws NoImageDataError on a content refusal (caller decides fallback). The
 * prompt MUST already instruct the model to render NO text — meme text is
 * composited by magick afterwards.
 *
 * Per the task spec, meme artwork generation NEVER auto-retries on ANY failure
 * (rate-limit included): a single attempt is made and any error bubbles straight
 * up so the orchestrator records the failure and the admin uses the explicit
 * manual "Try Again" control. Every pro-image generation is billed (~$0.13+),
 * so silent retries would multiply cost on exactly the failing memes.
 */
export async function generateMemeArtwork(
  prompt: string,
  slugHint: string,
): Promise<{ buf: Buffer; mimeType: string }> {
  try {
    const { b64_json, mimeType } = await generatePhotoImage(prompt, { aspectRatio: "1:1" });
    return { buf: Buffer.from(b64_json, "base64"), mimeType };
  } catch (err) {
    if (err instanceof NoImageDataError) {
      logger.warn(
        {
          slugHint,
          finishReason: err.finishReason,
          blockReason: err.blockReason,
          modelText: err.modelText?.slice(0, 300),
        },
        "Meme artwork refused by model (no safe-prompt retry)",
      );
    }
    throw err;
  }
}

/**
 * Upload a base/original meme image buffer (AI scene, admin upload, or a copy of
 * the article hero) to public object storage. Returns the served URL path.
 */
export async function uploadMemeOriginal(
  buf: Buffer,
  contentType: string,
  slugHint: string,
): Promise<string> {
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const key = `${MEME_ORIGINAL_PREFIX}/${slugHint}-${randomUUID().slice(0, 8)}.${ext}`;
  await uploadPublicBuffer(key, buf, contentType);
  return `/api/storage/public-objects/${key}`;
}

/**
 * Cover-crop a base image into a square WxW PNG (no text). The starting point
 * for every layout.
 */
async function makeSquareBase(inPath: string, outPath: string): Promise<void> {
  await execFileAsync("magick", [
    inPath,
    "-resize", `${W}x${W}^`,
    "-gravity", "center",
    "-extent", `${W}x${W}`,
    outPath,
  ]);
}

/**
 * Lay a slim translucent brand mark (logo lockup on one side, brainhook.net on
 * the other) onto a composed canvas. Best-effort: a missing logo asset downgrades
 * to text-only and never aborts the compose. `position` controls the corner band:
 * "bottom" (default) for the punchy layouts, "top" for the explainer layout whose
 * tall bottom panel is fully occupied by the summary paragraph.
 */
// Per-meme brand-footer placement overrides threaded from the meme row.
export interface BrandFooterConfig {
  logoCorner?: MemeBrandCorner;
  urlCorner?: MemeBrandCorner;
  logoOffsetXAdj?: number;
  logoOffsetYAdj?: number;
  urlOffsetXAdj?: number;
  urlOffsetYAdj?: number;
}

// Map a chosen corner to a magick gravity. "auto" / undefined fall back to the
// layout's default corner for this mark.
function brandCornerGravity(corner: MemeBrandCorner | undefined, fallback: string): string {
  switch (corner) {
    case "top_left":
      return "northwest";
    case "top_right":
      return "northeast";
    case "bottom_left":
      return "southwest";
    case "bottom_right":
      return "southeast";
    default:
      return fallback;
  }
}

// Clamp a brand-mark edge offset (base PAD + manual nudge). A small NEGATIVE
// offset is allowed on purpose: the logo and brainhook.net PNGs carry transparent
// padding, so the visible glyphs still look inset at offset 0 — letting the mark
// bleed past the edge (down to ~-20% of the canvas) pushes that artwork to the
// border. Inward travel is capped at ~45% so a mark can't reach the center.
function clampBrandOffset(value: number): number {
  return Math.max(-Math.round(W * 0.2), Math.min(Math.round(W * 0.45), Math.round(value)));
}

async function applyBrandFooter(
  canvasPath: string,
  dir: string,
  position: "top" | "bottom" = "bottom",
  brand: BrandFooterConfig = {},
): Promise<void> {
  const logoFallback = position === "top" ? "northwest" : "southwest";
  const urlFallback = position === "top" ? "northeast" : "southeast";
  const logoGravity = brandCornerGravity(brand.logoCorner, logoFallback);
  const urlGravity = brandCornerGravity(brand.urlCorner, urlFallback);
  const logoX = clampBrandOffset(PAD + (brand.logoOffsetXAdj ?? 0));
  const logoY = clampBrandOffset(PAD + (brand.logoOffsetYAdj ?? 0));
  const urlX = clampBrandOffset(PAD + (brand.urlOffsetXAdj ?? 0));
  const urlY = clampBrandOffset(PAD + (brand.urlOffsetYAdj ?? 0));
  const logoSmallPath = path.join(dir, "logo-small.png");
  const urlPath = path.join(dir, "url.png");
  try {
    await execFileAsync("magick", [LOGO_PATH, "-resize", "200x", logoSmallPath]);
    await execFileAsync("magick", [
      canvasPath,
      logoSmallPath, "-gravity", logoGravity, "-geometry", `+${logoX}+${logoY}`, "-composite",
      canvasPath,
    ]);
  } catch (err) {
    logger.warn({ err }, "Meme brand logo composite failed; using text-only footer");
  }
  await renderTextLayer(urlPath, "brainhook.net", {
    width: 360,
    height: 48,
    pointsize: 30,
    color: "white",
    font: SANS_BOLD,
    outline: false,
    uppercase: false,
    align: "right",
  });
  await execFileAsync("magick", [
    canvasPath,
    urlPath, "-gravity", urlGravity, "-geometry", `+${urlX}+${urlY}`, "-composite",
    canvasPath,
  ]);
}

export interface ComposeMemeInput {
  baseBuf: Buffer;
  layout: MemeLayout;
  topText: string;
  bottomText: string;
  extraText: string;
  // Where the optional "extra" caption is placed in the classic/split layouts:
  // "middle" (centered over the image, default) or "bottom" (below the other text).
  extraPosition?: MemeExtraTextPosition;
  // When a curated/custom template is used, its boxes drive placement instead of
  // the built-in layout geometry. Keyed by "top"/"bottom"/"extra".
  textAreas?: MemeTextArea[];
  // Advisory caption-placement hint from the scene-writing model (which zones it
  // left clear, where the subject sits). Used ONLY by the classic_top_bottom and
  // split_panel overlay layouts to break ties in the deterministic band analysis;
  // null for older memes, custom/uploaded artwork, or the panel layouts.
  placementHint?: MemeTextPlacement | null;
  // Manual caption nudges (pixels) for the classic/split overlay layouts only.
  // Added to the auto-computed offsets: +top moves the top caption DOWN from the top
  // edge, +bottom moves the bottom caption UP from the bottom edge. The final offset
  // is clamped on-canvas. 0 (default) = fully automatic placement.
  topOffsetAdj?: number;
  bottomOffsetAdj?: number;
  // Manual caption SIZE adjustments (percent delta) for the classic/split overlay
  // layouts only. Scales the auto-fitted font cap (and caption band height) so a
  // line can be made bigger or smaller: +25 = 25% larger, -25 = 25% smaller.
  // 0 (default) = fully automatic sizing. Clamped on-canvas.
  topSizeAdj?: number;
  bottomSizeAdj?: number;
  // Per-meme brand-footer placement overrides (logo + brainhook.net mark). Corner
  // choice + pixel nudge; defaults reproduce the automatic footer.
  brand?: BrandFooterConfig;
}

// Turn a percent-delta size adjustment into a clamped multiplier. The admin range
// is roughly -60%..+100%; we hard-clamp so a caption can never vanish or balloon
// off-canvas regardless of the stored value.
function captionSizeMultiplier(sizeAdj: number | undefined): number {
  const pct = Math.max(-60, Math.min(100, Math.round(sizeAdj ?? 0)));
  return 1 + pct / 100;
}

// Clamp a caption's edge offset so a manual nudge can never push the text off the
// canvas or so far in that it collides with the opposite caption.
function clampCaptionOffset(offset: number): number {
  const max = Math.round(W * 0.4);
  return Math.max(0, Math.min(max, Math.round(offset)));
}

/**
 * Measure the normalized brightness + busyness of the top, middle, and bottom
 * thirds of a square image. White outlined overlay captions sit in the top and
 * bottom bands, so the composer uses these to decide caption size + whether to
 * lay a readability scrim. Best-effort: any magick failure degrades to neutral
 * mid values (no scrim, base size) rather than aborting the compose.
 */
async function analyzeImageBands(
  squarePath: string,
): Promise<{ top: BandProfile; middle: BandProfile; bottom: BandProfile }> {
  const third = Math.round(W / 3);
  const measure = async (yOff: number): Promise<BandProfile> => {
    try {
      const { stdout } = await execFileAsync("magick", [
        squarePath,
        "-colorspace", "Gray",
        "-crop", `${W}x${third}+0+${yOff}`,
        "+repage",
        "-format", "%[fx:mean] %[fx:standard_deviation]",
        "info:",
      ]);
      const [mean, sd] = stdout.trim().split(/\s+/).map(Number);
      return {
        brightness: Number.isFinite(mean) ? mean : 0.5,
        busyness: Number.isFinite(sd) ? sd : 0,
      };
    } catch (err) {
      logger.warn({ err }, "Meme band analysis failed; using neutral profile");
      return { brightness: 0.5, busyness: 0 };
    }
  };
  const [top, middle, bottom] = await Promise.all([
    measure(0),
    measure(third),
    measure(W - third),
  ]);
  return { top, middle, bottom };
}

// How tall a readability scrim extends from the top/bottom edge. The gradient
// fades to transparent before the middle so the artwork is never fully dimmed.
const SCRIM_H = Math.round(W * 0.3);

/**
 * Trim a rendered caption PNG down to its visible text (outline included),
 * discarding the transparent band padding around it. Caption layers are rendered
 * into a box (so long lines wrap/shrink to fit), but the text is centered inside
 * that box — so when the layer is anchored by its edge, the empty band padding
 * floats the visible text away from the edge (a stray gap above the bottom logo).
 * Trimming makes the composite offset mean "edge → visible text", not "edge →
 * empty band". Best-effort: a trim failure (e.g. an all-transparent layer) leaves
 * the untrimmed file in place.
 */
async function trimCaptionLayer(layerPath: string): Promise<void> {
  try {
    await execFileAsync("magick", [layerPath, "-trim", "+repage", layerPath]);
  } catch (err) {
    logger.warn({ err }, "Meme caption trim failed; using untrimmed layer");
  }
}

/**
 * Render a soft top- or bottom-anchored darkening gradient (transparent toward
 * the center) used behind overlay captions when the underlying band is busy or
 * bright. Best-effort.
 */
async function renderScrim(outPath: string, zone: "top" | "bottom", heightPx: number): Promise<void> {
  // black→transparent for a top scrim (dark at the very top), the reverse for a
  // bottom scrim; alpha is multiplied down so the dimming stays subtle.
  const grad = zone === "top" ? "gradient:black-none" : "gradient:none-black";
  await execFileAsync("magick", [
    "-size", `${W}x${heightPx}`,
    grad,
    "-channel", "A", "-evaluate", "multiply", "0.5", "+channel",
    outPath,
  ]);
}

/**
 * True when the scene model said this overlay zone was left clear for text AND
 * the focal subject does not sit there. Null hint (older memes / custom artwork)
 * is treated as "clear" so the deterministic pixel analysis alone drives scrim.
 */
function zoneIsClear(hint: MemeTextPlacement | null | undefined, zone: MemeTextZone): boolean {
  if (!hint) return true;
  return hint.clearZones.includes(zone) && hint.subjectPosition !== zone;
}

/**
 * Compose a finished meme from a base image + text fields. Returns a JPEG
 * buffer. Throws if magick fails (orchestrator surfaces the error — there is no
 * silent placeholder for a build the admin explicitly requested).
 *
 * Three built-in layouts:
 *  - classic_top_bottom — impact-style outlined uppercase top & bottom captions
 *    over a square photo.
 *  - split_panel — square photo with a center divider; top & bottom captions on
 *    translucent bands (single-image "comparison").
 *  - headline_caption — square photo on top, solid panel below with a serif
 *    headline + a lighter caption line.
 *  - explainer — square photo on top, a TALL solid panel below holding an
 *    optional gold headline + a multi-sentence body paragraph (the longer
 *    "explainer" format for political/science deep-dives).
 *
 * A template's `textAreas` override the layout geometry: each field is placed in
 * its declared fractional box.
 */
export async function composeMeme(input: ComposeMemeInput): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "meme-"));
  const inPath = path.join(dir, "in.img");
  const squarePath = path.join(dir, "square.png");
  const canvasPath = path.join(dir, "canvas.png");
  const outPath = path.join(dir, "out.jpg");
  try {
    await writeFile(inPath, input.baseBuf);
    await makeSquareBase(inPath, squarePath);

    if (input.textAreas && input.textAreas.length > 0) {
      await composeWithTextAreas(squarePath, canvasPath, dir, input);
    } else if (input.layout === "explainer") {
      await composeExplainer(squarePath, canvasPath, dir, input);
    } else if (input.layout === "headline_caption") {
      await composeHeadlineCaption(squarePath, canvasPath, dir, input);
    } else if (input.layout === "split_panel") {
      await composeSplitPanel(squarePath, canvasPath, dir, input);
    } else {
      await composeClassic(squarePath, canvasPath, dir, input);
    }

    await applyBrandFooter(
      canvasPath,
      dir,
      input.layout === "explainer" ? "top" : "bottom",
      input.brand ?? {},
    );
    await execFileAsync("magick", [
      canvasPath,
      "-strip", "-interlace", "Plane", "-quality", "86",
      outPath,
    ]);
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Classic top/bottom caption layout. Captions are biased toward the top and
 * bottom edges (thin bands, small edge offsets) so the center artwork stays
 * visible. The bottom offset is measured from the SOUTH edge and kept large
 * enough to clear the brand footer in the bottom corners.
 */
async function composeClassic(
  squarePath: string,
  canvasPath: string,
  dir: string,
  input: ComposeMemeInput,
): Promise<void> {
  const topPath = path.join(dir, "top.png");
  const bottomPath = path.join(dir, "bottom.png");
  const composites: string[] = [squarePath];
  const fieldOpts: RenderTextOptions = {
    width: W - PAD * 2,
    // A thinner caption band so long lines hug the top/bottom edges instead of
    // bleeding toward the center and covering the artwork.
    height: Math.round(W * 0.2),
    pointsize: Math.round(W * 0.11),
    color: "white",
    font: SANS_BOLD,
    outline: true,
    uppercase: true,
    align: "center",
  };
  // Size + shield each overlay caption for the actual artwork: measure the image
  // bands, cap the font (so short lines don't balloon), and lay a scrim behind a
  // caption only when its band is busy/bright. The model's placement hint breaks
  // ties; the pixel analysis is authoritative.
  const bands = await analyzeImageBands(squarePath);
  const baseMaxPt = Math.round(W * 0.1);
  const topPlan = planOverlayCaption({
    band: bands.top,
    zone: "top",
    baseMaxPt,
    hintClear: zoneIsClear(input.placementHint, "top"),
  });
  const bottomPlan = planOverlayCaption({
    band: bands.bottom,
    zone: "bottom",
    baseMaxPt,
    hintClear: zoneIsClear(input.placementHint, "bottom"),
  });
  // Caption layers are trimmed to their visible text before compositing, so these
  // offsets are the gap from the canvas edge to the actual text (not empty band
  // padding). Bottom clears the brand logo (200x67 at PAD inset → top ~115px from
  // the bottom edge); top hugs the top edge. A manual per-meme nudge (clamped
  // on-canvas) is layered on top so an admin can fine-tune placement for free.
  const bottomOffset = clampCaptionOffset(Math.round(W * 0.115) + (input.bottomOffsetAdj ?? 0));
  const topOffset = clampCaptionOffset(Math.round(W * 0.022) + (input.topOffsetAdj ?? 0));
  // Per-field manual size: scale the font cap AND the band height by the same
  // clamped multiplier so a bigger caption actually gets more room to grow (and a
  // smaller one shrinks); 1x (default) reproduces the automatic sizing exactly.
  const topOpts = sizedFieldOpts(fieldOpts, topPlan.maxPointsize, input.topSizeAdj);
  const bottomOpts = sizedFieldOpts(fieldOpts, bottomPlan.maxPointsize, input.bottomSizeAdj);
  // Scrims go on BEFORE the text so the captions sit on top of them.
  if (input.topText.trim() && topPlan.scrim) {
    const scrimPath = path.join(dir, "scrim-top.png");
    await renderScrim(scrimPath, "top", SCRIM_H);
    composites.push(scrimPath, "-gravity", "north", "-geometry", "+0+0", "-composite");
  }
  if (input.bottomText.trim() && bottomPlan.scrim) {
    const scrimPath = path.join(dir, "scrim-bottom.png");
    await renderScrim(scrimPath, "bottom", SCRIM_H);
    composites.push(scrimPath, "-gravity", "south", "-geometry", "+0+0", "-composite");
  }
  if (await renderTextLayer(topPath, input.topText, topOpts)) {
    await trimCaptionLayer(topPath);
    composites.push(topPath, "-gravity", "north", "-geometry", `+0+${topOffset}`, "-composite");
  }
  if (await renderTextLayer(bottomPath, input.bottomText, bottomOpts)) {
    await trimCaptionLayer(bottomPath);
    composites.push(bottomPath, "-gravity", "south", "-geometry", `+0+${bottomOffset}`, "-composite");
  }
  await execFileAsync("magick", [...composites, canvasPath]);
}

// Apply a per-field manual size multiplier to a caption's render options: scales
// both the font cap and the box height (so positive adjustments truly grow the
// text instead of being box-limited), clamping the height to a safe ceiling.
function sizedFieldOpts(
  base: RenderTextOptions,
  maxPointsize: number,
  sizeAdj: number | undefined,
): RenderTextOptions {
  const mul = captionSizeMultiplier(sizeAdj);
  const height = Math.min(Math.round(W * 0.4), Math.round((base.height ?? Math.round(W * 0.2)) * mul));
  return { ...base, height, maxPointsize: Math.max(1, Math.round(maxPointsize * mul)) };
}

async function composeSplitPanel(
  squarePath: string,
  canvasPath: string,
  dir: string,
  input: ComposeMemeInput,
): Promise<void> {
  const bandedPath = path.join(dir, "banded.png");
  const topPath = path.join(dir, "top.png");
  const bottomPath = path.join(dir, "bottom.png");
  const bandH = Math.round(W * 0.18);
  // No translucent bands and NO center divider line: the text reads cleanly
  // straight over the photo via a bold black outline (the classic meme
  // treatment). (A faint white center rule used to be drawn here; it read as an
  // unwanted line through the middle of every split meme, so it's gone.)
  await execFileAsync("magick", [squarePath, bandedPath]);
  const fieldOpts: RenderTextOptions = {
    width: W - PAD * 2,
    height: bandH,
    pointsize: Math.round(W * 0.075),
    color: "white",
    font: SANS_BOLD,
    outline: true,
    uppercase: true,
    align: "center",
  };
  // Size + shield each band caption for the actual artwork (see composeClassic).
  const bands = await analyzeImageBands(squarePath);
  const baseMaxPt = Math.round(W * 0.075);
  const topPlan = planOverlayCaption({
    band: bands.top,
    zone: "top",
    baseMaxPt,
    hintClear: zoneIsClear(input.placementHint, "top"),
  });
  const bottomPlan = planOverlayCaption({
    band: bands.bottom,
    zone: "bottom",
    baseMaxPt,
    hintClear: zoneIsClear(input.placementHint, "bottom"),
  });
  const composites: string[] = [bandedPath];
  // Caption layers are trimmed to their visible text before compositing, so these
  // offsets are the gap from the canvas edge to the actual text. Bottom clears the
  // brand logo (~115px from the bottom edge); top hugs the top edge. A manual
  // per-meme nudge (clamped on-canvas) lets an admin fine-tune placement for free.
  const bottomOffset = clampCaptionOffset(Math.round(W * 0.115) + (input.bottomOffsetAdj ?? 0));
  const topOffset = clampCaptionOffset(Math.round(W * 0.022) + (input.topOffsetAdj ?? 0));
  // Per-field manual size: scale the font cap AND the band height (see composeClassic).
  const topOpts = sizedFieldOpts(fieldOpts, topPlan.maxPointsize, input.topSizeAdj);
  const bottomOpts = sizedFieldOpts(fieldOpts, bottomPlan.maxPointsize, input.bottomSizeAdj);
  // Scrims go on BEFORE the text so the captions sit on top of them.
  if (input.topText.trim() && topPlan.scrim) {
    const scrimPath = path.join(dir, "scrim-top.png");
    await renderScrim(scrimPath, "top", SCRIM_H);
    composites.push(scrimPath, "-gravity", "north", "-geometry", "+0+0", "-composite");
  }
  if (input.bottomText.trim() && bottomPlan.scrim) {
    const scrimPath = path.join(dir, "scrim-bottom.png");
    await renderScrim(scrimPath, "bottom", SCRIM_H);
    composites.push(scrimPath, "-gravity", "south", "-geometry", "+0+0", "-composite");
  }
  if (await renderTextLayer(topPath, input.topText, topOpts)) {
    await trimCaptionLayer(topPath);
    composites.push(topPath, "-gravity", "north", "-geometry", `+0+${topOffset}`, "-composite");
  }
  if (await renderTextLayer(bottomPath, input.bottomText, bottomOpts)) {
    await trimCaptionLayer(bottomPath);
    composites.push(bottomPath, "-gravity", "south", "-geometry", `+0+${bottomOffset}`, "-composite");
  }
  await execFileAsync("magick", [...composites, canvasPath]);
}

async function composeHeadlineCaption(
  squarePath: string,
  canvasPath: string,
  dir: string,
  input: ComposeMemeInput,
): Promise<void> {
  const stackedPath = path.join(dir, "stacked.png");
  const headlinePath = path.join(dir, "headline.png");
  const captionPath = path.join(dir, "caption.png");
  const headline = input.topText || input.extraText;
  // Optional kicker (small uppercase) above the headline — only when "extra" is a
  // distinct line, so it isn't duplicated when it's standing in as the headline.
  const kicker = input.extraText.trim() && input.extraText !== headline ? input.extraText : "";
  // Lay out the panel as contiguous, non-overlapping slots (all north-anchored) so
  // headline/caption can never collide regardless of how long any line is. Each
  // slot is a hard box that renderTextLayer shrink-fits into. The geometry is a
  // pure fn (memeRender) so the no-overlap invariant is unit-tested.
  const slots = computeHeadlinePanelSlots(Boolean(kicker));
  // Square photo on top, solid dark panel below.
  await execFileAsync("magick", [
    "-size", `${W}x${slots.totalH}`, "xc:#0c0e14",
    squarePath, "-gravity", "north", "-geometry", "+0+0", "-composite",
    stackedPath,
  ]);
  const composites: string[] = [stackedPath];
  if (kicker && slots.kicker) {
    const kickerPath = path.join(dir, "kicker.png");
    if (
      await renderTextLayer(kickerPath, kicker, {
        width: slots.contentWidth,
        height: slots.kicker.h,
        pointsize: Math.round(W * 0.032),
        color: "#9aa3b2",
        font: SANS_BOLD,
        outline: false,
        uppercase: true,
        align: "center",
      })
    ) {
      composites.push(kickerPath, "-gravity", "north", "-geometry", `+0+${slots.kicker.y}`, "-composite");
    }
  }
  // Headline (serif bold).
  if (
    await renderTextLayer(headlinePath, headline, {
      width: slots.contentWidth,
      height: slots.headline.h,
      pointsize: Math.round(W * 0.06),
      color: "white",
      font: SERIF_BOLD,
      outline: false,
      uppercase: false,
      align: "center",
    })
  ) {
    composites.push(headlinePath, "-gravity", "north", "-geometry", `+0+${slots.headline.y}`, "-composite");
  }
  // Caption (lighter sans) in the bottom slot.
  if (
    await renderTextLayer(captionPath, input.bottomText, {
      width: slots.contentWidth,
      height: slots.caption.h,
      pointsize: Math.round(W * 0.034),
      color: "#c9cdd6",
      font: SANS,
      outline: false,
      uppercase: false,
      align: "center",
    })
  ) {
    composites.push(captionPath, "-gravity", "north", "-geometry", `+0+${slots.caption.y}`, "-composite");
  }
  await execFileAsync("magick", [...composites, canvasPath]);
}

// The explainer renders its headline + body at FIXED point sizes (not auto-fit),
// so every generation looks identical in weight and reads cleanly on a phone.
// The dark panel is then sized to fit the wrapped copy (see computeExplainerLayout),
// which is what keeps the text readable and removes the dead grey gap.
const EXPLAINER_HEADLINE_PT = Math.round(W * 0.05); // ~54px gold kicker
const EXPLAINER_BODY_PT = Math.round(W * 0.037); // ~40px body — readable in feed

async function composeExplainer(
  squarePath: string,
  canvasPath: string,
  dir: string,
  input: ComposeMemeInput,
): Promise<void> {
  const headlinePath = path.join(dir, "explainer-headline.png");
  const bodyPath = path.join(dir, "explainer-body.png");
  // The explainer headline is a short gold kicker; the body is the long
  // paragraph. Fall back so the paragraph is never silently dropped if only one
  // of the fields is populated.
  const headline = input.topText.trim();
  const body = input.bottomText.trim() || input.extraText.trim();
  const contentWidth = W - PAD * 2;

  // Render the headline + body at a fixed, readable size and measure how tall
  // each wrapped to; the panel is sized from those heights so the copy is never
  // crushed and there is no empty band between the photo and the text.
  let headlineH = 0;
  if (headline) {
    headlineH = await renderParagraph(headlinePath, headline, {
      width: contentWidth,
      pointsize: EXPLAINER_HEADLINE_PT,
      color: "#f3c34e",
      font: SANS_BOLD,
      uppercase: true,
      align: "center",
    });
  }
  const bodyH = await renderParagraph(bodyPath, body, {
    width: contentWidth,
    pointsize: EXPLAINER_BODY_PT,
    color: "white",
    font: SANS_BOLD,
    uppercase: false,
    align: "center",
  });

  const hasHeadline = headlineH > 0;
  const layout = computeExplainerLayout({ headlineH, bodyH, hasHeadline });

  // Square photo on top, dark panel sized to fit the copy below, then the text.
  const composites: string[] = [
    "-size", `${W}x${layout.totalH}`, "xc:#0c0e14",
    squarePath, "-gravity", "north", "-geometry", "+0+0", "-composite",
  ];
  if (hasHeadline && layout.headlineY != null) {
    composites.push(headlinePath, "-gravity", "north", "-geometry", `+0+${layout.headlineY}`, "-composite");
  }
  if (bodyH > 0) {
    composites.push(bodyPath, "-gravity", "north", "-geometry", `+0+${layout.bodyY}`, "-composite");
  }
  await execFileAsync("magick", [...composites, canvasPath]);
}

async function composeWithTextAreas(
  squarePath: string,
  canvasPath: string,
  dir: string,
  input: ComposeMemeInput,
): Promise<void> {
  const valueByKey: Record<string, string> = {
    top: input.topText,
    bottom: input.bottomText,
    extra: input.extraText,
  };
  const composites: string[] = [squarePath];
  let i = 0;
  for (const area of input.textAreas ?? []) {
    const value = valueByKey[area.key] ?? "";
    if (!value.trim()) continue;
    const layerPath = path.join(dir, `area-${i++}.png`);
    const boxW = Math.max(1, Math.round(area.width * W));
    const boxH = Math.max(1, Math.round(area.height * W));
    const ok = await renderTextLayer(layerPath, value, {
      width: boxW,
      height: boxH,
      pointsize: Math.max(12, Math.round(area.fontSize * W)),
      color: area.color || "white",
      font: SANS_BOLD,
      outline: area.outline,
      uppercase: area.uppercase,
      align: area.align,
    });
    if (!ok) continue;
    const x = Math.round(area.x * W);
    const y = Math.round(area.y * W);
    composites.push(layerPath, "-gravity", "northwest", "-geometry", `+${x}+${y}`, "-composite");
  }
  await execFileAsync("magick", [...composites, canvasPath]);
}

/**
 * Upload a finished composed meme JPEG to public object storage. Returns the
 * served URL path.
 */
export async function uploadComposedMeme(buf: Buffer, slugHint: string): Promise<string> {
  const key = `${MEME_COMPOSED_PREFIX}/${slugHint}-${randomUUID().slice(0, 8)}.jpg`;
  await uploadPublicBuffer(key, buf, "image/jpeg");
  return `/api/storage/public-objects/${key}`;
}

/**
 * Upload an admin-provided template base image (decoded from a data URL) under
 * `meme-templates/`. Returns the served URL path.
 */
export async function uploadTemplateImage(
  buf: Buffer,
  contentType: string,
  slugHint: string,
): Promise<string> {
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const key = `${MEME_TEMPLATE_PREFIX}/${slugHint}-${randomUUID().slice(0, 8)}.${ext}`;
  await uploadPublicBuffer(key, buf, contentType);
  return `/api/storage/public-objects/${key}`;
}

/**
 * Generate an ORIGINAL BrainHook base canvas for a curated template format and
 * upload it under `meme-templates/`. We cannot embed copyrighted meme
 * screenshots, so each curated "format" ships as a clean, neutral BrainHook base
 * canvas (solid/gradient panels) that the composer overlays text onto. Admins
 * can replace the base with a rights-held image via upload. Returns the served
 * URL path. Idempotent at a fixed key per slug so a re-seed heals it.
 */
export async function generateTemplateBaseCanvas(
  slug: string,
  layout: MemeLayout,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "memetpl-"));
  const outPath = path.join(dir, "tpl.png");
  try {
    if (layout === "split_panel") {
      // Two-tone comparison panels (top warm / bottom cool) with a divider.
      await execFileAsync("magick", [
        "-size", `${W}x${W / 2}`, "gradient:#1f2a44-#16203a", path.join(dir, "tophalf.png"),
      ]);
      await execFileAsync("magick", [
        "-size", `${W}x${W / 2}`, "gradient:#3a1f24-#2a1620", path.join(dir, "bothalf.png"),
      ]);
      await execFileAsync("magick", [
        "-size", `${W}x${W}`, "xc:#0c0e14",
        path.join(dir, "tophalf.png"), "-gravity", "north", "-composite",
        path.join(dir, "bothalf.png"), "-gravity", "south", "-composite",
        outPath,
      ]);
    } else if (layout === "headline_caption") {
      await execFileAsync("magick", ["-size", `${W}x${W}`, "gradient:#1a2030-#0c0e14", outPath]);
    } else {
      // classic_top_bottom — neutral dark canvas with subtle vignette.
      await execFileAsync("magick", [
        "-size", `${W}x${W}`, "radial-gradient:#222838-#0c0e14", outPath,
      ]);
    }
    const buf = await readFile(outPath);
    const key = `${MEME_TEMPLATE_PREFIX}/${slug}.png`;
    await uploadPublicBuffer(key, buf, "image/png");
    return `/api/storage/public-objects/${key}`;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
