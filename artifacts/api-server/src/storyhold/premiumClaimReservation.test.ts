import assert from "node:assert/strict";
import test from "node:test";
import { quoteAiCostReservation, type GenerateAiTextInput } from "./aiGateway";
import { buildPremiumClaimRequest, premiumClaimInstructions } from "./premiumClaimVerification";
import {
  analyzeWorld,
  buildWorldPremiumVerificationPages,
  parseWorldFindingsFromModel,
  persistedLocalVerificationPacket,
  quoteWorldAnalysisReservation,
  worldVerificationRequest,
  type AnalysisChunk,
} from "./worldAnalysis";
import { proposalForPremiumVerificationPage } from "./premiumVerificationPages";

const scope = {
  worldId: "00000000-0000-4000-8000-000000000601",
  editionId: "00000000-0000-4000-8000-000000000602",
  analysisRunId: "00000000-0000-4000-8000-000000000603",
};
const chunk: AnalysisChunk = {
  id: "claim-reservation-chunk",
  sourceId: "claim-reservation-source",
  sourceTitle: "Synthetic Evidence",
  index: 0,
  content: "Mara believed the eastern gate was lost. The eastern gate remained open. Mara read <門>& on its arch.",
};
const local = parseWorldFindingsFromModel({
  claims: [{
    subject: "eastern gate", predicate: "status", value: "lost",
    epistemicHolder: "Mara", truthStatus: "belief", polarity: "positive",
    evidence: [{ chunkId: chunk.id, quote: "Mara believed the eastern gate was lost." }],
  }, {
    subject: "eastern gate", predicate: "status", value: "open",
    epistemicHolder: "", truthStatus: "fact", polarity: "positive",
    evidence: [{ chunkId: chunk.id, quote: "The eastern gate remained open." }],
  }, {
    subject: "eastern gate", predicate: "inscription", value: "<門>&",
    epistemicHolder: "", truthStatus: "fact", polarity: "positive",
    evidence: [{ chunkId: chunk.id, quote: "Mara read <門>& on its arch." }],
  }],
}, [chunk], "candidate");

function input() {
  return {
    worldName: "Reservation Fixture", premise: "", genre: "",
    chunks: [chunk], sources: [], persistedLocalFindings: local,
    premiumClaimScope: scope,
    existingCanonContext: "Earlier material is context, not manuscript evidence.",
    externalReferenceContext: "", userGuidance: "Keep Mara's belief distinct from the gate's observed state.",
  };
}

/** Fake configuration enables pricing only; every network call is forbidden. */
async function withPricingRuntime(run: () => Promise<void> | void) {
  const environment = {
    STORYHOLD_VERIFICATION_PROVIDER: "openrouter",
    STORYHOLD_CHRONOLOGY_PROVIDER: "openrouter",
    STORYHOLD_OPENROUTER_API_KEY: "fake-claim-reservation-test-key",
    STORYHOLD_OPENROUTER_CHRONOLOGY_MODEL: "mistralai/mistral-small-2603",
  };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    Object.assign(process.env, environment);
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("Provider calls are forbidden in claim reservation fixtures.");
    };
    await run();
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function plannedRequest(params = input()) {
  const pages = buildWorldPremiumVerificationPages(params);
  assert.equal(pages.length, 1);
  return worldVerificationRequest(params, [chunk], 0, pages.length,
    proposalForPremiumVerificationPage(persistedLocalVerificationPacket(params.persistedLocalFindings, [chunk]), pages[0]!),
    undefined, undefined, pages[0]);
}

