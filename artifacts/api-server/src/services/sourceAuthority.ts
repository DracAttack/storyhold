import type { SourceAuthorityTier, TrendMarkerPlatform } from "@workspace/db";

// --- Source-authority classifier -----------------------------------------
// Maps a source URL/domain to an authority tier. Pure and network-free so it
// stays unit-testable. Admin overrides always win (authority_source = 'manual').
//
// Tier ladder (strong → weak):
//   primary   — original research, government/court records, official standards
//   firsthand — company/institution newsrooms and press-release wires (direct
//               from the subject: the source IS the story)
//   wire      — syndicated news agencies (AP, Reuters, AFP, Bloomberg…)
//   reported  — established secondary journalism (BBC, NPR, NYT, WaPo, CNN…)
//   commentary — opinion, analysis, self-publishing platforms
//   social    — social media platforms
//   aggregator — link farms, scrapers, press-release aggregators, redirect hubs
//   reference — tertiary / background-only sources (Wikipedia, encyclopedias)
//               good for context, never citable as evidence
//   unknown   — honest default when no rule matches

export interface AuthorityClassification {
  tier: SourceAuthorityTier;
  reason: string;
}

/** Normalize a URL or bare host to a lowercase hostname (no www.). */
function normalizeHost(input: string): string {
  let host = input.trim().toLowerCase();
  try {
    if (host.includes("://")) host = new URL(host).hostname;
    else if (host.includes("/")) host = new URL("http://" + host).hostname;
  } catch {
    // fall through with the raw string
  }
  return host.replace(/^www\./, "");
}

/** True when `host` equals `suffix` or is a subdomain of it. */
function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith("." + suffix);
}

/** True when the host ends in any of the given TLD/suffix fragments. */
function endsWithAny(host: string, suffixes: string[]): boolean {
  return suffixes.some((s) => host === s || host.endsWith(s));
}

// ---------------------------------------------------------------------------
// Wire services / news agencies — pure syndicated copy.
// Note: press-release distributors (PRNewswire, BusinessWire…) belong in
// FIRSTHAND_HOSTS because they publish content on behalf of the subject, not
// their own reporting.
// ---------------------------------------------------------------------------
const WIRE = [
  "apnews.com",
  "ap.org",
  "reuters.com",     // robots often block fetch — metadata-only rows are fine
  "afp.com",
  "upi.com",
  "bloomberg.com",
  "efe.com",
  "ansa.it",
  "dpa.com",
  "pa.media",
  "aap.com.au",
  "thecanadianpressnews.ca",
  "kyodonews.net",
  "yna.co.kr",
  "ptinews.com",
  "aa.com.tr",
  "tass.com",
  "xinhuanet.com",
];

// ---------------------------------------------------------------------------
// Reported journalism — established outlets doing secondary/reported journalism.
// These are NOT wire agencies and NOT primary sources, but are trusted enough
// to corroborate a story. NYT opinion/WSJ opinion/etc. are handled separately
// by path-based commentary rules below.
// ---------------------------------------------------------------------------
const REPORTED = [
  // US broadcast & national news
  "abcnews.go.com",
  "cbsnews.com",
  "nbcnews.com",
  "cnn.com",
  "foxnews.com",
  "pbs.org",
  "npr.org",
  "usatoday.com",
  "time.com",
  "cnbc.com",
  // US newspapers & magazines
  "nytimes.com",
  "washingtonpost.com",
  "wsj.com",
  "latimes.com",
  "sfchronicle.com",
  "bostonglobe.com",
  "theatlantic.com",
  "newsweek.com",
  "thedailybeast.com",
  "businessinsider.com",
  "fortune.com",
  "slate.com",         // primarily reported; opinion section handled by path
  "statesman.com",
  "harvardmagazine.com",
  "reason.com",        // libertarian magazine — reported by default; /volokh/ blog is commentary (path rule)
  // Investigative / public-interest
  "propublica.org",
  "theintercept.com",
  "publicintegrity.org",
  "thetexastribune.org",
  "motherjones.com",
  "democracynow.org",
  // Politics & policy
  "politico.com",
  "politifact.com",   // fact-check articles; /factchecks/list index pages → aggregator (path rule)
  "defensescoop.com", // defense-tech trade press
  "thehill.com",
  "rollcall.com",
  "apolitical.co",
  "scotusblog.com",
  "vox.com",
  "axios.com",
  // International
  "bbc.com",
  "bbc.co.uk",
  "bbc.co",           // catch bbc.co.* subdomains
  "theguardian.com",
  "aljazeera.com",
  "independent.co.uk",
  "telegraph.co.uk",
  "thetimes.co.uk",
  "ft.com",
  "economist.com",
  "foreignpolicy.com",
  "foreignaffairs.com",
  // UK tabloids / mid-market (reported per user classification)
  "dailymail.co.uk",
  "dailymail.com",
  // Tech & science journalism
  "theverge.com",
  "technologyreview.com", // MIT Technology Review; /feed + /the-download → aggregator (path rules)
  "spacenews.com",
  "wired.com",
  "arstechnica.com",
  "techcrunch.com",
  "engadget.com",
  "newscientist.com",
  "scientificamerican.com",
  "popularmechanics.com",
  "livescience.com",
  "space.com",
  "skyandtelescope.org",
  "spectrum.ieee.org",  // IEEE Spectrum (journalism arm; not research like ieee.org)
  "statnews.com",
  // Culture / environment / specialty
  "nationalgeographic.com",
  "smithsonianmag.com",
  "grist.org",
  "hyperallergic.com",
  "snexplores.org",
  "vice.com",
  "wweek.com",
  // Health journalism
  "medicalnewstoday.com",
  "hcplive.com",          // clinical/HCP trade journalism
  // Local / alt-weekly / community news
  "indyweek.com",         // NC alt-weekly (Indy Week)
  "seattlemedium.com",    // Seattle community newspaper (Black press)
  "southblueprint.com",
  "wral.com",             // Raleigh NC broadcast news
];

