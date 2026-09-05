// Client-side suppression for the in-article "subscribe" nudge (SubscribePrompt).
//
// Goal: a reader who has already subscribed — or who recently dismissed the
// nudge — must not keep seeing it on future visits. Without server-side auth
// there is no authoritative "is this visitor subscribed" check, so this is a
// best-effort, per-device signal persisted with FIRST-PARTY storage:
//
//   - bh_newsletter_subscribed  → set on a successful signup (incl. an
//       already-subscribed response). Cookie (Max-Age 1y) + localStorage backup.
//       Suppresses the nudge forever on this device. Cleared when the reader
//       unsubscribes through this browser.
//   - bh_subscribe_toast_dismissed → set when the reader closes the nudge
//       WITHOUT subscribing. Cookie (Max-Age 24h, auto-expiring) + localStorage
//       backup that stores the expiry timestamp so the 24-hour window is honored
//       even if only localStorage survives. Suppresses the nudge for 24 hours.
//
// A per-tab-session "prompted" flag (sessionStorage) is also kept so the nudge
// fires at most once per browsing session even before the reader acts on it.
//
// NO personal data (email, name, IP, subscriber id) is ever stored — only
// boolean / timestamp suppression flags. All storage access is wrapped so
// private-mode browsers (which can throw) degrade gracefully via an in-memory
// fallback that lives for the current page lifetime.

const SUBSCRIBED_KEY = "bh_newsletter_subscribed";
const DISMISSED_KEY = "bh_subscribe_toast_dismissed";
// Per-tab-session "we already showed it this session" flag.
const PROMPTED_KEY = "brainhook:subscribe-prompted";
// Legacy key from before first-party cookie persistence — read so existing
// known-subscribers on this device are not re-prompted after the upgrade.
const LEGACY_SUBSCRIBED_KEY = "brainhook:subscribed";

const SUBSCRIBED_MAX_AGE = 31536000; // 1 year, in seconds
const DISMISSED_MAX_AGE = 24 * 60 * 60; // 24 hours, in seconds

// In-memory fallback used ONLY when Web Storage / cookies throw (private mode,
// restricted contexts). It is never written when real storage works, so it
// cannot leak suppression state across logically-separate readers/tests.
const memStore: Record<string, string> = {};

// --- storage primitives (all best-effort, never throw) ----------------------

function getCookie(name: string): string | null {
  try {
    const match = document.cookie.match(
      new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"),
    );
    if (match) return decodeURIComponent(match[1]);
  } catch {
    /* document/cookie unavailable */
  }
  return memStore[`cookie:${name}`] ?? null;
}

function setCookie(name: string, value: string, maxAgeSeconds: number): void {
  let secure = "";
  try {
    if (window.location.protocol === "https:") secure = "; Secure";
  } catch {
    /* no window.location — leave non-secure */
  }
  try {
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}`;
  } catch {
    memStore[`cookie:${name}`] = value;
  }
}

function deleteCookie(name: string): void {
  try {
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
  } catch {
    /* ignore */
  }
  delete memStore[`cookie:${name}`];
}

function lsGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memStore[`ls:${key}`] ?? null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    memStore[`ls:${key}`] = value;
  }
}

function lsRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  delete memStore[`ls:${key}`];
}

function ssGet(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return memStore[`ss:${key}`] ?? null;
  }
}

function ssSet(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    memStore[`ss:${key}`] = value;
  }
}

// --- subscribed flag --------------------------------------------------------

export function hasSubscribed(): boolean {
  return (
    getCookie(SUBSCRIBED_KEY) === "true" ||
    lsGet(SUBSCRIBED_KEY) === "true" ||
    lsGet(LEGACY_SUBSCRIBED_KEY) === "1"
  );
}

// Mark this device as subscribed (first-party cookie + localStorage backup).
// Called on any successful signup — including an already-subscribed response,
// which the API/clients treat as success. Subscribing supersedes a prior
// dismissal, so the dismissed flag is cleared too.
export function markSubscribed(): void {
  setCookie(SUBSCRIBED_KEY, "true", SUBSCRIBED_MAX_AGE);
  lsSet(SUBSCRIBED_KEY, "true");
  deleteCookie(DISMISSED_KEY);
  lsRemove(DISMISSED_KEY);
}

// Expire/remove the subscribed flag — used when the reader unsubscribes through
// this browser so the nudge can return.
export function clearSubscribed(): void {
  deleteCookie(SUBSCRIBED_KEY);
  lsRemove(SUBSCRIBED_KEY);
  lsRemove(LEGACY_SUBSCRIBED_KEY);
}

// --- dismissed flag ---------------------------------------------------------

export function wasToastDismissed(): boolean {
  // The cookie auto-expires after the 24-hour window; its presence alone means
  // "still suppressed". Legacy cookies from the old 30-day policy that are
  // still alive get capped to the current 24-hour window.
  const cookieVal = getCookie(DISMISSED_KEY);
  if (cookieVal === "true") return true;
  if (cookieVal && cookieVal !== "true") {
    // old-format non-timestamp cookie — clear it so it doesn't leak forever
    deleteCookie(DISMISSED_KEY);
  }
  // localStorage backup stores the expiry timestamp so the window is honored
  // even when the cookie was cleared but localStorage survived.
  const raw = lsGet(DISMISSED_KEY);
  if (!raw) return false;
  const until = Number(raw);
  if (!Number.isFinite(until) || until <= 0) {
    lsRemove(DISMISSED_KEY);
    return false;
  }
  const now = Date.now();
  // Cap legacy timestamps that were written under the old 30-day policy.
  if (until > now + DISMISSED_MAX_AGE * 1000) {
    // Treat anything beyond the current policy window as expired.
    lsRemove(DISMISSED_KEY);
    return false;
  }
  return now < until;
}

// Record that the reader closed the nudge without subscribing. Suppresses it for
// DISMISSED_MAX_AGE (cookie auto-expires; localStorage stores the expiry ms).
export function markSubscribeToastDismissed(): void {
  const until = Date.now() + DISMISSED_MAX_AGE * 1000;
  setCookie(DISMISSED_KEY, "true", DISMISSED_MAX_AGE);
  lsSet(DISMISSED_KEY, String(until));
}

// --- per-session "already shown" flag ---------------------------------------

export function wasSubscribePrompted(): boolean {
  return ssGet(PROMPTED_KEY) === "1";
}

export function markSubscribePrompted(): void {
  ssSet(PROMPTED_KEY, "1");
}

// Whether the article-page nudge should be shown at all. Checked BEFORE the
// nudge ever renders (so there is no post-hydration flash): suppressed for known
// subscribers, recent dismissers, and anyone already shown it this session.
export function shouldPromptSubscribe(): boolean {
  return !hasSubscribed() && !wasToastDismissed() && !wasSubscribePrompted();
}