test("claim reservation prices the complete receipt prompt and a 16,000-token output ceiling", async () => {
  await withPricingRuntime(() => {
    const params = input();
    const packet = persistedLocalVerificationPacket(local, [chunk]);
    assert.equal(packet.claims?.length, 3);
    const claimRequest = buildPremiumClaimRequest({
      scope, stepKey: "verification:0",
      chunks: [{ id: chunk.id, sourceId: chunk.sourceId, text: chunk.content }],
      claims: packet.claims ?? [],
      context: params,
    });
    const request = plannedRequest(params);
    const message = request.messages[0]!.content;
    assert.ok(message.includes(premiumClaimInstructions(claimRequest)), "the full scope-bound receipt instructions must be included in the priced prompt");
    assert.ok(message.includes(claimRequest.fingerprint));
    assert.ok(claimRequest.proposals.every((proposal) => message.includes(proposal.id)));
    assert.equal(request.maxOutputTokens, 16_000);

    const quote = quoteAiCostReservation(request);
    const serializedInput = [request.system, ...request.messages.map((item) => `${item.role}:${item.content}`)].join("\n");
    assert.equal(quote.inputUnits, Math.ceil(Buffer.byteLength(serializedInput, "utf8") / 2.2) + 256);
    assert.equal(quote.maxOutputUnits, 16_000);
    assert.equal(quote.pricingKnown, true);
    assert.ok(quote.maximumCostMicros > quoteAiCostReservation({ ...request, maxOutputTokens: 8_000 }).maximumCostMicros);
  });
});

test("whole-run reservation includes the claim verifier plus bounded synthesis without a second claim call", async () => {
  await withPricingRuntime(() => {
    const params = input();
    const request = plannedRequest(params);
    const verifier = quoteAiCostReservation(request);
    const total = quoteWorldAnalysisReservation(params);
    assert.equal(verifier.pricingKnown, true);
    assert.equal(total.pricingKnown, true);
    assert.ok(total.maximumCostMicros > verifier.maximumCostMicros, "the full verifier quote must be reserved in addition to synthesis");
    assert.equal(total.batchCount, 5, "one verification request and four bounded synthesis reservations; no extra claim call");
  });
});

test("claim prompt growth changes the reservation by the exact verifier cost while synthesis holds stay unchanged", async () => {
  await withPricingRuntime(() => {
    const params = input();
    const emptyLocal = { ...local, claims: [] };
    const fullRequest = plannedRequest(params);
    const emptyRequest = plannedRequest({ ...params, persistedLocalFindings: emptyLocal });
    const full = quoteWorldAnalysisReservation(params);
    const empty = quoteWorldAnalysisReservation({ ...params, persistedLocalFindings: emptyLocal });
    assert.equal(full.pricingKnown, true);
    assert.equal(empty.pricingKnown, true);
    assert.ok(full.maximumCostMicros > empty.maximumCostMicros);
    assert.equal(
      full.maximumCostMicros - empty.maximumCostMicros,
      quoteAiCostReservation(fullRequest).maximumCostMicros - quoteAiCostReservation(emptyRequest).maximumCostMicros,
    );
    assert.equal(full.batchCount, empty.batchCount);
  });
});

test("connected execution constructs the same claim request that was reserved before any provider call", async () => {
  await withPricingRuntime(async () => {
    const params = input();
    const quotedRequest = plannedRequest(params);
    const stopBeforeProvider = new Error("Reservation-only fixture stops before dispatch.");
    let captured: GenerateAiTextInput | undefined;
    await assert.rejects(analyzeWorld({
      ...params,
      analysisMode: "connected",
      executePremiumCall: async (stepKey, request) => {
        assert.equal(stepKey, "verification:0");
        captured = request;
        throw stopBeforeProvider;
      },
    }), (error: unknown) => error === stopBeforeProvider);
    assert.ok(captured);
    assert.equal(captured.maxOutputTokens, 16_000);
    assert.deepEqual(captured.messages, quotedRequest.messages);
    assert.equal(captured.system, quotedRequest.system);
    assert.deepEqual(quoteAiCostReservation(captured), quoteAiCostReservation(quotedRequest));
  });
});

test("premium reservation fails closed without its saved candidate graph", async () => {
  await withPricingRuntime(() => {
    const { persistedLocalFindings: _findings, ...withoutGraph } = input();
    assert.throws(() => quoteWorldAnalysisReservation(withoutGraph), /requires the saved Lorekeeper evidence graph/u);
  });
});

// Dense selected packets are paginated; the reservation prices every exact
// page request while the source-based synthesis allowance stays unchanged.
