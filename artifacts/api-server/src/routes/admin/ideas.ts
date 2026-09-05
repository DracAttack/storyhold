import { Router, type IRouter } from "express";
import { db, authorsTable, beatsTable, topicIdeasTable, type Author } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod/v4";
import { generateIdeasForAuthor, generateCrossoverIdeasForAuthor, generateIdeasForBeat, pickBestAuthorForIdea, NoSuitableAuthorError } from "../../services/llm";
import { recentTitlesForAuthor, recentPublishedTitlesForCategory, resolveAllowedBeats, countApprovedIdeas, getApprovedIdeaCap, startDraftArticleFromIdea, DuplicateArticleError } from "../../services/articles";
import { rankCoveringAuthors, toRankedPickCandidates } from "../../services/authorAssignment";
import { jaccard, probeConceptOverlap } from "../../services/dedupe";

function tokenSet(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter((w) => w.length > 2),
  );
}

const IDEA_OVERLAP_THRESHOLD = 0.35;

const router: IRouter = Router();

router.get("/ideas", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const authorId = typeof req.query.authorId === "string" ? req.query.authorId : undefined;
  const conditions = [];
  if (status) {
    conditions.push(eq(topicIdeasTable.status, status as "pending" | "approved" | "rejected" | "used"));
  }
  if (authorId) conditions.push(eq(topicIdeasTable.authorId, authorId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const items = await db
    .select()
    .from(topicIdeasTable)
    .where(where)
    .orderBy(desc(topicIdeasTable.createdAt));
  res.json({ items }); return;
});

// Bulk delete non-terminal ideas. With no ?status filter it removes every
// pending + approved + drafting idea (leaves used/rejected history alone).
// With ?status=pending|approved|drafting it removes only that one status —
// powers the per-section "Delete all <status>" button. Registered before
// "/ideas/:id" so the literal path wins over the param route.
const BULK_DELETABLE_STATUSES = ["pending", "approved", "drafting"] as const;
router.delete("/ideas/pending", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  if (status !== undefined && !(BULK_DELETABLE_STATUSES as readonly string[]).includes(status)) {
    res.status(400).json({ error: "Invalid status filter" }); return;
  }
  const statuses = status
    ? [status as (typeof BULK_DELETABLE_STATUSES)[number]]
    : [...BULK_DELETABLE_STATUSES];
  const removed = await db
    .delete(topicIdeasTable)
    .where(inArray(topicIdeasTable.status, statuses))
    .returning({ id: topicIdeasTable.id });
  res.json({ deleted: removed.length }); return;
});

router.get("/authors/:id/ideas", async (req, res) => {
  const items = await db
    .select()
    .from(topicIdeasTable)
    .where(eq(topicIdeasTable.authorId, req.params.id))
    .orderBy(topicIdeasTable.createdAt);
  res.json({ items }); return;
});

// Approve every pending idea for a single author in one operation. Scoped
// strictly to that author's ideas; leaves approved/drafting/rejected/used alone.
router.post("/authors/:id/ideas/approve-all", async (req, res) => {
  const approved = await db
    .update(topicIdeasTable)
    .set({ status: "approved", updatedAt: new Date() })
    .where(and(eq(topicIdeasTable.authorId, req.params.id), eq(topicIdeasTable.status, "pending")))
    .returning({ id: topicIdeasTable.id });
  res.json({ approved: approved.length }); return;
});

const createSchema = z.object({
  title: z.string().min(1),
  angle: z.string().min(1),
  status: z.enum(["pending", "approved", "rejected", "used"]).optional(),
});

router.post("/authors/:id/ideas", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  const force = req.query.force === "1" || req.query.force === "true";
  if (!force) {
    const { worst } = await probeConceptOverlap(parsed.data.title, parsed.data.angle, {
      threshold: IDEA_OVERLAP_THRESHOLD,
    });
    if (worst) {
      res.status(409).json({
        error: "Duplicate concept",
        message: `This idea overlaps too much with an existing ${worst.kind}: "${worst.title}" (${(worst.score * 100).toFixed(0)}% match). Pass ?force=1 to insert anyway.`,
        conflict: worst,
      });
      return;
    }
  }
  const [item] = await db
    .insert(topicIdeasTable)
    .values({ authorId: req.params.id, ...parsed.data })
    .returning();
  res.json(item); return;
});

