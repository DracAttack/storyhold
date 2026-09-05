import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { getSiteSettings, updateSiteSettings } from "../../services/siteSettings";

const router: IRouter = Router();

router.get("/site-settings", async (_req, res) => {
  const s = await getSiteSettings();
  res.json(s);
});

router.patch("/site-settings", async (req, res) => {
  const hour = () => z.number().int().min(0).max(23).optional();
  const weekday = () => z.number().int().min(0).max(6).optional();
  const parsed = z
    .object({
      adsEnabled: z.boolean().optional(),
      pipelineEnabled: z.boolean().optional(),
      dedupeScanEnabled: z.boolean().optional(),
      weeklyNewsletterEnabled: z.boolean().optional(),
      dailyDigestEnabled: z.boolean().optional(),
      socialAutoPostEnabled: z.boolean().optional(),
      contentActiveStartHour: hour(),
      contentActiveEndHour: hour(),
      approvedIdeaCap: z.number().int().min(1).max(500).optional(),
      publishCheckMinutes: z.number().int().min(1).max(60).optional(),
      autoApproveEnabled: z.boolean().optional(),
      autoApproveHours: z.number().int().min(1).max(2160).optional(),
      autoLockEnabled: z.boolean().optional(),
      autoLockHours: z.number().int().min(1).max(2160).optional(),
      weeklyNewsletterWeekday: weekday(),
      weeklyNewsletterHour: hour(),
      dedupeScanHour: hour(),
      dedupeScanFrequency: z.enum(["daily", "weekly"]).optional(),
      dedupeScanWeekday: weekday(),
      memeQueueActivated: z.boolean().optional(),
      memeQueuePaused: z.boolean().optional(),
      sourceDiscoveryEnabled: z.boolean().optional(),
      sourceFreshnessDefaultDays: z.number().int().min(1).max(365).optional(),
      sourceFreshnessByBeat: z.record(z.string(), z.number().int().min(1).max(365)).optional(),
      hotMarkerHarvestEnabled: z.boolean().optional(),
      hotMarkerObservationThreshold: z.number().int().min(1).max(100).optional(),
      hotMarkerPlatformThreshold: z.number().int().min(1).max(20).optional(),
      sourceLinkInsertionMode: z
        .enum(["off", "vault_only", "vault_first_with_capped_search", "legacy_web_search"])
        .optional(),
      draftResearchMode: z
        .enum(["vault_required", "vault_first_harvest_if_needed", "legacy_web_search"])
        .optional(),
      conceptExplainersEnabled: z.boolean().optional(),
      conceptDetectionThreshold: z.number().min(0).max(1).optional(),
      conceptDefinitionThreshold: z.number().min(0).max(1).optional(),
      conceptDensityMaxDefault: z.number().int().min(0).max(50).optional(),
      conceptDensityMaxLong: z.number().int().min(0).max(50).optional(),
      termOfDayEnabled: z.boolean().optional(),
      termOfDayDraftOnly: z.boolean().optional(),
      termOfDayHourUtc: hour(),
      termOfDayHour2Utc: z.number().int().min(0).max(23).nullable().optional(),
      termOfDayCooldownDays: z.number().int().min(180).max(3650).optional(),
      termOfDayMinArticles: z.number().int().min(0).max(50).optional(),
      termOfDayMaxHashtags: z.number().int().min(2).max(15).optional(),
      termOfDayIncludedBeats: z.array(z.string()).max(50).optional(),
      termOfDayExcludedBeats: z.array(z.string()).max(50).optional(),
      termOfDayExcludedModuleTypes: z.array(z.string()).max(10).optional(),
      termOfDayImageEnabled: z.boolean().optional(),
      termOfDayGeneralInterestStrength: z.number().min(0).max(3).optional(),
      termOfDayTechnicalPenaltyStrength: z.number().min(0).max(1).optional(),
      termOfDayBeatWindow: z.number().int().min(0).max(60).optional(),
      termOfDayEngagementWeighting: z.boolean().optional(),
      semanticClusterReconcileEnabled: z.boolean().optional(),
      reconcileJaccardLow: z.number().min(0).max(1).optional(),
      reconcileJaccardHigh: z.number().min(0).max(1).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  const s = await updateSiteSettings(parsed.data);
  res.json(s);
});

export default router;
