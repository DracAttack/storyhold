import { Router, type IRouter } from "express";
import {
  startDuplicateScan,
  getDuplicateScanStatus,
  listPendingDuplicates,
  keepDuplicate,
  deleteDuplicate,
  DuplicateReviewNotFoundError,
} from "../../services/duplicateScan";

const router: IRouter = Router();

// Pending review queue: each item is a quarantined offender + the original it
// duplicates + the AI's reason.
router.get("/duplicates", async (_req, res) => {
  const items = await listPendingDuplicates();
  res.json({ items });
  return;
});

// Kick off a scan. Fire-and-forget (the full pass can run minutes on a large
// corpus), guarded so a double-click / overlapping cron can't run two at once.
router.post("/duplicates/scan", async (_req, res) => {
  const { started, alreadyRunning } = await startDuplicateScan();
  res.status(202).json({ started, alreadyRunning });
  return;
});

// Poll target for the admin page while a scan is in flight.
router.get("/duplicates/scan-status", async (_req, res) => {
  res.json(await getDuplicateScanStatus());
  return;
});

// Keep the offender: un-quarantine it and remember the pair so it is never
// re-flagged.
router.post("/duplicates/:id/keep", async (req, res) => {
  try {
    await keepDuplicate(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof DuplicateReviewNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    throw err;
  }
  return;
});

// Delete the offender article (cascades the review row away).
router.post("/duplicates/:id/delete", async (req, res) => {
  try {
    await deleteDuplicate(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof DuplicateReviewNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    throw err;
  }
  return;
});

export default router;