const customCreateSchema = z.object({
  title: z.string().min(1),
  angle: z.string().optional(),
  authorId: z.string().optional(),
  beatSlug: z.string().min(1).optional(),
  status: z.enum(["pending", "approved", "rejected", "used"]).optional(),
});

router.post("/ideas", async (req, res) => {
  const parsed = customCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  const { title, angle, authorId, beatSlug, status } = parsed.data;
  const force = req.query.force === "1" || req.query.force === "true";

  // Optional editorial override: file the idea under a chosen beat so the draft
  // takes that beat's slant even when the assigned author normally writes a
  // different lane. Author selection below is unaffected — still best fit on
  // topic. This is the one sanctioned way an author writes outside their beat.
  let beatOverride: { name: string; slug: string } | undefined;
  if (beatSlug) {
    const [beat] = await db.select().from(beatsTable).where(eq(beatsTable.slug, beatSlug)).limit(1);
    if (!beat) { res.status(404).json({ error: "Beat not found" }); return; }
    beatOverride = { name: beat.name, slug: beat.slug };
  }

  if (!force) {
    // Manually-typed ideas get a looser, lexical-only check. The LLM concept
    // probe is too eager to call paraphrases "duplicates" for human-driven
    // entries; the human is on the hook here, so we just guard against
    // near-identical wording and let them force past anything else.
    const { worst } = await probeConceptOverlap(title, angle ?? "", {
      threshold: 0.55,
      useLlm: false,
    });
    if (worst) {
      res.status(409).json({
        error: "Duplicate concept",
        message: `This looks very similar to an existing ${worst.kind}: "${worst.title}" (${(worst.score * 100).toFixed(0)}% wording overlap). Use “Create anyway” to insert it.`,
        conflict: worst,
      });
      return;
    }
  }

  let chosen: Author | undefined;
  let pickReason: string | undefined;

  if (authorId) {
    const [a] = await db.select().from(authorsTable).where(eq(authorsTable.id, authorId)).limit(1);
    if (!a) { res.status(404).json({ error: "Author not found" }); return; }
    chosen = a as Author;
  } else {
    const all = await db
      .select()
      .from(authorsTable)
      .where(eq(authorsTable.active, true));
    if (all.length === 0) {
      res.status(400).json({ error: "No active authors available to assign this idea." });
      return;
    }
    // Look up the human-readable name for every sub-beat slug used by any
    // active author so the picker sees real expertise, not just slugs.
    const allSubBeatSlugs = Array.from(
      new Set(all.flatMap((a) => a.subBeats ?? []).filter(Boolean)),
    );
    const beatRows = allSubBeatSlugs.length === 0
      ? []
      : await db
          .select({ slug: beatsTable.slug, name: beatsTable.name })
          .from(beatsTable)
          .where(inArray(beatsTable.slug, allSubBeatSlugs));
    const slugToName = new Map(beatRows.map((b) => [b.slug, b.name]));
    try {
      // Workload-first ranking (see authorAssignment.ts): the picker sees the
      // roster ordered lightest recent load first, with each writer's current
      // workload listed, so custom ideas spread across the desk too.
      const ranked = await rankCoveringAuthors(null, { authors: all as Author[] });
      const pick = await pickBestAuthorForIdea(
        { title, angle },
        toRankedPickCandidates(ranked, slugToName),
      );
      pickReason = pick.reason;
      chosen = all.find((a) => a.id === pick.authorId) as Author | undefined;
    } catch (e) {
      if (e instanceof NoSuitableAuthorError) {
        res.status(400).json({
          error: "No suitable author",
          message: `${e.message} Pick a writer manually from the author dropdown.`,
        });
        return;
      }
      console.error(e);
      res.status(500).json({ error: "Author auto-pick failed", message: e instanceof Error ? e.message : String(e) });
      return;
    }
  }

  if (!chosen) { res.status(500).json({ error: "Failed to assign author" }); return; }

  const [item] = await db
    .insert(topicIdeasTable)
    .values({
      authorId: chosen.id,
      title,
      angle: angle ?? "",
      category: beatOverride?.name ?? chosen.category,
      categorySlug: beatOverride?.slug ?? chosen.categorySlug,
      status,
      notes: pickReason ? `Auto-assigned: ${pickReason}` : undefined,
    })
    .returning();
  res.json({ ...item, autoAssignReason: pickReason }); return;
});

