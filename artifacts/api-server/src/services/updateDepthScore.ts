/**
 * Update Depth Score — deterministic 0–100 scoring that shapes how thorough an
 * auto-generated update article should be. Computed BEFORE drafting; adds zero
 * LLM latency. The score encodes four editorial judgments:
 *
 *   1. Development magnitude   (0–35): how big is THIS development?
 *   2. Story significance      (0–30): how big is the UNDERLYING story?
 *   3. Beat thoroughness floor (0–20): does this beat value explanation or speed?
 *   4. Evidence availability   (0–15): can the vault actually support thoroughness?
 *
 * Risk modifier: a high cluster risk score REDUCES the target depth (risky beats
 * stay tight and factual, not long and editorializing) without blocking publish.
 *
 * Score → generator instruction:
 *   0–30   Tight recap stub   (2–4 sentences, no padding)
 *   31–60  Standard update    (~150–400 words)
 *   61–100 Thorough treatment (full write-up, mechanism + significance)
 *
 * Retraction note: if any article in the chain has an uncleared retraction
 * impact, the depth score is floored at "tight" (≤30) regardless of other
 * signals — the update must be conservative until an editor reviews the chain.
 * This is the only path where a retraction affects depth (not publish-blocking).
 */

// ---------------------------------------------------------------------------
// Beat thoroughness floors
// ---------------------------------------------------------------------------

// How much depth the beat deserves BY DEFAULT, on a 0–20 scale.
// Explanatory beats (science, health, climate) score high because their value
// is the mechanism — a bare "X happened" is near-worthless.
// Fast-event beats (politics, crime) score low because speed + accuracy matters
// more than depth, and short factual updates on risky beats are both safer and
// faster. This encodes "explain the science, just report the verdict".
const BEAT_THOROUGHNESS_FLOOR: Record<string, number> = {
  // High floor — explain-the-mechanism beats
  "science": 20,
  "climate": 20,
  "health": 20,
  "medicine": 20,
  "environment": 18,
  "technology": 16,
  "space": 18,
  "education": 15,
  "economics": 13,
  // Medium floor
  "business": 12,
  "culture": 12,
  "history": 14,
  "society": 11,
  // Low floor — fast-event / fact-first beats
  "politics": 6,
  "crime": 5,
  "law": 6,
  "sports": 5,
  "breaking": 3,
  "conflict": 7,
  "finance": 9,
};

const DEFAULT_BEAT_FLOOR = 10;

function beatThoroughnessFloor(beatSlug: string): number {
  return BEAT_THOROUGHNESS_FLOOR[beatSlug.toLowerCase()] ?? DEFAULT_BEAT_FLOOR;
}

// ---------------------------------------------------------------------------
// Headline vocabulary weight
// ---------------------------------------------------------------------------

// Terminal-event words indicate a major resolution → deserves more depth.
const TERMINAL_VOCAB = [
  "verdict", "sentenced", "resolved", "ruling", "convicted", "acquitted",
  "dismissed", "concluded", "final", "over", "ends", "ended", "killed",
  "dies", "died", "arrested", "charged", "indicted", "settlement", "settled",
  "peace", "ceasefire", "signed", "approved", "passed", "banned",
];

// Progress words indicate an increment → keep tight.
const PROGRESS_VOCAB = [
  "developing", "update", "continues", "ongoing", "latest", "breaking",
  "new details", "more", "report", "sources say",
];

