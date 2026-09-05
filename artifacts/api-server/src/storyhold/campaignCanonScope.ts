import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;

export const campaignCanonScopeSchemaSql = String.raw`
  CREATE TABLE IF NOT EXISTS storyhold.campaign_canon_evidence_snapshots (
    campaign_id uuid NOT NULL REFERENCES storyhold.campaigns(id) ON DELETE CASCADE,
    evidence_key text NOT NULL,
    world_id uuid NOT NULL,
    canon_edition_id uuid NOT NULL,
    source_id uuid NOT NULL,
    chunk_id uuid NOT NULL,
    source_content_hash text NOT NULL,
    chunk_content_hash text NOT NULL,
    source_title text NOT NULL DEFAULT '',
    source_kind text NOT NULL DEFAULT 'manuscript',
    chronology_label text NOT NULL DEFAULT '',
    excerpt text NOT NULL,
    excerpt_hash text NOT NULL,
    event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    chronology_orders jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (campaign_id, evidence_key)
  );

  CREATE INDEX IF NOT EXISTS campaign_canon_evidence_snapshot_scope
    ON storyhold.campaign_canon_evidence_snapshots
      (campaign_id, source_id, chunk_id);
  CREATE INDEX IF NOT EXISTS campaign_canon_evidence_snapshot_text
    ON storyhold.campaign_canon_evidence_snapshots
    USING GIN (to_tsvector('simple', excerpt));

  CREATE TABLE IF NOT EXISTS storyhold.campaign_canon_claim_snapshots (
    campaign_id uuid NOT NULL REFERENCES storyhold.campaigns(id) ON DELETE CASCADE,
    claim_id uuid NOT NULL,
    world_id uuid NOT NULL,
    canon_edition_id uuid NOT NULL,
    fingerprint text NOT NULL,
    supersedes_claim_id uuid,
    subject_entity_id uuid NOT NULL,
    predicate text NOT NULL,
    polarity text NOT NULL DEFAULT 'positive'
      CHECK (polarity IN ('positive', 'negative')),
    object_entity_id uuid,
    object_text text NOT NULL DEFAULT '',
    epistemic_holder_entity_id uuid,
    truth_status text NOT NULL
      CHECK (truth_status IN ('fact', 'belief', 'rumor', 'lie', 'disputed', 'unknown')),
    valid_from_label text NOT NULL DEFAULT '',
    valid_until_label text NOT NULL DEFAULT '',
    summary text NOT NULL DEFAULT '',
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    confidence real NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
    claim_status text NOT NULL
      CHECK (claim_status IN ('active', 'disputed', 'superseded', 'rejected')),
    assignment_source text NOT NULL
      CHECK (assignment_source IN ('local', 'ai', 'user')),
    source_updated_at timestamptz,
    snapshot_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (campaign_id, claim_id)
  );

  CREATE INDEX IF NOT EXISTS campaign_canon_claim_snapshot_scope
    ON storyhold.campaign_canon_claim_snapshots
      (campaign_id, truth_status, claim_status, subject_entity_id);

  CREATE OR REPLACE FUNCTION storyhold.reject_campaign_canon_snapshot_mutation()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'Campaign canon snapshots are append-only';
  END;
  $$;

  DROP TRIGGER IF EXISTS campaign_canon_evidence_snapshots_immutable
    ON storyhold.campaign_canon_evidence_snapshots;
  CREATE TRIGGER campaign_canon_evidence_snapshots_immutable
    BEFORE UPDATE ON storyhold.campaign_canon_evidence_snapshots
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_campaign_canon_snapshot_mutation();

  DROP TRIGGER IF EXISTS campaign_canon_claim_snapshots_immutable
    ON storyhold.campaign_canon_claim_snapshots;
  CREATE TRIGGER campaign_canon_claim_snapshots_immutable
    BEFORE UPDATE ON storyhold.campaign_canon_claim_snapshots
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_campaign_canon_snapshot_mutation();
`;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;
function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is JsonRecord =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function clean(value: unknown, maximum = 2_000): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, maximum)
    : "";
}

function identifier(value: unknown): string {
  const candidate = clean(value, 100);
  return UUID_PATTERN.test(candidate) ? candidate.toLocaleLowerCase() : "";
}

function finiteInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : null;
}

function boundedCount(value: unknown): number | null {
  const parsed = finiteInteger(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function normalized(value: unknown): string {
  return clean(value, 4_000)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

export function stableCanonSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)) ?? "null")
    .digest("hex");
}

export type CampaignCanonScopeMode =
  | "anchored_strict"
  | "edition_locked"
  | "legacy_anchored"
  | "legacy_unbounded"
  | "invalid";

export type LockedCampaignCanonScope = {
  present: boolean;
  valid: boolean;
  strict: boolean;
  mode: CampaignCanonScopeMode;
  policy: string | null;
  version: number | null;
  anchorEventId: string | null;
  anchorMode: "before" | "after" | null;
  maximumChronologyOrder: number | null;
  evidenceCount: number | null;
  claimCount: number | null;
  entityCount: number | null;
  evidenceSha256: string | null;
  claimsSha256: string | null;
  entitiesSha256: string | null;
  failureReason: string | null;
};

export type CampaignCanonScopeSnapshot = {
  version: 1;
  policy: "event_evidence_v1";
  mode: "anchored_strict" | "edition_locked";
  anchorEventId: string | null;
  anchorMode: "before" | "after" | null;
  maximumChronologyOrder: number | null;
  evidenceCount: number;
  claimCount: number;
  entityCount: number;
  evidenceSha256: string;
  claimsSha256: string;
  entitiesSha256: string;
};

function legacyCanonScope(start: JsonRecord): LockedCampaignCanonScope {
  const timeline = record(start.canonTimelineSnapshot);
  const anchorEventId = identifier(timeline.anchorEventId);
  const maximumChronologyOrder = finiteInteger(timeline.maximumChronologyOrder);
  const anchorMode = timeline.anchorMode === "before" || timeline.anchorMode === "after"
    ? timeline.anchorMode
    : null;
  const anchored = Boolean(anchorEventId && anchorMode && maximumChronologyOrder !== null);
  return {
    present: false,
    valid: true,
    strict: false,
    mode: anchored ? "legacy_anchored" : "legacy_unbounded",
    policy: null,
    version: null,
    anchorEventId: anchorEventId || null,
    anchorMode,
    maximumChronologyOrder,
    evidenceCount: null,
    claimCount: null,
    entityCount: null,
    evidenceSha256: null,
    claimsSha256: null,
    entitiesSha256: null,
    failureReason: null,
  };
}

/**
 * Parse the immutable campaign-start canon scope. A present but malformed
 * scope is deliberately invalid rather than falling back to live edition data.
 */
export function lockedCampaignCanonScope(value: unknown): LockedCampaignCanonScope {
  const start = record(value);
  if (!Object.prototype.hasOwnProperty.call(start, "canonScopeSnapshot")) {
    return legacyCanonScope(start);
  }
  const scope = record(start.canonScopeSnapshot);
  const requestedMode = clean(scope.mode, 40);
  const mode = requestedMode === "anchored_strict" || requestedMode === "edition_locked"
    ? requestedMode
    : "invalid";
  const version = finiteInteger(scope.version);
  const policy = clean(scope.policy, 80) || null;
  const anchorEventId = identifier(scope.anchorEventId) || null;
  const anchorMode = scope.anchorMode === "before" || scope.anchorMode === "after"
    ? scope.anchorMode
    : null;
  const maximumChronologyOrder = scope.maximumChronologyOrder === null
    ? null
    : finiteInteger(scope.maximumChronologyOrder);
  const evidenceCount = boundedCount(scope.evidenceCount);
  const claimCount = boundedCount(scope.claimCount);
  const entityCount = boundedCount(scope.entityCount);
  const evidenceSha256 = clean(scope.evidenceSha256, 64).toLocaleLowerCase();
  const claimsSha256 = clean(scope.claimsSha256, 64).toLocaleLowerCase();
  const entitiesSha256 = clean(scope.entitiesSha256, 64).toLocaleLowerCase();
  const commonValid =
    version === 1 &&
    policy === "event_evidence_v1" &&
    evidenceCount !== null && claimCount !== null && entityCount !== null &&
    SHA256_PATTERN.test(evidenceSha256) &&
    SHA256_PATTERN.test(claimsSha256) &&
    SHA256_PATTERN.test(entitiesSha256);
  const boundaryValid = mode === "edition_locked" || (
    mode === "anchored_strict" &&
    Boolean(anchorEventId && anchorMode && maximumChronologyOrder !== null)
  );
  const valid = commonValid && boundaryValid;
  return {
    present: true,
    valid,
    // A malformed present scope must still select fail-closed integration paths.
    strict:
      mode === "anchored_strict" || mode === "edition_locked" || mode === "invalid",
    mode,
    policy,
    version,
    anchorEventId,
    anchorMode,
    maximumChronologyOrder,
    evidenceCount,
    claimCount,
    entityCount,
    evidenceSha256: SHA256_PATTERN.test(evidenceSha256) ? evidenceSha256 : null,
    claimsSha256: SHA256_PATTERN.test(claimsSha256) ? claimsSha256 : null,
    entitiesSha256: SHA256_PATTERN.test(entitiesSha256) ? entitiesSha256 : null,
    failureReason: valid ? null : "The campaign canon scope is incomplete or malformed.",
  };
}

