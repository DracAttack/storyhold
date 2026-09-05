import {
  useListArticles,
  getListArticlesQueryKey,
  useGetSourceLinkJobStatus,
  getGetSourceLinkJobStatusQueryKey,
  useBackfillAllSourceLinks,
  useCancelSourceLinkJob,
  useRunCitationNotesBackfill,
  useCancelCitationNotesBackfill,
  useResetDeclinedNoteAttempts,
  useGetCitationNotesStatus,
  getGetCitationNotesStatusQueryKey,
  useGetCitationBackfillStatus,
  getGetCitationBackfillStatusQueryKey,
  useCancelCitationBackfill,
  useForceReleaseCitationBackfill,
  useRunDiversitySweep,
  useGetDiversitySweepStatus,
  getGetDiversitySweepStatusQueryKey,
  useResetAndRetryCitations,
  type ArticleBlock,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Loader2, Link2, Plus, OctagonX, ExternalLink, ChevronDown, ChevronRight, ArrowRight, NotebookPen, Sparkles, RefreshCw } from "lucide-react";
import { toast } from "sonner";

type Filter = "all" | "has" | "missing";

// Mirrors countExternalLinks in the API server: Markdown links pointing at an
// external http(s) URL (source citations) inside paragraph blocks only.
const EXTERNAL_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

// Per-article source-link cap. Mirrors SOURCE_LINK_TARGET in the API server
// (artifacts/api-server/src/services/articles.ts) — keep in sync.
const SOURCE_LINK_TARGET = 6;

// Characters of surrounding text to show on each side of the anchor.
const CONTEXT_WINDOW = 90;

type ExtractedLink = {
  /** The clickable anchor text as it appears in the body. */
  anchor: string;
  /** Target external URL. */
  url: string;
  /** Host shown as a compact label for the source. */
  host: string;
  /** Text immediately before the anchor (link syntax stripped, left-truncated). */
  before: string;
  /** Text immediately after the anchor (link syntax stripped, right-truncated). */
  after: string;
};

// Replace [text](url) markdown (internal or external) with just the visible text.
function stripLinkSyntax(s: string): string {
  return s.replace(/\[([^\]]+)\]\((?:https?:\/\/|\/article\/)[^\s)]+\)/g, "$1");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function extractLinks(body?: ArticleBlock[] | null): ExtractedLink[] {
  if (!body) return [];
  const out: ExtractedLink[] = [];
  for (const b of body) {
    if (b.type !== "paragraph" || typeof b.content !== "string") continue;
    const re = new RegExp(EXTERNAL_LINK_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(b.content)) !== null) {
      const anchor = m[1];
      const url = m[2];
      // Derive context from THIS match's position (m.index), not a textual
      // search — that avoids highlighting the wrong occurrence when the same
      // phrase appears more than once in the paragraph.
      let before = stripLinkSyntax(b.content.slice(0, m.index)).trimStart();
      let after = stripLinkSyntax(b.content.slice(m.index + m[0].length)).trimEnd();
      if (before.length > CONTEXT_WINDOW) {
        before = "… " + before.slice(before.length - CONTEXT_WINDOW).trimStart();
      }
      if (after.length > CONTEXT_WINDOW) {
        after = after.slice(0, CONTEXT_WINDOW).trimEnd() + " …";
      }
      out.push({ anchor, url, host: hostOf(url), before, after });
    }
  }
  return out;
}

