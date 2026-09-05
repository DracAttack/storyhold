// --- Ingest guards: junk URLs and hub/section pages ------------------------
//
// Two related defenses against feed floods polluting the Source Vault and the
// story-cluster graph, both born from real production incidents:
//
// 1. `isJunkIngestUrl` — some feeds emit URLs that are not articles at all and
//    can NEVER extract: the CDC MMWR feed emits `tools.cdc.gov/api/embed/
//    downloader/download.asp?...` media-download endpoints (891 failed vault
//    rows in one week), and model output occasionally slips search-engine
//    result URLs through. Rejecting them at ENQUEUE time saves the fetch
//    attempt, the retry loop, and the permanent junk row.
//
// 2. `isHubPage` — section fronts and index pages ("Entertainment & Arts |
//    Latest News & Updates | BBC News", "Research Guides: Popular Culture:
//    Introduction") are link-lists, not stories. Their generic titles become
//    cluster labels and their ever-changing headline soup false-merges
//    unrelated stories into one giant cluster that burns editorial-screening
//    calls forever (82 packets in 30 days on one BBC section page). Hub pages
//    are kept in the vault (they can still be background context) but are
//    EXCLUDED from clustering, cluster labels, and cluster keywords.
//
// Both predicates are pure, deterministic, and deliberately conservative:
// a false positive here silently drops a real story, so every pattern must be
// tied to a concrete observed junk shape.

/** URL shapes that are never ingestible articles. Reject at enqueue. */
const JUNK_URL_RES: RegExp[] = [
  // CDC media/embed API endpoints (podcast/media downloaders, not pages).
  /^https?:\/\/tools\.cdc\.gov\/api\//i,
  // Classic ASP download endpoints anywhere (always a binary/media payload).
  /\/download\.asp\b/i,
  // Search-engine result pages (Scholar, Google, Bing, DuckDuckGo). These are
  // query result lists, not sources; the citation pipeline already fast-rejects
  // them elsewhere — this closes the ingest-queue door too.
  /^https?:\/\/scholar\.google\./i,
  /^https?:\/\/(?:www\.)?google\.[a-z.]+\/search\b/i,
  /^https?:\/\/(?:www\.)?bing\.com\/search\b/i,
  /^https?:\/\/(?:html\.)?duckduckgo\.com\/(?:html\/?)?\?/i,
  // SciSpace (scispace.com) is an intermediary aggregator that copies paper
  // metadata from primary journals. Its URLs append internal IDs to paper
  // titles (e.g. "...1dfwms5euz"), corrupting citation display. Reject at
  // enqueue so the pipeline prefers the original journal source.
  /^https?:\/\/(?:www\.)?scispace\.com\//i,
  // Raw feed documents — the feed watcher polls feeds; feed URLs themselves
  // must never be ingested as articles.
  /\.(?:rss|atom)$/i,
  /\/(?:rss|feed)\/?$/i,
];

/** True when a URL can never be a real article and must not be enqueued. */
export function isJunkIngestUrl(url: string | null | undefined): boolean {
  const u = (url ?? "").trim();
  if (!u) return false;
  return JUNK_URL_RES.some((re) => re.test(u));
}

// Title shapes of section fronts / index / hub pages. Every pattern is tied to
// an observed production label. Kept tight: real article headlines must never
// match ("BBC News" suffixes alone are NOT enough — real stories carry them).
const HUB_TITLE_RES: RegExp[] = [
  // "Entertainment & Arts | Latest News & Updates | BBC News"
  /\blatest\s+news\s*(?:&|and)\s*updates?\b/i,
  // "Pop Culture News: Updates on Music, Movies, TV and Celebrities"
  /\bnews:\s*updates?\s+on\b/i,
  // "Research Guides: Popular Culture: Introduction" (library LibGuides hubs)
  /^research\s+guides?\s*:/i,
  // "Breaking News, Latest News and Videos | CNN" style section chrome
  /\bbreaking\s+news,?\s+latest\s+news\b/i,
  // Explicit index/landing self-descriptions
  /\b(?:news|topic|category|section)\s+(?:index|archive|landing)\b/i,
];

// URL path shapes that are section fronts rather than stories: a bare section
// path with no article slug. Only obvious, unambiguous shapes.
const HUB_URL_RES: RegExp[] = [
  // Bare section fronts: /news, /sport, /entertainment_and_arts … (no slug
  // after the section segment). Article URLs always carry a further segment.
  /^https?:\/\/[^/]+\/(?:news|sport|business|entertainment(?:_and_arts)?|culture|topics?)\/?$/i,
  // Category/tag/topic listing pages.
  /\/(?:category|categories|tag|tags)\/[^/]+\/?$/i,
  // LibGuides hub roots (guides.<school>.edu/c.php?g=…)
  /^https?:\/\/guides\.[^/]+\/c\.php\b/i,
];

/** The fields hub detection reads (subset of SourceDocument). */
export interface HubPageLike {
  url: string | null;
  title: string | null;
  leadSnippet?: string | null;
}

/**
 * True when a source document is a hub/section/index page rather than a story.
 * Hub pages stay in the vault but must be excluded from clustering, cluster
 * labels, and cluster keywords.
 */
export function isHubPage(doc: HubPageLike): boolean {
  const title = (doc.title ?? "").trim();
  if (title && HUB_TITLE_RES.some((re) => re.test(title))) return true;
  // The RSS item headline can also carry the hub title (feed-ingested docs
  // whose Readability title is null fall back to it for labels).
  const lead = (doc.leadSnippet ?? "").trim();
  if (lead && HUB_TITLE_RES.some((re) => re.test(lead))) return true;
  const url = (doc.url ?? "").trim();
  if (url && HUB_URL_RES.some((re) => re.test(url))) return true;
  return false;
}
