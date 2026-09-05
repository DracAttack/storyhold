import assert from "node:assert/strict";
import test from "node:test";
import {
  getAiRuntimeStatus,
  type AiTextResult,
  type GenerateAiTextInput,
} from "./aiGateway";
import { PremiumJournalError } from "./premiumReviewJournal";
import {
  analyzeWorld,
  parseWorldFindingsFromModel,
  type AnalysisChunk,
  type ChronologyFinding,
  type WorldAnalysisInput,
} from "./worldAnalysis";
import {
  approvedWorldClockProjection,
  type WorldClockPayload,
} from "./worldClockVerification";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

const WORLD_ID = uuid(1);
const EDITION_ID = uuid(2);
const RUN_ID = uuid(3);
const SOURCE_ID = uuid(4);
const CHUNK_ID = uuid(5);
const MARA_ID = uuid(11);
const ROWAN_ID = uuid(12);
const CITADEL_ID = uuid(13);
const OPENING_QUOTE = "At dawn, Mara opened the north gate while Rowan watched from the Citadel wall.";
const ENTRY_QUOTE = "Opening the north gate allowed Rowan to enter the Citadel before sunrise.";
const CHUNK: AnalysisChunk = {
  id: CHUNK_ID,
  sourceId: SOURCE_ID,
  sourceTitle: "Synthetic Manuscript",
  index: 0,
  content: `${OPENING_QUOTE} ${ENTRY_QUOTE}`,
};
const COMPLETED_AT = "2026-09-04T20:15:00.000Z";

type VerificationContract = {
  requestFingerprint: string;
  proposals: Array<{ id: string }>;
};

type ClockPromptInventory = {
  requestFingerprint: string;
  pageManifestFingerprint: string;
  page: { index: number; count: number; proposalIds: string[] };
  entities: Array<{ id: string; name: string; entityType: string; aliases: string[] }>;
  eventRegistry: Array<{ eventId: string; name: string }>;
  ownerConstraints: Array<{ id: string; kind: string; instruction: string; fingerprint: string }>;
  proposals: Array<{ id: string; payload: WorldClockPayload; evidenceIds: string[] }>;
  evidence: Array<{ id: string; chunkId: string; quote: string }>;
};

function marker(request: GenerateAiTextInput, kind: "CLAIM" | "GRAPH" | "STAT"): VerificationContract {
  const match = request.messages.map((message) => message.content).join("\n")
    .match(new RegExp(`<${kind}_VERIFICATION_REQUEST trust="unverified">\\s*([\\s\\S]*?)\\s*</${kind}_VERIFICATION_REQUEST>`, "u"));
  assert.ok(match, `${kind} verification request must be present`);
  return JSON.parse(match[1]!) as VerificationContract;
}

function clockInventory(request: GenerateAiTextInput): ClockPromptInventory {
  const match = request.system.match(
    /<WORLD_CLOCK_INVENTORY trust="unverified">\s*([\s\S]*?)\s*<\/WORLD_CLOCK_INVENTORY>/u,
  );
  assert.ok(match, "modern chronology request must contain its frozen World Clock inventory");
  return JSON.parse(match[1]!) as ClockPromptInventory;
}

function proposedChronology(request: GenerateAiTextInput): ChronologyFinding[] {
  const match = request.messages.map((message) => message.content).join("\n")
    .match(/<PROPOSED_BATCH_FINDINGS trust="unverified">\s*([\s\S]*?)\s*<\/PROPOSED_BATCH_FINDINGS>/u);
  assert.ok(match, "verification request must contain its assigned frozen findings");
  const proposed = JSON.parse(match[1]!) as { chronology?: ChronologyFinding[] };
  return proposed.chronology ?? [];
}

