// --- Source-to-concept edge persistence + backfill (Task #338) --------------
// Wires the pure deterministic tagger (conceptTagger.ts) to the DB:
//  - loadConceptLexicon: live/draft concept terms + aliases → matcher input
//  - tagSourceDocumentConcepts: tag ONE document and replace its edges
//    (fire-and-forget from the ingestion pipeline — never blocks or throws)
//  - refreshConceptEdges: re-tag ONE concept across the vault (concept edit /
//    hourly glossary reconcile). ILIKE prefilter narrows candidates, then the
//    pure matcher confirms word-boundary hits.
//  - startConceptEdgeBackfill: DB-locked bulk job over untagged documents
//    (jobState lock, runId-fenced — NOT a module boolean).
// Edges never change evidence eligibility; glossary-lane docs are never tagged.

import {
  db,
  sourceDocumentsTable,
  sourceConceptEdgesTable,
  conceptsTable,
  conceptAliasesTable,
  conceptRelationshipsTable,
} from "@workspace/db";
import { and, eq, ne, isNull, inArray, asc, desc, gt, or, ilike, notInArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  tagDocumentText,
  buildSurfaceFormRegex,
  type ConceptLexiconEntry,
} from "./conceptTagger";
import {
  findQueryConcepts,
  buildExpansionTerms,
  EXCLUDED_RELATION_TYPES,
  MAX_EDGE_LINKED_DOCS,
} from "./conceptQueryPlanner";
import {
  acquireJobLock,
  heartbeatJob,
  finishJob,
  isCancelRequested,
  requestJobCancel,
  getJobState,
  isJobRunning,
  type JobStateRow,
} from "./jobState";

export const CONCEPT_EDGE_BACKFILL_JOB = "concept_edge_backfill";
// Heartbeat TTL: a runner silent for this long is considered crashed and can
// be taken over by a new acquire (jobState fencing makes the old run a no-op).
const BACKFILL_TTL_MS = 10 * 60 * 1000;
const BACKFILL_BATCH = 50;
// Candidate page size for the per-concept refresh (keyset pagination — the
// refresh must see EVERY prefilter candidate before pruning stale edges).
const REFRESH_BATCH = 500;

// Document eligibility for tagging: successfully extracted (embedded or not),
// active, a representative (not a duplicate), and NOT the internal glossary
// lane (a glossary doc trivially contains its own term — an edge would be
// circular noise, and that lane must stay isolated from evidence retrieval).
const TAGGABLE_STATUSES = ["extracted", "embedded"] as const;

export function taggableDocFilter() {
  return and(
    inArray(sourceDocumentsTable.status, [...TAGGABLE_STATUSES]),
    eq(sourceDocumentsTable.lifecycleStatus, "active"),
    isNull(sourceDocumentsTable.duplicateOfId),
    ne(sourceDocumentsTable.discoveredVia, "glossary_concept"),
  );
}

/**
 * Load the matcher lexicon: every non-hidden concept's canonical term plus its
 * aliases. Hidden concepts get no edges (and refresh/reconcile removes any
 * they had).
 */
export async function loadConceptLexicon(): Promise<ConceptLexiconEntry[]> {
  const [concepts, aliases] = await Promise.all([
    db
      .select({ id: conceptsTable.id, term: conceptsTable.term })
      .from(conceptsTable)
      .where(ne(conceptsTable.status, "hidden")),
    db
      .select({ conceptId: conceptAliasesTable.conceptId, alias: conceptAliasesTable.alias })
      .from(conceptAliasesTable),
  ]);
  const aliasMap = new Map<string, string[]>();
  for (const a of aliases) {
    if (!a.alias?.trim()) continue;
    const list = aliasMap.get(a.conceptId) ?? [];
    list.push(a.alias);
    aliasMap.set(a.conceptId, list);
  }
  return concepts.map((c) => ({
    conceptId: c.id,
    term: c.term,
    aliases: aliasMap.get(c.id) ?? [],
  }));
}

