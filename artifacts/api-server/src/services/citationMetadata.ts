import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db, articleSourcesTable } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  safeFetchBytes,
  extractFromDocumentBytes,
  UnsafeUrlError,
  FetchError,
} from "./sourceFetch";
import { detectDocumentType } from "./documentExtract";
import { acquireJobLock, heartbeatJob, finishJob, isCancelRequested, getJobState, requestJobCancel, forceReleaseJob } from "./jobState";

// --- Citation metadata (true bibliographic references) --------------------
// The public References list must read like a real bibliography: the source's
// ACTUAL title with author/organization, publisher and date — never the
// in-body anchor text. This module resolves that metadata for article_sources
// rows and snapshots it onto the row (source_title, source_authors,
// publisher_name, source_published_at, canonical_url, doi, accessed_at), so a
// later publisher-side page edit can't silently rewrite our citations.
//
// Extraction order (per editorial spec):
//   1. Source Vault document metadata (already-ingested title/author/date)
//   2. JSON-LD (headline/name, author, publisher.name, datePublished)
//   3. Academic citation_* meta tags (title/author/journal/doi/date)
//   4. Open Graph (og:title, og:site_name, article:published_time)
//   5. Cleaned HTML <title>
//   6. (manual override = an admin-set source_title, which is never clobbered)
//   7. Only then: domain/URL fallback at render time.
// Anchor text is NEVER used.

export interface CitationMeta {
  title: string | null;
  authors: string | null;
  publisher: string | null;
  publishedAt: Date | null;
  canonicalUrl: string | null;
  doi: string | null;
}

const EMPTY_META: CitationMeta = {
  title: null,
  authors: null,
  publisher: null,
  publishedAt: null,
  canonicalUrl: null,
  doi: null,
};

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.replace(/\s+/g, " ").trim();
  return t.length > 0 ? t.slice(0, 500) : null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Strip trailing " | Site Name" / " - Site Name" breadcrumb segments from an
// HTML <title>. Uses a GREEDY prefix so each pass peels the rightmost segment;
// repeat up to 3 times so "Title | Journal | Publisher" becomes just "Title".
// Requires ≥12 chars left after stripping and only strips 2-80 char suffixes
// that themselves contain no separator characters (so internal separators in
// the title body are safe).
function cleanHtmlTitle(raw: string | null): string | null {
  const t = cleanText(raw);
  if (!t) return null;
  let s = t;
  for (let i = 0; i < 3; i++) {
    const m = s.match(/^(.{12,})\s+[|·–—-]\s+[^|·–—-]{2,80}$/);
    if (!m) break;
    s = m[1]!.trim();
  }
  // Final pass: strip trailing junk slug tokens (internal IDs, hex fragments,
  // URL slug identifiers) that intermediary aggregators append to paper titles.
  // Example: "Paradoxical Effects Of Thought Suppression 1dfwms5euz" (SciSpace).
  s = stripTrailingJunkToken(s);
  return s.length >= 4 ? s : t;
}

// Vowel set used by isJunkSlugToken.
const VOWELS = new Set("aeiou");

/**
 * True when a token looks like an internal ID / URL slug fragment rather than
 * a real word: all lowercase alphanumeric, 6–14 chars, with very few vowels
 * among the alphabetic characters (vowel ratio < 0.35). This catches the
 * SciSpace identifier pattern ("1dfwms5euz"), pure hex strings, and plain
 * numeric IDs while leaving short but real words untouched.
 */
function isJunkSlugToken(token: string): boolean {
  if (!/^[a-z0-9]{6,14}$/.test(token)) return false;
  const alpha = token.replace(/[0-9]/g, "");
  if (alpha.length === 0) return true; // pure digits
  const vowelCount = [...alpha].filter((c) => VOWELS.has(c)).length;
  return vowelCount / alpha.length < 0.35;
}

/**
 * Strip a trailing junk slug token (internal ID, hex fragment, URL slug
 * identifier) from a citation title. Only strips when the final whitespace-
 * separated token passes the junk-slug heuristic AND at least 12 chars of
 * semantic title would remain.
 *
 * Handles the observed SciSpace case:
 *   "Paradoxical Effects Of Thought Suppression 1dfwms5euz"
 *   → "Paradoxical Effects Of Thought Suppression"
 */
export function stripTrailingJunkToken(title: string): string {
  const m = title.match(/^(.{12,}?)\s+([a-z0-9]{6,14})$/);
  if (!m) return title;
  const prefix = m[1]!;
  const token = m[2]!;
  if (!isJunkSlugToken(token)) return title;
  return prefix.trim();
}

// --- Junk-title guard --------------------------------------------------------
// Bot walls, error pages and login gates serve HTML whose <title>/og:title is
// interstitial chrome, not the document's name ("Checking your browser",
// "Just a moment…", "Access Denied"). A citation must never show these, so this
// guard runs at extraction time AND at render time (defense in depth).

