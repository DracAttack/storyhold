import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  getAiRuntimeStatus,
  type AiTextResult,
  type GenerateAiTextInput,
} from "./aiGateway";
import {
  executeJournaledPremiumCall,
  PremiumJournalError,
  premiumReviewJournalSchemaSql,
  readPremiumJournalAccounting,
} from "./premiumReviewJournal";
import {
  analyzeWorld,
  buildWorldPremiumVerificationPages,
  parseWorldFindingsFromModel,
  premiumVerificationBatchChunkIds,
  type AnalysisChunk,
  type WorldAnalysisInput,
  type WorldFindings,
} from "./worldAnalysis";

const chunk: AnalysisChunk = {
  id: "fixture-chunk",
  sourceId: "fixture-source",
  sourceTitle: "Synthetic manuscript",
  index: 0,
  content: "Mara crossed the stone bridge before dawn.",
};
const responseBody = {
  chronology: [{
    name: "Mara crosses the bridge",
    summary: chunk.content,
    evidence: [{ chunkId: chunk.id, quote: chunk.content }],
  }],
  chapterSummaries: [],
  coverage: [{ chunkId: chunk.id, status: "findings" }],
};

function input(): WorldAnalysisInput {
  return {
    premiumClaimScope: {
      worldId: "20000000-0000-4000-8000-000000000001",
      editionId: "20000000-0000-4000-8000-000000000002",
      analysisRunId: "20000000-0000-4000-8000-000000000003",
    },
    worldName: "Synthetic world",
    premise: "",
    genre: "",
    chunks: [chunk],
    analysisMode: "connected",
    persistedLocalFindings: parseWorldFindingsFromModel(responseBody, [chunk]),
  };
}

function validatedResult(request: GenerateAiTextInput, body: unknown = responseBody): AiTextResult {
  const marker = request.messages.map((message) => message.content).join("\n")
    .match(/<CLAIM_VERIFICATION_REQUEST trust="unverified">\s*([\s\S]*?)\s*<\/CLAIM_VERIFICATION_REQUEST>/u);
  const claimRequest = marker ? JSON.parse(marker[1]!) as { requestFingerprint: string; proposals: unknown[] } : undefined;
  const explicitReview = Boolean(body && typeof body === "object" && "claimVerification" in body);
  if (request.system?.includes("independent canon verifier")) {
    assert.ok(claimRequest, "verification prompt must contain the bound claim request");
    if (!explicitReview) assert.equal(claimRequest.proposals.length, 0, "existing coverage fixtures have no atomic claim proposals");
  }
  const withClaims = claimRequest && !explicitReview ? {
    ...body as object,
    claims: [],
    claimVerification: { requestFingerprint: claimRequest.requestFingerprint, decisions: [], newClaims: [] },
  } : body;
  const graphMarker = request.messages.map((message) => message.content).join("\n")
    .match(/<GRAPH_VERIFICATION_REQUEST trust="unverified">\s*([\s\S]*?)\s*<\/GRAPH_VERIFICATION_REQUEST>/u);
  const graphRequest = graphMarker ? JSON.parse(graphMarker[1]!) as { requestFingerprint: string; proposals: unknown[] } : undefined;
  const explicitGraph = Boolean(body && typeof body === "object" && "graphVerification" in body);
  if (request.system?.includes("independent canon verifier")) {
    assert.ok(graphRequest, "verification prompt must contain the bound graph request");
    if (!explicitGraph) assert.equal(graphRequest.proposals.length, 0, "coverage-only fixtures have no graph proposals");
  }
  const text = JSON.stringify(graphRequest && !explicitGraph ? {
    ...withClaims as object, entityRelations: [], entityRules: [],
    graphVerification: { requestFingerprint: graphRequest.requestFingerprint, decisions: [], newFindings: [] },
  } : withClaims);
  assert.equal(typeof request.validate, "function");
  request.validate!(text);
  const runtime = getAiRuntimeStatus(request.task, request.contentMode, request.stage);
  assert.equal(runtime.provider, "openrouter");
  return {
    text,
    journalCompletedAt: "2026-09-03T00:00:00.000Z",
    runtime,
    provider: "openrouter",
    model: runtime.model,
    reasoning: "high",
    usage: {
      inputUnits: 10,
      outputUnits: 5,
      cachedInputUnits: 0,
      cacheWriteInputUnits: 0,
      reasoningUnits: 0,
      estimatedCostMicros: 100,
      pricingKnown: true,
      pricingVersion: "fixture",
      costEstimated: true,
    },
  };
}

