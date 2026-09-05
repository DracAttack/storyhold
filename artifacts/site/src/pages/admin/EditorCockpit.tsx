import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetEditorCockpit,
  getGetEditorCockpitQueryKey,
  useRejectCockpitCluster,
  usePromoteCockpitCluster,
  useBoostCockpitCluster,
  useSetClusterWatch,
  useListWatchedClusters,
  useMarkWatchedViewed,
  useResetClusterSignal,
} from "@workspace/api-client-react";
import type {
  CockpitCandidate,
  CockpitPacketItem,
  RejectCockpitClusterInput,
  PromoteCockpitClusterInputEditorialLabelOverride,
  StoryCluster,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, ClipboardList, ThumbsUp, ThumbsDown, ShieldAlert, FileText, Sparkles, Search, Tag, Eye, Bell, RotateCcw, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

type Surface = "candidate" | "packet" | "quarantine";
type RejectionReason = RejectCockpitClusterInput["reason"];

const REASON_OPTIONS: { value: RejectionReason; label: string }[] = [
  { value: "duplicate", label: "Duplicate — we already covered this" },
  { value: "boring", label: "Boring — no real hook" },
  { value: "weak_source", label: "Weak source — not authoritative enough" },
  { value: "bad_angle", label: "Bad angle — framing doesn't work" },
  { value: "too_late", label: "Too late — the moment has passed" },
  { value: "wrong_beat", label: "Wrong beat — off-brand for us" },
  { value: "bad_draft", label: "Bad draft — output quality too low" },
  { value: "legal_medical_political_risk", label: "Risk — legal / medical / political" },
];

const EDITORIAL_ANGLE_OPTIONS: { value: string; label: string }[] = [
  { value: "research_synthesis", label: "Research synthesis" },
  { value: "analysis", label: "Analysis" },
  { value: "explainer", label: "Explainer" },
  { value: "commentary", label: "Commentary" },
  { value: "original_reporting", label: "Original reporting" },
];

const DECISION_LABELS: Record<string, string> = {
  approve_draft: "Approve → draft",
  approve_research: "Approve → research",
  needs_human_editor: "Needs human editor",
  reject_duplicate: "Duplicate",
  reject_too_thin: "Too thin",
  reject_low_authority: "Low authority",
  reject_stale: "Stale",
  reject_out_of_beat: "Out of beat",
  reject_too_risky: "Too risky",
};

interface RejectTarget {
  clusterId: string;
  packetId: string | null;
  surface: Surface;
  label: string;
}

export default function EditorCockpit() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useGetEditorCockpit({
    query: { queryKey: getGetEditorCockpitQueryKey(), staleTime: 15000 },
  });

  // Watched stories — fetched separately so the mark-viewed stamp doesn't
  // require a full cockpit reload.
  const { data: watchedData, refetch: refetchWatched } = useListWatchedClusters();
  const watchedClusters: StoryCluster[] = watchedData?.items ?? [];
  const totalNew = watchedClusters.reduce((sum, c) => sum + (c.newDocsSinceViewed ?? 0), 0);

  const markViewed = useMarkWatchedViewed();

  // Stamp mark-viewed whenever there are unread signals so the badge resets.
  useEffect(() => {
    if (totalNew > 0) {
      markViewed.mutate(undefined, {
        onSuccess: () => refetchWatched(),
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalNew]);

  const [rejectTarget, setRejectTarget] = useState<RejectTarget | null>(null);
  const [reason, setReason] = useState<RejectionReason>("boring");
  const [editorialAngle, setEditorialAngle] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: getGetEditorCockpitQueryKey() });

  const promote = usePromoteCockpitCluster({
    mutation: {
      onSuccess: (res) => {
        toast.success(`Promoted for ${res.authorName} — added to the pipeline. The draft will appear in Drafts once the pipeline produces it.`);
        invalidate();
      },
      onError: (e: any) =>
        toast.error(e?.data?.error ?? e?.data?.message ?? "Could not promote this cluster."),
    },
  });

  const reject = useRejectCockpitCluster({
    mutation: {
      onSuccess: () => {
        toast.success("Rejected — recorded for the feedback loop.");
        setRejectTarget(null);
        invalidate();
      },
      onError: (e: any) =>
        toast.error(e?.data?.error ?? e?.data?.message ?? "Could not reject this cluster."),
    },
  });

  const [watchingId, setWatchingId] = useState<string | null>(null);
  const watchCluster = useSetClusterWatch({
    mutation: {
      onSuccess: (res) => {
        toast.success(res.watchedAt ? "Now watching this cluster for updates." : "Watch cleared.");
        invalidate();
      },
      onError: (e: any) =>
        toast.error(e?.data?.error ?? e?.data?.message ?? "Could not update watch."),
      onSettled: () => setWatchingId(null),
    },
  });

  const [resettingSignalId, setResettingSignalId] = useState<string | null>(null);
  const resetSignal = useResetClusterSignal({
    mutation: {
      onSuccess: () => {
        toast.success("Signal reset to pending — the next cron tick will retry.");
        refetchWatched();
      },
      onError: (e: any) =>
        toast.error(e?.data?.error ?? e?.data?.message ?? "Could not reset signal."),
      onSettled: () => setResettingSignalId(null),
    },
  });

  const doResetSignal = (clusterId: string) => {
    setResettingSignalId(clusterId);
    resetSignal.mutate({ id: clusterId });
  };

  const doWatch = (clusterId: string, currentlyWatched: boolean) => {
    setWatchingId(clusterId);
    watchCluster.mutate({ id: clusterId, data: { watched: !currentlyWatched } });
  };

  const [boostingId, setBoostingId] = useState<string | null>(null);
  const boost = useBoostCockpitCluster({
    mutation: {
      onSuccess: (res) => {
        if (res.promotable) toast.success(res.message);
        else if (res.added > 0) toast.info(res.message);
        else toast.warning(res.message);
        invalidate();
      },
      onError: (e: any) =>
        toast.error(e?.data?.error ?? e?.data?.message ?? "Source search failed."),
      onSettled: () => setBoostingId(null),
    },
  });

  const doBoost = (clusterId: string) => {
    setBoostingId(clusterId);
    boost.mutate({ data: { clusterId } });
  };

  const doPromote = (clusterId: string, packetId: string | null, surface: Surface) => {
    promote.mutate({
      data: {
        clusterId,
        packetId,
        surface,
        ...(editorialAngle ? { editorialLabelOverride: editorialAngle as PromoteCockpitClusterInputEditorialLabelOverride } : {}),
      },
    });
  };

  const openReject = (t: RejectTarget) => {
    setReason("boring");
    setRejectTarget(t);
  };

  const confirmReject = () => {
    if (!rejectTarget) return;
    reject.mutate({
      data: {
        clusterId: rejectTarget.clusterId,
        packetId: rejectTarget.packetId,
        surface: rejectTarget.surface,
        reason,
      },
    });
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="font-serif text-3xl font-bold flex items-center gap-2">
          <ClipboardList className="h-7 w-7 text-primary" /> Editor cockpit
        </h1>
        <p className="text-muted-foreground text-sm mt-1 max-w-2xl">
          Today's highest-signal candidates and evidence packets, with a deterministic read
          on why each matters. Promote into the draft funnel or reject with one click — no
          new AI runs here, and nothing auto-publishes.
        </p>
      </div>

      <div className="flex items-center gap-2 p-3 rounded-lg border bg-muted/40 text-sm">
        <Tag className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-muted-foreground shrink-0">Draft angle for next promote:</span>
        <Select value={editorialAngle ?? "__none__"} onValueChange={(v) => setEditorialAngle(v === "__none__" ? null : v)}>
          <SelectTrigger className="h-7 w-auto min-w-[160px] text-xs bg-background">
            <SelectValue placeholder="AI chooses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">AI chooses</SelectItem>
            {EDITORIAL_ANGLE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {editorialAngle && (
          <button
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setEditorialAngle(null)}
            title="Clear — let AI choose"
          >
            ✕ clear
          </button>
        )}
      </div>

      {isError ? (
        <Card className="p-8 text-center text-muted-foreground">Could not load the cockpit.</Card>
      ) : isLoading || !data ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin" />
        </div>
      ) : (
        <div className="space-y-8">
          {/* Watched Stories */}
          {watchedClusters.length > 0 && (
            <section>
              <h2 className="font-semibold text-sm mb-3 flex items-center gap-2">
                <Bell className="h-4 w-4 text-blue-500" /> Watched stories
                <span className="text-muted-foreground font-normal">({watchedClusters.length})</span>
                {totalNew > 0 && (
                  <Badge variant="secondary" className="bg-blue-500/15 text-blue-600 border-0 text-[10px] px-1.5 py-0">
                    {totalNew} new
                  </Badge>
                )}
              </h2>
              <div className="space-y-2">
                {watchedClusters.map((cluster) => (
                  <WatchedClusterRow
                    key={cluster.id}
                    cluster={cluster}
                    watching={false}
                    onUnwatch={() => {
                      const mutation = watchCluster;
                      setWatchingId(cluster.id);
                      mutation.mutate(
                        { id: cluster.id, data: { watched: false } },
                        { onSettled: () => { setWatchingId(null); refetchWatched(); } },
                      );
                    }}
                    unwatching={watchingId === cluster.id && watchCluster.isPending}
                    onResetSignal={() => doResetSignal(cluster.id)}
                    resettingSignal={resettingSignalId === cluster.id && resetSignal.isPending}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Top candidates */}
          <section>
            <h2 className="font-semibold text-sm mb-3 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> Top candidates
              <span className="text-muted-foreground font-normal">({data.topCandidates.length})</span>
            </h2>
            {data.topCandidates.length === 0 ? (
              <Card className="p-6 text-center text-sm text-muted-foreground">
                No open candidates right now.
              </Card>
            ) : (
              <div className="space-y-3">
                {data.topCandidates.map((c) => (
                  <CandidateCard
                    key={c.clusterId}
                    c={c}
                    busy={promote.isPending || reject.isPending}
                    boosting={boostingId === c.clusterId}
                    boostDisabled={boost.isPending}
                    watching={watchingId === c.clusterId}
                    watchDisabled={watchCluster.isPending}
                    onBoost={() => doBoost(c.clusterId)}
                    onWatch={() => doWatch(c.clusterId, c.watched)}
                    onPromote={() => doPromote(c.clusterId, null, "candidate")}
                    onReject={() =>
                      openReject({ clusterId: c.clusterId, packetId: null, surface: "candidate", label: c.label })
                    }
                  />
                ))}
              </div>
            )}
          </section>

          {/* Top evidence packets */}
          <section>
            <h2 className="font-semibold text-sm mb-3 flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" /> Top evidence packets
              <span className="text-muted-foreground font-normal">({data.topPackets.length})</span>
            </h2>
            {data.topPackets.length === 0 ? (
              <Card className="p-6 text-center text-sm text-muted-foreground">
                No approved packets waiting.
              </Card>
            ) : (
              <div className="space-y-3">
                {data.topPackets.map((p) => (
                  <PacketCard
                    key={p.packetId}
                    p={p}
                    busy={promote.isPending || reject.isPending}
                    onPromote={() => doPromote(p.clusterId, p.packetId, "packet")}
                    onReject={() =>
                      openReject({ clusterId: p.clusterId, packetId: p.packetId, surface: "packet", label: p.label })
                    }
                  />
                ))}
              </div>
            )}
          </section>

          {/* Quarantine queue */}
          <section>
            <h2 className="font-semibold text-sm mb-3 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-500" /> Quarantine queue
              <span className="text-muted-foreground font-normal">({data.quarantineQueue.length})</span>
            </h2>
            {data.quarantineQueue.length === 0 ? (
              <Card className="p-6 text-center text-sm text-muted-foreground">
                Nothing in quarantine.
              </Card>
            ) : (
              <div className="space-y-3">
                {data.quarantineQueue.map((p) => (
                  <PacketCard
                    key={p.packetId}
                    p={p}
                    quarantine
                    busy={promote.isPending || reject.isPending}
                    boosting={boostingId === p.clusterId}
                    boostDisabled={boost.isPending}
                    onBoost={() => doBoost(p.clusterId)}
                    onPromote={() => doPromote(p.clusterId, p.packetId, "quarantine")}
                    onReject={() =>
                      openReject({ clusterId: p.clusterId, packetId: p.packetId, surface: "quarantine", label: p.label })
                    }
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* Reject dialog */}
      <Dialog open={!!rejectTarget} onOpenChange={(open) => { if (!open) setRejectTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject candidate</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground -mt-1">{rejectTarget?.label}</p>
          <div className="py-2">
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Reason (recorded for the feedback loop)
            </label>
            <Select value={reason} onValueChange={(v) => setReason(v as RejectionReason)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {REASON_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmReject} disabled={reject.isPending}>
              {reject.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Watched Cluster Row ────────────────────────────────────────────────────

const SIGNAL_STATUS_LABELS: Record<string, string> = {
  pending: "Signal pending",
  consumed: "Signal consumed",
  exhausted: "Signal exhausted",
};

function SignalStatusBadge({ status }: { status: string }) {
  if (status === "exhausted") {
    return (
      <Badge variant="secondary" className="bg-amber-500/15 text-amber-700 border-0 text-[10px] px-1.5 py-0 shrink-0 flex items-center gap-1">
        <AlertTriangle className="h-2.5 w-2.5" />
        Exhausted
      </Badge>
    );
  }
  if (status === "consumed") {
    return (
      <Badge variant="secondary" className="bg-green-500/15 text-green-700 border-0 text-[10px] px-1.5 py-0 shrink-0">
        Consumed
      </Badge>
    );
  }
  if (status === "pending") {
    return (
      <Badge variant="secondary" className="bg-blue-500/15 text-blue-600 border-0 text-[10px] px-1.5 py-0 shrink-0">
        Pending
      </Badge>
    );
  }
  return null;
}

function WatchedClusterRow({
  cluster,
  onUnwatch,
  unwatching,
  onResetSignal,
  resettingSignal,
}: {
  cluster: StoryCluster;
  watching: boolean;
  onUnwatch: () => void;
  unwatching: boolean;
  onResetSignal: () => void;
  resettingSignal: boolean;
}) {
  const hasNew = (cluster.newDocsSinceViewed ?? 0) > 0;
  const signalStatus = cluster.signalStatus ?? null;
  const isExhausted = signalStatus === "exhausted";
  const retryCount = cluster.signalRetryCount ?? null;
  const trackType = cluster.signalTrackType ?? null;

  return (
    <Card className={`p-3 flex items-start gap-3 ${isExhausted ? "border-amber-300/60 bg-amber-50/30 dark:border-amber-700/40 dark:bg-amber-950/10" : ""}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium truncate">{cluster.label}</span>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">{cluster.beat}</Badge>
          {hasNew && (
            <Badge variant="secondary" className="bg-blue-500/15 text-blue-600 border-0 text-[10px] px-1.5 py-0 shrink-0">
              {cluster.newDocsSinceViewed} new
            </Badge>
          )}
          {signalStatus && <SignalStatusBadge status={signalStatus} />}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
          {cluster.watchedAt && (
            <p className="text-[11px] text-muted-foreground">
              Watching since {new Date(cluster.watchedAt).toLocaleDateString()}
            </p>
          )}
          {signalStatus && (
            <p className="text-[11px] text-muted-foreground">
              {SIGNAL_STATUS_LABELS[signalStatus] ?? signalStatus}
              {trackType && ` · ${trackType}`}
              {retryCount !== null && retryCount > 0 && ` · ${retryCount} ${retryCount === 1 ? "retry" : "retries"}`}
              {cluster.signalLastSignalAt && ` · ${new Date(cluster.signalLastSignalAt).toLocaleDateString()}`}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {(isExhausted || signalStatus === "consumed") && (
          <Button
            size="sm"
            variant="ghost"
            className={`h-7 px-2 text-xs ${isExhausted ? "text-amber-700 hover:text-amber-900 hover:bg-amber-100 dark:text-amber-400 dark:hover:bg-amber-900/30" : "text-muted-foreground hover:text-foreground"}`}
            onClick={onResetSignal}
            disabled={resettingSignal}
            title="Reset signal to pending — the next cron tick will retry"
          >
            {resettingSignal ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
            <span className="ml-1">Reset</span>
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground h-7 px-2 text-xs"
          onClick={onUnwatch}
          disabled={unwatching}
          title="Stop watching this story"
        >
          {unwatching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
          <span className="ml-1">Unwatch</span>
        </Button>
      </div>
    </Card>
  );
}

// ─── Action Row ─────────────────────────────────────────────────────────────

function ActionRow({
  busy,
  onPromote,
  onReject,
  promoteDisabled,
  promoteTitle,
  onBoost,
  boosting,
  boostDisabled,
}: {
  busy: boolean;
  onPromote: () => void;
  onReject: () => void;
  promoteDisabled?: boolean;
  promoteTitle?: string;
  // When provided, a "Find sources" button is shown (offered on items that
  // can't be promoted yet). Runs a targeted source search + re-screen.
  onBoost?: () => void;
  boosting?: boolean;
  boostDisabled?: boolean;
}) {
  return (
    <div className="flex gap-2 shrink-0">
      {onBoost && (
        <Button
          size="sm"
          variant="secondary"
          onClick={onBoost}
          disabled={busy || boostDisabled}
          title="Search the web for stronger sources on this subject, ingest what passes muster, and re-screen it toward promotion."
        >
          {boosting ? (
            <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
          ) : (
            <Search className="h-4 w-4 mr-1.5" />
          )}
          {boosting ? "Searching…" : "Find sources"}
        </Button>
      )}
      <Button
        size="sm"
        onClick={onPromote}
        disabled={busy || promoteDisabled}
        title={promoteTitle}
      >
        <ThumbsUp className="h-4 w-4 mr-1.5" /> Promote
      </Button>
      <Button size="sm" variant="outline" onClick={onReject} disabled={busy}>
        <ThumbsDown className="h-4 w-4 mr-1.5" /> Reject
      </Button>
    </div>
  );
}

function CandidateCard({
  c,
  busy,
  onPromote,
  onReject,
  onBoost,
  boosting,
  boostDisabled,
  onWatch,
  watching,
  watchDisabled,
}: {
  c: CockpitCandidate;
  busy: boolean;
  onPromote: () => void;
  onReject: () => void;
  onBoost: () => void;
  boosting: boolean;
  boostDisabled: boolean;
  onWatch: () => void;
  watching: boolean;
  watchDisabled: boolean;
}) {
  // A cluster can only be promoted once its latest evidence packet cleared
  // screening as approve_draft or needs_human_editor — mirror the server guard
  // so we never offer a Promote that is guaranteed to 409.
  const canPromote =
    c.latestDecision === "approve_draft" || c.latestDecision === "needs_human_editor";
  const screenLabel = !c.hasPacket
    ? "Not screened yet"
    : (DECISION_LABELS[c.latestDecision ?? ""] ?? c.latestDecision ?? "Screened");
  const promoteTitle = canPromote
    ? undefined
    : !c.hasPacket
      ? "Not screened yet — run editorial screening before promoting this into the draft funnel."
      : `Screened as “${screenLabel}” — only an approved story can be promoted to a draft. Reject it or wait for a fresh screen.`;
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <Badge variant="secondary" className="text-[11px]">{c.beat}</Badge>
            <Badge variant="outline" className="text-[11px]">Score {c.score}/100</Badge>
            <Badge
              variant={canPromote ? "default" : "outline"}
              className="text-[11px]"
            >
              {screenLabel}
            </Badge>
          </div>
          <div className="font-medium leading-snug">{c.estimatedAngle}</div>
          <p className="text-xs text-muted-foreground mt-1">{c.whyThisMatters}</p>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            className={`text-xs h-7 px-2 ${c.watched ? "text-blue-600 hover:text-blue-700" : "text-muted-foreground hover:text-primary"}`}
            onClick={onWatch}
            disabled={watching || watchDisabled}
            title={c.watched ? "Currently watching — click to stop watching this cluster" : "Watch this cluster for development updates"}
          >
            {watching ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Eye className={`h-3 w-3 mr-1 ${c.watched ? "fill-blue-600/20" : ""}`} />}
            {c.watched ? "Watching" : "Watch"}
          </Button>
          <ActionRow
            busy={busy}
            onPromote={onPromote}
            onReject={onReject}
            promoteDisabled={!canPromote}
            promoteTitle={promoteTitle}
            onBoost={canPromote ? undefined : onBoost}
            boosting={boosting}
            boostDisabled={boostDisabled}
          />
        </div>
      </div>
    </Card>
  );
}

function PacketCard({
  p,
  quarantine,
  busy,
  onPromote,
  onReject,
  onBoost,
  boosting,
  boostDisabled,
}: {
  p: CockpitPacketItem;
  quarantine?: boolean;
  busy: boolean;
  onPromote: () => void;
  onReject: () => void;
  // Boost is offered on quarantined packets (not the already-approved top packets).
  onBoost?: () => void;
  boosting?: boolean;
  boostDisabled?: boolean;
}) {
  return (
    <Card className={`p-4 ${quarantine ? "border-amber-500/30 bg-amber-500/5" : ""}`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <Badge variant="secondary" className="text-[11px]">{p.beat}</Badge>
            <Badge variant="outline" className="text-[11px]">{DECISION_LABELS[p.decision] ?? p.decision}</Badge>
            <Badge variant="outline" className="text-[11px]">v{p.version}</Badge>
            {p.stalePacket && (
              <Badge variant="outline" className="text-[11px] border-amber-400/60 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300 gap-1">
                <ShieldAlert className="h-3 w-3" /> Source retracted
              </Badge>
            )}
          </div>
          <div className="font-medium leading-snug">{p.estimatedAngle}</div>
          <p className="text-xs text-muted-foreground mt-1">{p.whyThisMatters}</p>
          {p.stalePacket && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              One or more evidence sources have been retracted or made unavailable. Re-screen before promoting.
            </p>
          )}
          {p.doNotDraftReason && (
            <p className="text-xs text-amber-600 dark:text-amber-500 mt-1">{p.doNotDraftReason}</p>
          )}
        </div>
        <ActionRow
          busy={busy}
          onPromote={onPromote}
          onReject={onReject}
          onBoost={onBoost}
          boosting={boosting}
          boostDisabled={boostDisabled}
        />
      </div>
    </Card>
  );
}
