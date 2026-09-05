import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  shouldPromptSubscribe,
  markSubscribed,
  markSubscribeToastDismissed,
  clearSubscribed,
  hasSubscribed,
  wasToastDismissed,
} from "./subscription";

// --- Minimal first-party storage stubs (no jsdom dependency) ----------------
// subscription.ts only touches document.cookie, window.localStorage,
// window.sessionStorage, and window.location.protocol — all at call time — so a
// few hand-rolled shims are enough to exercise the suppression logic.

type Jar = Map<string, { value: string; expiresAt: number | null }>;

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

const cookieWrites: string[] = [];

function installDom(protocol = "https:") {
  cookieWrites.length = 0;
  const jar: Jar = new Map();
  const g = globalThis as unknown as {
    window: unknown;
    document: { cookie: string };
  };
  g.document = {
    get cookie() {
      const now = Date.now();
      const live: string[] = [];
      for (const [name, rec] of jar) {
        if (rec.expiresAt !== null && rec.expiresAt <= now) {
          jar.delete(name);
          continue;
        }
        live.push(`${name}=${rec.value}`);
      }
      return live.join("; ");
    },
    set cookie(str: string) {
      cookieWrites.push(str);
      const parts = str.split(";").map((p) => p.trim());
      const [pair, ...attrs] = parts;
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      let maxAge: number | null = null;
      for (const a of attrs) {
        const [ak, av] = a.split("=");
        if (ak.toLowerCase() === "max-age") maxAge = Number(av);
      }
      if (maxAge !== null && maxAge <= 0) {
        jar.delete(name);
        return;
      }
      jar.set(name, {
        value,
        expiresAt: maxAge !== null ? Date.now() + maxAge * 1000 : null,
      });
    },
  };
  g.window = {
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    location: { protocol },
  };
}

beforeEach(() => {
  installDom();
});

afterEach(() => {
  const g = globalThis as unknown as { window?: unknown; document?: unknown };
  delete g.window;
  delete g.document;
});

test("a brand-new visitor (no cookie/localStorage) sees the toast", () => {
  assert.equal(shouldPromptSubscribe(), true);
});

test("the toast is hidden after a successful subscription", () => {
  markSubscribed();
  assert.equal(hasSubscribed(), true);
  assert.equal(shouldPromptSubscribe(), false);
});

test("the subscribed flag is persisted to a first-party cookie", () => {
  markSubscribed();
  assert.match(document.cookie, /bh_newsletter_subscribed=true/);
});

test("the toast is hidden after the reader dismisses it", () => {
  markSubscribeToastDismissed();
  assert.equal(wasToastDismissed(), true);
  assert.equal(shouldPromptSubscribe(), false);
});

test("the dismissal expires after the 30-day window", () => {
  markSubscribeToastDismissed();
  assert.equal(wasToastDismissed(), true);

  // Simulate time passing beyond the window: drop the (auto-expiring) cookie and
  // rewind the localStorage expiry timestamp into the past.
  document.cookie = "bh_subscribe_toast_dismissed=; Path=/; Max-Age=0";
  window.localStorage.setItem(
    "bh_subscribe_toast_dismissed",
    String(Date.now() - 1000),
  );

  assert.equal(wasToastDismissed(), false);
  assert.equal(shouldPromptSubscribe(), true);
});

test("an already-subscribed response suppresses the toast the same way", () => {
  // Clients call markSubscribed() on success regardless of whether the address
  // was new or already on the list, so the suppression path is identical.
  markSubscribed();
  assert.equal(shouldPromptSubscribe(), false);
});

test("no email or personal data is stored in the cookie", () => {
  markSubscribed();
  markSubscribeToastDismissed();
  const cookie = document.cookie;
  assert.doesNotMatch(cookie, /@/); // no email
  // Only the two boolean suppression flags are present.
  for (const part of cookie.split(";").map((p) => p.trim())) {
    if (!part) continue;
    assert.match(
      part,
      /^(bh_newsletter_subscribed|bh_subscribe_toast_dismissed)=true$/,
    );
  }
});

test("unsubscribing through this browser clears the subscribed flag", () => {
  markSubscribed();
  assert.equal(hasSubscribed(), true);
  clearSubscribed();
  assert.equal(hasSubscribed(), false);
  assert.doesNotMatch(document.cookie, /bh_newsletter_subscribed/);
  assert.equal(shouldPromptSubscribe(), true);
});

test("subscribing supersedes a prior dismissal", () => {
  markSubscribeToastDismissed();
  markSubscribed();
  assert.equal(wasToastDismissed(), false);
  assert.equal(hasSubscribed(), true);
});

test("the cookie is Secure over HTTPS and not Secure over HTTP", () => {
  installDom("https:");
  markSubscribed();
  assert.ok(
    cookieWrites.some((c) => /bh_newsletter_subscribed/.test(c) && /Secure/.test(c)),
    "expected a Secure subscribed cookie over https",
  );

  installDom("http:");
  markSubscribed();
  assert.ok(
    cookieWrites.some((c) => /bh_newsletter_subscribed/.test(c)),
    "expected the subscribed cookie to still be written over http",
  );
  assert.ok(
    !cookieWrites.some((c) => /bh_newsletter_subscribed/.test(c) && /Secure/.test(c)),
    "expected no Secure attribute over http",
  );
});
