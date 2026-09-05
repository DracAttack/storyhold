import {
  useGetSourceVaultStatus,
  useListSourceDocuments,
  useIngestSourceUrl,
  useUploadSourceDocument,
  useSearchSourceLeads,
  useRetrieveSourceChunks,
  useDeleteSourceDocument,
  useApproveSourceDocument,
  useSetSourceDocumentAuthority,
  useReclassifySourceDomains,
  useGetSourceQueue,
  useEnqueueSourceUrls,
  useListCategories,
  useGetArticle,
  getGetSourceVaultStatusQueryKey,
  getListSourceDocumentsQueryKey,
  getGetSourceQueueQueryKey,
  getGetArticleQueryKey,
  type SourceDocument,
  type SourceDocumentListItem,
  type SourceLead,
  type RetrievalHit,
  type ListSourceDocumentsParams,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Library,
  Loader2,
  Search,
  Sparkles,
  Trash2,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Plus,
  X,
  ListPlus,
  ShieldCheck,
  Copy,
  Lock,
  Upload,
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import { useEffect, useState } from "react";
import { format } from "date-fns";

// --- Source Vault admin (Phase 0 spike) ----------------------------------
// One page to exercise + inspect the whole "newsroom memory" loop: discover
// leads (Perplexity search), ingest a URL (SSRF-safe fetch → extract →
// quality-score → embed → store), run semantic retrieval over stored chunks,
// and browse/approve/delete the stored documents + their chunks. Degrades
// visibly when Perplexity is unconfigured (status banner + disabled paid paths).

const STATUS_META: Record<string, { label: string; className: string }> = {
  embedded: { label: "Embedded", className: "bg-emerald-100 text-emerald-700" },
  extracted: { label: "Extracted", className: "bg-blue-100 text-blue-700" },
  low_quality: { label: "Held (low quality)", className: "bg-amber-100 text-amber-700" },
  failed: { label: "Failed", className: "bg-rose-100 text-rose-700" },
  fetched: { label: "Fetched", className: "bg-muted text-muted-foreground" },
};

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status, className: "bg-muted text-muted-foreground" };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full capitalize ${meta.className}`}>{meta.label}</span>
  );
}

// Editorial lifecycle badge — only rendered when NOT the default `active`, so a
// healthy document stays visually quiet and stale/superseded/etc. stand out.
const LIFECYCLE_META: Record<string, { label: string; className: string }> = {
  stale: { label: "Stale", className: "bg-amber-100 text-amber-700" },
  superseded: { label: "Superseded", className: "bg-violet-100 text-violet-700" },
  retracted: { label: "Retracted", className: "bg-rose-100 text-rose-700" },
  unavailable: { label: "Unavailable", className: "bg-zinc-200 text-zinc-700" },
};

export function LifecycleBadge({ status }: { status?: string }) {
  if (status === "active" || !status) return null;
  const meta = LIFECYCLE_META[status] ?? { label: status, className: "bg-muted text-muted-foreground" };
  return <span className={`text-xs px-2 py-0.5 rounded-full ${meta.className}`}>{meta.label}</span>;
}

// Ordered strongest → weakest so the dropdown reads top-down by trust.
export const AUTHORITY_TIERS = [
  "primary",
  "firsthand",
  "wire",
  "reported",
  "commentary",
  "social",
  "aggregator",
  "reference",
  "unknown",
] as const;

export const AUTHORITY_CLASS: Record<string, string> = {
  primary: "bg-emerald-100 text-emerald-700",
  firsthand: "bg-teal-100 text-teal-700",
  wire: "bg-sky-100 text-sky-700",
  reported: "bg-blue-100 text-blue-700",
  commentary: "bg-indigo-100 text-indigo-700",
  social: "bg-amber-100 text-amber-700",
  aggregator: "bg-zinc-200 text-zinc-700",
  reference: "bg-slate-100 text-slate-600",
  unknown: "bg-muted text-muted-foreground",
};

const QUEUE_STATUS_CLASS: Record<string, string> = {
  pending: "bg-sky-100 text-sky-700",
  processing: "bg-indigo-100 text-indigo-700",
  done: "bg-emerald-100 text-emerald-700",
  failed: "bg-rose-100 text-rose-700",
  skipped: "bg-muted text-muted-foreground",
};

// How a queued URL was found — lets the queue distinguish admin-pasted URLs from
// URLs the vault discovered on its own (Perplexity search / Trend Scout signals).
const SOURCE_META: Record<string, { label: string; className: string }> = {
  manual_url: { label: "Manual", className: "bg-zinc-200 text-zinc-700" },
  manual_upload: { label: "Upload", className: "bg-zinc-200 text-zinc-700" },
  perplexity_search: { label: "Discovered", className: "bg-violet-100 text-violet-700" },
  trend_signal: { label: "Trend", className: "bg-amber-100 text-amber-700" },
  known_source: { label: "Known", className: "bg-teal-100 text-teal-700" },
};

export function errText(err: unknown, fallback: string): string {
  const e = err as { data?: { error?: string; message?: string } };
  return e?.data?.message ?? e?.data?.error ?? fallback;
}

function parseDomains(raw: string): string[] | undefined {
  const list = raw
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  return list.length > 0 ? list : undefined;
}

function ClaimOperationsCard() {
  const [report, setReport] = useState<any>(null);
  const [jobs, setJobs] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => {
    const [latest, status] = await Promise.all([
      fetch("/api/admin/vault/calibrate-claims/latest", { credentials: "include" }).then((r) => r.json()),
      fetch("/api/admin/vault/claim-jobs/status", { credentials: "include" }).then((r) => r.json()),
    ]);
    setReport(latest.report ?? null);
    setJobs(status);
  };
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const post = async (path: string, body: unknown, label: string) => {
    setBusy(label);
    try {
      const res = await fetch(`/api/admin${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      toast.success(
        data.dryRun
          ? `Sampled ${Number(data.documentsSampled ?? 0).toLocaleString()} sources: about ${Number(data.estimatedCostUsd ?? 0).toFixed(4)}. Projected full backfill for ${Number(data.eligibleDocuments ?? 0).toLocaleString()} eligible sources: about ${Number(data.projectedCostUsd ?? 0).toFixed(4)}.`
          : data.alreadyRunning
            ? `${label} is already running`
            : `${label} started`,
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="p-4 mb-6 space-y-3">
      <div>
        <h2 className="font-semibold flex items-center gap-2"><Sparkles className="h-4 w-4 text-cyan-600" /> Claim Layer</h2>
        <p className="text-xs text-muted-foreground">Calibrate extraction cost and quality before creating the reusable evidence-claim graph.</p>
      </div>
      <div className="flex gap-2 flex-wrap">
        <Button size="sm" variant="outline" disabled={Boolean(busy) || jobs?.calibration?.running}
          onClick={() => void post("/vault/calibrate-claims", { sampleSize: 1000 }, "Calibration")}>
          {jobs?.calibration?.running ? "Calibrating…" : "Run calibration (1,000 sources)"}
        </Button>
        <Button size="sm" variant="outline" disabled={Boolean(busy) || report?.status !== "succeeded"}
          onClick={() => void post("/vault/backfill-claims", { dryRun: true }, "Dry run")}>Full backfill estimate</Button>
        <Button size="sm" disabled={Boolean(busy) || jobs?.backfill?.running || report?.status !== "succeeded"}
          onClick={() => void post("/vault/backfill-claims", { batchSize: 500 }, "Claim backfill")}>
          {jobs?.backfill?.running ? "Backfilling…" : "Start backfill"}
        </Button>
      </div>
      {report ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 text-xs">
          <div><span className="text-muted-foreground">Sources</span><p className="font-semibold">{Number(report.documentsSampled ?? 0).toLocaleString()}</p></div>
          <div><span className="text-muted-foreground">Claims</span><p className="font-semibold">{Number(report.claimsExtracted ?? 0).toLocaleString()}</p></div>
          <div><span className="text-muted-foreground">No-claim documents</span><p className="font-semibold">{Number(report.noClaimDocuments ?? 0).toLocaleString()}</p></div>
          <div><span className="text-muted-foreground">No-claim sections</span><p className="font-semibold">{Number(report.noClaimSections ?? 0).toLocaleString()}</p></div>
          <div><span className="text-muted-foreground">Input tokens</span><p className="font-semibold">{Number(report.inputTokens ?? 0).toLocaleString()}</p></div>
          <div><span className="text-muted-foreground">Output tokens</span><p className="font-semibold">{Number(report.outputTokens ?? 0).toLocaleString()}</p></div>
          <div><span className="text-muted-foreground">Duplicate rate</span><p className="font-semibold">{(Number(report.duplicateRate ?? 0) * 100).toFixed(1)}%</p></div>
          <div>
            <span className="text-muted-foreground">Invalid JSON rate</span>
            <p className="font-semibold">
              {report.sectionsProcessed
                ? `${((Number(report.invalidJsonCount ?? 0) / Number(report.sectionsProcessed)) * 100).toFixed(1)}% (${Number(report.invalidJsonCount ?? 0).toLocaleString()})`
                : "0.0% (0)"}
            </p>
          </div>
          <div><span className="text-muted-foreground">Span failures</span><p className="font-semibold">{report.spanVerificationFailures}</p></div>
          <div><span className="text-muted-foreground">Total cost</span><p className="font-semibold">${Number(report.costUsd ?? 0).toFixed(4)}</p></div>
          <div><span className="text-muted-foreground">Cost / source</span><p className="font-semibold">${Number(report.costPerSource ?? 0).toFixed(5)}</p></div>
          <div><span className="text-muted-foreground">Cost / useful claim</span><p className="font-semibold">${Number(report.costPerUsefulClaim ?? 0).toFixed(5)}</p></div>
        </div>
      ) : <p className="text-xs text-muted-foreground">No calibration has run yet. Backfill stays locked until calibration succeeds.</p>}
      {report?.filterCounts && Object.keys(report.filterCounts).length > 0 && (
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Excluded before calibration:</span>{" "}
          {Object.entries(report.filterCounts)
            .map(([name, count]) => `${name.replaceAll("_", " ")}: ${Number(count).toLocaleString()}`)
            .join(" · ")}
        </div>
      )}
      {jobs?.backfill?.progress && (
        <p className="text-xs text-muted-foreground">
          Backfill: {jobs.backfill.progress.processed ?? 0} sources · {jobs.backfill.progress.claims ?? 0} claims
          {jobs.backfill.progress.failed ? ` · ${jobs.backfill.progress.failed} need retry` : ""}
          {jobs.backfill.progress.providerState ? ` · Gemini ${String(jobs.backfill.progress.providerState).replace("JOB_STATE_", "").toLowerCase()}` : ""}
        </p>
      )}
      {report?.status === "failed" && report.error && (
        <p className="text-xs text-destructive">Calibration failed: {report.error}</p>
      )}
      {jobs?.backfill?.status === "failed" && jobs.backfill.error && (
        <p className="text-xs text-destructive">Backfill stopped: {jobs.backfill.error}</p>
      )}
    </Card>
  );
}

