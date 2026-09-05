import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AdventureSetupCard } from "../components/customer/adventure-setup-card";
import {
  adventureSetupBlocksPlay,
  adventureSetupEntryExport,
  adventureSetupIsPending,
  adventureSetupOpening,
  adventureSetupResponseTemplate,
  completeAdventureSetupEntry,
  getAdventureSetupEntry,
  listAdventureSetupEntries,
  parseAdventureSetupResponse,
  prepareAdventureSetup,
  type AdventureSetupEntry,
  type AdventureSetupStatus,
} from "./adventureSetupApi";

const entry: AdventureSetupEntry = {
  id: "setup-1", campaignId: "campaign-1", campaignName: "Rain at the Western Gate",
  status: "awaiting_response", createdAt: "2026-09-05T00:00:00Z", updatedAt: "2026-09-05T00:00:00Z",
  error: null, inputSha256: "exact-starting-input", request: { system: "Frozen starting facts" }, plan: null, notes: "",
};

test("required adventures gate new choices until ready, without blocking legacy campaigns", () => {
  for (const status of ["required", "awaiting_response", "generating", "failed"] as const) {
    assert.equal(adventureSetupBlocksPlay({ required: true, status, opening: null }), true);
  }
  assert.equal(adventureSetupBlocksPlay({ required: true, status: "ready", opening: "Rain strikes the gate." }), false);
  assert.equal(adventureSetupBlocksPlay({ required: false, status: "not_required", opening: null }), false);
  assert.equal(adventureSetupBlocksPlay(undefined), false);
  assert.equal(adventureSetupIsPending({ required: true, status: "awaiting_response", opening: null }), true);
  assert.equal(adventureSetupIsPending({ required: true, status: "generating", opening: null }), true);
  assert.equal(adventureSetupIsPending({ required: true, status: "failed", opening: null }), false);
});

test("only a ready, nonempty public opening is displayed", () => {
  const setup: AdventureSetupStatus = { required: true, status: "ready", opening: "Rain strikes the gate." };
  assert.equal(adventureSetupOpening(setup), setup.opening);
  for (const status of ["required", "awaiting_response", "generating", "failed", "not_required"] as const) {
    assert.equal(adventureSetupOpening({ ...setup, status }), null);
  }
  assert.equal(adventureSetupOpening({ ...setup, opening: "  " }), null);
  assert.equal(adventureSetupOpening(undefined), null);
});

test("the compact player card uses safe status copy and never renders private extra fields", () => {
  const privateExtras = { plan: { npcMotive: "SECRET_BETRAYAL", clocks: ["PRIVATE_CLOCK"] }, inputSha256: "PRIVATE_HASH", error: "PRIVATE_PROVIDER_ERROR" };
  const render = (status: AdventureSetupStatus["status"], busy = false) => renderToStaticMarkup(createElement(AdventureSetupCard, {
    setup: { ...privateExtras, required: true, status, opening: null }, busy, error: null, onPrepare() {},
  }));
  assert.match(render("required"), /Prepare Adventure/);
  assert.match(render("failed"), /Try Again/);
  for (const status of ["awaiting_response", "generating"] as const) {
    assert.match(render(status), /Preparing Your Adventure/);
    assert.doesNotMatch(render(status), /<button/);
  }
  assert.match(render("required", true), /Preparing Your Adventure/);
  assert.equal(render("ready"), "");
  assert.doesNotMatch(render("required"), /SECRET_BETRAYAL|PRIVATE_CLOCK|PRIVATE_HASH|PRIVATE_PROVIDER_ERROR|inputSha256|npcMotive/);
});

test("setup retries use the same authenticated campaign route, and admin requests stay private", async () => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ adventureSetup: { required: true, status: "awaiting_response", opening: null }, creditsUsed: 0, enabled: true, entries: [], entry, duplicate: false }));
  };
  try {
    await prepareAdventureSetup("campaign/one?other");
    await prepareAdventureSetup("campaign/one?other");
    const controller = new AbortController();
    await listAdventureSetupEntries(controller.signal);
    await getAdventureSetupEntry("setup/other?path", controller.signal);
    const answer = { inputSha256: entry.inputSha256, plan: { opening: "Rain strikes the gate." }, notes: "Reviewed the first goal." };
    await completeAdventureSetupEntry(entry.id, answer);
    await completeAdventureSetupEntry(entry.id, answer);
    assert.equal(calls[0].url, "/api/storyhold/campaigns/campaign%2Fone%3Fother/setup");
    assert.equal(calls[0].options?.method, "POST");
    assert.equal(calls[1].url, calls[0].url);
    assert.equal(calls[1].options?.body, calls[0].options?.body);
    assert.equal(calls[2].url, "/api/storyhold/admin/adventure-setups");
    assert.equal(calls[2].options?.signal, controller.signal);
    assert.equal(calls[3].url, "/api/storyhold/admin/adventure-setups/setup%2Fother%3Fpath");
    assert.equal(calls[4].url, "/api/storyhold/admin/adventure-setups/setup-1/complete");
    assert.equal(calls[5].options?.body, calls[4].options?.body);
    assert.deepEqual(JSON.parse(String(calls[4].options?.body)), answer);
    for (const call of calls) assert.equal(call.options?.credentials, "include");
  } finally { globalThis.fetch = originalFetch; }
});

