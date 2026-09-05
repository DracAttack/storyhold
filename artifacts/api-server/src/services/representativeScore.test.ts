import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeRepresentativeScore,
  isMateriallyDefective,
  decideRepresentative,
  type RepScoreInput,
} from "./representativeScore";

// A healthy, active baseline document — individual tests override fields.
function doc(overrides: Partial<RepScoreInput> = {}): RepScoreInput {
  return {
    authorityTier: "firsthand",
    qualityScore: 80,
    wordCount: 1200,
    chunkCount: 0,
    canonicalUrl: null,
    domain: "example-news.com",
    extractionMethod: "readability",
    publishedAt: null,
    paywallDetected: false,
    excerptOnly: false,
    status: "extracted",
    lifecycleStatus: "active",
    authoritySource: "auto",
    ...overrides,
  };
}

// --- computeRepresentativeScore ------------------------------------------

test("authority dominates the composite score", () => {
  const primary = computeRepresentativeScore(doc({ authorityTier: "primary", qualityScore: 60 }));
  const social = computeRepresentativeScore(doc({ authorityTier: "social", qualityScore: 100 }));
  assert.ok(primary.total > social.total, "primary tier must beat social even at max quality");
  assert.equal(primary.breakdown.authority, 700);  // primary rank = 7
  assert.equal(social.breakdown.authority, 200);   // social rank = 2
});

test("breakdown components and reasons are reported", () => {
  const s = computeRepresentativeScore(
    doc({
      canonicalUrl: "https://example.gov/report",
      domain: "cdc.gov",
      extractionMethod: "unpdf",
      wordCount: 5000,
      chunkCount: 4,
    }),
    { includeChunks: true },
  );
  assert.equal(s.breakdown.canonical, 20);
  assert.equal(s.breakdown.officialDomain, 15);
  assert.equal(s.breakdown.extractionMethod, 10);
  assert.equal(s.breakdown.completeness, 20 + 4 * 5);
  assert.ok(s.reasons.some((r) => r.includes("canonical")), "reasons mention canonical");
  assert.ok(s.reasons.some((r) => r.includes("Official domain")), "reasons mention official domain");
});

test("chunk bonus excluded when includeChunks=false (ingest fairness)", () => {
  const withChunks = computeRepresentativeScore(doc({ chunkCount: 8 }), { includeChunks: true });
  const without = computeRepresentativeScore(doc({ chunkCount: 8 }), { includeChunks: false });
  assert.equal(withChunks.total - without.total, 40);
});

test("penalties: paywall, excerpt-only, social wrapper (no double-count)", () => {
  const paywalled = computeRepresentativeScore(doc({ paywallDetected: true }));
  assert.equal(paywalled.breakdown.penalties.paywall, -10);

  const excerpt = computeRepresentativeScore(doc({ excerptOnly: true }));
  assert.equal(excerpt.breakdown.penalties.excerptOnly, -30);

  // Manual pin of "primary" on a YouTube link: the wrapper penalty applies.
  const wrapped = computeRepresentativeScore(
    doc({ domain: "youtube.com", authorityTier: "primary" }),
  );
  assert.equal(wrapped.breakdown.penalties.socialWrapper, -15);

  // Tier already social — low authority covers it, no extra wrapper penalty.
  const social = computeRepresentativeScore(doc({ domain: "youtube.com", authorityTier: "social" }));
  assert.equal(social.breakdown.penalties.socialWrapper, undefined);
});

test("body_fallback extraction is penalized; recency is small and bounded", () => {
  const fallback = computeRepresentativeScore(doc({ extractionMethod: "body_fallback" }));
  assert.equal(fallback.breakdown.extractionMethod, -10);

  const fresh = computeRepresentativeScore(doc({ publishedAt: new Date() }));
  assert.equal(fresh.breakdown.recency, 10);
  const old = computeRepresentativeScore(
    doc({ publishedAt: new Date(Date.now() - 400 * 86_400_000) }),
  );
  assert.equal(old.breakdown.recency, 0);
});

// --- isMateriallyDefective -------------------------------------------------

test("materially defective: quality, excerpt, paywall, thin text, bad status/lifecycle", () => {
  assert.equal(isMateriallyDefective(doc()), false);
  assert.equal(isMateriallyDefective(doc({ qualityScore: 40 })), true);
  assert.equal(isMateriallyDefective(doc({ excerptOnly: true })), true);
  assert.equal(isMateriallyDefective(doc({ paywallDetected: true })), true);
  assert.equal(isMateriallyDefective(doc({ wordCount: 80 })), true);
  assert.equal(isMateriallyDefective(doc({ status: "failed" })), true);
  assert.equal(isMateriallyDefective(doc({ lifecycleStatus: "retracted" })), true);
  // requireChunks only counts against a STORED representative.
  assert.equal(isMateriallyDefective(doc({ chunkCount: 0 })), false);
  assert.equal(isMateriallyDefective(doc({ chunkCount: 0 }), { requireChunks: true }), true);
  assert.equal(isMateriallyDefective(doc({ chunkCount: 3 }), { requireChunks: true }), false);
});

