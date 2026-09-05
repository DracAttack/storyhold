/**
 * Concept merge sweep — finds glossary entries that name the SAME underlying
 * concept (true duplicates / synonyms registered as separate entries) and
 * merges them into a single surviving entry.
 *
 * Candidate detection is deterministic and cheap (no O(n²) scan — everything
 * is map-keyed):
 *
 *   identical_term    — normalized canonical terms are equal (punctuation /
 *                       case / whitespace variants). Provable repeats: merged
 *                       WITHOUT the LLM.
 *   plural_variant    — normalized terms equal after depluralizing the last
 *                       word ("boundary" vs "boundaries"). Also deterministic.
 *   term_is_alias     — one concept's canonical term is registered as an
 *                       alias of another concept. LLM-confirmed.
 *   shared_wiki_page  — both concepts ground to the same Wikipedia page id.
 *                       LLM-confirmed (disambiguation pages can group
 *                       genuinely distinct terms).
 *   token_set_match   — same set of non-stopword term tokens in any order
 *                       ("framing effect" vs "effect of framing"). LLM-confirmed.
 *
 * Pairs that already have ANY recorded relationship (distinct_from, related,
 * parent_of, …) are never proposed — a curated relationship is a human
 * statement that the two entries are intentionally separate. This is also the
 * acknowledgment mechanism: judging a pair "distinct" (or an admin dismissing
 * one) records distinct_from, so the same pair is never re-proposed.
 *
 * LLM-confirmed pairs (verdict "merge", confidence ≥ MERGE_CONFIDENCE) are
 * merged automatically in apply mode; "distinct" verdicts record the
 * relationship; "unsure" / low-confidence pairs are listed in the report for
 * manual review via the existing per-concept merge tools.
 *
 * The survivor of each merge is picked deterministically: live status first,
 * then the entry with a definition, then higher published-article count, then
 * the older row. Merging re-points mentions, aliases, grounding sources,
 * relationships and Term-of-the-Day history (see mergeConcepts), then the
 * loser's vault doc is deactivated and the survivor re-synced.
 *
 * Runs behind the shared background_jobs lock; the report persists as the
 * job's progress snapshot (same pattern as the alias audit).
 */

