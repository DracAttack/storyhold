import { Fragment, useMemo } from "react";
import { useZernioBestTimes, useZernioAccounts } from "@/hooks/api";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, Flame } from "lucide-react";

interface BestTimeSlot {
  day_of_week: number;
  hour: number;
  avg_engagement: number;
  post_count: number;
}

interface ZernioAccount {
  _id: string;
  platform?: string;
  displayName?: string;
  metadata?: {
    selectedPageId?: string;
    availablePages?: Array<{
      id: string;
      name?: string;
      username?: string;
      fan_count?: number;
      picture?: { data?: { url?: string } };
    }>;
  };
}

// Zernio's day_of_week convention: 0 = Sunday (matches JS Date.getDay())
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function hourLabel(h: number): string {
  if (h === 0) return "12a";
  if (h < 12) return `${h}a`;
  if (h === 12) return "12p";
  return `${h - 12}p`;
}

function CellTitle(slot: BestTimeSlot | undefined, day: number, hour: number): string {
  const base = `${DAY_LABELS[day]} ${hourLabel(hour)}`;
  if (!slot) return `${base} — no data`;
  return `${base} — avg engagement ${slot.avg_engagement} across ${slot.post_count} post${slot.post_count === 1 ? "" : "s"}`;
}

export function BestTimeHeatmap() {
  const { data, isLoading, isError } = useZernioBestTimes();
  const slots = ((data as { slots?: BestTimeSlot[] } | undefined)?.slots ?? []).filter(
    (s) =>
      typeof s.day_of_week === "number" &&
      typeof s.hour === "number" &&
      Number.isFinite(s.avg_engagement) &&
      s.day_of_week >= 0 &&
      s.day_of_week <= 6 &&
      s.hour >= 0 &&
      s.hour <= 23,
  );

  const { grid, max, best } = useMemo(() => {
    const grid = new Map<string, BestTimeSlot>();
    let max = 0;
    let best: BestTimeSlot | null = null;
    for (const s of slots) {
      grid.set(`${s.day_of_week}-${s.hour}`, s);
      if (s.avg_engagement > max) {
        max = s.avg_engagement;
        best = s;
      }
    }
    return { grid, max, best };
  }, [slots]);

  return (
    <Card
      className="bg-card/60 border-border transition-all duration-300 hover:border-pink-500/40 hover:shadow-[0_0_24px_-6px_rgba(244,114,182,0.35)]"
      data-testid="card-best-times"
    >
      <CardContent className="p-4 md:p-5">
        <div className="mb-4 flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 rounded-full bg-pink-400"
                style={{ boxShadow: "0 0 8px #f472b6" }}
              />
              Best Time to Post
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Average engagement by day &amp; hour, from Zernio
            </p>
          </div>
          {best && (
            <span
              className="flex items-center gap-1 text-xs font-semibold text-pink-400 drop-shadow-[0_0_8px_rgba(244,114,182,0.5)] shrink-0"
              data-testid="text-best-slot"
            >
              <Flame className="h-3.5 w-3.5" />
              {DAY_LABELS[best.day_of_week]} {hourLabel(best.hour)}
            </span>
          )}
        </div>

        {isLoading ? (
          <Skeleton className="h-44 rounded-lg" />
        ) : isError ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            Couldn't load best-time data from Zernio.
          </p>
        ) : slots.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center" data-testid="empty-best-times">
            Not enough posting history yet — the heatmap fills in as you post.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[620px]">
              <div className="grid gap-[3px]" style={{ gridTemplateColumns: "36px repeat(24, 1fr)" }}>
                <div />
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="text-center text-[8px] leading-4 text-muted-foreground h-4 whitespace-nowrap">
                    {hourLabel(h)}
                  </div>
                ))}
                {DAY_LABELS.map((label, day) => (
                  <Fragment key={day}>
                    <div className="text-[10px] text-muted-foreground flex items-center pr-1">
                      {label}
                    </div>
                    {Array.from({ length: 24 }, (_, hour) => {
                      const slot = grid.get(`${day}-${hour}`);
                      const intensity = slot && max > 0 ? slot.avg_engagement / max : 0;
                      const isBest = !!slot && !!best && slot === best;
                      return (
                        <div
                          key={`${day}-${hour}`}
                          title={CellTitle(slot, day, hour)}
                          className="aspect-square rounded-[3px] transition-colors"
                          style={{
                            backgroundColor:
                              intensity > 0
                                ? `rgba(244, 114, 182, ${0.15 + intensity * 0.75})`
                                : "rgba(148, 163, 184, 0.08)",
                            boxShadow: isBest
                              ? "0 0 8px rgba(244,114,182,0.8), inset 0 0 0 1px rgba(255,255,255,0.5)"
                              : intensity > 0.6
                                ? `0 0 6px rgba(244,114,182,${intensity * 0.5})`
                                : undefined,
                          }}
                        />
                      );
                    })}
                  </Fragment>
                ))}
              </div>
              <div className="flex items-center justify-end gap-1.5 mt-2 text-[10px] text-muted-foreground">
                Less
                {[0.1, 0.3, 0.55, 0.8, 1].map((v) => (
                  <span
                    key={v}
                    className="inline-block h-2.5 w-2.5 rounded-[2px]"
                    style={{ backgroundColor: `rgba(244, 114, 182, ${0.1 + v * 0.75})` }}
                  />
                ))}
                More
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function AudienceCard() {
  const { data, isLoading, isError } = useZernioAccounts();
  const accounts = (data as { accounts?: ZernioAccount[] } | undefined)?.accounts ?? [];

  // Only show the page each Zernio account actually posts to (selectedPageId),
  // not every page the connected Facebook user manages.
  const pages = accounts.flatMap((acc) =>
    (acc.metadata?.availablePages ?? [])
      .filter((p) => typeof p.id === "string" && p.id.length > 0)
      .filter((p) => !acc.metadata?.selectedPageId || p.id === acc.metadata.selectedPageId)
      .map((p) => ({
        id: p.id,
        name: p.name ?? acc.displayName ?? "Facebook Page",
        username: p.username,
        followers: Number.isFinite(p.fan_count) ? (p.fan_count as number) : 0,
        pictureUrl: p.picture?.data?.url,
      })),
  );

  const totalFollowers = pages.reduce((sum, p) => sum + p.followers, 0);

  return (
    <Card
      className="bg-card/60 border-border transition-all duration-300 hover:border-sky-500/40 hover:shadow-[0_0_24px_-6px_rgba(56,189,248,0.35)]"
      data-testid="card-audience"
    >
      <CardContent className="p-4 md:p-5">
        <div className="mb-4 flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 rounded-full bg-sky-400"
                style={{ boxShadow: "0 0 8px #38bdf8" }}
              />
              Audience
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">Followers per connected page</p>
          </div>
          <span
            className="text-2xl font-bold text-sky-400 drop-shadow-[0_0_10px_rgba(56,189,248,0.55)] shrink-0"
            data-testid="text-total-followers"
          >
            {totalFollowers.toLocaleString()}
          </span>
        </div>

        {isLoading ? (
          <Skeleton className="h-16 rounded-lg" />
        ) : isError ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            Couldn't load account data from Zernio.
          </p>
        ) : pages.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center" data-testid="empty-audience">
            No connected pages found on Zernio.
          </p>
        ) : (
          <div className="flex flex-col gap-2" data-testid="list-audience-pages">
            {pages.map((page) => (
              <div
                key={page.id}
                className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2"
              >
                <div className="h-9 w-9 rounded-full bg-muted overflow-hidden shrink-0 flex items-center justify-center">
                  {page.pictureUrl ? (
                    <img src={page.pictureUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <Users className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground truncate">{page.name}</p>
                  {page.username && (
                    <p className="text-xs text-muted-foreground truncate">@{page.username}</p>
                  )}
                </div>
                <span className="text-sm font-semibold text-foreground shrink-0">
                  {page.followers.toLocaleString()}{" "}
                  <span className="text-xs font-normal text-muted-foreground">followers</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