// --- decideRepresentative ----------------------------------------------------

test("rule 1: strictly higher tier wins when not defective", () => {
  const d = decideRepresentative(
    doc({ authorityTier: "primary" }),
    doc({ authorityTier: "wire", chunkCount: 6, qualityScore: 95 }),
  );
  assert.equal(d.winner, "incoming");
  assert.match(d.reason, /higher authority/);
});

test("rule 1 guard: higher tier but materially defective does NOT win", () => {
  const d = decideRepresentative(
    doc({ authorityTier: "primary", excerptOnly: true }),
    doc({ authorityTier: "wire" }),
  );
  assert.equal(d.winner, "rep");
  assert.match(d.reason, /materially defective/);
});

test("rule 2: same tier decided by composite score", () => {
  const win = decideRepresentative(
    doc({ qualityScore: 95, wordCount: 4000 }),
    doc({ qualityScore: 60, wordCount: 300 }),
  );
  assert.equal(win.winner, "incoming");
  assert.match(win.reason, /same tier, better copy/);

  const lose = decideRepresentative(
    doc({ qualityScore: 60 }),
    doc({ qualityScore: 95 }),
  );
  assert.equal(lose.winner, "rep");
});

test("rule 2: incumbent keeps ties (incoming must be strictly better)", () => {
  const d = decideRepresentative(doc(), doc());
  assert.equal(d.winner, "rep");
});

test("rule 3: one tier lower rescues only a materially defective rep", () => {
  // Rep (wire) is truly broken — thin excerpt, terrible quality. Challenger is
  // a clean full-text article one tier lower (reported). The authority gap
  // (100 pts) is intentionally hard to overcome; rescue fires because the rep
  // is materially defective AND the challenger's score beats it.
  // decideRepresentative(incoming, rep): incoming = challenger, rep = stored.
  const rescue = decideRepresentative(
    doc({ authorityTier: "reported", qualityScore: 90, wordCount: 4000 }),                              // incoming: reported (tier 4)
    doc({ authorityTier: "wire", excerptOnly: true, qualityScore: 20, wordCount: 90, chunkCount: 0 }), // rep: wire (tier 5), defective
  );
  assert.equal(rescue.winner, "incoming");
  assert.match(rescue.reason, /defective/);

  // A healthy wire rep holds even when the incoming reported doc is good —
  // rescue only fires for a defective rep, not merely a lower-tier one.
  const notEnough = decideRepresentative(
    doc({ authorityTier: "reported", qualityScore: 90, wordCount: 4000 }),  // incoming: reported
    doc({ authorityTier: "wire", qualityScore: 90 }),                       // rep: wire, NOT defective
  );
  assert.equal(notEnough.winner, "rep");

  // Healthy rep one tier up is never displaced by a lower-tier challenger.
  const hold = decideRepresentative(
    doc({ authorityTier: "wire", qualityScore: 100 }),
    doc({ authorityTier: "firsthand", chunkCount: 5 }),
  );
  assert.equal(hold.winner, "rep");

  // Two tiers lower never rescues, even against a defective rep.
  const tooFar = decideRepresentative(
    doc({ authorityTier: "commentary", qualityScore: 95 }),
    doc({ authorityTier: "firsthand", excerptOnly: true, qualityScore: 30 }),
  );
  assert.equal(tooFar.winner, "rep");
});

test("manual pin blocks rules 2 and 3, but not rule 1", () => {
  // Rule 2 blocked: same tier, better score, but rep is pinned.
  const pinnedTie = decideRepresentative(
    doc({ qualityScore: 100, wordCount: 5000 }),
    doc({ qualityScore: 50, wordCount: 200, authoritySource: "manual" }),
  );
  assert.equal(pinnedTie.winner, "rep");
  assert.match(pinnedTie.reason, /manually pinned/);

  // Rule 3 blocked: defective pinned rep still holds against a lower tier.
  const pinnedRescue = decideRepresentative(
    doc({ authorityTier: "wire", qualityScore: 95 }),
    doc({ authorityTier: "firsthand", excerptOnly: true, authoritySource: "manual" }),
  );
  assert.equal(pinnedRescue.winner, "rep");

  // Rule 1 still applies: a strictly higher tier displaces even a pin.
  const overruled = decideRepresentative(
    doc({ authorityTier: "primary" }),
    doc({ authorityTier: "wire", authoritySource: "manual" }),
  );
  assert.equal(overruled.winner, "incoming");
});
