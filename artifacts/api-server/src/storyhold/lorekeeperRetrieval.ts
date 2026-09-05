type EntityRow = Record<string, unknown>;
type SourceRow = Record<string, unknown> & { id?: unknown; content?: unknown };

const SEARCH_STOP_WORDS = new Set([
  "about", "after", "again", "before", "could", "from", "have", "into",
  "just", "that", "their", "then", "there", "they", "this", "what",
  "when", "where", "which", "with", "would", "your", "them", "some",
  "the", "and", "but", "for", "you", "his", "her", "its", "our",
]);

function cleanText(value: unknown, maximum = 8_000) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function stringValues(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => cleanText(item, 240)).filter(Boolean)
    : [];
}

export function retrievalTokens(value: string) {
  return [...new Set(
    (value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? [])
      .filter((token) => !SEARCH_STOP_WORDS.has(token)),
  )];
}

function normalizedLabel(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function editDistance(left: string, right: string) {
  if (left === right) return 0;
  if (!left) return right.length;
  if (!right) return left.length;
  const prior = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = prior[rightIndex - 1] +
        (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        prior[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        substitution,
      );
    }
    prior.splice(0, prior.length, ...current);
  }
  return prior[right.length];
}

function similarity(left: string, right: string) {
  const maximum = Math.max(left.length, right.length);
  return maximum === 0 ? 1 : 1 - editDistance(left, right) / maximum;
}

