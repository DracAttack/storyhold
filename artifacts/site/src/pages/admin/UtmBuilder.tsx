import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient, keepPreviousData } from "@tanstack/react-query";
import {
  useListUtmPresets,
  useCreateUtmPreset,
  useDeleteUtmPreset,
  getListUtmPresetsQueryKey,
  useGetShareReport,
  getGetShareReportQueryKey,
  type UtmPreset,
} from "@workspace/api-client-react";
import { getSiteOrigin } from "@/lib/seo";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Copy,
  Check,
  Link2,
  Info,
  Star,
  Trash2,
  History,
  Bookmark,
  Loader2,
  TrendingUp,
  PlusCircle,
} from "lucide-react";
import { toast } from "sonner";

const FIELDS: { key: "source" | "medium" | "campaign" | "content"; label: string; placeholder: string; hint: string }[] = [
  { key: "source", label: "Campaign source", placeholder: "reddit", hint: "Where the link is posted: reddit, facebook, newsletter, twitter…" },
  { key: "medium", label: "Campaign medium", placeholder: "social", hint: "The channel type: social, email, cpc, referral…" },
  { key: "campaign", label: "Campaign name", placeholder: "2026-q2-launch", hint: "A name to group this push: 2026-q2-launch, weekly-roundup…" },
  { key: "content", label: "Campaign content (optional)", placeholder: "hero-link", hint: "Distinguish two links in the same post: hero-link, footer-link…" },
];

// Recent-link history stays in localStorage on purpose — it's personal to one
// editor's session, not a shared team resource like the presets.
const HISTORY_KEY = "brainhook.utm.history.v1";
const HISTORY_LIMIT = 10;

