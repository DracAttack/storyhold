export type LocalEntityCategory =
  | "character"
  | "place"
  | "faction"
  | "institution"
  | "government"
  | "power_structure"
  | "creature"
  | "species"
  | "technology"
  | "vehicle"
  | "device"
  | "weapon"
  | "power"
  | "title"
  | "cultural_reference"
  | "term"
  | "ambiguous";

export type LocalEntityMention = {
  text: string;
  category: LocalEntityCategory;
  score: number;
  chunkId: string;
  sourceId: string;
  quote: string;
  /** Storyhold adds these after extraction from its own chunk ledger. */
  sectionTitle?: string | null;
  perspective?: string | null;
};

export type LocalRelationType =
  | "member_of"
  | "participates_in"
  | "species_of"
  | "subspecies_of"
  | "subtype_of"
  | "lifecycle_stage_of"
  | "has_power"
  | "has_form"
  | "holds_title"
  | "child_of"
  | "sibling_of"
  | "spouse_of"
  | "friend_of"
  | "best_friend_of"
  | "leads"
  | "governs"
  | "controlled_by"
  | "allied_with"
  | "opposed_to"
  | "located_in"
  | "part_of"
  | "created_by"
  | "related_to";

export type LocalRelationMention = {
  subject: string;
  relationType: LocalRelationType;
  target: string;
  score: number;
  chunkId: string;
  sourceId: string;
  quote: string;
};

export type LocalPassageClassification = {
  label: string;
  score: number;
  chunkId: string;
  sourceId: string;
};

export type LocalStorySignal = {
  signalType: "story_claim" | "story_action" | "state_change";
  fields: Record<string, string[]>;
  score: number;
  chunkId: string;
  sourceId: string;
  quote: string;
};

export type LocalEntityExtractionStatus = {
  enabled: boolean;
  configured: boolean;
  provider: "gliner1" | "gliner2";
  model: string;
  endpoint: string | null;
  endpointKind: "loopback" | "remote" | null;
  sendsSourceTextOffDevice: boolean;
  explanation: string;
};

export type LocalEntityExtractionReceipt = {
  status: "disabled" | "completed" | "partial" | "failed";
  attemptedSegments: number;
  completedSegments: number;
  failedSegments: number;
  mentionCount: number;
  relationCount: number;
  classificationCount: number;
  signalCount: number;
  elapsedMilliseconds: number;
  errors: string[];
  totalSegments?: number;
  unprocessedSegments?: number;
};

type SourceChunk = {
  id: string;
  sourceId: string;
  content: string;
};

type Segment = {
  chunkId: string;
  sourceId: string;
  text: string;
};

const LABELS = [
  ["person or named fictional character", "character"],
  ["named geographic place, room, settlement, planet, or location", "place"],
  ["named faction, alliance, army, guild, clan, or organized group", "faction"],
  ["named institution, company, agency, school, church, court, or organization", "institution"],
  ["named government, regime, kingdom, empire, ministry, or governing council", "government"],
  ["named hierarchy, collective mind, caste system, or network of authority", "power_structure"],
  ["named creature, monster, animal, alien form, or creature subtype", "creature"],
  ["named species, race, people, or biological classification", "species"],
  ["named technology, engineered process, or scientific system", "technology"],
  ["named vehicle, spacecraft, ship, or vehicle class", "vehicle"],
  ["named device, tool, machine, artifact, or piece of equipment", "device"],
  ["named weapon, armament, or weapon class", "weapon"],
  ["named supernatural, psychic, biological, or special ability", "power"],
  ["formal title, rank, office, honorific, or status", "title"],
] as const satisfies ReadonlyArray<readonly [string, LocalEntityCategory]>;

const LABEL_CATEGORY = new Map<string, LocalEntityCategory>(
  LABELS.map(([label, category]) => [label.toLocaleLowerCase(), category]),
);

