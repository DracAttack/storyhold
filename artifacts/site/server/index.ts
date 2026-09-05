import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request } from "express";
import {
  resolveSeoTitle,
  resolveSeoDescription,
  resolveSocialTitle,
  resolveHookText,
  type HookVariantLike,
  type HookAssignmentsLike,
} from "../src/lib/seoText.ts";
import { toArticleTitleCase } from "../src/lib/utils.ts";
import {
  PRIVACY_POLICY,
  TERMS_OF_USE,
  EDITORIAL_POLICY,
  CORRECTIONS_POLICY,
  CONTACT_PAGE,
  type PolicyDoc,
} from "../src/lib/policyContent.ts";
import { ADSENSE_CLIENT } from "../src/components/ads/adsense-config.ts";

/**
 * Production server for the BrainHook site.
 *
 * In development the app is served by Vite (client-side `useSeo` handles meta,
 * which is fine for browsers and JS-rendering crawlers). In production this tiny
 * server serves the built static assets AND injects route-specific SEO meta
 * (title, description, canonical, Open Graph, Twitter, JSON-LD) into the HTML
 * shell on every request — so non-JS bots and social scrapers (Facebook, X,
 * LinkedIn, Slack, Discord) see correct per-article tags. Article and category
 * data is read from the public API, so newly auto-published articles get correct
 * previews instantly with no redeploys.
 */

const SITE_NAME = "BrainHook";
const DEFAULT_TITLE = "BrainHook — Real Research. No BS.";
const DEFAULT_DESCRIPTION =
  "BrainHook explores the intersections of science, psychology, and human behavior to tell stories that matter — real research without the clickbait.";

// Number of articles per SSR-rendered archive page (author/category). Matches
// the client-side PAGE_SIZE in author.tsx so page 1 SSR content aligns with
// the first JS-rendered batch.
const SSR_PAGE_SIZE = 24;
// Hard upper bound on ?page= to prevent absurd DB offsets and unbounded cache keys.
const MAX_PAGE = 9999;

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dir, "public");
const INDEX_HTML = readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");

const PORT = Number(process.env.PORT) || 21238;
// Internal proxy origin used to reach the API server (same pattern as ad-hoc
// service-to-service calls in this monorepo). Overridable for flexibility.
const API_ORIGIN = (process.env.SEO_API_ORIGIN || "http://localhost:80").replace(/\/$/, "");
// Computed once at startup so the fetchJson fallback never uses a
// request-derived (potentially attacker-controlled) host header.
const TRUSTED_FALLBACK_BASE = (() => {
  const explicit = process.env.SITE_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]!.trim()}`;
  return ""; // local dev without env vars: no outbound fallback
})();

function log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ level, time: new Date().toISOString(), msg, ...extra }) + "\n");
}

/**
 * Per-request context tracking whether any API fetch could not be reached on any
 * origin (a genuine error, not an authoritative 404). On the autoscale platform
 * the instance can cold-start and answer a crawler request *before* the API
 * server is listening, so the prerender data fetch fails and the route falls
 * back to an empty/degraded shell. We must NOT cache such a degraded response —
 * otherwise one cold-start miss poisons the CDN (and our in-memory cache) for up
 * to a minute, serving an empty `#root` to crawlers/AdSense. The flag lets the
 * handler send `Cache-Control: no-store` and lets data getters skip caching the
 * error so the very next request (API now warm) re-fetches and renders fully.
 */
interface RequestContext {
  // Count (not a boolean) so a getter can tell whether *its own* fetch(es) newly
  // failed, even if an earlier fetch in the same request already failed.
  errorCount: number;
}
const requestContext = new AsyncLocalStorage<RequestContext>();
function markFetchError(): void {
  const store = requestContext.getStore();
  if (store) store.errorCount += 1;
}
function fetchErrorCount(): number {
  return requestContext.getStore()?.errorCount ?? 0;
}
function hadFetchError(): boolean {
  return fetchErrorCount() > 0;
}

/** Remove the default SEO tags from the shell so per-route tags never duplicate. */
function stripManaged(html: string): string {
  return html
    .replace(/<title>[\s\S]*?<\/title>/i, "")
    .replace(/\s*<meta\s+name="description"[^>]*>/gi, "")
    .replace(/\s*<meta\s+name="robots"[^>]*>/gi, "")
    .replace(/\s*<meta\s+property="og:[^"]*"[^>]*>/gi, "")
    .replace(/\s*<meta\s+name="twitter:[^"]*"[^>]*>/gi, "")
    .replace(/\s*<link\s+rel="alternate"\s+type="application\/rss\+xml"[^>]*>/gi, "");
}

// Robots directive for indexable pages: opt into Google Discover / Search large
// image previews (BrainHook is image-heavy) with no snippet/preview limits.
const ROBOTS_INDEXABLE = "max-image-preview:large, max-snippet:-1, max-video-preview:-1";

// Branded default share image (in the built `public/` dir), used whenever a
// route has no specific image (homepage, about, category, static pages) so every
// shared link renders a rich large-image card. 16:9, 1280×720. Keep in sync with
// the HTML shell and the client `useSeo` defaults.
const DEFAULT_SHARE_IMAGE_PATH = "/og-brand-card.jpg?v=2";
const DEFAULT_SHARE_IMAGE_WIDTH = 1280;
const DEFAULT_SHARE_IMAGE_HEIGHT = 720;
const DEFAULT_SHARE_IMAGE_ALT = "BrainHook — Real Research. No BS.";

// Snapchat sticker card (9:16). Snapchat only lets a website set a sticker, so a
// vertical full-screen image mimics a Spotify-style full card. Article images
// are letterboxed to 9:16 on the fly via the API image route (`?snap=1`); routes
// with no specific image use this static branded vertical card. Mirrors the
// client `useSeo` builder.
const DEFAULT_SNAP_STICKER_PATH = "/opengraph-snap.jpg";

const STRIPPED_SHELL = stripManaged(INDEX_HTML);

// The plain shell with its robots directive flipped to noindex. Served for any
// route that resolves to no known page (404s, /admin, unknown paths) so
// low-value/utility URLs never enter the index with the shell's indexable
// default. Falls back to appending the tag if the shell's robots meta ever
// changes shape.
const NOINDEX_SHELL = /<meta\s+name="robots"[^>]*>/i.test(INDEX_HTML)
  ? INDEX_HTML.replace(/<meta\s+name="robots"[^>]*>/i, '<meta name="robots" content="noindex, nofollow" />')
  : INDEX_HTML.replace("</head>", '<meta name="robots" content="noindex, nofollow" />\n  </head>');

function escAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escJsonLd(json: string): string {
  // Prevent a "</script>" inside data from breaking out of the script tag.
  return json.replace(/</g, "\\u003c");
}

/** Escape text destined for an HTML text node (body content, not attributes). */
function escHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Mirrors the client `renderInline` in src/pages/article.tsx: convert inline
// Markdown links to real anchors so crawlers/non-JS clients get followable
// links. External citations open in a new tab and are nofollow; internal
// rabbit-hole links (/article/<slug>) are plain followable in-app links. All
// surrounding prose and link labels are HTML-escaped.
// Inline tokens supported inside paragraph text: Markdown links, **bold**, and
// *italic*. Bold is tried before italic so `**x**` isn't mis-read as italic.
// Emphasis content must be non-empty and not start/end with whitespace, which
// keeps stray asterisks (e.g. "5 * 3") from accidentally emphasizing. Kept in
// sync with INLINE_TOKEN_RE / renderInline in src/pages/article.tsx.
const INLINE_TOKEN_RE =
  /\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/article\/[^\s)]+)\)|\*\*([^\s*](?:[^*]*[^\s*])?)\*\*|\*([^\s*](?:[^*]*[^\s*])?)\*/g;
// The model is asked to emit Markdown links, but it occasionally writes a raw
// HTML <a href="…">label</a> tag instead. Those would otherwise render as
// literal angle-bracket text, so normalize them back to Markdown before parsing
// (strip any stray inner tags from the label). Kept identical to the client copy
// in src/pages/article.tsx.
const HTML_ANCHOR_RE = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
function htmlAnchorsToMarkdown(text: string): string {
  return text.replace(HTML_ANCHOR_RE, (_m, _q, href, label) => {
    const cleanLabel = String(label).replace(/<[^>]+>/g, "").trim();
    const cleanHref = String(href).trim();
    return `[${cleanLabel || cleanHref}](${cleanHref})`;
  });
}
// Citation markers: when an in-body external link's URL matches one of the
// article's references, a superscript [n] follows the link and jumps to the
// matching entry in the numbered References list (#ref-n). Kept in sync with
// normalizeCitationUrl / renderInline in src/pages/article.tsx.
function normalizeCitationUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}${u.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}
function renderInlineHtml(raw: string, refNumbers?: Map<string, number>): string {
  return parseInlineHtml(htmlAnchorsToMarkdown(raw), refNumbers);
}

/** True when a link points to an article on this site, whether stored as a
 *  root-relative path or a full URL on the current origin. */
function isInternalLink(href: string): boolean {
  if (href.startsWith("/article/")) return true;
  try {
    const u = new URL(href);
    return u.pathname.startsWith("/article/");
  } catch {
    return false;
  }
}

// Recursive so emphasis can nest inside a link label (and vice versa). A fresh
// RegExp per call keeps the global lastIndex isolated across recursion.
function parseInlineHtml(text: string, refNumbers?: Map<string, number>): string {
  let out = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(INLINE_TOKEN_RE.source, "g");
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) out += escHtml(text.slice(lastIndex, match.index));
    if (match[2] !== undefined) {
      const href = match[2];
      const inner = parseInlineHtml(match[1]!);
      if (isInternalLink(href)) {
        // Normalise to root-relative for consistent routing
        const linkHref = href.startsWith("/") ? href : new URL(href).pathname;
        out += `<a href="${escAttr(linkHref)}" class="internal-link">${inner}</a>`;
      } else {
        out += `<a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer nofollow">${inner}</a>`;
        const refNum = refNumbers?.get(normalizeCitationUrl(href));
        if (refNum) {
          out += `<sup><a href="#ref-${refNum}" aria-label="Jump to reference ${refNum}">[${refNum}]</a></sup>`;
        }
      }
    } else if (match[3] !== undefined) {
      out += `<strong>${parseInlineHtml(match[3], refNumbers)}</strong>`;
    } else if (match[4] !== undefined) {
      out += `<em>${parseInlineHtml(match[4], refNumbers)}</em>`;
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) out += escHtml(text.slice(lastIndex));
  return out;
}

function getBaseUrl(_req: Request): string {
  // Use the startup-computed TRUSTED_FALLBACK_BASE whenever available so that
  // canonical / og:url values are never derived from an attacker-controlled
  // forwarded-host header. In production SITE_BASE_URL is always set, so this
  // path is authoritative. In true local dev (no SITE_BASE_URL, no
  // REPLIT_DOMAINS) TRUSTED_FALLBACK_BASE is empty and we fall back to the
  // server's own port — never a request-derived header.
  if (TRUSTED_FALLBACK_BASE) return TRUSTED_FALLBACK_BASE;
  return `http://localhost:${PORT}`;
}

interface RouteMeta {
  title: string;
  /** Distinct title for social cards (og/twitter). Falls back to `title`. */
  socialTitle?: string;
  description?: string;
  canonicalPath: string;
  image?: string;
  imageWidth?: number;
  imageHeight?: number;
  imageAlt?: string;
  type: "website" | "article";
  jsonLd?: Record<string, unknown> | null;
  /** When true, emit a noindex robots directive instead of the indexable default. */
  noindex?: boolean;
  /**
   * Prerendered HTML injected into #root so crawlers and non-JS clients see the
   * full content without waiting for client-side React/API fetch. Additive: on
   * JS-enabled browsers React (createRoot) replaces it on mount.
   */
  rootHtml?: string;
  /**
   * When set, the route is a permanent redirect: the request handler emits a
   * 301 to this path instead of rendering. Used for retired author slugs.
   */
  redirectTo?: string;
  /**
   * Serialized route data embedded as a JSON script tag so the client can
   * hydrate React Query with the same data the server used for prerender,
   * avoiding a loading-skeleton flash on mount.
   */
  serializedData?: { key: string; json: string };
}

function absoluteImage(image: string | undefined, base: string): string | undefined {
  if (!image) return undefined;
  if (/^https?:\/\//i.test(image)) return image;
  return `${base}${image.startsWith("/") ? "" : "/"}${image}`;
}

/**
 * Site-wide structured data for non-article routes (homepage, about, category,
 * static pages). An `Organization` block ties the BrainHook name + brand logo
 * (`/icon-512.png`) to the site as a whole so Google can surface the logo in
 * search results / a knowledge panel, and a `WebSite` block names the site and
 * references the same Organization as its publisher. Emitted as a single
 * `@graph` object so it stays one `<script id="seo-jsonld">` and mirrors the
 * client `useSeo` (which manages exactly one JSON-LD script). No `SearchAction`
 * is included because the site has no on-site search endpoint to wire it to.
 */
function siteJsonLd(base: string): Record<string, unknown> {
  const orgId = `${base}/#organization`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": orgId,
        name: SITE_NAME,
        legalName: "Brainhook Media",
        url: `${base}/`,
        logo: { "@type": "ImageObject", url: `${base}/icon-512.png`, width: 512, height: 512 },
        email: "editor@brainhook.net",
        address: {
          "@type": "PostalAddress",
          addressLocality: "Phoenix",
          addressRegion: "AZ",
          addressCountry: "US",
        },
        employee: { "@type": "Person", name: "Damien Lynn", jobTitle: "Editor" },
      },
      {
        "@type": "WebSite",
        "@id": `${base}/#website`,
        name: SITE_NAME,
        url: `${base}/`,
        publisher: { "@id": orgId },
      },
    ],
  };
}

