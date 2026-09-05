import { useState } from "react";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  Search,
  ScanLine,
  X,
  Check,
  ExternalLink,
  AlertTriangle,
  Link2,
  Quote,
} from "lucide-react";
import { toast } from "sonner";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface GapItem {
  id: string;
  articleId: string;
  articleSlug: string;
  articleTitle: string;
  claimText: string;
  contextText: string;
  publicationHint: string | null;
  yearHint: number | null;
  status: string;
  searchQuery: string | null;
  foundUrl: string | null;
  foundTitle: string | null;
  rationale: string | null;
  weavedAt: string | null;
  createdAt: string;
}

interface GapStats {
  total: number;
  pending: number;
  searching: number;
  found: number;
  ingested: number;
  dismissed: number;
  failed: number;
}

function useGapStats() {
  return useQuery<GapStats>({
    queryKey: ["source-gaps-stats"],
    queryFn: async () => {
      const res = await fetch("/api/admin/source-gaps/stats");
      if (!res.ok) throw new Error("Failed to load stats");
      return res.json();
    },
    staleTime: 30_000,
  });
}

function useGapList(statusFilter: string | null) {
  return useQuery<{ items: GapItem[]; total: number }>({
    queryKey: ["source-gaps", statusFilter],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (statusFilter) qs.set("status", statusFilter);
      qs.set("limit", "50");
      const res = await fetch(`/api/admin/source-gaps?${qs}`);
      if (!res.ok) throw new Error("Failed to load gaps");
      return res.json();
    },
    staleTime: 10_000,
  });
}

interface ScanReport {
  dryRun: boolean;
  articlesScanned: number;
  gapsFound: number;
  gapsInserted: number;
  gapsSkipped: number;
  articles: {
    id: string;
    slug: string;
    gapsFound: number;
    gapsInserted: number;
    gapsSkipped: number;
  }[];
}

function useScanGaps() {
  const qc = useQueryClient();
  return useMutation<ScanReport, Error, { dryRun: boolean; batchSize?: number }>({
    mutationFn: async (opts) => {
      const res = await fetch("/api/admin/source-gaps/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<ScanReport>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["source-gaps-stats"] });
      qc.invalidateQueries({ queryKey: ["source-gaps"] });
    },
  });
}

function useSearchGap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (gapId: string) => {
      const res = await fetch(`/api/admin/source-gaps/${gapId}/search`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["source-gaps-stats"] });
      qc.invalidateQueries({ queryKey: ["source-gaps"] });
    },
  });
}

interface ApplyResult {
  applied: boolean;
  reason?: string;
  phrase?: string;
  url?: string;
  title?: string | null;
  rationale?: string | null;
  articleSlug?: string;
}

function useApplyGap() {
  const qc = useQueryClient();
  return useMutation<ApplyResult, Error, string>({
    mutationFn: async (gapId: string) => {
      const res = await fetch(`/api/admin/source-gaps/${gapId}/apply`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.status === 404 || res.status === 409) {
        throw new Error(data.reason ?? data.error ?? "Apply failed");
      }
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["source-gaps-stats"] });
      qc.invalidateQueries({ queryKey: ["source-gaps"] });
    },
  });
}

