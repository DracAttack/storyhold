import { useEffect, useRef, useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import {
  useGetMeme,
  useGenerateMemeConcepts,
  useSelectMemeConcept,
  useRegenerateMemeExplainerSummary,
  useRegenerateMemeVisualPrompt,
  useUpdateMeme,
  useUploadMemeImage,
  useBuildMemePreview,
  useRegenerateMemeArtwork,
  useSelectMemeArtwork,
  useDeleteMemeArtwork,
  useAutoPlaceMemeText,
  useSetMemeAttemptOverride,
  useApproveMeme,
  usePostMemeNow,
  useDeleteMeme,
  useListMemeTemplates,
  useSaveMemeAsTemplate,
  useGetMemeAiCost,
  getGetMemeQueryKey,
  getListMemesQueryKey,
  getListMemeQueueQueryKey,
  getListMemeTemplatesQueryKey,
  type Meme,
  type MemeConcept,
  type MemeTemplate,
  type MemeUpdateInput,
  type MemeUpdateInputBrandLogoCorner,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  ArrowLeft,
  Sparkles,
  Wand2,
  Upload,
  Image as ImageIcon,
  RefreshCw,
  Save,
  CheckCircle2,
  Trash2,
  RotateCcw,
  ExternalLink,
  Search,
  Send,
  BookmarkPlus,
  MoveVertical,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

const SOURCE_TYPES = [
  { value: "mainstream_template", label: "Curated template" },
  { value: "ai_generated", label: "AI artwork (Nano Banana)" },
  { value: "admin_uploaded", label: "Upload image" },
  { value: "article_hero_image", label: "Article hero image" },
] as const;

const LAYOUTS = [
  { value: "classic_top_bottom", label: "Classic (top + bottom)" },
  { value: "split_panel", label: "Split panel" },
  { value: "headline_caption", label: "Headline + caption" },
  { value: "explainer", label: "Explainer (long paragraph)" },
] as const;

const ART_STYLES = [
  { value: "auto", label: "Auto (let AI decide)" },
  { value: "photographic", label: "Photographic" },
  { value: "cartoon", label: "Cartoon" },
  { value: "illustration", label: "Illustration" },
] as const;

// Optional slant for regenerating the visual prompt. "auto" sends no direction
// (let the AI pick); the others bias the scene's content/medium.
const VISUAL_DIRECTIONS = [
  { value: "auto", label: "Auto (no direction)" },
  { value: "realistic", label: "Realistic" },
  { value: "people", label: "People" },
  { value: "objects", label: "Objects" },
  { value: "cartoon", label: "Cartoon" },
  { value: "political_cartoon", label: "Political cartoon" },
] as const;

type VisualDirection = Exclude<(typeof VISUAL_DIRECTIONS)[number]["value"], "auto">;

/** Human label for a layout value (falls back to the raw value for unknowns). */
function layoutLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return LAYOUTS.find((l) => l.value === value)?.label ?? value;
}

const TERMINAL = new Set(["queued", "scheduled", "posting", "posted", "rejected", "approved"]);

const BRAND_CORNER_LABELS: Record<MemeUpdateInputBrandLogoCorner, string> = {
  auto: "Auto (layout default)",
  top_left: "Top left",
  top_right: "Top right",
  bottom_left: "Bottom left",
  bottom_right: "Bottom right",
};

// One brand-footer mark's controls (logo OR the brainhook.net URL): which corner
// it sits in, plus a pixel inset toward the center from that corner. Offsets are
// gravity-relative on the server, so "inset" always moves the mark inward
// regardless of the chosen corner. Applied on the next free recompose.
function BrandMarkControls(props: {
  title: string;
  corner: MemeUpdateInputBrandLogoCorner;
  offsetX: number;
  offsetY: number;
  disabled?: boolean;
  onCorner: (v: MemeUpdateInputBrandLogoCorner) => void;
  onOffsetX: (v: number) => void;
  onOffsetY: (v: number) => void;
}) {
  return (
    <div className="space-y-2 pt-3 border-t">
      <Label className="text-sm">{props.title}</Label>
      <Select
        value={props.corner}
        disabled={props.disabled}
        onValueChange={(v) => props.onCorner(v as MemeUpdateInputBrandLogoCorner)}
      >
        <SelectTrigger className="h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(BRAND_CORNER_LABELS) as MemeUpdateInputBrandLogoCorner[]).map((value) => (
            <SelectItem key={value} value={value}>
              {BRAND_CORNER_LABELS[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] leading-tight text-muted-foreground">
        − pushes the mark past the edge (lets the artwork bleed off) · + nudges it
        toward the center.
      </p>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Horizontal nudge</span>
          <span className="tabular-nums">{props.offsetX} px</span>
        </div>
        <Slider
          min={-200}
          max={480}
          step={4}
          value={[props.offsetX]}
          disabled={props.disabled}
          onValueChange={([v]) => props.onOffsetX(v)}
        />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Vertical nudge</span>
          <span className="tabular-nums">{props.offsetY} px</span>
        </div>
        <Slider
          min={-200}
          max={480}
          step={4}
          value={[props.offsetY]}
          disabled={props.disabled}
          onValueChange={([v]) => props.onOffsetY(v)}
        />
      </div>
    </div>
  );
}

function fmt(ts: string | null | undefined): string {
  if (!ts) return "—";
  try {
    return format(new Date(ts), "MMM d, yyyy HH:mm");
  } catch {
    return ts;
  }
}

/** Convert an ISO timestamp to a value the datetime-local input understands. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

function MemeAiCostBadge({ memeId, legacyCost }: { memeId: string; legacyCost: number }) {
  const { data } = useGetMemeAiCost(memeId, { query: { queryKey: ["meme-ai-cost", memeId], staleTime: 60000 } });
  const tracked = data ? Number(data.trackedCostUsd) : null;
  const display = tracked !== null && tracked > 0 ? tracked : legacyCost;
  const label = tracked !== null && tracked > 0 ? "AI cost" : "Est. cost";
  return <div>{label}: ${display.toFixed(2)}</div>;
}

export default function MemeEditor() {
  const params = useParams();
  const id = params.id as string;
  const [, navigate] = useLocation();
  const qc = useQueryClient();

  const { data: meme, isLoading } = useGetMeme(id);
  const templatesQuery = useListMemeTemplates();

  // Local draft of editable fields (synced from the server meme on load/refetch).
  const [draft, setDraft] = useState<MemeUpdateInput>({});
  const [dirty, setDirty] = useState(false);
  const [templateSearch, setTemplateSearch] = useState("");
  const [scheduleLocal, setScheduleLocal] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [savePresetOpen, setSavePresetOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  // A concept the admin has clicked but NOT yet applied. Clicking a concept only
  // stages it (and seeds a layout choice from its recommendation); nothing is
  // written or previewed until "Apply concept" is pressed, so the admin can pick
  // a different layout first.
  const [stagedConceptIndex, setStagedConceptIndex] = useState<number | null>(null);
  const [stagedLayout, setStagedLayout] = useState<string | null>(null);
  // True for the full async apply sequence (select + optional layout update +
  // optional explainer summary), so the cards/apply/cancel stay locked the whole
  // time rather than re-enabling between awaited mutations.
  const [applyingConcept, setApplyingConcept] = useState(false);
  // The chosen slant for "Regenerate prompt" ("auto" sends no direction).
  const [visualDirection, setVisualDirection] = useState<VisualDirection | "auto">("auto");
  const fileInput = useRef<HTMLInputElement>(null);
  const lastSyncedVersion = useRef<string | null>(null);

  // Hydrate the local draft from the server meme, keyed on a version stamp
  // (id + updatedAt). It only re-runs when the server row actually changes — a
  // landed save/preview/approve bumps updatedAt and we re-hydrate from the fresh
  // row; pure local edits (same updatedAt) never trigger a stale overwrite.
  useEffect(() => {
    if (!meme) return;
    const version = `${meme.id}:${meme.updatedAt}`;
    if (lastSyncedVersion.current === version) return;
    setDraft({
      sourceType: meme.sourceType,
      templateId: meme.templateId,
      layout: meme.layout,
      topText: meme.topText,
      bottomText: meme.bottomText,
      artStyle: meme.artStyle,
      visualPrompt: meme.visualPrompt,
      socialHook: meme.socialHook,
      socialSummary: meme.socialSummary,
      socialCta: meme.socialCta,
      caption: meme.caption,
      hashtags: meme.hashtags,
      allowPublicFigures: meme.allowPublicFigures,
      captionTopOffsetAdj: meme.captionTopOffsetAdj,
      captionBottomOffsetAdj: meme.captionBottomOffsetAdj,
      captionTopSizeAdj: meme.captionTopSizeAdj,
      captionBottomSizeAdj: meme.captionBottomSizeAdj,
      brandLogoCorner: meme.brandLogoCorner,
      brandUrlCorner: meme.brandUrlCorner,
      brandLogoOffsetXAdj: meme.brandLogoOffsetXAdj,
      brandLogoOffsetYAdj: meme.brandLogoOffsetYAdj,
      brandUrlOffsetXAdj: meme.brandUrlOffsetXAdj,
      brandUrlOffsetYAdj: meme.brandUrlOffsetYAdj,
    });
    setScheduleLocal(toLocalInput(meme.scheduledAt));
    setDirty(false);
    lastSyncedVersion.current = version;
  }, [meme]);

  const generateConcepts = useGenerateMemeConcepts();
  const selectConcept = useSelectMemeConcept();
  const explainerSummary = useRegenerateMemeExplainerSummary();
  const regenerateVisualPrompt = useRegenerateMemeVisualPrompt();
  const updateMeme = useUpdateMeme();
  const uploadImage = useUploadMemeImage();
  const buildPreview = useBuildMemePreview();
  const regenerateArtwork = useRegenerateMemeArtwork();
  const selectArtwork = useSelectMemeArtwork();
  const deleteArtwork = useDeleteMemeArtwork();
  const autoPlace = useAutoPlaceMemeText();
  const attemptOverride = useSetMemeAttemptOverride();
  const approve = useApproveMeme();
  const postNow = usePostMemeNow();
  const remove = useDeleteMeme();
  const saveAsTemplate = useSaveMemeAsTemplate();

  function refresh() {
    qc.invalidateQueries({ queryKey: getGetMemeQueryKey(id) });
    qc.invalidateQueries({ queryKey: getListMemesQueryKey() });
    qc.invalidateQueries({ queryKey: getListMemeQueueQueryKey() });
  }

  function patchDraft(p: Partial<MemeUpdateInput>) {
    setDraft((prev) => ({ ...prev, ...p }));
    setDirty(true);
  }

  // Drop any staged (un-applied) concept whenever the server row swaps or its
  // concepts are regenerated/reordered, so Apply can never commit a stale
  // positional index against a different concept set.
  const conceptSignature = (meme?.concepts ?? []).map((c) => c.jokeDescription).join("\u0001");
  useEffect(() => {
    setStagedConceptIndex(null);
    setStagedLayout(null);
  }, [meme?.id, conceptSignature]);

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!meme) {
    return (
      <div className="p-8 max-w-3xl mx-auto text-center space-y-4">
        <p className="text-muted-foreground">This meme no longer exists.</p>
        <Button asChild variant="outline">
          <Link href="/admin/memes">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to memes
          </Link>
        </Button>
      </div>
    );
  }

  const readOnly = TERMINAL.has(meme.status);
  const concepts: MemeConcept[] = meme.concepts ?? [];
  const sourceType = draft.sourceType ?? meme.sourceType;
  const templates: MemeTemplate[] = templatesQuery.data?.items ?? [];
  const filteredTemplates = templateSearch.trim()
    ? templates.filter((t) =>
        `${t.name} ${t.slug}`.toLowerCase().includes(templateSearch.trim().toLowerCase()),
      )
    : templates;

  // Persist the admin's layout + art-style picks BEFORE generating so the server
  // reads them off the stored row and steers the concepts (chosen layout forced
  // onto all 3; art style shapes the visual scene).
  const handleGenerateConcepts = async () => {
    if (!(await saveThen())) return;
    try {
      await generateConcepts.mutateAsync({ id });
      toast.success("Concepts generated.");
      refresh();
    } catch {
      toast.error("Concept generation is unavailable or turned off.");
    }
  };

  // Clicking a concept only STAGES it — it does not write anything or build a
  // preview. It seeds the layout choice from the concept's recommendation so the
  // admin can keep or change it before pressing "Apply concept".
  const handleStageConcept = (index: number) => {
    const concept = concepts[index];
    if (!concept) return;
    setStagedConceptIndex(index);
    setStagedLayout(concept.recommendedLayout);
  };

  const handleCancelStagedConcept = () => {
    setStagedConceptIndex(null);
    setStagedLayout(null);
  };

  // Commit the staged concept: apply its text/social fields, then persist the
  // admin's layout choice (which may differ from the concept's recommendation).
  // Switching to explainer with a one-liner bottom regenerates the summary, to
  // match the standalone layout switcher. No preview/artwork is built here.
  const handleApplyStagedConcept = async () => {
    if (stagedConceptIndex === null) return;
    const index = stagedConceptIndex;
    const concept = concepts[index];
    if (!concept) return;
    setApplyingConcept(true);
    try {
      await selectConcept.mutateAsync({ id, data: { index } });
      const chosenLayout = stagedLayout ?? concept.recommendedLayout;
      if (chosenLayout !== concept.recommendedLayout) {
        await updateMeme.mutateAsync({ id, data: { layout: chosenLayout } });
        if (chosenLayout === "explainer" && isOneLinerBottom(concept.bottomText)) {
          await explainerSummary.mutateAsync({ id }).catch(() => {
            /* explainer summary may be turned off; layout still applied */
          });
        }
      }
      setStagedConceptIndex(null);
      setStagedLayout(null);
      setDirty(false);
      toast.success("Concept applied.");
      refresh();
    } catch {
      toast.error("Could not apply that concept.");
    } finally {
      setApplyingConcept(false);
    }
  };

  // Regenerate the bottom text into the explainer layout's 1-2 paragraph article
  // summary. Persists any unsaved edits first (joke/kicker ground the summary,
  // and the server rewrites from the stored row), then refetches so the new
  // summary lands in the draft.
  const regenerateExplainerSummary = async () => {
    if (!(await saveThen())) return;
    try {
      await explainerSummary.mutateAsync({ id });
      toast.success("Bottom text rewritten as an explainer summary.");
      refresh();
    } catch (e: unknown) {
      toast.error(errMsg(e, "Could not generate the summary — it may be turned off."));
    }
  };

  // Regenerate ONLY the visual prompt (the text-free background scene), with an
  // optional direction slant. Persists any unsaved edits first (the server
  // rewrites from the stored row), then refetches so the new prompt lands in the
  // draft. On-image meme text is left untouched.
  const handleRegenerateVisualPrompt = async () => {
    if (!(await saveThen())) return;
    try {
      await regenerateVisualPrompt.mutateAsync({
        id,
        data: visualDirection === "auto" ? {} : { direction: visualDirection },
      });
      toast.success("Visual prompt regenerated.");
      refresh();
    } catch (e: unknown) {
      toast.error(errMsg(e, "Could not regenerate the prompt — it may be turned off."));
    }
  };

  // A punchy one-liner that should become a full summary when switching to the
  // explainer layout: short and without an existing paragraph break.
  function isOneLinerBottom(text: string): boolean {
    const t = text.trim();
    if (!t) return true;
    if (/\n\s*\n/.test(t)) return false;
    return t.split(/\s+/).filter(Boolean).length < 30;
  }

  // Changing the layout. When switching TO explainer and the current bottom text
  // is still a one-liner, auto-regenerate it into the longer article summary the
  // layout expects (other layout switches just set the field).
  const handleLayoutChange = (v: string) => {
    patchDraft({ layout: v });
    if (v === "explainer" && isOneLinerBottom(draft.bottomText ?? meme.bottomText)) {
      void regenerateExplainerSummary();
    }
  };

  const handleSave = async () => {
    try {
      await updateMeme.mutateAsync({ id, data: draft });
      setDirty(false);
      toast.success("Saved.");
      refresh();
    } catch (e: unknown) {
      toast.error(errMsg(e, "Could not save — the meme may be locked."));
    }
  };

  // Persist current edits first, then run a server action that rewrites from the
  // stored row (preview/approve/regenerate read the DB, not local state). This
  // ALWAYS writes the draft — never gated on `dirty` — because a hydration/
  // refetch race can clear `dirty` while the field text is genuinely newer than
  // the stored row, which silently made builds compose with stale text (e.g. an
  // edited bottom caption that "didn't update"). An idempotent extra PATCH is
  // cheap next to a 10-40s build and guarantees the server sees the latest text.
  const saveThen = async (): Promise<boolean> => {
    if (!meme) return false;
    try {
      await updateMeme.mutateAsync({ id, data: draft });
      setDirty(false);
      return true;
    } catch (e: unknown) {
      toast.error(errMsg(e, "Could not save before continuing."));
      return false;
    }
  };

  const handleUpload = async (file: File | undefined) => {
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      await uploadImage.mutateAsync({ id, data: { dataUrl } });
      toast.success("Image uploaded.");
      refresh();
    } catch (e: unknown) {
      toast.error(errMsg(e, "Upload failed."));
    }
  };

  // Free recompose — re-renders text onto the existing base image (reuses stored
  // AI artwork, never re-bills the model).
  const handleBuildPreview = async () => {
    if (!(await saveThen())) return;
    try {
      await buildPreview.mutateAsync({ id });
      toast.success("Preview updated.");
      refresh();
    } catch (e: unknown) {
      toast.error(errMsg(e, "Could not recompose the meme."));
    }
  };

  // Paid path — (re)generates the AI artwork, then composes. Counts an attempt.
  const handleRegenerateArtwork = async () => {
    if (!(await saveThen())) return;
    try {
      await regenerateArtwork.mutateAsync({ id });
      toast.success("Artwork generated.");
      refresh();
    } catch (e: unknown) {
      toast.error(errMsg(e, "Image generation failed."));
    }
  };

  // Smart auto-place — a vision pass writes recommended caption offset/size nudges
  // then recomposes. Free (reuses the stored artwork, no image re-bill).
  const handleAutoPlace = async () => {
    if (!(await saveThen())) return;
    try {
      await autoPlace.mutateAsync({ id });
      toast.success("Text auto-placed.");
      refresh();
    } catch (e: unknown) {
      toast.error(errMsg(e, "Could not auto-place the text."));
    }
  };

  // Restore a previously-generated artwork version as the active artwork. Free —
  // it just swaps the stored base+composed pair; no AI re-bill, no attempt used.
  const handleSelectArtwork = async (originalImageUrl: string) => {
    try {
      await selectArtwork.mutateAsync({ id, data: { originalImageUrl } });
      toast.success("Artwork restored.");
      refresh();
    } catch (e: unknown) {
      toast.error(errMsg(e, "Could not restore that artwork."));
    }
  };

  // Remove a version from the history slideshow (the active artwork is never
  // listed here, so this can't delete what's currently shown).
  const handleDeleteArtwork = async (originalImageUrl: string) => {
    try {
      await deleteArtwork.mutateAsync({ id, data: { originalImageUrl } });
      toast.success("Artwork deleted.");
      refresh();
    } catch (e: unknown) {
      toast.error(errMsg(e, "Could not delete that artwork."));
    }
  };

  const handleAttemptOverride = async (override: boolean) => {
    try {
      await attemptOverride.mutateAsync({ id, data: { override } });
      refresh();
    } catch {
      toast.error("Could not update the attempt override.");
    }
  };

  const handleApprove = async (duplicate = false) => {
    if (!(await saveThen())) return;
    const when = scheduleLocal ? new Date(scheduleLocal).toISOString() : null;
    try {
      const res = await approve.mutateAsync({ id, data: { scheduledAt: when, duplicate } });
      if (res.ok) {
        toast.success("Approved — enqueued to the meme queue.");
        refresh();
      } else {
        toast.error(res.reason ?? "Could not approve.");
      }
    } catch (e: unknown) {
      const reason = errReason(e);
      if (reason === "duplicate" && !duplicate) {
        if (window.confirm("A similar meme already exists. Enqueue anyway?")) {
          await handleApprove(true);
        }
        return;
      }
      toast.error(errMsg(e, "Could not approve the meme."));
    }
  };

  const handlePostNow = async () => {
    try {
      const res = await postNow.mutateAsync({ id });
      if (res.status === "posted") {
        toast.success("Posted to Facebook.");
      } else if (res.status === "disabled") {
        toast.error("Facebook posting is not configured.");
      } else {
        toast.error(res.error ?? res.reason ?? `Post ${res.status}.`);
      }
      refresh();
    } catch (e: unknown) {
      toast.error(errMsg(e, "Could not post the meme."));
    }
  };

  const handleDelete = async () => {
    try {
      await remove.mutateAsync({ id });
      toast.success("Meme deleted.");
      navigate("/admin/memes");
    } catch (e: unknown) {
      toast.error(errMsg(e, "Could not delete the meme."));
    }
  };

  const handleSaveAsPreset = async () => {
    try {
      const tpl = await saveAsTemplate.mutateAsync({
        id,
        data: { name: presetName.trim() || undefined },
      });
      toast.success(`Saved “${tpl.name}” as a preset.`);
      qc.invalidateQueries({ queryKey: getListMemeTemplatesQueryKey() });
      setSavePresetOpen(false);
      setPresetName("");
    } catch (e: unknown) {
      toast.error(errMsg(e, "Could not save as preset."));
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <Button asChild variant="ghost" size="sm" className="-ml-2 mb-1">
            <Link href="/admin/memes">
              <ArrowLeft className="h-4 w-4 mr-1" /> Memes
            </Link>
          </Button>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline">{meme.status}</Badge>
            <Badge variant="outline">{meme.category || "—"}</Badge>
            {dirty && <Badge variant="outline" className="bg-amber-100 text-amber-800 border-amber-200">Unsaved</Badge>}
          </div>
          <h1 className="text-xl font-bold truncate">{meme.articleTitle}</h1>
          <a
            href={meme.articleUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-blue-600 hover:underline inline-flex items-center gap-1"
          >
            View article <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <div className="text-right text-xs text-muted-foreground space-y-0.5">
          <div>Attempts: {meme.attemptCount}</div>
          <MemeAiCostBadge memeId={meme.id} legacyCost={Number(meme.estimatedCostUsd || 0)} />
          {meme.facebookPostUrl && (
            <a
              href={meme.facebookPostUrl}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 hover:underline inline-flex items-center gap-1"
            >
              View on Facebook <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>

      {/* Article context — what this meme is riffing on. */}
      {(meme.articleDek || meme.articleHeroImage) && (
        <Card className="p-3 flex gap-3 items-start">
          {meme.articleHeroImage && (
            <img
              src={meme.articleHeroImage}
              alt=""
              className="h-16 w-28 shrink-0 rounded object-cover bg-muted"
            />
          )}
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Article excerpt</p>
            <p className="text-sm mt-0.5">{meme.articleDek || "—"}</p>
          </div>
        </Card>
      )}

      {meme.lastError && (
        <Card className="p-3 border-red-200 bg-red-50 text-sm text-red-700">{meme.lastError}</Card>
      )}

      {readOnly && (
        <Card className="p-3 border-violet-200 bg-violet-50 text-sm text-violet-800">
          This meme is {meme.status}. It can no longer be edited.
          {meme.scheduledAt ? ` Scheduled for ${fmt(meme.scheduledAt)}.` : ""}
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LEFT: editor controls */}
        <div className="space-y-6">
          {/* Concepts */}
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-medium flex items-center gap-2">
                <Sparkles className="h-4 w-4" /> Concepts
              </h2>
              <Button
                size="sm"
                variant="outline"
                onClick={handleGenerateConcepts}
                disabled={readOnly || generateConcepts.isPending}
              >
                {generateConcepts.isPending ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-1" />
                )}
                {concepts.length ? "Regenerate" : "Generate 3 concepts"}
              </Button>
            </div>
            {concepts.length === 0 ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Set the layout and art style first — they steer the AI. Then generate three
                  article-grounded concepts, pick one to fill in the text and social copy below, and
                  refine.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Layout</Label>
                    <Select
                      value={draft.layout ?? meme.layout}
                      onValueChange={handleLayoutChange}
                      disabled={readOnly}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LAYOUTS.map((l) => (
                          <SelectItem key={l.value} value={l.value}>
                            {l.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Art style</Label>
                    <Select
                      value={draft.artStyle ?? meme.artStyle ?? "photographic"}
                      onValueChange={(v) => patchDraft({ artStyle: v as MemeUpdateInput["artStyle"] })}
                      disabled={readOnly}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ART_STYLES.map((s) => (
                          <SelectItem key={s.value} value={s.value}>
                            {s.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {concepts.map((c, i) => {
                  // While a concept is staged, highlight that one; otherwise fall
                  // back to the applied concept on the server row.
                  const active =
                    stagedConceptIndex !== null
                      ? stagedConceptIndex === i
                      : meme.selectedConceptIndex === i;
                  const applied = stagedConceptIndex === null && meme.selectedConceptIndex === i;
                  return (
                    <button
                      key={i}
                      type="button"
                      disabled={readOnly || applyingConcept}
                      onClick={() => handleStageConcept(i)}
                      className={`w-full text-left rounded-md border p-3 transition ${
                        active
                          ? "border-primary bg-primary/5"
                          : "hover:border-primary/50 hover:bg-muted/40"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-muted-foreground">
                            Concept {i + 1}
                          </span>
                          <span className="rounded-full border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {layoutLabel(c.recommendedLayout)}
                          </span>
                        </div>
                        {applied && <CheckCircle2 className="h-4 w-4 text-primary" />}
                      </div>
                      <p className="text-sm font-medium mt-1">{c.jokeDescription}</p>
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {c.topText} {c.bottomText}
                      </p>
                    </button>
                  );
                })}

                {stagedConceptIndex !== null && !readOnly && (
                  <div className="rounded-md border border-primary/40 bg-primary/5 p-3 space-y-3">
                    <p className="text-xs text-muted-foreground">
                      Concept {stagedConceptIndex + 1} selected. Choose a layout, then apply it —
                      nothing is built until you do.
                    </p>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Layout</Label>
                      <Select
                        value={stagedLayout ?? concepts[stagedConceptIndex]?.recommendedLayout}
                        onValueChange={setStagedLayout}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {LAYOUTS.map((l) => (
                            <SelectItem key={l.value} value={l.value}>
                              {l.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={handleApplyStagedConcept}
                        disabled={applyingConcept}
                      >
                        {applyingConcept ? (
                          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4 mr-1" />
                        )}
                        Apply concept
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={handleCancelStagedConcept}
                        disabled={applyingConcept}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* Image source */}
          <Card className="p-4 space-y-4">
            <h2 className="font-medium flex items-center gap-2">
              <ImageIcon className="h-4 w-4" /> Image source
            </h2>
            <div className="space-y-2">
              <Label>Source</Label>
              <Select
                value={sourceType}
                onValueChange={(v) => patchDraft({ sourceType: v })}
                disabled={readOnly}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOURCE_TYPES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Layout</Label>
              <Select
                value={draft.layout ?? meme.layout}
                onValueChange={handleLayoutChange}
                disabled={readOnly}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LAYOUTS.map((l) => (
                    <SelectItem key={l.value} value={l.value}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {sourceType === "mainstream_template" && (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search templates…"
                    value={templateSearch}
                    onChange={(e) => setTemplateSearch(e.target.value)}
                    className="pl-8"
                    disabled={readOnly}
                  />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-56 overflow-y-auto">
                  {filteredTemplates.map((t) => {
                    const active = (draft.templateId ?? meme.templateId) === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        disabled={readOnly}
                        onClick={() => patchDraft({ templateId: t.id, layout: t.layout })}
                        className={`rounded-md border overflow-hidden text-left ${
                          active ? "border-primary ring-2 ring-primary/30" : "hover:border-primary/50"
                        }`}
                        title={t.name}
                      >
                        <img src={t.imageUrl} alt={t.name} className="w-full h-16 object-cover bg-muted" />
                        <span className="block text-[11px] truncate px-1 py-0.5">{t.name}</span>
                      </button>
                    );
                  })}
                  {filteredTemplates.length === 0 && (
                    <p className="col-span-2 sm:col-span-3 text-xs text-muted-foreground py-4 text-center">
                      No templates match. Add some in the{" "}
                      <Link href="/admin/memes/templates" className="text-primary hover:underline">
                        template library
                      </Link>
                      .
                    </p>
                  )}
                </div>
              </div>
            )}

            {sourceType === "ai_generated" && (
              <div className="space-y-2">
                <Label>Art style</Label>
                <Select
                  value={draft.artStyle ?? meme.artStyle ?? "photographic"}
                  onValueChange={(v) => patchDraft({ artStyle: v as MemeUpdateInput["artStyle"] })}
                  disabled={readOnly}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ART_STYLES.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Controls how the artwork is rendered. Takes effect the next time you generate
                  artwork.
                </p>
                <Label>Visual prompt (square Nano Banana artwork)</Label>
                <Textarea
                  rows={4}
                  value={draft.visualPrompt ?? ""}
                  onChange={(e) => patchDraft({ visualPrompt: e.target.value })}
                  placeholder="Describe the meme artwork…"
                  disabled={readOnly}
                />
                <p className="text-xs text-muted-foreground">
                  AI art is billed per generation. Use “Generate artwork” to render it once,
                  then “Recompose text” re-renders edited text on the same artwork for free.
                </p>
                <div className="flex flex-wrap items-end gap-2 pt-1">
                  <div className="space-y-1">
                    <Label className="text-xs">Regenerate direction</Label>
                    <Select
                      value={visualDirection}
                      onValueChange={(v) => setVisualDirection(v as VisualDirection | "auto")}
                      disabled={readOnly || regenerateVisualPrompt.isPending}
                    >
                      <SelectTrigger className="w-[200px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {VISUAL_DIRECTIONS.map((d) => (
                          <SelectItem key={d.value} value={d.value}>
                            {d.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRegenerateVisualPrompt}
                    disabled={readOnly || regenerateVisualPrompt.isPending}
                  >
                    {regenerateVisualPrompt.isPending ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <Wand2 className="h-4 w-4 mr-1" />
                    )}
                    Regenerate prompt
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Rewrites only the scene above (text-free background), grounded in the article
                  and joke. It does not change the on-image meme text or re-render artwork — press
                  “Generate artwork” after to render it.
                </p>
              </div>
            )}

            {sourceType === "admin_uploaded" && (
              <div className="space-y-2">
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleUpload(e.target.files?.[0])}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInput.current?.click()}
                  disabled={readOnly || uploadImage.isPending}
                >
                  {uploadImage.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4 mr-1" />
                  )}
                  Upload image
                </Button>
                {meme.originalImageUrl && (
                  <p className="text-xs text-muted-foreground">An image is uploaded for this meme.</p>
                )}
              </div>
            )}

            {sourceType === "article_hero_image" && (
              <p className="text-sm text-muted-foreground">
                Uses the article’s existing hero image as the meme backdrop — no AI billing.
              </p>
            )}
          </Card>

          {/* Meme text */}
          <Card className="p-4 space-y-3">
            <h2 className="font-medium">Meme text</h2>
            <div className="space-y-2">
              <Label>Top text</Label>
              <Input
                value={draft.topText ?? ""}
                onChange={(e) => patchDraft({ topText: e.target.value })}
                disabled={readOnly}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Bottom text</Label>
                {(draft.layout ?? meme.layout) === "explainer" && !readOnly && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={regenerateExplainerSummary}
                    disabled={explainerSummary.isPending}
                  >
                    {explainerSummary.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5 mr-1" />
                    )}
                    Regenerate summary
                  </Button>
                )}
              </div>
              {(draft.layout ?? meme.layout) === "explainer" ? (
                <Textarea
                  rows={5}
                  value={draft.bottomText ?? ""}
                  onChange={(e) => patchDraft({ bottomText: e.target.value })}
                  disabled={readOnly || explainerSummary.isPending}
                />
              ) : (
                <Input
                  value={draft.bottomText ?? ""}
                  onChange={(e) => patchDraft({ bottomText: e.target.value })}
                  disabled={readOnly}
                />
              )}
              {(draft.layout ?? meme.layout) === "explainer" && (
                <p className="text-xs text-muted-foreground">
                  Explainer layout uses a 1–2 paragraph article summary. Switching to this layout from a
                  one-liner regenerates it automatically.
                </p>
              )}
            </div>
            {(meme.extraTextIdeas?.length ?? 0) > 0 && (
              <div className="space-y-2">
                <Label>Extra text ideas (optional)</Label>
                <p className="text-xs text-muted-foreground">
                  Suggestions only — click one to tack it onto the bottom text.
                </p>
                <div className="flex flex-wrap gap-2">
                  {(meme.extraTextIdeas ?? []).map((idea, i) => (
                    <Button
                      key={`${i}-${idea}`}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto py-1.5 text-xs whitespace-normal text-left"
                      disabled={readOnly}
                      onClick={() => {
                        const current = (draft.bottomText ?? meme.bottomText ?? "").trim();
                        patchDraft({ bottomText: current ? `${current} ${idea}` : idea });
                      }}
                    >
                      {idea}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center justify-between gap-2 pt-2 border-t">
              <div>
                <Label className="text-sm">Allow public figures in AI art</Label>
                <p className="text-xs text-muted-foreground">
                  Off by default. The model may still refuse some subjects.
                </p>
              </div>
              <Switch
                checked={draft.allowPublicFigures ?? false}
                disabled={readOnly}
                onCheckedChange={(v) => patchDraft({ allowPublicFigures: v })}
              />
            </div>
          </Card>

          {/* Social copy */}
          <Card className="p-4 space-y-3">
            <h2 className="font-medium">Social copy</h2>
            <div className="space-y-2">
              <Label>Hook</Label>
              <Input
                value={draft.socialHook ?? ""}
                onChange={(e) => patchDraft({ socialHook: e.target.value })}
                disabled={readOnly}
              />
            </div>
            <div className="space-y-2">
              <Label>Summary</Label>
              <Textarea
                rows={2}
                value={draft.socialSummary ?? ""}
                onChange={(e) => patchDraft({ socialSummary: e.target.value })}
                disabled={readOnly}
              />
            </div>
            <div className="space-y-2">
              <Label>Call to action</Label>
              <Input
                value={draft.socialCta ?? ""}
                onChange={(e) => patchDraft({ socialCta: e.target.value })}
                disabled={readOnly}
              />
            </div>
            <div className="space-y-2">
              <Label>Facebook caption</Label>
              <Textarea
                rows={4}
                value={draft.caption ?? ""}
                onChange={(e) => patchDraft({ caption: e.target.value })}
                disabled={readOnly}
              />
            </div>
            <div className="space-y-2">
              <Label>Hashtags (space or comma separated)</Label>
              <Input
                value={(draft.hashtags ?? []).join(" ")}
                onChange={(e) =>
                  patchDraft({
                    hashtags: e.target.value
                      .split(/[\s,]+/)
                      .map((h) => h.replace(/^#/, "").trim())
                      .filter(Boolean),
                  })
                }
                disabled={readOnly}
              />
            </div>
          </Card>
        </div>

        {/* RIGHT: preview + actions */}
        <div className="space-y-6 lg:sticky lg:top-6 self-start">
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h2 className="font-medium">Preview</h2>
              {sourceType === "ai_generated" ? (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleBuildPreview}
                    disabled={readOnly || buildPreview.isPending || !meme.originalImageUrl}
                    title={meme.originalImageUrl ? "Re-render text — free" : "Generate artwork first"}
                  >
                    {buildPreview.isPending ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <Wand2 className="h-4 w-4 mr-1" />
                    )}
                    Recompose text
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleAutoPlace}
                    disabled={readOnly || autoPlace.isPending || !meme.originalImageUrl}
                    title={
                      meme.originalImageUrl
                        ? "Let AI position the captions to avoid the subject — free"
                        : "Generate artwork first"
                    }
                  >
                    {autoPlace.isPending ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <MoveVertical className="h-4 w-4 mr-1" />
                    )}
                    Auto-place text
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleRegenerateArtwork}
                    disabled={readOnly || regenerateArtwork.isPending}
                    title="Calls the AI model — billed per generation"
                  >
                    {regenerateArtwork.isPending ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4 mr-1" />
                    )}
                    {meme.originalImageUrl ? "Regenerate artwork" : "Generate artwork"}
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  onClick={handleBuildPreview}
                  disabled={readOnly || buildPreview.isPending}
                >
                  {buildPreview.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Wand2 className="h-4 w-4 mr-1" />
                  )}
                  Build preview
                </Button>
              )}
            </div>
            <div className="aspect-square w-full rounded-md bg-muted overflow-hidden flex items-center justify-center">
              {meme.composedImageUrl ? (
                <img src={meme.composedImageUrl} alt="Meme preview" className="w-full h-full object-contain" />
              ) : (
                <div className="text-center text-muted-foreground text-sm p-6">
                  <ImageIcon className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  No preview yet. Set an image source and click “Build preview”.
                </div>
              )}
            </div>
            {meme.attemptCount > 0 && (
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">
                  {meme.attemptCount} AI attempt(s) used.
                </span>
                <label className="flex items-center gap-1">
                  <Switch
                    checked={meme.attemptOverride}
                    disabled={readOnly || attemptOverride.isPending}
                    onCheckedChange={handleAttemptOverride}
                  />
                  <span>Allow more attempts</span>
                </label>
              </div>
            )}
            {!readOnly && meme.originalImageUrl && (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => {
                  setPresetName(meme.articleTitle ?? "");
                  setSavePresetOpen(true);
                }}
                disabled={saveAsTemplate.isPending}
                title="Reuse this artwork as a template for future memes"
              >
                <BookmarkPlus className="h-4 w-4 mr-1" />
                Save as preset
              </Button>
            )}
            {meme.artworkHistory.length > 0 && (
              <div className="space-y-2 border-t pt-3">
                <p className="text-xs font-medium text-muted-foreground">
                  Previous artwork ({meme.artworkHistory.length})
                  <span className="block font-normal">
                    Click to restore an earlier version — free, no AI re-bill.
                  </span>
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {meme.artworkHistory.map((v) => {
                    const thumb = v.composedImageUrl ?? v.originalImageUrl;
                    const busy = selectArtwork.isPending || deleteArtwork.isPending;
                    return (
                      <div
                        key={v.originalImageUrl}
                        className="group relative aspect-square overflow-hidden rounded-md border bg-muted"
                      >
                        <button
                          type="button"
                          onClick={() => handleSelectArtwork(v.originalImageUrl)}
                          disabled={readOnly || busy}
                          title="Restore this artwork"
                          className="block h-full w-full disabled:cursor-not-allowed"
                        >
                          <img
                            src={thumb}
                            alt="Previous artwork"
                            className="h-full w-full object-cover transition-opacity group-hover:opacity-80"
                          />
                          <span className="pointer-events-none absolute inset-0 hidden items-center justify-center bg-black/40 group-hover:flex">
                            <RotateCcw className="h-5 w-5 text-white" />
                          </span>
                        </button>
                        {!readOnly && (
                          <button
                            type="button"
                            onClick={() => handleDeleteArtwork(v.originalImageUrl)}
                            disabled={busy}
                            title="Delete this version"
                            aria-label="Delete this version"
                            className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white opacity-0 transition-opacity hover:bg-destructive group-hover:opacity-100 disabled:cursor-not-allowed"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </Card>

          {/* Placement fine-tuning — lives next to the preview so the admin can
              nudge captions + branding and re-render without scrolling. Free
              recompose reuses the same artwork (no AI re-bill). */}
          {sourceType !== "mainstream_template" && (
            <Card className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-medium">Fine-tune placement</h2>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={
                    readOnly ||
                    ((draft.captionTopOffsetAdj ?? 0) === 0 &&
                      (draft.captionBottomOffsetAdj ?? 0) === 0 &&
                      (draft.captionTopSizeAdj ?? 0) === 0 &&
                      (draft.captionBottomSizeAdj ?? 0) === 0 &&
                      (draft.brandLogoCorner ?? "auto") === "auto" &&
                      (draft.brandUrlCorner ?? "auto") === "auto" &&
                      (draft.brandLogoOffsetXAdj ?? 0) === 0 &&
                      (draft.brandLogoOffsetYAdj ?? 0) === 0 &&
                      (draft.brandUrlOffsetXAdj ?? 0) === 0 &&
                      (draft.brandUrlOffsetYAdj ?? 0) === 0)
                  }
                  onClick={() =>
                    patchDraft({
                      captionTopOffsetAdj: 0,
                      captionBottomOffsetAdj: 0,
                      captionTopSizeAdj: 0,
                      captionBottomSizeAdj: 0,
                      brandLogoCorner: "auto",
                      brandUrlCorner: "auto",
                      brandLogoOffsetXAdj: 0,
                      brandLogoOffsetYAdj: 0,
                      brandUrlOffsetXAdj: 0,
                      brandUrlOffsetYAdj: 0,
                    })
                  }
                >
                  Reset all
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Adjust below, then hit “{sourceType === "ai_generated" ? "Recompose text" : "Build preview"}”
                above to apply — free, reuses the same artwork.
              </p>

              {["classic_top_bottom", "split_panel"].includes(draft.layout ?? meme.layout) && (
                <div className="space-y-3 pt-1">
                  <Label className="text-sm">Caption position</Label>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        Top caption {(draft.captionTopOffsetAdj ?? 0) < 0 ? "(higher)" : "(lower)"}
                      </span>
                      <span className="tabular-nums">{draft.captionTopOffsetAdj ?? 0} px</span>
                    </div>
                    <Slider
                      min={-60}
                      max={200}
                      step={4}
                      value={[draft.captionTopOffsetAdj ?? 0]}
                      disabled={readOnly}
                      onValueChange={([v]) => patchDraft({ captionTopOffsetAdj: v })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        Bottom caption {(draft.captionBottomOffsetAdj ?? 0) < 0 ? "(lower)" : "(higher)"}
                      </span>
                      <span className="tabular-nums">{draft.captionBottomOffsetAdj ?? 0} px</span>
                    </div>
                    <Slider
                      min={-100}
                      max={200}
                      step={4}
                      value={[draft.captionBottomOffsetAdj ?? 0]}
                      disabled={readOnly}
                      onValueChange={([v]) => patchDraft({ captionBottomOffsetAdj: v })}
                    />
                  </div>

                  <Label className="text-sm">Caption size</Label>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        Top caption {(draft.captionTopSizeAdj ?? 0) < 0 ? "(smaller)" : "(larger)"}
                      </span>
                      <span className="tabular-nums">
                        {(draft.captionTopSizeAdj ?? 0) > 0 ? "+" : ""}
                        {draft.captionTopSizeAdj ?? 0}%
                      </span>
                    </div>
                    <Slider
                      min={-60}
                      max={100}
                      step={5}
                      value={[draft.captionTopSizeAdj ?? 0]}
                      disabled={readOnly}
                      onValueChange={([v]) => patchDraft({ captionTopSizeAdj: v })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        Bottom caption {(draft.captionBottomSizeAdj ?? 0) < 0 ? "(smaller)" : "(larger)"}
                      </span>
                      <span className="tabular-nums">
                        {(draft.captionBottomSizeAdj ?? 0) > 0 ? "+" : ""}
                        {draft.captionBottomSizeAdj ?? 0}%
                      </span>
                    </div>
                    <Slider
                      min={-60}
                      max={100}
                      step={5}
                      value={[draft.captionBottomSizeAdj ?? 0]}
                      disabled={readOnly}
                      onValueChange={([v]) => patchDraft({ captionBottomSizeAdj: v })}
                    />
                  </div>
                </div>
              )}

              <BrandMarkControls
                title="Logo"
                corner={draft.brandLogoCorner ?? "auto"}
                offsetX={draft.brandLogoOffsetXAdj ?? 0}
                offsetY={draft.brandLogoOffsetYAdj ?? 0}
                disabled={readOnly}
                onCorner={(v) => patchDraft({ brandLogoCorner: v })}
                onOffsetX={(v) => patchDraft({ brandLogoOffsetXAdj: v })}
                onOffsetY={(v) => patchDraft({ brandLogoOffsetYAdj: v })}
              />
              <BrandMarkControls
                title="Website (brainhook.net)"
                corner={draft.brandUrlCorner ?? "auto"}
                offsetX={draft.brandUrlOffsetXAdj ?? 0}
                offsetY={draft.brandUrlOffsetYAdj ?? 0}
                disabled={readOnly}
                onCorner={(v) => patchDraft({ brandUrlCorner: v })}
                onOffsetX={(v) => patchDraft({ brandUrlOffsetXAdj: v })}
                onOffsetY={(v) => patchDraft({ brandUrlOffsetYAdj: v })}
              />
            </Card>
          )}

          {/* Schedule + actions */}
          <Card className="p-4 space-y-4">
            <div className="space-y-2">
              <Label>Schedule (optional, local time)</Label>
              <Input
                type="datetime-local"
                value={scheduleLocal}
                onChange={(e) => setScheduleLocal(e.target.value)}
                disabled={readOnly}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to let the queue assign the next daily meme slot (10am / 4pm / 7pm
                Phoenix).
              </p>
            </div>

            {!readOnly && (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={handleSave} disabled={updateMeme.isPending || !dirty}>
                  {updateMeme.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-1" />
                  )}
                  Save
                </Button>
                <Button onClick={() => handleApprove(false)} disabled={approve.isPending}>
                  {approve.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 mr-1" />
                  )}
                  Approve &amp; enqueue
                </Button>
              </div>
            )}

            {(meme.status === "queued" || meme.status === "scheduled" || meme.status === "failed") && (
              <Button variant="outline" onClick={handlePostNow} disabled={postNow.isPending}>
                {postNow.isPending ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Send className="h-4 w-4 mr-1" />
                )}
                Post now
              </Button>
            )}

            <div className="pt-2 border-t">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDelete(true)}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-4 w-4 mr-1" /> Delete meme
              </Button>
            </div>
          </Card>
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this meme?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the meme draft and its composed image. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={savePresetOpen} onOpenChange={setSavePresetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save as preset</AlertDialogTitle>
            <AlertDialogDescription>
              Reuse this meme's artwork and layout as a reusable template for future memes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="preset-name">Preset name</Label>
            <Input
              id="preset-name"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="e.g. Distracted scientist"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saveAsTemplate.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleSaveAsPreset();
              }}
              disabled={saveAsTemplate.isPending}
            >
              {saveAsTemplate.isPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <BookmarkPlus className="h-4 w-4 mr-1" />
              )}
              Save preset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function errReason(e: unknown): string | undefined {
  if (e && typeof e === "object" && "reason" in e) {
    return (e as { reason?: string }).reason;
  }
  return undefined;
}

function errMsg(e: unknown, fallback: string): string {
  if (e && typeof e === "object" && "error" in e && typeof (e as { error?: unknown }).error === "string") {
    return (e as { error: string }).error;
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}
