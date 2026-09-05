import { test } from "node:test";
import assert from "node:assert/strict";
import { checkContains, validateDefinedTermJsonLd } from "./healthz-seo.checks";

// ── checkContains ─────────────────────────────────────────────────────────────

test("checkContains: passes when needle is present", () => {
  const result = checkContains('<h1>Some Term</h1>', "<h1", "test: has H1");
  assert.equal(result.name, "test: has H1");
  assert.equal(result.pass, true);
});

test("checkContains: fails when needle is absent", () => {
  const result = checkContains("<div>no heading here</div>", "<h1", "test: has H1");
  assert.equal(result.name, "test: has H1");
  assert.equal(result.pass, false);
});

// ── H1 element presence check ─────────────────────────────────────────────────
// Mirrors the two checks added for glossary detail pages:
//   checkContains(html, `<h1`, `glossary/${slug}: page contains an H1 element`)
//   checkContains(html, conceptTerm, `glossary/${slug}: H1 term text … present in initial HTML`)

const CONCEPT_SLUG = "cognitive-dissonance";
const CONCEPT_TERM = "Cognitive Dissonance";

const GOOD_GLOSSARY_HTML = `<!DOCTYPE html>
<html>
<head><title>Cognitive Dissonance – BrainHook Glossary</title></head>
<body>
<h1>${CONCEPT_TERM}</h1>
<p>The discomfort of holding two conflicting beliefs.</p>
<script id="ssr-data-concept-detail" type="application/json">{"slug":"cognitive-dissonance"}</script>
</body>
</html>`;

// A page where the SSR server ran but renderGlossaryDetailHtml was skipped —
// no <h1> and no term text; the skeleton is client-rendered.
const MISSING_H1_HTML = `<!DOCTYPE html>
<html>
<head><title>BrainHook Glossary</title></head>
<body>
<div class="loading-skeleton"></div>
<script id="ssr-data-concept-detail" type="application/json">{"slug":"cognitive-dissonance"}</script>
</body>
</html>`;

const MISSING_SSR_DATA_HTML = `<!DOCTYPE html>
<html>
<head><title>Cognitive Dissonance – BrainHook Glossary</title></head>
<body>
<h1>${CONCEPT_TERM}</h1>
<p>The discomfort of holding two conflicting beliefs.</p>
</body>
</html>`;

const EMPTY_SHELL_HTML = `<!DOCTYPE html>
<html>
<head><title>Loading…</title></head>
<body><div id="root"></div></body>
</html>`;

// H1 element presence
test(`glossary detail: H1 check passes when <h1 is present`, () => {
  const r = checkContains(GOOD_GLOSSARY_HTML, "<h1", `glossary/${CONCEPT_SLUG}: page contains an H1 element`);
  assert.equal(r.pass, true);
});

test(`glossary detail: H1 check fails when <h1 is absent`, () => {
  const r = checkContains(MISSING_H1_HTML, "<h1", `glossary/${CONCEPT_SLUG}: page contains an H1 element`);
  assert.equal(r.pass, false);
});

test(`glossary detail: H1 check fails on empty client-only shell`, () => {
  const r = checkContains(EMPTY_SHELL_HTML, "<h1", `glossary/${CONCEPT_SLUG}: page contains an H1 element`);
  assert.equal(r.pass, false);
});

// H1 term text presence
test(`glossary detail: term text check passes when conceptTerm is in initial HTML`, () => {
  const r = checkContains(
    GOOD_GLOSSARY_HTML,
    CONCEPT_TERM,
    `glossary/${CONCEPT_SLUG}: H1 term text "${CONCEPT_TERM}" present in initial HTML`,
  );
  assert.equal(r.pass, true);
});

test(`glossary detail: term text check fails when conceptTerm is absent (client-deferred load)`, () => {
  const r = checkContains(
    MISSING_H1_HTML,
    CONCEPT_TERM,
    `glossary/${CONCEPT_SLUG}: H1 term text "${CONCEPT_TERM}" present in initial HTML`,
  );
  assert.equal(r.pass, false);
});

test(`glossary detail: term text check fails on empty shell`, () => {
  const r = checkContains(
    EMPTY_SHELL_HTML,
    CONCEPT_TERM,
    `glossary/${CONCEPT_SLUG}: H1 term text "${CONCEPT_TERM}" present in initial HTML`,
  );
  assert.equal(r.pass, false);
});

// ── ssr-data-concept-detail hydration script ──────────────────────────────────
// Mirrors: checkContains(html, 'id="ssr-data-concept-detail"', …)

test(`glossary detail: ssr-data check passes when hydration script tag is present`, () => {
  const r = checkContains(
    GOOD_GLOSSARY_HTML,
    'id="ssr-data-concept-detail"',
    `glossary/${CONCEPT_SLUG}: ssr-data-concept-detail hydration script is present`,
  );
  assert.equal(r.pass, true);
});

