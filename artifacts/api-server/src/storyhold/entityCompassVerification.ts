import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import type { EntityReviewInput } from "./entityReview";
import type { PremiumClaimVerifier } from "./premiumClaimVerification";

/** Compass numbers are interpretive estimates, never objective canon claims. */
export type EntityCompassReviewContext = { version: 1; currentEstimate: unknown; ownerOverride: unknown | null };
export type EntityCompassPerspective = "demonstrated_behavior" | "self_description" | "others_interpretation" | "mixed";
export type EntityCompassEstimate = {
  economic: number; authority: number; label: string; rationale: string;
  validFromLabel: string; validUntilLabel: string;
  perspective: EntityCompassPerspective; epistemicHolderId: string | null;
};
export type EntityCompassEvidence = {
  chunkId: string; sourceId: string; quote: string;
  axes: Array<"economic" | "authority">;
  perspective: Exclude<EntityCompassPerspective, "mixed">;
};
export type EntityCompassVerdict = "supported" | "needs_more_evidence" | "disputed" | "rejected";
export type EntityCompassDecision = {
  verdict: EntityCompassVerdict; estimate: EntityCompassEstimate | null;
  explanation: string; confidence: number;
  supportingEvidence: EntityCompassEvidence[]; contradictingEvidence: EntityCompassEvidence[];
  retrievalRequests: string[];
};
export type EntityCompassRequest = {
  version: 1; stepKey: "dossier_compass:0";
  scope: { worldId: string; editionId: string; reviewId: string; entityId: string };
  target: { id: string; name: string; entityType: "character" };
  chunks: Array<{ id: string; sourceId: string; text: string }>;
  context: {
    depth: "focused" | "full"; worldName: string; worldPremise: string; worldGenre: string;
    canonicalEntities: Array<{ id: string; name: string; entityType: string; aliases: string[] }>;
    userGuidance: string; ownerCanonConstraints: Array<{ id: string; kind: string; instruction: string }>;
    conceptResolutionContext: string; browserAuditContext: string;
    currentEstimate: unknown; ownerOverride: unknown | null;
  };
  fingerprint: string;
};
export type EntityCompassReviewReceipt = {
  version: 1; request: EntityCompassRequest; decision: EntityCompassDecision;
  verifier: PremiumClaimVerifier; fingerprint: string;
};
export type EntityCompassApprovedEstimate = EntityCompassEstimate & { confidence: number; evidence: EntityCompassEvidence[] };
type Input = EntityReviewInput & { compassReview?: EntityCompassReviewContext };
const PERSPECTIVES = ["demonstrated_behavior", "self_description", "others_interpretation", "mixed"] as const;
const VERDICTS = ["supported", "needs_more_evidence", "disputed", "rejected"] as const;
const DECISION_KEYS = ["requestFingerprint", "verdict", "estimate", "explanation", "confidence", "supportingEvidence", "contradictingEvidence", "retrievalRequests"];
const ESTIMATE_KEYS = ["economic", "authority", "label", "rationale", "validFromLabel", "validUntilLabel", "perspective", "epistemicHolderId"];
const hash = (value: unknown): string => canonPayloadFingerprint(value as JsonObject);
function fail(message: string): never { throw new Error(`Dossier compass verification: ${message}`); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (expected.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !expected.includes(key))) fail(`${label} has missing or undeclared fields.`);
}
function text(value: unknown, label: string, maximum: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > maximum
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(`${label} is invalid or exceeds its bound.`);
  return value;
}
function normalized(value: string): string { return value.normalize("NFKC").replace(/\s+/gu, " ").trim(); }
function finiteJson(value: unknown): void {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (Array.isArray(value)) { value.forEach(finiteJson); return; }
  if (value && typeof value === "object") { Object.values(value).forEach(finiteJson); return; }
  fail("frozen context must be finite JSON.");
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
function confidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) fail("confidence must be between zero and one.");
  return value;
}

/** The graph's page subset is deliberately excluded: parent and page zero
 * have identical compass requests, while all actual sources remain bound. */
