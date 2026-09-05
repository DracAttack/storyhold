import assert from "node:assert/strict";
import test from "node:test";
import {
  AnalysisContractValidationError,
  analysisProposalFingerprint,
  buildVerifiedPromotionPlan,
  canonPayloadFingerprint,
  canonPromotionBatchFingerprint,
  evidenceAnchorFingerprint,
  evidencePacketFingerprint,
  ownerConstraintFingerprint,
  promotablePayloadForDecision,
  validateAnalysisProposal,
  validateCanonPromotionBatch,
  validateCanonPromotionReceipt,
  validateEvidenceAnchor,
  validateEvidencePacket,
  validateVerificationDecisions,
  type AnalysisProposal,
  type CanonPromotionBatch,
  type CanonPromotionReceipt,
  type EvidenceAnchor,
  type EvidencePacket,
  type OwnerConstraintSnapshot,
  type VerificationDecision,
} from "./analysisVerificationContracts";

function makeEvidence(overrides: Partial<Omit<EvidenceAnchor, "id">> = {}): EvidenceAnchor {
  const body: Omit<EvidenceAnchor, "id"> = {
    chunkId: "chapter-01:chunk-04",
    sourceId: "manuscript-ashes",
    quote: "Echo lived inside Alec, bound to him in a symbiotic union.",
    startOffset: 402,
    endOffset: 462,
    role: "support",
    sourceKind: "manuscript",
    ...overrides,
  };
  return { ...body, id: evidenceAnchorFingerprint(body) };
}

function makeConstraint(
  overrides: Partial<Omit<OwnerConstraintSnapshot, "fingerprint">> = {},
): OwnerConstraintSnapshot {
  const body: Omit<OwnerConstraintSnapshot, "fingerprint"> = {
    id: "constraint-echo-not-daughter",
    kind: "relation",
    instruction: "Echo is not Alec's literal daughter.",
    ...overrides,
  };
  return { ...body, fingerprint: ownerConstraintFingerprint(body) };
}

function makeProposal(
  evidence: EvidenceAnchor,
  constraint: OwnerConstraintSnapshot,
  overrides: Partial<Omit<AnalysisProposal, "fingerprint">> = {},
): AnalysisProposal {
  const body: Omit<AnalysisProposal, "fingerprint"> = {
    id: "proposal-alec-echo-bond",
    worldId: "world-ashes",
    editionId: "edition-ashes-embers",
    analysisRunId: "run-local-01",
    kind: "relation",
    status: "candidate",
    payload: {
      subject: "Alec Sumner",
      relation: "symbiotic bond",
      object: "Echo",
      literal: true,
    },
    proposedBy: {
      lane: "local_model",
      provider: "local",
      model: "qwen",
    },
    confidence: 0.82,
    evidenceIds: [evidence.id],
    retrievalQueries: ["Alec Echo symbiotic bond"],
    dependencyIds: [],
    constraintIds: [constraint.id],
    ...overrides,
  };
  return { ...body, fingerprint: analysisProposalFingerprint(body) };
}

function makePacket(
  proposal: AnalysisProposal,
  evidence: EvidenceAnchor,
  constraint: OwnerConstraintSnapshot,
  overrides: Partial<Omit<EvidencePacket, "fingerprint">> = {},
): EvidencePacket {
  const body: Omit<EvidencePacket, "fingerprint"> = {
    id: "packet-alec-echo",
    worldId: proposal.worldId,
    editionId: proposal.editionId,
    analysisRunId: proposal.analysisRunId,
    corpusFingerprint: "corpus_sha256_ashes_embers",
    scope: {
      proposalIds: [proposal.id],
      entityIds: ["entity-alec", "entity-echo"],
      chapterKeys: ["book-1:chapter-7"],
    },
    proposals: [proposal],
    evidence: [evidence],
    existingCanon: [],
    ownerConstraints: [constraint],
    retrieval: {
      queries: ["Alec Echo symbiotic bond"],
      coveredTerms: ["Alec Sumner", "Echo"],
      missingTerms: [],
    },
    ...overrides,
  };
  return { ...body, fingerprint: evidencePacketFingerprint(body) };
}

function makeDecision(
  packet: EvidencePacket,
  proposal: AnalysisProposal,
  evidence: EvidenceAnchor,
  constraint: OwnerConstraintSnapshot,
  overrides: Partial<VerificationDecision> = {},
): VerificationDecision {
  return {
    id: "decision-alec-echo",
    proposalId: proposal.id,
    packetFingerprint: packet.fingerprint,
    verdict: "verified",
    supportingEvidenceIds: [evidence.id],
    contradictingEvidenceIds: [],
    constraintIds: [constraint.id],
    confidence: 0.96,
    explanation: "The manuscript states that Echo lives inside Alec as a symbiote.",
    retrievalRequests: [],
    verifier: {
      provider: "provider-neutral-test",
      model: "strong-verifier",
    },
    completedAt: "2026-08-28T12:00:00.000Z",
    ...overrides,
  };
}

