import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";

type ConceptDb = Pick<PGlite, "query">;

// Increment this whenever deterministic clustering, classification, or scoring
// semantics change. Existing editions are then rebuilt without requiring an AI
// call or waiting for another manuscript upload.
export const CONCEPT_RESOLUTION_VERSION = 3;

export type ConceptEntityType =
  | "character" | "creature" | "species" | "place" | "faction"
  | "institution" | "government" | "power_structure" | "technology"
  | "vehicle" | "device" | "weapon" | "power" | "title" | "ambiguous";

export type ConceptScoreBreakdown = {
  explicitWording: number;
  chapterSpread: number;
  sourceSpread: number;
  evidenceDensity: number;
  categoryConsistency: number;
  relationshipSupport: number;
  contradictionPenalty: number;
  total: number;
};

export type StoryConceptCluster = {
  id: string;
  entityId: string | null;
  preferredLabel: string;
  entityType: ConceptEntityType;
  labels: string[];
  mentionCount: number;
  sourceCount: number;
  chapterCount: number;
  score: number;
  scoreBreakdown: ConceptScoreBreakdown;
  resolutionStatus: "candidate" | "proposed" | "verified" | "ambiguous" | "rejected" | "merged";
  resolutionSource: "local" | "ai" | "user";
  alternatives: Array<{ entityId: string; name: string; entityType: string; sharedLabels: string[] }>;
  evidence: Array<{ chunkId: string; sourceId: string; quote: string }>;
  updatedAt?: string;
};

export type StoryRelationHypothesis = {
  id: string;
  subjectEntityId: string;
  subjectName: string;
  relationType: string;
  targetEntityId: string;
  targetName: string;
  interpretation: "literal" | "figurative" | "belief" | "rumor" | "mistaken" | "disputed" | "former";
  status: "candidate" | "verified" | "rejected";
  score: number;
  evidence: Array<{ chunkId: string; sourceId: string; quote: string }>;
  explanation: string;
  constraintIds: string[];
};

export type OwnerCanonConstraint = {
  id: string;
  entityId: string | null;
  kind: "identity" | "relationship" | "category" | "chronology" | "fact" | "focus";
  instruction: string;
  status: "active" | "superseded" | "dismissed";
  createdAt?: string;
};

export const conceptResolutionSchemaSql = String.raw`
  CREATE TABLE IF NOT EXISTS storyhold.world_concept_clusters (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    entity_id uuid REFERENCES storyhold.world_entities(id) ON DELETE SET NULL,
    preferred_label text NOT NULL,
    normalized_label text NOT NULL,
    entity_type text NOT NULL CHECK (entity_type IN
      ('character','creature','species','place','faction','institution','government',
       'power_structure','technology','vehicle','device','weapon','power','title','ambiguous')),
    labels jsonb NOT NULL DEFAULT '[]'::jsonb,
    mention_count integer NOT NULL DEFAULT 0 CHECK (mention_count >= 0),
    source_count integer NOT NULL DEFAULT 0 CHECK (source_count >= 0),
    chapter_count integer NOT NULL DEFAULT 0 CHECK (chapter_count >= 0),
    score real NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 100),
    score_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
    resolution_status text NOT NULL DEFAULT 'candidate' CHECK (resolution_status IN
      ('candidate','proposed','verified','ambiguous','rejected','merged')),
    resolution_source text NOT NULL DEFAULT 'local' CHECK (resolution_source IN
      ('local','ai','user')),
    alternatives jsonb NOT NULL DEFAULT '[]'::jsonb,
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    resolution_version integer NOT NULL DEFAULT 1,
    last_analysis_run_id uuid REFERENCES storyhold.world_analysis_runs(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (world_id, canon_edition_id, entity_id)
  );

  CREATE INDEX IF NOT EXISTS world_concept_clusters_scope
    ON storyhold.world_concept_clusters
      (world_id, canon_edition_id, resolution_status, score DESC);

  ALTER TABLE storyhold.world_concept_clusters
    ADD COLUMN IF NOT EXISTS resolution_version integer NOT NULL DEFAULT 1;

  CREATE TABLE IF NOT EXISTS storyhold.world_relation_hypotheses (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    fingerprint text NOT NULL,
    subject_entity_id uuid NOT NULL REFERENCES storyhold.world_entities(id) ON DELETE CASCADE,
    relation_type text NOT NULL,
    target_entity_id uuid NOT NULL REFERENCES storyhold.world_entities(id) ON DELETE CASCADE,
    interpretation text NOT NULL CHECK (interpretation IN
      ('literal','figurative','belief','rumor','mistaken','disputed','former')),
    hypothesis_status text NOT NULL DEFAULT 'candidate' CHECK (hypothesis_status IN
      ('candidate','verified','rejected')),
    score real NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 100),
    score_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    explanation text NOT NULL DEFAULT '',
    constraint_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    source_kind text NOT NULL DEFAULT 'local' CHECK (source_kind IN ('local','ai','user')),
    last_analysis_run_id uuid REFERENCES storyhold.world_analysis_runs(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (world_id, canon_edition_id, fingerprint)
  );

  CREATE INDEX IF NOT EXISTS world_relation_hypotheses_scope
    ON storyhold.world_relation_hypotheses
      (world_id, canon_edition_id, subject_entity_id, target_entity_id, relation_type);

  CREATE TABLE IF NOT EXISTS storyhold.world_owner_canon_constraints (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    scope_entity_id uuid REFERENCES storyhold.world_entities(id) ON DELETE CASCADE,
    fingerprint text NOT NULL,
    constraint_kind text NOT NULL CHECK (constraint_kind IN
      ('identity','relationship','category','chronology','fact','focus')),
    instruction text NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','dismissed')),
    created_by_player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (world_id, canon_edition_id, fingerprint)
  );

  CREATE INDEX IF NOT EXISTS world_owner_canon_constraints_scope
    ON storyhold.world_owner_canon_constraints
      (world_id, canon_edition_id, status, scope_entity_id, created_at DESC);
`;

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/[\u2019]/gu, "'").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function uniqueStrings(values: string[], maximum = 80): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const clean = value.replace(/\s+/gu, " ").trim();
    const key = normalized(clean);
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [clean];
  }).slice(0, maximum);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function bounded(value: number, minimum = 0, maximum = 100): number {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));
}