type HistoryEntry = {
  url: string;
  createdAt: number;
};

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function buildTaggedUrl(base: string, params: Record<string, string>): string {
  let url: URL;
  try {
    url = new URL(base.trim());
  } catch {
    return "";
  }
  const map: Record<string, string> = {
    source: "utm_source",
    medium: "utm_medium",
    campaign: "utm_campaign",
    content: "utm_content",
  };
  for (const [key, utm] of Object.entries(map)) {
    const value = params[key]?.trim();
    if (value) url.searchParams.set(utm, value);
  }
  return url.toString();
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Trending-shares range toggle — mirrors the windows the Shares report page uses
// so editors see the same rankings in both places.
type RangeKey = "7" | "30" | "90" | "all";

const RANGES: { key: RangeKey; label: string; days: number | null }[] = [
  { key: "7", label: "Last 7 days", days: 7 },
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 90 days", days: 90 },
  { key: "all", label: "All time", days: null },
];

const DAY_MS = 86400000;

// Start of today in UTC, as ms.
function utcTodayStartMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

// Map a tracked content identifier (article slug or the explicit "home" page
// key) to its full public URL on the canonical site origin.
function publicUrlForSlug(slug: string): string {
  const origin = getSiteOrigin();
  if (slug === "home") return `${origin}/`;
  return `${origin}/article/${slug}`;
}

// A reader-share link tagged with the site's standard share UTM scheme
// (utm_medium=social, utm_campaign=social_share, utm_content=<slug>) and a
// sensible default source matching the in-article "Copy link" button.
const DEFAULT_SHARE_SOURCE = "copy";

function shareTaggedUrl(slug: string): string {
  const url = new URL(publicUrlForSlug(slug));
  url.searchParams.set("utm_source", DEFAULT_SHARE_SOURCE);
  url.searchParams.set("utm_medium", "social");
  url.searchParams.set("utm_campaign", "social_share");
  url.searchParams.set("utm_content", slug);
  return url.toString();
}

export default function AdminUtmBuilder() {
  const [base, setBase] = useState("");
  const [values, setValues] = useState<Record<string, string>>({ source: "", medium: "", campaign: "", content: "" });
  const [copied, setCopied] = useState(false);

  const qc = useQueryClient();
  const { data: presetsData, isLoading: presetsLoading } = useListUtmPresets();
  const presets = presetsData?.items ?? [];
  const invalidatePresets = () => qc.invalidateQueries({ queryKey: getListUtmPresetsQueryKey() });
  const createPreset = useCreateUtmPreset({
    mutation: {
      onSuccess: () => invalidatePresets(),
      onError: () => toast.error("Couldn't save the preset — try again."),
    },
  });
  const deletePresetMut = useDeleteUtmPreset({
    mutation: {
      onSuccess: () => invalidatePresets(),
      onError: () => toast.error("Couldn't delete the preset — try again."),
    },
  });

  const [history, setHistory] = useState<HistoryEntry[]>(() => loadJson<HistoryEntry[]>(HISTORY_KEY, []));

  const [saveOpen, setSaveOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  // Trending shared articles, sourced from the same admin share report the
  // Shares page uses (no new endpoint). The range toggle re-queries the report
  // with a [from, to) UTC window, matching that page's date math.
  const [range, setRange] = useState<RangeKey>("30");
  const baseInputRef = useRef<HTMLInputElement>(null);

  const selectedRange = RANGES.find((r) => r.key === range) ?? RANGES[1];
  const { from, to } = useMemo(() => {
    const todayStart = utcTodayStartMs();
    const toMs = todayStart + DAY_MS;
    if (selectedRange.days === null) return { from: undefined, to: undefined as string | undefined };
    const fromMs = todayStart - (selectedRange.days - 1) * DAY_MS;
    return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
  }, [selectedRange.days]);

  const { data: shareReport, isLoading: shareReportLoading, isFetching: shareReportFetching } =
    useGetShareReport(
      { from, to },
      { query: { placeholderData: keepPreviousData, queryKey: getGetShareReportQueryKey({ from, to }) } },
    );

  const trending = shareReport?.byArticle ?? [];

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      /* ignore quota / unavailable storage */
    }
  }, [history]);

  const tagged = useMemo(() => buildTaggedUrl(base, values), [base, values]);
  const baseLooksValid = useMemo(() => {
    if (!base.trim()) return null;
    try {
      new URL(base.trim());
      return true;
    } catch {
      return false;
    }
  }, [base]);

  const canCopy = tagged.length > 0 && Boolean(values.source.trim()) && Boolean(values.medium.trim()) && Boolean(values.campaign.trim());
  const canSavePreset = Boolean(values.source.trim()) && Boolean(values.medium.trim()) && Boolean(values.campaign.trim());

  const recordHistory = (url: string) => {
    setHistory((prev) => {
      const next = [{ url, createdAt: Date.now() }, ...prev.filter((h) => h.url !== url)];
      return next.slice(0, HISTORY_LIMIT);
    });
  };

  const handleCopy = async () => {
    if (!canCopy) return;
    try {
      await navigator.clipboard.writeText(tagged);
      setCopied(true);
      recordHistory(tagged);
      toast.success("Tagged link copied to clipboard.");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy — select the link and copy manually.");
    }
  };

  const handleCopyExisting = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      recordHistory(url);
      toast.success("Link copied to clipboard.");
      window.setTimeout(() => setCopiedUrl((cur) => (cur === url ? null : cur)), 2000);
    } catch {
      toast.error("Couldn't copy — select the link and copy manually.");
    }
  };

  // One-tap copy of a trending article's ready, tagged share link.
  const handleCopyTrending = async (slug: string) => {
    await handleCopyExisting(shareTaggedUrl(slug));
  };

  // Fill the Article URL field with the trending article's public URL, then
  // scroll the builder into view and focus the field so the editor can
  // immediately set source / medium / campaign and copy.
  const handleLoadIntoBuilder = (slug: string) => {
    setBase(publicUrlForSlug(slug));
    requestAnimationFrame(() => {
      baseInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      baseInputRef.current?.focus();
    });
    toast.success("Loaded into the builder — set your source, medium, and campaign.");
  };

  const openSaveDialog = () => {
    if (!canSavePreset) return;
    setPresetName(values.campaign.trim());
    setSaveOpen(true);
  };

  const handleSavePreset = () => {
    const name = presetName.trim();
    if (!name) {
      toast.error("Give the preset a name.");
      return;
    }
    createPreset.mutate(
      {
        data: {
          name,
          source: values.source.trim(),
          medium: values.medium.trim(),
          campaign: values.campaign.trim(),
        },
      },
      {
        onSuccess: () => {
          setSaveOpen(false);
          toast.success(`Saved preset "${name}".`);
        },
      },
    );
  };

  const applyPreset = (preset: UtmPreset) => {
    setValues((v) => ({ ...v, source: preset.source, medium: preset.medium, campaign: preset.campaign }));
    toast.success(`Applied preset "${preset.name}".`);
  };

  const deletePreset = (id: string) => {
    deletePresetMut.mutate({ id });
  };

  const clearHistory = () => setHistory([]);

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-3xl">
      <div>
        <h1 className="font-serif text-3xl font-bold">UTM link builder</h1>
        <p className="text-muted-foreground mt-1">
          Build a tagged link so Google Analytics can tell you exactly where a visit came from.
        </p>
      </div>

      <Card className="p-4 border-amber-300/60 bg-amber-50 dark:bg-amber-950/20 flex gap-3 text-sm">
        <Info className="h-5 w-5 shrink-0 text-amber-600 mt-0.5" />
        <p className="text-amber-900 dark:text-amber-200">
          Use UTM links <strong>only for external posts</strong> (Reddit, Facebook groups, the newsletter, ads) — never for
          internal links between BrainHook articles. Internal UTM links pollute your analytics and break attribution.
        </p>
      </Card>

      {presets.length > 0 && (
        <Card className="p-4 md:p-6 space-y-3">
          <Label className="flex items-center gap-2">
            <Bookmark className="h-4 w-4" /> Saved presets
            <span className="text-xs font-normal text-muted-foreground">shared with all editors</span>
          </Label>
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => (
              <div
                key={p.id}
                className="group flex items-center gap-1 rounded-full border bg-muted/40 pl-1 pr-1 py-0.5 text-sm"
              >
                <button
                  type="button"
                  onClick={() => applyPreset(p)}
                  className="flex items-center gap-1.5 rounded-full px-2.5 py-1 hover:bg-muted transition-colors"
                  title={`${p.source} / ${p.medium} / ${p.campaign}`}
                >
                  <Star className="h-3.5 w-3.5 text-amber-500" />
                  <span className="font-medium">{p.name}</span>
                  <span className="text-muted-foreground text-xs hidden sm:inline">
                    {p.source}/{p.medium}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => deletePreset(p.id)}
                  className="rounded-full p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  aria-label={`Delete preset ${p.name}`}
                  title="Delete preset"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4 md:p-6 space-y-5">
        <div className="space-y-2">
          <Label htmlFor="utm-base">Article URL</Label>
          <Input
            id="utm-base"
            ref={baseInputRef}
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder="https://brainhook.net/article/your-article-slug"
          />
          {baseLooksValid === false && (
            <p className="text-xs text-destructive">Enter a full URL including https://</p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-2">
              <Label htmlFor={`utm-${f.key}`}>{f.label}</Label>
              <Input
                id={`utm-${f.key}`}
                value={values[f.key]}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
              />
              <p className="text-xs text-muted-foreground">{f.hint}</p>
            </div>
          ))}
        </div>

        <div>
          <Button variant="outline" size="sm" onClick={openSaveDialog} disabled={!canSavePreset}>
            <Star className="h-4 w-4 mr-2" /> Save as preset
          </Button>
          {!canSavePreset && (
            <p className="text-xs text-muted-foreground mt-2">
              Fill in source, medium, and campaign to save a reusable preset.
            </p>
          )}
        </div>
      </Card>

      <Card className="p-4 md:p-6 space-y-3">
        <Label className="flex items-center gap-2">
          <Link2 className="h-4 w-4" /> Tagged link
        </Label>
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm break-all min-h-[2.5rem] font-mono">
          {tagged || <span className="text-muted-foreground font-sans">Fill in the URL and at least source, medium, and campaign…</span>}
        </div>
        <Button onClick={handleCopy} disabled={!canCopy}>
          {copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
          {copied ? "Copied!" : "Copy tagged link"}
        </Button>
      </Card>

      <Card className="p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <Label className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4" /> Trending shared articles
          </Label>
          {shareReportFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
        <p className="text-xs text-muted-foreground -mt-2">
          The most-shared articles by readers, ranked by share count. Copy a ready, tagged link in one
          tap, or load one into the builder above to customize it.
        </p>

        <div className="flex items-center gap-2 flex-wrap">
          {RANGES.map((r) => (
            <Button
              key={r.key}
              variant={r.key === range ? "default" : "outline"}
              size="sm"
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </Button>
          ))}
        </div>

        {shareReportLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading shared articles…
          </div>
        ) : trending.length === 0 ? (
          <div className="rounded-md border border-dashed bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
            <TrendingUp className="h-6 w-6 mx-auto mb-2 opacity-40" />
            No shares in this range yet. Try a longer range, or check back as readers share articles.
          </div>
        ) : (
          <ul className="space-y-2">
            {trending.map((a) => {
              const shareUrl = shareTaggedUrl(a.slug);
              return (
                <li
                  key={a.slug}
                  className="flex items-center gap-3 rounded-md border bg-muted/30 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{a.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {a.total} {a.total === 1 ? "share" : "shares"}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleCopyTrending(a.slug)}
                      aria-label={`Copy tagged link for ${a.title}`}
                      title="Copy ready tagged link"
                    >
                      {copiedUrl === shareUrl ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleLoadIntoBuilder(a.slug)}
                      title="Load this article URL into the builder above"
                    >
                      <PlusCircle className="h-4 w-4 mr-1.5" />
                      Load into builder
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {history.length > 0 && (
        <Card className="p-4 md:p-6 space-y-3">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-2">
              <History className="h-4 w-4" /> Recent links
            </Label>
            <Button variant="ghost" size="sm" onClick={clearHistory} className="text-muted-foreground">
              Clear
            </Button>
          </div>
          <ul className="space-y-2">
            {history.map((h) => (
              <li
                key={h.url}
                className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2"
              >
                <span className="font-mono text-xs break-all flex-1 min-w-0">{h.url}</span>
                <span className="text-xs text-muted-foreground shrink-0 hidden sm:inline">
                  {relativeTime(h.createdAt)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 h-8 w-8"
                  onClick={() => handleCopyExisting(h.url)}
                  aria-label="Copy this link"
                  title="Copy this link"
                >
                  {copiedUrl === h.url ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save preset</DialogTitle>
            <DialogDescription>
              Save this source, medium, and campaign so you (and your teammates) can apply it again in one click.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="preset-name">Preset name</Label>
              <Input
                id="preset-name"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="Weekly newsletter"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSavePreset();
                  }
                }}
              />
            </div>
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground space-y-0.5">
              <div><span className="font-medium text-foreground">source:</span> {values.source.trim() || "—"}</div>
              <div><span className="font-medium text-foreground">medium:</span> {values.medium.trim() || "—"}</div>
              <div><span className="font-medium text-foreground">campaign:</span> {values.campaign.trim() || "—"}</div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSavePreset} disabled={createPreset.isPending}>
              {createPreset.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save preset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
