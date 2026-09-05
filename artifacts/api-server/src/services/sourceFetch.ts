import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateOrReservedIp } from "./citations";
import { parseRobotsTxt, isPathAllowed } from "../lib/robots";
import {
  detectDocumentType,
  extractDocumentText,
  type DocumentType,
} from "./documentExtract";

// --- SSRF-safe fetch + article extraction + quality score ----------------
// Fetches a source URL with the same SSRF hardening the citation checker uses
// (resolve DNS up front, refuse private/reserved targets, cap size, time out),
// extracts the main article body with Mozilla Readability, and scores the
// extraction quality 0-100 with human-readable flags so low-quality pages can be
// held out of embedding. Logger-free so it stays unit-testable in isolation.

const FETCH_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB cap (HTML pages + binary documents)
const MAX_REDIRECTS = 4;
// Accept header used for source fetches: prefer HTML/PDF/Office docs, but allow
// anything so we can sniff and route documents the server mislabels.
const FETCH_ACCEPT =
  "text/html,application/xhtml+xml,application/pdf,application/vnd.openxmlformats-officedocument.*,*/*";
/** Minimum quality score for a source to be embedded without manual approval. */
export const QUALITY_THRESHOLD = 55;

/** Thrown when a URL must never be fetched (SSRF) or is malformed. */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/** Thrown when the fetch itself fails (network, timeout, non-HTML, too big). */
export class FetchError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

/**
 * Validate a single URL is a public http(s) target safe to fetch: rejects
 * non-http(s) schemes, internal hostnames, and any host that resolves to a
 * private/reserved address (SSRF guard). Returns the parsed URL on success.
 */
async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError(`Not a valid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeUrlError(`Refusing non-http(s) URL: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new UnsafeUrlError(`Refusing internal hostname: ${host}`);
  }
  let addresses: { address: string }[];
  if (isIP(host)) {
    addresses = [{ address: host }];
  } else {
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      throw new UnsafeUrlError(`Host does not resolve: ${host}`);
    }
  }
  if (addresses.length === 0) throw new UnsafeUrlError(`Host does not resolve: ${host}`);
  if (addresses.some((a) => isPrivateOrReservedIp(a.address))) {
    throw new UnsafeUrlError(`Host resolves to a private/reserved address: ${host}`);
  }
  return parsed;
}

/** Result of a raw safe fetch: the raw bytes plus response metadata. */
interface RawBytesFetch {
  bytes: Buffer;
  finalUrl: string;
  status: number;
  contentType: string;
}

/**
 * Fetch a URL's raw bytes with SSRF hardening. Redirects are followed MANUALLY so
 * each hop is re-validated against the SSRF guard (a plain redirect:"follow"
 * would let a public URL bounce to an internal one). Enforces a byte cap and a
 * timeout. Content-type is returned (not enforced) so the caller can sniff and
 * route HTML vs binary documents.
 */
