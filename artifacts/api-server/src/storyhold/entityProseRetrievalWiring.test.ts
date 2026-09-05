import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// AST/source wiring guards, not HTTP simulations. Separate PGlite/pure tests
// exercise the loader, immutable history, search planner and review execution.
function load(name: string) {
  return ts.createSourceFile(name, readFileSync(new URL(`./${name}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
const source = load("worldStudio.ts");
function nodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  const visit = (node: ts.Node) => { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); };
  visit(root); return result;
}
function calls(root: ts.Node, name: string): ts.CallExpression[] {
  return nodes(root, (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText() === name);
}
function named(root: ts.Node, name: string): ts.FunctionDeclaration {
  const matches = nodes(root, (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, `One ${name} declaration is expected`); return matches[0]!;
}
function property(object: ts.Node, name: string): ts.Expression {
  assert.ok(ts.isObjectLiteralExpression(object));
  const item = object.properties.find((item) => item.name?.getText() === name);
  assert.ok(item, `Missing ${name}`);
  if (ts.isShorthandPropertyAssignment(item)) return item.name;
  assert.ok(ts.isPropertyAssignment(item)); return item.initializer;
}
function variable(root: ts.Node, name: string): ts.VariableDeclaration {
  const matches = nodes(root, (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node) && node.name.getText() === name);
  assert.equal(matches.length, 1, `One ${name} variable is expected`); return matches[0]!;
}
function parentIf(node: ts.Node, condition: string): ts.IfStatement {
  let current: ts.Node | undefined = node.parent;
  while (current && !(ts.isIfStatement(current) && current.expression.getText() === condition)) current = current.parent;
  assert.ok(current && ts.isIfStatement(current), `${node.getText().slice(0,80)} must be guarded by ${condition}`); return current;
}
function route(path: string): ts.ArrowFunction {
  const matches = nodes(source, (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText() === "app.post"
    && node.arguments.some((argument) => ts.isStringLiteral(argument) && argument.text === path));
  assert.equal(matches.length, 1); const registration = matches[0]!;
  assert.equal(registration.arguments[1]!.getText(), "requireUser");
  const handler = registration.arguments.at(-1)!; assert.ok(ts.isArrowFunction(handler)); return handler;
}
function ordered(text: string, ...parts: string[]) {
  let cursor = -1;
  for (const part of parts) { const next = text.indexOf(part, cursor + 1); assert.ok(next > cursor, `Expected in order: ${part}`); cursor = next; }
}
const context = named(source, "entityReviewContext");
const quote = route("/api/storyhold/worlds/:worldId/entities/:entityId/ai-review/quote");
const run = route("/api/storyhold/worlds/:worldId/entities/:entityId/ai-review");
const finish = named(source, "finishSavedEntityReview");
const freshOnly = ["entityReviewContext", "loadEntityProseRetrievalLeads", "loadEntityReviewManuscriptChunks", "planEntityProseRetrieval"];

test("all fresh context preparations carry the authenticated owner and connected-review gate", () => {
  const prepared = calls(source, "entityReviewContext");
  assert.equal(prepared.length, 3); assert.equal(calls(quote, "entityReviewContext").length, 1); assert.equal(calls(run, "entityReviewContext").length, 2);
  for (const call of prepared) {
    const input = call.arguments[0]!;
    assert.equal(property(input, "playerId").getText(), "user.id");
    assert.equal(property(input, "editionId").getText(), "edition.id");
    assert.equal(property(input, "entityId").getText(), "entityId");
    assert.equal(property(input, "reviewId").getText(), "quoteId");
    const enabled = property(input, "includeGraphReview").getText();
    assert.ok(["runtime.configured", "true"].includes(enabled));
    if (enabled === "true") parentIf(call, "runtime.configured");
  }
  const inventory = variable(context, "existingProseReview").initializer!;
  assert.ok(ts.isConditionalExpression(inventory)); assert.equal(inventory.condition.getText(), "params.includeGraphReview");
  assert.equal(inventory.whenFalse.getText(), "undefined");
  const leads = calls(context, "loadEntityProseRetrievalLeads"); assert.equal(leads.length, 1);
  parentIf(leads[0]!, "existingProseReview");
  const scope = leads[0]!.arguments[1]!;
  for (const [key, value] of Object.entries({ playerId: "params.playerId", worldId: "params.world.id", editionId: "params.editionId", entityId: "params.entityId" })) {
    assert.equal(property(scope, key).getText(), value);
  }
  assert.equal(leads[0]!.arguments[2]!.getText(), "existingProseReview");
});

test("targeted search receives the complete owner-scoped manuscript corpus, not the initial selected excerpt budget", () => {
  const corpus = variable(context, "chunkResult").initializer!;
  assert.ok(ts.isConditionalExpression(corpus)); assert.equal(corpus.condition.getText(), "params.includeGraphReview");
  const loader = calls(corpus.whenTrue, "loadEntityReviewManuscriptChunks"); assert.equal(loader.length, 1);
  const scope = loader[0]!.arguments[1]!;
  for (const [key, value] of Object.entries({ playerId: "params.playerId", worldId: "params.world.id", editionId: "params.editionId" })) assert.equal(property(scope,key).getText(),value);
  const plan = calls(context,"planEntityProseRetrieval"); assert.equal(plan.length,1);
  assert.equal(property(plan[0]!.arguments[0]!,"selectedChunks").getText(),"chunks");
  const complete = property(plan[0]!.arguments[0]!,"chunks").getText();
  assert.match(complete,/^chunkResult\.rows\.map\(/); assert.match(complete,/content: row\.content/);
  assert.doesNotMatch(complete,/\.slice\(|selectedPassages|excerpt/);
  ordered(context.getText(),"loadEntityReviewManuscriptChunks(","loadEntityProseRetrievalLeads(","planEntityProseRetrieval(");
  const sql = named(load("entityReviewSources.ts"),"loadEntityReviewManuscriptChunks").getText();
  for (const term of ["chunk.world_id=$1", "chunk.canon_edition_id=$2", "source.world_id=$1", "source.canon_edition_id=$2",
    "world.owner_player_id=$3", "source.source_kind='manuscript'", "source.processing_status='ready'", "source.canon_status IN ('candidate','canon')"]) {
    assert.ok(sql.replace(/\s+/g, "").includes(term.replace(/\s+/g, "")), `Scoped corpus must require ${term}`);
  }
  assert.doesNotMatch(sql,/\bLIMIT\b/); assert.match(sql,/\[scope\.worldId,\s*scope\.editionId,\s*scope\.playerId\]/);
});

test("additional full passages enter the same immutable input, quote preview and canonical fingerprint", () => {
  const loop = nodes(context, (node): node is ts.ForOfStatement => ts.isForOfStatement(node) && node.expression.getText() === "plan.chunks");
  assert.equal(loop.length,1);
  ordered(loop[0]!.getText(),"rowsById.get(chunk.id)","row.content !== chunk.content", "row.source_id !== chunk.sourceId", "selectedIds.has(row.id)", "selected.push(", "chunks.push(chunk)");
  const returned = nodes(context,(node): node is ts.ReturnStatement => ts.isReturnStatement(node)
    && Boolean(node.expression && ts.isObjectLiteralExpression(node.expression) && node.expression.properties.some((property) => property.name?.getText() === "input")));
  assert.equal(returned.length,1); const result = returned[0]!.expression!;
  assert.equal(property(property(result,"input"),"chunks").getText(),"chunks");
  assert.match(property(result,"selectedPassages").getText(),/^selected\.map\(/);
  assert.equal(property(calls(quote,"res.json").find((call) => ts.isObjectLiteralExpression(call.arguments[0]!)
    && call.arguments[0]!.properties.some((property) => property.name?.getText() === "quoteId" && ts.isShorthandPropertyAssignment(property)))!.arguments[0]!,"selectedPassages").getText(),"context.selectedPassages");
  const freeze = named(source,"frozenEntityReviewContext").getText(); assert.match(freeze,/canonFingerprint,\s*\.\.\.context/);
  const snapshot = variable(run,"snapshot");
  ordered(snapshot.getText(),"entityReviewContext(","entityReviewCanonFingerprint(","context.input.chunks.map((chunk) => chunk.id)","frozenEntityReviewContext(context, fingerprint)");
  const dispatch = calls(run,"executeJournaledEntityReviewPages"); assert.equal(dispatch.length,1);
  assert.equal(property(dispatch[0]!.arguments[1]!,"contextSnapshot").getText(),"snapshot");
  assert.ok(calls(run,"quoteEntityReviewReservation").some((call) => call.arguments[0]!.getText() === "context.input"));
});

test("public retrieval data is summary-only while selected passage previews remain ordinary review sources", () => {
  const publicProperties = [quote,finish].flatMap((root) => nodes(root,(node): node is ts.PropertyAssignment => ts.isPropertyAssignment(node)
    && node.name.getText() === "retrievalExpansion"));
  assert.equal(publicProperties.length,3);
  for (const property of publicProperties) assert.match(property.initializer.getText(),/^(?:context|saved)\.retrievalExpansion\.summary$/);
  for (const call of calls(quote,"res.json")) {
    const value = call.arguments[0]!;
    assert.doesNotMatch(value.getText(),/sourceReviewIds|searchedChunkCount|retrievalExpansion\.items/);
  }
  const returnValue = nodes(finish,(node): node is ts.ReturnStatement => ts.isReturnStatement(node)
    && Boolean(node.expression && ts.isObjectLiteralExpression(node.expression)));
  assert.equal(returnValue.length,1);
  assert.doesNotMatch(returnValue[0]!.getText(),/sourceReviewIds|searchedChunkCount|retrievalExpansion\.items/);
});

test("saved quote, continuation and finalization never initiate another source search", () => {
  for (const [handler,condition] of [[quote,"pending"],[run,"previous"]] as const) {
    const branch = nodes(handler,(node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText() === condition);
    assert.equal(branch.length,1); const body = branch[0]!.thenStatement;
    for (const name of freshOnly) assert.equal(calls(body,name).length,0,`${condition} must not ${name}`);
    assert.ok(ts.isBlock(body) && ts.isReturnStatement(body.statements.at(-1)!));
    ordered(handler.getText(),`if (${condition})`,"restoreEntityReviewContext(","entityReviewContext(");
  }
  for (const fn of [named(source,"continueSavedEntityReviewPages"),finish]) {
    for (const name of freshOnly) assert.equal(calls(fn,name).length,0,`${fn.name!.text} must not ${name}`);
    assert.equal(calls(fn,"restoreEntityReviewContext").length,1);
    assert.match(fn.getText(),/context\.input\.chunks\.map\(\(chunk\) => chunk\.id\)/);
  }
});

test("retrieval helpers introduce no model dispatch, network, subprocess or canonical writes", () => {
  const forbidden = new Set(["fetch","generateAiText","reviewEntity","executeJournaledEntityReviewCall","executeJournaledEntityReviewPages",
    "runBrowserDossierAssist","spawn","exec","execFile","fork","WebSocket"]);
  for (const file of ["entityProseRetrieval.ts","entityProseRetrievalPlan.ts","entityReviewSources.ts"]) {
    const module = load(file);
    for (const call of nodes(module,(node): node is ts.CallExpression => ts.isCallExpression(node))) {
      const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : call.expression.getText();
      assert.ok(!forbidden.has(name),`${file} must not call ${name}`);
      if (name === "query") {
        const sql = call.arguments[0]!.getText(); assert.match(sql,/^`SELECT\b/);
        assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/);
      }
    }
    for (const item of nodes(module,(node): node is ts.ImportDeclaration => ts.isImportDeclaration(node))) {
      assert.doesNotMatch(item.moduleSpecifier.getText(),/node:child_process|aiGateway|browserLorekeeper|openrouter/i);
    }
  }
});
