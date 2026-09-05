import assert from "node:assert/strict";
import test from "node:test";
import {
  WORLD_CLOCK_MAX_PAGE_BYTES,
  WORLD_CLOCK_MAX_PROPOSALS_PER_PAGE,
  approvedWorldClockProjection,
  assertWorldClockVerification,
  assertWorldClockVerificationReceipts,
  describeWorldClockVerificationManifest,
  prepareWorldClockVerificationPages,
  validateWorldClockVerification,
  worldClockVerificationInstructions,
  type WorldClockPayload,
  type WorldClockVerificationInput,
  type WorldClockVerificationRequest,
} from "./worldClockVerification";

const id = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const WORLD = id(1); const EDITION = id(2); const RUN = id(3);
const ALEC = id(11); const LILLY = id(12); const MICHAEL = id(13); const SANCTUARY = id(14);
const SOURCE = id(21); const FIRST = id(31); const SECOND = id(32); const THIRD = id(33);
const firstQuote = "At dawn on the First Day, Alec entered Sanctuary while Lilly watched from the gate.";
const strangerQuote = "A masked  stranger followed him.";
const secondQuote = "At dusk, Michael pulled the black lever.";
const relationQuote = "The opened gate allowed the raiders to enter Sanctuary.";
const beliefQuote = "Lilly said, “I believe Alec betrayed us.”";
const verifier = { provider: "openrouter", model: "resolved-premium-model", completedAt: "2026-09-04T18:00:00.000Z" };

function input(): WorldClockVerificationInput {
  return {
    version: 1,
    scope: { worldId: WORLD, editionId: EDITION, analysisRunId: RUN },
    chunks: [
      { id: FIRST, sourceId: SOURCE, sourceTitle: "Ashes", index: 0, content: `${firstQuote} ${strangerQuote}` },
      { id: SECOND, sourceId: SOURCE, sourceTitle: "Ashes", index: 1, content: `${secondQuote} ${relationQuote}` },
      { id: THIRD, sourceId: SOURCE, sourceTitle: "Ashes", index: 2, content: beliefQuote },
    ],
    entities: [
      { id: ALEC, name: "Alec Sumner", entityType: "character", aliases: ["Alec"] },
      { id: LILLY, name: "Lilly Potter", entityType: "character", aliases: ["Lilly"] },
      { id: MICHAEL, name: "Michael", entityType: "character", aliases: [] },
      { id: SANCTUARY, name: "Sanctuary", entityType: "place", aliases: ["the town"] },
    ],
    chronology: [
      {
        name: "Alec Enters Sanctuary", aliases: ["The First Arrival"],
        summary: "Alec enters Sanctuary while Lilly watches.", worldTimeLabel: "First Day, dawn",
        temporalStatus: "exact", importance: "major", sourceChapterKeys: [`${SOURCE}:chapter-1`],
        truthStatus: "fact", epistemicHolderId: null,
        actors: ["Alec"], witnesses: ["Lilly"], locations: ["Sanctuary"],
        evidence: [{ chunkId: FIRST, sourceId: SOURCE, quote: firstQuote }], confidence: 0.9,
      },
      {
        name: "Michael Opens the Gate", summary: "Michael opens a gate at dusk.", worldTimeLabel: "First Day, dusk",
        temporalStatus: "exact", importance: "turning_point", sourceChapterKeys: [`${SOURCE}:chapter-2`],
        truthStatus: "fact", epistemicHolderId: null,
        actors: ["Michael"], targets: ["The Gate"],
        eventRelations: [{ targetEvent: "Raiders Enter Sanctuary", relationType: "enables",
          summary: "Opening the gate permits the later entry.", evidence: [{ chunkId: SECOND, sourceId: SOURCE, quote: relationQuote }], confidence: 0.85 }],
        evidence: [{ chunkId: SECOND, sourceId: SOURCE, quote: secondQuote }], confidence: 0.9,
      },
      {
        name: "Raiders Enter Sanctuary", summary: "Raiders enter Sanctuary through the opened gate.",
        worldTimeLabel: "After the gate opens", temporalStatus: "relative", importance: "major",
        sourceChapterKeys: [`${SOURCE}:chapter-2`], truthStatus: "fact", epistemicHolderId: null,
        locations: ["Sanctuary"], evidence: [{ chunkId: SECOND, sourceId: SOURCE, quote: relationQuote }], confidence: 0.86,
      },
      {
        name: "Lilly Believes Alec Betrayed Them", summary: "Lilly believes Alec betrayed the group.",
        worldTimeLabel: "Later", temporalStatus: "relative", importance: "major",
        sourceChapterKeys: [`${SOURCE}:chapter-3`], truthStatus: "belief", epistemicHolderId: LILLY,
        evidence: [{ chunkId: THIRD, sourceId: SOURCE, quote: beliefQuote }], confidence: 0.8,
      },
    ],
    ownerConstraints: [{ id: "owner-clock-1", kind: "timeline", instruction: "A stated belief is not objective fact.", scopeEntityId: LILLY }],
  };
}