test(`glossary detail: ssr-data check fails when hydration script tag is absent`, () => {
  const r = checkContains(
    MISSING_SSR_DATA_HTML,
    'id="ssr-data-concept-detail"',
    `glossary/${CONCEPT_SLUG}: ssr-data-concept-detail hydration script is present`,
  );
  assert.equal(r.pass, false);
});

test(`glossary detail: ssr-data check fails on empty shell`, () => {
  const r = checkContains(
    EMPTY_SHELL_HTML,
    'id="ssr-data-concept-detail"',
    `glossary/${CONCEPT_SLUG}: ssr-data-concept-detail hydration script is present`,
  );
  assert.equal(r.pass, false);
});

// ── Both H1 and ssr-data absent simultaneously ────────────────────────────────
// Simulates a renderGlossaryDetailHtml regression that removes server rendering entirely.

test(`glossary detail: all three checks fail on a bare client-only shell`, () => {
  const h1Check = checkContains(EMPTY_SHELL_HTML, "<h1", `glossary/${CONCEPT_SLUG}: page contains an H1 element`);
  const termCheck = checkContains(
    EMPTY_SHELL_HTML,
    CONCEPT_TERM,
    `glossary/${CONCEPT_SLUG}: H1 term text "${CONCEPT_TERM}" present in initial HTML`,
  );
  const ssrCheck = checkContains(
    EMPTY_SHELL_HTML,
    'id="ssr-data-concept-detail"',
    `glossary/${CONCEPT_SLUG}: ssr-data-concept-detail hydration script is present`,
  );
  assert.equal(h1Check.pass, false, "H1 check should fail on empty shell");
  assert.equal(termCheck.pass, false, "term text check should fail on empty shell");
  assert.equal(ssrCheck.pass, false, "ssr-data check should fail on empty shell");
});

// ── validateDefinedTermJsonLd ──────────────────────────────────────────────────

const VALID_DEFINED_TERM_HTML = `<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "DefinedTerm",
  "name": "Cognitive Dissonance",
  "description": "The discomfort of holding conflicting beliefs.",
  "url": "https://brainhook.net/glossary/cognitive-dissonance",
  "inDefinedTermSet": {
    "@type": "DefinedTermSet",
    "name": "BrainHook Glossary",
    "url": "https://brainhook.net/glossary"
  }
}
</script>
</head><body><h1>Cognitive Dissonance</h1></body></html>`;

const NO_JSONLD_HTML = `<html><head></head><body><h1>Cognitive Dissonance</h1></body></html>`;

const BAD_CONTEXT_HTML = `<html><head>
<script type="application/ld+json">
{
  "@context": "https://wrongschema.org",
  "@type": "DefinedTerm",
  "name": "Cognitive Dissonance",
  "description": "The discomfort of holding conflicting beliefs.",
  "url": "https://brainhook.net/glossary/cognitive-dissonance",
  "inDefinedTermSet": {
    "@type": "DefinedTermSet",
    "name": "BrainHook Glossary",
    "url": "https://brainhook.net/glossary"
  }
}
</script>
</head><body></body></html>`;

const MISSING_FIELDS_HTML = `<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "DefinedTerm",
  "name": "Cognitive Dissonance"
}
</script>
</head><body></body></html>`;

test("validateDefinedTermJsonLd: passes on well-formed DefinedTerm JSON-LD", () => {
  const r = validateDefinedTermJsonLd(VALID_DEFINED_TERM_HTML, CONCEPT_SLUG);
  assert.equal(r.pass, true, `expected pass, got: ${r.detail}`);
});

test("validateDefinedTermJsonLd: fails when no JSON-LD block is present", () => {
  const r = validateDefinedTermJsonLd(NO_JSONLD_HTML, CONCEPT_SLUG);
  assert.equal(r.pass, false);
  assert.ok(r.detail?.includes("no DefinedTerm JSON-LD block found"), `detail: ${r.detail}`);
});

test("validateDefinedTermJsonLd: fails when @context is wrong", () => {
  const r = validateDefinedTermJsonLd(BAD_CONTEXT_HTML, CONCEPT_SLUG);
  assert.equal(r.pass, false);
  assert.ok(r.detail?.includes("@context="), `detail: ${r.detail}`);
});

test("validateDefinedTermJsonLd: fails when required fields are missing", () => {
  const r = validateDefinedTermJsonLd(MISSING_FIELDS_HTML, CONCEPT_SLUG);
  assert.equal(r.pass, false);
  assert.ok(r.detail?.includes("description is missing"), `detail: ${r.detail}`);
});

test("validateDefinedTermJsonLd: check name includes concept slug", () => {
  const r = validateDefinedTermJsonLd(VALID_DEFINED_TERM_HTML, CONCEPT_SLUG);
  assert.ok(r.name.includes(CONCEPT_SLUG), `name should include slug: ${r.name}`);
});
