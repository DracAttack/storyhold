import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  allowedCanonEntityIds,
  claimsWithCompleteEntityReferences,
  campaignCanonScopeSchemaSql,
  createCampaignCanonScopeSnapshot,
  identitySafeEntityProjection,
  loadStrictCampaignCanonClaims,
  loadStrictCampaignCanonEvidence,
  lockedCampaignCanonScope,
  observedEntityNamesFromEvidence,
  observedEntitySurfacesFromEvidence,
  persistCampaignCanonScopeSnapshots,
  projectAnchoredCanonClaims,
  projectAnchoredCanonEvidence,
  stableCanonSha256,
  validateDirectorAgainstImportedCanon,
} from "./campaignCanonScope";

const WORLD = "10000000-0000-4000-8000-000000000001";
const EDITION = "10000000-0000-4000-8000-000000000002";
const CAMPAIGN = "10000000-0000-4000-8000-000000000003";
const SOURCE = "10000000-0000-4000-8000-000000000004";
const CHUNK = "10000000-0000-4000-8000-000000000005";
const EVENT_BEFORE = "10000000-0000-4000-8000-000000000006";
const EVENT_AFTER = "10000000-0000-4000-8000-000000000007";
const CLAIM = "10000000-0000-4000-8000-000000000008";
const MARA = "10000000-0000-4000-8000-000000000009";
const OTHER = "10000000-0000-4000-8000-00000000000a";
const THIRD = "10000000-0000-4000-8000-00000000000b";
const SOURCE_HASH = "source-hash";
const CONTENT = "Mara guards the western gate. Much later, Mara abandons the city.";
const CHUNK_HASH = createHash("sha256").update(CONTENT).digest("hex");
const EMPTY_HASH = stableCanonSha256([]);

