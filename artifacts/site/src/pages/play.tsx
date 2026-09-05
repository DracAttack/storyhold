import { useState } from "react";
import { ArrowRight, RefreshCw, Sparkles } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { DemoConsole } from "@/components/customer/demo-console";
import { useAuth } from "@/lib/auth";
import { useSeo } from "@/lib/seo";
import {
  drawStoryholdScenarios,
  findStoryholdScenario,
  type StoryholdScenario,
} from "@/lib/storyholdScenarios";

const SUGGESTION_COUNT = 3;

function getLinkedScenario() {
  if (typeof window === "undefined") return undefined;
  return findStoryholdScenario(new URLSearchParams(window.location.search).get("scenario"));
}

export default function Play() {
  const auth = useAuth();
  const [selectedScenario, setSelectedScenario] = useState<StoryholdScenario | undefined>(
    getLinkedScenario,
  );
  const [suggestions, setSuggestions] = useState(() =>
    drawStoryholdScenarios(
      SUGGESTION_COUNT,
      selectedScenario ? [selectedScenario.id] : [],
    ),
  );
  const [sceneLocked, setSceneLocked] = useState(false);

  useSeo({
    title: "Try a scene",
    description: "Choose any world and role, then try a free Storyhold scene.",
    canonicalPath: "/play",
  });

  const refreshSuggestions = () => {
    setSuggestions(
      drawStoryholdScenarios(
        SUGGESTION_COUNT,
        selectedScenario ? [selectedScenario.id] : [],
      ),
    );
  };

  const chooseScenario = (scenario: StoryholdScenario) => {
    if (sceneLocked) return;
    setSelectedScenario(scenario);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("scenario", scenario.id);
    window.history.replaceState({}, "", `${nextUrl.pathname}${nextUrl.search}`);
  };

  return (
    <main>
      <section className="relative overflow-hidden border-b border-white/8">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_68%_15%,rgba(56,189,248,0.15),transparent_38%)]" />
        <div className="relative mx-auto grid max-w-7xl gap-6 px-4 py-7 sm:px-6 lg:grid-cols-[0.68fr_1.32fr] lg:items-start lg:gap-8 lg:px-8 lg:py-12">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
              Free scene
            </p>
            <h1 className="mt-3 font-serif text-4xl font-bold leading-[1.02] tracking-tight sm:text-5xl">
              Tell us who you are. Then act.
            </h1>
            <p className="mt-4 text-base leading-7 text-muted-foreground">
              Choose any kind of world and any kind of person. You do not need a character
              sheet, a rulebook, or the right vocabulary to begin.
            </p>
            <div className="mt-5 hidden space-y-2 text-xs text-muted-foreground sm:block">
              {[
                "Describe as much or as little as you want.",
                "Your choices shape what becomes possible next.",
                "The preview pauses whenever the live storyteller is unavailable.",
              ].map((item) => (
                <div key={item} className="flex items-start gap-2">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button asChild className="min-h-11 w-full rounded-xl sm:w-auto">
                <Link href="/profile/import?mode=idea">
                  Start New Adventure <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button asChild variant="outline" className="min-h-11 rounded-xl">
                <a href="#scene-console">Try a Free Scene</a>
              </Button>
              {auth.email ? (
                <Button asChild variant="ghost" className="min-h-11 rounded-xl">
                  <Link href="/profile/worlds">My Worlds</Link>
                </Button>
              ) : null}
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Start an adventure to create your world and character, with progress saved as you play.
            </p>
          </div>
          <div className="space-y-4">
            <section
              aria-labelledby="scenario-picker-title"
              className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-primary">
                    Need a beginning?
                  </p>
                  <h2 id="scenario-picker-title" className="mt-1 font-serif text-xl font-bold">
                    Try one of these.
                  </h2>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={refreshSuggestions}
                  disabled={sceneLocked}
                  className="shrink-0 rounded-lg text-xs text-muted-foreground hover:text-foreground"
                >
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> New ideas
                </Button>
              </div>

              <div className="mt-3 grid auto-cols-[86%] grid-flow-col gap-2 overflow-x-auto pb-2 sm:auto-cols-auto sm:grid-flow-row sm:grid-cols-3 sm:overflow-visible sm:pb-0" aria-live="polite">
                {suggestions.map((scenario) => {
                  const selected = scenario.id === selectedScenario?.id;
                  return (
                    <button
                      key={scenario.id}
                      type="button"
                      onClick={() => chooseScenario(scenario)}
                      disabled={sceneLocked}
                      aria-pressed={selected}
                      className={`flex min-h-40 flex-col rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
                        selected
                          ? "border-primary/60 bg-primary/[0.12]"
                          : "border-white/8 bg-black/20 hover:border-primary/35 hover:bg-white/[0.045]"
                      }`}
                    >
                      <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-primary">
                        {scenario.genre}
                      </span>
                      <span className="mt-1.5 block font-serif text-base font-bold leading-5">
                        {scenario.title}
                      </span>
                      <span className="mt-2 block line-clamp-3 text-xs leading-[1.15rem] text-muted-foreground">
                        {scenario.premise}
                      </span>
                      <span className="mt-auto pt-3 text-[10px] font-bold uppercase tracking-[0.14em] text-primary/85">
                        Use this beginning
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2.5 text-[11px] leading-4 text-muted-foreground">
                {sceneLocked
                  ? "Your starting point is now part of this scene."
                  : "Each opening gives you a setting, a role, and immediate trouble. Pick one to fill the premise and your first move."}
              </p>
            </section>

            <DemoConsole
              scenario={selectedScenario}
              onSessionLockChange={setSceneLocked}
            />
          </div>
        </div>
      </section>
    </main>
  );
}
