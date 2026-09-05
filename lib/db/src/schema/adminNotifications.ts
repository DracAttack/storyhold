import { pgTable, text, timestamp, jsonb, uuid } from "drizzle-orm/pg-core";

export type DigestPayload = {
  draftsCreated: number;
  articlesPublished: number;
  pendingIdeas: Array<{ id: string; title: string; authorId: string; authorSlug: string; authorName: string }>;
  drafts: Array<{ id: string; title: string; authorId: string; authorName: string }>;
  recipients: string[];
};

/** Payload for "story_update_published" notifications (Tier 2 major update). */
export type StoryUpdatePublishedPayload = {
  articleId: string;
  slug: string;
  title: string;
  clusterId: string;
  clusterLabel: string;
  wordCount: number;
};

export const adminNotificationsTable = pgTable("admin_notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: text("type", { enum: ["daily_digest", "story_update_published"] }).notNull().default("daily_digest"),
  subject: text("subject").notNull(),
  bodyHtml: text("body_html").notNull(),
  bodyText: text("body_text").notNull(),
  payload: jsonb("payload").$type<DigestPayload | StoryUpdatePublishedPayload>().notNull(),
  recipients: jsonb("recipients").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AdminNotification = typeof adminNotificationsTable.$inferSelect;
