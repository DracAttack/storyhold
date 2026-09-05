// --- Living Coverage Map — DB/Job layer (Task #345) --------------------------
//
// Daily recalculation pass: loads all live concepts, assembles the six
// pre-computed health metrics + five per-concept computed metrics, fingerprints
// the inputs, skips unchanged concepts, scores via coverageMapScore.ts, and
// upserts into coverage_map_items. Zero AI calls. Fire-and-forget via
// startCoverageMapPass() — same pattern as conceptEvidenceHealthJob.ts.

import {
  db,
  conceptsTable,
  conceptEvidenceHealthTable,
  conceptBeatAffinitiesTable,
  articleConceptMentionsTable,
  articlesTable,
  sourceConceptEdgesTable,
  sourceDocumentsTable,
  duplicateReviewsTable,
  crossBeatRadarSuggestionsTable,
  coverageMapItemsTable,
  topicIdeasTable,
  beatsTable,
  type EditorialState,
  type CoverageProvenance,
  type SourceAuthorityTier,
} from "@workspace/db";
import { and, eq, gte, inArray, sql, or, isNotNull, isNull, desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { BRIDGE_WEIGHT_THRESHOLD } from "./conceptBeatAffinity";
import { RADAR_MIN_EDGE_CONFIDENCE } from "./crossBeatRadar";
import { CONCEPT_HEALTH_TRUSTED_TIERS } from "./conceptEvidenceHealth";
import { pickRadarAuthor } from "./crossBeatRadarJob";
import {
  scoreConcept,
  inputFingerprint,
  type ConceptCoverageInputs,
} from "./coverageMapScore";

// ---------------------------------------------------------------------------
// In-process run flag (single-server assumption)
// ---------------------------------------------------------------------------

let coverageMapPassInFlight = false;

export function isCoverageMapPassRunning(): boolean {
  return coverageMapPassInFlight;
}

// ---------------------------------------------------------------------------
// Centrality thresholds
// ---------------------------------------------------------------------------

/** A concept mention is "central" when it appears early and with high confidence. */
const CENTRAL_PARAGRAPH_MAX = 2;
const CENTRAL_CONFIDENCE_MIN = 0.7;

// ---------------------------------------------------------------------------
// Types for bulk-assembled rows
// ---------------------------------------------------------------------------

interface ConceptHealthRow {
  id: string;
  term: string;
  slug: string;
  activeTrustedCount: number;
  independentFamilyCount: number;
  newestEvidenceAt: Date | null;
  retractedLinkedCount: number;
  articleMentionCount: number;
  demandViews30d: number;
}

interface CentralArticleRow {
  conceptId: string;
  centralCount: number;
  mostRecentAt: Date | null;
  oldestAt: Date | null;
  articleIds: string[];
}

interface NewFamiliesRow {
  families90d: number;
  families120d: number;
}

interface SourceProvenanceRow {
  docId: string;
  familyId: string | null;
}

interface ExistingItemRow {
  itemId: string;
  fingerprint: string;
  editorialState: string;
  editorialNote: string | null;
  ideaId: string | null;
}

// ---------------------------------------------------------------------------
// Bulk data loaders
// ---------------------------------------------------------------------------

async function loadConceptsWithHealth(): Promise<ConceptHealthRow[]> {
  const rows = await db
    .select({
      id: conceptsTable.id,
      term: conceptsTable.term,
      slug: conceptsTable.slug,
      activeTrustedCount: conceptEvidenceHealthTable.activeTrustedCount,
      independentFamilyCount: conceptEvidenceHealthTable.independentFamilyCount,
      newestEvidenceAt: conceptEvidenceHealthTable.newestEvidenceAt,
      retractedLinkedCount: conceptEvidenceHealthTable.retractedLinkedCount,
      articleMentionCount: conceptEvidenceHealthTable.articleMentionCount,
      demandViews30d: conceptEvidenceHealthTable.demandViews30d,
    })
    .from(conceptsTable)
    // LEFT JOIN: concepts without a health snapshot (health pass not yet run,
    // or newly created concepts) still get scored — evidence fields default
    // to 0 and they classify as insufficient_data rather than vanishing.
    .leftJoin(
      conceptEvidenceHealthTable,
      eq(conceptEvidenceHealthTable.conceptId, conceptsTable.id),
    )
    .where(eq(conceptsTable.status, "live"));

  return rows.map((r) => ({
    id: r.id,
    term: r.term,
    slug: r.slug,
    activeTrustedCount: r.activeTrustedCount ?? 0,
    independentFamilyCount: r.independentFamilyCount ?? 0,
    newestEvidenceAt: r.newestEvidenceAt ?? null,
    retractedLinkedCount: r.retractedLinkedCount ?? 0,
    articleMentionCount: r.articleMentionCount ?? 0,
    demandViews30d: r.demandViews30d ?? 0,
  }));
}

async function loadCentralArticles(
  conceptIds: string[],
): Promise<Map<string, CentralArticleRow>> {
  if (conceptIds.length === 0) return new Map();

  const rows = await db
    .select({
      conceptId: articleConceptMentionsTable.conceptId,
      articleId: articleConceptMentionsTable.articleId,
      publishedAt: articlesTable.publishedAt,
    })
    .from(articleConceptMentionsTable)
    .innerJoin(articlesTable, eq(articlesTable.id, articleConceptMentionsTable.articleId))
    .where(
      and(
        inArray(articleConceptMentionsTable.conceptId, conceptIds),
        sql`${articleConceptMentionsTable.paragraphIndex} <= ${CENTRAL_PARAGRAPH_MAX}`,
        sql`${articleConceptMentionsTable.confidence} >= ${CENTRAL_CONFIDENCE_MIN}`,
        eq(articlesTable.status, "published"),
        // Quarantined articles are hidden from readers; they must not count as
        // coverage or the map will suppress valid story opportunities.
        isNull(articlesTable.quarantinedAt),
      ),
    );

  const byConceptId = new Map<string, CentralArticleRow>();
  for (const row of rows) {
    const publishedAt = row.publishedAt ? new Date(row.publishedAt) : null;
    const existing = byConceptId.get(row.conceptId);
    if (!existing) {
      byConceptId.set(row.conceptId, {
        conceptId: row.conceptId,
        centralCount: 1,
        mostRecentAt: publishedAt,
        oldestAt: publishedAt,
        articleIds: [row.articleId],
      });
    } else {
      existing.centralCount += 1;
      existing.articleIds.push(row.articleId);
      if (publishedAt) {
        if (!existing.mostRecentAt || publishedAt > existing.mostRecentAt)
          existing.mostRecentAt = publishedAt;
        if (!existing.oldestAt || publishedAt < existing.oldestAt)
          existing.oldestAt = publishedAt;
      }
    }
  }
  return byConceptId;
}

async function loadNewSourceFamilies(
  conceptIds: string[],
  now: Date,
): Promise<Map<string, NewFamiliesRow>> {
  if (conceptIds.length === 0) return new Map();

  const ago90 = new Date(now.getTime() - 90 * 86_400_000);
  const ago120 = new Date(now.getTime() - 120 * 86_400_000);
  const trusted = [...CONCEPT_HEALTH_TRUSTED_TIERS] as SourceAuthorityTier[];

  const rows = await db
    .select({
      conceptId: sourceConceptEdgesTable.conceptId,
      familyId: sourceDocumentsTable.sourceFamilyId,
      docId: sourceDocumentsTable.id,
      // "New evidence" means newly PUBLISHED, not newly ingested. createdAt is
      // just discovery time — ingesting a five-year-old paper today must not
      // read as rising evidence. Fall back to createdAt only when the source
      // has no publication date.
      effectiveAt: sql<Date>`coalesce(${sourceDocumentsTable.publishedAt}, ${sourceDocumentsTable.createdAt})`,
    })
    .from(sourceConceptEdgesTable)
    .innerJoin(
      sourceDocumentsTable,
      eq(sourceDocumentsTable.id, sourceConceptEdgesTable.sourceDocumentId),
    )
    .where(
      and(
        inArray(sourceConceptEdgesTable.conceptId, conceptIds),
        eq(sourceDocumentsTable.evidenceEligible, true),
        eq(sourceDocumentsTable.lifecycleStatus, "active"),
        inArray(sourceDocumentsTable.authorityTier, trusted),
        isNotNull(sourceDocumentsTable.sourceFamilyId),
        sql`coalesce(${sourceDocumentsTable.publishedAt}, ${sourceDocumentsTable.createdAt}) >= ${ago120}`,
        sql`${sourceConceptEdgesTable.confidence} >= ${RADAR_MIN_EDGE_CONFIDENCE}`,
      ),
    );

  const tracker = new Map<
    string,
    { families90d: Set<string>; families120d: Set<string> }
  >();

  for (const row of rows) {
    const fk = row.familyId ?? row.docId;
    let entry = tracker.get(row.conceptId);
    if (!entry) {
      entry = { families90d: new Set(), families120d: new Set() };
      tracker.set(row.conceptId, entry);
    }
    entry.families120d.add(fk);
    // Raw sql<Date> is a compile-time cast only — pg returns a string.
    if (new Date(row.effectiveAt as unknown as string | Date) >= ago90) {
      entry.families90d.add(fk);
    }
  }

  const result = new Map<string, NewFamiliesRow>();
  for (const conceptId of conceptIds) {
    const entry = tracker.get(conceptId);
    result.set(conceptId, {
      families90d: entry?.families90d.size ?? 0,
      families120d: entry?.families120d.size ?? 0,
    });
  }
  return result;
}

async function loadSourceProvenance(
  conceptIds: string[],
): Promise<Map<string, SourceProvenanceRow[]>> {
  if (conceptIds.length === 0) return new Map();

  const trusted = [...CONCEPT_HEALTH_TRUSTED_TIERS] as SourceAuthorityTier[];

  const rows = await db
    .select({
      conceptId: sourceConceptEdgesTable.conceptId,
      docId: sourceDocumentsTable.id,
      familyId: sourceDocumentsTable.sourceFamilyId,
    })
    .from(sourceConceptEdgesTable)
    .innerJoin(
      sourceDocumentsTable,
      eq(sourceDocumentsTable.id, sourceConceptEdgesTable.sourceDocumentId),
    )
    .where(
      and(
        inArray(sourceConceptEdgesTable.conceptId, conceptIds),
        eq(sourceDocumentsTable.evidenceEligible, true),
        eq(sourceDocumentsTable.lifecycleStatus, "active"),
        inArray(sourceDocumentsTable.authorityTier, trusted),
        sql`${sourceConceptEdgesTable.confidence} >= ${RADAR_MIN_EDGE_CONFIDENCE}`,
      ),
    );

  const byConceptId = new Map<string, SourceProvenanceRow[]>();
  for (const row of rows) {
    const list = byConceptId.get(row.conceptId) ?? [];
    list.push({ docId: row.docId, familyId: row.familyId });
    byConceptId.set(row.conceptId, list);
  }
  return byConceptId;
}

async function loadBeatAffinities(
  conceptIds: string[],
): Promise<Map<string, Array<{ beatSlug: string; weight: number }>>> {
  if (conceptIds.length === 0) return new Map();

  const rows = await db
    .select({
      conceptId: conceptBeatAffinitiesTable.conceptId,
      beatSlug: conceptBeatAffinitiesTable.beatSlug,
      weight: conceptBeatAffinitiesTable.weight,
    })
    .from(conceptBeatAffinitiesTable)
    .where(inArray(conceptBeatAffinitiesTable.conceptId, conceptIds))
    .orderBy(desc(conceptBeatAffinitiesTable.weight));

  const byConceptId = new Map<string, Array<{ beatSlug: string; weight: number }>>();
  for (const row of rows) {
    const list = byConceptId.get(row.conceptId) ?? [];
    list.push({ beatSlug: row.beatSlug, weight: row.weight });
    byConceptId.set(row.conceptId, list);
  }
  return byConceptId;
}

async function loadSimilarArticleCounts(
  centralArticlesByConceptId: Map<string, CentralArticleRow>,
): Promise<Map<string, number>> {
  const allArticleIds: string[] = [];
  for (const row of centralArticlesByConceptId.values()) {
    allArticleIds.push(...row.articleIds);
  }
  if (allArticleIds.length === 0) return new Map();

  const pairs = await db
    .select({
      newerArticleId: duplicateReviewsTable.newerArticleId,
      olderArticleId: duplicateReviewsTable.olderArticleId,
    })
    .from(duplicateReviewsTable)
    .where(
      or(
        inArray(duplicateReviewsTable.newerArticleId, allArticleIds),
        inArray(duplicateReviewsTable.olderArticleId, allArticleIds),
      ),
    );

  // Build article → set of similar-article partners
  const similarSets = new Map<string, Set<string>>();
  const addPair = (a: string, b: string) => {
    const sa = similarSets.get(a) ?? new Set<string>();
    sa.add(b);
    similarSets.set(a, sa);
    const sb = similarSets.get(b) ?? new Set<string>();
    sb.add(a);
    similarSets.set(b, sb);
  };
  for (const p of pairs) addPair(p.newerArticleId, p.olderArticleId);

  const result = new Map<string, number>();
  for (const [conceptId, row] of centralArticlesByConceptId) {
    const centralSet = new Set(row.articleIds);
    let count = 0;
    for (const articleId of row.articleIds) {
      const simSet = similarSets.get(articleId);
      if (simSet && [...simSet].some((s) => centralSet.has(s))) count++;
    }
    result.set(conceptId, count);
  }
  return result;
}

async function loadRadarSuggestions(
  conceptIds: string[],
): Promise<Map<string, { suggestionId: string; status: string }>> {
  if (conceptIds.length === 0) return new Map();

  const rows = await db
    .select({
      conceptId: crossBeatRadarSuggestionsTable.conceptId,
      suggestionId: crossBeatRadarSuggestionsTable.id,
      status: crossBeatRadarSuggestionsTable.status,
    })
    .from(crossBeatRadarSuggestionsTable)
    .where(inArray(crossBeatRadarSuggestionsTable.conceptId, conceptIds))
    .orderBy(desc(crossBeatRadarSuggestionsTable.createdAt));

  const byConceptId = new Map<string, { suggestionId: string; status: string }>();
  for (const row of rows) {
    if (!byConceptId.has(row.conceptId)) {
      byConceptId.set(row.conceptId, { suggestionId: row.suggestionId, status: row.status });
    }
  }
  return byConceptId;
}

async function loadExistingItems(
  conceptIds: string[],
): Promise<Map<string, ExistingItemRow>> {
  if (conceptIds.length === 0) return new Map();
  const rows = await db
    .select({
      conceptId: coverageMapItemsTable.conceptId,
      itemId: coverageMapItemsTable.id,
      fingerprint: coverageMapItemsTable.inputFingerprint,
      editorialState: coverageMapItemsTable.editorialState,
      editorialNote: coverageMapItemsTable.editorialNote,
      ideaId: coverageMapItemsTable.ideaId,
    })
    .from(coverageMapItemsTable)
    .where(inArray(coverageMapItemsTable.conceptId, conceptIds));

  const m = new Map<string, ExistingItemRow>();
  for (const row of rows) {
    m.set(row.conceptId, {
      itemId: row.itemId,
      fingerprint: row.fingerprint,
      editorialState: row.editorialState,
      editorialNote: row.editorialNote,
      ideaId: row.ideaId,
    });
  }
  return m;
}

// ---------------------------------------------------------------------------
// Main pass
// ---------------------------------------------------------------------------

export interface CoverageMapPassSummary {
  total: number;
  scored: number;
  skipped: number;
  errors: number;
}

export async function runCoverageMapPass(
  now: Date = new Date(),
): Promise<CoverageMapPassSummary> {
  const summary: CoverageMapPassSummary = { total: 0, scored: 0, skipped: 0, errors: 0 };

  // Prune rows whose concept is no longer live (hidden/retired concepts must
  // leave rankings, recommendations, and counts). Runs before the early
  // return so a fully-hidden catalog still cleans up. NOT IN subquery — the
  // delete sees every candidate in one statement, no pagination window.
  await db.execute(sql`
    DELETE FROM coverage_map_items
    WHERE concept_id NOT IN (SELECT id FROM concepts WHERE status = 'live')
  `);

  const concepts = await loadConceptsWithHealth();
  summary.total = concepts.length;
  if (concepts.length === 0) return summary;

  const conceptIds = concepts.map((c) => c.id);

  const [centralArticles, newFamilies, sourceProvenance, beatAffinities, radarSuggestions, existingItems] =
    await Promise.all([
      loadCentralArticles(conceptIds),
      loadNewSourceFamilies(conceptIds, now),
      loadSourceProvenance(conceptIds),
      loadBeatAffinities(conceptIds),
      loadRadarSuggestions(conceptIds),
      loadExistingItems(conceptIds),
    ]);

  const similarCounts = await loadSimilarArticleCounts(centralArticles);

  for (const concept of concepts) {
    try {
      const central = centralArticles.get(concept.id);
      const families = newFamilies.get(concept.id);
      const provDocs = sourceProvenance.get(concept.id) ?? [];
      const beats = beatAffinities.get(concept.id) ?? [];
      const radar = radarSuggestions.get(concept.id);
      const existing = existingItems.get(concept.id);
      const similarCount = similarCounts.get(concept.id) ?? 0;

      const sortedBeats = [...beats].sort((a, b) => b.weight - a.weight);
      const primaryBeatSlug = sortedBeats[0]?.beatSlug ?? null;
      const secondaryBeatSlugs = sortedBeats
        .slice(1, 3)
        .filter((b) => b.weight >= BRIDGE_WEIGHT_THRESHOLD)
        .map((b) => b.beatSlug);

      // Deduplicate source families for provenance
      const seenFamilies = new Set<string>();
      const sourceDocumentIds: string[] = [];
      const sourceFamilyIds: string[] = [];
      for (const p of provDocs) {
        sourceDocumentIds.push(p.docId);
        const fk = p.familyId ?? p.docId;
        if (!seenFamilies.has(fk)) { seenFamilies.add(fk); sourceFamilyIds.push(fk); }
      }

      const inputs: ConceptCoverageInputs = {
        conceptId: concept.id,
        term: concept.term,
        slug: concept.slug,
        primaryBeatSlug,
        secondaryBeatSlugs,
        activeTrustedCount: concept.activeTrustedCount,
        independentFamilyCount: concept.independentFamilyCount,
        newestEvidenceAt: concept.newestEvidenceAt,
        retractedLinkedCount: concept.retractedLinkedCount,
        articleMentionCount: concept.articleMentionCount,
        demandViews30d: concept.demandViews30d,
        centralArticleCount: central?.centralCount ?? 0,
        mostRecentCentralArticleAt: central?.mostRecentAt ?? null,
        oldestCentralArticleAt: central?.oldestAt ?? null,
        newFamiliesLast90d: families?.families90d ?? 0,
        newFamiliesLast120d: families?.families120d ?? 0,
        similarCentralArticleCount: similarCount,
        sourceDocumentIds,
        sourceFamilyIds,
        centralArticleIds: central?.articleIds ?? [],
        radarSuggestionId: radar?.suggestionId ?? null,
        radarSuggestionStatus: radar?.status ?? null,
      };

      const editorialState = (existing?.editorialState ?? "none") as EditorialState;
      const fp = inputFingerprint(inputs, editorialState);
      if (existing && existing.fingerprint === fp) {
        summary.skipped++;
        continue;
      }

      const result = scoreConcept(inputs, editorialState, now);

      const provenance: CoverageProvenance = {
        sourceDocumentIds,
        sourceFamilyIds,
        centralArticleIds: central?.articleIds ?? [],
        primaryBeatSlug,
        secondaryBeatSlugs,
        coverageMapItemId: null,
        radarSuggestionId: radar?.suggestionId ?? null,
        radarSuggestionStatus: radar?.status ?? null,
      };

      await db
        .insert(coverageMapItemsTable)
        .values({
          conceptId: concept.id,
          classification: result.classification,
          evidenceStrength: result.scores.evidenceStrength,
          sourceDiversity: result.scores.sourceDiversity,
          evidenceFreshness: result.scores.evidenceFreshness,
          coverageDepth: result.scores.coverageDepth,
          articleUniqueness: result.scores.articleUniqueness,
          readerInterest: result.scores.readerInterest,
          updateUrgency: result.scores.updateUrgency,
          saturation: result.scores.saturation,
          opportunityScore: result.scores.opportunityScore,
          recommendedAction: result.recommendedAction,
          scoreBreakdown: result.breakdown,
          provenanceJson: provenance,
          inputFingerprint: fp,
          editorialState,
          editorialNote: existing?.editorialNote ?? null,
          ideaId: existing?.ideaId ?? null,
          radarSuggestionId: radar?.suggestionId ?? null,
          calculatedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: coverageMapItemsTable.conceptId,
          set: {
            classification: result.classification,
            evidenceStrength: result.scores.evidenceStrength,
            sourceDiversity: result.scores.sourceDiversity,
            evidenceFreshness: result.scores.evidenceFreshness,
            coverageDepth: result.scores.coverageDepth,
            articleUniqueness: result.scores.articleUniqueness,
            readerInterest: result.scores.readerInterest,
            updateUrgency: result.scores.updateUrgency,
            saturation: result.scores.saturation,
            opportunityScore: result.scores.opportunityScore,
            recommendedAction: result.recommendedAction,
            scoreBreakdown: result.breakdown,
            provenanceJson: provenance,
            inputFingerprint: fp,
            radarSuggestionId: radar?.suggestionId ?? null,
            calculatedAt: now,
            updatedAt: now,
            // Editorial state, note, ideaId preserved — not overwritten on recalc.
          },
        });

      summary.scored++;
    } catch (err) {
      logger.error({ err, conceptId: concept.id }, "coverage map: score/upsert failed");
      summary.errors++;
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Fire-and-forget wrapper
// ---------------------------------------------------------------------------

export function startCoverageMapPass(): { started: boolean } {
  if (coverageMapPassInFlight) return { started: false };
  coverageMapPassInFlight = true;
  void runCoverageMapPass()
    .then((s) => {
      if (s.scored > 0 || s.errors > 0)
        logger.info(s, "coverage map pass complete");
    })
    .catch((err) => logger.error({ err }, "coverage map pass failed"))
    .finally(() => { coverageMapPassInFlight = false; });
  return { started: true };
}

// ---------------------------------------------------------------------------
// Promote-to-idea from a coverage map item
// ---------------------------------------------------------------------------

export interface PromotedIdea {
  ideaId: string;
  title: string;
}

export async function promoteCoverageMapItemToIdea(itemId: string): Promise<PromotedIdea> {
  const [item] = await db
    .select()
    .from(coverageMapItemsTable)
    .where(eq(coverageMapItemsTable.id, itemId))
    .limit(1);

  if (!item) throw new Error(`Coverage map item ${itemId} not found`);
  if (item.ideaId) {
    throw new Error(
      `Coverage map item ${itemId} already promoted to idea ${item.ideaId}`,
    );
  }

  const provenance = item.provenanceJson;
  const beatSlug = provenance?.primaryBeatSlug;
  if (!beatSlug) throw new Error("Cannot promote: no primary beat associated with this concept");

  const [concept] = await db
    .select({ term: conceptsTable.term, slug: conceptsTable.slug })
    .from(conceptsTable)
    .where(eq(conceptsTable.id, item.conceptId))
    .limit(1);
  if (!concept) throw new Error("Coverage map concept not found");

  const [beat] = await db
    .select({ name: beatsTable.name })
    .from(beatsTable)
    .where(eq(beatsTable.slug, beatSlug))
    .limit(1);

  const titleMap: Record<string, string> = {
    strong_evidence_missing_coverage: `${concept.term}: the story readers haven't been told`,
    heavy_coverage_weak_evidence: `${concept.term}: what we know and what we're still missing`,
    rising_evidence_stale_coverage: `${concept.term}: what's changed since we last covered it`,
    saturated_territory: `${concept.term}: a fresh angle on a well-covered topic`,
    insufficient_data: `${concept.term}: an open question worth investigating`,
  };

  const angleMap: Record<string, string> = {
    strong_evidence_missing_coverage: `Strong, well-sourced evidence has accumulated around "${concept.term}" but almost nothing has been published. Build the foundational piece the evidence base supports.`,
    heavy_coverage_weak_evidence: `"${concept.term}" has been written about frequently but coverage outpaces the evidence. Find and cite the strongest independent sources, or reframe with appropriate epistemic humility.`,
    rising_evidence_stale_coverage: `New independent sources on "${concept.term}" have emerged since the last article on this topic. Write a fresh take that reflects the updated evidence base.`,
    saturated_territory: `The "${concept.term}" space is well-covered. If writing on this, find a distinctive angle, a cross-beat synthesis, or a gap the existing articles miss.`,
    insufficient_data: `"${concept.term}" appears in reader searches but lacks strong sourcing. Investigate whether the evidence exists to support a thorough article.`,
  };

  const notes = [
    `From Coverage Map: classification "${item.classification}" on "${concept.term}".`,
    `Scores: evidence ${(item.evidenceStrength * 100).toFixed(0)}%, diversity ${(item.sourceDiversity * 100).toFixed(0)}%, opportunity ${(item.opportunityScore * 100).toFixed(0)}%.`,
    provenance?.sourceDocumentIds?.length
      ? `${provenance.sourceDocumentIds.length} trusted vault sources, ${provenance.sourceFamilyIds?.length ?? 0} independent families.`
      : "",
    provenance?.centralArticleIds?.length
      ? `${provenance.centralArticleIds.length} existing central articles.`
      : "No existing central articles.",
    item.recommendedAction !== "monitor_only"
      ? `Recommended action: ${item.recommendedAction.replace(/_/g, " ")}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  const ideaTitle = titleMap[item.classification] ?? titleMap["insufficient_data"]!;
  const angle = angleMap[item.classification] ?? angleMap["insufficient_data"]!;

  const author = await pickRadarAuthor(beatSlug);
  if (!author) throw new Error("Cannot promote: no author covers this beat");

  return await db.transaction(async (tx) => {
    const [idea] = await tx
      .insert(topicIdeasTable)
      .values({
        authorId: author.id,
        title: ideaTitle,
        angle,
        category: beat?.name ?? beatSlug,
        categorySlug: beatSlug,
        secondaryBeats:
          provenance?.secondaryBeatSlugs?.length ? provenance.secondaryBeatSlugs : null,
        status: "pending",
        notes,
        // Structured lineage: the notes above only carry counts ("8 trusted
        // sources") — this snapshot preserves WHICH sources/families/articles
        // justified the promotion so the audit chain survives drafting.
        coverageMapItemId: itemId,
        coverageProvenanceJson: {
          conceptId: item.conceptId,
          classification: item.classification,
          recommendedAction: item.recommendedAction,
          scores: {
            evidenceStrength: item.evidenceStrength,
            sourceDiversity: item.sourceDiversity,
            opportunityScore: item.opportunityScore,
          },
          sourceDocumentIds: provenance?.sourceDocumentIds ?? [],
          sourceFamilyIds: provenance?.sourceFamilyIds ?? [],
          centralArticleIds: provenance?.centralArticleIds ?? [],
          radarSuggestionId: provenance?.radarSuggestionId ?? null,
          promotedAtIso: new Date().toISOString(),
        },
      })
      .returning({ id: topicIdeasTable.id });
    if (!idea) throw new Error("Failed to create idea");

    // Atomic claim: only link the idea if the row is still unpromoted. A
    // concurrent promote that won the race leaves 0 rows updated — throwing
    // here rolls back the idea insert, so no duplicate/orphan idea survives.
    const claimed = await tx
      .update(coverageMapItemsTable)
      .set({ ideaId: idea.id, updatedAt: new Date() })
      .where(and(eq(coverageMapItemsTable.id, itemId), isNull(coverageMapItemsTable.ideaId)))
      .returning({ id: coverageMapItemsTable.id });
    if (claimed.length === 0) {
      throw new Error(`Coverage map item ${itemId} already promoted concurrently`);
    }

    return { ideaId: idea.id, title: ideaTitle };
  });
}
