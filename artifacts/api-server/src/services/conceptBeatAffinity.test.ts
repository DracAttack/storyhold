import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildArticleSignal,
  buildSourceSignal,
  buildBaseProfile,
  buildRelationshipSignal,
  computeAffinityRows,
  isBridgeProfile,
  normalizeDistribution,
  ARTICLE_SIGNAL_WEIGHT,
  SOURCE_SIGNAL_WEIGHT,
  RELATIONSHIP_SIGNAL_WEIGHT,
  SECONDARY_BEAT_WEIGHT,
  MIN_PROFILE_WEIGHT,
  BRIDGE_WEIGHT_THRESHOLD,
} from "./conceptBeatAffinity";

const BEATS = new Set(["science", "politics", "culture", "tech"]);

function sumWeights(rows: ReadonlyArray<{ weight: number }>): number {
  return rows.reduce((s, r) => s + r.weight, 0);
}

test("normalizeDistribution: empty and non-positive mass -> {}", () => {
  assert.deepEqual(normalizeDistribution({}), {});
  assert.deepEqual(normalizeDistribution({ a: 0, b: -1, c: NaN }), {});
});

test("normalizeDistribution: positive entries sum to 1, junk dropped", () => {
  const out = normalizeDistribution({ a: 2, b: 1, c: 0, d: -5 });
  assert.ok(Math.abs(out.a! + out.b! - 1) < 1e-9);
  assert.ok(Math.abs(out.a! - 2 / 3) < 1e-9);
  assert.equal("c" in out, false);
  assert.equal("d" in out, false);
});

test("buildArticleSignal: primary 1.0, secondary 0.5, dup primary not double-counted, unknown beats ignored", () => {
  const sig = buildArticleSignal(
    [
      { primaryBeat: "science", secondaryBeats: ["politics", "science", "ghost-beat"] },
      { primaryBeat: "science", secondaryBeats: null },
    ],
    BEATS,
  );
  // masses: science 2, politics 0.5 -> normalized 0.8 / 0.2
  assert.ok(Math.abs(sig.science! - 2 / 2.5) < 1e-9);
  assert.ok(Math.abs(sig.politics! - SECONDARY_BEAT_WEIGHT / 2.5) < 1e-9);
  assert.equal("ghost-beat" in sig, false);
});

test("buildArticleSignal: no mentions -> empty", () => {
  assert.deepEqual(buildArticleSignal([], BEATS), {});
});

test("buildSourceSignal: confidence clamped to floor, null beat skipped", () => {
  const sig = buildSourceSignal(
    [
      { beatSlug: "tech", confidence: 0.0 }, // clamps to 0.1
      { beatSlug: "tech", confidence: 0.9 },
      { beatSlug: null, confidence: 1 },
      { beatSlug: "not-a-beat", confidence: 1 },
    ],
    BEATS,
  );
  assert.deepEqual(Object.keys(sig), ["tech"]);
  assert.ok(Math.abs(sig.tech! - 1) < 1e-9);
});

test("computeAffinityRows: no signals -> empty rows, not a bridge", () => {
  const rows = computeAffinityRows({}, {}, {});
  assert.deepEqual(rows, []);
  assert.equal(isBridgeProfile(rows), false);
});

test("computeAffinityRows: single-beat single-signal -> weight 1", () => {
  const rows = computeAffinityRows({ science: 3 }, {}, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.beatSlug, "science");
  assert.ok(Math.abs(rows[0]!.weight - 1) < 1e-9);
  assert.ok(Math.abs(rows[0]!.articleSignal - 1) < 1e-9);
  assert.equal(rows[0]!.sourceSignal, 0);
});

test("computeAffinityRows: relationship-only concept inherits neighbor profile in full", () => {
  const rel = buildRelationshipSignal([{ politics: 1 }, { politics: 0.5, culture: 0.5 }]);
  const rows = computeAffinityRows({}, {}, rel);
  assert.ok(Math.abs(sumWeights(rows) - 1) < 1e-9);
  assert.equal(rows[0]!.beatSlug, "politics");
  assert.ok(Math.abs(rows[0]!.weight - 1.5 / 2) < 1e-9);
});

