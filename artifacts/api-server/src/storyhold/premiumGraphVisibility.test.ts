import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { buildPremiumGraphRequest, validatePremiumGraphResponse } from "./premiumGraphVerification";
import { parseWorldFindingsFromModel, type EntityRelationFinding } from "./worldAnalysis";
import {
  cleanupCharacterReviewProjections,
  entityIsScannerProtected,
  persistedLocalEntityIsConnectionEligible,
  syncWorldEntities,
} from "./worldStudio";

const scope = {
  worldId: "00000000-0000-4000-8000-000000000701",
  editionId: "00000000-0000-4000-8000-000000000702",
  analysisRunId: "00000000-0000-4000-8000-000000000703",
};
const cleanupScope = { worldId: "world-visibility", editionId: "edition-visibility" };
const quote = "Mira was a member of the Watch.";
const relation: EntityRelationFinding = {
  subject: "Mira", target: "Watch", relationType: "member_of", status: "active",
  summary: "Mira belongs to the Watch.", validFromLabel: "", validUntilLabel: "",
  confidence: 0.9, reviewStatus: "candidate",
  evidence: [{ chunkId: "chunk-1", sourceId: "source-1", quote }],
};
const request = buildPremiumGraphRequest({
  scope, stepKey: "verification:0", chunks: [{ id: "chunk-1", sourceId: "source-1", text: quote }],
  relations: [relation], rules: [], context: {},
});
const receipt = validatePremiumGraphResponse(request, {
  entityRelations: [], entityRules: [], graphVerification: {
    requestFingerprint: request.fingerprint,
    decisions: request.proposals.map((proposal) => ({
      proposalId: proposal.id, verdict: "verified", confidence: 0.9,
      explanation: "The source explicitly identifies Mira's membership.",
      supportingEvidence: [{ chunkId: "chunk-1", quote }], contradictingEvidence: [], retrievalRequests: [],
    })), newFindings: [],
  },
}, { provider: "openai", model: "offline-fixture", completedAt: "2026-09-03T00:00:00.000Z" });

function entityRows() {
  return [
    { id: "mira", name: "Mira", normalized_name: "mira", entity_type: "character", dossier_id: "dossier-mira",
      summary: "A detailed established character card.", details: ["A carefully retained trait."], aliases: ["Captain Mira"],
      classification_source: "ai", review_status: "verified", pull_status: "active", scanner_present: true },
    { id: "watch", name: "Watch", normalized_name: "watch", entity_type: "faction", dossier_id: null,
      summary: "An established faction with detailed history.", details: ["Founded before the winter."], aliases: [],
      classification_source: "local", review_status: "candidate", pull_status: "active", scanner_present: true },
    { id: "hidden", name: "Dara", normalized_name: "dara", entity_type: "character", dossier_id: "dossier-hidden",
      summary: "An owner-hidden card.", details: [], aliases: [],
      classification_source: "ai", review_status: "verified", pull_status: "do_not_pull", scanner_present: true },
  ];
}

// Run the actual sync entry point through receipt validation and endpoint
// upserts, then stop before unrelated graph persistence. No provider or live
// database is involved; unexpected queries fail instead of silently succeeding.
function entityTrace(stopAfterRetirement = false, missingTarget = false) {
  const rows = entityRows().filter((row) => !missingTarget || row.id !== "watch");
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const boundary = new Error("Reached the intentional visibility-test boundary.");
  const db = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql.includes("SET scanner_present = false, pull_status = 'do_not_pull'")) {
        for (const row of rows) {
          if (row.classification_source !== "user" && row.review_status !== "user_confirmed" &&
              row.pull_status === "active" && (values[2] === true || row.classification_source === "local")) {
            row.scanner_present = false;
            row.pull_status = "do_not_pull";
          }
        }
        return { rows: [] };
      }
      if (sql.includes("SELECT dossier.*, run.analysis_kind")) {
        if (stopAfterRetirement) throw boundary;
        return { rows: [] };
      }
      if (sql.includes("SELECT * FROM storyhold.world_entities") && sql.includes("normalized_name = $3")) {
        return { rows: rows.filter((row) => row.normalized_name === values[2]) };
      }
      if (sql.includes("INSERT INTO storyhold.world_entities")) {
        rows.push({ id: String(values[0]), name: String(values[7]), normalized_name: String(values[6]),
          entity_type: String(values[8]), dossier_id: null, summary: String(values[10]),
          aliases: JSON.parse(String(values[9])), details: JSON.parse(String(values[11])),
          classification_source: String(values[17]), review_status: String(values[18]),
          pull_status: "active", scanner_present: true });
        return { rows: [] };
      }
      if (sql.includes("SELECT id, name, aliases, entity_type, pull_status, scanner_present")) throw boundary;
      throw new Error(`Unexpected query in visibility test: ${sql}`);
    },
  };
  return { rows, calls, boundary, db: db as unknown as Parameters<typeof syncWorldEntities>[0]["db"] };
}

