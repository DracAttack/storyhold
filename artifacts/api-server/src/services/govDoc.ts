// --- GovInfo document helpers (pure, logger-free, unit-testable) ---------
//
// GovInfo RSS items arrive titled with an opaque serial ("Congressional Report
// 119hrpt721", "Presidential Document 202600353") while the REAL subject sits
// at the top of the extracted text behind a fixed masthead. Two problems flow
// from that:
//   1. Editor surfaces (cluster labels, cockpit angles, source lists) show the
//      serial — an editor cannot tell what story the document is about.
//   2. The masthead boilerplate ("119TH CONGRESS", "HOUSE OF REPRESENTATIVES",
//      "Committed to the Committee of the Whole House…") dominates the token
//      set, so DIFFERENT reports look alike to the clusterer and false-merge
//      into giant junk clusters ("58 sources across 58 outlets", all one
//      domain). Same failure mode as the Wikipedia masthead false-merge.
//
// `govDocSubject` extracts a human-readable subject from the extracted text;
// `stripGovBoilerplate` removes the shared masthead vocabulary before
// clustering tokenization so only the document's actual subject drives
// cluster matching.

const GOV_DOMAINS = new Set(["govinfo.gov", "www.govinfo.gov"]);

/** True when the document came from GovInfo (the official US publishing feed). */
export function isGovInfoDoc(domain: string | null | undefined): boolean {
  return !!domain && GOV_DOMAINS.has(domain.toLowerCase());
}

// Serial-style titles the GovInfo feed resolver assigns when no better title
// exists. These carry zero editorial context.
const SERIAL_TITLE_RE =
  /^(Congressional (?:Report|Hearing|Record)|Congressionally Mandated Report|Presidential Document|Public Law|Federal Register)\b[\s:]*[A-Za-z0-9_.-]*$/i;

/** True when a title is an opaque GovInfo serial (no human-readable subject). */
export function isGovSerialTitle(title: string | null | undefined): boolean {
  return !!title && SERIAL_TITLE_RE.test(title.trim());
}

