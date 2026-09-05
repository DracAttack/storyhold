/**
 * Concept alias-conflation audit
 *
 * A glossary entry's aliases claim "this concept is ALSO KNOWN AS <alias>".
 * When an alias actually names a DIFFERENT concept (e.g. "fearful attachment"
 * listed as an alias of "anxious attachment"), the glossary is asserting two
 * distinct ideas are the same thing. This sweep detects and repairs those
 * conflations across ALL concepts:
 *
 *   Pass 1 (deterministic) — an alias that exactly matches ANOTHER concept's
 *     canonical term. The two entries provably coexist as separate concepts,
 *     so the alias is removed and a `distinct_from` relationship recorded.
 *   Pass 2 (deterministic) — the same alias registered on two different
 *     concepts. Ownership is ambiguous so neither copy is deleted, but a
 *     `distinct_from` relationship is recorded (unless the pair already has a
 *     curated relationship of any type) and the alias is flagged for review.
 *     Once EVERY owner pair for a shared alias has a recorded relationship
 *     (i.e. it was acknowledged on a previous run), the group is no longer
 *     re-reported — only a counter (`sharedAliasesAcknowledged`) tracks it —
 *     so the report surfaces new findings instead of the same list forever.
 *   Pass 3 (LLM, gated by the `alias_audit` AI function) — batch-judges each
 *     concept's remaining aliases and flags ones that name a distinct concept
 *     even when no matching registry entry exists (the "fearful attachment"
 *     case). Flagged aliases are removed; when the flagged alias matches an
 *     existing concept's term a `distinct_from` relationship is recorded too.
 *
 * Runs behind the shared background_jobs lock (fire-and-forget from the admin
 * route); the full report is persisted as the job's progress snapshot so the
 * admin UI can render the latest result durably.
 */

import { eq, and, sql } from "drizzle-orm";
import {
  db,
  conceptsTable,
  conceptAliasesTable,
  conceptRelationshipsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { llmAuditConceptAliases, type AliasAuditConceptInput } from "./llm";
import { acquireJobLock, heartbeatJob, finishJob, getJobState } from "./jobState";
import { BudgetGuard, BudgetExceededError } from "./aiBudget";

export const ALIAS_AUDIT_JOB = "concept_alias_audit";
const LOCK_TTL_MS = 10 * 60_000;
const LLM_BATCH_SIZE = 8;

// Module-level cooperative cancel flag — set by requestAliasAuditCancel(),
// cleared at the start of each executeAliasAudit() run.
let aliasAuditCancelRequested = false;

/**
 * Request a cooperative stop of the running alias audit. The audit will
 * finish the current LLM batch and then halt, persisting whatever it has
 * accumulated so far. Returns true when a run was active, false when idle.
 */
export function requestAliasAuditCancel(): boolean {
  if (!aliasAuditCancelRequested) {
    aliasAuditCancelRequested = true;
    return true;
  }
  return false;
}

export interface AliasAuditReport {
  dryRun: boolean;
  conceptsChecked: number;
  aliasesChecked: number;
  /** Pass 1 — alias exactly matches another concept's canonical term. */
  canonicalCollisions: Array<{ conceptSlug: string; alias: string; matchesSlug: string }>;
  /** Pass 2 — same alias registered on two different concepts. */
  sharedAliases: Array<{ alias: string; conceptSlugs: string[] }>;
  /**
   * Pass 2 — shared-alias groups suppressed from the report because every
   * owner pair already has a recorded relationship (acknowledged previously).
   */
  sharedAliasesAcknowledged: number;
  /** Pass 3 — LLM-flagged aliases that name a distinct concept. */
  llmFlags: Array<{ conceptSlug: string; alias: string; reason: string; matchesSlug: string | null }>;
  aliasesRemoved: number;
  relationshipsCreated: number;
  llmSkipped: boolean;
  llmSkipReason: string | null;
  finishedAt: string | null;
}

export async function getAliasAuditStatus(): Promise<{
  running: boolean;
  status: string;
  report: AliasAuditReport | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}> {
  const state = await getJobState(ALIAS_AUDIT_JOB);
  if (!state) {
    return { running: false, status: "idle", report: null, error: null, startedAt: null, finishedAt: null };
  }
  // A stale heartbeat (crashed fire-and-forget run) must read as not-running,
  // matching acquireJobLock's TTL takeover, or the admin button deadlocks.
  const heartbeatAge = state.heartbeatAt ? Date.now() - new Date(state.heartbeatAt).getTime() : Infinity;
  const running = state.status === "running" && heartbeatAge < LOCK_TTL_MS;
  return {
    running,
    status: running ? "running" : state.status === "running" ? "stalled" : state.status,
    report: (state.progress as unknown as AliasAuditReport) ?? null,
    error: state.error ?? null,
    startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
    finishedAt: state.finishedAt ? new Date(state.finishedAt).toISOString() : null,
  };
}

/** Insert a distinct_from relationship if the pair has no relationship yet. */
async function ensureDistinctFrom(
  fromId: string,
  toId: string,
  note: string,
  relPairs: Set<string>,
): Promise<boolean> {
  const key = [fromId, toId].sort().join("|");
  if (relPairs.has(key)) return false;
  try {
    await db.insert(conceptRelationshipsTable).values({
      fromConceptId: fromId,
      toConceptId: toId,
      relationType: "distinct_from",
      note,
    });
    relPairs.add(key);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505") {
      relPairs.add(key);
      return false;
    }
    throw err;
  }
}

