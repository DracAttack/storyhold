import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { isManualQueuedResponse } from "./manualStorytellerApi";
import { safeCampaignInputMode } from "./campaignInputModes";

const page = readFileSync(new URL("../pages/campaign-play.tsx", import.meta.url), "utf8");

// Execute the actual event-handler body with inert React setters and stubbed
// services. This catches accidental model probes even when their errors would
// otherwise be caught and hidden before a successful request.
function actualHandler(name: string, next: string, context: Record<string, unknown>) {
  const start = page.indexOf(`  const ${name} = async`);
  const end = page.indexOf(`  const ${next} = async`, start + 1);
  assert.ok(start >= 0 && end > start, `Production handler ${name} exists`);
  const source = page.slice(start, end).replace(`const ${name} =`, "globalThis.handler =");
  const script = transformSync(source, { loader: "ts", format: "esm", target: "es2022" }).code;
  vm.runInNewContext(script, context);
  return context.handler as (...args: unknown[]) => Promise<unknown>;
}

function sendContext(response: unknown, experienceMode: "solo" | "author", manual = false) {
  const requests: unknown[] = [];
  const browserCalls: string[] = [];
  const context: Record<string, any> = {
    action: "  I check the door.  ", inputMode: "action", sending: false,
    setupBlocksPlay: false, setupBusy: false,
    session: { campaign: { id: `campaign-${experienceMode}`, experienceMode }, turns: [], runtime: {}, manualStorytellerEnabled: manual },
    auth: { userId: "player", refresh: async () => {} },
    pendingTurnRequestRef: { current: null }, requestId: () => "request-original",
    safeCampaignInputMode, isManualQueuedResponse,
    manualTurnIsPending: () => false,
    acquireCampaignTurnRequest: async (input: Record<string, unknown>) => input.pendingRequest ?? { requestId: "request-original" },
    clearPendingCampaignTurnRequest: () => {},
    createCampaignTurnProposal: async (input: unknown) => { requests.push(input); return response; },
    browserLorekeeperIsEnabled: () => true,
    toast: { error: () => {} },
  };
  for (const name of ["inspectBrowserLorekeeper", "persistBrowserModelCache", "runBrowserTurnAssist", "runBrowserCampaignNarration", "completeBrowserNarration"]) {
    context[name] = async () => { browserCalls.push(name); throw new Error("A regular live send must not touch a browser model."); };
  }
  for (const name of ["setSending", "setPendingAction", "setPendingInputMode", "setError", "setLocalAssistMessage", "setLastCreditsUsed"]) context[name] = () => {};
  context.setAction = (action: string) => { context.action = action; };
  context.setSession = (update: unknown) => { context.savedSession = typeof update === "function" ? update(context.session) : update; };
  return { context, requests, browserCalls };
}

test("new solo and imported author choices go straight to the server even with browser intelligence enabled", async () => {
  for (const mode of ["solo", "author"] as const) {
    const { context, requests, browserCalls } = sendContext({ proposal: { id: "draft", narration: "A quiet corridor." }, creditsUsed: 2 }, mode);
    const send = actualHandler("submit", "refreshManualTurn", context);
    await send({ preventDefault() {} });
    assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{
      campaignId: `campaign-${mode}`, action: "I check the door.", inputMode: "action", requestId: "request-original",
    }]);
    assert.deepEqual(browserCalls, []);
    assert.equal(context.savedSession.pendingProposal.id, "draft");
  }
});

test("manual turns still queue without inference and uncertain sends reuse the saved request", async () => {
  const queued = { manualTurn: { id: "manual", requestId: "request-original", status: "awaiting_direction" }, creditsUsed: 0 };
  const { context, browserCalls } = sendContext(queued, "solo", true);
  const requests: Array<Record<string, unknown>> = [];
  context.createCampaignTurnProposal = async (input: Record<string, unknown>) => {
    requests.push(input);
    if (requests.length === 1) throw new Error("Lost response");
    return queued;
  };
  const send = actualHandler("submit", "refreshManualTurn", context);
  await send({ preventDefault() {} });
  assert.equal(context.action, "I check the door.");
  assert.equal(context.pendingTurnRequestRef.current.requestId, "request-original");
  await send({ preventDefault() {} });
  assert.equal(requests[0].requestId, requests[1].requestId);
  assert.equal(context.savedSession.pendingManualTurn.id, "manual");
  assert.deepEqual(browserCalls, []);
});

test("older saved browser narration can still complete around its locked proposal", async () => {
  const proposal = { id: "saved-proposal", browserNarrationTask: { proposalId: "saved-proposal", lockedOutcome: "success" } };
  for (const enabled of [true, false]) {
    const calls: Array<{ kind: string; input: unknown }> = [];
    const context: Record<string, unknown> = {
      session: { campaign: { id: "campaign" }, turns: [] },
      browserLorekeeperIsEnabled: () => enabled,
      setLocalAssistMessage: () => {},
      inspectBrowserLorekeeper: async () => ({ supported: true }),
      persistBrowserModelCache: async () => {},
      runBrowserCampaignNarration: async (input: unknown) => {
        calls.push({ kind: "browser", input });
        return { narration: "The saved result.", model: "saved-model", usage: { inputTokens: 2, outputTokens: 3 } };
      },
      submitCampaignBrowserNarration: async (input: unknown) => { calls.push({ kind: "complete", input }); return { proposal }; },
      regenerateCampaignTurnProposal: async (input: unknown) => { calls.push({ kind: "server", input }); return { proposal }; },
    };
    const complete = actualHandler("completeBrowserNarration", "submit", context);
    await complete({ proposal });
    assert.deepEqual(calls.map((call) => call.kind), enabled ? ["browser", "complete"] : ["server"]);
    assert.equal((calls.at(-1)!.input as Record<string, unknown>).proposalId, "saved-proposal");
  }
});
