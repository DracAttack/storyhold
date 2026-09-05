import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { WorldReferenceIssue } from "./worldKnowledge";
import { ENTITY_PROSE_FIELDS, type EntityProseField } from "./entityProseVerification";

type QualityDb = Pick<PGlite, "query">;

export type WorldQualitySeverity = "info" | "warning" | "critical";

export type WorldQualityFinding = {
  category:
    | "coverage"
    | "evidence"
    | "character"
    | "chronology"
    | "relationship"
    | "contradiction";
  severity: WorldQualitySeverity;
  subjectKind: string;
  subjectId: string | null;
  label: string;
  explanation: string;
  recommendedTask: string;
  metadata?: Record<string, unknown>;
};

export const worldQualitySchemaSql = String.raw`
  CREATE TABLE IF NOT EXISTS storyhold.world_quality_findings (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    source_analysis_run_id uuid REFERENCES storyhold.world_analysis_runs(id) ON DELETE SET NULL,
    fingerprint text NOT NULL,
    category text NOT NULL CHECK (category IN
      ('coverage', 'evidence', 'character', 'chronology', 'relationship', 'contradiction')),
    severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    subject_kind text NOT NULL,
    subject_id uuid,
    label text NOT NULL,
    explanation text NOT NULL,
    recommended_task text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    finding_status text NOT NULL DEFAULT 'open' CHECK (finding_status IN
      ('open', 'resolved', 'ignored')),
    first_detected_at timestamptz NOT NULL DEFAULT now(),
    last_detected_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    UNIQUE (world_id, canon_edition_id, fingerprint)
  );

  CREATE INDEX IF NOT EXISTS world_quality_findings_open
    ON storyhold.world_quality_findings
      (world_id, canon_edition_id, finding_status, severity, category);
`;

function fingerprint(finding: WorldQualityFinding): string {
  return createHash("sha256")
    .update(
      [
        finding.category,
        finding.subjectKind,
        finding.subjectId ?? "",
        finding.label.trim().toLocaleLowerCase(),
      ].join("\n"),
    )
    .digest("hex");
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function hasTraceableEvidence(value: unknown): boolean {
  return list(value).some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const evidence = entry as Record<string, unknown>;
    return (
      typeof evidence.chunkId === "string" && evidence.chunkId.length > 0 &&
      typeof evidence.sourceId === "string" && evidence.sourceId.length > 0 &&
      typeof evidence.quote === "string" && evidence.quote.trim().length > 0
    );
  });
}

