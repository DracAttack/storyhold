import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";

// One row per lifecycle event of the on-article "Swipe right to read the next
// article" prompt. `eventType` is "impression" (prompt shown), "activation"
// (reader took the suggestion) or "dismissal" (reader closed it). `method` is
// only set on activation — "swipe" for a real rightward touch gesture, "click"
// for a desktop click. `articleSlug` is the article the prompt appeared on;
// `targetSlug` is the rank-1 related article it pointed to. Lets the admin
// report measure prompt conversion. No PII — anonymous visitor/session UUIDs.
export const swipeEventsTable = pgTable(
  "swipe_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    visitorId: text("visitor_id"),
    sessionId: text("session_id"),
    articleSlug: text("article_slug").notNull(),
    targetSlug: text("target_slug"),
    eventType: text("event_type").notNull(),
    method: text("method"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("swipe_events_type_idx").on(t.eventType),
    index("swipe_events_session_idx").on(t.sessionId),
  ],
);

export type SwipeEvent = typeof swipeEventsTable.$inferSelect;
