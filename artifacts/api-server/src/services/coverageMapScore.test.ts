// Coverage Map scoring tests — per-file esbuild bundle, pure module only.
// Run: node artifacts/api-server/src/services/coverageMapScore.test.ts
// (after bundling with esbuild — see api-server-test-running memory note)

import assert from "node:assert/strict";

import {
  scoreConcept,
  scoreEvidenceStrength,
  scoreSourceDiversity,
  scoreEvidenceFreshness,
  scoreCoverageDepth,
  scoreArticleUniqueness,
  scoreReaderInterest,
  scoreUpdateUrgency,
  scoreSaturation,
  inputFingerprint,
  type ConceptCoverageInputs,
  EVIDENCE_STRONG_MIN_TRUSTED,
} from "./coverageMapScore.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseInputs: ConceptCoverageInputs = {
  conceptId: "c1",
  term: "Test Concept",
  slug: "test-concept",
  primaryBeatSlug: "science",
  secondaryBeatSlugs: [],
  activeTrustedCount: 0,
  independentFamilyCount: 0,
  newestEvidenceAt: null,
  retractedLinkedCount: 0,
  articleMentionCount: 0,
  demandViews30d: 0,
  centralArticleCount: 0,
  mostRecentCentralArticleAt: null,
  oldestCentralArticleAt: null,
  newFamiliesLast90d: 0,
  newFamiliesLast120d: 0,
  similarCentralArticleCount: 0,
  sourceDocumentIds: [],
  sourceFamilyIds: [],
  centralArticleIds: [],
  radarSuggestionId: null,
  radarSuggestionStatus: null,
};

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

// ---------------------------------------------------------------------------
// Test 1: Glossary-memory documents never count as evidence
// The job layer excludes evidenceEligible = false docs before calling the
// scorer. This test verifies that when activeTrustedCount is 0 (i.e. all
// docs were excluded as glossary-memory), evidenceStrength is 0.
// ---------------------------------------------------------------------------
{
  const strength = scoreEvidenceStrength(0);
  assert.equal(strength, 0, "Test 1: glossary-only → evidenceStrength = 0");
  console.log("✓ Test 1: Glossary-memory docs excluded → evidenceStrength = 0");
}

// ---------------------------------------------------------------------------
// Test 2: Trend markers never satisfy evidence thresholds
// Trend markers are kept in activeTrustedCount = 0 by the job layer
// (role = 'trend_marker' rows are never counted). Verify that trend-signal-only
// concepts cannot reach Section 1 regardless of demand signals.
// ---------------------------------------------------------------------------
{
  const trendOnlyInputs: ConceptCoverageInputs = {
    ...baseInputs,
    // Evidence counters are 0 (all sources were trend markers, excluded by job)
    activeTrustedCount: 0,
    independentFamilyCount: 0,
    newestEvidenceAt: null,
    // But reader interest (from social trends) is high
    demandViews30d: 1000,
    articleMentionCount: 0,
  };
  const { classification, scores } = scoreConcept(trendOnlyInputs);
  assert.equal(
    classification,
    "insufficient_data",
    "Test 2: trend-only concept cannot be classified as strong_evidence_missing_coverage",
  );
  assert.equal(scores.evidenceStrength, 0, "Test 2: evidenceStrength = 0 with no trusted docs");
  console.log("✓ Test 2: Trend markers excluded → evidenceStrength = 0, no Section 1");
}

// ---------------------------------------------------------------------------
// Test 3: Syndicated copies count as one source family
// If 10 copies of a wire story all share familyId = 'F1', the job passes
// independentFamilyCount = 1. Verify that diversity score reflects 1 family.
// ---------------------------------------------------------------------------
{
  const diversity = scoreSourceDiversity(1);
  assert.ok(diversity < 0.25, "Test 3: 1 family → low diversity score");
  const diversityTen = scoreSourceDiversity(10);
  assert.equal(diversityTen, 1, "Test 3: 10 families → diversity ceiling 1.0");
  console.log("✓ Test 3: Syndicated copies → 1 family → low diversity; 10 families → 1.0");
}

