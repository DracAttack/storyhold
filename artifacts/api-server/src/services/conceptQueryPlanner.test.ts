import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findQueryConcepts,
  buildExpansionTerms,
  syntheticEdgeSimilarity,
  MAX_EXPANSION_TERMS,
  SYNTHETIC_SIMILARITY_CAP,
  EXCLUDED_RELATION_TYPES,
} from "./conceptQueryPlanner";
import type { ConceptLexiconEntry } from "./conceptTagger";

// =============================================================================
// Concept-aware retrieval planner (Task #338) — pure half. Locks the
// purely-additive contract (no concept match => no behavior change) and the
// lane-separation guarantee that synthetic edge similarity can NEVER make an
// edge-linked doc look like a strong semantic hit or satisfy the grounding
// relevance floor on its own.
// =============================================================================

const lexicon: ConceptLexiconEntry[] = [
  { conceptId: "c1", term: "Cognitive Dissonance", aliases: ["dissonance theory"] },
  { conceptId: "c2", term: "Gaslighting", aliases: ["gaslight"] },
];

// --- findQueryConcepts -------------------------------------------------------

test("query mentioning no concept matches nothing (purely additive)", () => {
  assert.deepEqual(findQueryConcepts("Fed raises interest rates again", lexicon), []);
  assert.deepEqual(findQueryConcepts("", lexicon), []);
});

test("query matches by canonical term and by alias, word-boundary", () => {
  assert.deepEqual(
    findQueryConcepts("Why cognitive dissonance drives voters", lexicon).map((c) => c.conceptId),
    ["c1"],
  );
  assert.deepEqual(
    findQueryConcepts("He tried to gaslight the jury", lexicon).map((c) => c.conceptId),
    ["c2"],
  );
  // substring inside a larger word must NOT match
  assert.deepEqual(findQueryConcepts("gaslighting-adjacent egomaniacal rant", lexicon).map((c) => c.conceptId), ["c2"]);
});

// --- buildExpansionTerms -----------------------------------------------------

test("terms already in the query are skipped", () => {
  const out = buildExpansionTerms(
    "dissonance theory in politics",
    [lexicon[0]],
    ["Confirmation Bias"],
  );
  assert.deepEqual(out, ["Confirmation Bias"]);
});

test("aliases come before related terms and dedupe is case-insensitive", () => {
  const out = buildExpansionTerms(
    "cognitive dissonance article",
    [lexicon[0]],
    ["DISSONANCE THEORY", "Anchoring Bias"],
  );
  assert.deepEqual(out, ["dissonance theory", "Anchoring Bias"]);
});

test("expansion is capped at MAX_EXPANSION_TERMS", () => {
  const related = Array.from({ length: 20 }, (_, i) => `related concept ${i}`);
  const out = buildExpansionTerms("some query", [], related);
  assert.equal(out.length, MAX_EXPANSION_TERMS);
});

test("terms below the surface-form length floor are dropped", () => {
  const out = buildExpansionTerms("query", [], ["ego", "id", "mania"]);
  assert.deepEqual(out, ["mania"]);
});

// --- syntheticEdgeSimilarity — lane-separation regression --------------------

test("synthetic similarity never exceeds the cap, even at confidence 1", () => {
  assert.equal(syntheticEdgeSimilarity(1), SYNTHETIC_SIMILARITY_CAP);
  assert.equal(syntheticEdgeSimilarity(99), SYNTHETIC_SIMILARITY_CAP);
});

test("synthetic similarity stays well below a strong real semantic hit (~0.6+)", () => {
  for (const c of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(syntheticEdgeSimilarity(c) <= SYNTHETIC_SIMILARITY_CAP);
    assert.ok(syntheticEdgeSimilarity(c) < 0.6);
  }
});

test("zero/negative confidence yields the base, below the 0.15 relevance floor", () => {
  // An edge alone must never make an off-topic query look grounded.
  assert.ok(syntheticEdgeSimilarity(0) < 0.15);
  assert.equal(syntheticEdgeSimilarity(-5), syntheticEdgeSimilarity(0));
});

test("distinct_from is the excluded relation type (never expanded)", () => {
  assert.deepEqual([...EXCLUDED_RELATION_TYPES], ["distinct_from"]);
});
