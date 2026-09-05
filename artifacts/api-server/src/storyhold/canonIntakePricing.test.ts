import assert from "node:assert/strict";
import test from "node:test";
import {
  browserQwenUsageCredits,
  canonIntakeContentFingerprint,
  canonIntakeNeedsLargeWarning,
  canonIntakePricingFromEnvironment,
  estimatedTokensFromCharacters,
  incrementalLocalIntakeCredits,
  localIntakeComputeCredits,
} from "./canonIntakePricing";

test("local Canon Intake charges one cumulative world base plus its words", () => {
  assert.equal(localIntakeComputeCredits({ wordCount: 10_000, passageCount: 32, sourceCount: 1 }), 110);
  assert.equal(localIntakeComputeCredits({ wordCount: 100_000, passageCount: 280, sourceCount: 1 }), 200);
  assert.equal(localIntakeComputeCredits({ wordCount: 150_000, passageCount: 480, sourceCount: 8 }), 250);
  assert.equal(localIntakeComputeCredits({ wordCount: 162_000, passageCount: 522, sourceCount: 2 }), 262);
  assert.equal(localIntakeComputeCredits({ wordCount: 250_000, passageCount: 800, sourceCount: 100 }), 350);
});

test("later documents pay only the difference to the cumulative world price", () => {
  assert.equal(incrementalLocalIntakeCredits({
    cumulativeWordCount: 150_000,
    priorCreditsCharged: 200,
    sourceCount: 8,
    passageCount: 480,
  }), 50);
  assert.equal(incrementalLocalIntakeCredits({
    cumulativeWordCount: 150_000,
    priorCreditsCharged: 250,
    sourceCount: 8,
    passageCount: 480,
  }), 0);
  assert.equal(canonIntakeNeedsLargeWarning(150_000), false);
  assert.equal(canonIntakeNeedsLargeWarning(150_001), true);
});

test("browser Qwen pricing follows actual token workload", () => {
  assert.equal(estimatedTokensFromCharacters(4_001), 1_001);
  assert.equal(browserQwenUsageCredits({ inputTokens: 50_000, outputTokens: 10_000 }), 27);
  assert.equal(browserQwenUsageCredits({ inputTokens: 0, outputTokens: 0 }), 0);
});

test("meter rates remain configurable and safely capped", () => {
  const pricing = canonIntakePricingFromEnvironment({
    STORYHOLD_LOCAL_INTAKE_BASE_CREDITS: "50",
    STORYHOLD_LOCAL_INTAKE_CREDITS_PER_1K_WORDS: "2",
    STORYHOLD_LOCAL_INTAKE_MAX_WORLD_WORDS: "400000",
    STORYHOLD_LOCAL_INTAKE_WARNING_WORDS: "200000",
    STORYHOLD_LOCAL_INTAKE_MAX_CREDITS: "1200",
    STORYHOLD_BROWSER_QWEN_INPUT_CREDITS_PER_MILLION: "500",
    STORYHOLD_BROWSER_QWEN_OUTPUT_CREDITS_PER_MILLION: "2,000",
    STORYHOLD_BROWSER_QWEN_MAX_CREDITS: "500",
  });
  assert.equal(
    localIntakeComputeCredits({ wordCount: 1_000_000, passageCount: 5_000, sourceCount: 20 }, pricing),
    1_200,
  );
  assert.equal(pricing.localWorldWordLimit, 400_000);
  assert.equal(pricing.localLargeIntakeWarningWords, 200_000);
  assert.equal(browserQwenUsageCredits({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, pricing), 500);
});

test("the paid intake fingerprint follows content rather than upload order or source ids", () => {
  const first = canonIntakeContentFingerprint([
    { contentHash: "BOOK-TWO" },
    { contentHash: "book-one" },
  ]);
  const reordered = canonIntakeContentFingerprint([
    { contentHash: "book-one" },
    { contentHash: "book-two" },
  ]);
  const changed = canonIntakeContentFingerprint([
    { contentHash: "book-one" },
    { contentHash: "book-three" },
  ]);
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});
