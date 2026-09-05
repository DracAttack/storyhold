import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAuthors,
  useListCategories,
  useGenerateIdeas,
  useUpdateAuthor,
  getListIdeasForAuthorQueryKey,
  getListAuthorsQueryKey,
  getGetAuthorQueryKey,
  type Author,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Link } from "wouter";
import { Loader2, Plus, Sparkles, FileText, RotateCcw, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { ScheduleFields, CompassSliders, type CadenceValue, type ScheduleValues } from "./AuthorNew";

export default function Authors() {
  const { data, isLoading } = useListAuthors();
  // Resolve beat names from the full master list (/categories = whole beats
  // table) — NOT useBeats() (/public/beats), which hides beats with no published
  // articles and would render newly-assigned beats as raw slugs.
  const { data: categoriesData } = useListCategories();
  const beatNameBySlug = new Map(
    (categoriesData?.items ?? []).map((c) => [c.categorySlug, c.category]),
  );
  const qc = useQueryClient();
  const generateIdeas = useGenerateIdeas({
    mutation: {
      onSuccess: (_res, vars) => {
        toast.success("New ideas generated");
        qc.invalidateQueries({ queryKey: getListIdeasForAuthorQueryKey(vars.id) });
      },
      onError: () => toast.error("Idea generation failed"),
    },
  });
  if (isLoading || !data) return <div className="p-4 md:p-8"><Loader2 className="animate-spin" /></div>;
  return (
    <div className="p-4 md:p-8 max-w-6xl">
      <div className="flex items-start justify-between gap-4 mb-8">
        <div>
          <h1 className="font-serif text-3xl font-bold mb-1">Authors</h1>
          <p className="text-muted-foreground">AI-driven personas. Each one has its own voice, schedule, and political compass.</p>
        </div>
        <Link href="/admin/authors/new">
          <Button><Plus className="h-4 w-4 mr-2" />New author</Button>
        </Link>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data.items.map((a) => {
          const pending = generateIdeas.isPending && generateIdeas.variables?.id === a.id;
          return (
            <Card key={a.id} className="p-5 hover:border-primary transition-colors">
              <div className="flex items-start gap-4">
                <Link href={`/admin/authors/${a.id}`} className="shrink-0">
                  <img src={a.avatarUrl.startsWith("/") ? `${import.meta.env.BASE_URL.replace(/\/$/, "")}${a.avatarUrl}` : a.avatarUrl} alt={a.name} className="h-16 w-16 rounded-full bg-muted object-cover" />
                </Link>
                <div className="flex-1 min-w-0">
                  <Link href={`/admin/authors/${a.id}`} className="block hover:opacity-90">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-serif font-bold text-lg">{a.name}</h3>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${a.active ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}>
                        {a.active ? a.cadence : "paused"}
                      </span>
                      {a.active && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground tabular-nums">
                          {String(a.runHourUtc).padStart(2, "0")}:05 UTC
                        </span>
                      )}
                    </div>
                    <p className="text-xs uppercase tracking-wider text-primary mt-1">{a.category}</p>
                    {a.subBeats && a.subBeats.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {a.subBeats.map((slug) => (
                          <span key={slug} className="text-[10px] px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700">
                            + {beatNameBySlug.get(slug) ?? slug}
                          </span>
                        ))}
                      </div>
                    )}
                    <p className="text-sm text-muted-foreground mt-2 line-clamp-2">{a.bio}</p>
                  </Link>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => generateIdeas.mutate({ id: a.id })}
                    >
                      {pending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Sparkles className="h-4 w-4 mr-2" />
                      )}
                      {pending ? "Generating…" : "Generate 5 ideas"}
                    </Button>
                    <Link href={`/admin/articles?authorId=${a.id}`}>
                      <Button size="sm" variant="outline">
                        <FileText className="h-4 w-4 mr-2" />
                        Articles
                      </Button>
                    </Link>
                    <AuthorQuickEdit author={a} />
                  </div>
                </div>
              </div>
              <AuthorInlineEditor author={a} />
            </Card>
          );
        })}
      </div>
    </div>
  );
}

type InlineForm = ScheduleValues & {
  economicAxis: number;
  socialAxis: number;
};

