const MINIMUM_NARRATIVE_WORDS = 120;
const SHINGLE_SIZE = 12;
export const AUTHOR_STORY_DRAFT_MIN_WORDS = 1_000;
export const AUTHOR_STORY_DRAFT_MIN_TURNS = 6;

const SHEET_FIELD_PATTERN = /\b(?:name|full name|alias|age|birthday|gender|pronouns|race|species|class|level|alignment|occupation|role|height|weight|eyes?|hair|appearance|personality|traits?|strength|dexterity|constitution|intelligence|wisdom|charisma|acrobatics|armor class|hit points?|abilities|powers?|equipment|inventory|weapons?|skills?|background|history|biography|bio|relationships?|allies|enemies|faction|goals?|motivation|flaws?)\s*:/giu;
const SHEET_LINE_PATTERN = /^\s*(?:[-*#]+\s*)?(?:name|alias|age|gender|pronouns|race|species|class|level|alignment|occupation|role|height|weight|eyes?|hair|appearance|personality|traits?|strength|dexterity|constitution|intelligence|wisdom|charisma|acrobatics|armor class|hit points?|abilities|powers?|equipment|inventory|weapons?|skills?|background|history|biography|bio|relationships?|allies|enemies|faction|goals?|motivation|flaws?)\s*:/iu;
const LOREM_PATTERN = /\b(?:lorem ipsum|dolor sit amet|consectetur adipiscing elit)\b/giu;
const COMMON_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for",
  "from", "had", "has", "have", "he", "her", "hers", "him", "his", "i", "in",
  "is", "it", "its", "me", "my", "not", "of", "on", "or", "our", "she", "so",
  "that", "the", "their", "them", "there", "they", "this", "to", "was", "we",
  "were", "what", "when", "with", "you", "your",
]);

export type NarrativeQualificationReason =
  | "too_short"
  | "placeholder_text"
  | "repeated_text"
  | "low_language_variety"
  | "character_sheet_structure"
  | "insufficient_continuous_prose";

export type NarrativeQualification = {
  qualifies: boolean;
  score: number;
  wordCount: number;
  qualifyingWordCount: number;
  reasons: NarrativeQualificationReason[];
  explanation: string;
  metrics: {
    sentenceCount: number;
    sentenceDensity: number;
    lexicalDiversity: number;
    repeatedShingleRatio: number;
    sheetFieldCount: number;
    sheetLineRatio: number;
    placeholderCount: number;
    dominantContentWordRatio: number;
  };
};

export type AuthorManuscriptSource = {
  id?: unknown;
  title?: unknown;
  extracted_text?: unknown;
  word_count?: unknown;
  processing_status?: unknown;
  source_kind?: unknown;
  canon_status?: unknown;
};

export type AuthorManuscriptAssessment = {
  sourceId: string;
  title: string;
  wordCount: number;
  qualifyingWordCount: number;
  qualifies: boolean;
  score: number;
  reasons: NarrativeQualificationReason[];
  explanation: string;
};

export type AuthorManuscriptSummary = {
  uploadedManuscriptWordCount: number;
  qualifiedManuscriptWordCount: number;
  qualifiedSourceCount: number;
  rejectedSourceCount: number;
  assessments: AuthorManuscriptAssessment[];
};

export type StoryDraftAuthorAccessSource = {
  prose?: unknown;
  source_turn_ids?: unknown;
  status?: unknown;
};

function wordsFrom(text: string): string[] {
  return text.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
}

