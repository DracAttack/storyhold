import { db, authorsTable, beatsTable, trendSignalsTable, topicIdeasTable, type Author, type TrendSignal } from "@workspace/db";
import { and, asc, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { getSiteSettings } from "./siteSettings";
import {
  scoutTrendSignalsForBeat,
  pickBestAuthorForIdea,
  NoSuitableAuthorError,
  type RawTrendSignal,
  type TrendScoutOutcome,
} from "./llm";
import { recentTitlesForAuthor, recentPublishedTitlesForCategory, startDraftArticleFromIdea, countApprovedIdeas, getApprovedIdeaCap } from "./articles";
import { rankCoveringAuthors, toRankedPickCandidates } from "./authorAssignment";
import { probeConceptOverlap, jaccard } from "./dedupe";
import { sourceUrlIsReachable } from "./citations";
import { acquireJobLock, heartbeatJob, finishJob, getJobState, isJobRunning } from "./jobState";
import { BudgetGuard, BudgetExceededError } from "./aiBudget";
import { logger } from "../lib/logger";

const TREND_OVERLAP_THRESHOLD = 0.35;

function tokenSet(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter((w) => w.length > 2),
  );
}

// ---------------------------------------------------------------------------
// Background scan job state. DB-backed (table `background_jobs` via jobState.ts):
// a single-flight lock plus a pollable progress snapshot the admin Trend Radar
// page renders while scanning. Unlike the old in-memory version, this survives a
// restart and is consistent across autoscale instances — the lock prevents two
// instances starting a scan and any instance can read live progress.
// ---------------------------------------------------------------------------
/**
 * Per-beat outcome of a scan. `budget_exhausted` is a scan-level status (the
 * beat was never scouted because the AI budget ran out mid-run); every other
 * status comes straight from the scout's fail-closed classification. `inserted`
 * / `skipped` are candidate counts for that beat.
 */
export type BeatScanStatus = TrendScoutOutcome | "budget_exhausted";

export interface BeatScanOutcome {
  beat: string;
  beatSlug: string;
  status: BeatScanStatus;
  inserted: number;
  skipped: number;
  detail?: string;
}

export interface TrendScanJobState {
  running: boolean;
  total: number;
  processed: number;
  found: number;
  inserted: number;
  skipped: number;
  failed: number;
  currentBeat: string | null;
  outcomes: BeatScanOutcome[];
  startedAt: string | null;
  finishedAt: string | null;
}

const TREND_SCAN_JOB = "trend_scan";
// Web search + scoring runs minutes per beat across ~10 beats; a heartbeat older
// than this marks a crashed run stale so a later scan can take the lock over.
const TREND_SCAN_TTL_MS = 15 * 60 * 1000;

type TrendScanProgress = {
  total: number;
  processed: number;
  found: number;
  inserted: number;
  skipped: number;
  failed: number;
  currentBeat: string | null;
  outcomes: BeatScanOutcome[];
};

function emptyTrendProgress(): TrendScanProgress {
  return { total: 0, processed: 0, found: 0, inserted: 0, skipped: 0, failed: 0, currentBeat: null, outcomes: [] };
}

/**
 * Read the current/last trend scan job from the DB. DB-backed (table
 * `background_jobs`) so progress survives a restart and is consistent across
 * autoscale instances — the in-memory version went blank after a deploy and was
 * invisible to an instance that didn't run the scan.
 */
