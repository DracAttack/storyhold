/**
 * Shared acronym and mixed-case token map used by both the API server (concept
 * title-casing) and the reader site (headline title-casing).
 *
 * Key   = lowercase-normalised form of the token (no leading punctuation).
 * Value = canonical display form.
 *
 * Rule of thumb for entries: add a token here when it could arrive stored
 * entirely in lowercase (e.g. "covid", "ai") and must be rendered in a
 * specific capitalisation.  Tokens that already carry an uppercase letter after
 * their first character (e.g. "ADHD", "DSM-5") are handled by the "existing
 * uppercase" guard in the title-case functions and do NOT need an entry here.
 */
export const ACRONYMS: Record<string, string> = {
  // Science & medicine
  dna: "DNA",
  rna: "RNA",
  covid: "COVID",
  hiv: "HIV",
  aids: "AIDS",
  ibd: "IBD",
  adhd: "ADHD",
  scfas: "SCFAs",
  tnf: "TNF",
  "tnf-α": "TNF-α",
  // Space & tech
  jwst: "JWST",
  nasa: "NASA",
  ai: "AI",
  api: "API",
  llm: "LLM",
  npc: "NPC",
  npcs: "NPCs",
  rpg: "RPG",
  ui: "UI",
  uap: "UAP",
  uaps: "UAPs",
  // Government / law
  ftc: "FTC",
  fbi: "FBI",
  cia: "CIA",
  doj: "DOJ",
  epa: "EPA",
  sec: "SEC",
  nsa: "NSA",
  // Geography (abbreviations used as adjectives/nouns)
  uk: "UK",
  eu: "EU",
  un: "UN",
};

/**
 * Chicago-style headline capitalization for shared product UI and editorial
 * titles. Existing mixed case is preserved so names such as xAI, GLiNER2, and
 * Storyhold are never flattened, while the acronym map repairs lowercase API,
 * AI, NPC, RPG, and similar tokens.
 */
export function toChicagoTitleCase(title: string): string {
  if (!title) return title;
  const normalised = title.replace(/\\'/g, "'").replace(/''/g, "'");
  const minorWords = new Set([
    "a", "an", "the",
    "and", "as", "but", "for", "nor", "or", "so", "yet",
    "at", "by", "from", "in", "into", "of", "on", "onto", "per", "to", "up", "via", "vs", "with",
  ]);
  const tokens = normalised.split(/(\s+|\u2014)/);
  const isSeparator = (token: string) => /^\s+$/.test(token) || token === "\u2014";
  const wordCount = tokens.filter((token) => token.length > 0 && !isSeparator(token)).length;
  let wordIndex = 0;
  let capitalizeNext = false;

  return tokens.map((token) => {
    if (!token || /^\s+$/.test(token)) return token;
    if (token === "\u2014") {
      capitalizeNext = true;
      return token;
    }
    const first = wordIndex === 0;
    const last = wordIndex === wordCount - 1;
    const forced = capitalizeNext;
    capitalizeNext = /[.?!:]$/.test(token);
    wordIndex += 1;

    const match = token.match(/^([^a-zA-Z]*)([a-zA-Z][\s\S]*)$/);
    if (!match) return token;
    const [, lead, word] = match;
    if (/\d/.test(lead) || /[A-Z]/.test(word.slice(1))) return token;
    const lower = word.toLowerCase();
    const pure = lower.replace(/[^\p{L}\p{N}'-]+$/u, "");
    const tail = lower.slice(pure.length);
    if (Object.prototype.hasOwnProperty.call(ACRONYMS, pure)) {
      return lead + ACRONYMS[pure]! + tail;
    }
    if (first || last || forced || !minorWords.has(pure)) {
      return lead + lower.charAt(0).toUpperCase() + lower.slice(1);
    }
    return lead + lower;
  }).join("");
}
