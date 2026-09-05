import { createHmac, timingSafeEqual } from "node:crypto";

// How far the webhook timestamp may drift from "now" before we reject it as a
// possible replay. Matches the Svix library default (5 minutes either side).
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

export type SvixVerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify a Svix-signed webhook (Resend signs its webhooks with Svix). This
 * mirrors the official `svix` library's verification scheme so we don't need to
 * pull in the dependency:
 *
 *  - the secret is `whsec_<base64>`; the base64 part decodes to the HMAC key bytes
 *  - the signed content is `${svix-id}.${svix-timestamp}.${rawBody}`
 *  - HMAC-SHA256(key, signedContent) base64-encoded is the expected `v1` signature
 *  - the `svix-signature` header is a space-delimited list of `v<ver>,<sig>`
 *    entries; a constant-time match on ANY `v1` entry passes
 *  - the timestamp must be within +/-5 min of now to blunt replay attacks
 *
 * `rawBody` MUST be the exact bytes received — mount the webhook route with
 * `express.raw()` so the body is not re-serialized by `express.json()` (a
 * re-serialized body produces a different signature and always fails).
 */
export function verifySvixSignature(
  secret: string,
  rawBody: Buffer | string,
  headers: SvixHeaders,
): SvixVerifyResult {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) {
    return { ok: false, reason: "missing_headers" };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad_timestamp" };
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }

  // The `whsec_` prefix is conventional; tolerate a secret pasted without it.
  const secretKey = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const key = Buffer.from(secretKey, "base64");
  if (key.length === 0) return { ok: false, reason: "bad_secret" };

  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const signedContent = `${id}.${timestamp}.${body}`;
  const expected = createHmac("sha256", key).update(signedContent).digest("base64");
  const expectedBuf = Buffer.from(expected);

  // Header is a space-separated list of "v1,<sig>" (a key may have multiple
  // signatures during rotation). Accept a match on any v1 entry.
  for (const part of signature.split(" ")) {
    const comma = part.indexOf(",");
    if (comma === -1) continue;
    if (part.slice(0, comma) !== "v1") continue;
    const sigBuf = Buffer.from(part.slice(comma + 1));
    if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "no_match" };
}
