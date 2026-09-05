import { useId, useState, type ComponentType } from "react";
import {
  Activity,
  Backpack,
  ChevronDown,
  Compass,
  HeartPulse,
  MapPin,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  presentCampaignRpgState,
  type CampaignRpgPresentedOverview,
  type CampaignRpgPresentedSection,
  type CampaignRpgStateViewModel,
} from "@/lib/campaignRpgState";
import { cn } from "@/lib/utils";

type StatePanelProps = {
  state: CampaignRpgStateViewModel;
  defaultExpanded?: boolean;
  className?: string;
};

type StateIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

const overviewIcons: Record<CampaignRpgPresentedOverview["id"], StateIcon> = {
  objective: Target,
  location: MapPin,
  vitality: HeartPulse,
  stress: Activity,
};

const sectionIcons: Record<CampaignRpgPresentedSection["id"], StateIcon> = {
  objectives: Target,
  conditions: Activity,
  capabilities: Sparkles,
  equipment: ShieldCheck,
  inventory: Backpack,
  companions: Users,
  reputation: Compass,
};

function RulesBreakdown({
  values,
}: {
  values: CampaignRpgPresentedOverview["breakdown"];
}) {
  if (!values.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Rules Breakdown">
      {values.map((entry, index) => (
        <span
          key={`${entry.label}-${index}`}
          className="rounded-md border border-primary/15 bg-primary/[0.05] px-1.5 py-0.5 text-[10px] text-muted-foreground"
        >
          {entry.label} <strong className="text-foreground">{entry.value}</strong>
        </span>
      ))}
    </div>
  );
}

function OverviewCard({ item }: { item: CampaignRpgPresentedOverview }) {
  const Icon = overviewIcons[item.id];
  return (
    <div className="min-w-0 rounded-xl border border-white/8 bg-black/15 p-3">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{item.label}</span>
      </div>
      <div className="mt-1.5 flex min-w-0 items-baseline justify-between gap-2">
        <p className="truncate text-sm font-semibold text-foreground">{item.value}</p>
        {item.number ? (
          <span className="shrink-0 font-mono text-xs font-semibold tabular-nums text-foreground">
            {item.number}
          </span>
        ) : null}
      </div>
      {item.summary ? (
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
          {item.summary}
        </p>
      ) : null}
      <RulesBreakdown values={item.breakdown} />
    </div>
  );
}

function DetailSection({
  section,
  headingId,
}: {
  section: CampaignRpgPresentedSection;
  headingId: string;
}) {
  const Icon = sectionIcons[section.id];
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <h3
        id={headingId}
        className="flex items-center gap-2 text-xs font-semibold text-primary"
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {section.label}
      </h3>
      <ul className="mt-2 divide-y divide-white/8 rounded-xl border border-white/8 bg-black/10 px-3">
        {section.items.map((item) => (
          <li key={item.id} className="py-2.5 first:pt-2.5 last:pb-2.5">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="text-sm font-medium text-foreground">{item.title}</p>
                  {item.tags.map((tag) => (
                    <Badge
                      key={tag}
                      variant="outline"
                      className="h-5 border-amber-400/20 px-1.5 text-[9px] text-amber-200"
                    >
                      {tag}
                    </Badge>
                  ))}
                </div>
                {item.summary ? (
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {item.summary}
                  </p>
                ) : null}
                {item.detail ? (
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground/80">
                    {item.detail}
                  </p>
                ) : null}
              </div>
              {item.value ? (
                <span className="shrink-0 font-mono text-xs font-semibold tabular-nums text-foreground">
                  {item.value}
                </span>
              ) : null}
            </div>
            <RulesBreakdown values={item.breakdown} />
          </li>
        ))}
      </ul>
      {section.overflowCount ? (
        <p className="mt-1.5 text-[10px] text-muted-foreground">
          {section.overflowCount} more tracked in the full character record.
        </p>
      ) : null}
    </section>
  );
}

export function CampaignRpgStatePanel({
  state,
  defaultExpanded = false,
  className,
}: StatePanelProps) {
  const panelId = useId();
  const headingId = `${panelId}-heading`;
  const contentId = `${panelId}-details`;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const presentation = presentCampaignRpgState(state);
  const hasVisibleDetails = presentation.sections.length > 0;

  return (
    <Card
      className={cn(
        "overflow-hidden rounded-2xl border-white/8 bg-white/[0.025]",
        className,
      )}
      data-rpg-view={state.mode}
      role="region"
      aria-labelledby={headingId}
    >
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
              At a Glance
            </p>
            <h2 id={headingId} className="mt-1 font-serif text-xl font-bold text-foreground">
              {presentation.heading}
            </h2>
          </div>
          <Badge variant="outline" className="shrink-0 border-primary/20 text-[10px] text-primary">
            {presentation.modeLabel}
          </Badge>
        </div>

        {presentation.overview.length ? (
          <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),1fr))] gap-2">
            {presentation.overview.map((item) => (
              <OverviewCard key={item.id} item={item} />
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            No character details are visible right now.
          </p>
        )}
      </div>

      {hasVisibleDetails ? (
        <div className="border-t border-white/8">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => setExpanded((current) => !current)}
            className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-left text-xs font-semibold text-foreground transition-colors hover:bg-white/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-inset sm:px-5"
          >
            <span>{expanded ? "Hide Character Details" : "Show Character Details"}</span>
            <ChevronDown
              className={cn("h-4 w-4 text-muted-foreground transition-transform", expanded && "rotate-180")}
              aria-hidden
            />
          </button>
          <div id={contentId} hidden={!expanded}>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-5 border-t border-white/8 px-4 py-4 sm:px-5">
              {presentation.sections.map((section) => (
                <DetailSection
                  key={section.id}
                  section={section}
                  headingId={`${contentId}-${section.id}`}
                />
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export default CampaignRpgStatePanel;
