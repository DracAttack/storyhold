import { pgTable, text, uuid, real, timestamp, index } from "drizzle-orm/pg-core";
import { articlesTable } from "./articles";

// One row per near-duplicate pair surfaced by the daily AI dedup scan.
// `newerArticleId` is the QUARANTINED offender (the later-published of the
// pair); `olderArticleId` is the original it duplicates (shown as the "original"
// link in the admin review screen). `reason` is the AI's plain-English summary
// of why the two are substantially similar.
//
// Lifecycle of `status`:
//   pending → the offender is currently quarantined, awaiting admin review.
//   kept    → admin clicked "Keep": offender un-quarantined AND this pair is
//             remembered so the scan NEVER re-flags it ("overlook if previously
//             kept"). The row is retained purely as that memory.
//   deleted → admin clicked "Delete": the offender article is hard-deleted; the
//             cascade removes this row, so `deleted` is mostly transient.
//
// Both FKs cascade-delete: if either article is removed elsewhere the review
// row disappears with it (a kept-memory only matters while both still exist).
export const duplicateReviewsTable = pgTable(
  "duplicate_reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    newerArticleId: uuid("newer_article_id")
      .notNull()
      .references(() => articlesTable.id, { onDelete: "cascade" }),
    olderArticleId: uuid("older_article_id")
      .notNull()
      .references(() => articlesTable.id, { onDelete: "cascade" }),
    reason: text("reason").notNull().default(""),
    score: real("score").notNull().default(0),
    status: text("status", { enum: ["pending", "kept", "deleted"] }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [
    index("duplicate_reviews_status_idx").on(t.status),
    index("duplicate_reviews_newer_idx").on(t.newerArticleId),
    index("duplicate_reviews_older_idx").on(t.olderArticleId),
  ],
);

export type DuplicateReview = typeof duplicateReviewsTable.$inferSelect;
