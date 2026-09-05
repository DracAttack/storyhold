import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreCluster,
  strongestAuthorityTier,
  AUTHORITY_TIER_ORDER,
  type ClusterScoreInput,
} from "./clusterScore";

// A baseline input that contributes nothing (0 volume, 0 diversity, no recency)
// so a single component can be isolated per test. Authority defaults to unknown
// (null) which contributes round(0.2 * 20) = 4 unless overridden.
function baseInput(overrides: Partial<ClusterScoreInput> = {}): ClusterScoreInput {
  return {
    sourceCount: 0,
    familyCount: 0,
    domainCount: 0,
    topAuthorityTier: null,
    newestSourceAt: null,
    freshnessWindowDays: 7,
    ...overrides,
  };
}

// --- volume (weight 25, saturates at 8 sources) ---------------------------

// Volume credit is capped at 4 observations per independent voice (see
// VOLUME_PER_VOICE), so these tests carry enough families/domains that the
// cap is not the binding constraint.

test("volume: full credit at the saturation point (8 sources)", () => {
  const { breakdown } = scoreCluster(
    baseInput({ sourceCount: 8, familyCount: 8, domainCount: 8 }),
  );
  assert.equal(breakdown.volume, 25);
});

test("volume: half the saturation point yields half credit (rounded)", () => {
  const { breakdown } = scoreCluster(
    baseInput({ sourceCount: 4, familyCount: 4, domainCount: 4 }),
  );
  assert.equal(breakdown.volume, 13); // round(0.5 * 25) = 13
});

test("volume: zero sources gives zero", () => {
  const { breakdown } = scoreCluster(baseInput({ sourceCount: 0 }));
  assert.equal(breakdown.volume, 0);
});

test("volume: above saturation is clamped, not extrapolated", () => {
  const { breakdown } = scoreCluster(
    baseInput({ sourceCount: 40, familyCount: 10, domainCount: 10 }),
  );
  assert.equal(breakdown.volume, 25);
});

test("volume: negative source count is floored at zero", () => {
  const { breakdown } = scoreCluster(baseInput({ sourceCount: -5 }));
  assert.equal(breakdown.volume, 0);
});

// --- diversity (weight 30, saturates at 5 families) -----------------------
// Syndication-aware: familyCount collapses reprints into one voice, so this is
// the signal that 10 wire copies of one story ≈ 1 independent source.

test("diversity: full credit at the saturation point (5 families)", () => {
  const { breakdown } = scoreCluster(baseInput({ familyCount: 5 }));
  assert.equal(breakdown.diversity, 30);
});

test("diversity: syndicated reprints collapsed to one family score low", () => {
  // 10 raw sources but only 1 distinct family (all reprints of one wire story).
  const { breakdown } = scoreCluster(baseInput({ sourceCount: 10, familyCount: 1 }));
  assert.equal(breakdown.diversity, 6); // round(0.2 * 30) = 6
});

test("diversity: two independent families", () => {
  const { breakdown } = scoreCluster(baseInput({ familyCount: 2 }));
  assert.equal(breakdown.diversity, 12); // round(0.4 * 30) = 12
});

test("diversity: above saturation is clamped", () => {
  const { breakdown } = scoreCluster(baseInput({ familyCount: 25 }));
  assert.equal(breakdown.diversity, 30);
});

// --- independent voices: family count capped by domain count ---------------
// The GovInfo failure mode: 58 DISTINCT documents (each its own family) all
// from govinfo.gov scored as 58 "outlets" and banked full volume + diversity,
// flooding the editor cockpit with 90-100 scores. Voices = min(families,
// domains): one publisher can only ever be one voice.

test("voices: a single-domain flood scores as ONE voice, not 58", () => {
  const now = new Date("2026-07-13T00:00:00.000Z");
  const { score, breakdown } = scoreCluster(
    baseInput({
      sourceCount: 58,
      familyCount: 58,
      domainCount: 1,
      topAuthorityTier: "primary",
      newestSourceAt: now,
      freshnessWindowDays: 7,
      now,
    }),
  );
  // One voice → diversity/volume credited as a single outlet, then the whole
  // score is dampened by the single-voice cap (see SINGLE_VOICE_SCORE_CAP), so
  // components land below their un-dampened values (diversity 6 → ~4).
  assert.ok(breakdown.diversity <= 6, `one-voice diversity must stay minimal, got ${breakdown.diversity}`);
  assert.ok(breakdown.volume <= 13, `one-voice volume must stay capped, got ${breakdown.volume}`);
  assert.ok(score <= 45, `single-domain flood must not top the cockpit, got ${score}`);
});

