import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Source-wiring guards only, not simulated HTTP requests. Importing/registering
// worldStudio would schedule unrelated intake work; the reader's real database
// and authorization behavior has its own offline PGlite tests.
const source = ts.createSourceFile("worldStudio.ts", readFileSync(new URL("./worldStudio.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function nodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(root); return result;
}
function calls(root: ts.Node, name: string): ts.CallExpression[] {
  return nodes(root, (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(source) === name);
}
function route(path: string) {
  const found = nodes(source, (node): node is ts.CallExpression => ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression) && node.expression.getText(source) === "app.get"
    && node.arguments.some((argument) => ts.isStringLiteral(argument) && argument.text === path));
  assert.equal(found.length, 1, `Exactly one GET handler is expected for ${path}`);
  const registration = found[0]!;
  assert.equal(registration.arguments[1]?.getText(source), "requireUser");
  const handler = registration.arguments.at(-1)!;
  assert.ok(ts.isArrowFunction(handler));
  return { registration, handler, text: handler.body.getText(source) };
}
function ordered(text: string, ...parts: string[]) {
  let position = -1;
  for (const part of parts) {
    const next = text.indexOf(part, position + 1);
    assert.ok(next > position, `Expected source order: ${part}`); position = next;
  }
}
function property(object: ts.Node, name: string): string {
  assert.ok(ts.isObjectLiteralExpression(object));
  const found = object.properties.find((item) => item.name?.getText(source) === name);
  assert.ok(found, `Missing ${name} property`);
  if (ts.isShorthandPropertyAssignment(found)) return found.name.text;
  assert.ok(ts.isPropertyAssignment(found)); return found.initializer.getText(source);
}
function statusCall(handler: ts.Node) {
  const found = calls(handler, "readEntityProseStatus"); assert.equal(found.length, 1);
  assert.equal(found[0]!.arguments.length, 4); return found[0]!;
}
const characterPath = "/api/storyhold/worlds/:worldId/characters/:characterId";
const entityPath = "/api/storyhold/worlds/:worldId/entities/:entityId/prose-review";
const character = route(characterPath), entity = route(entityPath);

test("field status is requested through authenticated owner-only GET routes with exact world edition scope", () => {
  for (const route of [character, entity]) {
    ordered(route.text, "assertUuid(worldId, res)", "const user = currentUser(req)", "ownedWorld(db, worldId, user.id)",
      'res.status(404).json({ error: "World not found." })', "return;", "defaultEdition(db, worldId)",
      'res.status(409).json({ error: "This world does not have a canon edition." })', "return;", "readEntityProseStatus(");
    const call = statusCall(route.handler);
    assert.equal(property(call.arguments[1]!, "playerId"), "user.id");
    assert.equal(property(call.arguments[1]!, "worldId"), "worldId");
    assert.equal(property(call.arguments[1]!, "editionId"), "edition.id");
    assert.doesNotMatch(route.text, /req\.(?:body|query)/u, "Client text and claimed ownership cannot drive status");
  }
});

test("character status uses the serialized visible biography and profile, including author-only secrets", () => {
  ordered(character.text, "dossier.id = $1 AND dossier.world_id = $2 AND dossier.canon_edition_id = $3",
    "[characterId, worldId, edition.id]", "const row = dossierResult.rows[0]", "if (!row)", "return;",
    "const serialized = serializeDossier(row)", "readEntityProseStatus(", "res.json(");
  const call = statusCall(character.handler), visible = call.arguments[2]!;
  assert.equal(property(visible, "aliases"), "serialized.aliases");
  assert.equal(property(visible, "summary"), "serialized.summary");
  assert.equal(property(visible, "details"), "[]");
  assert.equal(property(visible, "authorControlled"), "dossierIsCustomerEdited(row)");
  assert.ok(ts.isObjectLiteralExpression(visible));
  const nested = visible.properties.find((item) => item.name?.getText(source) === "character")!;
  assert.ok(ts.isPropertyAssignment(nested));
  for (const field of ["aliases", "summary", "role", "profile"]) assert.equal(property(nested.initializer, field), `serialized.${field}`);
  const stored = call.arguments[3]!;
  assert.equal(property(stored, "details"), "[]");
  assert.ok(ts.isObjectLiteralExpression(stored));
  const rawCharacter = stored.properties.find((item) => item.name?.getText(source) === "character")!;
  assert.ok(ts.isPropertyAssignment(rawCharacter));
  for (const field of ["aliases", "summary", "role", "profile"]) assert.equal(property(rawCharacter.initializer, field), `row.${field}`);
  assert.match(character.text, /profile:\s*\{\s*\.\.\.serialized\.profile,\s*relationshipWeb\s*\}/u,
    "The visible prose profile must remain the same one evaluated for status");
});

test("character status identifies the linked entity, not the dossier ID, and handles a missing link safely", () => {
  const call = statusCall(character.handler);
  assert.equal(property(call.arguments[1]!, "entityId"), "row.hold_entity_id");
  assert.match(character.text, /typeof row\.hold_entity_id === "string"\s*\?\s*await readEntityProseStatus/u);
  assert.match(character.text, /:\s*\{\s*fields:\s*\[\]\s*\}/u);
  assert.doesNotMatch(call.getText(source), /entityId:\s*(?:characterId|String\(row\.hold_entity_id\))/u);
  assert.match(character.text, /res\.json\(\{[\s\S]*?\bproseReview,\s*character:/u);
});

test("entity status matches the exact safe public presentation instead of raw stored text", () => {
  ordered(entity.text, "SELECT * FROM storyhold.world_entities", "WHERE id = $1 AND world_id = $2 AND canon_edition_id = $3",
    "pull_status = 'active' AND merged_into_entity_id IS NULL", "[entityId, worldId, edition.id]", "if (!row)", "return;",
    "const serialized = serializeWorldEntity(row, [])", "readEntityProseStatus(", "res.json(proseReview)");
  const call = statusCall(entity.handler), visible = call.arguments[2]!;
  assert.equal(property(call.arguments[1]!, "entityId"), "entityId");
  for (const field of ["aliases", "summary", "details", "relationships"]) {
    assert.equal(property(visible, field), `serialized.${field}`);
    assert.equal(property(call.arguments[3]!, field), `row.${field}`);
  }
  assert.equal(property(visible, "authorControlled"), 'row.classification_source === "user" || row.review_status === "user_confirmed"');
  assert.doesNotMatch(visible.getText(source), /(?:summary|aliases|details):\s*row\./u);
});

test("status lookup adds no paid review and the dedicated endpoint is read-only", () => {
  for (const route of [character, entity]) {
    for (const name of ["getAiRuntimeStatus", "generateAiText", "reviewEntity", "reserveCredits", "settleEntityReviewAccountingInTransaction",
      "executeJournaledEntityReviewCall", "executeJournaledEntityReviewPages", "saveEntityReview", "syncEntityVerifiedProse", "saveEntityReviewVerificationBundle"]) {
      assert.equal(calls(route.handler, name).length, 0, `${name} must not run to display status`);
    }
  }
  // The existing character GET may still initialize Hold rows independently
  // of this feature. The dedicated status endpoint itself is read-only.
  assert.equal(calls(entity.handler, "ensureWorldEntities").length, 0);
  for (const call of calls(entity.handler, "db.query")) {
    const sql = call.arguments[0]!.getText(source);
    assert.match(sql, /^`SELECT\b/u); assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/u);
  }
  assert.equal(calls(entity.handler, "db.exec").length, 0);
});

test("field-status reads are not added to overview lists, public sessions, or mutation handlers", () => {
  const all = calls(source, "readEntityProseStatus");
  assert.equal(all.length, 2);
  const expected = new Set([statusCall(character.handler).pos, statusCall(entity.handler).pos]);
  assert.ok(all.every((call) => expected.has(call.pos)));
  for (const route of [character, entity]) assert.doesNotMatch(route.text,
    /(?:verification_snapshot|verification_fingerprint|request_snapshot|context_snapshot|claimReceipt|billable_attempts)/u,
    "Route responses should use safe reader metadata, never the private paid proof");
});