// Phrases that mark a title as junk wherever they appear at the start.
const JUNK_TITLE_PREFIX_RE =
  /^\W*(just a moment|checking your browser|checking the site|checking if the site|verify(ing)? (you('| a)?re|that you)|are you a robot|robot check|human verification|bot verification|browser (check|verification)|attention required|access denied|access restricted|access to this page|security check(point)?|captcha|cloudflare|ddos|radware|bot manager|please enable (javascript|cookies)|javascript is (disabled|required|not available)|enable javascript|unsupported browser|your browser is (out of date|not supported|unsupported|blocking)|page not found|redirect notice|redirecting|one moment|please wait|request rejected|request blocked|rate limit exceeded)/i;

// Titles that are junk only when they are (almost) the WHOLE title — these
// words legitimately start real titles ("Error Correction in Quantum…").
const JUNK_TITLE_EXACT = new Set([
  "error",
  "errors",
  "403",
  "404",
  "403 forbidden",
  "404 not found",
  "forbidden",
  "not found",
  "denied",
  "unauthorized",
  "sign in",
  "sign-in",
  "log in",
  "login",
  "log-in",
  "untitled",
  "untitled document",
  "loading",
  "loading…",
  "loading...",
  "home",
  "homepage",
  "subscribe",
  "subscribe to read",
  "new page",
  "default page",
  "site maintenance",
  "maintenance",
  "service unavailable",
  "too many requests",
  "bad gateway",
]);

/**
 * Last-resort readable title derived from a URL's path slug — for bot-walled
 * pages (justice.gov press releases, esa.int, war.gov) whose slug IS the
 * publisher's own headline. Returns null unless the slug looks like real
 * prose: ≥4 hyphen/underscore-separated words, mostly alphabetic.
 */
export function titleFromUrlSlug(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const segments = u.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(last);
  } catch {
    return null;
  }
  slug = slug.replace(/\.(html?|php|aspx?|pdf)$/i, "");
  const words = slug.split(/[-_]+/).filter(Boolean);
  if (words.length < 3) return null;
  const alphaWords = words.filter((w) => /^[a-z][a-z0-9']*$/i.test(w));
  if (alphaWords.length / words.length < 0.8) return null;
  const title = words
    .map((w) => (/^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
  // Sanity cap: a headline, not a dumping ground for tracking-token slugs.
  if (title.length > 160) return null;
  return title;
}

/**
 * True when a would-be citation title is interstitial/error chrome rather than
 * the source's actual name. `domain` (optional) also rejects titles that are
 * just the site's domain restated.
 */
export function isJunkCitationTitle(title: string | null | undefined, domain?: string | null): boolean {
  if (!title) return true;
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length < 4) return true;
  if (JUNK_TITLE_PREFIX_RE.test(t)) return true;
  const bare = t.toLowerCase().replace(/[\s.!…|·–—-]+$/g, "");
  if (JUNK_TITLE_EXACT.has(bare)) return true;
  if (domain) {
    const d = domain.toLowerCase();
    if (bare === d || bare === `www.${d}` || bare === d.replace(/^www\./, "")) return true;
  }
  return false;
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function extractDoi(candidate: string | null): string | null {
  if (!candidate) return null;
  const m = candidate.match(/10\.\d{4,9}\/[^\s"'<>]+/);
  return m ? m[0].replace(/[.,;)\]]+$/, "") : null;
}

// Collect author names out of a JSON-LD author value (string | object | array).
function jsonLdAuthors(value: unknown): string | null {
  const names: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") {
      const t = cleanText(v);
      if (t) names.push(t);
    } else if (v && typeof v === "object") {
      const n = cleanText((v as Record<string, unknown>).name);
      if (n) names.push(n);
    }
  };
  if (Array.isArray(value)) value.forEach(push);
  else push(value);
  if (names.length === 0) return null;
  return names.slice(0, 6).join(", ");
}

const ARTICLE_LD_TYPES = new Set([
  "Article",
  "NewsArticle",
  "ScholarlyArticle",
  "BlogPosting",
  "Report",
  "TechArticle",
  "MedicalScholarlyArticle",
  "WebPage",
]);

function ldTypeMatches(node: Record<string, unknown>): boolean {
  const t = node["@type"];
  if (typeof t === "string") return ARTICLE_LD_TYPES.has(t);
  if (Array.isArray(t)) return t.some((x) => typeof x === "string" && ARTICLE_LD_TYPES.has(x));
  return false;
}

/**
 * Extract citation metadata from an HTML document. Pure (no network) so it is
 * unit-testable; `doc` is a parsed DOM Document, `finalUrl` the fetched URL.
 */
export function extractCitationMetaFromDocument(doc: Document, finalUrl: string): CitationMeta {
  const meta: CitationMeta = { ...EMPTY_META };
  const metaContent = (selector: string): string | null =>
    cleanText(doc.querySelector(selector)?.getAttribute("content"));

  // 1. JSON-LD blocks (highest-fidelity structured metadata).
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    if (meta.title) break;
    try {
      const parsed: unknown = JSON.parse(script.textContent ?? "");
      const nodes: unknown[] = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>)["@graph"])
          ? ((parsed as Record<string, unknown>)["@graph"] as unknown[])
          : [parsed];
      for (const raw of nodes) {
        if (!raw || typeof raw !== "object") continue;
        const node = raw as Record<string, unknown>;
        if (!ldTypeMatches(node)) continue;
        const title = cleanText(node.headline) ?? cleanText(node.name);
        if (!title) continue;
        meta.title = title;
        meta.authors = jsonLdAuthors(node.author);
        const publisher = node.publisher;
        meta.publisher =
          publisher && typeof publisher === "object"
            ? cleanText((publisher as Record<string, unknown>).name)
            : cleanText(publisher);
        meta.publishedAt = parseDate(node.datePublished) ?? parseDate(node.dateCreated);
        break;
      }
    } catch {
      // Malformed JSON-LD — ignore this block.
    }
  }

  // 2. Academic citation_* meta tags (Google Scholar / Highwire) — these are
  // authoritative for journal articles, so they may fill gaps or override a
  // generic JSON-LD WebPage title.
  const citTitle = metaContent('meta[name="citation_title"]');
  if (citTitle) {
    meta.title = citTitle;
    const citAuthors = Array.from(doc.querySelectorAll('meta[name="citation_author"]'))
      .map((el) => cleanText(el.getAttribute("content")))
      .filter((x): x is string => !!x);
    if (citAuthors.length > 0) meta.authors = citAuthors.slice(0, 6).join(", ");
    meta.publisher =
      metaContent('meta[name="citation_journal_title"]') ??
      metaContent('meta[name="citation_publisher"]') ??
      meta.publisher;
    meta.publishedAt =
      parseDate(metaContent('meta[name="citation_publication_date"]') ?? undefined) ??
      parseDate(metaContent('meta[name="citation_date"]') ?? undefined) ??
      meta.publishedAt;
  }
  meta.doi =
    extractDoi(metaContent('meta[name="citation_doi"]')) ??
    extractDoi(metaContent('meta[name="dc.identifier"]')) ??
    null;

  // 3. Open Graph fallbacks. og:title often carries a trailing " | Site Name".
  if (!meta.title) meta.title = cleanHtmlTitle(metaContent('meta[property="og:title"]'));
  if (!meta.publisher) meta.publisher = metaContent('meta[property="og:site_name"]');
  if (!meta.publishedAt) {
    meta.publishedAt = parseDate(
      metaContent('meta[property="article:published_time"]') ??
        metaContent('meta[name="date"]') ??
        doc.querySelector("time[datetime]")?.getAttribute("datetime") ??
        undefined,
    );
  }
  if (!meta.authors) {
    meta.authors =
      metaContent('meta[name="author"]') ?? metaContent('meta[property="article:author"]');
  }
  // Junk-guard: some sites put a URL (e.g. their Facebook page) in the author
  // meta — a URL is never a byline.
  if (meta.authors && /^https?:\/\//i.test(meta.authors)) meta.authors = null;

  // 4. Cleaned <title>.
  if (!meta.title) meta.title = cleanHtmlTitle(doc.querySelector("title")?.textContent ?? null);

  // Canonical URL (junk-guarded, absolutized).
  const rawCanonical =
    doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ??
    metaContent('meta[property="og:url"]');
  if (rawCanonical && !/^(undefined|null|#|javascript:)/i.test(rawCanonical.trim())) {
    try {
      meta.canonicalUrl = new URL(rawCanonical, finalUrl).toString();
    } catch {
      // ignore malformed canonical
    }
  }

  return meta;
}

/**
 * Extract the Semantic Scholar paper ID from a URL.
 * URL shape: semanticscholar.org/paper/<TitleSlug>/<PaperId>
 * Paper IDs are 40-char hex strings (SHA-1-like). The title slug before the ID
 * is human-readable but not needed — the ID alone uniquely identifies the paper.
 */
export function parseSemanticScholarUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)semanticscholar\.org$/i.test(u.hostname)) return null;
    const segments = u.pathname.split("/").filter(Boolean);
    // Must start with "paper" segment
    if (segments[0]?.toLowerCase() !== "paper") return null;
    // Paper ID is the last segment — at least 10 hex chars
    const last = segments[segments.length - 1];
    if (!last || !/^[a-f0-9]{10,}$/i.test(last)) return null;
    return last;
  } catch {
    return null;
  }
}

