import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, Clock3, FilePlus2, Loader2 } from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { updateWorldChronology, type WorldDetail, type WorldSource } from "@/lib/storyholdApi";

type ChronologyItem = {
  source: WorldSource;
  sourceKind: WorldSource["sourceKind"];
  relation: WorldSource["chronologyRelation"];
  label: string;
  notes: string;
};

const sourceKinds: Array<[WorldSource["sourceKind"], string]> = [
  ["manuscript", "Book or manuscript"],
  ["character_sheet", "Character sheet"],
  ["setting_guide", "Setting guide"],
  ["ruleset", "Ruleset"],
  ["timeline", "Timeline"],
  ["notes", "Notes"],
  ["reference", "Reference"],
  ["other", "Other"],
];

const relations: Array<[WorldSource["chronologyRelation"], string]> = [
  ["origin", "Beginning / earliest"],
  ["continues", "Continues previous"],
  ["precedes", "Occurs before previous"],
  ["parallel", "Runs in parallel"],
  ["overlaps", "Overlapping period"],
  ["alternate", "Alternate continuity"],
  ["reference", "Reference - outside chronology"],
  ["unspecified", "Storyhold should infer"],
];

function itemsFrom(detail: WorldDetail): ChronologyItem[] {
  return [...detail.sources]
    .sort((left, right) => left.chronologyOrder - right.chronologyOrder)
    .map((source) => ({
      source,
      sourceKind: source.sourceKind,
      relation: source.chronologyRelation,
      label: source.chronologyLabel,
      notes: source.chronologyNotes,
    }));
}

export function WorldChronologyPanel({
  detail,
  onSaved,
}: {
  detail: WorldDetail;
  onSaved: () => void;
}) {
  const [items, setItems] = useState(() => itemsFrom(detail));
  const [summary, setSummary] = useState(detail.edition.chronologySummary);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setItems(itemsFrom(detail));
    setSummary(detail.edition.chronologySummary);
  }, [detail]);

  const update = (index: number, patch: Partial<ChronologyItem>) => {
    setItems((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    );
  };

  const move = (index: number, direction: -1 | 1) => {
    setItems((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item!);
      return next;
    });
  };

  const save = async () => {
    if (!items.length) return;
    setSaving(true);
    try {
      await updateWorldChronology({
        worldId: detail.world.id,
        summary,
        sources: items.map((item) => ({
          sourceId: item.source.id,
          sourceKind: item.sourceKind,
          relation: item.relation,
          label: item.label,
          notes: item.notes,
        })),
      });
      toast.success("The source chronology is saved.");
      onSaved();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The chronology could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_0.38fr]">
      <Card className="rounded-3xl border-white/8 bg-white/[0.025] p-5 sm:p-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Source Chronology</p>
            <h2 className="mt-2 font-serif text-3xl font-bold">How the Writing Fits Together</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              This orders sources, not every individual scene. Flashbacks, overlaps, and uncertain dates remain event-level relationships inside the World Clock.
            </p>
          </div>
          {detail.edition.chronologyStatus === "reviewed" ? (
            <span className="inline-flex shrink-0 items-center rounded-full border border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-1 text-xs text-emerald-300">
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> Reviewed
            </span>
          ) : null}
        </div>

        {items.length ? (
          <div className="mt-6 space-y-3">
            {items.map((item, index) => (
              <div key={item.source.id} className="rounded-2xl border border-white/8 bg-black/20 p-4">
                <div className="flex items-start gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-sm font-bold text-primary">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{item.source.title}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{item.source.originalFilename}</p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button type="button" aria-label="Move up" disabled={saving || index === 0} onClick={() => move(index, -1)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground disabled:opacity-25"><ArrowUp className="h-4 w-4" /></button>
                        <button type="button" aria-label="Move down" disabled={saving || index === items.length - 1} onClick={() => move(index, 1)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground disabled:opacity-25"><ArrowDown className="h-4 w-4" /></button>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <select value={item.sourceKind} onChange={(event) => update(index, { sourceKind: event.target.value as WorldSource["sourceKind"] })} className="h-9 rounded-lg border border-input bg-background px-2 text-xs">
                        {sourceKinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                      <select value={item.relation} onChange={(event) => update(index, { relation: event.target.value as WorldSource["chronologyRelation"] })} className="h-9 rounded-lg border border-input bg-background px-2 text-xs">
                        {relations.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </div>
                    <Input value={item.label} onChange={(event) => update(index, { label: event.target.value })} placeholder="Optional time label: eighteen months later" maxLength={240} className="mt-2 h-9 rounded-lg text-xs" />
                    <Input value={item.notes} onChange={(event) => update(index, { notes: event.target.value })} placeholder="Optional note: includes flashbacks to Book One" maxLength={1_000} className="mt-2 h-9 rounded-lg text-xs" />
                  </div>
                </div>
              </div>
            ))}
            <Textarea value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="General chronology summary or ambiguity" maxLength={2_000} className="min-h-24 rounded-xl" />
            <Button type="button" onClick={() => void save()} disabled={saving} className="w-full rounded-xl">
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Clock3 className="mr-2 h-4 w-4" />}
              Save this chronology
            </Button>
          </div>
        ) : (
          <div className="mt-6 rounded-2xl border border-dashed border-white/10 p-7 text-center text-sm text-muted-foreground">Add at least one source before reviewing chronology.</div>
        )}
      </Card>

      <div className="space-y-5">
        <Card className="rounded-3xl border-primary/20 bg-primary/[0.04] p-5">
          <Clock3 className="h-5 w-5 text-primary" />
          <h3 className="mt-4 font-serif text-xl font-bold">Relative Time Is Valid</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Storyhold can preserve “before the evacuation,” “during Book Two,” or an uncertain range. It should never invent an exact date merely to make the database tidy.</p>
        </Card>
        <Button asChild variant="outline" className="h-auto w-full justify-start rounded-2xl px-4 py-4">
          <Link href={`/profile/import?world=${detail.world.id}`}>
            <FilePlus2 className="mr-3 h-5 w-5 text-primary" /> Add more sources
          </Link>
        </Button>
      </div>
    </div>
  );
}
