import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAuthority, isDiscoverableSource, isMetadataOnlySource, isReviewArticleTitle, isCitationIntermediaryUrl, CITATION_INTERMEDIARY_DOMAINS } from "./sourceAuthority";

test("government / academic domains classify as primary", () => {
  assert.equal(classifyAuthority("https://www.whitehouse.gov/briefing").tier, "primary");
  assert.equal(classifyAuthority("nasa.gov").tier, "primary");
  assert.equal(classifyAuthority("science.nasa.gov").tier, "primary"); // subdomain still .gov
  assert.equal(classifyAuthority("mit.edu").tier, "primary");
  assert.equal(classifyAuthority("https://arxiv.org/abs/1234.5678").tier, "primary");
  assert.equal(classifyAuthority("who.int").tier, "primary");
  assert.equal(classifyAuthority("frontiersin.org").tier, "primary");
  assert.equal(classifyAuthority("journals.psychologicalscience.org").tier, "primary");
  assert.equal(classifyAuthority("link.springer.com").tier, "primary"); // caught by springer.com
  assert.equal(classifyAuthority("pmc.ncbi.nlm.nih.gov").tier, "primary"); // caught by ncbi.nlm.nih.gov
});

test("psychologicalscience.org path overrides", () => {
  // Default (no path) → firsthand (professional association)
  assert.equal(classifyAuthority("psychologicalscience.org").tier, "firsthand");
  // /news/ stays firsthand (official comms)
  assert.equal(classifyAuthority("https://www.psychologicalscience.org/news/story").tier, "firsthand");
  // /journals/ → primary (peer-reviewed journal content)
  assert.equal(classifyAuthority("https://psychologicalscience.org/journals/pspi/article").tier, "primary");
  // /publications/ → primary
  assert.equal(classifyAuthority("https://psychologicalscience.org/publications/observer").tier, "primary");
  // /observer/ → reported (APS Observer trade magazine)
  assert.equal(classifyAuthority("https://psychologicalscience.org/observer/article").tier, "reported");
});

test("wire services classify as wire", () => {
  assert.equal(classifyAuthority("apnews.com").tier, "wire");
  assert.equal(classifyAuthority("https://www.reuters.com/world").tier, "wire");
  assert.equal(classifyAuthority("bloomberg.com").tier, "wire");
  // Press-release distributors are firsthand (company-originated), not wire.
  assert.equal(classifyAuthority("prnewswire.com").tier, "firsthand");
  assert.equal(classifyAuthority("businesswire.com").tier, "firsthand");
});

test("established outlets classify as reported (secondary journalism)", () => {
  assert.equal(classifyAuthority("https://www.nytimes.com/2026/01/01/x").tier, "reported");
  assert.equal(classifyAuthority("bbc.co.uk").tier, "reported");
  assert.equal(classifyAuthority("theverge.com").tier, "reported");
  assert.equal(classifyAuthority("washingtonpost.com").tier, "reported");
  assert.equal(classifyAuthority("theguardian.com").tier, "reported"); // NOT firsthand
  assert.equal(classifyAuthority("arstechnica.com").tier, "reported"); // NOT firsthand
  assert.equal(classifyAuthority("indyweek.com").tier, "reported");
  assert.equal(classifyAuthority("seattlemedium.com").tier, "reported");
});

test("opinion paths on reported outlets reclassify to commentary", () => {
  assert.equal(classifyAuthority("https://www.nytimes.com/opinion/piece").tier, "commentary");
  assert.equal(classifyAuthority("https://theguardian.com/commentisfree/2026/x").tier, "commentary");
  assert.equal(classifyAuthority("https://www.wsj.com/opinion/article").tier, "commentary");
  // Straight news path stays reported.
  assert.equal(classifyAuthority("https://www.nytimes.com/2026/01/01/politics/x").tier, "reported");
  assert.equal(classifyAuthority("https://theguardian.com/us-news/article").tier, "reported");
});

