import { createHash } from "node:crypto";
import type { WorldFindings } from "./worldAnalysis";
import { PREMIUM_STAT_FAMILIES, premiumStatCandidates } from "./premiumStatCandidates";

/** Frozen boundaries for one paid verification call, not another selection pass. */
export type PremiumVerificationPage = {
  /** Absent on legacy, selected-typed-candidate plans. */
  version?: 2 | 3;
  stepKey: string;
  batchIndex: number;
  pageIndex: number;
  pageCount: number;
  candidateKeys: string[];
  packetFingerprint: string;
};

export const PREMIUM_VERIFICATION_CANDIDATES_PER_PAGE = 6;
const MAXIMUM_PACKET_CHARACTERS = 64_000;
const ARRAY_FIELDS = [
  "genres", "atmosphere", "themes", "worldRules", "locations", "factions",
  "institutions", "governments", "powerStructures", "creatures", "species",
  "technologies", "vehicles", "devices", "weapons", "powers", "titles",
  "ambiguous", "chapterSummaries", "chronology", "openQuestions", "recurringTerms",
  "characters", "entityRelations", "entityRules", "claims", "cohesionProposals",
] as const satisfies ReadonlyArray<keyof WorldFindings>;
const FAMILIES = [
  ["claims", "claim"], ["entityRelations", "relation"], ["entityRules", "rule"],
] as const;
type CandidateField = (typeof FAMILIES)[number][0];
type Candidate = { key: string; field: CandidateField; value: Record<string, unknown> };
const CONTEXT_FIELDS = ["genres", "atmosphere", "themes"] as const;
const ORDINARY_FIELDS = ARRAY_FIELDS.filter((field) =>
  !CONTEXT_FIELDS.some((context) => context === field)
  && !FAMILIES.some(([typed]) => typed === field));
type InventoryCandidate = { key: string; field: (typeof ARRAY_FIELDS)[number]; value: unknown };
type InventorySnapshot = { packet: WorldFindings; fingerprint: string; candidates: InventoryCandidate[] };

function fail(message: string): never {
  throw new Error(`Premium verification pages: ${message}`);
}

/** Canonical JSON retains exact strings, array order, evidence, and confidence. */
function stable(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object") return fail("packets must contain finite JSON data.");
  if (ancestors.has(value)) return fail("packets cannot contain circular references.");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return fail("packets must contain plain JSON objects.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${Array.from(value, (item) => stable(item, ancestors)).join(",")}]`;
    }
    // Optional object properties follow JSON persistence semantics. Undefined
    // array entries remain invalid instead of silently becoming null.
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child, ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function snapshot(packet: WorldFindings): { packet: WorldFindings; fingerprint: string; candidates: Candidate[] } {
  assertPacketShape(packet);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const [field, family] of FAMILIES) {
    for (const value of packet[field] ?? []) {
      if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${family} candidate must be an object.`);
      const encoded = stable(value);
      if (encoded.length > MAXIMUM_PACKET_CHARACTERS) {
        fail(`a single ${family} candidate exceeds the selected packet limit; it cannot be truncated.`);
      }
      const key = `${family}:${hash(encoded)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ key, field, value: JSON.parse(encoded) as Record<string, unknown> });
    }
  }
  const encoded = stable(packet);
  if (encoded.length > MAXIMUM_PACKET_CHARACTERS) fail("selected packet exceeds the 64,000-character limit; select it before pagination.");
  return {
    packet: JSON.parse(encoded) as WorldFindings,
    fingerprint: `premium_packet_${hash(encoded)}`,
    candidates,
  };
}

function assertPacketShape(packet: WorldFindings): void {
  if (!packet || typeof packet !== "object" || Array.isArray(packet) || typeof packet.summary !== "string") {
    fail("a selected packet must have a summary and finding arrays.");
  }
  if (Object.keys(packet).some((key) => key !== "summary" && !ARRAY_FIELDS.includes(key as (typeof ARRAY_FIELDS)[number]))) {
    fail("selected packet contains an unexpected field.");
  }
  for (const field of ARRAY_FIELDS) {
    if (field === "claims" && packet[field] === undefined) continue;
    if (!Array.isArray(packet[field])) fail(`selected packet ${field} must be an array.`);
  }
}

