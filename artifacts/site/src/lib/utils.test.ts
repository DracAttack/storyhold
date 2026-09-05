import { test } from "node:test";
import assert from "node:assert/strict";
import { chicagoTitleChildren, toArticleTitleCase } from "./utils";

// ---------------------------------------------------------------------------
// Basic title-casing
// ---------------------------------------------------------------------------

test("first word is always capitalised", () => {
  assert.equal(toArticleTitleCase("the quick brown fox"), "The Quick Brown Fox");
});

test("last word is always capitalised even when a stop word", () => {
  assert.equal(toArticleTitleCase("What Are We For"), "What Are We For");
});

test("stop words are lowercased mid-title", () => {
  assert.equal(
    toArticleTitleCase("War and Peace in the Middle"),
    "War and Peace in the Middle",
  );
});

// ---------------------------------------------------------------------------
// Sentence-restart: colon, em-dash (pre-existing), period, ?, !
// ---------------------------------------------------------------------------

test("word after a colon is capitalised", () => {
  assert.equal(
    toArticleTitleCase("Science: the next frontier"),
    "Science: The Next Frontier",
  );
});

test("word after an em-dash is capitalised", () => {
  assert.equal(
    toArticleTitleCase("Gut Health\u2014the real story"),
    "Gut Health\u2014The Real Story",
  );
});

test("word after a period is capitalised even when a stop word", () => {
  // Observed regression: "the Food Web…" kept lowercase after a period.
  assert.equal(
    toArticleTitleCase("Life. the Food Web and Beyond"),
    "Life. The Food Web and Beyond",
  );
});

test("word after a question mark is capitalised", () => {
  assert.equal(
    toArticleTitleCase("Are You Ready? so Why Wait"),
    "Are You Ready? So Why Wait",
  );
});

test("word after an exclamation mark is capitalised", () => {
  assert.equal(
    toArticleTitleCase("Incredible! the secrets inside"),
    "Incredible! The Secrets Inside",
  );
});

// ---------------------------------------------------------------------------
// Numeric-prefix tokens — must never mangle the letter suffix
// ---------------------------------------------------------------------------

test("1950s is returned verbatim — not 1950S", () => {
  assert.equal(
    toArticleTitleCase("the 1950s sky survey"),
    "The 1950s Sky Survey",
  );
});

test("3D token is returned verbatim", () => {
  // "a" is the first word → always capitalised; "3D" has non-letter prefix → verbatim
  assert.equal(toArticleTitleCase("a 3D model"), "A 3D Model");
});

// ---------------------------------------------------------------------------
// Acronym allowlist — canonical casing preserved even when stored lowercase
// ---------------------------------------------------------------------------

test("FTC preserved when stored uppercase (rule 5 / existing uppercase)", () => {
  assert.equal(
    toArticleTitleCase("FTC cracks down on big tech"),
    "FTC Cracks Down on Big Tech",
  );
});

test("ftc restored to FTC via allowlist when stored lowercase", () => {
  assert.equal(
    toArticleTitleCase("ftc cracks down on big tech"),
    "FTC Cracks Down on Big Tech",
  );
});

test("covid restored to COVID via allowlist", () => {
  assert.equal(
    toArticleTitleCase("how covid changed everything"),
    "How COVID Changed Everything",
  );
});

test("ai restored to AI via allowlist", () => {
  assert.equal(
    toArticleTitleCase("what ai means for the future"),
    "What AI Means for the Future",
  );
});

test("uk restored to UK via allowlist", () => {
  assert.equal(
    toArticleTitleCase("uk politics explained"),
    "UK Politics Explained",
  );
});

test("DNA preserved via existing-uppercase rule (no allowlist entry needed)", () => {
  assert.equal(
    toArticleTitleCase("DNA and the human genome"),
    "DNA and the Human Genome",
  );
});

test("TNF-α preserved via allowlist even when stored lowercase", () => {
  // α is a non-ASCII Unicode letter and must NOT be stripped by the tail-strip
  assert.equal(
    toArticleTitleCase("tnf-α and ibd"),
    "TNF-α and IBD",
  );
});

// ---------------------------------------------------------------------------
// Apostrophe normalisation
// ---------------------------------------------------------------------------

test("plain apostrophe round-trips unchanged", () => {
  assert.equal(
    toArticleTitleCase("Polyamory's new rules"),
    "Polyamory's New Rules",
  );
});

test("backslash-apostrophe is collapsed to plain apostrophe", () => {
  assert.equal(
    toArticleTitleCase("Polyamory\\'s new rules"),
    "Polyamory's New Rules",
  );
});

test("double-apostrophe is collapsed to single apostrophe", () => {
  assert.equal(
    toArticleTitleCase("Polyamory''s new rules"),
    "Polyamory's New Rules",
  );
});

// ---------------------------------------------------------------------------
// Punctuation-wrapped words — leading quotes/parens must not block casing
// ---------------------------------------------------------------------------

test("quoted word after period restart is capitalised inside the quote", () => {
  // Regression: lead='"' has no digit → must still capitalise the inner word
  assert.equal(
    toArticleTitleCase('Life. "the food web" and beyond'),
    'Life. "The Food Web" and Beyond',
  );
});

test("parenthesised word is capitalised normally", () => {
  assert.equal(
    toArticleTitleCase("(the rise of ai) explained"),
    "(The Rise of AI) Explained",
  );
});

test("opening quote is preserved and inner stop word is lowercased mid-title", () => {
  // '"and' mid-title: lead='"', word='and' → stop word → '"and' (lowercased)
  assert.equal(
    toArticleTitleCase('Science "and the natural world'),
    'Science "and the Natural World',
  );
});

// ---------------------------------------------------------------------------
// Mixed scenarios
// ---------------------------------------------------------------------------

test("acronym after colon subtitle restart", () => {
  assert.equal(
    toArticleTitleCase("Health: covid and the gut"),
    "Health: COVID and the Gut",
  );
});

test("existing uppercase tokens (ADHD, DSM-5) left untouched", () => {
  assert.equal(
    toArticleTitleCase("living with ADHD and the DSM-5 criteria"),
    "Living with ADHD and the DSM-5 Criteria",
  );
});

test("empty string returns empty string", () => {
  assert.equal(toArticleTitleCase(""), "");
});

test("Storyhold interface copy preserves product acronyms", () => {
  assert.equal(
    toArticleTitleCase("review this dossier with ai and an llm"),
    "Review This Dossier with AI and an LLM",
  );
});

test("intake activity uses headline capitalization", () => {
  assert.equal(
    toArticleTitleCase("looking deeper into Alec and the Co-op"),
    "Looking Deeper into Alec and the Co-op",
  );
});

test("adjacent JSX fragments are title-cased as one phrase", () => {
  assert.deepEqual(
    chicagoTitleChildren([57, " character", "s"]),
    ["57 Characters"],
  );
});