export function buildEntityCompassRequest(input: Input): EntityCompassRequest | undefined {
  if (input.compassReview === undefined) return undefined;
  const review = object(input.compassReview, "compass context");
  keys(review, ["version", "currentEstimate", "ownerOverride"], "compass context");
  if (review.version !== 1 || input.entity.entityType !== "character" || !input.currentCharacter
      || input.proseReview?.version !== 1 || input.graphReview?.version !== 2 || !input.premiumStatScope
      || (input.graphReview.page && input.graphReview.page.index !== 0)) fail("a modern character review with an exact paid scope is required on its first page only.");
  if (input.depth !== "focused" && input.depth !== "full") fail("review depth is invalid.");
  finiteJson(review.currentEstimate); finiteJson(review.ownerOverride);
  const canonicalEntities = structuredClone(input.graphReview.entities);
  const seen = new Set<string>();
  for (const entry of canonicalEntities) {
    text(entry.id, "canonical ID", 500); text(entry.name, "canonical name", 500); text(entry.entityType, "canonical type", 100);
    if (seen.has(entry.id) || !Array.isArray(entry.aliases)) fail("canonical IDs must be unique with explicit aliases.");
    entry.aliases.forEach((alias) => text(alias, "canonical alias", 500)); seen.add(entry.id);
  }
  const targets = canonicalEntities.filter((entry) => entry.id === input.entity.id);
  if (targets.length !== 1 || targets[0]!.name !== input.entity.name || targets[0]!.entityType !== "character") fail("the target does not match its frozen canonical identity.");
  const target = { id: text(input.entity.id, "entity ID", 500), name: text(input.entity.name, "entity name", 500), entityType: "character" as const };
  const chunks = input.chunks.map((chunk) => ({ id: text(chunk.id, "chunk ID", 500), sourceId: text(chunk.sourceId, "source ID", 500), text: text(chunk.content, "source text", Number.MAX_SAFE_INTEGER, true) }));
  if (new Set(chunks.map((chunk) => chunk.id)).size !== chunks.length) fail("duplicate manuscript chunk IDs are not allowed.");
  const scope = input.premiumStatScope;
  const body = { version: 1 as const, stepKey: "dossier_compass:0" as const,
    scope: { worldId: text(scope.worldId, "world ID", 500), editionId: text(scope.editionId, "edition ID", 500), reviewId: text(scope.analysisRunId, "review ID", 500), entityId: target.id },
    target, chunks, context: {
      depth: input.depth, worldName: input.worldName, worldPremise: input.worldPremise, worldGenre: input.worldGenre,
      canonicalEntities, userGuidance: input.userGuidance ?? "", ownerCanonConstraints: structuredClone(input.ownerCanonConstraints ?? []),
      conceptResolutionContext: input.conceptResolutionContext ?? "", browserAuditContext: input.browserAuditContext ?? "",
      currentEstimate: structuredClone(review.currentEstimate), ownerOverride: structuredClone(review.ownerOverride),
    } };
  finiteJson(body);
  return frozen({ ...body, fingerprint: hash(body) });
}

