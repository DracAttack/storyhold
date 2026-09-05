import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type {
  LocalCoreferenceResult,
  LocalCoreferenceSpan,
} from "./localCoreference";

type KnowledgeDb = Pick<PGlite, "query">;

export type KnowledgeEvidence = {
  chunkId: string;
  sourceId: string;
  quote: string;
};

export type WorldKnowledgeClaim = {
  subject: string;
  predicate: string;
  object: string;
  polarity?: "positive" | "negative";
  objectEntity?: string;
  epistemicHolder?: string;
  truthStatus:
    | "fact"
    | "belief"
    | "rumor"
    | "lie"
    | "disputed"
    | "unknown";
  validFromLabel?: string;
  validUntilLabel?: string;
  summary?: string;
  evidence: KnowledgeEvidence[];
  confidence: number;
  supersedes?: WorldKnowledgeClaimReference;
};

export type WorldKnowledgeClaimReference = Omit<
  WorldKnowledgeClaim,
  "summary" | "evidence" | "confidence" | "supersedes"
>;

export type WorldEventParticipant = {
  eventName: string;
  entity: string;
  role:
    | "actor"
    | "target"
    | "witness"
    | "location"
    | "beneficiary"
    | "causal_agent";
  evidence: KnowledgeEvidence[];
  confidence: number;
};

export type PersistableWorldEventParticipant = Omit<
  WorldEventParticipant,
  "eventName"
> & {
  eventId: string;
  eventName?: string;
};

export type PersistableWorldEventRelation = {
  sourceEventId: string;
  sourceEventName?: string;
  targetEvent: string;
  relationType:
    | "causes"
    | "enables"
    | "prevents"
    | "parallel_with"
    | "contradicts"
    | "supersedes"
    | "retells";
  summary: string;
  evidence: KnowledgeEvidence[];
  confidence: number;
};

export type WorldReferenceIssue = {
  kind:
    | "claim_subject"
    | "claim_object"
    | "claim_epistemic_holder"
    | "event_participant"
    | "event_relation_target"
    | "relation_subject"
    | "relation_target"
    | "faction_membership"
    | "entity_rule";
  label: string;
  resolution: "missing" | "ambiguous";
  context: string;
  metadata?: Record<string, unknown>;
};

export type MentionEntity = {
  id: string;
  name: string;
  aliases: string[];
};

export type ExtractedEntityMention = {
  entityId: string | null;
  surfaceForm: string;
  normalizedSurface: string;
  startOffset: number;
  endOffset: number;
  context: string;
  resolutionStatus: "resolved" | "ambiguous";
  confidence: number;
};

export const worldKnowledgeSchemaSql = String.raw`
  CREATE TABLE IF NOT EXISTS storyhold.world_knowledge_claims (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    source_analysis_run_id uuid REFERENCES storyhold.world_analysis_runs(id) ON DELETE SET NULL,
    supersedes_claim_id uuid REFERENCES storyhold.world_knowledge_claims(id) ON DELETE SET NULL,
    fingerprint text NOT NULL,
    subject_entity_id uuid NOT NULL REFERENCES storyhold.world_entities(id) ON DELETE CASCADE,
    predicate text NOT NULL,
    polarity text NOT NULL DEFAULT 'positive' CHECK (polarity IN ('positive', 'negative')),
    object_entity_id uuid REFERENCES storyhold.world_entities(id) ON DELETE SET NULL,
    object_text text NOT NULL DEFAULT '',
    epistemic_holder_entity_id uuid REFERENCES storyhold.world_entities(id) ON DELETE SET NULL,
    truth_status text NOT NULL CHECK (truth_status IN
      ('fact', 'belief', 'rumor', 'lie', 'disputed', 'unknown')),
    valid_from_label text NOT NULL DEFAULT '',
    valid_until_label text NOT NULL DEFAULT '',
    summary text NOT NULL DEFAULT '',
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    confidence real NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
    claim_status text NOT NULL DEFAULT 'active' CHECK (claim_status IN
      ('active', 'disputed', 'superseded', 'rejected')),
    assignment_source text NOT NULL DEFAULT 'ai' CHECK (assignment_source IN
      ('local', 'ai', 'user')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (world_id, canon_edition_id, fingerprint)
  );

  ALTER TABLE storyhold.world_knowledge_claims
    ADD COLUMN IF NOT EXISTS polarity text NOT NULL DEFAULT 'positive'
      CHECK (polarity IN ('positive', 'negative'));

  ALTER TABLE storyhold.world_knowledge_claims
    ADD COLUMN IF NOT EXISTS supersedes_claim_id uuid
      REFERENCES storyhold.world_knowledge_claims(id) ON DELETE SET NULL;

  CREATE INDEX IF NOT EXISTS world_knowledge_claims_supersedes
    ON storyhold.world_knowledge_claims (supersedes_claim_id)
    WHERE supersedes_claim_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS world_knowledge_claims_subject_polarity
    ON storyhold.world_knowledge_claims
      (world_id, canon_edition_id, subject_entity_id, predicate, polarity, claim_status);

  CREATE INDEX IF NOT EXISTS world_knowledge_claims_holder
    ON storyhold.world_knowledge_claims
      (world_id, canon_edition_id, epistemic_holder_entity_id, truth_status)
    WHERE epistemic_holder_entity_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS storyhold.world_event_participants (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    event_id uuid NOT NULL REFERENCES storyhold.world_clock_events(id) ON DELETE CASCADE,
    entity_id uuid NOT NULL REFERENCES storyhold.world_entities(id) ON DELETE CASCADE,
    participant_role text NOT NULL CHECK (participant_role IN
      ('actor', 'target', 'witness', 'location', 'beneficiary', 'causal_agent')),
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    confidence real NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
    assignment_source text NOT NULL DEFAULT 'ai' CHECK (assignment_source IN
      ('local', 'ai', 'user')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (event_id, entity_id, participant_role)
  );

  CREATE INDEX IF NOT EXISTS world_event_participants_entity
    ON storyhold.world_event_participants
      (world_id, canon_edition_id, entity_id, participant_role);

  CREATE TABLE IF NOT EXISTS storyhold.world_event_relations (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    source_event_id uuid NOT NULL REFERENCES storyhold.world_clock_events(id) ON DELETE CASCADE,
    target_event_id uuid NOT NULL REFERENCES storyhold.world_clock_events(id) ON DELETE CASCADE,
    relation_type text NOT NULL CHECK (relation_type IN
      ('causes', 'enables', 'prevents', 'parallel_with', 'contradicts', 'supersedes', 'retells')),
    summary text NOT NULL DEFAULT '',
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    confidence real NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
    assignment_source text NOT NULL DEFAULT 'ai' CHECK (assignment_source IN
      ('local', 'ai', 'user')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (source_event_id <> target_event_id),
    UNIQUE (source_event_id, target_event_id, relation_type)
  );

  CREATE INDEX IF NOT EXISTS world_event_relations_target
    ON storyhold.world_event_relations
      (world_id, canon_edition_id, target_event_id, relation_type);

  CREATE TABLE IF NOT EXISTS storyhold.world_coreference_mentions (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    source_id uuid NOT NULL REFERENCES storyhold.world_sources(id) ON DELETE CASCADE,
    chunk_id uuid NOT NULL REFERENCES storyhold.world_source_chunks(id) ON DELETE CASCADE,
    cluster_key text NOT NULL,
    surface_form text NOT NULL,
    normalized_surface text NOT NULL,
    start_offset integer NOT NULL CHECK (start_offset >= 0),
    end_offset integer NOT NULL CHECK (end_offset > start_offset),
    context text NOT NULL DEFAULT '',
    cluster_mentions jsonb NOT NULL DEFAULT '[]'::jsonb,
    model text NOT NULL,
    extraction_version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (chunk_id, start_offset, end_offset, cluster_key)
  );

  CREATE INDEX IF NOT EXISTS world_coreference_mentions_scope
    ON storyhold.world_coreference_mentions
      (world_id, canon_edition_id, chunk_id, start_offset);

  CREATE TABLE IF NOT EXISTS storyhold.world_entity_mentions (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    source_id uuid NOT NULL REFERENCES storyhold.world_sources(id) ON DELETE CASCADE,
    chunk_id uuid NOT NULL REFERENCES storyhold.world_source_chunks(id) ON DELETE CASCADE,
    entity_id uuid REFERENCES storyhold.world_entities(id) ON DELETE SET NULL,
    surface_form text NOT NULL,
    normalized_surface text NOT NULL,
    start_offset integer NOT NULL CHECK (start_offset >= 0),
    end_offset integer NOT NULL CHECK (end_offset > start_offset),
    context text NOT NULL DEFAULT '',
    resolution_status text NOT NULL DEFAULT 'candidate' CHECK (resolution_status IN
      ('candidate', 'resolved', 'ambiguous', 'rejected')),
    confidence real NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
    extraction_version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (chunk_id, start_offset, end_offset, normalized_surface)
  );

  CREATE INDEX IF NOT EXISTS world_entity_mentions_resolution
    ON storyhold.world_entity_mentions
      (world_id, canon_edition_id, normalized_surface, resolution_status);

  ALTER TABLE storyhold.world_entity_mentions
    ADD COLUMN IF NOT EXISTS mention_kind text NOT NULL DEFAULT 'literal'
      CHECK (mention_kind IN ('literal', 'coreference'));
  ALTER TABLE storyhold.world_entity_mentions
    ADD COLUMN IF NOT EXISTS antecedent_surface text;
  ALTER TABLE storyhold.world_entity_mentions
    ADD COLUMN IF NOT EXISTS cluster_key text;
`;

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionPatternSource(value: string): string | null {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.map(regexEscape).join("\\s+");
}

