import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  extractEntityMentionsFromChunk,
  knowledgeClaimFingerprint,
  resolveCoreferenceSpan,
  syncWorldCoreferenceSpans,
  syncWorldEntityMentions,
  syncWorldEventRelations,
  syncWorldEventParticipants,
  syncWorldKnowledgeClaims,
  worldKnowledgeSchemaSql,
} from "./worldKnowledge";

const WORLD_ID = "10000000-0000-4000-8000-000000000001";
const EDITION_ID = "10000000-0000-4000-8000-000000000002";
const ENTITY_ID = "10000000-0000-4000-8000-000000000003";
const EVENT_ID = "10000000-0000-4000-8000-000000000004";
const SECOND_EVENT_ID = "10000000-0000-4000-8000-000000000007";
const SOURCE_ID = "10000000-0000-4000-8000-000000000005";
const CHUNK_ID = "10000000-0000-4000-8000-000000000006";
const OVERLAP_CHUNK_ID = "10000000-0000-4000-8000-000000000008";
const USER_EDITED_AT = "2001-02-03T04:05:06.000Z";

async function createKnowledgeTestDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.worlds (
      id uuid PRIMARY KEY
    );
    CREATE TABLE storyhold.canon_editions (
      id uuid PRIMARY KEY,
      world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE
    );
    CREATE TABLE storyhold.world_analysis_runs (
      id uuid PRIMARY KEY
    );
    CREATE TABLE storyhold.world_entities (
      id uuid PRIMARY KEY,
      world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
      name text NOT NULL,
      aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
      entity_type text NOT NULL DEFAULT 'character',
      pull_status text NOT NULL DEFAULT 'active',
      scanner_present boolean NOT NULL DEFAULT true,
      merged_into_entity_id uuid REFERENCES storyhold.world_entities(id) ON DELETE SET NULL
    );
    CREATE TABLE storyhold.world_sources (
      id uuid PRIMARY KEY,
      world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
      processing_status text NOT NULL DEFAULT 'ready',
      canon_status text NOT NULL DEFAULT 'canon',
      chronology_order integer NOT NULL DEFAULT 0,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE storyhold.world_source_chunks (
      id uuid PRIMARY KEY,
      source_id uuid NOT NULL REFERENCES storyhold.world_sources(id) ON DELETE CASCADE,
      world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
      chunk_index integer NOT NULL,
      content text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE storyhold.world_clock_events (
      id uuid PRIMARY KEY,
      world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
      canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
      campaign_id uuid,
      title text NOT NULL
    );
  `);
  await db.exec(worldKnowledgeSchemaSql);
  await db.query("INSERT INTO storyhold.worlds (id) VALUES ($1)", [WORLD_ID]);
  await db.query(
    "INSERT INTO storyhold.canon_editions (id, world_id) VALUES ($1, $2)",
    [EDITION_ID, WORLD_ID],
  );
  await db.query(
    `INSERT INTO storyhold.world_entities
      (id, world_id, canon_edition_id, name)
     VALUES ($1, $2, $3, 'Ragger')`,
    [ENTITY_ID, WORLD_ID, EDITION_ID],
  );
  await db.query(
    `INSERT INTO storyhold.world_clock_events
      (id, world_id, canon_edition_id, title)
     VALUES ($1, $2, $3, 'Ragger opens the archive'),
            ($4, $2, $3, 'Alec learns the hidden history')`,
    [EVENT_ID, WORLD_ID, EDITION_ID, SECOND_EVENT_ID],
  );
  return db;
}

test("knowledge claims keep a character belief separate from objective fact", () => {
  const base = {
    subjectEntityId: "11111111-1111-4111-8111-111111111111",
    predicate: "survived",
    objectText: "the evacuation",
    validFromLabel: "Book Two",
  };
  const fact = knowledgeClaimFingerprint({ ...base, truthStatus: "fact" });
  const belief = knowledgeClaimFingerprint({
    ...base,
    truthStatus: "belief",
    epistemicHolderEntityId: "22222222-2222-4222-8222-222222222222",
  });
  assert.notEqual(fact, belief);
});

test("coreference resolves a pronoun only when its cluster has one canonical identity", () => {
  const resolved = resolveCoreferenceSpan({
    span: {
      surfaceForm: "He",
      startOffset: 14,
      endOffset: 16,
      context: "Ragger stopped. He listened.",
      clusterKey: "chunk:0",
      clusterMentions: ["Ragger", "He"],
    },
    entities: [
      { id: "ragger", name: "Ragger", aliases: ["The Old Dog"] },
      { id: "kendall", name: "Kendall Sumner", aliases: ["Kendall"] },
    ],
  });
  assert.equal(resolved?.entityId, "ragger");
  assert.equal(resolved?.resolutionStatus, "resolved");
  assert.equal(resolved?.antecedentSurface, "Ragger");

  const ambiguous = resolveCoreferenceSpan({
    span: {
      surfaceForm: "he",
      startOffset: 20,
      endOffset: 22,
      context: "Ragger met Alec before he left.",
      clusterKey: "chunk:1",
      clusterMentions: ["Ragger", "Alec", "he"],
    },
    entities: [
      { id: "ragger", name: "Ragger", aliases: [] },
      { id: "alec", name: "Alec Sumner", aliases: ["Alec"] },
    ],
  });
  assert.equal(ambiguous?.entityId, null);
  assert.equal(ambiguous?.resolutionStatus, "ambiguous");
});

test("coreference spans become offset-preserving canonical mentions", async () => {
  const db = await createKnowledgeTestDatabase();
  try {
    await db.query(
      `INSERT INTO storyhold.world_sources
        (id, world_id, canon_edition_id)
       VALUES ($1, $2, $3)`,
      [SOURCE_ID, WORLD_ID, EDITION_ID],
    );
    await db.query(
      `INSERT INTO storyhold.world_source_chunks
        (id, source_id, world_id, canon_edition_id, chunk_index, content)
       VALUES ($1, $2, $3, $4, 0, 'Ragger stopped. He listened.')`,
      [CHUNK_ID, SOURCE_ID, WORLD_ID, EDITION_ID],
    );
    const persisted = await syncWorldCoreferenceSpans({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
      result: {
        spans: [{
          sourceId: SOURCE_ID,
          chunkId: CHUNK_ID,
          clusterKey: `${CHUNK_ID}:0`,
          surfaceForm: "He",
          startOffset: 16,
          endOffset: 18,
          context: "Ragger stopped. He listened.",
          clusterMentions: ["Ragger", "He"],
        }],
        receipt: {
          status: "completed",
          model: "biu-nlp/f-coref",
          attemptedChunks: 1,
          completedChunkIds: [CHUNK_ID],
          mentionCount: 1,
          elapsedMilliseconds: 12,
          errors: [],
        },
      },
    });
    assert.deepEqual(persisted, { saved: 1, replacedChunks: 1 });

    const indexed = await syncWorldEntityMentions({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
    });
    assert.equal(indexed.coreferenceMentions, 1);
    const mentions = await db.query<{
      entity_id: string | null;
      surface_form: string;
      start_offset: number;
      end_offset: number;
      mention_kind: string;
      antecedent_surface: string | null;
    }>(
      `SELECT entity_id, surface_form, start_offset, end_offset,
              mention_kind, antecedent_surface
         FROM storyhold.world_entity_mentions
        WHERE chunk_id = $1
        ORDER BY start_offset, mention_kind`,
      [CHUNK_ID],
    );
    assert.deepEqual(mentions.rows, [
      {
        entity_id: ENTITY_ID,
        surface_form: "Ragger",
        start_offset: 0,
        end_offset: 6,
        mention_kind: "literal",
        antecedent_surface: null,
      },
      {
        entity_id: ENTITY_ID,
        surface_form: "He",
        start_offset: 16,
        end_offset: 18,
        mention_kind: "coreference",
        antecedent_surface: "Ragger",
      },
    ]);
  } finally {
    await db.close();
  }
});

test("a coreference repeat of an exact literal span is indexed only once", async () => {
  const db = await createKnowledgeTestDatabase();
  try {
    await db.query(
      `INSERT INTO storyhold.world_sources
        (id, world_id, canon_edition_id)
       VALUES ($1, $2, $3)`,
      [SOURCE_ID, WORLD_ID, EDITION_ID],
    );
    await db.query(
      `INSERT INTO storyhold.world_source_chunks
        (id, source_id, world_id, canon_edition_id, chunk_index, content)
       VALUES ($1, $2, $3, $4, 0, 'Ragger stopped. He listened.')`,
      [CHUNK_ID, SOURCE_ID, WORLD_ID, EDITION_ID],
    );
    await syncWorldCoreferenceSpans({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
      result: {
        spans: [{
          sourceId: SOURCE_ID,
          chunkId: CHUNK_ID,
          clusterKey: `${CHUNK_ID}:0`,
          surfaceForm: "Ragger",
          startOffset: 0,
          endOffset: 6,
          context: "Ragger stopped. He listened.",
          clusterMentions: ["Ragger", "He"],
        }],
        receipt: {
          status: "completed",
          model: "biu-nlp/f-coref",
          attemptedChunks: 1,
          completedChunkIds: [CHUNK_ID],
          mentionCount: 1,
          elapsedMilliseconds: 12,
          errors: [],
        },
      },
    });

    const indexed = await syncWorldEntityMentions({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
    });
    assert.equal(indexed.mentions, 1);
    assert.equal(indexed.coreferenceMentions, 0);
    const duplicate = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM storyhold.world_entity_mentions
        WHERE chunk_id = $1 AND start_offset = 0 AND end_offset = 6`,
      [CHUNK_ID],
    );
    assert.equal(duplicate.rows[0]?.count, 1);
  } finally {
    await db.close();
  }
});

