import { useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import {
  useGetShadowMetrics,
  getGetShadowMetricsQueryKey,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Gauge, AlertTriangle } from "lucide-react";

type RangeKey = "7" | "30" | "90" | "all";

const RANGES: { key: RangeKey; label: string; days: number | null }[] = [
  { key: "7", label: "Last 7 days", days: 7 },
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 90 days", days: 90 },
  { key: "all", label: "All time", days: null },
];

const DAY_MS = 86400000;

function usd(n: number): string {
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

const DECISION_LABELS: Record<string, string> = {
  approve_draft: "Approve → draft",
  approve_research: "Approve → research",
  needs_human_editor: "Needs human editor",
  reject_duplicate: "Reject — duplicate",
  reject_too_thin: "Reject — too thin",
  reject_low_authority: "Reject — low authority",
  reject_stale: "Reject — stale",
  reject_out_of_beat: "Reject — out of beat",
  reject_too_risky: "Reject — too risky",
};

const REASON_LABELS: Record<string, string> = {
  duplicate: "Duplicate",
  boring: "Boring / no hook",
  weak_source: "Weak source",
  bad_angle: "Bad angle",
  too_late: "Too late",
  wrong_beat: "Wrong beat",
  bad_draft: "Bad draft",
  legal_medical_political_risk: "Legal / medical / political risk",
};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground mt-1">{label}</div>
      {hint && <div className="text-[11px] text-muted-foreground/70 mt-1">{hint}</div>}
    </Card>
  );
}

