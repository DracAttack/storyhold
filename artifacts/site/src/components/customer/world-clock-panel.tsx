import { useEffect, useMemo, useState, type FormEvent } from "react";
import { BellRing, BookOpen, ChevronDown, ChevronRight, Clock3, Eye, Loader2, Search, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { addCampaignReminder, getCampaignClock, type WorldClockEvent, type WorldDetail } from "@/lib/storyholdApi";
import {
  worldClockEventsForPresentation,
  worldClockTruthLabel,
} from "@/lib/worldClockPresentation";

function importedEvents(detail: WorldDetail): WorldClockEvent[] {
  return worldClockEventsForPresentation(detail);
}

const eventLabel: Record<WorldClockEvent["eventKind"], string> = {
  canon: "Canon", scene: "Scene", commitment: "Promise", reminder: "Reminder",
  discovery: "Discovery", state_change: "Change", scheduled_effect: "Known deadline", ruling: "Ruling",
};

const temporalLabel = {
  exact: "Exact placement",
  relative: "Relative order",
  uncertain: "Order uncertain",
  parallel: "Overlapping accounts",
} as const;

function chapterMarker(title: string, sourceOrder: number) {
  return title.match(/^(?:Prologue|Epilogue|Requiem|Chapter\s+\d+)/iu)?.[0] ?? `Section ${sourceOrder + 1}`;
}

function causalLinkLabel(link: NonNullable<WorldClockEvent["causalLinks"]>[number]) {
  const labels = {
    causes: ["Causes", "Caused by"],
    enables: ["Enables", "Enabled by"],
    prevents: ["Prevents", "Prevented by"],
    parallel_with: ["Runs alongside", "Runs alongside"],
    contradicts: ["Contradicts", "Contradicts"],
    supersedes: ["Supersedes", "Superseded by"],
    retells: ["Retells", "Retold by"],
  } as const;
  return labels[link.relationType][link.direction === "outgoing" ? 0 : 1];
}

export function WorldClockPanel({ detail }: { detail: WorldDetail }) {
  const [campaignId, setCampaignId] = useState("");
  const [view, setView] = useState<"timeline" | "chapters">("timeline");
  const [events, setEvents] = useState<WorldClockEvent[]>(() => importedEvents(detail));
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [dueLabel, setDueLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!campaignId) {
      setEvents(importedEvents(detail));
      return;
    }
    setView("timeline");
    let active = true;
    setLoading(true);
    void getCampaignClock(campaignId)
      .then((response) => { if (active) setEvents(response.events); })
      .catch((reason) => { if (active) toast.error(reason instanceof Error ? reason.message : "The World Clock could not be opened."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [campaignId, detail]);

  const query = search.trim().toLocaleLowerCase();
  const visibleEvents = useMemo(() => !query ? events : events.filter((event) =>
    `${event.title} ${event.summary} ${event.worldTimeLabel}`.toLocaleLowerCase().includes(query),
  ), [events, query]);
  const eventGroups = useMemo(() => {
    const groups = new Map<string, WorldClockEvent[]>();
    for (const event of visibleEvents) {
      const label = event.worldTimeLabel || (campaignId ? "Campaign continuity" : "Canonical sequence");
      groups.set(label, [...(groups.get(label) ?? []), event]);
    }
    return [...groups.entries()].sort((left, right) =>
      (left[1][0]?.chronologyOrder ?? 0) - (right[1][0]?.chronologyOrder ?? 0),
    );
  }, [campaignId, visibleEvents]);
  const visibleChapters = useMemo(() => !query ? detail.chapterSummaries : detail.chapterSummaries.filter((chapter) =>
    `${chapter.sourceTitle} ${chapter.chapterTitle} ${chapter.perspective} ${chapter.summary} ${chapter.majorEvents.join(" ")}`.toLocaleLowerCase().includes(query),
  ), [detail.chapterSummaries, query]);
  const chapterGroups = useMemo(() => {
    const groups = new Map<string, typeof visibleChapters>();
    for (const chapter of visibleChapters) {
      const label = chapter.sourceChronologyLabel || chapter.sourceTitle;
      groups.set(label, [...(groups.get(label) ?? []), chapter]);
    }
    return [...groups.entries()].sort((left, right) =>
      (left[1][0]?.sourceChronologyOrder ?? 0) - (right[1][0]?.sourceChronologyOrder ?? 0),
    );
  }, [visibleChapters]);

  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const addReminder = async (event: FormEvent) => {
    event.preventDefault();
    if (!campaignId) return;
    setSaving(true);
    try {
      const response = await addCampaignReminder({ campaignId, kind: "reminder", title, summary, dueLabel });
      setEvents((current) => [...current, response.event]);
      setTitle(""); setSummary(""); setDueLabel("");
      toast.success("Reminder added to the World Clock.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The reminder could not be saved.");
    } finally { setSaving(false); }
  };

  const timelineActive = campaignId || view === "timeline";
  const visibleCount = timelineActive ? visibleEvents.length : visibleChapters.length;

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_0.38fr]">
      <Card className="rounded-3xl border-white/8 bg-white/[0.025] p-5 sm:p-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">{detail.world.worldClockName}</p>
            <h2 className="mt-2 font-serif text-3xl font-bold">World Chronology</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Canonical events are arranged by when they happen in-world. The separate chapter guide preserves the book's reading order, including flashbacks and overlapping viewpoints.
            </p>
          </div>
          <Clock3 className="h-7 w-7 shrink-0 text-primary" />
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-[0.75fr_1.25fr]">
          <select value={campaignId} onChange={(event) => setCampaignId(event.target.value)} className="h-10 rounded-xl border border-input bg-background px-3 text-sm">
            <option value="">Imported world</option>
            {detail.campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}{campaign.characterName ? ` - ${campaign.characterName}` : ""}</option>)}
          </select>
          <label className="relative"><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search people, places, chapters, and events" className="rounded-xl pl-9" /></label>
        </div>

        {!campaignId ? <div className="mt-4 inline-flex rounded-xl border border-white/10 bg-black/20 p-1">
          <Button type="button" size="sm" variant={view === "timeline" ? "default" : "ghost"} className="rounded-lg" onClick={() => setView("timeline")}><Clock3 className="mr-2 h-4 w-4" />Canonical timeline</Button>
          <Button type="button" size="sm" variant={view === "chapters" ? "default" : "ghost"} className="rounded-lg" onClick={() => setView("chapters")}><BookOpen className="mr-2 h-4 w-4" />Chapter guide</Button>
        </div> : null}

        {loading ? <div className="grid min-h-56 place-items-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div> : visibleCount ? (
          <div className="mt-7 space-y-4">
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><span className="rounded-full border border-white/10 px-3 py-1.5">{visibleCount} {timelineActive ? "canonical events" : "chapters"}</span><span className="rounded-full border border-white/10 px-3 py-1.5">{(timelineActive ? eventGroups : chapterGroups).length} sections</span></div>
            {timelineActive ? eventGroups.map(([group, groupEvents], groupIndex) => (
              <details key={group} open={groupIndex < 2 || Boolean(query)} className="group overflow-hidden rounded-2xl border border-white/8 bg-black/15">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 hover:bg-white/[0.025]"><div className="flex min-w-0 items-center gap-3"><ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 group-open:text-primary" /><div><h3 className="font-serif text-lg font-bold">{group}</h3><p className="mt-0.5 text-xs text-muted-foreground">{groupEvents.length} in-world event{groupEvents.length === 1 ? "" : "s"}</p></div></div><Badge variant="outline" className="shrink-0 border-white/10">{groupEvents.length}</Badge></summary>
                <div className="border-t border-white/8 p-2 sm:p-3">{groupEvents.map((event) => {
                  const isOpen = expanded.has(event.id);
                  return <article key={event.id} className="border-b border-white/8 last:border-0"><button type="button" className="flex w-full items-start gap-3 rounded-xl px-2 py-3 text-left hover:bg-white/[0.025] sm:px-3" aria-expanded={isOpen} onClick={() => toggle(event.id)}>{isOpen ? <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-primary" /> : <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />}<div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline" className="border-white/10 text-[9px] uppercase tracking-[0.1em]">{event.importance === "turning_point" ? "Turning point" : eventLabel[event.eventKind]}</Badge><span className="text-[10px] text-muted-foreground">{temporalLabel[event.temporalStatus ?? "relative"]}</span><span className="inline-flex items-center text-[10px] text-muted-foreground"><Eye className="mr-1 h-3 w-3" />{worldClockTruthLabel(event)}</span></div><h4 className="mt-1.5 font-serif text-lg font-bold">{event.title}</h4>{event.summary ? <p className={`mt-1.5 text-sm leading-6 text-muted-foreground ${isOpen ? "" : "line-clamp-2"}`}>{event.summary}</p> : null}{isOpen && event.scheduledForLabel ? <div className="mt-3 inline-flex items-center rounded-lg border border-primary/20 bg-primary/[0.05] px-2.5 py-1.5 text-xs text-primary"><BellRing className="mr-1.5 h-3.5 w-3.5" />{event.scheduledForLabel}</div> : null}{isOpen && event.knownEffects.length ? <div className="mt-3 border-t border-white/8 pt-3 text-xs leading-5 text-muted-foreground">Known effects: {event.knownEffects.join("; ")}</div> : null}{isOpen && event.causalLinks?.length ? <div className="mt-3 border-t border-white/8 pt-3"><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">Connected events</p><ul className="mt-2 space-y-1.5 text-xs leading-5 text-muted-foreground">{event.causalLinks.map((link) => <li key={link.id}><strong className="text-foreground">{causalLinkLabel(link)}:</strong> {link.otherEventTitle}{link.summary ? ` — ${link.summary}` : ""}</li>)}</ul></div> : null}</div></button></article>;
                })}</div>
              </details>
            )) : chapterGroups.map(([group, chapters], groupIndex) => (
              <details key={group} open={groupIndex === 0 || Boolean(query)} className="group overflow-hidden rounded-2xl border border-white/8 bg-black/15">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 hover:bg-white/[0.025]"><div className="flex min-w-0 items-center gap-3"><ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 group-open:text-primary" /><div><h3 className="font-serif text-lg font-bold">{group}</h3><p className="mt-0.5 text-xs text-muted-foreground">Reading order · {chapters.length} chapter{chapters.length === 1 ? "" : "s"}</p></div></div><Badge variant="outline" className="shrink-0 border-white/10">{chapters.length}</Badge></summary>
                <div className="border-t border-white/8 p-2 sm:p-3">{chapters.map((chapter) => { const isOpen = expanded.has(chapter.id); return <article key={chapter.id} className="border-b border-white/8 last:border-0"><button type="button" className="flex w-full items-start gap-3 rounded-xl px-2 py-3 text-left hover:bg-white/[0.025] sm:px-3" aria-expanded={isOpen} onClick={() => toggle(chapter.id)}>{isOpen ? <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-primary" /> : <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />}<div className="min-w-0 flex-1"><div className="flex flex-wrap gap-2"><Badge variant="outline" className="border-white/10 text-[9px] uppercase tracking-[0.1em]">{chapterMarker(chapter.chapterTitle, chapter.sourceOrder)}</Badge>{chapter.perspective ? <span className="text-[10px] text-muted-foreground">{chapter.perspective}</span> : null}<span className="text-[10px] text-muted-foreground">{chapter.summarySource === "ai" || chapter.summarySource === "user" ? "Deep summary" : "Initial scan"}</span></div><h4 className="mt-1.5 font-serif text-lg font-bold">{chapter.chapterTitle}</h4><p className={`mt-1.5 text-sm leading-6 text-muted-foreground ${isOpen ? "" : "line-clamp-2"}`}>{chapter.summary}</p>{isOpen && chapter.majorEvents.length ? <div className="mt-3 border-t border-white/8 pt-3"><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">Major developments</p><ul className="mt-2 space-y-1.5 text-xs leading-5 text-muted-foreground">{chapter.majorEvents.map((item) => <li key={item}>• {item}</li>)}</ul></div> : null}</div></button></article>; })}</div>
              </details>
            ))}
          </div>
        ) : <div className="mt-7 rounded-2xl border border-dashed border-white/10 p-8 text-center"><BookOpen className="mx-auto h-6 w-6 text-primary" /><p className="mt-3 font-semibold">{query ? (timelineActive ? "No matching events." : "No matching chapters.") : (timelineActive ? "No World Clock events are ready yet." : "No chapter summaries are ready yet.")}</p><p className="mt-2 text-sm text-muted-foreground">{query ? "Try another search." : (timelineActive ? "Material that has not earned a place in the timeline, or is private, stays out until it can be placed safely." : "Chapter summaries appear here after the manuscript has been read.")}</p></div>}
      </Card>

      <div className="space-y-5">
        {campaignId ? <Card className="rounded-3xl border-primary/20 bg-primary/[0.04] p-5"><Sparkles className="h-5 w-5 text-primary" /><h3 className="mt-4 font-serif text-xl font-bold">Add your own reminder</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">Use this for promises and deadlines your character actually knows about. It cannot expose the director's private schedule.</p><form onSubmit={addReminder} className="mt-4 space-y-2"><Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Pick up the repaired sword" maxLength={180} className="rounded-xl" /><Textarea value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="Optional context" maxLength={1_500} className="min-h-20 rounded-xl" /><Input value={dueLabel} onChange={(event) => setDueLabel(event.target.value)} placeholder="Due: in three world-days" maxLength={180} className="rounded-xl" /><Button type="submit" disabled={saving || title.trim().length < 2} className="w-full rounded-xl">{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <BellRing className="mr-2 h-4 w-4" />} Add reminder</Button></form></Card> : <Card className="rounded-3xl border-white/8 bg-white/[0.025] p-5"><BookOpen className="h-5 w-5 text-primary" /><h3 className="mt-4 font-serif text-xl font-bold">Two useful orders</h3><p className="mt-2 text-sm leading-6 text-muted-foreground"><strong className="text-foreground">Canonical timeline</strong> follows the world's history. <strong className="text-foreground">Chapter guide</strong> follows the author's reveal order. Storyhold keeps both so a flashback does not become a false date.</p></Card>}
        <Card className="rounded-3xl border-white/8 bg-white/[0.025] p-5 text-sm leading-6 text-muted-foreground">The Clock never shows a hidden-event count, private title, or secret deadline. Once a consequence becomes observable, only the observable event appears; its cause stays hidden until discovered.</Card>
      </div>
    </div>
  );
}
