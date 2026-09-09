import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getCreditUsage, getProviderCostCsv } from "./creditUsageApi";

test("admin credit usage reads settled accounting through the private route", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const report = {
    summary: { allTimeCredits: 42, sevenDayCredits: 10, todayCredits: 3, settledRequests: 2 },
    recent: [],
    provider: {
      filters: { from: null, to: null, operation: null, operations: ["campaign_turn"] },
      summary: { allTimeCostMicros: 1234, sevenDayCostMicros: 1234, todayCostMicros: 500, unchargedCostMicros: 300, requests: 2 },
      groups: [],
      recent: [],
    },
  };
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(report));
  };
  try {
    assert.deepEqual(await getCreditUsage(), report);
    assert.equal(calls[0]?.url, "/api/storyhold/admin/credit-usage");
    assert.equal(calls[0]?.options?.credentials, "include");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin credit usage sends provider cost filters", async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl = "";
  globalThis.fetch = async (url) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({}));
  };
  try {
    await getCreditUsage({ from: "2026-09-01", to: "2026-09-08", operation: "campaign_turn" });
    assert.equal(calledUrl, "/api/storyhold/admin/credit-usage?from=2026-09-01&to=2026-09-08&operation=campaign_turn");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("credit usage remains inside operator-only admin navigation", () => {
  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  const nav = readFileSync(new URL("../pages/admin/StoryholdAdminLayout.tsx", import.meta.url), "utf8");
  const server = readFileSync(new URL("../../../api-server/src/storyhold/campaignPlay.ts", import.meta.url), "utf8");
  assert.match(app, /\/admin\/credit-usage[\s\S]*?<AdminGuard operatorOnly>/u);
  assert.match(nav, /isPremiumRecoveryOperator\(role\)[\s\S]*?\/admin\/credit-usage/u);
  assert.match(server, /\/api\/storyhold\/admin\/credit-usage[\s\S]*?Operator access is required/u);
  assert.match(server, /player_id = \$1 AND status = 'settled'/u);
  assert.match(server, /known_billable_failure/u);
  assert.match(server, /credits_charged <= 0/u);
  assert.match(server, /\/api\/storyhold\/admin\/credit-usage\/export\.csv/u);
  const page = readFileSync(new URL("../pages/admin/CreditUsage.tsx", import.meta.url), "utf8");
  assert.match(page, /const applied = report\.provider\.filters/u);
  assert.match(page, /disabled=\{loading \|\| Boolean\(error\) \|\| exporting\}/u);
  assert.match(page, /URL\.revokeObjectURL\(url\)/u);
});

test("provider cost CSV sends the same encoded filters and authenticated request", async () => {
  const originalFetch = globalThis.fetch;
  const signal = new AbortController().signal;
  let calledUrl = "";
  let calledOptions: RequestInit | undefined;
  globalThis.fetch = async (url, options) => {
    calledUrl = String(url); calledOptions = options;
    return new Response('"Provider","Model"\r\n', { headers: { "content-type": "text/csv; charset=utf-8" } });
  };
  try {
    const blob = await getProviderCostCsv({ from: "2026-09-01", to: "2026-09-08", operation: "campaign_turn&other=value" }, signal);
    assert.equal(calledUrl, "/api/storyhold/admin/credit-usage/export.csv?from=2026-09-01&to=2026-09-08&operation=campaign_turn%26other%3Dvalue");
    assert.equal(calledOptions?.credentials, "include");
    assert.equal(calledOptions?.signal, signal);
    assert.deepEqual(calledOptions?.headers, { Accept: "text/csv" });
    assert.equal(await blob.text(), '"Provider","Model"\r\n');
  } finally { globalThis.fetch = originalFetch; }
});

test("provider CSV failures and sign-in HTML are not downloaded as finance data", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [401, 403, 500]) {
      globalThis.fetch = async () => new Response("unavailable", { status });
      await assert.rejects(getProviderCostCsv(), status === 500 ? /could not be exported/u : /signed-in owner and administrators only/u);
    }
    globalThis.fetch = async () => new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } });
    await assert.rejects(getProviderCostCsv(), /export was not returned/u);
  } finally { globalThis.fetch = originalFetch; }
});