function candidatePayload(request: WorldClockVerificationRequest, proposalId: string): WorldClockPayload {
  const proposal = request.proposals.find((item) => item.id === proposalId);
  assert.ok(proposal);
  return proposal.payload as unknown as WorldClockPayload;
}

function response(request: WorldClockVerificationRequest, options?: {
  verdict?: (payload: WorldClockPayload) => "verified" | "rejected" | "disputed" | "insufficient_evidence" | "needs_more_evidence";
  omit?: number;
  noCorrectionForUnresolved?: boolean;
}) {
  const decisions = request.proposals.map((proposal) => {
    const payload = proposal.payload as unknown as WorldClockPayload;
    const verdict = options?.verdict?.(payload) ?? "verified";
    const anchor = proposal.evidenceIds.map((anchorId) => request.evidence.find((item) => item.id === anchorId)).find(Boolean)
      ?? request.evidence[0];
    let correctedPayload: WorldClockPayload | null = null;
    if (verdict === "verified" && !options?.noCorrectionForUnresolved && payload.recordType === "participant" && payload.entityId === null) {
      correctedPayload = { ...payload, entityId: SANCTUARY, entityLabel: "Sanctuary" };
    }
    if (verdict === "verified" && !options?.noCorrectionForUnresolved && payload.recordType === "event_relation" && payload.targetEventId === null) {
      const target = request.eventRegistry.find((event) => event.name === payload.targetEventLabel)!;
      correctedPayload = { ...payload, targetEventId: target.eventId };
    }
    return {
      proposalId: proposal.id, verdict, correctedPayload,
      supportingEvidence: verdict === "verified" && anchor ? [{ chunkId: anchor.chunkId, quote: anchor.quote }] : [],
      contradictingEvidence: verdict === "disputed" && anchor ? [{ chunkId: anchor.chunkId, quote: anchor.quote }] : [],
      confidence: verdict === "verified" ? 0.88 : 0.4,
      explanation: verdict === "verified" ? "The cited passage supports this one atomic clock record." : "This candidate is not established.",
      retrievalRequests: verdict === "needs_more_evidence" ? ["Find direct evidence for this exact clock record."] : [],
    };
  });
  if (options?.omit !== undefined) decisions.splice(options.omit, 1);
  return { chronology: [], clockVerification: { requestFingerprint: request.fingerprint, decisions } };
}

function allReceipts(params: WorldClockVerificationInput) {
  return prepareWorldClockVerificationPages(params).map((page) =>
    validateWorldClockVerification(params, response(page), verifier, page.page.index));
}

