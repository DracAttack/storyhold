import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  doublePrecision,
  boolean,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { articlesTable } from "./articles";

// ---------------------------------------------------------------------------
// Unified social-post vocabulary (shared standard)
//
// The article queue (`social_queue`) and the meme system (`memes`) are two
// SEPARATE systems that post to the same platforms. These constants are the
// single canonical vocabulary both should read consistently. The article queue
// uses these values directly. The meme system already shipped with its own
// historical string values (e.g. `mainstream_template`, `article_hero_image`)
// and is intentionally NOT changed; the display layer maps them onto these.
// ---------------------------------------------------------------------------

/** What kind of media a queued post carries. Only `article` and `meme` are
 *  implemented; the rest are reserved so the data model can grow without a
 *  schema change. */
export const SOCIAL_MEDIA_TYPES = [
  "article",
  "meme",
  "quote_card",
  "direct_image",
  "video",
] as const;
export type SocialMediaType = (typeof SOCIAL_MEDIA_TYPES)[number];

/** Where the post's image/content originates. Article items use `article_hero`. */
export const SOCIAL_SOURCE_TYPES = [
  "article_hero",
  "meme_template",
  "ai_generated",
  "admin_uploaded",
] as const;
export type SocialSourceType = (typeof SOCIAL_SOURCE_TYPES)[number];

/** Lifecycle of a queued item.
 *  - draft     — created but not yet ready to post (e.g. copy not generated)
 *  - ready     — copy approved, eligible for the next free slot
 *  - scheduled — pinned to a specific scheduledAt
 *  - posting   — a slot/manual run currently has it in flight
 *  - posted    — successfully posted (moves to History)
 *  - failed    — permanent failure / retries exhausted (admin can retry)
 *  - paused    — per-item hold (distinct from the global queue pause)
 *  `queued` and `skipped` are retained as legacy-compatible synonyms (`queued`
 *  behaves like `ready`) so pre-existing rows keep working. */
export const SOCIAL_QUEUE_STATUSES = [
  "draft",
  "ready",
  "scheduled",
  "posting",
  "posted",
  "failed",
  "paused",
] as const;
export type SocialQueueStatus = (typeof SOCIAL_QUEUE_STATUSES)[number];

/** Statuses that count as "active" (still in the working queue, NOT history). */
export const SOCIAL_QUEUE_ACTIVE_STATUSES = [
  "draft",
  "ready",
  "queued",
  "scheduled",
  "posting",
  "paused",
  "failed",
] as const;

