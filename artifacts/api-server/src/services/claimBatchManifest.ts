export interface ClaimBatchManifestEntry {
  documentId: string;
  contentHash: string | null;
  sectionIndex: number;
  chunkIds: string[];
  extractorVersion: string;
}

export interface ClaimBatchManifestInput {
  document: { id: string; contentHash: string | null };
  section: { chunkIds: string[] };
  sectionIndex: number;
}

function entryKey(documentId: string, sectionIndex: number): string {
  return `${documentId}\u001f${sectionIndex}`;
}

export function createClaimBatchManifest(
  inputs: ClaimBatchManifestInput[],
  extractorVersion: string,
): ClaimBatchManifestEntry[] {
  return inputs.map((input) => ({
    documentId: input.document.id,
    contentHash: input.document.contentHash,
    sectionIndex: input.sectionIndex,
    chunkIds: [...input.section.chunkIds],
    extractorVersion,
  }));
}

export function normalizeClaimBatchManifest(value: unknown): ClaimBatchManifestEntry[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const entries: ClaimBatchManifestEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return undefined;
    const item = raw as Record<string, unknown>;
    if (
      typeof item.documentId !== "string" ||
      (typeof item.contentHash !== "string" && item.contentHash !== null) ||
      !Number.isInteger(item.sectionIndex) ||
      Number(item.sectionIndex) < 0 ||
      !Array.isArray(item.chunkIds) ||
      item.chunkIds.some((id) => typeof id !== "string") ||
      typeof item.extractorVersion !== "string"
    ) {
      return undefined;
    }
    entries.push({
      documentId: item.documentId,
      contentHash: item.contentHash,
      sectionIndex: Number(item.sectionIndex),
      chunkIds: item.chunkIds as string[],
      extractorVersion: item.extractorVersion,
    });
  }
  return entries;
}

export function manifestDocumentIds(manifest: ClaimBatchManifestEntry[]): string[] {
  return [...new Set(manifest.map((entry) => entry.documentId))];
}

/**
 * Rebuild the original provider request order after a restart. Refuse to apply
 * old responses if the source content, section chunks, or extractor version
 * changed while Replit was down.
 */
export function restoreClaimBatchManifestOrder<T extends ClaimBatchManifestInput>(
  manifest: ClaimBatchManifestEntry[],
  candidates: T[],
  extractorVersion: string,
): T[] {
  const candidatesByKey = new Map<string, T>();
  for (const candidate of candidates) {
    const key = entryKey(candidate.document.id, candidate.sectionIndex);
    if (candidatesByKey.has(key)) {
      throw new Error(`Duplicate rebuilt Gemini batch section ${key}.`);
    }
    candidatesByKey.set(key, candidate);
  }

  return manifest.map((entry) => {
    if (entry.extractorVersion !== extractorVersion) {
      throw new Error(
        `Gemini batch uses extractor ${entry.extractorVersion}, but the server now uses ${extractorVersion}.`,
      );
    }
    const key = entryKey(entry.documentId, entry.sectionIndex);
    const candidate = candidatesByKey.get(key);
    if (!candidate) throw new Error(`Cannot rebuild Gemini batch section ${key}.`);
    if (candidate.document.contentHash !== entry.contentHash) {
      throw new Error(`Source content changed while Gemini batch ${key} was running.`);
    }
    if (
      candidate.section.chunkIds.length !== entry.chunkIds.length ||
      candidate.section.chunkIds.some((id, index) => id !== entry.chunkIds[index])
    ) {
      throw new Error(`Source chunks changed while Gemini batch ${key} was running.`);
    }
    return candidate;
  });
}