export async function getTrendScanJob(): Promise<TrendScanJobState> {
  const row = await getJobState(TREND_SCAN_JOB);
  if (!row) {
    return { running: false, ...emptyTrendProgress(), startedAt: null, finishedAt: null };
  }
  const p = (row.progress ?? {}) as Partial<TrendScanProgress>;
  return {
    // A run whose heartbeat is older than the takeover TTL has crashed (the
    // fire-and-forget worker died on an autoscale scale-down or a mid-scan
    // deploy and never finalized the row). Report it as NOT running, mirroring
    // acquireJobLock's takeover rule, so the UI re-enables the Scan button
    // instead of deadlocking on a permanent "Scanning…".
    running: isJobRunning(row, TREND_SCAN_TTL_MS),
    total: p.total ?? 0,
    processed: p.processed ?? 0,
    found: p.found ?? 0,
    inserted: p.inserted ?? 0,
    skipped: p.skipped ?? 0,
    failed: p.failed ?? 0,
    currentBeat: p.currentBeat ?? null,
    outcomes: Array.isArray(p.outcomes) ? p.outcomes : [],
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/**
 * Atomically claim the scan lock (DB-backed). Returns false if a scan is already
 * running on any instance so the route can respond `alreadyRunning` without
 * launching a second scan. Must be awaited by the route before the async worker.
 */
export async function beginTrendScanJob(): Promise<string | null> {
  return acquireJobLock(TREND_SCAN_JOB, {
    ttlMs: TREND_SCAN_TTL_MS,
    progress: emptyTrendProgress(),
  });
}

/** Resolve each author's sub-beat slugs to display names for the picker. */
async function buildSlugToName(authors: Author[]): Promise<Map<string, string>> {
  const allSubBeatSlugs = Array.from(
    new Set(authors.flatMap((a) => a.subBeats ?? []).filter(Boolean)),
  );
  if (allSubBeatSlugs.length === 0) return new Map();
  const beatRows = await db
    .select({ slug: beatsTable.slug, name: beatsTable.name })
    .from(beatsTable)
    .where(inArray(beatsTable.slug, allSubBeatSlugs));
  return new Map(beatRows.map((b) => [b.slug, b.name]));
}

export interface BeatScanResult {
  outcome: TrendScoutOutcome;
  detail?: string;
  inserted: TrendSignal[];
  skipped: { headline: string; reason: string }[];
}

/**
 * Scout a single beat and persist the surviving signals. For each raw signal:
 *  - verify the source URL is reachable (drops fabricated/dead/search links);
 *  - dedupe against existing recent article concepts/ideas and within the batch;
 *  - dedupe against existing non-dismissed trend signals (by headline overlap);
 *  - resolve a suggested author (LLM name → active author, else best-fit picker);
 *  - insert with server-clamped scores.
 * The caller (runTrendScan) supplies the active-author roster so it's fetched
 * once per scan, not once per beat.
 */
export async function scoutTrendsForBeat(
  beat: { slug: string; name: string; description?: string | null; slant?: string | null },
  ctx: {
    activeAuthors: Author[];
    coveringAuthors: Author[];
    slugToName: Map<string, string>;
    count?: number;
    // Injectable seam for tests — defaults to the real fail-closed scout.
    scout?: typeof scoutTrendSignalsForBeat;
  },
): Promise<BeatScanResult> {
  const inserted: TrendSignal[] = [];
  const skipped: { headline: string; reason: string }[] = [];

  const [avoidTitles, recentCategoryTitles] = await Promise.all([
    recentTitlesForAuthor(beat.slug),
    recentPublishedTitlesForCategory(beat.slug),
  ]);
  const scout = ctx.scout ?? scoutTrendSignalsForBeat;
  const { outcome, signals, detail } = await scout(
    { name: beat.name, categorySlug: beat.slug, description: beat.description, slant: beat.slant },
    {
      count: ctx.count ?? 6,
      avoidTitles,
      recentCategoryTitles,
      authorNames: ctx.activeAuthors.map((a) => a.name),
    },
  );
  // Fail closed: a failed/unavailable/empty/skipped search yields no signals, so
  // we insert nothing and report WHY rather than fabricating candidates.
  if (signals.length === 0) return { outcome, detail, inserted, skipped };

  // Existing active (new/drafted) signals we should not re-propose near-dupes of.
  const existingSignals = await db
    .select({ headline: trendSignalsTable.headline, angle: trendSignalsTable.angle })
    .from(trendSignalsTable)
    .where(ne(trendSignalsTable.status, "dismissed"));

  const acceptedThisBeat: RawTrendSignal[] = [];

  for (const sig of signals) {
    // 1) Source must be real and reachable (https, non-search-query, resolves).
    const reachable = await sourceUrlIsReachable(sig.sourceUrl);
    if (!reachable) {
      skipped.push({ headline: sig.headline, reason: "source URL unreachable / search-query / fabricated" });
      continue;
    }

    // 2) Concept-dedupe against existing articles + pending/approved ideas.
    const { worst } = await probeConceptOverlap(sig.headline, sig.angle, {
      threshold: TREND_OVERLAP_THRESHOLD,
    });
    if (worst) {
      skipped.push({
        headline: sig.headline,
        reason: `overlaps existing ${worst.kind} "${worst.title}" (${(worst.score * 100).toFixed(0)}%)`,
      });
      continue;
    }

    // 3) Dedupe against existing stored signals (lexical) and the current batch.
    const sigTokens = tokenSet(`${sig.headline} ${sig.angle}`);
    const dupExisting = existingSignals.find(
      (e) => jaccard(tokenSet(`${e.headline} ${e.angle ?? ""}`), sigTokens) >= TREND_OVERLAP_THRESHOLD,
    );
    if (dupExisting) {
      skipped.push({ headline: sig.headline, reason: `overlaps an existing signal ("${dupExisting.headline}")` });
      continue;
    }
    const dupBatch = acceptedThisBeat.find(
      (a) => jaccard(tokenSet(`${a.headline} ${a.angle}`), sigTokens) >= TREND_OVERLAP_THRESHOLD,
    );
    if (dupBatch) {
      skipped.push({ headline: sig.headline, reason: `overlaps another signal in this batch ("${dupBatch.headline}")` });
      continue;
    }

    // 4) Resolve a suggested author. Prefer the LLM's named pick when it maps to
    // a writer who COVERS this beat; otherwise use the best-fit picker over the
    // covering pool (falling back to the full roster). A miss is non-fatal — the
    // signal is still stored without a suggested author; the editor assigns it.
    let suggestedAuthorId: string | null = null;
    let suggestedAuthorName: string | null = null;
    // Only honor the LLM's named pick when that writer actually COVERS this beat
    // (primary beat or a sub-beat). The scout sees the whole roster and will
    // sometimes name an off-beat writer (e.g. an astronomy writer for a
    // political-science hook); trusting that blindly is how a topic lands on the
    // wrong desk. An off-beat name falls through to the best-fit picker below,
    // which is beat-aware and may decline rather than force-fit.
    const named = sig.suggestedAuthor
      ? ctx.coveringAuthors.find((a) => a.name.toLowerCase() === sig.suggestedAuthor!.toLowerCase())
      : undefined;
    if (named) {
      suggestedAuthorId = named.id;
      suggestedAuthorName = named.name;
    } else {
      // Workload-first ranked pool (see authorAssignment.ts): covering writers
      // (primary + sub-beat in ONE pool) ordered lightest recent load first so
      // the picker spreads suggestions across the desk. Ranked fresh per signal
      // — cheap (two grouped counts) and it reflects picks made earlier in the
      // same scan via the approved-idea bank.
      const rankedCovering = await rankCoveringAuthors(beat.slug, { authors: ctx.coveringAuthors });
      const rankedRoster =
        rankedCovering.length > 0 ? null : await rankCoveringAuthors(null, { authors: ctx.activeAuthors });
      const primaryRanked = rankedCovering.length > 0 ? rankedCovering : (rankedRoster ?? []);
      try {
        const pick = await pickBestAuthorForIdea(
          { title: sig.headline, angle: sig.angle },
          toRankedPickCandidates(primaryRanked, ctx.slugToName),
        );
        const match = ctx.activeAuthors.find((a) => a.id === pick.authorId);
        if (match) {
          suggestedAuthorId = match.id;
          suggestedAuthorName = match.name;
        }
      } catch (e) {
        if (!(e instanceof NoSuitableAuthorError)) throw e;
        // No fit in covering pool; try the full roster once (workload-ranked).
        if (rankedCovering.length > 0) {
          try {
            const pick = await pickBestAuthorForIdea(
              { title: sig.headline, angle: sig.angle },
              toRankedPickCandidates(
                await rankCoveringAuthors(null, { authors: ctx.activeAuthors }),
                ctx.slugToName,
              ),
            );
            const match = ctx.activeAuthors.find((a) => a.id === pick.authorId);
            if (match) {
              suggestedAuthorId = match.id;
              suggestedAuthorName = match.name;
            }
          } catch (e2) {
            if (!(e2 instanceof NoSuitableAuthorError)) throw e2;
          }
        }
      }
    }

    const [row] = await db
      .insert(trendSignalsTable)
      .values({
        beatSlug: beat.slug,
        beat: beat.name,
        source: sig.source,
        sourceUrl: sig.sourceUrl,
        event: sig.event,
        headline: sig.headline,
        angle: sig.angle,
        suggestedAuthorId,
        suggestedAuthorName,
        urgencyScore: sig.urgency,
        riskScore: sig.risk,
        riskReason: sig.riskReason,
      })
      .returning();
    if (row) {
      inserted.push(row);
      acceptedThisBeat.push(sig);
    }
  }

  return { outcome, detail, inserted, skipped };
}

/**
 * Run a Trend Radar scan across the given beat slugs (or every beat when none
 * are specified). Fire-and-forget: call beginTrendScanJob() first (the route
 * does) to claim the single-flight lock, then pass the returned runId here and
 * await this in an unawaited promise. Per-beat failures never abort the whole
 * scan; progress is published to the pollable trendScanJob snapshot. The runId
 * fences heartbeat/finish writes so a superseded run can't clobber a takeover.
 */
export async function runTrendScan(
  runId: string,
  beatSlugs?: string[],
  opts: { count?: number } = {},
): Promise<TrendScanJobState> {
  const progress = emptyTrendProgress();
  let runError: unknown = null;
  try {
    const guard = await BudgetGuard.start("trend scan");
    const beats = beatSlugs && beatSlugs.length > 0
      ? await db.select().from(beatsTable).where(inArray(beatsTable.slug, beatSlugs))
      : await db.select().from(beatsTable);
    progress.total = beats.length;
    await heartbeatJob(TREND_SCAN_JOB, runId, { ...progress });

    const activeAuthors = (await db
      .select()
      .from(authorsTable)
      .where(eq(authorsTable.active, true))) as Author[];
    const slugToName = await buildSlugToName(activeAuthors);

    for (const beat of beats) {
      // Stop cleanly if we've hit the per-run or daily spend ceiling.
      try {
        await guard.check();
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          logger.warn({ reason: e.reason, beatsProcessed: progress.processed }, e.message);
          // Record the beat we stopped on so the UI shows WHY the scan is short
          // of `total`, then stop cleanly. Remaining beats are simply unscanned.
          progress.outcomes.push({
            beat: beat.name,
            beatSlug: beat.slug,
            status: "budget_exhausted",
            inserted: 0,
            skipped: 0,
            detail: e.message,
          });
          await heartbeatJob(TREND_SCAN_JOB, runId, { ...progress });
          break;
        }
        throw e;
      }
      progress.currentBeat = beat.name;
      await heartbeatJob(TREND_SCAN_JOB, runId, { ...progress });
      try {
        const covering = activeAuthors.filter(
          (a) => a.categorySlug === beat.slug || (a.subBeats ?? []).includes(beat.slug),
        );
        const result = await scoutTrendsForBeat(
          { slug: beat.slug, name: beat.name, description: beat.description, slant: beat.slant },
          { activeAuthors, coveringAuthors: covering, slugToName, count: opts.count },
        );
        progress.found += result.inserted.length + result.skipped.length;
        progress.inserted += result.inserted.length;
        progress.skipped += result.skipped.length;
        // A search that could not run (errored or the tool was unavailable) is a
        // failure the operator should see; an empty/skipped search is not.
        if (result.outcome === "search_failed" || result.outcome === "tool_unavailable") {
          progress.failed += 1;
        }
        progress.outcomes.push({
          beat: beat.name,
          beatSlug: beat.slug,
          status: result.outcome,
          inserted: result.inserted.length,
          skipped: result.skipped.length,
          detail: result.detail,
        });
      } catch (e) {
        progress.failed += 1;
        logger.error({ err: e, beat: beat.slug }, "Trend scan failed for beat");
        progress.outcomes.push({
          beat: beat.name,
          beatSlug: beat.slug,
          status: "search_failed",
          inserted: 0,
          skipped: 0,
          detail: e instanceof Error ? e.message : String(e),
        });
      } finally {
        progress.processed += 1;
        await heartbeatJob(TREND_SCAN_JOB, runId, { ...progress });
      }
    }
  } catch (e) {
    // A budget stop at start time (bulk disabled / daily cap already hit) is a
    // clean no-op, not a job failure.
    if (e instanceof BudgetExceededError) {
      logger.warn({ reason: e.reason }, e.message);
    } else {
      runError = e;
    }
  } finally {
    progress.currentBeat = null;
    await finishJob(TREND_SCAN_JOB, runId, runError ? "failed" : "succeeded", {
      progress: { ...progress },
      error: runError ? (runError instanceof Error ? runError.message : String(runError)) : undefined,
    });
  }
  if (runError) throw runError;
  return getTrendScanJob();
}

export interface ListTrendSignalsFilter {
  status?: "new" | "drafted" | "dismissed";
  beatSlug?: string;
}

export async function listTrendSignals(filter: ListTrendSignalsFilter = {}): Promise<TrendSignal[]> {
  const conditions = [];
  if (filter.status) conditions.push(eq(trendSignalsTable.status, filter.status));
  if (filter.beatSlug) conditions.push(eq(trendSignalsTable.beatSlug, filter.beatSlug));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  return db
    .select()
    .from(trendSignalsTable)
    .where(where)
    .orderBy(desc(trendSignalsTable.urgencyScore), desc(trendSignalsTable.createdAt));
}

export class TrendSignalError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "TrendSignalError";
    this.status = status;
  }
}

