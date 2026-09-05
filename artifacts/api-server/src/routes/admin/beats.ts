import { Router, type IRouter } from "express";
import { db, beatsTable, authorsTable, articlesTable } from "@workspace/db";
import { eq, sql, count, asc } from "drizzle-orm";
import { z } from "zod/v4";
import { reorderBeats } from "../../services/beats";
import { generateAndStoreBeatHeroImage } from "../../services/heroImage";

const router: IRouter = Router();

const slugRe = /^[a-z0-9-]+$/;

const createSchema = z.object({
  slug: z.string().min(1).regex(slugRe, "Slug must be kebab-case (a-z, 0-9, -)"),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  seoDescription: z.string().nullable().optional(),
  slant: z.string().nullable().optional(),
});
const updateSchema = z.object({
  slug: z.string().min(1).regex(slugRe).optional(),
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  seoDescription: z.string().nullable().optional(),
  slant: z.string().nullable().optional(),
});

// List beats with usage counts so the admin UI can warn before deletion and
// give a quick "where is this used" view.
router.get("/", async (_req, res) => {
  const rows = await db.select().from(beatsTable).orderBy(asc(beatsTable.name));
  // Count authors using each beat as primary, as sub-beat, and articles
  // tagged with the beat. One pass each — cheap on a small table.
  const primaryCounts = await db
    .select({ slug: authorsTable.categorySlug, n: count().as("n") })
    .from(authorsTable)
    .groupBy(authorsTable.categorySlug);
  const articleCounts = await db
    .select({ slug: articlesTable.categorySlug, n: count().as("n") })
    .from(articlesTable)
    .groupBy(articlesTable.categorySlug);
  const subBeatRows = await db
    .select({ subBeats: authorsTable.subBeats })
    .from(authorsTable);

  const pMap = new Map(primaryCounts.map((r) => [r.slug, Number(r.n)]));
  const aMap = new Map(articleCounts.map((r) => [r.slug, Number(r.n)]));
  const sMap = new Map<string, number>();
  for (const row of subBeatRows) {
    for (const slug of row.subBeats ?? []) {
      sMap.set(slug, (sMap.get(slug) ?? 0) + 1);
    }
  }

  const items = rows.map((b) => ({
    ...b,
    usage: {
      authorsPrimary: pMap.get(b.slug) ?? 0,
      authorsSubBeat: sMap.get(b.slug) ?? 0,
      articles: aMap.get(b.slug) ?? 0,
    },
  }));
  res.json({ items });
  return;
});

router.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error }); return; }
  const existing = await db.select({ id: beatsTable.id }).from(beatsTable).where(eq(beatsTable.slug, parsed.data.slug)).limit(1);
  if (existing.length > 0) { res.status(409).json({ error: "A beat with that slug already exists." }); return; }
  // Append new beats to the end of the display order so the admin's curated
  // ordering isn't disturbed by a creation.
  const [maxRow] = await db.select({ m: sql<number>`COALESCE(MAX(${beatsTable.sortOrder}), -1)` }).from(beatsTable);
  const nextOrder = Number(maxRow?.m ?? -1) + 1;
  const [created] = await db.insert(beatsTable).values({ ...parsed.data, sortOrder: nextOrder }).returning();
  res.status(201).json(created);
  return;
});

// Reorder beats by accepting a fully-specified list of beat ids in the desired
// display order. Any beats not present in the payload are pushed to the end in
// their existing relative order so a partial payload can never silently drop
// or duplicate rows.
const reorderSchema = z.object({ ids: z.array(z.string().uuid()).min(1) });
router.post("/reorder", async (req, res) => {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error }); return; }
  const items = await reorderBeats(parsed.data.ids);
  res.json({ items });
  return;
});

