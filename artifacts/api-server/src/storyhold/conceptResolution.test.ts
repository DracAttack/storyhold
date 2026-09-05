import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  conceptResolutionSchemaSql,
  enforceOwnerCanonConstraints,
  extractDirectedRelationshipHypotheses,
  loadOwnerCanonConstraints,
  ownerGuidanceKind,
  saveOwnerCanonConstraint,
  scoreStoryConcept,
  syncMentionCountsFromConceptGraph,
} from "./conceptResolution";

const WORLD_ID = "20000000-0000-4000-8000-000000000001";
const EDITION_ID = "20000000-0000-4000-8000-000000000002";
const PLAYER_ID = "20000000-0000-4000-8000-000000000003";

async function constraintDatabase() {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.players (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.canon_editions (
      id uuid PRIMARY KEY,
      world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE
    );
    CREATE TABLE storyhold.world_analysis_runs (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.world_entities (
      id uuid PRIMARY KEY,
      world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
      name text NOT NULL DEFAULT '',
      aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
      pull_status text NOT NULL DEFAULT 'active'
    );
    CREATE TABLE storyhold.world_entity_relations (
      id uuid PRIMARY KEY,
      world_id uuid NOT NULL,
      canon_edition_id uuid NOT NULL,
      source_entity_id uuid NOT NULL,
      relation_type text NOT NULL,
      target_entity_id uuid NOT NULL,
      assignment_source text NOT NULL
    );
    CREATE TABLE storyhold.world_entity_faction_memberships (
      entity_id uuid NOT NULL,
      faction_entity_id uuid NOT NULL,
      assignment_source text NOT NULL
    );
  `);
  await db.exec(conceptResolutionSchemaSql);
  await db.query("INSERT INTO storyhold.worlds (id) VALUES ($1)", [WORLD_ID]);
  await db.query("INSERT INTO storyhold.players (id) VALUES ($1)", [PLAYER_ID]);
  await db.query(
    "INSERT INTO storyhold.canon_editions (id, world_id) VALUES ($1, $2)",
    [EDITION_ID, WORLD_ID],
  );
  return db;
}

test("story scoring rewards spread and evidence while exposing contradictions", () => {
  const grounded = scoreStoryConcept({
    mentionCount: 24,
    sourceCount: 2,
    chapterCount: 7,
    evidenceCount: 8,
    relationCount: 4,
    reviewStatus: "verified",
    entityType: "character",
  });
  const conflicted = scoreStoryConcept({
    mentionCount: 24,
    sourceCount: 2,
    chapterCount: 7,
    evidenceCount: 8,
    relationCount: 4,
    reviewStatus: "verified",
    entityType: "character",
    conflictingLabels: 2,
  });
  assert.equal(grounded.contradictionPenalty, 0);
  assert.equal(conflicted.contradictionPenalty, 24);
  assert.ok(grounded.total > conflicted.total);
  assert.equal(
    grounded.total,
    grounded.explicitWording + grounded.chapterSpread + grounded.sourceSpread +
      grounded.evidenceDensity + grounded.categoryConsistency +
      grounded.relationshipSupport - grounded.contradictionPenalty,
  );
});

test("concept graph mention totals become the customer-facing entity and dossier totals", async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.world_entities (
      id uuid PRIMARY KEY,
      world_id uuid NOT NULL,
      canon_edition_id uuid NOT NULL,
      dossier_id uuid,
      mention_count integer NOT NULL DEFAULT 0,
      mention_source_count integer NOT NULL DEFAULT 0
    );
    CREATE TABLE storyhold.character_dossiers (
      id uuid PRIMARY KEY,
      world_id uuid NOT NULL,
      canon_edition_id uuid NOT NULL,
      mention_count integer NOT NULL DEFAULT 0,
      mention_source_count integer NOT NULL DEFAULT 0
    );
    CREATE TABLE storyhold.world_concept_clusters (
      world_id uuid NOT NULL,
      canon_edition_id uuid NOT NULL,
      entity_id uuid NOT NULL,
      mention_count integer NOT NULL,
      source_count integer NOT NULL
    );
  `);
  const entityId = "20000000-0000-4000-8000-000000000030";
  const dossierId = "20000000-0000-4000-8000-000000000031";
  await db.query(
    `INSERT INTO storyhold.character_dossiers
      (id, world_id, canon_edition_id, mention_count, mention_source_count)
     VALUES ($1, $2, $3, 0, 0)`,
    [dossierId, WORLD_ID, EDITION_ID],
  );
  await db.query(
    `INSERT INTO storyhold.world_entities
      (id, world_id, canon_edition_id, dossier_id, mention_count, mention_source_count)
     VALUES ($1, $2, $3, $4, 0, 0)`,
    [entityId, WORLD_ID, EDITION_ID, dossierId],
  );
  await db.query(
    `INSERT INTO storyhold.world_concept_clusters
      (world_id, canon_edition_id, entity_id, mention_count, source_count)
     VALUES ($1, $2, $3, 489, 2)`,
    [WORLD_ID, EDITION_ID, entityId],
  );
  await syncMentionCountsFromConceptGraph({
    db,
    worldId: WORLD_ID,
    editionId: EDITION_ID,
  });
  const entity = await db.query<{ mention_count: number; mention_source_count: number }>(
    "SELECT mention_count, mention_source_count FROM storyhold.world_entities WHERE id = $1",
    [entityId],
  );
  const dossier = await db.query<{ mention_count: number; mention_source_count: number }>(
    "SELECT mention_count, mention_source_count FROM storyhold.character_dossiers WHERE id = $1",
    [dossierId],
  );
  assert.deepEqual(entity.rows[0], { mention_count: 489, mention_source_count: 2 });
  assert.deepEqual(dossier.rows[0], { mention_count: 489, mention_source_count: 2 });
  await db.close();
});

