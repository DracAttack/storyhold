import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import {
  extractLocalStoryEntities,
  getLocalEntityExtractionStatus,
  localCharacterNameIsUseful,
  localEntityTextIsUseful,
  parseLocalEntityResponse,
  parseLocalPassageClassifications,
  parseLocalRelationResponse,
  parseLocalStorySignals,
  probeLocalEntityExtraction,
} from "./localEntityExtraction";

test("gameplay reads stop after a failure, preserve its detail, and leave thorough intake unchanged", async (t) => {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  process.env.STORYHOLD_LOCAL_GLINER2_ENABLED = "true";
  process.env.STORYHOLD_LOCAL_GLINER2_URL = "http://127.0.0.1:8765/gliner2";
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    bodies.push(JSON.parse(String(options?.body)));
    return Response.json({ error: "Model unavailable: Windows commit capacity exhausted." }, { status: 503 });
  });
  const chunks = ["one", "two", "three"].map((id) => ({ id, sourceId: "book", content: `${id} passage.` }));
  const deadlineUnixMs = Date.now() + 2_000;
  const gameplay = await extractLocalStoryEntities({ chunks, deadlineUnixMs, stopOnFailure: true, requireLoaded: true });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]?.deadlineUnixMs, deadlineUnixMs);
  assert.equal(bodies[0]?.requireLoaded, true);
  assert.equal(gameplay.receipt.status, "failed");
  assert.equal(gameplay.receipt.unprocessedSegments, 2);
  assert.match(gameplay.receipt.errors[0]!, /Windows commit capacity exhausted/);
  bodies.length = 0;
  const intake = await extractLocalStoryEntities({ chunks });
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0]?.deadlineUnixMs, undefined);
  assert.equal(bodies[0]?.requireLoaded, undefined);
  assert.equal(intake.receipt.failedSegments, 3);
});

test("gameplay entity deadline covers all segments and records unfinished work", async (t) => {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  process.env.STORYHOLD_LOCAL_GLINER2_ENABLED = "true";
  process.env.STORYHOLD_LOCAL_GLINER2_URL = "http://127.0.0.1:8765/gliner2";
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    requests += 1;
    if (requests === 1) return Response.json({ entities: [] });
    return await new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("Gameplay deadline exceeded")), { once: true });
    });
  });
  const started = Date.now();
  const result = await extractLocalStoryEntities({
    chunks: ["one", "two", "three"].map((id) => ({ id, sourceId: "book", content: `${id} passage.` })),
    deadlineUnixMs: started + 70, stopOnFailure: true,
  });
  assert.equal(requests, 2);
  assert.equal(result.receipt.status, "partial");
  assert.equal(result.receipt.completedSegments, 1);
  assert.equal(result.receipt.failedSegments, 1);
  assert.equal(result.receipt.unprocessedSegments, 1);
  assert.ok(Date.now() - started < 2_000);
  requests = 0;
  const expired = await extractLocalStoryEntities({
    chunks: [{ id: "one", sourceId: "book", content: "Alec waits." }], deadlineUnixMs: Date.now() - 1,
  });
  assert.equal(requests, 0);
  assert.equal(expired.receipt.status, "failed");
  assert.equal(expired.receipt.unprocessedSegments, 1);
});

