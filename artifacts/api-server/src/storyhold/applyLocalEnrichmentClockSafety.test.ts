import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("legacy Codex enrichment cannot replace owner or receipt-backed World Clock rows", async () => {
  const source = await readFile(new URL("./applyLocalEnrichment.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /DELETE FROM storyhold\.world_clock_events/u);
  assert.match(source, /event\.canon_edition_id = \$2/u);
  assert.match(source, /event\.canonical_key LIKE 'codex-canon-%'/u);
  assert.match(source, /event\.created_by_player_id IS NULL/u);
  assert.match(source, /event\.assignment_source = 'local'/u);
  assert.match(source, /world_clock_event_verifications verified/u);
  assert.match(source, /ON CONFLICT \(world_id, canonical_key\) DO UPDATE/u);
  assert.match(source, /world_clock_events\.canonical_key LIKE 'codex-canon-%'/u);
});

test("startup and chapter-map maintenance only retire unowned, unverified generated clock rows", async () => {
  const source = await readFile(new URL("./worldStudio.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /DELETE FROM storyhold\.world_clock_events/u);
  assert.match(source, /canonical_key LIKE 'source-chapter-v1-%'/u);
  assert.match(source, /canonical_key LIKE 'source-chapter-v2-%'/u);
  assert.match(source, /world_clock_events\.created_by_player_id IS NULL/u);
  assert.match(source, /event\.created_by_player_id IS NULL/u);
  assert.match(source, /event\.assignment_source = 'local'/u);
  assert.match(source, /world_clock_event_verifications verified/u);
  assert.match(source, /WHERE verified\.event_id = world_clock_events\.id/u);
  assert.match(source, /WHERE verified\.event_id = event\.id/u);
});

test("duplicate repair fails before clock constraints drop if a loser is owner-created or receipt-backed", async () => {
  const source = await readFile(new URL("./repairDuplicateWorldEntities.ts", import.meta.url), "utf8");
  assert.match(source, /event\.created_by_player_id IS NOT NULL/u);
  assert.match(source, /event\.assignment_source = 'user'/u);
  assert.match(source, /world_clock_event_verifications verification/u);
  assert.match(source, /protected_losers/u);
  assert.match(source, /duplicate_number > 1 AND is_protected = false/u);
  const protectionCheck = source.indexOf("referenceCounts.protected_losers > 0");
  const firstClockConstraintDrop = source.indexOf("for (const constraint of clockForeignKeys.rows)");
  assert.ok(protectionCheck >= 0);
  assert.ok(firstClockConstraintDrop > protectionCheck);
});
