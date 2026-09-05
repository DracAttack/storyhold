// Tests for the pure concept evidence-health derivation (Task #340).
// Run: npx esbuild <file> --bundle --platform=node --format=cjs \
//        --outfile=/tmp/x.cjs --external:pg-native && node --test /tmp/x.cjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isWeakSupport,
  isCoverageOpportunity,
  isStaleConflict,
  deriveHealthAlerts,
  healthAlertDedupeKey,
  WEAK_SUPPORT_MIN_MENTIONS,
  WEAK_SUPPORT_MIN_DEMAND_VIEWS,
  COVERAGE_FRESHNESS_DAYS,
  type ConceptHealthMetrics,
} from "./conceptEvidenceHealth";

const NOW = new Date("2026-07-01T00:00:00Z");
const FRESH = new Date("2026-06-15T00:00:00Z");
const STALE = new Date(NOW.getTime() - (COVERAGE_FRESHNESS_DAYS + 5) * 86_400_000);

function metrics(over: Partial<ConceptHealthMetrics> = {}): ConceptHealthMetrics {
  return {
    conceptId: "c1",
    term: "Gerrymandering",
    slug: "gerrymandering",
    activeTrustedCount: 0,
    independentFamilyCount: 0,
    newestEvidenceAt: null,
    retractedLinkedCount: 0,
    retractedDocIds: [],
    articleMentionCount: 0,
    demandViews30d: 0,
    ...over,
  };
}

test("weak_support: fires only when in demand AND evidence is thin", () => {
  // In demand via mentions, thin evidence.
  assert.equal(
    isWeakSupport(metrics({ articleMentionCount: WEAK_SUPPORT_MIN_MENTIONS, activeTrustedCount: 1 })),
    true,
  );
  // In demand via reader views alone.
  assert.equal(
    isWeakSupport(metrics({ demandViews30d: WEAK_SUPPORT_MIN_DEMAND_VIEWS, activeTrustedCount: 0 })),
    true,
  );
  // No demand — thin evidence alone is not a problem.
  assert.equal(isWeakSupport(metrics({ activeTrustedCount: 0 })), false);
  // Enough trusted evidence — healthy.
  assert.equal(
    isWeakSupport(metrics({ articleMentionCount: 5, activeTrustedCount: 2 })),
    false,
  );
});

test("coverage_opportunity: strong fresh independent evidence + little coverage", () => {
  const good = metrics({
    activeTrustedCount: 3,
    independentFamilyCount: 2,
    newestEvidenceAt: FRESH,
    articleMentionCount: 1,
  });
  assert.equal(isCoverageOpportunity(good, NOW), true);
  // Too much existing coverage.
  assert.equal(isCoverageOpportunity({ ...good, articleMentionCount: 2 }, NOW), false);
  // Not enough trusted docs.
  assert.equal(isCoverageOpportunity({ ...good, activeTrustedCount: 2 }, NOW), false);
  // Not enough independent families.
  assert.equal(isCoverageOpportunity({ ...good, independentFamilyCount: 1 }, NOW), false);
  // Stale evidence.
  assert.equal(isCoverageOpportunity({ ...good, newestEvidenceAt: STALE }, NOW), false);
  // No evidence timestamp at all.
  assert.equal(isCoverageOpportunity({ ...good, newestEvidenceAt: null }, NOW), false);
});

test("stale_conflict: any retracted/superseded linked source fires", () => {
  assert.equal(isStaleConflict(metrics({ retractedLinkedCount: 1 })), true);
  assert.equal(isStaleConflict(metrics({ retractedLinkedCount: 0 })), false);
});

test("deriveHealthAlerts: independent conditions can stack; keys are stable", () => {
  const m = metrics({
    // weak_support: in demand, thin evidence…
    articleMentionCount: 3,
    activeTrustedCount: 1,
    // …and a retracted source.
    retractedLinkedCount: 2,
  });
  const alerts = deriveHealthAlerts(m, NOW);
  assert.deepEqual(
    alerts.map((a) => a.alertType).sort(),
    ["stale_conflict", "weak_support"],
  );
  for (const a of alerts) {
    assert.equal(a.conceptId, "c1");
    assert.equal(a.dedupeKey, healthAlertDedupeKey(a.alertType, "c1"));
  }
  // weak_support and coverage_opportunity are mutually exclusive by
  // construction (thin vs strong evidence) — a healthy concept derives none.
  assert.deepEqual(deriveHealthAlerts(metrics(), NOW), []);
});

test("dedupe key format is <type>:<conceptId>", () => {
  assert.equal(healthAlertDedupeKey("weak_support", "abc"), "weak_support:abc");
});