function makeBatch(
  packet: EvidencePacket,
  constraint: OwnerConstraintSnapshot,
  decisions: VerificationDecision[],
  overrides: Partial<Omit<CanonPromotionBatch, "fingerprint">> = {},
): CanonPromotionBatch {
  const body: Omit<CanonPromotionBatch, "fingerprint"> = {
    id: "promotion-batch-alec-echo",
    worldId: packet.worldId,
    editionId: packet.editionId,
    analysisRunId: packet.analysisRunId,
    corpusFingerprint: packet.corpusFingerprint,
    packetFingerprint: packet.fingerprint,
    expectedConstraintFingerprints: [constraint.fingerprint],
    decisionIds: decisions.map((decision) => decision.id),
    ...overrides,
  };
  return { ...body, fingerprint: canonPromotionBatchFingerprint(body) };
}

function validFixture(): {
  evidence: EvidenceAnchor;
  constraint: OwnerConstraintSnapshot;
  proposal: AnalysisProposal;
  packet: EvidencePacket;
  decision: VerificationDecision;
  batch: CanonPromotionBatch;
} {
  const evidence = makeEvidence();
  const constraint = makeConstraint();
  const proposal = makeProposal(evidence, constraint);
  const packet = makePacket(proposal, evidence, constraint);
  const decision = makeDecision(packet, proposal, evidence, constraint);
  const batch = makeBatch(packet, constraint, [decision]);
  return { evidence, constraint, proposal, packet, decision, batch };
}

function issueCodes(validation: { issues: Array<{ code: string }> }): string[] {
  return validation.issues.map((issue) => issue.code);
}

test("a verified decision can promote its packet-bound corrected payload", () => {
  const fixture = validFixture();
  const correctedPayload = {
    ...fixture.proposal.payload,
    description: "Echo is an alien symbiote living inside Alec, not a family relation.",
  };
  const decision = makeDecision(
    fixture.packet,
    fixture.proposal,
    fixture.evidence,
    fixture.constraint,
    { correctedPayload },
  );
  const batch = makeBatch(fixture.packet, fixture.constraint, [decision]);

  assert.equal(validateEvidencePacket(fixture.packet).valid, true);
  assert.equal(validateVerificationDecisions(fixture.packet, [decision]).valid, true);
  assert.equal(validateCanonPromotionBatch(fixture.packet, [decision], batch).valid, true);

  const plan = buildVerifiedPromotionPlan(fixture.packet, [decision], batch);
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0]?.payload, correctedPayload);
  assert.equal(plan[0]?.payloadFingerprint, canonPayloadFingerprint(correctedPayload));
});

test("extractors cannot label their own proposal verified", () => {
  const fixture = validFixture();
  const invalid = {
    ...fixture.proposal,
    status: "verified",
  } as unknown as AnalysisProposal;
  invalid.fingerprint = analysisProposalFingerprint(invalid);

  const validation = validateAnalysisProposal(invalid);
  assert.equal(validation.valid, false);
  assert.ok(issueCodes(validation).includes("extractor_cannot_verify"));
});

test("proposal and evidence fingerprints expose content tampering", () => {
  const fixture = validFixture();
  const tamperedProposal: AnalysisProposal = {
    ...fixture.proposal,
    payload: { ...fixture.proposal.payload, literal: false },
  };
  const tamperedEvidence: EvidenceAnchor = {
    ...fixture.evidence,
    quote: "This quote was changed after the anchor was created.",
  };

  assert.ok(issueCodes(validateAnalysisProposal(tamperedProposal)).includes("fingerprint_mismatch"));
  assert.ok(issueCodes(validateEvidenceAnchor(tamperedEvidence)).includes("fingerprint_mismatch"));
});

test("packets reject unknown evidence, dependencies, and owner constraints", () => {
  const fixture = validFixture();
  const badProposal = makeProposal(fixture.evidence, fixture.constraint, {
    evidenceIds: ["ev_missing"],
    dependencyIds: ["proposal-missing"],
    constraintIds: ["constraint-missing"],
  });
  const packet = makePacket(badProposal, fixture.evidence, fixture.constraint);

  const validation = validateEvidencePacket(packet);
  assert.equal(validation.valid, false);
  assert.ok(issueCodes(validation).includes("unknown_evidence"));
  assert.ok(issueCodes(validation).includes("unknown_dependency"));
  assert.ok(issueCodes(validation).includes("unknown_constraint"));
});

