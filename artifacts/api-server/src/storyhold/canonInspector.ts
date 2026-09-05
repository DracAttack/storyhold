import { randomUUID } from "node:crypto";
import {
  extractLocalStoryEntities,
  type LocalEntityExtractionReceipt,
  type LocalStorySignal,
} from "./localEntityExtraction";
import {
  inspectLorekeeperNliPairs,
  type LorekeeperNliReceipt,
} from "./localLorekeeperModels";

type JsonRecord = Record<string, unknown>;

export type CanonInspectionViolation = {
  canonicalClaimId: string;
  generatedClaim: string;
  canonicalClaim: string;
  subject: string;
  contradictionConfidence: number;
};

export type CanonInspection = {
  status: "passed" | "violations" | "skipped" | "failed";
  candidateClaimCount: number;
  testedPairCount: number;
  violations: CanonInspectionViolation[];
  nli: LorekeeperNliReceipt;
  glinerStatus: string;
  elapsedMilliseconds: number;
  /** Private validation receipt reused by the postcheck; never a second model read. */
  localRead?: {
    model: string;
    receipt: LocalEntityExtractionReceipt;
    relations: Array<{ subject: string; relationType: string; target: string }>;
    passageKinds: string[];
  };
  errors?: string[];
};

export const GAMEPLAY_CANON_VALIDATION_BUDGET_MS = 30_000;

type GeneratedAtomicClaim = {
  subject: string;
  predicate: string;
  object: string;
  statement: string;
};

type CanonicalAtomicClaim = {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  statement: string;
};

