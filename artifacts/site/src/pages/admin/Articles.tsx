import {
  useListArticles,
  useListAuthors,
  useDeleteArticle,
  useDeleteAllPendingArticles,
  useUnpublishArticle,
  usePublishArticle,
  usePublishAllPendingArticles,
  useScheduleArticleNow,
  useScheduleAllPendingArticles,
  useReindexAllArticles,
  useBackfillAllInternalLinks,
  useBackfillAllSourceLinks,
  useRedistributeAllSourceLinks,
  useStripSearchLinks,
  useBackfillAllShareImages,
  useRebuildAllShareImages,
  useRandomizeArticleDates,
  useGetArticle,
  useRegenerateArticleImage,
  useCreateMemeForArticle,
  useListCategories,
  useBulkLabelArticles,
  useUpdateArticle,
  useCheckArticleSourceCoverage,
  getListArticlesQueryKey,
} from "@workspace/api-client-react";
import type { BulkLabelArticlesInputEditorialLabelOverride } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useSearch, useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { Loader2, Trash2, Undo2, Eye, FileEdit, ExternalLink, Send, Rocket, ImageIcon, Search, Link2, CalendarClock, Share2, BookMarked, FileText, X, Copy, Check, Laugh, Shuffle, Tag, AlertTriangle, DatabaseZap } from "lucide-react";
import { format } from "date-fns";
import { handleImageError, resolveImage, withImageParams } from "@/lib/heroImage";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const STATUSES = ["all", "draft", "scheduled", "published"] as const;
const ALL_TABS = [...STATUSES, "held"] as const;
type Tab = (typeof ALL_TABS)[number];

const SITE_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const EDITORIAL_LABEL_OPTIONS: {
  value: BulkLabelArticlesInputEditorialLabelOverride;
  label: string;
  description: string;
}[] = [
  { value: "original_reporting", label: "Original reporting", description: "First-hand reporting, exclusive sources, interviews" },
  { value: "research_synthesis", label: "Research synthesis", description: "Evidence packet or two or more primary sources" },
  { value: "analysis", label: "Analysis", description: "Any cited source plus editorial interpretation" },
  { value: "explainer", label: "Explainer", description: "Background-forward, plain-language breakdown" },
  { value: "commentary", label: "Commentary", description: "Opinion, argument, or editorial perspective" },
];

function articleUrl(slug: string) {
  return `${window.location.origin}${SITE_BASE}/article/${slug}`;
}

