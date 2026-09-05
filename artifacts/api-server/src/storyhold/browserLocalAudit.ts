import { createHash, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { Express, Request, RequestHandler } from "express";
import type {
  EvidenceReference,
  WorldFindings,
} from "./worldAnalysis";
import {
  CreditEconomyError,
  releaseCreditReservation,
  reserveCredits,
  settleFixedCreditReservationInTransaction,
} from "./creditEconomy";
import {
  BROWSER_QWEN_PRICING_VERSION,
  browserQwenUsageCredits,
  estimatedTokensFromCharacters,
} from "./canonIntakePricing";
import {
  syncWorldEntityMentions,
} from "./worldKnowledge";
import { syncWorldConceptGraph } from "./conceptResolution";
import { refreshWorldQualityFindings } from "./worldQuality";
import { repairGeneratedCharacterIdentities } from "./characterIdentity";
import {
  classifyLorekeeperQwenAudit,
  releaseLorekeeperStage,
} from "./localLorekeeperModels";
import {
  localCharacterNameIsUseful,
  localEntityTextIsUseful,
} from "./localEntityExtraction";

type AuditDb = Pick<PGlite, "query">;
type AuditRootDb = AuditDb & Pick<PGlite, "exec" | "transaction">;
type AuditUser = { id: string; email: string; role: string };
type AuditRequest = Request & { localUser?: AuditUser };

export type BrowserAuditVerdict =
  | "confirm"
  | "reclassify"
  | "merge"
  | "reject"
  | "uncertain";

export type BrowserAuditCandidate = {
  candidateKey: string;
  kind: "concept" | "character" | "relationship" | "claim" | "event" | "rule";
  category: string;
  name: string;
  summary: string;
  aliases: string[];
  evidence: EvidenceReference[];
};

export type BrowserAuditDecision = {
  candidateKey: string;
  verdict: BrowserAuditVerdict;
  correctedName: string;
  correctedCategory: string;
  aliases: string[];
  interpretation: string;
  concerns: string[];
  confidence: number;
};

export type BrowserAuditBatch = {
  auditId: string;
  batchIndex: number;
  totalBatches: number;
  candidates: BrowserAuditCandidate[];
};

export type SerializedBrowserAudit = {
  id: string;
  status: "pending" | "running" | "paused" | "completed" | "skipped" | "failed";
  model: string;
  totalCandidates: number;
  totalBatches: number;
  completedBatches: number;
  progress: number;
  stage: string;
  error: string | null;
  chargeStatus: "pending" | "reserved" | "settled" | "unlimited" | "released";
  missingQueries: string[];
  nextBatch: BrowserAuditBatch | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export const browserLocalAuditSchemaSql = String.raw`
  CREATE TABLE IF NOT EXISTS storyhold.browser_local_audits (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    canon_edition_id uuid NOT NULL REFERENCES storyhold.canon_editions(id) ON DELETE CASCADE,
    requested_by_player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE RESTRICT,
    local_analysis_run_id uuid REFERENCES storyhold.world_analysis_runs(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'paused', 'completed', 'skipped', 'failed')),
    model text NOT NULL DEFAULT 'Qwen3.5-0.8B-q4f16_1-MLC',
    trigger_kind text NOT NULL DEFAULT 'manual'
      CHECK (trigger_kind IN ('upload', 'manual')),
    force_full boolean NOT NULL DEFAULT false,
    user_guidance text NOT NULL DEFAULT '',
    total_candidates integer NOT NULL DEFAULT 0 CHECK (total_candidates >= 0),
    total_batches integer NOT NULL DEFAULT 0 CHECK (total_batches >= 0),
    completed_batches integer NOT NULL DEFAULT 0 CHECK (completed_batches >= 0),
    missing_queries jsonb NOT NULL DEFAULT '[]'::jsonb,
    device_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
    elapsed_ms integer NOT NULL DEFAULT 0 CHECK (elapsed_ms >= 0),
    pricing_version text NOT NULL DEFAULT 'browser-qwen-v1',
    reserved_input_units integer NOT NULL DEFAULT 0 CHECK (reserved_input_units >= 0),
    reserved_output_units integer NOT NULL DEFAULT 0 CHECK (reserved_output_units >= 0),
    actual_input_units integer NOT NULL DEFAULT 0 CHECK (actual_input_units >= 0),
    actual_output_units integer NOT NULL DEFAULT 0 CHECK (actual_output_units >= 0),
    price_credits integer NOT NULL DEFAULT 0 CHECK (price_credits >= 0),
    credits_charged integer NOT NULL DEFAULT 0 CHECK (credits_charged >= 0),
    charge_status text NOT NULL DEFAULT 'pending'
      CHECK (charge_status IN ('pending', 'reserved', 'settled', 'unlimited', 'released')),
    credit_reservation_id uuid,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    UNIQUE (local_analysis_run_id)
  );

  CREATE INDEX IF NOT EXISTS browser_local_audits_world
    ON storyhold.browser_local_audits (world_id, canon_edition_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS storyhold.browser_local_audit_batches (
    audit_id uuid NOT NULL REFERENCES storyhold.browser_local_audits(id) ON DELETE CASCADE,
    batch_index integer NOT NULL CHECK (batch_index >= 0),
    status text NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'completed', 'failed')),
    candidate_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
    packet jsonb NOT NULL DEFAULT '{}'::jsonb,
    result jsonb NOT NULL DEFAULT '{}'::jsonb,
    input_units integer NOT NULL DEFAULT 0 CHECK (input_units >= 0),
    output_units integer NOT NULL DEFAULT 0 CHECK (output_units >= 0),
    error text,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (audit_id, batch_index)
  );
`;

// Keep upgrades safe for databases created before browser metering existed.
export const browserLocalAuditPricingSchemaSql = String.raw`
  ALTER TABLE storyhold.browser_local_audits
    ADD COLUMN IF NOT EXISTS pricing_version text NOT NULL DEFAULT 'browser-qwen-v1';
  ALTER TABLE storyhold.browser_local_audits
    ADD COLUMN IF NOT EXISTS reserved_input_units integer NOT NULL DEFAULT 0 CHECK (reserved_input_units >= 0);
  ALTER TABLE storyhold.browser_local_audits
    ADD COLUMN IF NOT EXISTS reserved_output_units integer NOT NULL DEFAULT 0 CHECK (reserved_output_units >= 0);
  ALTER TABLE storyhold.browser_local_audits
    ADD COLUMN IF NOT EXISTS actual_input_units integer NOT NULL DEFAULT 0 CHECK (actual_input_units >= 0);
  ALTER TABLE storyhold.browser_local_audits
    ADD COLUMN IF NOT EXISTS actual_output_units integer NOT NULL DEFAULT 0 CHECK (actual_output_units >= 0);
  ALTER TABLE storyhold.browser_local_audits
    ADD COLUMN IF NOT EXISTS price_credits integer NOT NULL DEFAULT 0 CHECK (price_credits >= 0);
  ALTER TABLE storyhold.browser_local_audits
    ADD COLUMN IF NOT EXISTS credits_charged integer NOT NULL DEFAULT 0 CHECK (credits_charged >= 0);
  ALTER TABLE storyhold.browser_local_audits
    ADD COLUMN IF NOT EXISTS charge_status text NOT NULL DEFAULT 'pending';
  ALTER TABLE storyhold.browser_local_audits
    ADD COLUMN IF NOT EXISTS credit_reservation_id uuid;
  ALTER TABLE storyhold.browser_local_audits
    ADD COLUMN IF NOT EXISTS applied_at timestamptz;
  ALTER TABLE storyhold.browser_local_audits
    ADD COLUMN IF NOT EXISTS application_summary jsonb NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE storyhold.browser_local_audit_batches
    ADD COLUMN IF NOT EXISTS input_units integer NOT NULL DEFAULT 0 CHECK (input_units >= 0);
  ALTER TABLE storyhold.browser_local_audit_batches
    ADD COLUMN IF NOT EXISTS output_units integer NOT NULL DEFAULT 0 CHECK (output_units >= 0);
`;

const ENTITY_CATEGORIES: Array<{
  category: string;
  key: keyof WorldFindings;
}> = [
  { category: "world_rule", key: "worldRules" },
  { category: "place", key: "locations" },
  { category: "faction", key: "factions" },
  { category: "institution", key: "institutions" },
  { category: "government", key: "governments" },
  { category: "power_structure", key: "powerStructures" },
  { category: "creature", key: "creatures" },
  { category: "species", key: "species" },
  { category: "technology", key: "technologies" },
  { category: "vehicle", key: "vehicles" },
  { category: "device", key: "devices" },
  { category: "weapon", key: "weapons" },
  { category: "power", key: "powers" },
  { category: "title", key: "titles" },
  { category: "ambiguous", key: "ambiguous" },
];

function cleanText(value: unknown, limit: number) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function cleanStrings(value: unknown, limit = 24, itemLimit = 180) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item, itemLimit)).filter(Boolean))]
    .slice(0, limit);
}