test("only explicit corrections become durable canon constraints", () => {
  assert.equal(ownerGuidanceKind("Please go over Ragger's powers again."), null);
  assert.equal(
    ownerGuidanceKind("Echo is not literally Alec's daughter; that bond is metaphorical."),
    "relationship",
  );
  assert.equal(
    ownerGuidanceKind("Book Two happens after the flashback, not before it."),
    "chronology",
  );
});

function relationInput(content: string) {
  const allie = { entityId: "allie", surfaceForm: "Allie", startOffset: content.indexOf("Allie"), endOffset: content.indexOf("Allie") + 5 };
  const dave = { entityId: "dave", surfaceForm: "Dave", startOffset: content.indexOf("Dave"), endOffset: content.indexOf("Dave") + 4 };
  return {
    content,
    mentions: [allie, dave],
    namesById: new Map([["allie", "Allie"], ["dave", "Dave"]]),
  };
}

test("directed family grammar keeps the child and parent in the correct direction", () => {
  const possessive = extractDirectedRelationshipHypotheses(
    relationInput("Allie was Dave's daughter."),
  );
  assert.equal(possessive.length, 1);
  assert.equal(possessive[0]?.subjectName, "Allie");
  assert.equal(possessive[0]?.targetName, "Dave");
  assert.equal(possessive[0]?.relationType, "child_of");

  const parentPhrase = extractDirectedRelationshipHypotheses(
    relationInput("Dave was Allie's father."),
  );
  assert.equal(parentPhrase.length, 1);
  assert.equal(parentPhrase[0]?.subjectName, "Allie");
  assert.equal(parentPhrase[0]?.targetName, "Dave");
});