// JSON-LD for the per-author ProfilePage. Combines the route-specific schema
// (ProfilePage + Person) with the site-wide Organization/WebSite graph so every
// page has full publisher context. Mirrors what the client useSeo passes.
function buildAuthorJsonLd(
  slug: string,
  name: string,
  bio: string | undefined,
  base: string,
): Record<string, unknown> {
  const personUrl = `${base}/author/${slug}`;
  const siteGraph = siteJsonLd(base)["@graph"] as Record<string, unknown>[];
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "ProfilePage",
        "@id": `${personUrl}#profilepage`,
        name: `${name} — ${SITE_NAME}`,
        description: bio
          ? `${bio} Stories by ${name} on BrainHook.`
          : `All stories by ${name} on BrainHook.`,
        url: personUrl,
        mainEntity: {
          "@type": "Person",
          "@id": `${personUrl}#person`,
          name,
          ...(bio ? { description: bio } : {}),
          url: personUrl,
        },
        publisher: { "@id": `${base}/#organization` },
      },
      ...siteGraph,
    ],
  };
}

// JSON-LD for the per-category CollectionPage. Lists the first visible articles
// as an ItemList so search engines understand this as a topic hub.
function buildCategoryJsonLd(
  slug: string,
  name: string,
  description: string,
  items: PublicArticleSummary[],
  base: string,
): Record<string, unknown> {
  const pageUrl = `${base}/category/${slug}`;
  const siteGraph = siteJsonLd(base)["@graph"] as Record<string, unknown>[];
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        "@id": `${pageUrl}#collectionpage`,
        name: `${name} — ${SITE_NAME}`,
        description,
        url: pageUrl,
        mainEntity: {
          "@type": "ItemList",
          itemListElement: items.slice(0, 10).map((a, i) => ({
            "@type": "ListItem",
            position: i + 1,
            url: `${base}/article/${a.slug}`,
            name: a.title,
          })),
        },
        publisher: { "@id": `${base}/#organization` },
      },
      ...siteGraph,
    ],
  };
}

function buildHeadBlock(meta: RouteMeta, base: string): string {
  const fullTitle = meta.title.includes(SITE_NAME) ? meta.title : `${meta.title} | ${SITE_NAME}`;
  // Social cards use the social hook when provided, else the document title.
  const social = (meta.socialTitle ?? "").trim() || meta.title;
  const fullSocialTitle = social.includes(SITE_NAME) ? social : `${social} | ${SITE_NAME}`;
  const canonical = `${base}${meta.canonicalPath.startsWith("/") ? "" : "/"}${meta.canonicalPath}`;
  const lines: string[] = [];
  lines.push(`<title>${escAttr(fullTitle)}</title>`);
  if (meta.description) lines.push(`<meta name="description" content="${escAttr(meta.description)}" />`);
  lines.push(`<link rel="canonical" href="${escAttr(canonical)}" />`);
  lines.push(
    `<link rel="alternate" type="application/rss+xml" title="${escAttr(`${SITE_NAME} RSS Feed`)}" href="${escAttr(`${base}/rss.xml`)}" />`,
  );

  lines.push(`<meta property="og:locale" content="en_US" />`);
  lines.push(`<meta property="og:title" content="${escAttr(fullSocialTitle)}" />`);
  lines.push(`<meta property="og:type" content="${meta.type}" />`);
  lines.push(`<meta property="og:url" content="${escAttr(canonical)}" />`);
  lines.push(`<meta property="og:site_name" content="${SITE_NAME}" />`);
  if (meta.description) lines.push(`<meta property="og:description" content="${escAttr(meta.description)}" />`);

  // Resolve the share image: a route-specific image (e.g. an article hero) when
  // present, otherwise the branded default so every route renders a rich,
  // large-image card instead of a bare text preview.
  const image = meta.image ?? `${base}${DEFAULT_SHARE_IMAGE_PATH}`;
  const imageWidth = meta.image ? meta.imageWidth : DEFAULT_SHARE_IMAGE_WIDTH;
  const imageHeight = meta.image ? meta.imageHeight : DEFAULT_SHARE_IMAGE_HEIGHT;
  const imageAlt = meta.image ? (meta.imageAlt ?? fullTitle) : DEFAULT_SHARE_IMAGE_ALT;
  lines.push(`<meta property="og:image" content="${escAttr(image)}" />`);
  // secure_url only when the image is itself https (it always is in production).
  if (/^https:\/\//i.test(image)) {
    lines.push(`<meta property="og:image:secure_url" content="${escAttr(image)}" />`);
  }
  lines.push(`<meta property="og:image:alt" content="${escAttr(imageAlt)}" />`);
  if (imageWidth) lines.push(`<meta property="og:image:width" content="${imageWidth}" />`);
  if (imageHeight) lines.push(`<meta property="og:image:height" content="${imageHeight}" />`);

  // Snapchat Creative Kit sticker — a 9:16 card that fills the Snap (mirrors the
  // client seo builder). Article images are letterboxed to 9:16 on the fly
  // (`?snap=1`); routes with no specific image use the static branded card.
  const snapSticker = meta.image
    ? `${image}${image.includes("?") ? "&" : "?"}snap=1`
    : `${base}${DEFAULT_SNAP_STICKER_PATH}`;
  lines.push(`<meta property="snapchat:sticker" content="${escAttr(snapSticker)}" />`);

  // Robots: noindex routes opt out of indexing; everything else advertises the
  // large image preview directive that Google Discover / Search rely on.
  lines.push(
    `<meta name="robots" content="${meta.noindex ? "noindex, nofollow" : ROBOTS_INDEXABLE}" />`,
  );

  // AdSense loader — monetized routes only. The loader is deliberately NOT in
  // the global HTML shell (Google prohibits ad code on screens without
  // publisher content: admin, search, unsubscribe, policy pages, 404s), so it
  // is injected here for indexable article and glossary routes and lazily on
  // the client when an ad unit mounts (src/components/ads/loadAdSense.ts,
  // which no-ops when this tag is already present). Google's consent message
  // (Privacy & messaging) rides this loader, so EEA/UK/CH visitors get the
  // consent prompt exactly where ads can appear.
  const isAdSenseRoute =
    !meta.noindex &&
    (meta.type === "article" || meta.canonicalPath.startsWith("/glossary"));
  if (isAdSenseRoute) {
    lines.push(
      `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${escAttr(ADSENSE_CLIENT)}" crossorigin="anonymous"></script>`,
    );
  }

  lines.push(`<meta name="twitter:card" content="summary_large_image" />`);
  lines.push(`<meta name="twitter:title" content="${escAttr(fullSocialTitle)}" />`);
  if (meta.description) lines.push(`<meta name="twitter:description" content="${escAttr(meta.description)}" />`);
  lines.push(`<meta name="twitter:image" content="${escAttr(image)}" />`);
  lines.push(`<meta name="twitter:image:alt" content="${escAttr(imageAlt)}" />`);

  // Structured data: article pages carry their own Article JSON-LD (which
  // already references the publisher Organization + logo); every other route is
  // a "website" page and gets the site-wide Organization + WebSite graph so the
  // brand name and logo are associated with the site as a whole.
  const structuredData = meta.jsonLd ?? (meta.type === "website" ? siteJsonLd(base) : null);
  if (structuredData) {
    lines.push(
      `<script type="application/ld+json" id="seo-jsonld">${escJsonLd(JSON.stringify(structuredData))}</script>`,
    );
  }
  // Seed the client React Query cache with the same data the server used for
  // prerender, so the initial mount shows content immediately without a loading
  // skeleton that would flash between the SSR HTML and the first client render.
  if (meta.serializedData) {
    lines.push(
      `<script id="ssr-data-${meta.serializedData.key}" type="application/json">${escJsonLd(meta.serializedData.json)}</script>`,
    );
  }
  return lines.map((l) => `    ${l}`).join("\n");
}

// --- Data fetching (from the public API) with a small in-memory TTL cache. ---

interface CacheEntry {
  value: unknown;
  expires: number;
}
const cache = new Map<string, CacheEntry>();

// Maximum number of entries. When reached, the oldest quarter is evicted to
// prevent unbounded memory growth from unique crawler/attacker-generated URLs.
const MAX_CACHE_ENTRIES = 2000;

function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    cache.delete(key); // evict stale entry eagerly
    return undefined;
  }
  return entry.value as T;
}

function setCached(key: string, value: unknown, ttlMs: number): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Evict oldest 25% (Map insertion order) to bound memory.
    const evictCount = Math.ceil(MAX_CACHE_ENTRIES / 4);
    let evicted = 0;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (++evicted >= evictCount) break;
    }
  }
  cache.set(key, { value, expires: Date.now() + ttlMs });
}

type FetchResult = { kind: "ok"; data: unknown } | { kind: "not-found" } | { kind: "error" };

