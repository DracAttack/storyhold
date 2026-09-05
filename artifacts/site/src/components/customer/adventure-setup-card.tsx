import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  adventureSetupBlocksPlay,
  adventureSetupIsPending,
  type AdventureSetupStatus,
} from "@/lib/adventureSetupApi";

type AdventureSetupContext = {
  worldName: string;
  premise?: string;
  tone?: string;
  characterName?: string | null;
  characterConcept?: string;
  initialObjective?: string;
};

function preparationSteps(context: AdventureSetupContext): string[] {
  const material = [
    context.premise,
    context.tone,
    context.characterConcept,
    context.initialObjective,
  ].filter(Boolean).join(" ").toLocaleLowerCase();
  const character = context.characterName?.trim() || "Your Character";
  const steps = ["Mapping The Opening Scene"];

  if (/(magic|wizard|witch|spell|wand|enchant|demon|angel|supernatural|curse|ritual)/iu.test(material)) {
    steps.push("Examining The Magic System");
  }
  if (/(politic|king|queen|lord|lady|court|noble|heir|family|parent|dynasty|ministry|government|faction)/iu.test(material)) {
    steps.push("Establishing Political And Family Intrigue");
  }
  if (/(demon|devil|lord|ruler|heir|leader|captain|agent|operative)/iu.test(material)) {
    steps.push(`Determining ${character}'s Duties, Enemies, And Constraints`);
  }
  if (/(school|academy|university|student|teacher|class)/iu.test(material)) {
    steps.push("Sketching Rivalries, Rules, And Daily Pressures");
  }
  if (/(crime|gang|mafia|detective|spy|secret|murder|conspiracy)/iu.test(material)) {
    steps.push("Placing Secrets, Motives, And Unseen Pressure");
  }
  if (/(space|planet|ship|alien|future|science|technology|robot)/iu.test(material)) {
    steps.push("Defining The World’s Technology And Its Costs");
  }
  steps.push(
    "Tracing Relationships And Fault Lines",
    "Setting The First Stakes",
    "Planting Clues For What Comes Next",
  );
  return [...new Set(steps)].slice(0, 5);
}

export function AdventureSetupCard({ setup, busy, error, onPrepare, context }: {
  setup: AdventureSetupStatus | null | undefined;
  busy: boolean;
  error: string | null;
  onPrepare: () => void;
  context: AdventureSetupContext;
}) {
  const waiting = busy || adventureSetupIsPending(setup);
  const retry = setup?.status === "failed" || Boolean(error);
  const steps = useMemo(() => preparationSteps(context), [context.characterConcept, context.characterName, context.initialObjective, context.premise, context.tone, context.worldName]);
  const [visibleStep, setVisibleStep] = useState(0);

  useEffect(() => {
    if (!waiting || steps.length < 2) return;
    setVisibleStep(0);
    const interval = window.setInterval(() => {
      setVisibleStep((current) => (current + 1) % steps.length);
    }, 2_800);
    return () => window.clearInterval(interval);
  }, [steps.length, waiting]);

  if (!adventureSetupBlocksPlay(setup)) return null;

  return (
    <section aria-label="Adventure Preparation" aria-busy={waiting} className="mb-6 rounded-2xl border border-primary/20 bg-primary/[0.05] p-5">
      <div className="flex items-center gap-2 text-primary">
        {waiting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        <h2 className="font-serif text-xl font-bold">{waiting ? "Preparing Your Adventure" : "Prepare Your Adventure"}</h2>
      </div>
      <p role="status" className="mt-2 text-sm leading-6 text-muted-foreground">
        {waiting
          ? "Your beginning is saved. Storyhold is building the opening around the world and character you chose."
          : retry
            ? "Your beginning is saved. Try again to finish preparing your adventure."
            : "Let Storyhold prepare your opening before you make your first choice."}
      </p>
      {waiting ? (
        <div className="mt-4 rounded-xl border border-white/8 bg-black/15 p-3" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            <span>Preparing {context.worldName}</span>
            <span>{visibleStep + 1} / {steps.length}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${((visibleStep + 1) / steps.length) * 100}%` }} />
          </div>
          <p className="mt-3 break-words text-sm font-semibold text-foreground">{steps[visibleStep]}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">The opening will appear here when this saved preparation is complete.</p>
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-sm text-muted-foreground">{error}</p> : null}
      {!waiting ? <><p className="mt-3 text-xs text-muted-foreground">Adventure Preparation Uses Credits.</p><Button type="button" onClick={onPrepare} className="mt-4 rounded-xl">{retry ? "Try Again" : "Prepare Adventure"}</Button></> : null}
    </section>
  );
}
