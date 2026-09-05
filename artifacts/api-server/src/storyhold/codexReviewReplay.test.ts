import assert from "node:assert/strict";
import test from "node:test";
import {
  chronologySynthesisGroups,
  mergeWorldFindings,
  mergeSynthesizedChronology,
  parseWorldAnalysisBatchCoverage,
  parseWorldFindingsFromModel,
  type AnalysisChunk,
  type ChronologyFinding,
  type WorldFindings,
} from "./worldAnalysis";
import {
  CodexReviewReplayError,
  chronologyReplayPayload,
  extractionReplayPayload,
  replayCompletionForRequest,
  sourceChunksFromMessages,
  startCodexReviewReplay,
  validateCuratedWorldFindings,
} from "./codexReviewReplay";

const SOURCE_ONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_TWO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHUNK_ONE = "11111111-1111-4111-8111-111111111111";
const CHUNK_TWO = "22222222-2222-4222-8222-222222222222";
const CHUNK_THREE = "33333333-3333-4333-8333-333333333333";

function evidence(chunkId: string, quote: string, sourceId = SOURCE_ONE) {
  return { chunkId, sourceId, quote };
}

function curatedFixture(): WorldFindings {
  return {
    summary: "A grounded world summary.",
    genres: ["horror"],
    atmosphere: ["tense"],
    themes: ["survival"],
    worldRules: [],
    locations: [{
      name: "Sanctuary",
      summary: "A defended refuge.",
      evidence: [evidence(CHUNK_TWO, "Echo guarded Sanctuary.")],
    }],
    factions: [],
    institutions: [],
    governments: [],
    powerStructures: [],
    creatures: [],
    species: [],
    technologies: [],
    vehicles: [],
    devices: [],
    weapons: [],
    powers: [],
    titles: [],
    ambiguous: [],
    chapterSummaries: [{
      sourceId: SOURCE_ONE,
      sourceTitle: "Book One",
      chapterKey: `${SOURCE_ONE}:chapter-1`,
      chapterTitle: "Chapter One",
      perspective: "Alec",
      sourceOrder: 0,
      summary: "Alec crosses the bridge and commits to the journey.",
      majorEvents: ["Alec crosses the bridge."],
      evidence: [evidence(CHUNK_ONE, "Alec crossed the bridge.")],
      confidence: 0.95,
    }, {
      sourceId: SOURCE_ONE,
      sourceTitle: "Book One",
      chapterKey: `${SOURCE_ONE}:chapter-2`,
      chapterTitle: "Chapter Two",
      perspective: "Echo",
      sourceOrder: 1,
      summary: "Echo guards Sanctuary while danger approaches.",
      majorEvents: ["Echo guards Sanctuary."],
      evidence: [evidence(CHUNK_TWO, "Echo guarded Sanctuary.")],
      confidence: 0.95,
    }],
    chronology: [{
      name: "Alec reaches Sanctuary",
      summary: "The crossing brings Alec to the refuge.",
      evidence: [evidence(CHUNK_ONE, "Alec crossed the bridge.")],
      sourceChapterKeys: [
        `${SOURCE_ONE}:chapter-1`,
        `${SOURCE_ONE}:chapter-2`,
      ],
      actors: ["Alec"],
      targets: [],
      witnesses: ["Echo"],
      locations: ["Sanctuary"],
      confidence: 0.9,
    }],
    openQuestions: ["Who built Sanctuary?"],
    recurringTerms: ["Sanctuary"],
    characters: [{
      name: "Alec",
      aliases: [],
      role: "survivor",
      summary: "A persistent survivor.",
      traits: ["persistent"],
      motivations: [],
      fears: [],
      capabilities: [],
      history: [],
      origins: [],
      powers: [],
      moralSystem: [],
      physicalCharacteristics: [],
      relationships: [],
      relationshipWeb: [{
        name: "Echo",
        relationship: "ally",
        summary: "Echo protects Alec.",
        sentiment: "allied",
        evidence: [evidence(CHUNK_TWO, "Echo guarded Sanctuary.")],
      }],
      estimatedStats: {
        strength: { score: 10, confidence: 0.5, rationale: "ordinary", evidence: [] },
        dexterity: { score: 10, confidence: 0.5, rationale: "ordinary", evidence: [] },
        constitution: { score: 10, confidence: 0.5, rationale: "ordinary", evidence: [] },
        intelligence: { score: 10, confidence: 0.5, rationale: "ordinary", evidence: [] },
        wisdom: { score: 10, confidence: 0.5, rationale: "ordinary", evidence: [] },
        charisma: { score: 10, confidence: 0.5, rationale: "ordinary", evidence: [] },
        acrobatics: { score: 10, confidence: 0.5, rationale: "ordinary", evidence: [] },
      },
      socioPoliticalAxis: {
        economic: 0,
        authority: 0,
        label: "unknown",
        rationale: "thin evidence",
        confidence: 0.1,
      },
      knowledge: [],
      secrets: [],
      factionMemberships: [],
      evidence: [
        evidence(CHUNK_ONE, "Alec crossed the bridge."),
        evidence(CHUNK_TWO, "Echo guarded Sanctuary."),
      ],
      confidence: 0.8,
    }],
    entityRelations: [],
    entityRules: [],
    claims: [{
      subject: "Alec",
      predicate: "crossed",
      value: "the bridge",
      epistemicHolder: "",
      truthStatus: "fact",
      validFromLabel: "",
      validUntilLabel: "",
      evidence: [evidence(CHUNK_ONE, "Alec crossed the bridge.")],
      confidence: 0.95,
    }],
    cohesionProposals: [],
  };
}

