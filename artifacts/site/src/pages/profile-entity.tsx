import { type FormEvent, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  Fingerprint,
  Gauge,
  Link2,
  Loader2,
  Network,
  Pencil,
  Save,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { Link, useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ProfileFrame } from "@/components/customer/profile-frame";
import { EntityAiReviewCard } from "@/components/customer/entity-ai-review-card";
import { DossierEvidence } from "@/components/customer/dossier-evidence";
import { EntityConnectionEditor } from "@/components/customer/world-entity-panel";
import { useAuth } from "@/lib/auth";
import { useSeo } from "@/lib/seo";
import { worldEntityDossierHref, worldNeedsSortingHref } from "@/lib/worldEntityNavigation";
import { DOSSIER_PREVIEW_ITEMS, dossierListWindow } from "@/lib/dossierListWindow";
import { dossierListFromEditor } from "@/lib/dossierEdits";
import {
  createWorldEntityRelations,
  createWorldEntityRule,
  deleteWorldEntityRelation,
  deleteWorldEntityRule,
  getWorld,
  getWorldEntityProseReview,
  updateWorldEntity,
  type EvidenceReference,
  type DossierProseReview,
  type CharacterStatName,
  type WorldDetail,
  type WorldEntity,
  type WorldEntityRelation,
  type WorldEntityRule,
  type WorldEntityType,
} from "@/lib/storyholdApi";

const categoryNames: Record<WorldEntityType, string> = {
  character: "Person",
  creature: "Creature",
  species: "Species",
  place: "Place",
  faction: "Faction",
  institution: "Institution",
  government: "Government",
  power_structure: "Power structure",
  technology: "Technology",
  vehicle: "Vehicle",
  device: "Device",
  weapon: "Weapon",
  power: "Power",
  title: "Title",
  cultural_reference: "Cultural Reference",
  term: "Term or Moniker",
  ambiguous: "Needs Sorting",
};

const categoryTypes = Object.keys(categoryNames) as WorldEntityType[];

const statNames: CharacterStatName[] = [
  "strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma", "acrobatics",
];

function statTitle(value: string) {
  return value.replace(/(^|_)([a-z])/g, (_, space, letter) => `${space ? " " : ""}${letter.toUpperCase()}`);
}

function statModifier(score: number) {
  const value = Math.floor((score - 10) / 2);
  return value >= 0 ? `+${value}` : String(value);
}

const relationNames: Record<WorldEntityRelation["relationType"], { outgoing: string; incoming: string }> = {
  member_of: { outgoing: "Member of", incoming: "Known member" },
  participates_in: { outgoing: "Participates in", incoming: "Participant" },
  species_of: { outgoing: "Species", incoming: "Named member" },
  subspecies_of: { outgoing: "Subspecies of", incoming: "Known subspecies" },
  subtype_of: { outgoing: "Subtype of", incoming: "Known subtype" },
  lifecycle_stage_of: { outgoing: "Lifecycle stage of", incoming: "Known lifecycle stage" },
  has_power: { outgoing: "Displays power", incoming: "Observed in" },
  has_form: { outgoing: "Creature form", incoming: "Manifested by" },
  holds_title: { outgoing: "Holds title", incoming: "Known holder" },
  child_of: { outgoing: "Child of", incoming: "Parent of" },
  sibling_of: { outgoing: "Sibling of", incoming: "Sibling of" },
  spouse_of: { outgoing: "Spouse or partner of", incoming: "Spouse or partner of" },
  friend_of: { outgoing: "Friend of", incoming: "Friend of" },
  best_friend_of: { outgoing: "Best friend of", incoming: "Best friend of" },
  leads: { outgoing: "Leads", incoming: "Led by" },
  governs: { outgoing: "Governs", incoming: "Governed by" },
  controlled_by: { outgoing: "Controlled by", incoming: "Controls" },
  allied_with: { outgoing: "Allied with", incoming: "Allied with" },
  opposed_to: { outgoing: "Opposed to", incoming: "Opposed by" },
  located_in: { outgoing: "Located in", incoming: "Found here" },
  part_of: { outgoing: "Part of", incoming: "Contains" },
  created_by: { outgoing: "Created by", incoming: "Created" },
  related_to: { outgoing: "Connected to", incoming: "Connected to" },
};

function linkedDossier(worldId: string, entity: WorldEntity): string | null {
  return worldEntityDossierHref(worldId, entity);
}

function evidenceLabel(evidence: EvidenceReference, detail: WorldDetail) {
  const manual = evidence as EvidenceReference & { sourceTitle?: string | null; page?: number | null; note?: string | null };
  const source = detail.sources.find((candidate) => candidate.id === evidence.sourceId);
  const title = source?.title || manual.sourceTitle || "Imported source";
  return manual.page ? `${title} · page ${manual.page}` : title;
}

function evidenceText(evidence: EvidenceReference) {
  const manual = evidence as EvidenceReference & { note?: string | null };
  return evidence.quote || manual.note || "Evidence recorded during source review.";
}

function relationshipHeading(entity: WorldEntity, relation: WorldEntityRelation) {
  const outgoing = relation.sourceEntityId === entity.id;
  return relationNames[relation.relationType][outgoing ? "outgoing" : "incoming"];
}

export default function ProfileEntity() {
  const auth = useAuth();
  const [, setLocation] = useLocation();
  const { worldId = "", entityId = "" } = useParams<{ worldId: string; entityId: string }>();
  const [detail, setDetail] = useState<WorldDetail | null>(null);
  const [proseEvidence, setProseEvidence] = useState<{
    detail: WorldDetail;
    entityId: string;
    review: DossierProseReview | null;
    failed: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [summary, setSummary] = useState("");
  const [details, setDetails] = useState("");
  const [visibleDetailCount, setVisibleDetailCount] = useState(DOSSIER_PREVIEW_ITEMS);
  const [ruleName, setRuleName] = useState("");
  const [ruleDescription, setRuleDescription] = useState("");
  const [ruleKind, setRuleKind] = useState<WorldEntityRule["ruleKind"]>("trait");

  const entity = detail?.entities.find((candidate) => candidate.id === entityId) ?? null;
  const detailPage = dossierListWindow(entity?.details ?? [], visibleDetailCount);
  useEffect(() => setVisibleDetailCount(DOSSIER_PREVIEW_ITEMS), [entityId]);

  // Bind evidence to this exact loaded world snapshot, so an edit or dossier
  // navigation never briefly displays the previous record's checked badges.
  const currentProseEvidence = proseEvidence?.detail === detail && proseEvidence?.entityId === entityId ? proseEvidence : null;
  useEffect(() => {
    if (!auth.email || !detail || !entity || ["ambiguous", "term", "cultural_reference"].includes(entity.entityType)) return;
    let active = true;
    setProseEvidence(null);
    void getWorldEntityProseReview(worldId, entityId)
      .then((review) => { if (active) setProseEvidence({ detail, entityId, review, failed: false }); })
      .catch(() => { if (active) setProseEvidence({ detail, entityId, review: null, failed: true }); });
    return () => { active = false; };
  }, [auth.email, detail, entity, entityId, worldId]);

  useEffect(() => {
    if (entity?.entityType === "ambiguous") {
      setLocation(worldNeedsSortingHref(worldId, entity.id), { replace: true });
    } else if (entity?.entityType === "term" || entity?.entityType === "cultural_reference") {
      setLocation(`/profile/worlds/${worldId}`, { replace: true });
    }
  }, [entity?.entityType, entity?.id, setLocation, worldId]);

  useSeo({
    title: entity?.name || "Storyhold dossier",
    description: "A private canonical dossier in your Storyhold.",
    canonicalPath: `/profile/worlds/${worldId}/entities/${entityId}`,
    noindex: true,
  });

  const load = async () => {
    const response = await getWorld(worldId);
    setDetail(response);
    const found = response.entities.find((candidate) => candidate.id === entityId);
    if (found) {
      setName(found.name);
      setAliases(found.aliases.join(", "));
      setSummary(found.summary);
      setDetails(found.details.join("\n"));
    }
    return response;
  };

  useEffect(() => {
    if (!auth.email || !worldId || !entityId) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    void getWorld(worldId)
      .then((response) => {
        if (!active) return;
        setDetail(response);
        const found = response.entities.find((candidate) => candidate.id === entityId);
        if (found) {
          setName(found.name);
          setAliases(found.aliases.join(", "));
          setSummary(found.summary);
          setDetails(found.details.join("\n"));
        }
      })
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : "We could not open this dossier."))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [auth.email, entityId, worldId]);

  const relations = useMemo(() => {
    if (!detail || !entity) return [];
    return detail.entityRelations
      .filter((relation) => relation.sourceEntityId === entity.id || relation.targetEntityId === entity.id)
      .map((relation) => {
        const outgoing = relation.sourceEntityId === entity.id;
        const otherId = outgoing ? relation.targetEntityId : relation.sourceEntityId;
        return { relation, outgoing, other: detail.entities.find((candidate) => candidate.id === otherId) ?? null };
      });
  }, [detail, entity]);

  const relationGroups = useMemo(() => {
    const groups = new Map<string, typeof relations>();
    for (const row of relations) {
      const heading = relationshipHeading(entity!, row.relation);
      groups.set(heading, [...(groups.get(heading) ?? []), row]);
    }
    return [...groups.entries()];
  }, [entity, relations]);

  const rules = useMemo(() => detail?.entityRules.filter((rule) => rule.entityId === entityId && rule.status === "active") ?? [], [detail, entityId]);

  const saveCard = async (event: FormEvent) => {
    event.preventDefault();
    if (!entity || busy) return;
    setBusy(true);
    try {
      await updateWorldEntity({
        worldId,
        entityId,
        name: name.trim(),
        aliases: dossierListFromEditor(entity.aliases, aliases, ", ", ","),
        summary: summary.trim(),
        details: dossierListFromEditor(entity.details, details),
      });
      await load();
      setEditing(false);
      toast.success(`${name.trim()} was updated.`);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The dossier could not be updated.");
    } finally {
      setBusy(false);
    }
  };

  const classify = async (entityType: WorldEntityType) => {
    if (!entity || entityType === entity.entityType || busy) return;
    setBusy(true);
    try {
      await updateWorldEntity({ worldId, entityId, entityType });
      await load();
      toast.success(`${entity.name} is now filed as ${categoryNames[entityType].toLocaleLowerCase()}.`);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The category could not be changed.");
    } finally {
      setBusy(false);
    }
  };

  const addConnections = (input: {
    connections: Parameters<typeof createWorldEntityRelations>[0]["connections"];
    actionLabel: string;
    onSaved: () => void;
  }) => {
    if (busy) return;
    setBusy(true);
    void createWorldEntityRelations({ worldId, connections: input.connections })
      .then(load)
      .then(() => {
        input.onSaved();
        toast.success(`${input.connections.length} canonical connection${input.connections.length === 1 ? " was" : "s were"} saved.`);
      })
      .catch((reason) => toast.error(reason instanceof Error ? reason.message : "The connection could not be saved."))
      .finally(() => setBusy(false));
  };

  const removeConnection = async (relation: WorldEntityRelation) => {
    if (busy) return;
    setBusy(true);
    try {
      await deleteWorldEntityRelation({ worldId, relationId: relation.id });
      await load();
      toast.success("The canonical connection was removed.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The connection could not be removed.");
    } finally {
      setBusy(false);
    }
  };

  const addRule = async (event: FormEvent) => {
    event.preventDefault();
    if (!entity || busy || ruleName.trim().length < 2) return;
    setBusy(true);
    try {
      await createWorldEntityRule({ worldId, entityId, name: ruleName.trim(), description: ruleDescription.trim(), ruleKind });
      await load();
      setRuleName("");
      setRuleDescription("");
      toast.success("The canonical rule was added.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The rule could not be added.");
    } finally {
      setBusy(false);
    }
  };

  const removeRule = async (rule: WorldEntityRule) => {
    if (busy) return;
    setBusy(true);
    try {
      await deleteWorldEntityRule({ worldId, ruleId: rule.id });
      await load();
      toast.success(`${rule.name} was removed.`);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The rule could not be removed.");
    } finally {
      setBusy(false);
    }
  };

  if (entity?.entityType === "ambiguous" || entity?.entityType === "term" || entity?.entityType === "cultural_reference") {
    return (
      <ProfileFrame>
        <div className="grid min-h-80 place-items-center text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-2"><Loader2 className="h-5 w-5 animate-spin text-primary" />{entity.entityType === "ambiguous" ? "Opening Needs Sorting…" : "Opening Context Annotations…"}</span>
        </div>
      </ProfileFrame>
    );
  }

  return (
    <ProfileFrame>
      <Link href={`/profile/worlds/${worldId}`} className="inline-flex items-center text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to {detail?.world.name || "this world"}
      </Link>

      {loading ? (
        <div className="grid min-h-80 place-items-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : error || !detail || !entity ? (
        <Card className="mt-7 rounded-3xl border-red-400/20 bg-red-400/[0.05] p-7">
          <h1 className="font-serif text-3xl font-bold">This Dossier Could Not Be Opened.</h1>
          <p className="mt-3 text-sm text-muted-foreground">{error || "This canonical card may have been removed."}</p>
        </Card>
      ) : (
        <div className="mt-5 space-y-4">
          <section className="storyhold-glass relative overflow-hidden rounded-3xl p-5 sm:p-6">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_90%_10%,rgba(56,189,248,0.14),transparent_36%)]" />
            <div className="relative">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className="bg-primary text-primary-foreground">{categoryNames[entity.entityType]}</Badge>
                    <Badge variant="outline" className="border-white/10">{entity.reviewStatus.replaceAll("_", " ")}</Badge>
                    {entity.pullStatus !== "active" ? <Badge variant="outline" className="border-amber-300/20 text-amber-100">{entity.pullStatus.replaceAll("_", " ")}</Badge> : null}
                  </div>
                  <h1 className="mt-2 font-serif text-3xl font-bold tracking-tight sm:text-4xl">{entity.name}</h1>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{entity.summary || "This canonical card is waiting for a grounded summary."}</p>
                </div>
                <Button type="button" variant="outline" className="rounded-xl" onClick={() => setEditing((current) => !current)}>
                  {editing ? <X className="mr-2 h-4 w-4" /> : <Pencil className="mr-2 h-4 w-4" />}{editing ? "Close editor" : "Edit dossier"}
                </Button>
              </div>
              <div className="mt-4 flex flex-wrap gap-1.5 text-xs">
                <details className="relative"><summary className="inline-flex cursor-pointer list-none items-center rounded-full border border-white/10 px-3 py-1.5 text-muted-foreground"><Fingerprint className="mr-1.5 h-3.5 w-3.5 text-primary" />Identity record</summary><p className="absolute left-0 top-full z-10 mt-1 min-w-64 rounded-lg border border-white/10 bg-[#111015] px-3 py-2 font-mono text-[10px] shadow-xl">{entity.canonicalKey}</p></details>
                <span className="inline-flex items-center rounded-full border border-white/10 px-3 py-1.5 text-muted-foreground"><BookOpen className="mr-1.5 h-3.5 w-3.5 text-primary" /> {entity.mentionCountStatus === "exact" || entity.mentionCount > 0 ? `${entity.mentionCount.toLocaleString()} mention${entity.mentionCount === 1 ? "" : "s"} in ${entity.mentionSourceCount.toLocaleString()} source${entity.mentionSourceCount === 1 ? "" : "s"}` : entity.mentionCountStatus === "manual" ? "Added manually" : entity.mentionCountStatus === "derived" ? "Evidence-derived concept; no canonical name or alias count" : "No canonical name or alias wording found in indexed sources"}</span>
                <span className="inline-flex items-center rounded-full border border-white/10 px-3 py-1.5 text-muted-foreground"><Network className="mr-1.5 h-3.5 w-3.5 text-primary" /> {relations.length} canonical link{relations.length === 1 ? "" : "s"}</span>
              </div>
            </div>
          </section>

          <EntityAiReviewCard
            worldId={worldId}
            entityId={entity.id}
            name={entity.name}
            entityType={entity.entityType}
            onComplete={load}
          />

          <DossierEvidence
            key={entity.id}
            review={currentProseEvidence?.review}
            loading={!currentProseEvidence}
            error={currentProseEvidence?.failed}
            sources={detail.sources}
          />

          {editing ? (
            <Card className="rounded-3xl border-primary/20 bg-primary/[0.035] p-5 sm:p-6">
              <form onSubmit={saveCard} className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="text-xs font-semibold text-muted-foreground">Name<Input className="mt-1" value={name} onChange={(event) => setName(event.target.value)} maxLength={240} /></label>
                  <label className="text-xs font-semibold text-muted-foreground">Category<select className="storyhold-select mt-1 block w-full" value={entity.entityType} onChange={(event) => void classify(event.target.value as WorldEntityType)} disabled={busy}>{categoryTypes.map((type) => <option key={type} value={type}>{categoryNames[type]}</option>)}</select></label>
                </div>
                <label className="block text-xs font-semibold text-muted-foreground">Also known as <span className="font-normal opacity-70">(comma separated)</span><Input className="mt-1" value={aliases} onChange={(event) => setAliases(event.target.value)} /></label>
                <label className="block text-xs font-semibold text-muted-foreground">Summary<Textarea className="mt-1 min-h-24" value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={4_000} /></label>
                <label className="block text-xs font-semibold text-muted-foreground">Detailed facts <span className="font-normal opacity-70">(one per line)</span><Textarea className="mt-1 min-h-36" value={details} onChange={(event) => setDetails(event.target.value)} /></label>
                <div className="flex justify-end"><Button type="submit" disabled={busy || name.trim().length < 2}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Save dossier</Button></div>
              </form>
            </Card>
          ) : null}

          {entity.aliases.length || entity.details.length ? (
            <div className="grid gap-2 lg:grid-cols-[0.36fr_0.64fr]">
              <details className="group rounded-2xl border border-white/8 bg-white/[0.025]">
                <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3"><span className="flex items-center gap-2 font-serif text-lg font-bold"><Tag className="h-4 w-4 text-primary" />Aliases</span><span className="text-xs text-muted-foreground">{entity.aliases.length}</span></summary>
                {entity.aliases.length ? <div className="flex flex-wrap gap-1.5 border-t border-white/8 px-4 py-3">{entity.aliases.map((alias) => <Badge key={alias} variant="secondary">{alias}</Badge>)}</div> : <p className="border-t border-white/8 px-4 py-3 text-sm text-muted-foreground">No aliases are recorded.</p>}
              </details>
              <details className="group rounded-2xl border border-white/8 bg-white/[0.025]">
                <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3"><span className="font-serif text-lg font-bold">Known facts</span><span className="text-xs text-muted-foreground">{entity.details.length}</span></summary>
                {entity.details.length ? <ul className="space-y-1.5 border-t border-white/8 px-3 py-3">{detailPage.visibleValues.map((line, index) => <li key={`${line}-${index}`} className="rounded-lg bg-black/15 px-3 py-2 text-sm leading-5 text-foreground/85">{line}</li>)}</ul> : <p className="border-t border-white/8 px-4 py-3 text-sm text-muted-foreground">No detailed facts are recorded yet.</p>}
                {entity.details.length > DOSSIER_PREVIEW_ITEMS ? <div className="flex flex-wrap items-center gap-2 border-t border-white/8 px-4 py-3">
                  <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">Showing {detailPage.shownCount} of {detailPage.total}</span>
                  {detailPage.hasMore ? <><Button type="button" size="sm" variant="outline" onClick={() => setVisibleDetailCount(detailPage.nextCount)}>Show More</Button><Button type="button" size="sm" variant="ghost" onClick={() => setVisibleDetailCount(detailPage.total)}>Show All</Button></> : null}
                  {detailPage.shownCount > DOSSIER_PREVIEW_ITEMS ? <Button type="button" size="sm" variant="ghost" onClick={() => setVisibleDetailCount(DOSSIER_PREVIEW_ITEMS)}>Show Fewer</Button> : null}
                </div> : null}
              </details>
            </div>
          ) : null}

          {entity.entityType === "creature" ? (
            <Card className="rounded-3xl border-white/8 bg-white/[0.025] p-5 sm:p-6">
              <div className="flex items-center gap-3"><Gauge className="h-5 w-5 text-primary" /><div><h2 className="font-serif text-2xl font-bold">Estimated Abilities</h2><p className="mt-1 text-sm text-muted-foreground">Evidence-grounded D20 estimates for this creature, classification, or manifested form.</p></div></div>
              <div className="mt-4 flex gap-2 rounded-xl border border-primary/20 bg-primary/[0.045] px-3 py-2.5 text-xs leading-5 text-muted-foreground"><Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /><p><strong className="text-foreground">Premium Deep Reading Sharpens These Abilities.</strong> It weighs alternate forms, biological rules, injuries, limitations, and repeated feats before settling each score.</p></div>
              {entity.estimatedStats ? <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">{statNames.map((name) => { const stat = entity.estimatedStats![name]; const evidence = stat.evidence ?? []; return <details key={name} className="group rounded-2xl border border-white/8 bg-black/20 text-center"><summary className="cursor-pointer list-none p-4"><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{statTitle(name)}</p><p className="mt-2 font-serif text-3xl font-bold">{stat.score}</p><p className="text-xs font-semibold text-primary">{statModifier(stat.score)}</p><div className="mx-auto mt-3 h-1.5 max-w-20 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(5, stat.confidence * 100)}%` }} /></div><p className="mt-2 text-[10px] text-muted-foreground group-open:hidden">{evidence.length ? `Tap for ${evidence.length} source ${evidence.length === 1 ? "passage" : "passages"}` : "Tap for assessment"}</p></summary><div className="space-y-3 border-t border-white/8 px-3 py-3 text-left"><p className="text-xs leading-5 text-muted-foreground">{stat.rationale || "This score is still waiting for a source-grounded assessment."}</p>{evidence.length ? <div className="space-y-2">{evidence.map((item) => <blockquote key={`${item.chunkId}:${item.quote}`} className="rounded-lg border-l-2 border-primary/40 bg-black/20 px-2.5 py-2"><p className="text-[11px] leading-4 text-foreground/80">“{evidenceText(item)}”</p><cite className="mt-1 block text-[9px] not-italic text-muted-foreground">{evidenceLabel(item, detail)}</cite></blockquote>)}</div> : <p className="rounded-lg bg-amber-300/[0.06] px-2.5 py-2 text-[10px] leading-4 text-amber-100/80">No direct passage is attached to this score yet. Guide a dossier review toward this ability before relying on it.</p>}</div></details>; })}</div> : <p className="mt-5 rounded-2xl border border-dashed border-white/10 p-5 text-sm leading-6 text-muted-foreground">This creature has a full dossier, but its ability estimates are still waiting for a grounded source pass. Run an AI dossier review to populate them.</p>}
            </Card>
          ) : null}

          <Card className="rounded-3xl border-white/8 bg-white/[0.025] p-5 sm:p-6">
            <div className="flex items-start gap-3"><Link2 className="mt-1 h-5 w-5 text-primary" /><div><h2 className="font-serif text-2xl font-bold">Canonical Connections</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">Memberships, taxonomy, ownership, powers, offices, locations, and other links remain separate cards and are visible from both sides.</p></div></div>
            <div className="mt-4 flex gap-2 rounded-xl border border-primary/20 bg-primary/[0.045] px-3 py-2.5 text-xs leading-5 text-muted-foreground"><Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /><p><strong className="text-foreground">Premium Deep Reading Clarifies the Full Connection.</strong> It checks direction, metaphor, chronology, changing control, and the events that created or ended each link.</p></div>
            {relationGroups.length ? <div className="mt-5 grid gap-4 lg:grid-cols-2">{relationGroups.map(([heading, rows]) => <section key={heading} className="rounded-2xl border border-white/8 bg-black/15 p-4"><h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">{heading}</h3><div className="mt-3 space-y-2">{rows.map(({ relation, other }) => {
              const href = other ? linkedDossier(worldId, other) : null;
              return <div key={relation.id} className="flex items-start justify-between gap-3 rounded-xl border border-white/8 bg-black/20 px-3 py-2.5"><div className="min-w-0">{other ? href ? <Link href={href} className="font-semibold hover:text-primary hover:underline">{other.name}</Link> : <span className="font-semibold">{other.name}</span> : <span className="font-semibold">Missing card</span>}<div className="mt-1 flex flex-wrap gap-1.5"><Badge variant="outline" className="border-white/10 text-[9px]">{relation.status}</Badge><Badge variant="outline" className="border-white/10 text-[9px]">{categoryNames[other?.entityType ?? "ambiguous"]}</Badge></div>{relation.summary ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{relation.summary}</p> : null}{relation.validFromLabel || relation.validUntilLabel ? <p className="mt-1 text-[10px] text-muted-foreground">{relation.validFromLabel ? `From: ${relation.validFromLabel}` : ""}{relation.validFromLabel && relation.validUntilLabel ? " · " : ""}{relation.validUntilLabel ? `Until: ${relation.validUntilLabel}` : ""}</p> : null}</div><button type="button" aria-label={`Remove connection to ${other?.name ?? "card"}`} disabled={busy} className="rounded-lg p-1.5 text-muted-foreground hover:bg-white/10 hover:text-foreground" onClick={() => void removeConnection(relation)}><X className="h-3.5 w-3.5" /></button></div>;
            })}</div></section>)}</div> : <p className="mt-5 rounded-2xl border border-dashed border-white/10 p-5 text-sm text-muted-foreground">No canonical connections have been established yet.</p>}
            <div className="mt-5"><EntityConnectionEditor entity={entity} entities={detail.entities.filter((candidate) => candidate.pullStatus === "active")} busy={busy} onCreate={addConnections} /></div>
          </Card>

          <Card className="rounded-3xl border-white/8 bg-white/[0.025] p-5 sm:p-6">
            <div className="flex items-start gap-3"><ShieldCheck className="mt-1 h-5 w-5 text-primary" /><div><h2 className="font-serif text-2xl font-bold">Canonical Rules</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">Traits, limitations, biological rules, and gameplay consequences that retrieval must preserve.</p></div></div>
            <div className="mt-4 flex gap-2 rounded-xl border border-primary/20 bg-primary/[0.045] px-3 py-2.5 text-xs leading-5 text-muted-foreground"><Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /><p><strong className="text-foreground">Premium Deep Reading Finds Exceptions and Consequences.</strong> It traces triggers, limitations, inherited rules, and contradictory cases across the full source chronology.</p></div>
            {rules.length ? <div className="mt-5 grid gap-3 md:grid-cols-2">{rules.map((rule) => <div key={rule.id} className="flex items-start justify-between gap-3 rounded-2xl border border-white/8 bg-black/15 p-4"><div><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{rule.name}</h3><Badge variant="outline" className="border-white/10 text-[9px]">{rule.ruleKind}</Badge></div>{rule.description ? <p className="mt-2 text-sm leading-6 text-muted-foreground">{rule.description}</p> : null}{rule.trigger || rule.effect ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{rule.trigger ? `When: ${rule.trigger}` : ""}{rule.trigger && rule.effect ? " · " : ""}{rule.effect ? `Then: ${rule.effect}` : ""}</p> : null}</div><button type="button" aria-label={`Remove ${rule.name}`} disabled={busy} className="rounded-lg p-1.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-200" onClick={() => void removeRule(rule)}><Trash2 className="h-3.5 w-3.5" /></button></div>)}</div> : <p className="mt-4 text-sm text-muted-foreground">No explicit rules have been established yet.</p>}
            <form onSubmit={addRule} className="mt-5 grid gap-3 rounded-2xl border border-white/8 bg-black/15 p-4 lg:grid-cols-[0.7fr_0.45fr_1.2fr_auto] lg:items-end">
              <label className="text-xs font-semibold text-muted-foreground">Rule name<Input className="mt-1" value={ruleName} onChange={(event) => setRuleName(event.target.value)} placeholder="Genetic accretion" maxLength={180} /></label>
              <label className="text-xs font-semibold text-muted-foreground">Kind<select className="storyhold-select mt-1 block w-full" value={ruleKind} onChange={(event) => setRuleKind(event.target.value as WorldEntityRule["ruleKind"])}><option value="trait">Trait</option><option value="ability">Ability</option><option value="constraint">Constraint</option><option value="biological">Biological</option><option value="social">Social</option><option value="gameplay">Gameplay</option></select></label>
              <label className="text-xs font-semibold text-muted-foreground">Description<Input className="mt-1" value={ruleDescription} onChange={(event) => setRuleDescription(event.target.value)} placeholder="What remains true and why" maxLength={2_000} /></label>
              <Button type="submit" disabled={busy || ruleName.trim().length < 2}><ScrollText className="mr-2 h-4 w-4" />Add rule</Button>
            </form>
          </Card>

          <details className="group rounded-2xl border border-white/8 bg-white/[0.025]">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3"><span className="flex items-center gap-2 font-serif text-lg font-bold"><BookOpen className="h-4 w-4 text-primary" />Source evidence</span><span className="flex items-center gap-2 text-xs text-muted-foreground">{entity.evidence.length} passages <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" /></span></summary>
            {entity.evidence.length ? <div className="grid gap-2 border-t border-white/8 px-3 py-3 md:grid-cols-2">{entity.evidence.map((evidence, index) => <blockquote key={`${evidence.chunkId}-${index}`} className="rounded-xl bg-black/15 p-3"><p className="text-xs leading-5 text-foreground/85">{evidenceText(evidence)}</p><footer className="mt-2 text-[10px] font-semibold text-primary">{evidenceLabel(evidence, detail)}</footer></blockquote>)}</div> : <p className="border-t border-white/8 px-4 py-3 text-sm text-muted-foreground">No source citation has been attached to this card yet.</p>}
          </details>
        </div>
      )}
    </ProfileFrame>
  );
}