function abbreviatedAlias(alias: string, canonicalName: string): boolean {
  const short = normalized(alias).replace(/[^\p{L}\p{N}]/gu, "");
  const givenName = normalized(canonicalName.split(/\s+/u)[0] ?? canonicalName)
    .replace(/[^\p{L}\p{N}]/gu, "");
  return short.length >= 3 && short.length <= 4 && givenName.length > short.length &&
    givenName.length - short.length <= 4 && givenName.startsWith(short);
}

function abbreviationLooksLikeElision(input: {
  content: string;
  startOffset: number;
  endOffset: number;
  surfaceForm: string;
}): boolean {
  const suffix = input.content.slice(input.endOffset, input.endOffset + 2);
  if (!/^['’]/u.test(suffix) || /^['’][sS](?![\p{L}\p{N}])/u.test(suffix)) return false;
  // A quoted nickname such as ‘Lil’ is not an elision. A bare Lil’/lil', on
  // the other hand, is ordinarily a shortened adjective rather than a name.
  const preceding = input.content[input.startOffset - 1] ?? "";
  if (preceding === "'" || preceding === "‘") return false;
  // Names ending in s/x/z conventionally permit a trailing possessive
  // apostrophe. Do not throw those legitimate references away.
  return !/[sxz]$/iu.test(input.surfaceForm);
}

