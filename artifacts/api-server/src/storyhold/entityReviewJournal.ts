import type { PGlite } from "@electric-sql/pglite";
import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import { AiGatewayUnavailableError, type AiBillableAttempt, type AiTextResult, type GenerateAiTextInput } from "./aiGateway";
import { assertEntityGraphReview, assertEntityGraphReviews, validateEntityGraphReview } from "./entityGraphVerification";
import { prepareEntityReviewPages } from "./entityReviewPages";
import { assertEntityProseReview, validateEntityProseReview, type EntityProseReviewReceipt } from "./entityProseVerification";
import { assertEntityExistingProseReviews, prepareEntityExistingProsePages, validateEntityExistingProseReview,
  type EntityExistingProseReviewReceipt } from "./entityExistingProseReview";
import { entityReviewJsonObject, type EntityReviewInput } from "./entityReview";
import type { PremiumGraphReviewReceipt } from "./premiumGraphVerification";
import { assertEntityCompassReview, buildEntityCompassRequest, validateEntityCompassReview,
  type EntityCompassReviewReceipt } from "./entityCompassVerification";

type QueryDb = Pick<PGlite, "query">;
type JournalDb = Pick<PGlite, "query" | "transaction">;
export type EntityReviewCallScope = { reviewId: string; playerId: string; worldId: string; editionId: string; entityId: string };
export type EntityReviewCallStatus = "dispatched" | "completed" | "rejected" | "uncertain";
export type EntityReviewVerificationBundle = { version: 1; graph: PremiumGraphReviewReceipt }
  | { version: 2; graphs: PremiumGraphReviewReceipt[] }
  | { version: 3; graphs: PremiumGraphReviewReceipt[]; prose: EntityProseReviewReceipt }
  | { version: 4; graphs: PremiumGraphReviewReceipt[]; prose: EntityProseReviewReceipt; existingProse: EntityExistingProseReviewReceipt[] }
  | { version: 5; graphs: PremiumGraphReviewReceipt[]; prose: EntityProseReviewReceipt; existingProse: EntityExistingProseReviewReceipt[]; compass: EntityCompassReviewReceipt };
