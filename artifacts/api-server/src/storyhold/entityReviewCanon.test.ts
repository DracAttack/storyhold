import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { entityReviewCanonFingerprint } from "./entityReviewCanon";
import type { EntityReviewCallScope } from "./entityReviewJournal";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const scope: EntityReviewCallScope = { reviewId: id(1), playerId: id(2), worldId: id(3), editionId: id(4), entityId: id(5) };
const ids = { dossier: id(6), counterpart: id(7), faction: id(8), constraint: id(9), relation: id(10), rule: id(11), source: id(12), chunk: id(13), chunk2: id(14),
  world2: id(103), edition2: id(104), entity2: id(105), dossier2: id(106), counterpart2: id(107), constraint2: id(109), relation2: id(110), rule2: id(111), source2: id(112), chunkOther: id(113) };
type QueryDb = Pick<PGlite, "query">;
async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.players (id uuid PRIMARY KEY, credits integer NOT NULL);
    CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY, name text, premise text, genre text, updated_at timestamptz NOT NULL DEFAULT '2026-09-01T12:00:00Z');
    CREATE TABLE storyhold.world_entities (id uuid PRIMARY KEY, world_id uuid, canon_edition_id uuid, dossier_id uuid, name text,
      aliases jsonb DEFAULT '[]', entity_type text DEFAULT 'character', pull_status text DEFAULT 'active', merged_into_entity_id uuid,
      summary text DEFAULT '', details jsonb DEFAULT '[]', estimated_stats jsonb DEFAULT '{}', classification_source text DEFAULT 'ai',
      review_status text DEFAULT 'verified', updated_at timestamptz NOT NULL DEFAULT '2026-09-01T12:00:00Z');
    CREATE TABLE storyhold.character_dossiers (id uuid PRIMARY KEY, world_id uuid, canon_edition_id uuid, summary text, profile jsonb,
      dossier_status text DEFAULT 'active', user_edited_at timestamptz, updated_at timestamptz NOT NULL DEFAULT '2026-09-01T12:00:00Z');
    CREATE TABLE storyhold.world_owner_canon_constraints (id uuid PRIMARY KEY, world_id uuid, canon_edition_id uuid, scope_entity_id uuid,
      constraint_kind text, instruction text, status text DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT '2026-09-01T12:00:00Z');
    CREATE TABLE storyhold.world_entity_relations (id uuid PRIMARY KEY, world_id uuid, canon_edition_id uuid, source_entity_id uuid,
      target_entity_id uuid, relation_type text, relation_status text DEFAULT 'active', summary text DEFAULT '', valid_from_label text DEFAULT '',
      valid_until_label text DEFAULT '', evidence jsonb DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT '2026-09-01T12:00:00Z');
    CREATE TABLE storyhold.world_entity_rules (id uuid PRIMARY KEY, world_id uuid, canon_edition_id uuid, entity_id uuid,
      name text, description text, trigger_text text, effect_text text, rule_status text DEFAULT 'active', evidence jsonb DEFAULT '[]');
    CREATE TABLE storyhold.world_entity_faction_memberships (entity_id uuid, faction_entity_id uuid, assignment_source text DEFAULT 'ai',
      confidence real DEFAULT 0.8, evidence jsonb DEFAULT '[]', PRIMARY KEY(entity_id,faction_entity_id));
    CREATE TABLE storyhold.world_sources (id uuid PRIMARY KEY, world_id uuid, canon_edition_id uuid, title text, content_hash text,
      processing_status text DEFAULT 'ready', canon_status text DEFAULT 'canon', chronology_order integer DEFAULT 0, sort_order integer DEFAULT 0,
      chronology_relation text DEFAULT 'unspecified', chronology_label text DEFAULT '', chronology_notes text DEFAULT '', source_kind text DEFAULT 'manuscript');
    CREATE TABLE storyhold.world_source_chunks (id uuid PRIMARY KEY, world_id uuid, canon_edition_id uuid, source_id uuid, chunk_index integer,
      content text, embedding_updated_at timestamptz);`);
  await db.query("INSERT INTO storyhold.players VALUES ($1,100)", [scope.playerId]);
  for (const [world, edition, entity, dossier, counterpart, constraint, relation, rule, source, chunk] of [
    [scope.worldId, scope.editionId, scope.entityId, ids.dossier, ids.counterpart, ids.constraint, ids.relation, ids.rule, ids.source, ids.chunk],
    [ids.world2, ids.edition2, ids.entity2, ids.dossier2, ids.counterpart2, ids.constraint2, ids.relation2, ids.rule2, ids.source2, ids.chunkOther],
  ]) {
    await db.query("INSERT INTO storyhold.worlds (id,name,premise,genre) VALUES ($1,'Test world','A guarded gate','Fantasy')", [world]);
    await db.query("INSERT INTO storyhold.world_entities (id,world_id,canon_edition_id,dossier_id,name,aliases,summary,estimated_stats) VALUES ($1,$2,$3,$4,'Mara','[\"Captain Mara\"]','Mara guards the gate.','{\"strength\":{\"score\":14,\"rationale\":\"She lifts the gate.\"}}')", [entity, world, edition, dossier]);
    await db.query("INSERT INTO storyhold.world_entities (id,world_id,canon_edition_id,name) VALUES ($1,$2,$3,'Dara')", [counterpart, world, edition]);
    await db.query("INSERT INTO storyhold.character_dossiers (id,world_id,canon_edition_id,summary,profile) VALUES ($1,$2,$3,'Mara protects the others.','{\"traits\":[\"protective\"],\"estimatedStats\":{\"strength\":{\"score\":14}},\"nested\":{\"a\":1,\"b\":2}}')", [dossier, world, edition]);
    await db.query("INSERT INTO storyhold.world_owner_canon_constraints (id,world_id,canon_edition_id,scope_entity_id,constraint_kind,instruction) VALUES ($1,$2,$3,$4,'fact','Mara cannot fly.')", [constraint, world, edition, entity]);
    await db.query("INSERT INTO storyhold.world_entity_relations (id,world_id,canon_edition_id,source_entity_id,target_entity_id,relation_type,summary) VALUES ($1,$2,$3,$4,$5,'friend_of','Mara and Dara are friends.')", [relation, world, edition, entity, counterpart]);
    await db.query("INSERT INTO storyhold.world_entity_rules (id,world_id,canon_edition_id,entity_id,name,description,trigger_text,effect_text) VALUES ($1,$2,$3,$4,'Transformation','A temporary stronger form','danger','greater strength')", [rule, world, edition, entity]);
    await db.query("INSERT INTO storyhold.world_sources (id,world_id,canon_edition_id,title,content_hash) VALUES ($1,$2,$3,'Book One','content-v1')", [source, world, edition]);
    await db.query("INSERT INTO storyhold.world_source_chunks (id,world_id,canon_edition_id,source_id,chunk_index,content) VALUES ($1,$2,$3,$4,0,'Mara lifted the gate.')", [chunk, world, edition, source]);
    await db.query("INSERT INTO storyhold.world_entity_faction_memberships (entity_id,faction_entity_id) VALUES ($1,$2)", [entity, counterpart]);
  }
  await db.query("INSERT INTO storyhold.world_source_chunks (id,world_id,canon_edition_id,source_id,chunk_index,content) VALUES ($1,$2,$3,$4,1,'Dara escaped through the open gate.')", [ids.chunk2, scope.worldId, scope.editionId, ids.source]);
  return db;
}
const fingerprint = (db: QueryDb, lock = false) => entityReviewCanonFingerprint(db, scope, [ids.chunk, ids.chunk2], lock);

test("claim-aware fingerprint v2 preserves legacy hashes and binds only relevant scoped claims", async () => {
  const db = await database();
  try {
    const legacy = await fingerprint(db);
    assert.equal(legacy, await entityReviewCanonFingerprint(db, scope, [ids.chunk, ids.chunk2], false, 1));
    await db.exec(`CREATE TABLE storyhold.world_knowledge_claims (id uuid PRIMARY KEY, world_id uuid, canon_edition_id uuid,
      subject_entity_id uuid, object_entity_id uuid, epistemic_holder_entity_id uuid, predicate text, object_text text,
      polarity text DEFAULT 'positive', truth_status text DEFAULT 'fact', valid_from_label text DEFAULT '', valid_until_label text DEFAULT '',
      claim_status text DEFAULT 'active', assignment_source text DEFAULT 'ai', evidence jsonb DEFAULT '[]', confidence real DEFAULT 0.9);`);
    const v2 = (tx: QueryDb, lock = false) => entityReviewCanonFingerprint(tx, scope, [ids.chunk, ids.chunk2], lock, 2);
    const empty = await v2(db);
    assert.notEqual(empty, legacy);
    for (const column of ["subject_entity_id", "object_entity_id", "epistemic_holder_entity_id"]) {
      const rollback = new Error("Rollback claim addition");
      await assert.rejects(db.transaction(async (tx) => {
        await tx.query(`INSERT INTO storyhold.world_knowledge_claims (id,world_id,canon_edition_id,${column},predicate,object_text)
          VALUES($1,$2,$3,$4,'dossier.summary','Mara protects the gate.')`, [id(81), scope.worldId, scope.editionId, scope.entityId]);
        assert.notEqual(await v2(tx), empty, `${column} is bound`);
        assert.equal(await v2(tx), await v2(tx, true));
        assert.equal(await fingerprint(tx), legacy, "legacy snapshots do not gain new authority");
        throw rollback;
      }), (error: unknown) => error === rollback);
    }
    await db.query(`INSERT INTO storyhold.world_knowledge_claims (id,world_id,canon_edition_id,subject_entity_id,predicate,object_text)
      VALUES($1,$2,$3,$4,'dossier.summary','Mara protects the gate.')`, [id(81), scope.worldId, scope.editionId, scope.entityId]);
    const populated = await v2(db);
    for (const change of ["object_text='The gate is undefended.'", "assignment_source='user'", "claim_status='rejected'",
      "truth_status='belief'", "polarity='negative'", "valid_from_label='Book Two'", "valid_until_label='The ending'",
      "evidence='[{\"quote\":\"An owner corrected the claim.\"}]'"]) {
      const rollback = new Error("Rollback claim edit");
      await assert.rejects(db.transaction(async (tx) => {
        await tx.query(`UPDATE storyhold.world_knowledge_claims SET ${change} WHERE id=$1`, [id(81)]);
        assert.notEqual(await v2(tx), populated, change);
        throw rollback;
      }), (error: unknown) => error === rollback);
    }
    for (const [world, edition, subject] of [[ids.world2, ids.edition2, scope.entityId],
      [scope.worldId, ids.edition2, scope.entityId], [scope.worldId, scope.editionId, ids.counterpart]]) {
      await db.query(`INSERT INTO storyhold.world_knowledge_claims (id,world_id,canon_edition_id,subject_entity_id,predicate,object_text)
        VALUES($1,$2,$3,$4,'dossier.summary','Unrelated canon.')`, [id(world === ids.world2 ? 82 : edition === ids.edition2 ? 83 : 84), world, edition, subject]);
      assert.equal(await v2(db), populated, "another world, edition, or unrelated subject is excluded");
    }
    assert.equal(await fingerprint(db), legacy);
  } finally { await db.close(); }
});

async function invalidates(db: PGlite, mutation: (tx: QueryDb) => Promise<unknown>, label: string) {
  const before = await fingerprint(db);
  const rollback = new Error("Rollback tested canonical mutation");
  await assert.rejects(db.transaction(async (tx) => {
    await mutation(tx);
    assert.notEqual(await fingerprint(tx), before, label);
    assert.equal(await fingerprint(tx), await fingerprint(tx, true), `${label}: locked and unlocked reads match`);
    throw rollback;
  }), (error: unknown) => error === rollback);
  assert.equal(await fingerprint(db), before, "fixture rollback restores the prior canonical snapshot");
}

test("canonical fingerprints are stable across locked reads, JSONB key order, and timestamp round trips", async () => {
  const db = await database();
  try {
    const first = await fingerprint(db);
    assert.equal(first, await db.transaction((tx) => fingerprint(tx, true)));
    assert.equal(first, await entityReviewCanonFingerprint(db, JSON.parse(JSON.stringify(scope)), [ids.chunk2, ids.chunk]));
    const row = (await db.query<{ profile: unknown; updated_at: Date }>("SELECT profile, updated_at FROM storyhold.character_dossiers WHERE id = $1", [ids.dossier])).rows[0]!;
    const profile = JSON.parse(JSON.stringify(row.profile));
    profile.nested = { b: 2, a: 1 };
    await db.query("UPDATE storyhold.character_dossiers SET profile=$2::jsonb, updated_at=$3 WHERE id=$1", [ids.dossier, JSON.stringify(profile), row.updated_at.toISOString()]);
    await db.exec("SET TIME ZONE 'America/Phoenix'");
    assert.equal(await fingerprint(db), first);
  } finally { await db.close(); }
});

test("added, revised, and dismissed author canon constraints invalidate a saved reading", async () => {
  const db = await database();
  try {
    await invalidates(db, (tx) => tx.query("INSERT INTO storyhold.world_owner_canon_constraints (id,world_id,canon_edition_id,constraint_kind,instruction) VALUES ($1,$2,$3,'relationship','Dara is not Mara\'\'s child.')", [id(50), scope.worldId, scope.editionId]), "new world-wide owner constraint");
    await invalidates(db, (tx) => tx.query("UPDATE storyhold.world_owner_canon_constraints SET instruction='Mara can fly in one form.' WHERE id=$1", [ids.constraint]), "changed owner instruction");
    await invalidates(db, (tx) => tx.query("UPDATE storyhold.world_owner_canon_constraints SET status='dismissed' WHERE id=$1", [ids.constraint]), "dismissed owner instruction");
    await invalidates(db, (tx) => tx.query("DELETE FROM storyhold.world_owner_canon_constraints WHERE id=$1", [ids.constraint]), "removed owner instruction");
  } finally { await db.close(); }
});

test("target and dossier prose, profile, stats, and owner-edited status invalidate results", async () => {
  const db = await database();
  try {
    for (const [sql, label] of [
      ["UPDATE storyhold.world_entities SET summary='An owner-authored revision.' WHERE id=$1", "target prose"],
      ["UPDATE storyhold.world_entities SET details='[\"New defining fact\"]' WHERE id=$1", "target details"],
      ["UPDATE storyhold.world_entities SET estimated_stats='{}' WHERE id=$1", "target stats"],
      ["UPDATE storyhold.world_entities SET review_status='user_confirmed' WHERE id=$1", "owner-confirmed target"],
    ]) await invalidates(db, (tx) => tx.query(sql!, [scope.entityId]), label!);
    for (const [sql, label] of [
      ["UPDATE storyhold.character_dossiers SET summary='Mara secretly guards a second passage.' WHERE id=$1", "dossier prose"],
      ["UPDATE storyhold.character_dossiers SET profile=jsonb_set(profile,'{traits}','[\"suspicious\"]') WHERE id=$1", "dossier character profile"],
      ["UPDATE storyhold.character_dossiers SET profile=jsonb_set(profile,'{estimatedStats,strength,score}','19') WHERE id=$1", "dossier stat score"],
      ["UPDATE storyhold.character_dossiers SET user_edited_at='2026-09-02T12:00:00Z' WHERE id=$1", "owner edit marker"],
      ["UPDATE storyhold.character_dossiers SET dossier_status='inactive' WHERE id=$1", "retired dossier"],
    ]) await invalidates(db, (tx) => tx.query(sql!, [ids.dossier]), label!);
  } finally { await db.close(); }
});

test("aliases, categories, merged identities, and hidden relationship counterparts invalidate", async () => {
  const db = await database();
  try {
    for (const entity of [scope.entityId, ids.counterpart]) {
      await invalidates(db, (tx) => tx.query("UPDATE storyhold.world_entities SET aliases='[\"The Gatekeeper\"]' WHERE id=$1", [entity]), "new identity alias");
      await invalidates(db, (tx) => tx.query("UPDATE storyhold.world_entities SET entity_type='creature' WHERE id=$1", [entity]), "changed entity category");
      await invalidates(db, (tx) => tx.query("UPDATE storyhold.world_entities SET pull_status='hidden' WHERE id=$1", [entity]), "hidden record");
      await invalidates(db, (tx) => tx.query("UPDATE storyhold.world_entities SET merged_into_entity_id=$2 WHERE id=$1", [entity, id(77)]), "merged canonical identity");
    }
    await invalidates(db, (tx) => tx.query("INSERT INTO storyhold.world_entities (id,world_id,canon_edition_id,name) VALUES ($1,$2,$3,'New owner-created record')", [id(78), scope.worldId, scope.editionId]), "new canonical name inventory");
  } finally { await db.close(); }
});

test("relationship direction, temporal status, boundaries, rules, and membership evidence invalidate", async () => {
  const db = await database();
  try {
    for (const [sql, label] of [
      ["UPDATE storyhold.world_entity_relations SET relation_status='former' WHERE id=$1", "later former relationship"],
      ["UPDATE storyhold.world_entity_relations SET valid_from_label='Chapter 12',valid_until_label='Book Two ending' WHERE id=$1", "relationship chronology"],
      ["UPDATE storyhold.world_entity_relations SET relation_type='opposed_to' WHERE id=$1", "changed relationship type"],
      ["UPDATE storyhold.world_entity_relations SET source_entity_id=target_entity_id,target_entity_id=source_entity_id WHERE id=$1", "direction reversal"],
      ["UPDATE storyhold.world_entity_relations SET evidence='[{\"quote\":\"They fought after the betrayal.\"}]' WHERE id=$1", "relationship evidence"],
    ]) await invalidates(db, (tx) => tx.query(sql!, [ids.relation]), label!);
    for (const [sql, label] of [
      ["UPDATE storyhold.world_entity_rules SET description='Owner revised the limitation.' WHERE id=$1", "rule prose"],
      ["UPDATE storyhold.world_entity_rules SET trigger_text='only after sunset',effect_text='temporary heightened strength' WHERE id=$1", "rule conditions and effect"],
      ["UPDATE storyhold.world_entity_rules SET rule_status='retired' WHERE id=$1", "retired rule"],
    ]) await invalidates(db, (tx) => tx.query(sql!, [ids.rule]), label!);
    await invalidates(db, (tx) => tx.query("UPDATE storyhold.world_entity_faction_memberships SET assignment_source='user', evidence='[{\"quote\":\"She left the Watch.\"}]' WHERE entity_id=$1", [scope.entityId]), "owner membership evidence");
    await invalidates(db, (tx) => tx.query("DELETE FROM storyhold.world_entity_faction_memberships WHERE entity_id=$1", [scope.entityId]), "removed faction membership");
    await invalidates(db, (tx) => tx.query("INSERT INTO storyhold.world_entity_faction_memberships (entity_id,faction_entity_id) VALUES ($1,$2)", [ids.counterpart, scope.entityId]), "incoming membership where reviewed entity is faction");
  } finally { await db.close(); }
});

test("selected manuscript text/source and book chronology, exclusion, and new sources invalidate", async () => {
  const db = await database();
  try {
    await invalidates(db, (tx) => tx.query("UPDATE storyhold.world_source_chunks SET content='Dara, not Mara, lifted the gate.' WHERE id=$1", [ids.chunk]), "revised selected manuscript passage");
    await invalidates(db, (tx) => tx.query("UPDATE storyhold.world_source_chunks SET source_id=$2 WHERE id=$1", [ids.chunk, ids.source2]), "changed passage source identity");
    await invalidates(db, (tx) => tx.query("DELETE FROM storyhold.world_source_chunks WHERE id=$1", [ids.chunk]), "removed selected passage");
    for (const [sql, label] of [
      ["UPDATE storyhold.world_sources SET chronology_order=2 WHERE id=$1", "source chronology order"],
      ["UPDATE storyhold.world_sources SET sort_order=3 WHERE id=$1", "source sort order"],
      ["UPDATE storyhold.world_sources SET chronology_relation='precedes' WHERE id=$1", "source temporal relation"],
      ["UPDATE storyhold.world_sources SET chronology_label='Five years earlier' WHERE id=$1", "source temporal label"],
      ["UPDATE storyhold.world_sources SET chronology_notes='This volume runs in parallel to Book Two.' WHERE id=$1", "source chronology notes"],
      ["UPDATE storyhold.world_sources SET source_kind='reference' WHERE id=$1", "source changed to reference material"],
      ["UPDATE storyhold.world_sources SET canon_status='excluded' WHERE id=$1", "excluded book"],
      ["UPDATE storyhold.world_sources SET content_hash='content-v2' WHERE id=$1", "new source edition"],
    ]) await invalidates(db, (tx) => tx.query(sql!, [ids.source]), label!);
    await invalidates(db, (tx) => tx.query("INSERT INTO storyhold.world_sources (id,world_id,canon_edition_id,title,content_hash) VALUES ($1,$2,$3,'New sequel','sequel-hash')", [id(70), scope.worldId, scope.editionId]), "new unselected sequel");
  } finally { await db.close(); }
});

test("billing changes, world UI activity, and unselected embeddings do not stale canon", async () => {
  const db = await database();
  try {
    const before = await fingerprint(db);
    await db.query("UPDATE storyhold.players SET credits=40 WHERE id=$1", [scope.playerId]);
    await db.query("UPDATE storyhold.worlds SET updated_at=now() WHERE id=$1", [scope.worldId]);
    await db.query("UPDATE storyhold.world_source_chunks SET embedding_updated_at=now() WHERE id=$1", [ids.chunk]);
    assert.equal(await fingerprint(db), before);
    await invalidates(db, (tx) => tx.query("UPDATE storyhold.worlds SET premise='A different core premise.' WHERE id=$1", [scope.worldId]), "owner premise revision");
  } finally { await db.close(); }
});

test("changes in another world do not invalidate this dossier's canonical snapshot", async () => {
  const db = await database();
  try {
    const before = await fingerprint(db);
    await db.query("UPDATE storyhold.worlds SET name='Unrelated world renamed',premise='Changed',genre='Science fiction' WHERE id=$1", [ids.world2]);
    await db.query("UPDATE storyhold.world_entities SET name='Changed counterpart',aliases='[\"Unknown\"]',entity_type='creature',pull_status='hidden' WHERE world_id=$1", [ids.world2]);
    await db.query("UPDATE storyhold.character_dossiers SET summary='Unrelated dossier rewrite',profile='{}' WHERE world_id=$1", [ids.world2]);
    await db.query("UPDATE storyhold.world_owner_canon_constraints SET instruction='Unrelated correction',status='dismissed' WHERE world_id=$1", [ids.world2]);
    await db.query("UPDATE storyhold.world_entity_relations SET relation_type='opposed_to',relation_status='former' WHERE world_id=$1", [ids.world2]);
    await db.query("UPDATE storyhold.world_entity_rules SET trigger_text='other trigger' WHERE world_id=$1", [ids.world2]);
    await db.query("DELETE FROM storyhold.world_entity_faction_memberships WHERE entity_id=$1", [ids.entity2]);
    await db.query("UPDATE storyhold.world_sources SET canon_status='excluded',chronology_order=9 WHERE world_id=$1", [ids.world2]);
    await db.query("UPDATE storyhold.world_source_chunks SET content='Other book changed.' WHERE world_id=$1", [ids.world2]);
    assert.equal(await fingerprint(db), before);
  } finally { await db.close(); }
});