/**
 * Replace one document's edge set with the matches computed by the tagger and
 * stamp concept_edges_tagged_at. Upserts matched concepts, deletes edges to
 * concepts no longer matched. Never throws (logs and returns a count instead)
 * so ingestion hooks can fire-and-forget it.
 */
export async function tagSourceDocumentConcepts(
  documentId: string,
  preloadedLexicon?: ConceptLexiconEntry[],
): Promise<{ tagged: boolean; edges: number }> {
  try {
    const doc = await db
      .select({
        id: sourceDocumentsTable.id,
        title: sourceDocumentsTable.title,
        extractedText: sourceDocumentsTable.extractedText,
        status: sourceDocumentsTable.status,
        lifecycleStatus: sourceDocumentsTable.lifecycleStatus,
        duplicateOfId: sourceDocumentsTable.duplicateOfId,
        discoveredVia: sourceDocumentsTable.discoveredVia,
      })
      .from(sourceDocumentsTable)
      .where(eq(sourceDocumentsTable.id, documentId))
      .limit(1)
      .then((r) => r[0] ?? null);
    if (!doc) return { tagged: false, edges: 0 };

    const eligible =
      (TAGGABLE_STATUSES as readonly string[]).includes(doc.status) &&
      doc.lifecycleStatus === "active" &&
      doc.duplicateOfId == null &&
      doc.discoveredVia !== "glossary_concept" &&
      Boolean(doc.extractedText?.trim() || doc.title?.trim());
    if (!eligible) return { tagged: false, edges: 0 };

    const lexicon = preloadedLexicon ?? (await loadConceptLexicon());
    const matches = tagDocumentText({ title: doc.title, text: doc.extractedText }, lexicon);
    const now = new Date();

    const matchedIds = matches.map((m) => m.conceptId);
    if (matchedIds.length === 0) {
      await db
        .delete(sourceConceptEdgesTable)
        .where(eq(sourceConceptEdgesTable.sourceDocumentId, documentId));
    } else {
      await db
        .delete(sourceConceptEdgesTable)
        .where(
          and(
            eq(sourceConceptEdgesTable.sourceDocumentId, documentId),
            notInArray(sourceConceptEdgesTable.conceptId, matchedIds),
          ),
        );
      for (const m of matches) {
        await db
          .insert(sourceConceptEdgesTable)
          .values({
            sourceDocumentId: documentId,
            conceptId: m.conceptId,
            confidence: m.confidence,
            matchedSections: m.matchedSections,
          })
          .onConflictDoUpdate({
            target: [sourceConceptEdgesTable.sourceDocumentId, sourceConceptEdgesTable.conceptId],
            set: {
              confidence: m.confidence,
              matchedSections: m.matchedSections,
              updatedAt: now,
            },
          });
      }
    }

    await db
      .update(sourceDocumentsTable)
      .set({ conceptEdgesTaggedAt: now })
      .where(eq(sourceDocumentsTable.id, documentId));

    return { tagged: true, edges: matches.length };
  } catch (err) {
    logger.warn({ err, documentId }, "conceptEdges: tagging document failed");
    return { tagged: false, edges: 0 };
  }
}

/** Escape `%`, `_`, and `\` for a safe ILIKE contains-pattern. */
function escapeIlike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Remove every edge for a concept (hidden concept / explicit cleanup). */
export async function removeConceptEdges(conceptId: string): Promise<number> {
  const deleted = await db
    .delete(sourceConceptEdgesTable)
    .where(eq(sourceConceptEdgesTable.conceptId, conceptId))
    .returning({ id: sourceConceptEdgesTable.id });
  return deleted.length;
}

/**
 * Re-tag ONE concept across the whole vault (after a term/alias edit or from
 * the hourly glossary reconcile). A SQL ILIKE prefilter over title +
 * extracted_text narrows candidates, then the pure word-boundary matcher
 * confirms and scores. Replaces the concept's edge set: confirmed docs are
 * upserted, stale edges deleted. Hidden/deleted concepts lose all edges.
 * Never throws — safe to fire-and-forget from admin routes.
 */
