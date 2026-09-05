import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ArticleBlock } from "@workspace/db";

/**
 * External (http/https) Markdown links — i.e. source citations, NOT internal
 * /article/ links (those are handled by sanitizeInternalLinks in articles.ts).
 */
const EXTERNAL_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

/**
 * Raw model citation markup — an opening `<cite index="29-2">` (any attributes)
 * or a closing `</cite>`. The web-search-enabled draft model sometimes wraps
 * cited spans in these tags instead of the instructed Markdown links; rendered
 * verbatim they show up as literal tag soup in the prose.
 */
const CITE_TAG_RE = /<\/?cite\b[^>]*>/gi;

/**
 * Strip raw `<cite …>…</cite>` citation tags from a single string, keeping the
 * wrapped text. Pure/synchronous — no network, no logging. Returns the cleaned
 * text plus how many tags were removed. Any doubled spaces a removal leaves
 * behind are collapsed so the prose reads cleanly.
 */
export function stripCiteTagsFromText(text: string): { text: string; stripped: number } {
  const matches = text.match(CITE_TAG_RE);
  if (!matches) return { text, stripped: 0 };
  const cleaned = text.replace(CITE_TAG_RE, "").replace(/ {2,}/g, " ");
  return { text: cleaned, stripped: matches.length };
}

/**
 * Strip raw `<cite>` citation tags from every string-content block of an article
 * body, keeping the wrapped prose. Non-string blocks are passed through. Returns
 * the cleaned body plus the total number of tags removed. Pure/synchronous.
 */
export function stripCitationTags(body: ArticleBlock[]): { body: ArticleBlock[]; stripped: number } {
  let stripped = 0;
  const cleaned = body.map((block): ArticleBlock => {
    const content = "content" in block && typeof block.content === "string" ? block.content : null;
    if (!content) return block;
    const r = stripCiteTagsFromText(content);
    if (r.stripped === 0) return block;
    stripped += r.stripped;
    return { ...block, content: r.text } as ArticleBlock;
  });
  return { body: cleaned, stripped };
}

/**
 * Internal newsroom vocabulary that must NEVER appear in reader-facing prose.
 * Packet-grounded drafts are briefed with a "vetted evidence packet" pulled
 * from the Source Vault, and the draft model has slipped phrases like "the
 * evidence packet" into article text — a leak of internal tooling.
 *
 * Two tiers, because "evidence packet" is ALSO legitimate courtroom/crime
 * vocabulary (prosecutors hand juries evidence packets) and this magazine
 * covers crime beats:
 *  - ALWAYS rewritten: phrases that only exist in our internal briefing
 *    ("vetted/grounding/editorial evidence packet", "Source Vault").
 *  - `packetGrounded` ONLY: the bare "evidence packet(s)" — on a draft that
 *    was actually briefed with a packet, a bare mention is a leak; on any
 *    other text it is presumed legitimate journalism and left alone.
 *
 * Replacements preserve a leading capital and grammatical number (singular
 * "packet" → "the available evidence", plural "packets" → "the available
 * sources") so surrounding verbs still agree.
 */
const SOURCE_VAULT_RE = /\b(?:(?:the|our)\s+)?source\s+vault\b/gi;
const INTERNAL_PACKET_RE = /\b(?:(?:the|this|our|its|a)\s+)?(?:vetted|grounding|editorial)\s+evidence\s+(packets?)\b/gi;
const BARE_PACKET_RE = /\b(?:(?:the|this|our|its|a)\s+)?evidence\s+(packets?)\b/gi;

export type ScrubVocabOptions = {
  /**
   * True when the text came from a draft that was briefed with an evidence
   * packet — enables rewriting the bare "evidence packet(s)" too.
   */
  packetGrounded?: boolean;
};

function matchCase(match: string, replacement: string): string {
  const first = match.charAt(0);
  const capitalize = first === first.toUpperCase() && first !== first.toLowerCase();
  return capitalize ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;
}

function packetReplacement(packetWord: string): string {
  return packetWord.toLowerCase() === "packets" ? "the available sources" : "the available evidence";
}

/**
 * Rewrite internal-tooling vocabulary in a single string to reader-safe
 * equivalents. Pure/synchronous — no network, no logging. Returns the cleaned
 * text plus how many phrases were rewritten.
 */
export function scrubInternalVocabFromText(
  text: string,
  opts: ScrubVocabOptions = {},
): { text: string; scrubbed: number } {
  let scrubbed = 0;
  SOURCE_VAULT_RE.lastIndex = 0;
  let out = text.replace(SOURCE_VAULT_RE, (match) => {
    scrubbed += 1;
    return matchCase(match, "the source record");
  });
  const packetRules = opts.packetGrounded ? [INTERNAL_PACKET_RE, BARE_PACKET_RE] : [INTERNAL_PACKET_RE];
  for (const re of packetRules) {
    re.lastIndex = 0;
    out = out.replace(re, (match, packetWord: string) => {
      scrubbed += 1;
      return matchCase(match, packetReplacement(packetWord));
    });
  }
  return { text: out, scrubbed };
}

