import { Router, type IRouter } from "express";
import {
  startCitationBackfill,
  getCitationBackfillStatus,
  cancelCitationBackfill,
  forceReleaseCitationBackfill,
  startResetAndBackfill,
} from "../../services/citationMetadata";
import {
  startCitationNotesBackfill,
  cancelCitationNotesBackfill,
  resetDeclinedNoteAttempts,
  getCitationNotesStatus,
} from "../../services/citationNotes";
import {
  startDiversitySweep,
  getDiversitySweepStatus,
} from "../../services/sourceDiversity";

// --- Citation metadata backfill admin API ---------------------------------
// Fire-and-forget POST kicks the backfill (vault copy + bounded SSRF-safe URL
// metadata fetch) in the background; GET polls the shared background_jobs row.

const router: IRouter = Router();

router.post("/citations/backfill", async (_req, res) => {
  const started = await startCitationBackfill();
  if (!started) {
    res.status(409).json({ error: "Citation backfill already running" });
    return;
  }
  res.status(202).json({ started: true });
});

router.get("/citations/status", async (_req, res) => {
  res.json(await getCitationBackfillStatus());
});

router.post("/citations/backfill-cancel", async (_req, res) => {
  const cancelled = await cancelCitationBackfill();
  res.json({ cancelled });
});

router.post("/citations/backfill-force-release", async (req, res) => {
  const released = await forceReleaseCitationBackfill();
  req.log?.info({ released }, "citations/backfill-force-release: triggered");
  res.json({ released });
});

// Citation notes ("evidence map", Task #273): one AI sentence per (article,
// source) on why it's included. Same fire-and-forget + poll pattern.
router.post("/citations/notes-backfill", async (_req, res) => {
  const started = await startCitationNotesBackfill();
  if (!started) {
    res.status(409).json({ error: "Citation-notes backfill already running" });
    return;
  }
  res.status(202).json({ started: true });
});

router.get("/citations/notes-status", async (_req, res) => {
  res.json(await getCitationNotesStatus());
});

// Cooperative cancel: sets the cancel flag; the job loop checks it each
// iteration and exits early on the next article boundary.
router.post("/citations/notes-cancel", async (_req, res) => {
  const cancelled = await cancelCitationNotesBackfill();
  res.json({ cancelled });
});

// Reset declined note attempts: clears note_generated_at where the model
// previously declined (stamp present, note absent), making those sources
// eligible for the next backfill run.
router.post("/citations/notes-reset-declined", async (req, res) => {
  const reset = await resetDeclinedNoteAttempts();
  req.log?.info({ reset }, "citations/notes-reset-declined: triggered");
  res.json({ reset });
});

// Diversity sweep: deduplicates same-paper mirror references (doi.org + PMC +
// publisher site all citing the same paper → keep best-tier, reject rest) and
// clears any junk bot-wall titles from source_title. Same fire-and-forget +
// poll pattern as the other citation jobs.
router.post("/citations/diversity-sweep", async (_req, res) => {
  const started = await startDiversitySweep();
  if (!started) {
    res.status(409).json({ error: "Diversity sweep already running" });
    return;
  }
  res.status(202).json({ started: true });
});

router.get("/citations/diversity-status", async (_req, res) => {
  res.json(await getDiversitySweepStatus());
});

// Global reset-and-retry: clears accessed_at for all evidence sources that
// previously failed to get a title (source_title IS NULL, accessed_at stamped),
// then starts a fresh backfill run so they are all re-attempted.
router.post("/citations/reset-backfill", async (req, res) => {
  const result = await startResetAndBackfill();
  req.log?.info(result, "citations/reset-backfill: triggered");
  res.json(result);
});

export default router;
