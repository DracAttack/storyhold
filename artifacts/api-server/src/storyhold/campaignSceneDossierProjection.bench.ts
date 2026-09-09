import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { PGlite } from "@electric-sql/pglite";
import { projectAcceptedCampaignSceneDossiers } from "./campaignSceneDossierProjection";

const ACCEPTABLE_LARGE_CAST_MS = 500;
const worldId = "73000000-0000-4000-8000-000000000001";
const editionId = "73000000-0000-4000-8000-000000000002";
const campaignId = "73000000-0000-4000-8000-000000000003";

function uuid(index: number) {
  return `73000000-0000-4000-8001-${String(index).padStart(12, "0")}`;
}

async function createDatabase(castSize: number) {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.character_dossiers (
      id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      canonical_key text NOT NULL, normalized_name text NOT NULL, name text NOT NULL,
      aliases jsonb NOT NULL DEFAULT '[]'::jsonb, summary text NOT NULL DEFAULT '',
      profile jsonb NOT NULL DEFAULT '{}'::jsonb, evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      confidence real NOT NULL DEFAULT 0, mention_count integer NOT NULL DEFAULT 0,
      mention_source_count integer NOT NULL DEFAULT 0, dossier_status text NOT NULL DEFAULT 'active',
      user_edited_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (world_id, canon_edition_id, normalized_name), UNIQUE (world_id, canonical_key)
    );
    CREATE TABLE storyhold.world_entities (
      id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      dossier_id uuid REFERENCES storyhold.character_dossiers(id), canonical_key text NOT NULL,
      normalized_name text NOT NULL, name text NOT NULL, aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
      entity_type text NOT NULL, summary text NOT NULL DEFAULT '', details jsonb NOT NULL DEFAULT '[]'::jsonb,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb, mention_count integer NOT NULL DEFAULT 0,
      mention_source_count integer NOT NULL DEFAULT 0, confidence real NOT NULL DEFAULT 0,
      classification_source text NOT NULL DEFAULT 'local', review_status text NOT NULL DEFAULT 'candidate',
      pull_status text NOT NULL DEFAULT 'active', scanner_present boolean NOT NULL DEFAULT true,
      merged_into_entity_id uuid REFERENCES storyhold.world_entities(id), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (world_id, canon_edition_id, normalized_name), UNIQUE (world_id, canonical_key), UNIQUE (dossier_id)
    );
  `);
  const rows = Array.from({ length: castSize }, (_, index) => {
    const name = index === castSize - 1 ? "Target Hero" : `Cast Member ${index}`;
    return `('${uuid(index + 1)}','${worldId}','${editionId}','cast-${index}','${name.toLowerCase()}','${name}','["Alias ${index}"]','character')`;
  });
  for (let offset = 0; offset < rows.length; offset += 500) {
    await db.exec(`INSERT INTO storyhold.world_entities
      (id,world_id,canon_edition_id,canonical_key,normalized_name,name,aliases,entity_type)
      VALUES ${rows.slice(offset, offset + 500).join(",")}`);
  }
  return db;
}

async function measure(castSize: number) {
  const db = await createDatabase(castSize);
  try {
    const started = performance.now();
    await projectAcceptedCampaignSceneDossiers({
      db,
      worldId,
      canonEditionId: editionId,
      campaignId,
      turnId: uuid(castSize + 10),
      stateVersion: 1,
      narration: "Target Hero said the gate was secure. Target Hero turned home.",
      sceneSummary: "Target Hero secures the gate.",
    });
    return performance.now() - started;
  } finally {
    await db.close();
  }
}

const smallMs = await measure(100);
const largeMs = await measure(5_000);
console.log(`accepted-scene projection: 100 cast=${smallMs.toFixed(1)}ms, 5,000 cast=${largeMs.toFixed(1)}ms`);
console.log(`documented upper bound: ${ACCEPTABLE_LARGE_CAST_MS}ms for a 5,000-character cast`);
assert.ok(
  largeMs <= ACCEPTABLE_LARGE_CAST_MS,
  `large-cast projection took ${largeMs.toFixed(1)}ms (limit ${ACCEPTABLE_LARGE_CAST_MS}ms)`,
);