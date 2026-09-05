import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

type EntityType =
  | "character"
  | "creature"
  | "species"
  | "place"
  | "faction"
  | "institution"
  | "government"
  | "power_structure"
  | "technology"
  | "vehicle"
  | "device"
  | "weapon"
  | "power"
  | "title"
  | "ambiguous";

type Evidence = {
  source: string;
  page?: number;
  note: string;
};

type EnrichmentEntity = {
  name: string;
  type: EntityType;
  aliases?: string[];
  summary: string;
  details?: string[];
  evidence?: Evidence[];
  confidence?: number;
  mentionCount?: number;
  character?: {
    role: string;
    profile?: Record<string, unknown>;
    statPreset?: keyof typeof STAT_PRESETS;
    axis?: Record<string, unknown>;
  };
};

type EnrichmentDocument = {
  world: {
    name?: string;
    description: string;
    genre: string;
  };
  sources?: Array<{
    source: string;
    chronologyOrder: number;
    chronologyRelation: string;
    chronologyLabel: string;
    chronologyNotes: string;
  }>;
  chapterSummaries?: Array<{
    source: string;
    chapterKey: string;
    title: string;
    perspective?: string;
    sourceOrder: number;
    summary: string;
    majorEvents: string[];
    confidence?: number;
  }>;
  canonicalEvents?: Array<{
    key: string;
    title: string;
    summary: string;
    worldTimeLabel: string;
    temporalStatus: "exact" | "relative" | "uncertain" | "parallel";
    importance: "major" | "turning_point";
    sourceChapters: string[];
  }>;
  entities: EnrichmentEntity[];
  merges?: Array<{ source: string; target: string }>;
  relations?: Array<{
    source: string;
    type: string;
    target: string;
    status?: string;
    summary: string;
    validFrom?: string;
    validUntil?: string;
    evidence?: Evidence[];
    confidence?: number;
  }>;
  rules?: Array<{
    entity: string;
    name: string;
    kind: string;
    description: string;
    trigger?: string;
    effect?: string;
    evidence?: Evidence[];
    confidence?: number;
  }>;
  breakdown: {
    summary: string;
    genres: string[];
    atmosphere: string[];
    themes: string[];
    worldRules: string[];
    chronology: string[];
    openQuestions: string[];
    recurringTerms: string[];
  };
  suppressUnlistedLocalCandidates?: boolean;
};

const STAT_PRESETS = {
  civilian: [9, 10, 10, 10, 10, 10, 9],
  child: [6, 11, 8, 9, 9, 10, 11],
  survivor: [11, 12, 12, 10, 12, 10, 11],
  leader: [11, 11, 12, 12, 13, 14, 10],
  technician: [9, 11, 10, 15, 13, 10, 10],
  fighter: [14, 13, 14, 10, 12, 10, 12],
  elite: [16, 15, 16, 12, 14, 13, 14],
  enhanced: [19, 17, 19, 14, 15, 12, 16],
} as const;

const STAT_NAMES = [
  "strength",
  "dexterity",
  "constitution",
  "intelligence",
  "wisdom",
  "charisma",
  "acrobatics",
] as const;

function normalized(value: string) {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function slug(value: string) {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "entity"
  );
}

function json(value: unknown) {
  return JSON.stringify(value ?? null);
}

function boundedConfidence(value: number | undefined, fallback = 0.82) {
  return Math.max(0, Math.min(1, value ?? fallback));
}

function estimatedStats(preset: keyof typeof STAT_PRESETS = "civilian") {
  const values = STAT_PRESETS[preset];
  return Object.fromEntries(
    STAT_NAMES.map((name, index) => [
      name,
      {
        score: values[index],
        confidence: preset === "civilian" ? 0.35 : 0.58,
        rationale: `Provisional ${preset} estimate based on demonstrated behavior in the imported manuscripts.`,
      },
    ]),
  );
}

