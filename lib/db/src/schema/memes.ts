import { pgTable, text, integer, boolean, timestamp, jsonb, uuid, numeric } from "drizzle-orm/pg-core";
import { articlesTable } from "./articles";
import { memeTemplatesTable, type MemeLayout } from "./memeTemplates";

// How the meme's BASE image is sourced:
//  - mainstream_template — composed on a curated library template image (no AI)
//  - ai_generated        — Nano Banana square 1:1 original scene
//  - admin_uploaded      — admin uploaded their own base image
//  - article_hero_image  — reuse the article's existing hero image as the base
export const MEME_SOURCE_TYPES = [
  "mainstream_template",
  "ai_generated",
  "admin_uploaded",
  "article_hero_image",
] as const;
export type MemeSourceType = (typeof MEME_SOURCE_TYPES)[number];

// Lifecycle:
//  draft      — created / concept selected / editing (no paid image yet)
//  generating — artwork generation in flight
//  generated  — base image ready + composed; preview available
//  approved   — admin approved (transient; immediately enqueued)
//  queued     — in the meme posting queue (ready or scheduled) for a daily slot
//  posting    — a slot/manual run currently has it in flight (atomic claim)
//  posted     — posted to Facebook via Zernio
//  failed     — image generation or posting failed
// Placement of the optional "extra" caption.
export const MEME_EXTRA_TEXT_POSITIONS = ["middle", "bottom"] as const;
export type MemeExtraTextPosition = (typeof MEME_EXTRA_TEXT_POSITIONS)[number];

// Rendering medium for AI-generated artwork (ai_generated source only):
//  - auto         — let the model pick photo vs illustration per the scene
//  - photographic — force realistic, photographic-quality rendering (the default)
//  - cartoon      — bold, playful cel-shaded cartoon/comic style
//  - illustration — clean modern editorial illustration (vector/flat or painted)
export const MEME_ART_STYLES = ["auto", "photographic", "cartoon", "illustration"] as const;
export type MemeArtStyle = (typeof MEME_ART_STYLES)[number];

// Which corner the brand-footer logo / website mark sits in. "auto" keeps the
// layout's default placement (logo bottom-left, url bottom-right; flipped to the
// top for the explainer layout whose bottom is occupied by the summary panel).
export const MEME_BRAND_CORNERS = [
  "auto",
  "top_left",
  "top_right",
  "bottom_left",
  "bottom_right",
] as const;
export type MemeBrandCorner = (typeof MEME_BRAND_CORNERS)[number];

export const MEME_STATUSES = [
  "draft",
  "generating",
  "generated",
  "approved",
  "queued",
  "posting",
  "posted",
  "failed",
] as const;
export type MemeStatus = (typeof MEME_STATUSES)[number];

// One article-grounded meme concept proposed by the concept generator. The
// selected concept's fields are copied onto the meme row; the full set is cached
// in `concepts` so reopening the editor doesn't re-spend on the LLM.
// Horizontal zones used to describe where a meme scene left clean, text-safe
// space and where its focal subject sits. The composer uses this (alongside its
// own pixel-level band analysis) to size and place the on-image captions so they
// don't balloon over, or cover, the subject.
export const MEME_TEXT_ZONES = ["top", "center", "bottom"] as const;
export type MemeTextZone = (typeof MEME_TEXT_ZONES)[number];

// A per-meme placement recommendation produced by the scene-writing model: the
// zones it intentionally kept clear for captions and where the subject sits.
// Purely advisory — the composer's deterministic image analysis wins on
// conflict; this only breaks ties. Null for memes built before this existed or
// from custom/uploaded artwork.
export interface MemeTextPlacement {
  clearZones: MemeTextZone[];
  subjectPosition: MemeTextZone;
}

// One archived base+composed artwork pair, kept when artwork is regenerated or
// a new base is uploaded so the admin can review/restore/delete a prior version.
// The CURRENT active artwork lives in originalImageUrl/composedImageUrl and is
// never duplicated here. `originalImageUrl` (always present) is the stable key.
export interface MemeArtworkVersion {
  originalImageUrl: string;
  composedImageUrl: string | null;
  createdAt: string; // ISO timestamp captured when the version was archived
}

