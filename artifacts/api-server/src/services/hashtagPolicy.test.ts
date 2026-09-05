import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeHashtagTokens,
  ensureLearningTag,
  LEARNING_TAGS,
} from "./hashtagPolicy";

test("established multi-word learning tags are never split", () => {
  const out = sanitizeHashtagTokens([
    "TodayILearned",
    "SmarterEveryDay",
    "TodayYearsOld",
    "DidYouKnow",
  ]);
  assert.deepEqual(out, ["TodayILearned", "SmarterEveryDay", "TodayYearsOld", "DidYouKnow"]);
});

test("made-up compound tags still split; banned brand tags still dropped", () => {
  const out = sanitizeHashtagTokens([
    "RelationshipsCommunication",
    "TermOfTheDay",
    "MentalHealth",
  ]);
  assert.deepEqual(out, ["Relationships", "Communication", "MentalHealth"]);
});

test("ensureLearningTag leaves a compliant list untouched", () => {
  const tags = ["Gaslighting", "Psychology", "FunFact"];
  assert.deepEqual(ensureLearningTag(tags, { maxTags: 8, seed: "gaslighting" }), tags);
});

test("ensureLearningTag appends a learning tag when missing", () => {
  const out = ensureLearningTag(["Gaslighting", "Psychology"], { maxTags: 8, seed: "gaslighting" });
  assert.equal(out.length, 3);
  assert.equal(out[0], "Gaslighting");
  assert.ok((LEARNING_TAGS as readonly string[]).includes(out[2]!));
});

test("ensureLearningTag replaces the last tag when already at cap (term tag survives)", () => {
  const out = ensureLearningTag(["Gaslighting", "Psychology", "Manipulation"], {
    maxTags: 3,
    seed: "gaslighting",
  });
  assert.equal(out.length, 3);
  assert.equal(out[0], "Gaslighting");
  assert.equal(out[1], "Psychology");
  assert.ok((LEARNING_TAGS as readonly string[]).includes(out[2]!));
});

test("ensureLearningTag is deterministic per seed", () => {
  const a = ensureLearningTag(["Alpha"], { maxTags: 8, seed: "some-term" });
  const b = ensureLearningTag(["Alpha"], { maxTags: 8, seed: "some-term" });
  assert.deepEqual(a, b);
});
