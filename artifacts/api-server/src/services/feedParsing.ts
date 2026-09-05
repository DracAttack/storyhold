import { XMLParser } from "fast-xml-parser";

// --- RSS / Atom feed parsing (Task #227) --------------------------------
// A PURE parser: turns a feed's XML text into a normalized feed title + item
// list. No network, no DB, no logger, so it stays unit-testable in isolation
// (run with esbuild-bundle + node --test). Handles the two dominant formats —
// RSS 2.0 (<rss><channel><item>) and Atom (<feed><entry>) — plus RDF/RSS 1.0
// (<rdf:RDF><item>), which fast-xml-parser exposes the same way as RSS 2.0.

/** A single normalized feed item. */
export interface ParsedFeedItem {
  /** Stable per-item identity: the item's guid/id, falling back to its link. */
  dedupeKey: string;
  /** The article URL, when present (absolute http(s) expected). */
  url: string | null;
  /** The item headline, trimmed, when present. */
  title: string | null;
  /**
   * The item's description/summary text with HTML tags stripped, when present.
   * Used (with the title) as the haystack for a feed's optional keyword filter.
   */
  summary: string | null;
  /** Publication date parsed from pubDate / published / updated / dc:date. */
  publishedAt: Date | null;
}

/** The normalized result of parsing a feed document. */
export interface ParsedFeed {
  /** The feed's own <title>, when present. */
  title: string | null;
  items: ParsedFeedItem[];
}

/** Thrown when the payload isn't a parseable RSS/Atom/RDF feed. */
export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedParseError";
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  // Some feeds wrap values in CDATA; fast-xml-parser handles that transparently.
  processEntities: true,
});

/** Coerce fast-xml-parser's "maybe-array" shape into a real array. */
function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Pull the text out of a node that may be a string, number, or { "#text" }. */
function textOf(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === "string") return node.trim() || null;
  if (typeof node === "number") return String(node);
  if (typeof node === "object") {
    const rec = node as Record<string, unknown>;
    const t = rec["#text"];
    if (typeof t === "string") return t.trim() || null;
    if (typeof t === "number") return String(t);
  }
  return null;
}

/** Strip HTML tags + collapse whitespace so summary text is plain + matchable. */
function stripHtml(raw: string | null): string | null {
  if (!raw) return null;
  const text = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text : null;
}

/** Parse a date string into a Date, or null when absent/invalid. */
function parseDate(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Extract the link URL from an item. RSS uses a plain <link>text</link>; Atom
 * uses <link href="..."> and may carry several (alternate/self/…), so prefer
 * rel="alternate" (or no rel) with an http(s) href.
 */
function extractLink(item: Record<string, unknown>): string | null {
  const link = item["link"];

  // RSS: <link> is a plain string.
  const plain = textOf(link);
  if (plain && /^https?:\/\//i.test(plain)) return plain;

  // Atom: <link href="..." rel="..."> — possibly an array.
  const links = asArray(link).filter((l): l is Record<string, unknown> => typeof l === "object" && l !== null);
  if (links.length > 0) {
    const alternate = links.find((l) => {
      const rel = l["@_rel"];
      return rel === undefined || rel === "alternate";
    });
    const chosen = alternate ?? links[0]!;
    const href = chosen["@_href"];
    if (typeof href === "string" && /^https?:\/\//i.test(href.trim())) return href.trim();
  }

  return null;
}

/** Build the stable dedupe key for an item: guid/id, else the link URL. */
function itemDedupeKey(item: Record<string, unknown>, url: string | null): string | null {
  // RSS <guid> (may be an object with #text + isPermaLink attr) or Atom <id>.
  const guid = textOf(item["guid"]) ?? textOf(item["id"]);
  if (guid) return guid;
  return url;
}

/** Normalize one raw item/entry object into a ParsedFeedItem, or null if unusable. */
function normalizeItem(raw: unknown): ParsedFeedItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Record<string, unknown>;

  const url = extractLink(item);
  const dedupeKey = itemDedupeKey(item, url);
  // An item with neither a guid/id nor a link can't be deduped or fetched.
  if (!dedupeKey) return null;

  const title = textOf(item["title"]);
  // Description/summary text for the optional keyword filter. RSS uses
  // <description>; Atom uses <summary> (and sometimes <content>); some feeds
  // carry the richer <content:encoded>. All may contain HTML, so strip it.
  const summary = stripHtml(
    textOf(item["description"]) ??
      textOf(item["summary"]) ??
      textOf(item["content:encoded"]) ??
      textOf(item["content"]),
  );
  const publishedAt = parseDate(
    textOf(item["pubDate"]) ??
      textOf(item["published"]) ??
      textOf(item["updated"]) ??
      textOf(item["dc:date"]) ??
      textOf(item["date"]),
  );

  return { dedupeKey, url, title, summary, publishedAt };
}

/**
 * Parse an RSS 2.0 / Atom / RDF feed document into a normalized title + items.
 * Throws {@link FeedParseError} when the payload has no recognizable feed root
 * or is not valid XML. Individual malformed items are skipped, not fatal.
 */
export function parseFeed(xml: string): ParsedFeed {
  if (!xml || xml.trim().length === 0) {
    throw new FeedParseError("Empty feed body");
  }

  let root: Record<string, unknown>;
  try {
    root = parser.parse(xml) as Record<string, unknown>;
  } catch (err) {
    throw new FeedParseError(`Not valid XML: ${(err as Error).message}`);
  }

  // RSS 2.0: <rss><channel><item>*</channel></rss>
  const rss = root["rss"] as Record<string, unknown> | undefined;
  if (rss && typeof rss === "object") {
    const channel = rss["channel"] as Record<string, unknown> | undefined;
    if (channel && typeof channel === "object") {
      const items = asArray(channel["item"])
        .map(normalizeItem)
        .filter((i): i is ParsedFeedItem => i !== null);
      return { title: textOf(channel["title"]), items };
    }
  }

  // RDF / RSS 1.0: <rdf:RDF><channel/><item>*</rdf:RDF>
  const rdf = (root["rdf:RDF"] ?? root["RDF"]) as Record<string, unknown> | undefined;
  if (rdf && typeof rdf === "object") {
    const channel = rdf["channel"] as Record<string, unknown> | undefined;
    const items = asArray(rdf["item"])
      .map(normalizeItem)
      .filter((i): i is ParsedFeedItem => i !== null);
    return { title: channel ? textOf(channel["title"]) : null, items };
  }

  // Atom: <feed><entry>*</feed>
  const feed = root["feed"] as Record<string, unknown> | undefined;
  if (feed && typeof feed === "object") {
    const items = asArray(feed["entry"])
      .map(normalizeItem)
      .filter((i): i is ParsedFeedItem => i !== null);
    return { title: textOf(feed["title"]), items };
  }

  throw new FeedParseError("No RSS <channel>, Atom <feed>, or RDF root found");
}
