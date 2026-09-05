import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { CampaignCanonClaimSnapshot } from "./campaignCanonScope";
import {
  ensureCampaignRpgPersistence,
  initializeCampaignRpgStateInTransaction,
} from "./campaignRpgPersistence";
import {
  buildAnchoredCampaignStartPresentation,
  buildWorldStudioCampaignRpgSeed,
  campaignRpgSeedLineage,
} from "./worldStudio";

const CAMPAIGN_ID = "10000000-0000-4000-8000-000000000001";
const WORLD_ID = "10000000-0000-4000-8000-000000000002";
const EDITION_ID = "10000000-0000-4000-8000-000000000003";
const CHARACTER_ID = "10000000-0000-4000-8000-000000000004";
const ACTOR_ENTITY_ID = "10000000-0000-4000-8000-000000000005";
const ECHO_ENTITY_ID = "10000000-0000-4000-8000-000000000006";
const UNKNOWN_ENTITY_ID = "10000000-0000-4000-8000-000000000007";
const ANCHOR_EVENT_ID = "10000000-0000-4000-8000-000000000008";

function canonClaim(
  overrides: Partial<CampaignCanonClaimSnapshot> = {},
): CampaignCanonClaimSnapshot {
  return {
    claim_id: "20000000-0000-4000-8000-000000000001",
    world_id: WORLD_ID,
    canon_edition_id: EDITION_ID,
    fingerprint: "alec-bonded-echo",
    supersedes_claim_id: null,
    subject_entity_id: ACTOR_ENTITY_ID,
    predicate: "is bonded to",
    polarity: "positive",
    object_entity_id: ECHO_ENTITY_ID,
    object_text: "",
    epistemic_holder_entity_id: null,
    truth_status: "fact",
    valid_from_label: "",
    valid_until_label: "",
    summary: "Alec and Echo share a symbiotic bond.",
    evidence: [{
      evidenceKey: "evidence-1",
      sourceId: "30000000-0000-4000-8000-000000000001",
      chunkId: "30000000-0000-4000-8000-000000000002",
      quote: "Alec is bonded to Echo.",
    }],
    confidence: 0.98,
    claim_status: "active",
    assignment_source: "ai",
    source_updated_at: null,
    snapshot_hash: "f".repeat(64),
    ...overrides,
  };
}

const actorSnapshot = {
  entity_id: ACTOR_ENTITY_ID,
  canonical_key: "alec-sumner",
  entity_type: "character",
  name: "Alec Sumner",
  profile: {
    estimatedStats: {
      strength: {
        score: 16,
        confidence: 0.8,
        evidence: [{ quote: "He forced the door open." }],
      },
      dexterity: {
        score: 18,
        confidence: 0.9,
        evidence: [],
      },
    },
  },
  entity_rules: [{
    canonicalKey: "transforming-host",
    name: "Transforming Host",
    description: "Can assume an altered symbiotic form.",
    ruleKind: "ability",
    evidence: [{ quote: "Alec transforms." }],
  }],
};

const echoSnapshot = {
  entity_id: ECHO_ENTITY_ID,
  canonical_key: "echo",
  entity_type: "character",
  name: "Echo",
};

const sanctuarySnapshot = {
  entity_id: "10000000-0000-4000-8000-000000000009",
  canonical_key: "sanctuary",
  entity_type: "place",
  name: "Sanctuary",
};

const innSnapshot = {
  entity_id: "10000000-0000-4000-8000-000000000010",
  canonical_key: "inn",
  entity_type: "place",
  name: "Inn",
};