export type EntityReviewJournalPage = { stepKey: string; request: GenerateAiTextInput; provider: string; model: string };
export type EntityReviewPageResult = { stepKey: string; result: AiTextResult };
export type PagedEntityReviewResult = AiTextResult & { entityReviewPages: EntityReviewPageResult[] };
type EntityReviewPageRow = {
  review_id: string; step_key: string; page_index: number; request_snapshot: JsonObject; request_fingerprint: string;
  status: EntityReviewCallStatus; result_snapshot: AiTextResult | null; result_fingerprint: string | null;
  billable_attempts: AiBillableAttempt[]; error: string | null;
};
export type EntityReviewCallRow = {
  review_id: string; player_id: string; world_id: string; edition_id: string; entity_id: string;
  reservation_id: string | null; reserved_credits: number; unlimited: boolean;
  context_snapshot: JsonObject; context_fingerprint: string;
  request_snapshot: JsonObject; request_fingerprint: string;
  status: EntityReviewCallStatus; result_snapshot: AiTextResult | null; result_fingerprint: string | null;
  billable_attempts: AiBillableAttempt[]; error: string | null;
  finalization_snapshot: JsonObject | null; finalization_fingerprint: string | null;
  verification_snapshot: EntityReviewVerificationBundle | null; verification_fingerprint: string | null;
};
export class EntityReviewJournalError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "EntityReviewJournalError"; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const hash = (value: unknown) => canonPayloadFingerprint(value as JsonObject);
function fail(code: string, message: string): never { throw new EntityReviewJournalError(code, message); }
function scopeValid(scope: EntityReviewCallScope): void {
  if (!scope || [scope.reviewId, scope.playerId, scope.worldId, scope.editionId, scope.entityId].some((value) => typeof value !== "string" || !UUID.test(value))) {
    fail("SCOPE_INVALID", "A dossier call requires exact review, player, world, edition, and entity identifiers.");
  }
}
function sameScope(row: EntityReviewCallRow, scope: EntityReviewCallScope): boolean {
  return row.review_id === scope.reviewId && row.player_id === scope.playerId && row.world_id === scope.worldId
    && row.edition_id === scope.editionId && row.entity_id === scope.entityId;
}
function snapshot<T>(value: T): T {
  const seen = new Set<object>();
  const visit = (item: unknown, inArray = false): void => {
    if (item === null || typeof item === "boolean" || typeof item === "string") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (item === undefined && !inArray) return;
    if (!item || typeof item !== "object" || seen.has(item)) throw new Error("Snapshot must be finite plain JSON.");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("Snapshot cannot contain non-JSON objects.");
    seen.add(item);
    if (Array.isArray(item)) { for (const child of item) visit(child, true); }
    else for (const child of Object.values(item)) visit(child);
    seen.delete(item);
  };
  visit(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
function outcomeFingerprint(row: Pick<EntityReviewCallRow, "status" | "result_snapshot" | "billable_attempts" | "error">): string {
  return hash({ version: "storyhold:entity-review-outcome:v1", status: row.status, result: row.result_snapshot,
    billableAttempts: row.billable_attempts, error: row.error });
}
function checkedVerificationBundle(row: EntityReviewCallRow, value: unknown): EntityReviewVerificationBundle {
  try {
    const bundle = snapshot(value) as EntityReviewVerificationBundle;
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle) || ![1, 2, 3, 4, 5].includes(bundle.version)
      || Object.keys(bundle).sort().join(",") !== (bundle.version === 1 ? "graph,version" : bundle.version === 2 ? "graphs,version"
        : bundle.version === 3 ? "graphs,prose,version" : bundle.version === 4 ? "existingProse,graphs,prose,version" : "compass,existingProse,graphs,prose,version")
      || row.status !== "completed" || !row.result_snapshot) {
      throw new Error("The private proof requires a completed graph review.");
    }
    const input = row.context_snapshot.input as unknown as EntityReviewInput;
    if (!input || input.entity?.id !== row.entity_id || input.premiumStatScope?.worldId !== row.world_id
      || input.premiumStatScope.editionId !== row.edition_id || input.premiumStatScope.analysisRunId !== row.review_id) {
      throw new Error("The private proof does not match its exact saved dossier scope.");
    }
    if ((input.proseReview !== undefined) !== (bundle.version === 3 || bundle.version === 4 || bundle.version === 5)
      || (input.existingProseReview !== undefined) !== (bundle.version === 4 || bundle.version === 5)
      || (input.compassReview !== undefined) !== (bundle.version === 5)) {
      throw new Error("The saved dossier prose contract cannot be added or downgraded after dispatch.");
    }
    const result = row.result_snapshot;
    if (bundle.version === 2 || bundle.version === 3 || bundle.version === 4 || bundle.version === 5) {
      if (row.request_snapshot.version !== (bundle.version === 5 ? "storyhold:entity-review-request:v4" : bundle.version === 4 ? "storyhold:entity-review-request:v3" : "storyhold:entity-review-request:v2")
        || input.graphReview?.version !== 2) {
        throw new Error("Paged graph proof requires its original paged provider journal.");
      }
      const plan = prepareEntityReviewPages(input);
      const existingPages = bundle.version === 4 || bundle.version === 5 ? prepareEntityExistingProsePages(input) : [];
      const results = (result as PagedEntityReviewResult).entityReviewPages;
      if (!Array.isArray(results) || results.length !== plan.pages.length + existingPages.length || !Array.isArray(bundle.graphs)
        || bundle.graphs.length !== plan.pages.length) throw new Error("Incomplete saved graph page inventory.");
      assertEntityGraphReviews(input, bundle.graphs);
      for (const [index, page] of plan.pages.entries()) {
        const saved = results[index]!;
        if (saved.stepKey !== page.stepKey || !saved.result.journalCompletedAt) throw new Error("Wrong saved graph page.");
        const expected = validateEntityGraphReview(page.input, entityReviewJsonObject(saved.result.text), {
          provider: saved.result.provider, model: saved.result.runtime.execution?.resolvedModel ?? saved.result.model,
          completedAt: saved.result.journalCompletedAt,
        });
        if (!expected || hash(expected) !== hash(bundle.graphs[index])) throw new Error("Graph proof differs from its actual paid page.");
      }
      if (bundle.version === 3 || bundle.version === 4 || bundle.version === 5) {
        const first = results[0]!.result;
        assertEntityProseReview(input, bundle.prose);
        const expected = validateEntityProseReview(input, entityReviewJsonObject(first.text), {
          provider: first.provider, model: first.runtime.execution?.resolvedModel ?? first.model,
          completedAt: first.journalCompletedAt!,
        });
        if (!expected || hash(expected) !== hash(bundle.prose)) throw new Error("Prose proof differs from the first actual paid dossier page.");
      }
      if (bundle.version === 4 || bundle.version === 5) {
        assertEntityExistingProseReviews(input, bundle.existingProse);
        for (const [index, page] of existingPages.entries()) {
          const saved = results[plan.pages.length + index]!;
          if (saved.stepKey !== page.stepKey || !saved.result.journalCompletedAt) throw new Error("Wrong saved existing-prose page.");
          const expected = validateEntityExistingProseReview(input, page, entityReviewJsonObject(saved.result.text), {
            provider: saved.result.provider, model: saved.result.runtime.execution?.resolvedModel ?? saved.result.model,
            completedAt: saved.result.journalCompletedAt,
          });
          if (hash(expected) !== hash(bundle.existingProse[index])) throw new Error("Existing-prose proof differs from its actual paid page.");
        }
      }
      if (bundle.version === 5) {
        const first = results[0]!.result;
        assertEntityCompassReview(input, bundle.compass);
        const expected = validateEntityCompassReview(input, entityReviewJsonObject(first.text), {
          provider: first.provider, model: first.runtime.execution?.resolvedModel ?? first.model,
          completedAt: first.journalCompletedAt!,
        });
        if (!expected || hash(expected) !== hash(bundle.compass)) throw new Error("Compass proof differs from the first actual paid dossier page.");
      }
      return bundle;
    }
    if (["storyhold:entity-review-request:v2", "storyhold:entity-review-request:v3", "storyhold:entity-review-request:v4"].includes(String(row.request_snapshot.version))) {
      throw new Error("A paged dossier cannot acquire a single-page proof.");
    }
    assertEntityGraphReview(input, bundle.graph);
    const raw = entityReviewJsonObject(result.text);
    const expected = validateEntityGraphReview(input, raw, {
      provider: result.provider, model: result.runtime.execution?.resolvedModel ?? result.model,
      completedAt: result.journalCompletedAt!,
    });
    if (!expected || hash(expected) !== hash(bundle.graph)) throw new Error("The private proof differs from the saved provider response.");
    return bundle;
  } catch { fail("VERIFICATION_INVALID", "The dossier verification proof does not match its saved provider response and context."); }
}
function assertIntegrity(row: EntityReviewCallRow, scope: EntityReviewCallScope): void {
  try {
    const input = row.context_snapshot.input as unknown as EntityReviewInput | undefined;
    if (!sameScope(row, scope) || hash(row.context_snapshot) !== row.context_fingerprint
      || hash(row.request_snapshot) !== row.request_fingerprint || !Array.isArray(row.billable_attempts)
      || hash(row.request_snapshot.scope) !== hash(scope) || row.request_snapshot.reservationId !== row.reservation_id
      || row.request_snapshot.contextFingerprint !== row.context_fingerprint
      || (input?.existingProseReview !== undefined) !== (["storyhold:entity-review-request:v3", "storyhold:entity-review-request:v4"].includes(String(row.request_snapshot.version)))
      || (input?.compassReview !== undefined) !== (row.request_snapshot.version === "storyhold:entity-review-request:v4")
      || !["dispatched", "completed", "rejected", "uncertain"].includes(row.status)
      || !Number.isSafeInteger(row.reserved_credits) || row.reserved_credits < 0
      || (row.unlimited !== true && row.unlimited !== false)
      || (row.unlimited ? row.reservation_id !== null || row.reserved_credits !== 0 : !UUID.test(String(row.reservation_id)))
      || (row.status === "dispatched" && (row.result_snapshot !== null || row.result_fingerprint !== null || row.billable_attempts.length !== 0 || row.error !== null))
      || (row.status !== "dispatched" && outcomeFingerprint(row) !== row.result_fingerprint)
      || (row.status === "completed" && (!row.result_snapshot || typeof row.result_snapshot.text !== "string"
        || !row.result_snapshot.usage || !row.result_snapshot.runtime || !row.result_snapshot.journalCompletedAt
        || Number.isNaN(Date.parse(row.result_snapshot.journalCompletedAt))))
      || (row.status !== "completed" && row.result_snapshot !== null)
      || (row.status === "rejected" && !row.billable_attempts.length)
      || (row.verification_snapshot == null ? row.verification_fingerprint != null
        : row.status !== "completed" || hash(row.verification_snapshot) !== row.verification_fingerprint)
      || (row.finalization_snapshot === null ? row.finalization_fingerprint !== null
        : !["completed", "rejected"].includes(row.status) || hash(row.finalization_snapshot) !== row.finalization_fingerprint)) {
      throw new Error("Journal contents do not match their scope or fingerprints.");
    }
    if (row.verification_snapshot != null) checkedVerificationBundle(row, row.verification_snapshot);
  } catch { fail("JOURNAL_INTEGRITY", "The dossier call failed its stored integrity check."); }
}