async function fetchJsonResult(url: string, timeoutMs = 2500): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) {
      // A 404 is expected for unknown slugs; anything else is worth surfacing
      // since it means crawlers fall back to generic site meta for that route.
      if (res.status === 404) return { kind: "not-found" };
      log("warn", "API fetch returned non-ok status", { url, status: res.status });
      return { kind: "error" };
    }
    return { kind: "ok", data: await res.json() };
  } catch (err) {
    log("warn", "API fetch failed", { url, error: err instanceof Error ? err.message : String(err) });
    return { kind: "error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch an API path, preferring the configured internal origin. If that fetch
 * fails (network error / non-ok — e.g. the internal port isn't reachable in a
 * deployment), self-heal by retrying through the public base URL derived from
 * the request, which routes back via the shared proxy to the same API server.
 * A 404 is authoritative (the slug doesn't exist), so it short-circuits without
 * a redundant retry against the same data on the public host.
 */
async function fetchJson(pathAndQuery: string, base: string): Promise<unknown | null> {
  const primaryUrl = `${API_ORIGIN}${pathAndQuery}`;
  const primary = await fetchJsonResult(primaryUrl);
  if (primary.kind === "ok") return primary.data;
  if (primary.kind === "not-found") return null;

  // Prefer the startup-computed trusted base (SITE_BASE_URL / REPLIT_DOMAINS).
  // In local dev where neither is set, allow a per-request fallback only when
  // the host is localhost/127.0.0.1 — never an arbitrary header-supplied host.
  const localDevBase =
    !TRUSTED_FALLBACK_BASE && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)
      ? base.replace(/\/$/, "")
      : "";
  const resolvedFallbackBase = TRUSTED_FALLBACK_BASE || localDevBase;
  const fallbackUrl = `${resolvedFallbackBase}${pathAndQuery}`;
  if (resolvedFallbackBase && fallbackUrl !== primaryUrl) {
    const fallback = await fetchJsonResult(fallbackUrl);
    if (fallback.kind === "ok") return fallback.data;
    if (fallback.kind === "not-found") return null;
  }
  // Could not reach the API on any origin (e.g. cold start before the API is
  // listening). Flag the request as degraded so the response and caches treat
  // this as transient rather than an authoritative empty result.
  markFetchError();
  return null;
}

interface PublicArticleBlock {
  type: string;
  content?: string;
  items?: string[];
}

interface PublicArticle {
  slug: string;
  title: string;
  dek: string;
  // Optional editor SEO overrides; null/absent when unset (site derives them).
  seoTitle?: string | null;
  seoDescription?: string | null;
  category: string;
  categorySlug: string;
  heroImage: string;
  // Branded composite share card for og:image / twitter:image. Null/absent when
  // not generated — the raw hero is used as the fallback share image.
  shareImage?: string | null;
  publishedAt: string;
  readingTimeMinutes?: number;
  body?: PublicArticleBlock[];
  author: { slug: string; name: string; bio?: string; avatarUrl?: string };
  // Headline hook kit: typed variants + per-surface assignment. Null/absent when
  // not generated — the site falls back to the title / editor SEO overrides.
  hookVariants?: HookVariantLike[] | null;
  hookAssignments?: HookAssignmentsLike | null;
  // Numbered source list for the trust box; drives in-body [n] citation anchors.
  references?: Array<{ url: string; name: string; domain: string; note?: string | null }>;
  // Editorial metadata; updatedAt is the most recent source insertion or article update.
  editorial?: { updatedAt: string };
}

interface PublicBeat {
  slug: string;
  name: string;
  description: string | null;
  // Optional editor SEO description override; null/absent when unset.
  seoDescription?: string | null;
}

// Summary row shape returned by the public list/feed/homepage endpoints (no
// body). Mirrors `articleSummaryColumns` on the API server.
interface PublicArticleSummary {
  id: string;
  slug: string;
  title: string;
  dek: string;
  category: string;
  categorySlug: string;
  heroImage: string;
  readingTimeMinutes?: number;
  publishedAt: string;
  author: { slug: string; name: string; category?: string; bio?: string };
}

interface HomepageSection {
  beat: PublicBeat;
  items: PublicArticleSummary[];
}

interface HomepageData {
  featured: PublicArticleSummary | null;
  latest: PublicArticleSummary[];
  sections: HomepageSection[];
}

async function getArticle(slug: string, base: string): Promise<PublicArticle | null> {
  const key = `article:${slug}`;
  const cached = getCached<PublicArticle | null>(key);
  if (cached !== undefined) return cached;
  const errCountBefore = fetchErrorCount();
  const data = (await fetchJson(`/api/public/articles/${encodeURIComponent(slug)}`, base)) as
    | PublicArticle
    | null;
  // Cache hits for 60s; authoritative misses (genuine 404) for 20s so a bad slug
  // doesn't hammer the API. Never cache an unreachable-API result, so the next
  // request re-fetches once the API is warm.
  if (fetchErrorCount() === errCountBefore) setCached(key, data, data ? 60_000 : 20_000);
  return data;
}

async function fetchBeats(base: string): Promise<PublicBeat[]> {
  const key = "beats";
  let beats = getCached<PublicBeat[]>(key);
  if (beats === undefined) {
    const errCountBefore = fetchErrorCount();
    const data = (await fetchJson(`/api/public/beats`, base)) as { items?: PublicBeat[] } | null;
    beats = data?.items ?? [];
    // Don't cache an empty list that resulted from an unreachable API.
    if (fetchErrorCount() === errCountBefore) setCached(key, beats, 120_000);
  }
  return beats;
}

async function getBeat(slug: string, base: string): Promise<PublicBeat | null> {
  const beats = await fetchBeats(base);
  return beats.find((b) => b.slug === slug) ?? null;
}

// ---------------------------------------------------------------------------
// Glossary (Concept Explainer) — mirrors src/pages/glossary.tsx and
// src/pages/glossary-detail.tsx so crawlers get per-concept meta + DefinedTerm
// JSON-LD instead of the noindex shell.
// ---------------------------------------------------------------------------

interface ConceptSummary {
  slug: string;
  term: string;
  hoverDefinition: string;
  articleCount: number;
}

interface SourceTrailItem {
  sourceUrl: string;
  sourceType: "wikipedia" | "vault";
  relevanceScore: number;
  title?: string | null;
  author?: string | null;
  publisher?: string | null;
  publishedAt?: string | null;
  verifiedAt?: string | null;
  authorityTier?: string | null;
}

interface ConceptDetail {
  slug: string;
  term: string;
  hoverDefinition: string;
  definition: string;
  wikiUrl?: string | null;
  wikiTitle?: string | null;
  externalUrl?: string | null;
  externalTitle?: string | null;
  realLifeExample?: string | null;
  whatItIsnt?: string | null;
  commonlyMisusedOnline?: string | null;
  moduleType?: "behavioral" | "medical" | "technical" | "general" | null;
  sourceTrail?: SourceTrailItem[];
  shareImage?: string | null;
  cardImageUrl?: string | null;
  relationships?: Array<{ relationType: string; term: string; slug: string }>;
}

// Full live-concept list for the /glossary index prerender (paginated fetch,
// capped at 5,000 terms — matches the articles sitemap ceiling).
async function getConcepts(base: string): Promise<ConceptSummary[] | null> {
  const key = "concepts";
  const cached = getCached<ConceptSummary[] | null>(key);
  if (cached !== undefined) return cached;
  const errCountBefore = fetchErrorCount();
  const PAGE = 200;
  const all: ConceptSummary[] = [];
  let total = Infinity;
  for (let offset = 0; offset < Math.min(total, 5_000); offset += PAGE) {
    const data = (await fetchJson(`/api/public/concepts?limit=${PAGE}&offset=${offset}`, base)) as
      | { concepts?: ConceptSummary[]; total?: number }
      | null;
    if (!data) {
      // First-page failure → no list at all; later-page failure → partial list
      // is still better than nothing for crawlers.
      if (offset === 0) {
        if (fetchErrorCount() === errCountBefore) setCached(key, null, 20_000);
        return null;
      }
      break;
    }
    all.push(...(data.concepts ?? []));
    total = data.total ?? all.length;
    if ((data.concepts ?? []).length < PAGE) break;
  }
  if (fetchErrorCount() === errCountBefore) setCached(key, all, 120_000);
  return all;
}

async function getConcept(slug: string, base: string): Promise<ConceptDetail | null> {
  const key = `concept:${slug}`;
  const cached = getCached<ConceptDetail | null>(key);
  if (cached !== undefined) return cached;
  const errCountBefore = fetchErrorCount();
  const data = (await fetchJson(`/api/public/concepts/${encodeURIComponent(slug)}`, base)) as
    | ConceptDetail
    | null;
  if (fetchErrorCount() === errCountBefore) setCached(key, data, data ? 120_000 : 20_000);
  return data;
}

// Mirrors the useSeo call in src/pages/glossary.tsx.
function glossaryIndexMeta(base: string, concepts: ConceptSummary[] | null): RouteMeta {
  const meta: RouteMeta = {
    title: "Glossary — BrainHook",
    description:
      "Plain-English definitions of scientific, technical, and domain-specific terms used in BrainHook articles.",
    canonicalPath: "/glossary",
    type: "website",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "DefinedTermSet",
      name: "BrainHook Glossary",
      url: `${base}/glossary`,
    },
  };
  if (concepts && concepts.length > 0) {
    meta.rootHtml = renderGlossaryIndexHtml(concepts);
  } else {
    // No live concepts (feature disabled or empty glossary) — don't offer
    // crawlers an empty index page.
    meta.noindex = true;
  }
  return meta;
}

function renderGlossaryIndexHtml(concepts: ConceptSummary[]): string {
  // Group concepts by first letter for crawlers (mirrors client alphabetical view).
  const byLetter = new Map<string, ConceptSummary[]>();
  for (const c of concepts) {
    const letter = c.term.charAt(0).toUpperCase();
    const key = /^[A-Z]$/.test(letter) ? letter : "#";
    if (!byLetter.has(key)) byLetter.set(key, []);
    byLetter.get(key)!.push(c);
  }
  const sortedKeys = [...byLetter.keys()].sort((a, b) => {
    if (a === "#") return 1;
    if (b === "#") return -1;
    return a.localeCompare(b);
  });

  const parts: string[] = [];
  parts.push(`<div class="container mx-auto px-4 py-16 max-w-4xl">`);
  parts.push(`<h1 class="font-serif text-4xl md:text-5xl font-bold mb-4">Glossary</h1>`);
  parts.push(
    `<p class="text-muted-foreground mb-10">Plain-English definitions of scientific, technical, and domain-specific terms used in BrainHook articles.</p>`,
  );
  for (const letter of sortedKeys) {
    const group = byLetter.get(letter)!;
    parts.push(`<section>`);
    parts.push(`<h2 class="text-2xl font-bold mt-10 mb-4">${escHtml(letter)}</h2>`);
    parts.push(`<ul class="space-y-3">`);
    for (const c of group) {
      parts.push(
        `<li><a href="${escAttr(`/glossary/${c.slug}`)}" class="font-semibold hover:text-primary">${escHtml(c.term)}</a>${
          c.hoverDefinition ? ` — <span class="text-muted-foreground">${escHtml(c.hoverDefinition)}</span>` : ""
        }</li>`,
      );
    }
    parts.push(`</ul>`);
    parts.push(`</section>`);
  }
  parts.push(`</div>`);
  return parts.join("");
}

// Mirrors the useSeo call + DefinedTerm JSON-LD in src/pages/glossary-detail.tsx.
function glossaryDetailMeta(concept: ConceptDetail, base: string): RouteMeta {
  return {
    title: `${concept.term} — BrainHook Glossary`,
    description: concept.hoverDefinition || concept.definition.slice(0, 160),
    canonicalPath: `/glossary/${concept.slug}`,
    type: "website",
    // CSS-rendered 4:5 feed card (1200×1470 on its stacked-sheet plate)
    // when captured; RouteMeta falls back to the site default card when
    // absent.
    ...(concept.cardImageUrl
      ? {
          image: `${base}${concept.cardImageUrl}`,
          // card_image_url is the 4:5 feed card (glossary-cards-fb/).
          imageWidth: 1200,
          imageHeight: 1470,
          imageAlt: `${concept.term} — BrainHook Glossary card`,
        }
      : {}),
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "DefinedTerm",
      name: concept.term,
      description: concept.hoverDefinition || concept.definition,
      url: `${base}/glossary/${concept.slug}`,
      sameAs: [
        ...(concept.wikiUrl ? [concept.wikiUrl] : []),
        ...(concept.externalUrl ? [concept.externalUrl] : []),
      ].filter(Boolean),
      inDefinedTermSet: {
        "@type": "DefinedTermSet",
        name: "BrainHook Glossary",
        url: `${base}/glossary`,
      },
    },
    rootHtml: renderGlossaryDetailHtml(concept),
    serializedData: { key: "concept-detail", json: JSON.stringify(concept) },
  };
}

function renderGlossaryDetailHtml(concept: ConceptDetail): string {
  const parts: string[] = [];
  // Dark editorial wrapper matching the client redesign.
  parts.push(`<div class="min-h-screen bg-[#0D0D10] text-[#EEEBE4]">`);
  parts.push(`<div class="max-w-[1280px] mx-auto px-6 md:px-12 pt-8 pb-0">`);
  parts.push(`<p class="mb-8"><a href="/glossary" class="inline-flex items-center gap-1.5 text-sm text-[#9B968C] hover:text-[#F5A84E]">&larr; All terms</a></p>`);
  // Eyebrow label
  parts.push(`<div class="flex items-center gap-3 mb-4"><div class="h-px w-8 bg-[#F5A84E]"></div><span class="text-[#F5A84E] font-bold text-xs tracking-[0.2em] uppercase">BrainHook Glossary</span></div>`);
  // Term heading
  parts.push(`<h1 class="font-serif text-5xl md:text-7xl font-bold leading-[1.05] tracking-tight text-white mb-6">${escHtml(concept.term)}</h1>`);
  // Hover definition with left amber bar
  if (concept.hoverDefinition) {
    parts.push(`<p class="text-xl md:text-2xl text-[#C9C4B9] border-l-2 border-[#F5A84E] pl-5 py-1 mb-8 max-w-3xl leading-relaxed">${escHtml(concept.hoverDefinition)}</p>`);
  }
  parts.push(`</div>`);
  // Hero card — CSS-rendered portrait card shown as static img for SSR crawlers.
  parts.push(`<div class="max-w-[1280px] mx-auto px-6 md:px-12 pb-10">`);
  if (concept.cardImageUrl) {
    parts.push(
      `<div class="max-w-xs mb-6"><img src="${escAttr(concept.cardImageUrl)}" alt="${escAttr(`${concept.term} — BrainHook Glossary card`)}" width="1200" height="1470" class="w-full" loading="eager" /></div>`,
    );
  }
  parts.push(`</div>`);
  parts.push(`<div class="max-w-[1280px] mx-auto px-6 md:px-12 pb-16">`);
  parts.push(`<div class="max-w-3xl">`);
  // hoverDefinition already rendered above; full definition follows
  // "Not to be confused with" — curated distinct_from relationships
  const distinct = (concept.relationships ?? []).filter((r) => r.relationType === "distinct_from");
  if (distinct.length > 0) {
    parts.push(
      `<p class="mb-3 text-sm"><strong class="text-[#F5A84E]">Not to be confused with:</strong> ${distinct
        .map((r) => `<a href="${escAttr(`/glossary/${r.slug}`)}" class="text-[#F5A84E] hover:underline">${escHtml(r.term)}</a>`)
        .join(", ")}</p>`,
    );
  }
  // Other curated relationships — direction-aware labels (mirrors the client).
  const SSR_RELATION_LABELS: Record<string, string> = {
    subtype_of: "A type of",
    parent_of: "Includes",
    antonym: "Opposite of",
    related: "Related to",
    see_also: "See also",
  };
  for (const type of ["subtype_of", "parent_of", "antonym", "related", "see_also"]) {
    const group = (concept.relationships ?? []).filter((r) => r.relationType === type);
    if (group.length === 0) continue;
    parts.push(
      `<p class="mb-2 text-sm text-[#C9C4B9]"><strong class="text-[#EEEBE4]">${escHtml(SSR_RELATION_LABELS[type] ?? type)}:</strong> ${group
        .map((r) => `<a href="${escAttr(`/glossary/${r.slug}`)}" class="text-[#F5A84E] hover:underline">${escHtml(r.term)}</a>`)
        .join(", ")}</p>`,
    );
  }
  for (const para of concept.definition.split(/\n{2,}/)) {
    const trimmed = para.trim();
    if (trimmed) parts.push(`<p class="mb-4">${escHtml(trimmed)}</p>`);
  }
  if (concept.wikiUrl || concept.externalUrl) {
    const url = concept.externalUrl || concept.wikiUrl;
    const label = concept.externalTitle || concept.wikiTitle || "External reference";
    parts.push(
      `<p class="mt-6"><a href="${escAttr(url ?? "#")}" target="_blank" rel="noopener noreferrer nofollow">${escHtml(label)}</a></p>`,
    );
  }
  if (concept.realLifeExample) {
    parts.push(`<div class="mt-6 rounded-xl border border-[#2A2A32] bg-[#17171C] px-5 py-4 relative overflow-hidden"><div class="absolute top-0 left-0 w-1 h-full bg-[#F5A84E]/60"></div>`);
    parts.push(`<h2 class="text-sm font-semibold mb-2 text-[#F5A84E]">What this means in real life</h2>`);
    parts.push(`<p class="text-sm text-[#C9C4B9]">${escHtml(concept.realLifeExample)}</p>`);
    parts.push(`</div>`);
  }
  if (concept.whatItIsnt) {
    parts.push(`<div class="mt-6 rounded-xl border border-[#2A2A32] bg-[#17171C] px-5 py-4">`);
    parts.push(`<h2 class="text-sm font-semibold mb-2 text-[#9B968C]">What it isn’t</h2>`);
    parts.push(`<p class="text-sm text-[#C9C4B9]">${escHtml(concept.whatItIsnt)}</p>`);
    parts.push(`</div>`);
  }
  if (concept.commonlyMisusedOnline) {
    parts.push(`<div class="mt-6 rounded-xl border border-[#2A2A32] bg-[#17171C] px-5 py-4">`);
    parts.push(`<h2 class="text-sm font-semibold mb-2 text-red-400">Commonly misused online</h2>`);
    parts.push(`<p class="text-sm text-[#C9C4B9]">${escHtml(concept.commonlyMisusedOnline)}</p>`);
    parts.push(`</div>`);
  }
  if (concept.sourceTrail && concept.sourceTrail.length > 0) {
    const { count, highlight, lastVerified } = summarizeSourceTrail(concept.sourceTrail);
    parts.push(`<div class="mt-6 rounded-xl border border-[#2A2A32] bg-[#17171C] px-5 py-4">`);
    const verifiedSuffix = lastVerified ? ` Last verified <span class="text-[#9B968C]">${escHtml(lastVerified)}</span>.` : "";
    parts.push(`<p class="text-sm text-[#C9C4B9]">Based on <strong class="text-[#EEEBE4]">${count} reference source${count !== 1 ? "s" : ""}</strong>, including ${escHtml(highlight)}.${verifiedSuffix}</p>`);
    parts.push(`</div>`);
  }
  // Close: max-w-3xl inner, max-w-[1280px] content wrapper, outer bg-[#0D0D10] wrapper
  parts.push(`</div></div></div>`);
  return parts.join("");
}

