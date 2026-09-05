import { useState } from "react";
import {
  useListMemes,
  useListMemeQueue,
  useDeleteMeme,
  useUnqueueMeme,
  getListMemesQueryKey,
  getListMemeQueueQueryKey,
  type Meme,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  Laugh,
  Inbox,
  ExternalLink,
  ImagePlus,
  ListOrdered,
  Trash2,
  Undo2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

function statusClasses(status: string): string {
  switch (status) {
    case "posted":
      return "bg-green-100 text-green-800 border-green-200";
    case "failed":
      return "bg-red-100 text-red-800 border-red-200";
    case "queued":
    case "scheduled":
      return "bg-violet-100 text-violet-800 border-violet-200";
    case "posting":
      return "bg-blue-100 text-blue-800 border-blue-200";
    case "approved":
      return "bg-sky-100 text-sky-800 border-sky-200";
    default:
      return "bg-zinc-100 text-zinc-700 border-zinc-200";
  }
}

function errMsg(err: unknown): string {
  if (err && typeof err === "object" && "response" in err) {
    const r = (err as { response?: { data?: { error?: string } } }).response;
    if (r?.data?.error) return r.data.error;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}

function fmt(ts: string | null | undefined): string {
  if (!ts) return "—";
  try {
    return format(new Date(ts), "MMM d, yyyy HH:mm");
  } catch {
    return ts;
  }
}

export default function AdminMemes() {
  const [view, setView] = useState<"drafts" | "queue">("drafts");
  const { toast } = useToast();
  const qc = useQueryClient();

  const draftsQuery = useListMemes(
    { limit: 100 },
    { query: { queryKey: getListMemesQueryKey({ limit: 100 }), enabled: view === "drafts" } },
  );
  const queueQuery = useListMemeQueue(
    { limit: 100 },
    { query: { queryKey: getListMemeQueueQueryKey({ limit: 100 }), enabled: view === "queue" } },
  );

  const remove = useDeleteMeme();
  const unqueue = useUnqueueMeme();

  function refresh() {
    qc.invalidateQueries({ queryKey: getListMemesQueryKey({ limit: 100 }) });
    qc.invalidateQueries({ queryKey: getListMemeQueueQueryKey({ limit: 100 }) });
  }

  async function handleDelete(m: Meme) {
    if (!window.confirm("Delete this meme? This can't be undone.")) return;
    try {
      await remove.mutateAsync({ id: m.id });
      toast({ title: "Meme deleted" });
      refresh();
    } catch (err) {
      toast({
        title: "Couldn't delete",
        description: errMsg(err),
        variant: "destructive",
      });
    }
  }

  async function handleUnqueue(m: Meme) {
    try {
      await unqueue.mutateAsync({ id: m.id });
      toast({ title: "Removed from queue", description: "The meme is back in drafts." });
      refresh();
    } catch (err) {
      toast({
        title: "Couldn't unqueue",
        description: errMsg(err),
        variant: "destructive",
      });
    }
  }

  const list = view === "drafts" ? draftsQuery : queueQuery;
  const items: Meme[] = list.data?.items ?? [];
  const isLoading = list.isLoading;
  const busy = remove.isPending || unqueue.isPending;

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Laugh className="h-6 w-6" /> Memes
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Turn any article into a social meme. Start one from the meme button on an{" "}
            <Link href="/admin/articles" className="text-primary hover:underline">article row</Link>.
            Approving a meme enqueues it for the daily meme slots (10am, 4pm, 7pm Phoenix), separate
            from article-link posts.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/memes/templates">
            <ImagePlus className="h-4 w-4 mr-1" /> Template library
          </Link>
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant={view === "drafts" ? "default" : "outline"}
          size="sm"
          onClick={() => setView("drafts")}
        >
          <Laugh className="h-4 w-4 mr-1" /> All memes
        </Button>
        <Button
          variant={view === "queue" ? "default" : "outline"}
          size="sm"
          onClick={() => setView("queue")}
        >
          <ListOrdered className="h-4 w-4 mr-1" /> Queue
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <Inbox className="h-8 w-8 mx-auto mb-2 opacity-50" />
          {view === "queue"
            ? "No memes in the queue yet. Approve a meme to enqueue it."
            : "No memes yet. Open an article and click the meme button to create one."}
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((m) => (
            <Link key={m.id} href={`/admin/memes/${m.id}`}>
              <Card className="p-3 sm:p-4 hover:border-primary cursor-pointer flex items-center gap-4">
                <div className="h-16 w-16 shrink-0 rounded bg-muted overflow-hidden flex items-center justify-center">
                  {m.composedImageUrl ? (
                    <img src={m.composedImageUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <Laugh className="h-6 w-6 text-muted-foreground/50" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className={statusClasses(m.status)}>
                      {m.status}
                    </Badge>
                    <Badge variant="outline">{m.category || "—"}</Badge>
                  </div>
                  <p className="font-medium truncate mt-1">{m.articleTitle}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {m.jokeDescription || "No concept selected yet."}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {m.scheduledAt
                      ? `Scheduled: ${fmt(m.scheduledAt)}`
                      : m.postedAt
                        ? `Posted: ${fmt(m.postedAt)}`
                        : `Updated: ${fmt(m.updatedAt)}`}
                  </p>
                  {m.lastError && (
                    <p className="text-xs text-red-600 mt-0.5 truncate">{m.lastError}</p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  {m.facebookPostUrl && (
                    <a
                      href={m.facebookPostUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"
                    >
                      View <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {m.status === "queued" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void handleUnqueue(m);
                      }}
                    >
                      <Undo2 className="h-3.5 w-3.5 mr-1" />
                      Unqueue
                    </Button>
                  )}
                  {m.status !== "queued" &&
                    m.status !== "approved" &&
                    m.status !== "posted" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void handleDelete(m);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5 mr-1" />
                        Delete
                      </Button>
                    )}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
