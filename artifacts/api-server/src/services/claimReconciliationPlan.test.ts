import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planClaimReconciliation,
  type ReconciliationClaim,
} from "./claimReconciliationPlan";

function claim(
  id: string,
  status: ReconciliationClaim["status"],
  embedding: number[] | null,
  familyId: string | null = null,
): ReconciliationClaim {
  return { id, status, embedding, familyId, claim: `claim ${id}`, evidence: `evidence ${id}` };
}

test("an isolated new claim is pending even when it has no candidate pair", () => {
  const plan = planClaimReconciliation([claim("new", "extracted", [1, 0])], 0.8);
  assert.deepEqual(plan.pendingIds, ["new"]);
  assert.deepEqual(plan.pairs, []);
});

test("already reconciled claims are not compared with each other again", () => {
  const plan = planClaimReconciliation(
    [
      claim("old-a", "reconciled", [1, 0]),
      claim("old-b", "reconciled", [1, 0]),
      claim("new", "extracted", [1, 0]),
    ],
    0.8,
  );

  assert.deepEqual(
    plan.pairs.map(({ a, b }) => [a.id, b.id]),
    [["old-a", "new"], ["old-b", "new"]],
  );
});

test("a new claim with no similar partner can finish without an AI call", () => {
  const plan = planClaimReconciliation(
    [claim("old", "reconciled", [0, 1]), claim("new", "extracted", [1, 0])],
    0.8,
  );
  assert.deepEqual(plan.pendingIds, ["new"]);
  assert.equal(plan.pairs.length, 0);
});

test("same-family pairs remain deterministic", () => {
  const plan = planClaimReconciliation(
    [
      claim("old", "reconciled", [1, 0], "family-1"),
      claim("new", "extracted", [1, 0], "family-1"),
    ],
    0.8,
  );
  assert.equal(plan.pairs.length, 1);
  assert.equal(plan.pairs[0]!.sameFamily, true);
});
