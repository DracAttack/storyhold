import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type {
  AiCostReservationQuote,
  AiUsage,
  ReasoningLevel,
  StoryholdProviderId,
} from "./aiGateway";

type CreditQueryDb = Pick<PGlite, "exec" | "query">;
type CreditDb = CreditQueryDb & Pick<PGlite, "transaction">;

const DEFAULT_RETAIL_MICROS_PER_CREDIT = 20_000;
const DEFAULT_TARGET_MARGIN_BPS = 4_000;
const MINIMUM_TARGET_MARGIN_BPS = 4_000;

export const creditEconomySchemaSql = String.raw`
  CREATE TABLE IF NOT EXISTS storyhold.credit_reservations (
    id uuid PRIMARY KEY,
    player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE RESTRICT,
    world_id uuid REFERENCES storyhold.worlds(id) ON DELETE SET NULL,
    campaign_id uuid REFERENCES storyhold.campaigns(id) ON DELETE SET NULL,
    operation text NOT NULL,
    request_id text NOT NULL,
    reserved_credits integer NOT NULL CHECK (reserved_credits >= 0),
    actual_credits integer CHECK (actual_credits >= 0),
    status text NOT NULL DEFAULT 'reserved'
      CHECK (status IN ('reserved', 'settled', 'released')),
    provider text,
    model text,
    reasoning_level text,
    cost_micros bigint CHECK (cost_micros IS NULL OR cost_micros >= 0),
    pricing_version text,
    usage jsonb NOT NULL DEFAULT '{}'::jsonb,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    settled_at timestamptz,
    released_at timestamptz,
    UNIQUE (player_id, operation, request_id)
  );

  CREATE INDEX IF NOT EXISTS credit_reservations_active
    ON storyhold.credit_reservations (player_id, status, expires_at);

  CREATE TABLE IF NOT EXISTS storyhold.credit_ledger (
    id uuid PRIMARY KEY,
    player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE RESTRICT,
    world_id uuid REFERENCES storyhold.worlds(id) ON DELETE SET NULL,
    campaign_id uuid REFERENCES storyhold.campaigns(id) ON DELETE SET NULL,
    reservation_id uuid REFERENCES storyhold.credit_reservations(id) ON DELETE RESTRICT,
    operation text NOT NULL,
    request_id text NOT NULL,
    entry_kind text NOT NULL
      CHECK (entry_kind IN ('reserve', 'settle_adjustment', 'release', 'grant', 'purchase', 'manual')),
    credits_delta integer NOT NULL,
    balance_after integer NOT NULL CHECK (balance_after >= 0),
    provider text,
    model text,
    cost_micros bigint CHECK (cost_micros IS NULL OR cost_micros >= 0),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS credit_ledger_player_scope
    ON storyhold.credit_ledger (player_id, created_at DESC);

  CREATE OR REPLACE FUNCTION storyhold.reject_credit_ledger_mutation()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    -- Deleting a world or campaign uses FK SET NULL so its financial history
    -- survives without retaining the customer-owned scope row. Permit only that
    -- referential cleanup; every identity and accounting field stays immutable.
    IF TG_OP = 'UPDATE'
      AND NEW.id IS NOT DISTINCT FROM OLD.id
      AND NEW.player_id IS NOT DISTINCT FROM OLD.player_id
      AND (NEW.world_id IS NOT DISTINCT FROM OLD.world_id
        OR (OLD.world_id IS NOT NULL AND NEW.world_id IS NULL))
      AND (NEW.campaign_id IS NOT DISTINCT FROM OLD.campaign_id
        OR (OLD.campaign_id IS NOT NULL AND NEW.campaign_id IS NULL))
      AND NEW.reservation_id IS NOT DISTINCT FROM OLD.reservation_id
      AND NEW.operation IS NOT DISTINCT FROM OLD.operation
      AND NEW.request_id IS NOT DISTINCT FROM OLD.request_id
      AND NEW.entry_kind IS NOT DISTINCT FROM OLD.entry_kind
      AND NEW.credits_delta IS NOT DISTINCT FROM OLD.credits_delta
      AND NEW.balance_after IS NOT DISTINCT FROM OLD.balance_after
      AND NEW.provider IS NOT DISTINCT FROM OLD.provider
      AND NEW.model IS NOT DISTINCT FROM OLD.model
      AND NEW.cost_micros IS NOT DISTINCT FROM OLD.cost_micros
      AND NEW.metadata IS NOT DISTINCT FROM OLD.metadata
      AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
      AND (NEW.world_id IS DISTINCT FROM OLD.world_id
        OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id)
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Credit ledger entries are append-only';
  END;
  $$;

  DROP TRIGGER IF EXISTS credit_ledger_append_only ON storyhold.credit_ledger;
  CREATE TRIGGER credit_ledger_append_only
    BEFORE UPDATE OR DELETE ON storyhold.credit_ledger
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_credit_ledger_mutation();

  ALTER TABLE storyhold.ai_usage_ledger
    ADD COLUMN IF NOT EXISTS cached_input_units integer NOT NULL DEFAULT 0
      CHECK (cached_input_units >= 0);
  ALTER TABLE storyhold.ai_usage_ledger
    ADD COLUMN IF NOT EXISTS cache_write_input_units integer NOT NULL DEFAULT 0
      CHECK (cache_write_input_units >= 0);
  ALTER TABLE storyhold.ai_usage_ledger
    ADD COLUMN IF NOT EXISTS reasoning_units integer NOT NULL DEFAULT 0
      CHECK (reasoning_units >= 0);
  ALTER TABLE storyhold.ai_usage_ledger
    ADD COLUMN IF NOT EXISTS pricing_version text NOT NULL DEFAULT '';
  ALTER TABLE storyhold.ai_usage_ledger
    ADD COLUMN IF NOT EXISTS credits_charged integer NOT NULL DEFAULT 0
      CHECK (credits_charged >= 0);
  ALTER TABLE storyhold.ai_usage_ledger
    ADD COLUMN IF NOT EXISTS request_id text NOT NULL DEFAULT '';
`;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function marginBasisPoints(): number {
  const configured = positiveInteger(
    process.env.STORYHOLD_TARGET_GROSS_MARGIN_BPS,
    DEFAULT_TARGET_MARGIN_BPS,
  );
  return Math.min(9_500, Math.max(MINIMUM_TARGET_MARGIN_BPS, configured));
}

