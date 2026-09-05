import type { PGlite } from "@electric-sql/pglite";
import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import { readPremiumJournalSnapshot } from "./premiumReviewJournal";
import {
  approvedWorldClockProjection,
  assertWorldClockVerificationReceipts, validateWorldClockVerification, type WorldClockVerificationInput,
  type WorldClockVerificationReceipt,
} from "./worldClockVerification";

type ClockDb = Pick<PGlite, "query">;
type ReviewRow = {
  run_id: string; world_id: string; edition_id: string; step_key: string;
  receipt_fingerprint: string; snapshot_fingerprint: string; snapshot: WorldClockVerificationReceipt;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const hash = (value: unknown): string => canonPayloadFingerprint(value as JsonObject);
const clean = (value: string): string => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
export class WorldClockPersistenceError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "WorldClockPersistenceError"; }
}
function fail(code: string, message: string): never { throw new WorldClockPersistenceError(code, message); }
function jsonCopy<T>(value: T): T {
  try {
    const before = hash(value);
    const result = JSON.parse(JSON.stringify(value)) as T;
    if (hash(result) !== before) fail("CLOCK_RECEIPT_INVALID", "The clock receipt changed during durable JSON serialization.");
    return result;
  } catch (error) {
    if (error instanceof WorldClockPersistenceError) throw error;
    fail("CLOCK_RECEIPT_INVALID", "The clock receipt is not finite durable JSON.");
  }
}
function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) fail("CLOCK_ID_INVALID", `${label} must be a stable UUID.`);
  return value;
}

