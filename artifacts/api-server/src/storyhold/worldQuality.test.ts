import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  canonicalClaimValueKey,
  claimContradictionFindings,
  characterCompletenessFindings,
  genericSceneReferenceSurface,
  referenceResolutionFindings,
  upsertWorldQualityFinding,
} from "./worldQuality";
import { ENTITY_PROSE_FIELDS } from "./entityProseVerification";

function claim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "claim-1", subject_entity_id: "mira-id", subject_name: "Mira", predicate: "dossier.summary",
    object_text: "Mira shelters fugitives.", object_entity_id: null, object_name: null, polarity: "positive",
    epistemic_holder_entity_id: null, epistemic_holder_name: null, truth_status: "fact", valid_from_label: "", valid_until_label: "", ...overrides };
}

test("separate dossier sentences, list items and aliases are additive rather than conflicting scalar values", () => {
  for (const field of ENTITY_PROSE_FIELDS) {
    const claims = [claim({ predicate: `dossier.${field}` }), claim({ id: "claim-2", predicate: `dossier.${field}`, object_text: "Mira guards the tower." })];
    assert.deepEqual(claimContradictionFindings(claims, new Map()), [], field);
  }
  const labels = new Map([["mira", new Set(["mira-id"])], ["miri", new Set(["mira-id"])]]);
  assert.deepEqual(claimContradictionFindings([claim({ predicate: "dossier.aliases", object_text: "Mira", polarity: "negative" }),
    claim({ id: "claim-2", predicate: "dossier.aliases", object_text: "Miri" })], labels), []);
});

test("affirming and denying the same dossier proposition produces an actionable human-readable warning", () => {
  const result = claimContradictionFindings([claim(), claim({ id: "claim-2", polarity: "negative", object_text: "  MIRA shelters fugitives.  " }),
    claim({ id: "claim-3", object_text: "Mira guards the tower." })], new Map());
  assert.equal(result.length, 1); assert.match(result[0]!.label, /conflicting Summary statement/);
  assert.match(result[0]!.explanation, /Mira shelters fugitives/); assert.match(result[0]!.explanation, /affirmed and denied/);
  assert.doesNotMatch(`${result[0]!.label} ${result[0]!.explanation}`, /dossier\./);
  assert.deepEqual(result[0]!.metadata?.claimIds, ["claim-1", "claim-2"]);
  assert.deepEqual(result[0]!.metadata?.polarities, ["positive", "negative"]);
});

