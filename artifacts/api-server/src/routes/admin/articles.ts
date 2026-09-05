import { Router, type IRouter } from "express";
import { db, articlesTable, authorsTable, topicIdeasTable, beatsTable, memesTable, pageViewsTable, articleConceptMentionsTable, articleSourcesTable, hookVariantSchema, hookAssignmentsSchema, socialPackSchema } from "@workspace/db";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { startDraftArticleFromIdea, DuplicateArticleError } from "../../services/articles";
import { processArticleConcepts } from "../../services/conceptExplainer";
import { AiFunctionDisabledError } from "../../services/llm";
import { pickHeroImage, readingTimeFromBody, slugify } from "../../lib/slug";
import {
  regenerateArticleSection,
  backfillArticleInternalLinks,
  scrubInternalLinksToSlug,
  recalcConceptArticleCounts,
  undoArticleInternalLinks,
  backfillAllInternalLinks,
  beginInternalLinkJob,
  getInternalLinkJob,
  requestInternalLinkJobCancel,
  backfillArticleSourceLinks,
  undoArticleSourceLinks,
  backfillAllSourceLinks,
  redistributeAllSourceLinks,
  stripSearchLinksFromCatalogue,
  sanitizeSearchLinksOnPublish,
  beginSourceLinkJob,
  getSourceLinkJob,
  requestSourceLinkJobCancel,
  forceScheduleDraft,
  forceScheduleAllDrafts,
  reassignArticleAuthor,
  ReassignAuthorError,
  randomizeArticleDates,
  backfillShareImages,
  deleteAllShareImages,
  beginShareImageJob,
  beginShareImageDelete,
  endShareImageDelete,
  getShareImageJob,
  requestShareImageJobCancel,
  BackfillError,
  regenerateArticleHooksAndSocialPack,
  backfillSocialPacks,
  beginSocialPackJob,
  getSocialPackJob,
  requestSocialPackJobCancel,
  verifyArticle,
  redraftArticle,
  refreshArticleEvidence,
  EvidenceRefreshError,
} from "../../services/articles";
import { generateAndStoreHeroImage, uploadHeroImageFromDataUrl, archiveHeroImage } from "../../services/heroImage";
import { NoImageDataError } from "@workspace/integrations-gemini-ai/image";
import { pingArticleSlugs } from "../../lib/indexnow";
import { postArticleToFacebook } from "../../services/social";
import { logger } from "../../lib/logger";
import { refreshArticleCitationMetadata } from "../../services/citationMetadata";

const router: IRouter = Router();

// Overlapping bulk internal-link backfills are guarded by the internal-link job
// state in services/articles.ts (beginInternalLinkJob is an atomic check-and-set),
// which also tracks live progress for the admin gallery and a cooperative cancel
// flag — same pattern as the share-image job.

// Guards against an overlapping bulk "schedule all drafts" run racing itself (a
// double-click, or two admins at once) and assigning the same author slot to two
// different drafts — the read-occupied/assign-slot step isn't transactional.
// Same single-server assumption as run-pipeline/backfill; a multi-instance deploy
// would need a DB-level slot-uniqueness guarantee instead.
let scheduleAllRunning = false;

// Overlapping bulk share-image runs are guarded by the share-image job state in
// services/articles.ts (beginShareImageJob is an atomic check-and-set), which
// also tracks live progress for the admin gallery and a cooperative cancel flag.

router.get("/articles", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const authorId = typeof req.query.authorId === "string" ? req.query.authorId : undefined;
  const held = req.query.held === "true";
  const conditions = [];
  if (status) conditions.push(eq(articlesTable.status, status as "draft" | "scheduled" | "published"));
  if (authorId) conditions.push(eq(articlesTable.authorId, authorId));
  if (held) conditions.push(isNotNull(articlesTable.holdReason));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db
    .select()
    .from(articlesTable)
    .where(where)
    .orderBy(sql`coalesce(${articlesTable.publishedAt}, ${articlesTable.createdAt}) desc`);
  const memeCounts = await db
    .select({ articleId: memesTable.articleId, count: sql<number>`count(*)::int` })
    .from(memesTable)
    .groupBy(memesTable.articleId);
  const countByArticle = new Map(memeCounts.map((m) => [m.articleId, m.count]));
  const viewCounts = await db
    .select({ slug: pageViewsTable.articleSlug, count: sql<number>`count(*)::int` })
    .from(pageViewsTable)
    .groupBy(pageViewsTable.articleSlug);
  const viewsBySlug = new Map(viewCounts.map((v) => [v.slug, v.count]));
  const evidenceSourceCounts = await db
    .select({ articleId: articleSourcesTable.articleId, count: sql<number>`count(*)::int` })
    .from(articleSourcesTable)
    .where(eq(articleSourcesTable.role, "evidence"))
    .groupBy(articleSourcesTable.articleId);
  const evidenceByArticle = new Map(evidenceSourceCounts.map((e) => [e.articleId, e.count]));
  // Intermediary citations (SciSpace, ResearchGate, Semantic Scholar) suppressed
  // from the public References list. Editors can spot-and-replace these links
  // by reviewing this count in the Admin → Articles view.
  const intermediateCounts = await db
    .select({ articleId: articleSourcesTable.articleId, count: sql<number>`count(*)::int` })
    .from(articleSourcesTable)
    .where(and(eq(articleSourcesTable.role, "evidence"), eq(articleSourcesTable.isIntermediary, true)))
    .groupBy(articleSourcesTable.articleId);
  const intermediaryByArticle = new Map(intermediateCounts.map((e) => [e.articleId, e.count]));
  const items = rows.map((a) => ({
    ...a,
    memeCount: countByArticle.get(a.id) ?? 0,
    viewCount: viewsBySlug.get(a.slug) ?? 0,
    evidenceSourceCount: evidenceByArticle.get(a.id) ?? 0,
    intermediaryCitationCount: intermediaryByArticle.get(a.id) ?? 0,
  }));
  res.json({ items }); return;
});