// Mirrors the client's sourceTrailLabel/summarizeSourceTrail in
// src/pages/glossary-detail.tsx so bot-rendered and hydrated trust boxes stay
// semantically consistent. Keep the two in sync when either changes.
function sourceTrailLabel(s: SourceTrailItem): string {
  let host = "";
  try {
    host = new URL(s.sourceUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    // fall through to tier-based label
  }
  if (s.sourceType === "wikipedia" || host === "wikipedia.org" || host.endsWith(".wikipedia.org")) {
    return "Wikipedia overview";
  }
  if (host === "doi.org" || host.endsWith(".doi.org") || host === "pubmed.ncbi.nlm.nih.gov" || host === "ncbi.nlm.nih.gov") {
    return "Peer-reviewed study";
  }
  if (host === "nih.gov" || host.endsWith(".nih.gov")) return "NIH overview";
  if (host.endsWith(".gov")) return "Government source";
  switch (s.authorityTier) {
    case "primary":
      return "Primary source";
    case "firsthand":
      return "Official statement";
    case "wire":
      return "Wire service report";
    case "reported":
      return "News report";
    case "commentary":
      return "Commentary";
    case "reference":
      return "Reference work";
    default:
      return "Web source";
  }
}

const SOURCE_HIGHLIGHT_PRIORITY: Array<{ label: string; highlight: string }> = [
  { label: "Peer-reviewed study", highlight: "peer-reviewed research" },
  { label: "Government source", highlight: "government sources" },
  { label: "NIH overview", highlight: "NIH material" },
  { label: "Primary source", highlight: "primary sources" },
  { label: "Wire service report", highlight: "wire service reporting" },
  { label: "News report", highlight: "news reporting" },
  { label: "Wikipedia overview", highlight: "Wikipedia" },
];

function summarizeSourceTrail(trail: SourceTrailItem[]): { count: number; highlight: string; lastVerified: string | null } {
  const count = trail.length;
  const labels = new Set(trail.map(sourceTrailLabel));
  const highlight = SOURCE_HIGHLIGHT_PRIORITY.find((p) => labels.has(p.label))?.highlight ?? "reference sources";
  // Real verification date (most recent verifiedAt from the API), never the
  // render date.
  const timestamps = trail
    .map((s) => (s.verifiedAt ? Date.parse(s.verifiedAt) : Number.NaN))
    .filter((t) => Number.isFinite(t));
  const lastVerified = timestamps.length > 0
    ? new Date(Math.max(...timestamps)).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
    : null;
  return { count, highlight, lastVerified };
}

async function getHomepage(base: string): Promise<HomepageData | null> {
  const key = "homepage";
  const cached = getCached<HomepageData | null>(key);
  if (cached !== undefined) return cached;
  const errCountBefore = fetchErrorCount();
  const data = (await fetchJson(`/api/public/homepage`, base)) as HomepageData | null;
  // The live homepage re-rolls its random picks per visit; a short prerender
  // cache is fine — bots don't need fresh randomization and JS clients always
  // re-fetch. Never cache an unreachable-API result so a cold start self-heals
  // on the very next request rather than serving an empty shell for 20s.
  if (fetchErrorCount() === errCountBefore) setCached(key, data, data ? 60_000 : 20_000);
  return data;
}


// All published stories by one author (newest first), for the per-author
// "all articles by" page. Returns null on fetch failure so the route can fall
// back to the plain shell. Capped at 100 (the public list endpoint's max).
async function getAuthorFeed(slug: string, base: string): Promise<PublicArticleSummary[] | null> {
  const key = `authorfeed:${slug}`;
  const cached = getCached<PublicArticleSummary[] | null>(key);
  if (cached !== undefined) return cached;
  const errCountBefore = fetchErrorCount();
  const data = (await fetchJson(
    `/api/public/articles?author=${encodeURIComponent(slug)}&order=recent&limit=100`,
    base,
  )) as { items?: PublicArticleSummary[] } | null;
  const items = data ? (data.items ?? []) : null;
  if (fetchErrorCount() === errCountBefore) setCached(key, items, items ? 60_000 : 20_000);
  return items;
}

// Resolve an author slug to its canonical (current) slug via the API. Returns
// the canonical slug when `slug` is a retired alias of an existing author (so
// the page can 301), or null when `slug` is already canonical / unknown / the
// API was unreachable (caller falls back to rendering the page as-is). Only
// called for the empty-feed case, so it adds no overhead to authors with posts.
async function resolveAuthorSlug(slug: string, base: string): Promise<string | null> {
  const key = `authorresolve:${slug}`;
  const cached = getCached<string | null>(key);
  if (cached !== undefined) return cached;
  const errCountBefore = fetchErrorCount();
  const data = (await fetchJson(
    `/api/public/authors/${encodeURIComponent(slug)}/resolve`,
    base,
  )) as { canonical?: string; redirect?: boolean } | null;
  const canonical =
    data && data.redirect && data.canonical && data.canonical !== slug ? data.canonical : null;
  if (fetchErrorCount() === errCountBefore) setCached(key, canonical, 60_000);
  return canonical;
}

// Fetch a specific page of articles for an author, newest-first. Returns
// SSR_PAGE_SIZE items plus a `hasNext` flag (fetches one extra to detect more).
// Returns null on fetch failure so the caller can fall back to plain shell.
async function getAuthorFeedPage(
  slug: string,
  page: number,
  base: string,
): Promise<{ items: PublicArticleSummary[]; hasNext: boolean } | null> {
  const offset = (page - 1) * SSR_PAGE_SIZE;
  const limit = SSR_PAGE_SIZE + 1;
  const key = `authorfeedpage:${slug}:${page}`;
  const cached = getCached<{ items: PublicArticleSummary[]; hasNext: boolean } | null>(key);
  if (cached !== undefined) return cached;
  const errCountBefore = fetchErrorCount();
  const data = (await fetchJson(
    `/api/public/articles?author=${encodeURIComponent(slug)}&order=recent&offset=${offset}&limit=${limit}`,
    base,
  )) as { items?: PublicArticleSummary[] } | null;
  const allItems = data ? (data.items ?? []) : null;
  if (allItems === null) {
    if (fetchErrorCount() === errCountBefore) setCached(key, null, 20_000);
    return null;
  }
  const hasNext = allItems.length > SSR_PAGE_SIZE;
  const result = { items: allItems.slice(0, SSR_PAGE_SIZE), hasNext };
  if (fetchErrorCount() === errCountBefore) setCached(key, result, 60_000);
  return result;
}

// Fetch a specific page of category articles, newest-first. Same mechanics as
// getAuthorFeedPage but filtered by category slug.
async function getCategoryFeedPage(
  slug: string,
  page: number,
  base: string,
): Promise<{ items: PublicArticleSummary[]; hasNext: boolean } | null> {
  const offset = (page - 1) * SSR_PAGE_SIZE;
  const limit = SSR_PAGE_SIZE + 1;
  const key = `catfeedpage:${slug}:${page}`;
  const cached = getCached<{ items: PublicArticleSummary[]; hasNext: boolean } | null>(key);
  if (cached !== undefined) return cached;
  const errCountBefore = fetchErrorCount();
  const data = (await fetchJson(
    `/api/public/articles?category=${encodeURIComponent(slug)}&order=recent&offset=${offset}&limit=${limit}`,
    base,
  )) as { items?: PublicArticleSummary[] } | null;
  const allItems = data ? (data.items ?? []) : null;
  if (allItems === null) {
    if (fetchErrorCount() === errCountBefore) setCached(key, null, 20_000);
    return null;
  }
  const hasNext = allItems.length > SSR_PAGE_SIZE;
  const result = { items: allItems.slice(0, SSR_PAGE_SIZE), hasNext };
  if (fetchErrorCount() === errCountBefore) setCached(key, result, 60_000);
  return result;
}

// Concept mentions for one article — mirrors the client fetch in
// src/pages/article.tsx (useQuery on /api/public/articles/:slug/concepts).
// The API already enforces both kill-switches (global setting + per-article
// disable) by returning an empty list, so SSR parity is automatic.
type ConceptMention = {
  conceptId: string;
  slug: string;
  term: string;
  hoverDefinition: string;
  surfaceForm: string;
  paragraphIndex: number;
  wikiUrl: string | null;
  // Hidden terms still hover-annotate but must never link to /glossary/:slug
  // (the page 404s and is excluded from the sitemap).
  hidden?: boolean;
};

async function getArticleConcepts(slug: string, base: string): Promise<ConceptMention[]> {
  const key = `articleConcepts:${slug}`;
  const cached = getCached<ConceptMention[]>(key);
  if (cached !== undefined) return cached;
  const errCountBefore = fetchErrorCount();
  const data = (await fetchJson(
    `/api/public/articles/${encodeURIComponent(slug)}/concepts`,
    base,
  )) as { concepts?: ConceptMention[] } | null;
  const mentions = data?.concepts ?? [];
  if (fetchErrorCount() === errCountBefore) setCached(key, mentions, 60_000);
  return mentions;
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExpChars(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * Build a word-boundary–safe, case-insensitive regex for a concept surface form.
 * Uses alphanumeric lookarounds (not `\b`) so terms that end in a non-word char
 * still anchor correctly. Inner whitespace/hyphens are flexible so
 * "vapor-pressure deficit" matches both the hyphenated and spaced variant.
 * Returns null for empty or whitespace-only forms.
 * Kept in sync with buildBoundarySafeConceptRegex in src/pages/article.tsx.
 */
function buildBoundarySafeConceptRegex(surfaceForm: string): RegExp | null {
  const trimmed = surfaceForm.trim();
  if (!trimmed) return null;
  const words = trimmed.split(/[\s-]+/).filter(Boolean);
  if (words.length === 0) return null;
  const pattern = words.map(escapeRegExpChars).join("[\\s-]+");
  return new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, "i");
}

// Ranges that must not be annotated: markdown links, HTML anchors, bold/italic
// markers. Kept identical to computeExclusionZones in src/pages/article.tsx —
// annotating inside these would nest <a> tags (invalid HTML) or corrupt markup.
function computeExclusionZones(raw: string): Array<{ start: number; end: number }> {
  const zones: Array<{ start: number; end: number }> = [];
  const mdLink = /\[([^\]]*)\]\((https?:\/\/[^\s)]+|\/article\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdLink.exec(raw)) !== null) {
    zones.push({ start: m.index, end: m.index + m[0].length });
  }
  const htmlAnchor = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  while ((m = htmlAnchor.exec(raw)) !== null) {
    zones.push({ start: m.index, end: m.index + m[0].length });
  }
  const bold = /\*\*[^\s*](?:[^*]*[^\s*])?\*\*/g;
  while ((m = bold.exec(raw)) !== null) {
    zones.push({ start: m.index, end: m.index + m[0].length });
  }
  const italic = /\*[^\s*](?:[^*]*[^\s*])?\*/g;
  while ((m = italic.exec(raw)) !== null) {
    zones.push({ start: m.index, end: m.index + m[0].length });
  }
  return zones;
}

// SSR twin of renderParagraphWithConcepts in src/pages/article.tsx: wraps the
// FIRST case-insensitive occurrence of each mention's surface form in a real
// /glossary/:slug anchor (followable — crawlers discover glossary pages from
// article prose), skipping hits inside link/emphasis syntax and overlaps.
// Non-hit segments go through renderInlineHtml so citations/emphasis render
// exactly as before.
function renderParagraphWithConceptsHtml(
  raw: string,
  refNumbers: Map<string, number> | undefined,
  concepts: ConceptMention[],
): string {
  if (concepts.length === 0) return renderInlineHtml(raw, refNumbers);

  const excluded = computeExclusionZones(raw);
  const isExcluded = (start: number, end: number): boolean =>
    excluded.some((z) => start < z.end && end > z.start);

  // Use a word-boundary–safe regex (alphanumeric lookarounds) so that a surface
  // form like "peace" doesn't match inside "peacefulness" and "standing" doesn't
  // match inside "outstanding". Kept in sync with the client renderer in
  // src/pages/article.tsx.
  type Hit = { start: number; end: number; concept: ConceptMention };
  const hits: Hit[] = [];
  for (const c of concepts) {
    const re = buildBoundarySafeConceptRegex(c.surfaceForm);
    if (!re) continue;
    const m = re.exec(raw);
    if (!m) continue;
    const idx = m.index;
    const end = idx + m[0].length;
    if (isExcluded(idx, end)) continue;
    if (hits.some((h) => idx < h.end && end > h.start)) continue;
    hits.push({ start: idx, end, concept: c });
  }
  if (hits.length === 0) return renderInlineHtml(raw, refNumbers);
  hits.sort((a, b) => a.start - b.start);

  let out = "";
  let cursor = 0;
  for (const { start, end, concept } of hits) {
    if (start > cursor) out += renderInlineHtml(raw.slice(cursor, start), refNumbers);
    const inner = escHtml(raw.slice(start, end));
    // Hidden terms get the same visual annotation but no crawlable link —
    // their glossary page intentionally 404s.
    out += concept.hidden
      ? `<span class="cursor-help text-foreground font-bold border-b border-dotted border-foreground/70 pb-[1px]" aria-label="${escAttr(`Definition of ${concept.term}`)}">${inner}</span>`
      : `<a href="${escAttr(`/glossary/${concept.slug}`)}" class="cursor-help text-foreground font-bold border-b border-dotted border-foreground/70 pb-[1px] hover:border-foreground transition-colors" aria-label="${escAttr(`Definition of ${concept.term}`)}">${inner}</a>`;
    cursor = end;
  }
  if (cursor < raw.length) out += renderInlineHtml(raw.slice(cursor), refNumbers);
  return out;
}

// Topically-ranked "More like this" rail for crawlers/no-JS readers. Mirrors the
// client by consuming the same /related endpoint (concept-similarity ranking,
// with category/recency only as tiebreakers); the client takes the top 3 for its
// rail, so SSR does too — keeping the crawled link set identical to what users
// see. Returns whatever the endpoint provides (already self-excluded).
async function getRelated(article: PublicArticle, base: string): Promise<PublicArticleSummary[]> {
  const key = `related:${article.slug}`;
  const cached = getCached<PublicArticleSummary[]>(key);
  if (cached !== undefined) return cached;

  const errCountBefore = fetchErrorCount();
  const data = (await fetchJson(
    `/api/public/articles/${encodeURIComponent(article.slug)}/related`,
    base,
  )) as { items?: PublicArticleSummary[] } | null;
  const picks = (data?.items ?? []).filter((a) => a.slug !== article.slug).slice(0, 3);
  if (fetchErrorCount() === errCountBefore) setCached(key, picks, 60_000);
  return picks;
}