/** Snapshot every entry before sizing pages; no selection or evidence truncation. */
function inventorySnapshot(packet: WorldFindings, version: 2 | 3 = 2): InventorySnapshot {
  assertPacketShape(packet);
  const encoded = stable(packet);
  const saved = JSON.parse(encoded) as WorldFindings;
  const candidates: InventoryCandidate[] = [];
  const seen = new Set<string>();
  for (const field of CONTEXT_FIELDS) {
    if (saved[field].some((value) => typeof value !== "string")) fail(`context ${field} must contain strings.`);
  }
  function appendFields(fields: ReadonlyArray<(typeof ARRAY_FIELDS)[number]>): void {
    for (const field of fields) {
      const prefix = FAMILIES.find(([typed]) => typed === field)?.[1] ?? `finding:${field}`;
      for (const value of saved[field] ?? []) {
        if (field === "openQuestions" || field === "recurringTerms") {
          if (typeof value !== "string") fail(`${field} candidate must be a string.`);
        } else if (!value || typeof value !== "object" || Array.isArray(value)) {
          fail(`${field} candidate must be an object.`);
        }
        const key = `${prefix}:${hash(stable(value))}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // The original record still determines the ordinary candidate identity.
        // Its statistical estimates travel separately, with their own decisions.
        const proposalValue = version === 3 && value && typeof value === "object" && !Array.isArray(value)
          ? withoutEstimatedStats(value as Record<string, unknown>) : value;
        candidates.push({ key, field, value: proposalValue });
      }
    }
  }
  appendFields(FAMILIES.map(([field]) => field));
  if (version === 3) {
    for (const field of PREMIUM_STAT_FAMILIES) {
      for (const raw of saved[field] ?? []) {
        // Extraction shares the response contract's exact definition of a
        // meaningful estimate. It never invents work for neutral placeholders.
        const entry = raw as unknown as Record<string, unknown>;
        let estimates: ReturnType<typeof premiumStatCandidates>;
        try {
          estimates = premiumStatCandidates({ [field]: [raw] } as Partial<WorldFindings>);
        } catch (error) {
          fail(error instanceof Error ? error.message : "stat candidate could not be inspected.");
        }
        for (const estimate of estimates) {
          const value = (entry.estimatedStats as Record<string, unknown>)[estimate.stat];
          const key = `stat:${hash(stable({ family: field, entity: entry.name, stat: estimate.stat, value }))}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({ key, field, value: statProposalFinding(field, entry.name, estimate.stat, value) });
        }
      }
    }
  }
  appendFields(ORDINARY_FIELDS);
  return { packet: saved, fingerprint: `${version === 3 ? "premium_stat_inventory_" : "premium_inventory_"}${hash(encoded)}`, candidates };
}

function withoutEstimatedStats(value: Record<string, unknown>): Record<string, unknown> {
  const { estimatedStats: _estimates, ...finding } = value;
  return finding;
}

/** A stat page cannot become an alternate route for unassigned dossier prose. */
function statProposalFinding(field: string, name: unknown, stat: string, value: unknown): Record<string, unknown> {
  const estimate = value as Record<string, unknown>;
  const finding: Record<string, unknown> = {
    name,
    summary: "",
    evidence: estimate.evidence,
    confidence: estimate.confidence,
    estimatedStats: { [stat]: value },
  };
  if (field === "characters") {
    for (const key of [
      "aliases", "traits", "motivations", "fears", "capabilities", "history", "origins", "powers",
      "moralSystem", "physicalCharacteristics", "relationships", "relationshipWeb", "knowledge", "secrets", "factionMemberships",
    ]) finding[key] = [];
    finding.role = "";
    finding.socioPoliticalAxis = { economic: 0, authority: 0, label: "Undetermined", rationale: "", confidence: 0 };
  }
  return finding;
}

