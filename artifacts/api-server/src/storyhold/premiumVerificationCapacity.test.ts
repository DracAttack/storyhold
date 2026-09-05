import assert from "node:assert/strict";
import test from "node:test";
import { quoteAiCostReservation, type GenerateAiTextInput } from "./aiGateway";
import { proposalForPremiumVerificationPage } from "./premiumVerificationPages";
import {
  analyzeWorld,
  buildWorldPremiumVerificationPages,
  parseWorldFindingsFromModel,
  persistedLocalVerificationPacket,
  worldVerificationRequest,
  type AnalysisChunk,
  type WorldFindings,
} from "./worldAnalysis";

const scope = {
  worldId: "00000000-0000-4000-8000-000000000701",
  editionId: "00000000-0000-4000-8000-000000000702",
  analysisRunId: "00000000-0000-4000-8000-000000000703",
};
const chunkId = "00000000-0000-4000-8000-000000000704";
const sourceId = "00000000-0000-4000-8000-000000000705";
const relationTail = "RELATION_TAIL_23_<unaltered>&";
const ruleTail = "RULE_TAIL_11_<unaltered>&";

function denseFixture() {
  const claimLines = Array.from({ length: 24 }, (_, index) => `Artifact ${index} is stored in Vault ${index}.`);
  const relationLines = Array.from({ length: 24 }, (_, index) => `Agent ${index} is a member of Guild ${index}.`);
  const ruleLines = Array.from({ length: 12 }, (_, index) => `Device ${index} opens only when Lever ${index} is pulled.`);
  const chunk: AnalysisChunk = {
    id: chunkId, sourceId, sourceTitle: "Synthetic Dense Chapter", index: 0,
    content: [...claimLines, ...relationLines, ...ruleLines].join(" "),
  };
  const evidence = (quote: string) => [{ chunkId, sourceId, quote }];
  // These are saved, untrusted local candidates. Building them directly keeps
  // this capacity test independent of heuristic extraction/semantic cleanup.
  const findings: WorldFindings = {
    ...parseWorldFindingsFromModel({}, [chunk], "candidate"),
    claims: claimLines.map((quote, index) => ({
      subject: `Artifact ${index}`, predicate: "stored_in", value: `Vault ${index}`,
      polarity: "positive", epistemicHolder: "", truthStatus: "fact",
      validFromLabel: "", validUntilLabel: "", confidence: 0.5,
      reviewStatus: "candidate", evidence: evidence(quote),
    })),
    entityRelations: relationLines.map((quote, index) => ({
      subject: `Agent ${index}`, relationType: "member_of", target: `Guild ${index}`,
      status: "active", summary: index === 23
        ? `${"This candidate description still requires independent verification. ".repeat(15)}${relationTail}`
        : quote,
      validFromLabel: "", validUntilLabel: "", confidence: 0.5,
      reviewStatus: "candidate", evidence: evidence(quote),
    })),
    entityRules: ruleLines.map((quote, index) => ({
      entity: `Device ${index}`, name: `Lever Condition ${index}`, ruleKind: "constraint",
      description: index === 11
        ? `${"This candidate condition must receive an explicit independent verdict. ".repeat(22)}${ruleTail}`
        : quote,
      trigger: `Lever ${index} is pulled`, effect: `Device ${index} opens`,
      confidence: 0.5, reviewStatus: "candidate", evidence: evidence(quote),
    })),
  };
  const params = {
    worldName: "Synthetic Capacity Fixture", premise: "", genre: "",
    chunks: [chunk], sources: [], persistedLocalFindings: findings,
    premiumClaimScope: scope,
  };
  const packet = persistedLocalVerificationPacket(findings, [chunk]);
  return { params, chunk, findings, packet };
}

type Inventory = { requestFingerprint: string; proposals: Array<{ id: string; payload: Record<string, unknown> }> };

