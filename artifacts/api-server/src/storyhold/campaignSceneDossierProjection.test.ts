import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { projectAcceptedCampaignSceneDossiers } from "./campaignSceneDossierProjection";

const ids = {
  world: "71000000-0000-4000-8000-000000000001",
  edition: "71000000-0000-4000-8000-000000000002",
  campaign: "71000000-0000-4000-8000-000000000003",
  turnOne: "71000000-0000-4000-8000-000000000004",
  turnTwo: "71000000-0000-4000-8000-000000000005",
};

test("accepted scenes project named characters once, preserve edits, and never promote planned-only cast", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.character_dossiers (
      id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      canonical_key text NOT NULL, normalized_name text NOT NULL, name text NOT NULL,
      aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
      summary text NOT NULL DEFAULT '', profile jsonb NOT NULL DEFAULT '{}'::jsonb,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb, confidence real NOT NULL DEFAULT 0,
      mention_count integer NOT NULL DEFAULT 0, mention_source_count integer NOT NULL DEFAULT 0,
      dossier_status text NOT NULL DEFAULT 'active' CHECK (dossier_status IN ('active','suppressed')),
      user_edited_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (world_id, canon_edition_id, normalized_name), UNIQUE (world_id, canonical_key)
    );
    CREATE TABLE storyhold.world_entities (
      id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid NOT NULL,
      dossier_id uuid REFERENCES storyhold.character_dossiers(id) ON DELETE SET NULL, canonical_key text NOT NULL, normalized_name text NOT NULL,
      name text NOT NULL, aliases jsonb NOT NULL DEFAULT '[]'::jsonb, entity_type text NOT NULL, summary text NOT NULL DEFAULT '',
      details jsonb NOT NULL DEFAULT '[]'::jsonb, evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      mention_count integer NOT NULL DEFAULT 0, mention_source_count integer NOT NULL DEFAULT 0,
      confidence real NOT NULL DEFAULT 0, classification_source text NOT NULL DEFAULT 'local',
      review_status text NOT NULL DEFAULT 'candidate', pull_status text NOT NULL DEFAULT 'active',
      scanner_present boolean NOT NULL DEFAULT true, merged_into_entity_id uuid REFERENCES storyhold.world_entities(id) ON DELETE SET NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (world_id, canon_edition_id, normalized_name), UNIQUE (world_id, canonical_key), UNIQUE (dossier_id)
    );
  `);
  let advisoryLockCalls = 0;
  const projectingDb = {
    query: (...args: Parameters<typeof db.query>) => {
      if (String(args[0]).includes("pg_advisory_xact_lock")) advisoryLockCalls += 1;
      return db.query(...args);
    },
  } as Pick<PGlite, "query">;
  const first = {
    db: projectingDb, worldId: ids.world, canonEditionId: ids.edition, campaignId: ids.campaign,
    turnId: ids.turnOne, stateVersion: 1,
    narration: "Nera said the harbor was unsafe. Nera drew her coat tight.",
    sceneSummary: "Nera warns the party at the harbor.",
  };
  await projectAcceptedCampaignSceneDossiers({
    ...first,
    narration: "Nera said the harbor was completely different in this recovered payload. Nera turned.",
  });
  const created = (await db.query<{ id: string; dossier_id: string }>(
    "SELECT id, dossier_id FROM storyhold.world_entities WHERE normalized_name='nera'",
  )).rows[0]!;
  assert.ok(created.dossier_id);
  assert.equal((await db.query("SELECT * FROM storyhold.world_entities")).rows.length, 1);

  // Exact replay is a no-op rather than another projection side effect.
  await projectAcceptedCampaignSceneDossiers(first);
  assert.equal(Number((await db.query<{ mention_count: number }>(
    "SELECT mention_count FROM storyhold.world_entities WHERE id=$1", [created.id],
  )).rows[0]!.mention_count), 1);

  await db.query(
    "UPDATE storyhold.character_dossiers SET profile=$2::jsonb, summary='Owner wording', user_edited_at=now() WHERE id=$1",
    [created.dossier_id, JSON.stringify({ traits: ["careful"], customNote: "do not rewrite" })],
  );
  await projectAcceptedCampaignSceneDossiers({
    ...first, turnId: ids.turnTwo, stateVersion: 2,
    narration: "Nera said the harbor was safe tonight.",
    sceneSummary: "Nera now judges the harbor safe.",
  });
  const dossier = (await db.query<{ profile: unknown; summary: string; evidence: unknown[] }>(
    "SELECT profile, summary, evidence FROM storyhold.character_dossiers WHERE id=$1", [created.dossier_id],
  )).rows[0]!;
  assert.deepEqual(dossier.profile, { traits: ["careful"], customNote: "do not rewrite" });
  assert.equal(dossier.summary, "Owner wording");
  assert.equal(dossier.evidence.length, 2);

  // A setup/planned name is not an input to this committed-prose projection.
  await projectAcceptedCampaignSceneDossiers({
    ...first, turnId: "71000000-0000-4000-8000-000000000006", stateVersion: 3,
    narration: "The rain closed over the empty harbor.", sceneSummary: "No one arrives.",
  });
  assert.equal((await db.query(
    "SELECT * FROM storyhold.world_entities WHERE normalized_name='planned captain'",
  )).rows.length, 0);
  assert.ok(advisoryLockCalls > 0);

  const project = (turnId: string, narration: string) =>
    projectAcceptedCampaignSceneDossiers({
      ...first, turnId, stateVersion: 10, narration, sceneSummary: narration,
    });
  const uuid = (tail: number) =>
    `72000000-0000-4000-8000-${String(tail).padStart(12, "0")}`;
  // An active primary name outranks an unrelated card's alias.
  await db.query(
    `INSERT INTO storyhold.character_dossiers
      (id,world_id,canon_edition_id,canonical_key,normalized_name,name,aliases)
     VALUES ($1,$3,$4,'mara-d','mara','Mara','[]'),($2,$3,$4,'vera-d','vera','Vera','["Mara"]')`,
    [uuid(1), uuid(2), ids.world, ids.edition],
  );
  await db.query(
    `INSERT INTO storyhold.world_entities
      (id,world_id,canon_edition_id,dossier_id,canonical_key,normalized_name,name,aliases,entity_type)
     VALUES ($1,$5,$6,$3,'mara-e','mara','Mara','[]','character'),
            ($2,$5,$6,$4,'vera-e','vera','Vera','["Mara"]','character')`,
    [uuid(3), uuid(4), uuid(1), uuid(2), ids.world, ids.edition],
  );
  await project(uuid(5), "Mara said the lock was broken. Mara turned away.");
  assert.equal((await db.query<{ evidence: unknown[] }>(
    "SELECT evidence FROM storyhold.world_entities WHERE id=$1", [uuid(3)],
  )).rows[0]!.evidence.length, 1);
  assert.equal((await db.query<{ evidence: unknown[] }>(
    "SELECT evidence FROM storyhold.world_entities WHERE id=$1", [uuid(4)],
  )).rows[0]!.evidence.length, 0);

  // A genuinely ambiguous alias is skipped.
  await db.query(
    `INSERT INTO storyhold.world_entities
      (id,world_id,canon_edition_id,canonical_key,normalized_name,name,aliases,entity_type)
     VALUES ($1,$3,$4,'one-e','one','Ilya','["Shade"]','character'),
            ($2,$3,$4,'two-e','two','Oren','["Shade"]','character')`,
    [uuid(6), uuid(7), ids.world, ids.edition],
  );
  await project(uuid(8), "Shade said nothing. Shade turned toward the door.");
  assert.equal((await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM storyhold.world_entities WHERE id IN ($1,$2) AND jsonb_array_length(evidence)>0",
    [uuid(6), uuid(7)],
  )).rows[0]!.count, 0);

  // A merged historical name resolves to its active canonical target.
  await db.query(
    `INSERT INTO storyhold.world_entities
      (id,world_id,canon_edition_id,canonical_key,normalized_name,name,aliases,entity_type,pull_status,merged_into_entity_id)
     VALUES ($1,$3,$4,'old-nera','old nera','Old Nera','[]','character','merged',$2)`,
    [uuid(9), created.id, ids.world, ids.edition],
  );
  await project(uuid(10), "Old Nera said the tide was rising. Old Nera turned.");
  assert.equal((await db.query<{ evidence: unknown[] }>(
    "SELECT evidence FROM storyhold.world_entities WHERE id=$1", [created.id],
  )).rows[0]!.evidence.length, 3);

  // Dossier-only and entity-only split states are repaired in-place.
  await db.query(
    `INSERT INTO storyhold.character_dossiers
      (id,world_id,canon_edition_id,canonical_key,normalized_name,name)
     VALUES ($1,$2,$3,'orla-d','orla','Orla')`,
    [uuid(11), ids.world, ids.edition],
  );
  await project(uuid(12), "Orla said she would stay. Orla walked inside.");
  assert.equal((await db.query<{ dossier_id: string }>(
    "SELECT dossier_id FROM storyhold.world_entities WHERE normalized_name='orla'",
  )).rows[0]!.dossier_id, uuid(11));
  await db.query(
    `INSERT INTO storyhold.world_entities
      (id,world_id,canon_edition_id,canonical_key,normalized_name,name,entity_type)
     VALUES ($1,$2,$3,'tavi-e','tavi','Tavi','character')`,
    [uuid(13), ids.world, ids.edition],
  );
  await project(uuid(14), "Tavi said the bridge held. Tavi walked onward.");
  const taviDossier = (await db.query<{ dossier_id: string }>(
    "SELECT dossier_id FROM storyhold.world_entities WHERE id=$1", [uuid(13)],
  )).rows[0]!.dossier_id;
  assert.ok(taviDossier);
  await db.query(
    "UPDATE storyhold.character_dossiers SET evidence='[]', mention_count=0, mention_source_count=0 WHERE id=$1",
    [taviDossier],
  );
  await project(uuid(14), "Tavi said this replay had altered words. Tavi walked onward.");
  assert.equal((await db.query<{ evidence: unknown[]; mention_count: number }>(
    "SELECT evidence,mention_count FROM storyhold.character_dossiers WHERE id=$1", [taviDossier],
  )).rows[0]!.evidence.length, 1);

  // Apostrophe-bearing aliases resolve using the canonical world resolver.
  await db.query(
    `INSERT INTO storyhold.world_entities
      (id,world_id,canon_edition_id,canonical_key,normalized_name,name,aliases,entity_type)
     VALUES ($1,$2,$3,'ona-e','ona','Ona','["O’Neil"]','character')`,
    [uuid(16), ids.world, ids.edition],
  );
  await project(uuid(17), "O’Neil said the radio worked. O’Neil turned it off.");
  assert.equal((await db.query<{ evidence: unknown[] }>(
    "SELECT evidence FROM storyhold.world_entities WHERE id=$1", [uuid(16)],
  )).rows[0]!.evidence.length, 1);

  // Capitalized weather, places, factions, and titles are not people.
  await project(uuid(15), [
    "Rain turned cold. Rain turned colder.",
    "North Harbor stood silent. North Harbor stood empty.",
    "Iron Guild stood firm. Iron Guild stood together.",
    "The Captain turned away. The Captain turned back.",
  ].join(" "));
  assert.equal((await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM storyhold.world_entities WHERE normalized_name IN ('rain','north harbor','iron guild','captain')",
  )).rows[0]!.count, 0);

  // An alias on an already-owned dossier resolves through its owner and never
  // attempts a second entity with the same dossier_id.
  await db.query(
    `INSERT INTO storyhold.character_dossiers
      (id,world_id,canon_edition_id,canonical_key,normalized_name,name,aliases)
     VALUES ($1,$2,$3,'elara-d','elara','Elara','["Starlight"]')`,
    [uuid(18), ids.world, ids.edition],
  );
  await db.query(
    `INSERT INTO storyhold.world_entities
      (id,world_id,canon_edition_id,dossier_id,canonical_key,normalized_name,name,entity_type)
     VALUES ($1,$2,$3,$4,'elara-e','elara','Elara','character')`,
    [uuid(19), ids.world, ids.edition, uuid(18)],
  );
  await project(uuid(20), "Starlight said the watch had ended. Starlight walked home.");
  assert.equal((await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM storyhold.world_entities WHERE dossier_id=$1", [uuid(18)],
  )).rows[0]!.count, 1);
  assert.equal((await db.query<{ evidence: unknown[] }>(
    "SELECT evidence FROM storyhold.world_entities WHERE id=$1", [uuid(19)],
  )).rows[0]!.evidence.length, 1);

  // Established one-word stopword-like names and titled primary names are
  // resolved before unknown-name cleanup.
  await db.query(
    `INSERT INTO storyhold.world_entities
      (id,world_id,canon_edition_id,canonical_key,normalized_name,name,entity_type)
     VALUES ($1,$4,$5,'dawn-e','dawn','Dawn','character'),
            ($2,$4,$5,'captain-nera-e','captain nera','Captain Nera','character'),
            ($3,$4,$5,'late-e','late witness','Late Witness','character')`,
    [uuid(21), uuid(22), uuid(23), ids.world, ids.edition],
  );
  await project(uuid(24), "Dawn said she understood. Dawn walked away. Captain Nera said to wait. Captain Nera turned.");
  assert.equal((await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM storyhold.world_entities WHERE id IN ($1,$2) AND jsonb_array_length(evidence)=1",
    [uuid(21), uuid(22)],
  )).rows[0]!.count, 2);
  assert.equal((await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM storyhold.world_entities WHERE normalized_name='nera'",
  )).rows[0]!.count, 1);

  await project(
    uuid(25),
    `${"The corridor remained empty. ".repeat(180)} Late Witness said the signal was real. Late Witness turned.`,
  );
  assert.equal((await db.query<{ evidence: unknown[] }>(
    "SELECT evidence FROM storyhold.world_entities WHERE id=$1", [uuid(23)],
  )).rows[0]!.evidence.length, 1);
});