function result(request: GenerateAiTextInput, body: unknown, model: string): AiTextResult {
  const text = JSON.stringify(body);
  assert.equal(typeof request.validate, "function");
  request.validate!(text);
  const runtime = getAiRuntimeStatus(request.task, request.contentMode, request.stage);
  return {
    text,
    runtime,
    provider: "openrouter",
    model,
    reasoning: "high",
    journalCompletedAt: COMPLETED_AT,
    usage: {
      inputUnits: 40,
      outputUnits: 20,
      cachedInputUnits: 0,
      cacheWriteInputUnits: 0,
      reasoningUnits: 0,
      estimatedCostMicros: 300,
      pricingKnown: true,
      pricingVersion: "clock-runtime-fixture",
      costEstimated: true,
    },
  };
}

function emptyVerificationGates(request: GenerateAiTextInput) {
  const claims = marker(request, "CLAIM");
  const graph = marker(request, "GRAPH");
  const stats = marker(request, "STAT");
  assert.deepEqual(claims.proposals, []);
  assert.deepEqual(graph.proposals, []);
  assert.deepEqual(stats.proposals, []);
  return {
    claims: [],
    entityRelations: [],
    entityRules: [],
    claimVerification: {
      requestFingerprint: claims.requestFingerprint,
      decisions: [],
      newClaims: [],
    },
    graphVerification: {
      requestFingerprint: graph.requestFingerprint,
      decisions: [],
      newFindings: [],
    },
    statVerification: {
      requestFingerprint: stats.requestFingerprint,
      decisions: [],
      newStats: [],
    },
  };
}

function chronology(): ChronologyFinding[] {
  return [
    {
      name: "Mara Opens the North Gate",
      summary: "Mara opens the north gate while Rowan watches.",
      worldTimeLabel: "Before sunrise",
      temporalStatus: "relative",
      importance: "turning_point",
      sourceChapterKeys: [`${SOURCE_ID}:chapter-1`],
      actors: ["Mara"],
      witnesses: ["Rowan"],
      locations: ["Citadel"],
      eventRelations: [{
        targetEvent: "Rowan Enters the Citadel",
        relationType: "enables",
        summary: "The open gate allows Rowan to enter.",
        evidence: [{ chunkId: CHUNK_ID, sourceId: SOURCE_ID, quote: ENTRY_QUOTE }],
        confidence: 0.9,
      }],
      truthStatus: "fact",
      epistemicHolderId: null,
      evidence: [{ chunkId: CHUNK_ID, sourceId: SOURCE_ID, quote: OPENING_QUOTE }],
      confidence: 0.94,
    },
    {
      name: "Rowan Enters the Citadel",
      summary: "Rowan enters the Citadel through the open north gate.",
      worldTimeLabel: "Before sunrise",
      temporalStatus: "relative",
      importance: "major",
      sourceChapterKeys: [`${SOURCE_ID}:chapter-1`],
      actors: ["Rowan"],
      locations: ["Citadel"],
      truthStatus: "fact",
      epistemicHolderId: null,
      evidence: [{ chunkId: CHUNK_ID, sourceId: SOURCE_ID, quote: ENTRY_QUOTE }],
      confidence: 0.91,
    },
  ];
}

function params(events: ChronologyFinding[] = chronology()): WorldAnalysisInput {
  const local = parseWorldFindingsFromModel({ chronology: events }, [CHUNK], "candidate");
  return {
    worldName: "Clock Runtime Fixture",
    premise: "A gate changes the balance of the Citadel.",
    genre: "Fantasy",
    chunks: [CHUNK],
    sources: [],
    persistedLocalFindings: local,
    premiumClaimScope: {
      worldId: WORLD_ID,
      editionId: EDITION_ID,
      analysisRunId: RUN_ID,
    },
    premiumClockReviewVersion: 1,
    premiumClockEntityRegistry: [
      { id: MARA_ID, name: "Mara Vale", entityType: "character", aliases: ["Mara"] },
      { id: ROWAN_ID, name: "Rowan", entityType: "character", aliases: [] },
      { id: CITADEL_ID, name: "The Citadel", entityType: "place", aliases: ["Citadel"] },
    ],
    premiumClockOwnerConstraints: [{
      id: "owner-clock-gate",
      kind: "timeline",
      instruction: "Rowan enters only after Mara opens the north gate.",
      scopeEntityId: ROWAN_ID,
    }],
    analysisMode: "connected",
  };
}

