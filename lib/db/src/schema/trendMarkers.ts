import {
  pgTable,
  text,
  integer,
  timestamp,
  uuid,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// --- Trend markers & rejected sources (Task #227) -----------------------
// Discovery now classifies every observed URL into one of THREE roles instead
// of a binary keep/drop:
//   • evidence   → a citable source; enters the Source Vault (source_documents),
//                  gets fetched/extracted/embedded, can back claims + packets.
//   • trend_marker → a WEAK observation (social platforms: YouTube, TikTok,
//                  Reddit, X, Facebook, Instagram, Threads…). It is NEVER
//                  fetched, chunked, or embedded and can NEVER satisfy the
//                  authority floor. It only signals PUBLIC INTEREST / velocity:
//                  it nudges a matching story cluster's score up and is surfaced
//                  in Trend Radar so an editor can SEE what's buzzing. It enters
//                  an evidence packet only via a manual escalation that re-runs
//                  it through the normal SSRF-safe ingest + verify pipeline.
//   • rejected_junk → dropped outright (link farms / aggregator redirects /
//                  spam: MSN, Yahoo, Google News, Taboola, Outbrain…). Logged
//                  (thin) purely for transparency in the admin surface.
//
// These are contract-first schemas; the tables + indexes are also created
// idempotently at boot by ensureRuntimeTables (services/seed.ts) so fresh/reset
// dev DBs heal without a manual `push`.

// Lifecycle of a trend marker. observed = seen, contributing to velocity only.
// investigated = a bounded topic-scoped SOURCE HARVEST ran off this marker's buzz
// (Task #236): it searched the Source Vault (free) then, if needed + in budget,
// Perplexity by the marker's TOPIC (title/snippet/beat, never the social URL) and
// routed any evidence leads into the ingest queue. The marker itself is still NOT
// ingested and still carries zero authority — the harvest only mines the wider web
// for citable coverage of the same story. escalated = an editor pushed the
// marker's OWN url into the ingest pipeline (a source_document may result, judged
// on its own authority). dismissed = an editor hid it.
export const TREND_MARKER_STATUS = ["observed", "investigated", "escalated", "dismissed"] as const;
export type TrendMarkerStatus = (typeof TREND_MARKER_STATUS)[number];

// Social platform families a marker can come from (display + grouping only).
export const TREND_MARKER_PLATFORM = [
  "youtube",
  "tiktok",
  "reddit",
  "x",
  "facebook",
  "instagram",
  "threads",
  "linkedin",
  "mastodon",
  "bluesky",
  "telegram",
  "other",
] as const;
export type TrendMarkerPlatform = (typeof TREND_MARKER_PLATFORM)[number];

export const trendMarkersTable = pgTable(
  "trend_markers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Canonical URL of the observation (unique — re-observations bump counts).
    url: text("url").notNull(),
    domain: text("domain").notNull(),
    platform: text("platform", { enum: TREND_MARKER_PLATFORM }).notNull().default("other"),
    title: text("title"),
    snippet: text("snippet"),
    // Beat this observation was discovered under (slug), when known.
    beatSlug: text("beat_slug"),
    // The story cluster this marker is attached to (velocity contribution), or
    // null when it hasn't matched an existing cluster yet. No DB FK to keep boot
    // DDL healing simple — nulled in app on cluster delete.
    clusterId: uuid("cluster_id"),
    // How it was discovered (mirrors source_ingest_queue.discovered_via values).
    discoveredVia: text("discovered_via").notNull().default("perplexity_search"),
    status: text("status", { enum: TREND_MARKER_STATUS }).notNull().default("observed"),
    // How many times this exact URL has been re-observed (a crude buzz signal).
    observationCount: integer("observation_count").notNull().default(1),
    // When a topic-scoped source harvest last ran off this marker's buzz
    // (Task #236). Doubles as the harvest cooldown clock: a topic is not
    // re-harvested while any of its markers was investigated recently.
    investigatedAt: timestamp("investigated_at", { withTimezone: true }),
    // Short human-readable result of the last harvest (e.g. "2 leads enqueued,
    // 1 marker, 0 junk (vault: 3 hits)"). Null until first investigated.
    harvestSummary: text("harvest_summary"),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("trend_markers_url_key").on(t.url),
    index("trend_markers_platform_idx").on(t.platform),
    index("trend_markers_beat_idx").on(t.beatSlug),
    index("trend_markers_cluster_idx").on(t.clusterId),
    index("trend_markers_status_idx").on(t.status),
  ],
);

export const insertTrendMarkerSchema = createInsertSchema(trendMarkersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type TrendMarker = typeof trendMarkersTable.$inferSelect;
export type InsertTrendMarker = z.infer<typeof insertTrendMarkerSchema>;

export const rejectedSourcesTable = pgTable(
  "rejected_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    url: text("url").notNull(),
    domain: text("domain").notNull(),
    // Short human-readable reason (e.g. "news aggregator (msn.com)").
    reason: text("reason").notNull(),
    beatSlug: text("beat_slug"),
    discoveredVia: text("discovered_via").notNull().default("perplexity_search"),
    observationCount: integer("observation_count").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("rejected_sources_url_key").on(t.url),
    index("rejected_sources_domain_idx").on(t.domain),
  ],
);

export const insertRejectedSourceSchema = createInsertSchema(rejectedSourcesTable).omit({
  id: true,
  createdAt: true,
});
export type RejectedSource = typeof rejectedSourcesTable.$inferSelect;
export type InsertRejectedSource = z.infer<typeof insertRejectedSourceSchema>;
