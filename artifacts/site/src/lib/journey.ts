// Anonymous, first-party reader-journey identity. NO PII is ever stored or sent
// — identity is a pair of random UUIDs kept in the reader's own localStorage:
//
//   - visitorId  — a stable random UUID, persisted indefinitely, that lets the
//     admin report count distinct (anonymous) visitors and spot returning ones.
//   - sessionId  — a rolling random UUID that renews after 30 minutes of
//     inactivity, scoping a single browsing session.
//
// Alongside the session id we keep just enough path state to reconstruct a
// reading journey server-side: the session's first article (entrySlug), the
// article viewed immediately before this one (previousSlug) and a 1-based view
// counter (viewSequence). All of this is anonymous and first-party; nothing is
// shared cross-site and GA4 is untouched.

const VISITOR_KEY = "bh_visitor_id";
const VISITOR_EXP_KEY = "bh_visitor_exp"; // expiry timestamp (ms since epoch)
const SESSION_KEY = "bh_session";
const SESSION_IDLE_MS = 30 * 60 * 1000; // renew after 30 min of inactivity
// Rotate the visitor UUID after 90 days. Limits how long a single pseudonymous
// identifier spans a reader's history without requiring them to clear storage.
const VISITOR_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export interface JourneyView {
  visitorId?: string;
  sessionId?: string;
  previousSlug?: string;
  entrySlug?: string;
  viewSequence?: number;
}

export interface JourneyIdentity {
  visitorId?: string;
  sessionId?: string;
}

interface SessionState {
  id: string;
  lastActivity: number;
  entrySlug: string | null;
  lastSlug: string | null;
  sequence: number;
}