// Bulk delete every "pending" article (draft + scheduled, never published).
// Registered before "/articles/:id" so the literal path wins over the param.
router.delete("/articles/pending", async (_req, res) => {
  // Capture affected concept IDs BEFORE deletion — the FK cascade will remove
  // article_concept_mentions rows with the articles, making them invisible to
  // any post-delete lookup in recalcConceptArticleCounts.
  const affectedConceptIds = (
    await db
      .selectDistinct({ conceptId: articleConceptMentionsTable.conceptId })
      .from(articleConceptMentionsTable)
      .innerJoin(articlesTable, eq(articlesTable.id, articleConceptMentionsTable.articleId))
      .where(inArray(articlesTable.status, ["draft", "scheduled"]))
  ).map((r) => r.conceptId);

  const removed = await db
    .delete(articlesTable)
    .where(inArray(articlesTable.status, ["draft", "scheduled"]))
    .returning({ id: articlesTable.id, slug: articlesTable.slug });
  // Recalc article counts for any concepts tied to these deleted articles.
  if (affectedConceptIds.length > 0) {
    void recalcConceptArticleCounts(undefined, affectedConceptIds).catch((err) =>
      _req.log.error({ err, count: affectedConceptIds.length }, "Failed to recalc concept counts after bulk delete"),
    );
  }
  res.json({ deleted: removed.length }); return;
});

// Bulk publish every "pending" article (draft + scheduled) in one operation.
// Registered before "/articles/:id" so the literal path wins over the param.
// Like the single publish, this bulk action is an explicit human sign-off, so
// it also clears any verification quarantine on the drafts it publishes.
router.post("/articles/publish-pending", async (_req, res) => {
  const now = new Date();
  const published = await db
    .update(articlesTable)
    .set({ status: "published", publishedAt: now, scheduledFor: null, quarantinedAt: null, holdReason: null, updatedAt: now })
    .where(inArray(articlesTable.status, ["draft", "scheduled"]))
    .returning({ id: articlesTable.id, slug: articlesTable.slug });
  // Publish-time safeguard: never let scholar/search-query links go live.
  // Guarded: the articles are already published, so a sanitation failure must
  // not turn the response into a 500.
  if (published.length) {
    try {
      await sanitizeSearchLinksOnPublish(published.map((a) => a.id));
    } catch (err) {
      _req.log.error({ err }, "publish-pending: search-link sanitation failed");
    }
  }
  if (published.length) void pingArticleSlugs(published.map((a) => a.slug));
  res.json({ published: published.length }); return;
});

// Bulk "force schedule": immediately lock every draft into its scheduled slot
// instead of waiting up to 48h for the auto-lock. Scheduled/published articles
// are untouched. This does NOT publish anything early — each draft keeps (or is
// assigned) a future cadence slot and ships at its scheduled time.
// Registered before "/articles/:id" so the literal path wins over the param.
router.post("/articles/schedule-pending", async (_req, res) => {
  if (scheduleAllRunning) {
    res.json({ scheduled: 0, skippedNoSources: 0, alreadyRunning: true }); return;
  }
  scheduleAllRunning = true;
  try {
    const { scheduled, skippedNoSources } = await forceScheduleAllDrafts();
    res.json({ scheduled, skippedNoSources, alreadyRunning: false }); return;
  } finally {
    scheduleAllRunning = false;
  }
});

// Bulk internal-link backfill over the back catalog: every published article
// that has no in-body internal links yet gets one contextual-linking pass. Each
// article is a separate LLM call, so a full run is minutes long — far longer
// than an HTTP request stays open. Fire-and-forget: return 202 immediately and
// do the work in an unawaited promise (mirrors POST /admin/run-pipeline).
// Registered before "/articles/:id" so the literal path wins over the param.
router.post("/articles/backfill-links", (req, res) => {
  if (!beginInternalLinkJob()) {
    res.status(202).json({ started: false, alreadyRunning: true });
    return;
  }
  req.log?.info({ adminEmail: req.session?.adminEmail }, "backfill-links: start (background)");
  res.status(202).json({ started: true, alreadyRunning: false });
  void backfillAllInternalLinks()
    .then((result) => {
      logger.info({ result }, "backfill-links: done");
    })
    .catch((e) => {
      logger.error({ err: e }, "backfill-links: failed");
    });
});

// Live progress of the current/last internal-link bulk backfill (polled by the
// admin "Internal links" gallery). Literal path — registered before
// "/articles/:id" so it isn't swallowed by the param route.
router.get("/articles/link-status", (_req, res) => {
  res.json(getInternalLinkJob());
});

// Cooperatively halt a running internal-link backfill: the in-progress article
// finishes, then the loop stops. No-op (canceled=false) if idle.
router.post("/articles/links/cancel", (req, res) => {
  const canceled = requestInternalLinkJobCancel();
  req.log?.info({ adminEmail: req.session?.adminEmail, canceled }, "backfill-links: cancel requested");
  res.json({ canceled });
});

// Bulk source-link (external citation) backfill over the back catalog: every
// published article with no external source links yet gets one web-search-
// grounded pass. Each article is a separate LLM + web-search call, so a full run
// is many minutes long — far longer than an HTTP request stays open. Fire-and-
// forget: return 202 immediately, work in an unawaited promise. Registered
// before "/articles/:id" so the literal path wins over the param.
router.post("/articles/backfill-source-links", (req, res) => {
  if (!beginSourceLinkJob()) {
    res.status(202).json({ started: false, alreadyRunning: true });
    return;
  }
  req.log?.info({ adminEmail: req.session?.adminEmail }, "backfill-source-links: start (background)");
  res.status(202).json({ started: true, alreadyRunning: false });
  void backfillAllSourceLinks()
    .then((result) => {
      logger.info({ result }, "backfill-source-links: done");
    })
    .catch((e) => {
      logger.error({ err: e }, "backfill-source-links: failed");
    });
});

// Bulk citation REDISTRIBUTE over the back catalog: every published article
// whose external citations are all crammed into the first third of the prose
// gets its links stripped and re-placed across the whole body (same URLs, no
// web search — one LLM call per article). Shares the source-link job lock with
// the backfill so the two can never overlap. Fire-and-forget; registered
// before "/articles/:id".
router.post("/articles/redistribute-source-links", (req, res) => {
  if (!beginSourceLinkJob("redistribute")) {
    res.status(202).json({ started: false, alreadyRunning: true });
    return;
  }
  req.log?.info({ adminEmail: req.session?.adminEmail }, "redistribute-source-links: start (background)");
  res.status(202).json({ started: true, alreadyRunning: false });
  void redistributeAllSourceLinks()
    .then((result) => {
      logger.info({ result }, "redistribute-source-links: done");
    })
    .catch((e) => {
      logger.error({ err: e }, "redistribute-source-links: failed");
    });
});

// Live progress of the current/last source-link bulk job — backfill OR
// redistribute; the `mode` field says which (polled by the admin "Source
// links" gallery). Literal path — registered before "/articles/:id" so it
// isn't swallowed by the param route.
router.get("/articles/source-link-status", (_req, res) => {
  res.json(getSourceLinkJob());
});