export const worldClockPersistenceSchemaSql = String.raw`
  ALTER TABLE storyhold.world_clock_events ADD COLUMN IF NOT EXISTS truth_status text NOT NULL DEFAULT 'unknown'
    CHECK (truth_status IN ('fact', 'belief', 'rumor', 'lie', 'disputed', 'unknown'));
  ALTER TABLE storyhold.world_clock_events ADD COLUMN IF NOT EXISTS epistemic_holder_entity_id uuid
    REFERENCES storyhold.world_entities(id) ON DELETE SET NULL;
  ALTER TABLE storyhold.world_clock_events ADD COLUMN IF NOT EXISTS assignment_source text NOT NULL DEFAULT 'local'
    CHECK (assignment_source IN ('local', 'ai', 'user'));
  ALTER TABLE storyhold.world_clock_events ADD COLUMN IF NOT EXISTS source_analysis_run_id uuid
    REFERENCES storyhold.world_analysis_runs(id) ON DELETE SET NULL;
  ALTER TABLE storyhold.world_clock_events ADD COLUMN IF NOT EXISTS aliases jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE storyhold.world_clock_events ADD COLUMN IF NOT EXISTS confidence real NOT NULL DEFAULT 0
    CHECK (confidence >= 0 AND confidence <= 1);
  ALTER TABLE storyhold.world_clock_events ADD COLUMN IF NOT EXISTS verified_importance text NOT NULL DEFAULT 'unspecified'
    CHECK (verified_importance IN ('major','turning_point','unspecified'));

  CREATE TABLE IF NOT EXISTS storyhold.world_analysis_clock_reviews (
    run_id uuid NOT NULL REFERENCES storyhold.world_analysis_runs(id) ON DELETE CASCADE,
    world_id uuid NOT NULL, edition_id uuid NOT NULL,
    step_key text NOT NULL CHECK (length(step_key) BETWEEN 1 AND 200),
    receipt_fingerprint text NOT NULL, snapshot_fingerprint text NOT NULL, snapshot jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (run_id, step_key),
    UNIQUE (world_id, edition_id, run_id, step_key)
  );
  CREATE OR REPLACE FUNCTION storyhold.reject_clock_verification_mutation()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'World Clock verification receipts and links are immutable'; END;
  $$;
  DROP TRIGGER IF EXISTS world_clock_review_immutable ON storyhold.world_analysis_clock_reviews;
  CREATE TRIGGER world_clock_review_immutable BEFORE UPDATE ON storyhold.world_analysis_clock_reviews
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_clock_verification_mutation();

  CREATE TABLE IF NOT EXISTS storyhold.world_clock_event_verifications (
    event_id uuid NOT NULL REFERENCES storyhold.world_clock_events(id) ON DELETE CASCADE,
    world_id uuid NOT NULL, edition_id uuid NOT NULL, run_id uuid NOT NULL, step_key text NOT NULL, proposal_id text NOT NULL,
    decision_id text NOT NULL, payload_fingerprint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (run_id, step_key, proposal_id),
    FOREIGN KEY (world_id,edition_id,run_id,step_key) REFERENCES storyhold.world_analysis_clock_reviews(world_id,edition_id,run_id,step_key) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS storyhold.world_event_participant_verifications (
    participant_id uuid NOT NULL REFERENCES storyhold.world_event_participants(id) ON DELETE CASCADE,
    world_id uuid NOT NULL, edition_id uuid NOT NULL, run_id uuid NOT NULL, step_key text NOT NULL, proposal_id text NOT NULL,
    decision_id text NOT NULL, payload_fingerprint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (run_id, step_key, proposal_id),
    FOREIGN KEY (world_id,edition_id,run_id,step_key) REFERENCES storyhold.world_analysis_clock_reviews(world_id,edition_id,run_id,step_key) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS storyhold.world_event_relation_verifications (
    relation_id uuid NOT NULL REFERENCES storyhold.world_event_relations(id) ON DELETE CASCADE,
    world_id uuid NOT NULL, edition_id uuid NOT NULL, run_id uuid NOT NULL, step_key text NOT NULL, proposal_id text NOT NULL,
    decision_id text NOT NULL, payload_fingerprint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (run_id, step_key, proposal_id),
    FOREIGN KEY (world_id,edition_id,run_id,step_key) REFERENCES storyhold.world_analysis_clock_reviews(world_id,edition_id,run_id,step_key) ON DELETE CASCADE
  );
  DROP TRIGGER IF EXISTS world_clock_event_link_immutable ON storyhold.world_clock_event_verifications;
  CREATE TRIGGER world_clock_event_link_immutable BEFORE UPDATE ON storyhold.world_clock_event_verifications
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_clock_verification_mutation();
  DROP TRIGGER IF EXISTS world_clock_participant_link_immutable ON storyhold.world_event_participant_verifications;
  CREATE TRIGGER world_clock_participant_link_immutable BEFORE UPDATE ON storyhold.world_event_participant_verifications
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_clock_verification_mutation();
  DROP TRIGGER IF EXISTS world_clock_relation_link_immutable ON storyhold.world_event_relation_verifications;
  CREATE TRIGGER world_clock_relation_link_immutable BEFORE UPDATE ON storyhold.world_event_relation_verifications
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_clock_verification_mutation();
`;

export async function ensureWorldClockPersistence(db: Pick<PGlite, "exec">): Promise<void> {
  await db.exec(worldClockPersistenceSchemaSql);
}

async function assertRun(db: ClockDb, input: WorldClockVerificationInput): Promise<void> {
  const { scope } = input;
  uuid(scope.worldId, "World ID"); uuid(scope.editionId, "Edition ID"); uuid(scope.analysisRunId, "Analysis run ID");
  const rows = await db.query(`SELECT id FROM storyhold.world_analysis_runs
    WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3 AND analysis_kind = 'ai_enrichment' FOR UPDATE`,
  [scope.analysisRunId, scope.worldId, scope.editionId]);
  if (rows.rows.length !== 1) fail("CLOCK_SCOPE_MISMATCH", "The paid analysis run no longer matches this World Clock's world and edition.");
}

