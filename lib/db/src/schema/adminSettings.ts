import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const adminSettingsTable = pgTable("admin_settings", {
  email: text("email").primaryKey(),
  digestEnabled: boolean("digest_enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AdminSettings = typeof adminSettingsTable.$inferSelect;