test("the frozen inventory becomes independent event, participant and edge candidates with stable UUID identities", () => {
  const params = input(); const pages = prepareWorldClockVerificationPages(params);
  assert.equal(pages.length, 1);
  const request = pages[0]!;
  assert.equal(request.stepKey, "chronology:0"); assert.equal(request.page.stepKey, request.stepKey);
  assert.equal(request.page.count, 1); assert.equal(request.page.proposalIds.length, 11);
  assert.equal(request.proposals.filter((proposal) => proposal.payload.recordType === "event").length, 4);
  assert.equal(request.proposals.filter((proposal) => proposal.payload.recordType === "participant").length, 6);
  assert.equal(request.proposals.filter((proposal) => proposal.payload.recordType === "event_relation").length, 1);
  const event = request.proposals.find((proposal) => proposal.payload.recordType === "event")!.payload as unknown as Extract<WorldClockPayload, { recordType: "event" }>;
  assert.match(event.eventId, /^[0-9a-f-]{36}$/u); assert.match(event.canonicalKey, /^canon-event-v2-/u);
  assert.equal(event.chronologyOrder, 0); assert.equal(request.eventRegistry.length, 4);
  assert.ok(request.pageManifestFingerprint.startsWith("clock_page_manifest_"));
  assert.ok(request.inventoryFingerprint.startsWith("clock_inventory_"));
  const unresolved = request.proposals.map((proposal) => proposal.payload as unknown as WorldClockPayload)
    .find((payload) => payload.recordType === "participant" && payload.entityLabel === "The Gate");
  assert.equal(unresolved?.recordType, "participant");
  if (unresolved?.recordType === "participant") assert.equal(unresolved.entityId, null);
  assert.ok(Object.isFrozen(request)); assert.ok(Object.isFrozen(request.proposals));
  const otherEdition = input(); otherEdition.scope.editionId = id(99);
  const otherEvent = prepareWorldClockVerificationPages(otherEdition)[0]!.eventRegistry[0]!;
  assert.notEqual(otherEvent.eventId, event.eventId); assert.notEqual(otherEvent.canonicalKey, event.canonicalKey);
});

test("complete receipts preserve exact event order, belief viewpoint, roles, relations, evidence and actual verifier provenance", () => {
  const params = input(); const receipts = allReceipts(params);
  assertWorldClockVerificationReceipts(params, receipts); assertWorldClockVerification(params, receipts[0]!);
  const projection = approvedWorldClockProjection(params, receipts);
  assert.equal(projection.events.length, 4); assert.equal(projection.participants.length, 6);
  assert.equal(projection.relations.length, 1); assert.deepEqual(projection.withheld, []);
  assert.deepEqual(projection.events.map((item) => item.payload.chronologyOrder), [0, 1, 2, 3]);
  const belief = projection.events.find((item) => item.payload.truthStatus === "belief")!;
  assert.equal(belief.payload.epistemicHolderId, LILLY); assert.equal(belief.payload.summary, "Lilly believes Alec betrayed the group.");
  assert.deepEqual(belief.evidence, [{ chunkId: THIRD, sourceId: SOURCE, quote: beliefQuote }]);
  assert.equal(projection.relations[0]!.payload.relationType, "enables");
  assert.ok(projection.relations[0]!.payload.targetEventId);
  const corrected = projection.participants.find((item) => item.payload.entityLabel === "Sanctuary" && item.payload.role === "target")!;
  assert.equal(corrected.payload.entityId, SANCTUARY);
  assert.equal(receipts[0]!.verifier.model, "resolved-premium-model");
  assert.ok(Object.isFrozen(receipts[0])); assert.ok(Object.isFrozen(receipts[0]!.packet));
});

test("event approval never automatically approves its participants or causal edges", () => {
  const params = input(); const request = prepareWorldClockVerificationPages(params)[0]!;
  const raw = response(request, { verdict: (payload) => payload.recordType === "event" ? "verified" : "rejected" });
  const receipt = validateWorldClockVerification(params, raw, verifier);
  const projection = approvedWorldClockProjection(params, [receipt]);
  assert.equal(projection.events.length, 4); assert.equal(projection.participants.length, 0);
  assert.equal(projection.relations.length, 0); assert.deepEqual(projection.withheld, []);
});