// --- Per-route meta builders (mirror the client `useSeo` calls). ---

function homeMeta(): RouteMeta {
  return { title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION, canonicalPath: "/", type: "website" };
}

function aboutMeta(): RouteMeta {
  return {
    title: "About BrainHook — Our Story & How We Work",
    description:
      "How BrainHook began as a personal curiosity engine and grew into a human-directed, AI-assisted publication — and how we research, write, and edit the stories we publish.",
    canonicalPath: "/about",
    type: "website",
  };
}

const STATIC_PAGE_META: Record<string, RouteMeta> = {
  "/contact": {
    title: "Contact Us — BrainHook",
    description:
      "Get in touch with the BrainHook editorial team — for story tips, corrections, press inquiries, advertising, or general feedback.",
    canonicalPath: "/contact",
    type: "website",
  },
  "/privacy": {
    title: "Privacy Policy — BrainHook",
    description:
      "How BrainHook collects, uses, and protects your information — including newsletter data, cookies, and third-party advertising and analytics vendors such as Google AdSense.",
    canonicalPath: "/privacy",
    type: "website",
  },
  "/terms": {
    title: "Terms of Use — BrainHook",
    description:
      "The terms and conditions that govern your use of BrainHook, including acceptable use, intellectual property, disclaimers, and limitations of liability.",
    canonicalPath: "/terms",
    type: "website",
  },
  "/editorial-policy": {
    title: "Editorial Policy & Standards — BrainHook",
    description:
      "How BrainHook produces its research: rigorous editorial review, sourcing standards, and our commitment to accuracy and transparency.",
    canonicalPath: "/editorial-policy",
    type: "website",
  },
  "/corrections": {
    title: "Corrections Policy — BrainHook",
    description:
      "BrainHook is committed to accuracy. Learn how to report an error, how we evaluate correction requests, and how we update published articles transparently.",
    canonicalPath: "/corrections",
    type: "website",
  },
};

// Never emit the raw slug as the page name — Google indexed
// "psychology-behavior — BrainHook" from a window where the beat was absent
// from /public/beats. Title-case the slug words as the fallback.
function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function articleMeta(article: PublicArticle, base: string): RouteMeta {
  const canonical = `${base}/article/${article.slug}`;
  const heroAbs = absoluteImage(article.heroImage, base);
  // Prefer the branded composite share card for social cards (og/twitter); fall
  // back to the raw hero when no composite exists. JSON-LD keeps the raw hero
  // (the literal article photo is the better representative image for Google).
  const shareAbs = absoluteImage(article.shareImage ?? undefined, base) ?? heroAbs;
  const usingComposite = !!article.shareImage;
  // Editor SEO overrides fall back to deterministic derivation when blank.
  // Mirrors the client `useSeo` / JSON-LD wiring in src/pages/article.tsx so
  // dev (Vite) and prod (this server) emit identical title/description tags.
  const seoTitle = resolveSeoTitle(
    article.title,
    article.seoTitle,
    resolveHookText(article.hookVariants, article.hookAssignments, "seoTitle"),
  );
  const socialTitle = resolveSocialTitle(
    article.title,
    resolveHookText(article.hookVariants, article.hookAssignments, "social"),
  );
  const seoDescription =
    resolveSeoDescription(article.dek, article.seoDescription) ?? article.dek;
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: resolveHookText(article.hookVariants, article.hookAssignments, "h1") ?? article.title,
    description: seoDescription,
    image: heroAbs ? [heroAbs] : undefined,
    datePublished: article.publishedAt,
    dateModified: article.editorial?.updatedAt ?? article.publishedAt,
    author: { "@type": "Person", name: article.author.name },
    editor: { "@type": "Person", name: "Damien Lynn" },
    publisher: {
      "@type": "Organization",
      name: SITE_NAME,
      legalName: "Brainhook Media",
      logo: { "@type": "ImageObject", url: `${base}/icon-512.png`, width: 512, height: 512 },
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
    articleSection: article.category,
  };
  return {
    title: seoTitle,
    socialTitle,
    description: seoDescription,
    canonicalPath: `/article/${article.slug}`,
    image: shareAbs,
    // The composite share card is 1200×630; the raw hero is 16:9 (~1600×900).
    // These advisory hints help Discover/social render a large preview without
    // re-fetching the file first.
    imageWidth: shareAbs ? (usingComposite ? 1200 : 1600) : undefined,
    imageHeight: shareAbs ? (usingComposite ? 630 : 900) : undefined,
    imageAlt: shareAbs ? article.title : undefined,
    type: "article",
    jsonLd,
  };
}

// --- Prerendered article body (for crawlers / non-JS clients) --------------
//
// The production server already fetches the full article to build SEO meta, so
// we also render it to static HTML and inject it into #root. This is ADDITIVE:
// on JS-enabled browsers React (createRoot) replaces this markup on mount, so
// the SPA is untouched; bots and no-JS readers get the full text immediately.
// Class names mirror src/pages/article.tsx so the prerendered content is
// visually consistent and the React swap is seamless.

/** Resolve an article image path the same way the client `resolveImage` does. */
function resolveHero(src: string): string {
  if (!src) return "";
  if (/^https?:\/\//i.test(src) || src.startsWith("data:")) return src;
  if (src.startsWith("/")) return src;
  return `/images/${src}`;
}

const ARTICLE_DATE_FMT = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric" });
function formatArticleDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : ARTICLE_DATE_FMT.format(d);
}

// Inline lucide "clock" icon, matching the reading-time glyph the client card
// renders (lucide-react <Clock className="h-3 w-3" />), so the pre-mount paint
// lines up with the hydrated card.
const CLOCK_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clock h-3 w-3"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;

// Render one article "card" to static HTML as a real <a href> link, mirroring
// the non-featured branch of src/components/article/ArticleCard.tsx (same
// classes) so the prerendered paint matches the hydrated card. Adds a visible
// <time> so crawlers and non-JS readers see the published date too.
function renderCardHtml(a: PublicArticleSummary): string {
  const hero = resolveHero(a.heroImage);
  const dateStr = formatArticleDate(a.publishedAt);
  const parts: string[] = [];
  parts.push(`<div class="group flex flex-row gap-4 sm:flex-col sm:gap-0 h-full">`);
  parts.push(
    `<a href="${escAttr(`/article/${a.slug}`)}" class="block shrink-0 w-28 aspect-[4/3] sm:w-auto sm:mb-3 overflow-hidden rounded-lg">`,
  );
  if (hero) {
    parts.push(
      `<img src="${escAttr(hero)}" alt="${escAttr(a.title)}" class="object-cover w-full h-full transition-transform duration-500 group-hover:scale-105" />`,
    );
  }
  parts.push(`</a>`);
  parts.push(`<div class="flex flex-col min-w-0 flex-1">`);
  parts.push(`<div class="flex items-center gap-2 mb-1.5">`);
  parts.push(
    `<a href="${escAttr(`/category/${a.categorySlug}`)}" class="text-[11px] sm:text-xs font-bold uppercase tracking-wider text-primary hover:text-primary/80">${escHtml(a.category)}</a>`,
  );
  parts.push(`</div>`);
  parts.push(
    `<a href="${escAttr(`/article/${a.slug}`)}" class="block group-hover:text-primary transition-colors"><h3 class="font-serif text-base sm:text-lg font-bold leading-snug line-clamp-3 sm:line-clamp-2">${escHtml(toArticleTitleCase(a.title))}</h3></a>`,
  );
  parts.push(
    `<p class="hidden sm:block text-muted-foreground text-sm leading-relaxed mt-2 mb-4 line-clamp-2 flex-grow">${escHtml(a.dek)}</p>`,
  );
  parts.push(
    `<div class="flex items-center justify-between gap-2 mt-1.5 sm:mt-auto sm:pt-3 sm:border-t sm:border-border">`,
  );
  parts.push(
    `<a href="${escAttr(`/author/${a.author.slug}`)}" class="text-xs font-medium truncate hover:text-primary transition-colors">${escHtml(a.author.name)}</a>`,
  );
  const rightBits: string[] = [];
  if (dateStr) {
    rightBits.push(`<time datetime="${escAttr(a.publishedAt)}">${escHtml(dateStr)}</time>`);
  }
  if (a.readingTimeMinutes) {
    rightBits.push(`<span class="flex items-center gap-1">${CLOCK_SVG} ${a.readingTimeMinutes} min</span>`);
  }
  if (rightBits.length > 0) {
    parts.push(
      `<span class="text-muted-foreground text-xs flex items-center gap-2 shrink-0">${rightBits.join("")}</span>`,
    );
  }
  parts.push(`</div>`);
  parts.push(`</div>`);
  parts.push(`</div>`);
  return parts.join("");
}

// Render the home page's featured "lead story" as static HTML, mirroring the
// featured branch of ArticleCard.tsx.
function renderFeaturedCardHtml(a: PublicArticleSummary): string {
  const hero = resolveHero(a.heroImage);
  const parts: string[] = [];
  parts.push(`<div class="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-10 items-center">`);
  parts.push(
    `<a href="${escAttr(`/article/${a.slug}`)}" class="block aspect-[16/9] overflow-hidden rounded-xl">`,
  );
  if (hero) {
    parts.push(
      `<img src="${escAttr(hero)}" alt="${escAttr(a.title)}" class="object-cover w-full h-full transition-transform duration-700 hover:scale-105" />`,
    );
  }
  parts.push(`</a>`);
  parts.push(`<div>`);
  parts.push(
    `<a href="${escAttr(`/category/${a.categorySlug}`)}" class="text-xs font-bold uppercase tracking-widest text-primary hover:text-primary/80">${escHtml(a.category)}</a>`,
  );
  parts.push(
    `<a href="${escAttr(`/article/${a.slug}`)}" class="block mt-2 group"><h1 class="font-serif text-2xl md:text-3xl lg:text-4xl font-bold leading-tight group-hover:text-primary transition-colors">${escHtml(toArticleTitleCase(a.title))}</h1></a>`,
  );
  parts.push(
    `<p class="text-muted-foreground text-base mt-3 leading-relaxed line-clamp-2 md:line-clamp-3">${escHtml(a.dek)}</p>`,
  );
  parts.push(`<div class="flex items-center gap-3 mt-4 text-sm">`);
  parts.push(
    `<a href="${escAttr(`/author/${a.author.slug}`)}" class="font-semibold hover:text-primary transition-colors">${escHtml(a.author.name)}</a>`,
  );
  if (a.readingTimeMinutes) {
    parts.push(`<span class="text-muted-foreground">•</span>`);
    parts.push(
      `<span class="text-muted-foreground flex items-center gap-1">${CLOCK_SVG} ${a.readingTimeMinutes} min</span>`,
    );
  }
  parts.push(`</div>`);
  parts.push(`</div>`);
  parts.push(`</div>`);
  return parts.join("");
}

// Static newsletter block mirroring src/components/article/NewsletterCTA.tsx so
// its headline/copy is visible to crawlers (the live form hydrates over it).
function renderNewsletterHtml(): string {
  return [
    `<div class="bg-primary text-primary-foreground rounded-2xl p-8 md:p-12 lg:p-16 my-16 text-center max-w-4xl mx-auto overflow-hidden relative">`,
    `<div class="relative z-10">`,
    `<h2 class="font-serif text-3xl md:text-4xl font-bold mb-4">Brilliant ideas, delivered weekly.</h2>`,
    `<p class="text-primary-foreground/80 max-w-xl mx-auto mb-8 text-lg">Join thousands of curious minds who receive our top stories, exclusive insights, and editorial updates every Sunday morning. No spam, ever.</p>`,
    `</div>`,
    `</div>`,
  ].join("");
}

// Site-wide header prerender — mirrors the visible chrome of
// src/components/layout/Header.tsx (brand/home link + Glossary nav link +
// Subscribe button). The Subscribe dialog is JS-only; for crawlers/no-JS we
// render a plain anchor to /about so the control still leads somewhere.
// React replaces all of this on mount.
function renderHeaderHtml(): string {
  return [
    `<header class="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur">`,
    `<div class="container mx-auto px-4 h-16 flex items-center justify-between gap-4">`,
    `<a href="/" class="flex items-center gap-2 font-serif text-2xl font-bold tracking-tight text-primary shrink-0">BrainHook</a>`,
    `<nav class="flex items-center gap-4">`,
    `<a href="/glossary" class="text-sm font-medium text-muted-foreground hover:text-primary">Glossary</a>`,
    `<a href="/about" class="inline-flex items-center rounded-full bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold">Subscribe</a>`,
    `</nav>`,
    `</div>`,
    `</header>`,
  ].join("");
}

