/**
 * Glossary card capture — server-side headless-Chromium screenshots.
 *
 * Replaces the old client-side html-to-image capture: instead of
 * re-serializing the DOM in the admin's browser, we drive a real headless
 * Chromium at the site's /card-render page, inject the concept data via
 * window.__renderCard(data), wait for window.__CARD_READY (fonts + hero
 * image loaded), and screenshot BOTH card canvases. The two canvases are
 * the SAME shared card component rendered in two native CSS layout formats
 * (never one composition resized into the other):
 *   - #card-canvas-feed → 1200×1470 (4:5 card on its stacked-sheet plate)
 *     (glossary-cards-fb/{slug}-card.png, concepts.card_image_url —
 *     feeds Term of the Day; Media Library group "Glossary FB Cards")
 *   - #card-canvas-reel → 1200×2040 (9:16 card on its stacked-sheet plate)
 *     (glossary-cards/{slug}-snap.png, concepts.reels_image_url;
 *     Media Library group "Glossary Cards" — the existing glossary group)
 *
 * Captured PNG dimensions are validated against the expected exact sizes
 * before anything is uploaded — a mis-sized screenshot fails the card.
 *
 * Batch runs (backfill / rebuild-all) use the DB-backed background_jobs
 * lock (jobState.ts) — the same system as the citation backfill and daily
 * pipeline — so progress/locking survive autoscale instances and restarts,
 * with runId fencing and stale-heartbeat takeover.
 */

import { execFileSync } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright-core";
import { eq, and, isNull, isNotNull, inArray, asc } from "drizzle-orm";
import {
  db,
  conceptsTable,
  conceptAliasesTable,
  articleConceptMentionsTable,
  articlesTable,
} from "@workspace/db";
import { uploadPublicBuffer } from "../lib/objectStorage";
import { logger } from "../lib/logger";
import {
  acquireJobLock,
  heartbeatJob,
  finishJob,
  requestJobCancel,
  isCancelRequested,
  getJobState,
  isJobRunning,
} from "./jobState";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mirrors the site's ConceptForCard shape (GlossaryShareCard.tsx). */
interface CardRenderData {
  id: string;
  slug: string;
  term: string;
  definition: string;
  hoverDefinition: string;
  realLifeExample: string | null;
  whatItIsnt: string | null;
  commonlyMisusedOnline: string | null;
  moduleType: string | null;
  aliases: string[];
  heroImageUrl: string | null;
}

/** Which card output a batch run targets. Batches are format-scoped: a feed
 *  run never touches stored reel cards and vice versa. Single-card recapture
 *  still refreshes both. */
export type CaptureFormat = "feed" | "reel";

export interface CaptureBatchStatus {
  running: boolean;
  mode: "backfill" | "rebuild-all" | null;
  format: CaptureFormat | null;
  done: number;
  total: number;
  stored: number;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Environment resolution
// ---------------------------------------------------------------------------

/**
 * Site origin the headless browser navigates to. Prod must use the real site
 * (SITE_BASE_URL=https://brainhook.net, else the first REPLIT_DOMAINS entry);
 * dev goes through the local shared proxy so /card-render and the
 * /api/storage hero URLs resolve same-origin.
 */
function resolveCardRenderOrigin(): string {
  const env = process.env["SITE_BASE_URL"];
  if (env) return env.replace(/\/$/, "");
  if (process.env["NODE_ENV"] === "production") {
    const domains = process.env["REPLIT_DOMAINS"];
    const first = domains?.split(",")[0]?.trim();
    if (first) return `https://${first}`;
  }
  return "http://localhost:80";
}

/** System Chromium (installed as a Nix dependency; Playwright drives it). */
function resolveChromiumPath(): string {
  const env = process.env["CHROMIUM_PATH"];
  if (env) return env;
  try {
    return execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "Chromium binary not found — install the 'chromium' system dependency (Nix) or set CHROMIUM_PATH",
    );
  }
}

// ---------------------------------------------------------------------------
// Browser session
// ---------------------------------------------------------------------------

const RENDER_READY_TIMEOUT_MS = 30_000;

