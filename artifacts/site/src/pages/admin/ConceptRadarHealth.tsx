/**
 * Admin → Concepts — Cross-Beat Radar queue & Concept Evidence Health alerts
 * (Task #340). Rendered inside the Concepts page; follows the same
 * apiFetch + useQuery/useMutation pattern as the rest of the admin.
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Radar,
  HeartPulse,
  Play,
  RefreshCw,
  X,
  ArrowUpRight,
  Pickaxe,
  ExternalLink,
} from "lucide-react";

// ---------------------------------------------------------------------------
// API helper (same contract as Concepts.tsx apiFetch)
// ---------------------------------------------------------------------------

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`/api/admin${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...opts?.headers },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Types (mirror the OpenAPI schemas)
// ---------------------------------------------------------------------------

interface RadarSuggestion {
  id: string;
  conceptId: string;
  conceptTerm: string;
  conceptSlug: string;
  primaryBeatSlug: string;
  secondaryBeatSlugs: string[];
  title: string;
  angle: string;
  score: number;
  bridgeBeats: Array<{ beatSlug: string; weight: number }> | null;
  evidenceSnapshot: Array<{ docId: string; url: string; tier: string }> | null;
  status: "pending" | "dismissed" | "skipped";
  skipReason: string | null;
  ideaId: string | null;
  createdAt: string;
}

interface RadarStatus {
  running: boolean;
  counts: { pending: number; dismissed: number; skipped: number };
}

interface HealthAlert {
  id: string;
  conceptId: string;
  conceptTerm: string;
  conceptSlug: string;
  alertType: "weak_support" | "coverage_opportunity" | "stale_conflict";
  status: "open" | "dismissed" | "resolved" | "promoted";
  detail: {
    activeTrustedCount?: number;
    independentFamilyCount?: number;
    newestEvidenceAt?: string | null;
    retractedLinkedCount?: number;
    articleMentionCount?: number;
    demandViews30d?: number;
    linkedArticles?: Array<{ id: string; slug: string; title: string }>;
  } | null;
  ideaId: string | null;
  createdAt: string;
}

interface HealthStatus {
  running: boolean;
  conceptsTracked: number;
  lastComputedAt: string | null;
  alertCounts: { open: number; dismissed: number; resolved: number; promoted: number };
}

const ALERT_TYPE_LABEL: Record<HealthAlert["alertType"], string> = {
  weak_support: "Weak support",
  coverage_opportunity: "Coverage opportunity",
  stale_conflict: "Stale conflict",
};

const ALERT_TYPE_CLASS: Record<HealthAlert["alertType"], string> = {
  weak_support: "text-amber-600",
  coverage_opportunity: "text-emerald-600",
  stale_conflict: "text-destructive",
};

const SKIP_REASON_LABEL: Record<string, string> = {
  overlap: "too close to existing coverage",
  llm_refusal: "AI declined the pitch",
  author_capacity: "no author capacity",
  ai_paused: "AI function paused",
  llm_error: "AI error",
};

// ---------------------------------------------------------------------------
// Cross-Beat Radar section
// ---------------------------------------------------------------------------

function RadarSection() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"pending" | "dismissed" | "skipped">("pending");

  const status = useQuery<RadarStatus>({
    queryKey: ["admin-concept-radar-status"],
    queryFn: () => apiFetch("/concept-radar/status"),
    refetchInterval: (q) => (q.state.data?.running ? 5_000 : 30_000),
  });

  const suggestions = useQuery<{ suggestions: RadarSuggestion[]; total: number }>({
    queryKey: ["admin-concept-radar-suggestions", statusFilter],
    queryFn: () => apiFetch(`/concept-radar/suggestions?status=${statusFilter}&limit=25`),
    refetchInterval: status.data?.running ? 5_000 : false,
  });

  const run = useMutation({
    mutationFn: () => apiFetch("/concept-radar/run", { method: "POST" }),
    onSuccess: () => {
      toast.success("Radar run started — pitches appear below as they land");
      void qc.invalidateQueries({ queryKey: ["admin-concept-radar-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const dismiss = useMutation({
    mutationFn: (id: string) => apiFetch(`/concept-radar/suggestions/${id}/dismiss`, { method: "POST" }),
    onSuccess: (res: { ideaRejected: boolean }) => {
      toast.success(res.ideaRejected ? "Suggestion dismissed and its idea rejected" : "Suggestion dismissed");
      void qc.invalidateQueries({ queryKey: ["admin-concept-radar-suggestions"] });
      void qc.invalidateQueries({ queryKey: ["admin-concept-radar-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const counts = status.data?.counts;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Radar className="h-4 w-4" />
          Cross-Beat Radar
        </h2>
        {status.data?.running && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <RefreshCw className="h-3 w-3 animate-spin" />
            scanning…
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {(["pending", "dismissed", "skipped"] as const).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={statusFilter === s ? "secondary" : "ghost"}
              className="h-7 text-xs capitalize"
              onClick={() => setStatusFilter(s)}
            >
              {s}
              {counts ? ` (${counts[s]})` : ""}
            </Button>
          ))}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => run.mutate()}
            disabled={run.isPending || status.data?.running}
          >
            <Play className="h-3 w-3 mr-1" />
            Run now
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Finds bridge concepts (evidence-rich topics spanning two or more beats) and pitches
        cross-beat story ideas. Runs nightly; each pitch lands in the idea gallery as pending.
      </p>
      {suggestions.data && suggestions.data.suggestions.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No {statusFilter} suggestions{statusFilter === "pending" ? " — run the radar or wait for the nightly pass" : ""}.
        </p>
      )}
      {suggestions.data && suggestions.data.suggestions.length > 0 && (
        <div className="rounded-xl border border-border divide-y divide-border overflow-hidden">
          {suggestions.data.suggestions.map((s) => (
            <div key={s.id} className="px-4 py-3 space-y-1.5 text-sm">
              <div className="flex items-start gap-2 flex-wrap">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{s.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{s.angle}</p>
                </div>
                {s.status === "pending" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs shrink-0"
                    onClick={() => dismiss.mutate(s.id)}
                    disabled={dismiss.isPending}
                  >
                    <X className="h-3 w-3 mr-1" />
                    Dismiss
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                <Badge variant="outline" className="text-xs">{s.conceptTerm}</Badge>
                <span>
                  {s.primaryBeatSlug}
                  {s.secondaryBeatSlugs.length > 0 && ` ↔ ${s.secondaryBeatSlugs.join(", ")}`}
                </span>
                {s.bridgeBeats && s.bridgeBeats.length > 0 && (
                  <span>
                    weights:{" "}
                    {s.bridgeBeats.map((b) => `${b.beatSlug} ${(b.weight * 100).toFixed(0)}%`).join(" · ")}
                  </span>
                )}
                {s.evidenceSnapshot && s.evidenceSnapshot.length > 0 && (
                  <span>
                    {s.evidenceSnapshot.length} supporting source{s.evidenceSnapshot.length !== 1 ? "s" : ""}
                    {" ("}
                    {Array.from(new Set(s.evidenceSnapshot.map((e) => e.tier))).join(", ")}
                    {")"}
                  </span>
                )}
                {s.status === "skipped" && s.skipReason && (
                  <Badge variant="outline" className="text-xs text-amber-600">
                    {SKIP_REASON_LABEL[s.skipReason] ?? s.skipReason}
                  </Badge>
                )}
                {s.ideaId && s.status === "pending" && (
                  <a href="/admin/ideas" className="text-primary hover:underline inline-flex items-center gap-0.5">
                    idea created <ArrowUpRight className="h-3 w-3" />
                  </a>
                )}
                <span className="ml-auto">{new Date(s.createdAt).toLocaleDateString()}</span>
              </div>
              {s.evidenceSnapshot && s.evidenceSnapshot.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  {s.evidenceSnapshot.slice(0, 4).map((e) => (
                    <a
                      key={e.docId}
                      href={e.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-primary inline-flex items-center gap-0.5 max-w-[16rem] truncate"
                      title={e.url}
                    >
                      <ExternalLink className="h-3 w-3 shrink-0" />
                      <span className="truncate">{new URL(e.url).hostname.replace(/^www\./, "")}</span>
                      <span className="text-muted-foreground/60">({e.tier})</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Evidence Health section
// ---------------------------------------------------------------------------

function HealthSection() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"open" | "dismissed" | "resolved" | "promoted">("open");

  const status = useQuery<HealthStatus>({
    queryKey: ["admin-concept-health-status"],
    queryFn: () => apiFetch("/concept-health/status"),
    refetchInterval: (q) => (q.state.data?.running ? 5_000 : 30_000),
  });

  const alerts = useQuery<{ alerts: HealthAlert[]; total: number }>({
    queryKey: ["admin-concept-health-alerts", statusFilter],
    queryFn: () => apiFetch(`/concept-health/alerts?status=${statusFilter}&limit=25`),
    refetchInterval: status.data?.running ? 5_000 : false,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["admin-concept-health-alerts"] });
    void qc.invalidateQueries({ queryKey: ["admin-concept-health-status"] });
  };

  const run = useMutation({
    mutationFn: () => apiFetch("/concept-health/run", { method: "POST" }),
    onSuccess: () => {
      toast.success("Evidence health pass started (deterministic, no AI cost)");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const dismiss = useMutation({
    mutationFn: (id: string) => apiFetch(`/concept-health/alerts/${id}/dismiss`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Alert dismissed — it will not recur for this concept");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const promote = useMutation({
    mutationFn: (id: string) => apiFetch(`/concept-health/alerts/${id}/promote`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Promoted — a pending idea was added to the gallery");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const harvest = useMutation({
    mutationFn: (id: string) => apiFetch(`/concept-health/alerts/${id}/harvest`, { method: "POST" }),
    onSuccess: (res: { leads: number; enqueued: number }) => {
      toast.success(
        `Harvest complete — ${res.enqueued} of ${res.leads} lead${res.leads !== 1 ? "s" : ""} queued for the Source Vault`,
      );
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const s = status.data;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <HeartPulse className="h-4 w-4" />
          Evidence Health
        </h2>
        {s?.running && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <RefreshCw className="h-3 w-3 animate-spin" />
            computing…
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {(["open", "dismissed", "resolved", "promoted"] as const).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={statusFilter === f ? "secondary" : "ghost"}
              className="h-7 text-xs capitalize"
              onClick={() => setStatusFilter(f)}
            >
              {f}
              {s ? ` (${s.alertCounts[f]})` : ""}
            </Button>
          ))}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => run.mutate()}
            disabled={run.isPending || s?.running}
          >
            <Play className="h-3 w-3 mr-1" />
            Run now
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Nightly scorecard of each live concept's evidence base (trusted sources, independent
        outlets, freshness).
        {s && s.conceptsTracked > 0 && (
          <>
            {" "}
            {s.conceptsTracked} concept{s.conceptsTracked !== 1 ? "s" : ""} tracked
            {s.lastComputedAt && ` · last pass ${new Date(s.lastComputedAt).toLocaleString()}`}.
          </>
        )}
      </p>
      {alerts.data && alerts.data.alerts.length === 0 && (
        <p className="text-xs text-muted-foreground">No {statusFilter} alerts.</p>
      )}
      {alerts.data && alerts.data.alerts.length > 0 && (
        <div className="rounded-xl border border-border divide-y divide-border overflow-hidden">
          {alerts.data.alerts.map((a) => (
            <div key={a.id} className="px-4 py-3 space-y-1.5 text-sm">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className={`text-xs ${ALERT_TYPE_CLASS[a.alertType]}`}>
                  {ALERT_TYPE_LABEL[a.alertType]}
                </Badge>
                <a
                  href={`/glossary/${a.conceptSlug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium hover:underline"
                >
                  {a.conceptTerm}
                </a>
                <span className="text-xs text-muted-foreground ml-auto shrink-0">
                  {new Date(a.createdAt).toLocaleDateString()}
                </span>
                {a.status === "open" && (
                  <div className="flex items-center gap-1 shrink-0">
                    {a.alertType === "coverage_opportunity" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => promote.mutate(a.id)}
                        disabled={promote.isPending}
                      >
                        <ArrowUpRight className="h-3 w-3 mr-1" />
                        Promote to idea
                      </Button>
                    )}
                    {a.alertType === "weak_support" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => harvest.mutate(a.id)}
                        disabled={harvest.isPending}
                      >
                        {harvest.isPending && harvest.variables === a.id ? (
                          <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                        ) : (
                          <Pickaxe className="h-3 w-3 mr-1" />
                        )}
                        Harvest sources
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => dismiss.mutate(a.id)}
                      disabled={dismiss.isPending}
                    >
                      <X className="h-3 w-3 mr-1" />
                      Dismiss
                    </Button>
                  </div>
                )}
              </div>
              {a.detail && (
                <p className="text-xs text-muted-foreground">
                  {a.detail.activeTrustedCount ?? 0} trusted source
                  {(a.detail.activeTrustedCount ?? 0) !== 1 ? "s" : ""} ·{" "}
                  {a.detail.independentFamilyCount ?? 0} independent outlet
                  {(a.detail.independentFamilyCount ?? 0) !== 1 ? "s" : ""} ·{" "}
                  {a.detail.articleMentionCount ?? 0} published mention
                  {(a.detail.articleMentionCount ?? 0) !== 1 ? "s" : ""}
                  {typeof a.detail.demandViews30d === "number" &&
                    ` · ${a.detail.demandViews30d} views (30d)`}
                  {(a.detail.retractedLinkedCount ?? 0) > 0 && (
                    <span className="text-destructive">
                      {" "}
                      · {a.detail.retractedLinkedCount} retracted source
                      {(a.detail.retractedLinkedCount ?? 0) !== 1 ? "s" : ""} still linked
                    </span>
                  )}
                  {a.detail.newestEvidenceAt &&
                    ` · newest evidence ${new Date(a.detail.newestEvidenceAt).toLocaleDateString()}`}
                </p>
              )}
              {a.detail?.linkedArticles && a.detail.linkedArticles.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <span className="text-muted-foreground">Affected:</span>
                  {a.detail.linkedArticles.slice(0, 4).map((la) => (
                    <a
                      key={la.id}
                      href={`/article/${la.slug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline max-w-[18rem] truncate"
                    >
                      {la.title}
                    </a>
                  ))}
                </div>
              )}
              {a.status === "promoted" && a.ideaId && (
                <p className="text-xs text-muted-foreground">
                  Promoted to a pending idea —{" "}
                  <a href="/admin/ideas" className="text-primary hover:underline">
                    view in idea gallery
                  </a>
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ConceptRadarHealth() {
  return (
    <>
      <RadarSection />
      <HealthSection />
    </>
  );
}