function useDismissGap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (gapId: string) => {
      const res = await fetch(`/api/admin/source-gaps/${gapId}/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["source-gaps-stats"] });
      qc.invalidateQueries({ queryKey: ["source-gaps"] });
    },
  });
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  searching: "Searching",
  found: "Found",
  ingested: "Applied",
  dismissed: "Dismissed",
  failed: "Failed",
};

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-amber-500 text-white",
  searching: "bg-sky-500 text-white",
  found: "bg-emerald-500 text-white",
  ingested: "bg-emerald-700 text-white",
  dismissed: "bg-muted text-muted-foreground",
  failed: "bg-red-500 text-white",
};

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xl font-bold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

function GapCard({
  gap,
  onSearch,
  onApply,
  onDismiss,
  searchingId,
  applyingId,
  dismissingId,
}: {
  gap: GapItem;
  onSearch: (id: string) => void;
  onApply: (id: string) => void;
  onDismiss: (id: string) => void;
  searchingId: string | undefined;
  applyingId: string | undefined;
  dismissingId: string | undefined;
}) {
  const isSearching = searchingId === gap.id;
  const isApplying = applyingId === gap.id;
  const isDismissing = dismissingId === gap.id;

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0 space-y-2">
          {/* Status + hints row */}
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${STATUS_BADGE[gap.status] ?? "bg-muted text-muted-foreground"}`}
            >
              {STATUS_LABEL[gap.status] ?? gap.status}
            </span>
            {gap.yearHint && (
              <span className="text-xs text-muted-foreground">{gap.yearHint}</span>
            )}
            {gap.publicationHint && (
              <span className="text-xs text-muted-foreground truncate max-w-xs">
                {gap.publicationHint}
              </span>
            )}
          </div>

          {/* Gapped phrase */}
          <div className="flex gap-2 items-start">
            <Quote className="h-3.5 w-3.5 mt-0.5 text-muted-foreground/60 shrink-0" />
            <p className="text-sm font-medium leading-relaxed">{gap.claimText}</p>
          </div>

          {/* Context */}
          <p className="text-xs text-muted-foreground line-clamp-2 pl-5">
            {gap.contextText}
          </p>

          {/* Article link */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground pl-5">
            <span>In:</span>
            <a
              href={`/article/${gap.articleSlug}`}
              className="text-primary hover:underline inline-flex items-center gap-1"
              target="_blank"
              rel="noopener noreferrer"
            >
              {gap.articleTitle}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          {/* Found source + rationale */}
          {gap.foundUrl && (
            <div className="pl-5 space-y-1.5 border-l-2 border-emerald-500/30 ml-2.5 mt-1">
              <div className="flex items-center gap-1.5 text-xs">
                <Link2 className="h-3 w-3 text-emerald-600 shrink-0" />
                <span className="text-muted-foreground">Attached link:</span>
                <a
                  href={gap.foundUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1 font-medium truncate max-w-sm"
                >
                  {gap.foundTitle ?? gap.foundUrl}
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              </div>
              {gap.rationale && (
                <p className="text-xs text-muted-foreground italic leading-relaxed">
                  <span className="not-italic font-medium text-foreground/70">Why: </span>
                  {gap.rationale}
                </p>
              )}
              {gap.status === "ingested" && gap.weavedAt && (
                <p className="text-[10px] text-emerald-600 font-medium">
                  ✓ Woven into article body · trust box updated
                </p>
              )}
            </div>
          )}

          {/* Search query used (collapsed under Found/Ingested) */}
          {gap.searchQuery && gap.status !== "pending" && (
            <p className="text-[10px] text-muted-foreground/60 pl-5 truncate">
              Query: {gap.searchQuery}
            </p>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex flex-col gap-1.5 shrink-0">
          {gap.status === "pending" && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onSearch(gap.id)}
                disabled={isSearching}
              >
                {isSearching ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Search className="h-3.5 w-3.5" />
                )}
                Search
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => onDismiss(gap.id)}
                disabled={isDismissing}
              >
                {isDismissing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
                Dismiss
              </Button>
            </>
          )}

          {gap.status === "found" && (
            <>
              <Button
                size="sm"
                variant="default"
                className="bg-emerald-600 hover:bg-emerald-700"
                onClick={() => onApply(gap.id)}
                disabled={isApplying}
              >
                {isApplying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Link2 className="h-3.5 w-3.5" />
                )}
                Apply
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => onDismiss(gap.id)}
                disabled={isDismissing}
              >
                {isDismissing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
                Dismiss
              </Button>
            </>
          )}

          {gap.status === "ingested" && (
            <span className="text-xs text-emerald-600 flex items-center gap-1 font-medium">
              <Check className="h-3.5 w-3.5" /> Applied
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function SourceGaps() {
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [lastReport, setLastReport] = useState<ScanReport | null>(null);

  const stats = useGapStats();
  const gaps = useGapList(statusFilter);
  const scan = useScanGaps();
  const searchGap = useSearchGap();
  const applyGap = useApplyGap();
  const dismiss = useDismissGap();

  const runScan = (dryRun: boolean) => {
    scan.mutate(
      { dryRun, batchSize: 25 },
      {
        onSuccess: (data) => {
          setLastReport(data);
          toast.success(
            dryRun
              ? `Dry run: ${data.gapsFound} gaps across ${data.articlesScanned} articles`
              : `Scanned ${data.articlesScanned} articles · ${data.gapsInserted} gaps inserted`,
          );
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : "Scan failed"),
      },
    );
  };

  const handleSearch = (gapId: string) => {
    searchGap.mutate(gapId, {
      onSuccess: (data) => {
        if (data.status === "found") {
          toast.success(
            `Source found: "${data.foundTitle ?? data.foundUrl}" — click Apply to attach it`,
          );
        } else if (data.status === "duplicate") {
          toast.info(`Duplicate: ${data.duplicateReason ?? "source already linked"}`);
        } else {
          toast.info("No matching source found");
        }
      },
      onError: (err) => toast.error(err instanceof Error ? err.message : "Search failed"),
    });
  };

  const handleApply = (gapId: string) => {
    applyGap.mutate(gapId, {
      onSuccess: (data) => {
        if (data.applied) {
          toast.success(
            `Applied: "${data.phrase?.slice(0, 60)}…" → ${data.title ?? data.url}`,
          );
        } else {
          toast.info(
            data.reason === "already_linked"
              ? "Link already in article body"
              : data.reason === "already_in_trust_box"
                ? "Source already in trust box"
                : data.reason === "phrase_not_in_body"
                  ? "Claim text not found in article (may have been edited)"
                  : `Could not apply: ${data.reason ?? "unknown"}`,
          );
        }
      },
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : "Apply failed"),
    });
  };

  const handleDismiss = (gapId: string) => {
    dismiss.mutate(gapId, {
      onSuccess: () => toast.success("Gap dismissed"),
      onError: (err) => toast.error(err instanceof Error ? err.message : "Dismiss failed"),
    });
  };

  const s = stats.data;

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold tracking-tight">Source Gaps</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => runScan(true)}
            disabled={scan.isPending}
          >
            {scan.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ScanLine className="h-4 w-4" />
            )}
            Dry run
          </Button>
          <Button size="sm" onClick={() => runScan(false)} disabled={scan.isPending}>
            {scan.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ScanLine className="h-4 w-4" />
            )}
            Scan now
          </Button>
        </div>
      </div>

      {lastReport && (
        <div className="space-y-3">
          <Card className="p-3 text-sm space-y-1">
            <div className="font-medium">
              Last scan: {lastReport.dryRun ? "Dry run" : "Live"} ·{" "}
              {lastReport.articlesScanned} articles
            </div>
            <div className="text-muted-foreground">
              {lastReport.gapsFound} gaps found · {lastReport.gapsInserted ?? 0} inserted
            </div>
          </Card>
          {lastReport.articles.length > 0 && (
            <div className="rounded-lg border text-sm">
              <div className="px-3 py-2 bg-muted/50 border-b text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Per-article results
              </div>
              <div className="divide-y">
                {lastReport.articles.map((a) => (
                  <div key={a.id} className="flex items-center justify-between px-3 py-2">
                    <a
                      href={`/article/${a.slug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium hover:underline truncate mr-4"
                    >
                      {a.slug}
                    </a>
                    <div className="text-muted-foreground text-xs tabular-nums whitespace-nowrap">
                      {a.gapsFound} found
                      {a.gapsInserted > 0 && ` · ${a.gapsInserted} new`}
                      {a.gapsSkipped > 0 && ` · ${a.gapsSkipped} dup`}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {s && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          <Metric label="Total" value={s.total} />
          <Metric label="Pending" value={s.pending} />
          <Metric label="Searching" value={s.searching} />
          <Metric label="Found" value={s.found} />
          <Metric label="Applied" value={s.ingested} />
          <Metric label="Dismissed" value={s.dismissed} />
          <Metric label="Failed" value={s.failed} />
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={statusFilter === null ? "default" : "outline"}
          size="sm"
          onClick={() => setStatusFilter(null)}
        >
          All
        </Button>
        {Object.entries(STATUS_LABEL).map(([key, label]) => (
          <Button
            key={key}
            variant={statusFilter === key ? "default" : "outline"}
            size="sm"
            onClick={() => setStatusFilter(key)}
          >
            {label}
          </Button>
        ))}
      </div>

      {/* List */}
      {gaps.isLoading && (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-8">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading gaps…
        </div>
      )}

      {gaps.isError && (
        <div className="flex items-center gap-2 text-red-500 text-sm py-8">
          <AlertTriangle className="h-4 w-4" /> Failed to load gaps
        </div>
      )}

      {gaps.data && gaps.data.items.length === 0 && (
        <div className="text-muted-foreground text-sm py-8 text-center">
          No gaps {statusFilter ? `with status "${STATUS_LABEL[statusFilter]}"` : "yet"}.
          Run a scan to find unsourced claims in published articles.
        </div>
      )}

      {gaps.data && gaps.data.items.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {gaps.data.total} gap{gaps.data.total !== 1 ? "s" : ""} total ·{" "}
            {gaps.data.items.length} shown
          </p>
          {gaps.data.items.map((gap) => (
            <GapCard
              key={gap.id}
              gap={gap}
              onSearch={handleSearch}
              onApply={handleApply}
              onDismiss={handleDismiss}
              searchingId={searchGap.isPending ? (searchGap.variables as string) : undefined}
              applyingId={applyGap.isPending ? (applyGap.variables as string) : undefined}
              dismissingId={dismiss.isPending ? (dismiss.variables as string) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
