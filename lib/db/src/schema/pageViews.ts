import { pgTable, text, timestamp, uuid, integer, index } from "drizzle-orm/pg-core";

// One row per article page view. Mirrors share_events: the article slug + a
// snapshot of its title (so the report survives an article rename/delete) and
// when it was viewed. Also captures a COARSE traffic-source attribution (derived
// client-side from the landing URL's UTM params, else the external referrer host,
// else "direct") so the admin report can show WHERE views came from, not just
// totals. No PII is stored — the referrer is reduced to its bare host.
//
// Reader-journey columns (also nullable — legacy rows predate them) thread an
// ANONYMOUS, first-party identity through a visit: `visitorId` is a random UUID
// persisted in the reader's localStorage (no PII, never tied to a real person)
// and `sessionId` is a rolling random UUID that renews after 30 min of
// inactivity. `previousSlug`/`entrySlug`/`viewSequence` describe this view's
// place in the session's path (the slug viewed just before, the session's first
// article, and the 1-based position in the session). Together they let the admin
// Reader Journeys report reconstruct recirculation and reading paths without any
// cross-site tracking or personal data.
export const pageViewsTable = pgTable(
  "page_views",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    articleSlug: text("article_slug").notNull(),
    articleTitle: text("article_title").notNull(),
    // Traffic-source attribution (nullable — legacy rows predate it). `source`
    // and `medium` are the derived, normalized values the report groups on
    // (e.g. "facebook"/"social", a referrer host/"referral", or "direct"/"none");
    // `campaign`/`content` carry the raw UTM extras; `referrerHost` is the bare
    // referring domain when present.
    source: text("source"),
    medium: text("medium"),
    campaign: text("campaign"),
    content: text("content"),
    referrerHost: text("referrer_host"),
    // Anonymous reader-journey identity + path position (all nullable).
    visitorId: text("visitor_id"),
    sessionId: text("session_id"),
    previousSlug: text("previous_slug"),
    entrySlug: text("entry_slug"),
    viewSequence: integer("view_sequence"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("page_views_slug_idx").on(t.articleSlug),
    index("page_views_source_idx").on(t.source),
    index("page_views_session_idx").on(t.sessionId),
    index("page_views_visitor_idx").on(t.visitorId),
  ],
);

export type PageView = typeof pageViewsTable.$inferSelect;