test("voices: a fresh primary-tier single-voice cluster is capped at 45", () => {
  // Even ONE observation per voice with primary authority + perfect recency
  // must not headline the cockpit — the July 2026 failure mode was GovInfo
  // doc piles at 63-70 from authority (20) + recency (25) + capped volume.
  const now = new Date("2026-07-13T00:00:00.000Z");
  const { score, breakdown } = scoreCluster(
    baseInput({
      sourceCount: 14,
      familyCount: 14,
      domainCount: 1,
      topAuthorityTier: "primary",
      newestSourceAt: now,
      freshnessWindowDays: 7,
      now,
    }),
  );
  assert.ok(score <= 45, `single-voice cluster must cap at 45, got ${score}`);
  const sum =
    breakdown.volume + breakdown.diversity + breakdown.authority + breakdown.recency + breakdown.velocity;
  assert.equal(sum, score, "capped breakdown components must still sum to the score");
});

test("voices: two independent voices are NOT capped", () => {
  const now = new Date("2026-07-13T00:00:00.000Z");
  const { score } = scoreCluster(
    baseInput({
      sourceCount: 8,
      familyCount: 2,
      domainCount: 2,
      topAuthorityTier: "primary",
      newestSourceAt: now,
      freshnessWindowDays: 7,
      now,
    }),
  );
  assert.ok(score > 45, `two-voice corroborated story should exceed the cap, got ${score}`);
});

test("voices: a genuinely multi-outlet story outranks a bigger single-domain pile", () => {
  const now = new Date("2026-07-13T00:00:00.000Z");
  const common = { topAuthorityTier: "primary" as const, newestSourceAt: now, freshnessWindowDays: 7, now };
  const multi = scoreCluster(
    baseInput({ sourceCount: 6, familyCount: 5, domainCount: 5, ...common }),
  );
  const flood = scoreCluster(
    baseInput({ sourceCount: 80, familyCount: 80, domainCount: 1, ...common }),
  );
  assert.ok(
    multi.score > flood.score,
    `5-outlet story (${multi.score}) must beat 80-doc single-domain pile (${flood.score})`,
  );
});

test("voices: syndication collapse is unchanged (10 domains, 1 family = 1 voice)", () => {
  const { breakdown } = scoreCluster(
    baseInput({ sourceCount: 10, familyCount: 1, domainCount: 10 }),
  );
  assert.equal(breakdown.diversity, 6); // min(1, 10) = 1 voice
});

test("voices: zero domainCount (legacy rows) falls back to familyCount alone", () => {
  const { breakdown } = scoreCluster(baseInput({ familyCount: 5, domainCount: 0 }));
  assert.equal(breakdown.diversity, 30);
});

// --- authority (weight 20, per-tier credit) -------------------------------

test("authority: each tier maps to its expected weighted credit", () => {
  const cases: Array<[Exclude<ClusterScoreInput["topAuthorityTier"], null>, number]> = [
    ["primary", 20], // round(1 * 20)
    ["firsthand", 17], // round(0.85 * 20)
    ["wire", 12], // round(0.6 * 20)
    ["commentary", 8], // round(0.4 * 20)
    ["social", 5], // round(0.25 * 20)
    ["aggregator", 2], // round(0.1 * 20)
    ["unknown", 4], // round(0.2 * 20)
  ];
  for (const [tier, expected] of cases) {
    const { breakdown } = scoreCluster(baseInput({ topAuthorityTier: tier }));
    assert.equal(breakdown.authority, expected, `tier ${tier}`);
  }
});

test("authority: null tier is treated as unknown", () => {
  const { breakdown } = scoreCluster(baseInput({ topAuthorityTier: null }));
  assert.equal(breakdown.authority, 4); // same as unknown
});

// --- recency (weight 25, decays over the freshness window) ----------------