// ---------------------------------------------------------------------------
// Social platforms — weak public-interest signals only; never evidence.
// ---------------------------------------------------------------------------
const SOCIAL = [
  "twitter.com",
  "x.com",
  "facebook.com",
  "fb.com",
  "instagram.com",
  "threads.net",
  "reddit.com",
  "redd.it",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "linkedin.com",
  "mastodon.social",
  "mstdn.social",
  "counter.social",
  "bsky.app",
  "t.me",
  "telegram.me",
  "snapchat.com",
  "tumblr.com",
  "pinterest.com",
  "truthsocial.com",
  "gettr.com",
  "gab.com",
  "scribd.com",   // user-uploaded document sharing — never evidence
];

// ---------------------------------------------------------------------------
// Commentary / opinion / self-publishing platforms.
// Major outlets' opinion SECTIONS are handled by path-based rules below.
// ---------------------------------------------------------------------------
const COMMENTARY_PLATFORMS = [
  "medium.com",
  "substack.com",
  "wordpress.com",
  "blogspot.com",
  "ghost.io",
  "wixsite.com",
  "svbtle.com",
  "jacobin.com",
  "nationalreview.com",
  "thebulwark.com",
  "thedispatch.com",
  "dailykos.com",
  "crooksandliars.com",
  "mediaite.com",
  "salon.com",
  "thefederalist.com",
  "breitbart.com",
  "dailywire.com",
  "theblaze.com",
  "truthout.org",
  "wsws.org",             // advocacy framing (user manual fix)
  "counterpunch.org",
  // Think tanks / advocacy publishers whose output is analysis & opinion
  "aei.org",              // American Enterprise Institute — user reclassified firsthand → commentary
  "alec.org",             // American Legislative Exchange Council
  "thenation.com",        // user reclassified reported → commentary
  "theconversation.com",  // academic op-ed platform
  "psychologytoday.com",  // practitioner blog network
  "washingtontimes.com",
  "channeldraw.org",      // low-authority blog (user manual fix)
  "sonsoflibertymedia.com", // partisan framing (user manual fix)
  "struggle-la-lucha.org",
];

