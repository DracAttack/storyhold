import { useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import {
  useGetShareReport,
  getGetShareReportQueryKey,
  useGetPageViewReport,
  getGetPageViewReportQueryKey,
  useGetReaderJourneyReport,
  getGetReaderJourneyReportQueryKey,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Loader2, Share2, ArrowUpDown, Eye, Route } from "lucide-react";

const PLATFORM_LABELS: Record<string, string> = {
  facebook: "Facebook",
  x: "X",
  linkedin: "LinkedIn",
  pinterest: "Pinterest",
  reddit: "Reddit",
  copy: "Copy link",
  instagram: "Instagram",
  native: "Device share",
};

function platformLabel(p: string): string {
  return PLATFORM_LABELS[p] ?? p;
}

const PLACEMENT_LABELS: Record<string, string> = {
  inline_auto: "Inline (auto)",
  inline_manual: "Inline (manual)",
  more_like_this: "More like this",
  swipe_next: "Swipe next",
  homepage: "Homepage",
  category_page: "Category page",
  author_page: "Author page",
  search: "Search",
};

function placementLabel(p: string): string {
  return PLACEMENT_LABELS[p] ?? p;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// Map a tracked content identifier to its public URL. Articles use their slug;
// explicit page keys (e.g. "home") link to the page itself.
function contentHref(slug: string): string {
  if (slug === "home") return "/";
  return `/article/${slug}`;
}

type RangeKey = "7" | "30" | "90" | "all";

const RANGES: { key: RangeKey; label: string; days: number | null }[] = [
  { key: "7", label: "Last 7 days", days: 7 },
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 90 days", days: 90 },
  { key: "all", label: "All time", days: null },
];

// Start of today in UTC, as ms.
function utcTodayStartMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY_MS = 86400000;

export default function AdminShares() {
  const [range, setRange] = useState<RangeKey>("30");
  const [sortDesc, setSortDesc] = useState(true);

  const selected = RANGES.find((r) => r.key === range) ?? RANGES[1];

  // Compute the [from, to) window for the selected range. `to` is the start of
  // tomorrow (UTC) so today's shares are included; `from` is start-of-day N-1
  // days ago, giving an inclusive N-day window. "All time" omits `from`.
  const { from, to } = useMemo(() => {
    const todayStart = utcTodayStartMs();
    const toMs = todayStart + DAY_MS;
    if (selected.days === null) return { from: undefined, to: undefined as string | undefined };
    const fromMs = todayStart - (selected.days - 1) * DAY_MS;
    return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
  }, [selected.days]);

  const { data, isLoading, isFetching } = useGetShareReport(
    { from, to },
    { query: { placeholderData: keepPreviousData, queryKey: getGetShareReportQueryKey({ from, to }) } },
  );

  const { data: views, isFetching: viewsFetching } = useGetPageViewReport(
    { from, to },
    { query: { placeholderData: keepPreviousData, queryKey: getGetPageViewReportQueryKey({ from, to }) } },
  );

  const { data: journey, isFetching: journeyFetching } = useGetReaderJourneyReport(
    { from, to },
    { query: { placeholderData: keepPreviousData, queryKey: getGetReaderJourneyReportQueryKey({ from, to }) } },
  );

  const topViewed = useMemo(
    () => (views ? [...views.byArticle].sort((a, b) => b.total - a.total).slice(0, 10) : []),
    [views],
  );

  // Build a continuous daily series filling zero-share gaps so the chart axis is
  // even. For a fixed range we know the start/end; for "all time" we span from
  // the earliest recorded day through today.
  const chartData = useMemo(() => {
    if (!data) return [] as { date: string; label: string; count: number }[];
    const counts = new Map(data.byDay.map((d) => [d.date, d.count]));
    const todayStart = utcTodayStartMs();

    let startMs: number;
    if (selected.days !== null) {
      startMs = todayStart - (selected.days - 1) * DAY_MS;
    } else if (data.byDay.length > 0) {
      startMs = Date.parse(`${data.byDay[0].date}T00:00:00Z`);
    } else {
      return [];
    }

    const out: { date: string; label: string; count: number }[] = [];
    for (let ms = startMs; ms <= todayStart; ms += DAY_MS) {
      const key = utcDayKey(ms);
      out.push({
        date: key,
        label: new Date(ms).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }),
        count: counts.get(key) ?? 0,
      });
    }
    return out;
  }, [data, selected.days]);

  if (isLoading || !data) {
    return (
      <div className="p-4 md:p-8">
        <Loader2 className="animate-spin" />
      </div>
    );
  }

  const byArticle = [...data.byArticle].sort((a, b) => (sortDesc ? b.total - a.total : a.total - b.total));

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl">
      <div>
        <h1 className="font-serif text-3xl font-bold">Shares</h1>
        <p className="text-muted-foreground mt-1">
          How often readers clicked the Share buttons — recorded by BrainHook itself, no Google account needed.
        </p>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {RANGES.map((r) => (
          <Button
            key={r.key}
            variant={r.key === range ? "default" : "outline"}
            size="sm"
            onClick={() => setRange(r.key)}
          >
            {r.label}
          </Button>
        ))}
        {isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      <Card className="p-4 md:p-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h2 className="font-serif text-xl font-bold flex items-center gap-2">
                  <Route className="h-5 w-5" />
                  Reader journeys
                  {journeyFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  How anonymous readers move between articles in a session — recorded by BrainHook itself, no
                  personal data and no Google account needed.
                </p>
              </div>
            </div>

            {!journey ? (
              <p className="mt-4 text-sm text-muted-foreground">Loading reader journeys…</p>
            ) : journey.sessionsWithView === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">
                No reader journeys in this range yet. Data appears here as readers browse between articles.
              </p>
            ) : (
              <>
                <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  {[
                    { label: "Visitors", value: journey.anonymousVisitors.toLocaleString() },
                    { label: "Returning", value: journey.returningVisitors.toLocaleString() },
                    { label: "Sessions", value: journey.sessions.toLocaleString() },
                    { label: "Recirculation", value: pct(journey.recirculationRate) },
                    { label: "Avg reads / session", value: journey.avgViewsPerSession.toFixed(2) },
                    { label: "Recirculating", value: journey.recirculatingSessions.toLocaleString() },
                  ].map((m) => (
                    <div key={m.label} className="rounded-lg border bg-muted/30 p-3">
                      <div className="text-2xl font-bold tabular-nums">{m.value}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{m.label}</div>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Recirculation = sessions that read 2+ articles ÷ sessions that read at least one
                  ({journey.recirculatingSessions.toLocaleString()} / {journey.sessionsWithView.toLocaleString()}).
                </p>

                {journey.sessionDepth.length > 0 && (
                  <div className="mt-6 border-t pt-4">
                    <h3 className="font-serif text-lg font-bold mb-3">Session depth</h3>
                    <p className="text-sm text-muted-foreground -mt-2 mb-3">
                      How many distinct articles readers viewed in a single session.
                    </p>
                    <div className="space-y-2">
                      {(() => {
                        const maxDepth = Math.max(...journey.sessionDepth.map((d) => d.sessions), 1);
                        return journey.sessionDepth.map((d) => (
                          <div key={d.views} className="flex items-center gap-3">
                            <div className="w-16 shrink-0 text-sm text-muted-foreground">
                              {d.views >= 4 ? "4+ reads" : d.views === 1 ? "1 read" : `${d.views} reads`}
                            </div>
                            <div className="flex-1 h-5 rounded bg-muted/40 overflow-hidden">
                              <div
                                className="h-full bg-primary/70"
                                style={{ width: `${Math.round((d.sessions / maxDepth) * 100)}%` }}
                              />
                            </div>
                            <div className="w-16 shrink-0 text-right text-sm font-semibold tabular-nums">
                              {d.sessions.toLocaleString()}
                            </div>
                          </div>
                        ));
                      })()}
                    </div>
                  </div>
                )}

                {journey.entryArticles.length > 0 && (
                  <div className="mt-6 border-t pt-4">
                    <h3 className="font-serif text-lg font-bold mb-3">Entry articles</h3>
                    <p className="text-sm text-muted-foreground -mt-2 mb-3">
                      Where sessions started, ranked by how often the reader continued to a second article.
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm min-w-[480px]">
                        <thead>
                          <tr className="text-xs uppercase tracking-wider text-muted-foreground border-b">
                            <th className="text-left font-medium py-2 pr-3">Article</th>
                            <th className="text-right font-medium py-2 px-3 w-24">Sessions</th>
                            <th className="text-right font-medium py-2 px-3 w-24">Continued</th>
                            <th className="text-right font-medium py-2 pl-3 w-24">Rate</th>
                          </tr>
                        </thead>
                        <tbody>
                          {journey.entryArticles.map((a) => (
                            <tr key={a.slug} className="border-b last:border-0">
                              <td className="py-2.5 pr-3">
                                <a
                                  href={contentHref(a.slug)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="font-medium hover:text-primary"
                                >
                                  {a.title}
                                </a>
                              </td>
                              <td className="py-2.5 px-3 text-right tabular-nums">{a.sessions.toLocaleString()}</td>
                              <td className="py-2.5 px-3 text-right tabular-nums">{a.continued.toLocaleString()}</td>
                              <td className="py-2.5 pl-3 text-right font-bold tabular-nums">{pct(a.continuationRate)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {journey.topTransitions.length > 0 && (
                  <div className="mt-6 border-t pt-4">
                    <h3 className="font-serif text-lg font-bold mb-3">Top article-to-article hops</h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm min-w-[480px]">
                        <thead>
                          <tr className="text-xs uppercase tracking-wider text-muted-foreground border-b">
                            <th className="text-left font-medium py-2 pr-3">From → To</th>
                            <th className="text-right font-medium py-2 pl-3 w-24">Readers</th>
                          </tr>
                        </thead>
                        <tbody>
                          {journey.topTransitions.map((t) => (
                            <tr key={`${t.fromSlug}->${t.toSlug}`} className="border-b last:border-0">
                              <td className="py-2.5 pr-3">
                                <span className="font-mono text-[11px] break-all">{t.fromSlug}</span>
                                <span className="text-muted-foreground"> → </span>
                                <span className="font-mono text-[11px] break-all">{t.toSlug}</span>
                              </td>
                              <td className="py-2.5 pl-3 text-right font-bold tabular-nums">{t.count.toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {journey.topPaths.length > 0 && (
                  <div className="mt-6 border-t pt-4">
                    <h3 className="font-serif text-lg font-bold mb-3">Top reader paths</h3>
                    <p className="text-sm text-muted-foreground -mt-2 mb-3">
                      The most common full sequences of articles read within a session.
                    </p>
                    <div className="space-y-2">
                      {journey.topPaths.map((p, i) => (
                        <div
                          key={`${i}-${p.path.join(">")}`}
                          className="flex items-start justify-between gap-3 border-b last:border-0 py-2"
                        >
                          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                            {p.path.map((slug, j) => (
                              <span key={`${slug}-${j}`} className="flex items-center gap-1.5">
                                {j > 0 && <span className="text-muted-foreground">→</span>}
                                <span className="font-mono text-[11px] break-all">{slug}</span>
                              </span>
                            ))}
                          </div>
                          <span className="shrink-0 font-bold tabular-nums text-sm">{p.count.toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {journey.clicksByPlacement.length > 0 && (
                  <div className="mt-6 border-t pt-4">
                    <h3 className="font-serif text-lg font-bold mb-3">Recommendation clicks by placement</h3>
                    <div className="flex flex-wrap gap-2">
                      {journey.clicksByPlacement.map((c) => (
                        <span
                          key={c.placement}
                          className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground"
                        >
                          {placementLabel(c.placement)}
                          <span className="font-semibold text-foreground tabular-nums">{c.count.toLocaleString()}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {journey.clicksByRank.length > 0 && (
                  <div className="mt-6 border-t pt-4">
                    <h3 className="font-serif text-lg font-bold mb-3">Recommendation clicks by rank</h3>
                    <p className="text-sm text-muted-foreground -mt-2 mb-3">
                      Which position in the recommendation lists readers clicked (rank 1 = top suggestion).
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {journey.clicksByRank.map((c) => (
                        <span
                          key={c.rank}
                          className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground"
                        >
                          Rank {c.rank}
                          <span className="font-semibold text-foreground tabular-nums">{c.count.toLocaleString()}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-6 border-t pt-4">
                  <h3 className="font-serif text-lg font-bold mb-3">Swipe-to-next prompt</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                    {[
                      { label: "Impressions", value: journey.swipe.impressions.toLocaleString() },
                      { label: "Activations", value: journey.swipe.activations.toLocaleString() },
                      { label: "Via swipe", value: journey.swipe.swipeActivations.toLocaleString() },
                      { label: "Via click", value: journey.swipe.clickActivations.toLocaleString() },
                      { label: "Activation rate", value: pct(journey.swipe.activationRate) },
                    ].map((m) => (
                      <div key={m.label} className="rounded-lg border bg-muted/30 p-3">
                        <div className="text-2xl font-bold tabular-nums">{m.value}</div>
                        <div className="text-xs text-muted-foreground mt-0.5">{m.label}</div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Dismissed without acting: {journey.swipe.dismissals.toLocaleString()}.
                  </p>
                </div>
              </>
            )}
      </Card>

      <Card className="p-4 md:p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="font-serif text-xl font-bold flex items-center gap-2">
              <Eye className="h-5 w-5" />
              Page views
              {viewsFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              Article reads counted by BrainHook itself — no Google account needed.
            </p>
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold tabular-nums">{(views?.total ?? 0).toLocaleString()}</div>
            <div className="text-sm text-muted-foreground">total views</div>
          </div>
        </div>

        {topViewed.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm min-w-[420px]">
              <thead>
                <tr className="text-xs uppercase tracking-wider text-muted-foreground border-b">
                  <th className="text-left font-medium py-2 pr-3">Most viewed article</th>
                  <th className="text-right font-medium py-2 pl-3 w-24">Views</th>
                </tr>
              </thead>
              <tbody>
                {topViewed.map((a) => (
                  <tr key={a.slug} className="border-b last:border-0">
                    <td className="py-2.5 pr-3">
                      <a
                        href={contentHref(a.slug)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium hover:text-primary"
                      >
                        {a.title}
                      </a>
                    </td>
                    <td className="py-2.5 pl-3 text-right font-bold tabular-nums">{a.total.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            No page views in this range yet. Counts appear here as readers open articles.
          </p>
        )}

        {views && views.bySource.length > 0 && (
          <div className="mt-6 border-t pt-4">
            <h3 className="font-serif text-lg font-bold">Traffic sources</h3>
            <p className="text-sm text-muted-foreground mt-1 mb-3">
              Where these views came from — from share-link UTMs or the referring site, else "direct".
              The second line shows the exact link followed (campaign · content, where content is the article slug).
              Only counts views recorded since this shipped.
            </p>
            <div className="space-y-2.5">
              {views.bySource.map((s) => {
                const pct = views.total > 0 ? Math.round((s.count / views.total) * 100) : 0;
                const detail = [s.campaign, s.content].filter(Boolean).join(" · ");
                return (
                  <div
                    key={`${s.source}/${s.medium}/${s.campaign ?? ""}/${s.content ?? ""}`}
                    className="flex items-center gap-3 text-sm"
                  >
                    <div className="w-56 shrink-0 min-w-0">
                      <div className="truncate font-medium" title={`${s.source} / ${s.medium}`}>
                        {s.source}
                        <span className="text-muted-foreground"> / {s.medium}</span>
                      </div>
                      {detail && (
                        <div className="truncate font-mono text-[11px] text-muted-foreground" title={detail}>
                          {detail}
                        </div>
                      )}
                    </div>
                    <div className="flex-1 bg-muted rounded-full h-2.5 overflow-hidden">
                      <div className="bg-primary h-full rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="w-16 text-right tabular-nums text-muted-foreground">{s.count.toLocaleString()}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Card>

      {data.total === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <Share2 className="h-8 w-8 mx-auto mb-2 opacity-40" />
          No shares in this range. Try a longer range, or check back as readers click the Share buttons on articles.
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <Card className="p-6">
              <div className="text-3xl font-bold">{data.total}</div>
              <div className="text-sm text-muted-foreground mt-1">Total shares</div>
            </Card>
            <Card className="p-6">
              <div className="text-3xl font-bold">{data.byArticle.length}</div>
              <div className="text-sm text-muted-foreground mt-1">Items shared</div>
            </Card>
            <Card className="p-6">
              <div className="text-3xl font-bold">{data.byPlatform.length}</div>
              <div className="text-sm text-muted-foreground mt-1">Platforms used</div>
            </Card>
          </div>

          {chartData.length > 0 && (
            <Card className="p-4 md:p-6">
              <h2 className="font-serif text-xl font-bold mb-4">Shares over time</h2>
              <ChartContainer
                config={{ count: { label: "Shares", color: "hsl(var(--primary))" } }}
                className="aspect-auto h-[240px] w-full"
              >
                <BarChart data={chartData} margin={{ left: 4, right: 4, top: 4 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={24}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                    width={28}
                    tickMargin={4}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="var(--color-count)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ChartContainer>
            </Card>
          )}

          <Card className="p-4 md:p-6">
            <h2 className="font-serif text-xl font-bold mb-4">By platform</h2>
            <div className="space-y-2">
              {data.byPlatform.map((p) => {
                const pct = data.total > 0 ? Math.round((p.count / data.total) * 100) : 0;
                return (
                  <div key={p.platform} className="flex items-center gap-3 text-sm">
                    <div className="w-24 shrink-0 font-medium">{platformLabel(p.platform)}</div>
                    <div className="flex-1 bg-muted rounded-full h-2.5 overflow-hidden">
                      <div className="bg-primary h-full rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="w-16 text-right tabular-nums text-muted-foreground">{p.count}</div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="p-4 md:p-6">
            <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
              <h2 className="font-serif text-xl font-bold">By article / page</h2>
              <Button variant="outline" size="sm" onClick={() => setSortDesc((s) => !s)}>
                <ArrowUpDown className="h-4 w-4 mr-2" />
                {sortDesc ? "Most shared first" : "Least shared first"}
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[560px]">
                <thead>
                  <tr className="text-xs uppercase tracking-wider text-muted-foreground border-b">
                    <th className="text-left font-medium py-2 pr-3">Article / page</th>
                    <th className="text-left font-medium py-2 px-3">Breakdown</th>
                    <th className="text-right font-medium py-2 pl-3 w-20">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {byArticle.map((a) => (
                    <tr key={a.slug} className="border-b last:border-0 align-top">
                      <td className="py-3 pr-3">
                        <a
                          href={contentHref(a.slug)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium hover:text-primary"
                        >
                          {a.title}
                        </a>
                        <div className="mt-0.5 font-mono text-[11px] text-muted-foreground break-all">
                          utm_content={a.slug}
                        </div>
                      </td>
                      <td className="py-3 px-3">
                        <div className="flex flex-wrap gap-1.5">
                          {a.platforms.map((p) => (
                            <span
                              key={p.platform}
                              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                            >
                              {platformLabel(p.platform)}
                              <span className="font-semibold text-foreground">{p.count}</span>
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="py-3 pl-3 text-right font-bold tabular-nums">{a.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

    </div>
  );
}
