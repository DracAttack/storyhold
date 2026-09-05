import { pgTable, text, integer, boolean, timestamp, jsonb, uuid } from "drizzle-orm/pg-core";

// The general composition layouts the magick composer knows how to render.
// A curated/custom template declares which layout its text-area set targets.
//  - explainer — square photo on top + a TALL solid panel below holding an
//    optional short headline and a multi-sentence body paragraph (the longer
//    "explainer" format for political/science deep-dives).
export const MEME_LAYOUTS = ["classic_top_bottom", "split_panel", "headline_caption", "explainer"] as const;
export type MemeLayout = (typeof MEME_LAYOUTS)[number];

// One placement box for a single text field, expressed in FRACTIONS (0..1) of
// the composed image's width/height so a template renders correctly at any
// output size. `key` ties the box to a meme text field (e.g. "top", "bottom",
// "extra", or panel-specific keys like "left"/"right" for split-panel).
export interface MemeTextArea {
  key: string;
  label: string;
  // Bounding box as fractions of the image (x,y = top-left corner).
  x: number;
  y: number;
  width: number;
  height: number;
  // Relative font size as a fraction of image height (e.g. 0.08).
  fontSize: number;
  // Horizontal/vertical alignment within the box.
  align: "left" | "center" | "right";
  valign: "top" | "middle" | "bottom";
  // Hex fill + whether to draw the classic outlined/shadowed meme text.
  color: string;
  outline: boolean;
  // Force uppercase (classic impact-style meme text).
  uppercase: boolean;
}

// Admin-managed library of reusable meme templates. Curated "mainstream"
// templates (Morpheus, Drake, etc.) are seeded with their text-area definitions
// and license notes; admins can also upload their own or save a custom layout.
export const memeTemplatesTable = pgTable("meme_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Human name + a stable, searchable slug (the "templateId" in the spec).
  name: text("name").notNull(),
  // Name the unique constraint to match the live DB. The table is created by the
  // API server's boot DDL (`ensureRuntimeTables`) as `"slug" text NOT NULL UNIQUE`,
  // which Postgres names `meme_templates_slug_key` by default. An unnamed
  // `.unique()` here would make Drizzle expect `meme_templates_slug_unique` and
  // emit an interactive "add constraint" prompt on every `drizzle-kit push`.
  slug: text("slug").notNull().unique("meme_templates_slug_key"),
  // Public object-storage URL of the template base image.
  imageUrl: text("image_url").notNull(),
  // Which composer layout this template's text areas target.
  layout: text("layout").$type<MemeLayout>().notNull().default("classic_top_bottom"),
  // Where the image came from + any reuse/license caveats (curated meme formats
  // are widely reused but we record provenance so admins can judge fitness).
  sourceNotes: text("source_notes").notNull().default(""),
  licenseNotes: text("license_notes").notNull().default(""),
  // Placement boxes for the editable text fields on this template.
  textAreas: jsonb("text_areas").$type<MemeTextArea[]>().notNull().default([]),
  // How many text fields this template expects (UI hint).
  recommendedFieldCount: integer("recommended_field_count").notNull().default(2),
  defaultFont: text("default_font").notNull().default("DejaVuSans-Bold"),
  defaultAlignment: text("default_alignment").notNull().default("center"),
  // Disabled templates stay in the library for history but aren't offered.
  active: boolean("active").notNull().default(true),
  // Curated seed rows are flagged so a re-seed can heal them without clobbering
  // admin-authored templates.
  isCurated: boolean("is_curated").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MemeTemplate = typeof memeTemplatesTable.$inferSelect;
export type NewMemeTemplate = typeof memeTemplatesTable.$inferInsert;