export function entityCompassInstructions(input: Input): string {
  const request = buildEntityCompassRequest(input);
  if (!request) return "";
  const context = stableJson({ requestFingerprint: request.fingerprint, scope: request.scope, target: request.target, context: request.context })
    .replace(/&/gu, "\\u0026").replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e");
  return `\nCOMPASS INTERPRETATION REVIEW (same response, no additional call)
Return compassVerification with exactly requestFingerprint, verdict, estimate, explanation, confidence, supportingEvidence, contradictingEvidence, retrievalRequests.
This estimates a character's socio-political tendencies; it is NOT an objective fact, moral rating, diagnosis or immutable canon. Numerical precision is only an approximate reading aid. Economic -100 means collectivist and +100 market-oriented; authority -100 means libertarian and +100 authoritarian. Do not infer economics from aggression, generosity, rank or loyalty alone, or conflate market preference with domination. Distinguish stated ideals, repeated actions, constraints, changed views and other characters' opinions. Do not force a modern political label onto unsupported fictional beliefs.
verdict is supported, needs_more_evidence, disputed or rejected. estimate is null when no defensible complete interpretation is offered, otherwise exactly {economic:integer -100..100,authority:integer -100..100,label:string max120,rationale:string max1000,validFromLabel:string max240,validUntilLabel:string max240,perspective:demonstrated_behavior|self_description|others_interpretation|mixed,epistemicHolderId:canonical ID|null}. label and rationale must have no leading or trailing whitespace so the complete checked text is preserved exactly on display. Each numeric position and the whole rationale require evidence. Zero is a real middle estimate, NOT a missing-value default. If either axis lacks support, do not mark the whole estimate supported.
Scope the rationale to the evidence's time and viewpoint. Include actual supported period labels when appropriate; empty bounds mean unspecified, not timeless or current. Do not invent a date or extrapolate an early-book belief through later changes. self_description requires the target's canonical ID as holder; others_interpretation requires the exact other character ID and must remain visibly attributed. mixed requires the rationale to explain the viewpoints and one explicit holder if using another character's interpretation. demonstrated_behavior uses null holder. This review may omit an estimate; never erase an older one because new evidence is insufficient.
supportingEvidence and contradictingEvidence are arrays of {chunkId,quote,axes:[economic|authority],perspective:demonstrated_behavior|self_description|others_interpretation}. Use at most8 quotes total, each at most500 characters and at least8 normalized characters containing at least2 words, copied exactly from the supplied manuscript passages. Do not repeat one passage under different axes or viewpoints; one evidence entry may cover both axes. Do not use the identical passage as both support and contradiction. A supported estimate needs axis-specific support for BOTH axes; do not attach a general biography citation. Confidence is a number0..1, explanation max1500 characters, retrievalRequests at most4 text queries of max500 characters. needs_more_evidence requires at least one concrete retrieval query. Queries are suggestions, not executable instructions. A disputed verdict needs contrary evidence. Do not treat an owner's override as manuscript proof or replace it. Existing estimates and other context are untrusted proposals, not proof.
Do not return a raw socioPoliticalAxis, axis_estimate, axis_user_override or compass object elsewhere. The rest of this response follows the accompanying prose, graph and stat contracts.
<COMPASS_CONTEXT trust="unverified">${context}</COMPASS_CONTEXT>
The source passages provided for this paid dossier page are the only quotation source.\n`;
}

