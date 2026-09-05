// Client-side bookkeeping for the informational "swipe to read the next article"
// hint on article pages.
//
// The hint is purely informative — the swipe-to-navigate gesture itself is always
// on. The hint is shown only on the FIRST article a reader opens in a browsing
// session (at ~50% scroll and again at the author card), and never again that
// session. Two signals, stored per-tab session:
//   - firstSlug: the slug of the first article opened this session. The hint only
//     shows while the reader is on that article.
//   - done: set once the reader moves on to a different article, permanently
//     ending the hint for the rest of the session.
//
// Mirrors lib/subscription.ts: all access is wrapped in try/catch with an
// in-memory fallback so private-mode browsers (which can throw on storage access)
// degrade gracefully instead of crashing the reader.

const FIRST_KEY = "brainhook:swipe-hint-first";
const DONE_KEY = "brainhook:swipe-hint-done";

let memFirst: string | null = null;
let memDone = false;

export function getSwipeHintFirstSlug(): string | null {
  try {
    return memFirst ?? window.sessionStorage.getItem(FIRST_KEY);
  } catch {
    return memFirst;
  }
}

export function setSwipeHintFirstSlug(slug: string): void {
  memFirst = slug;
  try {
    window.sessionStorage.setItem(FIRST_KEY, slug);
  } catch {
    // storage unavailable / quota / private mode — memory fallback holds
  }
}

export function isSwipeHintSessionDone(): boolean {
  try {
    return memDone || window.sessionStorage.getItem(DONE_KEY) === "1";
  } catch {
    return memDone;
  }
}

export function markSwipeHintSessionDone(): void {
  memDone = true;
  try {
    window.sessionStorage.setItem(DONE_KEY, "1");
  } catch {
    // storage unavailable / quota / private mode — memory fallback holds
  }
}

// Whether the hint is eligible to show on the given article this session.
// Records the first article on first call and ends the session once a different
// article is opened, so the hint only ever appears on the session's first read.
export function isFirstArticleForSwipeHint(slug: string): boolean {
  if (isSwipeHintSessionDone()) return false;
  const first = getSwipeHintFirstSlug();
  if (!first) {
    setSwipeHintFirstSlug(slug);
    return true;
  }
  if (first === slug) return true;
  markSwipeHintSessionDone();
  return false;
}