function inventoryProposal(saved: InventorySnapshot, candidates: InventoryCandidate[], first: boolean): WorldFindings {
  const result = { summary: first ? saved.packet.summary : "" } as WorldFindings;
  for (const field of ARRAY_FIELDS) {
    (result as unknown as Record<string, unknown>)[field] = first && CONTEXT_FIELDS.some((context) => context === field)
      ? [...saved.packet[field] ?? []] : [];
  }
  for (const candidate of candidates) (result[candidate.field] as unknown[]).push(candidate.value);
  return result;
}

/** Greedy deterministic packing accounts for the complete JSON envelope. */
function inventoryGroups(saved: InventorySnapshot): InventoryCandidate[][] {
  const groups: InventoryCandidate[][] = [];
  let current: InventoryCandidate[] = [];
  if (JSON.stringify(inventoryProposal(saved, [], true)).length > MAXIMUM_PACKET_CHARACTERS) {
    fail("inventory context metadata exceeds the 64,000-character page limit; it cannot be truncated.");
  }
  for (const candidate of saved.candidates) {
    if (JSON.stringify(inventoryProposal(saved, [candidate], false)).length > MAXIMUM_PACKET_CHARACTERS) {
      fail(`a single ${candidate.field} candidate cannot fit the 64,000-character page limit; it cannot be truncated.`);
    }
    const proposed = [...current, candidate];
    if (proposed.length > PREMIUM_VERIFICATION_CANDIDATES_PER_PAGE
      || JSON.stringify(inventoryProposal(saved, proposed, groups.length === 0)).length > MAXIMUM_PACKET_CHARACTERS) {
      // Only the first page may contain context without candidates. This avoids
      // discarding metadata when a large first candidate needs its own page.
      groups.push(current);
      current = [candidate];
    } else {
      current = proposed;
    }
  }
  if (current.length > 0 || groups.length === 0) groups.push(current);
  return groups;
}

/** Preserve the complete relevant inventory, bounded by both count and JSON size. */
export function buildCompletePremiumVerificationPages(packets: WorldFindings[], version: 2 | 3 = 3): PremiumVerificationPage[] {
  return prepareCompletePremiumVerificationPages(packets, version).pages;
}

/** Invocation-local preparation avoids rescanning a large inventory per page. */
export function prepareCompletePremiumVerificationPages(packets: WorldFindings[], version: 2 | 3 = 3): {
  pages: PremiumVerificationPage[];
  proposals: WorldFindings[];
} {
  if (!Array.isArray(packets)) fail("inventory packets must be an array.");
  if (version !== 2 && version !== 3) fail("complete inventory version must be 2 or 3.");
  const pages: PremiumVerificationPage[] = [];
  const proposals: WorldFindings[] = [];
  packets.forEach((packet, batchIndex) => {
    const saved = inventorySnapshot(packet, version);
    const groups = inventoryGroups(saved);
    groups.forEach((candidates, pageIndex) => {
      pages.push({
        version,
        stepKey: `verification:${pages.length}`,
        batchIndex, pageIndex, pageCount: groups.length,
        candidateKeys: candidates.map((candidate) => candidate.key),
        packetFingerprint: saved.fingerprint,
      });
      proposals.push(inventoryProposal(saved, candidates, pageIndex === 0));
    });
  });
  assertPremiumVerificationPages(pages, packets.length);
  return { pages, proposals };
}

/**
 * Legacy selected-typed-packet builder, retained for old contract inspection.
 * New reviews must use the complete-inventory builder/preparer above.
 */