export async function refreshConceptEdges(
  conceptId: string,
): Promise<{ ok: boolean; edges: number }> {
  try {
    const concept = await db
      .select({ id: conceptsTable.id, term: conceptsTable.term, status: conceptsTable.status })
      .from(conceptsTable)
      .where(eq(conceptsTable.id, conceptId))
      .limit(1)
      .then((r) => r[0] ?? null);

    if (!concept || concept.status === "hidden") {
      await removeConceptEdges(conceptId);
      return { ok: true, edges: 0 };
    }

    const aliases = await db
      .select({ alias: conceptAliasesTable.alias })
      .from(conceptAliasesTable)
      .where(eq(conceptAliasesTable.conceptId, conceptId));

    const entry: ConceptLexiconEntry = {
      conceptId,
      term: concept.term,
      aliases: aliases.map((a) => a.alias).filter(Boolean),
    };

    // Only surface forms the matcher would actually use drive the prefilter
    // (forms below the length floor would ILIKE-match but never confirm).
    const usableForms = [entry.term, ...entry.aliases].filter(
      (f) => buildSurfaceFormRegex(f) !== null,
    );
    if (usableForms.length === 0) {
      await removeConceptEdges(conceptId);
      return { ok: true, edges: 0 };
    }

    const likeClauses = usableForms.flatMap((f) => {
      const pattern = `%${escapeIlike(f.trim())}%`;
      return [
        ilike(sourceDocumentsTable.title, pattern),
        ilike(sourceDocumentsTable.extractedText, pattern),
      ];
    });

    // Keyset-paginate ALL prefilter candidates (no hard cap): the stale-edge
    // delete below removes everything not in confirmedIds, so a truncated
    // candidate window would silently drop valid edges for high-frequency
    // terms. Batches keep memory bounded for large extracted_text rows.
    const now = new Date();
    const confirmedIds: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const candidates: Array<{ id: string; title: string | null; extractedText: string | null }> =
        await db
          .select({
            id: sourceDocumentsTable.id,
            title: sourceDocumentsTable.title,
            extractedText: sourceDocumentsTable.extractedText,
          })
          .from(sourceDocumentsTable)
          .where(
            and(
              taggableDocFilter(),
              or(...likeClauses),
              ...(cursor ? [gt(sourceDocumentsTable.id, cursor)] : []),
            ),
          )
          .orderBy(asc(sourceDocumentsTable.id))
          .limit(REFRESH_BATCH);
      if (candidates.length === 0) break;

      for (const doc of candidates) {
        const matches = tagDocumentText({ title: doc.title, text: doc.extractedText }, [entry]);
        const m = matches[0];
        if (!m) continue;
        confirmedIds.push(doc.id);
        await db
          .insert(sourceConceptEdgesTable)
          .values({
            sourceDocumentId: doc.id,
            conceptId,
            confidence: m.confidence,
            matchedSections: m.matchedSections,
          })
          .onConflictDoUpdate({
            target: [sourceConceptEdgesTable.sourceDocumentId, sourceConceptEdgesTable.conceptId],
            set: { confidence: m.confidence, matchedSections: m.matchedSections, updatedAt: now },
          });
      }
      cursor = candidates[candidates.length - 1]!.id;
    }

    // Drop edges to documents the edited term/aliases no longer match.
    if (confirmedIds.length === 0) {
      await db
        .delete(sourceConceptEdgesTable)
        .where(eq(sourceConceptEdgesTable.conceptId, conceptId));
    } else {
      await db
        .delete(sourceConceptEdgesTable)
        .where(
          and(
            eq(sourceConceptEdgesTable.conceptId, conceptId),
            notInArray(sourceConceptEdgesTable.sourceDocumentId, confirmedIds),
          ),
        );
    }

    return { ok: true, edges: confirmedIds.length };
  } catch (err) {
    logger.warn({ err, conceptId }, "conceptEdges: refreshing concept edges failed");
    return { ok: false, edges: 0 };
  }
}

// --- Concept-aware retrieval plan (Task #338, DB glue for the pure planner) --