/** Build the exact metadata object stored inside a version-7 start contract. */
export function createCampaignCanonScopeSnapshot(params: {
  mode: "anchored_strict" | "edition_locked";
  anchorEventId?: string | null;
  anchorMode?: "before" | "after" | null;
  maximumChronologyOrder?: number | null;
  evidence: readonly CampaignCanonEvidenceSnapshot[];
  claims: readonly CampaignCanonClaimSnapshot[];
  entities: readonly unknown[];
}): CampaignCanonScopeSnapshot {
  const anchorEventId = identifier(params.anchorEventId) || null;
  const anchorMode = params.anchorMode === "before" || params.anchorMode === "after"
    ? params.anchorMode
    : null;
  const maximumChronologyOrder = params.maximumChronologyOrder === null ||
      params.maximumChronologyOrder === undefined
    ? null
    : finiteInteger(params.maximumChronologyOrder);
  if (
    params.mode === "anchored_strict" &&
    (!anchorEventId || !anchorMode || maximumChronologyOrder === null)
  ) {
    throw new Error("An anchored canon scope requires a valid event boundary.");
  }
  return {
    version: 1,
    policy: "event_evidence_v1",
    mode: params.mode,
    anchorEventId: params.mode === "anchored_strict" ? anchorEventId : null,
    anchorMode: params.mode === "anchored_strict" ? anchorMode : null,
    maximumChronologyOrder:
      params.mode === "anchored_strict" ? maximumChronologyOrder : null,
    evidenceCount: params.evidence.length,
    claimCount: params.claims.length,
    entityCount: params.entities.length,
    evidenceSha256: stableCanonSha256(params.evidence),
    claimsSha256: stableCanonSha256(params.claims),
    entitiesSha256: stableCanonSha256(params.entities),
  };
}

export type LockedSourceIdentity = {
  id: string;
  content_hash: string;
};

export type CanonEvidenceChunkCandidate = {
  id: string;
  source_id: string;
  world_id: string;
  canon_edition_id: string;
  content: string;
  content_hash: string;
  source_content_hash: string;
  source_title?: string;
  source_kind?: string;
  chronology_label?: string;
};

export type CampaignCanonEvidenceSnapshot = {
  evidence_key: string;
  world_id: string;
  canon_edition_id: string;
  source_id: string;
  chunk_id: string;
  source_content_hash: string;
  chunk_content_hash: string;
  source_title: string;
  source_kind: string;
  chronology_label: string;
  excerpt: string;
  excerpt_hash: string;
  event_ids: string[];
  chronology_orders: number[];
};

export type CanonProjectionRejection = {
  kind: "event_evidence" | "claim" | "entity";
  id: string;
  reason: string;
};

/**
 * Freeze every hash-verified chunk in the current canon edition. This is the
 * safe launch boundary for imported worlds that do not yet have a usable
 * World Clock event: play reads this immutable copy instead of mutable source
 * rows that may be changed by a later intake or owner edit.
 */
export function projectEditionLockedCanonEvidence(params: {
  worldId: string;
  editionId: string;
  chunks: readonly CanonEvidenceChunkCandidate[];
  lockedSources: readonly LockedSourceIdentity[];
}): {
  rows: CampaignCanonEvidenceSnapshot[];
  rejections: CanonProjectionRejection[];
  sha256: string;
} {
  const worldId = identifier(params.worldId);
  const editionId = identifier(params.editionId);
  const lockedSources = new Map(
    params.lockedSources
      .map((source) => [identifier(source.id), clean(source.content_hash, 200)] as const)
      .filter(([id, hash]) => id && hash),
  );
  const rows: CampaignCanonEvidenceSnapshot[] = [];
  const rejections: CanonProjectionRejection[] = [];
  for (const chunk of params.chunks) {
    const chunkId = identifier(chunk.id);
    const sourceId = identifier(chunk.source_id);
    const rejectionId = chunkId || sourceId || "unknown";
    const lockedSourceHash = lockedSources.get(sourceId);
    if (
      !chunkId || !sourceId || !worldId || !editionId ||
      identifier(chunk.world_id) !== worldId ||
      identifier(chunk.canon_edition_id) !== editionId
    ) {
      rejections.push({ kind: "event_evidence", id: rejectionId, reason: "scope_mismatch" });
      continue;
    }
    if (!lockedSourceHash) {
      rejections.push({ kind: "event_evidence", id: rejectionId, reason: "unlocked_source" });
      continue;
    }
    if (clean(chunk.source_content_hash, 200) !== lockedSourceHash) {
      rejections.push({ kind: "event_evidence", id: rejectionId, reason: "source_hash_mismatch" });
      continue;
    }
    const rawContent = typeof chunk.content === "string" ? chunk.content : "";
    const chunkHash = createHash("sha256").update(rawContent).digest("hex");
    if (!rawContent || chunkHash !== clean(chunk.content_hash, 200).toLocaleLowerCase()) {
      rejections.push({ kind: "event_evidence", id: rejectionId, reason: "chunk_hash_mismatch" });
      continue;
    }
    const excerpt = rawContent
      .replace(/\u0000/gu, "")
      .replace(/\r\n/gu, "\n")
      .trim()
      .slice(0, 500_000);
    if (!excerpt) {
      rejections.push({ kind: "event_evidence", id: rejectionId, reason: "empty_chunk" });
      continue;
    }
    rows.push({
      evidence_key: evidenceIdentity(sourceId, chunkId, excerpt),
      world_id: worldId,
      canon_edition_id: editionId,
      source_id: sourceId,
      chunk_id: chunkId,
      source_content_hash: lockedSourceHash,
      chunk_content_hash: chunkHash,
      source_title: clean(chunk.source_title, 500),
      source_kind: clean(chunk.source_kind, 80) || "manuscript",
      chronology_label: clean(chunk.chronology_label, 240),
      excerpt,
      excerpt_hash: createHash("sha256").update(excerpt).digest("hex"),
      event_ids: [],
      chronology_orders: [],
    });
  }
  const uniqueRows = rows
    .filter((row, index, all) =>
      all.findIndex((candidate) => candidate.evidence_key === row.evidence_key) === index
    )
    .sort((left, right) => left.evidence_key.localeCompare(right.evidence_key));
  return { rows: uniqueRows, rejections, sha256: stableCanonSha256(uniqueRows) };
}

/** Return the smallest chunk inventory needed to prepare an event-evidence scope. */
export function referencedCanonEvidenceChunks(params: {
  timelineRows: readonly unknown[];
  maximumChronologyOrder: number;
}): Array<{ sourceId: string; chunkId: string }> {
  const references = new Map<string, { sourceId: string; chunkId: string }>();
  for (const rawEvent of params.timelineRows) {
    const event = record(rawEvent);
    const chronologyOrder = finiteInteger(
      event.chronology_order ?? event.chronologyOrder,
    );
    if (chronologyOrder === null || chronologyOrder > params.maximumChronologyOrder) continue;
    for (const evidence of records(event.evidence)) {
      const sourceId = identifier(evidence.sourceId ?? evidence.source_id);
      const chunkId = identifier(evidence.chunkId ?? evidence.chunk_id);
      if (!sourceId || !chunkId) continue;
      references.set(`${sourceId}:${chunkId}`, { sourceId, chunkId });
    }
  }
  return [...references.values()].sort((left, right) =>
    `${left.sourceId}:${left.chunkId}`.localeCompare(`${right.sourceId}:${right.chunkId}`)
  );
}

function evidenceIdentity(sourceId: string, chunkId: string, quote: string): string {
  return stableCanonSha256([sourceId, chunkId, normalized(quote)]);
}

/**
 * Project only exact, hash-verified quotes cited by events at the boundary.
 * It intentionally never copies the surrounding source chunk.
 */
