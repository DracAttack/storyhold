import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractRequiredEntities,
  sourceIsOnCase,
  assignSourceRole,
  isCorePacketRole,
} from "./packetRelevance";

// --- extractRequiredEntities --------------------------------------------------

test("extracts person name from a prose angle", () => {
  const e = extractRequiredEntities(
    "A Texas man got 30 years for handing out zines",
    "Daniel Sanchez Estrada was sentenced for obstruction after distributing anti-ICE zines at a protest.",
  );
  assert.ok(e.strong.some((s) => s.includes("Daniel Sanchez Estrada")), `strong=${e.strong}`);
  assert.ok(e.weak.includes("sentenced"), `weak=${e.weak}`);
  assert.ok(e.weak.includes("obstruction"));
  assert.ok(e.weak.includes("ice"));
});

test("title-case headline does not pollute strong entities", () => {
  const e = extractRequiredEntities("A Texas Man Got 30 Years For Handing Out Zines", null);
  // "Texas Man Got Years" must NOT become a required entity.
  assert.ok(
    !e.strong.some((s) => /man got/i.test(s)),
    `strong should not contain headline noise: ${e.strong}`,
  );
});

test("generic idea yields no entities", () => {
  const e = extractRequiredEntities("Why your brain loves a good list", "We keep clicking. Here's the psychology.");
  assert.equal(e.strong.length, 0, `strong=${e.strong}`);
});

test("quoted phrases become strong entities", () => {
  const e = extractRequiredEntities('The "quiet cracking" trend taking over offices', null);
  assert.ok(e.strong.includes("quiet cracking"), `strong=${e.strong}`);
});

// --- sourceIsOnCase -------------------------------------------------------------

const ENTITIES = extractRequiredEntities(
  "A Texas man got 30 years for handing out zines",
  "Daniel Sanchez Estrada was convicted of obstruction and conspiracy after distributing anti-ICE zines at a protest in El Paso.",
);

test("no entities at all → everything passes", () => {
  assert.ok(sourceIsOnCase("Any text at all", { strong: [], weak: [] }));
});

test("source mentioning the main entity is on-case", () => {
  assert.ok(
    sourceIsOnCase(
      "El Paso — Daniel Sanchez Estrada, 28, received a 30-year sentence on Tuesday...",
      ENTITIES,
    ),
  );
});

test("topic-adjacent source without the entity is off-case", () => {
  assert.ok(
    !sourceIsOnCase(
      "The House select subcommittee released its final report on the coronavirus pandemic response.",
      ENTITIES,
    ),
  );
});

test("same-case article omitting the full name is rescued by heavy event-term overlap", () => {
  const text =
    "A man was convicted of obstruction and conspiracy after he was arrested at a protest for handing out anti-ICE zines.";
  assert.ok(sourceIsOnCase(text, ENTITIES));
});

test("two generic term hits do not rescue when strong entities exist", () => {
  const text = "Protesters were arrested outside the courthouse during a rally on Monday.";
  assert.ok(!sourceIsOnCase(text, ENTITIES));
});

test("empty source text is off-case when entities exist", () => {
  assert.ok(!sourceIsOnCase("", ENTITIES));
});

test("weak-only entities need min(2, n) hits", () => {
  const weakOnly = { strong: [], weak: ["recall", "outbreak"] };
  assert.ok(sourceIsOnCase("The recall follows an outbreak traced to the plant.", weakOnly));
  assert.ok(!sourceIsOnCase("The recall was announced Friday.", weakOnly));
  const single = { strong: [], weak: ["recall"] };
  assert.ok(sourceIsOnCase("The recall was announced Friday.", single));
});

// --- assignSourceRole -----------------------------------------------------------

const base = { onCase: true, title: null as string | null, url: "https://example.com/a" };

test("off-case is always background_only", () => {
  assert.equal(
    assignSourceRole({ ...base, onCase: false, authorityTier: "primary", domain: "courtlistener.com" }),
    "background_only",
  );
});

test("primary tier → primary_record, unless prosecution-voiced", () => {
  assert.equal(
    assignSourceRole({ ...base, authorityTier: "primary", domain: "courtlistener.com" }),
    "primary_record",
  );
  assert.equal(
    assignSourceRole({
      ...base,
      authorityTier: "primary",
      domain: "justice.gov",
      url: "https://justice.gov/usao/pr/texas-man-sentenced",
    }),
    "prosecution_framing",
  );
});

test("firsthand tier splits by voice", () => {
  assert.equal(
    assignSourceRole({
      ...base,
      authorityTier: "firsthand",
      domain: "aclu.org",
      title: "ACLU statement on zine prosecution",
    }),
    "defense_or_advocacy_framing",
  );
  assert.equal(
    assignSourceRole({
      ...base,
      authorityTier: "firsthand",
      domain: "elpasopd.example",
      title: "Police Department press release",
    }),
    "prosecution_framing",
  );
  assert.equal(
    assignSourceRole({ ...base, authorityTier: "firsthand", domain: "witnessblog.example" }),
    "core_evidence",
  );
});

test("wire and reported tiers are core_evidence", () => {
  assert.equal(assignSourceRole({ ...base, authorityTier: "wire", domain: "apnews.com" }), "core_evidence");
  assert.equal(assignSourceRole({ ...base, authorityTier: "reported", domain: "bbc.com" }), "core_evidence");
});

test("commentary/social/unknown are context roles, never core", () => {
  assert.equal(
    assignSourceRole({ ...base, authorityTier: "commentary", domain: "substack.com" }),
    "reported_context",
  );
  assert.equal(assignSourceRole({ ...base, authorityTier: "social", domain: "x.com" }), "reported_context");
  assert.equal(assignSourceRole({ ...base, authorityTier: null, domain: "blog.example" }), "reported_context");
});

test("core role set is exactly core_evidence + primary_record", () => {
  assert.ok(isCorePacketRole("core_evidence"));
  assert.ok(isCorePacketRole("primary_record"));
  assert.ok(!isCorePacketRole("prosecution_framing"));
  assert.ok(!isCorePacketRole("defense_or_advocacy_framing"));
  assert.ok(!isCorePacketRole("reported_context"));
  assert.ok(!isCorePacketRole("background_only"));
  assert.ok(!isCorePacketRole(null));
});
