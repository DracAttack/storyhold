import { Router, type IRouter } from "express";
import { db, articlesTable, authorsTable, topicIdeasTable } from "@workspace/db";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { computeSlots, slotKey, slotMatchesCadence } from "../../services/scheduling";
import { getApprovedIdeaCap, reconcileAllSchedules } from "../../services/articles";

const router: IRouter = Router();

// Guards against an overlapping schedule reconcile racing itself (a double-click,
// or two admins at once). The read-occupied/assign-slot step inside the reslot
// and force-lock passes isn't globally transactional, so two parallel runs could
// hand the same author slot to two drafts. Same single-server assumption as
// run-pipeline / schedule-pending; a multi-instance deploy would need a DB-level
// slot-uniqueness guarantee instead.
let reconcileRunning = false;

type Candidate =
  | { kind: "draft"; articleId: string; title: string }
  | { kind: "idea"; ideaId: string; title: string }
  | { kind: "empty" };

type ProjectionEntry = {
  authorId: string;
  authorName: string;
  slotAt: string;
  candidate: Candidate;
};

router.get("/schedule/projection", async (req, res) => {
  const days = Math.min(60, Math.max(1, parseInt((req.query.days as string) ?? "14", 10) || 14));
  const now = new Date();
  const horizonStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const horizonEnd = new Date(horizonStart);
  horizonEnd.setUTCDate(horizonEnd.getUTCDate() + days);

  const authors = await db.select().from(authorsTable).where(eq(authorsTable.active, true));
  if (authors.length === 0) { res.json({ items: [] }); return; }

  const authorIds = authors.map((a) => a.id);

  // Pull each author's drafts (oldest first) and approved ideas (oldest first).
  const drafts = await db
    .select({ id: articlesTable.id, authorId: articlesTable.authorId, title: articlesTable.title, createdAt: articlesTable.createdAt, scheduledFor: articlesTable.scheduledFor })
    .from(articlesTable)
    .where(and(eq(articlesTable.status, "draft"), inArray(articlesTable.authorId, authorIds)))
    .orderBy(asc(articlesTable.createdAt));
  const ideas = await db
    .select({ id: topicIdeasTable.id, authorId: topicIdeasTable.authorId, title: topicIdeasTable.title, createdAt: topicIdeasTable.createdAt })
    .from(topicIdeasTable)
    .where(and(eq(topicIdeasTable.status, "approved"), inArray(topicIdeasTable.authorId, authorIds)))
    .orderBy(asc(topicIdeasTable.createdAt));

  // Real scheduled articles in the window — used to skip slots already covered.
  const scheduled = await db
    .select({ id: articlesTable.id, authorId: articlesTable.authorId, scheduledFor: articlesTable.scheduledFor })
    .from(articlesTable)
    .where(and(
      eq(articlesTable.status, "scheduled"),
      inArray(articlesTable.authorId, authorIds),
      gte(articlesTable.scheduledFor, horizonStart),
    ));

  // Build a per-author set of "occupied" slot keys (authorId|YYYY-MM-DD-HH UTC)
  const occupied = new Set<string>();
  for (const s of scheduled) {
    if (!s.scheduledFor) continue;
    const d = new Date(s.scheduledFor);
    occupied.add(slotKey(s.authorId, d));
  }

  const items: ProjectionEntry[] = [];

  // Drafts that already carry a reserved future slot are pinned to that slot:
  // they show in their reserved position and mark it occupied so the greedy
  // fill below never re-maps them onto a different slot or double-books it.
  const reservedDraftIds = new Set<string>();
  for (const d of drafts) {
    if (!d.scheduledFor) continue;
    const slot = new Date(d.scheduledFor);
    if (slot.getTime() <= now.getTime()) continue;
    reservedDraftIds.add(d.id);
    occupied.add(slotKey(d.authorId, slot));
    if (slot.getTime() < horizonEnd.getTime()) {
      const author = authors.find((a) => a.id === d.authorId);
      items.push({
        authorId: d.authorId,
        authorName: author?.name ?? "",
        slotAt: slot.toISOString(),
        candidate: { kind: "draft", articleId: d.id, title: d.title },
      });
    }
  }

  // Only unreserved drafts compete for the greedy fill below.
  const draftsByAuthor = new Map<string, typeof drafts>();
  for (const d of drafts) {
    if (reservedDraftIds.has(d.id)) continue;
    const list = draftsByAuthor.get(d.authorId) ?? [];
    list.push(d);
    draftsByAuthor.set(d.authorId, list);
  }
  const ideasByAuthor = new Map<string, typeof ideas>();
  for (const i of ideas) {
    const list = ideasByAuthor.get(i.authorId) ?? [];
    list.push(i);
    ideasByAuthor.set(i.authorId, list);
  }

  const ideaCap = await getApprovedIdeaCap();
  for (const author of authors) {
    const slots = computeSlots(
      {
        cadence: author.cadence,
        weekday: author.weekday,
        secondWeekday: author.secondWeekday ?? null,
        dayOfMonth: author.dayOfMonth ?? null,
        runHourUtc: author.runHourUtc ?? 14,
      },
      horizonStart,
      days,
    );
    // Only show future slots (skip slots earlier today that already passed).
    const futureSlots = slots.filter((s) => s.getTime() > now.getTime());

    const draftQueue = [...(draftsByAuthor.get(author.id) ?? [])];
    const approvedForAuthor = ideasByAuthor.get(author.id) ?? [];
    // Authors at the approved-idea cap have idea generation paused ("Ideas
    // paused" badge); don't surface their ideas as projected schedule fill —
    // their real drafts still show. Below the cap, ideas fill empty slots.
    const ideaQueue =
      approvedForAuthor.length >= ideaCap ? [] : [...approvedForAuthor];

    for (const slot of futureSlots) {
      if (occupied.has(slotKey(author.id, slot))) continue;
      let candidate: Candidate;
      if (draftQueue.length > 0) {
        const d = draftQueue.shift()!;
        candidate = { kind: "draft", articleId: d.id, title: d.title };
      } else if (ideaQueue.length > 0) {
        const i = ideaQueue.shift()!;
        candidate = { kind: "idea", ideaId: i.id, title: i.title };
      } else {
        candidate = { kind: "empty" };
      }
      items.push({
        authorId: author.id,
        authorName: author.name,
        slotAt: slot.toISOString(),
        candidate,
      });
    }
  }

  // Sort by slot time so the client renders chronologically.
  items.sort((a, b) => a.slotAt.localeCompare(b.slotAt));
  res.json({ items });
});