export function projectAnchoredCanonEvidence(params: {
  worldId: string;
  editionId: string;
  maximumChronologyOrder: number;
  timelineRows: readonly unknown[];
  chunks: readonly CanonEvidenceChunkCandidate[];
  lockedSources: readonly LockedSourceIdentity[];
}): {
  rows: CampaignCanonEvidenceSnapshot[];
  rejections: CanonProjectionRejection[];
  sha256: string;
} {
  const worldId = identifier(params.worldId);
  const editionId = identifier(params.editionId);
  const lockedSources = new Map(
    params.lockedSources
      .map((source) => [identifier(source.id), clean(source.content_hash, 200)] as const)
      .filter(([id, hash]) => id && hash),
  );
  const chunks = new Map(
    params.chunks.map((chunk) => [identifier(chunk.id), chunk] as const),
  );
  const projected = new Map<string, CampaignCanonEvidenceSnapshot>();
  const rejections: CanonProjectionRejection[] = [];
  for (const rawEvent of params.timelineRows) {
    const event = record(rawEvent);
    const chronologyOrder = finiteInteger(
      event.chronology_order ?? event.chronologyOrder,
    );
    if (chronologyOrder === null || chronologyOrder > params.maximumChronologyOrder) continue;
    const eventId = identifier(event.id ?? event.event_id ?? event.eventId);
    for (const rawEvidence of records(event.evidence)) {
      const sourceId = identifier(rawEvidence.sourceId ?? rawEvidence.source_id);
      const chunkId = identifier(rawEvidence.chunkId ?? rawEvidence.chunk_id);
      const quote = clean(rawEvidence.quote, 4_000);
      const rejectionId = eventId || chunkId || sourceId || "unknown";
      if (!sourceId || !chunkId || !quote) {
        rejections.push({ kind: "event_evidence", id: rejectionId, reason: "malformed_evidence" });
        continue;
      }
      const chunk = chunks.get(chunkId);
      const lockedSourceHash = lockedSources.get(sourceId);
      if (!chunk || !lockedSourceHash) {
        rejections.push({ kind: "event_evidence", id: rejectionId, reason: "unlocked_or_missing_chunk" });
        continue;
      }
      const candidateWorldId = identifier(chunk.world_id);
      const candidateEditionId = identifier(chunk.canon_edition_id);
      const candidateSourceId = identifier(chunk.source_id);
      if (
        !worldId || !editionId || candidateWorldId !== worldId ||
        candidateEditionId !== editionId || candidateSourceId !== sourceId
      ) {
        rejections.push({ kind: "event_evidence", id: rejectionId, reason: "scope_mismatch" });
        continue;
      }
      if (clean(chunk.source_content_hash, 200) !== lockedSourceHash) {
        rejections.push({ kind: "event_evidence", id: rejectionId, reason: "source_hash_mismatch" });
        continue;
      }
      const computedChunkHash = createHash("sha256").update(chunk.content).digest("hex");
      if (
        computedChunkHash !== clean(chunk.content_hash, 200).toLocaleLowerCase() ||
        !normalized(chunk.content).includes(normalized(quote))
      ) {
        rejections.push({ kind: "event_evidence", id: rejectionId, reason: "chunk_or_quote_mismatch" });
        continue;
      }
      const key = evidenceIdentity(sourceId, chunkId, quote);
      const existing = projected.get(key);
      if (existing) {
        if (eventId && !existing.event_ids.includes(eventId)) existing.event_ids.push(eventId);
        if (!existing.chronology_orders.includes(chronologyOrder)) {
          existing.chronology_orders.push(chronologyOrder);
        }
        continue;
      }
      projected.set(key, {
        evidence_key: key,
        world_id: worldId,
        canon_edition_id: editionId,
        source_id: sourceId,
        chunk_id: chunkId,
        source_content_hash: lockedSourceHash,
        chunk_content_hash: computedChunkHash,
        source_title: clean(chunk.source_title, 500),
        source_kind: clean(chunk.source_kind, 80) || "manuscript",
        chronology_label: clean(chunk.chronology_label, 240),
        excerpt: quote,
        excerpt_hash: createHash("sha256").update(quote).digest("hex"),
        event_ids: eventId ? [eventId] : [],
        chronology_orders: [chronologyOrder],
      });
    }
  }
  const rows = [...projected.values()]
    .map((row) => ({
      ...row,
      event_ids: [...row.event_ids].sort(),
      chronology_orders: [...row.chronology_orders].sort((left, right) => left - right),
    }))
    .sort((left, right) => left.evidence_key.localeCompare(right.evidence_key));
  return { rows, rejections, sha256: stableCanonSha256(rows) };
}

export type CampaignCanonClaimSnapshot = {
  claim_id: string;
  world_id: string;
  canon_edition_id: string;
  fingerprint: string;
  supersedes_claim_id: string | null;
  subject_entity_id: string;
  predicate: string;
  polarity: "positive" | "negative";
  object_entity_id: string | null;
  object_text: string;
  epistemic_holder_entity_id: string | null;
  truth_status: "fact" | "belief" | "rumor" | "lie" | "disputed" | "unknown";
  valid_from_label: string;
  valid_until_label: string;
  summary: string;
  evidence: Array<{
    evidenceKey: string;
    sourceId: string;
    chunkId: string;
    quote: string;
  }>;
  confidence: number;
  claim_status: "active" | "disputed" | "superseded" | "rejected";
  assignment_source: "local" | "ai" | "user";
  source_updated_at: string | null;
  snapshot_hash: string;
};

/**
 * Copy the current edition's evidence-backed claim graph into an immutable
 * campaign scope. Unlike an anchored projection this deliberately preserves
 * the edition's current semantic decisions because there is no earlier time
 * boundary to reconstruct; every citation still has to resolve into the
 * frozen evidence inventory.
 */
export function projectEditionLockedCanonClaims(params: {
  worldId: string;
  editionId: string;
  claims: readonly unknown[];
  evidence: readonly CampaignCanonEvidenceSnapshot[];
}): {
  rows: CampaignCanonClaimSnapshot[];
  rejections: CanonProjectionRejection[];
  sha256: string;
} {
  const worldId = identifier(params.worldId);
  const editionId = identifier(params.editionId);
  const rows: CampaignCanonClaimSnapshot[] = [];
  const rejections: CanonProjectionRejection[] = [];
  const truthStatuses = new Set(["fact", "belief", "rumor", "lie", "disputed", "unknown"]);
  const claimStatuses = new Set(["active", "disputed", "superseded", "rejected"]);
  const assignmentSources = new Set(["local", "ai", "user"]);
  for (const rawClaim of params.claims) {
    const claim = record(rawClaim);
    const claimId = identifier(claim.id ?? claim.claim_id ?? claim.claimId);
    const rejectionId = claimId || "unknown";
    const subjectEntityId = identifier(
      claim.subject_entity_id ?? claim.subjectEntityId,
    );
    const objectEntityId = identifier(
      claim.object_entity_id ?? claim.objectEntityId,
    ) || null;
    const holderEntityId = identifier(
      claim.epistemic_holder_entity_id ?? claim.epistemicHolderEntityId,
    ) || null;
    const predicate = clean(claim.predicate, 160);
    const objectText = objectEntityId
      ? ""
      : clean(claim.object_text ?? claim.object, 2_000);
    if (
      !claimId || !subjectEntityId || !predicate ||
      identifier(claim.world_id ?? claim.worldId) !== worldId ||
      identifier(claim.canon_edition_id ?? claim.editionId) !== editionId ||
      (!objectEntityId && !objectText)
    ) {
      rejections.push({ kind: "claim", id: rejectionId, reason: "scope_or_identity_mismatch" });
      continue;
    }
    const retainedEvidence = evidenceForClaim(claim.evidence, params.evidence);
    if (
      retainedEvidence.length === 0 ||
      retainedEvidence.length !== countDistinctUsableClaimEvidence(claim.evidence)
    ) {
      rejections.push({ kind: "claim", id: rejectionId, reason: "incomplete_frozen_evidence" });
      continue;
    }
    const truthStatus = clean(claim.truth_status ?? claim.truthStatus, 40);
    const claimStatus = clean(claim.claim_status ?? claim.claimStatus, 40);
    const assignmentSource = clean(
      claim.assignment_source ?? claim.assignmentSource,
      40,
    );
    if (
      !truthStatuses.has(truthStatus) || !claimStatuses.has(claimStatus) ||
      !assignmentSources.has(assignmentSource)
    ) {
      rejections.push({ kind: "claim", id: rejectionId, reason: "invalid_claim_state" });
      continue;
    }
    const sourceUpdatedAt = claim.source_updated_at instanceof Date
      ? claim.source_updated_at.toISOString()
      : clean(claim.source_updated_at ?? claim.sourceUpdatedAt, 80) || null;
    const withoutHash = {
      claim_id: claimId,
      world_id: worldId,
      canon_edition_id: editionId,
      fingerprint: clean(claim.fingerprint, 200) || stableCanonSha256({
        subjectEntityId,
        predicate: normalized(predicate),
        objectEntityId,
        objectText: normalized(objectText),
        holderEntityId,
        truthStatus,
      }),
      supersedes_claim_id: identifier(
        claim.supersedes_claim_id ?? claim.supersedesClaimId,
      ) || null,
      subject_entity_id: subjectEntityId,
      predicate,
      polarity: claim.polarity === "negative" ? "negative" as const : "positive" as const,
      object_entity_id: objectEntityId,
      object_text: objectText,
      epistemic_holder_entity_id: holderEntityId,
      truth_status: truthStatus as CampaignCanonClaimSnapshot["truth_status"],
      valid_from_label: clean(claim.valid_from_label ?? claim.validFromLabel, 240),
      valid_until_label: clean(claim.valid_until_label ?? claim.validUntilLabel, 240),
      summary: clean(claim.summary, 2_000),
      evidence: retainedEvidence,
      confidence: Math.max(0, Math.min(1, Number(claim.confidence) || 0)),
      claim_status: claimStatus as CampaignCanonClaimSnapshot["claim_status"],
      assignment_source: assignmentSource as CampaignCanonClaimSnapshot["assignment_source"],
      source_updated_at: sourceUpdatedAt,
    };
    rows.push({ ...withoutHash, snapshot_hash: stableCanonSha256(withoutHash) });
  }
  const uniqueRows = rows
    .filter((row, index, all) =>
      all.findIndex((candidate) => candidate.claim_id === row.claim_id) === index
    )
    .sort((left, right) => left.claim_id.localeCompare(right.claim_id));
  return { rows: uniqueRows, rejections, sha256: stableCanonSha256(uniqueRows) };
}

export type CampaignCanonObservedEntitySurfaces = Readonly<
  Record<string, readonly string[]>
>;

function evidenceForClaim(
  rawEvidence: unknown,
  allowed: readonly CampaignCanonEvidenceSnapshot[],
) {
  const retained: CampaignCanonClaimSnapshot["evidence"] = [];
  for (const item of records(rawEvidence)) {
    const sourceId = identifier(item.sourceId ?? item.source_id);
    const chunkId = identifier(item.chunkId ?? item.chunk_id);
    const quote = clean(item.quote, 4_000);
    if (!sourceId || !chunkId || !quote) continue;
    const match = allowed.find((entry) =>
      entry.source_id === sourceId &&
      entry.chunk_id === chunkId &&
      normalized(entry.excerpt).includes(normalized(quote))
    );
    if (!match) continue;
    retained.push({
      evidenceKey: match.evidence_key,
      sourceId,
      chunkId,
      quote,
    });
  }
  return retained.filter((item, index, all) =>
    all.findIndex((candidate) =>
      candidate.evidenceKey === item.evidenceKey &&
      normalized(candidate.quote) === normalized(item.quote)
    ) === index
  ).sort((left, right) =>
    `${left.evidenceKey}\n${left.quote}`.localeCompare(`${right.evidenceKey}\n${right.quote}`)
  );
}

