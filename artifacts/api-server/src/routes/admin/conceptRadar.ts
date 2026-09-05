/**
 * Admin — Cross-Beat Radar & Concept Evidence Health routes (Task #340)
 *
 * Matches the existing BrainHook admin-route pattern: fire-and-forget POST for
 * async jobs (202 immediately, 409 when busy) + GET for status/list. All
 * routes require requireAdmin + requireTrustedOrigin (applied at the router
 * level in routes/index.ts, same as every other /admin route).
 */

import { Router, type IRouter } from "express";
import { eq, desc, sql, and } from "drizzle-orm";
import {
  db,
  crossBeatRadarSuggestionsTable,
  conceptEvidenceHealthTable,
  conceptHealthAlertsTable,
  conceptsTable,
  topicIdeasTable,
  RADAR_SUGGESTION_STATUSES,
  CONCEPT_HEALTH_ALERT_STATUSES,
  CONCEPT_HEALTH_ALERT_TYPES,
  type RadarSuggestionStatus,
  type ConceptHealthAlertStatus,
  type ConceptHealthAlertType,
} from "@workspace/db";
import {
  startCrossBeatRadarRun,
  isCrossBeatRadarRunning,
  pickRadarAuthor,
} from "../../services/crossBeatRadarJob";
import {
  startConceptHealthPass,
  isConceptHealthPassRunning,
} from "../../services/conceptEvidenceHealthJob";
import { getConceptBeatProfile } from "../../services/conceptBeatAffinityJob";
import { searchWithFallback } from "../../services/researchFallback";
import { enqueueUrl } from "../../services/sourceIngestQueue";
import { VaultBudgetGuard, VaultBudgetExceededError } from "../../services/sourceVaultBudget";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Cross-Beat Radar — run trigger + status + suggestion list/dismiss
// ---------------------------------------------------------------------------

// POST /admin/concept-radar/run
// Fire-and-forget radar run (same start function the cron tick uses).
router.post("/concept-radar/run", (_req, res) => {
  const { started } = startCrossBeatRadarRun();
  if (!started) {
    res.status(409).json({ error: "Cross-beat radar run already in progress" });
    return;
  }
  res.status(202).json({ started: true });
});

// GET /admin/concept-radar/status
router.get("/concept-radar/status", async (_req, res) => {
  const rows = await db
    .select({
      status: crossBeatRadarSuggestionsTable.status,
      count: sql<number>`count(*)::int`,
    })
    .from(crossBeatRadarSuggestionsTable)
    .groupBy(crossBeatRadarSuggestionsTable.status);
  const counts: Record<RadarSuggestionStatus, number> = {
    pending: 0,
    dismissed: 0,
    skipped: 0,
  };
  for (const r of rows) counts[r.status] = Number(r.count);
  res.json({ running: isCrossBeatRadarRunning(), counts });
});

