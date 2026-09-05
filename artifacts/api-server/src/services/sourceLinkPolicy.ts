import type { SourceLinkInsertionMode } from "@workspace/db";

/**
 * Pure source-link insertion policy (Task #226, updated), factored out of
 * `articles.ts` so it can be unit-tested without pulling in the logger / DB /
 * API clients. This is the SINGLE source of truth for the dev money guard and
 * the per-mode Sonar gap-fill flag — `articles.ts` composes these; nothing
 * here does any I/O.
 *
 * "Sonar gap-fill" means a single Perplexity Sonar call that fires when the
 * candidate pool is thin after vault/packet/catalog gather. Citation URLs come
 * EXCLUSIVELY from Sonar's top-level `citations` field (never model prose) and
 * are enqueued into Source Vault for background ingestion. The citation-picking
 * model itself NEVER gets a web search tool — it may only cite URLs from the
 * pre-built vetted pool.
 *
 * `maxSearchQueriesFor` now returns 0 (Sonar off) or 1 (run one Sonar call);
 * callers check `> 0` to decide whether the gap-fill step runs.
 */

/**
 * Dev money guard. In a non-production environment any Sonar-capable mode
 * (`vault_first_with_capped_search` / `legacy_web_search`) is downgraded to
 * `vault_only` so dev cron / pipeline runs never spend on paid Sonar gap-fill
 * calls — unless the operator explicitly opts in via
 * `ALLOW_DEV_SOURCE_LINK_WEB_SEARCH`. Prod is never downgraded, and modes
 * that already skip gap-fill (`off` / `vault_only`) pass through unchanged.
 */
export function applyDevSourceLinkGuard(
  mode: SourceLinkInsertionMode,
  opts: { isProd: boolean; devWebSearchAllowed: boolean },
): SourceLinkInsertionMode {
  if (opts.isProd || opts.devWebSearchAllowed) return mode;
  if (mode === "vault_first_with_capped_search" || mode === "legacy_web_search") {
    return "vault_only";
  }
  return mode;
}

/**
 * Returns 0 (Sonar gap-fill disabled) or 1 (run one Sonar call) for a given
 * mode. Packet-backed articles never gap-fill (the evidence packet already
 * carries vetted sources); `vault_only` / `off` always skip; both
 * `vault_first_with_capped_search` and `legacy_web_search` allow one Sonar
 * call when there is no packet to lean on.
 *
 * Callers check `> 0` to decide whether the Sonar pre-step runs; the return
 * value is NOT a query count (there is always exactly one Sonar call).
 */
export function maxSearchQueriesFor(mode: SourceLinkInsertionMode, packetBacked: boolean): number {
  switch (mode) {
    case "off":
    case "vault_only":
      return 0;
    case "legacy_web_search":
      return packetBacked ? 0 : 1;
    case "vault_first_with_capped_search":
      return packetBacked ? 0 : 1;
    default:
      return 0;
  }
}

/**
 * Whether the `ALLOW_DEV_SOURCE_LINK_WEB_SEARCH` opt-in env var is truthy.
 * Accepts `"1"` or `"true"` (case-insensitive).
 */
export function devSourceLinkWebSearchAllowed(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true";
}
