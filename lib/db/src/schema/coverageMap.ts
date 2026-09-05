import {
  pgTable,
  text,
  uuid,
  real,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { conceptsTable } from "./concepts";
import { topicIdeasTable } from "./topicIdeas";
import { crossBeatRadarSuggestionsTable } from "./conceptRadar";

// --- Living Coverage Map (Task #345) -----------------------------------------
//
// One row per live concept. Stores pre-computed deterministic scores and the
// classification assigned by the coverage map scoring pass so the admin UI can
// filter and sort without re-running the full calculation on every request.
//
// Input fingerprint: SHA-256 of the six raw health metrics plus central-article
// count + cluster similarity count. Unchanged fingerprint → skip recalculation.
//
// Provenance JSON: everything the promote-to-idea flow needs (source IDs, beat
// slugs, article IDs) so nothing is lost when a coverage map item becomes an idea.
//
// Editorial state: editor decisions that suppress repetitive recommendations
// without touching factual evidence scores.

export const COVERAGE_CLASSIFICATIONS = [
  "strong_evidence_missing_coverage",
  "heavy_coverage_weak_evidence",
  "rising_evidence_stale_coverage",
  "saturated_territory",
  "insufficient_data",
] as const;
export type CoverageClassification = (typeof COVERAGE_CLASSIFICATIONS)[number];

export const RECOMMENDED_ACTIONS = [
  "create_foundational_article",
  "create_cross_beat_synthesis",
  "build_evidence_packet",
  "find_more_sources",
  "update_existing_article",
  "strengthen_glossary_evidence",
  "avoid_additional_general_coverage",
  "review_source_health",
  "mark_intentionally_complete",
  "monitor_only",
] as const;
export type RecommendedAction = (typeof RECOMMENDED_ACTIONS)[number];

export const EDITORIAL_STATES = [
  "none",
  "actively_expanding",
  "intentionally_complete",
  "intentionally_limited",
  "waiting_for_evidence",
  "watch_only",
  "not_a_priority",
] as const;
export type EditorialState = (typeof EDITORIAL_STATES)[number];

/**
 * Scores fed into opportunityScore:
 *   opportunityScore = evidenceStrength + sourceDiversity + evidenceFreshness
 *                    + readerInterest + coverageGap
 *                    - saturation - recentCoveragePenalty
 * All components stored individually for editor inspection.
 */
export interface CoverageScoreBreakdown {
  evidenceStrength: number;
  sourceDiversity: number;
  evidenceFreshness: number;
  coverageDepth: number;
  articleUniqueness: number;
  readerInterest: number;
  updateUrgency: number;
  saturation: number;
  coverageGap: number;
  recentCoveragePenalty: number;
  opportunityScore: number;
  /** Raw inputs used to produce the above — for editor inspection. */
  inputs: {
    activeTrustedCount: number;
    independentFamilyCount: number;
    newestEvidenceAtIso: string | null;
    retractedLinkedCount: number;
    centralArticleCount: number;
    totalArticleCount: number;
    mostRecentCentralArticleAtIso: string | null;
    newFamiliesLast90d: number;
    newFamiliesLast120d: number;
    similarCentralArticleCount: number;
    demandViews30d: number;
  };
}

/**
 * IDs preserved for promote-to-idea and cross-reference UI links.
 */
export interface CoverageProvenance {
  /** Vault source document IDs supporting this concept (evidenceEligible, active, trusted). */
  sourceDocumentIds: string[];
  /** Source family IDs (deduplicated) from those docs. */
  sourceFamilyIds: string[];
  /** Published central article IDs (paragraphIndex <= 2, confidence >= 0.7). */
  centralArticleIds: string[];
  /** Primary beat slug (strongest affinity). */
  primaryBeatSlug: string | null;
  /** Up to two secondary beat slugs. */
  secondaryBeatSlugs: string[];
  /** Coverage map item ID (self-reference, populated after first upsert). */
  coverageMapItemId: string | null;
  /** Cross-beat radar suggestion ID when one exists for this concept. */
  radarSuggestionId: string | null;
  /** Status of the linked radar suggestion. */
  radarSuggestionStatus: string | null;
}

export const coverageMapItemsTable = pgTable(
  "coverage_map_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => conceptsTable.id, { onDelete: "cascade" }),

    // Classification (the four required sections + insufficient_data fallback).
    classification: text("classification", { enum: COVERAGE_CLASSIFICATIONS })
      .notNull()
      .default("insufficient_data"),

    // Nine individual score components (0–1 each).
    evidenceStrength: real("evidence_strength").notNull().default(0),
    sourceDiversity: real("source_diversity").notNull().default(0),
    evidenceFreshness: real("evidence_freshness").notNull().default(0),
    coverageDepth: real("coverage_depth").notNull().default(0),
    articleUniqueness: real("article_uniqueness").notNull().default(0),
    readerInterest: real("reader_interest").notNull().default(0),
    updateUrgency: real("update_urgency").notNull().default(0),
    saturation: real("saturation").notNull().default(0),
    opportunityScore: real("opportunity_score").notNull().default(0),

    // Deterministic recommended action (one of RECOMMENDED_ACTIONS).
    recommendedAction: text("recommended_action", { enum: RECOMMENDED_ACTIONS })
      .notNull()
      .default("monitor_only"),

    // Full score breakdown including raw inputs — editor inspection only.
    scoreBreakdown: jsonb("score_breakdown").$type<CoverageScoreBreakdown>(),

    // IDs preserved for promote-to-idea and UI links.
    provenanceJson: jsonb("provenance_json").$type<CoverageProvenance>(),

    // Fingerprint of raw input metrics. Unchanged = skip recalculation.
    inputFingerprint: text("input_fingerprint").notNull().default(""),

    // Editor decisions. Never alter evidence scores.
    editorialState: text("editorial_state", { enum: EDITORIAL_STATES })
      .notNull()
      .default("none"),
    editorialNote: text("editorial_note"),

    // Linked topic idea when the editor promoted this item.
    ideaId: uuid("idea_id").references(() => topicIdeasTable.id, { onDelete: "set null" }),

    // Linked radar suggestion (if any exists for this concept).
    radarSuggestionId: uuid("radar_suggestion_id").references(
      () => crossBeatRadarSuggestionsTable.id,
      { onDelete: "set null" },
    ),

    calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("coverage_map_items_concept_unique").on(t.conceptId),
    index("coverage_map_items_classification_idx").on(t.classification),
    index("coverage_map_items_opportunity_idx").on(t.opportunityScore),
    index("coverage_map_items_editorial_state_idx").on(t.editorialState),
  ],
);

export type CoverageMapItem = typeof coverageMapItemsTable.$inferSelect;
export type InsertCoverageMapItem = typeof coverageMapItemsTable.$inferInsert;
