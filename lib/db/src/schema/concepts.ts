import {
  pgTable,
  text,
  boolean,
  timestamp,
  uuid,
  integer,
  real,
  uniqueIndex,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { articlesTable } from "./articles";

// Master concept registry. One row per canonical concept term; the slug is
// stable and drives the public /glossary/:slug URL. Concepts are auto-published
// (status = "live") when the LLM definition confidence meets the threshold.
export const conceptsTable = pgTable(
  "concepts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // URL-safe slug derived from the canonical term, e.g. "cognitive-dissonance"
    slug: text("slug").notNull().unique(),
    // Canonical display form, e.g. "Cognitive Dissonance"
    term: text("term").notNull(),
    // Short definition for the inline hover card (≤40 words)
    hoverDefinition: text("hover_definition").notNull().default(""),
    // Full plain-English definition shown on the glossary page (≤80 words)
    definition: text("definition").notNull().default(""),
    // Wikipedia grounding — populated when the MediaWiki search finds a match
    wikiPageId: integer("wiki_page_id"),
    wikiUrl: text("wiki_url"),
    wikiTitle: text("wiki_title"),
    // Short extract from the Wikipedia article used to ground the definition
    wikiExtract: text("wiki_extract"),
    // Wikipedia revision ID at the time the page was last ingested into the
    // Source Vault. Re-ingest happens ONLY when the live revision differs
    // (dedupe by page ID + refresh on revision change).
    wikiRevId: integer("wiki_rev_id"),
    // Quality scores from the LLM pipeline
    detectionConfidence: real("detection_confidence").notNull().default(0),
    definitionConfidence: real("definition_confidence").notNull().default(0),
    // Admin lifecycle: live = shown to readers; draft = below threshold or pending;
    // hidden = suppressed by admin
    status: text("status", { enum: ["live", "draft", "hidden"] }).notNull().default("draft"),
    // How many published articles mention this concept (denormalised for list display)
    articleCount: integer("article_count").notNull().default(0),
    // Admin opt-out: when true this term is never eligible for the Term of the
    // Day pool (e.g. drug names). Toggled from the ToD preview + card gallery.
    termOfDayBlocked: boolean("term_of_day_blocked").notNull().default(false),
    // Admin per-concept switch: when false, this concept never appears as a
    // hover card in article bodies (glossary page + Term of the Day are
    // unaffected). Toggled from the admin Concepts list.
    hoverEnabled: boolean("hover_enabled").notNull().default(true),
    // Admin mark: queued for the "backfill & review" sweep — re-resolve the
    // Wikipedia grounding, regenerate all definition fields, and recapture the
    // stored cards. Cleared automatically when the sweep finishes the concept.
    backfillRequested: boolean("backfill_requested").notNull().default(false),
    // External reference link (Wikipedia, Dictionary.com, etc.)
    externalUrl: text("external_url"),
    externalTitle: text("external_title"),
    // "What this means in real life" — one concrete example that puts shoes on the term
    realLifeExample: text("real_life_example"),
    // "What it isn't" — common misconceptions and clarifications
    whatItIsnt: text("what_it_isnt"),
    // How the term appears in BrainHook articles (data-driven, not AI-generated)
    seenInBrainHook: jsonb("seen_in_brainhook"),
    // Module type for "What this means in real life" context
    moduleType: text("module_type", { enum: ["behavioral", "medical", "technical", "general"] }),
    // How social media mutates this term — factual, restrained, shareable
    commonlyMisusedOnline: text("commonly_misused_online"),
    // Branded 1200×630 share card for og:image / twitter:image (landscape,
    // auto-generated on publish, regenerated on admin request). Falls back to
    // the site default share card when null.
    shareImage: text("share_image"),
    // Server-captured (headless Chromium screenshots of the CSS card) share
    // cards. Two outputs per render of the same composition:
    //  - card_image_url — 1080×1350 (4:5 feed portrait), fed to Term of the
    //    Day / feed posts. Stored as glossary-cards/{slug}-snap.png.
    //  - reels_image_url — 1080×1920 (9:16), the reels/stories card.
    //    Stored as glossary-cards/{slug}-reel.png.
    cardImageUrl: text("card_image_url"),
    reelsImageUrl: text("reels_image_url"),
    // Set by the pipeline when a concept is auto-hidden due to a non-standalone
    // or low-confidence definition. Null for concepts hidden manually by an admin.
    quarantineReason: text("quarantine_reason"),
    // When was the concept last processed through the pipeline
    lastProcessedAt: timestamp("last_processed_at", { withTimezone: true }),
    // Source retraction flag (Task #329). Set to true when the retraction
    // cascade detects that a vault source backing this concept's definition has
    // transitioned to a non-active lifecycle status AND the concept has zero
    // remaining active trusted-tier sources. An editor should review and either
    // rebuild the definition or manually clear the flag.
    conceptRetractionFlag: boolean("concept_retraction_flag").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugIdx: uniqueIndex("concepts_slug_idx").on(t.slug),
    statusIdx: index("concepts_status_idx").on(t.status),
  }),
);

