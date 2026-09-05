// --- Concept-to-beat affinity weights — DB glue + recompute job --------------
// Loads the deterministic inputs (published-article mentions, source-concept
// edges, relationship neighbors), runs the pure computation in
// conceptBeatAffinity.ts, and rewrites each concept's profile in a transaction
// so profiles never mix generations. Triggered by the daily cron tick
// (claimJobPeriod-gated) and on demand from the admin (in-process run claim —
// the recompute is cheap, DB-only, and idempotent).

import {
  db,
  conceptsTable,
  conceptBeatAffinitiesTable,
  conceptRelationshipsTable,
  articleConceptMentionsTable,
  articlesTable,
  beatsTable,
  sourceConceptEdgesTable,
  sourceDocumentsTable,
} from "@workspace/db";
import { and, eq, ne, sql, gte, notInArray, isNotNull } from "drizzle-orm";
import { logger } from "../lib/logger";
import { taggableDocFilter } from "./conceptEdges";
import {
  buildArticleSignal,
  buildSourceSignal,
  buildBaseProfile,
  buildRelationshipSignal,
  computeAffinityRows,
  isBridgeProfile,
  AFFINITY_EXCLUDED_RELATION_TYPES,
  BRIDGE_WEIGHT_THRESHOLD,
  BRIDGE_MIN_BEATS,
  type ArticleMentionInput,
  type EdgeDocInput,
  type BeatDistribution,
  type ConceptBeatAffinityRow,
} from "./conceptBeatAffinity";

export interface ConceptBeatAffinitySummary {
  concepts: number;
  conceptsWithProfile: number;
  rowsWritten: number;
  bridgeConcepts: number;
}

// In-process run claim (single-server assumption, same as the other
// fire-and-forget admin jobs). Claimed synchronously BEFORE the first await so
// concurrent POSTs can't both start a run.
let recomputeInFlight = false;

export function isConceptBeatAffinityRecomputeRunning(): boolean {
  return recomputeInFlight;
}

/**
 * Recompute every non-hidden concept's beat profile. Full rewrite per concept
 * (delete + insert inside one transaction). Hidden concepts get their rows
 * removed. Deterministic, no LLM cost. Throws on unexpected DB failure —
 * callers wrap it (fire-and-forget with logging, or cron catch).
 */
