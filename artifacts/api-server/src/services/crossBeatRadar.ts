// --- Cross-Beat Radar — PURE gate pipeline (Task #340) -----------------------
// Deterministic candidate evaluation for cross-beat story suggestions. A
// candidate is a bridge concept (meaningful beat-affinity weight in >= 2
// beats, per conceptBeatAffinity.ts) plus its linked ACTIVE trusted-tier
// Source Vault evidence. Four gates run in order; each failure names the gate
// so the job can report why a candidate was dropped:
//   1. affinity  — bridge profile (>= RADAR_MIN_BEATS beats at/above the
//                  bridge weight threshold)
//   2. evidence  — >= RADAR_MIN_TRUSTED_DOCS active trusted docs spanning
//                  >= RADAR_MIN_INDEPENDENT_FAMILIES independent families
//   3. freshness — newest trusted doc within the freshness window
//   4. overlap   — no overlapping existing coverage (the DB overlap check runs
//                  in the job; this module only encodes the pass/fail rule)
// All functions here are pure and logger-free so they can be tested with
// per-file esbuild bundles; DB/LLM glue lives in crossBeatRadarJob.ts.

import { BRIDGE_WEIGHT_THRESHOLD, BRIDGE_MIN_BEATS } from "./conceptBeatAffinity";

/** Beats needed at/above the bridge threshold (reuses the bridge rule). */
export const RADAR_MIN_BEATS = BRIDGE_MIN_BEATS;
export const RADAR_WEIGHT_THRESHOLD = BRIDGE_WEIGHT_THRESHOLD;

/** Authority tiers that count as supporting evidence for a radar pitch. */
export const RADAR_TRUSTED_TIERS = ["primary", "firsthand", "wire", "reported"] as const;
export type RadarTrustedTier = (typeof RADAR_TRUSTED_TIERS)[number];

/** Minimum active trusted docs and independent source families. */
export const RADAR_MIN_TRUSTED_DOCS = 2;
export const RADAR_MIN_INDEPENDENT_FAMILIES = 2;

/** Only edges at/above this confidence count as concept-linked evidence. */
export const RADAR_MIN_EDGE_CONFIDENCE = 0.3;

/**
 * Freshness window: the newest trusted doc must be at most this old. Beats
 * without an override use the default. Slow-moving reference beats can be
 * given longer windows here without touching the gate logic.
 */
export const RADAR_DEFAULT_FRESHNESS_DAYS = 120;
export const RADAR_BEAT_FRESHNESS_DAYS: Readonly<Record<string, number>> = {};

/** Max suggestions generated (LLM-phrased) per radar run — cost bound. */
export const RADAR_MAX_SUGGESTIONS_PER_RUN = 3;

/** Overlap threshold — same default the idea dedupe pipeline uses. */
export const RADAR_OVERLAP_THRESHOLD = 0.35;

export interface RadarEvidenceDoc {
  docId: string;
  url: string;
  /** Authority tier ("primary" | ... | "unknown"). */
  tier: string;
  /** Source family id (null = the doc is its own family representative). */
  familyId: string | null;
  /** Best available doc timestamp (publishedAt ?? fetchedAt ?? createdAt). */
  newestAt: Date | null;
}

export interface RadarCandidateInput {
  conceptId: string;
  term: string;
  slug: string;
  /** Beat-affinity rows at/above the bridge threshold, strongest first. */
  beats: ReadonlyArray<{ beatSlug: string; weight: number }>;
  /** Concept-linked ACTIVE vault docs (edge confidence already filtered). */
  evidence: ReadonlyArray<RadarEvidenceDoc>;
}

export type RadarGate = "affinity" | "evidence" | "freshness" | "overlap";

export interface RadarGateResult {
  passed: boolean;
  failedGate: RadarGate | null;
  /** Trusted docs that back the pitch (empty when the evidence gate fails). */
  trustedDocs: RadarEvidenceDoc[];
  independentFamilies: number;
  /** Deterministic ranking score (0 when failed). */
  score: number;
}

const TRUSTED_SET: ReadonlySet<string> = new Set(RADAR_TRUSTED_TIERS);

/** Family key: familyId when set, else the doc's own id (its own family). */
export function familyKey(doc: RadarEvidenceDoc): string {
  return doc.familyId ?? doc.docId;
}

