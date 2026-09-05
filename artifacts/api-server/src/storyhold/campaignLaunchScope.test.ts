import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import {
  campaignCharacterScopeSchemaSql,
  campaignScopedPlayerEntitySnapshot,
  createCampaignScopedCharacter,
  findWorldCanonicalCharacter,
  loadWorldAuthorStoryDraftAccess,
  prepareEditionLockedCampaignCanonScope,
  withCampaignScopedPlayerSnapshot,
  worldStudioSchemaSql,
} from "./worldStudio";
import {
  campaignCanonScopeSchemaSql,
  createCampaignCanonScopeSnapshot,
  lockedCampaignCanonScope,
  persistCampaignCanonScopeSnapshots,
  stableCanonSha256,
} from "./campaignCanonScope";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const WORLD = id(1), OTHER_WORLD = id(2), PLAYER = id(3), CAMPAIGN = id(4);
const BRANCH = id(5), CHARACTER = id(6), EDITION = id(7), SOURCE = id(8);
const CHUNK = id(9), ENTITY = id(10), CLAIM = id(11);

const lifecycleSchema = `
  CREATE SCHEMA storyhold;
  CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY);
  CREATE TABLE storyhold.characters (
    id uuid PRIMARY KEY, world_id uuid NOT NULL REFERENCES storyhold.worlds ON DELETE CASCADE,
    created_by_player_id uuid, canonical_key text, name text,
    initial_profile jsonb DEFAULT '{}', profile_locked_at timestamptz DEFAULT now()
  );
  CREATE TABLE storyhold.campaigns (
    id uuid PRIMARY KEY, world_id uuid NOT NULL REFERENCES storyhold.worlds ON DELETE RESTRICT,
    perspective_character_id uuid REFERENCES storyhold.characters ON DELETE SET NULL,
    start_locked_at timestamptz DEFAULT now(), start_contract jsonb DEFAULT '{}'
  );
  CREATE TABLE storyhold.campaign_members (
    campaign_id uuid REFERENCES storyhold.campaigns ON DELETE CASCADE,
    player_id uuid, character_id uuid REFERENCES storyhold.characters ON DELETE RESTRICT
  );
  CREATE TABLE storyhold.vault_memory_chunks (
    world_id uuid REFERENCES storyhold.worlds ON DELETE CASCADE,
    campaign_id uuid REFERENCES storyhold.campaigns ON DELETE CASCADE,
    character_id uuid REFERENCES storyhold.characters ON DELETE RESTRICT
  );
  CREATE FUNCTION storyhold.lock_start() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF OLD.start_locked_at IS NOT NULL AND
       NEW.perspective_character_id IS DISTINCT FROM OLD.perspective_character_id THEN
      RAISE EXCEPTION 'A locked campaign start cannot be changed';
    END IF;
    RETURN NEW;
  END; $$;
  CREATE TRIGGER locked_start BEFORE UPDATE ON storyhold.campaigns
    FOR EACH ROW EXECUTE FUNCTION storyhold.lock_start();
`;

test("world studio upgrades pre-branch campaigns before creating world-card summaries", async () => {
  const db = await PGlite.create({ extensions: { vector } });
  try {
    // Deliberately omit every later campaignPlay column. World Studio runs
    // first on startup and must not depend on campaignPlay having run before.
    await db.exec(`CREATE EXTENSION vector;
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.players (id uuid PRIMARY KEY);
      CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY);
      CREATE TABLE storyhold.characters (id uuid PRIMARY KEY, world_id uuid, name text);
      CREATE TABLE storyhold.campaigns (id uuid PRIMARY KEY, world_id uuid,
        ruleset_id uuid, owner_player_id uuid, start_contract jsonb DEFAULT '{}',
        start_locked_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now());`);
    await db.query("INSERT INTO storyhold.worlds VALUES ($1), ($2)", [WORLD, OTHER_WORLD]);
    await db.query("INSERT INTO storyhold.campaigns (id, world_id) VALUES ($1, $2)", [CAMPAIGN, WORLD]);
    await db.exec(worldStudioSchemaSql);
    assert.equal((await db.query("SELECT campaign_count FROM storyhold.world_card_stats WHERE world_id = $1", [WORLD])).rows[0]?.campaign_count, 1);
    await db.query("INSERT INTO storyhold.campaigns (id, world_id, parent_campaign_id) VALUES ($1, $2, $3)", [BRANCH, WORLD, CAMPAIGN]);
    // The second startup is idempotent and a branch is not another adventure.
    await db.exec(worldStudioSchemaSql);
    assert.deepEqual((await db.query("SELECT world_id, campaign_count FROM storyhold.world_card_stats ORDER BY world_id")).rows, [
      { world_id: WORLD, campaign_count: 1 }, { world_id: OTHER_WORLD, campaign_count: 0 },
    ]);
    assert.equal((await db.query("SELECT parent_campaign_id FROM storyhold.campaigns WHERE id = $1", [BRANCH])).rows[0]?.parent_campaign_id, CAMPAIGN);
  } finally { await db.close(); }
});