test("overlapping retrieval prefixes do not double-count literal names", async () => {
  const db = await createKnowledgeTestDatabase();
  try {
    await db.query(
      `INSERT INTO storyhold.world_sources
        (id, world_id, canon_edition_id)
       VALUES ($1, $2, $3)`,
      [SOURCE_ID, WORLD_ID, EDITION_ID],
    );
    await db.query(
      `INSERT INTO storyhold.world_source_chunks
        (id, source_id, world_id, canon_edition_id, chunk_index, content, metadata)
       VALUES ($1, $3, $4, $5, 0, 'Ragger stopped at the gate.', '{}'::jsonb),
              ($2, $3, $4, $5, 1, 'Ragger stopped at the gate. New material.',
               '{"overlapCharCount":27}'::jsonb)`,
      [CHUNK_ID, OVERLAP_CHUNK_ID, SOURCE_ID, WORLD_ID, EDITION_ID],
    );

    const indexed = await syncWorldEntityMentions({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
    });
    assert.equal(indexed.mentions, 1);
    const mentions = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM storyhold.world_entity_mentions
        WHERE entity_id = $1 AND mention_kind = 'literal'`,
      [ENTITY_ID],
    );
    assert.equal(mentions.rows[0]?.count, 1);
  } finally {
    await db.close();
  }
});

test("knowledge claim fingerprints normalize harmless formatting", () => {
  const input = {
    subjectEntityId: "11111111-1111-4111-8111-111111111111",
    predicate: "  Member   Of ",
    objectText: " The  Co-op ",
    truthStatus: "fact" as const,
  };
  assert.equal(
    knowledgeClaimFingerprint(input),
    knowledgeClaimFingerprint({
      ...input,
      predicate: "member of",
      objectText: "the co-op",
    }),
  );
  assert.equal(
    knowledgeClaimFingerprint(input),
    knowledgeClaimFingerprint({ ...input, polarity: "positive" }),
  );
  assert.notEqual(
    knowledgeClaimFingerprint(input),
    knowledgeClaimFingerprint({ ...input, polarity: "negative" }),
  );
});

test("positive and negative canon claims persist as separate atomic facts", async () => {
  const db = await createKnowledgeTestDatabase();
  try {
    const result = await syncWorldKnowledgeClaims({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
      assignmentSource: "user",
      claims: [{
        subject: "Ragger",
        predicate: "child_of",
        object: "Alec",
        polarity: "positive",
        truthStatus: "belief",
        evidence: [],
        confidence: 0.4,
      }, {
        subject: "Ragger",
        predicate: "child_of",
        object: "Alec",
        polarity: "negative",
        truthStatus: "fact",
        evidence: [],
        confidence: 1,
      }],
    });
    assert.equal(result.saved, 2);
    const saved = await db.query<{
      polarity: string;
      truth_status: string;
    }>(
      `SELECT polarity, truth_status
         FROM storyhold.world_knowledge_claims
        ORDER BY polarity`,
    );
    assert.deepEqual(saved.rows, [{
      polarity: "negative",
      truth_status: "fact",
    }, {
      polarity: "positive",
      truth_status: "belief",
    }]);
  } finally {
    await db.close();
  }
});

test("an explicit later claim retires the earlier AI belief but preserves its history", async () => {
  const db = await createKnowledgeTestDatabase();
  try {
    const earlier = {
      subject: "Ragger",
      predicate: "believed_status",
      object: "Alec was dead",
      epistemicHolder: "Ragger",
      truthStatus: "belief" as const,
      validFromLabel: "Before the reunion",
      validUntilLabel: "",
      evidence: [{ sourceId: SOURCE_ID, chunkId: CHUNK_ID, quote: "Ragger believed Alec was dead." }],
      confidence: 0.8,
    };
    await syncWorldKnowledgeClaims({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
      assignmentSource: "ai",
      claims: [earlier],
    });
    await syncWorldKnowledgeClaims({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
      assignmentSource: "ai",
      claims: [{
        subject: "Ragger",
        predicate: "knows_status",
        object: "Alec is alive",
        epistemicHolder: "Ragger",
        truthStatus: "fact",
        validFromLabel: "At the reunion",
        validUntilLabel: "",
        evidence: [{ sourceId: SOURCE_ID, chunkId: CHUNK_ID, quote: "Ragger saw Alec alive." }],
        confidence: 0.99,
        supersedes: {
          subject: earlier.subject,
          predicate: earlier.predicate,
          object: earlier.object,
          epistemicHolder: earlier.epistemicHolder,
          truthStatus: earlier.truthStatus,
          validFromLabel: earlier.validFromLabel,
          validUntilLabel: earlier.validUntilLabel,
        },
      }, earlier],
    });
    const stored = await db.query<{
      predicate: string;
      claim_status: string;
      valid_until_label: string;
      supersedes_claim_id: string | null;
    }>(
      `SELECT predicate, claim_status, valid_until_label, supersedes_claim_id
         FROM storyhold.world_knowledge_claims
        ORDER BY predicate`,
    );
    assert.equal(stored.rows.length, 2);
    const earlierStored = stored.rows.find((row) => row.predicate === "believed_status");
    const laterStored = stored.rows.find((row) => row.predicate === "knows_status");
    assert.equal(earlierStored?.claim_status, "superseded");
    assert.equal(earlierStored?.valid_until_label, "At the reunion");
    assert.ok(laterStored?.supersedes_claim_id);
  } finally {
    await db.close();
  }
});

test("mention extraction keeps exact offsets and prefers the longest label", () => {
  const content = "The shuttle crossed Hill AFB before Hill went dark.";
  const mentions = extractEntityMentionsFromChunk({
    content,
    entities: [
      { id: "hill", name: "Hill", aliases: [] },
      { id: "hill-afb", name: "Hill AFB", aliases: [] },
    ],
  });
  assert.deepEqual(
    mentions.map((mention) => ({
      id: mention.entityId,
      surface: content.slice(mention.startOffset, mention.endOffset),
    })),
    [
      { id: "hill-afb", surface: "Hill AFB" },
      { id: "hill", surface: "Hill" },
    ],
  );
});

test("a shared alias is retained as ambiguous instead of assigned arbitrarily", () => {
  const [mention] = extractEntityMentionsFromChunk({
    content: "Alex opened the door.",
    entities: [
      { id: "alex-one", name: "Alexandra North", aliases: ["Alex"] },
      { id: "alex-two", name: "Alexander Vale", aliases: ["Alex"] },
    ],
  });
  assert.equal(mention?.entityId, null);
  assert.equal(mention?.resolutionStatus, "ambiguous");
});

test("a canonical character count includes every resolved alias spelling", () => {
  const content = "Alec checked the gate. Alec Sumner called Echo. Alec followed.";
  const mentions = extractEntityMentionsFromChunk({
    content,
    entities: [{
      id: "alec-sumner",
      name: "Alec Sumner",
      aliases: ["Alec"],
    }],
  });
  assert.deepEqual(
    mentions.map((mention) => ({
      entityId: mention.entityId,
      surface: content.slice(mention.startOffset, mention.endOffset),
    })),
    [
      { entityId: "alec-sumner", surface: "Alec" },
      { entityId: "alec-sumner", surface: "Alec Sumner" },
      { entityId: "alec-sumner", surface: "Alec" },
    ],
  );
});

test("a proper nickname does not absorb the same lowercase common noun", () => {
  const content = 'A low buzz filled the room. David grinned. "Buzz, get over here."';
  const mentions = extractEntityMentionsFromChunk({
    content,
    entities: [{
      id: "alec-sumner",
      name: "Alec Sumner",
      aliases: ["Alec", "Buzz"],
    }],
  });
  assert.deepEqual(
    mentions.map((mention) => content.slice(mention.startOffset, mention.endOffset)),
    ["Buzz"],
  );
});

test("a short familiar alias excludes dialect elisions but keeps named uses", () => {
  const content = [
    `Kendall said, "Easy, Lil."`,
    `I was a lil’ nervous about my lil' brother.`,
    `Lil’ old me had no answer.`,
    `"Easy, lil," Kendall repeated.`,
    `Lil's answer came a moment later.`,
  ].join(" ");
  const mentions = extractEntityMentionsFromChunk({
    content,
    entities: [{
      id: "lilly",
      name: "Lilly",
      aliases: ["Lil"],
    }],
  });
  assert.deepEqual(
    mentions.map((mention) => content.slice(mention.startOffset, mention.endOffset)),
    ["Lil", "lil", "Lil"],
  );
  assert.ok(mentions.every((mention) => mention.entityId === "lilly"));
  assert.ok(mentions.every((mention) => !/^lil['’](?!s\b)/iu.test(
    content.slice(mention.startOffset, mention.endOffset + 2),
  )));
});

