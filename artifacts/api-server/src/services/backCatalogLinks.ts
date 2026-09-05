// --- Back Catalog link extraction + URL canonicalization (Task #228) ------
// PURE helpers (no DB, no logger, no network) so they stay unit-testable and can
// be imported by the test bundle without dragging in the pino worker transport.
// These parse an article body's markdown links, drop internal/non-web links, and
// canonicalize the remaining outbound URLs so the same source cited two slightly
// different ways (tracking params, trailing slash, casing) dedupes to one row.

import type { ArticleBlock } from "@workspace/db";

// Our own site: links to these hosts are internal navigation, never a "source".
const INTERNAL_HOSTS = ["brainhook.net", "www.brainhook.net"];

// Query-param keys that are pure tracking/analytics noise. Stripped during
// canonicalization so `?utm_source=…` variants of one URL collapse to one.
const TRACKING_PARAM_PREFIXES = ["utm_", "mc_", "pk_", "hsa_", "vero_"];
const TRACKING_PARAM_EXACT = new Set([
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "yclid",
  "twclid",
  "igshid",
  "igsh",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "ref_url",
  "referrer",
  "source",
  "cmpid",
  "campaign",
  "spm",
  "_hsenc",
  "_hsmi",
  "oly_enc_id",
  "oly_anon_id",
]);

/** A single outbound link found in an article body. */
export interface OutboundLink {
  /** The raw href exactly as written in the markdown. */
  href: string;
  /** The anchor/phrase the link wrapped. */
  anchorText: string;
}

// Markdown inline link: [anchor](href). Anchor is non-greedy and forbids nested
// brackets; href stops at the first whitespace or closing paren.
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(\s*([^)\s]+)\s*\)/g;

function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  if (TRACKING_PARAM_EXACT.has(k)) return true;
  return TRACKING_PARAM_PREFIXES.some((p) => k.startsWith(p));
}

/**
 * True when a href is NOT an outbound source: internal article/navigation
 * links, relative paths, in-page anchors, and non-http schemes (mailto/tel/
 * javascript/data). Only absolute http(s) links to another host are sources.
 */
export function isInternalUrl(href: string): boolean {
  const raw = href.trim();
  if (!raw) return true;
  // In-page anchors and root-relative/relative paths (incl. /article/<slug>).
  if (raw.startsWith("#") || raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../")) {
    return true;
  }
  const lower = raw.toLowerCase();
  // Non-web schemes.
  if (
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:") ||
    lower.startsWith("javascript:") ||
    lower.startsWith("data:")
  ) {
    return true;
  }
  // Must be an absolute http(s) URL.
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) return true;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return INTERNAL_HOSTS.includes(host);
  } catch {
    // Unparseable → treat as internal (skip) rather than harvest a junk URL.
    return true;
  }
}

/**
 * Canonicalize an outbound URL for dedup: lowercase host, drop the fragment,
 * strip tracking params (utm_*, fbclid, gclid, …), sort remaining params for a
 * stable key, and normalize a bare-root trailing slash. Returns null for any
 * non-http(s)/unparseable input. Path case is preserved (paths are
 * case-sensitive); only the host is lowercased.
 */
export function canonicalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  u.hostname = u.hostname.toLowerCase();
  u.hash = "";

  // Rebuild the query string without tracking params, in sorted order.
  const kept: [string, string][] = [];
  for (const [key, value] of u.searchParams.entries()) {
    if (!isTrackingParam(key)) kept.push([key, value]);
  }
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  u.search = "";
  for (const [key, value] of kept) u.searchParams.append(key, value);

  // Normalize an empty path to "/" and drop a lone trailing slash on the root
  // only (path-internal trailing slashes can be significant, so leave them).
  if (u.pathname === "") u.pathname = "/";

  let out = u.toString();
  // Drop a trailing "?" left when all params were tracking noise.
  out = out.replace(/\?$/, "");
  // Collapse "https://host/" → "https://host" for a cleaner canonical root.
  out = out.replace(/^(https?:\/\/[^/]+)\/$/, "$1");
  return out;
}

/** Lowercased registrable-ish host of a URL (www. stripped), or "". */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Extract every OUTBOUND source link from an article body. Walks all text-
 * bearing blocks, pulls markdown `[anchor](href)` links, skips internal/non-web
 * hrefs, canonicalizes the rest, and dedupes by canonical URL (first anchor
 * wins). Returns links keyed by their canonical URL.
 */
export function extractOutboundLinks(body: ArticleBlock[]): Array<{ url: string; anchorText: string }> {
  const seen = new Map<string, string>();
  for (const block of body ?? []) {
    const content = block && "content" in block ? block.content : undefined;
    if (typeof content !== "string" || content.length === 0) continue;
    MARKDOWN_LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MARKDOWN_LINK_RE.exec(content)) !== null) {
      const anchorText = m[1]!.trim();
      const href = m[2]!.trim();
      if (isInternalUrl(href)) continue;
      const canonical = canonicalizeUrl(href);
      if (!canonical) continue;
      if (!seen.has(canonical)) seen.set(canonical, anchorText);
    }
  }
  return Array.from(seen, ([url, anchorText]) => ({ url, anchorText }));
}
