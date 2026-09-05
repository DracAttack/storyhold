import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { ACRONYMS, toChicagoTitleCase } from "@workspace/content-utils"
import * as React from "react"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Known acronyms and mixed-case tokens whose canonical display form must be
 * preserved regardless of how they appear in the stored title.
 *
 * This is re-exported from @workspace/content-utils so it can be imported
 * directly from this module by existing callers.
 */
export const HEADLINE_ACRONYMS: Record<string, string> = ACRONYMS;

/**
 * Applies Chicago-style title case to an article title at display time.
 *
 * Rules applied in order:
 * 1. The first and last word are always capitalised.
 * 2. The word immediately after `.`, `?`, `!`, `:`, or an em-dash is always
 *    capitalised (sentence-restart / subtitle rule).  Em-dashes trigger the
 *    restart whether they are space-flanked ("word — word") or flush
 *    ("word—word") — the split step treats `\u2014` as its own delimiter.
 * 3. Articles (a, an, the), coordinating conjunctions (and, but, for, nor, or,
 *    so, yet), and short prepositions (at, by, in, into, of, on, onto, to, up,
 *    via, vs, with) are lowercased when they appear mid-title.
 * 4. Leading non-letter characters are peeled off and reattached (preserves
 *    opening quotes, parentheses, etc.) so the alphabetic word inside is cased
 *    correctly.  Exception: if the non-letter prefix contains a digit (e.g.
 *    "1950s", "3D") the whole token is returned verbatim — we cannot reliably
 *    case alphanumeric hybrids.
 * 5. Any token whose non-first characters already contain an uppercase letter
 *    is left completely unchanged — this preserves acronyms (ADHD, DSM-5,
 *    U.S.), proper brands, and intentional casing already in the DB.
 * 6. Tokens whose lowercase form matches the HEADLINE_ACRONYMS allowlist are
 *    replaced with their canonical form (e.g. "covid" → "COVID").  The leading
 *    punctuation prefix (if any) is reattached.
 * 7. All other words have their first character capitalised; the remaining
 *    characters are lowercased (normalises sentence-case storage).
 *
 * Apostrophe normalisation: escaped apostrophes (`\'`) and double-apostrophes
 * (`''`) that can leak through LLM JSON processing are collapsed to a single
 * plain apostrophe before any other processing.
 */
export function toArticleTitleCase(title: string): string {
  return toChicagoTitleCase(title);
}

export { toChicagoTitleCase };

/** Title-case only UI-label children; body copy is never passed through this. */
export function chicagoTitleChildren(children: React.ReactNode): React.ReactNode {
  if (typeof children === "string") return toChicagoTitleCase(children);
  if (Array.isArray(children)) {
    const output: React.ReactNode[] = [];
    let textRun = "";
    const flushText = () => {
      if (!textRun) return;
      output.push(toChicagoTitleCase(textRun));
      textRun = "";
    };
    for (const child of children) {
      if (typeof child === "string" || typeof child === "number") {
        textRun += String(child);
        continue;
      }
      if (child === null || child === undefined || typeof child === "boolean") continue;
      flushText();
      output.push(chicagoTitleChildren(child));
    }
    flushText();
    return output;
  }
  if (!React.isValidElement<{ children?: React.ReactNode }>(children)) return children;
  if (children.props.children === undefined) return children;
  return React.cloneElement(children, {
    children: chicagoTitleChildren(children.props.children),
  });
}

/**
 * Returns true when an alias contains only Latin-script characters
 * (Basic Latin, Latin-1, Latin Extended A/B, Latin Extended Additional).
 * Rejects any alias that contains CJK, Kanji, Arabic, Cyrillic, Devanagari,
 * Hebrew, Hangul, or any other non-Latin script — BrainHook only shows
 * aliases in English or proper Latin transliterations.
 */
export function isLatinAlias(alias: string): boolean {
  return !/[^\u0000-\u024F\u1E00-\u1EFF]/.test(alias);
}