test("GLiNER gameplay deadline closes the real local HTTP request and forwards the worker deadline", async (t) => {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  let sentDeadline = 0;
  let disconnected!: () => void;
  const connectionClosed = new Promise<void>((resolve) => { disconnected = resolve; });
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (part) => { body += String(part); });
    request.on("end", () => {
      sentDeadline = JSON.parse(body).deadlineUnixMs;
      response.writeHead(200, { "content-type": "application/json" });
      response.write(" ");
      response.on("close", disconnected);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.STORYHOLD_LOCAL_GLINER2_ENABLED = "true";
  process.env.STORYHOLD_LOCAL_GLINER2_URL = `http://127.0.0.1:${address.port}/gliner2`;
  const deadlineUnixMs = Date.now() + 150;
  const result = await extractLocalStoryEntities({
    chunks: [{ id: "one", sourceId: "book", content: "Mara waits." }], deadlineUnixMs, stopOnFailure: true,
  });
  assert.equal(sentDeadline, deadlineUnixMs);
  assert.equal(result.receipt.status, "failed");
  assert.match(result.receipt.errors.join(" "), /gameplay deadline/);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([connectionClosed, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Timed-out GLiNER connection remained open.")), 2_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
});

test("GLiNER resumes after the last durably saved segment", async () => {
  const previous = { ...process.env };
  const requests: string[] = [];
  const server = await import("node:http").then(({ createServer }) => createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part) => { body += part; });
    request.on("end", () => {
      requests.push(String((JSON.parse(body) as { text?: string }).text ?? ""));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        entities: [{ text: "Echo", label: "person or named fictional character", score: 0.9 }],
      }));
    });
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.STORYHOLD_LOCAL_GLINER1_ENABLED = "true";
    process.env.STORYHOLD_LOCAL_GLINER1_URL = `http://127.0.0.1:${address.port}/gliner1`;
    const savedMention = {
      text: "Alec",
      category: "character" as const,
      score: 0.9,
      chunkId: "one",
      sourceId: "book",
      quote: "Alec waited.",
    };
    const result = await extractLocalStoryEntities({
      stage: "gliner1",
      chunks: [
        { id: "one", sourceId: "book", content: "Alec waited." },
        { id: "two", sourceId: "book", content: "Echo arrived." },
      ],
      resume: {
        completedSegments: 1,
        mentions: [savedMention],
        relations: [],
        classifications: [],
        signals: [],
      },
    });
    assert.deepEqual(requests, ["Echo arrived."]);
    assert.equal(result.receipt.completedSegments, 2);
    assert.deepEqual(result.mentions.map((mention) => mention.text), ["Alec", "Echo"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    process.env = previous;
  }
});

test("local entity extraction rejects prose noise, references, and sound effects before canon review", () => {
  for (const value of [
    "Aye", "Shit", "Above", "Despite", "BOOM", "THUD", "Thump",
    "they", "them", "it", "me", "We", "Body", "weapon", "abilities",
    "well", "home", "Twat", "Gunshots", "Erm", "Eugh", "Gah",
    "Kablam", "Chrissake", "Betryal",
  ]) {
    assert.equal(localEntityTextIsUseful(value), false, value);
  }
  for (const value of ["Echo", "Ragger", "Hive Mind", "Hill AFB", "Visharath"]) {
    assert.equal(localEntityTextIsUseful(value), true, value);
  }
  assert.equal(localCharacterNameIsUseful("Dude"), true);
  assert.equal(localCharacterNameIsUseful("Dad"), true);
});

test("character leads require names instead of pronouns or descriptive references", () => {
  for (const value of [
    "He", "His", "You", "One", "someone", "pilot", "the stranger",
    "Elven assistant", "seventeen-year-old boy", "This man", "technicians",
    "Jesus fucking Christ", "Oh My God", "Turncoats and Changelings",
  ]) {
    assert.equal(localCharacterNameIsUseful(value), false, value);
  }
  for (const value of [
    "ISAAC", "Ash", "Ash Yutanaki Vale", "Admiral Seedbetter",
    "Lieutenant Drumrong", "Mistress Veyra",
  ]) {
    assert.equal(localCharacterNameIsUseful(value), true, value);
  }
});

test("GLiNER2 noise rows never become local entity leads", () => {
  const mentions = parseLocalEntityResponse(
    {
      entities: [
        { text: "BOOM", label: "named creature, monster, animal, alien form, or creature subtype", score: 0.99 },
        { text: "Shit", label: "person or named fictional character", score: 0.99 },
        { text: "He", label: "person or named fictional character", score: 0.99 },
        { text: "Echo", label: "person or named fictional character", score: 0.88 },
      ],
    },
    {
      chunkId: "11111111-1111-4111-8111-111111111111",
      sourceId: "22222222-2222-4222-8222-222222222222",
      text: "BOOM. Shit, He heard Echo speak and kept moving.",
    },
  );
  assert.deepEqual(mentions.map((mention) => mention.text), ["Echo"]);
});

test("local entity extraction rejects a remote endpoint unless explicitly allowed", () => {
  const previous = { ...process.env };
  try {
    process.env.STORYHOLD_LOCAL_NER_ENABLED = "true";
    process.env.STORYHOLD_LOCAL_NER_URL = "https://example.com/gliner";
    delete process.env.STORYHOLD_LOCAL_NER_ALLOW_REMOTE;
    const status = getLocalEntityExtractionStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.configured, false);
    assert.equal(status.endpoint, null);
  } finally {
    process.env = previous;
  }
});

