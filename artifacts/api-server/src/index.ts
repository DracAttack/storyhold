import cron from "node-cron";
import app from "./app";
import { logger } from "./lib/logger";
import { runDailyPipeline, publishDueArticles, autoLockStaleDrafts, autoApproveStaleIdeas, runBackCatalogueMaintenance } from "./services/articles";
import { runStartupSeed } from "./services/seed";
import { ensureDefaultShareCard } from "./services/shareImage";
import { recoverDraftingIdeas } from "./services/articles";
import { markServerReady } from "./routes/health";
import { sendWeeklyNewsletterToAll } from "./services/weeklyNewsletter";
import { startDuplicateScan } from "./services/duplicateScan";
import { getSiteSettings } from "./services/siteSettings";
import { postNextDueSlot, generateMissingSocialPacks } from "./services/socialQueue";
import { postNextDueMeme } from "./services/memeQueue";
import { isZernioConfigured } from "./services/social";
import { claimJobPeriod } from "./services/cronClaim";

// Safety net: a stray unhandled promise rejection must never crash the whole
// server. Node's default is to terminate the process on an unhandled rejection,
// which previously turned a single failed image transform into a site-wide
// crash-loop (every route 500'd). Log it loudly and keep serving.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection (kept process alive)");
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  try {
    await runStartupSeed();
    await ensureDefaultShareCard();
    await recoverDraftingIdeas();
  } catch (e) {
    logger.error({ err: e }, "Startup seed failed — exiting (likely missing schema; run `pnpm --filter @workspace/db push`)");
    process.exit(1);
  }

  // Mark the instance ready only after seed + initialization succeed.
  // /healthz/ready returns 503 until this point so the platform doesn't route
  // traffic to a still-booting instance.
  markServerReady();

  // In production the deployment target is autoscale, where in-process node-cron
  // is unreliable: there may be no running instance to fire the timer when idle,
  // and when scaled out the same timer fires on every instance (duplicate drafts
  // / newsletter blasts). Production therefore drives all scheduled work through
  // the externally-pinged GET /api/cron/tick endpoint (UptimeRobot, ~every 5
  // min) — see services/cronTick.ts — which gates each job by the same
  // site_settings rules plus a DB-backed per-period claim. The node-cron timers
  // below remain ONLY as a development convenience so local dev keeps ticking
  // without an external pinger.
  if (process.env["NODE_ENV"] === "production") {
    logger.info("Scheduled work is driven by GET /api/cron/tick (node-cron disabled in production)");
    return;
  }

  // Run hourly at :05; the pipeline itself filters authors by their per-author
  // runHourUtc so only the authors slotted for the current hour actually fire.
  // This replaces the old single 14:05 batch and keeps LLM cost spread out.
  cron.schedule("5 * * * *", async () => {
    try {
      const result = await runDailyPipeline();
      if (result.draftsCreated > 0 || result.ideasGenerated > 0 || result.articlesPublished > 0) {
        logger.info(result, "Hourly pipeline tick produced work");
      }
    } catch (e) {
      logger.error({ err: e }, "Hourly pipeline failed");
    }
  });

  // Weekly subscriber newsletter. Ticks hourly at minute 0 and fires the blast
  // only when the current UTC weekday + hour match the admin-configured schedule
  // (default Saturday 15:00 UTC, weekend reading). The schedule is read fresh on
  // every tick so it changes without a redeploy. Single server, so it fires
  // exactly once per matching hour; the service has an in-flight guard and skips
  // cleanly when there are no articles or subscribers. timezone: "UTC" keeps the
  // minute-0 tick aligned to UTC regardless of host local time (the day/hour
  // gate uses getUTCDay/getUTCHours so it is correct either way).
  cron.schedule(
    "0 * * * *",
    async () => {
      try {
        const s = await getSiteSettings();
        if (!s.weeklyNewsletterEnabled) return;
        const now = new Date();
        if (now.getUTCDay() !== s.weeklyNewsletterWeekday || now.getUTCHours() !== s.weeklyNewsletterHour) {
          return;
        }
        const result = await sendWeeklyNewsletterToAll();
        logger.info(result, "Weekly newsletter tick");
      } catch (e) {
        logger.error({ err: e }, "Weekly newsletter failed");
      }
    },
    { timezone: "UTC" },
  );

  // AI dedup scan. Ticks hourly at minute 0 and fires only at the admin-configured
  // UTC hour, either every day or on a chosen weekday ("weekly"). Detects
  // substantially-similar published pairs and quarantines the newer offender
  // pending admin review on /admin/duplicates. startDuplicateScan is
  // fire-and-forget with its own in-flight guard, so this returns immediately and
  // never overlaps itself. Schedule is read fresh per tick (no redeploy needed).
  cron.schedule(
    "0 * * * *",
    async () => {
      try {
        const s = await getSiteSettings();
        if (!s.dedupeScanEnabled) return;
        const now = new Date();
        if (now.getUTCHours() !== s.dedupeScanHour) return;
        if (s.dedupeScanFrequency === "weekly" && now.getUTCDay() !== s.dedupeScanWeekday) return;
        const { started, alreadyRunning } = await startDuplicateScan();
        logger.info({ started, alreadyRunning }, "Dedup scan tick");
      } catch (err) {
        logger.error({ err }, "Dedup scan tick failed");
      }
    },
    { timezone: "UTC" },
  );

  // Maintenance + publishing loop. Ticks every minute but only does work when the
  // current UTC minute lands on the admin-configured cadence (default every 2
  // minutes). Each tick: auto-approve unattended pending ideas, auto-lock
  // unattended drafts into their reserved slot, then publish anything whose
  // scheduled time has arrived. Auto-approve/auto-lock each have an admin toggle
  // and a configurable delay (hours); publishing always runs so scheduled posts
  // are never stranded. Auto-locked drafts always carry a future slot, so this
  // never publishes them early. Settings are read fresh per tick (no redeploy).
  cron.schedule(
    "* * * * *",
    async () => {
      try {
        const s = await getSiteSettings();
        const interval = s.publishCheckMinutes > 0 ? s.publishCheckMinutes : 1;
        if (new Date().getUTCMinutes() % interval !== 0) return;
        await autoApproveStaleIdeas(new Date(), { enabled: s.autoApproveEnabled, afterHours: s.autoApproveHours });
        await autoLockStaleDrafts(new Date(), { enabled: s.autoLockEnabled, afterHours: s.autoLockHours });
        const published = await publishDueArticles();
        if (published > 0) {
          logger.info({ published }, "Published due articles");
        }
      } catch (e) {
        logger.error({ err: e }, "publishDueArticles failed");
      }
    },
    { timezone: "UTC" },
  );

  // Daily back-catalogue maintenance. Ticks hourly at minute 10 and fires only
  // at a fixed quiet UTC hour: strips legacy scholar/search links from the
  // published catalogue, then backfills real verified source links and internal
  // links onto articles missing them (bounded per run). Dev-only convenience
  // mirror of the cron-tick job; in production the tick endpoint drives it. The
  // backfills have their own in-flight guards so they never collide with manual
  // admin runs.
  cron.schedule(
    "10 * * * *",
    async () => {
      try {
        if (new Date().getUTCHours() !== 4) return;
        const result = await runBackCatalogueMaintenance();
        logger.info(result, "Back-catalogue maintenance tick");
      } catch (e) {
        logger.error({ err: e }, "Back-catalogue maintenance failed");
      }
    },
    { timezone: "UTC" },
  );

  // Facebook posting QUEUE slots. Ticks hourly at minute 0 and posts one queue
  // item only at the five Phoenix slot hours (UTC 15/18/21/0/3), gated by
  // activation + pause + Zernio config. Dev-only convenience mirror of the
  // cron-tick job; in production the tick endpoint drives it. The per-slot
  // claimJobPeriod (same job + period key as the cron tick) guarantees at most
  // one post per slot per UTC day even if both paths ever run together — so the
  // "exactly one post per Phoenix slot" rule holds regardless of trigger.
  // postNextDueSlot self-gates again and never throws.
  cron.schedule(
    "0 * * * *",
    async () => {
      try {
        const now = new Date();
        if (![15, 21, 3].includes(now.getUTCHours())) return;
        if (!isZernioConfigured()) return;
        const s = await getSiteSettings();
        if (!s.socialQueueActivated || s.socialQueuePaused) return;
        // Must byte-match cronTick.ts hourKey() so both paths claim the same
        // period and never both post in one slot.
        const y = now.getUTCFullYear();
        const m = String(now.getUTCMonth() + 1).padStart(2, "0");
        const d = String(now.getUTCDate()).padStart(2, "0");
        const h = String(now.getUTCHours()).padStart(2, "0");
        const hourKey = `${y}-${m}-${d}T${h}`;
        if (!(await claimJobPeriod("social_queue_slot", `slot:${hourKey}`))) return;
        await generateMissingSocialPacks(3);
        const result = await postNextDueSlot(now);
        logger.info({ result }, "Social queue slot tick");
      } catch (e) {
        logger.error({ err: e }, "Social queue slot failed");
      }
    },
    { timezone: "UTC" },
  );

  // MEME posting cadence — post at most one ready/scheduled meme at the three
  // Phoenix slot hours (UTC 17/23/2), gated by meme activation + pause + Zernio
  // config. Dev-only convenience mirror of the cron-tick job. Uses its OWN
  // distinct claim key ("meme_queue_slot", byte-matching cronTick.ts) so the
  // meme cadence never collides with the article-link queue. postNextDueMeme
  // self-gates again and never throws.
  cron.schedule(
    "0 * * * *",
    async () => {
      try {
        const now = new Date();
        if (![17, 23, 2].includes(now.getUTCHours())) return;
        if (!isZernioConfigured()) return;
        const s = await getSiteSettings();
        if (!s.memeQueueActivated || s.memeQueuePaused) return;
        const y = now.getUTCFullYear();
        const m = String(now.getUTCMonth() + 1).padStart(2, "0");
        const d = String(now.getUTCDate()).padStart(2, "0");
        const h = String(now.getUTCHours()).padStart(2, "0");
        const hourKey = `${y}-${m}-${d}T${h}`;
        if (!(await claimJobPeriod("meme_queue_slot", `meme:${hourKey}`))) return;
        const result = await postNextDueMeme(now);
        logger.info({ result }, "Meme queue slot tick");
      } catch (e) {
        logger.error({ err: e }, "Meme queue slot failed");
      }
    },
    { timezone: "UTC" },
  );
});
