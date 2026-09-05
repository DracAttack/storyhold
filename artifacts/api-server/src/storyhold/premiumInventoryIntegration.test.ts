import assert from "node:assert/strict";
import test from "node:test";
import { getAiRuntimeStatus, quoteAiCostReservation, type AiTextResult, type GenerateAiTextInput } from "./aiGateway";
import {
  analyzeWorld, buildWorldPremiumVerificationPages, mergeWorldFindings, parseWorldFindingsFromModel,
  persistedLocalVerificationPacket, quoteWorldAnalysisReservation,
  type AnalysisChunk, type WorldAnalysisInput, type WorldFindings,
} from "./worldAnalysis";

const scope = {
  worldId: "00000000-0000-4000-8000-000000000901",
  editionId: "00000000-0000-4000-8000-000000000902",
  analysisRunId: "00000000-0000-4000-8000-000000000903",
};
const families = ["characters", "locations", "chronology", "claims"] as const;

function fixture(countPerFamily = 8): WorldAnalysisInput {
  const lines = families.flatMap((family) => Array.from({ length: countPerFamily }, (_, index) =>
    `${family === "characters" ? "Keeper" : family === "locations" ? "Harbor" : family === "chronology" ? "Arrival" : "Gate"} ${index} remained open through the winter.`));
  const chunk: AnalysisChunk = {
    id: "inventory-chunk", sourceId: "inventory-source", sourceTitle: "Synthetic inventory", index: 0,
    content: lines.join(" ") || "Snow fell on an empty road.",
  };
  const persistedLocalFindings = parseWorldFindingsFromModel({}, [chunk], "candidate");
  for (const family of families) {
    for (let index = 0; index < countPerFamily; index += 1) {
      const prefix = family === "characters" ? "Keeper" : family === "locations" ? "Harbor" : family === "chronology" ? "Arrival" : "Gate";
      const name = `${prefix} ${index}`;
      const quote = `${name} remained open through the winter.`;
      const evidence = [{ chunkId: chunk.id, sourceId: chunk.sourceId, quote }];
      const summary = `${name}. ${"The saved candidate includes detailed contextual observations. ".repeat(55)}`;
      if (family === "characters") {
        const parsed = parseWorldFindingsFromModel({ characters: [{ name, role: "Harbor keeper", summary: quote, evidence }] }, [chunk], "candidate");
        assert.equal(parsed.characters.length, 1);
        persistedLocalFindings.characters.push({ ...parsed.characters[0]!, summary });
      } else if (family === "claims") {
        persistedLocalFindings.claims!.push({ subject: name, predicate: "status", value: "open", polarity: "positive", epistemicHolder: "",
          truthStatus: "fact", validFromLabel: "winter", validUntilLabel: "", evidence, confidence: 0.95, reviewStatus: "candidate" });
      } else {
        persistedLocalFindings[family].push({ name, summary, evidence, confidence: 0.95, reviewStatus: "candidate" });
      }
    }
  }
  return { worldName: "Complete Inventory Fixture", premise: "", genre: "", chunks: [chunk], sources: [],
    premiumClaimScope: scope, persistedLocalFindings, analysisMode: "connected" };
}

function marker<T>(request: GenerateAiTextInput, name: string): T {
  const text = request.messages.map((message) => message.content).join("\n");
  const found = text.match(new RegExp(`<${name} trust="unverified">\\s*([\\s\\S]*?)\\s*</${name}>`, "u"));
  assert.ok(found, `The ${name} marker is required`);
  return JSON.parse(found[1]!) as T;
}
function proposal(request: GenerateAiTextInput) { return marker<WorldFindings>(request, "PROPOSED_BATCH_FINDINGS"); }
type Contract = { requestFingerprint: string; proposals: Array<{ id: string }> };

function responseBody(request: GenerateAiTextInput, params: WorldAnalysisInput, ordinary: Partial<WorldFindings> = {}) {
  const claims = marker<Contract>(request, "CLAIM_VERIFICATION_REQUEST");
  const graph = marker<Contract>(request, "GRAPH_VERIFICATION_REQUEST");
  const decisions = (items: Contract["proposals"]) => items.map((item) => ({
    proposalId: item.id, verdict: "rejected", explanation: "This proposed interpretation is not retained in this synthetic review.",
    confidence: 0.95, supportingEvidence: [], contradictingEvidence: [], retrievalRequests: [],
  }));
  const hasFindings = Object.values(ordinary).some((value) => Array.isArray(value) && value.some((item) =>
    item && typeof item === "object" && "evidence" in item && Array.isArray(item.evidence) && item.evidence.length > 0));
  return {
    ...ordinary, claims: [], entityRelations: [], entityRules: [],
    claimVerification: { requestFingerprint: claims.requestFingerprint, decisions: decisions(claims.proposals), newClaims: [] },
    graphVerification: { requestFingerprint: graph.requestFingerprint, decisions: decisions(graph.proposals), newFindings: [] },
    coverage: params.chunks.map((chunk) => ({ chunkId: chunk.id, status: hasFindings ? "findings" : "no_findings" })),
  };
}