async function withFakeConnectedRuntime(run: () => Promise<void>) {
  const environment = {
    STORYHOLD_VERIFICATION_PROVIDER: "openrouter",
    STORYHOLD_CHRONOLOGY_PROVIDER: "openrouter",
    STORYHOLD_OPENROUTER_API_KEY: "fake-integration-test-key",
    STORYHOLD_OPENROUTER_CHRONOLOGY_MODEL: "mistralai/mistral-small-2603",
  };
  const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    Object.assign(process.env, environment);
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("Network calls are forbidden in premium integration fixtures.");
    };
    await run();
    assert.equal(fetchCalls, 0, "the injected executor must bypass the real gateway");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("connected review awaits executor completion before verification and final coverage", async () => {
  await withFakeConnectedRuntime(async () => {
    const events: string[] = [];
    const result = await analyzeWorld({
      ...input(),
      executePremiumCall: async (stepKey, request) => {
        const result = validatedResult(request);
        // Stand in for asynchronous durable persistence before returning.
        await Promise.resolve();
        events.push(`saved:${stepKey}`);
        return result;
      },
      onCoverage: (coverage) => {
        events.push(`coverage:${coverage.finalSynthesis.status}`);
      },
    });

    assert.deepEqual(events, [
      "saved:verification:0",
      "coverage:pending",
      "saved:chronology:0",
      "coverage:completed",
    ]);
    assert.equal(result.coverage?.complete, true);
    assert.equal(result.usageRecords.length, 2);
    assert.equal(result.usage.estimatedCostMicros, 200);
  });
});

test("coverage failure occurs after executor completion and before another premium request", async () => {
  await withFakeConnectedRuntime(async () => {
    const savedSteps: string[] = [];
    const coverageFailure = new Error("Synthetic coverage write failure");
    await assert.rejects(analyzeWorld({
      ...input(),
      executePremiumCall: async (stepKey, request) => {
        const result = validatedResult(request);
        await Promise.resolve();
        savedSteps.push(stepKey);
        return result;
      },
      onCoverage: () => {
        assert.deepEqual(savedSteps, ["verification:0"]);
        throw coverageFailure;
      },
    }), (error: unknown) => error === coverageFailure);
    assert.deepEqual(savedSteps, ["verification:0"]);
  });
});

for (const code of ["JOURNAL_PERSISTENCE", "OUTCOME_UNRESOLVED"] as const) {
  test(`chronology ${code} escapes without final coverage or completion`, async () => {
    await withFakeConnectedRuntime(async () => {
      const steps: string[] = [];
      const coverageStates: string[] = [];
      const previewPhases: string[] = [];
      const journalFailure = new PremiumJournalError(code, "Synthetic journal failure");
      await assert.rejects(analyzeWorld({
        ...input(),
        executePremiumCall: async (stepKey, request) => {
          steps.push(stepKey);
          if (stepKey === "chronology:0") throw journalFailure;
          return validatedResult(request);
        },
        onCoverage: (coverage) => {
          coverageStates.push(coverage.finalSynthesis.status);
        },
        onIntakePreview: (preview) => {
          previewPhases.push(preview.phase);
        },
      }), (error: unknown) => error === journalFailure);

      assert.deepEqual(steps, ["verification:0", "chronology:0"]);
      assert.deepEqual(coverageStates, ["pending"]);
      assert.ok(!previewPhases.includes("complete"));
    });
  });
}