test("company newsrooms classify as firsthand", () => {
  assert.equal(classifyAuthority("aboutamazon.com").tier, "firsthand");
  assert.equal(classifyAuthority("openai.com").tier, "firsthand");
  assert.equal(classifyAuthority("https://news.mit.edu/2026/x").tier, "firsthand");
  // jpl.nasa.gov reclassified to primary (official NASA lab record, user list).
  assert.equal(classifyAuthority("jpl.nasa.gov").tier, "primary");
});

test("social + aggregator + commentary platforms classify correctly", () => {
  assert.equal(classifyAuthority("twitter.com").tier, "social");
  assert.equal(classifyAuthority("https://x.com/user/status/1").tier, "social");
  assert.equal(classifyAuthority("news.google.com").tier, "aggregator");
  assert.equal(classifyAuthority("sciencedaily.com").tier, "aggregator");
  assert.equal(classifyAuthority("neurosciencenews.com").tier, "aggregator");
  assert.equal(classifyAuthority("someone.substack.com").tier, "commentary");
  assert.equal(classifyAuthority("myblog.medium.com").tier, "commentary");
});

test("reference sources classify as reference (not primary/unknown)", () => {
  assert.equal(classifyAuthority("en.wikipedia.org").tier, "reference");
  assert.equal(classifyAuthority("wikipedia.org").tier, "reference");
  assert.equal(classifyAuthority("fr.wikipedia.org").tier, "reference");
  assert.equal(classifyAuthority("millercenter.org").tier, "reference");
  assert.equal(classifyAuthority("britannica.com").tier, "reference");
});

test("unknown domains default to unknown", () => {
  assert.equal(classifyAuthority("some-random-blog-9821.com").tier, "unknown");
  assert.equal(classifyAuthority("").tier, "unknown");
});

test("isDiscoverableSource drops social + aggregator, keeps citable tiers", () => {
  // Junk tiers excluded from discovery automatically (no allowlist needed).
  assert.equal(isDiscoverableSource("https://www.youtube.com/watch?v=abc"), false);
  assert.equal(isDiscoverableSource("reddit.com"), false);
  assert.equal(isDiscoverableSource("x.com"), false);
  assert.equal(isDiscoverableSource("tiktok.com"), false);
  assert.equal(isDiscoverableSource("msn.com"), false);
  assert.equal(isDiscoverableSource("news.google.com"), false);
  // Citable tiers kept.
  assert.equal(isDiscoverableSource("nasa.gov"), true);
  assert.equal(isDiscoverableSource("https://www.reuters.com/world"), true);
  assert.equal(isDiscoverableSource("nytimes.com"), true);
  assert.equal(isDiscoverableSource("someone.substack.com"), true);
  assert.equal(isDiscoverableSource("some-random-trade-journal-4821.com"), true);
  // Reference tier is ingestable (background context) but low authority.
  assert.equal(isDiscoverableSource("en.wikipedia.org"), true);
});

test("classification includes a human-readable reason", () => {
  const c = classifyAuthority("apnews.com");
  assert.ok(c.reason.length > 0);
  assert.match(c.reason, /wire/i);
});

// --- July 2026 user-supplied domain lists ---------------------------------

test("new primary-tier domains (journals, research orgs, agencies)", () => {
  assert.equal(classifyAuthority("https://www.aanda.org/articles/aa/full").tier, "primary");
  assert.equal(classifyAuthority("journals.ametsoc.org").tier, "primary");
  assert.equal(classifyAuthority("https://journals.sagepub.com/doi/10.1177/x").tier, "primary");
  assert.equal(classifyAuthority("jneurosci.org").tier, "primary");
  assert.equal(classifyAuthority("tandfonline.com").tier, "primary");
  assert.equal(classifyAuthority("nber.org").tier, "primary");
  assert.equal(classifyAuthority("usafacts.org").tier, "primary");
  assert.equal(classifyAuthority("https://www.dwd.de/EN/weather").tier, "primary");
  assert.equal(classifyAuthority("neurology.org").tier, "primary");
  assert.equal(classifyAuthority("psychiatryonline.org").tier, "primary");
  // .gov / .edu from the user list still ride the TLD rules.
  assert.equal(classifyAuthority("govinfo.gov").tier, "primary");
  assert.equal(classifyAuthority("georgewbush-whitehouse.archives.gov").tier, "primary");
  assert.equal(classifyAuthority("scholarship.kentlaw.iit.edu").tier, "primary");
});

