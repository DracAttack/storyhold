import {
  pgTable,
  text,
  integer,
  timestamp,
  uuid,
  jsonb,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// --- Story clusters (Task #199) ----------------------------------------
// The Source Vault, run as an automatic observer, ingests fresh source
// documents (via scheduled discovery). This table groups similar observations
// into "story clusters": a durable, incrementally-built grouping of vault
// sources that are all about the same developing story. Each ingested document
// is assigned to exactly one cluster (source_documents.cluster_id); a cluster
// is scored DETERMINISTICALLY (no paid AI) from its members' count, source
// diversity (syndication-aware), authority tier, and recency so the admin can
// triage what is heating up. Coverage memory (do-not-cover / already-covered)
// lives on the cluster so an editorial decision survives later observations.
//
// Contract-first schema; the table + indexes are also created idempotently at
// boot by ensureRuntimeTables (services/seed.ts) so fresh/reset dev DBs heal
// without a manual `push`.

// Operational lifecycle of a cluster. active = still within its freshness
// window (recent supporting sources). dormant = no fresh sources inside the
// beat's freshness window (aged out); excluded from the "hot now" ranking.
export const STORY_CLUSTER_STATUS = ["active", "dormant"] as const;
export type StoryClusterStatus = (typeof STORY_CLUSTER_STATUS)[number];

// Coverage memory. open = available for the editor to act on. covered = an
// article already covers this story (coveredArticleId). do_not_cover = an
// explicit editorial decision to skip. covered/do_not_cover suppress the
// cluster from the "needs attention" ranking until coverageResurfaceAfter
// (null = never resurface) elapses, at which point it reopens automatically.
export const CLUSTER_COVERAGE_STATUS = ["open", "covered", "do_not_cover"] as const;
export type ClusterCoverageStatus = (typeof CLUSTER_COVERAGE_STATUS)[number];

export const storyClustersTable = pgTable(
  "story_clusters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Beat this cluster belongs to (slug is the stable identity; display name
    // kept for convenient listing). Clustering only groups within a beat.
    beatSlug: text("beat_slug").notNull(),
    beat: text("beat").notNull(),
    // Human-readable label, derived DETERMINISTICALLY from the strongest
    // (highest-authority, newest) member's title — never AI-generated.
    label: text("label").notNull(),
    // Representative significant tokens used for incremental matching + display.
    keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
    status: text("status", { enum: STORY_CLUSTER_STATUS }).notNull().default("active"),

    // --- Deterministic score (no paid AI) ----------------------------------
    // 0-100 blended score; the component breakdown is kept for transparency.
    score: integer("score").notNull().default(0),
    scoreBreakdown: jsonb("score_breakdown")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    // Aggregates mirrored from the member sources for cheap listing/ranking.
    sourceCount: integer("source_count").notNull().default(0),
    // Distinct source families (syndication-aware diversity) + distinct domains.
    familyCount: integer("family_count").notNull().default(0),
    domainCount: integer("domain_count").notNull().default(0),
    // Strongest authority tier present among members (e.g. "primary").
    topAuthorityTier: text("top_authority_tier"),
    // Count of attached trend markers (weak social observations). These are NOT
    // member sources — they never contribute authority/diversity and can never
    // satisfy the trusted-source floor. They only feed the velocity component of
    // the score (public-interest signal) and the Trend Radar "buzzing" surface.
    markerCount: integer("marker_count").notNull().default(0),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    // When the cluster's freshness window elapses (newest source + beat window).
    // Past this it is swept to `dormant`.
    freshUntil: timestamp("fresh_until", { withTimezone: true }),

    // --- Coverage memory ---------------------------------------------------
    coverageStatus: text("coverage_status", { enum: CLUSTER_COVERAGE_STATUS })
      .notNull()
      .default("open"),
    coverageReason: text("coverage_reason"),
    // null = never resurface (permanent). A future date reopens the cluster.
    coverageResurfaceAfter: timestamp("coverage_resurface_after", { withTimezone: true }),
    // The article that covers this story (when coverageStatus = covered). No DB
    // FK to keep boot-DDL healing simple — set null in app on article delete.
    coveredArticleId: uuid("covered_article_id"),

    // --- Story Watch (Task #348) -------------------------------------------
    // Editor-flagged clusters get a lower development-signal threshold and a
    // targeted Perplexity search on top of the normal per-beat discovery pass.
    watched: boolean("watched").notNull().default(false),
    watchedAt: timestamp("watched_at", { withTimezone: true }),

    // --- Semantic reconciler (Task #330) -----------------------------------
    // When a reconciler pass merges this cluster INTO a larger one, this
    // timestamp is set. Archived clusters are excluded from active ranking and
    // further reconciliation passes. A null value means never archived.
    archivedAt: timestamp("archived_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("story_clusters_beat_idx").on(t.beatSlug),
    index("story_clusters_status_idx").on(t.status),
    index("story_clusters_score_idx").on(t.score),
    index("story_clusters_coverage_idx").on(t.coverageStatus),
  ],
);

export const insertStoryClusterSchema = createInsertSchema(storyClustersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type StoryCluster = typeof storyClustersTable.$inferSelect;
export type InsertStoryCluster = z.infer<typeof insertStoryClusterSchema>;

// --- Semantic cluster reconciler (Task #330) ----------------------------
// Two tables support the second-stage LLM reconciler that judges borderline
// story-cluster pairs (Jaccard 0.08–0.18 within the same beat).

// LLM verdict on a pair of clusters: whether they cover the same story.
export const CLUSTER_PAIR_VERDICT = ["same_story", "distinct", "uncertain"] as const;
export type ClusterPairVerdict = (typeof CLUSTER_PAIR_VERDICT)[number];

// Per-pair verdict cache. When a `same_story` pair is processed the smaller
// cluster is merged and archived; a `distinct` verdict is cached so the pair
// is never re-judged unless either cluster's keyword set changes (detected via
// a stored hash of the sorted keyword list). `uncertain` verdicts are NOT
// stored — the pair is re-evaluated on the next tick when new members may
// have resolved the ambiguity.
export const clusterPairVerdictsTable = pgTable(
  "cluster_pair_verdicts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Ordered so clusterAId < clusterBId (lexicographic) to make the pair
    // canonical regardless of which cluster was queried first.
    clusterAId: uuid("cluster_a_id").notNull(),
    clusterBId: uuid("cluster_b_id").notNull(),
    verdict: text("verdict", { enum: CLUSTER_PAIR_VERDICT }).notNull(),
    rationale: text("rationale"),
    // Sorted keyword hash at judgment time. A mismatch means either cluster
    // gained new members → re-judge.
    keywordHashA: text("keyword_hash_a").notNull(),
    keywordHashB: text("keyword_hash_b").notNull(),
    judgedAt: timestamp("judged_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cluster_pair_verdicts_pair_key").on(t.clusterAId, t.clusterBId),
    index("cluster_pair_verdicts_a_idx").on(t.clusterAId),
    index("cluster_pair_verdicts_b_idx").on(t.clusterBId),
  ],
);

// Audit log: one row per completed merge (smaller cluster absorbed into the
// larger). Persists after the archived cluster is gone so admins can review
// the reconciliation history.
export const clusterMergesTable = pgTable(
  "cluster_merges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The cluster that was merged away (archived).
    mergedFromClusterId: uuid("merged_from_cluster_id").notNull(),
    mergedFromLabel: text("merged_from_label").notNull(),
    // The cluster that absorbed the members.
    mergedIntoClusterId: uuid("merged_into_cluster_id").notNull(),
    mergedIntoLabel: text("merged_into_label").notNull(),
    // Beat context (slug + display name) for filtering.
    beatSlug: text("beat_slug").notNull(),
    beat: text("beat").notNull(),
    // LLM verdict rationale.
    rationale: text("rationale"),
    // How many source_documents were re-assigned.
    membersReassigned: integer("members_reassigned").notNull().default(0),
    // When the LLM judged the pair (milliseconds to confirm).
    judgedAt: timestamp("judged_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("cluster_merges_beat_idx").on(t.beatSlug),
    index("cluster_merges_created_idx").on(t.createdAt),
    index("cluster_merges_into_idx").on(t.mergedIntoClusterId),
  ],
);

export const insertClusterPairVerdictSchema = createInsertSchema(clusterPairVerdictsTable).omit({
  id: true,
  createdAt: true,
});
export const insertClusterMergeSchema = createInsertSchema(clusterMergesTable).omit({
  id: true,
  createdAt: true,
});
export type ClusterPairVerdictRow = typeof clusterPairVerdictsTable.$inferSelect;
export type ClusterMergeRow = typeof clusterMergesTable.$inferSelect;

// --- Vault re-sort snapshots -------------------------------------------
// One row per phase checkpoint captured during a vault re-sort run.
// Held after failure/cancel so an admin can restore the vault to a known-good
// state and resume the run from that phase. On successful completion the run's
// snapshots are NOT deleted — they are stamped run_finished_at so the UI can
// badge them as part of a finished run; they auto-expire 72h after that stamp.
// Kept in sync with ensureRuntimeTables in services/seed.ts.

export const RESORT_SNAPSHOT_TYPES = ["pre_a", "pre_b", "pre_c"] as const;
export type ResortSnapshotType = (typeof RESORT_SNAPSHOT_TYPES)[number];

// Outcome of the run a snapshot belongs to. Stamped when the run terminates:
// 'succeeded' (also sets run_finished_at, starting the 72h auto-expiry clock),
// 'failed', or 'cancelled'. NULL means the run never terminated cleanly —
// either it is still running (its runId matches the live job row) or it was
// interrupted (server restart killed the fire-and-forget promise); the stale-
// heartbeat detector stamps those 'failed' when it releases the dead job row.
export const RESORT_RUN_OUTCOMES = ["succeeded", "failed", "cancelled"] as const;
export type ResortRunOutcome = (typeof RESORT_RUN_OUTCOMES)[number];

export const vaultResortSnapshotsTable = pgTable(
  "vault_resort_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: text("run_id").notNull(),
    snapshotType: text("snapshot_type").$type<ResortSnapshotType>().notNull(),
    clusterCount: integer("cluster_count").notNull().default(0),
    docCount: integer("doc_count").notNull().default(0),
    verdictCount: integer("verdict_count").notNull().default(0),
    clustersJson: jsonb("clusters_json").$type<StoryCluster[]>().notNull().default([]),
    docAssignmentsJson: jsonb("doc_assignments_json")
      .$type<{ id: string; clusterId: string }[]>()
      .notNull()
      .default([]),
    pairVerdictsJson: jsonb("pair_verdicts_json")
      .$type<ClusterPairVerdictRow[]>()
      .notNull()
      .default([]),
    runOutcome: text("run_outcome").$type<ResortRunOutcome>(),
    runFinishedAt: timestamp("run_finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("vault_resort_snapshots_run_idx").on(t.runId),
    index("vault_resort_snapshots_type_idx").on(t.snapshotType),
  ],
);

export type VaultResortSnapshot = typeof vaultResortSnapshotsTable.$inferSelect;