test("mention sync never transfers lowercase dialect uses through a short alias", async () => {
  const db = await createKnowledgeTestDatabase();
  try {
    const content = `Kendall said, "Lil, wait." I was a lil’ nervous. My lil' brother stayed behind.`;
    await db.query(
      `UPDATE storyhold.world_entities
          SET name = 'Lilly', aliases = '["Lil"]'::jsonb
        WHERE id = $1`,
      [ENTITY_ID],
    );
    await db.query(
      `INSERT INTO storyhold.world_sources
        (id, world_id, canon_edition_id)
       VALUES ($1, $2, $3)`,
      [SOURCE_ID, WORLD_ID, EDITION_ID],
    );
    await db.query(
      `INSERT INTO storyhold.world_source_chunks
        (id, source_id, world_id, canon_edition_id, chunk_index, content)
       VALUES ($1, $2, $3, $4, 0, $5)`,
      [CHUNK_ID, SOURCE_ID, WORLD_ID, EDITION_ID, content],
    );

    const indexed = await syncWorldEntityMentions({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
    });
    assert.equal(indexed.mentions, 1);
    const saved = await db.query<{
      entity_id: string | null;
      surface_form: string;
      start_offset: number;
      end_offset: number;
    }>(
      `SELECT entity_id, surface_form, start_offset, end_offset
         FROM storyhold.world_entity_mentions
        WHERE chunk_id = $1
        ORDER BY start_offset`,
      [CHUNK_ID],
    );
    assert.deepEqual(saved.rows, [{
      entity_id: ENTITY_ID,
      surface_form: "Lil",
      start_offset: content.indexOf("Lil"),
      end_offset: content.indexOf("Lil") + 3,
    }]);
  } finally {
    await db.close();
  }
});