test("new firsthand-tier domains (orgs, companies, institutions)", () => {
  assert.equal(classifyAuthority("ilo.org").tier, "firsthand");
  assert.equal(classifyAuthority("ifstudies.org").tier, "firsthand");
  assert.equal(classifyAuthority("https://www.jpmorganchase.com/institute/research").tier, "firsthand");
  assert.equal(classifyAuthority("stories.td.com").tier, "firsthand");
  assert.equal(classifyAuthority("gottman.com").tier, "firsthand");
  assert.equal(classifyAuthority("drugs.com").tier, "firsthand");
  assert.equal(classifyAuthority("whitehousehistory.org").tier, "firsthand");
  assert.equal(classifyAuthority("algop.org").tier, "firsthand");
  assert.equal(classifyAuthority("lsst.org").tier, "firsthand");
});

test("user reclassifications: aei/thenation/reason/washingtontimes", () => {
  // aei.org: firsthand → commentary (think-tank output is analysis/opinion).
  assert.equal(classifyAuthority("https://www.aei.org/articles/x").tier, "commentary");
  // thenation.com: reported → commentary.
  assert.equal(classifyAuthority("thenation.com").tier, "commentary");
  // reason.com: commentary → reported by default…
  assert.equal(classifyAuthority("https://reason.com/2026/07/01/some-news").tier, "reported");
  // …but the Volokh Conspiracy blog path stays commentary.
  assert.equal(classifyAuthority("https://reason.com/volokh/2026/07/01/post").tier, "commentary");
  assert.equal(classifyAuthority("washingtontimes.com").tier, "commentary");
  assert.equal(classifyAuthority("theconversation.com").tier, "commentary");
  assert.equal(classifyAuthority("psychologytoday.com").tier, "commentary");
});

test("new reported-tier domains", () => {
  assert.equal(classifyAuthority("cnbc.com").tier, "reported");
  assert.equal(classifyAuthority("https://www.dailymail.co.uk/news/article-1.html").tier, "reported");
  assert.equal(classifyAuthority("defensescoop.com").tier, "reported");
  assert.equal(classifyAuthority("harvardmagazine.com").tier, "reported");
  assert.equal(classifyAuthority("hcplive.com").tier, "reported");
  assert.equal(classifyAuthority("spacenews.com").tier, "reported");
  assert.equal(classifyAuthority("wral.com").tier, "reported");
  assert.equal(classifyAuthority("https://www.politifact.com/factchecks/2026/jul/01/claim/").tier, "reported");
  // Opinion path on an unknown-default local paper still flips to commentary.
  assert.equal(classifyAuthority("https://www.newsandsentinel.com/opinion/editorials/x").tier, "commentary");
  // …while its non-opinion pages stay unclassified.
  assert.equal(classifyAuthority("https://www.newsandsentinel.com/news/local/x").tier, "unknown");
});

test("new reference-tier domains + guides.loc.gov override", () => {
  assert.equal(classifyAuthority("archive.org").tier, "reference");
  assert.equal(classifyAuthority("simplypsychology.org").tier, "reference");
  assert.equal(classifyAuthority("routledge.com").tier, "reference");
  assert.equal(classifyAuthority("simonandschuster.com").tier, "reference");
  assert.equal(classifyAuthority("ebsco.com").tier, "reference");
  // Library of Congress research guides beat the blanket .gov→primary rule…
  assert.equal(classifyAuthority("https://guides.loc.gov/chronicling-america").tier, "reference");
  // …but loc.gov itself stays primary.
  assert.equal(classifyAuthority("https://www.loc.gov/item/123").tier, "primary");
});

test("new aggregator-tier domains + scribd as social", () => {
  assert.equal(classifyAuthority("researchgate.net").tier, "aggregator");
  assert.equal(classifyAuthority("semanticscholar.org").tier, "aggregator");
  assert.equal(classifyAuthority("statista.com").tier, "aggregator");
  assert.equal(classifyAuthority("trendhunter.com").tier, "aggregator");
  assert.equal(classifyAuthority("music.amazon.com").tier, "aggregator");
  assert.equal(classifyAuthority("preview.inkl.com").tier, "aggregator"); // subdomain of inkl.com
  assert.equal(classifyAuthority("scribd.com").tier, "social");
});

