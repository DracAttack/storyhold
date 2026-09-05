import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CAMPAIGN_INPUT_MODES,
  campaignInputModes,
  safeCampaignInputMode,
} from "./campaignInputModes";

test("solo play never offers the author-only Event input", () => {
  assert.deepEqual(
    campaignInputModes("solo").map((option) => option.id),
    ["action", "question"],
  );
  assert.equal(safeCampaignInputMode("solo", "event"), "action");
});

test("author play retains all three ways to guide a story", () => {
  assert.deepEqual(campaignInputModes("author"), CAMPAIGN_INPUT_MODES);
  assert.equal(safeCampaignInputMode("author", "event"), "event");
});

test("the play screen renders only the modes allowed by the locked experience", () => {
  const page = readFileSync(
    new URL("../pages/campaign-play.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /campaignInputModes\(session\.campaign\.experienceMode\)\.map/u);
  assert.match(page, /safeCampaignInputMode\([\s\S]*session\.campaign\.experienceMode/u);
  assert.doesNotMatch(page, /\{INPUT_MODES\.map/u);
  assert.doesNotMatch(page, /Director(?:&apos;|')s causal decision/u);
  assert.doesNotMatch(page, /State \{(?:checkpoint|branch|session\.lineage)/u);
});
