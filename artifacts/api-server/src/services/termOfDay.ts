import {
  db,
  conceptsTable,
  articleConceptMentionsTable,
  articlesTable,
  termOfDayPostsTable,
  type TermOfDayPost,
} from "@workspace/db";
import { and, desc, eq, lt, ne, sql } from "drizzle-orm";
import { getSiteSettings, type SiteSettingsValues } from "./siteSettings";
import { siteUrl } from "./emailShared";
import { isZernioConfigured, isZernioPostingAllowed } from "./social";
import { ellipsize } from "./termOfDayCard";
import { logger } from "../lib/logger";
import { sanitizeHashtagTokens, ensureLearningTag } from "./hashtagPolicy";
import { generateTermOfDayHashtags, AiFunctionDisabledError } from "./llm";
import { phoenixDaypartFromUtcHour, pickTermOpener } from "./postOpeners";

// Hard floor for the per-term repeat cooldown: a term posted to Facebook stays
// out of the randomization pool for AT LEAST this many days, regardless of the
// admin setting. Editorial rule — repeats sooner than this read as recycled.
export const TOD_COOLDOWN_FLOOR_DAYS = 180;

// =============================================================================
// Term of the Day — one automated daily glossary-term post to Facebook via
// Zernio. Selection is WEIGHTED random over deterministic, zero-AI heuristics;
// the caption is assembled verbatim from stored glossary fields (no LLM); the
// card is a branded template (no AI image generation). A partial-unique date
// claim on term_of_day_posts guarantees retries can never double-post a day.
// =============================================================================

const ZERNIO_BASE = "https://zernio.com/api/v1";
const CREATE_TIMEOUT_MS = 20_000;
const POLL_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

// A 'posting' claim older than this is considered orphaned (prior run died
// between claiming the day and finishing the send) and may be reclaimed.
const STALE_POSTING_TAKEOVER_MS = 10 * 60 * 1000;
const POLL_TRIES = 3;
const POLL_DELAY_MS = 1_500;