export const entityReviewJournalSchemaSql = String.raw`
  CREATE TABLE IF NOT EXISTS storyhold.entity_review_ai_calls (
    review_id uuid PRIMARY KEY,
    player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE CASCADE,
    world_id uuid NOT NULL, edition_id uuid NOT NULL,
    entity_id uuid NOT NULL REFERENCES storyhold.world_entities(id) ON DELETE CASCADE,
    reservation_id uuid REFERENCES storyhold.credit_reservations(id),
    reserved_credits integer NOT NULL CHECK (reserved_credits >= 0), unlimited boolean NOT NULL,
    context_snapshot jsonb NOT NULL, context_fingerprint text NOT NULL,
    request_snapshot jsonb NOT NULL, request_fingerprint text NOT NULL,
    status text NOT NULL DEFAULT 'dispatched' CHECK (status IN ('dispatched', 'completed', 'rejected', 'uncertain')),
    result_snapshot jsonb, result_fingerprint text, billable_attempts jsonb NOT NULL DEFAULT '[]', error text,
    finalization_snapshot jsonb, finalization_fingerprint text,
    verification_snapshot jsonb, verification_fingerprint text,
    created_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, finalized_at timestamptz,
    CHECK ((unlimited AND reservation_id IS NULL AND reserved_credits = 0) OR (NOT unlimited AND reservation_id IS NOT NULL))
  );
  ALTER TABLE storyhold.entity_review_ai_calls ADD COLUMN IF NOT EXISTS verification_snapshot jsonb;
  ALTER TABLE storyhold.entity_review_ai_calls ADD COLUMN IF NOT EXISTS verification_fingerprint text;
  CREATE INDEX IF NOT EXISTS entity_review_ai_calls_pending ON storyhold.entity_review_ai_calls(entity_id)
    WHERE finalization_snapshot IS NULL;
  CREATE OR REPLACE FUNCTION storyhold.guard_entity_review_call_update()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.review_id IS DISTINCT FROM OLD.review_id OR NEW.player_id IS DISTINCT FROM OLD.player_id
      OR NEW.world_id IS DISTINCT FROM OLD.world_id OR NEW.edition_id IS DISTINCT FROM OLD.edition_id
      OR NEW.entity_id IS DISTINCT FROM OLD.entity_id OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
      OR NEW.reserved_credits IS DISTINCT FROM OLD.reserved_credits OR NEW.unlimited IS DISTINCT FROM OLD.unlimited
      OR NEW.context_snapshot IS DISTINCT FROM OLD.context_snapshot OR NEW.context_fingerprint IS DISTINCT FROM OLD.context_fingerprint
      OR NEW.request_snapshot IS DISTINCT FROM OLD.request_snapshot OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
      OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at THEN
      RAISE EXCEPTION 'Dossier call scope, funding, context, and request are immutable';
    END IF;
    IF OLD.status <> 'dispatched' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.result_snapshot IS DISTINCT FROM OLD.result_snapshot
      OR NEW.result_fingerprint IS DISTINCT FROM OLD.result_fingerprint OR NEW.billable_attempts IS DISTINCT FROM OLD.billable_attempts
      OR NEW.error IS DISTINCT FROM OLD.error OR NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
      RAISE EXCEPTION 'Dossier call outcomes are immutable';
    END IF;
    IF OLD.status = 'dispatched' AND NEW.status = 'dispatched' AND (NEW.result_snapshot IS NOT NULL OR NEW.result_fingerprint IS NOT NULL
      OR NEW.billable_attempts <> '[]'::jsonb OR NEW.error IS NOT NULL) THEN RAISE EXCEPTION 'Dispatched call has no known outcome'; END IF;
    IF OLD.finalization_snapshot IS NOT NULL AND (NEW.finalization_snapshot IS DISTINCT FROM OLD.finalization_snapshot
      OR NEW.finalization_fingerprint IS DISTINCT FROM OLD.finalization_fingerprint OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at) THEN
      RAISE EXCEPTION 'Dossier call finalizations are immutable';
    END IF;
    IF NEW.finalization_snapshot IS NOT NULL AND NEW.status NOT IN ('completed', 'rejected') THEN
      RAISE EXCEPTION 'Unknown dossier call outcomes cannot be finalized';
    END IF;
    IF (OLD.verification_snapshot IS NOT NULL OR OLD.finalization_snapshot IS NOT NULL)
      AND (NEW.verification_snapshot IS DISTINCT FROM OLD.verification_snapshot
        OR NEW.verification_fingerprint IS DISTINCT FROM OLD.verification_fingerprint) THEN
      RAISE EXCEPTION 'Dossier verification proofs are immutable and cannot be added after finalization';
    END IF;
    IF (NEW.verification_snapshot IS NULL) <> (NEW.verification_fingerprint IS NULL)
      OR (NEW.verification_snapshot IS NOT NULL AND NEW.status <> 'completed') THEN
      RAISE EXCEPTION 'Dossier verification proofs require a completed response and paired fingerprint';
    END IF;
    RETURN NEW;
  END;
  $$;
  DROP TRIGGER IF EXISTS entity_review_call_guard ON storyhold.entity_review_ai_calls;
  CREATE TRIGGER entity_review_call_guard BEFORE UPDATE ON storyhold.entity_review_ai_calls
    FOR EACH ROW EXECUTE FUNCTION storyhold.guard_entity_review_call_update();

  CREATE TABLE IF NOT EXISTS storyhold.entity_review_ai_pages (
    review_id uuid NOT NULL REFERENCES storyhold.entity_review_ai_calls(review_id) ON DELETE CASCADE,
    step_key text NOT NULL CHECK (length(step_key) > 0), page_index integer NOT NULL CHECK (page_index >= 0),
    request_snapshot jsonb NOT NULL, request_fingerprint text NOT NULL,
    status text NOT NULL DEFAULT 'dispatched' CHECK (status IN ('dispatched', 'completed', 'rejected', 'uncertain')),
    result_snapshot jsonb, result_fingerprint text, billable_attempts jsonb NOT NULL DEFAULT '[]', error text,
    created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
    PRIMARY KEY (review_id, step_key), UNIQUE (review_id, page_index)
  );
  CREATE OR REPLACE FUNCTION storyhold.guard_entity_review_page_update()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.review_id IS DISTINCT FROM OLD.review_id OR NEW.step_key IS DISTINCT FROM OLD.step_key
      OR NEW.page_index IS DISTINCT FROM OLD.page_index OR NEW.request_snapshot IS DISTINCT FROM OLD.request_snapshot
      OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Dossier page identity and request are immutable';
    END IF;
    IF OLD.status <> 'dispatched' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Dossier page outcomes are immutable'; END IF;
    IF NEW.status = 'dispatched' AND (NEW.result_snapshot IS NOT NULL OR NEW.result_fingerprint IS NOT NULL
      OR NEW.billable_attempts <> '[]'::jsonb OR NEW.error IS NOT NULL OR NEW.completed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Dispatched dossier page has no known outcome';
    END IF;
    RETURN NEW;
  END;
  $$;
  DROP TRIGGER IF EXISTS entity_review_page_guard ON storyhold.entity_review_ai_pages;
  CREATE TRIGGER entity_review_page_guard BEFORE UPDATE ON storyhold.entity_review_ai_pages
    FOR EACH ROW EXECUTE FUNCTION storyhold.guard_entity_review_page_update();
`;
export async function ensureEntityReviewJournal(db: Pick<PGlite, "exec">): Promise<void> { await db.exec(entityReviewJournalSchemaSql); }

