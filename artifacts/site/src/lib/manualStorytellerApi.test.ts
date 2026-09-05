import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  completeManualStorytellerEntry,
  getManualStorytellerEntry,
  isManualQueuedResponse,
  listManualStorytellerEntries,
  manualEntryExport,
  manualResponseTemplate,
  manualTurnIsPending,
  ManualStorytellerError,
  parseManualResponse,
  submitManualDirection,
  type ManualStorytellerEntry,
} from "./manualStorytellerApi";

const entry: ManualStorytellerEntry = {
  id: "entry-1", campaignId: "campaign-1", requestId: "request-1",
  status: "awaiting_direction", createdAt: "2026-09-04T00:00:00Z", updatedAt: "2026-09-04T00:00:00Z",
  error: null, turnId: null, playerInput: "I inspect the sealed door.", intent: "action",
  expectedStateVersion: 4, inputSha256: "exact-context-hash", directorRequest: { system: "Frozen rules", user: "Frozen evidence" },
  narratorRequest: null, direction: null, attempts: [],
};

test("manual queue remains pending until narration is committed and cannot masquerade as a proposal", () => {
  assert.equal(isManualQueuedResponse({ manualTurn: entry, creditsUsed: 0 }), true);
  assert.equal(isManualQueuedResponse({ proposal: { id: "proposal" } }), false);
  assert.equal(isManualQueuedResponse({ manualTurn: {} }), false);
  assert.equal(manualTurnIsPending(entry), true);
  assert.equal(manualTurnIsPending({ ...entry, status: "awaiting_narration" }), true);
  assert.equal(manualTurnIsPending({ ...entry, status: "completed" }), false);
  assert.equal(manualTurnIsPending({ ...entry, status: "stale" }), false);
});

test("export preserves the exact frozen requests and provides an input-bound response template", () => {
  const packet = manualEntryExport(entry);
  assert.deepEqual(packet.entry.directorRequest, entry.directorRequest);
  assert.equal(packet.responseTemplate.entryId, entry.id);
  assert.equal(packet.responseTemplate.inputSha256, entry.inputSha256);
  assert.deepEqual(packet.responseTemplate.direction, {});
  const narrationEntry = { ...entry, status: "awaiting_narration" as const, narratorRequest: { locked: "outcome" } };
  assert.deepEqual(manualEntryExport(narrationEntry).entry.narratorRequest, narrationEntry.narratorRequest);
  assert.equal(manualResponseTemplate(narrationEntry).narration, "");
});

test("an answer for another entry or an older context cannot be imported onto the selected turn", () => {
  const answer = { ...manualResponseTemplate(entry), direction: { outcome: "success" } };
  for (const wrong of [{ entryId: "other" }, { inputSha256: "earlier-context" }]) {
    assert.throws(() => parseManualResponse(entry, JSON.stringify({ ...answer, ...wrong })), /another saved input/);
  }
  assert.deepEqual(parseManualResponse(entry, JSON.stringify(answer)), answer);
});

test("Director and narration imports must follow the actual saved stage", () => {
  const answer = { ...manualResponseTemplate(entry), direction: { outcome: "success" } };
  assert.throws(() => parseManualResponse(entry, JSON.stringify({ ...answer, narration: "The door opens." })), /Director decision first/);
  assert.throws(() => parseManualResponse(entry, JSON.stringify(manualResponseTemplate(entry))), /structured decision/);
  const next = { ...entry, status: "awaiting_narration" as const };
  assert.throws(() => parseManualResponse(next, JSON.stringify(answer)), /narration field/);
  const narration = { ...manualResponseTemplate(next), narration: "The hinges are rusted shut.", notes: "Removed an unsupported treasure reveal." };
  assert.deepEqual(parseManualResponse(next, JSON.stringify(narration)), narration);
  for (const status of ["completed", "stale"] as const) {
    assert.throws(() => parseManualResponse({ ...entry, status }, JSON.stringify(answer)), /no longer awaiting/);
  }
});

test("private requests use authenticated local routes and retries preserve the exact frozen answer", async () => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ enabled: true, entries: [], entry, duplicate: false }), { status: 200 });
  };
  try {
    const controller = new AbortController();
    await listManualStorytellerEntries(controller.signal);
    await getManualStorytellerEntry("entry/other?path", controller.signal);
    await submitManualDirection(entry.id, { direction: { outcome: "success" }, inputSha256: entry.inputSha256, notes: "Checked the named character." });
    const answer = { narration: "The hinges are rusted shut.", inputSha256: entry.inputSha256, notes: "Checked continuity." };
    await completeManualStorytellerEntry(entry.id, answer);
    await completeManualStorytellerEntry(entry.id, answer);
    assert.equal(calls[0].url, "/api/storyhold/admin/manual-storyteller");
    assert.equal(calls[1].url, "/api/storyhold/admin/manual-storyteller/entry%2Fother%3Fpath");
    assert.equal(calls[2].url, "/api/storyhold/admin/manual-storyteller/entry-1/direction");
    assert.equal(calls[3].url, "/api/storyhold/admin/manual-storyteller/entry-1/complete");
    assert.equal(calls[4].options?.body, calls[3].options?.body);
    assert.deepEqual(JSON.parse(String(calls[3].options?.body)), answer);
    assert.equal(calls[0].options?.signal, controller.signal);
    for (const call of calls) assert.equal(call.options?.credentials, "include");
  } finally { globalThis.fetch = originalFetch; }
});

test("validation rejections preserve the private recorded attempt while infrastructure errors stay generic", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const rejected = { ...entry, error: "Unsupported objective advancement", attempts: [{ stage: "direction", accepted: false, error: "Unsupported objective advancement", notes: "Investigating mismatch", createdAt: entry.createdAt }] };
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "private failure", entry: rejected }), { status: 422 });
    await assert.rejects(submitManualDirection(entry.id, { inputSha256: entry.inputSha256, direction: {} }), (error: Error) => {
      assert.ok(error instanceof ManualStorytellerError);
      assert.equal(error.status, 422);
      assert.deepEqual(error.entry?.attempts, rejected.attempts);
      return true;
    });
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "PRIVATE_PROVIDER_TOKEN" }), { status: 500 });
    await assert.rejects(getManualStorytellerEntry(entry.id), (error: Error) => !error.message.includes("PRIVATE_PROVIDER_TOKEN"));
    globalThis.fetch = async () => { throw new Error("private network details"); };
    await assert.rejects(completeManualStorytellerEntry(entry.id, { narration: "Saved answer", inputSha256: entry.inputSha256 }), /may already have been accepted/);
  } finally { globalThis.fetch = originalFetch; }
});

test("the player path skips browser inference and keeps frozen prompts inside the private queue", () => {
  const play = readFileSync(new URL("../pages/campaign-play.tsx", import.meta.url), "utf8");
  const send = play.slice(play.indexOf("  const submit = async"), play.indexOf("  const refreshManualTurn"));
  assert.doesNotMatch(send, /inspectBrowserLorekeeper|persistBrowserModelCache|runBrowserTurnAssist|runBrowserCampaignNarration/);
  assert.match(play, /isManualQueuedResponse\(initialResponse\)/);
  assert.match(play, /pendingTurn.requestId === response.pendingManualTurn\?\.requestId/);
  assert.match(play, /manualTurnIsPending\(session.pendingManualTurn\)/);
  assert.doesNotMatch(play, /directorRequest|narratorRequest|inputSha256|manualEntryExport/);
});