export async function safeFetchBytes(rawUrl: string): Promise<RawBytesFetch> {
  let current = await assertPublicHttpUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": FETCH_UA, accept: FETCH_ACCEPT },
      });

      // Manual redirect handling with per-hop SSRF re-validation.
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new FetchError(`Redirect with no Location header`, res.status);
        if (hop === MAX_REDIRECTS) throw new FetchError(`Too many redirects`, res.status);
        current = await assertPublicHttpUrl(new URL(location, current).toString());
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        throw new FetchError(`Fetch returned HTTP ${res.status}`, res.status);
      }

      // Stream with a hard byte cap so a giant/hostile body can't exhaust memory.
      const reader = res.body?.getReader();
      if (!reader) throw new FetchError(`Empty response body`, res.status);
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          if (total > MAX_BYTES) {
            void reader.cancel();
            throw new FetchError(`Response exceeds ${MAX_BYTES} byte cap`, res.status);
          }
          chunks.push(value);
        }
      }
      return {
        bytes: Buffer.concat(chunks),
        finalUrl: current.toString(),
        status: res.status,
        contentType: res.headers.get("content-type") ?? "",
      };
    } catch (err) {
      if (err instanceof FetchError || err instanceof UnsafeUrlError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new FetchError(`Fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
      }
      throw new FetchError(`Fetch failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new FetchError(`Too many redirects`);
}

/** The extracted, cleaned article plus its quality assessment. */
export interface ExtractedSource {
  finalUrl: string;
  domain: string;
  httpStatus: number;
  title: string | null;
  author: string | null;
  excerpt: string | null;
  publishedAt: Date | null;
  text: string;
  wordCount: number;
  extractionMethod: string;
  qualityScore: number;
  qualityFlags: string[];
  /** rel=canonical / og:url target, absolutized, when it differs from finalUrl. */
  canonicalUrl: string | null;
  /** True when the page shows a paywall / subscription / login wall. */
  paywallDetected: boolean;
  /** True when only a truncated excerpt (not the full article) was obtained. */
  excerptOnly: boolean;
  /** Human-readable fetch-policy notes (paywall, excerpt, robots, etc.). */
  policyNotes: string | null;
}

/** robots.txt outcome for a URL. */
export type RobotsStatus = "allowed" | "disallowed" | "unknown";

export interface RobotsDecision {
  status: RobotsStatus;
  /** Whether fetching is permitted (unknown → permitted, fail-open). */
  allowed: boolean;
  note: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * True for canonical-tag values that are client-side rendering placeholders or
 * otherwise meaningless (a page shipped an unhydrated `<link rel="canonical"
 * href="undefined">`, an empty tag, or a bare fragment). Resolving these
 * against the page URL produces junk like `https://www.youtube.com/undefined`,
 * so they must be treated as "no canonical declared" rather than stored.
 */
function isJunkCanonicalHref(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "#" || v === "undefined" || v === "null") return true;
  // A path that is only "/undefined" or "/null" (with optional query/hash).
  return /^\/?(undefined|null)(?:[?#].*)?$/.test(v);
}

/**
 * Normalize any YouTube URL shape (youtu.be/<id>, /watch?v=<id>, /shorts/<id>,
 * /embed/<id>, /v/<id>, /live/<id>) into the canonical watch URL
 * `https://www.youtube.com/watch?v=<id>`. Returns null when the host is not
 * YouTube or no valid 11-character video id can be extracted (e.g. the "id"
 * was the literal string "undefined"). Pure — no network.
 */
export function canonicalizeYouTubeUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  let id: string | null = null;
  if (host === "youtu.be") {
    id = u.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (u.pathname === "/watch") {
      id = u.searchParams.get("v");
    } else {
      const m = u.pathname.match(/^\/(?:embed|shorts|v|live)\/([^/?#]+)/);
      if (m) id = m[1];
    }
  } else {
    return null;
  }
  if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) {
    return `https://www.youtube.com/watch?v=${id}`;
  }
  return null;
}

/**
 * Resolve the canonical URL for a fetched page. Guards against junk canonical
 * tags, absolutizes a valid relative/absolute canonical against the final URL,
 * and normalizes YouTube URLs to their `watch?v=<id>` form. When no usable
 * canonical is found, falls back to the post-redirect final URL, then the
 * originally requested URL — never a bogus value. Pure — no network.
 */
export function resolveCanonicalUrl(
  rawCanonical: string | null | undefined,
  finalUrl: string,
  requestedUrl: string,
): string | null {
  let declared: string | null = null;
  if (rawCanonical && !isJunkCanonicalHref(rawCanonical)) {
    try {
      declared = new URL(rawCanonical, finalUrl).toString();
    } catch {
      declared = null;
    }
  }
  // A YouTube page's declared canonical is often a fragile client-rendered
  // value; always prefer a deterministic watch URL derived from the id.
  const youTube =
    canonicalizeYouTubeUrl(declared ?? "") ??
    canonicalizeYouTubeUrl(finalUrl) ??
    canonicalizeYouTubeUrl(requestedUrl);
  if (youTube) return youTube;
  if (declared && declared !== finalUrl) return declared;
  if (finalUrl && finalUrl !== requestedUrl) return finalUrl;
  return requestedUrl || null;
}

function countWords(text: string): number {
  const t = text.trim();
  return t.length === 0 ? 0 : t.split(/\s+/).length;
}

/**
 * Heuristic 0-100 quality score for an extraction, with human-readable flags for
 * every deduction. Rewards article length and paragraph structure; penalizes
 * thin content, missing titles, high link/boilerplate density, and paywall/login
 * signals. Pure — no network.
 */
export function scoreQuality(input: {
  title: string | null;
  text: string;
  rawHtmlLength: number;
}): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 100;
  const words = countWords(input.text);
  const paragraphs = input.text.split(/\n{2,}/).filter((p) => p.trim().length > 0).length;

  if (words < 120) {
    score -= 55;
    flags.push(`very_short (${words} words)`);
  } else if (words < 300) {
    score -= 30;
    flags.push(`short (${words} words)`);
  } else if (words < 500) {
    score -= 10;
    flags.push(`thin (${words} words)`);
  }

  if (!input.title || input.title.trim().length === 0) {
    score -= 15;
    flags.push("no_title");
  }

  if (paragraphs < 2 && words >= 120) {
    score -= 10;
    flags.push("no_paragraph_structure");
  }

  // Extracted-text-to-HTML ratio: a very low ratio suggests boilerplate-heavy /
  // failed extraction. Only meaningful when the HTML is non-trivial.
  if (input.rawHtmlLength > 2000) {
    const ratio = input.text.length / input.rawHtmlLength;
    if (ratio < 0.02) {
      score -= 20;
      flags.push(`low_content_ratio (${(ratio * 100).toFixed(1)}%)`);
    }
  }

  // Paywall / access-wall signals in the extracted text.
  if (
    /subscribe to (read|continue)|create a free account|sign in to (read|continue)|this content is for subscribers/i.test(
      input.text,
    )
  ) {
    score -= 25;
    flags.push("paywall_signal");
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), flags };
}

// Signals that a page is gated behind a paywall / subscription / login wall.
const PAYWALL_TEXT =
  /subscribe to (read|continue)|create a (free )?account|sign in to (read|continue)|this (content|article) is for subscribers|already a subscriber|register to (read|continue)|to continue reading|unlock this article|members[- ]only/i;

/**
 * Detect access limits (paywall / login wall / truncated excerpt) from extracted
 * text + a few HTML meta hints. Pure — no network. `excerptOnly` means the page
 * yielded only a short teaser (typical of metered paywalls) rather than the full
 * body, so the text should not be trusted as complete.
 */
export function detectAccessLimits(input: {
  text: string;
  wordCount: number;
  metaPaywall: boolean;
}): { paywallDetected: boolean; excerptOnly: boolean; notes: string[] } {
  const notes: string[] = [];
  const paywallText = PAYWALL_TEXT.test(input.text);
  const paywallDetected = paywallText || input.metaPaywall;
  if (paywallDetected) notes.push(input.metaPaywall ? "paywall (meta)" : "paywall (text signal)");

  // A paywall/login wall that also produced very little body is an excerpt only.
  const excerptOnly = paywallDetected && input.wordCount < 250;
  if (excerptOnly) notes.push(`excerpt only (${input.wordCount} words behind wall)`);

  return { paywallDetected, excerptOnly, notes };
}

// --- Lifecycle recheck signals ------------------------------------------
// Pure detectors + a deterministic classifier mapping a re-fetch outcome to a
// lifecycle transition. Kept here (logger-free, no DB) so the transition rules
// are unit-testable in isolation; the DB-driven recheck loop lives in
// sourceVault.recheckActiveDocuments.

/** Publisher retraction / withdrawal / takedown notice in the re-fetched body. */
const RETRACTION_TEXT =
  /\b(this (?:article|story|paper|study|report|post) has been (?:retracted|withdrawn|removed|taken down|pulled)|(?:notice|note) of retraction|retraction notice|has been retracted|editorial retraction)\b/i;

/** Post-publication correction / clarification notice in the re-fetched body.
 * No trailing \b: several alternatives end in ":" (a non-word char) which would
 * never satisfy a word boundary before the following space. */
const CORRECTION_TEXT =
  /\b(correction:|corrected on\b|this (?:article|story) (?:has been|was) corrected|an earlier version of this (?:article|story|post)\b|editor'?s note:|clarification:)/i;

export interface EditorialSignals {
  retracted: boolean;
  correctionNoted: boolean;
}

/** Detect retraction / correction notices in a page's extracted text. Pure. */
export function detectEditorialSignals(text: string): EditorialSignals {
  return {
    retracted: RETRACTION_TEXT.test(text),
    correctionNoted: CORRECTION_TEXT.test(text),
  };
}

/** Lifecycle statuses a recheck can transition a document into. */
export type RecheckLifecycle = "active" | "retracted" | "unavailable";

/** Result of re-fetching a source URL during a lifecycle recheck. */
export type RecheckOutcome =
  | { kind: "fetched"; text: string; contentHash: string }
  | { kind: "gone" } // definitive 404/410 / robots-block / unsafe → unreachable
  | { kind: "transient" }; // network / timeout / other → leave the doc unchanged

export interface RecheckDecision {
  /** New lifecycle status, or null to leave the current one unchanged. */
  lifecycleStatus: RecheckLifecycle | null;
  /** New correction flag, or null to leave unchanged. */
  correctionDetected: boolean | null;
  /** Whether the body changed vs the prior fetch (drives content_changed_at). */
  contentChanged: boolean;
  note: string;
}

/**
 * Deterministically map a recheck outcome to a lifecycle transition. Pure — no
 * DB, no network. Rules, first match wins:
 *  - gone (404/410 / robots-block / unsafe) → `unavailable`
 *  - transient fetch failure → no change (never retract a live source on a blip)
 *  - retraction notice in body → `retracted`
 *  - body changed + correction notice → `active`, correction flagged
 *  - body changed (no notice) → `active`, content-change recorded
 *  - body unchanged → no change
 */
export function classifyRecheck(params: {
  outcome: RecheckOutcome;
  priorContentHash: string | null;
}): RecheckDecision {
  const { outcome, priorContentHash } = params;

  if (outcome.kind === "gone") {
    return {
      lifecycleStatus: "unavailable",
      correctionDetected: null,
      contentChanged: false,
      note: "source no longer reachable",
    };
  }
  if (outcome.kind === "transient") {
    return {
      lifecycleStatus: null,
      correctionDetected: null,
      contentChanged: false,
      note: "transient fetch failure; left unchanged",
    };
  }

  const signals = detectEditorialSignals(outcome.text);
  if (signals.retracted) {
    return {
      lifecycleStatus: "retracted",
      correctionDetected: null,
      contentChanged: false,
      note: "retraction notice detected",
    };
  }

  const contentChanged = priorContentHash != null && priorContentHash !== outcome.contentHash;
  if (contentChanged && signals.correctionNoted) {
    return {
      lifecycleStatus: "active",
      correctionDetected: true,
      contentChanged: true,
      note: "content changed with correction notice",
    };
  }
  if (contentChanged) {
    return {
      lifecycleStatus: "active",
      correctionDetected: null,
      contentChanged: true,
      note: "content changed since last fetch",
    };
  }
  return {
    lifecycleStatus: null,
    correctionDetected: null,
    contentChanged: false,
    note: "unchanged",
  };
}

/**
 * Fetch and evaluate the origin's robots.txt for `rawUrl` against `userAgent`.
 * Fail-OPEN: any error (missing file, network failure, non-200) yields
 * `unknown`/allowed — robots.txt is advisory and a fetch failure must not be read
 * as a blanket ban. A 200 body that disallows the path yields `disallowed`.
 * SSRF-safe (same guard as article fetches).
 */
export async function checkRobots(rawUrl: string, userAgent = FETCH_UA): Promise<RobotsDecision> {
  let robotsUrl: string;
  let pathname: string;
  try {
    const u = new URL(rawUrl);
    robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
    pathname = u.pathname + u.search;
  } catch {
    return { status: "unknown", allowed: true, note: "unparseable URL; robots skipped" };
  }

  try {
    // Follow redirects MANUALLY, re-validating each hop against the SSRF guard —
    // a plain redirect:"follow" would let a hostile origin bounce the robots
    // request to an internal/private target (same policy as safeFetchHtml).
    let current = await assertPublicHttpUrl(robotsUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(current.toString(), {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": userAgent, accept: "text/plain,*/*" },
        });

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (!location || hop === MAX_REDIRECTS) {
            return { status: "unknown", allowed: true, note: "robots.txt redirect not followed; assuming allowed" };
          }
          current = await assertPublicHttpUrl(new URL(location, current).toString());
          continue;
        }

        if (res.status !== 200) {
          return { status: "unknown", allowed: true, note: `robots.txt HTTP ${res.status}; assuming allowed` };
        }
        const body = (await res.text()).slice(0, 512 * 1024); // 512 KB cap
        const parsed = parseRobotsTxt(body);
        const allowed = isPathAllowed(parsed, pathname, userAgent);
        return allowed
          ? { status: "allowed", allowed: true, note: "robots.txt allows this path" }
          : { status: "disallowed", allowed: false, note: "robots.txt disallows this path" };
      } finally {
        clearTimeout(timer);
      }
    }
    return { status: "unknown", allowed: true, note: "robots.txt fetch failed; assuming allowed" };
  } catch {
    return { status: "unknown", allowed: true, note: "robots.txt fetch failed; assuming allowed" };
  }
}

/**
 * Fetch + extract + quality-score a source URL. Uses Mozilla Readability over a
 * jsdom document to isolate the main article body, falling back to a stripped
 * body-text extraction when Readability finds nothing. Throws UnsafeUrlError for
 * SSRF-refused targets and FetchError for network/format failures. Never returns
 * partial garbage silently — a thin/failed extraction is reported via a low
 * score + flags so the caller can hold it out of embedding.
 */
export async function fetchAndExtract(rawUrl: string): Promise<ExtractedSource> {
  const { bytes, finalUrl, status, contentType } = await safeFetchBytes(rawUrl);

  // Route binary documents (PDF/DOCX/PPTX/…) to the document extractor; anything
  // else is treated as HTML below.
  const docType = detectDocumentType({ contentType, url: finalUrl, bytes });
  if (docType) {
    return extractFromDocumentBytes(bytes, { type: docType, url: finalUrl, httpStatus: status });
  }

  // Non-document, non-HTML payloads (images, video, archives) are unsupported —
  // reject explicitly rather than feeding binary bytes to the HTML parser.
  if (contentType && !/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
    throw new FetchError(`Unsupported content-type: ${contentType}`, status);
  }

  const html = bytes.toString("utf8");

  // Dynamic import so the heavy DOM libs load lazily (and stay externalized).
  const { JSDOM } = await import("jsdom");
  const { Readability } = await import("@mozilla/readability");

  const dom = new JSDOM(html, { url: finalUrl });
  const doc = dom.window.document;

  let title: string | null = null;
  let author: string | null = null;
  let excerpt: string | null = null;
  let text = "";
  let extractionMethod = "readability";

  try {
    const reader = new Readability(doc);
    const article = reader.parse();
    if (article && article.textContent && article.textContent.trim().length > 0) {
      title = article.title?.trim() || null;
      author = article.byline?.trim() || null;
      excerpt = article.excerpt?.trim() || null;
      text = article.textContent.replace(/\n{3,}/g, "\n\n").trim();
    }
  } catch {
    // Fall through to the boilerplate-stripped fallback below.
  }

  if (text.length === 0) {
    extractionMethod = "body_fallback";
    // Strip scripts/styles/nav/etc then take the remaining body text.
    doc.querySelectorAll("script,style,noscript,nav,header,footer,aside,form").forEach((el) => el.remove());
    text = (doc.body?.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    title = title ?? (doc.querySelector("title")?.textContent?.trim() || null);
  }

  // Published date from common meta tags.
  let publishedAt: Date | null = null;
  const metaDate =
    doc.querySelector('meta[property="article:published_time"]')?.getAttribute("content") ||
    doc.querySelector('meta[name="date"]')?.getAttribute("content") ||
    doc.querySelector("time[datetime]")?.getAttribute("datetime");
  if (metaDate) {
    const d = new Date(metaDate);
    if (!Number.isNaN(d.getTime())) publishedAt = d;
  }

  // Canonical URL (rel=canonical, else og:url), absolutized against finalUrl.
  let canonicalUrl: string | null = null;
  const rawCanonical =
    doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ||
    doc.querySelector('meta[property="og:url"]')?.getAttribute("content") ||
    null;
  // Reject client-side placeholder values (e.g. an unhydrated href="undefined")
  // before absolutizing, so they never resolve to junk like `.../undefined`.
  if (rawCanonical && !isJunkCanonicalHref(rawCanonical)) {
    try {
      const abs = new URL(rawCanonical, finalUrl).toString();
      if (abs !== finalUrl) canonicalUrl = abs;
    } catch {
      // ignore malformed canonical
    }
  }

  // Paywall / login-wall detection from meta hints + extracted text.
  const wordCount = countWords(text);
  const metaPaywall =
    doc.querySelector('meta[name="article:content_tier"]')?.getAttribute("content") === "locked" ||
    doc.querySelector('meta[property="article:content_tier"]')?.getAttribute("content") === "locked" ||
    !!doc.querySelector('[data-paywall], .paywall, #paywall, [class*="paywall"]');
  const access = detectAccessLimits({ text, wordCount, metaPaywall });

  const { score, flags } = scoreQuality({ title, text, rawHtmlLength: html.length });
  const notes = access.notes.length > 0 ? access.notes.join("; ") : null;

  return {
    finalUrl,
    domain: hostOf(finalUrl),
    httpStatus: status,
    title,
    author,
    excerpt,
    publishedAt,
    text,
    wordCount,
    extractionMethod,
    qualityScore: score,
    qualityFlags: flags,
    canonicalUrl,
    paywallDetected: access.paywallDetected,
    excerptOnly: access.excerptOnly,
    policyNotes: notes,
  };
}

/**
 * Build an ExtractedSource from a document's bytes (PDF/DOCX/PPTX/…). Shared by
 * the URL path (fetchAndExtract, when a fetch resolves to a document) and the
 * upload path (ingestUpload). Extracts text via the format-specific backend,
 * then runs the same quality scoring HTML sources use (rawHtmlLength=0, since
 * there is no surrounding markup). A parse failure throws DocumentExtractionError
 * (recorded as a failed source, never silently stored); an empty text result
 * scores low and is flagged, not thrown. `filename` seeds the title when the
 * document carries none.
 */
export async function extractFromDocumentBytes(
  bytes: Buffer,
  ctx: { type: DocumentType; url: string; filename?: string | null; httpStatus?: number },
): Promise<ExtractedSource> {
  const extraction = await extractDocumentText(new Uint8Array(bytes), ctx.type);
  const text = extraction.text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  const titleFromFile = ctx.filename ? ctx.filename.replace(/\.[a-z0-9]+$/i, "").trim() || null : null;
  const title = extraction.title ?? titleFromFile;

  const wordCount = countWords(text);
  const { score, flags } = scoreQuality({ title, text, rawHtmlLength: 0 });
  // Surface the extraction backend + document shape as a policy note.
  const notes = [`document (${ctx.type})`];
  if (extraction.pageCount != null) notes.push(`${extraction.pageCount} pages`);
  if (text.length === 0) notes.push("no extractable text (scanned or empty?)");

  const isUpload = ctx.url.startsWith("upload://");

  return {
    finalUrl: ctx.url,
    domain: isUpload ? "upload" : hostOf(ctx.url),
    httpStatus: ctx.httpStatus ?? 200,
    title,
    author: null,
    excerpt: null,
    publishedAt: null,
    text,
    wordCount,
    extractionMethod: extraction.extractionMethod,
    qualityScore: score,
    qualityFlags: flags,
    canonicalUrl: null,
    paywallDetected: false,
    excerptOnly: false,
    policyNotes: notes.join("; "),
  };
}

// Re-export for the orchestrator's SSRF pre-checks without a second import site.
export { assertPublicHttpUrl };
