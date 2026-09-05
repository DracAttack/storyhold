// --- Concept-to-beat affinity weights — PURE computation ---------------------
// Deterministic (no LLM) weighted beat profile for a glossary concept, derived
// from three separately-normalized signals:
//   articleSignal      — primary beats (weight 1.0) + secondary beats (0.5) of
//                        published articles mentioning the concept
//   sourceSignal       — beats of vault documents linked through source-concept
//                        edges, weighted by edge confidence
//   relationshipSignal — mean of one-hop relationship neighbors' BASE profiles
//                        (article+source only — no recursion), damped via the
//                        blend weight below
// The blended weight is normalized per concept (rows sum to ~1) with tiny
// residual beats floored away. All functions here are pure and logger-free so
// they can be tested with per-file esbuild bundles; DB glue lives in
// conceptBeatAffinityJob.ts.

/** Blend weights. Renormalized over the signals that actually have data. */
export const ARTICLE_SIGNAL_WEIGHT = 0.5;
export const SOURCE_SIGNAL_WEIGHT = 0.3;
/**
 * Relationship blend weight — this IS the one-hop damping: neighbor profiles
 * can shift a concept's blend by at most this share when usage signals exist.
 * (A concept with NO usage data still inherits its neighbors' profile in full —
 * that is the only information available.)
 */
export const RELATIONSHIP_SIGNAL_WEIGHT = 0.2;

/** A secondary subject beat counts this much of a primary-beat mention. */
export const SECONDARY_BEAT_WEIGHT = 0.5;

/** Edge confidence is clamped to at least this before weighting a source doc. */
export const MIN_EDGE_DOC_WEIGHT = 0.1;

/** Blended weights below this are dropped (then the rest renormalizes). */
export const MIN_PROFILE_WEIGHT = 0.02;

/**
 * Bridge concept rule: meaningful weight in >= 2 beats. Named constant so the
 * cross-beat radar task can tune it in one place.
 */
export const BRIDGE_WEIGHT_THRESHOLD = 0.25;
export const BRIDGE_MIN_BEATS = 2;

/**
 * Relationship types that never contribute to the relationship signal:
 * distinct_from is "explicitly not the same concept" and antonym is a direct
 * opposite — both are adjacency in the graph but NOT topical affinity carriers
 * strong enough to transfer beat weight. (Antonyms usually share a beat anyway;
 * excluding them keeps the rule conservative.)
 */
export const AFFINITY_EXCLUDED_RELATION_TYPES = ["distinct_from", "antonym"] as const;

/** beat slug -> non-negative mass. Not necessarily normalized. */
export type BeatDistribution = Record<string, number>;

export interface ArticleMentionInput {
  /** Primary beat slug of a published article mentioning the concept. */
  primaryBeat: string | null;
  /** Secondary subject beat slugs of that article (may be empty/null). */
  secondaryBeats: readonly string[] | null;
}

export interface EdgeDocInput {
  /** Beat the vault document was discovered for (null = no beat context). */
  beatSlug: string | null;
  /** Deterministic edge confidence (0–1). */
  confidence: number;
}

export interface ConceptBeatAffinityRow {
  beatSlug: string;
  weight: number;
  articleSignal: number;
  sourceSignal: number;
  relationshipSignal: number;
}

/** Sum of all mass in a distribution (ignores non-finite/negative entries). */
function totalMass(dist: BeatDistribution): number {
  let sum = 0;
  for (const v of Object.values(dist)) {
    if (Number.isFinite(v) && v > 0) sum += v;
  }
  return sum;
}

/**
 * Normalize a distribution so positive entries sum to 1. Non-positive or
 * non-finite entries are dropped. Empty input (or no positive mass) -> {}.
 */
export function normalizeDistribution(dist: BeatDistribution): BeatDistribution {
  const sum = totalMass(dist);
  if (sum <= 0) return {};
  const out: BeatDistribution = {};
  for (const [k, v] of Object.entries(dist)) {
    if (Number.isFinite(v) && v > 0) out[k] = v / sum;
  }
  return out;
}

/**
 * Article signal: each mention contributes 1.0 to the article's primary beat
 * and SECONDARY_BEAT_WEIGHT to each secondary beat. Beats outside validBeats
 * (renamed/deleted) are ignored. Returns a normalized distribution.
 */
export function buildArticleSignal(
  mentions: readonly ArticleMentionInput[],
  validBeats: ReadonlySet<string>,
): BeatDistribution {
  const counts: BeatDistribution = {};
  for (const m of mentions) {
    if (m.primaryBeat && validBeats.has(m.primaryBeat)) {
      counts[m.primaryBeat] = (counts[m.primaryBeat] ?? 0) + 1;
    }
    for (const sb of m.secondaryBeats ?? []) {
      if (!sb || !validBeats.has(sb)) continue;
      // An article listing its own primary beat as secondary must not double-count.
      if (sb === m.primaryBeat) continue;
      counts[sb] = (counts[sb] ?? 0) + SECONDARY_BEAT_WEIGHT;
    }
  }
  return normalizeDistribution(counts);
}