test("index/listing paths classify as aggregator (host rules win first)", () => {
  // Host-specific index pages.
  assert.equal(classifyAuthority("https://en.wikipedia.org/wiki/Category:Extinct_animals").tier, "aggregator");
  assert.equal(classifyAuthority("https://www.politifact.com/factchecks/list/?page=2").tier, "aggregator");
  assert.equal(classifyAuthority("https://www.technologyreview.com/the-download/").tier, "aggregator");
  // Generic category/tag/search/feed paths on any host.
  assert.equal(classifyAuthority("https://www.wral.com/category/news/").tier, "aggregator");
  assert.equal(classifyAuthority("https://example-outlet.com/tag/space/").tier, "aggregator");
  assert.equal(classifyAuthority("https://www.technologyreview.com/feed/").tier, "aggregator");
  // Plain Wikipedia articles stay reference; plain article paths untouched.
  assert.equal(classifyAuthority("https://en.wikipedia.org/wiki/Moon").tier, "reference");
  assert.equal(classifyAuthority("https://www.nytimes.com/2026/01/01/politics/x").tier, "reported");
});

test("pbs path overrides: show/video → reference, washingtonweek article → reported", () => {
  assert.equal(classifyAuthority("https://www.pbs.org/show/washington-week/").tier, "reference");
  assert.equal(classifyAuthority("https://www.pbs.org/video/july-1-2026-episode/").tier, "reference");
  assert.equal(classifyAuthority("https://www.pbs.org/weta/washingtonweek/article/some-story").tier, "reported");
  assert.equal(classifyAuthority("https://www.pbs.org/newshour/politics/story").tier, "reported");
  assert.equal(classifyAuthority("pbssocal.org").tier, "reference");
  assert.equal(classifyAuthority("scetv.org").tier, "reference");
});

test("isMetadataOnlySource flags index/catalog pages only", () => {
  assert.equal(isMetadataOnlySource("https://en.wikipedia.org/wiki/Category:Extinct_animals"), true);
  assert.equal(isMetadataOnlySource("https://music.amazon.com/albums/B01"), true);
  assert.equal(isMetadataOnlySource("https://www.politifact.com/factchecks/list/"), true);
  assert.equal(isMetadataOnlySource("https://example.com/category/science/"), true);
  assert.equal(isMetadataOnlySource("https://example.com/feed"), true);
  assert.equal(isMetadataOnlySource("https://example.com/search?q=x"), true);
  // Real articles are not metadata-only.
  assert.equal(isMetadataOnlySource("https://en.wikipedia.org/wiki/Moon"), false);
  assert.equal(isMetadataOnlySource("https://www.politifact.com/factchecks/2026/jul/01/claim/"), false);
  assert.equal(isMetadataOnlySource("https://www.nytimes.com/2026/01/01/politics/x.html"), false);
  assert.equal(isMetadataOnlySource("upload://abc123"), false);
});

// ---------------------------------------------------------------------------
// isReviewArticleTitle — review-signal detection
// ---------------------------------------------------------------------------

test("isReviewArticleTitle detects systematic review signals", () => {
  assert.equal(isReviewArticleTitle("Short Chain Fatty Acids: A Systematic Review of Relevance for IBD"), true);
  assert.equal(isReviewArticleTitle("A systematic review of mindfulness interventions"), true);
  assert.equal(isReviewArticleTitle("SYSTEMATIC REVIEW of dietary effects"), true); // case-insensitive
});

test("isReviewArticleTitle detects meta-analysis signals", () => {
  assert.equal(isReviewArticleTitle("Meta-analysis of antidepressant efficacy across 80 trials"), true);
  assert.equal(isReviewArticleTitle("A meta analysis of sleep deprivation outcomes"), true);
  assert.equal(isReviewArticleTitle("Cognitive outcomes: meta-analysis and systematic review"), true);
});

