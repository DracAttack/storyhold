import { createHash } from "node:crypto";

/**
 * Replace a raw email address with the first 8 hex characters of its
 * lower-case SHA-256 digest, e.g. `"ab12cd34"`.
 *
 * This is enough to correlate related log events (same address → same hash)
 * without retaining the address itself in log lines, which matters when logs
 * are forwarded to external processors or stored long-term.
 *
 * Never use this to compare or authenticate — it is a log-correlation token
 * only, not a cryptographic secret.
 */
export function hashEmail(email: string): string {
  return createHash("sha256")
    .update(email.toLowerCase().trim())
    .digest("hex")
    .slice(0, 8);
}