function sentenceCountFrom(text: string): number {
  const matches = text.match(/[.!?…]+(?:["'”’)]*)?(?=\s|$)/g);
  return matches?.length ?? 0;
}

function repeatedShingleRatio(words: string[]): number {
  if (words.length < SHINGLE_SIZE * 2) return 0;
  const seen = new Set<string>();
  let repeated = 0;
  let total = 0;
  for (let index = 0; index <= words.length - SHINGLE_SIZE; index += SHINGLE_SIZE) {
    const shingle = words.slice(index, index + SHINGLE_SIZE).join(" ");
    total += 1;
    if (seen.has(shingle)) repeated += 1;
    else seen.add(shingle);
  }
  return total > 0 ? repeated / total : 0;
}

function boundedScore(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function explanationFor(reasons: NarrativeQualificationReason[]): string {
  if (reasons.includes("placeholder_text"))
    return "Placeholder text does not count as narrative manuscript material.";
  if (reasons.includes("repeated_text"))
    return "Too much of this source repeats the same wording to count as sustained narrative.";
  if (reasons.includes("character_sheet_structure"))
    return "This reads primarily as character-sheet or template fields rather than continuous story prose.";
  if (reasons.includes("low_language_variety"))
    return "The wording is too repetitive to establish genuine narrative material.";
  if (reasons.includes("insufficient_continuous_prose"))
    return "Storyhold could not find enough continuous sentences to treat this as narrative prose.";
  if (reasons.includes("too_short"))
    return `This source is under ${MINIMUM_NARRATIVE_WORDS} words, so it is too short to verify as narrative by itself.`;
  return "This source contains enough varied, continuous prose to count toward Author mode.";
}

export function assessNarrativeManuscript(textValue: unknown): NarrativeQualification {
  const text = typeof textValue === "string" ? textValue.trim() : "";
  const words = wordsFrom(text);
  const wordCount = words.length;
  const sentenceCount = sentenceCountFrom(text);
  const sentenceDensity = wordCount > 0 ? (sentenceCount * 1_000) / wordCount : 0;
  // Type-token ratios naturally shrink across book-length corpora. A bounded
  // sample keeps a long, legitimate novel from looking repetitive merely
  // because it contains far more words than a chapter upload.
  const lexicalSample = words.slice(0, 20_000);
  const lexicalDiversity = lexicalSample.length > 0
    ? new Set(lexicalSample).size / lexicalSample.length
    : 0;
  const repeatedRatio = repeatedShingleRatio(words);
  const sheetFieldCount = [...text.matchAll(SHEET_FIELD_PATTERN)].length;
  const meaningfulLines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const sheetLineCount = meaningfulLines.filter((line) => SHEET_LINE_PATTERN.test(line)).length;
  const sheetLineRatio = meaningfulLines.length > 0 ? sheetLineCount / meaningfulLines.length : 0;
  const placeholderCount = [...text.matchAll(LOREM_PATTERN)].length;
  const contentCounts = new Map<string, number>();
  for (const word of words) {
    if (word.length < 3 || COMMON_WORDS.has(word)) continue;
    contentCounts.set(word, (contentCounts.get(word) ?? 0) + 1);
  }
  const dominantContentWordCount = Math.max(0, ...contentCounts.values());
  const dominantContentWordRatio = wordCount > 0 ? dominantContentWordCount / wordCount : 0;
  const sheetFieldsPerThousand = wordCount > 0 ? (sheetFieldCount * 1_000) / wordCount : 0;

  const reasons: NarrativeQualificationReason[] = [];
  if (wordCount < MINIMUM_NARRATIVE_WORDS) reasons.push("too_short");
  if (placeholderCount >= 2 || (placeholderCount >= 1 && wordCount < 1_000))
    reasons.push("placeholder_text");
  if (repeatedRatio >= 0.42 || dominantContentWordRatio >= 0.12)
    reasons.push("repeated_text");
  if (wordCount >= MINIMUM_NARRATIVE_WORDS && lexicalDiversity < 0.055)
    reasons.push("low_language_variety");
  if (
    (sheetFieldCount >= 8 && sheetLineRatio >= 0.3) ||
    (sheetFieldCount >= 14 && sheetFieldsPerThousand >= 12)
  ) reasons.push("character_sheet_structure");
  if (
    wordCount >= MINIMUM_NARRATIVE_WORDS &&
    (sentenceCount < 3 || sentenceDensity < 2.5)
  ) reasons.push("insufficient_continuous_prose");

  let score = 0;
  if (wordCount >= MINIMUM_NARRATIVE_WORDS) score += 0.2;
  if (sentenceCount >= 3 && sentenceDensity >= 2.5) score += 0.25;
  if (lexicalDiversity >= 0.055) score += 0.2;
  if (repeatedRatio < 0.25 && dominantContentWordRatio < 0.08) score += 0.2;
  if (sheetLineRatio < 0.3 && sheetFieldsPerThousand < 12) score += 0.15;
  score = boundedScore(score);
  const qualifies = reasons.length === 0 && score >= 0.75;

  return {
    qualifies,
    score,
    wordCount,
    qualifyingWordCount: qualifies ? wordCount : 0,
    reasons,
    explanation: explanationFor(reasons),
    metrics: {
      sentenceCount,
      sentenceDensity: boundedScore(sentenceDensity / 100) * 100,
      lexicalDiversity: boundedScore(lexicalDiversity),
      repeatedShingleRatio: boundedScore(repeatedRatio),
      sheetFieldCount,
      sheetLineRatio: boundedScore(sheetLineRatio),
      placeholderCount,
      dominantContentWordRatio: boundedScore(dominantContentWordRatio),
    },
  };
}

export function summarizeAuthorManuscripts(
  sources: AuthorManuscriptSource[],
): AuthorManuscriptSummary {
  const assessments: AuthorManuscriptAssessment[] = [];
  for (const source of sources) {
    if (
      source.processing_status !== "ready" ||
      source.source_kind !== "manuscript" ||
      source.canon_status === "reference" ||
      source.canon_status === "excluded"
    ) continue;
    const assessment = assessNarrativeManuscript(source.extracted_text);
    const storedWordCount = Number(source.word_count);
    const sourceWordCount = Number.isFinite(storedWordCount) && storedWordCount >= 0
      ? Math.floor(storedWordCount)
      : assessment.wordCount;
    assessments.push({
      sourceId: typeof source.id === "string" ? source.id : "",
      title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : "Untitled source",
      wordCount: sourceWordCount,
      qualifyingWordCount: assessment.qualifies ? sourceWordCount : 0,
      qualifies: assessment.qualifies,
      score: assessment.score,
      reasons: assessment.reasons,
      explanation: assessment.explanation,
    });
  }
  return {
    uploadedManuscriptWordCount: assessments.reduce((total, item) => total + item.wordCount, 0),
    qualifiedManuscriptWordCount: assessments.reduce((total, item) => total + item.qualifyingWordCount, 0),
    qualifiedSourceCount: assessments.filter((item) => item.qualifies).length,
    rejectedSourceCount: assessments.filter((item) => !item.qualifies).length,
    assessments,
  };
}

export function storyDraftUnlocksAuthorMode(
  draft: StoryDraftAuthorAccessSource,
): boolean {
  if (draft.status === "archived") return false;
  const sourceTurnIds = Array.isArray(draft.source_turn_ids)
    ? draft.source_turn_ids.filter((item) => typeof item === "string")
    : [];
  if (sourceTurnIds.length < AUTHOR_STORY_DRAFT_MIN_TURNS) return false;
  const assessment = assessNarrativeManuscript(draft.prose);
  return assessment.qualifies && assessment.wordCount >= AUTHOR_STORY_DRAFT_MIN_WORDS;
}