import { db, conceptsTable, conceptAliasesTable, conceptRelationshipsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { llmJudgeConceptMergePairs, type MergeJudgePairInput } from "./llm";
import { acquireJobLock, heartbeatJob, finishJob, getJobState } from "./jobState";
import { BudgetGuard, BudgetExceededError } from "./aiBudget";
import { mergeConcepts } from "./conceptExplainer";
import { syncConceptToVault, deactivateConceptVaultDoc } from "./glossaryVaultSync";

export const MERGE_SWEEP_JOB = "concept_merge_sweep";
const LOCK_TTL_MS = 10 * 60_000;
const LLM_BATCH_SIZE = 10;
// Bound the LLM cost of a single run; remaining candidates surface next run.
const MAX_LLM_PAIRS = 120;
// Minimum judge confidence to auto-merge in apply mode.
const MERGE_CONFIDENCE = 0.75;

const STOPWORDS = new Set(["the", "a", "an", "of", "and", "or", "in", "on", "to", "for", "vs"]);

let mergeSweepCancelRequested = false;

/** Request a cooperative stop; the sweep halts after the current LLM batch. */
export function requestMergeSweepCancel(): void {
  mergeSweepCancelRequested = true;
}

export type MergeSignal =
  | "identical_term"
  | "plural_variant"
  | "term_is_alias"
  | "shared_wiki_page"
  | "token_set_match";

export interface MergePairReport {
  survivorSlug: string;
  survivorTerm: string;
  mergedSlug: string;
  mergedTerm: string;
  signal: MergeSignal;
  reason: string;
  confidence: number | null; // null = deterministic (no LLM involved)
}

export interface MergeReviewReport {
  aSlug: string;
  aTerm: string;
  bSlug: string;
  bTerm: string;
  signal: MergeSignal;
  reason: string;
  confidence: number | null;
}

export interface MergeSweepReport {
  dryRun: boolean;
  conceptsChecked: number;
  pairsConsidered: number;
  pairsJudged: number;
  /** Merges performed (apply mode) or proposed (dry run). */
  merged: MergePairReport[];
  /** Pairs the judge could not confirm — left for manual review. */
  needsReview: MergeReviewReport[];
  /** "Distinct" verdicts recorded as distinct_from (never re-proposed). */
  distinctRecorded: number;
  llmSkipped: boolean;
  llmSkipReason: string | null;
  finishedAt: string | null;
}

export async function getMergeSweepStatus(): Promise<{
  running: boolean;
  status: string;
  report: MergeSweepReport | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}> {
  const state = await getJobState(MERGE_SWEEP_JOB);
  if (!state) {
    return { running: false, status: "idle", report: null, error: null, startedAt: null, finishedAt: null };
  }
  const heartbeatAge = state.heartbeatAt ? Date.now() - new Date(state.heartbeatAt).getTime() : Infinity;
  const running = state.status === "running" && heartbeatAge < LOCK_TTL_MS;
  return {
    running,
    status: running ? "running" : state.status === "running" ? "stalled" : state.status,
    report: (state.progress as unknown as MergeSweepReport) ?? null,
    error: state.error ?? null,
    startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
    finishedAt: state.finishedAt ? new Date(state.finishedAt).toISOString() : null,
  };
}

export async function startMergeSweep(): Promise<string | null> {
  return acquireJobLock(MERGE_SWEEP_JOB, { ttlMs: LOCK_TTL_MS, progress: {} });
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function normalizeTerm(term: string): string {
  return term
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Depluralize the LAST word only ("attachment styles" → "attachment style"). */
function depluralize(norm: string): string {
  const words = norm.split(" ");
  const last = words[words.length - 1] ?? "";
  if (last.length > 3 && last.endsWith("ies")) words[words.length - 1] = `${last.slice(0, -3)}y`;
  else if (last.length > 3 && last.endsWith("es")) words[words.length - 1] = last.slice(0, -2);
  else if (last.length > 3 && last.endsWith("s") && !last.endsWith("ss")) {
    words[words.length - 1] = last.slice(0, -1);
  }
  return words.join(" ");
}

/** Sorted unique non-stopword tokens — order-insensitive term signature. */
function tokenSignature(norm: string): string {
  const tokens = [...new Set(norm.split(" ").filter((t) => t.length > 0 && !STOPWORDS.has(t)))];
  if (tokens.length === 0) return "";
  return tokens.sort().join("|");
}

interface SweepConcept {
  id: string;
  slug: string;
  term: string;
  status: string;
  definition: string;
  hoverDefinition: string;
  wikiPageId: number | null;
  articleCount: number;
  createdAt: Date;
}

/** Deterministic survivor pick: live > has definition > more articles > older. */
export function pickSurvivor(a: SweepConcept, b: SweepConcept): [SweepConcept, SweepConcept] {
  const rank = (c: SweepConcept): number[] => [
    c.status === "live" ? 0 : c.status === "draft" ? 1 : 2,
    (c.definition || c.hoverDefinition).trim().length > 0 ? 0 : 1,
    -c.articleCount,
    c.createdAt.getTime(),
  ];
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i]! < rb[i]!) return [a, b];
    if (ra[i]! > rb[i]!) return [b, a];
  }
  return a.id < b.id ? [a, b] : [b, a];
}

// Signal priority when a pair is detected by multiple signals (strongest wins
// for reporting; deterministic signals also decide the no-LLM path).
const SIGNAL_PRIORITY: MergeSignal[] = [
  "identical_term",
  "plural_variant",
  "term_is_alias",
  "shared_wiki_page",
  "token_set_match",
];
const DETERMINISTIC_SIGNALS = new Set<MergeSignal>(["identical_term", "plural_variant"]);

interface CandidatePair {
  aId: string;
  bId: string;
  signal: MergeSignal;
}

function pairKey(aId: string, bId: string): string {
  return [aId, bId].sort().join("|");
}