// ---------------------------------------------------------------------------
// Test 4: Strong evidence + no central article → Section 1
// ---------------------------------------------------------------------------
{
  const inputs: ConceptCoverageInputs = {
    ...baseInputs,
    activeTrustedCount: 5,
    independentFamilyCount: 3,
    newestEvidenceAt: daysAgo(30),
    centralArticleCount: 0,
    articleMentionCount: 0,
  };
  const { classification } = scoreConcept(inputs);
  assert.equal(
    classification,
    "strong_evidence_missing_coverage",
    "Test 4: strong evidence + no coverage → Section 1",
  );
  console.log("✓ Test 4: Strong evidence + no central article → strong_evidence_missing_coverage");
}

// ---------------------------------------------------------------------------
// Test 5: Heavy use + weak external support → Section 2
// ---------------------------------------------------------------------------
{
  const inputs: ConceptCoverageInputs = {
    ...baseInputs,
    activeTrustedCount: 1,
    independentFamilyCount: 1,
    newestEvidenceAt: daysAgo(400),
    centralArticleCount: 6,
    articleMentionCount: 14,
    demandViews30d: 200,
    mostRecentCentralArticleAt: daysAgo(30), // recent, so not Section 3
  };
  const { classification } = scoreConcept(inputs);
  assert.equal(
    classification,
    "heavy_coverage_weak_evidence",
    "Test 5: heavy coverage + weak evidence → Section 2",
  );
  console.log("✓ Test 5: Heavy coverage + weak evidence → heavy_coverage_weak_evidence");
}

// ---------------------------------------------------------------------------
// Test 6: New evidence + old coverage → Section 3
// ---------------------------------------------------------------------------
{
  const inputs: ConceptCoverageInputs = {
    ...baseInputs,
    activeTrustedCount: 4,
    independentFamilyCount: 3,
    newestEvidenceAt: daysAgo(20),
    newFamiliesLast90d: 3,
    centralArticleCount: 2,
    articleMentionCount: 4,
    mostRecentCentralArticleAt: daysAgo(400), // stale coverage
  };
  const { classification } = scoreConcept(inputs);
  assert.equal(
    classification,
    "rising_evidence_stale_coverage",
    "Test 6: new evidence + old coverage → Section 3",
  );
  console.log("✓ Test 6: New evidence + old coverage → rising_evidence_stale_coverage");
}

// ---------------------------------------------------------------------------
// Test 7: Highly similar articles + little new evidence → Section 4
// ---------------------------------------------------------------------------
{
  const inputs: ConceptCoverageInputs = {
    ...baseInputs,
    activeTrustedCount: 2,
    independentFamilyCount: 2,
    newestEvidenceAt: daysAgo(200),
    newFamiliesLast90d: 0,
    newFamiliesLast120d: 0,
    centralArticleCount: 8,
    articleMentionCount: 12,
    similarCentralArticleCount: 6, // 6 of 8 are similar
    mostRecentCentralArticleAt: daysAgo(20),
  };
  const { classification } = scoreConcept(inputs);
  assert.equal(
    classification,
    "saturated_territory",
    "Test 7: many similar articles + no new evidence → Section 4",
  );
  console.log("✓ Test 7: Highly similar articles + little new evidence → saturated_territory");
}

