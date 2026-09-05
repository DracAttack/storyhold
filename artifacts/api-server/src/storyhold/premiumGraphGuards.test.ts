import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPremiumGraphSemantics, assertPremiumRelationSemantics, parseWorldAnalysisBatchCoverage,
  parseWorldFindingsFromModel, type AnalysisChunk, type EntityRelationFinding,
} from "./worldAnalysis";
import {
  buildPremiumGraphRequest, graphFromPremiumReceipts, validatePremiumGraphResponse,
  type PremiumGraphReviewReceipt,
} from "./premiumGraphVerification";

function chunk(content: string, id = "chunk-1"): AnalysisChunk {
  return { id, sourceId: `source-${id}`, sourceTitle: "Test manuscript", index: 0, content };
}
function relation(source: AnalysisChunk, overrides: Partial<EntityRelationFinding> = {}): EntityRelationFinding {
  return {
    subject: "Mira", relationType: "child_of", target: "Dara", status: "active",
    summary: "Mira is Dara's daughter.", validFromLabel: "", validUntilLabel: "", confidence: 0.9,
    evidence: [{ chunkId: source.id, sourceId: source.sourceId, quote: source.content }], reviewStatus: "verified",
    ...overrides,
  };
}
function sources(chunks: AnalysisChunk[]) {
  return chunks.map((item) => ({ id: item.id, sourceId: item.sourceId, text: item.content }));
}
function receipt(batch: AnalysisChunk[], relations: EntityRelationFinding[], verdict = "verified"): PremiumGraphReviewReceipt {
  const request = buildPremiumGraphRequest({
    scope: { worldId: "world", editionId: "edition", analysisRunId: "run" }, stepKey: "verification:0",
    chunks: sources(batch), relations, rules: [], context: {},
  });
  const evidence = new Map(request.evidence.map((anchor) => [anchor.id, anchor]));
  return validatePremiumGraphResponse(request, {
    entityRelations: [], entityRules: [], graphVerification: {
      requestFingerprint: request.fingerprint,
      decisions: request.proposals.map((proposal) => ({
        proposalId: proposal.id, verdict, explanation: "The source establishes this relationship.", confidence: 0.9,
        supportingEvidence: proposal.evidenceIds.map((id) => {
          const anchor = evidence.get(id)!;
          return { chunkId: anchor.chunkId, quote: anchor.quote };
        }), contradictingEvidence: [], retrievalRequests: [],
      })), newFindings: [],
    },
  }, { provider: "openai", model: "test", completedAt: "2026-09-03T12:00:00.000Z" });
}

test("premium semantic guard rejects a mother figure claimed as literal kinship", () => {
  const source = chunk("Dara was a mother figure to Mira.");
  const finding = relation(source, { summary: "Dara was a mother figure to Mira." });
  assert.throws(() => assertPremiumRelationSemantics(finding, sources([source])), /Premium relation semantics rejected/);
  assert.throws(() => assertPremiumGraphSemantics(receipt([source], [finding]), [source]), /Premium relation semantics rejected/);
});

test("explicit biological and adopted parent-child relationships are allowed with correct direction", () => {
  for (const quote of ["Mira is Dara's biological daughter.", "Mira is the adopted daughter of Dara."]) {
    const source = chunk(quote);
    const finding = relation(source);
    assert.doesNotThrow(() => assertPremiumRelationSemantics(finding, sources([source])));
    assert.doesNotThrow(() => assertPremiumGraphSemantics(receipt([source], [finding]), [source]));
    assert.throws(() => assertPremiumRelationSemantics(relation(source, { subject: "Dara", target: "Mira" }), sources([source])), /semantics rejected/);
  }
});

test("figurative related_to remains eligible rather than broad rejection of nuanced relationships", () => {
  const source = chunk("Dara was a mother figure to Mira.");
  const finding = relation(source, { relationType: "related_to", summary: "Dara is a mother figure to Mira, not a biological parent." });
  assert.doesNotThrow(() => assertPremiumRelationSemantics(finding, sources([source])));
});

test("title co-occurrence is rejected while an explicit appointment remains eligible", () => {
  const unsupported = chunk("Mira listened while the Warden addressed the court.");
  assert.throws(() => assertPremiumRelationSemantics(relation(unsupported, { relationType: "holds_title", target: "Warden", summary: "Mira holds the office of Warden." }), sources([unsupported])), /semantics rejected/);
  const supported = chunk("The council appointed Mira as Warden.");
  assert.doesNotThrow(() => assertPremiumRelationSemantics(relation(supported, { relationType: "holds_title", target: "Warden", summary: "Mira holds the office of Warden." }), sources([supported])));
});

test("opposition cannot be inferred from fighting alongside each other", () => {
  const unsupported = chunk("Mira and Dara fought together, side by side.");
  assert.throws(() => assertPremiumRelationSemantics(relation(unsupported, { relationType: "opposed_to", summary: "Mira opposed Dara." }), sources([unsupported])), /semantics rejected/);
  const supported = chunk("Mira opposed Dara during the council vote.");
  assert.doesNotThrow(() => assertPremiumRelationSemantics(relation(supported, { relationType: "opposed_to", summary: "Mira opposed Dara." }), sources([supported])));
});

