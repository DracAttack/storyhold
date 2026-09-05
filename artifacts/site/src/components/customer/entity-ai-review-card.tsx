import { useEffect, useState } from "react";
import { AlertCircle, BookOpen, Brain, Loader2, Search, ShieldCheck, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
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
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  quoteWorldEntityAiReview,
  runWorldEntityAiReview,
  getStoryholdAiRuntime,
  getWorldCanonConstraints,
  dismissWorldCanonConstraint,
  type AiRuntimeStatus,
  type EntityAiReviewDepth,
  type EntityAiReviewQuote,
  type OwnerCanonConstraint,
} from "@/lib/storyholdApi";
import {
  inspectBrowserLorekeeper,
  persistBrowserModelCache,
  runBrowserDossierAssist,
  type BrowserLorekeeperCapability,
} from "@/lib/browserLorekeeper";
import { browserLorekeeperIsEnabled } from "@/lib/browserLorekeeperSettings";
import { entityReviewRetrievalNotice } from "@/lib/entityReviewRetrieval";

export function EntityAiReviewCard({
  worldId,
  entityId,
  name,
  entityType,
  onComplete,
}: {
  worldId: string;
  entityId: string;
  name: string;
  entityType: string;
  onComplete: () => Promise<unknown> | unknown;
}) {
  const [preparing, setPreparing] = useState<EntityAiReviewDepth | null>(null);
  const [quote, setQuote] = useState<EntityAiReviewQuote | null>(null);
  const [running, setRunning] = useState(false);
  const [guidance, setGuidance] = useState("");
  const [chosenDepth, setChosenDepth] = useState<EntityAiReviewDepth | null>(null);
  const [preparationError, setPreparationError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<AiRuntimeStatus | null>(null);
  const [browserCapability, setBrowserCapability] = useState<BrowserLorekeeperCapability | null>(null);
  const [constraints, setConstraints] = useState<OwnerCanonConstraint[]>([]);
  const [localReviewMessage, setLocalReviewMessage] = useState("");

  useEffect(() => {
    let active = true;
    void getStoryholdAiRuntime()
      .then((status) => { if (active) setRuntime(status); })
      .catch(() => { if (active) setRuntime(null); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    if (!browserLorekeeperIsEnabled()) {
      setBrowserCapability(null);
      return () => { active = false; };
    }
    void inspectBrowserLorekeeper()
      .then((capability) => { if (active) setBrowserCapability(capability); })
      .catch(() => { if (active) setBrowserCapability(null); });
    return () => { active = false; };
  }, []);

  const refreshConstraints = async () => {
    const result = await getWorldCanonConstraints({ worldId, entityId });
    setConstraints(result.constraints);
  };

  useEffect(() => {
    let active = true;
    void getWorldCanonConstraints({ worldId, entityId })
      .then((result) => { if (active) setConstraints(result.constraints); })
      .catch(() => { if (active) setConstraints([]); });
    return () => { active = false; };
  }, [worldId, entityId]);

  const prepare = async (depth: EntityAiReviewDepth) => {
    if (preparing || running) return;
    setChosenDepth(depth);
    setQuote(null);
    setPreparationError(null);
    setPreparing(depth);
    try {
      const prepared = await quoteWorldEntityAiReview({
        worldId,
        entityId,
        depth,
        guidance: guidance.trim(),
      });
      setQuote(prepared);
      if (prepared.resume) {
        setChosenDepth(prepared.depth);
        setGuidance(prepared.guidance ?? "");
      }
    } catch (reason) {
      setPreparationError(reason instanceof Error ? reason.message : "Storyhold could not prepare this source review.");
    } finally {
      setPreparing(null);
    }
  };

  const run = async () => {
    if (!quote || running) return;
    setRunning(true);
    try {
      const reviewGuidance = quote.resume ? quote.guidance ?? "" : guidance.trim();
      let browserAssist;
      try {
        if (!quote.resume && (browserLorekeeperIsEnabled() || quote.executionMode === "browser_qwen")) {
          const capability = browserCapability ?? await inspectBrowserLorekeeper();
          if (capability.supported) {
            await persistBrowserModelCache();
            browserAssist = await runBrowserDossierAssist({
              entityName: name,
              entityType,
              depth: quote.depth,
              guidance: reviewGuidance,
              passages: quote.selectedPassages,
              capability,
              produceReview: quote.executionMode === "browser_qwen",
              onProgress: (progress) => setLocalReviewMessage(progress.message),
            });
          } else if (quote.executionMode === "browser_qwen") {
            setLocalReviewMessage("Reading the selected story passages privately…");
          }
        }
      } catch (reason) {
        // A browser without WebGPU is not a failed review. The server uses the
        // same isolated private model as the intake stack when no premium
        // provider is connected.
        setLocalReviewMessage(
          quote.executionMode === "browser_qwen"
            ? "Reading the selected story passages privately…"
            : "Building an evidence-checked dossier…",
        );
      }
      const result = await runWorldEntityAiReview({
        worldId,
        entityId,
        depth: quote.depth,
        guidance: reviewGuidance,
        quoteId: quote.quoteId,
        approvedCredits: quote.requiredCredits,
        browserAssist,
      });
      await onComplete();
      await refreshConstraints();
      setQuote(null);
      setChosenDepth(null);
      toast.success(
        result.existingProseAudit
          ? result.unlimited ? `${name}'s dossier review is complete.`
            : `${name}'s dossier review is complete. ${result.creditsUsed.toLocaleString()} credits used.`
          : result.unlimited
          ? `${name}'s dossier was refreshed.`
          : `${name}'s dossier was refreshed for ${result.creditsUsed.toLocaleString()} credits.`,
        result.existingProseAudit ? { description: `${result.existingProseAudit.reviewedItems.toLocaleString()} existing entries reviewed. See Evidence by Section for supported details and anything that still needs checking.` } : undefined,
      );
      if (result.warnings?.length) toast.warning("Some Changes Need Your Review", {
        description: result.warnings.join(" "), duration: 15_000,
      });
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The dossier review did not finish. No canonical update was saved.");
    } finally {
      setLocalReviewMessage("");
      setRunning(false);
    }
  };

  const dismissConstraint = async (constraintId: string) => {
    try {
      await dismissWorldCanonConstraint({ worldId, constraintId });
      await refreshConstraints();
      toast.success("That permanent canon direction was removed.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The canon direction could not be removed.");
    }
  };

  const shortfall = quote && !quote.resume && !quote.unlimited
    ? Math.max(0, quote.requiredCredits - quote.availableCredits)
    : 0;
  const browserFallbackAvailable = browserLorekeeperIsEnabled() && browserCapability?.supported === true;
  // The server-side private Qwen reader is the non-WebGPU fallback. A missing
  // premium provider must not turn this into a dead button during local use.
  const reviewAvailable = true;
  const retrievalNotice = entityReviewRetrievalNotice(quote);

  return (
    <>
      <Card className="rounded-3xl border-primary/20 bg-primary/[0.035] p-5 sm:p-6">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-center">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2">
              <Brain className="h-5 w-5 text-primary" />
              <h2 className="font-serif text-2xl font-bold">Review This Dossier with AI</h2>
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Choose a pass to preview exactly which manuscript passages Storyhold will read. Nothing runs and no credits are used until you confirm the prepared review.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row lg:flex-col">
            <Button type="button" variant="outline" className="justify-start rounded-xl" disabled={Boolean(preparing) || running || !reviewAvailable} onClick={() => void prepare("focused")}>
              {preparing === "focused" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Check for missed updates
            </Button>
            <Button type="button" className="justify-start rounded-xl" disabled={Boolean(preparing) || running || !reviewAvailable} onClick={() => void prepare("full")}>
              {preparing === "full" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Build or refresh full dossier
            </Button>
          </div>
        </div>
        {runtime?.configured === false ? (
          <div className="mt-4 flex items-start gap-2 rounded-2xl border border-primary/20 bg-primary/[0.06] px-4 py-3 text-sm leading-6 text-foreground/85">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{browserFallbackAvailable
              ? "Premium Deep Reading is not connected yet. Storyhold can still build a private, evidence-checked review on this device; Premium Deep Reading will automatically take priority once connected."
              : "Premium Deep Reading is not connected yet. Storyhold can still use Private Story Intelligence on this computer for an evidence-checked dossier review."}</p>
          </div>
        ) : null}
        {constraints.length ? (
          <div className="mt-4 rounded-2xl border border-primary/20 bg-primary/[0.04] p-4">
            <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-primary" />Permanent canon directions</div>
            <div className="mt-2 space-y-2">
              {constraints.map((constraint) => (
                <div key={constraint.id} className="flex items-start justify-between gap-3 text-sm leading-6 text-foreground/85">
                  <p><span className="mr-2 text-xs font-semibold uppercase tracking-wide text-primary">{constraint.kind}</span>{constraint.instruction}</p>
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground" aria-label="Remove permanent canon direction" onClick={() => void dismissConstraint(constraint.id)}><X className="h-3.5 w-3.5" /></Button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <label className="mt-5 block text-xs font-semibold text-foreground/85">
          Tell Storyhold what to verify or correct <span className="font-normal text-muted-foreground">(optional)</span>
          <Textarea
            className="mt-2 min-h-24 resize-y bg-black/20 text-sm font-normal leading-6"
            value={guidance}
            onChange={(event) => setGuidance(event.target.value.slice(0, 2_000))}
            placeholder={`Examples: “Echo is not literally Alec's daughter; distinguish the metaphorical bond.” or “Recheck ${name}'s abilities after their transformation.”`}
            disabled={Boolean(preparing) || running}
          />
          <span className="mt-1.5 block font-normal leading-5 text-muted-foreground">
            Explicit corrections become permanent canon directions after you run the review. Storyhold still retrieves and cites the passages that explain them; an ordinary request to inspect a topic remains temporary.
          </span>
        </label>
        <div className="mt-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
          <p className="rounded-xl border border-white/8 bg-black/15 px-3 py-2"><strong className="text-foreground">Focused evidence check:</strong> reads up to 12 passages (16 with directions), uses medium reasoning, and looks for a correction or missed update.</p>
          <p className="rounded-xl border border-white/8 bg-black/15 px-3 py-2"><strong className="text-foreground">Full dossier rebuild:</strong> reads up to 28 passages (36 with directions), uses high reasoning, and refreshes every supported dossier field.</p>
        </div>
      </Card>

      <AlertDialog open={Boolean(chosenDepth)} onOpenChange={(open) => { if (!open && !running) { setQuote(null); setChosenDepth(null); setPreparationError(null); } }}>
        <AlertDialogContent className="border-primary/35 bg-[#111014] shadow-2xl shadow-black/75 sm:max-w-lg">
          <AlertDialogHeader className="items-center text-center sm:text-center">
            <div className="mb-1 grid h-12 w-12 place-items-center rounded-full border border-primary/25 bg-primary/10"><Sparkles className="h-5 w-5 text-primary" /></div>
            <AlertDialogTitle className="font-serif text-2xl">
              {quote?.resume ? "Resume Saved Review" : (quote?.depth ?? chosenDepth) === "full" ? "Build the full dossier?" : "Check this dossier for updates?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="max-w-md text-center leading-6">
              {preparing ? "Storyhold is finding the most relevant manuscript passages now." : quote?.resume ? (quote.remainingPages ? `Storyhold will continue the ${quote.remainingPages} remaining part${quote.remainingPages === 1 ? "" : "s"} of your saved review. Completed reading will not be repeated.` : "Storyhold will finish your saved review using its original directions and source selection. No new AI request will be sent.") : quote ? `Storyhold will review ${quote.passageCount} selected passages across ${quote.sourceCount} source${quote.sourceCount === 1 ? "" : "s"}${quote.executionMode === "connected" ? " with the connected premium reviewer" : " with private story intelligence on this device"}.` : "The source selection could not be prepared."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {preparing ? <div className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-black/25 p-5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Preparing the source selection…</div> : null}
          {preparationError ? <div className="flex items-start gap-2 rounded-2xl border border-red-400/20 bg-red-400/[0.06] p-4 text-sm leading-6 text-red-100"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><p>{preparationError}</p></div> : null}
          {quote ? <details className="rounded-2xl border border-white/10 bg-black/25 p-4 text-left" open>
            <summary className="cursor-pointer list-none text-sm font-semibold"><BookOpen className="mr-2 inline h-4 w-4 text-primary" />Selected manuscript passages ({quote.selectedPassages.length})</summary>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{quote.resume ? (quote.remainingPages ? "These are the original passages and directions saved for the remaining checks. No new source material will be added." : "These are the original passages saved with this review. They will not be sent for a new reading.") : <>These passages represent {name}'s direct appearances and broader narrative context across the manuscript. They are the only manuscript excerpts used for this dossier review.</>}</p>
            {retrievalNotice ? <p className="mt-2 text-xs leading-5 text-muted-foreground"><strong className="font-medium text-foreground">{retrievalNotice.heading}</strong>{" "}{retrievalNotice.detail}</p> : null}
            {quote.resume && quote.guidance ? <p className="mt-2 text-xs leading-5 text-muted-foreground"><strong className="text-foreground">Saved Review Directions:</strong> {quote.guidance}</p> : null}
            <div className="mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
              {quote.selectedPassages.map((passage) => <div key={passage.chunkId} className="rounded-xl border border-white/8 bg-black/20 px-3 py-2.5">
                <p className="text-xs font-semibold text-foreground">{passage.sourceTitle} · passage {passage.passageNumber}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{passage.excerpt}</p>
              <p className="mt-1.5 text-[11px] text-primary/80">
                {passage.nameMatches ? "Direct character passage" : "Narrative context passage"}
              </p>
              </div>)}
            </div>
          </details> : null}
          {quote ? <div className="rounded-2xl border border-white/10 bg-black/25 p-4 text-center">
            {quote.resume ? (
              <><p className="font-semibold text-primary">Saved Credit Hold</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{quote.unlimited ? "Your original owner-account exemption still applies." : "Storyhold keeps the existing hold while the saved review finishes. Unused held credits return after settlement; higher actual usage may use additional available credits."}</p></>
            ) : quote?.unlimited ? (
              <p className="font-semibold text-primary">Included with Your Unlimited Owner Account</p>
            ) : (
              <><p className="font-semibold text-primary">Credits Are Held While This Runs</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Unused held credits return after settlement. If actual usage is higher than the hold, Storyhold may use additional available credits.</p></>
            )}
            {shortfall ? <p className="mt-3 text-sm font-semibold text-red-300">Add credits before this review can run.</p> : null}
          </div> : null}
          {running && localReviewMessage ? (
            <p className="flex items-center justify-center gap-2 text-center text-xs leading-5 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              {localReviewMessage}
            </p>
          ) : null}
          <AlertDialogFooter className="mt-1 sm:justify-center">
            <AlertDialogCancel disabled={running}>Not now</AlertDialogCancel>
            <AlertDialogAction disabled={!quote || Boolean(preparing) || running || Boolean(shortfall)} onClick={(event) => { event.preventDefault(); void run(); }}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {running ? quote?.resume ? "Finishing Saved Review..." : "Reviewing sources..." : quote?.resume ? "Resume Saved Review" : "Confirm and run"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