function extractionMessages() {
  return [{
    role: "system",
    content: "You extract a reviewable world model from private narrative source material.",
  }, {
    role: "user",
    content: `Analyze this batch.
<SOURCE title="Book One" chunkId="${CHUNK_ONE}" sourceId="${SOURCE_ONE}" index=0>
Alec crossed the bridge.
</SOURCE>
<SOURCE title="Book Two" chunkId="${CHUNK_THREE}" sourceId="${SOURCE_TWO}" index=7>
Rain fell on an empty road.
</SOURCE>`,
  }];
}

test("extraction replay admits only exact in-batch evidence and accounts for every SOURCE", () => {
  const curated = curatedFixture();
  const before = JSON.stringify(curated);
  const chunks = sourceChunksFromMessages(extractionMessages());
  const payload = extractionReplayPayload(curated, chunks);

  assert.equal(JSON.stringify(curated), before, "the curated artifact must remain immutable");
  assert.deepEqual(payload.coverage, [{ chunkId: CHUNK_ONE, status: "findings" }, {
    chunkId: CHUNK_THREE,
    status: "no_findings",
  }]);
  assert.deepEqual(payload.locations, [], "out-of-batch cards must be omitted");
  const characters = payload.characters as Array<Record<string, unknown>>;
  assert.equal(characters.length, 1);
  assert.deepEqual(characters[0]?.evidence, [
    evidence(CHUNK_ONE, "Alec crossed the bridge."),
  ]);
  assert.deepEqual(characters[0]?.relationshipWeb, []);
  const claims = payload.claims as Array<Record<string, unknown>>;
  assert.equal(claims.length, 1);
});

test("only the first extraction batch emits whole-world summary fields", () => {
  const request = {
    model: "codex-session",
    messages: extractionMessages().map((message) => ({
      ...message,
      content: message.role === "user"
        ? `Analyze only the supplied passages in source batch 2 of 4.\n${message.content}`
        : message.content,
    })),
  };
  const completion = replayCompletionForRequest(curatedFixture(), request);
  const payload = JSON.parse(completion.choices[0]!.message.content) as Record<string, unknown>;
  assert.equal(payload.summary, "");
  assert.deepEqual(payload.genres, []);
  assert.deepEqual(payload.atmosphere, []);
  assert.deepEqual(payload.themes, []);
  assert.deepEqual(payload.openQuestions, []);
});

test("SOURCE parsing rejects duplicate and non-UUID chunk manifests", () => {
  const duplicate = extractionMessages();
  duplicate[1]!.content += `
<SOURCE title="Again" chunkId="${CHUNK_ONE}" sourceId="${SOURCE_ONE}" index=9>
Alec crossed the bridge.
</SOURCE>`;
  assert.throws(
    () => sourceChunksFromMessages(duplicate),
    (error: unknown) =>
      error instanceof CodexReviewReplayError && /repeated/.test(error.message),
  );
  assert.throws(
    () => sourceChunksFromMessages([{ content: `<SOURCE title="Book" chunkId="not-current" sourceId="${SOURCE_ONE}" index=0>
Text.
</SOURCE>` }]),
    /not a current UUID/,
  );
});

