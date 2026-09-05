import { useMemo } from "react";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  Cell,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";

interface PostAnalytics {
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  clicks: number;
  views: number;
  engagementRate: number;
}

interface AnalyticsPost {
  _id: string;
  content: string;
  publishedAt: string | null;
  status: string;
  analytics?: PostAnalytics;
}

const TZ = "America/Phoenix";

const NEON = {
  blue: "#38bdf8",
  violet: "#a78bfa",
  pink: "#f472b6",
};

function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
}

function shortDay(key: string): string {
  const d = new Date(`${key}T12:00:00`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function ChartCard({
  title,
  subtitle,
  tone,
  testId,
  children,
}: {
  title: string;
  subtitle?: string;
  tone: keyof typeof NEON;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <Card
      className="bg-card/60 border-border transition-all duration-300 hover:border-violet-500/40 hover:shadow-[0_0_24px_-6px_rgba(167,139,250,0.35)]"
      data-testid={testId}
    >
      <CardContent className="p-4 md:p-5">
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: NEON[tone], boxShadow: `0 0 8px ${NEON[tone]}` }}
            />
            {title}
          </h3>
          {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function NeonTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-violet-500/40 bg-background/95 px-3 py-2 shadow-[0_0_16px_-4px_rgba(167,139,250,0.5)] backdrop-blur">
      <p className="text-xs font-medium text-foreground mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} className="text-xs flex items-center gap-1.5">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: p.color, boxShadow: `0 0 6px ${p.color}` }}
          />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="text-foreground font-semibold">{p.value?.toLocaleString()}</span>
        </p>
      ))}
    </div>
  );
}

const axisProps = {
  stroke: "hsl(240 5% 45%)",
  fontSize: 11,
  tickLine: false as const,
  axisLine: false as const,
};

export function StatsCharts({ posts }: { posts: AnalyticsPost[] }) {
  const published = useMemo(
    () => posts.filter((p) => p.status === "published" && p.publishedAt),
    [posts],
  );

  const timeline = useMemo(() => {
    const byDay = new Map<string, { engagement: number; impressions: number; posts: number }>();
    for (const p of published) {
      const key = dayKey(p.publishedAt!);
      const a = p.analytics;
      const cur = byDay.get(key) ?? { engagement: 0, impressions: 0, posts: 0 };
      cur.engagement += (a?.likes ?? 0) + (a?.comments ?? 0) + (a?.shares ?? 0) + (a?.saves ?? 0);
      cur.impressions += a?.impressions ?? 0;
      cur.posts += 1;
      byDay.set(key, cur);
    }

    const days: Array<{ day: string; engagement: number; impressions: number; posts: number }> = [];
    const today = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toLocaleDateString("en-CA", { timeZone: TZ });
      const v = byDay.get(key) ?? { engagement: 0, impressions: 0, posts: 0 };
      days.push({ day: shortDay(key), ...v });
    }
    return days;
  }, [published]);

  const breakdown = useMemo(() => {
    const totals = { likes: 0, comments: 0, shares: 0, saves: 0, clicks: 0, views: 0 };
    for (const p of published) {
      const a = p.analytics;
      if (!a) continue;
      totals.likes += a.likes ?? 0;
      totals.comments += a.comments ?? 0;
      totals.shares += a.shares ?? 0;
      totals.saves += a.saves ?? 0;
      totals.clicks += a.clicks ?? 0;
      totals.views += a.views ?? 0;
    }
    return [
      { name: "Likes", value: totals.likes, color: NEON.pink },
      { name: "Comments", value: totals.comments, color: NEON.blue },
      { name: "Shares", value: totals.shares, color: NEON.violet },
      { name: "Saves", value: totals.saves, color: NEON.blue },
      { name: "Clicks", value: totals.clicks, color: NEON.pink },
      { name: "Views", value: totals.views, color: NEON.violet },
    ];
  }, [published]);

  const byWeekday = useMemo(() => {
    const order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const counts = new Map<string, number>(order.map((d) => [d, 0]));
    for (const p of published) {
      const wd = new Date(p.publishedAt!).toLocaleDateString("en-US", {
        weekday: "short",
        timeZone: TZ,
      });
      counts.set(wd, (counts.get(wd) ?? 0) + 1);
    }
    return order.map((d) => ({ name: d, value: counts.get(d) ?? 0 }));
  }, [published]);

  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4">
        Trends
      </h2>
      <div className="flex flex-col gap-4">
        <ChartCard
          title="Engagement Over Time"
          subtitle="Last 14 days — lifetime totals credited to each post's publish date"
          tone="pink"
          testId="chart-engagement-time"
        >
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={timeline} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradEngagement" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={NEON.pink} stopOpacity={0.5} />
                    <stop offset="100%" stopColor={NEON.pink} stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="gradImpressions" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={NEON.blue} stopOpacity={0.45} />
                    <stop offset="100%" stopColor={NEON.blue} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 5% 22%)" vertical={false} />
                <XAxis dataKey="day" {...axisProps} interval="preserveStartEnd" />
                <YAxis {...axisProps} allowDecimals={false} />
                <Tooltip content={<NeonTooltip />} cursor={{ stroke: "hsl(240 5% 35%)" }} />
                <Area
                  type="monotone"
                  dataKey="impressions"
                  name="Impressions"
                  stroke={NEON.blue}
                  strokeWidth={2}
                  fill="url(#gradImpressions)"
                  dot={false}
                  activeDot={{ r: 4, fill: NEON.blue }}
                />
                <Area
                  type="monotone"
                  dataKey="engagement"
                  name="Engagement"
                  stroke={NEON.pink}
                  strokeWidth={2}
                  fill="url(#gradEngagement)"
                  dot={false}
                  activeDot={{ r: 4, fill: NEON.pink }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        <div className="grid md:grid-cols-2 gap-4">
          <ChartCard
            title="Engagement Mix"
            subtitle="Lifetime totals across all published posts"
            tone="violet"
            testId="chart-engagement-mix"
          >
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={breakdown} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 5% 22%)" vertical={false} />
                  <XAxis dataKey="name" {...axisProps} interval={0} />
                  <YAxis {...axisProps} allowDecimals={false} />
                  <Tooltip content={<NeonTooltip />} cursor={{ fill: "rgba(167,139,250,0.06)" }} />
                  <Bar dataKey="value" name="Total" radius={[4, 4, 0, 0]} maxBarSize={36}>
                    {breakdown.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} fillOpacity={0.85} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>

          <ChartCard
            title="Posting Activity"
            subtitle="Published posts by day of week"
            tone="blue"
            testId="chart-posting-activity"
          >
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byWeekday} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradActivity" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={NEON.blue} />
                      <stop offset="100%" stopColor={NEON.violet} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 5% 22%)" vertical={false} />
                  <XAxis dataKey="name" {...axisProps} interval={0} />
                  <YAxis {...axisProps} allowDecimals={false} />
                  <Tooltip content={<NeonTooltip />} cursor={{ fill: "rgba(56,189,248,0.06)" }} />
                  <Bar
                    dataKey="value"
                    name="Posts"
                    fill="url(#gradActivity)"
                    fillOpacity={0.85}
                    radius={[4, 4, 0, 0]}
                    maxBarSize={36}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>
        </div>
      </div>
    </section>
  );
}
