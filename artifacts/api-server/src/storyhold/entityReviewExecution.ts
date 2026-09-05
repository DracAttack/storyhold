import type { PGlite } from "@electric-sql/pglite";
import type { JsonObject } from "./analysisVerificationContracts";
import type { AiTextResult } from "./aiGateway";
import {
  lockEntityReviewCallForFinalization, type EntityReviewCallScope,
} from "./entityReviewJournal";
import { settleEntityReviewAccountingInTransaction } from "./entityReviewAccounting";

type Db = Pick<PGlite, "query" | "transaction">;
type QueryDb = Pick<PGlite, "query" | "exec">;

export class EntityReviewStaleCanonError extends Error {
  constructor() {
    super("Your canon or source material changed while this review was running. The older response was not applied.");
    this.name = "EntityReviewStaleCanonError";
  }
}

/** Canon application, usage accounting and the replayable HTTP result commit
 * together. A transient save failure leaves the paid response available for
 * resume; a proven stale snapshot records a known-cost non-application. */
export async function finishJournaledEntityReview(db: Db, params: {
  scope: EntityReviewCallScope;
  apply: (tx: QueryDb, context: JsonObject, result: AiTextResult) => Promise<JsonObject>;
}): Promise<JsonObject> {
  try {
    return await db.transaction(async (tx) => {
      const row = await lockEntityReviewCallForFinalization(tx, params.scope);
      if (row.finalization_snapshot) return row.finalization_snapshot;
      if (row.status === "rejected") {
        return settleEntityReviewAccountingInTransaction(tx, {
          scope: params.scope, outcome: "not_applied",
          response: { error: "The review did not pass Storyhold's evidence checks. No generated dossier update was applied." },
        });
      }
      if (row.status !== "completed" || !row.result_snapshot) {
        throw new Error("This review's provider outcome needs to be checked before it can continue.");
      }
      const response = await params.apply(tx, row.context_snapshot, row.result_snapshot);
      return settleEntityReviewAccountingInTransaction(tx, { scope: params.scope, outcome: "applied", response });
    });
  } catch (error) {
    if (!(error instanceof EntityReviewStaleCanonError)) throw error;
    return db.transaction(async (tx) => settleEntityReviewAccountingInTransaction(tx, {
      scope: params.scope, outcome: "not_applied", response: { error: error.message },
    }));
  }
}
