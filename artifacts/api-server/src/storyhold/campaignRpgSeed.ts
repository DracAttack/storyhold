import {
  STORYHOLD_STAT_NAMES,
  normalizeCampaignSeed,
  type CampaignResolutionMode,
  type CampaignSeed,
  type CampaignSeedFact,
  type RpgCapability,
  type StoryholdStatName,
} from "./campaignRpgState";

type JsonRecord = Record<string, unknown>;

export type CampaignSeedClaim = {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  provenance: CampaignSeedFact["provenance"];
};

export type CampaignSeedEntityRule = {
  id?: string;
  canonicalKey?: string;
  name: string;
  description?: string;
  ruleKind?: string;
  confidence?: number;
  status?: string;
  evidence?: readonly unknown[];
  assignmentSource?: string;
  reviewStatus?: string;
  premiumVerified?: boolean;
  /** Set only by the strict cutoff projector, never by mutable dossier data. */
  temporalEvidenceVerified?: boolean;
};

export type CampaignSeedRetainedEvidence = {
  source_id?: string;
  sourceId?: string;
  chunk_id?: string;
  chunkId?: string;
  excerpt?: string;
  quote?: string;
};

export type BuildCampaignSeedInput = {
  campaignId: string;
  worldId: string;
  editionId: string;
  worldName: string;
  worldPremise?: string;
  origin: "imported" | "original";
  canonAnchor?: string | null;
  generatorVersion?: string | null;
  resolutionMode: CampaignResolutionMode;
  character: {
    id: string;
    name: string;
    estimatedStats?: unknown;
    /** Already evidence-projected scores for a historical strict launch. */
    projectedStats?: Partial<Record<StoryholdStatName, number>>;
    rules?: readonly CampaignSeedEntityRule[];
  };
  location?: { entityId?: string | null; name?: string; zone?: string | null };
  /** A player-authored opening goal. Runtime systems may advance or replace it. */
  initialObjective?: string;
  facts?: readonly CampaignSeedClaim[];
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function compact(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").replace(/\u0000/gu, "").replace(/\s+/gu, " ").trim().slice(0, maximum);
}

/**
 * Only evidence-backed or explicitly reviewed estimates become live mechanics.
 * An unsupported local placeholder remains the kernel's neutral score of ten.
 */
export function campaignStatsFromDossier(value: unknown): Partial<Record<StoryholdStatName, number>> {
  const source = record(value);
  const stats: Partial<Record<StoryholdStatName, number>> = {};
  for (const name of STORYHOLD_STAT_NAMES) {
    const estimate = record(source[name]);
    const score = Number(estimate.score);
    const confidence = Number(estimate.confidence ?? 0);
    const evidence = Array.isArray(estimate.evidence) ? estimate.evidence : [];
    const reviewStatus = compact(estimate.reviewStatus, 60).toLocaleLowerCase();
    const reviewed = ["verified", "approved", "user_confirmed", "owner_confirmed"].includes(reviewStatus);
    if (
      Number.isSafeInteger(score) && score >= 1 && score <= 20 &&
      (reviewed || (confidence >= 0.35 && evidence.length > 0))
    ) {
      stats[name] = score;
    }
  }
  return stats;
}

function normalizedEvidenceText(value: unknown): string {
  return compact(value, 4_000)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function evidenceParts(value: unknown): {
  sourceId: string;
  chunkId: string;
  quote: string;
} | null {
  const entry = record(value);
  const sourceId = compact(entry.sourceId ?? entry.source_id, 160);
  const chunkId = compact(entry.chunkId ?? entry.chunk_id, 160);
  const quote = compact(entry.quote ?? entry.excerpt, 4_000);
  return sourceId && chunkId && quote ? { sourceId, chunkId, quote } : null;
}

/** Exact source/chunk identity plus literal quotation, never mere chunk overlap. */
export function campaignEvidenceIsRetained(
  rawEvidence: unknown,
  retainedEvidence: readonly CampaignSeedRetainedEvidence[],
): boolean {
  const references = Array.isArray(rawEvidence)
    ? rawEvidence.map(evidenceParts).filter((value): value is NonNullable<typeof value> => Boolean(value))
    : [];
  if (!references.length || references.length !== (rawEvidence as unknown[]).length) return false;
  return references.every((reference) => retainedEvidence.some((rawRetained) => {
    const retained = evidenceParts(rawRetained);
    if (!retained || retained.sourceId !== reference.sourceId || retained.chunkId !== reference.chunkId) {
      return false;
    }
    const retainedQuote = normalizedEvidenceText(retained.quote);
    const referenceQuote = normalizedEvidenceText(reference.quote);
    return Boolean(referenceQuote) && retainedQuote.includes(referenceQuote);
  }));
}

/**
 * Project only stat scores with independent review authority whose complete
 * supporting passage inventory is already inside the strict cutoff snapshot.
 */
export function campaignStatsFromTemporalEvidence(params: {
  estimatedStats: unknown;
  retainedEvidence: readonly CampaignSeedRetainedEvidence[];
  premiumVerifiedStatNames?: readonly string[];
}): Partial<Record<StoryholdStatName, number>> {
  const source = record(params.estimatedStats);
  const premiumVerified = new Set(
    (params.premiumVerifiedStatNames ?? []).map((name) => compact(name, 80).toLocaleLowerCase()),
  );
  const projected: Record<string, unknown> = {};
  for (const name of STORYHOLD_STAT_NAMES) {
    const estimate = record(source[name]);
    const reviewStatus = compact(estimate.reviewStatus ?? estimate.review_status, 60)
      .toLocaleLowerCase();
    const reviewed = premiumVerified.has(name.toLocaleLowerCase()) ||
      ["verified", "approved", "user_confirmed", "owner_confirmed"].includes(reviewStatus);
    if (!reviewed || !campaignEvidenceIsRetained(estimate.evidence, params.retainedEvidence)) continue;
    projected[name] = { ...estimate, reviewStatus: "verified" };
  }
  return campaignStatsFromDossier(projected);
}

/**
 * A strict capability needs both authority and complete pre-cutoff evidence.
 * This prevents a later reveal from entering an earlier campaign through a
 * current entity-rule row.
 */
export function campaignRulesFromTemporalEvidence(params: {
  rules: readonly CampaignSeedEntityRule[];
  retainedEvidence: readonly CampaignSeedRetainedEvidence[];
}): CampaignSeedEntityRule[] {
  return params.rules.filter((rule) => {
    const source = compact(rule.assignmentSource, 40).toLocaleLowerCase();
    const review = compact(rule.reviewStatus, 60).toLocaleLowerCase();
    const authoritative = rule.temporalEvidenceVerified === true ||
      rule.premiumVerified === true || source === "user" ||
      ["verified", "approved", "user_confirmed", "owner_confirmed"].includes(review);
    return authoritative && campaignEvidenceIsRetained(rule.evidence, params.retainedEvidence);
  }).map((rule) => ({ ...rule, temporalEvidenceVerified: true }));
}

function safeId(value: unknown, fallback: string): string {
  const candidate = compact(value, 160);
  return candidate || fallback;
}

/**
 * Entity rules are descriptive canon. They may establish a capability, but
 * they do not prove mastery, so local rules begin at a conservative rank.
 */
export function campaignCapabilitiesFromRules(
  rules: readonly CampaignSeedEntityRule[] = [],
): RpgCapability[] {
  const allowedKinds = new Set(["trait", "ability", "biological", "gameplay"]);
  const seen = new Set<string>();
  const capabilities: RpgCapability[] = [];
  for (const [index, rule] of rules.entries()) {
    const name = compact(rule.name, 160);
    const kind = compact(rule.ruleKind ?? "trait", 40).toLocaleLowerCase();
    const status = compact(rule.status ?? "active", 40).toLocaleLowerCase();
    const source = compact(rule.assignmentSource, 40).toLocaleLowerCase();
    const review = compact(rule.reviewStatus, 60).toLocaleLowerCase();
    const hasSourceEvidence = Array.isArray(rule.evidence) && rule.evidence.length > 0;
    const independentlyApproved = rule.premiumVerified === true ||
      rule.temporalEvidenceVerified === true || source === "user" ||
      ["verified", "approved", "user_confirmed", "owner_confirmed"].includes(review);
    if (
      !name || !allowedKinds.has(kind) || status !== "active" ||
      (!hasSourceEvidence && !independentlyApproved)
    ) continue;
    const id = safeId(rule.id ?? rule.canonicalKey, `capability-${index + 1}`);
    if (seen.has(id)) continue;
    seen.add(id);
    const confidence = Number.isFinite(Number(rule.confidence))
      ? Math.max(0, Math.min(1, Number(rule.confidence)))
      : 0.5;
    capabilities.push({
      id,
      name,
      rank: confidence >= 0.9 ? 2 : 1,
      description: compact(rule.description, 1_000),
    });
  }
  return capabilities;
}

function campaignSeedFacts(values: readonly CampaignSeedClaim[] = []): CampaignSeedFact[] {
  const facts: CampaignSeedFact[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const subject = compact(value.subject, 500);
    const predicate = compact(value.predicate, 240);
    const object = compact(value.object, 1_000);
    if (!subject || !predicate || !object) continue;
    const id = safeId(value.id, `seed-fact-${index + 1}`);
    if (seen.has(id)) continue;
    seen.add(id);
    facts.push({
      id,
      subject,
      predicate,
      object,
      provenance: value.provenance,
      locked: true,
    });
  }
  return facts;
}

/** Build the immutable launch state shared by imported and original games. */
export function buildCampaignSeed(input: BuildCampaignSeedInput): CampaignSeed {
  const worldName = compact(input.worldName, 240);
  const characterName = compact(input.character.name, 160);
  const locationName = compact(input.location?.name, 240) || "Starting Scene";
  const initialObjective = compact(input.initialObjective, 240);
  return normalizeCampaignSeed({
    schemaVersion: 1,
    seedId: input.campaignId,
    origin: input.origin === "imported"
      ? {
          kind: "imported",
          worldId: input.worldId,
          editionId: input.editionId,
          canonAnchor: compact(input.canonAnchor, 240) || null,
        }
      : {
          kind: "original",
          worldId: input.worldId,
          generatorVersion: compact(input.generatorVersion, 160) || null,
        },
    world: {
      name: worldName,
      premise: compact(input.worldPremise, 4_000),
      facts: campaignSeedFacts(input.facts),
    },
    rules: { resolutionMode: input.resolutionMode },
    initialState: {
      activeCharacterId: input.character.id,
      characters: [{
        characterId: input.character.id,
        name: characterName,
        stats: input.character.projectedStats ??
          campaignStatsFromDossier(input.character.estimatedStats),
        capabilities: campaignCapabilitiesFromRules(input.character.rules),
      }],
      location: {
        entityId: compact(input.location?.entityId, 160) || null,
        name: locationName,
        zone: compact(input.location?.zone, 240) || null,
      },
      companions: [],
      reputations: [],
      objectives: initialObjective
        ? [{
            id: "opening-objective",
            title: initialObjective,
            description: "",
            status: "active",
            progress: 0,
            target: 1,
          }]
        : [],
      sharedResources: [],
    },
  });
}
