/**
 * Admin — Concept Explainer & Glossary routes
 *
 * Matches the existing BrainHook admin-route pattern:
 * fire-and-forget POST for async jobs + GET for status/list.
 * All routes require requireAdmin + requireTrustedOrigin (applied at the
 * router level in routes/index.ts, same as every other /admin route).
 */

import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { eq, desc, sql, and, ilike, isNull, isNotNull, inArray } from "drizzle-orm";
import {
  db,
  articlesTable,
  conceptsTable,
  conceptAliasesTable,
  conceptSourcesTable,
  articleConceptMentionsTable,
  sourceDocumentsTable,
  sourceConceptEdgesTable,
} from "@workspace/db";
import {
  processArticleConcepts,
  backfillConcepts,
  isConceptBackfillRunning,
  requestConceptBackfillPause,
  getConceptBackfillProgress,
  getConceptWithDetails,
  mergeConcepts,
  setArticleConceptsDisabled,
  getConceptProcessingRuns,
  getConceptCostSummary,
  toConceptTitleCase,
  bulkScanAllConcepts,
  bulkRecomposeConceptDefinitions,
  getBulkRecomposeStatus,
  requestBulkRecomposeCancel,
  backfillMarkedConcepts,
  getBackfillMarkedStatus,
  releaseBackfillMarkedClaim,
  requestBackfillMarkedCancel,
  tryClaimBackfillMarkedRun,
  recheckConceptSources,
  findExistingConcept,
  resolveOrCreateConcept,
  resolveConceptLlmProvider,
} from "../../services/conceptExplainer";
import { isResearchCapabilityAvailable } from "../../services/researchFallback";
import { isAiFunctionEnabled } from "../../services/aiSettings";
import { getSiteSettings } from "../../services/siteSettings";
import { resolveWikipedia, enqueueWikipediaInVault } from "../../services/wikipedia";
import {
  startConceptEdgeBackfill,
  getConceptEdgeBackfillStatus,
  requestConceptEdgeBackfillCancel,
  type ConceptEdgeBackfillProgress,
} from "../../services/conceptEdges";
import {
  startConceptBeatAffinityRecompute,
  getConceptBeatAffinityStatus,
  listBridgeConcepts,
  getConceptBeatProfile,
} from "../../services/conceptBeatAffinityJob";
import {
  startAliasAudit,
  executeAliasAudit,
  getAliasAuditStatus,
  requestAliasAuditCancel,
} from "../../services/conceptAliasAudit";
import {
  startMergeSweep,
  executeMergeSweep,
  requestMergeSweepCancel,
  getMergeSweepStatus,
} from "../../services/conceptMergeSweep";
import { deletePublicObject } from "../../lib/objectStorage";
import {
  captureSingleCard,
  startCaptureBatch,
  getCaptureBatchStatus,
  requestCaptureBatchCancel,
  CaptureBusyError,
  ConceptNotFoundError,
} from "../../services/glossaryCardCapture";
import { submitUrlsToIndexNow } from "../../lib/indexnow";
import {
  acquireJobLock,
  heartbeatJob,
  finishJob,
  getJobState,
  isJobRunning,
  requestJobCancel,
  isCancelRequested,
} from "../../services/jobState";
import { logger } from "../../lib/logger";
import {
  syncConceptToVault,
  deactivateConceptVaultDoc,
  reconcileGlossaryVault,
  glossaryPseudoUrl,
} from "../../services/glossaryVaultSync";
import { conceptRelationshipsTable } from "@workspace/db";

const router: IRouter = Router();

const RELATION_TYPES = [
  "related",
  "distinct_from",
  "parent_of",
  "subtype_of",
  "antonym",
  "see_also",
] as const;
type RelationType = (typeof RELATION_TYPES)[number];

// ---------------------------------------------------------------------------
// Backfill — trigger + pause + status
// ---------------------------------------------------------------------------
// Durable + resumable: progress lives in the concept_processing_runs ledger
// and the background_jobs lock row, so "resume" is simply starting the
// backfill again — already-processed articles are skipped by the candidate
// query. Pause is cooperative (cancel flag checked between articles).

// POST /admin/concepts/backfill
// Starts a background backfill pass over ALL remaining unprocessed articles
// (bounded per invocation; budget guard + pause stop it early).
router.post("/concepts/backfill", async (req, res) => {
  if (await isConceptBackfillRunning()) {
    res.status(409).json({ error: "Concept backfill already running" });
    return;
  }
  const limit = Math.min(Number(req.body?.limit) || 500, 2000);
  // Fire-and-forget
  void (async () => {
    try {
      await backfillConcepts(limit);
    } catch (err) {
      req.log?.error({ err }, "admin/concepts: backfill background error");
    }
  })();
  res.status(202).json({ started: true });
});

// POST /admin/concepts/backfill/pause
// Cooperative pause of the running backfill. Resume = start again (durable
// ledger skips finished articles).
router.post("/concepts/backfill/pause", async (_req, res) => {
  const requested = await requestConceptBackfillPause();
  if (!requested) {
    res.status(409).json({ error: "No concept backfill is running" });
    return;
  }
  res.json({ pauseRequested: true });
});

// GET /admin/concepts/backfill-status
// Durable progress snapshot (running flag, counts, remaining, stop reason).
router.get("/concepts/backfill-status", async (_req, res) => {
  res.json(await getConceptBackfillProgress());
});

// ---------------------------------------------------------------------------
// Source-to-concept edge backfill (Task #338)
// Deterministic tagger over untagged vault documents — no AI cost. DB-locked
// via the shared background_jobs pattern (stale-heartbeat takeover).
// Registered BEFORE /concepts/:id so "edge-backfill" is not captured as an id.
// ---------------------------------------------------------------------------

// POST /admin/concepts/edge-backfill
router.post("/concepts/edge-backfill", async (_req, res) => {
  const { started } = await startConceptEdgeBackfill();
  if (!started) {
    res.status(409).json({ error: "Concept edge backfill already running" });
    return;
  }
  res.status(202).json({ started: true });
});

// POST /admin/concepts/edge-backfill/cancel
router.post("/concepts/edge-backfill/cancel", async (req, res) => {
  const cancelled = await requestConceptEdgeBackfillCancel();
  if (!cancelled) {
    res.status(409).json({ error: "No concept edge backfill is running" });
    return;
  }
  req.log?.info("admin/concepts: edge-backfill cancel requested");
  res.json({ cancelRequested: true });
});

// GET /admin/concepts/edge-backfill/status
// Flat snapshot for the admin poller (progress lives in the job row's JSONB).
router.get("/concepts/edge-backfill/status", async (_req, res) => {
  const s = await getConceptEdgeBackfillStatus();
  const p = (s.state?.progress ?? {}) as Partial<ConceptEdgeBackfillProgress>;
  res.json({
    running: s.running,
    status: s.state?.status ?? "idle",
    scanned: Number(p.scanned ?? 0),
    tagged: Number(p.tagged ?? 0),
    edges: Number(p.edges ?? 0),
    remaining: s.remaining,
    error: s.state?.error ?? null,
    startedAt: s.state?.startedAt ?? null,
    finishedAt: s.state?.finishedAt ?? null,
  });
});

// ---------------------------------------------------------------------------
// Concept-to-beat affinity weights — recompute + status + bridges
// (literal paths, registered BEFORE /concepts/:id)
// ---------------------------------------------------------------------------

// POST /admin/concepts/beat-affinities/recompute
// Deterministic full recompute of every concept's beat profile. DB-only, no
// AI cost. Fire-and-forget (202) with an in-process run claim (409 when busy).
router.post("/concepts/beat-affinities/recompute", (_req, res) => {
  const { started } = startConceptBeatAffinityRecompute();
  if (!started) {
    res.status(409).json({ error: "Beat affinity recompute already running" });
    return;
  }
  res.status(202).json({ started: true });
});

// GET /admin/concepts/beat-affinities/status
router.get("/concepts/beat-affinities/status", async (_req, res) => {
  res.json(await getConceptBeatAffinityStatus());
});

// GET /admin/concepts/bridges
// Bridge concepts (meaningful weight in 2+ beats) with qualifying beats —
// the read API the cross-beat radar consumes.
router.get("/concepts/bridges", async (_req, res) => {
  res.json({ bridges: await listBridgeConcepts() });
});

// ---------------------------------------------------------------------------
// Run history + cost reporting (registered BEFORE /concepts/:id so the
// literal paths are not captured by the :id param route)
// ---------------------------------------------------------------------------

// GET /admin/concepts/runs
// Recent processing runs with per-run skipped candidates (term + reason).
router.get("/concepts/runs", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({ runs: await getConceptProcessingRuns(limit) });
});

// GET /admin/concepts/costs
// Aggregated AI spend for the concept pipeline (from ai_usage_events).
router.get("/concepts/costs", async (_req, res) => {
  res.json(await getConceptCostSummary());
});

// ---------------------------------------------------------------------------
// Bulk scan-articles — re-links every concept to every article in one pass
// ---------------------------------------------------------------------------

// POST /admin/concepts/bulk-scan-articles
// Synchronous (no AI, pure DB). Returns { concepts, newMentions }.
router.post("/concepts/bulk-scan-articles", async (req, res) => {
  try {
    const force = Boolean(req.body?.force);
    const result = await bulkScanAllConcepts(force);
    res.json(result);
  } catch (err) {
    req.log?.error({ err }, "admin/concepts: bulk-scan-articles error");
    res.status(500).json({ error: "bulk_scan_failed" });
  }
});

// ---------------------------------------------------------------------------
// Backfill & review sweep — targeted regeneration of admin-marked concepts
// (registered BEFORE /concepts/:id so the literal path is not captured)
// ---------------------------------------------------------------------------

