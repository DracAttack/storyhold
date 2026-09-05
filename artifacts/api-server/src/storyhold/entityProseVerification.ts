import { buildVerifiedPromotionPlan, canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import {
  assertPremiumClaimReceipt, buildPremiumClaimRequest, premiumClaimInstructions, validatePremiumClaimResponse,
  type PremiumClaimPayload, type PremiumClaimRequest, type PremiumClaimReviewReceipt, type PremiumClaimVerifier,
} from "./premiumClaimVerification";
import { premiumNeutralStats } from "./premiumStatCandidates";
import type { EntityReviewFinding, EntityReviewInput } from "./entityReview";
import type { CharacterFinding, EvidenceReference } from "./worldAnalysis";

export type EntityProseReviewContext = { version: 1 };
export const ENTITY_PROSE_FIELDS = ["aliases", "summary", "details", "role", "traits", "motivations", "fears", "capabilities",
  "history", "origins", "powers", "moralSystem", "physicalCharacteristics", "knowledge", "secrets"] as const;
export type EntityProseField = typeof ENTITY_PROSE_FIELDS[number];
export type EntityProseItem = { proposalId: string; field: EntityProseField; value: string; text: string;
  claim: PremiumClaimPayload; evidence: EvidenceReference[]; confidence: number };
export type EntityProseProjection = EntityProseItem[];
export type EntityProseReviewReceipt = { version: 1; claimReceipt: PremiumClaimReviewReceipt; displayOrder: string[];
  projection: EntityProseProjection; fingerprint: string };
type Input = EntityReviewInput & { proseReview?: EntityProseReviewContext };
const ROOT_FIELDS = new Set<EntityProseField>(["aliases", "summary", "details"]);
const CHARACTER_LIST_FIELDS = ["traits", "motivations", "fears", "capabilities", "history", "origins", "powers", "moralSystem",
  "physicalCharacteristics", "knowledge", "secrets"] as const;
const hash = (value: unknown) => canonPayloadFingerprint(value as JsonObject);
const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
const nameKey = (value: string) => normalized(value).toLocaleLowerCase();
function fail(message: string): never { throw new Error(`Dossier prose verification: ${message}`); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function capacity(input: Input): number { return input.depth === "full" ? 40 : 24; }
function identity(input: Input) {
  if (input.proseReview?.version !== 1 || Object.keys(input.proseReview).length !== 1 || !input.premiumStatScope
    || !input.entity.id || !input.entity.name || !input.entity.entityType || !input.graphReview?.entities) fail("the frozen target, scope, and prose contract are required.");
  const entities = input.graphReview.entities;
  const targets = entities.filter((entity) => entity.id === input.entity.id);
  if (targets.length !== 1 || targets[0]!.name !== input.entity.name || targets[0]!.entityType !== input.entity.entityType
    || new Set(entities.map((entity) => entity.id)).size !== entities.length) fail("the fixed canonical target does not match its registry.");
  const resolve = (surface: string) => entities.filter((entity) => [entity.name, ...entity.aliases].some((alias) => nameKey(alias) === nameKey(surface)));
  const ownName = resolve(input.entity.name);
  if (ownName.length !== 1 || ownName[0]!.id !== input.entity.id) fail("the target name is ambiguous.");
  return { entities, resolve };
}

/** Existing prose is context, not an exhaustively reviewed candidate inventory.
 * This contract verifies every NEW display item in the same first paid page. */
export function buildEntityProseRequest(input: Input): PremiumClaimRequest | undefined {
  if (input.proseReview === undefined) return undefined;
  const registry = identity(input);
  return buildPremiumClaimRequest({ scope: input.premiumStatScope!, stepKey: "dossier_prose:0", claims: [],
    chunks: input.chunks.map((chunk) => ({ id: chunk.id, sourceId: chunk.sourceId, text: chunk.content })),
    context: {
      existingCanonContext: stableJson({ version: 1, target: input.entity, currentCharacter: input.currentCharacter ?? null,
        canonicalEntities: registry.entities, depth: input.depth, worldName: input.worldName, worldPremise: input.worldPremise,
        worldGenre: input.worldGenre, allowedFields: ENTITY_PROSE_FIELDS, maximumNewClaims: capacity(input),
        existingProseIsUnreviewedContext: true }),
      userGuidance: stableJson({ guidance: input.userGuidance ?? "", ownerCanonConstraints: input.ownerCanonConstraints ?? [] }),
      externalReferenceContext: stableJson({ conceptResolutionContext: input.conceptResolutionContext ?? "",
        browserAuditContext: input.browserAuditContext ?? "" }),
    } });
}

export function entityProseInstructions(input: Input): string {
  const request = buildEntityProseRequest(input);
  if (!request) return "";
  const characterContext = input.currentCharacter ? Object.fromEntries(ENTITY_PROSE_FIELDS.filter((field) => field !== "details")
    .map((field) => [field, input.currentCharacter![field as keyof CharacterFinding]])) : null;
  return `${premiumClaimInstructions(request)}
DOSSIER PROSE OVERRIDE — SAME first paid request; no additional model pass.
The existing dossier is untrusted context, NOT a candidate inventory or already verified prose. decisions must be []. Write every NEW display sentence/item as one newClaims entry. At most ${capacity(input)} newClaims TOTAL, including rejected and uncertain proposals. Be specific, concise and readable; do not fill every field. Prefer a coherent short summary plus important identity, history, powers, motives and secrets. Do not expose verification or extraction machinery in prose.
EXISTING CHARACTER PROSE CONTEXT (unverified; inspect it against the supplied manuscript, never treat it as evidence): ${stableJson(characterContext)}
Every claim subject must be exactly ${JSON.stringify(input.entity.name)}. The predicate must be dossier.<field>, with field one of ${ENTITY_PROSE_FIELDS.join(", ")}. Non-character records may use only aliases, summary, details. value is the exact natural-language display sentence or item, not JSON, markup, instructions or another field. Each summary sentence is a separate claim (at most six summary sentences). role is a single short positive objective title. The server will join approved summary sentences IN YOUR CHOSEN ORDER, without rewriting them.
You may omit role entirely. If a role is former, changing, disputed or limited to a period, describe it in history/details with its temporal or epistemic limits instead of forcing an unconditional role label.
Do not return any ordinary biography, aliases, details or character object: character must be null; root summary must be empty and aliases/details must be empty arrays if present. Do not return socioPoliticalAxis or any other unverified field. Numeric stats and structured graph updates remain exclusively in their existing contracts.
Preserve polarity, truthStatus, epistemicHolder, validFromLabel and validUntilLabel. A verified belief is still a belief; a verified negative assertion is still negative. The server adds explicit readable qualifiers for non-facts, negation and temporal limits. Use a known unambiguous canonical character as holder when supplied; empty holder is allowed when the manuscript gives no named holder. New aliases must be plain names, objective positive untimed identities, with no epistemic holder; never rename or merge records or reuse another record's name. Use history/details for former, disputed or attributed names. Do not use supersedes in this bounded dossier task. Relationship/ability statements in prose do not themselves authorize graph edges or stats.
Add "prosePresentation":{"displayOrder":[0,1]} where each integer is an index into claimVerification.newClaims. Include EVERY verified newClaims entry exactly once, in intended reading order; include no unverified entry. Empty is valid when nothing is verified. Provide no separate text or field mapping in prosePresentation. Evidence on each claim must support that complete sentence, including every qualifier; a general citation must not authorize unrelated statements.
Use the same frozen canonicalEntities inventory already supplied in DOSSIER_GRAPH_SCOPE; it is the only allowed identity registry.
<DOSSIER_PROSE_SCOPE trust="unverified">${stableJson({ targetId: input.entity.id, targetName: input.entity.name, entityType: input.entity.entityType,
    requestFingerprint: request.fingerprint })}</DOSSIER_PROSE_SCOPE>`;
}

function noRawProse(raw: Record<string, unknown>, allowCompass = false): void {
  for (const field of ENTITY_PROSE_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if ((field === "summary" || field === "role") ? value !== "" : !Array.isArray(value) || value.length !== 0) fail(`raw ${field} must be empty; display text requires its own claim decision.`);
  }
  if (raw.character !== undefined && raw.character !== null) fail("raw character fields are forbidden; character must be null.");
  const allowed = new Set(["aliases", "summary", "details", "relationships", "evidence", "confidence", "estimatedStats", "character",
    "relations", "rules", "entityRelations", "entityRules", "graphVerification", "statVerifications", "claims", "claimVerification", "prosePresentation"]);
  if (allowCompass) allowed.add("compassVerification");
  if (Object.keys(raw).some((key) => !allowed.has(key))) fail("the response contains an undeclared prose or alternate output field.");
  if (raw.evidence !== undefined && (!Array.isArray(raw.evidence) || raw.evidence.length !== 0)) fail("root evidence cannot replace claim-level citations.");
  if (raw.estimatedStats !== undefined && raw.estimatedStats !== null) fail("raw numeric estimates are forbidden.");
}

function claimField(input: Input, claim: PremiumClaimPayload): EntityProseField {
  const registry = identity(input);
  if (claim.subject !== normalized(input.entity.name)) fail("every prose claim must belong to the exact fixed target.");
  if (!claim.predicate.startsWith("dossier.")) fail("the claim predicate is not a dossier field.");
  const field = claim.predicate.slice("dossier.".length) as EntityProseField;
  if (!ENTITY_PROSE_FIELDS.includes(field) || (input.entity.entityType !== "character" && !ROOT_FIELDS.has(field))) fail("the claim uses an unsupported dossier field for this category.");
  if (claim.supersedes) fail("dossier prose cannot supersede another canonical claim.");
  if (claim.epistemicHolder) {
    const holders = registry.resolve(claim.epistemicHolder);
    if (holders.length !== 1 || !["character", "creature"].includes(holders[0]!.entityType)) fail("the claim holder must be an unambiguous known character or creature.");
  }
  const maximum = field === "aliases" ? 120 : field === "role" ? 240 : field === "summary" ? 600 : 500;
  if (claim.value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(claim.value)) fail("a display item exceeds its field bound.");
  if (field === "aliases" || field === "role") {
    if (claim.polarity !== "positive" || claim.truthStatus !== "fact" || claim.epistemicHolder || claim.validFromLabel || claim.validUntilLabel) fail("aliases and roles must be positive, objective, untimed facts; use narrative fields for qualified assertions.");
  }
  if (field === "aliases") {
    if (!/^[\p{L}\p{N}][\p{L}\p{M}\p{N} .’'_-]*$/u.test(claim.value)) fail("an alias must be a safe plain name.");
    if (registry.resolve(claim.value).some((entity) => entity.id !== input.entity.id)) fail("a new alias cannot merge or collide with another canonical identity.");
  }
  return field;
}

function displayText(claim: PremiumClaimPayload): string {
  let value = claim.value;
  if (claim.polarity === "negative") value = `It is not true that ${value}`;
  switch (claim.truthStatus) {
    case "belief": value = claim.epistemicHolder ? `${claim.epistemicHolder} believes: ${value}` : `One belief in the story holds: ${value}`; break;
    case "rumor": value = claim.epistemicHolder ? `${claim.epistemicHolder} has heard a rumor: ${value}` : `Rumor holds: ${value}`; break;
    case "lie": value = claim.epistemicHolder ? `${claim.epistemicHolder} falsely claims: ${value}` : `A false claim circulates: ${value}`; break;
    case "disputed": value = claim.epistemicHolder ? `${claim.epistemicHolder}'s disputed account: ${value}` : `This remains disputed: ${value}`; break;
    case "unknown": value = claim.epistemicHolder ? `${claim.epistemicHolder}'s uncertain account: ${value}` : `This remains uncertain: ${value}`; break;
    case "fact": if (claim.epistemicHolder) value = `${claim.epistemicHolder} knows: ${value}`; break;
  }
  if (claim.validFromLabel && claim.validUntilLabel) value = `From ${claim.validFromLabel} until ${claim.validUntilLabel}: ${value}`;
  else if (claim.validFromLabel) value = `From ${claim.validFromLabel}: ${value}`;
  else if (claim.validUntilLabel) value = `Until ${claim.validUntilLabel}: ${value}`;
  return value;
}

function makeReceipt(input: Input, claimReceipt: PremiumClaimReviewReceipt, displayOrder: string[]): EntityProseReviewReceipt {
  assertPremiumClaimReceipt(claimReceipt);
  if (hash(claimReceipt.request) !== hash(buildEntityProseRequest(input))) fail("the claim review differs from its frozen dossier request.");
  if (claimReceipt.request.proposals.length || claimReceipt.packet.proposals.length > capacity(input)) fail("the claim inventory exceeds its complete first-page bound.");
  for (const proposal of claimReceipt.packet.proposals) claimField(input, proposal.payload as unknown as PremiumClaimPayload);
  const approved = buildVerifiedPromotionPlan(claimReceipt.packet, claimReceipt.decisions, claimReceipt.batch);
  const approvedById = new Map(approved.map((entry) => [entry.proposal.id, entry]));
  if (!Array.isArray(displayOrder) || displayOrder.length !== approved.length || new Set(displayOrder).size !== displayOrder.length
    || displayOrder.some((id) => !approvedById.has(id))) fail("display order must cover every verified claim exactly once and nothing else.");
  const anchors = new Map(claimReceipt.packet.evidence.map((anchor) => [anchor.id, anchor]));
  const projection = displayOrder.map((id): EntityProseItem => {
    const entry = approvedById.get(id)!; const claim = structuredClone(entry.payload) as unknown as PremiumClaimPayload;
    return { proposalId: id, field: claimField(input, claim), value: claim.value, text: displayText(claim), claim,
      confidence: entry.decision.confidence, evidence: entry.decision.supportingEvidenceIds.map((anchorId) => {
        const anchor = anchors.get(anchorId)!; return { chunkId: anchor.chunkId, sourceId: anchor.sourceId, quote: anchor.quote };
      }) };
  });
  if (projection.filter((item) => item.field === "summary").length > 6 || projection.filter((item) => item.field === "role").length > 1) fail("summary allows at most six ordered statements and role allows one.");
  const summary = projection.filter((item) => item.field === "summary").map((item) => item.text).join(" ");
  if (summary.length > 4_000 || projection.some((item) => !["summary", "aliases", "role"].includes(item.field) && item.text.length > 500)) fail("qualified display text exceeds the persistence field bound; it cannot be truncated.");
  const body = { version: 1 as const, claimReceipt: structuredClone(claimReceipt), displayOrder: [...displayOrder], projection };
  return freeze({ ...body, fingerprint: hash({ namespace: "storyhold:dossier-prose-receipt:v1", ...body }) });
}

export function validateEntityProseReview(input: Input, value: unknown, verifier: PremiumClaimVerifier): EntityProseReviewReceipt | undefined {
  const request = buildEntityProseRequest(input); if (!request) return undefined;
  const raw = object(value, "response"); noRawProse(raw, input.compassReview?.version === 1);
  const review = object(raw.claimVerification, "claimVerification");
  if (!Array.isArray(review.newClaims) || review.newClaims.length > capacity(input)) fail(`at most ${capacity(input)} new claims are allowed; no output is silently dropped.`);
  const presentation = object(raw.prosePresentation, "prosePresentation");
  if (Object.keys(presentation).join(",") !== "displayOrder" || !Array.isArray(presentation.displayOrder)) fail("prosePresentation requires only displayOrder.");
  const claimReceipt = validatePremiumClaimResponse(request, raw, verifier);
  const proposals = new Map(claimReceipt.packet.proposals.map((proposal) => [hash(proposal.payload), proposal.id]));
  const ids = review.newClaims.map((entry) => {
    const claim = object(object(entry, "new claim").claim, "claim");
    // The shared parser normalizes strings; use the exact normalized payload to
    // resolve the original response order to immutable proposal identifiers.
    const normalizedPayload = Object.fromEntries(Object.entries(claim).map(([key, child]) => [key, typeof child === "string" ? normalized(child) : child]));
    const id = proposals.get(hash(normalizedPayload)); if (!id) fail("the display item does not match its verified payload."); return id;
  });
  const order = presentation.displayOrder.map((index) => {
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= ids.length) fail("display order references an absent new claim.");
    return ids[index]!;
  });
  return makeReceipt(input, claimReceipt, order);
}

export function assertEntityProseReview(input: Input, receipt: EntityProseReviewReceipt | undefined): void {
  if (input.proseReview === undefined) { if (receipt !== undefined) fail("a legacy saved review cannot gain prose authority."); return; }
  if (!receipt || receipt.version !== 1) fail("the explicit prose receipt is missing.");
  const rebuilt = makeReceipt(input, receipt.claimReceipt, receipt.displayOrder);
  if (hash(rebuilt) !== hash(receipt)) fail("the prose receipt, ordered text, or evidence has changed.");
}

function blankCharacter(input: Input): CharacterFinding {
  return { name: input.entity.name, aliases: [], summary: "", role: "", traits: [], motivations: [], fears: [], capabilities: [], history: [], origins: [],
    powers: [], moralSystem: [], physicalCharacteristics: [], knowledge: [], secrets: [], relationships: [], relationshipWeb: [], factionMemberships: [],
    evidence: [], confidence: 0, estimatedStats: premiumNeutralStats(), socioPoliticalAxis: input.currentCharacter?.socioPoliticalAxis
      ? structuredClone(input.currentCharacter.socioPoliticalAxis) : { economic: 0, authority: 0, label: "Undetermined", rationale: "", confidence: 0 } };
}

/** Exact proof projection only. Existing graph/stat fields are preserved; no
 * unapproved legacy biography, alias or political estimate passes through. */
export function projectEntityReviewedProse(input: Input, finding: EntityReviewFinding, receipt: EntityProseReviewReceipt | undefined,
  options?: { includedProposalIds?: ReadonlySet<string> }): EntityReviewFinding {
  assertEntityProseReview(input, receipt);
  if (!receipt) return structuredClone(finding);
  const allIds = new Set(receipt.displayOrder);
  if (options?.includedProposalIds && [...options.includedProposalIds].some((id) => !allIds.has(id))) fail("canonical display selection contains an unapproved claim.");
  const items = receipt.projection.filter((item) => !options?.includedProposalIds || options.includedProposalIds.has(item.proposalId));
  const values = (field: EntityProseField) => items.filter((item) => item.field === field).map((item) => item.text);
  const result = structuredClone(finding);
  result.aliases = values("aliases"); result.summary = values("summary").join(" "); result.details = values("details");
  result.evidence = [...new Map(items.flatMap((item) => item.evidence).map((anchor) => [hash(anchor), structuredClone(anchor)])).values()];
  result.confidence = items.length ? Math.max(...items.map((item) => item.confidence)) : 0;
  if (input.entity.entityType === "character") {
    const character = result.character ?? blankCharacter(input);
    character.name = input.entity.name; character.aliases = [...result.aliases]; character.summary = result.summary; character.role = values("role")[0] ?? "";
    for (const field of CHARACTER_LIST_FIELDS) character[field] = values(field);
    character.evidence = structuredClone(result.evidence); character.confidence = result.confidence;
    // Socio-political estimates are deliberately not part of this textual claim
    // contract. Preserve the old value, never the unverified returned axis.
    character.socioPoliticalAxis = blankCharacter(input).socioPoliticalAxis;
    result.character = character;
  } else result.character = null;
  return result;
}

/** Compare only the prose boundary, independently of graph/stat projection. */
export function entityProseFields(finding: EntityReviewFinding) {
  return { aliases: finding.aliases, summary: finding.summary, details: finding.details,
    character: finding.character ? Object.fromEntries(["name", ...ENTITY_PROSE_FIELDS.filter((field) => field !== "details"), "socioPoliticalAxis"]
      .map((field) => [field, finding.character![field as keyof CharacterFinding]])) : null };
}
