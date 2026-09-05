import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRecoveryInput, containsRecoveryCredential, finalizePremiumRecoveryRun, formatRecoveryCost, formatRecoveryTimestamp,
  getPremiumRecoveryRun, isPremiumRecoveryOperator, listPremiumRecoveryRuns,
  recoverySettlementCost, usdToMicros, type PremiumRecoveryDraft, type PremiumRecoveryReview,
} from "./premiumRecoveryApi";

const review: PremiumRecoveryReview = {
  id: "run-1", runId: "run-1", worldId: "world-1", worldName: "Test World",
  status: "paused", stage: "verification", progress: 30, createdAt: "2026-09-03T23:58:00.000Z", fingerprint: "fingerprint-1",
  canFinalize: true, blockReason: null, reservedCredits: 50, knownCostMicros: 100,
  steps: [
    { stepKey: "known", status: "completed", provider: "provider", model: "model", knownCostMicros: 100, needsDecision: false, dispatchedAt: "2026-09-04T00:00:00.000Z", lastRecordedAt: "2026-09-04T00:01:00.000Z" },
    { stepKey: "uncertain", status: "running", provider: "provider", model: "model", knownCostMicros: null, needsDecision: true, dispatchedAt: "2026-09-04T00:02:00.000Z", lastRecordedAt: "2026-09-04T00:03:00.000Z" },
  ],
  receipt: null,
};
const note = "Verified provider billing records.";
const noCharge: PremiumRecoveryDraft = { outcome: "no_charge", usd: "", providerReference: "invoice-123" };

test("premium recovery allows only owner/admin, not creator or customer", () => {
  for (const role of ["owner", "admin"]) assert.equal(isPremiumRecoveryOperator(role), true);
  for (const role of [null, undefined, "", "creator", "customer", "Owner"]) assert.equal(isPremiumRecoveryOperator(role), false);
});

test("USD amounts are parsed exactly to six-decimal micros", () => {
  for (const [input, expected] of [
    ["0", 0], ["0.000001", 1], ["1.234567", 1234567], [" 12.01 ", 12010000],
    ["0003.10", 3100000], ["9007199254.740991", Number.MAX_SAFE_INTEGER],
  ] as const) assert.equal(usdToMicros(input), expected, input);
  for (const input of ["", " ", "-1", "+1", "1e3", "Infinity", "NaN", "1,000", ".50", "1.", "0.0000001", "9007199254.740992", "99999999999999999999999"]) {
    assert.equal(usdToMicros(input), null, input);
  }
});

test("cost formatting preserves all micros and does not turn unknown usage into zero", () => {
  assert.equal(formatRecoveryCost(null), "Unknown");
  assert.equal(formatRecoveryCost(0), "$0.000000");
  assert.equal(formatRecoveryCost(1234567), "$1.234567");
  assert.equal(formatRecoveryCost(Number.MAX_SAFE_INTEGER), "$9007199254.740991");
});

test("recovery timestamps remain explicit when old timing data is unavailable", () => {
  assert.equal(formatRecoveryTimestamp(null), "Not Recorded");
  assert.equal(formatRecoveryTimestamp("not-a-date"), "Not Recorded");
  const timestamp = "2026-09-04T00:00:00.000Z";
  assert.equal(formatRecoveryTimestamp(timestamp), new Date(timestamp).toLocaleString());
});

test("unknown steps require an explicit outcome, reference, note, and provider confirmation", () => {
  assert.match(buildRecoveryInput(review, {}, note, true).error!, /Choose an outcome/);
  assert.match(buildRecoveryInput(review, { uncertain: noCharge }, "short", true).error!, /audit note/);
  assert.match(buildRecoveryInput(review, { uncertain: noCharge }, "x".repeat(2001), true).error!, /audit note/);
  assert.match(buildRecoveryInput(review, { uncertain: noCharge }, note, false).error!, /Confirm/);
  assert.match(buildRecoveryInput(review, { uncertain: { ...noCharge, providerReference: "abc" } }, note, true).error!, /provider reference/);
  assert.match(buildRecoveryInput(review, { uncertain: { ...noCharge, providerReference: "x".repeat(301) } }, note, true).error!, /provider reference/);
  assert.match(buildRecoveryInput(review, { uncertain: { ...noCharge, outcome: "charged", usd: "" } }, note, true).error!, /USD amount/);
  assert.match(buildRecoveryInput(review, { uncertain: { ...noCharge, outcome: "charged", usd: "0.000000" } }, note, true).error!, /positive USD/);
});

test("credential-like text is rejected before it can enter a recovery receipt", () => {
  for (const secret of [
    "Bearer verylongauthorizationtoken123456",
    "sk-or-v1-examplecredentialvalue1234567890",
    "sk-ant-api03-abcdefghijklmnop123456",
    "OPENROUTER_API_KEY=not-a-real-key-but-still-private",
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
  ]) assert.equal(containsRecoveryCredential(secret), true, secret);
  for (const safe of ["req_1234567890", "invoice-2026-09-04", "Checked the provider billing dashboard."]) {
    assert.equal(containsRecoveryCredential(safe), false, safe);
  }
  assert.match(buildRecoveryInput(review, { uncertain: noCharge }, `Checked records. Bearer verylongauthorizationtoken123456`, true).error!, /Remove API keys/);
  assert.match(buildRecoveryInput(review, {
    uncertain: { ...noCharge, providerReference: "sk-or-v1-examplecredentialvalue1234567890" },
  }, note, true).error!, /request or invoice ID/);
});

