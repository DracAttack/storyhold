import assert from "node:assert/strict";
import test from "node:test";
import { registerPremiumRecoveryRoutes } from "./premiumRecoveryRoutes";
import { PremiumRecoveryError } from "./premiumReviewReconciliation";

const ACTOR = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const WORLD = "00000000-0000-4000-8000-000000000003";
const BASE = "/api/storyhold/admin/premium-recovery";
const PRIVATE = "PRIVATE_MANUSCRIPT_PROMPT_OR_CREDENTIAL";
type Options = Parameters<typeof registerPremiumRecoveryRoutes>[0];

function harness({ role = "owner", active = false, fail = false, finalized = false, privateFields = false, credentialValues = false, serviceError = null as unknown } = {}) {
  const routes = new Map<string, { middleware: unknown; handle: Function }>();
  const calls: Array<{ kind: string; value?: unknown; options?: unknown }> = [];
  const middleware = () => undefined;
  const finalReceipt = {
    id: "saved-receipt", actorId: ACTOR,
    note: credentialValues ? "Bearer examplecredentialvalue1234567890" : "Checked provider records.",
    decisions: credentialValues ? [{
      stepKey: "verification:0", outcome: "no_charge" as const, costMicros: 0,
      providerReference: "sk-or-v1-examplecredentialvalue1234567890",
    }] : [],
    costMicros: 0, creditsUsed: 0, creditsRefunded: 10, createdAt: "2026-09-04T00:00:00.000Z",
    ...(privateFields ? { rawProviderError: PRIVATE, requestSnapshot: PRIVATE } : {}),
  };
  const receipt = finalized ? finalReceipt : null;
  const detail = {
    id: RUN, runId: RUN, worldId: WORLD, worldName: "Test World", status: finalized ? "failed" : "paused",
    stage: "Saved boundary", progress: 43, createdAt: "2026-09-03T23:58:00.000Z",
    fingerprint: "saved-fingerprint", canFinalize: !finalized,
    blockReason: null, reservedCredits: 10, knownCostMicros: 0,
    steps: [{
      stepKey: "verification:0", status: "uncertain",
      provider: credentialValues ? "sk-examplecredentialvalue1234567890" : "openrouter",
      model: credentialValues ? "OPENROUTER_API_KEY=examplecredentialvalue" : "test/model",
      knownCostMicros: null, needsDecision: true,
      dispatchedAt: "2026-09-04T00:00:00.000Z", lastRecordedAt: "2026-09-04T00:01:00.000Z",
    }],
    receipt,
    ...(privateFields ? { requestSnapshot: PRIVATE, sourceText: PRIVATE, rawError: PRIVATE } : {}),
  };
  const services = {
    listPremiumRecoveries: async () => { calls.push({ kind: "list" }); if (serviceError) throw serviceError; if (fail) throw new Error("private-source-or-secret"); return [detail]; },
    inspectPremiumRecovery: async (_db: unknown, value: unknown) => { calls.push({ kind: "inspect", value }); return detail; },
    finalizePremiumRecovery: async (_db: unknown, value: unknown, options: unknown) => {
      calls.push({ kind: "finalize", value, options });
      return { ...detail, canFinalize: false, receipt: finalReceipt };
    },
  };
  const app = Object.fromEntries(["get", "post"].map((method) => [method, (path: string, auth: unknown, handle: Function) => {
    routes.set(`${method} ${path}`, { middleware: auth, handle });
  }]));
  registerPremiumRecoveryRoutes({
    app, db: { query: async () => ({ rows: role ? [{ role }] : [] }) },
    requireUser: middleware, isWorldWorkerActive: () => active, services,
  } as unknown as Options);
  async function request(method = "get", path = BASE, overrides: Record<string, unknown> = {}) {
    const route = routes.get(`${method} ${path}`)!;
    assert.equal(route.middleware, middleware);
    const req = {
      localUser: { id: ACTOR, role: "owner" }, params: { runId: RUN },
      is: () => "application/json", body: {
        expectedFingerprint: "snapshot", note: "Checked the provider records.",
        confirmProviderChecked: true, decisions: [], actorId: "spoof", runId: "spoof",
        isWorldWorkerActive: false,
      }, ...overrides,
    };
    const response = { status: 200, body: null as unknown, headers: {} as Record<string, string> };
    const res = {
      setHeader: (name: string, value: string) => { response.headers[name] = value; },
      status: (status: number) => { response.status = status; return res; },
      json: (body: unknown) => { response.body = body; return res; },
    };
    await route.handle(req, res);
    return response;
  }
  return { request, calls };
}

test("every recovery route denies missing authenticated identity", async () => {
  for (const [method, path] of [["get", BASE], ["get", `${BASE}/:runId`], ["post", `${BASE}/:runId/finalize`]]) {
    const h = harness();
    const res = await h.request(method, path, { localUser: undefined });
    assert.equal(res.status, 401);
    assert.equal((res.body as { code: string }).code, "UNAUTHENTICATED");
    assert.equal(res.headers["Cache-Control"], "no-store");
    assert.equal(h.calls.length, 0);
  }
});

test("current player/creator/demoted roles cannot inspect or alter billing despite cached owner role", async () => {
  for (const role of ["player", "creator", ""]) {
    for (const [method, path] of [["get", BASE], ["get", `${BASE}/:runId`], ["post", `${BASE}/:runId/finalize`]]) {
      const h = harness({ role });
      const response = await h.request(method, path);
      assert.equal(response.status, 403);
      assert.equal((response.body as { code: string }).code, "FORBIDDEN");
      assert.equal(h.calls.length, 0);
    }
  }
});