function result(request: GenerateAiTextInput, params: WorldAnalysisInput, ordinary: Partial<WorldFindings> = {}): AiTextResult {
  const text = JSON.stringify(responseBody(request, params, ordinary));
  request.validate!(text);
  const runtime = getAiRuntimeStatus(request.task, request.contentMode, request.stage);
  assert.equal(runtime.provider, "openrouter");
  return { text, journalCompletedAt: "2026-09-03T00:00:00.000Z", runtime, provider: runtime.provider, model: runtime.model,
    reasoning: "high", usage: { inputUnits: 10, outputUnits: 5, cachedInputUnits: 0, cacheWriteInputUnits: 0, reasoningUnits: 0,
      estimatedCostMicros: 100, pricingKnown: true, pricingVersion: "fixture", costEstimated: true } };
}

/** No real credentials, HTTP calls, worlds, or credit ledgers are used. */
async function offline(run: () => Promise<void> | void) {
  const environment = {
    STORYHOLD_VERIFICATION_PROVIDER: "openrouter", STORYHOLD_CHRONOLOGY_PROVIDER: "openrouter",
    STORYHOLD_OPENROUTER_API_KEY: "fake-complete-inventory-fixture-key",
    STORYHOLD_OPENROUTER_CHRONOLOGY_MODEL: "mistralai/mistral-small-2603",
  };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    Object.assign(process.env, environment);
    globalThis.fetch = async () => { fetchCalls += 1; throw new Error("Network is forbidden in inventory fixtures."); };
    await run();
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function signatures(findings: WorldFindings): string[] {
  return families.flatMap((family) => (findings[family] ?? []).map((item) =>
    `${family}:${"subject" in item ? item.subject : item.name}`)).sort();
}

test("the complete relevant inventory retains the tail beyond the old 64K selection cutoff", () => {
  const params = fixture();
  const before = structuredClone(params.persistedLocalFindings!);
  assert.ok(JSON.stringify(before).length > 64_000);
  const packet = persistedLocalVerificationPacket(before, params.chunks);
  assert.deepEqual(signatures(packet), signatures(before));
  assert.deepEqual(params.persistedLocalFindings, before, "building an inventory must not alter the saved evidence graph");
  assert.throws(() => persistedLocalVerificationPacket(before, params.chunks, 64_000), /bound|limit|exceed|large|split/iu,
    "an explicitly bounded legacy call must report overflow rather than silently deleting candidates");
});

test("source selection preserves more than four in-batch citations and filters only foreign evidence", () => {
  const params = fixture(1);
  const chunk = params.chunks[0]!;
  const quotes = Array.from({ length: 7 }, (_, index) => `The harbor signal flashed ${index} times.`);
  chunk.content = `${chunk.content} ${quotes.join(" ")}`;
  const evidence = quotes.map((quote) => ({ chunkId: chunk.id, sourceId: chunk.sourceId, quote }));
  const foreign = { chunkId: "outside-batch", sourceId: "other-source", quote: "An unrelated outside scene." };
  params.persistedLocalFindings!.locations[0]!.evidence = [...evidence, foreign];
  params.persistedLocalFindings!.characters[0]!.relationshipWeb = [{
    name: "Harbor 0", relationship: "associated with", summary: "The keeper works near the harbor.", sentiment: "professional",
    evidence: [...evidence, foreign],
  }];
  params.persistedLocalFindings!.locations.push({ name: "Entirely Foreign Town", summary: foreign.quote, evidence: [foreign] });
  const packet = persistedLocalVerificationPacket(params.persistedLocalFindings!, [chunk]);
  assert.deepEqual(packet.locations[0]!.evidence, evidence);
  assert.deepEqual(packet.characters[0]!.relationshipWeb[0]!.evidence, evidence);
  assert.equal(packet.locations.length, 1, "an unrelated candidate remains outside this source batch");
  assert.equal(params.persistedLocalFindings!.locations[0]!.evidence.length, 8, "the stored graph remains untouched");
});

test("mixed oversized inventory is reviewed exactly once in bounded pages, with exact reservation parity", async () => {
  await offline(async () => {
    const params = fixture();
    const pages = buildWorldPremiumVerificationPages(params);
    const expected = signatures(params.persistedLocalFindings!);
    assert.ok(pages.length > 1);
    assert.equal(pages.reduce((count, page) => count + page.candidateKeys.length, 0), expected.length);
    const reserved = quoteWorldAnalysisReservation({ ...params, premiumVerificationPages: pages });
    const sent: string[] = [];
    const steps: string[] = [];
    const pageQuotes: number[] = [];
    const reviewed = await analyzeWorld({ ...params, premiumVerificationPages: pages,
      executePremiumCall: async (step, request) => {
        steps.push(step);
        const packet = proposal(request);
        const current = signatures(packet);
        assert.ok(current.length <= 6, "ordinary candidates and typed claims share the same bounded page inventory");
        assert.ok(JSON.stringify(packet).length <= 64_000);
        sent.push(...current);
        pageQuotes.push(quoteAiCostReservation(request).maximumCostMicros);
        return result(request, params);
      },
      onCoverage: (coverage) => {
        assert.equal(steps.length, pages.length, "source completion must wait for every overflow page");
        assert.equal(coverage.batches.length, 1);
      },
    });
    assert.deepEqual(sent.sort(), expected);
    assert.deepEqual(steps, pages.map((page) => page.stepKey));
    assert.equal(new Set(sent).size, expected.length);
    assert.equal(reviewed.coverage?.complete, true);
    assert.equal(reviewed.claimReviews?.length, pages.length);
    assert.equal(reviewed.graphReviews?.length, pages.length);
    assert.equal(reviewed.usage.estimatedCostMicros, pages.length * 100);
    const empty = { ...params, persistedLocalFindings: parseWorldFindingsFromModel({}, params.chunks, "candidate") };
    const emptyReserved = quoteWorldAnalysisReservation(empty);
    let emptyPageQuote = 0;
    await analyzeWorld({ ...empty, executePremiumCall: async (_step, request) => {
      emptyPageQuote += quoteAiCostReservation(request).maximumCostMicros;
      return result(request, empty);
    } });
    assert.equal(reserved.batchCount - emptyReserved.batchCount, pages.length - 1,
      "extra inventory pages must not multiply chronology reservations");
    assert.equal(reserved.maximumCostMicros - emptyReserved.maximumCostMicros,
      pageQuotes.reduce((sum, cost) => sum + cost, 0) - emptyPageQuote);
  });
});

test("an ordinary continuation returns its assigned family and cannot rewrite an unassigned family", async () => {
  await offline(async () => {
    const params = fixture(7);
    for (const family of ["characters", "chronology", "claims"] as const) params.persistedLocalFindings![family] = [];
    const pages = buildWorldPremiumVerificationPages(params);
    assert.equal(pages.length, 2);
    let calls = 0;
    const reviewed = await analyzeWorld({ ...params, premiumVerificationPages: pages,
      executePremiumCall: async (_step, request) => {
        calls += 1;
        if (calls === 1) return result(request, params);
        const assigned = proposal(request).locations;
        assert.equal(assigned.length, 1);
        const invalid = responseBody(request, params, { factions: [{ name: "Unassigned Guild", summary: "Not part of this page", evidence: [] }] });
        assert.throws(() => request.validate!(JSON.stringify(invalid)), /factions|assigned|continuation|rewrite/iu);
        return result(request, params, { locations: assigned });
      },
    });
    assert.equal(calls, 2);
    assert.equal(reviewed.findings.locations.length, 1);
    assert.equal(reviewed.findings.locations[0]!.name, "Harbor 6");
    assert.equal(reviewed.coverage?.complete, true);
    assert.deepEqual(reviewed.coverage?.batches[0]!.chunks, [{ chunkId: params.chunks[0]!.id, status: "findings" }]);
  });
});

test("an individually oversized finding stops both quoting and execution before any provider dispatch", async () => {
  await offline(async () => {
    const params = fixture(1);
    params.persistedLocalFindings!.locations[0]!.summary = "Oversized candidate detail. ".repeat(3_000);
    let calls = 0;
    assert.throws(() => quoteWorldAnalysisReservation(params), /bound|limit|exceed|large|size/iu);
    await assert.rejects(analyzeWorld({ ...params, executePremiumCall: async () => {
      calls += 1;
      throw new Error("An oversized candidate reached a provider.");
    } }), /bound|limit|exceed|large|size/iu);
    assert.equal(calls, 0);
  });
});

test("a failed ordinary overflow page cannot mark its source complete or discard the remaining plan", async () => {
  await offline(async () => {
    const params = fixture(7);
    for (const family of ["characters", "chronology", "claims"] as const) params.persistedLocalFindings![family] = [];
    const pages = buildWorldPremiumVerificationPages(params);
    const savedPlan = structuredClone(pages);
    let calls = 0;
    let coverageWrites = 0;
    await assert.rejects(analyzeWorld({ ...params, premiumVerificationPages: pages,
      executePremiumCall: async (_step, request) => {
        calls += 1;
        if (calls === 2) throw new Error("Synthetic interruption before the final inventory page");
        return result(request, params, { locations: proposal(request).locations });
      },
      onCoverage: () => { coverageWrites += 1; },
    }), /Synthetic interruption/u);
    assert.equal(calls, 2);
    assert.equal(coverageWrites, 0, "six successful ordinary findings do not complete a source with an unchecked seventh candidate");
    assert.deepEqual(pages, savedPlan);
    assert.deepEqual(buildWorldPremiumVerificationPages(params), savedPlan, "the exact remaining candidate assignment is deterministic on resume");
  });
});

function secondaryFixture(): WorldAnalysisInput {
  const params = fixture(0);
  const chunk = params.chunks[0]!;
  const questions = Array.from({ length: 45 }, (_, index) => `Why did harbor ${index} remain open?`);
  const terms = Array.from({ length: 45 }, (_, index) => `Signalword${index}`);
  const quotes = Array.from({ length: 82 }, (_, index) => `Witness ${index} said the western gate remained open.`);
  chunk.content = [...questions, ...terms, ...quotes].join(" ");
  params.persistedLocalFindings!.openQuestions = questions;
  params.persistedLocalFindings!.recurringTerms = terms;
  params.persistedLocalFindings!.cohesionProposals = quotes.map((quote, index) => ({
    kind: "continuity", subject: `Witness ${index}`, summary: `Confirm the account from Witness ${index}.`, severity: "info",
    evidence: [{ chunkId: chunk.id, sourceId: chunk.sourceId, quote }],
  }));
  return params;
}

test("premium page combination retains every reviewed question, term, and cohesion proposal beyond legacy caps", async () => {
  await offline(async () => {
    const params = secondaryFixture();
    const expected = params.persistedLocalFindings!;
    const pages = buildWorldPremiumVerificationPages(params);
    assert.equal(pages.reduce((sum, page) => sum + page.candidateKeys.length, 0), 172);
    const seen = { openQuestions: [] as string[], recurringTerms: [] as string[], cohesionProposals: [] as string[] };
    const reviewed = await analyzeWorld({ ...params, premiumVerificationPages: pages,
      executePremiumCall: async (_step, request) => {
        const assigned = proposal(request);
        const ordinary: Partial<WorldFindings> = {};
        if (assigned.openQuestions.length) {
          ordinary.openQuestions = assigned.openQuestions;
          seen.openQuestions.push(...assigned.openQuestions);
        }
        if (assigned.recurringTerms.length) {
          ordinary.recurringTerms = assigned.recurringTerms;
          seen.recurringTerms.push(...assigned.recurringTerms);
        }
        if (assigned.cohesionProposals.length) {
          ordinary.cohesionProposals = assigned.cohesionProposals;
          seen.cohesionProposals.push(...assigned.cohesionProposals.map((item) => item.subject));
        }
        return result(request, params, ordinary);
      },
    });
    assert.deepEqual(seen.openQuestions, expected.openQuestions);
    assert.deepEqual(seen.recurringTerms, expected.recurringTerms);
    assert.deepEqual(seen.cohesionProposals, expected.cohesionProposals.map((item) => item.subject));
    assert.deepEqual(reviewed.findings.openQuestions, expected.openQuestions);
    assert.deepEqual(reviewed.findings.recurringTerms, expected.recurringTerms);
    assert.deepEqual(reviewed.findings.cohesionProposals.map((item) => item.subject), seen.cohesionProposals);
    assert.equal(reviewed.coverage?.complete, true);
  });
});

test("premium partial merges retain secondary findings while the legacy default limits remain unchanged", () => {
  const params = secondaryFixture();
  const expected = params.persistedLocalFindings!;
  const previous = parseWorldFindingsFromModel({}, params.chunks, "verified");
  const incoming = parseWorldFindingsFromModel({}, params.chunks, "verified");
  previous.openQuestions = expected.openQuestions.slice(0, 23);
  incoming.openQuestions = expected.openQuestions.slice(23);
  previous.recurringTerms = expected.recurringTerms.slice(0, 23);
  incoming.recurringTerms = expected.recurringTerms.slice(23);
  previous.cohesionProposals = expected.cohesionProposals.slice(0, 41);
  incoming.cohesionProposals = expected.cohesionProposals.slice(41);
  const premium = mergeWorldFindings(previous, incoming, { retainAllSecondaryEntries: true });
  assert.deepEqual(premium.openQuestions, expected.openQuestions);
  assert.deepEqual(premium.recurringTerms, expected.recurringTerms);
  assert.deepEqual(premium.cohesionProposals, expected.cohesionProposals);
  const legacy = mergeWorldFindings(previous, incoming);
  assert.equal(legacy.openQuestions.length, 40);
  assert.equal(legacy.recurringTerms.length, 40);
  assert.equal(legacy.cohesionProposals.length, 80);
  assert.equal(previous.openQuestions.length, 23);
  assert.equal(incoming.cohesionProposals.length, 41);
});