export function buildPremiumVerificationPages(packets: WorldFindings[]): PremiumVerificationPage[] {
  if (!Array.isArray(packets)) fail("selected packets must be an array.");
  const pages: PremiumVerificationPage[] = [];
  packets.forEach((packet, batchIndex) => {
    const saved = snapshot(packet);
    const pageCount = Math.max(1, Math.ceil(saved.candidates.length / PREMIUM_VERIFICATION_CANDIDATES_PER_PAGE));
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      pages.push({
        stepKey: `verification:${pages.length}`,
        batchIndex, pageIndex, pageCount,
        candidateKeys: saved.candidates
          .slice(pageIndex * PREMIUM_VERIFICATION_CANDIDATES_PER_PAGE, (pageIndex + 1) * PREMIUM_VERIFICATION_CANDIDATES_PER_PAGE)
          .map((candidate) => candidate.key),
        packetFingerprint: saved.fingerprint,
      });
    }
  });
  assertPremiumVerificationPages(pages, packets.length);
  return pages;
}

function pageShape(value: unknown): PremiumVerificationPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("each page must be an object.");
  const page = value as Record<string, unknown>;
  const fields = ["stepKey", "batchIndex", "pageIndex", "pageCount", "candidateKeys", "packetFingerprint"];
  if (page.version === 2 || page.version === 3) fields.push("version");
  if (Object.keys(page).length !== fields.length || fields.some((field) => !Object.hasOwn(page, field))) {
    fail("page fields do not match the frozen page contract.");
  }
  for (const field of ["batchIndex", "pageIndex", "pageCount"] as const) {
    if (!Number.isSafeInteger(page[field]) || Number(page[field]) < (field === "pageCount" ? 1 : 0)) {
      fail(`page ${field} must be a valid nonnegative integer.`);
    }
  }
  if (Number(page.pageIndex) >= Number(page.pageCount)) fail("page index is outside its source batch.");
  if (typeof page.stepKey !== "string" || !/^verification:(?:0|[1-9]\d*)$/u.test(page.stepKey)) fail("page step key is invalid.");
  const fingerprintPattern = page.version === 3 ? /^premium_stat_inventory_[a-f0-9]{64}$/u
    : page.version === 2 ? /^premium_inventory_[a-f0-9]{64}$/u : /^premium_packet_[a-f0-9]{64}$/u;
  if (typeof page.packetFingerprint !== "string" || !fingerprintPattern.test(page.packetFingerprint)) {
    fail("selected packet fingerprint is invalid.");
  }
  if (!Array.isArray(page.candidateKeys) || page.candidateKeys.length > PREMIUM_VERIFICATION_CANDIDATES_PER_PAGE
    || page.candidateKeys.some((key) => typeof key !== "string" || !validCandidateKey(key, page.version as 2 | 3 | undefined))) {
    fail("page candidate keys must identify at most six valid candidates.");
  }
  if (new Set(page.candidateKeys).size !== page.candidateKeys.length) fail("a page repeats a candidate key.");
  if (page.candidateKeys.length === 0 && (page.version !== undefined ? page.pageIndex !== 0 : page.pageCount !== 1)) {
    fail("an empty candidate page is only allowed for a source context page.");
  }
  if (page.version === undefined && Number(page.pageIndex) < Number(page.pageCount) - 1 && page.candidateKeys.length !== PREMIUM_VERIFICATION_CANDIDATES_PER_PAGE) {
    fail("a nonfinal page must preserve the six-candidate boundary.");
  }
  return value as PremiumVerificationPage;
}

function validCandidateKey(key: string, version: 2 | 3 | undefined): boolean {
  if (/^(?:claim|relation|rule):[a-f0-9]{64}$/u.test(key)) return true;
  if (version === 3 && /^stat:[a-f0-9]{64}$/u.test(key)) return true;
  if (version === undefined) return false;
  const ordinary = /^finding:([A-Za-z]+):[a-f0-9]{64}$/u.exec(key);
  return ordinary !== null && ORDINARY_FIELDS.some((field) => field === ordinary[1]);
}

/** Ordinary result families this page is allowed to review (not other pages'). */
export function premiumVerificationPageOrdinaryFields(page: PremiumVerificationPage): string[] {
  const checked = pageShape(page);
  if (checked.version === undefined) return checked.pageIndex === 0 ? [...ORDINARY_FIELDS] : [];
  return [...new Set(checked.candidateKeys.flatMap((key) => key.startsWith("finding:") ? [key.split(":")[1]!] : []))];
}

