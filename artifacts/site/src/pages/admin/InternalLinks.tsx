import {
  useListArticles,
  getListArticlesQueryKey,
  useGetInternalLinkJobStatus,
  getGetInternalLinkJobStatusQueryKey,
  useBackfillAllInternalLinks,
  useCancelInternalLinkJob,
  type ArticleBlock,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Loader2, Link2, Plus, OctagonX, ExternalLink, ChevronDown, ChevronRight, ArrowRight } from "lucide-react";
import { toast } from "sonner";

type Filter = "all" | "has" | "missing";

// Mirrors countInternalLinks in the API server: Markdown links that point at
// another article (/article/<slug>) inside paragraph blocks only.
const INTERNAL_LINK_RE = /\[([^\]]+)\]\((\/article\/[^\s)]+)\)/g;

// Per-article internal-link cap. Mirrors INTERNAL_LINK_TARGET in the API server
// (artifacts/api-server/src/services/articles.ts) — keep in sync.
const INTERNAL_LINK_TARGET = 4;

// Characters of surrounding text to show on each side of the anchor.
const CONTEXT_WINDOW = 90;

type ExtractedLink = {
  /** The clickable anchor text as it appears in the body. */
  anchor: string;
  /** Target article slug (the part after /article/). */
  slug: string;
  /** Text immediately before the anchor (link syntax stripped, left-truncated). */
  before: string;
  /** Text immediately after the anchor (link syntax stripped, right-truncated). */
  after: string;
};

// Replace [text](/article/slug) markdown with just the visible text.
function stripLinkSyntax(s: string): string {
  return s.replace(/\[([^\]]+)\]\(\/article\/[^\s)]+\)/g, "$1");
}

function extractLinks(body?: ArticleBlock[] | null): ExtractedLink[] {
  if (!body) return [];
  const out: ExtractedLink[] = [];
  for (const b of body) {
    if (b.type !== "paragraph" || typeof b.content !== "string") continue;
    const re = new RegExp(INTERNAL_LINK_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(b.content)) !== null) {
      const anchor = m[1];
      const slug = m[2].replace(/^\/article\//, "");
      // Derive context from THIS match's position (m.index), not a textual
      // search — that avoids highlighting the wrong occurrence when the same
      // phrase appears more than once in the paragraph. Everything before the
      // match's `[` and after its closing `)` consists of complete tokens, so
      // stripping link syntax on each side is safe.
      let before = stripLinkSyntax(b.content.slice(0, m.index)).trimStart();
      let after = stripLinkSyntax(b.content.slice(m.index + m[0].length)).trimEnd();
      if (before.length > CONTEXT_WINDOW) {
        before = "… " + before.slice(before.length - CONTEXT_WINDOW).trimStart();
      }
      if (after.length > CONTEXT_WINDOW) {
        after = after.slice(0, CONTEXT_WINDOW).trimEnd() + " …";
      }
      out.push({ anchor, slug, before, after });
    }
  }
  return out;
}