test("computeAffinityRows: blend renormalizes over PRESENT signals only", () => {
  // article + relationship present, source absent: shares should be 0.5/0.7 and 0.2/0.7
  const rows = computeAffinityRows({ science: 1 }, {}, { politics: 1 });
  const total = ARTICLE_SIGNAL_WEIGHT + RELATIONSHIP_SIGNAL_WEIGHT;
  const science = rows.find((r) => r.beatSlug === "science")!;
  const politics = rows.find((r) => r.beatSlug === "politics")!;
  assert.ok(Math.abs(science.weight - ARTICLE_SIGNAL_WEIGHT / total) < 1e-9);
  assert.ok(Math.abs(politics.weight - RELATIONSHIP_SIGNAL_WEIGHT / total) < 1e-9);
  assert.ok(Math.abs(sumWeights(rows) - 1) < 1e-9);
});

test("computeAffinityRows: full three-signal blend uses 0.5/0.3/0.2", () => {
  const rows = computeAffinityRows({ science: 1 }, { politics: 1 }, { culture: 1 });
  const w = Object.fromEntries(rows.map((r) => [r.beatSlug, r.weight]));
  assert.ok(Math.abs(w.science! - ARTICLE_SIGNAL_WEIGHT) < 1e-9);
  assert.ok(Math.abs(w.politics! - SOURCE_SIGNAL_WEIGHT) < 1e-9);
  assert.ok(Math.abs(w.culture! - RELATIONSHIP_SIGNAL_WEIGHT) < 1e-9);
});

test("computeAffinityRows: tiny residual beats floored away, rest renormalized", () => {
  // science gets 99%, dust gets 1% (< MIN_PROFILE_WEIGHT) -> dust dropped, science back to 1
  const rows = computeAffinityRows({ science: 99, politics: 1 }, {}, {});
  assert.ok(1 / 100 < MIN_PROFILE_WEIGHT, "test setup: politics share must be below the floor");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.beatSlug, "science");
  assert.ok(Math.abs(rows[0]!.weight - 1) < 1e-9);
});

test("computeAffinityRows: sorted by weight desc then beatSlug asc", () => {
  const rows = computeAffinityRows({ politics: 1, culture: 1, science: 2 }, {}, {});
  assert.equal(rows[0]!.beatSlug, "science");
  // tie between culture & politics -> alphabetical
  assert.equal(rows[1]!.beatSlug, "culture");
  assert.equal(rows[2]!.beatSlug, "politics");
});

test("buildBaseProfile excludes relationship weight (one-hop only)", () => {
  const base = buildBaseProfile({ science: 1 }, { politics: 1 });
  const total = ARTICLE_SIGNAL_WEIGHT + SOURCE_SIGNAL_WEIGHT;
  assert.ok(Math.abs(base.science! - ARTICLE_SIGNAL_WEIGHT / total) < 1e-9);
  assert.ok(Math.abs(base.politics! - SOURCE_SIGNAL_WEIGHT / total) < 1e-9);
});

test("buildRelationshipSignal: empty neighbor profiles contribute nothing", () => {
  assert.deepEqual(buildRelationshipSignal([{}, {}]), {});
  const sig = buildRelationshipSignal([{}, { tech: 1 }]);
  assert.ok(Math.abs(sig.tech! - 1) < 1e-9);
});

test("isBridgeProfile: needs >= 2 beats at or above the threshold", () => {
  const bridge = computeAffinityRows({ science: 1, politics: 1 }, {}, {});
  assert.ok(bridge.every((r) => r.weight >= BRIDGE_WEIGHT_THRESHOLD));
  assert.equal(isBridgeProfile(bridge), true);

  const single = computeAffinityRows({ science: 9, politics: 1 }, {}, {});
  assert.equal(isBridgeProfile(single), false);
});