export async function recomputeAllConceptBeatAffinities(): Promise<ConceptBeatAffinitySummary> {
  const [beats, concepts, mentionRows, edgeRows, relationRows] = await Promise.all([
    db.select({ slug: beatsTable.slug }).from(beatsTable),
    db
      .select({ id: conceptsTable.id })
      .from(conceptsTable)
      .where(ne(conceptsTable.status, "hidden")),
    // Published-article mentions: primary beat + secondary subject beats.
    db
      .select({
        conceptId: articleConceptMentionsTable.conceptId,
        primaryBeat: articlesTable.categorySlug,
        secondaryBeats: articlesTable.secondaryBeats,
      })
      .from(articleConceptMentionsTable)
      .innerJoin(articlesTable, eq(articleConceptMentionsTable.articleId, articlesTable.id))
      .where(eq(articlesTable.status, "published")),
    // Edge-linked vault docs with beat context (taggable/active docs only —
    // the same eligibility the edges themselves require).
    db
      .select({
        conceptId: sourceConceptEdgesTable.conceptId,
        beatSlug: sourceDocumentsTable.beatSlug,
        confidence: sourceConceptEdgesTable.confidence,
      })
      .from(sourceConceptEdgesTable)
      .innerJoin(
        sourceDocumentsTable,
        eq(sourceConceptEdgesTable.sourceDocumentId, sourceDocumentsTable.id),
      )
      .where(and(taggableDocFilter(), isNotNull(sourceDocumentsTable.beatSlug))),
    // One-hop relationship neighbors (affinity-carrying types only).
    db
      .select({
        fromConceptId: conceptRelationshipsTable.fromConceptId,
        toConceptId: conceptRelationshipsTable.toConceptId,
      })
      .from(conceptRelationshipsTable)
      .where(
        notInArray(conceptRelationshipsTable.relationType, [...AFFINITY_EXCLUDED_RELATION_TYPES]),
      ),
  ]);

  const validBeats: ReadonlySet<string> = new Set(beats.map((b) => b.slug));
  const liveConceptIds = new Set(concepts.map((c) => c.id));

  const mentionsByConcept = new Map<string, ArticleMentionInput[]>();
  for (const row of mentionRows) {
    if (!liveConceptIds.has(row.conceptId)) continue;
    const list = mentionsByConcept.get(row.conceptId) ?? [];
    list.push({ primaryBeat: row.primaryBeat, secondaryBeats: row.secondaryBeats });
    mentionsByConcept.set(row.conceptId, list);
  }

  const edgesByConcept = new Map<string, EdgeDocInput[]>();
  for (const row of edgeRows) {
    if (!liveConceptIds.has(row.conceptId)) continue;
    const list = edgesByConcept.get(row.conceptId) ?? [];
    list.push({ beatSlug: row.beatSlug, confidence: row.confidence });
    edgesByConcept.set(row.conceptId, list);
  }

  // Undirected one-hop adjacency among non-hidden concepts. Relationship rows
  // are directional (parent_of / subtype_of are inverses) but topical affinity
  // transfers both ways.
  const neighborsByConcept = new Map<string, Set<string>>();
  const addNeighbor = (a: string, b: string) => {
    if (a === b) return;
    if (!liveConceptIds.has(a) || !liveConceptIds.has(b)) return;
    const set = neighborsByConcept.get(a) ?? new Set<string>();
    set.add(b);
    neighborsByConcept.set(a, set);
  };
  for (const rel of relationRows) {
    addNeighbor(rel.fromConceptId, rel.toConceptId);
    addNeighbor(rel.toConceptId, rel.fromConceptId);
  }

  // Pass 1: base profiles (article + source only) for ALL concepts — the
  // one-hop neighbor input. Keeping this pass separate avoids recursion.
  const articleSignals = new Map<string, BeatDistribution>();
  const sourceSignals = new Map<string, BeatDistribution>();
  const baseProfiles = new Map<string, BeatDistribution>();
  for (const id of liveConceptIds) {
    const a = buildArticleSignal(mentionsByConcept.get(id) ?? [], validBeats);
    const s = buildSourceSignal(edgesByConcept.get(id) ?? [], validBeats);
    articleSignals.set(id, a);
    sourceSignals.set(id, s);
    baseProfiles.set(id, buildBaseProfile(a, s));
  }

  // Pass 2: final rows per concept, written in per-concept transactions.
  const summary: ConceptBeatAffinitySummary = {
    concepts: liveConceptIds.size,
    conceptsWithProfile: 0,
    rowsWritten: 0,
    bridgeConcepts: 0,
  };
  const now = new Date();
  for (const id of liveConceptIds) {
    const neighborProfiles = Array.from(neighborsByConcept.get(id) ?? [])
      .map((n) => baseProfiles.get(n) ?? {})
      .filter((p) => Object.keys(p).length > 0);
    const relationshipSignal = buildRelationshipSignal(neighborProfiles);
    const rows: ConceptBeatAffinityRow[] = computeAffinityRows(
      articleSignals.get(id) ?? {},
      sourceSignals.get(id) ?? {},
      relationshipSignal,
    );

    await db.transaction(async (tx) => {
      await tx
        .delete(conceptBeatAffinitiesTable)
        .where(eq(conceptBeatAffinitiesTable.conceptId, id));
      if (rows.length > 0) {
        await tx.insert(conceptBeatAffinitiesTable).values(
          rows.map((r) => ({
            conceptId: id,
            beatSlug: r.beatSlug,
            weight: r.weight,
            articleSignal: r.articleSignal,
            sourceSignal: r.sourceSignal,
            relationshipSignal: r.relationshipSignal,
            updatedAt: now,
          })),
        );
      }
    });

    if (rows.length > 0) summary.conceptsWithProfile += 1;
    summary.rowsWritten += rows.length;
    if (isBridgeProfile(rows)) summary.bridgeConcepts += 1;
  }

  // Remove any leftover rows for concepts that went hidden / were deleted
  // between recomputes (delete cascades cover deletion; hidden does not).
  const staleDeleted = await db
    .delete(conceptBeatAffinitiesTable)
    .where(
      liveConceptIds.size > 0
        ? notInArray(conceptBeatAffinitiesTable.conceptId, Array.from(liveConceptIds))
        : undefined,
    )
    .returning({ id: conceptBeatAffinitiesTable.id });
  if (staleDeleted.length > 0) {
    logger.info(
      { removed: staleDeleted.length },
      "conceptBeatAffinity: removed stale profiles for hidden/removed concepts",
    );
  }

  return summary;
}

/**
 * Start a recompute run (admin trigger + cron tick). Claims the in-process
 * slot synchronously; returns started=false when a run is already in flight.
 * The work itself runs in an unawaited promise — callers 202 immediately.
 */
export function startConceptBeatAffinityRecompute(): { started: boolean } {
  if (recomputeInFlight) return { started: false };
  recomputeInFlight = true;

  void (async () => {
    try {
      const summary = await recomputeAllConceptBeatAffinities();
      logger.info(summary, "conceptBeatAffinity: recompute complete");
    } catch (err) {
      logger.error({ err }, "conceptBeatAffinity: recompute failed");
    } finally {
      recomputeInFlight = false;
    }
  })();

  return { started: true };
}

export interface ConceptBeatAffinityStatus {
  running: boolean;
  lastComputedAt: string | null;
  conceptsWithProfile: number;
  bridgeConcepts: number;
}