export default function Articles() {
  const search = useSearch();
  const authorId = new URLSearchParams(search).get("authorId") ?? undefined;
  const [status, setStatus] = useState<Tab>("all");
  const listParams =
    status === "held"
      ? authorId
        ? { held: true, authorId }
        : { held: true }
      : status === "all"
        ? authorId
          ? { authorId }
          : undefined
        : authorId
          ? { status, authorId }
          : { status };
  const { data, isLoading } = useListArticles(listParams);
  // Always fetch the full list (scoped to the active author filter, if any) so
  // the status-tab counts and bulk-action totals are accurate regardless of
  // which status tab is selected.
  const { data: allData } = useListArticles(authorId ? { authorId } : undefined);
  const pendingCount = (allData?.items ?? []).filter((a) => a.status !== "published").length;
  const draftCount = (allData?.items ?? []).filter((a) => a.status === "draft").length;
  const publishedCount = (allData?.items ?? []).filter((a) => a.status === "published").length;
  const withCardCount = (allData?.items ?? []).filter((a) => a.shareImage).length;
  const missingCardCount = (allData?.items ?? []).length - withCardCount;
  const heldCount = (allData?.items ?? []).filter((a) => a.holdReason != null).length;
  const articleCount = (s: Tab) =>
    s === "held"
      ? heldCount
      : s === "all"
        ? (allData?.items ?? []).length
        : (allData?.items ?? []).filter((a) => a.status === s).length;
  const { data: authorsData } = useListAuthors();
  const authorMap = new Map((authorsData?.items ?? []).map((a) => [a.id, a]));
  const filteredAuthor = authorId ? authorMap.get(authorId) : undefined;

  // Beat/category + free-text filters, applied client-side over the already-
  // loaded list (the admin fetches the full set anyway, so this is instant and
  // needs no extra endpoint). Status + author still filter server-side above.
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<string>("newest");
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Debounce the free-text box so filtering doesn't re-run on every keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => setQuery(rawQuery), 250);
    return () => window.clearTimeout(id);
  }, [rawQuery]);
  // Distinct categories present in the catalog (label + slug), alphabetized, so
  // the dropdown reflects what's actually in use across every status.
  const categoryOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of allData?.items ?? []) {
      if (a.categorySlug && !map.has(a.categorySlug)) map.set(a.categorySlug, a.category);
    }
    return [...map.entries()]
      .map(([slug, label]) => ({ slug, label }))
      .sort((x, y) => x.label.localeCompare(y.label));
  }, [allData]);
  // Resolve a beat slug to its display name for crossover badges. Uses the full
  // beat list so secondary subjects not currently used as a primary still label.
  const { data: categoriesData } = useListCategories();
  const beatNameBySlug = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categoriesData?.items ?? []) map.set(c.categorySlug, c.category);
    for (const a of allData?.items ?? []) if (a.categorySlug && !map.has(a.categorySlug)) map.set(a.categorySlug, a.category);
    return map;
  }, [categoriesData, allData]);
  const beatName = (slug: string) => beatNameBySlug.get(slug) ?? slug;
  const displayed = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = (data?.items ?? []).filter((a) => {
      if (categoryFilter !== "all" && a.categorySlug !== categoryFilter) return false;
      if (q) {
        const hay = `${a.title} ${a.dek} ${a.category}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const created = (a: (typeof filtered)[number]) => new Date(a.createdAt).getTime();
    const sorted = [...filtered];
    switch (sortBy) {
      case "oldest":
        sorted.sort((x, y) => created(x) - created(y));
        break;
      case "memes-desc":
        sorted.sort((x, y) => (y.memeCount ?? 0) - (x.memeCount ?? 0) || created(y) - created(x));
        break;
      case "memes-asc":
        sorted.sort((x, y) => (x.memeCount ?? 0) - (y.memeCount ?? 0) || created(y) - created(x));
        break;
      case "views-desc":
        sorted.sort((x, y) => (y.viewCount ?? 0) - (x.viewCount ?? 0) || created(y) - created(x));
        break;
      case "views-asc":
        sorted.sort((x, y) => (x.viewCount ?? 0) - (y.viewCount ?? 0) || created(y) - created(x));
        break;
      case "newest":
      default:
        sorted.sort((x, y) => created(y) - created(x));
        break;
    }
    return sorted;
  }, [data, categoryFilter, query, sortBy]);

  const handleCopyLink = async (e: React.MouseEvent, slug: string, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(articleUrl(slug));
      setCopiedId(id);
      toast.success("Link copied");
      window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch {
      toast.error("Couldn't copy the link");
    }
  };
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: getListArticlesQueryKey() });
  const remove = useDeleteArticle({
    mutation: { onSuccess: () => { toast.success("Deleted"); invalidate(); }, onError: () => toast.error("Delete failed") },
  });
  const unpublish = useUnpublishArticle({
    mutation: { onSuccess: () => { toast.success("Sent back to draft"); invalidate(); }, onError: () => toast.error("Failed to send to draft") },
  });
  const publish = usePublishArticle({
    mutation: { onSuccess: () => { toast.success("Published"); invalidate(); }, onError: () => toast.error("Publish failed") },
  });
  const [confirmBulk, setConfirmBulk] = useState(false);
  const deleteAllPending = useDeleteAllPendingArticles({
    mutation: {
      onSuccess: (res) => {
        toast.success(`Deleted ${res.deleted} pending article${res.deleted === 1 ? "" : "s"}`);
        setConfirmBulk(false);
        invalidate();
      },
      onError: () => toast.error("Bulk delete failed"),
    },
  });
  const [confirmBulkPublish, setConfirmBulkPublish] = useState(false);
  const publishAllPending = usePublishAllPendingArticles({
    mutation: {
      onSuccess: (res) => {
        toast.success(`Published ${res.published} pending article${res.published === 1 ? "" : "s"}`);
        setConfirmBulkPublish(false);
        invalidate();
      },
      onError: () => toast.error("Bulk publish failed"),
    },
  });
  const [confirmBulkSchedule, setConfirmBulkSchedule] = useState(false);
  const scheduleAllPending = useScheduleAllPendingArticles({
    mutation: {
      onSuccess: (res) => {
        if (res.alreadyRunning) {
          toast.info("A bulk schedule is already running.");
        } else {
          const skipped = res.skippedNoSources ?? 0;
          const skipNote = skipped > 0
            ? ` (${skipped} packet-grounded draft${skipped === 1 ? "" : "s"} skipped — no evidence sources attached yet)`
            : "";
          toast.success(
            res.scheduled === 0 && skipped === 0
              ? "No drafts to schedule"
              : res.scheduled === 0
              ? `No drafts scheduled${skipNote}`
              : `Scheduled ${res.scheduled} draft${res.scheduled === 1 ? "" : "s"}${skipNote}`,
          );
        }
        setConfirmBulkSchedule(false);
        invalidate();
      },
      onError: () => toast.error("Bulk schedule failed"),
    },
  });
  const scheduleNow = useScheduleArticleNow({
    mutation: {
      onSuccess: () => { toast.success("Scheduled"); invalidate(); },
      onError: () => toast.error("Couldn't schedule — no free slot, or it's no longer a draft"),
    },
  });
  const [confirmReindex, setConfirmReindex] = useState(false);
  const reindexAll = useReindexAllArticles({
    mutation: {
      onSuccess: (res) => {
        if (res.skipped) {
          toast.info("Search-engine resubmission isn't available here (only runs on the live site).");
        } else {
          toast.success(`Resubmitted ${res.urls} URL${res.urls === 1 ? "" : "s"} to search engines.`);
        }
        setConfirmReindex(false);
      },
      onError: () => toast.error("Resubmission failed"),
    },
  });
  const [confirmBackfill, setConfirmBackfill] = useState(false);
  const backfillLinks = useBackfillAllInternalLinks({
    mutation: {
      onSuccess: (res) => {
        if (res.alreadyRunning) {
          toast.info("An internal-link backfill is already running. Links will appear as it finishes.");
        } else {
          toast.success("Started adding internal links to older articles. They'll update as it runs (a few minutes).");
        }
        setConfirmBackfill(false);
      },
      onError: () => toast.error("Couldn't start the internal-link backfill"),
    },
  });
  const [confirmSourceLinks, setConfirmSourceLinks] = useState(false);
  const backfillSourceLinks = useBackfillAllSourceLinks({
    mutation: {
      onSuccess: (res) => {
        if (res.alreadyRunning) {
          toast.info("A source-link backfill is already running. Links will appear as it finishes.");
        } else {
          toast.success("Started adding verified source links to older articles. They'll update as it runs (a few minutes).");
        }
        setConfirmSourceLinks(false);
      },
      onError: () => toast.error("Couldn't start the source-link backfill"),
    },
  });
  const [confirmRedistribute, setConfirmRedistribute] = useState(false);
  const redistributeSourceLinks = useRedistributeAllSourceLinks({
    mutation: {
      onSuccess: (res) => {
        if (res.alreadyRunning) {
          toast.info("A source-link job is already running. Wait for it to finish, then try again.");
        } else {
          toast.success("Started spreading citations across affected articles. They'll update as it runs (a few minutes).");
        }
        setConfirmRedistribute(false);
      },
      onError: () => toast.error("Couldn't start the citation redistribute"),
    },
  });
  // One-click synchronous sweep for search-engine links (Google Scholar /
  // results pages) left in older article bodies — the anchor phrase is kept,
  // only the link is removed. Returns exact counts, so the toast can confirm
  // a clean catalogue (updated=0) at a glance.
  const stripSearchLinks = useStripSearchLinks({
    mutation: {
      onSuccess: (res) => {
        toast.success(
          res.linksRemoved === 0
            ? `Scanned ${res.scanned} published articles — no search-engine links found`
            : `Removed ${res.linksRemoved} search link${res.linksRemoved === 1 ? "" : "s"} from ${res.updated} article${res.updated === 1 ? "" : "s"} (${res.scanned} scanned)`,
        );
      },
      onError: () => toast.error("Couldn't run the search-link sweep"),
    },
  });
  const [confirmShareImages, setConfirmShareImages] = useState(false);
  const backfillShareImages = useBackfillAllShareImages({
    mutation: {
      onSuccess: (res) => {
        if (res.alreadyRunning) {
          toast.info("A share-card backfill is already running. Cards will appear as it finishes.");
        } else {
          toast.success("Started adding branded share cards to older articles. They'll update as it runs (a few minutes).");
        }
        setConfirmShareImages(false);
      },
      onError: () => toast.error("Couldn't start the share-card backfill"),
    },
  });
  const [confirmRebuildShareImages, setConfirmRebuildShareImages] = useState(false);
  const rebuildShareImages = useRebuildAllShareImages({
    mutation: {
      onSuccess: (res) => {
        if (res.alreadyRunning) {
          toast.info("A share-card rebuild is already running. Cards will refresh as it finishes.");
        } else {
          toast.success("Started rebuilding every share card with the new branding. They'll refresh as it runs (a few minutes).");
        }
        setConfirmRebuildShareImages(false);
      },
      onError: () => toast.error("Couldn't start the share-card rebuild"),
    },
  });
  const [confirmBulkLabel, setConfirmBulkLabel] = useState(false);
  const [bulkLabelValue, setBulkLabelValue] = useState<BulkLabelArticlesInputEditorialLabelOverride>("analysis");
  const [bulkLabelCategorySlug, setBulkLabelCategorySlug] = useState<string>("all");
  const [bulkLabelStatus, setBulkLabelStatus] = useState<"published" | "all">("published");
  const bulkLabel = useBulkLabelArticles({
    mutation: {
      onSuccess: (res) => {
        toast.success(`Pinned "${EDITORIAL_LABEL_OPTIONS.find((o) => o.value === bulkLabelValue)?.label}" on ${res.updated} article${res.updated === 1 ? "" : "s"}`);
        setConfirmBulkLabel(false);
        invalidate();
      },
      onError: () => toast.error("Bulk label failed"),
    },
  });
  const bulkLabelCount = useMemo(() => {
    const items = allData?.items ?? [];
    return items.filter((a) => {
      if (bulkLabelStatus === "published" && a.status !== "published") return false;
      if (bulkLabelCategorySlug !== "all" && a.categorySlug !== bulkLabelCategorySlug) return false;
      return true;
    }).length;
  }, [allData, bulkLabelStatus, bulkLabelCategorySlug]);

  const checkSourceCoverage = useCheckArticleSourceCoverage({
    mutation: {
      onSuccess: (res) => {
        const parts: string[] = [];
        if (res.held > 0) parts.push(`${res.held} held`);
        if (res.cleared > 0) parts.push(`${res.cleared} holds cleared`);
        const detail = parts.length > 0 ? ` — ${parts.join(", ")}` : " — no changes";
        toast.success(`Source coverage check complete${detail}. Background repair running.`);
        invalidate();
      },
      onError: () => toast.error("Couldn't run source coverage check"),
    },
  });
  const [confirmRandomizeDates, setConfirmRandomizeDates] = useState(false);
  const randomizeDates = useRandomizeArticleDates({
    mutation: {
      onSuccess: (res) => {
        toast.success(
          res.updated === 0
            ? "No published articles to backdate"
            : `Backdated ${res.updated} article${res.updated === 1 ? "" : "s"} across the past ~18 months`,
        );
        setConfirmRandomizeDates(false);
        invalidate();
      },
      onError: () => toast.error("Couldn't randomize the article dates"),
    },
  });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [clearingOverrideId, setClearingOverrideId] = useState<string | null>(null);
  const [clearingHoldId, setClearingHoldId] = useState<string | null>(null);
  const updateArticle = useUpdateArticle();
  const handleClearHold = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (clearingHoldId === id) return;
    setClearingHoldId(id);
    try {
      await updateArticle.mutateAsync({ id, data: { holdReason: null } });
      toast.success("Hold cleared — article re-queued for auto-publish");
      invalidate();
    } catch {
      toast.error("Couldn't clear the hold");
    } finally {
      setClearingHoldId(null);
    }
  };
  const handleClearOverride = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (clearingOverrideId === id) return;
    setClearingOverrideId(id);
    try {
      await updateArticle.mutateAsync({ id, data: { editorialLabelOverride: null } });
      toast.success("Editorial label override cleared — auto-detect restored");
      invalidate();
    } catch {
      toast.error("Couldn't clear the override");
    } finally {
      setClearingOverrideId(null);
    }
  };
  // Hero-image regeneration can be fired from any row and several can run at
  // once (each takes ~10s server-side), so we track in-flight IDs in a Set
  // rather than a single pendingId.
  const [regenIds, setRegenIds] = useState<Set<string>>(new Set());
  const regenImage = useRegenerateArticleImage();
  // Use mutateAsync so each in-flight regeneration gets its own guaranteed
  // success/error/finally lifecycle — call-scoped mutate() callbacks on a single
  // shared mutation observer are unreliable when several run concurrently.
  const handleRegenImage = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (regenIds.has(id)) return;
    setRegenIds((prev) => new Set(prev).add(id));
    try {
      await regenImage.mutateAsync({ id });
      toast.success("New hero image ready");
      invalidate();
    } catch {
      toast.error("Image generation failed");
    } finally {
      setRegenIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const [, navigate] = useLocation();
  const createMeme = useCreateMemeForArticle();
  const handleCreateMeme = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (createMeme.isPending) return;
    setPendingId(id);
    try {
      const meme = await createMeme.mutateAsync({ id });
      navigate(`/admin/memes/${meme.id}`);
    } catch {
      toast.error("Could not start a meme for this article.");
    } finally {
      setPendingId(null);
    }
  };

  const handleSendToDraft = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setPendingId(id);
    unpublish.mutate({ id }, { onSettled: () => setPendingId(null) });
  };
  const handlePublish = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setPendingId(id);
    publish.mutate({ id }, { onSettled: () => setPendingId(null) });
  };
  const handleScheduleNow = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setPendingId(id);
    scheduleNow.mutate({ id }, { onSettled: () => setPendingId(null) });
  };
  const handleDelete = (e: React.MouseEvent, id: string, title: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
    setPendingId(id);
    remove.mutate({ id }, { onSettled: () => setPendingId(null) });
  };
  const handlePreview = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setPreviewId(id);
  };

  return (
    <div className="p-4 md:p-8 max-w-6xl">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-6">
        <div>
          <h1 className="font-serif text-3xl font-bold mb-1">Articles</h1>
          <p className="text-muted-foreground">Drafts, scheduled, and published.</p>
          {authorId && (
            <div className="mt-2 inline-flex items-center gap-2 rounded-full bg-primary/10 text-primary px-3 py-1 text-sm">
              <FileText className="h-3.5 w-3.5" />
              <span>
                By <strong>{filteredAuthor?.name ?? "this author"}</strong>
              </span>
              <Link href="/admin/articles" className="inline-flex items-center hover:opacity-80" aria-label="Clear author filter">
                <X className="h-3.5 w-3.5" />
              </Link>
            </div>
          )}
        </div>
        {!authorId && (
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          <Button
            type="button"
            variant="outline"
            className="text-sky-700 border-sky-600/40 hover:bg-sky-600/10 hover:text-sky-700"
            disabled={publishedCount === 0 || reindexAll.isPending}
            onClick={() => setConfirmReindex(true)}
            title="Resubmit every published article to search engines so they re-crawl and pick up the corrected SEO"
          >
            {reindexAll.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Search className="h-4 w-4 mr-2" />}
            Resubmit to search engines ({publishedCount})
          </Button>
          <Button
            type="button"
            variant="outline"
            className="text-indigo-700 border-indigo-600/40 hover:bg-indigo-600/10 hover:text-indigo-700"
            disabled={publishedCount === 0 || backfillLinks.isPending}
            onClick={() => setConfirmBackfill(true)}
            title="Add a few contextual internal links to older published articles that don't have any yet"
          >
            {backfillLinks.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Link2 className="h-4 w-4 mr-2" />}
            Add internal links to back catalog
          </Button>
          <Button
            type="button"
            variant="outline"
            className="text-teal-700 border-teal-600/40 hover:bg-teal-600/10 hover:text-teal-700"
            disabled={publishedCount === 0 || backfillSourceLinks.isPending}
            onClick={() => setConfirmSourceLinks(true)}
            title="Find and link a few verified external sources in older published articles that have none yet (never fabricates URLs, never rewords prose)"
          >
            {backfillSourceLinks.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <BookMarked className="h-4 w-4 mr-2" />}
            Add source links to back catalog
          </Button>
          <Button
            type="button"
            variant="outline"
            className="text-cyan-700 border-cyan-600/40 hover:bg-cyan-600/10 hover:text-cyan-700"
            disabled={publishedCount === 0 || redistributeSourceLinks.isPending}
            onClick={() => setConfirmRedistribute(true)}
            title="Find published articles whose citations are all bunched near the top and re-place the same links spread across the whole article (no new sources, prose never reworded)"
          >
            {redistributeSourceLinks.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Shuffle className="h-4 w-4 mr-2" />}
            Spread out front-loaded citations
          </Button>
          <Button
            type="button"
            variant="outline"
            className="text-rose-700 border-rose-600/40 hover:bg-rose-600/10 hover:text-rose-700"
            disabled={publishedCount === 0 || stripSearchLinks.isPending}
            onClick={() => stripSearchLinks.mutate()}
            title="Scan every published article and remove any Google Scholar / search-results-page links (the visible phrase is kept). Real source links and internal links are untouched. Safe to run anytime — reports exact counts."
          >
            {stripSearchLinks.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <X className="h-4 w-4 mr-2" />}
            Strip search-engine links
          </Button>
          <Button
            type="button"
            variant="outline"
            className="text-cyan-700 border-cyan-600/40 hover:bg-cyan-600/10 hover:text-cyan-700"
            disabled={checkSourceCoverage.isPending}
            onClick={() => checkSourceCoverage.mutate()}
            title="Re-run source-graph repair on packet-grounded articles, then hold any scheduled article with zero evidence sources (sets holdReason='no_evidence_sources') and clear the hold for articles that now have sources."
          >
            {checkSourceCoverage.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <DatabaseZap className="h-4 w-4 mr-2" />}
            Check source coverage
          </Button>
          <Button
            type="button"
            variant="outline"
            className="text-orange-700 border-orange-600/40 hover:bg-orange-600/10 hover:text-orange-700"
            disabled={publishedCount === 0 || backfillShareImages.isPending}
            onClick={() => setConfirmShareImages(true)}
            title="Add the branded BrainHook share card (wordmark + title overlay) to older published articles that don't have one yet, reusing their existing hero image"
          >
            {backfillShareImages.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Share2 className="h-4 w-4 mr-2" />}
            Add share cards to back catalog
          </Button>
          <Button
            type="button"
            variant="outline"
            className="text-orange-700 border-orange-600/40 hover:bg-orange-600/10 hover:text-orange-700"
            disabled={publishedCount === 0 || rebuildShareImages.isPending}
            onClick={() => setConfirmRebuildShareImages(true)}
            title="Rebuild the branded share card for EVERY published article (even ones that already have one) so the latest BrainHook logo and layout are applied across the whole back catalog. Reuses existing hero images."
          >
            {rebuildShareImages.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Share2 className="h-4 w-4 mr-2" />}
            Rebuild all share cards
          </Button>
          <Button
            type="button"
            variant="outline"
            className="text-fuchsia-700 border-fuchsia-600/40 hover:bg-fuchsia-600/10 hover:text-fuchsia-700"
            disabled={(allData?.items ?? []).length === 0 || bulkLabel.isPending}
            onClick={() => setConfirmBulkLabel(true)}
            title="Pin an editorial label (Analysis, Explainer, etc.) across a slice of the back catalog. Overwrites any existing label on matched articles."
          >
            {bulkLabel.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Tag className="h-4 w-4 mr-2" />}
            Bulk pin editorial labels
          </Button>
          <Button
            type="button"
            variant="outline"
            className="text-violet-700 border-violet-600/40 hover:bg-violet-600/10 hover:text-violet-700"
            disabled={publishedCount === 0 || randomizeDates.isPending}
            onClick={() => setConfirmRandomizeDates(true)}
            title="Backdate every published article so the archive looks like an organically-grown publication (~1–3 posts/week over the past ~18 months). Overwrites real publish dates."
          >
            {randomizeDates.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CalendarClock className="h-4 w-4 mr-2" />}
            Randomize publish dates
          </Button>
          <Button
            type="button"
            variant="outline"
            className="text-amber-700 border-amber-600/40 hover:bg-amber-600/10 hover:text-amber-700"
            disabled={draftCount === 0 || scheduleAllPending.isPending}
            onClick={() => setConfirmBulkSchedule(true)}
            title="Lock every draft into its scheduled slot now instead of waiting for the automatic 48-hour lock. Does not publish them early."
          >
            <CalendarClock className="h-4 w-4 mr-2" />
            Schedule all drafts ({draftCount})
          </Button>
          <Button
            type="button"
            variant="outline"
            className="text-emerald-700 border-emerald-600/40 hover:bg-emerald-600/10 hover:text-emerald-700"
            disabled={pendingCount === 0 || publishAllPending.isPending}
            onClick={() => setConfirmBulkPublish(true)}
          >
            <Rocket className="h-4 w-4 mr-2" />
            Publish all pending ({pendingCount})
          </Button>
          <Button
            type="button"
            variant="outline"
            className="text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
            disabled={pendingCount === 0 || deleteAllPending.isPending}
            onClick={() => setConfirmBulk(true)}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete all pending ({pendingCount})
          </Button>
        </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        {ALL_TABS.map((s) => {
          const isHeld = s === "held";
          const active = status === s;
          const activeClass = isHeld
            ? "bg-amber-600 text-white"
            : "bg-primary text-primary-foreground";
          const inactiveClass = isHeld
            ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
            : "bg-muted text-muted-foreground hover:bg-muted/80";
          const label = isHeld ? "Needs attention" : s;
          return (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-3 py-1.5 rounded-full text-sm capitalize ${active ? activeClass : inactiveClass}`}
            >
              {label} ({articleCount(s)})
            </button>
          );
        })}
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mb-3">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            type="search"
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            placeholder="Search by title, dek, or category…"
            aria-label="Search articles"
            className="w-full h-9 rounded-md border border-input bg-transparent pl-9 pr-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          aria-label="Filter by beat / category"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:w-64"
        >
          <option value="all">All beats &amp; categories</option>
          {categoryOptions.map((c) => (
            <option key={c.slug} value={c.slug}>{c.label}</option>
          ))}
        </select>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          aria-label="Sort articles"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:w-52"
        >
          <option value="newest">Newest first (created)</option>
          <option value="oldest">Oldest first (created)</option>
          <option value="views-desc">Most views</option>
          <option value="views-asc">Fewest views</option>
          <option value="memes-desc">Most memes</option>
          <option value="memes-asc">Fewest memes</option>
        </select>
        {(rawQuery || categoryFilter !== "all") && (
          <Button
            type="button"
            variant="ghost"
            className="h-9 text-muted-foreground"
            onClick={() => { setRawQuery(""); setQuery(""); setCategoryFilter("all"); }}
          >
            <X className="h-4 w-4 mr-1" /> Clear
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground mb-6 flex items-center gap-1.5">
        <Share2 className="h-3.5 w-3.5 text-orange-600" />
        <span><strong className="text-foreground">{withCardCount}</strong> with a share card{missingCardCount > 0 && <> · <strong className="text-foreground">{missingCardCount}</strong> without</>}. Use “Add share cards to back catalog” to fill the gaps.</span>
      </p>

      <AlertDialog open={confirmBulk} onOpenChange={(open) => !deleteAllPending.isPending && setConfirmBulk(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all pending articles?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes <strong>{pendingCount}</strong> pending article{pendingCount === 1 ? "" : "s"} (all drafts and scheduled-but-unpublished articles). Published articles are not affected. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteAllPending.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteAllPending.isPending}
              onClick={(e) => { e.preventDefault(); deleteAllPending.mutate(); }}
            >
              {deleteAllPending.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete {pendingCount} article{pendingCount === 1 ? "" : "s"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmBulkPublish} onOpenChange={(open) => !publishAllPending.isPending && setConfirmBulkPublish(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish all pending articles?</AlertDialogTitle>
            <AlertDialogDescription>
              This immediately publishes <strong>{pendingCount}</strong> pending article{pendingCount === 1 ? "" : "s"} (all drafts and scheduled-but-unpublished articles). They will go live on the site right away.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={publishAllPending.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-emerald-600 text-white hover:bg-emerald-600/90"
              disabled={publishAllPending.isPending}
              onClick={(e) => { e.preventDefault(); publishAllPending.mutate(); }}
            >
              {publishAllPending.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Publish {pendingCount} article{pendingCount === 1 ? "" : "s"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmBulkSchedule} onOpenChange={(open) => !scheduleAllPending.isPending && setConfirmBulkSchedule(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Schedule all drafts now?</AlertDialogTitle>
            <AlertDialogDescription>
              This locks all <strong>{draftCount}</strong> draft{draftCount === 1 ? "" : "s"} into their scheduled slots right away, instead of waiting up to 48 hours for the automatic lock. Each draft keeps (or is assigned) a future slot in the rotating schedule — nothing is published early, and they go live at their scheduled times. Already-scheduled and published articles are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={scheduleAllPending.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 text-white hover:bg-amber-600/90"
              disabled={scheduleAllPending.isPending}
              onClick={(e) => { e.preventDefault(); scheduleAllPending.mutate(); }}
            >
              {scheduleAllPending.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Schedule {draftCount} draft{draftCount === 1 ? "" : "s"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmBackfill} onOpenChange={(open) => !backfillLinks.isPending && setConfirmBackfill(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Add internal links to the back catalog?</AlertDialogTitle>
            <AlertDialogDescription>
              This weaves a few contextual links to other articles into every published article that doesn't have any yet — the SEO and "one click becomes three" boost the newer articles already get. It runs in the background and can take a few minutes; links appear as it works. Each article keeps a saved copy of its pre-link version, so you can undo any article individually from its editor.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={backfillLinks.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-indigo-600 text-white hover:bg-indigo-600/90"
              disabled={backfillLinks.isPending}
              onClick={(e) => { e.preventDefault(); backfillLinks.mutate(); }}
            >
              {backfillLinks.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Start adding links
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmSourceLinks} onOpenChange={(open) => !backfillSourceLinks.isPending && setConfirmSourceLinks(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Add source links to the back catalog?</AlertDialogTitle>
            <AlertDialogDescription>
              This finds and links a few verified external sources for claims in every published article that doesn't have any yet — boosting credibility and SEO. The AI only links a source when it can confirm the page exists; it never invents URLs, never cites bare search pages, and never rewords your prose (links are woven into existing phrases only). It runs in the background and can take several minutes; links appear as it works. Each article keeps a saved copy of its pre-link version, so you can undo any article individually from its editor.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={backfillSourceLinks.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-teal-600 text-white hover:bg-teal-600/90"
              disabled={backfillSourceLinks.isPending}
              onClick={(e) => { e.preventDefault(); backfillSourceLinks.mutate(); }}
            >
              {backfillSourceLinks.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Start adding sources
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRedistribute} onOpenChange={(open) => !redistributeSourceLinks.isPending && setConfirmRedistribute(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Spread out front-loaded citations?</AlertDialogTitle>
            <AlertDialogDescription>
              This finds published articles whose source links are all bunched into the opening paragraphs and re-places the same links spread across the whole article, so claims deeper in the piece carry their citations too. No new sources are added, no web searches run, and your prose is never reworded — links are only woven into existing phrases. An article is only changed when every one of its sources ends up linked again (a source cited twice is collapsed to one link); otherwise it's left exactly as is. It runs in the background over a few minutes, and each changed article keeps a saved pre-change copy you can restore from its editor.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={redistributeSourceLinks.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-cyan-600 text-white hover:bg-cyan-600/90"
              disabled={redistributeSourceLinks.isPending}
              onClick={(e) => { e.preventDefault(); redistributeSourceLinks.mutate(); }}
            >
              {redistributeSourceLinks.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Start redistributing
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmShareImages} onOpenChange={(open) => !backfillShareImages.isPending && setConfirmShareImages(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Add share cards to the back catalog?</AlertDialogTitle>
            <AlertDialogDescription>
              This adds the branded BrainHook share card — the orange wordmark and headline overlay — to every published article that doesn't have one yet, so links shared on social media show the branded image instead of the plain hero. It reuses each article's existing hero image (no new AI images), runs in the background, and can take a few minutes; cards appear as it works. Note: social platforms cache preview images, so already-shared links may need re-scraping (e.g. with Facebook's or LinkedIn's post inspector) to refresh.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={backfillShareImages.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-orange-600 text-white hover:bg-orange-600/90"
              disabled={backfillShareImages.isPending}
              onClick={(e) => { e.preventDefault(); backfillShareImages.mutate(); }}
            >
              {backfillShareImages.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Start adding share cards
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRebuildShareImages} onOpenChange={(open) => !rebuildShareImages.isPending && setConfirmRebuildShareImages(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebuild all share cards?</AlertDialogTitle>
            <AlertDialogDescription>
              This re-creates the branded share card for <strong>every</strong> published article — including the <strong>{withCardCount}</strong> that already have one — so the current BrainHook logo and layout are applied across the whole back catalog. It reuses each article's existing hero image (no new AI images), runs in the background, and can take a few minutes; cards refresh as it works. Note: social platforms cache preview images, so already-shared links may need re-scraping (e.g. with Facebook's or LinkedIn's post inspector) to refresh.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rebuildShareImages.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-orange-600 text-white hover:bg-orange-600/90"
              disabled={rebuildShareImages.isPending}
              onClick={(e) => { e.preventDefault(); rebuildShareImages.mutate(); }}
            >
              {rebuildShareImages.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Rebuild all share cards
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRandomizeDates} onOpenChange={(open) => !randomizeDates.isPending && setConfirmRandomizeDates(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Randomize all publish dates?</AlertDialogTitle>
            <AlertDialogDescription>
              This rewrites the publish date of all <strong>{publishedCount}</strong> published article{publishedCount === 1 ? "" : "s"}, spreading them out across the past ~18 months at roughly 1–3 posts per week so the archive looks like an organically-grown publication. Their original order is preserved (oldest stays oldest). <strong>This overwrites the real publish dates and can't be undone.</strong> Drafts and scheduled posts are not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={randomizeDates.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-violet-600 text-white hover:bg-violet-600/90"
              disabled={randomizeDates.isPending}
              onClick={(e) => { e.preventDefault(); randomizeDates.mutate(); }}
            >
              {randomizeDates.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Randomize dates
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmReindex} onOpenChange={(open) => !reindexAll.isPending && setConfirmReindex(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Resubmit all published articles to search engines?</AlertDialogTitle>
            <AlertDialogDescription>
              This pings search engines (via IndexNow) for all <strong>{publishedCount}</strong> published article{publishedCount === 1 ? "" : "s"}, plus the homepage, every category page, and the sitemap, asking them to re-crawl. Each page already serves its correct, up-to-date SEO automatically — this just nudges crawlers to revisit the existing backlog sooner. Note: IndexNow covers Bing and partners; for Google, also resubmit your sitemap in Search Console.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reindexAll.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-sky-600 text-white hover:bg-sky-600/90"
              disabled={reindexAll.isPending}
              onClick={(e) => { e.preventDefault(); reindexAll.mutate(); }}
            >
              {reindexAll.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Resubmit {publishedCount} article{publishedCount === 1 ? "" : "s"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={confirmBulkLabel} onOpenChange={(open) => { if (!bulkLabel.isPending) setConfirmBulkLabel(open); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Bulk pin editorial label</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Editorial label</label>
              <select
                value={bulkLabelValue as string}
                onChange={(e) => setBulkLabelValue(e.target.value as BulkLabelArticlesInputEditorialLabelOverride)}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {EDITORIAL_LABEL_OPTIONS.map((o) => (
                  <option key={o.value as string} value={o.value as string}>{o.label}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                {EDITORIAL_LABEL_OPTIONS.find((o) => o.value === bulkLabelValue)?.description}
              </p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Status filter</label>
              <select
                value={bulkLabelStatus}
                onChange={(e) => setBulkLabelStatus(e.target.value as "published" | "all")}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="published">Published only</option>
                <option value="all">All statuses</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Beat / category filter</label>
              <select
                value={bulkLabelCategorySlug}
                onChange={(e) => setBulkLabelCategorySlug(e.target.value)}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="all">All beats</option>
                {categoryOptions.map((c) => (
                  <option key={c.slug} value={c.slug}>{c.label}</option>
                ))}
              </select>
            </div>
            <p className="text-sm text-muted-foreground">
              This will overwrite the editorial label on <strong>{bulkLabelCount}</strong> article{bulkLabelCount === 1 ? "" : "s"}. Existing labels on matched articles are replaced.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmBulkLabel(false)} disabled={bulkLabel.isPending}>Cancel</Button>
            <Button
              className="bg-fuchsia-600 text-white hover:bg-fuchsia-600/90"
              disabled={bulkLabel.isPending || bulkLabelCount === 0}
              onClick={() => bulkLabel.mutate({
                data: {
                  editorialLabelOverride: bulkLabelValue,
                  ...(bulkLabelCategorySlug !== "all" ? { categorySlug: bulkLabelCategorySlug } : {}),
                  ...(bulkLabelStatus !== "all" ? { status: bulkLabelStatus } : {}),
                },
              })}
            >
              {bulkLabel.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Pin label on {bulkLabelCount} article{bulkLabelCount === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isLoading ? (
        <Loader2 className="animate-spin" />
      ) : (
        <div className="space-y-2">
          {displayed.map((a) => {
            const author = authorMap.get(a.authorId);
            return (
              <Link key={a.id} href={`/admin/articles/${a.id}`}>
                <Card className="p-3 sm:p-4 hover:border-primary cursor-pointer flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
                  <div className="flex items-start gap-3 sm:gap-4 min-w-0 flex-1">
                    <img src={withImageParams(resolveImage(a.heroImage), 200)} onError={handleImageError} alt="" className="h-14 w-20 sm:h-16 sm:w-24 object-cover rounded shrink-0 bg-muted" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${a.status === "published" ? "bg-emerald-100 text-emerald-700" : a.status === "scheduled" ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground"}`}>{a.status}</span>
                        {a.quarantinedAt && (
                          <span
                            className="text-xs px-2 py-0.5 rounded-full bg-rose-200 text-rose-900 font-medium"
                            title="Evidence check flagged this draft — it is hidden from the public site. Publishing it (or clearing quarantine in the editor) makes it live."
                          >
                            Quarantined — hidden
                          </span>
                        )}
                        {a.holdReason === "no_evidence_sources" && (
                          <span
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium border border-amber-300"
                            title="Auto-publish is held: this packet-grounded article has no evidence sources in article_sources. Click ✕ to clear the hold and re-queue for auto-publish, or add sources first."
                          >
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            Held — no sources
                            <button
                              type="button"
                              aria-label="Clear auto-publish hold"
                              disabled={clearingHoldId === a.id}
                              onClick={(e) => handleClearHold(e, a.id)}
                              className="ml-0.5 rounded-full hover:bg-amber-200 p-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {clearingHoldId === a.id ? (
                                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                              ) : (
                                <X className="h-2.5 w-2.5" />
                              )}
                            </button>
                          </span>
                        )}
                        <span
                          className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${a.shareImage ? "bg-orange-100 text-orange-700" : "bg-muted text-muted-foreground/70"}`}
                          title={a.shareImage ? "This article has a branded share card" : "No share card yet — falls back to the hero image when shared"}
                        >
                          <Share2 className="h-3 w-3" />
                          {a.shareImage ? "Card" : "No card"}
                        </span>
                        {/* Sources badge: warn for any non-explainer article with zero
                            evidence sources (including non-packet), not just packet-grounded.
                            Explainer articles have no sources by design. Draft articles
                            haven't been harvested yet so we skip zero-source warnings there. */}
                        {(() => {
                          const srcCount = a.evidenceSourceCount ?? 0;
                          const isExplicit = a.editorialLabelOverride === "explainer";
                          const isWarn = srcCount === 0 && !isExplicit && a.status !== "draft";
                          if (srcCount === 0 && (isExplicit || a.status === "draft")) return null;
                          return (
                            <span
                              className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${isWarn ? "bg-amber-50 text-amber-700 border border-amber-300" : "bg-teal-50 text-teal-700"}`}
                              title={isWarn
                                ? `Evidence sources: 0.${a.evidencePacketId ? " Packet-grounded — auto-publish held until sources are woven in." : " No evidence-role sources recorded for this article."}`
                                : `Evidence sources in article graph: ${srcCount}${a.evidencePacketId ? " (packet-grounded)" : ""}`}
                            >
                              {isWarn ? <AlertTriangle className="h-3 w-3 shrink-0" /> : <DatabaseZap className="h-3 w-3 shrink-0" />}
                              {srcCount} src{srcCount !== 1 ? "s" : ""}
                            </span>
                          );
                        })()}
                        {(a.intermediaryCitationCount ?? 0) > 0 && (
                          <span
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-orange-50 text-orange-700 border border-orange-300"
                            title={`${a.intermediaryCitationCount} aggregator citation${a.intermediaryCitationCount === 1 ? "" : "s"} suppressed from the public References list (SciSpace, ResearchGate, Semantic Scholar). Replace with the original journal URL to restore visibility.`}
                          >
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            {a.intermediaryCitationCount} hidden
                          </span>
                        )}
                        {(a.memeCount ?? 0) > 0 && (
                          <span
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-900 text-white"
                            title={`${a.memeCount} meme${a.memeCount === 1 ? "" : "s"} made from this article`}
                          >
                            <Laugh className="h-3 w-3" />
                            x{a.memeCount}
                          </span>
                        )}
                        {a.status === "published" && (
                          <span
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-600 text-white"
                            title={`${(a.viewCount ?? 0).toLocaleString()} all-time page view${a.viewCount === 1 ? "" : "s"}`}
                          >
                            <Eye className="h-3 w-3" />
                            {(a.viewCount ?? 0).toLocaleString()}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">{a.category}</span>
                        {a.secondaryBeats?.map((s) => (
                          <span
                            key={s}
                            className="text-xs px-2 py-0.5 rounded-full bg-violet-100 text-violet-700"
                            title="Cross-sectional secondary subject (admin-only — not shown to readers)"
                          >
                            + {beatName(s)}
                          </span>
                        ))}
                        {a.editorialLabelOverride && (
                          <span
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-fuchsia-100 text-fuchsia-800 font-medium border border-fuchsia-300"
                            title={`Manual editorial label override: "${EDITORIAL_LABEL_OPTIONS.find((o) => o.value === a.editorialLabelOverride)?.label ?? a.editorialLabelOverride}". Click ✕ to clear and restore auto-detection.`}
                          >
                            <Tag className="h-3 w-3 shrink-0" />
                            {EDITORIAL_LABEL_OPTIONS.find((o) => o.value === a.editorialLabelOverride)?.label ?? a.editorialLabelOverride}
                            <button
                              type="button"
                              aria-label="Clear editorial label override"
                              disabled={clearingOverrideId === a.id}
                              onClick={(e) => handleClearOverride(e, a.id)}
                              className="ml-0.5 rounded-full hover:bg-fuchsia-200 p-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {clearingOverrideId === a.id ? (
                                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                              ) : (
                                <X className="h-2.5 w-2.5" />
                              )}
                            </button>
                          </span>
                        )}
                      </div>
                      <h3 className="font-serif font-bold mt-1 line-clamp-2 sm:truncate">{a.title}</h3>
                      <p className="text-sm text-muted-foreground line-clamp-1">{a.dek}</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 w-full sm:w-auto">
                  <div className="text-left sm:text-right text-xs text-muted-foreground shrink-0">
                    <div>{author?.name}</div>
                    <div>{a.publishedAt ? `Published ${format(new Date(a.publishedAt), "MMM d")}` : a.scheduledFor ? `Scheduled ${format(new Date(a.scheduledFor), "MMM d, h:mm a")}` : `Updated ${format(new Date(a.updatedAt), "MMM d")}`}</div>
                  </div>
                  <div className="flex items-center gap-0.5 sm:gap-1 shrink-0 flex-wrap justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="Copy public article link"
                      onClick={(e) => handleCopyLink(e, a.slug, a.id)}
                    >
                      {copiedId === a.id ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="Preview article"
                      onClick={(e) => handlePreview(e, a.id)}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="Regenerate hero image with AI"
                      disabled={regenIds.has(a.id)}
                      onClick={(e) => handleRegenImage(e, a.id)}
                    >
                      {regenIds.has(a.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="Create a social meme from this article"
                      disabled={pendingId === a.id}
                      onClick={(e) => handleCreateMeme(e, a.id)}
                      className="text-violet-700 hover:text-violet-700 hover:bg-violet-600/10"
                    >
                      {pendingId === a.id && createMeme.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Laugh className="h-4 w-4" />}
                    </Button>
                    {a.status === "draft" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title="Schedule now (lock into its slot without waiting for the 48h auto-lock)"
                        disabled={pendingId === a.id}
                        onClick={(e) => handleScheduleNow(e, a.id)}
                        className="text-amber-700 hover:text-amber-700 hover:bg-amber-600/10"
                      >
                        {pendingId === a.id && scheduleNow.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarClock className="h-4 w-4" />}
                      </Button>
                    )}
                    {a.status !== "published" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title="Publish now"
                        disabled={pendingId === a.id}
                        onClick={(e) => handlePublish(e, a.id)}
                        className="text-emerald-700 hover:text-emerald-700 hover:bg-emerald-600/10"
                      >
                        {pendingId === a.id && publish.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      </Button>
                    )}
                    {a.status !== "draft" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title="Send back to draft"
                        disabled={pendingId === a.id}
                        onClick={(e) => handleSendToDraft(e, a.id)}
                      >
                        {pendingId === a.id && unpublish.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="Delete article"
                      disabled={pendingId === a.id}
                      onClick={(e) => handleDelete(e, a.id, a.title)}
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    >
                      {pendingId === a.id && remove.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </Button>
                  </div>
                  </div>
                </Card>
              </Link>
            );
          })}
          {displayed.length === 0 && (
            <p className="text-muted-foreground text-sm">
              {query || categoryFilter !== "all" ? "No articles match these filters." : "No articles in this view."}
            </p>
          )}
        </div>
      )}

      <Sheet open={previewId !== null} onOpenChange={(open) => !open && setPreviewId(null)}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-2xl overflow-y-auto p-0"
        >
          {previewId && <ArticlePreview id={previewId} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ArticlePreview({ id }: { id: string }) {
  const { data: article, isLoading } = useGetArticle(id);
  if (isLoading || !article) {
    return (
      <div className="p-4 md:p-8 flex items-center justify-center h-full">
        <Loader2 className="animate-spin text-muted-foreground" />
      </div>
    );
  }
  const heroSrc = article.heroImage
    ? withImageParams(resolveImage(article.heroImage), 800)
    : "";
  return (
    <div className="flex flex-col h-full">
      <SheetHeader className="px-6 pt-6 pb-3 border-b sticky top-0 bg-background z-10">
        <div className="flex items-center gap-2 text-xs">
          <span
            className={`px-2 py-0.5 rounded-full ${
              article.status === "published"
                ? "bg-emerald-100 text-emerald-700"
                : article.status === "scheduled"
                ? "bg-amber-100 text-amber-700"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {article.status}
          </span>
          <span className="text-muted-foreground uppercase tracking-wider">{article.category}</span>
          <span className="text-muted-foreground ml-auto">{article.readingTimeMinutes} min read</span>
        </div>
        <SheetTitle className="font-serif text-2xl text-left leading-tight">{article.title}</SheetTitle>
        <p className="text-sm text-muted-foreground text-left">{article.dek}</p>
        <div className="flex items-center gap-2 pt-2">
          <Link href={`/admin/articles/${article.id}`}>
            <Button size="sm" variant="outline">
              <FileEdit className="h-4 w-4 mr-2" /> Open editor
            </Button>
          </Link>
          {article.status === "published" && (
            <a
              href={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/article/${article.slug}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button size="sm" variant="ghost">
                <ExternalLink className="h-4 w-4 mr-2" /> View live
              </Button>
            </a>
          )}
        </div>
      </SheetHeader>

      <div className="flex-1 px-6 py-6 space-y-4">
        {heroSrc && (
          <img
            src={heroSrc}
            onError={handleImageError}
            alt=""
            className="w-full aspect-[16/9] object-cover rounded-lg bg-muted"
          />
        )}
        <div className="prose prose-sm dark:prose-invert prose-p:font-body prose-headings:font-serif max-w-none">
          {article.body.map((block, i) => {
            if (block.type === "paragraph") return <p key={i}>{block.content}</p>;
            if (block.type === "heading")
              return (
                <h2
                  key={i}
                  className="!font-serif !font-bold !text-xl !mt-8 !mb-3 !pt-3 !border-t !border-primary/30"
                >
                  {block.content}
                </h2>
              );
            if (block.type === "pullquote")
              return (
                <blockquote
                  key={i}
                  className="font-serif italic text-lg text-primary border-l-4 border-primary pl-4 my-6"
                >
                  "{block.content}"
                </blockquote>
              );
            if (block.type === "image") {
              const src = block.content?.startsWith("/")
                ? `${import.meta.env.BASE_URL.replace(/\/$/, "")}${block.content}`
                : block.content;
              return (
                <figure key={i} className="my-6">
                  <img src={src} alt="" className="rounded-lg w-full" />
                </figure>
              );
            }
            return null;
          })}
        </div>
      </div>
    </div>
  );
}