test("recency: a brand-new source gets full credit", () => {
  const now = new Date("2026-01-15T00:00:00.000Z");
  const { breakdown } = scoreCluster(
    baseInput({ newestSourceAt: now, freshnessWindowDays: 7, now }),
  );
  assert.equal(breakdown.recency, 25);
});

test("recency: a source exactly at the window edge decays to zero", () => {
  const now = new Date("2026-01-15T00:00:00.000Z");
  const newestSourceAt = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const { breakdown } = scoreCluster(baseInput({ newestSourceAt, freshnessWindowDays: 7, now }));
  assert.equal(breakdown.recency, 0);
});

test("recency: halfway through the window yields half credit", () => {
  const now = new Date("2026-01-15T00:00:00.000Z");
  const newestSourceAt = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000);
  const { breakdown } = scoreCluster(baseInput({ newestSourceAt, freshnessWindowDays: 8, now }));
  assert.equal(breakdown.recency, 13); // round(0.5 * 25) = 13
});

test("recency: a source older than the window gives no credit (not negative)", () => {
  const now = new Date("2026-01-15T00:00:00.000Z");
  const newestSourceAt = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const { breakdown } = scoreCluster(baseInput({ newestSourceAt, freshnessWindowDays: 7, now }));
  assert.equal(breakdown.recency, 0);
});

test("recency: null newestSourceAt gives no recency credit", () => {
  const { breakdown } = scoreCluster(baseInput({ newestSourceAt: null }));
  assert.equal(breakdown.recency, 0);
});

test("recency: a non-positive freshness window falls back to 7 days", () => {
  const now = new Date("2026-01-15T00:00:00.000Z");
  const newestSourceAt = new Date(now.getTime() - 3.5 * 24 * 60 * 60 * 1000);
  // windowDays = 0 → fallback 7 → ageDays 3.5 → recency 0.5.
  const { breakdown } = scoreCluster(baseInput({ newestSourceAt, freshnessWindowDays: 0, now }));
  assert.equal(breakdown.recency, 13);
});

// --- blend + 0-100 clamp --------------------------------------------------

test("score: the components sum to the total", () => {
  const now = new Date("2026-01-15T00:00:00.000Z");
  const { score, breakdown } = scoreCluster(
    baseInput({
      sourceCount: 4,
      familyCount: 2,
      topAuthorityTier: "wire",
      newestSourceAt: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000),
      freshnessWindowDays: 8,
      markerCount: 5,
      now,
    }),
  );
  assert.equal(
    score,
    breakdown.volume +
      breakdown.diversity +
      breakdown.authority +
      breakdown.recency +
      breakdown.velocity,
  );
  assert.equal(score, 13 + 12 + 12 + 13 + 8); // velocity: round(0.5 * 15) = 8
});

// --- velocity (weight 15, saturates at 10 markers) ------------------------
// Trend markers are the ONLY input here: they are a public-interest signal, not
// evidence, so they contribute solely to velocity (never volume/diversity/
// authority) and can never satisfy the trusted-source floor on their own.

test("velocity: full credit at the saturation point (10 markers)", () => {
  const { breakdown } = scoreCluster(baseInput({ markerCount: 10 }));
  assert.equal(breakdown.velocity, 15);
});

test("velocity: half the saturation point yields half credit (rounded)", () => {
  const { breakdown } = scoreCluster(baseInput({ markerCount: 5 }));
  assert.equal(breakdown.velocity, 8); // round(0.5 * 15) = 8
});

test("velocity: no markers gives zero", () => {
  const { breakdown } = scoreCluster(baseInput());
  assert.equal(breakdown.velocity, 0);
});

test("velocity: above saturation is clamped, not extrapolated", () => {
  const { breakdown } = scoreCluster(baseInput({ markerCount: 500 }));
  assert.equal(breakdown.velocity, 15);
});

test("velocity: markers never contribute authority/diversity/volume", () => {
  // A pile of markers with NO real sources cannot fabricate evidence signals.
  const { breakdown } = scoreCluster(baseInput({ markerCount: 100 }));
  assert.equal(breakdown.volume, 0);
  assert.equal(breakdown.diversity, 0);
  assert.equal(breakdown.authority, 4); // unknown default only
});

