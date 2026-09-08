import { useEffect, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileText,
  Globe2,
  History,
  Loader2,
  ScrollText,
  Sparkles,
  Upload,
  UsersRound,
} from "lucide-react";
import { Link, useParams } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ProfileFrame } from "@/components/customer/profile-frame";
import { WorldChronologyPanel } from "@/components/customer/world-chronology-panel";
import { WorldClockPanel } from "@/components/customer/world-clock-panel";
import { WorldContractPanel } from "@/components/customer/world-contract-panel";
import { WorldEntityPanel } from "@/components/customer/world-entity-panel";
import { WorldLorekeeperPanel } from "@/components/customer/world-lorekeeper-panel";
import { WorldConceptResolutionPanel } from "@/components/customer/world-concept-resolution-panel";
import { useAuth } from "@/lib/auth";
import { useSeo } from "@/lib/seo";
import { getWorld, type WorldDetail } from "@/lib/storyholdApi";
import { toChicagoTitleCase } from "@/lib/utils";

type WorldSection = "overview" | "clock" | "chronology" | "contract";
const worldSections = new Set<WorldSection>(["overview", "clock", "chronology", "contract"]);

function initialWorldSection(): WorldSection {
  if (typeof window === "undefined") return "overview";
  const value = new URLSearchParams(window.location.search).get("section") as WorldSection | null;
  return value && worldSections.has(value) ? value : "overview";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export default function ProfileWorld() {
  const auth = useAuth();
  const { id = "" } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<WorldDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<WorldSection>(initialWorldSection);

  useSeo({
    title: detail?.world.name || "Your world",
    description: "A private world in your Storyhold account.",
    canonicalPath: `/profile/worlds/${id}`,
    noindex: true,
  });

  const refresh = (showLoader = false) => {
    if (!auth.email || !id) return;
    if (showLoader) setLoading(true);
    setError(null);
    void getWorld(id)
      .then(setDetail)
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : "We could not open this world.");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!auth.email || !id) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    void getWorld(id)
      .then((response) => {
        if (active) setDetail(response);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "We could not open this world.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [auth.email, id]);

  useEffect(() => {
    const onPopState = () => setSection(initialWorldSection());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const chooseSection = (nextSection: WorldSection) => {
    setSection(nextSection);
    const nextUrl = new URL(window.location.href);
    if (nextSection === "overview") nextUrl.searchParams.delete("section");
    else nextUrl.searchParams.set("section", nextSection);
    window.history.replaceState({}, "", `${nextUrl.pathname}${nextUrl.search}`);
  };

  const understandingSummary = detail?.breakdown?.provider === "storyhold-development"
    ? `Storyhold has indexed ${detail.world.sourceCount.toLocaleString()} source${detail.world.sourceCount === 1 ? "" : "s"} and ${detail.world.wordCount.toLocaleString()} words. This private first pass inventories likely people, places, groups, species, creatures, vehicles, and uncertain labels without treating guesses as canon.`
    : detail?.breakdown?.summary;
  const chronology = detail?.breakdown?.chronology ?? [];
  const overviewChronology = chronology.length <= 6
    ? chronology
    : [...chronology.slice(0, 2), ...chronology.slice(-4)];
  const currentFrontierIndex = chronology.length <= 6 ? -1 : 2;
  const openQualityCount = detail?.qualityFindings?.filter((finding) => !finding.status || finding.status === "open").length ?? 0;
  const activeCampaign = detail?.campaigns.find((campaign) => campaign.status === "active")
    ?? detail?.campaigns.find((campaign) => campaign.status === "paused")
    ?? detail?.campaigns[0];
  return (
    <ProfileFrame>
      <Link href="/profile/worlds" className="inline-flex items-center text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to My Worlds
      </Link>

      {loading ? (
        <div className="grid min-h-80 place-items-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : error || !detail ? (
        <Card className="mt-8 rounded-3xl border-red-400/20 bg-red-400/[0.05] p-7">
          <h1 className="font-serif text-3xl font-bold">This World Could Not Be Opened.</h1>
          <p className="mt-3 text-sm text-muted-foreground">{error || "It may no longer be available."}</p>
        </Card>
      ) : (
        <div className="mt-5">
          <section className="storyhold-glass relative overflow-hidden rounded-3xl p-5 sm:p-6">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_90%_10%,rgba(215,175,100,0.12),transparent_40%)]" />
            <div className="relative">
              <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-start">
                <div className="min-w-0 xl:flex-1">
                  <div className="flex items-center gap-2">
                    <span className="h-px w-6 bg-primary/40"></span>
                    <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-primary/80">{toChicagoTitleCase(detail.world.genre || "Your World")}</p>
                  </div>
                  <h1 className="mt-3 font-serif text-4xl font-bold tracking-tight sm:text-5xl bg-gradient-to-br from-foreground to-foreground/70 bg-clip-text text-transparent drop-shadow-sm">{detail.world.name}</h1>
                  <p className="mt-3 max-w-3xl text-sm leading-relaxed text-foreground/80">{detail.world.premise || detail.world.description || "This world is ready for its first story."}</p>
                </div>
                <div className="flex w-full flex-wrap gap-2 xl:w-auto xl:justify-end">
                  <Button asChild className="rounded-xl shadow-[0_10px_28px_-16px_rgba(215,175,100,0.9)] text-primary-foreground font-bold hover:brightness-110">
                    <Link href={activeCampaign
                      ? `/profile/campaigns/${activeCampaign.id}/play`
                      : `/profile/worlds/${detail.world.id}?section=contract`}
                    >
                      <BookOpen className="mr-2 h-4 w-4" />
                      {activeCampaign ? "Continue Playing" : "Start a Campaign"}
                      <ChevronRight className="ml-2 h-4 w-4" />
                    </Link>
                  </Button>
                  <Button asChild variant="outline" className="rounded-xl">
                    <Link href={`/profile/worlds/${detail.world.id}/intake`}><Sparkles className="mr-2 h-4 w-4" /> Canon Intake &amp; Deeper Reading <ChevronRight className="ml-2 h-4 w-4" /></Link>
                  </Button>
                  <Button asChild variant="outline" className="rounded-xl">
                    <Link href={`/profile/import?world=${detail.world.id}`}><Upload className="mr-2 h-4 w-4" /> Add Sources</Link>
                  </Button>
                </div>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                <Badge variant="outline" className="border-primary/20 bg-black/30 px-3 py-1.5 text-xs text-foreground/80 shadow-inner"><FileText className="mr-2 h-4 w-4 text-primary/70" />{detail.world.sourceCount} source{detail.world.sourceCount === 1 ? "" : "s"}</Badge>
                <Badge variant="outline" className="border-primary/20 bg-black/30 px-3 py-1.5 text-xs text-foreground/80 shadow-inner"><BookOpen className="mr-2 h-4 w-4 text-primary/70" />{formatNumber(detail.world.wordCount)} words</Badge>
                <Badge variant="outline" className="border-primary/20 bg-black/30 px-3 py-1.5 text-xs text-foreground/80 shadow-inner"><UsersRound className="mr-2 h-4 w-4 text-primary/70" />{detail.world.peopleCount} character{detail.world.peopleCount === 1 ? "" : "s"}</Badge>
                <Badge variant="outline" className="border-primary/20 bg-black/30 px-3 py-1.5 text-xs text-foreground/80 shadow-inner"><Sparkles className="mr-2 h-4 w-4 text-primary/70" />{detail.world.campaignCount} campaign{detail.world.campaignCount === 1 ? "" : "s"}</Badge>
              </div>
            </div>
          </section>

          <nav className="mt-6 grid grid-cols-2 gap-2 rounded-2xl border border-white/5 bg-black/40 p-2 sm:grid-cols-4 shadow-inner" aria-label="World sections">
            {[
              ["overview", BookOpen, "Overview"],
              ["clock", Clock3, "World Clock"],
              ["chronology", FileText, "Sources & Time"],
              ["contract", ScrollText, "Start & Settings"],
            ].map(([value, Icon, label]) => {
              const TabIcon = Icon as typeof BookOpen;
              return (
                <button key={String(value)} type="button" onClick={() => chooseSection(value as WorldSection)} className={`flex items-center justify-center rounded-xl px-3 py-2.5 text-xs font-bold uppercase tracking-wider transition-all sm:text-[10px] ${section === value ? "bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-md" : "text-muted-foreground hover:bg-white/5 hover:text-primary"}`}>
                  <TabIcon className="mr-2 h-3.5 w-3.5" /> {toChicagoTitleCase(String(label))}
                </button>
              );
            })}
          </nav>

          {section === "clock" ? <div className="mt-5"><WorldClockPanel detail={detail} /></div> : null}
          {section === "chronology" ? <div className="mt-5"><WorldChronologyPanel detail={detail} onSaved={() => refresh()} /></div> : null}
          {section === "contract" ? <div className="mt-5"><WorldContractPanel detail={detail} onChanged={() => refresh()} /></div> : null}

          {section === "overview" ? (
            <>
              {understandingSummary ? (
                <Card className="mt-6 rounded-3xl border-primary/20 bg-gradient-to-br from-primary/[0.08] to-transparent p-6 shadow-sm">
                  <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.25em] text-primary">
                    <Sparkles className="h-3.5 w-3.5" /> Storyhold's Understanding
                  </p>
                  <p className="mt-3 text-base leading-relaxed text-foreground/90">{understandingSummary}</p>
                </Card>
              ) : detail.sources.length ? (
                <Card className="mt-6 rounded-3xl border border-primary/20 bg-primary/[0.05] p-6">
                  <div className="flex items-start gap-4"><Loader2 className="mt-0.5 h-6 w-6 animate-spin text-primary" /><div><p className="font-serif text-2xl font-bold text-foreground">Storyhold Is Still Reading This World.</p><p className="mt-2 text-sm leading-relaxed text-muted-foreground/90">Its people, places, rules, and chronology will appear as evidence is processed.</p></div></div>
                </Card>
              ) : (
                <Card className="mt-6 rounded-3xl border-white/5 bg-black/20 p-8 text-center shadow-inner"><BookOpen className="mx-auto h-8 w-8 text-primary/40" /><p className="mt-4 font-serif text-2xl font-bold text-foreground">This World Began from an Idea.</p><p className="mt-2 text-sm leading-relaxed text-muted-foreground max-w-md mx-auto">Its canon will grow as campaigns introduce and commit new people, places, mechanics, and consequences.</p></Card>
              )}

              <details className="group mt-6 rounded-3xl border border-white/5 bg-black/10 shadow-sm transition-colors hover:border-primary/20">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-5 font-serif text-2xl font-bold hover:bg-white/5 rounded-3xl transition-colors">
                  <span className="flex items-center gap-3"><Sparkles className="h-5 w-5 text-primary" />References and Canon Maintenance{openQualityCount ? <Badge variant="outline" className="ml-3 border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-200">{openQualityCount} notice{openQualityCount === 1 ? "" : "s"}</Badge> : null}</span>
                  <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <div className="border-t border-white/5 px-6 pb-6 pt-4 bg-black/20 rounded-b-3xl">
                  <WorldLorekeeperPanel detail={detail} onChanged={() => refresh()} />
                  <WorldConceptResolutionPanel detail={detail} onChanged={() => refresh()} />
                </div>
              </details>

              <WorldEntityPanel detail={detail} onChanged={() => refresh()} />

              <div className="mt-6 grid gap-4 xl:grid-cols-2">
                <Card className="rounded-3xl border-white/5 bg-black/10 p-6 shadow-sm">
                  <div className="flex items-center justify-between gap-3 border-b border-white/5 pb-4">
                    <div className="flex items-center gap-3"><History className="h-5 w-5 text-primary" /><h2 className="font-serif text-2xl font-bold">Timeline at a Glance</h2></div>
                    {chronology.length > overviewChronology.length ? <Button type="button" variant="outline" size="sm" className="shrink-0 border-primary/20 text-primary hover:bg-primary/10" onClick={() => chooseSection("clock")}>Full Clock</Button> : null}
                  </div>
                  <div className="pt-4">
                    {overviewChronology.length ? <div className="space-y-3">{overviewChronology.map((event, index) => <div key={event.name}>{index === currentFrontierIndex ? <p className="mb-2 mt-4 text-[10px] font-bold uppercase tracking-[0.2em] text-primary">Current Canon Frontier</p> : null}<div className="group rounded-xl border border-white/5 bg-black/20 px-4 py-3 transition-colors hover:border-primary/20 hover:bg-primary/5"><p className="font-serif text-lg font-bold group-hover:text-primary transition-colors">{toChicagoTitleCase(event.name)}</p>{event.summary ? <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{event.summary}</p> : null}</div></div>)}</div> : <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Major events will appear here as the source chronology is established.</p>}
                  </div>
                </Card>

                <Card className="rounded-3xl border-white/5 bg-black/10 p-6 shadow-sm">
                  <div className="flex items-center gap-3 border-b border-white/5 pb-4"><Globe2 className="h-5 w-5 text-primary" /><h2 className="font-serif text-2xl font-bold">Rules and Powers</h2></div>
                  <div className="pt-4">
                    <div className="space-y-3">{(detail.breakdown?.worldRules ?? []).slice(0, 5).map((rule) => <div key={rule.name} className="group rounded-xl border border-white/5 bg-black/20 px-4 py-3 transition-colors hover:border-primary/20 hover:bg-primary/5"><p className="font-serif text-lg font-bold group-hover:text-primary transition-colors">{rule.name}</p><p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{rule.summary}</p></div>)}</div>
                    {!detail.breakdown?.worldRules.length ? <p className="mt-2 text-sm leading-relaxed text-muted-foreground">World rules will be committed from sources and fair rulings during play.</p> : null}
                  </div>
                </Card>

                <details className="group rounded-3xl border border-white/5 bg-black/10 xl:col-span-2 shadow-sm transition-colors hover:border-primary/20">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-6 py-5 font-serif text-2xl font-bold"><span className="flex items-center gap-3"><Sparkles className="h-5 w-5 text-primary" />Open Possibilities <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary tracking-widest uppercase">{detail.breakdown?.openQuestions.length ?? 0}</span></span><ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-open:rotate-180" /></summary>
                  <div className="border-t border-white/5 px-6 py-5 bg-black/20 rounded-b-3xl">{detail.breakdown?.openQuestions.length ? <ul className="grid gap-3 text-sm leading-relaxed text-foreground/80 md:grid-cols-2">{detail.breakdown.openQuestions.slice(0, 8).map((question) => <li key={question} className="rounded-xl border border-white/5 bg-black/20 px-4 py-3 shadow-inner">{question}</li>)}</ul> : <p className="text-sm leading-relaxed text-muted-foreground">Possibilities remain uncommitted until the director schedules them or play makes them real.</p>}</div>
                </details>
              </div>

              <details className="group mt-4 rounded-3xl border border-white/5 bg-black/10 shadow-sm transition-colors hover:border-primary/20">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-5 font-serif text-2xl font-bold"><span className="flex items-center gap-3"><FileText className="h-5 w-5 text-primary" />Sources in This World <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary tracking-widest uppercase">{detail.sources.length}</span></span><ChevronDown className="h-5 w-5 text-muted-foreground transition-transform group-open:rotate-180" /></summary>
                <div className="border-t border-white/5 px-6 py-5 bg-black/20 rounded-b-3xl">{detail.sources.length ? <div className="space-y-3">{detail.sources.map((source) => <div key={source.id} className="flex flex-col justify-between gap-3 rounded-xl border border-white/5 bg-black/20 px-4 py-3 sm:flex-row sm:items-center"><div className="min-w-0"><p className="truncate font-semibold text-foreground/90">{source.title}</p><p className="mt-1 text-xs font-medium uppercase tracking-wider text-muted-foreground/70">{source.sourceKind.replaceAll("_", " ")} · {source.chronologyRelation.replaceAll("_", " ")}{source.chronologyLabel ? ` · ${source.chronologyLabel}` : ""}</p></div><span className="shrink-0 rounded-md bg-white/5 px-2.5 py-1 text-xs font-medium text-muted-foreground">{formatNumber(source.wordCount)} words</span></div>)}</div> : <p className="text-sm text-muted-foreground">No imported sources. This world will grow from its World Contract and campaigns.</p>}</div>
              </details>
            </>
          ) : null}
        </div>
      )}
    </ProfileFrame>
  );
}