/**
 * Resolve which active writer a signal should be assigned to, mirroring the
 * idea pipeline's author selection.
 *
 * Both paths first honor the scout's stored suggestion when that writer is still
 * active AND still covers the signal's beat. The stored `suggestedAuthorId` is
 * already a beat-aware best-fit pick (see the scout in `runTrendScan`) and it's
 * what the Trend Radar UI shows the editor, so re-running the picker here only
 * risks a second, lower-quality roll landing the topic on the wrong desk (e.g. a
 * microbiology signal suggested for Phoebe/Aris getting reassigned to the climate
 * writer). The paths differ only in their fallback when there is no usable
 * suggestion:
 * - `lenient: false` (the "Draft now" path): fall through to the beat-aware
 *   best-fit picker; if nothing fits, throw so the editor assigns a writer rather
 *   than drafting onto the wrong desk.
 * - `lenient: true` (the "Send to ideas" path): always land *a* writer — best fit
 *   if the picker finds one, otherwise the first covering writer (or any active
 *   writer). The idea is just queued as approved, so the editor can reassign it
 *   later from the Ideas page.
 */
export async function resolveSignalAuthor(
  signal: TrendSignal,
  opts: { lenient: boolean; pickAuthor?: typeof pickBestAuthorForIdea },
): Promise<{ author: Author; reason: string }> {
  // The LLM best-fit picker is injectable so regression tests can drive the
  // fallback deterministically (and assert it's NOT consulted when the scout's
  // suggestion already covers the beat) without a live model call.
  const pickAuthor = opts.pickAuthor ?? pickBestAuthorForIdea;
  const activeAuthors = (await db
    .select()
    .from(authorsTable)
    .where(eq(authorsTable.active, true))) as Author[];
  if (activeAuthors.length === 0) {
    throw new TrendSignalError("No active authors available to draft this signal", 400);
  }

  if (activeAuthors.length === 1) {
    return { author: activeAuthors[0]!, reason: "Only one active author." };
  }

  // Honor the scout's stored suggestion on BOTH paths when that writer is still
  // active and still covers the beat — it's the vetted best-fit pick the UI
  // displays. Only fall through to the picker when there is no usable suggestion.
  if (signal.suggestedAuthorId) {
    const candidate = activeAuthors.find((a) => a.id === signal.suggestedAuthorId);
    const coversBeat =
      candidate != null &&
      (candidate.categorySlug === signal.beatSlug || (candidate.subBeats ?? []).includes(signal.beatSlug));
    if (coversBeat) {
      return { author: candidate, reason: "Assigned to the writer Trend Radar suggested for this beat." };
    }
  }

  const slugToName = await buildSlugToName(activeAuthors);
  // Workload-first covering pool (see authorAssignment.ts): primary and
  // sub-beat coverers compete in ONE pool, lightest recent load first with
  // primary-beat fit breaking ties. The LLM picker sees that order (plus each
  // writer's load) and the lenient fallback (pool[0]) lands on the
  // lightest-loaded coverer — variety across the desk instead of always the
  // same primary-beat specialist.
  const rankedCovering = await rankCoveringAuthors(signal.beatSlug, { authors: activeAuthors });
  const ranked =
    rankedCovering.length > 0
      ? rankedCovering
      : await rankCoveringAuthors(null, { authors: activeAuthors });
  const pool = ranked.map((r) => r.author);
  try {
    const pick = await pickAuthor(
      { title: signal.headline, angle: signal.angle },
      toRankedPickCandidates(ranked, slugToName),
    );
    const picked = activeAuthors.find((a) => a.id === pick.authorId);
    if (picked) return { author: picked, reason: pick.reason };
  } catch (e) {
    if (!(e instanceof NoSuitableAuthorError)) throw e;
  }

  if (opts.lenient) {
    return {
      author: pool[0]!,
      reason: "No clear best fit; assigned the lightest-loaded writer covering this beat.",
    };
  }
  throw new TrendSignalError("No active writer fits this signal — assign an author first", 400);
}

