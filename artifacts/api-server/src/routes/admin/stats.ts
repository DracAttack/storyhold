import { Router, type IRouter } from "express";
import { db, articlesTable, authorsTable, beatsTable, topicIdeasTable, conceptsTable } from "@workspace/db";
import { asc, eq, sql } from "drizzle-orm";
import { runDailyPipeline, getApprovedIdeaCap } from "../../services/articles";
import { scanForContinuance } from "../../services/continuance";
import { getIndexNowKey, getPublicBaseUrl, submitUrlsToIndexNow } from "../../lib/indexnow";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

// Guards against overlapping manual pipeline runs. A manual run drafts for
// every active author (LLM + hero image), so it can take several minutes; a
// double-click should not launch a second multi-minute job in parallel.
let pipelineRunning = false;

router.get("/stats", async (_req, res) => {
  const totalsRow = await db
    .select({
      drafts: sql<number>`COUNT(*) FILTER (WHERE ${articlesTable.status} = 'draft')`,
      scheduled: sql<number>`COUNT(*) FILTER (WHERE ${articlesTable.status} = 'scheduled')`,
      published: sql<number>`COUNT(*) FILTER (WHERE ${articlesTable.status} = 'published')`,
    })
    .from(articlesTable);
  const ideasCount = await db
    .select({
      ideas: sql<number>`COUNT(*) FILTER (WHERE ${topicIdeasTable.status} IN ('pending','approved'))`,
    })
    .from(topicIdeasTable);

  const authors = await db.select().from(authorsTable).orderBy(authorsTable.name);
  const ideaCap = await getApprovedIdeaCap();
  const perAuthor = await Promise.all(
    authors.map(async (a) => {
      const counts = await db
        .select({
          drafts: sql<number>`COUNT(*) FILTER (WHERE ${articlesTable.status} = 'draft')`,
          scheduled: sql<number>`COUNT(*) FILTER (WHERE ${articlesTable.status} = 'scheduled')`,
          published: sql<number>`COUNT(*) FILTER (WHERE ${articlesTable.status} = 'published')`,
        })
        .from(articlesTable)
        .where(eq(articlesTable.authorId, a.id));
      const ideas = await db
        .select({
          pending: sql<number>`COUNT(*) FILTER (WHERE ${topicIdeasTable.status} = 'pending')`,
          approved: sql<number>`COUNT(*) FILTER (WHERE ${topicIdeasTable.status} = 'approved')`,
        })
        .from(topicIdeasTable)
        .where(eq(topicIdeasTable.authorId, a.id));
      const drafts = Number(counts[0]?.drafts ?? 0);
      const scheduled = Number(counts[0]?.scheduled ?? 0);
      const approvedIdeas = Number(ideas[0]?.approved ?? 0);
      return {
        authorId: a.id,
        authorName: a.name,
        drafts,
        scheduled,
        published: Number(counts[0]?.published ?? 0),
        pendingIdeas: Number(ideas[0]?.pending ?? 0),
        approvedIdeas,
        // Mirrors the idea-generation cap: once an author's bank of approved
        // (ready-to-draft) ideas reaches the cap, the system stops generating
        // new ideas for them until the bank drains back below it.
        autoPaused: approvedIdeas >= ideaCap,
      };
    }),
  );

  const upcomingRows = await db
    .select({
      id: articlesTable.id,
      title: articlesTable.title,
      scheduledFor: articlesTable.scheduledFor,
      authorName: authorsTable.name,
    })
    .from(articlesTable)
    .innerJoin(authorsTable, eq(authorsTable.id, articlesTable.authorId))
    .where(eq(articlesTable.status, "scheduled"))
    .orderBy(asc(articlesTable.scheduledFor))
    .limit(20);

  res.json({
    totals: {
      drafts: Number(totalsRow[0]?.drafts ?? 0),
      scheduled: Number(totalsRow[0]?.scheduled ?? 0),
      published: Number(totalsRow[0]?.published ?? 0),
      ideas: Number(ideasCount[0]?.ideas ?? 0),
    },
    perAuthor,
    upcoming: upcomingRows
      .filter((u) => u.scheduledFor)
      .map((u) => ({ id: u.id, title: u.title, scheduledFor: u.scheduledFor, authorName: u.authorName })),
  });
});

router.post("/run-pipeline", (req, res) => {
  // A manual run drafts for every active author (LLM + hero image), which can
  // take several minutes — longer than an HTTP request (and the upstream proxy)
  // will stay open. Run it fire-and-forget: return 202 immediately and do the
  // work in an unawaited promise. Drafts surface in the queue as they finish.
  if (pipelineRunning) {
    res.status(202).json({ started: false, alreadyRunning: true });
    return;
  }
  pipelineRunning = true;
  req.log?.info({ adminEmail: req.session?.adminEmail }, "run-pipeline: start (background)");
  res.status(202).json({ started: true, alreadyRunning: false });
  void runDailyPipeline(new Date(), { manual: true })
    .then((result) => {
      logger.info({ result }, "run-pipeline: done");
    })
    .catch((e) => {
      logger.error({ err: e }, "run-pipeline: failed");
    })
    .finally(() => {
      pipelineRunning = false;
    });
});

router.post("/reindex-all", async (req, res) => {
  // Resubmit every published article (plus home, about, all category pages, and
  // the sitemap) to IndexNow so search engines re-crawl and pick up the current
  // per-article SEO meta. SEO meta is rendered at request time, so there is no
  // per-article data to regenerate — the only retroactive action that helps the
  // existing backlog is nudging crawlers to revisit. A single IndexNow POST
  // carries every URL (the API allows up to 10,000 per request), so this is one
  // fast network call regardless of how many articles exist.
  try {
    const [articles, beats, concepts] = await Promise.all([
      db
        .select({ slug: articlesTable.slug })
        .from(articlesTable)
        .where(eq(articlesTable.status, "published")),
      db.select({ slug: beatsTable.slug }).from(beatsTable),
      db
        .select({ slug: conceptsTable.slug })
        .from(conceptsTable)
        .where(eq(conceptsTable.status, "live")),
    ]);

    const paths = [
      "/",
      "/about",
      "/glossary",
      "/sitemap.xml",
      "/sitemap-glossary.xml",
      ...beats.map((b) => `/category/${b.slug}`),
      ...articles.map((a) => `/article/${a.slug}`),
      ...concepts.map((c) => `/glossary/${c.slug}`),
    ];

    // IndexNow only accepts public hosts; in dev (localhost) or without a key the
    // submit is a no-op. Surface that to the admin instead of pretending we sent.
    const skipped = !getIndexNowKey() || !getPublicBaseUrl();
    if (!skipped) {
      await submitUrlsToIndexNow(paths);
    }

    req.log?.info(
      { skipped, urls: paths.length, articles: articles.length, categories: beats.length, concepts: concepts.length },
      "reindex-all: search-engine resubmission",
    );

    res.json({
      skipped,
      urls: skipped ? 0 : paths.length,
      articles: articles.length,
      categories: beats.length,
      concepts: concepts.length,
    });
  } catch (err) {
    req.log?.error({ err }, "reindex-all failed");
    res.status(500).json({
      error: "Reindex failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

router.post("/scan-continuance", async (_req, res) => {
  try {
    const result = await scanForContinuance();
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Continuance scan failed", message: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