/** Extend the existing world-graph provenance links without synthetic intake
 * runs. Call after both graph and dossier journal schemas have been installed. */
export async function ensureEntityReviewGraphLinks(db: Pick<PGlite, "exec">): Promise<void> {
  await db.exec(String.raw`
    DO $$
    DECLARE link_table text;
    BEGIN
      FOREACH link_table IN ARRAY ARRAY['world_entity_relation_verifications', 'world_entity_rule_verifications'] LOOP
        EXECUTE format('ALTER TABLE storyhold.%I ADD COLUMN IF NOT EXISTS entity_review_id uuid', link_table);
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('storyhold.' || link_table)
          AND conname = link_table || '_entity_review_fk') THEN
          EXECUTE format('ALTER TABLE storyhold.%I ADD CONSTRAINT %I FOREIGN KEY (entity_review_id) REFERENCES storyhold.entity_review_ai_calls(review_id) ON DELETE CASCADE',
            link_table, link_table || '_entity_review_fk');
        END IF;
        EXECUTE format('ALTER TABLE storyhold.%I DROP CONSTRAINT IF EXISTS %I', link_table, link_table || '_pkey');
        EXECUTE format('ALTER TABLE storyhold.%I ALTER COLUMN run_id DROP NOT NULL', link_table);
        EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON storyhold.%I (run_id, step_key, proposal_id)',
          link_table || '_world_scope_key', link_table);
        EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON storyhold.%I (entity_review_id, step_key, proposal_id)',
          link_table || '_dossier_scope_key', link_table);
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('storyhold.' || link_table)
          AND conname = link_table || '_exclusive_source') THEN
          EXECUTE format('ALTER TABLE storyhold.%I ADD CONSTRAINT %I CHECK ((run_id IS NULL) <> (entity_review_id IS NULL))',
            link_table, link_table || '_exclusive_source');
        END IF;
      END LOOP;
    END;
    $$;
  `);
}

async function lockTarget(db: QueryDb, scope: EntityReviewCallScope): Promise<void> {
  scopeValid(scope);
  const found = await db.query("SELECT id FROM storyhold.world_entities WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3 FOR UPDATE",
    [scope.entityId, scope.worldId, scope.editionId]);
  if (found.rows.length !== 1) fail("SCOPE_MISMATCH", "The reviewed entity does not match this world and edition.");
}
export async function readEntityReviewCall(db: QueryDb, scope: EntityReviewCallScope): Promise<EntityReviewCallRow | null> {
  scopeValid(scope);
  const row = (await db.query<EntityReviewCallRow>("SELECT * FROM storyhold.entity_review_ai_calls WHERE review_id = $1", [scope.reviewId])).rows[0];
  if (!row) return null;
  if (!sameScope(row, scope)) fail("SCOPE_MISMATCH", "This dossier review belongs to a different scope.");
  assertIntegrity(row, scope);
  if (["storyhold:entity-review-request:v2", "storyhold:entity-review-request:v3", "storyhold:entity-review-request:v4"].includes(String(row.request_snapshot.version))) await checkedPages(db, row);
  return row;
}
export async function findPendingEntityReviewCall(db: QueryDb, scope: Omit<EntityReviewCallScope, "reviewId">): Promise<EntityReviewCallRow | null> {
  scopeValid({ ...scope, reviewId: scope.entityId });
  const row = (await db.query<EntityReviewCallRow>(`SELECT * FROM storyhold.entity_review_ai_calls
    WHERE player_id = $1 AND world_id = $2 AND edition_id = $3 AND entity_id = $4 AND finalization_snapshot IS NULL
    ORDER BY created_at, review_id LIMIT 1`, [scope.playerId, scope.worldId, scope.editionId, scope.entityId])).rows[0];
  if (!row) return null;
  assertIntegrity(row, { ...scope, reviewId: row.review_id });
  if (["storyhold:entity-review-request:v2", "storyhold:entity-review-request:v3", "storyhold:entity-review-request:v4"].includes(String(row.request_snapshot.version))) await checkedPages(db, row);
  return row;
}
export async function lockEntityReviewCallForFinalization(db: QueryDb, scope: EntityReviewCallScope): Promise<EntityReviewCallRow> {
  await lockTarget(db, scope);
  await db.query("SELECT review_id FROM storyhold.entity_review_ai_calls WHERE review_id = $1 FOR UPDATE", [scope.reviewId]);
  const row = await readEntityReviewCall(db, scope);
  if (!row) fail("CALL_MISSING", "The dossier call has no durable record.");
  if (!["completed", "rejected"].includes(row.status)) fail("OUTCOME_UNRESOLVED", "The dossier call outcome is unknown and requires reconciliation.");
  return row;
}
/** Save in the same transaction as canonical graph projection. This proof is
 * private journal data and is never copied into the customer response. */