test("chronology replay returns every supplied chapter key exactly once", () => {
  const curated = curatedFixture();
  const group = {
    chapterSummaries: curated.chapterSummaries.map((chapter) => ({
      ...chapter,
      summary: "Weak incoming summary.",
    })),
    chronology: [],
  };
  const payload = chronologyReplayPayload(curated, group);
  const chapters = payload.chapterSummaries as Array<Record<string, unknown>>;
  assert.deepEqual(
    chapters.map((chapter) => chapter.chapterKey),
    curated.chapterSummaries.map((chapter) => chapter.chapterKey),
  );
  assert.equal(new Set(chapters.map((chapter) => chapter.chapterKey)).size, 2);
  assert.equal(chapters[0]?.summary, curated.chapterSummaries[0]?.summary);
  const chronology = payload.chronology as Array<Record<string, unknown>>;
  assert.equal(chronology.length, 1);
  assert.deepEqual(chronology[0]?.sourceChapterKeys, [
    `${SOURCE_ONE}:chapter-1`,
    `${SOURCE_ONE}:chapter-2`,
  ]);
});

test("chronology replay preserves curated diegetic order over incoming chapter order", () => {
  const curated = curatedFixture();
  const first = curated.chronology[0]!;
  const ancient = {
    ...first,
    name: "Ancient event",
    worldTimeLabel: "Long before the present",
    sourceChapterKeys: [`${SOURCE_ONE}:chapter-2`],
  };
  const present = {
    ...first,
    name: "Present event",
    worldTimeLabel: "Present",
    sourceChapterKeys: [`${SOURCE_ONE}:chapter-1`],
  };
  curated.chronology = [ancient, present];
  const payload = chronologyReplayPayload(curated, {
    chapterSummaries: curated.chapterSummaries,
    chronology: [present, ancient],
  });
  const chronology = payload.chronology as Array<Record<string, unknown>>;
  assert.deepEqual(
    chronology.map((event) => event.name),
    ["Ancient event", "Present event"],
  );
});

test("46-chapter multi-group replay preserves the complete curated chronology order", () => {
  const curated = curatedFixture();
  curated.chapterSummaries = Array.from({ length: 46 }, (_, index) => ({
    ...curated.chapterSummaries[index % 2]!,
    chapterKey: `${SOURCE_ONE}:chapter-${index + 1}`,
    chapterTitle: `Chapter ${index + 1}`,
    sourceOrder: index,
    summary: `Grounded chapter ${index + 1}. ${"Consequential detail. ".repeat(12)}`,
  }));
  const event = curated.chronology[0]!;
  const ancient = {
    ...event,
    name: "Ancient event",
    worldTimeLabel: "Long before the present",
    sourceChapterKeys: [`${SOURCE_ONE}:chapter-46`],
  };
  const middle = {
    ...event,
    name: "Middle event",
    worldTimeLabel: "Years before the present",
    sourceChapterKeys: [`${SOURCE_ONE}:chapter-30`],
  };
  const present = {
    ...event,
    name: "Present event",
    worldTimeLabel: "Present",
    sourceChapterKeys: [`${SOURCE_ONE}:chapter-1`],
  };
  curated.chronology = [ancient, middle, present];

  const incoming = {
    chapterSummaries: curated.chapterSummaries,
    chronology: [present, middle, ancient],
  };
  const groups = chronologySynthesisGroups(incoming, 6_000);
  assert.ok(groups.length > 2, "the fixture must cross several synthesis boundaries");

  const returnedChapterKeys: string[] = [];
  const synthesizedChronology: ChronologyFinding[] = [];
  for (const group of groups) {
    const payload = chronologyReplayPayload(curated, group);
    returnedChapterKeys.push(
      ...(payload.chapterSummaries as Array<{ chapterKey: string }>).map(
        (chapter) => chapter.chapterKey,
      ),
    );
    synthesizedChronology.push(
      ...(payload.chronology as unknown as ChronologyFinding[]),
    );
  }
  const finalChronology = mergeSynthesizedChronology(
    incoming.chronology,
    synthesizedChronology,
  );

  assert.equal(returnedChapterKeys.length, 46);
  assert.equal(new Set(returnedChapterKeys).size, 46);
  assert.deepEqual(
    finalChronology.map((item) => item.name),
    ["Ancient event", "Middle event", "Present event"],
  );
});

