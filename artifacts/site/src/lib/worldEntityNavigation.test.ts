import assert from "node:assert/strict";
import test from "node:test";
import {
  worldEntityDossierHref,
  worldEntityFilterFromSearch,
  worldNeedsSortingHref,
} from "./worldEntityNavigation";

test("only established canon records receive standalone dossier links", () => {
  assert.equal(worldEntityDossierHref("world-1", { id: "lead-1", dossierId: null, entityType: "ambiguous" }), null);
  assert.equal(worldEntityDossierHref("world-1", { id: "term-1", dossierId: null, entityType: "term" }), null);
  assert.equal(worldEntityDossierHref("world-1", { id: "reference-1", dossierId: null, entityType: "cultural_reference" }), null);
  assert.equal(
    worldEntityDossierHref("world-1", { id: "alec-entity", dossierId: "alec-dossier", entityType: "character" }),
    "/profile/worlds/world-1/characters/alec-dossier",
  );
  assert.equal(
    worldEntityDossierHref("world-1", { id: "sanctuary", dossierId: null, entityType: "place" }),
    "/profile/worlds/world-1/entities/sanctuary",
  );
});
test("needs-sorting links open the world triage filter and retain a focused lead", () => {
  assert.equal(
    worldNeedsSortingHref("world 1", "lead/1"),
    "/profile/worlds/world 1?hold=ambiguous&focus=lead%2F1#storyhold-entries",
  );
  assert.equal(worldEntityFilterFromSearch("?hold=ambiguous&focus=lead-1"), "ambiguous");
  assert.equal(worldEntityFilterFromSearch("?hold=character"), null);
});
