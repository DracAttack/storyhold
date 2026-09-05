// Tests for the pure Cross-Beat Radar gate pipeline (Task #340).
// Run: npx esbuild <file> --bundle --platform=node --format=cjs \
//        --outfile=/tmp/x.cjs --external:pg-native && node --test /tmp/x.cjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRadarCandidate,
  applyOverlapGate,
  radarDedupeKey,
  scoreCandidate,
  trustedEvidenceDocs,
  countIndependentFamilies,
  freshnessWindowDays,
  familyKey,
  RADAR_DEFAULT_FRESHNESS_DAYS,
  RADAR_WEIGHT_THRESHOLD,
  type RadarEvidenceDoc,
  type RadarCandidateInput,
} from "./crossBeatRadar";

const NOW = new Date("2026-07-01T00:00:00Z");
const FRESH = new Date("2026-06-20T00:00:00Z");
const STALE = new Date(NOW.getTime() - (RADAR_DEFAULT_FRESHNESS_DAYS + 10) * 86_400_000);

function doc(over: Partial<RadarEvidenceDoc> = {}): RadarEvidenceDoc {
  return {
    docId: over.docId ?? `doc-${Math.random().toString(36).slice(2, 8)}`,
    url: over.url ?? "https://example.com/x",
    tier: over.tier ?? "reported",
    familyId: over.familyId ?? null,
    newestAt: over.newestAt === undefined ? FRESH : over.newestAt,
  };
}

function candidate(over: Partial<RadarCandidateInput> = {}): RadarCandidateInput {
  return {
    conceptId: "c1",
    term: "Quantitative easing",
    slug: "quantitative-easing",
    beats: over.beats ?? [
      { beatSlug: "economics", weight: 0.6 },
      { beatSlug: "politics", weight: 0.4 },
    ],
    evidence: over.evidence ?? [
      doc({ docId: "a", tier: "primary" }),
      doc({ docId: "b", tier: "wire" }),
    ],
    ...("conceptId" in over ? { conceptId: over.conceptId! } : {}),
  };
}

test("passes all pure gates with a bridge profile + fresh independent trusted evidence", () => {
  const r = evaluateRadarCandidate(candidate(), NOW);
  assert.equal(r.passed, true);
  assert.equal(r.failedGate, null);
  assert.equal(r.trustedDocs.length, 2);
  assert.equal(r.independentFamilies, 2);
  assert.ok(r.score > 0);
});

test("affinity gate: fails with fewer than two beats at the bridge threshold", () => {
  const r = evaluateRadarCandidate(
    candidate({
      beats: [
        { beatSlug: "economics", weight: 0.9 },
        { beatSlug: "politics", weight: RADAR_WEIGHT_THRESHOLD - 0.01 },
      ],
    }),
    NOW,
  );
  assert.equal(r.passed, false);
  assert.equal(r.failedGate, "affinity");
  assert.equal(r.score, 0);
});

test("evidence gate: untrusted tiers do not count", () => {
  const r = evaluateRadarCandidate(
    candidate({
      evidence: [
        doc({ docId: "a", tier: "commentary" }),
        doc({ docId: "b", tier: "aggregator" }),
        doc({ docId: "c", tier: "reference" }),
      ],
    }),
    NOW,
  );
  assert.equal(r.passed, false);
  assert.equal(r.failedGate, "evidence");
});

test("evidence gate: two trusted docs in the SAME family fail independence", () => {
  const r = evaluateRadarCandidate(
    candidate({
      evidence: [
        doc({ docId: "a", tier: "primary", familyId: "fam1" }),
        doc({ docId: "b", tier: "wire", familyId: "fam1" }),
      ],
    }),
    NOW,
  );
  assert.equal(r.passed, false);
  assert.equal(r.failedGate, "evidence");
});

test("freshness gate: fails when the newest trusted doc is outside the window", () => {
  const r = evaluateRadarCandidate(
    candidate({
      evidence: [
        doc({ docId: "a", tier: "primary", newestAt: STALE }),
        doc({ docId: "b", tier: "wire", newestAt: STALE }),
      ],
    }),
    NOW,
  );
  assert.equal(r.passed, false);
  assert.equal(r.failedGate, "freshness");
});

test("freshness gate: docs with null timestamps count as never-fresh", () => {
  const r = evaluateRadarCandidate(
    candidate({
      evidence: [
        doc({ docId: "a", tier: "primary", newestAt: null }),
        doc({ docId: "b", tier: "wire", newestAt: null }),
      ],
    }),
    NOW,
  );
  assert.equal(r.passed, false);
  assert.equal(r.failedGate, "freshness");
});

test("overlap gate: any hit converts a pass into an overlap failure", () => {
  const passed = evaluateRadarCandidate(candidate(), NOW);
  const overlapped = applyOverlapGate(passed, 1);
  assert.equal(overlapped.passed, false);
  assert.equal(overlapped.failedGate, "overlap");
  assert.equal(overlapped.score, 0);
  // Zero hits leaves the result untouched.
  assert.deepEqual(applyOverlapGate(passed, 0), passed);
  // Already-failed results pass through unchanged.
  const failed = evaluateRadarCandidate(candidate({ beats: [] }), NOW);
  assert.equal(applyOverlapGate(failed, 5).failedGate, "affinity");
});

test("dedupe key: sorted beat pair, top two only, stable across order", () => {
  assert.equal(radarDedupeKey("c1", ["politics", "economics"]), "c1:economics+politics");
  assert.equal(radarDedupeKey("c1", ["economics", "politics"]), "c1:economics+politics");
  // Only the first two (sorted) beats participate.
  assert.equal(
    radarDedupeKey("c1", ["science", "economics", "politics"]),
    "c1:economics+politics",
  );
});

test("score: driven by second-strongest beat weight, damped evidence depth, family bonus", () => {
  const base = scoreCandidate(
    [
      { beatSlug: "a", weight: 0.6 },
      { beatSlug: "b", weight: 0.4 },
    ],
    2,
    2,
  );
  const strongerBridge = scoreCandidate(
    [
      { beatSlug: "a", weight: 0.6 },
      { beatSlug: "b", weight: 0.5 },
    ],
    2,
    2,
  );
  assert.ok(strongerBridge > base);
  const moreFamilies = scoreCandidate(
    [
      { beatSlug: "a", weight: 0.6 },
      { beatSlug: "b", weight: 0.4 },
    ],
    3,
    3,
  );
  assert.ok(moreFamilies > base);
});

test("helpers: familyKey falls back to docId; freshness window picks the loosest beat", () => {
  assert.equal(familyKey(doc({ docId: "d1", familyId: null })), "d1");
  assert.equal(familyKey(doc({ docId: "d1", familyId: "f9" })), "f9");
  assert.equal(freshnessWindowDays(["anything", "else"]), RADAR_DEFAULT_FRESHNESS_DAYS);
  const trusted = trustedEvidenceDocs([
    doc({ tier: "primary" }),
    doc({ tier: "social" }),
    doc({ tier: "reported" }),
  ]);
  assert.equal(trusted.length, 2);
  assert.equal(
    countIndependentFamilies([
      doc({ docId: "x", familyId: "f1" }),
      doc({ docId: "y", familyId: "f1" }),
      doc({ docId: "z", familyId: null }),
    ]),
    2,
  );
});
