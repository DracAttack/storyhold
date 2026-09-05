import { pgTable, text, timestamp, uuid, integer, index } from "drizzle-orm/pg-core";

// One row per click on an INTERNAL recommendation/navigation surface (a link
// that sends the reader to another BrainHook article). Powers the admin Reader
// Journeys report's "which recommendation slots actually get clicked" view.
//
// `placement` is the surface the link lived in (inline_auto, inline_manual,
// more_like_this, swipe_next, homepage, category_page, author_page, search).
// `recommendationRank` is the related-article rank when applicable — the
// "More like this" rail occupies ranks 1-3 and the auto inline callouts ranks
// 4-6 of the same /related ordering, so a click's rank ties back to exactly
// which suggestion was taken (null on feed surfaces that have no ranked order).
// `interactionType` is "click" for a normal click and "swipe" for the swipe-next
// prompt's touch gesture. `fromSlug` is where the click happened (an article
// slug, or a page key like "home"/"category"); `toSlug` is the destination
// article. No PII — identity is the anonymous visitor/session UUIDs only.
export const internalClicksTable = pgTable(
  "internal_clicks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    visitorId: text("visitor_id"),
    sessionId: text("session_id"),
    fromSlug: text("from_slug"),
    toSlug: text("to_slug").notNull(),
    toTitle: text("to_title"),
    placement: text("placement").notNull(),
    recommendationRank: integer("recommendation_rank"),
    interactionType: text("interaction_type").notNull().default("click"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("internal_clicks_placement_idx").on(t.placement),
    index("internal_clicks_session_idx").on(t.sessionId),
    index("internal_clicks_to_slug_idx").on(t.toSlug),
  ],
);

export type InternalClick = typeof internalClicksTable.$inferSelect;
