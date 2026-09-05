// --- Living Coverage Map — Pure Scoring (Task #345) -------------------------
//
// Deterministic, AI-free scoring functions for the Living Coverage Map.
// All functions here are pure (no DB, no logger, no AI) so they can be tested
// with per-file esbuild bundles.
//
// Evidence eligibility rules enforced by the JOB layer (before calling here):
//   1. Only source_documents rows with evidenceEligible = true count.
//   2. Only lifecycleStatus = 'active' docs count.
//   3. Source-family dedup: ten copies of one wire = 1 independent family.
//   4. Trend markers (articleSources.role = 'trend_marker') never reach here.
//   5. Glossary-memory docs (evidenceEligible = false) are already excluded.
//
// Reader interest may affect opportunityScore but NEVER evidence requirements.

import type {
  CoverageClassification,
  RecommendedAction,
  CoverageScoreBreakdown,
  EditorialState,
} from "@workspace/db";

// ---------------------------------------------------------------------------
// Thresholds — all configurable in one place
// ---------------------------------------------------------------------------

/** Min trusted docs for "strong" evidence (Section 1 threshold). */
export const EVIDENCE_STRONG_MIN_TRUSTED = 3;
/** Trusted docs for score = 1.0. */
export const EVIDENCE_SCORE_CEILING = 8;

/** Independent families for score = 1.0. */
export const DIVERSITY_SCORE_CEILING = 6;

/** Days until evidenceFreshness reaches 0 (linear interpolation). */
export const FRESHNESS_HALF_LIFE_DAYS = 180;

/** Central articles for coverageDepth = 1.0. */
export const COVERAGE_DEPTH_CEILING = 8;

/** Views in 30d for readerInterest = 1.0. */
export const READER_INTEREST_CEILING = 400;

/** Section 1: missing coverage threshold (low coverage depth). */
export const MISSING_COVERAGE_MAX_DEPTH = 0.25;

/** Section 2: heavy coverage floor. */
export const HEAVY_COVERAGE_MIN_DEPTH = 0.45;

/** Section 2: weak evidence ceiling. */
export const WEAK_EVIDENCE_MAX_STRENGTH = 0.4;

/** Section 3: new families in 90 days needed to signal "rising evidence". */
export const RISING_EVIDENCE_MIN_NEW_FAMILIES = 2;
/** Section 3: coverage must be at least this many days old. */
export const RISING_EVIDENCE_MIN_COVERAGE_AGE_DAYS = 180;

/** Section 4: central articles needed before saturation applies. */
export const SATURATED_MIN_CENTRAL_ARTICLES = 4;
/** Section 4: fraction of central articles that must be highly similar. */
export const SATURATED_SIMILAR_RATIO = 0.5;
/** Section 4: max new families in 120 days for saturation. */
export const SATURATED_MAX_NEW_FAMILIES = 0;

// ---------------------------------------------------------------------------
// Input struct (assembled by the job from multiple DB queries)
// ---------------------------------------------------------------------------

export interface ConceptCoverageInputs {
  conceptId: string;
  term: string;
  slug: string;
  // Beat affinities (highest-weight = primary)
  primaryBeatSlug: string | null;
  secondaryBeatSlugs: string[];
  // From concept_evidence_health (already computed by health pass)
  activeTrustedCount: number;
  independentFamilyCount: number;
  newestEvidenceAt: Date | null;
  retractedLinkedCount: number;
  articleMentionCount: number;
  demandViews30d: number;
  // Computed by coverage map job
  /** Articles where paragraphIndex <= 2 AND confidence >= 0.7. */
  centralArticleCount: number;
  mostRecentCentralArticleAt: Date | null;
  oldestCentralArticleAt: Date | null;
  /** New independent source families in the last 90 days. */
  newFamiliesLast90d: number;
  /** New independent source families in the last 120 days. */
  newFamiliesLast120d: number;
  /** Central articles that share a story cluster with another central article. */
  similarCentralArticleCount: number;
  // Provenance
  sourceDocumentIds: string[];
  sourceFamilyIds: string[];
  centralArticleIds: string[];
  radarSuggestionId: string | null;
  radarSuggestionStatus: string | null;
}