test("anchored campaign presentation never borrows live dossier or world prose", () => {
  const presentation = buildAnchoredCampaignStartPresentation({
    worldName: "Ashes",
    genre: "Post-Apocalyptic Fantasy",
    requestedStartingPoint: "",
    anchorMode: "before",
    anchorTitle: "The Masked Stranger Reveals His Divine Name",
    timelineRows: [{ chronology_order: 3, title: "The Survivors Reach Sanctuary" }],
    playerEntityId: ACTOR_ENTITY_ID,
    entitySnapshotRows: [
      { ...actorSnapshot, name: "Alec" },
      echoSnapshot,
    ],
    claims: [canonClaim({ object_entity_id: ECHO_ENTITY_ID })],
  });
  assert.equal(presentation.characterName, "Alec");
  assert.match(presentation.characterConcept, /Alec is bonded to Echo\./u);
  assert.equal(
    presentation.startingPoint,
    "The story resumes after The Survivors Reach Sanctuary, before the next recorded event.",
  );
  assert.doesNotMatch(JSON.stringify(presentation), /Masked Stranger|Divine Name/iu);
  assert.doesNotMatch(JSON.stringify(presentation), /transform|future dossier/iu);
});

test("an explicit anchored starting point remains the player's authority", () => {
  const presentation = buildAnchoredCampaignStartPresentation({
    worldName: "Ashes",
    genre: "Fantasy",
    requestedStartingPoint: "At Sanctuary's north gate before sunrise.",
    anchorMode: "after",
    anchorTitle: "A Prior Event",
    timelineRows: [],
    playerEntityId: ACTOR_ENTITY_ID,
    entitySnapshotRows: [{ ...actorSnapshot, name: "Alec" }],
    claims: [],
  });
  assert.equal(presentation.startingPoint, "At Sanctuary's north gate before sunrise.");
});

test("strict imported launch seeds use only anchored facts and identity-safe names", () => {
  const seed = buildWorldStudioCampaignRpgSeed({
    campaignId: CAMPAIGN_ID,
    worldId: WORLD_ID,
    editionId: EDITION_ID,
    worldName: "Ashes",
    worldPremise: "Humanity survives after a catastrophic fall.",
    startingPoint: "Alec reaches the northern gate of Sanctuary.",
    initialObjective: "",
    resolutionMode: "story_first",
    characterId: CHARACTER_ID,
    characterEntityId: ACTOR_ENTITY_ID,
    characterName: "Alec Sumner",
    hasManuscriptCanonSources: true,
    entitySnapshotRows: [actorSnapshot, echoSnapshot, sanctuarySnapshot],
    anchoredCanonClaims: [
      canonClaim(),
      canonClaim({
        claim_id: "20000000-0000-4000-8000-000000000002",
        object_entity_id: UNKNOWN_ENTITY_ID,
      }),
      canonClaim({
        claim_id: "20000000-0000-4000-8000-000000000003",
        truth_status: "belief",
      }),
    ],
    strictCharacterMechanics: {
      projectedStats: { strength: 16 },
      rules: [{
        id: "symbiotic-awareness",
        name: "Symbiotic Awareness",
        description: "Alec can sense Echo's presence.",
        ruleKind: "biological",
        evidence: [{
          sourceId: "30000000-0000-4000-8000-000000000001",
          chunkId: "30000000-0000-4000-8000-000000000002",
          quote: "Alec is bonded to Echo.",
        }],
        temporalEvidenceVerified: true,
      }],
    },
    canonAnchor: { eventId: ANCHOR_EVENT_ID, mode: "before" },
  });

  assert.deepEqual(seed.origin, {
    kind: "imported",
    worldId: WORLD_ID,
    editionId: EDITION_ID,
    canonAnchor: `before:${ANCHOR_EVENT_ID}`,
  });
  assert.deepEqual(seed.world.facts, [{
    id: "20000000-0000-4000-8000-000000000001",
    subject: "Alec Sumner",
    predicate: "is bonded to",
    object: "Echo",
    provenance: "manuscript",
    locked: true,
  }]);
  assert.equal(seed.initialState.characters[0]?.stats.strength, 16);
  assert.equal(seed.initialState.characters[0]?.stats.dexterity, 10);
  assert.deepEqual(
    seed.initialState.characters[0]?.capabilities.map((capability) => capability.name),
    ["Symbiotic Awareness", "Is Bonded to Echo"],
  );
  assert.deepEqual(seed.initialState.location, {
    entityId: sanctuarySnapshot.entity_id,
    name: "Sanctuary",
    zone: null,
  });
});

