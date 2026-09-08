import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getCreditUsage } from "./creditUsageApi";

test("admin credit usage reads settled accounting through the private route", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const report = {
    summary: { allTimeCredits: 42, sevenDayCredits: 10, todayCredits: 3, allTimeCostMicros: 1234, settledRequests: 2 },
    recent: [],
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

test("credit usage remains inside operator-only admin navigation", () => {
  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  const nav = readFileSync(new URL("../pages/admin/StoryholdAdminLayout.tsx", import.meta.url), "utf8");
  const server = readFileSync(new URL("../../../api-server/src/storyhold/campaignPlay.ts", import.meta.url), "utf8");
  assert.match(app, /\/admin\/credit-usage[\s\S]*?<AdminGuard operatorOnly>/u);
  assert.match(nav, /isPremiumRecoveryOperator\(role\)[\s\S]*?\/admin\/credit-usage/u);
  assert.match(server, /\/api\/storyhold\/admin\/credit-usage[\s\S]*?Operator access is required/u);
  assert.match(server, /player_id = \$1 AND status = 'settled'/u);
});