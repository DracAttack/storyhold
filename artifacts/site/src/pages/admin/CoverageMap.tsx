import {
  useGetCoverageMapStatus,
  useListCoverageMapItems,
  useTriggerCoverageMapRecalculate,
  usePromoteCoverageMapItem,
  useSetCoverageMapEditorialState,
  getGetCoverageMapStatusQueryKey,
  getListCoverageMapItemsQueryKey,
} from "@workspace/api-client-react";
import type {
  CoverageMapItemSummary,
  ListCoverageMapItemsParams,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { useState, useCallback } from "react";
import { format } from "date-fns";
import {
  Map,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Loader2,
  Sparkles,
  TrendingUp,
  BookOpen,
  BarChart2,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Eye,
  AlertCircle,
} from "lucide-react";
import AdminLayout from "./AdminLayout";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type Classification =
  | "strong_evidence_missing_coverage"
  | "heavy_coverage_weak_evidence"
  | "rising_evidence_stale_coverage"
  | "saturated_territory"
  | "insufficient_data";

type EditorialState =
  | "none"
  | "actively_expanding"
  | "intentionally_complete"
  | "intentionally_limited"
  | "waiting_for_evidence"
  | "watch_only"
  | "not_a_priority";

const SECTIONS: Array<{
  classification: Classification;
  label: string;
  description: string;
  icon: React.ElementType;
  color: string;
  bg: string;
}> = [
  {
    classification: "strong_evidence_missing_coverage",
    label: "Strong Evidence, Missing Coverage",
    description: "Well-sourced topics with no or shallow articles — your best commission targets.",
    icon: Sparkles,
    color: "text-emerald-600",
    bg: "bg-emerald-50 border-emerald-200",
  },
  {
    classification: "rising_evidence_stale_coverage",
    label: "Rising Evidence, Stale Coverage",
    description: "Fresh sources are accumulating but existing articles haven't caught up.",
    icon: TrendingUp,
    color: "text-amber-600",
    bg: "bg-amber-50 border-amber-200",
  },
  {
    classification: "heavy_coverage_weak_evidence",
    label: "Heavy Coverage, Weak Evidence",
    description: "Topics with many articles but thin sourcing — candidates for a rewrite.",
    icon: AlertCircle,
    color: "text-rose-600",
    bg: "bg-rose-50 border-rose-200",
  },
  {
    classification: "saturated_territory",
    label: "Saturated Territory",
    description: "Both well-covered and well-sourced. Monitor only unless a new angle emerges.",
    icon: BookOpen,
    color: "text-slate-500",
    bg: "bg-slate-50 border-slate-200",
  },
];

const EDITORIAL_STATE_LABELS: Record<EditorialState, string> = {
  none: "No decision",
  actively_expanding: "Actively expanding",
  intentionally_complete: "Intentionally complete",
  intentionally_limited: "Intentionally limited",
  waiting_for_evidence: "Waiting for evidence",
  watch_only: "Watch only",
  not_a_priority: "Not a priority",
};

// Must cover every RECOMMENDED_ACTIONS value the backend can emit.
const ACTION_LABELS: Record<string, string> = {
  create_foundational_article: "Create foundational article",
  create_cross_beat_synthesis: "Create cross-beat synthesis",
  build_evidence_packet: "Build evidence packet",
  find_more_sources: "Find more sources",
  update_existing_article: "Update existing article",
  strengthen_glossary_evidence: "Strengthen glossary evidence",
  avoid_additional_general_coverage: "Avoid additional general coverage",
  review_source_health: "Review source health",
  mark_intentionally_complete: "Mark intentionally complete",
  monitor_only: "Monitor only",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ScoreBar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-28 text-muted-foreground truncate">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-primary/60"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-7 text-right tabular-nums text-muted-foreground">{pct}</span>
    </div>
  );
}