const [dataDirArgument, worldId, enrichmentArgument] = process.argv.slice(2);
if (!dataDirArgument || !worldId || !enrichmentArgument) {
  throw new Error(
    "Usage: applyLocalEnrichment <data-dir> <world-id> <enrichment-json>",
  );
}

const dataDir = path.resolve(dataDirArgument);
const enrichment = JSON.parse(
  await readFile(path.resolve(enrichmentArgument), "utf8"),
) as EnrichmentDocument;
const db = await PGlite.create({ dataDir, extensions: { vector } });

try {
  await db.exec("BEGIN");
  const worldResult = await db.query<Record<string, unknown>>(
    `SELECT world.id, world.owner_player_id, edition.id AS edition_id
       FROM storyhold.worlds world
       JOIN storyhold.canon_editions edition ON edition.world_id = world.id
      WHERE world.id = $1
      ORDER BY edition.created_at ASC
      LIMIT 1`,
    [worldId],
  );
  if (worldResult.rows.length !== 1) throw new Error(`World ${worldId} was not found.`);
  const ownerId = String(worldResult.rows[0].owner_player_id);
  const editionId = String(worldResult.rows[0].edition_id);

  const sourceResult = await db.query<Record<string, unknown>>(
    `SELECT id, title, original_filename, content_hash
       FROM storyhold.world_sources
      WHERE world_id = $1 AND canon_edition_id = $2
      ORDER BY chronology_order, sort_order, created_at`,
    [worldId, editionId],
  );
  const sourceByKey = new Map<string, Record<string, unknown>>();
  sourceResult.rows.forEach((row, index) => {
    sourceByKey.set(index === 0 ? "B1" : "B2", row);
    sourceByKey.set(normalized(String(row.title)), row);
    sourceByKey.set(normalized(String(row.original_filename)), row);
  });
  const evidence = (entries: Evidence[] | undefined) =>
    (entries ?? []).map((entry) => {
      const source = sourceByKey.get(entry.source) ?? sourceByKey.get(normalized(entry.source));
      return {
        sourceId: source?.id ?? "",
        chunkId: `manual:${source?.id ?? normalized(entry.source)}:p${entry.page ?? "na"}`,
        quote: entry.note,
        sourceTitle: source?.title ?? entry.source,
        page: entry.page ?? null,
        note: entry.note,
      };
    });

  const runId = randomUUID();
  await db.query(
    `INSERT INTO storyhold.world_analysis_runs
      (id, world_id, canon_edition_id, requested_by_player_id, provider, model,
       status, stage, progress, source_count, chunk_count, started_at,
       completed_at, analysis_kind, trigger_kind, incremental,
       analysis_version, input_fingerprint, source_ids, review_source_ids)
     VALUES ($1, $2, $3, $4, 'codex', 'gpt-5', 'completed',
             'Codex manuscript enrichment completed', 100, $5, 0, now(), now(),
             'ai_enrichment', 'manual', false, 1, 'manual-codex-review',
             $6::jsonb, $6::jsonb)`,
    [
      runId,
      worldId,
      editionId,
      ownerId,
      sourceResult.rows.length,
      json(sourceResult.rows.map((row) => row.id)),
    ],
  );

  const entityIds = new Map<string, string>();
  for (const entity of enrichment.entities) {
    const key = normalized(entity.name);
    const existing = await db.query<Record<string, unknown>>(
      `SELECT id, dossier_id, review_status
         FROM storyhold.world_entities
        WHERE world_id = $1 AND canon_edition_id = $2 AND normalized_name = $3
        LIMIT 1`,
      [worldId, editionId, key],
    );
    const id = existing.rows.length ? String(existing.rows[0].id) : randomUUID();
    const aliases = [...new Set((entity.aliases ?? []).map((alias) => alias.trim()).filter(Boolean))];
    const reviewStatus = existing.rows[0]?.review_status === "user_confirmed"
      ? "user_confirmed"
      : "verified";
    await db.query(
      `INSERT INTO storyhold.world_entities
        (id, world_id, canon_edition_id, source_analysis_run_id, canonical_key,
         normalized_name, name, entity_type, aliases, summary, details,
         relationships, evidence, mention_count, mention_source_count,
         confidence, classification_source, review_status, pull_status,
         scanner_present)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb,
               '[]'::jsonb, $12::jsonb, $13, $14, $15, 'ai', $16, 'active', true)
       ON CONFLICT (world_id, canon_edition_id, normalized_name) DO UPDATE
         SET source_analysis_run_id = EXCLUDED.source_analysis_run_id,
             name = EXCLUDED.name,
             entity_type = EXCLUDED.entity_type,
             aliases = EXCLUDED.aliases,
             summary = EXCLUDED.summary,
             details = EXCLUDED.details,
             evidence = EXCLUDED.evidence,
             mention_count = GREATEST(storyhold.world_entities.mention_count,
                                      EXCLUDED.mention_count),
             mention_source_count = GREATEST(storyhold.world_entities.mention_source_count,
                                             EXCLUDED.mention_source_count),
             confidence = EXCLUDED.confidence,
             classification_source = EXCLUDED.classification_source,
             review_status = $16,
             pull_status = 'active', scanner_present = true, updated_at = now()`,
      [
        id,
        worldId,
        editionId,
        runId,
        `codex-${slug(entity.name)}-${id.slice(0, 8)}`,
        key,
        entity.name,
        entity.type,
        json(aliases),
        entity.summary,
        json(entity.details ?? []),
        json(evidence(entity.evidence)),
        Math.max(0, Math.round(entity.mentionCount ?? 0)),
        entity.evidence?.length ? new Set(entity.evidence.map((item) => item.source)).size : 0,
        boundedConfidence(entity.confidence),
        reviewStatus,
      ],
    );
    entityIds.set(key, id);

    if (entity.type !== "character" || !entity.character) continue;
    const profile = {
      traits: [], motivations: [], fears: [], capabilities: [], history: [],
      origins: [], powers: [], moralSystem: [], physicalCharacteristics: [],
      relationships: [], relationshipWeb: [], knowledge: [], secrets: [],
      ...(entity.character.profile ?? {}),
      estimatedStats: {
        ...estimatedStats(entity.character.statPreset),
        ...((entity.character.profile?.estimatedStats as Record<string, unknown> | undefined) ?? {}),
      },
    };
    const dossierResult = await db.query<Record<string, unknown>>(
      `SELECT id FROM storyhold.character_dossiers
        WHERE world_id = $1 AND canon_edition_id = $2 AND normalized_name = $3
        LIMIT 1`,
      [worldId, editionId, key],
    );
    const dossierId = dossierResult.rows.length
      ? String(dossierResult.rows[0].id)
      : randomUUID();
    await db.query(
      `INSERT INTO storyhold.character_dossiers
        (id, world_id, canon_edition_id, source_analysis_run_id, canonical_key,
         normalized_name, name, aliases, role, summary, profile, evidence,
         confidence, dossier_status, axis_estimate, mention_count,
         mention_source_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb,
               $12::jsonb, $13, 'active', $14::jsonb, $15, $16)
       ON CONFLICT (world_id, canon_edition_id, normalized_name) DO UPDATE
         SET source_analysis_run_id = EXCLUDED.source_analysis_run_id,
             name = EXCLUDED.name, aliases = EXCLUDED.aliases,
             role = EXCLUDED.role, summary = EXCLUDED.summary,
             profile = EXCLUDED.profile, evidence = EXCLUDED.evidence,
             confidence = EXCLUDED.confidence, dossier_status = 'active',
             axis_estimate = CASE
               WHEN storyhold.character_dossiers.axis_user_override IS NULL
               THEN EXCLUDED.axis_estimate
               ELSE storyhold.character_dossiers.axis_estimate
             END,
             mention_count = GREATEST(storyhold.character_dossiers.mention_count,
                                      EXCLUDED.mention_count),
             mention_source_count = GREATEST(storyhold.character_dossiers.mention_source_count,
                                             EXCLUDED.mention_source_count),
             updated_at = now()`,
      [
        dossierId,
        worldId,
        editionId,
        runId,
        `codex-character-${slug(entity.name)}-${dossierId.slice(0, 8)}`,
        key,
        entity.name,
        json(aliases),
        entity.character.role,
        entity.summary,
        json(profile),
        json(evidence(entity.evidence)),
        boundedConfidence(entity.confidence),
        json(entity.character.axis ?? {
          economic: 0,
          authority: 0,
          label: "Insufficient evidence",
          rationale: "The manuscripts do not establish a reliable socio-political position.",
          confidence: 0.15,
        }),
        Math.max(0, Math.round(entity.mentionCount ?? 0)),
        entity.evidence?.length ? new Set(entity.evidence.map((item) => item.source)).size : 0,
      ],
    );
    await db.query(
      `UPDATE storyhold.world_entities SET dossier_id = $2, updated_at = now()
        WHERE id = $1`,
      [id, dossierId],
    );
  }

  const getEntityId = async (name: string) => {
    const cached = entityIds.get(normalized(name));
    if (cached) return cached;
    const result = await db.query<Record<string, unknown>>(
      `SELECT id FROM storyhold.world_entities
        WHERE world_id = $1 AND canon_edition_id = $2 AND normalized_name = $3
        LIMIT 1`,
      [worldId, editionId, normalized(name)],
    );
    if (!result.rows.length) throw new Error(`Entity ${name} was not found.`);
    const id = String(result.rows[0].id);
    entityIds.set(normalized(name), id);
    return id;
  };

  for (const merge of enrichment.merges ?? []) {
    const sourceId = await getEntityId(merge.source);
    const targetId = await getEntityId(merge.target);
    const target = enrichment.entities.find((item) => normalized(item.name) === normalized(merge.target));
    const aliases = [...new Set([...(target?.aliases ?? []), merge.source])];
    await db.query(
      `UPDATE storyhold.world_entities
          SET aliases = $2::jsonb, updated_at = now()
        WHERE id = $1`,
      [targetId, json(aliases)],
    );
    await db.query(
      `UPDATE storyhold.world_entities
          SET pull_status = 'merged', scanner_present = false,
              merged_into_entity_id = $2, updated_at = now()
        WHERE id = $1`,
      [sourceId, targetId],
    );
    await db.query(
      `UPDATE storyhold.character_dossiers SET dossier_status = 'suppressed', updated_at = now()
        WHERE id = (SELECT dossier_id FROM storyhold.world_entities WHERE id = $1)`,
      [sourceId],
    );
  }

  for (const relation of enrichment.relations ?? []) {
    const sourceId = await getEntityId(relation.source);
    const targetId = await getEntityId(relation.target);
    await db.query(
      `INSERT INTO storyhold.world_entity_relations
        (id, world_id, canon_edition_id, source_entity_id, relation_type,
         target_entity_id, relation_status, summary, valid_from_label,
         valid_until_label, evidence, assignment_source, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'ai', $12)
       ON CONFLICT (world_id, canon_edition_id, source_entity_id, relation_type,
                    target_entity_id, relation_status, valid_from_label,
                    valid_until_label) DO UPDATE
         SET summary = EXCLUDED.summary, evidence = EXCLUDED.evidence,
             assignment_source = 'ai', confidence = EXCLUDED.confidence,
             updated_at = now()`,
      [
        randomUUID(), worldId, editionId, sourceId, relation.type, targetId,
        relation.status ?? "active", relation.summary, relation.validFrom ?? "",
        relation.validUntil ?? "", json(evidence(relation.evidence)),
        boundedConfidence(relation.confidence, 0.85),
      ],
    );
  }

  for (const rule of enrichment.rules ?? []) {
    const entityId = await getEntityId(rule.entity);
    await db.query(
      `INSERT INTO storyhold.world_entity_rules
        (id, world_id, canon_edition_id, entity_id, canonical_key, name,
         description, rule_kind, trigger_text, effect_text, evidence,
         assignment_source, confidence, rule_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
               'ai', $12, 'active')
       ON CONFLICT (world_id, canon_edition_id, entity_id, canonical_key) DO UPDATE
         SET name = EXCLUDED.name, description = EXCLUDED.description,
             rule_kind = EXCLUDED.rule_kind, trigger_text = EXCLUDED.trigger_text,
             effect_text = EXCLUDED.effect_text, evidence = EXCLUDED.evidence,
             assignment_source = 'ai', confidence = EXCLUDED.confidence,
             rule_status = 'active', updated_at = now()`,
      [
        randomUUID(), worldId, editionId, entityId, slug(rule.name), rule.name,
        rule.description, rule.kind, rule.trigger ?? "", rule.effect ?? "",
        json(evidence(rule.evidence)), boundedConfidence(rule.confidence, 0.82),
      ],
    );
  }

  if (enrichment.suppressUnlistedLocalCandidates) {
    const preserved = enrichment.entities.map((entity) => normalized(entity.name));
    await db.query(
      `UPDATE storyhold.world_entities
          SET pull_status = 'do_not_pull', scanner_present = false, updated_at = now()
        WHERE world_id = $1 AND canon_edition_id = $2
          AND pull_status = 'active'
          AND classification_source = 'local' AND review_status = 'candidate'
          AND normalized_name <> ALL($3::text[])`,
      [worldId, editionId, preserved],
    );
    await db.query(
      `UPDATE storyhold.character_dossiers dossier
          SET dossier_status = 'suppressed', updated_at = now()
        WHERE dossier.id IN (
          SELECT entity.dossier_id FROM storyhold.world_entities entity
           WHERE entity.world_id = $1 AND entity.canon_edition_id = $2
             AND entity.pull_status <> 'active' AND entity.dossier_id IS NOT NULL
        )`,
      [worldId, editionId],
    );
  }

  if (enrichment.sources) {
    for (const sourceUpdate of enrichment.sources) {
      const source = sourceByKey.get(sourceUpdate.source);
      if (!source) throw new Error(`Source ${sourceUpdate.source} was not found.`);
      await db.query(
        `UPDATE storyhold.world_sources
            SET chronology_order = $2, chronology_relation = $3,
                chronology_label = $4, chronology_notes = $5,
                chronology_review_status = 'reviewed', canon_status = 'canon',
                ai_review_status = 'reviewed', ai_reviewed_content_hash = content_hash,
                ai_analysis_version = GREATEST(ai_analysis_version, 1),
                ai_review_provider = 'codex', ai_review_model = 'gpt-5',
                ai_reviewed_at = now()
          WHERE id = $1`,
        [
          source.id, sourceUpdate.chronologyOrder, sourceUpdate.chronologyRelation,
          sourceUpdate.chronologyLabel, sourceUpdate.chronologyNotes,
        ],
      );
    }
  }

  if (enrichment.chapterSummaries) {
    for (const chapter of enrichment.chapterSummaries) {
      const source = sourceByKey.get(chapter.source);
      if (!source) throw new Error(`Source ${chapter.source} was not found for ${chapter.title}.`);
      const canonicalKey = `${source.id}:${chapter.chapterKey}`;
      await db.query(
        `INSERT INTO storyhold.world_chapter_summaries
          (id, world_id, canon_edition_id, source_id, canonical_key, chapter_title,
           perspective, source_order, summary, major_events, evidence, summary_source, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
                 '[]'::jsonb, 'ai', $11)
         ON CONFLICT (world_id, canonical_key) DO UPDATE
           SET chapter_title = EXCLUDED.chapter_title, perspective = EXCLUDED.perspective,
               source_order = EXCLUDED.source_order, summary = EXCLUDED.summary,
               major_events = EXCLUDED.major_events, summary_source = 'ai',
               confidence = EXCLUDED.confidence, updated_at = now()`,
        [randomUUID(), worldId, editionId, source.id, canonicalKey, chapter.title,
         chapter.perspective ?? "", chapter.sourceOrder, chapter.summary,
         json(chapter.majorEvents), boundedConfidence(chapter.confidence, 0.9)],
      );
    }
  }

  if (enrichment.canonicalEvents) {
    // A Codex replay owns only its own legacy `codex-canon-*` snapshot. Older
    // behavior deleted every public event in the world, which could cascade
    // away owner-authored events and receipt-backed premium clock links. Keep
    // omitted legacy rows recoverable in Studio and never touch a verified or
    // player-created record.
    await db.query(
      `UPDATE storyhold.world_clock_events event
          SET visibility = 'studio', knowledge_status = 'inferred'
        WHERE event.world_id = $1 AND event.canon_edition_id = $2
          AND event.campaign_id IS NULL
          AND event.created_by_player_id IS NULL
          AND event.assignment_source = 'local'
          AND event.canonical_key LIKE 'codex-canon-%'
          AND NOT EXISTS (
            SELECT 1 FROM storyhold.world_clock_event_verifications verified
             WHERE verified.event_id = event.id
          )`,
      [worldId, editionId],
    );
    for (let index = 0; index < enrichment.canonicalEvents.length; index += 1) {
      const event = enrichment.canonicalEvents[index]!;
      const chapterKeys = event.sourceChapters.flatMap((reference) => {
        const split = reference.indexOf(":");
        const source = sourceByKey.get(reference.slice(0, split));
        return source ? [`${source.id}:${reference.slice(split + 1)}`] : [];
      });
      const firstSourceKey = event.sourceChapters[0]?.split(":")[0] ?? "";
      const source = sourceByKey.get(firstSourceKey);
      await db.query(
        `INSERT INTO storyhold.world_clock_events
          (id, world_id, canon_edition_id, source_id, canonical_key, event_kind,
           title, summary, world_time_label, chronology_order, temporal_status,
           importance, source_chapter_keys, visibility, knowledge_status, evidence)
       VALUES ($1, $2, $3, $4, $5, 'canon', $6, $7, $8, $9, $10, $11,
                  $12::jsonb, 'world', 'observed', '[]'::jsonb)
         ON CONFLICT (world_id, canonical_key) DO UPDATE
           SET source_id = EXCLUDED.source_id,
               title = EXCLUDED.title,
               summary = EXCLUDED.summary,
               world_time_label = EXCLUDED.world_time_label,
               chronology_order = EXCLUDED.chronology_order,
               temporal_status = EXCLUDED.temporal_status,
               importance = EXCLUDED.importance,
               source_chapter_keys = EXCLUDED.source_chapter_keys,
               visibility = 'world',
               knowledge_status = 'observed'
         WHERE world_clock_events.canon_edition_id = EXCLUDED.canon_edition_id
           AND world_clock_events.campaign_id IS NULL
           AND world_clock_events.created_by_player_id IS NULL
           AND world_clock_events.assignment_source = 'local'
           AND world_clock_events.canonical_key LIKE 'codex-canon-%'
           AND NOT EXISTS (
             SELECT 1 FROM storyhold.world_clock_event_verifications verified
              WHERE verified.event_id = world_clock_events.id
           )`,
        [randomUUID(), worldId, editionId, source?.id ?? null, `codex-canon-${event.key}`,
         event.title, event.summary, event.worldTimeLabel, index * 1_000,
         event.temporalStatus, event.importance, json(chapterKeys)],
      );
    }
  }

  const byType = (type: EntityType) =>
    enrichment.entities.filter((entity) => entity.type === type).map((entity) => ({
      name: entity.name,
      aliases: entity.aliases ?? [],
      summary: entity.summary,
      confidence: boundedConfidence(entity.confidence),
      evidence: evidence(entity.evidence),
      reviewStatus: "verified",
    }));
  const chronology = (enrichment.canonicalEvents ?? []).length
    ? enrichment.canonicalEvents!.map((event) => ({
        name: event.title,
        summary: event.summary,
        worldTimeLabel: event.worldTimeLabel,
        temporalStatus: event.temporalStatus,
        importance: event.importance,
        sourceChapterKeys: event.sourceChapters,
        evidence: [], aliases: [], details: [], relationships: [],
        confidence: 0.95, reviewStatus: "verified",
      }))
    : enrichment.breakdown.chronology.map((entry, index) => {
    const summary = entry.trim();
    const colonTitle = summary.match(/^([^:]{2,80}):\s+/)?.[1];
    const bookTitle = summary.match(/^(Book\s+(?:One|Two|Three|Four|Five|\d+))/i)?.[1];
    return {
      name: colonTitle ?? bookTitle ?? `Imported event ${index + 1}`,
      summary,
      evidence: [],
      aliases: [],
      details: [],
      relationships: [],
      confidence: 0.9,
      reviewStatus: "verified",
    };
      });
  const nextVersion = await db.query<{ version: number }>(
    `SELECT COALESCE(max(version), 0)::int + 1 AS version
       FROM storyhold.world_breakdowns
      WHERE world_id = $1 AND canon_edition_id = $2`,
    [worldId, editionId],
  );
  await db.query(
    `UPDATE storyhold.world_breakdowns SET status = 'superseded'
      WHERE world_id = $1 AND canon_edition_id = $2 AND status <> 'superseded'`,
    [worldId, editionId],
  );
  await db.query(
    `INSERT INTO storyhold.world_breakdowns
      (id, world_id, canon_edition_id, analysis_run_id, version, status,
       provider, model, summary, genres, atmosphere, themes, world_rules,
       locations, factions, institutions, governments, power_structures,
       chronology, open_questions, recurring_terms, creatures, species,
       technologies, vehicles, devices, weapons, powers, titles,
       entity_relations, entity_rules, ambiguous_labels)
     VALUES ($1, $2, $3, $4, $5, 'approved', 'codex', 'gpt-5', $6,
             $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb,
             $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb,
             $17::jsonb, $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb,
             $22::jsonb, $23::jsonb, $24::jsonb, $25::jsonb, $26::jsonb,
             '[]'::jsonb, '[]'::jsonb, $27::jsonb)`,
    [
      randomUUID(), worldId, editionId, runId, nextVersion.rows[0].version,
      enrichment.breakdown.summary, json(enrichment.breakdown.genres),
      json(enrichment.breakdown.atmosphere), json(enrichment.breakdown.themes),
      json(enrichment.breakdown.worldRules), json(byType("place")),
      json(byType("faction")), json(byType("institution")),
      json(byType("government")), json(byType("power_structure")),
      json(chronology), json(enrichment.breakdown.openQuestions),
      json(enrichment.breakdown.recurringTerms), json(byType("creature")),
      json(byType("species")), json(byType("technology")),
      json(byType("vehicle")), json(byType("device")), json(byType("weapon")),
      json(byType("power")), json(byType("title")),
      json(byType("ambiguous")),
    ],
  );

  await db.query(
    `UPDATE storyhold.worlds
        SET name = COALESCE($2, name), description = $3, genre = $4,
            metadata_inference_status = 'generated', updated_at = now()
      WHERE id = $1`,
    [worldId, enrichment.world.name ?? null, enrichment.world.description, enrichment.world.genre],
  );
  await db.query(
    `UPDATE storyhold.canon_editions
        SET chronology_status = 'reviewed', chronology_summary = $2,
            chronology_reviewed_at = now()
      WHERE id = $1`,
    [editionId, enrichment.canonicalEvents?.map((event) => event.summary).join(" ") || enrichment.breakdown.chronology.join(" ")],
  );

  await db.exec("COMMIT");
  process.stdout.write(
    `Applied ${enrichment.entities.length} verified entities, ${(enrichment.relations ?? []).length} relations, and ${(enrichment.rules ?? []).length} rules to ${worldId}.\n`,
  );
} catch (error) {
  await db.exec("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await db.close();
}
