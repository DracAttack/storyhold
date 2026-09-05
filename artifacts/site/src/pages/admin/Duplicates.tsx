import {
  useListDuplicates,
  getListDuplicatesQueryKey,
  useScanDuplicates,
  useGetDuplicateScanStatus,
  getGetDuplicateScanStatusQueryKey,
  useKeepDuplicate,
  useDeleteDuplicate,
  type DuplicateReview,
  type DuplicateArticleSummary,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, ScanSearch, Check, Trash2, ExternalLink, ArrowRight, ShieldCheck } from "lucide-react";
import { handleImageError, resolveImage, withImageParams } from "@/lib/heroImage";
import { toast } from "sonner";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function ArticleMini({ a, tone }: { a: DuplicateArticleSummary; tone: "offender" | "original" }) {
  const badge =
    tone === "offender"
      ? { label: "Quarantined", cls: "bg-amber-500 text-white" }
      : { label: "Original", cls: "bg-emerald-600 text-white" };
  return (
    <div className="flex-1 min-w-0">
      <div className="relative aspect-[16/9] bg-muted rounded-lg overflow-hidden">
        <img
          src={withImageParams(resolveImage(a.heroImage), 400)}
          onError={handleImageError}
          alt=""
          loading="lazy"
          className="w-full h-full object-cover"
        />
        <span className={`absolute top-2 left-2 rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}`}>
          {badge.label}
        </span>
      </div>
      <p className="mt-2 text-sm font-medium line-clamp-2" title={a.title}>
        {a.title}
      </p>
      <p className="text-xs text-muted-foreground mt-0.5">
        {a.category} · {a.authorName} · {fmtDate(a.publishedAt)}
      </p>
      <a
        href={`/article/${a.slug}`}
        target="_blank"
        rel="noreferrer"
        className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
      >
        <ExternalLink className="h-3 w-3" /> View {tone === "original" ? "original" : "article"}
      </a>
    </div>
  );
}

function ReviewCard({
  review,
  onKeep,
  onDelete,
  busy,
}: {
  review: DuplicateReview;
  onKeep: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <Card className="p-4 space-y-4">
      <div className="flex flex-col sm:flex-row items-stretch gap-3">
        <ArticleMini a={review.newer} tone="offender" />
        <div className="hidden sm:flex items-center text-muted-foreground shrink-0">
          <ArrowRight className="h-5 w-5" />
        </div>
        <ArticleMini a={review.older} tone="original" />
      </div>

      <div className="rounded-md bg-muted/60 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
          Why it was flagged
        </p>
        <p className="text-sm">{review.reason || "No reason recorded."}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          Flagged {fmtDate(review.createdAt)} · similarity {Math.round(review.score * 100)}%
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onKeep} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Check className="h-4 w-4 mr-2" />}
            Keep
          </Button>
          <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)} disabled={busy}>
            <Trash2 className="h-4 w-4 mr-2" /> Delete
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={(o) => !busy && setConfirmDelete(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this article?</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently deletes “{review.newer.title}”. The older original stays live. This can't be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onDelete}
            >
              Delete article
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

export default function Duplicates() {
  const qc = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const listQuery = useListDuplicates();
  const reviews = listQuery.data?.items ?? [];

  const statusQuery = useGetDuplicateScanStatus({
    query: {
      queryKey: getGetDuplicateScanStatusQueryKey(),
      refetchInterval: (query) => (query.state.data?.running ? 2000 : false),
    },
  });
  const status = statusQuery.data;
  const running = status?.running ?? false;

  // When a scan finishes, refresh the pending queue so newly-quarantined pairs show.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      qc.invalidateQueries({ queryKey: getListDuplicatesQueryKey() });
      const last = status?.lastResult;
      if (last) {
        toast.success(
          `Scan done — ${last.quarantined} flagged from ${last.scanned} articles (${last.llmCalls} AI checks).`,
        );
      }
    }
    wasRunning.current = running;
  }, [running, qc, status?.lastResult]);

  const refetchStatus = () => statusQuery.refetch();

  const scan = useScanDuplicates({
    mutation: {
      onSuccess: (res) => {
        if (res.alreadyRunning) toast.info("A scan is already running.");
        else toast.success("Scanning for duplicates…");
        refetchStatus();
      },
      onError: () => toast.error("Couldn't start the scan."),
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: getListDuplicatesQueryKey() });

  const keep = useKeepDuplicate({
    mutation: {
      onSuccess: () => {
        toast.success("Kept — restored to the site and won't be flagged again.");
        invalidate();
      },
      onError: () => toast.error("Couldn't keep that article."),
      onSettled: () => setPendingId(null),
    },
  });

  const del = useDeleteDuplicate({
    mutation: {
      onSuccess: () => {
        toast.success("Deleted.");
        invalidate();
      },
      onError: () => toast.error("Couldn't delete that article."),
      onSettled: () => setPendingId(null),
    },
  });

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-bold">Dupes</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Articles the daily AI scan flagged as near-duplicates. The newer one is quarantined (hidden
            from the site) until you decide. <span className="font-medium text-foreground">{reviews.length}</span>{" "}
            awaiting review.
          </p>
        </div>
        <Button size="sm" onClick={() => scan.mutate()} disabled={running || scan.isPending}>
          {running || scan.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <ScanSearch className="h-4 w-4 mr-2" />
          )}
          {running ? "Scanning…" : "Scan now"}
        </Button>
      </div>

      {status?.lastFinishedAt && !running ? (
        <p className="text-xs text-muted-foreground">
          Last scan {fmtDate(status.lastFinishedAt)}
          {status.lastResult
            ? ` · ${status.lastResult.quarantined} flagged, ${status.lastResult.scanned} scanned`
            : ""}
          {status.lastError ? ` · error: ${status.lastError}` : ""}
        </p>
      ) : null}

      {listQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : reviews.length === 0 ? (
        <div className="flex flex-col items-center gap-2 text-muted-foreground py-16 text-center">
          <ShieldCheck className="h-10 w-10" />
          <p className="text-sm">No duplicates pending review. Nice and clean.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {reviews.map((r) => {
            const busy = pendingId === r.id && (keep.isPending || del.isPending);
            return (
              <ReviewCard
                key={r.id}
                review={r}
                busy={busy}
                onKeep={() => {
                  setPendingId(r.id);
                  keep.mutate({ id: r.id });
                }}
                onDelete={() => {
                  setPendingId(r.id);
                  del.mutate({ id: r.id });
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
