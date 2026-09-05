import { and, eq, gte, sql } from "drizzle-orm";
import { db, socialPostsTable } from "@workspace/db";
import { siteUrl } from "./emailShared";

// ---------------------------------------------------------------------------
// Daily Facebook posting budget for ARTICLE posts.
//
// Articles and memes are two SEPARATE posting systems that share the same
// Facebook page. This budget governs ARTICLE posts only: every successful
// article post (instant-on-publish AND the slow drip queue) mirrors into the
// `social_posts` table with status='posted' + postedAt, so counting that table
// is the single source of truth for "how many article posts went out today".
// Memes are tracked in the `memes` table and capped independently by their own
// three daily slots — they never consume this budget.
// ---------------------------------------------------------------------------

/** Hard ceiling on automated ARTICLE posts to Facebook per UTC day. Manual
 *  admin "Post to Facebook" (force) bypasses this. Memes are separate. */
export const MAX_ARTICLE_POSTS_PER_DAY = 3;

/** Minimum spacing between automated ARTICLE posts. Prevents the instant-publish
 *  path and a queue slot from firing within minutes of each other (the observed
 *  "double post"). Manual force posts bypass this. */
export const MIN_ARTICLE_GAP_MINUTES = 60;

/** Start of the UTC day containing `now`. The cadence and the queue slots are
 *  all reasoned about in UTC, so the daily window is a UTC calendar day. */
function utcDayStart(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
}

export interface ArticleSocialBudget {
  /** Article posts already shipped to Facebook so far today (UTC). */
  postedToday: number;
  /** Slots still available today (>= 0). */
  remaining: number;
  /** True when today's cap is reached — automated posting must stand down. */
  atCap: boolean;
  /** Timestamp of the most recent successful article post (any day), or null. */
  lastPostedAt: Date | null;
  /** True when the last post was less than MIN_ARTICLE_GAP_MINUTES ago. */
  withinMinGap: boolean;
  /** Convenience: an automated post may go out now (under cap AND past the gap). */
  canPostNow: boolean;
}

/**
 * Report the automated ARTICLE posting budget: today's count vs the daily cap
 * AND the spacing since the last post. Both the instant publish hook and the
 * drip queue mirror into `social_posts` (status='posted', postedAt set), so this
 * single read governs both paths — they never collectively exceed the daily cap,
 * and neither fires within {@link MIN_ARTICLE_GAP_MINUTES} of the other.
 */
export async function getArticleSocialBudget(
  now: Date = new Date(),
): Promise<ArticleSocialBudget> {
  const dayStart = utcDayStart(now);
  const [row] = await db
    .select({
      // count(*) FILTER limits the tally to today; max() is over all time so the
      // spacing gate also catches a post made just before the UTC day boundary.
      postedToday: sql<number>`count(*) filter (where ${socialPostsTable.postedAt} >= ${dayStart})::int`,
      lastPostedAt: sql<string | null>`max(${socialPostsTable.postedAt})`,
    })
    .from(socialPostsTable)
    .where(
      and(
        eq(socialPostsTable.platform, "facebook"),
        eq(socialPostsTable.status, "posted"),
      ),
    );
  const postedToday = Number(row?.postedToday ?? 0);
  const remaining = Math.max(0, MAX_ARTICLE_POSTS_PER_DAY - postedToday);
  const atCap = remaining <= 0;
  // Raw sql() aggregates come back as strings — coerce before date math.
  const lastPostedAt = row?.lastPostedAt ? new Date(row.lastPostedAt) : null;
  const withinMinGap = lastPostedAt
    ? now.getTime() - lastPostedAt.getTime() < MIN_ARTICLE_GAP_MINUTES * 60_000
    : false;
  return {
    postedToday,
    remaining,
    atCap,
    lastPostedAt,
    withinMinGap,
    canPostNow: !atCap && !withinMinGap,
  };
}

/**
 * Resolve the absolute, publicly-fetchable HTTPS URL for an object-storage
 * image so Zernio can fetch it for `mediaItems`. Public objects are served by
 * this api-server at `/api/storage/public-objects/...`; siteUrl() makes the
 * path absolute on the production (or dev) domain, which the shared proxy
 * routes back here. Already-absolute URLs are returned unchanged; empty/nullish
 * inputs return null so callers can omit the attachment.
 */
export function absolutePublicImageUrl(url: string | null | undefined): string | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return siteUrl(trimmed);
}