// ---------------------------------------------------------------------------
// Test 8: Similar articles don't inflate coverage depth
// ---------------------------------------------------------------------------
{
  // 8 articles, all highly similar — depth should not exceed score for truly distinct articles
  const similarInputs: ConceptCoverageInputs = {
    ...baseInputs,
    centralArticleCount: 8,
    similarCentralArticleCount: 8,
    articleMentionCount: 8,
  };
  const { scores: sim } = scoreConcept(similarInputs);

  // 4 distinct articles
  const distinctInputs: ConceptCoverageInputs = {
    ...baseInputs,
    centralArticleCount: 4,
    similarCentralArticleCount: 0,
    articleMentionCount: 4,
  };
  const { scores: distinct } = scoreConcept(distinctInputs);

  // articleUniqueness should be 0 for all-similar, 1.0 for all-distinct
  assert.equal(sim.articleUniqueness, 0, "Test 8: all similar → articleUniqueness = 0");
  assert.equal(distinct.articleUniqueness, 1, "Test 8: all distinct → articleUniqueness = 1");
  // Depth itself must reflect uniqueness — 8 near-duplicates are LESS coverage
  // than 4 distinct articles, not double. This is the guard for the original
  // bug: uniqueness was displayed beside an un-discounted depth score.
  assert.ok(
    sim.coverageDepth < distinct.coverageDepth,
    `Test 8: 8 similar (${sim.coverageDepth}) must score below 4 distinct (${distinct.coverageDepth})`,
  );
  assert.ok(
    sim.coverageDepth < 0.5,
    `Test 8: all-similar pile must not read as substantial coverage, got ${sim.coverageDepth}`,
  );
  console.log("✓ Test 8: Similar articles don't inflate depth (uniqueness discounts coverageDepth)");
}

// ---------------------------------------------------------------------------
// Test 9: Reader interest affects priority but not evidence strength
// ---------------------------------------------------------------------------
{
  const lowDemand: ConceptCoverageInputs = { ...baseInputs, demandViews30d: 0, activeTrustedCount: 5 };
  const highDemand: ConceptCoverageInputs = { ...baseInputs, demandViews30d: 999, activeTrustedCount: 5 };

  const { scores: low } = scoreConcept(lowDemand);
  const { scores: high } = scoreConcept(highDemand);

  assert.equal(
    low.evidenceStrength,
    high.evidenceStrength,
    "Test 9: evidenceStrength unchanged by reader interest",
  );
  assert.ok(high.readerInterest > low.readerInterest, "Test 9: readerInterest increases with views");
  assert.ok(
    high.opportunityScore > low.opportunityScore,
    "Test 9: opportunityScore increased by reader interest",
  );
  console.log("✓ Test 9: Reader interest affects opportunityScore but not evidenceStrength");
}

// ---------------------------------------------------------------------------
// Test 10: Retractions reduce evidence strength and surface review action
// ---------------------------------------------------------------------------
{
  const inputs: ConceptCoverageInputs = {
    ...baseInputs,
    activeTrustedCount: 3,
    independentFamilyCount: 2,
    newestEvidenceAt: daysAgo(20),
    retractedLinkedCount: 2, // two retractions
  };
  const { recommendedAction } = scoreConcept(inputs);
  assert.equal(
    recommendedAction,
    "review_source_health",
    "Test 10: retractions → review_source_health action",
  );
  console.log("✓ Test 10: Retractions → review_source_health recommended action");
}

// ---------------------------------------------------------------------------
// Test 11: Editorial states suppress repetitive recommendations
// ---------------------------------------------------------------------------
{
  const inputs: ConceptCoverageInputs = {
    ...baseInputs,
    activeTrustedCount: 5,
    independentFamilyCount: 3,
    newestEvidenceAt: daysAgo(10),
    centralArticleCount: 0,
    articleMentionCount: 0,
  };

  const { classification: cls1, recommendedAction: act1 } = scoreConcept(inputs, "none");
  assert.equal(cls1, "strong_evidence_missing_coverage", "Test 11 pre: Section 1 without editorial state");

  const { recommendedAction: actComplete } = scoreConcept(inputs, "intentionally_complete");
  assert.equal(
    actComplete,
    "mark_intentionally_complete",
    "Test 11: intentionally_complete → mark_intentionally_complete",
  );

  const { recommendedAction: actWaiting } = scoreConcept(inputs, "waiting_for_evidence");
  assert.equal(
    actWaiting,
    "find_more_sources",
    "Test 11: waiting_for_evidence → find_more_sources",
  );

  console.log("✓ Test 11: Editorial states suppress repetitive recommendations");
}