// Site-wide footer prerender — mirrors src/components/layout/Footer.tsx so
// crawlers/no-JS readers can discover every category and company/policy page
// (the live footer renders these client-side from /api/public/beats, so they
// were absent from the server HTML). React replaces this on mount.
function renderFooterHtml(beats: PublicBeat[]): string {
  const parts: string[] = [];
  parts.push(`<footer class="bg-card text-card-foreground border-t mt-auto">`);
  parts.push(`<div class="container mx-auto px-4 py-12 md:py-16">`);
  parts.push(`<div class="grid grid-cols-1 md:grid-cols-3 gap-12 lg:gap-24">`);

  // Brand + RSS + Company links
  parts.push(`<div class="space-y-6">`);
  parts.push(
    `<div><a href="/" class="font-serif text-2xl font-bold tracking-tight text-primary">BrainHook</a><p class="mt-4 text-muted-foreground text-sm leading-relaxed max-w-sm">Exploring the universe within and without. Real research without the clickbait.</p></div>`,
  );
  parts.push(
    `<div class="flex gap-4"><a href="/rss.xml" rel="noopener noreferrer" class="text-muted-foreground hover:text-primary inline-flex items-center gap-2 text-sm"><span>RSS</span></a></div>`,
  );
  parts.push(`<div><h3 class="font-serif font-semibold text-lg mb-4">Company</h3><ul class="space-y-3">`);
  parts.push(`<li><a href="/glossary" class="text-muted-foreground hover:text-primary text-sm">Glossary</a></li>`);
  parts.push(`<li><a href="/contact" class="text-muted-foreground hover:text-primary text-sm">Contact</a></li>`);
  parts.push(`<li><a href="/about" class="text-muted-foreground hover:text-primary text-sm">About Us</a></li>`);
  parts.push(`<li><a href="/editorial-policy" class="text-muted-foreground hover:text-primary text-sm">Editorial Policy</a></li>`);
  parts.push(
    `<li><a href="/corrections" class="text-muted-foreground hover:text-primary text-sm">Corrections Policy</a></li>`,
  );
  parts.push(`<li><a href="/privacy" class="text-muted-foreground hover:text-primary text-sm">Privacy Policy</a></li>`);
  parts.push(`<li><a href="/terms" class="text-muted-foreground hover:text-primary text-sm">Terms of Use</a></li>`);
  parts.push(`</ul></div></div>`);

  // Categories — the crawlable list of all beats
  parts.push(`<div><h3 class="font-serif font-semibold text-lg mb-4">Categories</h3><ul class="space-y-3">`);
  for (const c of beats) {
    parts.push(
      `<li><a href="${escAttr(`/category/${c.slug}`)}" class="text-muted-foreground hover:text-primary text-sm">${escHtml(c.name)}</a></li>`,
    );
  }
  parts.push(`</ul></div>`);

  // Subscribe blurb (form is JS-only; copy is enough for crawlers)
  parts.push(
    `<div><h3 class="font-serif font-semibold text-lg mb-4">Subscribe</h3><p class="text-muted-foreground text-sm mb-4">Get our best stories delivered to your inbox every week.</p></div>`,
  );

  parts.push(`</div>`);
  parts.push(
    `<div class="mt-16 pt-8 border-t border-border flex flex-col md:flex-row items-center justify-between gap-4 text-xs text-muted-foreground"><p>&copy; ${new Date().getFullYear()} BrainHook Magazine. All rights reserved.</p></div>`,
  );
  parts.push(`</div></footer>`);
  return parts.join("");
}

// Wrap a page's body prerender in the site chrome (header + footer) so every
// crawled route exposes the global nav, all category links, and company/policy
// links — matching the client's PublicLayout (Header → main → Footer).
function renderChrome(bodyHtml: string, beats: PublicBeat[]): string {
  return [
    `<div class="flex min-h-screen flex-col">`,
    renderHeaderHtml(),
    `<main class="flex-1 md:pl-9">`,
    bodyHtml,
    `</main>`,
    renderFooterHtml(beats),
    `</div>`,
  ].join("");
}

// Build the home page #root prerender: featured lead, manifesto band,
// "Latest Stories" rail and the newsletter block — mirroring the layout of
// src/pages/home.tsx (which no longer renders per-category sections).
function renderHomeHtml(data: HomepageData): string {
  const parts: string[] = [];
  parts.push(`<div class="pb-16">`);

  parts.push(`<section class="container mx-auto px-4 py-8 lg:py-12 border-b border-border">`);
  if (data.featured) {
    parts.push(renderFeaturedCardHtml(data.featured));
  } else {
    parts.push(`<p class="text-center text-muted-foreground">No articles yet.</p>`);
  }
  parts.push(`</section>`);

  parts.push(
    `<div class="bg-muted py-12 md:-ml-9 md:w-[calc(100%_+_2.25rem)]"><div class="container mx-auto px-4 text-center max-w-3xl">`,
  );
  parts.push(`<h2 class="font-serif text-2xl font-bold mb-4">Real Research. No BS.</h2>`);
  parts.push(
    `<p class="text-muted-foreground mb-6 text-lg">BrainHook was founded on a simple premise: respect the reader's intellect. We tell stories that illuminate the human experience, the workings of the mind, and the mysteries of the universe.</p>`,
  );
  parts.push(
    `<a href="/about" class="text-primary font-semibold hover:underline decoration-2 underline-offset-4">How BrainHook works &rarr;</a>`,
  );
  parts.push(`</div></div>`);

  if (data.latest.length > 0) {
    parts.push(`<section class="container mx-auto px-4 py-12">`);
    parts.push(
      `<div class="flex items-center gap-4 mb-8"><div class="h-px flex-1 bg-border"></div><div class="shrink-0 text-primary font-serif text-xl font-bold" style="letter-spacing:0.02em">More stories</div><div class="h-px flex-1 bg-border"></div></div>`,
    );
    parts.push(
      `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-px bg-border">`,
    );
    for (const a of data.latest.slice(0, 6)) parts.push(renderCardHtml(a));
    parts.push(`</div></section>`);
  }

  parts.push(`<section class="container mx-auto px-4">`);
  parts.push(renderNewsletterHtml());
  parts.push(`</section>`);

  parts.push(`</div>`);
  return parts.join("");
}

// Build the /about page #root prerender so crawlers and non-JS readers see the
// full About story (the page is static — no API needed). Mirrors the visible
// content of src/pages/about.tsx (hero + story sections + newsletter). The
// framer-motion wrapper is dropped (a plain div); reuse the SAME Tailwind
// classes so the pre-mount paint matches the client render.
function renderAboutHtml(): string {
  const parts: string[] = [];
  parts.push(`<div class="pb-24">`);

  parts.push(
    `<header class="bg-primary text-primary-foreground py-20 md:py-32 md:-ml-9 md:w-[calc(100%_+_2.25rem)]">`,
  );
  parts.push(`<div class="container mx-auto px-4 text-center max-w-4xl relative">`);
  parts.push(
    `<div class="absolute inset-0 opacity-10 pointer-events-none" style="background-image:radial-gradient(circle at 2px 2px, currentColor 1px, transparent 0);background-size:24px 24px;"></div>`,
  );
  parts.push(`<div>`);
  parts.push(
    `<span class="text-sm font-bold uppercase tracking-widest mb-6 block text-primary-foreground/80">About BrainHook</span>`,
  );
  parts.push(
    `<h1 class="font-serif text-5xl md:text-7xl font-bold leading-tight mb-8">Real Research.<br />No BS.</h1>`,
  );
  parts.push(
    `<p class="text-xl md:text-2xl font-body leading-relaxed text-primary-foreground/90">BrainHook was founded on a simple premise: respect the reader's intellect. We tell stories that illuminate the human experience, the workings of the mind, and the mysteries of the universe.</p>`,
  );
  parts.push(`</div></div></header>`);

  parts.push(`<section class="container mx-auto px-4 py-20 max-w-3xl">`);
  parts.push(
    `<div class="prose prose-lg dark:prose-invert prose-primary mx-auto prose-headings:font-serif">`,
  );
  parts.push(
    `<p class="text-2xl leading-relaxed font-serif text-foreground/90 mb-12 text-center">In an era of algorithmic optimization and outrage-driven engagement, truth has too often become a secondary metric. We are building something different.</p>`,
  );

  parts.push(`<h2>What BrainHook is</h2>`);
  parts.push(
    `<p>BrainHook is a magazine for the intellectually curious — a publication that chases the questions worth following: new research, psychological patterns, scientific discoveries, cultural oddities, and the unexpected connections between them. We translate complex ideas into accessible, energetic prose without dumbing them down, and we'd rather leave you thinking than leave you anxious. If a story doesn't teach you something meaningful about the world or yourself, we don't publish it.</p>`,
  );

  parts.push(`<h2>How BrainHook began</h2>`);
  parts.push(
    `<p>BrainHook started as something much smaller: a personal way to keep up with the subjects that fascinated me.</p>`,
  );
  parts.push(
    `<p>I've always been the kind of person who collects questions — passing thoughts, strange connections, new research, cultural shifts, and those moments when two seemingly unrelated ideas suddenly click together. Artificial intelligence gave me a way to explore those questions quickly, follow the threads further, and discover whether a connection was insightful, ridiculous, or somehow both.</p>`,
  );
  parts.push(
    `<p>At first, BrainHook was simply a private experiment. I created distinct subject profiles designed to follow particular fields, search for emerging stories and newly published research, and bring me a fresh spread of ideas each day. It became a kind of personalized curiosity engine: part research assistant, part morning newspaper, and part intellectual rabbit hole.</p>`,
  );
  parts.push(
    `<p>Eventually, I realized there was little reason to keep all of it to myself. The questions I was asking were not uniquely mine. Other people might be curious about the same studies, trends, psychological patterns, scientific discoveries, cultural oddities, and unexpected connections. BrainHook grew from a personal research project into a publication built to make those ideas accessible, engaging, and worth spending time with.</p>`,
  );
  parts.push(
    `<p class="font-serif text-xl text-foreground/90 border-l-4 border-primary pl-6 not-italic">That is still the heart of the project. One interesting question. One unexpected connection. One more hook for the brain.</p>`,
  );

  parts.push(`<h2>Who makes BrainHook</h2>`);
  parts.push(
    `<p>BrainHook combines human curiosity and editorial judgment with AI-assisted research and production tools.</p>`,
  );
  parts.push(
    `<p>Some articles are written directly by members of our editorial team using AI-assisted research. Others are developed collaboratively through our research and writing systems, then reviewed and shaped before publication.</p>`,
  );
  parts.push(
    `<p>Some contributor profiles represent real people publishing under pseudonyms — for privacy, safety, or creative freedom.</p>`,
  );
  parts.push(
    `<p>For a complete explanation of how we use AI, review sources, distinguish reporting from interpretation, and correct mistakes, read our <a href="/editorial-policy">Editorial Policy &amp; AI Disclosure</a>.</p>`,
  );
  parts.push(
    `<p class="font-serif text-xl text-foreground/90 mt-12">— Damien Lynn, Editor</p>`,
  );
  parts.push(`<h2>Masthead &amp; ownership</h2>`);
  parts.push(
    `<ul>` +
      `<li><strong>Editor</strong> — Damien Lynn</li>` +
      `<li><strong>Publisher</strong> — Brainhook Media, Phoenix, Arizona, USA</li>` +
      `<li><strong>Editorial contact</strong> — <a href="mailto:editor@brainhook.net">editor@brainhook.net</a></li>` +
      `<li><strong>Corrections</strong> — <a href="mailto:editor@brainhook.net">editor@brainhook.net</a> (see our <a href="/corrections">Corrections Policy</a>)</li>` +
      `</ul>`,
  );

  parts.push(`</div></section>`);

  parts.push(`<section class="container mx-auto px-4">`);
  parts.push(renderNewsletterHtml());
  parts.push(`</section>`);

  parts.push(`</div>`);
  return parts.join("");
}

// Shared #root prerender shell for the trust/policy pages (Editorial, Corrections,
// Privacy, Terms, Contact). Mirrors src/components/layout/PolicyPage.tsx (hero
// header + prose article) so crawlers/non-JS clients get the full,
// trust-relevant body. `bodyHtml` is trusted, hand-authored markup from the
// shared policy-content module (links/lists/strong), so it is not escaped;
// eyebrow/title/intro/updated are escaped as plain text.
function renderPolicyHtml(
  eyebrow: string,
  title: string,
  intro: string,
  updated: string,
  bodyHtml: string,
): string {
  const parts: string[] = [];
  parts.push(`<div class="pb-24">`);
  parts.push(
    `<header class="bg-primary text-primary-foreground py-16 md:py-24 md:-ml-9 md:w-[calc(100%_+_2.25rem)]">`,
  );
  parts.push(`<div class="container mx-auto px-4 text-center max-w-4xl relative">`);
  parts.push(
    `<div class="absolute inset-0 opacity-10 pointer-events-none" style="background-image:radial-gradient(circle at 2px 2px, currentColor 1px, transparent 0);background-size:24px 24px;"></div>`,
  );
  parts.push(`<div>`);
  parts.push(
    `<span class="text-sm font-bold uppercase tracking-widest mb-6 block text-primary-foreground/80">${escHtml(eyebrow)}</span>`,
  );
  parts.push(
    `<h1 class="font-serif text-4xl md:text-6xl font-bold leading-tight mb-6">${escHtml(title)}</h1>`,
  );
  if (intro) {
    parts.push(
      `<p class="text-lg md:text-xl font-body leading-relaxed text-primary-foreground/90 max-w-2xl mx-auto">${escHtml(intro)}</p>`,
    );
  }
  parts.push(`</div></div></header>`);
  parts.push(`<section class="container mx-auto px-4 py-16 max-w-3xl">`);
  parts.push(
    `<article class="prose prose-lg dark:prose-invert prose-primary mx-auto prose-headings:font-serif">`,
  );
  if (updated) {
    parts.push(`<p class="text-sm text-muted-foreground !mt-0">Last updated: ${escHtml(updated)}</p>`);
  }
  parts.push(bodyHtml);
  parts.push(`</article></section></div>`);
  return parts.join("");
}

// Renders a shared policy doc (src/lib/policyContent.ts — the SINGLE source
// of truth also consumed by the React pages) inside the mirrored policy-page
// shell. Editing copy in that module updates the visible page and this
// crawler prerender together, so the two can never drift apart again.
function renderPolicyDoc(doc: PolicyDoc): string {
  return renderPolicyHtml(doc.eyebrow, doc.title, doc.intro, doc.updated ?? "", doc.bodyHtml);
}

// Maps each meta-only static policy route to its #root body prerender, all
// driven by the shared policy-content module.
const STATIC_PAGE_BODY: Record<string, () => string> = {
  "/contact": () => renderPolicyDoc(CONTACT_PAGE),
  "/editorial-policy": () => renderPolicyDoc(EDITORIAL_POLICY),
  "/corrections": () => renderPolicyDoc(CORRECTIONS_POLICY),
  "/privacy": () => renderPolicyDoc(PRIVACY_POLICY),
  "/terms": () => renderPolicyDoc(TERMS_OF_USE),
};

