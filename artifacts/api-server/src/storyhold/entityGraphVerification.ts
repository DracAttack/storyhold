import { canonPayloadFingerprint, type AnalysisProposal, type JsonObject } from "./analysisVerificationContracts";
import {
  assertPremiumGraphReceipt, buildPremiumGraphRequest, canProjectCurrentFactionMembership,
  graphFromPremiumReceipts, premiumGraphInstructions, validatePremiumGraphResponse,
  type PremiumGraphRequest, type PremiumGraphReviewReceipt, type PremiumGraphVerifier,
} from "./premiumGraphVerification";
import { assertPremiumRelationSemantics, type CohesionFinding, type EntityRelationFinding, type EntityRuleFinding } from "./worldAnalysis";
import type { EntityReviewFinding, EntityReviewInput } from "./entityReview";
import { prepareEntityReviewPages } from "./entityReviewPages";

export const MAX_ENTITY_GRAPH_CANDIDATES = 12;
export const MAX_ENTITY_GRAPH_DISCOVERIES = 4;
export type EntityGraphContext = {
  version: 1 | 2;
  relations: EntityRelationFinding[];
  rules: EntityRuleFinding[];
  entities: Array<{ id: string; name: string; entityType: string; aliases: string[] }>;
  page?: { index: number; count: number; stepKey: string; candidateKeys: string[]; inventoryFingerprint: string };
};
type Input = EntityReviewInput & { graphReview?: EntityGraphContext };
type Entity = EntityGraphContext["entities"][number];
const CATEGORIES = new Set(["character", "creature", "species", "place", "faction", "institution", "government", "power_structure",
  "technology", "vehicle", "device", "weapon", "power", "title", "cultural_reference", "term", "ambiguous"]);
const ROOT_ARRAYS = new Set(["aliases", "details", "relationships", "evidence", "relations", "rules", "entityRelations", "entityRules", "statVerifications"]);
const CHARACTER_ARRAYS = new Set(["aliases", "traits", "motivations", "fears", "capabilities", "history", "origins", "powers", "moralSystem",
  "physicalCharacteristics", "relationships", "relationshipWeb", "knowledge", "secrets", "factionMemberships", "evidence"]);
