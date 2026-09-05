import { pgTable, timestamp, uuid, text, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Racing-cooldown tracker for the development signal detector. One row per
// story cluster; upserted each time a signal fires for that cluster. A new
// signal is suppressed when last_signal_at is within the last 2 hours —
// preventing simultaneous vault ingests from spawning duplicate draft jobs
// before any finish. The novelty gate (keyword + LLM) is the real re-fire
// protection; this is just a practical race guard.
//
// Signal lifecycle (status column):
//   pending   — signal fired; update article not yet generated.
//   consumed  — generateUpdateArticle succeeded (or was suppressed as redundant);
//               future scans skip this row unless genuinely new triggering docs appear.
//   exhausted — generation failed MAX_SIGNAL_RETRIES times; no further immediate retry.
//               The scanner auto-resets an exhausted row back to pending after 24 h
//               (EXHAUSTED_RESET_MS in developmentSignalDetector.ts) so transient
//               errors cannot permanently suppress a cluster.
//
// Source of truth: lib/db/src/schema/storyUpdateSignals.ts
// Boot DDL: services/seed.ts ensureRuntimeTables

export const storyUpdateSignalsTable = pgTable(
  "story_update_signals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The cluster that fired. Unique — one tracking row per cluster.
    clusterId: uuid("cluster_id").notNull(),
    // Track that triggered: "corroboration" (Track A) or "authority" (Track B).
    trackType: text("track_type"),
    // IDs of the vault source documents that triggered this signal.
    triggeringDocIds: text("triggering_doc_ids").array(),
    // The article that will be drafted (set after enqueue).
    originalArticleId: uuid("original_article_id"),
    // Lifecycle status: pending | consumed | exhausted.
    status: text("status").notNull().default("pending"),
    // Retry counter — incremented on each failed generateUpdateArticle call.
    retryCount: integer("retry_count").notNull().default(0),
    // Set when the signal is marked consumed (generation succeeded or suppressed).
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    lastSignalAt: timestamp("last_signal_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("story_update_signals_cluster_idx").on(t.clusterId),
    index("story_update_signals_last_signal_idx").on(t.lastSignalAt),
    index("story_update_signals_status_idx").on(t.status),
  ],
);

export const insertStoryUpdateSignalSchema = createInsertSchema(storyUpdateSignalsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type StoryUpdateSignal = typeof storyUpdateSignalsTable.$inferSelect;
export type InsertStoryUpdateSignal = z.infer<typeof insertStoryUpdateSignalSchema>;
