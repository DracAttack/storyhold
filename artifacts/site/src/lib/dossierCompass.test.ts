import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compassEvidenceLabel, compassPerspectiveLabel, dossierCompassView } from "./dossierCompass";
import type { DossierCompassReview, SocioPoliticalAxis } from "./storyholdApi";

const axis: SocioPoliticalAxis = { economic: -20, authority: 35, label: "Mutual Aid with Firm Leadership",
  rationale: "She shares supplies but insists on enforcing the evacuation order.", confidence: 0.99 };
const proof: DossierCompassReview = { status: "supported", estimate: { economic: axis.economic, authority: axis.authority,
  label: axis.label, rationale: axis.rationale, validFromLabel: "The Siege", validUntilLabel: "The Election",
  perspective: "demonstrated_behavior", epistemicHolderId: null }, evidence: [{ chunkId: "private-chunk", sourceId: "private-source",
  quote: "She shared the supplies and enforced the evacuation order.", axes: ["economic","authority"], perspective: "demonstrated_behavior" }],
  explanation: "Her conduct supports both dimensions during the siege." };

test("confidence never unlocks an unreviewed compass, and legacy estimates remain intact", () => {
  const before = structuredClone(axis);
  for (const confidence of [0,0.35,1]) {
    const view = dossierCompassView({ ...axis,confidence },false);
    assert.equal(view.sourceBacked,false); assert.equal(view.status,"not_reviewed"); assert.equal(view.label,"Unreviewed Estimate");
    assert.deepEqual(view.evidence,[]);
  }
  assert.deepEqual(axis,before);
});

test("exact current proof exposes a temporal source-backed interpretation, not an immutable fact", () => {
  const view = dossierCompassView(axis,false,proof);
  assert.equal(view.label,"Source-Backed Interpretation"); assert.equal(view.sourceBacked,true);
  assert.equal(view.timeframe,"From The Siege Until The Election"); assert.equal(view.perspective,"Demonstrated Conduct");
  assert.deepEqual(view.evidence,proof.evidence);
  assert.equal(dossierCompassView({...axis,rationale:"A replacement rationale"},false,proof).status,"not_reviewed");
  assert.equal(dossierCompassView({...axis,authority:34},false,proof).status,"not_reviewed");
  assert.equal(dossierCompassView(axis,false,{...proof,evidence:[]}).status,"not_reviewed");
  assert.equal(dossierCompassView(axis,false,{...proof,estimate:undefined}).status,"not_reviewed");
});

test("author choices win without borrowing an older proof, while unresolved reviews keep their concerns", () => {
  const concern: DossierCompassReview = { status:"needs_attention", explanation:"Her stated ideals conflict with her conduct.",
    evidence: proof.evidence, retrievalRequests:["Check the later council vote."] };
  const author = dossierCompassView(axis,true,concern);
  assert.equal(author.status,"author_controlled"); assert.equal(author.sourceBacked,false); assert.deepEqual(author.evidence,[]);
  assert.equal(dossierCompassView(axis,false,{...concern,status:"author_controlled"}).authorControlled,true);
  const view = dossierCompassView(axis,false,concern);
  assert.equal(view.status,"needs_attention"); assert.equal(view.sourceBacked,false); assert.deepEqual(view.retrievalRequests,concern.retrievalRequests);
  assert.equal(dossierCompassView(axis,false,{...concern,status:"needs_evidence"}).label,"Needs More Evidence");
});

test("viewpoint labels and source captions never display raw holder IDs or internal enum strings", () => {
  const perspective = { ...proof, estimate:{...proof.estimate!,perspective:"others_interpretation" as const,
    epistemicHolderId:"private-holder-id",epistemicHolderName:"Mira"} };
  assert.equal(dossierCompassView(axis,false,perspective).perspective,"Another Character’s Interpretation · Mira");
  delete perspective.estimate.epistemicHolderName;
  assert.doesNotMatch(dossierCompassView(axis,false,perspective).perspective!,/private-holder-id|others_interpretation/);
  assert.equal(compassPerspectiveLabel("self_description"),"Self-Description");
  assert.equal(compassPerspectiveLabel("mixed"),"Mixed Viewpoints");
  assert.equal(compassEvidenceLabel(["economic","authority"],"demonstrated_behavior"),"Economic Position · Authority and Liberty · Demonstrated Conduct");
  assert.equal(compassEvidenceLabel(["private_axis"]),"Compass Interpretation");
});

test("character page wires current proof, preserves manual editing and collapses source context without confidence gating", () => {
  const source = readFileSync(new URL("../pages/profile-character.tsx",import.meta.url),"utf8");
  assert.match(source,/dossierCompassView\(axis, character\.socioPoliticalAxisChanged, compassReview\)/);
  assert.equal((source.match(/setCompassReview\(result\.compassReview \?\? null\)/g) ?? []).length,2,"initial load and refresh both replace old proof");
  assert.doesNotMatch(source,/axis\.confidence\s*(?:>=|>|\*)/);
  assert.match(source,/const hasInterpretedAxis = compass\.sourceBacked \|\| compass\.authorControlled/);
  assert.match(source,/View Saved Unreviewed Estimate/);
  assert.match(source,/View Context and Source Passages<\/summary>/);
  assert.match(source,/onSubmit=\{saveAxis\}/);
  assert.match(source,/\{evidence\.quote\}/);
  assert.doesNotMatch(source,/<[^>]*>\{(?:compass|evidence)\.(?:epistemicHolderId|sourceId|chunkId)\}/);
});
