import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Brain,
  Fingerprint,
  Gauge,
  Loader2,
  Lock,
  Network,
  Pencil,
  Save,
  Scale,
  Shield,
  Sparkles,
  X,
} from "lucide-react";
import { Link, useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
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
import { compassEvidenceLabel, dossierCompassView } from "@/lib/dossierCompass";
import {
  createWorldEntityRelations,
  deleteWorldEntityRelation,
  getCharacterDossier,
  updateCharacterDossier,
  updateCharacterSocioPoliticalAxis,
  type CharacterDossier,
  type DossierProseReview,
  type DossierCompassReview,
  type CharacterAliasAttribution,
  type CharacterStatName,
  type WorldEntity,
  type WorldEntityRelation,
} from "@/lib/storyholdApi";

const statNames: CharacterStatName[] = [
  "strength",
  "dexterity",
  "constitution",
  "intelligence",
  "wisdom",
  "charisma",
  "acrobatics",
];

type EditableProfileKey =
  | "traits" | "motivations" | "fears" | "capabilities" | "history"
  | "origins" | "powers" | "moralSystem" | "physicalCharacteristics"
  | "relationships" | "knowledge" | "secrets";

const editableProfileFields: Array<{ key: EditableProfileKey; label: string }> = [
  { key: "traits", label: "Traits" },
  { key: "motivations", label: "Motivations" },
  { key: "fears", label: "Fears" },
  { key: "capabilities", label: "Capabilities" },
  { key: "history", label: "History" },
  { key: "origins", label: "Origins" },
  { key: "powers", label: "Powers" },
  { key: "moralSystem", label: "Moral system" },
  { key: "physicalCharacteristics", label: "Physical characteristics" },
  { key: "relationships", label: "Relationship notes" },
  { key: "knowledge", label: "Knowledge" },
  { key: "secrets", label: "Secrets" },
];

function emptyManualFields(): Record<EditableProfileKey, string> {
  return Object.fromEntries(editableProfileFields.map(({ key }) => [key, ""])) as Record<EditableProfileKey, string>;
}

function title(value: string) {
  return value.replace(/(^|_)([a-z])/g, (_, space, letter) => `${space ? " " : ""}${letter.toUpperCase()}`);
}

function modifier(score: number) {
  const value = Math.floor((score - 10) / 2);
  return value >= 0 ? `+${value}` : String(value);
}

function confidenceLabel(confidence: number, role: string) {
  if (/candidate|unreviewed|detected/i.test(role)) return "identity found in sources";
  if (confidence >= 0.8) return "strong evidence";
  if (confidence >= 0.5) return "supported estimate";
  return "tentative estimate";
}

function aliasKindLabel(kind: CharacterAliasAttribution["kind"]) {
  return ({
    familiar_name: "Familiar Name",
    formal_address: "Formal Address",
    honorific: "Honorific",
    nickname: "Nickname",
    identity_reveal: "Identity Reveal",
    descriptive_reference: "Descriptive Reference",
    owner_canon: "Owner-Confirmed Name",
  } as const)[kind];
}

function AliasBadge({
  alias,
  attribution,
}: {
  alias: string;
  attribution?: CharacterAliasAttribution;
}) {
  const [open, setOpen] = useState(false);
  if (!attribution) return <Badge variant="secondary">{alias}</Badge>;
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={180} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className={badgeVariants({
            variant: "secondary",
            className: "cursor-help hover:border-primary/30 hover:bg-primary/[0.08] focus-visible:ring-2 focus-visible:ring-primary/60",
          })}
          aria-label={`Why ${alias} is listed as a name for this character`}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          {alias}
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 rounded-2xl border-primary/20 bg-background/95 p-4 shadow-2xl backdrop-blur-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-serif text-lg font-bold text-foreground">{alias}</p>
            <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
              {aliasKindLabel(attribution.kind)}
            </p>
          </div>
          {attribution.attributedBy ? <Badge variant="outline">Used by {attribution.attributedBy}</Badge> : null}
        </div>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{attribution.explanation}</p>
        {attribution.temporalScope === "single_scene" ? (
          <Badge variant="outline" className="mt-3 border-sky-300/25 bg-sky-300/[0.06] text-sky-100">Scene-Specific Description</Badge>
        ) : null}
        {attribution.semanticLimits.length ? (
          <ul className="mt-3 space-y-1.5 text-xs leading-5 text-foreground/85">
            {attribution.semanticLimits.map((limit) => <li key={limit}>• {limit}</li>)}
          </ul>
        ) : null}
        {attribution.quote ? <blockquote className="mt-3 border-l-2 border-primary/35 pl-3 text-xs italic leading-5 text-foreground/85">“{attribution.quote}”</blockquote> : null}
        {attribution.sourceTitle || attribution.chapterTitle ? (
          <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <BookOpen className="h-3.5 w-3.5 text-primary" />
            {[attribution.sourceTitle, attribution.chapterTitle].filter(Boolean).join(" · ")}
          </p>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  );
}

function linkedEntityDossier(worldId: string, entity: WorldEntity): string | null {
  return worldEntityDossierHref(worldId, entity);
}

function normalizedEntityLabel(value: string) {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function evidencePresentation(evidence: CharacterDossier["evidence"][number]) {
  const manual = evidence as typeof evidence & {
    sourceTitle?: string | null;
    page?: number | null;
    note?: string | null;
  };
  const source = evidence.sourceId
    ? `Source ${evidence.sourceId.slice(0, 8)}`
    : manual.sourceTitle || "Imported source";
  const passage = evidence.chunkId
    ? `passage ${evidence.chunkId.slice(0, 18)}`
    : manual.page
      ? `page ${manual.page}`
      : "AI review note";
  return {
    key: evidence.chunkId || `${manual.sourceTitle ?? "source"}-${manual.page ?? "note"}`,
    quote: evidence.quote || manual.note || "Evidence recorded during manuscript review.",
    citation: `${source} · ${passage}`,
  };
}

function connectionLabel(relation: WorldEntityRelation, entityId: string) {
  const outgoing = relation.sourceEntityId === entityId;
  const otherName = outgoing ? relation.targetName : relation.sourceName;
  const labels: Record<WorldEntityRelation["relationType"], string> = {
    member_of: outgoing ? (relation.targetType === "institution" ? "Institution" : "Faction") : "Known member",
    participates_in: outgoing ? "Participates in" : "Participant",
    species_of: outgoing ? "Species" : "Named member",
    subspecies_of: outgoing ? "Subspecies of" : "Known subspecies",
    subtype_of: outgoing ? "Subtype of" : "Known subtype",
    lifecycle_stage_of: outgoing ? "Lifecycle stage of" : "Lifecycle stage",
    has_power: outgoing ? "Power" : "Observed in",
    has_form: outgoing ? "Creature form" : "Manifested by",
    holds_title: outgoing ? "Title" : "Title holder",
    child_of: outgoing ? "Parent" : "Child",
    sibling_of: "Sibling",
    spouse_of: "Spouse / partner",
    friend_of: "Friend",
    best_friend_of: "Best friend",
    leads: outgoing ? "Leads" : "Leader",
    governs: outgoing ? "Governs" : "Governed by",
    controlled_by: outgoing ? "Controlled by" : "Controls",
    allied_with: "Allied with",
    opposed_to: "Opposed to",
    located_in: outgoing ? "Location" : "Located here",
    part_of: outgoing ? "Part of" : "Contains",
    created_by: outgoing ? "Created by" : "Created",
    related_to: "Connected to",
  };
  return { label: labels[relation.relationType], otherName };
}

function DetailList({
  title: heading,
  values,
  empty,
}: {
  title: string;
  values: string[];
  empty: string;
}) {
  const [visibleCount, setVisibleCount] = useState(DOSSIER_PREVIEW_ITEMS);
  const page = dossierListWindow(values, visibleCount);
  return (
    <details className="group rounded-2xl border border-white/8 bg-white/[0.025]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <h2 className="font-serif text-lg font-bold">{heading}</h2>
        <span className="rounded-full border border-white/8 bg-black/20 px-2 py-0.5 text-[10px] text-muted-foreground">{values.length}</span>
      </summary>
      {values[0] ? <p className="-mt-1 line-clamp-2 px-4 pb-3 text-xs leading-5 text-muted-foreground group-open:hidden">{values[0]}</p> : null}
      {values.length ? (
        <ul className="space-y-1.5 border-t border-white/8 px-3 py-3 text-sm leading-5 text-foreground/85">
          {page.visibleValues.map((value, index) => (
            <li key={`${value}-${index}`} className="rounded-lg bg-black/15 px-3 py-2">
              {value}
            </li>
          ))}
        </ul>
      ) : (
        <p className="border-t border-white/8 px-4 py-3 text-sm leading-6 text-muted-foreground">{empty}</p>
      )}
      {values.length > DOSSIER_PREVIEW_ITEMS ? <div className="flex flex-wrap items-center gap-2 border-t border-white/8 px-4 py-3">
        <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">Showing {page.shownCount} of {page.total}</span>
        {page.hasMore ? <><Button type="button" size="sm" variant="outline" onClick={() => setVisibleCount(page.nextCount)}>Show More</Button><Button type="button" size="sm" variant="ghost" onClick={() => setVisibleCount(page.total)}>Show All</Button></> : null}
        {page.shownCount > DOSSIER_PREVIEW_ITEMS ? <Button type="button" size="sm" variant="ghost" onClick={() => setVisibleCount(DOSSIER_PREVIEW_ITEMS)}>Show Fewer</Button> : null}
      </div> : null}
    </details>
  );
}

function PremiumReadingNotice({
  title: heading,
  children,
  locked = false,
}: {
  title: string;
  children: ReactNode;
  locked?: boolean;
}) {
  return (
    <div className="mt-3 flex items-start justify-between gap-3 rounded-xl border border-emerald-300/15 bg-emerald-300/[0.045] px-3 py-2.5">
      <div className="flex min-w-0 items-start gap-2">
        {locked ? <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" /> : <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />}
        <p className="text-[11px] leading-5 text-muted-foreground"><strong className="text-foreground">{heading}</strong> {children}</p>
      </div>
      <a href="#dossier-deep-reading" className="shrink-0 text-[10px] font-semibold text-emerald-300 transition-colors hover:text-emerald-200">Improve</a>
    </div>
  );
}

export default function ProfileCharacter() {
  const auth = useAuth();
  const [, setLocation] = useLocation();
  const { worldId = "", characterId = "" } = useParams<{
    worldId: string;
    characterId: string;
  }>();
  const [worldName, setWorldName] = useState("");
  const [character, setCharacter] = useState<CharacterDossier | null>(null);
  const [proseReview, setProseReview] = useState<DossierProseReview | null>(null);
  const [compassReview, setCompassReview] = useState<DossierCompassReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [redirectingToSorting, setRedirectingToSorting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [economic, setEconomic] = useState(0);
  const [authority, setAuthority] = useState(0);
  const [axisLabel, setAxisLabel] = useState("");
  const [axisRationale, setAxisRationale] = useState("");
  const [axisExpanded, setAxisExpanded] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [dossierEditing, setDossierEditing] = useState(false);
  const [manualAliases, setManualAliases] = useState("");
  const [manualRole, setManualRole] = useState("");
  const [manualSummary, setManualSummary] = useState("");
  const [manualFields, setManualFields] = useState<Record<EditableProfileKey, string>>(emptyManualFields);
  const [hold, setHold] = useState<{
    entityId: string;
    entities: WorldEntity[];
    relations: WorldEntityRelation[];
  } | null>(null);

  useSeo({
    title: character?.name || "Character dossier",
    description: "A private character dossier in your Storyhold.",
    canonicalPath: `/profile/worlds/${worldId}/characters/${characterId}`,
    noindex: true,
  });

  useEffect(() => {
    if (!auth.email || !worldId || !characterId) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    setProseReview(null);
    setCompassReview(null);
    void getCharacterDossier(worldId, characterId)
      .then((result) => {
        if (!active) return;
        const holdEntity = result.hold?.entities.find((entity) => entity.id === result.hold?.entityId);
        if (holdEntity?.entityType === "ambiguous") {
          setRedirectingToSorting(true);
          setLocation(worldNeedsSortingHref(worldId, holdEntity.id), { replace: true });
          return;
        }
        setWorldName(result.world.name);
        setCharacter(result.character);
        setProseReview(result.proseReview ?? null);
        setCompassReview(result.compassReview ?? null);
        setEconomic(result.character.socioPoliticalAxis.economic);
        setAuthority(result.character.socioPoliticalAxis.authority);
        setAxisLabel(result.character.socioPoliticalAxis.label);
        setAxisRationale(result.character.socioPoliticalAxis.rationale);
        setHold(result.hold);
        setManualAliases(result.character.aliases.join(", "));
        setManualRole(result.character.role);
        setManualSummary(result.character.summary);
        setManualFields(Object.fromEntries(editableProfileFields.map(({ key }) => [key, result.character.profile[key].join("\n")])) as Record<EditableProfileKey, string>);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "We could not open this character.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [auth.email, characterId, setLocation, worldId]);

  const relationshipRows = useMemo(() => {
    if (!character) return [];
    const extracted = character.profile.relationshipWeb.length
      ? character.profile.relationshipWeb
      : character.profile.relationships.map((summary) => ({
          name: summary.split(/\s[-:—]\s/, 1)[0] || "Known connection",
          relationship: "known connection",
          summary,
          sentiment: "unknown" as const,
          evidence: [],
          relatedCharacterId: null,
        }));
    if (!hold) {
      return extracted.map((relationship, index) => ({
        key: `text:${normalizedEntityLabel(relationship.name)}:${index}`,
        name: relationship.name,
        labels: [relationship.relationship],
        summaries: relationship.summary ? [relationship.summary] : [],
        sentiment: relationship.sentiment,
        href: relationship.relatedCharacterId
          ? `/profile/worlds/${worldId}/characters/${relationship.relatedCharacterId}`
          : null,
        category: "Connection",
      }));
    }

    type RelationshipRow = {
      key: string;
      name: string;
      labels: string[];
      summaries: string[];
      sentiment: "allied" | "hostile" | "mixed" | "familial" | "romantic" | "professional" | "unknown";
      href: string | null;
      category: string;
    };
    const entitiesById = new Map(hold.entities.map((entity) => [entity.id, entity]));
    const entitiesByLabel = new Map<string, WorldEntity[]>();
    for (const entity of hold.entities) {
      for (const label of [entity.name, ...entity.aliases]) {
        const key = normalizedEntityLabel(label);
        if (!key) continue;
        entitiesByLabel.set(key, [...(entitiesByLabel.get(key) ?? []), entity]);
      }
    }
    const resolveEntity = (name: string, dossierId?: string | null) => {
      if (dossierId) {
        const byDossier = hold.entities.find((entity) => entity.dossierId === dossierId);
        if (byDossier) return byDossier;
      }
      const candidates = entitiesByLabel.get(normalizedEntityLabel(name)) ?? [];
      return candidates.length === 1 ? candidates[0] : null;
    };
    const merged = new Map<string, RelationshipRow>();
    const add = (params: {
      name: string;
      entity: WorldEntity | null;
      label: string;
      summary?: string;
      sentiment: RelationshipRow["sentiment"];
    }) => {
      const key = params.entity?.id ?? `text:${normalizedEntityLabel(params.name)}`;
      const row = merged.get(key) ?? {
        key,
        name: params.entity?.name ?? params.name,
        labels: [],
        summaries: [],
        sentiment: params.sentiment,
        href: params.entity ? linkedEntityDossier(worldId, params.entity) : null,
        category: params.entity ? title(params.entity.entityType) : "Connection",
      };
      if (params.label && !row.labels.some((label) => normalizedEntityLabel(label) === normalizedEntityLabel(params.label))) {
        row.labels.push(params.label);
      }
      if (params.summary && !row.summaries.some((summary) => normalizedEntityLabel(summary) === normalizedEntityLabel(params.summary!))) {
        row.summaries.push(params.summary);
      }
      if (row.sentiment === "unknown" && params.sentiment !== "unknown") row.sentiment = params.sentiment;
      merged.set(key, row);
    };

    for (const relation of hold.relations) {
      const outgoing = relation.sourceEntityId === hold.entityId;
      const otherEntityId = outgoing ? relation.targetEntityId : relation.sourceEntityId;
      const other = entitiesById.get(otherEntityId) ?? null;
      const display = connectionLabel(relation, hold.entityId);
      const sentiment = relation.relationType === "spouse_of"
        ? "romantic" as const
        : ["child_of", "sibling_of"].includes(relation.relationType)
          ? "familial" as const
          : ["friend_of", "best_friend_of", "allied_with"].includes(relation.relationType)
            ? "allied" as const
            : relation.relationType === "opposed_to"
              ? "hostile" as const
              : "professional" as const;
      add({ name: display.otherName, entity: other, label: display.label, summary: relation.summary || undefined, sentiment });
    }
    for (const relationship of extracted) {
      const resolvedEntity = resolveEntity(relationship.name, relationship.relatedCharacterId);
      // A source-backed dossier connection is useful before it has been
      // promoted into the canonical graph. Resolve it to the full dossier now
      // so intake relationships never disappear merely because their graph
      // edge is still waiting for deeper review or owner confirmation.
      add({
        name: relationship.name,
        entity: resolvedEntity,
        label: relationship.relationship,
        summary: relationship.summary,
        sentiment: relationship.sentiment,
      });
    }
    return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
  }, [character, hold, worldId]);

  async function performAxisSave() {
    if (!character || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateCharacterSocioPoliticalAxis({
        worldId,
        characterId,
        economic,
        authority,
        label: axisLabel,
        rationale: axisRationale,
      });
      setCharacter(result.character);
      setProseReview(null);
      setCompassReview(null);
      await refreshHold();
      setAxisExpanded(false);
      toast.success(`${character.name}'s socio-political position was updated.`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "The position could not be saved.";
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  function saveAxis(event: FormEvent) {
    event.preventDefault();
    if (!character || saving) return;
    const toastId = toast(`Update ${character.name}'s socio-political position?`, {
      description: "This replaces the owner-confirmed position used by the Hold. The source-derived estimate remains preserved for reference.",
      duration: 12_000,
      action: {
        label: "Confirm",
        onClick: () => {
          toast.dismiss(toastId);
          void performAxisSave();
        },
      },
      cancel: { label: "Cancel", onClick: () => toast.dismiss(toastId) },
    });
  }

  async function refreshHold() {
    const result = await getCharacterDossier(worldId, characterId);
    const holdEntity = result.hold?.entities.find((entity) => entity.id === result.hold?.entityId);
    if (holdEntity?.entityType === "ambiguous") {
      setRedirectingToSorting(true);
      setLocation(worldNeedsSortingHref(worldId, holdEntity.id), { replace: true });
      return;
    }
    setCharacter(result.character);
    setProseReview(result.proseReview ?? null);
    setCompassReview(result.compassReview ?? null);
    setEconomic(result.character.socioPoliticalAxis.economic);
    setAuthority(result.character.socioPoliticalAxis.authority);
    setAxisLabel(result.character.socioPoliticalAxis.label);
    setAxisRationale(result.character.socioPoliticalAxis.rationale);
    setHold(result.hold);
    setManualAliases(result.character.aliases.join(", "));
    setManualRole(result.character.role);
    setManualSummary(result.character.summary);
    setManualFields(Object.fromEntries(editableProfileFields.map(({ key }) => [key, result.character.profile[key].join("\n")])) as Record<EditableProfileKey, string>);
  }

  async function saveManualDossier(event: FormEvent) {
    event.preventDefault();
    if (!character || saving) return;
    setSaving(true);
    try {
      const result = await updateCharacterDossier({
        worldId,
        characterId,
        aliases: dossierListFromEditor(character.aliases, manualAliases, ", ", /[,;\n]/),
        role: manualRole.trim(),
        summary: manualSummary.trim(),
        profile: {
          ...character.profile,
          ...Object.fromEntries(editableProfileFields.map(({ key }) => [
            key,
            dossierListFromEditor(character.profile[key], manualFields[key]),
          ])),
        },
      });
      setCharacter(result.character);
      setProseReview(null);
      setCompassReview(null);
      setDossierEditing(false);
      await refreshHold();
      toast.success(`${character.name}'s dossier was updated.`);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The character dossier could not be updated.");
    } finally {
      setSaving(false);
    }
  }

  function addConnection(input: {
    connections: Parameters<typeof createWorldEntityRelations>[0]["connections"];
    actionLabel: string;
    onSaved: () => void;
  }) {
    if (!hold || connectionBusy) return;
    const pairs = input.connections.map((connection) => ({
      source: hold.entities.find((entity) => entity.id === connection.sourceEntityId),
      target: hold.entities.find((entity) => entity.id === connection.targetEntityId),
    }));
    if (!pairs.length || pairs.some((pair) => !pair.source || !pair.target)) return;
    setConnectionBusy(true);
    void createWorldEntityRelations({ worldId, connections: input.connections }).then(refreshHold).then(() => {
      input.onSaved();
      toast.success(`${input.connections.length} canonical connection${input.connections.length === 1 ? " was" : "s were"} saved.`);
    }).catch((reason) => toast.error(reason instanceof Error ? reason.message : "The Hold could not save those connections.")).finally(() => setConnectionBusy(false));
  }

  function removeConnection(relation: WorldEntityRelation) {
    if (connectionBusy) return;
    const toastId = toast("Remove this canonical connection?", {
      description: `${relation.sourceName} and ${relation.targetName} will keep their own dossiers.`,
      duration: 12_000,
      action: {
        label: "Remove",
        onClick: () => {
          toast.dismiss(toastId);
          setConnectionBusy(true);
          void deleteWorldEntityRelation({ worldId, relationId: relation.id }).then(refreshHold).then(() => toast.success("The connection was removed.")).catch((reason) => toast.error(reason instanceof Error ? reason.message : "The Hold could not remove that connection.")).finally(() => setConnectionBusy(false));
        },
      },
      cancel: { label: "Cancel", onClick: () => toast.dismiss(toastId) },
    });
  }

  if (loading || redirectingToSorting) {
    return <ProfileFrame><div className="grid min-h-96 place-items-center"><span className="inline-flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin text-primary" />{redirectingToSorting ? "Opening Needs Sorting…" : null}</span></div></ProfileFrame>;
  }

  if (error && !character) {
    return (
      <ProfileFrame>
        <Link href={`/profile/worlds/${worldId}`} className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="mr-2 h-4 w-4" /> Back to world</Link>
        <Card className="mt-8 rounded-3xl border-red-400/20 bg-red-400/[0.05] p-7"><h1 className="font-serif text-3xl font-bold">This Character Could Not Be Opened.</h1><p className="mt-3 text-sm text-muted-foreground">{error}</p></Card>
      </ProfileFrame>
    );
  }

  if (!character) return null;
  const axis = character.socioPoliticalAxis;
  const compass = dossierCompassView(axis, character.socioPoliticalAxisChanged, compassReview);
  const hasInterpretedAxis = compass.sourceBacked || compass.authorControlled;
  const holdEntity = hold?.entities.find((entity) => entity.id === hold.entityId) ?? null;
  const holdRelations = hold?.relations ?? [];
  const detailGroups = [
    { title: "History", values: character.profile.history, empty: "No supported history has been found yet." },
    { title: "Origins", values: character.profile.origins, empty: "This character's origins remain unknown." },
    { title: "Traits", values: character.profile.traits, empty: "No reliable traits have been inferred yet." },
    { title: "Physical Characteristics", values: character.profile.physicalCharacteristics, empty: "No physical description has been found yet." },
    { title: "Powers and Capabilities", values: [...character.profile.powers, ...character.profile.capabilities], empty: "No special powers or capabilities have been established." },
    { title: "Moral System", values: character.profile.moralSystem, empty: "Their moral framework has not been demonstrated clearly enough yet." },
    { title: "Motivations", values: character.profile.motivations, empty: "Their motives remain unclear." },
    { title: "Fears", values: character.profile.fears, empty: "No supported fears have been identified." },
    { title: "Knowledge", values: character.profile.knowledge, empty: "No character-specific knowledge is recorded yet." },
    { title: "Secrets", values: character.profile.secrets, empty: "No secrets are recorded in the Hold." },
  ];
  const establishedGroups = detailGroups.filter((group) => group.values.length > 0);
  const pendingGroups = detailGroups.filter((group) => group.values.length === 0);

  return (
    <ProfileFrame>
      <Link href={`/profile/worlds/${worldId}`} className="inline-flex items-center text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="mr-2 h-4 w-4" /> Back to {worldName || "world"}</Link>

      <section className="storyhold-glass relative mt-5 overflow-hidden rounded-3xl p-5 sm:p-6">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_90%_0%,rgba(56,189,248,0.16),transparent_38%)]" />
        <div className="relative">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Character Dossier</p>
              <h1 className="mt-2 font-serif text-3xl font-bold tracking-tight sm:text-4xl">{character.name}</h1>
              {character.role ? <p className="mt-2 text-base font-semibold text-primary/90">{character.role}</p> : null}
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{character.summary || "Storyhold has identified this person, but their fuller history still needs evidence."}</p>
            </div>
            <div className="flex w-fit flex-col gap-2 sm:items-end">
              <Badge variant="outline" className="w-fit border-primary/25 bg-primary/[0.06] px-3 py-1.5"><Sparkles className="mr-1.5 h-3.5 w-3.5" />{confidenceLabel(character.confidence, character.role)}</Badge>
              <Button type="button" size="sm" variant="outline" className="rounded-xl" onClick={() => setDossierEditing((current) => !current)}>
                {dossierEditing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                {dossierEditing ? "Close editor" : "Edit dossier yourself"}
              </Button>
            </div>
          </div>
          {character.aliases.length ? <div className="mt-4 flex flex-wrap gap-1.5">{character.aliases.map((alias) => (
            <AliasBadge
              key={alias}
              alias={alias}
              attribution={character.aliasAttributions.find((entry) => entry.alias.toLocaleLowerCase() === alias.toLocaleLowerCase())}
            />
          ))}</div> : null}
          <details className="mt-3 text-xs text-muted-foreground"><summary className="inline-flex cursor-pointer items-center gap-1.5 font-semibold hover:text-foreground"><Fingerprint className="h-3.5 w-3.5 text-primary" />Identity record</summary><p className="mt-2 rounded-lg bg-black/20 px-3 py-2 font-mono">{character.id}</p></details>
        </div>
      </section>

      {error ? <Card className="mt-5 rounded-2xl border-red-400/20 bg-red-400/[0.05] p-4 text-sm text-red-100">{error}</Card> : null}

      {dossierEditing ? (
        <Card className="mt-5 rounded-3xl border-primary/20 bg-primary/[0.035] p-5 sm:p-6">
          <form className="space-y-4" onSubmit={saveManualDossier}>
            <div><h2 className="font-serif text-2xl font-bold">Edit {character.name} manually</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">No AI is used. Enter one fact per line; blank sections stay blank.</p></div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-xs font-semibold text-muted-foreground">Role<Input className="mt-1" value={manualRole} onChange={(event) => setManualRole(event.target.value)} maxLength={240} placeholder="Executive, scout, antagonist..." /></label>
              <label className="text-xs font-semibold text-muted-foreground">Also known as<Input className="mt-1" value={manualAliases} onChange={(event) => setManualAliases(event.target.value)} placeholder="Comma-separated aliases" /></label>
            </div>
            <label className="block text-xs font-semibold text-muted-foreground">Biography / summary<Textarea className="mt-1 min-h-28" value={manualSummary} onChange={(event) => setManualSummary(event.target.value)} maxLength={4_000} /></label>
            <div className="grid gap-3 md:grid-cols-2">
              {editableProfileFields.map(({ key, label }) => <label key={key} className="text-xs font-semibold text-muted-foreground">{label}<Textarea className="mt-1 min-h-28" value={manualFields[key]} onChange={(event) => setManualFields((current) => ({ ...current, [key]: event.target.value }))} placeholder="One supported fact per line" /></label>)}
            </div>
            <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={saving} onClick={() => setDossierEditing(false)}>Cancel</Button><Button type="submit" disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save manual dossier</Button></div>
          </form>
        </Card>
      ) : null}

      {holdEntity ? <div id="dossier-deep-reading" className="mt-5 scroll-mt-24"><EntityAiReviewCard worldId={worldId} entityId={holdEntity.id} name={character.name} entityType="character" onComplete={refreshHold} /></div> : null}
      <div className="mt-3"><DossierEvidence key={character.id} review={proseReview} /></div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.12fr_0.88fr]">
        <div className="space-y-4">
          <Card className="rounded-2xl border-primary/15 bg-primary/[0.025] p-4">
            <div className="flex items-center gap-2"><Brain className="h-4 w-4 text-primary" /><div><h2 className="font-serif text-xl font-bold">Storyhold Understanding</h2><p className="text-xs text-muted-foreground">What the manuscript currently establishes about {character.name}.</p></div></div>
            <PremiumReadingNotice title="Premium Deep Reading Adds the Inner Story.">It substantially improves evolving motivations, private beliefs, secrets, contradictions, turning points, and chapter-by-chapter character development.</PremiumReadingNotice>
            {establishedGroups.length ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{establishedGroups.map((group) => <DetailList key={`${character.id}:${group.title}`} {...group} />)}</div> : <p className="mt-3 text-sm leading-6 text-muted-foreground">The source passages are indexed, but no durable character details have been established yet.</p>}
            {pendingGroups.length && establishedGroups.length ? <details className="mt-3 rounded-xl border border-white/8 bg-black/15 p-3"><summary className="cursor-pointer text-xs font-semibold">{pendingGroups.length} Areas Still Waiting for Direct Evidence</summary><div className="mt-3 grid gap-2 sm:grid-cols-2">{pendingGroups.map((group) => <p key={group.title} className="rounded-lg bg-black/15 px-3 py-2 text-xs text-muted-foreground"><strong className="text-foreground/80">{group.title}:</strong> {group.empty}</p>)}</div></details> : null}
          </Card>

          <Card className="rounded-2xl border-white/8 bg-white/[0.025] p-4">
            <div className="flex items-center gap-2"><Gauge className="h-4 w-4 text-primary" /><div><h2 className="font-serif text-xl font-bold">Estimated Abilities</h2><p className="text-xs text-muted-foreground">Open a score for its source evidence.</p></div></div>
            <PremiumReadingNotice title="These Are Preliminary Evidence Estimates.">Premium Deep Reading weighs transformations, injuries, equipment, repeated feats, creature forms, and changes over time before settling a score.</PremiumReadingNotice>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {statNames.map((name) => {
                const stat = character.profile.estimatedStats[name];
                const evidence = stat.evidence ?? [];
                const established = stat.confidence >= 0.2 && evidence.length > 0;
                return <details key={name} className="group rounded-xl border border-white/8 bg-black/20 text-center">
                  <summary className="cursor-pointer list-none p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title(name)}</p>
                    <p className="mt-1 font-serif text-2xl font-bold">{established ? stat.score : "—"}</p>
                    <p className="text-xs font-semibold text-primary">{established ? modifier(stat.score) : "Not Established"}</p>
                    <div className="mx-auto mt-2 h-1 max-w-16 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full bg-primary" style={{ width: `${established ? Math.max(5, stat.confidence * 100) : 0}%` }} /></div>
                    <p className="mt-1.5 text-[9px] text-muted-foreground group-open:hidden">{established ? `${evidence.length} source ${evidence.length === 1 ? "passage" : "passages"}` : "Waiting for Evidence"}</p>
                  </summary>
                  <div className="space-y-3 border-t border-white/8 px-3 py-3 text-left">
                    <p className="text-xs leading-5 text-muted-foreground">{stat.rationale || "This score is still waiting for a source-grounded assessment."}</p>
                    {evidence.length ? <div className="space-y-2">{evidence.map((item) => { const shown = evidencePresentation(item); return <blockquote key={shown.key} className="rounded-lg border-l-2 border-primary/40 bg-black/20 px-2.5 py-2"><p className="text-[11px] leading-4 text-foreground/80">“{shown.quote}”</p><cite className="mt-1 block text-[9px] not-italic text-muted-foreground">{shown.citation}</cite></blockquote>; })}</div> : <p className="rounded-lg bg-amber-300/[0.06] px-2.5 py-2 text-[10px] leading-4 text-amber-100/80">No direct passage is attached to this score yet. Guide a dossier review toward this ability before relying on it.</p>}
                  </div>
                </details>;
              })}
            </div>
          </Card>

          <Card className="rounded-2xl border-white/8 bg-white/[0.025] p-4">
            <div className="flex items-center gap-2"><Network className="h-4 w-4 text-primary" /><div><h2 className="font-serif text-xl font-bold">Connections</h2><p className="text-xs text-muted-foreground">People, places, groups, creatures, and objects.</p></div></div>
            <PremiumReadingNotice title="Premium Deep Reading Clarifies the Relationship Web.">It distinguishes literal from metaphorical bonds, tracks changing loyalties, and explains the events that shaped each connection.</PremiumReadingNotice>
            {relationshipRows.length ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{relationshipRows.map((relationship, index) => {
              const content = <><div className="flex items-start justify-between gap-2"><p className="truncate text-sm font-semibold">{relationship.name}</p><Badge variant="outline" className="shrink-0 text-[9px]">{relationship.category}</Badge></div><div className="mt-1.5 flex flex-wrap gap-1">{relationship.labels.slice(0, 2).map((label) => <Badge key={label} variant="secondary" className="text-[9px]">{label}</Badge>)}{relationship.labels.length > 2 ? <span className="text-[10px] text-muted-foreground">+{relationship.labels.length - 2}</span> : null}</div>{relationship.summaries[0] ? <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{relationship.summaries[0]}</p> : null}</>;
              return relationship.href ? <Link key={relationship.key || `${relationship.name}-${index}`} href={relationship.href} className="rounded-xl border border-white/8 bg-black/20 p-3 transition-colors hover:border-primary/35 hover:bg-primary/[0.04]">{content}</Link> : <div key={relationship.key || `${relationship.name}-${index}`} className="rounded-xl border border-white/8 bg-black/20 p-3">{content}</div>;
            })}</div> : <p className="mt-3 text-sm leading-6 text-muted-foreground">No evidence-backed relationships have been mapped yet.</p>}
            {holdEntity && hold ? <details className="mt-5 border-t border-white/8 pt-4"><summary className="cursor-pointer text-sm font-semibold text-primary">Manage Canonical Connections</summary><div className="mt-4"><EntityConnectionEditor entity={holdEntity} entities={hold.entities} busy={connectionBusy} onCreate={addConnection} /></div>{holdRelations.length ? <div className="mt-4 grid gap-2 sm:grid-cols-2">{holdRelations.map((relation) => { const display = connectionLabel(relation, hold.entityId); return <div key={relation.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-black/20 px-3 py-2 text-xs"><span><strong>{display.otherName}</strong><span className="ml-2 text-muted-foreground">{display.label}</span></span><button type="button" className="rounded-lg p-1.5 text-muted-foreground hover:bg-white/10 hover:text-foreground" aria-label={`Remove connection to ${display.otherName}`} disabled={connectionBusy} onClick={() => removeConnection(relation)}><X className="h-3.5 w-3.5" /></button></div>; })}</div> : null}</details> : <p className="mt-4 text-xs text-muted-foreground">This older dossier is waiting for its Hold card to be synchronized.</p>}
          </Card>

        </div>

        <div className="space-y-4">
          <Card className="rounded-3xl border-white/8 bg-white/[0.025] p-5">
            <div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-start gap-3"><Scale className="mt-1 h-5 w-5 shrink-0 text-primary" /><div><h2 className="font-serif text-xl font-bold">Socio-Political Estimate</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">An interpretation of motive and conduct, not a moral verdict or an immutable fact.</p></div></div><Badge variant="outline" className="shrink-0">{compass.label}</Badge></div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">{compass.explanation}</p>
            {!hasInterpretedAxis ? <p className="mt-2 text-xs leading-5 text-muted-foreground">Premium Deep Reading can check this position against the manuscript. Your saved estimate remains available below, and you can set your own position.</p> : null}
            <details className="mt-4" open={hasInterpretedAxis}>
              <summary className="cursor-pointer text-xs font-semibold text-primary">{hasInterpretedAxis ? "View Position" : "View Saved Unreviewed Estimate"}</summary>
              <div className="mt-3 grid gap-4 sm:grid-cols-[9rem_1fr] sm:items-center">
              <div className="relative h-36 overflow-hidden rounded-xl border border-white/10 bg-black/20">
                <div className="absolute inset-x-0 top-1/2 h-px bg-white/15" /><div className="absolute inset-y-0 left-1/2 w-px bg-white/15" />
                <span className="absolute left-1/2 top-1.5 -translate-x-1/2 text-[8px] uppercase tracking-wide text-muted-foreground">Authority</span><span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 text-[8px] uppercase tracking-wide text-muted-foreground">Liberty</span><span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[8px] uppercase tracking-wide text-muted-foreground">Market</span><span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[8px] uppercase tracking-wide text-muted-foreground">Collective</span>
                <div className="absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-black bg-primary shadow-[0_0_14px_rgba(56,189,248,0.6)]" style={{ left: `${(axis.economic + 100) / 2}%`, top: `${(100 - axis.authority) / 2}%` }} />
              </div>
              <div><p className="font-semibold">{axis.label}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-5 text-muted-foreground">{axis.rationale}</p><div className="mt-3 flex flex-wrap gap-2 text-xs"><span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1">Economic <strong className="text-primary">{axis.economic}</strong></span><span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1">Authority <strong className="text-primary">{axis.authority}</strong></span>{compass.authorControlled ? <span className="rounded-full border border-primary/20 bg-primary/[0.06] px-2.5 py-1 text-primary">Author-Controlled</span> : null}</div></div>
              </div>
            </details>
            {compass.timeframe || compass.perspective || compass.evidence.length || compass.retrievalRequests.length ? <details className="mt-4 border-t border-white/8 pt-3">
              <summary className="cursor-pointer text-xs font-semibold text-primary">View Context and Source Passages</summary>
              <div className="mt-3 space-y-3 text-xs leading-5 text-muted-foreground">
                {compass.timeframe ? <p><strong className="text-foreground">Timeframe:</strong> {compass.timeframe}</p> : null}
                {compass.perspective ? <p><strong className="text-foreground">Viewpoint:</strong> {compass.perspective}</p> : null}
                {compass.evidence.map((evidence, index) => <blockquote key={index} className="rounded-lg border-l-2 border-primary/40 bg-black/15 px-3 py-2">
                  <p className="whitespace-pre-wrap break-words">“{evidence.quote}”</p>
                  <footer className="mt-1 text-[10px]">Manuscript Passage · {compassEvidenceLabel(evidence.axes, evidence.perspective)}</footer>
                </blockquote>)}
                {compass.retrievalRequests.length ? <div><p className="font-medium text-foreground">Still Worth Checking</p><ul className="mt-1 list-disc space-y-1 pl-4">{compass.retrievalRequests.map((request, index) => <li key={index} className="break-words">{request}</li>)}</ul></div> : null}
              </div>
            </details> : null}
            <Button type="button" size="sm" variant="outline" className="mt-4 w-full" onClick={() => setAxisExpanded((current) => !current)}><Shield className="h-3.5 w-3.5" />{axisExpanded ? "Close Editor" : hasInterpretedAxis ? "Edit Estimate" : "Set Owner Position Manually"}</Button>
            {axisExpanded ? <form className="mt-4 space-y-4 border-t border-white/8 pt-4" onSubmit={saveAxis}>
              <p className="text-xs leading-5 text-muted-foreground">Adjust this interpretation whenever the evidence or your understanding changes. Storyhold preserves the original estimate for reference.</p>
              <div><div className="flex justify-between text-sm"><label htmlFor="economic">Economic axis</label><span className="font-mono text-primary">{economic}</span></div><input id="economic" type="range" min="-100" max="100" value={economic} onChange={(event) => setEconomic(Number(event.target.value))} className="mt-2 w-full accent-[hsl(var(--primary))]" /><div className="flex justify-between text-[10px] uppercase text-muted-foreground"><span>Collectivist</span><span>Market</span></div></div>
              <div><div className="flex justify-between text-sm"><label htmlFor="authority">Authority axis</label><span className="font-mono text-primary">{authority}</span></div><input id="authority" type="range" min="-100" max="100" value={authority} onChange={(event) => setAuthority(Number(event.target.value))} className="mt-2 w-full accent-[hsl(var(--primary))]" /><div className="flex justify-between text-[10px] uppercase text-muted-foreground"><span>Libertarian</span><span>Authoritarian</span></div></div>
              <div><label htmlFor="axis-label" className="text-sm font-medium">Position label</label><Input id="axis-label" value={axisLabel} onChange={(event) => setAxisLabel(event.target.value)} maxLength={120} className="mt-2" /></div>
              <div><label htmlFor="axis-reason" className="text-sm font-medium">Reason for this position</label><Textarea id="axis-reason" value={axisRationale} onChange={(event) => setAxisRationale(event.target.value)} maxLength={1000} rows={3} className="mt-2" /></div>
              <Button type="submit" disabled={saving} className="w-full rounded-xl">{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}Confirm position</Button>
            </form> : null}
          </Card>

          <details className="group rounded-2xl border border-white/8 bg-white/[0.025]">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3"><span className="flex items-center gap-2 font-serif text-lg font-bold"><BookOpen className="h-4 w-4 text-primary" />Evidence trail</span><span className="text-xs text-muted-foreground">{character.evidence.length} passages</span></summary>
            {character.evidence.length ? <div className="space-y-2 border-t border-white/8 px-3 py-3">{character.evidence.map((evidence, index) => {
              const presentation = evidencePresentation(evidence);
              return <blockquote key={`${presentation.key}-${index}`} className="rounded-lg border-l-2 border-primary/50 bg-black/15 p-3 text-xs leading-5 text-muted-foreground">“{presentation.quote}”<footer className="mt-1.5 font-mono text-[9px] text-muted-foreground/70">{presentation.citation}</footer></blockquote>;
            })}<p className="px-1 pt-1 text-[11px] leading-5 text-muted-foreground"><Brain className="mr-1 inline h-3 w-3 text-primary" />Estimates retain confidence and do not become immutable canon merely because an AI proposed them.</p></div> : <p className="border-t border-white/8 px-4 py-3 text-sm leading-6 text-muted-foreground">Storyhold has identified this character, but the current record has no cited passage yet. Premium Deep Reading can strengthen the dossier.</p>}
          </details>
        </div>
      </div>
    </ProfileFrame>
  );
}
