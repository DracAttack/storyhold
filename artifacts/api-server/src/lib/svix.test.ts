import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySvixSignature } from "./svix";

// A throwaway whsec_ secret (base64 of arbitrary bytes). Not a real credential.
const SECRET = "whsec_" + Buffer.from("svix-test-signing-key-0123456789").toString("base64");

function sign(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `v1,${sig}`;
}

function nowTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

test("verifySvixSignature: a correctly signed payload passes", () => {
  const id = "msg_123";
  const ts = nowTs();
  const body = JSON.stringify({ type: "email.bounced", data: { to: ["a@b.com"] } });
  const res = verifySvixSignature(SECRET, body, {
    id,
    timestamp: ts,
    signature: sign(SECRET, id, ts, body),
  });
  assert.equal(res.ok, true);
});

test("verifySvixSignature: a tampered body fails", () => {
  const id = "msg_123";
  const ts = nowTs();
  const body = JSON.stringify({ type: "email.bounced", data: { to: ["a@b.com"] } });
  const signature = sign(SECRET, id, ts, body);
  const res = verifySvixSignature(SECRET, body + "tampered", { id, timestamp: ts, signature });
  assert.equal(res.ok, false);
});

test("verifySvixSignature: wrong secret fails", () => {
  const id = "msg_123";
  const ts = nowTs();
  const body = "{}";
  const otherSecret = "whsec_" + Buffer.from("a-totally-different-key-9876543210").toString("base64");
  const res = verifySvixSignature(SECRET, body, {
    id,
    timestamp: ts,
    signature: sign(otherSecret, id, ts, body),
  });
  assert.equal(res.ok, false);
});

test("verifySvixSignature: an out-of-tolerance timestamp is rejected (replay guard)", () => {
  const id = "msg_123";
  const oldTs = String(Math.floor(Date.now() / 1000) - 60 * 60); // 1h old
  const body = "{}";
  const res = verifySvixSignature(SECRET, body, {
    id,
    timestamp: oldTs,
    signature: sign(SECRET, id, oldTs, body),
  });
  assert.equal(res.ok, false);
});

test("verifySvixSignature: missing headers are rejected", () => {
  const res = verifySvixSignature(SECRET, "{}", {
    id: undefined,
    timestamp: undefined,
    signature: undefined,
  });
  assert.equal(res.ok, false);
});

test("verifySvixSignature: matches one signature among several space-separated entries", () => {
  const id = "msg_123";
  const ts = nowTs();
  const body = "{}";
  const good = sign(SECRET, id, ts, body);
  const bogus = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const res = verifySvixSignature(SECRET, body, {
    id,
    timestamp: ts,
    signature: `${bogus} ${good}`,
  });
  assert.equal(res.ok, true);
});
