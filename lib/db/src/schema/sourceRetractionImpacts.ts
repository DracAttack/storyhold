import {
  pgTable,
  text,
  timestamp,
  uuid,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { articlesTable } from "./articles";

// --- Source retraction impact ledger (Task #329) -------------------------
// When a Source Vault document transitions to a non-active lifecycle status
// (retracted, unavailable, stale, superseded), this table records every
// article that cited it as evidence. The cascade service populates it
// fire-and-forget from the lifecycle recheck and mark-stale paths.
//
// One row per (source_document_id, article_id) pair — the unique index makes
// the cascade idempotent: a second cascade on the same (doc, article) is a
// silent no-op via ON CONFLICT DO NOTHING.
//
// Articles remain flagged (retraction_impact_at IS NOT NULL AND
// retraction_impact_cleared_at IS NULL) until either:
//   - The daily retraction_rescan cron finds the article still has enough
//     active trusted-tier sources and auto-clears (rescan_result = 'cleared')
//   - An editor clicks "Clear manually" in Admin → Source Health
//
// Packet impacts (stale_packet column on evidence_packets) are tracked on the
// packet row directly and are NOT duplicated here. This table is article-only.

export const sourceRetractionImpactsTable = pgTable(
  "source_retraction_impacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The source document whose lifecycle transition triggered this impact.
    // No DB FK (keeps boot-DDL healing simple; set null in app on doc delete).
    sourceDocumentId: uuid("source_document_id").notNull(),
    // The affected article.
    articleId: uuid("article_id")
      .notNull()
      .references(() => articlesTable.id, { onDelete: "cascade" }),
    // The lifecycle status at the moment the impact was recorded (e.g. "retracted").
    lifecycleStatus: text("lifecycle_status").notNull(),
    // When the impact was first recorded.
    impactedAt: timestamp("impacted_at", { withTimezone: true }).notNull().defaultNow(),
    // When the daily rescan last attempted to clear this impact.
    rescanAttemptedAt: timestamp("rescan_attempted_at", { withTimezone: true }),
    // Result of the most recent rescan. Null = not yet rescanned.
    // 'cleared'     = article still has active trusted-tier sources → impact cleared
    // 'still_flagged' = no active trusted-tier replacement → flag stays
    rescanResult: text("rescan_result"),
  },
  (t) => [
    // One row per (source, article): cascade is idempotent.
    uniqueIndex("source_retraction_impacts_source_article_key").on(
      t.sourceDocumentId,
      t.articleId,
    ),
    index("source_retraction_impacts_source_idx").on(t.sourceDocumentId),
    index("source_retraction_impacts_article_idx").on(t.articleId),
    index("source_retraction_impacts_impacted_idx").on(t.impactedAt),
  ],
);

export type SourceRetractionImpact = typeof sourceRetractionImpactsTable.$inferSelect;