function profile(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizedReferenceLabel(value: unknown): string {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function canonicalClaimValueKey(input: {
  objectEntityId?: unknown;
  objectText?: unknown;
  labelEntityIds: ReadonlyMap<string, ReadonlySet<string>>;
}): string {
  const entityId = String(input.objectEntityId ?? "").trim();
  if (entityId) return `entity:${entityId}`;
  const label = normalizedReferenceLabel(input.objectText);
  const matches = input.labelEntityIds.get(label);
  if (matches?.size === 1) return `entity:${[...matches][0]}`;
  return `text:${label}`;
}

const DOSSIER_FIELD_LABELS: Record<EntityProseField, string> = {
  aliases: "Names", summary: "Summary", details: "Details", role: "Role", traits: "Traits", motivations: "Motivations",
  fears: "Fears", capabilities: "Capabilities", history: "History", origins: "Origins", powers: "Powers",
  moralSystem: "Moral Outlook", physicalCharacteristics: "Physical Description", knowledge: "Knowledge", secrets: "Secrets",
};
function dossierClaimField(predicate: unknown): EntityProseField | undefined {
  const value = normalizedReferenceLabel(predicate);
  return ENTITY_PROSE_FIELDS.find((field) => value === `dossier.${field.toLocaleLowerCase()}`);
}

/** A dossier field is a collection of separately reviewed statements, not one
 * scalar value. Only affirmation and denial of the SAME statement, viewpoint
 * and interval conflict. Preserve the older scalar rules for other predicates. */
export function claimContradictionFindings(claims: ReadonlyArray<Record<string, unknown>>,
  labelEntityIds: ReadonlyMap<string, ReadonlySet<string>>): WorldQualityFinding[] {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const claim of claims) {
    const field = dossierClaimField(claim.predicate);
    if (!field && !["fact", "belief"].includes(String(claim.truth_status))) continue;
    if (field && (!["fact", "belief", "rumor", "lie", "disputed", "unknown"].includes(String(claim.truth_status))
      || !["positive", "negative"].includes(String(claim.polarity)))) continue;
    const scope = [claim.subject_entity_id, field ? `dossier.${field}` : claim.predicate,
      claim.epistemic_holder_entity_id ?? "", claim.valid_from_label ?? "", claim.valid_until_label ?? ""];
    // Do not resolve two distinct alias strings into one object here: aliases
    // are separately asserted names, even if they resolve to the same record.
    const key = field ? JSON.stringify(["dossier", ...scope, claim.truth_status, normalizedReferenceLabel(claim.object_text)]) : scope.join(":");
    const group = groups.get(key) ?? []; group.push(claim); groups.set(key, group);
  }
  const findings: WorldQualityFinding[] = [];
  for (const group of groups.values()) {
    const first = group[0]!; const field = dossierClaimField(first.predicate);
    const subject = String(first.subject_name ?? "This subject");
    if (field) {
      if (new Set(group.map((claim) => claim.polarity)).size < 2) continue;
      const statement = String(first.object_text ?? "").trim();
      const holder = String(first.epistemic_holder_name ?? "").trim();
      const interval = first.valid_from_label && first.valid_until_label
        ? `from ${String(first.valid_from_label)} until ${String(first.valid_until_label)}`
        : first.valid_from_label ? `from ${String(first.valid_from_label)}`
        : first.valid_until_label ? `until ${String(first.valid_until_label)}` : "the same time period";
      findings.push({ category: "contradiction", severity: "warning", subjectKind: "claim", subjectId: String(first.subject_entity_id),
        label: `${subject}: conflicting ${DOSSIER_FIELD_LABELS[field]} statement — “${statement.slice(0, 140)}”`,
        explanation: `“${statement}” is both affirmed and denied ${holder ? `in ${holder}'s account` : "within the same account"}, ${interval}. Both entries carry the same ${String(first.truth_status)} status; different sentences in this field are not being treated as contradictions.`,
        recommendedTask: "Open the cited statements and clarify which interpretation, viewpoint or time period is intended.",
        metadata: { claimIds: group.map((claim) => claim.id), subject, field, statement, polarities: ["positive", "negative"],
          truthStatus: first.truth_status, epistemicHolder: holder, validFromLabel: first.valid_from_label ?? "", validUntilLabel: first.valid_until_label ?? "" } });
      continue;
    }
    const values = new Set(group.map((claim) => canonicalClaimValueKey({ objectEntityId: claim.object_entity_id,
      objectText: claim.object_text, labelEntityIds })));
    if (values.size <= 1) continue;
    const predicate = String(first.predicate ?? "has conflicting values");
    const descriptions = group.map((claim) => {
      const value = String(claim.object_name ?? claim.object_text ?? claim.object_entity_id ?? "(blank)").trim();
      const holder = String(claim.epistemic_holder_name ?? "").trim();
      const scope = holder ? ` according to ${holder}` : " in objective canon";
      return `“${value || "(blank)"}”${scope}`;
    });
    findings.push({ category: "contradiction", severity: "warning", subjectKind: "claim", subjectId: String(first.subject_entity_id),
      label: `${subject}: conflicting “${predicate}” claims`,
      explanation: `${subject} is recorded as ${descriptions.join(" and ")}. These statements currently occupy the same time and belief scope, so Storyhold cannot tell whether this is a change, a competing belief, or an extraction mistake.`,
      recommendedTask: "Open the cited claims, choose the intended meaning, or guide the next review with the corrected time, viewpoint, or identity.",
      metadata: { claimIds: group.map((claim) => claim.id), subject, predicate, values: descriptions } });
  }
  return findings;
}

export function characterCompletenessFindings(input: {
  id: string;
  name: string;
  mentionCount: number;
  profile: unknown;
}): WorldQualityFinding[] {
  // A minor named character is allowed to remain minor. Quality warnings are
  // useful only when a recurring character is missing several consequential
  // dimensions, not whenever flavor text lacks a complete biography.
  if (input.mentionCount < 40) return [];
  const value = profile(input.profile);
  const missing: string[] = [];
  if (list(value.history).length === 0) missing.push("history");
  if (list(value.relationships).length === 0 && list(value.relationshipWeb).length === 0)
    missing.push("relationships");
  if (list(value.motivations).length === 0) missing.push("motivations");
  if (list(value.physicalCharacteristics).length === 0)
    missing.push("physical description");
  if (input.mentionCount >= 40 && list(value.knowledge).length === 0)
    missing.push("knowledge and beliefs");
  if (missing.length < 3) return [];
  return [{
    category: "character",
    severity: input.mentionCount >= 100 || missing.length >= 4 ? "warning" : "info",
    subjectKind: "character",
    subjectId: input.id,
    label: `${input.name} has an incomplete dossier`,
    explanation: `${input.name} appears ${input.mentionCount.toLocaleString()} times, but Storyhold has not grounded ${missing.join(", ")}.`,
    recommendedTask: "Run a guided character review for these specific gaps, or dismiss this notice if the character is intentionally minor.",
    metadata: { mentionCount: input.mentionCount, missingFields: missing },
  }];
}

function referenceRole(kind: WorldReferenceIssue["kind"]): string {
  switch (kind) {
    case "claim_subject": return "a claim subject";
    case "claim_object": return "a claim object";
    case "claim_epistemic_holder": return "a belief or knowledge holder";
    case "event_participant": return "a world-clock participant";
    case "event_relation_target": return "a connected world-clock event";
    case "relation_subject": return "a relationship source";
    case "relation_target": return "a relationship target";
    case "faction_membership": return "a faction membership";
    case "entity_rule": return "an entity-rule owner";
  }
}

export function referenceResolutionFindings(
  issues: WorldReferenceIssue[],
): WorldQualityFinding[] {
  const grouped = new Map<string, {
    issue: WorldReferenceIssue;
    contexts: Set<string>;
    occurrences: number;
  }>();
  for (const issue of issues) {
    const label = issue.label.replace(/\s+/g, " ").trim().slice(0, 240);
    if (!label) continue;
    const key = [issue.kind, issue.resolution, label.toLocaleLowerCase()].join("\n");
    const current = grouped.get(key) ?? {
      issue: { ...issue, label },
      contexts: new Set<string>(),
      occurrences: 0,
    };
    const context = issue.context.replace(/\s+/g, " ").trim().slice(0, 1_000);
    if (context && current.contexts.size < 12) current.contexts.add(context);
    current.occurrences += 1;
    grouped.set(key, current);
  }
  return [...grouped.values()].map(({ issue, contexts, occurrences }) => {
    const category: WorldQualityFinding["category"] =
      issue.kind === "event_participant" || issue.kind === "event_relation_target"
        ? "chronology"
        : issue.kind.startsWith("relation_") || issue.kind === "faction_membership"
          ? "relationship"
          : "evidence";
    const role = referenceRole(issue.kind);
    const reason = issue.resolution === "ambiguous"
      ? "matches more than one active canonical card"
      : "does not match an active canonical card or alias";
    return {
      category,
      severity: "warning",
      subjectKind: "unresolved_reference",
      subjectId: null,
      label: `${issue.label} could not be linked as ${role}`,
      explanation:
        `The label ${reason}. Storyhold kept the source statement but did not guess a canonical ID.`,
      recommendedTask:
        "Merge or rename the intended card, add a unique alias, or revise the extracted reference before relying on this link.",
      metadata: {
        kind: issue.kind,
        resolution: issue.resolution,
        occurrences,
        contexts: [...contexts],
        ...(issue.metadata ?? {}),
      },
    };
  });
}

export async function collectWorldQualityFindings(params: {
  db: QualityDb;
  worldId: string;
  editionId: string;
}): Promise<WorldQualityFinding[]> {
  const [
    sources,
    chapters,
    events,
    entities,
    dossiers,
    relations,
    claims,
    ambiguousMentions,
    latestReferenceRun,
  ] =
    await Promise.all([
      params.db.query<Record<string, unknown>>(
        `SELECT id, title, chunk_count, ai_review_status, ai_reviewed_chunk_count,
                extraction_quality_severity, extraction_diagnostics
           FROM storyhold.world_sources
          WHERE world_id = $1 AND canon_edition_id = $2
            AND processing_status = 'ready' AND canon_status IN ('candidate', 'canon')`,
        [params.worldId, params.editionId],
      ),
      params.db.query<Record<string, unknown>>(
        `SELECT id, chapter_title, summary, major_events, evidence
           FROM storyhold.world_chapter_summaries
          WHERE world_id = $1 AND canon_edition_id = $2`,
        [params.worldId, params.editionId],
      ),
      params.db.query<Record<string, unknown>>(
        `SELECT id, title, evidence, source_chapter_keys
           FROM storyhold.world_clock_events
          WHERE world_id = $1 AND canon_edition_id = $2
            AND campaign_id IS NULL AND event_kind = 'canon'`,
        [params.worldId, params.editionId],
      ),
      params.db.query<Record<string, unknown>>(
        `SELECT id, name, aliases, entity_type, evidence, mention_count
           FROM storyhold.world_entities
          WHERE world_id = $1 AND canon_edition_id = $2
            AND pull_status = 'active' AND scanner_present = true`,
        [params.worldId, params.editionId],
      ),
      params.db.query<Record<string, unknown>>(
        `SELECT dossier.id, dossier.name, dossier.mention_count, dossier.profile
           FROM storyhold.character_dossiers dossier
          WHERE dossier.world_id = $1 AND dossier.canon_edition_id = $2
            AND dossier.dossier_status = 'active'
            AND EXISTS (
              SELECT 1
                FROM storyhold.world_entities entity
               WHERE entity.dossier_id = dossier.id
                 AND entity.world_id = dossier.world_id
                 AND entity.canon_edition_id = dossier.canon_edition_id
                 AND entity.entity_type = 'character'
                 AND entity.pull_status = 'active'
                 AND entity.scanner_present = true
            )`,
        [params.worldId, params.editionId],
      ),
      params.db.query<Record<string, unknown>>(
        `SELECT id, summary, evidence, assignment_source
           FROM storyhold.world_entity_relations
          WHERE world_id = $1 AND canon_edition_id = $2`,
        [params.worldId, params.editionId],
      ),
      params.db.query<Record<string, unknown>>(
        `SELECT claim.id, claim.subject_entity_id, claim.predicate, claim.polarity,
                claim.object_entity_id, claim.object_text,
                claim.epistemic_holder_entity_id, claim.truth_status,
                claim.valid_from_label, claim.valid_until_label, claim.evidence,
                subject.name AS subject_name, object_entity.name AS object_name,
                holder.name AS epistemic_holder_name
           FROM storyhold.world_knowledge_claims claim
           LEFT JOIN storyhold.world_entities subject ON subject.id = claim.subject_entity_id
           LEFT JOIN storyhold.world_entities object_entity ON object_entity.id = claim.object_entity_id
           LEFT JOIN storyhold.world_entities holder ON holder.id = claim.epistemic_holder_entity_id
          WHERE claim.world_id = $1 AND claim.canon_edition_id = $2
            AND claim.claim_status IN ('active', 'disputed')`,
        [params.worldId, params.editionId],
      ),
      params.db.query<Record<string, unknown>>(
        `SELECT normalized_surface, min(surface_form) AS surface_form,
                count(*)::int AS mention_count,
                count(DISTINCT source_id)::int AS source_count
           FROM storyhold.world_entity_mentions
          WHERE world_id = $1 AND canon_edition_id = $2
            AND resolution_status = 'ambiguous'
          GROUP BY normalized_surface
          ORDER BY count(*) DESC
          LIMIT 500`,
        [params.worldId, params.editionId],
      ),
      params.db.query<Record<string, unknown>>(
        `SELECT id, unresolved_reference_count, unresolved_references
           FROM storyhold.world_analysis_runs
          WHERE world_id = $1 AND canon_edition_id = $2
          ORDER BY created_at DESC
          LIMIT 1`,
        [params.worldId, params.editionId],
      ),
    ]);
  const findings: WorldQualityFinding[] = [];
  const labelEntityIds = new Map<string, Set<string>>();
  for (const entity of entities.rows) {
    const entityId = String(entity.id ?? "").trim();
    if (!entityId) continue;
    for (const label of [entity.name, ...list(entity.aliases)]) {
      const normalized = normalizedReferenceLabel(label);
      if (!normalized) continue;
      const ids = labelEntityIds.get(normalized) ?? new Set<string>();
      ids.add(entityId);
      labelEntityIds.set(normalized, ids);
    }
  }
  const referenceIssues = list(
    latestReferenceRun.rows[0]?.unresolved_references,
  ).filter((value): value is WorldReferenceIssue => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const issue = value as Record<string, unknown>;
    return (
      typeof issue.kind === "string" &&
      typeof issue.label === "string" &&
      typeof issue.context === "string" &&
      ["missing", "ambiguous"].includes(String(issue.resolution))
    );
  });
  findings.push(...referenceResolutionFindings(referenceIssues));
  for (const source of sources.rows) {
    const total = Number(source.chunk_count ?? 0);
    const reviewed = Number(source.ai_reviewed_chunk_count ?? 0);
    if (source.ai_review_status === "reviewed" && reviewed < total) {
      findings.push({
        category: "coverage",
        severity: "critical",
        subjectKind: "source",
        subjectId: String(source.id),
        label: `${String(source.title)} is marked reviewed before coverage is complete`,
        explanation: `${reviewed.toLocaleString()} of ${total.toLocaleString()} chunks have recorded AI coverage.`,
        recommendedTask: "Resume the missing source chunks and keep the source in a partial state until coverage is durable.",
        metadata: { reviewedChunks: reviewed, totalChunks: total },
      });
    }
    const extractionSeverity = String(source.extraction_quality_severity ?? "ok");
    if (extractionSeverity === "warning" || extractionSeverity === "critical") {
      const diagnostics = profile(source.extraction_diagnostics);
      const messages = list(diagnostics.messages).filter(
        (message): message is string => typeof message === "string",
      );
      findings.push({
        category: "coverage",
        severity: extractionSeverity === "critical" ? "critical" : "warning",
        subjectKind: "source",
        subjectId: String(source.id),
        label: `${String(source.title)} may need a cleaner text extraction`,
        explanation:
          messages.join(" ") ||
          "Storyhold detected formatting or text-quality problems in this source.",
        recommendedTask:
          "Inspect the extracted chapter map and replace the file with a text-based DOCX, EPUB, or OCR-clean PDF if passages are missing or scrambled.",
        metadata: { diagnostics },
      });
    }
  }
  for (const chapter of chapters.rows) {
    const missing: string[] = [];
    if (!String(chapter.summary ?? "").trim()) missing.push("summary");
    if (list(chapter.major_events).length === 0) missing.push("major events");
    if (!hasTraceableEvidence(chapter.evidence)) missing.push("evidence");
    if (!missing.length) continue;
    findings.push({
      category: "coverage",
      severity: missing.includes("evidence") ? "warning" : "info",
      subjectKind: "chapter",
      subjectId: String(chapter.id),
      label: `${String(chapter.chapter_title)} needs a fuller chapter map`,
      explanation: `The chapter is missing ${missing.join(", ")}.`,
      recommendedTask: "Revisit this chapter before global chronology synthesis.",
      metadata: { missingFields: missing },
    });
  }
  for (const event of events.rows) {
    if (hasTraceableEvidence(event.evidence)) continue;
    findings.push({
      category: "chronology",
      severity: "warning",
      subjectKind: "event",
      subjectId: String(event.id),
      label: `${String(event.title)} has no direct source evidence`,
      explanation: "The event appears on the canonical world clock but cannot be traced to a verified passage.",
      recommendedTask: "Retrieve the linked chapters and attach exact evidence before using this event as canon.",
      metadata: { sourceChapterKeys: list(event.source_chapter_keys) },
    });
  }
  for (const entity of entities.rows) {
    if (hasTraceableEvidence(entity.evidence)) continue;
    findings.push({
      category: "evidence",
      severity: Number(entity.mention_count ?? 0) >= 12 ? "warning" : "info",
      subjectKind: String(entity.entity_type),
      subjectId: String(entity.id),
      label: `${String(entity.name)} has no verified evidence`,
      explanation: "The active Storyhold card has no source passage attached.",
      recommendedTask: "Run a targeted evidence review or move the card back to candidate status.",
    });
  }
  for (const dossier of dossiers.rows) {
    findings.push(...characterCompletenessFindings({
      id: String(dossier.id),
      name: String(dossier.name),
      mentionCount: Number(dossier.mention_count ?? 0),
      profile: dossier.profile,
    }));
  }
  for (const relation of relations.rows) {
    // An owner's explicit relationship assignment is itself a canonical
    // decision. It may intentionally have no manuscript citation, and the AI
    // must not nag the owner to prove or undo their own canon.
    if (relation.assignment_source === "user") continue;
    if (hasTraceableEvidence(relation.evidence)) continue;
    findings.push({
      category: "relationship",
      severity: "warning",
      subjectKind: "relationship",
      subjectId: String(relation.id),
      label: "A relationship has no verified evidence",
      explanation: String(relation.summary ?? "The relationship is not independently traceable."),
      recommendedTask: "Retrieve a passage that establishes both endpoints or return the relationship to candidate status.",
    });
  }
  for (const claim of claims.rows) {
    if (!hasTraceableEvidence(claim.evidence)) {
      findings.push({
        category: "evidence",
        severity: "warning",
        subjectKind: "claim",
        subjectId: String(claim.id),
        label: `A ${String(claim.truth_status)} claim has no verified passage`,
        explanation: `${dossierClaimField(claim.predicate) ? DOSSIER_FIELD_LABELS[dossierClaimField(claim.predicate)!] : String(claim.predicate)}: ${String(claim.object_text ?? "")}`,
        recommendedTask:
          "Revisit the source passage before using this claim as current character knowledge or objective canon.",
      });
    }
  }
  findings.push(...claimContradictionFindings(claims.rows, labelEntityIds));
  for (const mention of ambiguousMentions.rows) {
    // Generic scene referents are expected to resolve differently from one
    // chapter to another. They remain unresolved internally, but presenting
    // "the town" as a canon contradiction is noisy and not actionable.
    if (genericSceneReferenceSurface(mention.normalized_surface)) continue;
    findings.push({
      category: "contradiction",
      severity: Number(mention.mention_count ?? 0) >= 8 ? "warning" : "info",
      subjectKind: "identity",
      subjectId: null,
      label: `${String(mention.surface_form)} refers to more than one possible card`,
      explanation: `${Number(mention.mention_count ?? 0).toLocaleString()} passages across ${Number(mention.source_count ?? 0).toLocaleString()} sources use this shared name or alias. Storyhold left those mentions unassigned rather than mixing the identities.`,
      recommendedTask:
        "Review the involved cards and add a source-grounded disambiguating name or merge them if they are truly the same entity.",
      metadata: {
        normalizedSurface: mention.normalized_surface,
        mentionCount: Number(mention.mention_count ?? 0),
        sourceCount: Number(mention.source_count ?? 0),
      },
    });
  }
  return findings;
}