test("isReviewArticleTitle detects other review types", () => {
  assert.equal(isReviewArticleTitle("A Review of Current Evidence on Gut Microbiome"), true);
  assert.equal(isReviewArticleTitle("Literature review: vaccine hesitancy factors"), true);
  assert.equal(isReviewArticleTitle("Scoping review of climate adaptation strategies"), true);
  assert.equal(isReviewArticleTitle("Narrative review of long COVID symptoms"), true);
  assert.equal(isReviewArticleTitle("Cochrane review: antibiotic prophylaxis"), true);
  assert.equal(isReviewArticleTitle("An integrative review of nurse burnout"), true);
});

test("isReviewArticleTitle returns false for original research (RCT, study, trial)", () => {
  // Normal primary papers must NOT be downgraded.
  assert.equal(isReviewArticleTitle("Effect of low-dose aspirin on cardiovascular events: randomized controlled trial"), false);
  assert.equal(isReviewArticleTitle("CRISPR-Cas9 editing of the human genome"), false);
  assert.equal(isReviewArticleTitle("Phase III trial of mRNA-1273 vaccine efficacy"), false);
  assert.equal(isReviewArticleTitle("Observational study of dietary patterns in 10,000 adults"), false);
  assert.equal(isReviewArticleTitle("Short-chain fatty acids and IBD pathology"), false);
  assert.equal(isReviewArticleTitle(""), false);
});

test("isReviewArticleTitle detects review signal in excerpt/abstract when title is neutral", () => {
  // Excerpt-only: the title is a neutral paper title, but the abstract says "systematic review".
  const neutralTitle = "Short Chain Fatty Acids and Inflammatory Bowel Disease";
  const reviewAbstract =
    "Background: This study aimed to conduct a systematic review of published literature on SCFA relevance to IBD...";
  assert.equal(isReviewArticleTitle(neutralTitle, reviewAbstract), true);

  // Excerpt contains meta-analysis signal in the first 500 chars.
  const metaExcerpt = "Objectives: We performed a meta-analysis of 42 randomized controlled trials...";
  assert.equal(isReviewArticleTitle("Dietary Fiber and Gut Health", metaExcerpt), true);

  // No signal in either — must still return false.
  assert.equal(isReviewArticleTitle("Gut Microbiome Study", "We enrolled 500 participants..."), false);
});

test("reference-tier domain (Wikipedia) stays reference even if title contains review wording", () => {
  // The review-signal downgrade only applies to `primary`-tier domains.
  // Wikipedia is `reference` — it must never be reclassified by review wording.
  // (The caller in sourceVault.ts only downgrades when classifyAuthority returns primary.)
  assert.equal(classifyAuthority("en.wikipedia.org").tier, "reference");
  assert.equal(classifyAuthority("https://en.wikipedia.org/wiki/Systematic_review").tier, "reference");
  // Confirm isReviewArticleTitle would detect the signal (proving the guard is in the caller, not here).
  assert.equal(isReviewArticleTitle("Systematic review"), true);
});

test("non-HTTP (upload://) URLs must be classified by stored domain, not raw URL", () => {
  // The reclassify migration and persistExtractedSource share this rule:
  // classifyAuthority(url.startsWith("http") ? url : domain). A raw upload://
  // token carries no classifiable host and would restamp docs to "unknown".
  const url = "upload://abc123-report.pdf";
  const domain = "reuters.com";
  assert.equal(classifyAuthority(url).tier, "unknown");
  const input = url.startsWith("http") ? url : domain;
  assert.equal(classifyAuthority(input).tier, "wire");
});

// ---------------------------------------------------------------------------
// isCitationIntermediaryUrl — suppression of academic portal links from the
// public References list. The newly added portals (academia.edu, jstor.org,
// statista.com) are the primary focus; the original three (scispace,
// researchgate, semanticscholar) must continue to pass.
// ---------------------------------------------------------------------------

test("isCitationIntermediaryUrl — original three portals (scispace, researchgate, semanticscholar)", () => {
  assert.equal(isCitationIntermediaryUrl("https://scispace.com/papers/some-paper"), true);
  assert.equal(isCitationIntermediaryUrl("https://www.scispace.com/papers/another"), true);
  assert.equal(isCitationIntermediaryUrl("https://researchgate.net/publication/12345"), true);
  assert.equal(isCitationIntermediaryUrl("https://www.researchgate.net/profile/Author"), true);
  assert.equal(isCitationIntermediaryUrl("https://semanticscholar.org/paper/abc"), true);
  assert.equal(isCitationIntermediaryUrl("https://api.semanticscholar.org/paper/abc"), true);
});

