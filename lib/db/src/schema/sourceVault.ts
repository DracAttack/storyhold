import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  uuid,
  jsonb,
  customType,
  index,
  uniqueIndex,
  real,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { conceptsTable } from "./concepts";

// --- Source Vault (Phase 0 spike) ---------------------------------------
// A minimal "newsroom memory": discovered/ingested source URLs are fetched
// (SSRF-safe), their article body extracted + quality-scored, chunked, embedded
// (Perplexity), and the chunk vectors stored for semantic retrieval. This is the
// contract-first schema; the pgvector extension + these tables are also created
// idempotently at boot by ensureRuntimeTables (services/seed.ts) so fresh/reset
// dev DBs heal without a manual `push`.

// A pgvector column stored WITHOUT a fixed dimension modifier (`vector`, not
// `vector(768)`). The embedding size is NOT hardwired as a universal constant —
// each chunk records its own provider/model/dimensions — so different providers
// or model upgrades can coexist. Represented in JS as number[]; serialized to
// the pgvector text literal `[a,b,c]` on write and parsed back on read.
const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .replace(/^\[|\]$/g, "")
      .split(",")
      .filter((s) => s.length > 0)
      .map(Number);
  },
});

// How a document entered the vault. Stored on a plain text column (no PG enum),
// so extending this list is TS-only and needs no migration.
export const SOURCE_DISCOVERY = [
  "manual_url",
  "manual_upload",
  "perplexity_search",
  "trend_signal",
  "known_source",
  // Harvested from the outbound links of an existing article body (Task #228).
  "back_catalog",
  // Harvested from a HOT trend-marker topic's buzz (Task #236): the marker's
  // TOPIC (title/snippet/beat) is searched, never the social URL itself.
  "hot_marker_harvest",
  // Wikipedia page ingested as reference context grounding a glossary concept
  // (Concept Explainer). Reference-tier background material — never citable as
  // evidence (the authority classifier maps Wikipedia to the "reference" tier).
  "wikipedia_concept",
  // Discovered by the Sonar gap-fill step during source-link weaving: a single
  // Perplexity Sonar call runs when the vault/packet/catalog pool is thin; URLs
  // come exclusively from Sonar's top-level citations field, never model prose.
  "article_source_gap_fill",
  // Internal BrainHook glossary concept synced from the concepts table. Stored
  // as reference-tier background material for in-draft concept memory; never
  // cited as evidence. evidenceEligible = false on all rows with this value.
  "glossary_concept",
  // Force-ingested by an editor via the Ingest & Watch flow (Task #348).
  // After the document is clustered, the resulting cluster is auto-watched.
  "ingest_watch",
  // Surfaced by the targeted watched-cluster discovery pass (Task #348).
  // These items are processed ahead of regular perplexity_search leads so
  // breaking developments on watched stories are ingested promptly.
  "watched_cluster_search",
] as const;
export type SourceDiscovery = (typeof SOURCE_DISCOVERY)[number];

// Document lifecycle. fetched → extracted → embedded is the happy path.
// low_quality = extracted but below the quality bar (held out of embedding until
// an admin explicitly approves). failed = fetch/extract error.
export const SOURCE_DOC_STATUS = [
  "fetched",
  "extracted",
  "embedded",
  "low_quality",
  "failed",
] as const;
export type SourceDocStatus = (typeof SOURCE_DOC_STATUS)[number];

// Editorial lifecycle of a source, ORTHOGONAL to the ingest `status` above.
// active = current & citable; stale = past its freshness window; superseded =
// replaced by a newer/corrected version; retracted = pulled/retracted by the
// publisher; unavailable = no longer reachable (404/410/gone). Retrieval treats
// only `active` as fresh support.
export const SOURCE_LIFECYCLE_STATUS = [
  "active",
  "stale",
  "superseded",
  "retracted",
  "unavailable",
] as const;
export type SourceLifecycleStatus = (typeof SOURCE_LIFECYCLE_STATUS)[number];