export async function saveEntityReviewVerificationBundle(db: QueryDb, scope: EntityReviewCallScope,
  value: EntityReviewVerificationBundle): Promise<EntityReviewVerificationBundle> {
  const row = await lockEntityReviewCallForFinalization(db, scope);
  const bundle = checkedVerificationBundle(row, value);
  const fingerprint = hash(bundle);
  if (row.verification_snapshot != null) {
    if (row.verification_fingerprint !== fingerprint) fail("VERIFICATION_MISMATCH", "A different immutable dossier verification proof already exists.");
    return snapshot(row.verification_snapshot);
  }
  if (row.finalization_snapshot !== null) fail("REVIEW_FINALIZED", "A finalized dossier review cannot acquire a new verification proof.");
  const saved = await db.query(`UPDATE storyhold.entity_review_ai_calls
    SET verification_snapshot = $2::jsonb, verification_fingerprint = $3, updated_at = now()
    WHERE review_id = $1 AND status = 'completed' AND verification_snapshot IS NULL AND finalization_snapshot IS NULL RETURNING review_id`,
  [scope.reviewId, JSON.stringify(bundle), fingerprint]);
  if (saved.rows.length !== 1) fail("JOURNAL_PERSISTENCE", "The dossier verification proof could not be saved.");
  return snapshot(bundle);
}
export async function finalizeEntityReviewCall(db: QueryDb, scope: EntityReviewCallScope, outcomeJson: JsonObject): Promise<void> {
  const row = await lockEntityReviewCallForFinalization(db, scope);
  const outcome = snapshot(outcomeJson);
  if (!outcome || Array.isArray(outcome) || typeof outcome !== "object") fail("FINALIZATION_INVALID", "Finalization must be a JSON object.");
  const input = row.context_snapshot.input as unknown as EntityReviewInput | undefined;
  if (outcome.reviewed === true && input?.proseReview !== undefined
    && row.verification_snapshot?.version !== (input.compassReview !== undefined ? 5 : input.existingProseReview !== undefined ? 4 : 3)) {
    fail("VERIFICATION_REQUIRED", "A successful dossier review requires its complete saved graph and prose verification proof.");
  }
  const fingerprint = hash(outcome);
  if (row.finalization_snapshot !== null) {
    if (row.finalization_fingerprint !== fingerprint) fail("FINALIZATION_MISMATCH", "A different immutable dossier finalization already exists.");
    return;
  }
  const saved = await db.query(`UPDATE storyhold.entity_review_ai_calls
    SET finalization_snapshot = $2::jsonb, finalization_fingerprint = $3, finalized_at = now(), updated_at = now()
    WHERE review_id = $1 AND finalization_snapshot IS NULL AND status IN ('completed', 'rejected') RETURNING review_id`,
  [scope.reviewId, JSON.stringify(outcome), fingerprint]);
  if (saved.rows.length !== 1) fail("JOURNAL_PERSISTENCE", "The dossier finalization could not be saved.");
}

function attemptsForResult(result: AiTextResult): AiBillableAttempt[] {
  return [...(result.priorBillableAttempts ?? []), { provider: result.provider, model: result.model,
    resolvedModel: result.runtime.execution?.resolvedModel ?? result.model, upstreamProvider: result.runtime.execution?.upstreamProvider ?? null,
    stage: result.runtime.stage, reasoning: result.reasoning, usage: result.usage }];
}
async function saveOutcome(db: QueryDb, scope: EntityReviewCallScope, requestFingerprint: string,
  status: Exclude<EntityReviewCallStatus, "dispatched">, result: AiTextResult | null, attempts: AiBillableAttempt[], error: string | null): Promise<void> {
  try {
    const copiedResult = snapshot(result); const copiedAttempts = snapshot(attempts);
    const fingerprint = outcomeFingerprint({ status, result_snapshot: copiedResult, billable_attempts: copiedAttempts, error });
    const saved = await db.query(`UPDATE storyhold.entity_review_ai_calls
      SET status = $3, result_snapshot = $4::jsonb, result_fingerprint = $5, billable_attempts = $6::jsonb,
          error = $7, updated_at = now(), completed_at = now()
      WHERE review_id = $1 AND request_fingerprint = $2 AND status = 'dispatched' AND finalization_snapshot IS NULL RETURNING review_id`,
    [scope.reviewId, requestFingerprint, status, copiedResult === null ? null : JSON.stringify(copiedResult), fingerprint, JSON.stringify(copiedAttempts), error]);
    if (saved.rows.length !== 1) throw new Error("Dispatched dossier call changed.");
  } catch { fail("JOURNAL_PERSISTENCE", "The paid dossier outcome could not be durably recorded; reconciliation is required before retry."); }
}

async function prepareParent(db: JournalDb, params: { scope: EntityReviewCallScope; reservationId: string | null },
  context: JsonObject, requestSnapshot: JsonObject): Promise<EntityReviewCallRow | null> {
  const scope = params.scope;
  const requestFingerprint = hash(requestSnapshot);
  const contextFingerprint = hash(context);
  let previous: EntityReviewCallRow | null;
  try {
    previous = await db.transaction(async (tx) => {
      await lockTarget(tx, scope);
      const existing = await readEntityReviewCall(tx, scope);
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint || existing.context_fingerprint !== contextFingerprint
          || existing.reservation_id !== params.reservationId) fail("REQUEST_MISMATCH", "This review ID already has a different immutable request or context.");
        return existing;
      }
      const busy = await tx.query("SELECT review_id FROM storyhold.entity_review_ai_calls WHERE entity_id = $1 AND finalization_snapshot IS NULL FOR UPDATE", [scope.entityId]);
      if (busy.rows.length) fail("ENTITY_REVIEW_PENDING", "Finish or reconcile the existing paid dossier review before starting another.");
      const related = (await tx.query<{ id: string }>("SELECT id FROM storyhold.credit_reservations WHERE operation = 'entity_review' AND request_id = $1", [scope.reviewId])).rows;
      let reservedCredits = 0;
      const unlimited = params.reservationId === null;
      if (unlimited) {
        const player = (await tx.query<{ role: string }>("SELECT role FROM storyhold.players WHERE id = $1", [scope.playerId])).rows[0];
        if (!player || !["owner", "admin"].includes(player.role) || related.length) fail("RESERVATION_UNAVAILABLE", "Only a verified administrator can dispatch without a credit reservation.");
      } else {
        if (!UUID.test(params.reservationId!) || related.length !== 1 || related[0]!.id !== params.reservationId) fail("RESERVATION_UNAVAILABLE", "The dossier credit reservation does not match this review.");
        const held = (await tx.query<{ reserved_credits: number }>(`UPDATE storyhold.credit_reservations
          SET usage = COALESCE(usage, '{}'::jsonb) || jsonb_build_object('retainUntilReconciled', true, 'entityReviewJournalId', $1::text)
          WHERE id = $2 AND status = 'reserved' AND operation = 'entity_review' AND request_id = $1
            AND player_id = $3 AND world_id = $4
            AND (usage->>'entityReviewJournalId' IS NULL OR usage->>'entityReviewJournalId' = $1) RETURNING reserved_credits`,
        [scope.reviewId, params.reservationId, scope.playerId, scope.worldId])).rows[0];
        if (!held || !Number.isSafeInteger(held.reserved_credits) || held.reserved_credits < 0) fail("RESERVATION_UNAVAILABLE", "The dossier review requires its active scoped credit reservation.");
        reservedCredits = held.reserved_credits;
      }
      await tx.query(`INSERT INTO storyhold.entity_review_ai_calls
        (review_id, player_id, world_id, edition_id, entity_id, reservation_id, reserved_credits, unlimited,
         context_snapshot, context_fingerprint, request_snapshot, request_fingerprint)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12)`,
      [scope.reviewId, scope.playerId, scope.worldId, scope.editionId, scope.entityId, params.reservationId, reservedCredits, unlimited,
        JSON.stringify(context), contextFingerprint, JSON.stringify(requestSnapshot), requestFingerprint]);
      return null;
    });
  } catch (error) {
    if (error instanceof EntityReviewJournalError) throw error;
    fail("JOURNAL_PERSISTENCE", "The dossier call could not be journaled; no provider call was started.");
  }
  return previous;
}