test("21-batch replay and bounded synthesis preserve 1,295 curated evidence references across 208 chunks", () => {
  const totalChunkCount = 522;
  const citedChunkCount = 208;
  const batchSizes = [25, 24, ...Array.from({ length: 18 }, () => 25), 23];
  assert.equal(batchSizes.length, 21);
  assert.equal(batchSizes.reduce((total, size) => total + size, 0), totalChunkCount);

  const chunks: AnalysisChunk[] = Array.from({ length: totalChunkCount }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    sourceId: SOURCE_ONE,
    sourceTitle: "Evidence Corpus",
    index,
    content: `Grounded evidence passage ${index + 1}.`,
  }));
  const citedChunks = Array.from({ length: citedChunkCount }, (_, index) =>
    chunks[Math.floor(index * totalChunkCount / citedChunkCount)]!
  );
  let evidenceCursor = 0;
  const nextEvidence = () => {
    const chunk = citedChunks[evidenceCursor % citedChunks.length]!;
    evidenceCursor += 1;
    return evidence(chunk.id, chunk.content, chunk.sourceId);
  };

  const curated = curatedFixture();
  curated.locations = [];
  curated.claims = [];
  const characterTemplate = curated.characters[0]!;
  curated.characters = Array.from({ length: 49 }, (_, characterIndex) => ({
    ...characterTemplate,
    name: `Character ${characterIndex + 1}`,
    aliases: [],
    role: "",
    summary: "",
    traits: [],
    motivations: [],
    fears: [],
    capabilities: [],
    history: [],
    origins: [],
    powers: [],
    moralSystem: [],
    physicalCharacteristics: [],
    relationships: [],
    relationshipWeb: Array.from(
      { length: characterIndex < 25 ? 24 : 23 },
      (_, relationshipIndex) => ({
        name: `Contact ${characterIndex + 1}-${relationshipIndex + 1}`,
        relationship: `connection ${relationshipIndex + 1}`,
        summary: "A source-grounded connection.",
        sentiment: "unknown" as const,
        evidence: [nextEvidence()],
      }),
    ),
    knowledge: [],
    secrets: [],
    factionMemberships: [],
    evidence: [nextEvidence()],
  }));

  const chapterTemplate = curated.chapterSummaries[0]!;
  const longSummary = `A consequential development changes the world state. ${"Grounded consequence. ".repeat(30)}`;
  curated.chapterSummaries = Array.from({ length: 46 }, (_, index) => ({
    ...chapterTemplate,
    chapterKey: `${SOURCE_ONE}:chapter-${index + 1}`,
    chapterTitle: `Chapter ${index + 1}`,
    sourceOrder: index,
    summary: longSummary,
    majorEvents: [`Chapter event ${index + 1}`],
    evidence: [nextEvidence()],
  }));
  const chronologyTemplate = curated.chronology[0]!;
  curated.chronology = Array.from({ length: 48 }, (_, index) => ({
    ...chronologyTemplate,
    name: `Canonical event ${index + 1}`,
    summary: longSummary,
    worldTimeLabel: `Era ${index + 1}`,
    sourceChapterKeys: [`${SOURCE_ONE}:chapter-${(index % 46) + 1}`],
    evidence: [nextEvidence()],
  }));
  assert.equal(evidenceCursor, 1_295);

  const batches: AnalysisChunk[][] = [];
  let offset = 0;
  for (const size of batchSizes) {
    batches.push(chunks.slice(offset, offset + size));
    offset += size;
  }
  let relationshipOnlyCarrierCount = 0;
  const parsedBatches = batches.map((batch, batchIndex) => {
    const payload = extractionReplayPayload(
      curated,
      batch.map((chunk) => ({
        chunkId: chunk.id,
        sourceId: chunk.sourceId,
        content: chunk.content,
      })),
      { includeGlobalContext: batchIndex === 0 },
    );
    for (const carrier of payload.characters as Array<Record<string, unknown>>) {
      if (
        Array.isArray(carrier.evidence) && carrier.evidence.length === 0 &&
        Array.isArray(carrier.relationshipWeb) && carrier.relationshipWeb.length > 0
      ) {
        relationshipOnlyCarrierCount += 1;
        assert.deepEqual(
          Object.keys(carrier).sort(),
          ["evidence", "name", "relationshipWeb"],
          "a relationship-only slice must not replay unsupported profile fields",
        );
      }
    }
    const parsed = parseWorldFindingsFromModel(payload, batch);
    parseWorldAnalysisBatchCoverage(payload, batch, batchIndex, batches.length, parsed);
    return parsed;
  });
  assert.ok(relationshipOnlyCarrierCount > 0);
  let replayed = parsedBatches.slice(1).reduce(
    (current, batch) => mergeWorldFindings(current, batch),
    parsedBatches[0]!,
  );

  const synthesisGroups = chronologySynthesisGroups(replayed);
  assert.equal(synthesisGroups.length, 3, "the regression must retain the current three-group synthesis shape");
  assert.ok(synthesisGroups.every((group) => JSON.stringify(group).length <= 42_000));
  const synthesizedChronology: ChronologyFinding[] = [];
  for (const group of synthesisGroups) {
    const parsed = parseWorldFindingsFromModel(
      chronologyReplayPayload(curated, group as unknown as Record<string, unknown>),
      chunks,
    );
    const revisedByKey = new Map(
      parsed.chapterSummaries.map((chapter) => [chapter.chapterKey, chapter]),
    );
    replayed.chapterSummaries = replayed.chapterSummaries.map(
      (chapter) => revisedByKey.get(chapter.chapterKey) ?? chapter,
    );
    synthesizedChronology.push(...parsed.chronology);
  }
  replayed.chronology = mergeSynthesizedChronology(
    replayed.chronology,
    synthesizedChronology,
  );

  const evidenceMetrics = (value: unknown) => {
    let count = 0;
    const chunkIds = new Set<string>();
    const visit = (item: unknown): void => {
      if (Array.isArray(item)) {
        item.forEach(visit);
        return;
      }
      if (!item || typeof item !== "object") return;
      const record = item as Record<string, unknown>;
      if (typeof record.chunkId === "string" && typeof record.quote === "string") {
        count += 1;
        chunkIds.add(record.chunkId);
      }
      Object.values(record).forEach(visit);
    };
    visit(value);
    return { count, chunkIds };
  };
  const curatedMetrics = evidenceMetrics(curated);
  const replayedMetrics = evidenceMetrics(replayed);
  assert.equal(curatedMetrics.count, 1_295);
  assert.equal(replayedMetrics.count, curatedMetrics.count);
  assert.equal(curatedMetrics.chunkIds.size, 208);
  assert.deepEqual(replayedMetrics.chunkIds, curatedMetrics.chunkIds);
  assert.equal(replayed.characters.length, 49);
  assert.equal(replayed.chapterSummaries.length, 46);
  assert.equal(replayed.chronology.length, 48);
});

