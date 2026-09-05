import assert from "node:assert/strict";
import test from "node:test";
import { finalizeChunkCoverage, findingCountsByChunk } from "./worldStudio";
import { parseWorldFindingsFromModel, type AnalysisChunk, type EntityRelationFinding, type EntityRuleFinding, type WorldFindings } from "./worldAnalysis";
import { buildPremiumGraphRequest, graphFromPremiumReceipts, validatePremiumGraphResponse, type PremiumGraphReviewReceipt } from "./premiumGraphVerification";
import { buildPremiumVerificationPages, proposalForPremiumVerificationPage } from "./premiumVerificationPages";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { worldId: uuid(1), editionId: uuid(2), analysisRunId: uuid(3) };
const first: AnalysisChunk = { id: uuid(10), sourceId: uuid(20), sourceTitle: "First", index: 0, content: "Mira joined the Watch. The Watch admitted Mira. Mira can glow at dusk." };
const second: AnalysisChunk = { id: uuid(11), sourceId: uuid(21), sourceTitle: "Second", index: 1, content: "Before winter, Mira belonged to the Watch." };
function relation(source = first, overrides: Partial<EntityRelationFinding> = {}): EntityRelationFinding {
  return { subject: "Mira", relationType: "member_of", target: "Watch", status: "active", summary: "Mira joined the Watch.",
    validFromLabel: "", validUntilLabel: "", confidence: 0.9, reviewStatus: "verified",
    evidence: [{ chunkId: source.id, sourceId: source.sourceId, quote: source === first ? "Mira joined the Watch." : source.content }], ...overrides };
}
function rule(): EntityRuleFinding {
  return { entity: "Mira", name: "Dusk glow", description: "Mira glows at dusk.", ruleKind: "ability", trigger: "at dusk", effect: "Mira glows", confidence: 0.9,
    evidence: [{ chunkId: first.id, sourceId: first.sourceId, quote: "Mira can glow at dusk." }] };
}
function receipt(options: {
  chunks?: AnalysisChunk[]; relations?: EntityRelationFinding[]; rules?: EntityRuleFinding[];
  verdict?: string; stepKey?: string; worldId?: string;
} = {}): PremiumGraphReviewReceipt {
  const chunks = options.chunks ?? [first];
  const request = buildPremiumGraphRequest({ scope: { ...scope, worldId: options.worldId ?? scope.worldId }, stepKey: options.stepKey ?? "verification:0",
    chunks: chunks.map((item) => ({ id: item.id, sourceId: item.sourceId, text: item.content })),
    relations: options.relations ?? [relation()], rules: options.rules ?? [], context: {} });
  const anchors = new Map(request.evidence.map((anchor) => [anchor.id, anchor]));
  return validatePremiumGraphResponse(request, { entityRelations: [], entityRules: [], graphVerification: {
    requestFingerprint: request.fingerprint, decisions: request.proposals.map((proposal) => ({
      proposalId: proposal.id, verdict: options.verdict ?? "verified", explanation: "The manuscript directly supports this finding.", confidence: 0.9,
      supportingEvidence: proposal.evidenceIds.map((id) => { const anchor = anchors.get(id)!; return { chunkId: anchor.chunkId, quote: anchor.quote }; }),
      contradictingEvidence: [], retrievalRequests: options.verdict === "needs_more_evidence" ? ["Find the later passage."] : [],
    })), newFindings: [],
  } }, { provider: "openai", model: "test", completedAt: "2026-09-03T12:00:00.000Z" });
}
function findings(reviews: PremiumGraphReviewReceipt[], chunks = [first, second]): WorldFindings {
  const graph = graphFromPremiumReceipts(reviews);
  return { ...parseWorldFindingsFromModel({}, chunks), entityRelations: graph.entityRelations, entityRules: graph.entityRules };
}
function mockDatabase() {
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const db = { query: async (sql: string, params: unknown[]) => { writes.push({ sql, params }); return { rows: [] }; } } as unknown as Parameters<typeof finalizeChunkCoverage>[0];
  return { db, writes };
}
function options(reviews: PremiumGraphReviewReceipt[], expectedStepKeys = reviews.map((item) => item.request.stepKey)) {
  return { scope, reviews, expectedStepKeys };
}