// Cooperatively halt a running source-link backfill: the in-progress article
// finishes, then the loop stops. No-op (canceled=false) if idle.
router.post("/articles/source-links/cancel", (req, res) => {
  const canceled = requestSourceLinkJobCancel();
  req.log?.info({ adminEmail: req.session?.adminEmail, canceled }, "backfill-source-links: cancel requested");
  res.json({ canceled });
});

// Bulk share-image backfill over the back catalog: every published article that
// has no branded share card yet gets one, re-composited from its EXISTING hero
// image (no AI generation). A full run is minutes long — far longer than an HTTP
// request stays open. Fire-and-forget: return 202 immediately and do the work in
// an unawaited promise (mirrors POST /admin/articles/backfill-links).
// Registered before "/articles/:id" so the literal path wins over the param.
router.post("/articles/backfill-share-images", (req, res) => {
  if (!beginShareImageJob("backfill")) {
    res.status(202).json({ started: false, alreadyRunning: true });
    return;
  }
  req.log?.info({ adminEmail: req.session?.adminEmail }, "backfill-share-images: start (background)");
  res.status(202).json({ started: true, alreadyRunning: false });
  void backfillShareImages()
    .then((result) => {
      logger.info({ result }, "backfill-share-images: done");
    })
    .catch((e) => {
      logger.error({ err: e }, "backfill-share-images: failed");
    });
});

// Force-rebuild EVERY published article's branded share card — even ones that
// already have one — re-compositing from each existing hero image (no AI). Used
// after a branding/layout change to the card so the whole back catalog picks it
// up. Shares the share-image job guard so it can't overlap a backfill.
// Fire-and-forget; registered before "/articles/:id".
router.post("/articles/rebuild-share-images", (req, res) => {
  if (!beginShareImageJob("rebuild")) {
    res.status(202).json({ started: false, alreadyRunning: true });
    return;
  }
  req.log?.info({ adminEmail: req.session?.adminEmail }, "rebuild-share-images: start (background)");
  res.status(202).json({ started: true, alreadyRunning: false });
  void backfillShareImages({ force: true })
    .then((result) => {
      logger.info({ result }, "rebuild-share-images: done");
    })
    .catch((e) => {
      logger.error({ err: e }, "rebuild-share-images: failed");
    });
});

// Coverage check: synchronously evaluates evidence-source coverage for all
// packet-grounded articles. Scheduled articles with zero evidence sources are
// held (holdReason='no_evidence_sources'); those with sources have the hold
// cleared. Returns {held, cleared} stats. Also kicks off a background drift
// repair for published articles. Registered before "/articles/:id".
let checkSourceCoverageRunning = false;
router.post("/articles/check-source-coverage", async (req, res) => {
  if (checkSourceCoverageRunning) {
    res.status(409).json({ error: "Already running", alreadyRunning: true });
    return;
  }
  checkSourceCoverageRunning = true;
  try {
    req.log?.info({ adminEmail: req.session?.adminEmail }, "check-source-coverage: start");
    // Kick off source-graph drift repair in the background (slow: up to 500
    // published articles). Does not need to complete before returning stats.
    void import("../../services/backCatalogHarvest").then(({ repairSourceGraphDrift }) =>
      repairSourceGraphDrift(500)
        .then((r) => logger.info({ r }, "check-source-coverage: bg repair done"))
        .catch((err) => logger.error({ err }, "check-source-coverage: bg repair failed")),
    );
    // Synchronously scan ALL packet-grounded articles (any status) and
    // update holdReason for scheduled ones based on evidence-source count.
    const packetArticles = await db
      .select({ id: articlesTable.id, status: articlesTable.status, holdReason: articlesTable.holdReason })
      .from(articlesTable)
      .where(isNotNull(articlesTable.evidencePacketId));
    let held = 0;
    let cleared = 0;
    for (const article of packetArticles) {
      const [row] = await db
        .select({ cnt: sql<number>`count(*)::int` })
        .from(articleSourcesTable)
        .where(and(eq(articleSourcesTable.articleId, article.id), eq(articleSourcesTable.role, "evidence")));
      const hasEvidence = (row?.cnt ?? 0) > 0;
      if (article.status === "scheduled") {
        if (!hasEvidence) {
          await db
            .update(articlesTable)
            .set({ holdReason: "no_evidence_sources", updatedAt: new Date() })
            .where(eq(articlesTable.id, article.id));
          held++;
        } else if (article.holdReason === "no_evidence_sources") {
          await db
            .update(articlesTable)
            .set({ holdReason: null, updatedAt: new Date() })
            .where(eq(articlesTable.id, article.id));
          cleared++;
        }
      }
    }
    req.log?.info({ held, cleared }, "check-source-coverage: done");
    res.json({ held, cleared });
  } catch (e) {
    logger.error({ err: e }, "check-source-coverage: failed");
    res.status(500).json({ error: "Coverage check failed" });
  } finally {
    checkSourceCoverageRunning = false;
  }
});

// One-click sweep: strip legacy Google-Scholar / search-results-page links
// from every published article body, keeping the visible anchor phrase. Real
// verified source links and internal links are untouched. Pure string work
// (no network, no AI) — fast enough to run synchronously and return exact
// counts, unlike the fire-and-forget bulk jobs above. Idempotent; also runs
// automatically in the daily back-catalogue pass, so this button is for
// on-demand verification (e.g. after an AdSense review). Registered before
// "/articles/:id".
router.post("/articles/strip-search-links", async (req, res) => {
  const result = await stripSearchLinksFromCatalogue();
  req.log?.info({ adminEmail: req.session?.adminEmail, ...result }, "strip-search-links: done");
  res.json(result);
});

// Live progress of the current/last share-image job, polled by the admin
// gallery to drive the progress bar and enable/disable controls.
router.get("/articles/share-image-status", (_req, res) => {
  res.json(getShareImageJob());
});

// Cooperatively halt a running share-image job. The worker checks the flag
// between articles, so the current article finishes before it stops.
router.post("/articles/share-images/cancel", (req, res) => {
  const canceled = requestShareImageJobCancel();
  req.log?.info({ adminEmail: req.session?.adminEmail, canceled }, "share-images: cancel requested");
  res.json({ canceled });
});

// Delete every stored share card (nulls the column + removes the objects).
// Claims the share-image lock so it can't race a backfill/rebuild (and a job
// can't start mid-delete). Bounded DB work plus best-effort storage deletes —
// runs synchronously, releasing the lock in finally.
router.post("/articles/delete-share-images", async (req, res) => {
  if (!beginShareImageDelete()) {
    res.status(409).json({ error: "A share-image job is running. Halt it first." });
    return;
  }
  req.log?.info({ adminEmail: req.session?.adminEmail }, "delete-share-images: start");
  try {
    const result = await deleteAllShareImages();
    req.log?.info({ result }, "delete-share-images: done");
    res.json(result);
  } finally {
    endShareImageDelete();
  }
});