function abbreviationContextSupportsMention(input: {
  content: string;
  startOffset: number;
  endOffset: number;
}): boolean {
  const before = input.content.slice(Math.max(0, input.startOffset - 80), input.startOffset);
  const after = input.content.slice(input.endOffset, Math.min(input.content.length, input.endOffset + 24));
  if (/\b(?:call(?:ed|s)?|nickname(?:d|s)?|known\s+as|address(?:ed|es)?\s+as)\s+(?:(?:me|him|her|them)\s+)?$/iu.test(before)) {
    return true;
  }
  if (!/^\s*[,!?…]/u.test(after)) return false;
  // Lowercase styling is still credible when the manuscript unmistakably
  // uses the word as a direct address: at the opening of dialogue, or after a
  // compact vocative cue. This does not admit ordinary "a lil' ..." prose.
  return /["“]\s*$/u.test(before) ||
    /\b(?:hey|easy|listen|look|please)\s*,?\s*$/iu.test(before);
}

function createMentionExtractor(entities: MentionEntity[]) {
  const labels = new Map<
    string,
    {
      display: string;
      entityIds: Set<string>;
      canonicalIds: Set<string>;
      caseInsensitive: boolean;
      exactSurfaces: Set<string>;
      abbreviatedSurfaces: Set<string>;
    }
  >();
  for (const entity of entities) {
    const candidates = [entity.name, ...entity.aliases];
    for (let index = 0; index < candidates.length; index += 1) {
      const display = candidates[index]!.replace(/\s+/g, " ").trim();
      const key = normalized(display);
      if (key.length < 2) continue;
      const entry = labels.get(key) ?? {
        display,
        entityIds: new Set<string>(),
        canonicalIds: new Set<string>(),
        caseInsensitive: false,
        exactSurfaces: new Set<string>(),
        abbreviatedSurfaces: new Set<string>(),
      };
      entry.entityIds.add(entity.id);
      if (index === 0) {
        entry.canonicalIds.add(entity.id);
        entry.caseInsensitive = true;
      } else if (/\s/u.test(display) || !/^\p{Lu}/u.test(display)) {
        entry.caseInsensitive = true;
      } else {
        // A one-word proper nickname such as Buzz must not absorb ordinary
        // lowercase prose such as "a buzz filled the room." Preserve source
        // casing for these aliases while canonical names remain forgiving.
        entry.exactSurfaces.add(display);
        if (abbreviatedAlias(display, entity.name)) {
          entry.abbreviatedSurfaces.add(display);
        }
      }
      labels.set(key, entry);
    }
  }
  const ordered = [...labels.values()].sort(
    (left, right) => right.display.length - left.display.length,
  );
  // Keep individual regexes bounded. This still scans each chunk only a small
  // number of times even in a world with thousands of indexed labels.
  const patterns: RegExp[] = [];
  for (let offset = 0; offset < ordered.length; offset += 400) {
    const alternatives = ordered
      .slice(offset, offset + 400)
      .map((entry) => mentionPatternSource(entry.display))
      .filter((value): value is string => Boolean(value));
    if (!alternatives.length) continue;
    patterns.push(new RegExp(
      `(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`,
      "giu",
    ));
  }

  return (content: string, contextRadius = 180): ExtractedEntityMention[] => {
    const raw: Array<ExtractedEntityMention & { labelLength: number }> = [];
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of content.matchAll(pattern)) {
        const surfaceForm = match[0];
        const startOffset = match.index;
        if (startOffset === undefined) continue;
        const label = labels.get(normalized(surfaceForm));
        if (!label) continue;
        const exactSurface = surfaceForm.replace(/\s+/gu, " ").trim();
        const guardedAbbreviation = label.canonicalIds.size === 0 && label.abbreviatedSurfaces.size > 0;
        if (guardedAbbreviation && abbreviationLooksLikeElision({
          content,
          startOffset,
          endOffset: startOffset + surfaceForm.length,
          surfaceForm,
        })) {
          continue;
        }
        if (
          guardedAbbreviation &&
          !label.abbreviatedSurfaces.has(exactSurface) &&
          !abbreviationContextSupportsMention({
            content,
            startOffset,
            endOffset: startOffset + surfaceForm.length,
          })
        ) {
          continue;
        }
        if (!guardedAbbreviation && !label.caseInsensitive && !label.exactSurfaces.has(exactSurface)) {
          continue;
        }
        const endOffset = startOffset + surfaceForm.length;
        const ids = [...label.entityIds];
        const resolved = ids.length === 1;
        const canonical =
          resolved && label.canonicalIds.size === 1 && label.canonicalIds.has(ids[0]!);
        const radius = Math.max(20, contextRadius);
        raw.push({
          entityId: resolved ? ids[0]! : null,
          surfaceForm,
          normalizedSurface: normalized(surfaceForm),
          startOffset,
          endOffset,
          context: content
            .slice(Math.max(0, startOffset - radius), Math.min(content.length, endOffset + radius))
            .replace(/\s+/g, " ")
            .trim(),
          resolutionStatus: resolved ? "resolved" : "ambiguous",
          confidence: resolved ? (canonical ? 0.95 : 0.82) : 0.35,
          labelLength: endOffset - startOffset,
        });
      }
    }
    raw.sort((left, right) =>
      left.startOffset - right.startOffset || right.labelLength - left.labelLength,
    );
    const output: ExtractedEntityMention[] = [];
    let coveredUntil = -1;
    for (const mention of raw) {
      if (mention.startOffset < coveredUntil) continue;
      coveredUntil = mention.endOffset;
      const { labelLength: _labelLength, ...value } = mention;
      output.push(value);
    }
    return output;
  };
}

/**
 * Produce deterministic, offset-preserving mention candidates. A shared alias
 * is deliberately left ambiguous rather than silently assigning the passage
 * to whichever same-named entity happened to be processed first.
 */
export function extractEntityMentionsFromChunk(input: {
  content: string;
  entities: MentionEntity[];
  contextRadius?: number;
}): ExtractedEntityMention[] {
  return createMentionExtractor(input.entities)(
    input.content,
    input.contextRadius ?? 180,
  );
}

function boundedConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function evidenceKey(value: KnowledgeEvidence): string {
  return `${value.chunkId}:${value.quote.replace(/\s+/g, " ").trim().toLocaleLowerCase()}`;
}

function mergeEvidence(
  ...groups: Array<KnowledgeEvidence[] | null | undefined>
): KnowledgeEvidence[] {
  const seen = new Set<string>();
  const output: KnowledgeEvidence[] = [];
  for (const group of groups) {
    for (const item of group ?? []) {
      if (!item.chunkId || !item.sourceId || !item.quote.trim()) continue;
      const key = evidenceKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        chunkId: item.chunkId,
        sourceId: item.sourceId,
        quote: item.quote.replace(/\s+/g, " ").trim().slice(0, 500),
      });
      if (output.length >= 30) return output;
    }
  }
  return output;
}

export function knowledgeClaimFingerprint(input: {
  subjectEntityId: string;
  predicate: string;
  polarity?: "positive" | "negative";
  objectEntityId?: string | null;
  objectText?: string;
  epistemicHolderEntityId?: string | null;
  truthStatus: WorldKnowledgeClaim["truthStatus"];
  validFromLabel?: string;
  validUntilLabel?: string;
}): string {
  const legacyPositiveFingerprintInput = [
    input.subjectEntityId,
    normalized(input.predicate),
    input.objectEntityId ?? "",
    normalized(input.objectText ?? ""),
    input.epistemicHolderEntityId ?? "",
    input.truthStatus,
    normalized(input.validFromLabel ?? ""),
    normalized(input.validUntilLabel ?? ""),
  ].join("\n");
  return createHash("sha256")
    .update(input.polarity === "negative"
      ? `${legacyPositiveFingerprintInput}\nnegative`
      : legacyPositiveFingerprintInput)
    .digest("hex");
}

