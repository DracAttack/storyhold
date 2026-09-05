import { writeFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

const [dataDirArgument, worldId, outputArgument] = process.argv.slice(2);
if (!dataDirArgument || !worldId || !outputArgument) {
  throw new Error(
    "Usage: inspectLocalWorld <data-dir> <world-id> <output-json>",
  );
}

const dataDir = path.resolve(dataDirArgument);
const outputPath = path.resolve(outputArgument);
const db = await PGlite.create({ dataDir, extensions: { vector } });

try {
  const world = await db.query<Record<string, unknown>>(
    `SELECT world.id, world.name, world.description, world.genre,
            edition.id AS canon_edition_id, edition.name AS canon_edition_name
       FROM storyhold.worlds world
       JOIN storyhold.canon_editions edition ON edition.world_id = world.id
      WHERE world.id = $1
      ORDER BY edition.created_at ASC
      LIMIT 1`,
    [worldId],
  );
  if (world.rows.length !== 1) throw new Error(`World ${worldId} was not found.`);

  const editionId = String(world.rows[0].canon_edition_id);
  const [sources, chunks, entities, dossiers, relations, memberships, rules, chapters, clockEvents, breakdowns, analysisRuns] =
    await Promise.all([
      db.query(
        `SELECT id, title, original_filename, chronology_order, chronology_label,
                word_count, page_count, chunk_count, processing_status,
                local_scan_status, ai_review_status
           FROM storyhold.world_sources
          WHERE world_id = $1 AND canon_edition_id = $2
          ORDER BY sort_order, created_at`,
        [worldId, editionId],
      ),
      db.query(
        `SELECT id, source_id, chunk_index, content, metadata
           FROM storyhold.world_source_chunks
          WHERE world_id = $1 AND canon_edition_id = $2
          ORDER BY source_id, chunk_index`,
        [worldId, editionId],
      ),
      db.query(
        `SELECT id, dossier_id, canonical_key, normalized_name, name, entity_type,
                aliases, alias_attributions, summary, details, relationships, evidence, mention_count,
                mention_source_count, confidence, classification_source,
                review_status, pull_status, scanner_present, merged_into_entity_id
           FROM storyhold.world_entities
          WHERE world_id = $1 AND canon_edition_id = $2
          ORDER BY entity_type, name`,
        [worldId, editionId],
      ),
      db.query(
        `SELECT id, canonical_key, normalized_name, name, aliases, alias_attributions, role, summary,
                profile, evidence, confidence, dossier_status, axis_estimate,
                axis_user_override, mention_count, mention_source_count
           FROM storyhold.character_dossiers
          WHERE world_id = $1 AND canon_edition_id = $2
          ORDER BY name`,
        [worldId, editionId],
      ),
      db.query(
        `SELECT relation.id, relation.source_entity_id, source.name AS source_name,
                relation.relation_type, relation.target_entity_id,
                target.name AS target_name, relation.relation_status,
                relation.summary, relation.valid_from_label,
                relation.valid_until_label, relation.evidence,
                relation.assignment_source, relation.confidence
           FROM storyhold.world_entity_relations relation
           JOIN storyhold.world_entities source ON source.id = relation.source_entity_id
           JOIN storyhold.world_entities target ON target.id = relation.target_entity_id
          WHERE relation.world_id = $1 AND relation.canon_edition_id = $2
          ORDER BY source.name, relation.relation_type, target.name`,
        [worldId, editionId],
      ),
      db.query(
        `SELECT membership.entity_id, entity.name AS entity_name,
                membership.faction_entity_id, faction.name AS faction_name,
                membership.assignment_source, membership.confidence,
                membership.evidence
           FROM storyhold.world_entity_faction_memberships membership
           JOIN storyhold.world_entities entity ON entity.id = membership.entity_id
           JOIN storyhold.world_entities faction ON faction.id = membership.faction_entity_id
          WHERE entity.world_id = $1 AND entity.canon_edition_id = $2
          ORDER BY entity.name, faction.name`,
        [worldId, editionId],
      ),
      db.query(
        `SELECT rule.id, rule.entity_id, entity.name AS entity_name,
                rule.canonical_key, rule.name, rule.description, rule.rule_kind,
                rule.trigger_text, rule.effect_text, rule.evidence,
                rule.assignment_source, rule.confidence, rule.rule_status
           FROM storyhold.world_entity_rules rule
           JOIN storyhold.world_entities entity ON entity.id = rule.entity_id
          WHERE rule.world_id = $1 AND rule.canon_edition_id = $2
          ORDER BY entity.name, rule.name`,
        [worldId, editionId],
      ),
      db.query(
        `SELECT source_id, canonical_key, chapter_title, perspective, source_order,
                summary, major_events, evidence, summary_source, confidence
           FROM storyhold.world_chapter_summaries
          WHERE world_id = $1 AND canon_edition_id = $2
          ORDER BY source_id, source_order`,
        [worldId, editionId],
      ),
      db.query(
        `SELECT source_id, canonical_key, event_kind, title, summary,
                world_time_label, chronology_order, temporal_status,
                importance, source_chapter_keys, evidence
           FROM storyhold.world_clock_events
          WHERE world_id = $1 AND canon_edition_id = $2 AND campaign_id IS NULL
          ORDER BY chronology_order, created_at`,
        [worldId, editionId],
      ),
      db.query(
        `SELECT version, summary, genres, atmosphere, themes, world_rules,
                locations, factions, institutions, governments, power_structures,
                creatures, species, technologies, vehicles, devices, weapons,
                powers, titles, chronology, open_questions,
                recurring_terms, entity_relations, entity_rules, ambiguous_labels
           FROM storyhold.world_breakdowns
          WHERE world_id = $1 AND canon_edition_id = $2
          ORDER BY version DESC`,
        [worldId, editionId],
      ),
      db.query(
        `SELECT id, status, analysis_kind, created_at, completed_at,
                local_checkpoint
           FROM storyhold.world_analysis_runs
          WHERE world_id = $1 AND canon_edition_id = $2
          ORDER BY created_at DESC
          LIMIT 5`,
        [worldId, editionId],
      ),
    ]);

  await writeFile(
    outputPath,
    JSON.stringify(
      {
        world: world.rows[0],
        sources: sources.rows,
        chunks: chunks.rows,
        entities: entities.rows,
        dossiers: dossiers.rows,
        relations: relations.rows,
        memberships: memberships.rows,
        rules: rules.rows,
        breakdowns: breakdowns.rows,
    chapters: chapters.rows,
    clockEvents: clockEvents.rows,
    analysisRuns: analysisRuns.rows,
      },
      null,
      2,
    ),
    "utf8",
  );
  process.stdout.write(
    `Exported ${entities.rows.length} entities, ${relations.rows.length} relations, and ${rules.rows.length} rules to ${outputPath}.\n`,
  );
} finally {
  await db.close();
}