test("has_form requires manifestation rather than an ordinary species copula", () => {
  const taxonomy = chunk("Nera is a Valari symbiont with an unusual memory.");
  assert.throws(() => assertPremiumRelationSemantics(relation(taxonomy, { subject: "Nera", target: "Valari", relationType: "has_form", summary: "Nera has a Valari form." }), sources([taxonomy])), /semantics rejected/);
  assert.doesNotThrow(() => assertPremiumRelationSemantics(relation(taxonomy, { subject: "Nera", target: "Valari", relationType: "species_of", summary: "Nera belongs to the Valari species." }), sources([taxonomy])));
  const manifested = chunk("Mira transformed into Wolf Form before the battle.");
  assert.doesNotThrow(() => assertPremiumRelationSemantics(relation(manifested, { target: "Wolf Form", relationType: "has_form", summary: "Mira manifested Wolf Form." }), sources([manifested])));
});

test("taxonomic relations cannot be supported by bare co-occurrence", () => {
  const source = chunk("Nera watched the Valari at the distant gate.");
  assert.throws(() => assertPremiumRelationSemantics(relation(source, { subject: "Nera", target: "Valari", relationType: "species_of", summary: "Nera is a Valari." }), sources([source])), /semantics rejected/);
});

test("benign summary and evidence whitespace formatting does not modify or reject a valid payload", () => {
  const source = chunk("Mira is Dara's biological daughter.");
  const finding = relation(source, {
    summary: "Mira  is Dara's\n daughter.",
    evidence: [{ chunkId: source.id, sourceId: source.sourceId, quote: "Mira  is\n Dara's biological daughter." }],
  });
  const original = structuredClone(finding);
  assert.doesNotThrow(() => assertPremiumRelationSemantics(finding, sources([source])));
  assert.deepEqual(finding, original);
});

test("receipt-wide semantic guard checks every verified variant, not only the selected paraphrase", () => {
  const literal = chunk("Mira is Dara's biological daughter.", "literal");
  const figurative = chunk("Dara was a mother figure to Mira.", "figurative");
  const reviewed = receipt([literal, figurative], [relation(literal), relation(figurative, { summary: "Dara was a mother figure to Mira." })]);
  assert.equal(graphFromPremiumReceipts([reviewed]).entityRelations.length, 1);
  assert.throws(() => assertPremiumGraphSemantics(reviewed, [literal, figurative]), /semantics rejected/);
  const rejected = receipt([figurative], [relation(figurative)], "rejected");
  assert.doesNotThrow(() => assertPremiumGraphSemantics(rejected, [figurative]));
});

test("coverage retains both verified paraphrase passages when canonical projection selects only one", () => {
  const first = chunk("Mira joined the Watch before winter.", "first");
  const second = chunk("Before the uprising, Mira was a member of the Watch.", "second");
  const batch = [first, second];
  const reviewed = receipt(batch, [
    relation(first, { relationType: "member_of", target: "Watch", summary: "Mira joined the Watch." }),
    relation(second, { relationType: "member_of", target: "Watch", summary: "Mira belonged to the Watch." }),
  ]);
  const projected = graphFromPremiumReceipts([reviewed]);
  assert.equal(projected.entityRelations.length, 1);
  assert.equal(projected.entityRelations[0]!.evidence.length, 1);
  const findings = { ...parseWorldFindingsFromModel({}, batch), entityRelations: projected.entityRelations };
  const raw = { coverage: batch.map((item) => ({ chunkId: item.id, status: "findings" })) };
  assert.throws(() => parseWorldAnalysisBatchCoverage(raw, batch, 0, 1, findings), /no valid grounded finding/);
  const coverage = parseWorldAnalysisBatchCoverage(raw, batch, 0, 1, findings, reviewed);
  assert.deepEqual(coverage.chunks.map((item) => item.status), ["findings", "findings"]);
});

test("coverage refuses graph receipts from a different, reordered, or changed source batch", () => {
  const first = chunk("Mira is Dara's biological daughter.", "first");
  const second = chunk("Mira thanked Dara for the book.", "second");
  const reviewed = receipt([first, second], [relation(first)]);
  for (const changed of [[{ ...first, sourceId: "other-source" }, second], [{ ...first, content: first.content + " Changed." }, second], [second, first]]) {
    const raw = { coverage: changed.map((item) => ({ chunkId: item.id, status: "no_findings" })) };
    assert.throws(() => parseWorldAnalysisBatchCoverage(raw, changed, 0, 1, parseWorldFindingsFromModel({}, changed), reviewed), /exact submitted source batch/);
    assert.throws(() => assertPremiumGraphSemantics(reviewed, changed), /exact submitted source batch/);
  }
});

test("rejected-only supporting evidence does not manufacture a findings coverage row", () => {
  const source = chunk("Dara was a mother figure to Mira.");
  const reviewed = receipt([source], [relation(source)], "rejected");
  const emptyFindings = parseWorldFindingsFromModel({}, [source]);
  assert.doesNotThrow(() => parseWorldAnalysisBatchCoverage({ coverage: [{ chunkId: source.id, status: "no_findings" }] }, [source], 0, 1, emptyFindings, reviewed));
  assert.throws(() => parseWorldAnalysisBatchCoverage({ coverage: [{ chunkId: source.id, status: "findings" }] }, [source], 0, 1, emptyFindings, reviewed), /no valid grounded finding/);
});

test("coverage revalidates receipt integrity before trusting its evidence inventory", () => {
  const source = chunk("Mira is Dara's biological daughter.");
  const reviewed = structuredClone(receipt([source], [relation(source)]));
  reviewed.decisions[0]!.verdict = "rejected";
  assert.throws(() => parseWorldAnalysisBatchCoverage({ coverage: [{ chunkId: source.id, status: "findings" }] }, [source], 0, 1, parseWorldFindingsFromModel({}, [source]), reviewed), /receipt|fingerprint|verification/);
});