function headlineVocabBonus(headline: string): number {
  const lower = headline.toLowerCase();
  const hasTerminal = TERMINAL_VOCAB.some((w) => lower.includes(w));
  if (hasTerminal) return 10;
  const hasProgress = PROGRESS_VOCAB.some((w) => lower.includes(w));
  if (hasProgress) return 3;
  return 6; // neutral — a concrete development without a label
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DepthTarget = "stub" | "standard" | "thorough";

export interface UpdateDepthInput {
  /** The new development's implied headline (used for vocab scoring). */
  headline: string;
  /** Track that triggered the signal: "authority" (Track B) or "corroboration" (Track A). */
  trackType: "authority" | "corroboration";
  /** Number of triggering source documents. */
  triggeringDocCount: number;
  /** Whether ALL triggering docs are primary/firsthand/wire tier. */
  allTriggeringAreTrusted: boolean;
  /** Number of prior published articles in this story chain (0 for first update). */
  priorChainDepth: number;
  /** The parent cluster's score (0–100) — measures story significance/heat. */
  clusterScore: number;
  /** Beat slug of the cluster (used for thoroughness floor). */
  beatSlug: string;
  /** Number of ACTIVE, trusted-tier (primary/firsthand/wire) source documents
   *  currently available in the vault for this cluster. This is the evidence
   *  ceiling — thoroughness cannot exceed what the vault can ground. */
  activeTrustedSourceCount: number;
  /** Optional cluster risk score (0–100); high risk reduces target depth. */
  riskScore?: number;
  /** Whether any article in the chain has an uncleared retraction impact. */
  chainHasRetractionImpact?: boolean;
}

export interface UpdateDepthScore {
  /** Blended 0–100 score (after risk modifier). */
  score: number;
  /** Discrete depth target derived from the score. */
  depthTarget: DepthTarget;
  /** Generator instruction string to inject into the drafting prompt. */
  generatorInstruction: string;
  /** Score component breakdown (for transparency / admin review). */
  breakdown: {
    developmentMagnitude: number;  // 0–35
    storySignificance: number;     // 0–30
    beatThoroughnessFloor: number; // 0–20
    evidenceAvailability: number;  // 0–15
    riskReduction: number;         // 0–(total), always ≤0
  };
}

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

/**
 * Compute the update depth score deterministically from the provided inputs.
 * No AI calls, no async — pure data.
 */
export function computeUpdateDepthScore(input: UpdateDepthInput): UpdateDepthScore {
  // --- 1. Development magnitude (0–35) ---
  let magnitude = 0;
  if (input.trackType === "authority") {
    // Track B: single high-authority source fired. Base score 15.
    magnitude = 15;
  } else {
    // Track A: corroboration. Scale with source count.
    if (input.triggeringDocCount >= 4) {
      magnitude = 28;
    } else if (input.triggeringDocCount >= 3) {
      magnitude = 20;
    } else {
      magnitude = 12;
    }
  }
  // All-trusted-tier bonus: when every triggering doc is primary/firsthand/wire.
  if (input.allTriggeringAreTrusted) magnitude = Math.min(35, magnitude + 7);
  // Headline vocabulary bonus (3, 6, or 10).
  magnitude = Math.min(35, magnitude + headlineVocabBonus(input.headline) - 6);

  // --- 2. Story significance (0–30) ---
  // Chain depth: +3 per prior article, cap 15. Long-running stories deserve depth.
  const chainBonus = Math.min(15, input.priorChainDepth * 3);
  // Cluster heat: 0–15, scaled linearly from the 0–100 cluster score.
  const heatBonus = Math.round((input.clusterScore / 100) * 15);
  const significance = Math.min(30, chainBonus + heatBonus);

  // --- 3. Beat thoroughness floor (0–20) ---
  const beatFloor = Math.min(20, beatThoroughnessFloor(input.beatSlug));

  // --- 4. Evidence availability (0–15) ---
  // Caps thoroughness to what the vault can actually ground.
  // 1 trusted source → 3, 2 → 6, 3 → 9, 4 → 11, 5 → 13, 6+ → 15.
  const evidenceAvailability = Math.min(15, Math.round(input.activeTrustedSourceCount * 2.5));

  // --- Blended raw score ---
  const raw = magnitude + significance + beatFloor + evidenceAvailability;

  // --- Risk modifier ---
  // A high cluster risk score reduces the depth target so risky-beat updates
  // stay short and factual. Risk score 0 → no reduction; 100 → max -25.
  // This is intentionally asymmetric: risk reduces depth, never blocks publish.
  const riskScore = input.riskScore ?? 0;
  const riskReduction = -Math.round((riskScore / 100) * 25);

  // Retraction guard: any uncleared retraction impact in the chain floors the
  // score to "tight" (max 30). The update must be conservative until an editor
  // reviews which claims in the chain may be affected.
  const retractionCap = input.chainHasRetractionImpact ? 30 : 100;

  const score = Math.max(0, Math.min(retractionCap, raw + riskReduction));

  // --- Map to depth target ---
  let depthTarget: DepthTarget;
  let generatorInstruction: string;

  if (score <= 30) {
    depthTarget = "stub";
    generatorInstruction =
      "Report the development in 2–4 sentences. Do not pad. " +
      "If there is insufficient material for 2 sentences, produce a single clear recap. " +
      "No analysis, no mechanism, no background — fact only.";
  } else if (score <= 60) {
    depthTarget = "standard";
    generatorInstruction =
      "Report the development with brief context. " +
      "Include a proportional 'story so far' recap (1–2 short paragraphs for deep chains, " +
      "a single sentence for new ones). " +
      "Aim for 150–400 words. Ground every claim in the tagged vault sources.";
  } else {
    depthTarget = "thorough";
    generatorInstruction =
      "Provide a full development write-up: the fact, the mechanism or process behind it, " +
      "the significance to the ongoing story, and a generous 'story so far' that grounds " +
      "the reader in the chain. Ground every claim in the tagged vault sources. " +
      "Aim for 400–800 words. Do not pad — every sentence must be sourced or mechanistic.";
  }

  // Append retraction advisory to the instruction when the chain is affected.
  if (input.chainHasRetractionImpact) {
    generatorInstruction +=
      " NOTE: One or more sources supporting earlier articles in this chain have been " +
      "retracted or updated. Keep this update strictly factual and conservative. " +
      "Do not repeat claims from earlier chain articles unless they are directly " +
      "supported by active vault sources tagged to this cluster.";
  }

  return {
    score,
    depthTarget,
    generatorInstruction,
    breakdown: {
      developmentMagnitude: magnitude,
      storySignificance: significance,
      beatThoroughnessFloor: beatFloor,
      evidenceAvailability,
      riskReduction,
    },
  };
}
