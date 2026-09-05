import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Check, Download, Loader2, RefreshCw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  adventureSetupEntryExport,
  adventureSetupResponseTemplate,
  completeAdventureSetupEntry,
  getAdventureSetupEntry,
  listAdventureSetupEntries,
  parseAdventureSetupResponse,
  type AdventureSetupEntry,
  type AdventureSetupQueueRow,
} from "@/lib/adventureSetupApi";

const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const canAnswer = (entry: AdventureSetupQueueRow) => entry.status === "awaiting_response" || entry.status === "failed";
const statusLabel = (status: AdventureSetupQueueRow["status"]) => ({
  not_required: "Not Required", required: "Not Started", awaiting_response: "Awaiting Review",
  generating: "Preparing", ready: "Complete", failed: "Needs Attention",
})[status];

/** Mounted only in the existing owner/admin-only Manual Storyteller page. */
export function AdventureSetupQueue() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [rows, setRows] = useState<AdventureSetupQueueRow[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [entry, setEntry] = useState<AdventureSetupEntry | null>(null);
  const [responseText, setResponseText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void listAdventureSetupEntries(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setEnabled(result.enabled);
      setRows(result.entries);
      setSelectedId((current) => result.entries.some((row) => row.id === current)
        ? current : result.entries.find(canAnswer)?.id ?? result.entries[0]?.id ?? "");
    }).catch(() => {
      if (!controller.signal.aborted) setError("The private adventure setup queue could not be opened.");
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
    setLoading(true);
    void getAdventureSetupEntry(selectedId, controller.signal).then(({ entry: next }) => {
      if (controller.signal.aborted) return;
      setEntry(next);
      setResponseText(canAnswer(next) ? pretty(adventureSetupResponseTemplate(next)) : "");
    }).catch(() => {
      if (!controller.signal.aborted) setError("This adventure setup could not be opened.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selectedId, refresh]);

  const updateEntry = (next: AdventureSetupEntry) => {
    setEntry(next);
    setRows((current) => current.map((row) => row.id === next.id ? { ...row, ...next } : row));
  };

  const submit = async () => {
    if (!entry || busy) return;
    setError("");
    setNotice("");
    let input;
    try { input = parseAdventureSetupResponse(entry, responseText); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Check the response format."); return; }
    setBusy(true);
    try {
      const result = await completeAdventureSetupEntry(entry.id, input);
      updateEntry(result.entry);
      setResponseText("");
      setNotice("Adventure setup is saved. The campaign will show its opening and become playable. No premium API calls or credits were used.");
    } catch (reason) {
      // Preserve the submitted answer, including when the server saved it but the response was lost.
      try { updateEntry((await getAdventureSetupEntry(entry.id)).entry); } catch { /* Keep the last saved entry. */ }
      setError(reason instanceof Error ? reason.message : "The setup response could not be saved.");
    } finally { setBusy(false); }
  };

  const exportEntry = () => {
    if (!entry) return;
    const url = URL.createObjectURL(new Blob([pretty(adventureSetupEntryExport(entry))], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `storyhold-adventure-setup-${entry.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section aria-label="Private Adventure Setups" className="mt-7 rounded-2xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Owner and Administrators Only</p>
          <h2 className="mt-1 font-serif text-2xl font-bold">Adventure Setups</h2>
          <p className="mt-2 text-sm text-muted-foreground">Review a new adventure before its first choice. Private plans and exact inputs stay in this queue.</p>
        </div>
        <Button variant="outline" disabled={busy || loading} onClick={() => setRefresh((value) => value + 1)}><RefreshCw className="mr-2 h-4 w-4" /> Refresh Setups</Button>
      </div>
      {error ? <p role="alert" className="mt-4 rounded-xl border border-red-400/25 p-3 text-sm">{error}</p> : null}
      {notice ? <p role="status" className="mt-4 rounded-xl border border-emerald-400/25 p-3 text-sm">{notice}</p> : null}
      {enabled === null && !error ? <Loader2 className="mt-4 h-5 w-5 animate-spin" /> : null}
      {enabled === false ? <p className="mt-4 text-sm text-muted-foreground">Manual adventure setup is disabled.</p> : null}
      {enabled && !rows.length ? <p className="mt-4 text-sm text-muted-foreground">No adventure setups yet. Prepare an adventure from its campaign page to create an entry.</p> : null}
      {enabled && rows.length ? <>
        <label htmlFor="adventure-setup-entry" className="mt-5 block text-sm font-medium">Saved Adventure</label>
        <select id="adventure-setup-entry" value={selectedId} disabled={busy} onChange={(event) => setSelectedId(event.target.value)} className="mt-2 w-full rounded-xl border bg-background p-3 text-sm">
          {rows.map((row) => <option key={row.id} value={row.id}>{row.campaignName || "Campaign"} · {statusLabel(row.status)} · {new Date(row.createdAt).toLocaleString()}</option>)}
        </select>
        {loading ? <Loader2 className="mt-4 h-5 w-5 animate-spin" /> : entry ? <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="outline" onClick={exportEntry}><Download className="mr-2 h-4 w-4" /> Export Exact Setup Input</Button>
            <Link href={`/profile/campaigns/${entry.campaignId}/play`} className="text-sm text-primary underline underline-offset-4">Open Campaign</Link>
          </div>
          <details className="rounded-xl border p-3"><summary className="cursor-pointer text-sm font-medium">Inspect Private Saved Setup</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{pretty(adventureSetupEntryExport(entry))}</pre></details>
          {entry.error ? <p className="whitespace-pre-wrap rounded-xl border border-amber-400/25 p-3 text-sm">{entry.error}</p> : null}
          {canAnswer(entry) ? <div className="border-t pt-4">
            <p className="text-sm text-muted-foreground">Export the exact input for Codex, then paste or import its response. Keep the entry ID and input fingerprint from the template; put corrections in notes.</p>
            <label htmlFor="adventure-setup-response" className="mt-4 block text-sm font-medium">Setup Response JSON</label>
            <Textarea id="adventure-setup-response" value={responseText} onChange={(event) => setResponseText(event.target.value)} disabled={busy} className="mt-2 min-h-56 font-mono text-xs" spellCheck={false} />
            <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              if (file.size > 5_000_000) { setError("Choose a response file smaller than 5 MB."); return; }
              try { setResponseText(await file.text()); setError(""); } catch { setError("That response file could not be read."); }
            }} />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button disabled={busy || !responseText.trim()} onClick={submit}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />} Validate and Prepare Adventure</Button>
              <Button variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}><Upload className="mr-2 h-4 w-4" /> Import Setup Response</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setResponseText(pretty(adventureSetupResponseTemplate(entry)))}>Reset Response Template</Button>
            </div>
          </div> : null}
        </div> : null}
      </> : null}
    </section>
  );
}