const RELATIONS = [
  ["is an active or former member of", "member_of"],
  ["participates in a government or power structure", "participates_in"],
  ["is an individual member of a species", "species_of"],
  ["is a biological subspecies of", "subspecies_of"],
  ["is a creature or technology subtype of", "subtype_of"],
  ["is a lifecycle stage of", "lifecycle_stage_of"],
  ["demonstrates or possesses the power", "has_power"],
  ["is the manifested body or creature form of", "has_form"],
  ["currently or formerly holds the title", "holds_title"],
  ["is the literal biological or legally adopted child of", "child_of"],
  ["is the literal biological or legal sibling of", "sibling_of"],
  ["is married to", "spouse_of"],
  ["is a friend of", "friend_of"],
  ["is explicitly the best friend of", "best_friend_of"],
  ["leads", "leads"],
  ["governs", "governs"],
  ["is controlled by", "controlled_by"],
  ["is allied with", "allied_with"],
  ["is opposed to", "opposed_to"],
  ["is located in", "located_in"],
  ["is part of", "part_of"],
  ["was created by", "created_by"],
  ["has another explicitly stated relationship to", "related_to"],
] as const satisfies ReadonlyArray<readonly [string, LocalRelationType]>;

const LABEL_RELATION = new Map<string, LocalRelationType>(
  RELATIONS.map(([label, relation]) => [label.toLocaleLowerCase(), relation]),
);

// Zero-shot entity readers are intentionally generous.  These terms are
// common false positives in prose: sentence-openers, dialogue interjections,
// sound effects, emotions, and generic action words are not canon cards even
// when a local model assigns them an entity label.  The connected model still
// reads the original passage independently, so rejecting one of these leads
// cannot hide a genuinely named concept from the final review.
const LOCAL_ENTITY_NOISE_TERMS = new Set([
  "abilities", "above", "amidst", "aye", "baby", "back", "been", "beside", "blood", "body",
  "betryal", "boom", "buzz", "call", "chrissake", "damn", "death", "despite", "either", "enough", "erm", "eugh",
  "exhaustion", "fear", "finally", "find", "fire", "fury", "guilt", "had",
  "gah", "hold", "holy", "home", "horror", "instead", "kablam", "leaving", "listen", "made", "make",
  "mind", "neither", "old", "others", "out", "pain", "panic", "pop",
  "professor", "pushing", "rage", "salt", "sensing", "several", "shit",
  "silence", "sir", "six", "slowly", "standing", "suddenly", "thank",
  "thud", "thump", "time", "took", "turn", "two", "yet", "they", "twat",
  "gunshots", "weapon", "well",
]);

const LOCAL_CHARACTER_REFERENCE_TERMS = new Set([
  "he", "her", "hers", "herself", "him", "himself", "his", "i", "it",
  "itself", "me", "mine", "my", "myself", "one", "our", "ours",
  "ourselves", "she", "someone", "somebody", "their", "theirs", "them",
  "themselves", "they", "us", "we", "who", "whom", "whose", "you",
  "your", "yours", "yourself", "yourselves", "anybody", "anyone",
  "everybody", "everyone", "nobody", "coolant", "pilot", "assistant",
  "assistants", "child", "man", "woman", "boy", "girl", "dwarf",
  "stranger", "technician", "technicians", "figure", "poets", "rain",
  "soft", "leading",
]);

const CHARACTER_TITLE_WORDS = new Set([
  "admiral", "captain", "chief", "colonel", "commander", "doctor", "dr",
  "emperor", "empress", "general", "king", "lady", "lieutenant", "lord",
  "major", "master", "mistress", "officer", "professor", "queen", "saint",
  "sergeant", "sir",
]);

export function localEntityTextIsUseful(value: string): boolean {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || !/\p{L}/u.test(normalized)) return false;
  const folded = normalized.toLocaleLowerCase();
  if (LOCAL_ENTITY_NOISE_TERMS.has(folded)) return false;
  // Coreference references are useful while resolving a passage, but they
  // never identify a durable dossier or graph endpoint by themselves.
  if (LOCAL_CHARACTER_REFERENCE_TERMS.has(folded)) return false;
  // Repeated-letter/all-caps sound effects are especially common in fiction
  // and have no stable referent for Storyhold retrieval.
  if (/^[A-Z]{2,8}$/u.test(normalized) && /^(?:boom|thud|bam|bang|crash|wham|pow|zap|buzz)$/iu.test(normalized)) {
    return false;
  }
  return true;
}