function OpportunityRing({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color =
    pct >= 70 ? "text-emerald-600" : pct >= 40 ? "text-amber-500" : "text-muted-foreground";
  return (
    <div className={`flex flex-col items-center justify-center ${color}`}>
      <span className="text-2xl font-bold tabular-nums leading-none">{pct}</span>
      <span className="text-[10px] uppercase tracking-wide mt-0.5 text-muted-foreground">score</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item row
// ---------------------------------------------------------------------------

function ItemRow({
  item,
  onPromoted,
}: {
  item: CoverageMapItemSummary;
  onPromoted: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const qc = useQueryClient();

  const promote = usePromoteCoverageMapItem({
    mutation: {
      onSuccess: (data) => {
        toast.success(`Promoted "${item.term}" → idea created`);
        onPromoted();
        qc.invalidateQueries({ queryKey: getListCoverageMapItemsQueryKey() });
      },
      onError: (e: any) => {
        const msg = e?.response?.data?.error ?? "Failed to promote";
        toast.error(msg);
      },
    },
  });

  const setEditorial = useSetCoverageMapEditorialState({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListCoverageMapItemsQueryKey() });
      },
      onError: () => toast.error("Failed to save editorial decision"),
    },
  });

  const handleEditorialChange = (state: string) => {
    setEditorial.mutate({
      id: item.id,
      data: { editorialState: state as EditorialState },
    });
  };

  const actionLabel = ACTION_LABELS[item.recommendedAction] ?? item.recommendedAction;
  const promoted = !!item.ideaId;

  return (
    <div className="border rounded-lg bg-card overflow-hidden">
      <button
        className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-muted/40 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="w-14 shrink-0 pt-0.5">
          <OpportunityRing score={item.opportunityScore} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold truncate">{item.term}</span>
            {promoted && (
              <Badge variant="secondary" className="text-xs gap-1">
                <CheckCircle2 className="h-3 w-3" /> Idea created
              </Badge>
            )}
            {item.editorialState !== "none" && (
              <Badge variant="outline" className="text-xs">
                {EDITORIAL_STATE_LABELS[item.editorialState as EditorialState]}
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
            <ArrowUpRight className="h-3 w-3 shrink-0" />
            {actionLabel}
            <span className="mx-1 opacity-40">·</span>
            <Clock className="h-3 w-3 shrink-0" />
            {format(new Date(item.calculatedAt), "MMM d")}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 pt-1">
          {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 space-y-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
            <ScoreBar value={item.evidenceStrength} label="Evidence strength" />
            <ScoreBar value={item.sourceDiversity} label="Source diversity" />
            <ScoreBar value={item.evidenceFreshness} label="Evidence freshness" />
            <ScoreBar value={item.coverageDepth} label="Coverage depth" />
            <ScoreBar value={item.articleUniqueness} label="Article uniqueness" />
            <ScoreBar value={item.readerInterest} label="Reader interest" />
            <ScoreBar value={item.updateUrgency} label="Update urgency" />
            <ScoreBar value={item.saturation} label="Saturation" />
          </div>

          <div className="flex items-center gap-3 flex-wrap pt-1">
            <div className="flex-1 min-w-48">
              <Select
                value={item.editorialState}
                onValueChange={handleEditorialChange}
                disabled={setEditorial.isPending}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Editorial decision…" />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(EDITORIAL_STATE_LABELS).map(([v, l]) => (
                    <SelectItem key={v} value={v} className="text-xs">
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant={promoted ? "secondary" : "default"}
                    className="h-8 text-xs gap-1"
                    disabled={promoted || promote.isPending}
                    onClick={() => promote.mutate({ id: item.id })}
                  >
                    {promote.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Sparkles className="h-3 w-3" />
                    )}
                    {promoted ? "Promoted" : "Promote to idea"}
                  </Button>
                </TooltipTrigger>
                {promoted && (
                  <TooltipContent>Already has an idea linked</TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section panel
// ---------------------------------------------------------------------------

function SectionPanel({
  classification,
  label,
  description,
  icon: Icon,
  color,
  bg,
  count,
}: (typeof SECTIONS)[0] & { count: number }) {
  const [open, setOpen] = useState(classification === "strong_evidence_missing_coverage");
  const [page, setPage] = useState(0);
  const LIMIT = 20;

  const params: ListCoverageMapItemsParams = {
    classification,
    sort: "opportunity",
    order: "desc",
    limit: LIMIT,
    offset: page * LIMIT,
  };

  const { data, isLoading, refetch } = useListCoverageMapItems(params, {
    query: {
      queryKey: getListCoverageMapItemsQueryKey(params),
      enabled: open,
      staleTime: 60_000,
    },
  });

  const handlePromoted = useCallback(() => refetch(), [refetch]);

  return (
    <div className={`rounded-xl border ${bg} overflow-hidden`}>
      <button
        className="w-full text-left px-5 py-4 flex items-center gap-3"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon className={`h-5 w-5 shrink-0 ${color}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold">{label}</span>
            <Badge variant="secondary" className="text-xs">{count}</Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {open && (
        <div className="bg-background border-t px-4 py-3 space-y-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : !data || data.items.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-6">No items in this section.</p>
          ) : (
            <>
              {data.items.map((item) => (
                <ItemRow key={item.id} item={item} onPromoted={handlePromoted} />
              ))}
              {(data.total > LIMIT) && (
                <div className="flex items-center justify-between pt-2">
                  <span className="text-xs text-muted-foreground">
                    {page * LIMIT + 1}–{Math.min((page + 1) * LIMIT, data.total)} of {data.total}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={page === 0}
                      onClick={() => setPage((p) => p - 1)}
                    >
                      Prev
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={(page + 1) * LIMIT >= data.total}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function CoverageMapPage() {
  const qc = useQueryClient();

  const { data: status, isLoading: statusLoading } = useGetCoverageMapStatus({
    query: {
      queryKey: getGetCoverageMapStatusQueryKey(),
      refetchInterval: (query) => (query.state.data?.running ? 4000 : false),
    },
  });

  const recalculate = useTriggerCoverageMapRecalculate({
    mutation: {
      onSuccess: () => {
        toast.success("Coverage map recalculation started");
        qc.invalidateQueries({ queryKey: getGetCoverageMapStatusQueryKey() });
      },
      onError: (e: any) => {
        const msg = e?.response?.data?.error ?? "Already running";
        toast.error(msg);
      },
    },
  });

  const isRunning = status?.running ?? false;

  return (
    <AdminLayout>
      <div className="space-y-6 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <Map className="h-7 w-7 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">Living Coverage Map</h1>
              <p className="text-sm text-muted-foreground">
                Evidence vs. coverage balance across all concepts. Zero AI — computed daily.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => recalculate.mutate()}
            disabled={isRunning || recalculate.isPending}
          >
            {isRunning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {isRunning ? "Recalculating…" : "Recalculate"}
          </Button>
        </div>

        {/* Status bar */}
        {!statusLoading && status && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <Card className="col-span-2 sm:col-span-1">
              <CardContent className="pt-4 pb-3">
                <div className="flex items-center gap-2">
                  <BarChart2 className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">Total</span>
                </div>
                <div className="text-2xl font-bold mt-1">{status.total}</div>
                {status.lastCalculatedAt && (
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Updated {format(new Date(status.lastCalculatedAt), "MMM d, HH:mm")}
                  </div>
                )}
              </CardContent>
            </Card>

            {SECTIONS.slice(0, 4).map((s) => {
              const cnt = status.byClassification?.[s.classification] ?? 0;
              const Icon = s.icon;
              return (
                <Card key={s.classification}>
                  <CardContent className="pt-4 pb-3">
                    <div className="flex items-center gap-1.5">
                      <Icon className={`h-3.5 w-3.5 ${s.color}`} />
                      <span className="text-xs text-muted-foreground truncate leading-tight">{s.label.split(",")[0]}</span>
                    </div>
                    <div className={`text-2xl font-bold mt-1 ${s.color}`}>{cnt}</div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {statusLoading && (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* Sections */}
        {!statusLoading && (
          <div className="space-y-4">
            {SECTIONS.map((section) => (
              <SectionPanel
                key={section.classification}
                {...section}
                count={status?.byClassification?.[section.classification] ?? 0}
              />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!statusLoading && status && status.total === 0 && (
          <Card>
            <CardContent className="py-12 text-center space-y-3">
              <Eye className="h-8 w-8 text-muted-foreground mx-auto" />
              <p className="text-sm text-muted-foreground">
                No coverage map data yet. Click <strong>Recalculate</strong> to run the first pass.
              </p>
              <Button
                onClick={() => recalculate.mutate()}
                disabled={isRunning || recalculate.isPending}
              >
                {isRunning ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                Run now
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