router.post("/authors/:id/ideas/generate", async (req, res) => {
  const [author] = await db
    .select()
    .from(authorsTable)
    .where(eq(authorsTable.id, req.params.id))
    .limit(1);
  if (!author) { res.status(404).json({ error: "Author not found" }); return; }
  // Approved-idea cap: once an author's bank of ready-to-draft ideas is full,
  // stop generating more for them. The bank drains as the pipeline drafts them
  // (approved → used), so generation resumes automatically below the cap.
  const approvedCount = await countApprovedIdeas(author.id);
  const ideaCap = await getApprovedIdeaCap();
  if (approvedCount >= ideaCap) {
    res.status(409).json({
      error: "Idea cap reached",
      capped: true,
      approvedCount,
      cap: ideaCap,
      message: `${author.name} already has ${approvedCount} approved ideas (cap ${ideaCap}). Draft some of them before generating more.`,
    });
    return;
  }
  try {
    const [avoidTitles, recentCategoryTitles, allowedBeats] = await Promise.all([
      recentTitlesForAuthor(author.id),
      recentPublishedTitlesForCategory(author.categorySlug),
      resolveAllowedBeats(author),
    ]);
    const generated = await generateIdeasForAuthor(author as Author, { avoidTitles, recentCategoryTitles, allowedBeats });
    const slugToName = new Map(allowedBeats.map((b) => [b.categorySlug, b.category]));

    // Filter out concepts that overlap too much with existing articles or
    // pending/approved ideas before we insert anything.
    const accepted: typeof generated = [];
    const skipped: { title: string; reason: string }[] = [];
    for (const g of generated) {
      const { worst } = await probeConceptOverlap(g.title, g.angle, {
        threshold: IDEA_OVERLAP_THRESHOLD,
      });
      if (worst) {
        skipped.push({
          title: g.title,
          reason: `overlaps existing ${worst.kind} "${worst.title}" (${(worst.score * 100).toFixed(0)}%)`,
        });
        continue;
      }
      // Also dedupe within the freshly generated batch itself.
      const intra = accepted.find((a) => jaccard(tokenSet(a.title + " " + a.angle), tokenSet(g.title + " " + g.angle)) >= IDEA_OVERLAP_THRESHOLD);
      if (intra) {
        skipped.push({ title: g.title, reason: `overlaps another idea in this batch ("${intra.title}")` });
        continue;
      }
      accepted.push(g);
    }

    const inserted = accepted.length === 0
      ? []
      : await db
          .insert(topicIdeasTable)
          .values(accepted.map((g) => ({
            authorId: author.id,
            title: g.title,
            angle: g.angle,
            categorySlug: g.categorySlug,
            category: slugToName.get(g.categorySlug) ?? author.category,
          })))
          .returning();
    res.json({ items: inserted, skipped }); return;
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Idea generation failed", message: e instanceof Error ? e.message : String(e) }); return;
  }
});

