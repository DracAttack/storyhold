import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  real,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { conceptsTable } from "./concepts";
import { topicIdeasTable } from "./topicIdeas";

// --- Cross-Beat Radar & Evidence Health (Task #340) --------------------------
//
// Three tables:
//   cross_beat_radar_suggestions — persisted radar output: one row per
//     bridge-concept + beat-pair suggestion the radar generated (or dismissed).
//     The unique dedupe_key is the idempotency claim AND the dismissal memory:
//     a dismissed suggestion's key stays in the table so later runs never
//     re-pitch the same concept/beat-pair.
//   concept_evidence_health — one row per concept: the deterministic evidence
//     health metrics snapshot (trusted counts, family counts, freshness,
//     retraction/correction links, demand proxy), fully recomputed by the
//     daily health pass.
//   concept_health_alerts — actionable review flags derived from the health
//     metrics (weak support / coverage opportunity / stale-conflict). Unique
//     dedupe_key means an alert for the same condition is raised at most once;
//     dismissed alerts stay dismissed across recomputes.

/** Radar suggestion lifecycle. */
export const RADAR_SUGGESTION_STATUSES = ["pending", "dismissed", "skipped"] as const;
export type RadarSuggestionStatus = (typeof RADAR_SUGGESTION_STATUSES)[number];

export const crossBeatRadarSuggestionsTable = pgTable(
  "cross_beat_radar_suggestions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => conceptsTable.id, { onDelete: "cascade" }),
    // Snapshots so the row stays legible if the concept is renamed/merged.
    conceptTerm: text("concept_term").notNull(),
    conceptSlug: text("concept_slug").notNull(),
    // `<conceptId>:<beatA>+<beatB>` (beats sorted) — the idempotency claim.
    dedupeKey: text("dedupe_key").notNull(),
    // Primary beat the idea targets + the other bridge beats it blends.
    primaryBeatSlug: text("primary_beat_slug").notNull(),
    secondaryBeatSlugs: text("secondary_beat_slugs").array().notNull(),
    // LLM-phrased pitch (single budget-guarded call per suggestion).
    title: text("title").notNull(),
    angle: text("angle").notNull(),
    // Deterministic radar score (gate pipeline output) for ranking.
    score: real("score").notNull().default(0),
    // Provenance: qualifying beats with weights + the evidence snapshot
    // (trusted vault docs backing the bridge) at generation time.
    bridgeBeats: jsonb("bridge_beats").$type<Array<{ beatSlug: string; weight: number }>>(),
    evidenceSnapshot: jsonb("evidence_snapshot").$type<
      Array<{
        docId: string;
        url: string;
        tier: string;
        familyId: string | null;
        // True when the pitch model explicitly cited this source as backing
        // the angle (absent on older rows and skipped candidates).
        supporting?: boolean;
      }>
    >(),
    status: text("status", { enum: RADAR_SUGGESTION_STATUSES }).notNull().default("pending"),
    // Why a candidate was recorded but no idea created (dedupe overlap, no
    // covering author, idea cap, LLM disabled...). Null for clean pitches.
    skipReason: text("skip_reason"),
    // The topic idea the suggestion created (null when skipped/failed).
    ideaId: uuid("idea_id").references(() => topicIdeasTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cross_beat_radar_suggestions_dedupe_unique").on(t.dedupeKey),
    index("cross_beat_radar_suggestions_status_idx").on(t.status),
    index("cross_beat_radar_suggestions_concept_idx").on(t.conceptId),
  ],
);

export type CrossBeatRadarSuggestion = typeof crossBeatRadarSuggestionsTable.$inferSelect;

export const conceptEvidenceHealthTable = pgTable(
  "concept_evidence_health",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => conceptsTable.id, { onDelete: "cascade" }),
    // Active trusted-tier vault docs linked via source_concept_edges.
    activeTrustedCount: integer("active_trusted_count").notNull().default(0),
    // Distinct source families among those trusted docs (independence proxy).
    independentFamilyCount: integer("independent_family_count").notNull().default(0),
    // Newest linked ACTIVE doc timestamp (any tier) — freshness signal.
    newestEvidenceAt: timestamp("newest_evidence_at", { withTimezone: true }),
    // Linked docs whose lifecycle went retracted / corrected-superseded.
    retractedLinkedCount: integer("retracted_linked_count").notNull().default(0),
    // Published articles mentioning the concept.
    articleMentionCount: integer("article_mention_count").notNull().default(0),
    // Reader-demand proxy: page views (last 30d) of articles mentioning the
    // concept. (No per-term view tracking exists; this is the closest
    // deterministic proxy from existing analytics.)
    demandViews30d: integer("demand_views_30d").notNull().default(0),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("concept_evidence_health_concept_unique").on(t.conceptId)],
);

export type ConceptEvidenceHealth = typeof conceptEvidenceHealthTable.$inferSelect;

export const CONCEPT_HEALTH_ALERT_TYPES = [
  "weak_support",
  "coverage_opportunity",
  "stale_conflict",
] as const;
export type ConceptHealthAlertType = (typeof CONCEPT_HEALTH_ALERT_TYPES)[number];

export const CONCEPT_HEALTH_ALERT_STATUSES = [
  "open",
  "dismissed",
  "resolved",
  "promoted",
] as const;
export type ConceptHealthAlertStatus = (typeof CONCEPT_HEALTH_ALERT_STATUSES)[number];

export const conceptHealthAlertsTable = pgTable(
  "concept_health_alerts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => conceptsTable.id, { onDelete: "cascade" }),
    conceptTerm: text("concept_term").notNull(),
    conceptSlug: text("concept_slug").notNull(),
    alertType: text("alert_type", { enum: CONCEPT_HEALTH_ALERT_TYPES }).notNull(),
    // `<type>:<conceptId>` — one alert per condition per concept, ever, unless
    // it resolves first (resolved alerts may re-open if the condition returns).
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status", { enum: CONCEPT_HEALTH_ALERT_STATUSES }).notNull().default("open"),
    // Metrics snapshot + (for stale_conflict) the affected linked articles.
    detail: jsonb("detail").$type<{
      activeTrustedCount?: number;
      independentFamilyCount?: number;
      newestEvidenceAt?: string | null;
      retractedLinkedCount?: number;
      retractedDocIds?: string[];
      articleMentionCount?: number;
      demandViews30d?: number;
      linkedArticles?: Array<{ id: string; slug: string; title: string }>;
    }>(),
    // The idea created when a coverage_opportunity alert was promoted.
    ideaId: uuid("idea_id").references(() => topicIdeasTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("concept_health_alerts_dedupe_unique").on(t.dedupeKey),
    index("concept_health_alerts_status_idx").on(t.status),
    index("concept_health_alerts_concept_idx").on(t.conceptId),
  ],
);

export type ConceptHealthAlert = typeof conceptHealthAlertsTable.$inferSelect;