/** Validate persisted structure; rebuild against selected packets to verify content. */
export function assertPremiumVerificationPages(pages: unknown, sourceBatchCount: number): asserts pages is PremiumVerificationPage[] {
  if (!Number.isSafeInteger(sourceBatchCount) || sourceBatchCount < 0) fail("source batch count is invalid.");
  if (!Array.isArray(pages)) fail("frozen pages must be an array.");
  let expectedBatch = 0;
  let expectedPage = 0;
  let expectedCount = 0;
  let expectedFingerprint = "";
  let expectedVersion: 2 | 3 | undefined;
  let keysInBatch = new Set<string>();
  pages.forEach((value, index) => {
    const page = pageShape(value);
    if (index === 0) expectedVersion = page.version;
    if (page.version !== expectedVersion) fail("frozen pages cannot mix inventory versions.");
    if (page.stepKey !== `verification:${index}`) fail("verification step keys must be canonical and sequential.");
    if (page.batchIndex !== expectedBatch || page.batchIndex >= sourceBatchCount || page.pageIndex !== expectedPage) {
      fail("pages must contain complete, contiguous source-batch groups in order.");
    }
    if (expectedPage === 0) {
      expectedCount = page.pageCount;
      expectedFingerprint = page.packetFingerprint;
      keysInBatch = new Set<string>();
    }
    if (page.pageCount !== expectedCount || page.packetFingerprint !== expectedFingerprint) {
      fail("pages from one source batch disagree about their count or selected packet.");
    }
    for (const key of page.candidateKeys) {
      if (keysInBatch.has(key)) fail("a selected candidate appears on multiple pages of the same batch.");
      keysInBatch.add(key);
    }
    expectedPage += 1;
    if (expectedPage === expectedCount) {
      expectedBatch += 1;
      expectedPage = 0;
    }
  });
  if (expectedPage !== 0 || expectedBatch !== sourceBatchCount) fail("frozen pages omit part of a source batch.");
}

/** Materialize an exact frozen page without cutting or modifying candidate payloads. */
export function proposalForPremiumVerificationPage(packet: WorldFindings, page: PremiumVerificationPage): WorldFindings {
  const checked = pageShape(page);
  if (checked.version === 2 || checked.version === 3) {
    const saved = inventorySnapshot(packet, checked.version);
    if (saved.fingerprint !== checked.packetFingerprint) fail("complete inventory has changed since its pages were frozen.");
    const groups = inventoryGroups(saved);
    const candidates = groups[checked.pageIndex];
    if (checked.pageCount !== groups.length || !candidates
      || stable(checked.candidateKeys) !== stable(candidates.map((candidate) => candidate.key))) {
      fail("candidate keys or boundaries do not match the frozen complete inventory.");
    }
    return inventoryProposal(saved, candidates, checked.pageIndex === 0);
  }
  const saved = snapshot(packet);
  if (saved.fingerprint !== checked.packetFingerprint) fail("selected packet has changed since its pages were frozen.");
  const expectedCount = Math.max(1, Math.ceil(saved.candidates.length / PREMIUM_VERIFICATION_CANDIDATES_PER_PAGE));
  const candidates = saved.candidates.slice(
    checked.pageIndex * PREMIUM_VERIFICATION_CANDIDATES_PER_PAGE,
    (checked.pageIndex + 1) * PREMIUM_VERIFICATION_CANDIDATES_PER_PAGE,
  );
  if (checked.pageCount !== expectedCount || stable(checked.candidateKeys) !== stable(candidates.map((candidate) => candidate.key))) {
    fail("candidate keys or boundaries do not match the frozen selected packet.");
  }
  const result = saved.packet;
  if (checked.pageIndex > 0) {
    result.summary = "";
    for (const field of ARRAY_FIELDS) (result as unknown as Record<string, unknown>)[field] = [];
  }
  result.claims = [];
  result.entityRelations = [];
  result.entityRules = [];
  for (const candidate of candidates) {
    (result[candidate.field] as unknown[]).push(candidate.value);
  }
  return result;
}
