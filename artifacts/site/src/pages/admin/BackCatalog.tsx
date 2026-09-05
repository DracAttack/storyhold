import {
  useGetBackCatalogStats,
  getGetBackCatalogStatsQueryKey,
  useListBackCatalogSources,
  getListBackCatalogSourcesQueryKey,
  useRunBackCatalogHarvest,
  type BackCatalogHarvestReport,
  type ArticleSourceRow,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Radar, ExternalLink, FlaskConical, Play } from "lucide-react";
import { toast } from "sonner";

type StatusFilter = "published" | "draft" | "scheduled" | "all";

const STATUS_OPTIONS: StatusFilter[] = ["published", "draft", "scheduled", "all"];
const BATCH_OPTIONS = [5, 10, 25];

// Visual treatment per newsroom role, mirroring the three-way classifier (#227).
const ROLE_BADGE: Record<ArticleSourceRow["role"], { label: string; cls: string }> = {
  evidence: { label: "Evidence", cls: "bg-emerald-600 text-white" },
  trend_marker: { label: "Trend marker", cls: "bg-sky-600 text-white" },
  rejected_junk: { label: "Rejected", cls: "bg-muted text-muted-foreground" },
};

const STATUS_BADGE: Record<ArticleSourceRow["status"], string> = {
  queued: "bg-amber-500 text-white",
  ingested: "bg-emerald-600 text-white",
  marker: "bg-sky-600 text-white",
  rejected: "bg-muted text-muted-foreground",
};

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xl font-bold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default function BackCatalog() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<StatusFilter>("published");
  const [batchSize, setBatchSize] = useState(10);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [lastReport, setLastReport] = useState<BackCatalogHarvestReport | null>(null);

  const statsQuery = useGetBackCatalogStats({ status });
  const stats = statsQuery.data;

  const sourcesQuery = useListBackCatalogSources({ limit: 100 });
  const sources = sourcesQuery.data?.items ?? [];

  const refetchAll = () => {
    qc.invalidateQueries({ queryKey: getGetBackCatalogStatsQueryKey({ status }) });
    qc.invalidateQueries({ queryKey: getListBackCatalogSourcesQueryKey({ limit: 100 }) });
  };

  const harvest = useRunBackCatalogHarvest({
    mutation: {
      onSuccess: (report) => {
        setLastReport(report);
        if (report.dryRun) {
          toast.success(
            `Dry run: ${report.linksFound} links across ${report.articlesScanned} articles (nothing written).`,
          );
        } else {
          toast.success(
            `Scanned ${report.articlesScanned} articles — ${report.queued} queued, ${report.markers} markers, ${report.rejected} rejected.`,
          );
          refetchAll();
        }
      },
      onError: () => toast.error("Harvest failed — see server logs."),
    },
  });

  const run = (dryRun: boolean) =>
    harvest.mutate({
      data: {
        dryRun,
        batchSize,
        status,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
      },
    });

  const coverage =
    stats && stats.articlesTotal > 0
      ? Math.round((stats.articlesHarvested / stats.articlesTotal) * 100)
      : 0;

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-bold flex items-center gap-2">
            <Radar className="h-6 w-6" /> Back Catalog Source Harvest
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Scan existing article bodies for outbound source links, classify each
            one, and route evidence into the Source Vault ingest queue, social
            links to trend markers, and aggregators to rejected. Building an
            article&nbsp;↔&nbsp;source graph. This scan does not call AI, fetch
            pages, or publish anything.
          </p>
        </div>
      </div>

      {/* Controls */}
      <Card className="p-4 space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1 text-sm">
            <span className="font-medium">Article status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Batch size</span>
            <select
              value={batchSize}
              onChange={(e) => setBatchSize(Number(e.target.value))}
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            >
              {BATCH_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} articles
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Created from</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium">Created to</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => run(true)} disabled={harvest.isPending}>
            {harvest.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <FlaskConical className="h-4 w-4 mr-2" />
            )}
            Dry run
          </Button>
          <Button size="sm" onClick={() => run(false)} disabled={harvest.isPending}>
            {harvest.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Scan now
          </Button>
        </div>
      </Card>

      {/* Coverage metrics */}
      {stats ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Metric label={`Articles harvested (${coverage}%)`} value={`${stats.articlesHarvested}/${stats.articlesTotal}`} />
          <Metric label="Pending scan" value={stats.articlesPending} />
          <Metric label="Evidence" value={stats.byRole.evidence} />
          <Metric label="Trend markers" value={stats.byRole.trend_marker} />
          <Metric label="Rejected" value={stats.byRole.rejected_junk} />
          <Metric label="Linked to vault" value={stats.linkedDocuments} />
        </div>
      ) : null}

      {/* Last run report */}
      {lastReport ? (
        <Card className="p-4 space-y-2">
          <div className="text-sm font-medium">
            {lastReport.dryRun ? "Dry run result (nothing written)" : "Last run"}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Scanned {lastReport.articlesScanned}</span>
            <span>With links {lastReport.articlesWithLinks}</span>
            <span>Links found {lastReport.linksFound}</span>
            <span>Queued {lastReport.queued}</span>
            <span>Already ingested {lastReport.alreadyIngested}</span>
            <span>Duplicates {lastReport.duplicatesSkipped}</span>
            <span>Markers {lastReport.markers}</span>
            <span>Rejected {lastReport.rejected}</span>
            {lastReport.urlCapReached ? (
              <span className="text-amber-600">URL cap reached — run again for more</span>
            ) : null}
          </div>
        </Card>
      ) : null}

      {/* Results table */}
      <Card className="p-0 overflow-hidden">
        <div className="px-4 py-3 border-b text-sm font-medium">Recent harvested sources</div>
        {sourcesQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : sources.length === 0 ? (
          <p className="text-sm text-muted-foreground py-12 text-center">
            No harvested sources yet. Run a scan to build the graph.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-4 py-2">Source</th>
                  <th className="text-left font-medium px-4 py-2">Article</th>
                  <th className="text-left font-medium px-4 py-2">Role</th>
                  <th className="text-left font-medium px-4 py-2">Tier</th>
                  <th className="text-left font-medium px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((row) => (
                  <tr key={row.id} className="border-t align-top">
                    <td className="px-4 py-2 max-w-xs">
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline font-medium"
                        title={row.url}
                      >
                        {hostOf(row.url)}
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                      {row.anchorText ? (
                        <div className="text-xs text-muted-foreground line-clamp-1" title={row.anchorText}>
                          “{row.anchorText}”
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 max-w-[14rem]">
                      <Link
                        href={`/article/${row.articleSlug}`}
                        className="text-muted-foreground hover:text-foreground line-clamp-1"
                        title={row.articleSlug}
                      >
                        {row.articleSlug}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${ROLE_BADGE[row.role].cls}`}
                      >
                        {ROLE_BADGE[row.role].label}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{row.tier}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_BADGE[row.status]}`}
                      >
                        {row.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
