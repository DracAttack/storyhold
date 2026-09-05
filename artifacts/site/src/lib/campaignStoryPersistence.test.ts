import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Story Studio restores paid work from the server without storing private input in the browser", () => {
  const page = readFileSync(
    new URL("../pages/campaign-story.tsx", import.meta.url),
    "utf8",
  );
  const api = readFileSync(new URL("./storyholdApi.ts", import.meta.url), "utf8");

  assert.match(api, /pendingAdaptation:\s*CampaignStoryPendingAdaptation\s*\|\s*null/u);
  assert.match(page, /const saved = response\.pendingAdaptation/u);
  assert.match(page, /requestId:\s*saved\.requestId/u);
  assert.match(page, /setSelectedIds\(saved\.turnIds\)/u);

  const pendingIdentity = page.match(
    /type PendingStoryGeneration = \{([\s\S]*?)\n\};/u,
  )?.[1] ?? "";
  assert.match(pendingIdentity, /requestId:\s*string/u);
  assert.match(pendingIdentity, /fingerprint:\s*string/u);
  assert.doesNotMatch(pendingIdentity, /turnIds|title|voiceNotes|settings/u);
});