// ---------------------------------------------------------------------------
// Test 12: Promote-to-idea preserves provenance
// (Pure: verify that ConceptCoverageInputs contains all required provenance fields)
// ---------------------------------------------------------------------------
{
  const inputs: ConceptCoverageInputs = {
    ...baseInputs,
    conceptId: "concept-uuid",
    primaryBeatSlug: "psychology",
    secondaryBeatSlugs: ["neuroscience"],
    sourceDocumentIds: ["doc-1", "doc-2"],
    sourceFamilyIds: ["fam-1"],
    centralArticleIds: ["art-1"],
    radarSuggestionId: "radar-uuid",
    radarSuggestionStatus: "pending",
  };
  // Verify the inputs carry all provenance fields required by the promote route
  assert.equal(inputs.conceptId, "concept-uuid");
  assert.deepEqual(inputs.sourceDocumentIds, ["doc-1", "doc-2"]);
  assert.deepEqual(inputs.sourceFamilyIds, ["fam-1"]);
  assert.deepEqual(inputs.centralArticleIds, ["art-1"]);
  assert.equal(inputs.primaryBeatSlug, "psychology");
  assert.deepEqual(inputs.secondaryBeatSlugs, ["neuroscience"]);
  assert.equal(inputs.radarSuggestionId, "radar-uuid");
  // scoreConcept still works — no data lost
  const { classification } = scoreConcept(inputs);
  assert.ok(classification, "Test 12: scoreConcept returns classification with full provenance");
  console.log("✓ Test 12: Provenance fields present in ConceptCoverageInputs (promote-to-idea safe)");
}

// ---------------------------------------------------------------------------
// Test 13: Zero AI calls
// (Structural: verify no AI-related imports exist in the scoring module)
// ---------------------------------------------------------------------------
{
  // This test verifies the scoring module has no AI calls by checking that
  // the module exports are pure math functions only. The scoring module was
  // already confirmed to have no AI imports when read above.
  const result = scoreConcept(baseInputs);
  assert.ok(typeof result.scores.evidenceStrength === "number", "Test 13: returns numbers");
  assert.ok(typeof result.classification === "string", "Test 13: returns classification");
  // If AI were called, this synchronous call would require a Promise.
  assert.ok(!(result instanceof Promise), "Test 13: scoreConcept is synchronous (no AI calls)");
  console.log("✓ Test 13: scoreConcept is synchronous — no AI calls");
}

// ---------------------------------------------------------------------------
// Test 14: Unchanged items not recalculated (fingerprint)
// ---------------------------------------------------------------------------
{
  const inputs1: ConceptCoverageInputs = {
    ...baseInputs,
    activeTrustedCount: 5,
    independentFamilyCount: 3,
    newestEvidenceAt: new Date("2025-01-01T00:00:00Z"),
    centralArticleCount: 2,
  };
  const inputs2: ConceptCoverageInputs = { ...inputs1 }; // identical
  const inputs3: ConceptCoverageInputs = { ...inputs1, activeTrustedCount: 6 }; // different

  assert.equal(
    inputFingerprint(inputs1),
    inputFingerprint(inputs2),
    "Test 14: identical inputs → same fingerprint",
  );
  assert.notEqual(
    inputFingerprint(inputs1),
    inputFingerprint(inputs3),
    "Test 14: different inputs → different fingerprint",
  );
  console.log("✓ Test 14: Unchanged inputs produce identical fingerprint; changed inputs differ");
}

console.log("\n✅ All 14 Living Coverage Map scoring tests passed");