test("a causal edge needs its own meaningful exact evidence rather than borrowing event approval", () => {
  const params = input(); const request = prepareWorldClockVerificationPages(params)[0]!;
  const raw = response(request);
  const relation = raw.clockVerification.decisions.find((decision) =>
    candidatePayload(request, decision.proposalId).recordType === "event_relation")!;
  relation.supportingEvidence = [];
  assert.throws(() => validateWorldClockVerification(params, raw, verifier), /requires exact manuscript support/);
  relation.verdict = "needs_more_evidence"; relation.retrievalRequests = ["Find a passage explicitly connecting the gate opening to the entry."];
  const receipt = validateWorldClockVerification(params, raw, verifier);
  assert.equal(approvedWorldClockProjection(params, [receipt]).relations.length, 0);
  const prompt = worldClockVerificationInstructions(request);
  assert.match(prompt, /Adjacency, sequence.*does not prove causes/); assert.match(prompt, /each actor, target, witness, location/);
  assert.match(prompt, /belief or lie must retain its exact epistemic holder/);
});

test("unresolved labels remain visible candidates but cannot be verified without an exact canonical correction", () => {
  const params = input(); const request = prepareWorldClockVerificationPages(params)[0]!;
  const unresolved = request.proposals.find((proposal) => {
    const payload = proposal.payload as unknown as WorldClockPayload;
    return payload.recordType === "participant" && payload.entityId === null;
  })!;
  const raw = response(request, { noCorrectionForUnresolved: true });
  assert.throws(() => validateWorldClockVerification(params, raw, verifier), /unresolved participant/);
  const decision = raw.clockVerification.decisions.find((item) => item.proposalId === unresolved.id)!;
  decision.correctedPayload = { ...(unresolved.payload as unknown as Extract<WorldClockPayload, { recordType: "participant" }>), entityId: id(999), entityLabel: "Invented" };
  assert.throws(() => validateWorldClockVerification(params, raw, verifier), /absent from the frozen registry/);
  decision.correctedPayload = { ...(unresolved.payload as unknown as Extract<WorldClockPayload, { recordType: "participant" }>), entityId: SANCTUARY, entityLabel: "Sanctuary" };
  assert.doesNotThrow(() => validateWorldClockVerification(params, raw, verifier));
});

test("exact quotation, raw chronology bypass and complete decision coverage fail closed", () => {
  const params = input(); const request = prepareWorldClockVerificationPages(params)[0]!;
  const missing = response(request, { omit: 0 });
  assert.throws(() => validateWorldClockVerification(params, missing, verifier), /exactly one explicit decision/);
  const bypass = response(request); (bypass as unknown as { chronology: unknown[] }).chronology = [{ name: "Unchecked" }];
  assert.throws(() => validateWorldClockVerification(params, bypass, verifier), /legacy chronology/);
  const nested = response(request) as Record<string, unknown>; nested.findings = { worldClock: [{ title: "Unchecked" }] };
  assert.throws(() => validateWorldClockVerification(params, nested, verifier), /cannot bypass/);
  const inexact = response(request);
  const stranger = inexact.clockVerification.decisions.find((decision) => {
    const payload = candidatePayload(request, decision.proposalId);
    return payload.recordType === "event" && payload.name === "Alec Enters Sanctuary";
  })!;
  stranger.supportingEvidence = [{ chunkId: FIRST, quote: "A masked stranger followed him." }];
  assert.throws(() => validateWorldClockVerification(params, inexact, verifier), /exact substring/);
});