// GET /admin/concept-radar/suggestions
// Query params: status (pending|dismissed|skipped), limit, offset.
router.get("/concept-radar/suggestions", async (req, res) => {
  const statusParam = (req.query.status as string) || undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const statusFilter =
    statusParam && (RADAR_SUGGESTION_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as RadarSuggestionStatus)
      : undefined;

  const where = statusFilter
    ? eq(crossBeatRadarSuggestionsTable.status, statusFilter)
    : undefined;
  const [suggestions, [{ total }]] = await Promise.all([
    db
      .select()
      .from(crossBeatRadarSuggestionsTable)
      .where(where)
      .orderBy(desc(crossBeatRadarSuggestionsTable.createdAt), desc(crossBeatRadarSuggestionsTable.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(crossBeatRadarSuggestionsTable)
      .where(where),
  ]);
  res.json({ suggestions, total: Number(total) });
});

// POST /admin/concept-radar/suggestions/:id/dismiss
// Dismisses a pending suggestion. The dedupe key stays in the table, so the
// radar never re-pitches this concept/beat-pair. Also rejects the linked
// topic idea when it is still pending (an approved/drafting idea is the
// editor's call — leave it alone).
router.post("/concept-radar/suggestions/:id/dismiss", async (req, res) => {
  const [updated] = await db
    .update(crossBeatRadarSuggestionsTable)
    .set({ status: "dismissed", updatedAt: new Date() })
    .where(
      and(
        eq(crossBeatRadarSuggestionsTable.id, req.params.id as string),
        eq(crossBeatRadarSuggestionsTable.status, "pending"),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Pending suggestion not found" });
    return;
  }
  let ideaRejected = false;
  if (updated.ideaId) {
    const [idea] = await db
      .update(topicIdeasTable)
      .set({ status: "rejected", updatedAt: new Date() })
      .where(
        and(eq(topicIdeasTable.id, updated.ideaId), eq(topicIdeasTable.status, "pending")),
      )
      .returning({ id: topicIdeasTable.id });
    ideaRejected = Boolean(idea);
  }
  res.json({ suggestion: updated, ideaRejected });
});

// ---------------------------------------------------------------------------
// Concept Evidence Health — pass trigger + status + alert list/actions
// ---------------------------------------------------------------------------

// POST /admin/concept-health/run
router.post("/concept-health/run", (_req, res) => {
  const { started } = startConceptHealthPass();
  if (!started) {
    res.status(409).json({ error: "Concept health pass already in progress" });
    return;
  }
  res.status(202).json({ started: true });
});

// GET /admin/concept-health/status
router.get("/concept-health/status", async (_req, res) => {
  const [snapshotRow, alertRows] = await Promise.all([
    db
      .select({
        concepts: sql<number>`count(*)::int`,
        lastComputedAt: sql<string | null>`max(${conceptEvidenceHealthTable.computedAt})`,
      })
      .from(conceptEvidenceHealthTable),
    db
      .select({
        status: conceptHealthAlertsTable.status,
        count: sql<number>`count(*)::int`,
      })
      .from(conceptHealthAlertsTable)
      .groupBy(conceptHealthAlertsTable.status),
  ]);
  const alertCounts: Record<ConceptHealthAlertStatus, number> = {
    open: 0,
    dismissed: 0,
    resolved: 0,
    promoted: 0,
  };
  for (const r of alertRows) alertCounts[r.status] = Number(r.count);
  const snap = snapshotRow[0];
  res.json({
    running: isConceptHealthPassRunning(),
    conceptsTracked: Number(snap?.concepts ?? 0),
    // Raw sql aggregates come back as strings — coerce before ISO-formatting.
    lastComputedAt: snap?.lastComputedAt ? new Date(snap.lastComputedAt).toISOString() : null,
    alertCounts,
  });
});

// GET /admin/concept-health/alerts
// Query params: status (open|dismissed|resolved|promoted), type, limit, offset.
router.get("/concept-health/alerts", async (req, res) => {
  const statusParam = (req.query.status as string) || undefined;
  const typeParam = (req.query.type as string) || undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  const conds = [];
  if (statusParam && (CONCEPT_HEALTH_ALERT_STATUSES as readonly string[]).includes(statusParam)) {
    conds.push(eq(conceptHealthAlertsTable.status, statusParam as ConceptHealthAlertStatus));
  }
  if (typeParam && (CONCEPT_HEALTH_ALERT_TYPES as readonly string[]).includes(typeParam)) {
    conds.push(eq(conceptHealthAlertsTable.alertType, typeParam as ConceptHealthAlertType));
  }
  const where = conds.length ? and(...conds) : undefined;

  const [alerts, [{ total }]] = await Promise.all([
    db
      .select()
      .from(conceptHealthAlertsTable)
      .where(where)
      .orderBy(desc(conceptHealthAlertsTable.createdAt), desc(conceptHealthAlertsTable.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(conceptHealthAlertsTable)
      .where(where),
  ]);
  res.json({ alerts, total: Number(total) });
});

// POST /admin/concept-health/alerts/:id/dismiss
// Dismissed alerts stay dismissed across recomputes (dedupe key memory).
router.post("/concept-health/alerts/:id/dismiss", async (req, res) => {
  const [updated] = await db
    .update(conceptHealthAlertsTable)
    .set({ status: "dismissed", updatedAt: new Date() })
    .where(
      and(
        eq(conceptHealthAlertsTable.id, req.params.id as string),
        eq(conceptHealthAlertsTable.status, "open"),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Open alert not found" });
    return;
  }
  res.json({ alert: updated });
});

// POST /admin/concept-health/alerts/:id/promote
// coverage_opportunity only: creates a pending topic idea for the concept's
// strongest beat (deterministic author pick, same rule the radar uses) and
// marks the alert promoted. No LLM call — the editor refines title/angle in
// the idea gallery.
class PromoteBlockedError extends Error {}

router.post("/concept-health/alerts/:id/promote", async (req, res) => {
  const alertId = req.params.id as string;
  try {
    const outcome = await db.transaction(async (tx) => {
      // Atomic claim FIRST: only one concurrent request can flip open →
      // promoted, and the idea insert below shares this transaction, so a
      // losing racer never leaves an orphan pending idea behind.
      const [claimed] = await tx
        .update(conceptHealthAlertsTable)
        .set({ status: "promoted", updatedAt: new Date() })
        .where(
          and(
            eq(conceptHealthAlertsTable.id, alertId),
            eq(conceptHealthAlertsTable.status, "open"),
            eq(conceptHealthAlertsTable.alertType, "coverage_opportunity"),
          ),
        )
        .returning();
      if (!claimed) return null;

      const profile = await getConceptBeatProfile(claimed.conceptId);
      const topBeat = profile.rows[0];
      if (!topBeat) {
        // Throwing rolls the claim back — the alert stays open.
        throw new PromoteBlockedError("Concept has no beat affinity profile yet");
      }
      const author = await pickRadarAuthor(topBeat.beatSlug);
      if (!author) {
        throw new PromoteBlockedError("No covering author has approved-idea headroom");
      }

      const secondary = profile.rows.slice(1, 3).map((b) => b.beatSlug);
      const [idea] = await tx
        .insert(topicIdeasTable)
        .values({
          authorId: author.id,
          title: `${claimed.conceptTerm}: the story readers haven't been told`,
          angle: `Fresh, well-sourced evidence has accumulated around "${claimed.conceptTerm}" but almost nothing has been published on it. Build the definitive piece from the current evidence base.`,
          category: topBeat.beatName ?? topBeat.beatSlug,
          categorySlug: topBeat.beatSlug,
          secondaryBeats: secondary.length ? secondary : null,
          status: "pending",
          notes: `From Evidence Health: coverage opportunity on "${claimed.conceptTerm}" (${
            claimed.detail?.activeTrustedCount ?? "?"
          } trusted sources, ${claimed.detail?.independentFamilyCount ?? "?"} independent families, ${
            claimed.detail?.articleMentionCount ?? 0
          } published mentions).`,
        })
        .returning({ id: topicIdeasTable.id });

      const [updated] = await tx
        .update(conceptHealthAlertsTable)
        .set({ ideaId: idea?.id ?? null })
        .where(eq(conceptHealthAlertsTable.id, claimed.id))
        .returning();
      return { alert: updated ?? claimed, ideaId: idea?.id ?? null };
    });

    if (!outcome) {
      // Claim matched nothing: missing, wrong type, or already settled.
      const [row] = await db
        .select()
        .from(conceptHealthAlertsTable)
        .where(eq(conceptHealthAlertsTable.id, alertId))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: "Alert not found" });
      } else if (row.alertType !== "coverage_opportunity") {
        res.status(409).json({ error: "Only coverage-opportunity alerts can be promoted" });
      } else {
        res.status(409).json({ error: `Alert is ${row.status}, not open` });
      }
      return;
    }
    res.json(outcome);
  } catch (err) {
    if (err instanceof PromoteBlockedError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

// POST /admin/concept-health/alerts/:id/harvest
// weak_support only: bounded source harvest — one budget-guarded search for
// the concept term, enqueue the leads into the vault ingest queue, and mark
// the concept for the definition-backfill sweep. Synchronous (single search)
// so the admin sees the enqueue count immediately. The alert stays open —
// the next health pass resolves it once the evidence base recovers.
router.post("/concept-health/alerts/:id/harvest", async (req, res) => {
  const [alert] = await db
    .select()
    .from(conceptHealthAlertsTable)
    .where(eq(conceptHealthAlertsTable.id, req.params.id as string))
    .limit(1);
  if (!alert) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }
  if (alert.alertType !== "weak_support") {
    res.status(409).json({ error: "Only weak-support alerts can trigger a harvest" });
    return;
  }
  if (alert.status !== "open") {
    res.status(409).json({ error: `Alert is ${alert.status}, not open` });
    return;
  }

  try {
    await VaultBudgetGuard.start(`concept-harvest:${alert.conceptSlug}`);
  } catch (err) {
    if (err instanceof VaultBudgetExceededError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }

  const profile = await getConceptBeatProfile(alert.conceptId);
  const beatSlug = profile.rows[0]?.beatSlug ?? null;
  const leads = await searchWithFallback(
    `${alert.conceptTerm} evidence research primary sources`,
    { maxResults: 5, operation: "sourceVaultSearch" },
  );

  let enqueued = 0;
  for (const lead of leads) {
    const r = await enqueueUrl(lead.url, {
      discoveredVia: "perplexity_search",
      leadSnippet: lead.snippet ?? null,
      beatSlug,
    });
    if (r.enqueued) enqueued += 1;
  }

  await db
    .update(conceptsTable)
    .set({ backfillRequested: true })
    .where(eq(conceptsTable.id, alert.conceptId));

  req.log?.info(
    { conceptSlug: alert.conceptSlug, leads: leads.length, enqueued },
    "admin/concept-health: weak-support harvest complete",
  );
  res.json({ leads: leads.length, enqueued });
});

export default router;
