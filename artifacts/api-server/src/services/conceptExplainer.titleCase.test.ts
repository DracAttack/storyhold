import { test } from "node:test";
import assert from "node:assert/strict";
import { toConceptTitleCase } from "./conceptExplainer";

// =============================================================================
// toConceptTitleCase — unit tests
//
// Locks the acronym map, apostrophe normalisation, numeric-prefix verbatim
// pass-through, stop-word lowercasing, and existing-uppercase preservation
// rules so that a simplification of the formatter is immediately caught.
// =============================================================================

// ---------------------------------------------------------------------------
// Acronym map (ACRONYMS lookup in content-utils)
// ---------------------------------------------------------------------------

test("all-lowercase acronym is replaced with its canonical uppercase form", () => {
  assert.equal(toConceptTitleCase("covid research"), "COVID Research");
  assert.equal(toConceptTitleCase("ai policy"), "AI Policy");
  assert.equal(toConceptTitleCase("ftc investigation"), "FTC Investigation");
  assert.equal(toConceptTitleCase("dna analysis"), "DNA Analysis");
  assert.equal(toConceptTitleCase("nasa mission"), "NASA Mission");
});

test("hyphenated acronym in the map maps to its canonical form", () => {
  assert.equal(toConceptTitleCase("tnf-α signaling"), "TNF-α Signaling");
});

test("acronym at the start of the term is still uppercased", () => {
  assert.equal(toConceptTitleCase("ai"), "AI");
  assert.equal(toConceptTitleCase("ftc"), "FTC");
});

test("acronym in a trailing position is still uppercased", () => {
  assert.equal(toConceptTitleCase("regulation of ai"), "Regulation of AI");
  assert.equal(toConceptTitleCase("oversight by the ftc"), "Oversight by the FTC");
});

// ---------------------------------------------------------------------------
// Apostrophe normalisation — must happen BEFORE casing so the cased result
// contains a plain apostrophe, not a backslash or a doubled quote.
// ---------------------------------------------------------------------------

test("backslash-apostrophe is collapsed to a plain apostrophe before casing", () => {
  // The input string contains a literal backslash followed by an apostrophe.
  assert.equal(toConceptTitleCase("alzheimer\\'s disease"), "Alzheimer's Disease");
  assert.equal(toConceptTitleCase("parkinson\\'s disease"), "Parkinson's Disease");
});

test("double-apostrophe is collapsed to a single apostrophe before casing", () => {
  assert.equal(toConceptTitleCase("alzheimer''s disease"), "Alzheimer's Disease");
  assert.equal(toConceptTitleCase("hunter''s syndrome"), "Hunter's Syndrome");
});

test("plain apostrophe in a possessive is preserved unchanged", () => {
  assert.equal(toConceptTitleCase("alzheimer's disease"), "Alzheimer's Disease");
});

// ---------------------------------------------------------------------------
// Numeric-prefix tokens — returned verbatim so ordinal/hybrid tokens are
// never mangled (e.g. "19th" must not become "19Th" or "19th").
// ---------------------------------------------------------------------------

test("ordinal numeric-prefix tokens are passed through verbatim", () => {
  assert.equal(toConceptTitleCase("19th century economics"), "19th Century Economics");
  assert.equal(toConceptTitleCase("21st century skills"), "21st Century Skills");
});

test("alphanumeric hybrid token with leading digit is passed through verbatim", () => {
  assert.equal(toConceptTitleCase("3D printing"), "3D Printing");
});

// ---------------------------------------------------------------------------
// Stop-word lowercasing — short function words are lowercased mid-term but
// capitalised when they are the very first word.
// ---------------------------------------------------------------------------

test("stop words in non-initial position are lowercased", () => {
  assert.equal(toConceptTitleCase("role of ai in policy"), "Role of AI in Policy");
  assert.equal(toConceptTitleCase("rise and fall of an empire"), "Rise and Fall of an Empire");
  assert.equal(toConceptTitleCase("war on drugs"), "War on Drugs");
});

test("stop word as the first word is still capitalised", () => {
  assert.equal(toConceptTitleCase("the role of ai"), "The Role of AI");
  assert.equal(toConceptTitleCase("a guide to dna"), "A Guide to DNA");
});

// ---------------------------------------------------------------------------
// Existing-uppercase preservation — tokens whose non-first characters already
// contain an uppercase letter are left completely untouched.  This handles
// ADHD, DSM-5, U.S., and mixed-case brand names without ACRONYMS entries.
// ---------------------------------------------------------------------------

test("all-caps token not in the acronym map is preserved verbatim", () => {
  assert.equal(toConceptTitleCase("ADHD treatment"), "ADHD Treatment");
  assert.equal(toConceptTitleCase("PTSD symptoms"), "PTSD Symptoms");
});

test("mixed-case alphanumeric token with interior uppercase is preserved verbatim", () => {
  assert.equal(toConceptTitleCase("DSM-5 criteria"), "DSM-5 Criteria");
});

test("ADHD entry in ACRONYMS map returns canonical form when supplied lowercase", () => {
  // 'adhd' is in the ACRONYMS map → must map to 'ADHD', not just be
  // preserved via the uppercase-interior guard.
  assert.equal(toConceptTitleCase("adhd symptoms"), "ADHD Symptoms");
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("empty string is returned as-is", () => {
  assert.equal(toConceptTitleCase(""), "");
});

test("single-word term is capitalised correctly", () => {
  assert.equal(toConceptTitleCase("economics"), "Economics");
  assert.equal(toConceptTitleCase("covid"), "COVID");
});

test("pure punctuation / numeric tokens are left untouched", () => {
  assert.equal(toConceptTitleCase("section 230 policy"), "Section 230 Policy");
});
