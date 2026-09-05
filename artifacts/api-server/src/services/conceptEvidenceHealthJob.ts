// --- Concept Evidence Health — DB glue + daily pass (Task #340) --------------
// Aggregates the deterministic inputs (source-concept edges, lifecycle
// statuses, article mentions, 30-day page views), runs the pure rules in
// conceptEvidenceHealth.ts, rewrites concept_evidence_health snapshots, and
// reconciles concept_health_alerts:
//   - new alert keys INSERT (ON CONFLICT DO NOTHING — promoted keys stay
//     promoted; dismissed keys reopen only when the incident escalates past
//     the dismissal-time snapshot)
//   - existing OPEN alerts get their detail refreshed
//   - open/resolved flip as the underlying condition appears/clears
// Triggered by the daily cron tick and on demand from the admin. No LLM cost.

import {
  db,
  conceptsTable,
  conceptEvidenceHealthTable,
  conceptHealthAlertsTable,
  sourceConceptEdgesTable,
  sourceDocumentsTable,
  articleConceptMentionsTable,
  articlesTable,
  pageViewsTable,
  type ConceptHealthAlert,
} from "@workspace/db";
import { and, eq, ne, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  deriveHealthAlerts,
  CONCEPT_HEALTH_TRUSTED_TIERS,
  type ConceptHealthMetrics,
  type HealthAlertKind,
} from "./conceptEvidenceHealth";
import { RADAR_MIN_EDGE_CONFIDENCE } from "./crossBeatRadar";

export interface ConceptHealthSummary {
  concepts: number;
  alertsOpened: number;
  alertsResolved: number;
  weakSupport: number;
  coverageOpportunity: number;
  staleConflict: number;
}

// In-process run claim (single-server assumption, mirrors the other
// fire-and-forget admin jobs). Claimed synchronously BEFORE the first await.
let healthPassInFlight = false;

export function isConceptHealthPassRunning(): boolean {
  return healthPassInFlight;
}

const DEMAND_WINDOW_DAYS = 30;

/** Best available doc timestamp for freshness: published > fetched > created. */
function docTimestamp(row: {
  publishedAt: Date | null;
  fetchedAt: Date | null;
  createdAt: Date;
}): Date {
  return row.publishedAt ?? row.fetchedAt ?? row.createdAt;
}

/**
 * Compute fresh health metrics for every non-hidden concept. Pure aggregation
 * — exported separately so the radar job can reuse the trusted-evidence load.
 */