// Backfill the headline-hook kit + social pack onto published articles that
// don't have one yet. Fire-and-forget background loop; registered before
// "/articles/:id" so the literal path wins over the param.
router.post("/articles/backfill-social-packs", async (req, res) => {
  const runId = await beginSocialPackJob("backfill");
  if (!runId) {
    res.status(202).json({ started: false, alreadyRunning: true });
    return;
  }
  req.log?.info({ adminEmail: req.session?.adminEmail }, "backfill-social-packs: start (background)");
  res.status(202).json({ started: true, alreadyRunning: false });
  void backfillSocialPacks(runId)
    .then((result) => {
      logger.info({ result }, "backfill-social-packs: done");
    })
    .catch((e) => {
      logger.error({ err: e }, "backfill-social-packs: failed");
    });
});

// Force-regenerate the hook kit + social pack for EVERY published article — even
// ones that already have one — used after a prompt change. Shares the social-pack
// job guard so it can't overlap a backfill. Fire-and-forget.
router.post("/articles/rebuild-social-packs", async (req, res) => {
  const runId = await beginSocialPackJob("rebuild");
  if (!runId) {
    res.status(202).json({ started: false, alreadyRunning: true });
    return;
  }
  req.log?.info({ adminEmail: req.session?.adminEmail }, "rebuild-social-packs: start (background)");
  res.status(202).json({ started: true, alreadyRunning: false });
  void backfillSocialPacks(runId, { force: true })
    .then((result) => {
      logger.info({ result }, "rebuild-social-packs: done");
    })
    .catch((e) => {
      logger.error({ err: e }, "rebuild-social-packs: failed");
    });
});

// Live progress of the current/last social-pack job, polled by the admin UI.
router.get("/articles/social-pack-status", async (_req, res) => {
  res.json(await getSocialPackJob());
});

// Cooperatively halt a running social-pack job (worker checks between articles).
router.post("/articles/social-packs/cancel", async (req, res) => {
  const canceled = await requestSocialPackJobCancel();
  req.log?.info({ adminEmail: req.session?.adminEmail, canceled }, "social-packs: cancel requested");
  res.json({ canceled });
});

const EDITORIAL_LABELS = ["original_reporting", "research_synthesis", "analysis", "explainer", "commentary"] as const;
const bulkLabelSchema = z.object({
  editorialLabelOverride: z.enum(EDITORIAL_LABELS).nullable(),
  categorySlug: z.string().optional(),
  status: z.enum(["draft", "scheduled", "published"]).optional(),
});

// Bulk-pin an editorial label override across the catalogue in one shot.
// Registered before "/articles/:id" so the literal path wins over the param.
router.post("/articles/bulk-label", async (req, res) => {
  const parsed = bulkLabelSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() }); return; }
  const { editorialLabelOverride, categorySlug, status } = parsed.data;
  const conditions = [];
  if (status) conditions.push(eq(articlesTable.status, status));
  if (categorySlug) conditions.push(eq(articlesTable.categorySlug, categorySlug));
  const result = await db
    .update(articlesTable)
    .set({ editorialLabelOverride: editorialLabelOverride, updatedAt: new Date() })
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .returning({ id: articlesTable.id });
  req.log?.info(
    { adminEmail: req.session?.adminEmail, count: result.length, editorialLabelOverride, categorySlug, status },
    "bulk-label: done",
  );
  res.json({ updated: result.length }); return;
});

// Backdate every published article's publish date so the archive reads like an
// organically-grown publication (~1–3 posts/week across the past ~18 months).
// Overwrites real dates and cannot be undone — a deliberate maintenance action.
// One bounded transaction (seconds), so it runs synchronously. Registered before
// "/articles/:id" so the literal path wins over the param.
router.post("/articles/randomize-dates", async (req, res) => {
  const result = await randomizeArticleDates();
  req.log?.info({ adminEmail: req.session?.adminEmail, ...result }, "randomize-dates: done");
  res.json(result); return;
});

router.get("/articles/:id", async (req, res) => {
  const [item] = await db.select().from(articlesTable).where(eq(articlesTable.id, req.params.id)).limit(1);
  if (!item) { res.status(404).json({ error: "Not found" }); return; }
  res.json(item); return;
});

const blockSchema = z.union([
  z.object({
    type: z.enum(["paragraph", "heading", "pullquote", "image", "relatedArticle"]),
    content: z.string(),
  }),
  z.object({
    type: z.literal("takeaways"),
    items: z.array(z.string()),
  }),
]);

const updateSchema = z.object({
  title: z.string().optional(),
  dek: z.string().optional(),
  // Optional editor SEO overrides. Nullable so a cleared field stores NULL and
  // the site falls back to its deterministic derivation.
  seoTitle: z.string().nullable().optional(),
  seoDescription: z.string().nullable().optional(),
  slug: z.string().optional(),
  body: z.array(blockSchema).optional(),
  heroImage: z.string().optional(),
  categorySlug: z.string().optional(),
  // Cross-sectional secondary subjects (Task #258): admin-only. null/[] clears.
  secondaryBeats: z.array(z.string()).nullable().optional(),
  forceAutoRelated: z.boolean().optional(),
  // Editor-curated related-article override (ordered slugs). Null clears it and
  // restores automatic topical ranking. Normalized below (trim/dedupe/cap).
  relatedSlugs: z.array(z.string()).nullable().optional(),
  // Editor overrides for the headline-hook kit + social pack. Nullable so a
  // cleared field stores NULL (resolution falls back to the plain headline).
  hookVariants: z.array(hookVariantSchema).nullable().optional(),
  hookAssignments: hookAssignmentsSchema.nullable().optional(),
  socialPack: socialPackSchema.nullable().optional(),
  // Manual editorial label override (Task #291). When non-null, the public
  // article endpoint returns this label instead of auto-deriving one. Send null
  // to clear and restore auto-detection. Validated against the known label set.
  editorialLabelOverride: z.enum(["original_reporting", "research_synthesis", "analysis", "explainer", "commentary"]).nullable().optional(),
  // Clear the auto-publish hold by sending null. Non-null values (set
  // automatically by the server) are rejected so the client can't forge a hold.
  holdReason: z.null().optional(),
});

