import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DossierEvidence } from "../components/customer/dossier-evidence";
import {
  dossierEvidenceCounts,
  dossierEvidenceFieldLabel,
  dossierEvidenceSourceLabel,
  dossierEvidenceStatusLabel,
} from "./dossierEvidence";
import type { DossierProseReview } from "./storyholdApi";

const review: DossierProseReview = {
  fields: [
    { field: "summary", status: "verified", verifiedItems: 1, totalItems: 1, items: [
      { text: "Mira guards the bridge.", status: "verified", evidence: [{ chunkId: "private-chunk", sourceId: "private-source", quote: "Mira said, <hold the bridge>.\nNobody leaves." }], confidence: 0.96 },
    ] },
    { field: "history", status: "partial", verifiedItems: 1, totalItems: 2, items: [
      { text: "She crossed the river.", status: "verified", evidence: [{ chunkId: "other-private-chunk", sourceId: "private-source", quote: "Mira crossed the river." }] },
      { text: "She may have returned.", status: "not_reviewed", evidence: [] },
    ] },
    { field: "aliases", status: "author_controlled", verifiedItems: 0, totalItems: 1, items: [
      { text: "Riverkeeper", status: "author_controlled", evidence: [] },
    ] },
  ],
};

test("section labels are human-readable without exposing internal field identifiers", () => {
  assert.equal(dossierEvidenceFieldLabel("moralSystem"), "Values and Beliefs");
  assert.equal(dossierEvidenceFieldLabel("physicalCharacteristics"), "Appearance");
  assert.equal(dossierEvidenceFieldLabel("dossier.some_private_key"), "Other Details");
  assert.equal(dossierEvidenceStatusLabel("not_reviewed"), "Not Yet Checked");
  assert.equal(dossierEvidenceStatusLabel("author_controlled"), "Author-Controlled");
});

test("checked counts retain partial, unchecked and author-controlled items without blanket verification", () => {
  assert.deepEqual(dossierEvidenceCounts(review), { checked: 2, reviewed: 2, total: 4 });
  assert.deepEqual(dossierEvidenceCounts({ fields: [] }), { checked: 0, reviewed: 0, total: 0 });
});

test("source labels use manuscript titles or a neutral label, never raw identifiers", () => {
  assert.equal(dossierEvidenceSourceLabel("private-source"), "Source Passage");
  assert.equal(dossierEvidenceSourceLabel("private-source", [{ id: "private-source", title: "The River, Chapter 2" }]), "The River, Chapter 2");
});

test("evidence panel is collapsed, preserves exact quotes and exposes only public reader-facing text", () => {
  const html = renderToStaticMarkup(createElement(DossierEvidence, { review }));
  assert.match(html, /Evidence by Section/);
  assert.match(html, /2 of 4 Items Reviewed/);
  assert.match(html, /Partly Checked/);
  assert.match(html, /Author-Controlled/);
  assert.match(html, /no saved item-level check, not that the detail is wrong/);
  assert.match(html, /Mira said, &lt;hold the bridge&gt;\.\nNobody leaves\./);
  assert.doesNotMatch(html, /private-source|private-chunk|0\.96|<details[^>]*\sopen(?:\s|=|>)/);
});

test("unavailable evidence does not become an unverified or verified judgment", () => {
  const failed = renderToStaticMarkup(createElement(DossierEvidence, { review: null, error: true }));
  assert.match(failed, /Section evidence could not be loaded/);
  assert.doesNotMatch(failed, /0 of 0|Items Reviewed/);
  const pending = renderToStaticMarkup(createElement(DossierEvidence, { review: null, loading: true }));
  assert.match(pending, /Loading section evidence/);
  assert.doesNotMatch(pending, /could not be loaded/);
});

test("existing-text audit counts include completed concerns without implying canonical approval", () => {
  const audited: DossierProseReview = { fields: [{ field: "traits", status: "needs_attention", verifiedItems: 0, totalItems: 3,
    reviewedItems: 3, sourceCheckedItems: 1, items: [
      { text: "Patient", status: "supported", evidence: [], reviewBasis: "existing_text_audit" },
      { text: "Fearless", status: "needs_attention", evidence: [], reviewBasis: "existing_text_audit", explanation: "The scene shows fear, not fearlessness." },
      { text: "Former soldier", status: "needs_evidence", evidence: [], reviewBasis: "existing_text_audit", retrievalRequests: ["Check the earlier enlistment scene."] },
    ] }] };
  assert.deepEqual(dossierEvidenceCounts(audited), { checked: 1, reviewed: 3, total: 3 });
  const html = renderToStaticMarkup(createElement(DossierEvidence, { review: audited }));
  assert.match(html, /3 of 3 Items Reviewed/);
  assert.match(html, /Source-Supported/); assert.match(html, /Needs Attention/); assert.match(html, /Needs More Evidence/);
  assert.match(html, /not a change to your canon/); assert.match(html, /The text has not been deleted or rewritten/);
  assert.match(html, /The scene shows fear/); assert.match(html, /Check the earlier enlistment scene/);
  assert.doesNotMatch(html, /3 of 3[^<]*(?:Verified|Source-Checked)/);
});

test("long evidence lists have discoverable show-more and show-all controls without shortening visible items", () => {
  const fullText = "Full statement. ".repeat(120);
  const many: DossierProseReview = { fields: [{ field: "history", status: "not_reviewed", verifiedItems: 0, totalItems: 37,
    items: Array.from({ length: 37 }, (_, index) => ({ text: `${index}: ${fullText}`, status: "not_reviewed", evidence: [] })),
  }] };
  const html = renderToStaticMarkup(createElement(DossierEvidence, { review: many }));
  assert.match(html, /Showing 8 of 37/);
  assert.match(html, /Show More/);
  assert.match(html, /Show All/);
  assert.ok(html.includes(`0: ${fullText}`));
});