test("campaign-only heroes survive deleting their parent and disappear with the world", async () => {
  const db = new PGlite();
  try {
    await db.exec(lifecycleSchema);
    await db.exec(campaignCharacterScopeSchemaSql);
    await db.query("INSERT INTO storyhold.worlds VALUES ($1), ($2)", [WORLD, OTHER_WORLD]);
    await db.transaction(async (tx) => {
      await createCampaignScopedCharacter(tx as never, {
        characterId: CHARACTER, campaignId: CAMPAIGN, worldId: WORLD,
        playerId: PLAYER, name: "Mara", concept: "A traveling locksmith.",
      });
      await tx.query(
        "INSERT INTO storyhold.campaigns (id, world_id, perspective_character_id) VALUES ($1, $2, $3), ($4, $2, $3)",
        [CAMPAIGN, WORLD, CHARACTER, BRANCH],
      );
      await tx.query("INSERT INTO storyhold.campaign_members VALUES ($1, $2, $3), ($4, $2, $3)",
        [CAMPAIGN, PLAYER, CHARACTER, BRANCH]);
      await tx.query("INSERT INTO storyhold.vault_memory_chunks VALUES ($1, $2, $3), ($1, $4, $3)",
        [WORLD, CAMPAIGN, CHARACTER, BRANCH]);
    });
    // Reproduce and then upgrade the earlier installed cascading migration.
    await db.exec(`ALTER TABLE storyhold.characters DROP CONSTRAINT characters_scope_campaign_fk;
      ALTER TABLE storyhold.characters DROP CONSTRAINT characters_scope_shape_check;
      ALTER TABLE storyhold.characters ADD CONSTRAINT characters_scope_shape_check CHECK (
        (scope_kind = 'world' AND scope_campaign_id IS NULL) OR
        (scope_kind = 'campaign' AND scope_campaign_id IS NOT NULL)
      );
      ALTER TABLE storyhold.characters ADD CONSTRAINT characters_scope_campaign_fk
        FOREIGN KEY (scope_campaign_id) REFERENCES storyhold.campaigns ON DELETE CASCADE
        DEFERRABLE INITIALLY DEFERRED;`);
    await db.exec(campaignCharacterScopeSchemaSql);
    await db.exec(campaignCharacterScopeSchemaSql);
    assert.equal(await findWorldCanonicalCharacter(db as never, { characterId: CHARACTER, worldId: WORLD }), null);
    assert.equal(await findWorldCanonicalCharacter(db as never, { characterId: CHARACTER, worldId: OTHER_WORLD }), null);
    await db.query("DELETE FROM storyhold.campaigns WHERE id = $1", [CAMPAIGN]);
    const hero = (await db.query("SELECT scope_kind, scope_campaign_id FROM storyhold.characters WHERE id = $1", [CHARACTER])).rows[0];
    assert.deepEqual(hero, { scope_kind: "campaign", scope_campaign_id: null });
    assert.equal((await db.query("SELECT perspective_character_id FROM storyhold.campaigns WHERE id = $1", [BRANCH])).rows[0]?.perspective_character_id, CHARACTER);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM storyhold.campaign_members WHERE campaign_id = $1", [BRANCH])).rows[0]?.count, 1);
    assert.equal(await findWorldCanonicalCharacter(db as never, { characterId: CHARACTER, worldId: WORLD }), null);
    // Delete dependents in the order required by the world's restrictive FKs.
    await db.transaction(async (tx) => {
      await tx.query("DELETE FROM storyhold.campaigns WHERE world_id = $1", [WORLD]);
      await tx.query("DELETE FROM storyhold.worlds WHERE id = $1", [WORLD]);
    });
    assert.equal((await db.query("SELECT count(*)::int AS count FROM storyhold.characters")).rows[0]?.count, 0);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM storyhold.vault_memory_chunks")).rows[0]?.count, 0);
    assert.equal((await db.query("SELECT id FROM storyhold.worlds")).rows[0]?.id, OTHER_WORLD);
  } finally { await db.close(); }
});