const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
const nameKey = (value: string) => normalized(value).toLocaleLowerCase();
function fail(message: string): never { throw new Error(`Dossier graph verification: ${message}`); }
function hash(value: unknown): string { return canonPayloadFingerprint(value as JsonObject); }
// PostgreSQL JSONB reorders object keys. Context strings inside the shared
// request must retain the same bytes after a durable journal round trip.
function contextJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, maximum = 240): string {
  if (typeof value !== "string" || !normalized(value) || normalized(value).length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be a bounded nonempty string.`);
  }
  return normalized(value);
}
function identity(input: Input): { context: EntityGraphContext; target: Entity; resolve: (name: unknown) => Entity } {
  const context = input.graphReview;
  if (!context || ![1, 2].includes(context.version) || !Array.isArray(context.entities) || !Array.isArray(context.relations) || !Array.isArray(context.rules)) {
    fail("the frozen graph context is invalid.");
  }
  if (context.version === 1 && context.page !== undefined) fail("legacy graph context cannot contain page metadata.");
  if (!input.premiumStatScope) fail("an exact premium world, edition and review scope is required.");
  for (const key of ["worldId", "editionId", "analysisRunId"] as const) text(input.premiumStatScope[key], key);
  if (input.depth !== "focused" && input.depth !== "full") fail("the review depth is invalid.");
  const byId = new Map<string, Entity>();
  const byName = new Map<string, Entity | null>();
  for (const supplied of context.entities) {
    const entry = object(supplied, "canonical entity");
    const id = text(entry.id, "canonical entity ID");
    const name = text(entry.name, "canonical entity name");
    const entityType = text(entry.entityType, "canonical entity category");
    if (!CATEGORIES.has(entityType)) fail("an unknown canonical entity category was supplied.");
    if (byId.has(id) || !Array.isArray(entry.aliases)) fail("canonical IDs must be unique and aliases explicit arrays.");
    const aliases = entry.aliases.map((alias) => text(alias, "canonical alias"));
    const entity: Entity = { id, name, entityType, aliases };
    byId.set(id, entity);
    for (const label of [name, ...aliases]) {
      const key = nameKey(label);
      const previous = byName.get(key);
      byName.set(key, previous === undefined || previous?.id === id ? entity : null);
    }
  }
  const resolve = (name: unknown): Entity => {
    const value = byName.get(nameKey(text(name, "graph endpoint")));
    if (!value) fail("a graph endpoint is missing or ambiguous in the frozen canonical map.");
    return value;
  };
  const target = byId.get(text(input.entity.id, "reviewed entity ID"));
  if (!target || target.name !== normalized(input.entity.name) || target.entityType !== input.entity.entityType || resolve(target.name).id !== target.id) {
    fail("the reviewed entity does not match its fixed canonical identity and category.");
  }
  return { context, target, resolve };
}
function assertTargets(input: Input, proposals: readonly AnalysisProposal[]): void {
  const { target, resolve } = identity(input);
  for (const proposal of proposals) {
    const payload = proposal.payload;
    if (proposal.kind === "relation") {
      const subject = resolve(payload.subject); const other = resolve(payload.target);
      if (subject.id === other.id || (subject.id !== target.id && other.id !== target.id)) {
        fail("every relation must connect the reviewed canonical entity to a different known entity.");
      }
    } else if (proposal.kind === "rule") {
      if (resolve(payload.entity).id !== target.id) fail("every rule must belong to the reviewed canonical entity.");
    } else fail("only declared relations and rules are permitted in a dossier graph review.");
  }
}

/** This adapts the existing graph contract to a fixed dossier; it neither runs
 * another model nor expands a dossier review into a whole-world review. */
export function buildEntityGraphRequest(input: Input): PremiumGraphRequest | undefined {
  if (input.graphReview === undefined) return undefined;
  const { context, target } = identity(input);
  const page = context.page;
  if (context.version === 2 && (!page || !Number.isSafeInteger(page.index) || !Number.isSafeInteger(page.count)
    || page.index < 0 || page.count < 1 || page.count > 1_024 || page.index >= page.count || page.stepKey !== `dossier_graph:${page.index}`
    || !Array.isArray(page.candidateKeys) || page.candidateKeys.length > MAX_ENTITY_GRAPH_CANDIDATES
    || typeof page.inventoryFingerprint !== "string" || !/^canon_payload_[a-f0-9]{64}$/u.test(page.inventoryFingerprint))) {
    fail("version 2 requires exact derived page metadata; prepare the complete review before dispatch.");
  }
  const request = buildPremiumGraphRequest({ scope: input.premiumStatScope!, stepKey: page?.stepKey ?? "dossier_graph:0",
    chunks: input.chunks.map((chunk) => ({ id: chunk.id, sourceId: chunk.sourceId, text: chunk.content })),
    relations: context.relations, rules: context.rules,
    context: {
      existingCanonContext: contextJson({ version: context.version, entityId: target.id, entityName: target.name, entityType: target.entityType,
        reviewDepth: input.depth, canonicalEntities: context.entities, worldName: input.worldName, worldPremise: input.worldPremise,
        worldGenre: input.worldGenre, dossierContextFingerprint: hash({ entity: input.entity, knownEntities: input.knownEntities,
          currentCharacter: input.currentCharacter ?? null }),
        maximumCandidates: MAX_ENTITY_GRAPH_CANDIDATES, maximumDiscoveries: MAX_ENTITY_GRAPH_DISCOVERIES,
        ...(context.version === 2 ? { page } : {}) }),
      userGuidance: contextJson({ authorGuidance: input.userGuidance ?? "", ownerCanonConstraints: input.ownerCanonConstraints ?? [] }),
      externalReferenceContext: contextJson({ conceptResolutionContext: input.conceptResolutionContext ?? "", browserAuditContext: input.browserAuditContext ?? "" }),
    },
  });
  // The shared builder deduplicates complete semantic payloads; no slice hides
  // an unreviewed candidate after the provider has already been paid.
  if (request.proposals.length > MAX_ENTITY_GRAPH_CANDIDATES) fail(`the review exceeds ${MAX_ENTITY_GRAPH_CANDIDATES} distinct graph candidates; narrow the review before dispatch.`);
  if (page && hash(page.candidateKeys) !== hash(request.proposals.map((proposal) => `${proposal.kind}:${hash(proposal.payload)}`).sort())) {
    fail("the graph page does not contain its exact assigned candidate inventory.");
  }
  assertTargets(input, request.proposals);
  return request;
}
export function entityGraphInstructions(input: Input): string {
  const request = buildEntityGraphRequest(input);
  if (!request) return "";
  const scope = input.graphReview?.version === 2
    ? `This is page ${input.graphReview.page!.index + 1} of ${input.graphReview.page!.count} in one frozen dossier review. Review every candidate assigned here; candidates on other pages still receive their own decisions. Up to four new findings may correct assigned candidates or record exact-source omissions; do not invent filler. ${input.graphReview.page!.index === 0 ? "This first provider call also supplies the dossier and both stat groups." : "This continuation is graph-only: do not return dossier prose, aliases, character data or stat estimates/groups."}`
    : "This graph review shares the SAME single provider call and JSON response as the dossier and stat review.";
  return `DOSSIER GRAPH OVERRIDE: ${scope} It supersedes earlier relationship schemas. Return relations:[], rules:[], entityRelations:[], entityRules:[] exactly. Root relationships and character.relationships, character.relationshipWeb and character.factionMemberships must be absent or empty arrays. Do not return undeclared graph arrays or bypass this contract in another relationship field. Storyhold projects these displays only from verified graph decisions.
All candidate and discovered payloads, even rejected or uncertain ones, must concern the exact reviewed canonical entity: relations must touch it and rules must belong to it. Use only unambiguous names or aliases from the frozen map below. Never invent or merge identities. There are at most ${MAX_ENTITY_GRAPH_CANDIDATES} candidates and at most ${MAX_ENTITY_GRAPH_DISCOVERIES} newFindings TOTAL, counting every verdict. Keep summaries and explanations concise; do not fill the discovery allowance with weak guesses. Preserve direction, status, time boundaries and conditional behavior.
<DOSSIER_GRAPH_SCOPE trust="unverified">${request.context.existingCanonContext.replace(/&/gu, "\\u0026").replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e")}</DOSSIER_GRAPH_SCOPE>
${premiumGraphInstructions(request)}`;
}
function assertRawBoundary(response: Record<string, unknown>, allowProseClaims = false): void {
  for (const [key, value] of Object.entries(response)) if (Array.isArray(value) && !ROOT_ARRAYS.has(key)
    && !(allowProseClaims && key === "claims")) fail(`undeclared response array ${key}.`);
  const empty = (record: Record<string, unknown>, key: string, required = false) => {
    if (!required && record[key] === undefined) return;
    if (!Array.isArray(record[key]) || record[key].length !== 0) fail(`${key} must be an empty array; use graphVerification.`);
  };
  for (const key of ["relations", "rules", "entityRelations", "entityRules"]) empty(response, key, true);
  for (const key of ["relationships", "relationshipWeb", "factionMemberships"]) empty(response, key);
  if (response.character !== undefined && response.character !== null) {
    const character = object(response.character, "character");
    for (const [key, value] of Object.entries(character)) if (Array.isArray(value) && !CHARACTER_ARRAYS.has(key)) fail(`undeclared character array ${key}.`);
    for (const key of ["relationships", "relationshipWeb", "factionMemberships"]) empty(character, key);
  }
  const review = object(response.graphVerification, "graphVerification");
  if (!Array.isArray(review.newFindings) || review.newFindings.length > MAX_ENTITY_GRAPH_DISCOVERIES) {
    fail(`newFindings must contain at most ${MAX_ENTITY_GRAPH_DISCOVERIES} discoveries, without truncation.`);
  }
}
function assertReceiptTargetsAndSemantics(input: Input, receipt: PremiumGraphReviewReceipt): void {
  assertTargets(input, receipt.packet.proposals);
  const original = new Set(receipt.request.proposals.map((proposal) => proposal.id));
  if (receipt.packet.proposals.filter((proposal) => !original.has(proposal.id)).length > MAX_ENTITY_GRAPH_DISCOVERIES) fail("the saved receipt exceeds the discovery capacity.");
  const proposals = new Map(receipt.packet.proposals.map((proposal) => [proposal.id, proposal]));
  const anchors = new Map(receipt.packet.evidence.map((anchor) => [anchor.id, anchor]));
  for (const decision of receipt.decisions) {
    const proposal = proposals.get(decision.proposalId)!;
    if (decision.verdict !== "verified" || proposal.kind !== "relation") continue;
    assertPremiumRelationSemantics({ ...proposal.payload as unknown as EntityRelationFinding,
      confidence: decision.confidence, reviewStatus: "verified",
      evidence: decision.supportingEvidenceIds.map((id) => {
        const anchor = anchors.get(id)!;
        return { chunkId: anchor.chunkId, sourceId: anchor.sourceId, quote: anchor.quote };
      }),
    }, receipt.request.chunks);
  }
}
export function validateEntityGraphReview(input: Input, raw: unknown, verifier: PremiumGraphVerifier): PremiumGraphReviewReceipt | undefined {
  const request = buildEntityGraphRequest(input);
  if (!request) return undefined;
  const response = object(raw, "dossier response");
  assertRawBoundary(response, Boolean(input.proseReview) && input.graphReview?.page?.index === 0);
  const receipt = validatePremiumGraphResponse(request, response, verifier);
  assertReceiptTargetsAndSemantics(input, receipt);
  return receipt;
}
export function assertEntityGraphReview(input: Input, receipt: PremiumGraphReviewReceipt | undefined): void {
  const request = buildEntityGraphRequest(input);
  if (!request) {
    if (receipt !== undefined) fail("legacy saved input cannot acquire a modern graph receipt.");
    return;
  }
  if (!receipt) fail("the modern dossier review is missing its graph receipt.");
  assertPremiumGraphReceipt(receipt);
  if (hash(request) !== hash(receipt.request)) fail("the graph receipt belongs to different sources, scope, identities or owner instructions.");
  assertReceiptTargetsAndSemantics(input, receipt);
}

/** Final canon requires complete frozen coverage, not whichever paid pages
 * happened to finish first. Singular validation remains useful during a run. */
export function assertEntityGraphReviews(input: Input, receipts: readonly PremiumGraphReviewReceipt[]): void {
  if (!Array.isArray(receipts)) fail("the complete graph receipt inventory must be an array.");
  if (input.graphReview?.version !== 2) {
    if (receipts.length !== (input.graphReview ? 1 : 0)) fail("the legacy graph receipt inventory is incomplete.");
    assertEntityGraphReview(input, receipts[0]);
    return;
  }
  const plan = prepareEntityReviewPages(input);
  if (receipts.length !== plan.pages.length) fail("every frozen dossier graph page must complete before projection.");
  for (const [index, page] of plan.pages.entries()) assertEntityGraphReview(page.input, receipts[index]);
}

/** A repeated exact payload cannot become canon by selecting only its favorable
 * page. Every decision remains in the audit; disagreements are explicit. */
export function dossierGraphConflicts(receipts: readonly PremiumGraphReviewReceipt[]): {
  blockedPayloadFingerprints: Set<string>; conflicts: CohesionFinding[];
} {
  const groups = new Map<string, { payloadFingerprint: string; kind: string; payload: JsonObject;
    verdicts: Set<string>; evidence: EntityRelationFinding["evidence"] }>();
  const steps = new Set<string>(); let scope = "";
  for (const receipt of receipts) {
    assertPremiumGraphReceipt(receipt);
    const nextScope = hash(receipt.request.scope);
    if ((scope && scope !== nextScope) || steps.has(receipt.request.stepKey)) fail("cross-page verdicts require one scope and unique page steps.");
    scope = nextScope; steps.add(receipt.request.stepKey);
    const proposals = new Map(receipt.packet.proposals.map((proposal) => [proposal.id, proposal]));
    const anchors = new Map(receipt.packet.evidence.map((anchor) => [anchor.id, anchor]));
    for (const decision of receipt.decisions) {
      const proposal = proposals.get(decision.proposalId)!;
      const payloadFingerprint = hash(proposal.payload);
      const key = `${proposal.kind}:${payloadFingerprint}`;
      const group = groups.get(key) ?? { payloadFingerprint, kind: proposal.kind, payload: proposal.payload, verdicts: new Set<string>(), evidence: [] };
      group.verdicts.add(decision.verdict);
      for (const id of [...decision.supportingEvidenceIds, ...decision.contradictingEvidenceIds]) {
        const anchor = anchors.get(id)!;
        group.evidence.push({ chunkId: anchor.chunkId, sourceId: anchor.sourceId, quote: anchor.quote });
      }
      groups.set(key, group);
    }
  }
  const blockedPayloadFingerprints = new Set<string>(); const conflicts: CohesionFinding[] = [];
  for (const [, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    if (!group.verdicts.has("verified") || group.verdicts.size === 1) continue;
    blockedPayloadFingerprints.add(group.payloadFingerprint);
    const label = group.kind === "relation"
      ? `${String(group.payload.subject)} — ${String(group.payload.relationType).replace(/_/gu, " ")} — ${String(group.payload.target)}`
      : `${String(group.payload.entity)}: ${String(group.payload.name)}`;
    conflicts.push({ kind: "contradiction", severity: "conflict", subject: label,
      summary: `The review pages disagree about ${label}. One accepts this exact interpretation; another does not establish it. This proposed update was withheld and existing canon was left unchanged.`,
      evidence: [...new Map(group.evidence.map((anchor) => [hash(anchor), anchor])).entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, anchor]) => anchor) });
  }
  return { blockedPayloadFingerprints, conflicts };
}
const LABELS: Record<EntityRelationFinding["relationType"], [string, string]> = {
  member_of: ["Member Of", "Has Member"], participates_in: ["Participates In", "Has Participant"], species_of: ["Species", "Species Of"],
  subspecies_of: ["Subspecies Of", "Has Subspecies"], subtype_of: ["Subtype Of", "Has Subtype"], lifecycle_stage_of: ["Life Stage Of", "Has Life Stage"],
  has_power: ["Has Power", "Power Of"], has_form: ["Has Form", "Form Of"], holds_title: ["Holds Title", "Title Held By"],
  child_of: ["Child Of", "Parent Of"], sibling_of: ["Sibling Of", "Sibling Of"], spouse_of: ["Spouse Of", "Spouse Of"],
  friend_of: ["Friend Of", "Friend Of"], best_friend_of: ["Best Friend Of", "Best Friend Of"], leads: ["Leads", "Led By"], governs: ["Governs", "Governed By"],
  controlled_by: ["Controlled By", "Controls"], allied_with: ["Allied With", "Allied With"], opposed_to: ["Opposed To", "Opposed To"],
  located_in: ["Located In", "Location Of"], part_of: ["Part Of", "Includes"], created_by: ["Created By", "Creator Of"], related_to: ["Connected To", "Connected To"],
};
function label(relation: EntityRelationFinding, incoming: boolean): string {
  const status = relation.status === "active" ? "" : `${relation.status[0]!.toUpperCase()}${relation.status.slice(1)}: `;
  const period = [relation.validFromLabel ? `From ${relation.validFromLabel}` : "", relation.validUntilLabel ? `Until ${relation.validUntilLabel}` : ""].filter(Boolean).join("; ");
  return `${status}${LABELS[relation.relationType][incoming ? 1 : 0]}${period ? ` (${period})` : ""}`;
}
/** Derived display fields contain only the approved graph. The immutable
 * receipt retains rejected alternatives and conflicting rules for audit. */
export function projectEntityReviewedGraph(input: Input, finding: EntityReviewFinding, receipt: PremiumGraphReviewReceipt | undefined): EntityReviewFinding {
  assertEntityGraphReview(input, receipt);
  if (!receipt) return structuredClone(finding);
  return projectGraph(input, finding, graphFromPremiumReceipts([receipt]));
}

export function projectEntityReviewedGraphs(input: Input, finding: EntityReviewFinding, receipts: readonly PremiumGraphReviewReceipt[]): EntityReviewFinding {
  assertEntityGraphReviews(input, receipts);
  if (!receipts.length) return structuredClone(finding);
  const blocked = input.graphReview?.version === 2 ? dossierGraphConflicts(receipts).blockedPayloadFingerprints : undefined;
  return projectGraph(input, finding, graphFromPremiumReceipts(receipts, { excludedPayloadFingerprints: blocked }));
}
function projectGraph(input: Input, finding: EntityReviewFinding, graph: ReturnType<typeof graphFromPremiumReceipts>): EntityReviewFinding {
  const output = structuredClone(finding);
  const { target, resolve } = identity(input);
  output.relations = graph.entityRelations;
  output.rules = graph.entityRules;
  output.relationships = graph.entityRelations.map((relation) => `${relation.subject} — ${label(relation, false)} — ${relation.target}. ${relation.summary}`);
  if (output.character) {
    if (target.entityType !== "character" || normalized(output.character.name) !== target.name) fail("graph projection cannot manufacture or rename a character.");
    output.character.relationships = [...output.relationships];
    output.character.relationshipWeb = graph.entityRelations.map((relation) => {
      const incoming = resolve(relation.target).id === target.id;
      return { name: resolve(incoming ? relation.subject : relation.target).name, relationship: label(relation, incoming),
        summary: relation.summary, sentiment: "unknown" as const, evidence: structuredClone(relation.evidence) };
    });
    output.character.factionMemberships = [...new Set(graph.entityRelations.flatMap((relation) => {
      const source = resolve(relation.subject); const destination = resolve(relation.target);
      return source.id === target.id && canProjectCurrentFactionMembership(relation, destination.entityType, source.entityType) ? [destination.name] : [];
    }))];
  }
  return output;
}
