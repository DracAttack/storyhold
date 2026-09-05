import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";

// Per-AI-function control rows for the admin AI Control Center. One row per
// stable function key (see services/aiRegistry.ts in the API server). A missing
// row means "enabled, no override" — the registry default directive is used.
// `directiveOverride` is the admin-edited steering text injected into that
// function's prompt; null means use the registry default.
export const aiSettingsTable = pgTable("ai_settings", {
  key: text("key").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  directiveOverride: text("directive_override"),
  // Admin model override for this function. null = use the registry default
  // model (see services/aiRegistry.ts AI_FUNCTION_ROUTING). Only meaningful for
  // text functions; image functions use a fixed Gemini model.
  modelOverride: text("model_override"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AiSettingRow = typeof aiSettingsTable.$inferSelect;