test("owner and admin can read private no-store recovery status", async () => {
  for (const role of ["owner", "admin"]) {
    const h = harness({ role });
    const response = await h.request();
    assert.equal(response.status, 200);
    assert.equal(response.headers["Cache-Control"], "no-store");
    assert.equal(h.calls[0]?.kind, "list");
  }
});

test("a malformed run identifier never reaches inspection or finalization", async () => {
  const h = harness();
  const res = await h.request("post", `${BASE}/:runId/finalize`, { params: { runId: "bad-id" } });
  assert.equal(res.status, 404);
  assert.equal((res.body as { code: string }).code, "NOT_FOUND");
  assert.equal(h.calls.length, 0);
});

test("live-worker state blocks finalization and is visible in list/detail", async () => {
  const h = harness({ active: true });
  const listed = await h.request();
  assert.equal((listed.body as { runs: Array<{ canFinalize: boolean }> }).runs[0]?.canFinalize, false);
  const inspected = await h.request("get", `${BASE}/:runId`);
  assert.equal((inspected.body as { review: { canFinalize: boolean } }).review.canFinalize, false);
  const finalized = await h.request("post", `${BASE}/:runId/finalize`);
  assert.equal(finalized.status, 409);
  assert.equal((finalized.body as { code: string }).code, "ACTIVE_WORKER");
  assert.equal(h.calls.some((call) => call.kind === "finalize"), false);
});

test("finalize binds the authenticated actor/path and forwards only explicit decision fields", async () => {
  const h = harness();
  const res = await h.request("post", `${BASE}/:runId/finalize`);
  assert.equal(res.status, 200);
  const call = h.calls.find((item) => item.kind === "finalize")!;
  assert.deepEqual(call.value, {
    actorId: ACTOR, runId: RUN, expectedFingerprint: "snapshot",
    note: "Checked the provider records.", confirmProviderChecked: true, decisions: [],
  });
  assert.equal(typeof (call.options as { isWorldWorkerActive: unknown }).isWorldWorkerActive, "function");
});

test("non-JSON and array payloads cannot finalize", async () => {
  for (const overrides of [{ is: () => false }, { body: [] }, { body: null }]) {
    const h = harness();
    const response = await h.request("post", `${BASE}/:runId/finalize`, overrides);
    assert.equal(response.status, 400);
    assert.equal((response.body as { code: string }).code, "INVALID_REQUEST");
    assert.equal(h.calls.length, 0);
  }
});

test("credential-like audit text is rejected before inspection or finalization", async () => {
  const bodies = [
    {
      expectedFingerprint: "snapshot", note: "Bearer examplecredentialvalue1234567890",
      confirmProviderChecked: true, decisions: [],
    },
    {
      expectedFingerprint: "snapshot", note: "Checked provider records.", confirmProviderChecked: true,
      decisions: [{ stepKey: "verification:0", outcome: "no_charge", costMicros: 0, providerReference: "sk-or-v1-examplecredentialvalue1234567890" }],
    },
  ];
  for (const body of bodies) {
    const h = harness();
    const response = await h.request("post", `${BASE}/:runId/finalize`, { body });
    assert.equal(response.status, 400);
    assert.match(String((response.body as { code: string }).code), /INVALID_(?:REQUEST|DECISION)/u);
    assert.equal(h.calls.length, 0);
  }
});

test("a finalized receipt retry reaches authoritative idempotency checks even while another worker is active", async () => {
  const h = harness({ active: true, finalized: true });
  const response = await h.request("post", `${BASE}/:runId/finalize`);
  assert.equal(response.status, 200);
  assert.equal(h.calls.some((call) => call.kind === "finalize"), true);
});

test("unexpected private errors are not exposed in the operator response", async () => {
  const response = await harness({ fail: true }).request();
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(response).includes("private-source-or-secret"), false);
});

test("known recovery errors use curated public copy rather than exception text", async () => {
  const response = await harness({
    serviceError: new PremiumRecoveryError("INVALID_REQUEST", PRIVATE, 400),
  }).request();
  assert.equal(response.status, 400);
  assert.equal((response.body as { code: string }).code, "INVALID_REQUEST");
  assert.equal(JSON.stringify(response).includes(PRIVATE), false);
  assert.match(JSON.stringify(response.body), /incomplete or invalid/iu);
});

test("insufficient funded overage returns safe top-up guidance without exposing service text", async () => {
  const response = await harness({
    serviceError: new PremiumRecoveryError("INSUFFICIENT_CREDITS", PRIVATE, 409),
  }).request();
  assert.equal(response.status, 409);
  assert.equal((response.body as { code: string }).code, "INSUFFICIENT_CREDITS");
  assert.equal(JSON.stringify(response).includes(PRIVATE), false);
  assert.match(JSON.stringify(response.body), /No billing changes were made/iu);
  assert.match(JSON.stringify(response.body), /add credits before retrying/iu);
});

test("HTTP DTO projection drops future private service fields at every nesting level", async () => {
  const h = harness({ finalized: true, privateFields: true });
  for (const response of [
    await h.request(),
    await h.request("get", `${BASE}/:runId`),
    await h.request("post", `${BASE}/:runId/finalize`),
  ]) {
    assert.equal(response.status, 200);
    assert.equal(JSON.stringify(response.body).includes(PRIVATE), false);
  }
});

test("HTTP DTO projection redacts credential-like values in otherwise public fields", async () => {
  const response = await harness({ finalized: true, credentialValues: true }).request();
  assert.equal(response.status, 200);
  const serialized = JSON.stringify(response.body);
  assert.doesNotMatch(serialized, /examplecredentialvalue/iu);
  assert.match(serialized, /redacted/iu);
  assert.match(serialized, /Unrecorded Provider/iu);
  assert.match(serialized, /Unrecorded Model/iu);
});