export type WorldEntityNameResolution = {
  idsByName: Map<string, string | null>;
  canonicalIdByEntityId: Map<string, string>;
};

export async function loadWorldEntityNameResolution(params: {
  db: KnowledgeDb;
  worldId: string;
  editionId: string;
  targetEntityTypes?: string[];
}): Promise<WorldEntityNameResolution> {
  const result = await params.db.query<{
    id: string;
    name: string;
    aliases: unknown;
    entity_type: string;
    pull_status: string;
    scanner_present: boolean;
    merged_into_entity_id: string | null;
  }>(
    `SELECT id, name, aliases, entity_type, pull_status, scanner_present,
            merged_into_entity_id
       FROM storyhold.world_entities
      WHERE world_id = $1 AND canon_edition_id = $2
        AND pull_status IN ('active', 'merged')`,
    [params.worldId, params.editionId],
  );
  const rowsById = new Map(result.rows.map((row) => [row.id, row]));
  const permittedTypes = params.targetEntityTypes?.length
    ? new Set(params.targetEntityTypes)
    : null;
  const canonicalIdByEntityId = new Map<string, string>();
  const canonicalTarget = (startingId: string) => {
    const visited = new Set<string>();
    let current = rowsById.get(startingId);
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.pull_status === "active") {
        if (
          current.scanner_present === true &&
          (!permittedTypes || permittedTypes.has(current.entity_type))
        ) return current;
        return null;
      }
      if (
        current.pull_status !== "merged" ||
        !current.merged_into_entity_id
      ) return null;
      current = rowsById.get(current.merged_into_entity_id);
    }
    return null;
  };
  const resolvableRows: Array<{
    row: (typeof result.rows)[number];
    targetId: string;
  }> = [];
  for (const row of result.rows) {
    const target = canonicalTarget(row.id);
    if (!target) continue;
    canonicalIdByEntityId.set(row.id, target.id);
    resolvableRows.push({ row, targetId: target.id });
  }
  const output = new Map<string, string | null>();
  const activePrimaryNames = new Set<string>();
  // An active canonical name is more specific than every alias or retired
  // merged name. Resolve those first so historical labels cannot poison an
  // otherwise exact lookup. Two active cards with the same primary name stay
  // ambiguous and are never assigned arbitrarily.
  for (const { row, targetId } of resolvableRows) {
    if (row.pull_status !== "active") continue;
    const key = normalized(row.name);
    if (!key) continue;
    activePrimaryNames.add(key);
    const current = output.get(key);
    output.set(
      key,
      current === undefined || current === targetId ? targetId : null,
    );
  }
  for (const { row, targetId } of resolvableRows) {
    const historicalLabels = [
      ...(row.pull_status === "merged" ? [row.name] : []),
      ...(Array.isArray(row.aliases)
        ? row.aliases.filter((value): value is string => typeof value === "string")
        : []),
    ];
    for (const label of historicalLabels) {
      const key = normalized(label);
      if (!key || activePrimaryNames.has(key)) continue;
      const current = output.get(key);
      output.set(
        key,
        current === undefined || current === targetId ? targetId : null,
      );
    }
  }
  return { idsByName: output, canonicalIdByEntityId };
}

async function entityIdsByName(
  db: KnowledgeDb,
  worldId: string,
  editionId: string,
): Promise<Map<string, string | null>> {
  return (await loadWorldEntityNameResolution({
    db,
    worldId,
    editionId,
  })).idsByName;
}

