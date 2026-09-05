import {
  pgTable,
  text,
  integer,
  real,
  timestamp,
  uuid,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sourceDocumentsTable } from "./sourceVault";
import { articlesTable } from "./articles";

export const CLAIM_TYPES = [
  "finding",
  "statistic",
  "causal",
  "association",
  "definition",
  "recommendation",
  "observation",
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export const CLAIM_CERTAINTY = ["definitive", "qualified", "speculative", "disputed"] as const;
export type ClaimCertainty = (typeof CLAIM_CERTAINTY)[number];

export const CLAIM_STATUS = ["extracted", "reconciled", "low_quality", "failed"] as const;
export type ClaimStatus = (typeof CLAIM_STATUS)[number];

export const CLAIM_RELATIONSHIP_TYPES = [
  "supports",
  "independently_corroborates",
  "partially_supports",
  "qualifies",
  "contradicts",
  "different_population",
  "different_definition",
  "same_family_repeat",
] as const;
export type ClaimRelationshipType = (typeof CLAIM_RELATIONSHIP_TYPES)[number];

export const vaultClaimsTable = pgTable(
  "vault_claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceDocumentId: uuid("source_document_id")
      .notNull()
      .references(() => sourceDocumentsTable.id, { onDelete: "cascade" }),
    sourceFamilyId: uuid("source_family_id"),
    // source_chunks use UUID primary keys, so this is a UUID array even though
    // the original feature brief called it an integer array.
    sourceChunkIds: uuid("source_chunk_ids").array().notNull().default([]),
    claim: text("claim").notNull(),
    claimType: text("claim_type", { enum: CLAIM_TYPES }).notNull(),
    subject: text("subject").notNull(),
    relationship: text("relationship").notNull(),
    object: text("object").notNull(),
    context: text("context"),
    population: text("population"),
    timeframe: text("timeframe"),
    geographicScope: text("geographic_scope"),
    qualifiers: jsonb("qualifiers").$type<Record<string, unknown>>().notNull().default({}),
    certainty: text("certainty", { enum: CLAIM_CERTAINTY }).notNull(),
    exactEvidenceSpan: text("exact_evidence_span").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    status: text("status", { enum: CLAIM_STATUS }).notNull().default("extracted"),
    overrideText: text("override_text"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("vault_claims_document_status_idx").on(t.sourceDocumentId, t.status),
    index("vault_claims_family_idx").on(t.sourceFamilyId),
    index("vault_claims_created_idx").on(t.createdAt),
  ],
);

export const claimRelationshipsTable = pgTable(
  "claim_relationships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    claimAId: uuid("claim_a_id")
      .notNull()
      .references(() => vaultClaimsTable.id, { onDelete: "cascade" }),
    claimBId: uuid("claim_b_id")
      .notNull()
      .references(() => vaultClaimsTable.id, { onDelete: "cascade" }),
    relationshipType: text("relationship_type", { enum: CLAIM_RELATIONSHIP_TYPES }).notNull(),
    confidence: real("confidence").notNull().default(0),
    reconcilerModel: text("reconciler_model").notNull(),
    notes: text("notes"),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("claim_relationships_pair_key").on(t.claimAId, t.claimBId),
    index("claim_relationships_a_idx").on(t.claimAId),
    index("claim_relationships_b_idx").on(t.claimBId),
  ],
);

export const articleClaimUsesTable = pgTable(
  "article_claim_uses",
  {
    articleId: uuid("article_id")
      .notNull()
      .references(() => articlesTable.id, { onDelete: "cascade" }),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => vaultClaimsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("article_claim_uses_key").on(t.articleId, t.claimId),
    index("article_claim_uses_claim_idx").on(t.claimId),
  ],
);

export const claimExtractionReceiptsTable = pgTable(
  "claim_extraction_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceDocumentId: uuid("source_document_id")
      .notNull()
      .references(() => sourceDocumentsTable.id, { onDelete: "cascade" }),
    extractorVersion: text("extractor_version").notNull(),
    contentHash: text("content_hash"),
    status: text("status").notNull().default("succeeded"),
    sectionsProcessed: integer("sections_processed").notNull().default(0),
    claimsExtracted: integer("claims_extracted").notNull().default(0),
    provider: text("provider").notNull().default("anthropic"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("claim_extraction_receipts_document_version_key").on(
      t.sourceDocumentId,
      t.extractorVersion,
    ),
    index("claim_extraction_receipts_status_idx").on(t.status, t.updatedAt),
  ],
);

export const claimCalibrationRunsTable = pgTable("claim_calibration_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  status: text("status").notNull().default("running"),
  documentsSampled: integer("documents_sampled").notNull().default(0),
  sectionsProcessed: integer("sections_processed").notNull().default(0),
  claimsExtracted: integer("claims_extracted").notNull().default(0),
  noClaimSections: integer("no_claim_sections").notNull().default(0),
  noClaimDocuments: integer("no_claim_documents").notNull().default(0),
  filterCounts: jsonb("filter_counts").$type<Record<string, number>>().notNull().default({}),
  invalidJsonCount: integer("invalid_json_count").notNull().default(0),
  spanVerificationFailures: integer("span_verification_failures").notNull().default(0),
  duplicateRate: real("duplicate_rate").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  costPerSource: real("cost_per_source").notNull().default(0),
  costPerUsefulClaim: real("cost_per_useful_claim").notNull().default(0),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const claimCalibrationResultsTable = pgTable(
  "claim_calibration_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => claimCalibrationRunsTable.id, { onDelete: "cascade" }),
    sourceDocumentId: uuid("source_document_id")
      .notNull()
      .references(() => sourceDocumentsTable.id, { onDelete: "cascade" }),
    sourceChunkIds: uuid("source_chunk_ids").array().notNull().default([]),
    claims: jsonb("claims").$type<Record<string, unknown>[]>().notNull().default([]),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    invalidJson: integer("invalid_json").notNull().default(0),
    spanFailures: integer("span_failures").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("claim_calibration_results_run_idx").on(t.runId)],
);

export type VaultClaim = typeof vaultClaimsTable.$inferSelect;
export type ClaimRelationship = typeof claimRelationshipsTable.$inferSelect;
export type ClaimExtractionReceipt = typeof claimExtractionReceiptsTable.$inferSelect;