// Force-rebuild the schedule: realign every active author's pending articles to
// their current cadence, then lock all remaining drafts into their slots. DB-only
// (no LLM, no early publishing). Guarded against overlapping runs.
router.post("/schedule/reconcile", async (_req, res) => {
  if (reconcileRunning) {
    res.json({ authors: 0, rescheduled: 0, unscheduled: 0, scheduled: 0, skippedNoSources: 0, alreadyRunning: true }); return;
  }
  reconcileRunning = true;
  try {
    const result = await reconcileAllSchedules();
    res.json({ ...result, alreadyRunning: false }); return;
  } finally {
    reconcileRunning = false;
  }
});

const swapSchema = z.object({
  authorId: z.string().min(1),
  slotAt: z.coerce.date(),
  articleId: z.string().min(1),
});

router.post("/schedule/projection/swap", async (req, res) => {
  const parsed = swapSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  const { authorId, slotAt, articleId } = parsed.data;

  const [author] = await db.select().from(authorsTable).where(eq(authorsTable.id, authorId)).limit(1);
  if (!author) { res.status(404).json({ error: "Author not found" }); return; }
  if (!author.active) { res.status(400).json({ error: "Author is inactive" }); return; }

  const [article] = await db.select().from(articlesTable).where(eq(articlesTable.id, articleId)).limit(1);
  if (!article) { res.status(404).json({ error: "Article not found" }); return; }
  if (article.authorId !== authorId) { res.status(400).json({ error: "Article does not belong to that author" }); return; }
  if (article.status !== "draft") { res.status(400).json({ error: "Only draft articles can be scheduled" }); return; }

  // Slot must be in the future and sit exactly on the author's cadence (correct
  // UTC hour, and correct day for weekday-based / monthly / biweekly cadences).
  const now = new Date();
  if (slotAt.getTime() <= now.getTime()) { res.status(409).json({ error: "Slot is in the past" }); return; }
  const spec = {
    cadence: author.cadence,
    weekday: author.weekday,
    secondWeekday: author.secondWeekday ?? null,
    dayOfMonth: author.dayOfMonth ?? null,
    runHourUtc: author.runHourUtc ?? 14,
  };
  if (!slotMatchesCadence(spec, slotAt)) {
    res.status(409).json({ error: "Slot does not match this author's cadence" }); return;
  }

  // Best-effort conflict check: refuse if another scheduled article already occupies this
  // UTC hour for this author. Not strictly serializable — concurrent swaps could still race,
  // but this is a low-volume admin action so it's acceptable for now.
  const hourStart = new Date(Date.UTC(slotAt.getUTCFullYear(), slotAt.getUTCMonth(), slotAt.getUTCDate(), slotAt.getUTCHours()));
  const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);
  const conflicts = await db
    .select({ id: articlesTable.id })
    .from(articlesTable)
    .where(and(
      eq(articlesTable.authorId, authorId),
      inArray(articlesTable.status, ["draft", "scheduled"]),
      gte(articlesTable.scheduledFor, hourStart),
      sql`${articlesTable.scheduledFor} < ${hourEnd}`,
    ));
  const otherConflict = conflicts.find((c) => c.id !== articleId);
  if (otherConflict) { res.status(409).json({ error: "Slot already taken by another scheduled article or reserved draft" }); return; }

  const [updated] = await db
    .update(articlesTable)
    .set({ status: "scheduled", scheduledFor: slotAt, updatedAt: new Date() })
    .where(eq(articlesTable.id, articleId))
    .returning();
  res.json(updated); return;
});

router.get("/schedule/swappable", async (req, res) => {
  const authorId = typeof req.query.authorId === "string" ? req.query.authorId : "";
  if (!authorId) { res.status(400).json({ error: "authorId required" }); return; }
  const drafts = await db
    .select({ id: articlesTable.id, title: articlesTable.title, createdAt: articlesTable.createdAt })
    .from(articlesTable)
    .where(and(eq(articlesTable.status, "draft"), eq(articlesTable.authorId, authorId)))
    .orderBy(asc(articlesTable.createdAt));
  const ideas = await db
    .select({ id: topicIdeasTable.id, title: topicIdeasTable.title, createdAt: topicIdeasTable.createdAt })
    .from(topicIdeasTable)
    .where(and(eq(topicIdeasTable.status, "approved"), eq(topicIdeasTable.authorId, authorId)))
    .orderBy(asc(topicIdeasTable.createdAt));
  res.json({ drafts, ideas }); return;
});

export default router;