test("full Premium Review accepts matching receipts without retiring endpoints or flattening omitted rich cards", async () => {
  const trace = entityTrace();
  const before = structuredClone(trace.rows);
  await assert.rejects(syncWorldEntities({
    db: trace.db, worldId: scope.worldId, editionId: scope.editionId, runId: scope.analysisRunId,
    findings: parseWorldFindingsFromModel({}, []), analysisKind: "ai_enrichment",
    replaceGeneratedSnapshot: true, premiumGraphReviews: [receipt],
  }), (error) => error === trace.boundary);
  assert.deepEqual(trace.rows, before);
  assert.equal(trace.calls.some(({ sql }) => /UPDATE storyhold\.world_entities/.test(sql)), false);
  assert.deepEqual(trace.calls.filter(({ sql }) => sql.includes("normalized_name = $3")).map(({ values }) => values[2]), ["mira", "watch"]);
  assert.equal(persistedLocalEntityIsConnectionEligible(trace.rows[0]!), true);
  assert.equal(persistedLocalEntityIsConnectionEligible(trace.rows[1]!), true);
  assert.equal(persistedLocalEntityIsConnectionEligible(trace.rows[2]!), false);
  assert.equal(entityIsScannerProtected(trace.rows[2]), true);
});

test("paid relation projection can still create a genuinely missing endpoint", async () => {
  const trace = entityTrace(false, true);
  const originalMira = structuredClone(trace.rows[0]);
  await assert.rejects(syncWorldEntities({
    db: trace.db, worldId: scope.worldId, editionId: scope.editionId, runId: scope.analysisRunId,
    findings: parseWorldFindingsFromModel({}, []), analysisKind: "ai_enrichment",
    replaceGeneratedSnapshot: true, premiumGraphReviews: [receipt],
  }), (error) => error === trace.boundary);
  assert.deepEqual(trace.rows[0], originalMira);
  assert.equal(trace.calls.filter(({ sql }) => sql.includes("INSERT INTO storyhold.world_entities")).length, 1);
  assert.equal(trace.rows.find((row) => row.normalized_name === "watch")?.summary, relation.summary);
});

test("local scan retirement still retires local generated endpoints without changing owner hides or enriched endpoints", async () => {
  const trace = entityTrace(true);
  const before = structuredClone(trace.rows);
  await assert.rejects(syncWorldEntities({
    db: trace.db, worldId: scope.worldId, editionId: scope.editionId,
    findings: parseWorldFindingsFromModel({}, []), analysisKind: "local_scan",
  }), (error) => error === trace.boundary);
  assert.equal(trace.calls.filter(({ sql }) => sql.includes("SET scanner_present = false, pull_status = 'do_not_pull'")).length, 1);
  assert.equal(trace.rows[1]?.scanner_present, false);
  assert.equal(trace.rows[1]?.pull_status, "do_not_pull");
  assert.deepEqual(trace.rows[0], before[0]);
  assert.deepEqual(trace.rows[2], before[2]);
});

