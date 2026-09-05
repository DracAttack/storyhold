import { Router, type IRouter } from "express";
import { db, shareEventsTable } from "@workspace/db";
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

// Aggregated share-button click counts for the admin "Shares" report. Returns a
// grand total, a per-day time series, a per-platform breakdown, and a per-article
// breakdown (each with its own per-platform split), sorted most-shared first.
// An optional [from, to) date-time window (`from` inclusive, `to` exclusive)
// filters every aggregate; omit both for all time. The article/platform split is
// one GROUP BY pass folded in memory; the daily series is a second GROUP BY.
router.get("/shares", async (req, res) => {
  const from = parseBound(req.query.from);
  const to = parseBound(req.query.to);

  const conditions: SQL[] = [];
  if (from) conditions.push(gte(shareEventsTable.createdAt, from));
  if (to) conditions.push(lt(shareEventsTable.createdAt, to));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      slug: shareEventsTable.articleSlug,
      title: shareEventsTable.articleTitle,
      platform: shareEventsTable.platform,
      count: sql<number>`COUNT(*)`,
    })
    .from(shareEventsTable)
    .where(where)
    .groupBy(shareEventsTable.articleSlug, shareEventsTable.articleTitle, shareEventsTable.platform);

  // Per-day time series (UTC calendar days), ascending. Only days with at least
  // one share are returned; the client fills any gaps within the chosen range.
  const dayExpr = sql<string>`to_char(date_trunc('day', ${shareEventsTable.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
  const dayRows = await db
    .select({ date: dayExpr, count: sql<number>`COUNT(*)` })
    .from(shareEventsTable)
    .where(where)
    .groupBy(dayExpr)
    .orderBy(dayExpr);

  const byDay = dayRows.map((r) => ({ date: r.date, count: Number(r.count ?? 0) }));

  let total = 0;
  const platformTotals = new Map<string, number>();
  // slug -> { title, total, platforms: Map<platform, count> }
  const articles = new Map<string, { title: string; total: number; platforms: Map<string, number> }>();

  for (const r of rows) {
    const count = Number(r.count ?? 0);
    total += count;
    platformTotals.set(r.platform, (platformTotals.get(r.platform) ?? 0) + count);
    // Keep the most-recently-seen title for a slug (titles can change over time).
    let article = articles.get(r.slug);
    if (!article) {
      article = { title: r.title, total: 0, platforms: new Map() };
      articles.set(r.slug, article);
    }
    article.title = r.title;
    article.total += count;
    article.platforms.set(r.platform, (article.platforms.get(r.platform) ?? 0) + count);
  }

  const byPlatform = [...platformTotals.entries()]
    .map(([platform, count]) => ({ platform, count }))
    .sort((a, b) => b.count - a.count);

  const byArticle = [...articles.entries()]
    .map(([slug, a]) => ({
      slug,
      title: a.title,
      total: a.total,
      platforms: [...a.platforms.entries()]
        .map(([platform, count]) => ({ platform, count }))
        .sort((x, y) => y.count - x.count),
    }))
    .sort((a, b) => b.total - a.total);

  res.json({ total, byDay, byPlatform, byArticle });
  return;
});

export default router;
