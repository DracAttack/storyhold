// --- Concept Evidence Health — PURE derivation (Task #340) -------------------
// Deterministic health metrics + alert derivation for glossary concepts. The
// daily health pass (conceptEvidenceHealthJob.ts) aggregates the raw inputs
// from the DB; this module only encodes the rules so they can be tested with
// per-file esbuild bundles. Pure and logger-free.
//
// Alert types:
//   weak_support         — the concept is used by published articles (or has
//                          reader demand) but its evidence base is thin:
//                          fewer than WEAK_SUPPORT_MIN_TRUSTED active trusted
//                          docs. Action: bounded source harvest.
//   coverage_opportunity — the concept has a strong, fresh evidence base but
//                          little published coverage. Action: promote to idea.
//   stale_conflict       — a linked source was RETRACTED (true retraction
//                          only; dedupe "superseded" rep-swaps are benign and
//                          excluded). Action: editor review of the concept +
//                          its linked articles.

export const CONCEPT_HEALTH_TRUSTED_TIERS = [
  "primary",
  "firsthand",
  "wire",
  "reported",
] as const;

/** weak_support: mention/demand floor that makes thin evidence a problem. */
export const WEAK_SUPPORT_MIN_MENTIONS = 2;
export const WEAK_SUPPORT_MIN_DEMAND_VIEWS = 50;
/** weak_support: fires when active trusted docs are BELOW this. */
export const WEAK_SUPPORT_MIN_TRUSTED = 2;

/** coverage_opportunity: evidence floor that makes low coverage a missed story. */
export const COVERAGE_MIN_TRUSTED = 3;
export const COVERAGE_MIN_FAMILIES = 2;
/** coverage_opportunity: fires when published mentions are AT/BELOW this. */
export const COVERAGE_MAX_MENTIONS = 1;
/** coverage_opportunity: newest evidence must be within this window. */
export const COVERAGE_FRESHNESS_DAYS = 90;

export interface ConceptHealthMetrics {
  conceptId: string;
  term: string;
  slug: string;
  activeTrustedCount: number;
  independentFamilyCount: number;
  newestEvidenceAt: Date | null;
  retractedLinkedCount: number;
  /**
   * Doc ids of the retracted linked sources — the incident fingerprint for
   * stale_conflict. A dismissed alert reopens when a doc id appears that was
   * not in the dismissal-time set (count alone misses same-count swaps).
   */
  retractedDocIds: string[];
  articleMentionCount: number;
  demandViews30d: number;
}

export type HealthAlertKind = "weak_support" | "coverage_opportunity" | "stale_conflict";

export interface DerivedHealthAlert {
  conceptId: string;
  alertType: HealthAlertKind;
  dedupeKey: string;
}

/**
 * One row per condition per concept. Dismissals settle the CURRENT incident
 * only — the job reopens a dismissed row when the condition materially
 * escalates past the dismissal-time snapshot (new retraction, further
 * support loss, fresh evidence).
 */
export function healthAlertDedupeKey(alertType: HealthAlertKind, conceptId: string): string {
  return `${alertType}:${conceptId}`;
}

export function isWeakSupport(m: ConceptHealthMetrics): boolean {
  const inDemand =
    m.articleMentionCount >= WEAK_SUPPORT_MIN_MENTIONS ||
    m.demandViews30d >= WEAK_SUPPORT_MIN_DEMAND_VIEWS;
  return inDemand && m.activeTrustedCount < WEAK_SUPPORT_MIN_TRUSTED;
}

export function isCoverageOpportunity(m: ConceptHealthMetrics, now: Date = new Date()): boolean {
  if (m.articleMentionCount > COVERAGE_MAX_MENTIONS) return false;
  if (m.activeTrustedCount < COVERAGE_MIN_TRUSTED) return false;
  if (m.independentFamilyCount < COVERAGE_MIN_FAMILIES) return false;
  if (!m.newestEvidenceAt) return false;
  const cutoff = now.getTime() - COVERAGE_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
  return m.newestEvidenceAt.getTime() >= cutoff;
}

export function isStaleConflict(m: ConceptHealthMetrics): boolean {
  return m.retractedLinkedCount > 0;
}

/**
 * Derive the alert set a concept's metrics justify RIGHT NOW. The job diffs
 * this against existing rows: new keys insert (ON CONFLICT DO NOTHING so
 * dismissed keys stay dismissed), open alerts whose condition disappeared
 * resolve.
 */
export function deriveHealthAlerts(
  m: ConceptHealthMetrics,
  now: Date = new Date(),
): DerivedHealthAlert[] {
  const out: DerivedHealthAlert[] = [];
  if (isWeakSupport(m)) {
    out.push({
      conceptId: m.conceptId,
      alertType: "weak_support",
      dedupeKey: healthAlertDedupeKey("weak_support", m.conceptId),
    });
  }
  if (isCoverageOpportunity(m, now)) {
    out.push({
      conceptId: m.conceptId,
      alertType: "coverage_opportunity",
      dedupeKey: healthAlertDedupeKey("coverage_opportunity", m.conceptId),
    });
  }
  if (isStaleConflict(m)) {
    out.push({
      conceptId: m.conceptId,
      alertType: "stale_conflict",
      dedupeKey: healthAlertDedupeKey("stale_conflict", m.conceptId),
    });
  }
  return out;
}