async function assertSourcesUnchanged(db: ClockDb, input: WorldClockVerificationInput): Promise<void> {
  const expected = input.chunks.map((chunk) => ({ id: uuid(chunk.id, "Source chunk ID"), sourceId: uuid(chunk.sourceId, "Source ID"), content: chunk.content }));
  if (new Set(expected.map((chunk) => chunk.id)).size !== expected.length) fail("CLOCK_SOURCE_CHANGED", "The clock review contains duplicate source chunk identities.");
  if (!expected.length) fail("CLOCK_SOURCE_CHANGED", "A verified clock review requires its exact manuscript source packet.");
  const result = await db.query<{ id: string; source_id: string; content: string }>(
    `SELECT chunk.id, chunk.source_id, chunk.content
       FROM storyhold.world_source_chunks chunk
       JOIN storyhold.world_sources source ON source.id = chunk.source_id
      WHERE chunk.world_id = $1 AND chunk.canon_edition_id = $2
        AND source.world_id = $1 AND source.canon_edition_id = $2
        AND source.processing_status = 'ready' AND source.canon_status IN ('candidate','canon')
        AND chunk.id = ANY($3::uuid[]) FOR SHARE OF chunk,source`,
    [input.scope.worldId, input.scope.editionId, expected.map((chunk) => chunk.id)],
  );
  const actual = new Map(result.rows.map((row) => [row.id, row]));
  if (actual.size !== expected.length || expected.some((chunk) => {
    const row = actual.get(chunk.id);
    return !row || row.source_id !== chunk.sourceId || row.content !== chunk.content;
  })) fail("CLOCK_SOURCE_CHANGED", "The manuscript source packet changed after this paid World Clock review; the saved response remains recoverable but was not applied.");
}

async function assertFrozenEntityRegistry(db:ClockDb,input:WorldClockVerificationInput):Promise<void>{
  const supplied=input.entities;
  if(!Array.isArray(supplied)||new Set(supplied.map((entity)=>entity.id)).size!==supplied.length)fail("CLOCK_REGISTRY_CHANGED","The frozen canonical entity registry is malformed.");
  const rows=(await db.query<{id:string;name:string;entity_type:string;aliases:unknown}>(`SELECT id,name,entity_type,aliases
    FROM storyhold.world_entities WHERE world_id=$1 AND canon_edition_id=$2 AND pull_status='active' AND merged_into_entity_id IS NULL FOR SHARE`,
  [input.scope.worldId,input.scope.editionId])).rows;
  const actual=new Map(rows.map((row)=>[row.id,row]));
  const exact=actual.size===supplied.length&&supplied.every((entity)=>{
    const row=actual.get(uuid(entity.id,"Canonical entity ID"));
    return row&&row.name===entity.name&&row.entity_type===entity.entityType&&hash(row.aliases)===hash(entity.aliases);
  });
  if(!exact)fail("CLOCK_REGISTRY_CHANGED","The canonical entity registry changed after dispatch; the saved paid response remains recoverable but no clock record was applied.");
}

async function assertOwnerConstraintsUnchanged(db: ClockDb, input: WorldClockVerificationInput): Promise<void> {
  const expected = input.ownerConstraints ?? [];
  const rows = (await db.query<{ id: string; constraint_kind: string; instruction: string; scope_entity_id: string | null }>(
    `SELECT id, constraint_kind, instruction, scope_entity_id
       FROM storyhold.world_owner_canon_constraints
      WHERE world_id = $1 AND canon_edition_id = $2 AND status = 'active'
      ORDER BY id ASC
      FOR SHARE`,
    [input.scope.worldId, input.scope.editionId],
  )).rows;
  const mapped = rows.map((row) => ({
    id: row.id,
    kind: ({
      identity: "identity",
      relationship: "relation",
      category: "categorization",
      chronology: "timeline",
      fact: "canon",
      focus: "other",
    } as const)[row.constraint_kind as "identity" | "relationship" | "category" | "chronology" | "fact" | "focus"],
    instruction: row.instruction,
    scopeEntityId: row.scope_entity_id,
  }));
  if (mapped.some((item) => !item.kind) || hash(mapped) !== hash(expected)) {
    fail(
      "CLOCK_CONSTRAINTS_CHANGED",
      "The owner's active canon corrections changed after dispatch; the saved paid response remains recoverable but no clock record was applied.",
    );
  }
}

