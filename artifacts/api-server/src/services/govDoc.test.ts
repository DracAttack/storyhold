import { test } from "node:test";
import assert from "node:assert/strict";
import {
  govDocSubject,
  govDocDisplayTitle,
  isGovInfoDoc,
  isGovSerialTitle,
  stripGovBoilerplate,
} from "./govDoc";
import { tokens, jaccard } from "./dedupe";

// Text samples below are copied verbatim from production GovInfo documents
// (source_documents.extracted_text leads) — they are what the parsers must
// actually handle.

const REPORT_ND = `69–006 119TH CONGRESS REPORT " !HOUSE OF REPRESENTATIVES2d Session 119–581 NORTH DAKOTA TRUST LANDS COMPLETION ACT OF 2026 APRIL 2, 2026.—Committed to the Committee of the Whole House on the State of the Union and ordered to be printed`;

const REPORT_PECHANGA = `69–006 119TH CONGRESS REPORT " !HOUSE OF REPRESENTATIVES2d Session 119–585 TO TAKE CERTAIN LAND IN THE STATE OF CALIFORNIA INTO TRUST FOR THE BENEFIT OF THE PECHANGA BAND OF INDIANS, AND FOR OTHER PURPOSES APRIL 2, 2026.—Committed to the Committee of the Whole House on the State of the Union`;

const REPORT_TRADING = `69–006 119TH CONGRESS REPORT " !HOUSE OF REPRESENTATIVES2d Session 119–573 RESTORING THE SECONDARY TRADING MARKET ACT MARCH 25, 2026.—Committed to the Committee of the Whole House on the State of the Union`;

const PRES_REMARKS = `1 Administration of Donald J. Trump, 2026 Remarks at a Welcoming Ceremony for King Charles III of the United Kingdom April 28, 2026 Thank you very much. Thank you very much, everybody.`;

const PRES_PRESSER = `1 Administration of Donald J. Trump, 2026 The President's News Conference With Acting Attorney General Todd Blanche and Federal Bureau of Investigation Director Kashyap P. "Kash" Patel April 25, 2026 The President. Well, thank you very much.`;

const HEARING_CODES = `U.S. GOVERNMENT PUBLISHING OFFICE WASHINGTON :63–529 2026 PROTECTING U.S. LEADERSHIP IN CODES DEVELOPMENT AND ENHANCING PUBLIC ACCESS HEARING BEFORE THE SUBCOMMITTEE ON COURTS, INTELLECTUAL PROPERTY, ARTIFICIAL INTELLIGENCE, AND THE INTERNET OF THE COMMITTEE ON THE JUDICIARY U.S. HOUSE OF REPRESENTATIVES`;

const HEARING_ENERGY = `U.S. GOVERNMENT PUBLISHING OFFICE WASHINGTON :60–258 PDF 2026 S. HRG. 119–64 ENERGY AND WATER DEVELOPMENT APPROPRIATIONS FOR FISCAL YEAR 2026 HEARINGS BEFORE A SUBCOMMITTEE OF THE COMMITTEE ON APPROPRIATIONS UNITED STATES SENATE ONE HUNDRED NINETEENTH CONGRESS FIRST SESSION ON H.R. 6938`;

// --- serial title detection -------------------------------------------------

test("isGovSerialTitle: matches the GovInfo serial title formats", () => {
  assert.ok(isGovSerialTitle("Congressional Report 119hrpt721"));
  assert.ok(isGovSerialTitle("Congressional Hearing 119hhrg63873"));
  assert.ok(isGovSerialTitle("Presidential Document 202600353"));
  assert.ok(isGovSerialTitle("Congressionally Mandated Report VA1-00190302"));
});

test("isGovSerialTitle: rejects real headlines", () => {
  assert.ok(!isGovSerialTitle("North Dakota Trust Lands Completion Act of 2026"));
  assert.ok(!isGovSerialTitle("Congress passes a landmark trust lands bill"));
  assert.ok(!isGovSerialTitle(null));
  assert.ok(!isGovSerialTitle(""));
});

test("isGovInfoDoc: only govinfo.gov domains", () => {
  assert.ok(isGovInfoDoc("govinfo.gov"));
  assert.ok(isGovInfoDoc("www.govinfo.gov"));
  assert.ok(!isGovInfoDoc("congress.gov"));
  assert.ok(!isGovInfoDoc(null));
});

// --- subject extraction -----------------------------------------------------

