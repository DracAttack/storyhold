import { pgTable, text, timestamp, uuid, unique } from "drizzle-orm/pg-core";
import { articlesTable } from "./articles";

// One row per (article, platform) social-distribution attempt. Tracks whether an
// article has been pushed to an external social network (currently Facebook via
// the Zernio API) so the automated publish hook never double-posts and the admin
// "Post to Facebook" button can report status. No PII — just the article link,
// the platform, the latest attempt status, and the provider's post id.
export const socialPostsTable = pgTable(
  "social_posts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articlesTable.id, { onDelete: "cascade" }),
    // Currently always "facebook"; kept as a column so adding networks later is
    // additive and the uniqueness guard is per-platform.
    platform: text("platform").notNull().default("facebook"),
    // "pending" | "posted" | "failed".
    status: text("status").notNull().default("pending"),
    // The provider's post id (Zernio post._id) on success, for traceability.
    externalId: text("external_id"),
    // Short failure reason on the latest failed attempt (cleared on success).
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
  },
  (t) => [unique("social_posts_article_id_platform_unique").on(t.articleId, t.platform)],
);

export type SocialPost = typeof socialPostsTable.$inferSelect;
