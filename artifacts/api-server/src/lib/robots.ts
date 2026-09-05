/**
 * Builds the BrainHook robots.txt body. Kept in its own dependency-free module
 * so the crawler policy can be unit-tested without pulling in the DB/logger
 * import chain. The policy is locked in by `routes/robots.test.ts`.
 */
export function buildRobotsTxt(base: string): string {
  return `# BrainHook crawler policy
# - Search & social-preview crawlers (Googlebot, Bing, Applebot, etc.) may crawl all public content and hero images.
# - AI product crawlers (OpenAI, Anthropic, Google AI, Apple AI) are allowed so BrainHook can surface in AI-assisted discovery and citation.
# - Bulk-dataset / non-product harvesters (CCBot, Meta-ExternalAgent, Bytespider, Amazonbot) are blocked.
# - Admin pages and API JSON stay private; hero images under /api/storage/public-objects/ stay crawlable.

User-agent: CCBot
Disallow: /

User-agent: Meta-ExternalAgent
Disallow: /

User-agent: meta-externalagent
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: Amazonbot
Disallow: /

User-agent: GPTBot
Allow: /
Allow: /api/storage/public-objects/
Disallow: /admin
Disallow: /api/

User-agent: OAI-SearchBot
Allow: /
Allow: /api/storage/public-objects/
Disallow: /admin
Disallow: /api/

User-agent: ChatGPT-User
Allow: /
Allow: /api/storage/public-objects/
Disallow: /admin
Disallow: /api/

User-agent: ClaudeBot
Allow: /
Allow: /api/storage/public-objects/
Disallow: /admin
Disallow: /api/

User-agent: anthropic-ai
Allow: /
Allow: /api/storage/public-objects/
Disallow: /admin
Disallow: /api/

User-agent: Google-Extended
Allow: /
Allow: /api/storage/public-objects/
Disallow: /admin
Disallow: /api/

User-agent: Applebot-Extended
Allow: /
Allow: /api/storage/public-objects/
Disallow: /admin
Disallow: /api/

User-agent: Mediapartners-Google
Allow: /
Allow: /glossary
Allow: /glossary/
Allow: /api/storage/public-objects/
Disallow: /admin
Disallow: /api/

User-agent: *
Allow: /
Allow: /api/storage/public-objects/
Disallow: /admin
Disallow: /api/

Sitemap: ${base}/sitemap.xml
`;
}

// --- robots.txt PARSER (for respectful outbound fetching) ----------------
// Separate from buildRobotsTxt (which serves BrainHook's OWN policy). This is a
// small, pure parser used by the Source Vault to decide whether it may fetch a
// third-party URL. Pure + dependency-free so it stays unit-testable; the network
// fetch of the robots.txt body lives in sourceFetch.ts.

export interface RobotsRule {
  allow: string[];
  disallow: string[];
}

export interface ParsedRobots {
  /** Rule groups keyed by lowercased user-agent token ("*" for the wildcard). */
  groups: Map<string, RobotsRule>;
}

/**
 * Parse a robots.txt body into per-user-agent allow/disallow path prefix lists.
 * Consecutive `User-agent:` lines share the following rule block (standard
 * behavior). Comments and unknown directives are ignored. Never throws.
 */
export function parseRobotsTxt(body: string): ParsedRobots {
  const groups = new Map<string, RobotsRule>();
  let currentAgents: string[] = [];
  let expectingRules = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      // A user-agent line after rules starts a new group.
      if (expectingRules) currentAgents = [];
      expectingRules = false;
      const ua = value.toLowerCase();
      if (ua) {
        currentAgents.push(ua);
        if (!groups.has(ua)) groups.set(ua, { allow: [], disallow: [] });
      }
    } else if (field === "allow" || field === "disallow") {
      expectingRules = true;
      if (currentAgents.length === 0) continue;
      for (const ua of currentAgents) {
        const rule = groups.get(ua)!;
        // An empty Disallow means "allow everything" — skip adding a prefix.
        if (value !== "") rule[field].push(value);
      }
    }
  }

  return { groups };
}

/** Pick the rule group for `userAgent`, falling back to the "*" wildcard. */
function selectGroup(parsed: ParsedRobots, userAgent: string): RobotsRule | null {
  const ua = userAgent.toLowerCase();
  for (const [token, rule] of parsed.groups) {
    if (token !== "*" && ua.includes(token)) return rule;
  }
  return parsed.groups.get("*") ?? null;
}

/**
 * Whether `path` is allowed for `userAgent` per the parsed robots.txt. Uses the
 * standard longest-match-wins rule between Allow and Disallow prefixes; ties go
 * to Allow. With no matching group (or no rules), fetching is allowed.
 */
export function isPathAllowed(parsed: ParsedRobots, path: string, userAgent = "*"): boolean {
  const group = selectGroup(parsed, userAgent);
  if (!group) return true;

  const p = path || "/";
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const rule of group.allow) if (p.startsWith(rule) && rule.length > bestAllow) bestAllow = rule.length;
  for (const rule of group.disallow)
    if (p.startsWith(rule) && rule.length > bestDisallow) bestDisallow = rule.length;

  if (bestDisallow === -1) return true;
  return bestAllow >= bestDisallow;
}
