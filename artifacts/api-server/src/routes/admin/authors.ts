import { Router, type IRouter } from "express";
import { db, authorsTable, authorSlugRedirectsTable, beatsTable, articlesTable } from "@workspace/db";
import { eq, sql, count } from "drizzle-orm";
import { z } from "zod/v4";
import { generateAndStoreAuthorAvatar } from "../../services/heroImage";
import { pickRotatedWeekday, pickRandomHour, pickRandomDayOfMonth, cadenceUsesWeekday } from "../../services/scheduling";
import { reslotAuthorSchedule } from "../../services/articles";
import { normalizeSubBeats } from "../../services/beatAdjacency";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

function slugifyForFilename(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "author"
  );
}

const generateAvatarSchema = z.object({
  name: z.string().min(1),
  bio: z.string().optional().nullable(),
  voicePrompt: z.string().optional().nullable(),
  tone: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  slugHint: z.string().optional(),
});

router.post("/generate-avatar", async (req, res) => {
  const parsed = generateAvatarSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error });
    return;
  }
  try {
    const url = await generateAndStoreAuthorAvatar({
      name: parsed.data.name,
      bio: parsed.data.bio ?? null,
      voicePrompt: parsed.data.voicePrompt ?? null,
      tone: parsed.data.tone ?? null,
      category: parsed.data.category ?? null,
      slugHint: slugifyForFilename(parsed.data.slugHint || parsed.data.name),
    });
    res.json({ url });
    return;
  } catch (err) {
    logger.error({ err }, "Avatar generation failed");
    res.status(502).json({ error: "Avatar generation failed. Try again." });
    return;
  }
});

router.get("/", async (_req, res) => {
  const items = await db.select().from(authorsTable).orderBy(authorsTable.name);
  res.json({ items }); return;
});

// The curated master list of beats. Sourced from the beats table (managed
// in the admin Beats page). Any beat slugs in use by authors that aren't in
// the master list are surfaced as "(legacy)" entries so existing data stays
// editable until the admin reassigns or renames them.
router.get("/categories", async (_req, res) => {
  const beats = await db.select().from(beatsTable).orderBy(beatsTable.name);
  const used = await db
    .selectDistinct({ category: authorsTable.category, categorySlug: authorsTable.categorySlug })
    .from(authorsTable)
    .orderBy(authorsTable.category);
  const known = new Set(beats.map((b) => b.slug));
  const items = [
    ...beats.map((b) => ({ category: b.name, categorySlug: b.slug })),
    ...used.filter((r) => !known.has(r.categorySlug)),
  ];
  res.json({ items });
  return;
});

router.get("/:id", async (req, res) => {
  const [item] = await db.select().from(authorsTable).where(eq(authorsTable.id, req.params.id)).limit(1);
  if (!item) { res.status(404).json({ error: "Not found" }); return; }
  res.json(item); return;
});

// Shared field shapes — `update` makes them optional, `create` adds requireds.
const axis = z.number().min(-10).max(10);
const editableSchema = z.object({
  name: z.string().min(1).optional(),
  // Editable URL slug. Changing it records a redirect from the old slug (see the
  // PATCH handler) so already-crawled /author/<old> URLs don't 404.
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "Slug must be kebab-case (a-z, 0-9, -)").optional(),
  bio: z.string().optional(),
  avatarUrl: z.string().optional(),
  category: z.string().min(1).optional(),
  categorySlug: z.string().min(1).regex(/^[a-z0-9-]+$/).optional(),
  voicePrompt: z.string().optional(),
  sampleParagraphs: z.array(z.string()).optional(),
  wordCountTarget: z.number().int().optional(),
  cadence: z.enum(["daily", "twice_weekly", "weekly", "biweekly", "monthly"]).optional(),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  secondWeekday: z.number().int().min(0).max(6).nullable().optional(),
  dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
  randomizeSchedule: z.boolean().optional(),
  bannedTopics: z.array(z.string()).optional(),
  subBeats: z.array(z.string().regex(/^[a-z0-9-]+$/)).optional(),
  active: z.boolean().optional(),
  model: z.enum(["claude-sonnet-4-6", "claude-opus-4-1", "claude-haiku-4-5"]).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1024).max(16384).optional(),
  economicAxis: axis.optional(),
  socialAxis: axis.optional(),
  runHourUtc: z.number().int().min(0).max(23).optional(),
  tone: z.string().nullable().optional(),
  sentenceRhythm: z.string().nullable().optional(),
  vocabularyQuirks: z.string().nullable().optional(),
  signatureMove: z.string().nullable().optional(),
  corePromise: z.string().nullable().optional(),
  avoid: z.string().nullable().optional(),
  technicalExplanationStyle: z.string().nullable().optional(),
});

