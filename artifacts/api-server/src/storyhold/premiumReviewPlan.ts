import type { PGlite } from "@electric-sql/pglite";
import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import { readPremiumJournalAccounting } from "./premiumReviewJournal";
import { assertPremiumVerificationPages, type PremiumVerificationPage } from "./premiumVerificationPages";
import type { AnalysisChunk } from "./worldAnalysis";
import { PREMIUM_CLOCK_PAGES_PER_VERIFICATION_BATCH_LIMIT } from "./premiumReviewLimits";
export { PREMIUM_CLOCK_PAGES_PER_VERIFICATION_BATCH_LIMIT } from "./premiumReviewLimits";

type PlanQueryDb = Pick<PGlite, "query">;
type PlanDb = PlanQueryDb & Pick<PGlite, "transaction">;

type PremiumReviewPlanBase = {
  runId: string;
  worldId: string;
  editionId: string;
  playerId: string;
  executionVersion: string;
  scopeFingerprint: string;
  provider: string;
  model: string;
  worldContext: {
    worldName: string;
    premise: string;
    genre: string;
    userGuidance: string;
  };
  chunks: AnalysisChunk[];
  verificationBatches: string[][];
  incremental: boolean;
  partialDueToCredits: boolean;
  reservationId: string | null;
  reservedCredits: number;
  unlimited: boolean;
};

/** Canonical identities available before paid chronology begins. Later model
 * discoveries may still create events, but no actor/location edge can attach
 * to a guessed name or to an entity changed during the review. */
export type PremiumClockEntityRegistryEntry = {
  id: string;
  name: string;
  aliases: string[];
  entityType: string;
};

export type PremiumClockOwnerConstraint = {
  id: string;
  kind: "identity" | "relation" | "timeline" | "categorization" | "canon" | "other" | "exclusion";
  instruction: string;
  scopeEntityId: string | null;
};

/** Frozen after every source-verification page and before chronology:0. This
 * binds the dynamically derived clock inventory without making provider output
 * part of the earlier pre-dispatch plan. */
export type PremiumClockManifest = {
  version: 1;
  runId: string;
  worldId: string;
  editionId: string;
  pageCount: number;
  pageManifestFingerprint: string;
  inputFingerprint: string;
  requestManifestFingerprint: string;
};

export type PremiumReviewPlan = PremiumReviewPlanBase & (
  | { version: 1; verificationPages?: never }
  | { version: 2; verificationPages: PremiumVerificationPage[] }
  | {
      version: 3;
      verificationPages: PremiumVerificationPage[];
      clockReviewVersion: 1;
      clockEntityRegistry: PremiumClockEntityRegistryEntry[];
      clockOwnerConstraints: PremiumClockOwnerConstraint[];
    }
);

export const premiumReviewPlanSchemaSql = String.raw`
  CREATE TABLE IF NOT EXISTS storyhold.world_analysis_premium_plans (
    run_id uuid PRIMARY KEY REFERENCES storyhold.world_analysis_runs(id) ON DELETE CASCADE,
    snapshot jsonb NOT NULL,
    fingerprint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE OR REPLACE FUNCTION storyhold.reject_premium_plan_update()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'Premium review execution plans are immutable';
  END;
  $$;

  DROP TRIGGER IF EXISTS premium_plan_immutable ON storyhold.world_analysis_premium_plans;
  CREATE TRIGGER premium_plan_immutable
    BEFORE UPDATE ON storyhold.world_analysis_premium_plans
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_premium_plan_update();

  CREATE TABLE IF NOT EXISTS storyhold.world_analysis_premium_clock_manifests (
    run_id uuid PRIMARY KEY REFERENCES storyhold.world_analysis_premium_plans(run_id) ON DELETE CASCADE,
    snapshot jsonb NOT NULL,
    fingerprint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE OR REPLACE FUNCTION storyhold.reject_premium_clock_manifest_update()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'Premium World Clock manifests are immutable';
  END;
  $$;

  DROP TRIGGER IF EXISTS premium_clock_manifest_immutable ON storyhold.world_analysis_premium_clock_manifests;
  CREATE TRIGGER premium_clock_manifest_immutable
    BEFORE UPDATE ON storyhold.world_analysis_premium_clock_manifests
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_premium_clock_manifest_update();
`;

