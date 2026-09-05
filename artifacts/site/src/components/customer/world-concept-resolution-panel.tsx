import { useState } from "react";
import { AlertTriangle, BrainCircuit, CheckCircle2, ShieldCheck, X } from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  addWorldCanonConstraint,
  dismissWorldCanonConstraint,
  type StoryConceptCluster,
  type WorldDetail,
} from "@/lib/storyholdApi";
import { worldEntityDossierHref } from "@/lib/worldEntityNavigation";

function dossierHref(detail: WorldDetail, cluster: StoryConceptCluster): string | null {
  if (!cluster.entityId) return null;
  const entity = detail.entities.find((item) => item.id === cluster.entityId);
  if (!entity) return null;
  return worldEntityDossierHref(detail.world.id, entity);
}

function statusLabel(status: StoryConceptCluster["resolutionStatus"]) {
  if (status === "ambiguous") return "Needs distinction";
  if (status === "proposed") return "Ready for verification";
  if (status === "candidate") return "Early lead";
  return status.replaceAll("_", " ");
}

export function WorldConceptResolutionPanel({
  detail,
  onChanged,
}: {
  detail: WorldDetail;
  onChanged: () => Promise<unknown> | unknown;
}) {
  const clusters = detail.conceptClusters ?? [];
  const unresolved = clusters.filter((cluster) =>
    cluster.resolutionStatus === "ambiguous" ||
    cluster.resolutionStatus === "proposed" ||
    cluster.resolutionStatus === "candidate",
  );
  const hypotheses = (detail.relationshipHypotheses ?? []).filter((item) => item.status === "candidate");
  const constraints = detail.canonConstraints ?? [];
  const verified = clusters.filter((cluster) => cluster.resolutionStatus === "verified").length;
  const awaitingVerification = unresolved.length + hypotheses.length;
  const graphReady = clusters.length > 0;
  const [correction, setCorrection] = useState("");
  const [savingCorrection, setSavingCorrection] = useState(false);

  const dismiss = async (constraintId: string) => {
    try {
      await dismissWorldCanonConstraint({ worldId: detail.world.id, constraintId });
      await onChanged();
      toast.success("That permanent canon direction was removed.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The canon direction could not be removed.");
    }
  };

  const saveCorrection = async () => {
    const instruction = correction.trim();
    if (instruction.length < 8) {
      toast.error("Describe the correction in a complete sentence.");
      return;
    }
    setSavingCorrection(true);
    try {
      await addWorldCanonConstraint({ worldId: detail.world.id, instruction });
      setCorrection("");
      await onChanged();
      toast.success("Permanent canon correction saved.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The canon correction could not be saved.");
    } finally {
      setSavingCorrection(false);
    }
  };

  return (
    <Card className="mt-5 rounded-3xl border-white/8 bg-white/[0.025] p-5 sm:p-6">
      <details>
        <summary className="cursor-pointer list-none">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex items-start gap-3">
              <BrainCircuit className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div>
                <h2 className="font-serif text-2xl font-bold">Canon Interpretation</h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  Storyhold groups names and relationships here before AI is allowed to promote them into canon.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {graphReady ? <><Badge variant="outline"><CheckCircle2 className="mr-1 h-3 w-3" />{verified} verified</Badge>
              <Badge variant="outline" className={awaitingVerification ? "border-amber-300/30 text-amber-100" : ""}><AlertTriangle className="mr-1 h-3 w-3" />{awaitingVerification} to verify</Badge></> : <Badge variant="outline" className="border-amber-300/30 text-amber-100"><AlertTriangle className="mr-1 h-3 w-3" />Building local index</Badge>}
              {constraints.length ? <Badge variant="outline" className="border-primary/30 text-primary"><ShieldCheck className="mr-1 h-3 w-3" />{constraints.length} owner rule{constraints.length === 1 ? "" : "s"}</Badge> : null}
            </div>
          </div>
        </summary>

        <div className="mt-5 border-t border-white/8 pt-5">
          <p className="text-xs leading-5 text-muted-foreground">
            Scores use explicit mentions, chapter and source spread, evidence density, category consistency, connected relationships, and contradictory labels. They do not use popularity, recency, or publisher “heat.” A high score is still only a lead until the evidence-verifying AI confirms it.
          </p>

          <section className="mt-5 rounded-2xl border border-primary/15 bg-primary/[0.025] p-4">
            <h3 className="text-sm font-semibold text-foreground">Correct Storyhold Permanently</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">State the correction plainly. It will guide every future review and can be removed below.</p>
            <Textarea value={correction} onChange={(event) => setCorrection(event.target.value)} className="mt-3 min-h-20 bg-black/20" placeholder="Example: The Co-op and Sanctuary are different settlements. Sanctuary is Alec's later town." />
            <div className="mt-3 flex justify-end"><Button type="button" size="sm" disabled={savingCorrection || correction.trim().length < 8} onClick={() => void saveCorrection()}>{savingCorrection ? "Saving…" : "Save canon correction"}</Button></div>
          </section>

          {constraints.length ? (
            <section className="mt-5">
              <h3 className="text-sm font-semibold text-foreground">Permanent Owner Corrections</h3>
              <div className="mt-2 divide-y divide-white/8 rounded-2xl border border-primary/15 bg-primary/[0.035]">
                {constraints.map((constraint) => (
                  <div key={constraint.id} className="flex items-start justify-between gap-3 px-4 py-3">
                    <div><p className="text-xs font-semibold uppercase tracking-wide text-primary">{constraint.kind}</p><p className="mt-1 text-sm leading-6">{constraint.instruction}</p></div>
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground" aria-label="Remove permanent canon direction" onClick={() => void dismiss(constraint.id)}><X className="h-4 w-4" /></Button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {unresolved.length ? (
            <section className="mt-5">
              <h3 className="text-sm font-semibold text-foreground">Concepts Awaiting Evidence Review</h3>
              <div className="mt-2 divide-y divide-white/8 rounded-2xl border border-white/8 bg-black/15">
                {unresolved.slice(0, 20).map((cluster) => {
                  const href = dossierHref(detail, cluster);
                  return (
                    <div key={cluster.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{href ? <Link href={href} className="hover:text-primary hover:underline">{cluster.preferredLabel}</Link> : cluster.preferredLabel}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{cluster.entityType.replaceAll("_", " ")} · {cluster.mentionCount} mentions across {cluster.chapterCount} sections · {statusLabel(cluster.resolutionStatus)}</p>
                        {cluster.alternatives.length ? <p className="mt-1 text-xs text-amber-100">Overlaps with {cluster.alternatives.map((item) => item.name).join(", ")}</p> : null}
                      </div>
                      <div className="text-left sm:text-right"><p className="font-serif text-xl font-bold text-primary">{Math.round(cluster.score)}</p><p className="text-[11px] text-muted-foreground">evidence score</p></div>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {hypotheses.length ? (
            <section className="mt-5">
              <h3 className="text-sm font-semibold text-foreground">Relationships Needing More Evidence</h3>
              <div className="mt-2 divide-y divide-white/8 rounded-2xl border border-white/8 bg-black/15">
                {hypotheses.slice(0, 20).map((item) => (
                  <div key={item.id} className="px-4 py-3 text-sm">
                    <p><strong>{item.subjectName}</strong> <span className="text-muted-foreground">{item.relationType.replaceAll("_", " ")}</span> <strong>{item.targetName}</strong></p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground"><span className="text-primary">{item.interpretation}</span> · {item.explanation}</p>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {!unresolved.length && !hypotheses.length && !constraints.length ? <p className="text-sm text-muted-foreground">The next local manuscript scan will build this interpretation layer. Nothing here is sent to a paid model by itself.</p> : null}
        </div>
      </details>
    </Card>
  );
}