function zernioKey(): string {
  return process.env["ZERNIO_API_KEY"] ?? "";
}
function zernioAccountId(): string {
  return process.env["ZERNIO_FACEBOOK_ACCOUNT_ID"] ?? "";
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

interface ZernioCreateResponse {
  post?: { _id?: string };
}
interface ZernioGetResponse {
  post?: {
    _id?: string;
    postUrl?: string;
    permalink?: string;
    results?: Array<{ url?: string; postUrl?: string }>;
  };
}

function extractFacebookUrl(data: ZernioGetResponse | null): string | null {
  const post = data?.post;
  if (!post) return null;
  if (post.postUrl) return post.postUrl;
  if (post.permalink) return post.permalink;
  return post.results?.map((r) => r.url ?? r.postUrl).find(Boolean) ?? null;
}

async function pollForFacebookUrl(zernioPostId: string): Promise<string | null> {
  for (let i = 0; i < POLL_TRIES; i++) {
    if (i > 0) await sleep(POLL_DELAY_MS);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
    try {
      const resp = await fetch(`${ZERNIO_BASE}/posts/${encodeURIComponent(zernioPostId)}`, {
        headers: { Authorization: `Bearer ${zernioKey()}` },
        signal: controller.signal,
      });
      if (resp.ok) {
        const data = (await resp.json().catch(() => null)) as ZernioGetResponse | null;
        const url = extractFacebookUrl(data);
        if (url) return url;
      } else {
        await resp.body?.cancel().catch(() => {});
      }
    } catch {
      // best-effort — the post succeeded even if the permalink can't be resolved
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

/** UTC calendar date bucket, e.g. "2026-07-11". */
export function todayKey(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Candidate pool + deterministic weighting
// ---------------------------------------------------------------------------

export interface WeightEntry {
  reason: string;
  delta: string;
}

export interface TermCandidate {
  conceptId: string;
  slug: string;
  term: string;
  definition: string;
  hoverDefinition: string;
  realLifeExample: string | null;
  whatItIsnt: string | null;
  commonlyMisusedOnline: string | null;
  moduleType: string | null;
  shareImage: string | null;
  /** Stored 4:5 feed CSS card (1200×1470 on its stacked-sheet plate, glossary-cards-fb/{slug}-card.png). Used as the Zernio post image. */
  cardImageUrl: string | null;
  beatSlug: string;
  publishedArticleCount: number;
  relatedArticleIds: string[];
  lastPostedDate: string | null;
  weight: number;
  breakdown: WeightEntry[];
}

// Sensitive vocabulary — terms whose subject matter shouldn't headline a
// lighthearted daily brand post. Heavy multiplicative penalty, not a hard
// exclusion, so a beat consisting only of such terms can still surface one.
const SENSITIVE_RE =
  /\b(suicide|self[- ]harm|rape|sexual assault|incest|pedophil|child abuse|genocide|overdose|molest)\w*\b/i;

// Bill numbers / statute citations ("HR 1234", "S. 405", "SB-12") read as
// administrative homework, not a shareable term.
const BILL_NUMBER_RE = /\b(h\.?\s?r\.?|s\.?\s?b\.?|h\.?\s?b\.?|a\.?\s?b\.?|s)\.?\s*-?\s*\d{2,5}\b/i;

/** Count 4-digit years in a text — date-dense definitions read like a docket. */
function yearCount(text: string): number {
  return (text.match(/\b(1[89]\d{2}|20\d{2})\b/g) ?? []).length;
}

/** Mid-sentence capitalized words — a rough proper-noun density signal. */
function properNounCount(text: string): number {
  return (text.match(/(?<=[a-z,;] )[A-Z][a-z]{2,}/g) ?? []).length;
}

interface WeightContext {
  neverUsed: boolean;
  engagementBonus: number;
  recentSameBeatCount: number;
}

/**
 * Deterministic candidate weight. Additive general-interest bonuses are scaled
 * by termOfDayGeneralInterestStrength; every technical/administrative penalty
 * multiplier is blended toward 1 by termOfDayTechnicalPenaltyStrength (1 = full
 * spec penalty, 0 = penalties off). Beat balancing divides by 1 + the number of
 * same-beat posts in the recent window. Never negative; floored at 0.05.
 */
export function computeCandidateWeight(
  c: Omit<TermCandidate, "weight" | "breakdown" | "lastPostedDate">,
  ctx: WeightContext,
  s: SiteSettingsValues,
): { weight: number; breakdown: WeightEntry[] } {
  const gi = Math.max(0, s.termOfDayGeneralInterestStrength);
  const tp = Math.min(1, Math.max(0, s.termOfDayTechnicalPenaltyStrength));
  const blend = (m: number) => 1 - (1 - m) * tp;
  const breakdown: WeightEntry[] = [];
  let w = 10;
  breakdown.push({ reason: "base", delta: "10" });

  // --- General-interest bonuses (additive, scaled by gi) --------------------
  if (c.moduleType === "general") {
    const b = 3 * gi;
    w += b;
    breakdown.push({ reason: "module_general", delta: `+${b.toFixed(1)}` });
  } else if (c.moduleType === "behavioral") {
    const b = 2 * gi;
    w += b;
    breakdown.push({ reason: "module_behavioral", delta: `+${b.toFixed(1)}` });
  }
  const articleBonus = Math.min(c.publishedArticleCount, 5) * 0.5 * gi;
  if (articleBonus > 0) {
    w += articleBonus;
    breakdown.push({ reason: "article_coverage", delta: `+${articleBonus.toFixed(1)}` });
  }
  if (ctx.neverUsed) {
    w += 2;
    breakdown.push({ reason: "never_used", delta: "+2" });
  }
  if (ctx.engagementBonus !== 0) {
    w += ctx.engagementBonus;
    breakdown.push({
      reason: "engagement_history",
      delta: `${ctx.engagementBonus >= 0 ? "+" : ""}${ctx.engagementBonus.toFixed(1)}`,
    });
  }

  // --- Technical / administrative penalties (multiplicative, blended) -------
  const applyPenalty = (reason: string, mult: number) => {
    const eff = blend(mult);
    if (eff >= 0.999) return;
    w *= eff;
    breakdown.push({ reason, delta: `×${eff.toFixed(2)}` });
  };
  if (c.moduleType === "technical") applyPenalty("module_technical", 0.5);
  if (c.moduleType === "medical") applyPenalty("module_medical", 0.7);
  if (/^[A-Z]{2,6}$/.test(c.term.trim())) applyPenalty("acronym", 0.5);
  if (BILL_NUMBER_RE.test(c.term)) applyPenalty("bill_number", 0.35);
  else if (/\d/.test(c.term)) applyPenalty("numeric_term", 0.5);
  if (c.term.length > 30 || c.term.trim().split(/\s+/).length >= 5) {
    applyPenalty("long_term", 0.75);
  }
  const defText = c.definition || c.hoverDefinition;
  if (yearCount(defText) >= 2) applyPenalty("date_heavy_definition", 0.8);
  if (properNounCount(defText) >= 4) applyPenalty("name_heavy_definition", 0.8);
  if (SENSITIVE_RE.test(`${c.term} ${defText}`)) applyPenalty("sensitive_subject", 0.15);

  // --- Beat balancing (always on; window size configurable) -----------------
  if (ctx.recentSameBeatCount > 0) {
    const mult = 1 / (1 + ctx.recentSameBeatCount);
    w *= mult;
    breakdown.push({ reason: "recent_beat_balance", delta: `×${mult.toFixed(2)}` });
  }

  return { weight: Math.max(0.05, w), breakdown };
}

/**
 * Build the eligible, weighted candidate pool. Deterministic (no AI): live
 * concepts with a real definition, ≥ min connected PUBLISHED articles, not in
 * beat/module exclusions, and outside the cooldown window since their last
 * non-failed Term of the Day appearance.
 */
export async function buildTermOfDayPool(
  now: Date,
  s?: SiteSettingsValues,
): Promise<TermCandidate[]> {
  const settings = s ?? (await getSiteSettings());

  const concepts = await db
    .select({
      id: conceptsTable.id,
      slug: conceptsTable.slug,
      term: conceptsTable.term,
      definition: conceptsTable.definition,
      hoverDefinition: conceptsTable.hoverDefinition,
      realLifeExample: conceptsTable.realLifeExample,
      whatItIsnt: conceptsTable.whatItIsnt,
      commonlyMisusedOnline: conceptsTable.commonlyMisusedOnline,
      moduleType: conceptsTable.moduleType,
      shareImage: conceptsTable.shareImage,
      cardImageUrl: conceptsTable.cardImageUrl,
    })
    .from(conceptsTable)
    .where(
      and(
        eq(conceptsTable.status, "live"),
        ne(conceptsTable.definition, ""),
        eq(conceptsTable.termOfDayBlocked, false),
      ),
    );
  if (concepts.length === 0) return [];

  // Published-article connections per concept → beat + count + article ids.
  const mentions = await db
    .select({
      conceptId: articleConceptMentionsTable.conceptId,
      articleId: articlesTable.id,
      categorySlug: articlesTable.categorySlug,
    })
    .from(articleConceptMentionsTable)
    .innerJoin(
      articlesTable,
      and(
        eq(articlesTable.id, articleConceptMentionsTable.articleId),
        eq(articlesTable.status, "published"),
      ),
    );
  const byConcept = new Map<string, { articleIds: string[]; beatCounts: Map<string, number> }>();
  for (const m of mentions) {
    let entry = byConcept.get(m.conceptId);
    if (!entry) {
      entry = { articleIds: [], beatCounts: new Map() };
      byConcept.set(m.conceptId, entry);
    }
    entry.articleIds.push(m.articleId);
    entry.beatCounts.set(m.categorySlug, (entry.beatCounts.get(m.categorySlug) ?? 0) + 1);
  }

  // Posting history: cooldown, never-used bonus, engagement, beat window.
  const history = await db
    .select({
      conceptId: termOfDayPostsTable.conceptId,
      postDate: termOfDayPostsTable.postDate,
      beatSlug: termOfDayPostsTable.beatSlug,
      status: termOfDayPostsTable.status,
      totalEngagement: termOfDayPostsTable.totalEngagement,
    })
    .from(termOfDayPostsTable)
    .where(ne(termOfDayPostsTable.status, "failed"))
    .orderBy(desc(termOfDayPostsTable.postDate));

  const lastPostedByConcept = new Map<string, string>();
  const engagementByConcept = new Map<string, number[]>();
  const allEngagement: number[] = [];
  for (const h of history) {
    if (!lastPostedByConcept.has(h.conceptId)) lastPostedByConcept.set(h.conceptId, h.postDate);
    if (h.status === "posted" && typeof h.totalEngagement === "number") {
      const arr = engagementByConcept.get(h.conceptId) ?? [];
      arr.push(h.totalEngagement);
      engagementByConcept.set(h.conceptId, arr);
      allEngagement.push(h.totalEngagement);
    }
  }
  const globalAvgEngagement =
    allEngagement.length > 0 ? allEngagement.reduce((a, b) => a + b, 0) / allEngagement.length : 0;

  // Beat counts over the recent window (history is already date-descending).
  const windowSize = Math.max(0, settings.termOfDayBeatWindow);
  const recentBeatCounts = new Map<string, number>();
  for (const h of history.slice(0, windowSize)) {
    if (h.beatSlug) recentBeatCounts.set(h.beatSlug, (recentBeatCounts.get(h.beatSlug) ?? 0) + 1);
  }

  // Cooldown cutoff, compared lexicographically against YYYY-MM-DD keys.
  // Floored at 180 days — already-posted terms stay out of the pool for at
  // least six months no matter what the setting says.
  const cooldownDays = Math.max(TOD_COOLDOWN_FLOOR_DAYS, settings.termOfDayCooldownDays);
  const cutoff = new Date(now.getTime() - cooldownDays * 86_400_000);
  const cutoffKey = todayKey(cutoff);

  const included = new Set(settings.termOfDayIncludedBeats);
  const excluded = new Set(settings.termOfDayExcludedBeats);
  const excludedModules = new Set(settings.termOfDayExcludedModuleTypes);

  const pool: TermCandidate[] = [];
  for (const c of concepts) {
    const conn = byConcept.get(c.id);
    const publishedCount = conn?.articleIds.length ?? 0;
    if (publishedCount < settings.termOfDayMinArticles) continue;
    if (!c.cardImageUrl) continue; // only terms with a captured CSS share card
    if (c.moduleType && excludedModules.has(c.moduleType)) continue;

    // Dominant beat of connected published articles (ties → higher count wins,
    // then alphabetical for determinism).
    let beatSlug = "";
    if (conn) {
      const sorted = [...conn.beatCounts.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      );
      beatSlug = sorted[0]?.[0] ?? "";
    }
    if (included.size > 0 && !included.has(beatSlug)) continue;
    if (excluded.has(beatSlug)) continue;

    const lastPosted = lastPostedByConcept.get(c.id) ?? null;
    if (lastPosted && lastPosted >= cutoffKey) continue; // still cooling down

    // Engagement bonus: this concept's average vs the global average, scaled
    // and capped at +3 (floored at −1). Only when history exists AND enabled.
    let engagementBonus = 0;
    if (settings.termOfDayEngagementWeighting && globalAvgEngagement > 0) {
      const own = engagementByConcept.get(c.id);
      if (own && own.length > 0) {
        const avg = own.reduce((a, b) => a + b, 0) / own.length;
        engagementBonus = Math.min(3, Math.max(-1, 3 * (avg / globalAvgEngagement - 1)));
      }
    }

    const base = {
      conceptId: c.id,
      slug: c.slug,
      term: c.term,
      definition: c.definition,
      hoverDefinition: c.hoverDefinition,
      realLifeExample: c.realLifeExample,
      whatItIsnt: c.whatItIsnt,
      commonlyMisusedOnline: c.commonlyMisusedOnline,
      moduleType: c.moduleType,
      shareImage: c.shareImage,
      cardImageUrl: c.cardImageUrl,
      beatSlug,
      publishedArticleCount: publishedCount,
      relatedArticleIds: conn?.articleIds ?? [],
    };
    const { weight, breakdown } = computeCandidateWeight(
      base,
      {
        neverUsed: !lastPostedByConcept.has(c.id),
        engagementBonus,
        recentSameBeatCount: recentBeatCounts.get(beatSlug) ?? 0,
      },
      settings,
    );
    pool.push({ ...base, lastPostedDate: lastPosted, weight, breakdown });
  }
  return pool;
}

/** Weighted random pick. `rand` is injectable for tests. */
export function pickWeighted(
  pool: TermCandidate[],
  rand: () => number = Math.random,
): TermCandidate | null {
  if (pool.length === 0) return null;
  const total = pool.reduce((a, c) => a + c.weight, 0);
  let r = rand() * total;
  for (const c of pool) {
    r -= c.weight;
    if (r <= 0) return c;
  }
  return pool[pool.length - 1] ?? null;
}

// ---------------------------------------------------------------------------
// Deterministic caption + hashtags + tracked URL (zero AI)
// ---------------------------------------------------------------------------

// UTM scheme for Term of the Day links: campaign + per-term content tag so the
// traffic dashboard can attribute clicks to the feature AND the specific term.
const TOD_UTM = { source: "FB", medium: "Terms", campaign: "term_of_the_day" };

/** Glossary URL with the Term of the Day UTM tags (utm_content = term slug). */
export function termTrackedUrl(slug: string): string {
  const base = siteUrl(`/glossary/${encodeURIComponent(slug)}`);
  const hashIndex = base.indexOf("#");
  const hash = hashIndex >= 0 ? base.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? base.slice(0, hashIndex) : base;
  const queryIndex = withoutHash.indexOf("?");
  const path = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const params = new URLSearchParams(queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "");
  params.set("utm_source", TOD_UTM.source);
  params.set("utm_medium", TOD_UTM.medium);
  params.set("utm_campaign", TOD_UTM.campaign);
  params.set("utm_content", slug);
  return `${path}?${params.toString()}${hash}`;
}

/** PascalCase a phrase into a hashtag-safe token (letters/digits only). */
function hashtagToken(phrase: string): string {
  return phrase
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
}

// Friendly hashtag for a module type. `general` adds nothing.
const MODULE_HASHTAG: Record<string, string> = {
  behavioral: "Psychology",
  medical: "Health",
  technical: "Science",
};

/**
 * Deterministic hashtag set: the term itself first (the one "self-referential"
 * tag worth keeping — it IS the content), then each beat word as its OWN
 * single-word tag (people follow #Relationships and #Communication, not
 * #RelationshipsCommunication), then the module-type tag. No brand tags —
 * they eat a slot and do nothing for reach. Deduped, capped at maxHashtags,
 * with the global hashtag policy applied as the final gate.
 */
export function buildTermHashtags(
  c: Pick<TermCandidate, "term" | "beatSlug" | "moduleType">,
  maxHashtags: number,
): string[] {
  const tags: string[] = [];
  const push = (t: string | undefined) => {
    if (!t) return;
    const token = hashtagToken(t);
    if (!token || token.length > 30 || /^\d+$/.test(token)) return;
    if (!tags.some((x) => x.toLowerCase() === token.toLowerCase())) tags.push(token);
  };
  push(c.term);
  for (const word of c.beatSlug.split("-")) push(word);
  if (c.moduleType) push(MODULE_HASHTAG[c.moduleType]);
  return sanitizeHashtagTokens(tags, {
    maxTags: Math.max(1, maxHashtags),
    keep: [hashtagToken(c.term)],
  });
}

/**
 * Content-aware hashtags via the `term_hashtags` AI function (reads the
 * definition and example, picks real tags that fit the subject matter), with
 * the deterministic beat-word builder as the fallback when the function is
 * paused or the call fails. The term's own tag always stays first.
 */
export async function resolveTermHashtags(
  c: Pick<TermCandidate, "term" | "definition" | "hoverDefinition" | "realLifeExample" | "beatSlug" | "moduleType">,
  maxHashtags: number,
): Promise<string[]> {
  try {
    const tags = await generateTermOfDayHashtags({
      term: c.term,
      definition: (c.definition || c.hoverDefinition).trim(),
      realLifeExample: c.realLifeExample,
      beatName: c.beatSlug.split("-").join(" "),
      moduleType: c.moduleType,
      maxTags: Math.max(1, maxHashtags),
      keepToken: hashtagToken(c.term),
    });
    if (tags.length > 0)
      return ensureLearningTag(tags, { maxTags: Math.max(1, maxHashtags), seed: c.term });
  } catch (err) {
    if (err instanceof AiFunctionDisabledError) {
      logger.info({ term: c.term }, "term of day: hashtag AI paused, using deterministic tags");
    } else {
      logger.warn({ err, term: c.term }, "term of day: hashtag AI failed, using deterministic tags");
    }
  }
  return ensureLearningTag(buildTermHashtags(c, maxHashtags), {
    maxTags: Math.max(1, maxHashtags),
    seed: c.term,
  });
}

// Openers now live in postOpeners.ts, keyed by the Phoenix-local daypart the
// post goes out in — with two term posts a day, "Term/Word of the Day"
// phrasing is retired (self-referential BrainHook flavor is still fine).

const TOD_CTAS: string[] = [
  "Full breakdown — and where this shows up in our reporting — is at the link in the first comment. 👇 Your likes, follows, and shares always mean the world.",
  "The complete glossary entry, with real-world context and related concepts, is linked in the first comment. 👇 If this was useful, a like, follow, and share goes a long way.",
  "Dive deeper at the link in the first comment — including how this shows up in the real world. 👇 Liking, following, and sharing would mean so much to us.",
  "The full entry is at the link in the first comment. 👇 We'd love it if you liked, followed, and shared.",
  "Get the full picture at the link in the first comment. 👇 Your likes, follows, and shares help us keep going.",
  "More context, examples, and related terms at the link in the first comment. 👇 If this resonated, a like, follow, and share goes a long way.",
];

/** Pick deterministically from an array using the slug as a stable seed. */
function pickBySlug<T>(arr: T[], slug: string): T {
  const code = [...slug].reduce((s, ch) => s + ch.charCodeAt(0), 0);
  return arr[code % arr.length]!;
}

/**
 * Assemble the post caption — NO AI. Structure mirrors article FB posts:
 * varied intro + term, full definition, CTA (link in comments + engagement ask),
 * hashtags. Real-life / misuse details live on the share-card image, not here.
 */
export function buildTermCaption(
  c: Pick<
    TermCandidate,
    "slug" | "term" | "definition" | "hoverDefinition" | "realLifeExample" | "commonlyMisusedOnline"
  >,
  hashtags: string[],
  /** UTC hour the post goes out — drives the time-of-day opener flavor. */
  postHourUtc: number,
): string {
  const parts: string[] = [];
  parts.push(pickTermOpener(phoenixDaypartFromUtcHour(postHourUtc), c.slug, c.term));
  const def = (c.definition || c.hoverDefinition).trim();
  if (def) parts.push(def);
  parts.push(pickBySlug(TOD_CTAS, c.slug + "cta"));
  if (hashtags.length > 0) parts.push(hashtags.map((t) => `#${t}`).join(" "));
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Preview (read-only) — powers admin preview + reroll
// ---------------------------------------------------------------------------

export interface TermOfDayPreview {
  candidate: TermCandidate | null;
  caption: string | null;
  hashtags: string[];
  trackedUrl: string | null;
  poolSize: number;
  topCandidates: TermCandidate[];
}

/**
 * Pick a term and build the full post exactly as the daily run would, WITHOUT
 * writing anything. `excludeSlugs` powers the admin "reroll" (already-seen
 * previews are excluded so each reroll shows a fresh term).
 */
export async function previewTermOfDay(excludeSlugs: string[] = []): Promise<TermOfDayPreview> {
  const settings = await getSiteSettings();
  const fullPool = await buildTermOfDayPool(new Date(), settings);
  const excluded = new Set(excludeSlugs);
  const pool = fullPool.filter((c) => !excluded.has(c.slug));
  const topCandidates = [...fullPool].sort((a, b) => b.weight - a.weight).slice(0, 12);
  const candidate = pickWeighted(pool);
  if (!candidate) {
    return { candidate: null, caption: null, hashtags: [], trackedUrl: null, poolSize: pool.length, topCandidates };
  }
  const hashtags = await resolveTermHashtags(candidate, settings.termOfDayMaxHashtags);
  return {
    candidate,
    caption: buildTermCaption(candidate, hashtags, settings.termOfDayHourUtc),
    hashtags,
    trackedUrl: termTrackedUrl(candidate.slug),
    poolSize: pool.length,
    topCandidates,
  };
}

// ---------------------------------------------------------------------------
// Daily run + Zernio posting
// ---------------------------------------------------------------------------

export interface RunTermOfDayResult {
  status: "posted" | "drafted" | "skipped" | "failed" | "disabled";
  reason?: string;
  postId?: string;
  slug?: string;
  facebookPostUrl?: string;
}

/** Postgres unique-violation (the date-claim insert losing the race). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}

/**
 * Run the Term of the Day for `now`'s UTC date. Steps:
 *  1. Gate on settings (unless forced) and Zernio configuration.
 *  2. Weighted-random select an eligible term.
 *  3. CLAIM the date — insert the history row (status 'posting' / 'draft')
 *     under the partial unique index BEFORE any external call, so concurrent
 *     runs and retries can never double-post; the loser sees 23505.
 *  4. Compose the branded card (template, no AI), then send via Zernio with the
 *     row's fixed x-request-id. Only a Zernio-confirmed id (or idempotent 409)
 *     finalizes 'posted'; failures mark 'failed', which releases the date.
 *
 * Draft-only mode (setting or dev environment) stops after the card: the row
 * stays 'draft' for admin review and nothing reaches Zernio.
 */
export async function runTermOfDay(
  now: Date = new Date(),
  opts: { force?: boolean; slug?: string; slot?: 1 | 2 } = {},
): Promise<RunTermOfDayResult> {
  const slot = opts.slot ?? 1;
  const settings = await getSiteSettings();
  if (!opts.force && !settings.termOfDayEnabled) return { status: "disabled" };

  const draftOnly = settings.termOfDayDraftOnly || !isZernioPostingAllowed();
  if (!draftOnly && !isZernioConfigured()) {
    return { status: "skipped", reason: "zernio_not_configured" };
  }

  const pool = await buildTermOfDayPool(now, settings);
  // If a specific slug was requested (admin locked in the preview), find it in
  // the eligible pool. Fall back to weighted-random if it's not there (e.g.
  // cooldown just expired), so the run always produces something.
  const candidate = opts.slug
    ? (pool.find((c) => c.slug === opts.slug) ?? pickWeighted(pool))
    : pickWeighted(pool);
  if (!candidate) {
    logger.info({ poolSize: 0 }, "term of day: no eligible term");
    return { status: "skipped", reason: "no_eligible_term" };
  }

  const hashtags = await resolveTermHashtags(candidate, settings.termOfDayMaxHashtags);
  const slotHourUtc =
    slot === 2 ? (settings.termOfDayHour2Utc ?? settings.termOfDayHourUtc) : settings.termOfDayHourUtc;
  const caption = buildTermCaption(candidate, hashtags, slotHourUtc);
  const trackedUrl = termTrackedUrl(candidate.slug);
  const postDate = todayKey(now);

  // Admin force mode: clear any existing today's row FOR THIS SLOT so the
  // editor can test-fire repeatedly without waiting 24 hours. This deletes the
  // prior draft/posted row — the history gap is acceptable for a manual
  // override.
  if (opts.force) {
    const existingToday = await db
      .select({ id: termOfDayPostsTable.id })
      .from(termOfDayPostsTable)
      .where(
        and(eq(termOfDayPostsTable.postDate, postDate), eq(termOfDayPostsTable.slot, slot)),
      )
      .limit(1);
    if (existingToday.length > 0) {
      await db
        .delete(termOfDayPostsTable)
        .where(eq(termOfDayPostsTable.id, existingToday[0]!.id));
      logger.info({ postDate, previousId: existingToday[0]!.id }, "term of day: force-deleted existing today row");
    }
  }

  // Claim the date FIRST (before the card + Zernio) — the partial unique index
  // makes this the single-writer election for the day. One retry after
  // reclaiming a stale 'posting' row (a crashed prior run must not block the
  // whole day).
  let row: TermOfDayPost | null = null;
  for (let attempt = 0; attempt < 2 && !row; attempt++) {
    try {
      const inserted = await db
        .insert(termOfDayPostsTable)
        .values({
          conceptId: candidate.conceptId,
          slug: candidate.slug,
          term: candidate.term,
          beatSlug: candidate.beatSlug,
          postDate,
          slot,
          caption,
          hashtags,
          trackedUrl,
          relatedArticleIds: candidate.relatedArticleIds,
          selectionWeight: candidate.weight,
          weightBreakdown: candidate.breakdown,
          status: draftOnly ? "draft" : "posting",
          scheduledAt: now,
        })
        .returning();
      row = inserted[0]!;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Stale-claim recovery: a 'posting' row whose heartbeat (updatedAt) is
      // older than the takeover TTL means a prior run died mid-flight (e.g.
      // process crash between claim and send). Mark it failed — that frees
      // the partial unique index — and retry the claim once. NEVER touch
      // fresh 'posting' rows (a live run may be mid-send) or draft/posted.
      const staleBefore = new Date(now.getTime() - STALE_POSTING_TAKEOVER_MS);
      const reclaimed = await db
        .update(termOfDayPostsTable)
        .set({
          status: "failed",
          failureReason: "stale posting claim reclaimed (previous run died mid-flight)",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(termOfDayPostsTable.postDate, postDate),
            eq(termOfDayPostsTable.slot, slot),
            eq(termOfDayPostsTable.status, "posting"),
            lt(termOfDayPostsTable.updatedAt, staleBefore),
          ),
        )
        .returning({ id: termOfDayPostsTable.id });
      if (reclaimed.length === 0 || attempt === 1) {
        return { status: "skipped", reason: "already_claimed_today" };
      }
      logger.warn(
        { postDate, reclaimedId: reclaimed[0]!.id },
        "term of day: reclaimed stale posting row, retrying claim",
      );
    }
  }
  if (!row) return { status: "skipped", reason: "already_claimed_today" };

  try {
    // Use the stored 4:5 feed CSS card (1200×1470, glossary-cards-fb/{slug}-card.png,
    // "Glossary FB Cards (4:5)" in the Media Library) captured server-side by
    // headless Chromium. If the card hasn't been captured yet for this term,
    // post without an image rather than falling back to a template card.
    const imageUrl: string | null =
      settings.termOfDayImageEnabled ? (candidate.cardImageUrl ?? null) : null;
    if (imageUrl) {
      await db
        .update(termOfDayPostsTable)
        .set({ imageUrl, updatedAt: new Date() })
        .where(eq(termOfDayPostsTable.id, row.id));
    }

    if (draftOnly) {
      logger.info({ slug: candidate.slug, postDate }, "term of day: drafted (draft-only mode)");
      return { status: "drafted", postId: row.id, slug: candidate.slug };
    }

    return await sendTermOfDayToZernio({ ...row, imageUrl: imageUrl ?? row.imageUrl });
  } catch (err) {
    // Belt-and-suspenders: an unexpected throw after the claim must never
    // leave a stuck non-failed row blocking the day's unique index. Drafts
    // are kept (admin can retry them); a 'posting' claim flips to failed.
    if (!draftOnly) {
      const reason = err instanceof Error ? err.message : String(err);
      await markFailed(row.id, reason).catch(() => {});
      return { status: "failed", reason, postId: row.id, slug: candidate.slug };
    }
    throw err;
  }
}

/**
 * Post an existing 'draft' history row (admin "post this draft"). Atomically
 * claims draft → posting so a double-click can't send twice.
 */
export async function postTermOfDayDraft(
  id: string,
  opts: { force?: boolean } = {},
): Promise<RunTermOfDayResult> {
  if (!opts.force && !isZernioPostingAllowed()) {
    return { status: "skipped", reason: "posting_disabled_in_dev" };
  }
  if (!isZernioConfigured()) return { status: "skipped", reason: "zernio_not_configured" };
  const [claim] = await db
    .update(termOfDayPostsTable)
    .set({ status: "posting", updatedAt: new Date() })
    .where(and(eq(termOfDayPostsTable.id, id), eq(termOfDayPostsTable.status, "draft")))
    .returning();
  if (!claim) return { status: "skipped", reason: "not_a_draft" };
  return sendTermOfDayToZernio(claim);
}

/**
 * The Zernio send for a claimed ('posting') history row. Mirrors the meme/queue
 * posters: fixed per-row x-request-id idempotency key, bounded retries with
 * backoff on transient statuses, 409 treated as duplicate-success, provider
 * bodies never surfaced, and 'posted' only finalized with a confirmed post id
 * (or an idempotent 409).
 */
async function sendTermOfDayToZernio(row: TermOfDayPost): Promise<RunTermOfDayResult> {
  const mediaUrl = row.imageUrl ? absoluteUrl(row.imageUrl) : null;
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
    try {
      const resp = await fetch(`${ZERNIO_BASE}/posts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${zernioKey()}`,
          "Content-Type": "application/json",
          "x-request-id": row.zernioRequestId,
        },
        body: JSON.stringify({
          content: row.caption,
          ...(mediaUrl ? { mediaItems: [{ url: mediaUrl, type: "image" }] } : {}),
          // The glossary link rides in the FIRST COMMENT (group-shareable, no
          // link-penalty on the post itself). platformSpecificData MUST be
          // nested inside the per-platform entry — a top-level one is silently
          // dropped and the link vanishes.
          platforms: [
            {
              platform: "facebook",
              accountId: zernioAccountId(),
              ...(row.trackedUrl ? { platformSpecificData: { firstComment: row.trackedUrl } } : {}),
            },
          ],
          publishNow: true,
          metadata: { termOfDayPostId: row.id, conceptSlug: row.slug, source: "term_of_the_day" },
        }),
        signal: controller.signal,
      });

      // 409 = idempotency-key duplicate: the post IS live from a previous
      // attempt. Claim success; take the post id when the body has one.
      if (resp.status === 409) {
        const data = (await resp.json().catch(() => null)) as ZernioCreateResponse | null;
        const zernioPostId = data?.post?._id ?? row.zernioPostId ?? null;
        const fbUrl = zernioPostId ? await pollForFacebookUrl(zernioPostId) : null;
        await finalizePosted(row.id, zernioPostId, fbUrl);
        return {
          status: "posted",
          postId: row.id,
          slug: row.slug,
          ...(fbUrl ? { facebookPostUrl: fbUrl } : {}),
        };
      }

      if (!resp.ok) {
        // Never surface the raw provider body — it can echo the account id.
        await resp.body?.cancel().catch(() => {});
        lastError = `Zernio responded ${resp.status}`;
        if (isTransientStatus(resp.status) && attempt < MAX_ATTEMPTS) {
          await sleep(attempt * 1000 + Math.floor(Math.random() * 500));
          continue;
        }
        await markFailed(row.id, lastError);
        return { status: "failed", reason: lastError, postId: row.id, slug: row.slug };
      }

      const data = (await resp.json().catch(() => null)) as ZernioCreateResponse | null;
      const zernioPostId = data?.post?._id ?? null;
      // Refuse to declare success without a provider post ID.
      if (!zernioPostId) {
        const err = "Zernio accepted the post but returned no ID";
        await markFailed(row.id, err);
        return { status: "failed", reason: err, postId: row.id, slug: row.slug };
      }
      const fbUrl = await pollForFacebookUrl(zernioPostId);
      await finalizePosted(row.id, zernioPostId, fbUrl);
      logger.info({ slug: row.slug, zernioPostId }, "term of day: posted to Facebook");
      return {
        status: "posted",
        postId: row.id,
        slug: row.slug,
        ...(fbUrl ? { facebookPostUrl: fbUrl } : {}),
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(attempt * 1000 + Math.floor(Math.random() * 500));
        continue;
      }
      await markFailed(row.id, lastError);
      return { status: "failed", reason: lastError, postId: row.id, slug: row.slug };
    } finally {
      clearTimeout(timeout);
    }
  }
  await markFailed(row.id, lastError || "exhausted retries");
  return { status: "failed", reason: lastError, postId: row.id, slug: row.slug };
}

function absoluteUrl(p: string): string {
  if (/^https?:\/\//i.test(p)) return p;
  return siteUrl(p);
}

async function finalizePosted(
  id: string,
  zernioPostId: string | null,
  facebookPostUrl: string | null,
): Promise<void> {
  await db
    .update(termOfDayPostsTable)
    .set({
      status: "posted",
      zernioPostId,
      facebookPostUrl,
      postedAt: new Date(),
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(termOfDayPostsTable.id, id));
}

async function markFailed(id: string, reason: string): Promise<void> {
  await db
    .update(termOfDayPostsTable)
    .set({ status: "failed", failureReason: reason.slice(0, 500), updatedAt: new Date() })
    .where(eq(termOfDayPostsTable.id, id));
}

// ---------------------------------------------------------------------------
// History (admin)
// ---------------------------------------------------------------------------

export async function listTermOfDayHistory(limit = 30, offset = 0) {
  const rows = await db
    .select()
    .from(termOfDayPostsTable)
    .orderBy(desc(termOfDayPostsTable.postDate), desc(termOfDayPostsTable.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100))
    .offset(Math.max(offset, 0));
  const [{ count }] = (await db
    .select({ count: sql<number>`count(*)` })
    .from(termOfDayPostsTable)) as [{ count: number }];
  return { rows, total: Number(count) };
}
