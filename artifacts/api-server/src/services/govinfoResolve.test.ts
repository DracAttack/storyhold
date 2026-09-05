import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGovInfoContentUrl } from "./govinfoResolve";

test("package details page → content PDF", () => {
  assert.equal(
    resolveGovInfoContentUrl("https://www.govinfo.gov/app/details/GAOREPORTS-GAO-24-106393"),
    "https://www.govinfo.gov/content/pkg/GAOREPORTS-GAO-24-106393/pdf/GAOREPORTS-GAO-24-106393.pdf",
  );
});

test("package details page with trailing slash", () => {
  assert.equal(
    resolveGovInfoContentUrl("https://www.govinfo.gov/app/details/PLAW-118publ42/"),
    "https://www.govinfo.gov/content/pkg/PLAW-118publ42/pdf/PLAW-118publ42.pdf",
  );
});

test("granule details page → content HTML", () => {
  assert.equal(
    resolveGovInfoContentUrl(
      "https://www.govinfo.gov/app/details/CHRG-118hhrg12345/CHRG-118hhrg12345-Wit1",
    ),
    "https://www.govinfo.gov/content/pkg/CHRG-118hhrg12345/html/CHRG-118hhrg12345-Wit1.htm",
  );
});

test("query string and fragment are ignored", () => {
  assert.equal(
    resolveGovInfoContentUrl("https://www.govinfo.gov/app/details/CPRT-118?foo=bar#top"),
    "https://www.govinfo.gov/content/pkg/CPRT-118/pdf/CPRT-118.pdf",
  );
});

test("already a content URL → not rewritten", () => {
  assert.equal(
    resolveGovInfoContentUrl(
      "https://www.govinfo.gov/content/pkg/PLAW-118publ42/pdf/PLAW-118publ42.pdf",
    ),
    null,
  );
});

test("non-govinfo host → null", () => {
  assert.equal(resolveGovInfoContentUrl("https://example.com/app/details/FOO"), null);
});

test("govinfo non-details path → null", () => {
  assert.equal(resolveGovInfoContentUrl("https://www.govinfo.gov/app/search?query=ai"), null);
});

test("unexpected extra path segments → null", () => {
  assert.equal(
    resolveGovInfoContentUrl("https://www.govinfo.gov/app/details/PKG/GRANULE/extra"),
    null,
  );
});

test("null / empty input → null", () => {
  assert.equal(resolveGovInfoContentUrl(null), null);
  assert.equal(resolveGovInfoContentUrl(""), null);
  assert.equal(resolveGovInfoContentUrl("not a url"), null);
});
