import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureWorldClockPersistence } from "./worldClockPersistence";
import {
  readCampaignClockEventsForEdition,
  readWorldClockEventsForEdition,
  readWorldClockRelationsForEdition,
  serializeClockEvent,
} from "./worldStudio";

const WORLD = "10000000-0000-4000-8000-000000000001";
const OTHER_WORLD = "10000000-0000-4000-8000-000000000002";
const EDITION = "20000000-0000-4000-8000-000000000001";
const OTHER_EDITION = "20000000-0000-4000-8000-000000000002";
const CAMPAIGN = "30000000-0000-4000-8000-000000000001";
const OTHER_CAMPAIGN = "30000000-0000-4000-8000-000000000002";
const CHARACTER = "40000000-0000-4000-8000-000000000001";
const OTHER_CHARACTER = "40000000-0000-4000-8000-000000000002";
const HOLDER = "50000000-0000-4000-8000-000000000001";
const OTHER_HOLDER = "50000000-0000-4000-8000-000000000002";

async function clockDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.world_entities (
      id uuid PRIMARY KEY,
      world_id uuid NOT NULL,
      canon_edition_id uuid NOT NULL,
      name text NOT NULL
    );
    CREATE TABLE storyhold.world_clock_events (
      id uuid PRIMARY KEY,
      world_id uuid NOT NULL,
      canon_edition_id uuid,
      campaign_id uuid,
      visible_to_character_id uuid,
      canonical_key text NOT NULL,
      event_kind text NOT NULL DEFAULT 'canon',
      title text NOT NULL,
      summary text NOT NULL DEFAULT '',
      world_time_label text NOT NULL DEFAULT '',
      chronology_order bigint NOT NULL DEFAULT 0,
      temporal_status text NOT NULL DEFAULT 'relative',
      importance text NOT NULL DEFAULT 'major',
      source_chapter_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
      visibility text NOT NULL DEFAULT 'world',
      knowledge_status text NOT NULL DEFAULT 'observed',
      known_effects jsonb NOT NULL DEFAULT '[]'::jsonb,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      scheduled_for_label text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'committed',
      truth_status text,
      epistemic_holder_entity_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE storyhold.world_event_relations (
      id uuid PRIMARY KEY,
      world_id uuid NOT NULL,
      canon_edition_id uuid NOT NULL,
      source_event_id uuid NOT NULL,
      target_event_id uuid NOT NULL,
      relation_type text NOT NULL,
      summary text NOT NULL DEFAULT '',
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      confidence real NOT NULL DEFAULT 0
    );
    CREATE TABLE storyhold.world_clock_event_verifications (
      event_id uuid NOT NULL,
      world_id uuid NOT NULL,
      edition_id uuid NOT NULL
    );
  `);
  await db.query(
    `INSERT INTO storyhold.world_entities (id,world_id,canon_edition_id,name)
     VALUES ($1,$2,$3,'Lilly'),($4,$2,$5,'Old Lilly')`,
    [HOLDER, WORLD, EDITION, OTHER_HOLDER, OTHER_EDITION],
  );
  return db;
}

async function markVerified(db: PGlite, eventId: string) {
  await db.query(
    `INSERT INTO storyhold.world_clock_event_verifications
       (event_id,world_id,edition_id) VALUES ($1,$2,$3)`,
    [eventId, WORLD, EDITION],
  );
}

async function insertEvent(
  db: PGlite,
  input: {
    id: string;
    worldId?: string;
    editionId?: string | null;
    campaignId?: string | null;
    characterId?: string | null;
    visibility?: string;
    knowledgeStatus?: string;
    truthStatus?: string | null;
    holderId?: string | null;
    order?: number;
  },
) {
  await db.query(
    `INSERT INTO storyhold.world_clock_events
       (id,world_id,canon_edition_id,campaign_id,visible_to_character_id,
        canonical_key,title,chronology_order,visibility,knowledge_status,
        truth_status,epistemic_holder_entity_id)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11)`,
    [
      input.id,
      input.worldId ?? WORLD,
      input.editionId === undefined ? EDITION : input.editionId,
      input.campaignId ?? null,
      input.characterId ?? null,
      `event-${input.id.slice(-4)}`,
      input.order ?? 0,
      input.visibility ?? "world",
      input.knowledgeStatus ?? "observed",
      input.truthStatus ?? "fact",
      input.holderId ?? null,
    ],
  );
}

test("world clock reads only the selected canon edition and resolves holder names", async () => {
  const db = await clockDb();
  try {
    await insertEvent(db, {
      id: "60000000-0000-4000-8000-000000000001",
      truthStatus: "belief",
      holderId: HOLDER,
    });
    await insertEvent(db, {
      id: "60000000-0000-4000-8000-000000000002",
      editionId: OTHER_EDITION,
      truthStatus: "belief",
      holderId: OTHER_HOLDER,
    });
    await insertEvent(db, {
      id: "60000000-0000-4000-8000-000000000003",
      campaignId: CAMPAIGN,
      visibility: "campaign",
    });
    await insertEvent(db, {
      id: "60000000-0000-4000-8000-000000000004",
      worldId: OTHER_WORLD,
    });
    await insertEvent(db, {
      id: "60000000-0000-4000-8000-000000000005",
      visibility: "world",
      knowledgeStatus: "secret",
    });
    await insertEvent(db, {
      id: "60000000-0000-4000-8000-000000000006",
      truthStatus: "belief",
      holderId: OTHER_HOLDER,
      order: 6,
    });
    await markVerified(db, "60000000-0000-4000-8000-000000000001");
    await markVerified(db, "60000000-0000-4000-8000-000000000006");

    const result = await readWorldClockEventsForEdition(db, {
      worldId: WORLD,
      editionId: EDITION,
    });
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0]?.epistemic_holder_name, "Lilly");
    assert.deepEqual(serializeClockEvent(result.rows[0]!), {
      id: "60000000-0000-4000-8000-000000000001",
      canonicalKey: "event-0001",
      campaignId: null,
      sourceId: null,
      causalParentId: null,
      eventKind: "canon",
      title: "event-0001",
      summary: "",
      worldTimeLabel: "",
      chronologyOrder: 0,
      temporalStatus: "relative",
      importance: "major",
      sourceChapterKeys: [],
      causalLinks: [],
      visibility: "world",
      truthStatus: "belief",
      epistemicHolderEntityId: HOLDER,
      epistemicHolderName: "Lilly",
      knowledgeStatus: "observed",
      knownEffects: [],
      evidence: [],
      scheduledForLabel: "",
      dueWorldTimeMinutes: null,
      dueTurnNumber: null,
      maturedAt: null,
      status: "committed",
      createdAt: result.rows[0]?.created_at,
    });
    const mismatchedHolder = serializeClockEvent(result.rows[1]!);
    assert.equal(mismatchedHolder.truthStatus, "belief");
    assert.equal(mismatchedHolder.epistemicHolderEntityId, null);
    assert.equal(mismatchedHolder.epistemicHolderName, null);
    assert.doesNotMatch(JSON.stringify(mismatchedHolder), new RegExp(OTHER_HOLDER, "u"));
  } finally {
    await db.close();
  }
});

test("campaign clock imports current-edition canon without leaking another edition", async () => {
  const db = await clockDb();
  try {
    await insertEvent(db, { id: "70000000-0000-4000-8000-000000000001", order: 1 });
    await insertEvent(db, {
      id: "70000000-0000-4000-8000-000000000002",
      editionId: OTHER_EDITION,
      order: 2,
    });
    await insertEvent(db, {
      id: "70000000-0000-4000-8000-000000000003",
      campaignId: CAMPAIGN,
      visibility: "campaign",
      order: 3,
    });
    await insertEvent(db, {
      id: "70000000-0000-4000-8000-000000000004",
      editionId: null,
      campaignId: CAMPAIGN,
      visibility: "campaign",
      order: 4,
    });
    await insertEvent(db, {
      id: "70000000-0000-4000-8000-000000000005",
      editionId: OTHER_EDITION,
      campaignId: CAMPAIGN,
      visibility: "campaign",
      order: 5,
    });
    await insertEvent(db, {
      id: "70000000-0000-4000-8000-000000000006",
      campaignId: CAMPAIGN,
      characterId: CHARACTER,
      visibility: "character",
      truthStatus: "belief",
      holderId: HOLDER,
      order: 6,
    });
    await insertEvent(db, {
      id: "70000000-0000-4000-8000-000000000007",
      campaignId: CAMPAIGN,
      characterId: OTHER_CHARACTER,
      visibility: "character",
      order: 7,
    });
    await insertEvent(db, {
      id: "70000000-0000-4000-8000-000000000008",
      campaignId: OTHER_CAMPAIGN,
      visibility: "campaign",
      order: 8,
    });
    await insertEvent(db, {
      id: "70000000-0000-4000-8000-000000000009",
      campaignId: CAMPAIGN,
      visibility: "campaign",
      knowledgeStatus: "secret",
      order: 9,
    });
    await markVerified(db, "70000000-0000-4000-8000-000000000006");

    const result = await readCampaignClockEventsForEdition(db, {
      worldId: WORLD,
      editionId: EDITION,
      campaignId: CAMPAIGN,
      characterId: CHARACTER,
    });
    assert.deepEqual(
      result.rows.map((row) => row.id),
      [
        "70000000-0000-4000-8000-000000000001",
        "70000000-0000-4000-8000-000000000003",
        "70000000-0000-4000-8000-000000000004",
        "70000000-0000-4000-8000-000000000006",
      ],
    );
    const privateBelief = serializeClockEvent(result.rows.at(-1)!);
    assert.equal(privateBelief.truthStatus, "belief");
    assert.equal(privateBelief.epistemicHolderEntityId, HOLDER);
    assert.equal(privateBelief.epistemicHolderName, "Lilly");
  } finally {
    await db.close();
  }
});

test("world clock relations cannot reveal hidden or other-edition event titles", async () => {
  const db = await clockDb();
  try {
    const visibleA = "90000000-0000-4000-8000-000000000001";
    const visibleB = "90000000-0000-4000-8000-000000000002";
    const secret = "90000000-0000-4000-8000-000000000003";
    const otherEdition = "90000000-0000-4000-8000-000000000004";
    await insertEvent(db, { id: visibleA, order: 1 });
    await insertEvent(db, { id: visibleB, order: 2 });
    await insertEvent(db, { id: secret, order: 3, knowledgeStatus: "secret" });
    await insertEvent(db, { id: otherEdition, order: 4, editionId: OTHER_EDITION });
    await db.query(
      `INSERT INTO storyhold.world_event_relations
        (id,world_id,canon_edition_id,source_event_id,target_event_id,relation_type)
       VALUES
        ('91000000-0000-4000-8000-000000000001',$1,$2,$3,$4,'causes'),
        ('91000000-0000-4000-8000-000000000002',$1,$2,$3,$5,'causes'),
        ('91000000-0000-4000-8000-000000000003',$1,$2,$3,$6,'causes')`,
      [WORLD, EDITION, visibleA, visibleB, secret, otherEdition],
    );

    const relations = await readWorldClockRelationsForEdition(db, {
      worldId: WORLD,
      editionId: EDITION,
    });
    assert.deepEqual(relations.rows.map((row) => row.id), [
      "91000000-0000-4000-8000-000000000001",
    ]);
    assert.equal(relations.rows[0]?.source_title, `event-${visibleA.slice(-4)}`);
    assert.equal(relations.rows[0]?.target_title, `event-${visibleB.slice(-4)}`);
    assert.doesNotMatch(JSON.stringify(relations.rows), /0003|0004/u);
  } finally {
    await db.close();
  }
});

test("legacy clock serialization stays compatible and never exposes internal provenance", () => {
  const legacy = serializeClockEvent({
    id: "80000000-0000-4000-8000-000000000001",
    assignment_source: "gliner2_internal_pass",
    knowledge_status: "inferred",
  });
  assert.equal(Object.hasOwn(legacy, "truthStatus"), false);
  assert.equal(Object.hasOwn(legacy, "epistemicHolderEntityId"), false);
  assert.equal(JSON.stringify(legacy).includes("gliner"), false);

  const invalid = serializeClockEvent({
    id: "80000000-0000-4000-8000-000000000002",
    has_verified_truth: true,
    truth_status: "provider_verified",
    epistemic_holder_entity_id: null,
    epistemic_holder_name: "  ",
  });
  assert.equal(invalid.truthStatus, "unknown");
  assert.equal(invalid.epistemicHolderName, null);
});

test("the truth-column migration does not relabel legacy observations as reviewed truth", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.world_entities (
        id uuid PRIMARY KEY, world_id uuid NOT NULL,
        canon_edition_id uuid NOT NULL, name text NOT NULL
      );
      CREATE TABLE storyhold.world_analysis_runs (id uuid PRIMARY KEY);
      CREATE TABLE storyhold.world_event_participants (id uuid PRIMARY KEY);
      CREATE TABLE storyhold.world_event_relations (id uuid PRIMARY KEY);
      CREATE TABLE storyhold.world_clock_events (
        id uuid PRIMARY KEY, world_id uuid NOT NULL, canon_edition_id uuid,
        campaign_id uuid, visible_to_character_id uuid, canonical_key text NOT NULL,
        event_kind text NOT NULL DEFAULT 'canon', title text NOT NULL,
        summary text NOT NULL DEFAULT '', world_time_label text NOT NULL DEFAULT '',
        chronology_order bigint NOT NULL DEFAULT 0,
        temporal_status text NOT NULL DEFAULT 'relative',
        importance text NOT NULL DEFAULT 'major',
        source_chapter_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
        visibility text NOT NULL DEFAULT 'world',
        knowledge_status text NOT NULL DEFAULT 'observed',
        known_effects jsonb NOT NULL DEFAULT '[]'::jsonb,
        evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
        scheduled_for_label text NOT NULL DEFAULT '',
        status text NOT NULL DEFAULT 'committed',
        created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO storyhold.world_clock_events
        (id,world_id,canon_edition_id,canonical_key,title,knowledge_status)
      VALUES
        ('92000000-0000-4000-8000-000000000001','${WORLD}','${EDITION}','legacy-observed','Legacy Observation','observed'),
        ('92000000-0000-4000-8000-000000000002','${WORLD}','${EDITION}','legacy-revealed','Legacy Reveal','revealed');
    `);
    await ensureWorldClockPersistence(db);

    const migrated = await readWorldClockEventsForEdition(db, {
      worldId: WORLD,
      editionId: EDITION,
    });
    assert.deepEqual(migrated.rows.map((row) => row.truth_status), ["unknown", "unknown"]);
    const serialized = migrated.rows.map((row) => serializeClockEvent(row));
    assert.deepEqual(serialized.map((event) => event.knowledgeStatus), ["observed", "revealed"]);
    assert.equal(serialized.some((event) => Object.hasOwn(event, "truthStatus")), false);
  } finally {
    await db.close();
  }
});