test("an exact canonical name wins over another card's alias", async () => {
  const db = await createKnowledgeTestDatabase();
  try {
    await db.query(
      `INSERT INTO storyhold.world_entities
        (id, world_id, canon_edition_id, name, aliases)
       VALUES ($1, $2, $3, 'Anubsika', '["Ragger"]'::jsonb)`,
      ["10000000-0000-4000-8000-000000000030", WORLD_ID, EDITION_ID],
    );
    const result = await syncWorldKnowledgeClaims({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
      assignmentSource: "user",
      claims: [{
        subject: "Ragger",
        predicate: "held title",
        object: "Anubsika",
        truthStatus: "fact",
        evidence: [],
        confidence: 1,
      }],
    });
    assert.equal(result.saved, 1);
    assert.equal(result.unresolved, 0);
    assert.deepEqual(result.referenceIssues, []);
    const saved = await db.query<{ subject_entity_id: string }>(
      `SELECT subject_entity_id FROM storyhold.world_knowledge_claims
        WHERE world_id = $1 AND canon_edition_id = $2`,
      [WORLD_ID, EDITION_ID],
    );
    assert.equal(saved.rows[0]?.subject_entity_id, ENTITY_ID);
  } finally {
    await db.close();
  }
});

test("an unresolved epistemic holder is reported instead of erased", async () => {
  const db = await createKnowledgeTestDatabase();
  try {
    const result = await syncWorldKnowledgeClaims({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
      assignmentSource: "user",
      claims: [{
        subject: "Ragger",
        predicate: "survived",
        object: "the scouting mission",
        epistemicHolder: "The unnamed witness",
        truthStatus: "belief",
        evidence: [],
        confidence: 0.8,
      }],
    });
    assert.equal(result.saved, 0);
    assert.equal(result.unresolved, 1);
    assert.deepEqual(result.referenceIssues, [{
      kind: "claim_epistemic_holder",
      label: "The unnamed witness",
      resolution: "missing",
      context: "Ragger survived the scouting mission",
    }]);
    const saved = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM storyhold.world_knowledge_claims",
    );
    assert.equal(saved.rows[0]?.count, 0);
  } finally {
    await db.close();
  }
});