export function localCharacterNameIsUseful(value: string): boolean {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!localEntityTextIsUseful(normalized)) return false;
  const folded = normalized.toLocaleLowerCase();
  if (LOCAL_CHARACTER_REFERENCE_TERMS.has(folded)) return false;
  if (/^(?:jesus(?: fucking)? christ|oh my god|god damn(?: it)?|holy shit)$/iu.test(normalized)) {
    return false;
  }
  if (/^(?:a|an|the|this|that|these|those|one of|two|three|four|five|six|seven|eight|nine|ten)\b/iu.test(normalized)) {
    return false;
  }
  if (/^\p{Ll}/u.test(normalized)) return false;
  // Coordinated concepts are not one person. Keep each side available to its
  // own category instead of creating cards such as “Turncoats and Changelings.”
  if (/\b\p{Lu}[\p{L}\p{M}'’.-]*\s+(?:and|or|&)\s+\p{Lu}[\p{L}\p{M}'’.-]*\b/u.test(normalized)) {
    return false;
  }
  const words = normalized.split(/\s+/u);
  if (words.length === 1) return true;
  const first = words[0]!.replace(/[.]/gu, "").toLocaleLowerCase();
  if (CHARACTER_TITLE_WORDS.has(first)) {
    return Boolean(words[1] && /^\p{Lu}/u.test(words[1]));
  }
  // Descriptive noun phrases such as "Elven assistant" and "horned woman"
  // are references for coreference resolution, not named character cards.
  return /^\p{Lu}/u.test(words[words.length - 1]!);
}

function envEnabled(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLocaleLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function loopbackEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function remoteHttpsEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !loopbackEndpoint(value);
  } catch {
    return false;
  }
}

export function getLocalEntityExtractionStatus(
  stage: "gliner1" | "gliner2" = "gliner2",
): LocalEntityExtractionStatus {
  const endpoint = (stage === "gliner1"
    ? process.env.STORYHOLD_LOCAL_GLINER1_URL
    : process.env.STORYHOLD_LOCAL_GLINER2_URL ?? process.env.STORYHOLD_LOCAL_NER_URL
  )?.trim() || "";
  const requested = envEnabled(
    stage === "gliner1" ? "STORYHOLD_LOCAL_GLINER1_ENABLED" : "STORYHOLD_LOCAL_GLINER2_ENABLED",
    stage === "gliner2"
      ? envEnabled("STORYHOLD_LOCAL_NER_ENABLED", Boolean(endpoint))
      : Boolean(endpoint),
  );
  const allowRemote = envEnabled("STORYHOLD_LOCAL_NER_ALLOW_REMOTE", false);
  const safeEndpoint = Boolean(endpoint) && (
    loopbackEndpoint(endpoint) ||
    (allowRemote && remoteHttpsEndpoint(endpoint))
  );
  const enabled = requested && safeEndpoint;
  const isLoopback = Boolean(endpoint) && loopbackEndpoint(endpoint);
  return {
    enabled,
    configured: safeEndpoint,
    provider: stage,
    model: stage === "gliner1"
      ? process.env.STORYHOLD_LOCAL_GLINER1_MODEL?.trim() || "urchade/gliner_large-v2.1"
      : process.env.STORYHOLD_LOCAL_GLINER2_MODEL?.trim() ||
        process.env.STORYHOLD_LOCAL_NER_MODEL?.trim() || "fastino/gliner2-base-v1",
    endpoint: safeEndpoint ? endpoint : null,
    endpointKind: endpoint ? (isLoopback ? "loopback" : "remote") : null,
    sendsSourceTextOffDevice: Boolean(endpoint && !isLoopback),
    explanation: enabled
      ? stage === "gliner1"
        ? isLoopback
          ? "A configured loopback GLiNER 1 reader performs the broad, high-recall named-entity pass. Its leads remain evidence-backed candidates, not canon."
          : "A configured remote GLiNER 1 reader receives manuscript segments for a high-recall candidate pass. Its leads remain evidence-backed candidates, not canon."
        : isLoopback
          ? "A configured loopback GLiNER2 reader classifies Storyhold-native candidate terms, relationships, claims, and state changes before verification."
          : "A configured remote GLiNER2 reader receives manuscript segments to classify candidate terms, relationships, claims, and state changes before verification."
      : requested && endpoint && !safeEndpoint
        ? "The entity endpoint was blocked because manuscript text requires loopback HTTP(S), or an explicitly allowed remote HTTPS endpoint."
        : "The deterministic source scanner is active; the private GLiNER2 reader is not configured.",
  };
}

function healthEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = "/health";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function probeLocalEntityExtraction(
  timeoutMilliseconds = 2_000,
  stage: "gliner1" | "gliner2" = "gliner2",
): Promise<{ ready: boolean; status: LocalEntityExtractionStatus; message: string }> {
  const status = getLocalEntityExtractionStatus(stage);
  if (!status.enabled || !status.endpoint) {
    return { ready: false, status, message: status.explanation };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    const response = await fetch(healthEndpoint(status.endpoint), {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const payload = response.ok
      ? await response.json() as Record<string, unknown>
      : {};
    const ready = response.ok &&
      payload.status === "ready" &&
      payload.service === "storyhold-lorekeeper-local";
    return {
      ready,
      status,
      message: ready
        ? `${status.model} is installed and available to the sequential local reader.`
        : `The local Lorekeeper service returned HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      ready: false,
      status,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function boundedNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function modelScore(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : null;
}

function cleanEntityText(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 180)
    : "";
}

function rowsFromResponse(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    if (value.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
      return value as Array<Record<string, unknown>>;
    }
    return value.flatMap(rowsFromResponse);
  }
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["entities", "predictions", "results", "output", "data"]) {
    const rows = rowsFromResponse(record[key]);
    if (rows.length) return rows;
  }
  return [];
}

function quoteAround(text: string, entity: string, startValue: unknown): string {
  const declaredStart = Math.trunc(boundedNumber(startValue, -1));
  const start = declaredStart >= 0 && text.slice(declaredStart, declaredStart + entity.length) === entity
    ? declaredStart
    : text.indexOf(entity);
  if (start < 0) return entity;
  const left = Math.max(0, start - 80);
  const right = Math.min(text.length, start + entity.length + 80);
  return text.slice(left, right).normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 500);
}

function quoteAroundRelation(
  text: string,
  subject: string,
  target: string,
  subjectStartValue: unknown,
  targetStartValue: unknown,
): string {
  const normalizedText = text.normalize("NFKC");
  const locate = (value: string, declared: unknown): number => {
    const start = Math.trunc(boundedNumber(declared, -1));
    return start >= 0 && normalizedText.slice(start, start + value.length) === value
      ? start
      : normalizedText.indexOf(value);
  };
  const subjectStart = locate(subject, subjectStartValue);
  const targetStart = locate(target, targetStartValue);
  if (subjectStart < 0 || targetStart < 0) return quoteAround(text, subject, subjectStartValue);
  const left = Math.max(0, Math.min(subjectStart, targetStart) - 80);
  const right = Math.min(
    normalizedText.length,
    Math.max(subjectStart + subject.length, targetStart + target.length) + 80,
  );
  return normalizedText.slice(left, right).replace(/\s+/gu, " ").trim().slice(0, 500);
}

export function parseLocalEntityResponse(
  value: unknown,
  segment: Segment,
): LocalEntityMention[] {
  const seen = new Set<string>();
  return rowsFromResponse(value).flatMap((row): LocalEntityMention[] => {
    const text = cleanEntityText(row.text ?? row.word ?? row.entity_text ?? row.span);
    const label = cleanEntityText(row.label ?? row.entity ?? row.type).toLocaleLowerCase();
    const category = LABEL_CATEGORY.get(label);
    const score = modelScore(row.score ?? row.confidence);
    if (
      !text ||
      !category ||
      score === null ||
      text.length < 2 ||
      !localEntityTextIsUseful(text) ||
      (category === "character" && !localCharacterNameIsUseful(text)) ||
      !segment.text.normalize("NFKC").includes(text)
    ) return [];
    const key = `${category}\u0000${text.toLocaleLowerCase()}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      text,
      category,
      score,
      chunkId: segment.chunkId,
      sourceId: segment.sourceId,
      quote: quoteAround(segment.text, text, row.start),
    }];
  });
}

function relationRowsFromResponse(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const rows = (value as Record<string, unknown>).relations;
  return Array.isArray(rows)
    ? rows.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object" && !Array.isArray(row)))
    : [];
}

function directRows(value: unknown, key: string): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const rows = (value as Record<string, unknown>)[key];
  return Array.isArray(rows)
    ? rows.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object" && !Array.isArray(row)))
    : [];
}

