import { createHash } from "node:crypto";

// Paragraph- and chapter-aware chunks sized for embedding. Structural metadata
// is returned to callers without requiring a database migration; stores that
// do not yet persist it can continue using the original four fields.

const TARGET_CHARS = 1200;
const MAX_CHARS = 1800;
const MAX_OVERLAP_CHARS = 360;

export interface TextChunkMetadata {
  sectionKey: string | null;
  sectionTitle: string | null;
  sectionIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  overlapStartOffset: number | null;
  overlapCharCount: number;
}

export interface TextChunk {
  index: number;
  content: string;
  contentHash: string;
  charCount: number;
  metadata: TextChunkMetadata;
}

type Span = { text: string; start: number; end: number };
type StructuralSection = {
  key: string | null;
  title: string | null;
  index: number;
  start: number;
  end: number;
};
type RawChunk = Span & Pick<StructuralSection, "key" | "title" | "index">;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sectionSlug(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

const structuralHeadingPattern = /^[ \t]*(?:#{1,6}\s*)?(?:(?:chapter|part)\s+(?:\d{1,4}|[ivxlcdm]{1,12}|[a-z]+(?:[- ][a-z]+){0,3})|prologue|epilogue|requiem|interlude(?:\s+(?:\d{1,4}|[ivxlcdm]{1,12}|[a-z]+))?|pov\s*[:—–-]\s*[\p{L}][^\n]{0,80}|[\p{L}][\p{L}\p{M}’'. -]{0,60}\s+(?:\(pov\)|pov))[ \t]*(?:[:—–-][ \t]*[^\n]{1,120})?[ \t]*$/gimu;

function structuralSections(text: string): StructuralSection[] {
  const headings: Array<{ start: number; end: number; title: string }> = [];
  structuralHeadingPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = structuralHeadingPattern.exec(text)) !== null) {
    const title = match[0].trim().replace(/^#{1,6}\s*/u, "");
    headings.push({ start: match.index, end: match.index + match[0].length, title });
  }
  if (!headings.length) {
    return [{ key: null, title: null, index: 0, start: 0, end: text.length }];
  }

  const sections: StructuralSection[] = [];
  if (text.slice(0, headings[0]!.start).trim()) {
    sections.push({ key: "front-matter", title: "Front matter", index: 0, start: 0, end: headings[0]!.start });
  }
  const occurrences = new Map<string, number>();
  for (const heading of headings) {
    const baseKey = sectionSlug(heading.title);
    const occurrence = (occurrences.get(baseKey) ?? 0) + 1;
    occurrences.set(baseKey, occurrence);
    sections.push({
      key: occurrence === 1 ? baseKey : `${baseKey}-${occurrence}`,
      title: heading.title,
      index: sections.length,
      start: heading.start,
      end: text.length,
    });
  }
  for (let index = 0; index < sections.length - 1; index += 1) {
    sections[index]!.end = sections[index + 1]!.start;
  }
  return sections;
}

function trimmedSpan(text: string, absoluteStart: number): Span | null {
  const leading = text.length - text.trimStart().length;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return {
    text: trimmed,
    start: absoluteStart + leading,
    end: absoluteStart + leading + trimmed.length,
  };
}

function paragraphSpans(text: string, start: number, end: number): Span[] {
  const sectionText = text.slice(start, end);
  const spans: Span[] = [];
  const pattern = /\S[\s\S]*?(?=\n{2,}|$)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sectionText)) !== null) {
    const span = trimmedSpan(match[0], start + match.index);
    if (span) spans.push(span);
  }
  return spans;
}

function wordSafePieces(text: string, absoluteStart: number): Span[] {
  const pieces: Span[] = [];
  let localStart = 0;
  while (text.length - localStart > MAX_CHARS) {
    const window = text.slice(localStart, localStart + MAX_CHARS);
    let cut = window.lastIndexOf(" ");
    if (cut < TARGET_CHARS) cut = MAX_CHARS;
    const span = trimmedSpan(text.slice(localStart, localStart + cut), absoluteStart + localStart);
    if (span) pieces.push(span);
    localStart += cut;
    while (/\s/u.test(text[localStart] ?? "")) localStart += 1;
  }
  const tail = trimmedSpan(text.slice(localStart), absoluteStart + localStart);
  if (tail) pieces.push(tail);
  return pieces;
}

