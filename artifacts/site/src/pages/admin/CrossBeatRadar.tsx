import {
  useRunCrossBeatRadar,
  useGetCrossBeatRadarStatus,
  useListCrossBeatRadarSuggestions,
  useDismissCrossBeatRadarSuggestion,
  getGetCrossBeatRadarStatusQueryKey,
  getListCrossBeatRadarSuggestionsQueryKey,
  type CrossBeatRadarSuggestion,
  type CrossBeatRadarStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  Network,
  X,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  ArrowUpRight,
  BookOpen,
} from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { format } from "date-fns";

type StatusFilter = "pending" | "skipped" | "dismissed" | "all";

const STATUS_TABS: { id: StatusFilter; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "skipped", label: "Skipped" },
  { id: "dismissed", label: "Dismissed" },
  { id: "all", label: "All" },
];

const STATUS_PILL: Record<string, string> = {
  pending: "bg-emerald-100 text-emerald-700",
  skipped: "bg-amber-100 text-amber-700",
  dismissed: "bg-muted text-muted-foreground",
};

const SKIP_REASON_LABELS: Record<string, string> = {
  overlap: "Too similar to existing coverage",
  llm_refusal: "AI couldn't build a compelling pitch",
  author_capacity: "No author has idea-bank headroom",
  ai_paused: "AI enrichment is paused",
  llm_error: "AI call failed — will retry",
};

const TIER_COLOR: Record<string, string> = {
  primary: "text-emerald-700",
  firsthand: "text-emerald-700",
  wire: "text-blue-700",
  reported: "text-blue-600",
  commentary: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

function ScoreBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color =
    pct >= 70
      ? "bg-emerald-500"
      : pct >= 45
        ? "bg-amber-500"
        : "bg-muted-foreground/40";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 rounded-full bg-muted overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{pct}</span>
    </div>
  );
}

