import {
  useListTrendSignals,
  useGetTrendScanStatus,
  useStartTrendScan,
  useDraftTrendSignal,
  useSendTrendSignalToIdeas,
  useDismissTrendSignal,
  useListStoryClusters,
  useSetClusterCoverage,
  useListBeats,
  useListEvidencePackets,
  useScreenCluster,
  useListTrendMarkers,
  useEscalateTrendMarker,
  useInvestigateTrendMarker,
  useDismissTrendMarker,
  useListRejectedSources,
  useResortVault,
  useCancelVaultResort,
  useGetVaultResortStatus,
  getGetVaultResortStatusQueryKey,
  getListTrendSignalsQueryKey,
  getGetTrendScanStatusQueryKey,
  getListStoryClustersQueryKey,
  getListEvidencePacketsQueryKey,
  getGetLatestEvidencePacketQueryKey,
  getListTrendMarkersQueryKey,
  getListRejectedSourcesQueryKey,
  useListResortSnapshots,
  useDeleteResortSnapshot,
  useDeleteAllResortSnapshots,
  useRestoreResortSnapshot,
  getListResortSnapshotsQueryKey,
  type TrendSignal,
  type StoryCluster,
  type SetClusterCoverageInput,
  type EvidencePacket,
  type TrendMarker,
  type RejectedSource,
  type ResortSnapshotMeta,
  ScreenClusterInputResearch,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  Radar,
  FileEdit,
  X,
  ExternalLink,
  AlertTriangle,
  Lightbulb,
  Layers,
  Check,
  Ban,
  RotateCcw,
  Scale,
  Quote,
  FileSearch,
  ChevronDown,
  Activity,
  Trash2,
  ArrowUpRight,
} from "lucide-react";
import { toast } from "sonner";
import { useState, useEffect, useRef } from "react";
import { format } from "date-fns";

const STATUSES = ["new", "drafted", "dismissed", "all"] as const;
type StatusFilter = (typeof STATUSES)[number];

// --- Semantic reconciler types (Task #330) ------------------------------
interface ClusterMergeRow {
  id: string;
  mergedFromClusterId: string;
  mergedFromLabel: string;
  mergedIntoClusterId: string;
  mergedIntoLabel: string;
  beatSlug: string;
  beat: string;
  rationale: string | null;
  membersReassigned: number;
  judgedAt: string;
  createdAt: string;
}
interface ClusterMergesResponse {
  merges: ClusterMergeRow[];
  totalMerges: number;
}

// Human-readable label + tone for each fail-closed per-beat scan outcome.
const OUTCOME_META: Record<string, { label: string; tone: string }> = {
  search_success: { label: "Found hooks", tone: "text-emerald-700" },
  search_empty: { label: "Nothing fresh", tone: "text-muted-foreground" },
  search_failed: { label: "Search failed", tone: "text-rose-700" },
  tool_unavailable: { label: "Search unavailable", tone: "text-rose-700" },
  budget_exhausted: { label: "Budget reached", tone: "text-amber-700" },
  skipped_fail_closed: { label: "Skipped (unverified)", tone: "text-amber-700" },
};

function ScoreBar({ label, value, tone }: { label: string; value: number; tone: "urgency" | "risk" }) {
  const pct = Math.max(0, Math.min(100, value));
  const barColor =
    tone === "urgency"
      ? pct >= 66
        ? "bg-emerald-500"
        : pct >= 33
          ? "bg-amber-500"
          : "bg-muted-foreground/40"
      : pct >= 66
        ? "bg-rose-500"
        : pct >= 33
          ? "bg-amber-500"
          : "bg-emerald-500";
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground w-14 shrink-0">{label}</span>
      <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
        <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums w-7 text-right">{pct}</span>
    </div>
  );
}

type View = "signals" | "clusters" | "markers" | "rejected";