test("local entity extraction reports loopback health without sending manuscript text", async () => {
  const previous = { ...process.env };
  const server = await import("node:http").then(({ createServer }) => createServer((request, response) => {
    assert.equal(request.url, "/health");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ready", service: "storyhold-lorekeeper-local" }));
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.STORYHOLD_LOCAL_NER_ENABLED = "true";
    process.env.STORYHOLD_LOCAL_NER_URL = `http://127.0.0.1:${address.port}/gliner`;
    const health = await probeLocalEntityExtraction();
    assert.equal(health.ready, true);
    assert.equal(health.status.endpointKind, "loopback");
    assert.equal(health.status.sendsSourceTextOffDevice, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    process.env = previous;
  }
});

test("local entity extraction accepts GLiNER2 directional relations with shared exact evidence", () => {
  const relations = parseLocalRelationResponse(
    {
      relations: [{
        label: "is the literal biological or legally adopted child of",
        subject: { text: "Allie", start: 0 },
        target: { text: "Dave", start: 25 },
        score: 0.88,
      }],
    },
    {
      chunkId: "11111111-1111-4111-8111-111111111111",
      sourceId: "22222222-2222-4222-8222-222222222222",
      text: "Allie is the daughter of Dave, who raised her after the evacuation.",
    },
  );
  assert.equal(relations.length, 1);
  assert.deepEqual(relations[0] && {
    subject: relations[0].subject,
    relationType: relations[0].relationType,
    target: relations[0].target,
  }, { subject: "Allie", relationType: "child_of", target: "Dave" });
  assert.match(relations[0]?.quote ?? "", /Allie.*Dave/u);
});

test("GLiNER2 relations cannot promote pronouns or generic nouns as graph endpoints", () => {
  const relations = parseLocalRelationResponse(
    {
      relations: [
        { subject: { text: "I" }, target: { text: "Hive" }, label: "is controlled by", score: 0.99 },
        { subject: { text: "Alec" }, target: { text: "weapon" }, label: "demonstrates or possesses the power", score: 0.99 },
        { subject: { text: "Alec" }, target: { text: "Echo" }, label: "has another explicitly stated relationship to", score: 0.9 },
      ],
    },
    {
      chunkId: "11111111-1111-4111-8111-111111111111",
      sourceId: "22222222-2222-4222-8222-222222222222",
      text: "I resisted the Hive. Alec lowered the weapon while Echo spoke inside his mind.",
    },
  );
  assert.deepEqual(relations.map((relation) => [relation.subject, relation.target]), [["Alec", "Echo"]]);
});

test("local entity extraction accepts GLiNER rows with exact source evidence", () => {
  const mentions = parseLocalEntityResponse(
    {
      entities: [
        { text: "Nova Terra Defense Force", label: "named faction, alliance, army, guild, clan, or organized group", score: 0.91, start: 7 },
        { text: "Kestrel", label: "named vehicle, spacecraft, ship, or vehicle class", score: 0.78 },
        { text: "invented", label: "unknown label", score: 1 },
      ],
    },
    {
      chunkId: "11111111-1111-4111-8111-111111111111",
      sourceId: "22222222-2222-4222-8222-222222222222",
      text: "Inside Nova Terra Defense Force command, the Kestrel waited under guard.",
    },
  );
  assert.deepEqual(mentions.map(({ text, category }) => [text, category]), [
    ["Nova Terra Defense Force", "faction"],
    ["Kestrel", "vehicle"],
  ]);
  assert.ok(mentions.every((mention) => mention.quote.includes(mention.text)));
});

test("GLiNER2 combined output retains passage roles and exact-evidence story signals", () => {
  const segment = {
    chunkId: "11111111-1111-4111-8111-111111111111",
    sourceId: "22222222-2222-4222-8222-222222222222",
    text: "Allie promised Dave that she would guard Sanctuary after the evacuation.",
  };
  const payload = {
    classifications: [
      { label: "relationship statement", score: 0.91 },
      { label: "action", score: 0.82 },
    ],
    signals: [{
      signalType: "state_change",
      fields: {
        subject: [{ text: "Allie", score: 0.94, start: 0 }],
        change_type: [{ text: "promise", score: 0.89, start: -1 }],
        target: [{ text: "Dave", score: 0.88, start: 16 }],
        after: [{ text: "guard Sanctuary", score: 0.86, start: 36 }],
        hallucinated: [{ text: "Moon base", score: 0.99, start: -1 }],
      },
    }],
  };
  assert.deepEqual(
    parseLocalPassageClassifications(payload, segment).map((row) => row.label),
    ["relationship statement", "action"],
  );
  const signals = parseLocalStorySignals(payload, segment);
  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0]?.fields, {
    subject: ["Allie"],
    change_type: ["promise"],
    target: ["Dave"],
    after: ["guard Sanctuary"],
  });
  assert.match(signals[0]?.quote ?? "", /Allie.*guard Sanctuary/u);
});
