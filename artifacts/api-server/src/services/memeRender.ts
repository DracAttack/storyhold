import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Pure-ish meme rendering primitives shared by the composer (memeImage.ts) and
// the layout/clipping tests (memeRender.test.ts). This module intentionally
// depends ONLY on Node builtins + the `magick` binary so it can be imported into
// the bundled test runner without dragging in object storage / Gemini / logger.

const execFileAsync = promisify(execFile);

// Composed memes are square 1080×1080 (the headline_caption layout extends the
// canvas downward with a caption panel). Square reads well in the Facebook feed
// and is a safe base for cross-posting.
export const W = 1080;
export const PAD = 48;

// The soft drop shadow applied to non-outlined text (`-shadow 90x4+0+2`, sigma 4)
// is composited AFTER the shrink-fit resize, so it adds a small, fixed penumbra
// beyond the (already box-fitted) core text. Empirically this bleed is ~16px
// total across each dimension (~8px per edge); we budget 20px as the documented
// upper bound. The CORE glyphs always stay inside the box — only this soft,
// semi-transparent shadow extends past it, which is visually acceptable and is
// why the headline-panel slot gap need only exceed the core boxes, not the
// shadow. memeRender.test.ts enforces this budget against the real render.
export const SHADOW_BLEED_PX = 20;

/**
 * Neutralize the two characters magick's caption/label engine treats as escapes
 * (`%` formatting and a leading `@` = read-from-file) so user text renders
 * literally.
 */
export function safeText(text: string): string {
  return text.replace(/%/g, "%%").replace(/^@/, " @").trim();
}

export interface RenderTextOptions {
  width: number;
  height: number;
  pointsize: number;
  color: string;
  font: string;
  outline: boolean;
  uppercase: boolean;
  align: "left" | "center" | "right";
  // Upper bound on the auto-fitted font size. Without it, `caption:` maximizes the
  // font to FILL the whole box, so a short line balloons to fit a tall slot. When
  // set, the text first tries to render at this fixed point size (width-only wrap);
  // it only falls back to box auto-fit when even that overflows the box height.
  // This caps the on-image text size without ever clipping long captions.
  maxPointsize?: number;
}

/**
 * Render a single text field to its own transparent PNG sized to a box. magick's
 * `-size`/`-background` settings leak across `( ... )` groups in one invocation,
 * so EVERY text layer is rendered in its own command and composited later.
 *
 * Traditional-meme behaviour: `caption:` is given the FULL box (width AND height)
 * with NO fixed pointsize, so magick auto-picks the LARGEST font that fits the
 * wrapped text into the box. The text therefore runs nearly edge-to-edge and
 * wraps to as few lines as actually fit — instead of a big fixed font wrapping to
 * 2–3 words per line and then being shrunk down (which read tiny and cramped).
 * `pointsize` is no longer used for sizing (kept only for interface stability).
 *
 * Outlined (classic meme) text gets a uniform black outline built by dilating the
 * glyph alpha — this stays clean under auto-fit, whereas `-stroke` would clip at
 * the box edges once the text fills the box. Non-outlined text gets a soft drop
 * shadow for legibility over photos.
 */
export async function renderTextLayer(
  outPath: string,
  rawText: string,
  opts: RenderTextOptions,
): Promise<boolean> {
  const text = opts.uppercase ? rawText.toUpperCase() : rawText;
  if (!text.trim()) return false;
  const gravity = opts.align === "left" ? "West" : opts.align === "right" ? "East" : "Center";
  const w = Math.round(opts.width);
  const h = Math.round(opts.height);
  // Outline thickness scales with the box height (≈ the auto-fitted font size),
  // so it stays proportional whether the slot is tall (classic) or short (band).
  const outline = opts.outline ? Math.max(2, Math.round(h * 0.045)) : 0;
  // Inner padding leaves room for the outline/shadow and a hair of breathing space
  // so glyphs go nearly — but not quite — edge-to-edge and never clip at the slot.
  const pad = outline + Math.max(2, Math.round(w * 0.012));
  const innerW = Math.max(1, w - pad * 2);
  const innerH = Math.max(1, h - pad * 2);
  // Decide the sizing strategy. By default `caption:` is given BOTH dimensions and
  // no -pointsize, so it maximizes the font to fill the box (short lines balloon).
  // When a maxPointsize is set, first measure the text wrapped to the box WIDTH at
  // that fixed size: if it fits within the box height we render at the fixed size
  // (capping the balloon); otherwise we fall back to box auto-fit so long captions
  // still shrink to fit rather than clip.
  const cap = opts.maxPointsize && opts.maxPointsize > 0 ? Math.round(opts.maxPointsize) : 0;
  let fixedPt = 0;
  if (cap > 0) {
    const { stdout } = await execFileAsync("magick", [
      "-background", "none",
      "-font", opts.font,
      "-pointsize", String(cap),
      "-size", `${innerW}x`,
      `caption:${safeText(text)}`,
      "-format", "%h",
      "info:",
    ]);
    const measuredH = Number.parseInt(stdout.trim(), 10) || 0;
    if (measuredH > 0 && measuredH <= innerH) fixedPt = cap;
  }
  const sizeArgs =
    fixedPt > 0
      ? ["-pointsize", String(fixedPt), "-size", `${innerW}x`]
      : ["-size", `${innerW}x${innerH}`];
  const args = [
    "-background", "none",
    "-gravity", gravity,
    "-fill", opts.color,
    "-font", opts.font,
    // Either a capped fixed size (width-only wrap) or full-box auto-fit.
    ...sizeArgs,
    `caption:${safeText(text)}`,
    // Pad back out to the full slot so the outline/shadow has clean room and the
    // composited layer matches the intended box size.
    "-bordercolor", "none", "-border", String(pad),
  ];
  if (opts.outline) {
    // Build a uniform outline by dilating the text's alpha into a black silhouette
    // and compositing the fill text back on top.
    args.push(
      "(", "+clone", "-channel", "A", "-morphology", "Dilate", `Disk:${outline}`, "+channel",
      "-fill", "black", "-colorize", "100", ")",
      "+swap", "-compose", "over", "-composite",
    );
  } else {
    // Soft drop shadow so non-outlined text reads over busy artwork.
    args.push(
      "(", "+clone", "-background", "black", "-shadow", "90x4+0+2", ")",
      "+swap", "-background", "none", "-layers", "merge", "+repage",
    );
  }
  args.push(outPath);
  await execFileAsync("magick", args);
  return true;
}