test("score: a maxed-out cluster reaches exactly 100", () => {
  const now = new Date("2026-01-15T00:00:00.000Z");
  const { score, breakdown } = scoreCluster(
    baseInput({
      sourceCount: 8,
      familyCount: 5,
      topAuthorityTier: "primary",
      newestSourceAt: now,
      freshnessWindowDays: 7,
      now,
    }),
  );
  assert.deepEqual(breakdown, {
    volume: 25,
    diversity: 30,
    authority: 20,
    recency: 25,
    velocity: 0,
  });
  assert.equal(score, 100);
});

test("score: an over-saturated cluster is clamped to 100, never higher", () => {
  const now = new Date("2026-01-15T00:00:00.000Z");
  const { score } = scoreCluster(
    baseInput({
      sourceCount: 1000,
      familyCount: 1000,
      topAuthorityTier: "primary",
      newestSourceAt: now,
      freshnessWindowDays: 7,
      now,
    }),
  );
  assert.equal(score, 100);
});

test("score: an empty cluster stays within [0, 100]", () => {
  const { score } = scoreCluster(baseInput());
  assert.ok(score >= 0 && score <= 100, `expected 0..100, got ${score}`);
});

test("score: the result is always an integer", () => {
  const now = new Date("2026-01-15T00:00:00.000Z");
  const { score } = scoreCluster(
    baseInput({
      sourceCount: 3,
      familyCount: 3,
      topAuthorityTier: "commentary",
      newestSourceAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      freshnessWindowDays: 9,
      now,
    }),
  );
  assert.equal(Number.isInteger(score), true);
});

// --- authority ranking: AUTHORITY_TIER_ORDER + strongestAuthorityTier -----
// These back cluster LABEL selection (strongest member's title wins). The
// ordinal (index 0 = strongest) recently had a truthiness bug — index 0 is
// falsy, so `idx || fallback` would demote `primary`. These guard that.

test("AUTHORITY_TIER_ORDER: strongest-first ordering is exact", () => {
  assert.deepEqual(AUTHORITY_TIER_ORDER, [
    "primary",
    "firsthand",
    "wire",
    "reported",
    "commentary",
    "social",
    "aggregator",
    "reference",
    "unknown",
  ]);
});

test("AUTHORITY_TIER_ORDER: primary is ordinal 0 (the truthiness-bug guard)", () => {
  // If a comparator used `idx || fallback`, primary's 0 would be treated as
  // missing and sort LAST instead of first. Assert the raw ordinal is 0.
  assert.equal(AUTHORITY_TIER_ORDER.indexOf("primary"), 0);
  assert.ok(AUTHORITY_TIER_ORDER.indexOf("primary") < AUTHORITY_TIER_ORDER.indexOf("wire"));
  assert.ok(AUTHORITY_TIER_ORDER.indexOf("wire") < AUTHORITY_TIER_ORDER.indexOf("unknown"));
});

test("strongestAuthorityTier: picks the highest-authority tier regardless of order", () => {
  assert.equal(strongestAuthorityTier(["wire", "primary", "social"]), "primary");
  assert.equal(strongestAuthorityTier(["social", "wire", "commentary"]), "wire");
  assert.equal(strongestAuthorityTier(["aggregator", "social"]), "social");
});

test("strongestAuthorityTier: primary wins even when it appears last", () => {
  // Direct guard for the ordinal-0 truthiness bug in the picker itself.
  assert.equal(strongestAuthorityTier(["aggregator", "commentary", "primary"]), "primary");
});

test("strongestAuthorityTier: reference outranks only unknown", () => {
  // reference (Wikipedia-style background) is a KNOWN identity, so it beats
  // unclassified — but every evidence-capable tier beats it.
  assert.equal(strongestAuthorityTier(["reference", "unknown"]), "reference");
  assert.equal(strongestAuthorityTier(["reference", "aggregator"]), "aggregator");
});

test("strongestAuthorityTier: null/undefined members are ignored", () => {
  assert.equal(strongestAuthorityTier([null, undefined, "wire", null]), "wire");
});

test("strongestAuthorityTier: an empty list yields null", () => {
  assert.equal(strongestAuthorityTier([]), null);
});

test("strongestAuthorityTier: an all-empty list yields null", () => {
  assert.equal(strongestAuthorityTier([null, undefined]), null);
});
