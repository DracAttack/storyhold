import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

type Row = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;
type CheckLevel = "blocker" | "warning";

type AuditCheck = {
  id: string;
  level: CheckLevel;
  passed: boolean;
  expectation: string;
  observed: unknown;
};

type RelationshipObservation = {
  source: string;
  target: string;
  relationship: string;
  summary: string;
  evidenceCount: number;
  origin: "dossier" | "entity";
};

export type OwnerProtectionSnapshotRow = {
  key: string;
  kind: "entity" | "dossier" | "relation" | "membership" | "rule" | "claim";
  fingerprint: string;
};

export type OwnerProtectionSnapshot = {
  rowCount: number;
  fingerprint: string;
  rows: OwnerProtectionSnapshotRow[];
  counts: Record<OwnerProtectionSnapshotRow["kind"], number>;
  inheritedSuppressedEditedDossierIds: string[];
};

export type OwnerProtectionComparison = {
  passed: boolean;
  baseline: { rowCount: number; fingerprint: string };
  current: { rowCount: number; fingerprint: string };
  retainedBaselineFingerprint: string;
  missing: OwnerProtectionSnapshotRow[];
  changed: Array<{
    key: string;
    kind: OwnerProtectionSnapshotRow["kind"];
    baselineFingerprint: string;
    currentFingerprint: string;
  }>;
  added: OwnerProtectionSnapshotRow[];
  inheritedSuppressedEditedDossierIds: string[];
};

export type AuditCliOptions = {
  dataDirArgument: string;
  worldId: string;
  baselineArgument: string | null;
  outputArgument: string | null;
  pretty: boolean;
};

const AUDIT_SCHEMA_VERSION = "storyhold.root-fix-proof-audit.v2";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const INTERNAL_PROCESS_PATTERN =
  /\b(?:GLiNER(?:2)?|Qwen|MiniLM|BGE|WebGPU|llama\.cpp|semantic pass|local (?:semantic|analysis|scan|model|pipeline|classifier|dossier)|connected AI|premium AI|AI verification|AI must verify|source analysis run|scanner (?:found|candidate)|backend)\b/iu;

const EVIDENCE_BOILERPLATE_PATTERN =
  /\b(?:provisional (?:detail|finding|estimate)|cited passages? preserve|directly supported (?:by|in) the manuscript|directly attributed passages?|direct manuscript passage|current local dossier)\b/iu;

