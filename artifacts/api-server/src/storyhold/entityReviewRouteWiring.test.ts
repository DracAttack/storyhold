import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// These are bounded source-wiring guards, not HTTP or browser integration
// tests. Registering all world routes also schedules real intake/model work.
// Execution, journal and persistence behavior have separate PGlite tests.
const source = ts.createSourceFile("worldStudio.ts",
  readFileSync(new URL("./worldStudio.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function find<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T {
  let found: T | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (predicate(node)) { found = node; return; }
    ts.forEachChild(node, visit);
  };
  visit(root);
  assert.ok(found, "Expected source node was not found.");
  return found;
}

function route(path: string) {
  const call = find(source, (node): node is ts.CallExpression =>
    ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.getText(source) === "app.post"
    && node.arguments.some((argument) => ts.isStringLiteral(argument) && argument.text === path));
  assert.equal(call.arguments[1]?.getText(source), "requireUser");
  const handler = call.arguments.at(-1)!;
  assert.ok(ts.isArrowFunction(handler));
  return { handler, body: handler.body.getText(source) };
}

const path = "/api/storyhold/worlds/:worldId/entities/:entityId/ai-review";
const review = route(path);
const quote = route(`${path}/quote`);

test("saved responses with unknown pricing ask for a usage check instead of offering a futile resume", () => {
  assert.ok(quote.body.includes("pending.billable_attempts.some((attempt) => attempt.usage.pricingKnown !== true)"));
  assert.ok(review.body.includes("error instanceof EntityReviewAccountingError"));
  assert.ok(review.body.includes("final safety check before it can finish"));
  assert.ok(review.body.includes("no new paid request will start automatically"));
});

function ordered(body: string, ...fragments: string[]) {
  let position = -1;
  for (const fragment of fragments) {
    const next = body.indexOf(fragment, position + 1);
    assert.ok(next > position, `Expected source order: ${fragment}`);
    position = next;
  }
}

function namedFunction(name: string) {
  return find(source, (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source);
}

test("dossier quote authenticates ownership and offers saved review before any provider lookup", () => {
  ordered(quote.body,
    "ownedWorld(db, worldId, user.id)", "findPendingEntityReviewCall(db,",
    "if (pending)", "resume: true", "return;", "getAiRuntimeStatus(", "entityReviewContext({");
  assert.match(quote.body, /quoteId:\s*pending\.review_id/u);
  assert.match(quote.body, /guidance:\s*saved\.input\.userGuidance/u);
  assert.match(quote.body, /depth:\s*saved\.input\.depth/u);
});

test("saved execution bypasses reservations and provider setup and requires its original directions", () => {
  ordered(review.body,
    "ownedWorld(db, worldId, user.id)", "readEntityReviewCall(db, callScope)",
    "if (previous)", "previous.finalization_snapshot", "restoreEntityReviewContext(previous.context_snapshot)",
    "frozen.input.depth !== depth", "frozen.input.userGuidance", "finishSavedEntityReview(db, callScope)",
    "return;", "findPendingEntityReviewCall(db, callScope)", "getAiRuntimeStatus(", "reserveCredits(db,");
  assert.match(review.body, /previous\.finalization_snapshot\.reviewed\s*\?\s*200\s*:\s*409/u);
});

test("quote and execution use the dossier's own edition rather than the world's current default", () => {
  for (const body of [quote.body, review.body]) {
    ordered(body, "ownedWorld(db, worldId, user.id)", "entityReviewEdition(db, worldId, entityId)");
    assert.doesNotMatch(body, /\bdefaultEdition\s*\(/u);
  }
  const lookup = namedFunction("entityReviewEdition");
  assert.match(lookup, /SELECT canon_edition_id AS id FROM storyhold\.world_entities WHERE id = \$1 AND world_id = \$2/u);
  assert.match(lookup, /\[entityId, worldId\]/u);
});

test("fresh paid context is rebuilt and re-quoted after owner directions are enforced", () => {
  ordered(review.body,
    "saveOwnerCanonConstraint({", "enforceOwnerCanonConstraints({", "const snapshot = await db.transaction(",
    "const currentWorld =", "FOR SHARE", "world: currentWorld", "context.input.browserAuditContext = browserAuditContext",
    "entityReviewCanonFingerprint(tx, callScope", "frozenEntityReviewContext(context, fingerprint)",
    "const finalRequiredCredits =", "finalRequiredCredits > requiredCredits", "executeJournaledEntityReviewCall(db,");
  assert.match(review.body, /contextSnapshot:\s*snapshot/u);
});

test("the paid-dispatch flag is set at the actual provider invocation edge", () => {
  for (const [journal, dispatch] of [
    ["executeJournaledEntityReviewCall", "generateAiText(request)"],
    ["executeJournaledEntityReviewPages", "generateAiText(page.request)"],
  ]) {
    const execute = find(review.handler, (node): node is ts.CallExpression =>
      ts.isCallExpression(node) && node.expression.getText(source) === journal);
    const invoke = find(execute, (node): node is ts.PropertyAssignment =>
      ts.isPropertyAssignment(node) && node.name.getText(source) === "invoke");
    ordered(invoke.getText(source), "paidDispatchPossible = true", dispatch!);
    assert.ok(ts.isArrowFunction(invoke.initializer));
  }
});

test("catch protects holds when a paid call cannot be read or cannot be found", () => {
  const catchBody = find(review.handler, (node): node is ts.CatchClause =>
    ts.isCatchClause(node) && node.block.getText(source).includes("const saved = await readEntityReviewCall"))
    .block.getText(source);
  ordered(catchBody,
    "readEntityReviewCall(db, callScope)", "if (saved)", "saved.finalization_snapshot",
    'saved.status === "rejected"', "finishSavedEntityReview(db, callScope)",
    "if (paidDispatchPossible)", "return;", "catch (recoveryError)",
    "paidDispatchPossible || recoveryError instanceof EntityReviewJournalError", "return;", "releaseCreditReservation(");
});

test("saved application restores the frozen input and checks canon before parsing or saving", () => {
  const finish = namedFunction("finishSavedEntityReview");
  ordered(finish, "finishJournaledEntityReview(db,", "restoreEntityReviewContext(snapshot)",
    "entityReviewCanonFingerprint(tx, scope", "currentFingerprint !== snapshot.canonFingerprint",
    "throw new EntityReviewStaleCanonError()", "reviewEntityFromSavedResult(context.input, result)",
    "saveEntityReview({", 'reviewMode: "premium"', "refreshCanonicalMentionCounts({");
  assert.doesNotMatch(finish, /\b(?:getAiRuntimeStatus|generateAiText|reviewEntity|reserveCredits)\s*\(/u);
});

test("paged resume uses original requests and funding with source/model checks only before unstarted pages", () => {
  const resume = namedFunction("continueSavedEntityReviewPages");
  ordered(resume, "readEntityReviewCall(db, scope)", "restoreEntityReviewContext(call.context_snapshot)",
    "call.request_snapshot.pages", "const pages = frozen.map", "executeJournaledEntityReviewPages(db,",
    "reservationId: call.reservation_id", "beforePage:", "getAiRuntimeStatus(",
    "runtime.provider !== page.provider", "runtime.model !== page.model", "call.reserved_credits",
    "entityReviewCanonFingerprint(", "current !== call.context_snapshot.canonFingerprint",
    "invoke:", "generateAiText(page.request)");
  assert.match(resume, /request:\s*\{\s*\.\.\.page\.request,\s*validate:\s*prepared\[index\]!\.request\.validate/u);
  assert.doesNotMatch(resume, /\b(?:reserveCredits|entityReviewContext)\s*\(/u);
  ordered(review.body, "if (previous)", "continueSavedEntityReviewPages(db, callScope)", "finishSavedEntityReview(db, callScope)");
});

test("saved review quote exposes remaining work and settlement overage without reserving a second payment", () => {
  ordered(quote.body, "if (pending)", "readEntityReviewPageProgress(db,", "pageProgress?.canResume", "resume: true",
    "remainingPages: pageProgress ? pageProgress.totalPages - pageProgress.completedPages : 0", "return;");
  assert.match(quote.body, /requiredCredits:\s*funding\?\.additionalCreditsDue\s*\?\?\s*0/u);
  const pending = find(quote.handler, (node): node is ts.IfStatement =>
    ts.isIfStatement(node) && node.expression.getText(source) === "pending");
  assert.doesNotMatch(pending.thenStatement.getText(source), /\breserveCredits\s*\(/u);
});

test("saved context serializes and restores canonical-name lookup without querying new evidence", () => {
  const freeze = namedFunction("frozenEntityReviewContext");
  const restore = namedFunction("restoreEntityReviewContext");
  assert.match(freeze, /entityIdsByName:\s*\[\.\.\.context\.entityIdsByName\.entries\(\)\]/u);
  assert.match(restore, /snapshot\.version\s*!==\s*1/u);
  assert.match(restore, /new Map\(snapshot\.entityIdsByName/u);
  assert.doesNotMatch(restore, /entityReviewContext\s*\(|\.query\s*\(/u);
});

test("the resume UI uses saved directions and skips another browser reading", () => {
  const component = readFileSync(new URL("../../../site/src/components/customer/entity-ai-review-card.tsx", import.meta.url), "utf8");
  assert.match(component, /quote\.resume\s*\?\s*quote\.guidance\s*\?\?\s*""/u);
  assert.match(component, /if\s*\(!quote\.resume\s*&&\s*\(browserLorekeeperIsEnabled\(\)/u);
  assert.match(component, /depth:\s*quote\.depth/u);
});

test("modern dossier requests freeze graph eligibility and save proof before canonical graph writes", () => {
  const prepare = namedFunction("entityReviewContext");
  assert.match(prepare, /params\.includeGraphReview/u);
  assert.match(prepare, /persistedLocalEntityIsConnectionEligible\(entityRow\)/u);
  assert.match(prepare, /merged_into_entity_id IS NULL AND \(scanner_present = true OR classification_source = 'user' OR review_status = 'user_confirmed'\)/u);
  assert.match(prepare, /relation\.source_entity_id = \$3 OR relation\.target_entity_id = \$3/u);
  assert.doesNotMatch(prepare.slice(prepare.indexOf("if (params.includeGraphReview)")), /\bLIMIT \d/u);
  const finish = namedFunction("finishSavedEntityReview");
  ordered(finish, "reviewEntityFromSavedResult(", "saveEntityReviewVerificationBundle(", "saveEntityReview({");
  const save = namedFunction("saveEntityReview");
  ordered(save, "assertEntityGraphReview(", "syncEntityVerifiedGraph(", "const ownerEntity", "UPDATE storyhold.world_entities");
  assert.match(save, /for \(const relation of premium \? \[\] : finding\.relations\)/u);
  assert.match(save, /for \(const rule of premium \? \[\] : finding\.rules\)/u);
  assert.match(save, /graphSaved\.appliedRelations/u);
});

test("new connected reviews inventory raw stored prose while saved requests retain their original contract", () => {
  const prepare = namedFunction("entityReviewContext");
  const inventory = find(source, (node): node is ts.CallExpression =>
    ts.isCallExpression(node) && node.expression.getText(source) === "buildExistingProseInventory");
  const raw = inventory.getText(source);
  for (const field of ["aliases", "summary", "details", "relationships"]) assert.ok(raw.includes(`entityRow.${field}`));
  for (const field of ["aliases", "summary", "role", "profile"]) assert.ok(raw.includes(`currentDossier.${field}`));
  assert.doesNotMatch(raw, /\.slice\(|currentCharacter|boundedText|strings\(/u);
  assert.match(prepare, /graphReview\s*\?\s*\{\s*graphReview,\s*proseReview:/u);
  assert.match(prepare, /existingProseReview\s*=\s*params.includeGraphReview\s*\?\s*buildExistingProseInventory/u);
  assert.match(prepare, /graphReview,\s*proseReview:\s*\{\s*version: 1 as const\s*\},\s*existingProseReview/u);
  assert.doesNotMatch(namedFunction("restoreEntityReviewContext"), /buildExistingProseInventory|existingProseReview\s*[:=]/u);
});

test("complete old-prose proof is saved before applying new canon and unresolved outcomes remain advisory", () => {
  const finish = namedFunction("finishSavedEntityReview");
  ordered(finish, "reviewEntityFromSavedResult(", "saveEntityReviewVerificationBundle(",
    "version: 4", "existingProse: reviewed.existingProseReviews", "saveEntityReview({", "const existingDecisions =");
  assert.match(finish, /existing text was not automatically deleted/u);
  assert.match(finish, /Unresolved interpretations were preserved/u);
  assert.match(finish, /existingProseAudit:\s*\{\s*reviewedItems:\s*existingDecisions.length/u);
  const save = namedFunction("saveEntityReview");
  assert.doesNotMatch(save, /existingProseReviews|existingProseAudit/u,
    "Old audit judgments must not become a new canonical write path");
});

test("audit-only completion reports reviewed entries without claiming the evidence status stayed unchanged", () => {
  const save = namedFunction("saveEntityReview");
  assert.match(save, /input\.existingProseReview\?\.items.length\s*\|\|\s*input\.compassReview\s*\?\s*\[\]\s*:\s*\["This review did not establish/u);
  const component = readFileSync(new URL("../../../site/src/components/customer/entity-ai-review-card.tsx", import.meta.url), "utf8");
  assert.match(component, /result\.existingProseAudit\.reviewedItems\.toLocaleString\(\)/u);
  assert.match(component, /existing entries reviewed\. See Evidence by Section/u);
  assert.match(component, /dossier review is complete/u);
});
