import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDevSourceLinkGuard,
  devSourceLinkWebSearchAllowed,
  maxSearchQueriesFor,
} from "./sourceLinkPolicy";

// --- Sonar gap-fill flag (updated): maxSearchQueriesFor now returns 0 (off)
// or 1 (run one Sonar call). packet-backed=0, vault_only=0, off=0;
// vault_first non-packet=1, legacy non-packet=1. ---

test("packet-backed vault_first mode skips Sonar gap-fill (cap 0)", () => {
  assert.equal(maxSearchQueriesFor("vault_first_with_capped_search", true), 0);
});

test("non-packet vault_first mode enables one Sonar gap-fill call (cap 1)", () => {
  assert.equal(maxSearchQueriesFor("vault_first_with_capped_search", false), 1);
});

test("vault_only mode never gap-fills, packet or not (cap 0)", () => {
  assert.equal(maxSearchQueriesFor("vault_only", false), 0);
  assert.equal(maxSearchQueriesFor("vault_only", true), 0);
});

test("off mode never gap-fills (cap 0)", () => {
  assert.equal(maxSearchQueriesFor("off", false), 0);
  assert.equal(maxSearchQueriesFor("off", true), 0);
});

test("legacy_web_search enables one Sonar gap-fill call for non-packet articles", () => {
  assert.equal(maxSearchQueriesFor("legacy_web_search", false), 1);
  assert.equal(maxSearchQueriesFor("legacy_web_search", true), 0);
});

// --- Dev money guard (Task #226 acceptance): dev downgrades search modes to
// vault_only unless ALLOW_DEV_SOURCE_LINK_WEB_SEARCH; prod is never downgraded. ---

test("prod never downgrades a search mode", () => {
  assert.equal(
    applyDevSourceLinkGuard("vault_first_with_capped_search", { isProd: true, devWebSearchAllowed: false }),
    "vault_first_with_capped_search",
  );
  assert.equal(
    applyDevSourceLinkGuard("legacy_web_search", { isProd: true, devWebSearchAllowed: false }),
    "legacy_web_search",
  );
});

test("dev downgrades both search modes to vault_only by default", () => {
  assert.equal(
    applyDevSourceLinkGuard("vault_first_with_capped_search", { isProd: false, devWebSearchAllowed: false }),
    "vault_only",
  );
  assert.equal(
    applyDevSourceLinkGuard("legacy_web_search", { isProd: false, devWebSearchAllowed: false }),
    "vault_only",
  );
});

test("dev opt-in preserves search modes", () => {
  assert.equal(
    applyDevSourceLinkGuard("vault_first_with_capped_search", { isProd: false, devWebSearchAllowed: true }),
    "vault_first_with_capped_search",
  );
  // Non-search modes are never touched, opt-in or not.
  assert.equal(
    applyDevSourceLinkGuard("vault_only", { isProd: false, devWebSearchAllowed: false }),
    "vault_only",
  );
  assert.equal(applyDevSourceLinkGuard("off", { isProd: false, devWebSearchAllowed: false }), "off");
});

test("ALLOW_DEV_SOURCE_LINK_WEB_SEARCH is parsed truthily for 1/true only", () => {
  assert.equal(devSourceLinkWebSearchAllowed("1"), true);
  assert.equal(devSourceLinkWebSearchAllowed("true"), true);
  assert.equal(devSourceLinkWebSearchAllowed("TRUE"), true);
  assert.equal(devSourceLinkWebSearchAllowed(undefined), false);
  assert.equal(devSourceLinkWebSearchAllowed("0"), false);
  assert.equal(devSourceLinkWebSearchAllowed("no"), false);
});