function hasStorage(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

function uuid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  // Extremely defensive fallback (older browsers / locked-down crypto).
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random()
    .toString(16)
    .slice(2)}`;
}

function getVisitorId(): string | undefined {
  if (!hasStorage()) return undefined;
  try {
    const now = Date.now();
    const expRaw = window.localStorage.getItem(VISITOR_EXP_KEY);
    const exp = expRaw !== null ? Number(expRaw) : 0;
    let id = window.localStorage.getItem(VISITOR_KEY);
    // Mint a fresh UUID on first visit or after 90 days — both conditions write
    // a new expiry so the clock resets from the most-recent rotation.
    if (!id || !(exp > 0) || now >= exp) {
      id = uuid();
      window.localStorage.setItem(VISITOR_KEY, id);
      window.localStorage.setItem(VISITOR_EXP_KEY, String(now + VISITOR_MAX_AGE_MS));
    }
    return id;
  } catch {
    return undefined;
  }
}

function loadSession(): SessionState | null {
  if (!hasStorage()) return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionState> | null;
    if (!parsed || typeof parsed.id !== "string" || typeof parsed.lastActivity !== "number") return null;
    return {
      id: parsed.id,
      lastActivity: parsed.lastActivity,
      entrySlug: typeof parsed.entrySlug === "string" ? parsed.entrySlug : null,
      lastSlug: typeof parsed.lastSlug === "string" ? parsed.lastSlug : null,
      sequence: typeof parsed.sequence === "number" && parsed.sequence >= 0 ? parsed.sequence : 0,
    };
  } catch {
    return null;
  }
}

function saveSession(s: SessionState): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    // Storage full / blocked — tracking is best-effort, ignore.
  }
}

function freshSession(now: number): SessionState {
  return { id: uuid(), lastActivity: now, entrySlug: null, lastSlug: null, sequence: 0 };
}

// Return the live session, renewing it (new id, reset path) when it has been
// idle past the 30-minute window. Does NOT persist on its own — callers mutate
// and save.
function getLiveSession(now: number): SessionState {
  const existing = loadSession();
  if (!existing || now - existing.lastActivity > SESSION_IDLE_MS) return freshSession(now);
  return existing;
}

// Record an article view: advances the session path and returns the anonymous
// identity + path position to attach to the page-view payload. Idempotent guard
// against double-counting the SAME slug back-to-back (React strict-mode double
// effect, or a re-render firing the view effect twice) — re-viewing the same
// slug consecutively returns the existing position without advancing.
export function recordJourneyView(slug: string): JourneyView {
  if (!slug || !hasStorage()) return {};
  const now = Date.now();
  const s = getLiveSession(now);

  // Same slug as the immediately-previous view in this session: don't advance,
  // just refresh activity and return the current position.
  if (s.lastSlug === slug && s.sequence > 0) {
    s.lastActivity = now;
    saveSession(s);
    return {
      visitorId: getVisitorId(),
      sessionId: s.id,
      entrySlug: s.entrySlug ?? slug,
      viewSequence: s.sequence,
      // previousSlug intentionally omitted on a same-slug refire.
    };
  }

  const previousSlug = s.lastSlug && s.lastSlug !== slug ? s.lastSlug : undefined;
  if (!s.entrySlug) s.entrySlug = slug;
  s.sequence += 1;
  s.lastSlug = slug;
  s.lastActivity = now;
  saveSession(s);

  return {
    visitorId: getVisitorId(),
    sessionId: s.id,
    previousSlug,
    entrySlug: s.entrySlug,
    viewSequence: s.sequence,
  };
}

// Anonymous identity for non-view events (internal clicks, swipe-prompt events).
// Ensures/renews the session and touches its activity, but does NOT advance the
// reading path (the destination's own view will do that).
export function getJourneyIdentity(): JourneyIdentity {
  if (!hasStorage()) return {};
  const now = Date.now();
  const s = getLiveSession(now);
  s.lastActivity = now;
  saveSession(s);
  return { visitorId: getVisitorId(), sessionId: s.id };
}

/**
 * Erase all first-party journey identity from this browser (visitor UUID,
 * expiry timestamp, and session state). Called when the visitor withdraws
 * analytics consent so BrainHook's own tracking stops linking future page
 * views to the same pseudonymous identity.
 *
 * Subsequent page views will start a fresh, unrelated visitor UUID.
 */
export function clearJourneyIdentity(): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.removeItem(VISITOR_KEY);
    window.localStorage.removeItem(VISITOR_EXP_KEY);
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    // localStorage may be blocked — clearing is best-effort.
  }
}

// ── Best-effort event beacons ────────────────────────────────────────────────
// Internal-recommendation clicks and swipe-prompt lifecycle events are fired via
// navigator.sendBeacon so they survive the page unload that a click navigation
// triggers (a normal fetch would be cancelled mid-flight). Same-origin, so no
// CORS concerns; the payload is plain JSON the server validates and rate-limits.

// The recommendation/navigation surface a click happened on. Mirrors the server
// enum exactly (lib/api-spec InternalClickInput.placement).
export type ClickPlacement =
  | "inline_auto"
  | "inline_manual"
  | "more_like_this"
  | "swipe_next"
  | "homepage"
  | "developing_rail"
  | "category_page"
  | "author_page"
  | "search";

function beacon(path: string, payload: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    const body = JSON.stringify(payload);
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(path, blob)) return;
    }
    // Fallback when sendBeacon is unavailable or refuses the payload. keepalive
    // lets the POST outlive the navigation; failures are swallowed.
    void fetch(path, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Tracking is best-effort — never let it throw into a click handler.
  }
}

// Record a click on an internal recommendation/navigation surface. `toSlug` is
// the destination article; `placement`/`recommendationRank` describe which slot
// was taken. Fired before the client-side navigation; never blocks it.
export function trackInternalClick(args: {
  toSlug: string;
  fromSlug?: string;
  placement: ClickPlacement;
  recommendationRank?: number;
  interactionType?: "click" | "swipe";
}): void {
  if (!args.toSlug) return;
  beacon("/api/public/internal-click", {
    toSlug: args.toSlug,
    fromSlug: args.fromSlug,
    placement: args.placement,
    recommendationRank: args.recommendationRank,
    interactionType: args.interactionType ?? "click",
    ...getJourneyIdentity(),
  });
}

// Record a swipe-next prompt lifecycle event (impression / activation /
// dismissal). `method` is only meaningful on activation.
export function trackSwipeEvent(args: {
  articleSlug: string;
  targetSlug?: string;
  eventType: "impression" | "activation" | "dismissal";
  method?: "swipe" | "click";
}): void {
  if (!args.articleSlug) return;
  beacon("/api/public/swipe-event", {
    articleSlug: args.articleSlug,
    targetSlug: args.targetSlug,
    eventType: args.eventType,
    method: args.method,
    ...getJourneyIdentity(),
  });
}
