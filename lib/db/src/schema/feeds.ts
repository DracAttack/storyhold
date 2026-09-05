import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  uuid,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// --- Feed Registry & Known Source Watcher (Task #227) -------------------
// A deterministic RSS/Atom monitoring layer that refills the Source Vault from
// admin-defined TRUSTED feeds first (Perplexity remains a gap-filler). Admins
// register a feed per beat/sub-beats, enable/disable it, and set a poll cadence;
// a scheduled cron polls due feeds (conditional GET via ETag / Last-Modified),
// parses items, filters them through the SAME source-authority rules discovery
// uses, dedupes against what this feed has already seen, and enqueues NEW items
// to the existing Source Vault ingest queue tagged discoveredVia="known_source"
// + beatSlug so they cluster as observations. NO parallel discovery pipeline —
// it feeds the queue that already exists.
//
// These tables are ALSO created idempotently at boot by ensureRuntimeTables
// (services/seed.ts) so fresh/reset dev DBs heal without a manual `push`.

// Health of the last poll attempt. `ok` = fetched + parsed; `not_modified` = the
// server answered 304 (nothing new, still healthy); `error` = fetch/parse failed.
// NULL = never polled yet.
export const FEED_POLL_STATUS = ["ok", "not_modified", "error"] as const;
export type FeedPollStatus = (typeof FEED_POLL_STATUS)[number];

// Informational-only "purpose" label (Task #231): why this feed exists in the
// registry. Display-only — it does NOT change routing, scoring, or which items
// get enqueued. NULL = unspecified (older rows / admin left it blank).
export const FEED_PURPOSE = [
  "primary",
  "trend_sensor",
  "idea_scout",
  "research_preprint",
  "official_record",
] as const;
export type FeedPurpose = (typeof FEED_PURPOSE)[number];

// A registered RSS/Atom feed the newsroom watches. `url` is unique so the same
// feed can't be registered twice. `beatSlug` (+ optional `subBeats`) is carried
// onto every enqueued item so clustering groups the observations within a beat.
export const sourceFeedsTable = pgTable(
  "source_feeds",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The feed (RSS/Atom) URL.
    url: text("url").notNull(),
    // Admin label; falls back to the feed's own <title> when discovered.
    title: text("title"),
    // Primary beat the discovered items belong to (drives clustering + the
    // preferred-vs-gap-filler rule in sourceDiscovery).
    beatSlug: text("beat_slug").notNull(),
    // Additional sub-beats (informational; not adjacency-filtered).
    subBeats: jsonb("sub_beats").$type<string[]>().notNull().default([]),
    // --- Per-feed keyword filter (topical narrowing) ----------------------
    // Lets a BROAD feed be narrowed to relevant topics without a parallel
    // filtering engine. An item is enqueued only if it matches at least one
    // include term (empty array = allow all) AND matches none of the exclude
    // terms. Matched case-insensitively as substrings against the item's title
    // + summary/description text. Filtered-out items are still recorded seen
    // (so re-polls skip them) but NOT enqueued.
    filterIncludeTerms: jsonb("filter_include_terms").$type<string[]>().notNull().default([]),
    filterExcludeTerms: jsonb("filter_exclude_terms").$type<string[]>().notNull().default([]),
    // Whether this feed is polled. Disabled feeds are skipped entirely.
    enabled: boolean("enabled").notNull().default(true),
    // Minimum minutes between polls (the cron gates each feed on nextPollAt).
    pollIntervalMinutes: integer("poll_interval_minutes").notNull().default(60),
    // Informational-only "purpose" label (Task #231). Display-only; never gates
    // routing/scoring/enqueue. Stored as text (enum enforced in app/OpenAPI),
    // matching the lastStatus convention. NULL = unspecified.
    purpose: text("purpose", { enum: FEED_PURPOSE }),

    // --- Conditional GET state (bandwidth-friendly polling) ---------------
    etag: text("etag"),
    lastModified: text("last_modified"),

    // --- Per-feed health ---------------------------------------------------
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastStatus: text("last_status", { enum: FEED_POLL_STATUS }),
    lastError: text("last_error"),
    // Total NEW items ever enqueued from this feed (cumulative).
    itemCount: integer("item_count").notNull().default(0),

    // --- Last-poll breakdown (Task #231) -----------------------------------
    // Snapshot of the MOST RECENT successful poll (NULL until first polled), so
    // the admin can audit each feed's last run instead of only the cumulative
    // count. `lastItemsSeen` = items in the feed body; `lastItemsEnqueued` = new
    // evidence URLs pushed to the ingest queue; `lastMarkersRecorded` = new
    // social/velocity trend markers; `lastJunkRejected` = aggregator/link-farm
    // items dropped. All refreshed on every successful poll.
    lastItemsSeen: integer("last_items_seen"),
    lastItemsEnqueued: integer("last_items_enqueued"),
    lastMarkersRecorded: integer("last_markers_recorded"),
    lastJunkRejected: integer("last_junk_rejected"),
    // When this feed becomes due again. NULL = due immediately.
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    // Consecutive failed polls (for surfacing unhealthy feeds).
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("source_feeds_url_key").on(t.url),
    index("source_feeds_enabled_idx").on(t.enabled),
    index("source_feeds_next_poll_idx").on(t.nextPollAt),
    index("source_feeds_beat_idx").on(t.beatSlug),
  ],
);

// A feed item this feed has already seen. Recorded per feed so a re-poll skips
// items it already enqueued — this is what prevents a done ingest-queue URL from
// being revived (re-ingested) on every poll. `dedupeKey` prefers the item's
// GUID, falling back to its link. No DB FK to the feed (boot-DDL healing +
// drizzle-push simplicity, matching the vault convention) — children are deleted
// in application code when a feed is removed.
export const sourceFeedItemsTable = pgTable(
  "source_feed_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    feedId: uuid("feed_id").notNull(),
    // guid || url; stable per item so re-polls dedupe.
    dedupeKey: text("dedupe_key").notNull(),
    url: text("url"),
    title: text("title"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    // Whether this item was actually pushed to the ingest queue (a filtered-out
    // or already-known URL is recorded seen but not enqueued).
    enqueued: boolean("enqueued").notNull().default(false),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("source_feed_items_feed_dedupe_key").on(t.feedId, t.dedupeKey),
    index("source_feed_items_feed_idx").on(t.feedId),
  ],
);

export const insertSourceFeedSchema = createInsertSchema(sourceFeedsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertSourceFeedItemSchema = createInsertSchema(sourceFeedItemsTable).omit({
  id: true,
  discoveredAt: true,
});

export type SourceFeed = typeof sourceFeedsTable.$inferSelect;
export type InsertSourceFeed = z.infer<typeof insertSourceFeedSchema>;
export type SourceFeedItem = typeof sourceFeedItemsTable.$inferSelect;
export type InsertSourceFeedItem = z.infer<typeof insertSourceFeedItemSchema>;
