/**
 * Admin › Media Library › Glossary Cards — FORMAT-SPECIFIC gallery.
 *
 * One component, two pages (App.tsx routes):
 *   /admin/media-library/glossary     → format="reel"  9:16 (1080×1920) reels cards
 *   /admin/media-library/glossary-fb  → format="feed"  4:5  (1080×1350) FB feed cards
 * Each page previews the live CSS render in ITS format, tracks snapped
 * status / downloads against ITS stored column (reelsImageUrl vs
 * cardImageUrl), and exposes only ITS format's Backfill / Rebuild All
 * (format-scoped on the server — the other format is never touched).
 * Per-card Recapture still refreshes both formats.
 * Capture/store operations are delegated to GlosaryCaptureProvider which
 * lives at the AdminLayout level — batch loops run in the background even
 * when you navigate to another admin page.
 */

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, ExternalLink, Search, Download, CheckCircle2, RefreshCcw, Layers, Square, RotateCcw, ImagePlus, Sparkles } from "lucide-react";
import { Link } from "wouter";
import { GlossaryShareCard, type ConceptForCard } from "@/components/GlossaryShareCard";
import { Button } from "@/components/ui/button";
import { useGlossaryCapture } from "@/lib/useGlossaryCapture";
import { downloadImage } from "@/lib/downloadImage";

interface GalleryResponse {
  concepts: ConceptForCard[];
}

interface BackfillSweepStatus {
  running: boolean;
  processed: number;
  failed: number;
  total: number;
  current: string | null;
}

const STATUS_BADGE: Record<string, string> = {
  live:   "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  draft:  "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  hidden: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
};

const PAGE_META = {
  feed: {
    title: "Glossary FB Cards",
    crumb: "Glossary FB Cards (4:5)",
    blurb: "CSS-rendered 4:5 Facebook feed cards (1200×1470 PNG with the stacked-card plate on a transparent border) — used by FB posts and Term of the Day.",
    label: "4:5 feed",
    downloadSuffix: "fb",
  },
  reel: {
    title: "Glossary Reels Cards",
    crumb: "Glossary Cards (9:16)",
    blurb: "CSS-rendered 9:16 portrait cards (1200×2040 PNG with the stacked-card plate on a transparent border) — used for reels/stories.",
    label: "9:16 reels",
    downloadSuffix: "reel",
  },
} as const;

