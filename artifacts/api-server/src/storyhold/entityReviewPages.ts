import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import { buildPremiumGraphRequest } from "./premiumGraphVerification";
import { buildEntityGraphRequest, MAX_ENTITY_GRAPH_CANDIDATES } from "./entityGraphVerification";
import type { EntityReviewInput } from "./entityReview";
import type { EntityRelationFinding, EntityRuleFinding, EvidenceReference } from "./worldAnalysis";

export const MAX_ENTITY_REVIEW_PAGES = 1_024;
export const MAX_ENTITY_REVIEW_PAGE_CANDIDATE_BYTES = 64_000;
export type EntityReviewPage = {
  index: number; count: number; stepKey: string; candidateKeys: string[]; inventoryFingerprint: string; input: EntityReviewInput;
};
export type EntityReviewPagePlan = { version: 2; fingerprint: string; pages: EntityReviewPage[] };
type Candidate = { key: string; kind: "relation" | "rule"; value: EntityRelationFinding | EntityRuleFinding };
const hash = (value: unknown) => canonPayloadFingerprint(value as JsonObject);
function fail(message: string): never { throw new Error(`Dossier review pages: ${message}`); }
function evidenceKey(value: EvidenceReference): string { return hash({ chunkId: value.chunkId, sourceId: value.sourceId, quote: value.quote }); }
function candidateEnvelope(candidates: Candidate[]): { relations: EntityRelationFinding[]; rules: EntityRuleFinding[] } {
  return { relations: candidates.filter((candidate) => candidate.kind === "relation").map((candidate) => candidate.value as EntityRelationFinding),
    rules: candidates.filter((candidate) => candidate.kind === "rule").map((candidate) => candidate.value as EntityRuleFinding) };
}

/** Normalize with the real contract, merging exact semantic duplicates without
 * discarding their distinct support. Small preparation batches avoid the
 * provider contract's single-call array bound becoming a whole-dossier limit. */
function inventory(input: EntityReviewInput): Candidate[] {
  const graph = input.graphReview;
  if (!graph || graph.version !== 2 || graph.page !== undefined || !input.premiumStatScope
    || !Array.isArray(graph.relations) || !Array.isArray(graph.rules)) fail("an unpaged version-2 dossier and exact premium scope are required.");
  const supplied = [...graph.relations.map((value) => ({ kind: "relation" as const, value })), ...graph.rules.map((value) => ({ kind: "rule" as const, value }))];
  const found = new Map<string, Candidate>();
  for (let start = 0; start < supplied.length; start += 400) {
    const batch = supplied.slice(start, start + 400);
    const request = buildPremiumGraphRequest({ scope: input.premiumStatScope, stepKey: "dossier_graph:inventory",
      chunks: input.chunks.map((chunk) => ({ id: chunk.id, sourceId: chunk.sourceId, text: chunk.content })),
      relations: batch.filter((item) => item.kind === "relation").map((item) => item.value as EntityRelationFinding),
      rules: batch.filter((item) => item.kind === "rule").map((item) => item.value as EntityRuleFinding), context: {} });
    const anchors = new Map(request.evidence.map((anchor) => [anchor.id, anchor]));
    for (const proposal of request.proposals) {
      const kind = proposal.kind as "relation" | "rule";
      const key = `${kind}:${hash(proposal.payload)}`;
      const previous = found.get(key);
      const support = proposal.evidenceIds.map((id) => {
        const anchor = anchors.get(id)!; return { chunkId: anchor.chunkId, sourceId: anchor.sourceId, quote: anchor.quote };
      });
      const evidence = [...new Map([...(previous?.value.evidence ?? []), ...support].map((anchor) => [evidenceKey(anchor), anchor])).entries()]
        .sort(([left], [right]) => left.localeCompare(right)).map(([, anchor]) => anchor);
      found.set(key, { key, kind, value: { ...proposal.payload, confidence: Math.max(previous?.value.confidence ?? 0, proposal.confidence),
        evidence, reviewStatus: "candidate" } as EntityRelationFinding | EntityRuleFinding });
    }
  }
  return [...found.values()].sort((left, right) => left.key.localeCompare(right.key));
}

/** Freeze complete candidate coverage before any quote or provider call. The
 * first page keeps dossier/stat work; subsequent inputs are graph continuations. */
export function prepareEntityReviewPages(input: EntityReviewInput): EntityReviewPagePlan {
  const candidates = inventory(input);
  const canonicalInput: EntityReviewInput = { ...structuredClone(input), graphReview: {
    ...structuredClone(input.graphReview!), ...candidateEnvelope(candidates),
  } };
  const inventoryFingerprint = hash({ version: 2, input: canonicalInput });
  const groups: Candidate[][] = [];
  let current: Candidate[] = [];
  for (const candidate of candidates) {
    if (Buffer.byteLength(JSON.stringify(candidateEnvelope([candidate])), "utf8") > MAX_ENTITY_REVIEW_PAGE_CANDIDATE_BYTES) {
      fail("one complete graph candidate exceeds the page byte bound; its evidence cannot be truncated.");
    }
    const proposed = [...current, candidate];
    if (proposed.length > MAX_ENTITY_GRAPH_CANDIDATES || Buffer.byteLength(JSON.stringify(candidateEnvelope(proposed)), "utf8") > MAX_ENTITY_REVIEW_PAGE_CANDIDATE_BYTES) {
      groups.push(current); current = [candidate];
    } else current = proposed;
  }
  if (current.length || !groups.length) groups.push(current);
  if (groups.length > MAX_ENTITY_REVIEW_PAGES) fail(`the review exceeds the ${MAX_ENTITY_REVIEW_PAGES}-page safety bound; no candidate was truncated.`);
  const pages = groups.map((group, index): EntityReviewPage => {
    const page = { index, count: groups.length, stepKey: `dossier_graph:${index}`, candidateKeys: group.map((candidate) => candidate.key), inventoryFingerprint };
    const pageInput: EntityReviewInput = { ...structuredClone(input), graphReview: {
      ...structuredClone(input.graphReview!), ...candidateEnvelope(group), page,
    } };
    // Validate every category, fixed endpoint and request boundary now, not
    // after paying for the earlier pages of a malformed inventory.
    buildEntityGraphRequest(pageInput);
    return { ...page, input: pageInput };
  });
  return { version: 2, fingerprint: hash({ version: 2, inventoryFingerprint, pages }), pages };
}