test("packet scope and packet fingerprint must inventory the exact proposal set", () => {
  const fixture = validFixture();
  const wrongScopeBody: Omit<EvidencePacket, "fingerprint"> = {
    ...fixture.packet,
    scope: {
      ...fixture.packet.scope,
      proposalIds: ["proposal-not-in-packet"],
    },
  };
  const wrongScope: EvidencePacket = {
    ...wrongScopeBody,
    fingerprint: evidencePacketFingerprint(wrongScopeBody),
  };
  assert.ok(issueCodes(validateEvidencePacket(wrongScope)).includes("scope_inventory_mismatch"));

  const tamperedPacket: EvidencePacket = {
    ...fixture.packet,
    retrieval: {
      ...fixture.packet.retrieval,
      missingTerms: ["Michael as the Thrall"],
    },
  };
  assert.ok(issueCodes(validateEvidencePacket(tamperedPacket)).includes("fingerprint_mismatch"));
});

test("verifier decisions may reference only proposals, evidence, and constraints in their packet", () => {
  const fixture = validFixture();
  const invalid = makeDecision(
    fixture.packet,
    fixture.proposal,
    fixture.evidence,
    fixture.constraint,
    {
      proposalId: "proposal-missing",
      supportingEvidenceIds: ["ev_missing"],
      constraintIds: ["constraint-missing"],
    },
  );
  const validation = validateVerificationDecisions(fixture.packet, [invalid]);

  assert.equal(validation.valid, false);
  assert.ok(issueCodes(validation).includes("unknown_proposal"));
  assert.ok(issueCodes(validation).includes("unknown_evidence"));
  assert.ok(issueCodes(validation).includes("unknown_constraint"));
});

test("a corrected payload on a non-verified decision is never promotable", () => {
  const fixture = validFixture();
  const rejected = makeDecision(
    fixture.packet,
    fixture.proposal,
    fixture.evidence,
    fixture.constraint,
    {
      verdict: "rejected",
      correctedPayload: { subject: "Alec", rejectedSuggestion: true },
    },
  );
  const batch = makeBatch(fixture.packet, fixture.constraint, [rejected]);

  assert.equal(validateVerificationDecisions(fixture.packet, [rejected]).valid, true);
  assert.throws(
    () => promotablePayloadForDecision(fixture.proposal, rejected),
    (error: unknown) => {
      assert.ok(error instanceof AnalysisContractValidationError);
      assert.ok(error.issues.some((issue) => issue.code === "unverified_promotion"));
      return true;
    },
  );
  const validation = validateCanonPromotionBatch(fixture.packet, [rejected], batch);
  assert.equal(validation.valid, false);
  assert.ok(issueCodes(validation).includes("unverified_promotion"));
  assert.throws(() => buildVerifiedPromotionPlan(fixture.packet, [rejected], batch));
});

test("promotion detects owner-constraint changes made after verification", () => {
  const fixture = validFixture();
  const stale = makeBatch(fixture.packet, fixture.constraint, [fixture.decision], {
    expectedConstraintFingerprints: ["constraint_outdated"],
  });
  const validation = validateCanonPromotionBatch(
    fixture.packet,
    [fixture.decision],
    stale,
  );
  assert.equal(validation.valid, false);
  assert.ok(issueCodes(validation).includes("stale_constraints"));
});

test("a committed receipt can claim only the exact verified promotion payload", () => {
  const fixture = validFixture();
  const plan = buildVerifiedPromotionPlan(
    fixture.packet,
    [fixture.decision],
    fixture.batch,
  );
  const receipt: CanonPromotionReceipt = {
    id: "receipt-alec-echo",
    batchId: fixture.batch.id,
    batchFingerprint: fixture.batch.fingerprint,
    packetFingerprint: fixture.packet.fingerprint,
    worldId: fixture.packet.worldId,
    editionId: fixture.packet.editionId,
    analysisRunId: fixture.packet.analysisRunId,
    status: "committed",
    promoted: [{
      proposalId: fixture.proposal.id,
      decisionId: fixture.decision.id,
      canonKind: fixture.proposal.kind,
      canonRecordId: "world-relation-alec-echo",
      canonVersion: 1,
      payloadFingerprint: plan[0]?.payloadFingerprint ?? "",
    }],
    rejectedProposalIds: [],
    deferredProposalIds: [],
    projectionRevision: 1,
    committedAt: "2026-08-28T12:00:01.000Z",
  };
  assert.equal(
    validateCanonPromotionReceipt(
      fixture.packet,
      [fixture.decision],
      fixture.batch,
      receipt,
    ).valid,
    true,
  );

  const forged: CanonPromotionReceipt = {
    ...receipt,
    promoted: [{ ...receipt.promoted[0]!, payloadFingerprint: "canon_payload_forged" }],
  };
  const validation = validateCanonPromotionReceipt(
    fixture.packet,
    [fixture.decision],
    fixture.batch,
    forged,
  );
  assert.equal(validation.valid, false);
  assert.ok(issueCodes(validation).includes("payload_mismatch"));
});