function cleanEvidence(value: unknown, limit = 4): EvidenceReference[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: EvidenceReference[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const chunkId = cleanText(record.chunkId, 80);
    const sourceId = cleanText(record.sourceId, 80);
    const quote = cleanText(record.quote, 500);
    if (!chunkId || !sourceId || !quote) continue;
    const key = `${chunkId}:${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ chunkId, sourceId, quote });
    if (result.length >= limit) break;
  }
  return result;
}

function candidateKey(input: Omit<BrowserAuditCandidate, "candidateKey">) {
  return createHash("sha256")
    .update(JSON.stringify([
      input.kind,
      input.category,
      input.name,
      input.summary,
      input.evidence.map((entry) => [entry.chunkId, entry.quote]),
    ]))
    .digest("hex")
    .slice(0, 32);
}

function addCandidate(
  target: BrowserAuditCandidate[],
  input: Omit<BrowserAuditCandidate, "candidateKey">,
) {
  if (!input.name || input.evidence.length === 0) return;
  const candidate: BrowserAuditCandidate = {
    ...input,
    candidateKey: candidateKey(input),
  };
  if (!target.some((existing) => existing.candidateKey === candidate.candidateKey)) {
    target.push(candidate);
  }
}

function looksLikeProperNamedConcept(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 8) return false;
  return words.every((word) =>
    /^(?:[A-Z][\p{L}\p{N}'’.-]*|[A-Z0-9]{2,}|(?:the|of|and|or|in|on|at|for|to))$/u.test(word),
  );
}

function locallyPromotedNamedFinding(
  item: Record<string, unknown>,
  evidence: EvidenceReference[],
) {
  const confidence = Number(item.confidence) || 0;
  const mentionCount = Math.max(0, Number(item.mentionCount) || 0);
  const reviewStatus = cleanText(item.reviewStatus, 40);
  const name = cleanText(item.name, 240);
  return reviewStatus === "verified" ||
    mentionCount >= 3 ||
    (confidence >= 0.72 && evidence.length >= 2) ||
    evidence.length >= 3 ||
    looksLikeProperNamedConcept(name);
}

function locallyPromotedBrowserCandidate(candidate: BrowserAuditCandidate) {
  if (candidate.kind === "character") return true;
  if (candidate.kind === "concept") {
    return candidate.evidence.length >= 3 || looksLikeProperNamedConcept(candidate.name);
  }
  if (candidate.kind === "relationship") return candidate.evidence.length >= 2;
  return true;
}

/**
 * Builds a complete audit inventory from locally proposed, source-grounded
 * findings. The browser model audits these compact records; it never replaces
 * the whole-corpus reader and cannot write canon directly.
 */
export function browserAuditCandidates(findings: WorldFindings) {
  const candidates: BrowserAuditCandidate[] = [];
  for (const entry of ENTITY_CATEGORIES) {
    const values = findings[entry.key];
    if (!Array.isArray(values)) continue;
    for (const raw of values) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const evidence = cleanEvidence(item.evidence);
      if (!locallyPromotedNamedFinding(item, evidence)) continue;
      addCandidate(candidates, {
        kind: "concept",
        category: entry.category,
        name: cleanText(item.name, 240),
        summary: cleanText(item.summary, 1_200),
        aliases: cleanStrings(item.aliases),
        evidence,
      });
    }
  }
  for (const character of findings.characters) {
    addCandidate(candidates, {
      kind: "character",
      category: "character",
      name: cleanText(character.name, 240),
      summary: cleanText(character.summary || character.role, 1_200),
      aliases: cleanStrings(character.aliases),
      evidence: cleanEvidence(character.evidence),
    });
  }
  for (const relation of findings.entityRelations) {
    const evidence = cleanEvidence(relation.evidence);
    if (evidence.length < 2 && Number(relation.confidence) < 0.78) continue;
    addCandidate(candidates, {
      kind: "relationship",
      category: relation.relationType,
      name: `${cleanText(relation.subject, 180)} → ${cleanText(relation.target, 180)}`,
      summary: cleanText(
        relation.summary || `${relation.subject} ${relation.relationType} ${relation.target}`,
        1_200,
      ),
      aliases: [],
      evidence,
    });
  }
  for (const claim of findings.claims ?? []) {
    addCandidate(candidates, {
      kind: "claim",
      category: claim.truthStatus,
      name: `${cleanText(claim.subject, 180)} · ${cleanText(claim.predicate, 160)}`,
      summary: cleanText(
        `${claim.subject} ${claim.polarity === "negative" ? "does not " : ""}${claim.predicate} ${claim.value}`,
        1_200,
      ),
      aliases: cleanStrings(claim.epistemicHolder ? [`Known/believed by ${claim.epistemicHolder}`] : []),
      evidence: cleanEvidence(claim.evidence),
    });
  }
  for (const event of findings.chronology) {
    addCandidate(candidates, {
      kind: "event",
      category: event.temporalStatus ?? "relative",
      name: cleanText(event.name, 240),
      summary: cleanText(event.summary, 1_200),
      aliases: cleanStrings([
        event.worldTimeLabel ?? "",
        ...(event.sourceChapterKeys ?? []),
      ]),
      evidence: cleanEvidence(event.evidence),
    });
  }
  for (const rule of findings.entityRules) {
    addCandidate(candidates, {
      kind: "rule",
      category: rule.ruleKind,
      name: `${cleanText(rule.entity, 180)} · ${cleanText(rule.name, 200)}`,
      summary: cleanText(rule.description || `${rule.trigger} → ${rule.effect}`, 1_200),
      aliases: [],
      evidence: cleanEvidence(rule.evidence),
    });
  }
  return candidates;
}

type StrongConceptConsensus = {
  preferredCandidateKey: string;
  preferredName: string;
  preferredCategory: string;
  strong: true;
};

function conceptConsensusKey(name: string) {
  return normalizedEntityLabel(name).replace(/^the\s+/u, "");
}

/**
 * When two cheap passes assign the same surface to different categories, a
 * much broader exact-evidence record can overrule a one-quote classifier miss.
 * Close calls remain untouched for premium/owner review.
 */
export function strongConceptConsensus(candidates: BrowserAuditCandidate[]) {
  const groups = new Map<string, BrowserAuditCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.kind !== "concept") continue;
    const key = conceptConsensusKey(candidate.name);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  const output = new Map<string, StrongConceptConsensus>();
  for (const group of groups.values()) {
    if (new Set(group.map((candidate) => candidate.category)).size < 2) continue;
    const ranked = [...group].sort((left, right) =>
      right.evidence.length - left.evidence.length ||
      Number(looksLikeProperNamedConcept(right.name)) - Number(looksLikeProperNamedConcept(left.name)) ||
      right.summary.length - left.summary.length,
    );
    const preferred = ranked[0]!;
    const runnerUp = ranked[1]!;
    if (preferred.evidence.length < 3 || preferred.evidence.length - runnerUp.evidence.length < 2) continue;
    const consensus: StrongConceptConsensus = {
      preferredCandidateKey: preferred.candidateKey,
      preferredName: preferred.name,
      preferredCategory: preferred.category,
      strong: true,
    };
    for (const candidate of group) output.set(candidate.candidateKey, consensus);
  }
  return output;
}

function compactPromptCandidates(candidates: BrowserAuditCandidate[]) {
  return candidates.map((candidate, index) => [
    index,
    candidate.kind,
    candidate.category,
    candidate.name,
    candidate.summary.slice(0, 260),
    candidate.aliases.slice(0, 8),
    candidate.evidence
      .slice(0, candidate.kind === "character" || candidate.kind === "relationship" ? 2 : 1)
      .map((entry) => entry.quote.slice(0, 360)),
  ]);
}

export function localQwenAuditClassificationPrompt(
  candidate: BrowserAuditCandidate,
): string {
  return `You classify manuscript extraction records using only one label: valid, noise, unknown, wrong, alias.
valid: quoted evidence uses the proposed name as a real named entity of the proposed category.
noise: filler, profanity, pronoun, fragment, heading, or generic common noun falsely promoted as a proper name.
unknown: the quote is not enough to decide.
wrong: a real named entity, but the proposed category is clearly wrong.
alias: clearly another surface form of an already named entity.
Examples:
character Mara | "Mara opened the door." => valid
character Damn | "Damn it!" => noise
place Shadow | "a shadow moved across the wall" => noise
place Glass Harbor | "Iona entered Glass Harbor." => valid
place Macon | "We continued toward Macon, one of the larger towns." => valid
government Macon | "We continued toward Macon, one of the larger towns." => wrong
creature the Emberkin | "The Emberkin raised their armored hands." => valid
technology Emberkin | "Do you know anything about the Emberkin?" => wrong
species they | "They waited by the gate." => noise
creature The Home | "CHAPTER TWELVE: THE HOME" => noise
character Body | "A body lay beside the road." => noise
Separate literal fact from metaphor, belief, rumor, dispute, former state, and mistakes. Never use outside lore. When unsure choose unknown.
Now classify this [kind,category,name,summary,aliases,evidenceQuotes] record:
${JSON.stringify(compactPromptCandidates([candidate])[0])}
Answer with exactly one lowercase label from valid, noise, unknown, wrong, alias and nothing else. Label:`;
}

async function locallyAccelerateQwenBatch(packet: BrowserAuditBatch) {
  const receipt = await classifyLorekeeperQwenAudit({
    prompts: packet.candidates.map((candidate, index) => ({
      index,
      text: localQwenAuditClassificationPrompt(candidate),
    })),
  });
  const verdicts: Record<string, BrowserAuditVerdict> = {
    c: "confirm",
    x: "reject",
    u: "uncertain",
    // A logits-only classification cannot safely name a merge target or the
    // corrected category. Preserve these leads for premium verification rather
    // than manufacturing the missing detail.
    r: "uncertain",
    m: "uncertain",
  };
  return {
    result: {
      audits: packet.candidates.map((candidate, index): BrowserAuditDecision => {
        const decision = receipt.decisions.find((entry) => entry.index === index);
        if (!decision) throw new Error(`Qwen omitted audit record ${index}.`);
        const downgraded = decision.code === "r" || decision.code === "m";
        return {
          candidateKey: candidate.candidateKey,
          verdict: verdicts[decision.code] ?? "uncertain",
          correctedName: "",
          correctedCategory: "",
          aliases: [],
          interpretation: "",
          concerns: downgraded
            ? [decision.code === "m"
              ? "Possible alias or duplicate requires evidence-complete verification."
              : "Possible category correction requires evidence-complete verification."]
            : [],
          confidence: downgraded ? Math.min(0.79, decision.confidence) : decision.confidence,
        };
      }),
      missingQueries: [],
    },
    receipt,
  };
}

function packetSize(candidates: BrowserAuditCandidate[]) {
  // The browser does not need durable chunk/source UUIDs or repeated field
  // names. Size batches against the exact compact, evidence-complete prompt
  // representation that Qwen receives, while retaining the full packet in the
  // vault for exact-once validation and later premium verification.
  return JSON.stringify(compactPromptCandidates(candidates)).length;
}

export function packBrowserAuditCandidates(
  candidates: BrowserAuditCandidate[],
  maximumCandidates = 6,
  maximumCharacters = 3_500,
) {
  const batches: BrowserAuditCandidate[][] = [];
  let current: BrowserAuditCandidate[] = [];
  for (const candidate of candidates) {
    const proposed = [...current, candidate];
    if (
      current.length > 0 &&
      (proposed.length > maximumCandidates || packetSize(proposed) > maximumCharacters)
    ) {
      batches.push(current);
      current = [candidate];
    } else {
      current = proposed;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

export function browserAuditReservedUsage(
  batches: BrowserAuditCandidate[][],
) {
  // The browser prompt adds roughly 1,600 characters of evidence-bound rules
  // around each JSON packet. Reserve against the complete compact workload and
  // the 4K-safe output ceiling; final settlement uses the model's actual units.
  const promptCharacters = batches.reduce(
    (total, batch) => total + packetSize(batch) + 1_600,
    0,
  );
  return {
    inputTokens: estimatedTokensFromCharacters(promptCharacters),
    outputTokens: batches.length * 240,
  };
}

export async function createBrowserLocalAudit(params: {
  db: AuditDb;
  worldId: string;
  editionId: string;
  playerId: string;
  localAnalysisRunId: string;
  findings: WorldFindings;
  trigger: "upload" | "manual";
  forceFull: boolean;
  userGuidance?: string;
}) {
  const existing = await params.db.query<{ id: string }>(
    `SELECT id FROM storyhold.browser_local_audits
      WHERE local_analysis_run_id = $1 LIMIT 1`,
    [params.localAnalysisRunId],
  );
  if (existing.rows[0]) return { id: existing.rows[0].id, queued: true };
  const candidates = browserAuditCandidates(params.findings);
  const batches = packBrowserAuditCandidates(candidates);
  if (!batches.length) return { id: null, queued: false };
  const reservedUsage = browserAuditReservedUsage(batches);
  // The browser verifier is one of Canon Intake's included local stages. Keep
  // its measured units for margin and capacity telemetry, but never create a
  // second customer charge after the cumulative world-intake price is paid.
  const priceCredits = 0;
  const auditId = randomUUID();
  await params.db.query(
    `UPDATE storyhold.browser_local_audits
        SET status = 'skipped', error = 'Superseded by a newer local inventory.',
            completed_at = now()
      WHERE world_id = $1 AND canon_edition_id = $2
        AND status IN ('pending', 'running', 'paused')`,
    [params.worldId, params.editionId],
  );
  await params.db.query(
    `INSERT INTO storyhold.browser_local_audits
      (id, world_id, canon_edition_id, requested_by_player_id,
       local_analysis_run_id, trigger_kind, force_full, user_guidance,
       total_candidates, total_batches, pricing_version,
       reserved_input_units, reserved_output_units, price_credits)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      auditId,
      params.worldId,
      params.editionId,
      params.playerId,
      params.localAnalysisRunId,
      params.trigger,
      params.forceFull,
      cleanText(params.userGuidance, 4_000),
      candidates.length,
      batches.length,
      BROWSER_QWEN_PRICING_VERSION,
      reservedUsage.inputTokens,
      reservedUsage.outputTokens,
      priceCredits,
    ],
  );
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    await params.db.query(
      `INSERT INTO storyhold.browser_local_audit_batches
        (audit_id, batch_index, candidate_keys, packet)
       VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
      [
        auditId,
        index,
        JSON.stringify(batch.map((candidate) => candidate.candidateKey)),
        JSON.stringify({
          auditId,
          batchIndex: index,
          totalBatches: batches.length,
          candidates: batch,
        }),
      ],
    );
  }
  return { id: auditId, queued: true };
}

function arrayBody(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function recordBody(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function routeParam(req: Request, key: string) {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function currentUser(req: AuditRequest) {
  if (!req.localUser) throw new Error("Authentication middleware did not attach a user.");
  return req.localUser;
}

function parseBatchPacket(value: unknown): BrowserAuditBatch | null {
  const record = recordBody(value);
  const candidates = arrayBody(record.candidates).filter(
    (entry): entry is BrowserAuditCandidate => Boolean(
      entry && typeof entry === "object" && cleanText((entry as BrowserAuditCandidate).candidateKey, 64),
    ),
  );
  const auditId = cleanText(record.auditId, 80);
  const batchIndex = Number(record.batchIndex);
  const totalBatches = Number(record.totalBatches);
  if (!auditId || !Number.isInteger(batchIndex) || !Number.isInteger(totalBatches)) return null;
  return { auditId, batchIndex, totalBatches, candidates };
}

function parseDecision(value: unknown): BrowserAuditDecision | null {
  const record = recordBody(value);
  const candidateKey = cleanText(record.candidateKey, 64);
  const verdict = cleanText(record.verdict, 40) as BrowserAuditVerdict;
  if (!candidateKey || !new Set<BrowserAuditVerdict>([
    "confirm", "reclassify", "merge", "reject", "uncertain",
  ]).has(verdict)) return null;
  return {
    candidateKey,
    verdict,
    correctedName: cleanText(record.correctedName, 240),
    correctedCategory: cleanText(record.correctedCategory, 80),
    aliases: cleanStrings(record.aliases),
    interpretation: cleanText(record.interpretation, 1_200),
    concerns: cleanStrings(record.concerns, 12, 300),
    confidence: Math.max(0, Math.min(1, Number(record.confidence) || 0)),
  };
}

function validateBatchResult(packet: BrowserAuditBatch, value: unknown) {
  const record = recordBody(value);
  const decisions = arrayBody(record.audits)
    .map(parseDecision)
    .filter((entry): entry is BrowserAuditDecision => Boolean(entry));
  const required = packet.candidates.map((candidate) => candidate.candidateKey);
  const returned = decisions.map((decision) => decision.candidateKey);
  if (
    returned.length !== required.length ||
    new Set(returned).size !== returned.length ||
    required.some((key) => !returned.includes(key)) ||
    returned.some((key) => !required.includes(key))
  ) {
    throw new Error("The private browser audit did not account for every supplied finding exactly once.");
  }
  return {
    audits: decisions,
    missingQueries: cleanStrings(record.missingQueries, 40, 300),
  };
}

async function auditScope(
  db: AuditDb,
  auditId: string,
  playerId: string,
) {
  const result = await db.query<Record<string, unknown>>(
    `SELECT audit.*
       FROM storyhold.browser_local_audits audit
       JOIN storyhold.worlds world ON world.id = audit.world_id
      WHERE audit.id = $1 AND world.owner_player_id = $2
      LIMIT 1`,
    [auditId, playerId],
  );
  return result.rows[0] ?? null;
}

export async function latestBrowserAudit(
  db: AuditDb,
  worldId: string,
  playerId: string,
): Promise<SerializedBrowserAudit | null> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT audit.*
       FROM storyhold.browser_local_audits audit
       JOIN storyhold.worlds world ON world.id = audit.world_id
      WHERE audit.world_id = $1 AND world.owner_player_id = $2
      ORDER BY audit.created_at DESC, audit.id DESC
      LIMIT 1`,
    [worldId, playerId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const pending = await db.query<{ packet: unknown }>(
    `SELECT packet FROM storyhold.browser_local_audit_batches
      WHERE audit_id = $1 AND status <> 'completed'
      ORDER BY batch_index ASC LIMIT 1`,
    [row.id],
  );
  const totalBatches = Number(row.total_batches ?? 0);
  const completedBatches = Number(row.completed_batches ?? 0);
  const status = row.status as SerializedBrowserAudit["status"];
  const chargeStatus = (
    cleanText(row.charge_status, 40) || "pending"
  ) as SerializedBrowserAudit["chargeStatus"];
  const chargeReady = new Set(["reserved", "settled", "unlimited"]).has(
    chargeStatus,
  );
  return {
    id: String(row.id),
    status,
    model: cleanText(row.model, 200),
    totalCandidates: Number(row.total_candidates ?? 0),
    totalBatches,
    completedBatches,
    progress: status === "completed" || status === "skipped"
      ? 100
      : Math.round((completedBatches / Math.max(1, totalBatches)) * 100),
    stage: status === "pending"
      ? "Private browser intelligence is ready to start"
      : status === "running"
        ? `Checking story concepts ${completedBatches + 1} of ${totalBatches}`
        : status === "paused"
          ? "Private browser intelligence is paused"
          : status === "completed"
            ? "Private browser audit complete"
            : status === "skipped"
              ? "Private browser audit skipped"
              : "Private browser audit needs attention",
    error: row.error ? String(row.error) : null,
    chargeStatus,
    missingQueries: cleanStrings(row.missing_queries, 100, 300),
    nextBatch: chargeReady && (status === "pending" || status === "running")
      ? parseBatchPacket(pending.rows[0]?.packet)
      : null,
    createdAt: String(row.created_at),
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

export async function browserLocalAuditContext(
  db: AuditDb,
  worldId: string,
  editionId: string,
) {
  const audit = await db.query<{ id: string; missing_queries: unknown }>(
    `SELECT id, missing_queries FROM storyhold.browser_local_audits
      WHERE world_id = $1 AND canon_edition_id = $2 AND status = 'completed'
      ORDER BY completed_at DESC, created_at DESC LIMIT 1`,
    [worldId, editionId],
  );
  if (!audit.rows[0]) return "";
  const batches = await db.query<{ result: unknown }>(
    `SELECT result FROM storyhold.browser_local_audit_batches
      WHERE audit_id = $1 AND status = 'completed'
      ORDER BY batch_index ASC`,
    [audit.rows[0].id],
  );
  const decisions = batches.rows.flatMap((row) =>
    arrayBody(recordBody(row.result).audits)
      .map(parseDecision)
      .filter((entry): entry is BrowserAuditDecision => Boolean(entry)),
  );
  const useful = decisions.filter((decision) =>
    decision.verdict !== "confirm" || decision.concerns.length > 0,
  );
  return JSON.stringify({
    instruction: "Unverified local audit leads. Verify every suggestion against supplied SOURCE passages; never cite or promote this packet by itself.",
    decisions: useful.slice(0, 300),
    missingQueries: cleanStrings(audit.rows[0].missing_queries, 100, 300),
  }).slice(0, 24_000);
}

export async function resumePausedBrowserLocalAudit(
  db: AuditRootDb,
  auditId: string,
  chargeStatus: string,
) {
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE storyhold.browser_local_audit_batches
          SET status = 'pending', error = NULL, updated_at = now()
        WHERE audit_id = $1 AND status = 'failed'`,
      [auditId],
    );
    const savedBatches = await tx.query<{ packet: unknown; status: string }>(
      `SELECT packet, status
         FROM storyhold.browser_local_audit_batches
        WHERE audit_id = $1
        ORDER BY batch_index`,
      [auditId],
    );
    const hasCompletedBatch = savedBatches.rows.some((row) => row.status === "completed");
    if (!hasCompletedBatch) {
      const originalCandidates = savedBatches.rows.flatMap((row) =>
        parseBatchPacket(row.packet)?.candidates ?? [],
      );
      // Older audits stored every raw scanner proposal. Preserve those in the
      // vault, but migrate the still-unstarted browser workload to the same
      // local-promotion boundary used by new intakes.
      const savedCandidates = originalCandidates.filter(locallyPromotedBrowserCandidate);
      const repacked = packBrowserAuditCandidates(savedCandidates);
      if (
        repacked.length > 0 &&
        (repacked.length !== savedBatches.rows.length ||
          savedCandidates.length !== originalCandidates.length)
      ) {
        const reservedUsage = browserAuditReservedUsage(repacked);
        await tx.query(
          `DELETE FROM storyhold.browser_local_audit_batches WHERE audit_id = $1`,
          [auditId],
        );
        for (let index = 0; index < repacked.length; index += 1) {
          const candidates = repacked[index];
          await tx.query(
            `INSERT INTO storyhold.browser_local_audit_batches
              (audit_id, batch_index, candidate_keys, packet)
             VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
            [
              auditId,
              index,
              JSON.stringify(candidates.map((candidate) => candidate.candidateKey)),
              JSON.stringify({
                auditId,
                batchIndex: index,
                totalBatches: repacked.length,
                candidates,
              }),
            ],
          );
        }
        await tx.query(
          `UPDATE storyhold.browser_local_audits
              SET total_candidates = $2, total_batches = $3, completed_batches = 0,
                  reserved_input_units = $4, reserved_output_units = $5
            WHERE id = $1`,
          [
            auditId,
            savedCandidates.length,
            repacked.length,
            reservedUsage.inputTokens,
            reservedUsage.outputTokens,
          ],
        );
      }
    }
    const aggregate = await tx.query<{ completed: number }>(
      `SELECT count(*) FILTER (WHERE status = 'completed')::int AS completed
         FROM storyhold.browser_local_audit_batches
        WHERE audit_id = $1`,
      [auditId],
    );
    const chargeReady = ["reserved", "settled", "unlimited"].includes(chargeStatus);
    await tx.query(
      `UPDATE storyhold.browser_local_audits
          SET status = $2, completed_batches = $3, error = NULL,
              completed_at = NULL
        WHERE id = $1`,
      [auditId, chargeReady ? "running" : "pending", Number(aggregate.rows[0]?.completed ?? 0)],
    );
  });
}

