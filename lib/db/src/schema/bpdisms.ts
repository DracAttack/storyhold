// BPD-isms Post Queue — imported standalone app, fully firewalled from the
// BrainHook content pipeline. All tables are namespaced with a bpdisms_ prefix
// so they can never collide with the main app's social_posts / site_settings /
// posting tables. Only the bpdisms-api artifact reads or writes these tables.
import { pgTable, serial, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const bpdismsAppSettingsTable = pgTable("bpdisms_app_settings", {
  id: serial("id").primaryKey(),
  timezone: text("timezone").notNull().default("America/Phoenix"),
  destinationId: text("destination_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBpdismsAppSettingsSchema = createInsertSchema(bpdismsAppSettingsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertBpdismsAppSettings = z.infer<typeof insertBpdismsAppSettingsSchema>;
export type BpdismsAppSettings = typeof bpdismsAppSettingsTable.$inferSelect;

export const bpdismsPostingSlotsTable = pgTable("bpdisms_posting_slots", {
  id: serial("id").primaryKey(),
  timeOfDay: text("time_of_day").notNull(),
  daysOfWeekJson: text("days_of_week_json").notNull().default('["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]'),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBpdismsPostingSlotSchema = createInsertSchema(bpdismsPostingSlotsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertBpdismsPostingSlot = z.infer<typeof insertBpdismsPostingSlotSchema>;
export type BpdismsPostingSlot = typeof bpdismsPostingSlotsTable.$inferSelect;

export const bpdismsSocialPostsTable = pgTable("bpdisms_social_posts", {
  id: serial("id").primaryKey(),
  imageUrl: text("image_url").notNull(),
  imageStorageKey: text("image_storage_key").notNull(),
  originalFilename: text("original_filename").notNull(),
  caption: text("caption").notNull().default(""),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  timezone: text("timezone").notNull().default("America/Phoenix"),
  status: text("status").notNull().default("draft"),
  provider: text("provider").notNull().default("zernio"),
  providerPostId: text("provider_post_id"),
  providerResponseJson: text("provider_response_json"),
  errorMessage: text("error_message"),
  retryCount: integer("retry_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  postedAt: timestamp("posted_at", { withTimezone: true }),
});

export const insertBpdismsSocialPostSchema = createInsertSchema(bpdismsSocialPostsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertBpdismsSocialPost = z.infer<typeof insertBpdismsSocialPostSchema>;
export type BpdismsSocialPost = typeof bpdismsSocialPostsTable.$inferSelect;