// ---------------------------------------------------------------------------
// Aggregators — link farms, scrapers, redirect hubs, and press-release
// aggregators (sites that re-package research news from universities).
// ---------------------------------------------------------------------------
const AGGREGATORS = [
  "news.google.com",
  "news.yahoo.com",
  "flipboard.com",
  "smartnews.com",
  "msn.com",
  "buzzfeed.com",
  "upworthy.com",
  "outbrain.com",
  "taboola.com",
  "apple.news",
  "newsbreak.com",
  "ground.news",
  "allsides.com",
  "feedly.com",
  "drudgereport.com",
  "fark.com",
  "upday.com",
  "inkl.com",            // also covers preview.inkl.com (subdomain match)
  "dailyentertainmentworld.com",
  "music.amazon.com",    // catalog/product pages — metadata only, never evidence
  "trendhunter.com",
  // Academic-paper index/search portals (link to papers; not the papers themselves)
  "researchgate.net",
  "scispace.com",
  "semanticscholar.org",
  "academia.edu",        // researcher self-upload platform — copies, not canonical publications
  "jstor.org",           // digitised journal archive — intermediary, not the original journal
  "statista.com",        // stats aggregation portal (paywalled summaries of others' data)
  // Science/research press-release aggregators (not the original papers)
  "sciencedaily.com",
  "phys.org",
  "medicalxpress.com",
  "techxplore.com",
  "neurosciencenews.com",
  "eurekalert.org",
  "alphagalileo.org",
  "earth.com",
  "futurity.org",
];

// ---------------------------------------------------------------------------
// Citation intermediary domains — academic-paper aggregators that host copies
// of papers rather than the original publications. These rows are suppressed
// from the public References list so readers see the original journal. Keep
// this list narrow: only well-known domains where the URL definitely points to
// a copy, not the original. Cross-referenced with the broader AGGREGATOR_HOSTS
// list above, which drives the authority tier classifier.
// ---------------------------------------------------------------------------
export const CITATION_INTERMEDIARY_DOMAINS = new Set([
  "scispace.com",        // copies full paper metadata + abstract from journals
  "researchgate.net",    // mirrors papers, bot-walls scrapers
  "semanticscholar.org", // AI-powered aggregation of academic papers
  "academia.edu",        // researcher self-upload platform — copies, not canonical publications
  "jstor.org",           // digitised journal archive — intermediary, not the original journal
  "statista.com",        // paywalled re-packaged stats from third-party sources
]);

/**
 * True when the URL's host matches a known citation-intermediary aggregator.
 * Used to set `is_intermediary` on `article_sources` rows so the public
 * References list can suppress them in favour of the original journal link.
 */
