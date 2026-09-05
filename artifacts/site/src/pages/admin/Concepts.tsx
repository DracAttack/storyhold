/**
 * Admin → Concepts — Concept Explainer & Glossary management page.
 *
 * Matches the BrainHook admin page pattern: list + status header + action
 * buttons + inline editing. No external library components added.
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import ConceptRadarHealth from "./ConceptRadarHealth";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  ExternalLink,
  RefreshCw,
  CheckCircle,
  EyeOff,
  Trash2,
  BookOpen,
  Edit2,
  Pause,
  GitMerge,
  History,
  DollarSign,
  Ban,
  Settings2,
  Plus,
  ScanSearch,
  X,
  Link2,
  ImageIcon,
  ShieldCheck,
  Wand2,
  Unlink,
  Database,
  Clock,
  Square,
  Play,
  AlertTriangle,
  RotateCcw,
  Layers,
  Network,
  FilterX,
  ChevronUp,
  ChevronDown,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type VaultStatus = "embedded" | "pending" | "unavailable" | "no_doc" | "excluded";

interface Concept {
  id: string;
  slug: string;
  term: string;
  hoverDefinition: string;
  definition: string;
  status: "live" | "draft" | "hidden";
  hoverEnabled: boolean;
  detectionConfidence: number;
  definitionConfidence: number;
  articleCount: number;
  wikiUrl: string | null;
  wikiTitle: string | null;
  lastProcessedAt: string | null;
  createdAt: string;
  quarantineReason: string | null;
  cardImageUrl: string | null;
  vaultStatus?: VaultStatus;
  sourceSummary?: { relevant: number; filtered: number; total: number } | null;
}

interface GlossaryVaultStatus {
  embedded: number;
  pendingEmbed: number;
  unavailable: number;
  total: number;
  lastReconcileAt: string | null;
}

interface ConceptListResponse {
  concepts: Concept[];
  total: number;
}

interface BackfillStatus {
  running: boolean;
  status: string;
  processed: number;
  skipped: number;
  failed: number;
  totalPublished: number;
  remaining: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  stoppedReason: string | null;
}

interface SkippedCandidate {
  term: string;
  reason: string;
  confidence: number;
}

interface ProcessingRun {
  id: string;
  articleId: string;
  articleTitle: string;
  articleSlug: string;
  articleDisabled: boolean;
  status: string;
  conceptsFound: number;
  mentionsCreated: number;
  model: string | null;
  errorMessage: string | null;
  skippedCandidates: SkippedCandidate[];
  createdAt: string;
}

interface CostSummary {
  functions: Array<{
    function: string;
    calls: number;
    totalUsd: number;
    usd30d: number;
    lastModel: string | null;
  }>;
  totalUsd: number;
  totalUsd30d: number;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`/api/admin${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...opts?.headers },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useConceptList(status: string, q: string, retractionFlagged: boolean) {
  const params = new URLSearchParams({ limit: "100" });
  if (status !== "all") params.set("status", status);
  if (q) params.set("q", q);
  if (retractionFlagged) params.set("retractionFlagged", "true");
  return useQuery<ConceptListResponse>({
    queryKey: ["admin-concepts", status, q, retractionFlagged],
    queryFn: () => apiFetch(`/concepts?${params}`),
  });
}

function useBackfillStatus() {
  return useQuery<BackfillStatus>({
    queryKey: ["admin-concepts-backfill-status"],
    queryFn: () => apiFetch("/concepts/backfill-status"),
    refetchInterval: 5_000,
  });
}

function useProcessingRuns() {
  return useQuery<{ runs: ProcessingRun[] }>({
    queryKey: ["admin-concepts-runs"],
    queryFn: () => apiFetch("/concepts/runs?limit=50"),
    refetchInterval: 15_000,
  });
}

function useConceptCosts() {
  return useQuery<CostSummary>({
    queryKey: ["admin-concepts-costs"],
    queryFn: () => apiFetch("/concepts/costs"),
    refetchInterval: 60_000,
  });
}

function useGlossaryVaultStatus() {
  return useQuery<GlossaryVaultStatus>({
    queryKey: ["admin-glossary-vault-status"],
    queryFn: () => apiFetch("/glossary-vault/status"),
    refetchInterval: 30_000,
  });
}

interface ShareCardBackfillStatus {
  running: boolean;
  interrupted: boolean;
  remaining: number;
  generated: number;
  failed: number;
  total: number;
  startedAt: string | null;
  finishedAt: string | null;
}
function useShareCardBackfillStatus() {
  return useQuery<ShareCardBackfillStatus>({
    queryKey: ["admin-concepts-share-card-backfill-status"],
    queryFn: () => apiFetch("/concepts/backfill-share-cards/status"),
    refetchInterval: 5_000,
  });
}

interface ConceptEdgeBackfillStatus {
  running: boolean;
  status: string;
  scanned: number;
  tagged: number;
  edges: number;
  remaining: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
function useConceptEdgeBackfillStatus() {
  return useQuery<ConceptEdgeBackfillStatus>({
    queryKey: ["admin-concepts-edge-backfill-status"],
    queryFn: () => apiFetch("/concepts/edge-backfill/status"),
    refetchInterval: 5_000,
  });
}

interface BeatAffinityStatus {
  running: boolean;
  lastComputedAt: string | null;
  conceptsWithProfile: number;
  bridgeConcepts: number;
}
function useBeatAffinityStatus() {
  return useQuery<BeatAffinityStatus>({
    queryKey: ["admin-concepts-beat-affinity-status"],
    queryFn: () => apiFetch("/concepts/beat-affinities/status"),
    refetchInterval: 5_000,
  });
}

interface ConceptBeatAffinityRow {
  beatSlug: string;
  beatName: string | null;
  weight: number;
  articleSignal: number;
  sourceSignal: number;
  relationshipSignal: number;
  updatedAt: string | null;
}
interface ConceptBeatProfile {
  isBridge: boolean;
  rows: ConceptBeatAffinityRow[];
}

interface RebuildShareCardsStatus {
  running: boolean;
  interrupted: boolean;
  generated: number;
  failed: number;
  total: number;
  startedAt: string | null;
  finishedAt: string | null;
}
function useRebuildShareCardsStatus() {
  return useQuery<RebuildShareCardsStatus>({
    queryKey: ["admin-concepts-rebuild-share-cards-status"],
    queryFn: () => apiFetch("/concepts/rebuild-share-cards/status"),
    refetchInterval: 5_000,
  });
}

interface BulkRecomposeStatus {
  running: boolean;
  processed: number;
  skipped: number;
  failed: number;
  total: number;
}
function useBulkRecomposeStatus() {
  return useQuery<BulkRecomposeStatus>({
    queryKey: ["admin-concepts-bulk-recompose-status"],
    queryFn: () => apiFetch("/concepts/bulk-recompose/status"),
    refetchInterval: 5_000,
  });
}

interface SourceRelevanceBackfillStatus {
  running: boolean;
  interrupted: boolean;
  cancelRequested: boolean;
  processed: number;
  failed: number;
  total: number;
  startedAt: string | null;
  finishedAt: string | null;
  nullRelevanceCount: number;
}
function useSourceRelevanceBackfillStatus() {
  return useQuery<SourceRelevanceBackfillStatus>({
    queryKey: ["admin-concepts-source-relevance-backfill-status"],
    queryFn: () => apiFetch("/concepts/backfill-source-relevance/status"),
    refetchInterval: 5_000,
  });
}

interface AliasAuditReport {
  dryRun: boolean;
  conceptsChecked: number;
  aliasesChecked: number;
  canonicalCollisions: Array<{ conceptSlug: string; alias: string; matchesSlug: string }>;
  sharedAliases: Array<{ alias: string; conceptSlugs: string[] }>;
  sharedAliasesAcknowledged?: number;
  llmFlags: Array<{ conceptSlug: string; alias: string; reason: string; matchesSlug: string | null }>;
  aliasesRemoved: number;
  relationshipsCreated: number;
  llmSkipped: boolean;
  llmSkipReason: string | null;
  finishedAt: string | null;
}

interface AliasAuditStatus {
  running: boolean;
  status: string;
  report: AliasAuditReport | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

function useAliasAuditStatus() {
  return useQuery<AliasAuditStatus>({
    queryKey: ["admin-concepts-alias-audit"],
    queryFn: () => apiFetch("/concepts/alias-audit"),
    refetchInterval: 5_000,
  });
}

interface MergeSweepReport {
  dryRun: boolean;
  conceptsChecked: number;
  pairsConsidered: number;
  pairsJudged: number;
  merged: Array<{
    survivorSlug: string;
    survivorTerm: string;
    mergedSlug: string;
    mergedTerm: string;
    signal: string;
    reason: string;
    confidence: number | null;
  }>;
  needsReview: Array<{
    aSlug: string;
    aTerm: string;
    bSlug: string;
    bTerm: string;
    signal: string;
    reason: string;
    confidence: number | null;
  }>;
  distinctRecorded: number;
  llmSkipped: boolean;
  llmSkipReason: string | null;
  finishedAt: string | null;
}

interface MergeSweepStatus {
  running: boolean;
  status: string;
  report: MergeSweepReport | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

function useMergeSweepStatus() {
  return useQuery<MergeSweepStatus>({
    queryKey: ["admin-concepts-merge-sweep"],
    queryFn: () => apiFetch("/concepts/merge-sweep"),
    refetchInterval: 5_000,
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: Concept["status"] }) {
  const map = {
    live: "bg-green-100 text-green-800",
    draft: "bg-yellow-100 text-yellow-800",
    hidden: "bg-gray-100 text-gray-500",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${map[status]}`}
    >
      {status}
    </span>
  );
}

function ConfidencePip({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = pct >= 80 ? "text-green-600" : pct >= 60 ? "text-yellow-600" : "text-red-500";
  return <span className={`text-xs font-mono ${color}`}>{pct}%</span>;
}

function VaultStatusBadge({ status }: { status: VaultStatus | undefined }) {
  if (!status) return null;
  if (status === "no_doc") {
    return (
      <span
        title="Not yet synced to vault — will appear after the next reconcile pass"
        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-slate-50 text-slate-500 border border-slate-200"
      >
        <RefreshCw className="h-2.5 w-2.5" />
        Not synced
      </span>
    );
  }
  if (status === "embedded") {
    return (
      <span
        title="In vault memory — available for draft context"
        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200"
      >
        <Database className="h-2.5 w-2.5" />
        In memory
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span
        title="Synced to vault but not yet embedded — will be available after the next embed sweep"
        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200"
      >
        <Clock className="h-2.5 w-2.5" />
        Pending embed
      </span>
    );
  }
  if (status === "unavailable") {
    return (
      <span
        title="Hidden from vault memory (concept is hidden or was deactivated)"
        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-gray-100 text-gray-500 border border-gray-200"
      >
        <EyeOff className="h-2.5 w-2.5" />
        Unavailable
      </span>
    );
  }
  if (status === "excluded") {
    return (
      <span
        title="Hidden concepts are excluded from vault sync by design — this will not sync unless the concept is unhidden"
        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-gray-100 text-gray-500 border border-gray-200"
      >
        <EyeOff className="h-2.5 w-2.5" />
        Excluded (hidden)
      </span>
    );
  }
  return null;
}

// Inline edit panel shown below the row
interface ClaimListItem {
  id: string;
  claim: string;
  override_text: string | null;
  claim_type: string;
  certainty: string;
  population: string | null;
  timeframe: string | null;
  status: string;
  supporting_count: number;
  contradicting_count: number;
  qualifying_count: number;
  article_count: number;
  independent_family_count: number;
}

interface ClaimListResponse {
  items: ClaimListItem[];
  summary: {
    total: number;
    strongly_corroborated: number;
    qualified_disputed: number;
    single_family: number;
    new_90_days: number;
    articles_using: number;
  };
}

function ClaimIntelligencePanel({ concept, onClose }: { concept: Concept; onClose: () => void }) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overrideText, setOverrideText] = useState("");
  const list = useQuery<ClaimListResponse>({
    queryKey: ["admin-concept-claims", concept.slug],
    queryFn: () => apiFetch(`/concepts/${concept.slug}/claims`),
  });
  const detail = useQuery<any>({
    queryKey: ["admin-claim-detail", selectedId],
    queryFn: () => apiFetch(`/claims/${selectedId}`),
    enabled: Boolean(selectedId),
  });
  const update = useMutation({
    mutationFn: (patch: { status?: "low_quality" | "extracted"; overrideText?: string | null }) =>
      apiFetch(`/claims/${selectedId}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      toast.success("Claim updated");
      void qc.invalidateQueries({ queryKey: ["admin-concept-claims", concept.slug] });
      void qc.invalidateQueries({ queryKey: ["admin-claim-detail", selectedId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const reconcile = useMutation({
    mutationFn: () => apiFetch(`/concepts/${concept.slug}/claims/reconcile`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Claim relationships reconciled");
      void qc.invalidateQueries({ queryKey: ["admin-concept-claims", concept.slug] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const summary = list.data?.summary;
  const selected = detail.data?.claim;
  const selectedRelationships: any[] = detail.data?.relationships ?? [];
  const selectedArticles: any[] = detail.data?.articles ?? [];

  return (
    <div className="border-t border-border bg-muted/30 p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold flex items-center gap-1.5">
            <Layers className="h-4 w-4 text-cyan-600" /> Claim Intelligence — {concept.term}
          </p>
          <p className="text-xs text-muted-foreground">Structured claims, independent support, qualifications, contradictions, and article use.</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => reconcile.mutate()} disabled={reconcile.isPending}>
            {reconcile.isPending ? "Reconciling…" : "Reconcile"}
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
      </div>
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
          {[
            ["Claims", summary.total],
            ["Strong", summary.strongly_corroborated],
            ["Qualified / disputed", summary.qualified_disputed],
            ["Single family", summary.single_family],
            ["New 90d", summary.new_90_days],
            ["Articles", summary.articles_using],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded border border-border bg-background p-2">
              <p className="text-[10px] text-muted-foreground">{label}</p>
              <p className="text-lg font-semibold">{value}</p>
            </div>
          ))}
        </div>
      )}
      {list.isLoading ? <p className="text-xs text-muted-foreground">Loading claims…</p> :
       (list.data?.items.length ?? 0) === 0 ? <p className="text-xs text-muted-foreground">No claims extracted for this concept yet.</p> :
       <div className="space-y-2">
        {list.data!.items.map((claim) => (
          <button key={claim.id} type="button" onClick={() => { setSelectedId(claim.id); setOverrideText(claim.override_text ?? claim.claim); }}
            className="w-full text-left rounded border border-border bg-background p-3 hover:border-primary/50">
            <div className="flex gap-2 flex-wrap mb-1">
              <Badge variant="outline">{claim.certainty}</Badge>
              <Badge variant="secondary">{claim.independent_family_count} families</Badge>
              {claim.supporting_count > 0 && <Badge variant="secondary">{claim.supporting_count} supporting</Badge>}
              {claim.contradicting_count > 0 && <Badge variant="destructive">{claim.contradicting_count} contradicting</Badge>}
              {claim.qualifying_count > 0 && <Badge variant="outline">{claim.qualifying_count} qualifying</Badge>}
              {claim.status === "low_quality" && <Badge variant="destructive">low quality</Badge>}
            </div>
            <p className="text-sm">{claim.override_text ?? claim.claim}</p>
          </button>
        ))}
      </div>}
      {selected && (
        <div className="rounded-lg border border-cyan-500/30 bg-background p-4 space-y-3">
          <div className="flex justify-between gap-3">
            <div>
              <p className="font-semibold">{selected.override_text ?? selected.claim}</p>
              {selected.override_text && <p className="text-xs text-muted-foreground mt-1">Edited wording. Original: {selected.claim}</p>}
              <p className="text-xs text-muted-foreground mt-1">{selected.claim_type} · {selected.certainty}{selected.population ? ` · ${selected.population}` : ""}{selected.timeframe ? ` · ${selected.timeframe}` : ""}</p>
            </div>
            <Button size="icon" variant="ghost" onClick={() => setSelectedId(null)}><X className="h-4 w-4" /></Button>
          </div>
          <blockquote className="border-l-2 border-primary pl-3 text-sm italic">{selected.exact_evidence_span}</blockquote>
          <a className="text-xs text-primary hover:underline" href={selected.source_url} target="_blank" rel="noreferrer">
            {selected.source_title ?? selected.source_domain ?? "Open source document"} <ExternalLink className="inline h-3 w-3" />
          </a>
          <p className="text-xs text-muted-foreground">
            {selected.independent_family_count ?? 0} independent families · {selectedRelationships.length} relationships · {selectedArticles.length} linked articles
          </p>
          {selectedRelationships.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium">Claim relationships</p>
              {selectedRelationships.map((relationship) => (
                <div key={relationship.id} className="rounded border border-border p-2 text-xs">
                  <div className="flex gap-2 items-center flex-wrap">
                    <Badge variant={
                      relationship.relationship_type === "contradicts"
                        ? "destructive"
                        : relationship.relationship_type === "supports" || relationship.relationship_type === "independently_corroborates"
                          ? "secondary"
                          : "outline"
                    }>
                      {String(relationship.relationship_type).replaceAll("_", " ")}
                    </Badge>
                    <span className="text-muted-foreground">{Math.round(Number(relationship.confidence ?? 0) * 100)}% confidence</span>
                  </div>
                  <p className="mt-1">{relationship.related_claim}</p>
                  {relationship.notes && <p className="mt-1 text-muted-foreground">{relationship.notes}</p>}
                </div>
              ))}
            </div>
          )}
          {selectedArticles.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium">Articles using this claim</p>
              {selectedArticles.map((article) => (
                <a key={article.id} href={`/article/${article.slug}`} target="_blank" rel="noreferrer"
                  className="block text-xs text-primary hover:underline">
                  {article.title} <ExternalLink className="inline h-3 w-3" />
                </a>
              ))}
            </div>
          )}
          <Textarea value={overrideText} onChange={(e) => setOverrideText(e.target.value)} rows={2} placeholder="Editor wording override" />
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" onClick={() => update.mutate({ overrideText })} disabled={update.isPending}>Save wording</Button>
            {selected.status === "low_quality" ? (
              <Button size="sm" variant="outline" onClick={() => update.mutate({ status: "extracted" })}>Restore</Button>
            ) : (
              <Button size="sm" variant="destructive" onClick={() => update.mutate({ status: "low_quality" })}>Flag low quality</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ConceptEditPanel({
  concept,
  onClose,
}: {
  concept: Concept;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [term, setTerm] = useState(concept.term);
  const [hover, setHover] = useState(concept.hoverDefinition);
  const [full, setFull] = useState(concept.definition);

  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/concepts/${concept.id}`, {
        method: "PATCH",
        body: JSON.stringify({ term, hoverDefinition: hover, definition: full }),
      }),
    onSuccess: () => {
      toast.success("Concept updated");
      void qc.invalidateQueries({ queryKey: ["admin-concepts"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="border-t border-border bg-muted/30 p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Term</label>
          <Input value={term} onChange={(e) => setTerm(e.target.value)} className="text-sm" />
        </div>
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">
          Hover definition (≤40 words)
        </label>
        <Textarea
          value={hover}
          onChange={(e) => setHover(e.target.value)}
          rows={2}
          className="text-sm resize-none"
        />
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">
          Glossary definition (≤80 words)
        </label>
        <Textarea
          value={full}
          onChange={(e) => setFull(e.target.value)}
          rows={3}
          className="text-sm resize-none"
        />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// Inline merge panel: pick a surviving target concept; this concept (source)
// is absorbed into it — mentions re-pointed, term + aliases become target
// aliases, source row deleted.
function ConceptMergePanel({
  concept,
  candidates,
  onClose,
}: {
  concept: Concept;
  candidates: Concept[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [targetId, setTargetId] = useState("");

  const merge = useMutation({
    mutationFn: () =>
      apiFetch(`/concepts/${concept.id}/merge`, {
        method: "POST",
        body: JSON.stringify({ targetConceptId: targetId }),
      }),
    onSuccess: () => {
      toast.success(`"${concept.term}" merged`);
      void qc.invalidateQueries({ queryKey: ["admin-concepts"] });
      void qc.invalidateQueries({ queryKey: ["admin-concepts-runs"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const options = candidates.filter((c) => c.id !== concept.id);

  return (
    <div className="border-t border-border bg-muted/30 p-4 space-y-3">
      <p className="text-xs text-muted-foreground">
        Merge <span className="font-semibold text-foreground">“{concept.term}”</span> into another
        concept. Its mentions move over, the term becomes an alias, and this entry is deleted.
      </p>
      <div className="flex items-center gap-2">
        <select
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm min-w-56"
        >
          <option value="">Select target concept…</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.term} ({c.status}, {c.articleCount} art.)
            </option>
          ))}
        </select>
        <Button
          size="sm"
          onClick={() => merge.mutate()}
          disabled={!targetId || merge.isPending}
        >
          {merge.isPending ? "Merging…" : "Merge"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Relationships panel — curated semantic links between concepts
// ---------------------------------------------------------------------------

const RELATION_TYPES = [
  { value: "related", label: "Related to" },
  { value: "distinct_from", label: "Distinct from (not to be confused with)" },
  { value: "parent_of", label: "Parent of (broader term)" },
  { value: "subtype_of", label: "Subtype of (narrower term)" },
  { value: "antonym", label: "Antonym (opposite)" },
  { value: "see_also", label: "See also" },
] as const;

const RELATION_LABELS: Record<string, string> = Object.fromEntries(
  RELATION_TYPES.map((t) => [t.value, t.label]),
);

interface RelationshipRow {
  id: string;
  relationType: string;
  direction: "outgoing" | "incoming";
  note: string | null;
  otherConcept: { id: string; term: string; slug: string; status: string } | null;
  createdAt: string | null;
}

function ConceptRelationshipsPanel({
  concept,
  candidates,
  onClose,
}: {
  concept: Concept;
  candidates: Concept[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [targetId, setTargetId] = useState("");
  const [relationType, setRelationType] = useState<string>("related");
  const [note, setNote] = useState("");

  const { data, isLoading } = useQuery<{ relationships: RelationshipRow[] }>({
    queryKey: ["admin-concept-relationships", concept.id],
    queryFn: () => apiFetch(`/concepts/${concept.id}/relationships`),
  });

  const addRel = useMutation({
    mutationFn: () =>
      apiFetch(`/concepts/${concept.id}/relationships`, {
        method: "POST",
        body: JSON.stringify({ toConceptId: targetId, relationType, note: note.trim() || undefined }),
      }),
    onSuccess: () => {
      toast.success("Relationship added");
      setTargetId("");
      setNote("");
      void qc.invalidateQueries({ queryKey: ["admin-concept-relationships", concept.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeRel = useMutation({
    mutationFn: (relationshipId: string) =>
      apiFetch(`/concepts/relationships/${relationshipId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Relationship removed");
      void qc.invalidateQueries({ queryKey: ["admin-concept-relationships", concept.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const options = candidates.filter((c) => c.id !== concept.id);
  const rels = data?.relationships ?? [];

  return (
    <div className="border-t border-border bg-muted/30 p-4 space-y-3">
      <p className="text-xs text-muted-foreground">
        Curated relationships for{" "}
        <span className="font-semibold text-foreground">“{concept.term}”</span>. “Distinct from”
        renders a “Not to be confused with” callout on the public glossary page.
      </p>

      {isLoading ? (
        <p className="text-xs text-muted-foreground animate-pulse">Loading…</p>
      ) : rels.length === 0 ? (
        <p className="text-xs text-muted-foreground">No relationships yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {rels.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-sm">
              <Badge variant="secondary" className="text-[10px] shrink-0">
                {RELATION_LABELS[r.relationType] ?? r.relationType}
                {r.direction === "incoming" ? " (incoming)" : ""}
              </Badge>
              <span className="font-medium truncate">
                {r.otherConcept?.term ?? "(deleted concept)"}
              </span>
              {r.note && <span className="text-xs text-muted-foreground truncate">— {r.note}</span>}
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 text-destructive shrink-0 ml-auto"
                title="Remove relationship"
                onClick={() => removeRel.mutate(r.id)}
                disabled={removeRel.isPending}
              >
                <X className="h-3 w-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={relationType}
          onChange={(e) => setRelationType(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
        >
          {RELATION_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <select
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm min-w-56"
        >
          <option value="">Select concept…</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.term} ({c.status})
            </option>
          ))}
        </select>
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note"
          className="h-8 text-sm w-56"
        />
        <Button size="sm" onClick={() => addRel.mutate()} disabled={!targetId || addRel.isPending}>
          {addRel.isPending ? "Adding…" : "Add"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vault documents panel — Source Vault docs linked to a concept via
// deterministic source_concept_edges (read-only; edges never affect
// evidence eligibility).
// ---------------------------------------------------------------------------

interface ConceptVaultDoc {
  edgeId: string;
  confidence: number;
  matchedSections: Array<{ field: string; term: string; snippet: string; count: number }>;
  taggedAt: string | null;
  documentId: string;
  title: string | null;
  url: string;
  domain: string;
  authorityTier: string | null;
  status: string;
  lifecycleStatus: string;
  evidenceEligible: boolean;
  publishedAt: string | null;
}

// ---------------------------------------------------------------------------
// Source trail panel — concept_sources rows with claim-relevance badges
// ---------------------------------------------------------------------------

interface ConceptSourceRow {
  id: string;
  sourceUrl: string;
  sourceType: "wikipedia" | "vault";
  relevanceScore: number;
  claimRelevant: boolean | null;
  createdAt: string | null;
  docTitle: string | null;
  docDomain: string | null;
  docAuthorityTier: string | null;
  docLifecycleStatus: string | null;
}

function ClaimRelevanceBadge({ value }: { value: boolean | null }) {
  if (value === true)
    return (
      <Badge variant="outline" className="text-xs text-emerald-600 border-emerald-400/60 gap-1">
        <CheckCircle className="h-2.5 w-2.5" />
        relevant
      </Badge>
    );
  if (value === false)
    return (
      <Badge variant="outline" className="text-xs text-rose-500 border-rose-400/60 gap-1">
        <X className="h-2.5 w-2.5" />
        filtered
      </Badge>
    );
  return (
    <Badge variant="outline" className="text-xs text-muted-foreground gap-1">
      legacy
    </Badge>
  );
}

function ConceptSourceTrailPanel({ concept, onClose }: { concept: Concept; onClose: () => void }) {
  const qc = useQueryClient();
  const sourcesQuery = useQuery<{ sources: ConceptSourceRow[]; total: number }>({
    queryKey: ["admin-concept-sources", concept.id],
    queryFn: () => apiFetch(`/concepts/${concept.id}/sources`),
  });
  const sources = sourcesQuery.data?.sources ?? [];

  const override = useMutation({
    mutationFn: ({ sourceId, claimRelevant }: { sourceId: string; claimRelevant: boolean }) =>
      apiFetch(`/concepts/${concept.id}/sources/${sourceId}`, {
        method: "PATCH",
        body: JSON.stringify({ claimRelevant }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-concept-sources", concept.id] });
      toast.success("Source claim-relevance updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const relevant = sources.filter((s) => s.claimRelevant !== false);
  const filtered = sources.filter((s) => s.claimRelevant === false);

  return (
    <div className="border-t border-border bg-muted/30 px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
          Source trail — {concept.term}
          {sourcesQuery.data && (
            <span className="text-xs text-muted-foreground font-normal">
              ({relevant.length} relevant
              {filtered.length > 0 && `, ${filtered.length} filtered`})
            </span>
          )}
        </p>
        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {sourcesQuery.isLoading ? (
        <p className="text-xs text-muted-foreground animate-pulse">Loading source trail…</p>
      ) : sourcesQuery.isError ? (
        <p className="text-xs text-destructive">Failed to load sources.</p>
      ) : sources.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No grounding sources recorded yet. Sources are stored when the concept is processed or
          Wikipedia is ingested. Run "Re-check source claim-relevance" to score existing sources.
        </p>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden divide-y divide-border bg-background">
          {sources.map((s) => {
            const isFiltered = s.claimRelevant === false;
            const label = s.docTitle ?? (s.sourceType === "wikipedia" ? "Wikipedia" : s.sourceUrl);
            return (
              <div
                key={s.id}
                className={`px-3 py-2 text-sm ${isFiltered ? "opacity-50" : ""}`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <a
                    href={s.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium hover:underline truncate max-w-xs"
                    title={s.sourceUrl}
                  >
                    {label}
                  </a>
                  <ClaimRelevanceBadge value={s.claimRelevant} />
                  {s.sourceType === "wikipedia" && (
                    <Badge variant="outline" className="text-xs">Wikipedia</Badge>
                  )}
                  {s.docAuthorityTier && (
                    <Badge variant="outline" className="text-xs">{s.docAuthorityTier}</Badge>
                  )}
                  {isFiltered && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1.5 text-xs text-emerald-600 hover:text-emerald-500"
                      disabled={override.isPending && override.variables?.sourceId === s.id}
                      onClick={() => override.mutate({ sourceId: s.id, claimRelevant: true })}
                    >
                      {override.isPending && override.variables?.sourceId === s.id ? (
                        <RefreshCw className="h-2.5 w-2.5 animate-spin" />
                      ) : (
                        "Override"
                      )}
                    </Button>
                  )}
                  {s.claimRelevant === true && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1.5 text-xs text-muted-foreground hover:text-rose-500"
                      disabled={override.isPending && override.variables?.sourceId === s.id}
                      onClick={() => override.mutate({ sourceId: s.id, claimRelevant: false })}
                    >
                      {override.isPending && override.variables?.sourceId === s.id ? (
                        <RefreshCw className="h-2.5 w-2.5 animate-spin" />
                      ) : (
                        "Filter"
                      )}
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {s.docDomain ?? (() => { try { return new URL(s.sourceUrl).hostname; } catch { return s.sourceUrl; } })()}
                  {" · "}
                  score {s.relevanceScore.toFixed(2)}
                  {s.docLifecycleStatus && s.docLifecycleStatus !== "active" && (
                    <span className="ml-1.5 text-amber-500">[{s.docLifecycleStatus}]</span>
                  )}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ConceptVaultDocsPanel({ concept, onClose }: { concept: Concept; onClose: () => void }) {
  const docsQuery = useQuery<{ documents: ConceptVaultDoc[]; total: number }>({
    queryKey: ["admin-concept-vault-docs", concept.id],
    queryFn: () => apiFetch(`/concepts/${concept.id}/vault-documents`),
  });
  const docs = docsQuery.data?.documents ?? [];

  return (
    <div className="border-t border-border bg-muted/30 px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold flex items-center gap-1.5">
          <Database className="h-3.5 w-3.5 text-muted-foreground" />
          Vault documents — {concept.term}
          {docsQuery.data && (
            <span className="text-xs text-muted-foreground font-normal">({docsQuery.data.total})</span>
          )}
        </p>
        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {docsQuery.isLoading ? (
        <p className="text-xs text-muted-foreground animate-pulse">Loading linked documents…</p>
      ) : docsQuery.isError ? (
        <p className="text-xs text-destructive">Failed to load linked documents.</p>
      ) : docs.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No vault documents linked yet. New ingests are tagged automatically; run the
          "Vault Concept Edges" backfill above to tag the back catalog.
        </p>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden divide-y divide-border bg-background">
          {docs.map((d) => (
            <div key={d.edgeId} className="px-3 py-2 text-sm">
              <div className="flex items-center gap-2 flex-wrap">
                <a
                  href={d.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium hover:underline truncate max-w-md"
                  title={d.url}
                >
                  {d.title || d.url}
                </a>
                <ConfidencePip value={d.confidence} />
                {d.authorityTier && (
                  <Badge variant="outline" className="text-xs">{d.authorityTier}</Badge>
                )}
                {d.lifecycleStatus !== "active" && (
                  <Badge variant="outline" className="text-xs text-amber-600">{d.lifecycleStatus}</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {d.domain}
                {d.matchedSections.length > 0 && (
                  <>
                    {" · matched: "}
                    {Array.from(new Set(d.matchedSections.map((m) => m.term))).slice(0, 4).join(", ")}
                    {d.matchedSections.some((m) => m.field === "title") && " (incl. title)"}
                  </>
                )}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Beat profile panel — a concept's weighted beat affinities (deterministic)
// ---------------------------------------------------------------------------

function ConceptBeatProfilePanel({ concept, onClose }: { concept: Concept; onClose: () => void }) {
  const profileQuery = useQuery<ConceptBeatProfile>({
    queryKey: ["admin-concept-beat-profile", concept.id],
    queryFn: () => apiFetch(`/concepts/${concept.id}/beat-affinities`),
  });
  const profile = profileQuery.data;
  const rows = profile?.rows ?? [];

  return (
    <div className="border-t border-border bg-muted/30 px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold flex items-center gap-1.5">
          <Network className="h-3.5 w-3.5 text-muted-foreground" />
          Beat profile — {concept.term}
          {profile?.isBridge && (
            <Badge variant="outline" className="text-xs text-violet-600 border-violet-300">
              Bridge concept
            </Badge>
          )}
        </p>
        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {profileQuery.isLoading ? (
        <p className="text-xs text-muted-foreground animate-pulse">Loading beat profile…</p>
      ) : profileQuery.isError ? (
        <p className="text-xs text-destructive">Failed to load beat profile.</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No beat profile yet. Profiles are recomputed nightly from article mentions, linked vault
          sources, and related concepts — or run "Beat Affinities" above now.
        </p>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden divide-y divide-border bg-background">
          {rows.map((r) => (
            <div key={r.beatSlug} className="px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium w-40 truncate" title={r.beatSlug}>
                  {r.beatName ?? r.beatSlug}
                </span>
                <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${Math.round(Math.min(1, r.weight) * 100)}%` }}
                  />
                </div>
                <span className="text-xs tabular-nums w-10 text-right">
                  {(r.weight * 100).toFixed(0)}%
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                articles {(r.articleSignal * 100).toFixed(0)}% · sources{" "}
                {(r.sourceSignal * 100).toFixed(0)}% · related concepts{" "}
                {(r.relationshipSignal * 100).toFixed(0)}%
              </p>
            </div>
          ))}
        </div>
      )}
      {rows.length > 0 && rows[0]?.updatedAt && (
        <p className="text-xs text-muted-foreground">
          Computed {new Date(rows[0].updatedAt).toLocaleString()} — deterministic blend: article
          mentions 50% · vault sources 30% · related concepts 20% (renormalized when a signal has
          no data).
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manual import form — no AI, admin provides everything directly
// ---------------------------------------------------------------------------

type ImportMode = "ai" | "manual";

function ImportConceptForm({ onCreated }: { onCreated: () => void }) {
  const [mode, setMode] = useState<ImportMode>("ai");
  const [term, setTerm] = useState("");
  const [hover, setHover] = useState("");
  const [full, setFull] = useState("");
  const [aliases, setAliases] = useState("");
  const [wikiUrl, setWikiUrl] = useState("");

  const generate = useMutation({
    mutationFn: () =>
      apiFetch("/concepts/generate", {
        method: "POST",
        body: JSON.stringify({ term: term.trim() }),
      }),
    onSuccess: () => {
      toast.success(`"${term.trim()}" generated through the AI pipeline`);
      setTerm("");
      onCreated();
    },
    onError: (e: Error) => {
      toast.error(e.message);
    },
  });

  const create = useMutation({
    mutationFn: () =>
      apiFetch("/concepts/import", {
        method: "POST",
        body: JSON.stringify({
          term: term.trim(),
          hoverDefinition: hover.trim(),
          definition: full.trim(),
          aliases: aliases
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          wikiUrl: wikiUrl.trim() || undefined,
        }),
      }),
    onSuccess: () => {
      toast.success(`"${term.trim()}" imported and published`);
      setTerm("");
      setHover("");
      setFull("");
      setAliases("");
      setWikiUrl("");
      onCreated();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const canAiSubmit = term.trim().length > 0;
  const canManualSubmit =
    term.trim().length > 0 && hover.trim().length > 0 && full.trim().length > 0;
  const isPending = generate.isPending || create.isPending;

  return (
    <div className="rounded-xl border border-primary/40 bg-muted/20 p-4 space-y-3">
      {/* Mode toggle */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setMode("ai")}
          className={`text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${
            mode === "ai"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          AI Pipeline
        </button>
        <button
          onClick={() => setMode("manual")}
          className={`text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${
            mode === "manual"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Manual
        </button>
      </div>

      {mode === "ai" ? (
        <>
          <p className="text-xs text-muted-foreground">
            Just enter a term and the AI pipeline will find the best Wikipedia match,
            pull Source Vault context, generate definitions, and verify — the same
            process that runs on published articles. If the pipeline can’t produce a
            passing definition, it’ll fail gracefully; switch to Manual to write one.
          </p>
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Term <span className="text-destructive">*</span>
              </label>
              <Input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="e.g. New Relationship Energy"
                className="text-sm"
              />
            </div>
            <Button
              size="sm"
              onClick={() => generate.mutate()}
              disabled={!canAiSubmit || isPending}
            >
              {generate.isPending ? "Generating…" : "Generate & publish"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Create the concept immediately as <strong>live</strong> — no AI. Use{" "}
            <strong>Scan articles</strong> on the new row afterward to wire it up to existing articles.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Term <span className="text-destructive">*</span>
              </label>
              <Input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="e.g. New Relationship Energy"
                className="text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                Aliases (comma-separated)
              </label>
              <Input
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
                placeholder="e.g. NRE, limerence"
                className="text-sm"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Hover definition (≤40 words) <span className="text-destructive">*</span>
            </label>
            <Textarea
              value={hover}
              onChange={(e) => setHover(e.target.value)}
              placeholder="One-sentence plain-English gloss shown in the inline hover card."
              rows={2}
              className="text-sm resize-none"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Glossary definition (≤80 words) <span className="text-destructive">*</span>
            </label>
            <Textarea
              value={full}
              onChange={(e) => setFull(e.target.value)}
              placeholder="Full plain-English definition shown on the /glossary/:slug page."
              rows={3}
              className="text-sm resize-none"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">
              Wikipedia URL (optional)
            </label>
            <Input
              value={wikiUrl}
              onChange={(e) => setWikiUrl(e.target.value)}
              placeholder="https://en.wikipedia.org/wiki/…"
              className="text-sm"
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => create.mutate()}
              disabled={!canManualSubmit || isPending}
            >
              {create.isPending ? "Importing…" : "Import & publish"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feature settings panel — master toggle, confidence thresholds, density caps.
// Wired to the shared /admin/site-settings endpoint (only concept fields shown).
// ---------------------------------------------------------------------------

interface ConceptSettings {
  conceptExplainersEnabled: boolean;
  conceptDetectionThreshold: number;
  conceptDefinitionThreshold: number;
  conceptDensityMaxDefault: number;
  conceptDensityMaxLong: number;
}

function ConceptSettingsPanel() {
  const qc = useQueryClient();
  const settingsQuery = useQuery<ConceptSettings>({
    queryKey: ["admin-site-settings"],
    queryFn: () => apiFetch("/site-settings"),
  });

  const [draft, setDraft] = useState<Partial<Record<keyof ConceptSettings, string>>>({});

  const update = useMutation({
    mutationFn: (patch: Partial<ConceptSettings>) =>
      apiFetch("/site-settings", { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      toast.success("Concept settings saved");
      setDraft({});
      void qc.invalidateQueries({ queryKey: ["admin-site-settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const s = settingsQuery.data;
  if (!s) return null;

  function numField(
    key: Exclude<keyof ConceptSettings, "conceptExplainersEnabled">,
    label: string,
    hint: string,
    opts: { min: number; max: number; step: number; int?: boolean },
  ) {
    const raw = draft[key] ?? String(s![key]);
    const parsed = opts.int ? parseInt(raw, 10) : parseFloat(raw);
    const valid = !Number.isNaN(parsed) && parsed >= opts.min && parsed <= opts.max;
    const dirty = valid && parsed !== s![key];
    return (
      <div className="space-y-1">
        <Label className="text-xs font-medium">{label}</Label>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={opts.min}
            max={opts.max}
            step={opts.step}
            value={raw}
            onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
            className="h-8 w-24 text-sm"
          />
          {dirty && (
            <Button
              size="sm"
              className="h-8"
              disabled={update.isPending}
              onClick={() => update.mutate({ [key]: parsed })}
            >
              Save
            </Button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border p-4 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-muted-foreground" />
          <span className="font-semibold text-sm">Concept settings</span>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="concept-enabled" className="text-xs text-muted-foreground">
            {s.conceptExplainersEnabled ? "Enabled" : "Disabled"}
          </Label>
          <Switch
            id="concept-enabled"
            checked={s.conceptExplainersEnabled}
            disabled={update.isPending}
            onCheckedChange={(checked) => update.mutate({ conceptExplainersEnabled: checked })}
          />
        </div>
      </div>
      {!s.conceptExplainersEnabled && (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          Concept explainers are off — article annotations and the public glossary are hidden, and
          the detection pipeline is paused. Admin tools here still work.
        </p>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {numField(
          "conceptDetectionThreshold",
          "Detection threshold",
          "Detected terms below this confidence are discarded (0–1).",
          { min: 0, max: 1, step: 0.01 },
        )}
        {numField(
          "conceptDefinitionThreshold",
          "Definition threshold",
          "Concepts below this stay in draft, never shown to readers (0–1).",
          { min: 0, max: 1, step: 0.01 },
        )}
        {numField(
          "conceptDensityMaxDefault",
          "Max per article",
          "Cap on annotated concepts in a normal-length article.",
          { min: 0, max: 50, step: 1, int: true },
        )}
        {numField(
          "conceptDensityMaxLong",
          "Max per long article",
          "Cap for long articles (over ~2,500 words).",
          { min: 0, max: 50, step: 1, int: true },
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function AdminConcepts() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"all" | "live" | "draft" | "hidden">("all");
  const [q, setQ] = useState("");
  const [retractionFlagged, setRetractionFlagged] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [relationshipsId, setRelationshipsId] = useState<string | null>(null);
  const [cardViewId, setCardViewId] = useState<string | null>(null);
  const [vaultDocsId, setVaultDocsId] = useState<string | null>(null);
  const [claimsId, setClaimsId] = useState<string | null>(null);
  const [beatProfileId, setBeatProfileId] = useState<string | null>(null);
  const [sourceTrailId, setSourceTrailId] = useState<string | null>(null);
  const [showRuns, setShowRuns] = useState(false);
  const [quarantineCollapsed, setQuarantineCollapsed] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [scanResults, setScanResults] = useState<
    Record<string, { scanned: number; matched: number; created: number } | null>
  >({});

  const { data, isLoading, isError } = useConceptList(statusFilter, q, retractionFlagged);
  const backfillStatus = useBackfillStatus();
  const runsQuery = useProcessingRuns();
  const costsQuery = useConceptCosts();

  const startBackfill = useMutation({
    mutationFn: () => apiFetch("/concepts/backfill", { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => {
      toast.success("Backfill started — it pauses cleanly and resumes where it left off");
      void qc.invalidateQueries({ queryKey: ["admin-concepts-backfill-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pauseBackfill = useMutation({
    mutationFn: () => apiFetch("/concepts/backfill/pause", { method: "POST" }),
    onSuccess: () => {
      toast.success("Pause requested — the backfill stops after the current article");
      void qc.invalidateQueries({ queryKey: ["admin-concepts-backfill-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleArticle = useMutation({
    mutationFn: ({ articleId, disabled }: { articleId: string; disabled: boolean }) =>
      apiFetch(`/concepts/articles/${articleId}/toggle`, {
        method: "POST",
        body: JSON.stringify({ disabled }),
      }),
    onSuccess: (_data, vars) => {
      toast.success(vars.disabled ? "Concept explainers disabled for article" : "Concept explainers re-enabled for article");
      void qc.invalidateQueries({ queryKey: ["admin-concepts-runs"] });
      void qc.invalidateQueries({ queryKey: ["admin-concepts-backfill-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const publishConcept = useMutation({
    mutationFn: (id: string) => apiFetch(`/concepts/${id}/publish`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Concept published");
      void qc.invalidateQueries({ queryKey: ["admin-concepts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleHover = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`/concepts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ hoverEnabled: enabled }),
      }),
    onSuccess: (_data, { enabled }) => {
      toast.success(enabled ? "Hover cards enabled" : "Hover cards disabled");
      void qc.invalidateQueries({ queryKey: ["admin-concepts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const hideConcept = useMutation({
    mutationFn: (id: string) => apiFetch(`/concepts/${id}/hide`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Concept hidden");
      void qc.invalidateQueries({ queryKey: ["admin-concepts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const { data: quarantinedData, isLoading: quarantinedLoading } = useQuery<{ concepts: Concept[] }>({
    queryKey: ["admin-concepts-quarantined"],
    queryFn: () => apiFetch("/concepts/quarantined"),
    refetchOnWindowFocus: false,
  });

  const restoreConcept = useMutation({
    mutationFn: (id: string) => apiFetch(`/concepts/${id}/restore`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Concept restored to draft");
      void qc.invalidateQueries({ queryKey: ["admin-concepts-quarantined"] });
      void qc.invalidateQueries({ queryKey: ["admin-concepts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteConcept = useMutation({
    mutationFn: (id: string) => apiFetch(`/concepts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Concept deleted");
      void qc.invalidateQueries({ queryKey: ["admin-concepts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteAllQuarantined = useMutation({
    mutationFn: () => apiFetch("/concepts/quarantined", { method: "DELETE" }),
    onSuccess: (res: { deleted: number }) => {
      toast.success(`${res.deleted} quarantined concept${res.deleted !== 1 ? "s" : ""} deleted`);
      void qc.invalidateQueries({ queryKey: ["admin-concepts-quarantined"] });
      void qc.invalidateQueries({ queryKey: ["admin-concepts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const regenShareCard = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/concepts/${id}/regen-share-card`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Share card regenerated");
      void qc.invalidateQueries({ queryKey: ["admin-concepts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const scanArticles = useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) =>
      apiFetch(`/concepts/${id}/scan-articles`, {
        method: "POST",
        body: force ? JSON.stringify({ force: true }) : undefined,
      }) as Promise<{
        scanned: number;
        matched: number;
        created: number;
        alreadyExisted: number;
      }>,
    onSuccess: (result, { id }) => {
      setScanResults((prev) => ({ ...prev, [id]: result }));
      toast.success(
        `Scan complete — ${result.created} new mention${result.created !== 1 ? "s" : ""} across ${result.scanned} articles`,
      );
      void qc.invalidateQueries({ queryKey: ["admin-concepts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const recheckSources = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/concepts/${id}/recheck-sources`, { method: "POST" }) as Promise<{
        checked: number;
        removed: number;
      }>,
    onSuccess: (result, id) => {
      if (result.removed > 0) {
        toast.success(
          `Re-check complete — ${result.removed} source${result.removed !== 1 ? "s" : ""} filtered out of ${result.checked}`,
        );
      } else {
        toast.success(`Re-check complete — all ${result.checked} source${result.checked !== 1 ? "s" : ""} are claim-relevant`);
      }
      void qc.invalidateQueries({ queryKey: ["admin-concepts", id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const vaultStatusQuery = useGlossaryVaultStatus();

  const syncVault = useMutation({
    mutationFn: () => apiFetch("/glossary-vault/sync", { method: "POST" }),
    onSuccess: () => {
      toast.success("Vault sync started — concepts will be embedded within the next cron pass");
      void qc.invalidateQueries({ queryKey: ["admin-glossary-vault-status"] });
      void qc.invalidateQueries({ queryKey: ["admin-concepts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const aliasAuditStatus = useAliasAuditStatus();
  const [auditReportDismissed, setAuditReportDismissed] = useState(false);

  const startAliasAudit = useMutation({
    mutationFn: (dryRun: boolean) =>
      apiFetch("/concepts/alias-audit", { method: "POST", body: JSON.stringify({ dryRun }) }),
    onSuccess: (_res, dryRun) => {
      setAuditReportDismissed(false);
      toast.success(dryRun ? "Alias audit started (dry run — nothing is changed)" : "Alias audit started");
      void qc.invalidateQueries({ queryKey: ["admin-concepts-alias-audit"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const sourceRelevanceBackfillStatus = useSourceRelevanceBackfillStatus();
  const backfillSourceRelevance = useMutation({
    mutationFn: () => apiFetch("/concepts/backfill-source-relevance", { method: "POST" }),
    onSuccess: () => {
      toast.success("Source relevance backfill started — re-scoring all stored concept sources");
      void qc.invalidateQueries({ queryKey: ["admin-concepts-source-relevance-backfill-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelSourceRelevanceBackfill = useMutation({
    mutationFn: () => apiFetch("/concepts/backfill-source-relevance/cancel", { method: "POST" }),
    onSuccess: () => {
      toast.success("Source relevance backfill stopping after current concept");
      void qc.invalidateQueries({ queryKey: ["admin-concepts-source-relevance-backfill-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const backfillAliasLinks = useMutation<{ created: number; skipped: number }, Error>({
    mutationFn: () => apiFetch("/concepts/backfill-alias-links", { method: "POST" }),
    onSuccess: (res) => {
      toast.success(`Alias links backfilled — ${res.created} new link${res.created !== 1 ? "s" : ""} created, ${res.skipped} already existed`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const shareCardBackfillStatus = useShareCardBackfillStatus();
  const backfillShareCards = useMutation({
    mutationFn: () => apiFetch("/concepts/backfill-share-cards", { method: "POST" }),
    onSuccess: () => {
      toast.success("Share card backfill started");
      void qc.invalidateQueries({ queryKey: ["admin-concepts-share-card-backfill-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelShareCardBackfill = useMutation({
    mutationFn: () => apiFetch("/concepts/backfill-share-cards/cancel", { method: "POST" }),
    onSuccess: () => toast.success("Share card backfill stopping after current card"),
    onError: (e: Error) => toast.error(e.message),
  });

  const edgeBackfillStatus = useConceptEdgeBackfillStatus();
  const startEdgeBackfill = useMutation({
    mutationFn: () => apiFetch("/concepts/edge-backfill", { method: "POST" }),
    onSuccess: () => {
      toast.success("Vault edge backfill started — tagging documents against the glossary");
      void qc.invalidateQueries({ queryKey: ["admin-concepts-edge-backfill-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const cancelEdgeBackfill = useMutation({
    mutationFn: () => apiFetch("/concepts/edge-backfill/cancel", { method: "POST" }),
    onSuccess: () => toast.success("Edge backfill stopping after the current batch"),
    onError: (e: Error) => toast.error(e.message),
  });

  const beatAffinityStatus = useBeatAffinityStatus();
  const recomputeBeatAffinities = useMutation({
    mutationFn: () => apiFetch("/concepts/beat-affinities/recompute", { method: "POST" }),
    onSuccess: () => {
      toast.success("Beat affinity recompute started (deterministic, no AI cost)");
      void qc.invalidateQueries({ queryKey: ["admin-concepts-beat-affinity-status"] });
      void qc.invalidateQueries({ queryKey: ["admin-concept-beat-profile"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rebuildShareCardsStatus = useRebuildShareCardsStatus();
  const rebuildShareCards = useMutation({
    mutationFn: () => apiFetch("/concepts/rebuild-share-cards", { method: "POST" }),
    onSuccess: () => {
      toast.success("Rebuild started — regenerating all glossary cards");
      void qc.invalidateQueries({ queryKey: ["admin-concepts-rebuild-share-cards-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const cancelRebuildShareCards = useMutation({
    mutationFn: () => apiFetch("/concepts/rebuild-share-cards/cancel", { method: "POST" }),
    onSuccess: () => toast.success("Rebuild stopping after current card"),
    onError: (e: Error) => toast.error(e.message),
  });

  const bulkRecomposeStatus = useBulkRecomposeStatus();
  const bulkRecompose = useMutation<{ started: boolean }, Error, boolean>({
    mutationFn: (force = false) =>
      apiFetch("/concepts/bulk-recompose", { method: "POST", body: JSON.stringify({ force }) }),
    onSuccess: (_data, force) => {
      toast.success(force ? "Full recompose started — every concept will be regenerated" : "Recompose started — only missing fields");
      void qc.invalidateQueries({ queryKey: ["admin-concepts-bulk-recompose-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelBulkRecompose = useMutation({
    mutationFn: () => apiFetch("/concepts/bulk-recompose/cancel", { method: "POST" }),
    onSuccess: () => toast.success("Recompose stopping after current concept"),
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelAliasAudit = useMutation({
    mutationFn: () => apiFetch("/concepts/alias-audit/cancel", { method: "POST" }),
    onSuccess: () => toast.success("Alias audit stopping after current batch"),
    onError: (e: Error) => toast.error(e.message),
  });

  const mergeSweepStatus = useMergeSweepStatus();
  const [mergeReportDismissed, setMergeReportDismissed] = useState(false);

  const startMergeSweep = useMutation({
    mutationFn: (dryRun: boolean) =>
      apiFetch("/concepts/merge-sweep", { method: "POST", body: JSON.stringify({ dryRun }) }),
    onSuccess: (_res, dryRun) => {
      setMergeReportDismissed(false);
      toast.success(dryRun ? "Merge sweep started (dry run — nothing is changed)" : "Merge sweep started");
      void qc.invalidateQueries({ queryKey: ["admin-concepts-merge-sweep"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelMergeSweep = useMutation({
    mutationFn: () => apiFetch("/concepts/merge-sweep/cancel", { method: "POST" }),
    onSuccess: () => toast.success("Merge sweep stopping after current batch"),
    onError: (e: Error) => toast.error(e.message),
  });

  const bulkScanArticles = useMutation<{ concepts: number; newMentions: number }, Error>({
    mutationFn: () => apiFetch("/concepts/bulk-scan-articles", { method: "POST" }),
    onSuccess: (res) => {
      toast.success(
        `Relinked — ${res.newMentions} new mention${res.newMentions !== 1 ? "s" : ""} across ${res.concepts} concept${res.concepts !== 1 ? "s" : ""}`,
      );
      void qc.invalidateQueries({ queryKey: ["admin-concepts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const forceRescanArticles = useMutation<{ concepts: number; newMentions: number }, Error>({
    mutationFn: () =>
      apiFetch("/concepts/bulk-scan-articles", {
        method: "POST",
        body: JSON.stringify({ force: true }),
      }),
    onSuccess: (res) => {
      toast.success(
        `Force-rescanned — ${res.newMentions} mention${res.newMentions !== 1 ? "s" : ""} rebuilt across ${res.concepts} concept${res.concepts !== 1 ? "s" : ""}`,
      );
      void qc.invalidateQueries({ queryKey: ["admin-concepts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const bf = backfillStatus.data;
  const backfillRunning = bf?.running ?? false;
  const audit = aliasAuditStatus.data;
  const auditRunning = audit?.running ?? false;
  const auditReport = audit?.report ?? null;
  const mergeSweep = mergeSweepStatus.data;
  const mergeSweepRunning = mergeSweep?.running ?? false;
  const mergeReport = mergeSweep?.report ?? null;
  const concepts = data?.concepts ?? [];
  const total = data?.total ?? 0;
  const missingCardCount = concepts.filter((c) => !c.cardImageUrl).length;
  const runs = runsQuery.data?.runs ?? [];
  const costs = costsQuery.data;
  const vaultStatus = vaultStatusQuery.data;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Concept Explainer</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {total} term{total !== 1 ? "s" : ""} detected across published articles
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            size="sm"
            variant={showImport ? "default" : "outline"}
            onClick={() => setShowImport((v) => !v)}
          >
            {showImport ? (
              <>
                <X className="h-4 w-4 mr-1.5" />
                Cancel
              </>
            ) : (
              <>
                <Plus className="h-4 w-4 mr-1.5" />
                Import term
              </>
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => bulkScanArticles.mutate()}
            disabled={bulkScanArticles.isPending || forceRescanArticles.isPending}
            title="Scan every article for every concept and create missing mention links"
          >
            <Unlink className="h-4 w-4 mr-1.5" />
            {bulkScanArticles.isPending ? "Relinking…" : "Relink all"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (
                confirm(
                  "This clears ALL existing article mentions and rebuilds them from scratch using word-boundary matching. It will fix inflated article counts but may take a minute on a large catalog. Continue?",
                )
              ) {
                forceRescanArticles.mutate();
              }
            }}
            disabled={forceRescanArticles.isPending || bulkScanArticles.isPending}
            title="Clear all existing mention links and rebuild with word-boundary matching — fixes inflated article counts"
          >
            <Unlink className="h-4 w-4 mr-1.5" />
            {forceRescanArticles.isPending ? "Rescanning…" : "Force rescan all"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => backfillAliasLinks.mutate()}
            disabled={backfillAliasLinks.isPending}
          >
            <Link2 className="h-4 w-4 mr-1.5" />
            {backfillAliasLinks.isPending ? "Linking…" : "Link alias terms"}
          </Button>
          <a href="/glossary" target="_blank" rel="noopener noreferrer">
            <Button size="sm" variant="outline">
              <BookOpen className="h-4 w-4 mr-1.5" />
              Glossary page
            </Button>
          </a>
        </div>
      </div>

      {/* Manual import form — placed directly under the controls so it’s
          visible immediately when the button is clicked. */}
      {showImport && (
        <ImportConceptForm
          onCreated={() => {
            setShowImport(false);
            void qc.invalidateQueries({ queryKey: ["admin-concepts"] });
          }}
        />
      )}

      {/* ── Backfills panel ─────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border p-4 space-y-4">
        <p className="text-sm font-semibold">Backfills</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Annotation backfill */}
          <div className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <ScanSearch className="h-3.5 w-3.5 text-muted-foreground" />
                Article Annotation
              </div>
              {backfillRunning ? (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => pauseBackfill.mutate()} disabled={pauseBackfill.isPending}>
                  <Pause className="h-3 w-3 mr-1" />Pause
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => startBackfill.mutate()} disabled={startBackfill.isPending}>
                  <Play className="h-3 w-3 mr-1" />
                  {(bf?.processed ?? 0) > 0 && (bf?.remaining ?? 0) > 0 ? "Resume" : "Run"}
                </Button>
              )}
            </div>
            {bf ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {backfillRunning ? (
                    <span className="flex items-center gap-1"><RefreshCw className="h-3 w-3 animate-spin" />Running — {bf.processed} done · {bf.remaining} left</span>
                  ) : bf.stoppedReason ? (
                    <span className="text-amber-600">Paused: {bf.stoppedReason}</span>
                  ) : bf.remaining === 0 ? (
                    <span className="text-emerald-600">✓ Complete</span>
                  ) : (
                    <span>{bf.processed} done · {bf.remaining} left · {bf.failed} failed</span>
                  )}
                </p>
                {bf.totalPublished > 0 && (
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(100, ((bf.totalPublished - bf.remaining) / bf.totalPublished) * 100)}%` }} />
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground animate-pulse">Loading…</p>
            )}
          </div>

          {/* Alias audit */}
          <div className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
                Alias Audit
              </div>
              {auditRunning ? (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => cancelAliasAudit.mutate()} disabled={cancelAliasAudit.isPending}>
                  <Square className="h-3 w-3 mr-1" />Stop
                </Button>
              ) : (
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => startAliasAudit.mutate(true)} disabled={startAliasAudit.isPending} title="Dry run">Dry run</Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => startAliasAudit.mutate(false)} disabled={startAliasAudit.isPending}>
                    <Play className="h-3 w-3 mr-1" />Run
                  </Button>
                </div>
              )}
            </div>
            {auditRunning ? (
              <p className="text-xs text-muted-foreground flex items-center gap-1"><RefreshCw className="h-3 w-3 animate-spin" />Running LLM pass…</p>
            ) : auditReport ? (
              <p className="text-xs text-muted-foreground">
                {auditReport.dryRun && <span className="text-amber-600">Dry run · </span>}
                {auditReport.aliasesChecked} aliases · {auditReport.aliasesRemoved} removed ·{" "}
                {auditReport.relationshipsCreated} links
                {auditReport.llmSkipped && <span className="text-amber-600"> · AI skipped</span>}
              </p>
            ) : audit?.error ? (
              <p className="text-xs text-destructive">{audit.error}</p>
            ) : (
              <p className="text-xs text-muted-foreground">No run recorded yet</p>
            )}
          </div>

          {/* Merge sweep */}
          <div className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <GitMerge className="h-3.5 w-3.5 text-muted-foreground" />
                Merge Sweep
              </div>
              {mergeSweepRunning ? (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => cancelMergeSweep.mutate()} disabled={cancelMergeSweep.isPending}>
                  <Square className="h-3 w-3 mr-1" />Stop
                </Button>
              ) : (
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => startMergeSweep.mutate(true)} disabled={startMergeSweep.isPending} title="Detect duplicates without merging anything">Dry run</Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => startMergeSweep.mutate(false)} disabled={startMergeSweep.isPending}>
                    <Play className="h-3 w-3 mr-1" />Run
                  </Button>
                </div>
              )}
            </div>
            {mergeSweepRunning ? (
              <p className="text-xs text-muted-foreground flex items-center gap-1"><RefreshCw className="h-3 w-3 animate-spin" />Scanning for duplicate entries…</p>
            ) : mergeReport ? (
              <p className="text-xs text-muted-foreground">
                {mergeReport.dryRun && <span className="text-amber-600">Dry run · </span>}
                {mergeReport.pairsConsidered} candidate{mergeReport.pairsConsidered !== 1 ? "s" : ""} ·{" "}
                {mergeReport.merged.length} {mergeReport.dryRun ? "would merge" : "merged"} ·{" "}
                {mergeReport.needsReview.length} to review
                {mergeReport.llmSkipped && <span className="text-amber-600"> · AI skipped</span>}
              </p>
            ) : mergeSweep?.error ? (
              <p className="text-xs text-destructive">{mergeSweep.error}</p>
            ) : (
              <p className="text-xs text-muted-foreground">Finds entries that name the same concept twice and merges them into one.</p>
            )}
          </div>

          {/* Vault concept edge backfill */}
          <div className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <Database className="h-3.5 w-3.5 text-muted-foreground" />
                Vault Concept Edges
              </div>
              {edgeBackfillStatus.data?.running ? (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => cancelEdgeBackfill.mutate()} disabled={cancelEdgeBackfill.isPending}>
                  <Square className="h-3 w-3 mr-1" />Stop
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => startEdgeBackfill.mutate()} disabled={startEdgeBackfill.isPending || edgeBackfillStatus.data?.remaining === 0}>
                  <Play className="h-3 w-3 mr-1" />
                  {edgeBackfillStatus.data?.remaining === 0 ? "Done ✓" : "Run"}
                </Button>
              )}
            </div>
            {edgeBackfillStatus.data ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {edgeBackfillStatus.data.running ? (
                    <span className="flex items-center gap-1"><RefreshCw className="h-3 w-3 animate-spin" />{edgeBackfillStatus.data.scanned} scanned · {edgeBackfillStatus.data.edges} edges · {edgeBackfillStatus.data.remaining} left</span>
                  ) : edgeBackfillStatus.data.status === "failed" ? (
                    <span className="text-destructive">Failed: {edgeBackfillStatus.data.error ?? "unknown error"}</span>
                  ) : edgeBackfillStatus.data.remaining === 0 ? (
                    <span className="text-emerald-600">✓ All vault documents tagged</span>
                  ) : (
                    <span>{edgeBackfillStatus.data.remaining} documents untagged</span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  Links Source Vault documents to glossary terms (deterministic, no AI cost).
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground animate-pulse">Loading…</p>
            )}
          </div>

          {/* Concept-to-beat affinity recompute */}
          <div className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <Network className="h-3.5 w-3.5 text-muted-foreground" />
                Beat Affinities
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => recomputeBeatAffinities.mutate()}
                disabled={recomputeBeatAffinities.isPending || beatAffinityStatus.data?.running}
              >
                <Play className="h-3 w-3 mr-1" />
                Run
              </Button>
            </div>
            {beatAffinityStatus.data ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {beatAffinityStatus.data.running ? (
                    <span className="flex items-center gap-1">
                      <RefreshCw className="h-3 w-3 animate-spin" />
                      Recomputing profiles…
                    </span>
                  ) : beatAffinityStatus.data.conceptsWithProfile === 0 ? (
                    <span>No profiles yet — run to compute</span>
                  ) : (
                    <span>
                      {beatAffinityStatus.data.conceptsWithProfile} profiled ·{" "}
                      {beatAffinityStatus.data.bridgeConcepts} bridge concept
                      {beatAffinityStatus.data.bridgeConcepts !== 1 ? "s" : ""}
                      {beatAffinityStatus.data.lastComputedAt &&
                        ` · ${new Date(beatAffinityStatus.data.lastComputedAt).toLocaleDateString()}`}
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  Weighted beat profile per concept from mentions, vault sources and relationships
                  (deterministic, no AI cost). Also runs nightly.
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground animate-pulse">Loading…</p>
            )}
          </div>

          {/* Share card backfill */}
          <div className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <ImageIcon className="h-3.5 w-3.5 text-muted-foreground" />
                Share Cards
              </div>
              {shareCardBackfillStatus.data?.running ? (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => cancelShareCardBackfill.mutate()} disabled={cancelShareCardBackfill.isPending}>
                  <Square className="h-3 w-3 mr-1" />Stop
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => backfillShareCards.mutate()} disabled={backfillShareCards.isPending || shareCardBackfillStatus.data?.remaining === 0}>
                  <Play className="h-3 w-3 mr-1" />
                  {shareCardBackfillStatus.data?.remaining === 0 ? "Done ✓" : "Run"}
                </Button>
              )}
            </div>
            {shareCardBackfillStatus.data?.interrupted && (
              <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                Last run was interrupted (server restarted mid-job). {shareCardBackfillStatus.data.total > 0 && `${shareCardBackfillStatus.data.generated}/${shareCardBackfillStatus.data.total} processed before restart.`} Re-run to complete.
              </p>
            )}
            {shareCardBackfillStatus.data ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {shareCardBackfillStatus.data.running ? (
                    <span className="flex items-center gap-1"><RefreshCw className="h-3 w-3 animate-spin" />{shareCardBackfillStatus.data.generated} generated · {shareCardBackfillStatus.data.remaining} left</span>
                  ) : shareCardBackfillStatus.data.remaining === 0 ? (
                    <span className="text-emerald-600">✓ All cards generated</span>
                  ) : (
                    <span>{shareCardBackfillStatus.data.remaining} remaining</span>
                  )}
                </p>
                {shareCardBackfillStatus.data.total > 0 && (
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(100, (shareCardBackfillStatus.data.generated / shareCardBackfillStatus.data.total) * 100)}%` }} />
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground animate-pulse">Loading…</p>
            )}
          </div>

          {/* Rebuild all share cards */}
          <div className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
                Rebuild All Cards
              </div>
              {rebuildShareCardsStatus.data?.running ? (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => cancelRebuildShareCards.mutate()} disabled={cancelRebuildShareCards.isPending}>
                  <Square className="h-3 w-3 mr-1" />Stop
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => rebuildShareCards.mutate()} disabled={rebuildShareCards.isPending}>
                  <RotateCcw className="h-3 w-3 mr-1" />Rebuild
                </Button>
              )}
            </div>
            {rebuildShareCardsStatus.data?.interrupted && (
              <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                Last rebuild was interrupted (server restarted mid-job). {rebuildShareCardsStatus.data.total > 0 && `${rebuildShareCardsStatus.data.generated}/${rebuildShareCardsStatus.data.total} cleared before restart.`} Re-run to complete.
              </p>
            )}
            {rebuildShareCardsStatus.data ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {rebuildShareCardsStatus.data.running ? (
                    <span className="flex items-center gap-1">
                      <RefreshCw className="h-3 w-3 animate-spin" />
                      {rebuildShareCardsStatus.data.generated} / {rebuildShareCardsStatus.data.total} regenerated
                      {rebuildShareCardsStatus.data.failed > 0 && ` · ${rebuildShareCardsStatus.data.failed} failed`}
                    </span>
                  ) : rebuildShareCardsStatus.data.total > 0 && !rebuildShareCardsStatus.data.interrupted ? (
                    <span className="text-emerald-600">
                      ✓ {rebuildShareCardsStatus.data.generated} rebuilt · {rebuildShareCardsStatus.data.failed} failed
                    </span>
                  ) : (
                    <span>Force-regenerates all {rebuildShareCardsStatus.data.total || ""} live concept cards via the new compositor.</span>
                  )}
                </p>
                {rebuildShareCardsStatus.data.running && rebuildShareCardsStatus.data.total > 0 && (
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(100, (rebuildShareCardsStatus.data.generated / rebuildShareCardsStatus.data.total) * 100)}%` }} />
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground animate-pulse">Loading…</p>
            )}
            <p className="text-xs text-muted-foreground">Use this to fix cards generated by the old compositor (oversized text, wrong layout).</p>
          </div>

          {/* Source relevance backfill */}
          <div className={`rounded-lg border p-3 space-y-2 ${(sourceRelevanceBackfillStatus.data?.nullRelevanceCount ?? 0) > 0 && !sourceRelevanceBackfillStatus.data?.running ? "border-amber-500/50 bg-amber-500/5" : "border-border"}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <FilterX className="h-3.5 w-3.5 text-muted-foreground" />
                Source Relevance
                {(sourceRelevanceBackfillStatus.data?.nullRelevanceCount ?? 0) > 0 && !sourceRelevanceBackfillStatus.data?.running && (
                  <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-2.5 w-2.5" />
                    {sourceRelevanceBackfillStatus.data!.nullRelevanceCount.toLocaleString()} unverified
                  </span>
                )}
              </div>
              {sourceRelevanceBackfillStatus.data?.running ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => cancelSourceRelevanceBackfill.mutate()}
                  disabled={cancelSourceRelevanceBackfill.isPending || sourceRelevanceBackfillStatus.data?.cancelRequested}
                >
                  <Square className="h-3 w-3 mr-1" />Stop
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => backfillSourceRelevance.mutate()}
                  disabled={backfillSourceRelevance.isPending}
                >
                  <Play className="h-3 w-3 mr-1" />Run
                </Button>
              )}
            </div>
            {sourceRelevanceBackfillStatus.data?.interrupted && (
              <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                Last run was interrupted (server restarted mid-job). {sourceRelevanceBackfillStatus.data.total > 0 && `${sourceRelevanceBackfillStatus.data.processed}/${sourceRelevanceBackfillStatus.data.total} processed before restart.`} Re-run to continue.
              </p>
            )}
            {(sourceRelevanceBackfillStatus.data?.nullRelevanceCount ?? 0) > 0 && !sourceRelevanceBackfillStatus.data?.running && !sourceRelevanceBackfillStatus.data?.finishedAt && !sourceRelevanceBackfillStatus.data?.interrupted && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {sourceRelevanceBackfillStatus.data!.nullRelevanceCount.toLocaleString()} source{sourceRelevanceBackfillStatus.data!.nullRelevanceCount === 1 ? "" : "s"} have unverified relevance (
                <code className="text-[10px] bg-amber-500/10 rounded px-0.5">claim_relevant = NULL</code>). Run the backfill to clear them before the glossary goes public.
              </p>
            )}
            {sourceRelevanceBackfillStatus.data?.running ? (
              <>
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  {sourceRelevanceBackfillStatus.data.cancelRequested
                    ? "Stopping after current concept…"
                    : `${sourceRelevanceBackfillStatus.data.processed} / ${sourceRelevanceBackfillStatus.data.total} concepts scored`}
                  {!sourceRelevanceBackfillStatus.data.cancelRequested && sourceRelevanceBackfillStatus.data.failed > 0 && (
                    <span className="text-destructive ml-1">· {sourceRelevanceBackfillStatus.data.failed} failed</span>
                  )}
                </p>
                {sourceRelevanceBackfillStatus.data.total > 0 && (
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${Math.min(100, (sourceRelevanceBackfillStatus.data.processed / sourceRelevanceBackfillStatus.data.total) * 100)}%` }}
                    />
                  </div>
                )}
              </>
            ) : sourceRelevanceBackfillStatus.data?.finishedAt ? (
              <p className="text-xs text-muted-foreground">
                {sourceRelevanceBackfillStatus.data.processed} scored
                {sourceRelevanceBackfillStatus.data.failed > 0 && (
                  <span className="text-destructive"> · {sourceRelevanceBackfillStatus.data.failed} failed</span>
                )}
                {" "}— last run {new Date(sourceRelevanceBackfillStatus.data.finishedAt).toLocaleTimeString()}
                {(sourceRelevanceBackfillStatus.data.nullRelevanceCount ?? 0) > 0 && (
                  <span className="text-amber-600 dark:text-amber-400 ml-1">
                    · {sourceRelevanceBackfillStatus.data.nullRelevanceCount.toLocaleString()} still unverified (some may have failed)
                  </span>
                )}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Re-runs the claim-relevance filter on every stored concept source. Rows with{" "}
                <code className="text-[10px] bg-muted rounded px-0.5">claim_relevant = NULL</code> (legacy) get an
                explicit true/false so only vetted sources appear in the public source trail.
              </p>
            )}
          </div>

          {/* Bulk recompose */}
          <div className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <Wand2 className="h-3.5 w-3.5 text-muted-foreground" />
                Recompose Definitions
              </div>
              {bulkRecomposeStatus.data?.running ? (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => cancelBulkRecompose.mutate()} disabled={cancelBulkRecompose.isPending}>
                  <Square className="h-3 w-3 mr-1" />Stop
                </Button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkRecompose.mutate(false)} disabled={bulkRecompose.isPending} title="Regenerate real-life example, what it isnt, and commonly misused fields for concepts missing them">
                    <Play className="h-3 w-3 mr-1" />Run
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkRecompose.mutate(true)} disabled={bulkRecompose.isPending} title="Regenerate these fields for ALL concepts, not just missing ones">
                    <Wand2 className="h-3 w-3 mr-1" />Force
                  </Button>
                </div>
              )}
            </div>
            {bulkRecomposeStatus.data?.running ? (
              <>
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  {bulkRecomposeStatus.data.processed} done ·{" "}
                  {Math.max(0, bulkRecomposeStatus.data.total - bulkRecomposeStatus.data.processed - bulkRecomposeStatus.data.skipped - bulkRecomposeStatus.data.failed)} left
                  {bulkRecomposeStatus.data.failed > 0 && <span className="text-destructive ml-1">· {bulkRecomposeStatus.data.failed} failed</span>}
                </p>
                {bulkRecomposeStatus.data.total > 0 && (
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(100, ((bulkRecomposeStatus.data.processed + bulkRecomposeStatus.data.skipped) / bulkRecomposeStatus.data.total) * 100)}%` }} />
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Regenerate real-life example, "what it isn’t", and commonly misused fields. <b>Run</b> = missing only. <b>Force</b> = all concepts.</p>
            )}
          </div>
        </div>

        {/* Alias audit detailed results */}
        {auditReport && !auditReportDismissed && (
          <div className="border-t border-border pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">Last Alias Audit Details</p>
              <button
                onClick={() => setAuditReportDismissed(true)}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Dismiss audit results"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {auditReport.canonicalCollisions.length === 0 && auditReport.sharedAliases.length === 0 && auditReport.llmFlags.length === 0 ? (
              <p className="text-xs text-emerald-600">✓ No new conflations found</p>
            ) : (
              <>
                {auditReport.canonicalCollisions.length > 0 && (
                  <div>
                    <p className="text-xs font-medium">Aliases Naming Another Concept Directly</p>
                    <ul className="text-xs text-muted-foreground list-disc pl-5 mt-0.5">
                      {auditReport.canonicalCollisions.map((c, i) => (
                        <li key={i}>"{c.alias}" on <span className="font-mono">{c.conceptSlug}</span> → canonical term of <span className="font-mono">{c.matchesSlug}</span></li>
                      ))}
                    </ul>
                  </div>
                )}
                {auditReport.sharedAliases.length > 0 && (
                  <div>
                    <p className="text-xs font-medium">Same Alias on Multiple Concepts</p>
                    <ul className="text-xs text-muted-foreground list-disc pl-5 mt-0.5">
                      {auditReport.sharedAliases.map((s, i) => (
                        <li key={i}>"{s.alias}" → <span className="font-mono">{s.conceptSlugs.join(", ")}</span></li>
                      ))}
                    </ul>
                  </div>
                )}
                {auditReport.llmFlags.length > 0 && (
                  <div>
                    <p className="text-xs font-medium">AI-Flagged Conflations</p>
                    <ul className="text-xs text-muted-foreground list-disc pl-5 mt-0.5">
                      {auditReport.llmFlags.map((f, i) => (
                        <li key={i}>"{f.alias}" on <span className="font-mono">{f.conceptSlug}</span>{f.matchesSlug ? <> → <span className="font-mono">{f.matchesSlug}</span></> : null} — {f.reason}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
            {(auditReport.sharedAliasesAcknowledged ?? 0) > 0 && (
              <p className="text-xs text-muted-foreground">
                {auditReport.sharedAliasesAcknowledged} previously reviewed shared alias
                {auditReport.sharedAliasesAcknowledged === 1 ? "" : "es"} not re-listed (already marked distinct on an earlier run)
              </p>
            )}
          </div>
        )}

        {/* Merge sweep detailed results */}
        {mergeReport && !mergeReportDismissed && (
          <div className="border-t border-border pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">
                Last Merge Sweep Details
                {mergeReport.dryRun && <span className="text-amber-600"> (dry run — nothing was changed)</span>}
              </p>
              <button
                onClick={() => setMergeReportDismissed(true)}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Dismiss merge sweep results"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {mergeReport.merged.length === 0 && mergeReport.needsReview.length === 0 ? (
              <p className="text-xs text-emerald-600">✓ No duplicate entries found ({mergeReport.conceptsChecked} concepts checked)</p>
            ) : (
              <>
                {mergeReport.merged.length > 0 && (
                  <div>
                    <p className="text-xs font-medium">{mergeReport.dryRun ? "Would Merge" : "Merged"}</p>
                    <ul className="text-xs text-muted-foreground list-disc pl-5 mt-0.5">
                      {mergeReport.merged.map((m, i) => (
                        <li key={i}>
                          "{m.mergedTerm}" <span className="font-mono">({m.mergedSlug})</span> → "{m.survivorTerm}" <span className="font-mono">({m.survivorSlug})</span>
                          {" — "}{m.reason}
                          {m.confidence != null && <> ({Math.round(m.confidence * 100)}%)</>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {mergeReport.needsReview.length > 0 && (
                  <div>
                    <p className="text-xs font-medium">Needs Manual Review</p>
                    <ul className="text-xs text-muted-foreground list-disc pl-5 mt-0.5">
                      {mergeReport.needsReview.map((r, i) => (
                        <li key={i}>
                          "{r.aTerm}" <span className="font-mono">({r.aSlug})</span> vs "{r.bTerm}" <span className="font-mono">({r.bSlug})</span>
                          {" — "}{r.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
            {mergeReport.distinctRecorded > 0 && (
              <p className="text-xs text-muted-foreground">
                {mergeReport.distinctRecorded} pair{mergeReport.distinctRecorded === 1 ? "" : "s"} judged distinct
                {mergeReport.dryRun ? " (would be recorded so they are not re-proposed)" : " — recorded so they are never re-proposed"}
              </p>
            )}
            {mergeReport.llmSkipped && (
              <p className="text-xs text-amber-600">AI judge skipped: {mergeReport.llmSkipReason ?? "unknown reason"}</p>
            )}
          </div>
        )}
      </div>

      {/* ── Quarantine panel ─────────────────────────────────────────────── */}
      {((quarantinedData?.concepts.length ?? 0) > 0 || quarantinedLoading) && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/50 dark:border-amber-900/40 dark:bg-amber-950/20 p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4" />
            Definition Quarantine
            {quarantinedData && (
              <span className="ml-auto text-xs font-normal text-amber-700 dark:text-amber-500">
                {quarantinedData.concepts.length} concept{quarantinedData.concepts.length !== 1 ? "s" : ""}
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 text-amber-800 dark:text-amber-400"
              onClick={() => setQuarantineCollapsed((s) => !s)}
              title={quarantineCollapsed ? "Expand" : "Collapse"}
            >
              {quarantineCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
            </Button>
          </div>
          {!quarantineCollapsed && (
            <>
              <div className="flex items-center gap-2">
                <p className="text-xs text-amber-700 dark:text-amber-500 flex-1">
                  These concepts were automatically hidden because their glossary definition was too article-specific or had insufficient confidence. Review each one — restore to draft for editing, or delete if the term has no good standalone definition.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs text-destructive hover:text-destructive shrink-0"
                  onClick={() => {
                    const count = quarantinedData?.concepts.length ?? 0;
                    if (count > 0 && confirm(`Delete ALL ${count} quarantined concept${count !== 1 ? "s" : ""} permanently? This cannot be undone.`)) {
                      deleteAllQuarantined.mutate();
                    }
                  }}
                  disabled={deleteAllQuarantined.isPending}
                >
                  <Trash2 className="h-3 w-3 mr-1" />
                  Delete all
                </Button>
              </div>
              {quarantinedLoading ? (
                <p className="text-xs text-muted-foreground animate-pulse">Loading…</p>
              ) : (
                <div className="space-y-2">
                  {quarantinedData?.concepts.map((c) => (
                    <div key={c.id} className="rounded-lg border border-amber-200 dark:border-amber-900/40 bg-background p-3 space-y-1.5">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium">{c.term}</p>
                          {c.quarantineReason && (
                            <p className="text-xs text-amber-700 dark:text-amber-500 mt-0.5">{c.quarantineReason}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => restoreConcept.mutate(c.id)}
                            disabled={restoreConcept.isPending}
                          >
                            <RotateCcw className="h-3 w-3 mr-1" />
                            Restore
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs text-destructive hover:text-destructive"
                            onClick={() => {
                              if (confirm(`Delete "${c.term}" permanently?`)) deleteConcept.mutate(c.id);
                            }}
                            disabled={deleteConcept.isPending}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                      {c.definition && (
                        <p className="text-xs text-muted-foreground line-clamp-2 italic">"{c.definition}"</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Glossary Vault status */}
      <div className="rounded-xl border border-border p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Database className="h-4 w-4" />
            Glossary Vault Memory
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => syncVault.mutate()}
            disabled={syncVault.isPending}
          >
            <RefreshCw className={`h-4 w-4 mr-1.5 ${syncVault.isPending ? "animate-spin" : ""}`} />
            {syncVault.isPending ? "Syncing…" : "Sync now"}
          </Button>
        </div>
        {vaultStatus ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-center">
                <p className="text-xl font-bold text-emerald-700">{vaultStatus.embedded}</p>
                <p className="text-xs text-emerald-600 mt-0.5">In memory</p>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-center">
                <p className="text-xl font-bold text-amber-700">{vaultStatus.pendingEmbed}</p>
                <p className="text-xs text-amber-600 mt-0.5">Pending embed</p>
              </div>
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-center">
                <p className="text-xl font-bold text-gray-500">{vaultStatus.unavailable}</p>
                <p className="text-xs text-gray-500 mt-0.5">Unavailable</p>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-center">
                <p className="text-xl font-bold text-foreground">{vaultStatus.total}</p>
                <p className="text-xs text-muted-foreground mt-0.5">Total docs</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {vaultStatus.lastReconcileAt ? (
                <>
                  Last reconcile:{" "}
                  <span className="font-medium">
                    {new Date(vaultStatus.lastReconcileAt).toLocaleString()}
                  </span>
                  {" · "}
                </>
              ) : (
                "No reconcile run recorded yet · "
              )}
              The hourly cron syncs concepts automatically. "Sync now" runs a full pass immediately.
              Each synced doc must also be embedded by the vault embed sweep before it becomes
              available as draft context.
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground animate-pulse">Loading vault status…</p>
        )}
      </div>

      {/* AI costs */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <DollarSign className="h-4 w-4" />
          AI Cost — Concept Pipeline
        </div>
        {costs && (
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-2 font-medium">Function</th>
                  <th className="text-right px-4 py-2 font-medium">Calls</th>
                  <th className="text-right px-4 py-2 font-medium">Last 30 days</th>
                  <th className="text-right px-4 py-2 font-medium">All time</th>
                  <th className="text-left px-4 py-2 font-medium">Last model</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {costs.functions.map((f) => (
                  <tr key={f.function}>
                    <td className="px-4 py-2 font-mono text-xs">{f.function}</td>
                    <td className="px-4 py-2 text-right">{f.calls}</td>
                    <td className="px-4 py-2 text-right font-mono text-xs">
                      ${f.usd30d.toFixed(4)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs">
                      ${f.totalUsd.toFixed(4)}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {f.lastModel ?? "—"}
                    </td>
                  </tr>
                ))}
                <tr className="bg-muted/30 font-medium">
                  <td className="px-4 py-2 text-xs">Total</td>
                  <td className="px-4 py-2" />
                  <td className="px-4 py-2 text-right font-mono text-xs">
                    ${costs.totalUsd30d.toFixed(4)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs">
                    ${costs.totalUsd.toFixed(4)}
                  </td>
                  <td className="px-4 py-2" />
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {!costs && (
          <p className="text-xs text-muted-foreground">Loading cost data…</p>
        )}
      </div>

      {/* Feature settings */}
      <ConceptSettingsPanel />

      {/* Backfill progress */}
      {bf && (bf.running || bf.status !== "idle") && (
        <div className="rounded-xl border border-border p-4 text-sm space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <RefreshCw className={`h-4 w-4 ${bf.running ? "animate-spin text-primary" : "text-muted-foreground"}`} />
            <span className="font-semibold">
              Backfill {bf.running ? "running" : bf.status}
            </span>
            {bf.stoppedReason && (
              <Badge variant="outline" className="text-xs">
                stopped: {bf.stoppedReason}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {bf.processed} processed · {bf.skipped} skipped · {bf.failed} failed —{" "}
            {bf.remaining} of {bf.totalPublished} published articles remaining
          </p>
          {bf.error && <p className="text-xs text-destructive">{bf.error}</p>}
          {!bf.running && bf.remaining > 0 && (
            <p className="text-xs text-muted-foreground">
              Progress is durable — starting the backfill again resumes where it left off.
            </p>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border border-input overflow-hidden text-sm">
          {(["all", "live", "draft", "hidden"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={[
                "px-3 py-1.5 capitalize transition-colors",
                statusFilter === s
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted text-foreground",
              ].join(" ")}
            >
              {s}
            </button>
          ))}
        </div>
        <Input
          placeholder="Search terms…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="w-48 h-8 text-sm"
        />
        <button
          onClick={() => setRetractionFlagged((f) => !f)}
          className={[
            "flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs transition-colors",
            retractionFlagged
              ? "bg-amber-100 border-amber-400 text-amber-800 dark:bg-amber-950/40 dark:border-amber-500 dark:text-amber-300"
              : "border-input bg-background hover:bg-muted text-foreground",
          ].join(" ")}
          title="Show only concepts flagged by a source retraction"
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          Retraction flagged
        </button>
      </div>

      {/* List */}
      {isLoading && (
        <div className="py-16 text-center text-muted-foreground text-sm animate-pulse">
          Loading concepts…
        </div>
      )}
      {isError && (
        <div className="py-16 text-center text-destructive text-sm">
          Failed to load concepts.
        </div>
      )}

      {!isLoading && !isError && concepts.length === 0 && (
        <div className="py-16 text-center text-muted-foreground text-sm">
          {q
            ? `No concepts matching "${q}".`
            : "No concepts yet. Run the backfill to detect terms in published articles."}
        </div>
      )}

      {concepts.length > 0 && missingCardCount > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-sm">
          <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
          <span className="text-amber-200">
            {missingCardCount} term{missingCardCount !== 1 ? "s" : ""} missing a CSS share card — Term of the Day will skip these.
          </span>
          <a
            href="/admin/media-library/glossary"
            className="ml-auto text-amber-300 hover:text-amber-100 underline text-xs shrink-0 whitespace-nowrap"
          >
            Rebuild All Cards →
          </a>
        </div>
      )}

      {concepts.length > 0 && (
        <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
          {concepts.map((c) => (
            <div key={c.id}>
              <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors">
                {/* Term + status */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm">{c.term}</span>
                    <StatusBadge status={c.status} />
                    <VaultStatusBadge status={c.vaultStatus} />
                    <span className="text-xs text-muted-foreground">
                      detect <ConfidencePip value={c.detectionConfidence} /> def{" "}
                      <ConfidencePip value={c.definitionConfidence} />
                    </span>
                    {c.articleCount > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {c.articleCount} art.
                      </span>
                    )}
                    {c.sourceSummary && c.sourceSummary.total > 0 && (
                      <button
                        type="button"
                        title="Open source claim-relevance trail"
                        onClick={() => {
                          setEditingId(null);
                          setMergingId(null);
                          setRelationshipsId(null);
                          setBeatProfileId(null);
                          setVaultDocsId(null);
                          setSourceTrailId(sourceTrailId === c.id ? null : c.id);
                        }}
                        className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium border transition-colors cursor-pointer ${
                          c.sourceSummary.filtered > 0
                            ? "bg-rose-50 text-rose-600 border-rose-300/60 hover:bg-rose-100"
                            : "bg-emerald-50 text-emerald-700 border-emerald-300/60 hover:bg-emerald-100"
                        }`}
                      >
                        <ShieldCheck className="h-2.5 w-2.5 shrink-0" />
                        {c.sourceSummary.relevant} relevant
                        {c.sourceSummary.filtered > 0 && (
                          <span className="text-rose-500">/ {c.sourceSummary.filtered} filtered</span>
                        )}
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                    {c.hoverDefinition}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1.5 shrink-0">
                  <label
                    className="flex items-center gap-1 mr-1 text-xs text-muted-foreground cursor-pointer select-none"
                    title="When unchecked, this term never appears as a hover card in article bodies (glossary page unaffected)"
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-primary cursor-pointer"
                      checked={c.hoverEnabled}
                      disabled={toggleHover.isPending && toggleHover.variables?.id === c.id}
                      onChange={(e) =>
                        toggleHover.mutate({ id: c.id, enabled: e.target.checked })
                      }
                    />
                    Hover
                  </label>
                  {c.wikiUrl && (
                    <a
                      href={c.wikiUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      title="Wikipedia"
                    >
                      <Button size="icon" variant="ghost" className="h-7 w-7">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </a>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    title="Edit"
                    onClick={() => {
                      setMergingId(null);
                      setEditingId(editingId === c.id ? null : c.id);
                    }}
                  >
                    <Edit2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    title="Merge into another concept"
                    onClick={() => {
                      setEditingId(null);
                      setRelationshipsId(null);
                      setMergingId(mergingId === c.id ? null : c.id);
                    }}
                  >
                    <GitMerge className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-violet-600"
                    title="Manage relationships"
                    onClick={() => {
                      setEditingId(null);
                      setMergingId(null);
                      setVaultDocsId(null);
                      setRelationshipsId(relationshipsId === c.id ? null : c.id);
                    }}
                  >
                    <Link2 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className={`h-7 w-7 ${sourceTrailId === c.id ? "text-emerald-500 bg-emerald-500/10" : "text-emerald-600"}`}
                    title="Source claim-relevance trail"
                    onClick={() => {
                      setEditingId(null);
                      setMergingId(null);
                      setRelationshipsId(null);
                      setBeatProfileId(null);
                      setVaultDocsId(null);
                      setSourceTrailId(sourceTrailId === c.id ? null : c.id);
                    }}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className={`h-7 w-7 ${claimsId === c.id ? "text-cyan-500 bg-cyan-500/10" : "text-cyan-600"}`}
                    title="Claim intelligence"
                    onClick={() => {
                      setEditingId(null);
                      setMergingId(null);
                      setRelationshipsId(null);
                      setBeatProfileId(null);
                      setSourceTrailId(null);
                      setVaultDocsId(null);
                      setClaimsId(claimsId === c.id ? null : c.id);
                    }}
                  >
                    <Layers className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className={`h-7 w-7 ${vaultDocsId === c.id ? "text-teal-500 bg-teal-500/10" : "text-teal-600"}`}
                    title="Linked vault documents"
                    onClick={() => {
                      setEditingId(null);
                      setMergingId(null);
                      setRelationshipsId(null);
                      setBeatProfileId(null);
                      setSourceTrailId(null);
                      setVaultDocsId(vaultDocsId === c.id ? null : c.id);
                    }}
                  >
                    <Database className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className={`h-7 w-7 ${beatProfileId === c.id ? "text-indigo-500 bg-indigo-500/10" : "text-indigo-600"}`}
                    title="Beat profile"
                    onClick={() => {
                      setEditingId(null);
                      setMergingId(null);
                      setRelationshipsId(null);
                      setVaultDocsId(null);
                      setSourceTrailId(null);
                      setBeatProfileId(beatProfileId === c.id ? null : c.id);
                    }}
                  >
                    <Network className="h-3.5 w-3.5" />
                  </Button>
                  {c.status !== "live" && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-green-600"
                      title="Publish"
                      onClick={() => publishConcept.mutate(c.id)}
                    >
                      <CheckCircle className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {c.status === "live" && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-muted-foreground"
                      title="Hide"
                      onClick={() => hideConcept.mutate(c.id)}
                    >
                      <EyeOff className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {c.status === "live" && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-amber-600"
                      title="Regenerate share card"
                      disabled={
                        regenShareCard.isPending && regenShareCard.variables === c.id
                      }
                      onClick={() => regenShareCard.mutate(c.id)}
                    >
                      {regenShareCard.isPending && regenShareCard.variables === c.id ? (
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ImageIcon className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className={`h-7 w-7 ${
                      cardViewId === c.id
                        ? "text-amber-400 bg-amber-400/10"
                        : c.cardImageUrl
                          ? "text-amber-500/70 hover:text-amber-400"
                          : "text-muted-foreground/40 hover:text-muted-foreground"
                    }`}
                    title={c.cardImageUrl ? "View CSS share card" : "No CSS card captured yet"}
                    onClick={() => {
                      setEditingId(null);
                      setMergingId(null);
                      setRelationshipsId(null);
                      setCardViewId(cardViewId === c.id ? null : c.id);
                    }}
                  >
                    <Layers className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-sky-600"
                    title="Scan articles for this term"
                    disabled={scanArticles.isPending && scanArticles.variables?.id === c.id}
                    onClick={() => scanArticles.mutate({ id: c.id })}
                  >
                    {scanArticles.isPending && scanArticles.variables?.id === c.id ? (
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ScanSearch className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-fuchsia-600"
                    title="Re-check source claim-relevance"
                    disabled={recheckSources.isPending && recheckSources.variables === c.id}
                    onClick={() => recheckSources.mutate(c.id)}
                  >
                    {recheckSources.isPending && recheckSources.variables === c.id ? (
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FilterX className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-destructive"
                    title="Delete"
                    onClick={() => {
                      if (window.confirm(`Delete concept "${c.term}"?`)) {
                        deleteConcept.mutate(c.id);
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              {scanResults[c.id] && (
                <div className="px-4 pb-2 text-xs text-muted-foreground">
                  Last scan: {scanResults[c.id]!.created} new mention
                  {scanResults[c.id]!.created !== 1 ? "s" : ""} added
                  {" · "}
                  {scanResults[c.id]!.matched} article
                  {scanResults[c.id]!.matched !== 1 ? "s" : ""} matched of{" "}
                  {scanResults[c.id]!.scanned} scanned
                </div>
              )}
              {cardViewId === c.id && (
                <div className="px-4 pb-4 pt-3 border-t border-border bg-muted/20">
                  {c.cardImageUrl ? (
                    <div className="flex items-start gap-4">
                      <a
                        href={c.cardImageUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open full-size card"
                        className="shrink-0"
                      >
                        <img
                          src={c.cardImageUrl}
                          alt={`${c.term} share card`}
                          className="rounded shadow-md ring-1 ring-border hover:ring-amber-400/60 transition-all block"
                          style={{ width: 150, height: 267, objectFit: "cover" }}
                        />
                      </a>
                      <div className="text-xs text-muted-foreground space-y-1.5 pt-1">
                        <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                          <CheckCircle className="h-3.5 w-3.5 text-emerald-400" />
                          Card captured
                        </p>
                        <p className="text-muted-foreground">1080×1920 portrait (9:16) — Term of the Day will include this term.</p>
                        <p>
                          <a
                            href="/admin/media-library/glossary"
                            className="text-primary hover:underline"
                          >
                            Manage all cards →
                          </a>
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                      <div className="space-y-1 text-sm">
                        <p className="font-medium text-amber-300">No card captured — excluded from Term of the Day pool</p>
                        <p className="text-xs text-muted-foreground">
                          Go to{" "}
                          <a
                            href="/admin/media-library/glossary"
                            className="text-primary hover:underline"
                          >
                            Glossary Cards
                          </a>{" "}
                          and click <strong>Rebuild All Cards</strong> to capture missing cards.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {editingId === c.id && (
                <ConceptEditPanel concept={c} onClose={() => setEditingId(null)} />
              )}
              {mergingId === c.id && (
                <ConceptMergePanel
                  concept={c}
                  candidates={concepts}
                  onClose={() => setMergingId(null)}
                />
              )}
              {relationshipsId === c.id && (
                <ConceptRelationshipsPanel
                  concept={c}
                  candidates={concepts}
                  onClose={() => setRelationshipsId(null)}
                />
              )}
              {beatProfileId === c.id && (
                <ConceptBeatProfilePanel concept={c} onClose={() => setBeatProfileId(null)} />
              )}
              {vaultDocsId === c.id && (
                <ConceptVaultDocsPanel concept={c} onClose={() => setVaultDocsId(null)} />
              )}
              {claimsId === c.id && (
                <ClaimIntelligencePanel concept={c} onClose={() => setClaimsId(null)} />
              )}
              {sourceTrailId === c.id && (
                <ConceptSourceTrailPanel concept={c} onClose={() => setSourceTrailId(null)} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Cross-Beat Radar & Evidence Health (Task #340) */}
      <ConceptRadarHealth />

      {/* Processing runs */}
      <div className="space-y-3">
        <button
          onClick={() => setShowRuns((v) => !v)}
          className="flex items-center gap-2 text-sm font-semibold hover:text-primary transition-colors"
        >
          <History className="h-4 w-4" />
          Processing runs {runs.length > 0 && `(${runs.length})`}
          <span className="text-xs text-muted-foreground font-normal">
            {showRuns ? "hide" : "show"}
          </span>
        </button>
        {showRuns && runs.length === 0 && (
          <p className="text-xs text-muted-foreground">No processing runs yet.</p>
        )}
        {showRuns && runs.length > 0 && (
          <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
            {runs.map((r) => (
              <div key={r.id} className="px-4 py-3 text-sm">
                <div className="flex items-center gap-2 flex-wrap">
                  <a
                    href={`/article/${r.articleSlug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium hover:underline truncate max-w-md"
                  >
                    {r.articleTitle}
                  </a>
                  <Badge
                    variant="outline"
                    className={`text-xs ${
                      r.status === "completed"
                        ? "text-green-700"
                        : r.status === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground"
                    }`}
                  >
                    {r.status}
                  </Badge>
                  {r.articleDisabled && (
                    <Badge variant="outline" className="text-xs text-muted-foreground">
                      explainers off
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {r.conceptsFound} concepts · {r.mentionsCreated} mentions
                    {r.model ? ` · ${r.model}` : ""}
                  </span>
                  <span className="text-xs text-muted-foreground ml-auto shrink-0">
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    title={
                      r.articleDisabled
                        ? "Re-enable concept explainers on this article"
                        : "Disable concept explainers on this article"
                    }
                    onClick={() =>
                      toggleArticle.mutate({
                        articleId: r.articleId,
                        disabled: !r.articleDisabled,
                      })
                    }
                    disabled={toggleArticle.isPending}
                  >
                    <Ban className="h-3.5 w-3.5 mr-1" />
                    {r.articleDisabled ? "Enable" : "Disable"}
                  </Button>
                </div>
                {r.errorMessage && (
                  <p className="text-xs text-destructive mt-1">{r.errorMessage}</p>
                )}
                {r.skippedCandidates.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Skipped:{" "}
                    {r.skippedCandidates
                      .map(
                        (s) =>
                          `${s.term} (${s.reason}, ${Math.round(s.confidence * 100)}%)`,
                      )
                      .join(" · ")}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