export interface MemeConcept {
  jokeDescription: string;
  recommendedTemplateSlug: string | null;
  recommendedLayout: MemeLayout;
  topText: string;
  bottomText: string;
  // Legacy single on-image "extra" caption (no longer rendered or editable).
  // Kept so old cached concepts still deserialize; always "" for new concepts.
  extraText: string;
  // Up to three optional short tag-line IDEAS the admin can manually append to
  // the bottom text. Suggestions only — never rendered on their own.
  extraTextIdeas: string[];
  visualScene: string;
  // Advisory caption-placement hint for this concept's scene (may be null).
  textPlacement: MemeTextPlacement | null;
  // Social pack for this concept.
  socialHook: string;
  socialSummary: string;
  socialCta: string;
  caption: string;
  hashtags: string[];
}

// One row per meme an admin builds from an article. The meme row doubles as the
// posting-queue item: after approval `status` becomes "queued" and the daily
// meme-slot scheduler posts ready/scheduled memes via the existing Zernio path.
// Distinct from `social_queue` (article-link drip) so the two cadences never
// collide. No PII.
export const memesTable = pgTable("memes", {
  id: uuid("id").defaultRandom().primaryKey(),
  articleId: uuid("article_id")
    .notNull()
    .references(() => articlesTable.id, { onDelete: "cascade" }),
  // Snapshot of article context at build time so the meme + caption stay stable
  // even if the article slug/title is later edited.
  articleTitle: text("article_title").notNull().default(""),
  articleUrl: text("article_url").notNull().default(""),
  category: text("category").notNull().default(""),
  // True copy snapshot: the article's plain-text body captured at build time, so
  // any deferred caption (social-pack) generation at post time reads the content
  // the meme was built from — never the (possibly later edited or unpublished)
  // live article. Mirrors `sourceSnapshot` on social_queue. Null for legacy
  // memes built before this existed; those fall back to the live article.
  sourceSnapshot: text("source_snapshot"),

  // --- Concept ---
  // Cached last-generated concept set (so reopening doesn't re-spend) + which
  // one is selected.
  concepts: jsonb("concepts").$type<MemeConcept[]>(),
  selectedConceptIndex: integer("selected_concept_index"),
  jokeDescription: text("joke_description").notNull().default(""),

  // --- Image source + composition ---
  sourceType: text("source_type").$type<MemeSourceType>().notNull().default("mainstream_template"),
  templateId: uuid("template_id").references(() => memeTemplatesTable.id, { onDelete: "set null" }),
  layout: text("layout").$type<MemeLayout>().notNull().default("classic_top_bottom"),
  topText: text("top_text").notNull().default(""),
  bottomText: text("bottom_text").notNull().default(""),
  // Legacy single on-image "extra" caption — no longer rendered or editable.
  // Retained (always "") so historical rows + the API contract stay stable.
  extraText: text("extra_text").notNull().default(""),
  // Where the legacy "extra" caption was placed. Unused going forward.
  extraTextPosition: text("extra_text_position")
    .$type<MemeExtraTextPosition>()
    .notNull()
    .default("middle"),
  // Up to three generated optional tag-line IDEAS surfaced as suggestions in the
  // editor (the admin can tack one onto the bottom text). Never rendered alone.
  extraTextIdeas: jsonb("extra_text_ideas").$type<string[]>().notNull().default([]),
  // Manual per-meme caption nudges (pixels) for the classic_top_bottom / split_panel
  // overlay layouts. Added to the computed top/bottom offsets so an admin can fine-tune
  // caption position without re-billing AI artwork (applied on a free recompose).
  // +top = caption moves DOWN from the top edge; +bottom = caption moves UP from the
  // bottom edge. Ignored by panel/curated-template layouts. Default 0 = automatic.
  captionTopOffsetAdj: integer("caption_top_offset_adj").notNull().default(0),
  captionBottomOffsetAdj: integer("caption_bottom_offset_adj").notNull().default(0),
  // Manual per-meme caption SIZE adjustments (percent delta) for the same
  // classic_top_bottom / split_panel overlay layouts. Scales the auto-fitted
  // caption font cap (and band height) so an admin can make a line bigger or
  // smaller without re-billing AI artwork (applied on a free recompose).
  // 0 (default) = automatic size; e.g. +25 = 25% larger, -25 = 25% smaller.
  captionTopSizeAdj: integer("caption_top_size_adj").notNull().default(0),
  captionBottomSizeAdj: integer("caption_bottom_size_adj").notNull().default(0),
  // Per-meme brand-footer placement overrides. Corner picks which corner the logo
  // / brainhook.net mark sits in ("auto" = layout default); the offset adjustments
  // nudge it inward from that corner in pixels (added to the base PAD inset, clamped
  // on-canvas). Applied on a free recompose (no AI re-bill). Defaults reproduce the
  // original automatic footer exactly.
  brandLogoCorner: text("brand_logo_corner").$type<MemeBrandCorner>().notNull().default("auto"),
  brandUrlCorner: text("brand_url_corner").$type<MemeBrandCorner>().notNull().default("auto"),
  brandLogoOffsetXAdj: integer("brand_logo_offset_x_adj").notNull().default(0),
  brandLogoOffsetYAdj: integer("brand_logo_offset_y_adj").notNull().default(0),
  brandUrlOffsetXAdj: integer("brand_url_offset_x_adj").notNull().default(0),
  brandUrlOffsetYAdj: integer("brand_url_offset_y_adj").notNull().default(0),
  // Rendering medium for AI artwork (ai_generated source); "auto" lets the model
  // decide. Ignored for template/upload/hero sources.
  artStyle: text("art_style").$type<MemeArtStyle>().notNull().default("photographic"),
  // Prompt used for AI artwork (text-free square scene).
  visualPrompt: text("visual_prompt").notNull().default(""),
  // Advisory caption-placement hint for the current scene (clear zones +
  // subject position). Nullable: older memes and custom/uploaded artwork have
  // none, and the composer falls back to pure image analysis.
  textPlacement: jsonb("text_placement").$type<MemeTextPlacement>(),
  // Base image (template image / AI scene / uploaded / hero) and the final
  // composed meme. Both are public object-storage URLs.
  originalImageUrl: text("original_image_url"),
  composedImageUrl: text("composed_image_url"),
  // Prior artwork versions kept when artwork is regenerated / re-uploaded, so the
  // admin can review, restore, or delete an earlier base+composed pair. Never
  // includes the current active artwork (originalImageUrl/composedImageUrl).
  artworkHistory: jsonb("artwork_history").$type<MemeArtworkVersion[]>().notNull().default([]),

  // --- Social pack ---
  socialHook: text("social_hook").notNull().default(""),
  socialSummary: text("social_summary").notNull().default(""),
  socialCta: text("social_cta").notNull().default(""),
  canonicalUrl: text("canonical_url").notNull().default(""),
  caption: text("caption").notNull().default(""),
  hashtags: jsonb("hashtags").$type<string[]>().notNull().default([]),

  // --- State + cost ---
  status: text("status").$type<MemeStatus>().notNull().default("draft"),
  // Paid AI-artwork attempts ONLY (capped at 3 unless overridden). Posting
  // retries are tracked separately in `postAttemptCount` so they never consume
  // the artwork attempt budget.
  attemptCount: integer("attempt_count").notNull().default(0),
  // Zernio posting attempts (informational metric; NOT a cap). Kept distinct
  // from the AI artwork `attemptCount`.
  postAttemptCount: integer("post_attempt_count").notNull().default(0),
  attemptOverride: boolean("attempt_override").notNull().default(false),
  // Whether AI artwork may depict real public figures (admin override).
  allowPublicFigures: boolean("allow_public_figures").notNull().default(false),
  estimatedCostUsd: numeric("estimated_cost_usd").notNull().default("0"),
  lastError: text("last_error"),

  // --- Scheduling / posting (meme row IS the queue item) ---
  // Admin-picked time; null = "ready", picked up by the next open meme slot.
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  // Idempotency key sent to Zernio as x-request-id, fixed at enqueue so a
  // retried create can never double-post.
  zernioRequestId: uuid("zernio_request_id").notNull().defaultRandom(),
  zernioPostId: text("zernio_post_id"),
  facebookPostUrl: text("facebook_post_url"),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  // True when the meme was posted via the admin "Post now" override (force),
  // bypassing the normal generated→approved→queued transition. Records that
  // approval was granted manually at the API boundary rather than evaporating.
  postedViaOverride: boolean("posted_via_override").notNull().default(false),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Meme = typeof memesTable.$inferSelect;
export type NewMeme = typeof memesTable.$inferInsert;