test("figurative family language is not proposed as literal kinship", () => {
  const content = "Echo was not literally Alec's daughter; he only thought of her as family.";
  const result = extractDirectedRelationshipHypotheses({
    content,
    mentions: [
      { entityId: "echo", surfaceForm: "Echo", startOffset: 0, endOffset: 4 },
      { entityId: "alec", surfaceForm: "Alec", startOffset: content.indexOf("Alec"), endOffset: content.indexOf("Alec") + 4 },
    ],
    namesById: new Map([["echo", "Echo"], ["alec", "Alec"]]),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.interpretation, "figurative");
});

test("cheap directed claims keep membership and manifested creature identity provisional", () => {
  const membership = "Ragger joined Sanctuary after the Co-op fell.";
  const membershipResult = extractDirectedRelationshipHypotheses({
    content: membership,
    mentions: [
      { entityId: "ragger", surfaceForm: "Ragger", startOffset: membership.indexOf("Ragger"), endOffset: membership.indexOf("Ragger") + 6 },
      { entityId: "sanctuary", surfaceForm: "Sanctuary", startOffset: membership.indexOf("Sanctuary"), endOffset: membership.indexOf("Sanctuary") + 9 },
    ],
    namesById: new Map([["ragger", "Ragger"], ["sanctuary", "Sanctuary"]]),
    typesById: new Map([["ragger", "character"], ["sanctuary", "faction"]]),
  });
  assert.equal(membershipResult[0]?.relationType, "member_of");
  assert.equal(membershipResult[0]?.status, "candidate");

  const form = "Michael was the Thrall.";
  const formResult = extractDirectedRelationshipHypotheses({
    content: form,
    mentions: [
      { entityId: "michael", surfaceForm: "Michael", startOffset: form.indexOf("Michael"), endOffset: form.indexOf("Michael") + 7 },
      { entityId: "thrall", surfaceForm: "Thrall", startOffset: form.indexOf("Thrall"), endOffset: form.indexOf("Thrall") + 6 },
    ],
    namesById: new Map([["michael", "Michael"], ["thrall", "Thrall"]]),
    typesById: new Map([["michael", "character"], ["thrall", "creature"]]),
  });
  assert.equal(formResult[0]?.relationType, "has_form");
});

test("owner constraints are durable, deduplicated, and dismissible data", async () => {
  const db = await constraintDatabase();
  const first = await saveOwnerCanonConstraint({
    db,
    worldId: WORLD_ID,
    editionId: EDITION_ID,
    playerId: PLAYER_ID,
    instruction: "Echo is not literally Alec's daughter.",
  });
  const repeated = await saveOwnerCanonConstraint({
    db,
    worldId: WORLD_ID,
    editionId: EDITION_ID,
    playerId: PLAYER_ID,
    instruction: "  Echo is not literally Alec's daughter.  ",
  });
  assert.ok(first);
  assert.equal(repeated?.id, first?.id);
  assert.equal((await loadOwnerCanonConstraints({ db, worldId: WORLD_ID, editionId: EDITION_ID })).length, 1);
  await db.close();
});

test("a permanent correction removes only generated contradictory edges", async () => {
  const db = await constraintDatabase();
  const allieId = "20000000-0000-4000-8000-000000000010";
  const daveId = "20000000-0000-4000-8000-000000000011";
  await db.query(
    `INSERT INTO storyhold.world_entities
      (id, world_id, canon_edition_id, name) VALUES
      ($1, $3, $4, 'Allie'), ($2, $3, $4, 'Dave')`,
    [allieId, daveId, WORLD_ID, EDITION_ID],
  );
  await db.query(
    `INSERT INTO storyhold.world_entity_relations
      (id, world_id, canon_edition_id, source_entity_id, relation_type, target_entity_id, assignment_source)
     VALUES
      ('20000000-0000-4000-8000-000000000020', $1, $2, $4, 'child_of', $3, 'ai'),
      ('20000000-0000-4000-8000-000000000021', $1, $2, $3, 'friend_of', $4, 'user')`,
    [WORLD_ID, EDITION_ID, allieId, daveId],
  );
  await saveOwnerCanonConstraint({
    db,
    worldId: WORLD_ID,
    editionId: EDITION_ID,
    playerId: PLAYER_ID,
    entityId: allieId,
    instruction: "Dave is not Allie's child. That relationship was recorded the wrong way around.",
  });
  const result = await enforceOwnerCanonConstraints({
    db,
    worldId: WORLD_ID,
    editionId: EDITION_ID,
    entityId: allieId,
  });
  assert.equal(result.removedGeneratedRelations, 1);
  const remaining = await db.query<{ relation_type: string; assignment_source: string }>(
    "SELECT relation_type, assignment_source FROM storyhold.world_entity_relations ORDER BY relation_type",
  );
  assert.deepEqual(remaining.rows, [{ relation_type: "friend_of", assignment_source: "user" }]);
  await db.close();
});
