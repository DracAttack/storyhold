import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const utmPresetsTable = pgTable("utm_presets", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  source: text("source").notNull(),
  medium: text("medium").notNull(),
  campaign: text("campaign").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UtmPreset = typeof utmPresetsTable.$inferSelect;