// Generate deliberate CROSSOVER ideas for an author (Task #258): each idea
// keeps the author's primary beat as its canonical home but records one of the
// author's assigned sub-beats as a secondary subject, producing a
// cross-disciplinary angle. Mirrors /generate (same cap + dedupe), but persists
// the secondary subject as internal metadata. Returns 409 with reason when the
// author has no sub-beats to cross with.
router.post("/authors/:id/ideas/generate-crossover", async (req, res) => {
  const [author] = await db
    .select()
    .from(authorsTable)
    .where(eq(authorsTable.id, req.params.id))
    .limit(1);
  if (!author) { res.status(404).json({ error: "Author not found" }); return; }

  const allowedBeats = await resolveAllowedBeats(author);
  if (allowedBeats.length <= 1) {
    res.status(409).json({
      error: "No sub-beats",
      message: `${author.name} has no assigned sub-beats to cross with. Assign sub-beats first, then generate crossover ideas.`,
    });
    return;
  }

  const approvedCount = await countApprovedIdeas(author.id);
  const ideaCap = await getApprovedIdeaCap();
  if (approvedCount >= ideaCap) {
    res.status(409).json({
      error: "Idea cap reached",
      capped: true,
      approvedCount,
      cap: ideaCap,
      message: `${author.name} already has ${approvedCount} approved ideas (cap ${ideaCap}). Draft some of them before generating more.`,
    });
    return;
  }

  try {
    const [avoidTitles, recentCategoryTitles] = await Promise.all([
      recentTitlesForAuthor(author.id),
      recentPublishedTitlesForCategory(author.categorySlug),
    ]);
    const generated = await generateCrossoverIdeasForAuthor(author as Author, { avoidTitles, recentCategoryTitles, allowedBeats });
    const slugToName = new Map(allowedBeats.map((b) => [b.categorySlug, b.category]));

    const accepted: typeof generated = [];
    const skipped: { title: string; reason: string }[] = [];
    for (const g of generated) {
      const { worst } = await probeConceptOverlap(g.title, g.angle, {
        threshold: IDEA_OVERLAP_THRESHOLD,
      });
      if (worst) {
        skipped.push({
          title: g.title,
          reason: `overlaps existing ${worst.kind} "${worst.title}" (${(worst.score * 100).toFixed(0)}%)`,
        });
        continue;
      }
      const intra = accepted.find((a) => jaccard(tokenSet(a.title + " " + a.angle), tokenSet(g.title + " " + g.angle)) >= IDEA_OVERLAP_THRESHOLD);
      if (intra) {
        skipped.push({ title: g.title, reason: `overlaps another idea in this batch ("${intra.title}")` });
        continue;
      }
      accepted.push(g);
    }

    const inserted = accepted.length === 0
      ? []
      : await db
          .insert(topicIdeasTable)
          .values(accepted.map((g) => ({
            authorId: author.id,
            title: g.title,
            angle: g.angle,
            categorySlug: g.categorySlug,
            category: slugToName.get(g.categorySlug) ?? author.category,
            secondaryBeats: g.secondaryBeats,
          })))
          .returning();
    res.json({ items: inserted, skipped }); return;
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Crossover idea generation failed", message: e instanceof Error ? e.message : String(e) }); return;
  }
});

const generateFromBeatSchema = z.object({
  beatSlug: z.string().min(1),
  count: z.number().int().min(1).max(10).optional(),
});

