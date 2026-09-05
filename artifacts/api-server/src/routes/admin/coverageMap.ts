/**
 * Admin — Living Coverage Map routes (Task #345)
 *
 * All routes require requireAdmin + requireTrustedOrigin (applied at router
 * level in routes/index.ts). Zero AI calls — all data is pre-computed by
 * the daily coverage map pass (coverageMapJob.ts).
 */

import { Router, type IRouter } from "express";
import { eq, and, inArray, desc, asc, sql } from "drizzle-orm";
import {
  db,
  coverageMapItemsTable,
  conceptsTable,
  type CoverageClassification,
  type EditorialState,
  type RecommendedAction,
  COVERAGE_CLASSIFICATIONS,
  EDITORIAL_STATES,
} from "@workspace/db";
import {
  startCoverageMapPass,
  isCoverageMapPassRunning,
  promoteCoverageMapItemToIdea,
} from "../../services/coverageMapJob";
import { recommendAction } from "../../services/coverageMapScore";
import { z } from "zod/v4";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// GET /admin/coverage-map/status
// ---------------------------------------------------------------------------

router.get("/coverage-map/status", async (req, res) => {
  try {
    const running = isCoverageMapPassRunning();

    const counts = await db
      .select({
        classification: coverageMapItemsTable.classification,
        count: sql<number>`count(*)::int`,
      })
      .from(coverageMapItemsTable)
      // Hidden concepts must not inflate totals between prune passes.
      .innerJoin(conceptsTable, eq(conceptsTable.id, coverageMapItemsTable.conceptId))
      .where(eq(conceptsTable.status, "live"))
      .groupBy(coverageMapItemsTable.classification);

    const byClassification: Record<string, number> = {};
    let total = 0;
    for (const row of counts) {
      byClassification[row.classification] = Number(row.count);
      total += Number(row.count);
    }

    const [latest] = await db
      .select({ calculatedAt: coverageMapItemsTable.calculatedAt })
      .from(coverageMapItemsTable)
      .orderBy(desc(coverageMapItemsTable.calculatedAt))
      .limit(1);

    return res.json({
      running,
      total,
      byClassification,
      lastCalculatedAt: latest?.calculatedAt ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "coverage-map: GET /status failed");
    return res.status(500).json({ error: "Internal error" });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/coverage-map/recalculate
// ---------------------------------------------------------------------------

router.post("/coverage-map/recalculate", async (req, res) => {
  if (isCoverageMapPassRunning()) {
    return res.status(409).json({ error: "Coverage map pass already running" });
  }
  const { started } = startCoverageMapPass();
  return res.status(202).json({ started });
});

// ---------------------------------------------------------------------------
// GET /admin/coverage-map/items
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  classification: z
    .enum([...COVERAGE_CLASSIFICATIONS] as [CoverageClassification, ...CoverageClassification[]])
    .optional(),
  editorialState: z
    .enum([...EDITORIAL_STATES] as [EditorialState, ...EditorialState[]])
    .optional(),
  sort: z.enum(["opportunity", "evidence", "coverage", "updated"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

router.get("/coverage-map/items", async (req, res) => {
  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: z.prettifyError(parsed.error) });
    }
    const {
      classification,
      editorialState,
      sort = "opportunity",
      order = "desc",
      limit = 50,
      offset = 0,
    } = parsed.data;

    // Hidden/retired concepts must never surface in rankings — the daily pass
    // also prunes their rows, but filter at query time so a concept hidden
    // between passes disappears immediately.
    const filters = [eq(conceptsTable.status, "live")];
    if (classification) filters.push(eq(coverageMapItemsTable.classification, classification));
    if (editorialState) filters.push(eq(coverageMapItemsTable.editorialState, editorialState));

    const sortMap = {
      opportunity: coverageMapItemsTable.opportunityScore,
      evidence: coverageMapItemsTable.evidenceStrength,
      coverage: coverageMapItemsTable.coverageDepth,
      updated: coverageMapItemsTable.calculatedAt,
    };
    const sortCol = sortMap[sort];
    const orderFn = order === "asc" ? asc : desc;

    const rows = await db
      .select({
        id: coverageMapItemsTable.id,
        conceptId: coverageMapItemsTable.conceptId,
        term: conceptsTable.term,
        slug: conceptsTable.slug,
        classification: coverageMapItemsTable.classification,
        opportunityScore: coverageMapItemsTable.opportunityScore,
        evidenceStrength: coverageMapItemsTable.evidenceStrength,
        sourceDiversity: coverageMapItemsTable.sourceDiversity,
        evidenceFreshness: coverageMapItemsTable.evidenceFreshness,
        coverageDepth: coverageMapItemsTable.coverageDepth,
        articleUniqueness: coverageMapItemsTable.articleUniqueness,
        readerInterest: coverageMapItemsTable.readerInterest,
        updateUrgency: coverageMapItemsTable.updateUrgency,
        saturation: coverageMapItemsTable.saturation,
        recommendedAction: coverageMapItemsTable.recommendedAction,
        editorialState: coverageMapItemsTable.editorialState,
        editorialNote: coverageMapItemsTable.editorialNote,
        ideaId: coverageMapItemsTable.ideaId,
        radarSuggestionId: coverageMapItemsTable.radarSuggestionId,
        calculatedAt: coverageMapItemsTable.calculatedAt,
      })
      .from(coverageMapItemsTable)
      .innerJoin(conceptsTable, eq(conceptsTable.id, coverageMapItemsTable.conceptId))
      .where(filters.length > 0 ? and(...(filters as [typeof filters[0], ...typeof filters])) : undefined)
      .orderBy(orderFn(sortCol))
      .limit(limit)
      .offset(offset);

    const [countRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(coverageMapItemsTable)
      .innerJoin(conceptsTable, eq(conceptsTable.id, coverageMapItemsTable.conceptId))
      .where(filters.length > 0 ? and(...(filters as [typeof filters[0], ...typeof filters])) : undefined);

    return res.json({
      items: rows,
      total: Number(countRow?.total ?? 0),
      limit,
      offset,
    });
  } catch (err) {
    req.log.error({ err }, "coverage-map: GET /items failed");
    return res.status(500).json({ error: "Internal error" });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/coverage-map/items/:id
// ---------------------------------------------------------------------------

router.get("/coverage-map/items/:id", async (req, res) => {
  try {
    const [row] = await db
      .select({
        id: coverageMapItemsTable.id,
        conceptId: coverageMapItemsTable.conceptId,
        term: conceptsTable.term,
        slug: conceptsTable.slug,
        classification: coverageMapItemsTable.classification,
        opportunityScore: coverageMapItemsTable.opportunityScore,
        evidenceStrength: coverageMapItemsTable.evidenceStrength,
        sourceDiversity: coverageMapItemsTable.sourceDiversity,
        evidenceFreshness: coverageMapItemsTable.evidenceFreshness,
        coverageDepth: coverageMapItemsTable.coverageDepth,
        articleUniqueness: coverageMapItemsTable.articleUniqueness,
        readerInterest: coverageMapItemsTable.readerInterest,
        updateUrgency: coverageMapItemsTable.updateUrgency,
        saturation: coverageMapItemsTable.saturation,
        recommendedAction: coverageMapItemsTable.recommendedAction,
        editorialState: coverageMapItemsTable.editorialState,
        editorialNote: coverageMapItemsTable.editorialNote,
        ideaId: coverageMapItemsTable.ideaId,
        radarSuggestionId: coverageMapItemsTable.radarSuggestionId,
        scoreBreakdown: coverageMapItemsTable.scoreBreakdown,
        provenanceJson: coverageMapItemsTable.provenanceJson,
        inputFingerprint: coverageMapItemsTable.inputFingerprint,
        calculatedAt: coverageMapItemsTable.calculatedAt,
        updatedAt: coverageMapItemsTable.updatedAt,
      })
      .from(coverageMapItemsTable)
      .innerJoin(conceptsTable, eq(conceptsTable.id, coverageMapItemsTable.conceptId))
      .where(eq(coverageMapItemsTable.id, req.params.id!))
      .limit(1);

    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json({ item: row });
  } catch (err) {
    req.log.error({ err }, "coverage-map: GET /items/:id failed");
    return res.status(500).json({ error: "Internal error" });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/coverage-map/items/:id/promote
// ---------------------------------------------------------------------------

router.post("/coverage-map/items/:id/promote", async (req, res) => {
  try {
    const result = await promoteCoverageMapItemToIdea(req.params.id!);
    return res.status(201).json(result);
  } catch (err: any) {
    if (err?.message?.includes("already promoted")) {
      return res.status(409).json({ error: err.message });
    }
    if (err?.message?.includes("not found")) {
      return res.status(404).json({ error: err.message });
    }
    if (
      err?.message?.includes("no primary beat") ||
      err?.message?.includes("no author covers")
    ) {
      return res.status(422).json({ error: err.message });
    }
    req.log.error({ err }, "coverage-map: POST /items/:id/promote failed");
    return res.status(500).json({ error: "Internal error" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /admin/coverage-map/items/:id/editorial-state
// ---------------------------------------------------------------------------

const editorialStateSchema = z.object({
  editorialState: z.enum([...EDITORIAL_STATES] as [EditorialState, ...EditorialState[]]),
  editorialNote: z.string().max(500).optional(),
});

router.patch("/coverage-map/items/:id/editorial-state", async (req, res) => {
  try {
    const parsed = editorialStateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: z.prettifyError(parsed.error) });
    }
    const { editorialState, editorialNote } = parsed.data;

    // Editorial state drives recommendAction (e.g. "intentionally complete"
    // must stop reading "create foundational article"), so recompute the
    // recommendation from the stored scores in the same update — the daily
    // pass would otherwise skip the row until its evidence inputs change.
    const [row] = await db
      .select({
        classification: coverageMapItemsTable.classification,
        evidenceStrength: coverageMapItemsTable.evidenceStrength,
        sourceDiversity: coverageMapItemsTable.sourceDiversity,
        updateUrgency: coverageMapItemsTable.updateUrgency,
        saturation: coverageMapItemsTable.saturation,
        // Raw inputs live inside the stored breakdown/provenance JSON — the
        // table has no dedicated columns for them.
        scoreBreakdown: coverageMapItemsTable.scoreBreakdown,
        provenanceJson: coverageMapItemsTable.provenanceJson,
      })
      .from(coverageMapItemsTable)
      .where(eq(coverageMapItemsTable.id, req.params.id!));

    if (!row) return res.status(404).json({ error: "Not found" });

    const recommendedAction = recommendAction(
      row.classification,
      {
        evidenceStrength: row.evidenceStrength,
        sourceDiversity: row.sourceDiversity,
        updateUrgency: row.updateUrgency,
        saturation: row.saturation,
      },
      {
        retractedLinkedCount: row.scoreBreakdown?.inputs?.retractedLinkedCount ?? 0,
        primaryBeatSlug: row.provenanceJson?.primaryBeatSlug ?? null,
        secondaryBeatSlugs: row.provenanceJson?.secondaryBeatSlugs ?? [],
        centralArticleCount: row.scoreBreakdown?.inputs?.centralArticleCount ?? 0,
      },
      editorialState,
    );

    const [updated] = await db
      .update(coverageMapItemsTable)
      .set({
        editorialState,
        // Omitted field = keep the existing note; explicit empty/blank = clear.
        ...(editorialNote !== undefined
          ? { editorialNote: editorialNote.trim() ? editorialNote.trim() : null }
          : {}),
        recommendedAction,
        updatedAt: new Date(),
      })
      .where(eq(coverageMapItemsTable.id, req.params.id!))
      .returning({
        id: coverageMapItemsTable.id,
        editorialState: coverageMapItemsTable.editorialState,
        recommendedAction: coverageMapItemsTable.recommendedAction,
      });

    if (!updated) return res.status(404).json({ error: "Not found" });
    return res.json({
      id: updated.id,
      editorialState: updated.editorialState,
      recommendedAction: updated.recommendedAction,
    });
  } catch (err) {
    req.log.error({ err }, "coverage-map: PATCH /items/:id/editorial-state failed");
    return res.status(500).json({ error: "Internal error" });
  }
});

export default router;
