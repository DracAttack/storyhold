import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export const EVIDENCE_ROLES = ["support", "contradiction", "context"] as const;
export type EvidenceRole = (typeof EVIDENCE_ROLES)[number];

export const EVIDENCE_SOURCE_KINDS = [
  "manuscript",
  "owner_constraint",
  "outside_reference",
] as const;
export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];

/**
 * A content-addressed excerpt. Extractors may point at evidence, but may not
 * turn it into canon merely by emitting an anchor.
 */
export type EvidenceAnchor = {
  id: string;
  chunkId: string;
  sourceId: string;
  quote: string;
  startOffset?: number;
  endOffset?: number;
  role: EvidenceRole;
  sourceKind: EvidenceSourceKind;
};

export const PROPOSAL_KINDS = [
  "entity",
  "identity",
  "claim",
  "relation",
  "rule",
  "event",
  "chapter_summary",
  "dossier_fact",
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSER_LANES = [
  "deterministic",
  "local_model",
  "hosted_extractor",
] as const;
export type ProposerLane = (typeof PROPOSER_LANES)[number];

export type ProposalOrigin = {
  lane: ProposerLane;
  provider?: string;
  model?: string;
};

/**
 * Extractor output is deliberately candidate-only. There is no "verified"
 * proposal status: verification is a separate, packet-bound contract.
 */
export type AnalysisProposal<TPayload extends JsonObject = JsonObject> = {
  id: string;
  fingerprint: string;
  worldId: string;
  editionId: string;
  analysisRunId: string;
  kind: ProposalKind;
  status: "candidate";
  payload: TPayload;
  proposedBy: ProposalOrigin;
  confidence: number;
  evidenceIds: string[];
  retrievalQueries: string[];
  dependencyIds: string[];
  constraintIds: string[];
};

export type ExistingCanonRecord = {
  id: string;
  kind: ProposalKind;
  status: "active" | "disputed" | "superseded";
  version: number;
  value: JsonObject;
};

export const OWNER_CONSTRAINT_KINDS = [
  "identity",
  "relation",
  "timeline",
  "categorization",
  "canon",
  "exclusion",
  "other",
] as const;
export type OwnerConstraintKind = (typeof OWNER_CONSTRAINT_KINDS)[number];

export type OwnerConstraintSnapshot = {
  id: string;
  fingerprint: string;
  kind: OwnerConstraintKind;
  instruction: string;
  /** Optional for older contract families. Modern World Clock snapshots use an
   * explicit UUID or null so moving a correction between world/entity scope
   * changes every enclosing fingerprint. */
  scopeEntityId?: string | null;
};

export type EvidencePacket = {
  id: string;
  fingerprint: string;
  worldId: string;
  editionId: string;
  analysisRunId: string;
  corpusFingerprint: string;
  scope: {
    proposalIds: string[];
    entityIds: string[];
    chapterKeys: string[];
  };
  proposals: AnalysisProposal[];
  evidence: EvidenceAnchor[];
  existingCanon: ExistingCanonRecord[];
  ownerConstraints: OwnerConstraintSnapshot[];
  retrieval: {
    queries: string[];
    coveredTerms: string[];
    missingTerms: string[];
  };
};

export const VERIFICATION_VERDICTS = [
  "verified",
  "rejected",
  "disputed",
  "insufficient_evidence",
  "needs_more_evidence",
] as const;
export type VerificationVerdict = (typeof VERIFICATION_VERDICTS)[number];

export type VerificationDecision = {
  id: string;
  proposalId: string;
  packetFingerprint: string;
  verdict: VerificationVerdict;
  correctedPayload?: JsonObject;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  constraintIds: string[];
  confidence: number;
  explanation: string;
  retrievalRequests: string[];
  verifier: {
    provider: string;
    model: string;
  };
  completedAt: string;
};

export type VerifiedDecision = VerificationDecision & { verdict: "verified" };

export type CanonPromotionBatch = {
  id: string;
  fingerprint: string;
  worldId: string;
  editionId: string;
  analysisRunId: string;
  corpusFingerprint: string;
  packetFingerprint: string;
  expectedConstraintFingerprints: string[];
  decisionIds: string[];
};

export type CanonPromotionReceiptEntry = {
  proposalId: string;
  decisionId: string;
  canonKind: ProposalKind;
  canonRecordId: string;
  canonVersion: number;
  payloadFingerprint: string;
};

export type CanonPromotionReceipt = {
  id: string;
  batchId: string;
  batchFingerprint: string;
  packetFingerprint: string;
  worldId: string;
  editionId: string;
  analysisRunId: string;
  status: "committed" | "rejected";
  promoted: CanonPromotionReceiptEntry[];
  rejectedProposalIds: string[];
  deferredProposalIds: string[];
  projectionRevision: number;
  committedAt: string;
};

export type VerifiedPromotionEntry = {
  proposal: AnalysisProposal;
  decision: VerifiedDecision;
  payload: JsonObject;
  payloadFingerprint: string;
};

export type ContractValidationIssue = {
  path: string;
  code: string;
  message: string;
};

export type ContractValidationResult = {
  valid: boolean;
  issues: ContractValidationIssue[];
};

export class AnalysisContractValidationError extends Error {
  readonly issues: ContractValidationIssue[];

  constructor(message: string, issues: ContractValidationIssue[]) {
    super(message);
    this.name = "AnalysisContractValidationError";
    this.issues = issues;
  }
}

type EvidenceAnchorBody = Omit<EvidenceAnchor, "id">;
type ProposalBody = Omit<AnalysisProposal, "fingerprint">;
type EvidencePacketBody = Omit<EvidencePacket, "fingerprint">;
type PromotionBatchBody = Omit<CanonPromotionBatch, "fingerprint">;
type OwnerConstraintBody = Omit<OwnerConstraintSnapshot, "fingerprint">;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  let valid = false;
  if (Array.isArray(value)) {
    valid = value.every((item) => isJsonValue(item, ancestors));
  } else if (isRecord(value)) {
    valid = Object.values(value).every((item) => isJsonValue(item, ancestors));
  }
  ancestors.delete(value);
  return valid;
}

function stableSerialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Fingerprint input contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .join(",")}}`;
  }
  throw new TypeError(`Fingerprint input contains a non-JSON value of type ${typeof value}`);
}

function digest(namespace: string, value: unknown): string {
  return createHash("sha256")
    .update(`${namespace}\n${stableSerialize(value)}`, "utf8")
    .digest("hex");
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function byId<T extends { id: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => left.id.localeCompare(right.id));
}

export function evidenceAnchorFingerprint(anchor: EvidenceAnchorBody | EvidenceAnchor): string {
  return `ev_${digest("storyhold:evidence-anchor:v1", {
    chunkId: anchor.chunkId,
    sourceId: anchor.sourceId,
    quote: anchor.quote,
    startOffset: anchor.startOffset,
    endOffset: anchor.endOffset,
    role: anchor.role,
    sourceKind: anchor.sourceKind,
  })}`;
}

export function analysisProposalFingerprint(proposal: ProposalBody | AnalysisProposal): string {
  return `proposal_${digest("storyhold:analysis-proposal:v1", {
    id: proposal.id,
    worldId: proposal.worldId,
    editionId: proposal.editionId,
    analysisRunId: proposal.analysisRunId,
    kind: proposal.kind,
    status: proposal.status,
    payload: proposal.payload,
    proposedBy: proposal.proposedBy,
    confidence: proposal.confidence,
    evidenceIds: sortedUnique(proposal.evidenceIds),
    retrievalQueries: sortedUnique(proposal.retrievalQueries),
    dependencyIds: sortedUnique(proposal.dependencyIds),
    constraintIds: sortedUnique(proposal.constraintIds),
  })}`;
}

export function ownerConstraintFingerprint(
  constraint: OwnerConstraintBody | OwnerConstraintSnapshot,
): string {
  return `constraint_${digest("storyhold:owner-constraint:v1", {
    id: constraint.id,
    kind: constraint.kind,
    instruction: constraint.instruction,
    scopeEntityId: constraint.scopeEntityId,
  })}`;
}

export function evidencePacketFingerprint(packet: EvidencePacketBody | EvidencePacket): string {
  return `packet_${digest("storyhold:evidence-packet:v1", {
    id: packet.id,
    worldId: packet.worldId,
    editionId: packet.editionId,
    analysisRunId: packet.analysisRunId,
    corpusFingerprint: packet.corpusFingerprint,
    scope: {
      proposalIds: sortedUnique(packet.scope.proposalIds),
      entityIds: sortedUnique(packet.scope.entityIds),
      chapterKeys: sortedUnique(packet.scope.chapterKeys),
    },
    proposals: byId(packet.proposals),
    evidence: byId(packet.evidence),
    existingCanon: byId(packet.existingCanon),
    ownerConstraints: byId(packet.ownerConstraints),
    retrieval: {
      queries: sortedUnique(packet.retrieval.queries),
      coveredTerms: sortedUnique(packet.retrieval.coveredTerms),
      missingTerms: sortedUnique(packet.retrieval.missingTerms),
    },
  })}`;
}

export function canonPromotionBatchFingerprint(
  batch: PromotionBatchBody | CanonPromotionBatch,
): string {
  return `promotion_${digest("storyhold:canon-promotion-batch:v1", {
    id: batch.id,
    worldId: batch.worldId,
    editionId: batch.editionId,
    analysisRunId: batch.analysisRunId,
    corpusFingerprint: batch.corpusFingerprint,
    packetFingerprint: batch.packetFingerprint,
    expectedConstraintFingerprints: sortedUnique(batch.expectedConstraintFingerprints),
    decisionIds: sortedUnique(batch.decisionIds),
  })}`;
}

export function canonPayloadFingerprint(payload: JsonObject): string {
  return `canon_payload_${digest("storyhold:canon-payload:v1", payload)}`;
}

function addIssue(
  issues: ContractValidationIssue[],
  path: string,
  code: string,
  message: string,
): void {
  issues.push({ path, code, message });
}

function checkNonblank(
  value: unknown,
  path: string,
  issues: ContractValidationIssue[],
): value is string {
  if (typeof value !== "string" || !value.trim()) {
    addIssue(issues, path, "required_string", "Must be a non-blank string");
    return false;
  }
  return true;
}

function checkStringSet(
  values: unknown,
  path: string,
  issues: ContractValidationIssue[],
): values is string[] {
  if (!Array.isArray(values)) {
    addIssue(issues, path, "required_array", "Must be an array of strings");
    return false;
  }
  let valid = true;
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (!checkNonblank(value, `${path}[${index}]`, issues)) {
      valid = false;
      return;
    }
    if (seen.has(value)) {
      addIssue(issues, `${path}[${index}]`, "duplicate_reference", `Duplicate reference ${value}`);
      valid = false;
    }
    seen.add(value);
  });
  return valid;
}

function checkConfidence(value: unknown, path: string, issues: ContractValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    addIssue(issues, path, "invalid_confidence", "Must be a finite number from 0 through 1");
  }
}

function checkIsoDate(value: unknown, path: string, issues: ContractValidationIssue[]): void {
  if (!checkNonblank(value, path, issues)) return;
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(value) || Number.isNaN(Date.parse(value))) {
    addIssue(issues, path, "invalid_timestamp", "Must be an ISO-8601 timestamp");
  }
}

function result(issues: ContractValidationIssue[]): ContractValidationResult {
  return { valid: issues.length === 0, issues };
}

function equalStringSets(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = sortedUnique(left);
  const normalizedRight = sortedUnique(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function includeUnknownReferences(
  values: readonly string[],
  known: ReadonlySet<string>,
  path: string,
  code: string,
  label: string,
  issues: ContractValidationIssue[],
): void {
  values.forEach((value, index) => {
    if (!known.has(value)) {
      addIssue(issues, `${path}[${index}]`, code, `${label} ${value} is not present in this packet`);
    }
  });
}

export function validateEvidenceAnchor(anchor: EvidenceAnchor): ContractValidationResult {
  const issues: ContractValidationIssue[] = [];
  checkNonblank(anchor.id, "id", issues);
  checkNonblank(anchor.chunkId, "chunkId", issues);
  checkNonblank(anchor.sourceId, "sourceId", issues);
  checkNonblank(anchor.quote, "quote", issues);
  if (!EVIDENCE_ROLES.includes(anchor.role)) {
    addIssue(issues, "role", "invalid_enum", "Unknown evidence role");
  }
  if (!EVIDENCE_SOURCE_KINDS.includes(anchor.sourceKind)) {
    addIssue(issues, "sourceKind", "invalid_enum", "Unknown evidence source kind");
  }
  const hasStart = anchor.startOffset !== undefined;
  const hasEnd = anchor.endOffset !== undefined;
  if (hasStart !== hasEnd) {
    addIssue(issues, "startOffset", "incomplete_offset_range", "Both offsets must be supplied together");
  } else if (hasStart && hasEnd) {
    if (!Number.isInteger(anchor.startOffset) || (anchor.startOffset ?? -1) < 0) {
      addIssue(issues, "startOffset", "invalid_offset", "Must be a non-negative integer");
    }
    if (!Number.isInteger(anchor.endOffset) || (anchor.endOffset ?? -1) <= (anchor.startOffset ?? -1)) {
      addIssue(issues, "endOffset", "invalid_offset", "Must be an integer greater than startOffset");
    }
  }
  try {
    const expected = evidenceAnchorFingerprint(anchor);
    if (anchor.id !== expected) {
      addIssue(issues, "id", "fingerprint_mismatch", "Evidence ID does not match its content");
    }
  } catch (error) {
    addIssue(issues, "id", "unfingerprintable", error instanceof Error ? error.message : "Invalid evidence");
  }
  return result(issues);
}

export function validateAnalysisProposal(proposal: AnalysisProposal): ContractValidationResult {
  const issues: ContractValidationIssue[] = [];
  checkNonblank(proposal.id, "id", issues);
  checkNonblank(proposal.fingerprint, "fingerprint", issues);
  checkNonblank(proposal.worldId, "worldId", issues);
  checkNonblank(proposal.editionId, "editionId", issues);
  checkNonblank(proposal.analysisRunId, "analysisRunId", issues);
  if (!PROPOSAL_KINDS.includes(proposal.kind)) {
    addIssue(issues, "kind", "invalid_enum", "Unknown proposal kind");
  }
  if (proposal.status !== "candidate") {
    addIssue(
      issues,
      "status",
      "extractor_cannot_verify",
      "Analysis proposals must remain candidate-only until a separate verifier decision",
    );
  }
  if (!isRecord(proposal.payload) || !isJsonValue(proposal.payload)) {
    addIssue(issues, "payload", "invalid_json_object", "Payload must be a finite, acyclic JSON object");
  }
  if (!proposal.proposedBy || typeof proposal.proposedBy !== "object") {
    addIssue(issues, "proposedBy", "required_object", "Proposal origin is required");
  } else {
    if (!PROPOSER_LANES.includes(proposal.proposedBy.lane)) {
      addIssue(issues, "proposedBy.lane", "invalid_enum", "Unknown proposer lane");
    }
    if (proposal.proposedBy.provider !== undefined) {
      checkNonblank(proposal.proposedBy.provider, "proposedBy.provider", issues);
    }
    if (proposal.proposedBy.model !== undefined) {
      checkNonblank(proposal.proposedBy.model, "proposedBy.model", issues);
    }
  }
  checkConfidence(proposal.confidence, "confidence", issues);
  checkStringSet(proposal.evidenceIds, "evidenceIds", issues);
  checkStringSet(proposal.retrievalQueries, "retrievalQueries", issues);
  checkStringSet(proposal.dependencyIds, "dependencyIds", issues);
  checkStringSet(proposal.constraintIds, "constraintIds", issues);
  try {
    const expected = analysisProposalFingerprint(proposal);
    if (proposal.fingerprint !== expected) {
      addIssue(issues, "fingerprint", "fingerprint_mismatch", "Proposal fingerprint does not match its content");
    }
  } catch (error) {
    addIssue(
      issues,
      "fingerprint",
      "unfingerprintable",
      error instanceof Error ? error.message : "Invalid proposal",
    );
  }
  return result(issues);
}

export function validateEvidencePacket(packet: EvidencePacket): ContractValidationResult {
  const issues: ContractValidationIssue[] = [];
  checkNonblank(packet.id, "id", issues);
  checkNonblank(packet.fingerprint, "fingerprint", issues);
  checkNonblank(packet.worldId, "worldId", issues);
  checkNonblank(packet.editionId, "editionId", issues);
  checkNonblank(packet.analysisRunId, "analysisRunId", issues);
  checkNonblank(packet.corpusFingerprint, "corpusFingerprint", issues);
  checkStringSet(packet.scope.proposalIds, "scope.proposalIds", issues);
  checkStringSet(packet.scope.entityIds, "scope.entityIds", issues);
  checkStringSet(packet.scope.chapterKeys, "scope.chapterKeys", issues);

  const evidenceIds = new Set<string>();
  packet.evidence.forEach((anchor, index) => {
    const anchorResult = validateEvidenceAnchor(anchor);
    anchorResult.issues.forEach((issue) => {
      addIssue(issues, `evidence[${index}].${issue.path}`, issue.code, issue.message);
    });
    if (evidenceIds.has(anchor.id)) {
      addIssue(issues, `evidence[${index}].id`, "duplicate_id", `Duplicate evidence ID ${anchor.id}`);
    }
    evidenceIds.add(anchor.id);
  });

  const proposalIds = new Set<string>();
  packet.proposals.forEach((proposal, index) => {
    const proposalResult = validateAnalysisProposal(proposal);
    proposalResult.issues.forEach((issue) => {
      addIssue(issues, `proposals[${index}].${issue.path}`, issue.code, issue.message);
    });
    if (proposalIds.has(proposal.id)) {
      addIssue(issues, `proposals[${index}].id`, "duplicate_id", `Duplicate proposal ID ${proposal.id}`);
    }
    proposalIds.add(proposal.id);
    if (
      proposal.worldId !== packet.worldId
      || proposal.editionId !== packet.editionId
      || proposal.analysisRunId !== packet.analysisRunId
    ) {
      addIssue(
        issues,
        `proposals[${index}]`,
        "scope_mismatch",
        "Proposal world, edition, and run must match the packet",
      );
    }
  });

  const constraintIds = new Set<string>();
  packet.ownerConstraints.forEach((constraint, index) => {
    checkNonblank(constraint.id, `ownerConstraints[${index}].id`, issues);
    checkNonblank(constraint.fingerprint, `ownerConstraints[${index}].fingerprint`, issues);
    checkNonblank(constraint.instruction, `ownerConstraints[${index}].instruction`, issues);
    if (constraint.scopeEntityId !== undefined && constraint.scopeEntityId !== null) {
      checkNonblank(constraint.scopeEntityId, `ownerConstraints[${index}].scopeEntityId`, issues);
    }
    if (!OWNER_CONSTRAINT_KINDS.includes(constraint.kind)) {
      addIssue(issues, `ownerConstraints[${index}].kind`, "invalid_enum", "Unknown constraint kind");
    }
    try {
      if (constraint.fingerprint !== ownerConstraintFingerprint(constraint)) {
        addIssue(
          issues,
          `ownerConstraints[${index}].fingerprint`,
          "fingerprint_mismatch",
          "Owner-constraint fingerprint does not match its content",
        );
      }
    } catch (error) {
      addIssue(
        issues,
        `ownerConstraints[${index}].fingerprint`,
        "unfingerprintable",
        error instanceof Error ? error.message : "Invalid owner constraint",
      );
    }
    if (constraintIds.has(constraint.id)) {
      addIssue(
        issues,
        `ownerConstraints[${index}].id`,
        "duplicate_id",
        `Duplicate constraint ID ${constraint.id}`,
      );
    }
    constraintIds.add(constraint.id);
  });

  packet.existingCanon.forEach((record, index) => {
    checkNonblank(record.id, `existingCanon[${index}].id`, issues);
    if (!PROPOSAL_KINDS.includes(record.kind)) {
      addIssue(issues, `existingCanon[${index}].kind`, "invalid_enum", "Unknown canon kind");
    }
    if (!Number.isInteger(record.version) || record.version < 1) {
      addIssue(issues, `existingCanon[${index}].version`, "invalid_version", "Version must be a positive integer");
    }
    if (!isRecord(record.value) || !isJsonValue(record.value)) {
      addIssue(issues, `existingCanon[${index}].value`, "invalid_json_object", "Canon value must be a JSON object");
    }
  });

  packet.proposals.forEach((proposal, index) => {
    includeUnknownReferences(
      proposal.evidenceIds,
      evidenceIds,
      `proposals[${index}].evidenceIds`,
      "unknown_evidence",
      "Evidence",
      issues,
    );
    includeUnknownReferences(
      proposal.dependencyIds,
      proposalIds,
      `proposals[${index}].dependencyIds`,
      "unknown_dependency",
      "Proposal dependency",
      issues,
    );
    includeUnknownReferences(
      proposal.constraintIds,
      constraintIds,
      `proposals[${index}].constraintIds`,
      "unknown_constraint",
      "Owner constraint",
      issues,
    );
    if (proposal.dependencyIds.includes(proposal.id)) {
      addIssue(
        issues,
        `proposals[${index}].dependencyIds`,
        "self_dependency",
        "A proposal cannot depend on itself",
      );
    }
  });

  if (!equalStringSets(packet.scope.proposalIds, [...proposalIds])) {
    addIssue(
      issues,
      "scope.proposalIds",
      "scope_inventory_mismatch",
      "Packet scope must inventory exactly the included proposals",
    );
  }
  checkStringSet(packet.retrieval.queries, "retrieval.queries", issues);
  checkStringSet(packet.retrieval.coveredTerms, "retrieval.coveredTerms", issues);
  checkStringSet(packet.retrieval.missingTerms, "retrieval.missingTerms", issues);
  const overlap = packet.retrieval.coveredTerms.filter((term) => packet.retrieval.missingTerms.includes(term));
  if (overlap.length > 0) {
    addIssue(
      issues,
      "retrieval",
      "contradictory_coverage",
      `Terms cannot be both covered and missing: ${overlap.join(", ")}`,
    );
  }
  try {
    const expected = evidencePacketFingerprint(packet);
    if (packet.fingerprint !== expected) {
      addIssue(issues, "fingerprint", "fingerprint_mismatch", "Packet fingerprint does not match its contents");
    }
  } catch (error) {
    addIssue(issues, "fingerprint", "unfingerprintable", error instanceof Error ? error.message : "Invalid packet");
  }
  return result(issues);
}

export function validateVerificationDecisions(
  packet: EvidencePacket,
  decisions: readonly VerificationDecision[],
): ContractValidationResult {
  const issues = [...validateEvidencePacket(packet).issues];
  const proposalIds = new Set(packet.proposals.map((proposal) => proposal.id));
  const evidenceIds = new Set(packet.evidence.map((anchor) => anchor.id));
  const constraintIds = new Set(packet.ownerConstraints.map((constraint) => constraint.id));
  const decisionIds = new Set<string>();
  const decidedProposalIds = new Set<string>();

  decisions.forEach((decision, index) => {
    const path = `decisions[${index}]`;
    checkNonblank(decision.id, `${path}.id`, issues);
    if (decisionIds.has(decision.id)) {
      addIssue(issues, `${path}.id`, "duplicate_id", `Duplicate decision ID ${decision.id}`);
    }
    decisionIds.add(decision.id);
    checkNonblank(decision.proposalId, `${path}.proposalId`, issues);
    if (!proposalIds.has(decision.proposalId)) {
      addIssue(
        issues,
        `${path}.proposalId`,
        "unknown_proposal",
        `Proposal ${decision.proposalId} is not present in this packet`,
      );
    }
    if (decidedProposalIds.has(decision.proposalId)) {
      addIssue(
        issues,
        `${path}.proposalId`,
        "duplicate_final_decision",
        "A packet may contain only one final decision per proposal",
      );
    }
    decidedProposalIds.add(decision.proposalId);
    if (decision.packetFingerprint !== packet.fingerprint) {
      addIssue(
        issues,
        `${path}.packetFingerprint`,
        "packet_fingerprint_mismatch",
        "Decision was not made against this exact evidence packet",
      );
    }
    if (!VERIFICATION_VERDICTS.includes(decision.verdict)) {
      addIssue(issues, `${path}.verdict`, "invalid_enum", "Unknown verification verdict");
    }
    if (
      decision.correctedPayload !== undefined
      && (!isRecord(decision.correctedPayload) || !isJsonValue(decision.correctedPayload))
    ) {
      addIssue(
        issues,
        `${path}.correctedPayload`,
        "invalid_json_object",
        "Corrected payload must be a finite, acyclic JSON object",
      );
    }
    checkStringSet(decision.supportingEvidenceIds, `${path}.supportingEvidenceIds`, issues);
    checkStringSet(decision.contradictingEvidenceIds, `${path}.contradictingEvidenceIds`, issues);
    checkStringSet(decision.constraintIds, `${path}.constraintIds`, issues);
    checkStringSet(decision.retrievalRequests, `${path}.retrievalRequests`, issues);
    includeUnknownReferences(
      decision.supportingEvidenceIds,
      evidenceIds,
      `${path}.supportingEvidenceIds`,
      "unknown_evidence",
      "Evidence",
      issues,
    );
    includeUnknownReferences(
      decision.contradictingEvidenceIds,
      evidenceIds,
      `${path}.contradictingEvidenceIds`,
      "unknown_evidence",
      "Evidence",
      issues,
    );
    includeUnknownReferences(
      decision.constraintIds,
      constraintIds,
      `${path}.constraintIds`,
      "unknown_constraint",
      "Owner constraint",
      issues,
    );
    const evidenceOverlap = decision.supportingEvidenceIds.filter((id) =>
      decision.contradictingEvidenceIds.includes(id));
    if (evidenceOverlap.length > 0) {
      addIssue(
        issues,
        path,
        "conflicting_evidence_role",
        `Evidence cannot both support and contradict one decision: ${evidenceOverlap.join(", ")}`,
      );
    }
    if (decision.verdict === "verified" && decision.supportingEvidenceIds.length === 0) {
      addIssue(
        issues,
        `${path}.supportingEvidenceIds`,
        "verification_without_evidence",
        "A verified decision must cite at least one supporting evidence anchor",
      );
    }
    if (decision.verdict === "needs_more_evidence" && decision.retrievalRequests.length === 0) {
      addIssue(
        issues,
        `${path}.retrievalRequests`,
        "missing_retrieval_request",
        "A needs-more-evidence decision must say what to retrieve",
      );
    }
    checkConfidence(decision.confidence, `${path}.confidence`, issues);
    checkNonblank(decision.explanation, `${path}.explanation`, issues);
    checkNonblank(decision.verifier?.provider, `${path}.verifier.provider`, issues);
    checkNonblank(decision.verifier?.model, `${path}.verifier.model`, issues);
    checkIsoDate(decision.completedAt, `${path}.completedAt`, issues);
  });
  return result(issues);
}

export function validateCanonPromotionBatch(
  packet: EvidencePacket,
  decisions: readonly VerificationDecision[],
  batch: CanonPromotionBatch,
): ContractValidationResult {
  const issues = [...validateVerificationDecisions(packet, decisions).issues];
  checkNonblank(batch.id, "batch.id", issues);
  checkNonblank(batch.fingerprint, "batch.fingerprint", issues);
  checkStringSet(batch.expectedConstraintFingerprints, "batch.expectedConstraintFingerprints", issues);
  checkStringSet(batch.decisionIds, "batch.decisionIds", issues);
  if (
    batch.worldId !== packet.worldId
    || batch.editionId !== packet.editionId
    || batch.analysisRunId !== packet.analysisRunId
    || batch.corpusFingerprint !== packet.corpusFingerprint
  ) {
    addIssue(issues, "batch", "scope_mismatch", "Promotion batch scope must match the evidence packet");
  }
  if (batch.packetFingerprint !== packet.fingerprint) {
    addIssue(
      issues,
      "batch.packetFingerprint",
      "packet_fingerprint_mismatch",
      "Promotion batch must target this exact evidence packet",
    );
  }
  const expectedConstraints = packet.ownerConstraints.map((constraint) => constraint.fingerprint);
  if (!equalStringSets(batch.expectedConstraintFingerprints, expectedConstraints)) {
    addIssue(
      issues,
      "batch.expectedConstraintFingerprints",
      "stale_constraints",
      "Promotion requires the exact owner-constraint snapshot that the verifier reviewed",
    );
  }
  const decisionsById = new Map(decisions.map((decision) => [decision.id, decision]));
  batch.decisionIds.forEach((decisionId, index) => {
    const decision = decisionsById.get(decisionId);
    if (!decision) {
      addIssue(
        issues,
        `batch.decisionIds[${index}]`,
        "unknown_decision",
        `Decision ${decisionId} was not supplied with this packet`,
      );
      return;
    }
    if (decision.verdict !== "verified") {
      addIssue(
        issues,
        `batch.decisionIds[${index}]`,
        "unverified_promotion",
        `Decision ${decisionId} is ${decision.verdict}, not verified`,
      );
    }
    if (decision.packetFingerprint !== packet.fingerprint) {
      addIssue(
        issues,
        `batch.decisionIds[${index}]`,
        "packet_fingerprint_mismatch",
        "Selected decision was made against a different packet",
      );
    }
  });
  try {
    const expected = canonPromotionBatchFingerprint(batch);
    if (batch.fingerprint !== expected) {
      addIssue(
        issues,
        "batch.fingerprint",
        "fingerprint_mismatch",
        "Promotion batch fingerprint does not match its content",
      );
    }
  } catch (error) {
    addIssue(
      issues,
      "batch.fingerprint",
      "unfingerprintable",
      error instanceof Error ? error.message : "Invalid promotion batch",
    );
  }
  return result(issues);
}

function throwIfInvalid(label: string, validation: ContractValidationResult): void {
  if (!validation.valid) {
    throw new AnalysisContractValidationError(`${label} failed contract validation`, validation.issues);
  }
}

/**
 * The only public unwrap for a verifier correction. A rejected, disputed, or
 * incomplete decision can carry a suggested correction for another pass, but
 * this function will never expose it as promotable canon.
 */
export function promotablePayloadForDecision(
  proposal: AnalysisProposal,
  decision: VerificationDecision,
): JsonObject {
  if (decision.proposalId !== proposal.id) {
    throw new AnalysisContractValidationError("Decision does not belong to this proposal", [{
      path: "decision.proposalId",
      code: "proposal_mismatch",
      message: `Expected ${proposal.id}, received ${decision.proposalId}`,
    }]);
  }
  if (decision.verdict !== "verified") {
    throw new AnalysisContractValidationError("Only verified decisions have promotable payloads", [{
      path: "decision.verdict",
      code: "unverified_promotion",
      message: `Decision is ${decision.verdict}, not verified`,
    }]);
  }
  return decision.correctedPayload ?? proposal.payload;
}

export function buildVerifiedPromotionPlan(
  packet: EvidencePacket,
  decisions: readonly VerificationDecision[],
  batch: CanonPromotionBatch,
): VerifiedPromotionEntry[] {
  throwIfInvalid("Canon promotion batch", validateCanonPromotionBatch(packet, decisions, batch));
  const proposalsById = new Map(packet.proposals.map((proposal) => [proposal.id, proposal]));
  const decisionsById = new Map(decisions.map((decision) => [decision.id, decision]));
  return batch.decisionIds.map((decisionId) => {
    const decision = decisionsById.get(decisionId) as VerifiedDecision;
    const proposal = proposalsById.get(decision.proposalId);
    if (!proposal) {
      throw new AnalysisContractValidationError("Verified decision has no packet proposal", [{
        path: "decision.proposalId",
        code: "unknown_proposal",
        message: `Proposal ${decision.proposalId} is missing`,
      }]);
    }
    const payload = promotablePayloadForDecision(proposal, decision);
    return {
      proposal,
      decision,
      payload,
      payloadFingerprint: canonPayloadFingerprint(payload),
    };
  });
}

export function validateCanonPromotionReceipt(
  packet: EvidencePacket,
  decisions: readonly VerificationDecision[],
  batch: CanonPromotionBatch,
  receipt: CanonPromotionReceipt,
): ContractValidationResult {
  const issues = [...validateCanonPromotionBatch(packet, decisions, batch).issues];
  checkNonblank(receipt.id, "receipt.id", issues);
  if (receipt.batchId !== batch.id || receipt.batchFingerprint !== batch.fingerprint) {
    addIssue(issues, "receipt.batchId", "batch_mismatch", "Receipt must identify the exact promotion batch");
  }
  if (
    receipt.packetFingerprint !== packet.fingerprint
    || receipt.worldId !== packet.worldId
    || receipt.editionId !== packet.editionId
    || receipt.analysisRunId !== packet.analysisRunId
  ) {
    addIssue(issues, "receipt", "scope_mismatch", "Receipt scope must match the packet and batch");
  }
  if (!Number.isInteger(receipt.projectionRevision) || receipt.projectionRevision < 0) {
    addIssue(
      issues,
      "receipt.projectionRevision",
      "invalid_revision",
      "Projection revision must be a non-negative integer",
    );
  }
  checkIsoDate(receipt.committedAt, "receipt.committedAt", issues);
  checkStringSet(receipt.rejectedProposalIds, "receipt.rejectedProposalIds", issues);
  checkStringSet(receipt.deferredProposalIds, "receipt.deferredProposalIds", issues);

  let plan: VerifiedPromotionEntry[] = [];
  try {
    plan = buildVerifiedPromotionPlan(packet, decisions, batch);
  } catch {
    // The underlying validation issues were already copied above.
  }
  const planByProposal = new Map(plan.map((entry) => [entry.proposal.id, entry]));
  const receiptProposalIds = new Set<string>();
  receipt.promoted.forEach((entry, index) => {
    const path = `receipt.promoted[${index}]`;
    if (receiptProposalIds.has(entry.proposalId)) {
      addIssue(issues, `${path}.proposalId`, "duplicate_id", `Duplicate promoted proposal ${entry.proposalId}`);
    }
    receiptProposalIds.add(entry.proposalId);
    const planned = planByProposal.get(entry.proposalId);
    if (!planned) {
      addIssue(
        issues,
        `${path}.proposalId`,
        "unverified_promotion",
        `Proposal ${entry.proposalId} is not in the verified promotion plan`,
      );
      return;
    }
    if (entry.decisionId !== planned.decision.id) {
      addIssue(issues, `${path}.decisionId`, "decision_mismatch", "Receipt cites the wrong verifier decision");
    }
    if (entry.canonKind !== planned.proposal.kind) {
      addIssue(issues, `${path}.canonKind`, "kind_mismatch", "Receipt canon kind differs from the proposal");
    }
    if (entry.payloadFingerprint !== planned.payloadFingerprint) {
      addIssue(
        issues,
        `${path}.payloadFingerprint`,
        "payload_mismatch",
        "Receipt payload is not the verified proposal or verified correction",
      );
    }
    checkNonblank(entry.canonRecordId, `${path}.canonRecordId`, issues);
    if (!Number.isInteger(entry.canonVersion) || entry.canonVersion < 1) {
      addIssue(issues, `${path}.canonVersion`, "invalid_version", "Canon version must be a positive integer");
    }
  });
  if (receipt.status === "committed" && !equalStringSets([...receiptProposalIds], [...planByProposal.keys()])) {
    addIssue(
      issues,
      "receipt.promoted",
      "incomplete_receipt",
      "A committed receipt must account for every proposal in its verified promotion plan",
    );
  }
  return result(issues);
}
