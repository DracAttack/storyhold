import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../components/customer/quickstart-creator.tsx", import.meta.url),
  "utf8",
);
const api = readFileSync(new URL("./storyholdApi.ts", import.meta.url), "utf8");

test("new adventures keep reusable world canon separate from the player role", () => {
  assert.match(source, /identity:\s*worldPremise\.trim\(\)/u);
  assert.match(source, /premise:\s*worldPremise\.trim\(\)/u);
  assert.match(source, /createWorld\(\{[\s\S]*?premise:\s*worldPremise[\s\S]*?creationMode:\s*"quickstart"/u);
  assert.match(source, /createCampaign\(\{[\s\S]*?characterConcept,[\s\S]*?experienceMode:\s*"solo"/u);
  assert.doesNotMatch(source, /identity:\s*characterConcept/u);
});

test("new adventures pass the chosen rules and opening goal into campaign launch", () => {
  assert.match(source, /What Do You Want to Accomplish First\?/u);
  assert.match(source, /createCampaign\(\{[\s\S]*?initialObjective,[\s\S]*?resolutionMode/u);
  assert.match(api, /initialObjective\?:\s*string/u);
  assert.match(source, /Story-First — Hidden Rulings/u);
  assert.match(source, /Light Rules — Visible Outcomes and Factors/u);
  assert.match(source, /Tactical — Visible Mechanics and Modifiers/u);
});

test("editing a prepared beginning invalidates its preview and prior launch link", () => {
  assert.match(source, /useEffect\(\(\) => \{\s*setPrepared\(false\);\s*setCreated\(null\);/u);
  for (const dependency of [
    "characterConcept",
    "characterName",
    "initialObjective",
    "resolutionMode",
    "startingPoint",
    "worldName",
    "worldPremise",
  ]) {
    assert.match(source, new RegExp(`\\b${dependency}\\b`, "u"));
  }
});

test("quickstart copy stays player-facing", () => {
  assert.doesNotMatch(source, /source snapshot|RPG seed|GLiNER|Qwen|backend/iu);
  assert.match(source, /The world, your role, and the opening situation are locked/u);
  assert.match(source, /<details[\s\S]*Optional Boundaries and Fixed Facts[\s\S]*<\/details>/u);
});