function pagedFixture() {
  const chunks = [first, second];
  const packet = parseWorldFindingsFromModel({}, chunks);
  packet.entityRelations = Array.from({ length: 7 }, (_, index) => relation(index < 6 ? first : second, {
    summary: `Mira's Watch membership, recorded interpretation ${index + 1}.`,
  }));
  const verificationPages = buildPremiumVerificationPages([packet]);
  assert.equal(verificationPages.length, 2);
  const reviews = verificationPages.map((page) => {
    const proposal = proposalForPremiumVerificationPage(packet, page);
    return receipt({ chunks, relations: proposal.entityRelations, rules: proposal.entityRules, stepKey: page.stepKey });
  });
  return {
    chunks, reviews, projected: findings(reviews, chunks),
    settings: { ...options(reviews), verificationPages, verificationBatches: [[first.id, second.id]] },
  };
}

test("durable graph coverage keeps both paraphrase chunks analyzed after projection selects one", async () => {
  const reviewed = receipt({ chunks: [first, second], relations: [relation(first), relation(second, { summary: "Mira belonged to the Watch." })] });
  const projected = findings([reviewed]);
  assert.equal(projected.entityRelations.length, 1);
  assert.equal(projected.entityRelations[0]!.evidence.length, 1);
  const counts = findingCountsByChunk(projected, [reviewed]);
  assert.equal(counts.get(first.id), 1);
  assert.equal(counts.get(second.id), 1);
  const { db, writes } = mockDatabase();
  await finalizeChunkCoverage(db, scope.analysisRunId, [first, second], projected, options([reviewed]));
  assert.deepEqual(writes.map((write) => write.params), [
    [scope.analysisRunId, first.id, "analyzed", 1], [scope.analysisRunId, second.id, "analyzed", 1],
  ]);
});

test("verified graph counting deduplicates each exact payload/chunk, not different paraphrases", () => {
  const twoQuotes = relation(first, { evidence: [
    { chunkId: first.id, sourceId: first.sourceId, quote: "Mira joined the Watch." },
    { chunkId: first.id, sourceId: first.sourceId, quote: "The Watch admitted Mira." },
  ] });
  const firstReview = receipt({ relations: [twoQuotes] });
  const repeated = receipt({ relations: [twoQuotes], stepKey: "verification:1" });
  assert.equal(findingCountsByChunk(findings([firstReview, repeated]), [firstReview, repeated]).get(first.id), 1);
  const paraphrases = receipt({ relations: [twoQuotes, relation(first, { summary: "The Watch accepted Mira as a member." })] });
  assert.equal(findingCountsByChunk(findings([paraphrases]), [paraphrases]).get(first.id), 2);
});

test("verified relation and rule payloads each contribute once without projected-array double counting", () => {
  const reviewed = receipt({ rules: [rule()] });
  const projected = findings([reviewed]);
  assert.equal(projected.entityRelations.length, 1);
  assert.equal(projected.entityRules.length, 1);
  assert.equal(findingCountsByChunk(projected, [reviewed]).get(first.id), 2);
});

test("ordinary nongraph finding counts remain intact alongside the reviewed graph", () => {
  const reviewed = receipt();
  const projected = findings([reviewed]);
  projected.characters = [];
  projected.locations = [{ name: "Watch Hall", summary: "Mira can glow at dusk.", evidence: [{ chunkId: first.id, sourceId: first.sourceId, quote: "Mira can glow at dusk." }] }];
  const ordinary = { ...projected, entityRelations: [], entityRules: [] };
  assert.equal(findingCountsByChunk(ordinary).get(first.id), 1);
  assert.equal(findingCountsByChunk(projected, [reviewed]).get(first.id), 2);
});