function toAxis(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

function seedForm(author: Author): InlineForm {
  return {
    cadence: author.cadence as CadenceValue,
    weekday: author.weekday ?? null,
    secondWeekday: author.secondWeekday ?? null,
    dayOfMonth: author.dayOfMonth ?? null,
    runHourUtc: author.runHourUtc ?? 14,
    randomizeSchedule: author.randomizeSchedule,
    economicAxis: toAxis(author.economicAxis),
    socialAxis: toAxis(author.socialAxis),
  };
}

/**
 * Inline schedule + political-compass editor rendered directly on each author
 * card (no modal). Local draft state, with a Save button that only enables when
 * the draft differs from the saved author, plus a Reset to discard edits.
 */
function AuthorInlineEditor({ author }: { author: Author }) {
  const qc = useQueryClient();
  const saved = useMemo(() => seedForm(author), [author]);
  const [form, setForm] = useState<InlineForm>(saved);

  // Re-seed local draft if the underlying author changes (e.g. after a refetch)
  // and there are no in-progress local edits.
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);

  const update = useUpdateAuthor({
    mutation: {
      onSuccess: () => {
        toast.success(`Updated ${author.name}`);
        qc.invalidateQueries({ queryKey: getListAuthorsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetAuthorQueryKey(author.id) });
      },
      onError: (err) => {
        const e = err as unknown as { data?: { error?: string } };
        toast.error(e?.data?.error ?? "Save failed");
      },
    },
  });

  const usesWeekday =
    form.cadence === "weekly" || form.cadence === "biweekly" || form.cadence === "twice_weekly";

  const handleSave = () => {
    update.mutate({
      id: author.id,
      data: {
        cadence: form.cadence,
        weekday: usesWeekday ? form.weekday : null,
        secondWeekday: form.cadence === "twice_weekly" ? form.secondWeekday : null,
        dayOfMonth: form.cadence === "monthly" ? form.dayOfMonth : null,
        randomizeSchedule: form.randomizeSchedule,
        runHourUtc: form.runHourUtc,
        economicAxis: form.economicAxis,
        socialAxis: form.socialAxis,
      },
    });
  };

  return (
    <div className="mt-4 border-t pt-4 space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Schedule</h4>
        </div>
        <ScheduleFields values={form} onChange={(patch) => setForm((f) => ({ ...f, ...patch }))} />
      </div>

      <div className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Political compass</h4>
        <CompassSliders
          economicAxis={form.economicAxis}
          socialAxis={form.socialAxis}
          onChange={(econ, social) => setForm((f) => ({ ...f, economicAxis: econ, socialAxis: social }))}
        />
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={!dirty || update.isPending}>
          {update.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Save changes
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setForm(saved)}
          disabled={!dirty || update.isPending}
        >
          <RotateCcw className="h-4 w-4 mr-2" />
          Reset
        </Button>
        {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
      </div>
    </div>
  );
}

type QuickEditForm = ScheduleValues & {
  economicAxis: number;
  socialAxis: number;
};

/**
 * The original modal editor, kept alongside the on-card inline editor. Opens a
 * dialog with the same schedule + compass controls for editing without the rest
 * of the card in view.
 */
function AuthorQuickEdit({ author }: { author: Author }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const seed = (): QuickEditForm => ({
    cadence: author.cadence as CadenceValue,
    weekday: author.weekday ?? null,
    secondWeekday: author.secondWeekday ?? null,
    dayOfMonth: author.dayOfMonth ?? null,
    runHourUtc: author.runHourUtc ?? 14,
    randomizeSchedule: author.randomizeSchedule,
    economicAxis: toAxis(author.economicAxis),
    socialAxis: toAxis(author.socialAxis),
  });

  const [form, setForm] = useState<QuickEditForm>(seed);

  const update = useUpdateAuthor({
    mutation: {
      onSuccess: () => {
        toast.success(`Updated ${author.name}`);
        qc.invalidateQueries({ queryKey: getListAuthorsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetAuthorQueryKey(author.id) });
        setOpen(false);
      },
      onError: (err) => {
        const e = err as unknown as { data?: { error?: string } };
        toast.error(e?.data?.error ?? "Save failed");
      },
    },
  });

  const usesWeekday =
    form.cadence === "weekly" || form.cadence === "biweekly" || form.cadence === "twice_weekly";

  const handleSave = () => {
    update.mutate({
      id: author.id,
      data: {
        cadence: form.cadence,
        weekday: usesWeekday ? form.weekday : null,
        secondWeekday: form.cadence === "twice_weekly" ? form.secondWeekday : null,
        dayOfMonth: form.cadence === "monthly" ? form.dayOfMonth : null,
        randomizeSchedule: form.randomizeSchedule,
        runHourUtc: form.runHourUtc,
        economicAxis: form.economicAxis,
        socialAxis: form.socialAxis,
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setForm(seed());
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <SlidersHorizontal className="h-4 w-4 mr-2" />
          Schedule & compass
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-serif">{author.name} — schedule & compass</DialogTitle>
          <DialogDescription>
            Adjust how often this author publishes and their political lean without opening the full editor.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6 py-1">
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Schedule</h3>
            <ScheduleFields values={form} onChange={(patch) => setForm((f) => ({ ...f, ...patch }))} />
          </div>
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Political compass</h3>
            <CompassSliders
              economicAxis={form.economicAxis}
              socialAxis={form.socialAxis}
              onChange={(econ, social) => setForm((f) => ({ ...f, economicAxis: econ, socialAxis: social }))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={update.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={update.isPending}>
            {update.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
