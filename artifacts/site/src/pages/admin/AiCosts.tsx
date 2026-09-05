import { useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import {
  useGetAiUsageReport,
  getGetAiUsageReportQueryKey,
  useGetAiUsageDayDetail,
  getGetAiUsageDayDetailQueryKey,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis, Cell } from "recharts";
import { Loader2, DollarSign, X, AlertTriangle } from "lucide-react";
import { Link } from "wouter";

type RangeKey = "today" | "7" | "30" | "all";

const RANGES: { key: RangeKey; label: string; days: number | null }[] = [
  { key: "today", label: "Today", days: 1 },
  { key: "7", label: "Last 7 days", days: 7 },
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "all", label: "All time", days: null },
];

// Human labels for the pipeline operation ids recorded by the cost meter.
const OPERATION_LABELS: Record<string, string> = {
  generateArticleDraft: "Article draft",
  generateHooksAndSocialPack: "Headlines + social pack",
  generateIdeasForAuthor: "Idea generation (author)",
  generateIdeasForBeat: "Idea generation (beat)",
  scoutTrendSignalsForBeat: "Trend Radar scout",
  pickBestAuthorForIdea: "Author picker",
  llmConceptDuplicateCheck: "Dedupe — concept judge",
  llmTitleSimilarityCheck: "Dedupe — title twin",
  llmRewriteTitle: "Title rewrite",
  regenerateBlock: "Editor — regenerate block",
  insertInternalLinks: "Internal links",
  insertSourceLinks: "Source links",
  generateAndStoreHeroImage: "Hero image",
};

function operationLabel(op: string): string {
  return OPERATION_LABELS[op] ?? op;
}