function records(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

export type SceneEntityFrame = {
  matchedEntityIds: string[];
  matchedNames: string[];
  graphNeighborNames: string[];
  multiHopNames: string[];
  graphPaths: Array<{
    entityId: string | null;
    name: string;
    depth: 1 | 2;
    viaEntityId: string | null;
    viaName: string;
    relationType: string;
    relationStatus: string;
  }>;
  expandedTerms: string[];
};

export type CanonicalHistoryEvent = Record<string, unknown>;

/**
 * Selects a small, causally useful slice from an already locked campaign
 * timeline. The caller supplies only snapshot rows at or before the campaign
 * start, so ranking can never retrieve future manuscript events.
 */
export function selectCanonicalHistory(params: {
  rows: CanonicalHistoryEvent[];
  query: string;
  entityIds: string[];
  maximum?: number;
}): CanonicalHistoryEvent[] {
  const maximum = Math.max(4, Math.min(40, params.maximum ?? 24));
  const entityIds = new Set(params.entityIds.filter(Boolean));
  const terms = retrievalTokens(params.query);
  const selected = params.rows
    .map((row, index) => {
      const participants = stringValues(row.participant_entity_ids);
      const participantMatch = participants.some((id) => entityIds.has(id));
      const searchable = [
        cleanText(row.title, 600),
        cleanText(row.summary, 2_000),
        cleanText(row.world_time_label, 500),
        JSON.stringify(records(row.causal_links)),
      ].join(" ");
      return {
        row,
        index,
        score: (participantMatch ? 10_000 : 0) + occurrenceScore(searchable, terms),
        order: Number(row.chronology_order ?? 0),
      };
    })
    .sort((left, right) =>
      right.score - left.score || right.order - left.order || left.index - right.index,
    )
    .filter((item, index, all) =>
      all.findIndex((candidate) => String(candidate.row.event_id ?? candidate.row.id) ===
        String(item.row.event_id ?? item.row.id)) === index,
    )
    .slice(0, maximum)
    .sort((left, right) => left.order - right.order || left.index - right.index);
  return selected.map((item) => item.row);
}

/**
 * Exact canonical names and aliases lead. Conservative fuzzy matching is only
 * used for name-like tokens. A bounded two-hop graph walk then supplies
 * related people, places, factions, creatures, powers, titles, and objects.
 * Direct matches and first-hop neighbors always lead second-hop context.
 */
export function resolveSceneEntityFrame(
  entities: EntityRow[],
  query: string,
  options: { maximumDepth?: 1 | 2; maximumExpandedEntities?: number } = {},
): SceneEntityFrame {
  const normalizedQuery = ` ${normalizedLabel(query)} `;
  const queryTokens = retrievalTokens(query);
  const scored = entities.flatMap((entity) => {
    const name = cleanText(entity.name, 240);
    const labels = [name, ...stringValues(entity.aliases)]
      .map((label) => ({ raw: label, normalized: normalizedLabel(label) }))
      .filter((label) => label.normalized.length >= 3);
    let score = 0;
    let matchedLabel = "";
    for (const label of labels) {
      if (` ${normalizedQuery}`.includes(` ${label.normalized} `)) {
        const nextScore = 100 + label.normalized.length;
        if (nextScore > score) {
          score = nextScore;
          matchedLabel = label.raw;
        }
        continue;
      }
      if (!label.normalized.includes(" ") && label.normalized.length >= 5) {
        const fuzzy = Math.max(
          0,
          ...queryTokens.map((token) => similarity(label.normalized, token)),
        );
        if (fuzzy >= 0.9 && fuzzy * 50 > score) {
          score = fuzzy * 50;
          matchedLabel = label.raw;
        }
      }
    }
    return score > 0 ? [{ entity, name, labels, score, matchedLabel }] : [];
  })
    .sort((left, right) => right.score - left.score)
    .slice(0, 16);

  const matchedEntityIds = scored.map((item) => cleanText(item.entity.id, 80)).filter(Boolean);
  const matchedNames = [...new Set(scored.map((item) => item.name).filter(Boolean))];
  const maximumDepth = options.maximumDepth ?? 2;
  const maximumExpandedEntities = Math.max(
    8,
    Math.min(80, options.maximumExpandedEntities ?? 48),
  );
  const entitiesById = new Map(
    entities.flatMap((entity) => {
      const id = cleanText(entity.id, 80);
      return id ? [[id, entity] as const] : [];
    }),
  );
  const entitiesByLabel = new Map<string, EntityRow[]>();
  for (const entity of entities) {
    const labels = [cleanText(entity.name, 240), ...stringValues(entity.aliases)]
      .map(normalizedLabel)
      .filter(Boolean);
    for (const label of labels) {
      entitiesByLabel.set(label, [...(entitiesByLabel.get(label) ?? []), entity]);
    }
  }
  const resolveLinkedEntity = (link: Record<string, unknown>) => {
    const linkedId = cleanText(link.otherEntityId, 80);
    if (linkedId && entitiesById.has(linkedId)) return entitiesById.get(linkedId) ?? null;
    const linkedName = normalizedLabel(cleanText(link.otherName, 240));
    const candidates = linkedName ? entitiesByLabel.get(linkedName) ?? [] : [];
    return candidates.length === 1 ? candidates[0] : null;
  };
  const queue: Array<{ entity: EntityRow; depth: 0 | 1 | 2 }> = scored.map(
    (item) => ({ entity: item.entity, depth: 0 }),
  );
  const visitedEntityIds = new Set(matchedEntityIds);
  const visitedNames = new Set(matchedNames.map(normalizedLabel));
  const graphPaths: SceneEntityFrame["graphPaths"] = [];
  for (let cursor = 0;
    cursor < queue.length && graphPaths.length < maximumExpandedEntities;
    cursor += 1) {
    const current = queue[cursor];
    if (current.depth >= maximumDepth) continue;
    const viaEntityId = cleanText(current.entity.id, 80) || null;
    const viaName = cleanText(current.entity.name, 240);
    for (const link of records(current.entity.entity_links)) {
      if (graphPaths.length >= maximumExpandedEntities) break;
      const linkedEntity = resolveLinkedEntity(link);
      const linkedId = cleanText(linkedEntity?.id ?? link.otherEntityId, 80) || null;
      const linkedName = cleanText(linkedEntity?.name ?? link.otherName, 240);
      const linkedNameKey = normalizedLabel(linkedName);
      if (!linkedName ||
          (linkedId && visitedEntityIds.has(linkedId)) ||
          (!linkedId && visitedNames.has(linkedNameKey))) {
        continue;
      }
      const depth = (current.depth + 1) as 1 | 2;
      graphPaths.push({
        entityId: linkedId,
        name: linkedName,
        depth,
        viaEntityId,
        viaName,
        relationType: cleanText(link.relationType, 120),
        relationStatus: cleanText(link.status, 120),
      });
      if (linkedId) visitedEntityIds.add(linkedId);
      visitedNames.add(linkedNameKey);
      if (linkedEntity && depth < maximumDepth) {
        queue.push({ entity: linkedEntity, depth });
      }
    }
  }
  const graphNeighborNames = graphPaths
    .filter((path) => path.depth === 1)
    .map((path) => path.name);
  const multiHopNames = graphPaths
    .filter((path) => path.depth === 2)
    .map((path) => path.name);
  const matchedAliases = scored.flatMap((item) =>
    item.labels.map((label) => label.raw),
  );
  return {
    matchedEntityIds,
    matchedNames,
    graphNeighborNames,
    multiHopNames,
    graphPaths,
    expandedTerms: [...new Set([
      ...matchedNames,
      ...matchedAliases,
      ...graphNeighborNames,
      ...multiHopNames,
    ])].slice(0, 80),
  };
}

function tokenSet(value: string) {
  return new Set(retrievalTokens(value));
}

function overlap(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / Math.max(1, left.size + right.size - intersection);
}

function occurrenceScore(value: string, terms: string[]) {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  return terms.reduce((score, term) => {
    const normalizedTerm = term.normalize("NFKC").toLocaleLowerCase();
    return score + (normalized.includes(normalizedTerm)
      ? 1 + Math.min(5, normalizedTerm.length / 8)
      : 0);
  }, 0);
}

export function contextualSourceExcerpt(
  content: string,
  query: string,
  entityTerms: string[],
  maximum = 900,
) {
  if (content.length <= maximum) return content.trim();
  const lower = content.normalize("NFKC").toLocaleLowerCase();
  const terms = [...entityTerms, ...retrievalTokens(query)]
    .map((term) => term.normalize("NFKC").toLocaleLowerCase())
    .filter((term) => term.length >= 3);
  let bestIndex = 0;
  let bestScore = -1;
  for (const term of terms) {
    let index = lower.indexOf(term);
    while (index >= 0) {
      const window = lower.slice(Math.max(0, index - 260), index + 520);
      const score = occurrenceScore(window, terms);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
      index = lower.indexOf(term, index + term.length);
    }
  }
  let start = Math.max(0, bestIndex - Math.round(maximum * 0.35));
  let end = Math.min(content.length, start + maximum);
  const before = content.lastIndexOf(". ", start);
  if (before >= Math.max(0, start - 180)) start = before + 2;
  const after = content.indexOf(". ", end - 80);
  if (after >= 0 && after <= Math.min(content.length, end + 180)) end = after + 1;
  return `${start > 0 ? "…" : ""}${content.slice(start, end).trim()}${end < content.length ? "…" : ""}`;
}

export type SourceEvidenceSelection = {
  selected: SourceRow[];
  candidateCount: number;
  selectedCount: number;
  coverageTerms: string[];
  missingCoverageTerms: string[];
};

function compactJsonValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return cleanText(value, depth <= 1 ? 1_200 : 500);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, depth <= 1 ? 24 : 12).map((item) => compactJsonValue(item, depth + 1));
  }
  if (value && typeof value === "object" && depth < 4) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 32)
        .map(([key, item]) => [key, compactJsonValue(item, depth + 1)]),
    );
  }
  return undefined;
}

