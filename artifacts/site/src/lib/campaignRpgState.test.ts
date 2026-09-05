import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  CAMPAIGN_RPG_COMPACT_LIMIT,
  CAMPAIGN_RPG_MODE_LABELS,
  CAMPAIGN_RPG_SECTION_LABELS,
  enforceStoryFirstRpgState,
  presentCampaignRpgState,
  type CampaignRpgStateViewModel,
} from "./campaignRpgState";
import { toChicagoTitleCase } from "./utils";

const fullState: Omit<CampaignRpgStateViewModel, "mode"> = {
  objectives: [{
    id: "objective-gate",
    title: "Reach the Western Gate",
    status: "at-risk",
    summary: "Cross the flooded lower ward.",
    nextStep: "Find a dry route through the market.",
    stakes: "The gate closes at nightfall.",
    progress: { current: 2, maximum: 4 },
  }],
  location: {
    name: "Lower Ward",
    summary: "Rain fills the abandoned market.",
    nearby: ["Bell Tower", "Canal Steps"],
  },
  vitality: {
    state: "Bruised but Steady",
    current: 7,
    maximum: 10,
    temporary: 2,
    note: "Your ribs ache when you run.",
    breakdown: [{ label: "Travel Wear", value: -1 }],
  },
  stress: {
    state: "Watchful",
    current: 3,
    maximum: 8,
    breakdown: [{ label: "Safe Company", value: -2 }],
  },
  conditions: [{
    id: "condition-ribs",
    name: "Bruised Ribs",
    summary: "Sudden movement hurts.",
    severity: "Moderate",
    duration: "Until Rested",
  }],
  capabilities: [{
    id: "capability-scouting",
    name: "Scouting",
    summary: "You notice paths others miss.",
    rating: 3,
    modifier: 4,
    breakdown: [
      { label: "Training", value: 3 },
      { label: "Weather", value: -1 },
    ],
  }],
  equippedItems: [{
    id: "item-spear",
    name: "Ash Spear",
    summary: "A familiar, balanced weapon.",
    quantity: 1,
    rules: [{ label: "Reach", value: "2 Spaces" }],
  }],
  inventory: [{
    id: "item-tonic",
    name: "Restorative Tonic",
    summary: "Sharp-smelling and warm.",
    quantity: 3,
    rules: [{ label: "Restore", value: "1d6 Vitality" }],
  }],
  companions: [{
    id: "companion-ivo",
    name: "Ivo",
    role: "Guide",
    state: "Uneasy",
    note: "He distrusts the canal route.",
    vitality: { current: 5, maximum: 6 },
  }],
  reputation: [{
    id: "reputation-watch",
    name: "Western Watch",
    standing: "Reluctant Ally",
    note: "They remember your promise.",
    score: 2,
    breakdown: [{ label: "Kept Word", value: 3 }],
  }],
};

test("story-first presentation keeps fiction and hides every numeric rule", () => {
  const result = presentCampaignRpgState({ mode: "story-first", ...fullState });
  assert.equal(result.modeLabel, "Story Focus");
  assert.equal(result.showNumbers, false);
  assert.equal(result.showBreakdowns, false);
  assert.equal(result.overview.find((item) => item.id === "vitality")?.value, "Bruised but Steady");
  assert.equal(result.overview.find((item) => item.id === "vitality")?.number, undefined);
  assert.equal(result.overview.find((item) => item.id === "objective")?.number, undefined);
  assert.ok(result.sections.some((section) => section.id === "capabilities"));
  for (const overview of result.overview) {
    assert.equal(overview.number, undefined);
    assert.deepEqual(overview.breakdown, []);
  }
  for (const item of result.sections.flatMap((section) => section.items)) {
    assert.equal(item.value, undefined);
    assert.deepEqual(item.breakdown, []);
  }
  assert.deepEqual(
    result.sections.find((section) => section.id === "conditions")?.items[0]?.tags,
    [],
  );
});

test("a locked story-first campaign downgrades a mismatched detailed payload", () => {
  const supplied = { mode: "tactical" as const, ...fullState };
  const guarded = enforceStoryFirstRpgState(supplied, "story_first");
  const result = presentCampaignRpgState(guarded);
  assert.equal(guarded.mode, "story-first");
  assert.equal(result.showNumbers, false);
  assert.equal(result.showBreakdowns, false);
  assert.ok(result.overview.every((item) => item.number === undefined));
  assert.ok(
    result.sections.flatMap((section) => section.items).every(
      (item) => item.value === undefined && item.breakdown.length === 0,
    ),
  );
});