router.patch("/articles/:id", async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  const { categorySlug, ...rest } = parsed.data;
  const update: Record<string, unknown> = { ...rest, updatedAt: new Date() };
  // Store blank/whitespace-only SEO overrides as NULL so the site falls back to
  // its deterministic derivation rather than rendering an empty title/desc.
  if ("seoTitle" in rest) update.seoTitle = rest.seoTitle?.trim() ? rest.seoTitle.trim() : null;
  if ("seoDescription" in rest) update.seoDescription = rest.seoDescription?.trim() ? rest.seoDescription.trim() : null;
  // Normalize the related-article override: trim, drop empties, dedupe (keeping
  // order), cap at 12. An empty result stores NULL so the public /related
  // endpoint falls back to automatic topical ranking.
  if ("relatedSlugs" in rest) {
    if (rest.relatedSlugs == null) {
      update.relatedSlugs = null;
    } else {
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const s of rest.relatedSlugs) {
        const t = s.trim();
        if (t && !seen.has(t)) { seen.add(t); cleaned.push(t); }
        if (cleaned.length >= 12) break;
      }
      update.relatedSlugs = cleaned.length ? cleaned : null;
    }
  }
  // Normalize cross-sectional secondary subjects (Task #258): dedupe, drop
  // blanks, and never let the primary beat leak in. null/empty clears the field.
  // When categorySlug is omitted from the request we must fall back to the
  // article's stored primary so a secondary-only edit can't smuggle the primary
  // into secondaryBeats (which would violate the "secondary only" invariant).
  if ("secondaryBeats" in rest) {
    if (rest.secondaryBeats == null) {
      update.secondaryBeats = null;
    } else {
      let primary = categorySlug ?? "";
      if (!primary) {
        const [current] = await db
          .select({ categorySlug: articlesTable.categorySlug })
          .from(articlesTable)
          .where(eq(articlesTable.id, req.params.id))
          .limit(1);
        primary = current?.categorySlug ?? "";
      }
      const cleaned = Array.from(
        new Set(rest.secondaryBeats.map((s) => s.trim()).filter((s) => s && s !== primary)),
      );
      update.secondaryBeats = cleaned.length ? cleaned : null;
    }
  }
  if (parsed.data.body) update.readingTimeMinutes = readingTimeFromBody(parsed.data.body);
  if (parsed.data.slug) update.slug = slugify(parsed.data.slug);
  if (categorySlug) {
    const [beat] = await db
      .select({ slug: beatsTable.slug, name: beatsTable.name })
      .from(beatsTable)
      .where(eq(beatsTable.slug, categorySlug))
      .limit(1);
    if (!beat) { res.status(400).json({ error: "Unknown category", message: `No beat with slug "${categorySlug}".` }); return; }
    update.categorySlug = beat.slug;
    update.category = beat.name;
  }
  const [existing] = await db
    .select({ slug: articlesTable.slug, status: articlesTable.status })
    .from(articlesTable)
    .where(eq(articlesTable.id, req.params.id))
    .limit(1);
  const [item] = await db
    .update(articlesTable)
    .set(update)
    .where(eq(articlesTable.id, req.params.id))
    .returning();
  if (!item) { res.status(404).json({ error: "Not found" }); return; }
  const slugsToPing = new Set<string>();
  if (item.status === "published") slugsToPing.add(item.slug);
  if (existing?.status === "published" && existing.slug !== item.slug) slugsToPing.add(existing.slug);
  if (slugsToPing.size) void pingArticleSlugs([...slugsToPing]);
  res.json(item); return;
});

router.delete("/articles/:id", async (req, res) => {
  // Capture affected concept IDs BEFORE deletion — the FK cascade removes
  // article_concept_mentions rows with the article, so any post-delete lookup
  // finds nothing. Pass these directly to recalcConceptArticleCounts.
  const affectedConceptIds = (
    await db
      .selectDistinct({ conceptId: articleConceptMentionsTable.conceptId })
      .from(articleConceptMentionsTable)
      .where(eq(articleConceptMentionsTable.articleId, req.params.id))
  ).map((r) => r.conceptId);

  const [removed] = await db
    .delete(articlesTable)
    .where(eq(articlesTable.id, req.params.id))
    .returning({ id: articlesTable.id, slug: articlesTable.slug, status: articlesTable.status });
  if (removed?.status === "published") void pingArticleSlugs([removed.slug]);
  // Self-heal inbound internal links so no published article keeps pointing at
  // the now-deleted slug (which would 404). AI-free unwrap, fire-and-forget so
  // the delete response isn't blocked by the catalog sweep.
  if (removed?.slug) {
    void scrubInternalLinksToSlug(removed.slug).catch((err) =>
      req.log.error({ err, deletedSlug: removed.slug }, "Failed to scrub inbound internal links after delete"),
    );
  }
  // Recalc article counts for any concepts tied to this deleted article.
  if (affectedConceptIds.length > 0) {
    void recalcConceptArticleCounts(undefined, affectedConceptIds).catch((err) =>
      req.log.error({ err, articleId: req.params.id }, "Failed to recalc concept counts after single delete"),
    );
  }
  res.status(204).end();
});