test("customer merge chains resolve every retired name to the active target", async () => {
  const db = await createKnowledgeTestDatabase();
  try {
    const middleId = "10000000-0000-4000-8000-000000000031";
    const sourceId = "10000000-0000-4000-8000-000000000032";
    await db.query(
      `INSERT INTO storyhold.world_entities
        (id, world_id, canon_edition_id, name, aliases, pull_status,
         merged_into_entity_id)
       VALUES
        ($1, $4, $5, 'Old Dog', '["Old Dog narrator", "Ancient Name"]'::jsonb,
         'merged', $3),
        ($2, $4, $5, 'Anubsika', '["Anubis", "Ancient Name"]'::jsonb,
         'merged', $1)`,
      [middleId, sourceId, ENTITY_ID, WORLD_ID, EDITION_ID],
    );
    await db.query(
      `INSERT INTO storyhold.world_entities
        (id, world_id, canon_edition_id, name, aliases, pull_status)
       VALUES
        ('10000000-0000-4000-8000-000000000033', $1, $2,
         'Suppressed name', '[]'::jsonb, 'do_not_pull'),
        ('10000000-0000-4000-8000-000000000034', $1, $2,
         'Discarded name', '[]'::jsonb, 'deleted')`,
      [WORLD_ID, EDITION_ID],
    );

    const merged = await syncWorldKnowledgeClaims({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
      assignmentSource: "user",
      claims: [{
        subject: "Anubsika",
        predicate: "remembered",
        object: "the ancient expedition",
        epistemicHolder: "Ancient Name",
        truthStatus: "belief",
        evidence: [],
        confidence: 1,
      }],
    });
    assert.equal(merged.saved, 1);
    assert.equal(merged.unresolved, 0);
    assert.deepEqual(merged.referenceIssues, []);
    const saved = await db.query<{
      subject_entity_id: string;
      epistemic_holder_entity_id: string;
    }>(
      `SELECT subject_entity_id, epistemic_holder_entity_id
         FROM storyhold.world_knowledge_claims
        WHERE world_id = $1 AND canon_edition_id = $2`,
      [WORLD_ID, EDITION_ID],
    );
    assert.deepEqual(saved.rows, [{
      subject_entity_id: ENTITY_ID,
      epistemic_holder_entity_id: ENTITY_ID,
    }]);

    const excluded = await syncWorldKnowledgeClaims({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
      assignmentSource: "user",
      claims: [
        {
          subject: "Suppressed name",
          predicate: "should not",
          object: "resolve",
          truthStatus: "fact",
          evidence: [],
          confidence: 1,
        },
        {
          subject: "Ragger",
          predicate: "was remembered by",
          object: "someone",
          epistemicHolder: "Discarded name",
          truthStatus: "belief",
          evidence: [],
          confidence: 1,
        },
      ],
    });
    assert.equal(excluded.saved, 0);
    assert.equal(excluded.unresolved, 2);
    assert.deepEqual(
      excluded.referenceIssues.map((issue) => [
        issue.kind,
        issue.label,
        issue.resolution,
      ]),
      [
        ["claim_subject", "Suppressed name", "missing"],
        ["claim_epistemic_holder", "Discarded name", "missing"],
      ],
    );
  } finally {
    await db.close();
  }
});

