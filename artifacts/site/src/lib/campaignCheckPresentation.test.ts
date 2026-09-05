import assert from "node:assert/strict";
import test from "node:test";
import { presentCampaignCheck } from "./campaignCheckPresentation";

const overlyDetailed = {
  mode: "tactical" as const,
  result: { outcome: "mixed" as const, band: "mixed", certainty: "check_required" },
  difficulty: "hard" as const,
  factors: [
    { label: "Dexterity 14", influence: "helps" as const },
    { label: "Stealth Rank 2", influence: "helps" as const },
  ],
  numbers: { modifier: 5, percentile: 70, effectivePercentile: 75, d20: 14 },
  breakdown: [{ source: "ability", sourceId: "dexterity", label: "Dexterity 14", value: 8 }],
};

test("story-first keeps only the visible outcome even if the server sends too much", () => {
  assert.deepEqual(presentCampaignCheck(overlyDetailed, "story_first"), {
    outcome: "Mixed",
    difficulty: null,
    factors: [],
    numbers: [],
    breakdown: [],
  });
});

test("light rules explain qualitative factors without numbers or calculations", () => {
  const view = presentCampaignCheck(overlyDetailed, "light_rules");
  assert.equal(view?.difficulty, "Hard");
  assert.deepEqual(view?.factors.map((factor) => factor.label), ["Dexterity", "Stealth"]);
  assert.deepEqual(view?.numbers, []);
  assert.deepEqual(view?.breakdown, []);
});

test("tactical rules retain the requested numerical resolution", () => {
  const view = presentCampaignCheck(overlyDetailed, "tactical");
  assert.deepEqual(view?.numbers, [
    { label: "Modifier", value: "+5" },
    { label: "d20", value: "14" },
    { label: "Percentile", value: "70" },
    { label: "Final Result", value: "75" },
  ]);
  assert.deepEqual(view?.breakdown, [{ label: "Dexterity 14", value: "+8" }]);
});