export async function syncWorldKnowledgeClaims(params: {
  db: KnowledgeDb;
  worldId: string;
  editionId: string;
  runId?: string | null;
  claims: WorldKnowledgeClaim[];
  assignmentSource?: "local" | "ai" | "user";
  replaceAiSnapshot?: boolean;
  /** A review's omissions/deferred verdicts are not authority to retract earlier claims. */
  preserveUnreviewedAiClaims?: boolean;
  /** Dossier reviews may resolve only names frozen in their paid request. */
  resolvedEntityIdsByName?: ReadonlyMap<string, string | null>;
  /** Reports successful writes only, never rows protected by owner assignment. */
  onClaimApplied?: (value: { claimId: string; fingerprint: string; claim: WorldKnowledgeClaim }) => void | Promise<void>;
}): Promise<{
  saved: number;
  unresolved: number;
  unsupported: number;
  referenceIssues: WorldReferenceIssue[];
}> {
  const names = params.resolvedEntityIdsByName ?? await entityIdsByName(params.db, params.worldId, params.editionId);
  const activeFingerprints: string[] = [];
  const pendingSupersessions: Array<{
    storedClaimId: string;
    supersededFingerprint: string;
    validFromLabel: string;
  }> = [];
  const referenceIssues: WorldReferenceIssue[] = [];
  let saved = 0;
  let unresolved = 0;
  let unsupported = 0;
  for (const claim of params.claims) {
    const subjectId = names.get(normalized(claim.subject));
    const objectEntityId = claim.objectEntity
      ? names.get(normalized(claim.objectEntity))
      : undefined;
    const holderId = claim.epistemicHolder
      ? names.get(normalized(claim.epistemicHolder))
      : undefined;
    const claimContext = `${claim.subject} ${claim.predicate} ${claim.object}`
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1_000);
    if (!subjectId) {
      referenceIssues.push({
        kind: "claim_subject",
        label: claim.subject,
        resolution: subjectId === null ? "ambiguous" : "missing",
        context: claimContext,
      });
    }
    if (objectEntityId === null) {
      referenceIssues.push({
        kind: "claim_object",
        label: claim.objectEntity ?? claim.object,
        resolution: "ambiguous",
        context: claimContext,
      });
    }
    if (claim.epistemicHolder && !holderId) {
      referenceIssues.push({
        kind: "claim_epistemic_holder",
        label: claim.epistemicHolder,
        resolution: holderId === null ? "ambiguous" : "missing",
        context: claimContext,
      });
    }
    if (
      !subjectId ||
      objectEntityId === null ||
      (Boolean(claim.epistemicHolder) && !holderId)
    ) {
      unresolved += 1;
      continue;
    }
    const evidence = mergeEvidence(claim.evidence);
    if (params.assignmentSource !== "user" && evidence.length === 0) {
      unsupported += 1;
      continue;
    }
    const fingerprint = knowledgeClaimFingerprint({
      subjectEntityId: subjectId,
      predicate: claim.predicate,
      polarity: claim.polarity,
      objectEntityId: objectEntityId ?? null,
      objectText: claim.object,
      epistemicHolderEntityId: holderId ?? null,
      truthStatus: claim.truthStatus,
      validFromLabel: claim.validFromLabel,
      validUntilLabel: claim.validUntilLabel,
    });
    let supersededFingerprint = "";
    if (claim.supersedes) {
      const previousSubjectId = names.get(normalized(claim.supersedes.subject));
      const previousObjectId = claim.supersedes.objectEntity
        ? names.get(normalized(claim.supersedes.objectEntity))
        : undefined;
      const previousHolderId = claim.supersedes.epistemicHolder
        ? names.get(normalized(claim.supersedes.epistemicHolder))
        : undefined;
      if (
        previousSubjectId &&
        previousObjectId !== null &&
        (!claim.supersedes.epistemicHolder || previousHolderId)
      ) {
        supersededFingerprint = knowledgeClaimFingerprint({
          subjectEntityId: previousSubjectId,
          predicate: claim.supersedes.predicate,
          polarity: claim.supersedes.polarity,
          objectEntityId: previousObjectId ?? null,
          objectText: claim.supersedes.object,
          epistemicHolderEntityId: previousHolderId ?? null,
          truthStatus: claim.supersedes.truthStatus,
          validFromLabel: claim.supersedes.validFromLabel,
          validUntilLabel: claim.supersedes.validUntilLabel,
        });
      }
    }
    activeFingerprints.push(fingerprint);
    const existing = await params.db.query<{
      id: string;
      evidence: KnowledgeEvidence[];
      confidence: number;
    }>(
      `SELECT id, evidence, confidence
         FROM storyhold.world_knowledge_claims
        WHERE world_id = $1 AND canon_edition_id = $2 AND fingerprint = $3
        LIMIT 1`,
      [params.worldId, params.editionId, fingerprint],
    );
    const mergedEvidence = params.replaceAiSnapshot
      ? evidence
      : mergeEvidence(existing.rows[0]?.evidence, evidence);
    const stored = await params.db.query<{ id: string }>(
      `INSERT INTO storyhold.world_knowledge_claims
        (id, world_id, canon_edition_id, source_analysis_run_id, fingerprint,
         subject_entity_id, predicate, polarity, object_entity_id, object_text,
         epistemic_holder_entity_id, truth_status, valid_from_label,
         valid_until_label, summary, evidence, confidence, assignment_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16::jsonb, $17, $18)
       ON CONFLICT (world_id, canon_edition_id, fingerprint) DO UPDATE SET
         evidence = EXCLUDED.evidence,
          polarity = EXCLUDED.polarity,
          confidence = CASE WHEN $19 THEN EXCLUDED.confidence
                            ELSE GREATEST(storyhold.world_knowledge_claims.confidence,
                                          EXCLUDED.confidence) END,
          summary = CASE WHEN $19 THEN EXCLUDED.summary
                         WHEN length(EXCLUDED.summary) >
                               length(storyhold.world_knowledge_claims.summary)
                         THEN EXCLUDED.summary
                         ELSE storyhold.world_knowledge_claims.summary END,
         source_analysis_run_id = COALESCE(EXCLUDED.source_analysis_run_id,
                                           storyhold.world_knowledge_claims.source_analysis_run_id),
         claim_status = CASE
           WHEN storyhold.world_knowledge_claims.assignment_source = 'user'
           THEN storyhold.world_knowledge_claims.claim_status
           ELSE 'active' END,
         updated_at = now()
       WHERE storyhold.world_knowledge_claims.assignment_source <> 'user'
       RETURNING id`,
      [
        existing.rows[0]?.id ?? randomUUID(),
        params.worldId,
        params.editionId,
        params.runId ?? null,
        fingerprint,
        subjectId,
        claim.predicate.trim().slice(0, 160),
        claim.polarity === "negative" ? "negative" : "positive",
        objectEntityId ?? null,
        claim.object.trim().slice(0, 2_000),
        holderId ?? null,
        claim.truthStatus,
        (claim.validFromLabel ?? "").trim().slice(0, 240),
        (claim.validUntilLabel ?? "").trim().slice(0, 240),
        (claim.summary ?? "").trim().slice(0, 2_000),
        JSON.stringify(mergedEvidence),
        boundedConfidence(claim.confidence),
        params.assignmentSource ?? "ai",
        params.replaceAiSnapshot === true,
      ],
    );
    const storedClaimId = stored.rows[0]?.id ?? existing.rows[0]?.id;
    if (stored.rows[0]) await params.onClaimApplied?.({ claimId: stored.rows[0].id, fingerprint, claim });
    if (
      storedClaimId &&
      supersededFingerprint &&
      supersededFingerprint !== fingerprint
    ) {
      pendingSupersessions.push({
        storedClaimId,
        supersededFingerprint,
        validFromLabel: (claim.validFromLabel ?? "").trim().slice(0, 240),
      });
    }
    saved += 1;
  }
  // Apply lineage after every claim in the batch is materialized. This makes
  // the result independent of model array order and prevents an earlier claim
  // listed last from accidentally reactivating itself.
  for (const pending of pendingSupersessions) {
      const superseded = await params.db.query<{ id: string }>(
        `UPDATE storyhold.world_knowledge_claims
            SET claim_status = 'superseded',
                valid_until_label = CASE
                  WHEN valid_until_label = '' AND $4 <> '' THEN $4
                  ELSE valid_until_label END,
                updated_at = now()
          WHERE world_id = $1 AND canon_edition_id = $2
            AND fingerprint = $3
            AND assignment_source <> 'user'
            AND claim_status IN ('active', 'disputed')
          RETURNING id`,
        [
          params.worldId,
          params.editionId,
          pending.supersededFingerprint,
          pending.validFromLabel,
        ],
      );
      const supersededClaimId = superseded.rows[0]?.id;
      if (supersededClaimId) {
        await params.db.query(
          `UPDATE storyhold.world_knowledge_claims
              SET supersedes_claim_id = $2, updated_at = now()
            WHERE id = $1 AND assignment_source <> 'user'`,
          [pending.storedClaimId, supersededClaimId],
        );
      }
  }
  if (params.replaceAiSnapshot && !params.preserveUnreviewedAiClaims) {
    if (activeFingerprints.length > 0) {
      await params.db.query(
        `UPDATE storyhold.world_knowledge_claims
            SET claim_status = 'superseded', updated_at = now()
          WHERE world_id = $1 AND canon_edition_id = $2
            AND assignment_source = 'ai' AND claim_status = 'active'
            AND NOT (fingerprint = ANY($3::text[]))`,
        [params.worldId, params.editionId, activeFingerprints],
      );
    } else {
      await params.db.query(
        `UPDATE storyhold.world_knowledge_claims
            SET claim_status = 'superseded', updated_at = now()
          WHERE world_id = $1 AND canon_edition_id = $2
            AND assignment_source = 'ai' AND claim_status = 'active'`,
        [params.worldId, params.editionId],
      );
    }
  }
  return { saved, unresolved, unsupported, referenceIssues };
}

