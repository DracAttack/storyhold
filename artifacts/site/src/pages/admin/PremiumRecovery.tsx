import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  PremiumRecoveryRecordedSteps,
  recoveryProviderDescription as providerDescription,
  recoveryStepStatusLabel as stepStatusLabel,
  recoveryStepTitle as stepTitle,
} from "@/components/customer/premium-recovery-recorded-steps";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/lib/auth";
import { toArticleTitleCase } from "@/lib/utils";
import {
  buildRecoveryInput, finalizePremiumRecoveryRun, formatRecoveryCost,
  formatRecoveryTimestamp, getPremiumRecoveryRun, isPremiumRecoveryOperator, listPremiumRecoveryRuns, recoverySettlementCost,
  type PremiumRecoveryDraft, type PremiumRecoveryReceipt, type PremiumRecoveryReview,
} from "@/lib/premiumRecoveryApi";

const emptyDraft: PremiumRecoveryDraft = { outcome: "", usd: "", providerReference: "" };
const stateLabel = (value: string) => toArticleTitleCase(value.replaceAll("_", " "));
const runStateLabel = (review: PremiumRecoveryReview) => review.receipt
  ? "Closed and Settled"
  : review.status === "running"
    ? "Still Running"
    : review.recoveryMode === "settled_accounting_adoption" && review.canFinalize
      ? "Settled Accounting Ready to Close"
    : review.canFinalize
      ? "Ready for Charge Review"
      : "Needs Manual Investigation";

function AuditReceipt({ receipt }: { receipt: PremiumRecoveryReceipt }) {
  return (
    <section className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4" aria-label="Audit Receipt">
      <h3 className="flex items-center gap-2 font-semibold"><CheckCircle2 className="h-4 w-4 text-primary" /> Audit Receipt</h3>
      <p className="text-sm text-muted-foreground">This saved run is permanently closed. Closing it sent no additional AI request and promoted no saved provider output into canon.</p>
      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-muted-foreground">Settled Usage</dt><dd className="mt-1 font-mono">{formatRecoveryCost(receipt.costMicros)}</dd></div>
        <div><dt className="text-muted-foreground">Credits Used</dt><dd className="mt-1">{receipt.creditsUsed.toLocaleString()}</dd></div>
        <div><dt className="text-muted-foreground">Credits Refunded</dt><dd className="mt-1">{receipt.creditsRefunded.toLocaleString()}</dd></div>
      </dl>
      <dl className="space-y-2 break-words text-xs text-muted-foreground">
        <div><dt className="inline font-medium">Receipt: </dt><dd className="inline font-mono">{receipt.id}</dd></div>
        <div><dt className="inline font-medium">Operator: </dt><dd className="inline font-mono">{receipt.actorId}</dd></div>
        <div><dt className="inline font-medium">Recorded: </dt><dd className="inline">{new Date(receipt.createdAt).toLocaleString()}</dd></div>
        <div><dt className="font-medium">Audit Note</dt><dd className="mt-1 whitespace-pre-wrap">{receipt.note}</dd></div>
      </dl>
      {receipt.decisions.length > 0 && <details className="text-xs">
        <summary className="cursor-pointer font-medium">Verified Decisions ({receipt.decisions.length})</summary>
        <ul className="mt-3 space-y-3">
          {receipt.decisions.map((decision, index) => <li key={decision.stepKey} className="space-y-1 break-words">
            <p className="font-medium">{stepTitle(decision.stepKey, index)}</p>
            <p>{stateLabel(decision.outcome)} · {formatRecoveryCost(decision.costMicros)}</p>
            <p className="text-muted-foreground">Reference: {decision.providerReference}</p>
            <details><summary className="cursor-pointer text-muted-foreground">Technical Reference</summary><p className="mt-1 break-all font-mono">{decision.stepKey}</p></details>
          </li>)}
        </ul>
      </details>}
    </section>
  );
}