export type CanonicalEntityPacket = {
  priority: "direct" | "first_hop" | "second_hop" | "ranked";
  identity: {
    id: string;
    canonicalKey: string;
    type: string;
    name: string;
    aliases: string[];
  };
  role: string;
  summary: string;
  profile: unknown;
  details: unknown;
  factionMemberships: unknown;
  links: Array<Record<string, unknown>>;
  rules: Array<Record<string, unknown>>;
  claims: Array<Record<string, unknown>>;
};

/**
 * Builds one non-repeating identity packet per canonical entity. Direct scene
 * entities lead graph neighbors, and current atomic claims lead history. The
 * packet budget is enforced before prompt assembly so a large dossier cannot
 * silently crowd manuscript evidence out of the Director request.
 */
export function buildCanonicalEntityPackets(params: {
  entities: EntityRow[];
  dossiers: EntityRow[];
  claims: EntityRow[];
  matchedEntityIds: string[];
  graphPaths: SceneEntityFrame["graphPaths"];
  actingCharacterId?: string | null;
  maximumCharacters?: number;
}): CanonicalEntityPacket[] {
  const maximumCharacters = Math.max(4_000, Math.min(40_000, params.maximumCharacters ?? 18_000));
  const directIds = new Set([
    ...params.matchedEntityIds,
    ...(params.actingCharacterId ? [params.actingCharacterId] : []),
  ]);
  const firstHopIds = new Set(params.graphPaths
    .filter((path) => path.depth === 1 && path.entityId)
    .map((path) => path.entityId!));
  const secondHopIds = new Set(params.graphPaths
    .filter((path) => path.depth === 2 && path.entityId)
    .map((path) => path.entityId!));
  const dossierById = new Map<string, EntityRow>();
  const dossierByName = new Map<string, EntityRow>();
  for (const dossier of params.dossiers) {
    const id = cleanText(dossier.id, 80);
    const name = normalizedLabel(cleanText(dossier.name, 240));
    if (id) dossierById.set(id, dossier);
    if (name && !dossierByName.has(name)) dossierByName.set(name, dossier);
  }
  const priorityOf = (id: string) => directIds.has(id)
    ? 0
    : firstHopIds.has(id)
      ? 1
      : secondHopIds.has(id)
        ? 2
        : 3;
  const rows = params.entities
    .map((entity, index) => ({ entity, index, priority: priorityOf(cleanText(entity.id, 80)) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index);
  const packets: CanonicalEntityPacket[] = [];
  let usedCharacters = 2;
  for (const { entity, priority } of rows) {
    const id = cleanText(entity.id, 80);
    const name = cleanText(entity.name, 240);
    if (!id || !name) continue;
    const dossier = dossierById.get(id) ?? dossierByName.get(normalizedLabel(name));
    const seenLinks = new Set<string>();
    const links = records(entity.entity_links).flatMap((link) => {
      const key = [
        cleanText(link.relationType, 120),
        cleanText(link.otherEntityId, 80) || normalizedLabel(cleanText(link.otherName, 240)),
        cleanText(link.status, 120),
      ].join("\n");
      if (!key.trim() || seenLinks.has(key)) return [];
      seenLinks.add(key);
      return [{
        direction: cleanText(link.direction, 40),
        relationType: cleanText(link.relationType, 120),
        status: cleanText(link.status, 120),
        otherEntityId: cleanText(link.otherEntityId, 80),
        otherName: cleanText(link.otherName, 240),
        otherType: cleanText(link.otherType, 80),
        summary: cleanText(link.summary, 600),
        validFrom: cleanText(link.validFromLabel, 180),
        validUntil: cleanText(link.validUntilLabel, 180),
      }];
    }).slice(0, 24);
    const claims = params.claims
      .filter((claim) => [
        claim.subject_entity_id,
        claim.object_entity_id,
        claim.epistemic_holder_entity_id,
      ].some((claimEntityId) => String(claimEntityId ?? "") === id))
      .sort((left, right) => {
        const leftHistorical = left.claim_status === "superseded" || Boolean(cleanText(left.valid_until_label, 240));
        const rightHistorical = right.claim_status === "superseded" || Boolean(cleanText(right.valid_until_label, 240));
        return Number(leftHistorical) - Number(rightHistorical);
      })
      .slice(0, 24)
      .map((claim) => ({
        id: claim.id,
        subject: claim.subject_name,
        predicate: claim.predicate,
        polarity: claim.polarity ?? "positive",
        object: claim.object_name ?? claim.object_text,
        truthStatus: claim.truth_status,
        holder: claim.epistemic_holder_name,
        validFrom: claim.valid_from_label,
        validUntil: claim.valid_until_label,
        temporalState:
          claim.claim_status === "superseded" || Boolean(cleanText(claim.valid_until_label, 240))
            ? "historical"
            : "current",
        supersedesClaimId: claim.supersedes_claim_id,
        confidence: claim.confidence,
      }));
    const packet: CanonicalEntityPacket = {
      priority: (["direct", "first_hop", "second_hop", "ranked"] as const)[priority]!,
      identity: {
        id,
        canonicalKey: cleanText(entity.canonical_key, 180),
        type: cleanText(entity.entity_type, 80),
        name,
        aliases: stringValues(entity.aliases),
      },
      role: cleanText(dossier?.role ?? entity.role, 500),
      summary: cleanText(dossier?.summary ?? entity.summary, 1_500),
      profile: compactJsonValue(dossier?.profile ?? entity.profile),
      details: compactJsonValue(entity.details),
      factionMemberships: compactJsonValue(entity.faction_memberships),
      links,
      rules: records(entity.entity_rules).slice(0, 16).map((rule) => compactJsonValue(rule) as Record<string, unknown>),
      claims,
    };
    const serializedLength = JSON.stringify(packet).length + 1;
    if (usedCharacters + serializedLength > maximumCharacters) {
      if (priority === 0 && packets.length === 0) {
        packets.push({ ...packet, profile: {}, details: [], links: links.slice(0, 8), rules: [], claims: claims.slice(0, 8) });
      }
      continue;
    }
    packets.push(packet);
    usedCharacters += serializedLength;
  }
  return packets;
}

/**
 * Locally reranks the broad lexical/vector pool, adds coverage for canonical
 * entity terms, and uses MMR-style diversity so near-duplicate passages do not
 * crowd out other chapters or sources. Only the compressed excerpts enter the
 * expensive prompt; search itself still spans the entire locked corpus.
 */
export function selectDiverseSourceEvidence(params: {
  rows: SourceRow[];
  query: string;
  entityTerms: string[];
  maximum?: number;
}): SourceEvidenceSelection {
  const maximum = Math.max(8, Math.min(36, params.maximum ?? 24));
  const queryTerms = retrievalTokens(params.query);
  const coverageTerms = [...new Set(params.entityTerms
    .map((term) => cleanText(term, 240))
    .filter((term) => term.length >= 3))].slice(0, 24);
  const candidates = params.rows.map((row, index) => {
    const content = cleanText(row.content, 40_000);
    const source = cleanText(row.source_title, 300);
    const tokens = tokenSet(content);
    const queryScore = occurrenceScore(content, queryTerms);
    const entityScore = occurrenceScore(content, coverageTerms);
    return {
      row,
      index,
      source,
      tokens,
      base: (1 / (1 + index)) * 8 + queryScore + entityScore * 1.8,
    };
  });
  const selected: typeof candidates = [];
  const remaining = [...candidates];
  while (selected.length < maximum && remaining.length) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const redundancy = selected.length
        ? Math.max(...selected.map((item) => overlap(candidate.tokens, item.tokens)))
        : 0;
      const sourceDiversity = selected.some((item) => item.source === candidate.source) ? 0 : 0.8;
      const score = candidate.base * 0.78 + sourceDiversity - redundancy * 3.4;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }

  // Coverage is a gate, not a hope. If a resolved scene entity has a passage
  // in the broad pool, ensure at least one such passage survives compression.
  for (const term of coverageTerms) {
    const normalized = term.normalize("NFKC").toLocaleLowerCase();
    if (selected.some((item) => cleanText(item.row.content, 40_000).toLocaleLowerCase().includes(normalized))) {
      continue;
    }
    const replacement = candidates.find((item) =>
      cleanText(item.row.content, 40_000).toLocaleLowerCase().includes(normalized),
    );
    if (!replacement) continue;
    if (selected.length >= maximum) selected.pop();
    if (!selected.some((item) => String(item.row.id) === String(replacement.row.id))) {
      selected.push(replacement);
    }
  }
  const selectedRows = selected.map((item) => ({
    ...item.row,
    retrieval_excerpt: contextualSourceExcerpt(
      cleanText(item.row.content, 40_000),
      params.query,
      coverageTerms,
    ),
  }));
  const missingCoverageTerms = coverageTerms.filter((term) => {
    const normalized = term.normalize("NFKC").toLocaleLowerCase();
    return !selectedRows.some((row) =>
      cleanText(row.content, 40_000).toLocaleLowerCase().includes(normalized),
    );
  });
  return {
    selected: selectedRows,
    candidateCount: params.rows.length,
    selectedCount: selectedRows.length,
    coverageTerms,
    missingCoverageTerms,
  };
}