// Authority tier, ordered strongest → weakest. primary = original research /
// official record (journals, .gov, court docs); firsthand = company/institution
// newsrooms and press-release wires (PRNewswire, BusinessWire…); wire =
// syndicated news agencies (AP/Reuters/AFP/Bloomberg); reported = established
// secondary journalism (BBC, NPR, NYT, WaPo…); commentary = opinion/analysis/
// blogs; social = social posts; aggregator = link farms / press-release relays;
// reference = tertiary background-only sources (Wikipedia, encyclopedias);
// unknown = unclassified.
export const SOURCE_AUTHORITY_TIER = [
  "primary",
  "firsthand",
  "wire",
  "reported",
  "commentary",
  "social",
  "aggregator",
  "reference",
  "unknown",
] as const;
export type SourceAuthorityTier = (typeof SOURCE_AUTHORITY_TIER)[number];

// Whether an authority tier was assigned by the auto classifier or pinned by an
// admin. Manual pins persist across re-ingest/recheck.
export const SOURCE_AUTHORITY_SOURCE = ["auto", "manual"] as const;
export type SourceAuthoritySource = (typeof SOURCE_AUTHORITY_SOURCE)[number];

// State of a queued URL awaiting bounded batch ingestion.
export const SOURCE_QUEUE_STATUS = [
  "pending",
  "processing",
  "done",
  "failed",
  "skipped",
] as const;
export type SourceQueueStatus = (typeof SOURCE_QUEUE_STATUS)[number];

