import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { EDITORIAL_REJECTION_REASON, EDITORIAL_REVIEW_SURFACE } from "@workspace/db";
import { getShadowMetrics } from "../../services/shadowMetrics";
import {
  getEditorCockpit,
  promoteCluster,
  rejectCluster,
  boostClusterSources,
  EditorCockpitError,
} from "../../services/editorCockpit";

const router: IRouter = Router();

// Accept either an ISO string or an epoch-ms number for the metrics window.
function parseWhen(value: unknown): Date | undefined {
  if (value == null || value === "") return undefined;
  const s = String(value);
  const asNum = Number(s);
  const d = Number.isFinite(asNum) && /^\d+$/.test(s) ? new Date(asNum) : new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// GET /admin/shadow-metrics — recorded (never estimated) pipeline metrics.
router.get("/shadow-metrics", async (req, res) => {
  const from = parseWhen(req.query["from"]);
  const to = parseWhen(req.query["to"]);
  const metrics = await getShadowMetrics({ from, to });
  res.json(metrics);
});

// GET /admin/editor-cockpit — deterministic daily digest (no AI call).
router.get("/editor-cockpit", async (_req, res) => {
  const cockpit = await getEditorCockpit();
  res.json(cockpit);
});

const rejectSchema = z.object({
  clusterId: z.string().min(1),
  packetId: z.string().nullable().optional(),
  surface: z.enum(EDITORIAL_REVIEW_SURFACE),
  reason: z.enum(EDITORIAL_REJECTION_REASON),
  note: z.string().max(2000).nullable().optional(),
});

// POST /admin/editor-cockpit/reject — one-click structured rejection.
router.post("/editor-cockpit/reject", async (req, res) => {
  const parsed = rejectSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  try {
    const result = await rejectCluster(parsed.data.clusterId, {
      reason: parsed.data.reason,
      packetId: parsed.data.packetId ?? null,
      surface: parsed.data.surface,
      note: parsed.data.note ?? null,
      createdBy: req.session?.adminEmail ?? null,
    });
    res.json(result);
  } catch (e) {
    if (e instanceof EditorCockpitError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    throw e;
  }
});

const EDITORIAL_LABEL_VALUES = ["original_reporting", "research_synthesis", "analysis", "explainer", "commentary"] as const;
const promoteSchema = z.object({
  clusterId: z.string().min(1),
  packetId: z.string().nullable().optional(),
  surface: z.enum(EDITORIAL_REVIEW_SURFACE),
  note: z.string().max(2000).nullable().optional(),
  editorialLabelOverride: z.enum(EDITORIAL_LABEL_VALUES).nullable().optional(),
});

// POST /admin/editor-cockpit/promote — one-click promote into the draft funnel
// (never auto-publishes). Returns 202: an approved pipeline idea was created and a
// background draft kickoff was attempted (fire-and-forget; if the kickoff fails
// the idea stays approved in the author's bank for the pipeline to draft later).
router.post("/editor-cockpit/promote", async (req, res) => {
  const parsed = promoteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  try {
    const result = await promoteCluster(parsed.data.clusterId, {
      packetId: parsed.data.packetId ?? null,
      surface: parsed.data.surface,
      note: parsed.data.note ?? null,
      createdBy: req.session?.adminEmail ?? null,
      editorialLabelOverride: parsed.data.editorialLabelOverride ?? null,
    });
    res.status(202).json(result);
  } catch (e) {
    if (e instanceof EditorCockpitError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    throw e;
  }
});

const sourceBoostSchema = z.object({
  clusterId: z.string().min(1),
});

// POST /admin/editor-cockpit/source-boost — targeted source search for a cluster
// that can't be promoted yet. Finds + ingests + embeds fresh sources, attaches
// them, then re-screens (vault-only). Deliberate paid action; never automated.
router.post("/editor-cockpit/source-boost", async (req, res) => {
  const parsed = sourceBoostSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
    return;
  }
  try {
    const result = await boostClusterSources(parsed.data.clusterId);
    req.log?.info(
      {
        adminEmail: req.session?.adminEmail,
        clusterId: parsed.data.clusterId,
        added: result.added,
        attached: result.attached,
        decision: result.decision,
      },
      "editor cockpit: source boost",
    );
    res.json(result);
  } catch (e) {
    if (e instanceof EditorCockpitError) {
      res.status(e.status).json({ error: e.message });
      return;
    }
    throw e;
  }
});

export default router;