function verificationBody(request: GenerateAiTextInput, events = proposedChronology(request)) {
  return {
    chronology: events,
    coverage: [{ chunkId: CHUNK_ID, status: "findings" }],
    ...emptyVerificationGates(request),
  };
}

function clockBody(
  inventory: ClockPromptInventory,
  verdict: (payload: WorldClockPayload) => "verified" | "rejected" = () => "verified",
) {
  return {
    chapterSummaries: [],
    chronology: [],
    clockVerification: {
      requestFingerprint: inventory.requestFingerprint,
      decisions: inventory.proposals.map((proposal) => {
        const decision = verdict(proposal.payload);
        const anchor = proposal.evidenceIds
          .map((id) => inventory.evidence.find((evidence) => evidence.id === id))
          .find(Boolean) ?? inventory.evidence[0];
        assert.ok(anchor, "every runtime fixture proposal needs a frozen evidence anchor");
        return {
          proposalId: proposal.id,
          verdict: decision,
          correctedPayload: null,
          supportingEvidence: decision === "verified"
            ? [{ chunkId: anchor.chunkId, quote: anchor.quote }]
            : [],
          contradictingEvidence: [],
          confidence: decision === "verified" ? 0.9 : 0.2,
          explanation: decision === "verified"
            ? "The exact manuscript passage supports this one clock record."
            : "The passage does not establish this separate clock record.",
          retrievalRequests: [],
        };
      }),
    },
  };
}

