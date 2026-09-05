import { Header } from "@/components/layout/Header";
import { StatsCharts } from "@/components/stats/StatsCharts";
import { BestTimeHeatmap, AudienceCard } from "@/components/stats/BestTimes";
import { useZernioAnalytics } from "@/hooks/api";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Heart,
  MessageCircle,
  Share2,
  MousePointerClick,
  Eye,
  Radio,
  Zap,
  RefreshCw,
  ExternalLink,
  BarChart3,
  ImageIcon,
} from "lucide-react";
import logoUrl from "@/assets/bpd-logo.png";

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
  lastUpdated?: string;
}

interface AnalyticsPost {
  _id: string;
  content: string;
  publishedAt: string | null;
  status: string;
  analytics?: PostAnalytics;
  platform?: string;
  platformPostUrl?: string | null;
  thumbnailUrl?: string | null;
}

interface AnalyticsResponse {
  overview?: {
    totalPosts: number;
    publishedPosts: number;
    scheduledPosts: number;
    lastSync?: string;
  };
  posts?: AnalyticsPost[];
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const GLOWS = {
  blue: {
    text: "text-sky-400",
    glow: "drop-shadow-[0_0_10px_rgba(56,189,248,0.55)]",
    border: "hover:border-sky-500/50",
    shadow: "hover:shadow-[0_0_24px_-6px_rgba(56,189,248,0.4)]",
  },
  violet: {
    text: "text-violet-400",
    glow: "drop-shadow-[0_0_10px_rgba(167,139,250,0.55)]",
    border: "hover:border-violet-500/50",
    shadow: "hover:shadow-[0_0_24px_-6px_rgba(167,139,250,0.4)]",
  },
  pink: {
    text: "text-pink-400",
    glow: "drop-shadow-[0_0_10px_rgba(244,114,182,0.55)]",
    border: "hover:border-pink-500/50",
    shadow: "hover:shadow-[0_0_24px_-6px_rgba(244,114,182,0.4)]",
  },
} as const;

function NeonStat({
  label,
  value,
  icon: Icon,
  tone,
  testId,
}: {
  label: string;
  value: string;
  icon: typeof Heart;
  tone: keyof typeof GLOWS;
  testId: string;
}) {
  const g = GLOWS[tone];
  return (
    <Card
      className={`bg-card/60 border-border transition-all duration-300 ${g.border} ${g.shadow}`}
      data-testid={testId}
    >
      <CardContent className="p-4 flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon className={`h-4 w-4 ${g.text} ${g.glow}`} />
          <span className="text-xs font-medium uppercase tracking-wider">{label}</span>
        </div>
        <span className={`text-2xl font-bold text-foreground ${g.glow}`}>{value}</span>
      </CardContent>
    </Card>
  );
}

const METRIC_CHIPS: Array<{
  key: keyof PostAnalytics;
  label: string;
  icon: typeof Heart;
  tone: keyof typeof GLOWS;
}> = [
  { key: "likes", label: "Likes", icon: Heart, tone: "pink" },
  { key: "comments", label: "Comments", icon: MessageCircle, tone: "blue" },
  { key: "shares", label: "Shares", icon: Share2, tone: "violet" },
  { key: "impressions", label: "Impr.", icon: Eye, tone: "blue" },
  { key: "reach", label: "Reach", icon: Radio, tone: "violet" },
];

export default function StatsPage() {
  const { data, isLoading, isError, error, refetch, isRefetching } = useZernioAnalytics();
  const analytics = data as AnalyticsResponse | undefined;

  const posts = analytics?.posts ?? [];
  const overview = analytics?.overview;

  const totals = posts.reduce(
    (acc, p) => {
      const a = p.analytics;
      if (!a) return acc;
      acc.likes += a.likes ?? 0;
      acc.comments += a.comments ?? 0;
      acc.shares += a.shares ?? 0;
      acc.saves += a.saves ?? 0;
      acc.clicks += a.clicks ?? 0;
      acc.impressions += a.impressions ?? 0;
      acc.reach += a.reach ?? 0;
      return acc;
    },
    { likes: 0, comments: 0, shares: 0, saves: 0, clicks: 0, impressions: 0, reach: 0 },
  );

  const rankedPosts = [...posts]
    .filter((p) => p.status === "published")
    .sort((a, b) => {
      const erDiff = (b.analytics?.engagementRate ?? 0) - (a.analytics?.engagementRate ?? 0);
      if (erDiff !== 0) return erDiff;
      return (b.analytics?.impressions ?? 0) - (a.analytics?.impressions ?? 0);
    })
    .slice(0, 10);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header />

      <main className="flex-1 container max-w-screen-lg px-4 md:px-8 py-8">
        <div className="relative mb-10 flex flex-col items-center text-center">
          <div
            className="pointer-events-none absolute inset-x-0 -top-8 h-56 opacity-40"
            style={{
              background:
                "radial-gradient(ellipse 60% 100% at 50% 0%, rgba(139,92,246,0.25), rgba(236,72,153,0.12) 50%, transparent 80%)",
            }}
          />
          <img
            src={logoUrl}
            alt="BPD-isms neon logo"
            className="relative h-28 md:h-36 object-contain drop-shadow-[0_0_28px_rgba(217,70,239,0.45)]"
            data-testid="img-stats-logo"
          />
          <h1
            className="relative mt-2 text-3xl md:text-4xl font-bold bg-gradient-to-r from-sky-400 via-violet-400 to-pink-500 bg-clip-text text-transparent drop-shadow-[0_0_18px_rgba(167,139,250,0.35)]"
            data-testid="text-stats-title"
          >
            The Numbers
          </h1>
          <p className="relative text-muted-foreground mt-2">
            Live stats pulled straight from Zernio.
          </p>
          <div className="relative mt-3 flex items-center gap-3">
            {overview?.lastSync && (
              <span className="text-xs text-muted-foreground" data-testid="text-last-sync">
                Last synced {formatDate(overview.lastSync)}{" "}
                {new Date(overview.lastSync).toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isRefetching}
              className="border-violet-500/40 hover:border-violet-400 hover:bg-violet-500/10"
              data-testid="btn-refresh-stats"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isRefetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-24 rounded-xl" />
              ))}
            </div>
            <Skeleton className="h-64 rounded-xl" />
          </div>
        ) : isError ? (
          <div
            className="border-2 border-dashed border-pink-500/30 rounded-xl p-12 flex flex-col items-center justify-center text-center min-h-[300px]"
            data-testid="error-stats"
          >
            <Zap className="w-10 h-10 text-pink-400 drop-shadow-[0_0_10px_rgba(244,114,182,0.55)] mb-4" />
            <p className="text-lg font-semibold text-foreground">Couldn't reach Zernio.</p>
            <p className="text-muted-foreground mt-1 max-w-md">
              {error instanceof Error ? error.message : "Something went wrong fetching analytics."}
            </p>
            <Button
              variant="outline"
              className="mt-4 border-pink-500/40 hover:border-pink-400 hover:bg-pink-500/10"
              onClick={() => refetch()}
              data-testid="btn-retry-stats"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Try again
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-10">
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4">
                Overview
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <NeonStat label="Total Posts" value={formatCompact(overview?.totalPosts ?? 0)} icon={BarChart3} tone="blue" testId="stat-total-posts" />
                <NeonStat label="Published" value={formatCompact(overview?.publishedPosts ?? 0)} icon={Zap} tone="violet" testId="stat-published" />
                <NeonStat label="Impressions" value={formatCompact(totals.impressions)} icon={Eye} tone="pink" testId="stat-impressions" />
                <NeonStat label="Reach" value={formatCompact(totals.reach)} icon={Radio} tone="blue" testId="stat-reach" />
                <NeonStat label="Likes" value={formatCompact(totals.likes)} icon={Heart} tone="pink" testId="stat-likes" />
                <NeonStat label="Comments" value={formatCompact(totals.comments)} icon={MessageCircle} tone="blue" testId="stat-comments" />
                <NeonStat label="Shares" value={formatCompact(totals.shares)} icon={Share2} tone="violet" testId="stat-shares" />
                <NeonStat label="Clicks" value={formatCompact(totals.clicks)} icon={MousePointerClick} tone="pink" testId="stat-clicks" />
              </div>
            </section>

            <StatsCharts posts={posts} />

            <section>
              <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4">
                Timing &amp; Audience
              </h2>
              <div className="grid lg:grid-cols-[3fr_2fr] gap-4">
                <BestTimeHeatmap />
                <AudienceCard />
              </div>
            </section>

            <section>
              <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4">
                Top Performing Posts
              </h2>
              {rankedPosts.length === 0 ? (
                <div
                  className="border-2 border-dashed border-border rounded-xl p-12 flex flex-col items-center justify-center text-center min-h-[240px]"
                  data-testid="empty-top-posts"
                >
                  <BarChart3 className="w-10 h-10 text-muted-foreground mb-4" />
                  <p className="text-lg font-semibold text-foreground">No published posts tracked yet.</p>
                  <p className="text-muted-foreground mt-1">
                    Once Zernio syncs your published posts, the leaderboard lights up here.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-3" data-testid="list-top-posts">
                  {rankedPosts.map((post, idx) => {
                    const a = post.analytics;
                    const er = a?.engagementRate ?? 0;
                    return (
                      <Card
                        key={post._id}
                        className="bg-card/60 border-border transition-all duration-300 hover:border-violet-500/40 hover:shadow-[0_0_24px_-6px_rgba(167,139,250,0.35)]"
                        data-testid={`card-top-post-${idx}`}
                      >
                        <CardContent className="p-4 flex items-center gap-4">
                          <span
                            className={`text-xl font-black w-8 text-center shrink-0 bg-gradient-to-b from-sky-400 to-pink-500 bg-clip-text text-transparent ${idx === 0 ? "drop-shadow-[0_0_10px_rgba(244,114,182,0.5)]" : ""}`}
                          >
                            {idx + 1}
                          </span>
                          <div className="w-14 h-14 rounded-lg bg-muted shrink-0 overflow-hidden flex items-center justify-center">
                            {post.thumbnailUrl ? (
                              <img
                                src={post.thumbnailUrl}
                                alt=""
                                className="w-full h-full object-cover"
                                loading="lazy"
                              />
                            ) : (
                              <ImageIcon className="w-5 h-5 text-muted-foreground" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-foreground truncate">
                              {post.content?.trim() || "Untitled post"}
                            </p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {formatDate(post.publishedAt)}
                            </p>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
                              {METRIC_CHIPS.map(({ key, label, icon: ChipIcon, tone }) => {
                                const val = (a?.[key] as number | undefined) ?? 0;
                                return (
                                  <span
                                    key={key}
                                    className="flex items-center gap-1 text-xs text-muted-foreground"
                                    title={label}
                                  >
                                    <ChipIcon className={`h-3 w-3 ${GLOWS[tone].text}`} />
                                    {formatCompact(val)}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-1.5 shrink-0">
                            <span
                              className={`text-sm font-bold ${er > 0 ? "text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.4)]" : "text-muted-foreground"}`}
                            >
                              {er > 0 ? `${er.toFixed(2)}% ER` : "— ER"}
                            </span>
                            {post.platformPostUrl && (
                              <a
                                href={post.platformPostUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-sky-400 hover:text-sky-300 flex items-center gap-1"
                                data-testid={`link-post-${idx}`}
                              >
                                View <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