export default function TrendRadar() {
  const [view, setView] = useState<View>("signals");
  return (
    <div className="p-4 md:p-8 max-w-6xl">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="font-serif text-3xl font-bold mb-1 flex items-center gap-2">
            <Radar className="h-7 w-7 text-primary" /> Trend Radar
          </h1>
          <p className="text-muted-foreground">
            Scout fresh news and trends per beat, then turn the strongest, source-grounded hooks into
            drafts — or triage the story clusters the Source Vault is observing automatically.
          </p>
        </div>
      </div>

      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setView("signals")}
          className={`px-3 py-1.5 rounded-full text-sm inline-flex items-center gap-1.5 ${
            view === "signals"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          <Radar className="h-3.5 w-3.5" /> Signals
        </button>
        <button
          onClick={() => setView("clusters")}
          className={`px-3 py-1.5 rounded-full text-sm inline-flex items-center gap-1.5 ${
            view === "clusters"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          <Layers className="h-3.5 w-3.5" /> Evidence clusters
        </button>
        <button
          onClick={() => setView("markers")}
          className={`px-3 py-1.5 rounded-full text-sm inline-flex items-center gap-1.5 ${
            view === "markers"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          <Activity className="h-3.5 w-3.5" /> Trend markers
        </button>
        <button
          onClick={() => setView("rejected")}
          className={`px-3 py-1.5 rounded-full text-sm inline-flex items-center gap-1.5 ${
            view === "rejected"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          <Trash2 className="h-3.5 w-3.5" /> Rejected junk
        </button>
      </div>

      {view === "signals" ? (
        <SignalsView />
      ) : view === "clusters" ? (
        <ClustersView />
      ) : view === "markers" ? (
        <MarkersView />
      ) : (
        <RejectedView />
      )}
    </div>
  );
}

function SignalsView() {
  const [status, setStatus] = useState<StatusFilter>("new");
  const [listBeatSlug, setListBeatSlug] = useState<string>("");
  const [scanBeatSlug, setScanBeatSlug] = useState<string>("");
  const qc = useQueryClient();

  const { data: beatsData } = useListBeats();

  // Poll the scan job while it's running so progress/results converge without
  // a manual refresh.
  const { data: scanStatus } = useGetTrendScanStatus({
    query: {
      queryKey: getGetTrendScanStatusQueryKey(),
      refetchInterval: (query) =>
        (query.state.data as { running?: boolean } | undefined)?.running ? 4000 : false,
    },
  });
  const scanning = scanStatus?.running ?? false;

  // Poll the vault re-sort job while it's running so its progress converges.
  const { data: resortStatus } = useGetVaultResortStatus({
    query: {
      queryKey: getGetVaultResortStatusQueryKey(),
      refetchInterval: (query) =>
        (query.state.data as { running?: boolean } | undefined)?.running ? 4000 : false,
    },
  });
  const resorting = resortStatus?.running ?? false;
  // Stalled = server claims it's running but hasn't heartbeated in >3 min (process died).
  const STALL_MS = 3 * 60 * 1000;
  const resortStalled =
    resorting &&
    !!resortStatus?.heartbeatAt &&
    Date.now() - new Date(resortStatus.heartbeatAt).getTime() > STALL_MS;

  // Toast on re-sort finish so the operator isn't left wondering if it worked.
  const wasResortingRef = useRef(resorting);
  useEffect(() => {
    const wasRunning = wasResortingRef.current;
    wasResortingRef.current = resorting;
    if (wasRunning && !resorting && resortStatus?.finishedAt) {
      if (resortStatus.error) {
        toast.error(`Re-sort failed: ${resortStatus.error}`);
      } else {
        toast.success(
          `Re-sort complete — ${resortStatus.recomputed} clusters re-scored, ${resortStatus.clustersDeleted} released, ${resortStatus.reclustered?.created ?? 0} new groups formed.`,
        );
      }
    }
  }, [resorting, resortStatus?.finishedAt, resortStatus?.error, resortStatus?.recomputed, resortStatus?.clustersDeleted, resortStatus?.reclustered?.created]);

  // Displayed list is filtered by both the status tab and the beat dropdown.
  // While a scan is running, poll so freshly-inserted signals appear live.
  const params = {
    ...(status === "all" ? {} : { status }),
    ...(listBeatSlug ? { beatSlug: listBeatSlug } : {}),
  };
  const { data, isLoading } = useListTrendSignals(params, {
    query: {
      queryKey: getListTrendSignalsQueryKey(params),
      refetchInterval: scanning ? 4000 : false,
    },
  });

  // Count badges respect the beat filter (but not the status tab) so each tab
  // shows how many signals of that status exist in the current beat scope.
  const countParams = listBeatSlug ? { beatSlug: listBeatSlug } : undefined;
  const { data: allData } = useListTrendSignals(countParams, {
    query: {
      queryKey: getListTrendSignalsQueryKey(countParams),
      refetchInterval: scanning ? 4000 : false,
    },
  });
  const allItems = allData?.items ?? [];
  const countByStatus = (s: string) => allItems.filter((i) => i.status === s).length;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListTrendSignalsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetTrendScanStatusQueryKey() });
  };

  const startScan = useStartTrendScan({
    mutation: {
      onSuccess: (res) => {
        if (res.alreadyRunning) {
          toast.info("A scan is already running.");
        } else {
          toast.success("Scan started — fresh hooks will appear as beats finish.");
        }
        invalidate();
      },
      onError: () => toast.error("Could not start the scan."),
    },
  });

  const cancelResort = useCancelVaultResort({
    mutation: {
      onSuccess: (res) => {
        if (res.cancelled) {
          toast.info("Stop requested — the re-sort will halt after its current step.");
        } else {
          toast.info("No re-sort is currently running.");
        }
        qc.invalidateQueries({ queryKey: getGetVaultResortStatusQueryKey() });
      },
      onError: () => toast.error("Could not stop the re-sort."),
    },
  });

  const resortVault = useResortVault({
    mutation: {
      onSuccess: (res) => {
        if (res.alreadyRunning) {
          toast.info("A re-sort is already running.");
        } else {
          toast.success("Re-sort started — clusters will re-score and re-group in the background.");
        }
        qc.invalidateQueries({ queryKey: getGetVaultResortStatusQueryKey() });
        qc.invalidateQueries({ queryKey: getListStoryClustersQueryKey() });
      },
      onError: () => toast.error("Could not start the re-sort."),
    },
  });

  const { data: snapshotsData } = useListResortSnapshots();
  const snapshots: ResortSnapshotMeta[] = snapshotsData?.snapshots ?? [];
  const invalidateSnapshots = () =>
    qc.invalidateQueries({ queryKey: getListResortSnapshotsQueryKey() });

  const restoreSnapshot = useRestoreResortSnapshot({
    mutation: {
      onSuccess: (result) => {
        toast.success(
          `Restored — ${result.clustersRestored} clusters, ${result.docsRestored} docs, ${result.verdictsRestored} verdicts.`,
        );
        qc.invalidateQueries({ queryKey: getListStoryClustersQueryKey() });
        invalidateSnapshots();
      },
      onError: (err) => {
        const e = err as unknown as { data?: { error?: string; message?: string } };
        toast.error(e?.data?.error ?? e?.data?.message ?? "Restore failed.");
      },
    },
  });

  // Restore a snapshot, then start a new re-sort run that skips the phases the
  // snapshot already captured (pre_a → full run, pre_b → skip re-score,
  // pre_c → semantic merge only).
  const [resumingSnapshotId, setResumingSnapshotId] = useState<string | null>(null);
  const restoreAndResume = async (snap: ResortSnapshotMeta) => {
    const startPhase = snap.snapshotType === "pre_c" ? "c" : snap.snapshotType === "pre_b" ? "b" : "a";
    setResumingSnapshotId(snap.id);
    try {
      await restoreSnapshot.mutateAsync({ id: snap.id });
      resortVault.mutate({ data: { startPhase } });
    } catch {
      // restoreSnapshot's onError already toasts; don't start the run on failure.
    } finally {
      setResumingSnapshotId(null);
    }
  };

  const deleteSingleSnapshot = useDeleteResortSnapshot({
    mutation: {
      onSuccess: () => invalidateSnapshots(),
      onError: () => toast.error("Could not delete snapshot."),
    },
  });

  const deleteAllSnapshots = useDeleteAllResortSnapshots({
    mutation: {
      onSuccess: (result) => {
        toast.info(`${result.deleted} snapshot${result.deleted === 1 ? "" : "s"} cleared.`);
        invalidateSnapshots();
      },
      onError: () => toast.error("Could not clear snapshots."),
    },
  });

  const draft = useDraftTrendSignal({
    mutation: {
      onSuccess: () => {
        toast.success("Draft started — it'll appear in Drafts when ready.");
        invalidate();
      },
      onError: (err) => {
        const e = err as unknown as { status?: number; data?: { error?: string; message?: string } };
        toast.error(e?.data?.error ?? e?.data?.message ?? "Draft failed.");
        invalidate();
      },
    },
  });

  const sendToIdeas = useSendTrendSignalToIdeas({
    mutation: {
      onSuccess: () => {
        toast.success("Sent to approved ideas — draft it from Ideas whenever you're ready.");
        invalidate();
      },
      onError: (err) => {
        const e = err as unknown as { status?: number; data?: { error?: string; message?: string } };
        toast.error(e?.data?.error ?? e?.data?.message ?? "Could not send this signal to ideas.");
        invalidate();
      },
    },
  });

  const dismiss = useDismissTrendSignal({
    mutation: {
      onSuccess: () => invalidate(),
      onError: () => toast.error("Could not dismiss this signal."),
    },
  });

  const items = data?.items ?? [];

  const runScan = () => {
    startScan.mutate({
      data: scanBeatSlug ? { beatSlugs: [scanBeatSlug] } : {},
    });
  };

  return (
    <>
      <Card className="p-4 mb-6">
        <h2 className="font-serif font-bold mb-1">Run a scan</h2>
        <p className="text-sm text-muted-foreground mb-3">
          Searches the live web for fresh angles. Each hook is scored for urgency and risk and matched to the best-fit author. Scoped to one beat, or all beats if none is chosen.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="border rounded-md px-2 py-1.5 text-sm bg-background min-w-[14rem]"
            value={scanBeatSlug}
            onChange={(e) => setScanBeatSlug(e.target.value)}
            disabled={scanning}
          >
            <option value="">All beats</option>
            {(beatsData?.items ?? []).map((b) => (
              <option key={b.id} value={b.slug}>
                {b.name}
              </option>
            ))}
          </select>
          <Button onClick={runScan} disabled={scanning || startScan.isPending} className="ml-auto">
            {scanning || startScan.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Radar className="h-4 w-4 mr-2" />
            )}
            {scanning ? "Scanning…" : "Scan for hooks"}
          </Button>
        </div>
        {scanning && (
          <div className="mt-3 text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>
              Scanning {scanStatus?.currentBeat ? `“${scanStatus.currentBeat}”` : "beats"} —{" "}
              {scanStatus?.processed ?? 0}/{scanStatus?.total ?? 0} beats, {scanStatus?.inserted ?? 0} new hook
              {(scanStatus?.inserted ?? 0) === 1 ? "" : "s"} so far.
            </span>
          </div>
        )}
        {!scanning && scanStatus?.finishedAt && (
          <p className="mt-3 text-xs text-muted-foreground">
            Last scan: {scanStatus.inserted} new hook{scanStatus.inserted === 1 ? "" : "s"} from{" "}
            {scanStatus.processed} beat{scanStatus.processed === 1 ? "" : "s"}
            {scanStatus.skipped > 0 ? `, ${scanStatus.skipped} skipped` : ""}
            {scanStatus.failed > 0 ? `, ${scanStatus.failed} failed` : ""}.
          </p>
        )}
        {(scanStatus?.outcomes?.length ?? 0) > 0 && (
          <div className="mt-3 border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground mb-1.5">Per-beat outcome</p>
            <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {scanStatus!.outcomes.map((o) => {
                const meta = OUTCOME_META[o.status] ?? { label: o.status, tone: "text-muted-foreground" };
                const suffix =
                  o.status === "search_success"
                    ? ` — ${o.inserted} new`
                    : o.detail
                      ? ` — ${o.detail}`
                      : "";
                return (
                  <li key={o.beatSlug} className="text-xs flex items-baseline gap-1.5">
                    <span className={`font-medium shrink-0 ${meta.tone}`}>{meta.label}</span>
                    <span className="text-muted-foreground truncate">
                      {o.beat}
                      {suffix}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Card>

      <Card className="p-4 mb-6">
        <h2 className="font-serif font-bold mb-1">Re-sort the vault</h2>
        <p className="text-sm text-muted-foreground mb-3">
          Re-scores every story cluster and re-groups un-acted sources under the current
          matching rules. Reference-only stubs stop inflating scores and mis-merged groups
          split back apart. Safe to run anytime — clusters you've already covered or acted on
          are left untouched.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {resorting && (
            <Button
              onClick={() => cancelResort.mutate()}
              disabled={cancelResort.isPending}
              variant="outline"
              size="sm"
              className="ml-auto text-destructive border-destructive/40 hover:bg-destructive/10"
            >
              {cancelResort.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <X className="h-4 w-4 mr-2" />
              )}
              {resortStalled ? "Clear stuck job" : "Stop"}
            </Button>
          )}
          <Button
            onClick={() => resortVault.mutate({ data: {} })}
            disabled={resorting || resortVault.isPending}
            variant="outline"
            className={resorting ? "" : "ml-auto"}
          >
            {resorting || resortVault.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Radar className="h-4 w-4 mr-2" />
            )}
            {resorting ? "Re-sorting…" : "Re-sort vault"}
          </Button>
        </div>
        {resorting && (
          <div className="mt-3 text-sm text-muted-foreground flex items-center gap-2">
            {resortStalled ? (
              <>
                <span className="inline-block h-2 w-2 rounded-full bg-amber-500 shrink-0" />
                <span>
                  {"Stalled — server restarted mid-run. Click "}
                  <span className="font-medium text-foreground">Clear stuck job</span>
                  {" to reset."}
                </span>
              </>
            ) : (
              <>
                <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                <span>
                  {resortStatus?.phase === "preparing" ? (
                    "Preparing — scanning clusters…"
                  ) : resortStatus?.phase === "snapshot_a" ? (
                    "Saving checkpoint (Phase A)…"
                  ) : resortStatus?.phase === "recompute" ? (
                    resortStatus.totalToRecompute > 0 ? (
                      <>
                        <span className="font-medium text-foreground">
                          {resortStatus.recomputed} / {resortStatus.totalToRecompute}
                        </span>
                        {" clusters re-scored"}
                      </>
                    ) : (
                      "Re-scoring clusters…"
                    )
                  ) : resortStatus?.phase === "snapshot_b" ? (
                    "Saving checkpoint (Phase B)…"
                  ) : resortStatus?.phase === "recluster" ? (
                    <>
                      {"Re-grouping — "}
                      <span className="font-medium text-foreground">
                        {resortStatus.clustersDeleted} released
                      </span>
                      {resortStatus.reclustered?.created
                        ? `, ${resortStatus.reclustered.created} new groups formed`
                        : ", re-clustering…"}
                    </>
                  ) : resortStatus?.phase === "snapshot_c" ? (
                    "Saving checkpoint (Phase C)…"
                  ) : resortStatus?.phase === "reconcile" ? (
                    <>
                      {"Semantic merge — "}
                      <span className="font-medium text-foreground">
                        {resortStatus.reconciled?.judged ?? 0} pairs judged
                      </span>
                      {(resortStatus.reconciled?.merged ?? 0) > 0
                        ? `, ${resortStatus.reconciled!.merged} merged`
                        : ", comparing…"}
                    </>
                  ) : (
                    "Starting…"
                  )}
                </span>
              </>
            )}
          </div>
        )}
        {!resorting && resortStatus?.finishedAt && (
          <p className="mt-3 text-xs text-muted-foreground">
            {resortStatus.error
              ? `Last re-sort failed: ${resortStatus.error}`
              : `Last re-sort: re-scored ${resortStatus.recomputed} cluster${
                  resortStatus.recomputed === 1 ? "" : "s"
                }, released ${resortStatus.clustersDeleted} for re-grouping, formed ${
                  resortStatus.reclustered?.created ?? 0
                } new.`}
          </p>
        )}
      </Card>

      {snapshots.length > 0 && (
        <Card className="p-4 mb-6">
          <div className="flex items-start justify-between mb-3 gap-4">
            <div>
              <h2 className="font-serif font-bold">Re-sort snapshots</h2>
              <p className="text-sm text-muted-foreground">
                Checkpoints saved before each phase. Restore to roll back, or restore &amp; resume to
                continue a run from that phase. Finished-run snapshots auto-delete after 72 hours.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => deleteAllSnapshots.mutate()}
              disabled={deleteAllSnapshots.isPending}
              className="text-muted-foreground hover:text-destructive shrink-0"
            >
              {deleteAllSnapshots.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <Trash2 className="h-4 w-4 mr-1" />
              )}
              Clear all
            </Button>
          </div>
          <div className="divide-y">
            {snapshots.map((snap) => {
              const isCurrentRun = !!resortStatus?.runId && snap.runId === resortStatus.runId;
              const outcome: "succeeded" | "failed" | "cancelled" | "running" | "interrupted" =
                snap.runOutcome ?? (isCurrentRun && resorting ? "running" : "interrupted");
              const expiresIn =
                outcome === "succeeded" && snap.runFinishedAt
                  ? Math.max(
                      0,
                      Math.round(
                        (new Date(snap.runFinishedAt).getTime() +
                          72 * 60 * 60 * 1000 -
                          Date.now()) /
                          (60 * 60 * 1000),
                      ),
                    )
                  : null;
              return (
                <div key={snap.id} className="flex items-center gap-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">
                      {snap.snapshotType === "pre_a"
                        ? "Pre-A — initial state"
                        : snap.snapshotType === "pre_b"
                          ? "Pre-B — after re-score"
                          : "Pre-C — after re-group"}
                    </span>
                    <span
                      className={`text-[11px] font-medium px-1.5 py-0.5 rounded ml-2 ${
                        outcome === "succeeded"
                          ? "bg-emerald-500/10 text-emerald-600"
                          : outcome === "running"
                            ? "bg-blue-500/10 text-blue-600"
                            : outcome === "cancelled"
                              ? "bg-amber-500/10 text-amber-600"
                              : "bg-destructive/10 text-destructive"
                      }`}
                    >
                      {outcome === "succeeded"
                        ? expiresIn !== null
                          ? `Run finished · deletes in ~${expiresIn}h`
                          : "Run finished"
                        : outcome === "running"
                          ? "Run in progress"
                          : outcome === "cancelled"
                            ? "Run stopped"
                            : outcome === "failed"
                              ? "Run failed"
                              : "Run interrupted"}
                    </span>
                    <span className="text-xs text-muted-foreground ml-2">
                      {snap.clusterCount} clusters · {snap.docCount} docs
                      {snap.verdictCount > 0 ? ` · ${snap.verdictCount} verdicts` : ""}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {format(new Date(snap.createdAt), "MMM d, HH:mm")}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => restoreSnapshot.mutate({ id: snap.id })}
                    disabled={restoreSnapshot.isPending || resorting}
                  >
                    {restoreSnapshot.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5 mr-1" />
                    )}
                    Restore
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => restoreAndResume(snap)}
                    disabled={restoreSnapshot.isPending || resortVault.isPending || resorting}
                  >
                    {resumingSnapshotId === snap.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                    ) : (
                      <Radar className="h-3.5 w-3.5 mr-1" />
                    )}
                    Restore &amp; resume
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => deleteSingleSnapshot.mutate({ id: snap.id })}
                    disabled={deleteSingleSnapshot.isPending}
                    className="text-muted-foreground hover:text-destructive px-2"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="flex gap-2 flex-wrap">
          {STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-3 py-1.5 rounded-full text-sm capitalize ${
                status === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {s} ({s === "all" ? allItems.length : countByStatus(s)})
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm ml-auto">
          <span className="text-muted-foreground">Beat</span>
          <select
            className="border rounded-md px-2 py-1.5 text-sm bg-background min-w-[12rem]"
            value={listBeatSlug}
            onChange={(e) => setListBeatSlug(e.target.value)}
          >
            <option value="">All beats</option>
            {(beatsData?.items ?? []).map((b) => (
              <option key={b.id} value={b.slug}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {isLoading ? (
        <Loader2 className="animate-spin" />
      ) : items.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {status === "new"
            ? "No fresh hooks yet. Run a scan to scout the latest trends."
            : "No signals in this view."}
        </p>
      ) : (
        <div className="space-y-3">
          {items
            .slice()
            .sort((a, b) => b.urgencyScore - a.urgencyScore)
            .map((signal: TrendSignal) => (
              <Card key={signal.id} className="p-4">
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full capitalize ${
                          signal.status === "drafted"
                            ? "bg-blue-100 text-blue-700"
                            : signal.status === "dismissed"
                              ? "bg-muted text-muted-foreground"
                              : "bg-emerald-100 text-emerald-700"
                        }`}
                      >
                        {signal.status}
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                        {signal.beat}
                      </span>
                      {signal.suggestedAuthorName && (
                        <span className="text-xs text-muted-foreground">
                          Best fit: {signal.suggestedAuthorName}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground ml-auto">
                        {format(new Date(signal.createdAt), "MMM d")}
                      </span>
                    </div>

                    <h3 className="font-serif font-bold text-lg leading-snug">{signal.headline}</h3>
                    <p className="text-sm mt-1">
                      <span className="font-medium">Angle: </span>
                      <span className="text-muted-foreground">{signal.angle}</span>
                    </p>
                    <p className="text-sm mt-1">
                      <span className="font-medium">Event: </span>
                      <span className="text-muted-foreground">{signal.event}</span>
                    </p>

                    <a
                      href={signal.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-primary hover:underline inline-flex items-center gap-1 mt-1"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {signal.source}
                    </a>

                    <div className="mt-3 grid gap-1.5 max-w-md">
                      <ScoreBar label="Urgency" value={signal.urgencyScore} tone="urgency" />
                      <ScoreBar label="Risk" value={signal.riskScore} tone="risk" />
                    </div>
                    {signal.riskReason && (
                      <p className="text-xs text-muted-foreground mt-2 flex items-start gap-1.5">
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                        <span>{signal.riskReason}</span>
                      </p>
                    )}
                  </div>

                  <div className="flex flex-col items-stretch gap-1 shrink-0 w-32">
                    {signal.status === "new" && (
                      <>
                        <Button
                          size="sm"
                          disabled={draft.isPending}
                          onClick={() => draft.mutate({ id: signal.id })}
                        >
                          {draft.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                          ) : (
                            <FileEdit className="h-4 w-4 mr-2" />
                          )}
                          Draft
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={sendToIdeas.isPending}
                          onClick={() => sendToIdeas.mutate({ id: signal.id })}
                          title="Create an approved idea without drafting yet"
                        >
                          {sendToIdeas.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                          ) : (
                            <Lightbulb className="h-4 w-4 mr-2" />
                          )}
                          Send to ideas
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={dismiss.isPending}
                          onClick={() => dismiss.mutate({ id: signal.id })}
                        >
                          <X className="h-4 w-4 mr-2" />
                          Dismiss
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </Card>
            ))}
        </div>
      )}
    </>
  );
}

const CLUSTER_STATUSES = ["active", "dormant", "all"] as const;
type ClusterStatusFilter = (typeof CLUSTER_STATUSES)[number];

const COVERAGE_FILTERS = [
  { value: "open", label: "Open" },
  { value: "covered", label: "Covered" },
  { value: "do_not_cover", label: "Do not cover" },
  { value: "all", label: "All" },
] as const;
type CoverageFilter = (typeof COVERAGE_FILTERS)[number]["value"];

const COVERAGE_META: Record<
  string,
  { label: string; tone: string }
> = {
  open: { label: "Open", tone: "bg-emerald-100 text-emerald-800" },
  covered: { label: "Already covered", tone: "bg-sky-100 text-sky-800" },
  do_not_cover: { label: "Do not cover", tone: "bg-rose-100 text-rose-800" },
};

// Human-readable label + tone for each forced editorial decision (no "maybe").
const DECISION_META: Record<string, { label: string; tone: string }> = {
  reject_duplicate: { label: "Reject — duplicate", tone: "bg-rose-100 text-rose-800" },
  reject_too_thin: { label: "Reject — too thin", tone: "bg-rose-100 text-rose-800" },
  reject_low_authority: { label: "Reject — low authority", tone: "bg-rose-100 text-rose-800" },
  reject_stale: { label: "Reject — stale", tone: "bg-rose-100 text-rose-800" },
  reject_out_of_beat: { label: "Reject — out of beat", tone: "bg-rose-100 text-rose-800" },
  reject_too_risky: { label: "Reject — too risky", tone: "bg-rose-100 text-rose-800" },
  approve_research: { label: "Approve — research", tone: "bg-emerald-100 text-emerald-800" },
  approve_draft: { label: "Approve — draft", tone: "bg-emerald-100 text-emerald-800" },
  needs_human_editor: { label: "Needs human editor", tone: "bg-amber-100 text-amber-800" },
};

const RESEARCH_MODE_LABEL: Record<string, string> = {
  vault_only: "Vault only",
  sonar: "Sonar",
  deep_research: "Deep research",
};

function ClustersView() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<ClusterStatusFilter>("active");
  const [coverageFilter, setCoverageFilter] = useState<CoverageFilter>("open");
  const [beatSlug, setBeatSlug] = useState<string>("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [clusterSearch, setClusterSearch] = useState<string>("");
  const [showMerges, setShowMerges] = useState(false);

  const { data: beatsData } = useListBeats();

  const params = {
    includeSources: true,
    limit: 200,
    ...(statusFilter === "all" ? {} : { status: statusFilter }),
    // Coverage memory: default "open" hides dispositioned clusters from the
    // ranking; "all" opts back in via excludeCovered=false.
    ...(coverageFilter === "all"
      ? { excludeCovered: false }
      : { coverageStatus: coverageFilter }),
    ...(beatSlug ? { beatSlug } : {}),
  };
  const { data, isLoading } = useListStoryClusters(params, {
    query: { queryKey: getListStoryClustersQueryKey(params) },
  });

  const { data: mergesData } = useQuery<ClusterMergesResponse>({
    queryKey: ["cluster-merges"],
    queryFn: async () => {
      const res = await fetch("/api/admin/trends/clusters/merges?limit=20");
      if (!res.ok) throw new Error("Failed to fetch cluster merges");
      return res.json() as Promise<ClusterMergesResponse>;
    },
    staleTime: 60_000,
  });

  const setCoverage = useSetClusterCoverage({
    mutation: {
      onSuccess: () => {
        toast.success("Coverage updated");
        qc.invalidateQueries({ queryKey: getListStoryClustersQueryKey() });
      },
      onError: () => toast.error("Failed to update coverage"),
    },
  });

  const rawClusters = data?.items ?? [];
  const searchLower = clusterSearch.trim().toLowerCase();
  const clusters = searchLower
    ? rawClusters.filter(
        (c) =>
          c.label.toLowerCase().includes(searchLower) ||
          c.keywords.some((k) => k.toLowerCase().includes(searchLower)) ||
          c.beat.toLowerCase().includes(searchLower),
      )
    : rawClusters;

  return (
    <>
      <Card className="p-4 mb-6">
        <h2 className="font-serif font-bold mb-1">Story clusters</h2>
        <p className="text-sm text-muted-foreground mb-3">
          Groups of related observations the Source Vault is watching automatically. Ranked by a
          deterministic score (no paid AI): source volume, distinct families and domains, authority,
          and freshness. Mark a cluster as already covered or do-not-cover to keep it out of the
          ranking; covered clusters resurface after their window if fresh sources keep arriving.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            placeholder="Search clusters…"
            value={clusterSearch}
            onChange={(e) => setClusterSearch(e.target.value)}
            className="border rounded-md px-2 py-1.5 text-sm bg-background min-w-[14rem]"
          />
          <select
            className="border rounded-md px-2 py-1.5 text-sm bg-background min-w-[12rem]"
            value={beatSlug}
            onChange={(e) => setBeatSlug(e.target.value)}
          >
            <option value="">All beats</option>
            {(beatsData?.items ?? []).map((b) => (
              <option key={b.id} value={b.slug}>
                {b.name}
              </option>
            ))}
          </select>
          <div className="flex gap-1">
            {CLUSTER_STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 rounded-full text-sm capitalize ${
                  statusFilter === s
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {COVERAGE_FILTERS.map((c) => (
              <button
                key={c.value}
                onClick={() => setCoverageFilter(c.value)}
                className={`px-3 py-1.5 rounded-full text-sm ${
                  coverageFilter === c.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading clusters…
        </div>
      ) : clusters.length === 0 ? (
        <div className="text-center text-muted-foreground py-12">
          <Layers className="h-8 w-8 mx-auto mb-2 opacity-40" />
          <p>No story clusters yet.</p>
          <p className="text-sm">
            Clusters form automatically once discovery has ingested enough related sources.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {clusters.map((c) => (
            <ClusterCard
              key={c.id}
              cluster={c}
              expanded={expandedId === c.id}
              onToggle={() => setExpandedId((id) => (id === c.id ? null : c.id))}
              onSetCoverage={(data) => setCoverage.mutate({ id: c.id, data })}
              saving={setCoverage.isPending}
            />
          ))}
        </div>
      )}

      {/* --- Semantic reconciler audit (Task #330) ----------------------- */}
      <Card className="p-4 mt-6">
        <button
          className="w-full flex items-center justify-between"
          onClick={() => setShowMerges((v) => !v)}
        >
          <div className="flex items-center gap-2">
            <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
            <span className="font-semibold text-sm">Semantic merges</span>
            {(mergesData?.totalMerges ?? 0) > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                {mergesData!.totalMerges} total
              </span>
            )}
          </div>
          <ChevronDown
            className={`h-4 w-4 text-muted-foreground transition-transform ${showMerges ? "rotate-180" : ""}`}
          />
        </button>

        {!showMerges ? (
          <p className="text-xs text-muted-foreground mt-2">
            When the semantic cluster reconciler is enabled (Admin → Settings → AI Controls), borderline
            same-beat cluster pairs are judged by an LLM. Confirmed same-story duplicates are merged here.
          </p>
        ) : (mergesData?.merges ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground mt-3">
            No merges recorded yet. Enable the reconciler in AI Controls to start.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {mergesData!.merges.map((m) => (
              <div key={m.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-0.5">
                  <span className="font-medium uppercase tracking-wide">{m.beat}</span>
                  <span>·</span>
                  <span>{format(new Date(m.createdAt), "MMM d, h:mm a")}</span>
                  {m.membersReassigned > 0 && (
                    <>
                      <span>·</span>
                      <span>{m.membersReassigned} source{m.membersReassigned === 1 ? "" : "s"} moved</span>
                    </>
                  )}
                </div>
                <div className="flex items-start gap-1.5">
                  <span className="text-muted-foreground line-through truncate max-w-[38%]" title={m.mergedFromLabel}>
                    {m.mergedFromLabel}
                  </span>
                  <ArrowUpRight className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
                  <span className="font-medium truncate" title={m.mergedIntoLabel}>
                    {m.mergedIntoLabel}
                  </span>
                </div>
                {m.rationale && (
                  <p className="text-xs text-muted-foreground mt-1 italic">"{m.rationale}"</p>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

function ClusterCard({
  cluster,
  expanded,
  onToggle,
  onSetCoverage,
  saving,
}: {
  cluster: StoryCluster;
  expanded: boolean;
  onToggle: () => void;
  onSetCoverage: (data: SetClusterCoverageInput) => void;
  saving: boolean;
}) {
  const cov = COVERAGE_META[cluster.coverageStatus] ?? COVERAGE_META.open;
  const [coverageForm, setCoverageForm] = useState<"covered" | "do_not_cover" | null>(null);
  const [reason, setReason] = useState("");
  const [resurfaceDays, setResurfaceDays] = useState("");
  const [showScreening, setShowScreening] = useState(false);
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {cluster.beat}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${cov.tone}`}>{cov.label}</span>
            {cluster.status === "dormant" && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                Dormant
              </span>
            )}
          </div>
          <h3 className="font-serif font-bold leading-snug">{cluster.label}</h3>
          <p className="text-xs text-muted-foreground mt-1">
            {cluster.sourceCount} evidence source{cluster.sourceCount === 1 ? "" : "s"} ·{" "}
            {cluster.familyCount} famil{cluster.familyCount === 1 ? "y" : "ies"} ·{" "}
            {cluster.domainCount} domain{cluster.domainCount === 1 ? "" : "s"}
            {(cluster.markerCount ?? 0) > 0 ? (
              <span className="text-amber-700">
                {" "}
                · {cluster.markerCount} trend marker{cluster.markerCount === 1 ? "" : "s"}
              </span>
            ) : (
              ""
            )}{" "}
            · last seen {format(new Date(cluster.lastSeenAt), "MMM d, h:mm a")}
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-2xl font-bold tabular-nums leading-none">
            {Math.round(cluster.score)}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">score</div>
        </div>
      </div>

      {cluster.keywords.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {cluster.keywords.slice(0, 10).map((k) => (
            <span key={k} className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              {k}
            </span>
          ))}
        </div>
      )}

      {cluster.coverageStatus !== "open" && cluster.coverageReason && (
        <p className="text-xs text-muted-foreground mt-2 italic">
          {cluster.coverageReason}
          {cluster.coverageResurfaceAfter
            ? ` — resurfaces ${format(new Date(cluster.coverageResurfaceAfter), "MMM d")}`
            : ""}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-3">
        <Button variant="ghost" size="sm" onClick={onToggle}>
          {expanded ? "Hide sources" : `Show sources (${cluster.sources.length})`}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowScreening((v) => !v)}
        >
          <Scale className="h-3.5 w-3.5 mr-1" />
          {showScreening ? "Hide screening" : "Screening"}
        </Button>
        <div className="flex-1" />
        {cluster.coverageStatus !== "covered" && (
          <Button
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => setCoverageForm((f) => (f === "covered" ? null : "covered"))}
          >
            <Check className="h-3.5 w-3.5 mr-1" /> Covered
          </Button>
        )}
        {cluster.coverageStatus !== "do_not_cover" && (
          <Button
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => setCoverageForm((f) => (f === "do_not_cover" ? null : "do_not_cover"))}
          >
            <Ban className="h-3.5 w-3.5 mr-1" /> Don't cover
          </Button>
        )}
        {cluster.coverageStatus !== "open" && (
          <Button
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => onSetCoverage({ status: "open" })}
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reopen
          </Button>
        )}
      </div>

      {coverageForm && (
        <div className="mt-3 border-t pt-3 space-y-2">
          <p className="text-sm font-medium">
            {coverageForm === "covered"
              ? "Mark this story as already covered"
              : "Mark this story as do-not-cover"}
          </p>
          <textarea
            className="w-full text-sm border rounded-md px-2 py-1.5 bg-background min-h-[60px]"
            placeholder={
              coverageForm === "covered"
                ? "Optional note — e.g. covered in our Tuesday explainer"
                : "Why not cover this? — e.g. rumor, not our beat, too speculative"
            }
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-muted-foreground flex items-center gap-2">
              Resurface after
              <input
                type="number"
                min={1}
                max={365}
                className="w-20 border rounded-md px-2 py-1 text-sm bg-background"
                placeholder="never"
                value={resurfaceDays}
                onChange={(e) => setResurfaceDays(e.target.value)}
              />
              days
            </label>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => setCoverageForm(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={saving}
              onClick={() => {
                const days = Number.parseInt(resurfaceDays, 10);
                onSetCoverage({
                  status: coverageForm,
                  reason: reason.trim() || null,
                  resurfaceAfterDays:
                    Number.isNaN(days) || days <= 0 ? null : Math.min(365, days),
                });
                setCoverageForm(null);
              }}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Leave "resurface after" blank to keep this decision permanent. If sources keep arriving,
            the cluster reopens automatically after the window so a re-emerging story isn't lost.
          </p>
        </div>
      )}

      {expanded && (
        <div className="mt-3 border-t pt-3 space-y-2">
          {cluster.sources.map((s) => (
            <div key={s.id} className="flex items-start gap-2 text-sm">
              <ExternalLink className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline break-words"
                >
                  {s.title || s.url}
                </a>
                <div className="text-xs text-muted-foreground">
                  {s.domain} · {s.authorityTier}
                  {s.publishedAt ? ` · ${format(new Date(s.publishedAt), "MMM d, yyyy")}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showScreening && <ScreeningPanel clusterId={cluster.id} />}
    </Card>
  );
}

// Read-only editorial-screening view: shows the latest immutable evidence packet
// for a cluster (forced decision + evidence), lets an admin trigger a fresh
// vault-first screening pass, and browse prior packet versions. All fields are
// read-only — this task does not draft, verify, or publish.
function ScreeningPanel({ clusterId }: { clusterId: string }) {
  const qc = useQueryClient();
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  // Research mode the editor wants for the NEXT screening pass. Defaults to the
  // free vault-only pass; escalating to "sonar" spends budget on a paid
  // Perplexity call (guarded server-side, degrades cleanly to vault-only).
  const [research, setResearch] = useState<ScreenClusterInputResearch>(
    ScreenClusterInputResearch.vault_only,
  );
  const isPaid = research !== ScreenClusterInputResearch.vault_only;

  // The list endpoint is the source of truth (it 200s with an empty array when
  // no packet exists); the "latest" is just the highest version in that list.
  // Avoids the latest-endpoint 404 firing an error toast/retries for the common
  // never-screened case.
  const { data: listData, isLoading: loading } = useListEvidencePackets(
    clusterId,
    { query: { queryKey: getListEvidencePacketsQueryKey(clusterId) } },
  );

  const packets = [...(listData?.items ?? [])].sort((a, b) => b.version - a.version);
  const latest = packets[0] ?? null;
  const active =
    selectedVersion == null
      ? latest
      : packets.find((p) => p.version === selectedVersion) ?? latest;

  const screen = useScreenCluster({
    mutation: {
      onSuccess: (res) => {
        toast.success(`Evidence packet v${res.version} — ${res.decision.replace(/_/g, " ")}`);
        setSelectedVersion(null);
        qc.invalidateQueries({ queryKey: getListEvidencePacketsQueryKey(clusterId) });
        qc.invalidateQueries({ queryKey: getGetLatestEvidencePacketQueryKey(clusterId) });
      },
      onError: () => toast.error("Screening failed"),
    },
  });

  return (
    <div className="mt-3 border-t pt-3 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <FileSearch className="h-3.5 w-3.5 text-muted-foreground" /> Editorial screening
        </div>
        <div className="flex items-center gap-1.5">
          <select
            className="border rounded-md px-2 py-1.5 text-xs bg-background"
            value={research}
            disabled={screen.isPending}
            onChange={(e) => setResearch(e.target.value as ScreenClusterInputResearch)}
            aria-label="Research mode"
          >
            <option value={ScreenClusterInputResearch.vault_only}>Vault only (free)</option>
            <option value={ScreenClusterInputResearch.sonar}>Sonar (paid research)</option>
          </select>
          <Button
            variant={isPaid ? "default" : "outline"}
            size="sm"
            disabled={screen.isPending}
            onClick={() => screen.mutate({ id: clusterId, data: { research } })}
          >
            {screen.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <Scale className="h-3.5 w-3.5 mr-1" />
            )}
            Run screening
          </Button>
        </div>
      </div>

      {isPaid && (
        <p className="text-xs text-amber-700 flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          Sonar spends budget on a paid Perplexity research call. If the daily budget is
          exhausted or Perplexity isn't configured, the pass degrades cleanly to vault only —
          check the retrieval context below for the outcome.
        </p>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading packets…
        </p>
      ) : !active ? (
        <p className="text-xs text-muted-foreground">
          No evidence packet yet. Run screening to build one from the Source Vault (no paid
          research call).
        </p>
      ) : (
        <>
          {packets.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap text-xs">
              <span className="text-muted-foreground">Version</span>
              {packets.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelectedVersion(p.version)}
                  className={`px-2 py-0.5 rounded-full border ${
                    p.version === active.version
                      ? "bg-foreground text-background border-foreground"
                      : "bg-background text-muted-foreground"
                  }`}
                >
                  v{p.version}
                </button>
              ))}
            </div>
          )}
          <PacketView packet={active} />
        </>
      )}
    </div>
  );
}

function PacketView({ packet }: { packet: EvidencePacket }) {
  const dec = DECISION_META[packet.decision] ?? {
    label: packet.decision,
    tone: "bg-muted text-muted-foreground",
  };
  const rc = packet.retrievalContext;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${dec.tone}`}>
          {dec.label}
        </span>
        <span className="text-xs text-muted-foreground">
          v{packet.version} · {RESEARCH_MODE_LABEL[packet.researchMode] ?? packet.researchMode} ·{" "}
          {packet.model} · {format(new Date(packet.createdAt), "MMM d, h:mm a")}
        </span>
      </div>

      {packet.decisionReasons.length > 0 && (
        <ul className="list-disc pl-5 space-y-0.5 text-xs text-muted-foreground">
          {packet.decisionReasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}

      {packet.doNotDraftReason && (
        <p className="text-xs text-rose-700 flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          {packet.doNotDraftReason}
        </p>
      )}

      <PacketSection icon={<FileSearch className="h-3.5 w-3.5" />} title="Retrieval context">
        <div className="text-xs text-muted-foreground space-y-0.5">
          <p>Query: {rc.query || "—"}</p>
          <p>
            {rc.vaultHitCount} vault hit{rc.vaultHitCount === 1 ? "" : "s"} ·{" "}
            {rc.sonarUsed ? "Sonar used" : "vault only"}
            {rc.priorPacketVersion != null
              ? ` · prior v${rc.priorPacketVersion} (${rc.priorDecision ?? "—"})`
              : ""}
          </p>
          {rc.existingArticleTitles.length > 0 && (
            <p>Existing coverage: {rc.existingArticleTitles.join("; ")}</p>
          )}
          {rc.researchNote && <p className="italic">{rc.researchNote}</p>}
        </div>
      </PacketSection>

      {packet.sources.length > 0 && (
        <PacketSection
          icon={<ExternalLink className="h-3.5 w-3.5" />}
          title={`Sources (${packet.sources.length}, authority-ordered)`}
        >
          <div className="space-y-1.5">
            {packet.sources.map((s) => (
              <div key={s.id} className="text-xs">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline break-words font-medium"
                >
                  {s.title || s.url}
                </a>
                <div className="text-muted-foreground">
                  {s.domain} · {s.authorityTier} · {s.lifecycleStatus}
                  {s.excerptOnly ? " · excerpt-only" : ""}
                  {s.paywallDetected ? " · paywall" : ""}
                </div>
              </div>
            ))}
          </div>
        </PacketSection>
      )}

      {packet.claims.length > 0 && (
        <PacketSection icon={<Check className="h-3.5 w-3.5" />} title={`Claims (${packet.claims.length})`}>
          <ul className="list-disc pl-5 space-y-0.5 text-xs">
            {packet.claims.map((c, i) => (
              <li key={i}>
                {c.text}
                {c.sourceIds.length > 0 && (
                  <span className="text-muted-foreground"> ({c.sourceIds.length} src)</span>
                )}
              </li>
            ))}
          </ul>
        </PacketSection>
      )}

      {packet.contradictions.length > 0 && (
        <PacketSection
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          title={`Contradictions (${packet.contradictions.length})`}
        >
          <ul className="list-disc pl-5 space-y-0.5 text-xs text-amber-700">
            {packet.contradictions.map((c, i) => (
              <li key={i}>{c.summary}</li>
            ))}
          </ul>
        </PacketSection>
      )}

      {packet.quoteCandidates.length > 0 && (
        <PacketSection
          icon={<Quote className="h-3.5 w-3.5" />}
          title={`Quote candidates (${packet.quoteCandidates.length})`}
        >
          <div className="space-y-2">
            {packet.quoteCandidates.map((q, i) => (
              <div key={i} className="text-xs border-l-2 pl-2">
                <p className="italic">"{q.text}"</p>
                <p className="text-muted-foreground">
                  — {q.attribution || "unattributed"}
                  {q.verified ? " · verified" : " · unverified"}
                  {q.allowedToQuote ? " · quotable" : " · do not quote"}
                </p>
              </div>
            ))}
          </div>
        </PacketSection>
      )}

      {packet.supportingChunks.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground flex items-center gap-1">
            <ChevronDown className="h-3 w-3" /> Supporting chunks ({packet.supportingChunks.length})
          </summary>
          <div className="mt-1.5 space-y-1.5">
            {packet.supportingChunks.map((c) => (
              <div key={c.chunkId} className="border-l-2 pl-2 text-muted-foreground">
                <span className="text-[10px] uppercase tracking-wide">
                  sim {c.similarity.toFixed(2)}
                </span>
                <p>{c.content}</p>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function PacketSection({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs font-medium mb-1">
        {icon} {title}
      </div>
      {children}
    </div>
  );
}

const MARKER_STATUSES = ["observed", "investigated", "escalated", "dismissed", "all"] as const;
type MarkerStatusFilter = (typeof MARKER_STATUSES)[number];

const MARKER_STATUS_META: Record<string, { label: string; tone: string }> = {
  observed: { label: "Observed", tone: "bg-amber-100 text-amber-800" },
  investigated: { label: "Investigated", tone: "bg-sky-100 text-sky-800" },
  escalated: { label: "Escalated", tone: "bg-emerald-100 text-emerald-800" },
  dismissed: { label: "Dismissed", tone: "bg-muted text-muted-foreground" },
};

// Weak SOCIAL signals (YouTube/Reddit/X/TikTok…). Recorded for velocity /
// public-interest ONLY — never chunked or embedded, zero authority. They can't
// clear the evidence floor alone; the only way one becomes evidence is manual
// escalation (enqueue for SSRF-safe ingest + verification).
function MarkersView() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<MarkerStatusFilter>("observed");
  const [beatSlug, setBeatSlug] = useState<string>("");

  const { data: beatsData } = useListBeats();

  const params = {
    limit: 200,
    ...(status === "all" ? {} : { status }),
    ...(beatSlug ? { beatSlug } : {}),
  };
  const { data, isLoading } = useListTrendMarkers(params, {
    query: { queryKey: getListTrendMarkersQueryKey(params) },
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListTrendMarkersQueryKey() });

  const escalate = useEscalateTrendMarker({
    mutation: {
      onSuccess: () => {
        toast.success("Escalated — the URL is queued for ingest + verification.");
        invalidate();
      },
      onError: (err) => {
        const e = err as unknown as { data?: { error?: string; message?: string } };
        toast.error(e?.data?.error ?? e?.data?.message ?? "Could not escalate this marker.");
        invalidate();
      },
    },
  });

  const investigate = useInvestigateTrendMarker({
    mutation: {
      onSuccess: (result) => {
        const r = result as unknown as {
          stoppedBy?: string;
          leadsEnqueued?: number;
          summary?: string;
        };
        if (r?.stoppedBy === "disabled") {
          toast.error("Source Vault is disabled — enable it to harvest buzz.");
        } else if (r?.stoppedBy === "budget") {
          toast.error("Source Vault budget reached — try again later.");
        } else if (r?.stoppedBy === "not_configured") {
          toast.error("Perplexity is not configured — vault-only lookup ran.");
        } else if ((r?.leadsEnqueued ?? 0) > 0) {
          toast.success(`Harvested buzz — ${r.summary ?? "leads queued for ingest."}`);
        } else {
          toast.success(`Investigated — ${r?.summary ?? "no new leads found."}`);
        }
        invalidate();
      },
      onError: (err) => {
        const e = err as unknown as { data?: { error?: string; message?: string } };
        toast.error(e?.data?.error ?? e?.data?.message ?? "Could not investigate this marker.");
        invalidate();
      },
    },
  });

  const dismiss = useDismissTrendMarker({
    mutation: {
      onSuccess: () => invalidate(),
      onError: () => toast.error("Could not dismiss this marker."),
    },
  });

  const items = data?.items ?? [];

  return (
    <>
      <Card className="p-4 mb-6">
        <h2 className="font-serif font-bold mb-1">Trend markers</h2>
        <p className="text-sm text-muted-foreground">
          Weak <span className="font-medium">social</span> signals (YouTube, Reddit, X, TikTok…)
          picked up during discovery. They measure public interest and velocity{" "}
          <span className="font-medium">only</span> — they are never fetched, chunked, or embedded,
          carry zero authority, and can never satisfy the evidence floor on their own. A marker
          becomes evidence only when you <span className="font-medium">escalate</span> it: its URL is
          queued for SSRF-safe ingest and verification.
        </p>
      </Card>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="flex gap-2 flex-wrap">
          {MARKER_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-3 py-1.5 rounded-full text-sm capitalize ${
                status === s
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm ml-auto">
          <span className="text-muted-foreground">Beat</span>
          <select
            className="border rounded-md px-2 py-1.5 text-sm bg-background min-w-[12rem]"
            value={beatSlug}
            onChange={(e) => setBeatSlug(e.target.value)}
          >
            <option value="">All beats</option>
            {(beatsData?.items ?? []).map((b) => (
              <option key={b.id} value={b.slug}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading markers…
        </div>
      ) : items.length === 0 ? (
        <div className="text-center text-muted-foreground py-12">
          <Activity className="h-8 w-8 mx-auto mb-2 opacity-40" />
          <p>No trend markers in this view.</p>
          <p className="text-sm">
            Social observations surface here as discovery runs. They influence cluster ranking
            (velocity) but never become evidence unless escalated.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((m: TrendMarker) => (
            <MarkerCard
              key={m.id}
              marker={m}
              onEscalate={() => escalate.mutate({ id: m.id })}
              onInvestigate={() => investigate.mutate({ id: m.id })}
              onDismiss={() => dismiss.mutate({ id: m.id })}
              escalating={escalate.isPending}
              investigating={investigate.isPending}
              dismissing={dismiss.isPending}
            />
          ))}
        </div>
      )}
    </>
  );
}

function MarkerCard({
  marker,
  onEscalate,
  onInvestigate,
  onDismiss,
  escalating,
  investigating,
  dismissing,
}: {
  marker: TrendMarker;
  onEscalate: () => void;
  onInvestigate: () => void;
  onDismiss: () => void;
  escalating: boolean;
  investigating: boolean;
  dismissing: boolean;
}) {
  const meta = MARKER_STATUS_META[marker.status] ?? {
    label: marker.status,
    tone: "bg-muted text-muted-foreground",
  };
  return (
    <Card className="p-4">
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className={`text-xs px-2 py-0.5 rounded-full ${meta.tone}`}>{meta.label}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground capitalize">
              {marker.platform}
            </span>
            {marker.beatSlug && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                {marker.beatSlug}
              </span>
            )}
            <span className="text-xs text-muted-foreground ml-auto">
              seen {marker.observationCount}× · last {format(new Date(marker.lastSeenAt), "MMM d")}
            </span>
          </div>

          <h3 className="font-medium leading-snug break-words">{marker.title || marker.url}</h3>
          {marker.snippet && (
            <p className="text-sm text-muted-foreground mt-1">{marker.snippet}</p>
          )}
          <a
            href={marker.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline inline-flex items-center gap-1 mt-1"
          >
            <ExternalLink className="h-3 w-3" />
            {marker.domain}
          </a>
          <p className="text-[11px] text-muted-foreground mt-1">
            Velocity signal only — zero authority, not chunked or embedded.
          </p>
          {marker.harvestSummary && (
            <p className="text-xs text-sky-700 mt-2 flex items-start gap-1">
              <FileSearch className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span className="break-words">{marker.harvestSummary}</span>
            </p>
          )}
        </div>

        <div className="flex flex-col items-stretch gap-1 shrink-0 w-32">
          {marker.status !== "escalated" && (
            <Button size="sm" disabled={escalating} onClick={onEscalate}>
              {escalating ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <ArrowUpRight className="h-4 w-4 mr-2" />
              )}
              Escalate
            </Button>
          )}
          {marker.status !== "dismissed" && (
            <Button
              size="sm"
              variant="outline"
              disabled={investigating}
              onClick={onInvestigate}
              title="Search Source Vault + Perplexity for real reporting on this buzz (never the social URL)."
            >
              {investigating ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <FileSearch className="h-4 w-4 mr-2" />
              )}
              Investigate
            </Button>
          )}
          {marker.status !== "dismissed" && (
            <Button size="sm" variant="ghost" disabled={dismissing} onClick={onDismiss}>
              <X className="h-4 w-4 mr-2" />
              Dismiss
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

// Aggregator / link-farm leads (MSN, Yahoo, Google News, Taboola, Outbrain,
// BuzzFeed…) dropped during discovery. Logged thin for transparency only — never
// ingested, never scored. Read-only.
function RejectedView() {
  const { data, isLoading } = useListRejectedSources(
    { limit: 200 },
    { query: { queryKey: getListRejectedSourcesQueryKey({ limit: 200 }) } },
  );
  const items = data?.items ?? [];

  return (
    <>
      <Card className="p-4 mb-6">
        <h2 className="font-serif font-bold mb-1">Rejected junk</h2>
        <p className="text-sm text-muted-foreground">
          Aggregator and link-farm leads (MSN, Yahoo, Google News, Taboola, Outbrain, BuzzFeed…)
          dropped during discovery. Logged here for transparency only — they are never fetched,
          ingested, or scored, and never enter a cluster or evidence packet.
        </p>
      </Card>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading rejected sources…
        </div>
      ) : items.length === 0 ? (
        <div className="text-center text-muted-foreground py-12">
          <Trash2 className="h-8 w-8 mx-auto mb-2 opacity-40" />
          <p>Nothing rejected yet.</p>
          <p className="text-sm">Junk aggregator leads dropped by discovery will appear here.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((r: RejectedSource) => (
            <Card key={r.id} className="p-3">
              <div className="flex items-start gap-3">
                <Trash2 className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm hover:underline break-words"
                  >
                    {r.url}
                  </a>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {r.domain} · {r.reason}
                    {r.beatSlug ? ` · ${r.beatSlug}` : ""} · seen {r.observationCount}× · last{" "}
                    {format(new Date(r.lastSeenAt), "MMM d")}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