function RunReview({ runId, onFinalized, onBusyChange }: {
  runId: string;
  onFinalized: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [review, setReview] = useState<PremiumRecoveryReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, PremiumRecoveryDraft>>({});
  const [note, setNote] = useState("");
  const [providerChecked, setProviderChecked] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const submitRef = useRef(false);

  const load = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    setProviderChecked(false);
    try {
      const result = await getPremiumRecoveryRun(runId, controller.signal);
      if (controller.signal.aborted || !mountedRef.current) return;
      setReview(result.review);
      setNeedsRefresh(false);
    } catch (reason) {
      if (controller.signal.aborted || !mountedRef.current) return;
      setNeedsRefresh(true);
      setError(reason instanceof Error ? reason.message : "This run could not be loaded.");
    } finally {
      if (!controller.signal.aborted && mountedRef.current) setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => { mountedRef.current = false; requestRef.current?.abort(); };
  }, [load]);

  const validation = review ? buildRecoveryInput(review, drafts, note, providerChecked) : null;
  const settledAdoption = review?.recoveryMode === "settled_accounting_adoption";
  const blocked = loading || submitting || needsRefresh || !review?.canFinalize || review.status === "running" || Boolean(review.receipt);
  const updateDraft = (stepKey: string, patch: Partial<PremiumRecoveryDraft>) => {
    setDrafts((current) => ({ ...current, [stepKey]: { ...(current[stepKey] ?? emptyDraft), ...patch } }));
  };
  const requestConfirmation = (event: FormEvent) => {
    event.preventDefault();
    if (!blocked && validation?.input) setConfirmOpen(true);
  };
  const finalize = async () => {
    if (submitRef.current || blocked || !validation?.input) return;
    submitRef.current = true;
    setSubmitting(true);
    onBusyChange(true);
    setError(null);
    try {
      const result = await finalizePremiumRecoveryRun(runId, validation.input);
      if (!mountedRef.current) return;
      // Keep the returned receipt visible even if the subsequent read fails.
      setReview({ ...result.review, canFinalize: false, receipt: result.receipt });
      setConfirmOpen(false);
      setProviderChecked(false);
      onFinalized();
      await load();
    } catch (reason) {
      if (!mountedRef.current) return;
      setConfirmOpen(false);
      setNeedsRefresh(true);
      setProviderChecked(false);
      setError(reason instanceof Error ? reason.message : "Recovery could not be completed. Refresh the run before trying again.");
      // Notes and decisions intentionally remain intact after all failures.
    } finally {
      submitRef.current = false;
      if (mountedRef.current) { setSubmitting(false); onBusyChange(false); }
    }
  };

  return <Card className="min-w-0 space-y-5 p-4 sm:p-5" aria-busy={loading || submitting}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="break-words font-serif text-xl font-semibold">{review?.worldName || "Saved Run"}</h2>
        <p className="mt-1 break-all text-xs text-muted-foreground">Run Reference: <span className="font-mono">{runId}</span></p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={() => void load()} disabled={loading || submitting}>
        <RefreshCw className={`mr-2 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh Run
      </Button>
    </div>
    {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">{error} Your current notes and decisions have been kept.</p>}
    {!review && loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading saved run…</p>}
    {review && <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="secondary">{runStateLabel(review)}</Badge>
        <span>Pipeline Position at Interruption: {Math.round(Math.max(0, Math.min(100, review.progress)))}%</span>
      </div>
      <dl className="grid grid-cols-1 gap-3 rounded-lg bg-muted/50 p-3 text-sm sm:grid-cols-3">
        <div><dt className="text-muted-foreground">Review Started</dt><dd className="mt-1 font-medium">{formatRecoveryTimestamp(review.createdAt)}</dd></div>
        <div><dt className="text-muted-foreground">Original Reserved Credits</dt><dd className="mt-1 font-medium">{review.reservedCredits.toLocaleString()}</dd></div>
        <div><dt className="text-muted-foreground">{settledAdoption ? "Already-Settled Provider Cost" : "Recorded Provider Cost"}</dt><dd className="mt-1 font-mono">{formatRecoveryCost(review.knownCostMicros)}</dd></div>
      </dl>
      {review.receipt ? <AuditReceipt receipt={review.receipt} /> : <>
        {(!review.canFinalize || review.status === "running") && <p role="status" className="rounded-md border p-3 text-sm text-muted-foreground">{review.blockReason || "This run cannot be finalized in its current state. Running work must stop before recovery is available."}</p>}
        {settledAdoption && review.canFinalize && <p role="status" className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm leading-6">Storyhold verified that this run’s original credit hold was already settled and its provider usage was already recorded. Closing it will only mark the stranded run complete for accounting purposes and save an audit receipt. It will not call an AI provider, charge credits, refund credits, or promote output into canon.</p>}
        {needsRefresh && <p className="text-sm text-muted-foreground">Refresh this run before continuing. Review the latest state and confirm the provider records again.</p>}
        <form onSubmit={requestConfirmation} className="space-y-5">
          <fieldset disabled={blocked} className="min-w-0 space-y-4 disabled:opacity-70">
            <legend className="mb-2 font-semibold">{settledAdoption ? "Verify Existing Settlement" : "Verify Provider Charges"}</legend>
            <p className="text-xs leading-5 text-muted-foreground">{settledAdoption
              ? "Review the authenticated hold, provider-usage record, and credit-ledger settlement below. No new charge or refund will be calculated or applied."
              : "Compare every item marked for verification with the provider’s billing or request records. Enter its total provider cost, including attempts Storyhold already recorded—not an additional charge. A missing result does not prove that the provider charged nothing."}</p>
            {review.steps.length === 0 && <p className="text-sm text-muted-foreground">Storyhold recorded no provider requests for this run. Confirm that against the provider records before closing it.</p>}
            <PremiumRecoveryRecordedSteps review={review} />
            {review.steps.filter((step) => step.needsDecision).map((step, index) => {
              const draft = drafts[step.stepKey] ?? emptyDraft;
              const fieldId = `recovery-step-${index}`;
              const legacyAggregate = step.stepKey === "legacy:review-total";
              return <section key={step.stepKey} className="min-w-0 space-y-3 rounded-lg border p-3" aria-label={`Provider Step ${index + 1}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">{stepTitle(step.stepKey, index)}</h3>
                  <Badge variant={step.needsDecision ? "outline" : "secondary"}>{stepStatusLabel(step.status, step.needsDecision)}</Badge>
                </div>
                <p className="break-words text-xs text-muted-foreground">{providerDescription(step)}</p>
                {legacyAggregate && <p className="text-xs leading-5 text-muted-foreground">This older review has no reliable per-request journal. Verify the provider’s total cost across the entire review as one amount. Nothing from the saved review will be applied to canon.</p>}
                <p className="text-xs text-muted-foreground">Minimum Already Recorded: <span className="font-mono">{formatRecoveryCost(step.knownCostMicros)}</span></p>
                <p className="text-xs text-muted-foreground">Sent: {formatRecoveryTimestamp(step.dispatchedAt)} · Last Saved: {formatRecoveryTimestamp(step.lastRecordedAt)}</p>
                <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Technical Reference</summary><p className="mt-1 break-all font-mono">{step.stepKey}</p></details>
                {step.needsDecision && <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`${fieldId}-outcome`}>Verified Outcome</Label>
                    <select id={`${fieldId}-outcome`} required value={draft.outcome} onChange={(event) => updateDraft(step.stepKey, { outcome: event.target.value as PremiumRecoveryDraft["outcome"] })} className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed">
                      <option value="" disabled>Choose an Outcome</option>
                      <option value="charged">Charged</option>
                      <option value="no_charge" disabled={(step.knownCostMicros ?? 0) > 0}>No Charge</option>
                    </select>
                  </div>
                  {draft.outcome === "charged" && <div className="space-y-1.5">
                    <Label htmlFor={`${fieldId}-cost`}>{legacyAggregate ? "Verified Entire Review Total (USD)" : "Verified Request Total (USD)"}</Label>
                    <Input id={`${fieldId}-cost`} type="text" inputMode="decimal" required maxLength={30} placeholder="0.000000" value={draft.usd} onChange={(event) => updateDraft(step.stepKey, { usd: event.target.value })} aria-describedby={`${fieldId}-minimum`} />
                    <p id={`${fieldId}-minimum`} className="text-xs text-muted-foreground">Minimum recorded: {formatRecoveryCost(step.knownCostMicros ?? 0)}. Up to six decimal places.</p>
                  </div>}
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor={`${fieldId}-reference`}>Provider Evidence Reference</Label>
                    <Input id={`${fieldId}-reference`} required minLength={4} maxLength={300} autoComplete="off" value={draft.providerReference} onChange={(event) => updateDraft(step.stepKey, { providerReference: event.target.value })} placeholder="Request ID, invoice ID, or billing check reference" aria-describedby={`${fieldId}-reference-help`} />
                    <p id={`${fieldId}-reference-help`} className="text-xs text-muted-foreground">Use only the provider’s request or invoice reference. Never paste an API key, authorization header, raw error, or manuscript text.</p>
                  </div>
                </div>}
              </section>;
            })}
            <div className="space-y-1.5">
              <Label htmlFor="recovery-note">{settledAdoption ? "Closure Audit Note" : "Audit Note"}</Label>
              <Textarea id="recovery-note" required minLength={12} maxLength={2000} rows={3} autoComplete="off" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Describe the provider records checked and why this run should be closed." aria-describedby="recovery-note-help" />
              <p id="recovery-note-help" className="text-xs text-muted-foreground">12–2,000 characters. Do not include API keys, authorization headers, raw provider errors, credentials, or manuscript text.</p>
            </div>
            <label className="flex cursor-pointer items-start gap-3 text-sm leading-5">
              <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-primary" checked={providerChecked} onChange={(event) => setProviderChecked(event.target.checked)} required />
              <span>{settledAdoption
                ? "I reviewed the saved settlement and confirm that this action should only close the stranded run without changing credits."
                : "I checked the provider records and verified these usage outcomes and totals."}</span>
            </label>
          </fieldset>
          {!blocked && validation?.error && <p id="recovery-validation" className="text-xs text-muted-foreground" aria-live="polite">{validation.error}</p>}
          <Button type="submit" disabled={blocked || !validation?.input} aria-describedby={!blocked && validation?.error ? "recovery-validation" : undefined}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} {settledAdoption ? "Review Settled Run Closure" : "Review Run Closure"}
          </Button>
        </form>
      </>}
    </>}
    <AlertDialog open={confirmOpen} onOpenChange={(open) => { if (!submitRef.current) setConfirmOpen(open); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{settledAdoption ? "Close This Already-Settled Run?" : "Permanently Close This Saved Run?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {settledAdoption
              ? "This will permanently close the stranded Premium Review run and save an audit receipt. Its original charge and refund are already settled and will not change. The run cannot be resumed afterward. Closing it sends no additional AI request and does not promote saved provider output into canon."
              : "This will permanently close and cancel this saved Premium Review run, settle only the provider usage verified above against its original hold and any additional available account credits, and return any unused held credits. The run cannot be resumed afterward. Closing it sends no additional AI request and does not promote saved provider output into canon."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="break-words text-sm"><span className="font-medium">{review?.worldName}</span><br /><span className="break-all font-mono text-xs text-muted-foreground">{runId}</span></p>
        {review && validation?.input && <p className="rounded-md bg-muted p-3 text-sm">{settledAdoption ? "Already-Settled Provider Total" : "Verified Provider Total"}: <span className="font-mono font-medium">{formatRecoveryCost(recoverySettlementCost(review, validation.input.decisions))}</span></p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Keep Reviewing</AlertDialogCancel>
          <Button type="button" disabled={submitting || blocked || !validation?.input} onClick={() => void finalize()}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} {settledAdoption ? "Close Without Billing Changes" : "Close and Settle Run"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Card>;
}

export default function PremiumRecovery() {
  const { role } = useAuth();
  const allowed = isPremiumRecoveryOperator(role);
  const [runs, setRuns] = useState<PremiumRecoveryReview[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (!allowed) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const result = await listPremiumRecoveryRuns(controller.signal);
      if (controller.signal.aborted) return;
      setRuns(result.runs);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Saved runs could not be loaded.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [allowed]);
  useEffect(() => { void load(); return () => requestRef.current?.abort(); }, [load]);

  if (!allowed) return <p role="alert" className="p-6">Premium Recovery is available only to owners and administrators.</p>;
  return <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-8" data-testid="premium-recovery">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-primary"><ShieldCheck className="h-4 w-4" /> Private Operator Tools</p>
        <h1 className="font-serif text-3xl font-bold">Premium Recovery</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Use this when a Premium Review stopped after provider work and its accounting record needs to be safely closed. Storyhold will either request verification for unresolved charges or present an already-settled record it can close without moving credits. This does not resume analysis or apply saved AI output.</p>
      </div>
      <Button variant="outline" onClick={() => void load()} disabled={loading || busy}><RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh List</Button>
    </header>
    {error && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm">{error}</p>}
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
      <Card className="min-w-0 overflow-hidden">
        <div className="border-b p-4"><h2 className="font-semibold">Saved Runs</h2><p className="mt-1 text-xs text-muted-foreground">Up to 100 recent runs. Selecting a run does not change it.</p></div>
        {loading && runs.length === 0 ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading saved runs…</p> : runs.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{error ? "Saved runs could not be loaded. Refresh to check their status." : "No saved Premium Review runs need recovery."}</p> : <ul className="max-h-[28rem] divide-y overflow-y-auto">
          {runs.map((run) => <li key={run.runId}>
            <button type="button" disabled={busy} aria-pressed={selectedId === run.runId} onClick={() => setSelectedId(run.runId)} className={`w-full space-y-2 p-4 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:cursor-wait ${selectedId === run.runId ? "bg-primary/10" : ""}`}>
              <span className="block break-words text-sm font-medium">{run.worldName || "Untitled World"}</span>
              <span className="flex flex-wrap items-center gap-2"><Badge variant="secondary">{runStateLabel(run)}</Badge></span>
              <span className="block truncate text-[11px] text-muted-foreground">Run Reference: <span className="font-mono">{run.runId}</span></span>
            </button>
          </li>)}
        </ul>}
      </Card>
      {selectedId ? <RunReview key={selectedId} runId={selectedId} onFinalized={() => void load()} onBusyChange={setBusy} /> : <Card className="p-6 text-sm leading-6 text-muted-foreground">Select a saved run to compare its requests with the provider records and inspect its original credit reservation. Only verified usage can be settled; an unknown provider outcome requires an explicit operator decision.</Card>}
    </div>
  </div>;
}
