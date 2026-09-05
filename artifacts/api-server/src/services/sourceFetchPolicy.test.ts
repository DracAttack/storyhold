import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectAccessLimits,
  detectEditorialSignals,
  classifyRecheck,
  checkRobots,
  canonicalizeYouTubeUrl,
  resolveCanonicalUrl,
} from "./sourceFetch";

test("canonicalizeYouTubeUrl normalizes every YouTube shape to watch?v=", () => {
  const want = "https://www.youtube.com/watch?v=fZz8sTM_A98";
  assert.equal(canonicalizeYouTubeUrl("https://youtu.be/fZz8sTM_A98"), want);
  assert.equal(canonicalizeYouTubeUrl("https://www.youtube.com/watch?v=fZz8sTM_A98&list=abc"), want);
  assert.equal(canonicalizeYouTubeUrl("https://youtube.com/shorts/fZz8sTM_A98"), want);
  assert.equal(canonicalizeYouTubeUrl("https://www.youtube.com/embed/fZz8sTM_A98"), want);
  assert.equal(canonicalizeYouTubeUrl("https://m.youtube.com/watch?v=fZz8sTM_A98"), want);
});

test("canonicalizeYouTubeUrl rejects non-YouTube hosts and invalid ids", () => {
  assert.equal(canonicalizeYouTubeUrl("https://example.com/watch?v=fZz8sTM_A98"), null);
  assert.equal(canonicalizeYouTubeUrl("https://www.youtube.com/undefined"), null);
  assert.equal(canonicalizeYouTubeUrl("https://www.youtube.com/watch?v=undefined"), null);
  assert.equal(canonicalizeYouTubeUrl("not a url"), null);
});

test("resolveCanonicalUrl never produces a junk placeholder canonical", () => {
  // The reported bug: an unhydrated href="undefined" on a YouTube watch page.
  assert.equal(
    resolveCanonicalUrl(
      "undefined",
      "https://www.youtube.com/watch?v=fZz8sTM_A98",
      "https://www.youtube.com/watch?v=fZz8sTM_A98",
    ),
    "https://www.youtube.com/watch?v=fZz8sTM_A98",
  );
  // Already-absolutized junk still normalizes off the final/requested URL.
  assert.equal(
    resolveCanonicalUrl(
      "https://www.youtube.com/undefined",
      "https://youtu.be/fZz8sTM_A98",
      "https://youtu.be/fZz8sTM_A98",
    ),
    "https://www.youtube.com/watch?v=fZz8sTM_A98",
  );
});

test("resolveCanonicalUrl falls back to the original URL when no canonical is found", () => {
  assert.equal(
    resolveCanonicalUrl(null, "https://example.com/a", "https://example.com/a"),
    "https://example.com/a",
  );
  // A valid declared canonical wins over the requested URL.
  assert.equal(
    resolveCanonicalUrl(
      "https://example.com/canonical",
      "https://example.com/a?utm=x",
      "https://example.com/a?utm=x",
    ),
    "https://example.com/canonical",
  );
});

test("clean full article is not paywalled or excerpt-only", () => {
  const r = detectAccessLimits({
    text: "A ".repeat(600),
    wordCount: 600,
    metaPaywall: false,
  });
  assert.equal(r.paywallDetected, false);
  assert.equal(r.excerptOnly, false);
  assert.equal(r.notes.length, 0);
});

test("paywall text signal is detected", () => {
  const r = detectAccessLimits({
    text: "Here is the intro. Subscribe to continue reading this exclusive report.",
    wordCount: 11,
    metaPaywall: false,
  });
  assert.equal(r.paywallDetected, true);
  assert.equal(r.excerptOnly, true); // short body behind a wall
  assert.ok(r.notes.some((n) => /paywall/i.test(n)));
});

test("meta paywall flags even with no text signal", () => {
  const r = detectAccessLimits({
    text: "A ".repeat(400),
    wordCount: 400,
    metaPaywall: true,
  });
  assert.equal(r.paywallDetected, true);
  assert.equal(r.excerptOnly, false); // long body → not just an excerpt
});

// --- Lifecycle recheck: editorial-signal detection ----------------------

