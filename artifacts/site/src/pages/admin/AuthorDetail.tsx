import { useParams, useLocation, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAuthor,
  useListCategories,
  useUpdateAuthor,
  useDeleteAuthor,
  useListIdeasForAuthor,
  useListArticles,
  useGenerateIdeas,
  useGenerateCrossoverIdeas,
  useCreateCustomIdea,
  useUpdateIdea,
  useDeleteIdea,
  useGenerateDraft,
  useApproveAllIdeasForAuthor,
  useGenerateAuthorAvatar,
  useListLlmModels,
  getListIdeasForAuthorQueryKey,
  getGetAuthorQueryKey,
  getListArticlesQueryKey,
  type TopicIdea,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Sparkles, Trash2, Check, X, FileEdit, Image as ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { useEffect, useState } from "react";
import { format } from "date-fns";
import { CompassSliders, VoiceCraftFields, ScheduleFields, type CadenceValue } from "./AuthorNew";
import { CategoryPicker } from "@/components/admin/CategoryPicker";
import { SubBeatsPicker } from "@/components/admin/SubBeatsPicker";
import { SecondaryBeatsEditor } from "@/components/admin/SecondaryBeatsEditor";

export default function AuthorDetail() {
  const params = useParams();
  const id = params.id!;
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { data: author, isLoading } = useGetAuthor(id);
  // Resolve beat display names from the full master list (/categories reads the
  // whole beats table) — NOT useBeats() (/public/beats), which hides beats with
  // no published articles and would render those as raw slugs.
  const { data: categoriesData } = useListCategories();
  const beatNameBySlug = new Map(
    (categoriesData?.items ?? []).map((c) => [c.categorySlug, c.category]),
  );
  const { data: ideasData } = useListIdeasForAuthor(id);
  const { data: draftsData } = useListArticles({ authorId: id, status: "draft" });
  const { data: publishedData } = useListArticles({ authorId: id, status: "published" });

  const [form, setForm] = useState<{
    name: string;
    slug: string;
    bio: string;
    avatarUrl: string;
    category: string;
    categorySlug: string;
    subBeats: string[];
    voicePrompt: string;
    sampleParagraphs: string;
    bannedTopics: string;
    wordCountTarget: number;
    cadence: CadenceValue;
    weekday: number | null;
    secondWeekday: number | null;
    dayOfMonth: number | null;
    randomizeSchedule: boolean;
    runHourUtc: number;
    active: boolean;
    model: "claude-sonnet-4-6" | "claude-opus-4-1" | "claude-haiku-4-5";
    temperature: number;
    maxTokens: number;
    economicAxis: number;
    socialAxis: number;
    tone: string;
    sentenceRhythm: string;
    vocabularyQuirks: string;
    signatureMove: string;
    corePromise: string;
    avoid: string;
    technicalExplanationStyle: string;
  } | null>(null);
  const { data: modelsData } = useListLlmModels();

  // Portraits generated this session (plus the saved one) so the admin can
  // generate several and pick a favourite instead of each click overwriting the
  // last. Lives in component state only; the chosen URL is persisted on Save.
  const [avatarOptions, setAvatarOptions] = useState<string[]>([]);

  useEffect(() => {
    if (author && !form) {
      setAvatarOptions(author.avatarUrl ? [author.avatarUrl] : []);
      const econ = typeof author.economicAxis === "string" ? Number(author.economicAxis) : (author.economicAxis ?? 0);
      const social = typeof author.socialAxis === "string" ? Number(author.socialAxis) : (author.socialAxis ?? 0);
      setForm({
        name: author.name,
        slug: author.slug,
        bio: author.bio,
        avatarUrl: author.avatarUrl,
        category: author.category,
        categorySlug: author.categorySlug,
        subBeats: author.subBeats ?? [],
        voicePrompt: author.voicePrompt,
        sampleParagraphs: (author.sampleParagraphs ?? []).join("\n\n---\n\n"),
        bannedTopics: (author.bannedTopics ?? []).join(", "),
        wordCountTarget: author.wordCountTarget,
        cadence: author.cadence,
        weekday: author.weekday ?? null,
        secondWeekday: author.secondWeekday ?? null,
        dayOfMonth: author.dayOfMonth ?? null,
        randomizeSchedule: author.randomizeSchedule ?? true,
        runHourUtc: author.runHourUtc ?? 14,
        active: author.active,
        model: (author.model as "claude-sonnet-4-6" | "claude-opus-4-1" | "claude-haiku-4-5") ?? "claude-sonnet-4-6",
        temperature: typeof author.temperature === "string" ? Number(author.temperature) : (author.temperature ?? 1.0),
        maxTokens: author.maxTokens ?? 8192,
        economicAxis: Number.isFinite(econ) ? (econ as number) : 0,
        socialAxis: Number.isFinite(social) ? (social as number) : 0,
        tone: author.tone ?? "",
        sentenceRhythm: author.sentenceRhythm ?? "",
        vocabularyQuirks: author.vocabularyQuirks ?? "",
        signatureMove: author.signatureMove ?? "",
        corePromise: author.corePromise ?? "",
        avoid: author.avoid ?? "",
        technicalExplanationStyle: author.technicalExplanationStyle ?? "",
      });
    }
  }, [author, form]);

  const generateAvatar = useGenerateAuthorAvatar({
    mutation: {
      onSuccess: (data) => {
        setForm((f) => (f ? { ...f, avatarUrl: data.url } : f));
        setAvatarOptions((opts) => (opts.includes(data.url) ? opts : [...opts, data.url]));
        toast.success("New portrait generated — pick one and save");
      },
      onError: (err) => {
        const e = err as unknown as { data?: { error?: string } };
        toast.error(e?.data?.error ?? "Avatar generation failed.");
      },
    },
  });

  const update = useUpdateAuthor({
    mutation: {
      onSuccess: () => {
        toast.success("Saved");
        qc.invalidateQueries({ queryKey: getGetAuthorQueryKey(id) });
      },
      onError: () => toast.error("Save failed"),
    },
  });

  // Sub-beat changes auto-save without disturbing the rest of the form, so
  // an admin toggling chips doesn't have to remember to hit "Save profile".
  const [subBeatsJustSaved, setSubBeatsJustSaved] = useState(false);
  const autosaveSubBeats = useUpdateAuthor({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAuthorQueryKey(id) });
        setSubBeatsJustSaved(true);
        window.setTimeout(() => setSubBeatsJustSaved(false), 1500);
      },
      onError: () => toast.error("Couldn't save beats"),
    },
  });
  const handleSubBeatsChange = (next: string[]) => {
    if (!form) return;
    const cleaned = next.filter((s) => s !== form.categorySlug);
    setForm({ ...form, subBeats: cleaned });
    autosaveSubBeats.mutate({ id, data: { subBeats: cleaned } });
  };

  const [newIdea, setNewIdea] = useState({ title: "", angle: "" });
  const [ideaDuplicateWarning, setIdeaDuplicateWarning] = useState<string | null>(null);
  const createIdea = useCreateCustomIdea({
    mutation: {
      onSuccess: () => {
        setNewIdea({ title: "", angle: "" });
        setIdeaDuplicateWarning(null);
        toast.success("Idea added");
        qc.invalidateQueries({ queryKey: getListIdeasForAuthorQueryKey(id) });
      },
      onError: (err) => {
        const e = err as unknown as { status?: number; data?: { message?: string } };
        if (e?.status === 409) {
          setIdeaDuplicateWarning(e.data?.message ?? "Too similar to an existing idea or article.");
        } else {
          setIdeaDuplicateWarning(null);
          toast.error(e?.data?.message ?? "Failed to add idea");
        }
      },
    },
  });

  const submitNewIdea = (force = false) => {
    const title = newIdea.title.trim();
    const angle = newIdea.angle.trim();
    if (!title || !angle) return;
    if (!force) setIdeaDuplicateWarning(null);
    createIdea.mutate({
      data: { title, angle, authorId: id, status: "approved" },
      ...(force ? { params: { force: "1" } } : {}),
    });
  };

  const generateIdeas = useGenerateIdeas({
    mutation: {
      onSuccess: () => {
        toast.success("New ideas generated");
        qc.invalidateQueries({ queryKey: getListIdeasForAuthorQueryKey(id) });
      },
      onError: (err) => {
        const e = err as unknown as { status?: number; data?: { message?: string } };
        toast.error(
          e?.status === 409
            ? e.data?.message ?? "Idea cap reached — draft some before generating more."
            : "Generation failed",
        );
      },
    },
  });

  const generateCrossover = useGenerateCrossoverIdeas({
    mutation: {
      onSuccess: (data) => {
        const n = (data as { items?: unknown[] })?.items?.length ?? 0;
        toast.success(n > 0 ? `${n} crossover idea${n === 1 ? "" : "s"} generated` : "No crossover ideas passed the dedupe filter");
        qc.invalidateQueries({ queryKey: getListIdeasForAuthorQueryKey(id) });
      },
      onError: (err) => {
        const e = err as unknown as { status?: number; data?: { message?: string } };
        toast.error(e?.status === 409 ? e.data?.message ?? "Can't generate crossover ideas right now." : "Crossover generation failed");
      },
    },
  });

  const updateIdea = useUpdateIdea({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListIdeasForAuthorQueryKey(id) }) },
  });
  const approveIdea = useUpdateIdea({
    mutation: {
      onSuccess: () => {
        toast.success("Idea approved");
        qc.invalidateQueries({ queryKey: getListIdeasForAuthorQueryKey(id) });
      },
      onError: () => toast.error("Couldn't approve idea"),
    },
  });
  const approveAll = useApproveAllIdeasForAuthor({
    mutation: {
      onSuccess: (data) => {
        toast.success(
          data.approved === 0
            ? "No pending ideas to approve"
            : `Approved ${data.approved} idea${data.approved === 1 ? "" : "s"}`,
        );
        qc.invalidateQueries({ queryKey: getListIdeasForAuthorQueryKey(id) });
      },
      onError: () => toast.error("Couldn't approve ideas"),
    },
  });
  const deleteIdea = useDeleteIdea({
    mutation: { onSuccess: () => qc.invalidateQueries({ queryKey: getListIdeasForAuthorQueryKey(id) }) },
  });
  const draftFromIdea = useGenerateDraft({
    mutation: {
      onSuccess: (article) => {
        toast.success("Draft created");
        qc.invalidateQueries({ queryKey: getListArticlesQueryKey() });
        qc.invalidateQueries({ queryKey: getListIdeasForAuthorQueryKey(id) });
        setLocation(`/admin/articles/${article.id}`);
      },
      onError: (err) => {
        const e = err as unknown as { status?: number; data?: { message?: string } };
        if (e?.status === 409) {
          toast.error(e.data?.message ?? "Idea is too similar to an existing article — auto-rejected.");
          qc.invalidateQueries({ queryKey: getListIdeasForAuthorQueryKey(id) });
        } else {
          toast.error("Draft failed");
        }
      },
    },
  });

  if (isLoading || !author || !form) return <div className="p-4 md:p-8"><Loader2 className="animate-spin" /></div>;

  const handleSave = () => {
    update.mutate({
      id,
      data: {
        name: form.name,
        slug: form.slug.trim(),
        bio: form.bio,
        avatarUrl: form.avatarUrl,
        category: form.category,
        categorySlug: form.categorySlug,
        subBeats: form.subBeats.filter((s) => s !== form.categorySlug),
        voicePrompt: form.voicePrompt,
        sampleParagraphs: form.sampleParagraphs.split(/\n\s*---\s*\n/).map((s) => s.trim()).filter(Boolean),
        bannedTopics: form.bannedTopics.split(",").map((s) => s.trim()).filter(Boolean),
        wordCountTarget: form.wordCountTarget,
        cadence: form.cadence,
        weekday:
          form.cadence === "weekly" || form.cadence === "biweekly" || form.cadence === "twice_weekly"
            ? form.weekday
            : null,
        secondWeekday: form.cadence === "twice_weekly" ? form.secondWeekday : null,
        dayOfMonth: form.cadence === "monthly" ? form.dayOfMonth : null,
        randomizeSchedule: form.randomizeSchedule,
        runHourUtc: form.runHourUtc,
        active: form.active,
        model: form.model,
        temperature: form.temperature,
        maxTokens: form.maxTokens,
        economicAxis: form.economicAxis,
        socialAxis: form.socialAxis,
        tone: form.tone.trim() || null,
        sentenceRhythm: form.sentenceRhythm.trim() || null,
        vocabularyQuirks: form.vocabularyQuirks.trim() || null,
        signatureMove: form.signatureMove.trim() || null,
        corePromise: form.corePromise.trim() || null,
        avoid: form.avoid.trim() || null,
        technicalExplanationStyle: form.technicalExplanationStyle.trim() || null,
      },
    });
  };

  const ideas = ideasData?.items ?? [];
  const pending = ideas.filter((i) => i.status === "pending");
  const approved = ideas.filter((i) => i.status === "approved");
  const rejected = ideas.filter((i) => i.status === "rejected" || i.status === "used");
  // Keep in sync with MAX_APPROVED_IDEAS on the server. Once an author's bank of
  // approved (ready-to-draft) ideas hits the cap, idea generation pauses until
  // it drains.
  const APPROVED_IDEA_CAP = 20;
  const ideaCapReached = approved.length >= APPROVED_IDEA_CAP;
  const drafts = draftsData?.items ?? [];
  const recentPublished = (publishedData?.items ?? []).slice(0, 5);

  return (
    <div className="p-4 md:p-8 max-w-5xl space-y-8">
      <div className="flex items-start gap-6">
        <img src={form.avatarUrl.startsWith("/") ? `${import.meta.env.BASE_URL.replace(/\/$/, "")}${form.avatarUrl}` : form.avatarUrl} alt={author.name} className="h-20 w-20 rounded-full bg-muted shrink-0 object-cover" />
        <div className="flex-1">
          <p className="text-xs uppercase tracking-wider text-primary">{author.category}</p>
          <h1 className="font-serif text-3xl font-bold">{author.name}</h1>
          {form.subBeats.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Also writes on</span>
              {form.subBeats.map((slug) => (
                <span key={slug} className="text-xs px-2 py-0.5 rounded-full bg-violet-100 text-violet-700">
                  {beatNameBySlug.get(slug) ?? slug}
                </span>
              ))}
            </div>
          )}
        </div>
        <DeleteAuthorButton id={id} name={author.name} onDeleted={() => setLocation("/admin/authors")} />
      </div>

      <Card className="p-6 space-y-3">
        <div className="flex items-center gap-2">
          <ImageIcon className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-serif text-xl font-bold">Portrait</h2>
        </div>
        <div className="flex items-start gap-4">
          <img
            src={form.avatarUrl.startsWith("/") ? `${import.meta.env.BASE_URL.replace(/\/$/, "")}${form.avatarUrl}` : form.avatarUrl}
            alt=""
            className="h-16 w-16 shrink-0 rounded-full bg-muted border object-cover"
          />
          <div className="flex-1 space-y-2">
            <Input
              value={form.avatarUrl}
              onChange={(e) => setForm({ ...form, avatarUrl: e.target.value })}
              placeholder="Avatar URL"
            />
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  generateAvatar.mutate({
                    data: {
                      name: form.name,
                      bio: form.bio || null,
                      voicePrompt: form.voicePrompt || null,
                      tone: form.tone || null,
                      category: form.category || null,
                      // Derive the filename from the current name field so a
                      // renamed author's new portrait isn't filed under the old
                      // name. Server slugifies this hint.
                      slugHint: form.name.trim() || author.slug,
                    },
                  })
                }
                disabled={generateAvatar.isPending}
              >
                {generateAvatar.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4 mr-2" />
                )}
                {generateAvatar.isPending
                  ? "Generating portrait…"
                  : avatarOptions.length > 0
                    ? "Generate another"
                    : "Generate from persona"}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleSave}
                disabled={update.isPending || form.avatarUrl === author.avatarUrl}
              >
                {update.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save portrait
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Uses the current name, bio, voice, and tone fields. Generate as many as you like, click one to choose it, then Save portrait to persist.
            </p>
          </div>
        </div>

        {avatarOptions.length > 1 && (
          <div className="space-y-2 pt-1">
            <p className="text-xs font-medium text-muted-foreground">
              Choose a portrait ({avatarOptions.length})
            </p>
            <div className="flex flex-wrap gap-3">
              {avatarOptions.map((url) => {
                const selected = url === form.avatarUrl;
                return (
                  <button
                    key={url}
                    type="button"
                    onClick={() => setForm({ ...form, avatarUrl: url })}
                    className={`relative h-20 w-20 shrink-0 overflow-hidden rounded-full border bg-muted transition focus:outline-none focus:ring-2 focus:ring-primary ${
                      selected ? "ring-2 ring-primary ring-offset-2" : "hover:opacity-90"
                    }`}
                    aria-label={selected ? "Selected portrait" : "Choose this portrait"}
                    aria-pressed={selected}
                  >
                    <img
                      src={url.startsWith("/") ? `${import.meta.env.BASE_URL.replace(/\/$/, "")}${url}` : url}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                    {selected && (
                      <span className="absolute bottom-0.5 right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                        <Check className="h-3 w-3" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </Card>

      <Card className="p-6 space-y-4">
        <h2 className="font-serif text-xl font-bold">Profile & voice</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><Label>Word count target</Label><Input type="number" value={form.wordCountTarget} onChange={(e) => setForm({ ...form, wordCountTarget: Number(e.target.value) })} /></div>
        </div>
        <div>
          <Label>URL slug</Label>
          <Input
            value={form.slug}
            onChange={(e) => setForm({ ...form, slug: e.target.value })}
            placeholder="kebab-case (a-z, 0-9, -)"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            The author's public URL is <code>/author/{form.slug || "…"}</code>. Changing it after a
            rename automatically redirects the old URL so existing links don't break.
          </p>
        </div>
        <div><Label>Bio (shown on public site)</Label><Textarea rows={2} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} /></div>
        <CategoryPicker
          category={form.category}
          categorySlug={form.categorySlug}
          onChange={({ category, categorySlug }) => setForm({ ...form, category, categorySlug })}
          required
        />
        <SubBeatsPicker
          primarySlug={form.categorySlug}
          subBeats={form.subBeats}
          onChange={handleSubBeatsChange}
          saving={autosaveSubBeats.isPending}
          justSaved={subBeatsJustSaved}
        />
        <div><Label>Voice prompt (used by the model)</Label><Textarea rows={6} value={form.voicePrompt} onChange={(e) => setForm({ ...form, voicePrompt: e.target.value })} /></div>
        <div>
          <Label>Sample paragraphs (separate by <code>---</code> on its own line)</Label>
          <Textarea rows={6} value={form.sampleParagraphs} onChange={(e) => setForm({ ...form, sampleParagraphs: e.target.value })} />
        </div>
        <div><Label>Banned topics (comma-separated)</Label><Input value={form.bannedTopics} onChange={(e) => setForm({ ...form, bannedTopics: e.target.value })} /></div>

        <div className="space-y-4 pt-2">
          <div className="flex items-center gap-2">
            <Switch checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v })} />
            <Label>Active in pipeline</Label>
            {ideaCapReached && (
              <span
                className="inline-flex items-center rounded-full bg-amber-100 text-amber-800 border border-amber-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                title={`${approved.length} approved ideas (cap ${APPROVED_IDEA_CAP}) — new idea generation is paused until the backlog drains as drafts are written`}
              >
                Ideas paused
              </span>
            )}
          </div>
          <ScheduleFields
            values={form}
            onChange={(patch) => setForm((f) => (f ? { ...f, ...patch } : f))}
          />
        </div>

        <Button onClick={handleSave} disabled={update.isPending}>{update.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save profile</Button>
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <h2 className="font-serif text-xl font-bold">Voice craft</h2>
          <p className="text-sm text-muted-foreground">
            Short, opinionated guidance fed straight into the system prompt. Leave any field blank to skip it.
          </p>
        </div>
        <VoiceCraftFields
          values={{
            tone: form.tone,
            sentenceRhythm: form.sentenceRhythm,
            vocabularyQuirks: form.vocabularyQuirks,
            signatureMove: form.signatureMove,
            corePromise: form.corePromise,
            avoid: form.avoid,
            technicalExplanationStyle: form.technicalExplanationStyle,
          }}
          onChange={(patch) => setForm({ ...form, ...patch })}
        />
        <Button onClick={handleSave} disabled={update.isPending}>
          {update.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save voice craft
        </Button>
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <h2 className="font-serif text-xl font-bold">Political compass</h2>
          <p className="text-sm text-muted-foreground">
            Used as an undertone in the persona prompt — never as a soapbox. Leave both at 0 for a neutral writer.
          </p>
        </div>
        <CompassSliders
          economicAxis={form.economicAxis}
          socialAxis={form.socialAxis}
          onChange={(econ, social) => setForm({ ...form, economicAxis: econ, socialAxis: social })}
        />
        <Button onClick={handleSave} disabled={update.isPending}>
          {update.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save compass
        </Button>
      </Card>

      <Card className="p-6 space-y-4">
        <div>
          <h2 className="font-serif text-xl font-bold">Model & sampling</h2>
          <p className="text-sm text-muted-foreground">Pick which Claude model writes for {author.name} and how adventurous it should be. These apply to idea generation, drafting, and section rewrites.</p>
        </div>
        <div>
          <Label>Model</Label>
          <select
            className="border rounded px-2 py-2 bg-background w-full"
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value as typeof form.model })}
          >
            {(modelsData?.items ?? [{ id: form.model, label: form.model }]).map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <Label>Temperature</Label>
            <span className="text-sm text-muted-foreground tabular-nums">{form.temperature.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={form.temperature}
            onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-muted-foreground mt-1">
            <span>0 — deterministic</span>
            <span>1 — balanced</span>
            <span>2 — wildly creative</span>
          </div>
        </div>
        <div>
          <Label>Max tokens per response</Label>
          <Input
            type="number"
            min={1024}
            max={16384}
            step={256}
            value={form.maxTokens}
            onChange={(e) => setForm({ ...form, maxTokens: Math.max(1024, Math.min(16384, Number(e.target.value) || 8192)) })}
          />
          <p className="text-xs text-muted-foreground mt-1">Caps draft length. 8192 fits a ~2200-word feature comfortably.</p>
        </div>
        <Button onClick={handleSave} disabled={update.isPending}>
          {update.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save model settings
        </Button>
      </Card>

      <Card className="p-6 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-xl font-bold">Drafts awaiting review</h2>
          <span className="text-xs text-muted-foreground">{drafts.length} draft{drafts.length === 1 ? "" : "s"}</span>
        </div>
        {drafts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No drafts in the queue for {author.name} right now.</p>
        ) : (
          <ul className="space-y-2">
            {drafts.map((d) => (
              <li key={d.id}>
                <Link href={`/admin/articles/${d.id}`} className="block border rounded-lg p-3 hover:border-primary">
                  <div className="flex items-center gap-2">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">draft</span>
                    {d.continuesArticleId && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Follow-up</span>}
                    <span className="text-xs text-muted-foreground ml-auto">Updated {format(new Date(d.updatedAt), "MMM d")}</span>
                  </div>
                  <div className="font-serif font-bold mt-1 truncate">{d.title}</div>
                  <p className="text-sm text-muted-foreground line-clamp-1">{d.dek}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-6 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-xl font-bold">Recent published</h2>
          <Link href={`/admin/articles?status=published`} className="text-xs text-primary hover:underline">View all →</Link>
        </div>
        {recentPublished.length === 0 ? (
          <p className="text-sm text-muted-foreground">{author.name} hasn't published anything yet.</p>
        ) : (
          <ul className="space-y-2">
            {recentPublished.map((a) => (
              <li key={a.id}>
                <Link href={`/admin/articles/${a.id}`} className="block border rounded-lg p-3 hover:border-primary">
                  <div className="flex items-center gap-2">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">published</span>
                    <span className="text-xs text-muted-foreground ml-auto">{a.publishedAt ? format(new Date(a.publishedAt), "MMM d, yyyy") : "—"}</span>
                  </div>
                  <div className="font-serif font-bold mt-1 truncate">{a.title}</div>
                  <p className="text-sm text-muted-foreground line-clamp-1">{a.dek}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-serif text-xl font-bold">Topic ideas</h2>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => generateCrossover.mutate({ id })}
              disabled={generateCrossover.isPending || ideaCapReached || form.subBeats.filter((s) => s !== form.categorySlug).length === 0}
              title={
                form.subBeats.filter((s) => s !== form.categorySlug).length === 0
                  ? "Assign sub-beats to this author first to generate cross-sectional ideas"
                  : ideaCapReached
                    ? `At the ${APPROVED_IDEA_CAP}-approved-idea cap — draft some before generating more`
                    : "Generate ideas that blend this author's primary beat with one of their sub-beats"
              }
            >
              {generateCrossover.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
              Generate crossover ideas
            </Button>
            <Button
              variant="outline"
              onClick={() => generateIdeas.mutate({ id })}
              disabled={generateIdeas.isPending || ideaCapReached}
              title={ideaCapReached ? `At the ${APPROVED_IDEA_CAP}-approved-idea cap — draft some before generating more` : undefined}
            >
              {generateIdeas.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
              {ideaCapReached ? "Idea cap reached" : "Generate 5 new ideas"}
            </Button>
          </div>
        </div>

        <div className="border rounded-lg p-3 bg-muted/30 space-y-2">
          <div className="text-sm font-semibold">Add a topic idea manually</div>
          <Input placeholder="Working title" value={newIdea.title} onChange={(e) => { setNewIdea({ ...newIdea, title: e.target.value }); setIdeaDuplicateWarning(null); }} />
          <Input placeholder="One-sentence editorial angle" value={newIdea.angle} onChange={(e) => { setNewIdea({ ...newIdea, angle: e.target.value }); setIdeaDuplicateWarning(null); }} />
          <Button size="sm" disabled={!newIdea.title || !newIdea.angle || createIdea.isPending} onClick={() => submitNewIdea(false)}>
            {createIdea.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Add as approved
          </Button>
          {ideaDuplicateWarning && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 flex items-start gap-3">
              <div className="flex-1">{ideaDuplicateWarning}</div>
              <Button size="sm" variant="outline" onClick={() => submitNewIdea(true)} disabled={createIdea.isPending}>
                Add anyway
              </Button>
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-2 gap-2">
            <h3 className="text-sm font-semibold">Pending review ({pending.length})</h3>
            <Button
              size="sm"
              variant="outline"
              disabled={pending.length === 0 || approveAll.isPending}
              onClick={() => approveAll.mutate({ id })}
              title="Approve every pending idea for this author"
            >
              {approveAll.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Check className="h-4 w-4 mr-2 text-emerald-600" />}
              Approve all ({pending.length})
            </Button>
          </div>
          <IdeaGroup title="" ideas={pending} beatNameBySlug={beatNameBySlug} onApprove={(id) => approveIdea.mutate({ id, data: { status: "approved" } })} onReject={(id) => updateIdea.mutate({ id, data: { status: "rejected" } })} onDelete={(id) => deleteIdea.mutate({ id })} onDraft={(id) => draftFromIdea.mutate({ id })} onUpdateSecondary={(ideaId, next) => updateIdea.mutate({ id: ideaId, data: { secondaryBeats: next.length ? next : null } })} drafting={draftFromIdea.isPending} approvingId={approveIdea.isPending ? approveIdea.variables?.id : undefined} emptyLabel="No pending ideas." />
        </div>
        <IdeaGroup title={`Approved (${approved.length})`} ideas={approved} beatNameBySlug={beatNameBySlug} onApprove={() => {}} onReject={(id) => updateIdea.mutate({ id, data: { status: "rejected" } })} onDelete={(id) => deleteIdea.mutate({ id })} onDraft={(id) => draftFromIdea.mutate({ id })} onUpdateSecondary={(ideaId, next) => updateIdea.mutate({ id: ideaId, data: { secondaryBeats: next.length ? next : null } })} drafting={draftFromIdea.isPending} hideApprove />
        {rejected.length > 0 && <details><summary className="cursor-pointer text-sm text-muted-foreground">Rejected & used ({rejected.length})</summary><IdeaGroup title="" ideas={rejected} beatNameBySlug={beatNameBySlug} onApprove={() => {}} onReject={() => {}} onDelete={(id) => deleteIdea.mutate({ id })} onDraft={() => {}} drafting={false} hideApprove hideReject hideDraft /></details>}
      </Card>
    </div>
  );
}

function IdeaGroup({ title, ideas, beatNameBySlug, onApprove, onReject, onDelete, onDraft, onUpdateSecondary, drafting, approvingId, hideApprove, hideReject, hideDraft, emptyLabel }: {
  title: string;
  ideas: TopicIdea[];
  beatNameBySlug?: Map<string, string>;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onDelete: (id: string) => void;
  onDraft: (id: string) => void;
  /** When provided, secondary subjects are editable; otherwise shown read-only. */
  onUpdateSecondary?: (id: string, next: string[]) => void;
  drafting: boolean;
  approvingId?: string | undefined;
  hideApprove?: boolean;
  hideReject?: boolean;
  hideDraft?: boolean;
  emptyLabel?: string;
}) {
  if (ideas.length === 0 && title) return <div><h3 className="text-sm font-semibold mb-2">{title}</h3><p className="text-sm text-muted-foreground">{emptyLabel ?? "No ideas here yet."}</p></div>;
  if (ideas.length === 0) return emptyLabel ? <p className="text-sm text-muted-foreground">{emptyLabel}</p> : null;
  return (
    <div>
      {title && <h3 className="text-sm font-semibold mb-2">{title}</h3>}
      <ul className="space-y-2">
        {ideas.map((i) => (
          <li key={i.id} className="border rounded-lg p-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="font-medium">{i.title}</div>
              <div className="text-sm text-muted-foreground">{i.angle}</div>
              {onUpdateSecondary ? (
                <div className="mt-1">
                  <SecondaryBeatsEditor
                    primarySlug={i.categorySlug ?? ""}
                    value={i.secondaryBeats ?? []}
                    onChange={(next) => onUpdateSecondary(i.id, next)}
                  />
                </div>
              ) : (
                i.secondaryBeats && i.secondaryBeats.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 mt-1">
                    <span className="text-[10px] uppercase tracking-wide text-violet-600 font-semibold">Crossover</span>
                    {i.secondaryBeats.map((s) => (
                      <span key={s} className="text-xs px-2 py-0.5 rounded-full bg-violet-100 text-violet-700">
                        + {beatNameBySlug?.get(s) ?? s}
                      </span>
                    ))}
                  </div>
                )
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {!hideApprove && <Button size="icon" variant="ghost" onClick={() => onApprove(i.id)} disabled={approvingId === i.id} title="Approve">{approvingId === i.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4 text-emerald-600" />}</Button>}
              {!hideReject && <Button size="icon" variant="ghost" onClick={() => onReject(i.id)} title="Reject"><X className="h-4 w-4 text-rose-600" /></Button>}
              {!hideDraft && <Button size="icon" variant="ghost" onClick={() => onDraft(i.id)} disabled={drafting} title="Draft article"><FileEdit className="h-4 w-4" /></Button>}
              <Button size="icon" variant="ghost" onClick={() => onDelete(i.id)} title="Delete"><Trash2 className="h-4 w-4 text-muted-foreground" /></Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeleteAuthorButton({ id, name, onDeleted }: { id: string; name: string; onDeleted: () => void }) {
  const del = useDeleteAuthor();
  const onClick = async () => {
    if (!window.confirm(`Permanently delete ${name}? This cannot be undone. Authors with existing articles cannot be deleted.`)) return;
    try {
      await del.mutateAsync({ id });
      toast.success(`${name} deleted`);
      onDeleted();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string; articles?: number } } };
      const n = err?.response?.data?.articles;
      const detail = typeof n === "number" ? ` (${n} article${n === 1 ? "" : "s"} on file)` : "";
      toast.error((err?.response?.data?.error ?? "Failed to delete author") + detail);
    }
  };
  return (
    <Button variant="ghost" className="text-destructive hover:text-destructive shrink-0" onClick={onClick} disabled={del.isPending} title="Delete author">
      {del.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Trash2 className="h-4 w-4 mr-1" />} Delete
    </Button>
  );
}