/**
 * Fetch paper metadata from the Semantic Scholar public API (no key required).
 * Semantic Scholar pages are fully client-side rendered, so HTML scraping only
 * yields the site-name title. Their Graph API returns clean bibliographic data.
 * Rate-limited to ~100 req/5min unauthenticated — never throws, returns null.
 */
async function fetchSemanticScholarMetadata(paperId: string): Promise<CitationMeta | null> {
  try {
    const res = await fetch(
      `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(paperId)}?fields=title,authors,year,publicationDate,venue,externalIds`,
      {
        headers: {
          "User-Agent": "BrainHookCitationBot/1.0 (mailto:editorial@brainhook.net)",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      title?: string;
      authors?: Array<{ name?: string }>;
      year?: number;
      publicationDate?: string;
      venue?: string;
      externalIds?: { DOI?: string };
    };
    if (!data.title) return null;
    const authors =
      data.authors
        ?.map((a) => a.name)
        .filter(Boolean)
        .join(", ") || null;
    const publishedAt =
      parseDate(data.publicationDate) ?? parseDate(data.year ? String(data.year) : null);
    return {
      ...EMPTY_META,
      title: cleanText(data.title),
      authors,
      publisher: cleanText(data.venue) ?? null,
      publishedAt,
      doi: data.externalIds?.DOI ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve citation metadata for a DOI via the CrossRef REST API. Academic
 * publishers (doi.org, Wiley, Sage, OUP, …) commonly block scrapers, but
 * CrossRef serves the authoritative bibliographic record for free. Returns
 * null when the DOI is unknown or the API is unreachable — never throws.
 */
export async function fetchCrossrefMetadata(doi: string): Promise<CitationMeta | null> {
  try {
    const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: {
        "User-Agent": "BrainHookCitationBot/1.0 (mailto:editorial@brainhook.net)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { message?: Record<string, unknown> };
    const m = body.message;
    if (!m) return null;
    return crossrefItemToMeta(m, doi);
  } catch {
    return null;
  }
}

/** Map a CrossRef work record to CitationMeta. Returns null when untitled. */
function crossrefItemToMeta(m: Record<string, unknown>, doiFallback: string | null): CitationMeta | null {
  const title = cleanText(Array.isArray(m.title) ? m.title[0] : m.title);
  if (!title) return null;
  const authorList = Array.isArray(m.author)
    ? (m.author as Array<Record<string, unknown>>)
        .map((a) => cleanText([a.given, a.family].filter(Boolean).join(" ")) ?? cleanText(a.name))
        .filter((x): x is string => !!x)
    : [];
  const container = Array.isArray(m["container-title"]) ? m["container-title"][0] : null;
  const issued = (m.issued ?? m["published-print"] ?? m["published-online"]) as
    | { "date-parts"?: number[][] }
    | undefined;
  let publishedAt: Date | null = null;
  const parts = issued?.["date-parts"]?.[0];
  if (Array.isArray(parts) && typeof parts[0] === "number") {
    publishedAt = new Date(Date.UTC(parts[0], (parts[1] ?? 1) - 1, parts[2] ?? 1));
    if (Number.isNaN(publishedAt.getTime())) publishedAt = null;
  }
  return {
    title,
    authors: authorList.length > 0 ? authorList.slice(0, 6).join(", ") : null,
    publisher: cleanText(container) ?? cleanText(m.publisher),
    publishedAt,
    canonicalUrl: cleanText(m.URL),
    doi: cleanText(m.DOI) ?? doiFallback,
  };
}

const CROSSREF_HEADERS = {
  "User-Agent": "BrainHookCitationBot/1.0 (mailto:editorial@brainhook.net)",
  Accept: "application/json",
} as const;

/**
 * ScienceDirect article URLs carry an Elsevier PII (e.g. /pii/S0747563225003164)
 * and the pages themselves bot-wall scrapers. CrossRef indexes the PII as an
 * alternative-id, so the authoritative record is one filter query away.
 */
export function extractSciencedirectPii(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)sciencedirect\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/pii\/(S[0-9X]{16,17})/i);
    return m ? m[1]!.toUpperCase() : null;
  } catch {
    return null;
  }
}

export async function fetchCrossrefByPii(pii: string): Promise<CitationMeta | null> {
  try {
    const res = await fetch(
      `https://api.crossref.org/works?filter=alternative-id:${encodeURIComponent(pii)}&rows=1`,
      { headers: CROSSREF_HEADERS, signal: AbortSignal.timeout(10_000), redirect: "follow" },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { message?: { items?: Array<Record<string, unknown>> } };
    const item = body.message?.items?.[0];
    if (!item) return null;
    return crossrefItemToMeta(item, null);
  } catch {
    return null;
  }
}

// Oxford Academic (academic.oup.com) Cloudflare-403s scrapers even with a
// browser UA, but its article URLs encode journal/volume/page. We resolve the
// journal code to an ISSN (small static map for codes whose CrossRef prefix
// probe fails) and query the journal's works, accepting a hit ONLY when both
// volume and first page match — a bibliographic query alone is too fuzzy.
const OUP_JOURNAL_ISSN: Record<string, string> = {
  mnras: "0035-8711",
  gerontologist: "0016-9013",
  jcmc: "1083-6101",
  ct: "1050-3293",
  scan: "1749-5016",
};

// Royal Society Publishing (royalsocietypublishing.org) blocks scrapers with
// Cloudflare, but its article URLs encode journal/volume/article-ID, and each
// journal has a fixed ISSN we can hand to CrossRef.
const ROYAL_SOCIETY_JOURNAL_ISSN: Record<string, string> = {
  rspb: "0962-8452", // Proceedings of the Royal Society B
  rspa: "1364-5021", // Proceedings of the Royal Society A
  rstb: "0962-8436", // Philosophical Transactions B
  rsos: "2054-5703", // Royal Society Open Science
  rsif: "1742-5689", // Journal of the Royal Society Interface
};

export function parseRoyalSocietyUrl(
  url: string,
): { issn: string; volume: string; page: string } | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)royalsocietypublishing\.org$/i.test(u.hostname)) return null;
    // /<journal>/article/<volume>/<issue>/<articleId>/<optional-slug>
    const m = u.pathname.match(/^\/([a-z]+)\/article(?:-abstract)?\/(\d+)\/\d+\/(\d+)/i);
    if (!m) return null;
    const issn = ROYAL_SOCIETY_JOURNAL_ISSN[m[1]!.toLowerCase()];
    if (!issn) return null;
    return { issn, volume: m[2]!, page: m[3]! };
  } catch {
    return null;
  }
}