/**
 * Apply {@link scrubInternalVocabFromText} to every string-content block of an
 * article body. Non-string blocks pass through. Pure/synchronous.
 */
export function scrubInternalVocabulary(
  body: ArticleBlock[],
  opts: ScrubVocabOptions = {},
): { body: ArticleBlock[]; scrubbed: number } {
  let scrubbed = 0;
  const cleaned = body.map((block): ArticleBlock => {
    const content = "content" in block && typeof block.content === "string" ? block.content : null;
    if (!content) return block;
    const r = scrubInternalVocabFromText(content, opts);
    if (r.scrubbed === 0) return block;
    scrubbed += r.scrubbed;
    return { ...block, content: r.text } as ArticleBlock;
  });
  return { body: cleaned, scrubbed };
}

const CITATION_FETCH_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const CITATION_FETCH_TIMEOUT_MS = 7000;

/**
 * True for unfalsifiable *search-query* URLs — a query the writer composed
 * (Google Scholar / Google / Bing / DuckDuckGo results pages), not a specific
 * source. These get stripped: a search query is not a citation.
 */
export function isSearchQueryUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const path = u.pathname.toLowerCase();
  const hasQuery =
    u.searchParams.has("q") || u.searchParams.has("query") || u.searchParams.has("search_query");
  if (host.includes("scholar.google")) return true; // any Scholar results page
  const isSearchEngine =
    /(^|\.)google\.[a-z.]+$/.test(host) ||
    host === "bing.com" ||
    host.endsWith(".bing.com") ||
    host === "duckduckgo.com" ||
    host === "search.brave.com" ||
    host === "search.yahoo.com";
  if (isSearchEngine && (path.startsWith("/search") || path.startsWith("/scholar") || hasQuery)) {
    return true;
  }
  return false;
}

/**
 * SSRF guard: true if an IP literal is loopback, private, link-local, CGNAT, or
 * otherwise reserved — a target the server must never fetch. Covers the cloud
 * metadata endpoint (169.254.169.254) and IPv4-mapped IPv6 forms.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (fam === 6) {
    const lc = ip.toLowerCase();
    if (lc === "::1" || lc === "::") return true;
    if (lc.startsWith("fe80")) return true; // link-local
    if (lc.startsWith("fc") || lc.startsWith("fd")) return true; // unique-local
    const mapped = lc.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPrivateOrReservedIp(mapped[1]!);
    return false;
  }
  return false;
}

/**
 * Best-effort "should this anchor be removed?" check for a specific-source
 * citation URL. Returns true when the link must be UNLINKED — either because it
 * is confidently DEAD (host does not resolve / page returns 404/410) OR because
 * it points at an internal/private target a citation must never reference
 * (localhost, *.internal/*.local hosts, IP literals, or any hostname that
 * resolves to a private/reserved address). Everything else (2xx/3xx, 401/403/
 * 429/5xx, timeouts, connection/TLS errors, transient DNS failures) is treated
 * as ALIVE so a real citation is never stripped by a transient hiccup or a
 * publisher bot-wall. Never throws.
 *
 * SSRF-hardened: only http(s) is probed, internal hostnames are never fetched,
 * the host is DNS-resolved up front and refused (and stripped) if it maps to any
 * private/reserved address, and redirects are NOT followed (a 3xx already proves
 * the resource exists, and following could be redirected to an internal host).
 */
