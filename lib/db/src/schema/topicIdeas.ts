import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { authorsTable } from "./authors";

/**
 * Structured snapshot stored on an idea promoted from the Living Coverage Map.
 * Everything needed to audit WHY the idea exists after the map item moves on.
 */
export interface CoverageIdeaProvenance {
  conceptId: string;
  classification: string;
  recommendedAction: string;
  scores: {
    evidenceStrength: number;
    sourceDiversity: number;
    opportunityScore: number;
  };
  sourceDocumentIds: string[];
  sourceFamilyIds: string[];
  centralArticleIds: string[];
  radarSuggestionId: string | null;
  promotedAtIso: string;
}

export const topicIdeasTable = pgTable("topic_ideas", {
  id: uuid("id").defaultRandom().primaryKey(),
  authorId: uuid("author_id").notNull().references(() => authorsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  angle: text("angle").notNull(),
  // Which beat this idea targets — primary or one of the author's sub-beats.
  // Carries through to the article's category when drafted.
  category: text("category"),
  categorySlug: text("category_slug"),
  // Cross-sectional metadata (Task #258): beat slugs BEYOND the primary
  // categorySlug that this idea deliberately blends ("secondary subjects").
  // INTERNAL, admin-only — never surfaced to readers, never used for
  // classification/placement/canonicalization. Drives crossover idea
  // generation and widens draft-time Source Vault evidence across all beats.
  secondaryBeats: text("secondary_beats").array(),
  status: text("status", {
    enum: ["pending", "approved", "drafting", "rejected", "used", "needs_sources", "harvesting_sources"],
  })
    .notNull()
    .default("pending"),
  continuesArticleId: uuid("continues_article_id"),
  // Evidence lineage: when an idea was promoted from an editorial evidence
  // packet (Editor Cockpit), the packet that gated the promotion and its story
  // cluster. Both nullable — ideas from the normal author pipeline have neither.
  // Carried through to the drafted article so evidence lineage stays traceable.
  // No DB FK (keeps boot-DDL healing simple; app resolves/ignores dangling ids).
  evidencePacketId: uuid("evidence_packet_id"),
  clusterId: uuid("cluster_id"),
  // Coverage Map lineage: when an idea was promoted from a Living Coverage Map
  // item, the item id plus a structured snapshot of the evidence that justified
  // the promotion (source doc/family/article IDs, classification, scores).
  // Human-readable notes only carry counts — this preserves WHICH sources so
  // the audit chain survives into autonomous drafting. No DB FK (boot-DDL
  // healing stays simple; app resolves/ignores dangling ids). Both nullable —
  // ideas from other pipelines have neither.
  coverageMapItemId: uuid("coverage_map_item_id"),
  coverageProvenanceJson: jsonb("coverage_provenance_json").$type<CoverageIdeaProvenance>(),
  // How the most recent draft attempt was grounded (Task #233), surfaced in the
  // admin idea gallery so an editor can see how an article was sourced without
  // digging through logs. One of grounded_from_vault (drafted from an
  // auto-built Source Vault packet), packet_verified (drafted from a
  // pre-existing Editor-Cockpit packet), held_needs_sources (vault too weak —
  // held for a later harvest), or drafted_legacy_override (emergency web-search
  // fallback). Null until the idea has been through the draft path.
  draftGroundingOutcome: text("draft_grounding_outcome", {
    enum: [
      "grounded_from_vault",
      "packet_verified",
      "held_needs_sources",
      "drafted_legacy_override",
    ],
  }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTopicIdeaSchema = createInsertSchema(topicIdeasTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type TopicIdea = typeof topicIdeasTable.$inferSelect;
export type InsertTopicIdea = z.infer<typeof insertTopicIdeaSchema>;
