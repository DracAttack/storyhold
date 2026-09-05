import {
  useListArticles,
  getListArticlesQueryKey,
  useGetShareImageJobStatus,
  getGetShareImageJobStatusQueryKey,
  useBackfillAllShareImages,
  useRebuildAllShareImages,
  useDeleteAllShareImages,
  useCancelShareImageJob,
  useGetSocialPackJobStatus,
  getGetSocialPackJobStatusQueryKey,
  useBackfillAllSocialPacks,
  useRebuildAllSocialPacks,
  useCancelSocialPackJob,
  useUpdateArticle,
  useRegenerateArticleHooks,
  type Article,
  type SocialPack,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import {
  Loader2,
  ImageIcon,
  RefreshCw,
  Plus,
  Trash2,
  OctagonX,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Save,
  Sparkles,
} from "lucide-react";
import { handleImageError, resolveImage, withImageParams } from "@/lib/heroImage";
import { toast } from "sonner";

type Filter = "all" | "has" | "missing";
type Subject = "cards" | "packs";

const hasText = (s?: string | null) => !!s && s.trim() !== "";
const hasPack = (p?: SocialPack | null) => !!p && hasText(p.twitter);

export default function ShareCards() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [subject, setSubject] = useState<Subject>("cards");
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRebuildPacks, setConfirmRebuildPacks] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const articlesQuery = useListArticles({ status: "published" });
  const articles = articlesQuery.data?.items ?? [];

  // ---- Share-image job (existing) ----
  const statusQuery = useGetShareImageJobStatus({
    query: {
      queryKey: getGetShareImageJobStatusQueryKey(),
      refetchInterval: (query) => (query.state.data?.running ? 1500 : false),
    },
  });
  const status = statusQuery.data;
  const running = status?.running ?? false;

  // ---- Social-pack job (new) ----
  const packStatusQuery = useGetSocialPackJobStatus({
    query: {
      queryKey: getGetSocialPackJobStatusQueryKey(),
      refetchInterval: (query) => (query.state.data?.running ? 1500 : false),
    },
  });
  const packStatus = packStatusQuery.data;
  const packRunning = packStatus?.running ?? false;

  const wasRunning = useRef(false);
  const wasPackRunning = useRef(false);
  useEffect(() => {
    if ((wasRunning.current && !running) || (wasPackRunning.current && !packRunning)) {
      qc.invalidateQueries({ queryKey: getListArticlesQueryKey({ status: "published" }) });
    }
    wasRunning.current = running;
    wasPackRunning.current = packRunning;
  }, [running, packRunning, qc]);

  const refetchStatus = () => statusQuery.refetch();
  const refetchPackStatus = () => packStatusQuery.refetch();

  const backfill = useBackfillAllShareImages({
    mutation: {
      onSuccess: (res) => {
        if (res.alreadyRunning) toast.info("A share-card job is already running.");
        else toast.success("Adding missing share cards — progress below.");
        refetchStatus();
      },
      onError: () => toast.error("Couldn't start the backfill"),
    },
  });

  const rebuild = useRebuildAllShareImages({
    mutation: {
      onSuccess: (res) => {
        if (res.alreadyRunning) toast.info("A share-card job is already running.");
        else toast.success("Rebuilding every share card — progress below.");
        refetchStatus();
      },
      onError: () => toast.error("Couldn't start the rebuild"),
    },
  });

  const cancelJob = useCancelShareImageJob({
    mutation: {
      onSuccess: (res) => {
        if (res.canceled) toast.success("Halting — the current card will finish, then it stops.");
        else toast.info("No job is running.");
        refetchStatus();
      },
      onError: () => toast.error("Couldn't halt the job"),
    },
  });

  const deleteAll = useDeleteAllShareImages({
    mutation: {
      onSuccess: (res) => {
        toast.success(`Deleted ${res.deleted} share card${res.deleted === 1 ? "" : "s"}.`);
        qc.invalidateQueries({ queryKey: getListArticlesQueryKey({ status: "published" }) });
      },
      onError: () => toast.error("Couldn't delete share cards (a job may be running)."),
    },
  });

  const backfillPacks = useBackfillAllSocialPacks({
    mutation: {
      onSuccess: (res) => {
        if (res.alreadyRunning) toast.info("A social-pack job is already running.");
        else toast.success("Generating missing social packs — progress below.");
        refetchPackStatus();
      },
      onError: () => toast.error("Couldn't start the social-pack backfill"),
    },
  });

  const rebuildPacks = useRebuildAllSocialPacks({
    mutation: {
      onSuccess: (res) => {
        if (res.alreadyRunning) toast.info("A social-pack job is already running.");
        else toast.success("Regenerating every social pack — progress below.");
        refetchPackStatus();
      },
      onError: () => toast.error("Couldn't start the social-pack rebuild"),
    },
  });

  const cancelPackJob = useCancelSocialPackJob({
    mutation: {
      onSuccess: (res) => {
        if (res.canceled) toast.success("Halting — the current pack will finish, then it stops.");
        else toast.info("No social-pack job is running.");
        refetchPackStatus();
      },
      onError: () => toast.error("Couldn't halt the social-pack job"),
    },
  });

  const hasCard = (src?: string | null) => hasText(src);
  const total = articles.length;
  const withCard = articles.filter((a) => hasCard(a.shareImage)).length;
  const withoutCard = total - withCard;
  const withPack = articles.filter((a) => hasPack(a.socialPack)).length;
  const withoutPack = total - withPack;

  const has = (a: Article) => (subject === "cards" ? hasCard(a.shareImage) : hasPack(a.socialPack));
  const subjectWith = subject === "cards" ? withCard : withPack;
  const subjectWithout = subject === "cards" ? withoutCard : withoutPack;

  const visible = articles.filter((a) => {
    if (filter === "has") return has(a);
    if (filter === "missing") return !has(a);
    return true;
  });

  const pct = status && status.total > 0 ? Math.round((status.processed / status.total) * 100) : 0;
  const packPct =
    packStatus && packStatus.total > 0 ? Math.round((packStatus.processed / packStatus.total) * 100) : 0;
  const busy = backfill.isPending || rebuild.isPending;
  const packBusy = backfillPacks.isPending || rebuildPacks.isPending;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-bold">Share cards &amp; social packs</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Branded social images and ready-to-post copy for published articles.{" "}
            <span className="font-medium text-foreground">{withCard}</span> have a card,{" "}
            <span className="font-medium text-foreground">{withPack}</span> have a social pack.
          </p>
        </div>
      </div>

      {/* Share-card actions */}
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-medium">
            Share cards
            <span className="text-muted-foreground font-normal">
              {" "}
              — {withCard} present, {withoutCard} missing
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => backfill.mutate()} disabled={running || busy}>
              {backfill.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
              Add missing
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirmRebuild(true)} disabled={running || busy}>
              {rebuild.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Rebuild all
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
            ) : (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setConfirmDelete(true)}
                disabled={withCard === 0 || deleteAll.isPending}
              >
                {deleteAll.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 mr-2" />
                )}
                Delete all
              </Button>
            )}
          </div>
        </div>
        {(running || (status && status.finishedAt && status.processed > 0)) && status ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">
                {running
                  ? `${status.mode === "rebuild" ? "Rebuilding" : "Adding"} share cards…`
                  : status.canceled
                    ? "Job halted"
                    : "Last run complete"}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {status.processed} / {status.total}
              </span>
            </div>
            <Progress value={running ? pct : status.canceled ? pct : 100} />
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>Updated {status.updated}</span>
              <span>Skipped {status.skipped}</span>
              {status.failed > 0 ? <span className="text-destructive">Failed {status.failed}</span> : null}
              {status.canceled ? <span>Canceled</span> : null}
            </div>
          </div>
        ) : null}
      </Card>

      {/* Social-pack actions */}
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm font-medium">
            Social packs
            <span className="text-muted-foreground font-normal">
              {" "}
              — {withPack} present, {withoutPack} missing
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => backfillPacks.mutate()}
              disabled={packRunning || packBusy}
            >
              {backfillPacks.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              Add missing
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmRebuildPacks(true)}
              disabled={packRunning || packBusy}
            >
              {rebuildPacks.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Rebuild all
            </Button>
            {packRunning ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => cancelPackJob.mutate()}
                disabled={cancelPackJob.isPending || packStatus?.canceled}
              >
                {cancelPackJob.isPending || packStatus?.canceled ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <OctagonX className="h-4 w-4 mr-2" />
                )}
                {packStatus?.canceled ? "Halting…" : "Halt"}
              </Button>
            ) : null}
          </div>
        </div>
        {(packRunning || (packStatus && packStatus.finishedAt && packStatus.processed > 0)) && packStatus ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">
                {packRunning
                  ? `${packStatus.mode === "rebuild" ? "Regenerating" : "Generating"} social packs…`
                  : packStatus.canceled
                    ? "Job halted"
                    : "Last run complete"}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {packStatus.processed} / {packStatus.total}
              </span>
            </div>
            <Progress value={packRunning ? packPct : packStatus.canceled ? packPct : 100} />
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>Updated {packStatus.updated}</span>
              <span>Skipped {packStatus.skipped}</span>
              {packStatus.failed > 0 ? <span className="text-destructive">Failed {packStatus.failed}</span> : null}
              {packStatus.canceled ? <span>Canceled</span> : null}
            </div>
          </div>
        ) : null}
      </Card>

      {/* Filter controls */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex gap-2">
          {(["cards", "packs"] as Subject[]).map((s) => (
            <Button
              key={s}
              variant={subject === s ? "default" : "outline"}
              size="sm"
              onClick={() => setSubject(s)}
            >
              {s === "cards" ? "By card" : "By social pack"}
            </Button>
          ))}
        </div>
        <div className="flex gap-2">
          {(["all", "has", "missing"] as Filter[]).map((f) => (
            <Button
              key={f}
              variant={filter === f ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter(f)}
            >
              {f === "all"
                ? `All (${total})`
                : f === "has"
                  ? `Has ${subject === "cards" ? "card" : "pack"} (${subjectWith})`
                  : `Missing (${subjectWithout})`}
            </Button>
          ))}
        </div>
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
            const present = hasCard(a.shareImage);
            const packPresent = hasPack(a.socialPack);
            const isOpen = expanded === a.id;
            return (
              <Card key={a.id} className="overflow-hidden flex flex-col">
                <div className="flex gap-3 p-3">
                  <div className="relative w-40 shrink-0 aspect-[1200/630] bg-muted rounded overflow-hidden">
                    {present ? (
                      <img
                        src={withImageParams(resolveImage(a.shareImage as string), 400)}
                        onError={handleImageError}
                        alt=""
                        loading="lazy"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground gap-1">
                        <ImageIcon className="h-6 w-6" />
                        <span className="text-[10px]">No card</span>
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0 flex flex-col">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium line-clamp-2" title={a.title}>
                        {a.title}
                      </p>
                      <Link
                        href={`/admin/articles/${a.id}`}
                        className="text-muted-foreground hover:text-foreground shrink-0"
                        title="Edit article"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </Link>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          present ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"
                        }`}
                      >
                        {present ? "Has card" : "No card"}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          packPresent ? "bg-emerald-600 text-white" : "bg-amber-500 text-white"
                        }`}
                      >
                        {packPresent ? "Has pack" : "No pack"}
                      </span>
                    </div>
                    <div className="mt-auto pt-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => setExpanded(isOpen ? null : a.id)}
                      >
                        {isOpen ? <ChevronUp className="h-3.5 w-3.5 mr-1" /> : <ChevronDown className="h-3.5 w-3.5 mr-1" />}
                        {isOpen ? "Hide social pack" : packPresent ? "Quick-edit social pack" : "Add social pack"}
                      </Button>
                    </div>
                  </div>
                </div>
                {isOpen ? <SocialPackPanel article={a} /> : null}
              </Card>
            );
          })}
        </div>
      )}

      <AlertDialog open={confirmRebuild} onOpenChange={(o) => !rebuild.isPending && setConfirmRebuild(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebuild every share card?</AlertDialogTitle>
            <AlertDialogDescription>
              Re-composites a fresh branded card for all {total} published articles from their existing
              hero images (no AI cost). This can take a few minutes — you can halt it anytime.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => rebuild.mutate()}>Rebuild all</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmRebuildPacks}
        onOpenChange={(o) => !rebuildPacks.isPending && setConfirmRebuildPacks(o)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebuild every social pack?</AlertDialogTitle>
            <AlertDialogDescription>
              Regenerates the full per-platform copy set for all {total} published articles with a fresh LLM
              call each. This overwrites any manual edits and can take a while — you can halt it anytime.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => rebuildPacks.mutate()}>Rebuild all</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={(o) => !deleteAll.isPending && setConfirmDelete(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all share cards?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes the branded card from all {withCard} articles that have one and deletes the stored
              images. Articles fall back to their raw hero image for social previews until you rebuild.
              This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteAll.mutate()}
            >
              Delete all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const EMPTY_PACK: SocialPack = {
  twitter: "",
  threads: "",
  pinterestTitle: "",
  pinterestDescription: "",
  reddit: "",
  newsletterBlurb: "",
  quoteCard: "",
  altCaptions: [],
};

type PackField = Exclude<keyof SocialPack, "altCaptions">;

const PACK_FIELDS: { key: PackField; label: string; multiline?: boolean; hint?: string }[] = [
  { key: "twitter", label: "X / Twitter post", multiline: true, hint: "≤280 chars" },
  { key: "threads", label: "Threads post", multiline: true },
  { key: "pinterestTitle", label: "Pinterest title" },
  { key: "pinterestDescription", label: "Pinterest description", multiline: true },
  { key: "reddit", label: "Reddit prompt", multiline: true },
  { key: "newsletterBlurb", label: "Newsletter blurb", multiline: true },
  { key: "quoteCard", label: "Quote-card text", multiline: true },
];

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy");
    }
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs"
      onClick={onCopy}
      disabled={!value}
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