function retailMicrosPerCredit(): number {
  return positiveInteger(
    process.env.STORYHOLD_RETAIL_MICROS_PER_CREDIT,
    DEFAULT_RETAIL_MICROS_PER_CREDIT,
  );
}

function providerCostAllowancePerCredit(): number {
  return Math.max(
    1,
    Math.floor(
      (retailMicrosPerCredit() * (10_000 - marginBasisPoints())) / 10_000,
    ),
  );
}

export class CreditEconomyError extends Error {
  constructor(
    public readonly code:
      | "INSUFFICIENT_CREDITS"
      | "UNKNOWN_MODEL_PRICING"
      | "CREDIT_REQUEST_FINALIZED"
      | "CREDIT_RESERVATION_RELEASED"
      | "CREDIT_RESERVATION_RESTORE_INVALID",
    message: string,
    public readonly requiredCredits = 0,
    public readonly availableCredits = 0,
  ) {
    super(message);
    this.name = "CreditEconomyError";
  }
}

export function creditsForProviderCost(costMicros: number): number {
  if (
    typeof costMicros !== "number" ||
    !Number.isFinite(costMicros) ||
    costMicros < 0 ||
    costMicros > Number.MAX_SAFE_INTEGER
  ) {
    throw new CreditEconomyError(
      "UNKNOWN_MODEL_PRICING",
      "Storyhold could not verify a provider cost within the supported accounting range.",
    );
  }
  const normalized = Math.max(0, Math.ceil(costMicros));
  if (normalized === 0) return 0;
  return Math.max(1, Math.ceil(normalized / providerCostAllowancePerCredit()));
}

export function creditsForReservationQuote(
  quote: AiCostReservationQuote | {
    maximumCostMicros: number;
    pricingKnown: boolean;
  },
): number {
  if (!quote.pricingKnown) {
    throw new CreditEconomyError(
      "UNKNOWN_MODEL_PRICING",
      "Storyhold does not have verified pricing for every eligible model.",
    );
  }
  return creditsForProviderCost(quote.maximumCostMicros);
}

