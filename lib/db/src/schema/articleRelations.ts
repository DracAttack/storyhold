import { pgTable, text, timestamp, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Curated directional relationship between two published articles. Two kinds:
//   chain          — articleB is a direct update/development on articleA's
//                    specific story. Rendered as "Part of a series" nav.
//                    Created by Story Watch signal detector and the backpass.
//   subject_sibling — two articles independently cover the same subject.
//                    Rendered as "More on this subject". Created by the backpass.
//
// Directionality: articleAId is the earlier/original article; articleBId is
// the later one. For subject_sibling relations both orderings are stored so
// queries from either side are cheap (OR queries avoided).
//
// Source of truth: lib/db/src/schema/articleRelations.ts
// Boot DDL: services/seed.ts ensureRuntimeTables

export const ARTICLE_RELATION_KINDS = ["chain", "subject_sibling"] as const;
export type ArticleRelationKind = (typeof ARTICLE_RELATION_KINDS)[number];

export const articleRelationsTable = pgTable(
  "article_relations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The earlier / originating article (for chain: the article being continued).
    articleAId: uuid("article_a_id").notNull(),
    // The later / responding article (for chain: the update article).
    articleBId: uuid("article_b_id").notNull(),
    kind: text("kind", { enum: ARTICLE_RELATION_KINDS }).notNull(),
    // LLM confidence 0–1 assigned at classification time.
    confidence: text("confidence"),
    // Short LLM-generated rationale (stored for admin review / audit).
    rationale: text("rationale"),
    // For backpass relations: whether the pair shared ≥2 non-reference citations.
    sharedCitationCount: text("shared_citation_count"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("article_relations_pair_kind_key").on(t.articleAId, t.articleBId, t.kind),
    index("article_relations_a_idx").on(t.articleAId),
    index("article_relations_b_idx").on(t.articleBId),
    index("article_relations_kind_idx").on(t.kind),
  ],
);

export const insertArticleRelationSchema = createInsertSchema(articleRelationsTable).omit({
  id: true,
  createdAt: true,
});
export type ArticleRelation = typeof articleRelationsTable.$inferSelect;
export type InsertArticleRelation = z.infer<typeof insertArticleRelationSchema>;
