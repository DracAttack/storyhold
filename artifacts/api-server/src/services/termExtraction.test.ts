import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCandidateTerms } from "./termExtraction";

test("extracts multi-word proper nouns with their paragraph indexes", () => {
  const terms = extractCandidateTerms([
    "Researchers at the University of Michigan ran a decade-long study.",
    "Nothing relevant here, just plain prose about feelings.",
    "The University of Michigan team later replicated the result.",
  ]);
  const um = terms.find((t) => t.term.toLowerCase() === "university of michigan");
  assert.ok(um, `expected University of Michigan in ${JSON.stringify(terms)}`);
  assert.deepEqual(um.paragraphIndexes, [0, 2]);
});

test("drops leading stopword from a sentence-start run", () => {
  const terms = extractCandidateTerms(["The Federal Reserve raised rates again."]);
  assert.ok(terms.some((t) => t.term === "Federal Reserve"));
  assert.ok(!terms.some((t) => t.term.startsWith("The ")));
});

test("captures acronyms and mixed-case technical tokens", () => {
  const terms = extractCandidateTerms([
    "NASA confirmed the finding using fMRI scans on volunteers.",
  ]);
  assert.ok(terms.some((t) => t.term === "NASA"));
  assert.ok(terms.some((t) => t.term === "fMRI"));
});

test("blocklists generic acronyms and stopword singles", () => {
  const terms = extractCandidateTerms([
    "The CEO watched TV in the US while reading a PDF.",
  ]);
  assert.ok(!terms.some((t) => ["CEO", "TV", "US", "PDF"].includes(t.term)));
});

test("captures quoted phrases", () => {
  const terms = extractCandidateTerms([
    'Psychologists call this the “illusion of explanatory depth” effect.',
  ]);
  assert.ok(terms.some((t) => t.term.toLowerCase() === "illusion of explanatory depth"));
});

test("ignores markdown link URLs but keeps anchor text", () => {
  const terms = extractCandidateTerms([
    "A [Stanford University](https://stanford.edu/study) team disagreed.",
  ]);
  assert.ok(terms.some((t) => t.term === "Stanford University"));
  assert.ok(!terms.some((t) => t.term.includes("stanford.edu")));
});

test("does not capture ordinary sentence-start words as terms", () => {
  const terms = extractCandidateTerms([
    "Imagine walking into a room. Consider what happens next. Nothing does.",
  ]);
  assert.equal(terms.length, 0);
});

test("depth bonus ranks late-article terms above equally common early ones", () => {
  const paras = [
    "Alpha Institute appears early.",
    "filler", "filler", "filler", "filler", "filler",
    "Omega Institute appears late in the piece.",
  ];
  const terms = extractCandidateTerms(paras);
  const alpha = terms.find((t) => t.term === "Alpha Institute");
  const omega = terms.find((t) => t.term === "Omega Institute");
  assert.ok(alpha && omega);
  assert.ok(omega.score > alpha.score, `omega ${omega.score} should outrank alpha ${alpha.score}`);
});

test("caps results at max and returns highest-scored first", () => {
  const paras = Array.from({ length: 12 }, (_, i) => {
    const letter = String.fromCharCode(65 + i);
    return `The Body${letter} Institute studied item ${letter.toLowerCase()}.`;
  });
  const terms = extractCandidateTerms(paras, { max: 5 });
  assert.equal(terms.length, 5);
  for (let i = 1; i < terms.length; i++) {
    assert.ok(terms[i - 1]!.score >= terms[i]!.score);
  }
});

test("dedupes case-insensitively and counts occurrences", () => {
  const terms = extractCandidateTerms([
    "Quantum Darwinism is odd. QUANTUM DARWINISM is not a stopword.",
    "Later, quantum Darwinism again.",
  ]);
  const matches = terms.filter((t) => t.term.toLowerCase() === "quantum darwinism");
  assert.equal(matches.length, 1);
});