router.post("/articles/:id/schedule", async (req, res) => {
  const parsed = z.object({ scheduledFor: z.coerce.date() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  // Evidence-source gate: a packet-grounded draft with zero evidence rows in
  // article_sources must not advance to scheduled — it would auto-publish
  // unsourced. Block it here with a 409 so the editor can attach sources first.
  const [precheck] = await db
    .select({ evidencePacketId: articlesTable.evidencePacketId })
    .from(articlesTable)
    .where(eq(articlesTable.id, req.params.id))
    .limit(1);
  if (precheck?.evidencePacketId) {
    const [row] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(articleSourcesTable)
      .where(and(eq(articleSourcesTable.articleId, req.params.id), eq(articleSourcesTable.role, "evidence")));
    if ((row?.cnt ?? 0) === 0) {
      res.status(409).json({
        error: "no_evidence_sources",
        message: "Cannot schedule: this article has no evidence sources. Add sources via the Source Vault, then re-run verification before scheduling.",
      });
      return;
    }
  }
  // Guard: only draft articles may be scheduled. Scheduling a published article
  // would set status="scheduled" and remove it from public view until the date.
  const [item] = await db
    .update(articlesTable)
    .set({ status: "scheduled", scheduledFor: parsed.data.scheduledFor, updatedAt: new Date() })
    .where(and(eq(articlesTable.id, req.params.id), eq(articlesTable.status, "draft")))
    .returning();
  if (!item) {
    const [existing] = await db.select({ id: articlesTable.id, status: articlesTable.status }).from(articlesTable).where(eq(articlesTable.id, req.params.id)).limit(1);
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }
    res.status(409).json({ error: "Cannot schedule", message: `Only draft articles can be scheduled (current status: ${existing.status}).` }); return;
  }
  res.json(item); return;
});

// Force-schedule a single draft now: lock it into its slot without waiting for
// the 48h auto-lock. 409 if the article isn't a schedulable draft.
router.post("/articles/:id/schedule-now", async (req, res) => {
  // Evidence-source gate: same check as /schedule — a packet-grounded draft
  // with zero evidence rows must not jump to its slot unsourced.
  const [precheck] = await db
    .select({ evidencePacketId: articlesTable.evidencePacketId })
    .from(articlesTable)
    .where(eq(articlesTable.id, req.params.id))
    .limit(1);
  if (precheck?.evidencePacketId) {
    const [row] = await db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(articleSourcesTable)
      .where(and(eq(articleSourcesTable.articleId, req.params.id), eq(articleSourcesTable.role, "evidence")));
    if ((row?.cnt ?? 0) === 0) {
      res.status(409).json({
        error: "no_evidence_sources",
        message: "Cannot schedule: this article has no evidence sources. Add sources via the Source Vault, then re-run verification before scheduling.",
      });
      return;
    }
  }
  const item = await forceScheduleDraft(req.params.id);
  if (!item) {
    res.status(409).json({ error: "Not schedulable", message: "Only drafts can be force-scheduled, and a free slot must be available." });
    return;
  }
  res.json(item); return;
});

// Reassign an article to a different author. Validates the target author exists
// server-side; for scheduled articles, moves it onto a valid slot for the new
// author (see reassignArticleAuthor). 400 unknown author, 404 missing article,
// 409 when no free slot is available for a scheduled article's new author.
const reassignSchema = z.object({ authorId: z.string().min(1) });
router.post("/articles/:id/reassign", async (req, res) => {
  const parsed = reassignSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  try {
    const item = await reassignArticleAuthor(req.params.id, parsed.data.authorId);
    res.json(item); return;
  } catch (err) {
    if (err instanceof ReassignAuthorError) {
      res.status(err.status).json({ error: err.message }); return;
    }
    throw err;
  }
});

router.post("/articles/:id/publish", async (req, res) => {
  // An explicit manual publish is the human sign-off the quarantine flow waits
  // for — a quarantined (verification-flagged) draft the operator deliberately
  // publishes must go LIVE, not stay published-but-hidden (which also kept its
  // beat out of the public nav). Automated publishing never clears quarantine.
  //
  // Guard: only draft or scheduled articles may be published. Re-publishing an
  // already-published article would silently reset its original publishedAt,
  // breaking the article's canonical timestamp and any dependent ordering.
  const [item] = await db
    .update(articlesTable)
    .set({ status: "published", publishedAt: new Date(), scheduledFor: null, quarantinedAt: null, holdReason: null, updatedAt: new Date() })
    .where(and(eq(articlesTable.id, req.params.id), inArray(articlesTable.status, ["draft", "scheduled"])))
    .returning();
  if (!item) {
    const [existing] = await db.select({ id: articlesTable.id, status: articlesTable.status }).from(articlesTable).where(eq(articlesTable.id, req.params.id)).limit(1);
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }
    res.status(409).json({ error: "Cannot publish", message: `Only draft or scheduled articles can be published (current status: ${existing.status}).` }); return;
  }
  // Publish-time safeguard: never let scholar/search-query links go live.
  // Guarded: the article is already published, so a sanitation failure must
  // not turn the response into a 500.
  try {
    await sanitizeSearchLinksOnPublish([item.id]);
  } catch (err) {
    req.log.error({ err, articleId: item.id }, "publish: search-link sanitation failed");
  }
  void pingArticleSlugs([item.slug]);
  // Fire concept detection for the newly published article.
  // Fire-and-forget: a concept pipeline failure must never block or delay the
  // publish response. Guards inside processArticleConcepts handle the rest.
  void processArticleConcepts(item.id, false).catch((err) =>
    req.log.warn({ err, articleId: item.id }, "publish: concept processing failed (non-fatal)"),
  );
  res.json(item); return;
});

// Explicit human override for an already-published article stuck hidden by a
// failed evidence-verification check: clears articles.quarantinedAt so the
// article (and its beat) reappears on the public site. The verification report
// is kept for the record.
router.post("/articles/:id/clear-quarantine", async (req, res) => {
  const [item] = await db
    .update(articlesTable)
    .set({ quarantinedAt: null, updatedAt: new Date() })
    .where(eq(articlesTable.id, req.params.id))
    .returning();
  if (!item) { res.status(404).json({ error: "Not found" }); return; }
  if (item.status === "published") void pingArticleSlugs([item.slug]);
  res.json(item); return;
});

// Manually post a single (published) article to the connected Facebook Page via
// Zernio. Force-(re)posts regardless of any prior attempt, so an admin can push
// an older article or retry a failed auto-post. 503 when Zernio isn't
// configured, 404 unknown article, 409 when the article isn't publishable
// (not published / quarantined), 502 when the provider rejects the post.
router.post("/articles/:id/post-to-facebook", async (req, res) => {
  const result = await postArticleToFacebook(req.params.id, { force: true });
  switch (result.status) {
    case "posted":
      res.json(result);
      return;
    case "disabled":
      res.status(503).json({ status: result.status, error: "Facebook posting is not configured" });
      return;
    case "skipped":
      res.status(result.reason === "not_found" ? 404 : 409).json({
        status: result.status,
        error: result.reason === "not_found" ? "Article not found" : "Article must be published to post",
      });
      return;
    case "failed":
    default:
      res.status(502).json({ status: "failed", error: result.error ?? "Post failed" });
      return;
  }
});

router.post("/articles/:id/unpublish", async (req, res) => {
  const [item] = await db
    .update(articlesTable)
    .set({ status: "draft", publishedAt: null, scheduledFor: null, updatedAt: new Date() })
    .where(eq(articlesTable.id, req.params.id))
    .returning();
  if (!item) { res.status(404).json({ error: "Not found" }); return; }
  void pingArticleSlugs([item.slug]);
  res.json(item); return;
});

