import { pgTable, text, integer, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { authorsTable } from "./authors";

// A single scouted "trend signal": a fresh, source-grounded article hook the
// editor can judge and Draft before any AI drafting happens. Produced by the
// Trend Radar scan (web-search-grounded LLM), one row per proposed angle.
export const trendSignalsTable = pgTable("trend_signals", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Which beat this signal targets (slug + display name).
  beatSlug: text("beat_slug").notNull(),
  beat: text("beat").notNull(),
  // The real-world source/event backing the hook, and the verified source URL.
  source: text("source").notNull(),
  sourceUrl: text("source_url").notNull(),
  event: text("event").notNull(),
  // The proposed BrainHook headline + angle.
  headline: text("headline").notNull(),
  angle: text("angle").notNull(),
  // Best-fit author/persona for this hook (validated against active authors).
  suggestedAuthorId: uuid("suggested_author_id").references(() => authorsTable.id, { onDelete: "set null" }),
  suggestedAuthorName: text("suggested_author_name"),
  // 0-100 scores, clamped server-side.
  urgencyScore: integer("urgency_score").notNull().default(0),
  riskScore: integer("risk_score").notNull().default(0),
  riskReason: text("risk_reason"),
  // new = awaiting an editor; drafted = sent to the draft pipeline; dismissed.
  status: text("status", { enum: ["new", "drafted", "dismissed"] }).notNull().default("new"),
  // Links populated once drafted, so the signal isn't re-proposed.
  ideaId: uuid("idea_id"),
  articleId: uuid("article_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTrendSignalSchema = createInsertSchema(trendSignalsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type TrendSignal = typeof trendSignalsTable.$inferSelect;
export type InsertTrendSignal = z.infer<typeof insertTrendSignalSchema>;
