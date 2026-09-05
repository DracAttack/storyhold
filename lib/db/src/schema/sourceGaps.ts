import {
  pgTable,
  text,
  integer,
  timestamp,
  uuid,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { articlesTable } from "./articles";

// --- Source Gaps (unsourced-claim backfill) -----------------------------
// Tracks claims in published article bodies that reference a specific year +
// publication but have no inline citation link. Each gap can be searched,
// dismissed, or marked as sourced once a matching URL is ingested.

export const SOURCE_GAP_STATUS = [
  "pending",
  "searching",
  "found",
  "ingested",
  "dismissed",
  "failed",
] as const;
export type SourceGapStatus = (typeof SOURCE_GAP_STATUS)[number];

export const sourceGapsTable = pgTable(
  "source_gaps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articlesTable.id, { onDelete: "cascade" }),
    // The unsourced claim text (sentence or phrase).
    claimText: text("claim_text").notNull(),
    // Full paragraph block text for surrounding context.
    contextText: text("context_text").notNull(),
    // Extracted publication / journal / institution name (best-effort).
    publicationHint: text("publication_hint"),
    // Extracted year from the claim (e.g. 2025).
    yearHint: integer("year_hint"),
    status: text("status", { enum: SOURCE_GAP_STATUS })
      .notNull()
      .default("pending"),
    // The search query actually sent (for auditing / reproduction).
    searchQuery: text("search_query"),
    // Results from the web search step.
    foundUrl: text("found_url"),
    foundTitle: text("found_title"),
    // Linked source_document once ingestion completes.
    sourceDocumentId: uuid("source_document_id"),
    // Admin-facing dismissal reason (optional free text).
    dismissReason: text("dismiss_reason"),
    // Perplexity snippet explaining why the found source matches the claim —
    // shown in the admin UI as a "defence" for the automated pick.
    rationale: text("rationale"),
    // When the link was woven into the article body (and trust box updated).
    weavedAt: timestamp("weaved_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("source_gaps_article_idx").on(t.articleId),
    index("source_gaps_status_idx").on(t.status),
    index("source_gaps_created_idx").on(t.createdAt),
    // Idempotency: one gap per (article, claim-text). Prevents duplicate rows
    // from concurrent scans or re-scans of the same article.
    unique("source_gaps_article_claim_idx").on(t.articleId, t.claimText),
  ],
);

export const insertSourceGapSchema = createInsertSchema(sourceGapsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type SourceGap = typeof sourceGapsTable.$inferSelect;
export type InsertSourceGap = z.infer<typeof insertSourceGapSchema>;