export function scoreStoryConcept(input: {
  mentionCount: number;
  sourceCount: number;
  chapterCount: number;
  evidenceCount: number;
  relationCount: number;
  reviewStatus: string;
  entityType: string;
  conflictingLabels?: number;
}): ConceptScoreBreakdown {
  const explicitWording = Math.min(25, Math.round(Math.log2(Math.max(0, input.mentionCount) + 1) * 5));
  const chapterSpread = Math.min(20, Math.round(Math.sqrt(Math.max(0, input.chapterCount)) * 4));
  const sourceSpread = Math.min(10, Math.max(0, input.sourceCount) * 5);
  const evidenceDensity = Math.min(15, Math.max(0, input.evidenceCount) * 2);
  const categoryConsistency = input.reviewStatus === "user_confirmed"
    ? 20
    : input.reviewStatus === "verified"
      ? 16
      : input.entityType === "ambiguous" ? 2 : 8;
  const relationshipSupport = Math.min(10, Math.max(0, input.relationCount) * 2);
  const contradictionPenalty = Math.min(35,
    Math.max(0, input.conflictingLabels ?? 0) * 12 + (input.entityType === "ambiguous" ? 8 : 0));
  const total = bounded(
    explicitWording + chapterSpread + sourceSpread + evidenceDensity +
    categoryConsistency + relationshipSupport - contradictionPenalty,
  );
  return {
    explicitWording,
    chapterSpread,
    sourceSpread,
    evidenceDensity,
    categoryConsistency,
    relationshipSupport,
    contradictionPenalty,
    total,
  };
}

export function ownerGuidanceKind(value: string): OwnerCanonConstraint["kind"] | null {
  const text = normalized(value);
  if (text.length < 8) return null;
  const corrective = /\b(?:is not|isn't|are not|aren't|not actually|not literally|not before|not after|other way around|incorrect|wrong|mistaken|should be|must not|do not treat|don't treat|is called|are called|actual name|real name|same (?:person|place|thing|species|faction)|different (?:person|place|thing|species|faction))\b/u.test(text);
  if (!corrective) return null;
  if (/\b(?:daughter|son|child|father|mother|parent|brother|sister|sibling|wife|husband|spouse|friend|member|leader|relationship|related)\b/u.test(text)) return "relationship";
  if (/\b(?:before|after|timeline|chronology|flashback|present|past|future|book|chapter|event)\b/u.test(text)) return "chronology";
  if (/\b(?:person|character|alias|identity|same|different|actually)\b/u.test(text)) return "identity";
  if (/\b(?:character|creature|species|place|faction|institution|government|technology|vehicle|device|weapon|power|title|category)\b/u.test(text)) return "category";
  return "fact";
}

export function canonConstraintFingerprint(input: {
  worldId: string;
  editionId: string;
  entityId?: string | null;
  instruction: string;
}): string {
  return createHash("sha256").update([
    input.worldId,
    input.editionId,
    input.entityId ?? "",
    normalized(input.instruction),
  ].join("\n")).digest("hex");
}

export async function saveOwnerCanonConstraint(params: {
  db: ConceptDb;
  worldId: string;
  editionId: string;
  playerId: string;
  entityId?: string | null;
  instruction: string;
  forceKind?: OwnerCanonConstraint["kind"];
}): Promise<OwnerCanonConstraint | null> {
  const instruction = params.instruction.replace(/\s+/gu, " ").trim().slice(0, 4_000);
  const kind = params.forceKind ?? ownerGuidanceKind(instruction);
  if (!instruction || !kind) return null;
  const fingerprint = canonConstraintFingerprint({
    worldId: params.worldId,
    editionId: params.editionId,
    entityId: params.entityId,
    instruction,
  });
  const result = await params.db.query<Record<string, unknown>>(
    `INSERT INTO storyhold.world_owner_canon_constraints
      (id, world_id, canon_edition_id, scope_entity_id, fingerprint,
       constraint_kind, instruction, created_by_player_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (world_id, canon_edition_id, fingerprint)
     DO UPDATE SET status = 'active', instruction = EXCLUDED.instruction,
                   updated_at = now()
     RETURNING *`,
    [randomUUID(), params.worldId, params.editionId, params.entityId ?? null,
      fingerprint, kind, instruction, params.playerId],
  );
  return result.rows[0] ? serializeOwnerConstraint(result.rows[0]) : null;
}

export async function loadOwnerCanonConstraints(params: {
  db: ConceptDb;
  worldId: string;
  editionId: string;
  entityId?: string | null;
  includeWorld?: boolean;
  limit?: number;
}): Promise<OwnerCanonConstraint[]> {
  const result = await params.db.query<Record<string, unknown>>(
    `SELECT * FROM storyhold.world_owner_canon_constraints
      WHERE world_id = $1 AND canon_edition_id = $2 AND status = 'active'
        AND ($3::uuid IS NULL OR scope_entity_id = $3
          OR ($4::boolean = true AND scope_entity_id IS NULL))
      ORDER BY created_at ASC
      LIMIT $5`,
    [params.worldId, params.editionId, params.entityId ?? null,
      params.includeWorld !== false, Math.max(1, Math.min(500, params.limit ?? 200))],
  );
  return result.rows.map(serializeOwnerConstraint);
}

function contradictedRelationType(instruction: string): string | null {
  const text = normalized(instruction);
  if (/\b(?:daughter|son|child|father|mother|parent)\b/u.test(text)) return "child_of";
  if (/\b(?:brother|sister|sibling)\b/u.test(text)) return "sibling_of";
  if (/\b(?:wife|husband|spouse)\b/u.test(text)) return "spouse_of";
  if (/\bbest friend\b/u.test(text)) return "best_friend_of";
  if (/\bfriend\b/u.test(text)) return "friend_of";
  if (/\b(?:member|faction)\b/u.test(text)) return "member_of";
  if (/\b(?:species|race)\b/u.test(text)) return "species_of";
  if (/\b(?:creature form|manifested form)\b/u.test(text)) return "has_form";
  if (/\btitle\b/u.test(text)) return "holds_title";
  return null;
}

/**
 * Owner corrections can veto generated graph edges immediately. This never
 * edits a user-authored relationship; the next evidence review may add the
 * corrected direction as a separately cited canonical edge.
 */
export async function enforceOwnerCanonConstraints(params: {
  db: ConceptDb;
  worldId: string;
  editionId: string;
  entityId?: string | null;
}): Promise<{ removedGeneratedRelations: number }> {
  const [constraints, entitiesResult] = await Promise.all([
    loadOwnerCanonConstraints({
      db: params.db,
      worldId: params.worldId,
      editionId: params.editionId,
      entityId: params.entityId,
      includeWorld: true,
      limit: 500,
    }),
    params.db.query<Record<string, unknown>>(
      `SELECT id, name, aliases FROM storyhold.world_entities
        WHERE world_id = $1 AND canon_edition_id = $2
          AND pull_status = 'active'`,
      [params.worldId, params.editionId],
    ),
  ]);
  const entities = entitiesResult.rows.map((row) => ({
    id: String(row.id),
    labels: labelsFromRow(row),
  }));
  let removedGeneratedRelations = 0;
  for (const constraint of constraints) {
    if (constraint.kind !== "relationship") continue;
    const relationType = contradictedRelationType(constraint.instruction);
    if (!relationType) continue;
    const text = normalized(constraint.instruction);
    const mentioned = entities.filter((entity) =>
      entity.labels.some((label) => {
        const normalizedLabel = normalized(label);
        return normalizedLabel.length >= 2 && text.includes(normalizedLabel);
      }),
    );
    if (params.entityId && !mentioned.some((entity) => entity.id === params.entityId)) {
      const scoped = entities.find((entity) => entity.id === params.entityId);
      if (scoped) mentioned.unshift(scoped);
    }
    const ids = [...new Set(mentioned.map((entity) => entity.id))];
    if (ids.length !== 2) continue;
    const removed = await params.db.query<{ id: string }>(
      `DELETE FROM storyhold.world_entity_relations
        WHERE world_id = $1 AND canon_edition_id = $2
          AND assignment_source <> 'user' AND relation_type = $3
          AND ((source_entity_id = $4 AND target_entity_id = $5)
            OR (source_entity_id = $5 AND target_entity_id = $4))
        RETURNING id`,
      [params.worldId, params.editionId, relationType, ids[0], ids[1]],
    );
    removedGeneratedRelations += removed.rows.length;
    if (relationType === "member_of") {
      await params.db.query(
        `DELETE FROM storyhold.world_entity_faction_memberships
          WHERE assignment_source <> 'user'
            AND ((entity_id = $1 AND faction_entity_id = $2)
              OR (entity_id = $2 AND faction_entity_id = $1))`,
        [ids[0], ids[1]],
      );
    }
  }
  return { removedGeneratedRelations };
}

export function serializeOwnerConstraint(row: Record<string, unknown>): OwnerCanonConstraint {
  return {
    id: String(row.id),
    entityId: typeof row.scope_entity_id === "string" ? row.scope_entity_id : null,
    kind: String(row.constraint_kind) as OwnerCanonConstraint["kind"],
    instruction: String(row.instruction ?? ""),
    status: String(row.status) as OwnerCanonConstraint["status"],
    createdAt: typeof row.created_at === "string" ? row.created_at : undefined,
  };
}

function labelsFromRow(row: Record<string, unknown>): string[] {
  return uniqueStrings([
    String(row.name ?? ""),
    ...(Array.isArray(row.aliases)
      ? row.aliases.filter((value): value is string => typeof value === "string")
      : []),
  ]);
}

function evidenceFromRows(rows: Array<Record<string, unknown>>) {
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const chunkId = String(row.chunk_id ?? "");
    const sourceId = String(row.source_id ?? "");
    const quote = String(row.context ?? "").replace(/\s+/gu, " ").trim().slice(0, 500);
    const key = `${chunkId}:${normalized(quote)}`;
    if (!chunkId || !sourceId || !quote || seen.has(key)) return [];
    seen.add(key);
    return [{ chunkId, sourceId, quote }];
  }).slice(0, 12);
}