test("21-batch replay preserves explicit power summaries and all ten curated citations", () => {
  const totalChunkCount = 522;
  const batchSizes = [25, 24, ...Array.from({ length: 18 }, () => 25), 23];
  const chunks: AnalysisChunk[] = Array.from({ length: totalChunkCount }, (_, index) => ({
    id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    sourceId: SOURCE_ONE,
    sourceTitle: "Power Corpus",
    index,
    content: `Power evidence passage ${index + 1}.`,
  }));
  const powerSpecs = [
    { name: "Superhuman strength", summary: "The hybrid form can overpower human attackers, deform structures, and contend with large predators.", chunkIndexes: [45, 410] },
    { name: "Telepathy", summary: "Direct mental contact permits private communication across the collective.", chunkIndexes: [70, 430] },
    { name: "Thermal vision", summary: "Transformed senses render heat signatures across bodies and terrain.", chunkIndexes: [105, 455] },
    { name: "Ultraviolet vision", summary: "Transformed senses perceive ultraviolet traces invisible to ordinary humans.", chunkIndexes: [155] },
    { name: "Accelerated healing", summary: "The altered body heals much faster than an ordinary human body.", chunkIndexes: [230] },
    { name: "Neural resuscitation", summary: "A linked consciousness can restart otherwise fatal neural and cardiac failure.", chunkIndexes: [330] },
    { name: "Partial shapeshifting", summary: "A transformed body can alter one region without completing a full change.", chunkIndexes: [500] },
  ];
  assert.equal(powerSpecs.reduce((total, power) => total + power.chunkIndexes.length, 0), 10);

  const curated = curatedFixture();
  const character = curated.characters[0]!;
  curated.characters = [{
    ...character,
    name: "Geela",
    powers: powerSpecs.map((power) => power.name),
    relationshipWeb: [],
    evidence: [evidence(chunks[0]!.id, chunks[0]!.content, SOURCE_ONE)],
  }];
  curated.powers = powerSpecs.map((power) => ({
    name: power.name,
    summary: power.summary,
    evidence: power.chunkIndexes.map((index) =>
      evidence(chunks[index]!.id, chunks[index]!.content, SOURCE_ONE)
    ),
    aliases: [],
    details: [],
    relationships: [],
    confidence: 0.95,
    reviewStatus: "verified" as const,
  }));

  const batches: AnalysisChunk[][] = [];
  let offset = 0;
  for (const size of batchSizes) {
    batches.push(chunks.slice(offset, offset + size));
    offset += size;
  }
  const parsedBatches = batches.map((batch, batchIndex) => {
    const payload = extractionReplayPayload(
      curated,
      batch.map((chunk) => ({
        chunkId: chunk.id,
        sourceId: chunk.sourceId,
        content: chunk.content,
      })),
      { includeGlobalContext: batchIndex === 0 },
    );
    const parsed = parseWorldFindingsFromModel(payload, batch);
    parseWorldAnalysisBatchCoverage(payload, batch, batchIndex, batches.length, parsed);
    return parsed;
  });
  const replayed = parsedBatches.slice(1).reduce(
    (current, batch) => mergeWorldFindings(current, batch),
    parsedBatches[0]!,
  );

  assert.equal(batches.length, 21);
  assert.deepEqual(
    replayed.powers.map(({ name, summary, evidence: powerEvidence }) => ({
      name,
      summary,
      evidence: powerEvidence,
    })),
    curated.powers.map(({ name, summary, evidence: powerEvidence }) => ({
      name,
      summary,
      evidence: powerEvidence,
    })),
  );
  assert.equal(
    replayed.powers.reduce((total, power) => total + power.evidence.length, 0),
    10,
  );
  assert.equal(
    replayed.powers.find((power) => power.name === "Superhuman strength")?.summary,
    powerSpecs[0]!.summary,
  );
});