export function creditsForUsage(usage: AiUsage): number {
  const numericFields = [
    usage?.inputUnits,
    usage?.outputUnits,
    usage?.cachedInputUnits,
    usage?.cacheWriteInputUnits,
    usage?.reasoningUnits,
    usage?.estimatedCostMicros,
  ];
  if (
    !usage ||
    usage.pricingKnown !== true ||
    typeof usage.pricingVersion !== "string" ||
    usage.pricingVersion.trim().length === 0 ||
    numericFields.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0,
    )
  ) {
    throw new CreditEconomyError(
      "UNKNOWN_MODEL_PRICING",
      "Storyhold could not verify complete provider usage and pricing for this operation.",
    );
  }
  return creditsForProviderCost(usage.estimatedCostMicros);
}

export type CreditReservation = {
  id: string | null;
  playerId: string;
  reservedCredits: number;
  creditsRemaining: number;
  unlimited: boolean;
};

export async function reserveCredits(
  db: CreditDb,
  params: {
    playerId: string;
    worldId?: string | null;
    campaignId?: string | null;
    operation: string;
    requestId: string;
    requiredCredits: number;
    expiresInMinutes?: number;
    metadata?: Record<string, unknown>;
  },
): Promise<CreditReservation> {
  const requiredCredits = Math.max(0, Math.ceil(params.requiredCredits));
  // Reclaim expired holds before evaluating the spendable balance. This keeps
  // a long-running server from requiring a restart before abandoned credits
  // become usable again.
  await releaseExpiredCreditReservations(db, params.playerId);
  return db.transaction(async (tx) => {
    const existingResult = await tx.query<Record<string, unknown>>(
      `SELECT id, player_id, world_id, campaign_id, operation, request_id,
              reserved_credits, actual_credits, status
         FROM storyhold.credit_reservations
        WHERE player_id = $1 AND operation = $2 AND request_id = $3
        LIMIT 1`,
      [params.playerId, params.operation, params.requestId],
    );
    const playerResult = await tx.query<{ role: string; credits: number }>(
      "SELECT role, credits FROM storyhold.players WHERE id = $1 FOR UPDATE",
      [params.playerId],
    );
    const player = playerResult.rows[0];
    if (!player) throw new Error("The player account no longer exists.");
    const existing = existingResult.rows[0];
    if (existing) {
      if (
        existing.status !== "reserved" ||
        existing.player_id !== params.playerId ||
        existing.world_id !== (params.worldId ?? null) ||
        existing.campaign_id !== (params.campaignId ?? null) ||
        existing.operation !== params.operation ||
        existing.request_id !== params.requestId ||
        Number(existing.reserved_credits) !== requiredCredits
      ) {
        throw new CreditEconomyError(
          "CREDIT_REQUEST_FINALIZED",
          "This credit request already exists with different funding or scope.",
        );
      }
      return {
        id: String(existing.id),
        playerId: params.playerId,
        reservedCredits: Number(existing.reserved_credits),
        creditsRemaining: Number(player.credits),
        unlimited: false,
      };
    }
    // A role change cannot discard a hold that was already debited. The
    // existing-reservation branch above always wins; only genuinely new work
    // can use the current owner/admin exemption.
    if (player.role === "owner" || player.role === "admin") {
      return {
        id: null,
        playerId: params.playerId,
        reservedCredits: 0,
        creditsRemaining: Number(player.credits),
        unlimited: true,
      };
    }
    if (Number(player.credits) < requiredCredits) {
      throw new CreditEconomyError(
        "INSUFFICIENT_CREDITS",
        "There are not enough credits available for this operation.",
        requiredCredits,
        Number(player.credits),
      );
    }
    const balance = Number(player.credits) - requiredCredits;
    await tx.query(
      "UPDATE storyhold.players SET credits = $2, updated_at = now() WHERE id = $1",
      [params.playerId, balance],
    );
    const reservationId = randomUUID();
    const expiresInMinutes = Math.min(
      24 * 60,
      Math.max(5, Math.ceil(params.expiresInMinutes ?? 30)),
    );
    await tx.query(
      `INSERT INTO storyhold.credit_reservations
        (id, player_id, world_id, campaign_id, operation, request_id,
         reserved_credits, expires_at, usage)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               now() + ($8::text || ' minutes')::interval, $9::jsonb)`,
      [
        reservationId,
        params.playerId,
        params.worldId ?? null,
        params.campaignId ?? null,
        params.operation,
        params.requestId,
        requiredCredits,
        expiresInMinutes,
        JSON.stringify(params.metadata ?? {}),
      ],
    );
    await tx.query(
      `INSERT INTO storyhold.credit_ledger
        (id, player_id, world_id, campaign_id, reservation_id, operation,
         request_id, entry_kind, credits_delta, balance_after, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserve', $8, $9, $10::jsonb)`,
      [
        randomUUID(),
        params.playerId,
        params.worldId ?? null,
        params.campaignId ?? null,
        reservationId,
        params.operation,
        params.requestId,
        -requiredCredits,
        balance,
        JSON.stringify(params.metadata ?? {}),
      ],
    );
    return {
      id: reservationId,
      playerId: params.playerId,
      reservedCredits: requiredCredits,
      creditsRemaining: balance,
      unlimited: false,
    };
  });
}

