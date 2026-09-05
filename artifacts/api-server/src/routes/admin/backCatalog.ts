import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  harvestBackCatalog,
  getHarvestStats,
  listArticleSources,
  type HarvestArticleStatus,
} from "../../services/backCatalogHarvest";

// --- Back Catalog Source Harvest admin API (Task #228) -------------------
// Read-only stats + results table, plus a POST that scans a bounded batch of
// article bodies for outbound source links. The scan is DB-only and free (no
// AI, no web_search, no fetching) — it reuses the existing classify + enqueue/
// record plumbing. `dryRun` computes the outcome without writing anything.

const router: IRouter = Router();

const statusEnum = z.enum(["draft", "scheduled", "published", "all"]);

router.get("/back-catalog/stats", async (req, res) => {
  const parsed = statusEnum.safeParse(req.query.status ?? "published");
  const status: HarvestArticleStatus = parsed.success ? parsed.data : "published";
  res.json(await getHarvestStats(status));
});

router.get("/back-catalog/sources", async (req, res) => {
  const limit = Number(req.query.limit);
  const items = await listArticleSources(Number.isFinite(limit) ? limit : 100);
  res.json({ items });
});

const harvestSchema = z.object({
  dryRun: z.boolean().optional(),
  batchSize: z.number().int().min(1).max(25).optional(),
  dateFrom: z.string().nullable().optional(),
  dateTo: z.string().nullable().optional(),
  status: statusEnum.optional(),
});

router.post("/back-catalog/harvest", async (req, res) => {
  const parsed = harvestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  try {
    const report = await harvestBackCatalog({
      dryRun: parsed.data.dryRun,
      batchSize: parsed.data.batchSize,
      dateFrom: parsed.data.dateFrom,
      dateTo: parsed.data.dateTo,
      status: parsed.data.status,
    });
    res.json(report);
  } catch (e) {
    req.log?.error({ err: e }, "back-catalog: harvest failed");
    res.status(500).json({ error: "internal", message: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