function relationFingerprint(input: {
  subjectEntityId: string;
  relationType: string;
  targetEntityId: string;
  interpretation: StoryRelationHypothesis["interpretation"];
  quote?: string;
}) {
  return createHash("sha256").update([
    input.subjectEntityId,
    input.relationType,
    input.targetEntityId,
    input.interpretation,
    normalized(input.quote ?? ""),
  ].join("\n")).digest("hex");
}

type MentionForRelation = {
  entityId: string;
  surfaceForm: string;
  startOffset: number;
  endOffset: number;
};

function regexEscape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function flexibleLabel(value: string) {
  return regexEscape(value.trim()).replace(/\\ /gu, "\\s+");
}

function relationInterpretation(sentence: string): StoryRelationHypothesis["interpretation"] {
  const value = normalized(sentence);
  if (/\b(?:not literally|metaphor|metaphorical|like (?:a|his|her|their)|as (?:a|his|her|their) (?:son|daughter|child|brother|sister|father|mother))\b/u.test(value)) return "figurative";
  if (/\b(?:mistook|mistaken|incorrectly believed|falsely believed|wasn't actually|was not actually)\b/u.test(value)) return "mistaken";
  if (/\b(?:rumor|rumoured|rumored|hearsay)\b/u.test(value)) return "rumor";
  if (/\b(?:disputed|denied|contested|claimed|alleged)\b/u.test(value)) return "disputed";
  if (/\b(?:believed|thought|assumed|suspected|was told)\b/u.test(value)) return "belief";
  if (/\b(?:formerly|once|used to be|no longer|ex-)\b/u.test(value)) return "former";
  return "literal";
}

function sentenceSpans(content: string): Array<{ start: number; end: number; text: string }> {
  const spans: Array<{ start: number; end: number; text: string }> = [];
  const expression = /[^.!?\n]+(?:[.!?]+|$)/gu;
  for (const match of content.matchAll(expression)) {
    if (match.index === undefined || !match[0].trim()) continue;
    spans.push({ start: match.index, end: match.index + match[0].length, text: match[0].trim() });
  }
  return spans;
}

export function extractDirectedRelationshipHypotheses(input: {
  content: string;
  mentions: MentionForRelation[];
  namesById: Map<string, string>;
  typesById?: Map<string, string>;
}): Array<Omit<StoryRelationHypothesis, "id" | "evidence" | "constraintIds"> & { quote: string }> {
  const output: Array<Omit<StoryRelationHypothesis, "id" | "evidence" | "constraintIds"> & { quote: string }> = [];
  const seen = new Set<string>();
  for (const sentence of sentenceSpans(input.content)) {
    const mentions = input.mentions.filter((mention) =>
      mention.startOffset >= sentence.start && mention.endOffset <= sentence.end,
    );
    if (mentions.length < 2 || mentions.length > 8) continue;
    for (const subject of mentions) {
      for (const target of mentions) {
        if (subject.entityId === target.entityId) continue;
        const subjectLabel = flexibleLabel(subject.surfaceForm);
        const targetLabel = flexibleLabel(target.surfaceForm);
        const body = sentence.text;
        const directChild = [
          new RegExp(`${subjectLabel}[^.!?]{0,80}\\b(?:son|daughter|child)\\s+of\\s+${targetLabel}\\b`, "iu"),
          new RegExp(`${subjectLabel}[^.!?]{0,50}\\b(?:is|was)\\s+(?:(?:not\\s+)?(?:actually|literally)\\s+)?${targetLabel}(?:'s|\\u2019s)\\s+(?:son|daughter|child)\\b`, "iu"),
          new RegExp(`${targetLabel}(?:'s|\\u2019s)\\s+(?:son|daughter|child)[^.!?]{0,40}${subjectLabel}\\b`, "iu"),
        ].some((pattern) => pattern.test(body));
        const inverseParent = [
          new RegExp(`${subjectLabel}[^.!?]{0,50}\\b(?:is|was)\\s+${targetLabel}(?:'s|\\u2019s)\\s+(?:father|mother|parent)\\b`, "iu"),
          new RegExp(`${subjectLabel}[^.!?]{0,80}\\b(?:father|mother|parent)\\s+of\\s+${targetLabel}\\b`, "iu"),
          new RegExp(`${targetLabel}(?:'s|\\u2019s)\\s+(?:father|mother|parent)[^.!?]{0,40}${subjectLabel}\\b`, "iu"),
        ].some((pattern) => pattern.test(body));
        const candidates: Array<{ sourceId: string; targetId: string; relationType: string }> = [];
        if (inverseParent) {
          candidates.push({ sourceId: target.entityId, targetId: subject.entityId, relationType: "child_of" });
        } else if (directChild) {
          candidates.push({ sourceId: subject.entityId, targetId: target.entityId, relationType: "child_of" });
        }

        const targetType = input.typesById?.get(target.entityId);
        const directRelations: Array<{ relationType: string; pattern: RegExp; targetTypes: string[] }> = [
          { relationType: "sibling_of", targetTypes: ["character"], pattern: new RegExp(`${subjectLabel}[^.!?]{0,80}\\b(?:brother|sister|sibling)\\s+(?:of|to)\\s+${targetLabel}\\b`, "iu") },
          { relationType: "sibling_of", targetTypes: ["character"], pattern: new RegExp(`${subjectLabel}[^.!?]{0,50}\\b(?:is|was)\\s+${targetLabel}(?:'s|\\u2019s)\\s+(?:brother|sister|sibling)\\b`, "iu") },
          { relationType: "spouse_of", targetTypes: ["character"], pattern: new RegExp(`${subjectLabel}[^.!?]{0,80}\\b(?:husband|wife|spouse)\\s+(?:of|to)\\s+${targetLabel}\\b`, "iu") },
          { relationType: "spouse_of", targetTypes: ["character"], pattern: new RegExp(`${subjectLabel}[^.!?]{0,50}\\b(?:is|was)\\s+${targetLabel}(?:'s|\\u2019s)\\s+(?:husband|wife|spouse)\\b`, "iu") },
          { relationType: "best_friend_of", targetTypes: ["character"], pattern: new RegExp(`${subjectLabel}[^.!?]{0,70}\\b(?:is|was|became)\\s+${targetLabel}(?:'s|\\u2019s)\\s+best\\s+friend\\b`, "iu") },
          { relationType: "friend_of", targetTypes: ["character"], pattern: new RegExp(`${subjectLabel}[^.!?]{0,70}\\b(?:is|was|became)\\s+(?:a\\s+)?friend\\s+(?:of|to)\\s+${targetLabel}\\b`, "iu") },
          { relationType: "member_of", targetTypes: ["faction", "institution"], pattern: new RegExp(`${subjectLabel}[^.!?]{0,70}\\b(?:is|was|became)\\s+(?:a\\s+)?(?:member|part)\\s+of\\s+${targetLabel}\\b`, "iu") },
          { relationType: "member_of", targetTypes: ["faction", "institution"], pattern: new RegExp(`${subjectLabel}[^.!?]{0,55}\\b(?:joined|joins|belongs\\s+to|belonged\\s+to)\\s+${targetLabel}\\b`, "iu") },
          { relationType: "leads", targetTypes: ["faction", "institution", "government", "power_structure"], pattern: new RegExp(`${subjectLabel}[^.!?]{0,45}\\b(?:leads|led|commands|commanded|rules|ruled)\\s+${targetLabel}\\b`, "iu") },
          { relationType: "located_in", targetTypes: ["place"], pattern: new RegExp(`${subjectLabel}[^.!?]{0,50}\\b(?:is|was|lives|lived|waits|waited|stands|stood|located)\\s+(?:inside|in|at|within)\\s+${targetLabel}\\b`, "iu") },
        ];
        for (const relation of directRelations) {
          if ((!input.typesById || relation.targetTypes.includes(targetType ?? "")) && relation.pattern.test(body)) {
            candidates.push({
              sourceId: subject.entityId,
              targetId: target.entityId,
              relationType: relation.relationType,
            });
          }
        }

        const copularIdentity = new RegExp(
          `${subjectLabel}[^.!?]{0,55}\\b(?:is|was|became|becomes|transformed\\s+into)\\s+(?:an?\\s+|the\\s+)?${targetLabel}\\b`,
          "iu",
        ).test(body);
        if (copularIdentity && targetType === "species") {
          candidates.push({ sourceId: subject.entityId, targetId: target.entityId, relationType: "species_of" });
        } else if (copularIdentity && targetType === "creature") {
          candidates.push({ sourceId: subject.entityId, targetId: target.entityId, relationType: "has_form" });
        } else if (copularIdentity && targetType === "title") {
          candidates.push({ sourceId: subject.entityId, targetId: target.entityId, relationType: "holds_title" });
        }

        for (const candidate of candidates) {
          const interpretation = relationInterpretation(body);
          const key = `${candidate.sourceId}:${candidate.relationType}:${candidate.targetId}:${interpretation}:${normalized(body)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          output.push({
            subjectEntityId: candidate.sourceId,
            subjectName: input.namesById.get(candidate.sourceId) ?? candidate.sourceId,
            relationType: candidate.relationType,
            targetEntityId: candidate.targetId,
            targetName: input.namesById.get(candidate.targetId) ?? candidate.targetId,
            interpretation,
            status: "candidate",
            score: interpretation === "literal" ? 72 : 58,
            explanation: interpretation === "literal"
              ? `Deterministic grammar found an explicitly directed ${candidate.relationType.replaceAll("_", " ")} statement; connected AI must still verify it.`
              : `Deterministic grammar found ${candidate.relationType.replaceAll("_", " ")} wording marked as ${interpretation}; it must not be promoted as a current literal fact without contrary evidence.`,
            quote: body.slice(0, 500),
          });
        }
      }
    }
  }
  return output;
}

export async function syncMentionCountsFromConceptGraph(params: {
  db: ConceptDb;
  worldId: string;
  editionId: string;
}): Promise<void> {
  await params.db.query(
    `UPDATE storyhold.world_entities entity
        SET mention_count = cluster.mention_count,
            mention_source_count = cluster.source_count
       FROM storyhold.world_concept_clusters cluster
      WHERE entity.world_id = $1 AND entity.canon_edition_id = $2
        AND cluster.world_id = entity.world_id
        AND cluster.canon_edition_id = entity.canon_edition_id
        AND cluster.entity_id = entity.id
        AND (entity.mention_count IS DISTINCT FROM cluster.mention_count
          OR entity.mention_source_count IS DISTINCT FROM cluster.source_count)`,
    [params.worldId, params.editionId],
  );
  await params.db.query(
    `UPDATE storyhold.character_dossiers dossier
        SET mention_count = entity.mention_count,
            mention_source_count = entity.mention_source_count
       FROM storyhold.world_entities entity
      WHERE dossier.world_id = $1 AND dossier.canon_edition_id = $2
        AND entity.world_id = dossier.world_id
        AND entity.canon_edition_id = dossier.canon_edition_id
        AND entity.dossier_id = dossier.id
        AND (dossier.mention_count IS DISTINCT FROM entity.mention_count
          OR dossier.mention_source_count IS DISTINCT FROM entity.mention_source_count)`,
    [params.worldId, params.editionId],
  );
}

export async function syncWorldConceptGraph(params: {
  db: ConceptDb;
  worldId: string;
  editionId: string;
  runId?: string | null;
}): Promise<{ clusters: number; ambiguous: number; hypotheses: number }> {
  const [entitiesResult, aggregatesResult, evidenceResult, relationsResult, constraints] = await Promise.all([
    params.db.query<Record<string, unknown>>(
      `SELECT id, name, entity_type, aliases, review_status, classification_source
         FROM storyhold.world_entities
        WHERE world_id = $1 AND canon_edition_id = $2
          AND pull_status = 'active' AND scanner_present = true`,
      [params.worldId, params.editionId],
    ),
    params.db.query<Record<string, unknown>>(
      `SELECT mention.entity_id, count(*)::int AS mention_count,
              count(DISTINCT mention.source_id)::int AS source_count,
              count(DISTINCT coalesce(chunk.metadata->>'sectionKey',
                mention.source_id::text || ':' || floor(chunk.chunk_index / 8)::text))::int AS chapter_count
         FROM storyhold.world_entity_mentions mention
         JOIN storyhold.world_source_chunks chunk ON chunk.id = mention.chunk_id
        WHERE mention.world_id = $1 AND mention.canon_edition_id = $2
          AND mention.entity_id IS NOT NULL AND mention.resolution_status = 'resolved'
          AND mention.mention_kind = 'literal'
        GROUP BY mention.entity_id`,
      [params.worldId, params.editionId],
    ),
    params.db.query<Record<string, unknown>>(
      `SELECT * FROM (
         SELECT mention.entity_id, mention.chunk_id, mention.source_id,
                mention.surface_form, mention.context, mention.confidence,
                row_number() OVER (
                  PARTITION BY mention.entity_id
                  ORDER BY mention.confidence DESC, mention.source_id, mention.start_offset
                ) AS evidence_rank
           FROM storyhold.world_entity_mentions mention
          WHERE mention.world_id = $1 AND mention.canon_edition_id = $2
            AND mention.entity_id IS NOT NULL AND mention.resolution_status = 'resolved'
       ) ranked WHERE evidence_rank <= 12`,
      [params.worldId, params.editionId],
    ),
    params.db.query<Record<string, unknown>>(
      `SELECT relation.*, source.name AS source_name, target.name AS target_name
         FROM storyhold.world_entity_relations relation
         JOIN storyhold.world_entities source ON source.id = relation.source_entity_id
         JOIN storyhold.world_entities target ON target.id = relation.target_entity_id
        WHERE relation.world_id = $1 AND relation.canon_edition_id = $2
          AND source.pull_status = 'active' AND target.pull_status = 'active'
          AND source.scanner_present = true AND target.scanner_present = true`,
      [params.worldId, params.editionId],
    ),
    loadOwnerCanonConstraints({
      db: params.db, worldId: params.worldId, editionId: params.editionId,
      includeWorld: true, limit: 500,
    }),
  ]);
  const entities = entitiesResult.rows;
  const entityById = new Map(entities.map((row) => [String(row.id), row]));
  const aggregateById = new Map(aggregatesResult.rows.map((row) => [String(row.entity_id), row]));
  const evidenceById = new Map<string, Array<Record<string, unknown>>>();
  for (const row of evidenceResult.rows) {
    const id = String(row.entity_id);
    const group = evidenceById.get(id) ?? [];
    group.push(row);
    evidenceById.set(id, group);
  }
  const relationCounts = new Map<string, number>();
  for (const row of relationsResult.rows) {
    for (const id of [String(row.source_entity_id), String(row.target_entity_id)]) {
      relationCounts.set(id, (relationCounts.get(id) ?? 0) + 1);
    }
  }
  const labelOwners = new Map<string, Set<string>>();
  for (const row of entities) {
    for (const label of labelsFromRow(row)) {
      const owners = labelOwners.get(normalized(label)) ?? new Set<string>();
      owners.add(String(row.id));
      labelOwners.set(normalized(label), owners);
    }
  }
  let ambiguous = 0;
  for (const row of entities) {
    const entityId = String(row.id);
    const labels = labelsFromRow(row);
    const conflictingIds = new Set<string>();
    for (const label of labels) {
      for (const owner of labelOwners.get(normalized(label)) ?? []) {
        if (owner !== entityId) conflictingIds.add(owner);
      }
    }
    const alternatives = [...conflictingIds].flatMap((id) => {
      const other = entityById.get(id);
      if (!other) return [];
      const sharedLabels = labels.filter((label) =>
        labelsFromRow(other).some((otherLabel) => normalized(otherLabel) === normalized(label)),
      );
      return [{ entityId: id, name: String(other.name), entityType: String(other.entity_type), sharedLabels }];
    });
    const aggregate = aggregateById.get(entityId);
    const evidenceRows = evidenceById.get(entityId) ?? [];
    const breakdown = scoreStoryConcept({
      mentionCount: Number(aggregate?.mention_count ?? 0),
      sourceCount: Number(aggregate?.source_count ?? 0),
      chapterCount: Number(aggregate?.chapter_count ?? 0),
      evidenceCount: evidenceRows.length,
      relationCount: relationCounts.get(entityId) ?? 0,
      reviewStatus: String(row.review_status),
      entityType: String(row.entity_type),
      conflictingLabels: alternatives.length,
    });
    const resolutionSource = String(row.classification_source) === "user"
      ? "user" : String(row.review_status) === "verified" ? "ai" : "local";
    const resolutionStatus = alternatives.length
      ? "ambiguous"
      : String(row.review_status) === "user_confirmed" || String(row.review_status) === "verified"
        ? "verified"
        : breakdown.total >= 60 ? "proposed" : "candidate";
    if (resolutionStatus === "ambiguous") ambiguous += 1;
    await params.db.query(
      `INSERT INTO storyhold.world_concept_clusters
        (id, world_id, canon_edition_id, entity_id, preferred_label,
         normalized_label, entity_type, labels, mention_count, source_count,
         chapter_count, score, score_breakdown, resolution_status,
         resolution_source, alternatives, evidence, resolution_version,
         last_analysis_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12,
               $13::jsonb, $14, $15, $16::jsonb, $17::jsonb, $18, $19)
       ON CONFLICT (world_id, canon_edition_id, entity_id)
       DO UPDATE SET preferred_label = EXCLUDED.preferred_label,
                     normalized_label = EXCLUDED.normalized_label,
                     entity_type = EXCLUDED.entity_type,
                     labels = EXCLUDED.labels,
                     mention_count = EXCLUDED.mention_count,
                     source_count = EXCLUDED.source_count,
                     chapter_count = EXCLUDED.chapter_count,
                     score = EXCLUDED.score,
                     score_breakdown = EXCLUDED.score_breakdown,
                     resolution_status = CASE
                       WHEN storyhold.world_concept_clusters.resolution_source = 'user'
                       THEN storyhold.world_concept_clusters.resolution_status
                       ELSE EXCLUDED.resolution_status END,
                     resolution_source = CASE
                       WHEN storyhold.world_concept_clusters.resolution_source = 'user'
                       THEN 'user' ELSE EXCLUDED.resolution_source END,
                     alternatives = EXCLUDED.alternatives,
                     evidence = EXCLUDED.evidence,
                     resolution_version = EXCLUDED.resolution_version,
                     last_analysis_run_id = EXCLUDED.last_analysis_run_id,
                     updated_at = now()`,
      [randomUUID(), params.worldId, params.editionId, entityId, String(row.name),
        normalized(String(row.name)), String(row.entity_type), json(labels),
        Number(aggregate?.mention_count ?? 0), Number(aggregate?.source_count ?? 0),
        Number(aggregate?.chapter_count ?? 0), breakdown.total, json(breakdown),
        resolutionStatus, resolutionSource, json(alternatives),
        json(evidenceFromRows(evidenceRows)), CONCEPT_RESOLUTION_VERSION,
        params.runId ?? null],
    );
  }
  await params.db.query(
    `DELETE FROM storyhold.world_concept_clusters cluster
      WHERE cluster.world_id = $1 AND cluster.canon_edition_id = $2
        AND cluster.resolution_source <> 'user'
        AND (cluster.entity_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM storyhold.world_entities entity
           WHERE entity.id = cluster.entity_id AND entity.pull_status = 'active'
             AND entity.scanner_present = true
        ))`,
    [params.worldId, params.editionId],
  );

  // The mention index is the authoritative reading of the current source
  // corpus. Keep the customer-facing cards and character dossiers in sync
  // with the graph projection instead of leaving the counts that happened to
  // be present when an AI/local finding first created the row. This is also
  // alias-aware because the cluster aggregate is built from resolved mention
  // rows, not only the preferred display name.
  await syncMentionCountsFromConceptGraph(params);

  let hypothesisCount = 0;
  const activeFingerprints = new Set<string>();
  for (const relation of relationsResult.rows) {
    const interpretation: StoryRelationHypothesis["interpretation"] =
      String(relation.relation_status) === "former" ? "former"
        : String(relation.relation_status) === "disputed" ? "disputed" : "literal";
    const fingerprint = relationFingerprint({
      subjectEntityId: String(relation.source_entity_id),
      relationType: String(relation.relation_type),
      targetEntityId: String(relation.target_entity_id),
      interpretation,
    });
    activeFingerprints.add(fingerprint);
    hypothesisCount += 1;
    await params.db.query(
      `INSERT INTO storyhold.world_relation_hypotheses
        (id, world_id, canon_edition_id, fingerprint, subject_entity_id,
         relation_type, target_entity_id, interpretation, hypothesis_status,
         score, score_breakdown, evidence, explanation, constraint_ids,
         source_kind, last_analysis_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14::jsonb,$15,$16)
       ON CONFLICT (world_id, canon_edition_id, fingerprint)
       DO UPDATE SET hypothesis_status = EXCLUDED.hypothesis_status,
                     score = EXCLUDED.score, evidence = EXCLUDED.evidence,
                     explanation = EXCLUDED.explanation,
                     constraint_ids = EXCLUDED.constraint_ids,
                     source_kind = EXCLUDED.source_kind,
                     last_analysis_run_id = EXCLUDED.last_analysis_run_id,
                     updated_at = now()`,
      [randomUUID(), params.worldId, params.editionId, fingerprint,
        relation.source_entity_id, relation.relation_type, relation.target_entity_id,
        interpretation, "verified", bounded(Number(relation.confidence ?? 0.5) * 100),
        json({ canonicalRelation: 70, exactEvidence: Array.isArray(relation.evidence) && relation.evidence.length ? 30 : 0 }),
        json(Array.isArray(relation.evidence) ? relation.evidence : []),
        String(relation.summary ?? "Verified canonical relation."), json([]),
        String(relation.assignment_source ?? "local"), params.runId ?? null],
    );
  }

  const mentionRows = await params.db.query<Record<string, unknown>>(
    `SELECT mention.entity_id, mention.surface_form, mention.start_offset,
            mention.end_offset, mention.chunk_id, mention.source_id, chunk.content
       FROM storyhold.world_entity_mentions mention
       JOIN storyhold.world_source_chunks chunk ON chunk.id = mention.chunk_id
      WHERE mention.world_id = $1 AND mention.canon_edition_id = $2
        AND mention.entity_id IS NOT NULL AND mention.resolution_status = 'resolved'
      ORDER BY mention.chunk_id, mention.start_offset`,
    [params.worldId, params.editionId],
  );
  const mentionsByChunk = new Map<string, Array<Record<string, unknown>>>();
  for (const row of mentionRows.rows) {
    const group = mentionsByChunk.get(String(row.chunk_id)) ?? [];
    group.push(row);
    mentionsByChunk.set(String(row.chunk_id), group);
  }
  const namesById = new Map(entities.map((row) => [String(row.id), String(row.name)]));
  const typesById = new Map(entities.map((row) => [String(row.id), String(row.entity_type)]));
  for (const [chunkId, rows] of mentionsByChunk) {
    const first = rows[0]!;
    const extracted = extractDirectedRelationshipHypotheses({
      content: String(first.content),
      mentions: rows.map((row) => ({
        entityId: String(row.entity_id), surfaceForm: String(row.surface_form),
        startOffset: Number(row.start_offset), endOffset: Number(row.end_offset),
      })),
      namesById,
      typesById,
    });
    for (const hypothesis of extracted) {
      const relevantConstraints = constraints.filter((constraint) => {
        const text = normalized(constraint.instruction);
        return text.includes(normalized(hypothesis.subjectName)) ||
          text.includes(normalized(hypothesis.targetName));
      });
      const constrainedInterpretation = relevantConstraints.some((constraint) =>
        /not literally|metaphor|not (?:his|her|their)?\s*(?:daughter|son|child)|other way around/iu.test(constraint.instruction),
      ) ? "figurative" : hypothesis.interpretation;
      const fingerprint = relationFingerprint({
        subjectEntityId: hypothesis.subjectEntityId,
        relationType: hypothesis.relationType,
        targetEntityId: hypothesis.targetEntityId,
        interpretation: constrainedInterpretation,
        quote: hypothesis.quote,
      });
      activeFingerprints.add(fingerprint);
      hypothesisCount += 1;
      await params.db.query(
        `INSERT INTO storyhold.world_relation_hypotheses
          (id, world_id, canon_edition_id, fingerprint, subject_entity_id,
           relation_type, target_entity_id, interpretation, hypothesis_status,
           score, score_breakdown, evidence, explanation, constraint_ids,
           source_kind, last_analysis_run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'candidate',$9,$10::jsonb,$11::jsonb,$12,$13::jsonb,'local',$14)
         ON CONFLICT (world_id, canon_edition_id, fingerprint)
         DO UPDATE SET interpretation = EXCLUDED.interpretation,
                       score = EXCLUDED.score, score_breakdown = EXCLUDED.score_breakdown,
                       evidence = EXCLUDED.evidence, explanation = EXCLUDED.explanation,
                       constraint_ids = EXCLUDED.constraint_ids,
                       last_analysis_run_id = EXCLUDED.last_analysis_run_id,
                       updated_at = now()
         WHERE storyhold.world_relation_hypotheses.source_kind <> 'user'`,
        [randomUUID(), params.worldId, params.editionId, fingerprint,
          hypothesis.subjectEntityId, hypothesis.relationType, hypothesis.targetEntityId,
          constrainedInterpretation, hypothesis.score,
          json({ explicitGrammar: 55, direction: 25, interpretation: 20 }),
          json([{ chunkId, sourceId: String(first.source_id), quote: hypothesis.quote }]),
          constrainedInterpretation === hypothesis.interpretation
            ? hypothesis.explanation
            : "An owner correction prevents this family wording from being treated as literal kinship.",
          json(relevantConstraints.map((constraint) => constraint.id)), params.runId ?? null],
      );
    }
  }
  if (activeFingerprints.size) {
    const values = [...activeFingerprints];
    const placeholders = values.map((_, index) => `$${index + 3}`).join(",");
    await params.db.query(
      `DELETE FROM storyhold.world_relation_hypotheses
        WHERE world_id = $1 AND canon_edition_id = $2 AND source_kind <> 'user'
          AND fingerprint NOT IN (${placeholders})`,
      [params.worldId, params.editionId, ...values],
    );
  } else {
    await params.db.query(
      `DELETE FROM storyhold.world_relation_hypotheses
        WHERE world_id = $1 AND canon_edition_id = $2 AND source_kind <> 'user'`,
      [params.worldId, params.editionId],
    );
  }
  return { clusters: entities.length, ambiguous, hypotheses: hypothesisCount };
}

export function serializeStoryConceptCluster(row: Record<string, unknown>): StoryConceptCluster {
  return {
    id: String(row.id),
    entityId: typeof row.entity_id === "string" ? row.entity_id : null,
    preferredLabel: String(row.preferred_label ?? ""),
    entityType: String(row.entity_type) as ConceptEntityType,
    labels: Array.isArray(row.labels) ? row.labels.filter((value): value is string => typeof value === "string") : [],
    mentionCount: Number(row.mention_count ?? 0),
    sourceCount: Number(row.source_count ?? 0),
    chapterCount: Number(row.chapter_count ?? 0),
    score: Number(row.score ?? 0),
    scoreBreakdown: (row.score_breakdown && typeof row.score_breakdown === "object"
      ? row.score_breakdown : {}) as ConceptScoreBreakdown,
    resolutionStatus: String(row.resolution_status) as StoryConceptCluster["resolutionStatus"],
    resolutionSource: String(row.resolution_source) as StoryConceptCluster["resolutionSource"],
    alternatives: Array.isArray(row.alternatives)
      ? row.alternatives as StoryConceptCluster["alternatives"] : [],
    evidence: Array.isArray(row.evidence) ? row.evidence as StoryConceptCluster["evidence"] : [],
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : undefined,
  };
}

export function serializeStoryRelationHypothesis(row: Record<string, unknown>): StoryRelationHypothesis {
  return {
    id: String(row.id),
    subjectEntityId: String(row.subject_entity_id),
    subjectName: String(row.subject_name ?? ""),
    relationType: String(row.relation_type),
    targetEntityId: String(row.target_entity_id),
    targetName: String(row.target_name ?? ""),
    interpretation: String(row.interpretation) as StoryRelationHypothesis["interpretation"],
    status: String(row.hypothesis_status) as StoryRelationHypothesis["status"],
    score: Number(row.score ?? 0),
    evidence: Array.isArray(row.evidence) ? row.evidence as StoryRelationHypothesis["evidence"] : [],
    explanation: String(row.explanation ?? ""),
    constraintIds: Array.isArray(row.constraint_ids)
      ? row.constraint_ids.filter((value): value is string => typeof value === "string") : [],
  };
}

export async function conceptResolutionContext(params: {
  db: ConceptDb;
  worldId: string;
  editionId: string;
  entityId?: string | null;
}): Promise<string> {
  const [clusters, hypotheses, constraints] = await Promise.all([
    params.db.query<Record<string, unknown>>(
      `SELECT preferred_label, entity_type, labels, mention_count, source_count,
              chapter_count, score, score_breakdown, resolution_status,
              alternatives
         FROM storyhold.world_concept_clusters
        WHERE world_id = $1 AND canon_edition_id = $2
          AND ($3::uuid IS NULL OR entity_id = $3 OR alternatives @> $4::jsonb)
          AND (resolution_status <> 'verified' OR $3::uuid IS NOT NULL)
        ORDER BY CASE resolution_status WHEN 'ambiguous' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END,
                 score DESC, preferred_label
        LIMIT 180`,
      [params.worldId, params.editionId, params.entityId ?? null,
        json(params.entityId ? [{ entityId: params.entityId }] : [])],
    ),
    params.db.query<Record<string, unknown>>(
      `SELECT hypothesis.subject_entity_id, source.name AS subject_name,
              hypothesis.relation_type, hypothesis.target_entity_id,
              target.name AS target_name, hypothesis.interpretation,
              hypothesis.hypothesis_status, hypothesis.score,
              hypothesis.explanation, hypothesis.constraint_ids
         FROM storyhold.world_relation_hypotheses hypothesis
         JOIN storyhold.world_entities source ON source.id = hypothesis.subject_entity_id
         JOIN storyhold.world_entities target ON target.id = hypothesis.target_entity_id
        WHERE hypothesis.world_id = $1 AND hypothesis.canon_edition_id = $2
          AND ($3::uuid IS NULL OR hypothesis.subject_entity_id = $3
            OR hypothesis.target_entity_id = $3)
          AND (hypothesis.hypothesis_status <> 'verified' OR $3::uuid IS NOT NULL)
        ORDER BY CASE hypothesis.hypothesis_status WHEN 'candidate' THEN 0 ELSE 1 END,
                 hypothesis.score DESC
        LIMIT 240`,
      [params.worldId, params.editionId, params.entityId ?? null],
    ),
    loadOwnerCanonConstraints({
      db: params.db, worldId: params.worldId, editionId: params.editionId,
      entityId: params.entityId, includeWorld: true, limit: 200,
    }),
  ]);
  return JSON.stringify({
    warning: "Concept clusters and relationship hypotheses are retrieval leads, not manuscript evidence. Audit every one against supplied SOURCE passages before promotion.",
    ownerCanonConstraints: constraints.map(({ id, kind, instruction, entityId }) => ({ id, kind, instruction, entityId })),
    conceptClusters: clusters.rows.map((row) => ({
      label: row.preferred_label,
      type: row.entity_type,
      aliases: row.labels,
      mentions: row.mention_count,
      sources: row.source_count,
      chapters: row.chapter_count,
      score: row.score,
      scoreBreakdown: row.score_breakdown,
      status: row.resolution_status,
      alternatives: row.alternatives,
    })),
    relationshipHypotheses: hypotheses.rows.map((row) => ({
      subject: row.subject_name,
      relationType: row.relation_type,
      target: row.target_name,
      interpretation: row.interpretation,
      status: row.hypothesis_status,
      score: row.score,
      explanation: row.explanation,
      constraintIds: row.constraint_ids,
    })),
  }).slice(0, 32_000);
}