test("temporal and epistemic corrections cannot erase qualification or mutate immutable event identity", () => {
  const params = input(); const request = prepareWorldClockVerificationPages(params)[0]!;
  const eventProposal = request.proposals.find((proposal) => proposal.payload.recordType === "event")!;
  for (const mutate of [
    (payload: Extract<WorldClockPayload, { recordType: "event" }>) => { payload.eventId = id(999); },
    (payload: Extract<WorldClockPayload, { recordType: "event" }>) => { payload.temporalStatus = "exact"; payload.worldTimeLabel = ""; },
    (payload: Extract<WorldClockPayload, { recordType: "event" }>) => { payload.truthStatus = "belief"; payload.epistemicHolderId = null; },
    (payload: Extract<WorldClockPayload, { recordType: "event" }>) => { payload.truthStatus = "fact"; payload.epistemicHolderId = LILLY; },
  ]) {
    const raw = response(request); const decision = raw.clockVerification.decisions.find((item) => item.proposalId === eventProposal.id)!;
    const corrected = structuredClone(eventProposal.payload) as unknown as Extract<WorldClockPayload, { recordType: "event" }>;
    mutate(corrected); decision.correctedPayload = corrected;
    assert.throws(() => validateWorldClockVerification(params, raw, verifier), /immutable|exact event|belief|fact/);
  }
});

test("an unclassified event remains unresolved unless its exact receipt authorizes a truth classification", () => {
  const params = input();
  params.chronology = [{
    name: "Alec Enters Sanctuary",
    summary: "Alec enters Sanctuary while Lilly watches.",
    worldTimeLabel: "First Day, dawn",
    temporalStatus: "exact",
    importance: "major",
    sourceChapterKeys: [`${SOURCE}:chapter-1`],
    evidence: [{ chunkId: FIRST, sourceId: SOURCE, quote: firstQuote }],
    confidence: 0.9,
  }];
  const request = prepareWorldClockVerificationPages(params)[0]!;
  const eventProposal = request.proposals.find((proposal) =>
    proposal.payload.recordType === "event"
  )!;
  assert.equal(
    (eventProposal.payload as unknown as Extract<WorldClockPayload, { recordType: "event" }>).truthStatus,
    "unknown",
  );

  const unresolvedReceipt = validateWorldClockVerification(
    params,
    response(request),
    verifier,
  );
  assert.equal(
    approvedWorldClockProjection(params, [unresolvedReceipt]).events[0]?.payload.truthStatus,
    "unknown",
  );

  const classified = response(request);
  const decision = classified.clockVerification.decisions.find((item) =>
    item.proposalId === eventProposal.id
  )!;
  decision.correctedPayload = {
    ...(eventProposal.payload as unknown as Extract<WorldClockPayload, { recordType: "event" }>),
    truthStatus: "fact",
    epistemicHolderId: null,
  };
  const classifiedReceipt = validateWorldClockVerification(
    params,
    classified,
    verifier,
  );
  assert.equal(
    approvedWorldClockProjection(params, [classifiedReceipt]).events[0]?.payload.truthStatus,
    "fact",
  );
});

test("tampered source, registry, manifest, model, or incomplete and extra receipts cannot project", () => {
  const params = input(); const receipts = allReceipts(params);
  const changedSource = structuredClone(params); changedSource.chunks[0]!.content += " Changed.";
  assert.throws(() => assertWorldClockVerificationReceipts(changedSource, receipts), /exact frozen clock page|receipt request/);
  const changedRegistry = structuredClone(params); changedRegistry.entities[0]!.aliases.push("Changed Alias");
  assert.throws(() => assertWorldClockVerificationReceipts(changedRegistry, receipts), /exact frozen clock page|receipt request/);
  const changedConstraintScope = structuredClone(params); changedConstraintScope.ownerConstraints![0]!.scopeEntityId = ALEC;
  assert.throws(() => assertWorldClockVerificationReceipts(changedConstraintScope, receipts), /exact frozen clock page|receipt request/);
  const orphanedConstraintScope = structuredClone(params); orphanedConstraintScope.ownerConstraints![0]!.scopeEntityId = id(999);
  assert.throws(() => prepareWorldClockVerificationPages(orphanedConstraintScope), /outside the frozen canonical entity registry/);
  const changedReceipt = structuredClone(receipts[0]!); changedReceipt.request.pageManifestFingerprint = "forged";
  assert.throws(() => assertWorldClockVerification(params, changedReceipt), /exact frozen clock page/);
  const changedModel = structuredClone(receipts[0]!); changedModel.verifier.model = "claimed-model";
  assert.throws(() => assertWorldClockVerification(params, changedModel), /provenance changed/);
  assert.throws(() => assertWorldClockVerificationReceipts(params, []), /complete frozen page inventory/);
  assert.throws(() => assertWorldClockVerificationReceipts(params, [...receipts, receipts[0]!]), /complete frozen page inventory/);
  assert.deepEqual(approvedWorldClockProjection(undefined, []), { events: [], participants: [], relations: [], withheld: [] });
  assert.throws(() => assertWorldClockVerificationReceipts(undefined, receipts), /legacy world review/);
});