export interface RenderParagraphOptions {
  width: number;
  pointsize: number;
  color: string;
  font: string;
  uppercase?: boolean;
  align?: "left" | "center" | "right";
}

/**
 * Render a multi-line paragraph at a FIXED point size, wrapped to `width`, and
 * return its actual rendered pixel height. Unlike `renderTextLayer` (which
 * auto-fits text to fill a fixed box — variable, often tiny font, and slow on
 * long copy), this keeps the font size CONSTANT and lets the layer grow as tall
 * as the wrapped text needs. The explainer layout uses this so every generation
 * renders the summary at the same readable size and the panel is then sized to
 * fit the text (no dead gap). Width-only `caption:` with a fixed `-pointsize`
 * wraps and grows downward; a soft drop shadow keeps it legible over the panel.
 * Returns 0 for blank text (caller skips the slot).
 */
export async function renderParagraph(
  outPath: string,
  rawText: string,
  opts: RenderParagraphOptions,
): Promise<number> {
  const text = opts.uppercase ? rawText.toUpperCase() : rawText;
  if (!text.trim()) return 0;
  const gravity = opts.align === "left" ? "West" : opts.align === "right" ? "East" : "Center";
  const w = Math.round(opts.width);
  const args = [
    "-background", "none",
    "-gravity", gravity,
    "-fill", opts.color,
    "-font", opts.font,
    "-pointsize", String(Math.max(1, Math.round(opts.pointsize))),
    "-size", `${w}x`,
    `caption:${safeText(text)}`,
    // Soft drop shadow (composited after wrapping) so the copy reads over the panel.
    "(", "+clone", "-background", "black", "-shadow", "90x4+0+2", ")",
    "+swap", "-background", "none", "-layers", "merge", "+repage",
    outPath,
  ];
  await execFileAsync("magick", args);
  const { stdout } = await execFileAsync("magick", ["identify", "-format", "%h", outPath]);
  return Number.parseInt(stdout.trim(), 10) || 0;
}

export interface Slot {
  y: number;
  h: number;
}

export interface HeadlinePanelSlots {
  panelH: number;
  totalH: number;
  // Top-left content width shared by every slot (kicker/headline/caption).
  contentWidth: number;
  kicker: Slot | null;
  headline: Slot;
  caption: Slot;
}

/**
 * Compute the contiguous, non-overlapping slot geometry for the headline_caption
 * layout's bottom panel. Every slot is north-anchored at an absolute Y on the
 * full canvas (square photo height W + panel below). Returning this as a pure
 * function lets the composer and the tests agree on the exact boxes so the
 * no-overlap invariant is verifiable without rendering.
 */
export function computeHeadlinePanelSlots(hasKicker: boolean): HeadlinePanelSlots {
  const panelH = Math.round(W * 0.3);
  const totalH = W + panelH;
  const margin = Math.round(panelH * 0.08);
  const gap = Math.round(panelH * 0.04);
  const usable = panelH - margin * 2;
  const kickerH = hasKicker ? Math.round(panelH * 0.16) : 0;
  const captionH = Math.round(panelH * 0.28);
  const headlineH = usable - captionH - gap - (hasKicker ? kickerH + gap : 0);

  let slotY = W + margin;
  let kicker: Slot | null = null;
  if (hasKicker) {
    kicker = { y: slotY, h: kickerH };
    slotY += kickerH + gap;
  }
  const headline: Slot = { y: slotY, h: headlineH };
  slotY += headlineH + gap;
  const caption: Slot = { y: slotY, h: captionH };

  return { panelH, totalH, contentWidth: W - PAD * 2, kicker, headline, caption };
}

