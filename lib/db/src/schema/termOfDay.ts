import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  real,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { conceptsTable } from "./concepts";

// Lifecycle of a daily Term of the Day post.
//  - draft   — selected + caption built but held for admin review (draft-only
//              mode); never sent to Zernio yet.
//  - posting — a run has claimed this date and the Zernio create is in flight.
//  - posted  — Zernio confirmed the post (or an idempotent 409 duplicate).
//  - failed  — the Zernio create permanently failed; the date is re-claimable.
//  - skipped — the daily run found no eligible term (row records the reason).
export const TERM_OF_DAY_STATUSES = ["draft", "posting", "posted", "failed", "skipped"] as const;
export type TermOfDayStatus = (typeof TERM_OF_DAY_STATUSES)[number];

// One row per Term of the Day attempt. The row doubles as the cooldown ledger
// (a concept posted < N days ago is ineligible), the beat-balance window (last
// 14 posted rows), the idempotency claim for a date (partial unique below), and
// the engagement history that feeds the capped performance bonus.
export const termOfDayPostsTable = pgTable(
  "term_of_day_posts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => conceptsTable.id, { onDelete: "cascade" }),
    // Snapshots so history stays readable even if the concept is later edited.
    slug: text("slug").notNull(),
    term: text("term").notNull(),
    // Dominant beat (category slug) of the concept's connected published
    // articles at selection time — drives the recent-beat balancing penalty.
    beatSlug: text("beat_slug").notNull().default(""),
    // UTC calendar date this post belongs to (YYYY-MM-DD). The partial unique
    // index below enforces at most ONE non-failed row per (date, slot), which
    // is the "retries never double-post" guarantee.
    postDate: text("post_date").notNull(),
    // Daily posting slot (1 = primary hour, 2 = second hour). Slot identity is
    // the slot NUMBER, not the hour, so changing the configured hours in
    // settings never re-opens an already-claimed slot for the day.
    slot: integer("slot").notNull().default(1),

    // --- Post content snapshot (what actually went/goes out) -----------------
    caption: text("caption").notNull().default(""),
    hashtags: jsonb("hashtags").$type<string[]>().notNull().default([]),
    trackedUrl: text("tracked_url").notNull().default(""),
    imageUrl: text("image_url"),
    // Published article ids connected to the concept at selection time.
    relatedArticleIds: jsonb("related_article_ids").$type<string[]>().notNull().default([]),
    // Admin-requested AI caption rewrite, cached so retries never re-bill.
    rewrittenCaption: text("rewritten_caption"),

    // --- Selection audit ------------------------------------------------------
    selectionWeight: real("selection_weight").notNull().default(0),
    // Major weight adjustments applied, e.g. [{"reason":"never_used","delta":"+2"}].
    weightBreakdown: jsonb("weight_breakdown")
      .$type<Array<{ reason: string; delta: string }>>()
      .notNull()
      .default([]),

    status: text("status", { enum: TERM_OF_DAY_STATUSES }).notNull().default("posting"),
    failureReason: text("failure_reason"),

    // --- Zernio traceability ---------------------------------------------------
    // Idempotency key sent as x-request-id, fixed at row creation so a retried
    // create for the same date can never double-post.
    zernioRequestId: uuid("zernio_request_id").notNull().defaultRandom(),
    zernioPostId: text("zernio_post_id"),
    facebookPostUrl: text("facebook_post_url"),

    // --- Engagement (backfilled when available; feeds the capped bonus) --------
    clicks: integer("clicks"),
    reactions: integer("reactions"),
    comments: integer("comments"),
    shares: integer("shares"),
    totalEngagement: integer("total_engagement"),

    selectedAt: timestamp("selected_at", { withTimezone: true }).notNull().defaultNow(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one ACTIVE (non-failed) row per UTC date + slot: 'posting'
    // claims the (date, slot) before the Zernio call, so concurrent/retried
    // runs lose the insert race instead of double-posting. A 'failed' row
    // releases the slot.
    uniqueIndex("term_of_day_posts_date_slot_active_uniq")
      .on(t.postDate, t.slot)
      .where(sql`${t.status} <> 'failed'`),
    index("term_of_day_posts_concept_idx").on(t.conceptId),
    index("term_of_day_posts_status_idx").on(t.status),
    index("term_of_day_posts_posted_at_idx").on(t.postedAt),
  ],
);

export type TermOfDayPost = typeof termOfDayPostsTable.$inferSelect;
export type TermOfDayPostInsert = typeof termOfDayPostsTable.$inferInsert;
