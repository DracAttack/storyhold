import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import {
  listFeeds,
  createFeed,
  updateFeed,
  deleteFeed,
  pollFeedNow,
} from "../../services/feedWatcher";

const router: IRouter = Router();

// Poll cadence bounds: at most every 5 minutes, at least weekly. Matches the
// OpenAPI CreateSourceFeedInput/UpdateSourceFeedInput schema.
const pollIntervalMinutes = z.number().int().min(5).max(10080);

// Informational-only purpose label (Task #231). Never affects routing/scoring.
const purpose = z.enum([
  "primary",
  "trend_sensor",
  "idea_scout",
  "research_preprint",
  "official_record",
]);

// Keyword-filter terms: trimmed, non-empty, capped so a stray paste can't bloat
// the row. Empty include list = allow all; exclude wins over include.
const filterTerms = z.array(z.string().trim().min(1).max(200)).max(100);

const createSchema = z.object({
  url: z.string().min(1).url("Must be a valid URL"),
  title: z.string().nullish(),
  beatSlug: z.string().min(1),
  subBeats: z.array(z.string()).optional(),
  filterIncludeTerms: filterTerms.optional(),
  filterExcludeTerms: filterTerms.optional(),
  enabled: z.boolean().optional(),
  pollIntervalMinutes: pollIntervalMinutes.optional(),
  purpose: purpose.nullish(),
});

const updateSchema = z.object({
  title: z.string().nullish(),
  beatSlug: z.string().min(1).optional(),
  subBeats: z.array(z.string()).optional(),
  filterIncludeTerms: filterTerms.optional(),
  filterExcludeTerms: filterTerms.optional(),
  enabled: z.boolean().optional(),
  pollIntervalMinutes: pollIntervalMinutes.optional(),
  purpose: purpose.nullish(),
});

router.get("/feeds", async (_req, res) => {
  res.json({ items: await listFeeds() });
});

router.post("/feeds", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error });
    return;
  }
  try {
    const feed = await createFeed({
      url: parsed.data.url,
      title: parsed.data.title ?? null,
      beatSlug: parsed.data.beatSlug,
      subBeats: parsed.data.subBeats,
      filterIncludeTerms: parsed.data.filterIncludeTerms,
      filterExcludeTerms: parsed.data.filterExcludeTerms,
      enabled: parsed.data.enabled,
      pollIntervalMinutes: parsed.data.pollIntervalMinutes,
      purpose: parsed.data.purpose ?? null,
    });
    res.status(201).json(feed);
  } catch (e: unknown) {
    // Unique-URL violation → clean 409 (a feed can't be registered twice).
    if ((e as { code?: string })?.code === "23505") {
      res.status(409).json({ error: "A feed with this URL already exists." });
      return;
    }
    throw e;
  }
});

router.patch("/feeds/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error });
    return;
  }
  const data = parsed.data;
  const patch: Parameters<typeof updateFeed>[1] = {};
  if (data.title !== undefined) patch.title = data.title;
  if (data.beatSlug !== undefined) patch.beatSlug = data.beatSlug;
  if (data.subBeats !== undefined) patch.subBeats = data.subBeats;
  if (data.filterIncludeTerms !== undefined) patch.filterIncludeTerms = data.filterIncludeTerms;
  if (data.filterExcludeTerms !== undefined) patch.filterExcludeTerms = data.filterExcludeTerms;
  if (data.enabled !== undefined) patch.enabled = data.enabled;
  if (data.pollIntervalMinutes !== undefined) patch.pollIntervalMinutes = data.pollIntervalMinutes;
  if (data.purpose !== undefined) patch.purpose = data.purpose;
  try {
    const feed = await updateFeed(req.params.id, patch);
    if (!feed) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(feed);
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === "23505") {
      res.status(409).json({ error: "A feed with this URL already exists." });
      return;
    }
    throw e;
  }
});

router.delete("/feeds/:id", async (req, res) => {
  const deleted = await deleteFeed(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ deleted: true });
});

router.post("/feeds/:id/poll", async (req, res) => {
  const outcome = await pollFeedNow(req.params.id);
  if (!outcome) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(outcome);
});

export default router;