function countDistinctUsableClaimEvidence(rawEvidence: unknown): number {
  const keys = new Set<string>();
  for (const item of records(rawEvidence)) {
    const sourceId = identifier(item.sourceId ?? item.source_id);
    const chunkId = identifier(item.chunkId ?? item.chunk_id);
    const quote = clean(item.quote, 4_000);
    if (sourceId && chunkId && quote) {
      keys.add(`${sourceId}\n${chunkId}\n${normalized(quote)}`);
    }
  }
  return keys.size;
}

const AMBIGUOUS_CLAIM_LANGUAGE = /(?:\?|\b(?:allegedly|apparently|could|guess(?:es|ed)?|maybe|might|perhaps|possibly|presumably|probably|seems?|supposedly)\b)/iu;
const REPORTED_CLAIM_LANGUAGE = /\b(?:believes?|claims?|fears?|heard|hears?|rumou?rs?|says?|said|suspects?|thinks?|thought)\b/iu;
const NEGATED_CLAIM_LANGUAGE = /\b(?:cannot|can't|did\s+not|does\s+not|do\s+not|is\s+not|isn't|never|no\s+longer|was\s+not|wasn't|were\s+not|weren't|will\s+not|won't)\b/iu;

function phraseIndex(haystack: string, needle: string): number {
  const normalizedHaystack = ` ${normalized(haystack)} `;
  const normalizedNeedle = normalized(needle);
  return normalizedNeedle ? normalizedHaystack.indexOf(` ${normalizedNeedle} `) : -1;
}

function literalClaimClause(params: {
  quote: string;
  subjectSurfaces: readonly string[];
  predicate: string;
  objectSurfaces: readonly string[];
  holderSurfaces: readonly string[];
  hasHolder: boolean;
}): string | null {
  // A retained quote may contain several sentences. Co-occurrence across the
  // excerpt is not proof that one entity bears the stated relation to another.
  const clauses = params.quote.split(/(?<=[.!?])\s+|[;\r\n]+/u);
  for (const clause of clauses) {
    const predicateAt = phraseIndex(clause, params.predicate);
    if (predicateAt < 0) continue;
    const subjectAt = params.subjectSurfaces
      .map((surface) => phraseIndex(clause, surface))
      .filter((index) => index >= 0 && index < predicateAt)
      .sort((left, right) => right - left)[0];
    const objectAt = params.objectSurfaces
      .map((surface) => phraseIndex(clause, surface))
      .filter((index) => index > predicateAt)
      .sort((left, right) => left - right)[0];
    if (subjectAt === undefined || objectAt === undefined) continue;
    if (!params.hasHolder) return clause;
    const holderAt = params.holderSurfaces
      .map((surface) => phraseIndex(clause, surface))
      .filter((index) => index >= 0 && index < subjectAt)
      .sort((left, right) => right - left)[0];
    const reportedSurface = clause.match(REPORTED_CLAIM_LANGUAGE)?.[0] ?? "";
    const reportedAt = phraseIndex(clause, reportedSurface);
    if (
      holderAt !== undefined && reportedAt > holderAt &&
      reportedAt < subjectAt
    ) return clause;
  }
  return null;
}

function observedSurfacesForEntity(
  surfaces: CampaignCanonObservedEntitySurfaces | undefined,
  entityId: string | null,
): string[] {
  if (!entityId) return [];
  const values = surfaces?.[entityId];
  return Array.isArray(values)
    ? values.map((value) => clean(value, 240)).filter(Boolean)
    : [];
}

/**
 * Rebuild a claim's semantic shell from what is literally present at the
 * cutoff. The mutable claim row is useful as an index into exact quotations,
 * but it is not temporal proof for a later predicate, identity resolution,
 * belief holder, truth label, polarity, or lifecycle status.
 */
function literalClaimProjection(params: {
  claim: JsonRecord;
  retainedEvidence: CampaignCanonClaimSnapshot["evidence"];
  entitySurfacesById?: CampaignCanonObservedEntitySurfaces;
}): {
  subjectEntityId: string;
  predicate: string;
  polarity: "positive" | "negative";
  objectEntityId: string | null;
  objectText: string;
  epistemicHolderEntityId: string | null;
  truthStatus: CampaignCanonClaimSnapshot["truth_status"];
} | null {
  const subjectEntityId = identifier(
    params.claim.subject_entity_id ?? params.claim.subjectEntityId,
  );
  const objectEntityId = identifier(
    params.claim.object_entity_id ?? params.claim.objectEntityId,
  ) || null;
  const epistemicHolderEntityId = identifier(
    params.claim.epistemic_holder_entity_id ?? params.claim.epistemicHolderEntityId,
  ) || null;
  const predicate = clean(params.claim.predicate, 160);
  const objectText = clean(params.claim.object_text ?? params.claim.object, 2_000);
  const subjectSurfaces = observedSurfacesForEntity(
    params.entitySurfacesById,
    subjectEntityId,
  );
  const objectSurfaces = objectEntityId
    ? observedSurfacesForEntity(params.entitySurfacesById, objectEntityId)
    : objectText ? [objectText] : [];
  const holderSurfaces = epistemicHolderEntityId
    ? observedSurfacesForEntity(params.entitySurfacesById, epistemicHolderEntityId)
    : [];
  if (
    !subjectEntityId || !predicate || !subjectSurfaces.length ||
    !objectSurfaces.length || (epistemicHolderEntityId && !holderSurfaces.length)
  ) return null;

  let directClause = "";
  for (const evidence of params.retainedEvidence) {
    const clause = literalClaimClause({
      quote: evidence.quote,
      subjectSurfaces,
      predicate,
      objectSurfaces,
      holderSurfaces,
      hasHolder: Boolean(epistemicHolderEntityId),
    });
    if (!clause) continue;
    if (!epistemicHolderEntityId &&
      (AMBIGUOUS_CLAIM_LANGUAGE.test(clause) || REPORTED_CLAIM_LANGUAGE.test(clause))) {
      continue;
    }
    directClause = clause;
    break;
  }
  if (!directClause) return null;

  const negative = NEGATED_CLAIM_LANGUAGE.test(directClause);
  const reported = epistemicHolderEntityId
    ? directClause.match(REPORTED_CLAIM_LANGUAGE)?.[0]?.toLocaleLowerCase() ?? ""
    : "";
  const truthStatus: CampaignCanonClaimSnapshot["truth_status"] =
    !epistemicHolderEntityId
      ? "fact"
      : /rumou?r|heard|hears/u.test(reported)
        ? "rumor"
        : /believ|think|thought|suspect|fear/u.test(reported)
          ? "belief"
          : "unknown";
  return {
    subjectEntityId,
    predicate,
    polarity: negative ? "negative" : "positive",
    objectEntityId,
    objectText: objectEntityId ? "" : objectText,
    epistemicHolderEntityId,
    truthStatus,
  };
}

/** Snapshot only claims supported by exact already-retained event evidence. */
export function projectAnchoredCanonClaims(params: {
  worldId: string;
  editionId: string;
  claims: readonly unknown[];
  evidence: readonly CampaignCanonEvidenceSnapshot[];
  /** Literal entity surfaces resolved inside the retained exact excerpts. */
  entitySurfacesById?: CampaignCanonObservedEntitySurfaces;
}): {
  rows: CampaignCanonClaimSnapshot[];
  rejections: CanonProjectionRejection[];
  sha256: string;
} {
  const worldId = identifier(params.worldId);
  const editionId = identifier(params.editionId);
  const rows: CampaignCanonClaimSnapshot[] = [];
  const rejections: CanonProjectionRejection[] = [];
  for (const rawClaim of params.claims) {
    const claim = record(rawClaim);
    const claimId = identifier(claim.id ?? claim.claim_id ?? claim.claimId);
    const rejectionId = claimId || "unknown";
    if (
      !claimId || identifier(claim.world_id ?? claim.worldId) !== worldId ||
      identifier(claim.canon_edition_id ?? claim.editionId) !== editionId
    ) {
      rejections.push({ kind: "claim", id: rejectionId, reason: "scope_or_identity_mismatch" });
      continue;
    }
    const retainedEvidence = evidenceForClaim(claim.evidence, params.evidence);
    if (retainedEvidence.length === 0) {
      rejections.push({ kind: "claim", id: rejectionId, reason: "no_retained_evidence" });
      continue;
    }
    if (retainedEvidence.length !== countDistinctUsableClaimEvidence(claim.evidence)) {
      // A claim synthesized from both sides of the cutoff cannot be made safe
      // merely by deleting its later citation; its predicate or summary may
      // already encode that later knowledge.
      rejections.push({ kind: "claim", id: rejectionId, reason: "partially_retained_evidence" });
      continue;
    }
    const literal = literalClaimProjection({
      claim,
      retainedEvidence,
      entitySurfacesById: params.entitySurfacesById,
    });
    if (!literal) {
      rejections.push({ kind: "claim", id: rejectionId, reason: "interpretation_not_literal_at_cutoff" });
      continue;
    }
    const fingerprint = stableCanonSha256({
      subjectEntityId: literal.subjectEntityId,
      predicate: normalized(literal.predicate),
      polarity: literal.polarity,
      objectEntityId: literal.objectEntityId,
      objectText: normalized(literal.objectText),
      epistemicHolderEntityId: literal.epistemicHolderEntityId,
      truthStatus: literal.truthStatus,
      evidence: retainedEvidence.map((entry) => entry.evidenceKey),
    });
    const withoutHash = {
      claim_id: claimId,
      world_id: worldId,
      canon_edition_id: editionId,
      fingerprint,
      // Current supersession and validity labels may have been assigned after
      // the cutoff. Exact retained evidence remains; later lifecycle metadata
      // does not.
      supersedes_claim_id: null,
      subject_entity_id: literal.subjectEntityId,
      predicate: literal.predicate,
      polarity: literal.polarity,
      object_entity_id: literal.objectEntityId,
      object_text: literal.objectText,
      epistemic_holder_entity_id: literal.epistemicHolderEntityId,
      truth_status: literal.truthStatus,
      valid_from_label: "",
      valid_until_label: "",
      summary: "",
      evidence: retainedEvidence,
      // These are reconstructed cutoff-local claims. Current confidence,
      // lifecycle, assignment, and timestamps are deliberately not copied.
      confidence: Math.min(0.9, 0.7 + Math.min(4, retainedEvidence.length) * 0.05),
      claim_status: "active" as const,
      assignment_source: "local" as const,
      source_updated_at: null,
    };
    rows.push({ ...withoutHash, snapshot_hash: stableCanonSha256(withoutHash) });
  }
  const uniqueRows = rows
    .filter((row, index, all) =>
      all.findIndex((candidate) => candidate.claim_id === row.claim_id) === index
    )
    .sort((left, right) => left.claim_id.localeCompare(right.claim_id));
  return { rows: uniqueRows, rejections, sha256: stableCanonSha256(uniqueRows) };
}

export type IdentitySafeCampaignEntity = {
  entity_id: string;
  dossier_id: string | null;
  canonical_character_id: string | null;
  canonical_key: string;
  entity_type: string;
  name: string;
  aliases: [];
  role: "";
  summary: "";
  profile: JsonRecord;
  details: [];
  relationships: [];
  socio_political_axis: JsonRecord;
  faction_memberships: [];
  entity_links: [];
  entity_rules: [];
  mention_count: 0;
  confidence: number;
};

const NON_IDENTITY_SURFACES = new Set([
  "he", "him", "his", "she", "her", "hers", "they", "them", "their", "theirs",
  "it", "its", "i", "me", "my", "mine", "we", "us", "our", "ours", "you", "your",
  "dad", "mom", "mum", "dude", "sir", "maam", "madam", "captain", "doctor",
]);

function observedEntitySurfaceCandidates(params: {
  evidence: readonly CampaignCanonEvidenceSnapshot[];
  mentions: readonly unknown[];
}) {
  const excerptsByChunk = new Map<string, CampaignCanonEvidenceSnapshot[]>();
  for (const evidence of params.evidence) {
    const rows = excerptsByChunk.get(evidence.chunk_id) ?? [];
    rows.push(evidence);
    excerptsByChunk.set(evidence.chunk_id, rows);
  }
  const candidates = new Map<string, Map<string, {
    label: string;
    count: number;
    latestOrder: number;
    confidence: number;
  }>>();
  for (const rawMention of params.mentions) {
    const mention = record(rawMention);
    const entityId = identifier(mention.entity_id ?? mention.entityId);
    const chunkId = identifier(mention.chunk_id ?? mention.chunkId);
    const label = clean(mention.surface_form ?? mention.surfaceForm, 240);
    const key = normalized(label);
    if (!entityId || !chunkId || !key || key.length < 2 || NON_IDENTITY_SURFACES.has(key)) continue;
    const matchingEvidence = (excerptsByChunk.get(chunkId) ?? []).filter((evidence) =>
      ` ${normalized(evidence.excerpt)} `.includes(` ${key} `)
    );
    if (!matchingEvidence.length) continue;
    const byLabel = candidates.get(entityId) ?? new Map();
    const existing = byLabel.get(key);
    const confidence = Number(mention.confidence);
    byLabel.set(key, {
      label: existing?.label ?? label,
      count: (existing?.count ?? 0) + 1,
      latestOrder: Math.max(
        existing?.latestOrder ?? 0,
        ...matchingEvidence.flatMap((evidence) => evidence.chronology_orders.length
          ? evidence.chronology_orders
          : [0]),
      ),
      confidence: Math.max(existing?.confidence ?? 0, Number.isFinite(confidence) ? confidence : 0),
    });
    candidates.set(entityId, byLabel);
  }
  return candidates;
}

/** Return every non-generic literal surface visible in retained evidence. */
export function observedEntitySurfacesFromEvidence(params: {
  evidence: readonly CampaignCanonEvidenceSnapshot[];
  mentions: readonly unknown[];
}): Record<string, string[]> {
  const candidates = observedEntitySurfaceCandidates(params);
  return Object.fromEntries([...candidates].map(([entityId, byLabel]) => [
    entityId,
    [...byLabel.values()].sort((left, right) =>
      right.count - left.count ||
      right.latestOrder - left.latestOrder ||
      right.confidence - left.confidence ||
      right.label.length - left.label.length ||
      left.label.localeCompare(right.label)
    ).map((candidate) => candidate.label),
  ]));
}

/** Select a name that was literally visible in evidence retained at the cutoff. */
export function observedEntityNamesFromEvidence(params: {
  evidence: readonly CampaignCanonEvidenceSnapshot[];
  mentions: readonly unknown[];
}): Record<string, string> {
  const surfaces = observedEntitySurfacesFromEvidence(params);
  const selected: Record<string, string> = {};
  for (const [entityId, values] of Object.entries(surfaces)) {
    if (values[0]) selected[entityId] = values[0];
  }
  return selected;
}

/** Remove every dossier field without temporal provenance. */
export function identitySafeEntityProjection(params: {
  entities: readonly unknown[];
  allowedEntityIds: Iterable<string>;
  selectedPlayerEntityId?: string | null;
  observedNamesByEntityId?: Readonly<Record<string, string>>;
  preserveUnobservedIdentity?: boolean;
}): {
  rows: IdentitySafeCampaignEntity[];
  rejections: CanonProjectionRejection[];
  sha256: string;
} {
  const allowed = new Set(
    [...params.allowedEntityIds, params.selectedPlayerEntityId ?? ""]
      .map(identifier)
      .filter(Boolean),
  );
  const rejections: CanonProjectionRejection[] = [];
  const rows = params.entities.flatMap((raw): IdentitySafeCampaignEntity[] => {
    const entity = record(raw);
    const entityId = identifier(entity.entity_id ?? entity.id ?? entity.entityId);
    if (!entityId || !allowed.has(entityId)) return [];
    const canonicalKey = clean(entity.canonical_key ?? entity.canonicalKey, 240);
    const entityType = clean(entity.entity_type ?? entity.entityType, 80);
    const currentName = clean(entity.name, 240);
    const observedName = clean(params.observedNamesByEntityId?.[entityId], 240);
    const preserveUnobservedIdentity = params.preserveUnobservedIdentity !== false;
    const name = observedName || (preserveUnobservedIdentity
      ? currentName
      : `Unidentified ${entityType === "character" ? "Character" : "Subject"}`);
    if (!canonicalKey || !entityType || !name) {
      rejections.push({ kind: "entity", id: entityId, reason: "malformed_identity" });
      return [];
    }
    const confidence = Number(entity.confidence);
    const temporalEntityType = !preserveUnobservedIdentity &&
      entityId !== identifier(params.selectedPlayerEntityId) &&
      ["character", "creature", "species"].includes(entityType)
      ? "ambiguous"
      : entityType;
    return [{
      entity_id: entityId,
      dossier_id: identifier(entity.dossier_id ?? entity.dossierId) || null,
      canonical_character_id: identifier(
        entity.canonical_character_id ?? entity.canonicalCharacterId,
      ) || null,
      canonical_key: preserveUnobservedIdentity ? canonicalKey : `snapshot-${entityId}`,
      entity_type: temporalEntityType,
      name,
      aliases: [],
      role: "",
      summary: "",
      profile: {},
      details: [],
      relationships: [],
      socio_political_axis: {},
      faction_memberships: [],
      entity_links: [],
      entity_rules: [],
      mention_count: 0,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    }];
  }).filter((row, index, all) =>
    all.findIndex((candidate) => candidate.entity_id === row.entity_id) === index
  ).sort((left, right) =>
    `${left.entity_type}\n${left.name}\n${left.entity_id}`.localeCompare(
      `${right.entity_type}\n${right.name}\n${right.entity_id}`,
    )
  );
  return { rows, rejections, sha256: stableCanonSha256(rows) };
}

export function allowedCanonEntityIds(params: {
  timelineRows: readonly unknown[];
  claims: readonly CampaignCanonClaimSnapshot[];
  selectedPlayerEntityId?: string | null;
}): string[] {
  const values = new Set<string>();
  const selected = identifier(params.selectedPlayerEntityId);
  if (selected) values.add(selected);
  for (const rawEvent of params.timelineRows) {
    const event = record(rawEvent);
    for (const rawId of Array.isArray(event.participant_entity_ids)
      ? event.participant_entity_ids
      : Array.isArray(event.participantEntityIds)
        ? event.participantEntityIds
        : []) {
      const id = identifier(rawId);
      if (id) values.add(id);
    }
  }
  for (const claim of params.claims) {
    values.add(claim.subject_entity_id);
    if (claim.object_entity_id) values.add(claim.object_entity_id);
    if (claim.epistemic_holder_entity_id) values.add(claim.epistemic_holder_entity_id);
  }
  return [...values].sort();
}

/**
 * A strict claim is usable only when every entity pointer it carries is part
 * of the same immutable identity snapshot. Dropping an incomplete claim here
 * prevents a valid campaign start from becoming permanently unloadable.
 */
export function claimsWithCompleteEntityReferences(
  claims: readonly CampaignCanonClaimSnapshot[],
  retainedEntityIds: Iterable<string>,
): CampaignCanonClaimSnapshot[] {
  const retained = new Set([...retainedEntityIds].map(identifier).filter(Boolean));
  return claims.filter((claim) =>
    retained.has(identifier(claim.subject_entity_id)) &&
    (!claim.object_entity_id || retained.has(identifier(claim.object_entity_id))) &&
    (!claim.epistemic_holder_entity_id || retained.has(identifier(claim.epistemic_holder_entity_id)))
  );
}

export type CampaignCanonQueryDb = {
  query<T extends JsonRecord = JsonRecord>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
};

function batches<T>(values: readonly T[], maximum = 250): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += maximum) {
    output.push(values.slice(index, index + maximum));
  }
  return output;
}