// Crawlable prev/next pagination links. Only emitted inside the SSR prerender
// so they are visible to bots; the client JS replaces the prerender with its
// own load-more UX on mount.
function renderPaginationHtml(basePath: string, page: number, hasNext: boolean): string {
  if (page === 1 && !hasNext) return "";
  const parts: string[] = [];
  parts.push(
    `<nav class="flex justify-center gap-4 mt-10" aria-label="Pagination">`,
  );
  if (page > 1) {
    const prevHref = page === 2 ? basePath : `${basePath}?page=${page - 1}`;
    parts.push(
      `<a href="${escAttr(prevHref)}" class="inline-flex items-center justify-center rounded-full border border-border bg-background px-8 py-3 text-sm font-medium transition-colors hover:bg-muted">&larr; Newer stories</a>`,
    );
  }
  if (hasNext) {
    parts.push(
      `<a href="${escAttr(`${basePath}?page=${page + 1}`)}" class="inline-flex items-center justify-center rounded-full border border-border bg-background px-8 py-3 text-sm font-medium transition-colors hover:bg-muted">Older stories &rarr;</a>`,
    );
  }
  parts.push(`</nav>`);
  return parts.join("");
}

// Per-author "all articles by" page #root prerender so crawlers/non-JS clients
// see the full list of an author's published work. Mirrors the visible content
// of src/pages/author.tsx (heading + same card grid as the category page).
function renderAuthorHtml(
  slug: string,
  items: PublicArticleSummary[],
  page = 1,
  hasNext = false,
): string {
  const name = items[0]?.author.name ?? slug;
  const bio = items[0]?.author.bio;
  const parts: string[] = [];
  parts.push(`<div class="pb-24">`);
  parts.push(`<header class="relative overflow-hidden bg-muted">`);
  parts.push(`<div class="relative container mx-auto px-4 py-20 md:py-32 flex flex-col items-center text-center gap-4">`);
  parts.push(
    `<p class="text-xs font-bold uppercase tracking-[0.2em] text-white bg-black/50 rounded-full px-4 py-1.5 inline-block">All stories by</p>`,
  );
  parts.push(
    `<h1 class="font-serif text-4xl md:text-5xl lg:text-6xl font-bold text-white bg-black/55 rounded-2xl px-6 md:px-8 py-3 md:py-4 inline-block max-w-full">${escHtml(name)}</h1>`,
  );
  if (bio) {
    parts.push(
      `<p class="text-white bg-black/50 rounded-xl px-4 md:px-6 py-2 md:py-3 max-w-2xl text-base md:text-lg inline-block">${escHtml(bio)}</p>`,
    );
  }
  parts.push(`</div>`);
  parts.push(`</header>`);
  parts.push(`<section class="container mx-auto px-4 py-16">`);
  if (items.length === 0) {
    parts.push(`<p class="text-center text-muted-foreground">No published stories yet.</p>`);
  } else {
    parts.push(
      `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-x-5 gap-y-6 sm:gap-y-10">`,
    );
    for (const a of items) parts.push(renderCardHtml(a));
    parts.push(`</div>`);
    parts.push(renderPaginationHtml(`/author/${slug}`, page, hasNext));
  }
  parts.push(`</section>`);
  parts.push(`</div>`);
  return parts.join("");
}

// Build the category page #root prerender: hero heading, description and the
// article-card list — mirroring the layout of src/pages/category.tsx.
function renderCategoryHtml(
  slug: string,
  beat: PublicBeat | null,
  items: PublicArticleSummary[],
  page = 1,
  hasNext = false,
): string {
  const name = beat?.name ?? slug;
  const description = beat?.description?.trim() ? beat.description : `Stories from our ${name} desk.`;
  const parts: string[] = [];
  parts.push(`<div class="pb-24">`);
  parts.push(`<header class="relative overflow-hidden bg-muted">`);
  parts.push(`<div class="relative container mx-auto px-4 py-20 md:py-32 flex flex-col items-center text-center gap-4">`);
  parts.push(
    `<h1 class="font-serif text-4xl md:text-5xl lg:text-6xl font-bold text-white bg-black/55 rounded-2xl px-6 md:px-8 py-3 md:py-4 inline-block max-w-full">${escHtml(name)}</h1>`,
  );
  parts.push(
    `<p class="text-white bg-black/50 rounded-xl px-4 md:px-6 py-2 md:py-3 max-w-2xl text-base md:text-lg inline-block">${escHtml(description)}</p>`,
  );
  parts.push(`</div>`);
  parts.push(`</header>`);
  parts.push(`<section class="container mx-auto px-4 py-16">`);
  if (items.length === 0) {
    parts.push(`<p class="text-center text-muted-foreground">No stories in this category yet.</p>`);
  } else {
    parts.push(
      `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-x-5 gap-y-6 sm:gap-y-10">`,
    );
    for (const a of items) parts.push(renderCardHtml(a));
    parts.push(`</div>`);
    parts.push(renderPaginationHtml(`/category/${slug}`, page, hasNext));
  }
  parts.push(`</section>`);
  parts.push(`</div>`);
  return parts.join("");
}

function renderArticleHtml(
  article: PublicArticle,
  related: PublicArticleSummary[],
  base: string,
  concepts: ConceptMention[] = [],
): string {
  const parts: string[] = [];
  parts.push(`<article class="pb-24 overflow-x-hidden">`);

  parts.push(`<header class="container mx-auto px-4 pt-16 pb-6 max-w-4xl text-center">`);
  parts.push(
    `<a href="${escAttr(`/category/${article.categorySlug}`)}" class="inline-block text-xs font-bold uppercase tracking-widest text-primary border border-primary/40 rounded-full px-4 py-1.5 mb-6 hover:bg-primary/10 transition-colors">${escHtml(article.category)}</a>`,
  );
  parts.push(
    `<h1 class="font-serif text-4xl md:text-5xl lg:text-6xl font-bold leading-tight mb-6">${escHtml(
      resolveHookText(article.hookVariants, article.hookAssignments, "h1") ?? toArticleTitleCase(article.title),
    )}</h1>`,
  );
  parts.push(
    `<p class="text-xl md:text-2xl text-muted-foreground font-body leading-relaxed mb-8 max-w-3xl mx-auto">${escHtml(article.dek)}</p>`,
  );
  const dateStr = formatArticleDate(article.publishedAt);
  const metaBits: string[] = [
    `<a href="${escAttr(`/author/${article.author.slug}`)}" class="font-semibold hover:text-primary transition-colors">${escHtml(article.author.name)}</a>`,
  ];
  if (dateStr) metaBits.push(`<span class="text-muted-foreground">${escHtml(dateStr)}</span>`);
  if (article.readingTimeMinutes) metaBits.push(`<span class="text-muted-foreground">${article.readingTimeMinutes} min read</span>`);
  parts.push(
    `<div class="flex items-center justify-center gap-4 text-sm mt-8 border-y border-border py-4 flex-wrap">${metaBits.join('<span class="text-muted-foreground">•</span>')}</div>`,
  );
  parts.push(`</header>`);

  const hero = resolveHero(article.heroImage);
  if (hero) {
    parts.push(
      `<div class="container mx-auto px-4 max-w-5xl mb-16"><div class="aspect-[21/9] rounded-xl overflow-hidden shadow-lg relative"><img src="${escAttr(hero)}" alt="${escAttr(article.title)}" class="w-full h-full object-cover" /></div></div>`,
    );
  }

  parts.push(
    `<div class="container mx-auto px-4 max-w-[70ch]"><div class="prose prose-lg dark:prose-invert prose-p:font-body prose-headings:font-serif prose-primary mx-auto w-full max-w-full">`,
  );
  const refNumbers = new Map<string, number>();
  const refs = (article.references ?? []) as Array<{ url: string; name: string; domain: string; note?: string | null }>;
  refs.forEach((ref, i) => refNumbers.set(normalizeCitationUrl(ref.url), i + 1));
  const body = article.body ?? [];
  for (let blockIndex = 0; blockIndex < body.length; blockIndex++) {
    const block = body[blockIndex]!;
    switch (block.type) {
      case "paragraph":
        // Concept annotations: mirror the client, which filters mentions by
        // body-block index (paragraphIndex === index across ALL blocks).
        parts.push(
          `<p>${renderParagraphWithConceptsHtml(
            block.content ?? "",
            refNumbers,
            concepts.filter((c) => c.paragraphIndex === blockIndex),
          )}</p>`,
        );
        break;
      case "heading":
        parts.push(
          `<h2 class="!font-serif !font-bold !text-3xl md:!text-4xl !mt-16 !mb-6 !pt-6 !border-t-2 !border-primary/30 !leading-tight">${escHtml(block.content ?? "")}</h2>`,
        );
        break;
      case "pullquote":
        parts.push(
          `<blockquote class="font-serif italic text-2xl md:text-3xl text-primary my-10 border-l-4 border-primary pl-6">&ldquo;${escHtml(block.content ?? "")}&rdquo;</blockquote>`,
        );
        break;
      case "image":
        parts.push(
          `<figure class="my-10"><img src="${escAttr(resolveHero(block.content ?? ""))}" alt="Article visual" class="rounded-lg shadow-md w-full" /></figure>`,
        );
        break;
      case "relatedArticle":
        // Manual related blocks reference another article by slug. We don't have
        // that article's title here, but emitting a followable internal link is
        // still useful for crawlers.
        parts.push(`<p><a href="${escAttr(`${base}/article/${block.content}`)}">Suggested article</a></p>`);
        break;
      case "takeaways": {
        const itemsHtml = (block.items ?? [])
          .map((item: string) => `<li>${escHtml(item)}</li>`)
          .join("");
        parts.push(
          `<div class="not-prose my-8 rounded-xl border border-emerald-200 bg-emerald-50 px-6 py-5"><p class="text-xs font-bold uppercase tracking-widest text-emerald-700 mb-3">What you can do</p><ul class="space-y-2 list-none p-0">${itemsHtml}</ul></div>`,
        );
        break;
      }
      default:
        break;
    }
  }
  // Numbered references list so in-body [n] citation anchors resolve in the
  // prerendered HTML too (mirrors the client's EditorialTrustBox).
  if (refs.length > 0) {
    parts.push(`<h2>References</h2><ol>`);
    refs.forEach((ref, i) => {
      const note = (ref.note ?? "").trim();
      parts.push(
        `<li id="ref-${i + 1}"><a href="${escAttr(ref.url)}" target="_blank" rel="noopener noreferrer nofollow">${escHtml(ref.name)}</a> <span>(${escHtml(ref.domain)})</span>${note ? `<br><em>${escHtml(note)}</em>` : ""}</li>`,
      );
    });
    parts.push(`</ol>`);
  }
  parts.push(`</div>`);

  if (article.author.bio) {
    parts.push(
      `<div class="mt-16 pt-8 border-t border-border"><h4 class="font-bold text-lg mb-1">About ${escHtml(article.author.name)}</h4><p class="text-muted-foreground">${escHtml(article.author.bio)}</p></div>`,
    );
  }
  parts.push(`</div>`);

  // Bottom "More like this" rail — real /article/<slug> anchors so crawlers
  // discover related stories (mirrors the section in src/pages/article.tsx).
  if (related.length > 0) {
    parts.push(
      `<section class="container mx-auto px-4 mt-16 max-w-6xl border-t border-border pt-16">`,
    );
    parts.push(`<h3 class="font-serif text-3xl font-bold mb-10 text-center">More like this</h3>`);
    parts.push(`<div class="grid grid-cols-1 md:grid-cols-3 gap-8">`);
    for (const r of related) parts.push(renderCardHtml(r));
    parts.push(`</div>`);
    parts.push(`</section>`);
  }

  parts.push(`</article>`);
  return parts.join("");
}

function unsubscribeMeta(): RouteMeta {
  return {
    title: "Unsubscribe — BrainHook",
    description: "Manage your BrainHook newsletter subscription.",
    canonicalPath: "/unsubscribe",
    type: "website",
    noindex: true,
  };
}

// Internal search is a utility page: noindex (mirrors the client useSeo call in
// src/pages/search.tsx), and the canonical is always the clean /search path so
// ?q= variations never look like distinct indexable URLs.
function searchMeta(): RouteMeta {
  return {
    title: "Search — BrainHook",
    description: "Search BrainHook for real research with no BS.",
    canonicalPath: "/search",
    type: "website",
    noindex: true,
  };
}