test("retraction notice is detected", () => {
  const s = detectEditorialSignals("Update: This article has been retracted by the publisher.");
  assert.equal(s.retracted, true);
});

test("correction notice is detected", () => {
  const s = detectEditorialSignals("Correction: an earlier version of this story misstated the date.");
  assert.equal(s.correctionNoted, true);
});

test("a clean body has no editorial signals", () => {
  const s = detectEditorialSignals("A ".repeat(400));
  assert.equal(s.retracted, false);
  assert.equal(s.correctionNoted, false);
});

// --- Lifecycle recheck: deterministic transitions -----------------------

test("gone outcome transitions to unavailable", () => {
  const d = classifyRecheck({ outcome: { kind: "gone" }, priorContentHash: "abc" });
  assert.equal(d.lifecycleStatus, "unavailable");
  assert.equal(d.contentChanged, false);
});

test("transient fetch failure leaves the document unchanged", () => {
  const d = classifyRecheck({ outcome: { kind: "transient" }, priorContentHash: "abc" });
  assert.equal(d.lifecycleStatus, null);
  assert.equal(d.correctionDetected, null);
  assert.equal(d.contentChanged, false);
});

test("retraction notice transitions to retracted regardless of content change", () => {
  const d = classifyRecheck({
    outcome: { kind: "fetched", text: "This story has been withdrawn.", contentHash: "same" },
    priorContentHash: "same",
  });
  assert.equal(d.lifecycleStatus, "retracted");
});

test("changed body with a correction notice flags a correction", () => {
  const d = classifyRecheck({
    outcome: {
      kind: "fetched",
      text: "Correction: the figure was wrong. " + "A ".repeat(300),
      contentHash: "new",
    },
    priorContentHash: "old",
  });
  assert.equal(d.lifecycleStatus, "active");
  assert.equal(d.correctionDetected, true);
  assert.equal(d.contentChanged, true);
});

test("changed body with no notice records a content change only", () => {
  const d = classifyRecheck({
    outcome: { kind: "fetched", text: "A ".repeat(300), contentHash: "new" },
    priorContentHash: "old",
  });
  assert.equal(d.lifecycleStatus, "active");
  assert.equal(d.correctionDetected, null);
  assert.equal(d.contentChanged, true);
});

test("unchanged body is a no-op transition", () => {
  const d = classifyRecheck({
    outcome: { kind: "fetched", text: "A ".repeat(300), contentHash: "same" },
    priorContentHash: "same",
  });
  assert.equal(d.lifecycleStatus, null);
  assert.equal(d.contentChanged, false);
});

test("a first-seen document (no prior hash) is not treated as changed", () => {
  const d = classifyRecheck({
    outcome: { kind: "fetched", text: "A ".repeat(300), contentHash: "new" },
    priorContentHash: null,
  });
  assert.equal(d.lifecycleStatus, null);
  assert.equal(d.contentChanged, false);
});

// --- SSRF: robots.txt redirects are re-validated per hop -----------------

test("checkRobots never follows a robots.txt redirect to a private address", async () => {
  const origFetch = globalThis.fetch;
  const calls: string[] = [];
  // First hop (public robots.txt) 302-redirects to a link-local metadata IP.
  // A safe implementation must NOT issue a second fetch to that internal target;
  // the redirect is refused by the per-hop SSRF guard and the check fails OPEN.
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (calls.length === 1) {
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/robots.txt" } });
    }
    // If we ever get here, the SSRF guard failed — return a disallow to make the
    // assertion below fail loudly rather than silently pass.
    return new Response("User-agent: *\nDisallow: /", { status: 200 });
  }) as typeof fetch;

  try {
    // Use a public IP literal as the host so no real DNS lookup is needed.
    const decision = await checkRobots("http://1.1.1.1/some/path");
    assert.equal(calls.length, 1, "must not fetch the internal redirect target");
    assert.ok(!calls.some((u) => u.includes("169.254")), "must never request the private address");
    assert.equal(decision.allowed, true); // fail-open, without touching the internal host
  } finally {
    globalThis.fetch = origFetch;
  }
});
