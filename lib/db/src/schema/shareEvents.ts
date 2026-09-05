import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";

// One row per click on an article Share button. Kept intentionally lean: the
// article slug + a snapshot of its title (so the admin report survives an
// article rename/delete), the platform shared to, and when. No PII is stored.
export const shareEventsTable = pgTable(
  "share_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    articleSlug: text("article_slug").notNull(),
    articleTitle: text("article_title").notNull(),
    platform: text("platform").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("share_events_slug_idx").on(t.articleSlug),
    index("share_events_platform_idx").on(t.platform),
  ],
);

export type ShareEvent = typeof shareEventsTable.$inferSelect;