export function resolveCoreferenceSpan(input: {
  span: Pick<LocalCoreferenceSpan, "surfaceForm" | "startOffset" | "endOffset" | "context" | "clusterMentions" | "clusterKey">;
  entities: MentionEntity[];
}): (ExtractedEntityMention & {
  antecedentSurface: string;
  clusterKey: string;
}) | null {
  const primary = new Map<string, Set<string>>();
  const aliases = new Map<string, Set<string>>();
  for (const entity of input.entities) {
    const primaryKey = normalized(entity.name);
    const primaryIds = primary.get(primaryKey) ?? new Set<string>();
    primaryIds.add(entity.id);
    primary.set(primaryKey, primaryIds);
    for (const alias of entity.aliases) {
      const key = normalized(alias);
      if (!key) continue;
      const ids = aliases.get(key) ?? new Set<string>();
      ids.add(entity.id);
      aliases.set(key, ids);
    }
  }
  const candidateIds = new Set<string>();
  let antecedentSurface = "";
  let canonicalAnchor = false;
  for (const mention of input.span.clusterMentions) {
    const key = normalized(mention);
    if (!key || key === normalized(input.span.surfaceForm)) continue;
    const primaryIds = primary.get(key);
    const ids = primaryIds ?? aliases.get(key);
    if (!ids?.size) continue;
    if (!antecedentSurface) antecedentSurface = mention;
    if (primaryIds?.size) canonicalAnchor = true;
    for (const id of ids) candidateIds.add(id);
  }
  if (candidateIds.size === 0) return null;
  const resolved = candidateIds.size === 1;
  return {
    entityId: resolved ? [...candidateIds][0]! : null,
    surfaceForm: input.span.surfaceForm,
    normalizedSurface: normalized(input.span.surfaceForm),
    startOffset: input.span.startOffset,
    endOffset: input.span.endOffset,
    context: input.span.context,
    resolutionStatus: resolved ? "resolved" : "ambiguous",
    confidence: resolved ? (canonicalAnchor ? 0.78 : 0.7) : 0.3,
    antecedentSurface,
    clusterKey: input.span.clusterKey,
  };
}

export async function syncWorldCoreferenceSpans(params: {
  db: KnowledgeDb;
  worldId: string;
  editionId: string;
  result?: LocalCoreferenceResult | null;
}): Promise<{ saved: number; replacedChunks: number }> {
  const result = params.result;
  if (!result || !["completed", "partial"].includes(result.receipt.status)) {
    return { saved: 0, replacedChunks: 0 };
  }
  const completedChunkIds = [...new Set(result.receipt.completedChunkIds)];
  if (!completedChunkIds.length) return { saved: 0, replacedChunks: 0 };
  await params.db.query(
    `DELETE FROM storyhold.world_coreference_mentions
      WHERE world_id = $1 AND canon_edition_id = $2
        AND chunk_id = ANY($3::uuid[])`,
    [params.worldId, params.editionId, completedChunkIds],
  );
  const completed = new Set(completedChunkIds);
  const spans = result.spans.filter((span) => completed.has(span.chunkId));
  const batchSize = 300;
  for (let offset = 0; offset < spans.length; offset += batchSize) {
    const batch = spans.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const tuples = batch.map((span) => {
      const start = values.length;
      values.push(
        randomUUID(),
        params.worldId,
        params.editionId,
        span.sourceId,
        span.chunkId,
        span.clusterKey,
        span.surfaceForm,
        normalized(span.surfaceForm),
        span.startOffset,
        span.endOffset,
        span.context,
        JSON.stringify(span.clusterMentions),
        result.receipt.model,
      );
      return `($${start + 1}, $${start + 2}, $${start + 3}, $${start + 4},
               $${start + 5}, $${start + 6}, $${start + 7}, $${start + 8},
               $${start + 9}, $${start + 10}, $${start + 11}, $${start + 12}::jsonb,
               $${start + 13}, 1)`;
    });
    await params.db.query(
      `INSERT INTO storyhold.world_coreference_mentions
        (id, world_id, canon_edition_id, source_id, chunk_id, cluster_key,
         surface_form, normalized_surface, start_offset, end_offset, context,
         cluster_mentions, model, extraction_version)
       VALUES ${tuples.join(",")}`,
      values,
    );
  }
  return { saved: spans.length, replacedChunks: completedChunkIds.length };
}

/**
 * Rebuild the deterministic mention index for one world edition. This index
 * is source-scoped and offset-preserving, so later AI passes can retrieve
 * neighboring passages and can distinguish an unresolved shared alias from a
 * confirmed entity reference.
 */