export function parseLocalPassageClassifications(
  value: unknown,
  segment: Segment,
): LocalPassageClassification[] {
  const seen = new Set<string>();
  return directRows(value, "classifications").flatMap((row): LocalPassageClassification[] => {
    const label = cleanEntityText(row.label ?? row.text).toLocaleLowerCase();
    const score = modelScore(row.score ?? row.confidence);
    if (!label || score === null || seen.has(label)) return [];
    seen.add(label);
    return [{
      label,
      score,
      chunkId: segment.chunkId,
      sourceId: segment.sourceId,
    }];
  });
}

const SIGNAL_TYPES = new Set(["story_claim", "story_action", "state_change"]);
const SIGNAL_CHOICE_FIELDS = new Set(["truth_mode", "change_type"]);

export function parseLocalStorySignals(
  value: unknown,
  segment: Segment,
): LocalStorySignal[] {
  return directRows(value, "signals").flatMap((row): LocalStorySignal[] => {
    const signalType = cleanEntityText(row.signalType ?? row.signal_type);
    if (!SIGNAL_TYPES.has(signalType)) return [];
    const rawFields = row.fields && typeof row.fields === "object" && !Array.isArray(row.fields)
      ? row.fields as Record<string, unknown>
      : {};
    const fields: Record<string, string[]> = {};
    const scores: number[] = [];
    const exactValues: Array<{ text: string; start: unknown }> = [];
    let invalidScore = false;
    for (const [field, raw] of Object.entries(rawFields)) {
      const values = Array.isArray(raw) ? raw : [raw];
      const accepted: string[] = [];
      for (const value of values) {
        const record: Record<string, unknown> = value && typeof value === "object" && !Array.isArray(value)
          ? value as Record<string, unknown>
          : { text: value };
        const text = cleanEntityText(record.text ?? record.label);
        if (!text) continue;
        const score = modelScore(record.score ?? record.confidence);
        if (score === null) {
          invalidScore = true;
          continue;
        }
        const exact = segment.text.normalize("NFKC").includes(text);
        if (!exact && !SIGNAL_CHOICE_FIELDS.has(field)) continue;
        if (!accepted.some((existing) => existing.toLocaleLowerCase() === text.toLocaleLowerCase())) {
          accepted.push(text);
          scores.push(score);
          if (exact) exactValues.push({ text, start: record.start });
        }
      }
      if (accepted.length) fields[field] = accepted;
    }
    if (
      invalidScore || scores.length === 0 ||
      Object.keys(fields).length === 0 || exactValues.length === 0
    ) return [];
    const first = exactValues[0]!;
    const last = exactValues[exactValues.length - 1]!;
    return [{
      signalType: signalType as LocalStorySignal["signalType"],
      fields,
      score: Math.min(...scores),
      chunkId: segment.chunkId,
      sourceId: segment.sourceId,
      quote: quoteAroundRelation(segment.text, first.text, last.text, first.start, last.start),
    }];
  });
}

