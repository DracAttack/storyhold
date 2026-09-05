import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  db,
  sourceFeedsTable,
  sourceFeedItemsTable,
  type SourceFeed,
  type FeedPurpose,
} from "@workspace/db";
import { and, asc, eq, isNull, lte, or, sql, desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { isPrivateOrReservedIp } from "./citations";
import { parseFeed, type ParsedFeedItem } from "./feedParsing";
import { feedItemPassesFilter } from "./feedItemFilter";
import { resolveGovInfoContentUrl, titleFromGovInfoPkgId } from "./govinfoResolve";
import { classifySourceRole } from "./sourceAuthority";
import { recordMarker, recordRejected } from "./trendMarkers";
import { enqueueUrl } from "./sourceIngestQueue";
import { isSourceVaultEnabled } from "./sourceVaultBudget";

// --- Known Source Watcher (Task #227) -----------------------------------
// Polls admin-registered RSS/Atom feeds and refills the Source Vault from them
// FIRST (Perplexity is the gap-filler in sourceDiscovery). Each poll does a
// conditional GET (ETag / Last-Modified → 304 when unchanged), parses items,
// filters them through the SAME source-authority rules discovery uses, dedupes
// against what the feed has already seen (source_feed_items), and enqueues NEW,
// discoverable items to the existing ingest queue tagged discoveredVia=
// "known_source" + beatSlug so they cluster as observations. Never re-ingests a
// URL already handled (enqueue with reviveTerminal:false). Never throws — a bad
// feed records its own error + backoff and the pass moves on.

// Some publishers (e.g. Cloudflare-fronted sites) return 403 to any User-Agent
// that self-identifies as a bot, but serve their PUBLIC RSS fine to a normal
// browser UA. Feeds are meant to be read by aggregators, so present as a
// mainstream browser to avoid blanket bot blocks while still being a plain GET.
const FETCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — feeds are small; cap hostile bodies.
const MAX_REDIRECTS = 4;
// How many due feeds a single poll pass will process, so one tick stays quick.
const MAX_FEEDS_PER_PASS = 10;
// How many NEW items a single feed poll will enqueue, so one bursty feed can't
// flood the ingest queue in one pass.
const MAX_ITEMS_PER_FEED = 25;
// Exponential backoff cap for a repeatedly-failing feed (minutes), so a dead
// feed is retried at most this often regardless of its configured interval.
const MAX_BACKOFF_MINUTES = 6 * 60;

/** Thrown when a feed URL must never be fetched (SSRF) or is malformed. */
class UnsafeFeedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeFeedUrlError";
  }
}

/**
 * Validate a URL is a public http(s) target safe to fetch (rejects non-http(s),
 * internal hostnames, and hosts resolving to private/reserved addresses). Same
 * SSRF policy the vault fetch uses; feeds are admin-controlled but still fetched
 * server-side, so the guard stays.
 */
async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeFeedUrlError(`Not a valid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeFeedUrlError(`Refusing non-http(s) URL: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new UnsafeFeedUrlError(`Refusing internal hostname: ${host}`);
  }
  let addresses: { address: string }[];
  if (isIP(host)) {
    addresses = [{ address: host }];
  } else {
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      throw new UnsafeFeedUrlError(`Host does not resolve: ${host}`);
    }
  }
  if (addresses.length === 0) throw new UnsafeFeedUrlError(`Host does not resolve: ${host}`);
  if (addresses.some((a) => isPrivateOrReservedIp(a.address))) {
    throw new UnsafeFeedUrlError(`Host resolves to a private/reserved address: ${host}`);
  }
  return parsed;
}

/** Outcome of a conditional GET against a feed URL. */
interface FeedFetchResult {
  /** 304 = unchanged (nothing to parse); 200 = body present. */
  notModified: boolean;
  body: string;
  etag: string | null;
  lastModified: string | null;
  httpStatus: number;
}

/**
 * Conditional GET of a feed URL. Sends If-None-Match / If-Modified-Since when we
 * hold an ETag / Last-Modified so an unchanged feed answers 304 (cheap). Follows
 * redirects MANUALLY, re-validating each hop against the SSRF guard. Caps size +
 * time. Throws on network/HTTP failure so the caller records feed health.
 */
