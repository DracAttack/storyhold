import type { CharacterWorkspaceItem } from "./storyholdApi";

const previewTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export function workspaceFileAccess(item: CharacterWorkspaceItem) {
  const state = item.file?.scan?.state;
  if (item.kind !== "file" || !item.file) {
    return { available: false, previewable: false, pending: false, label: "", detail: "" };
  }
  if (state === "clean") {
    return { available: true, previewable: previewTypes.has(item.file.type), pending: false, label: "Safety Check Complete", detail: "" };
  }
  if (state === "quarantined") {
    const retryPending = item.file.scan?.reason === "scan_failed" && item.file.scan.retryPending === true;
    return {
      available: false, previewable: false, pending: retryPending,
      label: retryPending ? "File Quarantined — Retrying Check" : "File Quarantined",
      detail: item.file.scan?.reason === "suspicious"
        ? "A safety check flagged this file. Preview and download are blocked. Remove it and attach a trusted copy."
        : retryPending
          ? "The safety check was interrupted and will retry automatically. Preview and download remain blocked until the file passes. No credits are used."
          : "The safety check could not finish. Preview and download are blocked. Contact support or remove this file and try again later.",
    };
  }
  // Older/unknown responses must never unlock a file without a clean scan.
  return {
    available: false, previewable: false, pending: true,
    label: "Safety Check Pending",
    detail: "Preview and download will be available after the file passes its safety check. No credits are used.",
  };
}

export function getCharacterWorkspacePreviewUrl(input: { worldId: string; characterId: string; itemId: string }): string {
  const base = (import.meta.env?.BASE_URL ?? "/").replace(/\/$/, "");
  return `${base}/api/storyhold/worlds/${encodeURIComponent(input.worldId)}/characters/${encodeURIComponent(input.characterId)}/workspace/${encodeURIComponent(input.itemId)}/preview`;
}

/** Poll results only refresh safety metadata, not edits/removals made during a request. */
export function mergeWorkspaceScanUpdates(current: CharacterWorkspaceItem[], incoming: CharacterWorkspaceItem[]): CharacterWorkspaceItem[] {
  const byId = new Map(incoming.map((item) => [item.id, item]));
  return current.map((item) => {
    const next = byId.get(item.id);
    if (!item.file || !next?.file || item.kind !== "file") return item;
    return { ...item, file: { ...item.file, scan: next.file.scan } };
  });
}