// ---------------------------------------------------------------------------
// Individual score functions (0–1 each)
// ---------------------------------------------------------------------------

/**
 * How strong is the external evidence base?
 * Glossary-memory and trend-marker docs are excluded before this is called.
 */
export function scoreEvidenceStrength(activeTrustedCount: number): number {
  return Math.min(1, activeTrustedCount / EVIDENCE_SCORE_CEILING);
}

/**
 * Are the sources independent? Penalises single-family dominance.
 * Ten copies of one wire story count as 1 family (enforced upstream).
 */
export function scoreSourceDiversity(independentFamilyCount: number): number {
  return Math.min(1, independentFamilyCount / DIVERSITY_SCORE_CEILING);
}

/**
 * How fresh is the evidence? Linear decay to 0 at FRESHNESS_HALF_LIFE_DAYS*2.
 * Returns 0 when newestEvidenceAt is null.
 */
export function scoreEvidenceFreshness(newestEvidenceAt: Date | null, now: Date = new Date()): number {
  if (!newestEvidenceAt) return 0;
  const ageDays = (now.getTime() - newestEvidenceAt.getTime()) / 86_400_000;
  if (ageDays <= 0) return 1;
  const score = 1 - ageDays / (FRESHNESS_HALF_LIFE_DAYS * 2);
  return Math.max(0, Math.min(1, score));
}

// Depth credit a near-duplicate central article earns relative to a distinct
// one. Spec rule: several similar articles count as LESS coverage than the
// same number of distinct articles. Without this discount, 8 copies of the
// same article scored depth 1.0 — double what 4 genuinely different articles
// scored — so a topic could be marked fully covered by redundant coverage.
export const SIMILAR_CENTRAL_DEPTH_CREDIT = 0.25;

/**
 * How deeply has BrainHook covered this concept?
 * Weighted: central articles count double, peripheral mentions count once.
 * Near-duplicate central articles are discounted to
 * SIMILAR_CENTRAL_DEPTH_CREDIT of a distinct article so redundant coverage
 * cannot inflate depth (articleUniqueness is displayed alongside, but depth
 * itself must already reflect it — classification gates on depth).
 */
export function scoreCoverageDepth(
  centralArticleCount: number,
  totalArticleCount: number,
  similarCentralArticleCount = 0,
): number {
  const central = Math.max(0, centralArticleCount);
  const similar = Math.min(central, Math.max(0, similarCentralArticleCount));
  const effectiveCentral = central - similar + similar * SIMILAR_CENTRAL_DEPTH_CREDIT;
  const weighted = effectiveCentral * 2 + Math.max(0, totalArticleCount - central);
  return Math.min(1, weighted / (COVERAGE_DEPTH_CEILING * 2));
}

/**
 * How unique are the central articles?
 * Highly similar articles reduce effective depth (spec rule: several similar
 * articles count as less than distinct articles).
 * Returns 1.0 when no similar pairs exist.
 */
export function scoreArticleUniqueness(
  centralArticleCount: number,
  similarCentralArticleCount: number,
): number {
  if (centralArticleCount === 0) return 1;
  const ratio = similarCentralArticleCount / centralArticleCount;
  return Math.max(0, 1 - ratio);
}

/**
 * How much reader interest exists for this concept?
 * Reader interest affects priority/opportunityScore but NEVER evidence requirements.
 */
export function scoreReaderInterest(demandViews30d: number): number {
  return Math.min(1, demandViews30d / READER_INTEREST_CEILING);
}

/**
 * How urgently does existing coverage need updating?
 * High when: new families arrived recently AND existing coverage is old.
 */
export function scoreUpdateUrgency(
  newFamiliesLast90d: number,
  mostRecentCentralArticleAt: Date | null,
  now: Date = new Date(),
): number {
  if (newFamiliesLast90d === 0) return 0;
  if (!mostRecentCentralArticleAt) {
    // No coverage at all — urgency of update is 0 (it's a gap, not an update need)
    return 0;
  }
  const coverageAgeDays =
    (now.getTime() - mostRecentCentralArticleAt.getTime()) / 86_400_000;
  const newEvidenceScore = Math.min(1, newFamiliesLast90d / 4);
  const coverageAgeScore = Math.min(1, Math.max(0, coverageAgeDays - 60) / 300);
  return newEvidenceScore * coverageAgeScore;
}