export default function SourceLinks() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");

  const articlesQuery = useListArticles({ status: "published" });
  const articles = articlesQuery.data?.items ?? [];

  // Poll the job status only while a backfill is actually running. When a run
  // finishes, refetch the gallery so the new link counts appear.
  const statusQuery = useGetSourceLinkJobStatus({
    query: {
      queryKey: getGetSourceLinkJobStatusQueryKey(),
      refetchInterval: (query) => (query.state.data?.running ? 1500 : false),
    },
  });
  const status = statusQuery.data;
  const running = status?.running ?? false;

  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      qc.invalidateQueries({ queryKey: getListArticlesQueryKey({ status: "published" }) });
    }
    wasRunning.current = running;
  }, [running, qc]);

  const refetchStatus = () => statusQuery.refetch();

  const backfill = useBackfillAllSourceLinks({
    mutation: {
      onSuccess: (res) => {
        if (res.alreadyRunning) toast.info("A source-link backfill is already running.");
        else toast.success("Adding source links — progress below.");
        refetchStatus();
      },
      onError: () => toast.error("Couldn't start the backfill"),
    },
  });

  const cancelJob = useCancelSourceLinkJob({
    mutation: {
      onSuccess: (res) => {
        if (res.canceled) toast.success("Halting — the current article will finish, then it stops.");
        else toast.info("No backfill is running.");
        refetchStatus();
      },
      onError: () => toast.error("Couldn't halt the backfill"),
    },
  });

  // Citation notes ("evidence map"): one AI sentence per reference explaining
  // why the source is included. Backfill runs in the background; poll while
  // running so the button re-enables and the remaining count updates.
  // isStale = status is "running" but heartbeat has expired (worker crashed).
  const notesStatusQuery = useGetCitationNotesStatus({
    query: {
      queryKey: getGetCitationNotesStatusQueryKey(),
      refetchInterval: (query) => (query.state.data?.status === "running" ? 2000 : false),
    },
  });
  const notesStatus = notesStatusQuery.data;
  const notesStale = notesStatus?.isStale ?? false;
  // Treat a stale heartbeat as not-running so the operator can retrigger.
  const notesRunning = notesStatus?.status === "running" && !notesStale;
  const notesRemaining = notesStatus?.remaining ?? 0;
  const notesDeclined = notesStatus?.declinedAttempts ?? 0;

  const notesBackfill = useRunCitationNotesBackfill({
    mutation: {
      onSuccess: () => {
        toast.success("Writing citation notes in the background.");
        notesStatusQuery.refetch();
      },
      onError: () => toast.error("Couldn't start the citation-notes run (maybe one is already running)."),
    },
  });

  const notesCancel = useCancelCitationNotesBackfill({
    mutation: {
      onSuccess: (res) => {
        if (res.cancelled) toast.success("Stop requested — the job will finish the current article then exit.");
        else toast.info("No citation-notes run is currently active.");
        notesStatusQuery.refetch();
      },
      onError: () => toast.error("Couldn't send the stop request."),
    },
  });

  const notesResetDeclined = useResetDeclinedNoteAttempts({
    mutation: {
      onSuccess: (res) => {
        if (res.reset > 0) {
          toast.success(`Reset ${res.reset} declined attempt${res.reset === 1 ? "" : "s"} — click "Write citation notes" to retry them.`);
          notesStatusQuery.refetch();
        } else {
          toast.info("Nothing to reset — no previously-declined attempts found.");
        }
      },
      onError: () => toast.error("Reset failed"),
    },
  });

  // Source diversity sweep: strips same-paper mirror duplicates (doi.org +
  // PMC + publisher all citing the same paper → keep best-tier, reject rest)
  // and clears junk bot-wall titles. After the sweep, affected articles fall
  // below the source cap so "Top up sources" fills the gaps.
  //
  // sweepStarted drives aggressive polling for 30s after triggering so we
  // catch the result even if the sweep finishes in under a second.
  const [sweepStarted, setSweepStarted] = useState(false);
  const diversityStatusQuery = useGetDiversitySweepStatus({
    query: {
      queryKey: getGetDiversitySweepStatusQueryKey(),
      refetchInterval: (query) =>
        sweepStarted || query.state.data?.status === "running" ? 1000 : false,
    },
  });
  const diversityStatus = diversityStatusQuery.data?.status;
  const diversityRunning = diversityStatus === "running" || sweepStarted;
  const diversityProgress = diversityStatusQuery.data?.progress as Record<string, unknown> | null | undefined;

  // Show a result toast when the sweep finishes (catches both fast and slow runs).
  useEffect(() => {
    if (sweepStarted && diversityStatus && diversityStatus !== "running") {
      setSweepStarted(false);
      if (diversityStatus === "succeeded") {
        const p = diversityProgress;
        const rejected = Number(p?.rowsRejected ?? 0);
        const dupes = Number(p?.duplicateGroups ?? 0);
        const junk = Number(p?.junkTitlesCleared ?? 0);
        const parts: string[] = [];
        if (rejected > 0)
          parts.push(`removed ${rejected} duplicate reference${rejected === 1 ? "" : "s"} across ${dupes} group${dupes === 1 ? "" : "s"}`);
        if (junk > 0)
          parts.push(`cleared ${junk} junk title${junk === 1 ? "" : "s"}`);
        if (parts.length > 0)
          toast.success(`Dedup complete: ${parts.join(", ")}.`);
        else
          toast.info("Dedup complete — no duplicate references or junk titles found.");
      } else {
        toast.error("Dedup sweep failed — check server logs.");
      }
    }
  }, [diversityStatus, sweepStarted, diversityProgress]);

  const diversitySweep = useRunDiversitySweep({
    mutation: {
      onSuccess: () => {
        setSweepStarted(true);
        diversityStatusQuery.refetch();
      },
      onError: () => toast.error("Couldn't start the dedup sweep (maybe one is already running)."),
    },
  });

  // Citation-metadata backfill ("Retry reference titles"): poll while running
  // so the progress card updates live, and for 30s after triggering to catch
  // fast completions the same way we do for diversity sweep.
  const [citationBackfillStarted, setCitationBackfillStarted] = useState(false);
  const citationBackfillQuery = useGetCitationBackfillStatus({
    query: {
      queryKey: getGetCitationBackfillStatusQueryKey(),
      refetchInterval: (query) =>
        citationBackfillStarted || query.state.data?.status === "running" ? 1500 : false,
    },
  });
  const citationBackfillStatus = citationBackfillQuery.data;
  const citationBackfillRunning = citationBackfillStatus?.status === "running";
  const citationBackfillProgress = citationBackfillStatus?.progress as Record<string, unknown> | null | undefined;

  useEffect(() => {
    if (citationBackfillStarted && citationBackfillStatus?.status && citationBackfillStatus.status !== "running") {
      setCitationBackfillStarted(false);
    }
  }, [citationBackfillStatus?.status, citationBackfillStarted]);

  const citationBackfillCancel = useCancelCitationBackfill({
    mutation: {
      onSuccess: (res) => {
        res.cancelled
          ? toast.success("Stop requested — the job will finish its current URL then halt.")
          : toast.info("No running backfill to stop.");
        citationBackfillQuery.refetch();
      },
      onError: () => toast.error("Couldn't request stop"),
    },
  });

  const citationBackfillForceRelease = useForceReleaseCitationBackfill({
    mutation: {
      onSuccess: (res) => {
        res.released
          ? toast.success("Job cleared — you can now start a fresh run.")
          : toast.info("No stuck job found (it may have already finished).");
        citationBackfillQuery.refetch();
      },
      onError: () => toast.error("Couldn't force-release the job"),
    },
  });

  const resetCitations = useResetAndRetryCitations({
    mutation: {
      onSuccess: (res) => {
        if (res.started) {
          toast.success(`Reset ${res.reset} failed attempt${res.reset === 1 ? "" : "s"} — fetching reference titles in the background.`);
          setCitationBackfillStarted(true);
          citationBackfillQuery.refetch();
        } else if (res.reset > 0)
          toast.info(`Reset ${res.reset} attempts but a backfill is already running — they'll be picked up in that run.`);
        else
          toast.info("Nothing to reset — no previously-failed attempts found.");
      },
      onError: () => toast.error("Couldn't reset citations"),
    },
  });

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const linkCount = (a: (typeof articles)[number]) => extractLinks(a.body).length;
  // "Needs work" = below the per-article source cap.
  const needsWork = (a: (typeof articles)[number]) => linkCount(a) < SOURCE_LINK_TARGET;
  const total = articles.length;
  const needWork = articles.filter(needsWork).length;
  const atTarget = total - needWork;

  const visible = articles.filter((a) => {
    if (filter === "has") return !needsWork(a);
    if (filter === "missing") return needsWork(a);
    return true;
  });

  const pct = status && status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0;

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-bold">Source links</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Verified external source citations in published articles, up to {SOURCE_LINK_TARGET} per article.{" "}
            <span className="font-medium text-foreground">{atTarget}</span> are fully sourced,{" "}
            <span className="font-medium text-foreground">{needWork}</span> can take more.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => backfill.mutate()}
            disabled={running || backfill.isPending || needWork === 0}
          >
            {backfill.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
            Top up sources
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => notesBackfill.mutate()}
            disabled={notesRunning || notesBackfill.isPending || (notesRemaining === 0 && notesDeclined === 0)}
            title={
              notesRemaining === 0 && notesDeclined > 0
                ? `${notesDeclined} article${notesDeclined === 1 ? "" : "s"} have sources where the AI chose to write no note (couldn't explain confidently) — clicking runs them again in case a fresh attempt succeeds`
                : "Write the one-sentence 'why it's included' note under each reference"
            }
          >
            {notesRunning || notesBackfill.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <NotebookPen className="h-4 w-4 mr-2" />
            )}
            {notesRunning
              ? "Writing citation notes…"
              : notesRemaining > 0
                ? `Write citation notes (${notesRemaining})`
                : notesDeclined > 0
                  ? `Write citation notes (${notesDeclined} to retry)`
                  : "Write citation notes"}
          </Button>
          {notesRunning && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => notesCancel.mutate()}
              disabled={notesCancel.isPending}
              title="Request the job to stop after the current article — won't kill it mid-sentence"
            >
              {notesCancel.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <OctagonX className="h-4 w-4 mr-2" />}
              Stop notes
            </Button>
          )}
          {notesStale && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => notesBackfill.mutate()}
              disabled={notesBackfill.isPending}
              title="The citation-notes job appears stale (heartbeat expired) — click to restart it"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Restart (stalled)
            </Button>
          )}
          {!notesRunning && !notesStale && notesDeclined > 0 && notesRemaining === 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => notesResetDeclined.mutate()}
              disabled={notesResetDeclined.isPending}
              title="Clear prior declined attempts so the model gets another shot at writing notes for those sources"
            >
              {notesResetDeclined.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Reset declined ({notesDeclined})
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => diversitySweep.mutate()}
            disabled={diversityRunning || diversitySweep.isPending}
            title="Strip same-paper mirror duplicates (doi.org + PMC + publisher site) and clear junk titles"
          >
            {diversityRunning || diversitySweep.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4 mr-2" />
            )}
            {diversityRunning ? "Deduplicating…" : "Dedup sources"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => resetCitations.mutate()}
            disabled={resetCitations.isPending}
            title="Reset previously-failed citation-metadata attempts (anchor text showing as titles, bot-walled pages) and start a fresh backfill to retry them all"
          >
            {resetCitations.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            {resetCitations.isPending ? "Resetting…" : "Retry reference titles"}
          </Button>
          {running ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => cancelJob.mutate()}
              disabled={cancelJob.isPending || status?.canceled}
            >
              {cancelJob.isPending || status?.canceled ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <OctagonX className="h-4 w-4 mr-2" />
              )}
              {status?.canceled ? "Halting…" : "Halt"}
            </Button>
          ) : null}
        </div>
      </div>

      {notesStatus ? (
        <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
          <span>
            Citation notes: {notesStatus.sourcesWithNotes ?? 0} of {notesStatus.sourcesTotal ?? 0} sources noted
          </span>
          <span>
            {notesStatus.articlesWithNotes ?? 0} of {notesStatus.articlesTotal ?? 0} articles have at least one note
          </span>
          {notesRemaining > 0 ? <span>{notesRemaining} articles still pending</span> : null}
          {notesDeclined > 0 ? <span className="text-amber-600">{notesDeclined} articles had sources the model declined — use "Reset declined" to retry</span> : null}
          {notesStale ? <span className="text-destructive">⚠ Job appears stalled (heartbeat expired)</span> : null}
        </div>
      ) : null}

      {(running || (status && status.finishedAt && status.processed > 0)) && status ? (
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">
              {running
                ? "Adding source links…"
                : status.canceled
                  ? "Backfill halted"
                  : "Last run complete"}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {status.processed} / {status.total}
            </span>
          </div>
          <Progress value={running || status.canceled ? pct : 100} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Sourced {status.updated}</span>
            <span>Links added {status.linksAdded}</span>
            <span>Skipped {status.skipped}</span>
            {status.failed > 0 ? <span className="text-destructive">Failed {status.failed}</span> : null}
            {status.canceled ? <span>Canceled</span> : null}
          </div>
        </Card>
      ) : null}

      {(diversityRunning || (diversityProgress && Object.keys(diversityProgress).length > 0)) ? (
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">
              {diversityRunning ? "Deduplicating source references…" : "Last dedup sweep complete"}
            </span>
            {diversityRunning && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
          {diversityProgress && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {typeof diversityProgress.duplicateGroups === "number" && (
                <span>Duplicate groups found: {diversityProgress.duplicateGroups}</span>
              )}
              {typeof diversityProgress.rowsRejected === "number" && (
                <span>Rows removed: {diversityProgress.rowsRejected}</span>
              )}
              {typeof diversityProgress.junkTitlesCleared === "number" && (
                <span>Junk titles cleared: {diversityProgress.junkTitlesCleared}</span>
              )}
              {typeof diversityProgress.articlesAffected === "number" && (
                <span>Articles affected: {diversityProgress.articlesAffected}</span>
              )}
              {typeof diversityProgress.topUpLinksAdded === "number" && diversityProgress.topUpLinksAdded > 0 && (
                <span>Links re-added: {diversityProgress.topUpLinksAdded} (across {Number(diversityProgress.topUpArticlesFilled)} articles)</span>
              )}
            </div>
          )}
        </Card>
      ) : null}

      {(() => {
        const p = notesStatus?.progress as Record<string, unknown> | null | undefined;
        const proc = Number(p?.processed ?? 0);
        const tot = Number(p?.total ?? 0);
        const pct = tot > 0 ? Math.round((proc / tot) * 100) : 0;
        const show = notesRunning || notesStale || (p && tot > 0);
        if (!show) return null;
        return (
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">
                {notesRunning ? "Writing citation notes…" : notesStale ? "Citation notes — stalled" : "Last citation notes run"}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {proc} / {tot} articles
              </span>
            </div>
            <Progress value={notesRunning || notesStale ? pct : 100} />
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {typeof p?.notesWritten === "number" && <span>Notes written: {p.notesWritten}</span>}
              {typeof p?.rowsSkipped === "number" && p.rowsSkipped > 0 && <span>Model declined: {p.rowsSkipped}</span>}
              {typeof p?.failures === "number" && p.failures > 0 && <span className="text-destructive">Errors: {p.failures}</span>}
              {typeof p?.remaining === "number" && p.remaining > 0 && <span>Still to go (all runs): {p.remaining}</span>}
              {typeof p?.stoppedBy === "string" && (
                <span className="text-amber-600">Stopped by: {p.stoppedBy}</span>
              )}
            </div>
          </Card>
        );
      })()}

      {citationBackfillStatus ? (() => {
        const p = citationBackfillProgress;
        const proc = Number(p?.processed ?? 0);
        const tot = Number(p?.total ?? 0);
        const pct = tot > 0 ? Math.round((proc / tot) * 100) : 0;
        const active = citationBackfillRunning || citationBackfillStarted;
        const liveRemaining = citationBackfillStatus.remaining ?? 0;
        return (
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium flex items-center gap-2">
                {active ? "Fetching reference titles…" : "Reference title backfill"}
                {active && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {liveRemaining > 0
                  ? `${liveRemaining} still pending`
                  : active
                    ? (tot > 0 ? `${proc} / ${tot} URLs` : "starting…")
                    : "up to date"}
              </span>
            </div>
            {active && tot > 0 && <Progress value={pct} />}
            {p && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {typeof p.vaultCopied === "number" && p.vaultCopied > 0 && (
                  <span title="Titles copied from our Source Vault database — no network request needed">
                    From Vault: {p.vaultCopied}
                  </span>
                )}
                {typeof p.urlsFetched === "number" && p.urlsFetched > 0 && (
                  <span title="Source pages we fetched from the web to extract their title">
                    Web-fetched: {p.urlsFetched}
                  </span>
                )}
                {typeof p.rowsUpdated === "number" && (
                  <span title="Of the pages we fetched, how many yielded a usable title that was saved">
                    Titles saved: {p.rowsUpdated}
                  </span>
                )}
                {typeof p.fetchFailures === "number" && p.fetchFailures > 0 && (
                  <span className="text-destructive" title="Pages we could not read — site blocked our request, site was offline, or the URL was invalid">
                    Blocked / failed: {p.fetchFailures}
                  </span>
                )}
              </div>
            )}
            {active && (
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => citationBackfillCancel.mutate()}
                  disabled={citationBackfillCancel.isPending}
                  title="Ask the job to stop after its current URL — won't kill it mid-fetch"
                >
                  {citationBackfillCancel.isPending
                    ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    : <OctagonX className="h-4 w-4 mr-2" />}
                  Stop
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => citationBackfillForceRelease.mutate()}
                  disabled={citationBackfillForceRelease.isPending}
                  title="Force-clear the stuck job so you can start a fresh run immediately"
                >
                  {citationBackfillForceRelease.isPending
                    ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    : <RefreshCw className="h-4 w-4 mr-2" />}
                  Reset stuck job
                </Button>
              </div>
            )}
          </Card>
        );
      })() : null}

      <div className="flex gap-2">
        {(["all", "has", "missing"] as Filter[]).map((f) => (
          <Button
            key={f}
            variant={filter === f ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(f)}
          >
            {f === "all" ? `All (${total})` : f === "has" ? `At target (${atTarget})` : `Needs work (${needWork})`}
          </Button>
        ))}
      </div>

      {articlesQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground py-12 text-center">No articles match this filter.</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {visible.map((a) => {
            const links = extractLinks(a.body);
            const count = links.length;
            const present = count > 0;
            const isOpen = expanded.has(a.id);
            return (
              <Card key={a.id} className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => toggle(a.id)}
                    disabled={!present}
                    aria-expanded={present ? isOpen : undefined}
                    aria-controls={present ? `sources-${a.id}` : undefined}
                    className="min-w-0 flex items-start gap-2 text-left disabled:cursor-default disabled:opacity-100"
                  >
                    {present ? (
                      isOpen ? (
                        <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                      )
                    ) : (
                      <span className="w-4 shrink-0" />
                    )}
                    <span className="min-w-0 space-y-2">
                      <span
                        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          count >= SOURCE_LINK_TARGET ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"
                        }`}
                      >
                        <Link2 className="h-3 w-3" />
                        {count}/{SOURCE_LINK_TARGET} sources
                      </span>
                      <span className="block text-sm font-medium line-clamp-2" title={a.title}>
                        {a.title}
                      </span>
                    </span>
                  </button>
                  <Link
                    href={`/admin/articles/${a.id}`}
                    className="text-muted-foreground hover:text-foreground shrink-0"
                    title="Edit article"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Link>
                </div>

                {present && isOpen ? (
                  <ul id={`sources-${a.id}`} className="space-y-3 border-t pt-3">
                    {links.map((link, i) => (
                      <li key={`${link.url}-${i}`} className="text-xs space-y-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">
                            <Link2 className="h-3 w-3" />
                            {link.anchor}
                          </span>
                          <ArrowRight className="h-3 w-3 text-muted-foreground" />
                          <a
                            href={link.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-primary hover:underline font-medium"
                            title={link.url}
                          >
                            {link.host}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                        <p className="text-muted-foreground leading-relaxed">
                          {link.before}
                          <mark className="bg-amber-100 text-foreground rounded px-0.5">{link.anchor}</mark>
                          {link.after}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