/**
 * Start the audit. Returns the runId, or null when a run is already active.
 * The caller fire-and-forgets `executeAliasAudit(runId, dryRun)`.
 */
export async function startAliasAudit(): Promise<string | null> {
  return acquireJobLock(ALIAS_AUDIT_JOB, { ttlMs: LOCK_TTL_MS, progress: {} });
}

export async function executeAliasAudit(runId: string, dryRun: boolean): Promise<void> {
  aliasAuditCancelRequested = false; // reset for this run
  const report: AliasAuditReport = {
    dryRun,
    conceptsChecked: 0,
    aliasesChecked: 0,
    canonicalCollisions: [],
    sharedAliases: [],
    sharedAliasesAcknowledged: 0,
    llmFlags: [],
    aliasesRemoved: 0,
    relationshipsCreated: 0,
    llmSkipped: false,
    llmSkipReason: null,
    finishedAt: null,
  };
  try {
    const concepts = await db
      .select({
        id: conceptsTable.id,
        slug: conceptsTable.slug,
        term: conceptsTable.term,
        hoverDefinition: conceptsTable.hoverDefinition,
        definition: conceptsTable.definition,
      })
      .from(conceptsTable);
    const aliasRows = await db
      .select({
        id: conceptAliasesTable.id,
        conceptId: conceptAliasesTable.conceptId,
        alias: conceptAliasesTable.alias,
      })
      .from(conceptAliasesTable);
    const relRows = await db
      .select({
        fromConceptId: conceptRelationshipsTable.fromConceptId,
        toConceptId: conceptRelationshipsTable.toConceptId,
      })
      .from(conceptRelationshipsTable);

    const byId = new Map(concepts.map((c) => [c.id, c]));
    const termToConcept = new Map(concepts.map((c) => [c.term.trim().toLowerCase(), c]));
    const relPairs = new Set(relRows.map((r) => [r.fromConceptId, r.toConceptId].sort().join("|")));

    report.conceptsChecked = concepts.length;
    report.aliasesChecked = aliasRows.length;

    const removedAliasIds = new Set<string>();

    // ── Pass 1: alias === another concept's canonical term ────────────────
    for (const row of aliasRows) {
      const owner = byId.get(row.conceptId);
      if (!owner) continue;
      const match = termToConcept.get(row.alias.trim().toLowerCase());
      if (!match || match.id === owner.id) continue;
      report.canonicalCollisions.push({ conceptSlug: owner.slug, alias: row.alias, matchesSlug: match.slug });
      if (!dryRun) {
        await db.delete(conceptAliasesTable).where(eq(conceptAliasesTable.id, row.id));
        removedAliasIds.add(row.id);
        report.aliasesRemoved++;
        const created = await ensureDistinctFrom(
          owner.id,
          match.id,
          `Alias audit: "${row.alias}" was listed as an alias of "${owner.term}" but is its own glossary concept.`,
          relPairs,
        );
        if (created) report.relationshipsCreated++;
      }
    }

    // ── Pass 2: same alias on two different concepts ───────────────────────
    const aliasGroups = new Map<string, Array<{ conceptId: string }>>();
    for (const row of aliasRows) {
      if (removedAliasIds.has(row.id)) continue;
      const key = row.alias.trim().toLowerCase();
      const group = aliasGroups.get(key) ?? [];
      group.push({ conceptId: row.conceptId });
      aliasGroups.set(key, group);
    }
    for (const [alias, group] of aliasGroups) {
      const uniqueOwners = [...new Set(group.map((g) => g.conceptId))].filter((id) => byId.has(id));
      if (uniqueOwners.length < 2) continue;

      // Which owner pairs have NOT been acknowledged yet (no relationship of
      // any type on record)? Fully-acknowledged groups are suppressed so the
      // same shared aliases don't reappear in every report forever.
      const unacknowledged: Array<[string, string]> = [];
      for (let i = 0; i < uniqueOwners.length; i++) {
        for (let j = i + 1; j < uniqueOwners.length; j++) {
          const key = [uniqueOwners[i]!, uniqueOwners[j]!].sort().join("|");
          if (!relPairs.has(key)) unacknowledged.push([uniqueOwners[i]!, uniqueOwners[j]!]);
        }
      }
      if (unacknowledged.length === 0) {
        report.sharedAliasesAcknowledged++;
        continue;
      }

      report.sharedAliases.push({
        alias,
        conceptSlugs: uniqueOwners.map((id) => byId.get(id)!.slug),
      });
      if (!dryRun) {
        for (const [a, b] of unacknowledged) {
          const created = await ensureDistinctFrom(
            a,
            b,
            `Alias audit: both concepts claimed the shared alias "${alias}".`,
            relPairs,
          );
          if (created) report.relationshipsCreated++;
        }
      }
    }

    await heartbeatJob(ALIAS_AUDIT_JOB, runId, report as unknown as Record<string, unknown>);

    // ── Pass 3: LLM audit of remaining aliases ─────────────────────────────
    const remainingByConcept = new Map<string, string[]>();
    for (const row of aliasRows) {
      if (removedAliasIds.has(row.id)) continue;
      const list = remainingByConcept.get(row.conceptId) ?? [];
      list.push(row.alias.trim().toLowerCase());
      remainingByConcept.set(row.conceptId, list);
    }
    const auditable = concepts.filter((c) => (remainingByConcept.get(c.id)?.length ?? 0) > 0);

    let guard: BudgetGuard | null = null;
    try {
      guard = await BudgetGuard.start("concept alias audit");
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        report.llmSkipped = true;
        report.llmSkipReason = err.message;
      } else {
        throw err;
      }
    }

    if (guard) {
      outer: for (let offset = 0; offset < auditable.length; offset += LLM_BATCH_SIZE) {
        if (aliasAuditCancelRequested) {
          report.llmSkipped = true;
          report.llmSkipReason = "cancelled by admin";
          break outer;
        }
        try {
          await guard.check();
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            report.llmSkipped = true;
            report.llmSkipReason = err.message;
            break;
          }
          throw err;
        }
        const batch = auditable.slice(offset, offset + LLM_BATCH_SIZE);
        const inputs: AliasAuditConceptInput[] = batch.map((c, i) => ({
          index: i + 1,
          term: c.term,
          definition: c.hoverDefinition || c.definition || "",
          aliases: remainingByConcept.get(c.id) ?? [],
        }));
        const flags = await llmAuditConceptAliases(inputs);
        if (flags === null) {
          report.llmSkipped = true;
          report.llmSkipReason = "alias_audit AI function is paused or the call failed";
          break outer;
        }
        for (const flag of flags) {
          const concept = batch[flag.index - 1];
          if (!concept) continue;
          const match = termToConcept.get(flag.alias) ?? null;
          report.llmFlags.push({
            conceptSlug: concept.slug,
            alias: flag.alias,
            reason: flag.reason,
            matchesSlug: match && match.id !== concept.id ? match.slug : null,
          });
          if (!dryRun) {
            const deleted = await db
              .delete(conceptAliasesTable)
              .where(
                and(
                  eq(conceptAliasesTable.conceptId, concept.id),
                  sql`lower(${conceptAliasesTable.alias}) = ${flag.alias}`,
                ),
              )
              .returning({ id: conceptAliasesTable.id });
            report.aliasesRemoved += deleted.length;
            if (match && match.id !== concept.id) {
              const created = await ensureDistinctFrom(
                concept.id,
                match.id,
                `Alias audit: "${flag.alias}" named a distinct concept. ${flag.reason}`.trim(),
                relPairs,
              );
              if (created) report.relationshipsCreated++;
            }
          }
        }
        await heartbeatJob(ALIAS_AUDIT_JOB, runId, report as unknown as Record<string, unknown>);
      }
    }

    report.finishedAt = new Date().toISOString();
    await finishJob(ALIAS_AUDIT_JOB, runId, "succeeded", {
      progress: report as unknown as Record<string, unknown>,
    });
    logger.info(
      {
        dryRun,
        aliasesRemoved: report.aliasesRemoved,
        relationshipsCreated: report.relationshipsCreated,
        llmFlags: report.llmFlags.length,
        llmSkipped: report.llmSkipped,
      },
      "concept alias audit finished",
    );
  } catch (err) {
    logger.error({ err }, "concept alias audit failed");
    report.finishedAt = new Date().toISOString();
    await finishJob(ALIAS_AUDIT_JOB, runId, "failed", {
      progress: report as unknown as Record<string, unknown>,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Creation-time guard — filters model-proposed aliases that collide with
 * another concept's canonical term. Returns the safe subset plus the list of
 * rejected aliases with the colliding concept, so the caller can record
 * `distinct_from` relationships instead of persisting the conflation.
 */
export async function filterConflatingAliases(
  aliases: string[],
): Promise<{ safe: string[]; rejected: Array<{ alias: string; conceptId: string; conceptSlug: string }> }> {
  if (aliases.length === 0) return { safe: [], rejected: [] };
  const lowered = aliases.map((a) => a.toLowerCase().trim()).filter((a) => a.length > 0);
  if (lowered.length === 0) return { safe: [], rejected: [] };
  const collisions = await db
    .select({ id: conceptsTable.id, slug: conceptsTable.slug, term: conceptsTable.term })
    .from(conceptsTable)
    .where(sql`lower(${conceptsTable.term}) IN (${sql.join(lowered.map((a) => sql`${a}`), sql`, `)})`);
  if (collisions.length === 0) return { safe: lowered, rejected: [] };
  const byTerm = new Map(collisions.map((c) => [c.term.trim().toLowerCase(), c]));
  const safe: string[] = [];
  const rejected: Array<{ alias: string; conceptId: string; conceptSlug: string }> = [];
  for (const alias of lowered) {
    const hit = byTerm.get(alias);
    if (hit) rejected.push({ alias, conceptId: hit.id, conceptSlug: hit.slug });
    else safe.push(alias);
  }
  return { safe, rejected };
}