async function offline(run: () => Promise<void>) {
  const environment = {
    STORYHOLD_VERIFICATION_PROVIDER: "openrouter",
    STORYHOLD_OPENROUTER_API_KEY: "fake-world-clock-key",
    STORYHOLD_OPENROUTER_VERIFICATION_MODEL: "openai/gpt-4o-mini",
  };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    Object.assign(process.env, environment);
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("Network calls are forbidden in World Clock runtime tests.");
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

test("v3 runtime binds one global clock inventory, crosses the journal boundary, and projects receipts only", async () => {
  await offline(async () => {
    const input = params();
    const order: string[] = [];
    let observedInventory: ClockPromptInventory | undefined;
    const output = await analyzeWorld({
      ...input,
      assertPremiumChronologyPrefix: async (manifest) => {
        assert.equal(manifest.version, 1);
        assert.equal(manifest.runId, RUN_ID);
        assert.equal(manifest.worldId, WORLD_ID);
        assert.equal(manifest.editionId, EDITION_ID);
        assert.equal(manifest.pageCount, 1);
        assert.match(manifest.pageManifestFingerprint, /^clock_page_manifest_[0-9a-f]{64}$/u);
        assert.match(manifest.inputFingerprint, /^clock_inventory_[0-9a-f]{64}$/u);
        assert.match(manifest.requestManifestFingerprint, /^canon_payload_[0-9a-f]{64}$/u);
        order.push(`prefix:${manifest.pageCount}`);
      },
      executePremiumCall: async (step, request) => {
        order.push(step);
        if (step === "verification:0") {
          return result(request, verificationBody(request), "verification-fixture-model");
        }
        assert.equal(step, "chronology:0");
        const inventory = clockInventory(request);
        observedInventory = inventory;
        assert.deepEqual(inventory.entities, input.premiumClockEntityRegistry);
        assert.equal(inventory.ownerConstraints.length, 1);
        assert.equal(inventory.ownerConstraints[0]!.id, "owner-clock-gate");
        assert.equal(
          inventory.ownerConstraints[0]!.instruction,
          "Rowan enters only after Mara opens the north gate.",
        );
        const recordTypes = inventory.proposals.map((proposal) => proposal.payload.recordType);
        assert.equal(recordTypes.filter((kind) => kind === "event").length, 2);
        assert.equal(recordTypes.filter((kind) => kind === "participant").length, 5);
        assert.equal(recordTypes.filter((kind) => kind === "event_relation").length, 1);
        return result(
          request,
          clockBody(inventory, (payload) =>
            payload.recordType === "participant" && payload.role === "witness"
              ? "rejected"
              : payload.recordType === "event_relation"
                ? "rejected"
                : "verified"),
          "clock-fixture-model",
        );
      },
    });

    assert.deepEqual(order, ["verification:0", "prefix:1", "chronology:0"]);
    assert.ok(observedInventory);
    assert.equal(output.clockReviews?.length, 1);
    assert.equal(output.clockReviews?.[0]?.verifier.provider, "openrouter");
    assert.equal(output.clockReviews?.[0]?.verifier.model, "clock-fixture-model");
    assert.equal(output.clockReviews?.[0]?.verifier.completedAt, COMPLETED_AT);
    assert.ok(output.clockInput);
    const projection = approvedWorldClockProjection(output.clockInput, output.clockReviews ?? []);
    assert.equal(projection.events.length, 2);
    assert.equal(projection.participants.length, 4);
    assert.equal(projection.relations.length, 0);
    assert.equal(output.findings.chronology.length, 2);
    const opening = output.findings.chronology.find((event) => event.name === "Mara Opens the North Gate");
    assert.ok(opening);
    assert.deepEqual(opening.witnesses, []);
    assert.deepEqual(opening.eventRelations, []);
    assert.equal(output.coverage?.complete, true);
  });
});

function pagedChronology(count = 17): ChronologyFinding[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `Gate Signal ${index + 1}`,
    summary: `Mara gives gate signal ${index + 1}.`,
    worldTimeLabel: `Signal ${index + 1}`,
    temporalStatus: "relative" as const,
    importance: "major" as const,
    sourceChapterKeys: [`${SOURCE_ID}:chapter-1`],
    actors: ["Mara"],
    truthStatus: "fact" as const,
    epistemicHolderId: null,
    evidence: [{ chunkId: CHUNK_ID, sourceId: SOURCE_ID, quote: OPENING_QUOTE }],
    confidence: 0.8,
  }));
}

for (const failure of ["invalid", "rejected", "uncertain"] as const) {
  test(`v3 runtime fails fast after a ${failure} first clock page and never calls the next chronology page`, async () => {
    await offline(async () => {
      const events = pagedChronology();
      const steps: string[] = [];
      await assert.rejects(analyzeWorld({
        ...params(events),
        assertPremiumChronologyPrefix: async (manifest) => {
          assert.equal(manifest.pageCount, 2);
          assert.match(manifest.requestManifestFingerprint, /^canon_payload_[0-9a-f]{64}$/u);
          steps.push("prefix:2");
        },
        executePremiumCall: async (step, request) => {
          steps.push(step);
          if (step.startsWith("verification:")) {
            return result(request, verificationBody(request), "verification-fixture-model");
          }
          assert.equal(step, "chronology:0");
          if (failure === "invalid") {
            return result(request, {
              chapterSummaries: [], chronology: [],
              clockVerification: {
                requestFingerprint: clockInventory(request).requestFingerprint,
                decisions: [],
              },
            }, "clock-fixture-model");
          }
          if (failure === "uncertain") {
            throw new PremiumJournalError("OUTCOME_UNRESOLVED", "The paid clock outcome is uncertain.");
          }
          throw new Error("The provider rejected the clock page.");
        },
      }), failure === "invalid"
        ? /exactly one explicit decision|complete durable receipt/iu
        : /uncertain|rejected/iu);
      assert.deepEqual(steps, [
        "verification:0", "verification:1", "verification:2", "prefix:2", "chronology:0",
      ]);
    });
  });
}
