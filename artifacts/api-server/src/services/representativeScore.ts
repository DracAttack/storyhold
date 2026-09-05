import type { SourceAuthorityTier } from "@workspace/db";
import { classifyAuthority } from "./sourceAuthority";

// --- Representative scoring (pure, logger-free, unit-testable) -------------
// Decides which member of a duplicate family should be the retrievable
// representative. Authority-first, quality-second: the tier ladder stays
// dominant, and the composite score breaks ties / rescues families whose
// representative is materially defective. Every component is returned in a
// transparent breakdown so the admin UI can show WHY a document won.

/** Tier → rank. Mirrors the ladder in sourceAuthority.ts (strong → weak). */
export const AUTHORITY_RANK: Record<SourceAuthorityTier, number> = {
  primary: 7,
  firsthand: 6,
  wire: 5,
  reported: 4,
  commentary: 3,
  social: 2,
  aggregator: 1,
  reference: 0,
  unknown: 0,
};

// Keep in sync with QUALITY_THRESHOLD in sourceFetch.ts (not imported so this
// module stays dependency-light and bundleable in the pure ESM test harness).
const DEFECT_QUALITY_THRESHOLD = 55;

/** Everything the scorer needs to know about one document. */
export interface RepScoreInput {
  authorityTier: SourceAuthorityTier;
  qualityScore: number;
  wordCount: number;
  chunkCount: number;
  canonicalUrl: string | null;
  domain: string;
  extractionMethod: string | null;
  publishedAt: Date | null;
  paywallDetected: boolean;
  excerptOnly: boolean;
  status: string;
  lifecycleStatus: string;
  authoritySource?: string | null;
}

export interface RepresentativeScore {
  total: number;
  breakdown: {
    authority: number;
    quality: number;
    completeness: number;
    canonical: number;
    officialDomain: number;
    extractionMethod: number;
    recency: number;
    penalties: Record<string, number>;
  };
  reasons: string[];
}

const OFFICIAL_SUFFIXES = [".gov", ".mil", ".int", ".edu", ".ac.uk", ".edu.au"];

// Actual extractionMethod values produced by sourceFetch/documentExtract:
//   readability (clean HTML), body_fallback (messy HTML scrape),
//   unpdf / mammoth / pptx-xml / xlsx-xml / odf-xml / utf8 (structured docs).
const STRUCTURED_METHODS = new Set(["unpdf", "mammoth", "pptx-xml", "xlsx-xml", "odf-xml", "utf8"]);

/**
 * Composite representative score. Higher = better. Notes on design:
 * - qualityScore already prices in extraction defects (short text, no title,
 *   boilerplate ratio, paywall text) via scoreQuality — quality flags are NOT
 *   double-penalized here.
 * - Completeness uses diminishing returns so an 80k-word PDF can't stomp a
 *   clean official summary by sheer bulk.
 * - `includeChunks: false` is used for ingest-time comparisons, where the
 *   incoming doc always has 0 chunks (not yet embedded) — including chunk
 *   count there would rig the contest for the incumbent.
 */
export function computeRepresentativeScore(
  doc: RepScoreInput,
  opts: { includeChunks?: boolean } = {},
): RepresentativeScore {
  const includeChunks = opts.includeChunks !== false;
  const reasons: string[] = [];
  const penalties: Record<string, number> = {};

  // 1. Authority tier — the dominant signal (0–600).
  const authority = AUTHORITY_RANK[doc.authorityTier] * 100;
  reasons.push(`Authority tier "${doc.authorityTier}" (+${authority})`);

  // 2. Extraction quality (0–100); quality flags are already priced in.
  const quality = Math.max(0, Math.min(100, doc.qualityScore));
  reasons.push(`Extraction quality ${quality}/100 (+${quality})`);

  // 3. Completeness with diminishing returns.
  let completeness = 0;
  const w = doc.wordCount;
  const wordBonus = w < 50 ? 0 : w < 500 ? 5 : w < 3000 ? 15 : 20;
  if (wordBonus > 0) {
    completeness += wordBonus;
    reasons.push(`${w.toLocaleString()} words (+${wordBonus})`);
  }
  if (includeChunks && doc.chunkCount > 0) {
    const chunkBonus = Math.min(doc.chunkCount, 8) * 5;
    completeness += chunkBonus;
    reasons.push(`Embedded with ${doc.chunkCount} chunks (+${chunkBonus})`);
  }

  // 4. Canonical URL — the publisher marked a master copy.
  const canonical = doc.canonicalUrl ? 20 : 0;
  if (canonical) reasons.push(`Has canonical URL (+${canonical})`);

  // 5. Official domain.
  const host = doc.domain.toLowerCase();
  const officialDomain = OFFICIAL_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))
    ? 15
    : 0;
  if (officialDomain) reasons.push(`Official domain (+${officialDomain})`);

  // 6. Extraction method: structured document extraction is clean (+10);
  //    body_fallback means readability failed and we scraped the raw body (−10).
  const method = (doc.extractionMethod ?? "").toLowerCase();
  let extractionMethod = 0;
  if (STRUCTURED_METHODS.has(method)) {
    extractionMethod = 10;
    reasons.push(`Structured document extraction (+10)`);
  } else if (method === "body_fallback") {
    extractionMethod = -10;
    reasons.push(`Fallback body scrape (−10)`);
  }

  // 7. Recency: small (0–10), decays ~1/month — never enough to beat authority.
  let recency = 0;
  if (doc.publishedAt) {
    const daysAgo = Math.floor((Date.now() - doc.publishedAt.getTime()) / 86_400_000);
    recency = Math.max(0, 10 - Math.floor(Math.max(0, daysAgo) / 30));
    if (recency > 0) reasons.push(`Recent (published ${daysAgo}d ago) (+${recency})`);
  }

  // Penalties.
  if (doc.paywallDetected) {
    penalties.paywall = -10;
    reasons.push("Paywalled (−10)");
  }
  if (doc.excerptOnly) {
    penalties.excerptOnly = -30;
    reasons.push("Excerpt only — full text unavailable (−30)");
  }
  // Social/aggregator *wrapper* penalty: only when the domain classifies as
  // social/aggregator but the stored tier says otherwise (e.g. a manual pin on
  // a YouTube link) — if the tier already IS social/aggregator the low
  // authority score covers it and we don't double-count.
  const domainTier = classifyAuthority(doc.domain).tier;
  if (
    (domainTier === "social" || domainTier === "aggregator") &&
    doc.authorityTier !== "social" &&
    doc.authorityTier !== "aggregator"
  ) {
    penalties.socialWrapper = -15;
    reasons.push("Hosted on a social/aggregator domain (−15)");
  }

  const penaltyTotal = Object.values(penalties).reduce((a, b) => a + b, 0);
  const total =
    authority + quality + completeness + canonical + officialDomain + extractionMethod + recency + penaltyTotal;

  return {
    total,
    breakdown: { authority, quality, completeness, canonical, officialDomain, extractionMethod, recency, penalties },
    reasons,
  };
}

