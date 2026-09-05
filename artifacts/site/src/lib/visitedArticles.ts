// Client-side bookkeeping of which articles a reader has already seen this
// browsing session. The swipe-to-next endpoint prefers the most closely RELATED
// unseen article, so it needs to know what's already been read — otherwise the
// symmetric "most related" pick would ping-pong between the same two articles.
// The visited list is posted to the endpoint and excluded from the result.
//
// Mirrors lib/swipeHint.ts: all storage access is wrapped in try/catch with an
// in-memory fallback so private-mode browsers (which can throw on storage access)
// degrade gracefully instead of crashing the reader. Session-scoped (per tab) so
// a fresh visit starts the walk over.

const VISITED_KEY = "brainhook:visited-articles";
// Cap the retained history so the POST body stays small and bounded on very long
// sessions. Keeping the most-recent slugs is what matters — it prevents the swipe
// from looping back to something just read; re-surfacing an article seen dozens
// of stories ago is fine (and keeps the walk exhaustive).
const MAX_VISITED = 60;

let mem: string[] = [];

function read(): string[] {
  try {
    const raw = window.sessionStorage.getItem(VISITED_KEY);
    if (!raw) return mem;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : mem;
  } catch {
    return mem;
  }
}

function write(list: string[]): void {
  mem = list;
  try {
    window.sessionStorage.setItem(VISITED_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable / quota / private mode — memory fallback holds
  }
}

// The slugs seen this session (most-recent last), for posting to the swipe-next
// lookup so it can skip them.
export function getVisitedArticles(): string[] {
  return read();
}

// Record an article as seen. Moves an existing slug to the most-recent position
// and trims to the retention cap.
export function recordVisitedArticle(slug: string): void {
  if (!slug) return;
  const current = read().filter((s) => s !== slug);
  current.push(slug);
  write(current.length > MAX_VISITED ? current.slice(current.length - MAX_VISITED) : current);
}