async function repackUnstartedAuditForLocalAcceleration(
  db: AuditRootDb,
  auditId: string,
) {
  await db.transaction(async (tx) => {
    const rows = await tx.query<{ packet: unknown; status: string }>(
      `SELECT packet, status FROM storyhold.browser_local_audit_batches
        WHERE audit_id = $1 ORDER BY batch_index`,
      [auditId],
    );
    if (rows.rows.some((row) => row.status === "completed")) return;
    const candidates = rows.rows.flatMap((row) =>
      parseBatchPacket(row.packet)?.candidates ?? [],
    );
    const batches = packBrowserAuditCandidates(candidates, 28, 16_000);
    if (!batches.length || batches.length >= rows.rows.length) return;
    const reservedUsage = browserAuditReservedUsage(batches);
    await tx.query(
      `DELETE FROM storyhold.browser_local_audit_batches WHERE audit_id = $1`,
      [auditId],
    );
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      await tx.query(
        `INSERT INTO storyhold.browser_local_audit_batches
          (audit_id, batch_index, candidate_keys, packet)
         VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
        [
          auditId,
          index,
          JSON.stringify(batch.map((candidate) => candidate.candidateKey)),
          JSON.stringify({
            auditId,
            batchIndex: index,
            totalBatches: batches.length,
            candidates: batch,
          }),
        ],
      );
    }
    await tx.query(
      `UPDATE storyhold.browser_local_audits
          SET total_batches = $2, completed_batches = 0,
              reserved_input_units = $3, reserved_output_units = $4,
              model = 'Qwen/Qwen3.5-0.8B (Local Acceleration)',
              error = NULL
        WHERE id = $1`,
      [auditId, batches.length, reservedUsage.inputTokens, reservedUsage.outputTokens],
    );
  });
}

const AUDIT_ENTITY_TYPES = new Set([
  "character", "creature", "species", "place", "faction", "institution",
  "government", "power_structure", "technology", "vehicle", "device",
  "weapon", "power", "title", "ambiguous",
]);

function normalizedEntityLabel(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const CHARACTER_SURFACE_PREFIX_NOISE = new Set([
  "baby", "big", "dear", "little", "old", "poor", "tiny", "young",
]);
const CHARACTER_SURFACE_SUFFIX_NOISE = new Set(["past", "present"]);
const CHARACTER_SURFACE_TITLES = new Set([
  "admiral", "captain", "chief", "colonel", "commander", "doctor", "dr",
  "emperor", "empress", "general", "king", "lady", "lieutenant", "lord",
  "major", "master", "mistress", "officer", "professor", "queen", "saint",
  "sergeant", "sir", "mr", "mrs", "ms", "miss", "father", "mother",
]);

function characterSurfaceQuality(value: string) {
  const tokens = normalizedEntityLabel(value).split(/\s+/u).filter(Boolean);
  const repeated = tokens.some((token, index) => index > 0 && token === tokens[index - 1]);
  const decorated = tokens.length > 1 && (
    CHARACTER_SURFACE_PREFIX_NOISE.has(tokens[0]!) ||
    CHARACTER_SURFACE_SUFFIX_NOISE.has(tokens[tokens.length - 1]!) ||
    CHARACTER_SURFACE_TITLES.has(tokens[0]!)
  );
  return { tokens, lowQuality: repeated || decorated };
}

export function generatedCharacterAliasIsUseful(value: string) {
  const tokens = characterSurfaceQuality(value).tokens;
  return tokens.length > 0 && !tokens.some((token, index) =>
    index > 0 && token === tokens[index - 1]
  );
}

/** Choose the durable card label while retaining narrative variants as aliases. */
export function preferredGeneratedCharacterLabel(input: {
  name: string;
  aliases: string[];
  literalMentionCounts: Map<string, number>;
}) {
  const labels = cleanStrings([input.name, ...input.aliases], 40, 240);
  const hasSupportedCleanLabel = labels.some((label) => {
    const quality = characterSurfaceQuality(label);
    const count = input.literalMentionCounts.get(normalizedEntityLabel(label)) ?? 0;
    return !quality.lowQuality && count > 0;
  });
  return [...labels].sort((left, right) => {
    const leftQuality = characterSurfaceQuality(left);
    const rightQuality = characterSurfaceQuality(right);
    const leftCount = input.literalMentionCounts.get(normalizedEntityLabel(left)) ?? 0;
    const rightCount = input.literalMentionCounts.get(normalizedEntityLabel(right)) ?? 0;
    const leftPenalized = leftQuality.lowQuality && hasSupportedCleanLabel;
    const rightPenalized = rightQuality.lowQuality && hasSupportedCleanLabel;
    return Number(leftPenalized) - Number(rightPenalized) ||
      Number(rightQuality.tokens.length > 1) - Number(leftQuality.tokens.length > 1) ||
      rightQuality.tokens.length - leftQuality.tokens.length ||
      rightCount - leftCount ||
      left.localeCompare(right);
  })[0] ?? input.name;
}

/**
 * Reject a sentence-initial common noun that a zero-shot reader mistook for a
 * proper single-word name. The raw lead remains in the vault for later review.
 */
export function genericCasingFalsePositive(input: {
  name: string;
  aliases: string[];
  literalSurfaceCounts: Array<{ surface: string; count: number }>;
}) {
  if (!/^\p{Lu}/u.test(input.name)) return false;
  if (characterSurfaceQuality(input.name).tokens.length !== 1) return false;
  if (input.aliases.some((alias) => characterSurfaceQuality(alias).tokens.length > 1)) return false;
  const normalizedName = normalizedEntityLabel(input.name);
  const matching = input.literalSurfaceCounts.filter(
    (entry) => normalizedEntityLabel(entry.surface) === normalizedName,
  );
  const total = matching.reduce((sum, entry) => sum + entry.count, 0);
  const exact = matching
    .filter((entry) => entry.surface === input.name)
    .reduce((sum, entry) => sum + entry.count, 0);
  const lower = matching
    .filter((entry) => /^\p{Ll}/u.test(entry.surface))
    .reduce((sum, entry) => sum + entry.count, 0);
  return total >= 10 && exact <= 2 && lower >= 8 && lower >= Math.max(8, exact * 6);
}

/** Keep raw scanner breadth in the vault without turning generic prose nouns into cards. */
export function generatedEntityPresentationIsUseful(input: {
  name: string;
  entityType: string;
  evidenceQuotes?: string[];
}) {
  const name = input.name.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!localEntityTextIsUseful(name)) return false;
  if (input.entityType === "character") return localCharacterNameIsUseful(name);
  if (/^(?:my|his|her|their|our|your)\s+/iu.test(name)) return false;
  const genericByType: Record<string, Set<string>> = {
    ambiguous: new Set(["wife", "mentor"]),
    weapon: new Set(["bullets", "stalactites"]),
  };
  if (genericByType[input.entityType]?.has(normalizedEntityLabel(name))) return false;
  if (
    input.entityType !== "title" && input.evidenceQuotes?.length &&
    input.evidenceQuotes.every((quote) =>
      /\b(?:chapter|book|part)\s+(?:[ivxlcdm]+|\d+)\b/iu.test(quote) &&
      normalizedEntityLabel(quote).includes(normalizedEntityLabel(name)),
    )
  ) return false;
  const mustBeNamed = new Set([
    "ambiguous", "place", "faction", "institution", "government",
    "creature", "device", "weapon", "power",
  ]);
  if (mustBeNamed.has(input.entityType) && !looksLikeProperNamedConcept(name)) return false;
  if (input.entityType === "title") {
    const tokens = normalizedEntityLabel(name).split(/\s+/u).filter(Boolean);
    if (
      tokens.length > 1 && CHARACTER_SURFACE_TITLES.has(tokens[0]!) &&
      !tokens.slice(1).every((token) => CHARACTER_SURFACE_TITLES.has(token))
    ) return false;
  }
  return true;
}

function aliasComparisonCore(value: string) {
  return normalizedEntityLabel(value).replace(/^the\s+/u, "");
}

function oneEditApart(left: string, right: string) {
  if (Math.abs(left.length - right.length) > 1 || left === right) return false;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length === longer.length) {
    let differences = 0;
    for (let index = 0; index < shorter.length; index += 1) {
      if (shorter[index] !== longer[index] && ++differences > 1) return false;
    }
    return differences === 1;
  }
  let shortIndex = 0;
  let longIndex = 0;
  let differences = 0;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
    } else {
      differences += 1;
      longIndex += 1;
      if (differences > 1) return false;
    }
  }
  return true;
}

function repeatedLetterVariant(left: string, right: string) {
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (longer.length !== shorter.length + 1) return false;
  for (let index = 1; index < longer.length; index += 1) {
    if (longer[index] !== longer[index - 1]) continue;
    if (longer.slice(0, index) + longer.slice(index + 1) === shorter) return true;
  }
  return false;
}

/**
 * A spelling repair still belongs in the internal mention composite, but a
 * one-off typo should not be presented to the reader as a nickname. Explicit
 * identity language always wins, so real callsigns and narrative aliases stay
 * visible even when their spelling is close to the canonical name.
 */
export function generatedAliasIsCustomerVisible(input: {
  alias: string;
  canonicalName: string;
  aliasMentions: number;
  canonicalMentions: number;
  explicitlyAttributed?: boolean;
}) {
  if (normalizedEntityLabel(input.alias) === normalizedEntityLabel(input.canonicalName)) return false;
  if (input.explicitlyAttributed) return true;
  const alias = aliasComparisonCore(input.alias);
  const canonical = aliasComparisonCore(input.canonicalName);
  const probableTypo = oneEditApart(alias, canonical) &&
    input.aliasMentions <= 2 &&
    input.canonicalMentions >= 20 &&
    input.canonicalMentions >= Math.max(10, input.aliasMentions * 10);
  return !probableTypo;
}

export function generatedEntityAliasPair(input: {
  leftName: string;
  leftType: string;
  leftMentions: number;
  rightName: string;
  rightType: string;
  rightMentions: number;
}) {
  if (input.leftType !== input.rightType) return false;
  const left = aliasComparisonCore(input.leftName);
  const right = aliasComparisonCore(input.rightName);
  if (!left || !right || left === right) return false;
  const high = Math.max(input.leftMentions, input.rightMentions);
  const low = Math.min(input.leftMentions, input.rightMentions);
  const plural = `${left}s` === right || `${right}s` === left;
  if (plural) return high >= 2;
  if (low > 2 || high < 20 || !oneEditApart(left, right)) return false;
  return input.leftType !== "character" || repeatedLetterVariant(left, right);
}

function regexEscapeLabel(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s+");
}

export function explicitCharacterAliasPair(input: {
  leftName: string;
  rightName: string;
  evidenceQuotes: string[];
}) {
  const left = regexEscapeLabel(input.leftName);
  const right = regexEscapeLabel(input.rightName);
  const patterns = [
    new RegExp(`\\b${left}\\b[\\s\\S]{0,300}\\b(?:call me|calls me|go by|goes by|known as)\\s+["'“”‘’]*${right}\\b`, "iu"),
    new RegExp(`\\b${right}\\b[\\s\\S]{0,300}\\b(?:call me|calls me|go by|goes by|known as)\\s+["'“”‘’]*${left}\\b`, "iu"),
    new RegExp(`\\b${left}\\b[^.!?]{0,120}\\b(?:also known as|aka)\\s+${right}\\b`, "iu"),
    new RegExp(`\\b${right}\\b[^.!?]{0,120}\\b(?:also known as|aka)\\s+${left}\\b`, "iu"),
  ];
  return input.evidenceQuotes.some((quote) => patterns.some((pattern) => pattern.test(quote)));
}

export function evidenceBasedEntityCategory(input: {
  name: string;
  currentType: string;
  evidenceQuotes: string[];
}) {
  if (input.currentType === "place") return input.currentType;
  const label = regexEscapeLabel(input.name);
  const locationCues = [
    new RegExp(`\\b${label}(?:'s|’s)\\s+(?:interior|exterior|entrance|doors?|walls?|rooms?|floors?|lights?)\\b`, "iu"),
    new RegExp(`\\b(?:inside|outside|within|back at|arrived at|returned to|headed to|stepped into)\\s+(?:the\\s+)?${label}\\b`, "iu"),
  ];
  const organizationCues = new RegExp(
    `\\b${label}\\b[^.!?]{0,90}\\b(?:members?|employees?|staff|organization|company|agency|department|founded|employs?|governs?|voted|ordered)\\b`,
    "iu",
  );
  if (input.evidenceQuotes.some((quote) => organizationCues.test(quote))) return input.currentType;
  const matchedKinds = locationCues.filter((pattern) =>
    input.evidenceQuotes.some((quote) => pattern.test(quote)),
  ).length;
  if (matchedKinds >= 2) return "place";
  const joined = input.evidenceQuotes.join("\n");
  // Explicit object handling outranks a weak upstream character guess. This
  // repairs names such as Derringer and Citizen's Band Radio without changing
  // user-confirmed classifications (the caller already protects those rows).
  if (
    new RegExp(`\\b(?:drawing|draws?|held|holding|raising|raised|aimed|fired|noticed)\\b[^.!?]{0,100}\\b${label}\\b`, "iu").test(joined) ||
    new RegExp(`\\b${label}\\b[^.!?]{0,60}\\b(?:in|from)\\s+(?:my|his|her|their)\\s+(?:hand|ankle|holster)\\b`, "iu").test(joined)
  ) return "weapon";
  const lowerName = normalizedEntityLabel(input.name);
  if (
    /(?:radio|transmitter|receiver)$/u.test(lowerName) ||
    (new RegExp(`\\b${label}\\b`, "iu").test(joined) &&
      /\b(?:under the dash|wire network|car alarms?|piezo mics?|broadcast|front panel)\b/iu.test(joined))
  ) return /\b(?:network|system|alarms?|mics?)\b/iu.test(joined) ? "technology" : "device";
  if (input.currentType !== "ambiguous") return input.currentType;
  if (
    new RegExp(`\\b${label}\\b[\\s\\S]{0,90}\\b(?:and|with)\\s+(?:his|her)\\b`, "iu").test(joined)
  ) return "character";
  return input.currentType;
}

export function explicitAbbreviationAliasPair(input: {
  leftName: string;
  rightName: string;
  evidenceQuotes: string[];
}) {
  const compact = (value: string) => value.replace(/[^A-Za-z]/gu, "");
  const initialism = (value: string) => value
    .replace(/['’]s\b/giu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word && !new Set([
      "a", "an", "and", "of", "the",
      "device", "network", "radio", "system", "vehicle",
    ]).has(word.toLocaleLowerCase()))
    .map((word) => word[0]!.toLocaleUpperCase())
    .join("");
  const leftShort = compact(input.leftName);
  const rightShort = compact(input.rightName);
  const matches = (
    (leftShort.length >= 2 && leftShort.length <= 6 && leftShort === leftShort.toLocaleUpperCase() && initialism(input.rightName) === leftShort) ||
    (rightShort.length >= 2 && rightShort.length <= 6 && rightShort === rightShort.toLocaleUpperCase() && initialism(input.leftName) === rightShort)
  );
  if (!matches) return false;
  const shortName = leftShort.length <= 6 && leftShort === leftShort.toLocaleUpperCase()
    ? input.leftName
    : input.rightName;
  const longName = shortName === input.leftName ? input.rightName : input.leftName;
  const shortPattern = regexEscapeLabel(shortName);
  const longPattern = regexEscapeLabel(longName);
  const definitionPatterns = [
    new RegExp("\\bwhat(?:['’]s| is)\\s+(?:an?\\s+)?" + shortPattern + "\\b[\\s\\S]{0,180}\\b" + longPattern + "\\b", "iu"),
    new RegExp("\\b" + shortPattern + "\\b[\\s\\S]{0,80}\\b(?:means|stands for|short for)\\b[\\s\\S]{0,80}\\b" + longPattern + "\\b", "iu"),
    new RegExp("\\b" + longPattern + "\\b\\s*\\(\\s*" + shortPattern + "\\s*\\)", "iu"),
  ];
  return input.evidenceQuotes.some((quote) =>
    definitionPatterns.some((pattern) => pattern.test(quote)),
  );
}

function evidenceContainsLabel(candidate: BrowserAuditCandidate, label: string) {
  const normalized = normalizedEntityLabel(label);
  if (!normalized) return false;
  return candidate.evidence.some((entry) =>
    ` ${normalizedEntityLabel(entry.quote)} `.includes(` ${normalized} `),
  );
}

type AuditApplicationSummary = {
  projectionVersion: number;
  confirmed: number;
  rejected: number;
  reclassified: number;
  renamed: number;
  merged: number;
  deferred: number;
  suppressed: number;
};

function customerRelationshipSummary(candidate: BrowserAuditCandidate) {
  const [source = "This entity", target = "the related entity"] = candidate.name.split(/\s+→\s+/u);
  const relation = candidate.category.replaceAll("_", " ");
  if (["allied_with", "friend_of", "best_friend_of", "sibling_of", "spouse_of", "opposed_to", "related_to"].includes(candidate.category)) {
    return `The cited passages support a ${relation} connection between ${source} and ${target}.`;
  }
  return `The cited passages support that ${source} is ${relation} ${target}.`;
}

/**
 * Apply only reversible, local-candidate cleanup from the browser auditor.
 * These changes never mark a record verified and never touch owner-confirmed
 * canon. Premium review still owns factual promotion and dossier synthesis.
 */
export async function applyCompletedBrowserAudit(
  db: AuditDb,
  audit: Record<string, unknown>,
): Promise<AuditApplicationSummary> {
  const auditId = String(audit.id);
  const worldId = String(audit.world_id);
  const editionId = String(audit.canon_edition_id);
  const batches = await db.query<{ packet: unknown; result: unknown }>(
    `SELECT packet, result FROM storyhold.browser_local_audit_batches
      WHERE audit_id = $1 AND status = 'completed'
      ORDER BY batch_index`,
    [auditId],
  );
  const candidates = new Map<string, BrowserAuditCandidate>();
  const decisions: BrowserAuditDecision[] = [];
  for (const batch of batches.rows) {
    const packet = parseBatchPacket(batch.packet);
    if (packet) {
      for (const candidate of packet.candidates) candidates.set(candidate.candidateKey, candidate);
    }
    decisions.push(...arrayBody(recordBody(batch.result).audits)
      .map(parseDecision)
      .filter((entry): entry is BrowserAuditDecision => Boolean(entry)));
  }
  const entitiesResult = await db.query<Record<string, unknown>>(
    `SELECT id, dossier_id, name, entity_type, aliases, evidence, classification_source,
            review_status, pull_status, scanner_present
       FROM storyhold.world_entities
      WHERE world_id = $1 AND canon_edition_id = $2`,
    [worldId, editionId],
  );
  const entityRows = entitiesResult.rows;
  const conceptConsensus = strongConceptConsensus([...candidates.values()]);
  const activeLabelOwners = () => {
    const labels = new Map<string, Set<Record<string, unknown>>>();
    for (const row of entityRows) {
      if (row.pull_status !== "active" || row.scanner_present !== true) continue;
      const rowLabels = [
        row.name,
        ...(Array.isArray(row.aliases) ? row.aliases : []),
      ];
      for (const value of rowLabels) {
        const key = normalizedEntityLabel(value);
        if (!key) continue;
        const owners = labels.get(key) ?? new Set<Record<string, unknown>>();
        owners.add(row);
        labels.set(key, owners);
      }
    }
    return labels;
  };
  const generatedCandidate = (row: Record<string, unknown> | undefined) =>
    Boolean(row) && row!.classification_source !== "user" &&
    row!.review_status !== "user_confirmed" && row!.pull_status === "active";
  const summary: AuditApplicationSummary = {
    projectionVersion: 2,
    confirmed: 0, rejected: 0, reclassified: 0, renamed: 0, merged: 0, deferred: 0,
    suppressed: 0,
  };
  const suppressGeneratedEntity = async (row: Record<string, unknown>) => {
    if (row.scanner_present !== true) return false;
    await db.query(
      `UPDATE storyhold.world_entities
          SET scanner_present = false, updated_at = now()
        WHERE id = $1 AND classification_source <> 'user'
          AND review_status <> 'user_confirmed'`,
      [row.id],
    );
    row.scanner_present = false;
    if (row.dossier_id) {
      await db.query(
        `UPDATE storyhold.character_dossiers
            SET dossier_status = 'suppressed', updated_at = now()
          WHERE id = $1 AND user_edited_at IS NULL`,
        [row.dossier_id],
      );
    }
    return true;
  };

  const relationRows = await db.query<Record<string, unknown>>(
    `SELECT relation.*, source.name AS source_name, target.name AS target_name
       FROM storyhold.world_entity_relations relation
       JOIN storyhold.world_entities source ON source.id = relation.source_entity_id
       JOIN storyhold.world_entities target ON target.id = relation.target_entity_id
      WHERE relation.world_id = $1 AND relation.canon_edition_id = $2
        AND relation.assignment_source = 'local'`,
    [worldId, editionId],
  );
  for (const decision of decisions) {
    const candidate = candidates.get(decision.candidateKey);
    if (!candidate || candidate.kind !== "relationship") continue;
    const [sourceLabel = "", targetLabel = ""] = candidate.name.split(/\s+→\s+/u);
    const matches = relationRows.rows.filter((row) =>
      normalizedEntityLabel(row.source_name) === normalizedEntityLabel(sourceLabel) &&
      normalizedEntityLabel(row.target_name) === normalizedEntityLabel(targetLabel) &&
      String(row.relation_type) === candidate.category,
    );
    if (matches.length !== 1) {
      summary.deferred += 1;
      continue;
    }
    const relation = matches[0]!;
    if (decision.verdict === "reject" && decision.confidence >= 0.8) {
      await db.query(
        `DELETE FROM storyhold.world_entity_relations
          WHERE id = $1 AND assignment_source = 'local'`,
        [relation.id],
      );
      summary.rejected += 1;
      continue;
    }
    if (decision.verdict === "confirm" && decision.confidence >= 0.55) {
      await db.query(
        `UPDATE storyhold.world_entity_relations
            SET assignment_source = 'ai', summary = $2,
                relation_status = CASE WHEN relation_status = 'unknown' THEN 'active' ELSE relation_status END,
                confidence = GREATEST(confidence, $3), updated_at = now()
          WHERE id = $1 AND assignment_source = 'local'`,
        [relation.id, customerRelationshipSummary(candidate), decision.confidence],
      );
      summary.confirmed += 1;
      continue;
    }
    summary.deferred += 1;
  }

  for (const decision of decisions) {
    const candidate = candidates.get(decision.candidateKey);
    if (!candidate || !["concept", "character"].includes(candidate.kind)) continue;
    const consensus = conceptConsensus.get(candidate.candidateKey);
    if (consensus && consensus.preferredCandidateKey !== candidate.candidateKey) {
      const exactNonPreferred = entityRows.find((row) =>
        normalizedEntityLabel(row.name) === normalizedEntityLabel(candidate.name),
      );
      if (
        exactNonPreferred &&
        normalizedEntityLabel(candidate.name) !== normalizedEntityLabel(consensus.preferredName) &&
        generatedCandidate(exactNonPreferred) &&
        await suppressGeneratedEntity(exactNonPreferred)
      ) summary.suppressed += 1;
      summary.deferred += 1;
      continue;
    }
    const candidateLabels = new Set(
      [candidate.name, ...candidate.aliases].map(normalizedEntityLabel).filter(Boolean),
    );
    const typeCompatibleRows = entityRows.filter((row) =>
      consensus ? true : candidate.kind === "character"
        ? row.entity_type === "character"
        : row.entity_type === candidate.category,
    );
    const primaryMatches = typeCompatibleRows.filter((row) =>
      normalizedEntityLabel(row.name) === normalizedEntityLabel(candidate.name),
    );
    const sourceMatches = typeCompatibleRows.filter((row) =>
      [row.name, ...(Array.isArray(row.aliases) ? row.aliases : [])]
        .map(normalizedEntityLabel)
        .some((label) => candidateLabels.has(label)),
    );
    const source = primaryMatches.length === 1
      ? primaryMatches[0]
      : sourceMatches.length === 1 ? sourceMatches[0] : undefined;
    if (!generatedCandidate(source)) {
      summary.deferred += 1;
      continue;
    }
    const sourceId = String(source!.id);
    if (consensus && source!.entity_type !== consensus.preferredCategory) {
      await db.query(
        `UPDATE storyhold.world_entities SET entity_type = $2, updated_at = now()
          WHERE id = $1 AND classification_source <> 'user'
            AND review_status <> 'user_confirmed'`,
        [sourceId, consensus.preferredCategory],
      );
      source!.entity_type = consensus.preferredCategory;
      summary.reclassified += 1;
    }
    const effectiveVerdict = consensus && decision.verdict === "reject"
      ? "uncertain" as const
      : decision.verdict;
    if (effectiveVerdict === "uncertain") {
      if (source!.scanner_present !== true) {
        await db.query(
          `UPDATE storyhold.world_entities SET scanner_present = true, updated_at = now()
            WHERE id = $1 AND classification_source <> 'user'
              AND review_status <> 'user_confirmed'`,
          [sourceId],
        );
        source!.scanner_present = true;
        if (source!.dossier_id) {
          await db.query(
            `UPDATE storyhold.character_dossiers SET dossier_status = 'active', updated_at = now()
              WHERE id = $1 AND user_edited_at IS NULL`,
            [source!.dossier_id],
          );
        }
      }
      summary.deferred += 1;
      continue;
    }
    if (effectiveVerdict === "reject") {
      if (decision.confidence < 0.8) {
        summary.deferred += 1;
        continue;
      }
      await suppressGeneratedEntity(source!);
      summary.rejected += 1;
      continue;
    }
    if (effectiveVerdict === "merge") {
      const targetLabel = decision.correctedName || decision.aliases[0] || "";
      const targetOwners = activeLabelOwners().get(normalizedEntityLabel(targetLabel));
      const target = targetOwners?.size === 1 ? [...targetOwners][0] : undefined;
      if (!target || target.id === source!.id || decision.confidence < 0.72) {
        summary.deferred += 1;
        continue;
      }
      const sourceName = String(source!.name);
      const sourceNameIsExplicitAlias = target.entity_type === "character" && explicitCharacterAliasPair({
        leftName: String(target.name),
        rightName: sourceName,
        evidenceQuotes: [candidate, ...candidates.values()]
          .flatMap((entry) => entry.evidence.map((item) => item.quote)),
      });
      const exposeSourceName = generatedAliasIsCustomerVisible({
        alias: sourceName,
        canonicalName: String(target.name),
        aliasMentions: Number(source!.mention_count ?? 0),
        canonicalMentions: Number(target.mention_count ?? 0),
        explicitlyAttributed: sourceNameIsExplicitAlias,
      });
      const aliases = cleanStrings([
        ...(Array.isArray(target.aliases) ? target.aliases : []),
        ...(exposeSourceName ? [sourceName] : []),
        ...decision.aliases.filter((alias) => evidenceContainsLabel(candidate, alias)),
      ], 40, 240);
      await db.query(
        `UPDATE storyhold.world_entities
            SET aliases = $2::jsonb, updated_at = now()
          WHERE id = $1`,
        [target.id, JSON.stringify(aliases)],
      );
      target.aliases = aliases;
      await db.query(
        `UPDATE storyhold.world_entities
            SET pull_status = 'merged', scanner_present = false,
                merged_into_entity_id = $2, updated_at = now()
          WHERE id = $1 AND classification_source <> 'user'
            AND review_status <> 'user_confirmed'`,
        [sourceId, target.id],
      );
      source!.pull_status = "merged";
      source!.scanner_present = false;
      if (source!.dossier_id) {
        await db.query(
          `UPDATE storyhold.character_dossiers
              SET dossier_status = 'suppressed', updated_at = now()
            WHERE id = $1 AND user_edited_at IS NULL`,
          [source!.dossier_id],
        );
      }
      summary.merged += 1;
      continue;
    }
    if (source!.scanner_present !== true) {
      await db.query(
        `UPDATE storyhold.world_entities SET scanner_present = true, updated_at = now()
          WHERE id = $1 AND classification_source <> 'user'
            AND review_status <> 'user_confirmed'`,
        [sourceId],
      );
      source!.scanner_present = true;
      if (source!.dossier_id) {
        await db.query(
          `UPDATE storyhold.character_dossiers SET dossier_status = 'active', updated_at = now()
            WHERE id = $1 AND user_edited_at IS NULL`,
          [source!.dossier_id],
        );
      }
    }
    if (effectiveVerdict === "reclassify") {
      const correctedType = normalizedEntityLabel(decision.correctedCategory).replaceAll(" ", "_");
      if (
        decision.confidence >= 0.78 && AUDIT_ENTITY_TYPES.has(correctedType) &&
        (correctedType !== "character" || source!.entity_type === "character")
      ) {
        await db.query(
          `UPDATE storyhold.world_entities
              SET entity_type = $2, updated_at = now()
            WHERE id = $1 AND classification_source <> 'user'
              AND review_status <> 'user_confirmed'`,
          [sourceId, correctedType],
        );
        if (source!.entity_type === "character" && correctedType !== "character" && source!.dossier_id) {
          await db.query(
            `UPDATE storyhold.character_dossiers
                SET dossier_status = 'suppressed', updated_at = now()
              WHERE id = $1 AND user_edited_at IS NULL`,
            [source!.dossier_id],
          );
        }
        source!.entity_type = correctedType;
        summary.reclassified += 1;
      } else {
        summary.deferred += 1;
      }
    } else {
      summary.confirmed += 1;
    }

    const supportedAliases = decision.aliases.filter((alias) =>
      evidenceContainsLabel(candidate, alias),
    );
    if (supportedAliases.length) {
      const owners = activeLabelOwners();
      const safeAliases = supportedAliases.filter((alias) => {
        const matches = owners.get(normalizedEntityLabel(alias));
        return !matches || (matches.size === 1 && matches.has(source!));
      });
      if (safeAliases.length) {
        const aliases = cleanStrings([
          ...(Array.isArray(source!.aliases) ? source!.aliases : []),
          ...safeAliases,
        ], 40, 240);
        await db.query(
          `UPDATE storyhold.world_entities SET aliases = $2::jsonb, updated_at = now()
            WHERE id = $1`,
          [sourceId, JSON.stringify(aliases)],
        );
        source!.aliases = aliases;
      }
    }
    const correctedName = decision.correctedName.trim();
    if (
      correctedName && decision.confidence >= 0.8 &&
      evidenceContainsLabel(candidate, correctedName) &&
      normalizedEntityLabel(correctedName) !== normalizedEntityLabel(source!.name) &&
      !activeLabelOwners().has(normalizedEntityLabel(correctedName))
    ) {
      const priorName = String(source!.name);
      const aliases = cleanStrings([
        ...(Array.isArray(source!.aliases) ? source!.aliases : []),
        priorName,
      ], 40, 240);
      await db.query(
        `UPDATE storyhold.world_entities
            SET name = $2, normalized_name = $3, aliases = $4::jsonb, updated_at = now()
          WHERE id = $1 AND classification_source <> 'user'
            AND review_status <> 'user_confirmed'`,
        [sourceId, correctedName, normalizedEntityLabel(correctedName), JSON.stringify(aliases)],
      );
      if (source!.dossier_id) {
        await db.query(
          `UPDATE storyhold.character_dossiers
              SET name = $2, normalized_name = $3, aliases = $4::jsonb, updated_at = now()
            WHERE id = $1 AND user_edited_at IS NULL`,
          [source!.dossier_id, correctedName, normalizedEntityLabel(correctedName), JSON.stringify(aliases)],
        );
      }
      source!.name = correctedName;
      source!.aliases = aliases;
      summary.renamed += 1;
    }
  }

  // The local scanners deliberately over-collect. Only the evidence-bound
  // promotion set sent through Qwen belongs in the customer-facing Hold. Keep
  // every other raw row in the vault, but remove it from retrieval and cards.
  const auditedEntityLabels = new Set(
    [...candidates.values()]
      .filter((candidate) => candidate.kind === "concept" || candidate.kind === "character")
      .flatMap((candidate) => [candidate.name, ...candidate.aliases].map(normalizedEntityLabel)),
  );
  for (const row of entityRows) {
    if (
      row.scanner_present === true && generatedCandidate(row) &&
      !auditedEntityLabels.has(normalizedEntityLabel(row.name)) &&
      await suppressGeneratedEntity(row)
    ) summary.suppressed += 1;
  }

  await syncWorldEntityMentions({ db, worldId, editionId });

  // A one-off sentence-opening common noun can be capitalized and fool both a
  // zero-shot NER and a tiny classifier. Compare preserved source casing before
  // letting that lead inflate into hundreds of case-insensitive mentions.
  const literalSurfaces = await db.query<Record<string, unknown>>(
    `SELECT entity.id AS entity_id, entity.name, entity.aliases,
            mention.surface_form, count(*)::int AS mention_count
       FROM storyhold.world_entities entity
       JOIN storyhold.world_entity_mentions mention ON mention.entity_id = entity.id
      WHERE entity.world_id = $1 AND entity.canon_edition_id = $2
        AND entity.pull_status = 'active' AND entity.scanner_present = true
        AND entity.classification_source <> 'user'
        AND entity.review_status <> 'user_confirmed'
        AND mention.mention_kind = 'literal'
      GROUP BY entity.id, entity.name, entity.aliases, mention.surface_form`,
    [worldId, editionId],
  );
  const surfaceGroups = new Map<string, Array<{ surface: string; count: number }>>();
  for (const row of literalSurfaces.rows) {
    const group = surfaceGroups.get(String(row.entity_id)) ?? [];
    group.push({ surface: String(row.surface_form), count: Number(row.mention_count) || 0 });
    surfaceGroups.set(String(row.entity_id), group);
  }
  let casingSuppressions = 0;
  for (const row of entityRows) {
    if (row.scanner_present !== true || !generatedCandidate(row)) continue;
    if (!generatedEntityPresentationIsUseful({
      name: String(row.name),
      entityType: String(row.entity_type),
      evidenceQuotes: Array.isArray(row.evidence)
        ? row.evidence.flatMap((entry) => {
          const quote = recordBody(entry).quote;
          return typeof quote === "string" ? [quote] : [];
        })
        : [],
    })) {
      if (await suppressGeneratedEntity(row)) {
        summary.suppressed += 1;
        casingSuppressions += 1;
      }
      continue;
    }
    if (!genericCasingFalsePositive({
      name: String(row.name),
      aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
      literalSurfaceCounts: surfaceGroups.get(String(row.id)) ?? [],
    })) continue;
    if (await suppressGeneratedEntity(row)) {
      summary.suppressed += 1;
      casingSuppressions += 1;
    }
  }
  if (casingSuppressions > 0) await syncWorldEntityMentions({ db, worldId, editionId });

  // Tiny classifiers can confuse a named building with the organization that
  // occupies it. Strong, repeated spatial grammar is safe to repair locally;
  // ambiguous or organizational evidence remains deferred to premium review.
  for (const row of entityRows) {
    if (row.scanner_present !== true || !generatedCandidate(row)) continue;
    const evidenceQuotes = Array.isArray(row.evidence)
      ? row.evidence.flatMap((entry) => {
        const quote = recordBody(entry).quote;
        return typeof quote === "string" ? [quote] : [];
      })
      : [];
    const correctedType = evidenceBasedEntityCategory({
      name: String(row.name),
      currentType: String(row.entity_type),
      evidenceQuotes,
    });
    if (correctedType === row.entity_type) continue;
    await db.query(
      `UPDATE storyhold.world_entities SET entity_type = $2, updated_at = now()
        WHERE id = $1 AND classification_source <> 'user'
          AND review_status <> 'user_confirmed'`,
      [row.id, correctedType],
    );
    row.entity_type = correctedType;
    summary.reclassified += 1;
  }

  // Fold only mechanically strong typo/plural variants after Qwen has reduced
  // the candidate set. One-off character substitutions remain separate; a
  // repeated-letter spelling or a dominant non-character spelling is safe.
  const literalTotals = new Map(
    [...surfaceGroups.entries()].map(([id, rows]) => [
      id,
      rows.reduce((sum, entry) => sum + entry.count, 0),
    ]),
  );
  const mergeRows = entityRows
    .filter((row) => row.scanner_present === true && generatedCandidate(row))
    .sort((left, right) =>
      (literalTotals.get(String(right.id)) ?? 0) - (literalTotals.get(String(left.id)) ?? 0),
    );
  let aliasMerges = 0;
  for (let targetIndex = 0; targetIndex < mergeRows.length; targetIndex += 1) {
    const target = mergeRows[targetIndex]!;
    if (target.scanner_present !== true || target.pull_status !== "active") continue;
    for (let sourceIndex = targetIndex + 1; sourceIndex < mergeRows.length; sourceIndex += 1) {
      const source = mergeRows[sourceIndex]!;
      if (source.scanner_present !== true || source.pull_status !== "active") continue;
      const evidenceQuotes = [target, source].flatMap((row) =>
        Array.isArray(row.evidence)
          ? row.evidence.flatMap((entry) => {
            const quote = recordBody(entry).quote;
            return typeof quote === "string" ? [quote] : [];
          })
          : [],
      );
      const abbreviationAlias = explicitAbbreviationAliasPair({
        leftName: String(target.name),
        rightName: String(source.name),
        evidenceQuotes,
      });
      if (!generatedEntityAliasPair({
        leftName: String(target.name),
        leftType: String(target.entity_type),
        leftMentions: literalTotals.get(String(target.id)) ?? 0,
        rightName: String(source.name),
        rightType: String(source.entity_type),
        rightMentions: literalTotals.get(String(source.id)) ?? 0,
      }) && !(
        target.entity_type === "character" && source.entity_type === "character" &&
        explicitCharacterAliasPair({
          leftName: String(target.name),
          rightName: String(source.name),
          evidenceQuotes,
        })
      ) && !abbreviationAlias) continue;
      const targetTokens = characterSurfaceQuality(String(target.name)).tokens.length;
      const sourceTokens = characterSurfaceQuality(String(source.name)).tokens.length;
      const surviving = abbreviationAlias && sourceTokens > targetTokens ? source : target;
      const retired = surviving === target ? source : target;
      const retiredNameIsExplicitAlias = surviving.entity_type === "character" && explicitCharacterAliasPair({
        leftName: String(surviving.name),
        rightName: String(retired.name),
        evidenceQuotes,
      });
      const exposeRetiredName = generatedAliasIsCustomerVisible({
        alias: String(retired.name),
        canonicalName: String(surviving.name),
        aliasMentions: literalTotals.get(String(retired.id)) ?? 0,
        canonicalMentions: literalTotals.get(String(surviving.id)) ?? 0,
        explicitlyAttributed: retiredNameIsExplicitAlias || abbreviationAlias,
      });
      const aliases = cleanStrings([
        ...(Array.isArray(surviving.aliases) ? surviving.aliases : []),
        ...(exposeRetiredName ? [String(retired.name)] : []),
        ...(Array.isArray(retired.aliases) ? retired.aliases : []),
      ], 40, 240).filter((alias) =>
        normalizedEntityLabel(alias) !== normalizedEntityLabel(surviving.name) &&
        (surviving.entity_type !== "character" || generatedCharacterAliasIsUseful(alias)),
      );
      await db.query(
        `UPDATE storyhold.world_entities SET aliases = $2::jsonb, updated_at = now()
          WHERE id = $1`,
        [surviving.id, JSON.stringify(aliases)],
      );
      surviving.aliases = aliases;
      await db.query(
        `UPDATE storyhold.world_entities
            SET pull_status = 'merged', scanner_present = false,
                merged_into_entity_id = $2, updated_at = now()
          WHERE id = $1 AND classification_source <> 'user'
            AND review_status <> 'user_confirmed'`,
        [retired.id, surviving.id],
      );
      retired.pull_status = "merged";
      retired.scanner_present = false;
      if (retired.dossier_id) {
        await db.query(
          `UPDATE storyhold.character_dossiers SET dossier_status = 'suppressed', updated_at = now()
            WHERE id = $1 AND user_edited_at IS NULL`,
          [retired.dossier_id],
        );
      }
      aliasMerges += 1;
      summary.merged += 1;
      if (retired === target) break;
    }
  }
  if (aliasMerges > 0) await syncWorldEntityMentions({ db, worldId, editionId });

  // Re-evaluate the preferred character surface from the literal mention index
  // after aliases have been composited. Narrative decorations remain aliases.
  const characterRows = entityRows.filter((row) =>
    row.entity_type === "character" && row.scanner_present === true && generatedCandidate(row),
  );
  const literalCounts = characterRows.length > 0
    ? await db.query<Record<string, unknown>>(
      `SELECT entity_id, normalized_surface, count(*)::int AS mention_count
         FROM storyhold.world_entity_mentions
        WHERE world_id = $1 AND canon_edition_id = $2 AND mention_kind = 'literal'
          AND entity_id = ANY($3::uuid[])
        GROUP BY entity_id, normalized_surface`,
      [worldId, editionId, characterRows.map((row) => String(row.id))],
    )
    : { rows: [] as Record<string, unknown>[] };
  const countsByEntity = new Map<string, Map<string, number>>();
  for (const row of literalCounts.rows) {
    const counts = countsByEntity.get(String(row.entity_id)) ?? new Map<string, number>();
    counts.set(String(row.normalized_surface), Number(row.mention_count) || 0);
    countsByEntity.set(String(row.entity_id), counts);
  }
  for (const row of characterRows) {
    const existingAliases = (Array.isArray(row.aliases) ? row.aliases.map(String) : [])
      .filter(generatedCharacterAliasIsUseful);
    const preferred = preferredGeneratedCharacterLabel({
      name: String(row.name),
      aliases: existingAliases,
      literalMentionCounts: countsByEntity.get(String(row.id)) ?? new Map(),
    });
    if (normalizedEntityLabel(preferred) === normalizedEntityLabel(row.name)) {
      if (existingAliases.length !== (Array.isArray(row.aliases) ? row.aliases.length : 0)) {
        await db.query(
          `UPDATE storyhold.world_entities SET aliases = $2::jsonb, updated_at = now()
            WHERE id = $1 AND classification_source <> 'user'
              AND review_status <> 'user_confirmed'`,
          [row.id, JSON.stringify(existingAliases)],
        );
        if (row.dossier_id) {
          await db.query(
            `UPDATE storyhold.character_dossiers SET aliases = $2::jsonb, updated_at = now()
              WHERE id = $1 AND user_edited_at IS NULL`,
            [row.dossier_id, JSON.stringify(existingAliases)],
          );
        }
        row.aliases = existingAliases;
      }
      continue;
    }
    const collision = entityRows.some((other) =>
      other.id !== row.id && other.pull_status === "active" && other.scanner_present === true &&
      normalizedEntityLabel(other.name) === normalizedEntityLabel(preferred),
    );
    if (collision) continue;
    const priorName = String(row.name);
    const aliases = cleanStrings([
      ...existingAliases,
      priorName,
    ], 40, 240).filter((alias) =>
      normalizedEntityLabel(alias) !== normalizedEntityLabel(preferred) &&
      generatedCharacterAliasIsUseful(alias),
    );
    await db.query(
      `UPDATE storyhold.world_entities
          SET name = $2, normalized_name = $3, aliases = $4::jsonb, updated_at = now()
        WHERE id = $1 AND classification_source <> 'user'
          AND review_status <> 'user_confirmed'`,
      [row.id, preferred, normalizedEntityLabel(preferred), JSON.stringify(aliases)],
    );
    if (row.dossier_id) {
      await db.query(
        `UPDATE storyhold.character_dossiers
            SET name = $2, normalized_name = $3, aliases = $4::jsonb, updated_at = now()
          WHERE id = $1 AND user_edited_at IS NULL`,
        [row.dossier_id, preferred, normalizedEntityLabel(preferred), JSON.stringify(aliases)],
      );
    }
    row.name = preferred;
    row.aliases = aliases;
    summary.renamed += 1;
  }
  if (summary.renamed > 0) await syncWorldEntityMentions({ db, worldId, editionId });
  const identityRepairs = await repairGeneratedCharacterIdentities({
    db,
    worldId,
    editionId,
  });
  summary.renamed += identityRepairs.renamed;
  summary.merged += identityRepairs.merged;
  await syncWorldConceptGraph({ db, worldId, editionId, runId: String(audit.local_analysis_run_id ?? "") || null });
  // Old unresolved-reference receipts can become obsolete after a safe alias
  // merge. Retain only labels that still fail unique resolution.
  const labelOwners = activeLabelOwners();
  const latestRun = await db.query<Record<string, unknown>>(
    `SELECT id, unresolved_references FROM storyhold.world_analysis_runs
      WHERE world_id = $1 AND canon_edition_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [worldId, editionId],
  );
  if (latestRun.rows[0]) {
    const remaining = arrayBody(latestRun.rows[0].unresolved_references).filter((raw) => {
      const label = normalizedEntityLabel(recordBody(raw).label);
      return !label || labelOwners.get(label)?.size !== 1;
    });
    await db.query(
      `UPDATE storyhold.world_analysis_runs
          SET unresolved_reference_count = $2, unresolved_references = $3::jsonb
        WHERE id = $1`,
      [latestRun.rows[0].id, remaining.length, JSON.stringify(remaining)],
    );
  }
  await refreshWorldQualityFindings({ db, worldId, editionId, runId: String(audit.local_analysis_run_id ?? "") || null });
  await db.query(
    `UPDATE storyhold.browser_local_audits
        SET applied_at = now(), application_summary = $2::jsonb
      WHERE id = $1`,
    [auditId, JSON.stringify(summary)],
  );
  return summary;
}

export async function applyPendingCompletedBrowserAudits(db: AuditDb): Promise<number> {
  const pending = await db.query<Record<string, unknown>>(
    `SELECT * FROM storyhold.browser_local_audits
      WHERE status = 'completed'
        AND (applied_at IS NULL OR COALESCE(application_summary->>'projectionVersion', '') <> '2')
      ORDER BY completed_at, created_at`,
  );
  for (const audit of pending.rows) await applyCompletedBrowserAudit(db, audit);
  return pending.rows.length;
}

export function registerBrowserLocalAuditRoutes(params: {
  app: Express;
  db: AuditRootDb;
  requireUser: RequestHandler;
}) {
  const { app, db, requireUser } = params;

  app.get(
    "/api/storyhold/worlds/:worldId/browser-audit",
    requireUser,
    async (req: AuditRequest, res) => {
      const audit = await latestBrowserAudit(
        db,
        routeParam(req, "worldId"),
        currentUser(req).id,
      );
      res.json({ audit });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/browser-audit/:auditId/start",
    requireUser,
    async (req: AuditRequest, res) => {
      const user = currentUser(req);
      const auditId = routeParam(req, "auditId");
      const worldId = routeParam(req, "worldId");
      const audit = await auditScope(db, auditId, user.id);
      if (!audit || audit.world_id !== worldId) {
        res.status(404).json({ error: "That private audit was not found." });
        return;
      }
      if (!["pending", "running"].includes(String(audit.status))) {
        res.json({ audit: await latestBrowserAudit(db, worldId, user.id) });
        return;
      }
      const currentChargeStatus = cleanText(audit.charge_status, 40) || "pending";
      if (["reserved", "settled", "unlimited"].includes(currentChargeStatus)) {
        res.json({ audit: await latestBrowserAudit(db, worldId, user.id) });
        return;
      }
      try {
        const reservation = await reserveCredits(db, {
          playerId: user.id,
          worldId,
          operation: "browser_qwen",
          requestId: auditId,
          requiredCredits: Number(audit.price_credits ?? 0),
          expiresInMinutes: 6 * 60,
          metadata: {
            pricingVersion: BROWSER_QWEN_PRICING_VERSION,
            inputUnits: Number(audit.reserved_input_units ?? 0),
            outputUnits: Number(audit.reserved_output_units ?? 0),
            batchCount: Number(audit.total_batches ?? 0),
          },
        });
        await db.query(
          `UPDATE storyhold.browser_local_audits
              SET charge_status = $2, credit_reservation_id = $3,
                  error = NULL
            WHERE id = $1`,
          [
            auditId,
            reservation.unlimited ? "unlimited" : "reserved",
            reservation.id,
          ],
        );
        res.json({ audit: await latestBrowserAudit(db, worldId, user.id) });
      } catch (error) {
        if (error instanceof CreditEconomyError) {
          res.status(error.code === "INSUFFICIENT_CREDITS" ? 402 : 409).json({
            error: error.code === "INSUFFICIENT_CREDITS"
              ? "Canon Intake paused because this account ran out of credits. Add credits to continue from the saved work."
              : error.message,
          });
          return;
        }
        res.status(500).json({
          error: error instanceof Error
            ? error.message
            : "The private browser audit could not reserve its credits.",
        });
      }
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/browser-audit/:auditId/batches/:batchIndex",
    requireUser,
    async (req: AuditRequest, res) => {
      const user = currentUser(req);
      const auditId = routeParam(req, "auditId");
      const worldId = routeParam(req, "worldId");
      const batchIndex = Number(routeParam(req, "batchIndex"));
      const audit = await auditScope(db, auditId, user.id);
      if (!audit || audit.world_id !== worldId) {
        res.status(404).json({ error: "That private audit was not found." });
        return;
      }
      if (!["pending", "running"].includes(String(audit.status))) {
        res.status(409).json({ error: "That private audit is no longer accepting batches." });
        return;
      }
      if (!["reserved", "unlimited"].includes(String(audit.charge_status))) {
        res.status(409).json({ error: "Canon Intake has not reserved the browser-model credits yet." });
        return;
      }
      const batchResult = await db.query<{ packet: unknown; status: string }>(
        `SELECT packet, status FROM storyhold.browser_local_audit_batches
          WHERE audit_id = $1 AND batch_index = $2 LIMIT 1`,
        [auditId, batchIndex],
      );
      const packet = parseBatchPacket(batchResult.rows[0]?.packet);
      if (!packet) {
        res.status(404).json({ error: "That private audit batch was not found." });
        return;
      }
      if (batchResult.rows[0]?.status === "completed") {
        res.json({ audit: await latestBrowserAudit(db, worldId, user.id) });
        return;
      }
      let result: ReturnType<typeof validateBatchResult>;
      try {
        result = validateBatchResult(packet, req.body?.result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await db.query(
          `UPDATE storyhold.browser_local_audit_batches
              SET status = 'failed', error = $3, updated_at = now()
            WHERE audit_id = $1 AND batch_index = $2`,
          [auditId, batchIndex, message.slice(0, 1_000)],
        );
        res.status(422).json({ error: message });
        return;
      }
      let completedNow = false;
      const submittedUsage = recordBody(req.body?.usage);
      const inputUnits = Math.max(
        0,
        Math.round(Number(submittedUsage.inputTokens) ||
          estimatedTokensFromCharacters(JSON.stringify(packet).length + 1_600)),
      );
      const outputUnits = Math.max(
        0,
        Math.round(Number(submittedUsage.outputTokens) ||
          estimatedTokensFromCharacters(JSON.stringify(result).length)),
      );
      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE storyhold.browser_local_audit_batches
              SET status = 'completed', result = $3::jsonb, error = NULL,
                  input_units = $4, output_units = $5,
                  completed_at = now(), updated_at = now()
            WHERE audit_id = $1 AND batch_index = $2`,
          [auditId, batchIndex, JSON.stringify(result), inputUnits, outputUnits],
        );
        const aggregate = await tx.query<{
          completed: number;
          total: number;
          input_units: number;
          output_units: number;
        }>(
          `SELECT count(*) FILTER (WHERE status = 'completed')::int AS completed,
                  count(*)::int AS total,
                  COALESCE(sum(input_units) FILTER (WHERE status = 'completed'), 0)::int AS input_units,
                  COALESCE(sum(output_units) FILTER (WHERE status = 'completed'), 0)::int AS output_units
             FROM storyhold.browser_local_audit_batches
            WHERE audit_id = $1`,
          [auditId],
        );
        const completed = Number(aggregate.rows[0]?.completed ?? 0);
        const total = Number(aggregate.rows[0]?.total ?? 0);
        const actualInputUnits = Number(aggregate.rows[0]?.input_units ?? 0);
        const actualOutputUnits = Number(aggregate.rows[0]?.output_units ?? 0);
        completedNow = total > 0 && completed >= total;
        const allResults = await tx.query<{ result: unknown }>(
          `SELECT result FROM storyhold.browser_local_audit_batches
            WHERE audit_id = $1 AND status = 'completed'
            ORDER BY batch_index ASC`,
          [auditId],
        );
        const missingQueries = [...new Set(allResults.rows.flatMap((row) =>
          cleanStrings(recordBody(row.result).missingQueries, 40, 300),
        ))].slice(0, 100);
        let creditsCharged = Number(audit.credits_charged ?? 0);
        let chargeStatus = String(audit.charge_status);
        if (completedNow && audit.credit_reservation_id) {
          const actualCredits = Math.min(
            Number(audit.price_credits ?? 0),
            browserQwenUsageCredits({
              inputTokens: actualInputUnits,
              outputTokens: actualOutputUnits,
            }),
          );
          const settlement = await settleFixedCreditReservationInTransaction(tx, {
            reservationId: String(audit.credit_reservation_id),
            fixedCredits: actualCredits,
            provider: "storyhold-browser",
            model: cleanText(req.body?.model, 200) || String(audit.model),
            metadata: {
              pricingVersion: BROWSER_QWEN_PRICING_VERSION,
              inputUnits: actualInputUnits,
              outputUnits: actualOutputUnits,
              batchCount: total,
            },
          });
          creditsCharged = settlement.creditsUsed;
          chargeStatus = "settled";
        } else if (completedNow && chargeStatus === "unlimited") {
          chargeStatus = "unlimited";
        }
        await tx.query(
          `UPDATE storyhold.browser_local_audits
              SET status = CASE
                    WHEN $3 THEN 'completed'
                    WHEN status = 'paused' THEN 'paused'
                    ELSE 'running'
                  END,
                  completed_batches = $2,
                  missing_queries = $4::jsonb,
                  model = COALESCE(NULLIF($5, ''), model),
                  device_profile = $6::jsonb,
                  elapsed_ms = elapsed_ms + $7,
                  actual_input_units = $8,
                  actual_output_units = $9,
                  credits_charged = $10,
                  charge_status = $11,
                  started_at = COALESCE(started_at, now()),
                  completed_at = CASE WHEN $3 THEN now() ELSE NULL END,
                  error = NULL
            WHERE id = $1`,
          [
            auditId,
            completed,
            completedNow,
            JSON.stringify(missingQueries),
            cleanText(req.body?.model, 200),
            JSON.stringify(recordBody(req.body?.deviceProfile)),
            Math.max(0, Math.round(Number(req.body?.elapsedMilliseconds) || 0)),
            actualInputUnits,
            actualOutputUnits,
            creditsCharged,
            chargeStatus,
          ],
        );
        if (completedNow) {
          await applyCompletedBrowserAudit(tx, audit);
          await tx.query(
            `INSERT INTO storyhold.ai_usage_ledger
              (id, player_id, world_id, campaign_id, operation, provider, model,
               input_units, output_units, cached_input_units,
               cache_write_input_units, reasoning_units, cost_micros, cache_hit,
               pricing_version, credits_charged, request_id, metadata)
             VALUES ($1, $2, $3, NULL, 'browser_qwen', 'storyhold-browser', $4,
                     $5, $6, 0, 0, 0, 0, false, $7, $8, $9, $10::jsonb)`,
            [
              randomUUID(),
              user.id,
              worldId,
              cleanText(req.body?.model, 200) || String(audit.model),
              actualInputUnits,
              actualOutputUnits,
              BROWSER_QWEN_PRICING_VERSION,
              creditsCharged,
              auditId,
              JSON.stringify({ batchCount: total, localAnalysisRunId: audit.local_analysis_run_id }),
            ],
          );
        }
      });
      if (completedNow) {
        // Local acceleration uses the same one-worker supervisor as the earlier
        // specialists. Return its memory to the OS immediately after the last
        // durable batch is applied. This is harmless when Qwen ran in WebGPU.
        await releaseLorekeeperStage().catch(() => undefined);
      }
      const serialized = await latestBrowserAudit(db, worldId, user.id);
      res.json({ audit: serialized });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/browser-audit/:auditId/batches/:batchIndex/accelerate",
    requireUser,
    async (req: AuditRequest, res) => {
      const user = currentUser(req);
      const auditId = routeParam(req, "auditId");
      const worldId = routeParam(req, "worldId");
      const batchIndex = Number(routeParam(req, "batchIndex"));
      const audit = await auditScope(db, auditId, user.id);
      if (!audit || audit.world_id !== worldId) {
        res.status(404).json({ error: "That private audit was not found." });
        return;
      }
      if (!["pending", "running"].includes(String(audit.status))) {
        res.status(409).json({ error: "That private audit is no longer accepting batches." });
        return;
      }
      if (!["reserved", "unlimited"].includes(String(audit.charge_status))) {
        res.status(409).json({ error: "Canon Intake has not reserved the local-model credits yet." });
        return;
      }
      if (batchIndex === 0 && Number(audit.completed_batches ?? 0) === 0) {
        await repackUnstartedAuditForLocalAcceleration(db, auditId);
      }
      const batchResult = await db.query<{ packet: unknown; status: string }>(
        `SELECT packet, status FROM storyhold.browser_local_audit_batches
          WHERE audit_id = $1 AND batch_index = $2 LIMIT 1`,
        [auditId, batchIndex],
      );
      const packet = parseBatchPacket(batchResult.rows[0]?.packet);
      if (!packet) {
        res.status(404).json({ error: "That private audit batch was not found." });
        return;
      }
      if (batchResult.rows[0]?.status === "completed") {
        res.status(409).json({ error: "That private audit batch is already complete." });
        return;
      }
      try {
        const completed = await locallyAccelerateQwenBatch(packet);
        res.json({
          result: validateBatchResult(packet, completed.result),
          model: `${completed.receipt.model} (Local Acceleration)`,
          elapsedMilliseconds: completed.receipt.elapsedMilliseconds,
          deviceProfile: {
            runtime: "storyhold-local-acceleration",
            device: completed.receipt.device,
            workerPid: completed.receipt.workerPid,
            sequential: true,
            maximumResidentWorkers: 1,
          },
          usage: {
            inputTokens: completed.receipt.inputTokens,
            outputTokens: completed.receipt.outputTokens,
          },
        });
      } catch (error) {
        res.status(503).json({
          error: error instanceof Error ? error.message : "Qwen local acceleration failed.",
        });
      }
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/browser-audit/:auditId/pause",
    requireUser,
    async (req: AuditRequest, res) => {
      const user = currentUser(req);
      const auditId = routeParam(req, "auditId");
      const worldId = routeParam(req, "worldId");
      const audit = await auditScope(db, auditId, user.id);
      if (!audit || audit.world_id !== worldId) {
        res.status(404).json({ error: "That private audit was not found." });
        return;
      }
      if (["pending", "running"].includes(String(audit.status))) {
        await db.query(
          `UPDATE storyhold.browser_local_audits
              SET status = 'paused', error = $2, completed_at = NULL
            WHERE id = $1`,
          [
            auditId,
            cleanText(req.body?.reason, 1_000) ||
              "The private browser audit stopped without returning an error message.",
          ],
        );
      }
      res.json({ audit: await latestBrowserAudit(db, worldId, user.id) });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/browser-audit/:auditId/retry",
    requireUser,
    async (req: AuditRequest, res) => {
      const user = currentUser(req);
      const auditId = routeParam(req, "auditId");
      const worldId = routeParam(req, "worldId");
      const audit = await auditScope(db, auditId, user.id);
      if (!audit || audit.world_id !== worldId) {
        res.status(404).json({ error: "That private audit was not found." });
        return;
      }
      if (!["paused", "skipped"].includes(String(audit.status))) {
        res.status(409).json({ error: "That private audit is not waiting to be retried." });
        return;
      }
      await resumePausedBrowserLocalAudit(db, auditId, String(audit.charge_status));
      res.status(202).json({ audit: await latestBrowserAudit(db, worldId, user.id) });
    },
  );

  app.post(
    "/api/storyhold/worlds/:worldId/browser-audit/:auditId/skip",
    requireUser,
    async (req: AuditRequest, res) => {
      const user = currentUser(req);
      const auditId = routeParam(req, "auditId");
      const worldId = routeParam(req, "worldId");
      const audit = await auditScope(db, auditId, user.id);
      if (!audit || audit.world_id !== worldId) {
        res.status(404).json({ error: "That private audit was not found." });
        return;
      }
      if (["pending", "running"].includes(String(audit.status))) {
        const skipReason = cleanText(req.body?.reason, 1_000);
        // Older clients used the skip endpoint after a browser-model runtime
        // error. Preserve that work as a retryable pause; only an explicit
        // owner/device decision is allowed to skip the optional stage.
        if (/\b(?:stopped|failed|crashed|timed?\s*out|no json)\b/iu.test(skipReason)) {
          await db.query(
            `UPDATE storyhold.browser_local_audits
                SET status = 'paused', error = $2, completed_at = NULL
              WHERE id = $1`,
            [auditId, skipReason || "The private browser audit stopped unexpectedly."],
          );
          res.json({ audit: await latestBrowserAudit(db, worldId, user.id) });
          return;
        }
        await releaseCreditReservation(
          db,
          audit.credit_reservation_id ? String(audit.credit_reservation_id) : null,
          "Private browser audit skipped before completion",
        );
        await db.query(
          `UPDATE storyhold.browser_local_audits
              SET status = 'skipped', error = $2,
                  charge_status = CASE
                    WHEN charge_status = 'reserved' THEN 'released'
                    ELSE charge_status
                  END,
                  completed_at = now()
          WHERE id = $1`,
          [auditId, skipReason || "Browser intelligence is unavailable on this device."],
        );
      }
      res.json({ audit: await latestBrowserAudit(db, worldId, user.id) });
    },
  );
}