function SocialPackPanel({ article }: { article: Article }) {
  const qc = useQueryClient();
  const [pack, setPack] = useState<SocialPack>({ ...EMPTY_PACK, ...(article.socialPack ?? {}) });
  const [dirty, setDirty] = useState(false);

  // Re-seed when the underlying article changes (e.g. after a regenerate).
  useEffect(() => {
    setPack({ ...EMPTY_PACK, ...(article.socialPack ?? {}) });
    setDirty(false);
  }, [article.socialPack]);

  const update = useUpdateArticle({
    mutation: {
      onSuccess: () => {
        toast.success("Social pack saved.");
        setDirty(false);
        qc.invalidateQueries({ queryKey: getListArticlesQueryKey({ status: "published" }) });
      },
      onError: () => toast.error("Couldn't save the social pack"),
    },
  });

  const regen = useRegenerateArticleHooks({
    mutation: {
      onSuccess: () => {
        toast.success("Regenerated hooks & social pack.");
        qc.invalidateQueries({ queryKey: getListArticlesQueryKey({ status: "published" }) });
      },
      onError: () => toast.error("Couldn't regenerate (an LLM call may have failed)."),
    },
  });

  const setField = (key: PackField, value: string) => {
    setPack((p) => ({ ...p, [key]: value }));
    setDirty(true);
  };

  const setAltCaption = (i: number, value: string) => {
    setPack((p) => {
      const next = [...p.altCaptions];
      next[i] = value;
      return { ...p, altCaptions: next };
    });
    setDirty(true);
  };

  const addAltCaption = () => {
    setPack((p) => ({ ...p, altCaptions: [...p.altCaptions, ""] }));
    setDirty(true);
  };

  const removeAltCaption = (i: number) => {
    setPack((p) => ({ ...p, altCaptions: p.altCaptions.filter((_, idx) => idx !== i) }));
    setDirty(true);
  };

  const onSave = () => {
    const cleaned: SocialPack = {
      ...pack,
      altCaptions: pack.altCaptions.map((c) => c.trim()).filter(Boolean),
    };
    update.mutate({ id: article.id, data: { socialPack: cleaned } });
  };

  return (
    <div className="border-t bg-muted/30 p-3 space-y-3">
      {PACK_FIELDS.map(({ key, label, multiline, hint }) => (
        <div key={key} className="space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted-foreground">
              {label}
              {hint ? <span className="ml-1 font-normal opacity-70">({hint})</span> : null}
            </label>
            <CopyButton value={pack[key] ?? ""} />
          </div>
          {multiline ? (
            <Textarea
              value={pack[key] ?? ""}
              onChange={(e) => setField(key, e.target.value)}
              rows={2}
              className="text-sm"
            />
          ) : (
            <Input value={pack[key] ?? ""} onChange={(e) => setField(key, e.target.value)} className="text-sm" />
          )}
        </div>
      ))}

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-muted-foreground">Alternate captions</label>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={addAltCaption}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add
          </Button>
        </div>
        {pack.altCaptions.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">None yet.</p>
        ) : (
          pack.altCaptions.map((cap, i) => (
            <div key={i} className="flex items-center gap-1">
              <Input
                value={cap}
                onChange={(e) => setAltCaption(i, e.target.value)}
                className="text-sm"
                placeholder={`Caption ${i + 1}`}
              />
              <CopyButton value={cap} />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-destructive"
                onClick={() => removeAltCaption(i)}
                title="Remove"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" onClick={onSave} disabled={!dirty || update.isPending}>
          {update.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
          Save
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => regen.mutate({ id: article.id })}
          disabled={regen.isPending}
        >
          {regen.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4 mr-2" />
          )}
          Regenerate
        </Button>
        {dirty ? <span className="text-xs text-amber-600">Unsaved changes</span> : null}
      </div>
    </div>
  );
}