test("an automatic AI claim pass cannot overwrite or retire customer canon", async () => {
  const db = await createKnowledgeTestDatabase();
  try {
    const customerClaim = {
      subject: "Ragger",
      predicate: "served as",
      object: "Karagorn",
      truthStatus: "fact" as const,
      summary: "Customer-confirmed former title.",
      evidence: [],
      confidence: 0.37,
    };
    await syncWorldKnowledgeClaims({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
      assignmentSource: "user",
      claims: [customerClaim],
    });
    await db.query(
      `UPDATE storyhold.world_knowledge_claims
          SET claim_status = 'disputed', updated_at = $1
        WHERE world_id = $2 AND canon_edition_id = $3`,
      [USER_EDITED_AT, WORLD_ID, EDITION_ID],
    );

    const before = await db.query<Record<string, unknown>>(
      `SELECT summary, evidence, confidence, claim_status, assignment_source,
              source_analysis_run_id, updated_at
         FROM storyhold.world_knowledge_claims
        WHERE world_id = $1 AND canon_edition_id = $2`,
      [WORLD_ID, EDITION_ID],
    );
    await syncWorldKnowledgeClaims({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
      assignmentSource: "ai",
      replaceAiSnapshot: true,
      claims: [{
        ...customerClaim,
        summary: "AI attempted replacement.",
        confidence: 0.99,
        evidence: [{
          sourceId: "source-from-ai",
          chunkId: "chunk-from-ai",
          quote: "AI supplied evidence.",
        }],
      }],
    });
    await syncWorldKnowledgeClaims({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
      assignmentSource: "ai",
      replaceAiSnapshot: true,
      claims: [],
    });
    const after = await db.query<Record<string, unknown>>(
      `SELECT summary, evidence, confidence, claim_status, assignment_source,
              source_analysis_run_id, updated_at
         FROM storyhold.world_knowledge_claims
        WHERE world_id = $1 AND canon_edition_id = $2`,
      [WORLD_ID, EDITION_ID],
    );

    assert.equal(after.rows.length, 1);
    assert.deepEqual(after.rows, before.rows);
  } finally {
    await db.close();
  }
});

