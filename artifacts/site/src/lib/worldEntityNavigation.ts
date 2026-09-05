import type { WorldEntity, WorldEntityType } from "@/lib/storyholdApi";

export type WorldEntityFilter = WorldEntityType | "all" | "hidden";

const compactEntityTypes = new Set<WorldEntityType>([
  "ambiguous",
  "cultural_reference",
  "term",
]);

/**
 * Only established canon records receive standalone dossier routes. Context
 * annotations and unresolved intake leads stay in their world-level review UI.
 */
export function worldEntityDossierHref(
  worldId: string,
  entity: Pick<WorldEntity, "id" | "dossierId" | "entityType">,
): string | null {
  if (compactEntityTypes.has(entity.entityType)) return null;
  if (entity.entityType === "character" && entity.dossierId) {
    return `/profile/worlds/${worldId}/characters/${entity.dossierId}`;
  }
  return `/profile/worlds/${worldId}/entities/${entity.id}`;
}

export function worldNeedsSortingHref(worldId: string, entityId?: string): string {
  const params = new URLSearchParams({ hold: "ambiguous" });
  if (entityId) params.set("focus", entityId);
  return `/profile/worlds/${worldId}?${params.toString()}#storyhold-entries`;
}

export function worldEntityFilterFromSearch(search: string): WorldEntityFilter | null {
  const requested = new URLSearchParams(search).get("hold");
  return requested === "ambiguous" ? "ambiguous" : null;
}