test("campaign-only identity snapshots do not contaminate the shared world snapshot", () => {
  const sharedRows = [{ entity_id: ENTITY, canonical_key: "sanctuary", entity_type: "place", name: "Sanctuary" }];
  const shared = { rows: sharedRows, metadata: { count: 1, sha256: stableCanonSha256(sharedRows) } };
  const first = withCampaignScopedPlayerSnapshot(shared, campaignScopedPlayerEntitySnapshot({ characterId: CHARACTER, name: "Mara" }));
  const second = withCampaignScopedPlayerSnapshot(shared, campaignScopedPlayerEntitySnapshot({ characterId: id(20), name: "Iris" }));
  assert.equal(shared.rows.length, 1);
  assert.deepEqual(first.rows.map((row) => row.name).sort(), ["Mara", "Sanctuary"]);
  assert.deepEqual(second.rows.map((row) => row.name).sort(), ["Iris", "Sanctuary"]);
  assert.equal(first.metadata.sha256, stableCanonSha256(first.rows));
  assert.equal(first.rows.find((row) => row.entity_id === CHARACTER)?.dossier_id, null);
});

test("Author Mode story-draft qualification is bound to the current world and owner", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.campaigns(id uuid PRIMARY KEY, world_id uuid);
      CREATE TABLE storyhold.campaign_story_drafts(id uuid PRIMARY KEY, campaign_id uuid, world_id uuid,
        created_by_player_id uuid, status text, source_turn_ids jsonb);
      CREATE TABLE storyhold.campaign_story_draft_versions(draft_id uuid, revision_source text, prose text);`);
    await db.query("INSERT INTO storyhold.campaigns VALUES ($1, $2), ($3, $4)", [CAMPAIGN, WORLD, BRANCH, OTHER_WORLD]);
    await db.query(`INSERT INTO storyhold.campaign_story_drafts VALUES
      ($1, $2, $3, $4, 'ready', '[]'), ($5, $6, $7, $4, 'ready', '[]'),
      ($8, $2, $7, $4, 'ready', '[]'), ($9, $2, $3, $10, 'ready', '[]'),
      ($11, $2, $3, $4, 'archived', '[]')`,
      [id(21), CAMPAIGN, WORLD, PLAYER, id(22), BRANCH, OTHER_WORLD, id(23), id(24), id(25), id(26)]);
    await db.query(`INSERT INTO storyhold.campaign_story_draft_versions VALUES
      ($1, 'ai', 'Current world prose'), ($2, 'ai', 'Other world prose'),
      ($3, 'ai', 'Mismatched campaign'), ($4, 'ai', 'Other owner prose'),
      ($5, 'ai', 'Archived prose'), ($1, 'user', 'User-only revision')`, [id(21), id(22), id(23), id(24), id(26)]);
    const current = await loadWorldAuthorStoryDraftAccess(db as never, { playerId: PLAYER, worldId: WORLD });
    assert.deepEqual(current.rows.map((row) => row.prose), ["Current world prose"]);
    const other = await loadWorldAuthorStoryDraftAccess(db as never, { playerId: PLAYER, worldId: OTHER_WORLD });
    assert.deepEqual(other.rows.map((row) => row.prose), ["Other world prose"]);
  } finally { await db.close(); }
});

test("a current-edition imported start freezes source facts even when no clock exists", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.campaigns(id uuid PRIMARY KEY);
      CREATE TABLE storyhold.world_sources(id uuid PRIMARY KEY, world_id uuid, canon_edition_id uuid,
        content_hash text, title text, source_kind text, chronology_label text, chronology_order int, sort_order int);
      CREATE TABLE storyhold.world_source_chunks(id uuid PRIMARY KEY, source_id uuid, world_id uuid,
        canon_edition_id uuid, content text, content_hash text, chunk_index int);
      CREATE TABLE storyhold.world_knowledge_claims(id uuid PRIMARY KEY, world_id uuid, canon_edition_id uuid,
        subject_entity_id uuid, predicate text, object_text text, truth_status text, claim_status text,
        assignment_source text, evidence jsonb, confidence real);
      CREATE TABLE storyhold.world_entities(id uuid PRIMARY KEY, dossier_id uuid, world_id uuid, canon_edition_id uuid,
        canonical_key text, entity_type text, name text, aliases jsonb, summary text, details jsonb,
        relationships jsonb, mention_count int, confidence real, pull_status text);
      CREATE TABLE storyhold.character_dossiers(id uuid PRIMARY KEY, canonical_character_id uuid, role text,
        summary text, profile jsonb, axis_user_override jsonb, axis_estimate jsonb, dossier_status text);
      CREATE TABLE storyhold.world_entity_faction_memberships(entity_id uuid, faction_entity_id uuid,
        assignment_source text, confidence real);
      CREATE TABLE storyhold.world_entity_relations(id uuid, source_entity_id uuid, target_entity_id uuid,
        relation_type text, relation_status text, summary text, valid_from_label text, valid_until_label text);
      CREATE TABLE storyhold.world_entity_rules(id uuid, entity_id uuid, canonical_key text, name text,
        description text, rule_kind text, trigger_text text, effect_text text, evidence jsonb,
        assignment_source text, confidence real, rule_status text);
      CREATE TABLE storyhold.world_entity_rule_verifications(rule_id uuid);`);
    await db.exec(campaignCanonScopeSchemaSql);
    const content = "Mara guards the western gate. The gate remains closed until dawn.";
    const hash = createHash("sha256").update(content).digest("hex");
    await db.query("INSERT INTO storyhold.campaigns VALUES ($1)", [CAMPAIGN]);
    await db.query("INSERT INTO storyhold.world_sources VALUES ($1, $2, $3, 'edition-hash', 'Book One', 'manuscript', '', 0, 0)", [SOURCE, WORLD, EDITION]);
    await db.query("INSERT INTO storyhold.world_source_chunks VALUES ($1, $2, $3, $4, $5, $6, 0)", [CHUNK, SOURCE, WORLD, EDITION, content, hash]);
    await db.query(`INSERT INTO storyhold.world_entities VALUES
      ($1, NULL, $2, $3, 'mara', 'character', 'Mara', '[]', 'A steadfast guard.', '[]', '[]', 7, 0.9, 'active')`, [ENTITY, WORLD, EDITION]);
    await db.query(`INSERT INTO storyhold.world_knowledge_claims VALUES
      ($1, $2, $3, $4, 'guards', 'the western gate', 'fact', 'active', 'ai', $5::jsonb, 0.9)`,
      [CLAIM, WORLD, EDITION, ENTITY, JSON.stringify([{ sourceId: SOURCE, chunkId: CHUNK, quote: "Mara guards the western gate." }])]);
    const prepared = await prepareEditionLockedCampaignCanonScope(db as never, {
      worldId: WORLD, editionId: EDITION, lockedSources: [{ id: SOURCE, content_hash: "edition-hash" }], selectedPlayerEntityId: ENTITY,
    });
    assert.equal(prepared.evidence[0]?.excerpt, content);
    assert.equal(prepared.claims[0]?.object_text, "the western gate");
    assert.deepEqual(prepared.evidence[0]?.event_ids, []);
    assert.equal(prepared.entitySnapshot.rows[0]?.name, "Mara");
    const scope = lockedCampaignCanonScope({ canonScopeSnapshot: createCampaignCanonScopeSnapshot({
      mode: "edition_locked", evidence: prepared.evidence, claims: prepared.claims, entities: prepared.entitySnapshot.rows,
    }) });
    assert.equal(scope.valid, true);
    assert.equal(scope.strict, true);
    await persistCampaignCanonScopeSnapshots({ db, campaignId: CAMPAIGN, evidence: prepared.evidence, claims: prepared.claims });
    await db.query("UPDATE storyhold.world_source_chunks SET content = 'Rewritten later' WHERE id = $1", [CHUNK]);
    await db.query("UPDATE storyhold.world_knowledge_claims SET object_text = 'the eastern gate' WHERE id = $1", [CLAIM]);
    assert.equal((await db.query("SELECT excerpt FROM storyhold.campaign_canon_evidence_snapshots WHERE campaign_id = $1", [CAMPAIGN])).rows[0]?.excerpt, content);
    assert.equal((await db.query("SELECT object_text FROM storyhold.campaign_canon_claim_snapshots WHERE campaign_id = $1", [CAMPAIGN])).rows[0]?.object_text, "the western gate");
    await assert.rejects(db.query("UPDATE storyhold.campaign_canon_claim_snapshots SET object_text = 'tampered' WHERE campaign_id = $1", [CAMPAIGN]), /append-only/);
  } finally { await db.close(); }
});
