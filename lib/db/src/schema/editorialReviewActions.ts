import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// --- Editorial review actions (Task #202) ------------------------------
// Every one-click reject / promote an editor makes in the cockpit is recorded
// here so the editorial feedback loop has durable, structured signal to tune
// against. This is the ONLY new recorded data in the shadow-metrics chunk —
// every other metric (spend, source reuse, dedupe avoidance, quarantine /
// acceptance) is aggregated from tables that already record those outcomes
// (ai_usage_events, evidence_packets, articles). Nothing here is estimated.
//
// Contract-first schema; the table + indexes are also created idempotently at
// boot by ensureRuntimeTables (services/seed.ts) so fresh/reset dev DBs heal
// without a manual `push`.

// The fixed set of rejection reasons the editor picks from. Deliberately a
// SMALL closed vocabulary so the recorded reasons stay comparable across time
// (a free-text note is captured separately). Required on every reject.
export const EDITORIAL_REJECTION_REASON = [
  "duplicate",
  "boring",
  "weak_source",
  "bad_angle",
  "too_late",
  "wrong_beat",
  "bad_draft",
  "legal_medical_political_risk",
] as const;
export type EditorialRejectionReason = (typeof EDITORIAL_REJECTION_REASON)[number];

// What the editor did. reject = disposition the cluster as do-not-cover (with a
// reason). promote = route it into the existing idea → draft → human-publish
// funnel (NEVER auto-publish).
export const EDITORIAL_REVIEW_ACTION = ["reject", "promote"] as const;
export type EditorialReviewActionKind = (typeof EDITORIAL_REVIEW_ACTION)[number];

// Which cockpit surface the action was taken from (analytics only). candidate =
// a raw high-score open cluster; packet = an approve_draft evidence packet;
// quarantine = a needs_human_editor packet awaiting a human call.
export const EDITORIAL_REVIEW_SURFACE = ["candidate", "packet", "quarantine"] as const;
export type EditorialReviewSurface = (typeof EDITORIAL_REVIEW_SURFACE)[number];

export const editorialReviewActionsTable = pgTable(
  "editorial_review_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The cluster acted on. The evidence packet (when one drove the decision) is
    // recorded too. No DB FKs — set null / left dangling in app on delete, to
    // keep boot-DDL healing simple (mirrors evidence_packets / story_clusters).
    clusterId: uuid("cluster_id").notNull(),
    packetId: uuid("packet_id"),
    surface: text("surface", { enum: EDITORIAL_REVIEW_SURFACE }).notNull(),
    action: text("action", { enum: EDITORIAL_REVIEW_ACTION }).notNull(),
    // Required for reject, null for promote.
    rejectionReason: text("rejection_reason", { enum: EDITORIAL_REJECTION_REASON }),
    // The approved topic idea created when action = promote (the hand-off into
    // the human-publish funnel). Null for rejects.
    promotedIdeaId: uuid("promoted_idea_id"),
    // Optional free-text editor note (context the fixed reason can't carry).
    note: text("note"),
    // Admin email that took the action, for attribution.
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("editorial_review_actions_created_idx").on(t.createdAt),
    index("editorial_review_actions_action_idx").on(t.action),
    index("editorial_review_actions_reason_idx").on(t.rejectionReason),
    index("editorial_review_actions_cluster_idx").on(t.clusterId),
  ],
);

export const insertEditorialReviewActionSchema = createInsertSchema(editorialReviewActionsTable).omit({
  id: true,
  createdAt: true,
});
export type EditorialReviewAction = typeof editorialReviewActionsTable.$inferSelect;
export type InsertEditorialReviewAction = z.infer<typeof insertEditorialReviewActionSchema>;