/**
 * How saturated is this topic?
 * High when: many central articles, mostly similar, no new evidence.
 */
export function scoreSaturation(
  centralArticleCount: number,
  similarCentralArticleCount: number,
  newFamiliesLast120d: number,
): number {
  if (centralArticleCount < SATURATED_MIN_CENTRAL_ARTICLES) return 0;
  const similarRatio =
    centralArticleCount > 0 ? similarCentralArticleCount / centralArticleCount : 0;
  const volumeScore = Math.min(1, (centralArticleCount - 3) / 6); // 4 = 0.17, 10 = 1.0
  const noveltyPenalty = newFamiliesLast120d === 0 ? 1 : Math.max(0, 1 - newFamiliesLast120d / 3);
  return Math.min(1, volumeScore * similarRatio * noveltyPenalty);
}

/**
 * Gap between evidence strength and coverage depth.
 * High when: strong evidence but little coverage.
 */
export function scoreCoverageGap(evidenceStrength: number, coverageDepth: number): number {
  return Math.max(0, evidenceStrength - coverageDepth);
}

/**
 * Penalty when very recent central articles exist (no point piling on).
 */
export function scoreRecentCoveragePenalty(
  mostRecentCentralArticleAt: Date | null,
  now: Date = new Date(),
): number {
  if (!mostRecentCentralArticleAt) return 0;
  const ageDays = (now.getTime() - mostRecentCentralArticleAt.getTime()) / 86_400_000;
  if (ageDays > 90) return 0;
  // Linear penalty: 0 days old = 0.4, 90 days old = 0
  return Math.max(0, 0.4 * (1 - ageDays / 90));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function classify(
  inputs: ConceptCoverageInputs,
  scores: {
    evidenceStrength: number;
    sourceDiversity: number;
    evidenceFreshness: number;
    coverageDepth: number;
    updateUrgency: number;
    saturation: number;
    articleUniqueness: number;
  },
  now: Date = new Date(),
): CoverageClassification {
  const {
    evidenceStrength,
    sourceDiversity,
    evidenceFreshness,
    coverageDepth,
    updateUrgency,
    saturation,
    articleUniqueness,
  } = scores;

  // Need at least some evidence data to classify meaningfully.
  if (inputs.activeTrustedCount === 0 && inputs.independentFamilyCount === 0) {
    return "insufficient_data";
  }

  // Section 1: Strong Evidence, Missing Coverage
  // Priority: highest — the most actionable opportunity
  if (
    evidenceStrength >= 0.375 && // >= 3 trusted docs (3/8 ceiling)
    sourceDiversity >= 0.333 && // >= 2 families (2/6 ceiling)
    evidenceFreshness >= 0.3 &&
    coverageDepth <= MISSING_COVERAGE_MAX_DEPTH
  ) {
    return "strong_evidence_missing_coverage";
  }

  // Section 3: Rising Evidence, Stale Coverage
  // Check before Section 2 — an update recommendation is more valuable than
  // a "strengthen evidence" recommendation when new sources just arrived.
  if (
    inputs.newFamiliesLast90d >= RISING_EVIDENCE_MIN_NEW_FAMILIES &&
    inputs.mostRecentCentralArticleAt !== null
  ) {
    const coverageAgeDays =
      (now.getTime() - inputs.mostRecentCentralArticleAt.getTime()) / 86_400_000;
    if (
      coverageAgeDays >= RISING_EVIDENCE_MIN_COVERAGE_AGE_DAYS &&
      updateUrgency >= 0.35
    ) {
      return "rising_evidence_stale_coverage";
    }
  }

  // Section 4: Saturated Territory
  // Checked before Section 2 — when the coverage itself is highly redundant
  // (many near-duplicate articles), "stop writing about this" is the more
  // accurate diagnosis than "strengthen the evidence".
  if (
    saturation >= 0.4 &&
    inputs.centralArticleCount >= SATURATED_MIN_CENTRAL_ARTICLES &&
    articleUniqueness <= 0.5
  ) {
    return "saturated_territory";
  }

  // Section 2: Heavy Coverage, Weak Evidence
  if (
    coverageDepth >= HEAVY_COVERAGE_MIN_DEPTH &&
    (evidenceStrength <= WEAK_EVIDENCE_MAX_STRENGTH || sourceDiversity <= 0.333)
  ) {
    return "heavy_coverage_weak_evidence";
  }

  return "insufficient_data";
}

// ---------------------------------------------------------------------------
// Recommended action
// ---------------------------------------------------------------------------

export function recommendAction(
  classification: CoverageClassification,
  scores: {
    evidenceStrength: number;
    sourceDiversity: number;
    updateUrgency: number;
    saturation: number;
  },
  inputs: Pick<
    ConceptCoverageInputs,
    "retractedLinkedCount" | "primaryBeatSlug" | "secondaryBeatSlugs" | "centralArticleCount"
  >,
  editorialState: EditorialState,
): RecommendedAction {
  // Editorial states that stop the recommendation engine.
  if (editorialState === "intentionally_complete") return "mark_intentionally_complete";
  if (editorialState === "waiting_for_evidence") return "find_more_sources";

  // Retraction always surfaces first.
  if (inputs.retractedLinkedCount > 0) return "review_source_health";

  switch (classification) {
    case "strong_evidence_missing_coverage":
      // Cross-beat when multiple secondary beats exist.
      if ((inputs.secondaryBeatSlugs?.length ?? 0) >= 1 && inputs.primaryBeatSlug) {
        return "create_cross_beat_synthesis";
      }
      return "create_foundational_article";

    case "heavy_coverage_weak_evidence":
      if (scores.sourceDiversity < 0.333) return "find_more_sources";
      if (scores.evidenceStrength < 0.25) return "build_evidence_packet";
      return "strengthen_glossary_evidence";

    case "rising_evidence_stale_coverage":
      return "update_existing_article";

    case "saturated_territory":
      return "avoid_additional_general_coverage";

    case "insufficient_data":
      if (scores.evidenceStrength < 0.25) return "find_more_sources";
      return "monitor_only";
  }
}

// ---------------------------------------------------------------------------
// Top-level scorer
// ---------------------------------------------------------------------------

export interface CoverageScoreResult {
  scores: Omit<CoverageScoreBreakdown, "inputs">;
  breakdown: CoverageScoreBreakdown;
  classification: CoverageClassification;
  recommendedAction: RecommendedAction;
}

export function scoreConcept(
  inputs: ConceptCoverageInputs,
  editorialState: EditorialState = "none",
  now: Date = new Date(),
): CoverageScoreResult {
  const evidenceStrength = scoreEvidenceStrength(inputs.activeTrustedCount);
  const sourceDiversity = scoreSourceDiversity(inputs.independentFamilyCount);
  const evidenceFreshness = scoreEvidenceFreshness(inputs.newestEvidenceAt, now);
  const coverageDepth = scoreCoverageDepth(
    inputs.centralArticleCount,
    inputs.articleMentionCount,
    inputs.similarCentralArticleCount,
  );
  const articleUniqueness = scoreArticleUniqueness(
    inputs.centralArticleCount,
    inputs.similarCentralArticleCount,
  );
  const readerInterest = scoreReaderInterest(inputs.demandViews30d);
  const updateUrgency = scoreUpdateUrgency(
    inputs.newFamiliesLast90d,
    inputs.mostRecentCentralArticleAt,
    now,
  );
  const saturation = scoreSaturation(
    inputs.centralArticleCount,
    inputs.similarCentralArticleCount,
    inputs.newFamiliesLast120d,
  );
  const coverageGap = scoreCoverageGap(evidenceStrength, coverageDepth);
  const recentCoveragePenalty = scoreRecentCoveragePenalty(inputs.mostRecentCentralArticleAt, now);

  const opportunityScore = Math.max(
    0,
    Math.min(
      1,
      (evidenceStrength +
        sourceDiversity +
        evidenceFreshness +
        readerInterest +
        coverageGap -
        saturation -
        recentCoveragePenalty) /
        4, // normalise to 0–1 range
    ),
  );

  const classification = classify(inputs, {
    evidenceStrength,
    sourceDiversity,
    evidenceFreshness,
    coverageDepth,
    updateUrgency,
    saturation,
    articleUniqueness,
  }, now);

  const recommendedAction = recommendAction(
    classification,
    { evidenceStrength, sourceDiversity, updateUrgency, saturation },
    inputs,
    editorialState,
  );

  const breakdown: CoverageScoreBreakdown = {
    evidenceStrength,
    sourceDiversity,
    evidenceFreshness,
    coverageDepth,
    articleUniqueness,
    readerInterest,
    updateUrgency,
    saturation,
    coverageGap,
    recentCoveragePenalty,
    opportunityScore,
    inputs: {
      activeTrustedCount: inputs.activeTrustedCount,
      independentFamilyCount: inputs.independentFamilyCount,
      newestEvidenceAtIso: inputs.newestEvidenceAt?.toISOString() ?? null,
      retractedLinkedCount: inputs.retractedLinkedCount,
      centralArticleCount: inputs.centralArticleCount,
      totalArticleCount: inputs.articleMentionCount,
      mostRecentCentralArticleAtIso: inputs.mostRecentCentralArticleAt?.toISOString() ?? null,
      newFamiliesLast90d: inputs.newFamiliesLast90d,
      newFamiliesLast120d: inputs.newFamiliesLast120d,
      similarCentralArticleCount: inputs.similarCentralArticleCount,
      demandViews30d: inputs.demandViews30d,
    },
  };

  return {
    scores: {
      evidenceStrength,
      sourceDiversity,
      evidenceFreshness,
      coverageDepth,
      articleUniqueness,
      readerInterest,
      updateUrgency,
      saturation,
      coverageGap,
      recentCoveragePenalty,
      opportunityScore,
    },
    breakdown,
    classification,
    recommendedAction,
  };
}

// ---------------------------------------------------------------------------
// Input fingerprint — cheap change detection
// ---------------------------------------------------------------------------

/**
 * Returns a short fingerprint of the raw scoring inputs.
 * If the fingerprint matches the stored value, the job skips recalculation.
 * Uses a simple delimited string rather than a crypto hash for zero-dependency
 * use in the pure module (the job layer can hash it if desired).
 */
export function inputFingerprint(
  inputs: ConceptCoverageInputs,
  editorialState: EditorialState = "none",
): string {
  return [
    // Editorial state is a scoring determinant (recommendAction branches on
    // it), so a state change must invalidate the fingerprint or a skipped row
    // keeps a stale recommendation (e.g. "intentionally complete" rows still
    // told to create a foundational article) indefinitely.
    editorialState,
    inputs.activeTrustedCount,
    inputs.independentFamilyCount,
    inputs.newestEvidenceAt?.toISOString() ?? "null",
    inputs.retractedLinkedCount,
    inputs.centralArticleCount,
    inputs.articleMentionCount,
    inputs.newFamiliesLast90d,
    inputs.newFamiliesLast120d,
    inputs.similarCentralArticleCount,
    inputs.demandViews30d,
    inputs.mostRecentCentralArticleAt?.toISOString() ?? "null",
    // Provenance / routing determinants — included so a skipped row can never
    // retain stale beat, radar, or source metadata (promote-to-idea reads these).
    inputs.primaryBeatSlug ?? "null",
    [...inputs.secondaryBeatSlugs].sort().join(","),
    inputs.radarSuggestionId ?? "null",
    inputs.radarSuggestionStatus ?? "null",
    [...inputs.sourceDocumentIds].sort().join(","),
    [...inputs.sourceFamilyIds].sort().join(","),
    [...inputs.centralArticleIds].sort().join(","),
  ].join("|");
}
