import type { DraftResearchMode } from "@workspace/db";

/**
 * Pure draft-research policy (Task #233), factored out of `articles.ts` so it
 * can be unit-tested without pulling in the logger / DB / Anthropic client. This
 * is the SINGLE source of truth for the dev money guard and the per-mode
 * draft-time web-search cap — `articles.ts` composes these; nothing here does
 * any I/O.
 *
 * The whole point of the task: EVERY draft is grounded on an evidence packet
 * built from the Source Vault. `vault_required` and
 * `vault_first_harvest_if_needed` never let the drafter web-search. Only the
 * emergency `legacy_web_search` override falls back to the old
 * web-search-grounded draft path for a non-packet idea.
 */

/**
 * Dev money guard. In a non-production environment the only web-search-capable
 * mode (`legacy_web_search`) is downgraded to `vault_required` so dev cron /
 * pipeline runs never spend on paid draft-time web search — unless the operator
 * explicitly opts in via `ALLOW_DEV_DRAFT_WEB_SEARCH`. Prod is never downgraded,
 * and the vault-only modes pass through unchanged.
 */
export function applyDevDraftResearchGuard(
  mode: DraftResearchMode,
  opts: { isProd: boolean; devWebSearchAllowed: boolean },
): DraftResearchMode {
  if (opts.isProd || opts.devWebSearchAllowed) return mode;
  if (mode === "legacy_web_search") return "vault_required";
  return mode;
}

/**
 * Hard cap on draft-time server-side web_search calls for a given mode. A
 * packet-backed draft NEVER web-searches — the evidence packet already carries
 * vetted sources, which is the entire point of the vault-first pipeline. The
 * vault modes therefore always return 0. Only `legacy_web_search` (emergency
 * override) with NO packet reproduces the original cap of 3.
 */
export function maxDraftWebSearchesFor(mode: DraftResearchMode, packetBacked: boolean): number {
  if (packetBacked) return 0;
  switch (mode) {
    case "vault_required":
    case "vault_first_harvest_if_needed":
      return 0;
    case "legacy_web_search":
      return 3;
    default:
      return 0;
  }
}

/**
 * Whether a controlled Source Harvest should run before holding an idea when the
 * vault is too weak to build a packet. Only `vault_first_harvest_if_needed` opts
 * into the harvest; `vault_required` holds immediately and `legacy_web_search`
 * never reaches the hold path (it drafts via web search instead).
 */
export function shouldHarvestBeforeHold(mode: DraftResearchMode): boolean {
  return mode === "vault_first_harvest_if_needed";
}

/**
 * Whether the `ALLOW_DEV_DRAFT_WEB_SEARCH` opt-in env var is truthy. Accepts
 * `"1"` or `"true"` (case-insensitive).
 */
export function devDraftWebSearchAllowed(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true";
}