export async function executeJournaledEntityReviewCall(db: JournalDb, params: {
  scope: EntityReviewCallScope; reservationId: string | null; contextSnapshot: JsonObject;
  request: GenerateAiTextInput; provider: string; model: string; invoke: () => Promise<AiTextResult>;
}): Promise<AiTextResult> {
  const scope = params.scope; scopeValid(scope);
  if (params.request.allowProviderFallback !== false || params.request.providerFailurePolicy !== "stop") {
    fail("REQUEST_INVALID", "A journaled dossier call must stop after one provider outcome and disable internal fallback.");
  }
  const { validate: _validate, ...request } = params.request;
  let context: JsonObject; let requestSnapshot: JsonObject;
  try {
    context = snapshot(params.contextSnapshot);
    if ((context.input as unknown as EntityReviewInput | undefined)?.existingProseReview !== undefined
      || (context.input as unknown as EntityReviewInput | undefined)?.compassReview !== undefined) {
      throw new Error("Existing prose audit requires the complete paged request plan.");
    }
    requestSnapshot = snapshot({ version: "storyhold:entity-review-request:v1", scope, provider: params.provider, model: params.model,
      reservationId: params.reservationId, contextFingerprint: hash(context), request }) as unknown as JsonObject;
    if (!context || typeof context !== "object" || Array.isArray(context) || !params.provider || !params.model) throw new Error("Invalid request");
  } catch { fail("REQUEST_INVALID", "The dossier request and context must be complete plain JSON snapshots."); }
  const requestFingerprint = hash(requestSnapshot);
  const previous = await prepareParent(db, params, context, requestSnapshot);
  if (previous) {
    if (previous.finalization_snapshot !== null) fail("REVIEW_FINALIZED", "This dossier review is finalized; return its saved outcome instead of replaying work.");
    if (previous.status !== "completed") fail(previous.status === "rejected" ? "PREVIOUSLY_REJECTED" : "OUTCOME_UNRESOLVED", "This dossier call cannot be automatically redispatched.");
    params.request.validate?.(previous.result_snapshot!.text);
    return snapshot(previous.result_snapshot!);
  }
  let result: AiTextResult;
  try { result = await params.invoke(); }
  catch (error) {
    const gatewayError = error instanceof AiGatewayUnavailableError ? error : null;
    const attempts = gatewayError?.billableAttempts ?? [];
    const known = gatewayError !== null && gatewayError.hasUncertainOutcome === false && attempts.length > 0;
    const privateError = JSON.stringify({ name: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : String(error),
      ...(gatewayError ? { attempts: gatewayError.attempts, hasUncertainOutcome: gatewayError.hasUncertainOutcome ?? true } : {}) });
    await saveOutcome(db, scope, requestFingerprint, known ? "rejected" : "uncertain", null, attempts, privateError);
    if (!known) fail("OUTCOME_UNRESOLVED", "The provider outcome is uncertain; this review must be reconciled before retry.");
    throw error;
  }
  try {
    result = snapshot({ ...result, journalCompletedAt: new Date().toISOString() });
    await saveOutcome(db, scope, requestFingerprint, "completed", result, attemptsForResult(result), null);
  } catch (error) {
    if (error instanceof EntityReviewJournalError) throw error;
    fail("JOURNAL_PERSISTENCE", "The provider returned an unrecordable dossier result; reconciliation is required.");
  }
  params.request.validate?.(result.text);
  return result;
}

function frozenPageRequest(parent: EntityReviewCallRow, page: JsonObject, index: number): JsonObject {
  return { version: "storyhold:entity-review-page:v1", reviewId: parent.review_id,
    parentRequestFingerprint: parent.request_fingerprint, index, page };
}
function pagePlan(parent: EntityReviewCallRow): JsonObject[] {
  const pages = parent.request_snapshot.pages;
  const version = parent.request_snapshot.version;
  if (!["storyhold:entity-review-request:v2", "storyhold:entity-review-request:v3", "storyhold:entity-review-request:v4"].includes(String(version)) || !Array.isArray(pages) || !pages.length) {
    fail("JOURNAL_INTEGRITY", "The dossier review has no complete frozen page plan.");
  }
  const input = parent.context_snapshot?.input as unknown as EntityReviewInput | undefined;
  let expectedSteps: string[] | undefined;
  if (version === "storyhold:entity-review-request:v3" || version === "storyhold:entity-review-request:v4") {
    if (input?.existingProseReview?.version !== 1 || input.proseReview?.version !== 1 || input.graphReview?.version !== 2) {
      fail("JOURNAL_INTEGRITY", "The existing-prose audit requires its frozen graph, prose and stored-item contracts.");
    }
    try {
      if ((input.compassReview !== undefined) !== (version === "storyhold:entity-review-request:v4")) throw new Error("Wrong compass contract version.");
      if (input.compassReview) buildEntityCompassRequest(input);
      expectedSteps = [...prepareEntityReviewPages(input).pages.map((page) => page.stepKey),
        ...prepareEntityExistingProsePages(input).map((page) => page.stepKey)];
    } catch { fail("JOURNAL_INTEGRITY", "The frozen existing-prose inventory no longer produces a valid complete page plan."); }
    if (pages.length !== expectedSteps.length) fail("JOURNAL_INTEGRITY", "The paid dossier plan omits or adds an existing-prose audit page.");
  } else if (input?.existingProseReview !== undefined || input?.compassReview !== undefined) {
    fail("JOURNAL_INTEGRITY", "A legacy page plan cannot bypass the frozen existing-prose audit.");
  }
  for (const [index, page] of pages.entries()) {
    if (!page || typeof page !== "object" || Array.isArray(page) || page.stepKey !== (expectedSteps?.[index] ?? `dossier_graph:${index}`)
      || typeof page.provider !== "string" || !page.provider || typeof page.model !== "string" || !page.model
      || !page.request || typeof page.request !== "object" || Array.isArray(page.request)
      || page.request.allowProviderFallback !== false || page.request.providerFailurePolicy !== "stop") {
      fail("JOURNAL_INTEGRITY", "The dossier page plan is malformed or changes its provider failure policy.");
    }
  }
  return pages as JsonObject[];
}
function aggregatePageResults(pages: EntityReviewPageRow[]): PagedEntityReviewResult {
  const results = pages.map((page) => ({ stepKey: page.step_key, result: snapshot(page.result_snapshot!) }));
  const last = results.at(-1)!.result;
  return { ...last, entityReviewPages: results,
    priorBillableAttempts: [...pages.slice(0, -1).flatMap((page) => snapshot(page.billable_attempts)), ...(last.priorBillableAttempts ?? [])] };
}
/** Every completed parent is bound to the complete immutable child inventory;
 * partial parents may contain only a completed prefix and one unresolved tail. */
