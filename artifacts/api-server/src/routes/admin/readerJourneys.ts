import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";

const router: IRouter = Router();

// Parses an optional ISO date-time query param into a Date, returning undefined
// when missing or unparseable (so a bad value degrades to "no bound" rather
// than 500-ing the report). Mirrors the admin shares report.
function parseBound(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Aggregated, ANONYMOUS reader-journey report for the admin "Reader Journeys"
// view. All metrics are derived from page_views (threaded by the anonymous
// visitor/session UUIDs), internal_clicks and swipe_events — there is no PII
// anywhere. An optional [from, to) UTC window (`from` inclusive, `to` exclusive)
// filters every aggregate; omit both for all time.
//
// recirculation = sessions that viewed 2+ distinct articles / sessions with at
// least one article view.
router.get("/reader-journeys", async (req, res) => {
  const from = parseBound(req.query.from);
  const to = parseBound(req.query.to);

  // Reusable [from,to) range fragments. `pvRange` also requires a session id so
  // legacy (pre-tracking) rows never pollute the session math.
  const rangeParts = (): SQL[] => {
    const parts: SQL[] = [];
    if (from) parts.push(sql`created_at >= ${from}`);
    if (to) parts.push(sql`created_at < ${to}`);
    return parts;
  };
  const pvRange = sql.join([sql`session_id IS NOT NULL`, ...rangeParts()], sql` AND `);
  const rangeOnly = sql.join([sql`TRUE`, ...rangeParts()], sql` AND `);

  // Shared page_views CTE body (no WITH keyword) so each query reuses the same
  // window-filtered, session-scoped view set.
  const pvCte = sql`pv AS (
    SELECT session_id, visitor_id, article_slug, previous_slug, entry_slug, view_sequence, created_at
    FROM page_views
    WHERE ${pvRange}
  )`;

  const [
    totalsRes,
    returningRes,
    sessionAggRes,
    depthRes,
    entryRes,
    pathsRes,
    transitionsRes,
    placementRes,
    rankRes,
    swipeRes,
  ] = await Promise.all([
    // Distinct anonymous visitors + distinct sessions.
    db.execute(sql`
      WITH ${pvCte}
      SELECT
        COUNT(DISTINCT visitor_id) FILTER (WHERE visitor_id IS NOT NULL) AS anonymous_visitors,
        COUNT(DISTINCT session_id) AS sessions
      FROM pv
    `),
    // Visitors seen across 2+ distinct sessions in the window.
    db.execute(sql`
      WITH ${pvCte}
      SELECT COUNT(*) AS returning FROM (
        SELECT visitor_id FROM pv WHERE visitor_id IS NOT NULL
        GROUP BY visitor_id HAVING COUNT(DISTINCT session_id) >= 2
      ) t
    `),
    // Per-session distinct-article counts → recirculation + averages.
    db.execute(sql`
      WITH ${pvCte},
      sess AS (SELECT session_id, COUNT(DISTINCT article_slug) AS dv FROM pv GROUP BY session_id)
      SELECT
        COUNT(*) AS sessions_with_view,
        COUNT(*) FILTER (WHERE dv >= 2) AS recirculating,
        COALESCE(AVG(dv), 0) AS avg_views
      FROM sess
    `),
    // Session-depth distribution (distinct articles viewed, bucketed 1..4+).
    db.execute(sql`
      WITH ${pvCte},
      sess AS (SELECT session_id, COUNT(DISTINCT article_slug) AS dv FROM pv GROUP BY session_id)
      SELECT LEAST(dv, 4) AS views, COUNT(*) AS sessions
      FROM sess GROUP BY LEAST(dv, 4) ORDER BY 1
    `),
    // Top entry articles by continuation rate (entered → viewed a 2nd article).
    db.execute(sql`
      WITH ${pvCte},
      sess AS (SELECT session_id, COUNT(DISTINCT article_slug) AS dv, MAX(entry_slug) AS entry FROM pv GROUP BY session_id),
      agg AS (
        SELECT entry AS slug, COUNT(*) AS sessions, COUNT(*) FILTER (WHERE dv >= 2) AS continued
        FROM sess WHERE entry IS NOT NULL GROUP BY entry
      )
      SELECT a.slug, COALESCE(art.title, a.slug) AS title, a.sessions, a.continued
      FROM agg a
      LEFT JOIN articles art ON art.slug = a.slug
      ORDER BY a.continued::float / NULLIF(a.sessions, 0) DESC NULLS LAST, a.sessions DESC
      LIMIT 15
    `),
    // Most common ordered reading paths (first-seen order, repeats collapsed).
    db.execute(sql`
      WITH ${pvCte},
      firstseen AS (
        SELECT session_id, article_slug,
               MIN(COALESCE(view_sequence, 2147483647)) AS seq, MIN(created_at) AS ts
        FROM pv GROUP BY session_id, article_slug
      ),
      paths AS (
        SELECT session_id, array_agg(article_slug ORDER BY seq, ts) AS path
        FROM firstseen GROUP BY session_id
      )
      SELECT path, COUNT(*) AS count
      FROM paths WHERE array_length(path, 1) >= 2
      GROUP BY path ORDER BY count DESC LIMIT 15
    `),
    // Most common article→article hops.
    db.execute(sql`
      WITH ${pvCte}
      SELECT previous_slug AS from_slug, article_slug AS to_slug, COUNT(*) AS count
      FROM pv WHERE previous_slug IS NOT NULL
      GROUP BY previous_slug, article_slug ORDER BY count DESC LIMIT 20
    `),
    // Internal recommendation clicks by placement.
    db.execute(sql`
      SELECT placement, COUNT(*) AS count FROM internal_clicks
      WHERE ${rangeOnly} GROUP BY placement ORDER BY count DESC
    `),
    // Internal recommendation clicks by recommendation rank.
    db.execute(sql`
      SELECT recommendation_rank AS rank, COUNT(*) AS count FROM internal_clicks
      WHERE ${rangeOnly} AND recommendation_rank IS NOT NULL
      GROUP BY recommendation_rank ORDER BY recommendation_rank
    `),
    // Swipe-prompt funnel.
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'impression') AS impressions,
        COUNT(*) FILTER (WHERE event_type = 'activation') AS activations,
        COUNT(*) FILTER (WHERE event_type = 'activation' AND method = 'swipe') AS swipe_activations,
        COUNT(*) FILTER (WHERE event_type = 'activation' AND method = 'click') AS click_activations,
        COUNT(*) FILTER (WHERE event_type = 'dismissal') AS dismissals
      FROM swipe_events WHERE ${rangeOnly}
    `),
  ]);

  const totals = (totalsRes.rows[0] ?? {}) as Record<string, unknown>;
  const sessionAgg = (sessionAggRes.rows[0] ?? {}) as Record<string, unknown>;
  const swipeRow = (swipeRes.rows[0] ?? {}) as Record<string, unknown>;

  const sessionsWithView = num(sessionAgg.sessions_with_view);
  const recirculatingSessions = num(sessionAgg.recirculating);
  const impressions = num(swipeRow.impressions);
  const activations = num(swipeRow.activations);

  res.json({
    anonymousVisitors: num(totals.anonymous_visitors),
    returningVisitors: num((returningRes.rows[0] as Record<string, unknown> | undefined)?.returning),
    sessions: num(totals.sessions),
    sessionsWithView,
    recirculatingSessions,
    recirculationRate: sessionsWithView > 0 ? recirculatingSessions / sessionsWithView : 0,
    avgViewsPerSession: num(sessionAgg.avg_views),
    sessionDepth: depthRes.rows.map((r) => {
      const row = r as Record<string, unknown>;
      return { views: num(row.views), sessions: num(row.sessions) };
    }),
    entryArticles: entryRes.rows.map((r) => {
      const row = r as Record<string, unknown>;
      const sessions = num(row.sessions);
      const continued = num(row.continued);
      return {
        slug: String(row.slug ?? ""),
        title: String(row.title ?? row.slug ?? ""),
        sessions,
        continued,
        continuationRate: sessions > 0 ? continued / sessions : 0,
      };
    }),
    topPaths: pathsRes.rows.map((r) => {
      const row = r as Record<string, unknown>;
      const path = Array.isArray(row.path) ? (row.path as unknown[]).map((s) => String(s)) : [];
      return { path, count: num(row.count) };
    }),
    topTransitions: transitionsRes.rows.map((r) => {
      const row = r as Record<string, unknown>;
      return { fromSlug: String(row.from_slug ?? ""), toSlug: String(row.to_slug ?? ""), count: num(row.count) };
    }),
    clicksByPlacement: placementRes.rows.map((r) => {
      const row = r as Record<string, unknown>;
      return { placement: String(row.placement ?? ""), count: num(row.count) };
    }),
    clicksByRank: rankRes.rows.map((r) => {
      const row = r as Record<string, unknown>;
      return { rank: num(row.rank), count: num(row.count) };
    }),
    swipe: {
      impressions,
      activations,
      swipeActivations: num(swipeRow.swipe_activations),
      clickActivations: num(swipeRow.click_activations),
      dismissals: num(swipeRow.dismissals),
      activationRate: impressions > 0 ? activations / impressions : 0,
    },
  });
  return;
});

export default router;