/**
 * Source signal: each edge-linked vault document contributes its clamped edge
 * confidence to the beat it was discovered for. Docs with no beat context are
 * skipped. Returns a normalized distribution.
 */
export function buildSourceSignal(
  edgeDocs: readonly EdgeDocInput[],
  validBeats: ReadonlySet<string>,
): BeatDistribution {
  const counts: BeatDistribution = {};
  for (const d of edgeDocs) {
    if (!d.beatSlug || !validBeats.has(d.beatSlug)) continue;
    const w = Math.min(1, Math.max(MIN_EDGE_DOC_WEIGHT, d.confidence));
    counts[d.beatSlug] = (counts[d.beatSlug] ?? 0) + w;
  }
  return normalizeDistribution(counts);
}

/**
 * The BASE profile of a concept — article + source signals blended WITHOUT the
 * relationship signal. Used as the neighbor input to the relationship signal
 * so the computation stays one-hop (no recursion / fixpoint).
 */
export function buildBaseProfile(
  articleSignal: BeatDistribution,
  sourceSignal: BeatDistribution,
): BeatDistribution {
  return blendDistributions([
    { dist: articleSignal, weight: ARTICLE_SIGNAL_WEIGHT },
    { dist: sourceSignal, weight: SOURCE_SIGNAL_WEIGHT },
  ]);
}

/**
 * Relationship signal: the normalized mean of the neighbors' base profiles.
 * Neighbors with an empty base profile contribute nothing. One hop only —
 * inputs must be BASE profiles (article+source), never full blended profiles.
 */
export function buildRelationshipSignal(
  neighborBaseProfiles: readonly BeatDistribution[],
): BeatDistribution {
  const sum: BeatDistribution = {};
  for (const profile of neighborBaseProfiles) {
    for (const [beat, w] of Object.entries(profile)) {
      if (Number.isFinite(w) && w > 0) sum[beat] = (sum[beat] ?? 0) + w;
    }
  }
  return normalizeDistribution(sum);
}

/**
 * Weighted blend of distributions, renormalizing blend weights over the
 * distributions that actually carry mass (an absent signal never dilutes the
 * others — a mentions-only concept still gets a full-strength profile).
 */
function blendDistributions(
  parts: Array<{ dist: BeatDistribution; weight: number }>,
): BeatDistribution {
  const present = parts.filter((p) => p.weight > 0 && totalMass(p.dist) > 0);
  const totalWeight = present.reduce((s, p) => s + p.weight, 0);
  if (totalWeight <= 0) return {};
  const out: BeatDistribution = {};
  for (const p of present) {
    const norm = normalizeDistribution(p.dist);
    const share = p.weight / totalWeight;
    for (const [beat, w] of Object.entries(norm)) {
      out[beat] = (out[beat] ?? 0) + w * share;
    }
  }
  return out;
}

/**
 * Final per-concept affinity rows: blend the three signals, floor away tiny
 * residual weights, renormalize, and attach each signal's per-beat normalized
 * value for retuning. Sorted by weight desc, then beatSlug asc (stable reads).
 */
export function computeAffinityRows(
  articleSignal: BeatDistribution,
  sourceSignal: BeatDistribution,
  relationshipSignal: BeatDistribution,
): ConceptBeatAffinityRow[] {
  const blended = blendDistributions([
    { dist: articleSignal, weight: ARTICLE_SIGNAL_WEIGHT },
    { dist: sourceSignal, weight: SOURCE_SIGNAL_WEIGHT },
    { dist: relationshipSignal, weight: RELATIONSHIP_SIGNAL_WEIGHT },
  ]);

  // Floor + renormalize so surviving rows still sum to ~1.
  const floored: BeatDistribution = {};
  for (const [beat, w] of Object.entries(blended)) {
    if (w >= MIN_PROFILE_WEIGHT) floored[beat] = w;
  }
  const final = normalizeDistribution(floored);

  const a = normalizeDistribution(articleSignal);
  const s = normalizeDistribution(sourceSignal);
  const r = normalizeDistribution(relationshipSignal);

  return Object.entries(final)
    .map(([beatSlug, weight]) => ({
      beatSlug,
      weight,
      articleSignal: a[beatSlug] ?? 0,
      sourceSignal: s[beatSlug] ?? 0,
      relationshipSignal: r[beatSlug] ?? 0,
    }))
    .sort((x, y) => y.weight - x.weight || x.beatSlug.localeCompare(y.beatSlug));
}

/** Bridge concept: meaningful weight in BRIDGE_MIN_BEATS or more beats. */
export function isBridgeProfile(rows: readonly ConceptBeatAffinityRow[]): boolean {
  let qualifying = 0;
  for (const row of rows) {
    if (row.weight >= BRIDGE_WEIGHT_THRESHOLD) qualifying += 1;
  }
  return qualifying >= BRIDGE_MIN_BEATS;
}
