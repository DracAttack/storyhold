import { and, eq, gte, isNull, sql, desc } from "drizzle-orm";
import { db, articlesTable, beatsTable, type HookVariant, type HookAssignments } from "@workspace/db";
import { publicObjectExists, DEFAULT_SHARE_CARD_URL } from "../lib/objectStorage";

/**
 * Resolve the title to show for an article in the newsletter: the headline text
 * of the hook mode assigned to the "newsletter" surface, else the full title.
 * Mirrors `resolveHookText` in the site's seoText.ts (the api-server can't import
 * from artifacts/site, so the small resolution is duplicated here).
 */
function resolveNewsletterTitle(
  title: string,
  variants: HookVariant[] | null | undefined,
  assignments: HookAssignments | null | undefined,
): string {
  if (!variants || variants.length === 0 || !assignments) return title;
  const mode = assignments.newsletter;
  if (!mode) return title;
  const text = variants.find((v) => v.mode === mode)?.text?.replace(/\s+/g, " ").trim();
  return text || title;
}

export const SITE_BASE_URL = (process.env["SITE_BASE_URL"] ?? process.env["REPLIT_DEV_DOMAIN"] ?? "").replace(/\/$/, "");
const STORAGE_PREFIX = "/api/storage/public-objects/";

// Brand palette (mirrors the site's light theme, converted to hex for email clients).
export const INK = "#1F242E";
export const BODY = "#3C4250";
export const MUTED = "#9A8F80";
export const TERRACOTTA = "#AC5639";
export const CREAM_OUTER = "#F2EFE7";
export const CARD = "#FFFDF8";
export const RULE = "#ECE6DA";
export const SERIF = "Georgia, 'Playfair Display', 'Times New Roman', serif";
export const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";

export function siteUrl(p = "/"): string {
  if (!SITE_BASE_URL) return p;
  const base = SITE_BASE_URL.startsWith("http") ? SITE_BASE_URL : `https://${SITE_BASE_URL}`;
  return `${base}${p}`;
}

export function absoluteUrl(p: string): string {
  if (!p) return p;
  if (p.startsWith("http")) return p;
  return siteUrl(p.startsWith("/") ? p : `/${p}`);
}

/**
 * Append a `?w=` width hint so email clients fetch a small resized derivative
 * instead of the raw hero image. Raw PNG heroes are ~1.3MB, and Gmail's image
 * proxy (GoogleImageProxy) silently refuses to load images that large — so the
 * picture never appears in the inbox (JPEG heroes, ~150KB, loaded fine, which is
 * why it looked intermittent). The public-object route serves a cached, resized
 * derivative for `?w=`. Idempotent w.r.t. an existing query string.
 *
 * Share cards are already-composed JPEGs (~150KB) and skip the ?w= derivative
 * entirely — they are returned as-is to avoid the slow on-the-fly transcoding.
 */
export function emailImageSrc(url: string, isShareCard: boolean, width: number): string {
  if (!url) return url;
  if (isShareCard) return url; // already optimised; skip the slow derivative
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}w=${width}`;
}

export interface UtmParams {
  source: string;
  medium: string;
  campaign: string;
}

// Canonical UTM tags for the Zernio Facebook auto-poster. Kept in lockstep with
// the seeded `utm_presets` rows (campaigns FBA / FBM) so the admin link builder
// and the auto-poster attribute traffic the same way. Article posts (back-queue
// drip + instant publish) use FBA; meme posts use FBM.
export const ARTICLE_FB_UTM: UtmParams = { source: "FB", medium: "Artic", campaign: "FBA" };
export const MEME_FB_UTM: UtmParams = { source: "FB", medium: "Memes", campaign: "FBM" };

// Set utm_source/medium/campaign on a URL, preserving any other query params
// and the fragment. Idempotent: existing utm_* keys are OVERWRITTEN, never
// duplicated, so re-applying (or wrapping an already-tagged link) is safe.
// Works on absolute and relative URLs alike. Returns the input unchanged when empty.
export function withUtm(url: string, utm: UtmParams): string {
  if (!url) return url;
  const hashIndex = url.indexOf("#");
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = withoutHash.indexOf("?");
  const path = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const params = new URLSearchParams(queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "");
  params.set("utm_source", utm.source);
  params.set("utm_medium", utm.medium);
  params.set("utm_campaign", utm.campaign);
  const qs = params.toString();
  return `${path}${qs ? `?${qs}` : ""}${hash}`;
}

export function unsubscribeUrl(token: string): string {
  return siteUrl(`/unsubscribe?token=${encodeURIComponent(token)}`);
}

/**
 * RFC 8058 one-click unsubscribe headers for bulk sends (the weekly
 * newsletter). Gmail/Yahoo bulk-sender rules require header-based one-click
 * unsubscribe; mailbox providers POST `List-Unsubscribe=One-Click` to the URL
 * with no cookies, so it must be a public endpoint keyed only by the token
 * (see POST /api/public/unsubscribe-oneclick). The mailto fallback lands in
 * the monitored editor inbox.
 */
export function oneClickUnsubscribeHeaders(token: string): Record<string, string> {
  const url = siteUrl(`/api/public/unsubscribe-oneclick?token=${encodeURIComponent(token)}`);
  return {
    "List-Unsubscribe": `<${url}>, <mailto:editor@brainhook.net?subject=unsubscribe>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type FeedArticle = {
  slug: string;
  title: string;
  /** Title to show in the newsletter: the assigned newsletter hook, else title. */
  newsletterTitle: string;
  dek: string;
  category: string;
  /** Beat slug — present when fetched grouped by beat. */
  categorySlug?: string;
  readingTimeMinutes: number;
  heroImage: string;
  /** True when heroImage points at a pre-composed share card.  Email renderers
   * skip the ?w= derivative for share cards (already optimised JPEG). */
  isShareCard: boolean;
  publishedAt: Date | null;
};