export function trustedEvidenceDocs(
  evidence: ReadonlyArray<RadarEvidenceDoc>,
): RadarEvidenceDoc[] {
  return evidence.filter((d) => TRUSTED_SET.has(d.tier));
}

export function countIndependentFamilies(docs: ReadonlyArray<RadarEvidenceDoc>): number {
  return new Set(docs.map(familyKey)).size;
}

/** Freshness window (days) for a beat pair: the LOOSEST of the two beats. */
export function freshnessWindowDays(beatSlugs: ReadonlyArray<string>): number {
  let max = 0;
  for (const slug of beatSlugs) {
    const v = RADAR_BEAT_FRESHNESS_DAYS[slug] ?? RADAR_DEFAULT_FRESHNESS_DAYS;
    if (v > max) max = v;
  }
  return max || RADAR_DEFAULT_FRESHNESS_DAYS;
}

/**
 * Deterministic candidate score for ranking: second-strongest qualifying beat
 * weight (how genuinely "bridge" the concept is) blended with evidence depth
 * (log-damped trusted-doc count). Higher is better; purely for ordering.
 */
export function scoreCandidate(
  beats: ReadonlyArray<{ beatSlug: string; weight: number }>,
  trustedDocCount: number,
  independentFamilies: number,
): number {
  const sorted = [...beats].sort((a, b) => b.weight - a.weight);
  const bridgeStrength = sorted[1]?.weight ?? 0;
  const evidenceDepth = Math.log1p(trustedDocCount) / Math.log(10);
  const familyBonus = independentFamilies >= 3 ? 0.1 : 0;
  return Number((bridgeStrength + 0.3 * evidenceDepth + familyBonus).toFixed(4));
}

/**
 * Run gates 1–3 (affinity, evidence, freshness). Gate 4 (overlap) needs the
 * DB — the job runs it and combines via `applyOverlapGate`.
 */
export function evaluateRadarCandidate(
  input: RadarCandidateInput,
  now: Date = new Date(),
): RadarGateResult {
  const failed = (gate: RadarGate): RadarGateResult => ({
    passed: false,
    failedGate: gate,
    trustedDocs: [],
    independentFamilies: 0,
    score: 0,
  });

  // Gate 1 — affinity: bridge profile.
  const qualifying = input.beats.filter((b) => b.weight >= RADAR_WEIGHT_THRESHOLD);
  if (qualifying.length < RADAR_MIN_BEATS) return failed("affinity");

  // Gate 2 — trusted evidence across independent families.
  const trusted = trustedEvidenceDocs(input.evidence);
  const families = countIndependentFamilies(trusted);
  if (trusted.length < RADAR_MIN_TRUSTED_DOCS || families < RADAR_MIN_INDEPENDENT_FAMILIES) {
    return failed("evidence");
  }

  // Gate 3 — freshness: newest trusted doc within the window for these beats.
  const windowDays = freshnessWindowDays(qualifying.map((b) => b.beatSlug));
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const newest = trusted.reduce<number>(
    (acc, d) => (d.newestAt ? Math.max(acc, d.newestAt.getTime()) : acc),
    0,
  );
  if (newest < cutoff) return failed("freshness");

  return {
    passed: true,
    failedGate: null,
    trustedDocs: trusted,
    independentFamilies: families,
    score: scoreCandidate(qualifying, trusted.length, families),
  };
}

/** Gate 4 — overlap. `overlapHits` = existing articles+ideas above threshold. */
export function applyOverlapGate(result: RadarGateResult, overlapHits: number): RadarGateResult {
  if (!result.passed) return result;
  if (overlapHits > 0) {
    return { ...result, passed: false, failedGate: "overlap", score: 0 };
  }
  return result;
}

/**
 * Idempotency / dismissal-memory key: concept + the sorted top beat pair. A
 * dismissed suggestion's key stays in the table, so later runs never re-pitch
 * the same concept/beat-pair (a NEW beat pairing for the concept is allowed).
 */
export function radarDedupeKey(conceptId: string, beatSlugs: ReadonlyArray<string>): string {
  const pair = [...beatSlugs].sort().slice(0, 2).join("+");
  return `${conceptId}:${pair}`;
}
