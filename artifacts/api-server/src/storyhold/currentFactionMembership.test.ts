import assert from "node:assert/strict";
import test from "node:test";
import { canProjectCurrentFactionMembership } from "./premiumGraphVerification";
import type { EntityRelationFinding } from "./worldAnalysis";

type Link = Parameters<typeof canProjectCurrentFactionMembership>[0];
const current: Link = { relationType: "member_of", status: "active", validFromLabel: "", validUntilLabel: "" };
test("only active undated links to factions project current membership", () => {
  assert.equal(canProjectCurrentFactionMembership(current, "faction", "character"), true);
  assert.equal(canProjectCurrentFactionMembership(current, "faction", "creature"), true);
  for (const status of ["former", "conditional", "disputed", "unknown"] as const) {
    assert.equal(canProjectCurrentFactionMembership({ ...current, status }, "faction", "character"), false);
  }
  for (const target of ["character", "creature", "species", "place", "government", "institution", "technology", "ambiguous", undefined]) {
    assert.equal(canProjectCurrentFactionMembership(current, target, "character"), false);
  }
  for (const source of ["faction", "species", "place", "government", "institution", "technology", "ambiguous", undefined]) {
    assert.equal(canProjectCurrentFactionMembership(current, "faction", source), false);
  }
  for (const relationType of ["participates_in", "allied_with", "opposed_to", "related_to", "leads"] as EntityRelationFinding["relationType"][]) {
    assert.equal(canProjectCurrentFactionMembership({ ...current, relationType }, "faction", "character"), false);
  }
});
test("temporal labels are trimmed without erasing meaningful boundaries or mutating the link", () => {
  for (const whitespace of ["", " ", "\t\n", "\u00a0", "\u2003"]) {
    const link = { ...current, validFromLabel: whitespace, validUntilLabel: whitespace };
    const snapshot = structuredClone(link);
    assert.equal(canProjectCurrentFactionMembership(link, "faction", "character"), true);
    assert.deepEqual(link, snapshot);
  }
  for (const label of ["Book Two", " Chapter 12 ", "until winter", "unknown date", "0"]) {
    assert.equal(canProjectCurrentFactionMembership({ ...current, validFromLabel: label }, "faction", "character"), false);
    assert.equal(canProjectCurrentFactionMembership({ ...current, validUntilLabel: label }, "faction", "character"), false);
  }
  for (const malformed of [undefined, null, 0, []] as unknown[]) {
    assert.equal(canProjectCurrentFactionMembership({ ...current, validFromLabel: malformed } as unknown as Link, "faction", "character"), false);
    assert.equal(canProjectCurrentFactionMembership({ ...current, validUntilLabel: malformed } as unknown as Link, "faction", "character"), false);
  }
});