export default function InternalLinks() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");

  const articlesQuery = useListArticles({ status: "published" });
  const articles = articlesQuery.data?.items ?? [];

  // Poll the job status only while a backfill is actually running. When a run
  // finishes, refetch the gallery so the new link counts appear.
  const statusQuery = useGetInternalLinkJobStatus({
    query: {
      queryKey: getGetInternalLinkJobStatusQueryKey(),
      refetchInterval: (query) => (query.state.data?.running ? 1500 : false),
    },
  });
  const status = statusQuery.data;
  const running = status?.running ?? false;

  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      qc.invalidateQueries({ queryKey: getListArticlesQueryKey({ status: "published" }) });
    }
    wasRunning.current = running;
  }, [running, qc]);

  const refetchStatus = () => statusQuery.refetch();

  const backfill = useBackfillAllInternalLinks({
    mutation: {
      onSuccess: (res) => {
        if (res.alreadyRunning) toast.info("A link backfill is already running.");
        else toast.success("Adding internal links — progress below.");
        refetchStatus();
      },
      onError: () => toast.error("Couldn't start the backfill"),
    },
  });

  const cancelJob = useCancelInternalLinkJob({
    mutation: {
      onSuccess: (res) => {
        if (res.canceled) toast.success("Halting — the current article will finish, then it stops.");
        else toast.info("No backfill is running.");
        refetchStatus();
      },
      onError: () => toast.error("Couldn't halt the backfill"),
    },
  });

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Resolve a target slug to a published-article title (+ id for an editor link).
  // This published set is also our "live" target set: a link whose slug isn't
  // here points at an unpublished/deleted article and counts as dead.
  const articleBySlug = new Map(articles.map((a) => [a.slug, a]));

  // DISTINCT live targets — mirrors the backend budget math (one slug linked
  // several times counts once toward the cap). Dead = every link instance whose
  // target isn't in the live set (all get scrubbed on a top-up).
  const liveLinkCount = (a: (typeof articles)[number]) =>
    new Set(extractLinks(a.body).filter((l) => articleBySlug.has(l.slug)).map((l) => l.slug)).size;
  const deadLinkCount = (a: (typeof articles)[number]) =>
    extractLinks(a.body).filter((l) => !articleBySlug.has(l.slug)).length;
  // "Needs work" = below the per-article cap OR carrying any dead link to scrub.
  const needsWork = (a: (typeof articles)[number]) =>
    liveLinkCount(a) < INTERNAL_LINK_TARGET || deadLinkCount(a) > 0;
  const total = articles.length;
  const needWork = articles.filter(needsWork).length;
  const atTarget = total - needWork;

  const visible = articles.filter((a) => {
    if (filter === "has") return !needsWork(a);
    if (filter === "missing") return needsWork(a);
    return true;
  });

  const pct = status && status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0;

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-bold">Internal links</h1>
          <p className="text-sm text-muted-foreground mt-1">
            In-body links between published articles, up to {INTERNAL_LINK_TARGET} per article.{" "}
            <span className="font-medium text-foreground">{atTarget}</span> are fully linked,{" "}
            <span className="font-medium text-foreground">{needWork}</span> can take more.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => backfill.mutate()}
            disabled={running || backfill.isPending || needWork === 0}
          >
            {backfill.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
            Top up links
          </Button>
          {running ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => cancelJob.mutate()}
              disabled={cancelJob.isPending || status?.canceled}
            >
              {cancelJob.isPending || status?.canceled ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <OctagonX className="h-4 w-4 mr-2" />
              )}
              {status?.canceled ? "Halting…" : "Halt"}
            </Button>
          ) : null}
        </div>
      </div>

      {(running || (status && status.finishedAt && status.processed > 0)) && status ? (
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">
              {running
                ? "Adding internal links…"
                : status.canceled
                  ? "Backfill halted"
                  : "Last run complete"}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {status.processed} / {status.total}
            </span>
          </div>
          <Progress value={running || status.canceled ? pct : 100} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Updated {status.updated}</span>
            <span>Links added {status.linksAdded}</span>
            {status.linksRemoved > 0 ? <span>Dead links removed {status.linksRemoved}</span> : null}
            <span>Skipped {status.skipped}</span>
            {status.failed > 0 ? <span className="text-destructive">Failed {status.failed}</span> : null}
            {status.canceled ? <span>Canceled</span> : null}
          </div>
        </Card>
      ) : null}

      <div className="flex gap-2">
        {(["all", "has", "missing"] as Filter[]).map((f) => (
          <Button
            key={f}
            variant={filter === f ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(f)}
          >
            {f === "all" ? `All (${total})` : f === "has" ? `At target (${atTarget})` : `Needs work (${needWork})`}
          </Button>
        ))}
      </div>

      {articlesQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground py-12 text-center">No articles match this filter.</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {visible.map((a) => {
            const links = extractLinks(a.body);
            const count = links.length;
            const present = count > 0;
            const live = liveLinkCount(a);
            const dead = deadLinkCount(a);
            const atCap = live >= INTERNAL_LINK_TARGET;
            const isOpen = expanded.has(a.id);
            return (
              <Card key={a.id} className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => toggle(a.id)}
                    disabled={!present}
                    aria-expanded={present ? isOpen : undefined}
                    aria-controls={present ? `links-${a.id}` : undefined}
                    className="min-w-0 flex items-start gap-2 text-left disabled:cursor-default disabled:opacity-100"
                  >
                    {present ? (
                      isOpen ? (
                        <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                      )
                    ) : (
                      <span className="w-4 shrink-0" />
                    )}
                    <span className="min-w-0 space-y-2">
                      <span className="flex flex-wrap items-center gap-1">
                        <span
                          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            atCap ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"
                          }`}
                        >
                          <Link2 className="h-3 w-3" />
                          {live}/{INTERNAL_LINK_TARGET} links
                        </span>
                        {dead > 0 ? (
                          <span
                            className="inline-flex items-center gap-1 rounded bg-destructive px-1.5 py-0.5 text-[10px] font-medium text-white"
                            title="Links pointing at unpublished/deleted articles; a top-up will unwrap them"
                          >
                            <OctagonX className="h-3 w-3" />
                            {dead} dead
                          </span>
                        ) : null}
                      </span>
                      <span className="block text-sm font-medium line-clamp-2" title={a.title}>
                        {a.title}
                      </span>
                    </span>
                  </button>
                  <Link
                    href={`/admin/articles/${a.id}`}
                    className="text-muted-foreground hover:text-foreground shrink-0"
                    title="Edit article"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Link>
                </div>

                {present && isOpen ? (
                  <ul id={`links-${a.id}`} className="space-y-3 border-t pt-3">
                    {links.map((link, i) => {
                      const target = articleBySlug.get(link.slug);
                      return (
                        <li key={`${link.slug}-${i}`} className="text-xs space-y-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">
                              <Link2 className="h-3 w-3" />
                              {link.anchor}
                            </span>
                            <ArrowRight className="h-3 w-3 text-muted-foreground" />
                            <a
                              href={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/article/${link.slug}`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-primary hover:underline font-medium"
                              title={target ? target.title : link.slug}
                            >
                              {target ? target.title : link.slug}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                            {!target ? (
                              <span className="text-amber-600" title="Target not in the published set">
                                (unresolved)
                              </span>
                            ) : null}
                          </div>
                          <p className="text-muted-foreground leading-relaxed">
                            {link.before}
                            <mark className="bg-amber-100 text-foreground rounded px-0.5">{link.anchor}</mark>
                            {link.after}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