/** Persist already-validated projections inside the campaign creation transaction. */
export async function persistCampaignCanonScopeSnapshots(params: {
  db: CampaignCanonQueryDb;
  campaignId: string;
  evidence: readonly CampaignCanonEvidenceSnapshot[];
  claims: readonly CampaignCanonClaimSnapshot[];
}) {
  const campaignId = identifier(params.campaignId);
  if (!campaignId) throw new Error("A valid campaign ID is required for canon snapshots.");
  for (const batch of batches(params.evidence)) {
    await params.db.query(
      `INSERT INTO storyhold.campaign_canon_evidence_snapshots
        (campaign_id, evidence_key, world_id, canon_edition_id, source_id,
         chunk_id, source_content_hash, chunk_content_hash, source_title,
         source_kind, chronology_label, excerpt, excerpt_hash, event_ids,
         chronology_orders)
       SELECT $1, snapshot.evidence_key, snapshot.world_id,
              snapshot.canon_edition_id, snapshot.source_id, snapshot.chunk_id,
              snapshot.source_content_hash, snapshot.chunk_content_hash,
              snapshot.source_title, snapshot.source_kind,
              snapshot.chronology_label, snapshot.excerpt,
              snapshot.excerpt_hash, snapshot.event_ids,
              snapshot.chronology_orders
         FROM jsonb_to_recordset($2::jsonb) AS snapshot(
           evidence_key text, world_id uuid, canon_edition_id uuid,
           source_id uuid, chunk_id uuid, source_content_hash text,
           chunk_content_hash text, source_title text, source_kind text,
           chronology_label text, excerpt text, excerpt_hash text,
           event_ids jsonb, chronology_orders jsonb
         )`,
      [campaignId, JSON.stringify(batch)],
    );
  }
  for (const batch of batches(params.claims)) {
    await params.db.query(
      `INSERT INTO storyhold.campaign_canon_claim_snapshots
        (campaign_id, claim_id, world_id, canon_edition_id, fingerprint,
         supersedes_claim_id, subject_entity_id, predicate, polarity,
         object_entity_id, object_text, epistemic_holder_entity_id,
         truth_status, valid_from_label, valid_until_label, summary, evidence,
         confidence, claim_status, assignment_source, source_updated_at,
         snapshot_hash)
       SELECT $1, snapshot.claim_id, snapshot.world_id,
              snapshot.canon_edition_id, snapshot.fingerprint,
              snapshot.supersedes_claim_id, snapshot.subject_entity_id,
              snapshot.predicate, snapshot.polarity, snapshot.object_entity_id,
              snapshot.object_text, snapshot.epistemic_holder_entity_id,
              snapshot.truth_status, snapshot.valid_from_label,
              snapshot.valid_until_label, snapshot.summary, snapshot.evidence,
              snapshot.confidence, snapshot.claim_status,
              snapshot.assignment_source, snapshot.source_updated_at,
              snapshot.snapshot_hash
         FROM jsonb_to_recordset($2::jsonb) AS snapshot(
           claim_id uuid, world_id uuid, canon_edition_id uuid,
           fingerprint text, supersedes_claim_id uuid, subject_entity_id uuid,
           predicate text, polarity text, object_entity_id uuid,
           object_text text, epistemic_holder_entity_id uuid, truth_status text,
           valid_from_label text, valid_until_label text, summary text,
           evidence jsonb, confidence real, claim_status text,
           assignment_source text, source_updated_at timestamptz,
           snapshot_hash text
         )`,
      [campaignId, JSON.stringify(batch)],
    );
  }
  return { evidence: params.evidence.length, claims: params.claims.length };
}