router.post("/articles/:id/regenerate-image", async (req, res) => {
  const [existing] = await db.select().from(articlesTable).where(eq(articlesTable.id, req.params.id)).limit(1);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  const [author] = await db.select().from(authorsTable).where(eq(authorsTable.id, existing.authorId)).limit(1);
  let heroImage: string;
  let shareImage: string | null;
  let feedImage: string | null;
  try {
    const generated = await generateAndStoreHeroImage(
      { title: existing.title, dek: existing.dek, category: existing.category, body: existing.body },
      author ?? null,
      existing.slug,
      { operation: "regenerateHeroImage" },
    );
    heroImage = generated.heroImage;
    shareImage = generated.shareImage;
    feedImage = generated.feedImage;
  } catch (err) {
    if (err instanceof NoImageDataError) {
      req.log.warn(
        {
          slug: existing.slug,
          finishReason: err.finishReason,
          blockReason: err.blockReason,
          modelText: err.modelText?.slice(0, 300),
        },
        "Hero image regeneration declined by image model (no image returned)",
      );
      res.status(422).json({
        error: "Image model declined",
        message:
          "The image model declined to generate an image for this article's content. Try again, or lightly edit the article's wording (especially around named public figures) and retry.",
      });
      return;
    }
    req.log.error({ err, slug: existing.slug }, "Hero image regeneration failed");
    res.status(502).json({ error: "Image generation failed", message: err instanceof Error ? err.message : String(err) });
    return;
  }
  // Archive the outgoing hero + its cards BEFORE overwrite so the admin can
  // restore it later (only archives when a hero already existed).
  const [item] = await db
    .update(articlesTable)
    .set({
      heroImage,
      shareImage,
      feedImage,
      heroImageHistory: archiveHeroImage(existing.heroImageHistory, existing),
      updatedAt: new Date(),
    })
    .where(eq(articlesTable.id, req.params.id))
    .returning();
  res.json(item); return;
});

const uploadHeroSchema = z.object({ dataUrl: z.string().min(1) });
router.post("/articles/:id/upload-hero-image", async (req, res) => {
  const parsed = uploadHeroSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "dataUrl is required." });
    return;
  }
  const [existing] = await db.select().from(articlesTable).where(eq(articlesTable.id, req.params.id)).limit(1);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  try {
    const { heroImage, shareImage, feedImage } = await uploadHeroImageFromDataUrl(
      parsed.data.dataUrl,
      existing.title,
      existing.slug,
    );
    const [item] = await db
      .update(articlesTable)
      .set({
        heroImage,
        shareImage,
        feedImage,
        heroImageHistory: archiveHeroImage(existing.heroImageHistory, existing),
        updatedAt: new Date(),
      })
      .where(eq(articlesTable.id, req.params.id))
      .returning();
    res.json(item); return;
  } catch (err) {
    req.log.error({ err, slug: existing.slug }, "Hero image upload failed");
    res.status(400).json({ error: err instanceof Error ? err.message : "Upload failed." });
  }
});

// Restore a previously-archived hero-image version as the active hero. The chosen
// version is removed from history and the currently-active hero+cards are archived
// in its place, so history always holds exactly the non-active versions (mirrors
// the meme select-artwork restore). Keyed by the stable hero URL.
const restoreHeroSchema = z.object({ heroImage: z.string().min(1) });
router.post("/articles/:id/restore-hero-image", async (req, res) => {
  const parsed = restoreHeroSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "heroImage is required." }); return; }
  const [existing] = await db.select().from(articlesTable).where(eq(articlesTable.id, req.params.id)).limit(1);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }
  const target = existing.heroImageHistory.find((h) => h.heroImage === parsed.data.heroImage);
  if (!target) { res.status(404).json({ error: "Version not found" }); return; }
  const rest = existing.heroImageHistory.filter((h) => h.heroImage !== parsed.data.heroImage);
  const heroImageHistory = archiveHeroImage(rest, existing);
  const [item] = await db
    .update(articlesTable)
    .set({
      heroImage: target.heroImage,
      shareImage: target.shareImage,
      feedImage: target.feedImage,
      heroImageHistory,
      updatedAt: new Date(),
    })
    .where(eq(articlesTable.id, req.params.id))
    .returning();
  res.json(item); return;
});

// Regenerate the headline-hook variants + social pack for a single article.
// 404 if the article is missing, 502 if the LLM generation fails.
router.post("/articles/:id/regenerate-hooks", async (req, res) => {
  try {
    const item = await regenerateArticleHooksAndSocialPack(req.params.id);
    res.json(item); return;
  } catch (e) {
    if (e instanceof BackfillError && e.message === "Article not found") {
      res.status(404).json({ error: "Not found" }); return;
    }
    req.log.error({ err: e, id: req.params.id }, "regenerate-hooks failed");
    res.status(502).json({ error: "Hook generation failed", message: e instanceof Error ? e.message : String(e) });
    return;
  }
});

// Re-run the post-draft evidence verification for one packet-grounded article
// (#201). 404 if the article is missing or was never grounded on an evidence
// packet; 409 if verification is paused in AI Control.
router.post("/articles/:id/verify", async (req, res) => {
  try {
    const item = await verifyArticle(req.params.id);
    res.json(item); return;
  } catch (e) {
    if (e instanceof AiFunctionDisabledError) {
      res.status(409).json({
        error: "Evidence verification is turned off",
        message: "Turn on “Draft verification” in AI Controls to re-run this.",
      });
      return;
    }
    if (e instanceof BackfillError && (e.message === "Article not found" || e.message === "No evidence packet")) {
      res.status(404).json({ error: e.message }); return;
    }
    req.log.error({ err: e, id: req.params.id }, "verify-article failed");
    res.status(500).json({ error: "Verification failed", message: e instanceof Error ? e.message : String(e) });
    return;
  }
});

// Re-generate the body of an existing article against a fresh vault evidence
// packet, keeping the hero image, slug, and author unchanged. Moves the article
// back to "draft" for human review before re-publishing.
router.post("/articles/:id/redraft", async (req, res) => {
  try {
    const article = await redraftArticle(req.params.id);
    res.json(article); return;
  } catch (e) {
    if (e instanceof AiFunctionDisabledError) {
      res.status(409).json({
        error: "Draft generation is turned off",
        message: "Turn on “Draft generation” in AI Controls to use this.",
      });
      return;
    }
    if (e instanceof BackfillError && e.message === "Article not found") {
      res.status(404).json({ error: e.message }); return;
    }
    req.log.error({ err: e, id: req.params.id }, "redraft-article failed");
    res.status(500).json({ error: "Re-draft failed", message: e instanceof Error ? e.message : String(e) });
    return;
  }
});

