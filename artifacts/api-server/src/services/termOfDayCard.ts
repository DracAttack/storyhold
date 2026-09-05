import { randomUUID } from "crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { uploadPublicBuffer } from "../lib/objectStorage";
import { logger } from "../lib/logger";

const execFileAsync = promisify(execFile);

// Square feed canvas — Facebook renders an uploaded 1:1 photo full-width.
const CARD_W = 1080;
const CARD_H = 1080;
const PAD = 88;
const CONTENT_W = CARD_W - PAD * 2;

// Brand palette (mirrors the site / email brand constants).
const TERRACOTTA = "#AC5639";
const CREAM = "#F2EFE7";
const INK = "#1D1B16";
const BODY_GRAY = "#4A463E";

const SERIF_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf";
const SERIF = "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf";
const SANS_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

// BrainHook logo lockup PNG bundled next to the compiled server (build.mjs
// copies assets/ into dist/); resolved from this module's URL so it works in
// dev and the bundled prod output alike.
const LOGO_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "brainhook-logo.png");
const LOGO_W = 240;

/** Neutralize magick caption/label escapes (`%`, leading `@`). */
function magickSafe(text: string): string {
  return text.replace(/%/g, "%%").replace(/^@/, " @").trim();
}

/** Trim to a max length on a word boundary with an ellipsis. */
export function ellipsize(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max - 1).trimEnd()}…`;
}

// Manual shrink-to-fit: pointsize computed from text length. NEVER use magick's
// no-pointsize caption auto-fit — it hangs on this ImageMagick build.
function termPointsize(term: string): number {
  const len = term.length;
  if (len <= 12) return 112;
  if (len <= 20) return 94;
  if (len <= 30) return 78;
  if (len <= 42) return 64;
  return 54;
}

function definitionPointsize(text: string): number {
  const len = text.length;
  if (len <= 140) return 46;
  if (len <= 220) return 41;
  if (len <= 320) return 37;
  return 33;
}

/**
 * Compose the branded 1080×1080 "Term of the Day" card: cream canvas,
 * terracotta accents, "TERM OF THE DAY" kicker, the term in large serif, the
 * definition beneath, and the BrainHook logo + glossary URL footer. Pure
 * template — NO AI image generation, so composing is free and deterministic.
 *
 * Each text layer renders to its own PNG before compositing: magick's
 * `-size`/`-background` settings leak across `( ... )` groups in one command,
 * so layers are built with one command each (mirrors shareImage.ts).
 *
 * Returns a JPEG buffer, or null when magick fails (the post then goes out
 * without an attached image rather than failing the day).
 */
export async function composeTermOfDayCard(
  term: string,
  definition: string,
): Promise<Buffer | null> {
  const dir = await mkdtemp(path.join(tmpdir(), "tod-"));
  const basePath = path.join(dir, "base.png");
  const kickerPath = path.join(dir, "kicker.png");
  const termPath = path.join(dir, "term.png");
  const defPath = path.join(dir, "def.png");
  const logoDispPath = path.join(dir, "logo.png");
  const footerPath = path.join(dir, "footer.png");
  const outPath = path.join(dir, "out.jpg");

  const safeTerm = magickSafe(term);
  const safeDef = magickSafe(ellipsize(definition, 360));

  try {
    // 1. Base: cream canvas with terracotta top/bottom bands and a short
    //    accent rule under where the kicker sits.
    await execFileAsync("magick", [
      "-size", `${CARD_W}x${CARD_H}`, `xc:${CREAM}`,
      "-fill", TERRACOTTA,
      "-draw", `rectangle 0,0,${CARD_W},16`,
      "-draw", `rectangle 0,${CARD_H - 16},${CARD_W},${CARD_H}`,
      "-draw", `rectangle ${PAD},214,${PAD + 110},220`,
      basePath,
    ]);
    // 2. Kicker: "TERM OF THE DAY", terracotta caps, letter-spaced sans.
    await execFileAsync("magick", [
      "-background", "none", "-fill", TERRACOTTA, "-font", SANS_BOLD,
      "-pointsize", "40", "-kerning", "10",
      "label:TERM OF THE DAY",
      kickerPath,
    ]);
    // 3. The term itself: big serif, ink, wrapped to the content width.
    await execFileAsync("magick", [
      "-background", "none", "-fill", INK, "-font", SERIF_BOLD,
      "-pointsize", String(termPointsize(safeTerm)),
      "-size", `${CONTENT_W}x`, "-interline-spacing", "6",
      `caption:${safeTerm}`,
      termPath,
    ]);
    // 4. Definition: readable serif body, wrapped.
    await execFileAsync("magick", [
      "-background", "none", "-fill", BODY_GRAY, "-font", SERIF,
      "-pointsize", String(definitionPointsize(safeDef)),
      "-size", `${CONTENT_W}x`, "-interline-spacing", "12",
      `caption:${safeDef}`,
      defPath,
    ]);
    // 5. Footer: logo lockup + glossary URL.
    await execFileAsync("magick", [LOGO_PATH, "-resize", `${LOGO_W}x`, logoDispPath]);
    await execFileAsync("magick", [
      "-background", "none", "-fill", BODY_GRAY, "-font", SANS_BOLD,
      "-pointsize", "30", "-kerning", "2",
      "label:brainhook.net/glossary",
      footerPath,
    ]);
    // Measure the term block so the definition sits directly beneath it
    // regardless of how many lines the term wrapped to.
    const { stdout: termHOut } = await execFileAsync("magick", [
      "identify", "-format", "%h", termPath,
    ]);
    const termH = Number.parseInt(termHOut.trim(), 10) || 120;
    const termY = 268;
    const defY = termY + termH + 56;

    // 6. Composite everything onto the base.
    await execFileAsync("magick", [
      basePath,
      kickerPath, "-gravity", "northwest", "-geometry", `+${PAD}+140`, "-composite",
      termPath, "-gravity", "northwest", "-geometry", `+${PAD}+${termY}`, "-composite",
      defPath, "-gravity", "northwest", "-geometry", `+${PAD}+${defY}`, "-composite",
      logoDispPath, "-gravity", "southwest", "-geometry", `+${PAD}+92`, "-composite",
      footerPath, "-gravity", "southeast", "-geometry", `+${PAD}+104`, "-composite",
      "-strip", "-interlace", "Plane", "-quality", "88",
      outPath,
    ]);
    return await readFile(outPath);
  } catch (err) {
    logger.warn({ err, term }, "Term of the Day card composition failed; posting without image");
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Compose the Term of the Day card and upload it to public object storage under
 * `term-cards/`. Returns the served URL path, or null when composition fails.
 */
export async function generateAndStoreTermOfDayCard(
  term: string,
  definition: string,
  slugHint: string,
): Promise<string | null> {
  const t0 = Date.now();
  const buf = await composeTermOfDayCard(term, definition);
  if (!buf) return null;
  const key = `term-cards/${slugHint}-${randomUUID().slice(0, 8)}.jpg`;
  await uploadPublicBuffer(key, buf, "image/jpeg");
  const url = `/api/storage/public-objects/${key}`;
  logger.info({ slugHint, ms: Date.now() - t0, bytes: buf.length, url }, "Generated Term of the Day card");
  return url;
}
