import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOwnerProtectionSnapshot,
  compareOwnerProtectionSnapshots,
  parseAuditCliArguments,
} from "./auditRootFixProof.js";

const inheritedSuppressedDossier = {
  id: "dossier-1",
  name: "Inherited Record",
  normalized_name: "inherited record",
  aliases: [],
  alias_attributions: [],
  role: "",
  summary: "Pre-replay customer state",
  profile: {},
  evidence: [],
  confidence: 0.6,
  dossier_status: "suppressed",
  axis_estimate: {},
  axis_user_override: null,
  axis_user_changed_at: null,
  user_edited_at: "2026-08-01T00:00:00.000Z",
  mention_count: 1,
  mention_source_count: 1,
};

function snapshot(dossiers: Record<string, unknown>[]) {
  return buildOwnerProtectionSnapshot({
    entities: [],
    dossiers,
    relations: [],
    memberships: [],
    rules: [],
    claims: [],
  });
}

test("inherited suppressed customer-edited dossiers pass when baseline and replay match", () => {
  const baseline = snapshot([inheritedSuppressedDossier]);
  const current = snapshot([{ ...inheritedSuppressedDossier }]);
  const comparison = compareOwnerProtectionSnapshots(baseline, current);
  assert.equal(comparison.passed, true);
  assert.deepEqual(comparison.missing, []);
  assert.deepEqual(comparison.changed, []);
  assert.deepEqual(comparison.added, []);
  assert.deepEqual(comparison.inheritedSuppressedEditedDossierIds, ["dossier-1"]);
});

test("baseline comparison rejects changed, missing, and newly protected rows", () => {
  const baseline = snapshot([
    inheritedSuppressedDossier,
    { ...inheritedSuppressedDossier, id: "dossier-2", summary: "Must remain" },
  ]);
  const current = snapshot([
    { ...inheritedSuppressedDossier, summary: "Silently rewritten" },
    { ...inheritedSuppressedDossier, id: "dossier-3", summary: "Unexpected protection" },
  ]);
  const comparison = compareOwnerProtectionSnapshots(baseline, current);
  assert.equal(comparison.passed, false);
  assert.deepEqual(comparison.changed.map((row) => row.key), ["dossier:dossier-1"]);
  assert.deepEqual(comparison.missing.map((row) => row.key), ["dossier:dossier-2"]);
  assert.deepEqual(comparison.added.map((row) => row.key), ["dossier:dossier-3"]);
});

test("CLI parser accepts baseline, atomic output, and pretty formatting in any flag order", () => {
  assert.deepEqual(parseAuditCliArguments([
    "proof-db",
    "5e0bebbc-06fd-414b-be7a-bb02732f7808",
    "--output",
    "audit.json",
    "--pretty",
    "--baseline",
    "baseline-db",
  ]), {
    dataDirArgument: "proof-db",
    worldId: "5e0bebbc-06fd-414b-be7a-bb02732f7808",
    baselineArgument: "baseline-db",
    outputArgument: "audit.json",
    pretty: true,
  });
  assert.throws(
    () => parseAuditCliArguments(["proof-db", "world", "--baseline"]),
    /--baseline requires a path/u,
  );
  assert.throws(
    () => parseAuditCliArguments(["proof-db", "world", "--output", "one", "--output", "two"]),
    /--output may only be supplied once/u,
  );
});
