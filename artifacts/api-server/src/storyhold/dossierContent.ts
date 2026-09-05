/** Canonical storage is not an extraction/prompt budget. Preserve complete
 * strings, order and case; only exact duplicates and non-text entries disappear.
 * Incoming AI payloads remain bounded and validated by their own contracts. */
export function dossierStrings(...groups: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const value of group) {
      if (typeof value !== "string" || !value.trim() || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

/** Paid review must retain the identity of every old display slot. Preserve
 * existing string positions (even repeats/blanks); deduplicate only additions. */
export function appendDossierStrings(existing: unknown, ...additions: unknown[]): string[] {
  const result = Array.isArray(existing) ? existing.filter((value): value is string => typeof value === "string") : [];
  const seen = new Set(result);
  for (const group of additions) {
    if (!Array.isArray(group)) continue;
    for (const value of group) {
      if (typeof value !== "string" || !value.trim() || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

/** Replaying the same connection must not multiply its visible entry. Distinct
 * wording/time qualifiers remain separate; this does not infer equivalence. */
export function dossierConnections<T extends { name: string; relationship: string; summary: string; sentiment: string; evidence: unknown[] }>(...groups: T[][]): T[] {
  const entries = new Map<string, T>();
  for (const group of groups) for (const item of group) {
    const key = JSON.stringify([item.name, item.relationship, item.summary, item.sentiment]);
    const prior = entries.get(key);
    entries.set(key, { ...item, evidence: [...new Map([...(prior?.evidence ?? []), ...item.evidence]
      .map((anchor) => [JSON.stringify(anchor), anchor])).values()] });
  }
  return [...entries.values()];
}