/** Split a long paragraph at sentence boundaries, then at words only if needed. */
function sentenceSafePieces(span: Span): Span[] {
  if (span.text.length <= MAX_CHARS) return [span];
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const sentences: Span[] = [];
  for (const segment of segmenter.segment(span.text)) {
    const sentence = trimmedSpan(segment.segment, span.start + segment.index);
    if (!sentence) continue;
    if (sentence.text.length > MAX_CHARS) sentences.push(...wordSafePieces(sentence.text, sentence.start));
    else sentences.push(sentence);
  }

  const pieces: Span[] = [];
  let buffer: Span | null = null;
  for (const sentence of sentences) {
    if (!buffer) {
      buffer = sentence;
    } else if (buffer.text.length + sentence.text.length + 1 <= TARGET_CHARS) {
      buffer = { text: `${buffer.text} ${sentence.text}`, start: buffer.start, end: sentence.end };
    } else {
      pieces.push(buffer);
      buffer = sentence;
    }
  }
  if (buffer) pieces.push(buffer);
  return pieces;
}

function rawChunksForSection(text: string, section: StructuralSection): RawChunk[] {
  const pieces = paragraphSpans(text, section.start, section.end).flatMap(sentenceSafePieces);
  const chunks: RawChunk[] = [];
  let buffer: Span | null = null;
  for (const piece of pieces) {
    if (!buffer) {
      buffer = piece;
    } else if (buffer.text.length + piece.text.length + 2 <= TARGET_CHARS) {
      buffer = { text: `${buffer.text}\n\n${piece.text}`, start: buffer.start, end: piece.end };
    } else {
      chunks.push({ ...buffer, key: section.key, title: section.title, index: section.index });
      buffer = piece;
    }
  }
  if (buffer) chunks.push({ ...buffer, key: section.key, title: section.title, index: section.index });
  return chunks;
}

function completeSentenceOverlap(previous: RawChunk, nextLength: number) {
  if (previous.text.length === 0 || nextLength >= MAX_CHARS) return null;
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  const sentences = [...segmenter.segment(previous.text)]
    .map((segment) => ({ text: segment.segment.trim(), index: segment.index }))
    .filter((sentence) => sentence.text.length > 0);
  let overlap = "";
  let localStart = previous.text.length;
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    const sentence = sentences[index]!;
    const candidate = overlap ? `${sentence.text} ${overlap}` : sentence.text;
    if (candidate.length > MAX_OVERLAP_CHARS || nextLength + candidate.length + 2 > MAX_CHARS) break;
    overlap = candidate;
    localStart = sentence.index;
  }
  if (!overlap) return null;
  return { text: overlap, start: previous.start + localStart };
}

/**
 * Chunk extracted text without crossing detected chapter/part boundaries.
 * Long prose is split at sentence or word boundaries, and overlap consists of
 * complete sentences from the same structural section.
 */
export function chunkText(text: string): TextChunk[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const rawChunks = structuralSections(normalized).flatMap((section) =>
    rawChunksForSection(normalized, section),
  );
  return rawChunks.map((raw, index) => {
    const previous = rawChunks[index - 1];
    const canOverlap = previous && previous.key === raw.key;
    const overlap = canOverlap ? completeSentenceOverlap(previous, raw.text.length) : null;
    const content = `${overlap ? `${overlap.text}\n\n` : ""}${raw.text}`.trim();
    return {
      index,
      content,
      contentHash: sha256(content),
      charCount: content.length,
      metadata: {
        sectionKey: raw.key,
        sectionTitle: raw.title,
        sectionIndex: raw.index,
        sourceStartOffset: raw.start,
        sourceEndOffset: raw.end,
        overlapStartOffset: overlap?.start ?? null,
        overlapCharCount: overlap?.text.length ?? 0,
      },
    };
  });
}