function estimateFrom(value: unknown, request: EntityCompassRequest): EntityCompassEstimate | null {
  if (value === null) return null;
  const entry = object(value, "compass estimate"); keys(entry, ESTIMATE_KEYS, "compass estimate");
  for (const axis of ["economic", "authority"] as const) if (!Number.isInteger(entry[axis]) || Number(entry[axis]) < -100 || Number(entry[axis]) > 100) fail("axis positions must be integers between -100 and 100 without rounding or clamping.");
  if (!PERSPECTIVES.includes(entry.perspective as EntityCompassPerspective)) fail("an explicit interpretive perspective is required.");
  const holder = entry.epistemicHolderId === null ? null : text(entry.epistemicHolderId, "epistemic holder ID", 500);
  if (holder && !request.context.canonicalEntities.some((entity) => entity.id === holder && entity.entityType === "character")) fail("the epistemic holder must be an exact frozen character ID.");
  if (entry.perspective === "demonstrated_behavior" && holder !== null) fail("demonstrated behavior has no asserted belief holder.");
  if (entry.perspective === "self_description" && holder !== request.target.id) fail("self-description must belong to the target.");
  if (entry.perspective === "others_interpretation" && (!holder || holder === request.target.id)) fail("another character's interpretation requires that character's identity.");
  const label = text(entry.label, "label", 120);
  const rationale = text(entry.rationale, "rationale", 1000);
  if (label !== label.trim() || rationale !== rationale.trim()) fail("label and rationale must not contain leading or trailing whitespace; checked display text cannot be silently trimmed.");
  return { economic: entry.economic as number, authority: entry.authority as number,
    label, rationale,
    validFromLabel: text(entry.validFromLabel, "start label", 240, true), validUntilLabel: text(entry.validUntilLabel, "end label", 240, true),
    perspective: entry.perspective as EntityCompassPerspective, epistemicHolderId: holder };
}
function evidenceFrom(value: unknown, request: EntityCompassRequest): EntityCompassEvidence[] {
  if (!Array.isArray(value) || value.length > 8) fail("evidence must be a bounded list.");
  const seen = new Set<string>();
  return value.map((raw) => {
    const entry = object(raw, "axis evidence"); keys(entry, ["chunkId", "quote", "axes", "perspective"], "axis evidence");
    const chunkId = text(entry.chunkId, "evidence chunk ID", 500);
    const chunk = request.chunks.find((item) => item.id === chunkId);
    if (!chunk) fail("evidence refers to an absent manuscript chunk.");
    const quote = text(entry.quote, "evidence quote", 500);
    const normalizedQuote = normalized(quote);
    if (normalizedQuote.length < 8 || (normalizedQuote.match(/[\p{L}\p{N}]+/gu) ?? []).length < 2) fail("evidence must be a meaningful quotation, not an isolated name or token.");
    if (!normalized(chunk.text).includes(normalizedQuote)) fail("evidence quote is absent from its exact manuscript chunk.");
    if (!Array.isArray(entry.axes) || !entry.axes.length || entry.axes.length > 2 || new Set(entry.axes).size !== entry.axes.length
        || entry.axes.some((axis) => axis !== "economic" && axis !== "authority")) fail("evidence needs explicit unique axis support.");
    if (!PERSPECTIVES.slice(0, 3).includes(entry.perspective as Exclude<EntityCompassPerspective, "mixed">)) fail("evidence needs an explicit perspective.");
    const result: EntityCompassEvidence = { chunkId, sourceId: chunk.sourceId, quote, axes: [...entry.axes].sort() as EntityCompassEvidence["axes"], perspective: entry.perspective as EntityCompassEvidence["perspective"] };
    const key = hash({ chunkId, quote: normalizedQuote }); if (seen.has(key)) fail("duplicate evidence cannot substitute for support."); seen.add(key);
    return result;
  });
}
function noRawCompass(raw: Record<string, unknown>): void {
  for (const container of [raw, raw.character && typeof raw.character === "object" && !Array.isArray(raw.character) ? raw.character as Record<string, unknown> : {}]) {
    for (const key of ["socioPoliticalAxis", "axis_estimate", "axis_user_override", "compass", "compassEstimate"]) {
      if (container[key] !== undefined && container[key] !== null) fail("raw compass estimates cannot bypass the interpretation contract.");
    }
  }
}