test("deferred premium claims preserve earlier canon while explicit verified succession still applies", async () => {
  const db = await createKnowledgeTestDatabase();
  try {
    const earlier = {
      subject: "Ragger", predicate: "served as", object: "Karagorn",
      polarity: "positive" as const, truthStatus: "fact" as const,
      validFromLabel: "before the departure", validUntilLabel: "",
      evidence: [{ chunkId: "fixture", sourceId: "source", quote: "Ragger served as Karagorn before the departure." }],
      confidence: 0.9,
    };
    await syncWorldKnowledgeClaims({ db, worldId: WORLD_ID, editionId: EDITION_ID, assignmentSource: "ai", claims: [earlier] });
    await syncWorldKnowledgeClaims({ db, worldId: WORLD_ID, editionId: EDITION_ID, assignmentSource: "ai",
      claims: [], replaceAiSnapshot: true, preserveUnreviewedAiClaims: true });
    const retained = await db.query<{ claim_status: string }>("SELECT claim_status FROM storyhold.world_knowledge_claims");
    assert.deepEqual(retained.rows, [{ claim_status: "active" }], "absence is not a retraction verdict");
    await syncWorldKnowledgeClaims({ db, worldId: WORLD_ID, editionId: EDITION_ID, assignmentSource: "ai",
      replaceAiSnapshot: true, preserveUnreviewedAiClaims: true,
      claims: [{ ...earlier, polarity: "negative", validFromLabel: "after the departure", supersedes: earlier }],
    });
    const rows = await db.query<{ polarity: string; claim_status: string; supersedes_claim_id: string | null }>(
      "SELECT polarity, claim_status, supersedes_claim_id FROM storyhold.world_knowledge_claims ORDER BY polarity",
    );
    assert.equal(rows.rows.find((row) => row.polarity === "positive")?.claim_status, "superseded");
    assert.equal(rows.rows.find((row) => row.polarity === "negative")?.claim_status, "active");
    assert.ok(rows.rows.find((row) => row.polarity === "negative")?.supersedes_claim_id);
  } finally { await db.close(); }
});

