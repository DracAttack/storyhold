import type { CampaignCheckProjection, ResolutionMode } from "@/lib/storyholdApi";

export type PresentedCampaignCheck = {
  outcome: string | null;
  difficulty: string | null;
  factors: Array<{ label: string; influence: "helps" | "hinders" | "neutral" }>;
  numbers: Array<{ label: string; value: string }>;
  breakdown: Array<{ label: string; value: string }>;
};

function words(value: string | undefined): string | null {
  const cleaned = (value ?? "").replace(/[_-]+/gu, " ").trim();
  if (!cleaned) return null;
  return cleaned.replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function safeFactorLabel(value: string): string {
  return value
    .replace(/\s+Rank\s+\d+\s*$/iu, "")
    .replace(/\s*\([+-]?\d+\)\s*$/u, "")
    .replace(/\s+[+-]\d+\s*$/u, "")
    .replace(/\s+\d+(?:\.\d+)?\s*$/u, "")
    .trim();
}

/**
 * Applies the campaign's locked rules mode again in the browser. A stale or
 * malformed payload can therefore reveal less detail, never more.
 */
export function presentCampaignCheck(
  check: CampaignCheckProjection | null | undefined,
  lockedMode: ResolutionMode,
): PresentedCampaignCheck | null {
  if (!check) return null;

  const outcome = words(check.result?.outcome);
  if (lockedMode === "story_first") {
    return outcome
      ? { outcome, difficulty: null, factors: [], numbers: [], breakdown: [] }
      : null;
  }

  const factors = (check.factors ?? [])
    .map((factor) => ({
      label: safeFactorLabel(factor.label),
      influence: factor.influence,
    }))
    .filter((factor) => factor.label.length > 0);

  const mayShowNumbers = lockedMode === "tactical" || lockedMode === "custom";
  const numbers = mayShowNumbers && check.numbers
    ? [
        { label: "Modifier", value: signed(check.numbers.modifier) },
        ...(typeof check.numbers.d20 === "number"
          ? [{ label: "d20", value: String(check.numbers.d20) }]
          : []),
        ...(typeof check.numbers.percentile === "number"
          ? [{ label: "Percentile", value: String(check.numbers.percentile) }]
          : []),
        ...(typeof check.numbers.effectivePercentile === "number"
          ? [{ label: "Final Result", value: String(check.numbers.effectivePercentile) }]
          : []),
      ]
    : [];

  const breakdown = mayShowNumbers
    ? (check.breakdown ?? []).map((factor) => ({
        label: factor.label.trim(),
        value: signed(factor.value),
      })).filter((factor) => factor.label.length > 0)
    : [];

  const presented: PresentedCampaignCheck = {
    outcome,
    difficulty: words(check.difficulty),
    factors,
    numbers,
    breakdown,
  };
  return presented.outcome || presented.difficulty || presented.factors.length ||
    presented.numbers.length || presented.breakdown.length
    ? presented
    : null;
}