async function checkedPages(db: QueryDb, parent: EntityReviewCallRow): Promise<EntityReviewPageRow[]> {
  const plan = pagePlan(parent);
  const pages = (await db.query<EntityReviewPageRow>(
    "SELECT * FROM storyhold.entity_review_ai_pages WHERE review_id = $1 ORDER BY page_index", [parent.review_id])).rows;
  if (pages.length > plan.length) fail("JOURNAL_INTEGRITY", "The dossier journal contains an unplanned page.");
  for (const [index, page] of pages.entries()) {
    const request = frozenPageRequest(parent, plan[index]!, index);
    if (page.review_id !== parent.review_id || page.page_index !== index || page.step_key !== plan[index]!.stepKey
      || hash(page.request_snapshot) !== hash(request) || hash(page.request_snapshot) !== page.request_fingerprint
      || !Array.isArray(page.billable_attempts) || !["dispatched", "completed", "rejected", "uncertain"].includes(page.status)
      || (index < pages.length - 1 && page.status !== "completed")
      || (page.status === "dispatched" && (page.result_snapshot !== null || page.result_fingerprint !== null
        || page.billable_attempts.length !== 0 || page.error !== null))
      || (page.status !== "dispatched" && outcomeFingerprint(page) !== page.result_fingerprint)
      || (page.status !== "completed" && page.result_snapshot !== null)
      || (page.status === "rejected" && !page.billable_attempts.length)
      || (page.status === "completed" && (!page.result_snapshot || typeof page.result_snapshot.text !== "string"
        || !page.result_snapshot.usage || !page.result_snapshot.runtime || !page.result_snapshot.journalCompletedAt
        || Number.isNaN(Date.parse(page.result_snapshot.journalCompletedAt))
        || hash(attemptsForResult(page.result_snapshot)) !== hash(page.billable_attempts)
        || "entityReviewPages" in page.result_snapshot))) {
      fail("JOURNAL_INTEGRITY", "A dossier page failed its exact request, outcome, or ordering check.");
    }
  }
  if (parent.status === "completed" && (pages.length !== plan.length || pages.some((page) => page.status !== "completed")
    || hash(aggregatePageResults(pages)) !== hash(parent.result_snapshot)
    || hash(pages.flatMap((page) => page.billable_attempts)) !== hash(parent.billable_attempts))) {
    fail("JOURNAL_INTEGRITY", "The completed dossier result does not cover every saved paid page exactly once.");
  }
  if (["rejected", "uncertain"].includes(parent.status) && (pages.at(-1)?.status !== parent.status
    || hash(pages.flatMap((page) => page.billable_attempts)) !== hash(parent.billable_attempts))) {
    fail("JOURNAL_INTEGRITY", "The failed dossier result does not include its complete paid page history.");
  }
  if (parent.status === "dispatched" && pages.some((page) => ["rejected", "uncertain"].includes(page.status))) {
    fail("JOURNAL_INTEGRITY", "A terminal dossier page is missing its parent outcome.");
  }
  return pages;
}

export async function readEntityReviewPageProgress(db: QueryDb, scope: EntityReviewCallScope): Promise<{
  completedPages: number; totalPages: number; canResume: boolean; blockedStatus: EntityReviewCallStatus | null; nextStepKey: string | null;
}> {
  const parent = await readEntityReviewCall(db, scope);
  if (!parent) fail("CALL_MISSING", "The dossier review has no durable page plan.");
  const plan = pagePlan(parent); const pages = await checkedPages(db, parent);
  const completedPages = pages.filter((page) => page.status === "completed").length;
  const blockedStatus = pages.find((page) => page.status !== "completed")?.status ?? null;
  return { completedPages, totalPages: plan.length,
    canResume: parent.finalization_snapshot === null && parent.status === "dispatched" && blockedStatus === null,
    blockedStatus, nextStepKey: completedPages < plan.length ? String(plan[completedPages]!.stepKey) : null };
}

async function savePageOutcome(db: QueryDb, parent: EntityReviewCallRow, page: EntityReviewPageRow,
  status: Exclude<EntityReviewCallStatus, "dispatched">, result: AiTextResult | null, attempts: AiBillableAttempt[], error: string | null): Promise<void> {
  const copiedResult = snapshot(result); const copiedAttempts = snapshot(attempts);
  const fingerprint = outcomeFingerprint({ status, result_snapshot: copiedResult, billable_attempts: copiedAttempts, error });
  const saved = await db.query(`UPDATE storyhold.entity_review_ai_pages
    SET status = $3, result_snapshot = $4::jsonb, result_fingerprint = $5, billable_attempts = $6::jsonb, error = $7, completed_at = now()
    WHERE review_id = $1 AND step_key = $2 AND status = 'dispatched' AND request_fingerprint = $8 RETURNING step_key`,
  [parent.review_id, page.step_key, status, copiedResult === null ? null : JSON.stringify(copiedResult), fingerprint,
    JSON.stringify(copiedAttempts), error, page.request_fingerprint]);
  if (saved.rows.length !== 1) fail("JOURNAL_PERSISTENCE", "The paid dossier page could not be durably recorded; do not repeat its provider call.");
}

/** One funding parent; each immutable child is claimed and committed before its
 * provider call. A missing page is resumable, an already dispatched page is not. */
