import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTHOR_STORY_DRAFT_MIN_TURNS,
  assessNarrativeManuscript,
  storyDraftUnlocksAuthorMode,
  summarizeAuthorManuscripts,
} from "./narrativeQualification";

function narrativeChapter(paragraphs = 18): string {
  return Array.from({ length: paragraphs }, (_, index) =>
    `Mara crossed chamber ${index + 1} while the failing lights pulsed behind her. ` +
    `She heard the old engines wake below the floor and wondered which promise had brought the crew this far. ` +
    `“Keep moving,” Tomas said, although neither of them believed the corridor was empty.`,
  ).join("\n\n");
}

test("continuous fiction qualifies as narrative manuscript material", () => {
  const result = assessNarrativeManuscript(narrativeChapter());
  assert.equal(result.qualifies, true);
  assert.equal(result.qualifyingWordCount, result.wordCount);
  assert.ok(result.wordCount >= 120);
});

test("repeated lorem ipsum cannot unlock author mode", () => {
  const filler = Array.from({ length: 150 }, () =>
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
  ).join(" ");
  const result = assessNarrativeManuscript(filler);
  assert.equal(result.qualifies, false);
  assert.equal(result.qualifyingWordCount, 0);
  assert.ok(result.reasons.includes("placeholder_text"));
});

test("a pile of mislabeled character sheets does not count as a manuscript", () => {
  const sheet = Array.from({ length: 12 }, (_, index) => [
    `Name: Candidate ${index + 1}`,
    "Age: 27",
    "Species: Human",
    "Class: Scout",
    "Strength: 12",
    "Dexterity: 14",
    "Constitution: 11",
    "Intelligence: 13",
    "Wisdom: 10",
    "Charisma: 9",
    "Powers: None",
    "Equipment: Pack, radio, knife",
    "Bio: A cautious explorer with a difficult past and an unresolved family dispute.",
  ].join("\n")).join("\n\n");
  const result = assessNarrativeManuscript(sheet);
  assert.equal(result.qualifies, false);
  assert.ok(result.reasons.includes("character_sheet_structure"));

  const summary = summarizeAuthorManuscripts(Array.from({ length: 20 }, (_, index) => ({
    id: String(index),
    title: `Sheet ${index + 1}`,
    extracted_text: sheet,
    word_count: 1_000,
    processing_status: "ready",
    source_kind: "manuscript",
    canon_status: "canon",
  })));
  assert.equal(summary.qualifiedManuscriptWordCount, 0);
  assert.equal(summary.rejectedSourceCount, 20);
});

test("many honest chapter files combine toward author access", () => {
  const summary = summarizeAuthorManuscripts(Array.from({ length: 60 }, (_, index) => ({
    id: String(index),
    title: `Chapter ${index + 1}`,
    extracted_text: narrativeChapter(4),
    word_count: 200,
    processing_status: "ready",
    source_kind: "manuscript",
    canon_status: "canon",
  })));
  assert.equal(summary.qualifiedSourceCount, 60);
  assert.ok(summary.qualifiedManuscriptWordCount >= 10_000);
});

test("a token or filler story draft cannot unlock author mode", () => {
  assert.equal(storyDraftUnlocksAuthorMode({
    status: "draft",
    source_turn_ids: Array.from({ length: AUTHOR_STORY_DRAFT_MIN_TURNS }, (_, index) => String(index)),
    prose: "One sentence.",
  }), false);
  assert.equal(storyDraftUnlocksAuthorMode({
    status: "draft",
    source_turn_ids: Array.from({ length: AUTHOR_STORY_DRAFT_MIN_TURNS }, (_, index) => String(index)),
    prose: "Lorem ipsum dolor sit amet. ".repeat(500),
  }), false);
});

test("a substantial adaptation of committed scenes unlocks author mode", () => {
  assert.equal(storyDraftUnlocksAuthorMode({
    status: "draft",
    source_turn_ids: Array.from({ length: AUTHOR_STORY_DRAFT_MIN_TURNS }, (_, index) => String(index)),
    prose: narrativeChapter(24),
  }), true);
  assert.equal(storyDraftUnlocksAuthorMode({
    status: "draft",
    source_turn_ids: ["only-one-scene"],
    prose: narrativeChapter(24),
  }), false);
});
