import type { SourceAuthorityTier } from "@workspace/db";

// --- Deterministic story-cluster scoring (Task #199) --------------------
// A cluster's "heat" is scored WITHOUT any paid AI, from four observable,
// reproducible signals of its supporting vault sources:
//   • volume    — how many observations reference the story,
//   • diversity — how many INDEPENDENT sources (syndication-aware: distinct
//                 source families, so 10 wire reprints ≈ 1 voice),
//   • authority — the strongest source tier present (primary/firsthand > wire >
//                 commentary/social/aggregator),
//   • recency   — how fresh the newest source is vs the beat's freshness window.
// Kept pure + logger-free so it is trivially unit-testable and identical across
// instances (no clocks beyond the injected `now`, no I/O, no randomness).

export interface ClusterScoreInput {
  // Total member sources (raw observation volume).
  sourceCount: number;
  // Distinct source families — syndicated copies collapse to one (diversity).
  familyCount: number;
  // Distinct domains (a secondary diversity signal).
  domainCount: number;
  // Strongest authority tier present among members (null → treated as unknown).
  topAuthorityTier: SourceAuthorityTier | null;
  // Timestamp of the newest supporting source (null → no recency credit).
  newestSourceAt: Date | null;
  // Beat's freshness window in days (older-than = no recency credit).
  freshnessWindowDays: number;
  // Attached trend markers (weak social observations). These are NOT sources —
  // they contribute ONLY to the velocity component below (a public-interest
  // signal). They never touch volume/diversity/authority and can never satisfy
  // the trusted-source floor. Defaults to 0 (a cluster with no markers).
  markerCount?: number;
  now?: Date;
}

export interface ClusterScoreBreakdown {
  volume: number;
  diversity: number;
  authority: number;
  recency: number;
  // Public-interest / buzz signal derived purely from attached trend markers.
  velocity: number;
}

export interface ClusterScoreResult {
  // Blended 0-100 integer.
  score: number;
  // Each component already weighted (they sum to `score`), for transparency.
  breakdown: ClusterScoreBreakdown;
}

// Evidence-signal weights (volume+diversity+authority+recency sum to 100). These
// are the RELIABLE signals from real sources. Velocity is a SEPARATE additive
// public-interest bonus layered on top (see W_VELOCITY) and the final blend is
// clamped to 100 — markers can raise a cluster's heat but can never manufacture
// authority a real source would have to earn.
const W_VOLUME = 25;
const W_DIVERSITY = 30;
const W_AUTHORITY = 20;
const W_RECENCY = 25;

// Velocity bonus weight. Additive on top of the evidence signals (the four above
// still sum to 100 on their own); the total is clamped to 100. Deliberately
// modest so buzz nudges ranking without drowning out real evidence.
const W_VELOCITY = 15;

// Saturation points: this many hits/families = full credit for that component.
const VOLUME_FULL = 8;
const DIVERSITY_FULL = 5;
// Volume credit a single independent voice can contribute. A flood of
// observations from ONE publisher (e.g. dozens of GovInfo documents, all
// govinfo.gov) is not corroboration — without this cap a single-domain pile
// banked full volume + full diversity (each doc is its own "family") and gov
// RSS junk swamped the editor cockpit at score 90-100.
const VOLUME_PER_VOICE = 4;
// This many attached markers = full velocity credit.
const MARKER_FULL = 10;

// Score ceiling for a SINGLE-voice cluster (one independent publisher, however
// authoritative). Uncorroborated piles of official documents — e.g. dozens of
// GovInfo PDFs, all govinfo.gov, tier=primary — were banking full authority +
// recency and landing at 63-70, filling the editor cockpit's top-candidate list
// with administrative boilerplate no second outlet had picked up. A real story
// gets a second independent voice quickly; until it does, its heat is capped
// BELOW what any two-voice story with decent recency scores. The breakdown is
// scaled proportionally so components still sum to the (capped) score.
const SINGLE_VOICE_SCORE_CAP = 45;

// Authority tier → 0..1 credit. Ordered strongest → weakest.
const AUTHORITY_WEIGHT: Record<SourceAuthorityTier, number> = {
  primary: 1,
  firsthand: 0.85,
  wire: 0.6,
  reported: 0.5,
  commentary: 0.4,
  social: 0.25,
  aggregator: 0.1,
  reference: 0.15, // background-only; useful context, not citable evidence
  unknown: 0.2,
};

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Score a cluster deterministically from its member aggregates. Returns a 0-100
 * integer plus the (already-weighted) component breakdown for the admin surface.
 */
