import { useState } from "react";
import {
  useListSocialQueue,
  useGetSocialQueueStatus,
  useTestSocialQueueConnection,
  useEnqueueSocialBackCatalog,
  useActivateSocialQueue,
  usePauseSocialQueue,
  useResumeSocialQueue,
  usePostSocialQueueItem,
  useSkipSocialQueueItem,
  usePauseSocialQueueItem,
  useResetSocialQueueItem,
  useRescheduleSocialQueueItem,
  useReorderSocialQueueItem,
  useEditSocialQueueCaption,
  useEditSocialQueueFields,
  useGenerateSocialQueueCaption,
  useWipeSocialQueue,
  useRegenerateAllSocialCaptions,
  usePostMemeNow,
  useRescheduleMeme,
  useUnqueueMeme,
  useRegenerateMemeSocialPack,
  getListSocialQueueQueryKey,
  getGetSocialQueueStatusQueryKey,
  getTestSocialQueueConnectionQueryKey,
  type SocialQueueItem,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Inbox,
  Send,
  SkipForward,
  Pause,
  Play,
  RotateCcw,
  CalendarClock,
  Sparkles,
  Plug,
  PlayCircle,
  ExternalLink,
  ArrowUp,
  ArrowDown,
  ListOrdered,
  History,
  CheckCircle2,
  XCircle,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

const STATUS_FILTERS = [
  "all",
  "draft",
  "ready",
  "queued",
  "scheduled",
  "posting",
  "skipped",
  "paused",
  "failed",
] as const;

// Facebook is the only connected platform — posting flows through Zernio → FB.
// Exposing platforms we can't actually post to produced queue items that
// silently never shipped, so the picker offers Facebook only.
const PLATFORM_OPTIONS = ["facebook"] as const;

function statusClasses(status: string): string {
  switch (status) {
    case "posted":
      return "bg-green-100 text-green-800 border-green-200";
    case "failed":
      return "bg-red-100 text-red-800 border-red-200";
    case "paused":
      return "bg-amber-100 text-amber-800 border-amber-200";
    case "skipped":
      return "bg-zinc-100 text-zinc-700 border-zinc-200";
    case "posting":
      return "bg-blue-100 text-blue-800 border-blue-200";
    case "scheduled":
      return "bg-violet-100 text-violet-800 border-violet-200";
    case "draft":
      return "bg-orange-100 text-orange-800 border-orange-200";
    case "ready":
      return "bg-teal-100 text-teal-800 border-teal-200";
    default:
      return "bg-sky-100 text-sky-800 border-sky-200";
  }
}

function activationReason(reason: string | undefined): string {
  switch (reason) {
    case "not_configured":
      return "Zernio is not configured (missing API key or account id).";
    case "connection_unverified":
      return "Connection unverified — run “Test connection” first.";
    case "no_approved_test_post":
      return "Post at least one item (an approved test post) before activating.";
    default:
      return "Cannot activate the queue yet.";
  }
}

function fmt(ts: string | null | undefined): string {
  if (!ts) return "—";
  try {
    return format(new Date(ts), "MMM d, yyyy HH:mm");
  } catch {
    return ts;
  }
}

export default function AdminSocialQueue() {
  const qc = useQueryClient();
  const [view, setView] = useState<"queue" | "history">("queue");
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [mediaFilter, setMediaFilter] = useState<"all" | "article" | "meme">("all");

  const { data: status } = useGetSocialQueueStatus();
  const { data: listData, isLoading } = useListSocialQueue(
    statusFilter === "all" ? { limit: 200 } : { status: statusFilter, limit: 200 },
  );
  // History = first-class success/failure views over the persisted queue rows
  // (queue rows retain postedAt / attemptCount / lastError / facebookPostUrl).
  const postedParams = { status: "posted", limit: 200 } as const;
  const failedParams = { status: "failed", limit: 200 } as const;
  const { data: postedData, isLoading: postedLoading } = useListSocialQueue(postedParams, {
    query: { queryKey: getListSocialQueueQueryKey(postedParams), enabled: view === "history" },
  });
  const { data: failedData, isLoading: failedLoading } = useListSocialQueue(failedParams, {
    query: { queryKey: getListSocialQueueQueryKey(failedParams), enabled: view === "history" },
  });
  const connection = useTestSocialQueueConnection({
    query: { queryKey: getTestSocialQueueConnectionQueryKey(), enabled: false },
  });

  const enqueue = useEnqueueSocialBackCatalog();
  const activate = useActivateSocialQueue();
  const pauseQueue = usePauseSocialQueue();
  const resumeQueue = useResumeSocialQueue();
  const postItem = usePostSocialQueueItem();
  const skipItem = useSkipSocialQueueItem();
  const pauseItem = usePauseSocialQueueItem();
  const resetItem = useResetSocialQueueItem();
  const reschedule = useRescheduleSocialQueueItem();
  const reorder = useReorderSocialQueueItem();
  const editCaption = useEditSocialQueueCaption();
  const editFields = useEditSocialQueueFields();
  const generateCaption = useGenerateSocialQueueCaption();
  const regenerateMemeCaption = useRegenerateMemeSocialPack();
  const wipe = useWipeSocialQueue();
  const regenAllCaptions = useRegenerateAllSocialCaptions();
  // Meme rows on the unified screen post / reschedule / unqueue through the meme
  // system's own endpoints (memes keep a separate table + posting cadence).
  const postMeme = usePostMemeNow();
  const rescheduleMemeItem = useRescheduleMeme();
  const unqueueMemeItem = useUnqueueMeme();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [captionDraft, setCaptionDraft] = useState("");
  const [fieldsId, setFieldsId] = useState<string | null>(null);
  const [fieldsDraft, setFieldsDraft] = useState({
    socialHook: "",
    articleSummary: "",
    callToAction: "",
    hashtags: "",
    platform: "facebook",
  });
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [scheduleDraft, setScheduleDraft] = useState("");

  const allItems = listData?.items ?? [];
  const items = allItems.filter((i) => {
    const t = i.mediaType === "meme" ? "meme" : "article";
    return mediaFilter === "all" || t === mediaFilter;
  });
  const counts = status?.counts;

  const isMeme = (item: SocialQueueItem) => item.mediaType === "meme";
  // Reorder is article-queue-only and operates on the article subset of the
  // (possibly meme-interleaved) list, so moving an article never targets a
  // projected meme row (memes have sortKey 0 and no real queue position).
  const articleRows = items.filter((i) => !isMeme(i));

  function invalidate() {
    qc.invalidateQueries({ queryKey: getListSocialQueueQueryKey() });
    qc.invalidateQueries({ queryKey: getGetSocialQueueStatusQueryKey() });
  }

  const handleConnectionTest = async () => {
    const { data } = await connection.refetch();
    if (!data) {
      toast.error("Connection test failed.");
      return;
    }
    if (!data.configured) {
      toast.error("Zernio is not configured (missing API key or account id).");
    } else if (data.found) {
      toast.success(
        `Connected${data.accountName ? ` — ${data.accountName}` : ""}${data.status ? ` (${data.status})` : ""}.`,
      );
    } else {
      toast.error(data.error ?? "Configured account was not found at Zernio.");
    }
  };

  const handleEnqueue = async () => {
    try {
      const res = await enqueue.mutateAsync();
      const memePart = res.memeReposts > 0 ? ` Queued ${res.memeReposts} meme repost(s).` : "";
      toast.success(
        `Enqueued ${res.added} new article(s). ${res.skippedExisting} already queued.${memePart}`,
      );
      invalidate();
    } catch {
      toast.error("Failed to enqueue back catalogue.");
    }
  };

  const handleActivate = async () => {
    try {
      const res = await activate.mutateAsync();
      if (res.activated) {
        toast.success("Queue activated — slots will now post automatically.");
        invalidate();
      } else {
        toast.error(activationReason(res.reason));
      }
    } catch (e: unknown) {
      const reason =
        e && typeof e === "object" && "reason" in e
          ? (e as { reason?: string }).reason
          : undefined;
      toast.error(activationReason(reason));
    }
  };

  const handlePauseResume = async () => {
    try {
      if (status?.paused) {
        await resumeQueue.mutateAsync();
        toast.success("Queue resumed.");
      } else {
        await pauseQueue.mutateAsync();
        toast.success("Queue paused.");
      }
      invalidate();
    } catch {
      toast.error("Failed to update queue state.");
    }
  };

  const handlePost = async (item: SocialQueueItem) => {
    if (isMeme(item)) {
      try {
        const res = await postMeme.mutateAsync({ id: item.id });
        if (res.status === "posted") {
          toast.success("Meme posted to Facebook.");
        } else {
          toast.error(res.error ?? `Post ${res.status}.`);
        }
        invalidate();
      } catch {
        toast.error("Failed to post meme.");
      }
      return;
    }
    try {
      const res = await postItem.mutateAsync({ id: item.id });
      if (res.status === "posted") {
        toast.success("Posted to Facebook.");
      } else if (res.status === "needs_caption") {
        toast.error("Generate a caption first.");
      } else if (res.status === "disabled") {
        toast.error("Zernio is not configured.");
      } else {
        toast.error(res.error ?? res.reason ?? `Post ${res.status}.`);
      }
      invalidate();
    } catch {
      toast.error("Failed to post item.");
    }
  };

  const handleSkip = async (item: SocialQueueItem) => {
    if (isMeme(item)) {
      try {
        await unqueueMemeItem.mutateAsync({ id: item.id });
        toast.success("Meme removed from queue.");
        invalidate();
      } catch {
        toast.error("Failed to remove meme.");
      }
      return;
    }
    try {
      await skipItem.mutateAsync({ id: item.id });
      invalidate();
    } catch {
      toast.error("Failed to skip item.");
    }
  };

  const handleItemPauseResume = async (item: SocialQueueItem) => {
    try {
      if (item.queueStatus === "paused") {
        await resetItem.mutateAsync({ id: item.id });
      } else {
        await pauseItem.mutateAsync({ id: item.id });
      }
      invalidate();
    } catch {
      toast.error("Failed to update item.");
    }
  };

  const handleReset = async (item: SocialQueueItem) => {
    try {
      await resetItem.mutateAsync({ id: item.id });
      invalidate();
    } catch {
      toast.error("Failed to reset item.");
    }
  };

  const handleGenerateCaption = async (item: SocialQueueItem) => {
    try {
      const res = await generateCaption.mutateAsync({ id: item.id });
      toast.success("Caption generated.");
      setEditingId(item.id);
      setCaptionDraft(res.caption);
      invalidate();
    } catch {
      toast.error("Caption generation is unavailable or turned off.");
    }
  };

  // Memes aren't rows in social_queue (they're projected from the meme table), so
  // their caption is regenerated through the meme system's own endpoint.
  const handleRegenerateMemeCaption = async (item: SocialQueueItem) => {
    try {
      await regenerateMemeCaption.mutateAsync({ id: item.memeId ?? item.id });
      toast.success("Caption regenerated.");
      invalidate();
    } catch {
      toast.error("Caption generation is unavailable or turned off.");
    }
  };

  const handleSaveCaption = async (item: SocialQueueItem) => {
    try {
      await editCaption.mutateAsync({ id: item.id, data: { caption: captionDraft.trim() } });
      toast.success("Caption saved.");
      setEditingId(null);
      invalidate();
    } catch {
      toast.error("Failed to save caption.");
    }
  };

  const openFieldsEditor = (item: SocialQueueItem) => {
    setFieldsId(item.id);
    setFieldsDraft({
      socialHook: item.socialHook ?? "",
      articleSummary: item.articleSummary ?? "",
      callToAction: item.callToAction ?? "",
      hashtags: (item.hashtags ?? []).join(" "),
      platform: item.platform || "facebook",
    });
  };

  const handleSaveFields = async (item: SocialQueueItem) => {
    const hashtags = fieldsDraft.hashtags
      .split(/[\s,]+/)
      .map((t) => t.replace(/^#/, "").trim())
      .filter(Boolean);
    try {
      await editFields.mutateAsync({
        id: item.id,
        data: {
          socialHook: fieldsDraft.socialHook.trim() || null,
          articleSummary: fieldsDraft.articleSummary.trim() || null,
          callToAction: fieldsDraft.callToAction.trim() || null,
          hashtags,
          platform: fieldsDraft.platform,
        },
      });
      toast.success("Fields saved.");
      setFieldsId(null);
      invalidate();
    } catch {
      toast.error("Failed to save fields.");
    }
  };

  const handleWipe = async () => {
    if (
      !window.confirm(
        "Wipe the queue? This permanently removes all non-posted items (drafts, ready, scheduled, failed). Posted history is preserved. This cannot be undone.",
      )
    ) {
      return;
    }
    try {
      const res = await wipe.mutateAsync();
      toast.success(`Wiped ${res.deleted} item(s).`);
      invalidate();
    } catch {
      toast.error("Failed to wipe queue.");
    }
  };

  const handleMove = async (item: SocialQueueItem, dir: "up" | "down") => {
    const idx = articleRows.findIndex((i) => i.id === item.id);
    if (idx < 0) return;
    const neighbor = dir === "up" ? articleRows[idx - 1] : articleRows[idx + 1];
    if (!neighbor) return;
    // Place the item just past its neighbour (relative key) so it survives
    // duplicate/zero default sortKeys and only ever moves one position.
    const sortKey = dir === "up" ? neighbor.sortKey - 1 : neighbor.sortKey + 1;
    try {
      await reorder.mutateAsync({ id: item.id, data: { sortKey } });
      invalidate();
    } catch {
      toast.error("Failed to reorder item.");
    }
  };

  const handleReschedule = async (item: SocialQueueItem) => {
    const iso = scheduleDraft ? new Date(scheduleDraft).toISOString() : null;
    if (isMeme(item)) {
      if (!iso) {
        toast.error("Pick a date and time to reschedule the meme.");
        return;
      }
      try {
        await rescheduleMemeItem.mutateAsync({ id: item.id, data: { scheduledAt: iso } });
        toast.success("Meme rescheduled.");
        setScheduleId(null);
        invalidate();
      } catch {
        toast.error("Failed to reschedule meme.");
      }
      return;
    }
    try {
      await reschedule.mutateAsync({ id: item.id, data: { scheduledAt: iso } });
      toast.success(iso ? "Rescheduled." : "Schedule cleared.");
      setScheduleId(null);
      invalidate();
    } catch {
      toast.error("Failed to reschedule.");
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Social Queue</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Drip the published back catalogue to Facebook — five Phoenix slots a day (8a, 11a, 2p,
          5p, 8p), one post per slot, rotating categories. Instant post-on-publish and the manual
          “Post to Facebook” button are unaffected.
        </p>
      </div>

      {/* Status + global controls */}
      <Card className="p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={
              status?.configured
                ? "bg-green-100 text-green-800 border-green-200"
                : "bg-red-100 text-red-800 border-red-200"
            }
          >
            {status?.configured ? "Zernio configured" : "Zernio not configured"}
          </Badge>
          <Badge
            variant="outline"
            className={
              status?.activated
                ? status.paused
                  ? "bg-amber-100 text-amber-800 border-amber-200"
                  : "bg-green-100 text-green-800 border-green-200"
                : "bg-zinc-100 text-zinc-700 border-zinc-200"
            }
          >
            {status?.activated ? (status.paused ? "Paused" : "Active") : "Dormant"}
          </Badge>
        </div>

        {counts && (
          <div className="grid grid-cols-3 sm:grid-cols-6 lg:grid-cols-11 gap-2 text-center">
            {(
              [
                ["Total", counts.total],
                ["Draft", counts.draft],
                ["Ready", counts.ready],
                ["Queued", counts.queued],
                ["Scheduled", counts.scheduled],
                ["Posting", counts.posting],
                ["Posted", counts.posted],
                ["Skipped", counts.skipped],
                ["Paused", counts.paused],
                ["Failed", counts.failed],
                ["No caption", counts.missingCaption],
              ] as const
            ).map(([label, n]) => (
              <div key={label} className="rounded-md border bg-muted/30 p-2">
                <div className="text-lg font-semibold">{n}</div>
                <div className="text-[11px] text-muted-foreground">{label}</div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={handleConnectionTest} disabled={connection.isFetching}>
            {connection.isFetching ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plug className="h-4 w-4 mr-2" />}
            Test connection
          </Button>
          <Button variant="outline" size="sm" onClick={handleEnqueue} disabled={enqueue.isPending}>
            {enqueue.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Inbox className="h-4 w-4 mr-2" />}
            Enqueue back catalogue
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                const res = await regenAllCaptions.mutateAsync();
                if (res.cleared > 0)
                  toast.success(`Cleared ${res.cleared} caption${res.cleared === 1 ? "" : "s"} — they'll regenerate with the new prompt on the next cron tick.`);
                else
                  toast.info("No pending captions to clear (items may already be fresh or have no caption yet).");
              } catch {
                toast.error("Failed to clear captions.");
              }
            }}
            disabled={regenAllCaptions.isPending}
            title="Clear stored captions for all pending items so they are regenerated with the current AI prompt"
          >
            {regenAllCaptions.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Regenerate all captions
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-red-600 hover:text-red-700"
            onClick={handleWipe}
            disabled={wipe.isPending}
          >
            {wipe.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}
            Wipe queue
          </Button>
          {!status?.activated ? (
            <Button size="sm" onClick={handleActivate} disabled={activate.isPending}>
              {activate.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <PlayCircle className="h-4 w-4 mr-2" />}
              Activate queue
            </Button>
          ) : (
            <Button
              variant={status.paused ? "default" : "outline"}
              size="sm"
              onClick={handlePauseResume}
              disabled={pauseQueue.isPending || resumeQueue.isPending}
            >
              {status.paused ? <Play className="h-4 w-4 mr-2" /> : <Pause className="h-4 w-4 mr-2" />}
              {status.paused ? "Resume queue" : "Pause queue"}
            </Button>
          )}
        </div>
        {!status?.activated && (
          <p className="text-xs text-muted-foreground">
            Activation requires a verified Zernio connection and at least one item already posted
            (an approved test post). Use “Post” on a single item to send your test post first.
          </p>
        )}
      </Card>

      {/* View toggle: live queue vs. posted/failed history */}
      <div className="flex items-center gap-2">
        <Button
          variant={view === "queue" ? "default" : "outline"}
          size="sm"
          onClick={() => setView("queue")}
        >
          <ListOrdered className="h-4 w-4 mr-1" /> Queue
        </Button>
        <Button
          variant={view === "history" ? "default" : "outline"}
          size="sm"
          onClick={() => setView("history")}
        >
          <History className="h-4 w-4 mr-1" /> History
        </Button>
      </div>

      {view === "queue" && (
        <>
          {/* Filter */}
          <div className="flex items-center gap-2">
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s === "all" ? "All statuses" : s.charAt(0).toUpperCase() + s.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={mediaFilter} onValueChange={(v) => setMediaFilter(v as typeof mediaFilter)}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="article">Articles</SelectItem>
                <SelectItem value="meme">Memes</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">{items.length} shown</span>
          </div>

      {/* List */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <Inbox className="h-8 w-8 mx-auto mb-2 opacity-50" />
          No items. Click “Enqueue back catalogue” to populate the queue.
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <Card key={item.id} className="p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className={statusClasses(item.queueStatus)}>
                      {item.queueStatus}
                    </Badge>
                    <Badge variant="outline">{item.category || "—"}</Badge>
                    <Badge variant="outline" className="capitalize">
                      {item.platform || "facebook"}
                    </Badge>
                    {item.mediaType && item.mediaType !== "article" && (
                      <Badge variant="outline" className="capitalize">
                        {item.mediaType}
                      </Badge>
                    )}
                    {item.postedViaOverride && (
                      <Badge
                        variant="outline"
                        className="border-amber-300 bg-amber-50 text-amber-700"
                        title="Force-posted by an admin, bypassing the normal slot/claim rules"
                      >
                        forced
                      </Badge>
                    )}
                    {item.attemptCount > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {item.attemptCount} failed attempt{item.attemptCount > 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  <a
                    href={item.articleUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium hover:underline inline-flex items-center gap-1 mt-1"
                  >
                    {item.articleTitle}
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Scheduled: {fmt(item.scheduledAt)}
                    {item.postedAt ? ` · Posted: ${fmt(item.postedAt)}` : ""}
                  </div>
                  {item.facebookPostUrl && (
                    <a
                      href={item.facebookPostUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1 mt-0.5"
                    >
                      View on Facebook <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {item.lastError && (
                    <div className="text-xs text-red-600 mt-1 break-words">{item.lastError}</div>
                  )}
                </div>
                {isMeme(item) && item.imageUrl && (
                  <img
                    src={item.imageUrl}
                    alt="Meme preview"
                    className="h-20 w-20 rounded-md border object-cover shrink-0"
                    loading="lazy"
                  />
                )}
              </div>

              {/* Caption */}
              {editingId === item.id ? (
                <div className="space-y-2">
                  <Textarea
                    value={captionDraft}
                    onChange={(e) => setCaptionDraft(e.target.value)}
                    rows={4}
                    placeholder="Facebook caption…"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => handleSaveCaption(item)} disabled={editCaption.isPending}>
                      Save caption
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="rounded-md bg-muted/40 p-3 text-sm whitespace-pre-wrap">
                  {item.caption ? (
                    item.caption
                  ) : (
                    <span className="text-muted-foreground italic">No caption yet.</span>
                  )}
                </div>
              )}

              {/* Structured snapshot fields */}
              {fieldsId === item.id ? (
                <div className="space-y-2 rounded-md border p-3">
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Social hook</label>
                    <Input
                      value={fieldsDraft.socialHook}
                      onChange={(e) => setFieldsDraft((d) => ({ ...d, socialHook: e.target.value }))}
                      placeholder="Scroll-stopping hook…"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Article summary</label>
                    <Textarea
                      value={fieldsDraft.articleSummary}
                      onChange={(e) => setFieldsDraft((d) => ({ ...d, articleSummary: e.target.value }))}
                      rows={2}
                      placeholder="One or two sentence summary…"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Call to action</label>
                    <Input
                      value={fieldsDraft.callToAction}
                      onChange={(e) => setFieldsDraft((d) => ({ ...d, callToAction: e.target.value }))}
                      placeholder="Read more, tap the link…"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">
                      Hashtags (space or comma separated)
                    </label>
                    <Input
                      value={fieldsDraft.hashtags}
                      onChange={(e) => setFieldsDraft((d) => ({ ...d, hashtags: e.target.value }))}
                      placeholder="science space discovery"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">Platform</label>
                    <Select
                      value={fieldsDraft.platform}
                      onValueChange={(v) => setFieldsDraft((d) => ({ ...d, platform: v }))}
                    >
                      <SelectTrigger className="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PLATFORM_OPTIONS.map((p) => (
                          <SelectItem key={p} value={p} className="capitalize">
                            {p}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => handleSaveFields(item)} disabled={editFields.isPending}>
                      Save fields
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setFieldsId(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                (item.socialHook || item.articleSummary || item.callToAction || (item.hashtags?.length ?? 0) > 0) && (
                  <div className="rounded-md border bg-muted/20 p-3 text-sm space-y-1">
                    {item.socialHook && (
                      <div>
                        <span className="text-xs font-medium text-muted-foreground">Hook: </span>
                        {item.socialHook}
                      </div>
                    )}
                    {item.articleSummary && (
                      <div>
                        <span className="text-xs font-medium text-muted-foreground">Summary: </span>
                        {item.articleSummary}
                      </div>
                    )}
                    {item.callToAction && (
                      <div>
                        <span className="text-xs font-medium text-muted-foreground">CTA: </span>
                        {item.callToAction}
                      </div>
                    )}
                    {(item.hashtags?.length ?? 0) > 0 && (
                      <div className="text-xs text-sky-700">
                        {item.hashtags!.map((t) => `#${t}`).join(" ")}
                      </div>
                    )}
                  </div>
                )
              )}

              {/* Reschedule editor */}
              {scheduleId === item.id && (
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1">
                      Scheduled time (local)
                    </label>
                    <Input
                      type="datetime-local"
                      value={scheduleDraft}
                      onChange={(e) => setScheduleDraft(e.target.value)}
                      className="w-56"
                    />
                  </div>
                  <Button size="sm" onClick={() => handleReschedule(item)} disabled={reschedule.isPending}>
                    Save
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setScheduleDraft("");
                      handleReschedule(item);
                    }}
                  >
                    Clear
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setScheduleId(null)}>
                    Cancel
                  </Button>
                </div>
              )}

              {/* Actions */}
              <div className="flex flex-wrap gap-2 pt-1 border-t">
                {/* Reorder, caption/field editing, generate-caption, pause and
                    reset are article-queue-only. Memes keep their own table and
                    posting cadence — they only get Post now / Reschedule / Skip. */}
                {!isMeme(item) && (
                  <div className="flex">
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-r-none border-r-0 px-2"
                      title="Move up"
                      onClick={() => handleMove(item, "up")}
                      disabled={reorder.isPending || articleRows[0]?.id === item.id}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-l-none px-2"
                      title="Move down"
                      onClick={() => handleMove(item, "down")}
                      disabled={reorder.isPending || articleRows[articleRows.length - 1]?.id === item.id}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                  </div>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handlePost(item)}
                  disabled={
                    (isMeme(item) ? postMeme.isPending : postItem.isPending) ||
                    item.queueStatus === "posted"
                  }
                >
                  <Send className="h-4 w-4 mr-1" /> Post now
                </Button>
                {isMeme(item) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRegenerateMemeCaption(item)}
                    disabled={
                      regenerateMemeCaption.isPending ||
                      item.queueStatus === "posted" ||
                      item.queueStatus === "posting"
                    }
                    title="Rewrite this meme's Facebook caption from the article"
                  >
                    <Sparkles className="h-4 w-4 mr-1" /> Generate caption
                  </Button>
                )}
                {!isMeme(item) && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditingId(item.id);
                        setCaptionDraft(item.caption ?? "");
                      }}
                    >
                      Edit caption
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openFieldsEditor(item)}>
                      Edit fields
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleGenerateCaption(item)}
                      disabled={generateCaption.isPending}
                    >
                      <Sparkles className="h-4 w-4 mr-1" /> Generate caption
                    </Button>
                  </>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setScheduleId(item.id);
                    setScheduleDraft("");
                  }}
                >
                  <CalendarClock className="h-4 w-4 mr-1" /> Reschedule
                </Button>
                {!isMeme(item) && (
                  <Button variant="outline" size="sm" onClick={() => handleItemPauseResume(item)}>
                    {item.queueStatus === "paused" ? (
                      <>
                        <Play className="h-4 w-4 mr-1" /> Unpause
                      </>
                    ) : (
                      <>
                        <Pause className="h-4 w-4 mr-1" /> Pause
                      </>
                    )}
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => handleSkip(item)}>
                  <SkipForward className="h-4 w-4 mr-1" /> {isMeme(item) ? "Remove" : "Skip"}
                </Button>
                {!isMeme(item) && (
                  <Button variant="ghost" size="sm" onClick={() => handleReset(item)}>
                    <RotateCcw className="h-4 w-4 mr-1" /> Reset
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
        </>
      )}

      {view === "history" && (
        <HistoryView
          posted={postedData?.items ?? []}
          failed={failedData?.items ?? []}
          loading={postedLoading || failedLoading}
        />
      )}
    </div>
  );
}

function HistoryRow({ item, kind }: { item: SocialQueueItem; kind: "posted" | "failed" }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border p-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {kind === "posted" ? (
            <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
          ) : (
            <XCircle className="h-4 w-4 text-red-600 shrink-0" />
          )}
          <Badge variant="outline">{item.category || "—"}</Badge>
          {item.postedViaOverride && (
            <Badge
              variant="outline"
              className="border-amber-300 bg-amber-50 text-amber-700"
              title="Force-posted by an admin, bypassing the normal slot/claim rules"
            >
              forced
            </Badge>
          )}
          {kind === "posted" && item.attemptCount > 1 && (
            <span className="text-xs text-muted-foreground">
              {item.attemptCount === 2 ? "2nd" : item.attemptCount === 3 ? "3rd" : `${item.attemptCount}th`} attempt
            </span>
          )}
          {kind === "failed" && item.attemptCount > 0 && (
            <span className="text-xs text-muted-foreground">{item.attemptCount} failed attempt{item.attemptCount > 1 ? "s" : ""}</span>
          )}
        </div>
        <a
          href={item.articleUrl}
          target="_blank"
          rel="noreferrer"
          className="font-medium hover:underline inline-flex items-center gap-1 mt-1"
        >
          {item.articleTitle}
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
        <div className="text-xs text-muted-foreground mt-0.5">
          {kind === "posted" ? `Posted: ${fmt(item.postedAt)}` : `Scheduled: ${fmt(item.scheduledAt)}`}
        </div>
        {item.facebookPostUrl && (
          <a
            href={item.facebookPostUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1 mt-0.5"
          >
            View on Facebook <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {item.lastError && (
          <div className="text-xs text-red-600 mt-1 break-words">{item.lastError}</div>
        )}
      </div>
    </div>
  );
}

function HistoryView({
  posted,
  failed,
  loading,
}: {
  posted: SocialQueueItem[];
  failed: SocialQueueItem[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const sortedPosted = [...posted].sort(
    (a, b) => new Date(b.postedAt ?? 0).getTime() - new Date(a.postedAt ?? 0).getTime(),
  );
  const sortedFailed = [...failed].sort(
    (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime(),
  );
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-green-600" />
          <h2 className="font-semibold">Posted ({sortedPosted.length})</h2>
        </div>
        {sortedPosted.length === 0 ? (
          <p className="text-sm text-muted-foreground">No posts yet.</p>
        ) : (
          <div className="space-y-2">
            {sortedPosted.map((item) => (
              <HistoryRow key={item.id} item={item} kind="posted" />
            ))}
          </div>
        )}
      </Card>
      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <XCircle className="h-5 w-5 text-red-600" />
          <h2 className="font-semibold">Failed ({sortedFailed.length})</h2>
        </div>
        {sortedFailed.length === 0 ? (
          <p className="text-sm text-muted-foreground">No failures.</p>
        ) : (
          <div className="space-y-2">
            {sortedFailed.map((item) => (
              <HistoryRow key={item.id} item={item} kind="failed" />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
