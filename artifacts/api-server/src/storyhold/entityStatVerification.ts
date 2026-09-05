import { canonPayloadFingerprint, type JsonObject } from "./analysisVerificationContracts";
import { PREMIUM_STAT_NAMES, premiumNeutralStats, premiumStatCandidates } from "./premiumStatCandidates";
import { assertPremiumStatReceipt, assertPremiumStatRequest, buildPremiumStatRequest, premiumStatInstructions, statsFromPremiumReceipts,
  validatePremiumStatResponse, type PremiumStatRequest, type PremiumStatReviewReceipt, type PremiumStatVerifier } from "./premiumStatVerification";
import type { EntityReviewFinding, EntityReviewInput } from "./entityReview";
import type { CharacterFinding, WorldFindings } from "./worldAnalysis";

const FAMILIES: Readonly<Record<string, string>> = {
  character: "characters", creature: "creatures", species: "species", place: "locations", faction: "factions",
  institution: "institutions", government: "governments", power_structure: "powerStructures", technology: "technologies",
  vehicle: "vehicles", device: "devices", weapon: "weapons", power: "powers", title: "titles", ambiguous: "ambiguous",
};
const NO_STATS = new Set(["cultural_reference", "term"]);
const GROUPS = [PREMIUM_STAT_NAMES.slice(0, 6), PREMIUM_STAT_NAMES.slice(6)] as const;
function fail(message: string): never { throw new Error(`Dossier stat verification: ${message}`); }
const normalized = (value: string): string => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !normalized(value)) fail(`${label} must be a nonempty string.`);
  return normalized(value);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function fingerprint(value: unknown): string { return canonPayloadFingerprint(value as JsonObject); }
function identity(input: EntityReviewInput): { family: string | null; id: string; name: string; type: string } {
  if (!input.premiumStatScope) fail("a scoped premium review ID is required.");
  for (const key of ["worldId", "editionId", "analysisRunId"] as const) text(input.premiumStatScope[key], key);
  const id = text(input.entity.id, "entity ID");
  const name = text(input.entity.name, "entity name");
  const type = text(input.entity.entityType, "entity type");
  const family = FAMILIES[type] ?? null;
  if (!family && !NO_STATS.has(type)) fail("the entity category is unsupported.");
  if (input.depth !== "focused" && input.depth !== "full") fail("review depth is invalid.");
  return { family, id, name, type };
}

/** Two fixed bounded groups share one provider response. Adding estimates does
 * not reshape the protocol or permit a creature's stats to migrate to its host. */