export interface ConceptRetrievalPlan {
  /** Concepts the query text mentions (by term/alias, word-boundary). */
  matchedConceptIds: string[];
  /** Aliases + related-concept terms to append to the semantic query. */
  expansionTerms: string[];
  /** Edge-linked documents (evidence-eligible only), strongest edges first. */
  edgeDocs: Array<{ documentId: string; confidence: number }>;
}

export const EMPTY_CONCEPT_RETRIEVAL_PLAN: ConceptRetrievalPlan = {
  matchedConceptIds: [],
  expansionTerms: [],
  edgeDocs: [],
};

/**
 * Build a concept-aware retrieval plan for a semantic query: which glossary
 * concepts the query mentions, which extra vocabulary to search with, and
 * which vault documents are edge-linked to those concepts. Purely additive —
 * a query that matches no concept returns the empty plan (identical retrieval
 * behavior), and any failure degrades to the empty plan (never throws).
 * Edge-linked docs are restricted to evidence-eligible, taggable documents so
 * the glossary lane and duplicates can never leak into evidence retrieval.
 */
export async function planConceptRetrieval(queryText: string): Promise<ConceptRetrievalPlan> {
  try {
    const text = queryText.trim();
    if (!text) return EMPTY_CONCEPT_RETRIEVAL_PLAN;

    const lexicon = await loadConceptLexicon();
    const matched = findQueryConcepts(text, lexicon);
    if (matched.length === 0) return EMPTY_CONCEPT_RETRIEVAL_PLAN;
    const matchedIds = matched.map((m) => m.conceptId);

    // Related-concept terms (never distinct_from — explicitly NOT the same
    // concept) from non-hidden neighbors of the matched concepts.
    const related = await db
      .select({ term: conceptsTable.term })
      .from(conceptRelationshipsTable)
      .innerJoin(conceptsTable, eq(conceptRelationshipsTable.toConceptId, conceptsTable.id))
      .where(
        and(
          inArray(conceptRelationshipsTable.fromConceptId, matchedIds),
          notInArray(conceptRelationshipsTable.relationType, [...EXCLUDED_RELATION_TYPES]),
          ne(conceptsTable.status, "hidden"),
        ),
      );

    const expansionTerms = buildExpansionTerms(text, matched, related.map((r) => r.term));

    const edgeRows = await db
      .select({
        documentId: sourceConceptEdgesTable.sourceDocumentId,
        confidence: sourceConceptEdgesTable.confidence,
      })
      .from(sourceConceptEdgesTable)
      .innerJoin(
        sourceDocumentsTable,
        eq(sourceConceptEdgesTable.sourceDocumentId, sourceDocumentsTable.id),
      )
      .where(
        and(
          inArray(sourceConceptEdgesTable.conceptId, matchedIds),
          eq(sourceDocumentsTable.evidenceEligible, true),
          taggableDocFilter(),
        ),
      )
      .orderBy(desc(sourceConceptEdgesTable.confidence), asc(sourceConceptEdgesTable.sourceDocumentId))
      .limit(MAX_EDGE_LINKED_DOCS * 2);

    // Dedupe by document (a doc can be linked to several matched concepts —
    // keep its strongest edge), then cap.
    const byDoc = new Map<string, number>();
    for (const row of edgeRows) {
      const prev = byDoc.get(row.documentId);
      if (prev === undefined || row.confidence > prev) byDoc.set(row.documentId, row.confidence);
    }
    const edgeDocs = Array.from(byDoc.entries())
      .map(([documentId, confidence]) => ({ documentId, confidence }))
      .sort((a, b) => b.confidence - a.confidence || a.documentId.localeCompare(b.documentId))
      .slice(0, MAX_EDGE_LINKED_DOCS);

    return { matchedConceptIds: matchedIds, expansionTerms, edgeDocs };
  } catch (err) {
    logger.warn({ err }, "conceptEdges: retrieval plan failed; degrading to no-op plan");
    return EMPTY_CONCEPT_RETRIEVAL_PLAN;
  }
}

export interface ConceptEdgeBackfillProgress {
  scanned: number;
  tagged: number;
  edges: number;
  remaining: number;
}

