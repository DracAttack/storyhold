import { pgTable, text, integer, timestamp, jsonb, uuid, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { authorsTable } from "./authors";
import { topicIdeasTable } from "./topicIdeas";

// A single entry in the "Follow this story" timeline block.
export const followThisStoryEntrySchema = z.object({
  articleId: z.string(),
  slug: z.string(),
  title: z.string(),
  publishedAt: z.string(),
  articleKind: z.enum(["standard", "update"]),
});
export type FollowThisStoryEntry = z.infer<typeof followThisStoryEntrySchema>;

// A single entry in the "Story so far" context block (update articles).
export const storySoFarSchema = z.object({
  summary: z.string(), // AI-written context paragraph(s)
  originalSlug: z.string(),
  originalTitle: z.string(),
});
export type StorySoFar = z.infer<typeof storySoFarSchema>;

export const articleBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paragraph"), content: z.string() }),
  z.object({ type: z.literal("heading"), content: z.string() }),
  z.object({ type: z.literal("pullquote"), content: z.string() }),
  z.object({ type: z.literal("image"), content: z.string() }),
  z.object({ type: z.literal("relatedArticle"), content: z.string() }),
  z.object({
    type: z.literal("takeaways"),
    items: z.array(z.string().min(1)).min(1).max(10),
  }),
  z.object({
    type: z.literal("follow_this_story"),
    content: z.string(),
    entries: z.array(followThisStoryEntrySchema),
  }),
  z.object({
    type: z.literal("story_so_far"),
    content: z.string(),
    originalSlug: z.string(),
    originalTitle: z.string(),
  }),
]);
export type ArticleBlock = z.infer<typeof articleBlockSchema>;

// A prior hero-image version, archived whenever the hero is regenerated or
// re-uploaded (mirrors the meme artworkHistory pattern). Snapshots the hero and
// its branded share/feed cards together so restoring a version brings back a
// matching set. `heroImage` is the stable key.
export interface HeroImageVersion {
  heroImage: string;
  shareImage: string | null;
  feedImage: string | null;
  createdAt: string; // ISO timestamp captured when the version was archived
}

// The five headline "hook" modes. Each article gets one variant per mode; an
// assignment then maps a mode onto each consuming surface (H1, SEO title, social
// share title, newsletter subject) so the editor can steer the angle per channel.
export const HOOK_MODES = ["curiosity", "contrarian", "emotional", "news_peg", "plain_seo"] as const;
export const hookModeSchema = z.enum(HOOK_MODES);
export type HookMode = (typeof HOOK_MODES)[number];

export const hookVariantSchema = z.object({
  mode: hookModeSchema,
  text: z.string(),
});
export type HookVariant = z.infer<typeof hookVariantSchema>;

// Which hook mode drives each headline surface. Any surface may be unset, in
// which case the surface falls back to its editor override (if any) then the
// truncated H1. The visible H1 surface uses `h1` (unset = full title verbatim).
export const hookAssignmentsSchema = z.object({
  h1: hookModeSchema.nullable().optional(),
  seoTitle: hookModeSchema.nullable().optional(),
  social: hookModeSchema.nullable().optional(),
  newsletter: hookModeSchema.nullable().optional(),
});
export type HookAssignments = z.infer<typeof hookAssignmentsSchema>;

// Ready-to-post per-platform social copy. All strings; `altCaptions` is a small
// set of interchangeable short captions the editor can pick from.
export const socialPackSchema = z.object({
  twitter: z.string(),
  threads: z.string(),
  pinterestTitle: z.string(),
  pinterestDescription: z.string(),
  reddit: z.string(),
  newsletterBlurb: z.string(),
  quoteCard: z.string(),
  altCaptions: z.array(z.string()),
});
export type SocialPack = z.infer<typeof socialPackSchema>;

// Result of the post-draft evidence verification (#201). A packet-grounded draft
// is checked ONLY against its LOCKED evidence packet (no live web authority):
// - "passed": nothing flagged, the draft is faithful to the packet.
// - "flagged": the draft asserts facts the packet does not support, contradicts
//   the packet, or cites sources not in the packet — the article is quarantined
//   for a human editor.
// - "error": the checker itself could not run (model failure / unparseable) — the
//   article is also quarantined so a human still looks.
// Stored on the article so the admin can read the findings. `null` for drafts
// that never had an evidence packet (normal author pipeline).
export const verificationFindingSchema = z.object({
  claim: z.string(),
  detail: z.string(),
});
export type VerificationFinding = z.infer<typeof verificationFindingSchema>;

