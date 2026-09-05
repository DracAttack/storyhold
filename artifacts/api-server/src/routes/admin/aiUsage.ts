import { Router, type IRouter } from "express";
import { db, aiUsageEventsTable, articlesTable, memesTable } from "@workspace/db";
import { and, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { getAiSettings } from "../../services/aiSettings";
import { AI_TEXT_MODELS } from "../../services/aiRegistry";
import {
  isBulkJobsEnabled,
  getTodaySpendUsd,
  DAILY_BUDGET_USD,
  BULK_RUN_BUDGET_USD,
} from "../../services/aiBudget";

const router: IRouter = Router();

// Parses an optional ISO date-time query param into a Date, returning undefined
// when missing or unparseable (so a bad value degrades to "no bound" rather
// than 500-ing the report).
function parseBound(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function parseStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

// Coerce a raw SQL MIN/MAX(timestamp) aggregate (driver may hand back a Date or
// a string) into an ISO string, or null when the group had no rows.
function toIso(value: unknown): string | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// The set of text models we treat as "expensive" — the ones the whole task is
// about routing non-critical work OFF of. Derived from the registry so it stays
// in sync with the model catalog.
const EXPENSIVE_MODEL_IDS = new Set(AI_TEXT_MODELS.filter((m) => m.tier === "expensive").map((m) => m.id));

// Enrich a set of raw usage-event rows with the human-friendly article title/slug
// and, for meme-linked events, the parent article id. Batched so a page of the
// events list / top-calls list costs at most two extra queries.
async function enrichEventRows<
  T extends { articleId: string | null; memeId: string | null },
>(rows: T[]): Promise<(T & { articleTitle: string | null; articleSlug: string | null; memeArticleId: string | null })[]> {
  const articleIds = [...new Set(rows.map((r) => r.articleId).filter((v): v is string => !!v))];
  const memeIds = [...new Set(rows.map((r) => r.memeId).filter((v): v is string => !!v))];

  const articleMap = new Map<string, { title: string; slug: string }>();
  if (articleIds.length > 0) {
    const arts = await db
      .select({ id: articlesTable.id, title: articlesTable.title, slug: articlesTable.slug })
      .from(articlesTable)
      .where(inArray(articlesTable.id, articleIds));
    for (const a of arts) articleMap.set(a.id, { title: a.title, slug: a.slug });
  }

  const memeMap = new Map<string, string | null>();
  if (memeIds.length > 0) {
    const memes = await db
      .select({ id: memesTable.id, articleId: memesTable.articleId })
      .from(memesTable)
      .where(inArray(memesTable.id, memeIds));
    for (const m of memes) memeMap.set(m.id, m.articleId);
  }

  return rows.map((r) => {
    const art = r.articleId ? articleMap.get(r.articleId) : undefined;
    return {
      ...r,
      articleTitle: art?.title ?? null,
      articleSlug: art?.slug ?? null,
      memeArticleId: r.memeId ? (memeMap.get(r.memeId) ?? null) : null,
    };
  });
}

// The cost meter. Aggregates recorded AI-usage events into grand totals, a
// per-day spend series, and per-model / per-operation breakdowns. cost is the
// dollar amount that was billed at call time (numeric → cast to float here).
// An optional [from, to) date-time window plus optional model/operation filters
// narrow every aggregate; omit all for the all-time view.
router.get("/ai-usage", async (req, res) => {
  const from = parseBound(req.query.from);
  const to = parseBound(req.query.to);
  const modelFilter = parseStr(req.query.model);
  const operationFilter = parseStr(req.query.operation);

  const conditions: SQL[] = [];
  if (from) conditions.push(gte(aiUsageEventsTable.createdAt, from));
  if (to) conditions.push(lt(aiUsageEventsTable.createdAt, to));
  if (modelFilter) conditions.push(eq(aiUsageEventsTable.model, modelFilter));
  if (operationFilter) conditions.push(eq(aiUsageEventsTable.operation, operationFilter));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Grand totals.
  const [totals] = await db
    .select({
      cost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`,
      calls: sql<number>`COUNT(*)`,
      inputTokens: sql<number>`COALESCE(SUM(${aiUsageEventsTable.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${aiUsageEventsTable.outputTokens}), 0)`,
      webSearches: sql<number>`COALESCE(SUM(${aiUsageEventsTable.webSearches}), 0)`,
      images: sql<number>`COALESCE(SUM(${aiUsageEventsTable.images}), 0)`,
      // Cost carried by calls that did a web search / generated an image. This is
      // the whole call's cost (searches/images aren't billed as separate line
      // items here), so it's an upper-bound attribution, useful for "where is the
      // web-search / image money going?".
      webSearchCost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}) FILTER (WHERE ${aiUsageEventsTable.webSearches} > 0), 0)`,
      imageCost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}) FILTER (WHERE ${aiUsageEventsTable.images} > 0), 0)`,
      articleCount: sql<number>`COUNT(*) FILTER (WHERE ${aiUsageEventsTable.operation} = 'generateArticleDraft')`,
      // Spend that occurs exactly once per *newly drafted* article: the draft
      // LLM call, its hook/social pack, and its hero image. This deliberately
      // EXCLUDES the idea-generation funnel (batch — many ideas per draft),
      // dedupe/author-pick, link insertion, memes/captions/avatars, and every
      // back-catalog backfill/regeneration (which carry distinct operation
      // names). Dividing only this by the draft count keeps "avg per article"
      // a stable production figure that one-off maintenance can't inflate.
      productionCost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}) FILTER (WHERE ${aiUsageEventsTable.operation} IN ('generateArticleDraft', 'generateHooksAndSocialPack', 'generateAndStoreHeroImage')), 0)`,
    })
    .from(aiUsageEventsTable)
    .where(where);

  const totalCostUsd = Number(totals?.cost ?? 0);
  const articleCount = Number(totals?.articleCount ?? 0);
  const productionCostUsd = Number(totals?.productionCost ?? 0);

  // Spend grouped by model, highest cost first.
  const modelRows = await db
    .select({
      model: aiUsageEventsTable.model,
      cost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`,
      calls: sql<number>`COUNT(*)`,
      inputTokens: sql<number>`COALESCE(SUM(${aiUsageEventsTable.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${aiUsageEventsTable.outputTokens}), 0)`,
    })
    .from(aiUsageEventsTable)
    .where(where)
    .groupBy(aiUsageEventsTable.model);

  const byModel = modelRows
    .map((r) => ({
      model: r.model,
      costUsd: Number(r.cost ?? 0),
      calls: Number(r.calls ?? 0),
      inputTokens: Number(r.inputTokens ?? 0),
      outputTokens: Number(r.outputTokens ?? 0),
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  // Spend grouped by pipeline operation, highest cost first, with token / search
  // / image totals, per-call averages, and the first/last time it ran in-window.
  const opRows = await db
    .select({
      operation: aiUsageEventsTable.operation,
      cost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`,
      calls: sql<number>`COUNT(*)`,
      inputTokens: sql<number>`COALESCE(SUM(${aiUsageEventsTable.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${aiUsageEventsTable.outputTokens}), 0)`,
      webSearches: sql<number>`COALESCE(SUM(${aiUsageEventsTable.webSearches}), 0)`,
      images: sql<number>`COALESCE(SUM(${aiUsageEventsTable.images}), 0)`,
      firstAt: sql<string>`MIN(${aiUsageEventsTable.createdAt})`,
      lastAt: sql<string>`MAX(${aiUsageEventsTable.createdAt})`,
    })
    .from(aiUsageEventsTable)
    .where(where)
    .groupBy(aiUsageEventsTable.operation);

  const byOperation = opRows
    .map((r) => {
      const costUsd = Number(r.cost ?? 0);
      const calls = Number(r.calls ?? 0);
      const inputTokens = Number(r.inputTokens ?? 0);
      const outputTokens = Number(r.outputTokens ?? 0);
      const totalTokens = inputTokens + outputTokens;
      return {
        operation: r.operation,
        costUsd,
        calls,
        inputTokens,
        outputTokens,
        totalTokens,
        webSearches: Number(r.webSearches ?? 0),
        images: Number(r.images ?? 0),
        avgCostUsd: calls > 0 ? costUsd / calls : 0,
        avgTokens: calls > 0 ? totalTokens / calls : 0,
        firstAt: toIso(r.firstAt),
        lastAt: toIso(r.lastAt),
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd);

  // Per-day spend (UTC calendar days), ascending. Only days with at least one
  // call are returned; the client fills any gaps within the chosen range.
  const dayExpr = sql<string>`to_char(date_trunc('day', ${aiUsageEventsTable.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`;
  const dayRows = await db
    .select({
      date: dayExpr,
      cost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`,
      calls: sql<number>`COUNT(*)`,
    })
    .from(aiUsageEventsTable)
    .where(where)
    .groupBy(dayExpr)
    .orderBy(dayExpr);

  const byDay = dayRows.map((r) => ({
    date: r.date,
    costUsd: Number(r.cost ?? 0),
    calls: Number(r.calls ?? 0),
  }));

  // Headline "where did the money go?" summary, derived from the breakdowns.
  const highestAvg = [...byOperation].sort((a, b) => b.avgCostUsd - a.avgCostUsd)[0];
  const summary = {
    mostExpensiveOperation: byOperation[0]
      ? { operation: byOperation[0].operation, costUsd: byOperation[0].costUsd }
      : null,
    mostExpensiveModel: byModel[0] ? { model: byModel[0].model, costUsd: byModel[0].costUsd } : null,
    highestAvgOperation: highestAvg
      ? { operation: highestAvg.operation, avgCostUsd: highestAvg.avgCostUsd }
      : null,
    webSearchCostUsd: Number(totals?.webSearchCost ?? 0),
    imageCostUsd: Number(totals?.imageCost ?? 0),
  };

  res.json({
    totalCostUsd,
    totalCalls: Number(totals?.calls ?? 0),
    totalInputTokens: Number(totals?.inputTokens ?? 0),
    totalOutputTokens: Number(totals?.outputTokens ?? 0),
    totalWebSearches: Number(totals?.webSearches ?? 0),
    totalImages: Number(totals?.images ?? 0),
    articleCount,
    costPerArticleUsd: articleCount > 0 ? productionCostUsd / articleCount : 0,
    summary,
    byModel,
    byOperation,
    byDay,
  });
  return;
});

// Individual AI-usage events (the raw call log), newest / most-expensive first.
// Powers the operation drill-down and the "top calls" report. Filterable by
// window, operation, and model; capped at `limit` rows (default 50, max 200).
router.get("/ai-usage/events", async (req, res) => {
  const from = parseBound(req.query.from);
  const to = parseBound(req.query.to);
  const modelFilter = parseStr(req.query.model);
  const operationFilter = parseStr(req.query.operation);
  const sortParam = parseStr(req.query.sort) === "recent" ? "recent" : "cost";
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;

  const conditions: SQL[] = [];
  if (from) conditions.push(gte(aiUsageEventsTable.createdAt, from));
  if (to) conditions.push(lt(aiUsageEventsTable.createdAt, to));
  if (modelFilter) conditions.push(eq(aiUsageEventsTable.model, modelFilter));
  if (operationFilter) conditions.push(eq(aiUsageEventsTable.operation, operationFilter));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: aiUsageEventsTable.id,
      operation: aiUsageEventsTable.operation,
      model: aiUsageEventsTable.model,
      costUsd: aiUsageEventsTable.costUsd,
      inputTokens: aiUsageEventsTable.inputTokens,
      outputTokens: aiUsageEventsTable.outputTokens,
      webSearches: aiUsageEventsTable.webSearches,
      images: aiUsageEventsTable.images,
      createdAt: aiUsageEventsTable.createdAt,
      articleId: aiUsageEventsTable.articleId,
      memeId: aiUsageEventsTable.memeId,
    })
    .from(aiUsageEventsTable)
    .where(where)
    .orderBy(sortParam === "recent" ? desc(aiUsageEventsTable.createdAt) : desc(aiUsageEventsTable.costUsd))
    .limit(limit);

  const enriched = await enrichEventRows(rows);

  res.json({
    events: enriched.map((r) => ({
      id: r.id,
      operation: r.operation,
      model: r.model,
      costUsd: Number(r.costUsd ?? 0),
      inputTokens: Number(r.inputTokens ?? 0),
      outputTokens: Number(r.outputTokens ?? 0),
      webSearches: Number(r.webSearches ?? 0),
      images: Number(r.images ?? 0),
      createdAt: toIso(r.createdAt),
      articleId: r.articleId,
      articleTitle: r.articleTitle,
      articleSlug: r.articleSlug,
      memeId: r.memeId,
      memeArticleId: r.memeArticleId,
    })),
  });
  return;
});

// Model-routing overview for the AI Control page: every admin-controllable
// function with its resolved model + routing flags, plus per-function cost
// warnings and the current bulk-jobs / budget state. Read-only; changing a
// model routing goes through PATCH /admin/ai-settings/{key}.
router.get("/ai-usage/routing", async (_req, res) => {
  const settings = await getAiSettings();
  const todaySpendUsd = await getTodaySpendUsd();

  const functions = settings.functions.map((f) => {
    const warnings: string[] = [];
    if (!f.usesImages) {
      const onExpensive = EXPENSIVE_MODEL_IDS.has(f.model);
      if (f.bulkEligible && onExpensive) {
        warnings.push("Runs in bulk/back-catalog loops on an expensive model — consider a cheaper model.");
      }
      if (f.bulkEligible && f.usesWebSearch) {
        warnings.push("Runs in bulk loops with web search on — web-search context re-billing is a top cost driver.");
      }
    }
    return {
      key: f.key,
      label: f.label,
      group: f.group,
      enabled: f.enabled,
      model: f.model,
      defaultModel: f.defaultModel,
      modelOverride: f.modelOverride,
      costTier: f.costTier,
      bulkEligible: f.bulkEligible,
      usesWebSearch: f.usesWebSearch,
      usesImages: f.usesImages,
      perAuthorModel: f.perAuthorModel,
      warnings,
    };
  });

  res.json({
    models: AI_TEXT_MODELS,
    functions,
    budget: {
      bulkJobsEnabled: isBulkJobsEnabled(),
      dailyBudgetUsd: DAILY_BUDGET_USD,
      bulkRunBudgetUsd: BULK_RUN_BUDGET_USD,
      todaySpendUsd,
    },
  });
  return;
});

// Per-article cost breakdown: sum all ai_usage_events linked to this article.
router.get("/ai-usage/article/:articleId", async (req, res) => {
  const { articleId } = req.params;
  const [article] = await db
    .select({ id: articlesTable.id, title: articlesTable.title, slug: articlesTable.slug })
    .from(articlesTable)
    .where(eq(articlesTable.id, articleId))
    .limit(1);
  if (!article) {
    res.status(404).json({ error: "Article not found" });
    return;
  }
  const [totals] = await db
    .select({
      cost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`,
      calls: sql<number>`COUNT(*)`,
      inputTokens: sql<number>`COALESCE(SUM(${aiUsageEventsTable.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${aiUsageEventsTable.outputTokens}), 0)`,
      images: sql<number>`COALESCE(SUM(${aiUsageEventsTable.images}), 0)`,
    })
    .from(aiUsageEventsTable)
    .where(eq(aiUsageEventsTable.articleId, articleId));
  const opRows = await db
    .select({
      operation: aiUsageEventsTable.operation,
      cost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`,
      calls: sql<number>`COUNT(*)`,
    })
    .from(aiUsageEventsTable)
    .where(eq(aiUsageEventsTable.articleId, articleId))
    .groupBy(aiUsageEventsTable.operation)
    .orderBy(desc(sql`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`));
  res.json({
    articleId: article.id,
    title: article.title,
    slug: article.slug,
    totalCostUsd: Number(totals?.cost ?? 0),
    totalCalls: Number(totals?.calls ?? 0),
    totalInputTokens: Number(totals?.inputTokens ?? 0),
    totalOutputTokens: Number(totals?.outputTokens ?? 0),
    totalImages: Number(totals?.images ?? 0),
    byOperation: opRows.map((r) => ({
      operation: r.operation,
      costUsd: Number(r.cost ?? 0),
      calls: Number(r.calls ?? 0),
    })),
  });
  return;
});

// Per-meme cost breakdown: sum all ai_usage_events linked to this meme.
router.get("/ai-usage/meme/:memeId", async (req, res) => {
  const { memeId } = req.params;
  const [meme] = await db
    .select({ id: memesTable.id, articleId: memesTable.articleId, estimatedCostUsd: memesTable.estimatedCostUsd })
    .from(memesTable)
    .where(eq(memesTable.id, memeId))
    .limit(1);
  if (!meme) {
    res.status(404).json({ error: "Meme not found" });
    return;
  }
  const [totals] = await db
    .select({
      cost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`,
      calls: sql<number>`COUNT(*)`,
      inputTokens: sql<number>`COALESCE(SUM(${aiUsageEventsTable.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${aiUsageEventsTable.outputTokens}), 0)`,
      images: sql<number>`COALESCE(SUM(${aiUsageEventsTable.images}), 0)`,
    })
    .from(aiUsageEventsTable)
    .where(eq(aiUsageEventsTable.memeId, memeId));
  const opRows = await db
    .select({
      operation: aiUsageEventsTable.operation,
      cost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`,
      calls: sql<number>`COUNT(*)`,
    })
    .from(aiUsageEventsTable)
    .where(eq(aiUsageEventsTable.memeId, memeId))
    .groupBy(aiUsageEventsTable.operation)
    .orderBy(desc(sql`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`));
  res.json({
    memeId: meme.id,
    articleId: meme.articleId,
    trackedCostUsd: Number(totals?.cost ?? 0),
    legacyCostUsd: Number(meme.estimatedCostUsd ?? 0),
    totalCalls: Number(totals?.calls ?? 0),
    totalInputTokens: Number(totals?.inputTokens ?? 0),
    totalOutputTokens: Number(totals?.outputTokens ?? 0),
    totalImages: Number(totals?.images ?? 0),
    byOperation: opRows.map((r) => ({
      operation: r.operation,
      costUsd: Number(r.cost ?? 0),
      calls: Number(r.calls ?? 0),
    })),
  });
  return;
});

// Day drill-down: per-operation + per-model totals, the top individual calls,
// top 10 articles + top 10 memes, and which operations still ran on an expensive
// model — for a single UTC calendar day. Requires ?date=YYYY-MM-DD.
router.get("/ai-usage/day-detail", async (req, res) => {
  const dateStr = typeof req.query.date === "string" ? req.query.date.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    res.status(400).json({ error: "date query param required (YYYY-MM-DD)" });
    return;
  }
  const from = new Date(`${dateStr}T00:00:00Z`);
  const to = new Date(`${dateStr}T00:00:00Z`);
  to.setUTCDate(to.getUTCDate() + 1);
  const where = and(gte(aiUsageEventsTable.createdAt, from), lt(aiUsageEventsTable.createdAt, to));

  const [totals] = await db
    .select({
      cost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`,
      calls: sql<number>`COUNT(*)`,
    })
    .from(aiUsageEventsTable)
    .where(where);

  const opRows = await db
    .select({
      operation: aiUsageEventsTable.operation,
      cost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`,
      calls: sql<number>`COUNT(*)`,
    })
    .from(aiUsageEventsTable)
    .where(where)
    .groupBy(aiUsageEventsTable.operation)
    .orderBy(desc(sql`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`));

  const modelRows = await db
    .select({
      model: aiUsageEventsTable.model,
      cost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`,
      calls: sql<number>`COUNT(*)`,
    })
    .from(aiUsageEventsTable)
    .where(where)
    .groupBy(aiUsageEventsTable.model)
    .orderBy(desc(sql`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`));

  // Operations that ran on an expensive model this day, with how much of their
  // spend was on that expensive model — the "still on Sonnet/Opus" watch list.
  const expensiveIds = [...EXPENSIVE_MODEL_IDS];
  const sonnetOpRows =
    expensiveIds.length > 0
      ? await db
          .select({
            operation: aiUsageEventsTable.operation,
            model: aiUsageEventsTable.model,
            cost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`,
            calls: sql<number>`COUNT(*)`,
          })
          .from(aiUsageEventsTable)
          .where(and(where, inArray(aiUsageEventsTable.model, expensiveIds)))
          .groupBy(aiUsageEventsTable.operation, aiUsageEventsTable.model)
          .orderBy(desc(sql`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`))
      : [];

  const articleRows = await db
    .select({
      articleId: aiUsageEventsTable.articleId,
      cost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`,
      calls: sql<number>`COUNT(*)`,
    })
    .from(aiUsageEventsTable)
    .where(and(where, sql`${aiUsageEventsTable.articleId} IS NOT NULL`))
    .groupBy(aiUsageEventsTable.articleId)
    .orderBy(desc(sql`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`))
    .limit(10);

  const memeRows = await db
    .select({
      memeId: aiUsageEventsTable.memeId,
      cost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`,
      calls: sql<number>`COUNT(*)`,
    })
    .from(aiUsageEventsTable)
    .where(and(where, sql`${aiUsageEventsTable.memeId} IS NOT NULL`))
    .groupBy(aiUsageEventsTable.memeId)
    .orderBy(desc(sql`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`))
    .limit(10);

  // Top 20 individual calls this day (most expensive first), enriched for links.
  const topCallRows = await db
    .select({
      id: aiUsageEventsTable.id,
      operation: aiUsageEventsTable.operation,
      model: aiUsageEventsTable.model,
      costUsd: aiUsageEventsTable.costUsd,
      inputTokens: aiUsageEventsTable.inputTokens,
      outputTokens: aiUsageEventsTable.outputTokens,
      webSearches: aiUsageEventsTable.webSearches,
      images: aiUsageEventsTable.images,
      createdAt: aiUsageEventsTable.createdAt,
      articleId: aiUsageEventsTable.articleId,
      memeId: aiUsageEventsTable.memeId,
    })
    .from(aiUsageEventsTable)
    .where(where)
    .orderBy(desc(aiUsageEventsTable.costUsd))
    .limit(20);
  const topCalls = await enrichEventRows(topCallRows);

  // Enrich article rows with title+slug
  const articleIds = articleRows.map((r) => r.articleId).filter(Boolean) as string[];
  const articlesData =
    articleIds.length > 0
      ? await db
          .select({ id: articlesTable.id, title: articlesTable.title, slug: articlesTable.slug })
          .from(articlesTable)
          .where(inArray(articlesTable.id, articleIds))
      : [];
  const articleMap = new Map(articlesData.map((a) => [a.id, a]));

  // Enrich meme rows with articleId
  const memeIds = memeRows.map((r) => r.memeId).filter(Boolean) as string[];
  const memesData =
    memeIds.length > 0
      ? await db
          .select({ id: memesTable.id, articleId: memesTable.articleId })
          .from(memesTable)
          .where(inArray(memesTable.id, memeIds))
      : [];
  const memeMap = new Map(memesData.map((m) => [m.id, m]));

  res.json({
    date: dateStr,
    totalCostUsd: Number(totals?.cost ?? 0),
    totalCalls: Number(totals?.calls ?? 0),
    byOperation: opRows.map((r) => ({
      operation: r.operation,
      costUsd: Number(r.cost ?? 0),
      calls: Number(r.calls ?? 0),
    })),
    byModel: modelRows.map((r) => ({
      model: r.model,
      costUsd: Number(r.cost ?? 0),
      calls: Number(r.calls ?? 0),
    })),
    expensiveModelOperations: sonnetOpRows.map((r) => ({
      operation: r.operation,
      model: r.model,
      costUsd: Number(r.cost ?? 0),
      calls: Number(r.calls ?? 0),
    })),
    topCalls: topCalls.map((r) => ({
      id: r.id,
      operation: r.operation,
      model: r.model,
      costUsd: Number(r.costUsd ?? 0),
      inputTokens: Number(r.inputTokens ?? 0),
      outputTokens: Number(r.outputTokens ?? 0),
      webSearches: Number(r.webSearches ?? 0),
      images: Number(r.images ?? 0),
      createdAt: toIso(r.createdAt),
      articleId: r.articleId,
      articleTitle: r.articleTitle,
      articleSlug: r.articleSlug,
      memeId: r.memeId,
      memeArticleId: r.memeArticleId,
    })),
    topArticles: articleRows.map((r) => ({
      articleId: r.articleId,
      title: articleMap.get(r.articleId!)?.title ?? null,
      slug: articleMap.get(r.articleId!)?.slug ?? null,
      costUsd: Number(r.cost ?? 0),
      calls: Number(r.calls ?? 0),
    })),
    topMemes: memeRows.map((r) => ({
      memeId: r.memeId,
      articleId: memeMap.get(r.memeId!)?.articleId ?? null,
      costUsd: Number(r.cost ?? 0),
      calls: Number(r.calls ?? 0),
    })),
  });
  return;
});

export default router;