export function genericSceneReferenceSurface(value: unknown): boolean {
  return new Set([
    "the town",
    "the camp",
    "the settlement",
    "the community",
    "the colony",
    "the group",
    "the party",
    "the team",
  ]).has(normalizedReferenceLabel(value));
}

export async function upsertWorldQualityFinding(params: {
  db: QualityDb;
  worldId: string;
  editionId: string;
  runId?: string | null;
  finding: WorldQualityFinding;
}): Promise<string> {
  const key = fingerprint(params.finding);
  await params.db.query(
    `INSERT INTO storyhold.world_quality_findings
      (id, world_id, canon_edition_id, source_analysis_run_id, fingerprint,
       category, severity, subject_kind, subject_id, label, explanation,
       recommended_task, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
     ON CONFLICT (world_id, canon_edition_id, fingerprint) DO UPDATE SET
       source_analysis_run_id = COALESCE(EXCLUDED.source_analysis_run_id,
                                         storyhold.world_quality_findings.source_analysis_run_id),
       severity = EXCLUDED.severity,
       explanation = EXCLUDED.explanation,
       recommended_task = EXCLUDED.recommended_task,
       metadata = EXCLUDED.metadata,
       finding_status = CASE
         WHEN storyhold.world_quality_findings.finding_status = 'ignored'
         THEN 'ignored' ELSE 'open' END,
       resolved_at = CASE
         WHEN storyhold.world_quality_findings.finding_status = 'ignored'
         THEN storyhold.world_quality_findings.resolved_at ELSE NULL END,
       last_detected_at = now()`,
    [
      randomUUID(),
      params.worldId,
      params.editionId,
      params.runId ?? null,
      key,
      params.finding.category,
      params.finding.severity,
      params.finding.subjectKind,
      params.finding.subjectId,
      params.finding.label,
      params.finding.explanation,
      params.finding.recommendedTask,
      JSON.stringify(params.finding.metadata ?? {}),
    ],
  );
  return key;
}