// Standalone: generate a batch of fresh ideas grounded in a single beat (its
// name, description, and editorial slant), assign each to the best-fit author
// that covers the beat, dedupe against existing material + the batch itself,
// and insert the survivors. Returns the inserted ideas + a skipped list.
router.post("/ideas/generate-from-beat", async (req, res) => {
  const parsed = generateFromBeatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  const { beatSlug, count } = parsed.data;

  const [beat] = await db.select().from(beatsTable).where(eq(beatsTable.slug, beatSlug)).limit(1);
  if (!beat) { res.status(404).json({ error: "Beat not found" }); return; }

  const activeAuthors = (await db
    .select()
    .from(authorsTable)
    .where(eq(authorsTable.active, true))) as Author[];
  if (activeAuthors.length === 0) {
    res.status(400).json({ error: "No active authors available to assign ideas." });
    return;
  }

  // Authors who already cover this beat (primary OR sub-beat, ONE pool ranked
  // workload-first — see authorAssignment.ts) are the preferred pool; fall
  // back to the full active roster (also workload-ranked) when nobody covers
  // it. Ranked once per batch; the per-batch cap projection below still
  // prevents piling the whole run onto one author.
  const rankedCovering = await rankCoveringAuthors(beat.slug, { authors: activeAuthors });
  const rankedRoster = await rankCoveringAuthors(null, { authors: activeAuthors });

  try {
    // Resolve sub-beat slug → display name for the author picker.
    const allSubBeatSlugs = Array.from(
      new Set(activeAuthors.flatMap((a) => a.subBeats ?? []).filter(Boolean)),
    );
    const beatRows = allSubBeatSlugs.length === 0
      ? []
      : await db
          .select({ slug: beatsTable.slug, name: beatsTable.name })
          .from(beatsTable)
          .where(inArray(beatsTable.slug, allSubBeatSlugs));
    const slugToName = new Map(beatRows.map((b) => [b.slug, b.name]));

    const [avoidTitles, recentCategoryTitles] = await Promise.all([
      recentTitlesForAuthor(beat.slug),
      recentPublishedTitlesForCategory(beat.slug),
    ]);
    const generated = await generateIdeasForBeat(
      { name: beat.name, categorySlug: beat.slug, description: beat.description, slant: beat.slant },
      { count: count ?? 5, avoidTitles, recentCategoryTitles },
    );

    const accepted: { title: string; angle: string; authorId: string; notes?: string }[] = [];
    const skipped: { title: string; reason: string }[] = [];
    // Respect the per-author approved-idea cap. Seed from the live approved
    // count and project forward within this batch so we don't pile a whole beat
    // run onto one near-full author.
    const projectedApproved = new Map<string, number>();
    const bulkIdeaCap = await getApprovedIdeaCap();

    for (const g of generated) {
      // Skip concepts overlapping existing articles/ideas.
      const { worst } = await probeConceptOverlap(g.title, g.angle, {
        threshold: IDEA_OVERLAP_THRESHOLD,
      });
      if (worst) {
        skipped.push({
          title: g.title,
          reason: `overlaps existing ${worst.kind} "${worst.title}" (${(worst.score * 100).toFixed(0)}%)`,
        });
        continue;
      }
      // Skip intra-batch dupes.
      const intra = accepted.find((a) => jaccard(tokenSet(a.title + " " + a.angle), tokenSet(g.title + " " + g.angle)) >= IDEA_OVERLAP_THRESHOLD);
      if (intra) {
        skipped.push({ title: g.title, reason: `overlaps another idea in this batch ("${intra.title}")` });
        continue;
      }

      // Assign an author: prefer the covering pool (workload-ranked); if none
      // fits there, fall back to the full active roster's best fit.
      const primaryRanked = rankedCovering.length > 0 ? rankedCovering : rankedRoster;
      let authorId: string | undefined;
      let pickReason: string | undefined;
      try {
        const pick = await pickBestAuthorForIdea({ title: g.title, angle: g.angle }, toRankedPickCandidates(primaryRanked, slugToName));
        authorId = pick.authorId;
        pickReason = pick.reason;
      } catch (e) {
        if (!(e instanceof NoSuitableAuthorError)) throw e;
        if (rankedCovering.length > 0) {
          try {
            const pick = await pickBestAuthorForIdea({ title: g.title, angle: g.angle }, toRankedPickCandidates(rankedRoster, slugToName));
            authorId = pick.authorId;
            pickReason = pick.reason;
          } catch (e2) {
            if (!(e2 instanceof NoSuitableAuthorError)) throw e2;
          }
        }
      }
      if (!authorId) {
        skipped.push({ title: g.title, reason: "no active author fits this idea" });
        continue;
      }
      const projected = projectedApproved.get(authorId) ?? (await countApprovedIdeas(authorId));
      if (projected >= bulkIdeaCap) {
        projectedApproved.set(authorId, projected);
        const who = activeAuthors.find((a) => a.id === authorId)?.name ?? "author";
        skipped.push({ title: g.title, reason: `${who} is at the ${bulkIdeaCap}-idea cap` });
        continue;
      }
      projectedApproved.set(authorId, projected + 1);
      accepted.push({
        title: g.title,
        angle: g.angle,
        authorId,
        ...(pickReason ? { notes: `Auto-assigned: ${pickReason}` } : {}),
      });
    }

    const inserted = accepted.length === 0
      ? []
      : await db
          .insert(topicIdeasTable)
          .values(accepted.map((a) => ({
            authorId: a.authorId,
            title: a.title,
            angle: a.angle,
            category: beat.name,
            categorySlug: beat.slug,
            ...(a.notes ? { notes: a.notes } : {}),
          })))
          .returning();
    res.json({ items: inserted, skipped }); return;
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Idea generation failed", message: e instanceof Error ? e.message : String(e) }); return;
  }
});