/**
 * Consume a stored signal into an APPROVED topic idea for the (resolved)
 * suggested author. When `opts.draft` is true the new idea is also handed to the
 * background draft pipeline right away (the "Draft" action); when false it
 * simply lands in the approved-ideas queue for the editor to draft later (the
 * "Send to ideas" action). Either way the signal is marked `drafted` and linked
 * to the idea so it isn't re-proposed. Respects the per-author approved-idea cap.
 */
export interface ConsumeTrendSignalDeps {
  // Injectable seams for regression tests: the LLM best-fit picker used in the
  // author-resolution fallback, and the background draft launcher. Both default
  // to the real implementations so production behavior is unchanged.
  pickAuthor?: typeof pickBestAuthorForIdea;
  launchDraft?: typeof startDraftArticleFromIdea;
}

export async function consumeTrendSignalIntoIdea(
  id: string,
  opts: { draft: boolean } & ConsumeTrendSignalDeps,
): Promise<TrendSignal> {
  const [signal] = await db.select().from(trendSignalsTable).where(eq(trendSignalsTable.id, id)).limit(1);
  if (!signal) throw new TrendSignalError("Trend signal not found", 404);
  if (signal.status === "drafted") throw new TrendSignalError("This signal has already been drafted", 409);
  if (signal.status === "dismissed") throw new TrendSignalError("This signal was dismissed — it can't be drafted", 409);

  // Resolve the writer the same way the idea pipeline does. Both paths first
  // honor the scout's stored suggestion (when that writer is active and covers
  // the beat) so the assignment matches what Trend Radar showed the editor. They
  // differ only in the fallback when there's no usable suggestion: the draft path
  // is strict (it publishes onto a specific desk immediately, so it must land the
  // right writer or refuse); the "send to ideas" path is lenient — it always
  // assigns *a* writer (best fit, else any covering/active writer) so the idea
  // reliably lands in the approved queue for the editor to reassign later.
  const { author, reason: authorReason } = await resolveSignalAuthor(signal, {
    lenient: !opts.draft,
    pickAuthor: opts.pickAuthor,
  });

  const approvedCount = await countApprovedIdeas(author.id);
  const ideaCap = await getApprovedIdeaCap();
  if (approvedCount >= ideaCap) {
    throw new TrendSignalError(
      `${author.name} already has ${approvedCount} approved ideas (cap ${ideaCap}). Draft some of them first.`,
      409,
    );
  }

  // Atomically claim the signal (new → drafted) BEFORE any side effects. Only
  // the request that wins this guarded UPDATE proceeds to create an idea and
  // launch a draft; a concurrent second request gets no row back and 409s,
  // so the same hook can't spawn two ideas/drafts. Mirrors the guarded-status
  // claim used by the idea→draft pipeline.
  const [claimed] = await db
    .update(trendSignalsTable)
    .set({
      status: "drafted",
      suggestedAuthorId: author.id,
      suggestedAuthorName: author.name,
      updatedAt: new Date(),
    })
    .where(and(eq(trendSignalsTable.id, id), eq(trendSignalsTable.status, "new")))
    .returning();
  if (!claimed) throw new TrendSignalError("This signal is already being processed", 409);

  // From here the signal is marked drafted. If idea creation or the draft launch
  // fails, revert it to "new" so the editor can retry instead of stranding it.
  try {
    // Ground the angle in the real source so the draft can cite it.
    const groundedAngle = signal.angle
      ? `${signal.angle} (Source: ${signal.source} — ${signal.sourceUrl})`
      : `Based on ${signal.source}: ${signal.event} (${signal.sourceUrl})`;
    const [idea] = await db
      .insert(topicIdeasTable)
      .values({
        authorId: author.id,
        title: signal.headline,
        angle: groundedAngle,
        category: signal.beat,
        categorySlug: signal.beatSlug,
        status: "approved",
        notes: `From Trend Radar: ${signal.source} · Auto-assigned: ${authorReason}`,
      })
      .returning();
    if (!idea) throw new TrendSignalError("Failed to create idea from signal", 500);

    // When drafting immediately, hand the idea to the background draft pipeline
    // (force past dedupe — the editor explicitly chose this signal). Otherwise
    // the idea stays "approved" in the queue for the editor to draft later.
    if (opts.draft) {
      const launchDraft = opts.launchDraft ?? startDraftArticleFromIdea;
      await launchDraft(author.id, idea.id, { force: true });
    }

    const [updated] = await db
      .update(trendSignalsTable)
      .set({ ideaId: idea.id, updatedAt: new Date() })
      .where(eq(trendSignalsTable.id, id))
      .returning();
    return updated!;
  } catch (e) {
    await db
      .update(trendSignalsTable)
      .set({ status: "new", updatedAt: new Date() })
      .where(eq(trendSignalsTable.id, id));
    throw e;
  }
}

