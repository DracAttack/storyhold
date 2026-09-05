import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, FolderOpen, ChevronDown, ChevronRight, RefreshCw, ExternalLink, Trash2, RotateCw, Download, Eraser, Images, RotateCcw } from "lucide-react";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { withImageParams } from "@/lib/heroImage";
import { useGlossaryCapture } from "@/lib/useGlossaryCapture";
import { downloadImage } from "@/lib/downloadImage";

interface MediaItem {
  key: string;
  url: string;
  size: number;
  contentType: string;
  createdAt: string;
  slug?: string | null;
  conceptId?: string | null;
  termOfDayBlocked?: boolean | null;
  backfillRequested?: boolean | null;
}

interface MediaGroup {
  name: string;
  label: string;
  items: MediaItem[];
}

interface MediaLibraryData {
  total: number;
  groups: MediaGroup[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

/** Both glossary-card storage groups: 9:16 reels + 4:5 FB feed cards. */
const GLOSSARY_GROUPS = new Set(["glossary-cards", "glossary-cards-fb"]);

function viewHref(item: MediaItem, groupName: string): string | null {
  if (GLOSSARY_GROUPS.has(groupName) && item.slug) return `/glossary/${item.slug}`;
  if (groupName === "hero-images") {
    const filename = item.key.split("/").pop() ?? "";
    const m = filename.match(/^(.+)-[0-9a-f]{8}\./i);
    if (m) return `/article/${m[1]}`;
  }
  return null;
}

function MediaCard({
  item,
  groupName,
  onDelete,
  onRegen,
}: {
  item: MediaItem;
  groupName: string;
  onDelete: (key: string) => void;
  onRegen: (item: MediaItem) => void;
}) {
  const queryClient = useQueryClient();
  const [regenLoading, setRegenLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [downloadLoading, setDownloadLoading] = useState(false);
  const viewUrl = viewHref(item, groupName);
  const isGlossary = GLOSSARY_GROUPS.has(groupName);
  const canRegen = isGlossary && !!item.conceptId;

  // Term of the Day opt-out — per-concept flag, editable right on the card.
  // Local state so the checkbox responds instantly; reverts on API failure.
  const [todBlocked, setTodBlocked] = useState(!!item.termOfDayBlocked);
  const [todToggling, setTodToggling] = useState(false);
  const showTodBlock = isGlossary && !!item.conceptId && item.termOfDayBlocked != null;

  const handleToggleTodBlock = async () => {
    if (todToggling || !item.conceptId) return;
    const next = !todBlocked;
    setTodToggling(true);
    setTodBlocked(next);
    try {
      const res = await fetch(`/api/admin/concepts/${item.conceptId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ termOfDayBlocked: next }),
      });
      if (!res.ok) throw new Error("patch_failed");
      // Keep the sibling variant (9:16 vs 4:5) of the same term in sync.
      void queryClient.invalidateQueries({ queryKey: ["admin-media-library"] });
    } catch {
      setTodBlocked(!next);
      alert("Failed to update the Term of the Day block for this term.");
    } finally {
      setTodToggling(false);
    }
  };

  // Backfill & review mark — feeds the "Backfill Marked" sweep on the glossary
  // card pages. Same optimistic local-state pattern as the ToD checkbox.
  const [backfillMarked, setBackfillMarked] = useState(!!item.backfillRequested);
  const [backfillToggling, setBackfillToggling] = useState(false);
  const showBackfillMark = isGlossary && !!item.conceptId && item.backfillRequested != null;

  const handleToggleBackfill = async () => {
    if (backfillToggling || !item.conceptId) return;
    const next = !backfillMarked;
    setBackfillToggling(true);
    setBackfillMarked(next);
    try {
      const res = await fetch(`/api/admin/concepts/${item.conceptId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backfillRequested: next }),
      });
      if (!res.ok) throw new Error("patch_failed");
      // Keep the sibling variant (9:16 vs 4:5) of the same term in sync.
      void queryClient.invalidateQueries({ queryKey: ["admin-media-library"] });
    } catch {
      setBackfillMarked(!next);
      alert("Failed to update the backfill mark for this term.");
    } finally {
      setBackfillToggling(false);
    }
  };

  const { captureAndStore, busySingle, running: captureRunning } = useGlossaryCapture();

  // Show loading while the capture context is actively working on this card.
  const isCaptureActive = busySingle === item.conceptId;
  const showRegenSpinner = regenLoading || isCaptureActive;

  const handleRegen = async () => {
    if (!item.conceptId) return;
    if (captureRunning || busySingle) return; // capture engine busy
    setRegenLoading(true);
    try {
      if (isGlossary) {
        // Server-side capture: the API server re-renders and stores both
        // card outputs; no concept data needed client-side.
        setRegenLoading(false); // hand off to capture context (it sets busySingle)
        await captureAndStore({ id: item.conceptId });
      } else {
        await onRegen(item);
      }
    } finally {
      setRegenLoading(false);
    }
  };

  const handleDownload = async () => {
    if (downloadLoading) return;
    setDownloadLoading(true);
    try {
      await downloadImage(item.url, item.key.split("/").pop() ?? "image.png");
    } catch { /* ignore */ } finally {
      setDownloadLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete ${item.key.split("/").pop()}?`)) return;
    setDeleteLoading(true);
    try {
      onDelete(item.key);
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div className="group relative bg-muted rounded-lg overflow-hidden border border-border hover:border-primary/50 transition-colors">
      <div className={`relative bg-muted-foreground/5 ${groupName === "glossary-cards" ? "aspect-[9/16]" : groupName === "glossary-cards-fb" ? "aspect-[4/5]" : "aspect-video"}`}>
        <img
          src={withImageParams(item.url, 320)}
          alt=""
          loading="lazy"
          className="w-full h-full object-contain"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.opacity = "0.2";
          }}
        />
      </div>
      <div className="px-2 py-1.5 space-y-0.5">
        <p className="text-[11px] text-foreground truncate font-medium" title={item.key}>
          {item.slug ?? item.key.split("/").pop()}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {formatBytes(item.size)}
          {item.createdAt ? ` · ${formatDate(item.createdAt)}` : ""}
        </p>
      </div>
      {/* Action row — always visible (hover overlays are unusable on touch). */}
      <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
        {viewUrl && (
          <a
            href={viewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded bg-muted-foreground/10 hover:bg-muted-foreground/20 border border-border px-1.5 py-1 text-[10px] font-medium text-foreground transition-colors"
            title="View on site"
          >
            <ExternalLink className="h-3 w-3" />
            View
          </a>
        )}
        <button
          type="button"
          onClick={handleDownload}
          disabled={downloadLoading}
          className="inline-flex items-center gap-1 rounded bg-muted-foreground/10 hover:bg-muted-foreground/20 border border-border px-1.5 py-1 text-[10px] font-medium text-foreground transition-colors disabled:opacity-50"
          title="Download"
        >
          {downloadLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
          Download
        </button>
        {canRegen && (
          <button
            type="button"
            onClick={handleRegen}
            disabled={showRegenSpinner || (captureRunning && !isCaptureActive) || (!!busySingle && !isCaptureActive)}
            className="inline-flex items-center gap-1 rounded bg-amber-500/15 hover:bg-amber-500/25 border border-amber-400/30 px-1.5 py-1 text-[10px] font-medium text-amber-500 transition-colors disabled:opacity-50"
            title={isGlossary ? "Recapture glossary card" : "Regenerate share card"}
          >
            {showRegenSpinner ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : isGlossary ? (
              <RotateCcw className="h-3 w-3" />
            ) : (
              <RotateCw className="h-3 w-3" />
            )}
            {isGlossary ? "Recapture" : "Regen"}
          </button>
        )}
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleteLoading}
          className="inline-flex items-center gap-1 rounded bg-red-500/15 hover:bg-red-500/25 border border-red-400/30 px-1.5 py-1 text-[10px] font-medium text-red-400 transition-colors disabled:opacity-50"
          title="Delete"
        >
          {deleteLoading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
          Delete
        </button>
      </div>
      {showTodBlock && (
        <label
          className={`flex items-center gap-1.5 px-2 pb-2 text-[10px] cursor-pointer select-none ${
            todBlocked ? "text-red-400" : "text-muted-foreground"
          } ${todToggling ? "opacity-50" : ""}`}
          title="When ticked, this term is fully hidden from the public site: never picked for Term of the Day, no glossary page (404 + noindex), not in the A-Z index, sitemap, search, or related links. Article hover tooltips still work (without a glossary link), and internal vault/indexing tools can still use it."
        >
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-red-500"
            checked={todBlocked}
            disabled={todToggling}
            onChange={() => void handleToggleTodBlock()}
          />
          Hide term (no ToD, no glossary page)
        </label>
      )}
      {showBackfillMark && (
        <label
          className={`flex items-center gap-1.5 px-2 pb-2 text-[10px] cursor-pointer select-none ${
            backfillMarked ? "text-sky-400" : "text-muted-foreground"
          } ${backfillToggling ? "opacity-50" : ""}`}
          title="Mark this term for the 'Backfill Marked' sweep (run from the glossary card pages): re-research Wikipedia + Source Vault, regenerate all definition fields, and recapture both cards"
        >
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-sky-500"
            checked={backfillMarked}
            disabled={backfillToggling}
            onChange={() => void handleToggleBackfill()}
          />
          Mark for backfill &amp; review
        </label>
      )}
    </div>
  );
}

function MediaGrid({
  items,
  groupName,
  onDelete,
  onRegen,
}: {
  items: MediaItem[];
  groupName: string;
  onDelete: (key: string) => void;
  onRegen: (item: MediaItem) => void;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3 pt-1">
      {items.map((item) => (
        <MediaCard
          key={item.key}
          item={item}
          groupName={groupName}
          onDelete={onDelete}
          onRegen={onRegen}
        />
      ))}
    </div>
  );
}

export default function MediaLibrary() {
  const queryClient = useQueryClient();
  // All drawers start collapsed — image grids only mount when opened.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, isLoading, isError, refetch, isFetching } = useQuery<MediaLibraryData>({
    queryKey: ["admin-media-library"],
    queryFn: async () => {
      const res = await fetch("/api/admin/media-library");
      if (!res.ok) throw new Error("Failed to load media library");
      return res.json();
    },
    staleTime: 60 * 1000,
  });

  const deleteMutation = useMutation({
    mutationFn: async (key: string) => {
      const res = await fetch(`/api/admin/media-library/item?key=${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-media-library"] });
    },
  });

  const deleteGroupMutation = useMutation({
    mutationFn: async (group: string) => {
      const res = await fetch(`/api/admin/media-library/group?group=${encodeURIComponent(group)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Delete failed");
      return res.json() as Promise<{ deleted: number; total: number }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-media-library"] });
    },
  });

  const regenMutation = useMutation({
    mutationFn: async (item: MediaItem) => {
      if (!item.conceptId) throw new Error("No concept ID");
      const res = await fetch(`/api/admin/concepts/${item.conceptId}/regen-share-card`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Regen failed");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin-media-library"] });
    },
  });

  const toggle = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleDelete = (key: string) => deleteMutation.mutate(key);
  const handleRegen  = async (item: MediaItem) => regenMutation.mutateAsync(item);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24 gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Loading media library…</span>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="py-16 text-center space-y-4">
        <p className="text-muted-foreground">Couldn't load the media library.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    );
  }

  // Drawer order: 9:16 reels cards → 4:5 FB cards → hero images → the rest
  // (stable sort keeps the server's order for unlisted groups).
  const GROUP_ORDER = ["glossary-cards", "glossary-cards-fb", "hero-images"];
  const rank = (name: string) => {
    const i = GROUP_ORDER.indexOf(name);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  const sortedGroups = [...data.groups].sort((a, b) => rank(a.name) - rank(b.name));

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-bold">Media Library</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {data.total} image{data.total !== 1 ? "s" : ""} stored across {data.groups.length} categor{data.groups.length !== 1 ? "ies" : "y"}.
            Hover any image to view on site, regenerate, or delete.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/media-library/glossary-fb">
              <Images className="h-4 w-4 mr-2" />
              FB Cards (4:5)
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/media-library/glossary">
              <Images className="h-4 w-4 mr-2" />
              Reels Cards (9:16)
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Refresh
          </Button>
        </div>
      </div>

      {data.groups.length === 0 && (
        <Card className="p-12 text-center text-muted-foreground text-sm">
          No images found in storage.
        </Card>
      )}

      {sortedGroups.map((group) => {
        const isOpen = expanded.has(group.name);
        const canBulkDelete = GLOSSARY_GROUPS.has(group.name) && group.items.length > 0;
        const bulkDeleting = deleteGroupMutation.isPending && deleteGroupMutation.variables === group.name;
        return (
          <Card key={group.name} className="overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3">
              <button
                type="button"
                className="flex-1 flex items-center gap-2 min-w-0 text-left hover:opacity-80 transition-opacity"
                onClick={() => toggle(group.name)}
              >
                <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="font-medium text-sm">{group.label}</span>
                <span className="text-xs text-muted-foreground">({group.items.length})</span>
                {isOpen ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 ml-auto" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 ml-auto" />
                )}
              </button>
              {canBulkDelete && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                  disabled={bulkDeleting}
                  onClick={() => {
                    if (!confirm(`Delete all ${group.items.length} files in ${group.label}? This also clears their DB references.`)) return;
                    deleteGroupMutation.mutate(group.name);
                  }}
                >
                  {bulkDeleting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Eraser className="h-3 w-3 mr-1" />}
                  Delete all
                </Button>
              )}
            </div>

            {isOpen && (
              <div className="px-4 pb-4 border-t border-border">
                <MediaGrid
                  items={group.items}
                  groupName={group.name}
                  onDelete={handleDelete}
                  onRegen={handleRegen}
                />
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