/**
 * Pick the best email image for an article. Prefers the branded share card
 * (already-composed JPEG, ~150KB) over the raw hero PNG (~1.3MB). Both are
 * resolved to absolute URLs; missing or legacy assets fall back to the
 * branded default card so the email never embeds a 404.
 */
export async function resolveEmailImage(
  heroImage: string,
  shareImage: string | null,
  _slug: string,
): Promise<{ image: string; isShareCard: boolean }> {
  // 1. If a share card exists, use it directly (already optimised JPEG).
  if (shareImage) {
    if (shareImage.startsWith(STORAGE_PREFIX)) {
      const filePath = shareImage.slice(STORAGE_PREFIX.length);
      try {
        if (await publicObjectExists(filePath)) {
          return { image: absoluteUrl(shareImage), isShareCard: true };
        }
      } catch {
        /* fall through */
      }
    } else if (shareImage.startsWith("http")) {
      return { image: shareImage, isShareCard: true };
    }
  }
  // 2. Fall back to the raw hero (legacy or pre-share-card articles).
  if (heroImage && heroImage.includes("picsum.photos")) {
    return { image: absoluteUrl(DEFAULT_SHARE_CARD_URL), isShareCard: false };
  }
  if (heroImage && heroImage.startsWith(STORAGE_PREFIX)) {
    const filePath = heroImage.slice(STORAGE_PREFIX.length);
    try {
      if (!(await publicObjectExists(filePath))) {
        return { image: absoluteUrl(DEFAULT_SHARE_CARD_URL), isShareCard: false };
      }
    } catch {
      /* keep original on existence-check failure */
    }
  }
  return { image: absoluteUrl(heroImage), isShareCard: false };
}

type ArticleRow = {
  slug: string;
  title: string;
  dek: string;
  category: string;
  categorySlug: string;
  readingTimeMinutes: number;
  heroImage: string;
  shareImage: string | null;
  publishedAt: Date | null;
  hookVariants: HookVariant[] | null;
  hookAssignments: HookAssignments | null;
};

async function shapeArticles(rows: ArticleRow[], includeSlug = false): Promise<FeedArticle[]> {
  return Promise.all(
    rows.map(async (r) => {
      const { image, isShareCard } = await resolveEmailImage(r.heroImage, r.shareImage, r.slug);
      return {
        slug: r.slug,
        title: r.title,
        newsletterTitle: resolveNewsletterTitle(r.title, r.hookVariants, r.hookAssignments),
        dek: r.dek,
        category: r.category,
        ...(includeSlug ? { categorySlug: r.categorySlug } : {}),
        readingTimeMinutes: r.readingTimeMinutes,
        heroImage: image,
        isShareCard,
        publishedAt: r.publishedAt,
      };
    }),
  );
}

const SELECT_COLS = {
  slug: articlesTable.slug,
  title: articlesTable.title,
  dek: articlesTable.dek,
  category: articlesTable.category,
  categorySlug: articlesTable.categorySlug,
  readingTimeMinutes: articlesTable.readingTimeMinutes,
  heroImage: articlesTable.heroImage,
  shareImage: articlesTable.shareImage,
  publishedAt: articlesTable.publishedAt,
  hookVariants: articlesTable.hookVariants,
  hookAssignments: articlesTable.hookAssignments,
} as const;

/** Fetch a handful of random published articles (used by the welcome email). */
export async function fetchRandomArticles(count: number): Promise<FeedArticle[]> {
  const rows = await db
    .select(SELECT_COLS)
    .from(articlesTable)
    .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)))
    .orderBy(sql`random()`)
    .limit(count);
  return shapeArticles(rows);
}

