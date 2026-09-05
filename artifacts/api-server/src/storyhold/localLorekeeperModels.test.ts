import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  getLorekeeperNliStatus,
  inspectLorekeeperNliPairs,
  rerankLorekeeperRows,
} from "./localLorekeeperModels";

test("interactive NLI has a wall-clock deadline even when a local response keeps streaming", async (t) => {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  let requests = 0;
  let sentDeadline = 0;
  const server = createServer((request, response) => {
    requests += 1;
    let body = "";
    request.on("data", (part) => { body += String(part); });
    request.on("end", () => {
      sentDeadline = JSON.parse(body).deadlineUnixMs;
      response.writeHead(200, { "content-type": "application/json" });
      response.write(" ");
      const timer = setInterval(() => response.write(" "), 10);
      response.on("close", () => clearInterval(timer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.STORYHOLD_LOCAL_NLI_ENABLED = "true";
  process.env.STORYHOLD_LOCAL_NLI_URL = `http://127.0.0.1:${address.port}/nli`;
  const started = Date.now();
  const deadlineUnixMs = started + 150;
  const pairs = [{ id: "one", premise: "Mara is alive.", hypothesis: "Mara is dead." }];
  const result = await inspectLorekeeperNliPairs({ pairs, deadlineUnixMs });
  assert.equal(requests, 1);
  assert.equal(sentDeadline, deadlineUnixMs);
  assert.equal(result.receipt.status, "failed");
  assert.match(result.receipt.error!, /gameplay validation deadline/);
  assert.ok(Date.now() - started < 2_000);
  const expired = await inspectLorekeeperNliPairs({ pairs, deadlineUnixMs: Date.now() - 1 });
  assert.equal(expired.receipt.status, "failed");
  assert.equal(requests, 1);
});

test("local reranking preserves deterministic order when the specialist is disabled", async () => {
  const previousEnabled = process.env.STORYHOLD_LOCAL_RERANKER_ENABLED;
  process.env.STORYHOLD_LOCAL_RERANKER_ENABLED = "false";
  try {
    const result = await rerankLorekeeperRows({
      query: "Where is the vault?",
      rows: [
        { id: "first", text: "A broad scene." },
        { id: "second", text: "The vault is below the chapel." },
      ],
      id: (row) => row.id,
      text: (row) => row.text,
      maximumResults: 1,
    });
    assert.equal(result.receipt.status, "disabled");
    assert.deepEqual(result.rows.map((row) => row.id), ["first"]);
  } finally {
    if (previousEnabled === undefined) delete process.env.STORYHOLD_LOCAL_RERANKER_ENABLED;
    else process.env.STORYHOLD_LOCAL_RERANKER_ENABLED = previousEnabled;
  }
});

test("local NLI fails open when it is disabled", async () => {
  const previousEnabled = process.env.STORYHOLD_LOCAL_NLI_ENABLED;
  process.env.STORYHOLD_LOCAL_NLI_ENABLED = "false";
  try {
    const result = await inspectLorekeeperNliPairs({
      pairs: [{ id: "one", premise: "Mara is dead.", hypothesis: "Mara speaks." }],
    });
    assert.equal(result.receipt.status, "disabled");
    assert.deepEqual(result.results, []);
  } finally {
    if (previousEnabled === undefined) delete process.env.STORYHOLD_LOCAL_NLI_ENABLED;
    else process.env.STORYHOLD_LOCAL_NLI_ENABLED = previousEnabled;
  }
});

test("remote NLI is blocked without an explicit privacy acknowledgement", () => {
  const previous = { ...process.env };
  try {
    process.env.STORYHOLD_LOCAL_NLI_ENABLED = "true";
    process.env.STORYHOLD_LOCAL_NLI_URL = "https://nli.example.test/verify";
    delete process.env.STORYHOLD_LOCAL_NLI_ALLOW_REMOTE;
    delete process.env.STORYHOLD_LOCAL_MODELS_ALLOW_REMOTE;
    const status = getLorekeeperNliStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.configured, false);
    assert.equal(status.endpoint, null);
    assert.equal(status.sendsSourceTextOffDevice, true);
    assert.match(status.explanation, /blocked/i);
  } finally {
    process.env = previous;
  }
});

test("explicitly allowed remote NLI still requires HTTPS", () => {
  const previous = { ...process.env };
  try {
    process.env.STORYHOLD_LOCAL_NLI_ENABLED = "true";
    process.env.STORYHOLD_LOCAL_NLI_ALLOW_REMOTE = "true";
    process.env.STORYHOLD_LOCAL_NLI_URL = "http://nli.example.test/verify";
    const blocked = getLorekeeperNliStatus();
    assert.equal(blocked.configured, false);
    assert.match(blocked.explanation, /HTTPS/);
    process.env.STORYHOLD_LOCAL_NLI_URL = "https://nli.example.test/verify";
    const allowed = getLorekeeperNliStatus();
    assert.equal(allowed.enabled, true);
    assert.equal(allowed.endpointKind, "remote");
    assert.equal(allowed.sendsSourceTextOffDevice, true);
  } finally {
    process.env = previous;
  }
});

test("NLI rejects partial, duplicate, and malformed probability responses", async (t) => {
  const previous = { ...process.env };
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      results: [
        { id: "one", contradiction: 0.99, entailment: 0.5, neutral: 0 },
        { id: "one", contradiction: 0, entailment: 0, neutral: 1 },
      ],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env = previous;
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.STORYHOLD_LOCAL_NLI_ENABLED = "true";
  process.env.STORYHOLD_LOCAL_NLI_URL = `http://127.0.0.1:${address.port}/nli`;
  const result = await inspectLorekeeperNliPairs({
    pairs: [
      { id: "one", premise: "Mara is alive.", hypothesis: "Mara is dead." },
      { id: "two", premise: "Mara is alive.", hypothesis: "Mara speaks." },
    ],
  });
  assert.equal(result.receipt.status, "failed");
  assert.deepEqual(result.results, []);
  assert.match(result.receipt.error!, /invalid or mismatched/i);
});

test("MiniLM and BGE are separate sequential reranking stages", async () => {
  const previous = { ...process.env };
  const routes: string[] = [];
  const server = createServer((request, response) => {
    routes.push(request.url ?? "");
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      const payload = JSON.parse(body) as { candidates: Array<{ id: string }> };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        model: request.url?.endsWith("fast") ? "MiniLM" : "BGE",
        rankings: [...payload.candidates].reverse().map((candidate, index) => ({
          id: candidate.id,
          score: 1 - index / 10,
        })),
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    process.env.STORYHOLD_LOCAL_MINILM_ENABLED = "true";
    process.env.STORYHOLD_LOCAL_MINILM_URL = `http://127.0.0.1:${address.port}/rerank/fast`;
    process.env.STORYHOLD_LOCAL_RERANKER_ENABLED = "true";
    process.env.STORYHOLD_LOCAL_RERANKER_URL = `http://127.0.0.1:${address.port}/rerank/final`;
    const rows = [{ id: "one" }, { id: "two" }];
    const fast = await rerankLorekeeperRows({
      query: "identity",
      rows,
      id: (row) => row.id,
      text: (row) => row.id,
      stage: "minilm",
      required: true,
    });
    const final = await rerankLorekeeperRows({
      query: "identity",
      rows: fast.rows,
      id: (row) => row.id,
      text: (row) => row.id,
      stage: "bge",
      required: true,
    });
    assert.equal(fast.receipt.stage, "minilm");
    assert.equal(final.receipt.stage, "bge");
    assert.deepEqual(routes, ["/rerank/fast", "/rerank/final"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    process.env = previous;
  }
});

test("required intake reranking never silently returns the original order", async () => {
  const previous = { ...process.env };
  try {
    process.env.STORYHOLD_LOCAL_RERANKER_ENABLED = "false";
    await assert.rejects(
      rerankLorekeeperRows({
        query: "canon",
        rows: [{ id: "one" }],
        id: (row) => row.id,
        text: (row) => row.id,
        stage: "bge",
        required: true,
      }),
      /BGE is required/,
    );
  } finally {
    process.env = previous;
  }
});
