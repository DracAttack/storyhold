import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { articlesTable } from "./articles";
import { SOURCE_AUTHORITY_TIER } from "./sourceVault";

// --- Article ↔ source graph (Task #228) ---------------------------------
// Historically an article's outbound source links lived ONLY as markdown
// `[phrase](url)` inside its body blocks — there was no queryable relationship
// between an article and the sources it cites. The Back Catalog Source Harvest
// scans existing article bodies, canonicalizes + classifies every outbound link
// (reusing the #227 three-way classifier), routes evidence URLs into the Source
// Vault ingest queue, and records ONE row here per (article, canonical url). That
// makes the article→source relationship first-class so downstream features
// (e.g. #229 evidence-aware related articles) can reason over it.

// The newsroom ROLE a harvested link was classified into (mirrors SourceRole in
// services/sourceAuthority.ts; stored on a plain text column, no PG enum).
export const ARTICLE_SOURCE_ROLE = ["evidence", "trend_marker", "rejected_junk"] as const;
export type ArticleSourceRole = (typeof ARTICLE_SOURCE_ROLE)[number];

// What the harvest DID with the link:
//   queued    = evidence, enqueued into the Source Vault ingest queue.
//   ingested  = evidence, a matching source_document already existed (reused,
//               not re-ingested) and linked via sourceDocumentId.
//   marker    = social platform → recorded as a trend marker (velocity only).
//   rejected  = aggregator / link-farm junk → recorded thin for transparency.
export const ARTICLE_SOURCE_STATUS = ["queued", "ingested", "marker", "rejected"] as const;
export type ArticleSourceStatus = (typeof ARTICLE_SOURCE_STATUS)[number];

export const articleSourcesTable = pgTable(
  "article_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articlesTable.id, { onDelete: "cascade" }),
    // Canonicalized outbound URL (tracking params stripped, host lowercased,
    // hash dropped). Unique per article so a re-scan is idempotent.
    url: text("url").notNull(),
    domain: text("domain").notNull(),
    role: text("role", { enum: ARTICLE_SOURCE_ROLE }).notNull(),
    // Authority tier the role was derived from (primary/firsthand/…/unknown).
    tier: text("tier", { enum: SOURCE_AUTHORITY_TIER }).notNull().default("unknown"),
    status: text("status", { enum: ARTICLE_SOURCE_STATUS }).notNull(),
    // The Source Vault document this link resolves to, once ingested. NULL until
    // reconciliation matches the queued URL to a source_documents row. No DB FK
    // (keeps boot-DDL healing simple — set null in app on document delete).
    sourceDocumentId: uuid("source_document_id"),
    // The anchor text the link was wrapped in, for admin display context.
    anchorText: text("anchor_text"),
    // --- Citation snapshot -------------------------------------------------
    // Bibliographic metadata captured once (from the Source Vault document or a
    // direct metadata fetch of the page) so the public References list can show
    // a real citation — the actual source title, author/organization, publisher
    // and date — instead of the in-body anchor text. Snapshotting protects the
    // rendered reference from later publisher-side page-title edits.
    sourceTitle: text("source_title"),
    sourceAuthors: text("source_authors"),
    publisherName: text("publisher_name"),
    sourcePublishedAt: timestamp("source_published_at", { withTimezone: true }),
    canonicalUrl: text("canonical_url"),
    doi: text("doi"),
    // When citation metadata was last fetched/attempted for this row (set even
    // on a failed fetch so the backfill doesn't re-hammer dead URLs).
    accessedAt: timestamp("accessed_at", { withTimezone: true }),
    // --- Citation note (Task #273) -----------------------------------------
    // One AI-written sentence explaining WHY this source is included in this
    // article ("evidence map"). NULL = no note (renders nothing); the generator
    // omits a note when it isn't sure rather than guessing.
    citationNote: text("citation_note"),
    // When note generation was last attempted for this row (set even when the
    // model declined to write one, so the backfill doesn't re-bill dead rows).
    noteGeneratedAt: timestamp("note_generated_at", { withTimezone: true }),
    // Machine-readable reason a row was rejected, for admin transparency and
    // audit trails. NULL on non-rejected rows. Values: 'duplicate_title' (a
    // better-tier copy of the same paper was kept), 'junk_link' (aggregator /
    // link-farm), 'manual' (editor-rejected via admin).
    rejectionReason: text("rejection_reason"),
    // Set to true when the URL is a known intermediary aggregator (SciSpace,
    // ResearchGate, Semantic Scholar) that hosts a copy of the paper rather than
    // the original publication. Intermediary rows are suppressed from the public
    // References list — the reader should see the original journal, not the
    // mirror. Populated at harvest/insert time and back-filled by a guarded
    // migration for existing rows.
    isIntermediary: boolean("is_intermediary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("article_sources_article_url_key").on(t.articleId, t.url),
    index("article_sources_article_idx").on(t.articleId),
    index("article_sources_document_idx").on(t.sourceDocumentId),
    index("article_sources_url_idx").on(t.url),
    index("article_sources_role_idx").on(t.role),
  ],
);

export const insertArticleSourceSchema = createInsertSchema(articleSourcesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type ArticleSource = typeof articleSourcesTable.$inferSelect;
export type InsertArticleSource = z.infer<typeof insertArticleSourceSchema>;
