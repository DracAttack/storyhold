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
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_90%_10%,rgba(56,189,248,0.14),transparent_36%)]" />
            <div className="relative">
              <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-start">
                <div className="min-w-0 xl:flex-1">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">{toChicagoTitleCase(detail.world.genre || "Your World")}</p>
                  <h1 className="mt-2 font-serif text-3xl font-bold tracking-tight sm:text-4xl">{detail.world.name}</h1>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{detail.world.premise || detail.world.description || "This world is ready for its first story."}</p>
                </div>
                <div className="flex w-full flex-wrap gap-2 xl:w-auto xl:justify-end">
                  <Button asChild className="rounded-xl shadow-[0_10px_28px_-16px_rgba(56,189,248,0.9)]">
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
              <div className="mt-4 flex flex-wrap gap-1.5">
                <Badge variant="outline" className="border-white/10"><FileText className="mr-1.5 h-3.5 w-3.5 text-primary" />{detail.world.sourceCount} source{detail.world.sourceCount === 1 ? "" : "s"}</Badge>
                <Badge variant="outline" className="border-white/10"><BookOpen className="mr-1.5 h-3.5 w-3.5 text-primary" />{formatNumber(detail.world.wordCount)} words</Badge>
                <Badge variant="outline" className="border-white/10"><UsersRound className="mr-1.5 h-3.5 w-3.5 text-primary" />{detail.world.peopleCount} character{detail.world.peopleCount === 1 ? "" : "s"}</Badge>
                <Badge variant="outline" className="border-white/10"><Sparkles className="mr-1.5 h-3.5 w-3.5 text-primary" />{detail.world.campaignCount} campaign{detail.world.campaignCount === 1 ? "" : "s"}</Badge>
              </div>
            </div>
          </section>

          <nav className="storyhold-neu-inset mt-3 grid grid-cols-2 gap-1 rounded-xl border border-white/8 bg-black/20 p-1 sm:grid-cols-4" aria-label="World sections">
            {[
              ["overview", BookOpen, "Overview"],
              ["clock", Clock3, "World Clock"],
              ["chronology", FileText, "Sources & Time"],
              ["contract", ScrollText, "Start & Settings"],
            ].map(([value, Icon, label]) => {
              const TabIcon = Icon as typeof BookOpen;
              return (
                <button key={String(value)} type="button" onClick={() => chooseSection(value as WorldSection)} className={`flex items-center justify-center rounded-lg px-3 py-2 text-xs font-semibold transition-colors sm:text-sm ${section === value ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-white/[0.035] hover:text-foreground"}`}>
                  <TabIcon className="mr-2 h-4 w-4" /> {toChicagoTitleCase(String(label))}
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
                <Card className="mt-4 rounded-2xl border-primary/20 bg-primary/[0.045] p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Storyhold's Understanding</p>
                  <p className="mt-2 text-sm leading-6 text-foreground/90">{understandingSummary}</p>
                </Card>
              ) : detail.sources.length ? (
                <Card className="mt-5 rounded-3xl border-white/8 bg-white/[0.025] p-6">
                  <div className="flex items-start gap-3"><Loader2 className="mt-0.5 h-5 w-5 animate-spin text-primary" /><div><p className="font-semibold">Storyhold Is Still Reading This World.</p><p className="mt-1 text-sm leading-6 text-muted-foreground">Its people, places, rules, and chronology will appear as evidence is processed.</p></div></div>
                </Card>
              ) : (
                <Card className="mt-5 rounded-3xl border-white/8 bg-white/[0.025] p-6"><p className="font-semibold">This World Began from an Idea.</p><p className="mt-1 text-sm leading-6 text-muted-foreground">Its canon will grow as campaigns introduce and commit new people, places, mechanics, and consequences.</p></Card>
              )}

              <details className="group mt-4 rounded-2xl border border-white/8 bg-white/[0.025]">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-sm font-semibold hover:bg-white/[0.025]">
                  <span className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" />References and Canon Maintenance{openQualityCount ? <Badge variant="outline" className="ml-1 text-[10px]">{openQualityCount} notice{openQualityCount === 1 ? "" : "s"}</Badge> : null}</span>
                  <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <div className="border-t border-white/8 px-3 pb-3">
                  <WorldLorekeeperPanel detail={detail} onChanged={() => refresh()} />
                  <WorldConceptResolutionPanel detail={detail} onChanged={() => refresh()} />
                </div>
              </details>

              <WorldEntityPanel detail={detail} onChanged={() => refresh()} />

              <div className="mt-4 grid gap-3 xl:grid-cols-2">
                <Card className="rounded-2xl border-white/8 bg-white/[0.025] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2"><History className="h-4 w-4 text-primary" /><h2 className="font-serif text-xl font-bold">Timeline at a Glance</h2></div>
                    {chronology.length > overviewChronology.length ? <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => chooseSection("clock")}>Full Clock</Button> : null}
                  </div>
                  {overviewChronology.length ? <div className="mt-3 space-y-2">{overviewChronology.map((event, index) => <div key={event.name}>{index === currentFrontierIndex ? <p className="mb-1.5 mt-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">Current Canon Frontier</p> : null}<div className="rounded-lg border border-white/8 bg-black/15 px-3 py-2"><p className="text-sm font-semibold">{toChicagoTitleCase(event.name)}</p>{event.summary ? <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{event.summary}</p> : null}</div></div>)}</div> : <p className="mt-3 text-sm leading-6 text-muted-foreground">Major events will appear here as the source chronology is established.</p>}
                </Card>

                <Card className="rounded-2xl border-white/8 bg-white/[0.025] p-4">
                  <div className="flex items-center gap-2"><Globe2 className="h-4 w-4 text-primary" /><h2 className="font-serif text-xl font-bold">Rules and Powers</h2></div>
                  <div className="mt-3 space-y-2">{(detail.breakdown?.worldRules ?? []).slice(0, 5).map((rule) => <div key={rule.name} className="rounded-lg border border-white/8 bg-black/15 px-3 py-2"><p className="text-sm font-semibold">{rule.name}</p><p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{rule.summary}</p></div>)}</div>
                  {!detail.breakdown?.worldRules.length ? <p className="mt-4 text-sm leading-6 text-muted-foreground">World rules will be committed from sources and fair rulings during play.</p> : null}
                </Card>

                <details className="group rounded-2xl border border-white/8 bg-white/[0.025] xl:col-span-2">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold"><span className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" />Open Possibilities <span className="text-xs font-normal text-muted-foreground">({detail.breakdown?.openQuestions.length ?? 0})</span></span><ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" /></summary>
                  <div className="border-t border-white/8 px-4 py-3">{detail.breakdown?.openQuestions.length ? <ul className="grid gap-2 text-sm leading-5 text-foreground/85 md:grid-cols-2">{detail.breakdown.openQuestions.slice(0, 8).map((question) => <li key={question} className="rounded-lg bg-black/15 px-3 py-2">{question}</li>)}</ul> : <p className="text-sm leading-6 text-muted-foreground">Possibilities remain uncommitted until the director schedules them or play makes them real.</p>}</div>
                </details>
              </div>

              <details className="group mt-3 rounded-2xl border border-white/8 bg-white/[0.025]">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-sm font-semibold"><span className="flex items-center gap-2"><FileText className="h-4 w-4 text-primary" />Sources in This World <span className="text-xs font-normal text-muted-foreground">({detail.sources.length})</span></span><ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" /></summary>
                <div className="border-t border-white/8 px-4 py-3">{detail.sources.length ? <div className="space-y-2">{detail.sources.map((source) => <div key={source.id} className="flex flex-col justify-between gap-1 rounded-lg bg-black/15 px-3 py-2 text-sm sm:flex-row sm:items-center"><div className="min-w-0"><p className="truncate font-semibold">{source.title}</p><p className="text-xs text-muted-foreground">{source.sourceKind.replaceAll("_", " ")} · {source.chronologyRelation.replaceAll("_", " ")}{source.chronologyLabel ? ` · ${source.chronologyLabel}` : ""}</p></div><span className="shrink-0 text-xs text-muted-foreground">{formatNumber(source.wordCount)} words</span></div>)}</div> : <p className="text-sm text-muted-foreground">No imported sources. This world will grow from its World Contract and campaigns.</p>}</div>
              </details>
            </>
          ) : null}
        </div>
      )}
    </ProfileFrame>
  );
}