// GET /admin/concepts/backfill-marked/status
router.get("/concepts/backfill-marked/status", (_req, res) => {
  res.json(getBackfillMarkedStatus());
});

// POST /admin/concepts/backfill-marked
// Fire-and-forget sweep over every concept with backfill_requested = true:
// re-resolves Wikipedia, regenerates all definition fields, re-verifies, and
// recaptures both stored card snapshots. Marks clear only on success.
router.post("/concepts/backfill-marked", async (req, res) => {
  // Synchronous claim before any await — two near-simultaneous POSTs cannot
  // both pass an "is running?" check and launch duplicate sweeps.
  if (!tryClaimBackfillMarkedRun()) {
    res.status(409).json({ error: "Backfill sweep already running" });
    return;
  }
  let started = false;
  try {
    const [{ count: markedCount }] = (await db
      .select({ count: sql<number>`count(*)::int` })
      .from(conceptsTable)
      .where(eq(conceptsTable.backfillRequested, true))) as [{ count: number }];
    if (!markedCount) {
      res.status(409).json({ error: "No concepts are marked for backfill" });
      return;
    }
    void (async () => {
      try {
        await backfillMarkedConcepts();
      } catch (err) {
        req.log?.error({ err }, "admin/concepts: backfill-marked background error");
      }
    })();
    started = true;
    res.status(202).json({ started: true, total: markedCount });
  } finally {
    if (!started) releaseBackfillMarkedClaim();
  }
});

// POST /admin/concepts/backfill-marked/cancel
router.post("/concepts/backfill-marked/cancel", (req, res) => {
  const cancelled = requestBackfillMarkedCancel();
  if (!cancelled) {
    res.status(409).json({ error: "No backfill sweep is running" });
    return;
  }
  req.log?.info("admin/concepts: backfill-marked cancel requested");
  res.json({ cancelRequested: true });
});

// GET /admin/concepts/bulk-recompose/status
router.get("/concepts/bulk-recompose/status", (_req, res) => {
  res.json(getBulkRecomposeStatus());
});

// POST /admin/concepts/bulk-recompose/cancel
router.post("/concepts/bulk-recompose/cancel", (req, res) => {
  const cancelled = requestBulkRecomposeCancel();
  if (!cancelled) {
    res.status(409).json({ error: "No bulk recompose is running" });
    return;
  }
  req.log?.info("admin/concepts: bulk-recompose cancel requested");
  res.json({ cancelRequested: true });
});

// POST /admin/concepts/bulk-recompose
// Fire-and-forget: regenerates realLifeExample / whatItIsnt /
// commonlyMisusedOnline for concepts that are missing those fields.
// Pass { force: true } in the body to recompose ALL concepts.
router.post("/concepts/bulk-recompose", async (req, res) => {
  if (getBulkRecomposeStatus().running) {
    res.status(409).json({ error: "Bulk recompose already running" });
    return;
  }
  const force = Boolean(req.body?.force);
  void (async () => {
    try {
      await bulkRecomposeConceptDefinitions(force);
    } catch (err) {
      req.log?.error({ err }, "admin/concepts: bulk-recompose background error");
    }
  })();
  res.status(202).json({ started: true, force });
});

// ---------------------------------------------------------------------------
// Alias-conflation audit — general sweep across ALL concepts
// (registered BEFORE /concepts/:id so "alias-audit" is not captured as an id)
// ---------------------------------------------------------------------------
// Replaces the earlier one-off "backfill-attachment" route with a general
// mechanism: deterministic collision passes + an LLM pass that flags aliases
// naming a distinct concept. Fire-and-forget; the report persists as the
// background job's progress snapshot.

// POST /admin/concepts/alias-audit  { dryRun?: boolean }
router.post("/concepts/alias-audit", async (req, res) => {
  const dryRun = req.body?.dryRun === true;
  const runId = await startAliasAudit();
  if (!runId) {
    res.status(409).json({ error: "alias_audit_already_running" });
    return;
  }
  void executeAliasAudit(runId, dryRun).catch((err) => {
    req.log?.error({ err }, "admin/concepts: alias audit background error");
  });
  res.status(202).json({ started: true, dryRun });
});

// POST /admin/concepts/alias-audit/cancel
router.post("/concepts/alias-audit/cancel", (req, res) => {
  const cancelled = requestAliasAuditCancel();
  if (!cancelled) {
    res.status(409).json({ error: "No alias audit is running" });
    return;
  }
  req.log?.info("admin/concepts: alias-audit cancel requested");
  res.json({ cancelRequested: true });
});

// GET /admin/concepts/alias-audit — status + latest report
router.get("/concepts/alias-audit", async (_req, res) => {
  res.json(await getAliasAuditStatus());
});

// ---------------------------------------------------------------------------
// Merge sweep — find and merge duplicate glossary entries
// (registered BEFORE /concepts/:id so "merge-sweep" is not captured as an id)
// ---------------------------------------------------------------------------
// Deterministic candidate detection (identical/pluralized terms, term listed
// as another entry's alias, shared Wikipedia page, reordered wording) plus an
// LLM judge that confirms true duplicates before merging. Fire-and-forget;
// the report persists as the background job's progress snapshot.

// POST /admin/concepts/merge-sweep  { dryRun?: boolean }
router.post("/concepts/merge-sweep", async (req, res) => {
  const dryRun = req.body?.dryRun === true;
  const runId = await startMergeSweep();
  if (!runId) {
    res.status(409).json({ error: "merge_sweep_already_running" });
    return;
  }
  void executeMergeSweep(runId, dryRun).catch((err) => {
    req.log?.error({ err }, "admin/concepts: merge sweep background error");
  });
  res.status(202).json({ started: true, dryRun });
});

// POST /admin/concepts/merge-sweep/cancel
router.post("/concepts/merge-sweep/cancel", async (req, res) => {
  const status = await getMergeSweepStatus();
  if (!status.running) {
    res.status(409).json({ error: "No merge sweep is running" });
    return;
  }
  requestMergeSweepCancel();
  req.log?.info("admin/concepts: merge-sweep cancel requested");
  res.json({ cancelRequested: true });
});

// GET /admin/concepts/merge-sweep — status + latest report
router.get("/concepts/merge-sweep", async (_req, res) => {
  res.json(await getMergeSweepStatus());
});

// ---------------------------------------------------------------------------
// Per-article kill-switch
// ---------------------------------------------------------------------------

// POST /admin/concepts/articles/:articleId/toggle
// Enable/disable Concept Explainer annotations for a single article.
router.post("/concepts/articles/:articleId/toggle", async (req, res) => {
  const { disabled } = req.body as { disabled?: boolean };
  if (typeof disabled !== "boolean") {
    res.status(400).json({ error: "disabled_boolean_required" });
    return;
  }
  const result = await setArticleConceptsDisabled(req.params.articleId as string, disabled);
  if (!result) {
    res.status(404).json({ error: "article_not_found" });
    return;
  }
  res.json(result);
});

// ---------------------------------------------------------------------------
// Per-article concept processing
// ---------------------------------------------------------------------------

