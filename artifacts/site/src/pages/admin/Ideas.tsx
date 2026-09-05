import {
  useListIdeas,
  useListAuthors,
  useListBeats,
  useUpdateIdea,
  useDeleteIdea,
  useDeleteAllPendingIdeas,
  useGenerateDraft,
  useHarvestSourcesAndDraft,
  useHarvestSources,
  useCreateCustomIdea,
  useGenerateIdeasFromBeat,
  getListIdeasQueryKey,
  getListArticlesQueryKey,
  type TopicIdea,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SecondaryBeatsEditor } from "@/components/admin/SecondaryBeatsEditor";
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
import { Loader2, Check, X, FileEdit, Trash2, Plus, Sparkles, DatabaseZap } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { format } from "date-fns";

const STATUSES = ["pending", "approved", "drafting", "harvesting_sources", "needs_sources", "used", "rejected", "all"] as const;
type StatusFilter = (typeof STATUSES)[number];

export default function Ideas() {
  const [status, setStatus] = useState<StatusFilter>("pending");
  const qc = useQueryClient();
  // Timestamp until which we keep polling after a harvest/draft retry, even if
  // no drafting idea is currently VISIBLE. When a `needs_sources` idea is
  // retried it flips to `drafting` server-side and drops out of the filtered
  // list, so the "visible drafting" check alone would stop polling and the
  // eventual outcome (used, or back to needs_sources) would never refresh in.
  const [retryWatchUntil, setRetryWatchUntil] = useState(0);
  const watchRetry = () => setRetryWatchUntil(Date.now() + 180_000);
  const params = status === "all" ? undefined : { status };
  const { data, isLoading } = useListIdeas(params, {
    query: {
      queryKey: getListIdeasQueryKey(params),
      // Poll while any visible idea is still drafting/harvesting so the UI
      // converges without forcing the editor to refresh by hand. Also poll for
      // a window after a retry so an idea that left this filtered list and
      // then settled (used / back to needs_sources) is reflected automatically.
      refetchInterval: (query) => {
        const items = (query.state.data as { items?: { status: string }[] } | undefined)?.items ?? [];
        if (items.some((i) => i.status === "drafting" || i.status === "harvesting_sources")) return 4000;
        if (Date.now() < retryWatchUntil) return 4000;
        return false;
      },
    },
  });
  const { data: authorsData } = useListAuthors();
  const authorMap = new Map((authorsData?.items ?? []).map((a) => [a.id, a]));
  const { data: beatsData } = useListBeats();

  // Full list (any status) so per-tab counts and the bulk-delete count stay
  // accurate no matter which status tab is active.
  const { data: allIdeasData } = useListIdeas();
  const allItems = allIdeasData?.items ?? [];
  const countByStatus = (s: string) => allItems.filter((i) => i.status === s).length;
  const nonTerminalCount =
    countByStatus("pending") + countByStatus("approved") + countByStatus("drafting");
  // The bulk-delete button is scoped to the active tab: on a specific
  // non-terminal tab it deletes only that status; on "all" it deletes every
  // non-terminal idea. Terminal tabs (used/rejected) get no bulk delete.
  const bulkTarget: "pending" | "approved" | "drafting" | "all" | null =
    status === "pending" || status === "approved" || status === "drafting"
      ? status
      : status === "all"
        ? "all"
        : null;
  const bulkCount =
    bulkTarget === "all" ? nonTerminalCount : bulkTarget ? countByStatus(bulkTarget) : 0;
  const bulkLabel = bulkTarget === "all" ? "Delete all ideas" : `Delete all ${bulkTarget ?? ""}`;

  // Invalidate the base key (no params) so it prefix-matches every status-filtered
  // list query AND the all-status query that feeds the tab count badges. Using the
  // params-scoped key would leave the counts (and other tabs) stale after a mutation.
  const invalidate = () => qc.invalidateQueries({ queryKey: getListIdeasQueryKey() });
  const invalidateAll = invalidate;

  const updateIdea = useUpdateIdea({
    mutation: { onSuccess: invalidate, onError: () => toast.error("Update failed") },
  });
  const deleteIdea = useDeleteIdea({
    mutation: { onSuccess: invalidate, onError: () => toast.error("Delete failed") },
  });
  const [confirmBulk, setConfirmBulk] = useState(false);
  const deleteAllPending = useDeleteAllPendingIdeas({
    mutation: {
      onSuccess: (res) => {
        toast.success(`Deleted ${res.deleted} idea${res.deleted === 1 ? "" : "s"}`);
        setConfirmBulk(false);
        invalidateAll();
      },
      onError: () => toast.error("Bulk delete failed"),
    },
  });
  const draft = useGenerateDraft({
    mutation: {
      onSuccess: () => {
        // Draft generation now runs in the background. The article doesn't
        // exist yet, so just confirm the job started; the Ideas list will
        // poll until the idea moves to "Used" (or back to "Approved" on
        // failure), at which point the article shows up under Drafts.
        toast.success("Draft started — it'll appear in Drafts when ready.");
        watchRetry();
        qc.invalidateQueries({ queryKey: getListArticlesQueryKey() });
        invalidate();
      },
      onError: (err) => {
        const e = err as unknown as { status?: number; data?: { message?: string } };
        if (e?.status === 409) {
          toast.error(e.data?.message ?? "This idea is too similar to an existing article.");
          invalidate();
        } else {
          toast.error("Draft failed");
        }
      },
    },
  });

  const harvestAndDraft = useHarvestSourcesAndDraft({
    mutation: {
      onSuccess: () => {
        // Same fire-and-forget flow as a normal draft, but it first harvests
        // fresh sources for the idea's beat. The list polls the idea until it
        // moves to "Used" (grounded) or back to "Needs sources" (still thin).
        toast.success("Harvesting sources & retrying draft…");
        watchRetry();
        qc.invalidateQueries({ queryKey: getListArticlesQueryKey() });
        invalidate();
      },
      onError: (err) => {
        const e = err as unknown as { status?: number; data?: { message?: string } };
        if (e?.status === 409) {
          toast.error(e.data?.message ?? "This idea is too similar to an existing article.");
          invalidate();
        } else {
          toast.error("Harvest & retry failed");
        }
      },
    },
  });

  const harvestSources = useHarvestSources({
    mutation: {
      onSuccess: () => {
        toast.success("Harvesting sources & retrying draft…");
        watchRetry();
        qc.invalidateQueries({ queryKey: getListArticlesQueryKey() });
        invalidate();
      },
      onError: (err) => {
        const e = err as unknown as { status?: number; data?: { message?: string } };
        if (e?.status === 409) {
          toast.error(e.data?.message ?? "This idea is too similar to an existing article.");
          invalidate();
        } else {
          toast.error("Harvest & retry failed");
        }
      },
    },
  });

  const items = data?.items ?? [];

  const [newTitle, setNewTitle] = useState("");
  const [newAngle, setNewAngle] = useState("");
  const [newAuthorId, setNewAuthorId] = useState<string>("");
  const [newBeatSlug, setNewBeatSlug] = useState<string>("");
  const [autoPick, setAutoPick] = useState(true);

  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);

  const createCustom = useCreateCustomIdea({
    mutation: {
      onSuccess: (idea) => {
        const author = authorMap.get(idea.authorId);
        toast.success(
          author ? `Idea created — assigned to ${author.name}.` : "Idea created.",
        );
        setNewTitle("");
        setNewAngle("");
        setNewAuthorId("");
        setNewBeatSlug("");
        setAutoPick(true);
        setDuplicateWarning(null);
        // Jump to the tab the new idea actually lives in so it's visible.
        const created = idea.status as StatusFilter;
        if (status !== "all" && status !== created) setStatus(created);
        qc.invalidateQueries({ queryKey: getListIdeasQueryKey() });
      },
      onError: (err) => {
        const e = err as unknown as { status?: number; data?: { message?: string } };
        if (e?.status === 409) {
          setDuplicateWarning(e.data?.message ?? "Too similar to an existing idea or article.");
        } else {
          setDuplicateWarning(null);
          toast.error(e?.data?.message ?? "Could not create idea.");
        }
      },
    },
  });

  const [beatSlug, setBeatSlug] = useState<string>("");
  const [beatCount, setBeatCount] = useState<number>(5);

  const generateFromBeat = useGenerateIdeasFromBeat({
    mutation: {
      onSuccess: (res) => {
        const created = res.items.length;
        const skipped = res.skipped.length;
        if (created === 0) {
          toast.info(
            skipped > 0
              ? `No new ideas — all ${skipped} were too similar to existing material.`
              : "No ideas were generated. Try again.",
          );
        } else {
          toast.success(
            `Created ${created} idea${created === 1 ? "" : "s"}${skipped > 0 ? `, skipped ${skipped} near-duplicate${skipped === 1 ? "" : "s"}.` : "."}`,
          );
        }
        // Beat ideas land as "pending" — jump there so they're visible.
        if (created > 0 && status !== "all" && status !== "pending") setStatus("pending");
        qc.invalidateQueries({ queryKey: getListIdeasQueryKey() });
      },
      onError: (err) => {
        const e = err as unknown as { status?: number; data?: { error?: string; message?: string } };
        toast.error(e?.data?.error ?? e?.data?.message ?? "Could not generate ideas from this beat.");
      },
    },
  });

  const submitGenerateFromBeat = () => {
    if (!beatSlug) { toast.error("Pick a beat first."); return; }
    generateFromBeat.mutate({ data: { beatSlug, count: beatCount } });
  };

  const submitCustom = (force = false) => {
    const title = newTitle.trim();
    if (!title) { toast.error("A title is required."); return; }
    if (!force) setDuplicateWarning(null);
    createCustom.mutate({
      data: {
        title,
        angle: newAngle.trim() || undefined,
        authorId: !autoPick && newAuthorId ? newAuthorId : undefined,
        beatSlug: newBeatSlug || undefined,
        status: "approved",
      },
      ...(force ? { params: { force: "1" } } : {}),
    });
  };

  return (
    <div className="p-4 md:p-8 max-w-6xl">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="font-serif text-3xl font-bold mb-1">Topic ideas</h1>
          <p className="text-muted-foreground">All ideas from every author. Approve, reject, or turn one into a draft.</p>
        </div>
        {bulkTarget && (
          <Button
            type="button"
            variant="outline"
            className="text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive shrink-0"
            disabled={bulkCount === 0 || deleteAllPending.isPending}
            onClick={() => setConfirmBulk(true)}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            {bulkLabel} ({bulkCount})
          </Button>
        )}
      </div>

      <AlertDialog open={confirmBulk} onOpenChange={(open) => !deleteAllPending.isPending && setConfirmBulk(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{bulkLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes <strong>{bulkCount}</strong>{" "}
              {bulkTarget === "all" ? "non-terminal" : bulkTarget} idea{bulkCount === 1 ? "" : "s"}
              {bulkTarget === "all" ? " (pending, approved, and drafting)" : ""}. Used and rejected ideas are kept as history. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteAllPending.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteAllPending.isPending}
              onClick={(e) => {
                e.preventDefault();
                deleteAllPending.mutate(
                  bulkTarget && bulkTarget !== "all" ? { params: { status: bulkTarget } } : {},
                );
              }}
            >
              {deleteAllPending.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete {bulkCount} idea{bulkCount === 1 ? "" : "s"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card className="p-4 mb-6">
        <h2 className="font-serif font-bold mb-3">New custom idea</h2>
        <div className="space-y-3">
          <Input
            placeholder="Title (required)"
            value={newTitle}
            onChange={(e) => { setNewTitle(e.target.value); setDuplicateWarning(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitCustom(); }}
          />
          <Textarea
            placeholder="Angle (optional) — a sentence or two on the take or hook"
            value={newAngle}
            onChange={(e) => setNewAngle(e.target.value)}
            rows={2}
          />
          <div>
            <label className="flex items-center gap-2 text-sm">
              Beat
              <select
                className="border rounded-md px-2 py-1.5 text-sm bg-background min-w-[14rem]"
                value={newBeatSlug}
                onChange={(e) => setNewBeatSlug(e.target.value)}
              >
                <option value="">Author's own beat</option>
                {(beatsData?.items ?? []).map((b) => (
                  <option key={b.id} value={b.slug}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-muted-foreground mt-1">
              Editorial override: file this idea under a different beat to drive the article's slant — the one sanctioned time an author writes outside their own lane. The best author is still auto-picked on topic.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoPick}
                onChange={(e) => setAutoPick(e.target.checked)}
              />
              Let the system pick the best author
            </label>
            {!autoPick && (
              <select
                className="border rounded-md px-2 py-1.5 text-sm bg-background"
                value={newAuthorId}
                onChange={(e) => setNewAuthorId(e.target.value)}
              >
                <option value="">Select an author…</option>
                {(authorsData?.items ?? [])
                  .filter((a) => a.active)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} — {a.category}
                    </option>
                  ))}
              </select>
            )}
            <Button
              onClick={() => submitCustom(false)}
              disabled={createCustom.isPending || !newTitle.trim() || (!autoPick && !newAuthorId)}
              className="ml-auto"
            >
              {createCustom.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              Add idea
            </Button>
          </div>
          {duplicateWarning && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 flex items-start gap-3">
              <div className="flex-1">{duplicateWarning}</div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => submitCustom(true)}
                disabled={createCustom.isPending}
              >
                Create anyway
              </Button>
            </div>
          )}
        </div>
      </Card>

      <Card className="p-4 mb-6">
        <h2 className="font-serif font-bold mb-1">Generate ideas from a beat</h2>
        <p className="text-sm text-muted-foreground mb-3">
          Pick a beat and let the system brainstorm fresh, beat-grounded ideas — each anchored to the beat's slant and assigned to the best-fit author.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="border rounded-md px-2 py-1.5 text-sm bg-background min-w-[14rem]"
            value={beatSlug}
            onChange={(e) => setBeatSlug(e.target.value)}
          >
            <option value="">Select a beat…</option>
            {(beatsData?.items ?? []).map((b) => (
              <option key={b.id} value={b.slug}>
                {b.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm">
            How many
            <select
              className="border rounded-md px-2 py-1.5 text-sm bg-background"
              value={beatCount}
              onChange={(e) => setBeatCount(Number(e.target.value))}
            >
              {[3, 5, 7, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <Button
            onClick={submitGenerateFromBeat}
            disabled={generateFromBeat.isPending || !beatSlug}
            className="ml-auto"
          >
            {generateFromBeat.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Sparkles className="h-4 w-4 mr-2" />
            )}
            Generate ideas
          </Button>
        </div>
      </Card>

      <div className="flex gap-2 mb-6 flex-wrap">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`px-3 py-1.5 rounded-full text-sm capitalize ${
              status === s ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {s} ({s === "all" ? allItems.length : countByStatus(s)})
          </button>
        ))}
      </div>

      {isLoading ? (
        <Loader2 className="animate-spin" />
      ) : items.length === 0 ? (
        <p className="text-muted-foreground text-sm">No ideas in this view.</p>
      ) : (
        <div className="space-y-2">
          {items.map((idea: TopicIdea) => {
            const author = authorMap.get(idea.authorId);
            return (
              <Card key={idea.id} className="p-4">
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-xs px-2 py-0.5 rounded-full capitalize inline-flex items-center gap-1 ${
                        idea.status === "approved"
                          ? "bg-emerald-100 text-emerald-700"
                          : idea.status === "rejected"
                          ? "bg-rose-100 text-rose-700"
                          : idea.status === "used"
                          ? "bg-blue-100 text-blue-700"
                          : idea.status === "drafting"
                          ? "bg-amber-100 text-amber-800"
                          : idea.status === "harvesting_sources"
                          ? "bg-sky-100 text-sky-800"
                          : idea.status === "needs_sources"
                          ? "bg-orange-100 text-orange-800"
                          : "bg-muted text-muted-foreground"
                      }`}>
                        {(idea.status === "drafting" || idea.status === "harvesting_sources") && <Loader2 className="h-3 w-3 animate-spin" />}
                        {idea.status === "drafting"
                          ? "Drafting…"
                          : idea.status === "harvesting_sources"
                          ? "Sourcing…"
                          : idea.status === "needs_sources"
                          ? "Needs sources"
                          : idea.status}
                      </span>
                      {idea.draftGroundingOutcome ? (
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${
                            idea.draftGroundingOutcome === "grounded_from_vault" ||
                            idea.draftGroundingOutcome === "packet_verified"
                              ? "bg-teal-100 text-teal-700"
                              : idea.draftGroundingOutcome === "held_needs_sources"
                              ? "bg-orange-100 text-orange-800"
                              : "bg-yellow-100 text-yellow-800"
                          }`}
                          title="How this draft was grounded"
                        >
                          {idea.draftGroundingOutcome === "grounded_from_vault"
                            ? "Grounded from Vault"
                            : idea.draftGroundingOutcome === "packet_verified"
                            ? "Packet-verified"
                            : idea.draftGroundingOutcome === "held_needs_sources"
                            ? "Held: needs sources"
                            : "Legacy web search"}
                        </span>
                      ) : null}
                      {idea.status === "approved" || idea.status === "pending" ? (
                        <select
                          className="text-xs border rounded-md px-1.5 py-0.5 bg-background max-w-[12rem]"
                          value={idea.authorId}
                          disabled={updateIdea.isPending}
                          onChange={(e) => {
                            const authorId = e.target.value;
                            if (authorId && authorId !== idea.authorId) {
                              updateIdea.mutate({ id: idea.id, data: { authorId } });
                            }
                          }}
                          title="Reassign this idea to a different author"
                        >
                          {!authorMap.has(idea.authorId) && (
                            <option value={idea.authorId}>{author?.name ?? "Unknown author"}</option>
                          )}
                          {(authorsData?.items ?? [])
                            .filter((a) => a.active || a.id === idea.authorId)
                            .map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name} — {a.category}
                              </option>
                            ))}
                        </select>
                      ) : (
                        author && (
                          <Link href={`/admin/authors/${author.id}`} className="text-xs text-muted-foreground hover:text-primary">
                            {author.name}
                          </Link>
                        )
                      )}
                      {idea.status === "approved" || idea.status === "pending" ? (
                        <select
                          className="text-xs border rounded-md px-1.5 py-0.5 bg-background max-w-[12rem]"
                          value={idea.categorySlug ?? ""}
                          disabled={updateIdea.isPending}
                          onChange={(e) => {
                            const categorySlug = e.target.value;
                            if (categorySlug && categorySlug !== idea.categorySlug) {
                              updateIdea.mutate({ id: idea.id, data: { categorySlug } });
                            }
                          }}
                          title="File this idea under a different beat — sets the draft's slant (editorial override; doesn't change the author)"
                        >
                          {!(beatsData?.items ?? []).some((b) => b.slug === idea.categorySlug) && idea.category && (
                            <option value={idea.categorySlug ?? ""}>{idea.category}</option>
                          )}
                          {(beatsData?.items ?? []).map((b) => (
                            <option key={b.id} value={b.slug}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        idea.category && (
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full ${
                              author && idea.categorySlug && idea.categorySlug !== author.categorySlug
                                ? "bg-violet-100 text-violet-700"
                                : "bg-muted text-muted-foreground"
                            }`}
                            title={
                              author && idea.categorySlug && idea.categorySlug !== author.categorySlug
                                ? "Sub-beat (cross-disciplinary)"
                                : "Primary beat"
                            }
                          >
                            {idea.category}
                          </span>
                        )
                      )}
                      {idea.continuesArticleId && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Follow-up</span>
                      )}
                      <span className="text-xs text-muted-foreground ml-auto">{format(new Date(idea.createdAt), "MMM d")}</span>
                    </div>
                    <div className="mt-1">
                      <SecondaryBeatsEditor
                        primarySlug={idea.categorySlug ?? ""}
                        value={idea.secondaryBeats ?? []}
                        onChange={(next) =>
                          updateIdea.mutate({ id: idea.id, data: { secondaryBeats: next.length ? next : null } })
                        }
                        disabled={
                          updateIdea.isPending ||
                          idea.status === "used" ||
                          idea.status === "drafting" ||
                          idea.status === "rejected" ||
                          idea.status === "harvesting_sources"
                        }
                      />
                    </div>
                    <h3 className="font-serif font-bold mt-1 truncate">{idea.title}</h3>
                    <p className="text-sm text-muted-foreground line-clamp-2">{idea.angle}</p>
                    {idea.notes && (
                      <p className="text-xs text-muted-foreground mt-1 italic">{idea.notes}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {idea.status !== "approved" && idea.status !== "used" && idea.status !== "drafting" && idea.status !== "harvesting_sources" && (
                      <Button size="icon" variant="ghost" onClick={() => updateIdea.mutate({ id: idea.id, data: { status: "approved" } })} title="Approve">
                        <Check className="h-4 w-4 text-emerald-600" />
                      </Button>
                    )}
                    {idea.status !== "rejected" && idea.status !== "used" && idea.status !== "drafting" && idea.status !== "harvesting_sources" && (
                      <Button size="icon" variant="ghost" onClick={() => updateIdea.mutate({ id: idea.id, data: { status: "rejected" } })} title="Reject">
                        <X className="h-4 w-4 text-rose-600" />
                      </Button>
                    )}
                    {(idea.status === "needs_sources" ||
                      (idea.status === "approved" && idea.draftGroundingOutcome === "held_needs_sources")) && (
                      <Button
                        size="icon"
                        variant="ghost"
                        disabled={harvestSources.isPending || harvestAndDraft.isPending || draft.isPending}
                        onClick={() => harvestSources.mutate({ id: idea.id })}
                        title="Harvest sources & retry draft"
                      >
                        {harvestSources.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <DatabaseZap className="h-4 w-4 text-orange-600" />}
                      </Button>
                    )}
                    {idea.status !== "used" && (
                      <Button
                        size="icon"
                        variant="ghost"
                        disabled={draft.isPending || idea.status === "drafting" || idea.status === "harvesting_sources"}
                        onClick={() => draft.mutate({ id: idea.id })}
                        title={idea.status === "drafting" || idea.status === "harvesting_sources" ? "Draft in progress" : "Draft article"}
                      >
                        {draft.isPending || idea.status === "drafting" || idea.status === "harvesting_sources" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileEdit className="h-4 w-4" />}
                      </Button>
                    )}
                    <Button size="icon" variant="ghost" onClick={() => deleteIdea.mutate({ id: idea.id })} title="Delete">
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