function inventory(request: GenerateAiTextInput, kind: "CLAIM" | "GRAPH"): Inventory {
  const text = request.messages.map((message) => message.content).join("\n");
  const tag = `${kind}_VERIFICATION_REQUEST`;
  const start = `<${tag} trust="unverified">`;
  const end = `</${tag}>`;
  const startIndex = text.indexOf(start);
  assert.notEqual(startIndex, -1, `missing ${kind.toLowerCase()} candidate inventory`);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1);
  return JSON.parse(text.slice(startIndex + start.length, endIndex)) as Inventory;
}

async function withOfflineRuntime(run: () => Promise<void> | void) {
  const environment = {
    STORYHOLD_VERIFICATION_PROVIDER: "openrouter",
    STORYHOLD_OPENROUTER_API_KEY: "fake-verification-capacity-test-key",
  };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    Object.assign(process.env, environment);
    globalThis.fetch = async () => { calls += 1; throw new Error("Capacity fixtures forbid all provider calls."); };
    await run();
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("dense selected claim, relation, and rule candidates retain every mandatory ID and complete graph payload", async () => {
  await withOfflineRuntime(() => {
    const { params, packet, findings, chunk } = denseFixture();
    assert.equal(packet.claims?.length, 24);
    assert.equal(packet.entityRelations.length, 24);
    assert.equal(packet.entityRules.length, 12);
    assert.ok(JSON.stringify(packet).length <= 64_000);
    const request = worldVerificationRequest(params, [chunk], 0, 1, packet);
    const claims = inventory(request, "CLAIM");
    const graph = inventory(request, "GRAPH");
    assert.equal(claims.proposals.length, 24);
    assert.equal(graph.proposals.length, 36);
    assert.equal(new Set([...claims.proposals, ...graph.proposals].map((proposal) => proposal.id)).size, 60);
    assert.equal(graph.proposals.filter((proposal) => Object.hasOwn(proposal.payload, "relationType")).length, 24);
    assert.equal(graph.proposals.filter((proposal) => Object.hasOwn(proposal.payload, "ruleKind")).length, 12);
    assert.equal(
      graph.proposals.find((proposal) => proposal.payload.subject === "Agent 23")?.payload.summary,
      findings.entityRelations[23]!.summary,
      "a selected relation must not be truncated to reduce its response obligation",
    );
    assert.equal(
      graph.proposals.find((proposal) => proposal.payload.entity === "Device 11")?.payload.description,
      findings.entityRules[11]!.description,
      "a selected rule must retain its complete candidate description",
    );
    assert.equal(request.maxOutputTokens, 16_000);
    assert.equal(quoteAiCostReservation(request).maxOutputUnits, 16_000);
  });
});

test("dense response-size measurement is an offline estimate, not proof of fitting the fixed output ceiling", async (t) => {
  await withOfflineRuntime(() => {
    const { params, packet, chunk } = denseFixture();
    const request = worldVerificationRequest(params, [chunk], 0, 1, packet);
    const claims = inventory(request, "CLAIM");
    const graph = inventory(request, "GRAPH");
    const quote = quoteAiCostReservation(request);
    const maximalDecision = (proposal: Inventory["proposals"][number]) => ({
      proposalId: proposal.id,
      verdict: "needs_more_evidence", explanation: "e".repeat(240), confidence: 0.9999999999999999,
      supportingEvidence: Array.from({ length: 3 }, (_, index) => ({
        chunkId, quote: chunk.content.slice(index * 600, index * 600 + 500),
      })),
      contradictingEvidence: [],
      retrievalRequests: Array.from({ length: 3 }, (_, index) => `${"r".repeat(239)}${index}`),
    });
    const maximalMandatoryEnvelope = {
      claims: [], entityRelations: [], entityRules: [],
      claimVerification: { requestFingerprint: claims.requestFingerprint, decisions: claims.proposals.map(maximalDecision), newClaims: [] },
      graphVerification: { requestFingerprint: graph.requestFingerprint, decisions: graph.proposals.map(maximalDecision), newFindings: [] },
    };
    const renderedInput = [request.system, ...request.messages.map((message) => `${message.role}:${message.content}`)].join("\n");
    const outputBytes = Buffer.byteLength(JSON.stringify(maximalMandatoryEnvelope), "utf8");
    const estimatedOutputTokens = Math.ceil(outputBytes / 2.2);
    assert.ok(estimatedOutputTokens > 16_000, "existing field maxima must not be misrepresented as guaranteed to fit");
    t.diagnostic(JSON.stringify({
      claims: 24, relations: 24, rules: 12,
      selectedPacketCharacters: JSON.stringify(packet).length,
      selectedPacketUtf8Bytes: Buffer.byteLength(JSON.stringify(packet), "utf8"),
      renderedRequestUtf8Bytes: Buffer.byteLength(renderedInput, "utf8"),
      quotedInputUnits: quote.inputUnits,
      mandatoryDecisionEnvelopeUtf8Bytes: outputBytes,
      estimatedOutputTokensAtGatewayByteRatio: estimatedOutputTokens,
      reservedOutputTokenCap: quote.maxOutputUnits,
      excludes: "other world fields, optional new claims, and optional new graph findings",
      interpretation: "synthetic maximum-length ASCII fields; byte/2.2 estimate, not tokenizer measurement or provider benchmark",
    }));
  });
});

test("actual frozen review pages retain all sixty candidates while bounding mandatory decision output", async (t) => {
  await withOfflineRuntime(() => {
    const { params, packet, chunk } = denseFixture();
    const pages = buildWorldPremiumVerificationPages(params);
    assert.equal(pages.length, 10);
    const proposals = pages.map((page) => proposalForPremiumVerificationPage(packet, page));
    assert.deepEqual(proposals.flatMap((proposal) => proposal.claims ?? []), packet.claims);
    assert.deepEqual(proposals.flatMap((proposal) => proposal.entityRelations), packet.entityRelations);
    assert.deepEqual(proposals.flatMap((proposal) => proposal.entityRules), packet.entityRules);

    const maximalDecision = (proposal: Inventory["proposals"][number]) => ({
      proposalId: proposal.id,
      verdict: "needs_more_evidence", explanation: "e".repeat(240), confidence: 0.9999999999999999,
      supportingEvidence: Array.from({ length: 3 }, (_, index) => ({
        chunkId, quote: chunk.content.slice(index * 600, index * 600 + 500),
      })),
      contradictingEvidence: [],
      retrievalRequests: Array.from({ length: 3 }, (_, index) => `${"r".repeat(239)}${index}`),
    });
    const measureMandatoryEnvelope = (request: GenerateAiTextInput) => {
      const claims = inventory(request, "CLAIM");
      const graph = inventory(request, "GRAPH");
      const envelope = {
        claims: [], entityRelations: [], entityRules: [],
        claimVerification: { requestFingerprint: claims.requestFingerprint, decisions: claims.proposals.map(maximalDecision), newClaims: [] },
        graphVerification: { requestFingerprint: graph.requestFingerprint, decisions: graph.proposals.map(maximalDecision), newFindings: [] },
      };
      return {
        claims, graph,
        bytes: Buffer.byteLength(JSON.stringify(envelope), "utf8"),
      };
    };
    const unpaged = measureMandatoryEnvelope(worldVerificationRequest(params, [chunk], 0, 1, packet));
    const measured = pages.map((page, index) => {
      const request = worldVerificationRequest(params, [chunk], index, pages.length, proposals[index]!, undefined, undefined, page);
      const measurement = measureMandatoryEnvelope(request);
      assert.ok(measurement.claims.proposals.length + measurement.graph.proposals.length <= 6);
      assert.equal(quoteAiCostReservation(request).maxOutputUnits, 16_000);
      assert.ok(Math.ceil(measurement.bytes / 2.2) < 16_000,
        "the synthetic mandatory-only envelope must fit below the reply limit at the gateway byte heuristic");
      return measurement;
    });
    const everyCandidate = measured.flatMap(({ claims, graph }) => [...claims.proposals, ...graph.proposals]);
    assert.equal(everyCandidate.length, 60);
    assert.equal(new Set(everyCandidate.map((proposal) => proposal.id)).size, 60);
    assert.equal(measured.reduce((count, measurement) => count + measurement.claims.proposals.length, 0), 24);
    assert.equal(measured.reduce((count, measurement) => count + measurement.graph.proposals.length, 0), 36);
    assert.deepEqual(
      everyCandidate.map((proposal) => JSON.stringify(proposal.payload)).sort(),
      [...unpaged.claims.proposals, ...unpaged.graph.proposals].map((proposal) => JSON.stringify(proposal.payload)).sort(),
      "paging must retain complete request payloads, including the long relation and rule descriptions",
    );
    const maximumPageBytes = Math.max(...measured.map((measurement) => measurement.bytes));
    assert.ok(maximumPageBytes < unpaged.bytes / 5, "the largest page must materially reduce mandatory response size");
    t.diagnostic(JSON.stringify({
      pages: pages.length, retainedMandatoryCandidates: everyCandidate.length, maximumCandidatesPerPage: 6,
      unpagedMandatoryDecisionEnvelopeUtf8Bytes: unpaged.bytes,
      maximumPagedMandatoryDecisionEnvelopeUtf8Bytes: maximumPageBytes,
      maximumPagedEstimatedOutputTokensAtGatewayByteRatio: Math.ceil(maximumPageBytes / 2.2),
      reservedOutputTokenCap: 16_000,
      excludes: "ordinary prose and other world fields, optional new claims, and optional new graph findings",
      interpretation: "synthetic maximum-length ASCII mandatory fields only; byte/2.2 estimate, not a tokenizer guarantee or live provider benchmark",
    }));
  });
});

for (const missingKind of ["claim", "graph"] as const) {
  test(`an incomplete dense ${missingKind} verdict set fails before coverage or a second provider step`, async () => {
    await withOfflineRuntime(async () => {
      const { params } = denseFixture();
      if (missingKind === "graph") params.persistedLocalFindings.claims = [];
      const steps: string[] = [];
      const coverage: unknown[] = [];
      await assert.rejects(analyzeWorld({
        ...params,
        analysisMode: "connected",
        executePremiumCall: async (stepKey, request) => {
          steps.push(stepKey);
          const claims = inventory(request, "CLAIM");
          const graph = inventory(request, "GRAPH");
          const rejectedDecision = (proposal: Inventory["proposals"][number]) => ({
            proposalId: proposal.id, verdict: "rejected", explanation: "Synthetic fixture does not authorize this candidate.",
            confidence: 1, supportingEvidence: [], contradictingEvidence: [], retrievalRequests: [],
          });
          const claimDecisions = claims.proposals.map(rejectedDecision);
          const graphDecisions = graph.proposals.map(rejectedDecision);
          if (missingKind === "claim") claimDecisions.pop();
          else graphDecisions.pop();
          assert.equal(typeof request.validate, "function");
          request.validate!(JSON.stringify({
            claims: [], entityRelations: [], entityRules: [],
            coverage: [{ chunkId, status: "no_findings" }],
            claimVerification: { requestFingerprint: claims.requestFingerprint, decisions: claimDecisions, newClaims: [] },
            graphVerification: { requestFingerprint: graph.requestFingerprint, decisions: graphDecisions, newFindings: [] },
          }));
          throw new Error("The incomplete response unexpectedly passed validation.");
        },
        onCoverage: (value) => { coverage.push(value); },
      }), /exactly one explicit decision.*candidate|exactly one.*decision.*candidate/iu);
      assert.deepEqual(steps, ["verification:0"]);
      assert.deepEqual(coverage, []);
    });
  });
}
