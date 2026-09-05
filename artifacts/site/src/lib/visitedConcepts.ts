// Client-side bookkeeping of which glossary concepts a reader has already seen this
// browsing session. The swipe-to-next endpoint prefers the most closely RELATED
// unseen concept, so it needs to know what's already been read.
//
// Session-scoped (per tab) so a fresh visit starts the walk over.
// Storage access wrapped in try/catch — private-mode browsers degrade gracefully.

const VISITED_KEY = "brainhook:visited-concepts";
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

export function getVisitedConcepts(): string[] {
  return read();
}

export function recordVisitedConcept(slug: string): void {
  if (!slug) return;
  const current = read().filter((s) => s !== slug);
  current.push(slug);
  write(current.length > MAX_VISITED ? current.slice(current.length - MAX_VISITED) : current);
}