export type Concept = typeof conceptsTable.$inferSelect;
export type ConceptInsert = typeof conceptsTable.$inferInsert;

// Alternate surface forms of a concept (plural, abbreviated, synonym). The
// annotator uses all aliases + the canonical term to match against article text.
export const conceptAliasesTable = pgTable(
  "concept_aliases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => conceptsTable.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    // Whether this alias is a preferred alternate display name (vs. purely a
    // match-expansion alias). Informational only; canonical term is always shown.
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    conceptIdx: index("concept_aliases_concept_idx").on(t.conceptId),
  }),
);

export type ConceptAlias = typeof conceptAliasesTable.$inferSelect;

// Per-article concept mention. One row per (article, concept) pair — only the
// first occurrence is annotated; subsequent occurrences are ignored. The matched
// surface form and paragraph index allow the client renderer to locate it.
export const articleConceptMentionsTable = pgTable(
  "article_concept_mentions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articlesTable.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => conceptsTable.id, { onDelete: "cascade" }),
    // The exact surface form detected in the article text (may differ from the
    // canonical term; could be an alias)
    matchedTerm: text("matched_term").notNull(),
    // Zero-based paragraph block index of the first occurrence
    paragraphIndex: integer("paragraph_index").notNull().default(0),
    // sha256 (hex, 16 chars) of the containing paragraph's text — lets the
    // renderer/reprocessor detect when the paragraph content has changed since
    // the mention was recorded (stale-anchor detection), independent of index.
    paragraphHash: text("paragraph_hash").notNull().default(""),
    // sha256 (hex, 16 chars) of the sentence containing the first occurrence.
    sentenceHash: text("sentence_hash").notNull().default(""),
    // Surrounding text (~240 chars centred on the matched term) so admins and
    // the annotator can locate the mention even after paragraph reflow.
    contextSnippet: text("context_snippet").notNull().default(""),
    // LLM detection confidence for this specific mention (0–1)
    confidence: real("confidence").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    articleIdx: index("article_concept_mentions_article_idx").on(t.articleId),
    conceptIdx: index("article_concept_mentions_concept_idx").on(t.conceptId),
    uniquePair: uniqueIndex("article_concept_mentions_unique").on(t.articleId, t.conceptId),
  }),
);

export type ArticleConceptMention = typeof articleConceptMentionsTable.$inferSelect;

// Processing run ledger — one row per article concept processing attempt. Used
// to track results and gate the backfill (articles with a successful run skip
// re-processing unless forced).
export const conceptProcessingRunsTable = pgTable(
  "concept_processing_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articlesTable.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["ok", "failed", "skipped"] }).notNull().default("ok"),
    conceptsFound: integer("concepts_found").notNull().default(0),
    mentionsCreated: integer("mentions_created").notNull().default(0),
    model: text("model").notNull().default(""),
    errorMessage: text("error_message"),
    contentHash: text("content_hash"),
    // Candidates the pipeline saw but did NOT publish, with the reason:
    // below_threshold | density_cap | not_created (resolution/verification
    // failed or low definition confidence). Admin oversight only.
    skippedCandidates: jsonb("skipped_candidates")
      .$type<Array<{ term: string; reason: string; confidence: number }>>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    articleIdx: index("concept_processing_runs_article_idx").on(t.articleId),
  }),
);

export type ConceptProcessingRun = typeof conceptProcessingRunsTable.$inferSelect;