export function parseLocalRelationResponse(
  value: unknown,
  segment: Segment,
): LocalRelationMention[] {
  const seen = new Set<string>();
  return relationRowsFromResponse(value).flatMap((row): LocalRelationMention[] => {
    const label = cleanEntityText(row.label ?? row.relation ?? row.type).toLocaleLowerCase();
    const relationType = LABEL_RELATION.get(label);
    const subjectRow = row.subject && typeof row.subject === "object"
      ? row.subject as Record<string, unknown>
      : {};
    const targetRow = row.target && typeof row.target === "object"
      ? row.target as Record<string, unknown>
      : {};
    const subject = cleanEntityText(subjectRow.text ?? row.subject);
    const target = cleanEntityText(targetRow.text ?? row.target);
    const score = modelScore(row.score ?? row.confidence);
    const normalizedText = segment.text.normalize("NFKC");
    if (
      !relationType || !subject || !target || score === null || subject === target ||
      !localEntityTextIsUseful(subject) || !localEntityTextIsUseful(target) ||
      !normalizedText.includes(subject) || !normalizedText.includes(target)
    ) return [];
    const key = `${relationType}\u0000${subject.toLocaleLowerCase()}\u0000${target.toLocaleLowerCase()}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      subject,
      relationType,
      target,
      score,
      chunkId: segment.chunkId,
      sourceId: segment.sourceId,
      quote: quoteAroundRelation(
        segment.text,
        subject,
        target,
        subjectRow.start,
        targetRow.start,
      ),
    }];
  });
}

function splitChunk(chunk: SourceChunk, maximumCharacters = 1_500): Segment[] {
  const text = chunk.content.trim();
  if (!text) return [];
  const segments: Segment[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maximumCharacters);
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf(". ", end),
        text.lastIndexOf("! ", end),
        text.lastIndexOf("? ", end),
        text.lastIndexOf("\n", end),
      );
      if (boundary > start + Math.floor(maximumCharacters * 0.55)) end = boundary + 1;
    }
    const segmentText = text.slice(start, end).trim();
    if (segmentText) segments.push({ chunkId: chunk.id, sourceId: chunk.sourceId, text: segmentText });
    start = end;
  }
  return segments;
}

async function extractSegment(
  endpoint: string,
  segment: Segment,
  threshold: number,
  timeoutMilliseconds: number,
  deadlineUnixMs?: number,
  requireLoaded?: boolean,
): Promise<{
  mentions: LocalEntityMention[];
  relations: LocalRelationMention[];
  classifications: LocalPassageClassification[];
  signals: LocalStorySignal[];
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: segment.text,
        labels: LABELS.map(([label]) => label),
        relations: RELATIONS.map(([label]) => label),
        storySignals: true,
        threshold,
        ...(deadlineUnixMs === undefined ? {} : { deadlineUnixMs }),
        ...(requireLoaded ? { requireLoaded: true } : {}),
      }),
      signal: controller.signal,
    });
    const payload = await response.json();
    if (!response.ok) {
      const detail = typeof payload?.error === "string"
        ? payload.error.replace(/\s+/gu, " ").slice(0, 500)
        : "";
      throw new Error(`Local entity service returned HTTP ${response.status}.${detail ? ` ${detail}` : ""}`);
    }
    return {
      // Treat the service threshold as advisory only. The server repeats it
      // before admitting model output into its candidate ledger, so a
      // misconfigured or substituted endpoint cannot silently lower it.
      mentions: parseLocalEntityResponse(payload, segment)
        .filter((mention) => mention.score >= threshold),
      relations: parseLocalRelationResponse(payload, segment)
        .filter((relation) => relation.score >= threshold),
      classifications: parseLocalPassageClassifications(payload, segment)
        .filter((classification) => classification.score >= threshold),
      signals: parseLocalStorySignals(payload, segment)
        .filter((signal) => signal.score >= threshold),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(deadlineUnixMs !== undefined && Date.now() >= deadlineUnixMs
        ? "The local entity read reached its gameplay deadline."
        : `The local entity service did not return within ${Math.ceil(timeoutMilliseconds / 1_000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function extractLocalStoryEntities(params: {
  chunks: SourceChunk[];
  stage?: "gliner1" | "gliner2";
  timeoutMilliseconds?: number;
  /** Optional whole-call deadline for interactive work; manuscript intake has no deadline by default. */
  deadlineUnixMs?: number;
  /** Best-effort interactive prechecks may inspect a resident model but must never start a cold load. */
  requireLoaded?: boolean;
  stopOnFailure?: boolean;
  /**
   * Durable prefix from a previously interrupted run. Segments are stable for
   * an unchanged chunk set, so the reader can continue at the next segment
   * instead of replaying the manuscript from segment zero.
   */
  resume?: {
    completedSegments: number;
    mentions: LocalEntityMention[];
    relations: LocalRelationMention[];
    classifications: LocalPassageClassification[];
    signals: LocalStorySignal[];
  };
  onCheckpoint?: () => Promise<void> | void;
  onProgress?: (
    completed: number,
    total: number,
    mentions: LocalEntityMention[],
    relations: LocalRelationMention[],
    classifications: LocalPassageClassification[],
    signals: LocalStorySignal[],
  ) => Promise<void> | void;
}): Promise<{
  status: LocalEntityExtractionStatus;
  mentions: LocalEntityMention[];
  relations: LocalRelationMention[];
  classifications: LocalPassageClassification[];
  signals: LocalStorySignal[];
  receipt: LocalEntityExtractionReceipt;
}> {
  const startedAt = Date.now();
  const deadlineUnixMs = Number.isFinite(params.deadlineUnixMs)
    ? Math.trunc(params.deadlineUnixMs!)
    : undefined;
  const status = getLocalEntityExtractionStatus(params.stage ?? "gliner2");
  if (!status.enabled || !status.endpoint) {
    return {
      status,
      mentions: [],
      relations: [],
      classifications: [],
      signals: [],
      receipt: {
        status: "disabled",
        attemptedSegments: 0,
        completedSegments: 0,
        failedSegments: 0,
        mentionCount: 0,
        relationCount: 0,
        classificationCount: 0,
        signalCount: 0,
        elapsedMilliseconds: Date.now() - startedAt,
        errors: [],
      },
    };
  }
  const threshold = Math.max(
    0.15,
    Math.min(0.9, boundedNumber(process.env.STORYHOLD_LOCAL_NER_THRESHOLD, 0.42)),
  );
  const timeoutMilliseconds = Math.max(
    500,
    Math.min(
      120_000,
      params.timeoutMilliseconds ??
        boundedNumber(process.env.STORYHOLD_LOCAL_NER_TIMEOUT_MS, 45_000),
    ),
  );
  const configuredConcurrency = Math.max(
    1,
    Math.min(8, Math.trunc(boundedNumber(process.env.STORYHOLD_LOCAL_NER_CONCURRENCY, 3))),
  );
  // Storyhold's bundled loopback service keeps exactly one specialist model in
  // memory and serializes inference. Sending parallel requests only creates a
  // queue of Python threads that can outlive the caller's timeout. Remote
  // services may still opt into bounded concurrency.
  const concurrency = status.endpointKind === "loopback" || (deadlineUnixMs !== undefined && params.stopOnFailure)
    ? 1 : configuredConcurrency;
  const segments = params.chunks.flatMap((chunk) => splitChunk(chunk));
  const resumedSegments = Math.max(
    0,
    Math.min(segments.length, Math.trunc(params.resume?.completedSegments ?? 0)),
  );
  const mentions: LocalEntityMention[] = [...(params.resume?.mentions ?? [])];
  const relations: LocalRelationMention[] = [...(params.resume?.relations ?? [])];
  const classifications: LocalPassageClassification[] = [
    ...(params.resume?.classifications ?? []),
  ];
  const signals: LocalStorySignal[] = [...(params.resume?.signals ?? [])];
  const errors: string[] = [];
  let completedSegments = resumedSegments;
  let failedSegments = 0;
  let stoppedAfterFailure = false;
  for (let offset = resumedSegments; offset < segments.length; offset += concurrency) {
    if (deadlineUnixMs !== undefined && Date.now() >= deadlineUnixMs) {
      errors.push("The local entity read reached its gameplay deadline before all segments were checked.");
      break;
    }
    const batch = segments.slice(offset, offset + concurrency);
    const rows = await Promise.allSettled(
      batch.map((segment) => extractSegment(
        status.endpoint!, segment, threshold,
        deadlineUnixMs === undefined ? timeoutMilliseconds
          : Math.max(1, Math.min(timeoutMilliseconds, deadlineUnixMs - Date.now())),
        deadlineUnixMs,
        params.requireLoaded,
      )),
    );
    for (const row of rows) {
      if (row.status === "fulfilled") {
        completedSegments += 1;
        mentions.push(...row.value.mentions);
        relations.push(...row.value.relations);
        classifications.push(...row.value.classifications);
        signals.push(...row.value.signals);
      } else {
        failedSegments += 1;
        if (errors.length < 12) {
          errors.push(
            (row.reason instanceof Error ? row.reason.message : String(row.reason))
              .replace(/\s+/gu, " ")
              .slice(0, 500),
          );
        }
        if (params.stopOnFailure) stoppedAfterFailure = true;
      }
    }
    await params.onProgress?.(
      Math.min(segments.length, offset + batch.length),
      segments.length,
      [...mentions],
      [...relations],
      [...classifications],
      [...signals],
    );
    await params.onCheckpoint?.();
    if (stoppedAfterFailure) break;
  }
  return {
    status,
    mentions,
    relations,
    classifications,
    signals,
    receipt: {
      status: failedSegments === 0 && completedSegments === segments.length
        ? "completed"
        : completedSegments > 0
          ? "partial"
          : "failed",
      attemptedSegments: completedSegments + failedSegments,
      completedSegments,
      failedSegments,
      mentionCount: mentions.length,
      relationCount: relations.length,
      classificationCount: classifications.length,
      signalCount: signals.length,
      elapsedMilliseconds: Date.now() - startedAt,
      errors,
      totalSegments: segments.length,
      unprocessedSegments: Math.max(0, segments.length - completedSegments - failedSegments),
    },
  };
}