// USD formatter that keeps sub-cent precision for tiny per-call costs but reads
// cleanly for larger totals.
function usd(n: number): string {
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function utcTodayStartMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY_MS = 86400000;

function DayDetailPanel({ date, onClose }: { date: string; onClose: () => void }) {
  const { data, isLoading } = useGetAiUsageDayDetail(
    { date },
    { query: { queryKey: getGetAiUsageDayDetailQueryKey({ date }), staleTime: 30000 } },
  );

  const maxOpCost = Math.max(0, ...(data?.byOperation.map((o) => o.costUsd) ?? []));

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader className="pb-4">
          <div className="flex items-center justify-between">
            <SheetTitle className="font-serif text-xl">
              {new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}
            </SheetTitle>
            <Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button>
          </div>
        </SheetHeader>

        {isLoading || !data ? (
          <div className="flex justify-center py-12"><Loader2 className="animate-spin" /></div>
        ) : (
          <div className="space-y-5 pb-8">
            <div className="flex gap-4">
              <Card className="p-4 flex-1">
                <div className="text-2xl font-bold tabular-nums">{usd(data.totalCostUsd)}</div>
                <div className="text-xs text-muted-foreground mt-1">Total spend</div>
              </Card>
              <Card className="p-4 flex-1">
                <div className="text-2xl font-bold tabular-nums">{data.totalCalls.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground mt-1">AI calls</div>
              </Card>
            </div>

            {data.byOperation.length > 0 && (
              <div>
                <h3 className="font-semibold text-sm mb-2">By operation</h3>
                <div className="space-y-1.5">
                  {data.byOperation.map((o) => {
                    const pct = maxOpCost > 0 ? Math.round((o.costUsd / maxOpCost) * 100) : 0;
                    return (
                      <div key={o.operation} className="flex items-center gap-2 text-sm">
                        <div className="w-36 shrink-0 truncate text-xs" title={operationLabel(o.operation)}>
                          {operationLabel(o.operation)}
                        </div>
                        <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
                          <div className="bg-primary h-full rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="w-16 text-right tabular-nums text-xs font-semibold">{usd(o.costUsd)}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {data.byModel.length > 0 && (
              <div>
                <h3 className="font-semibold text-sm mb-2">By model</h3>
                <div className="space-y-1">
                  {data.byModel.map((m) => (
                    <div key={m.model} className="flex items-center gap-2 text-sm py-1 border-b last:border-0">
                      <div className="flex-1 min-w-0 truncate text-xs font-medium" title={m.model}>{m.model}</div>
                      <div className="text-xs text-muted-foreground tabular-nums shrink-0">{m.calls.toLocaleString()} calls</div>
                      <div className="tabular-nums text-xs font-semibold shrink-0 w-16 text-right">{usd(m.costUsd)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.expensiveModelOperations.length > 0 && (
              <div>
                <h3 className="font-semibold text-sm mb-2 flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                  On an expensive model
                </h3>
                <p className="text-xs text-muted-foreground mb-2">
                  Operations still running on Sonnet/Opus — candidates to route down.
                </p>
                <div className="space-y-1">
                  {data.expensiveModelOperations.map((o) => (
                    <div key={`${o.operation}-${o.model}`} className="flex items-center gap-2 text-sm py-1 border-b last:border-0">
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium truncate">{operationLabel(o.operation)}</div>
                        <div className="text-[11px] text-muted-foreground truncate" title={o.model}>{o.model} · {o.calls.toLocaleString()} calls</div>
                      </div>
                      <div className="tabular-nums text-xs font-semibold shrink-0 w-16 text-right">{usd(o.costUsd)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.topCalls.length > 0 && (
              <div>
                <h3 className="font-semibold text-sm mb-2">Most expensive calls</h3>
                <div className="space-y-1">
                  {data.topCalls.map((c) => (
                    <div key={c.id} className="flex items-center gap-2 text-sm py-1 border-b last:border-0">
                      <div className="flex-1 min-w-0">
                        {c.articleId ? (
                          <Link href={`/admin/articles/${c.articleId}`} className="text-xs font-medium hover:underline truncate block">
                            {operationLabel(c.operation)} — {c.articleTitle ?? c.articleId}
                          </Link>
                        ) : (
                          <div className="text-xs font-medium truncate">{operationLabel(c.operation)}</div>
                        )}
                        <div className="text-[11px] text-muted-foreground truncate" title={c.model}>
                          {c.model}
                          {c.webSearches > 0 ? ` · ${c.webSearches} web` : ""}
                          {c.images > 0 ? ` · ${c.images} img` : ""}
                        </div>
                      </div>
                      <div className="tabular-nums text-xs font-semibold shrink-0 w-16 text-right">{usd(c.costUsd)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.topArticles.length > 0 && (
              <div>
                <h3 className="font-semibold text-sm mb-2">Top articles</h3>
                <div className="space-y-1">
                  {data.topArticles.map((a, i) => (
                    <div key={a.articleId ?? i} className="flex items-center gap-2 text-sm py-1 border-b last:border-0">
                      <div className="flex-1 min-w-0">
                        {a.articleId ? (
                          <Link
                            href={`/admin/articles/${a.articleId}`}
                            className="truncate font-medium hover:underline block text-xs"
                          >
                            {a.title ?? a.articleId}
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">Unknown article</span>
                        )}
                      </div>
                      <div className="tabular-nums text-xs font-semibold shrink-0">{usd(a.costUsd)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.topMemes.length > 0 && (
              <div>
                <h3 className="font-semibold text-sm mb-2">Top memes</h3>
                <div className="space-y-1">
                  {data.topMemes.map((m, i) => (
                    <div key={m.memeId ?? i} className="flex items-center gap-2 text-sm py-1 border-b last:border-0">
                      <div className="flex-1 min-w-0">
                        {m.memeId ? (
                          <Link
                            href={`/admin/memes/${m.memeId}`}
                            className="truncate font-medium hover:underline block text-xs"
                          >
                            Meme {m.memeId.slice(0, 8)}…
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">Unknown meme</span>
                        )}
                      </div>
                      <div className="tabular-nums text-xs font-semibold shrink-0">{usd(m.costUsd)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.totalCalls === 0 && (
              <p className="text-muted-foreground text-sm text-center py-4">No AI spend on this day.</p>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default function AdminAiCosts() {
  const [range, setRange] = useState<RangeKey>("30");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const selected = RANGES.find((r) => r.key === range) ?? RANGES[2];

  // Compute the [from, to) window for the selected range. `to` is the start of
  // tomorrow (UTC) so today is included; `from` is start-of-day N-1 days ago.
  // "All time" omits `from`.
  const { from, to } = useMemo(() => {
    const todayStart = utcTodayStartMs();
    const toMs = todayStart + DAY_MS;
    if (selected.days === null) return { from: undefined, to: undefined as string | undefined };
    const fromMs = todayStart - (selected.days - 1) * DAY_MS;
    return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
  }, [selected.days]);

  const { data, isLoading, isFetching } = useGetAiUsageReport(
    { from, to },
    { query: { placeholderData: keepPreviousData, queryKey: getGetAiUsageReportQueryKey({ from, to }) } },
  );

  // Build a continuous daily spend series filling zero-cost gaps so the chart
  // axis is even. For a fixed range we know the start/end; for "all time" we
  // span from the earliest recorded day through today.
  const chartData = useMemo(() => {
    if (!data) return [] as { date: string; label: string; cost: number }[];
    const costs = new Map(data.byDay.map((d) => [d.date, d.costUsd]));
    const todayStart = utcTodayStartMs();

    let startMs: number;
    if (selected.days !== null) {
      startMs = todayStart - (selected.days - 1) * DAY_MS;
    } else if (data.byDay.length > 0) {
      startMs = Date.parse(`${data.byDay[0].date}T00:00:00Z`);
    } else {
      return [];
    }

    const out: { date: string; label: string; cost: number }[] = [];
    for (let ms = startMs; ms <= todayStart; ms += DAY_MS) {
      const key = utcDayKey(ms);
      out.push({
        date: key,
        label: new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }),
        cost: Number((costs.get(key) ?? 0).toFixed(4)),
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

  const maxModelCost = Math.max(0, ...data.byModel.map((m) => m.costUsd));

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl">
      {selectedDay && <DayDetailPanel date={selectedDay} onClose={() => setSelectedDay(null)} />}

      <div>
        <h1 className="font-serif text-3xl font-bold flex items-center gap-2">
          <DollarSign className="h-7 w-7" />
          AI costs
        </h1>
        <p className="text-muted-foreground mt-1">
          What BrainHook spends on AI — token usage, web searches, and hero images, billed at provider list
          prices and recorded per call as the pipeline runs.
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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-6">
          <div className="text-3xl font-bold tabular-nums">{usd(data.totalCostUsd)}</div>
          <div className="text-sm text-muted-foreground mt-1">Total spend</div>
        </Card>
        <Card className="p-6">
          <div className="text-3xl font-bold tabular-nums">{usd(data.costPerArticleUsd)}</div>
          <div className="text-sm text-muted-foreground mt-1">Avg per article ({data.articleCount.toLocaleString()})</div>
        </Card>
        <Card className="p-6">
          <div className="text-3xl font-bold tabular-nums">{data.totalCalls.toLocaleString()}</div>
          <div className="text-sm text-muted-foreground mt-1">AI calls</div>
        </Card>
        <Card className="p-6">
          <div className="text-3xl font-bold tabular-nums">{data.totalImages.toLocaleString()}</div>
          <div className="text-sm text-muted-foreground mt-1">Hero images</div>
        </Card>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="text-xl font-bold tabular-nums">{data.totalInputTokens.toLocaleString()}</div>
          <div className="text-xs text-muted-foreground mt-1">Input tokens</div>
        </Card>
        <Card className="p-4">
          <div className="text-xl font-bold tabular-nums">{data.totalOutputTokens.toLocaleString()}</div>
          <div className="text-xs text-muted-foreground mt-1">Output tokens</div>
        </Card>
        <Card className="p-4">
          <div className="text-xl font-bold tabular-nums">{data.totalWebSearches.toLocaleString()}</div>
          <div className="text-xs text-muted-foreground mt-1">Web searches</div>
        </Card>
      </div>

      {data.totalCalls > 0 && (
        <Card className="p-4 md:p-6">
          <h2 className="font-serif text-xl font-bold mb-1">Where the money went</h2>
          <p className="text-xs text-muted-foreground mb-4">The biggest cost drivers in this range.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-3 text-sm">
            {data.summary.mostExpensiveOperation && (
              <div>
                <div className="text-xs text-muted-foreground">Priciest operation</div>
                <div className="font-medium">{operationLabel(data.summary.mostExpensiveOperation.operation)}</div>
                <div className="tabular-nums text-muted-foreground text-xs">{usd(data.summary.mostExpensiveOperation.costUsd)}</div>
              </div>
            )}
            {data.summary.mostExpensiveModel && (
              <div>
                <div className="text-xs text-muted-foreground">Priciest model</div>
                <div className="font-medium truncate" title={data.summary.mostExpensiveModel.model}>{data.summary.mostExpensiveModel.model}</div>
                <div className="tabular-nums text-muted-foreground text-xs">{usd(data.summary.mostExpensiveModel.costUsd)}</div>
              </div>
            )}
            {data.summary.highestAvgOperation && (
              <div>
                <div className="text-xs text-muted-foreground">Highest avg / call</div>
                <div className="font-medium">{operationLabel(data.summary.highestAvgOperation.operation)}</div>
                <div className="tabular-nums text-muted-foreground text-xs">{usd(data.summary.highestAvgOperation.avgCostUsd)} avg</div>
              </div>
            )}
            <div>
              <div className="text-xs text-muted-foreground">Web-search calls cost</div>
              <div className="font-medium tabular-nums">{usd(data.summary.webSearchCostUsd)}</div>
              <div className="text-xs text-muted-foreground">whole-call cost, upper bound</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Image calls cost</div>
              <div className="font-medium tabular-nums">{usd(data.summary.imageCostUsd)}</div>
              <div className="text-xs text-muted-foreground">whole-call cost, upper bound</div>
            </div>
          </div>
        </Card>
      )}

      {data.totalCalls === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <DollarSign className="h-8 w-8 mx-auto mb-2 opacity-40" />
          No AI spend recorded in this range yet. Costs appear here as the content pipeline runs.
        </Card>
      ) : (
        <>
          {chartData.length > 0 && (
            <Card className="p-4 md:p-6">
              <h2 className="font-serif text-xl font-bold mb-1">Spend over time</h2>
              <p className="text-xs text-muted-foreground mb-4">Click any bar to see a breakdown for that day.</p>
              <ChartContainer
                config={{ cost: { label: "Cost (USD)", color: "hsl(var(--primary))" } }}
                className="aspect-auto h-[240px] w-full"
              >
                <BarChart
                  data={chartData}
                  margin={{ left: 4, right: 4, top: 4 }}
                  onClick={(payload) => {
                    const dateKey = payload?.activePayload?.[0]?.payload?.date as string | undefined;
                    if (dateKey) setSelectedDay(dateKey);
                  }}
                  style={{ cursor: "pointer" }}
                >
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
                    tickLine={false}
                    axisLine={false}
                    width={44}
                    tickMargin={4}
                    tickFormatter={(v: number) => `$${v}`}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="cost" radius={[3, 3, 0, 0]}>
                    {chartData.map((entry) => (
                      <Cell
                        key={entry.date}
                        fill={entry.date === selectedDay ? "hsl(var(--primary) / 0.65)" : "var(--color-cost)"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ChartContainer>
            </Card>
          )}

          <Card className="p-4 md:p-6">
            <h2 className="font-serif text-xl font-bold mb-4">By model</h2>
            <div className="space-y-2.5">
              {data.byModel.map((m) => {
                const pct = maxModelCost > 0 ? Math.round((m.costUsd / maxModelCost) * 100) : 0;
                return (
                  <div key={m.model} className="flex items-center gap-3 text-sm">
                    <div className="w-48 shrink-0 min-w-0">
                      <div className="truncate font-medium" title={m.model}>{m.model}</div>
                      <div className="text-xs text-muted-foreground">
                        {m.calls.toLocaleString()} calls · {(m.inputTokens + m.outputTokens).toLocaleString()} tokens
                      </div>
                    </div>
                    <div className="flex-1 bg-muted rounded-full h-2.5 overflow-hidden">
                      <div className="bg-primary h-full rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="w-20 text-right tabular-nums font-semibold">{usd(m.costUsd)}</div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="p-4 md:p-6">
            <h2 className="font-serif text-xl font-bold mb-4">By operation</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="text-xs uppercase tracking-wider text-muted-foreground border-b">
                    <th className="text-left font-medium py-2 pr-3">Operation</th>
                    <th className="text-right font-medium py-2 px-3 w-20">Calls</th>
                    <th className="text-right font-medium py-2 px-3 w-24">Tokens</th>
                    <th className="text-right font-medium py-2 px-3 w-16">Web</th>
                    <th className="text-right font-medium py-2 px-3 w-16">Img</th>
                    <th className="text-right font-medium py-2 px-3 w-24">Avg/call</th>
                    <th className="text-right font-medium py-2 pl-3 w-24">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byOperation.map((o) => (
                    <tr key={o.operation} className="border-b last:border-0">
                      <td className="py-2.5 pr-3 font-medium">{operationLabel(o.operation)}</td>
                      <td className="py-2.5 px-3 text-right tabular-nums text-muted-foreground">{o.calls.toLocaleString()}</td>
                      <td className="py-2.5 px-3 text-right tabular-nums text-muted-foreground">{o.totalTokens.toLocaleString()}</td>
                      <td className="py-2.5 px-3 text-right tabular-nums text-muted-foreground">{o.webSearches.toLocaleString()}</td>
                      <td className="py-2.5 px-3 text-right tabular-nums text-muted-foreground">{o.images.toLocaleString()}</td>
                      <td className="py-2.5 px-3 text-right tabular-nums text-muted-foreground">{usd(o.avgCostUsd)}</td>
                      <td className="py-2.5 pl-3 text-right tabular-nums font-semibold">{usd(o.costUsd)}</td>
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
