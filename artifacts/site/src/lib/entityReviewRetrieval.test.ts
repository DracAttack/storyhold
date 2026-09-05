import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { entityReviewRetrievalNotice } from "./entityReviewRetrieval";
import type { EntityReviewRetrievalExpansion } from "./storyholdApi";

const empty: EntityReviewRetrievalExpansion = { searchedItems: 0, addedPassages: 0, noMatchItems: 0,
  budgetDeferredItems: 0, alreadyCoveredItems: 0, skippedReviews: 0 };
const notice = (report: Partial<EntityReviewRetrievalExpansion>) => entityReviewRetrievalNotice({
  executionMode: "connected", retrievalExpansion: { ...empty, ...report },
});

test("legacy, local, saved-resume and empty reports do not claim a new completed search", () => {
  assert.equal(entityReviewRetrievalNotice(null), null);
  assert.equal(entityReviewRetrievalNotice({ executionMode: "connected" }), null);
  assert.equal(notice({}), null);
  for (const executionMode of ["local_qwen", "browser_qwen"] as const) assert.equal(entityReviewRetrievalNotice({ executionMode,
    retrievalExpansion: { ...empty, searchedItems: 3, addedPassages: 2 } }), null);
  assert.equal(entityReviewRetrievalNotice({ executionMode: "connected", resume: true,
    retrievalExpansion: { ...empty, searchedItems: 3, addedPassages: 2 } }), null);
});

test("fresh additional passages are explicitly leads rather than verified conclusions", () => {
  const result = notice({ searchedItems: 4, addedPassages: 2, alreadyCoveredItems: 1 })!;
  assert.equal(result.heading, "Found 2 Additional Passages for Unresolved Details.");
  assert.match(result.detail, /search leads, not verified facts/);
  assert.match(result.detail, /1 Detail already has passages selected/);
  assert.equal(notice({ searchedItems: 1, addedPassages: 1 })!.heading, "Found 1 Additional Passage for Unresolved Details.");
  assert.doesNotMatch(JSON.stringify(result), /(?:fully understood|all resolved|canon-verified|fingerprint|provider|model)/i);
});

test("partial searches retain ambiguous, unmatched and deferred counts without implying exhaustive coverage", () => {
  const result = notice({ searchedItems: 5, addedPassages: 1, noMatchItems: 2, budgetDeferredItems: 3, skippedReviews: 1 })!;
  assert.match(result.detail, /No new matches for 2 details; they still need checking/);
  assert.match(result.detail, /Matching passages for 3 details could not all be included/);
  assert.doesNotMatch(result.detail, /left to search|search limit/);
  assert.match(result.detail, /1 Earlier review could not be used/);
  assert.doesNotMatch(result.detail, /(?:all details|complete|5 details remain)/i, "counts must not be added as if necessarily disjoint");
  assert.equal(notice({ searchedItems: 3, noMatchItems: 3 })!.heading, "No Additional Passages Found.");
  assert.match(notice({ budgetDeferredItems: 2 })!.heading, /Matching Passages Could Not Be Included/);
  assert.match(notice({ skippedReviews: 1 })!.detail, /still need more evidence/);
});

test("already selected passages and zero new matches never mean the claims are established", () => {
  const result = notice({ searchedItems: 4, alreadyCoveredItems: 4 })!;
  assert.equal(result.heading, "4 Details Already Have Selected Passages.");
  assert.match(result.detail, /not verified facts/);
  assert.match(result.detail, /may still need more evidence/);
  assert.equal(notice({ searchedItems: 1 })!.heading, "No Additional Passages Found.");
  assert.match(notice({ searchedItems: 1 })!.detail, /Unresolved details may still need more evidence/,
    "a match from an earlier review is not automatically part of today's selection");
  for (const addedPassages of [-1, 0.2, NaN, Infinity]) assert.equal(notice({ searchedItems: 1, addedPassages }), null);
});

test("the existing passage preview renders the note without a new panel or browser-side search", () => {
  const text = readFileSync(new URL("../components/customer/entity-ai-review-card.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("card.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches: ts.JsxElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "p"
      && node.getText(source).includes("retrievalNotice.heading")) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source); assert.equal(matches.length, 1);
  const paragraph = matches[0]!;
  assert.ok(paragraph.getText(source).includes("retrievalNotice.detail"));
  let parent: ts.Node | undefined = paragraph.parent;
  while (parent && !(ts.isJsxElement(parent) && parent.openingElement.tagName.getText(source) === "details")) parent = parent.parent;
  assert.ok(parent?.getText(source).includes("quote.selectedPassages.map"), "the note stays within the existing source preview");
  assert.match(text, /const retrievalNotice = entityReviewRetrievalNotice\(quote\)/);
  assert.match(text, /if \(!quote\.resume && \(browserLorekeeperIsEnabled\(\) \|\| quote\.executionMode === "browser_qwen"\)\)/,
    "saved-resume still bypasses browser assistance");
  const helper = readFileSync(new URL("./entityReviewRetrieval.ts", import.meta.url), "utf8");
  assert.doesNotMatch(helper, /\b(?:fetch|useEffect|runBrowserDossierAssist|inspectBrowserLorekeeper)\s*\(/);
});