export async function refreshWorldQualityFindings(params: {
  db: QualityDb;
  worldId: string;
  editionId: string;
  runId?: string | null;
}): Promise<{ open: number; critical: number; warning: number }> {
  const findings = await collectWorldQualityFindings(params);
  const activeFingerprints: string[] = [];
  for (const finding of findings) {
    activeFingerprints.push(await upsertWorldQualityFinding({
      ...params,
      finding,
    }));
  }
  if (activeFingerprints.length) {
    await params.db.query(
      `UPDATE storyhold.world_quality_findings
          SET finding_status = 'resolved', resolved_at = now(), last_detected_at = now()
        WHERE world_id = $1 AND canon_edition_id = $2
          AND finding_status = 'open' AND NOT (fingerprint = ANY($3::text[]))`,
      [params.worldId, params.editionId, activeFingerprints],
    );
  } else {
    await params.db.query(
      `UPDATE storyhold.world_quality_findings
          SET finding_status = 'resolved', resolved_at = now(), last_detected_at = now()
        WHERE world_id = $1 AND canon_edition_id = $2 AND finding_status = 'open'`,
      [params.worldId, params.editionId],
    );
  }
  return {
    open: findings.length,
    critical: findings.filter((finding) => finding.severity === "critical").length,
    warning: findings.filter((finding) => finding.severity === "warning").length,
  };
}
