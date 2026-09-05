export type ReconciliationClaimStatus = "extracted" | "reconciled";

export type ReconciliationClaim = {
  id: string;
  claim: string;
  evidence: string;
  familyId: string | null;
  embedding: number[] | null;
  status: ReconciliationClaimStatus;
};

export type PlannedReconciliationPair = {
  a: ReconciliationClaim;
  b: ReconciliationClaim;
  similarity: number;
  sameFamily: boolean;
};

function cosine(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

/**
 * Plan only work that involves at least one newly extracted claim. Previously
 * reconciled claims remain useful comparison partners, but old-to-old pairs do
 * not need another paid review.
 */
export function planClaimReconciliation(
  claims: ReconciliationClaim[],
  similarityThreshold: number,
): { pendingIds: string[]; pairs: PlannedReconciliationPair[] } {
  const pendingIds = claims.filter((claim) => claim.status === "extracted").map((claim) => claim.id);
  const pairs: PlannedReconciliationPair[] = [];

  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      const a = claims[i]!;
      const b = claims[j]!;
      if (a.status !== "extracted" && b.status !== "extracted") continue;
      const similarity = cosine(a.embedding, b.embedding);
      if (similarity < similarityThreshold) continue;
      pairs.push({
        a,
        b,
        similarity,
        sameFamily: Boolean(a.familyId && a.familyId === b.familyId),
      });
    }
  }

  return { pendingIds, pairs };
}