test("strict mechanics expose an established bond before a reveal and transformation only after it", () => {
  const common = {
    campaignId: CAMPAIGN_ID,
    worldId: WORLD_ID,
    editionId: EDITION_ID,
    worldName: "The Ash Coast",
    worldPremise: "A fallen world survives.",
    startingPoint: "At the western gate.",
    initialObjective: "",
    resolutionMode: "light_rules" as const,
    characterId: CHARACTER_ID,
    characterEntityId: ACTOR_ENTITY_ID,
    characterName: "Mara",
    hasManuscriptCanonSources: true,
    entitySnapshotRows: [{ ...actorSnapshot, name: "Mara" }, { ...echoSnapshot, name: "Nyx" }],
    strictCharacterMechanics: { projectedStats: {}, rules: [] },
  };
  const bond = canonClaim({
    predicate: "is bonded to",
    object_entity_id: ECHO_ENTITY_ID,
    evidence: [{
      evidenceKey: "bond",
      sourceId: "30000000-0000-4000-8000-000000000001",
      chunkId: "30000000-0000-4000-8000-000000000002",
      quote: "Mara is bonded to Nyx.",
    }],
  });
  const transformation = canonClaim({
    claim_id: "20000000-0000-4000-8000-000000000004",
    predicate: "can transform into",
    object_entity_id: null,
    object_text: "an armored form",
    evidence: [{
      evidenceKey: "reveal",
      sourceId: "30000000-0000-4000-8000-000000000001",
      chunkId: "30000000-0000-4000-8000-000000000002",
      quote: "Mara can transform into an armored form.",
    }],
  });
  const before = buildWorldStudioCampaignRpgSeed({
    ...common,
    anchoredCanonClaims: [bond],
    canonAnchor: { eventId: ANCHOR_EVENT_ID, mode: "before" },
  });
  const after = buildWorldStudioCampaignRpgSeed({
    ...common,
    anchoredCanonClaims: [bond, transformation],
    canonAnchor: { eventId: ANCHOR_EVENT_ID, mode: "after" },
  });
  assert.deepEqual(
    before.initialState.characters[0]?.capabilities.map((capability) => capability.name),
    ["Is Bonded to Nyx"],
  );
  assert.doesNotMatch(JSON.stringify(before), /armored|transform/iu);
  assert.deepEqual(
    after.initialState.characters[0]?.capabilities.map((capability) => capability.name),
    ["Is Bonded to Nyx", "Can Transform into an Armored Form"],
  );
});

test("original unanchored launch seeds preserve premise and copy only supported actor mechanics", () => {
  const worldPremise = "A failing orbital city bargains with the storm below.";
  const seed = buildWorldStudioCampaignRpgSeed({
    campaignId: CAMPAIGN_ID,
    worldId: WORLD_ID,
    editionId: EDITION_ID,
    worldName: "The Last Aerostat",
    worldPremise,
    startingPoint: "Halfway through a disastrous lunch rush.",
    initialObjective: "Keep the shop open without revealing her magic.",
    resolutionMode: "light_rules",
    characterId: CHARACTER_ID,
    characterEntityId: ACTOR_ENTITY_ID,
    characterName: "Mara Vale",
    hasManuscriptCanonSources: false,
    entitySnapshotRows: [actorSnapshot],
    anchoredCanonClaims: null,
  });

  assert.deepEqual(seed.origin, {
    kind: "original",
    worldId: WORLD_ID,
    generatorVersion: "storyhold:original-adventure:v1",
  });
  assert.equal(seed.world.premise, worldPremise);
  assert.equal(seed.initialState.characters[0]?.name, "Mara Vale");
  assert.equal(seed.initialState.characters[0]?.stats.strength, 16);
  assert.equal(seed.initialState.characters[0]?.stats.dexterity, 10);
  assert.deepEqual(
    seed.initialState.characters[0]?.capabilities.map((capability) => capability.name),
    ["Transforming Host"],
  );
  assert.deepEqual(seed.world.facts, []);
  assert.deepEqual(seed.initialState.location, {
    entityId: null,
    name: "Opening Scene",
    zone: "Halfway through a disastrous lunch rush.",
  });
  assert.deepEqual(seed.initialState.objectives, [{
    id: "opening-objective",
    title: "Keep the shop open without revealing her magic.",
    description: "",
    status: "active",
    progress: 0,
    target: 1,
  }]);

  const lineage = campaignRpgSeedLineage(seed);
  assert.equal(lineage.seedId, CAMPAIGN_ID);
  assert.match(lineage.seedSha256, /^[0-9a-f]{64}$/u);
  assert.equal(lineage.initialStateVersion, 0);
  assert.equal(lineage.baselineCampaignStateVersion, 1);
  assert.equal(lineage.origin, "original");
});