/** Read only the immutable excerpts; never join back to mutable source text. */
export async function loadStrictCampaignCanonEvidence(params: {
  db: CampaignCanonQueryDb;
  campaignId: string;
  action: string;
  maximum?: number | null;
}) {
  const maximum = params.maximum === null
    ? null
    : Math.max(1, Math.min(256, Math.round(params.maximum ?? 32)));
  return params.db.query(
    `SELECT evidence_key AS id, evidence_key, world_id, canon_edition_id,
            source_id, chunk_id, source_content_hash, chunk_content_hash,
            source_title, source_kind, chronology_label, excerpt,
            excerpt AS content, excerpt_hash, 0::integer AS chunk_index,
            event_ids, chronology_orders
       FROM storyhold.campaign_canon_evidence_snapshots
      WHERE campaign_id = $1
      ORDER BY ts_rank_cd(
                 to_tsvector('simple', excerpt),
                 plainto_tsquery('simple', $2)
               ) DESC,
               evidence_key ASC
      LIMIT $3`,
    [params.campaignId, clean(params.action, 8_000), maximum],
  );
}

/** Resolve claim names only through the same campaign's identity-safe snapshot. */
export async function loadStrictCampaignCanonClaims(params: {
  db: CampaignCanonQueryDb;
  campaignId: string;
  action: string;
  maximum?: number | null;
}) {
  const maximum = params.maximum === null
    ? null
    : Math.max(1, Math.min(500, Math.round(params.maximum ?? 180)));
  return params.db.query(
    `SELECT claim.claim_id AS id, claim.claim_id, claim.world_id,
            claim.canon_edition_id, claim.fingerprint,
            claim.subject_entity_id, subject.name AS subject_name,
            claim.predicate, claim.polarity, claim.object_entity_id,
            object_entity.name AS object_name, claim.object_text,
            claim.epistemic_holder_entity_id,
            holder.name AS epistemic_holder_name,
            claim.truth_status, claim.supersedes_claim_id,
            claim.valid_from_label, claim.valid_until_label,
            claim.summary, claim.evidence, claim.confidence,
            claim.claim_status, claim.assignment_source,
            claim.source_updated_at, claim.snapshot_hash
       FROM storyhold.campaign_canon_claim_snapshots claim
       JOIN storyhold.campaign_entity_snapshots subject
         ON subject.campaign_id = claim.campaign_id
        AND subject.entity_id = claim.subject_entity_id
       LEFT JOIN storyhold.campaign_entity_snapshots object_entity
         ON object_entity.campaign_id = claim.campaign_id
        AND object_entity.entity_id = claim.object_entity_id
       LEFT JOIN storyhold.campaign_entity_snapshots holder
         ON holder.campaign_id = claim.campaign_id
        AND holder.entity_id = claim.epistemic_holder_entity_id
      WHERE claim.campaign_id = $1
      ORDER BY ts_rank_cd(
                 to_tsvector('simple', subject.name || ' ' || claim.predicate ||
                   ' ' || coalesce(object_entity.name, claim.object_text) ||
                   ' ' || claim.summary),
                 plainto_tsquery('simple', $2)
               ) DESC,
               CASE claim.claim_status WHEN 'active' THEN 0 WHEN 'disputed' THEN 1 ELSE 2 END,
               claim.confidence DESC, claim.claim_id ASC
      LIMIT $3`,
    [params.campaignId, clean(params.action, 8_000), maximum],
  );
}

export type ImportedCanonValidationIssueCode =
  | "AMBIGUOUS_CANON_SUBJECT"
  | "AMBIGUOUS_CANON_OBJECT"
  | "UNKNOWN_CANON_SUBJECT"
  | "UNKNOWN_CANON_OBJECT"
  | "UNRESOLVED_CANON_SUBJECT"
  | "UNRESOLVED_CANON_OBJECT"
  | "CANON_ENTITY_REFERENCE_MISMATCH"
  | "MALFORMED_CANON_NEGATION"
  | "IMPORTED_CANON_STANCE_CONFLICT"
  | "INVALID_IMPORTED_CANON_SUPERSESSION"
  | "UNKNOWN_SUPERSESSION"
  | "STATE_CHANGE_MISSING_REALITY_PROPOSITION";

export type ImportedCanonValidationIssue = {
  code: ImportedCanonValidationIssueCode;
  message: string;
  propositionIndex?: number;
  stateChangeIndex?: number;
  factIndex?: number;
  canonicalClaimId?: string;
};

export type ImportedCanonSemanticComparison = {
  proposition: Readonly<JsonRecord>;
  importedClaim: Readonly<JsonRecord>;
  subjectEntityId: string;
  propositionObjectEntityId: string | null;
  importedObjectEntityId: string | null;
};

/**
 * Optional adapter for a precomputed, trusted semantic/NLI decision. It may
 * promote a structurally different wording to equivalent, but it is never
 * consulted to waive malformed IDs, unresolved entities, explicit entity-ID
 * disagreement, or embedded negation.
 */
export type TrustedImportedCanonSemanticHook = (
  comparison: ImportedCanonSemanticComparison,
) => "equivalent" | "not_equivalent" | "uncertain";

function stringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => clean(item, 1_000)).filter(Boolean) : [];
}