function SuggestionCard({
  s,
  onDismiss,
  dismissing,
}: {
  s: CrossBeatRadarSuggestion;
  onDismiss: (id: string) => void;
  dismissing: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const allBeats = [s.primaryBeatSlug, ...s.secondaryBeatSlugs];
  const evidence = s.evidenceSnapshot ?? [];
  const uniqueFamilies = new Set(evidence.map((e) => e.familyId ?? e.docId)).size;
  const topTier = evidence.find((e) =>
    ["primary", "firsthand", "wire"].includes(e.tier),
  )?.tier;

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {/* Header metadata row */}
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span
              className={`text-xs px-2 py-0.5 rounded-full capitalize ${STATUS_PILL[s.status] ?? "bg-muted text-muted-foreground"}`}
            >
              {s.status}
            </span>

            {/* Concept badge */}
            <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
              {s.conceptTerm}
            </span>

            {/* Beat badges — primary first, then secondary */}
            {allBeats.map((b, i) => (
              <span
                key={b}
                className={`text-xs px-2 py-0.5 rounded-full ${
                  i === 0
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {i > 0 ? "× " : ""}
                {b.replace(/-/g, " ")}
              </span>
            ))}

            <ScoreBar score={s.score} />

            <span className="text-xs text-muted-foreground ml-auto">
              {format(new Date(s.createdAt), "MMM d, yyyy")}
            </span>
          </div>

          {/* Title + angle (only when the radar pitched an idea) */}
          {s.title ? (
            <>
              <h3 className="font-serif font-bold text-lg leading-snug mb-1">
                {s.title}
              </h3>
              <p className="text-sm text-muted-foreground">{s.angle}</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              {s.skipReason
                ? (SKIP_REASON_LABELS[s.skipReason] ?? s.skipReason)
                : "No pitch generated."}
            </p>
          )}

          {/* Evidence summary */}
          {evidence.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>
                <span className="font-medium text-foreground">
                  {evidence.length}
                </span>{" "}
                evidence source{evidence.length !== 1 ? "s" : ""}
              </span>
              <span>
                <span className="font-medium text-foreground">
                  {uniqueFamilies}
                </span>{" "}
                independent famil{uniqueFamilies !== 1 ? "ies" : "y"}
              </span>
              {topTier && (
                <span className={TIER_COLOR[topTier] ?? ""}>
                  Strongest: {topTier}
                </span>
              )}
            </div>
          )}

          {/* Bridge-beat weights */}
          {(s.bridgeBeats?.length ?? 0) > 0 && (
            <div className="mt-2 flex flex-wrap gap-3">
              {s.bridgeBeats!.map((b) => (
                <span key={b.beatSlug} className="text-xs text-muted-foreground">
                  {b.beatSlug.replace(/-/g, " ")}:{" "}
                  <span className="font-medium text-foreground">
                    {(b.weight * 100).toFixed(0)}%
                  </span>
                </span>
              ))}
            </div>
          )}

          {/* Evidence source list toggle */}
          {evidence.length > 0 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {expanded ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              {expanded ? "Hide" : "Show"} sources
            </button>
          )}

          {expanded && (
            <ul className="mt-2 space-y-1">
              {evidence.map((e) => (
                <li key={e.docId} className="flex items-baseline gap-2 text-xs">
                  <span
                    className={`shrink-0 font-medium ${TIER_COLOR[e.tier] ?? "text-muted-foreground"}`}
                  >
                    [{e.tier}]
                  </span>
                  <a
                    href={e.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate text-primary hover:underline flex items-center gap-1"
                  >
                    {e.url}
                    <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Action column */}
        <div className="flex flex-col gap-2 shrink-0">
          {s.status === "pending" && s.ideaId && (
            <a
              href="/admin/ideas"
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-primary/40 text-primary hover:bg-primary/5 transition-colors"
            >
              <ArrowUpRight className="h-3 w-3" />
              View idea
            </a>
          )}
          <a
            href={`/glossary/${s.conceptSlug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-muted/50 transition-colors"
          >
            <BookOpen className="h-3 w-3" />
            Concept
          </a>
          {s.status === "pending" && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={() => onDismiss(s.id)}
              disabled={dismissing}
            >
              {dismissing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <X className="h-3 w-3" />
              )}
              Dismiss
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function CrossBeatRadar() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const qc = useQueryClient();

  const { data: radarStatus } = useGetCrossBeatRadarStatus({
    query: {
      queryKey: getGetCrossBeatRadarStatusQueryKey(),
      refetchInterval: (query) => {
        const d = query.state.data as CrossBeatRadarStatus | undefined;
        return d?.running ? 4000 : 8000;
      },
    },
  });

  const running = radarStatus?.running ?? false;
  const counts = radarStatus?.counts ?? { pending: 0, dismissed: 0, skipped: 0 };
  const totalAll = counts.pending + counts.dismissed + counts.skipped;

  const listParams =
    statusFilter === "all" ? {} : { status: statusFilter as "pending" | "dismissed" | "skipped" };

  const { data, isLoading } = useListCrossBeatRadarSuggestions(listParams, {
    query: {
      queryKey: getListCrossBeatRadarSuggestionsQueryKey(listParams),
      refetchInterval: running ? 5000 : false,
    },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetCrossBeatRadarStatusQueryKey() });
    qc.invalidateQueries({ queryKey: ["listCrossBeatRadarSuggestions"] });
  };

  const run = useRunCrossBeatRadar({
    mutation: {
      onSuccess: (res) => {
        if (res.started) {
          toast.success(
            "Radar run started — suggestions appear when the scan finishes.",
          );
        } else {
          toast.info("A radar run is already in progress.");
        }
        invalidate();
      },
      onError: () => toast.error("Could not start a radar run."),
    },
  });

  const dismiss = useDismissCrossBeatRadarSuggestion({
    mutation: {
      onSuccess: (res) => {
        toast.success(
          `Dismissed.${res.ideaRejected ? " The linked pending idea was also rejected." : ""}`,
        );
        invalidate();
      },
      onError: () => toast.error("Could not dismiss this suggestion."),
    },
  });

  const items = data?.suggestions ?? [];

  const countFor = (s: StatusFilter) => {
    if (s === "all") return totalAll;
    if (s === "pending") return counts.pending;
    if (s === "dismissed") return counts.dismissed;
    return counts.skipped;
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="font-serif text-3xl font-bold mb-1 flex items-center gap-2">
            <Network className="h-7 w-7 text-primary" />
            Cross-Beat Radar
          </h1>
          <p className="text-muted-foreground text-sm max-w-2xl">
            Surfaces story opportunities where BrainHook's concept graph and
            Source Vault evidence connect across two or more beats — grounded
            in real sources, not invented angles. Each pitched suggestion
            becomes a pending topic idea the editorial team can promote or
            dismiss.
          </p>
        </div>
        <Button
          onClick={() => run.mutate()}
          disabled={running || run.isPending}
        >
          {running || run.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <Network className="h-4 w-4 mr-2" />
          )}
          {running ? "Running…" : "Run radar"}
        </Button>
      </div>

      {/* Running progress notice */}
      {running && (
        <Card className="p-3 mb-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin shrink-0 text-primary" />
          Scanning bridge concepts and scoring candidates — new suggestions
          will appear when the run finishes.
        </Card>
      )}

      {/* Status summary chips */}
      <div className="flex flex-wrap gap-4 mb-5 text-sm">
        <span>
          <span className="font-medium">{counts.pending}</span>{" "}
          <span className="text-muted-foreground">pending</span>
        </span>
        <span>
          <span className="font-medium">{counts.skipped}</span>{" "}
          <span className="text-muted-foreground">skipped</span>
        </span>
        <span>
          <span className="font-medium">{counts.dismissed}</span>{" "}
          <span className="text-muted-foreground">dismissed</span>
        </span>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-2 flex-wrap mb-5">
        {STATUS_TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setStatusFilter(id)}
            className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
              statusFilter === id
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {label}{" "}
            <span className="opacity-70">({countFor(id)})</span>
          </button>
        ))}
      </div>

      {/* Suggestion list */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {statusFilter === "pending"
            ? "No pending suggestions. Run the radar to discover new cross-beat story opportunities."
            : "Nothing here yet."}
        </p>
      ) : (
        <div className="space-y-3">
          {[...items]
            .sort((a, b) => b.score - a.score)
            .map((s) => (
              <SuggestionCard
                key={s.id}
                s={s}
                onDismiss={(id) => dismiss.mutate({ id })}
                dismissing={
                  dismiss.isPending &&
                  (dismiss.variables as { id?: string } | undefined)?.id === s.id
                }
              />
            ))}
        </div>
      )}
    </div>
  );
}
