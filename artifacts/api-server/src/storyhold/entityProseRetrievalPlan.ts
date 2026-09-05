import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import type { EntityExistingProseItem } from "./entityExistingProseReview";
import { retrievalTokens } from "./lorekeeperRetrieval";
import type { AnalysisChunk } from "./worldAnalysis";

export type EntityProseRetrievalLead = {
  item: EntityExistingProseItem;
  reviewId: string;
  requests: string[];
  previousChunks: AnalysisChunk[];
};
export type EntityProseRetrievalStatus = "added" | "already_selected" | "previously_reviewed" | "no_match" | "budget_deferred";
export type EntityProseRetrievalPlan = {
  /** Additional complete manuscript chunks only. Retrieval is a lead, not proof. */
  chunks: AnalysisChunk[];
  items: Array<{ itemId: string; status: EntityProseRetrievalStatus; matchedChunkIds: string[]; matchedChunkCount: number; selectedChunkIds: string[] }>;
  searchedChunkCount: number;
  addedChunkCount: number;
  budgetDeferredItems: number;
};
export const ENTITY_PROSE_RETRIEVAL_LIMITS = {
  focused: { chunks: 8, bytes: 64_000 },
  full: { chunks: 16, bytes: 128_000 },
} as const;
const GENERIC = new Set([
  "a", "an", "all", "any", "are", "as", "at", "be", "been", "being", "by", "can", "did", "do", "does", "each", "had", "has", "he", "him", "himself", "herself", "myself", "yourself", "ourselves", "themselves", "someone", "anyone", "everyone", "if", "in", "is", "it", "itself", "may", "not", "of", "on", "or", "she", "so", "than", "to", "until", "was", "we", "were", "who", "will", "yet",
  "find", "search", "look", "locate", "retrieve", "retrieval", "identify", "check", "confirm", "verify", "review", "determine", "clarify", "explain", "show", "shows", "showing", "establish", "establishes", "established", "support", "supports", "supported", "prove", "proof",
  "evidence", "passage", "passages", "source", "sources", "manuscript", "manuscripts", "chapter", "chapters", "page", "pages", "book", "books", "text", "texts", "paragraph", "paragraphs", "sentence", "sentences", "material", "context", "detail", "details", "item", "items", "dossier", "story", "storyhold", "wording", "claim", "claims", "information", "additional", "more", "missing", "specific", "relevant", "exact", "complete", "entire", "whether", "about", "other", "earlier", "later", "previous", "next", "first", "last", "please",
  "http", "https", "www", "com", "org", "net", "url", "website", "websites", "internet", "online", "visit", "browse", "open", "ignore", "instructions", "instruction",
]);
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
const searchTokens = (value: string) => [...new Set(retrievalTokens(value).map((token) => token.replace(/['’]s$/u, "")))];
const fingerprint = (value: unknown) => canonPayloadFingerprint(value as JsonObject);
function fail(message: string): never { throw new Error(`Dossier prose retrieval: ${message}`); }
function ordered(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function identity(chunk: AnalysisChunk): string { return fingerprint({ id: chunk.id, sourceId: chunk.sourceId, index: chunk.index, content: chunk.content }); }
function reviewedIdentity(chunk: AnalysisChunk): string { return fingerprint({ id: chunk.id, sourceId: chunk.sourceId, content: chunk.content }); }
function checkedChunk(chunk: AnalysisChunk): void {
  if (!chunk || typeof chunk.id !== "string" || !chunk.id || typeof chunk.sourceId !== "string" || !chunk.sourceId
    || typeof chunk.content !== "string" || !Number.isSafeInteger(chunk.index) || chunk.index < 0) fail("a manuscript chunk has invalid identity or text.");
}
function uniqueChunks(chunks: readonly AnalysisChunk[]): Map<string, AnalysisChunk> {
  const rows = new Map<string, AnalysisChunk>();
  for (const chunk of chunks) {
    checkedChunk(chunk);
    const previous = rows.get(chunk.id);
    if (previous && identity(previous) !== identity(chunk)) fail("one chunk ID has conflicting current content or source provenance.");
    if (!previous) rows.set(chunk.id, chunk);
  }
  return rows;
}
function labelPattern(label: string): RegExp {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u");
}
type Ranked = { chunk: AnalysisChunk; key: string; reviewedKey: string; tokens: Set<string>; normalized: string; bytes: number; targetMatch: boolean };
type Match = { candidate: Ranked; score: number };
type WorkItem = { lead: EntityProseRetrievalLead; matches: Match[]; eligible: Match[]; chosen: Ranked[]; contextIds: Set<string>; priorIdentities: Set<string> };

/** Deterministic lexical retrieval across the already-authorized corpus. No
 * embeddings, runtime models, database access, network access or canon writes.
 * Matching improves recall for the next verifier; it never validates a claim. */
export function planEntityProseRetrieval(params: {
  leads: EntityProseRetrievalLead[];
  chunks: AnalysisChunk[];
  selectedChunks: AnalysisChunk[];
  target: { name: string; aliases: string[] };
  depth: "focused" | "full";
}): EntityProseRetrievalPlan {
  const limits = ENTITY_PROSE_RETRIEVAL_LIMITS[params.depth];
  if (!limits) fail("the review depth is unsupported.");
  const corpus = uniqueChunks(params.chunks);
  const selected = uniqueChunks(params.selectedChunks);
  for (const [id, chunk] of selected) if (corpus.has(id) && identity(corpus.get(id)!) !== identity(chunk)) fail("the selected source context differs from the current manuscript corpus.");
  const labels = [...new Set([params.target.name, ...params.target.aliases].map(normalize).filter(Boolean))];
  const targetPatterns = labels.map(labelPattern);
  const targetTokens = new Set(labels.flatMap(searchTokens));
  const candidates: Ranked[] = [...corpus.values()]
    .sort((left, right) => ordered(left.sourceId, right.sourceId) || left.index - right.index || ordered(left.id, right.id))
    .map((chunk) => {
      const normalized = normalize(chunk.content);
      return { chunk, key: identity(chunk), reviewedKey: reviewedIdentity(chunk), tokens: new Set(searchTokens(chunk.content)), normalized,
        targetMatch: targetPatterns.some((pattern) => pattern.test(normalized)), bytes: Buffer.byteLength(JSON.stringify(chunk), "utf8") };
    });
  const byPosition = new Map<string, Ranked>();
  const frequency = new Map<string, number>();
  for (const candidate of candidates) {
    const position = `${candidate.chunk.sourceId}\u0000${candidate.chunk.index}`;
    if (byPosition.has(position)) fail("two current chunks occupy the same source position.");
    byPosition.set(position, candidate);
    for (const token of candidate.tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  const leadIds = new Map<string, string>();
  const work: WorkItem[] = [];
  for (const lead of params.leads) {
    if (!lead?.item || typeof lead.item.itemId !== "string" || !lead.item.itemId || typeof lead.item.text !== "string"
      || !Array.isArray(lead.requests) || lead.requests.some((request) => typeof request !== "string") || !Array.isArray(lead.previousChunks)) fail("an unresolved display-slot lead is invalid.");
    const leadFingerprint = fingerprint(lead);
    if (leadIds.has(lead.item.itemId)) {
      if (leadIds.get(lead.item.itemId) !== leadFingerprint) fail("one display-slot ID has conflicting unresolved review histories.");
      continue;
    }
    leadIds.set(lead.item.itemId, leadFingerprint);
    // A slot may have been reviewed against several historic revisions of one
    // chunk. All exact versions count as already read, not just the latest ID.
    const priorIdentities = new Set(lead.previousChunks.map((chunk) => { checkedChunk(chunk); return reviewedIdentity(chunk); }));
    const meaningful = (value: string) => searchTokens(value).filter((term) => !GENERIC.has(term) && !targetTokens.has(term));
    const queryWeights = new Map<string, number>();
    for (const term of meaningful(lead.item.text)) queryWeights.set(term, 1);
    for (const request of lead.requests) for (const term of meaningful(request)) queryWeights.set(term, 1.6);
    // Nicknames are themselves useful search phrases even when already listed
    // as aliases. The canonical name by itself is never a sufficient match.
    const aliasPhrase = lead.item.field === "aliases" && normalize(lead.item.text) !== normalize(params.target.name)
      && normalize(lead.item.text).length >= 2 ? normalize(lead.item.text) : "";
    const aliasPattern = aliasPhrase ? labelPattern(aliasPhrase) : null;
    const matches = candidates.flatMap((candidate): Match[] => {
      let score = 0;
      for (const [term, weight] of queryWeights) if (candidate.tokens.has(term)) score += weight * (1 + Math.log((candidates.length + 1) / ((frequency.get(term) ?? 0) + 1)));
      if (aliasPattern?.test(candidate.normalized)) score += 5;
      if (!score) return [];
      if (candidate.targetMatch) score += 0.75;
      return [{ candidate, score }];
    }).sort((left, right) => right.score - left.score || ordered(left.candidate.chunk.sourceId, right.candidate.chunk.sourceId)
      || left.candidate.chunk.index - right.candidate.chunk.index || ordered(left.candidate.chunk.id, right.candidate.chunk.id));
    const eligible = matches.filter(({ candidate }) => !selected.has(candidate.chunk.id) && !priorIdentities.has(candidate.reviewedKey));
    work.push({ lead, matches, eligible, chosen: [], contextIds: new Set(), priorIdentities });
  }
  const added = new Map<string, Ranked>();
  let usedBytes = 0;
  function add(candidate: Ranked): boolean {
    if (selected.has(candidate.chunk.id) || added.has(candidate.chunk.id)) return true;
    if (added.size >= limits.chunks || usedBytes + candidate.bytes > limits.bytes) return false;
    added.set(candidate.chunk.id, candidate); usedBytes += candidate.bytes;
    return true;
  }
  // One seed per unresolved item before anyone receives a second seed. Within
  // close-scoring matches, a second source offers useful chapter/book spread.
  for (let round = 0; round < 2; round++) for (const item of work) {
    const considered = item.eligible.filter(({ candidate }) => !item.chosen.some((chosen) => chosen.chunk.id === candidate.chunk.id));
    const sources = new Set(item.chosen.map((candidate) => candidate.chunk.sourceId));
    const ranked = considered.map((match, rank) => ({ match, rank })).sort((left, right) => {
      const leftScore = left.match.score + (sources.size && !sources.has(left.match.candidate.chunk.sourceId) ? 0.6 : 0);
      const rightScore = right.match.score + (sources.size && !sources.has(right.match.candidate.chunk.sourceId) ? 0.6 : 0);
      return rightScore - leftScore || left.rank - right.rank;
    });
    for (const { match } of ranked) if (add(match.candidate)) { item.chosen.push(match.candidate); break; }
  }
  // Add adjacent manuscript context only after seed coverage, and never cross
  // a source boundary or spend the byte budget on an already-reviewed neighbor.
  for (let offsetIndex = 0; offsetIndex < 2; offsetIndex++) for (let seedIndex = 0; seedIndex < 2; seedIndex++) for (const item of work) {
    const seed = item.chosen[seedIndex]; if (!seed) continue;
    const offset = offsetIndex === 0 ? -1 : 1;
    const neighbor = byPosition.get(`${seed.chunk.sourceId}\u0000${seed.chunk.index + offset}`);
    if (!neighbor) continue;
    if (!selected.has(neighbor.chunk.id) && !added.has(neighbor.chunk.id) && item.priorIdentities.has(neighbor.reviewedKey)) continue;
    if (add(neighbor)) item.contextIds.add(neighbor.chunk.id);
  }
  const items = work.map((item) => {
    const selectedIds = item.matches.filter(({ candidate }) => selected.has(candidate.chunk.id) || added.has(candidate.chunk.id)).map(({ candidate }) => candidate.chunk.id);
    const selectedChunkIds = [...new Set([...selectedIds, ...item.contextIds])];
    const hasAdded = item.eligible.some(({ candidate }) => added.has(candidate.chunk.id));
    const status: EntityProseRetrievalStatus = hasAdded ? "added" : item.eligible.length ? "budget_deferred"
      : selectedChunkIds.length ? "already_selected" : item.matches.length ? "previously_reviewed" : "no_match";
    return { itemId: item.lead.item.itemId, status, matchedChunkIds: item.matches.slice(0, 8).map(({ candidate }) => candidate.chunk.id),
      matchedChunkCount: item.matches.length, selectedChunkIds };
  });
  return { chunks: [...added.values()].map((candidate) => structuredClone(candidate.chunk)), items,
    searchedChunkCount: candidates.length, addedChunkCount: added.size,
    budgetDeferredItems: items.filter((item) => item.status === "budget_deferred").length };
}
