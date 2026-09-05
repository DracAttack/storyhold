import {
  useGetSourceDocument,
  useDeleteSourceDocument,
  useApproveSourceDocument,
  useSetSourceDocumentAuthority,
  useSetSourceDocumentLifecycle,
  usePromoteSourceDocumentCanonical,
  useMakeSourceDocumentRepresentative,
  useCreateCustomIdea,
  getGetSourceDocumentQueryKey,
  getListSourceDocumentsQueryKey,
  getGetSourceVaultStatusQueryKey,
  type SourceDocument,
  type SourceRef,
  type SourceArticleUsage,
  type RelatedSource,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  ExternalLink,
  Loader2,
  Trash2,
  ShieldCheck,
  Lock,
  Copy,
  FileText,
  Lightbulb,
  Ban,
  Link2,
  Crown,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { useState, type ReactNode } from "react";
import { format } from "date-fns";
import {
  StatusBadge,
  LifecycleBadge,
  AUTHORITY_CLASS,
  AUTHORITY_TIERS,
  errText,
} from "./SourceVault";

// --- Source Vault: per-document intelligence page (Task #230) -------------
// A dedicated route for one stored source: its metadata + authority controls,
// full extracted text, embedded chunks, the duplicate family it belongs to, the
// articles that cite it, nearest neighbours by stored-vector similarity, and the
// editorial actions (use in a new article, promote authority, reject as junk).

const ARTICLE_STATUS_CLASS: Record<string, string> = {
  published: "bg-emerald-100 text-emerald-700",
  scheduled: "bg-sky-100 text-sky-700",
  draft: "bg-muted text-muted-foreground",
};

const ROLE_CLASS: Record<string, string> = {
  evidence: "bg-emerald-100 text-emerald-700",
  trend_marker: "bg-amber-100 text-amber-700",
  rejected_junk: "bg-rose-100 text-rose-700",
};

// Human labels for how a document entered the vault (discoveredVia).
const SOURCE_TYPE_LABEL: Record<string, string> = {
  manual_url: "Manual URL",
  manual_upload: "Uploaded file",
  perplexity_search: "Discovered (search)",
  trend_signal: "Trend signal",
  known_source: "Known source",
  back_catalog: "Back-catalog harvest",
};

export default function SourceVaultDetail() {
  const qc = useQueryClient();
  const params = useParams();
  const [, navigate] = useLocation();
  const id = params.id ?? "";

  const { data, isLoading, isError } = useGetSourceDocument(id, {
    query: { queryKey: getGetSourceDocumentQueryKey(id), enabled: Boolean(id) },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetSourceDocumentQueryKey(id) });
    // Prefix match invalidates every filtered/paginated list variant + status.
    qc.invalidateQueries({ queryKey: getListSourceDocumentsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetSourceVaultStatusQueryKey() });
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

  const approve = useApproveSourceDocument({
    mutation: {
      onSuccess: (res) => {
        toast.success(res.note);
        invalidate();
      },
      onError: (err) => toast.error(errText(err, "Approve failed.")),
    },
  });

  const lifecycle = useSetSourceDocumentLifecycle({
    mutation: {
      onSuccess: () => {
        toast.success("Lifecycle updated.");
        invalidate();
      },
      onError: (err) => toast.error(errText(err, "Lifecycle update failed.")),
    },
  });

  const del = useDeleteSourceDocument({
    mutation: {
      onSuccess: () => {
        toast.success("Document deleted.");
        qc.invalidateQueries({ queryKey: getListSourceDocumentsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetSourceVaultStatusQueryKey() });
        navigate("/admin/source-vault");
      },
      onError: (err) => toast.error(errText(err, "Delete failed.")),
    },
  });

  const promoteCanonical = usePromoteSourceDocumentCanonical({
    mutation: {
      onSuccess: () => {
        toast.success("Canonical settings updated.");
        invalidate();
      },
      onError: (err) => toast.error(errText(err, "Could not promote as canonical.")),
    },
  });

  const makeRep = useMakeSourceDocumentRepresentative({
    mutation: {
      onSuccess: (res) => {
        toast.success(res.note);
        invalidate();
      },
      onError: (err) => toast.error(errText(err, "Could not make this the representative.")),
    },
  });

  const createIdea = useCreateCustomIdea({
    mutation: {
      onSuccess: () => toast.success("Draft idea created from this source. Find it in Ideas."),
      onError: (err) => toast.error(errText(err, "Could not create idea.")),
    },
  });

  if (!id) return null;
  if (isLoading) {
    return (
      <div className="p-8">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="p-4 md:p-8 max-w-4xl">
        <BackLink />
        <p className="text-muted-foreground text-sm mt-4">This document could not be found.</p>
      </div>
    );
  }

  const doc = data.document;
  const isRetracted = doc.lifecycleStatus === "retracted";

  const useInNewArticle = () => {
    createIdea.mutate({
      data: {
        title: doc.title ?? doc.domain,
        angle: `Write an article grounded in this source: ${doc.url}`,
        status: "approved",
      },
    });
  };

  return (
    <div className="p-4 md:p-8 max-w-4xl">
      <BackLink />

      <div className="mt-3 mb-5">
        <div className="flex items-center gap-2 flex-wrap mb-2">
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
          {doc.paywallDetected && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Paywall</span>
          )}
          {doc.duplicateOfId && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-200 text-zinc-700 inline-flex items-center gap-1">
              <Copy className="h-2.5 w-2.5" /> Duplicate
            </span>
          )}
        </div>
        <h1 className="font-serif text-2xl md:text-3xl font-bold leading-tight mb-1">
          {doc.title ?? doc.url}
        </h1>
        <a
          href={doc.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-primary inline-flex items-center gap-1 break-all"
        >
          <ExternalLink className="h-3.5 w-3.5 shrink-0" /> {doc.url}
        </a>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
          <span>{doc.domain}</span>
          <span>Quality {doc.qualityScore}</span>
          <span>{doc.wordCount} words</span>
          <span>{doc.chunkCount} chunks</span>
          <span>Added {format(new Date(doc.createdAt), "MMM d, yyyy HH:mm")}</span>
        </div>
        {(doc.qualityFlags ?? []).length > 0 && (
          <p className="text-xs text-amber-700 mt-1">{(doc.qualityFlags ?? []).join(", ")}</p>
        )}
        {doc.policyNotes && <p className="text-xs text-muted-foreground mt-1">{doc.policyNotes}</p>}
        {doc.error && <p className="text-xs text-rose-700 mt-1">{doc.error}</p>}
      </div>

      {/* Editorial actions */}
      <Card className="p-4 mb-6">
        <h2 className="font-serif font-bold mb-3">Actions</h2>
        <div className="flex flex-wrap gap-2 items-center">
          <Button size="sm" onClick={useInNewArticle} disabled={createIdea.isPending}>
            {createIdea.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <Lightbulb className="h-4 w-4 mr-1" />
            )}
            Use in new article
          </Button>

          {doc.status === "low_quality" && (
            <Button size="sm" variant="outline" onClick={() => approve.mutate({ id })} disabled={approve.isPending}>
              {approve.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Approve &amp; embed
            </Button>
          )}

          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setAuthority.mutate({ id, data: { tier: "primary", reason: "Promoted from source detail" } })
            }
            disabled={setAuthority.isPending}
          >
            <ShieldCheck className="h-4 w-4 mr-1" /> Promote to primary
          </Button>

          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            <select
              className="border rounded px-1.5 py-1 text-xs bg-background disabled:opacity-60"
              value={doc.authoritySource === "manual" ? (doc.authorityTier ?? "__auto__") : "__auto__"}
              disabled={setAuthority.isPending}
              onChange={(e) =>
                setAuthority.mutate({
                  id,
                  data: {
                    tier:
                      e.target.value === "__auto__"
                        ? null
                        : (e.target.value as SourceDocument["authorityTier"]),
                  },
                })
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

          {isRetracted ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => lifecycle.mutate({ id, data: { lifecycleStatus: "active", doNotRefetch: false } })}
              disabled={lifecycle.isPending}
            >
              Restore
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="text-rose-700"
              onClick={() =>
                lifecycle.mutate({
                  id,
                  data: { lifecycleStatus: "retracted", doNotRefetch: true, note: "Rejected as junk" },
                })
              }
              disabled={lifecycle.isPending}
            >
              <Ban className="h-4 w-4 mr-1" /> Reject as junk
            </Button>
          )}

          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground"
            onClick={() => {
              if (confirm("Delete this document permanently? This cannot be undone.")) del.mutate({ id });
            }}
            disabled={del.isPending}
          >
            <Trash2 className="h-4 w-4 mr-1" /> Delete
          </Button>
        </div>
      </Card>

      {/* Source details + classification provenance */}
      <Card className="p-4 mb-6">
        <h2 className="font-serif font-bold mb-3">Source details</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <DetailField label="Source type">
            <span className="inline-flex items-center gap-1.5">
              <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                {SOURCE_TYPE_LABEL[doc.discoveredVia ?? ""] ?? doc.discoveredVia ?? "Unknown"}
              </span>
            </span>
          </DetailField>
          <DetailField label="Domain">{doc.domain}</DetailField>
          <DetailField label="Original URL">
            <a
              href={doc.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary inline-flex items-center gap-1 break-all"
            >
              <ExternalLink className="h-3.5 w-3.5 shrink-0" /> {doc.url}
            </a>
          </DetailField>
          <DetailField label="Canonical URL">
            {doc.canonicalUrl ? (
              <a
                href={doc.canonicalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary inline-flex items-center gap-1 break-all"
              >
                <Link2 className="h-3.5 w-3.5 shrink-0" /> {doc.canonicalUrl}
              </a>
            ) : (
              <span className="text-muted-foreground">Not set — same as original URL</span>
            )}
          </DetailField>
          {doc.author && <DetailField label="Author">{doc.author}</DetailField>}
          {doc.publishedAt && (
            <DetailField label="Published">
              {format(new Date(doc.publishedAt), "MMM d, yyyy")}
            </DetailField>
          )}
          <DetailField label="Classification">
            <div className="flex flex-col gap-1">
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={`text-xs px-2 py-0.5 rounded-full capitalize inline-flex items-center gap-1 ${
                    AUTHORITY_CLASS[doc.authorityTier ?? "unknown"] ?? "bg-muted text-muted-foreground"
                  }`}
                >
                  {doc.authoritySource === "manual" && <Lock className="h-2.5 w-2.5" />}
                  {doc.authorityTier ?? "unknown"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {doc.authoritySource === "manual"
                    ? "pinned manually by an editor"
                    : "set automatically by the domain classifier"}
                </span>
              </span>
              {doc.authorityReason && (
                <span className="text-xs text-muted-foreground">Why: {doc.authorityReason}</span>
              )}
            </div>
          </DetailField>
        </dl>
      </Card>

      {/* Promote as canonical */}
      <PromoteCanonicalCard
        doc={doc}
        pending={promoteCanonical.isPending}
        onSubmit={(input) => promoteCanonical.mutate({ id, data: input })}
      />

      {/* Duplicate family */}
      {(data.duplicateOf || data.duplicates.length > 0) && (
        <Card className="p-4 mb-6">
          <h2 className="font-serif font-bold mb-3 flex items-center gap-2">
            <Copy className="h-4 w-4" /> Duplicate family
          </h2>
          <FamilyRetrievalBanner
            rep={data.duplicateOf}
            selfIsRep={!data.duplicateOf}
            selfStatus={doc.status}
            selfChunks={doc.chunkCount}
          />
          {data.duplicateOf && (
            <div className="mb-3">
              <div className="text-xs font-medium text-muted-foreground mb-1">Representative</div>
              <SourceRefRow refDoc={data.duplicateOf} isRepresentative />
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => makeRep.mutate({ id })}
                  disabled={makeRep.isPending}
                >
                  {makeRep.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                  ) : (
                    <Crown className="h-4 w-4 mr-1" />
                  )}
                  Make this document the representative
                </Button>
                <span className="text-xs text-muted-foreground">
                  Swaps the whole family to use this copy for retrieval.
                </span>
              </div>
            </div>
          )}
          {data.duplicates.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">
                Duplicates of this document ({data.duplicates.length})
              </div>
              <div className="space-y-1.5">
                {data.duplicates.map((d) => (
                  <SourceRefRow key={d.id} refDoc={d} />
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Representative score breakdown */}
      {typeof data.representativeScore === "number" && (
        <Card className="p-4 mb-6">
          <h2 className="font-serif font-bold mb-3 flex items-center gap-2">
            <Crown className="h-4 w-4" /> Representative score
            <span className="text-sm font-mono font-normal px-2 py-0.5 rounded bg-muted">
              {Math.round(data.representativeScore)}
            </span>
          </h2>
          <p className="text-xs text-muted-foreground mb-2">
            How good a "keeper" this copy is compared to duplicates of the same content. Authority
            weighs most; quality, completeness and retrievability follow.
          </p>
          {(data.representativeReasons ?? []).length > 0 && (
            <ul className="text-xs space-y-0.5">
              {(data.representativeReasons ?? []).map((r, i) => (
                <li key={i} className="text-muted-foreground">
                  • {r}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* Articles that cite this source */}
      <Card className="p-4 mb-6">
        <h2 className="font-serif font-bold mb-3 flex items-center gap-2">
          <FileText className="h-4 w-4" /> Cited by ({data.articles.length})
        </h2>
        {data.articles.length === 0 ? (
          <p className="text-sm text-muted-foreground">No articles cite this source yet.</p>
        ) : (
          <div className="space-y-2">
            {data.articles.map((a) => (
              <ArticleUsageRow key={`${a.articleId}-${a.url ?? ""}`} usage={a} />
            ))}
          </div>
        )}
      </Card>

      {/* Related sources */}
      {data.relatedSources.length > 0 && (
        <Card className="p-4 mb-6">
          <h2 className="font-serif font-bold mb-3 flex items-center gap-2">
            <Link2 className="h-4 w-4" /> Related sources
          </h2>
          <div className="space-y-1.5">
            {data.relatedSources.map((r) => (
              <RelatedSourceRow key={r.id} related={r} />
            ))}
          </div>
        </Card>
      )}

      {/* Extracted text + chunks */}
      <Card className="p-4 mb-6">
        <h2 className="font-serif font-bold mb-3">Extracted text</h2>
        <ExtractedTextViewer text={data.extractedText ?? null} />
        {data.chunks.length === 0 ? (
          <p className="text-xs text-muted-foreground mt-3">
            No embedded chunks yet.{" "}
            {data.extractedText
              ? "Extracted text is stored; approve/embed to enable retrieval."
              : "No extracted text was stored for this document."}
          </p>
        ) : (
          <div className="mt-4">
            <div className="text-xs font-medium text-muted-foreground mb-1">
              Embedded chunks ({data.chunks.length})
            </div>
            <ul className="space-y-1.5 max-h-96 overflow-y-auto">
              {data.chunks.map((c) => (
                <li key={c.id} className="text-xs border rounded p-2">
                  <div className="text-muted-foreground mb-0.5">
                    #{c.chunkIndex} · {c.charCount} chars
                    {c.dimensions ? ` · ${c.dimensions}d ${c.embeddingModel ?? ""}` : ""}
                  </div>
                  <p className="line-clamp-3">{c.content}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/admin/source-vault"
      className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
    >
      <ArrowLeft className="h-4 w-4" /> Back to Source Vault
    </Link>
  );
}

// "Retrievable?" health banner for a duplicate family: the family is healthy
// when its representative is embedded with chunks (that's the only copy the
// AI can retrieve). Shown for both perspectives — viewing the rep itself, or
// viewing one of its duplicates.
function FamilyRetrievalBanner({
  rep,
  selfIsRep,
  selfStatus,
  selfChunks,
}: {
  rep: SourceRef | null | undefined;
  selfIsRep: boolean;
  selfStatus: string;
  selfChunks: number;
}) {
  const status = selfIsRep ? selfStatus : (rep?.status ?? "unknown");
  const chunks = selfIsRep ? selfChunks : (rep?.chunkCount ?? 0);
  const ok = status === "embedded" && chunks > 0;
  const who = selfIsRep ? "This document is the family representative" : "The family representative";
  return (
    <div
      className={`flex items-start gap-2 rounded-md border p-2.5 mb-3 text-xs ${
        ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-300 bg-amber-50 text-amber-800"
      }`}
    >
      {ok ? (
        <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
      ) : (
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
      )}
      <div>
        <div className="font-medium">
          {ok ? "Retrievable" : "Not retrievable"}
        </div>
        <div>
          {ok
            ? `${who} is embedded with ${chunks} chunks — the AI can use this family when researching.`
            : `${who} has no embedded chunks (status: ${status}) — the AI cannot retrieve this family right now. Approve/embed the representative, or make a better copy the representative.`}
        </div>
      </div>
    </div>
  );
}

function SourceRefRow({
  refDoc,
  isRepresentative,
}: {
  refDoc: SourceRef;
  isRepresentative?: boolean;
}) {
  return (
    <Link
      href={`/admin/source-vault/${refDoc.id}`}
      className="flex items-center gap-2 border rounded-md p-2 hover:bg-muted/50 group"
    >
      {isRepresentative && <Crown className="h-3.5 w-3.5 text-amber-600 shrink-0" />}
      <StatusBadge status={refDoc.status} />
      <LifecycleBadge status={refDoc.lifecycleStatus} />
      {refDoc.authorityTier && (
        <span
          className={`text-xs px-2 py-0.5 rounded-full capitalize ${
            AUTHORITY_CLASS[refDoc.authorityTier] ?? "bg-muted text-muted-foreground"
          }`}
        >
          {refDoc.authorityTier}
        </span>
      )}
      <span className="text-sm truncate group-hover:text-primary min-w-0 flex-1">
        {refDoc.title ?? refDoc.url}
      </span>
      <span
        className="text-xs font-mono px-1.5 py-0.5 rounded bg-muted shrink-0"
        title={(refDoc.representativeReasons ?? []).join("\n")}
      >
        {Math.round(refDoc.representativeScore)}
      </span>
      <span className="text-xs text-muted-foreground shrink-0">
        {refDoc.chunkCount} chunks
      </span>
      <span className="text-xs text-muted-foreground shrink-0">{refDoc.domain}</span>
    </Link>
  );
}

function ArticleUsageRow({ usage }: { usage: SourceArticleUsage }) {
  return (
    <div className="flex items-center gap-2 border rounded-md p-2">
      <span
        className={`text-xs px-2 py-0.5 rounded-full capitalize ${
          ARTICLE_STATUS_CLASS[usage.articleStatus] ?? "bg-muted text-muted-foreground"
        }`}
      >
        {usage.articleStatus}
      </span>
      <span
        className={`text-xs px-2 py-0.5 rounded-full ${ROLE_CLASS[usage.role] ?? "bg-muted text-muted-foreground"}`}
      >
        {usage.role.replace("_", " ")}
      </span>
      <span className="text-sm truncate min-w-0 flex-1">{usage.articleTitle}</span>
      <div className="flex items-center gap-2 shrink-0">
        {usage.articleStatus === "published" && (
          <a
            href={`/article/${usage.articleSlug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary"
            title="View live article"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
        <Link
          href={`/admin/articles/${usage.articleId}`}
          className="text-xs text-primary hover:underline"
        >
          Edit
        </Link>
      </div>
    </div>
  );
}

function RelatedSourceRow({ related }: { related: RelatedSource }) {
  return (
    <Link
      href={`/admin/source-vault/${related.id}`}
      className="flex items-center gap-2 border rounded-md p-2 hover:bg-muted/50 group"
    >
      <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-muted shrink-0">
        {(related.similarity * 100).toFixed(0)}%
      </span>
      {related.authorityTier && (
        <span
          className={`text-xs px-2 py-0.5 rounded-full capitalize ${
            AUTHORITY_CLASS[related.authorityTier] ?? "bg-muted text-muted-foreground"
          }`}
        >
          {related.authorityTier}
        </span>
      )}
      <span className="text-sm truncate group-hover:text-primary min-w-0 flex-1">
        {related.title ?? related.url}
      </span>
      <span className="text-xs text-muted-foreground shrink-0">{related.domain}</span>
    </Link>
  );
}

function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground mb-0.5">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

function PromoteCanonicalCard({
  doc,
  pending,
  onSubmit,
}: {
  doc: SourceDocument;
  pending: boolean;
  onSubmit: (input: { canonicalUrl: string | null; tier?: SourceDocument["authorityTier"]; reason?: string }) => void;
}) {
  const [canonicalUrl, setCanonicalUrl] = useState(doc.canonicalUrl ?? "");
  const [tier, setTier] = useState<SourceDocument["authorityTier"] | "">(doc.authorityTier ?? "");

  const trimmed = canonicalUrl.trim();
  const canonicalChanged = trimmed !== (doc.canonicalUrl ?? "");
  const tierChanged = tier !== "" && tier !== doc.authorityTier;
  const dirty = canonicalChanged || tierChanged;

  return (
    <Card className="p-4 mb-6">
      <h2 className="font-serif font-bold mb-1 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4" /> Promote as canonical
      </h2>
      <p className="text-sm text-muted-foreground mb-3">
        Mark this document as the canonical representative: record its canonical URL and/or pin an authority
        tier. Pinning a tier here persists across re-ingest.
      </p>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Canonical URL
          <input
            type="url"
            placeholder="https://canonical.example.com/article"
            className="border rounded-md px-3 py-1.5 text-sm bg-background text-foreground"
            value={canonicalUrl}
            onChange={(e) => setCanonicalUrl(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground w-fit">
          Authority tier
          <select
            className="border rounded-md px-2 py-1.5 text-sm bg-background text-foreground"
            value={tier}
            onChange={(e) => setTier(e.target.value as SourceDocument["authorityTier"] | "")}
          >
            <option value="">Leave unchanged</option>
            {AUTHORITY_TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={pending || !dirty}
            onClick={() =>
              onSubmit({
                canonicalUrl: canonicalChanged ? (trimmed ? trimmed : null) : (doc.canonicalUrl ?? null),
                tier: tierChanged ? (tier as SourceDocument["authorityTier"]) : undefined,
                reason: "Promoted as canonical from source detail",
              })
            }
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <ShieldCheck className="h-4 w-4 mr-1" />}
            Promote as canonical
          </Button>
          {doc.canonicalUrl && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setCanonicalUrl("");
                onSubmit({ canonicalUrl: null });
              }}
            >
              Clear canonical URL
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function ExtractedTextViewer({ text }: { text: string | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!text || text.trim().length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No extracted text stored — this document was held or failed before extraction.
      </p>
    );
  }
  const charCount = text.length;
  const PREVIEW = 2000;
  const isLong = charCount > PREVIEW;
  const shown = expanded || !isLong ? text : text.slice(0, PREVIEW);
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs font-medium text-muted-foreground">
          {charCount.toLocaleString()} chars
        </div>
        {isLong && (
          <button onClick={() => setExpanded((v) => !v)} className="text-xs text-primary hover:underline">
            {expanded ? "Show less" : "Show all"}
          </button>
        )}
      </div>
      <pre className="text-xs whitespace-pre-wrap break-words bg-muted/40 border rounded p-2 max-h-96 overflow-y-auto font-sans">
        {shown}
        {!expanded && isLong ? "…" : ""}
      </pre>
    </div>
  );
}
