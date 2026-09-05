import { test } from "node:test";
import assert from "node:assert/strict";
import { simhash64, hammingDistance, isNearDuplicate, shingleContainment } from "./simhash";

const ARTICLE =
  "Scientists at the observatory announced a newly discovered exoplanet orbiting a distant star. " +
  "The planet, roughly twice the mass of Earth, sits within the habitable zone where liquid water could exist. " +
  "Researchers used the transit method to detect the faint dimming of the star's light as the planet passed in front of it. " +
  "The team plans further observations to characterize the planet's atmosphere over the coming years.";

// A near-identical reprint with a few words changed (syndication).
const REPRINT =
  "Scientists at the observatory revealed a newly discovered exoplanet orbiting a distant star. " +
  "The world, roughly twice the mass of Earth, sits within the habitable zone where liquid water might exist. " +
  "Researchers used the transit method to detect the faint dimming of the star's light as the planet passed in front of it. " +
  "The team plans further observations to characterize the planet's atmosphere over the coming years.";

const UNRELATED =
  "The city council approved a new budget for road repairs and public transit expansion next fiscal year. " +
  "Local officials say the plan will add bus routes and repave dozens of miles of aging streets across downtown.";

test("simhash64 produces a stable 16-char hex string", () => {
  const h = simhash64(ARTICLE);
  assert.equal(h.length, 16);
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(h, simhash64(ARTICLE)); // deterministic
});

test("empty / trivial text hashes to all zeros", () => {
  assert.equal(simhash64(""), "0000000000000000");
  assert.equal(simhash64("   "), "0000000000000000");
});

test("hammingDistance is zero for identical hashes", () => {
  assert.equal(hammingDistance(simhash64(ARTICLE), simhash64(ARTICLE)), 0);
});

test("near-duplicate reprint is flagged, unrelated text is not", () => {
  const a = simhash64(ARTICLE);
  const b = simhash64(REPRINT);
  const c = simhash64(UNRELATED);
  assert.ok(hammingDistance(a, b) <= 3, `reprint distance ${hammingDistance(a, b)} should be small`);
  assert.ok(isNearDuplicate(a, b));
  assert.ok(hammingDistance(a, c) > 3, `unrelated distance ${hammingDistance(a, c)} should be large`);
  assert.ok(!isNearDuplicate(a, c));
});

test("isNearDuplicate ignores zero/empty hashes", () => {
  assert.ok(!isNearDuplicate("0000000000000000", simhash64(ARTICLE)));
  assert.ok(!isNearDuplicate("", simhash64(ARTICLE)));
});

test("shingleContainment is high for a reprint", () => {
  const score = shingleContainment(ARTICLE, REPRINT);
  assert.ok(score >= 0.5, `reprint containment ${score} should be >= 0.5`);
});

test("shingleContainment is near zero for unrelated texts", () => {
  const score = shingleContainment(ARTICLE, UNRELATED);
  assert.ok(score < 0.1, `unrelated containment ${score} should be near 0`);
});

test("shingleContainment handles excerpt-in-original containment", () => {
  // An excerpt that is a verbatim prefix of the full article should score ~1
  // even though the full article is much longer (containment, not Jaccard).
  const excerpt = ARTICLE.slice(0, 180);
  const score = shingleContainment(excerpt, ARTICLE);
  assert.ok(score >= 0.9, `excerpt containment ${score} should be ~1`);
});

test("shingleContainment returns 0 for too-short or empty text", () => {
  assert.equal(shingleContainment("", ARTICLE), 0);
  assert.equal(shingleContainment("two words", ARTICLE), 0);
});