export default function SourceVault() {
  const qc = useQueryClient();
  const urlSearch = useSearch();
  const [ingestUrl, setIngestUrl] = useState("");
  const [ingestTier, setIngestTier] = useState<string>("");
  const [approveLowQuality, setApproveLowQuality] = useState(false);
  const [uploadBeatSlug, setUploadBeatSlug] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchDomains, setSearchDomains] = useState("");
  const [leads, setLeads] = useState<SourceLead[]>([]);
  const [retrieveQuery, setRetrieveQuery] = useState("");
  const [hits, setHits] = useState<RetrievalHit[]>([]);
  const [bulkUrls, setBulkUrls] = useState("");
  const [uploadName, setUploadName] = useState("");

  // Pre-populate packetId and articleId from URL params so editors landing from the
  // hold banner go straight to the packet's snapshotted sources with article context.
  const initialPacketId = new URLSearchParams(urlSearch).get("packetId") ?? undefined;
  const initialArticleId = new URLSearchParams(urlSearch).get("articleId") ?? undefined;

  const { data: heldArticle } = useGetArticle(initialArticleId ?? "", {
    query: {
      queryKey: getGetArticleQueryKey(initialArticleId ?? ""),
      enabled: Boolean(initialArticleId && initialPacketId),
    },
  });

  // Server-side list controls for the "source intelligence" console.
  const [filters, setFilters] = useState<ListSourceDocumentsParams>(() => ({
    sort: "recent",
    ...(initialPacketId ? { packetId: initialPacketId } : {}),
  }));
  const [qInput, setQInput] = useState("");

  const { data: status } = useGetSourceVaultStatus({
    query: { queryKey: getGetSourceVaultStatusQueryKey(), refetchInterval: 15000 },
  });
  const { data: docsData, isLoading: docsLoading } = useListSourceDocuments(filters, {
    query: { queryKey: getListSourceDocumentsQueryKey(filters) },
  });
  const { data: queueData } = useGetSourceQueue({
    query: { queryKey: getGetSourceQueueQueryKey(), refetchInterval: 15000 },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListSourceDocumentsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetSourceVaultStatusQueryKey() });
    qc.invalidateQueries({ queryKey: getGetSourceQueueQueryKey() });
  };

  const configured = status?.perplexityConfigured ?? false; // gates discovery (Perplexity search)
  const embedConfigured = status?.embeddingConfigured ?? false; // gates embed + retrieval
  const enabled = status?.enabled ?? true;

  const ingest = useIngestSourceUrl({
    mutation: {
      onSuccess: (res) => {
        toast[res.embedded ? "success" : "info"](res.note);
        setIngestUrl("");
        setIngestTier("");
        invalidate();
      },
      onError: (err) => toast.error(errText(err, "Ingest failed.")),
    },
  });

  const reclassify = useReclassifySourceDomains({
    mutation: {
      onSuccess: (res) => {
        toast.success(`Reclassified: ${res.updated} updated, ${res.unchanged} already correct.`);
        invalidate();
      },
      onError: (err) => toast.error(errText(err, "Reclassify failed.")),
    },
  });

  const upload = useUploadSourceDocument({
    mutation: {
      onSuccess: (res) => {
        toast[res.embedded ? "success" : "info"](res.note);
        setUploadName("");
        invalidate();
      },
      onError: (err) => toast.error(errText(err, "Upload failed.")),
    },
  });

  const categoriesQuery = useListCategories();
  const beatOptions = categoriesQuery.data?.items ?? [];

  const onSelectFile = (file: File | undefined) => {
    if (!file) return;
    setUploadName(file.name);
    const reader = new FileReader();
    reader.onerror = () => toast.error("Could not read the selected file.");
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        toast.error("Could not read the selected file.");
        return;
      }
      const comma = result.indexOf(",");
      const contentBase64 = comma >= 0 ? result.slice(comma + 1) : result;
      if (!contentBase64) {
        toast.error("The selected file is empty.");
        return;
      }
      upload.mutate({
        data: {
          filename: file.name,
          contentBase64,
          contentType: file.type || undefined,
          approveLowQuality,
          beatSlug: uploadBeatSlug || undefined,
        },
      });
    };
    reader.readAsDataURL(file);
  };

  const search = useSearchSourceLeads({
    mutation: {
      onSuccess: (res) => {
        setLeads(res.leads);
        toast.success(`Found ${res.leads.length} lead${res.leads.length === 1 ? "" : "s"}.`);
      },
      onError: (err) => toast.error(errText(err, "Search failed.")),
    },
  });

  const retrieve = useRetrieveSourceChunks({
    mutation: {
      onSuccess: (res) => {
        setHits(res.hits);
        toast.success(`${res.hits.length} matching chunk${res.hits.length === 1 ? "" : "s"}.`);
      },
      onError: (err) => toast.error(errText(err, "Retrieval failed.")),
    },
  });

  const approve = useApproveSourceDocument({
    mutation: {
      onSuccess: (res) => {
        toast.success(res.note);
        invalidate();
      },
      onError: (err) => toast.error(errText(err, "Approve failed.")),
    },
  });

  const del = useDeleteSourceDocument({
    mutation: {
      onSuccess: () => {
        toast.success("Document deleted.");
        invalidate();
      },
      onError: (err) => toast.error(errText(err, "Delete failed.")),
    },
  });

  const enqueue = useEnqueueSourceUrls({
    mutation: {
      onSuccess: (res) => {
        toast.success(`Queued ${res.enqueued} of ${res.total} URL${res.total === 1 ? "" : "s"}.`);
        invalidate();
      },
      onError: (err) => toast.error(errText(err, "Enqueue failed.")),
    },
  });

  // Queue discovered leads through the same bounded, budget-guarded ingest queue
  // as bulk paste — never ingest inline — tagged so the queue shows them as
  // "Discovered". Removes the queued leads from the on-screen list.
  const queueLeads = (chosen: SourceLead[]) => {
    if (chosen.length === 0) return;
    enqueue.mutate(
      {
        data: {
          urls: chosen.map((l) => l.url),
          leadSnippets: chosen.map((l) => l.snippet),
          discoveredVia: "perplexity_search",
          approveLowQuality,
        },
      },
      {
        onSuccess: () => {
          const queued = new Set(chosen.map((l) => l.url));
          setLeads((prev) => prev.filter((l) => !queued.has(l.url)));
        },
      },
    );
  };

  const setAuthority = useSetSourceDocumentAuthority({
    mutation: {
      onSuccess: () => {
        toast.success("Authority updated.");
        invalidate();
      },
      onError: (err) => toast.error(errText(err, "Authority update failed.")),
    },
  });

  const parseUrlLines = (raw: string): string[] =>
    raw
      .split(/[\n,]/)
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

  const docs = docsData?.items ?? [];
  const total = docsData?.total ?? 0;
  const pageSize = 100;
  const offset = filters.offset ?? 0;
  const hasActiveFilters = Boolean(
    filters.authorityTier ||
      filters.status ||
      filters.lifecycleStatus ||
      filters.beat ||
      (filters.duplicates && filters.duplicates !== "all") ||
      filters.usefulness ||
      filters.q ||
      filters.packetId ||
      (filters.sort && filters.sort !== "recent"),
  );
  const queue = queueData?.items ?? [];
  const queueStats = queueData?.stats;

  // Avoid an empty-page trap: if a filter/delete shrinks the result set below the
  // current offset, step back onto a page that still has rows.
  useEffect(() => {
    if (!docsLoading && docs.length === 0 && total > 0 && offset > 0) {
      setFilters((f) => ({ ...f, offset: Math.max((f.offset ?? 0) - pageSize, 0) }));
    }
  }, [docsLoading, docs.length, total, offset]);

  return (
    <div className="p-4 md:p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="font-serif text-3xl font-bold mb-1 flex items-center gap-2">
          <Library className="h-7 w-7 text-primary" /> Source Vault
        </h1>
        <p className="text-muted-foreground">
          Newsroom memory (spike): discover sources, fetch &amp; extract them safely, embed the text, and
          retrieve it by meaning.
        </p>
      </div>

      <ClaimOperationsCard />

      {/* Status / provider banner */}
      <Card className="p-4 mb-6">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="flex items-center gap-1.5">
            {configured ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            )}
            Perplexity {configured ? "configured" : "not configured"}
          </span>
          <span className="flex items-center gap-1.5">
            {status?.embeddingConfigured ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-amber-500" />
            )}
            Embeddings: <b className="text-foreground">{status?.embeddingProvider ?? "—"}</b>
          </span>
          <span className="text-muted-foreground">Vault {enabled ? "enabled" : "disabled"}</span>
          <span className="text-muted-foreground">
            Documents: <b className="text-foreground">{status?.documentCount ?? 0}</b>
          </span>
          <span className="text-muted-foreground">
            Embedded: <b className="text-foreground">{status?.embeddedCount ?? 0}</b>
          </span>
          <span className="text-muted-foreground">
            Chunks: <b className="text-foreground">{status?.chunkCount ?? 0}</b>
          </span>
          <span className="text-muted-foreground ml-auto">
            Spend today: <b className="text-foreground">${(status?.todaySpendUsd ?? 0).toFixed(2)}</b> / $
            {status?.dailyBudgetUsd ?? 0}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => reclassify.mutate()}
            disabled={reclassify.isPending}
            title="Re-run the domain classifier on all auto-classified documents. Manually pinned tiers are never changed."
          >
            {reclassify.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <ShieldCheck className="h-4 w-4 mr-1" />
            )}
            Reclassify all auto-classified
          </Button>
          <span className="text-xs text-muted-foreground">
            Re-runs domain rules on auto-classified documents. Manually pinned tiers are never changed.
          </span>
        </div>
        {!configured && (
          <p className="mt-3 text-xs text-amber-700">
            Set <code>PERPLEXITY_API_KEY</code> to enable lead discovery (search). Fetch, extract, embedding
            and retrieval work independently via the <code>{status?.embeddingProvider ?? "—"}</code> embedding
            provider — you can still ingest a known URL directly and search the vault.
          </p>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Ingest a URL */}
        <Card className="p-4">
          <h2 className="font-serif font-bold mb-1 flex items-center gap-2">
            <Plus className="h-4 w-4" /> Ingest a URL
          </h2>
          <p className="text-sm text-muted-foreground mb-3">
            Fetches the page (SSRF-safe), extracts the article body, scores its quality, and — if the key is
            set and the quality bar is met — chunks &amp; embeds it.
          </p>
          <div className="flex gap-2">
            <input
              type="url"
              placeholder="https://example.com/article"
              className="flex-1 border rounded-md px-3 py-1.5 text-sm bg-background"
              value={ingestUrl}
              onChange={(e) => setIngestUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && ingestUrl.trim()) {
                  ingest.mutate({
                    data: {
                      url: ingestUrl.trim(),
                      approveLowQuality,
                      authorityTier: ingestTier || undefined,
                    },
                  });
                }
              }}
            />
            <Button
              onClick={() =>
                ingest.mutate({
                  data: {
                    url: ingestUrl.trim(),
                    approveLowQuality,
                    authorityTier: ingestTier || undefined,
                  },
                })
              }
              disabled={ingest.isPending || !ingestUrl.trim()}
            >
              {ingest.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Ingest"}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-4 mt-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={approveLowQuality}
                onChange={(e) => setApproveLowQuality(e.target.checked)}
              />
              Embed even if it scores below the quality bar
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              <select
                className="border rounded px-1.5 py-1 text-xs bg-background"
                value={ingestTier}
                onChange={(e) => setIngestTier(e.target.value)}
                title="Pin authority tier at submission (auto-detects if left blank)"
              >
                <option value="">Auto-detect tier</option>
                {AUTHORITY_TIERS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </Card>

        {/* Upload a document */}
        <Card className="p-4">
          <h2 className="font-serif font-bold mb-1 flex items-center gap-2">
            <Upload className="h-4 w-4" /> Upload a document
          </h2>
          <p className="text-sm text-muted-foreground mb-3">
            Extracts text from a PDF, Word (.docx), PowerPoint (.pptx), OpenDocument, spreadsheet, or plain-text
            (.txt) file, scores
            its quality, and — if the key is set and the quality bar is met — chunks &amp; embeds it. Failed or
            unreadable files are recorded so you can see why, never silently stored.
          </p>
          <div className="flex items-center gap-2">
            <label className="inline-flex">
              <input
                type="file"
                className="hidden"
                accept=".pdf,.docx,.pptx,.xlsx,.odt,.odp,.ods,.txt,.text,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain"
                disabled={upload.isPending}
                onChange={(e) => {
                  onSelectFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              <Button asChild disabled={upload.isPending}>
                <span className="cursor-pointer">
                  {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Choose file"}
                </span>
              </Button>
            </label>
            <span className="text-xs text-muted-foreground truncate">
              {upload.isPending ? `Extracting ${uploadName}…` : uploadName || "No file selected"}
            </span>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground mt-2">
            Beat
            <select
              className="border rounded px-1 py-0.5 text-xs bg-background disabled:opacity-60"
              value={uploadBeatSlug}
              disabled={upload.isPending}
              onChange={(e) => setUploadBeatSlug(e.target.value)}
              title="Optionally tag the uploaded document with a beat/category"
            >
              <option value="">No beat</option>
              {beatOptions.map((b) => (
                <option key={b.categorySlug} value={b.categorySlug}>
                  {b.category}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground mt-2 cursor-pointer">
            <input
              type="checkbox"
              checked={approveLowQuality}
              onChange={(e) => setApproveLowQuality(e.target.checked)}
            />
            Embed even if it scores below the quality bar
          </label>
        </Card>

        {/* Discover leads */}
        <Card className="p-4">
          <h2 className="font-serif font-bold mb-1 flex items-center gap-2">
            <Search className="h-4 w-4" /> Discover leads
          </h2>
          <p className="text-sm text-muted-foreground mb-3">
            Uses Perplexity search to surface fresh candidate sources. Queue any (or all) into the same
            bounded ingest queue below — they drain within the budget, never all at once.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="e.g. James Webb telescope discoveries 2026"
              className="flex-1 border rounded-md px-3 py-1.5 text-sm bg-background disabled:opacity-60"
              value={searchQuery}
              disabled={!configured}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && searchQuery.trim()) {
                  search.mutate({ data: { query: searchQuery.trim(), maxResults: 10, domains: parseDomains(searchDomains) } });
                }
              }}
            />
            <Button
              onClick={() => search.mutate({ data: { query: searchQuery.trim(), maxResults: 10, domains: parseDomains(searchDomains) } })}
              disabled={!configured || search.isPending || !searchQuery.trim()}
            >
              {search.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
            </Button>
          </div>
          <input
            type="text"
            placeholder="Optional: limit to domains, comma-separated (e.g. reuters.com, nasa.gov)"
            className="mt-2 w-full border rounded-md px-3 py-1.5 text-xs bg-background disabled:opacity-60"
            value={searchDomains}
            disabled={!configured}
            onChange={(e) => setSearchDomains(e.target.value)}
          />
          {leads.length > 0 && (
            <>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {leads.length} lead{leads.length === 1 ? "" : "s"}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={enqueue.isPending}
                  onClick={() => queueLeads(leads)}
                >
                  <ListPlus className="h-3.5 w-3.5 mr-1" /> Queue all
                </Button>
              </div>
              <ul className="mt-2 space-y-2 sm:max-h-64 sm:overflow-y-auto">
                {leads.map((lead) => (
                  <li key={lead.url} className="text-sm border rounded-md p-2">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium leading-snug truncate">{lead.title}</p>
                        <p className="text-xs text-muted-foreground truncate">{lead.domain}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        disabled={enqueue.isPending}
                        onClick={() => queueLeads([lead])}
                      >
                        Queue
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      </div>

      {/* Bounded batch ingestion queue */}
      <Card className="p-4 mt-6">
        <h2 className="font-serif font-bold mb-1 flex items-center gap-2">
          <ListPlus className="h-4 w-4" /> Ingest queue
        </h2>
        <p className="text-sm text-muted-foreground mb-3">
          Paste many URLs (one per line, or comma-separated) to queue them. The scheduler drains a small
          batch each tick within the daily/run budget — anything not reached stays pending for the next
          tick, so a big backlog trickles in safely.
        </p>
        <textarea
          placeholder={"https://example.com/a\nhttps://example.com/b"}
          className="w-full h-24 border rounded-md px-3 py-2 text-sm bg-background disabled:opacity-60 font-mono"
          value={bulkUrls}
          disabled={!enabled}
          onChange={(e) => setBulkUrls(e.target.value)}
        />
        <div className="flex items-center gap-3 mt-2">
          <Button
            onClick={() => {
              const urls = parseUrlLines(bulkUrls);
              enqueue.mutate(
                { data: { urls, approveLowQuality } },
                { onSuccess: () => setBulkUrls("") },
              );
            }}
            disabled={!enabled || enqueue.isPending || parseUrlLines(bulkUrls).length === 0}
          >
            {enqueue.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              `Queue ${parseUrlLines(bulkUrls).length || ""} URL${parseUrlLines(bulkUrls).length === 1 ? "" : "s"}`
            )}
          </Button>
          {queueStats && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground ml-auto">
              <span>Pending <b className="text-foreground">{queueStats.pending}</b></span>
              <span>Processing <b className="text-foreground">{queueStats.processing}</b></span>
              <span>Done <b className="text-foreground">{queueStats.done}</b></span>
              <span>Failed <b className="text-foreground">{queueStats.failed}</b></span>
            </div>
          )}
        </div>
        {queue.length > 0 && (
          <ul className="mt-3 space-y-1 sm:max-h-56 sm:overflow-y-auto">
            {queue.map((item) => (
              <li key={item.id} className="text-xs border rounded-md p-2 flex items-center gap-2">
                <span
                  className={`px-1.5 py-0.5 rounded-full capitalize shrink-0 ${
                    QUEUE_STATUS_CLASS[item.status] ?? "bg-muted text-muted-foreground"
                  }`}
                >
                  {item.status}
                </span>
                {item.discoveredVia && SOURCE_META[item.discoveredVia] && (
                  <span
                    className={`px-1.5 py-0.5 rounded-full shrink-0 ${SOURCE_META[item.discoveredVia]!.className}`}
                    title={`Source: ${item.discoveredVia}`}
                  >
                    {SOURCE_META[item.discoveredVia]!.label}
                  </span>
                )}
                <span className="truncate flex-1">{item.url}</span>
                {item.attempts > 0 && (
                  <span className="text-muted-foreground shrink-0">{item.attempts} tries</span>
                )}
                {item.lastError && (
                  <span className="text-rose-600 truncate max-w-[40%]" title={item.lastError}>
                    {item.lastError}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Semantic retrieval */}
      <Card className="p-4 mt-6">
        <h2 className="font-serif font-bold mb-1 flex items-center gap-2">
          <Sparkles className="h-4 w-4" /> Semantic retrieval
        </h2>
        <p className="text-sm text-muted-foreground mb-3">
          Embeds your query and ranks stored chunks by cosine similarity. This is the “memory recall” the
          drafting pipeline will build on.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Ask the vault something…"
            className="flex-1 border rounded-md px-3 py-1.5 text-sm bg-background disabled:opacity-60"
            value={retrieveQuery}
            disabled={!embedConfigured}
            onChange={(e) => setRetrieveQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && retrieveQuery.trim()) {
                retrieve.mutate({ data: { query: retrieveQuery.trim(), limit: 8 } });
              }
            }}
          />
          <Button
            onClick={() => retrieve.mutate({ data: { query: retrieveQuery.trim(), limit: 8 } })}
            disabled={!embedConfigured || retrieve.isPending || !retrieveQuery.trim()}
          >
            {retrieve.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Retrieve"}
          </Button>
        </div>
        {hits.length > 0 && (
          <ul className="mt-3 space-y-2">
            {hits.map((hit) => (
              <li key={hit.chunkId} className="text-sm border rounded-md p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-muted">
                    {(hit.similarity * 100).toFixed(1)}%
                  </span>
                  <span className="text-xs text-muted-foreground truncate">
                    {hit.document.title ?? hit.document.domain} · chunk #{hit.chunkIndex}
                  </span>
                  <a
                    href={hit.document.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto text-primary shrink-0"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
                <p className="text-muted-foreground line-clamp-3">{hit.content}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Stored documents — source intelligence console */}
      <div className="mt-8">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <h2 className="font-serif font-bold text-xl">
            Stored documents{" "}
            <span className="text-muted-foreground font-sans font-normal text-base">
              ({total.toLocaleString()})
            </span>
          </h2>
          {hasActiveFilters && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setFilters({ sort: "recent" });
                setQInput("");
              }}
            >
              <X className="h-3.5 w-3.5 mr-1" /> Clear filters
            </Button>
          )}
          </div>

        {filters.packetId && (
          <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-center gap-2">
            <Lock className="h-3.5 w-3.5 shrink-0" />
            <span>
              {heldArticle ? (
                <>
                  Showing sources from the evidence packet for{" "}
                  <Link
                    href={`/admin/articles/${heldArticle.id}`}
                    className="font-semibold underline underline-offset-2 text-amber-800 hover:text-amber-950"
                  >
                    "{heldArticle.title}"
                  </Link>
                  . These are the sources captured when the article was grounded.
                </>
              ) : (
                <>
                  Showing only sources from evidence packet{" "}
                  <span className="font-mono">{filters.packetId.slice(0, 8)}…</span>.
                  Landing from a held-article banner? These are the sources the article's grounding packet captured.
                </>
              )}
            </span>
            <button
              className="ml-auto shrink-0 text-amber-700 hover:text-amber-900"
              onClick={() => setFilters((f) => { const { packetId: _, ...rest } = f; return rest; })}
              title="Remove packet filter"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Filter + sort toolbar (all server-side) */}
        <Card className="p-3 mb-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex items-center gap-1.5 flex-1 min-w-[200px]">
              <Search className="h-4 w-4 text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder="Search url, title or domain…"
                className="w-full border rounded-md px-3 py-1.5 text-sm bg-background"
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter")
                    setFilters((f) => ({ ...f, q: qInput.trim() || undefined, offset: 0 }));
                }}
              />
            </div>
            <FilterSelect
              label="Sort"
              value={filters.sort ?? "recent"}
              onChange={(v) => setFilters((f) => ({ ...f, sort: v as ListSourceDocumentsParams["sort"], offset: 0 }))}
              options={[
                ["recent", "Newest discovered"],
                ["updated", "Newest updated"],
                ["oldest_unreviewed", "Oldest unreviewed"],
                ["authority", "Authority (primary first)"],
                ["oldest", "Oldest"],
                ["quality", "Quality"],
                ["words", "Word count"],
                ["most_used", "Most used"],
              ]}
            />
            <FilterSelect
              label="Authority"
              value={filters.authorityTier ?? ""}
              onChange={(v) =>
                setFilters((f) => ({
                  ...f,
                  authorityTier: (v || undefined) as ListSourceDocumentsParams["authorityTier"],
                  offset: 0,
                }))
              }
              options={[["", "Any"], ...AUTHORITY_TIERS.map((t) => [t, t] as [string, string])]}
            />
            <FilterSelect
              label="Status"
              value={filters.status ?? ""}
              onChange={(v) =>
                setFilters((f) => ({
                  ...f,
                  status: (v || undefined) as ListSourceDocumentsParams["status"],
                  offset: 0,
                }))
              }
              options={[
                ["", "Any"],
                ["embedded", "Embedded"],
                ["extracted", "Extracted"],
                ["low_quality", "Held (low quality)"],
                ["fetched", "Fetched"],
                ["failed", "Failed"],
              ]}
            />
            <FilterSelect
              label="Lifecycle"
              value={filters.lifecycleStatus ?? ""}
              onChange={(v) =>
                setFilters((f) => ({
                  ...f,
                  lifecycleStatus: (v || undefined) as ListSourceDocumentsParams["lifecycleStatus"],
                  offset: 0,
                }))
              }
              options={[
                ["", "Any"],
                ["active", "Active"],
                ["stale", "Stale"],
                ["superseded", "Superseded"],
                ["retracted", "Retracted"],
                ["unavailable", "Unavailable"],
              ]}
            />
            <FilterSelect
              label="Beat"
              value={filters.beat ?? ""}
              onChange={(v) => setFilters((f) => ({ ...f, beat: v || undefined, offset: 0 }))}
              options={[
                ["", "Any"],
                ...beatOptions.map((b) => [b.categorySlug, b.category] as [string, string]),
              ]}
            />
            <FilterSelect
              label="Duplicates"
              value={filters.duplicates ?? "all"}
              onChange={(v) =>
                setFilters((f) => ({
                  ...f,
                  duplicates: v as ListSourceDocumentsParams["duplicates"],
                  offset: 0,
                }))
              }
              options={[
                ["all", "All"],
                ["exclude", "Hide duplicates"],
                ["only", "Only duplicates"],
              ]}
            />
            <FilterSelect
              label="Usefulness"
              value={filters.usefulness ?? ""}
              onChange={(v) =>
                setFilters((f) => ({
                  ...f,
                  usefulness: (v || undefined) as ListSourceDocumentsParams["usefulness"],
                  offset: 0,
                }))
              }
              options={[
                ["", "Any"],
                ["published", "In a published article"],
                ["evidence", "Used as evidence"],
                ["draft", "In a draft/scheduled article"],
                ["orphaned", "Orphaned (unused)"],
              ]}
            />
          </div>
        </Card>

        {docsLoading ? (
          <Loader2 className="animate-spin" />
        ) : docs.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {hasActiveFilters ? "No documents match these filters." : "Nothing ingested yet. Add a URL above."}
          </p>
        ) : (
          <>
            <div className="space-y-2">
              {docs.map((doc) => (
                <DocumentRow
                  key={doc.id}
                  doc={doc}
                  onApprove={() => approve.mutate({ id: doc.id })}
                  onDelete={() => del.mutate({ id: doc.id })}
                  onSetAuthority={(tier) => setAuthority.mutate({ id: doc.id, data: { tier } })}
                  approving={approve.isPending}
                  deleting={del.isPending}
                  settingAuthority={setAuthority.isPending}
                  canEmbed={embedConfigured}
                />
              ))}
            </div>
            {(offset > 0 || offset + docs.length < total) && (
              <div className="flex items-center justify-between mt-3 text-sm">
                <span className="text-muted-foreground">
                  Showing {offset + 1}–{offset + docs.length} of {total.toLocaleString()}
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={offset === 0}
                    onClick={() => setFilters((f) => ({ ...f, offset: Math.max(offset - pageSize, 0) }))}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={offset + docs.length >= total}
                    onClick={() => setFilters((f) => ({ ...f, offset: offset + pageSize }))}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      {label}
      <select
        className="border rounded-md px-2 py-1.5 text-sm bg-background text-foreground"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function DocumentRow({
  doc,
  onApprove,
  onDelete,
  onSetAuthority,
  approving,
  deleting,
  settingAuthority,
  canEmbed,
}: {
  doc: SourceDocumentListItem;
  onApprove: () => void;
  onDelete: () => void;
  onSetAuthority: (tier: SourceDocument["authorityTier"] | null) => void;
  approving: boolean;
  deleting: boolean;
  settingAuthority: boolean;
  canEmbed: boolean;
}) {
  const isDuplicate = Boolean(doc.duplicateOfId);
  return (
    <Card className={`p-3 ${isDuplicate ? "opacity-70" : ""}`}>
      <div className="flex items-start gap-3">
        <Link href={`/admin/source-vault/${doc.id}`} className="min-w-0 flex-1 text-left group">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <StatusBadge status={doc.status} />
            <LifecycleBadge status={doc.lifecycleStatus} />
            {doc.authorityTier && (
              <span
                className={`text-xs px-2 py-0.5 rounded-full capitalize inline-flex items-center gap-1 ${
                  AUTHORITY_CLASS[doc.authorityTier] ?? "bg-muted text-muted-foreground"
                }`}
                title={doc.authorityReason ?? undefined}
              >
                {doc.authoritySource === "manual" && <Lock className="h-2.5 w-2.5" />}
                {doc.authorityTier}
              </span>
            )}
            {isDuplicate && (
              <span
                className="text-xs px-2 py-0.5 rounded-full bg-zinc-200 text-zinc-700 inline-flex items-center gap-1"
                title={doc.dedupeReason ?? "duplicate"}
              >
                <Copy className="h-2.5 w-2.5" /> Duplicate
              </span>
            )}
            {doc.paywallDetected && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Paywall</span>
            )}
            {doc.usageCount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary inline-flex items-center gap-1">
                <FileText className="h-2.5 w-2.5" /> {doc.usageCount} article{doc.usageCount === 1 ? "" : "s"}
              </span>
            )}
            <span className="text-xs text-muted-foreground">{doc.domain}</span>
            <span className="text-xs text-muted-foreground">Q {doc.qualityScore}</span>
            <span className="text-xs text-muted-foreground">{doc.wordCount} words</span>
            {doc.chunkCount > 0 && (
              <span className="text-xs text-muted-foreground">{doc.chunkCount} chunks</span>
            )}
            <span className="text-xs text-muted-foreground ml-auto">
              {format(new Date(doc.createdAt), "MMM d, HH:mm")}
            </span>
          </div>
          <p className="font-medium leading-snug truncate group-hover:text-primary group-hover:underline">
            {doc.title ?? doc.url}
          </p>
          {(doc.qualityFlags ?? []).length > 0 && (
            <p className="text-xs text-amber-700 mt-0.5">{(doc.qualityFlags ?? []).join(", ")}</p>
          )}
          {doc.policyNotes && <p className="text-xs text-muted-foreground mt-0.5">{doc.policyNotes}</p>}
          {doc.error && <p className="text-xs text-rose-700 mt-0.5">{doc.error}</p>}
        </Link>
        <div className="flex flex-col gap-1 shrink-0">
          {doc.status === "low_quality" && (
            <Button size="sm" variant="outline" onClick={onApprove} disabled={approving || !canEmbed}>
              {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Approve & embed"}
            </Button>
          )}
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            <select
              className="border rounded px-1 py-0.5 text-xs bg-background disabled:opacity-60"
              value={doc.authoritySource === "manual" ? (doc.authorityTier ?? "__auto__") : "__auto__"}
              disabled={settingAuthority}
              onChange={(e) =>
                onSetAuthority(
                  e.target.value === "__auto__"
                    ? null
                    : (e.target.value as SourceDocument["authorityTier"]),
                )
              }
              title="Pin authority tier (persists across re-ingest), or Auto to reclassify"
            >
              <option value="__auto__">Auto (unpin)</option>
              {AUTHORITY_TIERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" variant="ghost" onClick={onDelete} disabled={deleting}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
