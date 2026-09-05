import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  acquireCampaignBranchRequest,
  acquireCampaignRerollRequest,
  acquireCampaignTurnRequest,
  clearPendingCampaignBranchRequest,
  clearPendingCampaignRerollRequest,
  clearPendingCampaignTurnRequest,
  readPendingCampaignBranchRequest,
  readPendingCampaignRerollRequest,
  readPendingCampaignTurnRequest,
} from "./campaignRequestPersistence";

class MemorySessionStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

const scope = {
  playerId: "player_12345678",
  campaignId: "campaign_12345678",
};

test("ordinary campaign retries reuse one request ID without storing turn text", async () => {
  const storage = new MemorySessionStorage();
  let created = 0;
  const first = await acquireCampaignTurnRequest({
    ...scope,
    action: "A private line of dialogue that must never enter storage.",
    inputMode: "action",
    createRequestId: () => `request_${++created}_12345678`,
    storage,
  });
  const serialized = [...storage.values.values()].join("\n");
  assert.doesNotMatch(serialized, /private line|dialogue|never enter/iu);
  assert.doesNotMatch(serialized, /"action"\s*:/u);

  const afterReload = await acquireCampaignTurnRequest({
    ...scope,
    action: "A private line of dialogue that must never enter storage.",
    inputMode: "action",
    createRequestId: () => `request_${++created}_12345678`,
    storage,
  });
  assert.equal(afterReload.requestId, first.requestId);
  assert.equal(created, 1);

  const differentInput = await acquireCampaignTurnRequest({
    ...scope,
    action: "I take a different action.",
    inputMode: "action",
    createRequestId: () => `request_${++created}_12345678`,
    storage,
  });
  assert.notEqual(differentInput.requestId, first.requestId);
  assert.equal(created, 2);
});

test("turn persistence is scoped to the signed-in player and campaign and clears conditionally", async () => {
  const storage = new MemorySessionStorage();
  const pending = await acquireCampaignTurnRequest({
    ...scope,
    action: "Open the door.",
    inputMode: "action",
    createRequestId: () => "request_scoped_12345678",
    storage,
  });
  assert.equal(
    readPendingCampaignTurnRequest({ ...scope, storage })?.requestId,
    pending.requestId,
  );
  assert.equal(
    readPendingCampaignTurnRequest({
      playerId: "another_player_12345678",
      campaignId: scope.campaignId,
      storage,
    }),
    null,
  );

  clearPendingCampaignTurnRequest({
    ...scope,
    requestId: "a_different_request_12345678",
    storage,
  });
  assert.ok(readPendingCampaignTurnRequest({ ...scope, storage }));
  clearPendingCampaignTurnRequest({
    ...scope,
    requestId: pending.requestId,
    storage,
  });
  assert.equal(readPendingCampaignTurnRequest({ ...scope, storage }), null);
});

test("the in-memory identity remains safe when session storage is unavailable", async () => {
  let created = 0;
  const first = await acquireCampaignTurnRequest({
    ...scope,
    action: "Keep walking.",
    inputMode: "action",
    createRequestId: () => `request_memory_${++created}_12345678`,
    storage: null,
  });
  const retry = await acquireCampaignTurnRequest({
    ...scope,
    action: "Keep walking.",
    inputMode: "action",
    createRequestId: () => `request_memory_${++created}_12345678`,
    pendingRequest: first,
    storage: null,
  });
  assert.equal(retry.requestId, first.requestId);
  assert.equal(created, 1);
});

test("reroll retries keep the exact source proposal across reload and a lost success response", () => {
  const storage = new MemorySessionStorage();
  const first = acquireCampaignRerollRequest({
    ...scope,
    currentProposalId: "proposal_original_12345678",
    storage,
  });
  const afterReload = acquireCampaignRerollRequest({
    ...scope,
    currentProposalId: "proposal_original_12345678",
    storage,
  });
  assert.equal(afterReload.sourceProposalId, first.sourceProposalId);

  const afterLostSuccess = acquireCampaignRerollRequest({
    ...scope,
    currentProposalId: "proposal_result_12345678",
    currentRerolledFromProposalId: "proposal_original_12345678",
    storage,
  });
  assert.equal(afterLostSuccess.sourceProposalId, "proposal_original_12345678");

  const unrelatedProposal = acquireCampaignRerollRequest({
    ...scope,
    currentProposalId: "proposal_unrelated_12345678",
    currentRerolledFromProposalId: null,
    storage,
  });
  assert.equal(unrelatedProposal.sourceProposalId, "proposal_unrelated_12345678");

  clearPendingCampaignRerollRequest({
    ...scope,
    sourceProposalId: "proposal_original_12345678",
    storage,
  });
  assert.ok(readPendingCampaignRerollRequest({ ...scope, storage }));
  clearPendingCampaignRerollRequest({
    ...scope,
    sourceProposalId: "proposal_unrelated_12345678",
    storage,
  });
  assert.equal(readPendingCampaignRerollRequest({ ...scope, storage }), null);
});

test("paid branch retries preserve the exact request payload across reload", () => {
  const storage = new MemorySessionStorage();
  let created = 0;
  const first = acquireCampaignBranchRequest({
    ...scope,
    checkpointId: "checkpoint_12345678",
    name: "Alternate branch 1",
    mode: "alternate",
    createRequestId: () => `branch_request_${++created}_12345678`,
    storage,
  });
  const afterReload = acquireCampaignBranchRequest({
    ...scope,
    checkpointId: "checkpoint_12345678",
    name: "Alternate branch 2",
    mode: "alternate",
    createRequestId: () => `branch_request_${++created}_12345678`,
    storage,
  });
  assert.deepEqual(afterReload, first);
  assert.equal(created, 1);
  assert.equal(
    readPendingCampaignBranchRequest({ ...scope, storage })?.requestId,
    first.requestId,
  );

  clearPendingCampaignBranchRequest({
    ...scope,
    requestId: "different_branch_request_12345678",
    storage,
  });
  assert.ok(readPendingCampaignBranchRequest({ ...scope, storage }));
  clearPendingCampaignBranchRequest({
    ...scope,
    requestId: first.requestId,
    storage,
  });
  assert.equal(readPendingCampaignBranchRequest({ ...scope, storage }), null);
});

test("campaign play sends the persisted identities to the matching paid endpoints", () => {
  const page = readFileSync(
    new URL("../pages/campaign-play.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /requestId:\s*pendingRequest\.requestId/u);
  assert.match(page, /proposalId:\s*pendingRequest\.sourceProposalId/u);
  assert.match(page, /readPendingCampaignTurnRequest/u);
  assert.match(page, /readPendingCampaignRerollRequest/u);
  assert.match(page, /readPendingCampaignBranchRequest/u);
  assert.match(page, /requestId:\s*pendingRequest\.requestId/u);
  assert.match(page, /response\.pendingTurnRequest/u);
  assert.match(page, /setAction\(response\.pendingTurnRequest\.action\)/u);
  assert.match(page, /createRequestId:\s*\(\) => response\.pendingTurnRequest!\.requestId/u);
  assert.doesNotMatch(page, /requestIdRef/u);
  assert.doesNotMatch(page, /private narrator|connected narrator|server Lorekeeper/iu);
});
