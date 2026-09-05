import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import {
  BookOpen,
  BrainCircuit,
  ChevronRight,
  FileText,
  Layers3,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  createWorld,
  listWorlds,
  type AiRuntimeStatus,
  type WorldSummary,
} from "@/lib/storyholdApi";

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function AiStatusCard({ ai }: { ai: AiRuntimeStatus }) {
  return (
    <Card className="border-primary/20 bg-primary/[0.035] p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary/10 p-2 text-primary">
          <BrainCircuit className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">World analysis</h2>
            <Badge variant={ai.configured ? "default" : "secondary"}>
              {ai.configured ? "AI connected" : "Private development mode"}
            </Badge>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {ai.explanation}
          </p>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span>Engine: {ai.model}</span>
            <span>
              {ai.sendsSourceTextOffDevice
                ? "Source batches leave this PC"
                : "Source text stays on this PC"}
            </span>
            <span>
              {ai.billable ? "Provider charges apply" : "No model charges"}
            </span>
            <span>
              Local reader: {ai.localExtraction.enabled
                ? `${ai.localExtraction.model} connected`
                : "not connected"}
            </span>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {ai.localExtraction.explanation}
          </p>
        </div>
      </div>
    </Card>
  );
}

export default function Worlds() {
  const [, setLocation] = useLocation();
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  const [ai, setAi] = useState<AiRuntimeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [genre, setGenre] = useState("");
  const [premise, setPremise] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listWorlds();
      setWorlds(result.worlds);
      setAi(result.ai);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "World Studio could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim().length < 2) return;
    setCreating(true);
    try {
      const world = await createWorld({ name, genre, premise });
      toast.success(`${world.name} is ready for sources.`);
      setLocation(`/admin/worlds/${world.id}`);
    } catch (reason) {
      toast.error(
        reason instanceof Error
          ? reason.message
          : "The world could not be created.",
      );
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="mx-auto max-w-6xl space-y-6 p-4 md:p-8"
      data-testid="world-studio-index"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
            Universe Studio
          </div>
          <h1 className="font-serif text-3xl font-bold md:text-4xl">
            Your worlds
          </h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Keep unrelated stories isolated by canonical world and edition IDs,
            while every source still lives in one shared Storyhold vault.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Refresh
        </Button>
      </div>

      {ai ? <AiStatusCard ai={ai} /> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-serif text-2xl font-bold">World library</h2>
            <span className="text-sm text-muted-foreground">
              {worlds.length} total
            </span>
          </div>
          {loading && worlds.length === 0 ? (
            <Card className="flex items-center gap-3 p-6 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" /> Loading worlds…
            </Card>
          ) : error ? (
            <Card className="border-destructive/40 p-6">
              <p className="font-medium text-destructive">{error}</p>
            </Card>
          ) : worlds.length === 0 ? (
            <Card className="border-dashed p-10 text-center">
              <BookOpen className="mx-auto h-10 w-10 text-muted-foreground/50" />
              <h3 className="mt-4 font-serif text-xl font-bold">
                Create the first world
              </h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                ASHES can be one world; every other novel or original setting
                can have its own sealed canon beside it.
              </p>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {worlds.map((world) => (
                <Link
                  key={world.id}
                  href={`/admin/worlds/${world.id}`}
                  className="group block"
                >
                  <Card className="h-full p-5 transition-colors hover:border-primary/40 hover:bg-primary/[0.02]">
                    <div className="flex items-start justify-between gap-3">
                      <div className="rounded-lg bg-muted p-2.5 text-primary">
                        <BookOpen className="h-5 w-5" />
                      </div>
                      <ChevronRight className="h-5 w-5 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                    </div>
                    <h3 className="mt-4 font-serif text-xl font-bold">
                      {world.name}
                    </h3>
                    <p className="mt-1 text-xs font-medium uppercase tracking-wide text-primary/80">
                      {world.genre || "Genre open"}
                    </p>
                    {world.pendingCohesionCount > 0 ||
                    world.waitingAiReviewCount > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {world.waitingAiReviewCount > 0 ? (
                          <Badge variant="outline">
                            {world.waitingAiReviewCount} waiting for AI
                          </Badge>
                        ) : null}
                        {world.pendingCohesionCount > 0 ? (
                          <Badge variant="secondary">
                            {world.pendingCohesionCount} cohesion decisions
                          </Badge>
                        ) : null}
                      </div>
                    ) : null}
                    <p className="mt-3 line-clamp-3 min-h-[3.75rem] text-sm leading-5 text-muted-foreground">
                      {world.premise ||
                        "No premise supplied yet. Upload source material and let Storyhold begin the breakdown."}
                    </p>
                    <div className="mt-5 grid grid-cols-3 gap-2 border-t pt-4 text-center">
                      <div>
                        <div className="font-semibold tabular-nums">
                          {world.sourceCount}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          sources
                        </div>
                      </div>
                      <div>
                        <div className="font-semibold tabular-nums">
                          {formatNumber(world.wordCount)}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          words
                        </div>
                      </div>
                      <div>
                        <div className="font-semibold tabular-nums">
                          {world.characterDraftCount}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          drafts
                        </div>
                      </div>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </section>

        <aside>
          <Card className="sticky top-6 p-5">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-primary/10 p-2 text-primary">
                <Plus className="h-5 w-5" />
              </div>
              <div>
                <h2 className="font-serif text-xl font-bold">Create a world</h2>
                <p className="text-xs text-muted-foreground">
                  Sources come next.
                </p>
              </div>
            </div>
            <form className="mt-5 space-y-4" onSubmit={submit}>
              <div className="space-y-2">
                <Label htmlFor="world-name">World name</Label>
                <Input
                  id="world-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="ASHES"
                  maxLength={140}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="world-genre">Genre or atmosphere</Label>
                <Input
                  id="world-genre"
                  value={genre}
                  onChange={(event) => setGenre(event.target.value)}
                  placeholder="Horror science fiction"
                  maxLength={160}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="world-premise">
                  What should Storyhold know first?
                </Label>
                <Textarea
                  id="world-premise"
                  value={premise}
                  onChange={(event) => setPremise(event.target.value)}
                  placeholder="Optional. The uploaded books remain the evidence."
                  rows={5}
                  maxLength={6000}
                />
              </div>
              <Button
                className="w-full"
                type="submit"
                disabled={creating || name.trim().length < 2}
              >
                {creating ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="mr-2 h-4 w-4" />
                )}
                Create and add sources
              </Button>
            </form>
            <div className="mt-5 space-y-3 border-t pt-5 text-xs text-muted-foreground">
              <div className="flex gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                <span>Every world receives a permanent canonical ID.</span>
              </div>
              <div className="flex gap-2">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>Whole books remain immutable source evidence.</span>
              </div>
              <div className="flex gap-2">
                <Layers3 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>Draft analysis cannot silently rewrite canon.</span>
              </div>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
