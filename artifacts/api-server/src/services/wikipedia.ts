import { db, conceptsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { enqueueUrl } from "./sourceIngestQueue";

// ---------------------------------------------------------------------------
// Wikipedia API helpers
// ---------------------------------------------------------------------------
// Uses the official MediaWiki REST API and Action API directly — never Perplexity
// web search for content that is available here for free. All content retrieval
// goes through these endpoints.
//
// REST API  (https://en.wikipedia.org/w/rest.php/v1/…)  — lightweight, fast,
//   preferred for search and summaries.
// Action API (https://en.wikipedia.org/w/api.php?action=…) — used for redirect
//   resolution and full introductory text where the REST summary is too short.

const REST_BASE = "https://en.wikipedia.org/w/rest.php/v1";
const ACTION_BASE = "https://en.wikipedia.org/w/api.php";
const FETCH_TIMEOUT_MS = 8_000;

const WIKI_HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "BrainHook-ConceptExplainer/1.0 (https://brainhook.net; editorial@brainhook.net)",
};

async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: WIKI_HEADERS, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One search result from the MediaWiki REST search endpoint. */
export interface WikipediaCandidate {
  /** Stable page key, e.g. "Cognitive_dissonance" (for use in other API calls) */
  key: string;
  /** Display title */
  title: string;
  /** Short description (one phrase, often from Wikidata) */
  description: string;
  /** Brief excerpt from the page */
  excerpt: string;
}

/** Full page data retrieved via the REST summary endpoint + redirect-resolved key. */
export interface WikipediaPage {
  pageId: number;
  key: string;
  title: string;
  /** Redirected-to canonical page key (same as key when no redirect occurred). */
  canonicalKey: string;
  /** First ~1,000 chars of the page extract — used as grounding for definitions. */
  extract: string;
  /** Canonical desktop URL */
  url: string;
  /** Wikipedia revision ID at time of retrieval — used to detect later changes. */
  revId?: number;
}

// ---------------------------------------------------------------------------
// Step 2 — Search for candidate pages
// ---------------------------------------------------------------------------

/**
 * Search the Wikipedia REST API for up to `limit` candidate pages matching
 * `term`. Returns an empty array if the search fails or yields nothing.
 * Caller (Step 3) hands these to Perplexity to pick the best match.
 */