test("setup failures do not leak infrastructure or private planning details", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "PRIVATE_PROVIDER_TOKEN", plan: "SECRET_BETRAYAL" }), { status: 500 });
    await assert.rejects(prepareAdventureSetup("campaign-1"), (reason: Error) => {
      assert.match(reason.message, /adventure is saved/);
      assert.doesNotMatch(reason.message, /PRIVATE_PROVIDER_TOKEN|SECRET_BETRAYAL/);
      return true;
    });
    globalThis.fetch = async () => { throw new Error("PRIVATE_NETWORK_DETAILS"); };
    await assert.rejects(prepareAdventureSetup("campaign-1"), /adventure is saved/);
  } finally { globalThis.fetch = originalFetch; }
});

test("manual setup imports bind the answer to its exact saved campaign input", () => {
  const packet = adventureSetupEntryExport(entry);
  assert.deepEqual(packet.entry.request, entry.request);
  assert.equal(packet.responseTemplate.entryId, entry.id);
  const response = { ...adventureSetupResponseTemplate(entry), plan: { opening: "Rain strikes the gate." } };
  const parsed = parseAdventureSetupResponse(entry, JSON.stringify(response));
  assert.deepEqual(parsed, { inputSha256: entry.inputSha256, plan: response.plan, notes: "" });
  for (const incorrect of [{ entryId: "setup-2" }, { inputSha256: "earlier-input" }]) {
    assert.throws(() => parseAdventureSetupResponse(entry, JSON.stringify({ ...response, ...incorrect })), /another saved input/);
  }
  assert.throws(() => parseAdventureSetupResponse(entry, JSON.stringify(packet.responseTemplate)), /plan field/);
  assert.throws(() => parseAdventureSetupResponse({ ...entry, status: "ready" }, JSON.stringify(response)), /no longer awaiting/);
  assert.throws(() => parseAdventureSetupResponse(entry, JSON.stringify({ ...response, notes: "x".repeat(8_001) })), /8,000/);
});

test("play polls only reads, gates submission, and keeps completed turns visible", () => {
  const play = readFileSync(new URL("../pages/campaign-play.tsx", import.meta.url), "utf8");
  const pollStart = play.indexOf("    if (!session || !adventureSetupIsPending(session.adventureSetup)) return;");
  const poll = play.slice(pollStart, play.indexOf("  const prepareAdventure = async", pollStart));
  assert.match(poll, /getCampaignPlay\(campaignId, controller.signal\)/);
  assert.match(poll, /setTimeout\(refresh, 4_000\)/);
  assert.doesNotMatch(poll, /prepareAdventureSetup|createCampaignTurnProposal|runBrowser/);
  const submit = play.slice(play.indexOf("  const submit = async"), play.indexOf("  const refreshManualTurn"));
  assert.match(submit, /if \([^\n]*setupBlocksPlay[^\n]*\) return;/);
  assert.match(play, /disabled=\{setupBlocksPlay \|\| setupBusy/);
  assert.match(play, /\{session.turns.map\(\(turn\) =>/);
  assert.doesNotMatch(play, /adventureSetup\.plan|inputSha256|adventureSetupEntryExport|AdventureSetupQueue/);
});

test("quickstart preserves the created campaign when setup needs a retry", () => {
  const source = readFileSync(new URL("../components/customer/quickstart-creator.tsx", import.meta.url), "utf8");
  const saved = source.indexOf("setCreated({ worldId: world.id");
  const preparing = source.indexOf("await prepareAdventureSetup(campaign.campaign.id)");
  const recovery = source.indexOf("Your beginning is saved. You can finish preparing it");
  const navigation = source.indexOf("navigate(`/profile/campaigns/${campaign.campaign.id}/play`)", preparing);
  assert.ok(saved >= 0 && saved < preparing && preparing < recovery && recovery < navigation);
  assert.doesNotMatch(source.slice(preparing, navigation), /createWorld\(|createCampaign\(/);
  const admin = readFileSync(new URL("../pages/admin/ManualStoryteller.tsx", import.meta.url), "utf8");
  assert.match(admin, /enabled \? <AdventureSetupQueue \/>/);
});