function entityNames(entities: readonly unknown[]) {
  const idsByName = new Map<string, Set<string>>();
  const idsByObjectMeaning = new Map<string, Set<string>>();
  const nameById = new Map<string, string>();
  const referenceLabels: Array<{
    id: string;
    label: string;
    kind: "durable" | "short_first";
  }> = [];
  const register = (index: Map<string, Set<string>>, key: string, id: string) => {
    if (!key) return;
    const ids = index.get(key) ?? new Set<string>();
    ids.add(id);
    index.set(key, ids);
  };
  for (const raw of entities) {
    const entity = record(raw);
    const id = identifier(entity.entity_id ?? entity.id ?? entity.entityId);
    const name = clean(entity.name, 240);
    if (!id || !name) continue;
    nameById.set(id, normalized(name));
    for (const label of [name, ...stringValues(entity.aliases)]) {
      register(idsByName, normalized(label), id);
      register(idsByObjectMeaning, canonicalObjectText(label), id);
      const normalizedLabel = normalized(label);
      if (normalizedLabel) {
        referenceLabels.push({ id, label: normalizedLabel, kind: "durable" });
      }
    }

    // Director prose commonly shortens a person's canonical full name. Add
    // each meaningful canonical-name token to the same ambiguity-aware index;
    // a shared first or last name therefore fails closed instead of guessing.
    const entityType = normalized(entity.entity_type ?? entity.entityType);
    const tokens = normalized(name).split(" ").filter(Boolean);
    if (["character", "person", "creature"].includes(entityType) && tokens.length > 1) {
      const firstName = tokens[0]!;
      if (
        firstName.length >= 3 &&
        !["the", "sir", "mrs", "miss", "lady", "lord", "captain", "doctor"].includes(firstName)
      ) {
        referenceLabels.push({ id, label: firstName, kind: "short_first" });
      }
      for (const token of tokens) {
        if (
          token.length >= 3 &&
          !["the", "sir", "mrs", "miss", "lady", "lord", "captain", "doctor"].includes(token)
        ) {
          register(idsByName, token, id);
        }
      }
    }
  }
  return { idsByName, idsByObjectMeaning, nameById, referenceLabels };
}

function claimId(claim: JsonRecord): string {
  return clean(claim.claim_id ?? claim.id ?? claim.claimId, 100);
}

function claimSubjectId(claim: JsonRecord): string {
  return identifier(claim.subject_entity_id ?? claim.subjectEntityId);
}

function canonicalClaimStance(claim: JsonRecord): "affirmed" | "denied" {
  return claim.polarity === "negative" ? "denied" : "affirmed";
}

const PREDICATE_SYNONYMS = new Map<string, string>([
  ["guard", "guard"],
  ["protect", "guard"],
  ["defend", "guard"],
]);

const PREDICATE_AUXILIARIES = new Set([
  "am", "are", "be", "been", "being", "is", "was", "were",
]);

function conservativePredicateToken(token: string): string {
  if (PREDICATE_SYNONYMS.has(token)) return PREDICATE_SYNONYMS.get(token)!;
  let root = token;
  if (token.endsWith("ies") && token.length > 4) root = `${token.slice(0, -3)}y`;
  else if (token.endsWith("ing") && token.length > 5) {
    root = token.slice(0, -3);
    if (root.length > 3 && root.at(-1) === root.at(-2)) root = root.slice(0, -1);
  } else if (token.endsWith("ed") && token.length > 4) root = token.slice(0, -2);
  else if (token.endsWith("es") && token.length > 4) root = token.slice(0, -2);
  else if (token.endsWith("s") && token.length > 3) root = token.slice(0, -1);
  return PREDICATE_SYNONYMS.get(root) ?? root;
}

function canonicalPredicate(value: unknown): string {
  return normalized(value)
    .split(" ")
    .filter((token) => token && !PREDICATE_AUXILIARIES.has(token))
    .map(conservativePredicateToken)
    .join(" ");
}

const OBJECT_TOKEN_EQUIVALENTS = new Map<string, string>([
  ["western", "west"],
  ["eastern", "east"],
  ["northern", "north"],
  ["southern", "south"],
  ["gate", "entrance"],
  ["gates", "entrance"],
  ["entrances", "entrance"],
  ["entry", "entrance"],
  ["entryway", "entrance"],
]);

function canonicalObjectText(value: unknown): string {
  return normalized(value)
    .split(" ")
    .filter((token) => token && !["a", "an", "the"].includes(token))
    .map((token) => OBJECT_TOKEN_EQUIVALENTS.get(token) ?? token)
    .join(" ");
}

type EntityReferenceResolution = {
  id: string | null;
  ambiguous: boolean;
  invalidDirect: boolean;
  unresolvedKnownReference: boolean;
  mismatched: boolean;
};

function containsTokenSequence(text: string, sequence: string): boolean {
  if (!text || !sequence) return false;
  return ` ${text} `.includes(` ${sequence} `);
}

function knownEntityReferenceCandidates(
  value: unknown,
  names: ReturnType<typeof entityNames>,
): Set<string> {
  const candidate = normalized(value);
  if (!candidate) return new Set();
  const candidateTokens = candidate.split(" ");
  const decorators = new Set([
    "a", "an", "the", "captain", "cap", "commander", "doctor", "dr",
    "elder", "emperor", "empress", "general", "guard", "king", "lady",
    "lieutenant", "lord", "miss", "mr", "mrs", "ms", "officer", "old",
    "prince", "princess", "queen", "sergeant", "sir", "warden", "young",
  ]);
  return new Set(
    names.referenceLabels
      .filter(({ label, kind }) => {
        if (!containsTokenSequence(candidate, label)) return false;
        const labelTokens = label.split(" ");
        if (labelTokens.length > 1 && kind === "durable") return true;
        const remaining = [...candidateTokens];
        const at = remaining.findIndex((token, index) =>
          remaining.slice(index, index + labelTokens.length).join(" ") === label
        );
        if (at < 0) return false;
        remaining.splice(at, labelTokens.length);
        return remaining.length > 0 && remaining.every((token) => decorators.has(token));
      })
      .map(({ id }) => id),
  );
}

function entityReferenceResolution(params: {
  directValue: unknown;
  textValue: unknown;
  names: ReturnType<typeof entityNames>;
}): EntityReferenceResolution {
  const rawDirect = clean(params.directValue, 100);
  const direct = identifier(rawDirect);
  if (rawDirect && (!direct || !params.names.nameById.has(direct))) {
    return {
      id: null,
      ambiguous: false,
      invalidDirect: true,
      unresolvedKnownReference: false,
      mismatched: false,
    };
  }
  const ids = params.names.idsByName.get(normalized(params.textValue));
  const textId = ids?.size === 1 ? [...ids][0]! : null;
  const apparentIds = knownEntityReferenceCandidates(params.textValue, params.names);
  if (direct && textId && direct !== textId) {
    return {
      id: null,
      ambiguous: false,
      invalidDirect: false,
      unresolvedKnownReference: false,
      mismatched: true,
    };
  }
  if (direct && apparentIds.size > 0 && !apparentIds.has(direct)) {
    return {
      id: null,
      ambiguous: false,
      invalidDirect: false,
      unresolvedKnownReference: false,
      mismatched: true,
    };
  }
  if (direct) {
    return {
      id: direct,
      ambiguous: false,
      invalidDirect: false,
      unresolvedKnownReference: false,
      mismatched: false,
    };
  }
  if (ids && ids.size > 1) {
    return {
      id: null,
      ambiguous: true,
      invalidDirect: false,
      unresolvedKnownReference: false,
      mismatched: false,
    };
  }
  return {
    id: textId,
    ambiguous: false,
    invalidDirect: false,
    unresolvedKnownReference: !textId && apparentIds.size > 0,
    mismatched: false,
  };
}

function claimObjectId(claim: JsonRecord): string {
  return identifier(claim.object_entity_id ?? claim.objectEntityId);
}

function sameStructuralStatement(params: {
  proposition: JsonRecord;
  propositionObject: EntityReferenceResolution;
  claim: JsonRecord;
  names: ReturnType<typeof entityNames>;
  subjectEntityId: string;
  semanticEquivalence?: TrustedImportedCanonSemanticHook;
}): boolean {
  const canonicalObjectId = claimObjectId(params.claim);
  let objectEquivalent = false;
  if (canonicalObjectId || params.propositionObject.id) {
    if (canonicalObjectId && params.propositionObject.id) {
      if (canonicalObjectId !== params.propositionObject.id) return false;
      objectEquivalent = true;
    } else {
      const claimObjectNames = [
        params.claim.object_name,
        params.claim.object_text,
        params.claim.object,
      ];
      const resolvedClaimObject = claimObjectNames
        .map((value) => entityReferenceResolution({
          directValue: canonicalObjectId,
          textValue: value,
          names: params.names,
        }))
        .find((resolution) => resolution.id);
      objectEquivalent = Boolean(
        resolvedClaimObject?.id &&
        params.propositionObject.id &&
        resolvedClaimObject.id === params.propositionObject.id,
      );
      if (!objectEquivalent) return false;
    }
  } else {
    objectEquivalent = canonicalObjectText(
      params.proposition.object ?? params.proposition.object_value,
    ) === canonicalObjectText(
      params.claim.object_name ?? params.claim.object_text ?? params.claim.object,
    );
  }

  const predicateEquivalent =
    canonicalPredicate(params.proposition.predicate) ===
    canonicalPredicate(params.claim.predicate);
  if (predicateEquivalent && objectEquivalent) return true;
  if (!params.semanticEquivalence) return false;
  return params.semanticEquivalence({
    proposition: params.proposition,
    importedClaim: params.claim,
    subjectEntityId: params.subjectEntityId,
    propositionObjectEntityId: params.propositionObject.id,
    importedObjectEntityId: canonicalObjectId || null,
  }) === "equivalent";
}

