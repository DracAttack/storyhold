import { createHash } from "node:crypto";

export const CANON_INTAKE_PRICING_VERSION = "canon-intake-v3";
export const BROWSER_QWEN_PRICING_VERSION = "browser-qwen-v1";

export const DEFAULT_CANON_INTAKE_WORD_LIMIT = 250_000;
export const DEFAULT_LARGE_INTAKE_WARNING_WORDS = 150_000;

export type CanonIntakePricing = {
  localBaseCredits: number;
  localCreditsPerThousandWords: number;
  localWorldWordLimit: number;
  localLargeIntakeWarningWords: number;
  browserInputCreditsPerMillionTokens: number;
  browserOutputCreditsPerMillionTokens: number;
  maximumLocalCredits: number;
  maximumBrowserCredits: number;
};

export const DEFAULT_CANON_INTAKE_PRICING: CanonIntakePricing = {
  // One world pays one cumulative setup charge, no matter whether its material
  // arrives as one manuscript or hundreds of chapter files. The word component
  // then grows by one credit per started thousand words. At the standard retail
  // credit value this makes 150,000 words cost 250 credits and the 250,000-word
  // ceiling cost 350 credits.
  localBaseCredits: 100,
  localCreditsPerThousandWords: 1,
  localWorldWordLimit: DEFAULT_CANON_INTAKE_WORD_LIMIT,
  localLargeIntakeWarningWords: DEFAULT_LARGE_INTAKE_WARNING_WORDS,
  // Browser Qwen is metered from the compact audit tokens it handles. It has no
  // external provider bill, but it remains a priced Storyhold processing stage.
  browserInputCreditsPerMillionTokens: 300,
  browserOutputCreditsPerMillionTokens: 1_200,
  maximumLocalCredits: 20_000,
  maximumBrowserCredits: 10_000,
};

function configuredInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.ceil(parsed)));
}

export function canonIntakePricingFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): CanonIntakePricing {
  const localWorldWordLimit = configuredInteger(
    environment.STORYHOLD_LOCAL_INTAKE_MAX_WORLD_WORDS,
    DEFAULT_CANON_INTAKE_PRICING.localWorldWordLimit,
    1_000,
    10_000_000,
  );
  const localLargeIntakeWarningWords = Math.min(
    localWorldWordLimit,
    configuredInteger(
      environment.STORYHOLD_LOCAL_INTAKE_WARNING_WORDS,
      DEFAULT_CANON_INTAKE_PRICING.localLargeIntakeWarningWords,
      1_000,
      10_000_000,
    ),
  );
  return {
    localBaseCredits: configuredInteger(
      environment.STORYHOLD_LOCAL_INTAKE_BASE_CREDITS,
      DEFAULT_CANON_INTAKE_PRICING.localBaseCredits,
      0,
      100_000,
    ),
    localCreditsPerThousandWords: configuredInteger(
      environment.STORYHOLD_LOCAL_INTAKE_CREDITS_PER_1K_WORDS,
      DEFAULT_CANON_INTAKE_PRICING.localCreditsPerThousandWords,
      0,
      100_000,
    ),
    localWorldWordLimit,
    localLargeIntakeWarningWords,
    browserInputCreditsPerMillionTokens: configuredInteger(
      environment.STORYHOLD_BROWSER_QWEN_INPUT_CREDITS_PER_MILLION,
      DEFAULT_CANON_INTAKE_PRICING.browserInputCreditsPerMillionTokens,
      0,
      1_000_000,
    ),
    browserOutputCreditsPerMillionTokens: configuredInteger(
      environment.STORYHOLD_BROWSER_QWEN_OUTPUT_CREDITS_PER_MILLION,
      DEFAULT_CANON_INTAKE_PRICING.browserOutputCreditsPerMillionTokens,
      0,
      1_000_000,
    ),
    maximumLocalCredits: configuredInteger(
      environment.STORYHOLD_LOCAL_INTAKE_MAX_CREDITS,
      DEFAULT_CANON_INTAKE_PRICING.maximumLocalCredits,
      1,
      1_000_000,
    ),
    maximumBrowserCredits: configuredInteger(
      environment.STORYHOLD_BROWSER_QWEN_MAX_CREDITS,
      DEFAULT_CANON_INTAKE_PRICING.maximumBrowserCredits,
      1,
      1_000_000,
    ),
  };
}

export function localIntakeComputeCredits(
  input: { wordCount: number; sourceCount: number; passageCount: number },
  pricing: CanonIntakePricing = canonIntakePricingFromEnvironment(),
) {
  const wordCount = Math.max(0, Math.ceil(Number(input.wordCount) || 0));
  const sourceCount = Math.max(0, Math.ceil(Number(input.sourceCount) || 0));
  const passageCount = Math.max(0, Math.ceil(Number(input.passageCount) || 0));
  if (sourceCount === 0 || wordCount === 0 || passageCount === 0) return 0;
  const credits =
    pricing.localBaseCredits +
    Math.ceil(wordCount / 1_000) * pricing.localCreditsPerThousandWords;
  return Math.min(pricing.maximumLocalCredits, Math.max(1, Math.ceil(credits)));
}

export function incrementalLocalIntakeCredits(
  input: {
    cumulativeWordCount: number;
    priorCreditsCharged: number;
    sourceCount: number;
    passageCount: number;
  },
  pricing: CanonIntakePricing = canonIntakePricingFromEnvironment(),
) {
  const target = localIntakeComputeCredits(
    {
      wordCount: input.cumulativeWordCount,
      sourceCount: input.sourceCount,
      passageCount: input.passageCount,
    },
    pricing,
  );
  return Math.max(0, target - Math.max(0, Math.ceil(input.priorCreditsCharged || 0)));
}

export function canonIntakeWordLimit(
  pricing: CanonIntakePricing = canonIntakePricingFromEnvironment(),
) {
  return pricing.localWorldWordLimit;
}

export function canonIntakeNeedsLargeWarning(
  wordCount: number,
  pricing: CanonIntakePricing = canonIntakePricingFromEnvironment(),
) {
  return Math.max(0, Math.ceil(Number(wordCount) || 0)) >
    pricing.localLargeIntakeWarningWords;
}

export function browserQwenUsageCredits(
  input: { inputTokens: number; outputTokens: number },
  pricing: CanonIntakePricing = canonIntakePricingFromEnvironment(),
) {
  const inputTokens = Math.max(0, Math.ceil(Number(input.inputTokens) || 0));
  const outputTokens = Math.max(0, Math.ceil(Number(input.outputTokens) || 0));
  if (inputTokens === 0 && outputTokens === 0) return 0;
  const credits =
    Math.ceil(
      (inputTokens * pricing.browserInputCreditsPerMillionTokens) / 1_000_000,
    ) +
    Math.ceil(
      (outputTokens * pricing.browserOutputCreditsPerMillionTokens) / 1_000_000,
    );
  return Math.min(pricing.maximumBrowserCredits, Math.max(1, credits));
}

export function estimatedTokensFromCharacters(characters: number) {
  return Math.max(0, Math.ceil((Number(characters) || 0) / 4));
}

export function canonIntakeContentFingerprint(
  sources: Array<{ contentHash: string }>,
) {
  return createHash("sha256")
    .update(CANON_INTAKE_PRICING_VERSION)
    .update("\n")
    .update(
      sources
        .map((source) => source.contentHash.trim().toLocaleLowerCase())
        .filter(Boolean)
        .sort()
        .join("\n"),
    )
    .digest("hex");
}
