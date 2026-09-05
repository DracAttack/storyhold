import { pgTable, text, timestamp, uuid, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const beatsTable = pgTable("beats", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Named to match the constraint already present in existing databases
  // (Postgres' default `beats_slug_key`). Leaving it unnamed makes drizzle-kit
  // expect `beats_slug_unique` and try to re-add an already-existing unique
  // constraint on every push — an interactive data-loss prompt that blocks deploy.
  slug: text("slug").notNull().unique("beats_slug_key"),
  name: text("name").notNull(),
  description: text("description"),
  // Optional editor override for the category page's search/social meta
  // description. When null, the site derives one from `description`.
  seoDescription: text("seo_description"),
  slant: text("slant"),
  heroImageUrl: text("hero_image_url"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertBeatSchema = createInsertSchema(beatsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type Beat = typeof beatsTable.$inferSelect;
export type InsertBeat = z.infer<typeof insertBeatSchema>;