/** Reopen the original protected premium hold without reserving or charging again. */
export async function restorePremiumCreditReservation(
  db: CreditDb,
  params: {
    reservationId: string;
    playerId: string;
    worldId: string;
    runId: string;
    reservedCredits: number;
  },
): Promise<CreditReservation> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(params.reservationId)) {
    throw new CreditEconomyError(
      "CREDIT_RESERVATION_RESTORE_INVALID",
      "The original premium credit reservation cannot be restored.",
    );
  }
  return db.transaction(async (tx) => {
    // Match settlement's reservation-then-player lock order. Never sweep expiry:
    // an unfinished provider journal keeps its original hold until reconciled.
    const result = await tx.query<{
      id: string;
      player_id: string;
      world_id: string | null;
      operation: string;
      request_id: string;
      reserved_credits: number;
      status: string;
      usage: Record<string, unknown> | null;
    }>(
      `SELECT id, player_id, world_id, operation, request_id,
              reserved_credits, status, usage
         FROM storyhold.credit_reservations WHERE id = $1 FOR UPDATE`,
      [params.reservationId],
    );
    const reservation = result.rows[0];
    if (
      !reservation ||
      reservation.player_id !== params.playerId ||
      reservation.world_id !== params.worldId ||
      reservation.operation !== "world_analysis" ||
      reservation.request_id !== params.runId ||
      reservation.status !== "reserved" ||
      !Number.isSafeInteger(params.reservedCredits) ||
      params.reservedCredits < 0 ||
      Number(reservation.reserved_credits) !== params.reservedCredits ||
      reservation.usage?.retainUntilReconciled !== true
    ) {
      throw new CreditEconomyError(
        "CREDIT_RESERVATION_RESTORE_INVALID",
        "The original premium credit reservation cannot be restored.",
      );
    }
    const playerResult = await tx.query<{ credits: number }>(
      "SELECT credits FROM storyhold.players WHERE id = $1 FOR UPDATE",
      [params.playerId],
    );
    const player = playerResult.rows[0];
    if (!player) {
      throw new CreditEconomyError(
        "CREDIT_RESERVATION_RESTORE_INVALID",
        "The original premium credit reservation cannot be restored.",
      );
    }
    // Role changes and current affordability cannot change an existing metered
    // commitment: its credits were already removed from this spendable balance.
    return {
      id: reservation.id,
      playerId: reservation.player_id,
      reservedCredits: Number(reservation.reserved_credits),
      creditsRemaining: Number(player.credits),
      unlimited: false,
    };
  });
}

export type CreditSettlement = {
  creditsUsed: number;
  creditsRemaining: number;
  uncoveredCredits: number;
};