export async function computeAllConceptHealthMetrics(
  now: Date = new Date(),
): Promise<ConceptHealthMetrics[]> {
  const [concepts, edgeDocRows, mentionRows, viewRows] = await Promise.all([
    db
      .select({ id: conceptsTable.id, term: conceptsTable.term, slug: conceptsTable.slug })
      .from(conceptsTable)
      .where(ne(conceptsTable.status, "hidden")),
    // Every concept-linked vault doc (edge confidence gated) with the fields
    // health needs: lifecycle, tier, family, timestamps. Duplicate-of docs are
    // excluded — the family representative carries the evidence.
    db
      .select({
        conceptId: sourceConceptEdgesTable.conceptId,
        docId: sourceDocumentsTable.id,
        lifecycleStatus: sourceDocumentsTable.lifecycleStatus,
        authorityTier: sourceDocumentsTable.authorityTier,
        sourceFamilyId: sourceDocumentsTable.sourceFamilyId,
        evidenceEligible: sourceDocumentsTable.evidenceEligible,
        publishedAt: sourceDocumentsTable.publishedAt,
        fetchedAt: sourceDocumentsTable.fetchedAt,
        createdAt: sourceDocumentsTable.createdAt,
      })
      .from(sourceConceptEdgesTable)
      .innerJoin(
        sourceDocumentsTable,
        eq(sourceConceptEdgesTable.sourceDocumentId, sourceDocumentsTable.id),
      )
      .where(gte(sourceConceptEdgesTable.confidence, RADAR_MIN_EDGE_CONFIDENCE)),
    // Published-article mentions (concept -> article slugs).
    db
      .select({
        conceptId: articleConceptMentionsTable.conceptId,
        articleSlug: articlesTable.slug,
      })
      .from(articleConceptMentionsTable)
      .innerJoin(articlesTable, eq(articleConceptMentionsTable.articleId, articlesTable.id))
      .where(
        and(
          eq(articlesTable.status, "published"),
          // Quarantined articles are hidden from readers; exclude them so
          // suppressed stories do not appear as live concept coverage.
          isNull(articlesTable.quarantinedAt),
        ),
      ),
    // 30-day view counts per article slug (demand proxy).
    db
      .select({
        articleSlug: pageViewsTable.articleSlug,
        views: sql<string>`count(*)`,
      })
      .from(pageViewsTable)
      .where(
        gte(
          pageViewsTable.createdAt,
          new Date(now.getTime() - DEMAND_WINDOW_DAYS * 24 * 60 * 60 * 1000),
        ),
      )
      .groupBy(pageViewsTable.articleSlug),
  ]);

  const trustedTiers: ReadonlySet<string> = new Set(CONCEPT_HEALTH_TRUSTED_TIERS);
  const viewsBySlug = new Map<string, number>();
  // Raw sql aggregates come back as strings at runtime — coerce explicitly.
  for (const row of viewRows) viewsBySlug.set(row.articleSlug, Number(row.views));

  const slugsByConcept = new Map<string, Set<string>>();
  for (const row of mentionRows) {
    const set = slugsByConcept.get(row.conceptId) ?? new Set<string>();
    set.add(row.articleSlug);
    slugsByConcept.set(row.conceptId, set);
  }

  interface Acc {
    trustedFamilies: Set<string>;
    trustedCount: number;
    newest: Date | null;
    retracted: number;
    retractedDocIds: string[];
  }
  const accByConcept = new Map<string, Acc>();
  for (const row of edgeDocRows) {
    const acc =
      accByConcept.get(row.conceptId) ??
      ({
        trustedFamilies: new Set<string>(),
        trustedCount: 0,
        newest: null,
        retracted: 0,
        retractedDocIds: [],
      } as Acc);
    // Only true retractions count against a concept. "superseded" is routine
    // dedupe hygiene (a better copy of the same document replaced the family
    // representative) — treating it as a retraction produced false
    // stale_conflict alerts on healthy concepts.
    if (row.lifecycleStatus === "retracted") {
      acc.retracted += 1;
      acc.retractedDocIds.push(row.docId);
    } else if (row.lifecycleStatus === "active") {
      // Freshness must come from the same population as trust: active,
      // evidence-eligible, trusted-tier docs. Letting any active doc (unknown
      // tier, reference stubs, ineligible pages) bump newestEvidenceAt made
      // concepts look freshly evidenced when the trusted base was years old.
      if (row.evidenceEligible && trustedTiers.has(row.authorityTier)) {
        const ts = docTimestamp(row);
        if (!acc.newest || ts > acc.newest) acc.newest = ts;
        acc.trustedCount += 1;
        acc.trustedFamilies.add(row.sourceFamilyId ?? row.docId);
      }
    }
    accByConcept.set(row.conceptId, acc);
  }

  return concepts.map((c) => {
    const acc = accByConcept.get(c.id);
    const slugs = slugsByConcept.get(c.id) ?? new Set<string>();
    let demand = 0;
    for (const slug of slugs) demand += viewsBySlug.get(slug) ?? 0;
    return {
      conceptId: c.id,
      term: c.term,
      slug: c.slug,
      activeTrustedCount: acc?.trustedCount ?? 0,
      independentFamilyCount: acc?.trustedFamilies.size ?? 0,
      newestEvidenceAt: acc?.newest ?? null,
      retractedLinkedCount: acc?.retracted ?? 0,
      retractedDocIds: acc ? [...acc.retractedDocIds].sort() : [],
      articleMentionCount: slugs.size,
      demandViews30d: demand,
    };
  });
}

/** Linked published articles for a concept — stale_conflict alert detail. */
async function linkedArticlesByConcept(
  conceptIds: string[],
): Promise<Map<string, Array<{ id: string; slug: string; title: string }>>> {
  const out = new Map<string, Array<{ id: string; slug: string; title: string }>>();
  if (conceptIds.length === 0) return out;
  const rows = await db
    .select({
      conceptId: articleConceptMentionsTable.conceptId,
      id: articlesTable.id,
      slug: articlesTable.slug,
      title: articlesTable.title,
    })
    .from(articleConceptMentionsTable)
    .innerJoin(articlesTable, eq(articleConceptMentionsTable.articleId, articlesTable.id))
    .where(
      and(
        inArray(articleConceptMentionsTable.conceptId, conceptIds),
        eq(articlesTable.status, "published"),
        // Quarantined articles are hidden from readers; exclude them so they
        // don't appear as live coverage in health snapshots.
        isNull(articlesTable.quarantinedAt),
      ),
    );
  for (const row of rows) {
    const list = out.get(row.conceptId) ?? [];
    if (list.length < 20) list.push({ id: row.id, slug: row.slug, title: row.title });
    out.set(row.conceptId, list);
  }
  return out;
}

