// Pure text helpers for the post-draft evidence verifier. Kept logger-free and
// dependency-free in their own module so both editorialScreen.ts (which strips
// the draft body before checking) and llm.ts (which filters the verifier's
// findings) can share them without an import cycle, and so tests can exercise
// them directly.

// Internal cross-links to our own articles ([anchor](/article/slug)) are site
// navigation, not source citations — the verifier was flagging them as
// "invented sources" and quarantining clean drafts. Strip them down to their
// anchor text before the draft is sent for checking so the verifier never sees
// them. Handles the optional markdown title segment ((/article/slug "title")).
export function stripInternalArticleLinks(text: string): string {
  return text.replace(/\[([^\]]*)\]\(\/article\/[^)]*\)/g, "$1");
}

// Matches OUR internal-article link forms only: a root-relative /article/...
// (at start of text, or preceded by whitespace, a quote, or an opening paren —
// i.e. markdown "](/article/..." or the verifier's "Internal link to
// '/article/...'"), or an absolute link on our own domain. Deliberately does
// NOT match arbitrary external URLs that happen to contain "/article/" in
// their path (e.g. example.com/article/123) — those are real sourcing claims
// the verifier must keep.
const INTERNAL_LINK_RE = /(^|[\s'"“”‘’(])\/article\/|\bbrainhook\.net\/article\//i;

// True when a verifier finding is really about an internal cross-link rather
// than a genuine sourcing problem. Safety net behind the prompt-level ban.
export function isInternalLinkFinding(f: { claim: string; detail: string }): boolean {
  return (
    INTERNAL_LINK_RE.test(f.claim) ||
    INTERNAL_LINK_RE.test(f.detail) ||
    /internal (article )?link/i.test(f.claim)
  );
}