export async function settleCreditReservationInTransaction(
  db: CreditQueryDb,
  params: {
    reservationId: string;
    usage: AiUsage;
    provider: StoryholdProviderId | string;
    model: string;
    reasoning: ReasoningLevel;
    /**
     * Premium work must never be finalized with an unpaid remainder. When the
     * actual metered charge exceeds both the estimate held up front and the
     * player's remaining spendable balance, leave the reservation untouched so
     * the exact saved work can resume after a top-up.
     *
     * The default preserves the older generic settlement behavior for callers
     * that deliberately support partially covered usage.
     */
    requireFullPayment?: boolean;
  },
): Promise<CreditSettlement> {
  // Validate the complete metered usage before an idempotent replay can return
  // success. Otherwise a caller could replay a settled hold with a different
  // cost (or unknown pricing) and receive a misleading successful result.
  const requiredCredits = creditsForUsage(params.usage);
  const reservationResult = await db.query<Record<string, unknown>>(
    "SELECT * FROM storyhold.credit_reservations WHERE id = $1 FOR UPDATE",
    [params.reservationId],
  );
  const reservation = reservationResult.rows[0];
  if (!reservation) throw new Error("Credit reservation not found.");
  if (reservation.status === "released") {
    throw new CreditEconomyError(
      "CREDIT_RESERVATION_RELEASED",
      "This credit reservation was already released.",
    );
  }
  const playerResult = await db.query<{ credits: number }>(
    "SELECT credits FROM storyhold.players WHERE id = $1 FOR UPDATE",
    [reservation.player_id],
  );
  const player = playerResult.rows[0];
  if (!player) throw new Error("The player account no longer exists.");
  if (reservation.status === "settled") {
    const storedUsage = reservation.usage as Record<string, unknown> | null;
    const usageFields = [
      "inputUnits",
      "outputUnits",
      "cachedInputUnits",
      "cacheWriteInputUnits",
      "reasoningUnits",
      "estimatedCostMicros",
      "pricingKnown",
      "pricingVersion",
      "costEstimated",
    ] as const;
    const actualCredits = Number(reservation.actual_credits);
    const storedCostMicros = Number(reservation.cost_micros);
    const settlementRows = await db.query<Record<string, unknown>>(
      `SELECT credits_delta, provider, model, cost_micros, metadata
         FROM storyhold.credit_ledger
        WHERE reservation_id = $1 AND entry_kind = 'settle_adjustment'`,
      [params.reservationId],
    );
    const ledger = settlementRows.rows[0];
    const ledgerMetadata = ledger?.metadata as Record<string, unknown> | undefined;
    const uncoveredCredits = Math.max(0, requiredCredits - actualCredits);
    const matches =
      Number.isSafeInteger(actualCredits) &&
      actualCredits >= 0 &&
      actualCredits <= requiredCredits &&
      storedCostMicros === params.usage.estimatedCostMicros &&
      reservation.provider === params.provider &&
      reservation.model === params.model &&
      reservation.reasoning_level === params.reasoning &&
      reservation.pricing_version === params.usage.pricingVersion &&
      Boolean(storedUsage) &&
      usageFields.every((field) => storedUsage?.[field] === params.usage[field]) &&
      settlementRows.rows.length === 1 &&
      Number(ledger?.credits_delta) === Number(reservation.reserved_credits) - actualCredits &&
      ledger?.provider === params.provider &&
      ledger?.model === params.model &&
      Number(ledger?.cost_micros) === params.usage.estimatedCostMicros &&
      Number(ledgerMetadata?.requiredCredits) === requiredCredits &&
      Number(ledgerMetadata?.uncoveredCredits) === uncoveredCredits;
    if (!matches) {
      throw new CreditEconomyError(
        "CREDIT_REQUEST_FINALIZED",
        "This credit request was already settled with different or incomplete accounting.",
      );
    }
    if (params.requireFullPayment && uncoveredCredits > 0) {
      throw new CreditEconomyError(
        "INSUFFICIENT_CREDITS",
        "The completed work costs more credits than this account could settle.",
        requiredCredits,
        actualCredits,
      );
    }
    return {
      creditsUsed: actualCredits,
      creditsRemaining: Number(player.credits),
      uncoveredCredits,
    };
  }
  const reservedCredits = Number(reservation.reserved_credits);
  const maximumCollectible = reservedCredits + Number(player.credits);
  if (params.requireFullPayment && requiredCredits > maximumCollectible) {
    throw new CreditEconomyError(
      "INSUFFICIENT_CREDITS",
      "This work used more credits than the original estimate and the remaining balance cannot cover the difference.",
      requiredCredits,
      maximumCollectible,
    );
  }
  const creditsUsed = Math.min(requiredCredits, maximumCollectible);
  const uncoveredCredits = Math.max(0, requiredCredits - creditsUsed);
  const adjustment = reservedCredits - creditsUsed;
  const balance = Number(player.credits) + adjustment;
  await db.query(
    "UPDATE storyhold.players SET credits = $2, updated_at = now() WHERE id = $1",
    [reservation.player_id, balance],
  );
  await db.query(
    `UPDATE storyhold.credit_reservations
        SET status = 'settled', actual_credits = $2, provider = $3, model = $4,
            reasoning_level = $5, cost_micros = $6, pricing_version = $7,
            usage = $8::jsonb, settled_at = now()
      WHERE id = $1`,
    [
      params.reservationId,
      creditsUsed,
      params.provider,
      params.model,
      params.reasoning,
      params.usage.estimatedCostMicros,
      params.usage.pricingVersion,
      JSON.stringify(params.usage),
    ],
  );
  await db.query(
    `INSERT INTO storyhold.credit_ledger
      (id, player_id, world_id, campaign_id, reservation_id, operation,
       request_id, entry_kind, credits_delta, balance_after, provider, model,
       cost_micros, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'settle_adjustment', $8, $9,
             $10, $11, $12, $13::jsonb)`,
    [
      randomUUID(),
      reservation.player_id,
      reservation.world_id,
      reservation.campaign_id,
      params.reservationId,
      reservation.operation,
      reservation.request_id,
      adjustment,
      balance,
      params.provider,
      params.model,
      params.usage.estimatedCostMicros,
      JSON.stringify({
        pricingVersion: params.usage.pricingVersion,
        reasoning: params.reasoning,
        requiredCredits,
        uncoveredCredits,
      }),
    ],
  );
  return { creditsUsed, creditsRemaining: balance, uncoveredCredits };
}