async function openCapturePage(browser: Browser): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 2100 },
    deviceScaleFactor: 1,
  });
  const origin = resolveCardRenderOrigin();
  await page.goto(`${origin}/card-render`, { waitUntil: "domcontentloaded", timeout: RENDER_READY_TIMEOUT_MS });
  // Wait for the SPA to mount and expose the injection hook.
  await page.waitForFunction(() => typeof (window as never as { __renderCard?: unknown }).__renderCard === "function", undefined, {
    timeout: RENDER_READY_TIMEOUT_MS,
  });
  return page;
}

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    executablePath: resolveChromiumPath(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--hide-scrollbars"],
  });
}

interface CardPngs {
  feed?: Buffer;
  reel?: Buffer;
}

/** Exact stored dimensions per format — must match CAPTURE_CANVAS_DIMS on
 *  the site (the 1080-wide card + a 60px transparent stacked-sheet border
 *  on every side). */
const EXPECTED_DIMS = {
  feed: { w: 1200, h: 1470 },
  reel: { w: 1200, h: 2040 },
} as const;

/** Read width/height straight from the PNG IHDR header (bytes 16–24). */
function pngDims(buf: Buffer): { w: number; h: number } {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("captured screenshot is not a PNG");
  }
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function assertCardDims(buf: Buffer, format: keyof typeof EXPECTED_DIMS, slug: string): void {
  const { w, h } = pngDims(buf);
  const exp = EXPECTED_DIMS[format];
  if (w !== exp.w || h !== exp.h) {
    throw new Error(
      `${slug}: captured ${format} card is ${w}×${h}, expected ${exp.w}×${exp.h} — refusing to store`,
    );
  }
}