type DirectionSupersession = {
  supersededClaimId: string;
  subject: string;
  predicate: string;
  object: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function clean(value: unknown, maximum = 500): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, maximum)
    : "";
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is JsonRecord =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function values(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => clean(item, 300)).filter(Boolean)
    : [];
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function statement(subject: string, predicate: string, object: string): string {
  return [subject, predicate, object].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function generatedClaims(signals: LocalStorySignal[]): GeneratedAtomicClaim[] {
  const generated: GeneratedAtomicClaim[] = [];
  for (const signal of signals) {
    const fields = signal.fields;
    if (signal.signalType === "story_claim") {
      const truthMode = clean(fields.truth_mode?.[0], 40).toLocaleLowerCase();
      if (truthMode && truthMode !== "fact") continue;
      const subject = clean(fields.subject?.[0], 240);
      const predicate = clean(fields.predicate?.[0], 300);
      const object = clean(fields.object?.[0], 400);
      if (subject && predicate) {
        generated.push({
          subject,
          predicate,
          object,
          statement: statement(subject, predicate, object),
        });
      }
      continue;
    }
    if (signal.signalType === "state_change") {
      const subject = clean(fields.subject?.[0], 240);
      const predicate = clean(fields.change_type?.[0], 160) || "state becomes";
      const object = clean(fields.after?.[0] ?? fields.target?.[0], 400);
      if (subject && object) {
        generated.push({
          subject,
          predicate,
          object,
          statement: statement(subject, predicate, object),
        });
      }
    }
  }
  const seen = new Set<string>();
  return generated.filter((claim) => {
    const key = normalized(claim.statement);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 48);
}

function canonicalClaims(params: {
  worldClaims: JsonRecord[];
  campaignFacts: JsonRecord[];
}): CanonicalAtomicClaim[] {
  const world = params.worldClaims.flatMap((claim): CanonicalAtomicClaim[] => {
    if (
      clean(claim.truth_status, 40) !== "fact" ||
      !["active", "disputed"].includes(clean(claim.claim_status, 40) || "active") ||
      claim.epistemic_holder_entity_id
    ) return [];
    const subject = clean(claim.subject_name ?? claim.subject, 240);
    const predicate = clean(claim.predicate, 300);
    const object = clean(claim.object_name ?? claim.object_text ?? claim.object, 400);
    if (!subject || !predicate) return [];
    return [{
      id: clean(claim.id, 100) || `world-${normalized(statement(subject, predicate, object))}`,
      subject,
      predicate,
      object,
      statement: clean(claim.summary, 700) || statement(subject, predicate, object),
    }];
  });
  const campaign = params.campaignFacts.flatMap((fact): CanonicalAtomicClaim[] => {
    if (clean(fact.stance, 40) === "superseded") return [];
    const subject = clean(fact.subject, 240);
    const predicate = clean(fact.predicate, 300);
    let object = clean(fact.object_value ?? fact.object, 400);
    if (clean(fact.stance, 40) === "denied" && object) object = `not ${object}`;
    if (!subject || !predicate) return [];
    return [{
      id: clean(fact.id, 100) || `campaign-${normalized(statement(subject, predicate, object))}`,
      subject,
      predicate,
      object,
      statement: statement(subject, predicate, object),
    }];
  });
  return [...world, ...campaign];
}

function aliasMap(entities: JsonRecord[]) {
  const aliases = new Map<string, string>();
  for (const entity of entities) {
    const name = clean(entity.name, 240);
    if (!name) continue;
    aliases.set(normalized(name), normalized(name));
    for (const alias of values(entity.aliases)) aliases.set(normalized(alias), normalized(name));
  }
  return aliases;
}

function sameSubject(
  left: string,
  right: string,
  aliases: Map<string, string>,
): boolean {
  const leftKey = aliases.get(normalized(left)) ?? normalized(left);
  const rightKey = aliases.get(normalized(right)) ?? normalized(right);
  return Boolean(leftKey && leftKey === rightKey);
}

function directionSupersessions(direction: JsonRecord): DirectionSupersession[] {
  return records(direction.propositions).flatMap((row): DirectionSupersession[] => {
    const supersededClaimId = clean(
      row.supersedesPropositionId ?? row.supersedes_proposition_id,
      100,
    );
    const subject = clean(row.subject, 240);
    const predicate = clean(row.predicate, 300);
    const object = clean(row.objectValue ?? row.object, 400);
    const causalBasis = values(row.causalBasis ?? row.causal_basis);
    const stance = clean(row.stance, 40);
    if (
      clean(row.layer, 40) !== "reality" ||
      !UUID_PATTERN.test(supersededClaimId) ||
      !subject || !predicate || !object || causalBasis.length === 0 ||
      stance !== "affirmed"
    ) return [];
    return [{ supersededClaimId, subject, predicate, object }];
  });
}

function exactDirectionSupersession(
  generated: GeneratedAtomicClaim,
  canonical: CanonicalAtomicClaim,
  supersessions: DirectionSupersession[],
  aliases: Map<string, string>,
): boolean {
  return supersessions.some((supersession) =>
    supersession.supersededClaimId === canonical.id &&
    sameSubject(supersession.subject, generated.subject, aliases) &&
    sameSubject(supersession.subject, canonical.subject, aliases) &&
    normalized(supersession.predicate) === normalized(generated.predicate) &&
    normalized(supersession.predicate) === normalized(canonical.predicate) &&
    normalized(supersession.object) === normalized(generated.object)
  );
}

export function buildCanonInspectionPairs(params: {
  generatedClaims: GeneratedAtomicClaim[];
  worldClaims: JsonRecord[];
  campaignFacts: JsonRecord[];
  entities: JsonRecord[];
  direction?: JsonRecord;
}) {
  const aliases = aliasMap(params.entities);
  const canon = canonicalClaims(params);
  const supersessions = directionSupersessions(params.direction ?? {});
  const pairContext = new Map<string, {
    generated: GeneratedAtomicClaim;
    canonical: CanonicalAtomicClaim;
  }>();
  const pairs: Array<{ id: string; premise: string; hypothesis: string }> = [];
  for (const generated of params.generatedClaims) {
    for (const canonical of canon) {
      if (!sameSubject(generated.subject, canonical.subject, aliases)) continue;
      if (normalized(generated.statement) === normalized(canonical.statement)) continue;
      if (
        exactDirectionSupersession(
          generated,
          canonical,
          supersessions,
          aliases,
        )
      ) continue;
      const id = `${canonical.id}:${pairs.length}`.slice(0, 160);
      pairs.push({
        id,
        premise: canonical.statement,
        hypothesis: generated.statement,
      });
      pairContext.set(id, { generated, canonical });
      if (pairs.length >= 160) break;
    }
    if (pairs.length >= 160) break;
  }
  return { pairs, pairContext };
}

export async function inspectGeneratedNarration(params: {
  narration: string;
  sceneSummary: string;
  direction: JsonRecord;
  worldClaims: JsonRecord[];
  campaignFacts: JsonRecord[];
  entities: JsonRecord[];
  deadlineUnixMs?: number;
}): Promise<CanonInspection> {
  const startedAt = Date.now();
  const deadlineUnixMs = Math.min(
    startedAt + GAMEPLAY_CANON_VALIDATION_BUDGET_MS,
    Number.isFinite(params.deadlineUnixMs) ? params.deadlineUnixMs! : Infinity,
  );
  let localRead: CanonInspection["localRead"];
  try {
    const local = await extractLocalStoryEntities({
      chunks: [{
        id: randomUUID(),
        sourceId: randomUUID(),
        content: `${clean(params.sceneSummary, 2_000)}\n\n${clean(params.narration, 14_000)}`,
      }],
      timeoutMilliseconds: 30_000,
      deadlineUnixMs,
      stopOnFailure: true,
    });
    localRead = {
      model: local.status.model,
      receipt: local.receipt,
      relations: local.relations.map(({ subject, relationType, target }) => ({ subject, relationType, target })),
      passageKinds: [...new Set(local.classifications.map((entry) => entry.label))],
    };
    const claims = generatedClaims(local.signals);
    const built = buildCanonInspectionPairs({
      generatedClaims: claims,
      worldClaims: params.worldClaims,
      campaignFacts: params.campaignFacts,
      entities: params.entities,
      direction: params.direction,
    });
    const nli = await inspectLorekeeperNliPairs({ pairs: built.pairs, deadlineUnixMs });
    const violations = nli.results.flatMap((result): CanonInspectionViolation[] => {
      if (
        result.contradiction < 0.82 ||
        result.contradiction < result.entailment + 0.2
      ) return [];
      const context = built.pairContext.get(result.id);
      if (!context) return [];
      return [{
        canonicalClaimId: context.canonical.id,
        generatedClaim: context.generated.statement,
        canonicalClaim: context.canonical.statement,
        subject: context.canonical.subject,
        contradictionConfidence: result.contradiction,
      }];
    }).slice(0, 12);
    const errors = [...local.receipt.errors];
    if (nli.receipt.error) errors.push(nli.receipt.error);
    const checkedPairIds = new Set(nli.results.map((result) => result.id));
    const incompleteNli = nli.receipt.status === "completed" &&
      built.pairs.some((pair) => !checkedPairIds.has(pair.id));
    if (incompleteNli) errors.push("The local NLI check did not return every requested comparison.");
    const status = violations.length ? "violations"
      : ["failed", "partial"].includes(local.receipt.status) || nli.receipt.status === "failed" || incompleteNli
        ? "failed"
        : local.receipt.status === "completed" && nli.receipt.status === "completed"
          ? "passed" : "skipped";
    return {
      status,
      candidateClaimCount: claims.length,
      testedPairCount: built.pairs.length,
      violations,
      nli: nli.receipt,
      glinerStatus: local.receipt.status,
      elapsedMilliseconds: Date.now() - startedAt,
      localRead,
      errors: errors.slice(0, 12),
    };
  } catch (error) {
    return {
      status: "failed",
      candidateClaimCount: 0,
      testedPairCount: 0,
      violations: [],
      nli: {
        status: "failed",
        model: process.env.STORYHOLD_LOCAL_NLI_MODEL?.trim() ||
          "cross-encoder/nli-deberta-v3-xsmall",
        pairCount: 0,
        elapsedMilliseconds: 0,
        error: error instanceof Error ? error.message : String(error),
      },
      glinerStatus: "failed",
      elapsedMilliseconds: Date.now() - startedAt,
      localRead,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function canonRepairInstruction(inspection: CanonInspection): string {
  return inspection.violations.map((violation) =>
    `- Do not state "${violation.generatedClaim}". Canon says: "${violation.canonicalClaim}".`,
  ).join("\n");
}