export function isCitationIntermediaryUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    for (const domain of CITATION_INTERMEDIARY_DOMAINS) {
      if (host === domain || host.endsWith("." + domain)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Primary sources — research repositories, journals, official records, courts.
// ---------------------------------------------------------------------------
const PRIMARY_HOSTS = [
  // Preprint servers / repositories
  "arxiv.org",
  "biorxiv.org",
  "medrxiv.org",
  "ssrn.com",
  "doi.org",
  // Academic journals & publishers
  "nature.com",
  "science.org",
  "sciencedirect.com",
  "springer.com",
  "wiley.com",
  "cell.com",
  "thelancet.com",
  "nejm.org",
  "pnas.org",
  "journals.plos.org",
  "plos.org",
  "jamanetwork.com",
  "bmj.com",
  "frontiersin.org",
  "mdpi.com",
  "aanda.org",          // Astronomy & Astrophysics journal
  "journals.ametsoc.org", // American Meteorological Society journals
  "journals.sagepub.com", // SAGE journals
  "jneurosci.org",      // Journal of Neuroscience
  "microbiologyresearch.org",
  "neurology.org",
  "policyreview.info",  // Internet Policy Review journal
  "psychiatryonline.org",
  "tandfonline.com",    // Taylor & Francis journals
  "ieee.org",
  "acm.org",
  "acs.org",
  "aip.org",
  "iopscience.iop.org",
  "academic.oup.com",   // Oxford Academic journals
  // Psychology journals (journals subdomain is primary; root domain is firsthand)
  "journals.psychologicalscience.org",
  // Biomedical databases
  "pubmed.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
  // Research institutes publishing original data
  "pewresearch.org",    // Pew Research Center — original surveys + reports
  "aaas.org",           // American Association for the Advancement of Science
  "nber.org",           // National Bureau of Economic Research — working papers
  "usafacts.org",       // civic-data nonprofit — original statistical analysis
  "vin.com",            // Veterinary Information Network — professional proceedings
  // Non-US government agencies (not covered by the .gov TLD rule)
  "dwd.de",             // Deutscher Wetterdienst — German national weather agency
  // International bodies
  "who.int",
  "un.org",
  "europa.eu",
  // US courts / legal documents
  "supremecourt.gov",
  "law.justia.com",
  "courtlistener.com",
  "oyez.org",
  // Financial / regulatory
  "sec.gov",
];

// ---------------------------------------------------------------------------
// Firsthand sources — direct from the subject.
// Includes: company/institution newsrooms, official org blogs, and press-
// release distribution wires (PRNewswire, BusinessWire…). These are "firsthand"
// because the originating organization controls the content.
// ---------------------------------------------------------------------------
const FIRSTHAND_HOSTS = [
  // Press-release distribution wires
  "prnewswire.com",
  "businesswire.com",
  "globenewswire.com",
  "newsfilecorp.com",
  "accesswire.com",
  "einpresswire.com",
  // Major tech/company newsrooms (whole domain = official comms)
  "aboutamazon.com",
  "about.fb.com",
  "anthropic.com",
  "openai.com",
  "spacex.com",
  "tesla.com",
  "newsroom.spotify.com",
  "newsroom.ibm.com",
  // Official org & advocacy sites (they originate their own authoritative content)
  "redcross.org",
  "amnesty.org",
  "hrw.org",
  "worldbank.org",
  "imf.org",
  "oecd.org",
  "wto.org",
  "nato.int",
  "aclu.org",             // American Civil Liberties Union — advocacy + legal
  "eff.org",              // Electronic Frontier Foundation — digital-rights advocacy
  "pen.org",              // PEN America — free expression org
  "transparency.org",     // Transparency International — anti-corruption NGO
  "americanprogress.org", // Center for American Progress — progressive think tank
  "cato.org",             // Cato Institute — libertarian think tank
  "ilo.org",              // International Labour Organization — official reports
  "equidem.org",          // labor-rights org — firsthand reports
  "ibanet.org",           // International Bar Association
  "ifstudies.org",        // Institute for Family Studies — think tank reports
  "algop.org",            // Alabama GOP — party source: partisan claims, not neutral evidence
  "whitehousehistory.org",// White House Historical Association
  "lsst.org",             // Vera Rubin Observatory / LSST project — institutional statements
  "maapprogram.org",      // MAAP climate/environment research project
  // Company / commercial sources (the source IS the subject)
  "jpmorganchase.com",    // JPMorgan Chase institute reports
  "stories.td.com",       // TD Bank survey releases
  "springhealth.com",     // mental-health company reports
  "rula.com",             // mental-health company reports
  "gottman.com",          // Gottman Institute — relationship-psychology explainer
  "amfmtreatment.com",    // treatment provider — commercial health explainer
  "medshadow.org",        // medication-safety advocacy explainers
  "drugs.com",            // commercial drug database/reference
  "skincarenetwork.co.uk",// commercial dermatology explainers
  "xometry.com",          // commercial manufacturing explainers
  "shortyawards.com",     // awards body — institutional profiles
  // Professional associations (originate authoritative research digests & position statements)
  "psychologicalscience.org", // Association for Psychological Science
];

// ---------------------------------------------------------------------------
// Reported-journalism subdomains of primary-tier parent domains.
// These MUST be checked BEFORE PRIMARY_HOSTS to avoid the parent-domain catch.
// e.g. spectrum.ieee.org is a tech journalism magazine, not an IEEE research
// paper — but ieee.org is in PRIMARY_HOSTS and would swallow it otherwise.
// ---------------------------------------------------------------------------
const REPORTED_SUBDOMAINS = [
  "spectrum.ieee.org",  // IEEE Spectrum — technology journalism arm of ieee.org
];

// ---------------------------------------------------------------------------
// Firsthand subdomain prefixes — e.g. "news.mit.edu" is firsthand even though
// "mit.edu" is primary (the broader academic institution). These match against
// the host BEFORE stripping the TLD to avoid catching unrelated subdomains.
// ---------------------------------------------------------------------------
const FIRSTHAND_SUBDOMAINS = [
  // University/lab newsrooms
  "news.mit.edu",
  "news.harvard.edu",
  "news.stanford.edu",
  "news.berkeley.edu",
  "newsroom.ucla.edu",
  // NOTE: jpl.nasa.gov intentionally NOT here — user classified it primary
  // (official NASA lab record), so the .gov TLD rule stamps it primary.
  // Major tech company newsrooms on the main domain
  "blog.google",
  "blog.cloudflare.com",
  "deepmind.google",
  "newsroom.microsoft.com",
  "apple.com/newsroom",  // path-prefix; handled separately below
];

// ---------------------------------------------------------------------------
// Review-article title signals — phrases that indicate a document synthesises
// existing literature rather than reporting original experimental data. When a
// primary-tier domain hosts a document whose title contains any of these
// signals, the tier is downgraded to `reported`.
// ---------------------------------------------------------------------------
const REVIEW_TITLE_RE =
  /\b(systematic\s+review|meta[- ]analysis|a\s+review\s+of|literature\s+review|scoping\s+review|narrative\s+review|cochrane\s+review|integrative\s+review)\b/i;

/**
 * Returns true when a document title and/or excerpt/abstract signals a review
 * article — one that synthesises prior literature rather than producing new
 * experimental data. Used to downgrade primary-tier docs to `reported`.
 * Checks title first, then falls back to the first 500 characters of excerpt
 * (enough to cover a typical abstract). Pure and network-free.
 */
export function isReviewArticleTitle(title: string, excerpt?: string | null): boolean {
  if (REVIEW_TITLE_RE.test(title)) return true;
  if (excerpt) return REVIEW_TITLE_RE.test(excerpt.slice(0, 500));
  return false;
}

// ---------------------------------------------------------------------------
// Reference-only sources — encyclopedias, fact-reference wikis, historical
// background databases. Good for context; not citable as evidence.
// ---------------------------------------------------------------------------
const REFERENCE_HOSTS = [
  "wikipedia.org",      // all language subdomains (en., fr., …)
  "wikimedia.org",      // Wikimedia commons / meta
  "wikidata.org",
  "millercenter.org",   // University of Virginia presidential history reference
  "britannica.com",     // Encyclopædia Britannica
  "encyclopedia.com",
  "archive.org",        // Internet Archive — background/historical snapshots
  "ebsco.com",          // research-database vendor reference pages
  "simplypsychology.org", // psychology study guides / tertiary explainer
  "historysnob.com",
  "artificialintelligenceact.eu", // EU AI Act explainer/reference site
  "scetv.org",          // SC public media — show/reference pages
  "pbssocal.org",       // local public media — show pages, metadata-heavy (user pathOverrides default)
  // Book publishers — catalog/marketing pages, background only
  "routledge.com",
  "hachettebookgroup.com",
  "simonandschuster.com",
  "packmojo.com",       // commercial how-to reference
];

// ---------------------------------------------------------------------------
// Reference-only .gov subdomains — research-guide portals rather than official
// records. Checked BEFORE the blanket .gov→primary TLD rule.
// ---------------------------------------------------------------------------
const REFERENCE_GOV_SUBDOMAINS = [
  "guides.loc.gov",     // Library of Congress research guides (background only)
];

// ---------------------------------------------------------------------------
// Path-based primary overrides — URLs whose host classifies as firsthand but
// a specific path signals a peer-reviewed journal or official data release.
// Checked BEFORE host lists so the subdomain classification is correct.
// ---------------------------------------------------------------------------
const PRIMARY_PATHS: Array<{ host: string; pathPrefix: string }> = [
  { host: "psychologicalscience.org", pathPrefix: "/journals" },
  { host: "psychologicalscience.org", pathPrefix: "/publications" },
];

// ---------------------------------------------------------------------------
// Path-based reported overrides — sections of firsthand/primary domains that
// publish magazine-style journalism rather than authoritative institutional
// content (e.g. an association's trade magazine).
// ---------------------------------------------------------------------------
const REPORTED_PATHS: Array<{ host: string; pathPrefix: string }> = [
  { host: "psychologicalscience.org", pathPrefix: "/observer" }, // APS Observer magazine
  { host: "pbs.org", pathPrefix: "/weta/washingtonweek/article" }, // Washington Week reported articles
];

// ---------------------------------------------------------------------------
// Path-based reference overrides — show/video landing pages of otherwise-
// reported public-media hosts. Metadata-rich but not reported journalism.
// ---------------------------------------------------------------------------
const REFERENCE_PATHS: Array<{ host: string; pathPrefix: string }> = [
  { host: "pbs.org", pathPrefix: "/show/" },  // show landing pages (metadata only)
  { host: "pbs.org", pathPrefix: "/video/" }, // video pages (transcript at best)
];

// ---------------------------------------------------------------------------
// Path-based aggregator overrides — index/listing sections of otherwise-useful
// hosts. Checked before domain rules AND before the generic index-path rule so
// host-specific decisions stay explicit.
// ---------------------------------------------------------------------------
const AGGREGATOR_PATHS: Array<{ host: string; pathPrefix: string }> = [
  { host: "en.wikipedia.org", pathPrefix: "/wiki/category:" }, // category index pages
  { host: "politifact.com", pathPrefix: "/factchecks/list" },  // fact-check list/index pages
  { host: "technologyreview.com", pathPrefix: "/the-download" }, // newsletter roundup (source lead only)
];

// Generic index/listing path segments — category hubs, tag pages, search
// results, RSS feeds, podcast/show landing pages. These are navigation, not
// articles: classify as aggregator (never evidence) regardless of host. Runs
// AFTER the host-specific path overrides above so explicit decisions win.
const INDEX_PATH_SEGMENT_RE =
  /(^|\/)(category|tags?|topics|search|feed|rss|podcasts|show)(\/|$)/;

// ---------------------------------------------------------------------------
// Path-based commentary overrides.
// Applied only when a full URL (with path) is supplied. A domain that normally
// classifies as `reported` reclassifies to `commentary` when the URL path
// starts with a known opinion/editorial prefix.
// ---------------------------------------------------------------------------
const COMMENTARY_PATHS: Array<{ host: string; pathPrefix: string }> = [
  { host: "reason.com", pathPrefix: "/volokh" },     // Volokh Conspiracy legal blog
  { host: "newsandsentinel.com", pathPrefix: "/opinion" }, // local-paper opinion section
  { host: "nytimes.com", pathPrefix: "/opinion" },
  { host: "washingtonpost.com", pathPrefix: "/opinions" },
  { host: "wsj.com", pathPrefix: "/opinion" },
  { host: "cnn.com", pathPrefix: "/opinions" },
  { host: "foxnews.com", pathPrefix: "/opinion" },
  { host: "theguardian.com", pathPrefix: "/commentisfree" },
  { host: "latimes.com", pathPrefix: "/opinion" },
  { host: "usatoday.com", pathPrefix: "/opinion" },
  { host: "nbcnews.com", pathPrefix: "/think" },
  { host: "bbc.com", pathPrefix: "/future" },        // BBC Future = analysis/commentary
  { host: "bloomberg.com", pathPrefix: "/opinion" }, // Bloomberg Opinion
  { host: "reuters.com", pathPrefix: "/breakingviews" }, // Reuters Breakingviews
  { host: "ft.com", pathPrefix: "/opinion" },
  { host: "theatlantic.com", pathPrefix: "/ideas" },
  { host: "politico.com", pathPrefix: "/magazine" }, // Politico Magazine = analysis
  { host: "axios.com", pathPrefix: "/hard-truths" },
];

// ---------------------------------------------------------------------------
// Firsthand path overrides — URLs whose host would otherwise classify
// differently but the path signals an official company/org source.
// ---------------------------------------------------------------------------
const FIRSTHAND_PATHS: Array<{ host: string; pathPrefix: string }> = [
  { host: "apple.com", pathPrefix: "/newsroom" },
  { host: "microsoft.com", pathPrefix: "/en-us/microsoft-365" }, // MSFT blog
  { host: "microsoft.com", pathPrefix: "/en-us/research" },
];

/**
 * Classify a source domain/URL into an authority tier. Returns the tier plus a
 * short human-readable reason. The full URL (with path) is required for
 * path-based commentary overrides; a bare domain also works for most cases.
 */
export function classifyAuthority(domainOrUrl: string): AuthorityClassification {
  const raw = domainOrUrl.trim().toLowerCase();
  if (!raw) return { tier: "unknown", reason: "no domain" };

  // Parse path for path-based rules (only if a full URL was supplied).
  let urlPath = "";
  try {
    const u = raw.includes("://") ? new URL(raw) : new URL("http://" + raw);
    urlPath = u.pathname;
  } catch {
    // bare domain — no path to check
  }

  const host = normalizeHost(raw);
  if (!host) return { tier: "unknown", reason: "no domain" };

  // --- Path-based overrides (checked before domain rules) ---

  // Primary path (e.g. psychologicalscience.org/journals/)
  for (const rule of PRIMARY_PATHS) {
    if (hostMatches(host, rule.host) && urlPath.startsWith(rule.pathPrefix)) {
      return { tier: "primary", reason: `academic journal/data path (${host}${urlPath})` };
    }
  }

  // Reported path (e.g. psychologicalscience.org/observer — association magazine)
  for (const rule of REPORTED_PATHS) {
    if (hostMatches(host, rule.host) && urlPath.startsWith(rule.pathPrefix)) {
      return { tier: "reported", reason: `magazine/news section of association site (${host}${urlPath})` };
    }
  }

  // Firsthand path (e.g. apple.com/newsroom)
  for (const rule of FIRSTHAND_PATHS) {
    if (hostMatches(host, rule.host) && urlPath.startsWith(rule.pathPrefix)) {
      return { tier: "firsthand", reason: `official newsroom/blog path (${host}${urlPath})` };
    }
  }

  // Commentary path (e.g. nytimes.com/opinion)
  for (const rule of COMMENTARY_PATHS) {
    if (hostMatches(host, rule.host) && urlPath.startsWith(rule.pathPrefix)) {
      return { tier: "commentary", reason: `opinion/editorial path (${host}${urlPath})` };
    }
  }

  // Reference path (e.g. pbs.org/show/… — show/video landing pages)
  for (const rule of REFERENCE_PATHS) {
    if (hostMatches(host, rule.host) && urlPath.startsWith(rule.pathPrefix)) {
      return { tier: "reference", reason: `show/video landing page (${host}${urlPath})` };
    }
  }

  // Aggregator path (e.g. en.wikipedia.org/wiki/Category:… index pages)
  for (const rule of AGGREGATOR_PATHS) {
    if (hostMatches(host, rule.host) && urlPath.startsWith(rule.pathPrefix)) {
      return { tier: "aggregator", reason: `index/listing page (${host}${urlPath})` };
    }
  }

  // Generic index/listing paths (category hubs, tag pages, search, feeds…).
  // Host-specific overrides above win; anything left matching these segments
  // is navigation, not an article.
  if (urlPath && urlPath !== "/" && INDEX_PATH_SEGMENT_RE.test(urlPath)) {
    return { tier: "aggregator", reason: `index/listing/feed page (${host}${urlPath})` };
  }

  // --- TLD-based rules ---

  if (endsWithAny(host, [".gov", ".mil", ".int"])) {
    // Research-guide portals — background reference, not official records.
    if (REFERENCE_GOV_SUBDOMAINS.some((s) => hostMatches(host, s))) {
      return { tier: "reference", reason: `government research-guide portal (${host})` };
    }
    // Specific .gov subdomains that are newsrooms (not regulatory records)
    if (FIRSTHAND_SUBDOMAINS.some((s) => hostMatches(host, s))) {
      return { tier: "firsthand", reason: `official institution newsroom (${host})` };
    }
    return { tier: "primary", reason: `official government/agency domain (${host})` };
  }
  if (endsWithAny(host, [".edu", ".ac.uk"]) || host.endsWith(".edu.au")) {
    // University newsroom subdomains (news.mit.edu etc.)
    if (FIRSTHAND_SUBDOMAINS.some((s) => hostMatches(host, s))) {
      return { tier: "firsthand", reason: `university newsroom (${host})` };
    }
    return { tier: "primary", reason: `academic institution domain (${host})` };
  }

  // --- Explicit host lists (strongest → weakest) ---

  // Reported-journalism subdomains of primary-tier parents (e.g. spectrum.ieee.org).
  // Must come BEFORE PRIMARY_HOSTS so the parent domain doesn't swallow the subdomain.
  if (REPORTED_SUBDOMAINS.some((s) => hostMatches(host, s))) {
    return { tier: "reported", reason: `specialty journalism outlet (${host})` };
  }

  if (PRIMARY_HOSTS.some((h) => hostMatches(host, h))) {
    return { tier: "primary", reason: `primary research/official record (${host})` };
  }

  // Firsthand subdomains (e.g. blog.google)
  if (FIRSTHAND_SUBDOMAINS.some((s) => hostMatches(host, s) || host === s)) {
    return { tier: "firsthand", reason: `official institution newsroom (${host})` };
  }
  if (FIRSTHAND_HOSTS.some((h) => hostMatches(host, h))) {
    return { tier: "firsthand", reason: `company newsroom or press-release wire (${host})` };
  }

  if (WIRE.some((h) => hostMatches(host, h))) {
    return { tier: "wire", reason: `wire service / news agency (${host})` };
  }
  if (REPORTED.some((h) => hostMatches(host, h))) {
    return { tier: "reported", reason: `established reported journalism (${host})` };
  }
  if (SOCIAL.some((h) => hostMatches(host, h))) {
    return { tier: "social", reason: `social platform (${host})` };
  }
  if (AGGREGATORS.some((h) => hostMatches(host, h))) {
    return { tier: "aggregator", reason: `news aggregator / press-release relay (${host})` };
  }
  if (COMMENTARY_PLATFORMS.some((h) => hostMatches(host, h))) {
    return { tier: "commentary", reason: `self-publishing/opinion platform (${host})` };
  }

  // Reference sources — encyclopedias, background wikis. Good for context
  // only; never citable as evidence for a factual claim.
  if (REFERENCE_HOSTS.some((h) => hostMatches(host, h))) {
    return { tier: "reference", reason: `tertiary reference / background source (${host})` };
  }

  return { tier: "unknown", reason: `no domain rule matched (${host})` };
}

/**
 * True when a URL is an index/listing/catalog page whose extraction can only
 * ever yield navigation metadata, never an article body: generic category/tag/
 * search/feed/podcast/show paths, Wikipedia Category: pages, fact-check list
 * pages, and music-catalog product pages. Ingest uses this to keep such rows
 * as metadata-only (status low_quality, never embedded). Pure + network-free.
 */
export function isMetadataOnlySource(url: string): boolean {
  const raw = url.trim().toLowerCase();
  const host = normalizeHost(raw);
  if (!host) return false;
  let path = "";
  try {
    path = new URL(raw.startsWith("http") ? raw : `https://${raw}`).pathname;
  } catch {
    return false;
  }
  if (hostMatches(host, "music.amazon.com")) return true;
  if (hostMatches(host, "wikipedia.org") && path.startsWith("/wiki/category:")) return true;
  if (hostMatches(host, "politifact.com") && path.startsWith("/factchecks/list")) return true;
  return path !== "/" && INDEX_PATH_SEGMENT_RE.test(path);
}

// Authority tiers that are never acceptable as a newsroom source lead:
// `social` (YouTube, Reddit, X…) and `aggregator` (MSN, Yahoo, BuzzFeed…).
const DISCOVERY_EXCLUDED_TIERS: ReadonlySet<SourceAuthorityTier> = new Set([
  "social",
  "aggregator",
]);

/**
 * Decide whether a discovered domain/URL is fit to enter the source pipeline.
 * Convenience wrapper — returns true for anything that classifies as evidence.
 */
export function isDiscoverableSource(domainOrUrl: string): boolean {
  return classifySourceRole(domainOrUrl).role === "evidence";
}

// --- Three-way source role -----------------------------------------------
// Routes every observed URL into one of three roles, reusing the classifier:
//   • social     → trend_marker (public-interest signal; velocity only)
//   • aggregator → rejected_junk (link farm / redirect spam; dropped)
//   • everything else → evidence
export type SourceRole = "evidence" | "trend_marker" | "rejected_junk";

export interface SourceRoleClassification {
  role: SourceRole;
  tier: SourceAuthorityTier;
  reason: string;
  platform: TrendMarkerPlatform | null;
}

const PLATFORM_HOSTS: Array<[string[], TrendMarkerPlatform]> = [
  [["youtube.com", "youtu.be"], "youtube"],
  [["tiktok.com"], "tiktok"],
  [["reddit.com", "redd.it"], "reddit"],
  [["twitter.com", "x.com"], "x"],
  [["facebook.com", "fb.com", "fb.watch"], "facebook"],
  [["instagram.com"], "instagram"],
  [["threads.net"], "threads"],
  [["linkedin.com"], "linkedin"],
  [["mastodon.social", "mstdn.social", "counter.social"], "mastodon"],
  [["bsky.app"], "bluesky"],
  [["t.me", "telegram.me"], "telegram"],
  [["snapchat.com"], "other"],
  [["truthsocial.com", "gettr.com", "gab.com"], "other"],
];

/** Map a URL/host to its social-platform family (or "other" when unknown). */
export function detectPlatform(domainOrUrl: string): TrendMarkerPlatform {
  const host = normalizeHost(domainOrUrl);
  for (const [hosts, platform] of PLATFORM_HOSTS) {
    if (hosts.some((h) => hostMatches(host, h))) return platform;
  }
  return "other";
}

/**
 * Classify a discovered domain/URL into its newsroom ROLE. Single routing
 * decision every discovery/feed lead flows through. Pure + network-free.
 */
export function classifySourceRole(domainOrUrl: string): SourceRoleClassification {
  const { tier, reason } = classifyAuthority(domainOrUrl);
  if (tier === "social") {
    return { role: "trend_marker", tier, reason, platform: detectPlatform(domainOrUrl) };
  }
  if (tier === "aggregator") {
    return { role: "rejected_junk", tier, reason, platform: null };
  }
  return { role: "evidence", tier, reason, platform: null };
}
