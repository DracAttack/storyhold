import type { CharacterFinding, EvidenceReference, WorldFindings } from "./worldAnalysis";

export const PREMIUM_STAT_FAMILIES = [
  "characters", "worldRules", "locations", "factions", "institutions", "governments",
  "powerStructures", "creatures", "species", "technologies", "vehicles", "devices",
  "weapons", "powers", "titles", "ambiguous",
] as const;
export const PREMIUM_STAT_NAMES = [
  "strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma", "acrobatics",
] as const;
export type PremiumStatPayload = { family: string; entity: string; stat: string; score: number; rationale: string };
export type PremiumStatCandidate = PremiumStatPayload & { evidence: EvidenceReference[]; confidence: number };

const PLACEHOLDERS = new Set([
  "", "Neutral estimate pending stronger source evidence.",
  "This ability has not yet been established by a direct manuscript passage.",
]);
export function isNeutralPremiumStatEstimate(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["score", "confidence", "rationale", "evidence", "reviewStatus"].includes(key))) return false;
  return item.score === 10 && typeof item.confidence === "number" && Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 0.1
    && Array.isArray(item.evidence) && item.evidence.length === 0 && typeof item.rationale === "string"
    && PLACEHOLDERS.has(item.rationale.normalize("NFKC").replace(/\s+/gu, " ").trim());
}
export function neutralPremiumStatEstimate(): CharacterFinding["estimatedStats"]["strength"] {
  return { score: 10, confidence: 0.1, rationale: "Neutral estimate pending stronger source evidence.", evidence: [] };
}
export function premiumNeutralStats(): CharacterFinding["estimatedStats"] {
  return Object.fromEntries(PREMIUM_STAT_NAMES.map((stat) => [stat, neutralPremiumStatEstimate()])) as CharacterFinding["estimatedStats"];
}
function fail(message: string): never { throw new Error(`Premium stat verification: ${message}`); }
function clean(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") fail(`${label} must be a string.`);
  const result = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!result || result.length > maximum) fail(`${label} is empty or exceeds its bound.`);
  return result;
}
export function premiumStatPayload(value: unknown): PremiumStatPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("stat payload must be an object.");
  const item = value as Record<string, unknown>;
  const keys = ["family", "entity", "stat", "score", "rationale"];
  if (keys.some((key) => !Object.hasOwn(item, key)) || Object.keys(item).some((key) => !keys.includes(key))) fail("stat payload fields must be exact.");
  if (!PREMIUM_STAT_FAMILIES.includes(item.family as typeof PREMIUM_STAT_FAMILIES[number])) fail("invalid stat family.");
  if (!PREMIUM_STAT_NAMES.includes(item.stat as typeof PREMIUM_STAT_NAMES[number])) fail("invalid stat name.");
  if (typeof item.score !== "number" || !Number.isInteger(item.score) || item.score < 1 || item.score > 20) fail("stat score must be an integer between one and twenty.");
  return { family: item.family as string, entity: clean(item.entity, "stat entity", 240), stat: item.stat as string, score: item.score, rationale: clean(item.rationale, "stat rationale", 500) };
}

/** Generated neutral defaults are absence of a finding, not seven supported
 * average-ability claims. Any actual estimate remains independently reviewable. */
export function premiumStatCandidates(value: unknown): PremiumStatCandidate[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("findings must be an object.");
  const findings = value as Partial<WorldFindings>;
  const result: PremiumStatCandidate[] = [];
  for (const family of PREMIUM_STAT_FAMILIES) {
    const entries = findings[family];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) fail(`${family} must be an array.`);
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`${family} finding must be an object.`);
      const stats = entry.estimatedStats;
      if (stats === undefined) continue;
      if (!stats || typeof stats !== "object" || Array.isArray(stats)) fail("estimatedStats must be an object.");
      if (Object.keys(stats).some((stat) => !PREMIUM_STAT_NAMES.includes(stat as typeof PREMIUM_STAT_NAMES[number]))) fail("invalid stat name.");
      for (const stat of PREMIUM_STAT_NAMES) {
        const raw = stats[stat];
        if (raw === undefined) continue;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("stat estimate must be an object.");
        if (Object.keys(raw).some((key) => !["score", "confidence", "rationale", "evidence", "reviewStatus"].includes(key))) fail("stat estimate contains unexpected fields.");
        if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) fail("stat confidence must be between zero and one.");
        if (!Array.isArray(raw.evidence)) fail("stat evidence must be an array.");
        const rationale = typeof raw.rationale === "string" ? raw.rationale.normalize("NFKC").replace(/\s+/gu, " ").trim() : raw.rationale;
        if (isNeutralPremiumStatEstimate(raw)) continue;
        result.push({ ...premiumStatPayload({ family, entity: entry.name, stat, score: raw.score, rationale }), confidence: raw.confidence, evidence: structuredClone(raw.evidence) });
      }
    }
  }
  return result;
}
