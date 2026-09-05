import { useEffect, useMemo, useState } from "react";
import { ArrowRight, BookOpen, Clock3, FileText, Loader2, Search, Sparkles, Upload, UsersRound } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ProfileFrame } from "@/components/customer/profile-frame";
import { useAuth } from "@/lib/auth";
import { useSeo } from "@/lib/seo";
import { listWorlds, type WorldSummary } from "@/lib/storyholdApi";
import { toChicagoTitleCase } from "@/lib/utils";

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function worldStatus(world: WorldSummary): { label: string; className: string } {
  if (world.latestAnalysisStatus === "running" || world.latestAnalysisStatus === "queued") {
    return { label: "Reading Your World", className: "border-primary/25 bg-primary/[0.07] text-primary" };
  }
  if (world.latestAnalysisStatus === "failed") return { label: "Deeper Reading Needs Attention", className: "border-amber-300/25 bg-amber-300/[0.06] text-amber-200" };
  if (world.sourceCount === 0) return { label: "Ready to Begin", className: "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300" };
  if (world.waitingAiReviewCount > 0) return { label: "Indexed — Deeper Reading Pending", className: "border-amber-300/25 bg-amber-300/[0.06] text-amber-200" };
  return { label: "Ready to Explore", className: "border-emerald-400/20 bg-emerald-400/[0.06] text-emerald-300" };
}

