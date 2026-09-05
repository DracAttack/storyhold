import { pgTable, text, timestamp, uuid, integer, numeric, index } from "drizzle-orm/pg-core";

// One row per billable AI call (the cost meter). Records WHICH model/provider was
// used, for WHICH pipeline operation, the token counts and web-search count it
// reported, and the dollar cost computed AT THE TIME OF THE CALL (so historical
// rows keep the price they were actually billed at, even if the rate table later
// changes). `authorSlug` is captured when the call is author-scoped (idea gen,
// draft) so spend can be attributed; it's null for global ops (dedupe judge,
// etc.). `articleId` / `memeId` link a call to a specific piece of content so
// the admin can see per-article and per-meme AI spend. Runtime-only analytics
// table — created via ensureRuntimeTables boot DDL, mirroring page_views. No PII.
export const aiUsageEventsTable = pgTable(
  "ai_usage_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // "anthropic" (text) or "gemini" (image).
    provider: text("provider").notNull(),
    // Logical model id, e.g. "claude-sonnet-4-6", "gemini-3-pro-image-preview".
    model: text("model").notNull(),
    // Pipeline operation, e.g. "generateArticleDraft", "generateHooksAndSocialPack".
    operation: text("operation").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    webSearches: integer("web_searches").notNull().default(0),
    // Number of images generated (image ops only; text ops record 0).
    images: integer("images").notNull().default(0),
    // Dollar cost, computed at call time. numeric(12,6) keeps sub-cent precision.
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    // Author the call was made on behalf of, when applicable (else null).
    authorSlug: text("author_slug"),
    // Content attribution — link the spend to a specific article or meme so the
    // admin can see per-article / per-meme cost breakdowns. Null for calls that
    // aren't scoped to a single piece of content (idea generation, dedupe, etc.).
    articleId: text("article_id"),
    memeId: text("meme_id"),
    // Trend-intelligence attribution — link the spend to the story cluster and/or
    // screened evidence packet it was made for (editorial screen + packet-grounded
    // drafts) so per-cluster / per-packet AI cost can be reported. Null for calls
    // that aren't cluster/packet-scoped (normal pipeline, dedupe, memes, etc.).
    clusterId: text("cluster_id"),
    packetId: text("packet_id"),
    // Source-link insertion mode in effect for this call (Task #226): off /
    // vault_only / vault_first_with_capped_search / legacy_web_search. Null for
    // ops that aren't source-link insertion.
    mode: text("mode"),
    // Human-readable audit reason for the call (Task #226) — e.g. the web-search
    // queries the model actually ran, or a "no-search; pool=N" note when the
    // packet/vault pool covered it without any paid search. Null for ops that
    // don't record a reason.
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_usage_events_created_idx").on(t.createdAt),
    index("ai_usage_events_model_idx").on(t.model),
    index("ai_usage_events_op_idx").on(t.operation),
    index("ai_usage_events_article_idx").on(t.articleId),
    index("ai_usage_events_meme_idx").on(t.memeId),
    index("ai_usage_events_cluster_idx").on(t.clusterId),
    index("ai_usage_events_packet_idx").on(t.packetId),
  ],
);

export type AiUsageEvent = typeof aiUsageEventsTable.$inferSelect;