export const schemaSql = premiumReviewPlanSchemaSql;

export class PremiumReviewPlanError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PremiumReviewPlanError";
  }
}

function invalid(message: string): never {
  throw new PremiumReviewPlanError("PLAN_INVALID", message);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_PLAN_CHUNKS = 100_000;
const MAX_PLAN_VERIFICATION_PAGES = 100_000;
const MAX_PLAN_CONTENT_CHARACTERS = 100_000_000;
/** The reservation prices this many bounded clock calls per source batch. */
const MAX_CLOCK_ENTITY_REGISTRY = 100_000;

function validatePlan(value: unknown): asserts value is PremiumReviewPlan {
  if (!record(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3)) invalid("Unsupported or malformed premium review plan version.");
  for (const field of ["runId", "worldId", "editionId", "playerId"] as const) {
    if (typeof value[field] !== "string" || !UUID.test(value[field])) invalid(`Invalid premium plan ${field}.`);
  }
  for (const field of ["executionVersion", "scopeFingerprint", "provider", "model"] as const) {
    if (!nonblank(value[field])) invalid(`Premium plan ${field} must be nonblank.`);
  }
  if (!record(value.worldContext) || !nonblank(value.worldContext.worldName)) invalid("The frozen world context is missing.");
  for (const field of ["premise", "genre", "userGuidance"] as const) {
    if (typeof value.worldContext[field] !== "string") invalid(`Invalid frozen world context ${field}.`);
  }
  if (typeof value.incremental !== "boolean" || typeof value.partialDueToCredits !== "boolean" || typeof value.unlimited !== "boolean") {
    invalid("Premium review plan flags must be explicit booleans.");
  }
  if (!Number.isSafeInteger(value.reservedCredits) || Number(value.reservedCredits) < 0 || Number(value.reservedCredits) > 2_147_483_647) {
    invalid("Invalid reserved credit amount in premium review plan.");
  }
  if (value.unlimited) {
    if (value.reservationId !== null || value.reservedCredits !== 0) invalid("An exempt plan must not include a paid reservation.");
  } else if (typeof value.reservationId !== "string" || !UUID.test(value.reservationId)) {
    invalid("A metered plan requires its original reservation ID.");
  }
  if (!Array.isArray(value.chunks) || value.chunks.length === 0 || value.chunks.length > MAX_PLAN_CHUNKS) {
    invalid("Premium review plan must contain a bounded, nonempty chunk inventory.");
  }
  const ids: string[] = [];
  const unique = new Set<string>();
  let contentCharacters = 0;
  for (const chunk of value.chunks) {
    if (!record(chunk) || !nonblank(chunk.id) || !nonblank(chunk.sourceId)
      || typeof chunk.sourceTitle !== "string" || !nonblank(chunk.content)
      || !Number.isSafeInteger(chunk.index) || Number(chunk.index) < 0
      || (chunk.sectionTitle !== undefined && chunk.sectionTitle !== null && typeof chunk.sectionTitle !== "string")) {
      invalid("Premium review plan contains a malformed source chunk.");
    }
    if (unique.has(chunk.id)) invalid("Premium review plan contains duplicate chunk IDs.");
    unique.add(chunk.id);
    ids.push(chunk.id);
    contentCharacters += chunk.content.length;
    if (contentCharacters > MAX_PLAN_CONTENT_CHARACTERS) invalid("Premium review plan exceeds the frozen content limit.");
  }
  if (!Array.isArray(value.verificationBatches) || value.verificationBatches.length === 0 || value.verificationBatches.length > ids.length) {
    invalid("Premium review plan requires nonempty verification batches.");
  }
  let position = 0;
  for (const batch of value.verificationBatches) {
    if (!Array.isArray(batch) || batch.length === 0) invalid("Premium review batches must be nonempty.");
    for (const chunkId of batch) {
      if (typeof chunkId !== "string" || chunkId !== ids[position]) {
        invalid("Verification batches must partition every frozen chunk exactly once in its original order.");
      }
      position += 1;
    }
  }
  if (position !== ids.length) invalid("Verification batches omit frozen source chunks.");
  if (value.version === 1) {
    if (Object.hasOwn(value, "verificationPages") || Object.hasOwn(value, "clockReviewVersion")
      || Object.hasOwn(value, "clockEntityRegistry") || Object.hasOwn(value, "clockOwnerConstraints")) {
      invalid("Legacy premium review plans cannot contain candidate pages or a clock contract.");
    }
  } else {
    if (!Array.isArray(value.verificationPages) || value.verificationPages.length === 0
      || value.verificationPages.length > MAX_PLAN_VERIFICATION_PAGES) {
      invalid("Premium review plan requires a bounded, nonempty candidate page inventory.");
    }
    try {
      assertPremiumVerificationPages(value.verificationPages, value.verificationBatches.length);
    } catch {
      invalid("Premium review candidate pages must preserve their complete, ordered source-batch groups and step identities.");
    }
    if (value.version === 3) {
      if (value.clockReviewVersion !== 1) invalid("The clock review contract version is invalid.");
      if (!Array.isArray(value.clockEntityRegistry) || value.clockEntityRegistry.length > MAX_CLOCK_ENTITY_REGISTRY) {
        invalid("The clock entity registry must be an explicit bounded array.");
      }
      const entityIds = new Set<string>();
      let previousId = "";
      for (const entity of value.clockEntityRegistry) {
        if (!record(entity) || Object.keys(entity).sort().join("\n") !== ["aliases", "entityType", "id", "name"].sort().join("\n")
          || typeof entity.id !== "string" || !UUID.test(entity.id) || entityIds.has(entity.id)
          || !nonblank(entity.name) || entity.name.length > 500
          || !nonblank(entity.entityType) || entity.entityType.length > 80
          || !Array.isArray(entity.aliases) || entity.aliases.length > 200
          || entity.aliases.some((alias) => !nonblank(alias) || alias.length > 500)) {
          invalid("The clock entity registry contains a malformed or duplicate canonical identity.");
        }
        if (previousId && entity.id.localeCompare(previousId) <= 0) {
          invalid("The clock entity registry must preserve deterministic ID order.");
        }
        previousId = entity.id;
        entityIds.add(entity.id);
      }
      if (!Array.isArray(value.clockOwnerConstraints) || value.clockOwnerConstraints.length > 500) {
        invalid("The clock owner constraints must be an explicit bounded array.");
      }
      const constraintIds = new Set<string>();
      let previousConstraintId = "";
      for (const constraint of value.clockOwnerConstraints) {
        if (!record(constraint)
          || Object.keys(constraint).sort().join("\n") !== ["id", "instruction", "kind", "scopeEntityId"].sort().join("\n")
          || typeof constraint.id !== "string" || !UUID.test(constraint.id) || constraintIds.has(constraint.id)
          || !["identity", "relation", "timeline", "categorization", "canon", "other", "exclusion"].includes(String(constraint.kind))
          || !nonblank(constraint.instruction) || constraint.instruction.length > 4_000
          || (constraint.scopeEntityId !== null
            && (typeof constraint.scopeEntityId !== "string" || !UUID.test(constraint.scopeEntityId)
              || !entityIds.has(constraint.scopeEntityId)))) {
          invalid("The clock owner constraints contain a malformed or duplicate correction.");
        }
        if (previousConstraintId && constraint.id.localeCompare(previousConstraintId) <= 0) {
          invalid("The clock owner constraints must preserve deterministic ID order.");
        }
        previousConstraintId = constraint.id;
        constraintIds.add(constraint.id);
      }
    } else if (Object.hasOwn(value, "clockReviewVersion") || Object.hasOwn(value, "clockEntityRegistry")
      || Object.hasOwn(value, "clockOwnerConstraints")) {
      invalid("An older premium review plan cannot acquire a clock contract.");
    }
  }
}

function fingerprint(plan: PremiumReviewPlan): string {
  return canonPayloadFingerprint({
    namespace: `storyhold:premium-review-plan:v${plan.version}`,
    plan: plan as unknown as JsonObject,
  });
}

function validateClockManifest(
  plan: PremiumReviewPlan,
  value: unknown,
): asserts value is PremiumClockManifest {
  if (plan.version !== 3) {
    throw new PremiumReviewPlanError(
      "PLAN_INVALID",
      "Only a version-three premium review can freeze a World Clock manifest.",
    );
  }
  if (!record(value)
    || Object.keys(value).sort().join("\n") !== [
      "editionId", "inputFingerprint", "pageCount", "pageManifestFingerprint",
      "requestManifestFingerprint", "runId", "version", "worldId",
    ].sort().join("\n")
    || value.version !== 1
    || value.runId !== plan.runId
    || value.worldId !== plan.worldId
    || value.editionId !== plan.editionId
    || !Number.isSafeInteger(value.pageCount)
    || Number(value.pageCount) < 0
    || Number(value.pageCount) > premiumReviewMaximumClockPageCount(plan)
    || typeof value.pageManifestFingerprint !== "string"
    || !/^clock_page_manifest_[0-9a-f]{64}$/u.test(value.pageManifestFingerprint)
    || typeof value.inputFingerprint !== "string"
    || !/^clock_inventory_[0-9a-f]{64}$/u.test(value.inputFingerprint)
    || typeof value.requestManifestFingerprint !== "string"
    || !/^canon_payload_[0-9a-f]{64}$/u.test(value.requestManifestFingerprint)) {
    throw new PremiumReviewPlanError(
      "CLOCK_MANIFEST_INVALID",
      "The World Clock manifest is malformed, out of scope, or exceeds its frozen reservation.",
    );
  }
}

function clockManifestFingerprint(manifest: PremiumClockManifest): string {
  return canonPayloadFingerprint({
    namespace: "storyhold:premium-clock-manifest:v1",
    manifest: manifest as unknown as JsonObject,
  });
}

export async function readPremiumClockManifest(
  db: PlanQueryDb,
  plan: PremiumReviewPlan,
): Promise<PremiumClockManifest | null> {
  validatePlan(plan);
  if (plan.version !== 3) return null;
  const result = await db.query<{ snapshot: unknown; fingerprint: string }>(
    "SELECT snapshot, fingerprint FROM storyhold.world_analysis_premium_clock_manifests WHERE run_id = $1",
    [plan.runId],
  );
  const row = result.rows[0];
  if (!row) return null;
  try {
    validateClockManifest(plan, row.snapshot);
    if (clockManifestFingerprint(row.snapshot) !== row.fingerprint) throw new Error("Manifest fingerprint mismatch");
    return row.snapshot;
  } catch {
    throw new PremiumReviewPlanError(
      "CLOCK_MANIFEST_INTEGRITY",
      "The stored World Clock manifest failed its integrity check.",
    );
  }
}

/** Frozen call identities, including every candidate page before chronology. */
export function premiumReviewVerificationStepKeys(plan: PremiumReviewPlan): string[] {
  validatePlan(plan);
  return (plan.version === 2 || plan.version === 3)
    ? plan.verificationPages.map((page) => page.stepKey)
    : plan.verificationBatches.map((_batch, index) => `verification:${index}`);
}

/** Maximum chronology calls covered by the immutable premium reservation. */
export function premiumReviewMaximumClockPageCount(plan: PremiumReviewPlan): number {
  validatePlan(plan);
  return plan.verificationBatches.length * PREMIUM_CLOCK_PAGES_PER_VERIFICATION_BATCH_LIMIT;
}

async function assertPremiumChronologyJournalState(
  db: PlanQueryDb,
  plan: PremiumReviewPlan,
  expectedPageCount: number,
  options: { requireComplete?: boolean } = {},
): Promise<number> {
  try {
    // A status label is not proof of a durable paid response. Authenticate all
    // request/result fingerprints and recorded attempts before trusting it.
    await readPremiumJournalAccounting(db, plan.runId);
  } catch {
    throw new PremiumReviewPlanError(
      "CLOCK_JOURNAL_MISMATCH",
      "The saved premium journal failed its integrity check before World Clock review.",
    );
  }
  const rows = await db.query<{ step_key: string; status: string }>(
    "SELECT step_key, status FROM storyhold.world_analysis_ai_calls WHERE run_id = $1",
    [plan.runId],
  );
  const expectedVerification = new Set(premiumReviewVerificationStepKeys(plan));
  const completedVerification = new Set<string>();
  const chronology: number[] = [];
  for (const row of rows.rows) {
    const verificationMatch = /^verification:(0|[1-9][0-9]*)$/u.exec(row.step_key);
    if (verificationMatch) {
      if (!expectedVerification.has(row.step_key) || row.status !== "completed") {
        throw new PremiumReviewPlanError(
          "CLOCK_JOURNAL_MISMATCH",
          "World Clock review requires every exact frozen verification page to be complete.",
        );
      }
      completedVerification.add(row.step_key);
      continue;
    }
    const chronologyMatch = /^chronology:(0|[1-9][0-9]*)$/u.exec(row.step_key);
    if (!chronologyMatch || row.status !== "completed") {
      throw new PremiumReviewPlanError(
        "CLOCK_JOURNAL_MISMATCH",
        "The premium journal contains an unexpected or unfinished World Clock step.",
      );
    }
    chronology.push(Number(chronologyMatch[1]));
  }
  if (completedVerification.size !== expectedVerification.size) {
    throw new PremiumReviewPlanError(
      "CLOCK_JOURNAL_MISMATCH",
      "World Clock review cannot begin before every frozen verification page is complete.",
    );
  }
  chronology.sort((left, right) => left - right);
  if (chronology.some((index, position) => index !== position || index >= expectedPageCount)) {
    throw new PremiumReviewPlanError(
      "CLOCK_JOURNAL_MISMATCH",
      "Saved World Clock calls are not an exact prefix of the rebuilt page inventory.",
    );
  }
  if (options.requireComplete === true && chronology.length !== expectedPageCount) {
    throw new PremiumReviewPlanError(
      "CLOCK_JOURNAL_MISMATCH",
      "The completed World Clock is missing one or more exact paid page receipts.",
    );
  }
  return chronology.length;
}

/**
 * Freeze the complete dynamically derived v3 clock manifest exactly once. It
 * must happen after every source-verification page and before chronology:0, so
 * a restart cannot expand, shrink, or repack the remaining paid suffix.
 */
export async function freezePremiumClockManifest(
  db: PlanDb,
  plan: PremiumReviewPlan,
  supplied: PremiumClockManifest,
): Promise<PremiumClockManifest> {
  validatePlan(plan);
  validateClockManifest(plan, supplied);
  const manifest = JSON.parse(JSON.stringify(supplied)) as PremiumClockManifest;
  validateClockManifest(plan, manifest);
  return db.transaction(async (tx) => {
    await assertRunScope(tx, plan);
    const storedPlan = await readPremiumReviewPlan(tx, plan.runId);
    if (!storedPlan || fingerprint(storedPlan) !== fingerprint(plan)) {
      throw new PremiumReviewPlanError(
        "CLOCK_MANIFEST_MISMATCH",
        "The World Clock manifest no longer matches its immutable premium review plan.",
      );
    }
    await assertFunding(tx, plan, false);
    const existing = await readPremiumClockManifest(tx, plan);
    if (existing) {
      if (clockManifestFingerprint(existing) !== clockManifestFingerprint(manifest)) {
        throw new PremiumReviewPlanError(
          "CLOCK_MANIFEST_MISMATCH",
          "A different immutable World Clock inventory is already frozen for this review.",
        );
      }
      await assertPremiumChronologyJournalState(tx, plan, existing.pageCount);
      return existing;
    }
    const chronologyCount = await assertPremiumChronologyJournalState(tx, plan, manifest.pageCount);
    if (chronologyCount !== 0) {
      throw new PremiumReviewPlanError(
        "CLOCK_MANIFEST_MISSING",
        "Paid World Clock pages exist without the immutable manifest that had to precede them.",
      );
    }
    await tx.query(
      `INSERT INTO storyhold.world_analysis_premium_clock_manifests
        (run_id, snapshot, fingerprint) VALUES ($1, $2::jsonb, $3)`,
      [plan.runId, JSON.stringify(manifest), clockManifestFingerprint(manifest)],
    );
    const saved = await readPremiumClockManifest(tx, plan);
    if (!saved || clockManifestFingerprint(saved) !== clockManifestFingerprint(manifest)) {
      throw new PremiumReviewPlanError(
        "CLOCK_MANIFEST_INTEGRITY",
        "The immutable World Clock manifest could not be authenticated after saving.",
      );
    }
    return saved;
  });
}

/** Validate current work only against the already frozen v3 clock manifest.
 * The exact request journal still authenticates every individual paid page. */
export async function assertPremiumChronologyJournalPrefix(
  db: PlanQueryDb,
  plan: PremiumReviewPlan,
  supplied: PremiumClockManifest,
  options: { requireComplete?: boolean } = {},
): Promise<void> {
  validatePlan(plan);
  validateClockManifest(plan, supplied);
  const frozenManifest = await readPremiumClockManifest(db, plan);
  if (!frozenManifest) {
    throw new PremiumReviewPlanError(
      "CLOCK_MANIFEST_MISSING",
      "World Clock review cannot dispatch or finalize without its immutable page manifest.",
    );
  }
  if (clockManifestFingerprint(frozenManifest) !== clockManifestFingerprint(supplied)) {
    throw new PremiumReviewPlanError(
      "CLOCK_MANIFEST_MISMATCH",
      "The rebuilt World Clock inventory differs from the immutable pre-dispatch manifest.",
    );
  }
  await assertPremiumChronologyJournalState(db, plan, frozenManifest.pageCount, options);
}

function snapshotPlan(plan: PremiumReviewPlan): PremiumReviewPlan {
  validatePlan(plan);
  try {
    // Reject non-JSON values before serialization could silently replace them.
    fingerprint(plan);
    const snapshot: unknown = JSON.parse(JSON.stringify(plan));
    validatePlan(snapshot);
    return snapshot;
  } catch (error) {
    if (error instanceof PremiumReviewPlanError) throw error;
    return invalid("Premium review plan must be a finite, serializable JSON snapshot.");
  }
}

export async function readPremiumReviewPlan(db: PlanQueryDb, runId: string): Promise<PremiumReviewPlan | null> {
  const result = await db.query<{ snapshot: unknown; fingerprint: string }>(
    "SELECT snapshot, fingerprint FROM storyhold.world_analysis_premium_plans WHERE run_id = $1",
    [runId],
  );
  const row = result.rows[0];
  if (!row) return null;
  try {
    validatePlan(row.snapshot);
    if (row.snapshot.runId !== runId || fingerprint(row.snapshot) !== row.fingerprint) throw new Error("Plan fingerprint mismatch");
    return row.snapshot;
  } catch {
    throw new PremiumReviewPlanError("PLAN_INTEGRITY", "The stored premium review plan failed its integrity check.");
  }
}

async function assertRunScope(db: PlanQueryDb, plan: PremiumReviewPlan): Promise<void> {
  const result = await db.query(
    `SELECT id FROM storyhold.world_analysis_runs
      WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3
        AND requested_by_player_id = $4 FOR UPDATE`,
    [plan.runId, plan.worldId, plan.editionId, plan.playerId],
  );
  if (result.rows.length !== 1) {
    throw new PremiumReviewPlanError("PLAN_SCOPE_MISMATCH", "The premium review run no longer matches the saved world, edition, or player.");
  }
}

async function assertFunding(db: PlanQueryDb, plan: PremiumReviewPlan, retain: boolean): Promise<void> {
  if (plan.unlimited) {
    const player = await db.query<{ role: string }>("SELECT role FROM storyhold.players WHERE id = $1 FOR UPDATE", [plan.playerId]);
    if (!["owner", "admin"].includes(player.rows[0]?.role ?? "")) {
      throw new PremiumReviewPlanError("EXEMPTION_UNAVAILABLE", "The saved exempt premium review requires the player's current owner or admin role.");
    }
    return;
  }
  const reservation = await db.query<{ usage: Record<string, unknown> }>(
    `SELECT usage FROM storyhold.credit_reservations
      WHERE id = $1 AND world_id = $2 AND player_id = $3
        AND operation = 'world_analysis' AND request_id = $4
        AND reserved_credits = $5 AND status = 'reserved' FOR UPDATE`,
    [plan.reservationId, plan.worldId, plan.playerId, plan.runId, plan.reservedCredits],
  );
  if (reservation.rows.length !== 1 || (!retain && reservation.rows[0]?.usage?.retainUntilReconciled !== true)) {
    throw new PremiumReviewPlanError("RESERVATION_UNAVAILABLE", "The original retained premium review credit reservation is no longer available.");
  }
  if (retain) {
    await db.query(
      `UPDATE storyhold.credit_reservations
          SET usage = usage || '{"retainUntilReconciled":true}'::jsonb WHERE id = $1`,
      [plan.reservationId],
    );
  }
}

export async function savePremiumReviewPlan(db: PlanDb, supplied: PremiumReviewPlan): Promise<PremiumReviewPlan> {
  const plan = snapshotPlan(supplied);
  return db.transaction(async (tx) => {
    // FOR UPDATE conflicts with the journal's FK key-share lock, so no initial
    // plan can slip in behind a call that was dispatched without a frozen plan.
    await assertRunScope(tx, plan);
    const existing = await readPremiumReviewPlan(tx, plan.runId);
    if (existing) {
      if (fingerprint(existing) !== fingerprint(plan)) {
        throw new PremiumReviewPlanError("PLAN_MISMATCH", "A different immutable execution plan already exists for this premium review.");
      }
      await assertFunding(tx, existing, false);
      return existing;
    }
    const calls = await tx.query("SELECT step_key FROM storyhold.world_analysis_ai_calls WHERE run_id = $1 LIMIT 1", [plan.runId]);
    if (calls.rows.length > 0) {
      throw new PremiumReviewPlanError("JOURNAL_WITHOUT_PLAN", "A premium review plan cannot be created after a provider call was already journaled.");
    }
    await assertFunding(tx, plan, true);
    await tx.query(
      "INSERT INTO storyhold.world_analysis_premium_plans (run_id, snapshot, fingerprint) VALUES ($1, $2::jsonb, $3)",
      [plan.runId, JSON.stringify(plan), fingerprint(plan)],
    );
    return plan;
  });
}

export async function validatePremiumReviewResume(
  db: PlanDb,
  params: {
    runId: string;
    worldId: string;
    editionId: string;
    playerId: string;
    executionVersion: string;
    scopeFingerprint: string;
    provider: string;
    model: string;
  },
): Promise<PremiumReviewPlan> {
  return db.transaction(async (tx) => {
    const plan = await readPremiumReviewPlan(tx, params.runId);
    if (!plan) {
      const calls = await tx.query("SELECT step_key FROM storyhold.world_analysis_ai_calls WHERE run_id = $1 LIMIT 1", [params.runId]);
      throw new PremiumReviewPlanError(
        calls.rows.length ? "JOURNAL_WITHOUT_PLAN" : "PLAN_MISSING",
        "This premium review has no trusted frozen execution plan and cannot be resumed.",
      );
    }
    for (const field of ["worldId", "editionId", "playerId", "executionVersion", "scopeFingerprint", "provider", "model"] as const) {
      if (params[field] !== plan[field]) {
        throw new PremiumReviewPlanError("RESUME_SCOPE_MISMATCH", `Premium review resume no longer matches its saved ${field}.`);
      }
    }
    await assertRunScope(tx, plan);
    // This validates hashes for every saved response and usage record, not
    // merely its status label. Corrupt accounting must fail closed.
    const accounting = await readPremiumJournalAccounting(tx, plan.runId);
    for (const attempt of accounting.attempts) {
      const usage = attempt.usage;
      if (!usage || typeof usage !== "object" || usage.pricingKnown !== true
        || [
          "estimatedCostMicros", "inputUnits", "outputUnits", "cachedInputUnits",
          "cacheWriteInputUnits", "reasoningUnits",
        ].some((field) => {
          const value = usage[field as keyof typeof usage];
          return typeof value !== "number" || !Number.isFinite(value) || value < 0;
        })) {
        throw new PremiumReviewPlanError(
          "JOURNAL_USAGE_UNVERIFIED",
          "Saved premium usage has unknown pricing or invalid costs or counters; reconcile it before another provider call.",
        );
      }
    }
    const journal = await tx.query<{ step_key: string; status: string }>(
      "SELECT step_key, status FROM storyhold.world_analysis_ai_calls WHERE run_id = $1",
      [plan.runId],
    );
    if (accounting.hasUncertain || journal.rows.some((row) => row.status !== "completed")) {
      throw new PremiumReviewPlanError("JOURNAL_NOT_RESUMABLE", "An unresolved or rejected provider call prevents premium review resume; reconcile it first.");
    }
    const verification: number[] = [];
    const chronology: number[] = [];
    for (const row of journal.rows) {
      const key = /^(verification|chronology):(0|[1-9][0-9]*)$/u.exec(row.step_key);
      if (!key || !Number.isSafeInteger(Number(key[2]))) {
        throw new PremiumReviewPlanError("JOURNAL_NOT_RESUMABLE", "The saved premium journal contains an unknown or noncanonical step key.");
      }
      (key[1] === "verification" ? verification : chronology).push(Number(key[2]));
    }
    for (const indices of [verification, chronology]) {
      indices.sort((left, right) => left - right);
      if (indices.some((index, position) => index !== position)) {
        throw new PremiumReviewPlanError("JOURNAL_NOT_RESUMABLE", "Completed premium journal calls must form a contiguous prefix before any new call.");
      }
    }
    const verificationCount = premiumReviewVerificationStepKeys(plan).length;
    if (verification.length > verificationCount
      || (chronology.length > 0 && verification.length !== verificationCount)) {
      throw new PremiumReviewPlanError("JOURNAL_NOT_RESUMABLE", "Chronology cannot precede completed verification of every frozen candidate page.");
    }
    if (plan.version === 3 && chronology.length > premiumReviewMaximumClockPageCount(plan)) {
      throw new PremiumReviewPlanError(
        "JOURNAL_NOT_RESUMABLE",
        "The saved World Clock journal exceeds the calls reserved by its immutable premium review plan.",
      );
    }
    if (plan.version === 3) {
      const manifest = await readPremiumClockManifest(tx, plan);
      if (chronology.length > 0 && !manifest) {
        throw new PremiumReviewPlanError(
          "JOURNAL_NOT_RESUMABLE",
          "Paid World Clock pages exist without their required immutable pre-dispatch manifest.",
        );
      }
      if (manifest) await assertPremiumChronologyJournalPrefix(tx, plan, manifest);
    }
    await assertFunding(tx, plan, false);
    return plan;
  });
}