test("page packing is bounded, deterministic, and every page binds the complete ordered manifest", () => {
  const params = input();
  params.chronology = Array.from({ length: WORLD_CLOCK_MAX_PROPOSALS_PER_PAGE + 2 }, (_, index) => ({
    name: `Event ${index}`, summary: `Event ${index} happens.`, worldTimeLabel: `Moment ${index}`,
    temporalStatus: "exact" as const, importance: "major" as const, sourceChapterKeys: [`${SOURCE}:chapter-${index}`],
    truthStatus: "fact" as const, epistemicHolderId: null,
    evidence: [{ chunkId: FIRST, sourceId: SOURCE, quote: firstQuote }], confidence: 0.8,
  }));
  const pages = prepareWorldClockVerificationPages(params);
  assert.equal(pages.length, 2); assert.equal(pages[0]!.proposals.length, WORLD_CLOCK_MAX_PROPOSALS_PER_PAGE);
  assert.equal(pages[1]!.proposals.length, 2); assert.deepEqual(pages.map((page) => page.stepKey), ["chronology:0", "chronology:1"]);
  assert.equal(pages[0]!.pageManifestFingerprint, pages[1]!.pageManifestFingerprint);
  assert.equal(pages[0]!.eventRegistry.length, WORLD_CLOCK_MAX_PROPOSALS_PER_PAGE + 2);
  assert.ok(pages.every((page) => Buffer.byteLength(JSON.stringify(page), "utf8") <= WORLD_CLOCK_MAX_PAGE_BYTES));
  const receipts = pages.map((page) => validateWorldClockVerification(params, response(page), verifier, page.page.index));
  assertWorldClockVerificationReceipts(params, receipts);
  const changed = structuredClone(params); changed.chronology.push({ ...structuredClone(changed.chronology[0]!), name: "Late Addition", summary: "A late event appears." });
  assert.notEqual(prepareWorldClockVerificationPages(changed)[0]!.pageManifestFingerprint, pages[0]!.pageManifestFingerprint);
  assert.throws(() => assertWorldClockVerificationReceipts(changed, receipts), /complete frozen page inventory|exact frozen clock page/);
});

test("the durable manifest descriptor binds both populated and empty clock inventories", () => {
  const params = input();
  const pages = prepareWorldClockVerificationPages(params);
  const descriptor = describeWorldClockVerificationManifest(params);
  assert.deepEqual(descriptor, {
    version: 1,
    runId: RUN,
    worldId: WORLD,
    editionId: EDITION,
    pageCount: pages.length,
    pageManifestFingerprint: pages[0]!.pageManifestFingerprint,
    inputFingerprint: pages[0]!.inventoryFingerprint,
  });
  assert.deepEqual(describeWorldClockVerificationManifest(params), descriptor);

  const empty = structuredClone(params);
  empty.chronology = [];
  const emptyDescriptor = describeWorldClockVerificationManifest(empty);
  assert.equal(emptyDescriptor.pageCount, 0);
  assert.equal(prepareWorldClockVerificationPages(empty).length, 0);
  assert.notEqual(emptyDescriptor.pageManifestFingerprint, descriptor.pageManifestFingerprint);
  assert.notEqual(emptyDescriptor.inputFingerprint, descriptor.inputFingerprint);
  assert.deepEqual(describeWorldClockVerificationManifest(empty), emptyDescriptor);
});