export default function ProfileWorlds() {
  const auth = useAuth();
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [libraryFilter, setLibraryFilter] = useState<"all" | "ready" | "reading" | "attention">("all");

  const visibleWorlds = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return worlds.filter((world) => {
      const reading = world.latestAnalysisStatus === "running" || world.latestAnalysisStatus === "queued";
      const attention = world.latestAnalysisStatus === "failed" || world.waitingAiReviewCount > 0;
      const ready = !reading && !attention;
      if (libraryFilter === "ready" && !ready) return false;
      if (libraryFilter === "reading" && !reading) return false;
      if (libraryFilter === "attention" && !attention) return false;
      return !needle || `${world.name} ${world.genre ?? ""} ${world.premise ?? ""} ${world.description ?? ""}`.toLocaleLowerCase().includes(needle);
    });
  }, [libraryFilter, query, worlds]);

  useSeo({
    title: "My Worlds",
    description: "Worlds saved to your Storyhold account.",
    canonicalPath: "/profile/worlds",
    noindex: true,
  });

  useEffect(() => {
    if (!auth.email) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    void listWorlds()
      .then((response) => {
        if (active) setWorlds(response.worlds);
      })
      .catch((reason) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "We could not load your worlds.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [auth.email]);

  return (
    <ProfileFrame>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
            Your Library
          </p>
          <h1 className="mt-2 font-serif text-3xl font-bold tracking-tight sm:text-4xl">
            My Worlds
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Everything you create or import stays with this account.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild className="h-11 rounded-xl px-5">
            <Link href="/profile/import?mode=idea">
              <Sparkles className="mr-2 h-4 w-4" /> Start New Adventure
            </Link>
          </Button>
          <Button asChild variant="outline" className="h-11 rounded-xl px-5">
            <Link href="/profile/import?mode=sources">
              <Upload className="mr-2 h-4 w-4" /> Import My Writing
            </Link>
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="grid min-h-72 place-items-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : error ? (
        <div className="mt-8 rounded-2xl border border-red-400/20 bg-red-400/[0.06] p-5 text-sm text-red-100">
          {error}
        </div>
      ) : worlds.length === 0 ? (
        <Card className="mt-8 rounded-3xl border-dashed border-primary/25 bg-primary/[0.035] p-8 text-center sm:p-12">
          <BookOpen className="mx-auto h-8 w-8 text-primary" />
          <h2 className="mt-5 font-serif text-3xl font-bold">Your First World Is Waiting.</h2>
          <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-muted-foreground">
            Begin an original RPG from a few parameters, or bring your writing and play inside its established canon.
          </p>
          <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
            <Button asChild className="rounded-xl">
              <Link href="/profile/import?mode=idea">
                Start New Adventure <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" className="rounded-xl">
              <Link href="/profile/import?mode=sources">
                Import My Writing <Upload className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </Card>
      ) : (
        <>
        <div className="storyhold-glass-subtle mt-5 flex flex-col gap-2 rounded-xl p-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Worlds" className="h-9 pl-9" />
          </div>
          <select value={libraryFilter} onChange={(event) => setLibraryFilter(event.target.value as typeof libraryFilter)} className="storyhold-select min-h-9 py-1.5 text-xs" aria-label="Filter worlds">
            <option value="all">All Worlds</option><option value="ready">Ready</option><option value="reading">Reading Now</option><option value="attention">Needs Attention</option>
          </select>
          <span className="shrink-0 px-2 text-xs text-muted-foreground">{visibleWorlds.length} of {worlds.length}</span>
        </div>
        {visibleWorlds.length ? <div className="mt-2 grid gap-2">
          {visibleWorlds.map((world) => {
            const status = worldStatus(world);
            // A source-free RPG world is ready to configure or continue—not a
            // manuscript waiting for Canon Intake.  Keeping this route on the
            // world overview also exposes the campaign's permanent Play link.
            const statusHref = world.sourceCount === 0
              ? `/profile/worlds/${world.id}`
              : `/profile/worlds/${world.id}/intake`;
            const statusAction = world.sourceCount === 0
              ? `Open ${world.name} and continue or start its campaign`
              : `Open Canon Intake and Deeper Reading for ${world.name}`;
            return (
              <Card key={world.id} className="storyhold-lift group relative h-full rounded-xl border-white/8 bg-white/[0.025] px-4 py-3">
                <Link
                  href={`/profile/worlds/${world.id}`}
                  className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  aria-label={`Open ${world.name}`}
                />
                <div className="flex items-start justify-between gap-3">
                  <div className="pointer-events-none relative z-10 min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
                      {toChicagoTitleCase(world.genre || "Your World")}
                    </p>
                    <h2 className="mt-0.5 truncate font-serif text-xl font-bold">{world.name}</h2>
                  </div>
                  <Link
                    href={statusHref}
                    className={`relative z-20 inline-flex max-w-52 shrink-0 items-center rounded-full border px-2.5 py-1 text-center text-[10px] font-semibold uppercase tracking-[0.1em] transition-[filter,transform] hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${status.className}`}
                    aria-label={`${status.label}. ${statusAction}`}
                    title={statusAction}
                  >
                    {status.label}<ArrowRight className="ml-1.5 h-3 w-3" />
                  </Link>
                </div>
                <p className="pointer-events-none relative z-10 mt-1.5 line-clamp-1 text-xs leading-5 text-muted-foreground">
                  {world.premise || world.description || (world.sourceCount ? "Sources are indexed. Open this world to review what the Hold found." : "A blank world, ready for its first story.")}
                </p>
                <div className="pointer-events-none relative z-10 mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-white/8 pt-2.5 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5"><FileText className="h-3.5 w-3.5 text-primary" /><strong className="text-foreground">{world.sourceCount}</strong> Sources</span>
                  <span className="inline-flex items-center gap-1.5"><UsersRound className="h-3.5 w-3.5 text-primary" /><strong className="text-foreground">{world.peopleCount}</strong> People</span>
                  <span className="inline-flex items-center gap-1.5"><BookOpen className="h-3.5 w-3.5 text-primary" /><strong className="text-foreground">{formatNumber(world.wordCount)}</strong> Words</span>
                  <span className="inline-flex items-center gap-1.5"><Sparkles className="h-3.5 w-3.5 text-primary" /><strong className="text-foreground">{world.campaignCount}</strong> Campaigns</span>
                  <span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" />{new Date(world.updatedAt).toLocaleDateString()}</span>
                  <span className="ml-auto inline-flex items-center font-semibold text-primary">Open <ArrowRight className="ml-1 h-3.5 w-3.5" /></span>
                </div>
              </Card>
            );
          })}
        </div> : <div className="mt-4 rounded-2xl border border-dashed border-white/10 px-5 py-8 text-center"><p className="font-semibold">No Worlds Match That View.</p><button type="button" className="mt-2 text-sm font-semibold text-primary hover:underline" onClick={() => { setQuery(""); setLibraryFilter("all"); }}>Clear Search and Filters</button></div>}
        </>
      )}
    </ProfileFrame>
  );
}