function subjectResolution(
  proposition: JsonRecord,
  names: ReturnType<typeof entityNames>,
): EntityReferenceResolution {
  return entityReferenceResolution({
    directValue: proposition.subjectEntityId ?? proposition.subject_entity_id,
    textValue: proposition.subject,
    names,
  });
}

function objectResolution(
  proposition: JsonRecord,
  names: ReturnType<typeof entityNames>,
): EntityReferenceResolution {
  const exact = entityReferenceResolution({
    directValue: proposition.objectEntityId ?? proposition.object_entity_id,
    textValue: proposition.object ?? proposition.object_value,
    names,
  });
  if (
    exact.ambiguous || exact.invalidDirect || exact.mismatched ||
    exact.unresolvedKnownReference
  ) return exact;
  const semanticIds = names.idsByObjectMeaning.get(canonicalObjectText(
    proposition.object ?? proposition.object_value,
  ));
  if (!semanticIds?.size) return exact;
  if (exact.id) {
    // An exact name or explicit ID disambiguates a conservative semantic
    // collision (for example, two genuinely distinct western entrances).
    if (semanticIds.has(exact.id)) return exact;
    return { ...exact, id: null, mismatched: true };
  }
  if (semanticIds.size > 1) return { ...exact, ambiguous: true };
  return { ...exact, id: [...semanticIds][0]! };
}

function hasEmbeddedNegation(proposition: JsonRecord, object: EntityReferenceResolution): boolean {
  const predicate = clean(proposition.predicate, 160).toLocaleLowerCase();
  const objectText = clean(
    proposition.object ?? proposition.object_value,
    1_000,
  ).toLocaleLowerCase();
  const contraction = /\b\p{L}+n['’]t\b/iu;
  const negation = /\b(?:cannot|never|not|without)\b|\bno\s+longer\b/iu;
  if (contraction.test(predicate) || negation.test(predicate)) return true;
  // A resolved entity may legitimately have a proper name such as "No Man's
  // Land". Only free-text objects are interpreted as embedded assertions.
  return !object.id && (contraction.test(objectText) || negation.test(objectText) || /\bno\b/iu.test(objectText));
}

function propositionCoversFact(proposition: JsonRecord, stateChange: JsonRecord, fact: string) {
  if (clean(proposition.layer, 40) !== "reality") return false;
  if (normalized(proposition.subject) !== normalized(stateChange.subject)) return false;
  const factText = normalized(fact);
  const predicate = normalized(proposition.predicate);
  const object = normalized(proposition.object ?? proposition.object_value);
  if (!factText || !predicate || !object) return false;
  const assertion = `${predicate} ${object}`.trim();
  return factText.includes(assertion) || assertion.includes(factText) || (
    factText.includes(object) &&
    predicate.split(" ").some((token) => token.length > 2 && factText.includes(token))
  );
}

/**
 * Deterministic first-line defense for structured Director output. A trusted,
 * precomputed NLI decision may tighten equivalence after those structural
 * checks, but it cannot waive them.
 */
export function validateDirectorAgainstImportedCanon(params: {
  propositions: readonly unknown[];
  stateChanges?: readonly unknown[];
  importedClaims: readonly unknown[];
  entities: readonly unknown[];
  knownCampaignFactIds?: Iterable<string>;
  semanticEquivalence?: TrustedImportedCanonSemanticHook;
}): { ok: boolean; issues: ImportedCanonValidationIssue[] } {
  const names = entityNames(params.entities);
  const hardClaims = params.importedClaims.map(record).filter((claim) =>
    clean(claim.truth_status ?? claim.truthStatus, 40) === "fact" &&
    clean(claim.claim_status ?? claim.claimStatus, 40) === "active" &&
    !identifier(claim.epistemic_holder_entity_id ?? claim.epistemicHolderEntityId)
  );
  const hardClaimById = new Map(hardClaims.map((claim) => [claimId(claim), claim]));
  const campaignFactIds = new Set(
    [...(params.knownCampaignFactIds ?? [])].map((id) => clean(id, 100)).filter(Boolean),
  );
  const propositions = params.propositions.map(record);
  const issues: ImportedCanonValidationIssue[] = [];
  propositions.forEach((proposition, propositionIndex) => {
    if (clean(proposition.layer, 40) !== "reality") return;
    const subject = subjectResolution(proposition, names);
    if (subject.invalidDirect) {
      issues.push({
        code: "UNKNOWN_CANON_SUBJECT",
        message: "A reality proposition referenced an unknown canonical subject ID.",
        propositionIndex,
      });
      return;
    }
    if (subject.mismatched) {
      issues.push({
        code: "CANON_ENTITY_REFERENCE_MISMATCH",
        message: "A reality proposition's canonical subject ID and subject name identify different entities.",
        propositionIndex,
      });
      return;
    }
    if (subject.ambiguous) {
      issues.push({
        code: "AMBIGUOUS_CANON_SUBJECT",
        message: "A reality proposition used an ambiguous canonical subject name.",
        propositionIndex,
      });
      return;
    }
    if (subject.unresolvedKnownReference) {
      issues.push({
        code: "UNRESOLVED_CANON_SUBJECT",
        message: "A reality proposition appears to reference known canon but does not identify one canonical subject safely.",
        propositionIndex,
      });
      return;
    }

    const object = objectResolution(proposition, names);
    if (object.invalidDirect) {
      issues.push({
        code: "UNKNOWN_CANON_OBJECT",
        message: "A reality proposition referenced an unknown canonical object ID.",
        propositionIndex,
      });
      return;
    }
    if (object.mismatched) {
      issues.push({
        code: "CANON_ENTITY_REFERENCE_MISMATCH",
        message: "A reality proposition's canonical object ID and object name identify different entities.",
        propositionIndex,
      });
      return;
    }
    if (object.ambiguous) {
      issues.push({
        code: "AMBIGUOUS_CANON_OBJECT",
        message: "A reality proposition used an ambiguous canonical object name.",
        propositionIndex,
      });
      return;
    }
    if (object.unresolvedKnownReference) {
      issues.push({
        code: "UNRESOLVED_CANON_OBJECT",
        message: "A reality proposition appears to reference known canon but does not identify one canonical object safely.",
        propositionIndex,
      });
      return;
    }
    if (hasEmbeddedNegation(proposition, object)) {
      issues.push({
        code: "MALFORMED_CANON_NEGATION",
        message: "A reality proposition embedded negation in its predicate or object instead of expressing polarity through stance.",
        propositionIndex,
      });
      return;
    }

    const supersessionId = clean(
      proposition.supersedesPropositionId ?? proposition.supersedes_proposition_id,
      100,
    );
    const supersededClaim = supersessionId ? hardClaimById.get(supersessionId) : undefined;
    if (supersededClaim) {
      const basis = stringValues(proposition.causalBasis ?? proposition.causal_basis);
      if (
        !subject.id || claimSubjectId(supersededClaim) !== subject.id ||
        !sameStructuralStatement({
          proposition,
          propositionObject: object,
          claim: supersededClaim,
          names,
          subjectEntityId: subject.id ?? "",
          semanticEquivalence: params.semanticEquivalence,
        }) ||
        basis.length === 0
      ) {
        issues.push({
          code: "INVALID_IMPORTED_CANON_SUPERSESSION",
          message: "An imported canon supersession must target the same subject and predicate and cite a causal basis.",
          propositionIndex,
          canonicalClaimId: supersessionId,
        });
      }
    } else if (supersessionId && !campaignFactIds.has(supersessionId)) {
      issues.push({
        code: "UNKNOWN_SUPERSESSION",
        message: "A reality proposition referenced an unknown fact or imported canon claim.",
        propositionIndex,
      });
    }
    if (!subject.id) return;
    for (const claim of hardClaims) {
      if (
        claimSubjectId(claim) !== subject.id ||
        !sameStructuralStatement({
          proposition,
          propositionObject: object,
          claim,
          names,
          subjectEntityId: subject.id,
          semanticEquivalence: params.semanticEquivalence,
        })
      ) continue;
      const canonicalId = claimId(claim);
      if (supersessionId === canonicalId) continue;
      const stance = clean(proposition.stance, 40) || "affirmed";
      if (stance !== canonicalClaimStance(claim)) {
        issues.push({
          code: "IMPORTED_CANON_STANCE_CONFLICT",
          message: "A reality proposition contradicts an active imported canon fact without superseding it.",
          propositionIndex,
          canonicalClaimId: canonicalId,
        });
      }
    }
  });
  (params.stateChanges ?? []).map(record).forEach((stateChange, stateChangeIndex) => {
    stringValues(stateChange.facts).forEach((fact, factIndex) => {
      if (propositions.some((proposition) => propositionCoversFact(proposition, stateChange, fact))) return;
      issues.push({
        code: "STATE_CHANGE_MISSING_REALITY_PROPOSITION",
        message: "A durable state-change fact is not represented by a reality proposition.",
        stateChangeIndex,
        factIndex,
      });
    });
  });
  return { ok: issues.length === 0, issues };
}

export class ImportedCanonValidationError extends Error {
  readonly issues: ImportedCanonValidationIssue[];

  constructor(issues: ImportedCanonValidationIssue[]) {
    super("DIRECTOR_IMPORTED_CANON_VALIDATION_FAILED");
    this.name = "ImportedCanonValidationError";
    this.issues = issues;
  }
}

export function assertDirectorAgainstImportedCanon(
  params: Parameters<typeof validateDirectorAgainstImportedCanon>[0],
) {
  const result = validateDirectorAgainstImportedCanon(params);
  if (!result.ok) throw new ImportedCanonValidationError(result.issues);
  return result;
}
