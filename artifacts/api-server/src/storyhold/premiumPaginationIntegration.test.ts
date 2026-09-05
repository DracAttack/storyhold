import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { getAiRuntimeStatus, quoteAiCostReservation, type AiTextResult, type GenerateAiTextInput } from "./aiGateway";
import {
  analyzeWorld, buildWorldPremiumVerificationPages, parseWorldFindingsFromModel,
  quoteWorldAnalysisReservation, type AnalysisChunk, type WorldAnalysisInput,
} from "./worldAnalysis";
import {
  executeJournaledPremiumCall, premiumReviewJournalSchemaSql, readPremiumJournalAccounting,
} from "./premiumReviewJournal";

const scope = {
  worldId: "00000000-0000-4000-8000-000000000801",
  editionId: "00000000-0000-4000-8000-000000000802",
  analysisRunId: "00000000-0000-4000-8000-000000000803",
};
const playerId = "00000000-0000-4000-8000-000000000804";
const reservationId = "00000000-0000-4000-8000-000000000805";

function fixture(count = 14): WorldAnalysisInput {
  const sentences = Array.from({ length: count }, (_, index) => `Gate ${index} remained open through the winter.`);
  const chunk: AnalysisChunk = {
    id: "pagination-chunk", sourceId: "pagination-source", sourceTitle: "Synthetic gates", index: 0,
    content: sentences.join(" ") || "The road continued through an otherwise empty valley.",
  };
  const persistedLocalFindings = parseWorldFindingsFromModel({
    claims: sentences.map((quote, index) => ({
      subject: `Gate ${index}`, predicate: "status", value: "open", polarity: "positive",
      epistemicHolder: "", truthStatus: "fact", validFromLabel: "winter", validUntilLabel: "",
      confidence: 0.95, evidence: [{ chunkId: chunk.id, quote }],
    })),
  }, [chunk], "candidate");
  assert.equal(persistedLocalFindings.claims?.length, count);
  return {
    worldName: "Pagination Fixture", premise: "", genre: "", chunks: [chunk], sources: [],
    premiumClaimScope: scope, persistedLocalFindings, analysisMode: "connected",
  };
}

type Contract = { requestFingerprint: string; proposals: Array<{ id: string; payload: Record<string, unknown> }> };
function contract(request: GenerateAiTextInput, kind: "CLAIM" | "GRAPH"): Contract {
  const text = request.messages.map((message) => message.content).join("\n");
  const marker = text.match(new RegExp(`<${kind}_VERIFICATION_REQUEST trust="unverified">\\s*([\\s\\S]*?)\\s*</${kind}_VERIFICATION_REQUEST>`, "u"));
  assert.ok(marker, `${kind} decisions must be bound to the page request`);
  return JSON.parse(marker[1]!) as Contract;
}

function resultForPage(request: GenerateAiTextInput, params: WorldAnalysisInput, verified = true): AiTextResult {
  const claims = contract(request, "CLAIM");
  const graph = contract(request, "GRAPH");
  assert.equal(graph.proposals.length, 0);
  const decisions = claims.proposals.map((proposal) => ({
    proposalId: proposal.id, verdict: verified ? "verified" : "rejected",
    explanation: verified ? "The supplied passage directly states this condition." : "This proposed interpretation is not retained.",
    confidence: 0.95,
    supportingEvidence: verified ? [{ chunkId: params.chunks[0]!.id, quote: `${proposal.payload.subject} remained open through the winter.` }] : [],
    contradictingEvidence: [], retrievalRequests: [],
  }));
  const body = {
    claims: [], entityRelations: [], entityRules: [],
    claimVerification: { requestFingerprint: claims.requestFingerprint, decisions, newClaims: [] },
    graphVerification: { requestFingerprint: graph.requestFingerprint, decisions: [], newFindings: [] },
    coverage: params.chunks.map((chunk) => ({ chunkId: chunk.id, status: verified && decisions.length ? "findings" : "no_findings" })),
  };
  const text = JSON.stringify(body);
  request.validate!(text);
  const runtime = getAiRuntimeStatus(request.task, request.contentMode, request.stage);
  assert.equal(runtime.provider, "openrouter");
  return {
    text, journalCompletedAt: "2026-09-03T00:00:00.000Z", runtime, provider: runtime.provider,
    model: runtime.model, reasoning: "high", usage: {
      inputUnits: 10, outputUnits: 5, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
      estimatedCostMicros: 100, pricingKnown: true, pricingVersion: "fixture", costEstimated: true,
    },
  };
}

