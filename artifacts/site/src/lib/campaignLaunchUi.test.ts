import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const importPage = readFileSync(
  new URL("../pages/profile-import.tsx", import.meta.url),
  "utf8",
);
const quickstart = readFileSync(
  new URL("../components/customer/quickstart-creator.tsx", import.meta.url),
  "utf8",
);
const importedLaunch = readFileSync(
  new URL("../components/customer/world-contract-panel.tsx", import.meta.url),
  "utf8",
);

test("the creation screen exposes two distinct player entrances", () => {
  assert.match(importPage, /Start a New Adventure/u);
  assert.match(importPage, /Play My Writing/u);
  assert.match(importPage, /<QuickstartCreator\s+scenario=\{linkedScenario\}\s*\/>/u);
  assert.match(importPage, /<ManuscriptImporter/u);
});

test("an original adventure locks a solo RPG seed without manuscript assumptions", () => {
  assert.match(quickstart, /creationMode:\s*"quickstart"/u);
  assert.match(quickstart, /experienceMode:\s*"solo"/u);
  assert.match(quickstart, /characterConcept,/u);
  assert.match(quickstart, /initialObjective,/u);
  assert.match(quickstart, /resolutionMode,/u);
  assert.match(quickstart, /<fieldset disabled=\{busy\}/u);
  assert.doesNotMatch(quickstart, /upload(?:ed)? manuscript|source snapshot/iu);
});

test("an imported-world launch sends every player choice and invalidates stale links", () => {
  assert.match(importedLaunch, /Opening Objective \(Optional\)/u);
  assert.match(importedLaunch, /createCampaign\(\{[\s\S]*?initialObjective,[\s\S]*?canonAnchorEventId:[\s\S]*?resolutionMode,[\s\S]*?experienceMode,/u);
  assert.match(importedLaunch, /useEffect\(\(\) => \{\s*setCreatedCampaignId\(""\);[\s\S]*?initialObjective,[\s\S]*?selectedStartChoiceId,/u);
  assert.match(importedLaunch, /defaultCampaignStartChoice\(startChoices\)/u);
  assert.match(importedLaunch, /disabled=\{Boolean\(createdCampaignId\)\}/u);
});

test("campaign launch copy describes player consequences, not internal plumbing", () => {
  assert.doesNotMatch(importedLaunch, /fixed source snapshot|campaign-scoped memory|RPG seed|backend|GLiNER|Qwen/iu);
  assert.match(importedLaunch, /Storyhold preserves the canon they can know at that moment/u);
});
