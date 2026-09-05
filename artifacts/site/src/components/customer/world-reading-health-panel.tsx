import { useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpenCheck,
  CheckCircle2,
  ChevronDown,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { WorldPremiumReviewButton } from "@/components/customer/world-premium-review-button";
import {
  analyzeWorldSources,
  dismissWorldQualityFinding,
  resumeWorldIntake,
  type WorldDetail,
  type WorldQualityFinding,
} from "@/lib/storyholdApi";
import { Textarea } from "@/components/ui/textarea";

type ReadingStatus =
  | "ready"
  | "local_ready"
  | "reading"
  | "premium_reading"
  | "premium_paused"
  | "retry";

const categoryLabels: Record<WorldQualityFinding["category"], string> = {
  coverage: "Reading coverage",
  evidence: "Source evidence",
  character: "Characters",
  chronology: "Chronology",
  relationship: "Relationships",
  contradiction: "Possible contradictions",
};

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

function sourceCoverage(detail: WorldDetail) {
  return detail.sources.map((source) => {
    const total = Math.max(0, Number(source.chunkCount ?? 0));
    const reviewed = Math.min(total, Math.max(0, Number(source.aiReviewedChunkCount ?? 0)));
    return {
      id: source.id,
      title: source.title,
      aiReviewed: reviewed,
      localReviewed: ["completed", "not_applicable"].includes(source.localScanStatus)
        ? total
        : 0,
      total,
      applicable: source.aiReviewStatus !== "not_applicable" && total > 0,
      active: ["queued", "running"].includes(source.aiReviewStatus) ||
        ["queued", "running"].includes(source.localScanStatus),
      waiting: source.aiReviewStatus === "waiting",
      failed: source.aiReviewStatus === "failed" || source.localScanStatus === "failed",
    };
  });
}

function premiumReviewComplete(detail: WorldDetail) {
  const run = detail.latestRun;
  return run?.analysisKind === "ai_enrichment" &&
    run.status === "completed" &&
    detail.intakePipeline.status === "ready" &&
    (run.synthesisStatus === "completed" || run.synthesisStatus === "not_applicable");
}

function readingStatus(detail: WorldDetail, findings: WorldQualityFinding[]): ReadingStatus {
  const latestRun = detail.latestRun;
  const premiumRun = latestRun?.analysisKind === "ai_enrichment";
  if (premiumRun && detail.intakePipeline.status === "paused") {
    return "premium_paused";
  }
  if (premiumRun && (latestRun.status === "queued" || latestRun.status === "running")) {
    return "premium_reading";
  }
  const premiumComplete = premiumReviewComplete(detail);
  if (premiumComplete) return "ready";

  const coverage = sourceCoverage(detail).filter((source) => source.applicable);
  const runActive = latestRun?.status === "queued" || latestRun?.status === "running";
  const sourceActive = coverage.some((source) => source.active);
  const synthesisPending = latestRun?.synthesisStatus === "pending";
  if (runActive || sourceActive || synthesisPending) {
    return "reading";
  }

  const incomplete = coverage.some(
    (source) => source.aiReviewed < source.total || source.waiting,
  );
  const failed = latestRun?.status === "failed" || latestRun?.synthesisStatus === "failed" || coverage.some((source) => source.failed);
  const importantFinding = findings.some((finding) => finding.severity === "warning" || finding.severity === "critical");
  if (premiumRun && latestRun?.status === "completed" && !premiumComplete) return "retry";
  if (premiumRun && (failed || incomplete || importantFinding)) return "retry";
  if (detail.intakePipeline.canOpenWorld) return "local_ready";
  return failed || incomplete || importantFinding ? "retry" : "ready";
}

function synthesisCopy(detail: WorldDetail) {
  const run = detail.latestRun;
  switch (run?.synthesisStatus) {
    case "completed":
      return run.synthesisGroupCount
        ? `The whole-world check connected ${formatNumber(run.synthesisCompletedGroups ?? run.synthesisGroupCount)} of ${formatNumber(run.synthesisGroupCount)} evidence groups.`
        : "The whole-world consistency check is complete.";
    case "pending":
      return "Storyhold is connecting findings across chapters, books, and timelines.";
    case "failed":
      return /credit/iu.test(run.synthesisError ?? "")
        ? "The final consistency check paused when available credits ran out. Saved findings are intact."
        : "The chapter readings were saved, but the final cross-book consistency check needs another pass.";
    case "not_applicable":
      return "No separate whole-world consistency result is recorded for this review yet.";
    default:
      return null;
  }
}

function localExtractionCopy(detail: WorldDetail) {
  const run = detail.latestRun;
  if (!run || run.analysisKind !== "local_scan") return null;
  const completed = formatNumber(run.localExtractionCompletedSegments ?? 0);
  const attempted = formatNumber(run.localExtractionAttemptedSegments ?? 0);
  const mentions = formatNumber(run.localExtractionMentionCount ?? 0);
  const relations = formatNumber(run.localExtractionRelationCount ?? 0);
  switch (run.localExtractionStatus) {
    case "completed":
      return `Storyhold privately classified ${mentions} exact-source mentions and ${relations} relationship leads across ${completed} source passages. Uncertain candidates remain in the review layer instead of appearing as canon.`;
    case "partial":
      return `Storyhold classified ${completed} of ${attempted} source passages and preserved ${mentions} mentions plus ${relations} relationship leads for continued review.`;
    case "failed":
      return "The private story reader was unavailable, so Storyhold preserved the complete source inventory and marked the deeper reading for attention.";
    default:
      return null;
  }
}

export function WorldReadingHealthPanel({
  detail,
  onReviewStarted,
}: {
  detail: WorldDetail;
  onReviewStarted?: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const [startedRunId, setStartedRunId] = useState<string | null>(null);
  const [guidance, setGuidance] = useState("");
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const findings = (detail.qualityFindings ?? []).filter((finding) =>
    !finding.status || finding.status === "open",
  );
  const premiumRun = detail.latestRun?.analysisKind === "ai_enrichment";
  const premiumComplete = premiumReviewComplete(detail);
  const premiumPaused = premiumRun && detail.intakePipeline.status === "paused";
  const premiumRunning = premiumRun &&
    (detail.latestRun?.status === "queued" || detail.latestRun?.status === "running");
  const showPremiumCoverage = premiumRun;
  const coverage = sourceCoverage(detail).map((source) => ({
    ...source,
    reviewed: showPremiumCoverage ? source.aiReviewed : source.localReviewed,
  }));
  const reviewable = coverage.filter((source) => source.applicable);
  const totalChunks = reviewable.reduce((total, source) => total + source.total, 0);
  const reviewedChunks = reviewable.reduce((total, source) => total + source.reviewed, 0);
  const derivedStatus = readingStatus(detail, findings);
  const startedRunPending = Boolean(
    startedRunId &&
    (detail.latestRun?.id !== startedRunId || ["queued", "running"].includes(detail.latestRun.status)),
  );
  const activelyRunning = startedRunPending ||
    detail.latestRun?.status === "queued" ||
    detail.latestRun?.status === "running" ||
    (!premiumPaused && reviewable.some((source) => source.active));
  const status: ReadingStatus = startedRunPending ? "reading" : derivedStatus;
  const synthesis = synthesisCopy(detail);
  const localExtraction = localExtractionCopy(detail);

  const groupedFindings = useMemo(() => {
    const groups = new Map<WorldQualityFinding["category"], WorldQualityFinding[]>();
    for (const finding of findings) {
      const current = groups.get(finding.category) ?? [];
      current.push(finding);
      groups.set(finding.category, current);
    }
    return [...groups.entries()];
  }, [findings]);

  const statusPresentation = status === "ready"
    ? {
        label: "Sources fully reviewed",
        summary: totalChunks
          ? "Storyhold has finished reading every uploaded passage and checking how the findings connect."
          : "There is no unfinished source review in this world.",
        Icon: CheckCircle2,
        className: "border-emerald-400/20 bg-emerald-400/[0.045]",
        iconClassName: "text-emerald-300",
      }
    : status === "premium_reading"
      ? {
          label: "Premium Deep Reading in progress",
          summary: "Storyhold is checking the cited local findings against the source passages. Your locally built world remains usable while this optional review runs.",
          Icon: Loader2,
          className: "border-primary/20 bg-primary/[0.045]",
          iconClassName: "animate-spin text-primary",
        }
    : status === "premium_paused"
      ? {
          label: "Premium Deep Reading paused",
          summary: detail.latestRun?.premiumResumeStatus === "blocked"
            ? "This premium review needs attention before resuming. Your saved world remains usable."
            : "The premium review is saved. Resume continues the same review without repeating completed reading. Unused held credits return after settlement; higher actual usage may use additional available credits.",
          Icon: BookOpenCheck,
          className: "border-amber-300/20 bg-amber-300/[0.045]",
          iconClassName: "text-amber-300",
        }
    : status === "local_ready"
      ? {
          label: "Storyhold World Ready",
          summary: "Storyhold has read and organized the uploaded passages. You can use the world now; Premium Deep Reading remains optional.",
          Icon: CheckCircle2,
          className: "border-emerald-400/20 bg-emerald-400/[0.045]",
          iconClassName: "text-emerald-300",
        }
    : status === "reading"
      ? {
          label: "Review in progress",
          summary: "Storyhold is reading the uploaded sources in batches. Completed passages are saved as it goes.",
          Icon: Loader2,
          className: "border-primary/20 bg-primary/[0.045]",
          iconClassName: "animate-spin text-primary",
        }
      : {
          label: premiumRun ? "Premium Deep Reading incomplete" : "Source review incomplete",
          summary: premiumRun
            ? "Some passages or the final consistency check still need premium review. Your locally built world remains saved and usable."
            : "Some passages or connections still need review. Everything already found remains saved.",
          Icon: AlertTriangle,
          className: "border-amber-300/20 bg-amber-300/[0.045]",
          iconClassName: "text-amber-300",
        };

  const startReview = async () => {
    setStarting(true);
    try {
      const hasSavedCheckpoint = Boolean(detail.latestRun?.localCheckpointStage);
      if (detail.intakePipeline.canRetryLocal && hasSavedCheckpoint) {
        const response = await resumeWorldIntake(detail.world.id);
        setStartedRunId(response.runId ?? detail.latestRun?.id ?? null);
        toast.success("Source reading is continuing from its saved progress.");
      } else {
        const response = await analyzeWorldSources(detail.world.id, {
          guidance: guidance.trim(),
        });
        setStartedRunId(response.run.id);
        toast.success(hasSavedCheckpoint ? "Source reading has resumed." : "Storyhold has started reading the sources.");
      }
      onReviewStarted?.();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The full review could not be started.");
    } finally {
      setStarting(false);
    }
  };

  const resumePremiumReview = async () => {
    setStarting(true);
    try {
      const response = await resumeWorldIntake(detail.world.id);
      setStartedRunId(response.runId ?? detail.latestRun?.id ?? null);
      toast.success("Premium Deep Reading is resuming.");
      onReviewStarted?.();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Premium Deep Reading could not be resumed.");
    } finally {
      setStarting(false);
    }
  };

  const dismissFinding = async (finding: WorldQualityFinding) => {
    if (dismissingId) return;
    setDismissingId(finding.id);
    try {
      await dismissWorldQualityFinding({
        worldId: detail.world.id,
        findingId: finding.id,
      });
      toast.success("That source-review notice was dismissed.");
      onReviewStarted?.();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The notice could not be dismissed.");
    } finally {
      setDismissingId(null);
    }
  };

  return (
    <Card className={`mt-5 rounded-3xl p-5 sm:p-6 ${statusPresentation.className}`}>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div className="flex min-w-0 items-start gap-3">
          <span className="rounded-xl bg-black/20 p-2.5">
            <statusPresentation.Icon className={`h-5 w-5 ${statusPresentation.iconClassName}`} />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Source Review</p>
            <h2 className="mt-1 font-serif text-2xl font-bold">{statusPresentation.label}</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{statusPresentation.summary}</p>
          </div>
        </div>
        {detail.intakePipeline.canOpenWorld && premiumPaused ? (
          <Button
            type="button"
            variant="outline"
            className="shrink-0 rounded-xl"
            disabled={starting}
            onClick={() => void resumePremiumReview()}
          >
            {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {starting ? "Resuming Premium Deep Reading" : "Resume Premium Deep Reading"}
          </Button>
        ) : detail.intakePipeline.canOpenWorld && detail.intakePipeline.canStartPremiumReview ? (
          <WorldPremiumReviewButton
            worldId={detail.world.id}
            className="shrink-0 rounded-xl"
            label={premiumComplete
              ? "Run Premium Deep Reading again"
              : premiumRun
                ? "Retry Premium Deep Reading"
                : "Start Premium Deep Reading"}
            initialGuidance={guidance}
            onStarted={(runId) => {
              setStartedRunId(runId);
              onReviewStarted?.();
            }}
          />
        ) : detail.intakePipeline.canOpenWorld ? (
          <Button type="button" variant="outline" className="shrink-0 rounded-xl" disabled>
            {premiumRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {premiumRunning ? "Premium Deep Reading running" : "Premium AI not connected"}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="shrink-0 rounded-xl"
            disabled={starting || activelyRunning || detail.sources.length === 0}
            onClick={() => void startReview()}
          >
            {starting || activelyRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {status === "retry"
              ? detail.latestRun?.localCheckpointStage
                ? "Resume Source Reading"
                : "Restart Source Reading"
              : "Reading Sources"}
          </Button>
        )}
      </div>

      {totalChunks > 0 ? (
        <div className="mt-5">
          <div className="flex justify-between gap-4 text-xs text-muted-foreground">
            <span>{showPremiumCoverage ? "Passages premium-reviewed" : "Passages indexed locally"}</span>
            <span>{formatNumber(reviewedChunks)} / {formatNumber(totalChunks)} passages</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-black/25">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${Math.min(100, Math.round((reviewedChunks / totalChunks) * 100))}%` }}
            />
          </div>
        </div>
      ) : null}

      <details className="mt-4 rounded-xl border border-white/8 bg-black/15 px-3 py-2.5">
        <summary className="cursor-pointer text-sm font-semibold">Guide the Next Review</summary>
        <div className="mt-3 border-t border-white/8 pt-3">
          <p className="text-xs leading-5 text-muted-foreground">
            Point Storyhold at a difficult passage or state an author correction. A full rerun will use this as direction while still checking the manuscript evidence.
          </p>
          <Textarea
            className="mt-3 min-h-24 resize-y bg-black/20 text-sm leading-6"
            value={guidance}
            onChange={(event) => setGuidance(event.target.value.slice(0, 4_000))}
            placeholder="Examples: Echo is not literally Alec's daughter. Recheck the flashback chronology in Book One. Review how Michael's Thrall form affects his abilities."
            disabled={starting || activelyRunning}
          />
          <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
            This direction is stored with the review run. It does not replace source citations or silently become a manuscript fact.
          </p>
        </div>
      </details>

      {detail.latestRun?.analysisKind === "ai_enrichment" && status !== "ready" && synthesis ? (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-white/8 bg-black/15 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
          <BookOpenCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>{synthesis}</span>
        </div>
      ) : null}

      {(status === "reading" || status === "local_ready") && localExtraction ? (
        <div className="mt-2 flex items-start gap-2 rounded-xl border border-white/8 bg-black/15 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
          <BookOpenCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span>{localExtraction}</span>
        </div>
      ) : null}

      {(groupedFindings.length || coverage.some((source) => source.applicable && source.reviewed < source.total)) ? (
        <div className="mt-4 space-y-2">
          {groupedFindings.map(([category, categoryFindings]) => (
            <details key={category} className="group rounded-xl border border-white/8 bg-black/15 px-3 py-2.5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold">
                <span>{categoryLabels[category]} <span className="font-normal text-muted-foreground">({categoryFindings.length})</span></span>
                <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-3 space-y-3 border-t border-white/8 pt-3">
                {categoryFindings.map((finding) => (
                  <div key={finding.id} className="rounded-xl border border-white/6 bg-black/10 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold">{finding.label}</p>
                        {finding.severity === "critical" ? <span className="rounded-full bg-red-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-300">Important</span> : null}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 rounded-lg px-2 text-[11px] text-muted-foreground"
                        disabled={Boolean(dismissingId)}
                        onClick={() => void dismissFinding(finding)}
                      >
                        {dismissingId === finding.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        Dismiss
                      </Button>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{finding.explanation}</p>
                    {finding.recommendedTask ? <p className="mt-1 text-xs leading-5 text-foreground/80">Next: {finding.recommendedTask}</p> : null}
                  </div>
                ))}
              </div>
            </details>
          ))}

          {coverage.some((source) => source.applicable && source.reviewed < source.total) ? (
            <details className="group rounded-xl border border-white/8 bg-black/15 px-3 py-2.5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold">
                <span>Sources still being reviewed</span>
                <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-3 space-y-2 border-t border-white/8 pt-3">
                {coverage.filter((source) => source.applicable && source.reviewed < source.total).map((source) => (
                  <div key={source.id} className="flex items-center justify-between gap-4 text-xs">
                    <span className="min-w-0 truncate text-foreground/85">{source.title}</span>
                    <span className={source.applicable && source.reviewed < source.total ? "shrink-0 text-amber-200" : "shrink-0 text-muted-foreground"}>
                      {source.total === 0
                        ? "No readable passages"
                        : source.applicable
                          ? `${formatNumber(source.reviewed)} / ${formatNumber(source.total)}`
                          : "Local index only"}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      <p className="mt-4 text-[11px] leading-5 text-muted-foreground">
        This status only tells you which reading passes are complete; it does not judge the quality of your writing. {(detail.premiumAi?.configured ?? detail.ai.configured)
          ? "Premium Deep Reading is optional, records completed passage coverage as it goes, and never erases owner canon."
          : "The locally built world remains usable without a connected premium reviewer."}
      </p>
    </Card>
  );
}