/** Pricing is configured with a synthetic key; real fetch is forbidden. */
async function offline(run: () => Promise<void>) {
  const environment = {
    STORYHOLD_VERIFICATION_PROVIDER: "openrouter", STORYHOLD_CHRONOLOGY_PROVIDER: "openrouter",
    STORYHOLD_OPENROUTER_API_KEY: "fake-pagination-fixture-key",
    STORYHOLD_OPENROUTER_CHRONOLOGY_MODEL: "mistralai/mistral-small-2603",
  };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    Object.assign(process.env, environment);
    globalThis.fetch = async () => { fetchCalls += 1; throw new Error("Network is forbidden in pagination fixtures."); };
    await run();
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("fourteen selected claims use three bounded calls without losing or duplicating a candidate", async () => {
  await offline(async () => {
    const params = fixture();
    const pages = buildWorldPremiumVerificationPages(params);
    assert.equal(pages.length, 3);
    const steps: string[] = [];
    const subjects: string[] = [];
    const proposalIds: string[] = [];
    const result = await analyzeWorld({
      ...params, premiumVerificationPages: pages,
      executePremiumCall: async (stepKey, request) => {
        steps.push(stepKey);
        if (stepKey !== "verification:0") assert.match(request.system, /candidate-continuation page.*overrides the general world-analysis shape/su);
        const proposals = contract(request, "CLAIM").proposals;
        assert.ok(proposals.length <= 6 && proposals.length > 0);
        subjects.push(...proposals.map((proposal) => String(proposal.payload.subject)));
        proposalIds.push(...proposals.map((proposal) => proposal.id));
        return resultForPage(request, params);
      },
    });
    assert.deepEqual(steps, ["verification:0", "verification:1", "verification:2"]);
    assert.equal(subjects.length, 14);
    assert.equal(new Set(subjects).size, 14);
    assert.equal(new Set(proposalIds).size, 14);
    assert.deepEqual(result.findings.claims?.map((claim) => claim.subject).sort(), subjects.sort());
    assert.equal(result.claimReviews?.length, 3);
    assert.equal(result.graphReviews?.length, 3, "even empty graph pages require a receipt");
    assert.equal(result.coverage?.batches.length, 1, "coverage counts source batches, not candidate pages");
    assert.deepEqual(result.coverage?.batches[0]?.chunks, [{ chunkId: params.chunks[0]!.id, status: "findings" }]);
    assert.equal(result.coverage?.complete, true);
    assert.equal(result.usage.estimatedCostMicros, 300);
  });
});

test("source coverage waits for all pages and ORs findings across a no-findings page", async () => {
  await offline(async () => {
    const params = fixture();
    const steps: string[] = [];
    const states: string[] = [];
    const result = await analyzeWorld({
      ...params,
      executePremiumCall: async (step, request) => {
        steps.push(step);
        return resultForPage(request, params, step === "verification:1");
      },
      onCoverage: (coverage) => {
        assert.equal(steps.length, 3, "no source passage is complete while a candidate page remains unchecked");
        assert.equal(coverage.batches.length, 1);
        states.push(coverage.batches[0]!.chunks[0]!.status);
      },
    });
    assert.ok(states.length > 0);
    assert.ok(states.every((status) => status === "findings"));
    assert.equal(result.findings.claims?.length, 6);
    assert.equal(result.coverage?.complete, true);
  });
});

test("missing, altered, and reordered frozen candidate pages stop before any dispatch", async () => {
  await offline(async () => {
    const params = fixture();
    const pages = buildWorldPremiumVerificationPages(params);
    const altered = structuredClone(pages);
    altered[0]!.packetFingerprint = "changed-packet-fingerprint";
    let calls = 0;
    for (const invalid of [[], pages.slice(1), [...pages].reverse(), [...pages, pages[0]!], altered]) {
      await assert.rejects(analyzeWorld({
        ...params, premiumVerificationPages: invalid,
        executePremiumCall: async () => { calls += 1; throw new Error("An invalid page reached dispatch."); },
      }), /page|frozen|verification/i);
    }
    assert.equal(calls, 0);
  });
});

test("a source without typed candidates still receives one complete discovery review", async () => {
  await offline(async () => {
    const params = fixture(0);
    assert.equal(buildWorldPremiumVerificationPages(params).length, 1);
    const steps: string[] = [];
    const result = await analyzeWorld({
      ...params,
      executePremiumCall: async (step, request) => { steps.push(step); return resultForPage(request, params); },
    });
    assert.deepEqual(steps, ["verification:0"]);
    assert.equal(result.coverage?.complete, true);
    assert.deepEqual(result.coverage?.batches[0]?.chunks, [{ chunkId: params.chunks[0]!.id, status: "no_findings" }]);
  });
});

test("global page keys remain sequential across source batches and preserve separate source coverage", async () => {
  await offline(async () => {
    const dense = fixture();
    const empty: AnalysisChunk = {
      id: "empty-second-source-chunk", sourceId: "empty-second-source", sourceTitle: "A quiet interlude",
      index: 0, content: "Rain fell throughout the afternoon, and nothing else happened.",
    };
    const params: WorldAnalysisInput = {
      ...dense, chunks: [...dense.chunks, empty],
      premiumVerificationBatches: [[dense.chunks[0]!.id], [empty.id]],
    };
    const pages = buildWorldPremiumVerificationPages(params);
    assert.equal(pages.length, 4);
    const steps: string[] = [];
    const completedBatchCounts: number[] = [];
    const result = await analyzeWorld({
      ...params, premiumVerificationPages: pages,
      executePremiumCall: async (step, request) => {
        steps.push(step);
        return resultForPage(request, { ...params, chunks: step === "verification:3" ? [empty] : dense.chunks });
      },
      onCoverage: (coverage) => {
        completedBatchCounts.push(coverage.batches.length);
        if (coverage.batches.length === 1) assert.equal(steps.length, 3);
        else assert.equal(steps.length, 4);
      },
    });
    assert.deepEqual(steps, ["verification:0", "verification:1", "verification:2", "verification:3"]);
    assert.equal(completedBatchCounts[0], 1);
    assert.equal(completedBatchCounts.at(-1), 2);
    assert.deepEqual(result.coverage?.batches.map((batch) => batch.chunks), [
      [{ chunkId: dense.chunks[0]!.id, status: "findings" }],
      [{ chunkId: empty.id, status: "no_findings" }],
    ]);
    assert.equal(quoteWorldAnalysisReservation(params).batchCount, 12,
      "four verification pages reserve eight synthesis calls for two source batches");
  });
});

test("reservation prices every actual page without multiplying the source-batch synthesis allowance", async () => {
  await offline(async () => {
    const params = fixture();
    const noClaims = { ...params, persistedLocalFindings: { ...params.persistedLocalFindings!, claims: [] } };
    const total = quoteWorldAnalysisReservation(params);
    const emptyTotal = quoteWorldAnalysisReservation(noClaims);
    assert.equal(total.pricingKnown, true);
    assert.equal(emptyTotal.pricingKnown, true);
    assert.equal(total.batchCount, 7, "three verification pages plus four source-batch synthesis reservations");
    assert.equal(emptyTotal.batchCount, 5, "one discovery page plus the same four synthesis reservations");
    const pageQuotes: number[] = [];
    await analyzeWorld({
      ...params,
      executePremiumCall: async (_step, request) => {
        pageQuotes.push(quoteAiCostReservation(request).maximumCostMicros);
        return resultForPage(request, params);
      },
    });
    const emptyQuotes: number[] = [];
    await analyzeWorld({
      ...noClaims,
      executePremiumCall: async (_step, request) => {
        emptyQuotes.push(quoteAiCostReservation(request).maximumCostMicros);
        return resultForPage(request, noClaims);
      },
    });
    assert.equal(pageQuotes.length, 3);
    assert.equal(emptyQuotes.length, 1);
    assert.equal(total.maximumCostMicros - emptyTotal.maximumCostMicros,
      pageQuotes.reduce((sum, cost) => sum + cost, 0) - emptyQuotes[0]!);
  });
});

async function journalDatabase(): Promise<PGlite> {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.world_analysis_runs (id uuid PRIMARY KEY, world_id uuid NOT NULL, requested_by_player_id uuid NOT NULL);
      CREATE TABLE storyhold.credit_reservations (
        id uuid PRIMARY KEY, world_id uuid NOT NULL, player_id uuid NOT NULL,
        operation text NOT NULL, request_id text NOT NULL, status text NOT NULL DEFAULT 'reserved',
        reserved_credits integer NOT NULL DEFAULT 20, usage jsonb NOT NULL DEFAULT '{}'::jsonb
      );
    `);
    await db.exec(premiumReviewJournalSchemaSql);
    await db.query("INSERT INTO storyhold.world_analysis_runs VALUES ($1, $2, $3)", [scope.analysisRunId, scope.worldId, playerId]);
    await db.query("INSERT INTO storyhold.credit_reservations (id, world_id, player_id, operation, request_id) VALUES ($1, $2, $3, 'world_analysis', $4)",
      [reservationId, scope.worldId, playerId, scope.analysisRunId]);
    return db;
  } catch (error) { await db.close(); throw error; }
}

test("interruption before the second page keeps coverage incomplete and replays the first paid result once", async () => {
  await offline(async () => {
    const db = await journalDatabase();
    try {
      const base = fixture();
      const params = { ...base, premiumVerificationPages: buildWorldPremiumVerificationPages(base) };
      const invocations: string[] = [];
      let coverageWrites = 0;
      const interruption = new Error("Synthetic interruption before second page dispatch");
      const executor = (interrupt: boolean): NonNullable<WorldAnalysisInput["executePremiumCall"]> => async (step, request) => {
        if (interrupt && step === "verification:1") throw interruption;
        const runtime = getAiRuntimeStatus(request.task, request.contentMode, request.stage);
        return executeJournaledPremiumCall(db, {
          runId: scope.analysisRunId, reservationId, stepKey: step, request,
          provider: runtime.provider, model: runtime.model, scopeFingerprint: "synthetic-pagination-plan",
          invoke: async () => { invocations.push(step); return resultForPage(request, params); },
        });
      };
      await assert.rejects(analyzeWorld({
        ...params, executePremiumCall: executor(true), onCoverage: () => { coverageWrites += 1; },
      }), (error: unknown) => error === interruption);
      assert.deepEqual(invocations, ["verification:0"]);
      assert.equal(coverageWrites, 0);
      const saved = await readPremiumJournalAccounting(db, scope.analysisRunId);
      assert.equal(saved.callCount, 1);
      assert.equal(saved.hasUncertain, false);
      const restored = JSON.parse(JSON.stringify(params)) as WorldAnalysisInput;
      const resumed = await analyzeWorld({ ...restored, executePremiumCall: executor(false) });
      assert.deepEqual(invocations, ["verification:0", "verification:1", "verification:2"]);
      assert.equal(resumed.findings.claims?.length, 14);
      assert.equal(resumed.coverage?.complete, true);
      assert.equal(resumed.usage.estimatedCostMicros, 300, "replayed results are counted once in the rebuilt usage result");
      const accounting = await readPremiumJournalAccounting(db, scope.analysisRunId);
      assert.equal(accounting.callCount, 3);
      assert.equal(accounting.attempts.length, 3);
      assert.equal(accounting.hasUncertain, false);
      const hold = (await db.query<{ status: string; reserved_credits: number }>("SELECT status, reserved_credits FROM storyhold.credit_reservations")).rows;
      assert.deepEqual(hold, [{ status: "reserved", reserved_credits: 20 }]);
    } finally { await db.close(); }
  });
});