const STRUCTURAL_NAME_PATTERN =
  /^(?:(?:chapter|book|part|section|volume)\s+(?:[\divxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)(?:\b|\s*[-:])|prologue|epilogue|table of contents|contents|acknowledg(?:e)?ments?|copyright|title page)$/iu;

const KNOWN_JUNK_NAMES = new Set([
  "armed",
  "betryal",
  "dad",
  "dude",
  "erm",
  "jesus",
]);

const EXPECTED_ALIAS_SPEAKERS = [
  { alias: "Sir Alec", speaker: "David", quotePattern: /David chuckled[^]*Sir Alec/iu },
  { alias: "Buzz", speaker: "David", quotePattern: /David[’']s gaze[^]*Buzz/iu },
  { alias: "Mr. Aldrin", speaker: "David", quotePattern: /David smiled[^]*Mr\. Aldrin/iu },
] as const;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return array(value).map(text).filter(Boolean);
}

function normalized(value: unknown): string {
  return text(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[’']/gu, "'")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, jsonSafe(entry)]),
    );
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(jsonSafe(value))).digest("hex");
}

function unique<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function includesNormalized(values: unknown, expected: string): boolean {
  const target = normalized(expected);
  return strings(values).some((value) => normalized(value) === target);
}

function entityIsCustomerOwned(entity: Row): boolean {
  return entity.classification_source === "user" || entity.review_status === "user_confirmed";
}

function entityIsActiveVisible(entity: Row): boolean {
  return entity.pull_status === "active" && entity.scanner_present === true;
}

function entityLabels(entity: Row): string[] {
  return [text(entity.name), ...strings(entity.aliases)].filter(Boolean);
}

function entityMatches(entity: Row, labels: string[]): boolean {
  const expected = new Set(labels.map(normalized));
  return entityLabels(entity).some((label) => expected.has(normalized(label)));
}

function exactEntity(entities: Row[], name: string): Row | undefined {
  const wanted = normalized(name);
  return entities.find((entity) => normalized(entity.name) === wanted);
}

function activeVisibleEntity(entities: Row[], name: string): Row | undefined {
  const wanted = normalized(name);
  return entities.find((entity) =>
    entityIsActiveVisible(entity) && normalized(entity.name) === wanted
  );
}

function dossierForEntity(dossiersById: Map<string, Row>, entity?: Row): Row | undefined {
  return entity ? dossiersById.get(text(entity.dossier_id)) : undefined;
}

function profile(dossier?: Row): JsonRecord {
  return record(dossier?.profile);
}

function compactEntity(entity?: Row): unknown {
  if (!entity) return null;
  return {
    id: entity.id,
    name: entity.name,
    type: entity.entity_type,
    aliases: entity.aliases,
    mentions: entity.mention_count,
    sources: entity.mention_source_count,
    classificationSource: entity.classification_source,
    reviewStatus: entity.review_status,
    pullStatus: entity.pull_status,
    scannerPresent: entity.scanner_present,
    mergedInto: entity.merged_into_entity_id ?? null,
    dossierId: entity.dossier_id ?? null,
  };
}

function compactDossier(dossier?: Row): unknown {
  if (!dossier) return null;
  const dossierProfile = profile(dossier);
  return {
    id: dossier.id,
    name: dossier.name,
    aliases: dossier.aliases,
    status: dossier.dossier_status,
    mentions: dossier.mention_count,
    sources: dossier.mention_source_count,
    summary: dossier.summary,
    powers: dossierProfile.powers ?? [],
    relationships: dossierProfile.relationships ?? [],
    userEditedAt: dossier.user_edited_at ?? null,
    hasAxisOverride: dossier.axis_user_override !== null && dossier.axis_user_override !== undefined,
  };
}

function entryEvidenceCount(entry: JsonRecord): number {
  return array(entry.evidence).length;
}

function relationshipObservations(entity: Row | undefined, dossier: Row | undefined): RelationshipObservation[] {
  if (!entity) return [];
  const source = text(entity.name);
  const output: RelationshipObservation[] = [];
  for (const entryValue of array(profile(dossier).relationshipWeb)) {
    const entry = record(entryValue);
    const target = text(entry.name);
    const relationship = text(entry.relationship);
    if (!target || !relationship) continue;
    output.push({
      source,
      target,
      relationship,
      summary: text(entry.summary),
      evidenceCount: entryEvidenceCount(entry),
      origin: "dossier",
    });
  }
  const flattened = unique([
    ...strings(entity.relationships),
    ...strings(profile(dossier).relationships),
  ], (value) => normalized(value));
  for (const value of flattened) {
    const separator = value.indexOf(":");
    if (separator <= 0 || separator >= value.length - 1) continue;
    output.push({
      source,
      target: value.slice(0, separator).trim(),
      relationship: value.slice(separator + 1).trim(),
      summary: "",
      evidenceCount: 0,
      origin: "entity",
    });
  }
  return unique(output, (entry) =>
    [entry.source, entry.target, entry.relationship, entry.origin].map(normalized).join("|")
  );
}

function pairMatches(source: string, target: string, left: string, right: string): boolean {
  return normalized(source) === normalized(left) && normalized(target) === normalized(right);
}

function profileText(value: unknown): string {
  if (Array.isArray(value)) return value.map(profileText).filter(Boolean).join(" | ");
  if (!value || typeof value !== "object") return text(value);
  const source = value as JsonRecord;
  return Object.entries(source)
    .filter(([key]) => ![
      "evidence", "quote", "chunkId", "sourceId", "sourceTitle", "chapterTitle",
    ].includes(key))
    .map(([, entry]) => profileText(entry))
    .filter(Boolean)
    .join(" | ");
}

function narrativeProfileText(value: unknown): string {
  if (Array.isArray(value)) return value.map(narrativeProfileText).filter(Boolean).join(" | ");
  if (!value || typeof value !== "object") return text(value);
  const source = value as JsonRecord;
  return Object.entries(source)
    .filter(([key]) => ![
      "evidence", "quote", "chunkId", "sourceId", "sourceTitle", "chapterTitle",
      // Stat cards have their own evidence contract. An unestablished score is
      // not the same defect as exposing pipeline prose in a narrative dossier.
      "estimatedStats",
    ].includes(key))
    .map(([, entry]) => narrativeProfileText(entry))
    .filter(Boolean)
    .join(" | ");
}

function matchingExcerpt(value: string, pattern: RegExp): string {
  const match = pattern.exec(value);
  if (!match || match.index === undefined) return "";
  const start = Math.max(0, match.index - 90);
  const end = Math.min(value.length, match.index + match[0].length + 130);
  return `${start > 0 ? "…" : ""}${value.slice(start, end)}${end < value.length ? "…" : ""}`;
}

function compactRelation(relation: Row): unknown {
  return {
    id: relation.id,
    source: relation.source_name,
    type: relation.relation_type,
    target: relation.target_name,
    status: relation.relation_status,
    summary: relation.summary,
    assignmentSource: relation.assignment_source,
    evidenceCount: array(relation.evidence).length,
  };
}

function selectedFields(row: Row, fields: readonly string[]): JsonRecord {
  return Object.fromEntries(fields.map((field) => [field, jsonSafe(row[field] ?? null)]));
}

function snapshotRow(
  kind: OwnerProtectionSnapshotRow["kind"],
  key: string,
  value: unknown,
): OwnerProtectionSnapshotRow {
  return { kind, key, fingerprint: fingerprint(value) };
}

export function buildOwnerProtectionSnapshot(input: {
  entities: Row[];
  dossiers: Row[];
  relations: Row[];
  memberships: Row[];
  rules: Row[];
  claims: Row[];
}): OwnerProtectionSnapshot {
  const protectedEntities = input.entities.filter(entityIsCustomerOwned);
  const protectedDossierIds = new Set(
    protectedEntities.map((entity) => text(entity.dossier_id)).filter(Boolean),
  );
  const protectedDossiers = input.dossiers.filter((dossier) =>
    protectedDossierIds.has(text(dossier.id)) ||
    (dossier.user_edited_at !== null && dossier.user_edited_at !== undefined) ||
    (dossier.axis_user_override !== null && dossier.axis_user_override !== undefined)
  );
  const rows: OwnerProtectionSnapshotRow[] = [
    ...protectedEntities.map((entity) => snapshotRow(
      "entity",
      `entity:${text(entity.id)}`,
      selectedFields(entity, [
        "id", "dossier_id", "canonical_key", "normalized_name", "name", "entity_type",
        "aliases", "alias_attributions", "summary", "details", "relationships",
        "estimated_stats", "evidence", "mention_count", "mention_source_count",
        "confidence", "classification_source", "review_status", "pull_status",
        "scanner_present", "merged_into_entity_id",
      ]),
    )),
    ...protectedDossiers.map((dossier) => snapshotRow(
      "dossier",
      `dossier:${text(dossier.id)}`,
      selectedFields(dossier, [
        "id", "canonical_character_id", "canonical_key", "normalized_name", "name",
        "aliases", "alias_attributions", "role", "summary", "profile", "evidence",
        "confidence", "dossier_status", "axis_estimate", "axis_user_override",
        "axis_user_changed_at", "user_edited_at", "mention_count", "mention_source_count",
      ]),
    )),
    ...input.relations.filter((row) => row.assignment_source === "user").map((relation) => snapshotRow(
      "relation",
      `relation:${text(relation.id)}`,
      selectedFields(relation, [
        "id", "source_entity_id", "relation_type", "target_entity_id", "relation_status",
        "summary", "valid_from_label", "valid_until_label", "evidence",
        "assignment_source", "confidence",
      ]),
    )),
    ...input.memberships.filter((row) => row.assignment_source === "user").map((membership) => snapshotRow(
      "membership",
      `membership:${text(membership.entity_id)}:${text(membership.faction_entity_id)}`,
      selectedFields(membership, [
        "entity_id", "faction_entity_id", "assignment_source", "confidence", "evidence",
      ]),
    )),
    ...input.rules.filter((row) => row.assignment_source === "user").map((rule) => snapshotRow(
      "rule",
      `rule:${text(rule.id)}`,
      selectedFields(rule, [
        "id", "entity_id", "canonical_key", "name", "description", "rule_kind",
        "trigger_text", "effect_text", "evidence", "assignment_source", "confidence",
        "rule_status",
      ]),
    )),
    ...input.claims.filter((row) => row.assignment_source === "user").map((claim) => snapshotRow(
      "claim",
      `claim:${text(claim.id)}`,
      selectedFields(claim, [
        "id", "fingerprint", "subject_entity_id", "predicate", "polarity",
        "object_entity_id", "object_text", "epistemic_holder_entity_id",
        "truth_status", "valid_from_label", "valid_until_label", "claim_status",
        "summary", "evidence", "assignment_source", "confidence",
      ]),
    )),
  ].sort((left, right) => left.key.localeCompare(right.key));
  const counts: OwnerProtectionSnapshot["counts"] = {
    entity: 0,
    dossier: 0,
    relation: 0,
    membership: 0,
    rule: 0,
    claim: 0,
  };
  for (const row of rows) counts[row.kind] += 1;
  const inheritedSuppressedEditedDossierIds = protectedDossiers
    .filter((dossier) =>
      dossier.user_edited_at !== null && dossier.user_edited_at !== undefined &&
      dossier.dossier_status === "suppressed"
    )
    .map((dossier) => text(dossier.id))
    .sort();
  return {
    rowCount: rows.length,
    fingerprint: fingerprint(rows),
    rows,
    counts,
    inheritedSuppressedEditedDossierIds,
  };
}

export function compareOwnerProtectionSnapshots(
  baseline: OwnerProtectionSnapshot,
  current: OwnerProtectionSnapshot,
): OwnerProtectionComparison {
  const baselineByKey = new Map(baseline.rows.map((row) => [row.key, row]));
  const currentByKey = new Map(current.rows.map((row) => [row.key, row]));
  const missing = baseline.rows.filter((row) => !currentByKey.has(row.key));
  const changed = baseline.rows.flatMap((row) => {
    const currentRow = currentByKey.get(row.key);
    if (!currentRow || currentRow.fingerprint === row.fingerprint) return [];
    return [{
      key: row.key,
      kind: row.kind,
      baselineFingerprint: row.fingerprint,
      currentFingerprint: currentRow.fingerprint,
    }];
  });
  const added = current.rows.filter((row) => !baselineByKey.has(row.key));
  const retainedBaseline = baseline.rows.flatMap((row) => {
    const currentRow = currentByKey.get(row.key);
    return currentRow ? [currentRow] : [];
  });
  return {
    passed: missing.length === 0 && changed.length === 0 && added.length === 0,
    baseline: { rowCount: baseline.rowCount, fingerprint: baseline.fingerprint },
    current: { rowCount: current.rowCount, fingerprint: current.fingerprint },
    retainedBaselineFingerprint: fingerprint(retainedBaseline),
    missing,
    changed,
    added,
    inheritedSuppressedEditedDossierIds: baseline.inheritedSuppressedEditedDossierIds.filter((id) =>
      current.inheritedSuppressedEditedDossierIds.includes(id)
    ),
  };
}

function profileStat(profileValue: JsonRecord, name: string): JsonRecord {
  const estimates = record(profileValue.estimatedStats);
  const key = Object.keys(estimates).find((candidate) => normalized(candidate) === normalized(name));
  return key ? record(estimates[key]) : {};
}

function structuredPairRelations(relations: Row[], left: Row | undefined, right: Row | undefined): Row[] {
  if (!left || !right) return [];
  const leftId = text(left.id);
  const rightId = text(right.id);
  return relations.filter((relation) => {
    const source = text(relation.source_entity_id);
    const target = text(relation.target_entity_id);
    return (source === leftId && target === rightId) || (source === rightId && target === leftId);
  });
}

function aliasAttributions(entity: Row | undefined, dossier: Row | undefined): JsonRecord[] {
  return unique(
    [...array(entity?.alias_attributions), ...array(dossier?.alias_attributions)].map(record),
    (entry) => [entry.alias, entry.chunkId, entry.sourceId].map(normalized).join("|"),
  );
}

function makeCheck(
  checks: AuditCheck[],
  id: string,
  level: CheckLevel,
  passed: boolean,
  expectation: string,
  observed: unknown,
): void {
  checks.push({ id, level, passed, expectation, observed: jsonSafe(observed) });
}

async function ensureClosedExistingDataDirectory(dataDir: string): Promise<void> {
  await access(dataDir);
  const details = await stat(dataDir);
  if (!details.isDirectory()) throw new Error(`${dataDir} is not a directory.`);
  await access(path.join(dataDir, "PG_VERSION"));
  const pidPath = path.join(dataDir, "postmaster.pid");
  try {
    const pidText = await readFile(pidPath, "utf8");
    const pid = Number(pidText.split(/\r?\n/u)[0]);
    if (pid === -42) return;
    if (Number.isInteger(pid) && pid > 0) {
      throw new Error(
        `Refusing to audit ${dataDir}: postmaster PID ${pid} is present. Stop or copy the vault first.`,
      );
    }
    throw new Error(
      `Refusing to audit ${dataDir}: postmaster.pid has an unrecognized first line. Use a cleanly closed staging copy.`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function selectRows(
  db: Pick<PGlite, "query">,
  sql: string,
  parameters: unknown[] = [],
): Promise<Row[]> {
  if (!/^\s*(?:SELECT|WITH)\b/iu.test(sql)) {
    throw new Error("The proof auditor only permits SELECT/CTE statements.");
  }
  const result = await db.query<Row>(sql, parameters);
  return result.rows;
}

async function withReadOnlyPglite<T>(
  dataDir: string,
  operation: (db: Pick<PGlite, "query">) => Promise<T>,
): Promise<T> {
  await ensureClosedExistingDataDirectory(dataDir);
  const db = await PGlite.create({ dataDir, extensions: { vector } });
  let transactionOpen = false;
  try {
    await db.exec("BEGIN TRANSACTION READ ONLY");
    transactionOpen = true;
    const result = await operation(db);
    await db.exec("ROLLBACK");
    transactionOpen = false;
    return result;
  } finally {
    if (transactionOpen) await db.exec("ROLLBACK").catch(() => undefined);
    await db.close();
  }
}

async function ownerProtectionSnapshotFromClosedDatabase(
  dataDir: string,
  worldId: string,
): Promise<OwnerProtectionSnapshot> {
  return withReadOnlyPglite(dataDir, async (db) => {
    const world = await selectRows(
      db,
      "SELECT id FROM storyhold.worlds WHERE id = $1 LIMIT 1",
      [worldId],
    );
    if (!world[0]) throw new Error(`Baseline world ${worldId} was not found.`);
    const edition = await selectRows(
      db,
      `SELECT id FROM storyhold.canon_editions
        WHERE world_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1`,
      [worldId],
    );
    const editionId = text(edition[0]?.id);
    if (!editionId) throw new Error(`Baseline world ${worldId} has no canon edition.`);
    const entities = await selectRows(
      db,
      `SELECT * FROM storyhold.world_entities
        WHERE world_id = $1 AND canon_edition_id = $2
        ORDER BY normalized_name, id`,
      [worldId, editionId],
    );
    const dossiers = await selectRows(
      db,
      `SELECT * FROM storyhold.character_dossiers
        WHERE world_id = $1 AND canon_edition_id = $2
        ORDER BY normalized_name, id`,
      [worldId, editionId],
    );
    const relations = await selectRows(
      db,
      `SELECT * FROM storyhold.world_entity_relations
        WHERE world_id = $1 AND canon_edition_id = $2 AND assignment_source = 'user'
        ORDER BY id`,
      [worldId, editionId],
    );
    const memberships = await selectRows(
      db,
      `SELECT membership.*
         FROM storyhold.world_entity_faction_memberships membership
         JOIN storyhold.world_entities entity ON entity.id = membership.entity_id
        WHERE entity.world_id = $1 AND entity.canon_edition_id = $2
          AND membership.assignment_source = 'user'
        ORDER BY membership.entity_id, membership.faction_entity_id`,
      [worldId, editionId],
    );
    const rules = await selectRows(
      db,
      `SELECT * FROM storyhold.world_entity_rules
        WHERE world_id = $1 AND canon_edition_id = $2 AND assignment_source = 'user'
        ORDER BY id`,
      [worldId, editionId],
    );
    const claims = await selectRows(
      db,
      `SELECT * FROM storyhold.world_knowledge_claims
        WHERE world_id = $1 AND canon_edition_id = $2 AND assignment_source = 'user'
        ORDER BY id`,
      [worldId, editionId],
    );
    return buildOwnerProtectionSnapshot({ entities, dossiers, relations, memberships, rules, claims });
  });
}

async function audit(
  db: Pick<PGlite, "query">,
  worldId: string,
  dataDir: string,
  baselineOwnerProtection?: { dataDirectory: string; snapshot: OwnerProtectionSnapshot },
) {
  const checks: AuditCheck[] = [];
  const worldRows = await selectRows(
    db,
    "SELECT id, name, owner_player_id FROM storyhold.worlds WHERE id = $1 LIMIT 1",
    [worldId],
  );
  const world = worldRows[0];
  if (!world) throw new Error(`World ${worldId} was not found.`);
  const editionRows = await selectRows(
    db,
    `SELECT id, name, created_at
       FROM storyhold.canon_editions
      WHERE world_id = $1
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [worldId],
  );
  const edition = editionRows[0];
  if (!edition) throw new Error(`World ${worldId} has no canon edition.`);
  const editionId = text(edition.id);

  // Deliberately sequential: this diagnostic must not create a memory spike
  // while a local model worker is resident.
  const entities = await selectRows(
    db,
    `SELECT id, dossier_id, canonical_key, name, normalized_name, entity_type, aliases,
            alias_attributions, summary, details, relationships, estimated_stats,
            evidence, mention_count, mention_source_count, confidence,
            classification_source, review_status, pull_status, scanner_present,
            merged_into_entity_id, source_analysis_run_id
       FROM storyhold.world_entities
      WHERE world_id = $1 AND canon_edition_id = $2
      ORDER BY normalized_name, id`,
    [worldId, editionId],
  );
  const dossiers = await selectRows(
    db,
    `SELECT id, canonical_character_id, canonical_key, name, normalized_name,
            aliases, alias_attributions, role, summary,
            profile, evidence, confidence, dossier_status, mention_count,
            mention_source_count, axis_estimate, axis_user_override,
            axis_user_changed_at, user_edited_at,
            source_analysis_run_id
       FROM storyhold.character_dossiers
      WHERE world_id = $1 AND canon_edition_id = $2
      ORDER BY normalized_name, id`,
    [worldId, editionId],
  );
  const relations = await selectRows(
    db,
    `SELECT relation.id, relation.source_entity_id, source.name AS source_name,
            relation.relation_type, relation.target_entity_id,
            target.name AS target_name, relation.relation_status,
            relation.summary, relation.valid_from_label, relation.valid_until_label,
            relation.evidence, relation.assignment_source, relation.confidence
       FROM storyhold.world_entity_relations relation
       JOIN storyhold.world_entities source ON source.id = relation.source_entity_id
       JOIN storyhold.world_entities target ON target.id = relation.target_entity_id
      WHERE relation.world_id = $1 AND relation.canon_edition_id = $2
      ORDER BY source.name, relation.relation_type, target.name, relation.id`,
    [worldId, editionId],
  );
  const ownerMemberships = await selectRows(
    db,
    `SELECT membership.entity_id, membership.faction_entity_id,
            membership.assignment_source, membership.confidence, membership.evidence
       FROM storyhold.world_entity_faction_memberships membership
       JOIN storyhold.world_entities entity ON entity.id = membership.entity_id
      WHERE entity.world_id = $1 AND entity.canon_edition_id = $2
        AND membership.assignment_source = 'user'
      ORDER BY membership.entity_id, membership.faction_entity_id`,
    [worldId, editionId],
  );
  const ownerRules = await selectRows(
    db,
    `SELECT id, entity_id, canonical_key, name, description, rule_kind,
            trigger_text, effect_text, evidence, assignment_source, confidence, rule_status
       FROM storyhold.world_entity_rules
      WHERE world_id = $1 AND canon_edition_id = $2 AND assignment_source = 'user'
      ORDER BY id`,
    [worldId, editionId],
  );
  const ownerClaims = await selectRows(
    db,
    `SELECT id, fingerprint, subject_entity_id, predicate, polarity,
            object_entity_id, object_text, epistemic_holder_entity_id,
            truth_status, valid_from_label, valid_until_label, summary,
            evidence, confidence, claim_status, assignment_source
       FROM storyhold.world_knowledge_claims
      WHERE world_id = $1 AND canon_edition_id = $2 AND assignment_source = 'user'
      ORDER BY id`,
    [worldId, editionId],
  );
  const currentOwnerProtection = buildOwnerProtectionSnapshot({
    entities,
    dossiers,
    relations,
    memberships: ownerMemberships,
    rules: ownerRules,
    claims: ownerClaims,
  });

  const dossiersById = new Map(dossiers.map((dossier) => [text(dossier.id), dossier]));
  const entityById = new Map(entities.map((entity) => [text(entity.id), entity]));
  const visibleEntities = entities.filter(entityIsActiveVisible);
  const visibleByLabel = new Map<string, Row>();
  for (const entity of visibleEntities) {
    for (const label of entityLabels(entity)) {
      const key = normalized(label);
      if (!visibleByLabel.has(key)) visibleByLabel.set(key, entity);
    }
  }
  const allRelationshipObservations = entities.flatMap((entity) =>
    relationshipObservations(entity, dossierForEntity(dossiersById, entity))
  );

  const identityVariants = entities.filter((entity) =>
    entityMatches(entity, ["David", "Dave", "Raider Dave"])
  );
  const activeIdentityVariants = identityVariants.filter(entityIsActiveVisible);
  const david = activeVisibleEntity(entities, "David");
  const davidDossier = dossierForEntity(dossiersById, david);
  makeCheck(
    checks,
    "david.one-active-canonical-identity",
    "blocker",
    activeIdentityVariants.length === 1 && normalized(activeIdentityVariants[0]?.name) === "david",
    "David, Dave, and Raider Dave resolve to one visible canonical David row.",
    identityVariants.map(compactEntity),
  );
  makeCheck(
    checks,
    "david.character-category",
    "blocker",
    david?.entity_type === "character",
    "Canonical David is a character.",
    compactEntity(david),
  );
  makeCheck(
    checks,
    "david.composite-aliases-and-count",
    "blocker",
    Boolean(david) && includesNormalized(david?.aliases, "Dave") &&
      includesNormalized(david?.aliases, "Raider Dave") && number(david?.mention_count) >= 147 &&
      davidDossier?.dossier_status === "active" && normalized(davidDossier?.name) === "david" &&
      includesNormalized(davidDossier?.aliases, "Dave") &&
      includesNormalized(davidDossier?.aliases, "Raider Dave") && number(davidDossier?.mention_count) >= 147,
    "David's entity and active dossier retain Dave/Raider Dave aliases and composite the 87 + 60 persisted mentions.",
    { entity: compactEntity(david), dossier: compactDossier(davidDossier) },
  );
  makeCheck(
    checks,
    "david.retired-split-hidden",
    "blocker",
    identityVariants.filter((entity) => entity.id !== david?.id).every((entity) =>
      entity.pull_status === "merged" && entity.scanner_present === false &&
      text(entity.merged_into_entity_id) === text(david?.id)
    ),
    "Every retired David/Dave split is merged into canonical David and is scanner-hidden.",
    identityVariants.filter((entity) => entity.id !== david?.id).map(compactEntity),
  );

  const alec = activeVisibleEntity(entities, "Alec Sumner");
  const alecDossier = dossierForEntity(dossiersById, alec);
  const alecAttributions = aliasAttributions(alec, alecDossier);
  for (const expected of EXPECTED_ALIAS_SPEAKERS) {
    const matchingAttributions = alecAttributions.filter((entry) =>
      normalized(entry.alias) === normalized(expected.alias) && expected.quotePattern.test(text(entry.quote))
    );
    const attribution = matchingAttributions[0];
    const quote = text(attribution?.quote);
    makeCheck(
      checks,
      `alec.alias-attribution.${normalized(expected.alias).replace(/\s+/gu, "-")}`,
      "blocker",
      normalized(attribution?.attributedBy) === normalized(expected.speaker) &&
        normalized(quote).includes(normalized(expected.alias)) &&
        Boolean(text(attribution?.chunkId)) && Boolean(text(attribution?.sourceId)),
      `${expected.alias} is attributed to David with inspectable quotation, chunk, and source evidence.`,
      matchingAttributions.length ? matchingAttributions : null,
    );
  }
  const alecSummary = text(alecDossier?.summary || alec?.summary);
  const alecProfile = profile(alecDossier);
  const alecPowers = profileText(alecProfile.powers);
  const alecRelationships = relationshipObservations(alec, alecDossier);
  const alecEchoRelationship = alecRelationships.find((entry) =>
    normalized(entry.target) === "echo" && /\b(?:symbio|bond|host|shared mind|within|inside)\b/iu.test(
      `${entry.relationship} ${entry.summary}`,
    )
  );
  makeCheck(
    checks,
    "alec.defining-summary",
    "blocker",
    /\bEcho\b/iu.test(alecSummary) && /\b(?:symbio|within|inside|mind|head)\w*/iu.test(alecSummary) &&
      /\btransform\w*/iu.test(alecSummary),
    "Alec's customer-facing summary explicitly includes Echo's internal symbiosis and Alec's transformation.",
    alecSummary,
  );
  makeCheck(
    checks,
    "alec.transformation-power",
    "blocker",
    /\btransform\w*/iu.test(alecPowers),
    "Alec's transformation is persisted in Powers, not only in stats/capabilities.",
    alecProfile.powers ?? [],
  );
  makeCheck(
    checks,
    "alec.echo-relationship",
    "blocker",
    Boolean(alecEchoRelationship),
    "Alec's relationship web records his symbiotic bond with Echo.",
    alecRelationships.filter((entry) => normalized(entry.target) === "echo"),
  );

  const echo = activeVisibleEntity(entities, "Echo");
  const echoDossier = dossierForEntity(dossiersById, echo);
  const echoSummary = text(echoDossier?.summary || echo?.summary);
  const echoProfile = profile(echoDossier);
  const echoPowers = profileText(echoProfile.powers);
  const echoRelationships = relationshipObservations(echo, echoDossier);
  const echoAlecRelationship = echoRelationships.find((entry) =>
    ["alec", "alec sumner"].includes(normalized(entry.target)) && /\b(?:symbio|bond|host|shared mind|within|inside)\b/iu.test(
      `${entry.relationship} ${entry.summary}`,
    )
  );
  makeCheck(
    checks,
    "echo.defining-summary",
    "blocker",
    /\bAlec(?: Sumner)?\b/iu.test(echoSummary) && /\b(?:symbio|within|inside|mind|head)\w*/iu.test(echoSummary),
    "Echo's summary identifies Echo as Alec's internal Visharath symbiont.",
    echoSummary,
  );
  makeCheck(
    checks,
    "echo.transformation-power",
    "blocker",
    /\btransform\w*/iu.test(echoPowers),
    "Echo's role in the shared transformation is persisted in Powers.",
    echoProfile.powers ?? [],
  );
  makeCheck(
    checks,
    "echo.alec-relationship",
    "blocker",
    Boolean(echoAlecRelationship),
    "Echo's relationship web records the symbiotic bond with Alec Sumner.",
    echoRelationships.filter((entry) => ["alec", "alec sumner"].includes(normalized(entry.target))),
  );

  const turned = exactEntity(entities, "Turned");
  const turnedDossier = dossierForEntity(dossiersById, turned);
  const turnedEchoProjection = [
    ...relationshipObservations(turned, turnedDossier).filter((entry) => normalized(entry.target) === "echo"),
    ...echoRelationships.filter((entry) => normalized(entry.target) === "turned"),
  ].filter((entry) => /symbio/iu.test(`${entry.relationship} ${entry.summary}`));
  const turnedEchoGraph = structuredPairRelations(relations, turned, echo).filter((relation) =>
    /symbio/iu.test(`${text(relation.relation_type)} ${text(relation.summary)}`)
  );
  makeCheck(
    checks,
    "echo.no-turned-symbiosis",
    "blocker",
    turnedEchoProjection.length === 0 && turnedEchoGraph.length === 0,
    "Neither side of the Turned/Echo pair retains the false Symbiotic Bond.",
    { projected: turnedEchoProjection, structured: turnedEchoGraph.map(compactRelation) },
  );

  const michael = activeVisibleEntity(entities, "Michael");
  const michaelDossier = dossierForEntity(dossiersById, michael);
  const michaelProfile = profile(michaelDossier);
  const strength = profileStat(michaelProfile, "strength");
  const thrall = activeVisibleEntity(entities, "Thrall");
  const thrallDossier = dossierForEntity(dossiersById, thrall);
  const thrallMichaelProjection = relationshipObservations(thrall, thrallDossier)
    .filter((entry) => normalized(entry.target) === "michael" &&
      /\bmanifested by\b/iu.test(`${entry.relationship} ${entry.summary}`));
  const michaelThrallRelations = structuredPairRelations(relations, michael, thrall);
  makeCheck(
    checks,
    "michael.thrall-identity",
    "blocker",
    includesNormalized(michael?.aliases, "Mike") &&
      /\bThrall\b/iu.test(text(michaelDossier?.summary || michael?.summary)) &&
      /\bThrall\b/iu.test(profileText(michaelProfile.powers)) &&
      michaelThrallRelations.some((relation) =>
        relation.relation_type === "has_form" &&
        text(relation.source_entity_id) === text(michael?.id) &&
        text(relation.target_entity_id) === text(thrall?.id)
      ) && thrallMichaelProjection.length > 0,
    "Michael composites Mike, is identified as the Thrall in summary/Powers, has a directed structured form edge, and Thrall retains the reciprocal projection.",
    {
      entity: compactEntity(michael),
      dossier: compactDossier(michaelDossier),
      thrall: compactEntity(thrall),
      thrallDossier: compactDossier(thrallDossier),
      thrallMichaelProjection,
      thrallRelations: michaelThrallRelations.map(compactRelation),
    },
  );
  makeCheck(
    checks,
    "michael.thrall-strength",
    "blocker",
    number(strength.score) >= 17 && array(strength.evidence).length > 0 &&
      /\bThrall\b/iu.test(`${text(strength.rationale)} ${JSON.stringify(strength.evidence ?? [])}`),
    "Michael's Strength is at least 17 and cites his Thrall evidence.",
    strength,
  );

  const lilly = activeVisibleEntity(entities, "Lilly");
  const kendall = activeVisibleEntity(entities, "Kendall");
  const lillyDossier = dossierForEntity(dossiersById, lilly);
  const kendallDossier = dossierForEntity(dossiersById, kendall);
  const lillyRelationships = relationshipObservations(lilly, lillyDossier);
  const kendallRelationships = relationshipObservations(kendall, kendallDossier);
  const affair = [
    ...lillyRelationships.filter((entry) => normalized(entry.target) === "kendall"),
    ...kendallRelationships.filter((entry) => normalized(entry.target) === "lilly"),
  ].find((entry) => /\b(?:affair|romantic|infidel|cheat|lover)\w*/iu.test(
    `${entry.relationship} ${entry.summary}`,
  ));
  const lillyAlecHistory = lillyRelationships.find((entry) =>
    ["alec", "alec sumner"].includes(normalized(entry.target)) &&
    /\b(?:broken|rupture|former|earlier|later|ended|marri|partner)\w*/iu.test(
      `${entry.relationship} ${entry.summary}`,
    )
  );
  makeCheck(
    checks,
    "lilly-kendall.affair",
    "blocker",
    Boolean(affair) && number(affair?.evidenceCount) > 0,
    "Lilly and Kendall's affair/romantic betrayal is explicit and evidenced.",
    { affair: affair ?? null, pair: [...lillyRelationships, ...kendallRelationships].filter((entry) =>
      ["lilly", "kendall"].includes(normalized(entry.source)) &&
      ["lilly", "kendall"].includes(normalized(entry.target))
    ) },
  );
  makeCheck(
    checks,
    "lilly-alec.temporal-rupture",
    "blocker",
    Boolean(lillyAlecHistory),
    "Lilly and Alec retain the earlier partnership and later rupture rather than one timeless opposition.",
    lillyRelationships.filter((entry) => ["alec", "alec sumner"].includes(normalized(entry.target))),
  );

  const raggerVariants = entities.filter((entity) =>
    entityMatches(entity, ["Ragger", "Karagorn Anubsika", "Anubsika", "Anubis"])
  );
  const activeRaggerVariants = raggerVariants.filter(entityIsActiveVisible);
  const ragger = activeVisibleEntity(entities, "Ragger");
  const raggerDossier = dossierForEntity(dossiersById, ragger);
  makeCheck(
    checks,
    "ragger.canonical-identity",
    "blocker",
    activeRaggerVariants.length === 1 && Boolean(ragger) && ragger?.entity_type === "character" &&
      ["Karagorn Anubsika", "Anubsika", "Anubis"].every((alias) =>
        includesNormalized(ragger?.aliases, alias)
      ),
    "Ragger is one visible character identity with Karagorn Anubsika, Anubsika, and Anubis as aliases.",
    raggerVariants.map(compactEntity),
  );
  makeCheck(
    checks,
    "ragger.singular-prowler-form-wording",
    "blocker",
    !/form of the Prowlers/iu.test(profileText(profile(raggerDossier).powers)),
    "Ragger's Powers do not use the stale split wording 'form of the Prowlers'.",
    profile(raggerDossier).powers ?? [],
  );

  const prowlerVariants = entities.filter((entity) => entityMatches(entity, ["Prowler", "Prowlers"]));
  const activeProwlerVariants = prowlerVariants.filter(entityIsActiveVisible);
  const prowler = activeVisibleEntity(entities, "Prowler");
  const prowlerDossier = dossierForEntity(dossiersById, prowler);
  makeCheck(
    checks,
    "prowler.singular-plural-identity",
    "blocker",
    activeProwlerVariants.length === 1 && Boolean(prowler) && prowler?.entity_type === "creature" &&
      includesNormalized(prowler?.aliases, "Prowlers") && number(prowler?.mention_count) >= 36 &&
      prowlerDossier?.dossier_status === "active" && includesNormalized(prowlerDossier?.aliases, "Prowlers") &&
      number(prowlerDossier?.mention_count) >= 36,
    "Prowler/Prowlers collapse to one visible creature and active dossier with the plural alias and composite count.",
    { entities: prowlerVariants.map(compactEntity), dossier: compactDossier(prowlerDossier) },
  );
  makeCheck(
    checks,
    "prowler.retired-split-hidden",
    "blocker",
    prowlerVariants.filter((entity) => entity.id !== prowler?.id).every((entity) =>
      entity.pull_status === "merged" && entity.scanner_present === false &&
      text(entity.merged_into_entity_id) === text(prowler?.id)
    ),
    "Every retired Prowler/Prowlers split is merged into the survivor and scanner-hidden.",
    prowlerVariants.filter((entity) => entity.id !== prowler?.id).map(compactEntity),
  );

  const martin = activeVisibleEntity(entities, "Martin");
  const martinDossier = dossierForEntity(dossiersById, martin);
  const martinProfile = profile(martinDossier);
  const martinHistory = profileText(martinProfile.history);
  const martinPhysical = profileText(martinProfile.physicalCharacteristics);
  makeCheck(
    checks,
    "martin.history-vs-scars",
    "blocker",
    !/\b(?:thrust out|held out|extended|reached out)\b[^.]{0,80}\bhand\b/iu.test(martinHistory) &&
      /\bscar\w*/iu.test(martinPhysical),
    "Martin's hand gesture is absent from History while his scars remain Physical Characteristics.",
    { history: martinProfile.history ?? [], physicalCharacteristics: martinProfile.physicalCharacteristics ?? [] },
  );

  const whiskey = activeVisibleEntity(entities, "Whiskey Angel");
  const whiskeyDossier = dossierForEntity(dossiersById, whiskey);
  const whiskeyAlecLeads = relationshipObservations(whiskey, whiskeyDossier).filter((entry) =>
    ["alec", "alec sumner"].includes(normalized(entry.target)) && normalized(entry.relationship) === "leads"
  );
  const whiskeyAlecGraphLeads = relations.filter((relation) =>
    text(relation.source_entity_id) === text(whiskey?.id) &&
    text(relation.target_entity_id) === text(alec?.id) && relation.relation_type === "leads"
  );
  makeCheck(
    checks,
    "whiskey.no-false-alec-leads",
    "blocker",
    whiskeyAlecLeads.length === 0 && whiskeyAlecGraphLeads.length === 0,
    "Whiskey Angel does not retain a false Leads relationship to Alec.",
    { projected: whiskeyAlecLeads, structured: whiskeyAlecGraphLeads.map(compactRelation) },
  );

  const knownClutterPairs = [
    ["Mathis", "Banshees"],
    ["Molly", "Banshees"],
    ["Sarah", "Banshees"],
    ["Vishtal", "our species"],
    ["Vishtal", "your species"],
    ["armed", "Turned"],
  ] as const;
  const generatedEntityNames = new Set(
    entities.filter((entity) => entityIsActiveVisible(entity) && !entityIsCustomerOwned(entity))
      .map((entity) => normalized(entity.name)),
  );
  const knownProjectedClutter = allRelationshipObservations.filter((entry) =>
    generatedEntityNames.has(normalized(entry.source)) && knownClutterPairs.some(([source, target]) =>
      pairMatches(entry.source, entry.target, source, target)
    )
  );
  const knownStructuredClutter = relations.filter((relation) =>
    relation.assignment_source !== "user" &&
    entityIsActiveVisible(entityById.get(text(relation.source_entity_id)) ?? {}) &&
    !entityIsCustomerOwned(entityById.get(text(relation.source_entity_id)) ?? {}) &&
    knownClutterPairs.some(([source, target]) =>
      pairMatches(text(relation.source_name), text(relation.target_name), source, target)
    )
  );
  makeCheck(
    checks,
    "global.no-known-generated-relation-clutter",
    "blocker",
    knownProjectedClutter.length === 0 && knownStructuredClutter.length === 0,
    "Known V4 co-occurrence/species clutter is absent from every generated profile and graph row.",
    { projected: knownProjectedClutter, structured: knownStructuredClutter.map(compactRelation) },
  );

  const expectedTargetCategories: Array<{ pattern: RegExp; allowed: Set<string> }> = [
    { pattern: /\bAssociated Location\b/iu, allowed: new Set(["place"]) },
    { pattern: /\bCreature Connection\b/iu, allowed: new Set(["creature", "species"]) },
    { pattern: /\bMember Of Species\b/iu, allowed: new Set(["creature", "species"]) },
    { pattern: /\bFaction Connection\b/iu, allowed: new Set(["faction", "institution", "government", "power_structure"]) },
    { pattern: /\bTechnology Connection\b/iu, allowed: new Set(["technology", "device", "vehicle", "weapon"]) },
  ];
  const staleCategoryLabels = unique(allRelationshipObservations.flatMap((entry) => {
    const rule = expectedTargetCategories.find((candidate) => candidate.pattern.test(entry.relationship));
    const target = visibleByLabel.get(normalized(entry.target));
    if (!rule || !target || rule.allowed.has(text(target.entity_type))) return [];
    return [{ ...entry, targetType: target.entity_type }];
  }), (entry) => [entry.source, entry.target, entry.relationship].map(normalized).join("|"));
  makeCheck(
    checks,
    "global.no-stale-category-labels",
    "blocker",
    staleCategoryLabels.length === 0,
    "Projected relationship labels agree with each target's final persisted category.",
    staleCategoryLabels,
  );

  const visibleStructural = visibleEntities.filter((entity) => STRUCTURAL_NAME_PATTERN.test(text(entity.name)));
  const visibleJunk = visibleEntities.filter((entity) => KNOWN_JUNK_NAMES.has(normalized(entity.name)));
  const customerHidden = entities.filter((entity) =>
    entity.pull_status === "do_not_pull" && entityIsCustomerOwned(entity)
  );
  const customerHiddenJunk = customerHidden.filter((entity) =>
    KNOWN_JUNK_NAMES.has(normalized(entity.name)) || STRUCTURAL_NAME_PATTERN.test(text(entity.name))
  );
  const scannerLeakedHidden = entities.filter((entity) =>
    entity.pull_status === "do_not_pull" && !entityIsCustomerOwned(entity) && entity.scanner_present === true
  );
  makeCheck(
    checks,
    "global.no-visible-structural-or-junk-cards",
    "blocker",
    visibleStructural.length === 0 && visibleJunk.length === 0,
    "Structural headings and known junk tokens do not produce visible cards.",
    { structural: visibleStructural.map(compactEntity), junk: visibleJunk.map(compactEntity) },
  );
  makeCheck(
    checks,
    "global.customer-hidden-is-owner-authored",
    "blocker",
    customerHiddenJunk.length === 0 && scannerLeakedHidden.length === 0,
    "Customer Hidden has no known junk, and discarded scanner leads cannot masquerade as owner-hidden cards.",
    {
      customerHidden: customerHidden.map(compactEntity),
      customerHiddenJunk: customerHiddenJunk.map(compactEntity),
      scannerLeakedHidden: scannerLeakedHidden.map(compactEntity),
    },
  );

  if (baselineOwnerProtection) {
    const comparison = compareOwnerProtectionSnapshots(
      baselineOwnerProtection.snapshot,
      currentOwnerProtection,
    );
    makeCheck(
      checks,
      "owner-protection.persisted",
      "blocker",
      comparison.passed,
      "Every baseline owner-protected row is byte-stable at the canon-field level, with no missing, changed, or newly protected rows.",
      {
        baselineDataDirectory: baselineOwnerProtection.dataDirectory,
        baselineCounts: baselineOwnerProtection.snapshot.counts,
        currentCounts: currentOwnerProtection.counts,
        ...comparison,
      },
    );
  } else {
    makeCheck(
      checks,
      "owner-protection.persisted",
      "warning",
      false,
      "Owner protection requires --baseline <closed-pre-replay-data-dir>; inherited suppressed/edited state cannot be judged safely without it.",
      {
        comparisonAvailable: false,
        current: {
          rowCount: currentOwnerProtection.rowCount,
          fingerprint: currentOwnerProtection.fingerprint,
          counts: currentOwnerProtection.counts,
          suppressedEditedDossierIds: currentOwnerProtection.inheritedSuppressedEditedDossierIds,
        },
      },
    );
  }

  const targetAcceptanceNames = new Set([
    "alec sumner", "david", "echo", "kendall", "lilly", "martin", "michael", "ragger", "whiskey angel",
  ]);
  const surfaceRows = visibleEntities.flatMap((entity) => {
    const dossier = dossierForEntity(dossiersById, entity);
    const surface = [
      text(entity.summary),
      profileText(entity.details),
      profileText(entity.relationships),
      text(dossier?.role),
      text(dossier?.summary),
      profileText(dossier?.profile),
    ].filter(Boolean).join(" | ");
    const narrativeSurface = [
      text(entity.summary),
      profileText(entity.details),
      profileText(entity.relationships),
      text(dossier?.role),
      text(dossier?.summary),
      narrativeProfileText(dossier?.profile),
    ].filter(Boolean).join(" | ");
    return [{ name: text(entity.name), surface, narrativeSurface }];
  });
  const internalProcessLeaks = surfaceRows
    .filter((row) => INTERNAL_PROCESS_PATTERN.test(row.surface))
    .map((row) => ({ name: row.name, excerpt: matchingExcerpt(row.surface, INTERNAL_PROCESS_PATTERN) }));
  const targetBoilerplateLeaks = surfaceRows
    .filter((row) =>
      targetAcceptanceNames.has(normalized(row.name)) &&
      EVIDENCE_BOILERPLATE_PATTERN.test(row.narrativeSurface)
    )
    .map((row) => ({
      name: row.name,
      excerpt: matchingExcerpt(row.narrativeSurface, EVIDENCE_BOILERPLATE_PATTERN),
    }));
  const globalBoilerplateLeaks = surfaceRows
    .filter((row) => EVIDENCE_BOILERPLATE_PATTERN.test(row.narrativeSurface))
    .map((row) => ({
      name: row.name,
      excerpt: matchingExcerpt(row.narrativeSurface, EVIDENCE_BOILERPLATE_PATTERN),
    }));
  makeCheck(
    checks,
    "presentation.no-internal-process-language",
    "blocker",
    internalProcessLeaks.length === 0,
    "No visible customer surface exposes model, pipeline, scanner, or backend implementation language.",
    internalProcessLeaks,
  );
  makeCheck(
    checks,
    "presentation.target-dossiers-avoid-evidence-boilerplate",
    "blocker",
    targetBoilerplateLeaks.length === 0,
    "Acceptance-target dossiers use narrative prose instead of provisional/evidence-process boilerplate.",
    targetBoilerplateLeaks,
  );
  makeCheck(
    checks,
    "presentation.full-world-evidence-boilerplate-backlog",
    "warning",
    globalBoilerplateLeaks.length === 0,
    "All other visible generated cards have also been migrated away from evidence-process boilerplate.",
    globalBoilerplateLeaks,
  );

  const failedBlockers = checks.filter((check) => check.level === "blocker" && !check.passed);
  const failedWarnings = checks.filter((check) => check.level === "warning" && !check.passed);
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    auditedAt: new Date().toISOString(),
    mode: "closed-staged-vault/read-only-transaction/selects-only",
    dataDirectory: dataDir,
    baselineDataDirectory: baselineOwnerProtection?.dataDirectory ?? null,
    world: { id: world.id, name: world.name },
    canonEdition: { id: edition.id, name: edition.name },
    passed: failedBlockers.length === 0,
    summary: {
      checks: checks.length,
      passedChecks: checks.filter((check) => check.passed).length,
      failedBlockers: failedBlockers.length,
      failedWarnings: failedWarnings.length,
      entities: entities.length,
      visibleEntities: visibleEntities.length,
      dossiers: dossiers.length,
      structuredRelations: relations.length,
    },
    failedBlockerIds: failedBlockers.map((check) => check.id),
    failedWarningIds: failedWarnings.map((check) => check.id),
    checks,
  };
}

const USAGE =
  "Usage: auditRootFixProof <closed-staged-data-dir> <world-id> " +
  "[--baseline <closed-pre-replay-data-dir>] [--output <json>] [--pretty]";

export function parseAuditCliArguments(args: string[]): AuditCliOptions {
  const [dataDirArgument, worldId, ...flags] = args;
  if (!dataDirArgument || !worldId) throw new Error(USAGE);
  let baselineArgument: string | null = null;
  let outputArgument: string | null = null;
  let pretty = false;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === "--pretty") {
      if (pretty) throw new Error("--pretty may only be supplied once.");
      pretty = true;
      continue;
    }
    if (flag === "--baseline" || flag === "--output") {
      const value = flags[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path.\n${USAGE}`);
      if (flag === "--baseline") {
        if (baselineArgument) throw new Error("--baseline may only be supplied once.");
        baselineArgument = value;
      } else {
        if (outputArgument) throw new Error("--output may only be supplied once.");
        outputArgument = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${flag ?? ""}\n${USAGE}`);
  }
  return { dataDirArgument, worldId, baselineArgument, outputArgument, pretty };
}

function pathIsSameOrInside(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function writeJsonAtomically(
  outputPath: string,
  value: unknown,
  pretty: boolean,
): Promise<void> {
  const parent = path.dirname(outputPath);
  await mkdir(parent, { recursive: true });
  const temporaryPath = path.join(
    parent,
    `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(jsonSafe(value), null, pretty ? 2 : 0)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function runAuditCli(args: string[]): Promise<void> {
  const options = parseAuditCliArguments(args);
  if (!UUID_PATTERN.test(options.worldId)) throw new Error(`Invalid world UUID: ${options.worldId}`);
  const dataDir = path.resolve(options.dataDirArgument);
  const baselineDataDir = options.baselineArgument ? path.resolve(options.baselineArgument) : null;
  const outputPath = options.outputArgument ? path.resolve(options.outputArgument) : null;
  if (baselineDataDir && pathIsSameOrInside(baselineDataDir, dataDir) && pathIsSameOrInside(dataDir, baselineDataDir)) {
    throw new Error("--baseline must identify a separate pre-replay database directory.");
  }
  if (outputPath && pathIsSameOrInside(outputPath, dataDir)) {
    throw new Error("--output must be outside the audited database directory.");
  }
  if (outputPath && baselineDataDir && pathIsSameOrInside(outputPath, baselineDataDir)) {
    throw new Error("--output must be outside the baseline database directory.");
  }

  const baselineOwnerProtection = baselineDataDir
    ? {
        dataDirectory: baselineDataDir,
        snapshot: await ownerProtectionSnapshotFromClosedDatabase(baselineDataDir, options.worldId),
      }
    : undefined;
  const result = await withReadOnlyPglite(
    dataDir,
    (db) => audit(db, options.worldId, dataDir, baselineOwnerProtection),
  );
  if (outputPath) {
    await writeJsonAtomically(outputPath, result, options.pretty);
    process.stdout.write(`${JSON.stringify({
      schemaVersion: AUDIT_SCHEMA_VERSION,
      passed: result.passed,
      output: outputPath,
      summary: result.summary,
      failedBlockerIds: result.failedBlockerIds,
      failedWarningIds: result.failedWarningIds,
    })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(jsonSafe(result), null, options.pretty ? 2 : 0)}\n`);
  }
  if (!result.passed) process.exitCode = 2;
}

function reportFatalError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({
    schemaVersion: AUDIT_SCHEMA_VERSION,
    passed: false,
    fatalError: message,
  })}\n`);
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  runAuditCli(process.argv.slice(2)).catch(reportFatalError);
}
