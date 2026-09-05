import {
  db,
  articlesTable,
  articleSourcesTable,
  sourceDocumentsTable,
  sourceIngestQueueTable,
  type ArticleSourceRole,
  type ArticleSourceStatus,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, isNull, isNotNull, lte, or, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { classifySourceRole, isCitationIntermediaryUrl } from "./sourceAuthority";
import { enqueueUrl } from "./sourceIngestQueue";
import { recordMarker, recordRejected } from "./trendMarkers";
import { extractOutboundLinks, domainOf } from "./backCatalogLinks";
import { snapshotCitationFromVaultDoc, copyVaultCitationMetadata } from "./citationMetadata";

// --- Back Catalog Source Harvest (Task #228) ----------------------------
// Scan EXISTING article bodies for outbound source links, canonicalize + dedupe
// them, classify each with the SAME three-way role classifier the live pipeline
// uses (#227), and route them into the EXISTING plumbing:
//   • evidence     → the Source Vault ingest queue (discovered_via=back_catalog)
//   • trend_marker → recorded as a social velocity marker
//   • rejected_junk→ recorded thin for transparency
// Every observed link also writes ONE row to `article_sources`, making the
// article→source relationship first-class for downstream features (#229).
//
// The scan itself is DB-only and free: it reuses the idempotent enqueue/record
// helpers and never fetches, embeds, drafts, rewrites, or calls paid AI. The
// actual fetch+extract+embed happens later, on the existing async queue drain,
// under its own VAULT budget guard. This module NEVER calls web_search.

// Hard per-run caps so a manual "scan now" stays fast and bounded regardless of
// the requested batch size.
const MAX_ARTICLES_PER_RUN = 25;
const MAX_URLS_PER_RUN = 100;
// How many classified links to return inline for the admin results table.
const SAMPLE_LIMIT = 60;

export type HarvestArticleStatus = "draft" | "scheduled" | "published" | "all";

export interface HarvestOptions {
  /** Compute the outcome WITHOUT writing anything (no enqueue/record/insert). */
  dryRun?: boolean;
  /** Articles to scan this run (clamped to MAX_ARTICLES_PER_RUN). */
  batchSize?: number;
  /** Only scan articles created on/after this ISO date. */
  dateFrom?: string | null;
  /** Only scan articles created on/before this ISO date. */
  dateTo?: string | null;
  /** Which article statuses to scan (default "published"). */
  status?: HarvestArticleStatus;
}

export interface HarvestSampleItem {
  articleSlug: string;
  url: string;
  domain: string;
  role: ArticleSourceRole;
  tier: string;
  status: ArticleSourceStatus;
}

export interface HarvestReport {
  dryRun: boolean;
  articlesScanned: number;
  articlesWithLinks: number;
  linksFound: number;
  queued: number;
  alreadyIngested: number;
  duplicatesSkipped: number;
  markers: number;
  rejected: number;
  urlCapReached: boolean;
  estCostUsd: number;
  sample: HarvestSampleItem[];
}

/** Look up whether a canonical URL is already known to the vault. */
async function lookupExisting(
  url: string,
): Promise<{ documentId: string | null; inQueue: boolean }> {
  const [doc] = await db
    .select({ id: sourceDocumentsTable.id })
    .from(sourceDocumentsTable)
    .where(or(eq(sourceDocumentsTable.url, url), eq(sourceDocumentsTable.canonicalUrl, url)))
    .limit(1);
  if (doc) return { documentId: doc.id, inQueue: true };
  const [q] = await db
    .select({ id: sourceIngestQueueTable.id })
    .from(sourceIngestQueueTable)
    .where(eq(sourceIngestQueueTable.url, url))
    .limit(1);
  return { documentId: null, inQueue: Boolean(q) };
}

// --- Shared per-article link routing ------------------------------------
// One canonical implementation of "route every outbound link in this body into
// the source graph", used by the post-draft hook, the admin source-link
// backfill, and the daily drift repair. Idempotent: rows upsert on
// (article_id, url) and the enqueue/record helpers dedupe internally.

export interface RouteLinksResult {
  linksFound: number;
  routed: number;
  allRouted: boolean;
}

/**
 * Classify + route every outbound link in `body` and upsert its
 * `article_sources` row. When EVERY link routed cleanly, stamps
 * `sources_harvested_at` (all-or-null rule, mirrors harvestBackCatalog).
 * Never throws — per-link failures are logged and reported via `allRouted`.
 */
export async function routeArticleLinksIntoGraph(
  articleId: string,
  body: unknown,
  beatSlug: string | null,
): Promise<RouteLinksResult> {
  const links = extractOutboundLinks((body as Parameters<typeof extractOutboundLinks>[0]) ?? []);
  const result: RouteLinksResult = { linksFound: links.length, routed: 0, allRouted: true };
  if (links.length === 0) return result;

  for (const link of links) {
    const url = link.url;
    const domain = domainOf(url);
    const classification = classifySourceRole(url);
    const role: ArticleSourceRole = classification.role;
    const tier = classification.tier;
    let status: ArticleSourceStatus;
    let sourceDocumentId: string | null = null;
    try {
      if (role === "evidence") {
        const existing = await lookupExisting(url);
        if (existing.documentId) {
          status = "ingested";
          sourceDocumentId = existing.documentId;
        } else {
          status = "queued";
          if (!existing.inQueue) {
            await enqueueUrl(url, {
              discoveredVia: "back_catalog",
              leadSnippet: link.anchorText || null,
              beatSlug,
              reviveTerminal: false,
            });
          }
        }
      } else if (role === "trend_marker") {
        status = "marker";
        await recordMarker({
          url,
          title: link.anchorText || null,
          beatSlug,
          discoveredVia: "back_catalog",
          platform: classification.platform ?? undefined,
        });
      } else {
        status = "rejected";
        await recordRejected({
          url,
          reason: classification.reason,
          beatSlug,
          discoveredVia: "back_catalog",
        });
      }
      // On re-route of the same (article, url), refresh the classification but
      // NEVER clear an already-linked document with a null.
      const conflictSet: Record<string, unknown> = {
        domain,
        role,
        tier,
        status,
        anchorText: link.anchorText || null,
        isIntermediary: isCitationIntermediaryUrl(url),
        updatedAt: new Date(),
      };
      if (sourceDocumentId !== null) conflictSet.sourceDocumentId = sourceDocumentId;
      await db
        .insert(articleSourcesTable)
        .values({
          articleId,
          url,
          domain,
          role,
          tier,
          status,
          sourceDocumentId,
          anchorText: link.anchorText || null,
          isIntermediary: isCitationIntermediaryUrl(url),
        })
        .onConflictDoUpdate({
          target: [articleSourcesTable.articleId, articleSourcesTable.url],
          set: conflictSet,
        });
      result.routed += 1;
    } catch (err) {
      result.allRouted = false;
      logger.warn({ err, url, articleId }, "routeArticleLinks: link route failed");
    }
  }

  if (result.allRouted) {
    await db
      .update(articlesTable)
      .set({ sourcesHarvestedAt: new Date() })
      .where(eq(articlesTable.id, articleId));
  }
  return result;
}

// --- Source-graph drift repair -------------------------------------------
// An article's body can gain outbound links AFTER its one-time harvest ran
// (admin source-link backfill, editor edits). Historically those late links
// never reached article_sources — the harvest gate is `sources_harvested_at IS
// NULL`, so a stamped article is never re-scanned — leaving the public
// References list missing sources that are plainly linked in the prose. This
// sweep detects that drift (body links absent from the graph) and routes just
// the drifted articles through the shared routing above. DB-only, free,
// idempotent; runs daily from back-catalogue maintenance.

export interface DriftRepairReport {
  articlesScanned: number;
  articlesRepaired: number;
  linksRouted: number;
}

export async function repairSourceGraphDrift(maxRepairs = 25): Promise<DriftRepairReport> {
  const report: DriftRepairReport = { articlesScanned: 0, articlesRepaired: 0, linksRouted: 0 };

  const articles = await db
    .select({
      id: articlesTable.id,
      slug: articlesTable.slug,
      body: articlesTable.body,
      categorySlug: articlesTable.categorySlug,
    })
    .from(articlesTable)
    .where(and(eq(articlesTable.status, "published"), isNotNull(articlesTable.sourcesHarvestedAt)));
  if (articles.length === 0) return report;

  // One query for the whole known graph of these articles, grouped in memory.
  const known = new Map<string, Set<string>>();
  const rows = await db
    .select({ articleId: articleSourcesTable.articleId, url: articleSourcesTable.url })
    .from(articleSourcesTable)
    .where(inArray(articleSourcesTable.articleId, articles.map((a) => a.id)));
  for (const r of rows) {
    let set = known.get(r.articleId);
    if (!set) known.set(r.articleId, (set = new Set()));
    set.add(r.url);
  }

  const repairedIds: string[] = [];
  for (const article of articles) {
    report.articlesScanned += 1;
    const links = extractOutboundLinks(article.body ?? []);
    if (links.length === 0) continue;
    const have = known.get(article.id) ?? new Set<string>();
    const missing = links.filter((l) => !have.has(l.url));
    if (missing.length === 0) continue;

    const routed = await routeArticleLinksIntoGraph(
      article.id,
      article.body,
      article.categorySlug || null,
    );
    report.articlesRepaired += 1;
    report.linksRouted += missing.length;
    repairedIds.push(article.id);
    logger.info(
      { articleId: article.id, slug: article.slug, missing: missing.length, routed },
      "repairSourceGraphDrift: routed late-added body links",
    );
    if (report.articlesRepaired >= maxRepairs) break;
  }

  if (repairedIds.length > 0) {
    // Snapshot true-citation metadata from any vault docs the new rows matched —
    // free, idempotent, DB-only (same follow-up as the post-draft hook).
    try {
      await copyVaultCitationMetadata();
    } catch (err) {
      logger.warn({ err }, "repairSourceGraphDrift: citation metadata copy failed");
    }
  }
  return report;
}

/**
 * Harvest a bounded batch of never-scanned articles. Selects articles with
 * `sources_harvested_at IS NULL` (matching the requested status/date window),
 * extracts + classifies their outbound links, routes each into the existing
 * plumbing, and records the article→source rows. Marks each scanned article
 * `sources_harvested_at = now` (live runs only) so the catalog advances and a
 * re-run never re-scans the same article. Dry runs write nothing.
 */
export async function harvestBackCatalog(opts: HarvestOptions = {}): Promise<HarvestReport> {
  const dryRun = opts.dryRun ?? false;
  const batchSize = Math.min(Math.max(opts.batchSize ?? MAX_ARTICLES_PER_RUN, 1), MAX_ARTICLES_PER_RUN);
  const statusFilter: HarvestArticleStatus = opts.status ?? "published";

  const where = [isNull(articlesTable.sourcesHarvestedAt)];
  if (statusFilter !== "all") {
    where.push(eq(articlesTable.status, statusFilter));
  }
  if (opts.dateFrom) {
    const from = new Date(opts.dateFrom);
    if (!Number.isNaN(from.getTime())) where.push(gte(articlesTable.createdAt, from));
  }
  if (opts.dateTo) {
    const to = new Date(opts.dateTo);
    if (!Number.isNaN(to.getTime())) where.push(lte(articlesTable.createdAt, to));
  }

  const articles = await db
    .select({
      id: articlesTable.id,
      slug: articlesTable.slug,
      body: articlesTable.body,
      categorySlug: articlesTable.categorySlug,
    })
    .from(articlesTable)
    .where(and(...where))
    .orderBy(desc(articlesTable.createdAt))
    .limit(batchSize);

  const report: HarvestReport = {
    dryRun,
    articlesScanned: 0,
    articlesWithLinks: 0,
    linksFound: 0,
    queued: 0,
    alreadyIngested: 0,
    duplicatesSkipped: 0,
    markers: 0,
    rejected: 0,
    urlCapReached: false,
    estCostUsd: 0,
    sample: [],
  };

  let urlsProcessed = 0;

  for (const article of articles) {
    if (urlsProcessed >= MAX_URLS_PER_RUN) {
      report.urlCapReached = true;
      break;
    }
    report.articlesScanned += 1;
    const links = extractOutboundLinks(article.body ?? []);
    if (links.length > 0) report.articlesWithLinks += 1;
    const beatSlug = article.categorySlug || null;

    // Track whether EVERY link in this article was fully routed this run. If the
    // URL cap truncates the article mid-way, or any link's routing/persistence
    // throws, we must NOT mark the article harvested — otherwise the unprocessed
    // links are lost forever (the selection gate is `sources_harvested_at IS
    // NULL`). Leaving it null lets the next run pick the article back up.
    let articleComplete = true;

    for (const link of links) {
      if (urlsProcessed >= MAX_URLS_PER_RUN) {
        report.urlCapReached = true;
        articleComplete = false;
        break;
      }
      urlsProcessed += 1;
      report.linksFound += 1;

      const url = link.url;
      const domain = domainOf(url);
      const classification = classifySourceRole(url);
      const role = classification.role;
      const tier = classification.tier;
      let status: ArticleSourceStatus;
      let sourceDocumentId: string | null = null;

      try {
        if (role === "evidence") {
          const existing = await lookupExisting(url);
          if (existing.documentId) {
            status = "ingested";
            sourceDocumentId = existing.documentId;
            report.alreadyIngested += 1;
          } else if (existing.inQueue) {
            status = "queued";
            report.duplicatesSkipped += 1;
          } else {
            status = "queued";
            if (!dryRun) {
              await enqueueUrl(url, {
                discoveredVia: "back_catalog",
                leadSnippet: link.anchorText || null,
                beatSlug,
                reviveTerminal: false,
              });
            }
            report.queued += 1;
          }
        } else if (role === "trend_marker") {
          status = "marker";
          if (!dryRun) {
            await recordMarker({
              url,
              title: link.anchorText || null,
              beatSlug,
              discoveredVia: "back_catalog",
              platform: classification.platform ?? undefined,
            });
          }
          report.markers += 1;
        } else {
          status = "rejected";
          if (!dryRun) {
            await recordRejected({
              url,
              reason: classification.reason,
              beatSlug,
              discoveredVia: "back_catalog",
            });
          }
          report.rejected += 1;
        }

        if (!dryRun) {
          // On re-harvest of the same (article, url), refresh the classification
          // but NEVER clear an already-linked document with a null — only set the
          // document id when we actually resolved one this pass.
          const conflictSet: Record<string, unknown> = {
            domain,
            role,
            tier,
            status,
            anchorText: link.anchorText || null,
            updatedAt: new Date(),
          };
          if (sourceDocumentId !== null) conflictSet.sourceDocumentId = sourceDocumentId;
          await db
            .insert(articleSourcesTable)
            .values({
              articleId: article.id,
              url,
              domain,
              role,
              tier,
              status,
              sourceDocumentId,
              anchorText: link.anchorText || null,
            })
            .onConflictDoUpdate({
              target: [articleSourcesTable.articleId, articleSourcesTable.url],
              set: conflictSet,
            });
        }

        if (report.sample.length < SAMPLE_LIMIT) {
          report.sample.push({ articleSlug: article.slug, url, domain, role, tier, status });
        }
      } catch (err) {
        // Persistence/routing failed for this link — leave the article un-marked
        // so a later run retries it (enqueue/record helpers are idempotent).
        articleComplete = false;
        logger.warn({ err, url, articleId: article.id }, "backCatalogHarvest: link route failed");
      }
    }

    if (!dryRun && articleComplete) {
      await db
        .update(articlesTable)
        .set({ sourcesHarvestedAt: new Date() })
        .where(eq(articlesTable.id, article.id));
    }
  }

  logger.info(
    {
      dryRun,
      articlesScanned: report.articlesScanned,
      linksFound: report.linksFound,
      queued: report.queued,
      alreadyIngested: report.alreadyIngested,
      markers: report.markers,
      rejected: report.rejected,
    },
    "backCatalogHarvest: run complete",
  );
  return report;
}

/**
 * Link harvested evidence rows that are still awaiting ingest to the
 * source_documents they resolved to, once the async queue has produced them.
 * Cheap + idempotent: run after each queue drain. Bounded by `limit`.
 */
export async function reconcileHarvestedSources(limit = 200): Promise<number> {
  const pending = await db
    .select({ id: articleSourcesTable.id, url: articleSourcesTable.url })
    .from(articleSourcesTable)
    .where(and(eq(articleSourcesTable.role, "evidence"), isNull(articleSourcesTable.sourceDocumentId)))
    .limit(Math.min(Math.max(limit, 1), 1000));
  if (pending.length === 0) return 0;

  let linked = 0;
  for (const row of pending) {
    try {
      const [doc] = await db
        .select({
          id: sourceDocumentsTable.id,
          title: sourceDocumentsTable.title,
          author: sourceDocumentsTable.author,
          publishedAt: sourceDocumentsTable.publishedAt,
          canonicalUrl: sourceDocumentsTable.canonicalUrl,
        })
        .from(sourceDocumentsTable)
        .where(
          or(eq(sourceDocumentsTable.url, row.url), eq(sourceDocumentsTable.canonicalUrl, row.url)),
        )
        .limit(1);
      if (!doc) continue;
      await db
        .update(articleSourcesTable)
        .set({ sourceDocumentId: doc.id, status: "ingested", updatedAt: new Date() })
        .where(eq(articleSourcesTable.id, row.id));
      // Snapshot true-citation metadata from the vault doc (no-op if the row
      // already has a source_title — manual overrides / prior snapshots win).
      await snapshotCitationFromVaultDoc(row.id, doc);
      linked += 1;
    } catch (err) {
      logger.warn({ err, id: row.id }, "backCatalogHarvest: reconcile row failed");
    }
  }
  if (linked > 0) logger.info({ linked }, "backCatalogHarvest: reconciled harvested sources");
  return linked;
}

export interface HarvestStats {
  articlesTotal: number;
  articlesHarvested: number;
  articlesPending: number;
  sourcesTotal: number;
  byStatus: Record<ArticleSourceStatus, number>;
  byRole: Record<ArticleSourceRole, number>;
  linkedDocuments: number;
}

export async function getHarvestStats(status: HarvestArticleStatus = "published"): Promise<HarvestStats> {
  const scopeWhere = status === "all" ? undefined : eq(articlesTable.status, status);

  const [[{ total } = { total: 0 }], [{ harvested } = { harvested: 0 }]] = await Promise.all([
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(articlesTable)
      .where(scopeWhere),
    db
      .select({ harvested: sql<number>`count(*)::int` })
      .from(articlesTable)
      .where(
        scopeWhere
          ? and(scopeWhere, isNotNull(articlesTable.sourcesHarvestedAt))
          : isNotNull(articlesTable.sourcesHarvestedAt),
      ),
  ]);

  // Source-level aggregates are scoped to the SAME article-status window as the
  // article counts above, so the dashboard stays internally consistent with the
  // selected filter. Join through articles to apply the status predicate.
  const statusRows = await db
    .select({ status: articleSourcesTable.status, n: sql<number>`count(*)::int` })
    .from(articleSourcesTable)
    .innerJoin(articlesTable, eq(articleSourcesTable.articleId, articlesTable.id))
    .where(scopeWhere)
    .groupBy(articleSourcesTable.status);
  const roleRows = await db
    .select({ role: articleSourcesTable.role, n: sql<number>`count(*)::int` })
    .from(articleSourcesTable)
    .innerJoin(articlesTable, eq(articleSourcesTable.articleId, articlesTable.id))
    .where(scopeWhere)
    .groupBy(articleSourcesTable.role);
  const [{ linked } = { linked: 0 }] = await db
    .select({ linked: sql<number>`count(*)::int` })
    .from(articleSourcesTable)
    .innerJoin(articlesTable, eq(articleSourcesTable.articleId, articlesTable.id))
    .where(
      scopeWhere
        ? and(scopeWhere, isNotNull(articleSourcesTable.sourceDocumentId))
        : isNotNull(articleSourcesTable.sourceDocumentId),
    );

  const byStatus: Record<ArticleSourceStatus, number> = {
    queued: 0,
    ingested: 0,
    marker: 0,
    rejected: 0,
  };
  for (const r of statusRows) byStatus[r.status] = Number(r.n);
  const byRole: Record<ArticleSourceRole, number> = {
    evidence: 0,
    trend_marker: 0,
    rejected_junk: 0,
  };
  for (const r of roleRows) byRole[r.role] = Number(r.n);

  const sourcesTotal = Object.values(byStatus).reduce((a, b) => a + b, 0);
  return {
    articlesTotal: Number(total),
    articlesHarvested: Number(harvested),
    articlesPending: Math.max(Number(total) - Number(harvested), 0),
    sourcesTotal,
    byStatus,
    byRole,
    linkedDocuments: Number(linked),
  };
}

export interface ArticleSourceRow {
  id: string;
  articleId: string;
  articleSlug: string;
  url: string;
  domain: string;
  role: ArticleSourceRole;
  tier: string;
  status: ArticleSourceStatus;
  sourceDocumentId: string | null;
  anchorText: string | null;
  createdAt: string;
}

/** Recent harvested article→source rows for the admin results table. */
export async function listArticleSources(limit = 100): Promise<ArticleSourceRow[]> {
  const rows = await db
    .select({
      id: articleSourcesTable.id,
      articleId: articleSourcesTable.articleId,
      articleSlug: articlesTable.slug,
      url: articleSourcesTable.url,
      domain: articleSourcesTable.domain,
      role: articleSourcesTable.role,
      tier: articleSourcesTable.tier,
      status: articleSourcesTable.status,
      sourceDocumentId: articleSourcesTable.sourceDocumentId,
      anchorText: articleSourcesTable.anchorText,
      createdAt: articleSourcesTable.createdAt,
    })
    .from(articleSourcesTable)
    .innerJoin(articlesTable, eq(articleSourcesTable.articleId, articlesTable.id))
    .orderBy(desc(articleSourcesTable.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