export function scoreCluster(input: ClusterScoreInput): ClusterScoreResult {
  const now = input.now ?? new Date();

  // Independent voices = distinct source families, CAPPED by distinct domains.
  // Families collapse syndicated reprints (10 wire copies ≈ 1 voice); the
  // domain cap collapses the inverse failure (58 distinct documents all from
  // one publisher ≈ 1 voice, not 58 "outlets"). domainCount can be 0 for
  // legacy rows with no recorded domain — fall back to familyCount alone.
  const families = Math.max(0, input.familyCount);
  const domains = Math.max(0, input.domainCount);
  const voices = domains > 0 ? Math.min(families, domains) : families;

  const effectiveVolume = Math.min(
    Math.max(0, input.sourceCount),
    Math.max(1, voices) * VOLUME_PER_VOICE,
  );
  const volume = clamp01(effectiveVolume / VOLUME_FULL);
  const diversity = clamp01(voices / DIVERSITY_FULL);
  const authority = AUTHORITY_WEIGHT[input.topAuthorityTier ?? "unknown"] ?? 0.2;

  let recency = 0;
  if (input.newestSourceAt) {
    const windowDays = input.freshnessWindowDays > 0 ? input.freshnessWindowDays : 7;
    const ageDays = (now.getTime() - input.newestSourceAt.getTime()) / (24 * 60 * 60 * 1000);
    recency = clamp01(1 - ageDays / windowDays);
  }

  const velocity = clamp01(Math.max(0, input.markerCount ?? 0) / MARKER_FULL);

  // Single-voice corroboration cap: with at most one independent voice, scale
  // every component down so the total cannot exceed SINGLE_VOICE_SCORE_CAP.
  // Applied to the raw (pre-rounding) components so the rounded breakdown
  // still sums to the returned score.
  let damp = 1;
  const rawTotal =
    volume * W_VOLUME +
    diversity * W_DIVERSITY +
    authority * W_AUTHORITY +
    recency * W_RECENCY +
    velocity * W_VELOCITY;
  if (voices <= 1 && rawTotal > SINGLE_VOICE_SCORE_CAP) {
    damp = SINGLE_VOICE_SCORE_CAP / rawTotal;
  }

  const breakdown: ClusterScoreBreakdown = {
    volume: Math.round(volume * W_VOLUME * damp),
    diversity: Math.round(diversity * W_DIVERSITY * damp),
    authority: Math.round(authority * W_AUTHORITY * damp),
    recency: Math.round(recency * W_RECENCY * damp),
    velocity: Math.round(velocity * W_VELOCITY * damp),
  };
  const score =
    breakdown.volume +
    breakdown.diversity +
    breakdown.authority +
    breakdown.recency +
    breakdown.velocity;
  return { score: Math.max(0, Math.min(100, score)), breakdown };
}

// Ordering used when picking the strongest tier present in a cluster
// (strongest first). Exported so callers can rank individual tiers consistently.
export const AUTHORITY_TIER_ORDER: SourceAuthorityTier[] = [
  "primary",
  "firsthand",
  "wire",
  "reported",
  "commentary",
  "social",
  "aggregator",
  "reference",
  "unknown",
];

// Tiers strong enough to corroborate a story on their own: original research /
// official record (primary — includes .gov/.edu/journals/court docs), company
// newsrooms and press releases (firsthand), syndicated wire copy (AP/Reuters/
// AFP), and established reported journalism (BBC/NPR/NYT/WaPo/etc — reported).
// Everything weaker — commentary, social, aggregator, and unknown — may still
// surface as a candidate LEAD, but cannot satisfy the "trusted source" bar by
// itself. A niche/local/trade (unknown) source needs at least one of these to
// back it before a packet is auto-approved for drafting; an editor can manually
// promote such a source into a trusted tier in Source Vault (setDocumentAuthority).
export const TRUSTED_AUTHORITY_TIERS: ReadonlySet<SourceAuthorityTier> = new Set([
  "primary",
  "firsthand",
  "wire",
  "reported",
]);

/** True when a tier is strong enough to corroborate a story on its own. */
export function isTrustedAuthorityTier(
  tier: SourceAuthorityTier | null | undefined,
): boolean {
  return !!tier && TRUSTED_AUTHORITY_TIERS.has(tier);
}

/** Return the strongest (highest-authority) tier among the given tiers. */
export function strongestAuthorityTier(
  tiers: Array<SourceAuthorityTier | null | undefined>,
): SourceAuthorityTier | null {
  let best: SourceAuthorityTier | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const t of tiers) {
    if (!t) continue;
    const rank = AUTHORITY_TIER_ORDER.indexOf(t);
    if (rank >= 0 && rank < bestRank) {
      bestRank = rank;
      best = t;
    }
  }
  return best;
}