export async function executeJournaledEntityReviewPages(db: JournalDb, params: {
  scope: EntityReviewCallScope; reservationId: string | null; contextSnapshot: JsonObject; pages: EntityReviewJournalPage[];
  invoke: (page: EntityReviewJournalPage, index: number) => Promise<AiTextResult>;
  beforePage?: (page: EntityReviewJournalPage, index: number) => Promise<void>;
}): Promise<PagedEntityReviewResult> {
  scopeValid(params.scope);
  let context: JsonObject; let requestSnapshot: JsonObject;
  try {
    context = snapshot(params.contextSnapshot);
    if (!params.pages.length || !context || typeof context !== "object" || Array.isArray(context)) throw new Error("Missing plan");
    const pages = params.pages.map(({ request, ...page }) => { const { validate: _validate, ...frozen } = request; return { ...page, request: frozen }; });
    const hasExistingProse = (context.input as unknown as EntityReviewInput | undefined)?.existingProseReview !== undefined;
    const hasCompass = (context.input as unknown as EntityReviewInput | undefined)?.compassReview !== undefined;
    requestSnapshot = snapshot({ version: hasCompass ? "storyhold:entity-review-request:v4" : hasExistingProse ? "storyhold:entity-review-request:v3" : "storyhold:entity-review-request:v2", scope: params.scope,
      provider: params.pages[0]!.provider, model: params.pages[0]!.model,
      reservationId: params.reservationId, contextFingerprint: hash(context), pages }) as unknown as JsonObject;
    pagePlan({ request_snapshot: requestSnapshot, context_snapshot: context } as EntityReviewCallRow);
  } catch { fail("REQUEST_INVALID", "A paged dossier review requires its complete ordered safe-provider request plan."); }
  await prepareParent(db, params, context, requestSnapshot);
  const getParent = async (queryDb: QueryDb) => {
    const row = await readEntityReviewCall(queryDb, params.scope);
    if (!row) fail("CALL_MISSING", "The frozen dossier review is missing.");
    if (row.finalization_snapshot !== null) fail("REVIEW_FINALIZED", "This dossier review is already finalized.");
    if (row.status === "rejected") fail("PREVIOUSLY_REJECTED", "A paid dossier page was rejected and cannot be automatically retried.");
    if (row.status === "uncertain") fail("OUTCOME_UNRESOLVED", "A dossier page outcome is uncertain; its credit hold remains reserved.");
    return row;
  };
  for (const [index, page] of params.pages.entries()) {
    let parent = await getParent(db);
    if (parent.status === "completed") return snapshot(parent.result_snapshot as PagedEntityReviewResult);
    const previous = await checkedPages(db, parent);
    if (previous[index]?.status === "completed") continue;
    if (previous.some((item) => item.status !== "completed")) fail("OUTCOME_UNRESOLVED", "A dispatched dossier page cannot be automatically repeated.");
    await params.beforePage?.(page, index);
    const claimed = await db.transaction(async (tx) => {
      await lockTarget(tx, params.scope);
      await tx.query("SELECT review_id FROM storyhold.entity_review_ai_calls WHERE review_id = $1 FOR UPDATE", [params.scope.reviewId]);
      parent = await getParent(tx);
      const current = await checkedPages(tx, parent);
      if (parent.status === "completed" || current[index]?.status === "completed") return null;
      if (current.length !== index || current.some((item) => item.status !== "completed")) fail("OUTCOME_UNRESOLVED", "Another request already dispatched this dossier page.");
      // A resumed review cannot dispatch against a released or otherwise changed hold.
      if (!parent.unlimited) {
        const hold = (await tx.query<{ id: string }>(`SELECT id FROM storyhold.credit_reservations WHERE id = $1
          AND player_id = $2 AND world_id = $3 AND request_id = $4 AND operation = 'entity_review' AND status = 'reserved'
          AND reserved_credits = $5 AND usage->>'retainUntilReconciled' = 'true' AND usage->>'entityReviewJournalId' = $4 FOR UPDATE`,
        [parent.reservation_id, parent.player_id, parent.world_id, parent.review_id, parent.reserved_credits])).rows[0];
        if (!hold) fail("RESERVATION_UNAVAILABLE", "The original dossier credit hold must remain intact before another page runs.");
      } else {
        const player = (await tx.query<{ role: string }>("SELECT role FROM storyhold.players WHERE id = $1 FOR SHARE", [parent.player_id])).rows[0];
        if (!player || !["owner", "admin"].includes(player.role)) fail("RESERVATION_UNAVAILABLE", "The exempt dossier account no longer has administrator access.");
      }
      const frozen = frozenPageRequest(parent, pagePlan(parent)[index]!, index);
      return (await tx.query<EntityReviewPageRow>(`INSERT INTO storyhold.entity_review_ai_pages
        (review_id,step_key,page_index,request_snapshot,request_fingerprint) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING *`,
      [params.scope.reviewId, page.stepKey, index, JSON.stringify(frozen), hash(frozen)])).rows[0]!;
    });
    if (!claimed) continue;
    let result: AiTextResult;
    try {
      result = await params.invoke(page, index);
      result = snapshot({ ...result, journalCompletedAt: new Date().toISOString() });
      if ("entityReviewPages" in result) throw new Error("Provider pages cannot contain an aggregate journal result.");
      try { page.request.validate?.(result.text); }
      catch (error) { throw new AiGatewayUnavailableError(error instanceof Error ? error.message : String(error), [], attemptsForResult(result), false); }
    } catch (error) {
      const gateway = error instanceof AiGatewayUnavailableError ? error : null;
      const attempts = gateway?.billableAttempts ?? [];
      const known = gateway !== null && gateway.hasUncertainOutcome === false && attempts.length > 0;
      const status = known ? "rejected" : "uncertain";
      const privateError = JSON.stringify({ name: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : String(error),
        hasUncertainOutcome: !known });
      try {
        await db.transaction(async (tx) => {
          await tx.query("SELECT review_id FROM storyhold.entity_review_ai_calls WHERE review_id = $1 FOR UPDATE", [params.scope.reviewId]);
          const prefix = await checkedPages(tx, parent);
          await savePageOutcome(tx, parent, claimed, status, null, attempts, privateError);
          await saveOutcome(tx, params.scope, parent.request_fingerprint, status, null,
            [...prefix.slice(0, index).flatMap((item) => item.billable_attempts), ...attempts], privateError);
        });
      } catch { fail("JOURNAL_PERSISTENCE", "The paid dossier page outcome could not be recorded; reconciliation is required before retry."); }
      if (!known) fail("OUTCOME_UNRESOLVED", "A dossier page has an uncertain provider outcome; do not repeat the paid request.");
      throw error;
    }
    try { await savePageOutcome(db, parent, claimed, "completed", result, attemptsForResult(result), null); }
    catch { fail("JOURNAL_PERSISTENCE", "The paid dossier page could not be recorded; reconciliation is required before retry."); }
  }
  return db.transaction(async (tx) => {
    await tx.query("SELECT review_id FROM storyhold.entity_review_ai_calls WHERE review_id = $1 FOR UPDATE", [params.scope.reviewId]);
    const parent = await getParent(tx);
    if (parent.status === "completed") return snapshot(parent.result_snapshot as PagedEntityReviewResult);
    const pages = await checkedPages(tx, parent);
    if (pages.length !== params.pages.length || pages.some((page) => page.status !== "completed")) fail("OUTCOME_UNRESOLVED", "The dossier page inventory is not complete.");
    const result = aggregatePageResults(pages);
    await saveOutcome(tx, params.scope, parent.request_fingerprint, "completed", result, pages.flatMap((page) => page.billable_attempts), null);
    return snapshot(result);
  });
}