// Links concepts to the Source Vault documents that grounded their definitions.
// Populated during Step 4 (Wikipedia ingest) and Step 5 (vault retrieval) of
// the pipeline. Lets admins see what sourced each definition and supports future
// authority scoring.
export const conceptSourcesTable = pgTable(
  "concept_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => conceptsTable.id, { onDelete: "cascade" }),
    // Canonical URL of the grounding document (Wikipedia page URL or vault URL)
    sourceUrl: text("source_url").notNull(),
    // Describes how this source relates to the concept: "wikipedia" | "vault"
    sourceType: text("source_type", { enum: ["wikipedia", "vault"] }).notNull(),
    // Relevance score (0–1) from semantic search, or 1.0 for Wikipedia direct match
    relevanceScore: real("relevance_score").notNull().default(1.0),
    // Whether this source directly supports a specific claim in the glossary definition.
    // null = legacy/unverified (recorded before the filter existed — shown in public trail).
    // true = confirmed claim-relevant.  false = filtered out (hidden from public trail).
    claimRelevant: boolean("claim_relevant"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    conceptIdx: index("concept_sources_concept_idx").on(t.conceptId),
    uniquePair: uniqueIndex("concept_sources_unique").on(t.conceptId, t.sourceUrl),
  }),
);

// Curated semantic relationships between concepts (admin-managed, not AI-generated).
// Types:
//   related      — topical overlap, same domain, often read together
//   distinct_from — "not the same as" (e.g. anxious attachment ≠ fearful attachment)
//   parent_of    — broader term that contains this one (e.g. attachment styles → anxious)
//   subtype_of   — narrower term within a broader one (inverse of parent_of)
//   antonym      — direct opposite (e.g. introvert ↔ extrovert)
//   see_also     — loose topical pointer, not a strict taxonomic link
export const conceptRelationshipsTable = pgTable(
  "concept_relationships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fromConceptId: uuid("from_concept_id")
      .notNull()
      .references(() => conceptsTable.id, { onDelete: "cascade" }),
    toConceptId: uuid("to_concept_id")
      .notNull()
      .references(() => conceptsTable.id, { onDelete: "cascade" }),
    relationType: text("relation_type", {
      enum: ["related", "distinct_from", "parent_of", "subtype_of", "antonym", "see_also"],
    }).notNull(),
    // Free-text admin note about why this link exists
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    fromIdx: index("concept_relationships_from_idx").on(t.fromConceptId),
    toIdx: index("concept_relationships_to_idx").on(t.toConceptId),
    uniquePair: uniqueIndex("concept_relationships_unique").on(
      t.fromConceptId,
      t.toConceptId,
      t.relationType,
    ),
  }),
);

export type ConceptRelationship = typeof conceptRelationshipsTable.$inferSelect;

export type ConceptSource = typeof conceptSourcesTable.$inferSelect;

// Concept-to-beat affinity weights (Task: concept-beat-affinities). One row per
// (concept, beat) with the blended weight plus its component signals kept
// separate so the blend can be retuned without recomputing from scratch.
// Internal editorial intelligence only — articles keep their single primary
// beat for publishing. Recomputed deterministically (no LLM) from article
// mentions, source-concept edges, and one-hop relationship neighbors.
export const conceptBeatAffinitiesTable = pgTable(
  "concept_beat_affinities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => conceptsTable.id, { onDelete: "cascade" }),
    beatSlug: text("beat_slug").notNull(),
    // Blended weight (normalized per concept — a concept's rows sum to ~1)
    weight: real("weight").notNull().default(0),
    // Component signals, each normalized per concept (0 when the signal had no
    // data for this concept). Kept so the blend can be re-tuned cheaply.
    articleSignal: real("article_signal").notNull().default(0),
    sourceSignal: real("source_signal").notNull().default(0),
    relationshipSignal: real("relationship_signal").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePair: uniqueIndex("concept_beat_affinities_unique").on(t.conceptId, t.beatSlug),
    conceptIdx: index("concept_beat_affinities_concept_idx").on(t.conceptId),
  }),
);

export type ConceptBeatAffinity = typeof conceptBeatAffinitiesTable.$inferSelect;
export type InsertConceptBeatAffinity = typeof conceptBeatAffinitiesTable.$inferInsert;