/** Insert a distinct_from relationship if the pair has no relationship yet. */
async function ensureDistinctFrom(
  fromId: string,
  toId: string,
  note: string,
  relPairs: Set<string>,
): Promise<boolean> {
  const key = pairKey(fromId, toId);
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

// ---------------------------------------------------------------------------
// Sweep execution
// ---------------------------------------------------------------------------

export async function executeMergeSweep(runId: string, dryRun: boolean): Promise<void> {
  mergeSweepCancelRequested = false;
  const report: MergeSweepReport = {
    dryRun,
    conceptsChecked: 0,
    pairsConsidered: 0,
    pairsJudged: 0,
    merged: [],
    needsReview: [],
    distinctRecorded: 0,
    llmSkipped: false,
    llmSkipReason: null,
    finishedAt: null,
  };
  try {
    const concepts: SweepConcept[] = await db
      .select({
        id: conceptsTable.id,
        slug: conceptsTable.slug,
        term: conceptsTable.term,
        status: conceptsTable.status,
        definition: conceptsTable.definition,
        hoverDefinition: conceptsTable.hoverDefinition,
        wikiPageId: conceptsTable.wikiPageId,
        articleCount: conceptsTable.articleCount,
        createdAt: conceptsTable.createdAt,
      })
      .from(conceptsTable);
    const aliasRows = await db
      .select({ conceptId: conceptAliasesTable.conceptId, alias: conceptAliasesTable.alias })
      .from(conceptAliasesTable);
    const relRows = await db
      .select({
        fromConceptId: conceptRelationshipsTable.fromConceptId,
        toConceptId: conceptRelationshipsTable.toConceptId,
      })
      .from(conceptRelationshipsTable);

    report.conceptsChecked = concepts.length;
    const byId = new Map(concepts.map((c) => [c.id, c]));
    const relPairs = new Set(relRows.map((r) => pairKey(r.fromConceptId, r.toConceptId)));
    // Raw relationship edges, kept so the guard can be re-evaluated against
    // RESOLVED ids after merges (a safe B–C pair can become a guarded A–C
    // pair once B merges into A — relPairs alone would miss that).
    const relEdges: Array<[string, string]> = relRows.map((r) => [r.fromConceptId, r.toConceptId]);
    const aliasesByConcept = new Map<string, string[]>();
    for (const row of aliasRows) {
      const list = aliasesByConcept.get(row.conceptId) ?? [];
      list.push(row.alias);
      aliasesByConcept.set(row.conceptId, list);
    }

    // ── Candidate generation (all map-keyed, no pairwise scan) ─────────────
    const candidates = new Map<string, CandidatePair>();
    const addPair = (aId: string, bId: string, signal: MergeSignal) => {
      if (aId === bId) return;
      const key = pairKey(aId, bId);
      if (relPairs.has(key)) return; // curated relationship = intentionally separate
      const existing = candidates.get(key);
      if (
        !existing ||
        SIGNAL_PRIORITY.indexOf(signal) < SIGNAL_PRIORITY.indexOf(existing.signal)
      ) {
        candidates.set(key, { aId, bId, signal });
      }
    };
    const addGroup = (group: SweepConcept[], signal: MergeSignal) => {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          addPair(group[i]!.id, group[j]!.id, signal);
        }
      }
    };
    const groupBy = (keyOf: (c: SweepConcept) => string | null): Map<string, SweepConcept[]> => {
      const m = new Map<string, SweepConcept[]>();
      for (const c of concepts) {
        const k = keyOf(c);
        if (!k) continue;
        const g = m.get(k) ?? [];
        g.push(c);
        m.set(k, g);
      }
      return m;
    };

    const normOf = new Map(concepts.map((c) => [c.id, normalizeTerm(c.term)]));

    // identical_term / plural_variant / token_set_match / shared_wiki_page
    for (const g of groupBy((c) => normOf.get(c.id) || null).values()) addGroup(g, "identical_term");
    for (const g of groupBy((c) => depluralize(normOf.get(c.id) ?? "") || null).values()) {
      addGroup(g, "plural_variant");
    }
    for (const g of groupBy((c) => tokenSignature(normOf.get(c.id) ?? "") || null).values()) {
      addGroup(g, "token_set_match");
    }
    for (const g of groupBy((c) => (c.wikiPageId != null ? String(c.wikiPageId) : null)).values()) {
      addGroup(g, "shared_wiki_page");
    }
    // term_is_alias — a concept's canonical term registered as another's alias
    const conceptsByNorm = groupBy((c) => normOf.get(c.id) || null);
    for (const row of aliasRows) {
      const aliasNorm = normalizeTerm(row.alias);
      if (!aliasNorm) continue;
      for (const other of conceptsByNorm.get(aliasNorm) ?? []) {
        addPair(row.conceptId, other.id, "term_is_alias");
      }
    }

    report.pairsConsidered = candidates.size;
    await heartbeatJob(MERGE_SWEEP_JOB, runId, report as unknown as Record<string, unknown>);

    // Merged-id remapping — once B merges into A, later pairs naming B
    // resolve to A (and collapse when both sides resolve to the same row).
    const remap = new Map<string, string>();
    const resolve = (id: string): string => {
      let cur = id;
      while (remap.has(cur)) cur = remap.get(cur)!;
      return cur;
    };

    // True when the RESOLVED pair is covered by any existing relationship edge
    // (each edge's endpoints are resolved too, so relationships inherited by a
    // survivor through an earlier merge in this run still guard the pair).
    const hasRelationshipResolved = (aId: string, bId: string): boolean => {
      const key = pairKey(aId, bId);
      return relEdges.some(([from, to]) => pairKey(resolve(from), resolve(to)) === key);
    };

    const performMerge = async (
      pair: CandidatePair,
      reason: string,
      confidence: number | null,
    ): Promise<void> => {
      const aId = resolve(pair.aId);
      const bId = resolve(pair.bId);
      if (aId === bId) return;
      if (hasRelationshipResolved(aId, bId)) {
        logger.info(
          { a: aId, b: bId, signal: pair.signal },
          "merge sweep: pair became relationship-guarded after earlier merge — skipping",
        );
        return;
      }
      const a = byId.get(aId);
      const b = byId.get(bId);
      if (!a || !b) return;
      const [survivor, loser] = pickSurvivor(a, b);
      const entry: MergePairReport = {
        survivorSlug: survivor.slug,
        survivorTerm: survivor.term,
        mergedSlug: loser.slug,
        mergedTerm: loser.term,
        signal: pair.signal,
        reason,
        confidence,
      };
      if (dryRun) {
        report.merged.push(entry);
        // Simulate the merge so chained pairs collapse in the dry-run report too.
        remap.set(loser.id, survivor.id);
        return;
      }
      const result = await mergeConcepts(loser.id, survivor.id);
      if (!result) {
        logger.warn({ loser: loser.slug, survivor: survivor.slug }, "merge sweep: mergeConcepts returned null");
        return;
      }
      remap.set(loser.id, survivor.id);
      report.merged.push(entry);
      await deactivateConceptVaultDoc(loser.id);
      void syncConceptToVault(survivor.id);
    };

    // ── Pass 1: deterministic merges (provable repeats, no LLM) ────────────
    const llmPairs: CandidatePair[] = [];
    for (const pair of candidates.values()) {
      if (DETERMINISTIC_SIGNALS.has(pair.signal)) {
        await performMerge(
          pair,
          pair.signal === "identical_term"
            ? "Canonical terms are identical after normalization."
            : "Terms differ only by pluralization.",
          null,
        );
      } else {
        llmPairs.push(pair);
      }
    }
    await heartbeatJob(MERGE_SWEEP_JOB, runId, report as unknown as Record<string, unknown>);

    // ── Pass 2: LLM judge for the non-provable candidates ──────────────────
    const judgeable = llmPairs.slice(0, MAX_LLM_PAIRS);
    if (llmPairs.length > MAX_LLM_PAIRS) {
      logger.info(
        { total: llmPairs.length, cap: MAX_LLM_PAIRS },
        "merge sweep: candidate pairs over cap — remainder deferred to next run",
      );
    }

    let guard: BudgetGuard | null = null;
    if (judgeable.length > 0) {
      try {
        guard = await BudgetGuard.start("concept merge sweep");
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          report.llmSkipped = true;
          report.llmSkipReason = err.message;
        } else {
          throw err;
        }
      }
    }

    if (guard) {
      outer: for (let offset = 0; offset < judgeable.length; offset += LLM_BATCH_SIZE) {
        if (mergeSweepCancelRequested) {
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
        const batch = judgeable.slice(offset, offset + LLM_BATCH_SIZE);
        // Skip pairs already collapsed by earlier merges in this run, and pairs
        // that became relationship-guarded once their ids resolved to survivors.
        const active = batch.filter((p) => {
          const aId = resolve(p.aId);
          const bId = resolve(p.bId);
          return aId !== bId && !hasRelationshipResolved(aId, bId);
        });
        if (active.length === 0) continue;
        const inputs: MergeJudgePairInput[] = active.map((p, i) => {
          const a = byId.get(resolve(p.aId))!;
          const b = byId.get(resolve(p.bId))!;
          return {
            index: i + 1,
            a: {
              term: a.term,
              definition: (a.definition || a.hoverDefinition || "").slice(0, 300),
              aliases: aliasesByConcept.get(a.id) ?? [],
            },
            b: {
              term: b.term,
              definition: (b.definition || b.hoverDefinition || "").slice(0, 300),
              aliases: aliasesByConcept.get(b.id) ?? [],
            },
          };
        });
        const verdicts = await llmJudgeConceptMergePairs(inputs);
        if (verdicts === null) {
          report.llmSkipped = true;
          report.llmSkipReason = "merge_sweep AI function is paused or the call failed";
          break outer;
        }
        report.pairsJudged += active.length;
        for (let i = 0; i < active.length; i++) {
          const pair = active[i]!;
          const verdict = verdicts.find((v) => v.index === i + 1);
          const a = byId.get(resolve(pair.aId));
          const b = byId.get(resolve(pair.bId));
          if (!a || !b || a.id === b.id) continue;
          if (verdict && verdict.verdict === "merge" && verdict.confidence >= MERGE_CONFIDENCE) {
            await performMerge(pair, verdict.reason, verdict.confidence);
          } else if (verdict && verdict.verdict === "distinct") {
            if (!dryRun) {
              const created = await ensureDistinctFrom(
                a.id,
                b.id,
                `Merge sweep: judged distinct concepts. ${verdict.reason}`.trim(),
                relPairs,
              );
              if (created) {
                report.distinctRecorded++;
                relEdges.push([a.id, b.id]);
              }
            } else {
              report.distinctRecorded++;
              relEdges.push([a.id, b.id]);
            }
          } else {
            report.needsReview.push({
              aSlug: a.slug,
              aTerm: a.term,
              bSlug: b.slug,
              bTerm: b.term,
              signal: pair.signal,
              reason: verdict?.reason ?? "Judge did not return a verdict for this pair.",
              confidence: verdict?.confidence ?? null,
            });
          }
        }
        await heartbeatJob(MERGE_SWEEP_JOB, runId, report as unknown as Record<string, unknown>);
      }
    } else if (judgeable.length > 0) {
      // Budget blocked the judge — surface the pairs for manual review.
      for (const pair of judgeable) {
        const a = byId.get(resolve(pair.aId));
        const b = byId.get(resolve(pair.bId));
        if (!a || !b || a.id === b.id) continue;
        report.needsReview.push({
          aSlug: a.slug,
          aTerm: a.term,
          bSlug: b.slug,
          bTerm: b.term,
          signal: pair.signal,
          reason: "AI judge skipped — review manually.",
          confidence: null,
        });
      }
    }

    report.finishedAt = new Date().toISOString();
    await finishJob(MERGE_SWEEP_JOB, runId, "succeeded", {
      progress: report as unknown as Record<string, unknown>,
    });
    logger.info(
      {
        dryRun,
        pairsConsidered: report.pairsConsidered,
        merged: report.merged.length,
        needsReview: report.needsReview.length,
        distinctRecorded: report.distinctRecorded,
        llmSkipped: report.llmSkipped,
      },
      "concept merge sweep finished",
    );
  } catch (err) {
    logger.error({ err }, "concept merge sweep failed");
    report.finishedAt = new Date().toISOString();
    await finishJob(MERGE_SWEEP_JOB, runId, "failed", {
      progress: report as unknown as Record<string, unknown>,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