export async function syncWorldEntityMentions(params: {
  db: KnowledgeDb;
  worldId: string;
  editionId: string;
}): Promise<{
  chunks: number;
  mentions: number;
  ambiguous: number;
  coreferenceMentions: number;
}> {
  const [entityResult, chunkResult, coreferenceResult] = await Promise.all([
    params.db.query<{ id: string; name: string; aliases: unknown }>(
      `SELECT id, name, aliases
         FROM storyhold.world_entities
        WHERE world_id = $1 AND canon_edition_id = $2
          AND pull_status = 'active' AND scanner_present = true`,
      [params.worldId, params.editionId],
    ),
    params.db.query<{ id: string; source_id: string; content: string; metadata: unknown }>(
      `SELECT chunk.id, chunk.source_id, chunk.content, chunk.metadata
         FROM storyhold.world_source_chunks chunk
         JOIN storyhold.world_sources source ON source.id = chunk.source_id
        WHERE chunk.world_id = $1 AND chunk.canon_edition_id = $2
          AND source.processing_status = 'ready'
          AND source.canon_status IN ('candidate', 'canon')
        ORDER BY source.chronology_order, source.sort_order, source.created_at,
                 chunk.chunk_index`,
      [params.worldId, params.editionId],
    ),
    params.db.query<{
      source_id: string;
      chunk_id: string;
      cluster_key: string;
      surface_form: string;
      start_offset: number;
      end_offset: number;
      context: string;
      cluster_mentions: unknown;
    }>(
      `SELECT source_id, chunk_id, cluster_key, surface_form, start_offset,
              end_offset, context, cluster_mentions
         FROM storyhold.world_coreference_mentions
        WHERE world_id = $1 AND canon_edition_id = $2
        ORDER BY source_id, chunk_id, start_offset`,
      [params.worldId, params.editionId],
    ),
  ]);
  const entities: MentionEntity[] = entityResult.rows.map((row) => ({
    id: row.id,
    name: row.name,
    aliases: Array.isArray(row.aliases)
      ? row.aliases.filter((value): value is string => typeof value === "string")
      : [],
  }));
  const extractMentions = createMentionExtractor(entities);
  const overlapByChunk = new Map(chunkResult.rows.map((chunk) => {
    const metadata = chunk.metadata && typeof chunk.metadata === "object"
      ? chunk.metadata as Record<string, unknown>
      : {};
    const overlap = Number(metadata.overlapCharCount);
    return [chunk.id, Number.isFinite(overlap) ? Math.max(0, Math.trunc(overlap)) : 0] as const;
  }));

  await params.db.query(
    `DELETE FROM storyhold.world_entity_mentions
      WHERE world_id = $1 AND canon_edition_id = $2`,
    [params.worldId, params.editionId],
  );
  const rows: Array<{
    id: string;
    sourceId: string;
    chunkId: string;
    mention: ExtractedEntityMention;
    mentionKind: "literal" | "coreference";
    antecedentSurface: string | null;
    clusterKey: string | null;
  }> = [];
  for (const chunk of chunkResult.rows) {
    const overlapCharacters = overlapByChunk.get(chunk.id) ?? 0;
    for (const mention of extractMentions(chunk.content)) {
      // Source chunks intentionally overlap for retrieval. A mention wholly
      // inside the copied prefix was already indexed in the prior chunk and
      // must not inflate the customer-facing mention count.
      if (overlapCharacters > 0 && mention.endOffset <= overlapCharacters) continue;
      rows.push({
        id: randomUUID(), sourceId: chunk.source_id, chunkId: chunk.id, mention,
        mentionKind: "literal", antecedentSurface: null, clusterKey: null,
      });
    }
  }
  for (const row of coreferenceResult.rows) {
    const overlapCharacters = overlapByChunk.get(row.chunk_id) ?? 0;
    if (overlapCharacters > 0 && Number(row.end_offset) <= overlapCharacters) continue;
    const mention = resolveCoreferenceSpan({
      span: {
        surfaceForm: row.surface_form,
        startOffset: Number(row.start_offset),
        endOffset: Number(row.end_offset),
        context: row.context,
        clusterKey: row.cluster_key,
        clusterMentions: Array.isArray(row.cluster_mentions)
          ? row.cluster_mentions.filter((value): value is string => typeof value === "string")
          : [],
      },
      entities,
    });
    if (!mention) continue;
    rows.push({
      id: randomUUID(),
      sourceId: row.source_id,
      chunkId: row.chunk_id,
      mention,
      mentionKind: "coreference",
      antecedentSurface: mention.antecedentSurface,
      clusterKey: mention.clusterKey,
    });
  }
  // A coreference cluster can repeat a proper-name span that the deterministic
  // extractor already indexed. The database intentionally allows only one
  // normalized mention at an exact source offset, so collapse those overlaps
  // before a multi-row INSERT. Literal source wording is appended first and is
  // therefore retained over a duplicate inferred coreference mention.
  const uniqueRows = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = [
      row.chunkId,
      row.mention.startOffset,
      row.mention.endOffset,
      row.mention.normalizedSurface,
    ].join(":");
    if (!uniqueRows.has(key)) uniqueRows.set(key, row);
  }
  const deduplicatedRows = [...uniqueRows.values()];
  const ambiguous = deduplicatedRows.filter(
    (row) => row.mention.resolutionStatus === "ambiguous",
  ).length;
  const coreferenceMentions = deduplicatedRows.filter(
    (row) => row.mentionKind === "coreference" &&
      row.mention.resolutionStatus !== "ambiguous",
  ).length;
  const batchSize = 300;
  for (let offset = 0; offset < deduplicatedRows.length; offset += batchSize) {
    const batch = deduplicatedRows.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const tuples = batch.map((row) => {
      const start = values.length;
      values.push(
        row.id,
        params.worldId,
        params.editionId,
        row.sourceId,
        row.chunkId,
        row.mention.entityId,
        row.mention.surfaceForm,
        row.mention.normalizedSurface,
        row.mention.startOffset,
        row.mention.endOffset,
        row.mention.context,
        row.mention.resolutionStatus,
        row.mention.confidence,
        row.mentionKind,
        row.antecedentSurface,
        row.clusterKey,
      );
      return `($${start + 1}, $${start + 2}, $${start + 3}, $${start + 4},
               $${start + 5}, $${start + 6}, $${start + 7}, $${start + 8},
               $${start + 9}, $${start + 10}, $${start + 11}, $${start + 12},
               $${start + 13}, $${start + 14}, $${start + 15}, $${start + 16})`;
    });
    await params.db.query(
      `INSERT INTO storyhold.world_entity_mentions
        (id, world_id, canon_edition_id, source_id, chunk_id, entity_id,
         surface_form, normalized_surface, start_offset, end_offset, context,
          resolution_status, confidence, mention_kind, antecedent_surface, cluster_key)
       VALUES ${tuples.join(",")}`,
      values,
    );
  }
  return {
    chunks: chunkResult.rows.length,
    mentions: deduplicatedRows.length,
    ambiguous,
    coreferenceMentions,
  };
}

