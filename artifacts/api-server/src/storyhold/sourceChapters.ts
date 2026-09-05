export type NarrativeSectionKind =
  | "chapter"
  | "part"
  | "interlude"
  | "prologue"
  | "epilogue"
  | "requiem"
  | "pov"
  | "file";

export type NarrativeSection = {
  key: string;
  title: string;
  body: string;
  order: number;
  sourceOffset: number;
  endOffset: number;
  kind: NarrativeSectionKind;
  marker: string;
  perspective: string;
};

export type NarrativeParseOptions = {
  /** Treat a heading-free, one-chapter source as a section named by its file. */
  sourceTitle?: string;
  fallbackToSource?: boolean;
  sourceKey?: string;
};

type HeadingCandidate = {
  baseKey: string;
  marker: string;
  title: string;
  kind: Exclude<NarrativeSectionKind, "file">;
  perspective: string;
  index: number;
  bodyStart: number;
};

const numberWord = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
  "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand",
].join("|");
const ordinalToken = `(?:\\d{1,4}|[ivxlcdm]{1,12}|(?:${numberWord})(?:[- ](?:and[- ]+)?(?:${numberWord}))*)`;
const explicitHeadingPattern = new RegExp(
  `^(?:(prologue|epilogue|requiem)|((?:chapter|part))\\s+(${ordinalToken})|(interlude)(?:\\s+(${ordinalToken}))?)\\b`,
  "iu",
);
const povHeadingPatterns = [
  /^pov\s*[:—–-]\s*([\p{L}][\p{L}\p{M}’'. -]{0,78})$/iu,
  /^([\p{L}][\p{L}\p{M}’'. -]{0,78}?)\s*(?:\(\s*pov\s*\)|[:—–-]\s*pov|\s+pov)$/iu,
  /^point\s+of\s+view\s*[:—–-]\s*([\p{L}][\p{L}\p{M}’'. -]{0,78})$/iu,
];
const boundaryPattern = /(?:[\r\n\f●•▪◦]|^)\s*(?:#{1,6}\s*)?/gu;
const titleWordPattern = /^[\p{Lu}\d][\p{L}\p{M}\d’'!?-]*(?:\s+(?:(?:a|an|and|at|for|from|in|into|of|on|the|to|with)|[\p{Lu}\d][\p{L}\p{M}\d’'!?-]*)){0,11}/u;

function slug(value: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "section";
}

function capitalizeMarker(marker: string) {
  return marker
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./u, (letter) => letter.toLocaleUpperCase());
}

function perspectiveFromTitle(title: string) {
  return title.match(/\(([^)]{1,100})\)\s*$/u)?.[1]?.trim() ?? "";
}

function isBareUppercasePerspective(line: string) {
  if (line.length < 2 || line.length > 48 || /\d|[.!?,:;()[\]{}]/u.test(line)) return false;
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 4) return false;
  if (/^(?:THE END|CONTENTS|TABLE OF CONTENTS|ACKNOWLEDGEMENTS?)$/u.test(line)) return false;
  const letters = line.replace(/[^\p{L}]/gu, "");
  return letters.length >= 2 && letters === letters.toLocaleUpperCase();
}

function candidateLineEnd(text: string, start: number) {
  const newline = text.indexOf("\n", start);
  const formFeed = text.indexOf("\f", start);
  const bullets = ["●", "•", "▪", "◦"]
    .map((bullet) => text.indexOf(bullet, start))
    .filter((index) => index >= 0);
  return Math.min(
    ...[newline, formFeed, ...bullets, text.length].filter((index) => index >= 0),
  );
}

/** Consume heading-like words without swallowing compact PDF body prose. */
function headingSuffix(text: string, markerEnd: number, boundaryEnd: number) {
  const raw = text.slice(markerEnd, Math.min(boundaryEnd, markerEnd + 220));
  const withoutSeparator = raw.replace(/^\s*[:—–-]\s*/u, "");
  const separatorWasPresent = withoutSeparator !== raw;
  const compact = withoutSeparator.replace(/\s+/g, " ").trim();
  if (!compact) return { suffix: "", consumed: raw.length };

  const lineBounded = boundaryEnd < text.length && /[\r\n\f]/u.test(text[boundaryEnd] ?? "");
  const looksLikeOneHeading =
    lineBounded && compact.length <= 150 && !/[.!?](?:\s|$)/u.test(compact);
  if (looksLikeOneHeading) {
    return { suffix: compact.replace(/\s+\d{1,4}$/u, "").trim(), consumed: raw.length };
  }

  const proseBoundary = compact.search(
    /\s+(?=(?:He|How|I|It|She|They|We|What|When|Where|Who|Why|You)\s+(?:a|an|are|can|could|did|do|does|had|has|have|is|might|must|should|the|was|were|will|would|[\p{Ll}]{3,})\b)/u,
  );
  const headingLikePrefix = proseBoundary > 0 ? compact.slice(0, proseBoundary) : compact;
  const titleMatch = headingLikePrefix.match(titleWordPattern)?.[0] ?? "";
  const perspective = compact.slice(titleMatch.length).match(/^\s*(\([^)]{1,100}\))/u)?.[1] ?? "";
  const suffix = `${titleMatch}${perspective ? ` ${perspective}` : ""}`.trim();
  if (!suffix || (!separatorWasPresent && titleMatch.split(/\s+/).length > 8)) {
    return { suffix: "", consumed: raw.length - raw.trimStart().length };
  }
  const suffixStart = raw.indexOf(withoutSeparator) + withoutSeparator.indexOf(compact);
  return { suffix, consumed: suffixStart + suffix.length };
}

function parseCandidate(text: string, markerStart: number): HeadingCandidate | null {
  const boundaryEnd = candidateLineEnd(text, markerStart);
  const segment = text.slice(markerStart, boundaryEnd).trim();
  if (!segment) return null;

  for (const pattern of povHeadingPatterns) {
    const match = segment.match(pattern);
    if (!match) continue;
    const perspective = match[1]!.replace(/\s+/g, " ").trim();
    return {
      baseKey: `pov-${slug(perspective)}`,
      marker: `POV: ${perspective}`,
      title: perspective,
      kind: "pov",
      perspective,
      index: markerStart,
      bodyStart: boundaryEnd,
    };
  }

  const explicit = segment.match(explicitHeadingPattern);
  if (!explicit) {
    if (!isBareUppercasePerspective(segment)) return null;
    const perspective = segment
      .toLocaleLowerCase()
      .replace(/(?:^|\s)\p{L}/gu, (letter) => letter.toLocaleUpperCase());
    return {
      baseKey: `pov-${slug(perspective)}`,
      marker: perspective,
      title: perspective,
      kind: "pov",
      perspective,
      index: markerStart,
      bodyStart: boundaryEnd,
    };
  }
  const fixed = explicit[1]?.toLocaleLowerCase();
  const numberedKind = explicit[2]?.toLocaleLowerCase();
  const interlude = explicit[4]?.toLocaleLowerCase();
  const kind = (fixed ?? numberedKind ?? interlude) as HeadingCandidate["kind"];
  const ordinal = explicit[3] ?? explicit[5] ?? "";
  const marker = capitalizeMarker(
    fixed ?? `${numberedKind ?? interlude}${ordinal ? ` ${ordinal}` : ""}`,
  );
  const markerEnd = markerStart + explicit[0].length;
  const { suffix, consumed } = headingSuffix(text, markerEnd, boundaryEnd);
  const title = suffix ? `${marker} — ${suffix}` : marker;
  const lineBounded = boundaryEnd < text.length && /[\r\n\f]/u.test(text[boundaryEnd] ?? "");
  return {
    baseKey: slug(marker),
    marker,
    title,
    kind,
    perspective: perspectiveFromTitle(title),
    index: markerStart,
    bodyStart: lineBounded ? boundaryEnd + 1 : markerEnd + consumed,
  };
}

function headingCandidates(text: string) {
  const candidates: HeadingCandidate[] = [];
  boundaryPattern.lastIndex = 0;
  let boundary: RegExpExecArray | null;
  while ((boundary = boundaryPattern.exec(text)) !== null) {
    const markerStart = boundary.index + boundary[0].length;
    const candidate = parseCandidate(text, markerStart);
    if (candidate && candidates.at(-1)?.index !== candidate.index) candidates.push(candidate);
    if (boundary[0].length === 0) boundaryPattern.lastIndex += 1;
  }
  // Some PDF/DOCX extractors collapse an entire page into one line. When at
  // least two strongly formatted inline headings exist, recover them without
  // treating an ordinary prose reference such as "in Chapter 4" as a split.
  const inlinePattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:(?:chapter|part)\\s+${ordinalToken}|interlude(?:\\s+${ordinalToken})?)(?=\\s*(?:[:â€”â€“-]|\\())`,
    "giu",
  );
  const inlineStarts = [...text.matchAll(inlinePattern)]
    .map((match) => match.index)
    .filter((index): index is number => index !== undefined);
  if (inlineStarts.length >= 2) {
    for (const markerStart of inlineStarts) {
      if (candidates.some((candidate) => candidate.index === markerStart)) continue;
      const candidate = parseCandidate(text, markerStart);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates.sort((left, right) => left.index - right.index);
}

function proseBetween(text: string, candidate: HeadingCandidate, next?: HeadingCandidate) {
  return text.slice(candidate.bodyStart, next?.index ?? text.length).trim();
}

function tableOfContentsIndexes(text: string, candidates: HeadingCandidate[]) {
  const ignored = new Set<number>();
  const signatures = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const signature = `${candidate.baseKey}:${slug(candidate.title)}`;
    const indexes = signatures.get(signature) ?? [];
    indexes.push(index);
    signatures.set(signature, indexes);
  });

  candidates.forEach((candidate, index) => {
    const signature = `${candidate.baseKey}:${slug(candidate.title)}`;
    const repeatedLater = (signatures.get(signature) ?? []).some((other) => other > index);
    if (!repeatedLater) return;
    const between = proseBetween(text, candidate, candidates[index + 1]);
    const words = between.replace(/\d{1,4}\s*$/u, "").match(/[\p{L}\p{N}’'-]+/gu) ?? [];
    const crowded = (candidates[index + 1]?.index ?? text.length) - candidate.index < 240;
    const containsSentence = /[.!?]["'”’)]?(?:\s|$)/u.test(between);
    if (words.length <= 12 && crowded && !containsSentence) ignored.add(index);
  });
  return ignored;
}

export function createFileNarrativeSection(
  text: string,
  sourceTitle: string,
  sourceKey?: string,
): NarrativeSection | null {
  const body = text.trim();
  if (!body) return null;
  const title = sourceTitle.trim().replace(/\.[a-z0-9]{1,8}$/iu, "") || "Untitled chapter";
  return {
    key: sourceKey ? slug(sourceKey) : `file-${slug(title)}`,
    title,
    body,
    order: 0,
    sourceOffset: text.indexOf(body),
    endOffset: text.indexOf(body) + body.length,
    kind: "file",
    marker: title,
    perspective: perspectiveFromTitle(title),
  };
}

/**
 * Finds narrative sections at structural boundaries. Repeated labels are
 * preserved; only compact, repeated table-of-contents entries are ignored.
 */
export function parseNarrativeSections(
  text: string,
  options: NarrativeParseOptions = {},
): NarrativeSection[] {
  const candidates = headingCandidates(text);
  const ignored = tableOfContentsIndexes(text, candidates);
  const selected = candidates.filter((_, index) => !ignored.has(index));
  const occurrences = new Map<string, number>();

  const sections = selected
    .map((candidate, index) => {
      const bodyEnd = selected[index + 1]?.index ?? text.length;
      const body = text.slice(candidate.bodyStart, bodyEnd).trim();
      const occurrence = (occurrences.get(candidate.baseKey) ?? 0) + 1;
      occurrences.set(candidate.baseKey, occurrence);
      return {
        key: occurrence === 1 ? candidate.baseKey : `${candidate.baseKey}-${occurrence}`,
        title: candidate.title,
        body,
        order: index,
        sourceOffset: candidate.index,
        endOffset: bodyEnd,
        kind: candidate.kind,
        marker: candidate.marker,
        perspective: candidate.perspective,
      } satisfies NarrativeSection;
    })
    .filter((section) => section.body.length > 0);

  if (sections.length || !options.fallbackToSource || !options.sourceTitle) return sections;
  const fallback = createFileNarrativeSection(text, options.sourceTitle, options.sourceKey);
  return fallback ? [fallback] : [];
}

function sentenceList(body: string) {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  return [...segmenter.segment(normalized)]
    .map(({ segment }) => segment.trim().replace(/^\d{1,4}\s+/, ""))
    .filter((sentence) => sentence.length >= 20 && sentence.length <= 500);
}

function compactSentence(sentence: string, maximum = 280) {
  if (sentence.length <= maximum) return sentence;
  const clipped = sentence.slice(0, maximum);
  const boundary = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, Math.max(boundary, 160)).trim()}…`;
}

function eventScore(sentence: string) {
  const eventTerms = sentence.match(/\b(?:arriv|attack|betray|break|capture|chang|confront|decid|destroy|discover|escape|find|flee|kill|learn|leave|meet|open|realiz|rescu|return|reveal|save|search|transform|travel|warn)\w*/giu)?.length ?? 0;
  const names = sentence.match(/\b[\p{Lu}][\p{L}’'-]{2,}\b/gu)?.length ?? 0;
  const dialoguePenalty = /^[“"']/u.test(sentence) ? 2 : 0;
  return eventTerms * 3 + Math.min(names, 5) - dialoguePenalty;
}

/** A zero-cost, source-grounded digest that an AI pass can later rewrite. */
export function summarizeNarrativeSection(body: string) {
  const sentences = sentenceList(body);
  if (!sentences.length) return "This section was indexed, but its extracted text did not contain a stable prose digest.";
  const opening = sentences.slice(0, Math.min(4, sentences.length)).sort((a, b) => eventScore(b) - eventScore(a))[0]!;
  const middleStart = Math.floor(sentences.length * 0.25);
  const middleEnd = Math.max(middleStart + 1, Math.ceil(sentences.length * 0.8));
  const development = sentences
    .slice(middleStart, middleEnd)
    .map((sentence, index) => ({ sentence, index, score: eventScore(sentence) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.sentence;
  const closing = [...sentences.slice(Math.max(0, sentences.length - 5))]
    .sort((a, b) => eventScore(b) - eventScore(a))[0];
  const chosen = [opening, development, closing].filter((sentence, index, all): sentence is string =>
    Boolean(sentence) && all.findIndex((candidate) => candidate === sentence) === index,
  );
  return chosen.map((sentence) => compactSentence(sentence)).join(" ");
}