export default function ShadowMetrics() {
  const [range, setRange] = useState<RangeKey>("30");

  const params = useMemo(() => {
    const cfg = RANGES.find((r) => r.key === range)!;
    if (cfg.days == null) return {} as { from?: string; to?: string };
    const to = Date.now();
    const from = to - cfg.days * DAY_MS;
    return { from: String(from), to: String(to) };
  }, [range]);

  const { data, isLoading, isError } = useGetShadowMetrics(params, {
    query: {
      queryKey: getGetShadowMetricsQueryKey(params),
      staleTime: 30000,
      placeholderData: keepPreviousData,
    },
  });

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-serif text-3xl font-bold flex items-center gap-2">
            <Gauge className="h-7 w-7 text-primary" /> Shadow metrics
          </h1>
          <p className="text-muted-foreground text-sm mt-1 max-w-2xl">
            Recorded outcomes from the research → screening → draft pipeline. Every number
            here is measured from what actually happened — nothing is estimated or projected.
          </p>
        </div>
        <div className="flex gap-1 bg-muted rounded-lg p-1">
          {RANGES.map((r) => (
            <Button
              key={r.key}
              size="sm"
              variant={range === r.key ? "default" : "ghost"}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      {isError ? (
        <Card className="p-8 text-center text-muted-foreground">
          <AlertTriangle className="h-6 w-6 mx-auto mb-2" />
          Could not load metrics.
        </Card>
      ) : isLoading || !data ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* Headline */}
          <Card className="p-6 bg-primary/5 border-primary/20">
            <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
              Recorded cost per verified draft
            </div>
            <div className="text-4xl font-bold tabular-nums">
              {usd(data.drafts.costPerVerifiedDraftUsd)}
            </div>
            <div className="text-sm text-muted-foreground mt-2">
              {usd(data.drafts.productionCostUsd)} production spend ÷{" "}
              {data.drafts.verifiedDrafts.toLocaleString()} draft
              {data.drafts.verifiedDrafts === 1 ? "" : "s"} created in this window.
            </div>
          </Card>

          {/* Spend */}
          <section>
            <h2 className="font-semibold text-sm mb-2">Recorded spend</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Total spend" value={usd(data.spend.totalUsd)} />
              <Stat label="Web search" value={usd(data.spend.webSearchUsd)} hint={`${data.spend.webSearches.toLocaleString()} searches`} />
              <Stat label="Images" value={usd(data.spend.imageUsd)} hint={`${data.spend.images.toLocaleString()} images`} />
              <Stat label="AI calls" value={data.spend.calls.toLocaleString()} />
            </div>
          </section>

          {/* Screening funnel */}
          <section>
            <h2 className="font-semibold text-sm mb-2">Screening quality</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
              <Stat label="Evidence packets" value={data.screening.totalPackets.toLocaleString()} />
              <Stat label="Acceptance rate" value={pct(data.screening.acceptanceRatePct)} hint="approve → draft/research" />
              <Stat label="Rejection rate" value={pct(data.screening.rejectionRatePct)} />
              <Stat label="Quarantine rate" value={pct(data.screening.quarantineRatePct)} hint="needs human editor" />
            </div>
            {data.screening.byDecision.length > 0 && (
              <Card className="p-4">
                <div className="space-y-1.5">
                  {data.screening.byDecision.map((d) => {
                    const max = Math.max(...data.screening.byDecision.map((x) => x.count), 1);
                    const width = Math.round((d.count / max) * 100);
                    return (
                      <div key={d.decision} className="flex items-center gap-2 text-sm">
                        <div className="w-44 shrink-0 truncate text-xs" title={DECISION_LABELS[d.decision] ?? d.decision}>
                          {DECISION_LABELS[d.decision] ?? d.decision}
                        </div>
                        <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
                          <div className="bg-primary h-full rounded-full" style={{ width: `${width}%` }} />
                        </div>
                        <div className="w-12 text-right tabular-nums text-xs font-semibold">{d.count}</div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}
          </section>

          {/* Source reuse */}
          <section>
            <h2 className="font-semibold text-sm mb-2">Source reuse &amp; cost avoidance</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Vault-only packets" value={data.sourceReuse.vaultOnlyPackets.toLocaleString()} hint={`${pct(data.sourceReuse.vaultOnlyRatePct)} of packets`} />
              <Stat label="Paid research" value={data.sourceReuse.paidResearchPackets.toLocaleString()} hint="sonar + deep research" />
              <Stat label="Vault hits reused" value={data.sourceReuse.totalVaultHits.toLocaleString()} />
              <Stat label="Duplicates blocked" value={data.duplicateAvoidance.rejectDuplicatePackets.toLocaleString()} hint="rejected at screening" />
            </div>
          </section>

          {/* Editor feedback loop */}
          <section>
            <h2 className="font-semibold text-sm mb-2">Editor feedback loop</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
              <Stat label="Actions taken" value={data.editorFeedback.totalActions.toLocaleString()} />
              <Stat label="Promotes" value={data.editorFeedback.promotes.toLocaleString()} />
              <Stat label="Rejects" value={data.editorFeedback.rejects.toLocaleString()} />
            </div>
            {data.editorFeedback.byRejectionReason.some((r) => r.count > 0) && (
              <Card className="p-4">
                <div className="text-xs text-muted-foreground mb-2">Rejections by reason</div>
                <div className="space-y-1.5">
                  {data.editorFeedback.byRejectionReason
                    .filter((r) => r.count > 0)
                    .sort((a, b) => b.count - a.count)
                    .map((r) => {
                      const max = Math.max(...data.editorFeedback.byRejectionReason.map((x) => x.count), 1);
                      const width = Math.round((r.count / max) * 100);
                      return (
                        <div key={r.reason} className="flex items-center gap-2 text-sm">
                          <div className="w-44 shrink-0 truncate text-xs" title={REASON_LABELS[r.reason] ?? r.reason}>
                            {REASON_LABELS[r.reason] ?? r.reason}
                          </div>
                          <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
                            <div className="bg-destructive h-full rounded-full" style={{ width: `${width}%` }} />
                          </div>
                          <div className="w-12 text-right tabular-nums text-xs font-semibold">{r.count}</div>
                        </div>
                      );
                    })}
                </div>
              </Card>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