function actualVerifier(result: NonNullable<Awaited<ReturnType<typeof readPremiumJournalSnapshot>>["rows"][number]["result_snapshot"]>) {
  if (!result.journalCompletedAt) fail("CLOCK_JOURNAL_MISMATCH", "The saved paid response has no durable completion time.");
  return { provider: result.provider, model: result.runtime.execution?.resolvedModel ?? result.model, completedAt: result.journalCompletedAt };
}
function responseObject(value: string): Record<string, unknown> {
  try {
    const trimmed = value.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
    const start = trimmed.indexOf("{"); const end = trimmed.lastIndexOf("}");
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch { fail("CLOCK_JOURNAL_MISMATCH", "The exact saved paid response no longer contains a valid World Clock result."); }
}

async function assertExactPaidReceipt(db: ClockDb, input: WorldClockVerificationInput, supplied: WorldClockVerificationReceipt): Promise<WorldClockVerificationReceipt> {
  const journal = await readPremiumJournalSnapshot(db, input.scope.analysisRunId);
  const stepKey = supplied.request.stepKey;
  const rows = journal.rows.filter((row) => row.step_key === stepKey);
  if (rows.length !== 1 || rows[0]!.status !== "completed" || !rows[0]!.result_snapshot) fail("CLOCK_JOURNAL_MISMATCH", "Canonical clock writes require the exact completed paid response journal entry.");
  const stored = validateWorldClockVerification(input, responseObject(rows[0]!.result_snapshot.text), actualVerifier(rows[0]!.result_snapshot), supplied.request.page.index);
  if (hash(stored) !== hash(supplied)) fail("CLOCK_JOURNAL_MISMATCH", "The supplied World Clock receipt is not the receipt reconstructed from the exact saved paid response.");
  return jsonCopy(stored);
}

async function saveReceipt(db: ClockDb, receipt: WorldClockVerificationReceipt): Promise<void> {
  const scope = receipt.request.scope; const full = hash(receipt);
  await db.query(`INSERT INTO storyhold.world_analysis_clock_reviews
      (run_id,world_id,edition_id,step_key,receipt_fingerprint,snapshot_fingerprint,snapshot)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (run_id,step_key) DO NOTHING`,
  [scope.analysisRunId, scope.worldId, scope.editionId, receipt.request.stepKey, receipt.fingerprint, full, JSON.stringify(receipt)]);
  const stored = (await db.query<ReviewRow>("SELECT * FROM storyhold.world_analysis_clock_reviews WHERE run_id=$1 AND step_key=$2",
    [scope.analysisRunId, receipt.request.stepKey])).rows[0];
  if (!stored || stored.run_id !== scope.analysisRunId || stored.world_id !== scope.worldId || stored.edition_id !== scope.editionId
      || stored.receipt_fingerprint !== receipt.fingerprint || stored.snapshot_fingerprint !== full || hash(stored.snapshot) !== full) {
    fail("CLOCK_RECEIPT_MISMATCH", "A different or damaged immutable World Clock receipt occupies this paid review step.");
  }
}

function knowledgeStatus(truthStatus: string): string {
  if (truthStatus === "fact") return "observed";
  if (truthStatus === "rumor") return "told";
  if (truthStatus === "disputed" || truthStatus === "lie") return "disputed";
  return "inferred";
}
function evidenceSourceId(evidence: Array<{ sourceId: string }>): string | null { return evidence[0]?.sourceId ?? null; }
function decisionByProposal(receipts: readonly WorldClockVerificationReceipt[]): Map<string, { decision: { id: string }; receipt: WorldClockVerificationReceipt }> {
  const result = new Map<string, { decision: { id: string }; receipt: WorldClockVerificationReceipt }>();
  for (const receipt of receipts) for (const decision of receipt.decisions) {
    if (result.has(decision.proposalId)) fail("CLOCK_RECEIPT_INVALID", "A clock proposal has more than one verification decision.");
    result.set(decision.proposalId, { decision, receipt });
  }
  return result;
}

export type WorldClockProjectionResult = {
  events:number;participants:number;relations:number;replayed:boolean;
  withheld:Array<{proposalId:string;recordType:"participant"|"event_relation";reason:
    "source_event_not_approved"|"target_event_not_approved"|"duplicate_participant"|"duplicate_event_relation"}>;
};
export type WorldClockProjectionReview = { input: WorldClockVerificationInput; receipts: readonly WorldClockVerificationReceipt[] };

/** Caller owns the encompassing transaction. It intentionally has no DELETE,
 * omission cleanup, supersession mutation, provider call, or nested transaction. */
export async function applyVerifiedWorldClockProjection(db: ClockDb, params: {
  reviews: readonly WorldClockProjectionReview[];
}): Promise<WorldClockProjectionResult> {
  if (!params.reviews.length) fail("CLOCK_RECEIPTS_INCOMPLETE", "At least one independently journaled World Clock review is required.");
  const firstScope=params.reviews[0]!.input.scope;
  const reviewed: Array<{input:WorldClockVerificationInput;receipts:WorldClockVerificationReceipt[];
    projection:ReturnType<typeof approvedWorldClockProjection>;decisions:ReturnType<typeof decisionByProposal>}> = [];
  for (const group of params.reviews) {
    if (group.input.scope.worldId!==firstScope.worldId || group.input.scope.editionId!==firstScope.editionId
        || group.input.scope.analysisRunId!==firstScope.analysisRunId) fail("CLOCK_SCOPE_MISMATCH","All World Clock review groups must belong to one exact world, edition and paid run.");
    await assertRun(db,group.input); await assertSourcesUnchanged(db,group.input); await assertFrozenEntityRegistry(db,group.input);
    await assertOwnerConstraintsUnchanged(db, group.input);
    assertWorldClockVerificationReceipts(group.input,group.receipts);
    const receipts:WorldClockVerificationReceipt[]=[];
    for(const supplied of group.receipts) receipts.push(await assertExactPaidReceipt(db,group.input,supplied));
    assertWorldClockVerificationReceipts(group.input,receipts);
    for(const receipt of receipts) await saveReceipt(db,receipt);
    reviewed.push({input:group.input,receipts,projection:approvedWorldClockProjection(group.input,receipts),decisions:decisionByProposal(receipts)});
  }
  const expectedChronologySteps=new Set(reviewed.flatMap((group)=>group.receipts.map((receipt)=>receipt.request.stepKey)));
  if(expectedChronologySteps.size!==reviewed.reduce((count,group)=>count+group.receipts.length,0))fail("CLOCK_RECEIPTS_INCOMPLETE","Clock review groups cannot reuse one paid journal step.");
  const journalChronologySteps=(await readPremiumJournalSnapshot(db,firstScope.analysisRunId)).rows
    .map((row)=>row.step_key).filter((step)=>/^chronology:\d+(?::\d+)?$/u.test(step));
  if(journalChronologySteps.length!==expectedChronologySteps.size||journalChronologySteps.some((step)=>!expectedChronologySteps.has(step))){
    fail("CLOCK_RECEIPTS_INCOMPLETE","The World Clock receipt aggregate does not exactly cover the paid chronology journal manifest.");
  }
  const before = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM (
    SELECT proposal_id FROM storyhold.world_clock_event_verifications WHERE run_id=$1
    UNION ALL SELECT proposal_id FROM storyhold.world_event_participant_verifications WHERE run_id=$1
    UNION ALL SELECT proposal_id FROM storyhold.world_event_relation_verifications WHERE run_id=$1) applied`,
  [firstScope.analysisRunId]);
  let eventCount = 0; let participantCount = 0; let relationCount = 0;

  for (const group of reviewed) for (const item of group.projection.events) {
    const event = item.payload;
    const eventId = uuid(event.eventId, "Canonical event ID");
    const holderId = event.epistemicHolderId === null ? null : uuid(event.epistemicHolderId, "Epistemic holder ID");
    if (holderId) {
      const holder = await db.query("SELECT id FROM storyhold.world_entities WHERE id=$1 AND world_id=$2 AND canon_edition_id=$3 AND pull_status='active' AND merged_into_entity_id IS NULL",
        [holderId, firstScope.worldId, firstScope.editionId]);
      if (holder.rows.length !== 1) fail("CLOCK_REFERENCE_CHANGED", "A verified event's epistemic holder changed or is no longer canonical.");
    }
    const existing = (await db.query<Record<string, unknown>>("SELECT * FROM storyhold.world_clock_events WHERE id=$1 OR (world_id=$2 AND canonical_key=$3) FOR UPDATE",
      [eventId, firstScope.worldId, event.canonicalKey])).rows;
    if (existing.length) {
      const row = existing[0]!;
      const expectedSourceId = evidenceSourceId(item.evidence);
      const exact = existing.length === 1 && row.id === eventId && row.world_id === firstScope.worldId && row.canon_edition_id === firstScope.editionId
        && row.canonical_key === event.canonicalKey && row.title === event.name && row.summary === event.summary
        && row.world_time_label === event.worldTimeLabel && Number(row.chronology_order) === event.chronologyOrder * 1000
        && row.temporal_status === event.temporalStatus && row.verified_importance === event.importance
        && row.truth_status === event.truthStatus && row.epistemic_holder_entity_id === holderId
        && row.campaign_id === null && row.created_by_player_id === null
        && row.source_id === expectedSourceId && row.event_kind === "canon"
        && row.visibility === "world" && row.status === "committed"
        && row.knowledge_status === knowledgeStatus(event.truthStatus)
        && row.importance === (event.importance === "unspecified" ? "major" : event.importance)
        && row.assignment_source === "ai"
        && Number(row.confidence) === item.confidence && hash(row.aliases) === hash(event.aliases)
        && hash(row.source_chapter_keys) === hash(event.sourceChapterKeys) && hash(row.evidence) === hash(item.evidence);
      if (!exact || row.assignment_source === "user" || row.created_by_player_id !== null) fail("CLOCK_CANON_CONFLICT", "A verified event conflicts with an existing or owner-controlled World Clock event; neither record was changed.");
    } else {
      await db.query(`INSERT INTO storyhold.world_clock_events
        (id,world_id,canon_edition_id,source_id,canonical_key,event_kind,title,summary,world_time_label,chronology_order,
         temporal_status,importance,source_chapter_keys,visibility,knowledge_status,truth_status,epistemic_holder_entity_id,
         evidence,status,assignment_source,source_analysis_run_id,aliases,confidence,verified_importance)
       VALUES ($1,$2,$3,$4,$5,'canon',$6,$7,$8,$9,$10,$11,$12::jsonb,'world',$13,$14,$15,$16::jsonb,'committed','ai',$17,$18::jsonb,$19,$20)`,
      [eventId, firstScope.worldId, firstScope.editionId, evidenceSourceId(item.evidence), event.canonicalKey,
        event.name,event.summary,event.worldTimeLabel,event.chronologyOrder*1000,event.temporalStatus,event.importance==="unspecified"?"major":event.importance,
        JSON.stringify(event.sourceChapterKeys),knowledgeStatus(event.truthStatus),event.truthStatus,holderId,JSON.stringify(item.evidence),firstScope.analysisRunId,JSON.stringify(event.aliases),item.confidence,event.importance]);
    }
    const verified = group.decisions.get(item.proposalId);
    if (!verified) fail("CLOCK_RECEIPT_INVALID", "An approved event lost its individual verification decision.");
    const linked = await db.query(`INSERT INTO storyhold.world_clock_event_verifications
      (event_id,world_id,edition_id,run_id,step_key,proposal_id,decision_id,payload_fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT DO NOTHING RETURNING event_id`, [eventId,firstScope.worldId,firstScope.editionId,firstScope.analysisRunId,verified.receipt.request.stepKey,item.proposalId,verified.decision.id,hash(event)]);
    const savedLink=(await db.query<Record<string,unknown>>("SELECT * FROM storyhold.world_clock_event_verifications WHERE run_id=$1 AND step_key=$2 AND proposal_id=$3",
      [firstScope.analysisRunId,verified.receipt.request.stepKey,item.proposalId])).rows[0];
    if(!savedLink||savedLink.event_id!==eventId||savedLink.world_id!==firstScope.worldId||savedLink.edition_id!==firstScope.editionId
        ||savedLink.decision_id!==verified.decision.id||savedLink.payload_fingerprint!==hash(event))fail("CLOCK_RECEIPT_MISMATCH","The immutable event verification link differs from this exact approved projection.");
    eventCount += linked.rows.length;
  }

  const approvedEventIds = new Set(reviewed.flatMap((group)=>group.projection.events.map((item) => item.payload.eventId)));
  for (const group of reviewed) for (const item of group.projection.participants) {
    const participant = item.payload; const id = uuid(participant.participantId,"Participant ID");
    const entityId = uuid(participant.entityId,"Participant entity ID");
    const participantEventId=uuid(participant.eventId,"Participant event ID");
    if (!approvedEventIds.has(participantEventId)) fail("CLOCK_REFERENCE_CHANGED", "A participant cannot attach to an event not approved in this exact projection.");
    const entity = await db.query("SELECT id FROM storyhold.world_entities WHERE id=$1 AND world_id=$2 AND canon_edition_id=$3 AND pull_status='active' AND merged_into_entity_id IS NULL",
      [entityId,firstScope.worldId,firstScope.editionId]);
    if (entity.rows.length !== 1) fail("CLOCK_REFERENCE_CHANGED", "A verified participant changed or is no longer canonical.");
    const conflict = (await db.query<Record<string,unknown>>("SELECT * FROM storyhold.world_event_participants WHERE event_id=$1 AND entity_id=$2 AND participant_role=$3 FOR UPDATE",
      [participantEventId,entityId,participant.role])).rows[0];
    if (conflict) {
      const exact = conflict.id === id && conflict.world_id === firstScope.worldId && conflict.canon_edition_id === firstScope.editionId
        && hash(conflict.evidence) === hash(item.evidence) && Number(conflict.confidence) === item.confidence && conflict.assignment_source === "ai";
      if (!exact || conflict.assignment_source === "user") fail("CLOCK_CANON_CONFLICT", "An existing event participant differs from this exact approved projection; neither row was changed.");
    } else await db.query(`INSERT INTO storyhold.world_event_participants
      (id,world_id,canon_edition_id,event_id,entity_id,participant_role,evidence,confidence,assignment_source)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'ai')`,
    [id,firstScope.worldId,firstScope.editionId,participantEventId,entityId,participant.role,JSON.stringify(item.evidence),item.confidence]);
    const row = (await db.query<{id:string}>("SELECT id FROM storyhold.world_event_participants WHERE event_id=$1 AND entity_id=$2 AND participant_role=$3",
      [participantEventId,entityId,participant.role])).rows[0];
    if (!row) fail("CLOCK_CANON_CONFLICT","The approved participant could not be retained.");
    const verified=group.decisions.get(item.proposalId); if(!verified) fail("CLOCK_RECEIPT_INVALID","An approved participant lost its decision.");
    const linked=await db.query(`INSERT INTO storyhold.world_event_participant_verifications
      (participant_id,world_id,edition_id,run_id,step_key,proposal_id,decision_id,payload_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING participant_id`,
    [row.id,firstScope.worldId,firstScope.editionId,firstScope.analysisRunId,verified.receipt.request.stepKey,item.proposalId,verified.decision.id,hash(participant)]);
    const savedLink=(await db.query<Record<string,unknown>>("SELECT * FROM storyhold.world_event_participant_verifications WHERE run_id=$1 AND step_key=$2 AND proposal_id=$3",
      [firstScope.analysisRunId,verified.receipt.request.stepKey,item.proposalId])).rows[0];
    if(!savedLink||savedLink.participant_id!==row.id||savedLink.world_id!==firstScope.worldId||savedLink.edition_id!==firstScope.editionId
        ||savedLink.decision_id!==verified.decision.id||savedLink.payload_fingerprint!==hash(participant))fail("CLOCK_RECEIPT_MISMATCH","The immutable participant verification link differs from this exact approved projection.");
    participantCount+=linked.rows.length;
  }

  for (const group of reviewed) for (const item of group.projection.relations) {
    const relation=item.payload; const id=uuid(relation.relationId,"Event relation ID");
    const sourceEventId=uuid(relation.sourceEventId,"Source event ID");
    const targetEventId=uuid(relation.targetEventId,"Target event ID");
    if (!approvedEventIds.has(sourceEventId)||!approvedEventIds.has(targetEventId)) fail("CLOCK_REFERENCE_CHANGED","An event relation cannot attach outside this exact approved projection.");
    const conflict=(await db.query<Record<string,unknown>>("SELECT * FROM storyhold.world_event_relations WHERE source_event_id=$1 AND target_event_id=$2 AND relation_type=$3 FOR UPDATE",
      [sourceEventId,targetEventId,relation.relationType])).rows[0];
    if (conflict) {
      const exact = conflict.id === id && conflict.world_id === firstScope.worldId && conflict.canon_edition_id === firstScope.editionId
        && conflict.summary === relation.summary && hash(conflict.evidence) === hash(item.evidence)
        && Number(conflict.confidence) === item.confidence && conflict.assignment_source === "ai";
      if (!exact || conflict.assignment_source === "user") fail("CLOCK_CANON_CONFLICT","An existing event relation differs from this exact approved projection; neither row was changed.");
    } else await db.query(`INSERT INTO storyhold.world_event_relations
      (id,world_id,canon_edition_id,source_event_id,target_event_id,relation_type,summary,evidence,confidence,assignment_source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'ai')`,
    [id,firstScope.worldId,firstScope.editionId,sourceEventId,targetEventId,relation.relationType,relation.summary,JSON.stringify(item.evidence),item.confidence]);
    const row=(await db.query<{id:string}>("SELECT id FROM storyhold.world_event_relations WHERE source_event_id=$1 AND target_event_id=$2 AND relation_type=$3",
      [sourceEventId,targetEventId,relation.relationType])).rows[0];
    if(!row) fail("CLOCK_CANON_CONFLICT","The approved event relation could not be retained.");
    const verified=group.decisions.get(item.proposalId);if(!verified)fail("CLOCK_RECEIPT_INVALID","An approved event relation lost its decision.");
    const linked=await db.query(`INSERT INTO storyhold.world_event_relation_verifications
      (relation_id,world_id,edition_id,run_id,step_key,proposal_id,decision_id,payload_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING relation_id`,
    [row.id,firstScope.worldId,firstScope.editionId,firstScope.analysisRunId,verified.receipt.request.stepKey,item.proposalId,verified.decision.id,hash(relation)]);
    const savedLink=(await db.query<Record<string,unknown>>("SELECT * FROM storyhold.world_event_relation_verifications WHERE run_id=$1 AND step_key=$2 AND proposal_id=$3",
      [firstScope.analysisRunId,verified.receipt.request.stepKey,item.proposalId])).rows[0];
    if(!savedLink||savedLink.relation_id!==row.id||savedLink.world_id!==firstScope.worldId||savedLink.edition_id!==firstScope.editionId
        ||savedLink.decision_id!==verified.decision.id||savedLink.payload_fingerprint!==hash(relation))fail("CLOCK_RECEIPT_MISMATCH","The immutable relation verification link differs from this exact approved projection.");
    relationCount+=linked.rows.length;
  }
  return {events:eventCount,participants:participantCount,relations:relationCount,replayed:Number(before.rows[0]?.count??0)>0,
    withheld:reviewed.flatMap((group)=>group.projection.withheld.map((item)=>structuredClone(item)))};
}

export const saveVerifiedWorldClockProjection = applyVerifiedWorldClockProjection;