test("canon-scope schema rejects updates and permits campaign cascade cleanup", async () => {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.campaigns(id uuid PRIMARY KEY);`);
  await db.exec(campaignCanonScopeSchemaSql);
  await db.query("INSERT INTO storyhold.campaigns(id) VALUES ($1)", [CAMPAIGN]);
  await persistCampaignCanonScopeSnapshots({
    db,
    campaignId: CAMPAIGN,
    evidence: [{
      evidence_key: "evidence",
      world_id: WORLD,
      canon_edition_id: EDITION,
      source_id: SOURCE,
      chunk_id: CHUNK,
      source_content_hash: "source",
      chunk_content_hash: "chunk",
      source_title: "Source",
      source_kind: "manuscript",
      chronology_label: "Beginning",
      excerpt: "quote",
      excerpt_hash: "excerpt",
      event_ids: [EVENT_BEFORE],
      chronology_orders: [10],
    }],
    claims: [{
      claim_id: CLAIM,
      world_id: WORLD,
      canon_edition_id: EDITION,
      fingerprint: "fingerprint",
      supersedes_claim_id: null,
      subject_entity_id: MARA,
      predicate: "guards",
      polarity: "positive",
      object_entity_id: null,
      object_text: "gate",
      epistemic_holder_entity_id: null,
      truth_status: "fact",
      valid_from_label: "",
      valid_until_label: "",
      summary: "",
      evidence: [],
      confidence: 0.8,
      claim_status: "active",
      assignment_source: "ai",
      source_updated_at: null,
      snapshot_hash: "snapshot",
    }],
  });
  await assert.rejects(
    db.query(
      "UPDATE storyhold.campaign_canon_evidence_snapshots SET excerpt = 'changed' WHERE campaign_id = $1",
      [CAMPAIGN],
    ),
    /append-only/,
  );
  await assert.rejects(
    db.query(
      "UPDATE storyhold.campaign_canon_claim_snapshots SET summary = 'changed' WHERE campaign_id = $1",
      [CAMPAIGN],
    ),
    /append-only/,
  );
  await db.query("DELETE FROM storyhold.campaigns WHERE id = $1", [CAMPAIGN]);
  assert.equal((await db.query(
    "SELECT count(*)::int AS count FROM storyhold.campaign_canon_evidence_snapshots",
  )).rows[0]?.count, 0);
  assert.equal((await db.query(
    "SELECT count(*)::int AS count FROM storyhold.campaign_canon_claim_snapshots",
  )).rows[0]?.count, 0);
  await db.close();
});

test("start-contract parser distinguishes strict, malformed, and legacy scopes", () => {
  const snapshot = createCampaignCanonScopeSnapshot({
    mode: "anchored_strict",
    anchorEventId: EVENT_BEFORE,
    anchorMode: "after",
    maximumChronologyOrder: 10,
    evidence: [],
    claims: [],
    entities: [],
  });
  const strict = lockedCampaignCanonScope({
    version: 7,
    canonScopeSnapshot: snapshot,
  });
  assert.equal(strict.valid, true);
  assert.equal(strict.strict, true);
  assert.equal(strict.mode, "anchored_strict");
  assert.deepEqual(
    {
      evidence: snapshot.evidenceSha256,
      claims: snapshot.claimsSha256,
      entities: snapshot.entitiesSha256,
    },
    { evidence: EMPTY_HASH, claims: EMPTY_HASH, entities: EMPTY_HASH },
  );
  assert.throws(
    () => createCampaignCanonScopeSnapshot({
      mode: "anchored_strict",
      evidence: [],
      claims: [],
      entities: [],
    }),
    /valid event boundary/,
  );

  const malformed = lockedCampaignCanonScope({ canonScopeSnapshot: null });
  assert.equal(malformed.present, true);
  assert.equal(malformed.valid, false);
  assert.equal(malformed.strict, true);

  assert.equal(lockedCampaignCanonScope({ version: 5 }).mode, "legacy_unbounded");
  assert.equal(lockedCampaignCanonScope({
    version: 6,
    canonTimelineSnapshot: {
      anchorEventId: EVENT_BEFORE,
      anchorMode: "before",
      maximumChronologyOrder: 9,
    },
  }).mode, "legacy_anchored");
});

test("anchored evidence projection retains exact pre-cutoff quotes, never the chunk", () => {
  const input = {
    worldId: WORLD,
    editionId: EDITION,
    maximumChronologyOrder: 10,
    timelineRows: [
      {
        id: EVENT_BEFORE,
        chronology_order: 10,
        evidence: [{ sourceId: SOURCE, chunkId: CHUNK, quote: "Mara guards the western gate." }],
      },
      {
        id: EVENT_AFTER,
        chronology_order: 11,
        evidence: [{ sourceId: SOURCE, chunkId: CHUNK, quote: "Much later, Mara abandons the city." }],
      },
    ],
    chunks: [{
      id: CHUNK,
      source_id: SOURCE,
      world_id: WORLD,
      canon_edition_id: EDITION,
      content: CONTENT,
      content_hash: CHUNK_HASH,
      source_content_hash: SOURCE_HASH,
      source_title: "The Gate",
      source_kind: "manuscript",
      chronology_label: "Book one",
    }],
    lockedSources: [{ id: SOURCE, content_hash: SOURCE_HASH }],
  };
  const projection = projectAnchoredCanonEvidence(input);
  assert.equal(projection.rows.length, 1);
  assert.equal(projection.rows[0]?.excerpt, "Mara guards the western gate.");
  assert.doesNotMatch(projection.rows[0]?.excerpt ?? "", /abandons/);
  assert.deepEqual(projection.rows[0]?.event_ids, [EVENT_BEFORE]);
  assert.equal(
    projectAnchoredCanonEvidence({
      ...input,
      timelineRows: [...input.timelineRows].reverse(),
    }).sha256,
    projection.sha256,
  );

  const drifted = projectAnchoredCanonEvidence({
    ...input,
    chunks: [{ ...input.chunks[0]!, source_content_hash: "changed" }],
  });
  assert.deepEqual(drifted.rows, []);
  assert.equal(drifted.rejections[0]?.reason, "source_hash_mismatch");
});

test("claim projection rejects claims synthesized across the cutoff", () => {
  const evidence = projectAnchoredCanonEvidence({
    worldId: WORLD,
    editionId: EDITION,
    maximumChronologyOrder: 10,
    timelineRows: [{
      id: EVENT_BEFORE,
      chronology_order: 10,
      evidence: [{ sourceId: SOURCE, chunkId: CHUNK, quote: "Mara guards the western gate." }],
    }],
    chunks: [{
      id: CHUNK,
      source_id: SOURCE,
      world_id: WORLD,
      canon_edition_id: EDITION,
      content: CONTENT,
      content_hash: CHUNK_HASH,
      source_content_hash: SOURCE_HASH,
    }],
    lockedSources: [{ id: SOURCE, content_hash: SOURCE_HASH }],
  }).rows;
  const projection = projectAnchoredCanonClaims({
    worldId: WORLD,
    editionId: EDITION,
    evidence,
    claims: [{
      id: CLAIM,
      world_id: WORLD,
      canon_edition_id: EDITION,
      fingerprint: "claim-fingerprint",
      subject_entity_id: MARA,
      predicate: "guards",
      object_text: "the western gate",
      truth_status: "fact",
      claim_status: "active",
      assignment_source: "ai",
      confidence: 0.9,
      evidence: [
        { sourceId: SOURCE, chunkId: CHUNK, quote: "Mara guards the western gate." },
        { sourceId: SOURCE, chunkId: CHUNK, quote: "Much later, Mara abandons the city." },
      ],
    }, {
      id: "10000000-0000-4000-8000-00000000000b",
      world_id: WORLD,
      canon_edition_id: EDITION,
      fingerprint: "manual-without-evidence",
      subject_entity_id: MARA,
      predicate: "rules",
      object_text: "the city",
      truth_status: "fact",
      claim_status: "active",
      assignment_source: "user",
      evidence: [],
    }],
  });
  assert.equal(projection.rows.length, 0);
  assert.equal(projection.rejections[0]?.reason, "partially_retained_evidence");
  assert.equal(projection.rejections.at(-1)?.reason, "no_retained_evidence");

  const whollyRetained = projectAnchoredCanonClaims({
    worldId: WORLD,
    editionId: EDITION,
    evidence,
    entitySurfacesById: { [MARA]: ["Mara"] },
    claims: [{
      id: CLAIM,
      world_id: WORLD,
      canon_edition_id: EDITION,
      fingerprint: "safe-claim",
      subject_entity_id: MARA,
      predicate: "guards",
      object_text: "the western gate",
      truth_status: "fact",
      claim_status: "active",
      assignment_source: "ai",
      confidence: 0.9,
      evidence: [{ sourceId: SOURCE, chunkId: CHUNK, quote: "Mara guards the western gate." }],
    }],
  });
  assert.equal(whollyRetained.rows.length, 1);
  assert.equal(whollyRetained.rows[0]?.evidence.length, 1);
  assert.equal(whollyRetained.rows[0]?.summary, "");
  assert.equal(whollyRetained.rows[0]?.valid_until_label, "");

  const nonliteralFutureObject = projectAnchoredCanonClaims({
    worldId: WORLD,
    editionId: EDITION,
    evidence,
    entitySurfacesById: { [MARA]: ["Mara"] },
    claims: [{
      id: CLAIM,
      world_id: WORLD,
      canon_edition_id: EDITION,
      fingerprint: "future-object",
      subject_entity_id: MARA,
      predicate: "is secretly",
      object_text: "the future queen",
      truth_status: "fact",
      claim_status: "active",
      assignment_source: "ai",
      confidence: 0.9,
      evidence: [{ sourceId: SOURCE, chunkId: CHUNK, quote: "Mara guards the western gate." }],
    }],
  });
  assert.equal(nonliteralFutureObject.rows.length, 0);
  assert.equal(nonliteralFutureObject.rejections[0]?.reason, "interpretation_not_literal_at_cutoff");
});

test("claim projection rebuilds direct facts and rejects ambiguous reveals or hidden entity resolution", () => {
  const directEvidence = [{
    evidence_key: "direct",
    world_id: WORLD,
    canon_edition_id: EDITION,
    source_id: SOURCE,
    chunk_id: CHUNK,
    source_content_hash: SOURCE_HASH,
    chunk_content_hash: CHUNK_HASH,
    source_title: "The Gate",
    source_kind: "manuscript",
    chronology_label: "Book One",
    excerpt: "Mara guards Rowan at the western gate.",
    excerpt_hash: "direct-hash",
    event_ids: [EVENT_BEFORE],
    chronology_orders: [10],
  }];
  const direct = projectAnchoredCanonClaims({
    worldId: WORLD,
    editionId: EDITION,
    evidence: directEvidence,
    entitySurfacesById: { [MARA]: ["Mara"], [OTHER]: ["Rowan"] },
    claims: [{
      id: CLAIM,
      world_id: WORLD,
      canon_edition_id: EDITION,
      fingerprint: "later-fingerprint",
      subject_entity_id: MARA,
      predicate: "guards",
      object_entity_id: OTHER,
      truth_status: "lie",
      claim_status: "superseded",
      assignment_source: "ai",
      confidence: 0.99,
      evidence: [{
        sourceId: SOURCE,
        chunkId: CHUNK,
        quote: "Mara guards Rowan at the western gate.",
      }],
    }],
  });
  assert.equal(direct.rows.length, 1);
  assert.equal(direct.rows[0]?.truth_status, "fact");
  assert.equal(direct.rows[0]?.claim_status, "active");
  assert.equal(direct.rows[0]?.assignment_source, "local");
  assert.equal(direct.rows[0]?.object_entity_id, OTHER);
  assert.notEqual(direct.rows[0]?.fingerprint, "later-fingerprint");

  const ambiguousEvidence = [{
    ...directEvidence[0]!,
    evidence_key: "ambiguous",
    excerpt: "Mara is Rowan, perhaps?",
  }];
  const ambiguous = projectAnchoredCanonClaims({
    worldId: WORLD,
    editionId: EDITION,
    evidence: ambiguousEvidence,
    entitySurfacesById: { [MARA]: ["Mara"], [OTHER]: ["Rowan"] },
    claims: [{
      id: CLAIM,
      world_id: WORLD,
      canon_edition_id: EDITION,
      fingerprint: "future-reveal",
      subject_entity_id: MARA,
      predicate: "is",
      object_entity_id: OTHER,
      truth_status: "fact",
      claim_status: "active",
      assignment_source: "ai",
      evidence: [{ sourceId: SOURCE, chunkId: CHUNK, quote: "Mara is Rowan, perhaps?" }],
    }],
  });
  assert.deepEqual(ambiguous.rows, []);
  assert.equal(ambiguous.rejections[0]?.reason, "interpretation_not_literal_at_cutoff");

  const hiddenIdentity = projectAnchoredCanonClaims({
    worldId: WORLD,
    editionId: EDITION,
    evidence: directEvidence,
    entitySurfacesById: { [MARA]: ["Mara"], [OTHER]: ["The Future Queen"] },
    claims: [{
      id: CLAIM,
      world_id: WORLD,
      canon_edition_id: EDITION,
      fingerprint: "hidden-resolution",
      subject_entity_id: MARA,
      predicate: "guards",
      object_entity_id: OTHER,
      truth_status: "fact",
      claim_status: "active",
      assignment_source: "ai",
      evidence: [{ sourceId: SOURCE, chunkId: CHUNK, quote: "Mara guards Rowan at the western gate." }],
    }],
  });
  assert.deepEqual(hiddenIdentity.rows, []);

  const cooccurrenceOnlyEvidence = [{
    ...directEvidence[0]!,
    evidence_key: "cooccurrence-only",
    excerpt: "Mara guards the western gate. Rowan watches from the tower.",
  }];
  const cooccurrenceOnly = projectAnchoredCanonClaims({
    worldId: WORLD,
    editionId: EDITION,
    evidence: cooccurrenceOnlyEvidence,
    entitySurfacesById: { [MARA]: ["Mara"], [OTHER]: ["Rowan"] },
    claims: [{
      id: CLAIM,
      world_id: WORLD,
      canon_edition_id: EDITION,
      fingerprint: "cooccurrence-is-not-a-relation",
      subject_entity_id: MARA,
      predicate: "guards",
      object_entity_id: OTHER,
      truth_status: "fact",
      claim_status: "active",
      assignment_source: "ai",
      evidence: [{
        sourceId: SOURCE,
        chunkId: CHUNK,
        quote: "Mara guards the western gate. Rowan watches from the tower.",
      }],
    }],
  });
  assert.deepEqual(cooccurrenceOnly.rows, []);
});

test("entity projection retains allowed identity only", () => {
  const claims = projectAnchoredCanonClaims({
    worldId: WORLD,
    editionId: EDITION,
    evidence: [],
    claims: [],
  }).rows;
  const allowed = allowedCanonEntityIds({
    timelineRows: [{ participant_entity_ids: [MARA] }],
    claims,
    selectedPlayerEntityId: MARA,
  });
  const projection = identitySafeEntityProjection({
    allowedEntityIds: allowed,
    selectedPlayerEntityId: MARA,
    entities: [{
      id: MARA,
      dossier_id: "10000000-0000-4000-8000-00000000000c",
      canonical_key: "mara",
      entity_type: "character",
      name: "Mara",
      aliases: ["The Future Queen"],
      summary: "She betrays the city in book three.",
      profile: { secrets: ["future betrayal"] },
      relationships: ["secret heir"],
      confidence: 0.93,
    }, {
      id: OTHER,
      canonical_key: "future-villain",
      entity_type: "character",
      name: "Future Villain",
    }],
  });
  assert.equal(projection.rows.length, 1);
  assert.equal(projection.rows[0]?.name, "Mara");
  assert.deepEqual(projection.rows[0]?.aliases, []);
  assert.equal(projection.rows[0]?.summary, "");
  assert.deepEqual(projection.rows[0]?.profile, {});
  assert.equal(JSON.stringify(projection.rows).includes("future"), false);
});

test("strict entity projection uses only names observed before the cutoff", () => {
  const evidence = [{
    evidence_key: "before",
    world_id: WORLD,
    canon_edition_id: EDITION,
    source_id: SOURCE,
    chunk_id: CHUNK,
    source_content_hash: "source",
    chunk_content_hash: "chunk",
    source_title: "Ashes",
    source_kind: "manuscript",
    chronology_label: "Book One",
    excerpt: "Ragger watches from the edge of the firelight.",
    excerpt_hash: "excerpt",
    event_ids: [EVENT_BEFORE],
    chronology_orders: [10],
  }];
  const observed = observedEntityNamesFromEvidence({
    evidence,
    mentions: [
      { entity_id: MARA, chunk_id: CHUNK, surface_form: "Ragger", confidence: 0.8 },
      { entity_id: MARA, chunk_id: CHUNK, surface_form: "he", confidence: 0.99 },
      { entity_id: MARA, chunk_id: CHUNK, surface_form: "Karagorn Anubsika", confidence: 0.99 },
    ],
  });
  assert.deepEqual(observed, { [MARA]: "Ragger" });
  assert.deepEqual(observedEntitySurfacesFromEvidence({
    evidence,
    mentions: [
      { entity_id: MARA, chunk_id: CHUNK, surface_form: "Ragger", confidence: 0.8 },
      { entity_id: MARA, chunk_id: CHUNK, surface_form: "he", confidence: 0.99 },
      { entity_id: MARA, chunk_id: CHUNK, surface_form: "Karagorn Anubsika", confidence: 0.99 },
    ],
  }), { [MARA]: ["Ragger"] });
  const projection = identitySafeEntityProjection({
    entities: [{
      id: MARA,
      canonical_key: "ragger-karagorn-anubsika",
      entity_type: "character",
      name: "Karagorn Anubsika",
      summary: "Ragger is revealed as Karagorn Anubsika.",
    }],
    allowedEntityIds: [MARA],
    observedNamesByEntityId: observed,
    preserveUnobservedIdentity: false,
  });
  assert.equal(projection.rows[0]?.name, "Ragger");
  assert.equal(projection.rows[0]?.canonical_key, `snapshot-${MARA}`);
  assert.equal(projection.rows[0]?.entity_type, "ambiguous");
  assert.doesNotMatch(JSON.stringify(projection.rows), /Karagorn|Anubsika/iu);
});

test("strict claims retain only complete subject, object, and belief-holder identities", () => {
  const base = {
    claim_id: CLAIM,
    world_id: WORLD,
    canon_edition_id: EDITION,
    fingerprint: "claim",
    supersedes_claim_id: null,
    subject_entity_id: MARA,
    predicate: "knows",
    polarity: "positive" as const,
    object_entity_id: OTHER,
    object_text: "",
    epistemic_holder_entity_id: null,
    truth_status: "fact" as const,
    valid_from_label: "",
    valid_until_label: "",
    summary: "",
    evidence: [],
    confidence: 0.8,
    claim_status: "active" as const,
    assignment_source: "ai" as const,
    source_updated_at: null,
    snapshot_hash: "hash",
  };
  assert.equal(claimsWithCompleteEntityReferences([base], [MARA]).length, 0);
  assert.equal(claimsWithCompleteEntityReferences([base], [MARA, OTHER]).length, 1);
  assert.equal(claimsWithCompleteEntityReferences([
    { ...base, object_entity_id: null, epistemic_holder_entity_id: OTHER },
  ], [MARA]).length, 0);
});

test("strict retrieval helpers query snapshots rather than mutable canon tables", async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const db = {
    async query<T extends Record<string, unknown>>(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows: [] as T[] };
    },
  };
  await loadStrictCampaignCanonEvidence({ db, campaignId: CAMPAIGN, action: "gate" });
  await loadStrictCampaignCanonClaims({ db, campaignId: CAMPAIGN, action: "gate" });
  assert.match(calls[0]?.sql ?? "", /campaign_canon_evidence_snapshots/);
  assert.doesNotMatch(calls[0]?.sql ?? "", /world_source_chunks/);
  assert.match(calls[1]?.sql ?? "", /campaign_canon_claim_snapshots/);
  assert.doesNotMatch(calls[1]?.sql ?? "", /world_knowledge_claims|world_entities/);
});

test("structural validation blocks imported-fact contradictions and permits exact causal supersession", () => {
  const importedClaims = [{
    id: CLAIM,
    subject_entity_id: MARA,
    predicate: "guards",
    object_text: "the western gate",
    polarity: "positive",
    truth_status: "fact",
    claim_status: "active",
  }];
  const entities = [{ id: MARA, name: "Mara", aliases: ["The Warden"] }];
  const contradiction = validateDirectorAgainstImportedCanon({
    importedClaims,
    entities,
    propositions: [{
      layer: "reality",
      subjectEntityId: MARA,
      subject: "Mara",
      predicate: "guards",
      object: "the western gate",
      stance: "denied",
      causalBasis: ["player action"],
    }],
  });
  assert.equal(contradiction.ok, false);
  assert.equal(contradiction.issues[0]?.code, "IMPORTED_CANON_STANCE_CONFLICT");

  const supersession = validateDirectorAgainstImportedCanon({
    importedClaims,
    entities,
    propositions: [{
      layer: "reality",
      subjectEntityId: MARA,
      subject: "Mara",
      predicate: "guards",
      object: "the western gate",
      stance: "denied",
      causalBasis: ["The gate fell after the resolved conflict."],
      supersedesPropositionId: CLAIM,
    }],
  });
  assert.deepEqual(supersession, { ok: true, issues: [] });

  const wrongSubject = validateDirectorAgainstImportedCanon({
    importedClaims,
    entities: [...entities, { id: OTHER, name: "Other" }],
    propositions: [{
      layer: "reality",
      subjectEntityId: OTHER,
      subject: "Other",
      predicate: "guards",
      object: "the western gate",
      stance: "denied",
      causalBasis: ["event"],
      supersedesPropositionId: CLAIM,
    }],
  });
  assert.equal(wrongSubject.issues[0]?.code, "INVALID_IMPORTED_CANON_SUPERSESSION");

  const wrongPredicate = validateDirectorAgainstImportedCanon({
    importedClaims,
    entities,
    propositions: [{
      layer: "reality",
      subjectEntityId: MARA,
      subject: "Mara",
      predicate: "owns",
      object: "the western gate",
      stance: "denied",
      causalBasis: ["event"],
      supersedesPropositionId: CLAIM,
    }],
  });
  assert.equal(wrongPredicate.issues[0]?.code, "INVALID_IMPORTED_CANON_SUPERSESSION");
});

test("structural validation resolves unique shortened character names and rejects ambiguous ones", () => {
  const importedClaims = [{
    id: CLAIM,
    subject_entity_id: MARA,
    predicate: "guards",
    object_text: "the western gate",
    polarity: "positive",
    truth_status: "fact",
    claim_status: "active",
  }];
  const shortened = validateDirectorAgainstImportedCanon({
    importedClaims,
    entities: [{ id: MARA, entity_type: "character", name: "Mara Vance" }],
    propositions: [{
      layer: "reality",
      subject: "Mara",
      predicate: "guards",
      object: "the western gate",
      stance: "denied",
    }],
  });
  assert.equal(shortened.issues[0]?.code, "IMPORTED_CANON_STANCE_CONFLICT");

  const ambiguous = validateDirectorAgainstImportedCanon({
    importedClaims,
    entities: [
      { id: MARA, entity_type: "character", name: "Mara Vance" },
      { id: OTHER, entity_type: "character", name: "Mara Holt" },
    ],
    propositions: [{
      layer: "reality",
      subject: "Mara",
      predicate: "guards",
      object: "the western gate",
      stance: "denied",
    }],
  });
  assert.equal(ambiguous.issues[0]?.code, "AMBIGUOUS_CANON_SUBJECT");
});

test("structural validation rejects unknown, malformed, and mismatched canonical entity references", () => {
  const importedClaims = [{
    id: CLAIM,
    subject_entity_id: MARA,
    predicate: "guards",
    object_entity_id: OTHER,
    object_name: "Western Gate",
    polarity: "positive",
    truth_status: "fact",
    claim_status: "active",
  }];
  const entities = [
    { id: MARA, entity_type: "character", name: "Mara Vance" },
    { id: OTHER, entity_type: "place", name: "Western Gate" },
    { id: THIRD, entity_type: "character", name: "Tessa Rowan" },
  ];
  const proposition = {
    layer: "reality",
    subject: "Mara",
    predicate: "guards",
    object: "Western Gate",
    stance: "affirmed",
  };

  for (const subjectEntityId of [
    "10000000-0000-4000-8000-000000000099",
    "not-a-canonical-id",
  ]) {
    const result = validateDirectorAgainstImportedCanon({
      importedClaims,
      entities,
      propositions: [{ ...proposition, subjectEntityId }],
    });
    assert.equal(result.issues[0]?.code, "UNKNOWN_CANON_SUBJECT");
  }

  const mismatchedSubject = validateDirectorAgainstImportedCanon({
    importedClaims,
    entities,
    propositions: [{ ...proposition, subjectEntityId: MARA, subject: "Tessa Rowan" }],
  });
  assert.equal(mismatchedSubject.issues[0]?.code, "CANON_ENTITY_REFERENCE_MISMATCH");

  const decoratedMismatch = validateDirectorAgainstImportedCanon({
    importedClaims,
    entities,
    propositions: [{ ...proposition, subjectEntityId: MARA, subject: "Captain Tessa" }],
  });
  assert.equal(decoratedMismatch.issues[0]?.code, "CANON_ENTITY_REFERENCE_MISMATCH");

  const unknownObject = validateDirectorAgainstImportedCanon({
    importedClaims,
    entities,
    propositions: [{
      ...proposition,
      objectEntityId: "10000000-0000-4000-8000-000000000099",
    }],
  });
  assert.equal(unknownObject.issues[0]?.code, "UNKNOWN_CANON_OBJECT");

  const mismatchedObject = validateDirectorAgainstImportedCanon({
    importedClaims,
    entities,
    propositions: [{
      ...proposition,
      objectEntityId: THIRD,
      object: "west entrance",
    }],
  });
  assert.equal(mismatchedObject.issues[0]?.code, "CANON_ENTITY_REFERENCE_MISMATCH");
});

test("structural validation fails closed on decorated known subjects without blocking unrelated new NPCs", () => {
  const importedClaims = [{
    id: CLAIM,
    subject_entity_id: MARA,
    predicate: "guards",
    object_text: "the western gate",
    polarity: "positive",
    truth_status: "fact",
    claim_status: "active",
  }];
  const entities = [{ id: MARA, entity_type: "character", name: "Mara Vance" }];
  const decorated = validateDirectorAgainstImportedCanon({
    importedClaims,
    entities,
    propositions: [{
      layer: "reality",
      subject: "Captain Mara",
      predicate: "guards",
      object: "the western gate",
      stance: "denied",
    }],
  });
  assert.equal(decorated.issues[0]?.code, "UNRESOLVED_CANON_SUBJECT");

  for (const subject of ["Marabelle", "Mara Jade", "Tessa Rowan"]) {
    const unrelated = validateDirectorAgainstImportedCanon({
      importedClaims,
      entities,
      propositions: [{
        layer: "reality",
        subject,
        predicate: "guards",
        object: "the western gate",
        stance: "denied",
      }],
    });
    assert.deepEqual(unrelated, { ok: true, issues: [] });
  }
});

test("structural validation catches narrow predicate and location paraphrases", () => {
  const importedClaims = [{
    id: CLAIM,
    subject_entity_id: MARA,
    predicate: "guards",
    object_entity_id: OTHER,
    object_name: "the Western Gate",
    polarity: "positive",
    truth_status: "fact",
    claim_status: "active",
  }];
  const entities = [
    { id: MARA, entity_type: "character", name: "Mara Vance", aliases: ["The Warden"] },
    { id: OTHER, entity_type: "place", name: "Western Gate" },
  ];
  for (const [predicate, object] of [
    ["defends", "west entrance"],
    ["is protecting", "the western entryway"],
    ["guarded", "western gates"],
  ]) {
    const contradiction = validateDirectorAgainstImportedCanon({
      importedClaims,
      entities,
      propositions: [{
        layer: "reality",
        subject: "The Warden",
        predicate,
        object,
        stance: "denied",
      }],
    });
    assert.equal(
      contradiction.issues[0]?.code,
      "IMPORTED_CANON_STANCE_CONFLICT",
      `${predicate} ${object}`,
    );
  }

  const causalSupersession = validateDirectorAgainstImportedCanon({
    importedClaims,
    entities,
    propositions: [{
      layer: "reality",
      subject: "Mara",
      predicate: "defends",
      object: "west entrance",
      stance: "denied",
      causalBasis: ["The resolved siege destroyed the entrance."],
      supersedesPropositionId: CLAIM,
    }],
  });
  assert.deepEqual(causalSupersession, { ok: true, issues: [] });
});

test("structural validation does not broaden paraphrases into unrelated canon conflicts", () => {
  const importedClaims = [{
    id: CLAIM,
    subject_entity_id: MARA,
    predicate: "guards",
    object_text: "the western gate",
    polarity: "positive",
    truth_status: "fact",
    claim_status: "active",
  }];
  const entities = [{ id: MARA, entity_type: "character", name: "Mara Vance" }];
  for (const [predicate, object] of [
    ["observes", "the western gate"],
    ["guards", "the northern entrance"],
    ["protects", "the western wall"],
  ]) {
    const distinct = validateDirectorAgainstImportedCanon({
      importedClaims,
      entities,
      propositions: [{
        layer: "reality",
        subject: "Mara",
        predicate,
        object,
        stance: "denied",
      }],
    });
    assert.deepEqual(distinct, { ok: true, issues: [] }, `${predicate} ${object}`);
  }
});

test("trusted semantic hooks may tighten text matching but cannot waive entity identity", () => {
  const importedClaims = [{
    id: CLAIM,
    subject_entity_id: MARA,
    predicate: "maintains watch over",
    object_text: "the moonlit approach",
    polarity: "positive",
    truth_status: "fact",
    claim_status: "active",
  }];
  const entities = [
    { id: MARA, entity_type: "character", name: "Mara Vance" },
    { id: OTHER, entity_type: "place", name: "Western Gate" },
    // Semantically similar names remain separate when their canonical IDs do.
    { id: THIRD, entity_type: "place", name: "West Entrance" },
  ];
  let hookCalls = 0;
  const semanticEquivalence = () => {
    hookCalls += 1;
    return "equivalent" as const;
  };
  const tightened = validateDirectorAgainstImportedCanon({
    importedClaims,
    entities,
    semanticEquivalence,
    propositions: [{
      layer: "reality",
      subject: "Mara",
      predicate: "keeps vigil beside",
      object: "the road silvered by moonlight",
      stance: "denied",
    }],
  });
  assert.equal(tightened.issues[0]?.code, "IMPORTED_CANON_STANCE_CONFLICT");
  assert.equal(hookCalls, 1);

  hookCalls = 0;
  const identityLocked = validateDirectorAgainstImportedCanon({
    importedClaims: [{
      ...importedClaims[0],
      object_entity_id: OTHER,
      object_name: "Western Gate",
    }],
    entities,
    semanticEquivalence,
    propositions: [{
      layer: "reality",
      subject: "Mara",
      predicate: "maintains watch over",
      objectEntityId: THIRD,
      object: "West Entrance",
      stance: "denied",
    }],
  });
  assert.deepEqual(identityLocked, { ok: true, issues: [] });
  assert.equal(hookCalls, 0);
});

test("structural validation rejects embedded negation instead of trusting contradictory stance encoding", () => {
  const importedClaims = [{
    id: CLAIM,
    subject_entity_id: MARA,
    predicate: "guards",
    object_text: "the western gate",
    polarity: "positive",
    truth_status: "fact",
    claim_status: "active",
  }];
  const entities = [{ id: MARA, entity_type: "character", name: "Mara Vance" }];
  for (const proposition of [
    { predicate: "does not guard", object: "the western gate", stance: "affirmed" },
    { predicate: "guards", object: "not the western gate", stance: "denied" },
    { predicate: "doesn't defend", object: "west entrance", stance: "denied" },
    { predicate: "can't protect", object: "west entrance", stance: "affirmed" },
  ]) {
    const result = validateDirectorAgainstImportedCanon({
      importedClaims,
      entities,
      propositions: [{ layer: "reality", subject: "Mara", ...proposition }],
    });
    assert.equal(result.issues[0]?.code, "MALFORMED_CANON_NEGATION");
  }

  const properName = validateDirectorAgainstImportedCanon({
    importedClaims: [],
    entities: [
      { id: MARA, entity_type: "character", name: "Mara Vance" },
      { id: OTHER, entity_type: "place", name: "No Man's Land" },
    ],
    propositions: [{
      layer: "reality",
      subject: "Mara",
      predicate: "enters",
      objectEntityId: OTHER,
      object: "No Man's Land",
      stance: "affirmed",
    }],
  });
  assert.deepEqual(properName, { ok: true, issues: [] });
});

test("structural validation ignores epistemic claims and requires state facts to be propositions", () => {
  const epistemic = validateDirectorAgainstImportedCanon({
    importedClaims: [{
      id: CLAIM,
      subject_entity_id: MARA,
      predicate: "guards",
      object_text: "the western gate",
      truth_status: "belief",
      claim_status: "active",
    }],
    entities: [{ id: MARA, name: "Mara" }],
    propositions: [{
      layer: "reality",
      subject: "Mara",
      predicate: "guards",
      object: "the western gate",
      stance: "denied",
    }],
  });
  assert.equal(epistemic.ok, true);

  const unmodeled = validateDirectorAgainstImportedCanon({
    importedClaims: [],
    entities: [{ id: MARA, name: "Mara" }],
    propositions: [],
    stateChanges: [{ subject: "Mara", facts: ["guards the western gate"] }],
  });
  assert.equal(unmodeled.issues[0]?.code, "STATE_CHANGE_MISSING_REALITY_PROPOSITION");

  const modeled = validateDirectorAgainstImportedCanon({
    importedClaims: [],
    entities: [{ id: MARA, name: "Mara" }],
    propositions: [{
      layer: "reality",
      subject: "Mara",
      predicate: "guards",
      object: "the western gate",
      stance: "affirmed",
    }],
    stateChanges: [{ subject: "Mara", facts: ["Mara guards the western gate"] }],
  });
  assert.equal(modeled.ok, true);
});