async function resolveMeta(pathname: string, page: number, base: string): Promise<RouteMeta | null> {
  if (pathname === "/") {
    const meta = homeMeta();
    // Additive prerender: bots/non-JS get the full home layout; on failure we
    // fall back to the plain shell (meta still correct).
    const data = await getHomepage(base);
    if (data) {
      meta.rootHtml = renderHomeHtml(data);
      // Serialize the SSR data so the client hydrates from the same random
      // picks, avoiding a flash: skeleton replaces SSR article, then new
      // random article replaces skeleton. The client reads this on mount.
      meta.serializedData = {
        key: "homepage",
        json: JSON.stringify(data),
      };
    }
    return meta;
  }
  if ((pathname.replace(/\/$/, "") || "/") === "/about") {
    const meta = aboutMeta();
    meta.rootHtml = renderAboutHtml();
    return meta;
  }
  if ((pathname.replace(/\/$/, "") || "/") === "/unsubscribe") return unsubscribeMeta();
  if ((pathname.replace(/\/$/, "") || "/") === "/search") return searchMeta();
  if ((pathname.replace(/\/$/, "") || "/") === "/glossary") {
    // Glossary index: indexable meta + prerendered term list so crawlers can
    // discover every /glossary/:slug page from real anchors.
    const concepts = await getConcepts(base);
    return glossaryIndexMeta(base, concepts);
  }
  if (pathname.startsWith("/glossary/")) {
    const slug = decodeURIComponent(pathname.slice("/glossary/".length).replace(/\/$/, ""));
    if (!slug) return null;
    // Unknown/non-live concepts return null → NOINDEX_SHELL, so thin or
    // unpublished entries never enter the index.
    const concept = await getConcept(slug, base);
    if (!concept) return null;
    return glossaryDetailMeta(concept, base);
  }
  const staticKey = pathname.replace(/\/$/, "") || "/";
  const staticMeta = STATIC_PAGE_META[staticKey];
  if (staticMeta) {
    // Additive prerender: the trust/policy pages (editorial, corrections,
    // privacy, terms) get their full body so non-JS crawlers see the content,
    // not an empty shell. Others keep meta-only.
    const renderBody = STATIC_PAGE_BODY[staticKey];
    return renderBody ? { ...staticMeta, rootHtml: renderBody() } : staticMeta;
  }
  if (pathname.startsWith("/article/")) {
    const slug = decodeURIComponent(pathname.slice("/article/".length).replace(/\/$/, ""));
    if (!slug) return null;
    const article = await getArticle(slug, base);
    if (!article) return null;
    const meta = articleMeta(article, base);
    const [related, concepts] = await Promise.all([
      getRelated(article, base),
      getArticleConcepts(slug, base),
    ]);
    meta.rootHtml = renderArticleHtml(article, related, base, concepts);
    // Inject DefinedTerm structured data for each unique concept so Google can
    // index the definitions and surface them as rich results. One block per
    // concept (deduplicated by conceptId — the same concept can appear in
    // multiple paragraphs). Zero concepts = no blocks, no change to existing
    // output.
    if (concepts.length > 0) {
      const seen = new Set<string>();
      const graph: Record<string, unknown>[] = [];
      if (meta.jsonLd) {
        graph.push(meta.jsonLd);
      }
      for (const c of concepts) {
        if (seen.has(c.conceptId)) continue;
        seen.add(c.conceptId);
        const termBlock: Record<string, unknown> = {
          "@context": "https://schema.org",
          "@type": "DefinedTerm",
          name: c.term,
          description: c.hoverDefinition,
          url: `${base}/glossary/${c.slug}`,
          inDefinedTermSet: {
            "@type": "DefinedTermSet",
            name: "BrainHook Glossary",
            url: `${base}/glossary`,
          },
        };
        if (c.wikiUrl) termBlock.sameAs = c.wikiUrl;
        graph.push(termBlock);
      }
      meta.jsonLd = {
        "@context": "https://schema.org",
        "@graph": graph,
      };
    }
    return meta;
  }
  if (pathname.startsWith("/category/")) {
    const slug = decodeURIComponent(pathname.slice("/category/".length).replace(/\/$/, ""));
    if (!slug) return null;
    const beat = await getBeat(slug, base);
    const beatName = beat?.name ?? humanizeSlug(slug);
    const description =
      resolveSeoDescription(beat?.description, beat?.seoDescription) ??
      `Stories from our ${beatName} desk on BrainHook.`;
    // Use newest-first paginated fetch for SSR. The client fetches the same
    // endpoint with the same order=recent parameter, so SSR and JS content match.
    const pageData = await getCategoryFeedPage(slug, page, base);
    const items = pageData?.items ?? null;
    const hasNext = pageData?.hasNext ?? false;
    const canonicalPath = page > 1 ? `/category/${slug}?page=${page}` : `/category/${slug}`;
    const meta: RouteMeta = {
      title: `${beatName} — BrainHook`,
      description,
      canonicalPath,
      type: "website",
    };
    // An empty page 1 means the category has no published stories: noindex it
    // (and the sitemap already excludes it). Data-driven — flips back to
    // indexable the moment the first article publishes. Only when the fetch
    // SUCCEEDED with zero items so a transient API blip never stamps noindex.
    if (items !== null && items.length === 0) {
      meta.noindex = true;
      if (page > 1) return null; // Beyond last page
    }
    if (items && items.length > 0) {
      meta.jsonLd = buildCategoryJsonLd(slug, beatName, description, items, base);
      meta.rootHtml = renderCategoryHtml(slug, beat, items, page, hasNext);
    } else if (items !== null) {
      meta.rootHtml = renderCategoryHtml(slug, beat, [], page, false);
    }
    return meta;
  }
  if (pathname.startsWith("/author/")) {
    const slug = decodeURIComponent(pathname.slice("/author/".length).replace(/\/$/, ""));
    if (!slug) return null;
    // Fetch the specific archive page (newest-first). Requests SSR_PAGE_SIZE+1
    // items so we can detect whether a next page exists without an extra call.
    const pageData = await getAuthorFeedPage(slug, page, base);
    if (pageData !== null && pageData.items.length === 0) {
      if (page === 1) {
        // Empty page 1: may be a retired slug. Ask the API for the canonical
        // and 301 if so; otherwise return null → NOINDEX_SHELL. This prevents
        // unknown/empty author URLs from entering the index.
        const canonical = await resolveAuthorSlug(slug, base);
        if (canonical) {
          const target = `/author/${canonical}`;
          return { title: "Redirecting…", canonicalPath: target, type: "website", redirectTo: target };
        }
        // No published articles, no canonical redirect: noindex (null → NOINDEX_SHELL).
        return null;
      }
      // page > 1 with no content: not a real page.
      return null;
    }
    const items = pageData?.items ?? null;
    const hasNext = pageData?.hasNext ?? false;
    const authorName = items?.[0]?.author.name ?? slug;
    const authorBio = items?.[0]?.author.bio;
    const canonicalPath = page > 1 ? `/author/${slug}?page=${page}` : `/author/${slug}`;
    const meta: RouteMeta = {
      title: `${authorName} — BrainHook`,
      description: `All stories by ${authorName} on BrainHook.`,
      canonicalPath,
      type: "website",
      jsonLd: items ? buildAuthorJsonLd(slug, authorName, authorBio, base) : null,
    };
    if (items) meta.rootHtml = renderAuthorHtml(slug, items, page, hasNext);
    return meta;
  }
  return null;
}

// Content-Security-Policy tuned to BrainHook's real third-party surface:
// Google AdSense, GA4/Google Tag Manager, Google Fonts, the same-origin image
// transform route, and admin Unsplash defaults. Built from per-directive lists
// for readability. The inline allowances ('unsafe-inline'/'unsafe-eval', blob:)
// are required because the site uses the inline AdSense loader, per-page JSON-LD
// `<script type="application/ld+json">` blocks, inline Tailwind/Radix styles,
// and AdSense's eval/blob-worker usage. Images are not a script-injection
// vector, so img-src enumerates the Google ad/analytics pixel domains it needs.
const GOOGLE_ADS_SCRIPT = [
  "https://pagead2.googlesyndication.com",
  "https://*.googlesyndication.com",
  "https://partner.googleadservices.com",
  "https://www.googleadservices.com",
  "https://googleads.g.doubleclick.net",
  "https://*.g.doubleclick.net",
  "https://adservice.google.com",
  // Ad-traffic-quality ("sodar") endpoints the AdSense code calls for
  // invalid-traffic / spam checks. Blocking these degrades or denies ad
  // serving and hurts IVT standing.
  "https://ep1.adtrafficquality.google",
  "https://ep2.adtrafficquality.google",
  "https://*.adtrafficquality.google",
  // Google's certified consent message (AdSense → Privacy & messaging) is
  // delivered through Funding Choices; required for the EEA/UK/CH CMP.
  "https://fundingchoicesmessages.google.com",
];
const GOOGLE_ANALYTICS_SCRIPT = [
  "https://www.googletagmanager.com",
  "https://www.google-analytics.com",
  "https://*.google-analytics.com",
];
const CSP_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'self'"],
  "base-uri": ["'self'"],
  "object-src": ["'none'"],
  "frame-ancestors": ["'self'"],
  "script-src": [
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    "blob:",
    ...GOOGLE_ADS_SCRIPT,
    ...GOOGLE_ANALYTICS_SCRIPT,
  ],
  "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
  "img-src": [
    "'self'",
    "data:",
    "https://*.googlesyndication.com",
    "https://*.g.doubleclick.net",
    "https://*.doubleclick.net",
    "https://*.google-analytics.com",
    "https://www.googletagmanager.com",
    "https://*.gstatic.com",
    "https://*.google.com",
    "https://*.adtrafficquality.google",
    "https://fundingchoicesmessages.google.com",
    "https://images.unsplash.com",
  ],
  "frame-src": [
    "https://googleads.g.doubleclick.net",
    "https://*.googlesyndication.com",
    "https://tpc.googlesyndication.com",
    "https://www.google.com",
    "https://*.adtrafficquality.google",
    "https://fundingchoicesmessages.google.com",
  ],
  "child-src": [
    "'self'",
    "blob:",
    "https://googleads.g.doubleclick.net",
    "https://*.googlesyndication.com",
    "https://tpc.googlesyndication.com",
    "https://www.google.com",
    "https://*.adtrafficquality.google",
    "https://fundingchoicesmessages.google.com",
  ],
  "worker-src": ["'self'", "blob:"],
  "connect-src": [
    "'self'",
    "https://www.google-analytics.com",
    "https://*.google-analytics.com",
    "https://analytics.google.com",
    "https://*.analytics.google.com",
    "https://region1.google-analytics.com",
    "https://www.googletagmanager.com",
    "https://www.google.com",
    ...GOOGLE_ADS_SCRIPT,
  ],
};
const CONTENT_SECURITY_POLICY = Object.entries(CSP_DIRECTIVES)
  .map(([directive, values]) => `${directive} ${values.join(" ")}`)
  .join("; ");

// Conservative Permissions-Policy: lock down sensitive device features the site
// never uses, while deliberately NOT disabling `browsing-topics` /
// `attribution-reporting` (AdSense relies on those Privacy Sandbox features).
const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
].join(", ");

const app = express();
app.disable("x-powered-by");

// Security headers on every response (HTML shell, prerendered routes, and
// static assets). HSTS is intentionally omitted: the Replit deploy proxy
// terminates TLS and owns the edge, so setting Strict-Transport-Security here
// has no reliable effect and risks pinning the wrong host — leave it to the
// platform.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", PERMISSIONS_POLICY);
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  next();
});

// Canonical-host enforcement: 301-redirect any `www.` host to its apex so the
// site only ever serves one preferred hostname. This is a no-op until `www` is
// actually connected at the DNS/deployment level, and it deliberately only
// touches `www.` hosts so internal health checks and the `.replit.app` host are
// left alone.
app.use((req, res, next) => {
  const rawHost = ((req.headers["x-forwarded-host"] as string | undefined) || req.headers.host || "")
    .split(",")[0]!
    .trim();
  if (rawHost.toLowerCase().startsWith("www.")) {
    const apex = rawHost.slice(4);
    res.redirect(301, `https://${apex}${req.originalUrl}`);
    return;
  }
  next();
});

app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html")) {
        // HTML files: always revalidate.
        res.setHeader("Cache-Control", "no-cache");
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        // Content-hashed JS/CSS/images under /assets/: safe to cache forever.
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        // Stable-name but potentially updated files (llms.txt, manifests, icons,
        // OG images, favicons): revalidate hourly so updates propagate within an
        // hour rather than being stuck in intermediary caches for a year.
        res.setHeader("Cache-Control", "public, max-age=3600, must-revalidate");
      }
    },
  }),
);

app.get(/.*/, async (req, res) => {
  // Run the whole request inside a context so any unreachable-API fetch flips a
  // per-request "degraded" flag. A degraded response (empty/partial prerender
  // from a cold start before the API was listening) must NOT be cached.
  await requestContext.run({ errorCount: 0 }, async () => {
    const pathname = req.path;
    const base = getBaseUrl(req);
    // Parse `?page=N` for archive pagination. Clamp to ≥ 1; ignore non-numeric.
    const rawPage = req.query["page"];
    // Clamp to [1, MAX_PAGE] to prevent absurd DB offsets and unbounded cache keys.
    const page = Math.min(MAX_PAGE, Math.max(1, parseInt(String(rawPage ?? "1"), 10) || 1));
    let meta: RouteMeta | null = null;
    try {
      meta = await resolveMeta(pathname, page, base);
    } catch (err) {
      log("error", "meta resolution failed", { pathname, error: err instanceof Error ? err.message : String(err) });
    }

    // Permanent redirect (e.g. a retired author slug → its current slug). Emit a
    // 301 before any HTML rendering so crawlers fold the old URL into the new one.
    if (meta?.redirectTo) {
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.redirect(301, `${base}${meta.redirectTo}`);
      return;
    }

    res.type("html");
    if (!meta) {
      // Unknown route (admin, 404, etc.) — serve the shell, but with a noindex
      // robots tag: these are utility/low-value URLs that must never enter the
      // index. Exception: if the API was unreachable (so a REAL article/feed may
      // have merely looked like a 404), keep the shell's indexable default and
      // don't cache, so a transient blip never stamps noindex onto a live page.
      // Admin paths are always noindex regardless — they never depend on the API.
      const isAdminPath = pathname === "/admin" || pathname.startsWith("/admin/");
      if (hadFetchError() && !isAdminPath) {
        // API was unreachable: return 503 + Retry-After so crawlers retry
        // without changing the page's indexed status. Never cache — the outage
        // is transient and the real content should serve on the next crawl.
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Retry-After", "30");
        res.status(503).send(NOINDEX_SHELL);
        return;
      }
      // Genuine unknown public route (API reachable, not admin) → 404.
      // Admin paths stay 200 (utility routes, never indexed by design).
      res.setHeader("Cache-Control", "public, max-age=60");
      if (!isAdminPath) res.status(404);
      res.send(NOINDEX_SHELL);
      return;
    }
    let html = STRIPPED_SHELL.replace("</head>", `${buildHeadBlock(meta, base)}\n  </head>`);
    // Additive prerender: drop the page body — wrapped in the site chrome (global
    // header + footer with every category and company/policy link) — into #root so
    // crawlers/non-JS clients can see the navigation and discover the whole site.
    // React (createRoot) replaces it on mount for JS-enabled browsers. We render
    // chrome for every resolved public route, even ones without a body prerender
    // (e.g. policy pages), so the nav/footer are present site-wide.
    let beats: PublicBeat[] = [];
    try {
      beats = await fetchBeats(base);
    } catch (err) {
      log("error", "beats fetch for chrome failed", { pathname, error: err instanceof Error ? err.message : String(err) });
    }
    const rootHtml = renderChrome(meta.rootHtml ?? "", beats);
    html = html.replace('<div id="root"></div>', `<div id="root">${rootHtml}</div>`);
    // Degraded prerender (API unreachable → empty/partial #root): serve once but
    // never cache it, so the next crawl re-renders with full content once warm.
    res.setHeader("Cache-Control", hadFetchError() ? "no-store" : "public, max-age=60");
    res.send(html);
  });
});

app.listen(PORT, "0.0.0.0", () => {
  log("info", "site server started", { port: PORT, apiOrigin: API_ORIGIN });
});