/**
 * Fetch articles published within the last `sinceDays` days, newest first. If
 * none were published in that window, fall back to the most recent published
 * articles so the weekly email is never empty.
 */
export async function fetchRecentArticles(sinceDays: number, max: number): Promise<FeedArticle[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const recent = await db
    .select(SELECT_COLS)
    .from(articlesTable)
    .where(and(eq(articlesTable.status, "published"), gte(articlesTable.publishedAt, since), isNull(articlesTable.quarantinedAt)))
    .orderBy(sql`${articlesTable.publishedAt} DESC NULLS LAST`)
    .limit(max);
  if (recent.length > 0) return shapeArticles(recent);

  // Fallback: most-recent published stories. NULLS LAST keeps undated rows from
  // jumping to the top (Postgres defaults DESC to NULLS FIRST).
  const fallback = await db
    .select(SELECT_COLS)
    .from(articlesTable)
    .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)))
    .orderBy(sql`${articlesTable.publishedAt} DESC NULLS LAST`)
    .limit(max);
  return shapeArticles(fallback);
}

/**
 * Fetch articles for one category (beat slug), newest first. Used to tailor the
 * weekly digest to a subscriber's chosen subject. Like `fetchRecentArticles`,
 * it prefers stories published within the window and falls back to the most
 * recent published stories *in that category* so a quiet week still produces a
 * full email. Returns an empty array when the category has no published
 * articles at all — the caller then falls back to the general digest.
 */
export async function fetchRecentArticlesByCategory(categorySlug: string, sinceDays: number, max: number): Promise<FeedArticle[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const recent = await db
    .select(SELECT_COLS)
    .from(articlesTable)
    .where(
      and(
        eq(articlesTable.status, "published"),
        eq(articlesTable.categorySlug, categorySlug),
        gte(articlesTable.publishedAt, since),
        isNull(articlesTable.quarantinedAt),
      ),
    )
    .orderBy(sql`${articlesTable.publishedAt} DESC NULLS LAST`)
    .limit(max);
  if (recent.length > 0) return shapeArticles(recent);

  const fallback = await db
    .select(SELECT_COLS)
    .from(articlesTable)
    .where(
      and(
        eq(articlesTable.status, "published"),
        eq(articlesTable.categorySlug, categorySlug),
        isNull(articlesTable.quarantinedAt),
      ),
    )
    .orderBy(sql`${articlesTable.publishedAt} DESC NULLS LAST`)
    .limit(max);
  return shapeArticles(fallback);
}

export type BeatArticleGroup = {
  beatName: string;
  beatSlug: string;
  articles: FeedArticle[];
};

/**
 * Fetch recent articles grouped by beat, ordered by the beat's sortOrder.
 * Each beat gets up to `maxPerBeat` articles; the total across all beats is
 * capped at `maxTotal`. Falls back to most-recent published articles in each
 * beat when the window is empty. Quiet beats are omitted (they contribute
 * nothing). Used for the "Everything" newsletter so each section is a
 * self-contained beat digest.
 */
export async function fetchRecentArticlesGroupedByBeat(
  sinceDays: number,
  maxPerBeat: number,
  maxTotal: number,
): Promise<BeatArticleGroup[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

  // Load all beats in presentation order
  const beats = await db
    .select({ slug: beatsTable.slug, name: beatsTable.name })
    .from(beatsTable)
    .orderBy(beatsTable.sortOrder);

  const groups: BeatArticleGroup[] = [];
  let total = 0;

  for (const beat of beats) {
    if (total >= maxTotal) break;

    // Prefer windowed articles, fallback to most recent in the beat
    const limit = Math.min(maxPerBeat, maxTotal - total);

    const windowed = await db
      .select(SELECT_COLS)
      .from(articlesTable)
      .where(
        and(
          eq(articlesTable.status, "published"),
          eq(articlesTable.categorySlug, beat.slug),
          gte(articlesTable.publishedAt, since),
          isNull(articlesTable.quarantinedAt),
        ),
      )
      .orderBy(sql`${articlesTable.publishedAt} DESC NULLS LAST`)
      .limit(limit);

    const rows =
      windowed.length > 0
        ? windowed
        : await db
            .select(SELECT_COLS)
            .from(articlesTable)
            .where(
              and(
                eq(articlesTable.status, "published"),
                eq(articlesTable.categorySlug, beat.slug),
                isNull(articlesTable.quarantinedAt),
              ),
            )
            .orderBy(sql`${articlesTable.publishedAt} DESC NULLS LAST`)
            .limit(limit);

    if (rows.length === 0) continue; // quiet beat

    const articles = await shapeArticles(rows, true);
    groups.push({ beatName: beat.name, beatSlug: beat.slug, articles });
    total += articles.length;
  }

  return groups;
}
