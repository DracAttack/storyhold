import {
  useListSourceFeeds,
  useCreateSourceFeed,
  useUpdateSourceFeed,
  useDeleteSourceFeed,
  usePollSourceFeedNow,
  useListCategories,
  getListSourceFeedsQueryKey,
  type SourceFeed,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SubBeatsPicker } from "@/components/admin/SubBeatsPicker";
import {
  Rss,
  Loader2,
  Plus,
  Trash2,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Pencil,
  X,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { format } from "date-fns";

// Keyword-filter terms are edited as a comma-separated string and stored as an
// array. Empty include list = allow all; an item is dropped if it matches any
// exclude term (case-insensitive substring on the item title + summary).
const parseTerms = (s: string): string[] =>
  s
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
const termsToString = (terms: string[] | null | undefined): string => (terms ?? []).join(", ");

// --- Known Source Watcher admin (Task #227) ------------------------------
// Register RSS/Atom feeds the newsroom watches, per beat (+ optional adjacent
// sub-beats). The cron polls due feeds (conditional GET), filters + dedupes
// items, and enqueues NEW items to the Source Vault ingest queue tagged
// discoveredVia="known_source". This page is the CRUD + per-feed health
// surface; "Poll now" forces an immediate poll.

function relative(dt?: string | null): string {
  if (!dt) return "—";
  try {
    return format(new Date(dt), "MMM d, HH:mm");
  } catch {
    return "—";
  }
}

const STATUS_META: Record<string, { label: string; className: string }> = {
  ok: { label: "OK", className: "bg-emerald-100 text-emerald-700" },
  not_modified: { label: "Unchanged", className: "bg-blue-100 text-blue-700" },
  error: { label: "Error", className: "bg-rose-100 text-rose-700" },
};

// Informational-only "purpose" label (Task #231): why a feed exists in the
// registry. Display-only — it never changes routing, scoring, or enqueueing.
type FeedPurpose = NonNullable<SourceFeed["purpose"]>;

const PURPOSE_META: Record<FeedPurpose, { label: string; hint: string; className: string }> = {
  primary: {
    label: "Primary",
    hint: "Core evidence feed for this beat.",
    className: "bg-indigo-100 text-indigo-700",
  },
  trend_sensor: {
    label: "Trend sensor",
    hint: "Fast-moving feed watched for developing-story velocity.",
    className: "bg-amber-100 text-amber-700",
  },
  idea_scout: {
    label: "Idea scout",
    hint: "Feed mined for story angles and fresh ideas.",
    className: "bg-fuchsia-100 text-fuchsia-700",
  },
  research_preprint: {
    label: "Research / preprint",
    hint: "Journal or preprint feed of new research.",
    className: "bg-cyan-100 text-cyan-700",
  },
  official_record: {
    label: "Official record",
    hint: "Government / agency / court release feed.",
    className: "bg-slate-200 text-slate-700",
  },
};

const PURPOSE_ORDER: FeedPurpose[] = [
  "primary",
  "trend_sensor",
  "idea_scout",
  "research_preprint",
  "official_record",
];

// Sentinel for the "no purpose" option (Select can't hold an empty string value).
const NO_PURPOSE = "__none__";

function HealthBadge({ feed }: { feed: SourceFeed }) {
  if (!feed.lastStatus) {
    return <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">Never polled</span>;
  }
  const meta = STATUS_META[feed.lastStatus] ?? { label: feed.lastStatus, className: "bg-muted text-muted-foreground" };
  return <span className={`text-xs px-2 py-0.5 rounded-full ${meta.className}`}>{meta.label}</span>;
}

function PurposeBadge({ purpose }: { purpose?: SourceFeed["purpose"] }) {
  if (!purpose) return null;
  const meta = PURPOSE_META[purpose as FeedPurpose];
  if (!meta) return null;
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${meta.className}`} title={meta.hint}>
      {meta.label}
    </span>
  );
}

export default function Feeds() {
  const qc = useQueryClient();
  const feedsQuery = useListSourceFeeds();
  const categoriesQuery = useListCategories();
  const beatOptions = categoriesQuery.data?.items ?? [];
  const feeds = feedsQuery.data?.items ?? [];

  const invalidate = () => qc.invalidateQueries({ queryKey: getListSourceFeedsQueryKey() });

  const createFeed = useCreateSourceFeed({
    mutation: {
      onSuccess: () => {
        toast.success("Feed added");
        setUrl("");
        setTitle("");
        setBeatSlug("");
        setSubBeats([]);
        setInterval(60);
        setPurpose(NO_PURPOSE);
        setFilterInclude("");
        setFilterExclude("");
        invalidate();
      },
      onError: (e) => toast.error((e as Error)?.message || "Could not add feed"),
    },
  });

  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [beatSlug, setBeatSlug] = useState("");
  const [subBeats, setSubBeats] = useState<string[]>([]);
  const [interval, setInterval] = useState(60);
  const [purpose, setPurpose] = useState<string>(NO_PURPOSE);
  const [filterInclude, setFilterInclude] = useState("");
  const [filterExclude, setFilterExclude] = useState("");

  const handleAdd = () => {
    if (!url.trim()) {
      toast.error("Enter a feed URL");
      return;
    }
    if (!beatSlug) {
      toast.error("Pick a beat");
      return;
    }
    createFeed.mutate({
      data: {
        url: url.trim(),
        title: title.trim() || null,
        beatSlug,
        subBeats,
        filterIncludeTerms: parseTerms(filterInclude),
        filterExcludeTerms: parseTerms(filterExclude),
        pollIntervalMinutes: interval,
        purpose: purpose === NO_PURPOSE ? null : (purpose as FeedPurpose),
      },
    });
  };

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Rss className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Feeds</h1>
          <p className="text-sm text-muted-foreground">
            Trusted RSS/Atom feeds the newsroom watches. New items feed the Source Vault ingest
            queue first; Perplexity fills the gaps for beats without a feed.
          </p>
        </div>
      </div>

      {/* Add a feed */}
      <Card className="p-4 space-y-4">
        <h2 className="font-semibold flex items-center gap-2">
          <Plus className="h-4 w-4" /> Add a feed
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="feed-url">Feed URL</Label>
            <Input
              id="feed-url"
              placeholder="https://example.com/feed.xml"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="feed-title">Label (optional)</Label>
            <Input
              id="feed-title"
              placeholder="Reuters World"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Beat</Label>
            <Select value={beatSlug} onValueChange={setBeatSlug}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a beat" />
              </SelectTrigger>
              <SelectContent>
                {beatOptions.map((b) => (
                  <SelectItem key={b.categorySlug} value={b.categorySlug}>
                    {b.category}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="feed-interval">Poll every (minutes)</Label>
            <Input
              id="feed-interval"
              type="number"
              min={5}
              max={10080}
              value={interval}
              onChange={(e) => setInterval(Number(e.target.value) || 60)}
            />
          </div>
          <div className="space-y-1">
            <Label>Purpose (optional)</Label>
            <Select value={purpose} onValueChange={setPurpose}>
              <SelectTrigger>
                <SelectValue placeholder="No purpose label" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PURPOSE}>No purpose label</SelectItem>
                {PURPOSE_ORDER.map((p) => (
                  <SelectItem key={p} value={p}>
                    {PURPOSE_META[p].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Informational only — never affects routing or scoring.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="feed-include">Only include if title matches (optional)</Label>
            <Input
              id="feed-include"
              placeholder="artificial intelligence, PFAS, cryptocurrency"
              value={filterInclude}
              onChange={(e) => setFilterInclude(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="feed-exclude">Exclude if title matches (optional)</Label>
            <Input
              id="feed-exclude"
              placeholder="correction, notice of meeting"
              value={filterExclude}
              onChange={(e) => setFilterExclude(e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Comma-separated keywords, matched case-insensitively against each item's title and
            summary. Leave "include" empty to accept everything; "exclude" always wins. Use this to
            narrow a broad feed to relevant topics.
          </p>
        </div>
        {beatSlug && (
          <SubBeatsPicker primarySlug={beatSlug} subBeats={subBeats} onChange={setSubBeats} />
        )}
        <Button onClick={handleAdd} disabled={createFeed.isPending}>
          {createFeed.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Add feed
        </Button>
      </Card>

      {/* Feed list */}
      <Card className="p-4">
        <h2 className="font-semibold mb-3">Registered feeds ({feeds.length})</h2>
        {feedsQuery.isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : feeds.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No feeds yet. Add one above to start watching a trusted source.
          </p>
        ) : (
          <div className="space-y-2">
            {feeds.map((feed) => (
              <FeedRow key={feed.id} feed={feed} beatOptions={beatOptions} onChanged={invalidate} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function FeedRow({
  feed,
  beatOptions,
  onChanged,
}: {
  feed: SourceFeed;
  beatOptions: { category: string; categorySlug: string }[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [beatSlug, setBeatSlug] = useState(feed.beatSlug);
  const [subBeats, setSubBeats] = useState<string[]>(feed.subBeats ?? []);
  const [interval, setInterval] = useState(feed.pollIntervalMinutes);
  const [purpose, setPurpose] = useState<string>(feed.purpose ?? NO_PURPOSE);
  const [filterInclude, setFilterInclude] = useState(termsToString(feed.filterIncludeTerms));
  const [filterExclude, setFilterExclude] = useState(termsToString(feed.filterExcludeTerms));

  const updateFeed = useUpdateSourceFeed({
    mutation: {
      onSuccess: () => {
        onChanged();
      },
      onError: (e) => toast.error((e as Error)?.message || "Could not update feed"),
    },
  });
  const deleteFeed = useDeleteSourceFeed({
    mutation: {
      onSuccess: () => {
        toast.success("Feed deleted");
        onChanged();
      },
      onError: (e) => toast.error((e as Error)?.message || "Could not delete feed"),
    },
  });
  const pollNow = usePollSourceFeedNow({
    mutation: {
      onSuccess: (out) => {
        if (out.status === "error") {
          toast.error(`Poll failed: ${out.error ?? "unknown error"}`);
        } else {
          toast.success(
            `Polled: ${out.itemsSeen} seen · ${out.itemsEnqueued} enqueued · ` +
              `${out.markersRecorded} markers · ${out.junkRejected} junk`,
          );
        }
        onChanged();
      },
      onError: (e) => toast.error((e as Error)?.message || "Poll failed"),
    },
  });

  const startEdit = () => {
    setBeatSlug(feed.beatSlug);
    setSubBeats(feed.subBeats ?? []);
    setInterval(feed.pollIntervalMinutes);
    setPurpose(feed.purpose ?? NO_PURPOSE);
    setFilterInclude(termsToString(feed.filterIncludeTerms));
    setFilterExclude(termsToString(feed.filterExcludeTerms));
    setEditing(true);
  };

  const saveEdit = () => {
    updateFeed.mutate(
      {
        id: feed.id,
        data: {
          beatSlug,
          subBeats,
          filterIncludeTerms: parseTerms(filterInclude),
          filterExcludeTerms: parseTerms(filterExclude),
          pollIntervalMinutes: interval,
          purpose: purpose === NO_PURPOSE ? null : (purpose as FeedPurpose),
        },
      },
      {
        onSuccess: () => {
          toast.success("Feed updated");
          setEditing(false);
        },
      },
    );
  };

  return (
    <div className="border rounded-md p-3 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium truncate">{feed.title || feed.url}</span>
            <HealthBadge feed={feed} />
            <PurposeBadge purpose={feed.purpose} />
            {feed.consecutiveFailures > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> {feed.consecutiveFailures} fails
              </span>
            )}
          </div>
          <a
            href={feed.url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1 truncate max-w-full"
          >
            {feed.url} <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
          <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-4 gap-y-1">
            <span>Beat: {feed.beatSlug}</span>
            {feed.subBeats && feed.subBeats.length > 0 && (
              <span>+{feed.subBeats.length} sub-beat{feed.subBeats.length > 1 ? "s" : ""}</span>
            )}
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" /> every {feed.pollIntervalMinutes}m
            </span>
            <span className="flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" /> {feed.itemCount} enqueued
            </span>
            <span>Last: {relative(feed.lastPolledAt)}</span>
            <span>Next: {relative(feed.nextPollAt)}</span>
          </div>
          {feed.lastPolledAt && (
            <div className="text-xs text-muted-foreground mt-1">
              Last poll: {feed.lastItemsSeen ?? 0} seen · {feed.lastItemsEnqueued ?? 0} enqueued ·{" "}
              {feed.lastMarkersRecorded ?? 0} markers · {feed.lastJunkRejected ?? 0} junk
            </div>
          )}
          {feed.lastError && (
            <p className="text-xs text-rose-600 mt-1 truncate">{feed.lastError}</p>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2">
            <Switch
              checked={feed.enabled}
              onCheckedChange={(checked) =>
                updateFeed.mutate({ id: feed.id, data: { enabled: checked } })
              }
            />
            <span className="text-xs text-muted-foreground">{feed.enabled ? "On" : "Off"}</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => pollNow.mutate({ id: feed.id })}
            disabled={pollNow.isPending}
          >
            <RefreshCw className={`h-4 w-4 ${pollNow.isPending ? "animate-spin" : ""}`} /> Poll
          </Button>
          <Button size="sm" variant="ghost" onClick={() => (editing ? setEditing(false) : startEdit())}>
            {editing ? <X className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (confirm("Delete this feed and its seen-item history?")) {
                deleteFeed.mutate({ id: feed.id });
              }
            }}
          >
            <Trash2 className="h-4 w-4 text-rose-600" />
          </Button>
        </div>
      </div>

      {editing && (
        <div className="border-t pt-3 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Beat</Label>
              <Select value={beatSlug} onValueChange={setBeatSlug}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a beat" />
                </SelectTrigger>
                <SelectContent>
                  {beatOptions.map((b) => (
                    <SelectItem key={b.categorySlug} value={b.categorySlug}>
                      {b.category}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`interval-${feed.id}`}>Poll every (minutes)</Label>
              <Input
                id={`interval-${feed.id}`}
                type="number"
                min={5}
                max={10080}
                value={interval}
                onChange={(e) => setInterval(Number(e.target.value) || 60)}
              />
            </div>
            <div className="space-y-1">
              <Label>Purpose (optional)</Label>
              <Select value={purpose} onValueChange={setPurpose}>
                <SelectTrigger>
                  <SelectValue placeholder="No purpose label" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PURPOSE}>No purpose label</SelectItem>
                  {PURPOSE_ORDER.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PURPOSE_META[p].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`include-${feed.id}`}>Only include if title matches</Label>
              <Input
                id={`include-${feed.id}`}
                placeholder="artificial intelligence, PFAS"
                value={filterInclude}
                onChange={(e) => setFilterInclude(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`exclude-${feed.id}`}>Exclude if title matches</Label>
              <Input
                id={`exclude-${feed.id}`}
                placeholder="correction, notice of meeting"
                value={filterExclude}
                onChange={(e) => setFilterExclude(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">
              Comma-separated keywords (case-insensitive, matched on title + summary). Empty
              "include" accepts everything; "exclude" always wins.
            </p>
          </div>
          <SubBeatsPicker primarySlug={beatSlug} subBeats={subBeats} onChange={setSubBeats} />
          <div className="flex gap-2">
            <Button size="sm" onClick={saveEdit} disabled={updateFeed.isPending}>
              {updateFeed.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save changes
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