/**
 * Extract a readable citation title from a ResearchGate publication URL.
 * ResearchGate bot-walls all scrapers, but its URLs encode the paper title as
 * a slug after the numeric publication ID: /publication/<id>_<Title_Words>.
 * Returns null when the slug is too short, too long, or absent.
 */
export function titleFromResearchGateUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)researchgate\.net$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/publication\/\d+_(.+)/);
    if (!m) return null;
    // Slugs use underscores as word separators; hyphens are within-word.
    const title = m[1]!.replace(/_/g, " ").replace(/\s+/g, " ").trim();
    if (title.length < 10 || title.length > 250) return null;
    return title;
  } catch {
    return null;
  }
}

export function parseOupArticleUrl(
  url: string,
): { journalCode: string; volume: string; page: string } | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)academic\.oup\.com$/i.test(u.hostname) && u.hostname.toLowerCase() !== "academic.oup.com") {
      return null;
    }
    // /<journal>/article(-abstract)?/<volume>/<issue>/<firstPage>/<id>
    const m = u.pathname.match(/^\/([a-z0-9-]+)\/article(?:-abstract)?\/(\d+)\/[^/]+\/([A-Za-z0-9.]+)\//i);
    if (!m) return null;
    return { journalCode: m[1]!.toLowerCase(), volume: m[2]!, page: m[3]! };
  } catch {
    return null;
  }
}

/**
 * MDPI article URLs literally encode the journal ISSN:
 * mdpi.com/<issn>/<volume>/<issue>/<articleNumber>. The pages bot-wall
 * scrapers, but CrossRef resolves via the volume + article-number match.
 */
export function parseMdpiArticleUrl(
  url: string,
): { issn: string; volume: string; page: string } | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)mdpi\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/(\d{4}-\d{3}[\dXx])\/(\d+)\/(\d+)\/(\d+)(?:\/|$)/);
    if (!m) return null;
    return { issn: m[1]!.toUpperCase(), volume: m[2]!, page: m[4]! };
  } catch {
    return null;
  }
}

// jneurosci.org/content/<volume>/<issue>/<firstPage> — bot-walled; the Journal
// of Neuroscience's ISSN is fixed, so CrossRef volume+page resolves it.
export function parseJneurosciArticleUrl(
  url: string,
): { issn: string; volume: string; page: string } | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)jneurosci\.org$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/content\/(\d+)\/(\d+)\/(\d+)(?:\.\w+)?(?:\/|$)/);
    if (!m) return null;
    return { issn: "0270-6474", volume: m[1]!, page: m[3]! };
  } catch {
    return null;
  }
}

export async function fetchCrossrefOupMetadata(parsed: {
  journalCode: string;
  volume: string;
  page: string;
}): Promise<CitationMeta | null> {
  const issn = OUP_JOURNAL_ISSN[parsed.journalCode];
  if (!issn) return null;
  return fetchCrossrefByVolumePage(issn, parsed.volume, parsed.page);
}

/**
 * Query a journal's CrossRef works by volume + first page (or e-locator /
 * article number), accepting a hit only on an exact match of both — a
 * bibliographic query alone is too fuzzy to trust as a citation.
 */
export async function fetchCrossrefByVolumePage(
  issn: string,
  volume: string,
  page: string,
): Promise<CitationMeta | null> {
  try {
    const res = await fetch(
      `https://api.crossref.org/journals/${issn}/works?query.bibliographic=${encodeURIComponent(
        `${volume} ${page}`,
      )}&rows=20`,
      { headers: CROSSREF_HEADERS, signal: AbortSignal.timeout(15_000), redirect: "follow" },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { message?: { items?: Array<Record<string, unknown>> } };
    const items = body.message?.items ?? [];
    const wantPage = page.toLowerCase();
    const hit = items.find((m) => {
      if (cleanText(m.volume) !== volume) return false;
      const firstPage = (cleanText(m.page) ?? "").split("-")[0]!.trim().toLowerCase();
      // E-locator IDs (e.g. "zmae017") live in article-number, not page.
      const articleNumber = (cleanText(m["article-number"]) ?? "").toLowerCase();
      return firstPage === wantPage || articleNumber === wantPage;
    });
    if (!hit) return null;
    return crossrefItemToMeta(hit, null);
  } catch {
    return null;
  }
}

// PMC / PubMed URLs carry a stable record ID; NCBI's E-utilities esummary API
// serves the authoritative citation record (title/authors/journal/date) even
// though the HTML pages themselves sit behind a bot wall.
function extractNcbiId(rawUrl: string): { db: "pmc" | "pubmed"; id: string } | null {
  const pmc = rawUrl.match(/ncbi\.nlm\.nih\.gov\/(?:pmc\/)?articles\/PMC(\d+)/i);
  if (pmc) return { db: "pmc", id: pmc[1] };
  const pubmed = rawUrl.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i);
  if (pubmed) return { db: "pubmed", id: pubmed[1] };
  return null;
}

/**
 * Resolve citation metadata via NCBI E-utilities esummary. Returns null on any
 * failure — never throws.
 */