test("an automatic AI event pass cannot overwrite or delete a customer participant", async () => {
  const db = await createKnowledgeTestDatabase();
  try {
    await syncWorldEventParticipants({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
      assignmentSource: "user",
      participants: [{
        eventId: EVENT_ID,
        entity: "Ragger",
        role: "actor",
        evidence: [],
        confidence: 0.42,
      }],
    });
    await db.query(
      `UPDATE storyhold.world_event_participants
          SET updated_at = $1
        WHERE event_id = $2`,
      [USER_EDITED_AT, EVENT_ID],
    );
    const before = await db.query<Record<string, unknown>>(
      `SELECT entity_id, participant_role, evidence, confidence,
              assignment_source, updated_at
         FROM storyhold.world_event_participants
        WHERE event_id = $1`,
      [EVENT_ID],
    );

    await syncWorldEventParticipants({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
      assignmentSource: "ai",
      eventIds: [EVENT_ID],
      participants: [{
        eventId: EVENT_ID,
        entity: "Ragger",
        role: "actor",
        evidence: [{
          sourceId: "source-from-ai",
          chunkId: "chunk-from-ai",
          quote: "AI supplied evidence.",
        }],
        confidence: 0.99,
      }],
    });
    await syncWorldEventParticipants({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
      assignmentSource: "ai",
      eventIds: [EVENT_ID],
      participants: [],
    });
    const after = await db.query<Record<string, unknown>>(
      `SELECT entity_id, participant_role, evidence, confidence,
              assignment_source, updated_at
         FROM storyhold.world_event_participants
        WHERE event_id = $1`,
      [EVENT_ID],
    );

    assert.equal(after.rows.length, 1);
    assert.deepEqual(after.rows, before.rows);
  } finally {
    await db.close();
  }
});

test("world-event relations persist only grounded edges to a unique retained event", async () => {
  const db = await createKnowledgeTestDatabase();
  try {
    const synced = await syncWorldEventRelations({
      db,
      worldId: WORLD_ID,
      editionId: EDITION_ID,
      eventIds: [EVENT_ID, SECOND_EVENT_ID],
      assignmentSource: "ai",
      relations: [{
        sourceEventId: EVENT_ID,
        sourceEventName: "Ragger opens the archive",
        targetEvent: "Alec learns the hidden history",
        relationType: "enables",
        summary: "The opened archive makes the hidden account available.",
        evidence: [{
          sourceId: SOURCE_ID,
          chunkId: CHUNK_ID,
          quote: "Ragger opened the archive for Alec.",
        }],
        confidence: 0.94,
      }, {
        sourceEventId: EVENT_ID,
        sourceEventName: "Ragger opens the archive",
        targetEvent: "An event that does not exist",
        relationType: "causes",
        summary: "This must not be guessed.",
        evidence: [{ sourceId: SOURCE_ID, chunkId: CHUNK_ID, quote: "unsupported" }],
        confidence: 0.4,
      }],
    });
    assert.equal(synced.saved, 1);
    assert.equal(synced.unresolved, 1);
    assert.equal(synced.referenceIssues[0]?.kind, "event_relation_target");
    const stored = await db.query<Record<string, unknown>>(
      `SELECT source_event_id, target_event_id, relation_type, summary, evidence
         FROM storyhold.world_event_relations`,
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0]?.source_event_id, EVENT_ID);
    assert.equal(stored.rows[0]?.target_event_id, SECOND_EVENT_ID);
    assert.equal(stored.rows[0]?.relation_type, "enables");
  } finally {
    await db.close();
  }
});