function metricsDetail(m: ConceptHealthMetrics) {
  return {
    activeTrustedCount: m.activeTrustedCount,
    independentFamilyCount: m.independentFamilyCount,
    newestEvidenceAt: m.newestEvidenceAt ? m.newestEvidenceAt.toISOString() : null,
    retractedLinkedCount: m.retractedLinkedCount,
    retractedDocIds: m.retractedDocIds,
    articleMentionCount: m.articleMentionCount,
    demandViews30d: m.demandViews30d,
  };
}

/**
 * The daily health pass: recompute metrics, rewrite snapshots, reconcile
 * alerts. Idempotent — safe to re-run any time. Throws on unexpected DB
 * failure; callers wrap it (fire-and-forget with logging, or cron catch).
 */
export async function runConceptHealthPass(now: Date = new Date()): Promise<ConceptHealthSummary> {
  const metrics = await computeAllConceptHealthMetrics(now);
  const summary: ConceptHealthSummary = {
    concepts: metrics.length,
    alertsOpened: 0,
    alertsResolved: 0,
    weakSupport: 0,
    coverageOpportunity: 0,
    staleConflict: 0,
  };

  // 1. Rewrite metric snapshots (upsert per concept).
  for (const m of metrics) {
    await db
      .insert(conceptEvidenceHealthTable)
      .values({
        conceptId: m.conceptId,
        activeTrustedCount: m.activeTrustedCount,
        independentFamilyCount: m.independentFamilyCount,
        newestEvidenceAt: m.newestEvidenceAt,
        retractedLinkedCount: m.retractedLinkedCount,
        articleMentionCount: m.articleMentionCount,
        demandViews30d: m.demandViews30d,
        computedAt: now,
      })
      .onConflictDoUpdate({
        target: conceptEvidenceHealthTable.conceptId,
        set: {
          activeTrustedCount: m.activeTrustedCount,
          independentFamilyCount: m.independentFamilyCount,
          newestEvidenceAt: m.newestEvidenceAt,
          retractedLinkedCount: m.retractedLinkedCount,
          articleMentionCount: m.articleMentionCount,
          demandViews30d: m.demandViews30d,
          computedAt: now,
        },
      });
  }
  // Snapshots for concepts that went hidden/deleted since the last pass.
  const liveIds = metrics.map((m) => m.conceptId);
  if (liveIds.length > 0) {
    await db
      .delete(conceptEvidenceHealthTable)
      .where(notInArray(conceptEvidenceHealthTable.conceptId, liveIds));
  }

  // 2. Derive the justified alert set.
  const derivedByKey = new Map<string, { m: ConceptHealthMetrics; alertType: HealthAlertKind }>();
  for (const m of metrics) {
    for (const a of deriveHealthAlerts(m, now)) {
      derivedByKey.set(a.dedupeKey, { m, alertType: a.alertType });
      if (a.alertType === "weak_support") summary.weakSupport += 1;
      if (a.alertType === "coverage_opportunity") summary.coverageOpportunity += 1;
      if (a.alertType === "stale_conflict") summary.staleConflict += 1;
    }
  }

  const staleConflictConcepts = Array.from(derivedByKey.values())
    .filter((d) => d.alertType === "stale_conflict")
    .map((d) => d.m.conceptId);
  const linkedArticles = await linkedArticlesByConcept(staleConflictConcepts);

  // 3. Reconcile against existing rows.
  const existing = await db.select().from(conceptHealthAlertsTable);
  const existingByKey = new Map<string, ConceptHealthAlert>(existing.map((r) => [r.dedupeKey, r]));

  for (const [key, { m, alertType }] of derivedByKey) {
    const detail = {
      ...metricsDetail(m),
      ...(alertType === "stale_conflict"
        ? { linkedArticles: linkedArticles.get(m.conceptId) ?? [] }
        : {}),
    };
    const prior = existingByKey.get(key);
    if (!prior) {
      const inserted = await db
        .insert(conceptHealthAlertsTable)
        .values({
          conceptId: m.conceptId,
          conceptTerm: m.term,
          conceptSlug: m.slug,
          alertType,
          dedupeKey: key,
          status: "open",
          detail,
        })
        .onConflictDoNothing({ target: conceptHealthAlertsTable.dedupeKey })
        .returning({ id: conceptHealthAlertsTable.id });
      // Conflict = a concurrent pass inserted this key first — not opened by us.
      if (inserted.length > 0) summary.alertsOpened += 1;
    } else if (prior.status === "open") {
      // Refresh the snapshot on open alerts so the admin sees live numbers.
      await db
        .update(conceptHealthAlertsTable)
        .set({ detail, conceptTerm: m.term, conceptSlug: m.slug, updatedAt: now })
        .where(and(eq(conceptHealthAlertsTable.id, prior.id), eq(conceptHealthAlertsTable.status, "open")));
    } else if (prior.status === "resolved") {
      // The condition came back after resolving — reopen.
      await db
        .update(conceptHealthAlertsTable)
        .set({ status: "open", detail, conceptTerm: m.term, conceptSlug: m.slug, updatedAt: now })
        .where(
          and(eq(conceptHealthAlertsTable.id, prior.id), eq(conceptHealthAlertsTable.status, "resolved")),
        );
      summary.alertsOpened += 1;
    } else if (prior.status === "dismissed") {
      // A dismissal resolves THAT incident — it must not vaccinate the
      // concept forever. Reopen when the condition materially escalated
      // beyond the dismissal-time snapshot (detail is frozen at dismissal,
      // since snapshot refreshes only run while the alert is open):
      //  - stale_conflict: a retracted doc the editor never saw (id fingerprint)
      //  - weak_support: trusted support degraded further
      //  - coverage_opportunity: fresh evidence arrived since dismissal
      const d = prior.detail;
      let escalated: boolean;
      if (!d) {
        // No dismissal-time snapshot — we can't prove the current condition
        // is the same incident that was dismissed, so err toward reopening.
        escalated = true;
      } else if (alertType === "stale_conflict") {
        if (d.retractedDocIds) {
          // Incident fingerprint: a retracted doc the editor never saw.
          const seen = new Set(d.retractedDocIds);
          escalated = m.retractedDocIds.some((id) => !seen.has(id));
        } else if (d.retractedLinkedCount != null) {
          // Legacy snapshot (pre-fingerprint): count growth is the best signal.
          escalated = m.retractedLinkedCount > d.retractedLinkedCount;
        } else {
          escalated = true;
        }
      } else if (alertType === "weak_support") {
        // Missing prior count → Infinity → reopen (unknown snapshot).
        escalated = m.activeTrustedCount < (d.activeTrustedCount ?? Infinity);
      } else {
        const parsed = d.newestEvidenceAt ? Date.parse(d.newestEvidenceAt) : NaN;
        // Invalid/missing prior timestamp → 0 → any current evidence reopens.
        const priorNewest = Number.isFinite(parsed) ? parsed : 0;
        escalated = (m.newestEvidenceAt?.getTime() ?? 0) > priorNewest;
      }
      if (escalated) {
        await db
          .update(conceptHealthAlertsTable)
          .set({ status: "open", detail, conceptTerm: m.term, conceptSlug: m.slug, updatedAt: now })
          .where(
            and(eq(conceptHealthAlertsTable.id, prior.id), eq(conceptHealthAlertsTable.status, "dismissed")),
          );
        summary.alertsOpened += 1;
      }
    }
    // promoted: hands off — that human decision is remembered.
  }

  // 4. Auto-resolve open alerts whose condition cleared.
  for (const row of existing) {
    if (row.status !== "open") continue;
    if (derivedByKey.has(row.dedupeKey)) continue;
    await db
      .update(conceptHealthAlertsTable)
      .set({ status: "resolved", updatedAt: now })
      .where(and(eq(conceptHealthAlertsTable.id, row.id), eq(conceptHealthAlertsTable.status, "open")));
    summary.alertsResolved += 1;
  }

  return summary;
}

/**
 * Start a health pass (admin trigger + cron tick). Claims the in-process slot
 * synchronously; returns started=false when a run is already in flight. The
 * work runs in an unawaited promise — callers 202 immediately.
 */
export function startConceptHealthPass(): { started: boolean } {
  if (healthPassInFlight) return { started: false };
  healthPassInFlight = true;

  void (async () => {
    try {
      const summary = await runConceptHealthPass();
      logger.info(summary, "conceptHealth: daily pass complete");
    } catch (err) {
      logger.error({ err }, "conceptHealth: daily pass failed");
    } finally {
      healthPassInFlight = false;
    }
  })();

  return { started: true };
}