test("light rules show concise totals without tactical breakdowns", () => {
  const result = presentCampaignRpgState({ mode: "light-rules", ...fullState });
  assert.equal(result.showNumbers, true);
  assert.equal(result.showBreakdowns, false);
  assert.equal(result.overview.find((item) => item.id === "vitality")?.number, "7 / 10");
  assert.equal(
    result.sections.find((section) => section.id === "capabilities")?.items[0]?.value,
    "+4",
  );
  assert.ok(
    result.sections.flatMap((section) => section.items).every(
      (item) => item.breakdown.length === 0,
    ),
  );
});

test("tactical presentation exposes supplied totals, tags, and breakdowns", () => {
  const result = presentCampaignRpgState({ mode: "tactical", ...fullState });
  const vitality = result.overview.find((item) => item.id === "vitality");
  const objective = result.sections.find((section) => section.id === "objectives")?.items[0];
  const capability = result.sections.find((section) => section.id === "capabilities")?.items[0];
  const equipment = result.sections.find((section) => section.id === "equipment")?.items[0];
  const inventory = result.sections.find((section) => section.id === "inventory")?.items[0];

  assert.equal(result.modeLabel, "Tactical Detail");
  assert.equal(result.showNumbers, true);
  assert.equal(result.showBreakdowns, true);
  assert.equal(vitality?.number, "7 / 10");
  assert.deepEqual(vitality?.breakdown, [{ label: "Travel Wear", value: "-1" }]);
  assert.equal(objective?.value, "2 / 4");
  assert.deepEqual(objective?.tags, ["At Risk"]);
  assert.equal(capability?.value, "+4");
  assert.deepEqual(capability?.tags, ["Rating 3"]);
  assert.deepEqual(capability?.breakdown, [
    { label: "Training", value: "+3" },
    { label: "Weather", value: "-1" },
  ]);
  assert.equal(equipment?.value, "×1");
  assert.deepEqual(equipment?.breakdown, [{ label: "Reach", value: "2 Spaces" }]);
  assert.equal(inventory?.value, "×3");
});

test("custom visibility fails closed and reveals only explicitly allowed sections", () => {
  const result = presentCampaignRpgState({
    mode: "custom",
    ...fullState,
    visibility: {
      sections: { location: "summary", companions: "detailed" },
      showNumbers: false,
      showBreakdowns: true,
    },
  });
  assert.deepEqual(result.overview.map((item) => item.id), ["location"]);
  assert.deepEqual(result.sections.map((section) => section.id), ["companions"]);
  assert.equal(result.sections[0]?.items[0]?.detail, "He distrusts the canal route.");
  assert.equal(result.sections[0]?.items[0]?.value, undefined);
  assert.equal(result.showBreakdowns, false);
});

test("the panel stays compact and all interface labels use the site's title style", () => {
  const result = presentCampaignRpgState({
    mode: "tactical",
    conditions: Array.from({ length: CAMPAIGN_RPG_COMPACT_LIMIT + 3 }, (_, index) => ({
      id: `condition-${index}`,
      name: `Condition ${index}`,
    })),
  });
  const conditions = result.sections.find((section) => section.id === "conditions");
  assert.equal(conditions?.items.length, CAMPAIGN_RPG_COMPACT_LIMIT);
  assert.equal(conditions?.overflowCount, 3);

  const labels = [
    result.heading,
    "At a Glance",
    "Current Objective",
    "Show Character Details",
    "Hide Character Details",
    "Rules Breakdown",
    ...Object.values(CAMPAIGN_RPG_MODE_LABELS),
    ...Object.values(CAMPAIGN_RPG_SECTION_LABELS),
  ];
  for (const label of labels) {
    assert.equal(label, toChicagoTitleCase(label));
  }
  assert.doesNotMatch(labels.join(" "), /backend|model|schema|state[_ ]version|engine/iu);
});

test("campaign play renders only a supplied RPG state and keeps legacy sessions empty", () => {
  const page = readFileSync(
    new URL("../pages/campaign-play.tsx", import.meta.url),
    "utf8",
  );
  const api = readFileSync(new URL("./storyholdApi.ts", import.meta.url), "utf8");
  assert.match(api, /rpgState\?:\s*CampaignRpgStateViewModel/u);
  assert.match(page, /session\.rpgState\s*\?\s*\(/u);
  assert.match(page, /<CampaignRpgStatePanel/u);
  assert.match(page, /enforceStoryFirstRpgState\([\s\S]*session\.campaign\.resolutionMode/u);
  assert.doesNotMatch(page, /rpgState\s*\?\?\s*\{/u);
  assert.ok(page.indexOf("<CampaignRpgStatePanel") < page.indexOf("World Clock"));
});