test("rejected and uncertain graph decisions add no durable findings or candidate fallback", async () => {
  for (const verdict of ["rejected", "disputed", "insufficient_evidence", "needs_more_evidence"]) {
    const reviewed = receipt({ verdict });
    const localFallback = { ...findings([reviewed]), entityRelations: [relation()] };
    assert.equal(findingCountsByChunk(localFallback, [reviewed]).get(first.id) ?? 0, 0);
    const { db, writes } = mockDatabase();
    await finalizeChunkCoverage(db, scope.analysisRunId, [first], localFallback, options([reviewed]));
    assert.deepEqual(writes[0]!.params, [scope.analysisRunId, first.id, "no_findings", 0]);
  }
});

test("mixed receipt scopes fail before any durable coverage write", async () => {
  const firstReview = receipt();
  const foreign = receipt({ chunks: [second], relations: [relation(second)], worldId: uuid(99), stepKey: "verification:1" });
  const { db, writes } = mockDatabase();
  await assert.rejects(() => finalizeChunkCoverage(db, scope.analysisRunId, [first, second], findings([firstReview]), options([firstReview, foreign])), /scope|world|edition|run/iu);
  assert.deepEqual(writes, []);
});

test("unknown, changed source, changed text, missing, and reordered chunk partitions fail before writes", async () => {
  const reviewed = receipt({ chunks: [first, second], relations: [relation(first), relation(second, { summary: "Mira belonged to the Watch." })] });
  for (const changed of [
    [{ ...first, id: uuid(98) }, second], [{ ...first, sourceId: uuid(98) }, second],
    [{ ...first, content: first.content + " Changed." }, second], [first], [second, first], [first, first],
  ]) {
    const { db, writes } = mockDatabase();
    await assert.rejects(() => finalizeChunkCoverage(db, scope.analysisRunId, changed, findings([reviewed]), options([reviewed])), /exact submitted source chunk partition/);
    assert.deepEqual(writes, []);
  }
});

test("wrong run, missing expected steps, and tampered receipts fail before writes", async () => {
  const reviewed = receipt();
  for (const attempt of [
    { runId: uuid(90), settings: options([reviewed]) },
    { runId: scope.analysisRunId, settings: options([reviewed], ["verification:0", "verification:1"]) },
    { runId: scope.analysisRunId, settings: options([{ ...reviewed, fingerprint: "forged" }]) },
  ]) {
    const { db, writes } = mockDatabase();
    await assert.rejects(() => finalizeChunkCoverage(db, attempt.runId, [first], findings([reviewed]), attempt.settings));
    assert.deepEqual(writes, []);
  }
});

test("expected batch order, not receipt retrieval order, controls source partition validation", async () => {
  const earlier = receipt();
  const later = receipt({ chunks: [second], relations: [relation(second)], stepKey: "verification:1" });
  const { db, writes } = mockDatabase();
  await finalizeChunkCoverage(db, scope.analysisRunId, [first, second], findings([earlier, later]), options([later, earlier], ["verification:0", "verification:1"]));
  assert.deepEqual(writes.map((write) => write.params[2]), ["analyzed", "analyzed"]);
});

test("paged graph coverage validates repeated source context but writes each source once without double counting", async () => {
  const fixture = pagedFixture();
  assert.deepEqual(fixture.reviews[0]!.request.chunks, fixture.reviews[1]!.request.chunks);
  assert.deepEqual(fixture.settings.expectedStepKeys, ["verification:0", "verification:1"]);
  const counts = findingCountsByChunk(fixture.projected, fixture.reviews);
  assert.equal(counts.get(first.id), 6);
  assert.equal(counts.get(second.id), 1);
  const { db, writes } = mockDatabase();
  await finalizeChunkCoverage(db, scope.analysisRunId, fixture.chunks, fixture.projected, {
    ...fixture.settings, reviews: [...fixture.reviews].reverse(),
  });
  assert.deepEqual(writes.map((write) => write.params), [
    [scope.analysisRunId, first.id, "analyzed", 6],
    [scope.analysisRunId, second.id, "analyzed", 1],
  ]);
});