export async function settleCreditReservation(
  db: CreditDb,
  params: Parameters<typeof settleCreditReservationInTransaction>[1],
): Promise<CreditSettlement> {
  return db.transaction((tx) => settleCreditReservationInTransaction(tx, params));
}

/**
 * Settles a reservation at a product price instead of deriving the charge
 * from provider usage. Storyhold uses this for deliberately priced choices
 * such as rerolls and timeline branches. Provider usage is still retained for
 * margin/accounting telemetry, but it cannot increase the advertised price.
 */
export async function settleFixedCreditReservationInTransaction(
  db: CreditQueryDb,
  params: {
    reservationId: string;
    fixedCredits: number;
    provider: StoryholdProviderId | string;
    model: string;
    reasoning?: ReasoningLevel | null;
    usage?: AiUsage | null;
    metadata?: Record<string, unknown>;
  },
): Promise<CreditSettlement> {
  const fixedCredits = Math.max(0, Math.ceil(params.fixedCredits));
  const reservationResult = await db.query<Record<string, unknown>>(
    "SELECT * FROM storyhold.credit_reservations WHERE id = $1 FOR UPDATE",
    [params.reservationId],
  );
  const reservation = reservationResult.rows[0];
  if (!reservation) throw new Error("Credit reservation not found.");
  if (reservation.status === "released") {
    throw new CreditEconomyError(
      "CREDIT_RESERVATION_RELEASED",
      "This credit reservation was already released.",
    );
  }
  const playerResult = await db.query<{ credits: number }>(
    "SELECT credits FROM storyhold.players WHERE id = $1 FOR UPDATE",
    [reservation.player_id],
  );
  const player = playerResult.rows[0];
  if (!player) throw new Error("The player account no longer exists.");
  if (reservation.status === "settled") {
    if (Number(reservation.actual_credits ?? 0) !== fixedCredits) {
      throw new CreditEconomyError(
        "CREDIT_REQUEST_FINALIZED",
        "This fixed-price credit request was already settled at a different price.",
      );
    }
    return {
      creditsUsed: fixedCredits,
      creditsRemaining: Number(player.credits),
      uncoveredCredits: 0,
    };
  }
  const reservedCredits = Number(reservation.reserved_credits);
  if (reservedCredits < fixedCredits) {
    throw new CreditEconomyError(
      "CREDIT_REQUEST_FINALIZED",
      "The fixed-price credit hold does not cover this operation.",
      fixedCredits,
      reservedCredits,
    );
  }
  const adjustment = reservedCredits - fixedCredits;
  const balance = Number(player.credits) + adjustment;
  const usage = params.usage ?? null;
  await db.query(
    "UPDATE storyhold.players SET credits = $2, updated_at = now() WHERE id = $1",
    [reservation.player_id, balance],
  );
  await db.query(
    `UPDATE storyhold.credit_reservations
        SET status = 'settled', actual_credits = $2, provider = $3, model = $4,
            reasoning_level = $5, cost_micros = $6,
            pricing_version = $7, usage = $8::jsonb, settled_at = now()
      WHERE id = $1`,
    [
      params.reservationId,
      fixedCredits,
      params.provider,
      params.model,
      params.reasoning ?? null,
      usage?.estimatedCostMicros ?? 0,
      usage?.pricingVersion ?? "storyhold-product-v1",
      JSON.stringify(
        usage ?? {
          fixedProductPrice: true,
          ...(params.metadata ?? {}),
        },
      ),
    ],
  );
  await db.query(
    `INSERT INTO storyhold.credit_ledger
      (id, player_id, world_id, campaign_id, reservation_id, operation,
       request_id, entry_kind, credits_delta, balance_after, provider, model,
       cost_micros, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'settle_adjustment', $8, $9,
             $10, $11, $12, $13::jsonb)`,
    [
      randomUUID(),
      reservation.player_id,
      reservation.world_id,
      reservation.campaign_id,
      params.reservationId,
      reservation.operation,
      reservation.request_id,
      adjustment,
      balance,
      params.provider,
      params.model,
      usage?.estimatedCostMicros ?? 0,
      JSON.stringify({
        pricingMode: "fixed_product",
        fixedCredits,
        reasoning: params.reasoning ?? null,
        ...(params.metadata ?? {}),
      }),
    ],
  );
  return {
    creditsUsed: fixedCredits,
    creditsRemaining: balance,
    uncoveredCredits: 0,
  };
}

