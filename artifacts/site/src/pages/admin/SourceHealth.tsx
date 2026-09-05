import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

type RetractionImpactItem = {
  articleId: string;
  articleTitle: string;
  articleSlug: string;
  sourceId: string;
  sourceUrl: string;
  sourceDomain: string | null;
  sourceTitle: string | null;
  lifecycleStatus: "retracted" | "unavailable" | "superseded" | "stale";
  impactedAt: string;
  rescanAttemptedAt: string | null;
  rescanResult: string | null;
};

const STATUS_COLORS: Record<RetractionImpactItem["lifecycleStatus"], string> = {
  retracted: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300 border-red-200",
  unavailable: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300 border-orange-200",
  superseded: "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300 border-yellow-200",
  stale: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-slate-200",
};

const STATUS_LABELS: Record<RetractionImpactItem["lifecycleStatus"], string> = {
  retracted: "Retracted",
  unavailable: "Unavailable",
  superseded: "Superseded",
  stale: "Stale",
};

async function fetchImpacts(): Promise<{ impacts: RetractionImpactItem[] }> {
  const res = await fetch("/api/admin/source-health");
  if (!res.ok) throw new Error(`Failed to load impacts: ${res.status}`);
  return res.json() as Promise<{ impacts: RetractionImpactItem[] }>;
}

async function rescanArticle(articleId: string): Promise<{ rescanned: number; cleared: number }> {
  const res = await fetch(`/api/admin/source-health/${articleId}/rescan`, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Rescan failed: ${res.status}`);
  }
  return res.json() as Promise<{ rescanned: number; cleared: number }>;
}

async function clearArticle(articleId: string): Promise<{ cleared: boolean; articleId: string }> {
  const res = await fetch(`/api/admin/source-health/${articleId}/clear`, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Clear failed: ${res.status}`);
  }
  return res.json() as Promise<{ cleared: boolean; articleId: string }>;
}

export default function SourceHealth() {
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin", "source-health"],
    queryFn: fetchImpacts,
    refetchOnWindowFocus: false,
  });

  const rescanMutation = useMutation({
    mutationFn: (articleId: string) => {
      setPendingId(articleId);
      return rescanArticle(articleId);
    },
    onSuccess: (result, articleId) => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "source-health"] });
      if (result.cleared > 0) {
        toast.success("Re-screen complete — retraction flag cleared automatically.");
      } else {
        toast.info("Re-screen complete — article still lacks an active trusted source. Flag remains.");
      }
    },
    onError: (err: Error) => {
      toast.error(`Re-screen failed: ${err.message}`);
    },
    onSettled: () => setPendingId(null),
  });

  const clearMutation = useMutation({
    mutationFn: (articleId: string) => {
      setPendingId(articleId);
      return clearArticle(articleId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "source-health"] });
      toast.success("Impact cleared manually. Article will no longer show the source notice.");
    },
    onError: (err: Error) => {
      toast.error(`Clear failed: ${err.message}`);
    },
    onSettled: () => setPendingId(null),
  });

  const impacts = data?.impacts ?? [];

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Source Health</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Articles whose evidence sources have been marked retracted, unavailable, superseded, or
          stale. Each carries a reader-visible notice until rescanned or manually cleared.
        </p>
      </div>

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-md" />
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Failed to load retraction impacts. Check the API server logs.
        </div>
      )}

      {!isLoading && !error && impacts.length === 0 && (
        <div className="flex items-center gap-3 rounded-md border border-border bg-muted/40 px-5 py-10 text-sm text-muted-foreground">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500" />
          No uncleared retraction impacts — all articles are in good standing.
        </div>
      )}

      {impacts.length > 0 && (
        <div className="rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Article</TableHead>
                <TableHead>Triggering Source</TableHead>
                <TableHead className="w-28">Status</TableHead>
                <TableHead className="w-32">Flagged</TableHead>
                <TableHead className="w-32">Last Rescan</TableHead>
                <TableHead className="w-36 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {impacts.map((item) => {
                const isBusy = pendingId === item.articleId;
                return (
                  <TableRow key={`${item.articleId}::${item.sourceId}`}>
                    <TableCell className="max-w-xs">
                      <a
                        href={`/article/${item.articleSlug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                      >
                        <span className="line-clamp-2">{item.articleTitle}</span>
                        <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
                      </a>
                    </TableCell>

                    <TableCell className="max-w-xs">
                      <a
                        href={item.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground hover:decoration-foreground/40"
                      >
                        <span className="line-clamp-2">
                          {item.sourceTitle ?? item.sourceDomain ?? item.sourceUrl}
                        </span>
                        <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
                      </a>
                    </TableCell>

                    <TableCell>
                      <Badge
                        variant="outline"
                        className={`text-[11px] font-semibold ${STATUS_COLORS[item.lifecycleStatus]}`}
                      >
                        {STATUS_LABELS[item.lifecycleStatus]}
                      </Badge>
                    </TableCell>

                    <TableCell className="text-xs text-muted-foreground">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>{formatDistanceToNow(new Date(item.impactedAt), { addSuffix: true })}</span>
                        </TooltipTrigger>
                        <TooltipContent>
                          {format(new Date(item.impactedAt), "PPpp")}
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>

                    <TableCell className="text-xs text-muted-foreground">
                      {item.rescanAttemptedAt ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>
                              {formatDistanceToNow(new Date(item.rescanAttemptedAt), { addSuffix: true })}
                              {item.rescanResult && (
                                <span className="block opacity-70">{item.rescanResult}</span>
                              )}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            {format(new Date(item.rescanAttemptedAt), "PPpp")}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="opacity-50">—</span>
                      )}
                    </TableCell>

                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2"
                              disabled={isBusy}
                              onClick={() => rescanMutation.mutate(item.articleId)}
                            >
                              <RefreshCw className={`h-3.5 w-3.5 ${isBusy ? "animate-spin" : ""}`} />
                              <span className="sr-only">Re-screen</span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Re-screen — auto-clears if article still has active trusted sources</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2 text-green-700 hover:bg-green-50 hover:text-green-800 dark:text-green-400 dark:hover:bg-green-950"
                              disabled={isBusy}
                              onClick={() => clearMutation.mutate(item.articleId)}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              <span className="sr-only">Clear manually</span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Clear manually — editor sign-off that evidence base is acceptable</TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