export function buildEntityStatRequests(input: EntityReviewInput): PremiumStatRequest[] {
  const entity = identity(input);
  if (!entity.family) return [];
  const original = entity.type === "character" ? input.currentCharacter?.estimatedStats ?? input.entity.estimatedStats : input.entity.estimatedStats;
  // Validate every provided field before selecting group members, so an unknown
  // stat or invalid estimate cannot disappear behind grouping.
  premiumStatCandidates({ [entity.family]: [{ name: entity.name, ...(original === undefined ? {} : { estimatedStats: original }) }] });
  return GROUPS.map((allowedStats, index) => {
    const estimatedStats = Object.fromEntries(allowedStats.flatMap((stat) => original?.[stat] === undefined ? [] : [[stat, original[stat]]]));
    return buildPremiumStatRequest({ scope: input.premiumStatScope!, stepKey: `dossier_stats:${index}`,
      chunks: input.chunks.map((chunk) => ({ id: chunk.id, sourceId: chunk.sourceId, text: chunk.content })),
      findings: { [entity.family!]: [{ name: entity.name, estimatedStats }] } as Partial<WorldFindings>,
      context: {
        existingCanonContext: JSON.stringify({ entityId: entity.id, entityName: entity.name, entityType: entity.type,
          family: entity.family, reviewDepth: input.depth, allowedStats, worldName: input.worldName,
          worldPremise: input.worldPremise, worldGenre: input.worldGenre }),
        // New graph-enabled requests survive JSONB object-key reordering.
        // Keep older request bytes unchanged so existing paid receipts remain valid.
        userGuidance: JSON.stringify({ authorGuidance: input.userGuidance ?? "", ownerCanonConstraints: input.graphReview
          ? (input.ownerCanonConstraints ?? []).map(({ id, kind, instruction }) => ({ id, kind, instruction }))
          : input.ownerCanonConstraints ?? [] }),
        externalReferenceContext: JSON.stringify({ conceptResolutionContext: input.conceptResolutionContext ?? "", browserAuditContext: input.browserAuditContext ?? "" }),
      },
    });
  });
}
function groupContext(request: PremiumStatRequest, index: number): { entityName: string; family: string; allowedStats: readonly string[] } {
  // Validate without allocating a prompt string that would be discarded.
  assertPremiumStatRequest(request);
  if (request.stepKey !== `dossier_stats:${index}`) fail("stat request groups must retain their fixed order.");
  let raw: unknown;
  try { raw = JSON.parse(request.context.existingCanonContext); } catch { fail("stat group context is malformed."); }
  const context = object(raw, "stat group context");
  if (fingerprint({ names: context.allowedStats }) !== fingerprint({ names: GROUPS[index] })) fail("stat group names do not match the fixed protocol.");
  return { entityName: text(context.entityName, "stat group entity name"), family: text(context.family, "stat group family"), allowedStats: GROUPS[index]! };
}
export function entityStatInstructions(requests: readonly PremiumStatRequest[]): string {
  if (requests.length !== 0 && requests.length !== 2) fail("there must be exactly two stat groups, or none for reference records.");
  if (!requests.length) return "DOSSIER STAT OVERRIDE: This record category has no numeric stat review. Return estimatedStats:null and no meaningful character estimatedStats; return statVerifications:[] exactly. Do not invent or inherit stats.";
  const instructions = requests.map((request, index) => {
    const context = groupContext(request, index);
    return `GROUP ${index}: Only family ${JSON.stringify(context.family)}, exact entity ${JSON.stringify(context.entityName)}, and stat names ${JSON.stringify(context.allowedStats)} are allowed, including newStats.\n${premiumStatInstructions(request, { includeSharedContract: index === 0, includeCandidateEvidence: true })}`;
  });
  return `DOSSIER STAT OVERRIDE: The two groups below share this ONE provider call and ONE JSON response. The STAT VERIFICATION CONTRACT is printed once and applies in full to BOTH groups. Return top-level statVerifications as an array of EXACTLY TWO review objects in the listed order. Each object has requestFingerprint, decisions, newStats; use its OWN group's inventory fingerprint, not the other group's example fingerprint. Do not return singular statVerification. Root estimatedStats and character.estimatedStats may be null, omitted, or neutral placeholders only; meaningful estimates must appear only in statVerifications. Both groups are required even when their candidate inventory is empty. Do not change the stable entity/category, transfer another person's or creature's stats, cross group boundaries, or interpret an omitted stat as a verified average.
${instructions.join("\n\n")}`;
}
function assertNoRawStats(raw: Record<string, unknown>): void {
  const check = (estimate: unknown) => {
    if (estimate === undefined || estimate === null) return;
    if (premiumStatCandidates({ characters: [{ name: "Reviewed entity", estimatedStats: estimate }] }).length) fail("meaningful raw estimatedStats are forbidden; use statVerifications.");
  };
  check(raw.estimatedStats);
  if (raw.character !== undefined && raw.character !== null) check(object(raw.character, "character").estimatedStats);
  if (Object.hasOwn(raw, "statVerification")) fail("use the fixed statVerifications array, not a singular statVerification.");
}
function assertGroupTargets(receipt: PremiumStatReviewReceipt, index: number): void {
  const context = groupContext(receipt.request, index);
  for (const proposal of receipt.packet.proposals) {
    const value = proposal.payload;
    if (value.family !== context.family || value.entity !== context.entityName || !context.allowedStats.includes(String(value.stat))) fail("stat approval changes the reviewed entity, category, or allowed group.");
  }
}
export function validateEntityStatReviews(input: EntityReviewInput, raw: unknown, verifier: PremiumStatVerifier): PremiumStatReviewReceipt[] {
  const requests = buildEntityStatRequests(input);
  const response = object(raw, "dossier response");
  assertNoRawStats(response);
  if (!Array.isArray(response.statVerifications) || response.statVerifications.length !== requests.length) fail("statVerifications must contain exactly the expected review groups.");
  const groups = response.statVerifications;
  return requests.map((request, index) => {
    const reviewed = validatePremiumStatResponse(request, { statVerification: groups[index] }, verifier);
    assertGroupTargets(reviewed, index);
    return reviewed;
  });
}
export function assertEntityStatReviews(input: EntityReviewInput, receipts: readonly PremiumStatReviewReceipt[]): void {
  const expected = buildEntityStatRequests(input);
  if (!Array.isArray(receipts) || receipts.length !== expected.length) fail("saved stat review groups are incomplete.");
  receipts.forEach((receipt, index) => {
    assertPremiumStatReceipt(receipt);
    if (fingerprint(receipt.request) !== fingerprint(expected[index])) fail("saved stat review belongs to a changed entity, scope, source, or review context.");
    assertGroupTargets(receipt, index);
  });
}
export function projectEntityReviewedStats(input: EntityReviewInput, finding: EntityReviewFinding, reviews: readonly PremiumStatReviewReceipt[]): EntityReviewFinding {
  assertEntityStatReviews(input, reviews);
  const entity = identity(input);
  const output = structuredClone(finding);
  output.estimatedStats = null;
  if (output.character) {
    if (entity.type !== "character" || normalized(output.character.name) !== entity.name) fail("stat projection cannot create or rename the reviewed character.");
    output.character.estimatedStats = premiumNeutralStats();
  }
  const slots = new Map<string, ReturnType<typeof statsFromPremiumReceipts>>();
  for (const stat of statsFromPremiumReceipts(reviews)) {
    const values = slots.get(stat.stat) ?? []; values.push(stat); slots.set(stat.stat, values);
  }
  const approved: Partial<CharacterFinding["estimatedStats"]> = {};
  for (const [stat, variants] of slots) {
    if (variants.length !== 1) continue; // Conflicting exact estimates remain in receipts, not the dossier.
    const value = variants[0]!;
    approved[stat as keyof CharacterFinding["estimatedStats"]] = { score: value.score, rationale: value.rationale, confidence: value.confidence, evidence: structuredClone(value.evidence) };
  }
  if (entity.type === "character") {
    if (output.character) Object.assign(output.character.estimatedStats, approved);
  } else if (Object.keys(approved).length) output.estimatedStats = approved;
  return output;
}
