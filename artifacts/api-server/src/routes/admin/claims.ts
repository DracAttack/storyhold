import { Router, type IRouter } from "express";
import {
  BackfillVaultClaimsBody,
  CalibrateVaultClaimsBody,
  GetVaultClaimParams,
  ListConceptClaimsQueryParams,
  UpdateVaultClaimBody,
  UpdateVaultClaimParams,
} from "@workspace/api-zod";
import { getRequestAdminEmail } from "../../lib/auth";
import {
  getClaimDetail,
  listClaimsForConcept,
  reconcileClaimsForConcept,
  updateClaim,
} from "../../services/claimGraph";
import { VaultBudgetExceededError } from "../../services/sourceVaultBudget";
import {
  getClaimJobsStatus,
  getLatestClaimCalibration,
  startClaimBackfill,
  startClaimCalibration,
} from "../../services/claimExtraction";

const router: IRouter = Router();

router.get("/concepts/:slug/claims", async (req, res) => {
  const parsed = ListConceptClaimsQueryParams.safeParse(req.query ?? {});
  if (
    !parsed.success ||
    (parsed.data.limit !== undefined && !Number.isInteger(parsed.data.limit)) ||
    (parsed.data.offset !== undefined && !Number.isInteger(parsed.data.offset))
  ) {
    res.status(400).json({ error: "Invalid query", issues: parsed.success ? [] : parsed.error.issues });
    return;
  }
  res.json(await listClaimsForConcept(req.params.slug, parsed.data));
});

router.post("/concepts/:slug/claims/reconcile", async (req, res) => {
  try {
    res.json(await reconcileClaimsForConcept(req.params.slug));
  } catch (err) {
    if (err instanceof VaultBudgetExceededError) {
      res.status(503).json({ error: err.reason, message: err.message });
      return;
    }
    throw err;
  }
});

router.get("/claims/:id", async (req, res) => {
  const parsed = GetVaultClaimParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid claim id" });
    return;
  }
  const detail = await getClaimDetail(parsed.data.id);
  if (!detail) {
    res.status(404).json({ error: "Claim not found" });
    return;
  }
  res.json(detail);
});

router.patch("/claims/:id", async (req, res) => {
  const id = UpdateVaultClaimParams.safeParse(req.params);
  const patch = UpdateVaultClaimBody.safeParse(req.body ?? {});
  const emptyPatch =
    patch.success &&
    patch.data.status === undefined &&
    patch.data.overrideText === undefined;
  if (!id.success || !patch.success || emptyPatch) {
    res.status(400).json({ error: "Invalid claim update", issues: patch.success ? [] : patch.error.issues });
    return;
  }
  const adminEmail = await getRequestAdminEmail(req);
  if (!adminEmail) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const claim = await updateClaim(id.data.id, patch.data, adminEmail);
  if (!claim) {
    res.status(404).json({ error: "Claim not found" });
    return;
  }
  res.json(claim);
});

router.post("/vault/calibrate-claims", async (req, res) => {
  const parsed = CalibrateVaultClaimsBody.safeParse(req.body ?? {});
  if (!parsed.success || !Number.isInteger(parsed.data.sampleSize)) {
    res.status(400).json({
      error: "Invalid calibration request",
      issues: parsed.success ? [] : parsed.error.issues,
    });
    return;
  }
  try {
    const result = await startClaimCalibration(parsed.data.sampleSize ?? 1_000);
    res.status(202).json(result);
  } catch (err) {
    if (err instanceof VaultBudgetExceededError) {
      res.status(503).json({ error: err.reason, message: err.message });
      return;
    }
    res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/vault/calibrate-claims/latest", async (_req, res) => {
  res.json({ report: await getLatestClaimCalibration() });
});

router.post("/vault/backfill-claims", async (req, res) => {
  const parsed = BackfillVaultClaimsBody.safeParse(req.body ?? {});
  if (!parsed.success || !Number.isInteger(parsed.data.batchSize)) {
    res.status(400).json({
      error: "Invalid backfill request",
      issues: parsed.success ? [] : parsed.error.issues,
    });
    return;
  }
  try {
    const result = await startClaimBackfill(parsed.data);
    res.status(result.dryRun ? 200 : 202).json(result);
  } catch (err) {
    if (err instanceof VaultBudgetExceededError) {
      res.status(503).json({ error: err.reason, message: err.message });
      return;
    }
    res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/vault/claim-jobs/status", async (_req, res) => {
  res.json(await getClaimJobsStatus());
});

export default router;