export async function fetchNcbiMetadata(dbName: "pmc" | "pubmed", id: string): Promise<CitationMeta | null> {
  try {
    // NCBI rate-limits anonymous clients to ~3 req/s — a burst backfill trips
    // 429s, so retry with backoff instead of falling through to the bot wall.
    let res: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 700 * attempt + Math.random() * 400));
      res = await fetch(
        `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=${dbName}&id=${encodeURIComponent(id)}&retmode=json`,
        {
          headers: { "User-Agent": "BrainHookCitationBot/1.0 (mailto:editorial@brainhook.net)" },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (res.status !== 429 && res.status < 500) break;
    }
    if (!res || !res.ok) return null;
    const body = (await res.json()) as { result?: Record<string, unknown> };
    const rec = body.result?.[id] as Record<string, unknown> | undefined;
    if (!rec) return null;
    const title = cleanText(rec.title);
    if (!title || isJunkCitationTitle(title)) return null;
    const authors = Array.isArray(rec.authors)
      ? (rec.authors as Array<Record<string, unknown>>)
          .map((a) => cleanText(a.name))
          .filter((x): x is string => !!x)
          .slice(0, 6)
          .join(", ")
      : null;
    const ids = Array.isArray(rec.articleids) ? (rec.articleids as Array<Record<string, unknown>>) : [];
    const doi = extractDoi(cleanText(ids.find((x) => x.idtype === "doi")?.value));
    return {
      title: title.replace(/\.\s*$/, ""),
      authors: authors || null,
      publisher: cleanText(rec.fulljournalname) ?? cleanText(rec.source),
      publishedAt: parseDate(cleanText(rec.pubdate) ?? cleanText(rec.epubdate) ?? undefined),
      canonicalUrl: null,
      doi,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a URL (SSRF-hardened) and extract citation metadata. Binary documents
 * (PDF/DOCX/…) fall back to the document extractor's title. URLs carrying a
 * DOI fall back to the CrossRef record when the page itself is blocked or
 * yields no title. Throws UnsafeUrlError/FetchError on refusal/network
 * failure (only when no CrossRef fallback rescued the citation).
 */
export async function fetchCitationMetadata(rawUrl: string): Promise<CitationMeta> {
  // Google Scholar search-query URLs (scholar.google.com/scholar?q=...) are
  // inherently unfetchable as citations: the page is a search-results page,
  // not an article, and Google blocks all scrapers. Reject immediately rather
  // than wasting a retry budget.
  if (/scholar\.google\.com\/scholar\b/i.test(rawUrl)) {
    throw new FetchError("Google Scholar search URLs cannot be resolved to a citable source", 0);
  }

  // SciSpace (scispace.com) is an intermediary aggregator, not a primary
  // source. Its paper URLs encode the paper title as a slug with a trailing
  // internal ID ("paradoxical-effects-of-thought-suppression-1dfwms5euz").
  // Derive a clean title from the URL slug (strip the junk ID suffix) so
  // existing article_sources rows can still carry a readable citation title.
  if (/(?:^|\.)scispace\.com$/i.test(safeHostname(rawUrl) ?? "")) {
    const slugTitle = titleFromUrlSlug(rawUrl);
    if (slugTitle) {
      return { ...EMPTY_META, title: stripTrailingJunkToken(slugTitle) };
    }
    throw new FetchError("SciSpace is an intermediary aggregator — prefer the original journal URL", 0);
  }

  // ResearchGate blocks all scrapers but encodes the paper title in the URL
  // slug as /publication/<id>_<Title_Words>. Derive a title from the slug;
  // fall through to the normal fetch path only when the slug is unusable.
  const rgTitle = titleFromResearchGateUrl(rawUrl);
  if (rgTitle) return { ...EMPTY_META, title: rgTitle };

  // Semantic Scholar pages are fully client-side rendered (React); HTML parsing
  // only yields the site-name title. Use their free public Graph API instead.
  const s2id = parseSemanticScholarUrl(rawUrl);
  if (s2id) {
    const viaS2 = await fetchSemanticScholarMetadata(s2id);
    if (viaS2) return viaS2;
    // API miss (rate-limit / unknown ID) — fall through to slug fallback
  }

  // PMC/PubMed pages bot-wall scrapers — go straight to the NCBI record.
  const ncbi = extractNcbiId(rawUrl);
  if (ncbi) {
    const viaNcbi = await fetchNcbiMetadata(ncbi.db, ncbi.id);
    if (viaNcbi) return viaNcbi;
  }
  // ScienceDirect bot-walls scrapers; the PII resolves via CrossRef.
  const pii = extractSciencedirectPii(rawUrl);
  if (pii) {
    const viaPii = await fetchCrossrefByPii(pii);
    if (viaPii) return viaPii;
  }
  // Oxford Academic Cloudflare-403s scrapers; volume+page resolve via CrossRef.
  const oup = parseOupArticleUrl(rawUrl);
  if (oup) {
    const viaOup = await fetchCrossrefOupMetadata(oup);
    if (viaOup) return viaOup;
  }
  // Royal Society Publishing Cloudflare-403s scrapers; vol+article-ID → CrossRef.
  const royal = parseRoyalSocietyUrl(rawUrl);
  if (royal) {
    const viaRoyal = await fetchCrossrefByVolumePage(royal.issn, royal.volume, royal.page);
    if (viaRoyal) return viaRoyal;
  }
  // MDPI / JNeurosci bot-wall scrapers; their URLs encode ISSN+volume+page.
  const journalRef = parseMdpiArticleUrl(rawUrl) ?? parseJneurosciArticleUrl(rawUrl);
  if (journalRef) {
    const viaJournal = await fetchCrossrefByVolumePage(
      journalRef.issn,
      journalRef.volume,
      journalRef.page,
    );
    if (viaJournal) return viaJournal;
  }
  const urlDoi = extractDoi(rawUrl);
  let fetched: Awaited<ReturnType<typeof safeFetchBytes>>;
  try {
    fetched = await safeFetchBytes(rawUrl);
  } catch (err) {
    if (urlDoi) {
      const viaCrossref = await fetchCrossrefMetadata(urlDoi);
      if (viaCrossref) return viaCrossref;
    }
    // Last resort: derive a meaningful title from the URL path slug.  Many
    // government and institutional pages (justice.gov, war.gov, esa.int, etc.)
    // use the article headline as their slug, so the slug IS the citation title.
    const slugTitle = titleFromUrlSlug(rawUrl);
    if (slugTitle) return { ...EMPTY_META, title: slugTitle };
    throw err;
  }
  const { bytes, finalUrl, status, contentType } = fetched;
  const docType = detectDocumentType({ contentType, url: finalUrl, bytes });
  if (docType) {
    const extracted = await extractFromDocumentBytes(bytes, {
      type: docType,
      url: finalUrl,
      httpStatus: status,
    });
    const rawDocTitle = cleanText(extracted.title);
    // Apply HTML-title cleaning to strip breadcrumb suffixes even on binary
    // documents whose metadata title sometimes has "Title | Publisher" format.
    const docTitle = rawDocTitle && !isJunkCitationTitle(rawDocTitle, safeHostname(finalUrl))
      ? (cleanHtmlTitle(rawDocTitle) ?? rawDocTitle)
      : null;
    return {
      ...EMPTY_META,
      title: docTitle,
      authors: cleanText(extracted.author),
      publishedAt: extracted.publishedAt ?? null,
      doi: extractDoi(rawUrl) ?? extractDoi(finalUrl),
    };
  }
  if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    throw new FetchError(`Unsupported content-type for citation metadata: ${contentType}`, status);
  }
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(bytes.toString("utf8"), { url: finalUrl });
  const meta = extractCitationMetaFromDocument(dom.window.document, finalUrl);
  if (!meta.doi) meta.doi = extractDoi(rawUrl) ?? extractDoi(finalUrl);
  // Bot-block interstitials (Cloudflare etc.) return HTML with a junk title;
  // a DOI-bearing URL can still be rescued from the CrossRef record.
  const junk = meta.title !== null && isJunkCitationTitle(meta.title, safeHostname(finalUrl));
  if ((!meta.title || junk) && meta.doi) {
    const viaCrossref = await fetchCrossrefMetadata(meta.doi);
    if (viaCrossref) return viaCrossref;
  }
  if (junk) return { ...meta, title: null, authors: null, publisher: null, publishedAt: null };
  // Last resort: if the page loaded but yielded no title (e.g. bot-walled with
  // Cloudflare that also lacked a DOI), try a slug derived from the final URL.
  if (!meta.title) meta.title = titleFromUrlSlug(finalUrl) ?? titleFromUrlSlug(rawUrl);
  return meta;
}

// --- Snapshot helpers ------------------------------------------------------

/**
 * Copy citation metadata from URL-matched Source Vault documents onto
 * article_sources rows that don't have a snapshot yet. Free (DB-only) and
 * idempotent — never overwrites an existing source_title (manual overrides and
 * prior snapshots win).
 */
// PostgreSQL regex that mirrors the JS JUNK_TITLE_PREFIX_RE guard: prevents
// bot-wall interstitial page titles from being stored as citation metadata.
// Applied both when copying from the vault and when clearing existing junk.
const JUNK_TITLE_PG_RE =
  `^\\W*(just a moment|checking your browser|checking the site|checking if the site|` +
  `verify(ing)? (you|that)|are you a robot|robot check|human verification|` +
  `bot verification|browser (check|verification)|attention required|` +
  `access denied|access restricted|access to this page|security check(point)?|` +
  `captcha|cloudflare|ddos|radware|bot manager|` +
  `please enable (javascript|cookies)|javascript is (disabled|required)|` +
  `enable javascript|unsupported browser|your browser is|` +
  `page not found|redirect notice|redirecting|one moment|please wait|` +
  `request rejected|request blocked|rate limit exceeded)`;

export async function copyVaultCitationMetadata(): Promise<number> {
  const res = await db.execute(sql`
    UPDATE "article_sources" s
    SET "source_title" = NULLIF(btrim(sd."title"), ''),
        "source_authors" = COALESCE(s."source_authors", NULLIF(btrim(sd."author"), '')),
        "source_published_at" = COALESCE(s."source_published_at", sd."published_at"),
        "canonical_url" = COALESCE(s."canonical_url", sd."canonical_url"),
        "accessed_at" = COALESCE(s."accessed_at", sd."fetched_at", now()),
        "updated_at" = now()
    FROM "source_documents" sd
    WHERE s."source_title" IS NULL
      AND s."role" = 'evidence'
      AND s."status" <> 'rejected'
      AND NULLIF(btrim(sd."title"), '') IS NOT NULL
      AND NOT (btrim(sd."title") ~* ${JUNK_TITLE_PG_RE})
      AND (
        sd."id" = s."source_document_id"
        OR sd."url" = s."url"
        OR sd."canonical_url" = s."url"
      )
  `);
  return res.rowCount ?? 0;
}

/**
 * NULL out any junk bot-wall titles (e.g. "Radware Bot Manager Captcha") that
 * slipped into article_sources.source_title during a prior vault copy. Also
 * resets accessed_at so the citation backfill will re-fetch those URLs.
 * Called by the admin diversity sweep; safe to call independently.
 */
export async function clearJunkSourceTitles(): Promise<number> {
  const res = await db.execute(sql`
    UPDATE "article_sources"
    SET "source_title" = NULL,
        "accessed_at" = NULL,
        "updated_at" = now()
    WHERE "role" = 'evidence'
      AND "status" <> 'rejected'
      AND "source_title" IS NOT NULL
      AND "source_title" ~* ${JUNK_TITLE_PG_RE}
  `);
  return res.rowCount ?? 0;
}

/**
 * Snapshot citation metadata onto a single article_sources row from an
 * already-known Source Vault document (used at reconcile/link time so new
 * articles get true citations without waiting for a backfill run).
 */
export async function snapshotCitationFromVaultDoc(
  articleSourceId: string,
  doc: { title: string | null; author: string | null; publishedAt: Date | null; canonicalUrl: string | null },
): Promise<void> {
  const title = cleanText(doc.title);
  if (!title || isJunkCitationTitle(title)) return;
  await db
    .update(articleSourcesTable)
    .set({
      sourceTitle: title,
      sourceAuthors: cleanText(doc.author),
      sourcePublishedAt: doc.publishedAt ?? null,
      canonicalUrl: doc.canonicalUrl ?? null,
      accessedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(articleSourcesTable.id, articleSourceId), isNull(articleSourcesTable.sourceTitle)));
}

// --- Stored-title cleaning ---------------------------------------------------

/**
 * Clean breadcrumb suffixes out of source titles that were vault-copied or
 * HTML-scraped before the recursive `cleanHtmlTitle` fix. Finds rows whose
 * stored title contains a " | " separator (multi-segment breadcrumb format)
 * or ends with a known site-name suffix (" - PubMed", " - Google Scholar",
 * etc.) and applies JS-level cleaning in-process, then bulk-updates the DB.
 *
 * Safe to call on every backfill run: idempotent (already-clean titles match
 * no pattern and are skipped), fast (limited to the dirty subset).
 */
export async function cleanStoredVaultTitles(opts?: {
  articleIds?: string[];
}): Promise<number> {
  // Fetch candidate rows: titles with a pipe (breadcrumb), known junk suffix,
  // or a trailing junk slug token (e.g. "Title 1dfwms5euz" from SciSpace).
  // When articleIds is provided only those articles are scoped (used by tests).
  const articleFilter =
    opts?.articleIds && opts.articleIds.length > 0
      ? sql`AND article_id = ANY(ARRAY[${sql.join(
          opts.articleIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}])`
      : sql``;
  const rows = await db.execute(sql`
    SELECT id, source_title
    FROM article_sources
    WHERE role = 'evidence'
      AND status <> 'rejected'
      AND source_title IS NOT NULL
      ${articleFilter}
      AND (
        source_title LIKE '% | %'
        OR source_title LIKE '% - PubMed'
        OR source_title LIKE '% – PubMed'
        OR source_title LIKE '% - Google Scholar'
        OR source_title LIKE '% – Google Scholar'
        OR source_title ~* '[[:space:]]+[-–—][[:space:]]+(PubMed|Google Scholar|ResearchGate|Internet Archive|Cambridge Core|Academia\.edu|Semantic Scholar|ScienceDirect|bioRxiv|medRxiv|PsycNET|JSTOR|Springer|Wiley|Taylor & Francis)$'
        OR source_title ~ '[[:space:]]+[a-z0-9]{6,14}$'
      )
  `);
  if (rows.rows.length === 0) return 0;

  let cleaned = 0;
  const now = new Date();
  for (const row of rows.rows) {
    const rawTitle = row.source_title as string | null;
    if (!rawTitle) continue;
    const tidied = cleanHtmlTitle(rawTitle);
    if (!tidied || tidied === rawTitle) continue;
    await db.execute(sql`
      UPDATE article_sources
      SET source_title = ${tidied}, updated_at = ${now}
      WHERE id = ${row.id as string}
        AND source_title = ${rawTitle}
    `);
    cleaned++;
  }
  return cleaned;
}

// --- Backfill job ------------------------------------------------------------

export const CITATION_BACKFILL_JOB = "citation_metadata_backfill";
const BACKFILL_TTL_MS = 3 * 60 * 1000;
// Per-run cap on network fetches so a single tick can't run unbounded; re-run
// the job to continue (rows already attempted are skipped via accessed_at).
const MAX_FETCHES_PER_RUN = 400;

export interface CitationBackfillReport {
  vaultCopied: number;
  urlsFetched: number;
  rowsUpdated: number;
  fetchFailures: number;
  remaining: number;
}

async function countRemaining(): Promise<number> {
  const res = await db.execute(sql`
    SELECT count(DISTINCT "url")::int AS n FROM "article_sources"
    WHERE "role" = 'evidence' AND "status" <> 'rejected'
      AND "source_title" IS NULL AND "accessed_at" IS NULL
  `);
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * Backfill citation snapshots for every evidence source row. Pass 1 copies
 * metadata from URL-matched Source Vault documents (free). Pass 2 fetches each
 * remaining distinct URL once (SSRF-hardened) and applies the extracted
 * metadata to ALL rows sharing that URL. Failed fetches still stamp
 * accessed_at so re-runs don't re-hammer dead URLs.
 */
export async function backfillCitationMetadata(): Promise<CitationBackfillReport | null> {
  const runId = await acquireJobLock(CITATION_BACKFILL_JOB, { ttlMs: BACKFILL_TTL_MS });
  if (!runId) return null;
  return runCitationBackfill(runId);
}

/**
 * Fire-and-forget variant for the admin trigger: acquires the lock (409 path
 * when it can't) and runs the backfill in an unawaited promise.
 */
export async function startCitationBackfill(): Promise<boolean> {
  const runId = await acquireJobLock(CITATION_BACKFILL_JOB, { ttlMs: BACKFILL_TTL_MS });
  if (!runId) return false;
  void runCitationBackfill(runId).catch((err) => {
    logger.error({ err }, "citationBackfill: background run failed");
  });
  return true;
}

async function runCitationBackfill(runId: string): Promise<CitationBackfillReport> {
  const report: CitationBackfillReport = {
    vaultCopied: 0,
    urlsFetched: 0,
    rowsUpdated: 0,
    fetchFailures: 0,
    remaining: 0,
  };
  try {
    // Pass 0: clean breadcrumb suffixes out of titles stored by earlier runs
    // (before the recursive cleanHtmlTitle fix). Idempotent — already-clean
    // titles are skipped. Runs before the vault copy so freshly-copied titles
    // benefit from the same cleaning on the same run.
    await cleanStoredVaultTitles();

    report.vaultCopied = await copyVaultCitationMetadata();

    const pending = await db
      .selectDistinct({ url: articleSourcesTable.url })
      .from(articleSourcesTable)
      .where(
        and(
          eq(articleSourcesTable.role, "evidence"),
          ne(articleSourcesTable.status, "rejected"),
          isNull(articleSourcesTable.sourceTitle),
          isNull(articleSourcesTable.accessedAt),
        ),
      )
      .limit(MAX_FETCHES_PER_RUN);

    let processed = 0;
    for (const { url } of pending) {
      if (await isCancelRequested(CITATION_BACKFILL_JOB)) break;
      processed += 1;
      if (processed % 10 === 0) {
        await heartbeatJob(CITATION_BACKFILL_JOB, runId, {
          phase: "fetch",
          processed,
          total: pending.length,
          ...report,
        });
      }
      const now = new Date();
      try {
        const meta = await fetchCitationMetadata(url);
        report.urlsFetched += 1;
        if (meta.title) {
          const updated = await db
            .update(articleSourcesTable)
            .set({
              sourceTitle: meta.title,
              sourceAuthors: meta.authors,
              publisherName: meta.publisher,
              sourcePublishedAt: meta.publishedAt,
              canonicalUrl: meta.canonicalUrl,
              doi: meta.doi,
              accessedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(articleSourcesTable.url, url),
                isNull(articleSourcesTable.sourceTitle),
              ),
            )
            .returning({ id: articleSourcesTable.id });
          report.rowsUpdated += updated.length;
        } else {
          await db
            .update(articleSourcesTable)
            .set({ accessedAt: now, updatedAt: now })
            .where(and(eq(articleSourcesTable.url, url), isNull(articleSourcesTable.accessedAt)));
        }
      } catch (err) {
        report.fetchFailures += 1;
        // Stamp the attempt so re-runs skip this URL; the render path falls
        // back to the domain (never anchor text).
        await db
          .update(articleSourcesTable)
          .set({ accessedAt: now, updatedAt: now })
          .where(and(eq(articleSourcesTable.url, url), isNull(articleSourcesTable.accessedAt)));
        if (!(err instanceof UnsafeUrlError) && !(err instanceof FetchError)) {
          logger.warn({ err, url }, "citationBackfill: unexpected fetch error");
        }
      }
    }

    report.remaining = await countRemaining();
    await finishJob(CITATION_BACKFILL_JOB, runId, "succeeded", { progress: { ...report } });
    logger.info(report, "citationBackfill: run complete");
    return report;
  } catch (err) {
    await finishJob(CITATION_BACKFILL_JOB, runId, "failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    logger.error({ err }, "citationBackfill: run failed");
    throw err;
  }
}

export async function getCitationBackfillStatus(): Promise<{
  status: string;
  progress: Record<string, unknown> | null;
  remaining: number;
}> {
  const state = await getJobState(CITATION_BACKFILL_JOB);
  return {
    status: state?.status ?? "idle",
    progress: (state?.progress as Record<string, unknown> | null) ?? null,
    remaining: await countRemaining(),
  };
}

/** Request cooperative cancellation of the running citation backfill. */
export async function cancelCitationBackfill(): Promise<boolean> {
  return requestJobCancel(CITATION_BACKFILL_JOB);
}

/**
 * Force-release a stuck citation backfill job (marks it failed so the next
 * acquireJobLock call can succeed immediately without waiting for TTL takeover).
 */
export async function forceReleaseCitationBackfill(): Promise<boolean> {
  return forceReleaseJob(CITATION_BACKFILL_JOB);
}

// --- Per-article citation refresh ----------------------------------------

export interface CitationRefreshReport {
  fetched: number;
  updated: number;
  failed: number;
}

/**
 * Reset and re-fetch citation metadata for a single article's evidence sources.
 * Clears accessed_at (and any existing source_title) for each source row so the
 * fetch is unconditional, then synchronously fetches each distinct URL.
 * Bounded by the number of sources on one article (≤ ~10).
 */
export async function refreshArticleCitationMetadata(articleId: string): Promise<CitationRefreshReport> {
  // Clear existing snapshots so we get a fresh attempt even on URLs that
  // previously failed or returned a junk title.
  await db.execute(sql`
    UPDATE "article_sources"
    SET "source_title" = NULL,
        "source_authors" = NULL,
        "publisher_name" = NULL,
        "source_published_at" = NULL,
        "canonical_url" = NULL,
        "doi" = NULL,
        "accessed_at" = NULL,
        "updated_at" = now()
    WHERE "article_id" = ${articleId}
      AND "role" = 'evidence'
      AND "status" <> 'rejected'
  `);

  // Re-snapshot from the Vault first (free, no network).
  await copyVaultCitationMetadataForArticle(articleId);

  // Fetch remaining URLs that the Vault didn't cover.
  const pending = await db
    .selectDistinct({ url: articleSourcesTable.url })
    .from(articleSourcesTable)
    .where(
      and(
        eq(articleSourcesTable.articleId, articleId),
        eq(articleSourcesTable.role, "evidence"),
        ne(articleSourcesTable.status, "rejected"),
        isNull(articleSourcesTable.sourceTitle),
        isNull(articleSourcesTable.accessedAt),
      ),
    );

  const report: CitationRefreshReport = { fetched: 0, updated: 0, failed: 0 };
  const now = new Date();

  for (const { url } of pending) {
    try {
      const meta = await fetchCitationMetadata(url);
      report.fetched += 1;
      if (meta.title) {
        const updated = await db
          .update(articleSourcesTable)
          .set({
            sourceTitle: meta.title,
            sourceAuthors: meta.authors,
            publisherName: meta.publisher,
            sourcePublishedAt: meta.publishedAt,
            canonicalUrl: meta.canonicalUrl,
            doi: meta.doi,
            accessedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(articleSourcesTable.url, url),
              eq(articleSourcesTable.articleId, articleId),
              isNull(articleSourcesTable.sourceTitle),
            ),
          )
          .returning({ id: articleSourcesTable.id });
        report.updated += updated.length;
      } else {
        await db
          .update(articleSourcesTable)
          .set({ accessedAt: now, updatedAt: now })
          .where(
            and(
              eq(articleSourcesTable.url, url),
              eq(articleSourcesTable.articleId, articleId),
            ),
          );
      }
    } catch {
      report.failed += 1;
      await db
        .update(articleSourcesTable)
        .set({ accessedAt: now, updatedAt: now })
        .where(
          and(
            eq(articleSourcesTable.url, url),
            eq(articleSourcesTable.articleId, articleId),
          ),
        );
    }
  }

  return report;
}

/** Vault copy scoped to a single article (used by the per-article refresh). */
async function copyVaultCitationMetadataForArticle(articleId: string): Promise<void> {
  await db.execute(sql`
    UPDATE "article_sources" AS s
    SET "source_title"       = d."title",
        "source_authors"     = d."author",
        "source_published_at"= d."published_at",
        "canonical_url"      = d."canonical_url",
        "accessed_at"        = now(),
        "updated_at"         = now()
    FROM "source_documents" AS d
    WHERE s."source_document_id" = d."id"
      AND s."article_id"         = ${articleId}
      AND s."role"               = 'evidence'
      AND s."status"            <> 'rejected'
      AND s."source_title"      IS NULL
      AND d."title"             IS NOT NULL
      AND d."title"             <> ''
  `);
}

// --- Global reset-and-retry -----------------------------------------------

/**
 * Reset the accessed_at stamp on evidence-source rows that still have no
 * source_title (previously attempted but got nothing), then kick off the
 * standard background backfill so they are retried.  Returns how many rows
 * were reset and whether a fresh backfill was started.
 */
export async function startResetAndBackfill(): Promise<{ reset: number; started: boolean }> {
  const res = await db.execute(sql`
    UPDATE "article_sources"
    SET "accessed_at" = NULL,
        "updated_at"  = now()
    WHERE "role"         = 'evidence'
      AND "status"      <> 'rejected'
      AND "source_title" IS NULL
      AND "accessed_at" IS NOT NULL
  `);
  const reset = Number(res.rowCount ?? 0);
  const started = await startCitationBackfill();
  return { reset, started };
}