/**
 * "Materially defective" — the document can't do the representative's job
 * (be the retrievable, trustworthy copy). `requireChunks` applies only to a
 * STORED representative (an incoming challenger hasn't had its chance to
 * embed yet, so 0 chunks is not held against it).
 */
export function isMateriallyDefective(
  doc: RepScoreInput,
  opts: { requireChunks?: boolean } = {},
): boolean {
  if (doc.status === "failed" || doc.status === "low_quality") return true;
  if (doc.lifecycleStatus !== "active") return true;
  if (doc.qualityScore < DEFECT_QUALITY_THRESHOLD) return true;
  if (doc.excerptOnly) return true;
  if (doc.paywallDetected) return true;
  if (doc.wordCount < 120) return true;
  if (opts.requireChunks && doc.chunkCount === 0) return true;
  return false;
}

export interface RepresentativeDecision {
  winner: "incoming" | "rep";
  reason: string;
  incomingScore: RepresentativeScore;
  repScore: RepresentativeScore;
}

/**
 * Authority-first, quality-second representative choice.
 * The incoming document dethrones the stored representative only when:
 *   1. its tier is strictly higher AND it is not materially defective, or
 *   2. tiers are equal AND its score is strictly higher, or
 *   3. it is exactly one tier lower BUT the stored rep is materially defective,
 *      the challenger is not, and the challenger's score is higher.
 * A manually-pinned representative (authoritySource = "manual") can only be
 * displaced by rule 1 — score tie-breaks never override an admin decision.
 * Scores are compared without chunk counts (see computeRepresentativeScore).
 */
export function decideRepresentative(
  incoming: RepScoreInput,
  rep: RepScoreInput,
): RepresentativeDecision {
  const incomingScore = computeRepresentativeScore(incoming, { includeChunks: false });
  const repScore = computeRepresentativeScore(rep, { includeChunks: false });
  const tierGap = AUTHORITY_RANK[incoming.authorityTier] - AUTHORITY_RANK[rep.authorityTier];
  const repPinned = rep.authoritySource === "manual";

  if (tierGap > 0 && !isMateriallyDefective(incoming)) {
    return {
      winner: "incoming",
      reason: `higher authority (${incoming.authorityTier} > ${rep.authorityTier})`,
      incomingScore,
      repScore,
    };
  }

  if (!repPinned && tierGap === 0 && incomingScore.total > repScore.total) {
    return {
      winner: "incoming",
      reason: `same tier, better copy (score ${incomingScore.total} > ${repScore.total})`,
      incomingScore,
      repScore,
    };
  }

  if (
    !repPinned &&
    tierGap === -1 &&
    isMateriallyDefective(rep, { requireChunks: true }) &&
    !isMateriallyDefective(incoming) &&
    incomingScore.total > repScore.total
  ) {
    return {
      winner: "incoming",
      reason: `representative is defective and challenger is usable (score ${incomingScore.total} > ${repScore.total})`,
      incomingScore,
      repScore,
    };
  }

  const why =
    tierGap > 0
      ? "incoming is higher-tier but materially defective"
      : repPinned && tierGap >= -1
        ? "representative is manually pinned"
        : tierGap === 0
          ? `same tier, representative scores ≥ (${repScore.total} ≥ ${incomingScore.total})`
          : `representative outranks (${rep.authorityTier} > ${incoming.authorityTier})`;
  return { winner: "rep", reason: why, incomingScore, repScore };
}