/** Platforms a queued post can target. Only `facebook` is wired to Zernio today. */
export const SOCIAL_PLATFORMS = [
  "facebook",
  "instagram",
  "x",
  "threads",
  "linkedin",
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

// One row per queued social post. Today every row is an `article` link drip
// (a SEPARATE system from `social_posts`, which records instant-post-on-publish
// + the manual "Post to Facebook" button, and from the `memes` table, which has
// its own queue). The queue exists to gradually distribute the OLDER /
// never-posted back catalogue, one post per scheduled slot. Success here ALSO
// writes a `social_posts` row so the two systems never double-post the same
// article.
//
// Rows are SNAPSHOTS: the title/URL/category/hero image and the generated copy
// (hook/summary/CTA/caption/hashtags) are captured at enqueue time, so later
// edits to the underlying article never silently change a queued post.
//
// No PII — just the article link, generated copy, the rotation category, and
// Zernio request/post traceability ids.
export const socialQueueTable = pgTable("social_queue", {
  id: uuid("id").defaultRandom().primaryKey(),
  articleId: uuid("article_id")
    .notNull()
    .references(() => articlesTable.id, { onDelete: "cascade" }),
  // Snapshot of the absolute article URL + headline at enqueue time.
  articleUrl: text("article_url").notNull(),
  articleTitle: text("article_title").notNull(),
  // Category slug used for slot rotation. Snapshotted from the article.
  category: text("category").notNull().default(""),

  // --- Unified media vocabulary ---------------------------------------------
  // What this post is (article link, meme, etc.). Always `article` here today.
  mediaType: text("media_type").notNull().default("article"),
  // Where its image/content comes from. Article items use `article_hero`.
  sourceType: text("source_type").notNull().default("article_hero"),
  // Soft reference to a `memes` row when mediaType=meme (null for articles). No
  // FK constraint on purpose — the meme system is independent and must not be
  // coupled to this table's lifecycle.
  memeId: uuid("meme_id"),
  // Target platform (facebook/instagram/x/threads/linkedin).
  platform: text("platform").notNull().default("facebook"),
  // Hero/preview image snapshot (informational; article posts stay link-based
  // so Facebook builds its own preview — the image is not uploaded).
  imageUrl: text("image_url"),

  // --- Snapshot copy fields (captured at enqueue) ---------------------------
  socialHook: text("social_hook"),
  articleSummary: text("article_summary"),
  callToAction: text("call_to_action"),
  // The general approved caption (no URL — appended at post time).
  caption: text("caption"),
  // A platform-specific override; when present it is used instead of `caption`.
  selectedPlatformCaption: text("selected_platform_caption"),
  // Relevant hashtags as a string array (each like "#tag").
  hashtags: jsonb("hashtags").$type<string[]>(),
  // Plain-text snapshot of the article body AT ENQUEUE TIME. Deferred copy
  // generation reads THIS, never the live article, so an edit to the underlying
  // article between enqueue and generation can't silently rewrite a queued post.
  // Null on legacy rows (those fall back to the live article when generating).
  sourceSnapshot: text("source_snapshot"),

  queueStatus: text("queue_status").notNull().default("ready"),
  attemptCount: integer("attempt_count").notNull().default(0),
  // Optional explicit time; when null the item flows by sort order into the
  // next free slot.
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  // IANA timezone the schedule is expressed in (informational; the cadence is
  // Phoenix / America/Phoenix, which has no DST).
  scheduledTimezone: text("scheduled_timezone").default("America/Phoenix"),

  // Idempotency key sent to Zernio as x-request-id, fixed at enqueue.
  zernioRequestId: uuid("zernio_request_id").notNull().defaultRandom(),
  // Provider post id (the unified `platformPostId`) + resolved permalink.
  zernioPostId: text("zernio_post_id"),
  facebookPostUrl: text("facebook_post_url"),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  lastError: text("last_error"),
  // One-shot override allowing a previously-posted article to post once more.
  repostApproved: boolean("repost_approved").notNull().default(false),
  // True when an admin force-posted (bypassing the normal slot/claim rules).
  // Only meaningfully set for memes via read-time projection; articles default
  // false. Surfaced as a "forced" indicator in the admin queue for an audit trail.
  postedViaOverride: boolean("posted_via_override").notNull().default(false),
  // Manual ordering key (smaller = sooner).
  sortKey: doublePrecision("sort_key").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // DB-level seat belt against duplicate ACTIVE queue entries for the same
  // (article, media type, platform). The old one-row-per-article unique was
  // dropped to allow intentional reposts, but reposts only happen once the prior
  // item has left the active set (posted/skipped), so an ACTIVE-only partial
  // unique still allows them while closing the read-then-insert race two
  // concurrent enqueues could otherwise win. Created at boot by identical raw DDL
  // in ensureRuntimeTables; keep the name + predicate in lockstep so drizzle-kit
  // push stays diff-clean (no interactive deploy prompt).
  uniqueIndex("social_queue_active_dedup_uniq")
    .on(t.articleId, t.mediaType, t.platform)
    .where(
      sql`${t.queueStatus} in ('draft','ready','queued','scheduled','posting','paused','failed')`,
    ),
]);

export type SocialQueueItem = typeof socialQueueTable.$inferSelect;
