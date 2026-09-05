import { useEffect, useMemo, useState } from "react";
import {
  ArchiveRestore,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  GitMerge,
  Link2,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import {
  createWorldEntity,
  createWorldEntityRelations,
  createWorldEntityRule,
  deleteWorldEntity,
  deleteWorldEntityRelation,
  deleteWorldEntityRule,
  mergeWorldEntities,
  undoWorldEntityMerge,
  updateWorldEntity,
  type EvidenceReference,
  type WorldDetail,
  type WorldEntity,
  type WorldEntityRelation,
  type WorldEntityRelationType,
  type WorldEntityRule,
  type WorldEntityType,
} from "@/lib/storyholdApi";
import {
  worldEntityDossierHref,
  worldEntityFilterFromSearch,
} from "@/lib/worldEntityNavigation";

function ContextEvidenceBadge({
  evidence,
  sourceTitles,
}: {
  evidence: EvidenceReference[];
  sourceTitles: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const passages = useMemo(() => {
    const seen = new Set<string>();
    return evidence.flatMap((item) => {
      const quote = item.quote.trim();
      if (!quote) return [];
      const key = `${item.sourceId}\u0000${quote}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{
        ...item,
        quote,
        sourceTitle: sourceTitles.get(item.sourceId) ?? "Uploaded Manuscript",
      }];
    });
  }, [evidence, sourceTitles]);

  if (!passages.length) return null;

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={160} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/[0.05] px-2 py-1 text-[10px] font-medium text-foreground/80 transition-colors hover:border-primary/35 hover:bg-primary/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          aria-label={`Read ${passages.length} cited passage${passages.length === 1 ? "" : "s"}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          <BookOpen className="h-3 w-3 text-primary" />
          {passages.length} Cited Passage{passages.length === 1 ? "" : "s"}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        className="max-h-[min(28rem,70vh)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border-primary/20 bg-background/95 p-4 shadow-2xl backdrop-blur-xl"
      >
        <p className="font-serif text-base font-bold text-foreground">From the Manuscript</p>
        <div className="mt-3 space-y-4">
          {passages.map((passage, index) => (
            <figure key={`${passage.sourceId}-${passage.chunkId}-${index}`} className="border-l-2 border-primary/30 pl-3">
              <blockquote className="whitespace-pre-wrap text-xs leading-5 text-foreground/85">{passage.quote}</blockquote>
              <figcaption className="mt-2 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
                <BookOpen className="h-3 w-3 shrink-0 text-primary" />
                <span>
                  {[passage.sourceTitle, passage.sectionTitle, passage.perspective ? `POV: ${passage.perspective}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

const categories: Array<{
  value: WorldEntityType;
  label: string;
  plural: string;
  help: string;
}> = [
  { value: "character", label: "Person", plural: "People", help: "Named people and playable characters" },
  { value: "place", label: "Place", plural: "Places", help: "Locations, regions, structures, and worlds" },
  { value: "faction", label: "Faction", plural: "Factions", help: "Organizations, polities, teams, and movements" },
  { value: "institution", label: "Institution", plural: "Institutions", help: "Corporations, courts, churches, academies, agencies, and durable organizations" },
  { value: "government", label: "Government", plural: "Governments", help: "Regimes, states, councils, ministries, and formal systems of rule" },
  { value: "power_structure", label: "Power structure", plural: "Power structures", help: "Hierarchies, collective minds, networks, and systems through which authority flows" },
  { value: "species", label: "Species", plural: "Species", help: "Peoples, species, and biological lineages" },
  { value: "creature", label: "Creature", plural: "Creatures", help: "Named creatures, classifications, subtypes, and lifecycle stages" },
  { value: "technology", label: "Technology", plural: "Technology", help: "Scientific fields, engineered systems, methods, and technological capabilities" },
  { value: "vehicle", label: "Vehicle", plural: "Vehicles", help: "Named and classified land, sea, air, space, and other transport" },
  { value: "device", label: "Device", plural: "Devices", help: "Tools, machines, artifacts, equipment, and named mechanisms" },
  { value: "weapon", label: "Weapon", plural: "Weapons", help: "Named weapons, weapon classes, armaments, and destructive systems" },
  { value: "power", label: "Power", plural: "Powers", help: "Abilities, gifts, techniques, and unusual capabilities" },
  { value: "title", label: "Title", plural: "Titles", help: "Ranks, offices, honors, and statuses" },
  { value: "cultural_reference", label: "Cultural Reference", plural: "Cultural References", help: "Outside fiction, history, religion, media, and mythology invoked by the manuscript" },
  { value: "term", label: "Term or Moniker", plural: "Terms and Monikers", help: "Forms of address, signals, idioms, calls, and recurring vocabulary that do not identify one standalone person" },
  { value: "ambiguous", label: "Needs Sorting", plural: "Needs Sorting", help: "Names and concepts whose category is not established" },
];

const relationOptions: Array<{ value: WorldEntityRelationType; label: string; target?: WorldEntityType[] }> = [
  { value: "member_of", label: "Member of", target: ["faction", "institution"] },
  { value: "participates_in", label: "Participates in", target: ["government", "power_structure"] },
  { value: "species_of", label: "Species is", target: ["species"] },
  { value: "subspecies_of", label: "Subspecies of", target: ["species"] },
  { value: "subtype_of", label: "Subtype of", target: ["species", "creature"] },
  { value: "lifecycle_stage_of", label: "Lifecycle stage of", target: ["species"] },
  { value: "has_power", label: "Displays power", target: ["power"] },
  { value: "has_form", label: "Has creature form", target: ["creature"] },
  { value: "holds_title", label: "Holds title", target: ["title"] },
  { value: "child_of", label: "Child of", target: ["character"] },
  { value: "sibling_of", label: "Sibling of", target: ["character"] },
  { value: "spouse_of", label: "Spouse or partner of", target: ["character"] },
  { value: "friend_of", label: "Friend of", target: ["character"] },
  { value: "best_friend_of", label: "Best friend of", target: ["character"] },
  { value: "leads", label: "Leads" },
  { value: "governs", label: "Governs" },
  { value: "controlled_by", label: "Controlled by" },
  { value: "allied_with", label: "Allied with" },
  { value: "opposed_to", label: "Opposed to" },
  { value: "located_in", label: "Located in", target: ["place"] },
  { value: "part_of", label: "Part of" },
  { value: "created_by", label: "Created by" },
  { value: "related_to", label: "Related to" },
];

type ConnectionAction = {
  value: string;
  label: string;
  relationType: WorldEntityRelationType;
  direction: "outgoing" | "incoming";
  candidateTypes?: WorldEntityType[];
  defaultStatus?: WorldEntityRelation["status"];
};

function connectionActionsFor(entity: WorldEntity): ConnectionAction[] {
  const related: ConnectionAction = { value: "related", label: "Add another connection", relationType: "related_to", direction: "outgoing" };
  switch (entity.entityType) {
    case "character":
      return [
        { value: "faction", label: "Add to faction", relationType: "member_of", direction: "outgoing", candidateTypes: ["faction"] },
        { value: "institution", label: "Add to institution", relationType: "member_of", direction: "outgoing", candidateTypes: ["institution"] },
        { value: "government", label: "Add to government", relationType: "participates_in", direction: "outgoing", candidateTypes: ["government"] },
        { value: "power-structure", label: "Add to power structure", relationType: "participates_in", direction: "outgoing", candidateTypes: ["power_structure"] },
        { value: "species", label: "Assign species", relationType: "species_of", direction: "outgoing", candidateTypes: ["species"] },
        { value: "power", label: "Add power", relationType: "has_power", direction: "outgoing", candidateTypes: ["power"] },
        { value: "creature-form", label: "Add manifested creature form", relationType: "has_form", direction: "outgoing", candidateTypes: ["creature"] },
        { value: "title", label: "Add title", relationType: "holds_title", direction: "outgoing", candidateTypes: ["title"] },
        { value: "vehicle", label: "Add vehicle", relationType: "related_to", direction: "outgoing", candidateTypes: ["vehicle"] },
        { value: "device", label: "Add device or equipment", relationType: "related_to", direction: "outgoing", candidateTypes: ["device"] },
        { value: "weapon", label: "Add weapon", relationType: "related_to", direction: "outgoing", candidateTypes: ["weapon"] },
        { value: "technology", label: "Add technology", relationType: "related_to", direction: "outgoing", candidateTypes: ["technology"] },
        { value: "location", label: "Add location", relationType: "located_in", direction: "outgoing", candidateTypes: ["place"] },
        { value: "ally", label: "Add ally", relationType: "allied_with", direction: "outgoing", candidateTypes: ["character", "faction"] },
        { value: "opponent", label: "Add opponent", relationType: "opposed_to", direction: "outgoing", candidateTypes: ["character", "faction"] },
        { value: "parent", label: "Add parent", relationType: "child_of", direction: "outgoing", candidateTypes: ["character"] },
        { value: "child", label: "Add child", relationType: "child_of", direction: "incoming", candidateTypes: ["character"] },
        { value: "sibling", label: "Add sibling", relationType: "sibling_of", direction: "outgoing", candidateTypes: ["character"] },
        { value: "spouse", label: "Add spouse or partner", relationType: "spouse_of", direction: "outgoing", candidateTypes: ["character"] },
        { value: "friend", label: "Add friend", relationType: "friend_of", direction: "outgoing", candidateTypes: ["character"] },
        { value: "best-friend", label: "Add best friend", relationType: "best_friend_of", direction: "outgoing", candidateTypes: ["character"] },
        { value: "leader", label: "Assign as leader of", relationType: "leads", direction: "outgoing", candidateTypes: ["faction", "institution", "government", "power_structure"] },
        related,
      ];
    case "creature":
      return [
        { value: "faction", label: "Add to faction", relationType: "member_of", direction: "outgoing", candidateTypes: ["faction"] },
        { value: "species", label: "Assign species", relationType: "species_of", direction: "outgoing", candidateTypes: ["species"] },
        { value: "subtype", label: "Assign creature or species subtype", relationType: "subtype_of", direction: "outgoing", candidateTypes: ["species", "creature"] },
        { value: "power", label: "Add power", relationType: "has_power", direction: "outgoing", candidateTypes: ["power"] },
        { value: "manifested-by", label: "Add person who manifests this form", relationType: "has_form", direction: "incoming", candidateTypes: ["character"] },
        { value: "title", label: "Add title", relationType: "holds_title", direction: "outgoing", candidateTypes: ["title"] },
        { value: "location", label: "Add location", relationType: "located_in", direction: "outgoing", candidateTypes: ["place"] },
        { value: "power-structure", label: "Add to power structure", relationType: "participates_in", direction: "outgoing", candidateTypes: ["power_structure"] },
        related,
      ];
    case "faction":
      return [
        { value: "member", label: "Add known member", relationType: "member_of", direction: "incoming", candidateTypes: ["character", "creature", "species"] },
        { value: "former-member", label: "Add former member", relationType: "member_of", direction: "incoming", candidateTypes: ["character", "creature", "species"], defaultStatus: "former" },
        { value: "base", label: "Add base or territory", relationType: "located_in", direction: "outgoing", candidateTypes: ["place"] },
        { value: "parent", label: "Add parent organization", relationType: "part_of", direction: "outgoing", candidateTypes: ["faction"] },
        { value: "leader", label: "Add leader", relationType: "leads", direction: "incoming", candidateTypes: ["character", "title"] },
        { value: "institution", label: "Add supervising institution", relationType: "part_of", direction: "outgoing", candidateTypes: ["institution"] },
        { value: "government", label: "Add governing body", relationType: "controlled_by", direction: "outgoing", candidateTypes: ["government", "institution", "character", "title"] },
        { value: "power-structure", label: "Add power structure", relationType: "participates_in", direction: "outgoing", candidateTypes: ["power_structure"] },
        { value: "ally", label: "Add allied faction", relationType: "allied_with", direction: "outgoing", candidateTypes: ["faction"] },
        { value: "opponent", label: "Add opposed faction", relationType: "opposed_to", direction: "outgoing", candidateTypes: ["faction"] },
        related,
      ];
    case "species":
      return [
        { value: "member", label: "Add named person or creature", relationType: "species_of", direction: "incoming", candidateTypes: ["character", "creature"] },
        { value: "subspecies", label: "Add known subspecies", relationType: "subspecies_of", direction: "incoming", candidateTypes: ["species"] },
        { value: "subtype", label: "Add known creature subtype", relationType: "subtype_of", direction: "incoming", candidateTypes: ["creature"] },
        { value: "lifecycle", label: "Add lifecycle stage", relationType: "lifecycle_stage_of", direction: "incoming", candidateTypes: ["creature"] },
        { value: "power", label: "Add observed power", relationType: "has_power", direction: "outgoing", candidateTypes: ["power"] },
        { value: "power-structure", label: "Add collective or governing structure", relationType: "participates_in", direction: "outgoing", candidateTypes: ["power_structure", "government"] },
        related,
      ];
    case "institution":
      return [
        { value: "member", label: "Add member", relationType: "member_of", direction: "incoming", candidateTypes: ["character", "creature", "faction"] },
        { value: "former-member", label: "Add former member", relationType: "member_of", direction: "incoming", candidateTypes: ["character", "creature", "faction"], defaultStatus: "former" },
        { value: "leader", label: "Add leader or director", relationType: "leads", direction: "incoming", candidateTypes: ["character", "title"] },
        { value: "government", label: "Add governing authority", relationType: "controlled_by", direction: "outgoing", candidateTypes: ["government", "character", "title"] },
        { value: "parent", label: "Add parent institution", relationType: "part_of", direction: "outgoing", candidateTypes: ["institution", "government"] },
        { value: "location", label: "Add headquarters or jurisdiction", relationType: "located_in", direction: "outgoing", candidateTypes: ["place"] },
        related,
      ];
    case "government":
      return [
        { value: "leader", label: "Add ruler or leader", relationType: "leads", direction: "incoming", candidateTypes: ["character", "title"] },
        { value: "governed", label: "Add what it governs", relationType: "governs", direction: "outgoing", candidateTypes: ["place", "species", "faction", "institution"] },
        { value: "institution", label: "Add institution within government", relationType: "part_of", direction: "incoming", candidateTypes: ["institution"] },
        { value: "structure", label: "Add governing power structure", relationType: "controlled_by", direction: "outgoing", candidateTypes: ["power_structure", "institution", "character", "title"] },
        { value: "territory", label: "Add seat or territory", relationType: "located_in", direction: "outgoing", candidateTypes: ["place"] },
        related,
      ];
    case "power_structure":
      return [
        { value: "participant", label: "Add participant", relationType: "participates_in", direction: "incoming", candidateTypes: ["character", "creature", "species", "faction", "institution", "government"] },
        { value: "controller", label: "Add controller or ruling body", relationType: "controlled_by", direction: "outgoing", candidateTypes: ["character", "title", "institution", "government"] },
        { value: "leader", label: "Add leader", relationType: "leads", direction: "incoming", candidateTypes: ["character", "title"] },
        { value: "substructure", label: "Add contained structure", relationType: "part_of", direction: "incoming", candidateTypes: ["power_structure", "institution"] },
        related,
      ];
    case "power":
      return [
        { value: "observed", label: "Add person, creature, or species observed using it", relationType: "has_power", direction: "incoming", candidateTypes: ["character", "creature", "species"] },
        related,
      ];
    case "technology":
      return [
        { value: "device", label: "Add device using it", relationType: "part_of", direction: "incoming", candidateTypes: ["device"] },
        { value: "vehicle", label: "Add vehicle using it", relationType: "part_of", direction: "incoming", candidateTypes: ["vehicle"] },
        { value: "weapon", label: "Add weapon using it", relationType: "part_of", direction: "incoming", candidateTypes: ["weapon"] },
        { value: "creator", label: "Add creator or developer", relationType: "created_by", direction: "outgoing", candidateTypes: ["character", "faction", "institution", "government"] },
        related,
      ];
    case "vehicle":
      return [
        { value: "technology", label: "Add underlying technology", relationType: "part_of", direction: "outgoing", candidateTypes: ["technology"] },
        { value: "device", label: "Add installed device", relationType: "part_of", direction: "incoming", candidateTypes: ["device"] },
        { value: "weapon", label: "Add mounted weapon", relationType: "part_of", direction: "incoming", candidateTypes: ["weapon"] },
        { value: "creator", label: "Add creator or manufacturer", relationType: "created_by", direction: "outgoing", candidateTypes: ["character", "faction", "institution", "government"] },
        { value: "location", label: "Add current or usual location", relationType: "located_in", direction: "outgoing", candidateTypes: ["place"] },
        related,
      ];
    case "device":
      return [
        { value: "technology", label: "Add underlying technology", relationType: "part_of", direction: "outgoing", candidateTypes: ["technology"] },
        { value: "vehicle", label: "Install in vehicle", relationType: "part_of", direction: "outgoing", candidateTypes: ["vehicle"] },
        { value: "creator", label: "Add creator or manufacturer", relationType: "created_by", direction: "outgoing", candidateTypes: ["character", "faction", "institution", "government"] },
        { value: "location", label: "Add location", relationType: "located_in", direction: "outgoing", candidateTypes: ["place"] },
        related,
      ];
    case "weapon":
      return [
        { value: "technology", label: "Add underlying technology", relationType: "part_of", direction: "outgoing", candidateTypes: ["technology"] },
        { value: "vehicle", label: "Mount on vehicle", relationType: "part_of", direction: "outgoing", candidateTypes: ["vehicle"] },
        { value: "creator", label: "Add creator or manufacturer", relationType: "created_by", direction: "outgoing", candidateTypes: ["character", "faction", "institution", "government"] },
        { value: "location", label: "Add location", relationType: "located_in", direction: "outgoing", candidateTypes: ["place"] },
        related,
      ];
    case "title":
      return [
        { value: "holder", label: "Add current holder", relationType: "holds_title", direction: "incoming", candidateTypes: ["character", "creature"], defaultStatus: "active" },
        { value: "former-holder", label: "Add former holder", relationType: "holds_title", direction: "incoming", candidateTypes: ["character", "creature"], defaultStatus: "former" },
        { value: "leadership", label: "Add body led by this office", relationType: "leads", direction: "outgoing", candidateTypes: ["faction", "institution", "government", "power_structure"] },
        related,
      ];
    case "place":
      return [
        { value: "located", label: "Add person, group, creature, vehicle, device, weapon, or place found here", relationType: "located_in", direction: "incoming", candidateTypes: ["character", "faction", "creature", "species", "vehicle", "device", "weapon", "place"] },
        { value: "contained", label: "Add contained place", relationType: "part_of", direction: "incoming", candidateTypes: ["place"] },
        related,
      ];
    default:
      return [related];
  }
}

function connectionButtonLabel(entity: WorldEntity) {
  if (entity.entityType === "character") return "Add family, affiliation, power, or title";
  if (entity.entityType === "faction") return "Add a known member or alliance";
  if (entity.entityType === "institution") return "Add members, leaders, or authority";
  if (entity.entityType === "government") return "Add rulers, institutions, or jurisdiction";
  if (entity.entityType === "power_structure") return "Add participants or controllers";
  if (entity.entityType === "species") return "Add a member, subtype, or lifecycle stage";
  if (entity.entityType === "technology") return "Add implementations or creators";
  if (entity.entityType === "vehicle") return "Add systems, weapons, or manufacturer";
  if (entity.entityType === "device") return "Add technology, installation, or creator";
  if (entity.entityType === "weapon") return "Add technology, mounting, or creator";
  if (entity.entityType === "power") return "Add where this power is observed";
  if (entity.entityType === "title") return "Add a current or former holder";
  if (entity.entityType === "place") return "Add who or what is found here";
  return "Add a connection";
}

type Filter = "all" | "hidden" | WorldEntityType;
type Sort = "mentions" | "alphabetical" | "recent";
type ManualEntityType = Exclude<WorldEntityType, "ambiguous">;

const manualCategories = categories.filter(
  (category): category is typeof category & { value: ManualEntityType } => category.value !== "ambiguous",
);

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

function mentionLabel(entity: WorldEntity, includeSources: boolean) {
  if (entity.mentionCountStatus === "exact" || entity.mentionCount > 0) {
    const sourceLabel = includeSources
      ? ` in ${formatNumber(entity.mentionSourceCount)} source${entity.mentionSourceCount === 1 ? "" : "s"}`
      : "";
    return `${formatNumber(entity.mentionCount)} mention${entity.mentionCount === 1 ? "" : "s"}${sourceLabel}`;
  }
  if (entity.mentionCountStatus === "manual") return "Added manually";
  if (entity.mentionCountStatus === "derived") {
    const citedPassages = new Set(entity.evidence.map((item) => item.chunkId).filter(Boolean)).size;
    return citedPassages > 0
      ? `Derived from ${formatNumber(citedPassages)} cited passage${citedPassages === 1 ? "" : "s"}`
      : "Evidence-derived concept";
  }
  return "No exact wording found in the indexed sources";
}

function aliasLabel(entity: WorldEntity) {
  return entity.entityType === "character" ? "AKA" : "Also Indexed As";
}

function category(value: WorldEntityType) {
  return categories.find((candidate) => candidate.value === value) ?? categories[categories.length - 1]!;
}

function relationLabel(value: WorldEntityRelationType) {
  return relationOptions.find((candidate) => candidate.value === value)?.label ?? value.replaceAll("_", " ");
}

function requestConfirmation(input: {
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => Promise<unknown>;
}) {
  const toastId = toast(input.title, {
    description: input.description,
    duration: 12_000,
    action: {
      label: input.confirmLabel ?? "Confirm",
      onClick: () => {
        toast.dismiss(toastId);
        void input.onConfirm();
      },
    },
    cancel: { label: "Cancel", onClick: () => toast.dismiss(toastId) },
  });
}

function reverseHeading(entity: WorldEntity, relation: WorldEntityRelation) {
  if (relation.relationType === "member_of" && entity.entityType === "faction") {
    return relation.status === "former" ? "Former members" : "Known members";
  }
  if (relation.relationType === "member_of" && entity.entityType === "institution") {
    return relation.status === "former" ? "Former members" : "Known members";
  }
  if (relation.relationType === "participates_in" && ["government", "power_structure"].includes(entity.entityType)) return "Participants";
  if (relation.relationType === "leads" && ["faction", "institution", "government", "power_structure"].includes(entity.entityType)) return relation.status === "former" ? "Former leaders" : "Leadership";
  if (relation.relationType === "governs" && entity.entityType !== "government") return "Governed by";
  if (relation.relationType === "controlled_by") return "Controls this structure";
  if (relation.relationType === "child_of" && entity.entityType === "character") return "Children";
  if (relation.relationType === "sibling_of" && entity.entityType === "character") return "Siblings";
  if (relation.relationType === "spouse_of" && entity.entityType === "character") return "Spouses and partners";
  if (["friend_of", "best_friend_of"].includes(relation.relationType) && entity.entityType === "character") return "Friends";
  if (relation.relationType === "species_of" && entity.entityType === "species") return "Named members and creatures";
  if (["subspecies_of", "subtype_of"].includes(relation.relationType) && entity.entityType === "species") return "Known subtypes";
  if (relation.relationType === "lifecycle_stage_of" && entity.entityType === "species") return "Known lifecycle stages";
  if (relation.relationType === "has_power" && entity.entityType === "power") return "Observed in";
  if (relation.relationType === "has_form" && entity.entityType === "creature") return "Manifested by";
  if (relation.relationType === "holds_title" && entity.entityType === "title") {
    return relation.status === "former" ? "Former holders" : "Current holders";
  }
  return `Linked by ${relationLabel(relation.relationType).toLocaleLowerCase()}`;
}

type AtAGlanceConnection = {
  key: string;
  label: string;
  name: string;
  status: WorldEntityRelation["status"];
};

function outgoingConnectionLabel(relation: WorldEntityRelation) {
  switch (relation.relationType) {
    case "member_of": return relation.targetType === "institution" ? "Institution" : "Faction";
    case "participates_in": return "Participates in";
    case "species_of": return "Species";
    case "subspecies_of": return "Parent species";
    case "subtype_of": return "Subtype of";
    case "lifecycle_stage_of": return "Lifecycle of";
    case "has_power": return "Power";
    case "has_form": return "Creature form";
    case "holds_title": return "Title";
    case "child_of": return "Child of";
    case "sibling_of": return "Sibling";
    case "spouse_of": return "Spouse / partner";
    case "friend_of": return "Friend";
    case "best_friend_of": return "Best friend";
    case "leads": return "Leads";
    case "governs": return "Governs";
    case "controlled_by": return "Controlled by";
    case "located_in": return "Location";
    case "allied_with": return "Ally";
    case "opposed_to": return "Opposes";
    case "part_of": return "Part of";
    case "created_by": return "Created by";
    default: return "Related";
  }
}

function incomingConnectionLabel(entity: WorldEntity, relation: WorldEntityRelation) {
  if (relation.relationType === "member_of" && entity.entityType === "faction") return relation.status === "former" ? "Former member" : "Member";
  if (relation.relationType === "member_of" && entity.entityType === "institution") return relation.status === "former" ? "Former member" : "Member";
  if (relation.relationType === "participates_in") return "Participant";
  if (relation.relationType === "child_of" && entity.entityType === "character") return "Child";
  if (relation.relationType === "sibling_of" && entity.entityType === "character") return "Sibling";
  if (relation.relationType === "spouse_of" && entity.entityType === "character") return "Spouse / partner";
  if (relation.relationType === "friend_of" && entity.entityType === "character") return "Friend";
  if (relation.relationType === "best_friend_of" && entity.entityType === "character") return "Best friend";
  if (relation.relationType === "leads") return relation.status === "former" ? "Former leader" : "Leader";
  if (relation.relationType === "governs") return "Governed by";
  if (relation.relationType === "controlled_by") return "Controls";
  if (relation.relationType === "species_of" && entity.entityType === "species") return "Named member";
  if (relation.relationType === "subspecies_of" && entity.entityType === "species") return "Subspecies";
  if (relation.relationType === "subtype_of") return "Subtype";
  if (relation.relationType === "lifecycle_stage_of" && entity.entityType === "species") return "Lifecycle stage";
  if (relation.relationType === "has_power" && entity.entityType === "power") return "Observed in";
  if (relation.relationType === "has_form" && entity.entityType === "creature") return "Manifested by";
  if (relation.relationType === "holds_title" && entity.entityType === "title") return relation.status === "former" ? "Former holder" : "Holder";
  if (relation.relationType === "located_in" && entity.entityType === "place") return "Found here";
  return "Linked from";
}

function atAGlanceConnections(entity: WorldEntity, outgoing: WorldEntityRelation[], incoming: WorldEntityRelation[]) {
  const direct: AtAGlanceConnection[] = outgoing.map((relation) => ({
    key: relation.id,
    label: outgoingConnectionLabel(relation),
    name: relation.targetName,
    status: relation.status,
  }));
  const reverse: AtAGlanceConnection[] = incoming.map((relation) => ({
    key: relation.id,
    label: incomingConnectionLabel(entity, relation),
    name: relation.sourceName,
    status: relation.status,
  }));
  return [...direct, ...reverse];
}

export function EntityConnectionEditor({
  entity,
  entities,
  busy,
  onCreate,
  actionValues,
  buttonLabel,
}: {
  entity: WorldEntity;
  entities: WorldEntity[];
  busy: boolean;
  actionValues?: string[];
  buttonLabel?: string;
  onCreate: (input: {
    connections: Array<{
      sourceEntityId: string;
      targetEntityId: string;
      relationType: WorldEntityRelationType;
      status: WorldEntityRelation["status"];
      summary: string;
      validFromLabel: string;
      validUntilLabel: string;
    }>;
    actionLabel: string;
    onSaved: () => void;
  }) => void;
}) {
  const allActions = connectionActionsFor(entity);
  const actions = actionValues?.length
    ? allActions.filter((action) => actionValues.includes(action.value))
    : allActions;
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [actionValue, setActionValue] = useState(actions[0]?.value ?? "related");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [candidateQuery, setCandidateQuery] = useState("");
  const [status, setStatus] = useState<WorldEntityRelation["status"]>("active");
  const [summary, setSummary] = useState("");
  const [validFromLabel, setValidFromLabel] = useState("");
  const [validUntilLabel, setValidUntilLabel] = useState("");
  const action = actions.find((candidate) => candidate.value === actionValue) ?? actions[0]!;
  const candidates = entities
    .filter((candidate) => candidate.id !== entity.id && candidate.pullStatus === "active")
    .filter((candidate) => !action.candidateTypes || action.candidateTypes.includes(candidate.entityType))
    .sort((left, right) => left.name.localeCompare(right.name));
  const visibleCandidates = candidates.filter((candidate) => {
    const needle = candidateQuery.trim().toLocaleLowerCase();
    return !needle || `${candidate.name} ${candidate.aliases.join(" ")}`.toLocaleLowerCase().includes(needle);
  });
  const selectedCandidates = candidates.filter((candidate) => selectedIds.includes(candidate.id));
  const pendingConnections = selectedIds.map((candidateId) => ({
    sourceEntityId: action.direction === "outgoing" ? entity.id : candidateId,
    targetEntityId: action.direction === "outgoing" ? candidateId : entity.id,
    relationType: action.relationType,
    status,
    summary,
    validFromLabel,
    validUntilLabel,
  }));

  function toggleCandidate(candidateId: string) {
    setSelectedIds((current) => current.includes(candidateId) ? current.filter((id) => id !== candidateId) : [...current, candidateId]);
  }

  function closeEditor() {
    setOpen(false);
    setConfirmOpen(false);
    setSelectedIds([]);
    setCandidateQuery("");
    setSummary("");
    setValidFromLabel("");
    setValidUntilLabel("");
  }

  if (!open) {
    return <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}><Link2 className="h-3.5 w-3.5" /> {buttonLabel ?? connectionButtonLabel(entity)}</Button>;
  }
  return (
    <div className="mt-3 rounded-xl border border-primary/20 bg-primary/[0.035] p-3">
      <div>
        <p className="font-semibold">Connect {entity.name}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">Choose the plain-language action. Storyhold keeps the correct canonical direction behind the scenes.</p>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1.3fr_0.7fr]">
        <label className="text-xs font-semibold text-muted-foreground">What are you adding?
          <select value={actionValue} onChange={(event) => { const next = actions.find((candidate) => candidate.value === event.target.value) ?? actions[0]!; setActionValue(next.value); setSelectedIds([]); setCandidateQuery(""); setStatus(next.defaultStatus ?? "active"); }} className="storyhold-select mt-1 block w-full">
            {actions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-muted-foreground">When?
          <select value={status} onChange={(event) => setStatus(event.target.value as WorldEntityRelation["status"])} className="storyhold-select mt-1 block w-full">
            <option value="active">Current / active</option><option value="former">Former</option><option value="conditional">Conditional</option><option value="disputed">Disputed</option><option value="unknown">Status unknown</option>
          </select>
        </label>
      </div>
      {!candidates.length ? <p className="mt-3 rounded-lg border border-amber-300/15 bg-amber-300/[0.04] px-3 py-2 text-xs text-amber-100">There are no matching cards yet. Add or reclassify one in the appropriate Hold section first.</p> : null}
      {candidates.length ? <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3">
        <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center"><div><p className="text-xs font-semibold text-foreground">Choose one or many Hold cards</p><p className="mt-0.5 text-[11px] text-muted-foreground">{selectedIds.length} selected</p></div><div className="flex gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => setSelectedIds((current) => [...new Set([...current, ...visibleCandidates.map((candidate) => candidate.id)])])}>Select all shown</Button><Button type="button" size="sm" variant="ghost" disabled={!selectedIds.length} onClick={() => setSelectedIds([])}>Clear</Button></div></div>
        <div className="relative mt-2"><Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={candidateQuery} onChange={(event) => setCandidateQuery(event.target.value)} placeholder="Filter matching cards" className="h-9 pl-9 text-xs" /></div>
        <div className="mt-2 max-h-60 overflow-y-auto rounded-lg border border-white/8 bg-[#151318] p-1">
          {visibleCandidates.length ? <div className="grid gap-1 sm:grid-cols-2">{visibleCandidates.map((candidate) => {
            const selected = selectedIds.includes(candidate.id);
            return <label key={candidate.id} className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors ${selected ? "border-primary/45 bg-primary/[0.09] text-foreground" : "border-transparent text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"}`}><input type="checkbox" checked={selected} onChange={() => toggleCandidate(candidate.id)} className="h-4 w-4 shrink-0 accent-[hsl(var(--primary))]" /><span className="min-w-0 flex-1 truncate font-semibold">{candidate.name}</span><span className="shrink-0 text-[9px] uppercase tracking-wide opacity-65">{category(candidate.entityType).label}</span></label>;
          })}</div> : <p className="px-3 py-5 text-center text-xs text-muted-foreground">No matching cards.</p>}
        </div>
      </div> : null}
      <Input className="mt-3 h-10 text-sm" value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="What should the Hold remember about this connection? (optional)" />
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <Input className="h-9 text-xs" value={validFromLabel} onChange={(event) => setValidFromLabel(event.target.value)} placeholder="Began when... (optional)" />
        <Input className="h-9 text-xs" value={validUntilLabel} onChange={(event) => setValidUntilLabel(event.target.value)} placeholder="Ended when... (optional)" />
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={closeEditor}>Cancel</Button>
        <Button type="button" size="sm" disabled={busy || !selectedIds.length} onClick={() => setConfirmOpen(true)}><Plus className="h-3.5 w-3.5" /> Review &amp; save {selectedIds.length || ""} connection{selectedIds.length === 1 ? "" : "s"}</Button>
      </div>
      {selectedIds.length ? <p className="mt-2 text-right text-[11px] text-muted-foreground">Nothing is saved until you confirm the centered prompt.</p> : null}
      <AlertDialog open={confirmOpen} onOpenChange={(next) => !busy && setConfirmOpen(next)}>
        <AlertDialogContent className="border-primary/35 bg-[#111014] shadow-2xl shadow-black/70 sm:max-w-lg">
          <AlertDialogHeader className="items-center text-center sm:text-center">
            <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary"><ShieldCheck className="h-6 w-6" /></div>
            <AlertDialogTitle className="font-serif text-2xl">Are you sure?</AlertDialogTitle>
            <AlertDialogDescription className="max-w-md text-center leading-6">
              You are about to {action.label.toLocaleLowerCase()} for {selectedIds.length} Hold card{selectedIds.length === 1 ? "" : "s"}. This changes canonical relationships and will be visible from both dossiers.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-48 space-y-2 overflow-y-auto rounded-xl border border-white/10 bg-black/25 p-3">
            {selectedCandidates.slice(0, 8).map((candidate) => <div key={candidate.id} className="flex items-center justify-between gap-3 text-sm"><span className="font-semibold">{action.direction === "outgoing" ? entity.name : candidate.name}</span><span className="text-primary">→</span><span className="text-right font-semibold">{action.direction === "outgoing" ? candidate.name : entity.name}</span></div>)}
            {selectedCandidates.length > 8 ? <p className="text-center text-xs text-muted-foreground">And {selectedCandidates.length - 8} more</p> : null}
          </div>
          <AlertDialogFooter className="mt-1 sm:justify-center">
            <AlertDialogCancel disabled={busy}>No, go back</AlertDialogCancel>
            <AlertDialogAction disabled={busy || !pendingConnections.length} onClick={() => onCreate({ connections: pendingConnections, actionLabel: action.label, onSaved: closeEditor })}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Yes, save {selectedIds.length}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RuleEditor({ entity, busy, onCreate }: { entity: WorldEntity; busy: boolean; onCreate: (input: { name: string; description: string; ruleKind: WorldEntityRule["ruleKind"] }) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [ruleKind, setRuleKind] = useState<WorldEntityRule["ruleKind"]>("trait");
  if (!open) return <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}><Plus className="h-3.5 w-3.5" /> Add rule</Button>;
  return (
    <div className="mt-3 rounded-xl border border-primary/20 bg-primary/[0.035] p-3">
      <div className="grid gap-2 sm:grid-cols-[0.7fr_1.3fr]">
        <select value={ruleKind} onChange={(event) => setRuleKind(event.target.value as WorldEntityRule["ruleKind"])} className="storyhold-select w-full">
          <option value="trait">Trait</option><option value="ability">Ability</option><option value="constraint">Constraint</option><option value="biological">Biological rule</option><option value="social">Social rule</option><option value="gameplay">Gameplay rule</option>
        </select>
        <Input className="h-9 text-xs" value={name} onChange={(event) => setName(event.target.value)} placeholder={`Rule name for ${entity.name}`} />
      </div>
      <Textarea className="mt-2 min-h-16 text-xs" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Describe what is consistently true, including limits or exceptions." />
      <div className="mt-3 flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button type="button" size="sm" disabled={busy || !name.trim()} onClick={() => { onCreate({ name: name.trim(), description: description.trim(), ruleKind }); setOpen(false); setName(""); setDescription(""); }}><Plus className="h-3.5 w-3.5" /> Save rule</Button></div>
    </div>
  );
}

function CardEditor({ entity, busy, onSave }: { entity: WorldEntity; busy: boolean; onSave: (input: { name: string; aliases: string[]; summary: string; details: string[] }) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(entity.name);
  const [aliases, setAliases] = useState(entity.aliases.join(", "));
  const [summary, setSummary] = useState(entity.summary);
  const [details, setDetails] = useState(entity.details.join("\n"));
  if (!open) return <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}><Pencil className="h-3.5 w-3.5" /> Edit card</Button>;
  return <div className="mt-3 rounded-xl border border-primary/20 bg-primary/[0.035] p-3"><div className="grid gap-2 sm:grid-cols-2"><label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Canonical name<Input className="mt-1 h-9 text-xs" value={name} onChange={(event) => setName(event.target.value)} /></label><label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Also known as<Input className="mt-1 h-9 text-xs" value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder="Comma separated" /></label></div><label className="mt-2 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Summary<Textarea className="mt-1 min-h-20 text-xs" value={summary} onChange={(event) => setSummary(event.target.value)} /></label><label className="mt-2 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Grounded details <span className="normal-case tracking-normal opacity-70">(one per line)</span><Textarea className="mt-1 min-h-20 text-xs" value={details} onChange={(event) => setDetails(event.target.value)} /></label><div className="mt-3 flex justify-end gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button type="button" size="sm" disabled={busy || !name.trim()} onClick={() => { onSave({ name: name.trim(), aliases: aliases.split(/[,;\n]/).map((value) => value.trim()).filter(Boolean), summary: summary.trim(), details: details.split("\n").map((value) => value.trim()).filter(Boolean) }); setOpen(false); }}><Check className="h-3.5 w-3.5" /> Save card</Button></div></div>;
}

export function WorldEntityPanel({ detail, onChanged }: { detail: WorldDetail; onChanged: () => void }) {
  const sourceTitles = useMemo(
    () => new Map(detail.sources.map((source) => [source.id, source.title])),
    [detail.sources],
  );
  const [filter, setFilter] = useState<Filter>(() => {
    if (typeof window === "undefined") return "character";
    return worldEntityFilterFromSearch(window.location.search) ?? "character";
  });
  const [sort, setSort] = useState<Sort>("mentions");
  const [query, setQuery] = useState("");
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const [visibleLimit, setVisibleLimit] = useState(12);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorldEntity | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [newType, setNewType] = useState<ManualEntityType>("character");
  const [newName, setNewName] = useState("");
  const [newAliases, setNewAliases] = useState("");
  const [newSummary, setNewSummary] = useState("");
  const [adding, setAdding] = useState(false);

  const active = detail.entities.filter((entity) => entity.pullStatus === "active");
  const deleteLinkCount = deleteTarget
    ? detail.entityRelations.filter((relation) => relation.sourceEntityId === deleteTarget.id || relation.targetEntityId === deleteTarget.id).length
    : 0;
  const deleteRuleCount = deleteTarget
    ? detail.entityRules.filter((rule) => rule.entityId === deleteTarget.id).length
    : 0;
  const counts = useMemo(() => {
    const result = Object.fromEntries(["all", "hidden", ...categories.map((item) => item.value)].map((key) => [key, 0])) as Record<Filter, number>;
    result.all = active.length;
    result.hidden = detail.entities.filter((entity) => entity.pullStatus === "do_not_pull").length;
    for (const entity of active) result[entity.entityType] += 1;
    return result;
  }, [active, detail.entities]);

  const matching = detail.entities
    .filter((entity) => filter === "hidden" ? entity.pullStatus === "do_not_pull" : entity.pullStatus === "active" && (filter === "all" || entity.entityType === filter))
    .filter((entity) => {
      const needle = query.trim().toLocaleLowerCase();
      return !needle || `${entity.name} ${entity.aliases.join(" ")} ${entity.summary}`.toLocaleLowerCase().includes(needle);
    })
    .sort((left, right) => sort === "alphabetical" ? left.name.localeCompare(right.name) : sort === "recent" ? right.updatedAt.localeCompare(left.updatedAt) : right.mentionCount - left.mentionCount || left.name.localeCompare(right.name));

  const groups = useMemo(() => {
    if (filter === "all") return categories.map((item) => ({ ...item, entities: matching.filter((entity) => entity.entityType === item.value).slice(0, visibleLimit) })).filter((group) => group.entities.length);
    const item = filter === "hidden" ? { value: "ambiguous" as const, label: "Hidden", plural: "Hidden from retrieval", help: "Records marked do not pull" } : category(filter);
    return [{ ...item, entities: matching.slice(0, visibleLimit) }];
  }, [filter, matching, visibleLimit]);

  useEffect(() => setVisibleLimit(12), [filter, query, sort]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const requestedFilter = worldEntityFilterFromSearch(window.location.search);
    if (requestedFilter) setFilter(requestedFilter);
    const focusId = new URLSearchParams(window.location.search).get("focus");
    if (!focusId) return;
    const sortedLeads = detail.entities
      .filter((entity) => entity.pullStatus === "active" && entity.entityType === "ambiguous")
      .sort((left, right) => right.mentionCount - left.mentionCount || left.name.localeCompare(right.name));
    const focusIndex = sortedLeads.findIndex((entity) => entity.id === focusId);
    if (focusIndex >= 0) setVisibleLimit((current) => Math.max(current, focusIndex + 1));
    const timeout = window.setTimeout(() => {
      document.getElementById(`hold-card-${focusId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [detail.entities.length, detail.world.id]);

  function chooseFilter(nextFilter: Filter, clearQuery = true) {
    setFilter(nextFilter);
    if (clearQuery) setQuery("");
    if (typeof window === "undefined") return;
    const nextUrl = new URL(window.location.href);
    if (nextFilter === "ambiguous") nextUrl.searchParams.set("hold", "ambiguous");
    else nextUrl.searchParams.delete("hold");
    nextUrl.searchParams.delete("focus");
    window.history.replaceState({}, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
  }

  async function run(entityId: string, action: () => Promise<unknown>, success: string) {
    setBusyId(entityId);
    try { await action(); toast.success(success); onChanged(); return true; }
    catch (reason) { toast.error(reason instanceof Error ? reason.message : "The Hold could not save that change."); return false; }
    finally { setBusyId(null); }
  }

  function toggleExpanded(entityId: string) {
    setExpandedIds((current) => { const next = new Set(current); if (next.has(entityId)) next.delete(entityId); else next.add(entityId); return next; });
  }

  function toggleSection(sectionKey: string) {
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(sectionKey)) next.delete(sectionKey);
      else next.add(sectionKey);
      return next;
    });
  }

  function openLinked(entityId: string) {
    setFilter("all");
    setExpandedIds((current) => new Set(current).add(entityId));
    window.setTimeout(() => document.getElementById(`hold-card-${entityId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
  }

  function addEntity() {
    const name = newName.trim();
    if (!name) return void toast.error("Give this Hold record a name.");
    requestConfirmation({
      title: `Create ${name}'s ${category(newType).label.toLocaleLowerCase()} dossier?`,
      description: "This creates a blank, stable canonical record using only what you entered. No AI or credits are used. You can fill it in yourself or request a source review from the finished dossier.",
      confirmLabel: "Create dossier",
      onConfirm: async () => {
        setAdding(true);
        try {
          const result = await createWorldEntity({ worldId: detail.world.id, name, entityType: newType, aliases: newAliases.split(/[,;\n]/).map((alias) => alias.trim()).filter(Boolean), summary: newSummary.trim() });
          setNewName(""); setNewAliases(""); setNewSummary(""); setShowAdd(false); setFilter(newType);
          setExpandedIds((current) => new Set(current).add(result.entity.id));
          toast.success(`${name}'s dossier was created without using AI or credits.`); onChanged();
        } catch (reason) { toast.error(reason instanceof Error ? reason.message : "The Hold could not create that record."); }
        finally { setAdding(false); }
      },
    });
  }

  function classify(entity: WorldEntity, entityType: WorldEntityType) {
    if (entityType === entity.entityType) return;
    requestConfirmation({ title: `Move ${entity.name} to ${category(entityType).plural}?`, description: "Its canonical ID, evidence, rules, and links remain intact.", onConfirm: () => run(entity.id, () => updateWorldEntity({ worldId: detail.world.id, entityId: entity.id, entityType }), `${entity.name} is now filed under ${category(entityType).plural}.`) });
  }

  function suppress(entity: WorldEntity) {
    requestConfirmation({ title: `Remove ${entity.name} from the Hold?`, description: "It will be marked do not pull and ignored by story retrieval. You can restore it from Hidden.", confirmLabel: "Remove", onConfirm: () => run(entity.id, () => updateWorldEntity({ worldId: detail.world.id, entityId: entity.id, pullStatus: "do_not_pull" }), `${entity.name} will no longer be pulled into story context.`) });
  }

  function restore(entity: WorldEntity) {
    requestConfirmation({ title: `Restore ${entity.name}?`, description: "The Hold will make this card available to retrieval again.", confirmLabel: "Restore", onConfirm: () => run(entity.id, () => updateWorldEntity({ worldId: detail.world.id, entityId: entity.id, pullStatus: "active" }), `${entity.name} was restored.`) });
  }

  function merge(entity: WorldEntity) {
    const target = active.find((candidate) => candidate.id === mergeTargets[entity.id]);
    if (!target) return;
    requestConfirmation({
      title: `Merge ${entity.name} into ${target.name}?`,
      description: `${entity.name} becomes an AKA of ${target.name}. Evidence, details, rules, and links are retained under the surviving canonical card.`,
      confirmLabel: "Merge",
      onConfirm: async () => {
        setBusyId(entity.id);
        try {
          const result = await mergeWorldEntities({ worldId: detail.world.id, sourceEntityId: entity.id, targetEntityId: target.id });
          setMergeTargets((current) => ({ ...current, [entity.id]: "" })); onChanged();
          toast.success(result.summary, { duration: 12_000, action: { label: "Undo", onClick: () => void run(result.actionId, () => undoWorldEntityMerge({ worldId: detail.world.id, actionId: result.actionId }), "The merge was undone.") } });
        } catch (reason) { toast.error(reason instanceof Error ? reason.message : "Those records could not be merged."); }
        finally { setBusyId(null); }
      },
    });
  }

  function addRelations(entity: WorldEntity, input: {
    connections: Parameters<typeof createWorldEntityRelations>[0]["connections"];
    actionLabel: string;
    onSaved: () => void;
  }) {
    const pairs = input.connections.map((connection) => ({
      source: active.find((candidate) => candidate.id === connection.sourceEntityId),
      target: active.find((candidate) => candidate.id === connection.targetEntityId),
    }));
    if (!pairs.length || pairs.some((pair) => !pair.source || !pair.target)) return;
    void run(entity.id, () => createWorldEntityRelations({ worldId: detail.world.id, connections: input.connections }), `${input.connections.length} canonical connection${input.connections.length === 1 ? " was" : "s were"} saved.`).then((saved) => {
      if (saved) input.onSaved();
    });
  }

  function removeRelation(entity: WorldEntity, relation: WorldEntityRelation) {
    requestConfirmation({ title: "Remove this canonical link?", description: `${relation.sourceName} - ${relationLabel(relation.relationType)} - ${relation.targetName}. Neither card will be deleted.`, confirmLabel: "Remove link", onConfirm: () => run(entity.id, () => deleteWorldEntityRelation({ worldId: detail.world.id, relationId: relation.id }), "The link was removed.") });
  }

  function addRule(entity: WorldEntity, input: { name: string; description: string; ruleKind: WorldEntityRule["ruleKind"] }) {
    requestConfirmation({ title: `Add ${input.name} to ${entity.name}?`, description: "This becomes an explicit rule on this canonical card and will be available to retrieval.", confirmLabel: "Add rule", onConfirm: () => run(entity.id, () => createWorldEntityRule({ worldId: detail.world.id, entityId: entity.id, ...input }), `${input.name} was added to ${entity.name}.`) });
  }

  function editCard(entity: WorldEntity, input: { name: string; aliases: string[]; summary: string; details: string[] }) {
    requestConfirmation({ title: `Save changes to ${entity.name}?`, description: "The canonical ID and every link remain unchanged. Renaming the card changes only its display name.", confirmLabel: "Save card", onConfirm: () => run(entity.id, () => updateWorldEntity({ worldId: detail.world.id, entityId: entity.id, ...input }), `${input.name} was updated.`) });
  }

  return (
    <Card id="storyhold-entries" className="mt-3 scroll-mt-24 rounded-2xl border-white/8 bg-white/[0.025] p-4">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div><div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" /><h2 className="font-serif text-xl font-bold">Your Storyhold</h2></div><p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">Browse full dossiers for established people, places, groups, creatures, objects, and rules. Brief references stay as context annotations, while uncertain discoveries remain compact in Needs Sorting until you classify or merge them.</p></div>
        <div className="flex w-full flex-col gap-2 sm:flex-row lg:max-w-xl"><div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => { setQuery(event.target.value); if (event.target.value.trim()) chooseFilter("all", false); }} placeholder="Search your Storyhold" className="pl-9" /></div><Button type="button" onClick={() => setShowAdd((current) => !current)}>{showAdd ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}{showAdd ? "Close" : "Add to Storyhold"}</Button></div>
      </div>

      {showAdd ? <form className="mt-5 rounded-2xl border border-primary/20 bg-primary/[0.04] p-4" onSubmit={(event) => { event.preventDefault(); addEntity(); }}><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><h3 className="font-serif text-xl font-bold">Create a new dossier</h3><p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">Choose what it is and enter as much or as little as you know. Blank dossiers are valid. This form never calls AI or spends credits.</p></div><label className="text-xs font-semibold text-muted-foreground">What are you adding?<select value={newType} onChange={(event) => setNewType(event.target.value as ManualEntityType)} className="storyhold-select mt-1 block min-w-48">{manualCategories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label></div><div className="mt-4 grid gap-3 lg:grid-cols-2"><label className="text-xs font-semibold text-muted-foreground">Name<Input className="mt-1" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Guppie Henderson" maxLength={240} autoFocus /></label><label className="text-xs font-semibold text-muted-foreground">Also known as <span className="font-normal opacity-70">(optional)</span><Input className="mt-1" value={newAliases} onChange={(event) => setNewAliases(event.target.value)} placeholder="Translations, shorthand, alternate names" /></label></div><label className="mt-3 block text-xs font-semibold text-muted-foreground">{newType === "character" ? "Biography" : "Description"} <span className="font-normal opacity-70">(optional)</span><Textarea className="mt-1 min-h-20" value={newSummary} onChange={(event) => setNewSummary(event.target.value)} placeholder="Leave this blank or enter a grounded starting description." maxLength={4000} /></label><div className="mt-4 flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setShowAdd(false)} disabled={adding}>Cancel</Button><Button type="submit" disabled={adding || !newName.trim()}>{adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}Create blank {category(newType).label.toLocaleLowerCase()} dossier</Button></div></form> : null}

      <div className="sticky top-[108px] z-20 -mx-1 mt-3 grid gap-2 rounded-xl border border-white/8 bg-background/92 p-2 shadow-lg shadow-black/20 backdrop-blur sm:grid-cols-2 lg:top-[66px]"><select value={filter} onChange={(event) => chooseFilter(event.target.value as Filter)} aria-label="Choose Storyhold category" className="storyhold-select min-h-9 py-1.5 text-xs"><option value="all">All Storyhold entries ({counts.all})</option>{categories.map((item) => <option key={item.value} value={item.value}>{item.plural} ({counts[item.value]})</option>)}<option value="hidden">Hidden ({counts.hidden})</option></select><select value={sort} onChange={(event) => setSort(event.target.value as Sort)} aria-label="Sort Hold cards" className="storyhold-select min-h-9 py-1.5 text-xs"><option value="mentions">Most mentioned</option><option value="alphabetical">A-Z</option><option value="recent">Recently updated</option></select></div>

      {groups.length ? <div className="mt-3 space-y-2">{groups.map((group) => {
        const sectionKey = filter === "hidden" ? "hidden" : group.value;
        const collapsed = collapsedSections.has(sectionKey);
        return <section key={sectionKey} className="rounded-xl border border-white/8 bg-black/10 px-3 py-1.5"><button type="button" className="flex w-full items-center justify-between gap-3 py-1.5 text-left" onClick={() => toggleSection(sectionKey)} aria-expanded={!collapsed}><div className="flex min-w-0 items-center gap-2">{collapsed ? <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 shrink-0 text-primary" />}<h3 className="font-serif text-lg font-bold">{group.plural}</h3></div><Badge variant="outline" className="shrink-0 border-white/10">{filter === "hidden" ? counts.hidden : counts[group.value as WorldEntityType] ?? group.entities.length}</Badge></button>{!collapsed ? <><div className="mt-1 columns-1 gap-2 border-t border-white/8 pt-2 xl:columns-2">{group.entities.map((entity) => {
        const isContextAnnotation = entity.entityType === "term" || entity.entityType === "cultural_reference";
        if (isContextAnnotation) return <div
          key={entity.id}
          className="mb-2 break-inside-avoid rounded-xl border border-white/8 bg-black/20 px-3 py-3 sm:px-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-semibold">{entity.name}</h4>
            <Badge variant="outline" className="shrink-0 border-white/10 text-[9px]">{category(entity.entityType).label}</Badge>
          </div>
          <p className="mt-1 break-words text-xs leading-5 text-foreground/75">{entity.summary}</p>
          {entity.details.length ? <div className="mt-2 flex flex-wrap gap-1.5">{entity.details.map((detailLine) => <span key={detailLine} className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-muted-foreground">{detailLine}</span>)}</div> : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="text-[10px] text-muted-foreground">Context annotation · {mentionLabel(entity, true)}</p>
            <ContextEvidenceBadge evidence={entity.evidence} sourceTitles={sourceTitles} />
          </div>
        </div>;
        if (entity.entityType === "ambiguous") {
          const isBusy = busyId === entity.id;
          const mergeOptions = active
            .filter((candidate) => candidate.id !== entity.id && candidate.entityType !== "ambiguous")
            .sort((left, right) => left.name.localeCompare(right.name));
          return <article
            id={`hold-card-${entity.id}`}
            key={entity.id}
            className="mb-2 break-inside-avoid rounded-xl border border-amber-300/20 bg-amber-300/[0.035] px-3 py-3 sm:px-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="font-semibold">{entity.name}</h4>
                  <Badge variant="outline" className="shrink-0 border-amber-300/30 text-[9px] text-amber-100">Needs Sorting</Badge>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">{mentionLabel(entity, true)}{entity.aliases.length ? ` · Possible matches: ${entity.aliases.slice(0, 3).join(", ")}${entity.aliases.length > 3 ? ` +${entity.aliases.length - 3}` : ""}` : ""}</p>
              </div>
              {isBusy ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : null}
            </div>
            {entity.summary ? <p className="mt-2 line-clamp-3 text-xs leading-5 text-foreground/80">{entity.summary}</p> : null}
            {entity.details.length ? <p className="mt-2 line-clamp-2 text-[11px] leading-5 text-muted-foreground">{entity.details.slice(0, 2).join(" · ")}</p> : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ContextEvidenceBadge evidence={entity.evidence} sourceTitles={sourceTitles} />
              <span className="text-[10px] text-muted-foreground">This lead stays out of canon until you sort or merge it.</span>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(12rem,1.2fr)_auto]">
              <select
                value=""
                onChange={(event) => {
                  const nextType = event.target.value as ManualEntityType;
                  if (nextType) classify(entity, nextType);
                }}
                disabled={isBusy}
                aria-label={`Sort ${entity.name} into a category`}
                className="storyhold-select min-h-9 py-1.5 text-xs"
              >
                <option value="">Choose the correct category…</option>
                {manualCategories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
              <select
                value={mergeTargets[entity.id] ?? ""}
                onChange={(event) => setMergeTargets((current) => ({ ...current, [entity.id]: event.target.value }))}
                disabled={isBusy}
                aria-label={`Merge ${entity.name} into an existing dossier`}
                className="storyhold-select min-h-9 min-w-0 py-1.5 text-xs"
              >
                <option value="">Or choose an existing dossier…</option>
                {mergeOptions.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} ({category(candidate.entityType).label})</option>)}
              </select>
              <Button type="button" size="sm" variant="outline" disabled={!mergeTargets[entity.id] || isBusy} onClick={() => merge(entity)}><GitMerge className="h-3.5 w-3.5" /> Merge</Button>
            </div>
            <div className="mt-2 flex justify-end gap-2">
              {entity.pullStatus === "do_not_pull"
                ? <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" disabled={isBusy} onClick={() => restore(entity)}><ArchiveRestore className="h-3.5 w-3.5" /> Restore</Button>
                : <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" disabled={isBusy} onClick={() => suppress(entity)}><ArchiveRestore className="h-3.5 w-3.5" /> Ignore</Button>}
              <Button type="button" size="sm" variant="ghost" className="text-red-200 hover:bg-red-500/10 hover:text-red-100" disabled={isBusy} onClick={() => setDeleteTarget(entity)}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>
            </div>
          </article>;
        }
        const dossierHref = worldEntityDossierHref(detail.world.id, entity);
        if (!dossierHref) return null;
        return <Link
          key={entity.id}
          href={dossierHref}
          className="group mb-2 flex w-full min-w-0 break-inside-avoid items-center gap-3 rounded-xl border border-white/8 bg-black/20 px-3 py-3 transition-colors hover:border-primary/25 hover:bg-primary/[0.045] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 sm:px-4"
          aria-label={`Open ${entity.name}'s dossier`}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h4 className="truncate font-semibold">{entity.name}</h4>
              <Badge variant="outline" className="shrink-0 border-white/10 text-[9px]">{category(entity.entityType).label}</Badge>
              {entity.pullStatus === "do_not_pull" ? <Badge variant="outline" className="shrink-0 border-amber-300/20 text-[9px] text-amber-100">Hidden</Badge> : null}
            </div>
            <p className="mt-1 truncate text-[11px] text-muted-foreground">
              {mentionLabel(entity, false)}
              {entity.aliases.length ? ` · ${aliasLabel(entity)} ${entity.aliases.slice(0, 2).join(", ")}${entity.aliases.length > 2 ? ` +${entity.aliases.length - 2}` : ""}` : ""}
            </p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
        </Link>;

        const expanded = expandedIds.has(entity.id);
        const isBusy = busyId === entity.id;
        const outgoing = detail.entityRelations.filter((relation) => relation.sourceEntityId === entity.id);
        const incoming = detail.entityRelations.filter((relation) => relation.targetEntityId === entity.id);
        const rules = detail.entityRules.filter((rule) => rule.entityId === entity.id && rule.status === "active");
        const reverseGroups = new Map<string, WorldEntityRelation[]>();
        for (const relation of incoming) { const heading = reverseHeading(entity, relation); reverseGroups.set(heading, [...(reverseGroups.get(heading) ?? []), relation]); }
        const mergeOptions = active.filter((candidate) => candidate.id !== entity.id).sort((left, right) => left.name.localeCompare(right.name));
        const glanceConnections = atAGlanceConnections(entity, outgoing, incoming);
        const cardSummary = entity.summary || entity.details[0] || "This card is waiting for a grounded summary.";
        return <article id={`hold-card-${entity.id}`} key={entity.id} className="mb-2 break-inside-avoid overflow-hidden rounded-2xl border border-white/8 bg-black/20">
          <button type="button" className="flex w-full items-start gap-3 p-3 text-left hover:bg-white/[0.035] sm:px-4" onClick={() => toggleExpanded(entity.id)} aria-expanded={expanded}>
            {expanded ? <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-primary" /> : <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><h4 className="font-semibold">{entity.name}</h4><Badge variant="outline" className={entity.entityType === "ambiguous" ? "border-amber-300/30 text-amber-100" : "border-white/10"}>{category(entity.entityType).label}</Badge></div>
              <p className="mt-1 text-[11px] text-muted-foreground">{mentionLabel(entity, true)}{entity.aliases.length ? ` · ${aliasLabel(entity)} ${entity.aliases.slice(0, 2).join(", ")}${entity.aliases.length > 2 ? ` +${entity.aliases.length - 2}` : ""}` : ""}{rules.length ? ` · ${rules.length} rule${rules.length === 1 ? "" : "s"}` : ""}</p>
              <p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-foreground/75">{cardSummary}</p>
              {glanceConnections.length ? <div className="mt-2 flex flex-wrap gap-1.5">{glanceConnections.slice(0, 4).map((connection) => <span key={connection.key} className="rounded-full border border-primary/20 bg-primary/[0.06] px-2 py-1 text-[10px] text-foreground"><span className="text-muted-foreground">{connection.label}:</span> {connection.name}{connection.status !== "active" ? <span className="text-muted-foreground"> · {connection.status}</span> : null}</span>)}{glanceConnections.length > 4 ? <span className="rounded-full border border-white/10 px-2 py-1 text-[10px] text-muted-foreground">+{glanceConnections.length - 4} more</span> : null}</div> : <p className="mt-2 text-[10px] text-muted-foreground">No canonical connections yet</p>}
            </div>
            {isBusy ? <Loader2 className="mt-1 h-4 w-4 animate-spin text-primary" /> : null}
          </button>
          {expanded ? <div className="border-t border-white/8 p-4">{entity.aliases.length ? <div className="flex flex-wrap items-center gap-1.5"><Tag className="h-3.5 w-3.5 text-primary" /><span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{entity.entityType === "character" ? "Also Known As" : "Also Indexed As"}</span>{entity.aliases.map((alias) => <Badge key={alias} variant="secondary" className="text-[10px]">{alias}</Badge>)}</div> : null}<p className="mt-3 break-words text-sm leading-6 text-muted-foreground">{entity.summary || "No grounded summary has been established yet."}</p>{entity.details.length ? <ul className="mt-3 space-y-1 text-xs text-muted-foreground">{entity.details.map((detailLine) => <li key={detailLine} className="break-words">• {detailLine}</li>)}</ul> : null}<CardEditor entity={entity} busy={isBusy} onSave={(input) => editCard(entity, input)} />
          {entity.pullStatus === "do_not_pull" ? <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/8 p-3"><p className="text-xs text-muted-foreground">Excluded from retrieval. Restore it or delete the entry from this Hold.</p><div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" onClick={() => restore(entity)}><ArchiveRestore className="h-3.5 w-3.5" /> Restore</Button><Button type="button" size="sm" variant="outline" className="border-red-400/25 text-red-200 hover:bg-red-500/10 hover:text-red-100" disabled={isBusy} onClick={() => setDeleteTarget(entity)}><Trash2 className="h-3.5 w-3.5" /> Delete entry</Button></div></div> : <>
            {reverseGroups.size ? <div className="mt-4 space-y-3">{[...reverseGroups.entries()].map(([heading, relations]) => <div key={heading} className="rounded-xl border border-white/8 bg-white/[0.02] p-3"><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{heading}</p><div className="mt-2 flex flex-wrap gap-2">{relations.map((relation) => <span key={relation.id} className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/[0.06] py-1 pl-2.5 pr-1 text-xs"><button type="button" className="hover:underline" onClick={() => openLinked(relation.sourceEntityId)}>{relation.sourceName}</button>{relation.status !== "active" ? <span className="text-[10px] text-muted-foreground">{relation.status}</span> : null}<button type="button" className="rounded-full p-1 text-muted-foreground hover:bg-white/10" aria-label="Remove link" onClick={() => removeRelation(entity, relation)}><X className="h-3 w-3" /></button></span>)}</div></div>)}</div> : null}
            {outgoing.length ? <div className="mt-4 rounded-xl border border-white/8 bg-white/[0.02] p-3"><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">This card's links</p><div className="mt-2 space-y-2">{outgoing.map((relation) => <div key={relation.id} className="flex items-start justify-between gap-3 rounded-lg bg-black/20 px-3 py-2 text-xs"><div><span className="text-muted-foreground">{relationLabel(relation.relationType)} </span><button type="button" className="font-semibold hover:underline" onClick={() => openLinked(relation.targetEntityId)}>{relation.targetName}</button><Badge variant="outline" className="ml-2 border-white/10 text-[9px]">{relation.status}</Badge>{relation.summary ? <p className="mt-1 text-muted-foreground">{relation.summary}</p> : null}{relation.validFromLabel || relation.validUntilLabel ? <p className="mt-1 text-[10px] text-muted-foreground">{relation.validFromLabel ? `From: ${relation.validFromLabel}` : ""}{relation.validFromLabel && relation.validUntilLabel ? " · " : ""}{relation.validUntilLabel ? `Until: ${relation.validUntilLabel}` : ""}</p> : null}</div><button type="button" className="rounded p-1 text-muted-foreground hover:bg-white/10" aria-label="Remove link" onClick={() => removeRelation(entity, relation)}><X className="h-3.5 w-3.5" /></button></div>)}</div></div> : null}
            <div className="mt-4"><EntityConnectionEditor entity={entity} entities={active} busy={isBusy} onCreate={(input) => addRelations(entity, input)} /></div>
            <div className="mt-4 rounded-xl border border-white/8 bg-white/[0.02] p-3"><div className="flex items-center justify-between gap-2"><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Canonical rules</p><RuleEditor entity={entity} busy={isBusy} onCreate={(input) => addRule(entity, input)} /></div>{rules.length ? <div className="mt-2 space-y-2">{rules.map((rule) => <div key={rule.id} className="flex items-start justify-between gap-3 rounded-lg bg-black/20 px-3 py-2 text-xs"><div><div className="flex items-center gap-2"><span className="font-semibold">{rule.name}</span><Badge variant="outline" className="border-white/10 text-[9px]">{rule.ruleKind}</Badge></div>{rule.description ? <p className="mt-1 text-muted-foreground">{rule.description}</p> : null}</div><button type="button" className="rounded p-1 text-muted-foreground hover:bg-white/10" aria-label="Remove rule" onClick={() => requestConfirmation({ title: `Remove ${rule.name}?`, description: "This removes only this rule from the card.", confirmLabel: "Remove rule", onConfirm: () => run(entity.id, () => deleteWorldEntityRule({ worldId: detail.world.id, ruleId: rule.id }), "The rule was removed.") })}><X className="h-3.5 w-3.5" /></button></div>)}</div> : <p className="mt-2 text-xs text-muted-foreground">No explicit rules have been established.</p>}</div>
            <div className="mt-4 grid gap-2 sm:grid-cols-[0.8fr_1.2fr_auto]"><select value={entity.entityType} onChange={(event) => classify(entity, event.target.value as WorldEntityType)} disabled={isBusy} className="storyhold-select min-h-9 py-1.5 text-xs">{categories.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><select value={mergeTargets[entity.id] ?? ""} onChange={(event) => setMergeTargets((current) => ({ ...current, [entity.id]: event.target.value }))} disabled={isBusy} className="storyhold-select min-h-9 min-w-0 py-1.5 text-xs"><option value="">Choose an AKA or duplicate to merge...</option>{mergeOptions.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} ({category(candidate.entityType).label})</option>)}</select><Button type="button" size="sm" variant="outline" disabled={!mergeTargets[entity.id] || isBusy} onClick={() => merge(entity)}><GitMerge className="h-3.5 w-3.5" /> Merge</Button></div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2"><Button asChild type="button" size="sm" variant="ghost"><Link href={dossierHref ?? "#storyhold-entries"}>Open full {entity.entityType === "character" ? "person" : category(entity.entityType).label.toLocaleLowerCase()} dossier <ChevronRight className="h-3.5 w-3.5" /></Link></Button><div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="ghost" className="text-muted-foreground" disabled={isBusy} onClick={() => suppress(entity)}><ArchiveRestore className="h-3.5 w-3.5" /> Hide from stories</Button><Button type="button" size="sm" variant="outline" className="border-red-400/25 text-red-200 hover:bg-red-500/10 hover:text-red-100" disabled={isBusy} onClick={() => setDeleteTarget(entity)}><Trash2 className="h-3.5 w-3.5" /> Delete entry</Button></div></div>
          </>}</div> : null}</article>;
      })}</div>{group.entities.length < matching.filter((entity) => filter === "all" ? entity.entityType === group.value : true).length ? <div className="mt-3 flex justify-center"><Button type="button" size="sm" variant="outline" onClick={() => setVisibleLimit((current) => current + 12)}>Show 12 more {group.plural.toLocaleLowerCase()}</Button></div> : null}</> : null}</section>;
      })}</div> : <div className="mt-5 rounded-2xl border border-dashed border-white/10 p-8 text-center"><Check className="mx-auto h-5 w-5 text-primary" /><p className="mt-2 font-semibold">Nothing in this section.</p><p className="mt-1 text-sm text-muted-foreground">Try another section or clear the search.</p></div>}

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !busyId) setDeleteTarget(null); }}>
        <AlertDialogContent className="border-red-400/25 bg-[#111014] shadow-2xl shadow-black/75 sm:max-w-lg">
          <AlertDialogHeader className="items-center text-center sm:text-center">
            <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-full border border-red-400/30 bg-red-500/10 text-red-200"><Trash2 className="h-6 w-6" /></div>
            <AlertDialogTitle className="font-serif text-2xl">Are you sure?</AlertDialogTitle>
            <AlertDialogDescription className="max-w-md text-center leading-6">
              Delete <strong className="text-foreground">{deleteTarget?.name}</strong> from this Hold? This cannot be undone in Storyhold.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteTarget ? <div className="rounded-xl border border-red-400/15 bg-red-500/[0.045] p-4 text-sm">
            <div className="flex items-center justify-between gap-3"><span className="font-semibold">{deleteTarget.name}</span><Badge variant="outline" className="border-red-300/20 text-red-100">{category(deleteTarget.entityType).label}</Badge></div>
            <ul className="mt-3 space-y-1.5 text-xs leading-5 text-muted-foreground">
              <li>• The visible card and{deleteTarget.dossierId ? " its person dossier" : " its indexed details"} will be removed.</li>
              <li>• {deleteLinkCount} connected link{deleteLinkCount === 1 ? "" : "s"} and {deleteRuleCount} canonical rule{deleteRuleCount === 1 ? "" : "s"} will be deleted.</li>
              <li>• A private do-not-recreate marker will stop later manuscript scans from bringing it back.</li>
            </ul>
          </div> : null}
          <AlertDialogFooter className="mt-1 sm:justify-center">
            <AlertDialogCancel disabled={Boolean(busyId)}>No, keep it</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 text-white hover:bg-red-500" disabled={!deleteTarget || Boolean(busyId)} onClick={() => {
              const target = deleteTarget;
              if (!target) return;
              setDeleteTarget(null);
              void run(target.id, () => deleteWorldEntity({ worldId: detail.world.id, entityId: target.id }), `${target.name} was deleted from the Hold.`);
            }}><Trash2 className="h-4 w-4" /> Yes, delete entry</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {detail.entityActions.some((action) => !action.undoneAt) ? <div className="mt-6 border-t border-white/8 pt-5"><p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Recent merges</p><div className="mt-3 flex flex-wrap gap-2">{detail.entityActions.filter((action) => !action.undoneAt).slice(0, 8).map((action) => <Button key={action.id} type="button" size="sm" variant="outline" disabled={busyId === action.id} onClick={() => requestConfirmation({ title: "Undo this merge?", description: action.summary, confirmLabel: "Undo", onConfirm: () => run(action.id, () => undoWorldEntityMerge({ worldId: detail.world.id, actionId: action.id }), "The merge was undone.") })}>{busyId === action.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}{action.summary}</Button>)}</div></div> : null}
    </Card>
  );
}
