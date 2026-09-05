import { ChevronDown, Scale } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { presentCampaignCheck } from "@/lib/campaignCheckPresentation";
import type { CampaignCheckProjection, ResolutionMode } from "@/lib/storyholdApi";

export function CampaignCheckResult({
  check,
  resolutionMode,
}: {
  check: CampaignCheckProjection | null | undefined;
  resolutionMode: ResolutionMode;
}) {
  const view = presentCampaignCheck(check, resolutionMode);
  if (!view || resolutionMode === "story_first") return null;

  return (
    <div className="mt-4 rounded-xl border border-primary/15 bg-primary/[0.035] px-3.5 py-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 font-semibold text-foreground/85">
          <Scale className="h-3.5 w-3.5 text-primary" /> What Shaped the Outcome
        </span>
        {view.difficulty ? (
          <Badge variant="outline" className="h-5 border-white/10 px-1.5 text-[10px]">
            {view.difficulty} Difficulty
          </Badge>
        ) : null}
        {view.factors.map((factor, index) => (
          <Badge
            key={`${factor.label}-${factor.influence}-${index}`}
            variant="outline"
            className={`h-5 px-1.5 text-[10px] ${
              factor.influence === "helps"
                ? "border-emerald-300/20 text-emerald-200"
                : factor.influence === "hinders"
                  ? "border-amber-300/20 text-amber-100"
                  : "border-white/10 text-muted-foreground"
            }`}
          >
            {factor.label} · {factor.influence === "helps" ? "Helped" : factor.influence === "hinders" ? "Hindered" : "Neutral"}
          </Badge>
        ))}
        {view.numbers.map((number) => (
          <span key={number.label} className="rounded-md bg-black/20 px-2 py-1 text-muted-foreground">
            {number.label} <strong className="font-semibold text-foreground/85">{number.value}</strong>
          </span>
        ))}
      </div>
      {view.breakdown.length ? (
        <details className="group mt-2 border-t border-white/8 pt-2 text-muted-foreground">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium hover:text-foreground">
            <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
            Show Calculation
          </summary>
          <div className="mt-2 grid gap-1 sm:grid-cols-2">
            {view.breakdown.map((factor, index) => (
              <div key={`${factor.label}-${index}`} className="flex justify-between gap-4 rounded-md bg-black/15 px-2 py-1.5">
                <span>{factor.label}</span>
                <strong className="font-semibold text-foreground/80">{factor.value}</strong>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
