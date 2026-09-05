import assert from "node:assert/strict";
import test from "node:test";
import {
    STORYHOLD_SCENARIOS,
    auditStoryholdScenarioSelectionConfig,
    drawStoryholdScenarios,
    getScenarioQuickstart,
} from "./storyholdScenarios";

test("scenario quickstart extracts useful, separate world and character fields", () => {
    const scenario = {
      id: "test",
      genre: "Dark fantasy",
      title: "The kingdom erased your name",
      premise: "You are the only healer who remembers the village. Tonight, a child arrives.",
      openingMove: "I hide the child."
    };
    const prefill = getScenarioQuickstart(scenario);
    assert.equal(prefill.characterConcept, "You are the only healer who remembers the village.");
    assert.match(prefill.worldPremise, /A dark fantasy world/u);
    assert.match(prefill.worldPremise, /Tonight, a child arrives\./u);
    assert.equal(prefill.worldName, "The kingdom erased your name");
    assert.equal(prefill.tone, "Dark fantasy");
    assert.equal(prefill.startingPoint, "Tonight, a child arrives.");
    assert.equal(prefill.initialObjective, "I hide the child.");
    assert.equal(prefill.worldPremise.includes("You are the only healer"), false);
});

test("scenario quickstart handles a premise that does not begin with the player's role", () => {
    const scenario = {
      id: "test2",
      genre: "Sci-fi",
      title: "Title",
      premise: "A strange thing happens. You are caught in it.",
      openingMove: "Run."
    };
    const prefill = getScenarioQuickstart(scenario);
    assert.match(prefill.characterConcept, /A strange thing happens\./u);
    assert.match(prefill.worldPremise, /That person is caught in it\./u);
});

test("curated suggestions favor the selected genre without repeating the selection", () => {
    const selected = STORYHOLD_SCENARIOS.find(s => s.genre === "Dark fantasy");
    const drawn = drawStoryholdScenarios(5, selected?.id);
    assert.equal(drawn.length, 5);
    assert.equal(drawn.some((scenario) => scenario.id === selected?.id), false);
    assert.equal(drawn.some((scenario) => scenario.genre === "Dark fantasy"), true);
});

test("curated suggestions start with a diverse set when no scenario is selected", () => {
    const drawn = drawStoryholdScenarios(5);
    assert.equal(drawn.length, 5);
    const genres = new Set(drawn.map(s => s.genre));
    assert.equal(genres.size, 5);
});

test("every curated suggestion points to a real catalog scenario", () => {
    const drawn = drawStoryholdScenarios(100);
    assert.ok(drawn.length >= 20);
    assert.equal(drawn.every((scenario) => STORYHOLD_SCENARIOS.includes(scenario)), true);
});

test("scenario selection configuration rejects missing and duplicate IDs", () => {
    const issues = auditStoryholdScenarioSelectionConfig(
        STORYHOLD_SCENARIOS,
        ["erased-name", "missing-feature", "erased-name"],
        ["company-found-something", "missing-suggestion"],
    );
    assert.deepEqual(issues, [
        "Featured scenario missing-feature is not in the catalog.",
        "Featured scenario erased-name is configured more than once.",
        "Suggested scenario missing-suggestion is not in the catalog.",
    ]);
});