async function countBackfillCandidates(): Promise<number> {
  const rows = await db
    .select({ n: sql<string>`count(*)` })
    .from(sourceDocumentsTable)
    .where(and(taggableDocFilter(), isNull(sourceDocumentsTable.conceptEdgesTaggedAt)));
  // Raw sql aggregates come back as strings at runtime — coerce explicitly.
  return Number(rows[0]?.n ?? 0);
}

/**
 * Start the bulk backfill over every untagged eligible document. DB-locked via
 * jobState (runId-fenced heartbeats — a crashed run is taken over after the
 * TTL, and its late writes are no-ops). Returns started=false when a live run
 * already holds the lock. The actual work runs in an unawaited promise; the
 * caller should 202 immediately.
 */
export async function startConceptEdgeBackfill(): Promise<{ started: boolean }> {
  const remaining = await countBackfillCandidates();
  const runId = await acquireJobLock(CONCEPT_EDGE_BACKFILL_JOB, {
    ttlMs: BACKFILL_TTL_MS,
    progress: { scanned: 0, tagged: 0, edges: 0, remaining } satisfies ConceptEdgeBackfillProgress,
  });
  if (!runId) return { started: false };

  void (async () => {
    const progress: ConceptEdgeBackfillProgress = { scanned: 0, tagged: 0, edges: 0, remaining };
    try {
      const lexicon = await loadConceptLexicon();
      let cursor: string | null = null;
      for (;;) {
        if (await isCancelRequested(CONCEPT_EDGE_BACKFILL_JOB)) {
          await finishJob(CONCEPT_EDGE_BACKFILL_JOB, runId, "succeeded", {
            progress: { ...progress },
            error: "cancelled by admin",
          });
          return;
        }
        const filter = and(
          taggableDocFilter(),
          isNull(sourceDocumentsTable.conceptEdgesTaggedAt),
          ...(cursor ? [gt(sourceDocumentsTable.id, cursor)] : []),
        );
        const batch: Array<{ id: string }> = await db
          .select({ id: sourceDocumentsTable.id })
          .from(sourceDocumentsTable)
          .where(filter)
          .orderBy(asc(sourceDocumentsTable.id))
          .limit(BACKFILL_BATCH);
        if (batch.length === 0) break;

        for (const { id } of batch) {
          const res = await tagSourceDocumentConcepts(id, lexicon);
          progress.scanned += 1;
          if (res.tagged) progress.tagged += 1;
          progress.edges += res.edges;
          progress.remaining = Math.max(0, progress.remaining - 1);
        }
        await heartbeatJob(CONCEPT_EDGE_BACKFILL_JOB, runId, { ...progress });
        cursor = batch[batch.length - 1]!.id;
      }
      await finishJob(CONCEPT_EDGE_BACKFILL_JOB, runId, "succeeded", { progress: { ...progress } });
      logger.info(progress, "conceptEdges: backfill complete");
    } catch (err) {
      logger.error({ err }, "conceptEdges: backfill failed");
      await finishJob(CONCEPT_EDGE_BACKFILL_JOB, runId, "failed", {
        progress: { ...progress },
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  return { started: true };
}

export interface ConceptEdgeBackfillStatus {
  running: boolean;
  state: JobStateRow | null;
  remaining: number;
}

/** Current backfill state for the admin poller (stale heartbeat = not running). */
export async function getConceptEdgeBackfillStatus(): Promise<ConceptEdgeBackfillStatus> {
  const [state, remaining] = await Promise.all([
    getJobState(CONCEPT_EDGE_BACKFILL_JOB),
    countBackfillCandidates(),
  ]);
  return { running: isJobRunning(state, BACKFILL_TTL_MS), state, remaining };
}

/** Cooperative cancel; false when no live run holds the lock (stale = not live). */
export async function requestConceptEdgeBackfillCancel(): Promise<boolean> {
  const state = await getJobState(CONCEPT_EDGE_BACKFILL_JOB);
  if (!isJobRunning(state, BACKFILL_TTL_MS)) return false;
  return requestJobCancel(CONCEPT_EDGE_BACKFILL_JOB);
}