function sourceChunks(count = 34, padding = ""): AnalysisChunk[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `fixture-chunk-${index}`,
    sourceId: "fixture-source",
    sourceTitle: "Synthetic manuscript",
    index,
    content: `Mara crossed bridge ${index} before dawn.${padding}`,
  }));
}

function batchResponse(chunks: AnalysisChunk[]) {
  return {
    locations: chunks.map((chunk) => ({
      name: `Bridge ${chunk.index}`,
      evidence: [{ chunkId: chunk.id, quote: chunk.content.split(".")[0] + "." }],
    })),
    coverage: chunks.map((chunk) => ({ chunkId: chunk.id, status: "findings" })),
  };
}

function batchInput(chunks: AnalysisChunk[], batches: string[][]): WorldAnalysisInput {
  return {
    ...input(),
    chunks,
    premiumVerificationBatches: batches,
    persistedLocalFindings: parseWorldFindingsFromModel(batchResponse(chunks), chunks),
  };
}

function responseForStep(
  stepKey: string,
  request: GenerateAiTextInput,
  params: WorldAnalysisInput,
): AiTextResult {
  assert.match(stepKey, /^verification:\d+$/u);
  const pages = params.premiumVerificationPages ?? buildWorldPremiumVerificationPages(params);
  const page = pages.find((candidate) => candidate.stepKey === stepKey);
  assert.ok(page);
  const batch = params.premiumVerificationBatches?.[page.batchIndex];
  assert.ok(batch);
  const marker = request.messages.map((message) => message.content).join("\n")
    .match(/<PROPOSED_BATCH_FINDINGS trust="unverified">\s*([\s\S]*?)\s*<\/PROPOSED_BATCH_FINDINGS>/u);
  assert.ok(marker);
  const assigned = JSON.parse(marker[1]!) as WorldFindings;
  // A coincidental text-label match can offer a candidate without a citation in
  // this source batch. The synthetic verifier retains only grounded locations.
  const locations = assigned.locations.filter((location) => location.evidence.some((item) => batch.includes(item.chunkId)));
  const citedChunkIds = new Set(locations.flatMap((location) => location.evidence.map((item) => item.chunkId)));
  return validatedResult(request, {
    locations,
    coverage: batch.map((chunkId) => ({ chunkId, status: citedChunkIds.has(chunkId) ? "findings" : "no_findings" })),
  });
}

function frozenBatchInput(chunks: AnalysisChunk[], batches: string[][]): WorldAnalysisInput {
  const params = batchInput(chunks, batches);
  return { ...params, premiumVerificationPages: buildWorldPremiumVerificationPages(params) };
}

test("frozen verification boundaries preserve the real 32-chunk cap and survive changed sizes", async () => {
  await withFakeConnectedRuntime(async () => {
    const original = sourceChunks();
    const frozen = premiumVerificationBatchChunkIds(original);
    assert.deepEqual(frozen.map((batch) => batch.length), [32, 2]);

    const larger = sourceChunks(34, " Padding".repeat(300));
    assert.notDeepEqual(premiumVerificationBatchChunkIds(larger), frozen);
    const params = frozenBatchInput(larger, frozen);
    assert.deepEqual(params.premiumVerificationPages!.filter((page) => page.pageIndex === 0).map((page) => page.batchIndex), [0, 1]);
    assert.ok(params.premiumVerificationPages!.length > frozen.length, "the source partition is not the inventory page partition");
    const requested: string[] = [];
    const result = await analyzeWorld({
      ...params,
      executePremiumCall: async (stepKey, request) => {
        requested.push(stepKey);
        return responseForStep(stepKey, request, params);
      },
    });
    assert.deepEqual(requested, params.premiumVerificationPages!.map((page) => page.stepKey));
    assert.deepEqual(result.coverage?.batches.map((batch) =>
      batch.chunks.map((chunk) => chunk.chunkId)), frozen);
    assert.equal(result.findings.locations.length, 34);
  });
});