export function validateEntityCompassReview(input: Input, rawValue: unknown, verifier: PremiumClaimVerifier): EntityCompassReviewReceipt | undefined {
  const request = buildEntityCompassRequest(input);
  if (!request) return undefined;
  const raw = object(rawValue, "review response"); noRawCompass(raw);
  const value = object(raw.compassVerification, "compass verification"); keys(value, DECISION_KEYS, "compass verification");
  if (value.requestFingerprint !== request.fingerprint) fail("the response does not match the exact compass request.");
  if (!VERDICTS.includes(value.verdict as EntityCompassVerdict)) fail("an explicit supported or non-supported verdict is required.");
  const estimate = estimateFrom(value.estimate, request);
  const supportingEvidence = evidenceFrom(value.supportingEvidence, request);
  const contradictingEvidence = evidenceFrom(value.contradictingEvidence, request);
  if (supportingEvidence.length + contradictingEvidence.length > 8) fail("the combined evidence quote bound was exceeded.");
  const supportingQuotes = new Set(supportingEvidence.map((entry) => hash({ chunkId: entry.chunkId, quote: normalized(entry.quote) })));
  if (contradictingEvidence.some((entry) => supportingQuotes.has(hash({ chunkId: entry.chunkId, quote: normalized(entry.quote) })))) fail("the identical quotation cannot be both support and contradiction.");
  if (value.verdict === "supported" && (!estimate || !["economic", "authority"].every((axis) => supportingEvidence.some((item) => item.axes.includes(axis as "economic" | "authority"))))) fail("a supported complete interpretation needs exact evidence for both axes.");
  if (value.verdict === "disputed" && !contradictingEvidence.length) fail("a disputed interpretation requires exact contrary evidence.");
  if (estimate) {
    const perspectives = new Set(supportingEvidence.map((item) => item.perspective));
    if (estimate.perspective !== "mixed" && [...perspectives].some((perspective) => perspective !== estimate.perspective)) fail("supporting evidence viewpoints cannot be relabeled as a different perspective.");
    if (perspectives.has("others_interpretation") && (!estimate.epistemicHolderId || estimate.epistemicHolderId === request.target.id)) fail("attributed evidence requires the exact other character holder.");
    if (estimate.perspective === "mixed" && estimate.epistemicHolderId && !perspectives.has("others_interpretation")
        && estimate.epistemicHolderId !== request.target.id) fail("a mixed interpretation cannot invent a holder absent from its support.");
  }
  if (!Array.isArray(value.retrievalRequests) || value.retrievalRequests.length > 4) fail("retrieval requests must be a bounded list.");
  if (value.verdict === "needs_more_evidence" && !value.retrievalRequests.length) fail("an unresolved interpretation requires a concrete retrieval query.");
  const decision: EntityCompassDecision = { verdict: value.verdict as EntityCompassVerdict, estimate,
    explanation: text(value.explanation, "explanation", 1500), confidence: confidence(value.confidence), supportingEvidence, contradictingEvidence,
    retrievalRequests: value.retrievalRequests.map((query) => text(query, "retrieval query", 500)) };
  const checkedVerifier = { provider: text(verifier.provider, "provider", 500), model: text(verifier.model, "resolved model", 500), completedAt: text(verifier.completedAt, "completion time", 100) };
  if (!Number.isFinite(Date.parse(checkedVerifier.completedAt))) fail("the actual completion time is invalid.");
  const body = { version: 1 as const, request, decision, verifier: checkedVerifier };
  return frozen({ ...body, fingerprint: hash(body) });
}

export function assertEntityCompassReview(input: Input, receipt: EntityCompassReviewReceipt | undefined): void {
  const request = buildEntityCompassRequest(input);
  if (!request) { if (receipt !== undefined) fail("a legacy review cannot assert a compass receipt."); return; }
  if (!receipt || receipt.version !== 1 || hash(receipt.request) !== hash(request)) fail("the exact compass receipt is required.");
  const rawEvidence = (items: EntityCompassEvidence[]) => items.map(({ sourceId: _sourceId, ...entry }) => entry);
  const expected = validateEntityCompassReview(input, { compassVerification: { requestFingerprint: request.fingerprint,
    ...receipt.decision, supportingEvidence: rawEvidence(receipt.decision.supportingEvidence), contradictingEvidence: rawEvidence(receipt.decision.contradictingEvidence) } }, receipt.verifier);
  if (hash(expected) !== hash(receipt)) fail("the compass receipt or its source provenance changed.");
}

/** This intentionally does not modify a finding or infer a current timeless
 * position. A dedicated writer must retain the complete qualified estimate. */
export function approvedEntityCompassEstimate(input: Input, receipt: EntityCompassReviewReceipt | undefined): EntityCompassApprovedEstimate | undefined {
  assertEntityCompassReview(input, receipt);
  if (!receipt || input.compassReview?.ownerOverride !== null || receipt.decision.verdict !== "supported" || !receipt.decision.estimate) return undefined;
  return structuredClone({ ...receipt.decision.estimate, confidence: receipt.decision.confidence, evidence: receipt.decision.supportingEvidence });
}