// Post-draft evidence refresh: rebuild the packet from the current vault
// (entity-gated), lock a new version, and re-verify the existing draft against
// it. The body is untouched — the editor decides what to do with the result.
router.post("/articles/:id/refresh-evidence", async (req, res) => {
  try {
    const result = await refreshArticleEvidence(req.params.id);
    res.json(result); return;
  } catch (e) {
    if (e instanceof AiFunctionDisabledError) {
      res.status(409).json({
        error: "Evidence verification is turned off",
        message: "Turn on “Draft verification” in AI Controls to use this.",
      });
      return;
    }
    if (e instanceof BackfillError && e.message === "Article not found") {
      res.status(404).json({ error: e.message }); return;
    }
    if (e instanceof EvidenceRefreshError) {
      res.status(422).json({ error: "Evidence refresh not possible", message: e.message });
      return;
    }
    req.log.error({ err: e, id: req.params.id }, "refresh-article-evidence failed");
    res.status(500).json({ error: "Evidence refresh failed", message: e instanceof Error ? e.message : String(e) });
    return;
  }
});

router.post("/articles/:id/regenerate-section", async (req, res) => {
  const parsed = z.object({ blockIndex: z.number().int().min(0), instructions: z.string().optional() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  try {
    const article = await regenerateArticleSection(req.params.id, parsed.data.blockIndex, parsed.data.instructions);
    res.json(article); return;
  } catch (e) {
    if (e instanceof AiFunctionDisabledError) {
      res.status(409).json({
        error: "AI block writing is turned off",
        message: "Turn on “Block writing & rewrite” in AI Controls to use this.",
      });
      return;
    }
    if (e instanceof Error && e.name === "BlockTypeNotWritableError") {
      res.status(400).json({ error: "Block type not writable", message: e.message }); return;
    }
    res.status(500).json({ error: "Regenerate section failed", message: e instanceof Error ? e.message : String(e) }); return;
  }
});

// Single-article internal-link backfill. One LLM call — fast enough to run
// synchronously within the request. Reversible: the pre-backfill body is
// snapshotted server-side so it can be undone via /undo-links.
router.post("/articles/:id/backfill-links", async (req, res) => {
  try {
    const result = await backfillArticleInternalLinks(req.params.id);
    res.json(result); return;
  } catch (e) {
    if (e instanceof BackfillError && e.message === "Article not found") {
      res.status(404).json({ error: "Not found" }); return;
    }
    req.log?.error({ err: e, articleId: req.params.id }, "Single-article internal-link backfill failed");
    res.status(500).json({ error: "Backfill failed", message: e instanceof Error ? e.message : String(e) }); return;
  }
});

// Undo a previous internal-link backfill, restoring the pre-backfill body.
router.post("/articles/:id/undo-links", async (req, res) => {
  try {
    const result = await undoArticleInternalLinks(req.params.id);
    res.json(result); return;
  } catch (e) {
    if (e instanceof BackfillError && e.message === "Article not found") {
      res.status(404).json({ error: "Not found" }); return;
    }
    req.log?.error({ err: e, articleId: req.params.id }, "Undo internal-link backfill failed");
    res.status(500).json({ error: "Undo failed", message: e instanceof Error ? e.message : String(e) }); return;
  }
});

// Single-article source-link (external citation) backfill. One LLM + web-search
// call — can take ~1–2 min but still runs synchronously within the request.
// Reversible: the pre-backfill body is snapshotted server-side (sourceLinksBackup)
// so it can be undone via /undo-source-links.
router.post("/articles/:id/backfill-source-links", async (req, res) => {
  try {
    const result = await backfillArticleSourceLinks(req.params.id);
    res.json(result); return;
  } catch (e) {
    if (e instanceof BackfillError && e.message === "Article not found") {
      res.status(404).json({ error: "Not found" }); return;
    }
    req.log?.error({ err: e, articleId: req.params.id }, "Single-article source-link backfill failed");
    res.status(500).json({ error: "Backfill failed", message: e instanceof Error ? e.message : String(e) }); return;
  }
});

// Undo a previous source-link backfill, restoring the pre-backfill body.
router.post("/articles/:id/undo-source-links", async (req, res) => {
  try {
    const result = await undoArticleSourceLinks(req.params.id);
    res.json(result); return;
  } catch (e) {
    if (e instanceof BackfillError && e.message === "Article not found") {
      res.status(404).json({ error: "Not found" }); return;
    }
    req.log?.error({ err: e, articleId: req.params.id }, "Undo source-link backfill failed");
    res.status(500).json({ error: "Undo failed", message: e instanceof Error ? e.message : String(e) }); return;
  }
});

// Per-article citation-metadata refresh: clears accessed_at + source_title for
// the article's evidence sources, re-snapshots from the Vault (free), then
// synchronously fetches any remaining URLs. Bounded by the number of sources on
// one article so it can run inline (no job queue needed).
router.post("/articles/:id/refresh-citations", async (req, res) => {
  try {
    const report = await refreshArticleCitationMetadata(req.params.id);
    req.log?.info({ articleId: req.params.id, ...report }, "refresh-citations: done");
    res.json(report); return;
  } catch (e) {
    req.log?.error({ err: e, articleId: req.params.id }, "refresh-citations failed");
    res.status(500).json({ error: "Refresh failed", message: e instanceof Error ? e.message : String(e) }); return;
  }
});

router.post("/ideas/:id/draft", async (req, res) => {
  const [idea] = await db.select().from(topicIdeasTable).where(eq(topicIdeasTable.id, req.params.id)).limit(1);
  if (!idea) { res.status(404).json({ error: "Idea not found" }); return; }
  try {
    // Manual "approve → send to draft" deliberately overrides the dedupe gates:
    // the editor has explicitly chosen this idea, so it must draft even if the
    // automated dedupe would have flagged it as a near/concept duplicate.
    const updatedIdea = await startDraftArticleFromIdea(idea.authorId, idea.id, { force: true });
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
    console.error(e);
    res.status(500).json({ error: "Draft generation failed", message: e instanceof Error ? e.message : String(e) }); return;
  }
});

// One-click "Harvest sources & retry" for a held (needs_sources) idea. Runs a
// controlled Source Harvest for the idea's beat and then re-attempts drafting,
// forcing the harvest regardless of the configured draftResearchMode so the
// action is meaningful even under `vault_required`. Reuses the same fire-and-
// forget draft path as /draft (returns 202; the idea polls to grounded/used or
// back to needs_sources if the vault is still too thin).
router.post("/ideas/:id/harvest-and-draft", async (req, res) => {
  const [idea] = await db.select().from(topicIdeasTable).where(eq(topicIdeasTable.id, req.params.id)).limit(1);
  if (!idea) { res.status(404).json({ error: "Idea not found" }); return; }
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
    console.error(e);
    res.status(500).json({ error: "Harvest & draft failed", message: e instanceof Error ? e.message : String(e) }); return;
  }
});

export default router;