const createSchema = editableSchema.extend({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "Slug must be kebab-case (a-z, 0-9, -)"),
  name: z.string().min(1),
  bio: z.string().min(1),
  avatarUrl: z.string().min(1),
  category: z.string().min(1),
  categorySlug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  voicePrompt: z.string().min(1),
});

// Drizzle's `numeric` columns round-trip as strings; convert here so callers
// can pass plain numbers and Postgres still gets a `NUMERIC` literal.
function applyNumericFields(target: Record<string, unknown>, src: { temperature?: number; economicAxis?: number; socialAxis?: number }) {
  if (src.temperature !== undefined) target["temperature"] = src.temperature.toFixed(2);
  if (src.economicAxis !== undefined) target["economicAxis"] = src.economicAxis.toFixed(1);
  if (src.socialAxis !== undefined) target["socialAxis"] = src.socialAxis.toFixed(1);
}

router.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues, body: req.body },
      "Author create rejected by schema",
    );
    res.status(400).json({ error: "Invalid body", details: parsed.error });
    return;
  }
  const data = parsed.data;
  // Sub-beats are admin-curated: normalise (de-dupe, drop the primary beat) but
  // do NOT adjacency-filter — an admin's explicit pick is authoritative.
  if (data.subBeats) data.subBeats = normalizeSubBeats(data.categorySlug, data.subBeats);
  // New authors join the rotating weekly schedule by default. When the caller
  // didn't pin a cadence, default to weekly. Then auto-fill any cadence-relevant
  // scheduling field (weekday(s) / day-of-month / hour) the caller left blank so
  // the author slots straight into the rotation.
  if (data.cadence === undefined) data.cadence = "weekly";
  const cadence = data.cadence;
  if (cadenceUsesWeekday(cadence)) {
    if (data.weekday === null || data.weekday === undefined) data.weekday = pickRotatedWeekday(null);
    if (cadence === "twice_weekly" && (data.secondWeekday === null || data.secondWeekday === undefined)) {
      data.secondWeekday = pickRotatedWeekday(data.weekday ?? null);
    }
  }
  if (cadence === "monthly" && (data.dayOfMonth === null || data.dayOfMonth === undefined)) {
    data.dayOfMonth = pickRandomDayOfMonth();
  }
  if (cadence === "twice_weekly" && data.secondWeekday === data.weekday) {
    res.status(400).json({ error: "Twice-a-week cadence needs two different weekdays." });
    return;
  }
  if (cadence !== "daily" && data.runHourUtc === undefined) data.runHourUtc = pickRandomHour();
  const existing = await db.select({ id: authorsTable.id }).from(authorsTable).where(eq(authorsTable.slug, data.slug)).limit(1);
  if (existing.length > 0) { res.status(409).json({ error: "An author with that slug already exists." }); return; }

  const { temperature, economicAxis, socialAxis, ...rest } = data;
  // Null out fields irrelevant to the chosen cadence so we never persist a
  // stale weekday on a monthly author, etc.
  const insertValues: Record<string, unknown> = {
    ...rest,
    weekday: cadenceUsesWeekday(cadence) ? data.weekday : null,
    secondWeekday: cadence === "twice_weekly" ? data.secondWeekday : null,
    dayOfMonth: cadence === "monthly" ? data.dayOfMonth : null,
  };
  applyNumericFields(insertValues, { temperature, economicAxis, socialAxis });
  const [inserted] = await db
    .insert(authorsTable)
    .values(insertValues as typeof authorsTable.$inferInsert)
    .returning();
  res.status(201).json(inserted); return;
});