async function captureCardPngs(
  page: Page,
  data: CardRenderData,
  formats: readonly CaptureFormat[],
): Promise<CardPngs> {
  await page.evaluate((d) => {
    const w = window as never as { __CARD_READY?: boolean; __renderCard?: (x: unknown) => void };
    w.__CARD_READY = false;
    w.__renderCard?.(d);
  }, data as unknown);
  await page.waitForFunction(() => (window as never as { __CARD_READY?: boolean }).__CARD_READY === true, undefined, {
    timeout: RENDER_READY_TIMEOUT_MS,
  });
  const out: CardPngs = {};
  for (const format of formats) {
    const png = await page
      .locator(`#card-canvas-${format}`)
      // omitBackground keeps the padding around the stacked-card sheets
      // transparent (the /card-render page forces a transparent body).
      .screenshot({ type: "png", animations: "disabled", omitBackground: true, timeout: RENDER_READY_TIMEOUT_MS });
    assertCardDims(png, format, data.slug);
    out[format] = png;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Data assembly (same hero-pool logic as the admin gallery endpoint)
// ---------------------------------------------------------------------------

async function loadCardData(conceptIds: string[]): Promise<CardRenderData[]> {
  if (conceptIds.length === 0) return [];
  const [concepts, aliases, mentionHeroes] = await Promise.all([
    db
      .select({
        id: conceptsTable.id,
        slug: conceptsTable.slug,
        term: conceptsTable.term,
        definition: conceptsTable.definition,
        hoverDefinition: conceptsTable.hoverDefinition,
        realLifeExample: conceptsTable.realLifeExample,
        whatItIsnt: conceptsTable.whatItIsnt,
        commonlyMisusedOnline: conceptsTable.commonlyMisusedOnline,
        moduleType: conceptsTable.moduleType,
      })
      .from(conceptsTable)
      .where(inArray(conceptsTable.id, conceptIds))
      .orderBy(asc(conceptsTable.term), asc(conceptsTable.id)),
    db
      .select({ conceptId: conceptAliasesTable.conceptId, alias: conceptAliasesTable.alias })
      .from(conceptAliasesTable)
      .where(inArray(conceptAliasesTable.conceptId, conceptIds)),
    db
      .select({
        conceptId: articleConceptMentionsTable.conceptId,
        heroImage: articlesTable.heroImage,
      })
      .from(articleConceptMentionsTable)
      .innerJoin(articlesTable, eq(articleConceptMentionsTable.articleId, articlesTable.id))
      .where(
        and(
          inArray(articleConceptMentionsTable.conceptId, conceptIds),
          eq(articlesTable.status, "published"),
          isNull(articlesTable.quarantinedAt),
          isNotNull(articlesTable.heroImage),
        ),
      ),
  ]);

  const aliasesByConcept = new Map<string, string[]>();
  for (const a of aliases) {
    const arr = aliasesByConcept.get(a.conceptId) ?? [];
    arr.push(a.alias);
    aliasesByConcept.set(a.conceptId, arr);
  }
  const heroPool = new Map<string, string[]>();
  for (const row of mentionHeroes) {
    if (!row.heroImage) continue;
    const arr = heroPool.get(row.conceptId) ?? [];
    arr.push(row.heroImage);
    heroPool.set(row.conceptId, arr);
  }

  return concepts.map((c) => {
    const heroes = heroPool.get(c.id) ?? [];
    return {
      ...c,
      aliases: aliasesByConcept.get(c.id) ?? [],
      heroImageUrl: heroes.length > 0 ? heroes[Math.floor(Math.random() * heroes.length)]! : null,
    };
  });
}

async function storeCardPngs(
  concept: { id: string; slug: string },
  pngs: CardPngs,
): Promise<{ url: string | null; reelUrl: string | null }> {
  // Storage split drives the Media Library grouping:
  //   glossary-cards-fb/ → 4:5 feed cards (new "Glossary FB Cards" group)
  //   glossary-cards/    → 9:16 reels (the existing glossary group)
  // Only the formats present in `pngs` are uploaded/updated — format-scoped
  // batches must never overwrite the other format's stored card or column.
  const updates: Partial<{ cardImageUrl: string; reelsImageUrl: string }> = {};
  let url: string | null = null;
  let reelUrl: string | null = null;
  if (pngs.feed) {
    const feedPath = `glossary-cards-fb/${concept.slug}-card.png`;
    await uploadPublicBuffer(feedPath, pngs.feed, "image/png");
    url = `/api/storage/public-objects/${feedPath}`;
    updates.cardImageUrl = url;
  }
  if (pngs.reel) {
    const reelPath = `glossary-cards/${concept.slug}-snap.png`;
    await uploadPublicBuffer(reelPath, pngs.reel, "image/png");
    reelUrl = `/api/storage/public-objects/${reelPath}`;
    updates.reelsImageUrl = reelUrl;
  }
  if (Object.keys(updates).length > 0) {
    await db.update(conceptsTable).set(updates).where(eq(conceptsTable.id, concept.id));
  }
  return { url, reelUrl };
}

// ---------------------------------------------------------------------------
// Single capture
// ---------------------------------------------------------------------------

let singleBusyConceptId: string | null = null;

async function isCaptureBusy(): Promise<boolean> {
  if (singleBusyConceptId !== null) return true;
  const status = await getCaptureBatchStatus();
  return status.running;
}

export async function captureSingleCard(conceptId: string): Promise<{ url: string; reelUrl: string }> {
  if (await isCaptureBusy()) throw new CaptureBusyError();
  singleBusyConceptId = conceptId;
  try {
    const [data] = await loadCardData([conceptId]);
    if (!data) throw new ConceptNotFoundError();
    const browser = await launchBrowser();
    try {
      const page = await openCapturePage(browser);
      // Single recapture refreshes BOTH formats — it's a per-term action.
      const pngs = await captureCardPngs(page, data, ["feed", "reel"]);
      const urls = await storeCardPngs(data, pngs);
      logger.info({ conceptId, slug: data.slug }, "glossaryCardCapture: captured cards (headless)");
      return { url: urls.url!, reelUrl: urls.reelUrl! };
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    singleBusyConceptId = null;
  }
}

export class CaptureBusyError extends Error {
  constructor() { super("capture_busy"); }
}
export class ConceptNotFoundError extends Error {
  constructor() { super("concept_not_found"); }
}

// ---------------------------------------------------------------------------
// Batch runs (backfill / rebuild-all)
// ---------------------------------------------------------------------------

const CAPTURE_JOB = "glossary_card_capture";
/** Generous per-heartbeat TTL — heartbeats fire after every card. */
const CAPTURE_JOB_TTL_MS = 3 * 60_000;

interface CaptureProgress {
  mode: "backfill" | "rebuild-all";
  format: CaptureFormat;
  done: number;
  total: number;
  stored: number;
  lastError: string | null;
}

export async function getCaptureBatchStatus(): Promise<CaptureBatchStatus> {
  const row = await getJobState(CAPTURE_JOB);
  const running = isJobRunning(row, CAPTURE_JOB_TTL_MS);
  const p = (row?.progress ?? null) as Partial<CaptureProgress> | null;
  return {
    running,
    mode: running ? (p?.mode ?? null) : null,
    format: running ? (p?.format ?? null) : null,
    done: running ? Number(p?.done ?? 0) : 0,
    total: running ? Number(p?.total ?? 0) : 0,
    stored: running ? Number(p?.stored ?? 0) : 0,
    lastError: p?.lastError ?? null,
  };
}

export async function requestCaptureBatchCancel(): Promise<void> {
  await requestJobCancel(CAPTURE_JOB);
}

/**
 * Start a FORMAT-SCOPED batch capture: only the requested format is captured
 * and stored — the other format's files and DB column are untouched.
 * Backfill selects only concepts missing THAT format's card.
 * Returns the number of concepts queued, or null if a capture is already in
 * flight (one shared lock — headless Chromium runs one batch at a time).
 * Runs unawaited (fire-and-forget) — progress via getCaptureBatchStatus()
 * (DB-backed, survives restarts / other instances).
 */
export async function startCaptureBatch(
  mode: "backfill" | "rebuild-all",
  format: CaptureFormat,
): Promise<number | null> {
  if (singleBusyConceptId !== null) return null;

  const missingColumn = format === "feed" ? conceptsTable.cardImageUrl : conceptsTable.reelsImageUrl;
  const rows = await db
    .select({ id: conceptsTable.id })
    .from(conceptsTable)
    .where(mode === "backfill" ? isNull(missingColumn) : undefined)
    .orderBy(asc(conceptsTable.term), asc(conceptsTable.id));
  if (rows.length === 0) return 0;

  const progress: CaptureProgress = { mode, format, done: 0, total: rows.length, stored: 0, lastError: null };
  const runId = await acquireJobLock(CAPTURE_JOB, { ttlMs: CAPTURE_JOB_TTL_MS, progress: { ...progress } });
  if (!runId) return null;

  void runBatch(runId, progress, rows.map((r) => r.id)).catch(async (err) => {
    logger.error({ err }, "glossaryCardCapture: batch crashed");
    await finishJob(CAPTURE_JOB, runId, "failed", {
      progress: { ...progress, lastError: err instanceof Error ? err.message : String(err) },
    }).catch(() => {});
  });

  return rows.length;
}

async function runBatch(runId: string, progress: CaptureProgress, conceptIds: string[]): Promise<void> {
  let browser: Browser | null = null;
  try {
    const cards = await loadCardData(conceptIds);
    browser = await launchBrowser();
    let page = await openCapturePage(browser);

    for (const card of cards) {
      if (await isCancelRequested(CAPTURE_JOB)) break;
      try {
        const pngs = await captureCardPngs(page, card, [progress.format]);
        await storeCardPngs(card, pngs);
        progress.stored++;
      } catch (err) {
        progress.lastError = `${card.slug}: ${err instanceof Error ? err.message : String(err)}`;
        logger.warn({ err, slug: card.slug }, "glossaryCardCapture: card failed, continuing");
        // The page can wedge after a failed render — recycle it so one bad
        // card doesn't poison the rest of the batch.
        try {
          await page.close().catch(() => {});
          page = await openCapturePage(browser);
        } catch (reopenErr) {
          logger.error({ err: reopenErr }, "glossaryCardCapture: could not recover page, aborting batch");
          break;
        }
      }
      progress.done++;
      // Fenced on runId — a superseded runner can't clobber a takeover.
      await heartbeatJob(CAPTURE_JOB, runId, { ...progress });
    }
    await finishJob(CAPTURE_JOB, runId, "succeeded", { progress: { ...progress } });
  } catch (err) {
    await finishJob(CAPTURE_JOB, runId, "failed", {
      progress: { ...progress, lastError: err instanceof Error ? err.message : String(err) },
    }).catch(() => {});
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
    logger.info(
      { mode: progress.mode, format: progress.format, done: progress.done, total: progress.total, stored: progress.stored },
      "glossaryCardCapture: batch finished",
    );
  }
}
