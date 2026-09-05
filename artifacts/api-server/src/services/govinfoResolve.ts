// --- GovInfo content-URL resolver ---------------------------------------
// GovInfo feed <link>s point at the SPA "details" page
// (https://www.govinfo.gov/app/details/<PKGID>[/<GRANULEID>]), which is a
// JavaScript app shell — Readability extracts nothing from it. The actual
// document lives at a stable, predictable /content/ URL. This PURE resolver
// rewrites a details link to that content URL so the Source Vault fetches the
// real document, not an empty shell. Non-GovInfo or unrecognized URLs are
// returned unchanged (null = "no rewrite"). No network, no DB, no logger — so
// it stays unit-testable in isolation.
//
// URL shapes (verified against live GovInfo):
//   /app/details/GAOREPORTS-B-304335
//     → /content/pkg/GAOREPORTS-B-304335/pdf/GAOREPORTS-B-304335.pdf   (200 application/pdf)
//   /app/details/<PKGID>/<GRANULEID>   (granule, e.g. custom-search Federal Register items)
//     → /content/pkg/<PKGID>/html/<GRANULEID>.htm
//
// The feed guid (GovInfo package/granule ID) stays the dedupe key — only the
// FETCH target changes.

const GOVINFO_HOSTS = new Set(["www.govinfo.gov", "govinfo.gov"]);

// Known GovInfo collection-prefix → readable label prefix mapping.
// These correspond to the RSS feeds seeded in govinfo_feeds_v1.
const PKG_PREFIX_LABELS: Array<[RegExp, string]> = [
  [/^GAOREPORTS/i, "GAO Report"],
  [/^CMR/i, "Congressionally Mandated Report"],
  [/^CHRG/i, "Congressional Hearing"],
  [/^CRPT/i, "Congressional Report"],
  [/^PLAW/i, "Public Law"],
  [/^DCPD/i, "Presidential Document"],
  [/^CPRT/i, "Congressional Committee Print"],
  [/^BILLS/i, "Congressional Bill"],
  [/^CREC/i, "Congressional Record"],
  [/^STATUTE/i, "Statutes at Large"],
  [/^CFR/i, "Code of Federal Regulations"],
  [/^USCOURTS/i, "Court Filing"],
  [/^FR/i, "Federal Register"],
];

/**
 * Derive a human-readable title from a GovInfo package ID when the document's
 * actual title could not be extracted (e.g. a PDF with no readable text layer).
 * Returns a readable string like "GAO Report B-304335", or `null` when the
 * package ID doesn't match any known collection prefix.
 *
 * Examples:
 *   GAOREPORTS-B-304335     → "GAO Report B-304335"
 *   PLAW-118publ58          → "Public Law 118-publ58"
 *   CHRG-117shrg48261       → "Congressional Hearing 117-shrg48261"
 *   BILLS-118s4249is        → "Congressional Bill 118-s4249is"
 */
export function titleFromGovInfoPkgId(pkgId: string): string | null {
  if (!pkgId) return null;
  for (const [re, label] of PKG_PREFIX_LABELS) {
    if (re.test(pkgId)) {
      // Append the remainder of the ID as a human-readable qualifier.
      const suffix = pkgId.replace(re, "").replace(/^[-_]/, "").trim();
      return suffix ? `${label} ${suffix}` : label;
    }
  }
  return null;
}

/** Package IDs / granule IDs are alphanumerics, dot, underscore, hyphen. */
const ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Extract the GovInfo package ID from any stored GovInfo URL — either the
 * content-file shape (/content/pkg/<PKGID>/pdf/<PKGID>.pdf, what the Source
 * Vault stores after resolveGovInfoContentUrl rewrote the feed link) or the
 * SPA details shape (/app/details/<PKGID>[/<GRANULEID>]). Returns null for
 * non-GovInfo or unrecognized URLs. Pure — used by the one-time title
 * backfill for GovInfo docs ingested before leadSnippet fallback existed.
 */
export function pkgIdFromGovInfoUrl(link: string | null | undefined): string | null {
  if (!link) return null;
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return null;
  }
  if (!GOVINFO_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  if (segments[0] === "content" && segments[1] === "pkg" && segments[2] && ID_RE.test(segments[2])) {
    return segments[2];
  }
  if (segments[0] === "app" && segments[1] === "details" && segments[2] && ID_RE.test(segments[2])) {
    return segments[2];
  }
  return null;
}

/**
 * Rewrite a GovInfo details-page link to its underlying content-file URL.
 * Returns the new URL, or `null` when the link is not a rewritable GovInfo
 * details page (caller should then keep the original link).
 */
export function resolveGovInfoContentUrl(link: string | null | undefined): string | null {
  if (!link) return null;

  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!GOVINFO_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  // Path: /app/details/<PKGID>[/<GRANULEID>]  (ignore trailing slash / query).
  // Accept only the exact package (3 segments) or granule (4 segments) shapes;
  // anything longer is an unexpected GovInfo route we shouldn't guess a content
  // file for.
  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length !== 3 && segments.length !== 4) return null;
  if (segments[0] !== "app" || segments[1] !== "details") return null;

  const pkgId = segments[2]!;
  if (!ID_RE.test(pkgId)) return null;

  // Granule-level detail (e.g. Federal Register custom-search items).
  if (segments.length === 4) {
    const granuleId = segments[3]!;
    if (!ID_RE.test(granuleId)) return null;
    return `https://www.govinfo.gov/content/pkg/${pkgId}/html/${granuleId}.htm`;
  }

  // Package-level detail (the 7 single-document collection feeds): the whole
  // package IS the document, delivered as a PDF at a predictable path.
  return `https://www.govinfo.gov/content/pkg/${pkgId}/pdf/${pkgId}.pdf`;
}