test("payload includes only required decisions and current fingerprint", () => {
  const result = buildRecoveryInput(review, { uncertain: noCharge, known: noCharge, staleStep: noCharge }, `  ${note}  `, true);
  assert.deepEqual(result.input, {
    expectedFingerprint: "fingerprint-1", note, confirmProviderChecked: true,
    decisions: [{ stepKey: "uncertain", outcome: "no_charge", costMicros: 0, providerReference: "invoice-123" }],
  });
});

test("step total cannot undercut recorded attempts or erase them with no charge", () => {
  const priorCostReview = { ...review, steps: [{ ...review.steps[1], knownCostMicros: 1000001 }] };
  assert.match(buildRecoveryInput(priorCostReview, { uncertain: noCharge }, note, true).error!, /lower/);
  assert.match(buildRecoveryInput(priorCostReview, { uncertain: { ...noCharge, outcome: "charged", usd: "1" } }, note, true).error!, /lower/);
  const result = buildRecoveryInput(priorCostReview, { uncertain: { ...noCharge, outcome: "charged", usd: "1.000001" } }, note, true);
  assert.equal(result.input?.decisions[0].costMicros, 1000001);
});

test("known-only runs require no invented zero-charge decisions", () => {
  const knownReview = { ...review, steps: [review.steps[0]] };
  assert.deepEqual(buildRecoveryInput(knownReview, {}, note, true).input?.decisions, []);
});

test("settlement preview replaces rather than adds prior per-step usage", () => {
  const recorded = { ...review, knownCostMicros: 1500000, steps: [{ ...review.steps[1], knownCostMicros: 1000000 }] };
  const decisions = [{ stepKey: "uncertain", outcome: "charged" as const, costMicros: 2000000, providerReference: "invoice" }];
  assert.equal(recoverySettlementCost(recorded, decisions), 2500000);
  assert.equal(recoverySettlementCost({ ...recorded, knownCostMicros: Number.MAX_SAFE_INTEGER }, decisions), null);
  assert.equal(buildRecoveryInput({ ...review, knownCostMicros: Number.MAX_SAFE_INTEGER }, { uncertain: { ...noCharge, outcome: "charged", usd: "1" } }, note, true).input, null);
});

test("blocked, running, settled, or fingerprint-less runs cannot finalize", () => {
  const receipt = { id: "receipt", actorId: "admin", note, decisions: [], costMicros: 0, creditsUsed: 0, creditsRefunded: 50, createdAt: "2026-09-03T00:00:00Z" };
  for (const state of [{ canFinalize: false }, { status: "running" }, { receipt }, { fingerprint: "" }]) {
    assert.equal(buildRecoveryInput({ ...review, ...state }, { uncertain: noCharge }, note, true).input, null);
  }
});

test("recovery requests use private endpoints, session cookies, encoded IDs, and explicit POST input", async () => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ runs: [], review, receipt: null }), { status: 200 });
  };
  try {
    const controller = new AbortController();
    await listPremiumRecoveryRuns(controller.signal);
    await getPremiumRecoveryRun("run/with?path", controller.signal);
    const input = buildRecoveryInput(review, { uncertain: noCharge }, note, true).input!;
    await finalizePremiumRecoveryRun("run-1", input);
    assert.equal(calls[0].url, "/api/storyhold/admin/premium-recovery");
    assert.equal(calls[0].options?.signal, controller.signal);
    assert.equal(calls[1].url, "/api/storyhold/admin/premium-recovery/run%2Fwith%3Fpath");
    assert.equal(calls[2].url, "/api/storyhold/admin/premium-recovery/run-1/finalize");
    assert.equal(calls[2].options?.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[2].options?.body)), input);
    for (const call of calls) assert.equal(call.options?.credentials, "include");
  } finally { globalThis.fetch = originalFetch; }
});

test("server and provider error bodies never reach the recovery display", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [400, 401, 403, 404, 409, 422, 500]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: "SECRET_KEY manuscript text raw provider failure" }), { status });
      await assert.rejects(getPremiumRecoveryRun("run-1"), (error: Error) => {
        assert.doesNotMatch(error.message, /SECRET_KEY|manuscript|raw provider failure/);
        return true;
      });
    }
    globalThis.fetch = async () => { throw new Error("SECRET_KEY in network failure"); };
    await assert.rejects(getPremiumRecoveryRun("run-1"), /recovery service could not be reached/);
  } finally { globalThis.fetch = originalFetch; }
});

test("only allowlisted recovery error codes produce specific actionable messages", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      code: "ACTIVE_WORKER",
      error: "SECRET_KEY manuscript text raw provider failure",
    }), { status: 409 });
    await assert.rejects(getPremiumRecoveryRun("run-1"), (error: Error) => {
      assert.match(error.message, /worker is still active/iu);
      assert.match(error.message, /No billing changes/iu);
      assert.doesNotMatch(error.message, /SECRET_KEY|manuscript|raw provider failure/iu);
      return true;
    });
    globalThis.fetch = async () => new Response(JSON.stringify({
      code: "SECRET_KEY",
      error: "raw provider failure",
    }), { status: 409 });
    await assert.rejects(getPremiumRecoveryRun("run-1"), (error: Error) => {
      assert.match(error.message, /changed or is blocked/iu);
      assert.doesNotMatch(error.message, /SECRET_KEY|raw provider failure/iu);
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});
