import {
  db,
  aiUsageEventsTable,
  articlesTable,
  evidencePacketsTable,
  editorialReviewActionsTable,
  EDITORIAL_REJECTION_REASON,
  type EditorialRejectionReason,
} from "@workspace/db";
import { and, gte, lt, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

// --- Shadow metrics (Task #202) ----------------------------------------
// A READ-ONLY aggregation over tables that already RECORD their outcomes:
//   - ai_usage_events        → actual AI / search / image spend (billed at call time)
//   - evidence_packets       → screening decisions, source reuse, dedupe avoidance
//   - articles               → verified drafts produced
//   - editorial_review_actions → the editor's structured reject / promote feedback
// Every number here is a recorded value. Nothing is an estimate or a projected
// "savings" figure — the headline is recorded cost per VERIFIED draft (the once-
// per-article production spend divided by the drafts that actually became
// articles, i.e. passed drafting + verification).

export interface ShadowMetricsWindow {
  from?: Date;
  to?: Date;
}

export interface ShadowMetrics {
  window: { from: string | null; to: string | null };
  spend: {
    totalUsd: number;
    productionUsd: number;
    webSearchUsd: number;
    imageUsd: number;
    calls: number;
    webSearches: number;
    images: number;
  };
  drafts: {
    verifiedDrafts: number;
    productionCostUsd: number;
    costPerVerifiedDraftUsd: number;
  };
  screening: {
    totalPackets: number;
    approveDraft: number;
    approveResearch: number;
    needsHumanEditor: number;
    rejected: number;
    quarantineRatePct: number;
    acceptanceRatePct: number;
    rejectionRatePct: number;
    byDecision: { decision: string; count: number }[];
  };
  sourceReuse: {
    vaultOnlyPackets: number;
    sonarPackets: number;
    deepResearchPackets: number;
    paidResearchPackets: number;
    vaultOnlyRatePct: number;
    totalVaultHits: number;
  };
  duplicateAvoidance: {
    rejectDuplicatePackets: number;
  };
  editorFeedback: {
    totalActions: number;
    promotes: number;
    rejects: number;
    byRejectionReason: { reason: EditorialRejectionReason; count: number }[];
  };
}

function windowConds(col: PgColumn, w: ShadowMetricsWindow): SQL[] {
  const c: SQL[] = [];
  if (w.from) c.push(gte(col, w.from));
  if (w.to) c.push(lt(col, w.to));
  return c;
}

function pct(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

/**
 * Aggregate the recorded shadow-pipeline metrics for an optional [from, to)
 * window. All values come straight from recorded tables; there are no estimated
 * or projected figures. Numeric SUM/aggregate columns come back from the driver
 * as strings, so every one is coerced with Number().
 */
export async function getShadowMetrics(w: ShadowMetricsWindow = {}): Promise<ShadowMetrics> {
  // --- Spend (ai_usage_events) -----------------------------------------
  const spendWhere = (() => {
    const c = windowConds(aiUsageEventsTable.createdAt, w);
    return c.length ? and(...c) : undefined;
  })();
  const [spendRow] = await db
    .select({
      totalCost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}), 0)`,
      calls: sql<number>`COUNT(*)`,
      webSearches: sql<number>`COALESCE(SUM(${aiUsageEventsTable.webSearches}), 0)`,
      images: sql<number>`COALESCE(SUM(${aiUsageEventsTable.images}), 0)`,
      webSearchCost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}) FILTER (WHERE ${aiUsageEventsTable.webSearches} > 0), 0)`,
      imageCost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}) FILTER (WHERE ${aiUsageEventsTable.images} > 0), 0)`,
      // Once-per-article production spend: the draft LLM call, its hook/social
      // pack, and its hero image (mirrors the AI-costs meter's definition).
      productionCost: sql<number>`COALESCE(SUM(${aiUsageEventsTable.costUsd}) FILTER (WHERE ${aiUsageEventsTable.operation} IN ('generateArticleDraft', 'generateHooksAndSocialPack', 'generateAndStoreHeroImage')), 0)`,
    })
    .from(aiUsageEventsTable)
    .where(spendWhere);

  const totalUsd = Number(spendRow?.totalCost ?? 0);
  const productionUsd = Number(spendRow?.productionCost ?? 0);

  // --- Verified drafts (articles produced in-window) -------------------
  // A draft that reached an `articles` row is a VERIFIED draft: it passed the
  // drafting + concept-safety / verification stages (failed drafts never create
  // a row). Cost per verified draft = production spend ÷ that count.
  const artWhere = (() => {
    const c = windowConds(articlesTable.createdAt, w);
    return c.length ? and(...c) : undefined;
  })();
  const [artRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(articlesTable)
    .where(artWhere);
  const verifiedDrafts = Number(artRow?.count ?? 0);

  // --- Screening + source reuse (evidence_packets) ---------------------
  const packetWhere = (() => {
    const c = windowConds(evidencePacketsTable.createdAt, w);
    return c.length ? and(...c) : undefined;
  })();
  const decisionRows = await db
    .select({
      decision: evidencePacketsTable.decision,
      count: sql<number>`COUNT(*)`,
    })
    .from(evidencePacketsTable)
    .where(packetWhere)
    .groupBy(evidencePacketsTable.decision);

  const decisionCounts = new Map<string, number>();
  for (const r of decisionRows) decisionCounts.set(r.decision, Number(r.count ?? 0));
  const dc = (k: string) => decisionCounts.get(k) ?? 0;
  const totalPackets = [...decisionCounts.values()].reduce((a, b) => a + b, 0);
  const approveDraft = dc("approve_draft");
  const approveResearch = dc("approve_research");
  const needsHumanEditor = dc("needs_human_editor");
  const rejected =
    dc("reject_duplicate") +
    dc("reject_too_thin") +
    dc("reject_low_authority") +
    dc("reject_stale") +
    dc("reject_out_of_beat") +
    dc("reject_too_risky");

  const researchRows = await db
    .select({
      mode: evidencePacketsTable.researchMode,
      count: sql<number>`COUNT(*)`,
      vaultHits: sql<number>`COALESCE(SUM((${evidencePacketsTable.retrievalContext} ->> 'vaultHitCount')::int), 0)`,
    })
    .from(evidencePacketsTable)
    .where(packetWhere)
    .groupBy(evidencePacketsTable.researchMode);
  const modeCounts = new Map<string, number>();
  let totalVaultHits = 0;
  for (const r of researchRows) {
    modeCounts.set(r.mode, Number(r.count ?? 0));
    totalVaultHits += Number(r.vaultHits ?? 0);
  }
  const vaultOnlyPackets = modeCounts.get("vault_only") ?? 0;
  const sonarPackets = modeCounts.get("sonar") ?? 0;
  const deepResearchPackets = modeCounts.get("deep_research") ?? 0;

  // --- Editor feedback (editorial_review_actions) ----------------------
  const actionWhere = (() => {
    const c = windowConds(editorialReviewActionsTable.createdAt, w);
    return c.length ? and(...c) : undefined;
  })();
  const actionRows = await db
    .select({
      action: editorialReviewActionsTable.action,
      count: sql<number>`COUNT(*)`,
    })
    .from(editorialReviewActionsTable)
    .where(actionWhere)
    .groupBy(editorialReviewActionsTable.action);
  const actionCounts = new Map<string, number>();
  for (const r of actionRows) actionCounts.set(r.action, Number(r.count ?? 0));
  const promotes = actionCounts.get("promote") ?? 0;
  const rejects = actionCounts.get("reject") ?? 0;

  const reasonRows = await db
    .select({
      reason: editorialReviewActionsTable.rejectionReason,
      count: sql<number>`COUNT(*)`,
    })
    .from(editorialReviewActionsTable)
    .where(actionWhere)
    .groupBy(editorialReviewActionsTable.rejectionReason);
  const reasonCounts = new Map<string, number>();
  for (const r of reasonRows) {
    if (r.reason) reasonCounts.set(r.reason, Number(r.count ?? 0));
  }
  const byRejectionReason = EDITORIAL_REJECTION_REASON.map((reason) => ({
    reason,
    count: reasonCounts.get(reason) ?? 0,
  }));

  return {
    window: { from: w.from?.toISOString() ?? null, to: w.to?.toISOString() ?? null },
    spend: {
      totalUsd,
      productionUsd,
      webSearchUsd: Number(spendRow?.webSearchCost ?? 0),
      imageUsd: Number(spendRow?.imageCost ?? 0),
      calls: Number(spendRow?.calls ?? 0),
      webSearches: Number(spendRow?.webSearches ?? 0),
      images: Number(spendRow?.images ?? 0),
    },
    drafts: {
      verifiedDrafts,
      productionCostUsd: productionUsd,
      costPerVerifiedDraftUsd: verifiedDrafts > 0 ? productionUsd / verifiedDrafts : 0,
    },
    screening: {
      totalPackets,
      approveDraft,
      approveResearch,
      needsHumanEditor,
      rejected,
      quarantineRatePct: pct(needsHumanEditor, totalPackets),
      acceptanceRatePct: pct(approveDraft + approveResearch, totalPackets),
      rejectionRatePct: pct(rejected, totalPackets),
      byDecision: decisionRows
        .map((r) => ({ decision: r.decision, count: Number(r.count ?? 0) }))
        .sort((a, b) => b.count - a.count),
    },
    sourceReuse: {
      vaultOnlyPackets,
      sonarPackets,
      deepResearchPackets,
      paidResearchPackets: sonarPackets + deepResearchPackets,
      vaultOnlyRatePct: pct(vaultOnlyPackets, totalPackets),
      totalVaultHits,
    },
    duplicateAvoidance: {
      rejectDuplicatePackets: dc("reject_duplicate"),
    },
    editorFeedback: {
      totalActions: promotes + rejects,
      promotes,
      rejects,
      byRejectionReason,
    },
  };
}
