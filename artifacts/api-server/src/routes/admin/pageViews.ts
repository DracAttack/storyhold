import { Router, type IRouter } from "express";
import { db, pageViewsTable } from "@workspace/db";
import { and, gte, lt, sql, type SQL } from "drizzle-orm";

const router: IRouter = Router();

// Parses an optional ISO date-time query param into a Date, returning undefined
// when missing or unparseable (so a bad value degrades to "no bound" rather
// than 500-ing the report).
function parseBound(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// Aggregated article page-view counts for the admin "Shares" report. Returns a
// grand total, a per-day time series, and a per-article breakdown sorted
// most-viewed first. An optional [from, to) date-time window (`from` inclusive,
// `to` exclusive) filters every aggregate; omit both for all time.
router.get("/page-views", async (req, res) => {
  const from = parseBound(req.query.from);
  const to = parseBound(req.query.to);

  const conditions: SQL[] = [];
  if (from) conditions.push(gte(pageViewsTable.createdAt, from));
  if (to) conditions.push(lt(pageViewsTable.createdAt, to));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      slug: pageViewsTable.articleSlug,
      title: pageViewsTable.articleTitle,
      count: sql<number>`COUNT(*)`,
    })
    .from(pageViewsTable)
    .where(where)
    .groupBy(pageViewsTable.articleSlug, pageViewsTable.articleTitle);

  // Per-day time series (UTC calendar days), ascending. Only days with at least
  // one view are returned; the client fills any gaps within the chosen range.
  const dayExpr = sql<string>`to_char(date_trunc('day', ${pageViewsTable.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
  const dayRows = await db
    .select({ date: dayExpr, count: sql<number>`COUNT(*)` })
    .from(pageViewsTable)
    .where(where)
    .groupBy(dayExpr)
    .orderBy(dayExpr);

  const byDay = dayRows.map((r) => ({ date: r.date, count: Number(r.count ?? 0) }));

  let total = 0;
  // slug -> { title, total }
  const articles = new Map<string, { title: string; total: number }>();

  for (const r of rows) {
    const count = Number(r.count ?? 0);
    total += count;
    // Keep the most-recently-seen title for a slug (titles can change over time).
    const article = articles.get(r.slug);
    if (article) {
      article.title = r.title;
      article.total += count;
    } else {
      articles.set(r.slug, { title: r.title, total: count });
    }
  }

  const byArticle = [...articles.entries()]
    .map(([slug, a]) => ({ slug, title: a.title, total: a.total }))
    .sort((a, b) => b.total - a.total);

  // Traffic-source breakdown: where views came from, grouped by the derived
  // source + medium AND the raw campaign/content (so admins can see the EXACT
  // link followed — utm_content is the article slug for share links). Legacy
  // rows recorded before attribution shipped have NULL source/medium, so they
  // bucket together as "(unknown)" rather than dropping.
  const sourceExpr = sql<string>`COALESCE(${pageViewsTable.source}, '(unknown)')`;
  const mediumExpr = sql<string>`COALESCE(${pageViewsTable.medium}, '(unknown)')`;
  const sourceRows = await db
    .select({
      source: sourceExpr,
      medium: mediumExpr,
      campaign: pageViewsTable.campaign,
      content: pageViewsTable.content,
      count: sql<number>`COUNT(*)`,
    })
    .from(pageViewsTable)
    .where(where)
    .groupBy(sourceExpr, mediumExpr, pageViewsTable.campaign, pageViewsTable.content);

  const bySource = sourceRows
    .map((r) => ({
      source: r.source,
      medium: r.medium,
      campaign: r.campaign ?? undefined,
      content: r.content ?? undefined,
      count: Number(r.count ?? 0),
    }))
    .sort((a, b) => b.count - a.count);

  res.json({ total, byDay, byArticle, bySource });
  return;
});

export default router;