test("invalid frozen partitions fail before the premium executor is called", async () => {
  await withFakeConnectedRuntime(async () => {
    const chunks = sourceChunks(3);
    const ids = chunks.map((chunk) => chunk.id);
    const invalid: Array<{ name: string; batches: string[][] }> = [
      { name: "empty plan", batches: [] },
      { name: "empty batch", batches: [[], ids] },
      { name: "duplicate", batches: [[ids[0]!, ids[0]!], ids.slice(1)] },
      { name: "unknown", batches: [[ids[0]!, "unknown", ids[2]!]] },
      { name: "missing", batches: [ids.slice(0, 2)] },
      { name: "out of order", batches: [[ids[1]!, ids[0]!, ids[2]!]] },
    ];
    let calls = 0;
    for (const fixture of invalid) {
      await assert.rejects(analyzeWorld({
        ...batchInput(chunks, fixture.batches),
        executePremiumCall: async () => {
          calls += 1;
          throw new Error(`Invalid ${fixture.name} reached the executor.`);
        },
      }), /Premium verification batches/u, fixture.name);
    }
    assert.equal(calls, 0);
  });
});

const RUN_ID = "00000000-0000-4000-8000-000000000201";
const RESERVATION_ID = "00000000-0000-4000-8000-000000000202";
const WORLD_ID = "00000000-0000-4000-8000-000000000203";
const PLAYER_ID = "00000000-0000-4000-8000-000000000204";