test("govDocSubject: congressional report — bill title extracted and cased", () => {
  assert.equal(govDocSubject(REPORT_ND), "North Dakota Trust Lands Completion Act of 2026");
});

test("govDocSubject: congressional report — long land-into-trust subject", () => {
  const s = govDocSubject(REPORT_PECHANGA);
  assert.ok(s, "expected a subject");
  assert.match(s!, /Pechanga Band of Indians/i);
});

test("govDocSubject: presidential document — remarks title extracted", () => {
  assert.equal(
    govDocSubject(PRES_REMARKS),
    "Remarks at a Welcoming Ceremony for King Charles III of the United Kingdom",
  );
});

test("govDocSubject: presidential document — news conference title extracted", () => {
  const s = govDocSubject(PRES_PRESSER);
  assert.ok(s, "expected a subject");
  assert.match(s!, /News Conference/);
});

test("govDocSubject: hearing — subject before HEARING BEFORE extracted", () => {
  const s = govDocSubject(HEARING_CODES);
  assert.ok(s, "expected a subject");
  assert.match(s!, /Codes Development/i);
  assert.doesNotMatch(s!, /GOVERNMENT PUBLISHING OFFICE/i);
});

test("govDocSubject: null/empty text yields null", () => {
  assert.equal(govDocSubject(null), null);
  assert.equal(govDocSubject(""), null);
  assert.equal(govDocSubject("short"), null);
});

// --- display title ----------------------------------------------------------

test("govDocDisplayTitle: serial title + extractable subject → typed headline", () => {
  const title = govDocDisplayTitle({
    domain: "govinfo.gov",
    title: "Congressional Report 119hrpt581",
    extractedText: REPORT_ND,
  });
  assert.equal(title, "Congressional Report: North Dakota Trust Lands Completion Act of 2026");
});

test("govDocDisplayTitle: non-GovInfo docs are never rewritten", () => {
  assert.equal(
    govDocDisplayTitle({
      domain: "nytimes.com",
      title: "Congressional Report 119hrpt581",
      extractedText: REPORT_ND,
    }),
    null,
  );
});

test("govDocDisplayTitle: a real (non-serial) title is kept as-is", () => {
  assert.equal(
    govDocDisplayTitle({
      domain: "govinfo.gov",
      title: "Congress passes trust lands bill",
      extractedText: REPORT_ND,
    }),
    null,
  );
});

test("govDocDisplayTitle: unparseable text (transmittal letters) keeps the serial", () => {
  assert.equal(
    govDocDisplayTitle({
      domain: "govinfo.gov",
      title: "Congressionally Mandated Report VA1-00190302",
      extractedText:
        "THE SECRETARY OF VETERANS AFFAIRS WASHINGTON The Honorable Jon Tester Chairman",
    }),
    null,
  );
});

// --- boilerplate stripping → cluster separation ------------------------------
// The actual regression: distinct congressional reports shared so much masthead
// vocabulary that jaccard(docA, docB) cleared the 0.2 join threshold and 50+
// unrelated reports merged into one cluster. After stripping, the remaining
// tokens are the bill subjects, which do NOT clear the threshold.

test("stripGovBoilerplate: removes the congressional masthead", () => {
  const out = stripGovBoilerplate(REPORT_ND);
  assert.doesNotMatch(out, /119TH CONGRESS/i);
  assert.doesNotMatch(out, /HOUSE OF REPRESENTATIVES/i);
  assert.doesNotMatch(out, /Committed to the Committee of the Whole House/i);
  assert.match(out, /NORTH DAKOTA TRUST LANDS/i);
});

test("unrelated gov reports fall below the 0.2 cluster join threshold after stripping", () => {
  const pairs: Array<[string, string]> = [
    [REPORT_ND, REPORT_TRADING],
    [REPORT_ND, REPORT_PECHANGA],
    [HEARING_CODES, HEARING_ENERGY],
    [PRES_REMARKS, REPORT_ND],
  ];
  for (const [a, b] of pairs) {
    const sim = jaccard(tokens(stripGovBoilerplate(a)), tokens(stripGovBoilerplate(b)));
    assert.ok(sim < 0.2, `expected < 0.2 similarity after strip, got ${sim.toFixed(3)}`);
  }
});

test("without stripping, the same reports DO false-merge (documents the bug)", () => {
  const sim = jaccard(tokens(REPORT_ND), tokens(REPORT_TRADING));
  assert.ok(sim >= 0.2, `expected the raw masthead overlap to clear 0.2, got ${sim.toFixed(3)}`);
});