const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December";
const MONTH_DATE_RE = new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2},\\s+\\d{4}`, "i");

const MAX_SUBJECT_CHARS = 140;
const MIN_SUBJECT_CHARS = 12;

/** Title-case an ALL-CAPS heading; leaves mixed-case text untouched. */
function humanizeCase(s: string): string {
  const letters = s.replace(/[^A-Za-z]/g, "");
  if (!letters || letters !== letters.toUpperCase()) return s;
  const SMALL = new Set([
    "a", "an", "and", "as", "at", "but", "by", "for", "in", "into", "of",
    "on", "or", "the", "to", "with",
  ]);
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => {
      if (i > 0 && SMALL.has(w)) return w;
      // Keep obvious acronyms/codes (contain digits or all-consonant shorts) upper.
      if (/\d/.test(w) || /^(us|usa|va|ai|fbi|cia|nasa|epa|fda|dod|dhs|irs|un|eu|uk|hr)$/.test(w))
        return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/** Trim a candidate subject to a bounded, tidy display string (word boundary). */
function boundSubject(raw: string): string | null {
  const s = raw.replace(/\s+/g, " ").replace(/[\s.,;:—–-]+$/g, "").trim();
  if (s.length < MIN_SUBJECT_CHARS) return null;
  if (s.length <= MAX_SUBJECT_CHARS) return humanizeCase(s);
  const cut = s.slice(0, MAX_SUBJECT_CHARS);
  const atWord = cut.slice(0, cut.lastIndexOf(" "));
  return humanizeCase(atWord.replace(/[\s.,;:—–-]+$/g, "")) + "…";
}

/**
 * Extract a human-readable subject from a GovInfo document's extracted text.
 * Returns null when no confident subject is found (callers keep the serial).
 *
 * Formats handled (validated against production GovInfo documents):
 *  - Presidential Document: "1 Administration of <President>, <year> <Subject>
 *    <Month D, YYYY> …" — subject sits between the administration line and the
 *    first full date.
 *  - Congressional Report: "69–006 119TH CONGRESS REPORT … 2d Session 119–585
 *    <ALL-CAPS SUBJECT> <MONTH D, YYYY>.—Committed …" — subject sits between
 *    the session serial and the date line.
 *  - Congressional Hearing: "U.S. GOVERNMENT PUBLISHING OFFICE WASHINGTON :… 
 *    <ALL-CAPS SUBJECT> HEARING(S) BEFORE …" — subject sits before
 *    "HEARING(S) BEFORE".
 */
export function govDocSubject(extractedText: string | null | undefined): string | null {
  if (!extractedText) return null;
  const head = extractedText.slice(0, 1200).replace(/\s+/g, " ").trim();
  if (!head) return null;

  // Presidential Document (remarks, news conferences, EOs in the daily comp).
  {
    const m = head.match(
      new RegExp(`Administration of [^,]{1,60}, \\d{4}\\s+(.+?)(?=\\s+(?:${MONTHS})\\s+\\d{1,2},\\s+\\d{4})`, "i"),
    );
    if (m?.[1]) {
      const s = boundSubject(m[1]);
      if (s) return s;
    }
  }

  // Congressional Report: subject between "…Session 119–585" and the date.
  {
    const m = head.match(
      new RegExp(`Session\\s+\\d+[–—-]\\d+\\s+(.+?)(?=\\s+(?:${MONTHS})\\s+\\d{1,2},\\s+\\d{4}|\\s*\\.\\s*[–—-])`, "i"),
    );
    if (m?.[1]) {
      const s = boundSubject(m[1]);
      if (s) return s;
    }
  }

  // Congressional Hearing: subject before "HEARING(S) BEFORE".
  {
    const m = head.match(/^(.*?)\s+HEARINGS?\s+BEFORE\b/i);
    if (m?.[1]) {
      // Drop the publishing-office masthead + serials/years that precede the subject.
      const cleaned = m[1]
        .replace(/U\.?\s?S\.?\s+GOVERNMENT PUBLISHING OFFICE/gi, " ")
        .replace(/\bWASHINGTON\b\s*:?/gi, " ")
        .replace(/\bS\.?\s*HRG\.?\s*[\d–—-]+/gi, " ")
        .replace(/\bPDF\b/gi, " ")
        .replace(/\b\d{2,3}[–—-]\d{1,4}\b/g, " ")
        .replace(/\b(19|20)\d{2}\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const s = boundSubject(cleaned);
      if (s) return s;
    }
  }

  return null;
}

/**
 * Human-readable display title for a document: for GovInfo docs whose stored
 * title is an opaque serial, prefix the doc type and append the extracted
 * subject ("Congressional Report: North Dakota Trust Lands Completion Act of
 * 2026"). Returns null when nothing better than the stored title exists.
 */
export function govDocDisplayTitle(doc: {
  domain: string | null;
  title: string | null;
  extractedText: string | null;
}): string | null {
  if (!isGovInfoDoc(doc.domain)) return null;
  if (!isGovSerialTitle(doc.title)) return null;
  const subject = govDocSubject(doc.extractedText);
  if (!subject) return null;
  const kind = doc.title!.trim().match(/^[A-Za-z ]+?(?=\s*[A-Za-z0-9_.-]*\d|$)/)?.[0]?.trim();
  return kind ? `${kind}: ${subject}` : subject;
}

// Masthead/structural vocabulary shared by ALL GovInfo documents of a given
// type. Left in, it becomes the dominant shared token set across otherwise
// unrelated documents and false-merges them into one cluster. Stripped before
// clustering tokenization (display text is never touched).
const GOV_BOILERPLATE_RES: RegExp[] = [
  /U\.?\s?S\.?\s+GOVERNMENT PUBLISHING OFFICE/gi,
  /\bWASHINGTON\b\s*:?\s*[\d–—-]*/gi,
  /\b\d{2,3}(?:st|nd|rd|th|TH|ST|ND|RD)\s+CONGRESS\b/gi,
  /\bONE HUNDRED (?:AND )?[A-Z]+TH CONGRESS\b/gi,
  // No trailing \b: GovInfo PDFs glue the next token on ("REPRESENTATIVES2d").
  /\bHOUSE OF REPRESENTATIVES\w*/gi,
  /\bUNITED STATES SENATE\b/gi,
  /\b(?:FIRST|SECOND|1st|2d|2nd)\s+SESSION\b/gi,
  /\bSESSIONS?\b/gi,
  // Full masthead dates ("APRIL 2, 2026") and bare years are structural, not
  // topical — left in, every same-week document shares them.
  new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2},\\s+\\d{4}`, "gi"),
  /\b(19|20)\d{2}\b/g,
  /\bS\.?\s*HRG\.?\s*[\d–—-]+/gi,
  /\bREPORT\b\s*(?=["'!]|\s*HOUSE|\s*SENATE|$)/g,
  /Committed to the Committee of the Whole House on the State of the Union/gi,
  /and ordered to be printed/gi,
  /submitted the following/gi,
  /\bAdministration of [^,]{1,60}, \d{4}/gi,
  /\bCongressionally Mandated Report\b/gi,
  /\bCongressional (?:Report|Hearing|Record)\b/gi,
  /\bPresidential Document\b/gi,
  /\bThe Honorable\b/gi,
  /\bDear (?:Mr|Ms|Mrs|Madam)\.? Chair(?:man|woman)?\b:?/gi,
  /\bCommittee on [A-Za-z ,'&-]+/g,
  /\bSUBCOMMITTEE OF THE\b/gi,
  /\bHEARINGS?\s+BEFORE\b/gi,
  /\bAPPROPRIATIONS\s+FOR\s+FISCAL\s+YEAR\b/gi,
  /\b\d{2,3}[–—-]\d{1,4}\b/g,
  /\bPDF\b/g,
];

/**
 * Strip GovInfo masthead/structural boilerplate from text before clustering
 * tokenization. Only ever applied to GovInfo documents — general news prose
 * legitimately mentions committees and chambers as topical signal.
 */
export function stripGovBoilerplate(text: string): string {
  let out = text;
  for (const re of GOV_BOILERPLATE_RES) out = out.replace(re, " ");
  return out.replace(/\s+/g, " ").trim();
}
