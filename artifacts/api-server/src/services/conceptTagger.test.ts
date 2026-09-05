import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSurfaceFormRegex,
  tagDocumentText,
  MIN_SURFACE_FORM_LENGTH,
  type ConceptLexiconEntry,
} from "./conceptTagger";

// =============================================================================
// Deterministic source-to-concept tagger (Task #338). Pure word-boundary
// matching — no LLM, no DB. These tests lock the matching rules (length floor,
// flexible hyphen/space, boundary anchoring) and the confidence model
// (title boost + text saturation).
// =============================================================================

const entry = (conceptId: string, term: string, aliases: string[] = []): ConceptLexiconEntry => ({
  conceptId,
  term,
  aliases,
});

// --- buildSurfaceFormRegex ---------------------------------------------------

test("short single-word forms are rejected (below length floor)", () => {
  assert.equal(MIN_SURFACE_FORM_LENGTH, 4);
  assert.equal(buildSurfaceFormRegex("ego"), null);
  assert.equal(buildSurfaceFormRegex("did"), null);
  assert.notEqual(buildSurfaceFormRegex("mania"), null);
});

test("multi-word forms are exempt from the length floor", () => {
  const re = buildSurfaceFormRegex("id ego");
  assert.notEqual(re, null);
  assert.equal(re!.test("the id ego split"), true);
});

// NOTE: buildSurfaceFormRegex returns a /g regex, whose .test() is stateful
// (lastIndex). Build a fresh regex per assertion, matching production usage.
test("hyphen and space are interchangeable inside a form", () => {
  assert.equal(buildSurfaceFormRegex("self esteem")!.test("her self-esteem improved"), true);
  assert.equal(buildSurfaceFormRegex("self esteem")!.test("her self esteem improved"), true);
});

test("word boundaries: no substring matches inside larger words", () => {
  assert.equal(buildSurfaceFormRegex("mania")!.test("kleptomania is different"), false);
  assert.equal(buildSurfaceFormRegex("mania")!.test("egomaniacal"), false);
  assert.equal(buildSurfaceFormRegex("mania")!.test("a mania for detail"), true);
});

test("matching is case-insensitive", () => {
  const re = buildSurfaceFormRegex("Cognitive Dissonance")!;
  assert.equal(re.test("COGNITIVE DISSONANCE in voters"), true);
});

test("regex metacharacters in terms are escaped", () => {
  const re = buildSurfaceFormRegex("catch-22 (dilemma)")!;
  assert.equal(re.test("a real catch-22 (dilemma) here"), true);
});

// --- tagDocumentText ---------------------------------------------------------

const lexicon: ConceptLexiconEntry[] = [
  entry("c-dissonance", "Cognitive Dissonance", ["dissonance theory"]),
  entry("c-gaslight", "Gaslighting", ["gaslight"]),
  entry("c-anchor", "Anchoring Bias", ["anchoring effect"]),
];

test("empty document produces no matches", () => {
  assert.deepEqual(tagDocumentText({ title: "", text: "" }, lexicon), []);
  assert.deepEqual(tagDocumentText({ title: null, text: undefined }, lexicon), []);
});

test("no concept mentioned => no matches (purely additive)", () => {
  const out = tagDocumentText(
    { title: "Fed raises rates", text: "The central bank hiked interest rates again." },
    lexicon,
  );
  assert.deepEqual(out, []);
});

test("title hit alone earns exactly the title boost", () => {
  const out = tagDocumentText(
    { title: "Cognitive dissonance and elections", text: "No mention in the body." },
    lexicon,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].conceptId, "c-dissonance");
  assert.equal(out[0].confidence, 0.4);
  assert.equal(out[0].matchedSections[0].field, "title");
});

test("text occurrences saturate at 5 (title+saturated text = 1.0)", () => {
  const body = Array(8).fill("gaslighting is discussed here.").join(" ");
  const out = tagDocumentText({ title: "The rise of gaslighting", text: body }, lexicon);
  assert.equal(out.length, 1);
  assert.equal(out[0].confidence, 1);
});

test("one body mention scores below a title mention", () => {
  const out = tagDocumentText(
    { title: "Unrelated headline", text: "Researchers described gaslighting once." },
    lexicon,
  );
  assert.equal(out.length, 1);
  // 0.6 * (1/5) = 0.12 — a single body hit is a weak signal
  assert.ok(Math.abs(out[0].confidence - 0.12) < 1e-9);
});

test("aliases match and multiple concepts sort by confidence then id", () => {
  const out = tagDocumentText(
    {
      title: "Anchoring effect in salary talks",
      text: "The anchoring effect shapes offers. Dissonance theory explains the rest.",
    },
    lexicon,
  );
  assert.deepEqual(
    out.map((m) => m.conceptId),
    ["c-anchor", "c-dissonance"],
  );
  assert.ok(out[0].confidence > out[1].confidence);
});

test("matched sections carry term, count, and a bounded snippet", () => {
  const text = `${"x".repeat(300)} gaslighting ${"y".repeat(300)}`;
  const out = tagDocumentText({ title: null, text }, lexicon);
  const section = out[0].matchedSections[0];
  assert.equal(section.field, "text");
  assert.equal(section.term.toLowerCase(), "gaslighting");
  assert.equal(section.count >= 1, true);
  assert.ok(section.snippet.length <= 170);
  assert.ok(section.snippet.includes("gaslighting"));
});

test("deterministic: same inputs give identical output", () => {
  const doc = { title: "Gaslighting at work", text: "Cognitive dissonance and gaslight tactics." };
  assert.deepEqual(tagDocumentText(doc, lexicon), tagDocumentText(doc, lexicon));
});
