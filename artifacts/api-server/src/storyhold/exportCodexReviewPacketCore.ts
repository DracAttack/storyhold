import { createHash } from "node:crypto";

/**
 * Positional result order for the exporter's one parallel read batch. Keep the
 * names beside a runtime arity check so inserting a query cannot silently shift
 * every dataset after it or discard the final result.
 */
export const CODEX_REVIEW_PACKET_QUERY_RESULT_KEYS = [
  "chapterSummaries",
  "clockEvents",
  "eventParticipants",
  "entities",
  "dossiers",
  "dossierContributions",
  "relations",
  "memberships",
  "rules",
  "entityActions",
  "claims",
  "mentions",
  "coreferenceMentions",
  "qualityFindings",
  "breakdowns",
  "characterDrafts",
  "cohesionProposals",
  "discrepancyReports",
  "canonAmendments",
  "canonIntegritySignals",
  "playerCanonIntegrity",
  "analysisRuns",
  "analysisCoverage",
  "aiUsage",
  "account",
  "creditReservations",
  "creditLedger",
  "canonicalCharacters",
  "campaigns",
  "worldStateEvents",
  "vaultMemories",
] as const;

type CodexReviewPacketQueryResultKey =
  (typeof CODEX_REVIEW_PACKET_QUERY_RESULT_KEYS)[number];

export function bindCodexReviewPacketQueryResults<Row>(
  results: readonly Row[][],
): Record<CodexReviewPacketQueryResultKey, Row[]> {
  if (results.length !== CODEX_REVIEW_PACKET_QUERY_RESULT_KEYS.length) {
    throw new Error(
      `Codex review packet query-result drift: expected ${CODEX_REVIEW_PACKET_QUERY_RESULT_KEYS.length} datasets, received ${results.length}.`,
    );
  }
  return Object.fromEntries(
    CODEX_REVIEW_PACKET_QUERY_RESULT_KEYS.map((key, index) => [key, results[index]!]),
  ) as Record<CodexReviewPacketQueryResultKey, Row[]>;
}

/**
 * Convert database values into a deterministic, JSON-safe representation.
 * Object keys are sorted recursively; array order remains meaningful and must
 * therefore be made deterministic by each export query's ORDER BY clause.
 */
export function normalizeReviewPacketValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeReviewPacketValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeReviewPacketValue(entry)]),
    );
  }
  return value;
}

export function stableReviewPacketJson(value: unknown): string {
  return JSON.stringify(normalizeReviewPacketValue(value));
}

export function reviewPacketFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(stableReviewPacketJson(value))
    .digest("hex");
}

export function fingerprintedRowSet(rows: unknown[]) {
  return {
    rowCount: rows.length,
    fingerprint: reviewPacketFingerprint(rows),
  };
}