const updateSchema = z.object({
  title: z.string().optional(),
  angle: z.string().optional(),
  status: z.enum(["pending", "approved", "rejected", "used"]).optional(),
  authorId: z.string().min(1).optional(),
  categorySlug: z.string().min(1).optional(),
  // Cross-sectional secondary subjects (Task #258): admin-only. null/[] clears.
  secondaryBeats: z.array(z.string()).nullable().optional(),
});

router.patch("/ideas/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  // Reassigning the author: confirm the target author exists before writing.
  if (parsed.data.authorId) {
    const [a] = await db.select().from(authorsTable).where(eq(authorsTable.id, parsed.data.authorId)).limit(1);
    if (!a) { res.status(404).json({ error: "Author not found" }); return; }
  }
  const updates: Record<string, unknown> = { ...parsed.data, updatedAt: new Date() };
  // Re-filing under a different beat (editorial slant override): resolve the
  // beat so `category` stays in sync with `categorySlug`. Author is untouched.
  if (parsed.data.categorySlug) {
    const [beat] = await db.select().from(beatsTable).where(eq(beatsTable.slug, parsed.data.categorySlug)).limit(1);
    if (!beat) { res.status(404).json({ error: "Beat not found" }); return; }
    updates.category = beat.name;
  }
  // Normalize cross-sectional secondary subjects (Task #258): dedupe, drop
  // blanks, and never let the primary beat leak in as its own "secondary". null
  // clears the field.
  if (parsed.data.secondaryBeats !== undefined) {
    if (parsed.data.secondaryBeats === null) {
      updates.secondaryBeats = null;
    } else {
      const [current] = await db.select().from(topicIdeasTable).where(eq(topicIdeasTable.id, req.params.id)).limit(1);
      const primary = (parsed.data.categorySlug ?? current?.categorySlug ?? "") as string;
      const cleaned = Array.from(
        new Set(parsed.data.secondaryBeats.filter((s) => s && s.length > 0 && s !== primary)),
      );
      updates.secondaryBeats = cleaned.length > 0 ? cleaned : null;
    }
  }
  const [item] = await db
    .update(topicIdeasTable)
    .set(updates)
    .where(eq(topicIdeasTable.id, req.params.id))
    .returning();
  if (!item) { res.status(404).json({ error: "Not found" }); return; }
  res.json(item); return;
});

router.delete("/ideas/:id", async (req, res) => {
  await db.delete(topicIdeasTable).where(eq(topicIdeasTable.id, req.params.id));
  res.status(204).end();
});

// Harvest sources + retry draft for a needs_sources or approved idea. Runs a
// targeted Perplexity search, ingests leads into the Source Vault, then
// re-attempts grounding and drafting. Fire-and-forget 202 — same pattern as
// /draft. Visible on needs_sources ideas and approved ideas with a grounding
// failure note, so the editor can trigger the breaking-news intake lane manually.
router.post("/ideas/:id/harvest-sources", async (req, res) => {
  const [idea] = await db.select().from(topicIdeasTable).where(eq(topicIdeasTable.id, req.params.id)).limit(1);
  if (!idea) { res.status(404).json({ error: "Idea not found" }); return; }
  if (idea.status !== "needs_sources" && idea.status !== "approved") {
    res.status(409).json({ error: "Idea must be in needs_sources or approved status to harvest sources" }); return;
  }
  try {
    const updatedIdea = await startDraftArticleFromIdea(idea.authorId, idea.id, { force: true, forceHarvest: true });
    res.status(202).json(updatedIdea); return;
  } catch (e) {
    if (e instanceof DuplicateArticleError) {
      res.status(409).json({
        error: "Duplicate article",
        message: e.message,
        conflictingTitle: e.conflictingTitle,
        conflictingId: e.conflictingId,
      });
      return;
    }
    res.status(500).json({ error: "Harvest & draft failed", message: e instanceof Error ? e.message : String(e) }); return;
  }
});

export default router;