async function journalDatabase(dataDirectory?: string): Promise<PGlite> {
  const db = new PGlite(dataDirectory);
  try {
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.world_analysis_runs (
        id uuid PRIMARY KEY, world_id uuid NOT NULL,
        requested_by_player_id uuid NOT NULL
      );
      CREATE TABLE storyhold.credit_reservations (
        id uuid PRIMARY KEY, world_id uuid NOT NULL, player_id uuid NOT NULL,
        operation text NOT NULL, request_id text NOT NULL,
        status text NOT NULL DEFAULT 'reserved',
        reserved_credits integer NOT NULL DEFAULT 20,
        usage jsonb NOT NULL DEFAULT '{}'::jsonb
      );
    `);
    await db.exec(premiumReviewJournalSchemaSql);
    await db.query(
      "INSERT INTO storyhold.world_analysis_runs VALUES ($1, $2, $3)",
      [RUN_ID, WORLD_ID, PLAYER_ID],
    );
    await db.query(
      `INSERT INTO storyhold.credit_reservations
        (id, world_id, player_id, operation, request_id)
       VALUES ($1, $2, $3, 'world_analysis', $4)`,
      [RESERVATION_ID, WORLD_ID, PLAYER_ID, RUN_ID],
    );
    return db;
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
}

function journalExecutor(
  db: PGlite,
  invoke: (stepKey: string, request: GenerateAiTextInput) => Promise<AiTextResult>,
): NonNullable<WorldAnalysisInput["executePremiumCall"]> {
  return (stepKey, request) => {
    const runtime = getAiRuntimeStatus(request.task, request.contentMode, request.stage);
    return executeJournaledPremiumCall(db, {
      runId: RUN_ID,
      reservationId: RESERVATION_ID,
      stepKey,
      request,
      provider: runtime.provider,
      model: runtime.model,
      scopeFingerprint: "synthetic-frozen-evidence-scope",
      invoke: () => invoke(stepKey, request),
    });
  };
}

test("same-run journal replay survives closing and reopening its disk database without duplicate calls or usage", async () => {
  await withFakeConnectedRuntime(async () => {
    const temporaryParent = resolve(tmpdir());
    const directoryPrefix = "storyhold-premium-replay-";
    const dataDirectory = await mkdtemp(join(temporaryParent, directoryPrefix));
    let db: PGlite | undefined;
    try {
      db = await journalDatabase(dataDirectory);
      const chunks = sourceChunks();
      const batches = premiumVerificationBatchChunkIds(chunks);
      assert.deepEqual(batches.map((batch) => batch.length), [32, 2]);
      const params = frozenBatchInput(chunks, batches);
      const pages = params.premiumVerificationPages!;
      const completedPrefix = pages.filter((page) => page.batchIndex === 0).map((page) => page.stepKey);
      assert.ok(completedPrefix.length > 1);
      const serializedPlan = JSON.stringify(params);
      const invocations: string[] = [];
      const invoke = async (stepKey: string, request: GenerateAiTextInput) => {
        invocations.push(stepKey);
        return responseForStep(stepKey, request, params);
      };
      const interruption = new Error("Synthetic process interruption after durable response");
      await assert.rejects(analyzeWorld({
        ...params,
        executePremiumCall: journalExecutor(db, invoke),
        onCoverage: (coverage) => {
          assert.equal(coverage.batches.length, 1);
          assert.deepEqual(coverage.batches[0]!.chunks.map((item) => item.chunkId), batches[0]);
          throw interruption;
        },
      }), (error: unknown) => error === interruption);
      assert.deepEqual(invocations, completedPrefix);
      const saved = await readPremiumJournalAccounting(db, RUN_ID);
      assert.equal(saved.callCount, completedPrefix.length);
      assert.equal(saved.attempts.length, completedPrefix.length);
      assert.equal(saved.attempts.reduce((sum, attempt) => sum + attempt.usage.estimatedCostMicros, 0), completedPrefix.length * 100);
      assert.equal(saved.hasUncertain, false);

      // Drop the live database instance: replay must come from the committed
      // disk journal, not retained query state in the first PGlite instance.
      const closedInstance = db;
      await db.close();
      db = undefined;
      db = new PGlite(dataDirectory);
      assert.notEqual(db, closedInstance);
      const reopened = await readPremiumJournalAccounting(db, RUN_ID);
      assert.equal(reopened.callCount, completedPrefix.length);
      assert.deepEqual(reopened.attempts, saved.attempts);

      const resumed = await analyzeWorld({
        ...(JSON.parse(serializedPlan) as WorldAnalysisInput),
        executePremiumCall: journalExecutor(db, invoke),
      });
      const uninterrupted = await analyzeWorld({
        ...params,
        executePremiumCall: async (stepKey, request) =>
          responseForStep(stepKey, request, params),
      });

      assert.deepEqual(invocations, pages.map((page) => page.stepKey));
      assert.equal(new Set(invocations).size, pages.length);
      assert.deepEqual(resumed.findings, uninterrupted.findings);
      assert.equal(resumed.findings.locations.length, 34);
      assert.deepEqual(resumed.coverage, uninterrupted.coverage);
      assert.deepEqual(resumed.usageRecords, uninterrupted.usageRecords);
      assert.deepEqual(resumed.usage, uninterrupted.usage);
      assert.equal(resumed.usage.estimatedCostMicros, pages.length * 100);
      const accounting = await readPremiumJournalAccounting(db, RUN_ID);
      assert.equal(accounting.callCount, pages.length);
      assert.equal(accounting.attempts.length, pages.length);
      assert.equal(accounting.attempts.reduce((sum, attempt) => sum + attempt.usage.estimatedCostMicros, 0), resumed.usage.estimatedCostMicros);
      const hold = await db.query<{ status: string; reserved_credits: number }>(
        "SELECT status, reserved_credits FROM storyhold.credit_reservations",
      );
      assert.deepEqual(hold.rows, [{ status: "reserved", reserved_credits: 20 }]);
    } finally {
      try {
        await db?.close();
      } finally {
        // Only remove this test's mkdtemp child, never the temp parent itself.
        const cleanupTarget = resolve(dataDirectory);
        assert.equal(dirname(cleanupTarget), temporaryParent);
        assert.ok(basename(cleanupTarget).startsWith(directoryPrefix));
        await rm(cleanupTarget, { recursive: true, force: true });
      }
    }
  });
});

test("an uncertain journal outcome blocks replay and all later premium batches", async () => {
  await withFakeConnectedRuntime(async () => {
    const db = await journalDatabase();
    try {
      const chunks = sourceChunks(66);
      const batches = premiumVerificationBatchChunkIds(chunks);
      const params = frozenBatchInput(chunks, batches);
      const invocations: string[] = [];
      const execute = journalExecutor(db, async (stepKey, request) => {
        invocations.push(stepKey);
        if (stepKey === "verification:1") {
          throw new Error("Synthetic lost response after dispatch");
        }
        return responseForStep(stepKey, request, params);
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(analyzeWorld({
          ...params,
          executePremiumCall: execute,
        }), (error: unknown) =>
          error instanceof PremiumJournalError && error.code === "OUTCOME_UNRESOLVED");
      }
      assert.deepEqual(invocations, ["verification:0", "verification:1"]);
      const accounting = await readPremiumJournalAccounting(db, RUN_ID);
      assert.equal(accounting.callCount, 2);
      assert.equal(accounting.attempts.length, 1);
      assert.equal(accounting.hasUncertain, true);
    } finally {
      await db.close();
    }
  });
});

test("premium claims retain explicit belief and time decisions without promoting rejected baseline claims", async () => {
  await withFakeConnectedRuntime(async () => {
    const source = { ...chunk, content: "In the second winter, Mara believed Seren survived the evacuation. Nobody had confirmed it." };
    const local = parseWorldFindingsFromModel({ claims: [{
      subject: "Seren", predicate: "survived", value: "the evacuation",
      truthStatus: "fact", polarity: "positive", epistemicHolder: "",
      validFromLabel: "", validUntilLabel: "", confidence: 0.9,
      evidence: [{ chunkId: source.id, quote: source.content }],
    }] }, [source]);
    const stages: string[] = [];
    const result = await analyzeWorld({
      ...input(), chunks: [source], persistedLocalFindings: local,
      executePremiumCall: async (step, request) => {
        stages.push(step);
        const inventory = JSON.parse(request.messages[0]!.content.match(
          /<CLAIM_VERIFICATION_REQUEST trust="unverified">([\s\S]*?)<\/CLAIM_VERIFICATION_REQUEST>/u,
        )![1]!) as { requestFingerprint: string; proposals: Array<{ id: string }> };
        return validatedResult(request, {
          coverage: [{ chunkId: source.id, status: "findings" }], claims: [],
          claimVerification: {
            requestFingerprint: inventory.requestFingerprint,
            decisions: inventory.proposals.map((proposal) => ({
              proposalId: proposal.id, verdict: "rejected", explanation: "The source establishes a belief, not confirmed survival.",
              confidence: 0.96, supportingEvidence: [],
              contradictingEvidence: [{ chunkId: source.id, quote: source.content }], retrievalRequests: [],
            })),
            newClaims: [{
              claim: { subject: "Seren", predicate: "survived", value: "the evacuation",
                truthStatus: "belief", polarity: "positive", epistemicHolder: "Mara",
                validFromLabel: "the second winter", validUntilLabel: "" },
              verdict: "verified", explanation: "Mara holds this belief in the second winter; confirmation is absent.",
              confidence: 0.96, supportingEvidence: [{ chunkId: source.id, quote: source.content }],
              contradictingEvidence: [], retrievalRequests: [],
            }],
          },
        });
      },
    });
    assert.deepEqual(stages, ["verification:0"], "claim decisions add no extra provider call");
    assert.equal(result.findings.claims?.length, 1);
    const claim = result.findings.claims![0]!;
    assert.equal(claim.truthStatus, "belief");
    assert.equal(claim.epistemicHolder, "Mara");
    assert.equal(claim.validFromLabel, "the second winter");
    assert.equal(claim.reviewStatus, "verified");
    assert.equal(result.claimReviews?.length, 1);
    assert.deepEqual(result.claimReviews![0]!.decisions.map((decision) => decision.verdict).sort(), ["rejected", "verified"]);
    assert.equal(result.claimReviews![0]!.verifier.completedAt, "2026-09-03T00:00:00.000Z");
  });
});

test("legacy or incomplete premium claim decisions stop before coverage or a second paid step", async () => {
  await withFakeConnectedRuntime(async () => {
    for (const body of [responseBody, { ...responseBody, claims: [], claimVerification: { requestFingerprint: "forged", decisions: [], newClaims: [] } }]) {
      let calls = 0;
      let coverageWrites = 0;
      await assert.rejects(analyzeWorld({
        ...input(),
        executePremiumCall: async (_step, request) => {
          calls += 1;
          request.validate!(JSON.stringify(body));
          throw new Error("Malformed claim output must not get this far.");
        },
        onCoverage: () => { coverageWrites += 1; },
      }), /Premium claim verification/);
      assert.equal(calls, 1);
      assert.equal(coverageWrites, 0);
    }
  });
});

test("premium graph review preserves relationship periods and materializes an explicitly verified ability", async () => {
  await withFakeConnectedRuntime(async () => {
    const source = { ...chunk, content: "Mara and Seren were allies during the first winter. Seren opposed Mara in the second winter. Mara can transform when threatened." };
    const proof = [{ chunkId: source.id, quote: source.content }];
    const local = parseWorldFindingsFromModel({
      entityRelations: [
        { subject: "Seren", relationType: "allied_with", target: "Mara", status: "former", summary: "Seren and Mara were allies.",
          validFromLabel: "first winter", validUntilLabel: "second winter", confidence: 0.9, evidence: proof },
        { subject: "Seren", relationType: "opposed_to", target: "Mara", status: "active", summary: "Seren opposes Mara.",
          validFromLabel: "second winter", validUntilLabel: "", confidence: 0.9, evidence: proof },
      ],
      entityRules: [{ entity: "Mara", name: "Transformation", description: "Mara can transform when threatened.",
        ruleKind: "ability", trigger: "when threatened", effect: "transform", confidence: 0.9, evidence: proof }],
    }, [source]);
    const steps: string[] = [];
    const result = await analyzeWorld({
      ...input(), chunks: [source], persistedLocalFindings: local,
      executePremiumCall: async (step, request) => {
        steps.push(step);
        const inventory = JSON.parse(request.messages[0]!.content.match(
          /<GRAPH_VERIFICATION_REQUEST trust="unverified">([\s\S]*?)<\/GRAPH_VERIFICATION_REQUEST>/u,
        )![1]!) as { requestFingerprint: string; proposals: Array<{ id: string }> };
        assert.equal(inventory.proposals.length, 3);
        return validatedResult(request, {
          entityRelations: [], entityRules: [], coverage: [{ chunkId: source.id, status: "findings" }],
          graphVerification: { requestFingerprint: inventory.requestFingerprint,
            decisions: inventory.proposals.map((proposal) => ({ proposalId: proposal.id,
              verdict: "verified", confidence: 0.9, explanation: "The manuscript states this relationship period or ability.",
              supportingEvidence: proof, contradictingEvidence: [], retrievalRequests: [] })),
            newFindings: [],
          },
        });
      },
    });
    assert.deepEqual(steps, ["verification:0"]);
    assert.equal(result.findings.entityRelations.length, 2);
    const earlier = result.findings.entityRelations.find((relation) => relation.relationType === "allied_with")!;
    const later = result.findings.entityRelations.find((relation) => relation.relationType === "opposed_to")!;
    assert.equal(earlier.status, "former");
    assert.equal(earlier.validUntilLabel, "second winter");
    assert.equal(later.validFromLabel, "second winter");
    assert.equal(result.findings.entityRules[0]?.trigger, "when threatened");
    assert.equal(result.findings.entityRules[0]?.reviewStatus, "verified");
    assert.equal(result.graphReviews?.[0]?.decisions.length, 3);
    assert.equal(result.graphReviews?.[0]?.verifier.completedAt, "2026-09-03T00:00:00.000Z");
  });
});