test("paged coverage rejects changed membership, source identity, ordering, or text on a later page before writes", async () => {
  const fixture = pagedFixture();
  for (const changedChunks of [
    [second], [second, first],
    [{ ...first, sourceId: uuid(91) }, second],
    [first, { ...second, content: `${second.content} A later unauthorized change.` }],
    [{ ...first, id: uuid(92) }, second],
  ]) {
    const later = receipt({ chunks: changedChunks, relations: [], stepKey: "verification:1" });
    const { db, writes } = mockDatabase();
    await assert.rejects(() => finalizeChunkCoverage(db, scope.analysisRunId, fixture.chunks, fixture.projected, {
      ...fixture.settings, reviews: [fixture.reviews[0]!, later],
    }), /exact frozen source batch/);
    assert.deepEqual(writes, []);
  }
});

test("paged coverage rejects missing pages, wrong steps, and malformed page boundaries before writes", async () => {
  const fixture = pagedFixture();
  const wrongStep = receipt({ chunks: fixture.chunks, relations: [], stepKey: "verification:7" });
  for (const changed of [
    { ...fixture.settings, reviews: [fixture.reviews[0]!] },
    { ...fixture.settings, reviews: [fixture.reviews[0]!, wrongStep] },
    { ...fixture.settings, expectedStepKeys: ["verification:1", "verification:0"] },
    { ...fixture.settings, verificationPages: fixture.settings.verificationPages.slice(0, 1) },
    { ...fixture.settings, verificationPages: fixture.settings.verificationPages.map((page) => ({ ...page, pageCount: 3 })) },
    { ...fixture.settings, verificationPages: fixture.settings.verificationPages.map((page, index) => ({ ...page, batchIndex: index })) },
  ]) {
    const { db, writes } = mockDatabase();
    await assert.rejects(() => finalizeChunkCoverage(db, scope.analysisRunId, fixture.chunks, fixture.projected, changed));
    assert.deepEqual(writes, []);
  }
});

test("paged coverage preserves the exact source partition rather than counting repeated page chunks", async () => {
  const fixture = pagedFixture();
  for (const verificationBatches of [
    [[second.id, first.id]], [[first.id]], [[first.id, first.id]],
    [[first.id, second.id, second.id]], [[]],
    [[first.id], [second.id]],
  ]) {
    const { db, writes } = mockDatabase();
    await assert.rejects(() => finalizeChunkCoverage(db, scope.analysisRunId, fixture.chunks, fixture.projected, {
      ...fixture.settings, verificationBatches,
    }));
    assert.deepEqual(writes, []);
  }
});

test("paged coverage requires frozen pages and source batches together before any durable write", async () => {
  const fixture = pagedFixture();
  for (const changed of [
    { ...fixture.settings, verificationPages: undefined },
    { ...fixture.settings, verificationBatches: undefined },
  ]) {
    const { db, writes } = mockDatabase();
    await assert.rejects(() => finalizeChunkCoverage(db, scope.analysisRunId, fixture.chunks, fixture.projected, changed), /requires both frozen candidate pages and source batches/);
    assert.deepEqual(writes, []);
  }
});

test("legacy nongraph callers keep the existing coverage behavior", async () => {
  const plain = parseWorldFindingsFromModel({}, [first]);
  plain.entityRelations = [relation()];
  assert.equal(findingCountsByChunk(plain).get(first.id), 1);
  const { db, writes } = mockDatabase();
  await finalizeChunkCoverage(db, scope.analysisRunId, [first], plain);
  assert.deepEqual(writes[0]!.params, [scope.analysisRunId, first.id, "analyzed", 1]);
});
