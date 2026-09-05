import { Router, type IRouter, type Request, type Response } from "express";
import path from "path";
import { findPublicObject, uploadPublicBuffer } from "../lib/objectStorage";
import {
  transformImage,
  contentTypeFor,
  type TransformFormat,
} from "../lib/imageTransform";

const router: IRouter = Router();

// Allowed derivative widths. Requests are snapped UP to the nearest step so the
// cache key space stays bounded no matter what width the client asks for.
const WIDTH_STEPS = [160, 200, 320, 400, 600, 768, 800, 900, 1200, 1280, 1600];
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);
const FORCEABLE_FORMATS = new Set<TransformFormat>(["webp", "avif", "jpeg", "png"]);

// Cache derivatives under this prefix. Requests for paths already inside it are
// NEVER transformed again — this prevents recursive second-order derivatives
// (a storage/compute amplification vector on this public route).
const DERIVED_PREFIX = "_derived/";
// Skip transforming pathologically large sources (our heroes are ~1-2MB); the
// original is streamed instead so the URL still resolves.
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

type StorageFile = NonNullable<Awaited<ReturnType<typeof findPublicObject>>>;

function clampWidth(raw: unknown): number | null {
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  for (const step of WIDTH_STEPS) if (n <= step) return step;
  return WIDTH_STEPS[WIDTH_STEPS.length - 1];
}

function forcedFormat(raw: unknown): TransformFormat | null {
  if (typeof raw !== "string") return null;
  const f = raw.toLowerCase() as TransformFormat;
  return FORCEABLE_FORMATS.has(f) ? f : null;
}

function originalFormatFromExt(ext: string): TransformFormat {
  if (ext === ".png") return "png";
  if (ext === ".webp") return "webp";
  if (ext === ".avif") return "avif";
  return "jpeg";
}

// Auto-upgrade to WebP when the browser accepts it. AVIF is only produced on an
// explicit `?format=avif` request to avoid slow first-hit encodes on the
// serving path.
function negotiateFormat(accept: string, original: TransformFormat): TransformFormat {
  if (accept.includes("image/webp")) return "webp";
  return original;
}

class OriginalMissingError extends Error {}

// De-dupe concurrent generation of the same derivative within this process.
const inflight = new Map<string, Promise<void>>();

async function ensureDerivative(
  filePath: string,
  derivativeKey: string,
  width: number | null,
  format: TransformFormat,
  snap = false,
): Promise<void> {
  let pending = inflight.get(derivativeKey);
  if (!pending) {
    pending = (async () => {
      const original = await findPublicObject(filePath);
      if (!original) throw new OriginalMissingError();
      const [meta] = await original.getMetadata();
      if (Number(meta.size ?? 0) > MAX_SOURCE_BYTES) {
        throw new Error("Source image too large to transform");
      }
      const [buf] = await original.download();
      const out = await transformImage(buf, {
        width: width ?? undefined,
        format,
        snap,
      });
      await uploadPublicBuffer(derivativeKey, out, contentTypeFor(format));
    })();
    inflight.set(derivativeKey, pending);
    // The awaiter below (and concurrent route handlers) observe `pending`'s
    // rejection directly. This detached cleanup chain must NOT surface its own
    // unhandled rejection — without the trailing `.catch`, a failing transform
    // (e.g. a missing `magick` binary in production) escapes as an
    // unhandledRejection and crashes the whole process.
    void pending.finally(() => inflight.delete(derivativeKey)).catch(() => {});
  }
  await pending;
}

function streamObject(
  file: StorageFile,
  contentType: string,
  req: Request,
  res: Response,
): void {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("Vary", "Accept");
  const nodeStream = file.createReadStream();
  nodeStream.on("error", (err: unknown) => {
    req.log.error({ err }, "Error streaming public object");
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to stream object" });
    } else {
      res.destroy();
    }
  });
  nodeStream.pipe(res);
}

/**
 * GET /storage/public-objects/*
 * Serve a public asset from object storage. Cached aggressively because
 * uploaded keys include a random suffix.
 *
 * Optional image transforms via query params (applied to image files only):
 *   ?w=<width>        resize down to <width> (snapped to a bounded set)
 *   ?format=<fmt>     force webp|avif|jpeg|png
 * When no `format` is forced, the response is negotiated from the `Accept`
 * header (WebP when supported, else the original format). Derivatives are
 * generated once via ImageMagick and cached back into object storage under a
 * `_derived/` prefix. If a transform fails, the original bytes are served so a
 * URL never hard-fails to a broken image.
 */
router.get(
  "/storage/public-objects/*filePath",
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.filePath;
      const filePath = Array.isArray(raw) ? raw.join("/") : raw;

      const width = clampWidth(req.query.w);
      const forced = forcedFormat(req.query.format);
      const snap = req.query.snap === "1" || req.query.snap === "true";
      const ext = path.extname(filePath).toLowerCase();

      // No transform requested, not a transformable image, or already a cached
      // derivative → stream original (never derive from a derivative).
      if (
        (width === null && forced === null && !snap) ||
        !IMAGE_EXTS.has(ext) ||
        filePath.startsWith(DERIVED_PREFIX)
      ) {
        const file = await findPublicObject(filePath);
        if (!file) {
          res.status(404).json({ error: "File not found" });
          return;
        }
        const [metadata] = await file.getMetadata();
        streamObject(
          file,
          (metadata.contentType as string) || "application/octet-stream",
          req,
          res,
        );
        return;
      }

      const original = originalFormatFromExt(ext);

      // Snapchat sticker mode: always a fixed-size 9:16 JPEG (the landscape card
      // letterboxed on black). Width/format negotiation does not apply.
      let targetFormat: TransformFormat;
      let derivativeKey: string;
      if (snap) {
        targetFormat = "jpeg";
        derivativeKey = `_derived/${filePath}/snap916.jpg`;
      } else {
        targetFormat =
          forced ?? negotiateFormat(String(req.headers["accept"] || ""), original);

        // Nothing to do (same format, no resize) → stream original.
        if (width === null && targetFormat === original) {
          const file = await findPublicObject(filePath);
          if (!file) {
            res.status(404).json({ error: "File not found" });
            return;
          }
          const [metadata] = await file.getMetadata();
          streamObject(
            file,
            (metadata.contentType as string) || contentTypeFor(original),
            req,
            res,
          );
          return;
        }

        derivativeKey = `_derived/${filePath}/w${width ?? "orig"}.${targetFormat}`;
      }

      let derivative = await findPublicObject(derivativeKey);

      if (!derivative) {
        try {
          await ensureDerivative(filePath, derivativeKey, width, targetFormat, snap);
        } catch (err) {
          if (err instanceof OriginalMissingError) {
            res.status(404).json({ error: "File not found" });
            return;
          }
          // Transform failed: degrade gracefully to the original bytes.
          req.log.warn(
            { err, filePath, width, targetFormat },
            "Image transform failed; serving original",
          );
          const file = await findPublicObject(filePath);
          if (!file) {
            res.status(404).json({ error: "File not found" });
            return;
          }
          const [metadata] = await file.getMetadata();
          streamObject(
            file,
            (metadata.contentType as string) || contentTypeFor(original),
            req,
            res,
          );
          return;
        }
        derivative = await findPublicObject(derivativeKey);
      }

      if (!derivative) {
        res.status(500).json({ error: "Failed to produce image" });
        return;
      }
      streamObject(derivative, contentTypeFor(targetFormat), req, res);
    } catch (error) {
      req.log.error({ err: error }, "Error serving public object");
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to serve public object" });
      }
    }
  },
);

export default router;