export default function GlossaryCards({ format }: { format: "feed" | "reel" }) {
  const { running, progress, busySingle, startBackfill, startRebuildAll, stop, captureAndStore } = useGlossaryCapture();
  const meta = PAGE_META[format];
  const storedUrl = (c: ConceptForCard) => (format === "feed" ? c.cardImageUrl : c.reelsImageUrl) ?? null;

  const [query, setQuery] = useState("");
  const [downloading, setDownloading] = useState<string | null>(null);

  const { data, isLoading, isError, refetch, isFetching } = useQuery<GalleryResponse>({
    queryKey: ["admin-glossary-gallery"],
    queryFn: async () => {
      const res = await fetch("/api/admin/concepts/gallery");
      if (!res.ok) throw new Error("Failed to load glossary cards");
      return res.json();
    },
    staleTime: 60 * 1000,
  });

  const filtered = (data?.concepts ?? []).filter((c) =>
    !query.trim() || c.term.toLowerCase().includes(query.toLowerCase()),
  );

  const isBusy = running || !!busySingle;

  // ── Per-card actions ────────────────────────────────────────────────────

  async function handleDownload(concept: ConceptForCard) {
    if (downloading) return;
    setDownloading(concept.id);
    try {
      let url = storedUrl(concept);
      if (!url) {
        // No stored snapshot — server-side capture first (refreshes both
        // formats), then download this page's format.
        const ok = await captureAndStore(concept);
        if (!ok) return;
        const fresh = await refetch();
        const freshConcept = fresh.data?.concepts.find((c) => c.id === concept.id);
        url = freshConcept ? storedUrl(freshConcept) : null;
        if (!url) return;
      }
      await downloadImage(url, `brainhook-glossary-${concept.slug}-${meta.downloadSuffix}.png`);
    } catch { /* ignore */ } finally {
      setDownloading(null);
    }
  }

  const [togglingBlock, setTogglingBlock] = useState<string | null>(null);

  async function handleToggleTodBlock(concept: ConceptForCard) {
    if (togglingBlock) return;
    setTogglingBlock(concept.id);
    try {
      const res = await fetch(`/api/admin/concepts/${concept.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ termOfDayBlocked: !concept.termOfDayBlocked }),
      });
      if (!res.ok) throw new Error("patch_failed");
      await refetch();
    } catch {
      alert("Failed to update the Term of the Day block for this term.");
    } finally {
      setTogglingBlock(null);
    }
  }

  async function handleToggleBackfill(concept: ConceptForCard) {
    if (togglingBlock) return;
    setTogglingBlock(concept.id);
    try {
      const res = await fetch(`/api/admin/concepts/${concept.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backfillRequested: !concept.backfillRequested }),
      });
      if (!res.ok) throw new Error("patch_failed");
      await refetch();
    } catch {
      alert("Failed to update the backfill mark for this term.");
    } finally {
      setTogglingBlock(null);
    }
  }

  async function handleRecapture(concept: ConceptForCard) {
    if (isBusy) return;
    await captureAndStore(concept);
    void refetch();
  }

  // ── Backfill & review sweep (server-side, targeted to marked concepts) ──

  const { data: sweepStatus, refetch: refetchSweepStatus } = useQuery<BackfillSweepStatus>({
    queryKey: ["admin-backfill-marked-status"],
    queryFn: async () => {
      const res = await fetch("/api/admin/concepts/backfill-marked/status");
      if (!res.ok) throw new Error("Failed to load sweep status");
      return res.json();
    },
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  });
  const sweepRunning = !!sweepStatus?.running;

  // When the sweep finishes, reload the gallery (marks cleared, cards recaptured).
  const wasSweepRunning = useRef(false);
  useEffect(() => {
    if (wasSweepRunning.current && !sweepRunning) void refetch();
    wasSweepRunning.current = sweepRunning;
  }, [sweepRunning, refetch]);

  const markedCount = (data?.concepts ?? []).filter((c) => c.backfillRequested).length;

  async function handleBackfillSweep() {
    if (sweepRunning || !markedCount) return;
    if (
      !confirm(
        `Re-research and regenerate ${markedCount} marked term${markedCount !== 1 ? "s" : ""}?\n\nFor each marked term this re-resolves Wikipedia, pulls fresh Source Vault context, regenerates ALL definition fields, re-verifies, and recaptures both card formats. Runs on the server — you can navigate away.`,
      )
    )
      return;
    try {
      const res = await fetch("/api/admin/concepts/backfill-marked", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        alert(body?.error ?? "Failed to start the backfill sweep.");
        return;
      }
      void refetchSweepStatus();
    } catch {
      alert("Failed to start the backfill sweep.");
    }
  }

  async function handleCancelSweep() {
    try {
      await fetch("/api/admin/concepts/backfill-marked/cancel", { method: "POST" });
      void refetchSweepStatus();
    } catch { /* ignore */ }
  }

  // ── Bulk actions (format-scoped: this page's format only — the other
  //    format's stored cards are never touched) ──

  function handleBackfill() {
    const concepts = data?.concepts;
    if (!concepts?.length) return;
    const missing = concepts.filter((c) => !storedUrl(c));
    if (!missing.length) { alert(`All ${meta.label} cards already have snapshots.`); return; }
    if (!confirm(`Backfill ${missing.length} missing ${meta.label} card${missing.length !== 1 ? "s" : ""}?\n\nOnly ${meta.label} cards are touched. Runs on the server — you can navigate away or close the tab.`)) return;
    startBackfill(format, () => void refetch());
  }

  function handleRebuildAll() {
    const concepts = data?.concepts;
    if (!concepts?.length) return;
    if (!confirm(`Re-capture and overwrite all ${concepts.length} ${meta.label} cards?\n\nOnly ${meta.label} cards are touched. Runs in the background — you can navigate away.`)) return;
    startRebuildAll(format, () => void refetch());
  }

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="p-6 max-w-[1700px] mx-auto">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
            <Link href="/admin/media-library" className="hover:text-foreground transition-colors">
              Media Library
            </Link>
            <span>/</span>
            <span className="text-foreground">{meta.crumb}</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">{meta.title}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {meta.blurb}{" "}
            {data ? `${data.concepts.length} terms · ${data.concepts.filter((c) => storedUrl(c)).length} snapped` : ""}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {running && (
            <Button
              variant="outline" size="sm"
              onClick={stop}
              className="gap-2 border-red-500/40 text-red-400 hover:bg-red-500/10 hover:text-red-300"
            >
              <Square className="h-3.5 w-3.5" /> Stop
            </Button>
          )}

          {/* Format-scoped bulk actions — this page's format only; the other
              format's stored cards are never touched */}
          <Button
            variant="outline" size="sm"
            onClick={handleBackfill}
            disabled={isBusy || isLoading || !data?.concepts.length}
            className="gap-2"
            title={`Capture only the ${meta.label} cards that don't have a snapshot yet — the other format is untouched`}
          >
            {running && progress.mode === "backfill" && progress.format === format ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" />{progress.done} / {progress.total}</>
            ) : (
              <><ImagePlus className="h-3.5 w-3.5" />Backfill Missing</>
            )}
          </Button>
          <Button
            variant="outline" size="sm"
            onClick={handleRebuildAll}
            disabled={isBusy || isLoading || !data?.concepts.length}
            className="gap-2"
            title={`Re-capture every ${meta.label} card (overwrites stored snapshots) — the other format is untouched`}
          >
            {running && progress.mode === "rebuild-all" && progress.format === format ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" />{progress.done} / {progress.total}</>
            ) : (
              <><Layers className="h-3.5 w-3.5" />Rebuild All</>
            )}
          </Button>

          {/* Targeted backfill & review sweep — only checkmarked terms */}
          <Button
            variant="outline" size="sm"
            onClick={() => void handleBackfillSweep()}
            disabled={sweepRunning || isLoading || markedCount === 0}
            className="gap-2 border-sky-500/40 text-sky-400 hover:bg-sky-500/10 hover:text-sky-300"
            title="Re-research (Wikipedia + Source Vault + AI) and regenerate every term marked with the 'Backfill & review' checkbox, then recapture its cards"
          >
            {sweepRunning ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" />{sweepStatus?.processed ?? 0} / {sweepStatus?.total ?? 0}</>
            ) : (
              <><Sparkles className="h-3.5 w-3.5" />Backfill Marked{markedCount > 0 ? ` (${markedCount})` : ""}</>
            )}
          </Button>

          <Button
            variant="outline" size="sm"
            onClick={() => refetch()}
            disabled={isFetching || running}
            className="gap-2"
          >
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
            Refresh
          </Button>
        </div>
      </div>

      {/* ── Background-job progress bar ── */}
      {running && progress.total > 0 && (
        <div className="mb-6 rounded-lg border border-amber-500/25 bg-amber-500/5 p-4">
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2.5">
              <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
              <span className="text-sm font-medium text-amber-200">
                {progress.mode === "backfill" ? "Backfilling missing" : "Rebuilding all"}{" "}
                {progress.format ? PAGE_META[progress.format].label : ""} cards
              </span>
              <span className="text-sm text-amber-400/70">
                {progress.done} of {progress.total} · {progress.stored} saved
              </span>
            </div>
            <button
              onClick={stop}
              className="text-xs text-red-400 hover:text-red-300 transition-colors px-2 py-1 rounded border border-red-500/30 hover:bg-red-500/10"
            >
              Stop after this one
            </button>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-amber-500 rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5">
            Running in the background — you can navigate away and it will keep going.
          </p>
        </div>
      )}

      {/* ── Backfill & review sweep progress bar ── */}
      {sweepRunning && (
        <div className="mb-6 rounded-lg border border-sky-500/25 bg-sky-500/5 p-4">
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-2.5">
              <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
              <span className="text-sm font-medium text-sky-200">
                Backfilling marked terms{sweepStatus?.current ? ` — ${sweepStatus.current}` : ""}
              </span>
              <span className="text-sm text-sky-400/70">
                {sweepStatus?.processed ?? 0} of {sweepStatus?.total ?? 0}
                {sweepStatus?.failed ? ` · ${sweepStatus.failed} failed` : ""}
              </span>
            </div>
            <button
              onClick={() => void handleCancelSweep()}
              className="text-xs text-red-400 hover:text-red-300 transition-colors px-2 py-1 rounded border border-red-500/30 hover:bg-red-500/10"
            >
              Stop after this one
            </button>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-sky-500 rounded-full transition-all duration-300"
              style={{
                width: `${sweepStatus && sweepStatus.total > 0 ? Math.round(((sweepStatus.processed + sweepStatus.failed) / sweepStatus.total) * 100) : 0}%`,
              }}
            />
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5">
            Re-researching Wikipedia + Source Vault, regenerating definitions, and recapturing cards. Failed terms keep their mark for a retry.
          </p>
        </div>
      )}

      {/* ── Search ── */}
      <div className="relative mb-6">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search terms…"
          className="w-full pl-9 pr-4 py-2 bg-muted/40 border border-border rounded-lg text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* ── States ── */}
      {isLoading && (
        <div className="flex items-center justify-center py-24 text-muted-foreground gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading concepts…
        </div>
      )}
      {isError && (
        <div className="text-center py-24 text-red-400">
          Failed to load — check the API server.
        </div>
      )}

      {/* ── Card grid ── */}
      {!isLoading && !isError && (
        <>
          {filtered.length === 0 ? (
            <p className="text-muted-foreground text-sm py-16 text-center">No terms match "{query}"</p>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
              {filtered.map((concept) => (
                <div key={concept.id} className="space-y-3">
                  {/* Card preview with stacked decoration */}
                  <div className="relative">
                    <div
                      className="absolute -inset-2 rounded-xl transform -rotate-[1deg]"
                      style={{
                        background: "linear-gradient(145deg, #141414 0%, #000000 55%, #0a0a0a 100%)",
                        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), inset 0 -1px 0 rgba(0,0,0,0.9)",
                      }}
                    />
                    <div className="absolute -inset-1 bg-gradient-to-br from-[#F5A84E]/10 to-transparent border border-[#F5A84E]/20 rounded-xl transform rotate-[2deg]" />
                    <div className="relative rounded-xl overflow-hidden ring-1 ring-[#2A2A32]">
                      {(running || busySingle === concept.id) && (
                        <div className="absolute inset-0 z-10 bg-black/50 flex items-center justify-center">
                          <Loader2 className="h-5 w-5 animate-spin text-amber-400/60" />
                        </div>
                      )}
                      {/* WYSIWYG: preview the live CSS render in THIS page's format. */}
                      <GlossaryShareCard concept={concept} format={format} />
                    </div>
                  </div>

                  {/* Term + status */}
                  <div className="flex items-center gap-2 px-0.5 mb-2">
                    <span className="text-sm font-medium text-foreground truncate">{concept.term}</span>
                    {storedUrl(concept) && (
                      <span title="Snapshot stored" className="shrink-0 flex items-center">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                      </span>
                    )}
                    {(concept as ConceptForCard & { status?: string }).status && (
                      <span
                        className={`ml-auto text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0 ${
                          STATUS_BADGE[(concept as ConceptForCard & { status?: string }).status ?? "draft"] ??
                          STATUS_BADGE.draft
                        }`}
                      >
                        {(concept as ConceptForCard & { status?: string }).status}
                      </span>
                    )}
                  </div>

                  {/* Term of the Day opt-out (4:5 cards feed Term of the Day) */}
                  {format === "feed" && (
                    <label
                      className={`flex items-center gap-2 px-0.5 mb-2 text-xs cursor-pointer select-none ${
                        concept.termOfDayBlocked ? "text-red-400" : "text-muted-foreground"
                      } ${togglingBlock === concept.id ? "opacity-50" : ""}`}
                      title="When ticked, this term is never picked for the daily Term of the Day post"
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-red-500"
                        checked={!!concept.termOfDayBlocked}
                        disabled={togglingBlock === concept.id}
                        onChange={() => void handleToggleTodBlock(concept)}
                      />
                      Do not use for Term of the Day
                    </label>
                  )}

                  {/* Backfill & review mark — feeds the "Backfill Marked" sweep */}
                  <label
                    className={`flex items-center gap-2 px-0.5 mb-2 text-xs cursor-pointer select-none ${
                      concept.backfillRequested ? "text-sky-400" : "text-muted-foreground"
                    } ${togglingBlock === concept.id ? "opacity-50" : ""}`}
                    title="Mark this term for the 'Backfill Marked' sweep: re-research Wikipedia + Source Vault, regenerate all definition fields, and recapture both cards"
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-sky-500"
                      checked={!!concept.backfillRequested}
                      disabled={togglingBlock === concept.id || sweepRunning}
                      onChange={() => void handleToggleBackfill(concept)}
                    />
                    Mark for backfill &amp; review
                  </label>

                  {/* Action buttons */}
                  <div className="grid grid-cols-3 gap-1.5">
                    <button
                      onClick={() => void handleRecapture(concept)}
                      disabled={isBusy}
                      className="flex flex-col items-center gap-1 py-2 px-1 rounded-lg bg-[#1A1A22] border border-[#2A2A35] hover:border-amber-500/40 hover:bg-[#1E1B14] hover:text-amber-400 text-muted-foreground transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                      title="Re-capture and overwrite the stored card"
                    >
                      {busySingle === concept.id
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <RotateCcw className="h-4 w-4" />}
                      <span className="text-[10px] font-medium uppercase tracking-wide leading-none">Recapture</span>
                    </button>

                    <button
                      onClick={() => void handleDownload(concept)}
                      disabled={downloading === concept.id || (isBusy && !storedUrl(concept))}
                      className="flex flex-col items-center gap-1 py-2 px-1 rounded-lg bg-[#1A1A22] border border-[#2A2A35] hover:border-[#3A3A45] hover:bg-[#1E1E28] hover:text-foreground text-muted-foreground transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      title={storedUrl(concept) ? `Download stored ${meta.label} PNG` : `Capture and download ${meta.label} PNG`}
                    >
                      {downloading === concept.id
                        ? <Loader2 className="h-4 w-4 animate-spin" />
                        : <Download className="h-4 w-4" />}
                      <span className="text-[10px] font-medium uppercase tracking-wide leading-none">Download</span>
                    </button>

                    {storedUrl(concept) ? (
                      <a
                        href={storedUrl(concept)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex flex-col items-center gap-1 py-2 px-1 rounded-lg bg-[#1A1A22] border border-[#2A2A35] hover:border-[#3A3A45] hover:bg-[#1E1E28] hover:text-foreground text-muted-foreground transition-all"
                        title={`Open the stored ${meta.label} PNG in a new tab`}
                      >
                        <ExternalLink className="h-4 w-4" />
                        <span className="text-[10px] font-medium uppercase tracking-wide leading-none">Open</span>
                      </a>
                    ) : (
                      <button
                        disabled
                        className="flex flex-col items-center gap-1 py-2 px-1 rounded-lg bg-[#1A1A22] border border-[#2A2A35] text-muted-foreground opacity-40 cursor-not-allowed"
                        title="No stored card yet — Recapture first"
                      >
                        <ExternalLink className="h-4 w-4" />
                        <span className="text-[10px] font-medium uppercase tracking-wide leading-none">Open</span>
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
