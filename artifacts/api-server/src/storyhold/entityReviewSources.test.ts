import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { loadEntityReviewManuscriptChunks } from "./entityReviewSources";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const scope = { worldId: id(1), editionId: id(2), playerId: id(3) };

test("additional-passage corpus contains full text across books only inside the owned manuscript edition", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.worlds(id uuid PRIMARY KEY, owner_player_id uuid);
      CREATE TABLE storyhold.world_sources(id uuid PRIMARY KEY, world_id uuid, canon_edition_id uuid,
        title text, source_kind text DEFAULT 'manuscript', processing_status text DEFAULT 'ready',
        canon_status text DEFAULT 'canon', chronology_order int DEFAULT 0, sort_order int DEFAULT 0,
        created_at timestamptz DEFAULT '2026-09-04');
      CREATE TABLE storyhold.world_source_chunks(id uuid PRIMARY KEY, source_id uuid, world_id uuid,
        canon_edition_id uuid, chunk_index int, content text, metadata jsonb DEFAULT '{}');`);
    await db.query("INSERT INTO storyhold.worlds VALUES($1,$2),($3,$4)", [scope.worldId,scope.playerId,id(4),id(5)]);
    const longText = "The winter reunion was in the second book. ".repeat(500);
    for (let index = 0; index < 8; index++) {
      await db.query(`INSERT INTO storyhold.world_sources(id,world_id,canon_edition_id,title,chronology_order)
        VALUES($1,$2,$3,$4,$5)`, [id(10+index),scope.worldId,scope.editionId,`Book ${index}`,index]);
      await db.query(`INSERT INTO storyhold.world_source_chunks(id,source_id,world_id,canon_edition_id,chunk_index,content)
        VALUES($1,$2,$3,$4,0,$5)`, [id(30+index),id(10+index),scope.worldId,scope.editionId,index===1?longText:`Passage ${index}`]);
    }
    await db.query("UPDATE storyhold.world_sources SET source_kind='reference' WHERE id=$1", [id(12)]);
    await db.query("UPDATE storyhold.world_sources SET canon_status='excluded' WHERE id=$1", [id(13)]);
    await db.query("UPDATE storyhold.world_sources SET processing_status='processing' WHERE id=$1", [id(14)]);
    await db.query("UPDATE storyhold.world_sources SET world_id=$1 WHERE id=$2", [id(4),id(15)]);
    await db.query("UPDATE storyhold.world_sources SET canon_edition_id=$1 WHERE id=$2", [id(99),id(16)]);
    await db.query("UPDATE storyhold.world_source_chunks SET canon_edition_id=$1 WHERE id=$2", [id(99),id(37)]);
    const before = (await db.query("SELECT * FROM storyhold.world_source_chunks ORDER BY id")).rows;
    const result = await loadEntityReviewManuscriptChunks(db, scope);
    assert.deepEqual(result.map((row) => row.id), [id(30),id(31)]);
    assert.equal(result[1]!.content, longText, "Whole passages survive, including text without the entity's name");
    assert.deepEqual(await loadEntityReviewManuscriptChunks(db, {...scope,playerId:id(5)}), []);
    assert.deepEqual((await db.query("SELECT * FROM storyhold.world_source_chunks ORDER BY id")).rows, before);
    await db.query("UPDATE storyhold.world_sources SET canon_status='candidate' WHERE id=$1", [id(11)]);
    assert.equal((await loadEntityReviewManuscriptChunks(db, scope)).length, 2);
  } finally { await db.close(); }
});