export async function searchWikipediaCandidates(
  term: string,
  limit = 5,
): Promise<WikipediaCandidate[]> {
  try {
    const url = `${REST_BASE}/search/page?q=${encodeURIComponent(term)}&limit=${limit}`;
    const resp = await fetchWithTimeout(url);
    if (!resp.ok) {
      logger.warn({ term, status: resp.status }, "wikipedia: candidate search failed");
      return [];
    }
    const data = (await resp.json()) as { pages?: Array<{
      key: string;
      title: string;
      description?: string;
      excerpt?: string;
    }> };
    return (data.pages ?? []).map((p) => ({
      key: p.key,
      title: p.title,
      description: (p.description ?? "").trim(),
      excerpt: (p.excerpt ?? "").trim().slice(0, 300),
    }));
  } catch (err) {
    logger.warn({ err, term }, "wikipedia: candidate search error");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Step 4 — Retrieve and resolve a selected page
// ---------------------------------------------------------------------------

/**
 * Resolve redirect chains for a Wikipedia page key via the Action API.
 * Returns the canonical (redirect-resolved) page key, or `key` when no redirect
 * is needed. Falls back to the input key on any network error.
 */
async function resolveRedirect(key: string): Promise<string> {
  try {
    const url =
      `${ACTION_BASE}?action=query&redirects=1&titles=${encodeURIComponent(key.replace(/_/g, " "))}` +
      `&format=json&formatversion=2`;
    const resp = await fetchWithTimeout(url);
    if (!resp.ok) return key;
    const data = (await resp.json()) as {
      query?: {
        redirects?: Array<{ from: string; to: string }>;
        pages?: Array<{ title: string }>;
      };
    };
    const pages = data.query?.pages ?? [];
    if (pages.length > 0 && pages[0]?.title) {
      // Normalise back to underscore-key form
      return pages[0].title.replace(/ /g, "_");
    }
    return key;
  } catch {
    return key;
  }
}

/**
 * Fetch the full page summary (extract, pageId, revId, canonical URL) for a
 * Wikipedia page key. Resolves any redirect first. Returns null on failure.
 *
 * This is Step 4 of the concept pipeline — called after Perplexity has chosen
 * the best candidate from the list returned by `searchWikipediaCandidates`.
 */
export async function fetchWikipediaPage(key: string): Promise<WikipediaPage | null> {
  try {
    const canonicalKey = await resolveRedirect(key);
    const summaryUrl = `${REST_BASE}/page/summary/${encodeURIComponent(canonicalKey)}`;
    const resp = await fetchWithTimeout(summaryUrl);
    if (!resp.ok) {
      logger.warn({ key, canonicalKey, status: resp.status }, "wikipedia: page fetch failed");
      return null;
    }
    const data = (await resp.json()) as {
      page_id?: number;
      title?: string;
      extract?: string;
      content_urls?: { desktop?: { page?: string } };
      revision_id?: number;
    };

    const extract = (data.extract ?? "").trim();
    if (extract.length < 20) {
      logger.debug({ key }, "wikipedia: page extract too short, skipping");
      return null;
    }

    const url =
      data.content_urls?.desktop?.page ??
      `https://en.wikipedia.org/wiki/${encodeURIComponent(canonicalKey)}`;

    return {
      pageId: data.page_id ?? 0,
      key,
      canonicalKey,
      title: data.title ?? key.replace(/_/g, " "),
      // Truncate extract to 1,000 chars — enough to cover the lead paragraph
      // for grounding without ballooning the prompt.
      extract: extract.slice(0, 1_000),
      url,
      revId: data.revision_id,
    };
  } catch (err) {
    logger.warn({ err, key }, "wikipedia: fetchWikipediaPage error");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Convenience: resolve top-1 match without disambiguation (used by admin regen)
// ---------------------------------------------------------------------------

/**
 * Quick single-term lookup — search + resolve in one call. Returns the top
 * matching page or null. Used for admin-triggered concept regen where we skip
 * the Perplexity disambiguation step for speed.
 */
export async function resolveWikipedia(term: string): Promise<WikipediaPage | null> {
  const candidates = await searchWikipediaCandidates(term, 3);
  if (candidates.length === 0) return null;

  // Prefer an exact title/key match (case-insensitive) before falling back to
  // position-1.
  const lower = term.toLowerCase();
  const best =
    candidates.find((c) => c.title.toLowerCase() === lower) ??
    candidates.find((c) => c.key.toLowerCase().replace(/_/g, " ") === lower) ??
    candidates[0];

  if (!best) return null;
  return fetchWikipediaPage(best.key);
}

// ---------------------------------------------------------------------------
// Source Vault enqueue
// ---------------------------------------------------------------------------

/**
 * Ingest a resolved Wikipedia page into the Source Vault as reference context
 * for a glossary concept — deduped by Wikipedia page ID and refreshed only on
 * revision change:
 *
 * - If any concept already recorded this page ID at the SAME revision, the
 *   page is already in the vault and up to date → no-op (page-ID dedupe).
 * - Otherwise the URL is enqueued with `discoveredVia: "wikipedia_concept"`
 *   (reference-context source typing; the authority classifier maps Wikipedia
 *   to the background-only "reference" tier) and `reviveTerminal: true` so a
 *   previously ingested (`done`) queue row is revived to re-ingest the new
 *   revision. All concepts sharing the page ID get their stored `wikiRevId`
 *   stamped to the ingested revision.
 *
 * Fire-and-forget — the vault drain picks the row up on the next cron tick.
 * Never throws; concept creation is never blocked.
 */
export async function enqueueWikipediaInVault(
  page: WikipediaPage,
  conceptTerm: string,
): Promise<void> {
  try {
    const hasPageIdentity = page.pageId > 0 && typeof page.revId === "number";
    if (hasPageIdentity) {
      const [known] = await db
        .select({ wikiRevId: conceptsTable.wikiRevId })
        .from(conceptsTable)
        .where(eq(conceptsTable.wikiPageId, page.pageId))
        .limit(1);
      if (known && known.wikiRevId === page.revId) {
        logger.debug(
          { pageId: page.pageId, revId: page.revId, url: page.url },
          "wikipedia: vault ingest skipped — page already ingested at this revision",
        );
        return;
      }
    }
    await enqueueUrl(page.url, {
      discoveredVia: "wikipedia_concept",
      leadSnippet: `Wikipedia reference context grounding concept: "${conceptTerm}"`,
      // Revive a done/failed queue row so a revision change re-ingests the page.
      reviveTerminal: true,
    });
    if (hasPageIdentity) {
      // Stamp the ingested revision on every concept sharing this page so the
      // dedupe check above holds for subsequent concepts/reprocessing runs.
      await db
        .update(conceptsTable)
        .set({ wikiRevId: page.revId })
        .where(eq(conceptsTable.wikiPageId, page.pageId));
    }
  } catch (err) {
    // Vault enqueue is optional — the URL may already exist or the vault may
    // not be configured. Log and continue; concept creation is never blocked.
    logger.debug({ err, url: page.url }, "wikipedia: vault enqueue skipped or failed");
  }
}