async function conditionalGet(
  rawUrl: string,
  prior: { etag: string | null; lastModified: string | null },
): Promise<FeedFetchResult> {
  let current = await assertPublicHttpUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        "user-agent": FETCH_UA,
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      };
      if (prior.etag) headers["if-none-match"] = prior.etag;
      if (prior.lastModified) headers["if-modified-since"] = prior.lastModified;

      const res = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers,
      });

      if (res.status === 304) {
        return { notModified: true, body: "", etag: prior.etag, lastModified: prior.lastModified, httpStatus: 304 };
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) throw new Error(`Redirect with no Location header (HTTP ${res.status})`);
        if (hop === MAX_REDIRECTS) throw new Error("Too many redirects");
        current = await assertPublicHttpUrl(new URL(location, current).toString());
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Feed returned HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("Empty response body");
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          if (total > MAX_BYTES) {
            void reader.cancel();
            throw new Error(`Feed body exceeds ${MAX_BYTES} byte cap`);
          }
          chunks.push(value);
        }
      }
      return {
        notModified: false,
        body: Buffer.concat(chunks).toString("utf8"),
        etag: res.headers.get("etag"),
        lastModified: res.headers.get("last-modified"),
        httpStatus: res.status,
      };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new Error(`Feed fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Too many redirects");
}

/** Compute the next due time after a successful poll (configured interval). */
function nextPollAfterSuccess(now: Date, intervalMinutes: number): Date {
  const minutes = intervalMinutes > 0 ? intervalMinutes : 60;
  return new Date(now.getTime() + minutes * 60_000);
}

/** Compute the backed-off next due time after a failure (capped exponential). */
function nextPollAfterFailure(now: Date, intervalMinutes: number, consecutiveFailures: number): Date {
  const base = intervalMinutes > 0 ? intervalMinutes : 60;
  const backoff = Math.min(base * Math.pow(2, Math.max(0, consecutiveFailures - 1)), MAX_BACKOFF_MINUTES);
  return new Date(now.getTime() + backoff * 60_000);
}

/** Per-feed outcome of a single poll. */
export interface FeedPollOutcome {
  feedId: string;
  status: "ok" | "not_modified" | "error";
  itemsSeen: number;
  itemsEnqueued: number;
  // Task #231: full per-poll breakdown so the admin can audit each run.
  markersRecorded: number;
  junkRejected: number;
  error?: string;
}

/**
 * Poll a single feed once: conditional GET → parse → filter → dedupe → enqueue
 * new discoverable items. Records feed health (status, error, counts, next due,
 * ETag/Last-Modified) and NEVER throws — a failure is captured on the feed row.
 */
async function pollFeed(feed: SourceFeed, now: Date): Promise<FeedPollOutcome> {
  const outcome: FeedPollOutcome = {
    feedId: feed.id,
    status: "ok",
    itemsSeen: 0,
    itemsEnqueued: 0,
    markersRecorded: 0,
    junkRejected: 0,
  };

  let fetched: FeedFetchResult;
  try {
    fetched = await conditionalGet(feed.url, { etag: feed.etag, lastModified: feed.lastModified });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const consecutiveFailures = feed.consecutiveFailures + 1;
    await db
      .update(sourceFeedsTable)
      .set({
        lastPolledAt: now,
        lastStatus: "error",
        lastError: message,
        consecutiveFailures,
        nextPollAt: nextPollAfterFailure(now, feed.pollIntervalMinutes, consecutiveFailures),
        updatedAt: now,
      })
      .where(eq(sourceFeedsTable.id, feed.id));
    outcome.status = "error";
    outcome.error = message;
    return outcome;
  }

  // 304 — unchanged. Healthy; just advance the schedule.
  if (fetched.notModified) {
    await db
      .update(sourceFeedsTable)
      .set({
        lastPolledAt: now,
        lastSuccessAt: now,
        lastStatus: "not_modified",
        lastError: null,
        consecutiveFailures: 0,
        // A 304 poll saw nothing new — the last-poll breakdown reflects that run.
        lastItemsSeen: 0,
        lastItemsEnqueued: 0,
        lastMarkersRecorded: 0,
        lastJunkRejected: 0,
        nextPollAt: nextPollAfterSuccess(now, feed.pollIntervalMinutes),
        updatedAt: now,
      })
      .where(eq(sourceFeedsTable.id, feed.id));
    outcome.status = "not_modified";
    return outcome;
  }

  // Parse. A parse failure is a feed error (bad payload), recorded + backed off.
  let items: ParsedFeedItem[];
  let feedTitle: string | null = null;
  try {
    const parsed = parseFeed(fetched.body);
    items = parsed.items;
    feedTitle = parsed.title;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const consecutiveFailures = feed.consecutiveFailures + 1;
    await db
      .update(sourceFeedsTable)
      .set({
        lastPolledAt: now,
        lastStatus: "error",
        lastError: `parse: ${message}`,
        consecutiveFailures,
        nextPollAt: nextPollAfterFailure(now, feed.pollIntervalMinutes, consecutiveFailures),
        updatedAt: now,
      })
      .where(eq(sourceFeedsTable.id, feed.id));
    outcome.status = "error";
    outcome.error = message;
    return outcome;
  }

  outcome.itemsSeen = items.length;
  let enqueued = 0;

  for (const item of items) {
    if (enqueued >= MAX_ITEMS_PER_FEED) break;

    // Record every item we saw (idempotent per feed) so re-polls skip it. A
    // conflict means we've seen this item before → nothing new to do.
    let isNew = false;
    try {
      const [inserted] = await db
        .insert(sourceFeedItemsTable)
        .values({
          feedId: feed.id,
          dedupeKey: item.dedupeKey,
          url: item.url,
          title: item.title,
          publishedAt: item.publishedAt,
          enqueued: false,
        })
        .onConflictDoNothing({
          target: [sourceFeedItemsTable.feedId, sourceFeedItemsTable.dedupeKey],
        })
        .returning({ id: sourceFeedItemsTable.id });
      isNew = !!inserted;
    } catch (err) {
      logger.warn({ err, feedId: feed.id, dedupeKey: item.dedupeKey }, "feedWatcher: record item failed");
      continue;
    }

    if (!isNew) continue;
    if (!item.url) continue;

    // Optional per-feed keyword filter: narrow a broad feed to relevant topics.
    // Filtered-out items stay recorded seen (inserted above) so re-polls skip
    // them, but are neither routed nor enqueued.
    if (
      !feedItemPassesFilter(item, {
        includeTerms: feed.filterIncludeTerms,
        excludeTerms: feed.filterExcludeTerms,
      })
    ) {
      continue;
    }

    // GovInfo feed links point at a JavaScript SPA "details" page the extractor
    // can't read; rewrite to the underlying content file so the vault fetches
    // the real document. Non-GovInfo (or unrecognized) URLs pass through
    // unchanged. The feed guid stays the dedupe key — only the fetch target
    // changes.
    const fetchUrl = resolveGovInfoContentUrl(item.url) ?? item.url;

    // Three-way routing (Task #227): a social feed item becomes a trend marker
    // (velocity signal only), an aggregator item is logged as rejected junk, and
    // only true evidence sources are enqueued for ingestion.
    const role = classifySourceRole(fetchUrl);
    if (role.role === "trend_marker") {
      await recordMarker({
        url: fetchUrl,
        title: item.title || null,
        beatSlug: feed.beatSlug,
        discoveredVia: "known_source",
        platform: role.platform ?? undefined,
      });
      outcome.markersRecorded += 1;
      continue;
    }
    if (role.role === "rejected_junk") {
      await recordRejected({
        url: fetchUrl,
        reason: role.reason,
        beatSlug: feed.beatSlug,
        discoveredVia: "known_source",
      });
      outcome.junkRejected += 1;
      continue;
    }

    try {
      const { enqueued: didEnqueue } = await enqueueUrl(fetchUrl, {
        discoveredVia: "known_source",
        beatSlug: feed.beatSlug,
        // Use the RSS item headline as the lead snippet so cluster label
        // derivation has a human-readable string even when the fetched document
        // is a GovInfo PDF that Readability cannot extract a title from. When
        // the RSS item itself carries no title (e.g. some GovInfo collections),
        // synthesise one from the package-ID dedupeKey (e.g. "GAOREPORTS-B-…"
        // → "GAO Report B-…") so the cluster label never falls back to a domain.
        leadSnippet: item.title || titleFromGovInfoPkgId(item.dedupeKey) || null,
        // A feed re-surfaces the same URLs; never re-ingest a URL already handled.
        reviveTerminal: false,
      });
      if (didEnqueue) {
        enqueued += 1;
        await db
          .update(sourceFeedItemsTable)
          .set({ enqueued: true })
          .where(and(eq(sourceFeedItemsTable.feedId, feed.id), eq(sourceFeedItemsTable.dedupeKey, item.dedupeKey)));
      }
    } catch (err) {
      logger.warn({ err, feedId: feed.id, url: item.url }, "feedWatcher: enqueue item failed");
    }
  }

  outcome.itemsEnqueued = enqueued;
  await db
    .update(sourceFeedsTable)
    .set({
      title: feed.title ?? feedTitle,
      lastPolledAt: now,
      lastSuccessAt: now,
      lastStatus: "ok",
      lastError: null,
      consecutiveFailures: 0,
      itemCount: feed.itemCount + enqueued,
      lastItemsSeen: outcome.itemsSeen,
      lastItemsEnqueued: outcome.itemsEnqueued,
      lastMarkersRecorded: outcome.markersRecorded,
      lastJunkRejected: outcome.junkRejected,
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      nextPollAt: nextPollAfterSuccess(now, feed.pollIntervalMinutes),
      updatedAt: now,
    })
    .where(eq(sourceFeedsTable.id, feed.id));

  return outcome;
}

/** Summary of one poll pass across all due feeds. */
export interface PollDueFeedsResult {
  ran: boolean;
  feedsPolled: number;
  itemsEnqueued: number;
  stoppedBy: "disabled" | "empty" | "done";
}

/**
 * Poll every enabled feed that is due (nextPollAt <= now, or never polled),
 * bounded to MAX_FEEDS_PER_PASS oldest-due-first. Gated ONLY by the Source
 * Vault kill switch — deliberately NOT by `sourceDiscoveryEnabled`: that
 * setting is the master switch for PAID automatic discovery (Perplexity
 * per-beat search), while feed polling is free HTTP fetches of admin-curated
 * feeds. Coupling them once silently stopped all scheduled feed polls when the
 * admin turned discovery off to save money (13 feeds sat "Never polled").
 * Per-feed on/off lives on each feed's own `enabled` flag. Never throws.
 */
export async function pollDueFeeds(now: Date = new Date()): Promise<PollDueFeedsResult> {
  const result: PollDueFeedsResult = { ran: false, feedsPolled: 0, itemsEnqueued: 0, stoppedBy: "done" };

  if (!isSourceVaultEnabled()) {
    result.stoppedBy = "disabled";
    return result;
  }
  result.ran = true;

  const due = await db
    .select()
    .from(sourceFeedsTable)
    .where(
      and(
        eq(sourceFeedsTable.enabled, true),
        or(isNull(sourceFeedsTable.nextPollAt), lte(sourceFeedsTable.nextPollAt, now)),
      ),
    )
    .orderBy(sql`${sourceFeedsTable.nextPollAt} ASC NULLS FIRST`)
    .limit(MAX_FEEDS_PER_PASS);

  if (due.length === 0) {
    result.stoppedBy = "empty";
    return result;
  }

  for (const feed of due) {
    try {
      const outcome = await pollFeed(feed, now);
      result.feedsPolled += 1;
      result.itemsEnqueued += outcome.itemsEnqueued;
    } catch (err) {
      // pollFeed never throws, but stay defensive so one feed can't abort the pass.
      logger.warn({ err, feedId: feed.id }, "feedWatcher: pollFeed threw unexpectedly");
    }
  }

  return result;
}

/**
 * The set of beat slugs that have at least one ENABLED feed. Used by
 * sourceDiscovery to skip the paid Perplexity search for beats already covered
 * by a trusted feed (feeds first, Perplexity as gap-filler).
 */
export async function beatsCoveredByFeeds(): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ beatSlug: sourceFeedsTable.beatSlug })
    .from(sourceFeedsTable)
    .where(eq(sourceFeedsTable.enabled, true));
  return new Set(rows.map((r) => r.beatSlug));
}

// --- Admin CRUD ----------------------------------------------------------

export async function listFeeds(): Promise<SourceFeed[]> {
  // Stable order: many feeds share an identical created_at (seeded in one
  // batch), so ordering by created_at alone is a big tie that Postgres resolves
  // in arbitrary heap-scan order — any UPDATE (e.g. a poll) rewrites the tuple
  // and makes that row appear to jump around. The unique id tiebreaker pins the
  // order so feeds stay put regardless of polling/edits.
  return db
    .select()
    .from(sourceFeedsTable)
    .orderBy(desc(sourceFeedsTable.createdAt), asc(sourceFeedsTable.id));
}

export interface CreateFeedInput {
  url: string;
  title?: string | null;
  beatSlug: string;
  subBeats?: string[];
  filterIncludeTerms?: string[];
  filterExcludeTerms?: string[];
  enabled?: boolean;
  pollIntervalMinutes?: number;
  purpose?: FeedPurpose | null;
}

/** Register a new feed. Throws on a duplicate URL (caught → 409 by the route). */
export async function createFeed(input: CreateFeedInput): Promise<SourceFeed> {
  const [row] = await db
    .insert(sourceFeedsTable)
    .values({
      url: input.url.trim(),
      title: input.title ?? null,
      beatSlug: input.beatSlug,
      subBeats: input.subBeats ?? [],
      filterIncludeTerms: input.filterIncludeTerms ?? [],
      filterExcludeTerms: input.filterExcludeTerms ?? [],
      enabled: input.enabled ?? true,
      pollIntervalMinutes: input.pollIntervalMinutes ?? 60,
      purpose: input.purpose ?? null,
    })
    .returning();
  return row!;
}

export interface UpdateFeedInput {
  title?: string | null;
  beatSlug?: string;
  subBeats?: string[];
  filterIncludeTerms?: string[];
  filterExcludeTerms?: string[];
  enabled?: boolean;
  pollIntervalMinutes?: number;
  purpose?: FeedPurpose | null;
}

/** Update an existing feed's editable fields. Returns null when not found. */
export async function updateFeed(id: string, input: UpdateFeedInput): Promise<SourceFeed | null> {
  const patch: Partial<typeof sourceFeedsTable.$inferInsert> = { updatedAt: new Date() };
  if (input.title !== undefined) patch.title = input.title;
  if (input.beatSlug !== undefined) patch.beatSlug = input.beatSlug;
  if (input.subBeats !== undefined) patch.subBeats = input.subBeats;
  if (input.filterIncludeTerms !== undefined) patch.filterIncludeTerms = input.filterIncludeTerms;
  if (input.filterExcludeTerms !== undefined) patch.filterExcludeTerms = input.filterExcludeTerms;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.pollIntervalMinutes !== undefined) patch.pollIntervalMinutes = input.pollIntervalMinutes;
  if (input.purpose !== undefined) patch.purpose = input.purpose;
  const [row] = await db
    .update(sourceFeedsTable)
    .set(patch)
    .where(eq(sourceFeedsTable.id, id))
    .returning();
  return row ?? null;
}

/** Delete a feed and its seen-item rows (no DB FK, so cascade in app). */
export async function deleteFeed(id: string): Promise<boolean> {
  await db.delete(sourceFeedItemsTable).where(eq(sourceFeedItemsTable.feedId, id));
  const rows = await db.delete(sourceFeedsTable).where(eq(sourceFeedsTable.id, id)).returning({ id: sourceFeedsTable.id });
  return rows.length > 0;
}

/** Force a feed due immediately (admin "Poll now"). Returns the poll outcome. */
export async function pollFeedNow(id: string, now: Date = new Date()): Promise<FeedPollOutcome | null> {
  const [feed] = await db.select().from(sourceFeedsTable).where(eq(sourceFeedsTable.id, id)).limit(1);
  if (!feed) return null;
  return pollFeed(feed, now);
}
