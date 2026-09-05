import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Check, Download, Loader2, RefreshCw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { AdventureSetupQueue } from "@/components/admin/adventure-setup-queue";
import {
  completeManualStorytellerEntry,
  getManualStorytellerEntry,
  listManualStorytellerEntries,
  manualEntryExport,
  manualResponseTemplate,
  manualTurnIsPending,
  manualTurnStatusLabel,
  ManualStorytellerError,
  parseManualResponse,
  submitManualDirection,
  type ManualQueueRow,
  type ManualStorytellerEntry,
} from "@/lib/manualStorytellerApi";

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

export default function ManualStoryteller() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [rows, setRows] = useState<ManualQueueRow[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [entry, setEntry] = useState<ManualStorytellerEntry | null>(null);
  const [responseText, setResponseText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingEntry, setLoadingEntry] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void listManualStorytellerEntries(controller.signal).then((result) => {
      setEnabled(result.enabled);
      setRows(result.entries);
      setSelectedId((current) => result.entries.some((row) => row.id === current)
        ? current
        : result.entries.find(manualTurnIsPending)?.id ?? result.entries[0]?.id ?? "");
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "The test queue could not be opened.");
    });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    setEntry(null);
    setResponseText("");
    setError("");
    setNotice("");
    if (!selectedId) return;
    const controller = new AbortController();
    setLoadingEntry(true);
    void getManualStorytellerEntry(selectedId, controller.signal).then(({ entry: next }) => {
      if (controller.signal.aborted) return;
      setEntry(next);
      setResponseText(manualTurnIsPending(next) ? pretty(manualResponseTemplate(next)) : "");
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "This entry could not be opened.");
    }).finally(() => { if (!controller.signal.aborted) setLoadingEntry(false); });
    return () => controller.abort();
  }, [selectedId, refresh]);

  const submit = async () => {
    if (!entry || busy) return;
    setError("");
    setNotice("");
    let input;
    try { input = parseManualResponse(entry, responseText); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Check the response format."); return; }
    setBusy(true);
    try {
      const result = input.direction
        ? await submitManualDirection(entry.id, { direction: input.direction, inputSha256: input.inputSha256, notes: input.notes })
        : await completeManualStorytellerEntry(entry.id, { narration: input.narration!, inputSha256: input.inputSha256, notes: input.notes });
      setEntry(result.entry);
      setRows((current) => current.map((row) => row.id === result.entry.id ? { ...row, ...result.entry } : row));
      setResponseText(manualTurnIsPending(result.entry) ? pretty(manualResponseTemplate(result.entry)) : "");
      setNotice(result.entry.status === "completed"
        ? "The accepted turn is saved. Refresh the campaign to see the response. No premium API calls or credits were used."
        : "The Director decision passed validation. Export this entry again for the exact narration request and new response template.");
    } catch (reason) {
      if (reason instanceof ManualStorytellerError && reason.entry) {
        const updatedEntry = reason.entry;
        setEntry(updatedEntry);
        setRows((current) => current.map((row) => row.id === updatedEntry.id ? { ...row, ...updatedEntry } : row));
      }
      setError(reason instanceof Error ? reason.message : "The answer could not be saved.");
      // Keep the answer after a rejected or uncertain response, so it is inspectable and retryable.
    } finally { setBusy(false); }
  };

  const exportEntry = () => {
    if (!entry) return;
    const url = URL.createObjectURL(new Blob([pretty(manualEntryExport(entry))], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `storyhold-test-${entry.id}-${entry.status}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="mx-auto max-w-6xl p-5 md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Private Development Tools</p>
          <h1 className="mt-1 font-serif text-3xl font-bold">Manual Storyteller</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Play saves the real story input here. Review the Director decision, then the narration, through the same campaign checks. These tests make no premium API calls and use no credits.</p>
        </div>
        <Button variant="outline" disabled={busy || loadingEntry} onClick={() => setRefresh((value) => value + 1)}>
          <RefreshCw className="mr-2 h-4 w-4" /> Refresh Queue
        </Button>
      </div>
      {error ? <p role="alert" className="mt-5 rounded-xl border border-red-400/25 bg-red-400/5 p-3 text-sm text-red-600 dark:text-red-200">{error}</p> : null}
      {notice ? <p role="status" className="mt-5 rounded-xl border border-emerald-400/25 bg-emerald-400/5 p-3 text-sm">{notice}</p> : null}
      {enabled === null && !error ? <Loader2 className="mt-8 h-5 w-5 animate-spin" /> : null}
      {enabled === false ? <p className="mt-8 rounded-xl border p-5 text-sm text-muted-foreground">Manual Storyteller is disabled. This private queue is available only when local test mode is enabled on the development server.</p> : null}
      {enabled ? <AdventureSetupQueue /> : null}
      {enabled && !rows.length ? <p className="mt-8 rounded-xl border p-5 text-sm text-muted-foreground">No test turns yet. Complete any adventure setup above, then send a choice from the campaign.</p> : null}
      {enabled && rows.length ? (
        <div className="mt-7 grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
          <nav aria-label="Saved Test Turns" className="space-y-2">
            {rows.map((row) => (
              <button key={row.id} type="button" disabled={busy} onClick={() => setSelectedId(row.id)} aria-current={row.id === selectedId ? "true" : undefined}
                className={`w-full rounded-xl border p-3 text-left disabled:opacity-60 ${row.id === selectedId ? "border-primary/50 bg-primary/10" : "bg-card hover:bg-muted"}`}>
                <p className="truncate text-sm font-semibold">{row.campaignName || "Campaign"}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">{row.worldName}</p>
                <p className="mt-2 line-clamp-2 text-sm">{row.playerInput}</p>
                <p className="mt-2 text-xs text-primary">{manualTurnStatusLabel(row.status)}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">{new Date(row.createdAt).toLocaleString()}</p>
              </button>
            ))}
          </nav>
          <section className="min-w-0 rounded-2xl border bg-card p-5">
            {loadingEntry ? <Loader2 className="h-5 w-5 animate-spin" /> : entry ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Badge variant="outline">{manualTurnStatusLabel(entry.status)}</Badge>
                  <Link href={`/profile/campaigns/${entry.campaignId}/play`} className="text-sm text-primary underline underline-offset-4">Open Campaign</Link>
                </div>
                <p className="mt-4 whitespace-pre-wrap text-sm leading-6">{entry.playerInput}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="outline" onClick={exportEntry}><Download className="mr-2 h-4 w-4" /> Export Exact Input</Button>
                  {manualTurnIsPending(entry) ? <Button variant="ghost" disabled={busy} onClick={() => setResponseText(pretty(manualResponseTemplate(entry)))}>Reset Response Template</Button> : null}
                </div>
                <details className="mt-4 rounded-xl border p-3">
                  <summary className="cursor-pointer text-sm font-medium">Inspect Saved Input</summary>
                  <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{pretty(manualEntryExport(entry))}</pre>
                </details>
                {entry.error ? <p className="mt-4 whitespace-pre-wrap rounded-xl border border-amber-400/25 p-3 text-sm">{entry.error}</p> : null}
                {manualTurnIsPending(entry) ? (
                  <div className="mt-5 border-t pt-5">
                    <h2 className="font-semibold">{entry.status === "awaiting_direction" ? "1. Review Director Decision" : "2. Review Story Response"}</h2>
                    <p className="mt-2 text-sm text-muted-foreground">Export the saved input for Codex. Paste or import its response JSON here, keeping the entry ID and input fingerprint from the template. Record mistakes and corrections in the optional notes field.</p>
                    <label htmlFor="manual-response" className="mt-4 block text-sm font-medium">Response JSON</label>
                    <Textarea id="manual-response" value={responseText} onChange={(event) => setResponseText(event.target.value)} disabled={busy} className="mt-2 min-h-64 font-mono text-xs" spellCheck={false} />
                    <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={async (event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (!file) return;
                      if (file.size > 5_000_000) { setError("Choose a response file smaller than 5 MB."); return; }
                      try { setResponseText(await file.text()); setError(""); } catch { setError("That response file could not be read."); }
                    }} />
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button disabled={busy || !responseText.trim()} onClick={submit}>
                        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
                        {entry.status === "awaiting_direction" ? "Validate Decision" : "Validate and Publish Turn"}
                      </Button>
                      <Button variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}><Upload className="mr-2 h-4 w-4" /> Import Response File</Button>
                    </div>
                  </div>
                ) : null}
                {entry.attempts.length ? <details className="mt-5 border-t pt-4" open={Boolean(entry.error)}>
                  <summary className="cursor-pointer text-sm font-semibold">Review History ({entry.attempts.length})</summary>
                  <ol className="mt-3 space-y-3">{entry.attempts.map((attempt, index) => <li key={index} className="rounded-xl border p-3 text-sm">
                    <p className="font-medium">{attempt.stage} · {attempt.accepted ? "Accepted" : "Rejected"}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{new Date(attempt.createdAt).toLocaleString()}</p>
                    {attempt.error ? <p className="mt-2 whitespace-pre-wrap text-amber-600 dark:text-amber-200">{attempt.error}</p> : null}
                    {attempt.notes ? <p className="mt-2 whitespace-pre-wrap">{attempt.notes}</p> : null}
                    {attempt.response !== undefined ? <details className="mt-2"><summary className="cursor-pointer text-xs">Inspect Submitted Answer</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{pretty(attempt.response)}</pre></details> : null}
                  </li>)}</ol>
                </details> : null}
              </>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}