router.patch("/:id", async (req, res) => {
  const parsed = editableSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body", details: parsed.error }); return; }
  const data = { ...parsed.data };
  // Beat name and slug must move together — disallow lopsided edits that
  // would desync the (category, categorySlug) pair.
  if ((data.category !== undefined) !== (data.categorySlug !== undefined)) {
    res.status(400).json({
      error: "Both `category` and `categorySlug` must be provided together when changing the beat.",
    });
    return;
  }
  const [previous] = await db
    .select({
      id: authorsTable.id,
      slug: authorsTable.slug,
      cadence: authorsTable.cadence,
      weekday: authorsTable.weekday,
      secondWeekday: authorsTable.secondWeekday,
      dayOfMonth: authorsTable.dayOfMonth,
      runHourUtc: authorsTable.runHourUtc,
      categorySlug: authorsTable.categorySlug,
      subBeats: authorsTable.subBeats,
    })
    .from(authorsTable)
    .where(eq(authorsTable.id, req.params.id))
    .limit(1);
  if (!previous) { res.status(404).json({ error: "Not found" }); return; }

  // Sub-beats are admin-curated. Whenever the sub-beats OR the primary beat
  // change, normalise the resulting set (de-dupe, drop the primary beat) but do
  // NOT adjacency-filter — an admin's explicit pick is authoritative and must
  // persist exactly as chosen.
  if (data.subBeats !== undefined || data.categorySlug !== undefined) {
    const effCategorySlug = data.categorySlug ?? previous.categorySlug;
    const effSubBeats = data.subBeats !== undefined ? data.subBeats : previous.subBeats ?? [];
    data.subBeats = normalizeSubBeats(effCategorySlug, effSubBeats);
  }

  // Validate cadence invariants against the *resulting* state (patch merged
  // onto the existing row), so partial updates can't leave an author in an
  // invalid combination — e.g. a twice-weekly author patching only its
  // `secondWeekday` to equal its `weekday`, even when `cadence` isn't resent.
  // A field absent from the payload keeps its current value; a field present as
  // `null` is an explicit clear. After validating we null the fields that are
  // irrelevant to the effective cadence so we never persist a stale weekday on
  // a monthly author, etc.
  const effCadence = data.cadence ?? previous.cadence;
  const effWeekday = data.weekday !== undefined ? data.weekday : previous.weekday;
  const effSecondWeekday = data.secondWeekday !== undefined ? data.secondWeekday : previous.secondWeekday;
  const effDayOfMonth = data.dayOfMonth !== undefined ? data.dayOfMonth : previous.dayOfMonth;
  if (cadenceUsesWeekday(effCadence) && (effWeekday === null || effWeekday === undefined)) {
    res.status(400).json({ error: "This cadence requires a weekday (0=Sunday … 6=Saturday)." });
    return;
  }
  if (effCadence === "monthly" && (effDayOfMonth === null || effDayOfMonth === undefined)) {
    res.status(400).json({ error: "Monthly cadence requires a day of month (1–28)." });
    return;
  }
  if (effCadence === "twice_weekly") {
    if (effSecondWeekday === null || effSecondWeekday === undefined) {
      res.status(400).json({ error: "Twice-a-week cadence requires a second weekday." });
      return;
    }
    if (effSecondWeekday === effWeekday) {
      res.status(400).json({ error: "Twice-a-week cadence needs two different weekdays." });
      return;
    }
  }
  // Null out fields irrelevant to the effective cadence.
  if (effCadence === "daily") {
    data.weekday = null;
    data.secondWeekday = null;
    data.dayOfMonth = null;
  } else if (effCadence === "weekly" || effCadence === "biweekly") {
    data.secondWeekday = null;
    data.dayOfMonth = null;
  } else if (effCadence === "twice_weekly") {
    data.dayOfMonth = null;
  } else if (effCadence === "monthly") {
    data.weekday = null;
    data.secondWeekday = null;
  }
  // A slug change is a rename: guard uniqueness up front, then (after the update
  // succeeds) record a redirect from the old slug so crawled/inbound
  // /author/<old> URLs 301 instead of 404. A no-op slug (same value) is dropped
  // so it never spuriously creates a self-redirect.
  const slugChanging = data.slug !== undefined && data.slug !== previous.slug;
  if (data.slug !== undefined && !slugChanging) delete data.slug;
  if (slugChanging) {
    const clash = await db
      .select({ id: authorsTable.id })
      .from(authorsTable)
      .where(eq(authorsTable.slug, data.slug!))
      .limit(1);
    if (clash.length > 0) {
      res.status(409).json({ error: "An author with that slug already exists." });
      return;
    }
  }

  const { temperature, economicAxis, socialAxis, ...rest } = data;
  const updates: Record<string, unknown> = { ...rest, updatedAt: new Date() };
  applyNumericFields(updates, { temperature, economicAxis, socialAxis });
  // A rename and its redirect bookkeeping must land together — otherwise a
  // failure between the two reproduces the original bug (new slug, no redirect
  // for the old one). Wrap them in a transaction so they commit atomically.
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(authorsTable)
      .set(updates)
      .where(eq(authorsTable.id, req.params.id))
      .returning();
    if (!row) return undefined;
    if (slugChanging) {
      // Record old → author so the per-author page can 301 the retired slug.
      await tx
        .insert(authorSlugRedirectsTable)
        .values({ oldSlug: previous.slug, authorId: row.id })
        .onConflictDoNothing();
      // The new slug is now a real author slug (and resolution checks authors
      // first), so drop any stale redirect row that pointed away from it.
      await tx
        .delete(authorSlugRedirectsTable)
        .where(eq(authorSlugRedirectsTable.oldSlug, row.slug));
    }
    return row;
  });
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }

  // When the author's schedule definition (cadence / weekday / run hour)
  // changes, realign their pending articles to the new cadence so the calendar
  // reflects it: daily re-packs day-by-day, weekly drops off-cadence events.
  const scheduleChanged =
    updated.cadence !== previous.cadence ||
    updated.weekday !== previous.weekday ||
    updated.secondWeekday !== previous.secondWeekday ||
    updated.dayOfMonth !== previous.dayOfMonth ||
    (updated.runHourUtc ?? 14) !== (previous.runHourUtc ?? 14);
  if (scheduleChanged) {
    try {
      const result = await reslotAuthorSchedule(updated.id);
      req.log?.info({ authorId: updated.id, ...result }, "Realigned author schedule after change");
    } catch (err) {
      req.log?.error({ err, authorId: updated.id }, "Failed to realign author schedule after change");
    }
  }
  res.json(updated); return;
});

// Hard-delete an author. Refuses if the author has any articles on record
// (drafts, scheduled, or published) — admin must clean those up first so we
// don't orphan content. Topic ideas cascade-delete via the FK constraint.
router.delete("/:id", async (req, res) => {
  const [{ n }] = await db
    .select({ n: count() })
    .from(articlesTable)
    .where(eq(articlesTable.authorId, req.params.id));
  if (Number(n) > 0) {
    res.status(409).json({
      error: "Author still has articles. Delete or reassign them first.",
      articles: Number(n),
    });
    return;
  }
  try {
    const [deleted] = await db
      .delete(authorsTable)
      .where(eq(authorsTable.id, req.params.id))
      .returning({ id: authorsTable.id });
    if (!deleted) { res.status(404).json({ error: "Not found" }); return; }
    res.status(204).end();
    return;
  } catch (e: unknown) {
    // Map a foreign-key violation (e.g. an article was created between the
    // count check and the delete) to a clean 409 instead of a 500.
    const code = (e as { code?: string })?.code;
    if (code === "23503") {
      res.status(409).json({ error: "Author still has articles. Delete or reassign them first." });
      return;
    }
    throw e;
  }
});

export default router;
