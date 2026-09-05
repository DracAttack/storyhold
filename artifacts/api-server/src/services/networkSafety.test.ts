import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateOrReservedIp } from "./networkSafety";

// Preserved from the magazine citation tests because these checks now guard
// Storyhold's user-supplied Source Vault URLs directly.
test("isPrivateOrReservedIp blocks SSRF targets and allows public IPs", () => {
  for (const ip of [
    "127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fd00::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPrivateOrReservedIp(ip), true, `expected blocked: ${ip}`);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateOrReservedIp(ip), false, `expected allowed: ${ip}`);
  }
});
