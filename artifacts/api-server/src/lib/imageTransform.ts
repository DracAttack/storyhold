import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

const execFileAsync = promisify(execFile);

export type TransformFormat = "webp" | "avif" | "jpeg" | "png";

const CONTENT_TYPES: Record<TransformFormat, string> = {
  webp: "image/webp",
  avif: "image/avif",
  jpeg: "image/jpeg",
  png: "image/png",
};

const EXTENSIONS: Record<TransformFormat, string> = {
  webp: "webp",
  avif: "avif",
  jpeg: "jpg",
  png: "png",
};

export function contentTypeFor(format: TransformFormat): string {
  return CONTENT_TYPES[format];
}

/**
 * Resize and/or transcode an image buffer using the `magick` (ImageMagick) CLI.
 * `width` only ever shrinks (the `>` flag), so requesting a width larger than
 * the source returns the source dimensions. Metadata is stripped. Returns the
 * encoded buffer in the requested format.
 */
// Snapchat Creative Kit "sticker" cards are vertical. We letterbox the existing
// landscape share card onto a 9:16 black canvas so the shared Snap fills the
// screen (the only way to approximate a Spotify-style full card from the web,
// where the sticker is the only image surface a website can set).
export const SNAP_CARD_WIDTH = 1080;
export const SNAP_CARD_HEIGHT = 1920;

export async function transformImage(
  input: Buffer,
  opts: { width?: number; format: TransformFormat; snap?: boolean },
): Promise<Buffer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imgtx-"));
  const inPath = path.join(dir, `in-${randomUUID().slice(0, 8)}`);
  const outPath = path.join(dir, `out-${randomUUID().slice(0, 8)}.${EXTENSIONS[opts.format]}`);
  try {
    await writeFile(inPath, input);
    const args: string[] = [inPath, "-auto-orient"];
    if (opts.snap) {
      // Contain the source within the 9:16 box (no upscale beyond the box) and
      // pad the remainder with black, centered. Produces a tall card whose art
      // is the original landscape share card centered on black.
      args.push(
        "-resize",
        `${SNAP_CARD_WIDTH}x${SNAP_CARD_HEIGHT}`,
        "-background",
        "black",
        "-gravity",
        "center",
        "-extent",
        `${SNAP_CARD_WIDTH}x${SNAP_CARD_HEIGHT}`,
      );
    } else if (opts.width && Number.isFinite(opts.width)) {
      // `>` => only shrink images larger than the target, never upscale.
      args.push("-resize", `${Math.round(opts.width)}x>`);
    }
    args.push("-strip");
    if (opts.format === "webp") {
      args.push("-quality", "80");
    } else if (opts.format === "avif") {
      args.push("-quality", "50");
    } else if (opts.format === "jpeg") {
      args.push("-interlace", "Plane", "-quality", "82");
    }
    args.push(outPath);
    await execFileAsync("magick", args, { timeout: 25000 });
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