/** Status snapshot for the admin poller (aggregates read from the DB). */
export async function getConceptBeatAffinityStatus(): Promise<ConceptBeatAffinityStatus> {
  const [agg, bridges] = await Promise.all([
    db
      .select({
        concepts: sql<string>`count(distinct ${conceptBeatAffinitiesTable.conceptId})`,
        last: sql<string | null>`max(${conceptBeatAffinitiesTable.updatedAt})`,
      })
      .from(conceptBeatAffinitiesTable),
    countBridgeConcepts(),
  ]);
  const row = agg[0];
  // Raw sql aggregates come back as strings at runtime — coerce explicitly.
  return {
    running: recomputeInFlight,
    lastComputedAt: row?.last ? new Date(row.last).toISOString() : null,
    conceptsWithProfile: Number(row?.concepts ?? 0),
    bridgeConcepts: bridges,
  };
}

async function countBridgeConcepts(): Promise<number> {
  const rows = await db
    .select({ conceptId: conceptBeatAffinitiesTable.conceptId })
    .from(conceptBeatAffinitiesTable)
    .where(gte(conceptBeatAffinitiesTable.weight, BRIDGE_WEIGHT_THRESHOLD))
    .groupBy(conceptBeatAffinitiesTable.conceptId)
    .having(sql`count(*) >= ${BRIDGE_MIN_BEATS}`);
  return rows.length;
}

export interface BridgeConceptEntry {
  conceptId: string;
  term: string;
  slug: string;
  status: string;
  /** Qualifying beats (weight >= threshold), strongest first. */
  beats: Array<{ beatSlug: string; weight: number }>;
}

/**
 * Bridge concepts — concepts with meaningful weight in two or more beats —
 * with their qualifying beats, strongest bridge first (by second-highest
 * qualifying weight, then term). Read API for the cross-beat radar.
 */
export async function listBridgeConcepts(): Promise<BridgeConceptEntry[]> {
  const rows = await db
    .select({
      conceptId: conceptBeatAffinitiesTable.conceptId,
      beatSlug: conceptBeatAffinitiesTable.beatSlug,
      weight: conceptBeatAffinitiesTable.weight,
      term: conceptsTable.term,
      slug: conceptsTable.slug,
      status: conceptsTable.status,
    })
    .from(conceptBeatAffinitiesTable)
    .innerJoin(conceptsTable, eq(conceptBeatAffinitiesTable.conceptId, conceptsTable.id))
    .where(
      and(
        gte(conceptBeatAffinitiesTable.weight, BRIDGE_WEIGHT_THRESHOLD),
        ne(conceptsTable.status, "hidden"),
      ),
    );

  const byConcept = new Map<string, BridgeConceptEntry>();
  for (const row of rows) {
    const entry = byConcept.get(row.conceptId) ?? {
      conceptId: row.conceptId,
      term: row.term,
      slug: row.slug,
      status: row.status,
      beats: [],
    };
    entry.beats.push({ beatSlug: row.beatSlug, weight: row.weight });
    byConcept.set(row.conceptId, entry);
  }

  return Array.from(byConcept.values())
    .filter((e) => e.beats.length >= BRIDGE_MIN_BEATS)
    .map((e) => ({
      ...e,
      beats: e.beats.sort((a, b) => b.weight - a.weight || a.beatSlug.localeCompare(b.beatSlug)),
    }))
    .sort(
      (a, b) =>
        (b.beats[1]?.weight ?? 0) - (a.beats[1]?.weight ?? 0) || a.term.localeCompare(b.term),
    );
}

export interface ConceptBeatProfile {
  isBridge: boolean;
  rows: Array<{
    beatSlug: string;
    beatName: string | null;
    weight: number;
    articleSignal: number;
    sourceSignal: number;
    relationshipSignal: number;
    updatedAt: string | null;
  }>;
}

/** One concept's full beat profile, strongest first, with beat display names. */
export async function getConceptBeatProfile(conceptId: string): Promise<ConceptBeatProfile> {
  const rows = await db
    .select({
      beatSlug: conceptBeatAffinitiesTable.beatSlug,
      weight: conceptBeatAffinitiesTable.weight,
      articleSignal: conceptBeatAffinitiesTable.articleSignal,
      sourceSignal: conceptBeatAffinitiesTable.sourceSignal,
      relationshipSignal: conceptBeatAffinitiesTable.relationshipSignal,
      updatedAt: conceptBeatAffinitiesTable.updatedAt,
      beatName: beatsTable.name,
    })
    .from(conceptBeatAffinitiesTable)
    .leftJoin(beatsTable, eq(conceptBeatAffinitiesTable.beatSlug, beatsTable.slug))
    .where(eq(conceptBeatAffinitiesTable.conceptId, conceptId));

  const sorted = rows
    .map((r) => ({
      beatSlug: r.beatSlug,
      beatName: r.beatName ?? null,
      weight: r.weight,
      articleSignal: r.articleSignal,
      sourceSignal: r.sourceSignal,
      relationshipSignal: r.relationshipSignal,
      updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
    }))
    .sort((a, b) => b.weight - a.weight || a.beatSlug.localeCompare(b.beatSlug));

  const qualifying = sorted.filter((r) => r.weight >= BRIDGE_WEIGHT_THRESHOLD).length;
  return { isBridge: qualifying >= BRIDGE_MIN_BEATS, rows: sorted };
}
