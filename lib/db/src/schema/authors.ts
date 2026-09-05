import { pgTable, text, integer, boolean, timestamp, jsonb, uuid, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const authorsTable = pgTable("authors", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  bio: text("bio").notNull(),
  avatarUrl: text("avatar_url").notNull(),
  category: text("category").notNull(),
  categorySlug: text("category_slug").notNull(),
  voicePrompt: text("voice_prompt").notNull(),
  sampleParagraphs: jsonb("sample_paragraphs").$type<string[]>().notNull().default([]),
  wordCountTarget: integer("word_count_target").notNull().default(2200),
  cadence: text("cadence", {
    enum: ["daily", "twice_weekly", "weekly", "biweekly", "monthly"],
  })
    .notNull()
    .default("daily"),
  weekday: integer("weekday"),
  // Second publishing weekday, used only by the `twice_weekly` cadence.
  secondWeekday: integer("second_weekday"),
  // Day-of-month (1–28) the `monthly` cadence publishes on.
  dayOfMonth: integer("day_of_month"),
  // When true (default), the author's publishing day(s)/hour are re-randomized
  // after each post (see rotateAuthorsAfterPublish). When false, the schedule
  // stays fixed on the configured day/time. Daily authors are unaffected.
  randomizeSchedule: boolean("randomize_schedule").notNull().default(true),
  bannedTopics: jsonb("banned_topics").$type<string[]>().notNull().default([]),
  // Adjacent beats this author can also write in. Stored as categorySlug
  // strings. The primary `category`/`categorySlug` is always implicitly
  // included in the author's writable lane.
  subBeats: jsonb("sub_beats").$type<string[]>().notNull().default([]),
  active: boolean("active").notNull().default(true),
  model: text("model").notNull().default("claude-sonnet-4-6"),
  temperature: numeric("temperature", { precision: 3, scale: 2 }).notNull().default("1.00"),
  maxTokens: integer("max_tokens").notNull().default(8192),
  // Political-compass coordinates fed into the persona prompt.
  // economicAxis: -10 (far left) … 0 (centrist) … +10 (far right)
  // socialAxis:   -10 (libertarian) … 0 (centrist) … +10 (authoritarian)
  economicAxis: numeric("economic_axis", { precision: 3, scale: 1 }).notNull().default("0.0"),
  socialAxis: numeric("social_axis", { precision: 3, scale: 1 }).notNull().default("0.0"),
  // UTC hour-of-day (0–23) when this author's pipeline slot fires. Spreading
  // authors across hours avoids one giant LLM batch.
  runHourUtc: integer("run_hour_utc").notNull().default(14),
  // Voice-craft fields — short, opinionated guidance that gets injected into
  // the system prompt. All optional; blank fields are skipped.
  tone: text("tone"),
  sentenceRhythm: text("sentence_rhythm"),
  vocabularyQuirks: text("vocabulary_quirks"),
  signatureMove: text("signature_move"),
  corePromise: text("core_promise"),
  avoid: text("avoid"),
  // How this author translates dense research, mechanisms, and specialist
  // material without dropping into the source's register. Optional; every
  // author still receives the shared technical re-voicing rules.
  technicalExplanationStyle: text("technical_explanation_style"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAuthorSchema = createInsertSchema(authorsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Author = typeof authorsTable.$inferSelect;
export type InsertAuthor = z.infer<typeof insertAuthorSchema>;