// One ingested source page. `contentHash` is a sha256 of the extracted text so a
// re-ingest of unchanged content is detectable. Raw HTML is intentionally NOT
// stored — only the extracted, cleaned article text.
export const sourceDocumentsTable = pgTable(
  "source_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    url: text("url").notNull(),
    // The URL after redirects, if it differed from the requested one.
    canonicalUrl: text("canonical_url"),
    domain: text("domain").notNull(),
    title: text("title"),
    author: text("author"),
    excerpt: text("excerpt"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    // How it was discovered + the search lead snippet (if any).
    discoveredVia: text("discovered_via", { enum: SOURCE_DISCOVERY })
      .notNull()
      .default("manual_url"),
    leadSnippet: text("lead_snippet"),
    // Fetch outcome.
    httpStatus: integer("http_status"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    extractionMethod: text("extraction_method"),
    extractedText: text("extracted_text"),
    wordCount: integer("word_count").notNull().default(0),
    contentHash: text("content_hash"),
    // Quality gate: 0-100 heuristic score + human-readable flag reasons.
    qualityScore: integer("quality_score").notNull().default(0),
    qualityFlags: jsonb("quality_flags").$type<string[]>().notNull().default([]),
    status: text("status", { enum: SOURCE_DOC_STATUS }).notNull().default("fetched"),
    chunkCount: integer("chunk_count").notNull().default(0),
    // Embedding provenance mirrored from the chunks for convenient listing.
    embeddingProvider: text("embedding_provider"),
    embeddingModel: text("embedding_model"),
    embeddingDimensions: integer("embedding_dimensions"),
    error: text("error"),

    // --- Dedup + syndication (Step 1) --------------------------------------
    // 64-bit simhash of the extracted text (hex) for near-duplicate detection.
    contentSimhash: text("content_simhash"),
    // If this doc is a duplicate/syndicated copy, the id of the representative
    // it duplicates (self-reference; NOT a DB FK to keep boot-DDL healing +
    // drizzle push simple — enforced in application logic + set null on delete).
    duplicateOfId: uuid("duplicate_of_id"),
    // Why it was marked a duplicate: canonical_url | content_hash | near_duplicate.
    dedupeReason: text("dedupe_reason"),
    // Groups every version/copy of the same story (the representative's id).
    sourceFamilyId: uuid("source_family_id"),

    // --- Fetch policy (Step 2) ---------------------------------------------
    // robots.txt outcome for this URL: allowed | disallowed | unknown.
    robotsStatus: text("robots_status"),
    fetchAllowed: boolean("fetch_allowed").notNull().default(true),
    paywallDetected: boolean("paywall_detected").notNull().default(false),
    excerptOnly: boolean("excerpt_only").notNull().default(false),
    doNotRefetch: boolean("do_not_refetch").notNull().default(false),
    policyNotes: text("policy_notes"),

    // --- Lifecycle (Step 3) ------------------------------------------------
    lifecycleStatus: text("lifecycle_status", { enum: SOURCE_LIFECYCLE_STATUS })
      .notNull()
      .default("active"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    contentChangedAt: timestamp("content_changed_at", { withTimezone: true }),
    supersededById: uuid("superseded_by_id"),
    correctionDetected: boolean("correction_detected").notNull().default(false),
    staleAfter: timestamp("stale_after", { withTimezone: true }),

    // --- Authority tier (Step 4) -------------------------------------------
    authorityTier: text("authority_tier", { enum: SOURCE_AUTHORITY_TIER })
      .notNull()
      .default("unknown"),
    authoritySource: text("authority_source", { enum: SOURCE_AUTHORITY_SOURCE })
      .notNull()
      .default("auto"),
    authorityReason: text("authority_reason"),

    // --- Discovery + clustering (Task #199) --------------------------------
    // The beat this document was discovered for (null for manually-fed docs
    // with no beat context). Clustering only groups documents within a beat.
    beatSlug: text("beat_slug"),
    // The story cluster this document was assigned to (no DB FK to keep boot-DDL
    // healing simple — set null in app on cluster delete).
    clusterId: uuid("cluster_id"),
    // When the clustering pass assigned this doc. NULL = not yet clustered.
    clusteredAt: timestamp("clustered_at", { withTimezone: true }),

    // --- Evidence eligibility (glossary lane) ------------------------------
    // false for internal glossary_concept documents: they are used only as
    // INTERNAL CONCEPT MEMORY during drafting and must NEVER be returned by
    // the standard evidence semanticSearch or counted toward source coverage,
    // authority floor, or verifier support. All other documents default true.
    evidenceEligible: boolean("evidence_eligible").notNull().default(true),

    // --- Security screening ------------------------------------------------
    // Set true if the document's extracted text triggered a prompt-injection
    // heuristic. Flagged docs are quarantined from LLM input pipelines.
    promptInjectionSuspected: boolean("prompt_injection_suspected").notNull().default(false),

    // --- Concept edges (Task #338) ------------------------------------------
    // When the deterministic concept tagger last scanned this document. NULL =
    // not yet tagged (the backfill candidate filter). Re-tag on content change.
    conceptEdgesTaggedAt: timestamp("concept_edges_tagged_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("source_documents_url_key").on(t.url),
    index("source_documents_status_idx").on(t.status),
    index("source_documents_domain_idx").on(t.domain),
    index("source_documents_lifecycle_idx").on(t.lifecycleStatus),
    index("source_documents_family_idx").on(t.sourceFamilyId),
    index("source_documents_content_hash_idx").on(t.contentHash),
    index("source_documents_cluster_idx").on(t.clusterId),
    index("source_documents_beat_idx").on(t.beatSlug),
  ],
);

// One embedded chunk of a document's extracted text. The vector column is
// dimensionless (see `vector` above); the true size lives in `dimensions`.
export const sourceChunksTable = pgTable(
  "source_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => sourceDocumentsTable.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    charCount: integer("char_count").notNull().default(0),
    embedding: vector("embedding"),
    embeddingProvider: text("embedding_provider").notNull(),
    embeddingModel: text("embedding_model").notNull(),
    dimensions: integer("dimensions").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("source_chunks_document_idx").on(t.documentId),
    uniqueIndex("source_chunks_document_chunk_key").on(t.documentId, t.chunkIndex),
    // Approximate-nearest-neighbour index for the cosine similarity search
    // (`embedding <=> query`). The column is dimensionless (mixed providers
    // historically) and pgvector can only index uniformly-sized vectors, so this
    // is a partial index over the standard 384-dim local embeddings, casting to a
    // fixed size so the index can build. The query casts the same way (see
    // semanticSearch) so the planner can use it.
    index("source_chunks_embedding_hnsw_idx")
      .using("hnsw", sql`(embedding::vector(384)) vector_cosine_ops`)
      .where(sql`"dimensions" = 384`),
  ],
);

// Kind of work a vault job performed.
export const SOURCE_JOB_KIND = ["ingest_url", "search", "retrieve"] as const;
export type SourceJobKind = (typeof SOURCE_JOB_KIND)[number];

export const SOURCE_JOB_STATUS = ["running", "succeeded", "failed"] as const;
export type SourceJobStatus = (typeof SOURCE_JOB_STATUS)[number];

// An inspectable audit row for each vault operation (spike observability).
export const sourceVaultJobsTable = pgTable(
  "source_vault_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind", { enum: SOURCE_JOB_KIND }).notNull(),
    status: text("status", { enum: SOURCE_JOB_STATUS }).notNull().default("running"),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb("result").$type<Record<string, unknown>>(),
    costUsd: text("cost_usd").notNull().default("0"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("source_vault_jobs_created_idx").on(t.createdAt)],
);

// A bounded work queue of URLs awaiting ingestion. The cron tick atomically
// claims a small batch (UPDATE ... FOR UPDATE SKIP LOCKED), ingests each within
// per-run/day budgets, and leaves the rest `pending` for the next tick so work
// is preserved across stops. `url` is unique so re-enqueues are idempotent.
export const sourceIngestQueueTable = pgTable(
  "source_ingest_queue",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    url: text("url").notNull(),
    discoveredVia: text("discovered_via", { enum: SOURCE_DISCOVERY })
      .notNull()
      .default("manual_url"),
    leadSnippet: text("lead_snippet"),
    // Beat this URL was discovered for (carried onto the ingested document so
    // clustering can group within a beat). NULL for manual bulk enqueues.
    beatSlug: text("beat_slug"),
    approveLowQuality: boolean("approve_low_quality").notNull().default(false),
    status: text("status", { enum: SOURCE_QUEUE_STATUS }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    // The document produced once ingested (no DB FK: set null on delete in app).
    documentId: uuid("document_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("source_ingest_queue_url_key").on(t.url),
    index("source_ingest_queue_status_idx").on(t.status),
  ],
);

export const insertSourceDocumentSchema = createInsertSchema(sourceDocumentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertSourceChunkSchema = createInsertSchema(sourceChunksTable).omit({
  id: true,
  createdAt: true,
});

export type SourceDocument = typeof sourceDocumentsTable.$inferSelect;
export type InsertSourceDocument = z.infer<typeof insertSourceDocumentSchema>;
export type SourceChunk = typeof sourceChunksTable.$inferSelect;
export type InsertSourceChunk = z.infer<typeof insertSourceChunkSchema>;
export type SourceVaultJob = typeof sourceVaultJobsTable.$inferSelect;

export const insertSourceIngestQueueSchema = createInsertSchema(sourceIngestQueueTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type SourceIngestQueueItem = typeof sourceIngestQueueTable.$inferSelect;
export type InsertSourceIngestQueueItem = z.infer<typeof insertSourceIngestQueueSchema>;

// --- Source-to-concept edges (Task #338) ----------------------------------
// A durable link layer between ingested vault documents and glossary concepts,
// computed DETERMINISTICALLY (word-boundary term/alias matching — no per-doc
// LLM cost) when a document reaches extracted/embedded status, and kept in
// sync by the hourly glossary reconcile. Powers concept-aware evidence
// retrieval (query expansion + edge-linked candidate blending) and the admin
// "documents linked to this concept" view. Edges NEVER change evidence
// eligibility: glossary-lane documents stay evidence_eligible = false.

/** One matched span the tagger recorded for an edge (admin display + audit). */
export interface ConceptEdgeMatchedSection {
  /** Where the match occurred. */
  field: "title" | "text";
  /** The concept term or alias that matched (as stored, not as it appeared). */
  term: string;
  /** ~160 chars of surrounding text centred on the first occurrence. */
  snippet: string;
  /** Occurrences of this term/alias within the field. */
  count: number;
}

export const sourceConceptEdgesTable = pgTable(
  "source_concept_edges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceDocumentId: uuid("source_document_id")
      .notNull()
      .references(() => sourceDocumentsTable.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => conceptsTable.id, { onDelete: "cascade" }),
    // Deterministic confidence (0–1) from match density + a title-hit boost.
    confidence: real("confidence").notNull().default(0),
    matchedSections: jsonb("matched_sections")
      .$type<ConceptEdgeMatchedSection[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("source_concept_edges_unique").on(t.sourceDocumentId, t.conceptId),
    index("source_concept_edges_concept_idx").on(t.conceptId),
    index("source_concept_edges_document_idx").on(t.sourceDocumentId),
  ],
);

export type SourceConceptEdge = typeof sourceConceptEdgesTable.$inferSelect;
export type InsertSourceConceptEdge = typeof sourceConceptEdgesTable.$inferInsert;
