import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Loader2,
  Pause,
  Play,
} from "lucide-react";
import { Link, useParams } from "wouter";
import { ProfileFrame } from "@/components/customer/profile-frame";
import { WorldReadingHealthPanel } from "@/components/customer/world-reading-health-panel";
import { WorldPremiumReviewButton } from "@/components/customer/world-premium-review-button";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/lib/auth";
import { useSeo } from "@/lib/seo";
import { toChicagoTitleCase } from "@/lib/utils";
import {
  accelerateBrowserLocalAuditBatch,
  getWorld,
  pauseBrowserLocalAudit,
  pauseWorldIntake,
  retryBrowserLocalAudit,
  resumeWorldIntake,
  startBrowserLocalAudit,
  submitBrowserLocalAuditBatch,
  type WorldDetail,
} from "@/lib/storyholdApi";
import {
  inspectBrowserLorekeeper,
  persistBrowserModelCache,
  releaseBrowserLorekeeperEngine,
  runBrowserLorekeeperBatch,
} from "@/lib/browserLorekeeper";
import {
  getBrowserLorekeeperPreference,
  setBrowserLorekeeperPreference,
  type BrowserLorekeeperPreference,
} from "@/lib/browserLorekeeperSettings";

export default function ProfileWorldIntake() {
  const auth = useAuth();
  const { worldId = "" } = useParams<{ worldId: string }>();
  const [detail, setDetail] = useState<WorldDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browserMessage, setBrowserMessage] = useState("");
  const [browserLoadProgress, setBrowserLoadProgress] = useState(0);
  const [browserRetryNonce, setBrowserRetryNonce] = useState(0);
  const [activityCursor, setActivityCursor] = useState(0);
  const activityCountRef = useRef(0);
  const [pauseAction, setPauseAction] = useState<"pausing" | "resuming" | "">("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [browserPreference, setBrowserPreference] = useState<BrowserLorekeeperPreference>(() =>
    getBrowserLorekeeperPreference(),
  );
  const activeBrowserBatch = useRef("");
  const browserAttempts = useRef(new Map<string, number>());
  const locallyAcceleratedAudits = useRef(new Set<string>());
  const creditReservationFailure = useRef("");

  const browserFailureMessage = (reason: unknown) => {
    if (reason instanceof Error && reason.message.trim()) return reason.message.trim();
    if (typeof reason === "string" && reason.trim()) return reason.trim();
    if (reason && typeof reason === "object") {
      const record = reason as Record<string, unknown>;
      for (const key of ["message", "error", "reason"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      try {
        const serialized = JSON.stringify(reason);
        if (serialized && serialized !== "{}") return serialized.slice(0, 1_000);
      } catch {
        // Fall through to the stable message below.
      }
    }
    return "Private Story Intelligence stopped without returning an error message.";
  };

  useSeo({
    title: detail ? `Canon Intake - ${detail.world.name}` : "Canon Intake",
    description: "Watch Storyhold read and organize your sources.",
    canonicalPath: `/profile/worlds/${worldId}/intake`,
    noindex: true,
  });

  useEffect(() => {
    if (!auth.email || !worldId) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await getWorld(worldId);
        if (!active) return;
        setDetail(next);
        setError(null);
      } catch (reason) {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "Canon Intake could not be opened.");
      } finally {
        if (active) timer = window.setTimeout(poll, 1_200);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [auth.email, worldId]);

  const browserAudit = detail?.latestBrowserAudit ?? null;
  const browserBatch = browserAudit?.nextBatch ?? null;

  useEffect(() => () => releaseBrowserLorekeeperEngine(), []);

  useEffect(() => {
    if (browserAudit && ["paused", "completed", "skipped", "failed"].includes(browserAudit.status)) {
      releaseBrowserLorekeeperEngine();
    }
  }, [browserAudit?.status]);

  useEffect(() => {
    if (!worldId || !browserAudit) return;
    if (!(["pending", "running"] as const).includes(browserAudit.status as "pending" | "running")) return;
    if (browserPreference === "unset") return;
    if (browserPreference === "disabled") locallyAcceleratedAudits.current.add(browserAudit.id);
    const needsCreditReservation = browserAudit.chargeStatus === "pending";
    if (needsCreditReservation && creditReservationFailure.current === browserAudit.id) return;
    if (!needsCreditReservation && !browserBatch) return;
    const batchKey = needsCreditReservation
      ? `${browserAudit.id}:credit-reservation`
      : `${browserAudit.id}:${browserBatch?.batchIndex ?? "waiting"}`;
    if (activeBrowserBatch.current === batchKey) return;
    activeBrowserBatch.current = batchKey;
    let cancelled = false;
    const run = async () => {
      try {
        if (needsCreditReservation) {
          setBrowserMessage("Preparing the private story review…");
          await startBrowserLocalAudit({ worldId, auditId: browserAudit.id });
          creditReservationFailure.current = "";
          return;
        }
        if (!browserBatch) return;
        const runLocalAcceleration = async () => {
          releaseBrowserLorekeeperEngine();
          locallyAcceleratedAudits.current.add(browserAudit.id);
          setBrowserMessage(`Reviewing ${browserBatch.candidates[0]?.name || "story findings"} with Private Story Intelligence…`);
          setBrowserLoadProgress(0);
          return accelerateBrowserLocalAuditBatch({
            worldId,
            auditId: browserAudit.id,
            batchIndex: browserBatch.batchIndex,
          });
        };
        let completed;
        if (locallyAcceleratedAudits.current.has(browserAudit.id)) {
          completed = await runLocalAcceleration();
        } else {
          setBrowserMessage("Checking whether this device can run the private story model…");
          await persistBrowserModelCache();
          const capability = await inspectBrowserLorekeeper();
          if (cancelled) return;
          if (!capability.supported) {
            completed = await runLocalAcceleration();
          } else {
            try {
              completed = await runBrowserLorekeeperBatch(
                browserBatch,
                capability,
                (progress) => {
                  if (cancelled) return;
                  setBrowserMessage(progress.message);
                  setBrowserLoadProgress(progress.progress);
                },
              );
            } catch {
              completed = await runLocalAcceleration();
            }
          }
        }
        if (cancelled) return;
        await submitBrowserLocalAuditBatch({
          worldId,
          auditId: browserAudit.id,
          batchIndex: browserBatch.batchIndex,
          ...completed,
        });
        browserAttempts.current.delete(batchKey);
      } catch (reason) {
        if (cancelled) return;
        if (needsCreditReservation) {
          creditReservationFailure.current = browserAudit.id;
          setBrowserMessage(
            reason instanceof Error
              ? reason.message
              : "Canon Intake could not continue.",
          );
          return;
        }
        const attempts = (browserAttempts.current.get(batchKey) ?? 0) + 1;
        browserAttempts.current.set(batchKey, attempts);
        const message = browserFailureMessage(reason);
        if (attempts >= 2) {
          releaseBrowserLorekeeperEngine();
          setBrowserMessage(`Private story reading paused after saving its completed work: ${message}`);
          await pauseBrowserLocalAudit({
            worldId,
            auditId: browserAudit.id,
            reason: message,
          }).catch(() => undefined);
        } else {
          setBrowserMessage("The private story model paused. Retrying this saved batch…");
          window.setTimeout(() => {
            if (activeBrowserBatch.current === batchKey) activeBrowserBatch.current = "";
            setBrowserRetryNonce((current) => current + 1);
          }, 1_000);
        }
      } finally {
        if (activeBrowserBatch.current === batchKey) activeBrowserBatch.current = "";
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [browserAudit?.chargeStatus, browserAudit?.id, browserAudit?.status, browserBatch?.batchIndex, browserPreference, browserRetryNonce, worldId]);

  const activityCount = detail?.latestRun?.intakeActivity?.length ?? 0;
  const activityRunId = detail?.latestRun?.id ?? "";
  const activityRunActive = detail?.latestRun?.status === "queued" || detail?.latestRun?.status === "running";
  const hasIntakeActivity = activityCount > 0;
  useEffect(() => {
    activityCountRef.current = activityCount;
    const firstVisible = Math.max(0, activityCount - 60);
    setActivityCursor((current) => current < firstVisible || current >= activityCount ? firstVisible : current);
  }, [activityCount]);

  useEffect(() => {
    if (!activityRunActive || !hasIntakeActivity) return;
    const timer = window.setInterval(() => {
      const currentCount = activityCountRef.current;
      const firstVisible = Math.max(0, currentCount - 60);
      setActivityCursor((current) => current >= currentCount - 1 ? firstVisible : current + 1);
    }, 1_600);
    return () => window.clearInterval(timer);
  }, [activityRunActive, activityRunId, hasIntakeActivity]);

  if (!detail && !error) {
    return (
      <ProfileFrame>
        <div className="grid min-h-[55vh] place-items-center">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
        </div>
      </ProfileFrame>
    );
  }

  if (!detail) {
    return (
      <ProfileFrame>
        <Card className="rounded-3xl border-red-400/20 bg-red-500/[0.05] p-7">
          <p>{error}</p>
          <Button asChild variant="outline" className="mt-5">
            <Link href="/profile/worlds">Back to Worlds</Link>
          </Button>
        </Card>
      </ProfileFrame>
    );
  }

  const run = detail.latestRun;
  const pipeline = detail.intakePipeline;
  const runActive = run?.status === "queued" || run?.status === "running";
  const browserPending = Boolean(
    browserAudit && (browserAudit.status === "pending" || browserAudit.status === "running"),
  );
  const browserRetryable = Boolean(
    browserAudit && browserAudit.status === "skipped" && browserAudit.error,
  );
  const openable = pipeline.canOpenWorld;
  const intakePaused = pipeline.status === "paused";
  const pauseRequested = Boolean(runActive && run?.pauseRequested);
  const premiumRun = run?.analysisKind === "ai_enrichment";
  const premiumActive = Boolean(premiumRun && runActive);
  const premiumPaused = Boolean(premiumRun && intakePaused);
  const premiumComplete = Boolean(
    premiumRun &&
    run?.status === "completed" &&
    pipeline.status === "ready" &&
    (run?.synthesisStatus === "completed" || run?.synthesisStatus === "not_applicable"),
  );
  const premiumNeedsRetry = Boolean(
    premiumRun &&
    !premiumActive &&
    !premiumPaused &&
    !premiumComplete &&
    (run?.status === "completed" || run?.status === "failed"),
  );
  const premiumContext = premiumActive || premiumPaused || premiumComplete || premiumNeedsRetry;
  const blockingFailure = pipeline.status === "failed";
  const latestActivity = run?.intakeActivity?.at(-1);
  const visibleActivity = runActive
    ? run?.intakeActivity?.[Math.min(activityCursor, Math.max(0, (run?.intakeActivity?.length ?? 1) - 1))] ?? latestActivity
    : latestActivity;
  const progress = browserPending
    ? Math.max(pipeline.progress, Math.min(99, pipeline.progress + Math.round(browserLoadProgress * 4)))
    : pipeline.progress;
  const statusText = browserPending
    ? browserMessage || pipeline.message
    : premiumNeedsRetry
      ? run?.stage || pipeline.message
    : runActive
      ? visibleActivity?.label || pipeline.message
      : pipeline.message;
  const savedStage = runActive || intakePaused || premiumNeedsRetry ? run?.stage?.trim() || "" : "";
  const savedExtractor = run?.intakePreview?.extractor?.trim() || "";
  const savedExtractorStage = savedExtractor.split("·")[0]?.trim().toLocaleLowerCase() || "";
  const savedPassageProgress = run?.intakePreview &&
    run.intakePreview.totalPassages > 0 &&
    savedExtractorStage &&
    savedStage.toLocaleLowerCase().includes(savedExtractorStage)
    ? `Reading Checkpoint ${run.intakePreview.completedPassages.toLocaleString()} of ${run.intakePreview.totalPassages.toLocaleString()}`
    : "";

  const pauseIntake = async () => {
    setPauseAction("pausing");
    setActionError(null);
    try {
      releaseBrowserLorekeeperEngine();
      await pauseWorldIntake(worldId);
      setDetail(await getWorld(worldId));
    } catch (reason) {
      setActionError(
        reason instanceof Error
          ? reason.message
          : premiumRun
            ? "Premium Deep Reading could not be paused."
            : "Canon Intake could not be paused.",
      );
    } finally {
      setPauseAction("");
    }
  };

  const resumeIntake = async () => {
    setPauseAction("resuming");
    setActionError(null);
    try {
      await resumeWorldIntake(worldId);
      setDetail(await getWorld(worldId));
    } catch (reason) {
      setActionError(
        reason instanceof Error
          ? reason.message
          : premiumRun
            ? "Premium Deep Reading could not be resumed."
            : "Canon Intake could not be resumed.",
      );
    } finally {
      setPauseAction("");
    }
  };

  return (
    <ProfileFrame>
      <AlertDialog open={browserPending && browserPreference === "unset"}>
        <AlertDialogContent className="border-primary/25 bg-[#111014] sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-2xl">Where Should Storyhold Read?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-3 text-sm leading-6">
              <span className="block">
                Storyhold privately checks the names, relationships, and concepts found during intake. When it finishes, your world opens and pauses before any optional Premium Deep Reading.
              </span>
              <span className="block">
                Using this browser may make the reading faster on a capable computer and keeps the private reader on this device. Otherwise, Storyhold will complete the same required reading for you. Keep this page and browser open until the world is ready.
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setBrowserLorekeeperPreference("disabled");
                setBrowserPreference("disabled");
              }}
            >
              Let Storyhold Handle It
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setBrowserLorekeeperPreference("enabled");
                setBrowserPreference("enabled");
              }}
            >
              Use This Browser
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="mx-auto flex min-h-[60vh] w-full max-w-3xl items-center px-0 py-5 sm:py-7">
        <div className="w-full">
          <Link
            href={`/profile/worlds/${worldId}`}
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="mr-2 h-4 w-4" /> {toChicagoTitleCase(`Back to ${detail.world.name}`)}
          </Link>

          <Card className="mt-4 rounded-3xl border-primary/15 bg-[#121115] px-5 py-6 sm:px-7 sm:py-7">
            <div className="flex items-center gap-3">
              {intakePaused || premiumNeedsRetry ? (
                <CircleDashed className="h-6 w-6 shrink-0 text-amber-300" />
              ) : premiumActive ? (
                <Loader2 className="h-6 w-6 shrink-0 animate-spin text-primary" />
              ) : openable ? (
                <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-400" />
              ) : blockingFailure && !runActive ? (
                <CircleDashed className="h-6 w-6 shrink-0 text-amber-300" />
              ) : (
                <Loader2 className="h-6 w-6 shrink-0 animate-spin text-primary" />
              )}
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                  {premiumContext ? "Premium Deep Reading" : "Canon Intake"}
                </p>
                <h1 className="mt-1 font-serif text-2xl font-bold sm:text-3xl">
                  {toChicagoTitleCase(premiumComplete
                    ? `${detail.world.name} is fully verified.`
                    : premiumPaused
                      ? `${detail.world.name}'s premium review is paused.`
                    : premiumActive
                      ? `${detail.world.name} is receiving a premium deep reading.`
                    : premiumNeedsRetry
                      ? `${detail.world.name} needs another premium pass.`
                    : intakePaused
                      ? `${detail.world.name} is paused.`
                    : openable
                      ? `${detail.world.name} is ready to open.`
                      : `Building ${detail.world.name}…`)}
                </h1>
              </div>
            </div>

            <Progress
              value={progress}
              aria-label={premiumContext ? "Premium Deep Reading progress" : "Canon Intake progress"}
              className="mt-5 h-3"
            />
            <div className="mt-3 flex items-start justify-between gap-5 text-sm leading-6 text-muted-foreground">
              <div>
                <p aria-live="polite">{toChicagoTitleCase(statusText)}</p>
                {savedStage ? (
                  <p className="mt-1 text-xs text-foreground/65">
                    {toChicagoTitleCase(savedStage)}
                    {savedPassageProgress ? ` · ${savedPassageProgress}` : ""}
                  </p>
                ) : null}
                {browserPending ? (
                  <p className="mt-1 text-xs text-amber-200/80">
                    Keep this page and browser open while Storyhold completes the deeper private reading. Completed work is saved as it goes.
                  </p>
                ) : premiumPaused ? (
                  <p className="mt-1 text-xs text-amber-200/80">
                    Premium Deep Reading is paused. Your locally built world remains saved and usable.
                  </p>
                ) : intakePaused ? (
                  <p className="mt-1 text-xs text-amber-200/80">
                    Completed work is saved. You can leave this page and resume the intake later.
                  </p>
                ) : null}
                {actionError ? (
                  <p className="mt-2 text-xs text-red-300" role="alert">{actionError}</p>
                ) : null}
                {premiumPaused && run?.error ? (
                  <p className="mt-2 max-w-2xl text-xs leading-5 text-red-300" role="alert">
                    Premium Deep Reading paused: {run.error}
                  </p>
                ) : intakePaused && run?.error ? (
                  <p className="mt-2 max-w-2xl text-xs leading-5 text-red-300" role="alert">
                    Source reading paused after saving its latest progress: {run.error}
                  </p>
                ) : null}
                {intakePaused && browserAudit?.error ? (
                  <p className="mt-2 max-w-2xl text-xs leading-5 text-red-300" role="alert">
                    Private story reading paused after saving its completed work: {browserAudit.error}
                  </p>
                ) : null}
                {blockingFailure && run?.error ? (
                  <p className="mt-2 max-w-2xl text-xs leading-5 text-red-300" role="alert">
                    Finalization stopped: {run.error}
                  </p>
                ) : null}
              </div>
              <span className="shrink-0 tabular-nums">{progress}%</span>
            </div>

            <div className="mt-5 flex justify-end">
              {intakePaused ? (
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    className="rounded-xl"
                    disabled={pauseAction === "resuming"}
                    onClick={() => void resumeIntake()}
                  >
                    {pauseAction === "resuming" ? (
                      <>Resuming <Loader2 className="ml-2 h-4 w-4 animate-spin" /></>
                    ) : (
                      <>
                        {premiumPaused ? "Resume Premium Deep Reading" : "Resume intake"}
                        <Play className="ml-2 h-4 w-4" />
                      </>
                    )}
                  </Button>
                  {openable ? (
                    <Button asChild variant="outline" className="rounded-xl">
                      <Link href={`/profile/worlds/${worldId}`}>
                        Enter World <ChevronRight className="ml-2 h-4 w-4" />
                      </Link>
                    </Button>
                  ) : null}
                </div>
              ) : runActive || browserPending ? (
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-xl"
                    disabled={pauseAction === "pausing" || pauseRequested}
                    onClick={() => void pauseIntake()}
                  >
                    {pauseAction === "pausing" || pauseRequested ? (
                      <>Pausing safely <Loader2 className="ml-2 h-4 w-4 animate-spin" /></>
                    ) : (
                      <>
                        {premiumActive ? "Pause Premium Deep Reading" : "Pause intake"}
                        <Pause className="ml-2 h-4 w-4" />
                      </>
                    )}
                  </Button>
                  {openable ? (
                    <Button asChild className="rounded-xl">
                      <Link href={`/profile/worlds/${worldId}`}>
                        Enter World <ChevronRight className="ml-2 h-4 w-4" />
                      </Link>
                    </Button>
                  ) : null}
                </div>
              ) : openable ? (
                <div className="flex flex-wrap justify-end gap-2">
                  {browserRetryable && browserAudit ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-xl"
                      onClick={() => {
                        setBrowserMessage("Retrying Private Story Intelligence from its saved progress…");
                        void retryBrowserLocalAudit({ worldId, auditId: browserAudit.id })
                          .then(() => getWorld(worldId))
                          .then(setDetail)
                          .catch((reason) => setActionError(browserFailureMessage(reason)));
                      }}
                    >
                      Retry Private Intelligence
                    </Button>
                  ) : null}
                  {pipeline.canStartPremiumReview ? (
                    <WorldPremiumReviewButton
                      worldId={worldId}
                      label={premiumComplete
                        ? "Run Premium Deep Reading again"
                        : premiumNeedsRetry
                          ? "Retry Premium Deep Reading"
                          : "Start Premium Deep Reading"}
                      onStarted={() => setDetail((current) => current ? { ...current } : current)}
                    />
                  ) : null}
                  <Button asChild className="rounded-xl">
                    <Link href={`/profile/worlds/${worldId}`}>
                      Enter World <ChevronRight className="ml-2 h-4 w-4" />
                    </Link>
                  </Button>
                </div>
              ) : pipeline.canRetryLocal && !runActive ? null : (
                <Button disabled className="rounded-xl">
                  Finishing your Storyhold <Loader2 className="ml-2 h-4 w-4 animate-spin" />
                </Button>
              )}
            </div>
          </Card>

          {!runActive && (openable || blockingFailure) ? (
            <WorldReadingHealthPanel
              detail={detail}
              onReviewStarted={() => setDetail((current) => current ? { ...current } : current)}
            />
          ) : null}
        </div>
      </div>
    </ProfileFrame>
  );
}