test("isCitationIntermediaryUrl — newly added portals: academia.edu", () => {
  assert.equal(isCitationIntermediaryUrl("https://academia.edu/12345/Paper_Title"), true);
  assert.equal(isCitationIntermediaryUrl("https://www.academia.edu/12345/Paper_Title"), true);
  // Researcher profile subdomains are also intermediary copies.
  assert.equal(isCitationIntermediaryUrl("https://independent.academia.edu/JohnSmith"), true);
});

test("isCitationIntermediaryUrl — newly added portals: jstor.org", () => {
  assert.equal(isCitationIntermediaryUrl("https://jstor.org/stable/10.2307/123456"), true);
  assert.equal(isCitationIntermediaryUrl("https://www.jstor.org/stable/10.2307/123456"), true);
  assert.equal(isCitationIntermediaryUrl("https://www.jstor.org/action/doBasicSearch?q=topic"), true);
});

test("isCitationIntermediaryUrl — newly added portals: statista.com", () => {
  assert.equal(isCitationIntermediaryUrl("https://statista.com/statistics/12345/some-stat/"), true);
  assert.equal(isCitationIntermediaryUrl("https://www.statista.com/statistics/12345/some-stat/"), true);
  assert.equal(isCitationIntermediaryUrl("https://de.statista.com/statistik/daten/studie/12345/"), true);
});

test("isCitationIntermediaryUrl — non-intermediary URLs return false", () => {
  // Original journal/publisher domains are NOT intermediaries.
  assert.equal(isCitationIntermediaryUrl("https://nature.com/articles/s41586-021-00001-z"), false);
  assert.equal(isCitationIntermediaryUrl("https://science.org/doi/10.1126/science.abc1234"), false);
  assert.equal(isCitationIntermediaryUrl("https://arxiv.org/abs/2101.00001"), false);
  assert.equal(isCitationIntermediaryUrl("https://pmc.ncbi.nlm.nih.gov/articles/PMC1234567/"), false);
  assert.equal(isCitationIntermediaryUrl("https://nytimes.com/2026/01/01/x"), false);
  // Malformed / non-HTTP inputs return false without throwing.
  assert.equal(isCitationIntermediaryUrl("not-a-url"), false);
  assert.equal(isCitationIntermediaryUrl(""), false);
  assert.equal(isCitationIntermediaryUrl("upload://abc123"), false);
});

test("CITATION_INTERMEDIARY_DOMAINS contains all six suppressed portals", () => {
  // This test keeps the Set and the seed.ts backfill UPDATE in sync.
  // If a domain is added to the Set but forgotten in seed.ts (or vice-versa),
  // existing rows go un-flagged until the next manual repair.
  const expected = [
    "scispace.com",
    "researchgate.net",
    "semanticscholar.org",
    "academia.edu",
    "jstor.org",
    "statista.com",
  ];
  for (const domain of expected) {
    assert.ok(
      CITATION_INTERMEDIARY_DOMAINS.has(domain),
      `Expected CITATION_INTERMEDIARY_DOMAINS to contain "${domain}"`,
    );
  }
});

test("isCitationIntermediaryUrl — every domain in CITATION_INTERMEDIARY_DOMAINS is detected", () => {
  // Exhaustive round-trip: whatever is in the Set must be caught by the fn.
  for (const domain of CITATION_INTERMEDIARY_DOMAINS) {
    const url = `https://${domain}/some/path`;
    assert.equal(
      isCitationIntermediaryUrl(url),
      true,
      `Expected isCitationIntermediaryUrl("${url}") to be true`,
    );
    // www. prefix must also be caught.
    const wwwUrl = `https://www.${domain}/some/path`;
    assert.equal(
      isCitationIntermediaryUrl(wwwUrl),
      true,
      `Expected isCitationIntermediaryUrl("${wwwUrl}") to be true`,
    );
  }
});
