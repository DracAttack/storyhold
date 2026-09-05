import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateAuthor,
  useGenerateAuthorAvatar,
  useListLlmModels,
  getListAuthorsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, ArrowLeft, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { Link } from "wouter";
import { CategoryPicker } from "@/components/admin/CategoryPicker";
import { SubBeatsPicker } from "@/components/admin/SubBeatsPicker";

const DEFAULT_AVATAR =
  "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=320&h=320&fit=crop&auto=format";

export type CadenceValue = "daily" | "twice_weekly" | "weekly" | "biweekly" | "monthly";

export interface ScheduleValues {
  cadence: CadenceValue;
  weekday: number | null;
  secondWeekday: number | null;
  dayOfMonth: number | null;
  runHourUtc: number;
  randomizeSchedule: boolean;
}

const CADENCE_LABELS: Record<CadenceValue, string> = {
  daily: "Daily",
  twice_weekly: "Twice a week",
  weekly: "Weekly",
  biweekly: "Every two weeks",
  monthly: "Once a month",
};

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function cadenceUsesWeekday(c: CadenceValue): boolean {
  return c === "weekly" || c === "biweekly" || c === "twice_weekly";
}

/**
 * Shared schedule editor used by the new-author and author-detail forms. Renders
 * the cadence picker plus the day/day-of-month/run-hour controls relevant to the
 * chosen cadence and the "shuffle day after each post" toggle (hidden for daily).
 */