test("starting locations require a complete place-name match", () => {
  const seed = buildWorldStudioCampaignRpgSeed({
    campaignId: CAMPAIGN_ID,
    worldId: WORLD_ID,
    editionId: EDITION_ID,
    worldName: "The Unwritten Road",
    worldPremise: "A road changes when no one is looking.",
    startingPoint: "At the beginning of the longest night.",
    initialObjective: "Reach shelter before dawn.",
    resolutionMode: "story_first",
    characterId: CHARACTER_ID,
    characterEntityId: ACTOR_ENTITY_ID,
    characterName: "Mara",
    hasManuscriptCanonSources: false,
    entitySnapshotRows: [actorSnapshot, innSnapshot],
    anchoredCanonClaims: null,
  });

  assert.deepEqual(seed.initialState.location, {
    entityId: null,
    name: "Opening Scene",
    zone: "At the beginning of the longest night.",
  });
});

test("campaign RPG schema initializes after campaigns exists", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.campaigns (id uuid PRIMARY KEY);
    `);
    await ensureCampaignRpgPersistence(db);
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'storyhold' AND table_name LIKE 'campaign_rpg_%'
        ORDER BY table_name`,
    );
    assert.deepEqual(tables.rows.map((row) => row.table_name), [
      "campaign_rpg_seeds",
      "campaign_rpg_state_events",
      "campaign_rpg_states",
    ]);
  } finally {
    await db.close();
  }
});

test("campaign launch and RPG initialization roll back atomically", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.campaigns (id uuid PRIMARY KEY);
    `);
    await ensureCampaignRpgPersistence(db);
    const seed = buildWorldStudioCampaignRpgSeed({
      campaignId: CAMPAIGN_ID,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
      worldName: "Rollback Hold",
      worldPremise: "Nothing survives a partial launch.",
      startingPoint: "At the edge of the storm.",
      initialObjective: "Find shelter before the storm arrives.",
      resolutionMode: "tactical",
      characterId: CHARACTER_ID,
      characterEntityId: ACTOR_ENTITY_ID,
      characterName: "Mara",
      hasManuscriptCanonSources: false,
      entitySnapshotRows: [actorSnapshot],
      anchoredCanonClaims: null,
    });

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO storyhold.campaigns (id) VALUES ($1)", [CAMPAIGN_ID]);
        await initializeCampaignRpgStateInTransaction({
          db: tx,
          campaignId: CAMPAIGN_ID,
          seed,
        });
        throw new Error("A later campaign launch write failed.");
      }),
      /later campaign launch write failed/i,
    );
    assert.equal(
      (await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM storyhold.campaigns",
      )).rows[0]?.count,
      0,
    );
    assert.equal(
      (await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM storyhold.campaign_rpg_seeds",
      )).rows[0]?.count,
      0,
    );
    assert.equal(
      (await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM storyhold.campaign_rpg_states",
      )).rows[0]?.count,
      0,
    );
  } finally {
    await db.close();
  }
});