async function cleanupDatabase() {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.character_dossiers (
      id text PRIMARY KEY, world_id text, canon_edition_id text, dossier_status text, role text,
      canonical_character_id text, user_edited_at timestamptz, updated_at timestamptz
    );
    CREATE TABLE storyhold.world_entities (
      id text, dossier_id text, classification_source text, review_status text, pull_status text
    );
    CREATE TABLE storyhold.character_dossier_source_contributions (
      dossier_id text, world_id text, canon_edition_id text, evidence jsonb
    );
    CREATE TABLE storyhold.world_analysis_runs (id text, analysis_kind text);
    CREATE TABLE storyhold.character_drafts (
      id text, world_id text, canon_edition_id text, analysis_run_id text, review_status text, reviewed_at timestamptz
    );
    INSERT INTO storyhold.character_dossiers VALUES
      ('rich', 'world-visibility', 'edition-visibility', 'active', 'Captain', NULL, NULL, NULL),
      ('candidate', 'world-visibility', 'edition-visibility', 'active', 'Detected character candidate', NULL, NULL, NULL),
      ('edited', 'world-visibility', 'edition-visibility', 'active', 'Detected character candidate', NULL, now(), NULL),
      ('confirmed', 'world-visibility', 'edition-visibility', 'active', 'Detected character candidate', NULL, NULL, NULL),
      ('canonical', 'world-visibility', 'edition-visibility', 'active', 'Detected character candidate', 'canon-1', NULL, NULL),
      ('hidden', 'world-visibility', 'edition-visibility', 'suppressed', 'Detected character candidate', NULL, NULL, NULL),
      ('outside', 'other-world', 'edition-visibility', 'active', 'Detected character candidate', NULL, NULL, NULL);
    INSERT INTO storyhold.world_entities VALUES
      ('confirmed-entity', 'confirmed', 'user', 'user_confirmed', 'active'),
      ('hidden-entity', 'hidden', 'ai', 'verified', 'do_not_pull');
    INSERT INTO storyhold.character_dossier_source_contributions
      SELECT id, world_id, canon_edition_id, '[{"chunkId":"original-evidence"}]'::jsonb
        FROM storyhold.character_dossiers;
    INSERT INTO storyhold.world_analysis_runs VALUES ('local-run', 'local_scan'), ('paid-run', 'ai_enrichment');
    INSERT INTO storyhold.character_drafts VALUES
      ('local-draft', 'world-visibility', 'edition-visibility', 'local-run', 'draft', NULL),
      ('paid-draft', 'world-visibility', 'edition-visibility', 'paid-run', 'draft', NULL),
      ('confirmed-draft', 'world-visibility', 'edition-visibility', 'paid-run', 'confirmed', NULL);
  `);
  return db;
}

async function savedCharacters(db: PGlite) {
  return {
    dossiers: (await db.query("SELECT * FROM storyhold.character_dossiers ORDER BY id")).rows,
    contributions: (await db.query("SELECT * FROM storyhold.character_dossier_source_contributions ORDER BY dossier_id")).rows,
    entities: (await db.query("SELECT * FROM storyhold.world_entities ORDER BY id")).rows,
  };
}

test("premium cleanup preserves omitted dossier links, candidate dossiers, evidence contributions, and owner hides", async () => {
  const db = await cleanupDatabase();
  try {
    const before = await savedCharacters(db);
    for (const replaceGeneratedSnapshot of [false, true]) {
      await cleanupCharacterReviewProjections({
        db, ...cleanupScope,
        analysisKind: "ai_enrichment", replaceGeneratedSnapshot,
      });
      assert.deepEqual(await savedCharacters(db), before);
    }
    const active = await db.query("SELECT id FROM storyhold.character_dossiers WHERE id = 'rich' AND dossier_status = 'active'");
    assert.equal(active.rows.length, 1, "The character detail route's active-dossier lookup must still resolve.");
    assert.deepEqual((await db.query("SELECT id, review_status FROM storyhold.character_drafts ORDER BY id")).rows, [
      { id: "confirmed-draft", review_status: "confirmed" },
      { id: "local-draft", review_status: "rejected" },
      { id: "paid-draft", review_status: "rejected" },
    ]);
  } finally { await db.close(); }
});

test("local cleanup still suppresses lightweight candidates and only local drafts with owner guards intact", async () => {
  const db = await cleanupDatabase();
  try {
    const before = await savedCharacters(db);
    await cleanupCharacterReviewProjections({
      db, ...cleanupScope, analysisKind: "local_scan",
    });
    const after = await savedCharacters(db);
    assert.deepEqual(after.contributions, before.contributions);
    assert.deepEqual(after.entities, before.entities);
    for (const dossier of after.dossiers as Array<Record<string, unknown>>) {
      if (dossier.id === "candidate") {
        assert.equal(dossier.dossier_status, "suppressed");
        assert.notEqual(dossier.updated_at, null);
      } else {
        assert.deepEqual(dossier, (before.dossiers as Array<Record<string, unknown>>).find((row) => row.id === dossier.id));
      }
    }
    assert.deepEqual((await db.query("SELECT id, review_status FROM storyhold.character_drafts ORDER BY id")).rows, [
      { id: "confirmed-draft", review_status: "confirmed" },
      { id: "local-draft", review_status: "rejected" },
      { id: "paid-draft", review_status: "draft" },
    ]);
  } finally { await db.close(); }
});