export const advisoryFindingSchema = z.object({
  findingType: z.string(),
  detail: z.string(),
  url: z.string().optional(),
});
export type AdvisoryFinding = z.infer<typeof advisoryFindingSchema>;

export const verificationReportSchema = z.object({
  status: z.enum(["passed", "flagged", "error"]),
  checkedAt: z.string(),
  model: z.string().nullable(),
  summary: z.string(),
  unsupportedClaims: z.array(verificationFindingSchema),
  contradictedClaims: z.array(verificationFindingSchema),
  inventedSources: z.array(verificationFindingSchema),
  advisoryFindings: z.array(advisoryFindingSchema).optional(),
});
export type VerificationReport = z.infer<typeof verificationReportSchema>;

export const articlesTable = pgTable("articles", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  authorId: uuid("author_id").notNull().references(() => authorsTable.id),
  ideaId: uuid("idea_id").references(() => topicIdeasTable.id, { onDelete: "set null" }),
  // Evidence lineage: when this article was drafted from an editorial evidence
  // packet (promoted via the Editor Cockpit), the packet that grounded the draft
  // and its story cluster. Both nullable — articles from the normal author
  // pipeline have neither. No DB FK (keeps boot-DDL healing simple).
  evidencePacketId: uuid("evidence_packet_id"),
  clusterId: uuid("cluster_id"),
  // Post-draft evidence verification result (#201). Only written for
  // packet-grounded drafts; a non-"passed" report also sets quarantinedAt.
  verificationReport: jsonb("verification_report").$type<VerificationReport>(),
  title: text("title").notNull(),
  titleCandidates: text("title_candidates").array(),
  dek: text("dek").notNull(),
  // Optional editor overrides for search/social meta. When null, the site
  // derives a sensible value (concise title from the headline; clamped
  // description from the dek). They never change the visible H1.
  seoTitle: text("seo_title"),
  seoDescription: text("seo_description"),
  // Manual editorial label override. When non-null, replaces the deterministic
  // auto-classification (research_synthesis / analysis / explainer) shown in the
  // "How this article was produced" trust box. Null = auto-derive. Must be set
  // by an editor — never written by the pipeline. Keep in sync with the boot DDL
  // guard in services/seed.ts and the UpdateArticleInput OpenAPI schema.
  editorialLabelOverride: text("editorial_label_override"),
  category: text("category").notNull(),
  categorySlug: text("category_slug").notNull(),
  // Cross-sectional metadata (Task #258): secondary subject beat slugs carried
  // through from the idea. INTERNAL, admin-only — the article still classifies,
  // places, and canonicalizes under its single primary categorySlug. Never
  // leaked to readers, public endpoints, category pages, sitemaps, RSS, or SEO.
  secondaryBeats: text("secondary_beats").array(),
  body: jsonb("body").$type<ArticleBlock[]>().notNull(),
  // Pre-backfill snapshot of `body`, captured the first time an admin-triggered
  // internal-link backfill modifies this article. Lets a bad backfill be undone
  // cleanly (restore this body, clear the column). Null when no backfill has run.
  internalLinksBackup: jsonb("internal_links_backup").$type<ArticleBlock[]>(),
  // Pre-backfill snapshot of `body`, captured the first time an admin-triggered
  // SOURCE-link (external citation) backfill modifies this article. Kept separate
  // from `internalLinksBackup` so a source-link undo never clobbers an internal-
  // link undo (and vice-versa). Null when no source-link backfill has run.
  sourceLinksBackup: jsonb("source_links_backup").$type<ArticleBlock[]>(),
  heroImage: text("hero_image").notNull(),
  // Branded composite share card (hero + brand gradient + wordmark + title) used
  // for og:image / twitter:image. Null until generated (or when composition
  // failed) — consumers fall back to `heroImage`.
  shareImage: text("share_image"),
  // Branded SQUARE (1080×1080, 1:1) feed card used as the ATTACHED photo on
  // Facebook posts, where the 1.91:1 `shareImage` posts too wide/letterboxed.
  // Composed from the same hero buffer. Null until generated (or when
  // composition failed) — Facebook posters fall back to `shareImage` then the
  // raw `heroImage`. The og:image / twitter:image still uses `shareImage`.
  feedImage: text("feed_image"),
  // Prior hero-image versions, newest-first, archived each time the hero is
  // regenerated or re-uploaded so a version can be restored wholesale. Each
  // entry snapshots the hero + its branded share/feed cards. Capped; [] default.
  heroImageHistory: jsonb("hero_image_history").$type<HeroImageVersion[]>().notNull().default([]),
  // Headline-hook kit. All nullable for backward compatibility with articles
  // created before this feature. `hookVariants` holds one entry per HookMode;
  // `hookAssignments` maps modes onto the four consuming surfaces; `socialPack`
  // holds the ready-to-post per-platform copy. Generated at draft time and
  // regenerable/editable in the admin.
  hookVariants: jsonb("hook_variants").$type<HookVariant[]>(),
  hookAssignments: jsonb("hook_assignments").$type<HookAssignments>(),
  socialPack: jsonb("social_pack").$type<SocialPack>(),
  readingTimeMinutes: integer("reading_time_minutes").notNull(),
  status: text("status", { enum: ["draft", "scheduled", "published"] }).notNull().default("draft"),
  forceAutoRelated: boolean("force_auto_related").notNull().default(false),
  // Per-article kill-switch for the Concept Explainer: when true, concept
  // processing skips this article and the public mentions endpoint returns
  // an empty set (existing mentions are suppressed, not deleted).
  conceptExplainersDisabled: boolean("concept_explainers_disabled").notNull().default(false),
  // Editor-curated override for the "related articles" rail/callouts. NULL (or
  // empty) means automatic topical ranking; a non-empty ordered list of slugs
  // means the public /related endpoint returns exactly those (published) slugs
  // in order, bypassing the auto-scorer. Lets editors fix off-topic slips.
  relatedSlugs: jsonb("related_slugs").$type<string[]>(),
  // Set by the daily AI dedup scan when this article is flagged as a near-
  // duplicate of an older one. While non-null the article is QUARANTINED: it
  // stays status="published" (so admins still see it) but every public-facing
  // read excludes `quarantined_at IS NOT NULL`, pulling it from the live site,
  // sitemap, RSS, related rails and newsletters until an admin keeps or deletes
  // it on /admin/duplicates. Cleared (back to live) when an admin clicks "Keep".
  quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
  continuesArticleId: uuid("continues_article_id"),
  // --- Story Watch / story chains (Task #348) ----------------------------
  // Whether this is a standard article or a story-watch update. Updates are
  // excluded from category pages, home feed, related rail, and author pages
  // (they are still crawlable, in sitemap, in RSS, and discoverable via
  // their own canonical URL). "standard" is the universal default.
  articleKind: text("article_kind", { enum: ["standard", "update"] })
    .notNull()
    .default("standard"),
  // Links an update article back to its story chain. NULL for originals and
  // articles that predate story-chain tracking. No DB FK (boot-DDL healing).
  // For the original article in a chain this stays null; for each update it
  // points to the original article's id.
  storyChainId: uuid("story_chain_id"),
  // 1-based position within the story chain (1 = first update, 2 = second, …).
  // NULL for originals and non-chain articles.
  chainPosition: integer("chain_position"),
  // When the Back Catalog Source Harvest (#228) last scanned this article's body
  // for outbound source links. NULL = never scanned; the harvest advances
  // through the catalog by selecting NULL rows, so a scanned article is skipped
  // on later runs (matching the internal-link backfill's skip-once behavior).
  sourcesHarvestedAt: timestamp("sources_harvested_at", { withTimezone: true }),
  // When the Source Gap scanner last checked this article for unsourced claims.
  // NULL = never scanned; scanner advances through catalog by selecting NULL first.
  sourceGapScannedAt: timestamp("source_gap_scanned_at", { withTimezone: true }),
  // Source retraction impact tracking (Task #329). When a Source Vault document
  // that this article cites as evidence transitions to a non-active lifecycle
  // status, the cascade service sets `retraction_impact_at` so the admin surface
  // and public trust box can surface the flag. The daily retraction_rescan cron
  // (or a manual editor action) writes `retraction_impact_cleared_at` once the
  // article's remaining evidence base is confirmed still solid.
  retractionImpactAt: timestamp("retraction_impact_at", { withTimezone: true }),
  retractionImpactClearedAt: timestamp("retraction_impact_cleared_at", { withTimezone: true }),
  // Reason the auto-publish gate held a scheduled article without quarantining
  // it. Set by publishDueArticles when a check fails for a correctable reason
  // (e.g. zero evidence sources in article_sources for a packet-grounded draft).
  // Cleared on successful auto-publish. NULL = no hold or hold cleared.
  holdReason: text("hold_reason"),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertArticleSchema = createInsertSchema(articlesTable, {
  body: z.array(articleBlockSchema),
}).omit({ id: true, createdAt: true, updatedAt: true });
export type Article = typeof articlesTable.$inferSelect;
export type InsertArticle = z.infer<typeof insertArticleSchema>;