export async function citationUrlIsDead(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    return true; // internal hostname: never a valid citation → strip the anchor
  }

  // Resolve first and refuse private/reserved targets (SSRF guard). A genuine
  // NXDOMAIN means the host doesn't exist → the citation is dead.
  let addresses: { address: string }[];
  if (isIP(host)) {
    addresses = [{ address: host }];
  } else {
    try {
      addresses = await lookup(host, { all: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOTFOUND" || code === "EAI_NONAME" || code === "EAI_NODATA") return true;
      return false; // transient DNS error → inconclusive, keep the link
    }
  }
  if (addresses.length === 0) return true;
  // A host that resolves to a private/reserved address is never a real citation
  // and must never be fetched (SSRF) → strip the anchor.
  if (addresses.some((a) => isPrivateOrReservedIp(a.address))) return true;
  // NOTE: a DNS-rebinding TOCTOU window remains between this lookup and fetch's
  // own connect-time resolution. Acceptable here (internal draft-time check,
  // private-IP refusal, no redirect following); full closure would require
  // connect-time IP pinning (custom undici dispatcher) or a domain allowlist.

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CITATION_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": CITATION_FETCH_UA, accept: "text/html,application/xhtml+xml,*/*" },
    });
    return res.status === 404 || res.status === 410;
  } catch {
    // Timeout / connection reset / TLS error → inconclusive → keep the link.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Positive liveness check for a SOURCE-link backfill candidate. Returns true
 * ONLY when we have high confidence the URL points at a real, reachable page —
 * the inverse philosophy of {@link citationUrlIsDead}: there we keep a link
 * unless it is *confidently dead*; here we INSERT a brand-new link only when it
 * is *confidently alive*, so a transient hiccup means "skip", never "fabricate".
 *
 * Reachable means: https (we require TLS for inserted sources), the host
 * DNS-resolves to a public (non-private/reserved) address, and a GET returns a
 * status that proves the resource exists — any 2xx/3xx, or a 401/403/405/429
 * (publisher bot-walls that still confirm the path exists). A 404/410, NXDOMAIN,
 * timeout, connection/TLS error, or a host that resolves only to internal IPs
 * all return false (skip the insertion). Never throws.
 *
 * SSRF-hardened identically to {@link citationUrlIsDead}: only https is probed,
 * internal hostnames are refused, the host is resolved up front and rejected if
 * it maps to any private/reserved address, and redirects are NOT followed.
 */
export async function sourceUrlIsReachable(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // Inserted source citations must be https — no http, no other schemes.
  if (parsed.protocol !== "https:") return false;
  // A search-query results page is not a citable source.
  if (isSearchQueryUrl(url)) return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    return false;
  }

  let addresses: { address: string }[];
  if (isIP(host)) {
    addresses = [{ address: host }];
  } else {
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      return false; // NXDOMAIN or transient DNS error → not confidently reachable
    }
  }
  if (addresses.length === 0) return false;
  if (addresses.some((a) => isPrivateOrReservedIp(a.address))) return false; // refuse internal hosts

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CITATION_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": CITATION_FETCH_UA, accept: "text/html,application/xhtml+xml,*/*" },
    });
    if (res.status === 404 || res.status === 410) return false;
    // 2xx/3xx (resource exists / redirects) and common bot-wall statuses
    // (401/403/405/429) all prove the path is real. Other 4xx/5xx → skip.
    if (res.status >= 200 && res.status < 400) return true;
    return res.status === 401 || res.status === 403 || res.status === 405 || res.status === 429;
  } catch {
    return false; // timeout / connection reset / TLS error → not confidently reachable
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Citation safety net for freshly generated drafts. Over external (http/https)
 * Markdown links in paragraph blocks:
 *  1) strip unfalsifiable search-query "citations" (Scholar/Google/Bing results
 *     pages) — a known low-quality / scaled-AI-content signal; and
 *  2) verify each remaining specific-source link actually resolves, unlinking any
 *     that are confidently dead (fabricated URLs).
 * The visible phrase is always preserved — only the broken anchor is removed — so
 * prose is never lost. Internal /article/ links are left untouched here.
 *
 * Returns the cleaned body plus counts of what was removed; the caller logs
 * (this module stays logger-free so it's unit-testable in isolation).
 */
export async function sanitizeCitations(
  body: ArticleBlock[],
): Promise<{ body: ArticleBlock[]; strippedSearch: number; strippedDead: number }> {
  const toVerify = new Set<string>();
  for (const block of body) {
    if (block.type !== "paragraph" || typeof block.content !== "string") continue;
    EXTERNAL_LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EXTERNAL_LINK_RE.exec(block.content)) !== null) {
      const url = m[2]!;
      if (!isSearchQueryUrl(url)) toVerify.add(url);
    }
  }

  const dead = new Set<string>();
  await Promise.all(
    Array.from(toVerify).map(async (url) => {
      try {
        if (await citationUrlIsDead(url)) dead.add(url);
      } catch {
        // keep the link on any unexpected error
      }
    }),
  );

  let strippedSearch = 0;
  let strippedDead = 0;
  const cleaned = body.map((block) => {
    if (block.type !== "paragraph" || typeof block.content !== "string") return block;
    const content = block.content.replace(EXTERNAL_LINK_RE, (full, phrase: string, url: string) => {
      if (isSearchQueryUrl(url)) {
        strippedSearch += 1;
        return phrase;
      }
      if (dead.has(url)) {
        strippedDead += 1;
        return phrase;
      }
      return full;
    });
    return content === block.content ? block : { ...block, content };
  });

  return { body: cleaned, strippedSearch, strippedDead };
}
