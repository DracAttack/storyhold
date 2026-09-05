import { Router, type IRouter } from "express";
import { db, utmPresetsTable } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";

const router: IRouter = Router();

const createSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  medium: z.string().min(1),
  campaign: z.string().min(1),
});

// Shared UTM presets for the admin link builder. These live server-side (not in
// one browser's localStorage) so every editor — and the same person on another
// device — sees and reuses the same list.
router.get("/utm-presets", async (_req, res) => {
  const rows = await db.select().from(utmPresetsTable).orderBy(desc(utmPresetsTable.createdAt));
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      source: r.source,
      medium: r.medium,
      campaign: r.campaign,
      createdAt: r.createdAt.toISOString(),
    })),
  });
  return;
});

router.post("/utm-presets", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error });
    return;
  }
  const name = parsed.data.name.trim();
  const source = parsed.data.source.trim();
  const medium = parsed.data.medium.trim();
  const campaign = parsed.data.campaign.trim();
  if (!name || !source || !medium || !campaign) {
    res.status(400).json({ error: "All fields are required." });
    return;
  }
  // Treat a preset name as a unique key (case-insensitive): re-saving an
  // existing name overwrites it rather than piling up duplicates, matching the
  // previous localStorage behavior.
  const created = await db.transaction(async (tx) => {
    await tx
      .delete(utmPresetsTable)
      .where(sql`lower(${utmPresetsTable.name}) = ${name.toLowerCase()}`);
    const [row] = await tx
      .insert(utmPresetsTable)
      .values({ name, source, medium, campaign })
      .returning();
    return row;
  });
  res.status(201).json({
    id: created.id,
    name: created.name,
    source: created.source,
    medium: created.medium,
    campaign: created.campaign,
    createdAt: created.createdAt.toISOString(),
  });
  return;
});

router.delete("/utm-presets/:id", async (req, res) => {
  const [deleted] = await db
    .delete(utmPresetsTable)
    .where(eq(utmPresetsTable.id, req.params.id))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).end();
  return;
});

export default router;