export interface ExplainerLayout {
  panelH: number;
  totalH: number;
  // Top-left content width shared by the headline + body layers.
  contentWidth: number;
  // Absolute north-anchored Y of each rendered layer on the full canvas, or null
  // when there is no headline.
  headlineY: number | null;
  bodyY: number;
}

/**
 * Compute the `explainer` layout's panel geometry from the ALREADY-RENDERED
 * heights of the headline and body layers (see `renderParagraph`). The text is
 * rendered at a fixed, readable point size and wraps to as many lines as it
 * needs, so the panel is sized to fit the copy — `marginTop + headline + gap +
 * body + marginBottom` — instead of cramming variable-length copy into a fixed
 * box (the old behavior, which shrank long summaries to an unreadable sliver and
 * left a dead gap above short ones). A short body is padded up to a minimum
 * panel height and the content block is vertically centered, so the result is
 * always snug: no giant grey gap between the photo and the copy, and a
 * consistent font size across every generation. Pure so it is unit-tested
 * without rendering.
 */
export function computeExplainerLayout(opts: {
  headlineH: number;
  bodyH: number;
  hasHeadline: boolean;
}): ExplainerLayout {
  const marginTop = Math.round(W * 0.05);
  const marginBottom = Math.round(W * 0.055);
  const gap = Math.round(W * 0.028);
  const headlineH = opts.hasHeadline ? Math.max(0, Math.round(opts.headlineH)) : 0;
  const bodyH = Math.max(1, Math.round(opts.bodyH));
  const contentH = (opts.hasHeadline ? headlineH + gap : 0) + bodyH;

  // Floor so a one-sentence summary still reads as a deliberate panel rather than
  // a thin strip; when content exceeds it, the panel grows to fit.
  const minPanelH = Math.round(W * 0.3);
  const panelH = Math.max(minPanelH, marginTop + contentH + marginBottom);
  const totalH = W + panelH;

  // Vertically center the content block within the panel. When the panel is
  // exactly content + margins this equals marginTop; when minPanelH padded a
  // short body, this centers it instead of leaving the slack at the bottom.
  const blockTop = W + Math.max(marginTop, Math.round((panelH - contentH) / 2));
  let y = blockTop;
  let headlineY: number | null = null;
  if (opts.hasHeadline) {
    headlineY = y;
    y += headlineH + gap;
  }

  return { panelH, totalH, contentWidth: W - PAD * 2, headlineY, bodyY: y };
}

// Normalized (0–1) brightness + busyness of an image band, measured by the
// composer (analyzeImageBands) so overlay captions can be sized and shielded for
// the actual artwork rather than blindly. `brightness` is the mean luma;
// `busyness` is the luma standard deviation (high = lots of detail/contrast that
// fights white text).
export interface BandProfile {
  brightness: number;
  busyness: number;
}

// The composer's decision for one overlay caption: the capped font size and
// whether to lay a readability scrim behind it.
export interface OverlayTextPlan {
  maxPointsize: number;
  scrim: boolean;
}

// Thresholds (on the normalized 0–1 scale) above which an image band is "busy"
// or "bright" enough that white outlined text needs a scrim to stay readable.
// Tuned conservatively: a calm, mid-dark photo gets no scrim at all.
const BAND_BUSY = 0.2;
const BAND_BRIGHT = 0.62;
// Softer thresholds used only to nudge a borderline band when the scene model
// says the zone was NOT left clear for text (or the subject sits there).
const BAND_BUSY_SOFT = 0.14;
const BAND_BRIGHT_SOFT = 0.55;

/**
 * Decide how to render one overlay caption (classic/split layouts) over a given
 * image band. Pure so it is unit-tested without rendering.
 *
 * - `scrim`: true when the band is busy or bright enough that white outlined text
 *   would struggle. A model placement hint (`hintClear=false`, i.e. the scene did
 *   NOT keep this zone clear) lowers the bar so a borderline band still gets a
 *   scrim; a `hintClear=true` zone only scrims on the hard thresholds.
 * - `maxPointsize`: the base cap, shrunk slightly when the zone is busy AND the
 *   model didn't flag it as clear, so the caption occupies less of the noisy area.
 *
 * The deterministic pixel measurement is authoritative; the hint only breaks ties.
 */
export function planOverlayCaption(opts: {
  band: BandProfile;
  zone: "top" | "bottom";
  baseMaxPt: number;
  hintClear: boolean;
}): OverlayTextPlan {
  const busy = opts.band.busyness > BAND_BUSY;
  const bright = opts.band.brightness > BAND_BRIGHT;
  let scrim = busy || bright;
  if (!opts.hintClear && (opts.band.busyness > BAND_BUSY_SOFT || opts.band.brightness > BAND_BRIGHT_SOFT)) {
    scrim = true;
  }
  let maxPointsize = Math.round(opts.baseMaxPt);
  if (busy && !opts.hintClear) {
    maxPointsize = Math.round(opts.baseMaxPt * 0.85);
  }
  return { maxPointsize: Math.max(1, maxPointsize), scrim };
}