router.patch("/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error }); return; }
  // All beat-side and dependent-row writes happen in a single transaction so a
  // mid-flight failure can never leave authors/articles pointing at a slug the
  // beats table no longer has (or vice versa).
  try {
    const updated = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(beatsTable).where(eq(beatsTable.id, req.params.id)).limit(1);
      if (!current) {
        const e = new Error("not_found"); (e as Error & { httpStatus?: number }).httpStatus = 404; throw e;
      }
      if (parsed.data.slug && parsed.data.slug !== current.slug) {
        const dupe = await tx.select({ id: beatsTable.id }).from(beatsTable).where(eq(beatsTable.slug, parsed.data.slug)).limit(1);
        if (dupe.length > 0) {
          const e = new Error("slug_taken"); (e as Error & { httpStatus?: number }).httpStatus = 409; throw e;
        }
      }
      const [row] = await tx
        .update(beatsTable)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(beatsTable.id, req.params.id))
        .returning();
      if (!row) {
        const e = new Error("not_found"); (e as Error & { httpStatus?: number }).httpStatus = 404; throw e;
      }

      // Cascade rename to dependent rows so display names stay consistent and
      // slug-based filtering keeps working.
      if (parsed.data.slug && parsed.data.slug !== current.slug) {
        await tx.update(authorsTable).set({ categorySlug: parsed.data.slug }).where(eq(authorsTable.categorySlug, current.slug));
        await tx.update(articlesTable).set({ categorySlug: parsed.data.slug }).where(eq(articlesTable.categorySlug, current.slug));
        await tx.execute(sql`
          UPDATE authors
          SET sub_beats = (
            SELECT COALESCE(jsonb_agg(CASE WHEN value = ${current.slug} THEN ${parsed.data.slug} ELSE value END), '[]'::jsonb)
            FROM jsonb_array_elements_text(sub_beats) AS t(value)
          )
          WHERE sub_beats @> to_jsonb(ARRAY[${current.slug}]::text[])
        `);
      }
      if (parsed.data.name && parsed.data.name !== current.name) {
        const useSlug = parsed.data.slug ?? current.slug;
        await tx.update(authorsTable).set({ category: parsed.data.name }).where(eq(authorsTable.categorySlug, useSlug));
        await tx.update(articlesTable).set({ category: parsed.data.name }).where(eq(articlesTable.categorySlug, useSlug));
      }
      return row;
    });
    res.json(updated);
    return;
  } catch (e) {
    const status = (e as Error & { httpStatus?: number }).httpStatus;
    if (status === 404) { res.status(404).json({ error: "Not found" }); return; }
    if (status === 409) { res.status(409).json({ error: "A beat with that slug already exists." }); return; }
    throw e;
  }
});

// Regenerate (or generate for the first time) an AI hero image for a beat.
// Mirrors POST /admin/articles/:id/regenerate-image: generation runs
// synchronously, a generation failure surfaces a 502 so the admin UI can show
// a clear error instead of silently doing nothing.
router.post("/:id/regenerate-image", async (req, res) => {
  const [existing] = await db.select().from(beatsTable).where(eq(beatsTable.id, req.params.id)).limit(1);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  let heroImageUrl: string;
  try {
    heroImageUrl = await generateAndStoreBeatHeroImage({
      name: existing.name,
      description: existing.description,
      slant: existing.slant,
      slugHint: existing.slug,
    });
  } catch (err) {
    req.log.error({ err, slug: existing.slug }, "Beat hero image regeneration failed");
    res.status(502).json({ error: "Image generation failed", message: err instanceof Error ? err.message : String(err) });
    return;
  }
  const [item] = await db
    .update(beatsTable)
    .set({ heroImageUrl, updatedAt: new Date() })
    .where(eq(beatsTable.id, req.params.id))
    .returning();
  res.json(item);
  return;
});

router.delete("/:id", async (req, res) => {
  const [current] = await db.select().from(beatsTable).where(eq(beatsTable.id, req.params.id)).limit(1);
  if (!current) { res.status(404).json({ error: "Not found" }); return; }

  const [{ n: primaryN }] = await db.select({ n: count() }).from(authorsTable).where(eq(authorsTable.categorySlug, current.slug));
  const [{ n: articleN }] = await db.select({ n: count() }).from(articlesTable).where(eq(articlesTable.categorySlug, current.slug));
  const subAuthors = await db
    .select({ id: authorsTable.id })
    .from(authorsTable)
    .where(sql`${authorsTable.subBeats} @> to_jsonb(ARRAY[${current.slug}]::text[])`);
  if (Number(primaryN) > 0 || Number(articleN) > 0 || subAuthors.length > 0) {
    res.status(409).json({
      error: "Beat is in use — reassign the authors and articles first.",
      usage: {
        authorsPrimary: Number(primaryN),
        authorsSubBeat: subAuthors.length,
        articles: Number(articleN),
      },
    });
    return;
  }
  await db.delete(beatsTable).where(eq(beatsTable.id, req.params.id));
  res.status(204).end();
  return;
});

export default router;