/**
 * Draft a stored signal now: create the approved idea AND launch the background
 * draft pipeline immediately.
 */
export function draftTrendSignal(id: string): Promise<TrendSignal> {
  return consumeTrendSignalIntoIdea(id, { draft: true });
}

/**
 * Send a stored signal to the approved-ideas queue WITHOUT drafting. The idea is
 * created as `approved` so the editor can draft it later (manually or via the
 * pipeline); the signal is marked `drafted` and linked so it isn't re-proposed.
 */
export function sendTrendSignalToIdeas(id: string): Promise<TrendSignal> {
  return consumeTrendSignalIntoIdea(id, { draft: false });
}

/**
 * Automatically push qualifying "new" trend signals into the approved-ideas
 * queue once per day (gated by trendAutoInjectEnabled in site_settings). Only
 * signals with urgencyScore >= trendAutoInjectMinUrgency are injected; signals
 * below the threshold remain "new" for the editor to review manually.
 *
 * Each signal is sent to ideas (not immediately drafted) so the normal
 * approval + drafting pipeline picks up the work at the author's cadence.
 * Signals that fail (author-cap hit, no covering author, already processed)
 * are skipped non-fatally — they stay "new" for the editor.
 */
export async function autoInjectTrendSignals(): Promise<{
  injected: number;
  skipped: number;
  errors: number;
}> {
  const s = await getSiteSettings();
  if (!s.trendAutoInjectEnabled) return { injected: 0, skipped: 0, errors: 0 };

  const signals = await db
    .select()
    .from(trendSignalsTable)
    .where(
      and(
        eq(trendSignalsTable.status, "new"),
        gte(trendSignalsTable.urgencyScore, s.trendAutoInjectMinUrgency),
      ),
    )
    .orderBy(desc(trendSignalsTable.urgencyScore), asc(trendSignalsTable.createdAt));

  let injected = 0;
  let skipped = 0;
  let errors = 0;

  for (const signal of signals) {
    try {
      await consumeTrendSignalIntoIdea(signal.id, { draft: false });
      injected++;
    } catch (e) {
      if (e instanceof TrendSignalError) {
        // Expected: author cap hit, no covering author, already processed, etc.
        skipped++;
        logger.debug({ signalId: signal.id, err: e }, "trend auto-inject: signal skipped");
      } else {
        errors++;
        logger.warn({ signalId: signal.id, err: e }, "trend auto-inject: unexpected error, signal left as new");
      }
    }
  }

  return { injected, skipped, errors };
}

export async function dismissTrendSignal(id: string): Promise<TrendSignal> {
  const [updated] = await db
    .update(trendSignalsTable)
    .set({ status: "dismissed", updatedAt: new Date() })
    .where(eq(trendSignalsTable.id, id))
    .returning();
  if (!updated) throw new TrendSignalError("Trend signal not found", 404);
  return updated;
}