test("an individually verified dependent is explicitly withheld when an endpoint event was not approved", () => {
  const params = input(); const request = prepareWorldClockVerificationPages(params)[0]!;
  const raw = response(request, { verdict: (payload) => payload.recordType === "event" && payload.name === "Raiders Enter Sanctuary" ? "rejected" : "verified" });
  const receipt = validateWorldClockVerification(params, raw, verifier);
  const projection = approvedWorldClockProjection(params, [receipt]);
  assert.equal(projection.relations.length, 0);
  assert.equal(projection.withheld.some((item) => item.recordType === "event_relation" && item.reason === "target_event_not_approved"), true);
  assert.equal(projection.events.some((item) => item.payload.name === "Raiders Enter Sanctuary"), false);
});

test("alias-equivalent participants and duplicate typed event edges cannot collide in persistence", () => {
  const params = input();
  params.chronology[0]!.actors = ["Alec", "Alec Sumner"];
  params.chronology[1]!.eventRelations = [
    params.chronology[1]!.eventRelations![0]!,
    structuredClone(params.chronology[1]!.eventRelations![0]!),
  ];
  const pages = prepareWorldClockVerificationPages(params);
  const request = pages[0]!;
  const raw = response(request);
  const alecProposals = request.proposals.filter((proposal) => {
    const payload = proposal.payload as unknown as WorldClockPayload;
    return payload.recordType === "participant"
      && payload.entityId === ALEC
      && payload.role === "actor";
  });
  const exactNameProposal = alecProposals.find((proposal) =>
    (proposal.payload as unknown as Extract<WorldClockPayload, { recordType: "participant" }>).entityLabel === "Alec Sumner"
  )!;
  const aliasProposal = alecProposals.find((proposal) => proposal.id !== exactNameProposal.id)!;
  raw.clockVerification.decisions.find((decision) => decision.proposalId === exactNameProposal.id)!.confidence = 0.99;
  raw.clockVerification.decisions.find((decision) => decision.proposalId === aliasProposal.id)!.confidence = 0.61;

  const relationProposals = request.proposals.filter((proposal) =>
    (proposal.payload as unknown as WorldClockPayload).recordType === "event_relation"
  );
  const preferredRelation = relationProposals[1]!;
  raw.clockVerification.decisions.find((decision) => decision.proposalId === relationProposals[0]!.id)!.confidence = 0.62;
  raw.clockVerification.decisions.find((decision) => decision.proposalId === preferredRelation.id)!.confidence = 0.98;
  const receipts = [validateWorldClockVerification(params, raw, verifier, request.page.index)];
  const projection = approvedWorldClockProjection(params, receipts);
  const alecActors = projection.participants.filter((item) =>
    item.payload.eventId === projection.events.find((event) => event.payload.name === "Alec Enters Sanctuary")?.payload.eventId
      && item.payload.entityId === ALEC
      && item.payload.role === "actor"
  );
  assert.equal(alecActors.length, 1);
  assert.equal(alecActors[0]!.proposalId, exactNameProposal.id);
  assert.equal(projection.relations.length, 1);
  assert.equal(projection.relations[0]!.proposalId, preferredRelation.id);
  assert.equal(projection.withheld.some((item) => item.reason === "duplicate_participant"), true);
  assert.equal(projection.withheld.some((item) => item.reason === "duplicate_event_relation"), true);
  assert.equal(projection.withheld.some((item) => item.proposalId === aliasProposal.id), true);
  assert.equal(projection.withheld.some((item) => item.proposalId === relationProposals[0]!.id), true);
});

test("a single oversized candidate is rejected explicitly and never truncated", () => {
  const params = input();
  params.chronology = [params.chronology[0]!];
  params.entities[0]!.aliases = Array.from({ length: 400 }, (_, index) => `Alias-${String(index).padStart(3, "0")}-${"x".repeat(390)}`);
  assert.throws(() => prepareWorldClockVerificationPages(params), /exceeds the maximum page size|cannot be truncated/);
});