export function ScheduleFields({
  values,
  onChange,
}: {
  values: ScheduleValues;
  onChange: (patch: Partial<ScheduleValues>) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-6">
      <div className="flex flex-col gap-1">
        <Label>Cadence</Label>
        <select
          className="border rounded px-2 py-1 bg-background"
          value={values.cadence}
          onChange={(e) => {
            const cadence = e.target.value as CadenceValue;
            const patch: Partial<ScheduleValues> = { cadence };
            if (cadence === "daily") {
              patch.weekday = null;
              patch.secondWeekday = null;
              patch.dayOfMonth = null;
            } else if (cadence === "monthly") {
              patch.weekday = null;
              patch.secondWeekday = null;
              patch.dayOfMonth = values.dayOfMonth ?? 1;
            } else {
              patch.weekday = values.weekday ?? 1;
              patch.dayOfMonth = null;
              patch.secondWeekday = cadence === "twice_weekly" ? values.secondWeekday ?? 4 : null;
            }
            onChange(patch);
          }}
        >
          {(Object.keys(CADENCE_LABELS) as CadenceValue[]).map((v) => (
            <option key={v} value={v}>
              {CADENCE_LABELS[v]}
            </option>
          ))}
        </select>
      </div>

      {cadenceUsesWeekday(values.cadence) && (
        <div className="flex flex-col gap-1">
          <Label>{values.cadence === "twice_weekly" ? "First day" : "Day"}</Label>
          <select
            className="border rounded px-2 py-1 bg-background"
            value={values.weekday ?? 1}
            onChange={(e) => {
              const weekday = Number(e.target.value);
              const patch: Partial<ScheduleValues> = { weekday };
              // Keep the two twice-a-week days distinct: if the new first day
              // collides with the second, shift the second to the next weekday.
              if (values.cadence === "twice_weekly" && values.secondWeekday === weekday) {
                patch.secondWeekday = (weekday + 1) % 7;
              }
              onChange(patch);
            }}
          >
            {WEEKDAY_LABELS.map((d, i) => (
              <option key={i} value={i}>
                {d}
              </option>
            ))}
          </select>
        </div>
      )}

      {values.cadence === "twice_weekly" && (
        <div className="flex flex-col gap-1">
          <Label>Second day</Label>
          <select
            className="border rounded px-2 py-1 bg-background"
            value={values.secondWeekday ?? 4}
            onChange={(e) => onChange({ secondWeekday: Number(e.target.value) })}
          >
            {WEEKDAY_LABELS.map((d, i) => (
              <option key={i} value={i} disabled={i === (values.weekday ?? 1)}>
                {d}
                {i === (values.weekday ?? 1) ? " (first day)" : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      {values.cadence === "monthly" && (
        <div className="flex flex-col gap-1">
          <Label>Day of month</Label>
          <select
            className="border rounded px-2 py-1 bg-background"
            value={values.dayOfMonth ?? 1}
            onChange={(e) => onChange({ dayOfMonth: Number(e.target.value) })}
          >
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <Label>Run hour (UTC)</Label>
        <select
          className="border rounded px-2 py-1 bg-background"
          value={values.runHourUtc}
          onChange={(e) => onChange({ runHourUtc: Number(e.target.value) })}
        >
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              {String(h).padStart(2, "0")}:05 UTC
            </option>
          ))}
        </select>
      </div>

      {values.cadence !== "daily" && (
        <div className="flex items-center gap-2 pb-1">
          <Switch
            checked={values.randomizeSchedule}
            onCheckedChange={(v) => onChange({ randomizeSchedule: v })}
          />
          <Label>Shuffle day after each post</Label>
        </div>
      )}
    </div>
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export default function AuthorNew() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { data: modelsData } = useListLlmModels();

  const [form, setForm] = useState({
    slug: "",
    slugTouched: false,
    name: "",
    bio: "",
    avatarUrl: DEFAULT_AVATAR,
    category: "",
    categorySlug: "",
    categorySlugTouched: false,
    subBeats: [] as string[],
    voicePrompt: "",
    sampleParagraphs: "",
    bannedTopics: "",
    wordCountTarget: 2200,
    cadence: "weekly" as CadenceValue,
    weekday: 1 as number | null,
    secondWeekday: 4 as number | null,
    dayOfMonth: 1 as number | null,
    randomizeSchedule: true,
    runHourUtc: 14,
    active: true,
    model: "claude-sonnet-4-6" as "claude-sonnet-4-6" | "claude-opus-4-1" | "claude-haiku-4-5",
    temperature: 1.0,
    maxTokens: 8192,
    economicAxis: 0,
    socialAxis: 0,
    tone: "",
    sentenceRhythm: "",
    vocabularyQuirks: "",
    signatureMove: "",
    corePromise: "",
    avoid: "",
    technicalExplanationStyle: "",
  });

  const create = useCreateAuthor({
    mutation: {
      onSuccess: (author) => {
        toast.success(`Created ${author.name}`);
        qc.invalidateQueries({ queryKey: getListAuthorsQueryKey() });
        setLocation(`/admin/authors/${author.id}`);
      },
      onError: (err) => {
        const e = err as unknown as {
          status?: number;
          data?: { error?: string; details?: { issues?: Array<{ path?: (string | number)[]; message?: string }> } };
        };
        if (e?.status === 409) {
          toast.error(e.data?.error ?? "An author with that slug already exists.");
          return;
        }
        const issues = e?.data?.details?.issues ?? [];
        if (issues.length > 0) {
          const summary = issues
            .slice(0, 3)
            .map((i) => `${(i.path ?? []).join(".") || "field"}: ${i.message ?? "invalid"}`)
            .join(" • ");
          toast.error(`Validation failed — ${summary}`);
          return;
        }
        toast.error(e?.data?.error ?? "Could not create author.");
      },
    },
  });

  const generateAvatar = useGenerateAuthorAvatar({
    mutation: {
      onSuccess: (data) => {
        setForm((f) => ({ ...f, avatarUrl: data.url }));
        toast.success("Avatar generated");
      },
      onError: (err) => {
        const e = err as unknown as { data?: { error?: string } };
        toast.error(e?.data?.error ?? "Avatar generation failed.");
      },
    },
  });

  const handleGenerateAvatar = () => {
    if (!form.name.trim()) {
      toast.error("Add a name first so the portrait matches the persona.");
      return;
    }
    generateAvatar.mutate({
      data: {
        name: form.name.trim(),
        bio: form.bio.trim() || null,
        voicePrompt: form.voicePrompt.trim() || null,
        tone: form.tone.trim() || null,
        category: form.category.trim() || null,
        slugHint: form.slug || slugify(form.name),
      },
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.bio || !form.category || !form.voicePrompt) {
      toast.error("Name, bio, category, and voice prompt are required.");
      return;
    }
    const finalSlug = slugify(form.slug || form.name);
    if (!finalSlug) {
      toast.error("Could not derive a URL slug from the name. Please add a slug.");
      return;
    }
    create.mutate({
      data: {
        slug: finalSlug,
        name: form.name,
        bio: form.bio,
        avatarUrl: form.avatarUrl,
        category: form.category,
        categorySlug: slugify(form.categorySlug || form.category),
        voicePrompt: form.voicePrompt,
        sampleParagraphs: form.sampleParagraphs.split(/\n\s*---\s*\n/).map((s) => s.trim()).filter(Boolean),
        bannedTopics: form.bannedTopics.split(",").map((s) => s.trim()).filter(Boolean),
        subBeats: form.subBeats.filter((s) => s !== (form.categorySlug || slugify(form.category))),
        wordCountTarget: form.wordCountTarget,
        cadence: form.cadence,
        weekday: cadenceUsesWeekday(form.cadence) ? form.weekday : null,
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

  return (
    <div className="p-4 md:p-8 max-w-4xl space-y-6">
      <div>
        <Link href="/admin/authors" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to authors
        </Link>
        <h1 className="font-serif text-3xl font-bold mt-2">New author</h1>
        <p className="text-muted-foreground">Spin up a new persona for the magazine.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card className="p-6 space-y-4">
          <h2 className="font-serif text-xl font-bold">Identity</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label>Name</Label>
              <Input
                value={form.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setForm((f) => ({
                    ...f,
                    name,
                    slug: f.slugTouched ? f.slug : slugify(name),
                  }));
                }}
                placeholder="e.g. Dr. Maya Chen"
                required
              />
            </div>
            <div>
              <Label>Slug</Label>
              <Input
                value={form.slug}
                onChange={(e) => setForm((f) => ({ ...f, slug: slugify(e.target.value), slugTouched: true }))}
                placeholder="maya-chen"
                pattern="[a-z0-9-]+"
                required
              />
              <p className="text-xs text-muted-foreground mt-1">Lowercase, dashes only. Used in URLs.</p>
            </div>
          </div>
          <CategoryPicker
            category={form.category}
            categorySlug={form.categorySlug}
            onChange={({ category, categorySlug }) =>
              setForm((f) => ({ ...f, category, categorySlug, categorySlugTouched: true }))
            }
            required
          />
          <SubBeatsPicker
            primarySlug={form.categorySlug}
            subBeats={form.subBeats}
            onChange={(subBeats) => setForm((f) => ({ ...f, subBeats }))}
          />
          <div>
            <Label>Avatar</Label>
            <div className="flex items-start gap-3 mt-1">
              <div className="h-16 w-16 shrink-0 rounded-full overflow-hidden bg-muted border">
                {form.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={form.avatarUrl} alt="" className="w-full h-full object-cover" />
                ) : null}
              </div>
              <div className="flex-1 space-y-2">
                <Input
                  value={form.avatarUrl}
                  onChange={(e) => setForm({ ...form, avatarUrl: e.target.value })}
                  placeholder="Paste a URL or generate one →"
                  required
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleGenerateAvatar}
                  disabled={generateAvatar.isPending}
                >
                  {generateAvatar.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4 mr-2" />
                  )}
                  {generateAvatar.isPending ? "Generating portrait…" : "Generate portrait from persona"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Uses the name, bio, voice, and tone fields to compose a 1:1 editorial headshot.
                </p>
              </div>
            </div>
          </div>
          <div>
            <Label>Bio (shown on public site)</Label>
            <Textarea rows={2} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} required />
          </div>
        </Card>

        <Card className="p-6 space-y-4">
          <h2 className="font-serif text-xl font-bold">Voice & guardrails</h2>
          <div>
            <Label>Voice prompt (used by the model)</Label>
            <Textarea
              rows={6}
              value={form.voicePrompt}
              onChange={(e) => setForm({ ...form, voicePrompt: e.target.value })}
              placeholder="You write with warmth and rigor. You're allergic to clichés. You ground every claim in a mechanism…"
              required
            />
          </div>
          <div>
            <Label>Sample paragraphs (separate by <code>---</code> on its own line)</Label>
            <Textarea
              rows={5}
              value={form.sampleParagraphs}
              onChange={(e) => setForm({ ...form, sampleParagraphs: e.target.value })}
              placeholder={"Sample one…\n\n---\n\nSample two…"}
            />
          </div>
          <div>
            <Label>Banned topics (comma-separated)</Label>
            <Input value={form.bannedTopics} onChange={(e) => setForm({ ...form, bannedTopics: e.target.value })} />
          </div>
          <div>
            <Label>Word count target</Label>
            <Input
              type="number"
              value={form.wordCountTarget}
              onChange={(e) => setForm({ ...form, wordCountTarget: Number(e.target.value) })}
            />
          </div>
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
            onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          />
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
            onChange={(econ, social) => setForm((f) => ({ ...f, economicAxis: econ, socialAxis: social }))}
          />
        </Card>

        <Card className="p-6 space-y-4">
          <h2 className="font-serif text-xl font-bold">Schedule</h2>
          <div className="flex items-center gap-2">
            <Switch checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v })} />
            <Label>Active in pipeline</Label>
          </div>
          <ScheduleFields
            values={form}
            onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          />
        </Card>

        <Card className="p-6 space-y-4">
          <h2 className="font-serif text-xl font-bold">Model & sampling</h2>
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
          </div>
        </Card>

        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => setLocation("/admin/authors")}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Create author
          </Button>
        </div>
      </form>
    </div>
  );
}

export interface VoiceCraftValues {
  tone: string;
  sentenceRhythm: string;
  vocabularyQuirks: string;
  signatureMove: string;
  corePromise: string;
  avoid: string;
  technicalExplanationStyle: string;
}

const VOICE_CRAFT_FIELDS: { key: keyof VoiceCraftValues; label: string; placeholder: string; rows?: number; help?: string }[] = [
  { key: "tone", label: "Tone", placeholder: "e.g. Wry, generous, intellectually playful — never preachy." },
  { key: "sentenceRhythm", label: "Sentence rhythm", placeholder: "e.g. Mix punchy 4-word sentences with one long, breath-held one. Avoid uniform medium-length clauses." },
  { key: "vocabularyQuirks", label: "Vocabulary quirks", placeholder: "e.g. Loves precise verbs (buckles, ripples, lurches). Will reach for one good Latinate word per piece, no more." },
  { key: "signatureMove", label: "Signature move", placeholder: "e.g. Open with a concrete physical scene, then zoom out to the abstract idea." },
  { key: "corePromise", label: "Core promise to the reader", placeholder: "e.g. By the end you'll see something familiar in a strange new light, and feel smarter for it." },
  { key: "avoid", label: "Avoid", placeholder: "e.g. Hype, listicles, exclamation marks, the word 'fascinating', any hand-waving at 'the science'." },
  {
    key: "technicalExplanationStyle",
    label: "Technical explanation style",
    rows: 4,
    placeholder: "e.g. Begin with the recognizable human consequence, then work backward into the mechanism. Make systems feel observable rather than clinical. Introduce formal labels only after the reader understands what the system is doing.",
    help: "Describe how this author translates research, mechanisms, and specialist material into their own voice. Focus on explanatory instincts rather than subject expertise.",
  },
];

export function VoiceCraftFields({
  values,
  onChange,
}: {
  values: VoiceCraftValues;
  onChange: (patch: Partial<VoiceCraftValues>) => void;
}) {
  return (
    <div className="space-y-4">
      {VOICE_CRAFT_FIELDS.map((f) => (
        <div key={f.key}>
          <Label>{f.label}</Label>
          <Textarea
            rows={f.rows ?? 2}
            value={values[f.key]}
            placeholder={f.placeholder}
            onChange={(e) => onChange({ [f.key]: e.target.value } as Partial<VoiceCraftValues>)}
          />
          {f.help && <p className="mt-1 text-xs text-muted-foreground">{f.help}</p>}
        </div>
      ))}
    </div>
  );
}

export function CompassSliders({
  economicAxis,
  socialAxis,
  onChange,
}: {
  economicAxis: number;
  socialAxis: number;
  onChange: (economicAxis: number, socialAxis: number) => void;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div>
        <div className="flex items-center justify-between">
          <Label>Economic axis</Label>
          <span className="text-sm text-muted-foreground tabular-nums">{economicAxis.toFixed(1)}</span>
        </div>
        <input
          type="range"
          min={-10}
          max={10}
          step={0.5}
          value={economicAxis}
          onChange={(e) => onChange(Number(e.target.value), socialAxis)}
          className="w-full"
        />
        <div className="flex justify-between text-xs text-muted-foreground mt-1">
          <span>Left −10</span>
          <span>Center 0</span>
          <span>Right +10</span>
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between">
          <Label>Social axis</Label>
          <span className="text-sm text-muted-foreground tabular-nums">{socialAxis.toFixed(1)}</span>
        </div>
        <input
          type="range"
          min={-10}
          max={10}
          step={0.5}
          value={socialAxis}
          onChange={(e) => onChange(economicAxis, Number(e.target.value))}
          className="w-full"
        />
        <div className="flex justify-between text-xs text-muted-foreground mt-1">
          <span>Libertarian −10</span>
          <span>Center 0</span>
          <span>Authoritarian +10</span>
        </div>
      </div>
    </div>
  );
}