test("dossier contradiction scope preserves holder, truth status, time boundaries, subject and exact statement", () => {
  for (const changed of [{ epistemic_holder_entity_id: "dara-id" }, { truth_status: "belief" }, { valid_from_label: "spring" },
    { valid_until_label: "winter" }, { subject_entity_id: "dara-id" }, { object_text: "Mira once sheltered fugitives." }]) {
    assert.deepEqual(claimContradictionFindings([claim(), claim({ id: "claim-2", polarity: "negative", ...changed })], new Map()), []);
  }
  for (const status of ["fact", "belief", "rumor", "lie", "disputed", "unknown"]) {
    const scoped = { truth_status: status, epistemic_holder_entity_id: "dara-id", epistemic_holder_name: "Dara", valid_from_label: "winter", valid_until_label: "spring" };
    const result = claimContradictionFindings([claim(scoped), claim({ id: "claim-2", polarity: "negative", ...scoped })], new Map());
    assert.equal(result.length, 1, status); assert.match(result[0]!.explanation, /Dara's account/); assert.match(result[0]!.explanation, /from winter until spring/);
  }
  assert.deepEqual(claimContradictionFindings([claim(), claim({ id: "claim-2", polarity: "positive" })], new Map()), []);
  assert.deepEqual(claimContradictionFindings([claim(), claim({ id: "claim-2", polarity: undefined })], new Map()), []);
});

test("legacy scalar contradiction behavior and canonical alias resolution are unchanged", () => {
  const labels = new Map([["alec", new Set(["alec-id"])], ["alec sumner", new Set(["alec-id"])]]);
  const legacy = claim({ predicate: "father", object_text: "Alec" });
  assert.deepEqual(claimContradictionFindings([legacy, { ...legacy, id: "claim-2", object_text: "Alec Sumner" }], labels), []);
  const conflict = claimContradictionFindings([legacy, { ...legacy, id: "claim-2", object_text: "Someone Else", truth_status: "belief" }], labels);
  assert.equal(conflict.length, 1); assert.equal(conflict[0]!.label, "Mira: conflicting “father” claims");
  assert.deepEqual(claimContradictionFindings([legacy, { ...legacy, id: "claim-2", object_text: "Someone Else", truth_status: "rumor" }], labels), []);
  // The new additive rule is intentionally narrow, not a blanket exemption
  // for unknown future names under the dossier prefix.
  assert.equal(claimContradictionFindings([claim({ predicate: "dossier.unknown" }),
    claim({ id: "claim-2", predicate: "dossier.unknown", object_text: "Different" })], labels).length, 1);
});

test("generic scene referents do not become misleading canon contradictions", () => {
  assert.equal(genericSceneReferenceSurface("The Town"), true);
  assert.equal(genericSceneReferenceSurface("the camp"), true);
  assert.equal(genericSceneReferenceSurface("Sanctuary"), false);
  assert.equal(genericSceneReferenceSurface("Co-op survivors"), false);
});

test("claim contradiction checks treat a unique canonical alias as the same value", () => {
  const labels = new Map<string, ReadonlySet<string>>([
    ["alec sumner", new Set(["alec-id"])],
    ["alec", new Set(["alec-id"])],
  ]);
  assert.equal(
    canonicalClaimValueKey({ objectText: "Alec", labelEntityIds: labels }),
    canonicalClaimValueKey({ objectText: "Alec Sumner", labelEntityIds: labels }),
  );
  assert.notEqual(
    canonicalClaimValueKey({ objectText: "someone else", labelEntityIds: labels }),
    canonicalClaimValueKey({ objectText: "Alec Sumner", labelEntityIds: labels }),
  );
});

test("important characters receive a deterministic completeness finding", () => {
  const findings = characterCompletenessFindings({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Mara",
    mentionCount: 120,
    profile: {
      traits: ["stubborn"],
      history: [],
      relationships: [],
      relationshipWeb: [],
      motivations: [],
      physicalCharacteristics: [],
      knowledge: [],
    },
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "warning");
  assert.deepEqual(findings[0]?.metadata?.missingFields, [
    "history",
    "relationships",
    "motivations",
    "physical description",
    "knowledge and beliefs",
  ]);
});

test("minor characters are not forced into invented completeness", () => {
  assert.deepEqual(
    characterCompletenessFindings({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Guard",
      mentionCount: 2,
      profile: {},
    }),
    [],
  );
});

test("a recurring flavor character can remain intentionally incomplete", () => {
  assert.deepEqual(
    characterCompletenessFindings({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Stali",
      mentionCount: 16,
      profile: {},
    }),
    [],
  );
});

test("unresolved canonical references become grouped durable quality findings", () => {
  const findings = referenceResolutionFindings([
    {
      kind: "event_participant",
      label: "the search party",
      resolution: "missing",
      context: "Camera thirty proves the Destroyer is Alec",
      metadata: { role: "witness" },
    },
    {
      kind: "event_participant",
      label: "the search party",
      resolution: "missing",
      context: "The party reaches Sanctuary",
      metadata: { role: "witness" },
    },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.category, "chronology");
  assert.equal(findings[0]?.severity, "warning");
  assert.equal(findings[0]?.metadata?.occurrences, 2);
  assert.deepEqual(findings[0]?.metadata?.contexts, [
    "Camera thirty proves the Destroyer is Alec",
    "The party reaches Sanctuary",
  ]);
});

test("an unresolved entity-rule owner becomes an evidence warning", () => {
  const [finding] = referenceResolutionFindings([{
    kind: "entity_rule",
    label: "Unknown physiology",
    resolution: "ambiguous",
    context: "Cannot survive sunlight",
    metadata: { ruleKind: "biological" },
  }]);
  assert.equal(finding?.category, "evidence");
  assert.equal(finding?.severity, "warning");
  assert.match(finding?.label ?? "", /entity-rule owner/);
  assert.equal(finding?.metadata?.kind, "entity_rule");
  assert.equal(finding?.metadata?.resolution, "ambiguous");
});

test("quality refresh preserves a customer's ignored finding", async () => {
  const db = new PGlite();
  const worldId = "40000000-0000-4000-8000-000000000001";
  const editionId = "40000000-0000-4000-8000-000000000002";
  const finding = {
    category: "coverage" as const,
    severity: "info" as const,
    subjectKind: "chapter",
    subjectId: null,
    label: "Prologue has no major events",
    explanation: "The local parser found no major events.",
    recommendedTask: "Review this chapter.",
    metadata: { chapterKey: "prologue-2" },
  };
  try {
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.world_quality_findings (
        id uuid PRIMARY KEY,
        world_id uuid NOT NULL,
        canon_edition_id uuid NOT NULL,
        source_analysis_run_id uuid,
        fingerprint text NOT NULL,
        category text NOT NULL,
        severity text NOT NULL,
        subject_kind text NOT NULL,
        subject_id uuid,
        label text NOT NULL,
        explanation text NOT NULL,
        recommended_task text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        finding_status text NOT NULL DEFAULT 'open',
        first_detected_at timestamptz NOT NULL DEFAULT now(),
        last_detected_at timestamptz NOT NULL DEFAULT now(),
        resolved_at timestamptz,
        UNIQUE (world_id, canon_edition_id, fingerprint)
      );
    `);
    const key = await upsertWorldQualityFinding({
      db,
      worldId,
      editionId,
      finding,
    });
    await db.query(
      `UPDATE storyhold.world_quality_findings
          SET finding_status = 'ignored', resolved_at = '2025-02-03T04:05:06Z'
        WHERE world_id = $1 AND canon_edition_id = $2 AND fingerprint = $3`,
      [worldId, editionId, key],
    );

    await upsertWorldQualityFinding({
      db,
      worldId,
      editionId,
      finding: {
        ...finding,
        severity: "warning",
        explanation: "The finding was detected again after restart.",
        metadata: { chapterKey: "prologue-2", detectionCount: 2 },
      },
    });

    const stored = await db.query<{
      finding_status: string;
      severity: string;
      explanation: string;
      metadata: Record<string, unknown>;
      resolved_at: Date | null;
    }>(
      `SELECT finding_status, severity, explanation, metadata, resolved_at
         FROM storyhold.world_quality_findings
        WHERE world_id = $1 AND canon_edition_id = $2 AND fingerprint = $3`,
      [worldId, editionId, key],
    );
    assert.equal(stored.rows[0]?.finding_status, "ignored");
    assert.equal(stored.rows[0]?.severity, "warning");
    assert.equal(
      stored.rows[0]?.explanation,
      "The finding was detected again after restart.",
    );
    assert.deepEqual(stored.rows[0]?.metadata, {
      chapterKey: "prologue-2",
      detectionCount: 2,
    });
    assert.equal(
      stored.rows[0]?.resolved_at?.toISOString(),
      "2025-02-03T04:05:06.000Z",
    );
  } finally {
    await db.close();
  }
});
