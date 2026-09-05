import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import {
  BookOpen,
  BrainCircuit,
  CheckCircle2,
  Database,
  FileArchive,
  Fingerprint,
  Library,
  Loader2,
  LockKeyhole,
  RefreshCw,
  ScrollText,
  Sparkles,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

type StoryholdStatus = {
  status: "ready";
  project: string;
  schemaVersion: number;
  user: { id: string; email: string; role: string };
  database: {
    engine: string;
    persistent: boolean;
    vectorSearch: string;
    location: string;
  };
  canonicalModel: {
    singleSharedVault: boolean;
    scopedBy: string[];
    immutableStarts: boolean;
    appendOnlyStateEvents: boolean;
    aggregatePatternsSeparated: boolean;
  };
  counts: {
    players: number;
    worlds: number;
    campaigns: number;
    memories: number;
    sources: number;
    character_drafts: number;
  };
};

export default function Dashboard() {
  const [data, setData] = useState<StoryholdStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${apiBase}/storyhold/status`, {
        credentials: "include",
      });
      if (!response.ok)
        throw new Error(`Status check failed (${response.status}).`);
      setData((await response.json()) as StoryholdStatus);
    } catch (reason) {
      setData(null);
      setError(
        reason instanceof Error
          ? reason.message
          : "The local server could not be reached.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  return (
    <div
      className="mx-auto max-w-6xl space-y-6 p-4 md:p-8"
      data-testid="storyhold-dashboard"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
            Local foundation
          </div>
          <h1 className="font-serif text-3xl font-bold md:text-4xl">
            Storyhold
          </h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            The imported site is running behind a safe Storyhold layer. We can
            now rebuild it one capability at a time without starting BrainHook's
            publishing or automation systems.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void loadStatus()}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Check system
        </Button>
      </div>

      {loading && !data ? (
        <Card className="flex items-center gap-3 p-6 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" /> Checking the local
          Storyhold services…
        </Card>
      ) : error ? (
        <Card className="border-destructive/40 p-6">
          <div className="font-semibold text-destructive">
            The local backend is not ready.
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        </Card>
      ) : data ? (
        <>
          <Card
            className="flex flex-wrap items-center justify-between gap-4 border-emerald-500/30 bg-emerald-500/5 p-5"
            data-testid="baseline-ready"
          >
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-7 w-7 text-emerald-600" />
              <div>
                <div className="font-semibold">Local baseline ready</div>
                <div className="text-sm text-muted-foreground">
                  Login, persistent PostgreSQL storage, and vector search are
                  connected.
                </div>
              </div>
            </div>
            <div className="rounded-full border bg-background px-3 py-1 text-xs font-medium">
              Schema v{data.schemaVersion}
            </div>
          </Card>

          <Card className="border-primary/25 bg-primary/[0.035] p-6">
            <div className="flex flex-wrap items-center justify-between gap-5">
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-primary/10 p-2.5 text-primary">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="font-serif text-xl font-bold">
                    World Studio is ready
                  </h2>
                  <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                    Create separate worlds, upload entire books or document
                    collections, inspect extracted passages, and build
                    reviewable world and character drafts.
                  </p>
                </div>
              </div>
              <Button asChild>
                <Link href="/admin/worlds">
                  <BookOpen className="mr-2 h-4 w-4" />
                  Open World Studio
                </Link>
              </Button>
            </div>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {[
              { label: "Players", value: data.counts.players, icon: Users },
              { label: "Worlds", value: data.counts.worlds, icon: BookOpen },
              {
                label: "Sources",
                value: data.counts.sources,
                icon: FileArchive,
              },
              {
                label: "Character drafts",
                value: data.counts.character_drafts,
                icon: Fingerprint,
              },
              {
                label: "Campaigns",
                value: data.counts.campaigns,
                icon: ScrollText,
              },
              {
                label: "Vault memories",
                value: data.counts.memories,
                icon: Library,
              },
            ].map(({ label, value, icon: Icon }) => (
              <Card key={label} className="p-5">
                <Icon className="mb-4 h-5 w-5 text-primary" />
                <div className="text-3xl font-bold tabular-nums">{value}</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {label}
                </div>
              </Card>
            ))}
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card className="p-6">
              <div className="mb-5 flex items-center gap-3">
                <Fingerprint className="h-6 w-6 text-primary" />
                <div>
                  <h2 className="font-serif text-xl font-bold">
                    Canonical identity
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Every retrieval is scoped before memory reaches a game.
                  </p>
                </div>
              </div>
              <dl className="space-y-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">Signed-in player ID</dt>
                  <dd
                    className="mt-1 break-all font-mono text-xs"
                    data-testid="canonical-player-id"
                  >
                    {data.user.id}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Vault boundaries</dt>
                  <dd className="mt-1">
                    {data.canonicalModel.scopedBy.join(" · ")}
                  </dd>
                </div>
                <div className="flex items-start gap-2">
                  <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  <dd>
                    Character origins and campaign starting contracts are locked
                    at the database level.
                  </dd>
                </div>
              </dl>
            </Card>

            <Card className="p-6">
              <div className="mb-5 flex items-center gap-3">
                <Database className="h-6 w-6 text-primary" />
                <div>
                  <h2 className="font-serif text-xl font-bold">
                    Local vault foundation
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Persistent on this PC; replaceable with hosted PostgreSQL
                    later.
                  </p>
                </div>
              </div>
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Engine</dt>
                  <dd className="text-right">{data.database.engine}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Vector extension</dt>
                  <dd>pgvector {data.database.vectorSearch}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Storage</dt>
                  <dd className="font-mono text-xs">
                    {data.database.location}
                  </dd>
                </div>
                <div className="flex items-start gap-2 border-t pt-3">
                  <BrainCircuit className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <dd>
                    Aggregate pattern insights live separately from canonical
                    world memory.
                  </dd>
                </div>
              </dl>
            </Card>
          </div>

          <Card className="p-6">
            <h2 className="font-serif text-xl font-bold">
              Imported capability audit
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The original admin tools are still present for inspection, but
              their publishing and automation endpoints are deliberately off in
              local mode.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button asChild variant="outline">
                <Link href="/admin/source-vault">
                  <Library className="mr-2 h-4 w-4" />
                  Inspect imported vault UI
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/admin/ai-control">
                  <BrainCircuit className="mr-2 h-4 w-4" />
                  Inspect AI controls
                </Link>
              </Button>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