export async function releaseCreditReservation(
  db: CreditDb,
  reservationId: string | null,
  reason: string,
): Promise<void> {
  if (!reservationId) return;
  await db.transaction(async (tx) => {
    const reservationResult = await tx.query<Record<string, unknown>>(
      "SELECT * FROM storyhold.credit_reservations WHERE id = $1 FOR UPDATE",
      [reservationId],
    );
    const reservation = reservationResult.rows[0];
    if (!reservation || reservation.status !== "reserved") {
      return;
    }
    // Recheck under the reservation lock: a paid call may have started after
    // the expiry sweep selected this row. Uncertain provider work needs explicit
    // reconciliation, never an automatic refund followed by a duplicate retry.
    if (reason === "expired before settlement" &&
      (reservation.usage as Record<string, unknown> | null)?.retainUntilReconciled === true) {
      return;
    }
    // A dossier call can have completed (and cost money) before application or
    // the HTTP response fails. Only its journal-aware settlement/reconciliation
    // may resolve that protected hold; generic catch handlers must not refund it.
    const retainedUsage = reservation.usage as Record<string, unknown> | null;
    if (reservation.operation === "entity_review" && retainedUsage?.retainUntilReconciled === true
      && typeof retainedUsage.entityReviewJournalId === "string" && retainedUsage.entityReviewJournalId.length > 0) {
      return;
    }
    const playerResult = await tx.query<{ credits: number }>(
      `UPDATE storyhold.players
          SET credits = credits + $2, updated_at = now()
        WHERE id = $1
        RETURNING credits`,
      [reservation.player_id, reservation.reserved_credits],
    );
    const balance = Number(playerResult.rows[0]?.credits ?? 0);
    await tx.query(
      `UPDATE storyhold.credit_reservations
          SET status = 'released', released_at = now(), usage = $2::jsonb
        WHERE id = $1`,
      [reservationId, JSON.stringify({ releaseReason: reason.slice(0, 500) })],
    );
    await tx.query(
      `INSERT INTO storyhold.credit_ledger
        (id, player_id, world_id, campaign_id, reservation_id, operation,
         request_id, entry_kind, credits_delta, balance_after, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'release', $8, $9, $10::jsonb)`,
      [
        randomUUID(),
        reservation.player_id,
        reservation.world_id,
        reservation.campaign_id,
        reservationId,
        reservation.operation,
        reservation.request_id,
        Number(reservation.reserved_credits),
        balance,
        JSON.stringify({ releaseReason: reason.slice(0, 500) }),
      ],
    );
  });
}

export async function releaseExpiredCreditReservations(
  db: CreditDb,
  playerId: string | null = null,
): Promise<number> {
  const expired = await db.query<{ id: string }>(
    `SELECT id FROM storyhold.credit_reservations
      WHERE status = 'reserved' AND expires_at <= now()
        AND COALESCE(usage->>'retainUntilReconciled', 'false') <> 'true'
        AND ($1::uuid IS NULL OR player_id = $1)
      ORDER BY created_at ASC`,
    [playerId],
  );
  for (const row of expired.rows) {
    await releaseCreditReservation(db, row.id, "expired before settlement");
  }
  return expired.rows.length;
}
