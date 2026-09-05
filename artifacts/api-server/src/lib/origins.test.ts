import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { isTrustedOrigin, requireTrustedOrigin } from "./origins";

// These tests assume a non-production env (the default for the dev test run),
// where Replit-hosted wildcard origins are trusted in addition to the explicit
// production origins.

test("isTrustedOrigin: explicit production origins are trusted", () => {
  assert.equal(isTrustedOrigin("https://brainhook.net"), true);
  assert.equal(isTrustedOrigin("https://www.brainhook.net"), true);
});

test("isTrustedOrigin: arbitrary third-party origins are rejected", () => {
  assert.equal(isTrustedOrigin("https://evil.com"), false);
  assert.equal(isTrustedOrigin("http://brainhook.net"), false); // http, not https
  assert.equal(isTrustedOrigin(null), false);
  assert.equal(isTrustedOrigin(undefined), false);
  assert.equal(isTrustedOrigin(""), false);
});

test("isTrustedOrigin: suffix-spoofing attempts do not bypass the allowlist", () => {
  assert.equal(isTrustedOrigin("https://replit.dev.evil.com"), false);
  assert.equal(isTrustedOrigin("https://notreplit.dev"), false);
  assert.equal(isTrustedOrigin("https://brainhook.net.evil.com"), false);
  assert.equal(isTrustedOrigin("https://evilbrainhook.net"), false);
});

test("isTrustedOrigin: Replit-hosted dev origins trusted outside production", () => {
  assert.equal(isTrustedOrigin("https://something.replit.dev"), true);
  assert.equal(isTrustedOrigin("https://abc-123.worf.replit.dev"), true);
  assert.equal(isTrustedOrigin("https://my-app.replit.app"), true);
});

test("isTrustedOrigin: production gate rejects wildcard Replit origins (explicit-only)", () => {
  // With the wildcard off (production), only the explicit static origins are
  // trusted — arbitrary Replit-hosted origins must NOT be treated as same-site.
  assert.equal(isTrustedOrigin("https://something.replit.dev", { allowReplitWildcard: false }), false);
  assert.equal(isTrustedOrigin("https://my-app.replit.app", { allowReplitWildcard: false }), false);
  assert.equal(isTrustedOrigin("https://brainhook.net", { allowReplitWildcard: false }), true);
});

function mockReq(method: string, headers: Record<string, string>): Request {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    method,
    originalUrl: "/api/admin/test",
    get(name: string) {
      return lower[name.toLowerCase()];
    },
    log: { warn() {} },
  } as unknown as Request;
}

function mockRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

test("requireTrustedOrigin: safe methods pass without an origin", () => {
  let called = false;
  requireTrustedOrigin(mockReq("GET", {}), mockRes(), () => {
    called = true;
  });
  assert.equal(called, true);
});

test("requireTrustedOrigin: mutation from a trusted origin passes", () => {
  let called = false;
  requireTrustedOrigin(mockReq("POST", { Origin: "https://brainhook.net" }), mockRes(), () => {
    called = true;
  });
  assert.equal(called, true);
});

test("requireTrustedOrigin: mutation from an untrusted origin is blocked with 403", () => {
  let called = false;
  const res = mockRes();
  requireTrustedOrigin(mockReq("POST", { Origin: "https://evil.com" }), res, () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test("requireTrustedOrigin: mutation with no Origin/Referer is blocked", () => {
  let called = false;
  const res = mockRes();
  requireTrustedOrigin(mockReq("POST", {}), res, () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test("requireTrustedOrigin: falls back to Referer when Origin is absent", () => {
  let called = false;
  requireTrustedOrigin(
    mockReq("POST", { Referer: "https://brainhook.net/admin/articles" }),
    mockRes(),
    () => {
      called = true;
    },
  );
  assert.equal(called, true);
});
