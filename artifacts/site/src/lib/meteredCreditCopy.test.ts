import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const dossier = read("../components/customer/entity-ai-review-card.tsx");
const readingHealth = read("../components/customer/world-reading-health-panel.tsx");
const worldReview = read("../components/customer/world-premium-review-button.tsx");
const campaignStory = read("../pages/campaign-story.tsx");
const storyStudioServer = read("../../../api-server/src/storyhold/storyStudio.ts");
const legal = read("../pages/storyhold-legal.tsx");

test("customer review surfaces explain metered holds without displaying an exact pre-run maximum", () => {
  for (const source of [dossier, readingHealth, worldReview, campaignStory]) {
    assert.match(source, /unused held credits return/iu);
    assert.match(source, /higher actual usage may use additional available credits/iu);
  }
  assert.doesNotMatch(dossier, /Maximum Storyhold credits/iu);
  assert.doesNotMatch(dossier, /You need \{shortfall\.toLocaleString\(\)\} more credits/iu);
});

test("premium credit terms disclose estimate settlement without changing fixed Canon Intake pricing", () => {
  assert.match(legal, /For metered premium work, Storyhold may hold an estimated amount while processing/iu);
  assert.match(legal, /if actual usage is higher, additional available credits may be used/iu);
  assert.match(legal, /balance cannot cover the difference[\s\S]*remains saved[\s\S]*without repeating the model request/iu);
  assert.match(legal, /provider performed billable work[\s\S]*measured credits may still be used/iu);
  assert.match(legal, /At 150,000 words, the complete local intake is 250 credits/iu);
  assert.match(legal, /reserves the full required balance before Canon Intake begins/iu);
});

test("Story Studio keeps the exact paid request identity across reloads and restarts", () => {
  assert.match(campaignStory, /storyhold:pending-story-generation/iu);
  assert.match(campaignStory, /generationStorageKey\(playerId: string, campaignId: string\)/u);
  assert.match(campaignStory, /const saved = response\.pendingAdaptation/u);
  assert.match(campaignStory, /pending\.fingerprint !== fingerprint/u);
  assert.match(campaignStory, /requestId:\s*generationRequestId/iu);
  assert.match(campaignStory, /writePendingGeneration\(auth\.userId, session\.campaign\.id, pendingGenerationRef\.current\)/u);
  assert.match(campaignStory, /writePendingGeneration\(auth\.userId, session\.campaign\.id, null\)/u);
  assert.match(campaignStory, /generationInFlightRef\.current = generationRequestId/u);
  assert.match(campaignStory, /reason\.payload\.retrySameRequest === false/u);
  assert.doesNotMatch(campaignStory, /requestId:\s*requestId\(\)/u);
  assert.match(storyStudioServer, /CREATE TABLE IF NOT EXISTS storyhold\.campaign_story_requests/u);
  assert.match(storyStudioServer, /input_payload jsonb NOT NULL/u);
  assert.match(storyStudioServer, /storyStudioInputFromSavedRequest\(preparedRequest\)/u);
});