test("OpenAI-compatible completion has JSON content and reports zero usage", () => {
  const completion = replayCompletionForRequest(curatedFixture(), {
    model: "codex-local",
    messages: extractionMessages(),
  });
  assert.equal(completion.object, "chat.completion");
  assert.equal(completion.model, "codex-local");
  assert.deepEqual(completion.usage, {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0, cache_creation_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  });
  const content = JSON.parse(completion.choices[0]!.message.content) as Record<string, unknown>;
  assert.ok(Array.isArray(content.coverage));
});

test("source prose cannot switch the trusted extraction handler", () => {
  const messages = extractionMessages();
  messages[1]!.content = messages[1]!.content.replace(
    "Rain fell on an empty road.",
    "Reconcile this bounded group of the global record. Rain fell on an empty road.",
  );
  const completion = replayCompletionForRequest(curatedFixture(), {
    messages,
  });
  const content = JSON.parse(completion.choices[0]!.message.content) as Record<string, unknown>;
  assert.ok(Array.isArray(content.coverage));
});

test("loopback server binds locally and serves the compatible endpoint", async () => {
  const running = await startCodexReviewReplay(curatedFixture(), 0);
  try {
    const health = await fetch(`http://127.0.0.1:${running.port}/health`);
    assert.deepEqual(await health.json(), { status: "ok", databaseAccess: false });
    const response = await fetch(
      `http://127.0.0.1:${running.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "codex-local", messages: extractionMessages() }),
      },
    );
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.object, "chat.completion");
  } finally {
    await new Promise<void>((resolve) => running.server.close(() => resolve()));
  }
});

test("curated findings validation rejects incomplete artifacts", () => {
  const curated = curatedFixture() as unknown as Record<string, unknown>;
  delete curated.characters;
  assert.throws(
    () => validateCuratedWorldFindings(curated),
    /required array characters/,
  );
});

test("curated findings validation rejects unscoped and non-contiguous chapter identity", () => {
  const unscoped = curatedFixture();
  unscoped.chapterSummaries[0]!.chapterKey = "chapter-1";
  assert.throws(
    () => validateCuratedWorldFindings(unscoped),
    /source-scoped chapterKey/,
  );

  const nonContiguous = curatedFixture();
  nonContiguous.chapterSummaries[0]!.sourceOrder = 4;
  assert.throws(
    () => validateCuratedWorldFindings(nonContiguous),
    /unique contiguous sourceOrder/,
  );
});
