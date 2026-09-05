import type { SyntheticEvent } from "react";

/**
 * Branded BrainHook card shown when a hero image fails to load (e.g. the binary
 * is missing from object storage in a dev environment). A static asset bundled
 * in the site's `public/` dir — served reliably by the site itself, so it never
 * depends on an external service. Resolved with the artifact base path so it
 * works under the proxied path prefix. Never a picsum/stock placeholder.
 */
export const HERO_IMAGE_FALLBACK = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/brand-fallback.webp?v=3`;

/**
 * Resolve an article hero/avatar image source. Absolute URLs are returned as
 * is; root-relative and bare filenames are prefixed with the artifact base path.
 */
export function resolveImage(src: string): string {
  if (!src) return HERO_IMAGE_FALLBACK;
  if (src.startsWith("http") || src.startsWith("data:")) return src;
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  if (src.startsWith("/")) return `${base}${src}`;
  return `${base}/images/${src}`;
}

// Marker for images served by the API's public-object route, which supports
// on-the-fly resizing/WebP transforms via `?w=` query params. Other sources
// (external URLs, inline data URIs, bundled static files) are passed through
// untouched.
const STORAGE_MARKER = "/api/storage/public-objects/";

/**
 * True when a (resolved) URL points at the transformable public-object route.
 */
export function isStorageImage(resolvedUrl: string): boolean {
  return (
    !!resolvedUrl &&
    !resolvedUrl.startsWith("data:") &&
    resolvedUrl.includes(STORAGE_MARKER)
  );
}

/**
 * Append a width transform to an already-resolved storage URL. The server
 * negotiates WebP vs the original format from the request's `Accept` header, so
 * no explicit format param is needed. Non-storage URLs are returned unchanged.
 */
export function withImageParams(resolvedUrl: string, width?: number): string {
  if (!width || !isStorageImage(resolvedUrl)) return resolvedUrl;
  const sep = resolvedUrl.includes("?") ? "&" : "?";
  return `${resolvedUrl}${sep}w=${width}`;
}

/**
 * Build a `srcSet` string for the given widths from an already-resolved URL.
 * Returns undefined for non-storage URLs (no responsive variants available).
 */
export function buildSrcSet(
  resolvedUrl: string,
  widths: number[],
): string | undefined {
  if (!isStorageImage(resolvedUrl)) return undefined;
  return widths
    .map((w) => `${withImageParams(resolvedUrl, w)} ${w}w`)
    .join(", ");
}

/**
 * onError handler for hero/article images: swaps the broken source for the
 * branded fallback card and detaches itself to avoid an error loop.
 */
export function handleImageError(e: SyntheticEvent<HTMLImageElement>): void {
  const img = e.currentTarget;
  // Guard against an error loop if the branded fallback itself fails to load.
  // `img.src` is the browser-resolved absolute URL, so compare by suffix rather
  // than against the (base-relative) HERO_IMAGE_FALLBACK string.
  if (img.dataset.fallbackApplied || img.src.endsWith(HERO_IMAGE_FALLBACK)) return;
  img.dataset.fallbackApplied = "true";
  img.onerror = null;
  img.srcset = "";
  img.src = HERO_IMAGE_FALLBACK;
}
