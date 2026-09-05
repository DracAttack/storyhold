import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PremiumRecoveryRecordedSteps } from "../components/customer/premium-recovery-recorded-steps";
import type { PremiumRecoveryReview } from "./premiumRecoveryApi";

const source = readFileSync(new URL("../pages/admin/PremiumRecovery.tsx", import.meta.url), "utf8");
const recordedStepsSource = readFileSync(new URL("../components/customer/premium-recovery-recorded-steps.tsx", import.meta.url), "utf8");
const completeUiSource = `${source}\n${recordedStepsSource}`;

test("premium recovery describes closure without denying prior AI attempts", () => {
  assert.doesNotMatch(source, /No AI was run/iu);
  assert.match(source, /sent no additional AI request/iu);
  assert.match(source, /does not resume analysis or apply saved AI output/iu);
  assert.match(source, /does not promote saved provider output into canon/iu);
  assert.match(source, /against its original hold and any additional available account credits/iu);
  assert.match(source, /return any unused held credits/iu);
});

test("legacy aggregate recovery presents journal rows only as incomplete lower-bound context", () => {
  const legacy: PremiumRecoveryReview = {
    id: "run-1", runId: "run-1", worldId: "world-1", worldName: "Legacy World",
    status: "paused", stage: "saved boundary", progress: 42,
    createdAt: "2026-09-04T00:00:00.000Z", fingerprint: "fixture-fingerprint",
    recoveryMode: "legacy_total_attestation", canFinalize: true, blockReason: null,
    reservedCredits: 10, knownCostMicros: 12_000, receipt: null,
    steps: [{
      stepKey: "chronology:0", status: "uncertain", provider: "openrouter",
      model: "test/model", knownCostMicros: 12_000, needsDecision: false,
      dispatchedAt: null, lastRecordedAt: null,
    }],
  };
  const markup = renderToStaticMarkup(createElement(PremiumRecoveryRecordedSteps, { review: legacy }));
  assert.match(markup, /Saved Journal Context/u);
  assert.match(markup, /not a complete per-request accounting record/iu);
  assert.match(markup, /known cost is a lower bound/iu);
  assert.match(markup, /Verify the provider’s total for the entire review below/iu);
  assert.match(markup, /Saved Journal Evidence/u);
  assert.doesNotMatch(markup, /fully recorded/iu);
});

test("premium recovery keeps raw process identifiers subordinate to operator-facing labels", () => {
  assert.doesNotMatch(source, /\{stateLabel\(review\.stage\)\}/u);
  assert.match(completeUiSource, /Ready for Charge Review/u);
  assert.match(completeUiSource, /Canon Evidence Review/u);
  assert.match(completeUiSource, /World Clock Review/u);
  assert.match(completeUiSource, /Technical Reference/u);
  assert.match(completeUiSource, /Entire Legacy Review/u);
  assert.match(completeUiSource, /Original Provider and Model Were Not Reliably Recorded/u);
  assert.doesNotMatch(completeUiSource, />operator-reconciliation</u);
  assert.doesNotMatch(completeUiSource, />legacy-unattributed</u);
});

test("provider timing context is visible without exposing a request payload", () => {
  assert.match(source, /Review Started/u);
  assert.match(source, /Sent: \{formatRecoveryTimestamp\(step\.dispatchedAt\)\}/u);
  assert.match(source, /Last Saved: \{formatRecoveryTimestamp\(step\.lastRecordedAt\)\}/u);
  assert.doesNotMatch(source, /requestSnapshot|resultSnapshot|sourceText/u);
});

test("pipeline percentage is presented as position, not proof that work was saved", () => {
  assert.match(source, /Pipeline Position at Interruption/u);
  assert.doesNotMatch(source, /% of the original review was saved/iu);
});

test("both durable free-text fields explicitly prohibit secret and manuscript input", () => {
  assert.match(source, /Never paste an API key, authorization header, raw error, or manuscript text/iu);
  assert.match(source, /Do not include API keys, authorization headers, raw provider errors, credentials, or manuscript text/iu);
});

test("already-settled recovery cannot be mistaken for a new charge or refund", () => {
  assert.match(source, /Settled Accounting Ready to Close/u);
  assert.match(source, /It will not call an AI provider, charge credits, refund credits, or promote output into canon/iu);
  assert.match(source, /No new charge or refund will be calculated or applied/iu);
  assert.match(source, /original charge and refund are already settled and will not change/iu);
  assert.match(source, /Close Without Billing Changes/u);
  assert.match(source, /already-settled record it can close without moving credits/iu);
});
