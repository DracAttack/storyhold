import assert from "node:assert/strict";
import test from "node:test";
import { entityReviewPublicError } from "./entityReview";
import { EntityReviewJournalError } from "./entityReviewJournal";
import { EntityReviewAccountingError } from "./entityReviewAccounting";
import { PremiumGraphJournalError } from "./premiumGraphJournal";

test("graph validation errors hide internals and do not promise no paid dispatch", () => {
  for (const error of [
    new Error("Dossier graph verification: newFindings must contain at most 4 discoveries, without truncation."),
    new Error("Premium graph verification: response requestFingerprint does not match the source request."),
  ]) {
    const message = entityReviewPublicError(error);
    assert.match(message, /could not verify this review's connections and rules/iu);
    assert.doesNotMatch(message, /newFindings|requestFingerprint|No new AI request was sent|no credits|not charged/iu);
  }
});

test("only predispatch graph inventory overflow directs the owner to world review", () => {
  const message = entityReviewPublicError(new Error("Dossier graph verification: the review exceeds 12 distinct graph candidates; narrow the review before dispatch."));
  assert.match(message, /Use the world review/u);
  assert.match(message, /No new AI request was sent/u);
});

test("graph application errors retain recovery without exposing proof storage", () => {
  const message = entityReviewPublicError(new PremiumGraphJournalError("GRAPH_RECEIPT_MISMATCH", "verification_snapshot private fingerprint differs"));
  assert.match(message, /saved result is retained/u);
  assert.doesNotMatch(message, /verification_snapshot|fingerprint|no credits|not charged/iu);
});

test("private verification protocol errors never become customer-facing diagnostics", () => {
  for (const error of [
    new Error("Dossier stat verification: statVerifications must contain exactly two groups."),
    new Error("Premium stat verification: request fingerprint does not match."),
    Object.assign(new Error("Stored receipt input checksum mismatch"), { name: "EntityStatJournalError" }),
    Object.assign(new Error("Unexpected proposal_id"), { name: "AnalysisContractValidationError" }),
    new Error("Provider rejected statVerifications field"),
  ]) {
    const message = entityReviewPublicError(error);
    assert.match(message, /could not verify the ability estimates/u);
    assert.doesNotMatch(message, /statVerifications|fingerprint|checksum|proposal_id/u);
    assert.doesNotMatch(message, /no credits|not charged/iu);
  }
});

test("existing-prose audit errors hide private protocol and never invent a refund or a free retry", () => {
  const message = entityReviewPublicError(new Error("Existing dossier prose review: requestFingerprint and itemId do not match the frozen inventory."));
  assert.doesNotMatch(message, /requestFingerprint|itemId|frozen inventory|Existing dossier prose review:/u);
  assert.doesNotMatch(message, /no credits|not charged|refunded|free retry/iu);
  assert.match(message, /could not verify|saved result|review/u);
});

test("predispatch source-search errors hide private slot diagnostics and explain that no call began", () => {
  for (const prefix of ["Dossier prose retrieval:", "Dossier existing prose retrieval:"]) {
    const message = entityReviewPublicError(new Error(`${prefix} itemId and source provenance mismatch.`));
    assert.match(message, /additional manuscript passages/u);
    assert.match(message, /no new AI request was sent/u);
    assert.doesNotMatch(message, /itemId|provenance|refunded|free retry/u);
  }
});

test("actionable source and target changes retain their plain-language explanation", () => {
  const message = "The manuscript changed during this review. No dossier changes were saved.";
  assert.equal(entityReviewPublicError(new Error(message)), message);
  assert.equal(entityReviewPublicError(null), "The dossier review failed. No generated dossier update was applied.");
});

test("paid-call journal errors explain saved-outcome recovery without exposing private diagnostics", () => {
  for (const error of [
    new EntityReviewJournalError("JOURNAL_PERSISTENCE", "entity_review_ai_calls UPDATE failed; request_fingerprint=private-fixture-hash"),
    new EntityReviewJournalError("OUTCOME_UNRESOLVED", "upstream body: private provider details; dispatched request 123"),
    new EntityReviewJournalError("REQUEST_MISMATCH", "context_snapshot differs for entity_id and reservation_id"),
  ]) {
    const message = entityReviewPublicError(error);
    assert.match(message, /saved outcome/iu);
    assert.match(message, /No new paid request will start automatically/u);
    assert.doesNotMatch(message, /entity_review_ai_calls|UPDATE|request_fingerprint|private-fixture-hash|upstream|context_snapshot|entity_id|reservation_id/u);
    assert.doesNotMatch(message, /no credits|not charged|refunded|free/iu);
  }
});

test("accounting recovery errors do not disclose ledger details or promise unknown refunds", () => {
  for (const error of [
    new EntityReviewAccountingError("DOSSIER_ACCOUNTING_UNCERTAIN", "pricingKnown=false; billable_attempts missing token usage"),
    new EntityReviewAccountingError("DOSSIER_ACCOUNTING_DUPLICATE", "ai_usage_ledger request_id=private-review-hash already exists"),
    new EntityReviewAccountingError("DOSSIER_ACCOUNTING_FUNDING", "credit_reservations has mismatched player_id and usage payload"),
  ]) {
    const message = entityReviewPublicError(error);
    assert.match(message, /saved outcome/iu);
    assert.match(message, /No new paid request will start automatically/u);
    assert.doesNotMatch(message, /pricingKnown|billable_attempts|ai_usage_ledger|request_id|private-review-hash|credit_reservations|player_id/u);
    assert.doesNotMatch(message, /no credits|not charged|refunded|free/iu);
  }
});