export async function syncWorldEventParticipants(params: {
  db: KnowledgeDb;
  worldId: string;
  editionId: string;
  participants: PersistableWorldEventParticipant[];
  eventIds?: string[];
  assignmentSource?: "local" | "ai" | "user";
}): Promise<{
  saved: number;
  unresolved: number;
  referenceIssues: WorldReferenceIssue[];
}> {
  const eventIds = [...new Set([
    ...(params.eventIds ?? []),
    ...params.participants.map((item) => item.eventId),
  ])];
  if (eventIds.length === 0) {
    return { saved: 0, unresolved: 0, referenceIssues: [] };
  }
  const names = await entityIdsByName(params.db, params.worldId, params.editionId);
  const placeholders = eventIds.map((_, index) => `$${index + 3}`).join(",");
  // Regenerated AI participant edges are a replaceable projection. User-made
  // assignments remain authoritative and are never removed by a later pass.
  await params.db.query(
    `DELETE FROM storyhold.world_event_participants
      WHERE world_id = $1 AND canon_edition_id = $2
        AND assignment_source <> 'user' AND event_id IN (${placeholders})`,
    [params.worldId, params.editionId, ...eventIds],
  );
  let saved = 0;
  let unresolved = 0;
  const referenceIssues: WorldReferenceIssue[] = [];
  for (const participant of params.participants) {
    const entityId = names.get(normalized(participant.entity));
    if (!entityId) {
      unresolved += 1;
      referenceIssues.push({
        kind: "event_participant",
        label: participant.entity,
        resolution: entityId === null ? "ambiguous" : "missing",
        context: participant.eventName ?? participant.eventId,
        metadata: { role: participant.role, eventId: participant.eventId },
      });
      continue;
    }
    const evidence = mergeEvidence(participant.evidence);
    if ((params.assignmentSource ?? "ai") !== "user" && evidence.length === 0) {
      unresolved += 1;
      continue;
    }
    await params.db.query(
      `INSERT INTO storyhold.world_event_participants
        (id, world_id, canon_edition_id, event_id, entity_id,
         participant_role, evidence, confidence, assignment_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       ON CONFLICT (event_id, entity_id, participant_role) DO UPDATE SET
         evidence = EXCLUDED.evidence,
         confidence = GREATEST(storyhold.world_event_participants.confidence,
                               EXCLUDED.confidence),
         assignment_source = EXCLUDED.assignment_source,
         updated_at = now()
       WHERE storyhold.world_event_participants.assignment_source <> 'user'`,
      [
        randomUUID(),
        params.worldId,
        params.editionId,
        participant.eventId,
        entityId,
        participant.role,
        JSON.stringify(evidence),
        boundedConfidence(participant.confidence),
        params.assignmentSource ?? "ai",
      ],
    );
    saved += 1;
  }
  return { saved, unresolved, referenceIssues };
}

export async function syncWorldEventRelations(params: {
  db: KnowledgeDb;
  worldId: string;
  editionId: string;
  relations: PersistableWorldEventRelation[];
  eventIds: string[];
  assignmentSource?: "local" | "ai" | "user";
}): Promise<{
  saved: number;
  unresolved: number;
  referenceIssues: WorldReferenceIssue[];
}> {
  const eventIds = [...new Set(params.eventIds)];
  if (eventIds.length === 0) return { saved: 0, unresolved: 0, referenceIssues: [] };
  const placeholders = eventIds.map((_, index) => `$${index + 3}`).join(",");
  const eventResult = await params.db.query<{ id: string; title: string }>(
    `SELECT id, title FROM storyhold.world_clock_events
      WHERE world_id = $1 AND canon_edition_id = $2
        AND campaign_id IS NULL AND id IN (${placeholders})`,
    [params.worldId, params.editionId, ...eventIds],
  );
  const eventsByName = new Map<string, Array<{ id: string; title: string }>>();
  for (const event of eventResult.rows) {
    const key = normalized(event.title);
    eventsByName.set(key, [...(eventsByName.get(key) ?? []), event]);
  }
  await params.db.query(
    `DELETE FROM storyhold.world_event_relations
      WHERE world_id = $1 AND canon_edition_id = $2
        AND assignment_source <> 'user'
        AND source_event_id IN (${placeholders})`,
    [params.worldId, params.editionId, ...eventIds],
  );
  let saved = 0;
  let unresolved = 0;
  const referenceIssues: WorldReferenceIssue[] = [];
  for (const relation of params.relations) {
    const targetCandidates = eventsByName.get(normalized(relation.targetEvent)) ?? [];
    if (targetCandidates.length !== 1) {
      unresolved += 1;
      referenceIssues.push({
        kind: "event_relation_target",
        label: relation.targetEvent,
        resolution: targetCandidates.length > 1 ? "ambiguous" : "missing",
        context: relation.sourceEventName ?? relation.sourceEventId,
        metadata: {
          sourceEventId: relation.sourceEventId,
          relationType: relation.relationType,
        },
      });
      continue;
    }
    const targetEventId = targetCandidates[0]!.id;
    const evidence = mergeEvidence(relation.evidence);
    if (targetEventId === relation.sourceEventId ||
        ((params.assignmentSource ?? "ai") !== "user" && evidence.length === 0)) {
      unresolved += 1;
      continue;
    }
    await params.db.query(
      `INSERT INTO storyhold.world_event_relations
        (id, world_id, canon_edition_id, source_event_id, target_event_id,
         relation_type, summary, evidence, confidence, assignment_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       ON CONFLICT (source_event_id, target_event_id, relation_type) DO UPDATE SET
         summary = EXCLUDED.summary,
         evidence = EXCLUDED.evidence,
         confidence = GREATEST(storyhold.world_event_relations.confidence,
                               EXCLUDED.confidence),
         assignment_source = EXCLUDED.assignment_source,
         updated_at = now()
       WHERE storyhold.world_event_relations.assignment_source <> 'user'`,
      [
        randomUUID(),
        params.worldId,
        params.editionId,
        relation.sourceEventId,
        targetEventId,
        relation.relationType,
        relation.summary,
        JSON.stringify(evidence),
        boundedConfidence(relation.confidence),
        params.assignmentSource ?? "ai",
      ],
    );
    saved += 1;
  }
  return { saved, unresolved, referenceIssues };
}