// POST /admin/concepts/process/:articleId
// Trigger (or force-rerun) concept detection for a single article.
router.post("/concepts/process/:articleId", async (req, res) => {
  const { articleId } = req.params;
  const force = req.query.force === "true";
  const result = await processArticleConcepts(articleId as string, force);
  if (result.status === "failed") {
    res.status(500).json(result);
    return;
  }
  res.json(result);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// AI-powered concept generation (drop-in a term, run the full pipeline)
// ---------------------------------------------------------------------------

// POST /admin/concepts/generate
// Runs the normal glossary pipeline (wiki search, disambiguation, vault
// lookup, definition generation, verification) against a single term with
// no article context. Returns the created concept or an error if the pipeline
// couldn't produce a passing definition.
router.post("/concepts/generate", async (req, res) => {
  const { term } = req.body as { term?: string };
  if (!term?.trim()) {
    res.status(400).json({ error: "term_required" });
    return;
  }

  if (!(await isResearchCapabilityAvailable())) {
    res.status(503).json({ error: "research_unavailable", message: "The research provider (Perplexity) is not configured." });
    return;
  }
  const settings = await getSiteSettings();
  if (!settings.conceptExplainersEnabled) {
    res.status(503).json({ error: "explainers_disabled" });
    return;
  }
  if (!(await isAiFunctionEnabled("concept_definition"))) {
    res.status(503).json({ error: "ai_disabled", message: "The concept_definition AI function is currently disabled." });
    return;
  }

  const existing = await findExistingConcept(term.trim());
  if (existing) {
    res.status(409).json({ error: "already_exists", id: existing.id, slug: existing.slug });
    return;
  }

  const provider = resolveConceptLlmProvider();
  const definitionThreshold = settings.conceptDefinitionThreshold;

  try {
    // Pass empty article context — the pipeline works standalone; vault
    // semantic search uses the term itself as the query, and definition
    // generation treats "no article context" as a general-domain term.
    const result = await resolveOrCreateConcept(
      term.trim(),
      "", // no article context
      1.0, // admin-triggered = max detection confidence
      definitionThreshold,
      provider,
    );

    if (!result) {
      res.status(422).json({
        error: "generation_failed",
        message: "The AI pipeline could not produce a passing definition for this term. Try the manual import form instead.",
      });
      return;
    }

    void syncConceptToVault(result.id);
    res.status(201).json({ id: result.id, slug: result.slug });
  } catch (err) {
    // Surface provider errors so the admin knows whether it’s a temporary
    // outage (quota, cooldown) vs a term-specific failure.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("insufficient_quota") || msg.includes("cooldown") || msg.includes("Perplexity")) {
      res.status(503).json({
        error: "provider_unavailable",
        message: "The AI research provider is temporarily unavailable (quota exhausted or cooldown). Switch to Manual import or try again shortly.",
      });
      return;
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Manual concept import (no AI — admin provides term + definitions directly)
// ---------------------------------------------------------------------------

// POST /admin/concepts/import
// Creates a concept immediately as "live" with the provided definitions.
// Also accepts an optional aliases[] array and wikiUrl.
// Must be registered before /:id routes so Express doesn't swallow "import"
// as a param value.
router.post("/concepts/import", async (req, res) => {
  const { term, hoverDefinition, definition, aliases, wikiUrl } = req.body as {
    term?: string;
    hoverDefinition?: string;
    definition?: string;
    aliases?: string[];
    wikiUrl?: string;
  };

  if (!term?.trim()) {
    res.status(400).json({ error: "term_required" });
    return;
  }
  if (!hoverDefinition?.trim()) {
    res.status(400).json({ error: "hover_definition_required" });
    return;
  }
  if (!definition?.trim()) {
    res.status(400).json({ error: "definition_required" });
    return;
  }

  // Slug: kebab-case, collision-safe
  const base = term.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  let slug = base;
  for (let suffix = 2; ; suffix++) {
    const [existing] = await db
      .select({ slug: conceptsTable.slug })
      .from(conceptsTable)
      .where(eq(conceptsTable.slug, slug))
      .limit(1);
    if (!existing) break;
    slug = `${base}-${suffix}`;
  }

  const [concept] = await db
    .insert(conceptsTable)
    .values({
      term: toConceptTitleCase(term.trim()),
      slug,
      hoverDefinition: hoverDefinition.trim(),
      definition: definition.trim(),
      status: "live",
      detectionConfidence: 1.0,
      definitionConfidence: 1.0,
      wikiUrl: wikiUrl?.trim() || null,
      lastProcessedAt: new Date(),
    })
    .returning();

  if (aliases?.length) {
    const rows = aliases
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a.length > 0)
      .map((alias) => ({ conceptId: concept.id, alias, isPrimary: false }));
    if (rows.length) {
      await db.insert(conceptAliasesTable).values(rows).onConflictDoNothing();
    }
  }

  void syncConceptToVault(concept.id);
  res.status(201).json(concept);
});

// ---------------------------------------------------------------------------
// Concept list + search
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Glossary Vault status + manual sync
// (registered BEFORE /concepts routes to avoid path conflicts)
// ---------------------------------------------------------------------------

// GET /admin/glossary-vault/status
// Returns per-status counts for glossary_concept vault docs and the last
// reconcile timestamp from the cron_job_runs ledger.
router.get("/glossary-vault/status", async (_req, res) => {
  // Count vault docs by (lifecycleStatus, status) for the glossary lane.
  const rows = await db
    .select({
      lifecycleStatus: sourceDocumentsTable.lifecycleStatus,
      docStatus: sourceDocumentsTable.status,
      count: sql<number>`count(*)::int`,
    })
    .from(sourceDocumentsTable)
    .where(eq(sourceDocumentsTable.discoveredVia, "glossary_concept"))
    .groupBy(sourceDocumentsTable.lifecycleStatus, sourceDocumentsTable.status);

  let embedded = 0;
  let pendingEmbed = 0;
  let unavailable = 0;

  for (const r of rows) {
    const n = Number(r.count);
    if (r.lifecycleStatus === "unavailable") {
      unavailable += n;
    } else if (r.docStatus === "embedded") {
      embedded += n;
    } else {
      pendingEmbed += n;
    }
  }

  const total = embedded + pendingEmbed + unavailable;

  // Last reconcile time from the cron_job_runs runtime table (raw SQL —
  // the table is created idempotently at boot, not part of the Drizzle schema).
  // db.execute returns { rows: [...] }, not a directly destructurable array.
  let lastReconcileAt: string | null = null;
  try {
    const result = await db.execute<{ ran_at: string | null }>(
      sql`SELECT ran_at FROM cron_job_runs WHERE job = 'glossary_vault_reconcile' LIMIT 1`,
    );
    const cronRow = result.rows[0];
    if (cronRow?.ran_at) {
      lastReconcileAt = new Date(cronRow.ran_at).toISOString();
    }
  } catch {
    // Runtime table may not exist on fresh dev DBs — non-fatal.
  }

  res.json({ embedded, pendingEmbed, unavailable, total, lastReconcileAt });
});

// POST /admin/glossary-vault/sync
// Fire-and-forget full reconciliation pass. Returns 202 immediately.
router.post("/glossary-vault/sync", async (req, res) => {
  void reconcileGlossaryVault()
    .then((r) => {
      req.log?.info(r, "admin/glossary-vault: manual sync complete");
    })
    .catch((err) => {
      req.log?.error({ err }, "admin/glossary-vault: manual sync error");
    });
  res.status(202).json({ started: true });
});

// GET /admin/concepts
// List all concepts with optional status filter and search term.
// Query params: status (live|draft|hidden), q (search term), limit, offset
router.get("/concepts", async (req, res) => {
  const status = (req.query.status as string) || undefined;
  const q = (req.query.q as string) || "";
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const retractionFlagged = req.query.retractionFlagged === "true";

  const conditions = [];
  if (status && ["live", "draft", "hidden"].includes(status)) {
    conditions.push(eq(conceptsTable.status, status as "live" | "draft" | "hidden"));
  }
  if (q.trim()) {
    conditions.push(ilike(conceptsTable.term, `%${q.trim()}%`));
  }
  if (retractionFlagged) {
    conditions.push(eq(conceptsTable.conceptRetractionFlag, true));
  }

  const where = conditions.length > 0 ? and(...(conditions as [ReturnType<typeof eq>])) : undefined;

  const [rows, [countRow]] = await Promise.all([
    db
      .select()
      .from(conceptsTable)
      .where(where)
      .orderBy(desc(conceptsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(conceptsTable)
      .where(where),
  ]);

  // Bulk-lookup vault status for the returned concepts in a single query.
  // "excluded" = hidden concept with no active vault doc — by design it will
  // never sync (reconcile only syncs non-hidden concepts), so the UI must not
  // present it as "waiting for the next reconcile".
  type VaultStatus = "embedded" | "pending" | "unavailable" | "no_doc" | "excluded";
  const vaultStatusMap = new Map<string, VaultStatus>();
  if (rows.length > 0) {
    const pseudoUrls = rows.map((r) => glossaryPseudoUrl(r.id));
    const vaultDocs = await db
      .select({
        url: sourceDocumentsTable.url,
        docStatus: sourceDocumentsTable.status,
        lifecycleStatus: sourceDocumentsTable.lifecycleStatus,
      })
      .from(sourceDocumentsTable)
      .where(inArray(sourceDocumentsTable.url, pseudoUrls));

    for (const doc of vaultDocs) {
      const conceptId = doc.url.replace("brainhook://glossary/", "");
      let vs: VaultStatus;
      if (doc.lifecycleStatus === "unavailable") {
        vs = "unavailable";
      } else if (doc.docStatus === "embedded") {
        vs = "embedded";
      } else {
        vs = "pending";
      }
      vaultStatusMap.set(conceptId, vs);
    }
  }

  // Batch-count concept_sources claim-relevance for the returned concepts.
  // Returned as null when no sources exist for a concept (to distinguish
  // "no sources" from "0 filtered").
  const sourceSummaryMap = new Map<
    string,
    { relevant: number; filtered: number; total: number }
  >();
  if (rows.length > 0) {
    const conceptIds = rows.map((r) => r.id);
    const summaryRows = await db
      .select({
        conceptId: conceptSourcesTable.conceptId,
        relevant: sql<number>`count(*) filter (where claim_relevant is not false)::int`,
        filtered: sql<number>`count(*) filter (where claim_relevant = false)::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(conceptSourcesTable)
      .where(inArray(conceptSourcesTable.conceptId, conceptIds))
      .groupBy(conceptSourcesTable.conceptId);

    for (const r of summaryRows) {
      sourceSummaryMap.set(r.conceptId, {
        relevant: Number(r.relevant),
        filtered: Number(r.filtered),
        total: Number(r.total),
      });
    }
  }

  const concepts = rows.map((c) => {
    let vaultStatus: VaultStatus = vaultStatusMap.get(c.id) ?? "no_doc";
    // Hidden concepts are excluded from vault sync by design; a missing or
    // deactivated doc is the intended terminal state, not a pending sync.
    if (c.status === "hidden" && (vaultStatus === "no_doc" || vaultStatus === "unavailable")) {
      vaultStatus = "excluded";
    }
    const sourceSummary = sourceSummaryMap.get(c.id) ?? null;
    return { ...c, vaultStatus, sourceSummary };
  });

  res.json({ concepts, total: Number(countRow?.count ?? 0) });
});

// GET /admin/concepts/gallery — all concepts with aliases for the CSS card gallery
// Must be registered before /concepts/:id so "gallery" isn't captured as an id.
router.get("/concepts/gallery", async (_req, res) => {
  const [concepts, aliases, mentionHeroes] = await Promise.all([
    db.select().from(conceptsTable).orderBy(conceptsTable.term),
    db.select().from(conceptAliasesTable),
    db
      .select({
        conceptId: articleConceptMentionsTable.conceptId,
        heroImage: articlesTable.heroImage,
      })
      .from(articleConceptMentionsTable)
      .innerJoin(articlesTable, eq(articleConceptMentionsTable.articleId, articlesTable.id))
      .where(
        and(
          eq(articlesTable.status, "published"),
          isNull(articlesTable.quarantinedAt),
          isNotNull(articlesTable.heroImage),
        ),
      ),
  ]);

  // Collect all hero candidates per concept then pick one at random.
  const heroPool = new Map<string, string[]>();
  for (const row of mentionHeroes) {
    const arr = heroPool.get(row.conceptId) ?? [];
    arr.push(row.heroImage);
    heroPool.set(row.conceptId, arr);
  }
  const heroByConceptId = new Map<string, string>();
  for (const [id, heroes] of heroPool) {
    heroByConceptId.set(id, heroes[Math.floor(Math.random() * heroes.length)]!);
  }

  const byConceptId = new Map<string, string[]>();
  for (const a of aliases) {
    const arr = byConceptId.get(a.conceptId) ?? [];
    arr.push(a.alias);
    byConceptId.set(a.conceptId, arr);
  }
  res.json({
    concepts: concepts.map((c) => ({
      ...c,
      aliases: byConceptId.get(c.id) ?? [],
      heroImageUrl: heroByConceptId.get(c.id) ?? null,
    })),
  });
});

// DB-backed job key for the source-relevance backfill.
// Uses the background_jobs table (via jobState.ts) so state survives restarts
// and the UI can detect "interrupted" (status=running but heartbeat gone stale).
const SOURCE_RELEVANCE_BACKFILL_JOB = "concept_source_relevance_backfill";
const SOURCE_RELEVANCE_TTL_MS = 5 * 60 * 1000; // 5-min heartbeat TTL

// GET /admin/concepts/backfill-source-relevance/status
// Returns a live progress snapshot while the job runs, and the final counts
// from the last run after it finishes. Also includes a live count of
// concept_sources rows where claim_relevant IS NULL so admins can tell at a
// glance whether the backfill has run to completion. Must be registered BEFORE
// the POST so Express doesn't try to match "status" as a sub-path.
router.get("/concepts/backfill-source-relevance/status", async (_req, res) => {
  const [[nullRow], jobRow] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(conceptSourcesTable)
      .where(isNull(conceptSourcesTable.claimRelevant)),
    getJobState(SOURCE_RELEVANCE_BACKFILL_JOB),
  ]);
  const running = isJobRunning(jobRow, SOURCE_RELEVANCE_TTL_MS);
  // "interrupted" = DB row still says running but heartbeat went stale — the
  // server restarted mid-run. The admin UI surfaces this as a warning.
  const interrupted = !running && jobRow?.status === "running";
  const progress = (jobRow?.progress ?? {}) as Record<string, unknown>;
  res.json({
    running,
    interrupted,
    cancelRequested: jobRow?.cancelRequested ?? false,
    processed: Number(progress.processed ?? 0),
    failed: Number(progress.failed ?? 0),
    total: Number(progress.total ?? 0),
    startedAt: jobRow?.startedAt ?? null,
    finishedAt: interrupted ? null : (jobRow?.finishedAt ?? null),
    nullRelevanceCount: Number(nullRow?.count ?? 0),
  });
});

// POST /admin/concepts/backfill-source-relevance
// Fire-and-forget bulk job: re-run the claim-relevance filter on every
// concept's stored sources. Safe to run on the back catalog (null rows =
// legacy / unverified) — only updates claim_relevant, never deletes sources.
// Must be before /concepts/:id so the literal path isn't captured as an id.
router.post("/concepts/backfill-source-relevance", async (req, res) => {
  const runId = await acquireJobLock(SOURCE_RELEVANCE_BACKFILL_JOB, {
    ttlMs: SOURCE_RELEVANCE_TTL_MS,
    progress: { processed: 0, failed: 0, total: 0 },
  });
  if (!runId) {
    res.status(409).json({ error: "Source relevance backfill already running" });
    return;
  }

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  void (async () => {
    try {
      const rows = await db
        .select({ id: conceptsTable.id })
        .from(conceptsTable)
        .orderBy(conceptsTable.createdAt);
      let processed = 0;
      let failed = 0;
      const total = rows.length;
      await heartbeatJob(SOURCE_RELEVANCE_BACKFILL_JOB, runId, { processed, failed, total });
      for (const row of rows) {
        if (await isCancelRequested(SOURCE_RELEVANCE_BACKFILL_JOB)) {
          req.log.info({ processed, failed }, "concept source-relevance backfill cancelled");
          break;
        }
        try {
          await recheckConceptSources(row.id);
          processed++;
        } catch {
          failed++;
        }
        // Space calls to avoid LLM rate limits; heartbeat every 10 concepts.
        await delay(800);
        if ((processed + failed) % 10 === 0) {
          await heartbeatJob(SOURCE_RELEVANCE_BACKFILL_JOB, runId, { processed, failed, total });
        }
      }
      req.log.info({ processed, failed }, "concept source-relevance backfill complete");
      await finishJob(SOURCE_RELEVANCE_BACKFILL_JOB, runId, "succeeded", {
        progress: { processed, failed, total },
      });
    } catch (err) {
      req.log.error({ err }, "concept source-relevance backfill error");
      await finishJob(SOURCE_RELEVANCE_BACKFILL_JOB, runId, "failed", { error: String(err) });
    }
  })();
  res.status(202).json({ status: "backfill_started" });
});

// POST /admin/concepts/backfill-source-relevance/cancel
// Cooperative cancel — sets cancel_requested in the DB; the loop checks it
// between concepts. Must be registered before /concepts/:id.
router.post("/concepts/backfill-source-relevance/cancel", async (req, res) => {
  const cancelled = await requestJobCancel(SOURCE_RELEVANCE_BACKFILL_JOB);
  if (!cancelled) {
    res.status(409).json({ error: "No source relevance backfill is currently running" });
    return;
  }
  req.log.info("concept source-relevance backfill cancel requested");
  res.json({ status: "cancel_requested" });
});

// GET /admin/concepts/quarantined
// List concepts that were auto-quarantined by the pipeline (status=hidden + quarantineReason set).
// Must be before /concepts/:id so "quarantined" isn't captured as an id.
router.get("/concepts/quarantined", async (_req, res) => {
  const rows = await db
    .select()
    .from(conceptsTable)
    .where(and(eq(conceptsTable.status, "hidden"), isNotNull(conceptsTable.quarantineReason)))
    .orderBy(desc(conceptsTable.createdAt));
  res.json({ concepts: rows });
});

// DELETE /admin/concepts/quarantined
// Bulk-delete every quarantined concept (status=hidden + quarantineReason set).
// Fire-and-forget deactivates vault docs after the DB delete. Returns the count.
router.delete("/concepts/quarantined", async (_req, res) => {
  const rows = await db
    .delete(conceptsTable)
    .where(and(eq(conceptsTable.status, "hidden"), isNotNull(conceptsTable.quarantineReason)))
    .returning({ id: conceptsTable.id });
  for (const row of rows) {
    void deactivateConceptVaultDoc(row.id);
  }
  res.json({ deleted: rows.length });
});

// ---------------------------------------------------------------------------
// Concept detail + edit
// ---------------------------------------------------------------------------

// GET /admin/concepts/:id
router.get("/concepts/:id", async (req, res) => {
  const concept = await getConceptWithDetails(req.params.id as string);
  if (!concept) {
    res.status(404).json({ error: "concept_not_found" });
    return;
  }
  res.json(concept);
});

// PATCH /admin/concepts/:id
// Admin can edit term, definition, hoverDefinition, status.
router.patch("/concepts/:id", async (req, res) => {
  const { id } = req.params;
  const { term, definition, hoverDefinition, status, termOfDayBlocked, backfillRequested, hoverEnabled } = req.body as {
    term?: string;
    definition?: string;
    hoverDefinition?: string;
    status?: "live" | "draft" | "hidden";
    termOfDayBlocked?: boolean;
    backfillRequested?: boolean;
    hoverEnabled?: boolean;
  };

  const patch: Partial<typeof conceptsTable.$inferInsert> = {};
  if (term !== undefined) patch.term = toConceptTitleCase(term.trim());
  if (definition !== undefined) patch.definition = definition.trim();
  if (hoverDefinition !== undefined) patch.hoverDefinition = hoverDefinition.trim();
  if (status !== undefined && ["live", "draft", "hidden"].includes(status)) {
    patch.status = status;
  }
  if (typeof termOfDayBlocked === "boolean") patch.termOfDayBlocked = termOfDayBlocked;
  if (typeof backfillRequested === "boolean") patch.backfillRequested = backfillRequested;
  if (typeof hoverEnabled === "boolean") patch.hoverEnabled = hoverEnabled;

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "no_changes" });
    return;
  }

  patch.updatedAt = new Date();

  const [updated] = await db
    .update(conceptsTable)
    .set(patch)
    .where(eq(conceptsTable.id, id as string))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "concept_not_found" });
    return;
  }
  void syncConceptToVault(id as string);
  res.json(updated);
});

// ---------------------------------------------------------------------------
// Card capture — server-side headless-Chromium screenshots of the CSS card.
// Replaces the old client-side html-to-image capture + store-card upload.
// ---------------------------------------------------------------------------

// GET /admin/concepts/capture-cards/status
// Progress of the current (or last) batch capture run (DB-backed job state).
router.get("/concepts/capture-cards/status", async (_req, res) => {
  res.json(await getCaptureBatchStatus());
});

// POST /admin/concepts/capture-cards/start
//   { mode: "backfill" | "rebuild-all", format: "feed" | "reel" }
// Fire-and-forget FORMAT-SCOPED batch capture (202): only the requested
// format is captured/stored — the other format's files are never touched.
// backfill = only concepts missing that format's card; rebuild-all = every
// concept, overwriting that format's stored snapshots.
router.post("/concepts/capture-cards/start", async (req, res) => {
  const body = req.body as { mode?: string; format?: string } | undefined;
  const mode = body?.mode;
  const format = body?.format;
  if (mode !== "backfill" && mode !== "rebuild-all") {
    res.status(400).json({ error: "mode must be 'backfill' or 'rebuild-all'" });
    return;
  }
  if (format !== "feed" && format !== "reel") {
    res.status(400).json({ error: "format must be 'feed' or 'reel'" });
    return;
  }
  const total = await startCaptureBatch(mode, format);
  if (total === null) {
    res.status(409).json({ error: "capture_busy" });
    return;
  }
  logger.info({ mode, format, total }, "concepts: capture batch started");
  res.status(202).json({ started: total > 0, total });
});

// POST /admin/concepts/capture-cards/cancel
// Stop the running batch after the in-flight card finishes.
router.post("/concepts/capture-cards/cancel", async (_req, res) => {
  await requestCaptureBatchCancel();
  res.json({ ok: true });
});

// POST /admin/concepts/:id/capture-card
// Synchronous single-card capture: headless Chromium screenshots the CSS
// card at /card-render and stores BOTH outputs — the 4:5 FB feed card
// (glossary-cards-fb/{slug}-card.png → concepts.card_image_url) and the 9:16
// reels card (glossary-cards/{slug}-snap.png → concepts.reels_image_url).
router.post("/concepts/:id/capture-card", async (req, res) => {
  const { id } = req.params;
  try {
    const { url, reelUrl } = await captureSingleCard(id as string);
    res.json({ url, reelUrl });
  } catch (err) {
    if (err instanceof CaptureBusyError) {
      res.status(409).json({ error: "capture_busy" });
      return;
    }
    if (err instanceof ConceptNotFoundError) {
      res.status(404).json({ error: "concept_not_found" });
      return;
    }
    logger.warn({ err, conceptId: id }, "concepts: capture-card failed");
    res.status(500).json({ error: "capture_failed" });
  }
});

// DELETE /admin/concepts/:id/card
// Deletes the stored snapshot card from object storage and clears
// concepts.card_image_url. The next download will re-capture a fresh card.
router.delete("/concepts/:id/card", async (req, res) => {
  const { id } = req.params;

  const [concept] = await db
    .select({
      id: conceptsTable.id,
      slug: conceptsTable.slug,
      cardImageUrl: conceptsTable.cardImageUrl,
      reelsImageUrl: conceptsTable.reelsImageUrl,
      shareImage: conceptsTable.shareImage,
    })
    .from(conceptsTable)
    .where(eq(conceptsTable.id, id as string))
    .limit(1);

  if (!concept) {
    res.status(404).json({ error: "concept_not_found" });
    return;
  }

  if (concept.cardImageUrl || concept.reelsImageUrl) {
    await deletePublicObject(`glossary-cards-fb/${concept.slug}-card.png`).catch(() => {});
    await deletePublicObject(`glossary-cards/${concept.slug}-snap.png`).catch(() => {});
    // Transitional reel naming from the earlier dual-output pass.
    await deletePublicObject(`glossary-cards/${concept.slug}-reel.png`).catch(() => {});
    // If share_image aliases the same snap URL (backfill copies it), null it
    // too so the DB never points at the just-deleted object.
    await db
      .update(conceptsTable)
      .set({
        cardImageUrl: null,
        reelsImageUrl: null,
        ...(concept.shareImage && concept.shareImage === concept.cardImageUrl ? { shareImage: null } : {}),
      })
      .where(eq(conceptsTable.id, id as string));
    logger.info({ conceptId: id, slug: concept.slug }, "concepts: cleared snapshot cards");
  }

  res.json({ ok: true });
});

// DELETE /admin/concepts/:id
// Hard-delete a concept + cascaded mentions + aliases.
// The vault doc is deactivated immediately (fire-and-forget) so the deleted
// concept cannot appear in glossary retrieval. The hourly reconcile (Pass 3)
// provides a safety-net for any that are missed.
router.delete("/concepts/:id", async (req, res) => {
  const { id } = req.params;
  const [deleted] = await db
    .delete(conceptsTable)
    .where(eq(conceptsTable.id, id as string))
    .returning({ id: conceptsTable.id });
  if (!deleted) {
    res.status(404).json({ error: "concept_not_found" });
    return;
  }
  void deactivateConceptVaultDoc(id as string);
  res.json({ deleted: true });
});

// POST /admin/concepts/:id/publish
// Publish a concept (status → live). CSS share card is captured client-side
// from /admin/media-library/glossary on first admin download.
router.post("/concepts/:id/publish", async (req, res) => {
  const [updated] = await db
    .update(conceptsTable)
    .set({ status: "live", updatedAt: new Date() })
    .where(eq(conceptsTable.id, req.params.id as string))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "concept_not_found" });
    return;
  }
  void syncConceptToVault(updated.id);
  void submitUrlsToIndexNow(["/", "/sitemap.xml", "/sitemap-glossary.xml", `/glossary/${updated.slug}`]);
  res.json(updated);
});

// POST /admin/concepts/:id/regen-share-card
// Clears the old satori share_image from storage + DB so the next crawl
// falls back to the branded default. CSS cards are captured client-side
// from /admin/media-library/glossary — this endpoint no longer generates them.
router.post("/concepts/:id/regen-share-card", async (req, res) => {
  const [concept] = await db
    .select({
      id: conceptsTable.id,
      shareImage: conceptsTable.shareImage,
      cardImageUrl: conceptsTable.cardImageUrl,
    })
    .from(conceptsTable)
    .where(eq(conceptsTable.id, req.params.id as string))
    .limit(1);
  if (!concept) {
    res.status(404).json({ error: "concept_not_found" });
    return;
  }
  // Same alias guard as the rebuild sweep: share_image may be a copy of the
  // CSS-captured snap URL (backfill aliases card_image_url), so deleting it
  // from storage would 404 the canonical card. Only delete true satori files.
  const isAliasedSnap =
    concept.shareImage === concept.cardImageUrl ||
    (concept.shareImage?.endsWith("-snap.png") ?? false);
  if (!isAliasedSnap && concept.shareImage?.startsWith("/api/storage/public-objects/")) {
    const key = concept.shareImage.replace("/api/storage/public-objects/", "");
    await deletePublicObject(key).catch(() => {});
  }
  const [updated] = await db
    .update(conceptsTable)
    .set({ shareImage: null })
    .where(eq(conceptsTable.id, concept.id))
    .returning();
  res.json(updated);
});

// ---------------------------------------------------------------------------
// Concept relationships — curated semantic links between concepts
// ---------------------------------------------------------------------------

// GET /admin/concepts/:id/relationships
// All relationships where this concept is either endpoint, with the other
// concept's term/slug resolved for display.
router.get("/concepts/:id/relationships", async (req, res) => {
  const conceptId = req.params.id as string;
  const rows = await db
    .select({
      id: conceptRelationshipsTable.id,
      fromConceptId: conceptRelationshipsTable.fromConceptId,
      toConceptId: conceptRelationshipsTable.toConceptId,
      relationType: conceptRelationshipsTable.relationType,
      note: conceptRelationshipsTable.note,
      createdAt: conceptRelationshipsTable.createdAt,
    })
    .from(conceptRelationshipsTable)
    .where(
      sql`${conceptRelationshipsTable.fromConceptId} = ${conceptId} OR ${conceptRelationshipsTable.toConceptId} = ${conceptId}`,
    );
  // Resolve the "other side" concept for each row
  const otherIds = [...new Set(rows.map((r) => (r.fromConceptId === conceptId ? r.toConceptId : r.fromConceptId)))];
  const others = otherIds.length
    ? await db
        .select({ id: conceptsTable.id, term: conceptsTable.term, slug: conceptsTable.slug, status: conceptsTable.status })
        .from(conceptsTable)
        .where(inArray(conceptsTable.id, otherIds))
    : [];
  const byId = new Map(others.map((c) => [c.id, c]));
  res.json({
    relationships: rows.map((r) => {
      const otherId = r.fromConceptId === conceptId ? r.toConceptId : r.fromConceptId;
      const other = byId.get(otherId);
      return {
        id: r.id,
        relationType: r.relationType,
        direction: r.fromConceptId === conceptId ? "outgoing" : "incoming",
        note: r.note,
        otherConcept: other
          ? { id: other.id, term: other.term, slug: other.slug, status: other.status }
          : null,
        createdAt: r.createdAt ? r.createdAt.toISOString() : null,
      };
    }),
  });
});

// POST /admin/concepts/:id/relationships
// Create a relationship from this concept to another. 409 on duplicate.
router.post("/concepts/:id/relationships", async (req, res) => {
  const fromConceptId = req.params.id as string;
  const { toConceptId, relationType, note } = req.body as {
    toConceptId?: string;
    relationType?: string;
    note?: string;
  };
  if (!toConceptId?.trim()) {
    res.status(400).json({ error: "to_concept_id_required" });
    return;
  }
  if (toConceptId === fromConceptId) {
    res.status(400).json({ error: "cannot_relate_to_self" });
    return;
  }
  if (!relationType || !RELATION_TYPES.includes(relationType as RelationType)) {
    res.status(400).json({ error: "invalid_relation_type", allowed: RELATION_TYPES });
    return;
  }
  // Both concepts must exist
  const endpoints = await db
    .select({ id: conceptsTable.id })
    .from(conceptsTable)
    .where(inArray(conceptsTable.id, [fromConceptId, toConceptId.trim()]));
  if (endpoints.length !== 2) {
    res.status(404).json({ error: "concept_not_found" });
    return;
  }
  try {
    const [created] = await db
      .insert(conceptRelationshipsTable)
      .values({
        fromConceptId,
        toConceptId: toConceptId.trim(),
        relationType: relationType as RelationType,
        note: note?.trim() || null,
      })
      .returning();
    void syncConceptToVault(fromConceptId);
    res.status(201).json(created);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "relationship_already_exists" });
      return;
    }
    throw err;
  }
});

// DELETE /admin/concepts/relationships/:relationshipId
// Remove a curated relationship.
router.delete("/concepts/relationships/:relationshipId", async (req, res) => {
  const [deleted] = await db
    .delete(conceptRelationshipsTable)
    .where(eq(conceptRelationshipsTable.id, req.params.relationshipId as string))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "relationship_not_found" });
    return;
  }
  void syncConceptToVault(deleted.fromConceptId);
  res.json({ deleted: true });
});

// POST /admin/concepts/:id/restore
// Restore a quarantined concept back to draft for admin review.
router.post("/concepts/:id/restore", async (req, res) => {
  const [updated] = await db
    .update(conceptsTable)
    .set({ status: "draft", quarantineReason: null, updatedAt: new Date() })
    .where(
      and(
        eq(conceptsTable.id, req.params.id as string),
        eq(conceptsTable.status, "hidden"),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "concept_not_found_or_not_quarantined" });
    return;
  }
  void syncConceptToVault(updated.id);
  res.json(updated);
});

// POST /admin/concepts/:id/hide
// Suppress a concept (status → hidden).
router.post("/concepts/:id/hide", async (req, res) => {
  const [updated] = await db
    .update(conceptsTable)
    .set({ status: "hidden", updatedAt: new Date() })
    .where(eq(conceptsTable.id, req.params.id as string))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "concept_not_found" });
    return;
  }
  void syncConceptToVault(updated.id);
  res.json(updated);
});

// POST /admin/concepts/:id/merge
// Merge duplicate concepts: :id (source) is absorbed into targetConceptId —
// mentions re-pointed, term + aliases become target aliases, grounding
// sources move over, source row deleted, target article count recomputed.
router.post("/concepts/:id/merge", async (req, res) => {
  const { targetConceptId } = req.body as { targetConceptId?: string };
  if (!targetConceptId?.trim()) {
    res.status(400).json({ error: "target_concept_id_required" });
    return;
  }
  if (targetConceptId === req.params.id) {
    res.status(400).json({ error: "cannot_merge_into_self" });
    return;
  }
  const merged = await mergeConcepts(req.params.id as string, targetConceptId.trim());
  if (!merged) {
    res.status(404).json({ error: "concept_not_found" });
    return;
  }
  // The absorbed concept is hard-deleted — retire its vault doc immediately
  // (reconcile Pass 3 would eventually catch it) and re-sync the survivor.
  void deactivateConceptVaultDoc(req.params.id as string);
  void syncConceptToVault(merged.id);
  res.json(merged);
});

// POST /admin/concepts/:id/regen-wiki
// Re-resolve the Wikipedia page for a concept (admin-triggered, no disambiguation).
router.post("/concepts/:id/regen-wiki", async (req, res) => {
  const concept = await getConceptWithDetails(req.params.id as string);
  if (!concept) {
    res.status(404).json({ error: "concept_not_found" });
    return;
  }
  const page = await resolveWikipedia(concept.term);
  if (!page) {
    res.status(404).json({ error: "no_wiki_page_found" });
    return;
  }
  const [updated] = await db
    .update(conceptsTable)
    .set({
      wikiPageId: page.pageId,
      wikiUrl: page.url,
      wikiTitle: page.title,
      wikiExtract: page.extract,
      wikiRevId: page.revId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(conceptsTable.id, req.params.id as string))
    .returning();
  // Re-ingest into the Source Vault if this page/revision isn't there yet
  // (page-ID deduped + revision-change refresh inside the helper).
  void enqueueWikipediaInVault(page, concept.term);
  // Sync the concept's vault doc so the updated Wikipedia extract is immediately
  // reflected in draft LLM concept memory without waiting for the hourly cron.
  void syncConceptToVault(req.params.id as string);
  res.json(updated);
});

// ---------------------------------------------------------------------------
// Article scan — literal text search for an existing concept's term + aliases
// ---------------------------------------------------------------------------

// POST /admin/concepts/:id/scan-articles
// Scans ALL published, non-quarantined articles for the concept's term and any
// registered aliases. Creates article_concept_mentions rows wherever the term
// first appears in a paragraph block. Safe to re-run: existing mentions are
// skipped (onConflictDoNothing). Returns { scanned, matched, created, alreadyExisted }.
router.post("/concepts/:id/scan-articles", async (req, res) => {
  const [concept] = await db
    .select()
    .from(conceptsTable)
    .where(eq(conceptsTable.id, req.params.id as string))
    .limit(1);
  if (!concept) {
    res.status(404).json({ error: "concept_not_found" });
    return;
  }

  const aliases = await db
    .select({ alias: conceptAliasesTable.alias })
    .from(conceptAliasesTable)
    .where(eq(conceptAliasesTable.conceptId, concept.id));

  // All search strings: canonical term first, then aliases (longer first so
  // e.g. "NRE" doesn't get shadowed by a shorter alias that shares letters).
  const searchTerms = [concept.term, ...aliases.map((a) => a.alias)].sort(
    (a, b) => b.length - a.length,
  );

  // Load all published, non-quarantined articles
  const articles = await db
    .select({ id: articlesTable.id, body: articlesTable.body })
    .from(articlesTable)
    .where(and(eq(articlesTable.status, "published"), isNull(articlesTable.quarantinedAt)));

  // Build a set of article IDs that already have a mention for this concept
  const existingRows = await db
    .select({ articleId: articleConceptMentionsTable.articleId })
    .from(articleConceptMentionsTable)
    .where(eq(articleConceptMentionsTable.conceptId, concept.id));
  const alreadyMentioned = new Set(existingRows.map((r) => r.articleId));

  // Force mode: wipe existing mentions so they're re-evaluated with word-boundary
  // matching. Needed to correct over-linked concepts from a previous scan.
  const force = Boolean(req.body?.force);
  if (force && alreadyMentioned.size > 0) {
    await db
      .delete(articleConceptMentionsTable)
      .where(eq(articleConceptMentionsTable.conceptId, concept.id));
    alreadyMentioned.clear();
  }

  // Word-boundary patterns for each search term (longer first so a short alias
  // doesn't shadow a longer alias that contains the same prefix).
  const patterns = searchTerms.map((t) => ({
    term: t,
    re: new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
  }));

  let matched = 0;
  let created = 0;
  const alreadyExisted = alreadyMentioned.size;

  for (const article of articles) {
    if (alreadyMentioned.has(article.id)) {
      matched++;
      continue;
    }

    const blocks = (article.body ?? []) as Array<{ type: string; content: string }>;
    let foundIdx = -1;
    let matchedTerm = "";
    let foundContent = "";
    let tMatchPos = 0;

    outer: for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].type !== "paragraph") continue;
      for (const { term, re } of patterns) {
        const m = re.exec(blocks[i].content);
        if (m) {
          foundIdx = i;
          matchedTerm = term;
          foundContent = blocks[i].content;
          tMatchPos = m.index;
          break outer;
        }
      }
    }

    if (foundIdx === -1) continue;
    matched++;

    // Hashes (16-char sha256 prefix)
    const paragraphHash = createHash("sha256").update(foundContent).digest("hex").slice(0, 16);

    const sentStart = Math.max(0, foundContent.lastIndexOf(". ", tMatchPos) + 2);
    const sentEndRaw = foundContent.indexOf(". ", tMatchPos + matchedTerm.length);
    const sentEnd = sentEndRaw === -1 ? foundContent.length : sentEndRaw + 1;
    const sentence = foundContent.slice(sentStart, sentEnd).trim();
    const sentenceHash = createHash("sha256").update(sentence).digest("hex").slice(0, 16);

    const centre = tMatchPos + Math.floor(matchedTerm.length / 2);
    let rawSnippet = foundContent.slice(Math.max(0, centre - 120), Math.min(foundContent.length, centre + 120));
    // Trim to word boundaries so the snippet never starts/ends mid-word
    const snipStartSpace = rawSnippet.indexOf(" ");
    if (snipStartSpace > 0 && snipStartSpace < 25) rawSnippet = rawSnippet.slice(snipStartSpace + 1);
    if (!/[.!?]$/.test(rawSnippet)) {
      const snipEndSpace = rawSnippet.lastIndexOf(" ");
      if (snipEndSpace > rawSnippet.length - 25) rawSnippet = rawSnippet.slice(0, snipEndSpace);
    }
    const contextSnippet = rawSnippet;

    await db
      .insert(articleConceptMentionsTable)
      .values({
        articleId: article.id,
        conceptId: concept.id,
        matchedTerm,
        paragraphIndex: foundIdx,
        paragraphHash,
        sentenceHash,
        contextSnippet,
        confidence: 1.0,
      })
      .onConflictDoNothing();

    created++;
  }

  // Recompute article_count
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(articleConceptMentionsTable)
    .where(eq(articleConceptMentionsTable.conceptId, concept.id));
  await db
    .update(conceptsTable)
    .set({ articleCount: Number(countRow?.count ?? 0), updatedAt: new Date() })
    .where(eq(conceptsTable.id, concept.id));

  res.json({ scanned: articles.length, matched, created, alreadyExisted });
});

// ---------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------

// POST /admin/concepts/:id/aliases
// Add an alias to an existing concept.
router.post("/concepts/:id/aliases", async (req, res) => {
  const { alias, isPrimary } = req.body as { alias?: string; isPrimary?: boolean };
  if (!alias?.trim()) {
    res.status(400).json({ error: "alias_required" });
    return;
  }
  const [created] = await db
    .insert(conceptAliasesTable)
    .values({
      conceptId: req.params.id as string,
      alias: alias.trim().toLowerCase(),
      isPrimary: isPrimary ?? false,
    })
    .onConflictDoNothing()
    .returning();
  if (created) {
    void syncConceptToVault(req.params.id as string);
  }
  res.status(201).json(created ?? { skipped: true });
});

// DELETE /admin/concepts/:conceptId/aliases/:aliasId
router.delete("/concepts/:conceptId/aliases/:aliasId", async (req, res) => {
  const [deleted] = await db
    .delete(conceptAliasesTable)
    .where(
      and(
        eq(conceptAliasesTable.id, req.params.aliasId as string),
        eq(conceptAliasesTable.conceptId, req.params.conceptId as string),
      ),
    )
    .returning({ id: conceptAliasesTable.id });
  if (!deleted) {
    res.status(404).json({ error: "alias_not_found" });
    return;
  }
  void syncConceptToVault(req.params.conceptId as string);
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// Alias → concept back-links
// ---------------------------------------------------------------------------

/**
 * POST /admin/concepts/backfill-alias-links
 *
 * For every concept alias that matches another concept's canonical term,
 * ensure a `see_also` relationship exists between the two concepts so the
 * glossary detail page can render the alias as a clickable cross-link.
 *
 * Idempotent: skips pairs that already have ANY curated relationship.
 * Only creates see_also (distinct_from pairs are already created by the
 * alias-conflation audit).
 */
router.post("/concepts/backfill-alias-links", async (req, res) => {
  // Build an index: canonical term (lowercased) → concept id + slug.
  const allConcepts = await db
    .select({ id: conceptsTable.id, slug: conceptsTable.slug, term: conceptsTable.term })
    .from(conceptsTable)
    .where(eq(conceptsTable.status, "live"));

  const termToConceptId = new Map<string, string>();
  for (const c of allConcepts) {
    termToConceptId.set(c.term.toLowerCase().trim(), c.id);
  }

  // Load all aliases with their parent concept id.
  const allAliases = await db
    .select({ conceptId: conceptAliasesTable.conceptId, alias: conceptAliasesTable.alias })
    .from(conceptAliasesTable);

  // Load existing relationships to skip already-linked pairs.
  const existingRels = await db
    .select({
      fromConceptId: conceptRelationshipsTable.fromConceptId,
      toConceptId: conceptRelationshipsTable.toConceptId,
    })
    .from(conceptRelationshipsTable);

  const pairSet = new Set<string>();
  for (const r of existingRels) {
    pairSet.add(`${r.fromConceptId}:${r.toConceptId}`);
    pairSet.add(`${r.toConceptId}:${r.fromConceptId}`);
  }

  let created = 0;
  let skipped = 0;

  for (const { conceptId, alias } of allAliases) {
    const matchedId = termToConceptId.get(alias.toLowerCase().trim());
    if (!matchedId || matchedId === conceptId) {
      skipped++;
      continue;
    }
    if (pairSet.has(`${conceptId}:${matchedId}`)) {
      skipped++;
      continue;
    }

    // Create a see_also relationship from the alias-owner → matched concept.
    await db
      .insert(conceptRelationshipsTable)
      .values({
        fromConceptId: conceptId,
        toConceptId: matchedId,
        relationType: "see_also",
        note: "auto-linked: alias matches canonical term",
      })
      .onConflictDoNothing();

    pairSet.add(`${conceptId}:${matchedId}`);
    pairSet.add(`${matchedId}:${conceptId}`);
    created++;
  }

  res.json({ created, skipped });
});

// ---------------------------------------------------------------------------
// Share-card backfill
// ---------------------------------------------------------------------------

// DB-backed job key — state persists across restarts so the UI can detect
// "interrupted" (DB says running but heartbeat went stale after a deploy).
const SHARE_CARD_BACKFILL_JOB = "concept_share_card_backfill";
const SHARE_CARD_BACKFILL_TTL_MS = 5 * 60 * 1000; // 5-min heartbeat TTL

// GET /admin/concepts/backfill-share-cards/status
router.get("/concepts/backfill-share-cards/status", async (_req, res) => {
  const [[{ remaining }], jobRow] = await Promise.all([
    db
      .select({ remaining: sql<number>`count(*)::int` })
      .from(conceptsTable)
      .where(and(eq(conceptsTable.status, "live"), isNull(conceptsTable.shareImage))),
    getJobState(SHARE_CARD_BACKFILL_JOB),
  ]);
  const running = isJobRunning(jobRow, SHARE_CARD_BACKFILL_TTL_MS);
  const interrupted = !running && jobRow?.status === "running";
  const progress = (jobRow?.progress ?? {}) as Record<string, unknown>;
  res.json({
    running,
    interrupted,
    remaining,
    generated: Number(progress.generated ?? 0),
    failed: Number(progress.failed ?? 0),
    total: Number(progress.total ?? 0),
    startedAt: jobRow?.startedAt ?? null,
    finishedAt: interrupted ? null : (jobRow?.finishedAt ?? null),
  });
});

// POST /admin/concepts/backfill-share-cards/cancel
router.post("/concepts/backfill-share-cards/cancel", async (req, res) => {
  const cancelled = await requestJobCancel(SHARE_CARD_BACKFILL_JOB);
  if (!cancelled) {
    res.status(409).json({ error: "No share card backfill is running" });
    return;
  }
  req.log?.info("admin/concepts: share-card backfill cancel requested");
  res.json({ cancelRequested: true });
});

// POST /admin/concepts/backfill-share-cards
// Iterates all live concepts with no share_image and copies their CSS-captured
// card_image_url into share_image. No image generation — pure DB aliasing.
// Fire-and-forget — returns 202 immediately. Skips concepts already aliased.
router.post("/concepts/backfill-share-cards", async (req, res) => {
  const runId = await acquireJobLock(SHARE_CARD_BACKFILL_JOB, {
    ttlMs: SHARE_CARD_BACKFILL_TTL_MS,
    progress: { generated: 0, failed: 0, total: 0 },
  });
  if (!runId) {
    res.status(409).json({ error: "Share card backfill already running" });
    return;
  }
  res.status(202).json({ ok: true });

  req.log?.info({ adminEmail: req.session?.adminEmail }, "concepts/backfill-share-cards: start");

  void (async () => {
    try {
      // Copy the CSS-captured card (card_image_url) into share_image.
      // We never generate satori cards in bulk — only concepts that already
      // have a CSS snap get a share_image set here.
      const concepts = await db
        .select({ id: conceptsTable.id, cardImageUrl: conceptsTable.cardImageUrl })
        .from(conceptsTable)
        .where(
          and(
            eq(conceptsTable.status, "live"),
            isNull(conceptsTable.shareImage),
            isNotNull(conceptsTable.cardImageUrl),
          ),
        );

      let generated = 0;
      let failed = 0;
      const total = concepts.length;
      await heartbeatJob(SHARE_CARD_BACKFILL_JOB, runId, { generated, failed, total });

      for (const c of concepts) {
        if (await isCancelRequested(SHARE_CARD_BACKFILL_JOB)) {
          logger.info({ generated, failed }, "concepts/backfill-share-cards: cancelled");
          break;
        }
        try {
          await db
            .update(conceptsTable)
            .set({ shareImage: c.cardImageUrl })
            .where(eq(conceptsTable.id, c.id));
          generated++;
        } catch {
          failed++;
        }
        // Heartbeat every 25 items (pure DB ops, no delay).
        if ((generated + failed) % 25 === 0) {
          await heartbeatJob(SHARE_CARD_BACKFILL_JOB, runId, { generated, failed, total });
        }
      }
      logger.info({ generated, failed }, "concepts/backfill-share-cards: done");
      await finishJob(SHARE_CARD_BACKFILL_JOB, runId, "succeeded", {
        progress: { generated, failed, total },
      });
    } catch (err) {
      logger.error({ err }, "concepts/backfill-share-cards: error");
      await finishJob(SHARE_CARD_BACKFILL_JOB, runId, "failed", { error: String(err) });
    }
  })();
});

// ---------------------------------------------------------------------------
// Share-card rebuild (force-regenerate ALL live concept satori cards)
// ---------------------------------------------------------------------------

// DB-backed job key — same pattern as the backfill above so restarts are
// detectable via the stale-heartbeat "interrupted" flag in the status response.
const SHARE_CARD_REBUILD_JOB = "concept_share_card_rebuild";
const SHARE_CARD_REBUILD_TTL_MS = 5 * 60 * 1000; // 5-min heartbeat TTL

// GET /admin/concepts/rebuild-share-cards/status
router.get("/concepts/rebuild-share-cards/status", async (_req, res) => {
  const jobRow = await getJobState(SHARE_CARD_REBUILD_JOB);
  const running = isJobRunning(jobRow, SHARE_CARD_REBUILD_TTL_MS);
  const interrupted = !running && jobRow?.status === "running";
  const progress = (jobRow?.progress ?? {}) as Record<string, unknown>;
  res.json({
    running,
    interrupted,
    generated: Number(progress.generated ?? 0),
    failed: Number(progress.failed ?? 0),
    total: Number(progress.total ?? 0),
    startedAt: jobRow?.startedAt ?? null,
    finishedAt: interrupted ? null : (jobRow?.finishedAt ?? null),
  });
});

// POST /admin/concepts/rebuild-share-cards/cancel
router.post("/concepts/rebuild-share-cards/cancel", async (req, res) => {
  const cancelled = await requestJobCancel(SHARE_CARD_REBUILD_JOB);
  if (!cancelled) {
    res.status(409).json({ error: "No rebuild is running" });
    return;
  }
  req.log?.info("admin/concepts: rebuild-share-cards cancel requested");
  res.json({ cancelRequested: true });
});

// POST /admin/concepts/rebuild-share-cards
// Sweeps all live concepts: deletes any stored satori PNG from object storage
// and clears the share_image column. CSS cards are captured client-side from
// /admin/media-library/glossary — this route only cleans up old satori cards.
router.post("/concepts/rebuild-share-cards", async (req, res) => {
  const runId = await acquireJobLock(SHARE_CARD_REBUILD_JOB, {
    ttlMs: SHARE_CARD_REBUILD_TTL_MS,
    progress: { generated: 0, failed: 0, total: 0 },
  });
  if (!runId) {
    res.status(409).json({ error: "Rebuild already running" });
    return;
  }
  res.status(202).json({ ok: true });

  req.log?.info({ adminEmail: req.session?.adminEmail }, "concepts/rebuild-share-cards: start sweep-delete");

  void (async () => {
    try {
      const concepts = await db
        .select({
          id: conceptsTable.id,
          shareImage: conceptsTable.shareImage,
          cardImageUrl: conceptsTable.cardImageUrl,
        })
        .from(conceptsTable)
        .where(and(eq(conceptsTable.status, "live"), isNotNull(conceptsTable.shareImage)));

      let generated = 0;
      let failed = 0;
      const total = concepts.length;
      await heartbeatJob(SHARE_CARD_REBUILD_JOB, runId, { generated, failed, total });

      for (const concept of concepts) {
        if (await isCancelRequested(SHARE_CARD_REBUILD_JOB)) {
          logger.info({ cleared: generated, failed }, "concepts/rebuild-share-cards: cancelled");
          break;
        }
        try {
          // NEVER delete the object if it's the CSS-captured snap card — the
          // backfill aliases card_image_url into share_image, so deleting the
          // shared file here silently 404s the canonical card (data loss).
          // Only true satori-generated og:images (never "-snap.png", never
          // equal to card_image_url) are safe to remove from storage.
          const isAliasedSnap =
            concept.shareImage === concept.cardImageUrl ||
            (concept.shareImage?.endsWith("-snap.png") ?? false);
          if (!isAliasedSnap && concept.shareImage?.startsWith("/api/storage/public-objects/")) {
            const key = concept.shareImage.replace("/api/storage/public-objects/", "");
            await deletePublicObject(key).catch(() => {});
          }
          await db
            .update(conceptsTable)
            .set({ shareImage: null })
            .where(eq(conceptsTable.id, concept.id));
          generated++;
        } catch {
          failed++;
        }
        // Heartbeat every 10 items (storage deletes can be slow).
        if ((generated + failed) % 10 === 0) {
          await heartbeatJob(SHARE_CARD_REBUILD_JOB, runId, { generated, failed, total });
        }
      }
      logger.info({ cleared: generated, failed }, "concepts/rebuild-share-cards: done");
      await finishJob(SHARE_CARD_REBUILD_JOB, runId, "succeeded", {
        progress: { generated, failed, total },
      });
    } catch (err) {
      logger.error({ err }, "concepts/rebuild-share-cards: error");
      await finishJob(SHARE_CARD_REBUILD_JOB, runId, "failed", { error: String(err) });
    }
  })();
});

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

// GET /admin/concepts/:id/vault-documents
// Source Vault documents linked to this concept via deterministic
// source_concept_edges (Task #338), strongest edges first. Read-only —
// edges never affect evidence eligibility.
router.get("/concepts/:id/vault-documents", async (req, res) => {
  const [concept] = await db
    .select({ id: conceptsTable.id })
    .from(conceptsTable)
    .where(eq(conceptsTable.id, req.params.id as string))
    .limit(1);
  if (!concept) {
    res.status(404).json({ error: "concept_not_found" });
    return;
  }
  const rows = await db
    .select({
      edgeId: sourceConceptEdgesTable.id,
      confidence: sourceConceptEdgesTable.confidence,
      matchedSections: sourceConceptEdgesTable.matchedSections,
      taggedAt: sourceConceptEdgesTable.updatedAt,
      documentId: sourceDocumentsTable.id,
      title: sourceDocumentsTable.title,
      url: sourceDocumentsTable.url,
      domain: sourceDocumentsTable.domain,
      authorityTier: sourceDocumentsTable.authorityTier,
      status: sourceDocumentsTable.status,
      lifecycleStatus: sourceDocumentsTable.lifecycleStatus,
      evidenceEligible: sourceDocumentsTable.evidenceEligible,
      publishedAt: sourceDocumentsTable.publishedAt,
    })
    .from(sourceConceptEdgesTable)
    .innerJoin(
      sourceDocumentsTable,
      eq(sourceConceptEdgesTable.sourceDocumentId, sourceDocumentsTable.id),
    )
    .where(eq(sourceConceptEdgesTable.conceptId, req.params.id as string))
    .orderBy(desc(sourceConceptEdgesTable.confidence), sourceDocumentsTable.id);
  res.json({
    documents: rows.map((r) => ({
      ...r,
      taggedAt: r.taggedAt?.toISOString() ?? null,
      publishedAt: r.publishedAt?.toISOString() ?? null,
    })),
    total: rows.length,
  });
});

// GET /admin/concepts/:id/sources
// Source trail: every concept_sources row for this concept, with a vault-doc
// join for title/domain metadata. Ordered: wikipedia first, then vault by
// descending relevance score. Includes the claim_relevant flag so admins can
// audit which sources passed or failed the claim-relevance filter.
router.get("/concepts/:id/sources", async (req, res) => {
  const { id } = req.params;
  const [concept] = await db
    .select({ id: conceptsTable.id })
    .from(conceptsTable)
    .where(eq(conceptsTable.id, id as string))
    .limit(1);
  if (!concept) {
    res.status(404).json({ error: "concept_not_found" });
    return;
  }
  const rows = await db
    .select({
      id: conceptSourcesTable.id,
      sourceUrl: conceptSourcesTable.sourceUrl,
      sourceType: conceptSourcesTable.sourceType,
      relevanceScore: conceptSourcesTable.relevanceScore,
      claimRelevant: conceptSourcesTable.claimRelevant,
      createdAt: conceptSourcesTable.createdAt,
      docTitle: sourceDocumentsTable.title,
      docDomain: sourceDocumentsTable.domain,
      docAuthorityTier: sourceDocumentsTable.authorityTier,
      docLifecycleStatus: sourceDocumentsTable.lifecycleStatus,
    })
    .from(conceptSourcesTable)
    .leftJoin(
      sourceDocumentsTable,
      and(
        eq(sourceDocumentsTable.url, conceptSourcesTable.sourceUrl),
        eq(conceptSourcesTable.sourceType, "vault"),
      ),
    )
    .where(eq(conceptSourcesTable.conceptId, id as string))
    .orderBy(conceptSourcesTable.sourceType, desc(conceptSourcesTable.relevanceScore));

  res.json({
    sources: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
    total: rows.length,
  });
});

// PATCH /admin/concepts/:id/sources/:sourceId
// Override the claim_relevant flag on a single concept_sources row.
// Allows admins to flip a false-positive "filtered" source back to relevant.
router.patch("/concepts/:id/sources/:sourceId", async (req, res) => {
  const { id, sourceId } = req.params;
  const { claimRelevant } = req.body as { claimRelevant?: boolean };
  if (typeof claimRelevant !== "boolean") {
    res.status(400).json({ error: "claimRelevant_boolean_required" });
    return;
  }
  const [updated] = await db
    .update(conceptSourcesTable)
    .set({ claimRelevant })
    .where(
      and(
        eq(conceptSourcesTable.id, sourceId as string),
        eq(conceptSourcesTable.conceptId, id as string),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "source_not_found" });
    return;
  }
  res.json({ id: updated.id, claimRelevant: updated.claimRelevant });
});

// POST /admin/concepts/:id/recheck-sources
// Re-run the claim-relevance filter on this concept's stored concept_sources
// rows and update claim_relevant on each. Returns { checked, removed }.
router.post("/concepts/:id/recheck-sources", async (req, res) => {
  const { id } = req.params;
  const [concept] = await db
    .select({ id: conceptsTable.id })
    .from(conceptsTable)
    .where(eq(conceptsTable.id, id as string))
    .limit(1);
  if (!concept) {
    res.status(404).json({ error: "concept_not_found" });
    return;
  }
  const result = await recheckConceptSources(id as string);
  res.json(result);
});

// GET /admin/concepts/:id/beat-affinities
// This concept's weighted beat profile (blended weight + component signals),
// strongest beat first, with the bridge flag.
router.get("/concepts/:id/beat-affinities", async (req, res) => {
  const [concept] = await db
    .select({ id: conceptsTable.id })
    .from(conceptsTable)
    .where(eq(conceptsTable.id, req.params.id as string))
    .limit(1);
  if (!concept) {
    res.status(404).json({ error: "concept_not_found" });
    return;
  }
  res.json(await getConceptBeatProfile(req.params.id as string));
});

// GET /admin/concepts/:id/mentions
// List all article mentions for a concept.
router.get("/concepts/:id/mentions", async (req, res) => {
  const rows = await db
    .select()
    .from(articleConceptMentionsTable)
    .where(eq(articleConceptMentionsTable.conceptId, req.params.id as string))
    .orderBy(desc(articleConceptMentionsTable.createdAt));
  res.json({ mentions: rows });
});

// DELETE /admin/concepts/mentions/:mentionId
// Remove a specific mention.
router.delete("/concepts/mentions/:mentionId", async (req, res) => {
  const [deleted] = await db
    .delete(articleConceptMentionsTable)
    .where(eq(articleConceptMentionsTable.id, req.params.mentionId as string))
    .returning({ id: articleConceptMentionsTable.id });
  if (!deleted) {
    res.status(404).json({ error: "mention_not_found" });
    return;
  }
  res.json({ deleted: true });
});

export default router;
