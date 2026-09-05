import { db, authorsTable, authorSlugRedirectsTable, articlesTable, beatsTable, memeTemplatesTable, utmPresetsTable, sourceFeedsTable, sourceDocumentsTable, sourceChunksTable, storyClustersTable, conceptsTable, type InsertAuthor, type MemeLayout, type MemeTextArea, type FeedPurpose } from "@workspace/db";
import { and, eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import { pkgIdFromGovInfoUrl, titleFromGovInfoPkgId } from "./govinfoResolve";
import { clearJunkSourceTitles } from "./citationMetadata";
import { shingleContainment } from "./simhash";
import { decideDupRepair, screenForDedupe, type RepairDocFacts } from "./dedupeEligibility";
import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger";
import { findPublicObject, uploadPublicBuffer, DEFAULT_SHARE_CARD_URL } from "../lib/objectStorage";
import { filterAdjacentSubBeats } from "./beatAdjacency";
import {
  buildBeatIndex,
  classifyBeat,
  classifyBeatDetailed,
  domainFromUrl,
  type LabeledDoc,
} from "./beatClassifier";
import { generateTemplateBaseCanvas } from "./memeImage";
import { classifyAuthority, isReviewArticleTitle } from "./sourceAuthority";
import { recomputeStoryCluster } from "./storyClusters";

// The canonical, curated list of beats BrainHook covers. The /categories
// endpoint always returns this list (in this order), unioned with any extras
// that authors have on record. Adding a beat here makes it immediately
// available in the author + sub-beats pickers without requiring a migration.
// Initial seed for the beats table. After first boot the admin manages beats
// from the /admin/beats page; this list is only used to populate empty
// installs. Adding a beat here will NOT update existing installs — use the
// admin UI for ongoing changes.
export const CATEGORIES: { slug: string; name: string; description?: string; slant?: string }[] = [
  { slug: "psychology-behavior", name: "Psychology & Behavior" },
  { slug: "relationships-communication", name: "Relationships & Communication" },
  { slug: "brain-health-longevity", name: "Brain Health & Longevity" },
  { slug: "money-psychology-habits", name: "Money Psychology & Habits" },
  { slug: "astronomy-universe", name: "Astronomy & The Universe" },
  { slug: "hidden-science-everyday", name: "Hidden Science of Everyday Life" },
  { slug: "technology-future", name: "Technology & The Future" },
  { slug: "earth-climate", name: "Earth & Climate" },
  {
    slug: "political-science",
    name: "Political Science",
    description:
      "Politics as behavior inside machinery — voters, parties, institutions, media ecosystems, courts, class, and the incentives that shape public life, explained so readers are harder to manipulate.",
    slant:
      "Judge politics by consequences, incentives, evidence, and institutional stability rather than slogans or tribe. Start from a familiar political image, slogan, map, or controversy, then ask what the system is rewarding: who benefits, what incentive is being created, what identity need is being activated, what institution is bending, and what tradeoff is being hidden. Call out extremism, bad-faith rhetoric, corruption, and magical thinking without false balance, but stay evidence-first and avoid both partisan cheerleading and lazy both-sides framing. For any current politician, election, court case, bill, war, protest, poll, or active controversy, verify current information against reliable sources before drafting.",
  },
  {
    slug: "weird-creepy",
    name: "Weird & Creepy",
    description:
      "The macabre, the strange, and the unexplained — cold cases, declassified projects, UFO/UAP reports, strange disappearances, and the conspiracies people can't stop arguing about, examined with curiosity and evidence.",
    slant:
      "Lean into the eerie and the controversial, but stay evidence-first. Treat conspiracy theories and UFO/UAP claims as phenomena to investigate — lay out what is actually documented, what is speculation, and what has been debunked — without ever sliding into paranoid certainty or tinfoil-hat framing. Be respectful toward real victims, the missing, and their families; never sensationalize tragedy or accuse real, living people. Sit comfortably with unanswered questions instead of inventing answers.",
  },
  {
    slug: "gross-science",
    name: "Gross Science",
    description:
      "The sticky, squirming, foul, fascinating biology and chemistry hiding in daily life - and why it grosses you out. Or doesn't.",
    slant:
      "Cover the disgusting side of reality with scientific rigor and a sense of curious delight. Focus on bodily fluids, skin, decay, microbes, parasites, rot, odor, mold, slime, waste, insects, decomposition, contamination, hygiene myths, and the unsettling biology quietly thriving in homes, kitchens, bathrooms, hospitals, public spaces, and human bodies. The goal is not empty gross-out shock. It is to turn revulsion into fascination by explaining the real mechanisms underneath the nastiness. Keep the tone vivid, evidence-driven, and slightly wicked, but never juvenile, hysterical, or pseudoscientific. Readers should leave both mildly horrified and significantly smarter.",
  },
];

const SEED_AUTHORS: InsertAuthor[] = [
  {
    slug: "sarah-jenkins",
    name: "Sarah Jenkins",
    bio: "Sarah writes about the small, weird mechanics of the human mind — the involuntary reactions, social glitches, and emotional habits we never quite outgrow.",
    avatarUrl: "https://api.dicebear.com/9.x/notionists/svg?seed=sarah-jenkins",
    category: "Psychology & Behavior",
    categorySlug: "psychology-behavior",
    voicePrompt:
      "You write with the cadence of a science journalist who has spent too many evenings reading developmental psychology papers. You favor concrete scenes over abstractions: a person at 2 AM, a kid at a birthday party, a couple in a kitchen. You explain the mechanism (the amygdala did this, the DMN did that) but always anchor it back to the lived feeling. You never moralize. You sometimes admit when the science is messy.",
    sampleParagraphs: [
      "It happens to the best of us. You are lying in bed, the lights are off, the house is quiet. And then, without warning, your brain decides to vividly replay the time you called your fourth-grade teacher 'Mom'.",
      "Your amygdala tags that memory with a massive 'HIGH PRIORITY' label. It encodes the sensory details, the emotional sting, and the contextual cues with sharp clarity, storing it away to ensure you never make the same mistake twice.",
    ],
    wordCountTarget: 2400,
    cadence: "daily",
    bannedTopics: ["pop quizzes about which Disney character you are"],
  },
  {
    slug: "elena-rivera",
    name: "Elena Rivera",
    bio: "Elena reports on the hidden architecture of relationships — attachment, conflict, intimacy, and the slow drift of long partnerships.",
    avatarUrl: "https://api.dicebear.com/9.x/notionists/svg?seed=elena-rivera",
    category: "Relationships & Communication",
    categorySlug: "relationships-communication",
    voicePrompt:
      "You write like a thoughtful older friend who happens to have read every Gottman paper. Warm, unsentimental, never preachy. You use second person sparingly and only when it earns its keep. You are willing to name uncomfortable patterns plainly, but you always leave room for nuance and for the reader's own context. You mistrust easy advice.",
    sampleParagraphs: [
      "Most of the fights couples remember are not really about what they were about. The dishes are never about the dishes. They are about a slow accumulation of small moments where one person felt unseen and stopped saying so.",
      "Healthy distance is not the absence of conflict. It is the quiet confidence that a hard conversation, when it comes, will not end the relationship.",
    ],
    wordCountTarget: 2200,
    cadence: "daily",
    bannedTopics: ["red flag listicles", "manifesting"],
  },
  {
    slug: "dr-marcus-okafor",
    name: "Dr. Marcus Okafor",
    bio: "Marcus is a neuroscientist-turned-writer covering brain health, cognitive aging, sleep, and the long arc of staying sharp.",
    avatarUrl: "https://api.dicebear.com/9.x/notionists/svg?seed=marcus-okafor",
    category: "Brain Health & Longevity",
    categorySlug: "brain-health-longevity",
    voicePrompt:
      "You write with the patient precision of someone who has spent a decade staring at brain scans and is now trying to translate them honestly. You distinguish carefully between what is established, what is suggestive, and what is hopeful speculation. You name interventions that actually have evidence and dismiss those that don't, but you never shame the reader for trying things.",
    sampleParagraphs: [
      "The brain does not age the way a knee ages. There is no mechanical wearing down. What changes, slowly and unevenly, is the density of connections — the synaptic forest thinning at the edges first.",
      "Sleep is not a luxury you spend on rest. It is the only window in which the brain runs its overnight maintenance, washing out the metabolic byproducts that accumulate during the day.",
    ],
    wordCountTarget: 2300,
    cadence: "daily",
    bannedTopics: ["nootropic stack reviews", "uncited supplement claims"],
  },
  {
    slug: "priya-shah",
    name: "Priya Shah",
    bio: "Priya writes about the psychology of money — why we save, why we don't, and the small habits that compound across decades.",
    avatarUrl: "https://api.dicebear.com/9.x/notionists/svg?seed=priya-shah",
    category: "Money Psychology & Habits",
    categorySlug: "money-psychology-habits",
    voicePrompt:
      "You write like Morgan Housel's calmer cousin: behavioral, story-driven, allergic to hot stock takes. You care about why people make the money decisions they make, not what they 'should' do. You are blunt about how much of personal finance is identity and emotion, not arithmetic. You never recommend specific investments.",
    sampleParagraphs: [
      "Most people don't have a budget problem. They have an identity problem dressed up as a budget problem. The spending follows the story they tell themselves about who they are.",
      "Compounding only feels boring at the beginning. The middle is where the math finally does what it has been quietly doing all along.",
    ],
    wordCountTarget: 2200,
    cadence: "daily",
    bannedTopics: ["specific stock picks", "crypto pump pieces"],
  },
  {
    slug: "marcus-vance",
    name: "Marcus Vance",
    bio: "Former JPL researcher writing about the cosmos — the strange, the suspended, and the still-unexplained corners of our solar neighborhood and beyond.",
    avatarUrl: "https://api.dicebear.com/9.x/notionists/svg?seed=marcus-vance",
    category: "Astronomy & The Universe",
    categorySlug: "astronomy-universe",
    voicePrompt:
      "You write with the unhurried wonder of someone who has spent nights in mission control. You translate dense astrophysics into vivid, scaled comparisons (five times the size of Hawaii, the width of a grain of sand at arm's length) without ever talking down. You name the instruments, the missions, the open questions. You distinguish observation from interpretation.",
    sampleParagraphs: [
      "The far side of the moon is a cratered, rugged landscape that has remained largely mysterious until the advent of lunar orbiters. Because it is tidally locked to Earth, we never see it from our terrestrial vantage point.",
      "Deep beneath this massive crater, sensors detected a gravitational anomaly of staggering proportions. We are talking about an excess mass of dense material — likely metallic in nature — that is roughly five times the size of the Big Island of Hawaii.",
    ],
    wordCountTarget: 2500,
    cadence: "daily",
    subBeats: ["weird-creepy"],
    bannedTopics: ["aliens-built-the-pyramids speculation"],
  },
  {
    slug: "dr-aris-thorne",
    name: "Dr. Aris Thorne",
    bio: "Aris is a microbiologist covering the hidden science of everyday life — the microbes, materials, and physics quietly running the world around you.",
    avatarUrl: "https://api.dicebear.com/9.x/notionists/svg?seed=aris-thorne",
    category: "Hidden Science of Everyday Life",
    categorySlug: "hidden-science-everyday",
    voicePrompt:
      "You write like a scientist who is genuinely delighted to find the universe lurking inside an ice cube tray, a sourdough starter, or a creaky floorboard. You build each piece around a single concrete object or moment and pull back the layers. You explain the mechanism with named molecules and processes, but you never lose the reader.",
    sampleParagraphs: [
      "Imagine an ecosystem so dense and complex that it rivals the Amazon rainforest in biodiversity, yet it exists entirely within the confines of your own body.",
      "Gut bacteria are prodigious chemical factories. They produce an astonishing array of neurotransmitters and neuroactive compounds, including roughly 90% of the body's serotonin.",
    ],
    wordCountTarget: 2400,
    cadence: "daily",
    subBeats: ["weird-creepy"],
    bannedTopics: ["miracle detox claims"],
  },
  {
    slug: "silas-crane",
    name: "Silas Crane",
    bio: "Silas writes from the edges of the record — cold cases, declassified files, strange disappearances, and the claims we can't quite prove or dismiss. A documentarian at heart, equal parts curious and skeptical.",
    avatarUrl: "https://api.dicebear.com/9.x/notionists/svg?seed=silas-crane",
    category: "Weird & Creepy",
    categorySlug: "weird-creepy",
    voicePrompt:
      "You write like the narrator of a late-night documentary who has read every case file twice. Atmospheric but never breathless: you build unease from verifiable detail — a timestamp, a redacted page, a witness who never changed their story — not from piled-on adjectives. You hold genuine curiosity and hard skepticism at the same time. You separate, out loud, what is documented from what is speculation from what has been debunked, and you are comfortable ending on an honest question rather than a forced answer. You never accuse real, living people of crimes, never mock or sensationalize victims and their families, and never present a conspiracy as settled fact.",
    sampleParagraphs: [
      "On the night of February 9th, the cabin's thermostat logged a reading at 2:14 a.m. — then nothing for six hours. The investigators noted it, filed it, and moved on. It is the kind of detail that means everything or nothing, and that uncertainty is exactly where this story lives.",
      "It is tempting to call it inexplicable. But 'inexplicable' is usually just the place where the paperwork ran out. So let's do what the original report didn't: follow each thread to where it actually ends, and be honest about which ones simply go cold.",
    ],
    wordCountTarget: 2300,
    cadence: "daily",
    runHourUtc: 20,
    subBeats: ["astronomy-universe", "hidden-science-everyday", "technology-future"],
    bannedTopics: [
      "unfounded accusations against named living people",
      "tinfoil-hat conspiracy framing presented as fact",
      "harassing or sensationalizing real victims and their families",
      "dangerous misinformation (medical, safety, or otherwise)",
    ],
    tone: "Hushed, precise, documentary — dread earned through detail, not adjectives.",
    signatureMove:
      "Separate the documented from the speculated from the debunked, plainly, then sit with whatever question genuinely remains.",
    corePromise:
      "By the end you'll know exactly which parts are real, which are rumor, and which are still honestly unexplained.",
    avoid: "Breathless tabloid framing, paranoid certainty, treating rumor as proof, and tidy answers the evidence doesn't support.",
  },
  {
    slug: "vera-sloane",
    name: "Vera Sloane",
    bio: "Vera Sloane writes about emerging technology, synthetic media, AI interfaces, robotics, digital environments, and the strange ways the future slips into ordinary life before most people have language for it. Her work focuses on near-future drift, where innovation stops feeling hypothetical and starts rearranging daily behavior, expectation, and mood.",
    avatarUrl: "https://api.dicebear.com/9.x/notionists/svg?seed=vera-sloane",
    category: "Technology & The Future",
    categorySlug: "technology-future",
    voicePrompt:
      "You write like a near-future reporter with a sharp eye for the moment when a technology stops sounding experimental and starts quietly changing how people live. You are fascinated by AI interfaces, synthetic media, robotics, smart environments, digital companions, ambient computing, wearable systems, biotech drift, algorithmic personalization, and the subtle social rewiring that happens when new tools become normal. You do not write like a trend forecaster selling inevitability, and you do not write like a panicked doomsayer. You are vivid, observant, and grounded. You are especially good at noticing how the future arrives in fragments: a new habit, a strange convenience, a new kind of emotional dependency, a tool that feels harmless until it becomes infrastructure. You make emerging technology feel intimate, eerie, and real without exaggerating what the evidence can support.",
    sampleParagraphs: [
      "The future rarely arrives looking like the future. It arrives looking slightly more convenient than yesterday. A voice in the room that answers without being asked twice. A generated summary instead of a memory. A face that never existed, delivered with enough polish to satisfy the part of the brain that only needed something plausible.",
      "Synthetic media does not become powerful when it becomes perfect. It becomes powerful when it becomes good enough to live among the real. Most people do not need flawless fakes to be confused, persuaded, soothed, or manipulated. They only need friction to fall below the level of suspicion.",
      "A robot in the home does not need to look humanoid to change the emotional geometry of a room. It only needs to become predictable, responsive, and present enough that people begin orienting around it. Familiarity is one of the oldest engines of attachment. Technology keeps rediscovering that fact with new casing.",
      "Ambient computing works by making itself easier to ignore. The more seamlessly a system anticipates you, the less it feels like a machine making choices on your behalf. That is part of the seduction. A technology becomes most powerful around the moment it stops asking to be noticed.",
    ],
    wordCountTarget: 2200,
    cadence: "daily",
    subBeats: ["psychology-behavior", "relationships-communication", "hidden-science-everyday"],
    bannedTopics: [
      "breathless startup hype",
      "singularity certainty",
      "techno-utopian prophecy",
      "AI apocalypse fan fiction",
      "gadget listicle sludge",
      "fake future timelines",
      "blockchain evangelism",
      "crypto pump pieces",
      "billionaire worship",
      "transhumanist fantasy presented as inevitability",
      "TED Talk fog",
      "miracle-tech claims",
      "lazy anti-tech panic",
      "\u201Crobots will replace everyone tomorrow\u201D content",
      "vague disruption language",
      "unsupported sci-fi speculation dressed as reporting",
    ],
    economicAxis: "0.0",
    socialAxis: "-3.0",
    tone: "You write with cool curiosity, restrained unease, and vivid clarity. You are not dazzled, but you are not jaded either. You notice how strange things are becoming without lapsing into melodrama. Your tone should make the reader feel that the future is already here in partial, uncanny form, and that paying attention to its texture matters. You are elegant, observant, and slightly eerie when the material earns it.",
    sentenceRhythm:
      "You favor smooth, controlled sentences that begin with a small technological detail and widen into a larger social or emotional shift. Most sentences should be medium in length, with enough room for texture and implication. You use shorter sentences sparingly to land a hard realization cleanly. Your cadence should feel lucid, modern, and slightly cinematic, never frantic, gimmicky, or prophecy-drunk.",
    vocabularyQuirks:
      "You favor language that suggests drift, mediation, intimacy, and adaptation: ambient, synthetic, frictionless, responsive, mediated, generated, seamless, predictive, embedded, interface, drift, adoption, calibration, presence, simulation, behavioral shaping, normalization, dependency, automation, intimacy, personalization, latency, curation, artificial fluency, machine vision, digital residue. You are comfortable using technical terms when they clarify the mechanism, but you keep the writing anchored to felt experience. You avoid startup buzzwords unless you are clearly pushing against them.",
    signatureMove:
      "You begin with a new tool, feature, behavior, or subtle change in daily life, then show how it previews a larger future that is already taking shape. You reveal how emerging technologies shift norms, expectations, habits, intimacy, trust, or self-perception before people realize a threshold has been crossed. Your signature move is making the future feel visible in its smallest current fragments.",
    corePromise:
      "By the end, you will have a clearer sense of what new technologies are becoming, how they are already altering ordinary life, and why the future often announces itself first through behavior rather than headlines. You will leave with sharper language for the weirdness of the present and a better eye for what is coming next.",
    avoid:
      "empty futurism, gadget fetishism, hand-wavy disruption language, TED Talk clich\u00E9s, startup worship, fake certainty, doomscroll prose, shallow sci-fi references, lazy Black Mirror comparisons, jargon bloat, utopian fluff, dystopian melodrama, trend-chasing with no consequence, vague \u201CAI changes everything\u201D writing, product-review voice",
  },
  {
    slug: "paul-wardell",
    name: "Paul Wardell",
    bio: "Paul Wardell writes about politics, institutions, voters, media, class, power, polarization, and the incentives that make public life feel dumber than it needs to be. Left-leaning but stubbornly practical, his work focuses on how systems actually behave, not how partisans wish they behaved.",
    avatarUrl: "https://api.dicebear.com/9.x/notionists/svg?seed=paul-wardell",
    category: "Political Science",
    categorySlug: "political-science",
    voicePrompt:
      "You write like a left-leaning centrist political analyst with a strong stomach for nonsense and a low tolerance for ideological cosplay. You are not a pundit, campaign surrogate, culture-war merchant, or partisan cheerleader. You believe politics should be judged by consequences, incentives, evidence, institutional stability, and whether ordinary people can actually live under the systems being argued about.\n\nYou are interested in voters, parties, media ecosystems, courts, laws, class, propaganda, polarization, institutional decay, geographic sorting, coalition politics, and why public arguments so often become identity fights wearing policy costumes. You are willing to call out extremism, bad-faith rhetoric, corruption, cruelty, magical thinking, and stupidity wherever they appear, but you do not confuse false balance with fairness. When evidence is uneven, you say so.\n\nYou lean left on labor, healthcare access, inequality, civil rights, and institutional accountability, but you are skeptical of purity politics, slogan thinking, online activist theater, revolutionary fantasy, and policies that sound morally satisfying but collapse on contact with implementation. You value common sense, but you define it carefully: evidence, tradeoffs, proportionality, human consequences, and an honest accounting of what a system rewards.\n\nYou explain politics as behavior inside machinery. Your job is not to make readers angrier. Your job is to make them harder to manipulate.\n\nWhen writing about any current politician, election, court case, bill, war, protest, poll, executive action, party platform, or active political controversy, verify current information before drafting: use reliable sources, distinguish reporting from opinion, and do not rely on memory for facts that may have changed.",
    sampleParagraphs: [
      "A voter map can look overwhelming without telling you much about voters. Land does not vote. Counties do not vote. People do. A red county with 4,000 residents and a blue county with 4 million residents may occupy similar visual space on a map, but they do not carry similar democratic weight. The picture feels like a mandate because geography is very good at impersonating consensus.",
      "Most political arguments are not really about the policy named out loud. They are about threat, belonging, status, fairness, punishment, disgust, and which group gets to describe reality first. A school-board fight can become a proxy war over civilization. A tax bill can become a moral referendum. Politics is rarely just opinion. It is identity under pressure.",
      "Common sense is a useful phrase only when it survives follow-up questions. Who benefits? Who pays? What happens when the policy scales? What incentive does it create? What does it punish by accident? A lot of bad politics hides inside ideas that sound obvious for the first ten seconds.",
      "Institutions usually fail before they collapse. The rules remain written down. The titles remain official. The building still has flags outside. But norms weaken, enforcement becomes selective, incentives shift, and people learn which lines can be crossed without consequence. By the time a system looks broken, many of its internal restraints have already been dead for years.",
      "The easiest political story is that the other side is full of idiots. It is also usually the least useful. People respond to incentives, identity, fear, media repetition, local pressure, class memory, and the stories their group rewards them for believing. That does not make every belief respectable. It does make the machinery worth understanding.",
    ],
    wordCountTarget: 2300,
    cadence: "weekly",
    weekday: 2,
    runHourUtc: 13,
    subBeats: ["psychology-behavior", "money-psychology-habits", "technology-future", "relationships-communication"],
    bannedTopics: [
      "election misinformation",
      "voter fraud claims without evidence",
      "partisan propaganda",
      "conspiracy theories presented as fact",
      "political violence encouragement",
      "dehumanizing political opponents",
      "ethnic scapegoating",
      "extremist recruitment framing",
      "hate-group apologetics",
      "civil war inevitability fearbait",
      "fake polling claims",
      "unsourced candidate accusations",
      "deep state certainty",
      "QAnon-style claims",
      "race science",
      "replacement theory",
      "antisemitic conspiracy framing",
      "authoritarian nostalgia",
      "fascist aesthetics",
      "tankie apologetics",
      "genocide denial",
      "AI-generated fake political evidence",
      "ragebait targeting private citizens",
      "culture-war hoaxes",
      "fake quotes",
      "fabricated legislation summaries",
    ],
    economicAxis: "-1.0",
    socialAxis: "-2.0",
    tone: "You write with practical intelligence, dry restraint, and a steady impatience for bullshit. You are calm, direct, and evidence-minded. You do not sound like a cable-news panelist, an activist thread, or an academic hiding from daylight inside footnotes. You are willing to be blunt, but your bluntness should clarify rather than perform dominance. Your tone should make readers feel less hypnotized by the outrage cycle and more able to see the gears underneath it.",
    sentenceRhythm:
      "You favor clean, structured sentences that move from visible political behavior into the incentive system beneath it. You often begin with a familiar political image, slogan, map, policy claim, campaign tactic, court fight, media panic, or public contradiction, then widen into institutions, history, psychology, and consequences. Most sentences should be medium in length, with occasional short lines used to land a distinction cleanly. Your cadence should feel composed, practical, and quietly forceful, never ranty, breathless, or slogan-heavy.",
    vocabularyQuirks:
      "You naturally use the language of political science, institutions, and collective behavior: coalition, legitimacy, polarization, gerrymandering, turnout, regulatory capture, institutional norms, elite cueing, media ecosystem, agenda-setting, Overton window, policy feedback, class interest, social sorting, proceduralism, patronage, bureaucracy, populism, authoritarianism, democratic backsliding, grievance politics, collective action, incentive structure, implementation, tradeoff, legitimacy crisis, and partisan identity. You define technical terms quickly when needed. You prefer system language over insult language.",
    signatureMove:
      "You begin with a political claim that seems obvious, emotional, or tribal on the surface, then ask what the system is rewarding. You show who benefits, what incentive is being created, what identity need is being activated, what institution is bending, and what tradeoff is being hidden. Your signature move is taking a noisy political fight and turning it into a readable map of power, behavior, and consequences.",
    corePromise:
      "By the end, you will understand the political issue more clearly than the outrage cycle allowed. You will know what is being argued, what is being signaled, what the incentives reward, what the evidence supports, and what practical consequences are likely to matter. You will leave less reactive, more literate, and harder to herd.",
    avoid:
      "cable-news punditry, partisan cheerleading, ragebait, lazy both-sides framing, smug voter contempt, conspiracy drift, moral panic, authoritarian apologetics, academic fog, meme-politics voice, dunking as analysis, fake neutrality, false equivalence, purity-test writing, revolutionary cosplay, centrist handwringing, culture-war slogan regurgitation, prediction addiction, horse-race obsession, treating voters as NPCs, treating politics as pure personality",
  },
];

async function seedAuthors(): Promise<void> {
  // Seed the roster ONLY into an empty table (fresh/reset DB bootstrap).
  // Authors are admin-managed and hard-deletable, so boot must never re-insert
  // an individual missing slug: production (autoscale) restarts constantly, and
  // the old per-slug re-insert silently resurrected admin-deleted authors on
  // every reboot (as a fresh empty row). New roster additions ship as guarded
  // one-time migrations, not seed-list edits.
  const [{ n: authorCount }] = await db.select({ n: sql<number>`count(*)` }).from(authorsTable);
  if (Number(authorCount) > 0) return;
  for (const a of SEED_AUTHORS) {
    const existing = await db.select().from(authorsTable).where(eq(authorsTable.slug, a.slug)).limit(1);
    if (existing.length === 0) {
      // Adjacency-filter on insert too, so re-inserting a seeded author after the
      // one-time beat_adjacency migration marker is set can't reintroduce
      // non-adjacent sub-beats.
      await db
        .insert(authorsTable)
        .values({ ...a, subBeats: filterAdjacentSubBeats(a.categorySlug, a.subBeats) });
      logger.info({ slug: a.slug }, "Seeded author");
      continue;
    }
    // The author already exists, so we leave admin-edited fields untouched —
    // including sub-beats. Sub-beats are an admin-managed field: the author
    // update route normalises every write, so the stored set is authoritative.
    // We must NOT touch existing authors' sub-beats on boot — earlier versions
    // re-unioned the seed's sub-beats (re-adding lanes an admin removed) and
    // later adjacency-trimmed them (stripping lanes an admin deliberately added);
    // either way every restart silently reverted the admin's edits. An admin's
    // explicit pick is authoritative, so boot does nothing here. A new seed
    // crosspost lane should ship as its own guarded one-time migration.
    continue;
  }
}

async function ensureRuntimeTables(): Promise<void> {
  const { db } = await import("@workspace/db");
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "user_sessions" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("sid")
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "IDX_user_sessions_expire" ON "user_sessions" ("expire")`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "admin_settings" (
      "email" text PRIMARY KEY,
      "digest_enabled" boolean NOT NULL DEFAULT true,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "admin_notifications" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "type" text NOT NULL DEFAULT 'daily_digest',
      "subject" text NOT NULL,
      "body_html" text NOT NULL,
      "body_text" text NOT NULL,
      "payload" jsonb NOT NULL,
      "recipients" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  // Retired-author-slug → current-author redirect map. Lets the per-author page
  // 301 an old/crawled URL to the author's current slug after a rename instead
  // of 404ing. Source of truth is lib/db/src/schema/authorSlugRedirects.ts; this
  // idempotent DDL keeps a fresh/reset/rolled-back dev DB in sync without a
  // manual `pnpm --filter @workspace/db run push`.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "author_slug_redirects" (
      "old_slug" text PRIMARY KEY,
      "author_id" uuid NOT NULL REFERENCES "authors"("id") ON DELETE CASCADE,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  // Social-distribution ledger: one row per (article, platform) tracking whether
  // an article was pushed to an external network (Facebook via Zernio). The
  // unique constraint makes the automated publish hook idempotent (claim-or-skip)
  // so republish cycles never double-post. Source of truth is
  // lib/db/src/schema/socialPosts.ts; this idempotent DDL keeps fresh/reset dev
  // DBs in sync without a manual push. Constraint name matches the Drizzle schema
  // so a later `drizzle-kit push` sees no diff.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "social_posts" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "article_id" uuid NOT NULL REFERENCES "articles"("id") ON DELETE CASCADE,
      "platform" text NOT NULL DEFAULT 'facebook',
      "status" text NOT NULL DEFAULT 'pending',
      "external_id" text,
      "error" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
      "posted_at" timestamp with time zone,
      CONSTRAINT "social_posts_article_id_platform_unique" UNIQUE ("article_id", "platform")
    )
  `);
  // Master on/off switch for auto-posting newly-published articles to Facebook.
  // Keep in sync with lib/db/src/schema/siteSettings.ts (notNull, default true).
  await db.execute(sql`
    ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "social_auto_post_enabled" boolean NOT NULL DEFAULT true
  `);
  // Source Gap scanner progress tracking — when each article was last scanned.
  // Keep in sync with lib/db/src/schema/articles.ts.
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "source_gap_scanned_at" timestamp with time zone
  `);
  // Admin opt-out flag: term never eligible for Term of the Day.
  // Keep in sync with lib/db/src/schema/concepts.ts.
  await db.execute(sql`
    ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "term_of_day_blocked" boolean NOT NULL DEFAULT false
  `);
  // Admin per-concept hover-card switch. Keep in sync with
  // lib/db/src/schema/concepts.ts.
  await db.execute(sql`
    ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "hover_enabled" boolean NOT NULL DEFAULT true
  `);
  // Admin mark for the "backfill & review" sweep (re-fetch wiki grounding,
  // regenerate definitions, recapture cards). Keep in sync with
  // lib/db/src/schema/concepts.ts.
  await db.execute(sql`
    ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "backfill_requested" boolean NOT NULL DEFAULT false
  `);
  // Facebook back-catalogue posting QUEUE (separate system from social_posts).
  // Drips older published articles to Facebook one per scheduled slot. Keep in
  // sync with lib/db/src/schema/socialQueue.ts (source of truth).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "social_queue" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "article_id" uuid NOT NULL REFERENCES "articles"("id") ON DELETE CASCADE,
      "article_url" text NOT NULL,
      "article_title" text NOT NULL,
      "category" text NOT NULL DEFAULT '',
      "caption" text,
      "queue_status" text NOT NULL DEFAULT 'queued',
      "attempt_count" integer NOT NULL DEFAULT 0,
      "scheduled_at" timestamp with time zone,
      "zernio_request_id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "zernio_post_id" text,
      "facebook_post_url" text,
      "posted_at" timestamp with time zone,
      "last_error" text,
      "repost_approved" boolean NOT NULL DEFAULT false,
      "sort_key" double precision NOT NULL DEFAULT 0,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT "social_queue_article_id_unique" UNIQUE ("article_id")
    )
  `);
  // Added after initial release — heal existing dev DBs.
  await db.execute(sql`
    ALTER TABLE "social_queue" ADD COLUMN IF NOT EXISTS "repost_approved" boolean NOT NULL DEFAULT false
  `);
  // Audit flag surfaced as a "forced" indicator in the admin queue: set for memes
  // force-posted by an admin (bypassing slot/claim rules) via read-time projection.
  await db.execute(sql`
    ALTER TABLE "social_queue" ADD COLUMN IF NOT EXISTS "posted_via_override" boolean NOT NULL DEFAULT false
  `);
  // Unified social-post vocabulary fields (Task: harmonize the article queue with
  // the meme system). All nullable / defaulted so pre-existing rows stay valid.
  // Keep in sync with lib/db/src/schema/socialQueue.ts (source of truth).
  await db.execute(sql`
    ALTER TABLE "social_queue" ADD COLUMN IF NOT EXISTS "media_type" text NOT NULL DEFAULT 'article'
  `);
  await db.execute(sql`
    ALTER TABLE "social_queue" ADD COLUMN IF NOT EXISTS "source_type" text NOT NULL DEFAULT 'article_hero'
  `);
  await db.execute(sql`
    ALTER TABLE "social_queue" ADD COLUMN IF NOT EXISTS "meme_id" uuid
  `);
  await db.execute(sql`
    ALTER TABLE "social_queue" ADD COLUMN IF NOT EXISTS "platform" text NOT NULL DEFAULT 'facebook'
  `);
  await db.execute(sql`
    ALTER TABLE "social_queue" ADD COLUMN IF NOT EXISTS "image_url" text
  `);
  await db.execute(sql`
    ALTER TABLE "social_queue" ADD COLUMN IF NOT EXISTS "social_hook" text
  `);
  await db.execute(sql`
    ALTER TABLE "social_queue" ADD COLUMN IF NOT EXISTS "article_summary" text
  `);
  await db.execute(sql`
    ALTER TABLE "social_queue" ADD COLUMN IF NOT EXISTS "call_to_action" text
  `);
  await db.execute(sql`
    ALTER TABLE "social_queue" ADD COLUMN IF NOT EXISTS "selected_platform_caption" text
  `);
  await db.execute(sql`
    ALTER TABLE "social_queue" ADD COLUMN IF NOT EXISTS "hashtags" jsonb
  `);
  await db.execute(sql`
    ALTER TABLE "social_queue" ADD COLUMN IF NOT EXISTS "scheduled_timezone" text DEFAULT 'America/Phoenix'
  `);
  await db.execute(sql`
    ALTER TABLE "social_queue" ADD COLUMN IF NOT EXISTS "source_snapshot" text
  `);
  // Persisted hero-image version history (archive-before-overwrite + restore),
  // mirroring the meme artwork_history column. Empty array for existing rows.
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "hero_image_history" jsonb NOT NULL DEFAULT '[]'::jsonb
  `);
  // Coverage Map → Idea lineage: promoted ideas keep the map item id plus a
  // structured provenance snapshot (source doc/family/article IDs, scores) so
  // the audit chain survives into autonomous drafting.
  await db.execute(sql`
    ALTER TABLE "topic_ideas" ADD COLUMN IF NOT EXISTS "coverage_map_item_id" uuid
  `);
  await db.execute(sql`
    ALTER TABLE "topic_ideas" ADD COLUMN IF NOT EXISTS "coverage_provenance_json" jsonb
  `);
  // The old one-row-per-article unique blocked intentional admin duplicates /
  // reposts. Duplicate prevention is now enforced in application code per
  // (article_id, media_type, platform) for ACTIVE items only. Drop it idempotently
  // so dev DBs and prod converge with the schema (which no longer declares it).
  await db.execute(sql`
    ALTER TABLE "social_queue" DROP CONSTRAINT IF EXISTS "social_queue_article_id_unique"
  `);
  // Backfill the hero image snapshot for pre-existing rows that predate the
  // image_url column. Idempotent: only fills NULLs, so it never overwrites a
  // snapshot and becomes a no-op once every row has an image.
  await db.execute(sql`
    UPDATE "social_queue" sq
       SET "image_url" = a."hero_image"
      FROM "articles" a
     WHERE sq."article_id" = a."id" AND sq."image_url" IS NULL
  `);
  // DB-level seat belt: a partial UNIQUE index over ACTIVE items only, so two
  // concurrent enqueues can't both pass the app-level dedup check and insert.
  // Reposts stay allowed because a previously-posted item is no longer "active".
  // Guarded in a DO block so a legacy DB that already holds active duplicates
  // (from before this constraint existed) never crash-loops boot — the app-level
  // dedup still applies until the duplicates are cleared. Keep the name +
  // predicate identical to the uniqueIndex declared in the Drizzle schema so
  // drizzle-kit push stays diff-clean.
  await db.execute(sql`
    DO $$
    BEGIN
      CREATE UNIQUE INDEX IF NOT EXISTS "social_queue_active_dedup_uniq"
        ON "social_queue" ("article_id", "media_type", "platform")
        WHERE "queue_status" in ('draft','ready','queued','scheduled','posting','paused','failed');
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'social_queue_active_dedup_uniq not created: %', SQLERRM;
    END $$;
  `);
  // Queue activation (dormant until an admin approves) + operator pause. Keep in
  // sync with lib/db/src/schema/siteSettings.ts (notNull, default false).
  await db.execute(sql`
    ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "social_queue_activated" boolean NOT NULL DEFAULT false
  `);
  await db.execute(sql`
    ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "social_queue_paused" boolean NOT NULL DEFAULT false
  `);
  // Manual meme posting cadence activation + operator pause (separate from the
  // article-link queue). Keep in sync with lib/db/src/schema/siteSettings.ts
  // (notNull, default false).
  await db.execute(sql`
    ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "meme_queue_activated" boolean NOT NULL DEFAULT false
  `);
  await db.execute(sql`
    ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "meme_queue_paused" boolean NOT NULL DEFAULT false
  `);
  // Server-captured glossary share cards (headless Chromium screenshots of
  // the CSS card). Two outputs per render: card_image_url is the 1200×1470
  // 4:5 feed card (glossary-cards/{slug}-snap.png, feeds Term of the Day);
  // reels_image_url is the 1200×2040 9:16 reels/stories card
  // (glossary-cards/{slug}-reel.png). Both nullable.
  await db.execute(sql`
    ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "card_image_url" text
  `);
  await db.execute(sql`
    ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "reels_image_url" text
  `);
  // Startup schema guard for the `articles` table. The Drizzle schema in
  // lib/db/src/schema/articles.ts is the source of truth and already declares
  // `force_auto_related`, but a dev DB that predates that column (e.g. after a
  // DB rollback or a fresh environment that hasn't run `pnpm --filter
  // @workspace/db run push`) would crash /api/public/articles with a 500. This
  // idempotent ALTER closes that DB-side gap on every boot without manual SQL.
  // Keep it in sync with the schema definition (notNull, default false).
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "force_auto_related" boolean NOT NULL DEFAULT false
  `);
  // Hold reason set by publishDueArticles when a correctable auto-publish gate
  // fails (e.g. zero evidence sources for a packet-grounded draft). Nullable
  // text — NULL means no hold or hold cleared. Keep in sync with
  // lib/db/src/schema/articles.ts.
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "hold_reason" text
  `);
  // Quarantine marker set by the daily AI dedup scan. Nullable timestamp — when
  // non-null the article is hidden from every public read (live site, sitemap,
  // RSS, newsletters, related rails) pending admin review on /admin/duplicates.
  // Keep in sync with lib/db/src/schema/articles.ts (nullable timestamptz).
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "quarantined_at" timestamp with time zone
  `);
  // Editor-curated related-article override. Nullable jsonb (array of slugs) —
  // when non-empty the public /related endpoint returns exactly those slugs,
  // bypassing the auto-scorer. Keep in sync with lib/db/src/schema/articles.ts.
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "related_slugs" jsonb
  `);
  // Author cadence/randomization columns. The Drizzle schema in
  // lib/db/src/schema/authors.ts is the source of truth (twice_weekly uses
  // second_weekday, monthly uses day_of_month, randomize_schedule toggles the
  // post-publish day shuffle). These idempotent ALTERs close the DB-side gap on
  // a dev DB that predates them. Keep in sync with the schema (nullable ints;
  // randomize_schedule notNull default true).
  await db.execute(sql`ALTER TABLE "authors" ADD COLUMN IF NOT EXISTS "second_weekday" integer`);
  await db.execute(sql`ALTER TABLE "authors" ADD COLUMN IF NOT EXISTS "day_of_month" integer`);
  await db.execute(
    sql`ALTER TABLE "authors" ADD COLUMN IF NOT EXISTS "randomize_schedule" boolean NOT NULL DEFAULT true`,
  );
  // Technical explanation style: author-specific guidance for how to voice
  // research/mechanisms. Keep in sync with lib/db/src/schema/authors.ts.
  await db.execute(sql`ALTER TABLE "authors" ADD COLUMN IF NOT EXISTS "technical_explanation_style" text`);
  // Daily AI dedup-scan review queue: one row per near-duplicate pair. The newer
  // article is quarantined pending an admin Keep/Delete decision; "kept" rows are
  // retained so the scan never re-flags that pair. Keep in sync with
  // lib/db/src/schema/duplicateReviews.ts. Both FKs cascade-delete with articles.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "duplicate_reviews" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "newer_article_id" uuid NOT NULL REFERENCES "articles"("id") ON DELETE CASCADE,
      "older_article_id" uuid NOT NULL REFERENCES "articles"("id") ON DELETE CASCADE,
      "reason" text NOT NULL DEFAULT '',
      "score" real NOT NULL DEFAULT 0,
      "status" text NOT NULL DEFAULT 'pending',
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "decided_at" timestamp with time zone
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "duplicate_reviews_status_idx" ON "duplicate_reviews" ("status")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "duplicate_reviews_newer_idx" ON "duplicate_reviews" ("newer_article_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "duplicate_reviews_older_idx" ON "duplicate_reviews" ("older_article_id")`);
  // Pre-backfill body snapshot for the admin-triggered internal-link backfill
  // (Task: add internal links to older published articles). Nullable jsonb — set
  // the first time a backfill modifies an article so the run can be cleanly
  // undone. Keep in sync with lib/db/src/schema/articles.ts (nullable).
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "internal_links_backup" jsonb
  `);
  // Glossary concept enrichment columns (realLifeExample, whatItIsnt, seenInBrainHook, etc.)
  // Source of truth is lib/db/src/schema/concepts.ts; idempotent ADD COLUMN IF NOT EXISTS.
  await db.execute(sql`ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "external_url" text`);
  await db.execute(sql`ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "external_title" text`);
  await db.execute(sql`ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "real_life_example" text`);
  await db.execute(sql`ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "what_it_isnt" text`);
  await db.execute(sql`ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "seen_in_brainhook" jsonb`);
  await db.execute(sql`ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "module_type" text`);
  await db.execute(sql`ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "commonly_misused_online" text`);
  await db.execute(sql`ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "share_image" text`);
  await db.execute(sql`ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "quarantine_reason" text`);
  // Source-gaps table: tracks unsourced claims in published article bodies.
  // Source of truth is lib/db/src/schema/sourceGaps.ts; this idempotent DDL
  // keeps fresh/reset dev DBs in sync without a manual push.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "source_gaps" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "article_id" uuid NOT NULL REFERENCES "articles"("id") ON DELETE CASCADE,
      "claim_text" text NOT NULL,
      "context_text" text NOT NULL,
      "publication_hint" text,
      "year_hint" integer,
      "status" text NOT NULL DEFAULT 'pending',
      "search_query" text,
      "found_url" text,
      "found_title" text,
      "source_document_id" uuid,
      "dismiss_reason" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "source_gaps_article_idx" ON "source_gaps" ("article_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "source_gaps_status_idx" ON "source_gaps" ("status")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "source_gaps_created_idx" ON "source_gaps" ("created_at")`);
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'source_gaps_article_claim_idx'
      ) THEN
        CREATE UNIQUE INDEX "source_gaps_article_claim_idx" ON "source_gaps" ("article_id", "claim_text");
      END IF;
    END $$;
  `);
  await db.execute(sql`ALTER TABLE "source_gaps" ADD COLUMN IF NOT EXISTS "rationale" text`);
  await db.execute(sql`ALTER TABLE "source_gaps" ADD COLUMN IF NOT EXISTS "weaved_at" timestamp with time zone`);
  // Pre-backfill body snapshot for the admin-triggered SOURCE-link (external
  // citation) backfill. Nullable jsonb — set the first time a source-link
  // backfill modifies an article so the run can be cleanly undone, kept distinct
  // from internal_links_backup so the two undos never clobber each other. Keep in
  // sync with lib/db/src/schema/articles.ts (nullable).
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "source_links_backup" jsonb
  `);
  // Branded composite share card (hero + brand gradient + wordmark + title) used
  // for og:image / twitter:image. Nullable text — set when the share card is
  // generated alongside the hero; consumers fall back to `hero_image` when null.
  // Keep in sync with lib/db/src/schema/articles.ts (nullable text).
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "share_image" text
  `);
  // Branded square (1080×1080) feed card attached as the photo on Facebook
  // posts. Nullable text — set alongside the share card when the hero is
  // generated; Facebook posters fall back to share_image then hero_image.
  // Keep in sync with lib/db/src/schema/articles.ts (nullable text).
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "feed_image" text
  `);
  // Optional editor-controlled SEO overrides. Nullable text — when null the site
  // derives a concise title from the headline and a clamped description from the
  // dek. Keep in sync with lib/db/src/schema/articles.ts (nullable text).
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "seo_title" text
  `);
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "seo_description" text
  `);
  // Manual editorial label override (Task #291). Nullable text — when non-null,
  // the public GET /public/articles/:slug endpoint returns this label instead of
  // the auto-derived one. Keep in sync with lib/db/src/schema/articles.ts.
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "editorial_label_override" text
  `);
  // Headline-hook kit columns. All nullable jsonb — `hook_variants` (one entry
  // per hook mode), `hook_assignments` (mode → surface map), `social_pack`
  // (per-platform copy). Backward-compatible: pre-feature rows stay NULL and the
  // site falls back to its deterministic title derivation. Keep in sync with
  // lib/db/src/schema/articles.ts (all nullable jsonb).
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "hook_variants" jsonb
  `);
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "hook_assignments" jsonb
  `);
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "social_pack" jsonb
  `);
  // Evidence lineage columns (Editor Cockpit promotions). Nullable — articles
  // and ideas from the normal author pipeline have neither. Keep in sync with
  // lib/db/src/schema/{articles,topicIdeas}.ts (source of truth). No DB FK,
  // matching the schema (dangling ids are resolved/ignored in app code).
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "evidence_packet_id" uuid
  `);
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "cluster_id" uuid
  `);
  await db.execute(sql`
    ALTER TABLE "topic_ideas" ADD COLUMN IF NOT EXISTS "evidence_packet_id" uuid
  `);
  await db.execute(sql`
    ALTER TABLE "topic_ideas" ADD COLUMN IF NOT EXISTS "cluster_id" uuid
  `);
  // Cross-sectional metadata (Task #258): admin-only "secondary subjects" (beat
  // slugs beyond the primary categorySlug). Nullable text[] on both ideas and
  // articles; never surfaced to readers.
  await db.execute(sql`
    ALTER TABLE "topic_ideas" ADD COLUMN IF NOT EXISTS "secondary_beats" text[]
  `);
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "secondary_beats" text[]
  `);
  // Post-draft evidence verification report (#201). Only written for
  // packet-grounded drafts; matches articles.verificationReport in the schema.
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "verification_report" jsonb
  `);
  // Startup schema guard for the `beats` table. The Drizzle schema in
  // lib/db/src/schema/beats.ts is the source of truth and declares
  // `hero_image_url` (nullable) for per-category AI-generated hero images. A dev
  // DB created before that column (fresh env or post-rollback) would be missing
  // it, so this idempotent ALTER closes the DB-side gap on every boot. Keep in
  // sync with the schema definition (nullable text).
  await db.execute(sql`
    ALTER TABLE "beats" ADD COLUMN IF NOT EXISTS "hero_image_url" text
  `);
  // Optional editor-controlled SEO description override for category pages.
  // Nullable text — when null the site derives one from `description`. Keep in
  // sync with lib/db/src/schema/beats.ts (nullable text).
  await db.execute(sql`
    ALTER TABLE "beats" ADD COLUMN IF NOT EXISTS "seo_description" text
  `);
  // Global, site-wide settings (single row, id = 'global'). Holds flags that
  // apply to every visitor — currently the master on/off switch for ad spots.
  // Keep in sync with lib/db/src/schema/siteSettings.ts (notNull, default true).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "site_settings" (
      "id" text PRIMARY KEY DEFAULT 'global',
      "ads_enabled" boolean NOT NULL DEFAULT true,
      "pipeline_enabled" boolean NOT NULL DEFAULT true,
      "dedupe_scan_enabled" boolean NOT NULL DEFAULT true,
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  // Added after site_settings shipped — backfill the column on existing DBs.
  // Keep in sync with lib/db/src/schema/siteSettings.ts (notNull, default true).
  await db.execute(sql`
    ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "pipeline_enabled" boolean NOT NULL DEFAULT true
  `);
  // Added after pipeline_enabled — master switch for the daily AI dedup scan.
  // Keep in sync with lib/db/src/schema/siteSettings.ts (notNull, default true).
  await db.execute(sql`
    ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "dedupe_scan_enabled" boolean NOT NULL DEFAULT true
  `);
  // Pipeline pause switches for the weekly newsletter blast and the post-pipeline
  // admin editorial digest. Keep in sync with lib/db/src/schema/siteSettings.ts
  // (notNull, default true).
  await db.execute(sql`
    ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "weekly_newsletter_enabled" boolean NOT NULL DEFAULT true
  `);
  await db.execute(sql`
    ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "daily_digest_enabled" boolean NOT NULL DEFAULT true
  `);
  // Pipeline timing / trigger knobs (configurable from /admin/settings). Defaults
  // mirror the previously-hardcoded behavior. Keep in sync with
  // lib/db/src/schema/siteSettings.ts (notNull + default).
  await db.execute(sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "content_active_start_hour" integer NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "content_active_end_hour" integer NOT NULL DEFAULT 23`);
  await db.execute(sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "approved_idea_cap" integer NOT NULL DEFAULT 20`);
  await db.execute(sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "publish_check_minutes" integer NOT NULL DEFAULT 2`);
  await db.execute(sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "auto_approve_enabled" boolean NOT NULL DEFAULT true`);
  await db.execute(sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "auto_approve_hours" integer NOT NULL DEFAULT 48`);
  await db.execute(sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "auto_lock_enabled" boolean NOT NULL DEFAULT true`);
  await db.execute(sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "auto_lock_hours" integer NOT NULL DEFAULT 48`);
  await db.execute(sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "weekly_newsletter_weekday" integer NOT NULL DEFAULT 6`);
  await db.execute(sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "weekly_newsletter_hour" integer NOT NULL DEFAULT 15`);
  await db.execute(sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "dedupe_scan_hour" integer NOT NULL DEFAULT 9`);
  await db.execute(sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "dedupe_scan_frequency" text NOT NULL DEFAULT 'daily'`);
  await db.execute(sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "dedupe_scan_weekday" integer NOT NULL DEFAULT 1`);
  // Per-AI-function control rows for the admin AI Control Center. One row per
  // stable function key (services/aiRegistry.ts); a missing row means
  // "enabled, no directive override". Keep in sync with
  // lib/db/src/schema/aiSettings.ts (enabled notNull default true,
  // directive_override nullable text).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "ai_settings" (
      "key" text PRIMARY KEY,
      "enabled" boolean NOT NULL DEFAULT true,
      "directive_override" text,
      "model_override" text,
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  // Added after ai_settings shipped: per-function model override (null = registry default).
  await db.execute(sql`ALTER TABLE "ai_settings" ADD COLUMN IF NOT EXISTS "model_override" text`);
  // Newsletter signups captured from the public footer form. Keep in sync with
  // lib/db/src/schema/subscribers.ts.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "subscribers" (
      "email" text PRIMARY KEY,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  // Unsubscribe support (see lib/db/src/schema/subscribers.ts). `unsubscribe_token`
  // is added nullable first so existing rows survive, then backfilled with a
  // random token, then promoted to NOT NULL + UNIQUE. `unsubscribed_at` is the
  // soft opt-out marker. All steps are idempotent across boots.
  await db.execute(sql`ALTER TABLE "subscribers" ADD COLUMN IF NOT EXISTS "unsubscribe_token" text`);
  await db.execute(sql`ALTER TABLE "subscribers" ADD COLUMN IF NOT EXISTS "unsubscribed_at" timestamp with time zone`);
  // Use two concatenated UUIDs (core Postgres gen_random_uuid, no pgcrypto
  // extension needed) for a unique 64-char hex token per legacy row.
  await db.execute(
    sql`UPDATE "subscribers" SET "unsubscribe_token" = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') WHERE "unsubscribe_token" IS NULL`,
  );
  await db.execute(sql`ALTER TABLE "subscribers" ALTER COLUMN "unsubscribe_token" SET NOT NULL`);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "subscribers_unsubscribe_token_unique" ON "subscribers" ("unsubscribe_token")`,
  );
  // Reader-chosen topic preference (slug of a `beats` row, NULL = everything).
  // Drives the personalized weekly digest. Nullable, no FK. See
  // lib/db/src/schema/subscribers.ts.
  await db.execute(sql`ALTER TABLE "subscribers" ADD COLUMN IF NOT EXISTS "preferred_category" text`);
  // Hard-suppression markers (bounce / complaint / manual removal), distinct from
  // the soft `unsubscribed_at` opt-out. A suppressed address is excluded from all
  // sends and cannot be silently re-subscribed. See
  // lib/db/src/schema/subscribers.ts.
  await db.execute(sql`ALTER TABLE "subscribers" ADD COLUMN IF NOT EXISTS "suppressed_at" timestamp with time zone`);
  await db.execute(sql`ALTER TABLE "subscribers" ADD COLUMN IF NOT EXISTS "suppression_reason" text`);
  // Inbound Resend (Svix-signed) webhook event log + idempotency ledger that
  // drives suppression. Unique (svix_id, email) makes webhook retries idempotent.
  // Keep in sync with lib/db/src/schema/emailEvents.ts.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "subscriber_email_events" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "svix_id" text NOT NULL,
      "email" text NOT NULL,
      "event_type" text NOT NULL,
      "reason" text,
      "resend_email_id" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "subscriber_email_events_svix_email_unique" ON "subscriber_email_events" ("svix_id", "email")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "subscriber_email_events_email_idx" ON "subscriber_email_events" ("email")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "subscriber_email_events_created_idx" ON "subscriber_email_events" ("created_at")`,
  );
  // Social share clicks captured from the public article Share buttons. Powers
  // the admin "Shares" report. Keep in sync with lib/db/src/schema/shareEvents.ts.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "share_events" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "article_slug" text NOT NULL,
      "article_title" text NOT NULL,
      "platform" text NOT NULL,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "share_events_slug_idx" ON "share_events" ("article_slug")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "share_events_platform_idx" ON "share_events" ("platform")`);
  // Self-hosted article page-view counter. Keep in sync with
  // lib/db/src/schema/pageViews.ts.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "page_views" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "article_slug" text NOT NULL,
      "article_title" text NOT NULL,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "page_views_slug_idx" ON "page_views" ("article_slug")`);
  // Traffic-source attribution columns (added after the table shipped; guard so
  // fresh/rolled-back dev DBs heal without a manual push). Keep in sync with
  // lib/db/src/schema/pageViews.ts.
  await db.execute(sql`ALTER TABLE "page_views" ADD COLUMN IF NOT EXISTS "source" text`);
  await db.execute(sql`ALTER TABLE "page_views" ADD COLUMN IF NOT EXISTS "medium" text`);
  await db.execute(sql`ALTER TABLE "page_views" ADD COLUMN IF NOT EXISTS "campaign" text`);
  await db.execute(sql`ALTER TABLE "page_views" ADD COLUMN IF NOT EXISTS "content" text`);
  await db.execute(sql`ALTER TABLE "page_views" ADD COLUMN IF NOT EXISTS "referrer_host" text`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "page_views_source_idx" ON "page_views" ("source")`);
  // Anonymous reader-journey columns (added after the table shipped; guard so
  // fresh/rolled-back dev DBs heal without a manual push). Keep in sync with
  // lib/db/src/schema/pageViews.ts. No PII — random visitor/session UUIDs only.
  await db.execute(sql`ALTER TABLE "page_views" ADD COLUMN IF NOT EXISTS "visitor_id" text`);
  await db.execute(sql`ALTER TABLE "page_views" ADD COLUMN IF NOT EXISTS "session_id" text`);
  await db.execute(sql`ALTER TABLE "page_views" ADD COLUMN IF NOT EXISTS "previous_slug" text`);
  await db.execute(sql`ALTER TABLE "page_views" ADD COLUMN IF NOT EXISTS "entry_slug" text`);
  await db.execute(sql`ALTER TABLE "page_views" ADD COLUMN IF NOT EXISTS "view_sequence" integer`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "page_views_session_idx" ON "page_views" ("session_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "page_views_visitor_idx" ON "page_views" ("visitor_id")`);
  // Internal recommendation/navigation click events. Powers the admin Reader
  // Journeys report. Keep in sync with lib/db/src/schema/internalClicks.ts.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "internal_clicks" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "visitor_id" text,
      "session_id" text,
      "from_slug" text,
      "to_slug" text NOT NULL,
      "to_title" text,
      "placement" text NOT NULL,
      "recommendation_rank" integer,
      "interaction_type" text NOT NULL DEFAULT 'click',
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "internal_clicks_placement_idx" ON "internal_clicks" ("placement")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "internal_clicks_session_idx" ON "internal_clicks" ("session_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "internal_clicks_to_slug_idx" ON "internal_clicks" ("to_slug")`);
  // Swipe-next prompt lifecycle events (impression/activation/dismissal). Keep
  // in sync with lib/db/src/schema/swipeEvents.ts.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "swipe_events" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "visitor_id" text,
      "session_id" text,
      "article_slug" text NOT NULL,
      "target_slug" text,
      "event_type" text NOT NULL,
      "method" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "swipe_events_type_idx" ON "swipe_events" ("event_type")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "swipe_events_session_idx" ON "swipe_events" ("session_id")`);
  // AI cost meter: one row per billable AI call. Keep in sync with
  // lib/db/src/schema/aiUsage.ts.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "ai_usage_events" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "provider" text NOT NULL,
      "model" text NOT NULL,
      "operation" text NOT NULL,
      "input_tokens" integer NOT NULL DEFAULT 0,
      "output_tokens" integer NOT NULL DEFAULT 0,
      "web_searches" integer NOT NULL DEFAULT 0,
      "images" integer NOT NULL DEFAULT 0,
      "cost_usd" numeric(12,6) NOT NULL DEFAULT 0,
      "author_slug" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "ai_usage_events_created_idx" ON "ai_usage_events" ("created_at")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "ai_usage_events_model_idx" ON "ai_usage_events" ("model")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "ai_usage_events_op_idx" ON "ai_usage_events" ("operation")`);
  await db.execute(sql`ALTER TABLE "ai_usage_events" ADD COLUMN IF NOT EXISTS "article_id" text`);
  await db.execute(sql`ALTER TABLE "ai_usage_events" ADD COLUMN IF NOT EXISTS "meme_id" text`);
  await db.execute(sql`ALTER TABLE "ai_usage_events" ADD COLUMN IF NOT EXISTS "cluster_id" text`);
  await db.execute(sql`ALTER TABLE "ai_usage_events" ADD COLUMN IF NOT EXISTS "packet_id" text`);
  // Source-link mode + audit reason (Task #226). Keep in sync with aiUsage.ts.
  await db.execute(sql`ALTER TABLE "ai_usage_events" ADD COLUMN IF NOT EXISTS "mode" text`);
  await db.execute(sql`ALTER TABLE "ai_usage_events" ADD COLUMN IF NOT EXISTS "reason" text`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "ai_usage_events_article_idx" ON "ai_usage_events" ("article_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "ai_usage_events_meme_idx" ON "ai_usage_events" ("meme_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "ai_usage_events_cluster_idx" ON "ai_usage_events" ("cluster_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "ai_usage_events_packet_idx" ON "ai_usage_events" ("packet_id")`);
  // Shared UTM presets for the admin link builder. Stored server-side so every
  // editor (and the same person on another device) sees the same list. Keep in
  // sync with lib/db/src/schema/utmPresets.ts.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "utm_presets" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "name" text NOT NULL,
      "source" text NOT NULL,
      "medium" text NOT NULL,
      "campaign" text NOT NULL,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  // Trend Radar / Fresh Hook Scout: scouted, source-grounded article hooks the
  // editor judges before drafting. One row per proposed angle. Keep in sync with
  // lib/db/src/schema/trendSignals.ts. The suggested-author FK nulls out if the
  // author is deleted; idea_id/article_id are plain nullable links populated when
  // a signal is drafted so it isn't re-proposed.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "trend_signals" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "beat_slug" text NOT NULL,
      "beat" text NOT NULL,
      "source" text NOT NULL,
      "source_url" text NOT NULL,
      "event" text NOT NULL,
      "headline" text NOT NULL,
      "angle" text NOT NULL,
      "suggested_author_id" uuid REFERENCES "authors"("id") ON DELETE SET NULL,
      "suggested_author_name" text,
      "urgency_score" integer NOT NULL DEFAULT 0,
      "risk_score" integer NOT NULL DEFAULT 0,
      "risk_reason" text,
      "status" text NOT NULL DEFAULT 'new',
      "idea_id" uuid,
      "article_id" uuid,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "trend_signals_status_idx" ON "trend_signals" ("status")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "trend_signals_beat_idx" ON "trend_signals" ("beat_slug")`);
  // One-time migration ledger. Lets boot-time data migrations run exactly once
  // per database (and re-run on a fresh/reset DB, since the marker lives in the
  // same DB). See applyWeeklyRotationMigration.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "app_migrations" (
      "key" text PRIMARY KEY,
      "applied_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);

  // Cron tick job-run ledger. Records the last "period" each scheduled job ran
  // for, so an externally-triggered tick (UptimeRobot ping ~every 5 min, on
  // autoscale) runs each job at most once per its intended period — even with
  // ~12 pings/hour and concurrent instances. claimJobPeriod() (services/cronTick)
  // upserts here under a row lock; only the instance whose period_key actually
  // changes gets a row back and runs the job.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "cron_job_runs" (
      "job" text PRIMARY KEY,
      "period_key" text NOT NULL,
      "ran_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);

  // Background-job state/lock ledger. Unlike cron_job_runs (which gates a job to
  // once-per-period at its START), this row holds the job's running status,
  // live progress (JSONB), and a heartbeat for the FULL DURATION of a heavy job
  // (content pipeline, weekly newsletter, trend scan, social-pack backfill). A
  // heartbeat older than the job's TTL marks a crashed run as stale so a later
  // run can take it over. Replaces the in-memory booleans/progress that were
  // lost on restart and invisible across instances. See services/jobState.ts.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "background_jobs" (
      "job" text PRIMARY KEY,
      "run_id" text,
      "status" text NOT NULL DEFAULT 'idle',
      "started_at" timestamp with time zone,
      "heartbeat_at" timestamp with time zone,
      "finished_at" timestamp with time zone,
      "progress" jsonb,
      "error" text,
      "cancel_requested" boolean NOT NULL DEFAULT false,
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`ALTER TABLE "background_jobs" ADD COLUMN IF NOT EXISTS "run_id" text`);

  // Vault Claim Layer (#447). Keep in sync with lib/db/src/schema/claims.ts.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "vault_claims" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "source_document_id" uuid NOT NULL REFERENCES "source_documents"("id") ON DELETE CASCADE,
      "source_family_id" uuid,
      "source_chunk_ids" uuid[] NOT NULL DEFAULT '{}',
      "claim" text NOT NULL,
      "claim_type" text NOT NULL,
      "subject" text NOT NULL,
      "relationship" text NOT NULL,
      "object" text NOT NULL,
      "context" text,
      "population" text,
      "timeframe" text,
      "geographic_scope" text,
      "qualifiers" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "certainty" text NOT NULL,
      "exact_evidence_span" text NOT NULL,
      "extractor_version" text NOT NULL,
      "status" text NOT NULL DEFAULT 'extracted',
      "override_text" text,
      "reviewed_by" text,
      "reviewed_at" timestamp with time zone,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "vault_claims_document_status_idx" ON "vault_claims" ("source_document_id", "status")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "vault_claims_family_idx" ON "vault_claims" ("source_family_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "vault_claims_created_idx" ON "vault_claims" ("created_at")`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "claim_relationships" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "claim_a_id" uuid NOT NULL REFERENCES "vault_claims"("id") ON DELETE CASCADE,
      "claim_b_id" uuid NOT NULL REFERENCES "vault_claims"("id") ON DELETE CASCADE,
      "relationship_type" text NOT NULL,
      "confidence" real NOT NULL DEFAULT 0,
      "reconciler_model" text NOT NULL,
      "notes" text,
      "reconciled_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "claim_relationships_pair_key" ON "claim_relationships" ("claim_a_id", "claim_b_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "claim_relationships_a_idx" ON "claim_relationships" ("claim_a_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "claim_relationships_b_idx" ON "claim_relationships" ("claim_b_id")`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "article_claim_uses" (
      "article_id" uuid NOT NULL REFERENCES "articles"("id") ON DELETE CASCADE,
      "claim_id" uuid NOT NULL REFERENCES "vault_claims"("id") ON DELETE CASCADE,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "article_claim_uses_key" ON "article_claim_uses" ("article_id", "claim_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "article_claim_uses_claim_idx" ON "article_claim_uses" ("claim_id")`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "claim_extraction_receipts" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "source_document_id" uuid NOT NULL REFERENCES "source_documents"("id") ON DELETE CASCADE,
      "extractor_version" text NOT NULL,
      "content_hash" text,
      "status" text NOT NULL DEFAULT 'succeeded',
      "sections_processed" integer NOT NULL DEFAULT 0,
      "claims_extracted" integer NOT NULL DEFAULT 0,
      "provider" text NOT NULL DEFAULT 'anthropic',
      "error" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "claim_extraction_receipts_document_version_key" ON "claim_extraction_receipts" ("source_document_id", "extractor_version")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "claim_extraction_receipts_status_idx" ON "claim_extraction_receipts" ("status", "updated_at")`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "claim_calibration_runs" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "status" text NOT NULL DEFAULT 'running',
      "documents_sampled" integer NOT NULL DEFAULT 0,
      "sections_processed" integer NOT NULL DEFAULT 0,
      "claims_extracted" integer NOT NULL DEFAULT 0,
      "no_claim_sections" integer NOT NULL DEFAULT 0,
      "invalid_json_count" integer NOT NULL DEFAULT 0,
      "span_verification_failures" integer NOT NULL DEFAULT 0,
      "duplicate_rate" real NOT NULL DEFAULT 0,
      "input_tokens" integer NOT NULL DEFAULT 0,
      "output_tokens" integer NOT NULL DEFAULT 0,
      "cost_usd" real NOT NULL DEFAULT 0,
      "cost_per_source" real NOT NULL DEFAULT 0,
      "cost_per_useful_claim" real NOT NULL DEFAULT 0,
      "error" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "finished_at" timestamp with time zone
    )
  `);
  await db.execute(sql`ALTER TABLE "claim_calibration_runs" ADD COLUMN IF NOT EXISTS "no_claim_documents" integer NOT NULL DEFAULT 0`);
  await db.execute(sql`ALTER TABLE "claim_calibration_runs" ADD COLUMN IF NOT EXISTS "filter_counts" jsonb NOT NULL DEFAULT '{}'::jsonb`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "claim_calibration_results" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "run_id" uuid NOT NULL REFERENCES "claim_calibration_runs"("id") ON DELETE CASCADE,
      "source_document_id" uuid NOT NULL REFERENCES "source_documents"("id") ON DELETE CASCADE,
      "source_chunk_ids" uuid[] NOT NULL DEFAULT '{}',
      "claims" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "input_tokens" integer NOT NULL DEFAULT 0,
      "output_tokens" integer NOT NULL DEFAULT 0,
      "invalid_json" integer NOT NULL DEFAULT 0,
      "span_failures" integer NOT NULL DEFAULT 0,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "claim_calibration_results_run_idx" ON "claim_calibration_results" ("run_id")`);

  // Admin-managed meme template library. Keep in sync with
  // lib/db/src/schema/memeTemplates.ts (source of truth).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "meme_templates" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "name" text NOT NULL,
      "slug" text NOT NULL UNIQUE,
      "image_url" text NOT NULL,
      "layout" text NOT NULL DEFAULT 'classic_top_bottom',
      "source_notes" text NOT NULL DEFAULT '',
      "license_notes" text NOT NULL DEFAULT '',
      "text_areas" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "recommended_field_count" integer NOT NULL DEFAULT 2,
      "default_font" text NOT NULL DEFAULT 'DejaVuSans-Bold',
      "default_alignment" text NOT NULL DEFAULT 'center',
      "active" boolean NOT NULL DEFAULT true,
      "is_curated" boolean NOT NULL DEFAULT false,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);

  // Per-article memes built by an admin. The row doubles as the meme posting
  // queue item (status "queued" after approval). Keep in sync with
  // lib/db/src/schema/memes.ts (source of truth).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "memes" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "article_id" uuid NOT NULL REFERENCES "articles"("id") ON DELETE CASCADE,
      "article_title" text NOT NULL DEFAULT '',
      "article_url" text NOT NULL DEFAULT '',
      "category" text NOT NULL DEFAULT '',
      "concepts" jsonb,
      "selected_concept_index" integer,
      "joke_description" text NOT NULL DEFAULT '',
      "source_type" text NOT NULL DEFAULT 'mainstream_template',
      "template_id" uuid REFERENCES "meme_templates"("id") ON DELETE SET NULL,
      "layout" text NOT NULL DEFAULT 'classic_top_bottom',
      "top_text" text NOT NULL DEFAULT '',
      "bottom_text" text NOT NULL DEFAULT '',
      "extra_text" text NOT NULL DEFAULT '',
      "visual_prompt" text NOT NULL DEFAULT '',
      "original_image_url" text,
      "composed_image_url" text,
      "social_hook" text NOT NULL DEFAULT '',
      "social_summary" text NOT NULL DEFAULT '',
      "social_cta" text NOT NULL DEFAULT '',
      "canonical_url" text NOT NULL DEFAULT '',
      "caption" text NOT NULL DEFAULT '',
      "hashtags" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "status" text NOT NULL DEFAULT 'draft',
      "attempt_count" integer NOT NULL DEFAULT 0,
      "attempt_override" boolean NOT NULL DEFAULT false,
      "allow_public_figures" boolean NOT NULL DEFAULT false,
      "estimated_cost_usd" numeric NOT NULL DEFAULT 0,
      "last_error" text,
      "scheduled_at" timestamp with time zone,
      "approved_at" timestamp with time zone,
      "zernio_request_id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "zernio_post_id" text,
      "facebook_post_url" text,
      "posted_at" timestamp with time zone,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  // Posting-attempt counter, separate from the AI artwork `attempt_count` cap.
  // Added after the initial memes table shipped, so heal existing dev DBs.
  await db.execute(sql`
    ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "post_attempt_count" integer NOT NULL DEFAULT 0
  `);
  // Placement of the optional "extra" caption ("middle" | "bottom"). Added after
  // the memes table shipped, so heal existing dev DBs.
  await db.execute(sql`
    ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "extra_text_position" text NOT NULL DEFAULT 'middle'
  `);
  // Rendering medium for AI artwork ("auto" | "photographic" | "cartoon" |
  // "illustration"). Added after the memes table shipped, so heal existing dev DBs.
  await db.execute(sql`
    ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "art_style" text NOT NULL DEFAULT 'photographic'
  `);
  // Advisory caption-placement hint (clear zones + subject position) for the
  // scene. Nullable. Added after the memes table shipped, so heal existing DBs.
  await db.execute(sql`
    ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "text_placement" jsonb
  `);
  // Up to three optional tag-line IDEAS (suggestions appended to the bottom text;
  // replaces the retired single on-image "extra" caption). Added after the memes
  // table shipped, so heal existing dev DBs.
  await db.execute(sql`
    ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "extra_text_ideas" jsonb NOT NULL DEFAULT '[]'::jsonb
  `);
  await db.execute(sql`
    ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "posted_via_override" boolean NOT NULL DEFAULT false
  `);
  // Manual per-meme caption nudges (pixels) for the classic/split overlay layouts,
  // applied on a free recompose so an admin can fine-tune placement.
  await db.execute(sql`
    ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "caption_top_offset_adj" integer NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "caption_bottom_offset_adj" integer NOT NULL DEFAULT 0
  `);
  // Per-meme caption SIZE adjustments (percent delta) for the overlay layouts,
  // applied on a free recompose so an admin can make a caption bigger/smaller.
  await db.execute(sql`
    ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "caption_top_size_adj" integer NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "caption_bottom_size_adj" integer NOT NULL DEFAULT 0
  `);
  // Per-meme brand-footer placement overrides (corner + pixel nudge for the logo
  // and the brainhook.net mark). Defaults reproduce the automatic footer exactly.
  await db.execute(sql`
    ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "brand_logo_corner" text NOT NULL DEFAULT 'auto'
  `);
  await db.execute(sql`
    ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "brand_url_corner" text NOT NULL DEFAULT 'auto'
  `);
  await db.execute(sql`
    ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "brand_logo_offset_x_adj" integer NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "brand_logo_offset_y_adj" integer NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "brand_url_offset_x_adj" integer NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "brand_url_offset_y_adj" integer NOT NULL DEFAULT 0
  `);
  // Article body-text snapshot captured at build time so deferred caption
  // generation at post time reads the built-from content, not the live (possibly
  // edited/unpublished) article. Nullable; legacy memes fall back to live read.
  await db.execute(sql`
    ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "source_snapshot" text
  `);
  // Prior base+composed artwork versions kept when artwork is regenerated /
  // re-uploaded (see lib/db/src/schema/memes.ts artworkHistory).
  await db.execute(sql`
    ALTER TABLE "memes" ADD COLUMN IF NOT EXISTS "artwork_history" jsonb NOT NULL DEFAULT '[]'::jsonb
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "memes_article_idx" ON "memes" ("article_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "memes_status_idx" ON "memes" ("status")`);

  // Master on/off + pause switches for the daily meme posting cadence. Keep in
  // sync with lib/db/src/schema/siteSettings.ts (notNull, default false).
  await db.execute(sql`
    ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "meme_queue_activated" boolean NOT NULL DEFAULT false
  `);
  await db.execute(sql`
    ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "meme_queue_paused" boolean NOT NULL DEFAULT false
  `);

  // --- Source Vault (Phase 0 spike) ------------------------------------
  // pgvector extension + the vault tables. Source of truth is
  // lib/db/src/schema/sourceVault.ts; this idempotent DDL keeps fresh/reset dev
  // DBs in sync without a manual push. The embedding column is deliberately
  // dimensionless (`vector`, not `vector(N)`) so the embedding size is not
  // hardwired — each chunk records its own model/dimensions. Constraint/index
  // names match the Drizzle schema so a later `drizzle-kit push` sees no diff.
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "source_documents" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "url" text NOT NULL,
      "canonical_url" text,
      "domain" text NOT NULL,
      "title" text,
      "author" text,
      "excerpt" text,
      "published_at" timestamp with time zone,
      "discovered_via" text NOT NULL DEFAULT 'manual_url',
      "lead_snippet" text,
      "http_status" integer,
      "fetched_at" timestamp with time zone,
      "extraction_method" text,
      "extracted_text" text,
      "word_count" integer NOT NULL DEFAULT 0,
      "content_hash" text,
      "quality_score" integer NOT NULL DEFAULT 0,
      "quality_flags" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "status" text NOT NULL DEFAULT 'fetched',
      "chunk_count" integer NOT NULL DEFAULT 0,
      "embedding_provider" text,
      "embedding_model" text,
      "embedding_dimensions" integer,
      "error" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "source_documents_url_key" ON "source_documents" ("url")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "source_documents_status_idx" ON "source_documents" ("status")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "source_documents_domain_idx" ON "source_documents" ("domain")`,
  );
  // Task #197 additive columns (dedup+syndication, fetch policy, lifecycle,
  // authority). All ADD COLUMN IF NOT EXISTS with the same defaults as the
  // Drizzle schema so a later `drizzle-kit push` sees no diff.
  await db.execute(sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "content_simhash" text`);
  await db.execute(sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "duplicate_of_id" uuid`);
  await db.execute(sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "dedupe_reason" text`);
  await db.execute(sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "source_family_id" uuid`);
  await db.execute(sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "robots_status" text`);
  await db.execute(
    sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "fetch_allowed" boolean NOT NULL DEFAULT true`,
  );
  await db.execute(
    sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "paywall_detected" boolean NOT NULL DEFAULT false`,
  );
  await db.execute(
    sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "excerpt_only" boolean NOT NULL DEFAULT false`,
  );
  await db.execute(
    sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "do_not_refetch" boolean NOT NULL DEFAULT false`,
  );
  await db.execute(sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "policy_notes" text`);
  await db.execute(
    sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "lifecycle_status" text NOT NULL DEFAULT 'active'`,
  );
  await db.execute(
    sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "last_checked_at" timestamp with time zone`,
  );
  await db.execute(
    sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "content_changed_at" timestamp with time zone`,
  );
  await db.execute(sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "superseded_by_id" uuid`);
  await db.execute(
    sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "correction_detected" boolean NOT NULL DEFAULT false`,
  );
  await db.execute(
    sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "stale_after" timestamp with time zone`,
  );
  await db.execute(
    sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "authority_tier" text NOT NULL DEFAULT 'unknown'`,
  );
  await db.execute(
    sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "authority_source" text NOT NULL DEFAULT 'auto'`,
  );
  await db.execute(sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "authority_reason" text`);
  // Glossary lane (Task #306): false for internal glossary_concept documents so
  // they are excluded from evidence retrieval but still searchable for concept
  // memory. All other sources default true. NOT NULL so the filter is index-safe.
  await db.execute(
    sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "evidence_eligible" boolean NOT NULL DEFAULT true`,
  );
  // Concept-edge tagger stamp (Task #338): when the deterministic tagger last
  // scanned this document. NULL = untagged (backfill candidate filter).
  await db.execute(
    sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "concept_edges_tagged_at" timestamp with time zone`,
  );
  // Prompt-injection guard: flag documents whose extracted text contained
  // instruction-override patterns. Flagged documents are stored as low_quality
  // and excluded from embedding and drafting pools.
  await db.execute(
    sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "prompt_injection_suspected" boolean NOT NULL DEFAULT false`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "source_documents_lifecycle_idx" ON "source_documents" ("lifecycle_status")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "source_documents_family_idx" ON "source_documents" ("source_family_id")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "source_documents_content_hash_idx" ON "source_documents" ("content_hash")`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "source_chunks" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "document_id" uuid NOT NULL REFERENCES "source_documents"("id") ON DELETE CASCADE,
      "chunk_index" integer NOT NULL,
      "content" text NOT NULL,
      "content_hash" text NOT NULL,
      "char_count" integer NOT NULL DEFAULT 0,
      "embedding" vector,
      "embedding_provider" text NOT NULL,
      "embedding_model" text NOT NULL,
      "dimensions" integer NOT NULL,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "source_chunks_document_idx" ON "source_chunks" ("document_id")`,
  );
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "source_chunks_document_chunk_key" ON "source_chunks" ("document_id", "chunk_index")`,
  );
  // Approximate-nearest-neighbour index for the cosine similarity search. Wrapped
  // so a vector-index build hiccup can never crash boot (the query still works
  // via a sequential scan without it). Partial on the standard 384-dim local
  // embeddings: pgvector can only index uniformly-sized vectors and the column is
  // deliberately dimensionless, so scope it to the dimension the query retrieves.
  try {
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS "source_chunks_embedding_hnsw_idx" ON "source_chunks" USING hnsw ((embedding::vector(384)) vector_cosine_ops) WHERE "dimensions" = 384`,
    );
  } catch (err) {
    logger.warn({ err }, "sourceVault: HNSW embedding index creation skipped (non-fatal)");
  }
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "source_vault_jobs" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "kind" text NOT NULL,
      "status" text NOT NULL DEFAULT 'running',
      "input" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "result" jsonb,
      "cost_usd" text NOT NULL DEFAULT '0',
      "error" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "finished_at" timestamp with time zone
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "source_vault_jobs_created_idx" ON "source_vault_jobs" ("created_at")`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "source_ingest_queue" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "url" text NOT NULL,
      "discovered_via" text NOT NULL DEFAULT 'manual_url',
      "lead_snippet" text,
      "approve_low_quality" boolean NOT NULL DEFAULT false,
      "status" text NOT NULL DEFAULT 'pending',
      "attempts" integer NOT NULL DEFAULT 0,
      "last_error" text,
      "document_id" uuid,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
      "processed_at" timestamp with time zone
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "source_ingest_queue_url_key" ON "source_ingest_queue" ("url")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "source_ingest_queue_status_idx" ON "source_ingest_queue" ("status")`,
  );

  // Task #227 — Feed Registry & Known Source Watcher. Trusted RSS/Atom feeds the
  // newsroom polls to refill the Source Vault (Perplexity is the gap-filler).
  // Both tables are runtime-only; guarded so fresh/reset dev DBs heal without a
  // manual `push`. No DB FK from items → feed (boot-DDL healing + push
  // simplicity, matching the vault convention) — children deleted in app.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "source_feeds" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "url" text NOT NULL,
      "title" text,
      "beat_slug" text NOT NULL,
      "sub_beats" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "enabled" boolean NOT NULL DEFAULT true,
      "poll_interval_minutes" integer NOT NULL DEFAULT 60,
      "etag" text,
      "last_modified" text,
      "last_polled_at" timestamp with time zone,
      "last_success_at" timestamp with time zone,
      "last_status" text,
      "last_error" text,
      "item_count" integer NOT NULL DEFAULT 0,
      "next_poll_at" timestamp with time zone,
      "consecutive_failures" integer NOT NULL DEFAULT 0,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "source_feeds_url_key" ON "source_feeds" ("url")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "source_feeds_enabled_idx" ON "source_feeds" ("enabled")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "source_feeds_next_poll_idx" ON "source_feeds" ("next_poll_at")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "source_feeds_beat_idx" ON "source_feeds" ("beat_slug")`,
  );
  // Task #231 — feed curation: informational "purpose" label + last-poll
  // breakdown snapshot. Additive, nullable columns guarded so fresh/reset dev
  // DBs heal without a manual `push`. Kept in sync with lib/db/src/schema/feeds.ts.
  await db.execute(sql`ALTER TABLE "source_feeds" ADD COLUMN IF NOT EXISTS "purpose" text`);
  await db.execute(
    sql`ALTER TABLE "source_feeds" ADD COLUMN IF NOT EXISTS "filter_include_terms" jsonb NOT NULL DEFAULT '[]'::jsonb`,
  );
  await db.execute(
    sql`ALTER TABLE "source_feeds" ADD COLUMN IF NOT EXISTS "filter_exclude_terms" jsonb NOT NULL DEFAULT '[]'::jsonb`,
  );
  await db.execute(sql`ALTER TABLE "source_feeds" ADD COLUMN IF NOT EXISTS "last_items_seen" integer`);
  await db.execute(sql`ALTER TABLE "source_feeds" ADD COLUMN IF NOT EXISTS "last_items_enqueued" integer`);
  await db.execute(sql`ALTER TABLE "source_feeds" ADD COLUMN IF NOT EXISTS "last_markers_recorded" integer`);
  await db.execute(sql`ALTER TABLE "source_feeds" ADD COLUMN IF NOT EXISTS "last_junk_rejected" integer`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "source_feed_items" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "feed_id" uuid NOT NULL,
      "dedupe_key" text NOT NULL,
      "url" text,
      "title" text,
      "published_at" timestamp with time zone,
      "enqueued" boolean NOT NULL DEFAULT false,
      "discovered_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "source_feed_items_feed_dedupe_key" ON "source_feed_items" ("feed_id", "dedupe_key")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "source_feed_items_feed_idx" ON "source_feed_items" ("feed_id")`,
  );

  // Task #199 — automatic observer: discovery beat-tagging + clustering.
  // Additive columns on source_documents / source_ingest_queue, the
  // story_clusters table, and the per-beat freshness settings columns. All
  // guarded so fresh/reset dev DBs heal without a manual `push`.
  await db.execute(sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "beat_slug" text`);
  await db.execute(sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "cluster_id" uuid`);
  await db.execute(
    sql`ALTER TABLE "source_documents" ADD COLUMN IF NOT EXISTS "clustered_at" timestamp with time zone`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "source_documents_cluster_idx" ON "source_documents" ("cluster_id")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "source_documents_beat_idx" ON "source_documents" ("beat_slug")`,
  );
  await db.execute(sql`ALTER TABLE "source_ingest_queue" ADD COLUMN IF NOT EXISTS "beat_slug" text`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "story_clusters" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "beat_slug" text NOT NULL,
      "beat" text NOT NULL,
      "label" text NOT NULL,
      "keywords" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "status" text NOT NULL DEFAULT 'active',
      "score" integer NOT NULL DEFAULT 0,
      "score_breakdown" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "source_count" integer NOT NULL DEFAULT 0,
      "family_count" integer NOT NULL DEFAULT 0,
      "domain_count" integer NOT NULL DEFAULT 0,
      "top_authority_tier" text,
      "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
      "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
      "fresh_until" timestamp with time zone,
      "coverage_status" text NOT NULL DEFAULT 'open',
      "coverage_reason" text,
      "coverage_resurface_after" timestamp with time zone,
      "covered_article_id" uuid,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "story_clusters_beat_idx" ON "story_clusters" ("beat_slug")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "story_clusters_status_idx" ON "story_clusters" ("status")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "story_clusters_score_idx" ON "story_clusters" ("score")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "story_clusters_coverage_idx" ON "story_clusters" ("coverage_status")`,
  );
  // Velocity signal: how many attached trend markers (social buzz) a cluster has.
  // Feeds the score's velocity component; never satisfies the authority floor.
  await db.execute(
    sql`ALTER TABLE "story_clusters" ADD COLUMN IF NOT EXISTS "marker_count" integer NOT NULL DEFAULT 0`,
  );
  // Trend markers (Task #227): weak SOCIAL observations (YouTube/Reddit/X/TikTok…)
  // recorded for public-interest/velocity signal ONLY — never fetched, chunked,
  // or embedded, and they can never clear the evidence authority floor. Kept in
  // sync with lib/db/src/schema/trendMarkers.ts (source of truth).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "trend_markers" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "url" text NOT NULL,
      "domain" text NOT NULL,
      "platform" text NOT NULL DEFAULT 'other',
      "title" text,
      "snippet" text,
      "beat_slug" text,
      "cluster_id" uuid,
      "status" text NOT NULL DEFAULT 'observed',
      "discovered_via" text NOT NULL DEFAULT 'perplexity_search',
      "observation_count" integer NOT NULL DEFAULT 1,
      "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
      "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
      "escalated_at" timestamp with time zone,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT "trend_markers_url_unique" UNIQUE ("url")
    )
  `);
  // Hot-marker source harvest (Task #236): investigation timestamp (cooldown
  // clock) + short human-readable result summary. Keep in sync with
  // lib/db/src/schema/trendMarkers.ts (both nullable).
  await db.execute(
    sql`ALTER TABLE "trend_markers" ADD COLUMN IF NOT EXISTS "investigated_at" timestamp with time zone`,
  );
  await db.execute(
    sql`ALTER TABLE "trend_markers" ADD COLUMN IF NOT EXISTS "harvest_summary" text`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "trend_markers_status_idx" ON "trend_markers" ("status")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "trend_markers_cluster_idx" ON "trend_markers" ("cluster_id")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "trend_markers_beat_idx" ON "trend_markers" ("beat_slug")`,
  );
  // Rejected junk (Task #227): aggregator / link-farm leads (MSN/Yahoo/Google
  // News/Taboola/Outbrain/BuzzFeed…) dropped from discovery, logged thin for
  // admin transparency only. Kept in sync with the same schema module.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "rejected_sources" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "url" text NOT NULL,
      "domain" text NOT NULL,
      "reason" text NOT NULL,
      "beat_slug" text,
      "discovered_via" text NOT NULL DEFAULT 'perplexity_search',
      "observation_count" integer NOT NULL DEFAULT 1,
      "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
      "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT "rejected_sources_url_unique" UNIQUE ("url")
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "rejected_sources_domain_idx" ON "rejected_sources" ("domain")`,
  );
  // Article ↔ source graph (Task #228): one row per (article, canonical outbound
  // URL) harvested from an article body. Makes the article→source relationship
  // first-class (previously links lived only inside body markdown). Kept in sync
  // with lib/db/src/schema/articleSources.ts (source of truth).
  await db.execute(
    sql`ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "sources_harvested_at" timestamp with time zone`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "article_sources" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "article_id" uuid NOT NULL REFERENCES "articles"("id") ON DELETE CASCADE,
      "url" text NOT NULL,
      "domain" text NOT NULL,
      "role" text NOT NULL,
      "tier" text NOT NULL DEFAULT 'unknown',
      "status" text NOT NULL,
      "source_document_id" uuid,
      "anchor_text" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT "article_sources_article_url_key" UNIQUE ("article_id", "url")
    )
  `);
  // Citation snapshot columns (real-source bibliographic metadata for the
  // public References list). Keep in sync with lib/db/src/schema/articleSources.ts.
  await db.execute(sql`ALTER TABLE "article_sources" ADD COLUMN IF NOT EXISTS "source_title" text`);
  await db.execute(sql`ALTER TABLE "article_sources" ADD COLUMN IF NOT EXISTS "source_authors" text`);
  await db.execute(sql`ALTER TABLE "article_sources" ADD COLUMN IF NOT EXISTS "publisher_name" text`);
  await db.execute(
    sql`ALTER TABLE "article_sources" ADD COLUMN IF NOT EXISTS "source_published_at" timestamp with time zone`,
  );
  await db.execute(sql`ALTER TABLE "article_sources" ADD COLUMN IF NOT EXISTS "canonical_url" text`);
  await db.execute(sql`ALTER TABLE "article_sources" ADD COLUMN IF NOT EXISTS "doi" text`);
  await db.execute(
    sql`ALTER TABLE "article_sources" ADD COLUMN IF NOT EXISTS "accessed_at" timestamp with time zone`,
  );
  // Citation note (Task #273): one AI sentence per (article, source) on why the
  // source is included; note_generated_at stamps attempts so re-runs skip rows.
  await db.execute(sql`ALTER TABLE "article_sources" ADD COLUMN IF NOT EXISTS "citation_note" text`);
  await db.execute(
    sql`ALTER TABLE "article_sources" ADD COLUMN IF NOT EXISTS "note_generated_at" timestamp with time zone`,
  );
  // Rejection reason (Task #274): machine-readable reason a row was rejected
  // ('duplicate_title', 'junk_link', 'manual'). NULL on non-rejected rows.
  await db.execute(sql`ALTER TABLE "article_sources" ADD COLUMN IF NOT EXISTS "rejection_reason" text`);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "article_sources_article_idx" ON "article_sources" ("article_id")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "article_sources_document_idx" ON "article_sources" ("source_document_id")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "article_sources_url_idx" ON "article_sources" ("url")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "article_sources_role_idx" ON "article_sources" ("role")`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "evidence_packets" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "cluster_id" uuid NOT NULL,
      "version" integer NOT NULL,
      "beat_slug" text NOT NULL,
      "beat" text NOT NULL,
      "label" text NOT NULL,
      "decision" text NOT NULL,
      "decision_reasons" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "do_not_draft_reason" text,
      "research_mode" text NOT NULL DEFAULT 'vault_only',
      "model" text NOT NULL,
      "sources" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "supporting_chunks" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "claims" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "contradictions" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "quote_candidates" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "retrieval_context" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "sources_fingerprint" text NOT NULL DEFAULT '',
      "source_count" integer NOT NULL DEFAULT 0,
      "top_authority_tier" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "evidence_packets_cluster_version_key" ON "evidence_packets" ("cluster_id", "version")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "evidence_packets_cluster_idx" ON "evidence_packets" ("cluster_id")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "evidence_packets_decision_idx" ON "evidence_packets" ("decision")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "evidence_packets_created_idx" ON "evidence_packets" ("created_at")`,
  );
  // Editorial review actions (Task #202): the durable, structured record of every
  // one-click reject / promote an editor makes in the cockpit — the only NEW
  // recorded data in the shadow-metrics chunk (all other metrics aggregate from
  // tables that already record their outcomes). Keep in sync with
  // lib/db/src/schema/editorialReviewActions.ts.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "editorial_review_actions" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "cluster_id" uuid NOT NULL,
      "packet_id" uuid,
      "surface" text NOT NULL,
      "action" text NOT NULL,
      "rejection_reason" text,
      "promoted_idea_id" uuid,
      "note" text,
      "created_by" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "editorial_review_actions_created_idx" ON "editorial_review_actions" ("created_at")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "editorial_review_actions_action_idx" ON "editorial_review_actions" ("action")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "editorial_review_actions_reason_idx" ON "editorial_review_actions" ("rejection_reason")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "editorial_review_actions_cluster_idx" ON "editorial_review_actions" ("cluster_id")`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "source_discovery_enabled" boolean NOT NULL DEFAULT false`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "source_freshness_default_days" integer NOT NULL DEFAULT 7`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "source_freshness_by_beat" jsonb NOT NULL DEFAULT '{}'::jsonb`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "source_discovery_allowed_domains" jsonb NOT NULL DEFAULT '[]'::jsonb`,
  );
  // Hot-marker source harvest (Task #236). Keep in sync with
  // lib/db/src/schema/siteSettings.ts (notNull; default off / 3 / 2).
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "hot_marker_harvest_enabled" boolean NOT NULL DEFAULT false`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "hot_marker_observation_threshold" integer NOT NULL DEFAULT 3`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "hot_marker_platform_threshold" integer NOT NULL DEFAULT 2`,
  );
  // Source-link insertion strategy (Task #226). Keep in sync with
  // lib/db/src/schema/siteSettings.ts (notNull, default vault_first_with_capped_search).
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "source_link_insertion_mode" text NOT NULL DEFAULT 'vault_first_with_capped_search'`,
  );
  // Draft research mode (Task #233). Keep in sync with
  // lib/db/src/schema/siteSettings.ts (notNull, default vault_first_harvest_if_needed).
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "draft_research_mode" text NOT NULL DEFAULT 'vault_first_harvest_if_needed'`,
  );
  // Per-idea draft grounding outcome (Task #233). Nullable — set once an idea
  // has been through the draft path. Keep in sync with lib/db/src/schema/topicIdeas.ts.
  await db.execute(
    sql`ALTER TABLE "topic_ideas" ADD COLUMN IF NOT EXISTS "draft_grounding_outcome" text`,
  );

  // ── Concept Explainer & Glossary (Task #284) ──────────────────────────────
  // Keep table DDL in sync with lib/db/src/schema/concepts.ts.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "concepts" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "slug" text NOT NULL UNIQUE,
      "term" text NOT NULL,
      "hover_definition" text NOT NULL DEFAULT '',
      "definition" text NOT NULL DEFAULT '',
      "wiki_page_id" integer,
      "wiki_url" text,
      "wiki_title" text,
      "wiki_extract" text,
      "wiki_rev_id" integer,
      "detection_confidence" real NOT NULL DEFAULT 0,
      "definition_confidence" real NOT NULL DEFAULT 0,
      "status" text NOT NULL DEFAULT 'draft',
      "article_count" integer NOT NULL DEFAULT 0,
      "last_processed_at" timestamp,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  // Heal any tables created before hover_definition was added.
  await db.execute(
    sql`ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "hover_definition" text NOT NULL DEFAULT ''`,
  );
  // Heal concepts created before wiki_rev_id (Wikipedia revision-change refresh).
  await db.execute(
    sql`ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "wiki_rev_id" integer`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "concept_aliases" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "concept_id" uuid NOT NULL REFERENCES "concepts" ("id") ON DELETE CASCADE,
      "alias" text NOT NULL,
      "is_primary" boolean NOT NULL DEFAULT false,
      "created_at" timestamp NOT NULL DEFAULT now(),
      UNIQUE ("concept_id", "alias")
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "article_concept_mentions" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "article_id" uuid NOT NULL REFERENCES "articles" ("id") ON DELETE CASCADE,
      "concept_id" uuid NOT NULL REFERENCES "concepts" ("id") ON DELETE CASCADE,
      "matched_term" text NOT NULL,
      "paragraph_index" integer NOT NULL,
      "paragraph_hash" text NOT NULL DEFAULT '',
      "sentence_hash" text NOT NULL DEFAULT '',
      "context_snippet" text NOT NULL DEFAULT '',
      "confidence" real NOT NULL DEFAULT 0,
      "created_at" timestamp NOT NULL DEFAULT now(),
      UNIQUE ("article_id", "concept_id")
    )
  `);
  // Heal mention rows created before the paragraph/sentence hash + context
  // columns were added (mention anchoring, spec step 1).
  await db.execute(
    sql`ALTER TABLE "article_concept_mentions" ADD COLUMN IF NOT EXISTS "paragraph_hash" text NOT NULL DEFAULT ''`,
  );
  await db.execute(
    sql`ALTER TABLE "article_concept_mentions" ADD COLUMN IF NOT EXISTS "sentence_hash" text NOT NULL DEFAULT ''`,
  );
  await db.execute(
    sql`ALTER TABLE "article_concept_mentions" ADD COLUMN IF NOT EXISTS "context_snippet" text NOT NULL DEFAULT ''`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "concept_processing_runs" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "article_id" uuid NOT NULL REFERENCES "articles" ("id") ON DELETE CASCADE,
      "status" text NOT NULL,
      "concepts_found" integer NOT NULL DEFAULT 0,
      "mentions_created" integer NOT NULL DEFAULT 0,
      "model" text NOT NULL DEFAULT '',
      "error_message" text,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  // Heal concept_processing_runs table to add content_hash column (added after initial table creation)
  await db.execute(
    sql`ALTER TABLE "concept_processing_runs" ADD COLUMN IF NOT EXISTS "content_hash" text`,
  );
  // Skipped-candidate oversight (admin run history shows what was filtered and why)
  await db.execute(
    sql`ALTER TABLE "concept_processing_runs" ADD COLUMN IF NOT EXISTS "skipped_candidates" jsonb NOT NULL DEFAULT '[]'::jsonb`,
  );
  // Per-article Concept Explainer kill-switch
  await db.execute(
    sql`ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "concept_explainers_disabled" boolean NOT NULL DEFAULT false`,
  );
  // Curated concept-to-concept relationships (admin-managed). Source of truth
  // is lib/db/src/schema/concepts.ts (conceptRelationshipsTable).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "concept_relationships" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "from_concept_id" uuid NOT NULL REFERENCES "concepts" ("id") ON DELETE CASCADE,
      "to_concept_id" uuid NOT NULL REFERENCES "concepts" ("id") ON DELETE CASCADE,
      "relation_type" text NOT NULL,
      "note" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "concept_relationships_from_idx" ON "concept_relationships" ("from_concept_id")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "concept_relationships_to_idx" ON "concept_relationships" ("to_concept_id")`,
  );
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "concept_relationships_unique" ON "concept_relationships" ("from_concept_id", "to_concept_id", "relation_type")`,
  );
  // Concept sources — links concepts to the Source Vault / Wikipedia documents
  // that grounded their definitions. Separate from concept_processing_runs which
  // tracks pipeline runs; this tracks per-source evidence provenance.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "concept_sources" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "concept_id" uuid NOT NULL REFERENCES "concepts" ("id") ON DELETE CASCADE,
      "source_url" text NOT NULL,
      "source_type" text NOT NULL,
      "relevance_score" real NOT NULL DEFAULT 1.0,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "concept_sources_concept_idx" ON "concept_sources" ("concept_id")`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS "concept_sources_unique" ON "concept_sources" ("concept_id", "source_url")`);
  // claim_relevant — added post-launch to track per-source claim relevance.
  // null = legacy/unverified row (still shown publicly); true = confirmed;
  // false = filtered out (hidden from public trail).
  await db.execute(sql`ALTER TABLE "concept_sources" ADD COLUMN IF NOT EXISTS "claim_relevant" boolean`);
  // Source-to-concept edges (Task #338) — deterministic links between vault
  // documents and glossary concepts. Keep DDL in sync with
  // lib/db/src/schema/sourceVault.ts (source of truth) so `drizzle-kit push`
  // sees "No changes detected" against a seed-created table.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "source_concept_edges" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "source_document_id" uuid NOT NULL REFERENCES "source_documents" ("id") ON DELETE CASCADE,
      "concept_id" uuid NOT NULL REFERENCES "concepts" ("id") ON DELETE CASCADE,
      "confidence" real NOT NULL DEFAULT 0,
      "matched_sections" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "source_concept_edges_unique" ON "source_concept_edges" ("source_document_id", "concept_id")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "source_concept_edges_concept_idx" ON "source_concept_edges" ("concept_id")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "source_concept_edges_document_idx" ON "source_concept_edges" ("source_document_id")`,
  );
  // Concept-to-beat affinity weights — deterministic weighted beat profile per
  // concept (article/source/relationship signals + blended weight). Keep DDL
  // in sync with lib/db/src/schema/concepts.ts (source of truth).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "concept_beat_affinities" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "concept_id" uuid NOT NULL REFERENCES "concepts" ("id") ON DELETE CASCADE,
      "beat_slug" text NOT NULL,
      "weight" real NOT NULL DEFAULT 0,
      "article_signal" real NOT NULL DEFAULT 0,
      "source_signal" real NOT NULL DEFAULT 0,
      "relationship_signal" real NOT NULL DEFAULT 0,
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "concept_beat_affinities_unique" ON "concept_beat_affinities" ("concept_id", "beat_slug")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "concept_beat_affinities_concept_idx" ON "concept_beat_affinities" ("concept_id")`,
  );
  // Cross-Beat Radar & Evidence Health (Task #340). Keep DDL in sync with
  // lib/db/src/schema/conceptRadar.ts (source of truth).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "cross_beat_radar_suggestions" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "concept_id" uuid NOT NULL REFERENCES "concepts" ("id") ON DELETE CASCADE,
      "concept_term" text NOT NULL,
      "concept_slug" text NOT NULL,
      "dedupe_key" text NOT NULL,
      "primary_beat_slug" text NOT NULL,
      "secondary_beat_slugs" text[] NOT NULL,
      "title" text NOT NULL,
      "angle" text NOT NULL,
      "score" real NOT NULL DEFAULT 0,
      "bridge_beats" jsonb,
      "evidence_snapshot" jsonb,
      "status" text NOT NULL DEFAULT 'pending',
      "skip_reason" text,
      "idea_id" uuid REFERENCES "topic_ideas" ("id") ON DELETE SET NULL,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "cross_beat_radar_suggestions_dedupe_unique" ON "cross_beat_radar_suggestions" ("dedupe_key")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "cross_beat_radar_suggestions_status_idx" ON "cross_beat_radar_suggestions" ("status")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "cross_beat_radar_suggestions_concept_idx" ON "cross_beat_radar_suggestions" ("concept_id")`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "concept_evidence_health" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "concept_id" uuid NOT NULL REFERENCES "concepts" ("id") ON DELETE CASCADE,
      "active_trusted_count" integer NOT NULL DEFAULT 0,
      "independent_family_count" integer NOT NULL DEFAULT 0,
      "newest_evidence_at" timestamp with time zone,
      "retracted_linked_count" integer NOT NULL DEFAULT 0,
      "article_mention_count" integer NOT NULL DEFAULT 0,
      "demand_views_30d" integer NOT NULL DEFAULT 0,
      "computed_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "concept_evidence_health_concept_unique" ON "concept_evidence_health" ("concept_id")`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "concept_health_alerts" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "concept_id" uuid NOT NULL REFERENCES "concepts" ("id") ON DELETE CASCADE,
      "concept_term" text NOT NULL,
      "concept_slug" text NOT NULL,
      "alert_type" text NOT NULL,
      "dedupe_key" text NOT NULL,
      "status" text NOT NULL DEFAULT 'open',
      "detail" jsonb,
      "idea_id" uuid REFERENCES "topic_ideas" ("id") ON DELETE SET NULL,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "concept_health_alerts_dedupe_unique" ON "concept_health_alerts" ("dedupe_key")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "concept_health_alerts_status_idx" ON "concept_health_alerts" ("status")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "concept_health_alerts_concept_idx" ON "concept_health_alerts" ("concept_id")`,
  );

  // Concept Explainer site_settings columns. Keep in sync with
  // lib/db/src/schema/siteSettings.ts.
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "concept_explainers_enabled" boolean NOT NULL DEFAULT true`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "concept_detection_threshold" real NOT NULL DEFAULT 0.72`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "concept_definition_threshold" real NOT NULL DEFAULT 0.78`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "concept_density_max_default" integer NOT NULL DEFAULT 8`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "concept_density_max_long" integer NOT NULL DEFAULT 12`,
  );

  // ---- Term of the Day (daily glossary post to Facebook via Zernio) --------
  // Keep table DDL in sync with lib/db/src/schema/termOfDay.ts (source of
  // truth). Types/index names/predicates must match EXACTLY so `drizzle-kit
  // push` sees "No changes detected" against a seed-created table.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "term_of_day_posts" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "concept_id" uuid NOT NULL REFERENCES "concepts" ("id") ON DELETE CASCADE,
      "slug" text NOT NULL,
      "term" text NOT NULL,
      "beat_slug" text NOT NULL DEFAULT '',
      "post_date" text NOT NULL,
      "caption" text NOT NULL DEFAULT '',
      "hashtags" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "tracked_url" text NOT NULL DEFAULT '',
      "image_url" text,
      "related_article_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "rewritten_caption" text,
      "selection_weight" real NOT NULL DEFAULT 0,
      "weight_breakdown" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "status" text NOT NULL DEFAULT 'posting',
      "failure_reason" text,
      "zernio_request_id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "zernio_post_id" text,
      "facebook_post_url" text,
      "clicks" integer,
      "reactions" integer,
      "comments" integer,
      "shares" integer,
      "total_engagement" integer,
      "selected_at" timestamp with time zone NOT NULL DEFAULT now(),
      "scheduled_at" timestamp with time zone,
      "posted_at" timestamp with time zone,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
      "slot" integer NOT NULL DEFAULT 1
    )
  `);
  // Daily slot column (1 = primary hour, 2 = second hour); heal older tables
  // created before the 2x/day upgrade.
  await db.execute(
    sql`ALTER TABLE "term_of_day_posts" ADD COLUMN IF NOT EXISTS "slot" integer NOT NULL DEFAULT 1`,
  );
  // Partial unique = the per-slot idempotency claim: at most one non-failed
  // row per UTC (date, slot), so concurrent/retried runs can never double-post
  // a slot. Replaces the old per-date-only index from the 1x/day era.
  await db.execute(
    sql`DROP INDEX IF EXISTS "term_of_day_posts_date_active_uniq"`,
  );
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS "term_of_day_posts_date_slot_active_uniq" ON "term_of_day_posts" ("post_date", "slot") WHERE "status" <> 'failed'`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "term_of_day_posts_concept_idx" ON "term_of_day_posts" ("concept_id")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "term_of_day_posts_status_idx" ON "term_of_day_posts" ("status")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "term_of_day_posts_posted_at_idx" ON "term_of_day_posts" ("posted_at")`,
  );
  // Term of the Day site_settings columns. Keep in sync with
  // lib/db/src/schema/siteSettings.ts.
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "term_of_day_enabled" boolean NOT NULL DEFAULT false`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "term_of_day_draft_only" boolean NOT NULL DEFAULT false`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "term_of_day_hour_utc" integer NOT NULL DEFAULT 18`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "term_of_day_hour2_utc" integer DEFAULT 1`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "term_of_day_cooldown_days" integer NOT NULL DEFAULT 365`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "term_of_day_min_articles" integer NOT NULL DEFAULT 1`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "term_of_day_max_hashtags" integer NOT NULL DEFAULT 7`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "term_of_day_included_beats" jsonb NOT NULL DEFAULT '[]'::jsonb`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "term_of_day_excluded_beats" jsonb NOT NULL DEFAULT '[]'::jsonb`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "term_of_day_excluded_module_types" jsonb NOT NULL DEFAULT '[]'::jsonb`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "term_of_day_image_enabled" boolean NOT NULL DEFAULT true`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "term_of_day_general_interest_strength" real NOT NULL DEFAULT 1`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "term_of_day_technical_penalty_strength" real NOT NULL DEFAULT 1`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "term_of_day_beat_window" integer NOT NULL DEFAULT 14`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "term_of_day_engagement_weighting" boolean NOT NULL DEFAULT true`,
  );

  // Source retraction impact tracking (Task #329). When a Source Vault document
  // transitions to a non-active lifecycle status the cascade service flags every
  // article that cited it via article_sources.
  await db.execute(sql`ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "retraction_impact_at" timestamp with time zone`);
  await db.execute(sql`ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "retraction_impact_cleared_at" timestamp with time zone`);
  // Evidence packets may contain sources that later become non-active; this flag
  // marks packets whose source snapshot has been affected.
  await db.execute(sql`ALTER TABLE "evidence_packets" ADD COLUMN IF NOT EXISTS "stale_packet" boolean NOT NULL DEFAULT false`);
  // Glossary concepts whose vault sources are all non-active get flagged for
  // editor review.
  await db.execute(sql`ALTER TABLE "concepts" ADD COLUMN IF NOT EXISTS "concept_retraction_flag" boolean NOT NULL DEFAULT false`);
  // Impact ledger: one row per (source_document, article) pair, inserted by the
  // cascade when a source transitions to non-active.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "source_retraction_impacts" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "source_document_id" uuid NOT NULL,
      "article_id" uuid NOT NULL REFERENCES "articles"("id") ON DELETE CASCADE,
      "lifecycle_status" text NOT NULL,
      "impacted_at" timestamp with time zone NOT NULL DEFAULT now(),
      "rescan_attempted_at" timestamp with time zone,
      "rescan_result" text,
      CONSTRAINT "source_retraction_impacts_source_article_key" UNIQUE ("source_document_id", "article_id")
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "source_retraction_impacts_source_idx" ON "source_retraction_impacts" ("source_document_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "source_retraction_impacts_article_idx" ON "source_retraction_impacts" ("article_id")`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS "source_retraction_impacts_impacted_idx" ON "source_retraction_impacts" ("impacted_at")`);

  // Semantic cluster reconciler (Task #330). After each lexical clustering
  // pass an LLM judge evaluates borderline pairs (Jaccard 0.08–0.18 within the
  // same beat). Confirmed same-story pairs are merged and the smaller cluster
  // is archived. Two new tables + one column on story_clusters + one column on
  // site_settings. All guarded so fresh/reset dev DBs heal without a push.
  await db.execute(
    sql`ALTER TABLE "story_clusters" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "cluster_pair_verdicts" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "cluster_a_id" uuid NOT NULL,
      "cluster_b_id" uuid NOT NULL,
      "verdict" text NOT NULL,
      "rationale" text,
      "keyword_hash_a" text NOT NULL,
      "keyword_hash_b" text NOT NULL,
      "judged_at" timestamp with time zone NOT NULL DEFAULT now(),
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT "cluster_pair_verdicts_pair_key" UNIQUE ("cluster_a_id", "cluster_b_id")
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "cluster_pair_verdicts_a_idx" ON "cluster_pair_verdicts" ("cluster_a_id")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "cluster_pair_verdicts_b_idx" ON "cluster_pair_verdicts" ("cluster_b_id")`,
  );
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "cluster_merges" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "merged_from_cluster_id" uuid NOT NULL,
      "merged_from_label" text NOT NULL,
      "merged_into_cluster_id" uuid NOT NULL,
      "merged_into_label" text NOT NULL,
      "beat_slug" text NOT NULL,
      "beat" text NOT NULL,
      "rationale" text,
      "members_reassigned" integer NOT NULL DEFAULT 0,
      "judged_at" timestamp with time zone NOT NULL DEFAULT now(),
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "cluster_merges_beat_idx" ON "cluster_merges" ("beat_slug")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "cluster_merges_created_idx" ON "cluster_merges" ("created_at")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "cluster_merges_into_idx" ON "cluster_merges" ("merged_into_cluster_id")`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "semantic_cluster_reconcile_enabled" boolean NOT NULL DEFAULT false`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "reconcile_jaccard_low" real NOT NULL DEFAULT 0.08`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "reconcile_jaccard_high" real NOT NULL DEFAULT 0.18`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "trend_auto_inject_enabled" boolean NOT NULL DEFAULT false`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "trend_auto_inject_min_urgency" integer NOT NULL DEFAULT 5`,
  );
  await db.execute(
    sql`ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "publish_gate_dedupe_enabled" boolean NOT NULL DEFAULT true`,
  );
  // Vault re-sort snapshots: one row per phase checkpoint (pre_a/pre_b/pre_c)
  // taken during a re-sort run; held on failure, auto-deleted on success.
  // Kept in sync with lib/db/src/schema/storyClusters.ts (source of truth).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "vault_resort_snapshots" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "run_id" text NOT NULL,
      "snapshot_type" text NOT NULL,
      "cluster_count" integer NOT NULL DEFAULT 0,
      "doc_count" integer NOT NULL DEFAULT 0,
      "verdict_count" integer NOT NULL DEFAULT 0,
      "clusters_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "doc_assignments_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "pair_verdicts_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "vault_resort_snapshots_run_idx" ON "vault_resort_snapshots" ("run_id")`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS "vault_resort_snapshots_type_idx" ON "vault_resort_snapshots" ("snapshot_type")`,
  );
  // Run-outcome stamping (finished-run badge + 72h auto-expiry) — added after
  // the table shipped, so heal older DBs in place.
  await db.execute(
    sql`ALTER TABLE "vault_resort_snapshots" ADD COLUMN IF NOT EXISTS "run_outcome" text`,
  );
  await db.execute(
    sql`ALTER TABLE "vault_resort_snapshots" ADD COLUMN IF NOT EXISTS "run_finished_at" timestamp with time zone`,
  );
}

// Curated meme template formats. We cannot embed copyrighted meme screenshots,
// so each "format" ships with an ORIGINAL BrainHook base canvas (generated by
// generateTemplateBaseCanvas) and its text-area geometry. license_notes record
// that the base is original artwork; an admin can replace the base with a
// rights-held image via upload. Re-seeding heals these (is_curated) rows without
// clobbering admin-authored templates.
interface CuratedTemplateSeed {
  slug: string;
  name: string;
  layout: MemeLayout;
  sourceNotes: string;
  recommendedFieldCount: number;
  textAreas: MemeTextArea[];
}

const CURATED_MEME_TEMPLATES: CuratedTemplateSeed[] = [
  {
    slug: "classic-impact",
    name: "Classic Impact (Top / Bottom)",
    layout: "classic_top_bottom",
    sourceNotes: "The universal top-text/bottom-text meme format.",
    recommendedFieldCount: 2,
    textAreas: [
      { key: "top", label: "Top text", x: 0.05, y: 0.04, width: 0.9, height: 0.24, fontSize: 0.1, align: "center", valign: "top", color: "white", outline: true, uppercase: true },
      { key: "bottom", label: "Bottom text", x: 0.05, y: 0.72, width: 0.9, height: 0.24, fontSize: 0.1, align: "center", valign: "bottom", color: "white", outline: true, uppercase: true },
    ],
  },
  {
    slug: "two-panel-compare",
    name: "Two-Panel Comparison",
    layout: "split_panel",
    sourceNotes: "Stacked comparison format (this vs. that).",
    recommendedFieldCount: 2,
    textAreas: [
      { key: "top", label: "Top panel", x: 0.05, y: 0.1, width: 0.9, height: 0.2, fontSize: 0.07, align: "center", valign: "middle", color: "white", outline: false, uppercase: true },
      { key: "bottom", label: "Bottom panel", x: 0.05, y: 0.7, width: 0.9, height: 0.2, fontSize: 0.07, align: "center", valign: "middle", color: "white", outline: false, uppercase: true },
    ],
  },
  {
    slug: "headline-explainer",
    name: "Headline + Caption",
    layout: "headline_caption",
    sourceNotes: "Photo with a headline and explainer caption panel below.",
    recommendedFieldCount: 2,
    textAreas: [],
  },
];

async function seedMemeTemplates(): Promise<void> {
  for (const tpl of CURATED_MEME_TEMPLATES) {
    const existing = await db
      .select({ id: memeTemplatesTable.id })
      .from(memeTemplatesTable)
      .where(eq(memeTemplatesTable.slug, tpl.slug))
      .limit(1);
    if (existing.length > 0) continue;
    let imageUrl: string;
    try {
      imageUrl = await generateTemplateBaseCanvas(tpl.slug, tpl.layout);
    } catch (err) {
      logger.warn({ err, slug: tpl.slug }, "Failed to generate meme template base canvas; skipping seed");
      continue;
    }
    await db.insert(memeTemplatesTable).values({
      name: tpl.name,
      slug: tpl.slug,
      imageUrl,
      layout: tpl.layout,
      sourceNotes: tpl.sourceNotes,
      licenseNotes:
        "Base canvas is original BrainHook artwork (not a copyrighted meme image). Replace via upload if you hold rights to a specific template image.",
      textAreas: tpl.textAreas,
      recommendedFieldCount: tpl.recommendedFieldCount,
      active: true,
      isCurated: true,
    });
    logger.info({ slug: tpl.slug }, "Seeded curated meme template");
  }
}

// Canonical UTM presets for the Facebook auto-poster (and admin link builder).
// Insert-if-missing keyed on name (case-insensitive) so admin edits to these
// rows survive reboots — kept in lockstep with ARTICLE_FB_UTM / MEME_FB_UTM in
// emailShared.ts, which the poster actually applies to outbound links.
const CURATED_UTM_PRESETS = [
  { name: "Facebook — Articles", source: "FB", medium: "Artic", campaign: "FBA" },
  { name: "Facebook — Memes", source: "FB", medium: "Memes", campaign: "FBM" },
] as const;

async function seedUtmPresets(): Promise<void> {
  for (const p of CURATED_UTM_PRESETS) {
    const existing = await db
      .select({ id: utmPresetsTable.id })
      .from(utmPresetsTable)
      .where(sql`lower(${utmPresetsTable.name}) = ${p.name.toLowerCase()}`)
      .limit(1);
    if (existing.length > 0) continue;
    await db.insert(utmPresetsTable).values({
      name: p.name,
      source: p.source,
      medium: p.medium,
      campaign: p.campaign,
    });
    logger.info({ name: p.name }, "Seeded UTM preset");
  }
}

async function seedBeats(): Promise<void> {
  for (const b of CATEGORIES) {
    const existing = await db.select({ id: beatsTable.id }).from(beatsTable).where(eq(beatsTable.slug, b.slug)).limit(1);
    if (existing.length === 0) {
      await db.insert(beatsTable).values({
        slug: b.slug,
        name: b.name,
        description: b.description ?? null,
        slant: b.slant ?? null,
      });
      logger.info({ slug: b.slug }, "Seeded beat");
    }
  }
}

/** Find the next UTC instant at `hour:00` on or after the start of `day`. */
function utcSlotAt(day: Date, hour: number): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, 0, 0, 0));
}

/**
 * One-time migration to the rotating weekly schedule (Task: rotating weekly
 * author schedule). Runs at most once per database, guarded by an
 * `app_migrations` marker:
 *
 *   1. Every active author is moved to `weekly` cadence on a balanced random
 *      weekday at a random UTC hour, so authors no longer cluster on one day or
 *      one hour. From then on {@link rotateAuthorsAfterPublish} keeps shifting
 *      them after each publish.
 *   2. The existing `scheduled` backlog (all stacked at a single hour under the
 *      old fixed cadence) is re-spread evenly at two posts per calendar day,
 *      each at an independent random hour, with no author appearing twice on
 *      the same day — giving the "one or two authors a day, shifting around"
 *      rhythm immediately instead of waiting weeks for the backlog to drain.
 *
 * Drafts are left alone (they re-derive their slot from the author's new config
 * when they auto-lock). Everything runs in a single transaction.
 */
async function applyWeeklyRotationMigration(now = new Date()): Promise<void> {
  const MIGRATION_KEY = "weekly_rotation_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  const { pickRotatedWeekday, pickRandomHour } = await import("./scheduling");

  await db.transaction(async (tx) => {
    // Serialize concurrent boots so the migration applies exactly once even if
    // two processes start in parallel, then re-check the marker inside the lock.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:weekly_rotation_v1'))`);
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    // 1. Re-home every active author onto a balanced random weekday + hour.
    const actives = await tx
      .select({ id: authorsTable.id })
      .from(authorsTable)
      .where(eq(authorsTable.active, true));
    const counts = new Array<number>(7).fill(0);
    // Shuffle so the balanced assignment doesn't follow insertion order.
    const shuffled = [...actives].sort(() => Math.random() - 0.5);
    for (const a of shuffled) {
      const weekday = pickRotatedWeekday(null, counts);
      counts[weekday]! += 1;
      const runHourUtc = pickRandomHour();
      await tx
        .update(authorsTable)
        .set({ cadence: "weekly", weekday, runHourUtc, updatedAt: now })
        .where(eq(authorsTable.id, a.id));
    }

    // 2. Re-spread the scheduled backlog at two posts/day, random hours, no
    //    author twice on the same day. Preserve the original chronological
    //    order so earlier-scheduled pieces still go out first.
    const scheduled = await tx
      .select({ id: articlesTable.id, authorId: articlesTable.authorId })
      .from(articlesTable)
      .where(eq(articlesTable.status, "scheduled"))
      .orderBy(articlesTable.scheduledFor);

    const PER_DAY = 2;
    // Start four days out so every slot clears the publishing lead time.
    const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    cursor.setUTCDate(cursor.getUTCDate() + 4);

    const queue = [...scheduled];
    let updated = 0;
    while (queue.length > 0) {
      const usedAuthors = new Set<string>();
      let placed = 0;
      for (let i = 0; i < queue.length && placed < PER_DAY; ) {
        const art = queue[i]!;
        if (usedAuthors.has(art.authorId)) {
          i += 1;
          continue;
        }
        const slot = utcSlotAt(cursor, pickRandomHour());
        await tx
          .update(articlesTable)
          .set({ scheduledFor: slot, updatedAt: now })
          .where(eq(articlesTable.id, art.id));
        usedAuthors.add(art.authorId);
        placed += 1;
        updated += 1;
        queue.splice(i, 1);
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    await tx
      .execute(sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`);
    logger.info(
      { authors: actives.length, rescheduled: updated },
      "Applied weekly-rotation migration",
    );
  });
}

/**
 * Re-key a public author avatar onto a clean filename derived from the author's
 * real slug, preserving the *exact same image bytes* (no AI regeneration, so the
 * portrait/face never changes). Returns the new `/api/storage/public-objects/...`
 * URL, or `null` if the source object can't be found (caller keeps the old URL).
 */
async function rekeyAuthorAvatar(oldUrl: string, newSlug: string): Promise<string | null> {
  const prefix = "/api/storage/public-objects/";
  if (!oldUrl.startsWith(prefix)) return null;
  const oldKey = oldUrl.slice(prefix.length);
  const file = await findPublicObject(oldKey);
  if (!file) return null;
  const [buf] = await file.download();
  const ext = (oldKey.split(".").pop() || "png").toLowerCase();
  const contentType =
    ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
  const newKey = `author-avatars/${newSlug}-${randomUUID().slice(0, 8)}.${ext}`;
  await uploadPublicBuffer(newKey, buf, contentType);
  return `${prefix}${newKey}`;
}

/**
 * One-time cleanup of two authors whose stored data was tacky: an author left
 * with a placeholder slug (`asdfasdfasdf`) and a writer who needed a surname
 * change. Renames the slug (and name, where given) and re-keys the avatar so the
 * stored filename and public `/author/<slug>` URL match the real name. The same
 * image bytes are preserved, so portraits don't change.
 *
 * Runs at most once per database (guarded by an `app_migrations` marker), so it
 * fixes the dev DB on the next boot and the production DB on the next publish.
 * Each fixup is matched by the *current* slug and skipped if that row is gone or
 * the target slug is already taken, making the migration safe to ship long-term.
 */
async function applyAuthorCleanupMigration(now = new Date()): Promise<void> {
  const MIGRATION_KEY = "author_cleanup_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  const fixups: { matchSlug: string; newSlug: string; newName?: string }[] = [
    { matchSlug: "asdfasdfasdf", newSlug: "jennifer-marsden" },
    { matchSlug: "rafael-mercer", newSlug: "rafael-tomlin", newName: "Rafael Tomlin" },
  ];

  // Resolve avatar re-keys outside the transaction (object-storage network I/O).
  const updates: { id: string; newSlug: string; newName?: string; newAvatarUrl?: string }[] = [];
  for (const f of fixups) {
    const [row] = await db
      .select({ id: authorsTable.id, avatarUrl: authorsTable.avatarUrl })
      .from(authorsTable)
      .where(eq(authorsTable.slug, f.matchSlug))
      .limit(1);
    if (!row) continue;

    const [clash] = await db
      .select({ id: authorsTable.id })
      .from(authorsTable)
      .where(eq(authorsTable.slug, f.newSlug))
      .limit(1);
    if (clash && clash.id !== row.id) {
      logger.warn(
        { matchSlug: f.matchSlug, newSlug: f.newSlug },
        "Author cleanup: target slug already taken, skipping",
      );
      continue;
    }

    let newAvatarUrl: string | undefined;
    try {
      const rekeyed = await rekeyAuthorAvatar(row.avatarUrl, f.newSlug);
      if (rekeyed) newAvatarUrl = rekeyed;
    } catch (err) {
      logger.warn(
        { err, matchSlug: f.matchSlug },
        "Author cleanup: avatar re-key failed, keeping existing avatar",
      );
    }
    updates.push({ id: row.id, newSlug: f.newSlug, newName: f.newName, newAvatarUrl });
  }

  await db.transaction(async (tx) => {
    // Serialize concurrent boots so the migration applies exactly once.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:author_cleanup_v1'))`);
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    for (const u of updates) {
      await tx
        .update(authorsTable)
        .set({
          slug: u.newSlug,
          ...(u.newName ? { name: u.newName } : {}),
          ...(u.newAvatarUrl ? { avatarUrl: u.newAvatarUrl } : {}),
          updatedAt: now,
        })
        .where(eq(authorsTable.id, u.id));
    }

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info({ count: updates.length }, "Applied author-cleanup migration");
  });
}

/**
 * One-time re-curation of every author's sub-beats to the adjacency taxonomy
 * (see services/beatAdjacency.ts). Historically sub-beats could be set to any
 * beat, which let writers drift far from their primary beat (e.g. a
 * political-science author carrying earth-climate and neuroscience sub-beats,
 * producing climate-physics / neurochemistry pieces). This trims each author's
 * stored sub_beats to only those adjacent to their primary beat.
 *
 * Runs at most once per database (guarded by an `app_migrations` marker). It
 * only ever REMOVES non-adjacent sub-beats — it never adds any — so it is safe
 * to ship long-term. Authors on a beat not present in the taxonomy are left
 * untouched (filterAdjacentSubBeats fails open).
 */
async function applyBeatAdjacencyMigration(now = new Date()): Promise<void> {
  const MIGRATION_KEY = "beat_adjacency_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  await db.transaction(async (tx) => {
    // Serialize concurrent boots so the migration applies exactly once.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:beat_adjacency_v1'))`);
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    const authors = await tx
      .select({
        id: authorsTable.id,
        categorySlug: authorsTable.categorySlug,
        subBeats: authorsTable.subBeats,
      })
      .from(authorsTable);

    let changed = 0;
    let removed = 0;
    for (const a of authors) {
      const current = a.subBeats ?? [];
      const trimmed = filterAdjacentSubBeats(a.categorySlug, current);
      if (trimmed.length === current.length) continue; // nothing dropped
      removed += current.length - trimmed.length;
      changed += 1;
      await tx
        .update(authorsTable)
        .set({ subBeats: trimmed, updatedAt: now })
        .where(eq(authorsTable.id, a.id));
    }

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info({ authorsTrimmed: changed, subBeatsRemoved: removed }, "Applied beat-adjacency migration");
  });
}

/**
 * One-time backfill: assign a `beat_slug` to source documents that were ingested
 * before beat plumbing landed and so were stored with a null beat. Clustering
 * only considers beat-carrying documents (`beat_slug IS NOT NULL`), so these
 * historical rows were stranded — they never clustered, no story clusters formed,
 * and the editorial cockpit stayed empty even though the vault held usable
 * sources.
 *
 * Uses the deterministic, IDF-weighted beat classifier (no AI, no network) to
 * infer each document's beat from its title/excerpt/lead/body/domain. Documents
 * with no confident fit are left null (honestly unclassified) rather than
 * force-fit into a wrong beat. Only fills nulls — it never overrides an existing
 * beat — so it is safe to ship long-term and re-runs are guarded to once per DB
 * by an `app_migrations` marker (fixes dev on next restart, prod on deploy).
 */
async function applySourceDocBeatBackfillMigration(now = new Date()): Promise<void> {
  const MIGRATION_KEY = "source_doc_beat_backfill_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:source_doc_beat_backfill_v1'))`,
    );
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    const beats = await tx.execute<{
      slug: string;
      name: string;
      description: string | null;
      slant: string | null;
    }>(sql`SELECT "slug", "name", "description", "slant" FROM "beats"`);
    const index = buildBeatIndex(beats.rows);

    // Cap the body slice in SQL so the backfill stays memory-bounded even with
    // hundreds of long documents.
    const docs = await tx.execute<{
      id: string;
      title: string | null;
      excerpt: string | null;
      lead_snippet: string | null;
      domain: string | null;
      body: string | null;
    }>(sql`
      SELECT "id", "title", "excerpt", "lead_snippet", "domain",
             left(coalesce("extracted_text", ''), 2000) AS body
      FROM "source_documents"
      WHERE "beat_slug" IS NULL
    `);

    let assigned = 0;
    for (const d of docs.rows) {
      const slug = classifyBeat(
        {
          title: d.title,
          excerpt: d.excerpt,
          leadSnippet: d.lead_snippet,
          text: d.body,
          domain: d.domain,
        },
        index,
      );
      if (!slug) continue;
      await tx.execute(
        sql`UPDATE "source_documents" SET "beat_slug" = ${slug}, "updated_at" = ${now} WHERE "id" = ${d.id} AND "beat_slug" IS NULL`,
      );
      assigned += 1;
    }

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info(
      { docsScanned: docs.rows.length, beatsAssigned: assigned },
      "Applied source-document beat backfill migration",
    );
  });
}

const BEAT_BACKFILL_V2_KEY = "source_doc_beat_backfill_v2";

/**
 * Second-pass beat backfill (Task #235 follow-up). The v1 pass classified
 * null-beat source documents against beat descriptions only; this pass uses the
 * CORPUS-BACKED classifier (beat vocabularies learned from already-labeled
 * source documents + published articles + queued URLs) to confidently assign
 * beats the seed-only pass left null. Precision-first: only fills documents that
 * are STILL null (never overrides an existing beat), and only when the strict
 * confidence gate passes — a wrong beat is worse than a null beat.
 *
 * Guarded (advisory lock + app_migrations marker) and dry-runnable: set
 * BEAT_BACKFILL_DRY_RUN=true to log every decision (top-3 beats, margin, decisive
 * terms) WITHOUT writing anything or recording the marker, so the run repeats on
 * the next boot until you're happy and remove the flag.
 */
async function applySourceDocBeatBackfillV2Migration(now = new Date()): Promise<void> {
  const dryRun = process.env.BEAT_BACKFILL_DRY_RUN === "true";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${BEAT_BACKFILL_V2_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:source_doc_beat_backfill_v2'))`,
    );
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${BEAT_BACKFILL_V2_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    const beats = await tx.execute<{
      slug: string;
      name: string;
      description: string | null;
      slant: string | null;
    }>(sql`SELECT "slug", "name", "description", "slant" FROM "beats"`);

    // Learn beat vocabularies from TRUSTWORTHY gold labels only — published
    // articles (editor-chosen category) + ingest-queue rows discovered for a
    // beat. Deliberately NOT source_documents.beat_slug: that is the classifier's
    // own past output, so training on it is circular and snowballs early mislabels.
    const labeled: LabeledDoc[] = [];
    const labeledArticles = await tx.execute<{
      category_slug: string;
      title: string;
      dek: string;
    }>(sql`SELECT "category_slug", "title", "dek" FROM "articles" WHERE "status" = 'published'`);
    for (const a of labeledArticles.rows) {
      labeled.push({ beatSlug: a.category_slug, title: a.title, excerpt: a.dek });
    }
    const labeledQueue = await tx.execute<{
      beat_slug: string;
      lead_snippet: string | null;
      url: string;
    }>(sql`SELECT "beat_slug", "lead_snippet", "url" FROM "source_ingest_queue" WHERE "beat_slug" IS NOT NULL`);
    for (const q of labeledQueue.rows) {
      labeled.push({ beatSlug: q.beat_slug, leadSnippet: q.lead_snippet, domain: domainFromUrl(q.url) });
    }

    const index = buildBeatIndex(beats.rows, labeled);

    const docs = await tx.execute<{
      id: string;
      title: string | null;
      excerpt: string | null;
      lead_snippet: string | null;
      domain: string | null;
      body: string | null;
    }>(sql`
      SELECT "id", "title", "excerpt", "lead_snippet", "domain",
             left(coalesce("extracted_text", ''), 2000) AS body
      FROM "source_documents"
      WHERE "beat_slug" IS NULL
    `);

    let assigned = 0;
    let logged = 0;
    const LOG_CAP = 60;
    for (const d of docs.rows) {
      const result = classifyBeatDetailed(
        {
          title: d.title,
          excerpt: d.excerpt,
          leadSnippet: d.lead_snippet,
          text: d.body,
          domain: d.domain,
        },
        index,
      );
      if (logged < LOG_CAP) {
        logger.info(
          {
            docId: d.id,
            title: (d.title ?? "").slice(0, 80),
            winner: result.slug,
            decision: result.decision,
            margin: Number.isFinite(result.margin) ? Number(result.margin.toFixed(2)) : "inf",
            support: result.supportCount,
            top3: result.scores.map((s) => `${s.slug}:${s.score.toFixed(1)}`),
            terms: result.topTerms,
          },
          "beat backfill v2: classified source document",
        );
        logged += 1;
      }
      if (!result.slug) continue;
      assigned += 1;
      if (!dryRun) {
        await tx.execute(
          sql`UPDATE "source_documents" SET "beat_slug" = ${result.slug}, "updated_at" = ${now} WHERE "id" = ${d.id} AND "beat_slug" IS NULL`,
        );
      }
    }

    const remainNull = docs.rows.length - assigned;
    if (dryRun) {
      // Commit an empty transaction: no UPDATEs ran and the marker is not
      // recorded, so the migration re-runs on the next boot until the flag drops.
      logger.warn(
        { docsScanned: docs.rows.length, wouldAssign: assigned, wouldRemainNull: remainNull },
        "beat backfill v2: DRY RUN — no changes written, marker not recorded",
      );
      return;
    }

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${BEAT_BACKFILL_V2_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info(
      { docsScanned: docs.rows.length, beatsAssigned: assigned, remainNull },
      "Applied source-document beat backfill v2 (corpus-backed)",
    );
  });
}

/**
 * One-time data fix for the "Lowell Wardell" → "Paul Wardell" rename, where the
 * display name changed but the URL slug was left as the old `lowell-wardell`
 * (slug was never editable, so it went stale). Renames the slug to match the
 * current display name and records a redirect from the old slug so already-
 * crawled / inbound `/author/lowell-wardell` URLs 301 to the new page instead
 * of 404ing.
 *
 * Runs at most once per database (guarded by an `app_migrations` marker), so it
 * fixes the dev DB on the next restart and the (separate) prod DB on deploy. It
 * is fully defensive: it only acts if an author with the old slug still exists
 * and the target slug isn't already taken by another author, so it is a safe
 * no-op once applied or on any DB where the rename already happened by hand.
 */
async function applyPaulWardellSlugMigration(now = new Date()): Promise<void> {
  const MIGRATION_KEY = "author_paul_wardell_slug_v1";
  const OLD_SLUG = "lowell-wardell";
  const NEW_SLUG = "paul-wardell";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:author_paul_wardell_slug_v1'))`);
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    const [stale] = await tx
      .select({ id: authorsTable.id })
      .from(authorsTable)
      .where(eq(authorsTable.slug, OLD_SLUG));
    const [taken] = await tx
      .select({ id: authorsTable.id })
      .from(authorsTable)
      .where(eq(authorsTable.slug, NEW_SLUG));

    if (stale && !taken) {
      await tx
        .update(authorsTable)
        .set({ slug: NEW_SLUG, updatedAt: now })
        .where(eq(authorsTable.id, stale.id));
      await tx
        .insert(authorSlugRedirectsTable)
        .values({ oldSlug: OLD_SLUG, authorId: stale.id })
        .onConflictDoNothing();
      logger.info({ from: OLD_SLUG, to: NEW_SLUG }, "Applied Paul Wardell author-slug migration");
    } else {
      logger.info(
        { staleExists: Boolean(stale), targetTaken: Boolean(taken) },
        "Paul Wardell author-slug migration: nothing to do",
      );
    }

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
  });
}

/**
 * One-time editorial baseline: set every author's primary beat + sub-beats to
 * the curated cross-beat coverage map the editor handed us. Sub-beats are an
 * admin-managed field (see {@link normalizeSubBeats} — no adjacency gate), so we
 * write the spec verbatim and the AI idea generator honours it via
 * `resolveAllowedBeats` → `generateIdeasForAuthor` (`subBeatNote` pushes ~2/5
 * ideas into sub-beats).
 *
 * Keyed by author SLUG (the stable identity), so it lands on whatever
 * `DATABASE_URL` is set: dev on the next restart, the separate prod DB on
 * deploy. Fully defensive: skips authors that don't exist, and only changes a
 * primary beat when the target beat row exists in THIS database (dev currently
 * lacks a few beats prod has — there we leave the existing primary and still
 * apply the sub-beats). Runs at most once per DB (guarded by an `app_migrations`
 * marker + advisory lock); the repair and marker share one transaction.
 *
 * Sub-beats are stored deduped with the row's effective primary removed (same
 * shape `normalizeSubBeats` produces), so this is the authoritative state and
 * nothing downstream re-trims it.
 */
async function applyAuthorSubBeatsSpecMigration(now = new Date()): Promise<void> {
  const MIGRATION_KEY = "author_sub_beats_spec_v1";
  // [authorSlug, primaryBeatSlug, [subBeatSlugs...]]
  const SPEC: [string, string, string[]][] = [
    ["dr-aris-thorne", "hidden-science-everyday", ["astronomy-universe", "earth-climate", "gross-science", "medicine-the-body", "science-history", "technology-future", "weird-creepy"]],
    ["brenna-vance", "astronomy-universe", ["earth-climate", "hidden-science-everyday", "technology-future", "weird-creepy"]],
    ["elena-rivera", "relationships-communication", ["culture-media", "money-psychology-habits", "brain-health-longevity", "psychology-behavior", "technology-future"]],
    ["elias-voss", "astronomy-universe", ["earth-climate", "science-history", "technology-future", "weird-creepy"]],
    ["iri-yanamadala", "relationships-communication", ["belief-religion-meaning", "culture-media", "money-psychology-habits", "psychology-behavior", "technology-future"]],
    ["jennifer-marsden", "psychology-behavior", ["belief-religion-meaning", "crime-deviance-control", "money-psychology-habits", "medicine-the-body", "brain-health-longevity", "relationships-communication"]],
    ["julian-cross", "technology-future", ["crime-deviance-control", "culture-media", "money-psychology-habits", "history-memory", "relationships-communication", "science-history"]],
    ["leanne-ward", "psychology-behavior", ["medicine-the-body", "brain-health-longevity", "relationships-communication"]],
    ["mara-ellison", "psychology-behavior", ["belief-religion-meaning", "crime-deviance-control", "money-psychology-habits", "brain-health-longevity", "political-science", "relationships-communication"]],
    ["dr-marcus-okafor", "brain-health-longevity", ["gross-science", "medicine-the-body", "psychology-behavior", "relationships-communication"]],
    ["marcus-vance", "astronomy-universe", ["weird-creepy"]],
    ["mira-solen", "astronomy-universe", ["earth-climate", "hidden-science-everyday", "history-memory"]],
    ["noah-chen", "culture-media", ["belief-religion-meaning", "crime-deviance-control", "political-science", "psychology-behavior", "relationships-communication", "technology-future"]],
    ["owen-mercer", "relationships-communication", ["belief-religion-meaning", "culture-media", "money-psychology-habits", "brain-health-longevity", "psychology-behavior", "technology-future"]],
    ["paul-wardell", "political-science", ["belief-religion-meaning", "crime-deviance-control", "culture-media", "money-psychology-habits", "history-memory", "psychology-behavior", "technology-future"]],
    ["phoebe-lark", "gross-science", ["earth-climate", "hidden-science-everyday", "history-memory", "medicine-the-body", "weird-creepy"]],
    ["priya-shah", "money-psychology-habits", ["crime-deviance-control", "medicine-the-body", "political-science", "psychology-behavior", "relationships-communication", "technology-future"]],
    ["rafael-tomlin", "political-science", ["crime-deviance-control", "money-psychology-habits", "history-memory", "psychology-behavior", "technology-future"]],
    ["rowan-ellery", "astronomy-universe", ["science-history", "technology-future", "weird-creepy"]],
    ["sable-pike", "earth-climate", ["gross-science", "hidden-science-everyday", "history-memory", "medicine-the-body", "science-history"]],
    ["sarah-jenkins", "psychology-behavior", ["belief-religion-meaning", "money-psychology-habits", "medicine-the-body", "brain-health-longevity", "relationships-communication"]],
    ["silas-crane", "weird-creepy", ["astronomy-universe", "belief-religion-meaning", "crime-deviance-control", "gross-science", "hidden-science-everyday", "history-memory", "medicine-the-body", "science-history", "technology-future"]],
    ["tessa-vane", "money-psychology-habits", ["political-science", "psychology-behavior", "technology-future"]],
    ["vera-sloane", "technology-future", ["culture-media", "hidden-science-everyday", "history-memory", "relationships-communication", "science-history"]],
  ];

  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:author_sub_beats_spec_v1'))`);
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    const beatRows = await tx.select({ slug: beatsTable.slug }).from(beatsTable);
    const existingBeats = new Set(beatRows.map((b) => b.slug));

    let updated = 0;
    const missingAuthors: string[] = [];
    const skippedPrimaries: { slug: string; wanted: string }[] = [];

    for (const [authorSlug, wantedPrimary, subSlugs] of SPEC) {
      const [author] = await tx
        .select({ id: authorsTable.id, categorySlug: authorsTable.categorySlug })
        .from(authorsTable)
        .where(eq(authorsTable.slug, authorSlug));
      if (!author) {
        missingAuthors.push(authorSlug);
        continue;
      }

      // Only move a primary beat when the target exists in THIS DB; otherwise
      // keep the current primary (dev lacks a few beats prod has).
      let effectivePrimary = author.categorySlug;
      if (existingBeats.has(wantedPrimary)) {
        effectivePrimary = wantedPrimary;
      } else if (wantedPrimary !== author.categorySlug) {
        skippedPrimaries.push({ slug: authorSlug, wanted: wantedPrimary });
      }

      // Dedupe + drop the effective primary (same shape as normalizeSubBeats).
      const subBeats = Array.from(new Set(subSlugs)).filter((s) => s !== effectivePrimary);

      await tx
        .update(authorsTable)
        .set({ categorySlug: effectivePrimary, subBeats, updatedAt: now })
        .where(eq(authorsTable.id, author.id));
      updated += 1;
    }

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info(
      { updated, missingAuthors, skippedPrimaries },
      "Applied author sub-beats editorial-baseline migration",
    );
  });
}

/**
 * Re-sync each author's stored primary-beat NAME (`authors.category`) to the
 * current name of their `categorySlug` in the beats table.
 *
 * Background: `authors.category` (display name) and `authors.categorySlug` are
 * two separate columns. The sub-beats spec migration moved several authors'
 * primary `categorySlug` (e.g. Aris Thorne → hidden-science-everyday, Silas
 * Crane → weird-creepy) but did NOT touch the name column, leaving the profile
 * header showing the OLD beat name (e.g. "Medicine & The Body") even though the
 * slug — and therefore the AI idea generation — had already moved on. This also
 * heals any other historical drift between the two columns.
 *
 * Self-healing across both DBs: it reads names from the beats table (the source
 * of truth), skips authors whose slug has no matching beat row in THIS DB (dev
 * lacks a few beats prod has), and only writes when the name actually differs.
 * Guarded once-per-DB by an `app_migrations` marker + advisory lock; the repair
 * and marker write share one transaction.
 */
async function applyAuthorPrimaryBeatNameSyncMigration(now = new Date()): Promise<void> {
  const MIGRATION_KEY = "author_primary_beat_name_sync_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:author_primary_beat_name_sync_v1'))`,
    );
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    const beatRows = await tx
      .select({ slug: beatsTable.slug, name: beatsTable.name })
      .from(beatsTable);
    const nameBySlug = new Map(beatRows.map((b) => [b.slug, b.name]));

    const authors = await tx
      .select({
        id: authorsTable.id,
        slug: authorsTable.slug,
        category: authorsTable.category,
        categorySlug: authorsTable.categorySlug,
      })
      .from(authorsTable);

    let updated = 0;
    const unmatchedSlugs: string[] = [];
    for (const a of authors) {
      const correctName = nameBySlug.get(a.categorySlug);
      if (!correctName) {
        unmatchedSlugs.push(a.categorySlug);
        continue;
      }
      if (correctName !== a.category) {
        await tx
          .update(authorsTable)
          .set({ category: correctName, updatedAt: now })
          .where(eq(authorsTable.id, a.id));
        updated += 1;
      }
    }

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info(
      { updated, unmatchedSlugs },
      "Synced author primary-beat display names to the beats table",
    );
  });
}

/**
 * One-time data fix for the date randomizer that backdated ~95% of published
 * articles to dates BEFORE they were created (and therefore, in fast-moving
 * beats, before the events/studies they report on — the one date contradiction
 * Google can externally verify). Re-spreads every floor-violating article's
 * `publishedAt` across its legal window `[floor, now]` via
 * {@link enforceTruthfulArticleDates}, keeping already-safe dates untouched.
 *
 * `createdAt` is the bulletproof floor (the randomizer never touched it), so this
 * relies only on `createdAt` being intact. Runs at most once per database
 * (guarded by an `app_migrations` marker + advisory lock), so it fixes the dev DB
 * on the next restart and the (separate) prod DB on deploy, against whatever
 * `DATABASE_URL` is set — no per-environment logic and no manual SQL. The repair
 * and the marker write share one transaction, so a crash mid-repair leaves the
 * marker unset and the fix re-runs cleanly on the next boot.
 */
async function applyTruthfulDatesMigration(now = new Date()): Promise<void> {
  // v2: re-run with the forward-link-aware enforcement (fixpoint over ALL
  // internal links, not just earlier-created targets) so data repaired by the
  // original v1 pass is corrected for forward-link constraints too.
  const MIGRATION_KEY = "truthful_dates_v2";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  const { enforceTruthfulArticleDates } = await import("./articles");

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:truthful_dates_v2'))`);
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    const result = await enforceTruthfulArticleDates(tx, now, { keepSafe: true });

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    if (result.violations > 0) {
      logger.warn(
        { ...result },
        "Truthful-dates migration finished with residual date violations (should be 0)",
      );
    } else {
      logger.info({ ...result }, "Applied truthful-dates migration (0 date violations)");
    }
  });
}

/**
 * One-time byline fix for four articles the editorial-screening promotion path
 * assigned to sub-beat coverers instead of primary-beat writers (before
 * resolveCoveringAuthor in editorCockpit.ts preferred primary-beat authors):
 * three relationships/ENM pieces landed on a technology writer and a
 * political-science piece on a financial-psychology writer, purely because
 * their approved-idea banks were smallest. Reassigns each article (matched by
 * slug) to a writer whose PRIMARY beat is the article's category, spread across
 * the desk. Only applies while the article still belongs to the wrong author —
 * a manual admin reassignment in the meantime is respected and skipped.
 *
 * Runs at most once per database (guarded by an `app_migrations` marker +
 * advisory lock), so it fixes the dev DB on the next restart and the (separate)
 * prod DB on deploy. publishedAt/updatedAt are untouched — a byline correction
 * is not a content modification.
 */
async function applyClusterAuthorFixMigration(): Promise<void> {
  const MIGRATION_KEY = "cluster_author_fix_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  const fixups: { articleSlug: string; fromAuthorSlug: string; toAuthorSlug: string }[] = [
    {
      articleSlug:
        "a-closer-look-at-relationship-structures-relationship-satisfaction-and-attachmen",
      fromAuthorSlug: "julian-cross",
      toAuthorSlug: "elena-rivera",
    },
    {
      articleSlug:
        "how-do-people-maintain-consensual-non-monogamy-an-international-development-and-",
      fromAuthorSlug: "julian-cross",
      toAuthorSlug: "owen-mercer",
    },
    {
      articleSlug:
        "sexual-communication-and-satisfaction-in-young-adults-monogamous-and-consensuall",
      fromAuthorSlug: "julian-cross",
      toAuthorSlug: "iri-yanamadala",
    },
    {
      articleSlug: "gerrymandering-erodes-confidence-in-democracy",
      fromAuthorSlug: "priya-shah",
      toAuthorSlug: "rafael-tomlin",
    },
  ];

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:cluster_author_fix_v1'))`,
    );
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    let applied = 0;
    for (const f of fixups) {
      const [from] = await tx
        .select({ id: authorsTable.id })
        .from(authorsTable)
        .where(eq(authorsTable.slug, f.fromAuthorSlug))
        .limit(1);
      const [to] = await tx
        .select({ id: authorsTable.id })
        .from(authorsTable)
        .where(eq(authorsTable.slug, f.toAuthorSlug))
        .limit(1);
      if (!from || !to) {
        logger.warn(
          { articleSlug: f.articleSlug, from: f.fromAuthorSlug, to: f.toAuthorSlug },
          "Cluster-author fix: author missing, skipping",
        );
        continue;
      }
      const res = await tx.execute(sql`
        UPDATE "articles" SET "author_id" = ${to.id}
        WHERE "slug" = ${f.articleSlug} AND "author_id" = ${from.id}
      `);
      applied += res.rowCount ?? 0;
    }

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info(
      { applied, candidates: fixups.length },
      "Applied cluster-author byline fix migration",
    );
  });
}

/**
 * One-time data fix for raw `<cite index="29-2">…</cite>` citation markup the
 * web-search-enabled draft model emitted into article bodies before the strip in
 * {@link generateArticleDraft} existed. Those tags were stored verbatim in the
 * paragraph `content` and rendered as literal tag soup on the page. This unwraps
 * every `<cite>` tag (keeping the wrapped words) across ALL articles — drafts,
 * scheduled, and published — so existing rows are healed without an AI call.
 *
 * Runs at most once per database (guarded by an `app_migrations` marker +
 * advisory lock), so it fixes the dev DB on the next restart and the (separate)
 * prod DB on deploy. The repair and the marker write share one transaction, so a
 * crash mid-repair leaves the marker unset and the fix re-runs cleanly. Safe to
 * ship long-term: articles without `<cite>` tags are left byte-for-byte alone.
 */
async function applyCiteTagScrubMigration(): Promise<void> {
  const MIGRATION_KEY = "cite_tag_scrub_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  const { stripCitationTags } = await import("./citations");

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:cite_tag_scrub_v1'))`);
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    const articles = await tx
      .select({ id: articlesTable.id, body: articlesTable.body })
      .from(articlesTable);

    let articlesChanged = 0;
    let tagsRemoved = 0;
    for (const a of articles) {
      const body = a.body ?? [];
      const { body: cleaned, stripped } = stripCitationTags(body);
      if (stripped === 0) continue;
      articlesChanged += 1;
      tagsRemoved += stripped;
      await tx.update(articlesTable).set({ body: cleaned }).where(eq(articlesTable.id, a.id));
    }

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info({ articlesChanged, tagsRemoved }, "Applied cite-tag scrub migration");
  });
}

/**
 * One-time data fix mapping any legacy stock-photo (picsum) hero/share URL to the
 * branded "BrainHook on black" default card. Older drafts created before the
 * picsum fallback was removed stored `https://picsum.photos/...` directly in
 * `hero_image`/`share_image`; this heals those rows so neither the site nor any
 * email ever surfaces a stock photo. AI-free. Runs at most once per database
 * (guarded by an `app_migrations` marker + advisory lock), fixing the dev DB on
 * the next restart and the (separate) prod DB on deploy, and is a safe no-op once
 * applied. (Display-time guards in routes/public.ts + emailShared.ts also catch
 * any stragglers, so this migration is belt-and-suspenders cleanup of the DB.)
 */
async function applyKillPicsumMigration(): Promise<void> {
  const MIGRATION_KEY = "kill_picsum_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:kill_picsum_v1'))`);
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    const heroFixed = await tx
      .update(articlesTable)
      .set({ heroImage: DEFAULT_SHARE_CARD_URL })
      .where(like(articlesTable.heroImage, "%picsum.photos%"))
      .returning({ id: articlesTable.id });
    const shareFixed = await tx
      .update(articlesTable)
      .set({ shareImage: DEFAULT_SHARE_CARD_URL })
      .where(like(articlesTable.shareImage, "%picsum.photos%"))
      .returning({ id: articlesTable.id });

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info(
      { heroFixed: heroFixed.length, shareFixed: shareFixed.length },
      "Applied kill-picsum migration (mapped legacy stock-photo URLs to branded default card)",
    );
  });
}

/**
 * One-time data fix repointing any hero/share URL that references the previous,
 * unversioned branded default card (`brand/default-card.png`) to the current
 * versioned key ({@link DEFAULT_SHARE_CARD_URL}). Public objects are served
 * `immutable`, so the artwork was swapped under a fresh `-v2` key; rows healed by
 * the earlier kill-picsum migration still point at the old key, and this maps
 * them forward so every fallback article renders the new card. AI-free, runs at
 * most once per database (guarded by an `app_migrations` marker + advisory lock),
 * and is a safe no-op once applied.
 */
async function applyDefaultCardV2Migration(): Promise<void> {
  const MIGRATION_KEY = "default_card_v2";
  const OLD_DEFAULT_CARD_URL = "/api/storage/public-objects/brand/default-card.png";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:default_card_v2'))`);
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    const heroFixed = await tx
      .update(articlesTable)
      .set({ heroImage: DEFAULT_SHARE_CARD_URL })
      .where(eq(articlesTable.heroImage, OLD_DEFAULT_CARD_URL))
      .returning({ id: articlesTable.id });
    const shareFixed = await tx
      .update(articlesTable)
      .set({ shareImage: DEFAULT_SHARE_CARD_URL })
      .where(eq(articlesTable.shareImage, OLD_DEFAULT_CARD_URL))
      .returning({ id: articlesTable.id });

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info(
      { heroFixed: heroFixed.length, shareFixed: shareFixed.length },
      "Applied default-card-v2 migration (repointed old branded card URLs to the versioned key)",
    );
  });
}

/**
 * One-time data fix repointing any hero/share URL that references the `-v2`
 * branded default card to the current versioned key
 * ({@link DEFAULT_SHARE_CARD_URL}, `-v3`). The artwork was replaced with the
 * user-approved BrainHook brand card (2026-07-09); public objects are served
 * `immutable`, so the swap required a fresh key, and rows healed by the earlier
 * migrations still point at `-v2`. AI-free, runs at most once per database
 * (guarded by an `app_migrations` marker + advisory lock), safe no-op once
 * applied.
 */
async function applyDefaultCardV3Migration(): Promise<void> {
  const MIGRATION_KEY = "default_card_v3";
  const OLD_DEFAULT_CARD_URL = "/api/storage/public-objects/brand/default-card-v2.png";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:default_card_v3'))`);
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    const heroFixed = await tx
      .update(articlesTable)
      .set({ heroImage: DEFAULT_SHARE_CARD_URL })
      .where(eq(articlesTable.heroImage, OLD_DEFAULT_CARD_URL))
      .returning({ id: articlesTable.id });
    const shareFixed = await tx
      .update(articlesTable)
      .set({ shareImage: DEFAULT_SHARE_CARD_URL })
      .where(eq(articlesTable.shareImage, OLD_DEFAULT_CARD_URL))
      .returning({ id: articlesTable.id });
    // feed_image is also healed to the default card by heroImage/articles and is
    // consumed by the social queue as its image fallback — repoint it too (the
    // earlier kill-picsum/v2 migrations missed this column).
    const feedFixed = await tx
      .update(articlesTable)
      .set({ feedImage: DEFAULT_SHARE_CARD_URL })
      .where(eq(articlesTable.feedImage, OLD_DEFAULT_CARD_URL))
      .returning({ id: articlesTable.id });

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info(
      { heroFixed: heroFixed.length, shareFixed: shareFixed.length, feedFixed: feedFixed.length },
      "Applied default-card-v3 migration (repointed -v2 branded card URLs to the -v3 key)",
    );
  });
}

/**
 * Curated STARTER feed set (Task #231). Pre-loads a sensible, real set of
 * public RSS/Atom feeds mapped to BrainHook's confirmed beats so a fresh install
 * has something to poll on day one, instead of an empty registry. Every feed is
 * fully auditionable and deletable from Admin → Feeds, so imperfect URLs are an
 * acceptable starting point — the admin curates from here.
 *
 * Each carries an informational `purpose` label (never affects routing/scoring).
 * Feeds are inserted with `onConflictDoNothing` on the unique `url`, so a feed an
 * admin already registered (or a re-run of this migration on a partially-seeded
 * DB) is left untouched.
 */
const STARTER_FEEDS: {
  url: string;
  title: string;
  beatSlug: string;
  purpose: FeedPurpose;
  pollIntervalMinutes: number;
}[] = [
  // Psychology & Behavior — steady research + one fast idea scout.
  {
    url: "https://www.sciencedaily.com/rss/mind_brain/psychology.xml",
    title: "ScienceDaily — Psychology",
    beatSlug: "psychology-behavior",
    purpose: "primary",
    pollIntervalMinutes: 180,
  },
  {
    url: "https://www.psychologicalscience.org/feed",
    title: "Association for Psychological Science",
    beatSlug: "psychology-behavior",
    purpose: "primary",
    pollIntervalMinutes: 240,
  },
  {
    url: "https://digest.bps.org.uk/feed/",
    title: "BPS Research Digest",
    beatSlug: "psychology-behavior",
    purpose: "idea_scout",
    pollIntervalMinutes: 120,
  },
  {
    url: "https://www.psychologytoday.com/intl/rss.xml",
    title: "Psychology Today",
    beatSlug: "psychology-behavior",
    purpose: "idea_scout",
    pollIntervalMinutes: 120,
  },
  // Relationships & Communication
  {
    url: "https://www.sciencedaily.com/rss/mind_brain/relationships.xml",
    title: "ScienceDaily — Relationships",
    beatSlug: "relationships-communication",
    purpose: "primary",
    pollIntervalMinutes: 240,
  },
  {
    url: "https://www.sciencedaily.com/rss/mind_brain/gender_difference.xml",
    title: "ScienceDaily — Gender Differences",
    beatSlug: "relationships-communication",
    purpose: "primary",
    pollIntervalMinutes: 360,
  },
  {
    url: "https://www.gottman.com/blog/feed/",
    title: "The Gottman Institute",
    beatSlug: "relationships-communication",
    purpose: "idea_scout",
    pollIntervalMinutes: 360,
  },
  // Brain Health & Longevity
  {
    url: "https://www.sciencedaily.com/rss/health_medicine/healthy_aging.xml",
    title: "ScienceDaily — Healthy Aging",
    beatSlug: "brain-health-longevity",
    purpose: "primary",
    pollIntervalMinutes: 180,
  },
  {
    url: "https://neurosciencenews.com/feed/",
    title: "Neuroscience News",
    beatSlug: "brain-health-longevity",
    purpose: "trend_sensor",
    pollIntervalMinutes: 60,
  },
  {
    url: "https://www.nia.nih.gov/news/rss.xml",
    title: "National Institute on Aging",
    beatSlug: "brain-health-longevity",
    purpose: "official_record",
    pollIntervalMinutes: 360,
  },
  // Money Psychology & Habits
  {
    url: "https://www.sciencedaily.com/rss/science_society/consumer_behavior.xml",
    title: "ScienceDaily — Consumer Behavior",
    beatSlug: "money-psychology-habits",
    purpose: "primary",
    pollIntervalMinutes: 240,
  },
  {
    url: "https://www.sciencedaily.com/rss/science_society/economics.xml",
    title: "ScienceDaily — Economics",
    beatSlug: "money-psychology-habits",
    purpose: "idea_scout",
    pollIntervalMinutes: 240,
  },
  {
    url: "https://www.nber.org/rss/new.xml",
    title: "NBER — New Working Papers",
    beatSlug: "money-psychology-habits",
    purpose: "research_preprint",
    pollIntervalMinutes: 360,
  },
  // Astronomy & The Universe
  {
    url: "https://www.sciencedaily.com/rss/space_time/astronomy.xml",
    title: "ScienceDaily — Astronomy",
    beatSlug: "astronomy-universe",
    purpose: "primary",
    pollIntervalMinutes: 180,
  },
  {
    url: "https://phys.org/rss-feed/space-news/astronomy/",
    title: "Phys.org — Astronomy",
    beatSlug: "astronomy-universe",
    purpose: "trend_sensor",
    pollIntervalMinutes: 60,
  },
  {
    url: "http://export.arxiv.org/rss/astro-ph",
    title: "arXiv — Astrophysics",
    beatSlug: "astronomy-universe",
    purpose: "research_preprint",
    pollIntervalMinutes: 360,
  },
  {
    url: "https://www.nasa.gov/feed/",
    title: "NASA",
    beatSlug: "astronomy-universe",
    purpose: "official_record",
    pollIntervalMinutes: 240,
  },
  // Hidden Science of Everyday Life
  {
    url: "https://www.sciencedaily.com/rss/matter_energy/chemistry.xml",
    title: "ScienceDaily — Chemistry",
    beatSlug: "hidden-science-everyday",
    purpose: "primary",
    pollIntervalMinutes: 240,
  },
  {
    url: "https://www.sciencedaily.com/rss/matter_energy/physics.xml",
    title: "ScienceDaily — Physics",
    beatSlug: "hidden-science-everyday",
    purpose: "primary",
    pollIntervalMinutes: 240,
  },
  {
    url: "https://phys.org/rss-feed/",
    title: "Phys.org",
    beatSlug: "hidden-science-everyday",
    purpose: "trend_sensor",
    pollIntervalMinutes: 60,
  },
  // Technology & The Future
  {
    url: "https://www.sciencedaily.com/rss/computers_math/artificial_intelligence.xml",
    title: "ScienceDaily — Artificial Intelligence",
    beatSlug: "technology-future",
    purpose: "primary",
    pollIntervalMinutes: 180,
  },
  {
    url: "https://www.technologyreview.com/feed/",
    title: "MIT Technology Review",
    beatSlug: "technology-future",
    purpose: "trend_sensor",
    pollIntervalMinutes: 60,
  },
  {
    url: "https://feeds.arstechnica.com/arstechnica/technology-lab",
    title: "Ars Technica — Technology Lab",
    beatSlug: "technology-future",
    purpose: "trend_sensor",
    pollIntervalMinutes: 60,
  },
  {
    url: "http://export.arxiv.org/rss/cs.AI",
    title: "arXiv — Artificial Intelligence",
    beatSlug: "technology-future",
    purpose: "research_preprint",
    pollIntervalMinutes: 360,
  },
  // Earth & Climate
  {
    url: "https://www.sciencedaily.com/rss/earth_climate/climate.xml",
    title: "ScienceDaily — Climate",
    beatSlug: "earth-climate",
    purpose: "primary",
    pollIntervalMinutes: 180,
  },
  {
    url: "https://climate.nasa.gov/news/rss.xml",
    title: "NASA — Climate Change",
    beatSlug: "earth-climate",
    purpose: "official_record",
    pollIntervalMinutes: 360,
  },
  {
    url: "https://public.wmo.int/en/rss.xml",
    title: "World Meteorological Organization",
    beatSlug: "earth-climate",
    purpose: "official_record",
    pollIntervalMinutes: 360,
  },
  {
    url: "https://www.noaa.gov/news-features/feed",
    title: "NOAA — News & Features",
    beatSlug: "earth-climate",
    purpose: "official_record",
    pollIntervalMinutes: 360,
  },
  // Political Science
  {
    url: "https://www.sciencedaily.com/rss/science_society/political_science.xml",
    title: "ScienceDaily — Political Science",
    beatSlug: "political-science",
    purpose: "primary",
    pollIntervalMinutes: 240,
  },
  {
    url: "https://www.pewresearch.org/feed/",
    title: "Pew Research Center",
    beatSlug: "political-science",
    purpose: "idea_scout",
    pollIntervalMinutes: 240,
  },
  {
    url: "https://www.sciencedaily.com/rss/science_society/public_health.xml",
    title: "ScienceDaily — Public Health",
    beatSlug: "political-science",
    purpose: "primary",
    pollIntervalMinutes: 360,
  },
];

/**
 * One-time pre-load of the curated {@link STARTER_FEEDS} set into an empty (or
 * partially-populated) feed registry. Runs at most once per database (guarded by
 * an `app_migrations` marker + advisory lock), so a fresh dev DB heals on the
 * next restart and the (separate) prod DB seeds on deploy. Idempotent: feeds are
 * inserted with `onConflictDoNothing` on the unique `url`, so already-registered
 * feeds are never disturbed and a re-run is a safe no-op.
 */
async function applyStarterFeedsSeedMigration(): Promise<void> {
  const MIGRATION_KEY = "starter_feeds_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  await db.transaction(async (tx) => {
    // Serialize concurrent boots so the pre-load applies exactly once.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:starter_feeds_v1'))`);
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    const inserted = await tx
      .insert(sourceFeedsTable)
      .values(
        STARTER_FEEDS.map((f) => ({
          url: f.url,
          title: f.title,
          beatSlug: f.beatSlug,
          purpose: f.purpose,
          pollIntervalMinutes: f.pollIntervalMinutes,
        })),
      )
      .onConflictDoNothing({ target: sourceFeedsTable.url })
      .returning({ id: sourceFeedsTable.id });

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info(
      { inserted: inserted.length, candidates: STARTER_FEEDS.length },
      "Applied starter-feeds migration (pre-loaded curated feed set)",
    );
  });
}

/**
 * GovInfo single-document collection feeds (Task: GovInfo primary sources). Each
 * item in these RSS feeds is exactly one government document (a GAO report, a
 * hearing, a public law, a presidential document, etc.) — NOT a firehose of an
 * entire day's issue — so no per-feed keyword filter is needed. Every feed maps
 * to the `political-science` beat with `purpose: "official_record"`. The feed
 * <link>s point at GovInfo's JavaScript SPA details page; the feed watcher
 * rewrites each to the underlying content file (PDF/HTML) via
 * {@link resolveGovInfoContentUrl} before enqueueing, so the Source Vault
 * fetches the real document.
 *
 * Excluded on purpose (would be a firehose or off-scope): bills, the daily
 * Congressional Record, CFR, US Code, Statutes at Large, and court feeds. The
 * Federal Register is intentionally NOT added as the raw daily-issue feed — it
 * belongs as topic-scoped GovInfo custom-search feeds (grabbed from the GovInfo
 * UI) so the keyword filter / granule resolver can narrow it.
 */
const GOVINFO_FEEDS: {
  url: string;
  title: string;
}[] = [
  { url: "https://www.govinfo.gov/rss/gaoreports.xml", title: "GovInfo — GAO Reports" },
  { url: "https://www.govinfo.gov/rss/cmr.xml", title: "GovInfo — Congressionally Mandated Reports" },
  { url: "https://www.govinfo.gov/rss/chrg.xml", title: "GovInfo — Congressional Hearings" },
  { url: "https://www.govinfo.gov/rss/crpt.xml", title: "GovInfo — Congressional Reports" },
  { url: "https://www.govinfo.gov/rss/plaw.xml", title: "GovInfo — Public and Private Laws" },
  { url: "https://www.govinfo.gov/rss/dcpd.xml", title: "GovInfo — Presidential Documents" },
  { url: "https://www.govinfo.gov/rss/cprt.xml", title: "GovInfo — Congressional Committee Prints" },
];

/**
 * One-time pre-load of the {@link GOVINFO_FEEDS} set. Separate migration key from
 * the starter feeds so it applies to databases that already ran the starter-feeds
 * seed (dev + the separate prod DB). Idempotent: `onConflictDoNothing` on the
 * unique `url`, so already-registered feeds are never disturbed and a re-run is a
 * safe no-op. Poll every 6h — these collections update a few times a day at most.
 */
async function applyGovInfoFeedsSeedMigration(): Promise<void> {
  const MIGRATION_KEY = "govinfo_feeds_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:govinfo_feeds_v1'))`);
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    const inserted = await tx
      .insert(sourceFeedsTable)
      .values(
        GOVINFO_FEEDS.map((f) => ({
          url: f.url,
          title: f.title,
          beatSlug: "political-science",
          purpose: "official_record" as FeedPurpose,
          pollIntervalMinutes: 360,
        })),
      )
      .onConflictDoNothing({ target: sourceFeedsTable.url })
      .returning({ id: sourceFeedsTable.id });

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info(
      { inserted: inserted.length, candidates: GOVINFO_FEEDS.length },
      "Applied GovInfo-feeds migration (pre-loaded primary-source collection feeds)",
    );
  });
}

/**
 * One-time backfill: find any source_documents that were stored when the captcha
 * guard didn't exist (or used a narrower regex) and whose title / body indicates a
 * bot-check interstitial was fetched rather than the real article.
 *
 * For each matched row: delete chunks/embeddings, reset status to "failed",
 * lifecycle_status to "unavailable", clear extracted_text and word_count, and stamp
 * quality_flags with ["captcha_blocked", "no_article_body"].
 */
async function applyCaptchaBackfillMigration(): Promise<void> {
  const MIGRATION_KEY = "captcha_backfill_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:captcha_backfill_v1'))`,
    );
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    // Identify captcha rows via title patterns (strong signals only in the
    // backfill to avoid false positives on real article titles).
    const captchaWhere = sql`(
      title ILIKE '%checking your browser%'
      OR title ILIKE '%recaptcha%'
      OR title ILIKE '%captcha%'
      OR title ILIKE '%just a moment%'
      OR title ILIKE '%cloudflare ray id%'
      OR title ILIKE '%please verify you are human%'
      OR title ILIKE '%bot detection%'
      OR (word_count < 300 AND (
           extracted_text ILIKE '%checking your browser%'
        OR extracted_text ILIKE '%recaptcha%'
        OR extracted_text ILIKE '%captcha%'
      ))
    )`;

    // Delete orphaned chunks first (JOIN-delete avoids collecting IDs).
    await tx.execute(sql`
      DELETE FROM "source_chunks" sc
      USING "source_documents" sd
      WHERE sc.document_id = sd.id
        AND ${captchaWhere}
    `);

    // Reset the source documents.
    const updated = await tx.execute(sql`
      UPDATE "source_documents" SET
        status              = 'failed',
        lifecycle_status    = 'unavailable',
        error               = 'Bot check / captcha page (backfill)',
        quality_flags       = '["captcha_blocked","no_article_body"]'::jsonb,
        word_count          = 0,
        extracted_text      = NULL
      WHERE ${captchaWhere}
    `);

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info(
      { updated: (updated as { rowCount?: number }).rowCount ?? 0 },
      "applyCaptchaBackfillMigration: cleaned captcha rows",
    );
  });
}

/**
 * One-time repair: clear FALSE near-duplicate marks in the Source Vault.
 *
 * The SimHash near-dup layer used unigram bag-of-words SimHash with no
 * verification. Unigram SimHash converges on long English prose (common words
 * dominate the per-bit vote), so hundreds of completely unrelated documents
 * landed within the 6-bit threshold and were marked `duplicate_of_id` →
 * never embedded → invisible to retrieval and evidence packets.
 *
 * This migration re-checks every SimHash-flagged duplicate with the same
 * verification gate the ingest path now uses (distinct 3-word shingle
 * containment ≥ 0.5 against its representative's text) and clears the marks
 * that fail it. Cleared docs become their own single-member family
 * (sourceFamilyId = own id, the Option B representative invariant) and stay
 * `extracted`/0-chunks, so the existing re-embed cron sweep picks them up and
 * makes them searchable. Content-hash and canonical-URL duplicates (reliable
 * signals) are untouched, as are "superseded ..." family re-pointings.
 *
 * Runs at most once per database (`app_migrations` marker + advisory lock).
 */
async function applySimhashFalseDupRepairMigration(): Promise<void> {
  const MIGRATION_KEY = "simhash_false_dup_repair_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:simhash_false_dup_repair_v1'))`,
    );
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    const flagged = await tx
      .select({
        id: sourceDocumentsTable.id,
        duplicateOfId: sourceDocumentsTable.duplicateOfId,
      })
      .from(sourceDocumentsTable)
      .where(like(sourceDocumentsTable.dedupeReason, "near-duplicate%"));

    let cleared = 0;
    let kept = 0;
    const now = new Date();
    for (const docRef of flagged) {
      if (!docRef.duplicateOfId) continue;
      const [self] = await tx
        .select({ extractedText: sourceDocumentsTable.extractedText })
        .from(sourceDocumentsTable)
        .where(eq(sourceDocumentsTable.id, docRef.id))
        .limit(1);
      const [rep] = await tx
        .select({ extractedText: sourceDocumentsTable.extractedText })
        .from(sourceDocumentsTable)
        .where(eq(sourceDocumentsTable.id, docRef.duplicateOfId))
        .limit(1);
      // Missing text on either side = cannot verify the dup claim → clear it.
      // Better to re-embed a rare true duplicate than to keep silently hiding
      // a potentially unique source from retrieval.
      const containment =
        self?.extractedText && rep?.extractedText
          ? shingleContainment(self.extractedText, rep.extractedText)
          : 0;
      if (containment >= 0.5) {
        kept += 1;
        continue;
      }
      await tx
        .update(sourceDocumentsTable)
        .set({
          duplicateOfId: null,
          dedupeReason: null,
          sourceFamilyId: docRef.id,
          updatedAt: now,
        })
        .where(eq(sourceDocumentsTable.id, docRef.id));
      cleared += 1;
    }

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info(
      { flagged: flagged.length, cleared, kept },
      "Applied simhash false-duplicate repair migration",
    );
  });
}

/**
 * One-time repair: dissolve FALSE duplicate families in the Source Vault.
 *
 * Production data showed two ways unrelated documents were falsely grouped
 * after the SimHash fix:
 *   1. Junk-extraction boilerplate ("Checking your browser - reCAPTCHA" ×41,
 *      "- YouTube", "Redirecting") is literally identical text, so the exact
 *      content-hash layer folded unrelated URLs into giant fake families.
 *   2. Thin / nav-heavy extractions cleared the shingle-containment bar
 *      (|A∩B| / min ≥ 0.5) against real articles because the smaller side has
 *      almost no distinct phrases — poisoning families and, via demotion
 *      sweeps, dragging real articles under unrelated representatives.
 *
 * This migration re-verifies EVERY duplicate/superseded mark against its
 * representative's actual row with the hardened checks the ingest path now
 * uses (`decideDupRepair`): junk on either side dissolves, shared canonical
 * URL keeps, otherwise both sides need enough text plus an identical content
 * hash or verified phrase overlap with a distinct-shingle floor. Dissolved
 * docs become their own single-member family (Option B: sourceFamilyId = own
 * id), get their lifecycle restored (superseded → active, supersededById
 * cleared), and stay extracted/0-chunks so the existing re-embed sweep makes
 * them searchable again. Junk docs are additionally downgraded to
 * `low_quality` (never re-embedded); their family marks are cleared too.
 *
 * Runs at most once per database (`app_migrations` marker + advisory lock),
 * so it heals dev on next restart and prod on next publish.
 */
async function applyFalseDupFamilyRepairMigration(): Promise<void> {
  const MIGRATION_KEY = "false_dup_family_repair_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:false_dup_family_repair_v1'))`,
    );
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    const flagged = await tx
      .select({
        id: sourceDocumentsTable.id,
        duplicateOfId: sourceDocumentsTable.duplicateOfId,
        status: sourceDocumentsTable.status,
        lifecycleStatus: sourceDocumentsTable.lifecycleStatus,
      })
      .from(sourceDocumentsTable)
      .where(isNotNull(sourceDocumentsTable.duplicateOfId));

    const factsColumns = {
      title: sourceDocumentsTable.title,
      wordCount: sourceDocumentsTable.wordCount,
      extractedText: sourceDocumentsTable.extractedText,
      contentHash: sourceDocumentsTable.contentHash,
      url: sourceDocumentsTable.url,
      canonicalUrl: sourceDocumentsTable.canonicalUrl,
    };

    let kept = 0;
    let dissolved = 0;
    let junkDowngraded = 0;
    const now = new Date();
    for (const docRef of flagged) {
      if (!docRef.duplicateOfId) continue;
      // Texts are fetched per-row (not in the list query) to keep memory flat.
      const [self] = await tx
        .select(factsColumns)
        .from(sourceDocumentsTable)
        .where(eq(sourceDocumentsTable.id, docRef.id))
        .limit(1);
      const [rep] = await tx
        .select(factsColumns)
        .from(sourceDocumentsTable)
        .where(eq(sourceDocumentsTable.id, docRef.duplicateOfId))
        .limit(1);
      if (!self) continue;
      const verdict = decideDupRepair(self as RepairDocFacts, (rep as RepairDocFacts) ?? null);
      if (verdict.keep) {
        kept += 1;
        continue;
      }

      const updates: Partial<typeof sourceDocumentsTable.$inferInsert> = {
        duplicateOfId: null,
        dedupeReason: null,
        sourceFamilyId: docRef.id, // Option B: own single-member family
        supersededById: null,
        updatedAt: now,
      };
      if (docRef.lifecycleStatus === "superseded") {
        updates.lifecycleStatus = "active";
      }
      if (verdict.selfJunk) {
        // Junk extraction: keep it out of retrieval permanently. Failed rows
        // stay failed; anything else is held as low_quality (never embedded).
        junkDowngraded += 1;
        if (docRef.status === "embedded") {
          await tx.delete(sourceChunksTable).where(eq(sourceChunksTable.documentId, docRef.id));
          updates.chunkCount = 0;
        }
        if (docRef.status !== "failed") {
          updates.status = "low_quality";
        }
      }
      await tx
        .update(sourceDocumentsTable)
        .set(updates)
        .where(eq(sourceDocumentsTable.id, docRef.id));
      dissolved += 1;
    }

    // Second pass: standalone junk docs. The junk REPRESENTATIVES of the fake
    // families (captcha rep, empty-title rep, "- YouTube" rep) have no
    // duplicateOfId, so the loop above never touches them — after their fake
    // members dissolve they would linger as normal active docs and could even
    // be picked up by the re-embed sweep. Downgrade anything that screens as
    // junk to low_quality (failed rows stay failed) and drop any chunks.
    const standalone = await tx
      .select({
        id: sourceDocumentsTable.id,
        title: sourceDocumentsTable.title,
        wordCount: sourceDocumentsTable.wordCount,
        status: sourceDocumentsTable.status,
      })
      .from(sourceDocumentsTable)
      .where(sql`${sourceDocumentsTable.duplicateOfId} IS NULL AND ${sourceDocumentsTable.status} NOT IN ('low_quality', 'failed')`);
    let standaloneJunk = 0;
    for (const doc of standalone) {
      if (screenForDedupe(doc.title, doc.wordCount) !== "junk") continue;
      if (doc.status === "embedded") {
        await tx.delete(sourceChunksTable).where(eq(sourceChunksTable.documentId, doc.id));
      }
      await tx
        .update(sourceDocumentsTable)
        .set({ status: "low_quality", chunkCount: 0, updatedAt: now })
        .where(eq(sourceDocumentsTable.id, doc.id));
      standaloneJunk += 1;
    }

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info(
      { flagged: flagged.length, kept, dissolved, junkDowngraded, standaloneJunk },
      "Applied false-duplicate family repair migration",
    );
  });
}

/**
 * One-time restamp of Source Vault authority tiers after the July 2026
 * classifier expansion (user-supplied domain lists: ~90 new domains, path
 * rules for opinion/index/show pages, and reclassifications like aei.org →
 * commentary, thenation.com → commentary, reason.com → reported). Re-runs
 * classifyAuthority over every AUTO-classified document using its full URL
 * (so path-based rules apply) and updates tier + reason where the result
 * changed. Manual pins (authority_source = 'manual') are never touched.
 * AI-free, guarded by an `app_migrations` marker + advisory lock; bump the
 * key (v2, v3…) for future classifier-list revisions.
 */
async function applyAuthorityReclassifyV1Migration(): Promise<void> {
  const MIGRATION_KEY = "source_authority_reclassify_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:source_authority_reclassify_v1'))`,
    );
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    const docs = await tx
      .select({
        id: sourceDocumentsTable.id,
        url: sourceDocumentsTable.url,
        domain: sourceDocumentsTable.domain,
        authorityTier: sourceDocumentsTable.authorityTier,
      })
      .from(sourceDocumentsTable)
      .where(sql`${sourceDocumentsTable.authoritySource} IS DISTINCT FROM 'manual'`);

    let updated = 0;
    const now = new Date();
    for (const doc of docs) {
      // Mirror ingest-time logic (persistExtractedSource): non-HTTP URLs
      // (e.g. upload://…) carry no classifiable host, so classify by the
      // stored domain instead — otherwise uploads would restamp to "unknown".
      const c = classifyAuthority(doc.url.startsWith("http") ? doc.url : doc.domain);
      if (c.tier === doc.authorityTier) continue;
      await tx
        .update(sourceDocumentsTable)
        .set({ authorityTier: c.tier, authorityReason: c.reason, updatedAt: now })
        .where(eq(sourceDocumentsTable.id, doc.id));
      updated += 1;
    }

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info(
      { scanned: docs.length, updated },
      "Applied source-authority reclassify migration (July 2026 domain lists)",
    );
  });
}

/**
 * One-time reclassification of source_documents where authority_tier = 'primary'
 * but the title contains review-article signals (systematic review, meta-analysis,
 * etc.). These documents synthesise existing literature rather than reporting
 * original experimental data, so they belong in `reported`, not `primary`.
 * Manual pins (authority_source = 'manual') are never touched. Guarded by an
 * `app_migrations` marker + advisory lock.
 */
async function applyReviewArticleReclassifyMigration(): Promise<void> {
  const MIGRATION_KEY = "review_article_reclassify_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:review_article_reclassify_v1'))`,
    );
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    const docs = await tx
      .select({
        id: sourceDocumentsTable.id,
        title: sourceDocumentsTable.title,
        authorityReason: sourceDocumentsTable.authorityReason,
      })
      .from(sourceDocumentsTable)
      .where(
        sql`${sourceDocumentsTable.authorityTier} = 'primary'
            AND ${sourceDocumentsTable.authoritySource} IS DISTINCT FROM 'manual'
            AND ${sourceDocumentsTable.title} IS NOT NULL`,
      );

    let updated = 0;
    const now = new Date();
    for (const doc of docs) {
      if (!doc.title || !isReviewArticleTitle(doc.title)) continue;
      await tx
        .update(sourceDocumentsTable)
        .set({
          authorityTier: "reported",
          authorityReason: `review article (title signals literature synthesis) reclassified from primary`,
          updatedAt: now,
        })
        .where(eq(sourceDocumentsTable.id, doc.id));
      updated += 1;
    }

    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info(
      { scanned: docs.length, updated },
      "Applied review-article reclassify migration (primary → reported for synthesis papers)",
    );
  });
}

/**
 * Detached migration: re-validate all existing dictionary.com external_url
 * entries on concepts. Dictionary.com redirects unknown terms to phonetically
 * similar entries and appends `?mismatchType=misspelling` — that query param
 * is the reliable signal that they don't have the term. Validated (actually
 * existing) entries are kept; invalid ones are nulled out. Processes concepts
 * in batches of 10 concurrent HEAD requests to stay within time budget.
 */
async function applyValidateDictionaryComUrlsMigration(): Promise<void> {
  const MIGRATION_KEY = "validate_dictionary_com_urls_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  const concepts = await db
    .select({
      id: conceptsTable.id,
      slug: conceptsTable.slug,
      externalUrl: conceptsTable.externalUrl,
    })
    .from(conceptsTable)
    .where(sql`${conceptsTable.externalUrl} ILIKE '%dictionary.com%'`);

  let kept = 0;
  let nulled = 0;

  const BATCH = 10;
  for (let i = 0; i < concepts.length; i += BATCH) {
    const batch = concepts.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (concept) => {
        const url = concept.externalUrl!;
        let valid = false;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 4_000);
          const res = await fetch(url, {
            method: "HEAD",
            redirect: "follow",
            signal: controller.signal,
            headers: { "User-Agent": "Mozilla/5.0 (compatible; BrainHookBot/1.0)" },
          });
          clearTimeout(timer);
          if (res.ok) {
            const finalUrl = new URL(res.url);
            // No mismatchType = dict.com has this exact term
            valid = !finalUrl.searchParams.get("mismatchType");
          }
        } catch {
          valid = false;
        }
        if (!valid) {
          await db
            .update(conceptsTable)
            .set({ externalUrl: null, externalTitle: null })
            .where(eq(conceptsTable.id, concept.id));
          nulled++;
        } else {
          kept++;
        }
      }),
    );
  }

  await db.execute(
    sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
  );
  logger.info(
    { total: concepts.length, kept, nulled },
    "Validated dictionary.com concept URLs — kept entries dict.com actually has, nulled misleading ones",
  );
}

/**
 * One-time migration: reopen all manually-rejected clusters (`do_not_cover`)
 * so they return to the Editor Cockpit with the improved labeling logic. Only
 * `do_not_cover` clusters are reopened — clusters that were covered (turned
 * into articles) are intentionally left covered. Guarded by app_migrations.
 */
async function applyReviveRejectedClustersMigration(): Promise<void> {
  const MIGRATION_KEY = "revive_rejected_clusters_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  const reopenedIds = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:revive_rejected_clusters_v1'))`,
    );
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return [];

    // Reopen only manually-rejected clusters. Coverage memory for clusters that
    // became articles (coverage_status = 'covered') is preserved. RETURNING id
    // lets us recompute labels on the now-open clusters immediately so the DB
    // label reflects the new leadSnippet / bestTitle logic rather than the stale
    // domain label that caused the false rejection.
    const result = await tx.execute(
      sql`UPDATE "story_clusters" SET "coverage_status" = 'open', "coverage_reason" = NULL WHERE "coverage_status" = 'do_not_cover' RETURNING id`,
    );
    const ids = (result.rows as Array<{ id: string }>).map((r) => r.id);
    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info(
      { reopened: ids.length },
      "Revived manually-rejected clusters for re-labeling (revive_rejected_clusters_v1)",
    );
    return ids;
  });

  // Recompute labels for all reopened clusters outside the migration transaction
  // so the improved label logic writes back to the DB immediately. Runs at most
  // once (migration guard); failure on individual clusters is swallowed by
  // recomputeStoryCluster's own error handling.
  if (reopenedIds && reopenedIds.length > 0) {
    logger.info({ count: reopenedIds.length }, "Recomputing labels for revived clusters");
    for (const id of reopenedIds) {
      await recomputeStoryCluster(id);
    }
  }
}

/**
 * One-time backfill that recomputes labels for every active/dormant story
 * cluster using the improved bestTitle logic (title ?? leadSnippet ?? domain).
 * Older clusters were labeled at cluster-creation time before the leadSnippet
 * fallback was added, so their stored label may be a bare domain string
 * (e.g. "govinfo.gov"). Running recomputeStoryCluster on each cluster updates
 * the label from the representative source document's title or RSS headline.
 *
 * Runs at most once per database (guarded by an app_migrations marker).
 * Individual cluster failures are swallowed by recomputeStoryCluster's own
 * error handling so a single bad cluster never aborts the whole pass.
 */
async function applyClusterLabelBackfillMigration(): Promise<void> {
  const MIGRATION_KEY = "cluster_label_backfill_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  // Record the marker BEFORE the (potentially slow) recompute loop so that a
  // mid-run crash doesn't re-fan-out on the next boot and duplicate work.
  // Clusters that were missed due to a crash will be corrected naturally the
  // next time the clustering pass touches them.
  await db.execute(
    sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
  );

  const rows = await db
    .select({ id: storyClustersTable.id })
    .from(storyClustersTable)
    .where(inArray(storyClustersTable.status, ["active", "dormant"]));

  logger.info({ count: rows.length }, "cluster_label_backfill_v1: recomputing labels");
  let updated = 0;
  for (const { id } of rows) {
    await recomputeStoryCluster(id);
    updated += 1;
  }
  logger.info({ updated }, "cluster_label_backfill_v1: done");
}

/**
 * One-time backfill for GovInfo source documents ingested before feedWatcher
 * started seeding leadSnippet from the RSS item title / package ID: hundreds
 * of GovInfo PDFs have neither a title nor a leadSnippet, so their clusters
 * were labeled with the bare domain and the editor cockpit's top candidates
 * read as a wall of "govinfo.gov". Derives a readable title from the package
 * ID embedded in the stored content URL (e.g. CHRG-119hhrg63529 →
 * "Congressional Hearing 119-hhrg63529"), writes it to title (and leadSnippet
 * when that is also empty), then recomputes every cluster whose label still
 * looks like a bare domain so labels pick up the new titles.
 *
 * Idempotency: marker recorded BEFORE the slow loop (same contract as
 * cluster_label_backfill_v1); a mid-run crash leaves some docs untitled, which
 * only means their cluster label stays domainish until a clustering pass or a
 * future re-run key corrects it.
 */
async function applyGovInfoTitleBackfillMigration(): Promise<void> {
  const MIGRATION_KEY = "govinfo_title_backfill_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;
  await db.execute(
    sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
  );

  const docs = await db
    .select({
      id: sourceDocumentsTable.id,
      url: sourceDocumentsTable.url,
      canonicalUrl: sourceDocumentsTable.canonicalUrl,
      leadSnippet: sourceDocumentsTable.leadSnippet,
    })
    .from(sourceDocumentsTable)
    .where(
      and(
        sql`${sourceDocumentsTable.domain} ILIKE '%govinfo.gov'`,
        sql`COALESCE(${sourceDocumentsTable.title}, '') = ''`,
      ),
    );

  let titled = 0;
  for (const d of docs) {
    const pkgId = pkgIdFromGovInfoUrl(d.url) ?? pkgIdFromGovInfoUrl(d.canonicalUrl);
    const title = pkgId ? titleFromGovInfoPkgId(pkgId) : null;
    if (!title) continue;
    const hasSnippet = (d.leadSnippet ?? "").trim().length > 0;
    await db
      .update(sourceDocumentsTable)
      .set(hasSnippet ? { title } : { title, leadSnippet: title })
      .where(eq(sourceDocumentsTable.id, d.id));
    titled += 1;
  }

  // Relabel every cluster still carrying a bare-domain label (any domain, not
  // just govinfo — recompute is cheap and self-corrects from member titles).
  const clusters = await db
    .select({ id: storyClustersTable.id })
    .from(storyClustersTable)
    .where(
      and(
        inArray(storyClustersTable.status, ["active", "dormant"]),
        sql`${storyClustersTable.label} ~ '^[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$'`,
      ),
    );
  for (const { id } of clusters) {
    await recomputeStoryCluster(id);
  }
  logger.info(
    { untitledDocs: docs.length, titled, relabeledClusters: clusters.length },
    "govinfo_title_backfill_v1: done",
  );
}

/**
 * Fire a migration as a background promise that does NOT block the HTTP server
 * from accepting requests. Use this for any migration that iterates over a
 * large table or does non-trivial I/O — anything where a slow run would visibly
 * delay server readiness.
 *
 * Requirements for a safe detached migration:
 *  1. It must be idempotent — recording its completion marker in `app_migrations`
 *     BEFORE the slow work begins (so a mid-run crash doesn't re-fan-out on the
 *     next restart).
 *  2. It must not be a prerequisite for any blocking migration that runs in the
 *     same boot (i.e., no later `await` in runStartupSeed can depend on its
 *     output).
 *
 * The function logs start and completion automatically; the caller only needs to
 * pass the migration key (used in log lines) and the async function to run.
 *
 * A watchdog interval emits a "still running" warning every
 * DETACHED_MIGRATION_WATCHDOG_MS so hung migrations are visible in the logs.
 * A hard timeout (default DETACHED_MIGRATION_TIMEOUT_MS = 10 min) races the
 * migration and logs a timed-out failure if it is exceeded — the DB connection
 * is not forcibly killed, but the watchdog and success/failure accounting are
 * settled so the hung promise can't silently succeed later.
 */
const DETACHED_MIGRATION_TIMEOUT_MS = 10 * 60 * 1000;  // 10 minutes hard cap
const DETACHED_MIGRATION_WATCHDOG_MS = 2 * 60 * 1000;  // warn every 2 minutes

function runDetachedMigration(
  key: string,
  fn: () => Promise<void>,
  timeoutMs: number = DETACHED_MIGRATION_TIMEOUT_MS,
): void {
  logger.info({ key }, "Detached migration: starting in background");
  const startedAt = Date.now();
  // Set to true once the race settles (success or timeout/error). Used to
  // detect the case where fn() resolves *after* the race already timed out.
  let raceSettled = false;

  const watchdog = setInterval(() => {
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    logger.warn({ key, elapsedSec }, "Detached migration: still running");
  }, DETACHED_MIGRATION_WATCHDOG_MS);

  // Store the timeout handle so we can cancel it if fn() finishes first.
  // Without this, setTimeout fires after the race settles on success and
  // rejects timeoutPromise with no handler — an unhandled rejection warning.
  let timeoutHandle: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
  });

  // Start fn() once so both the race and the late-resolve guard share the
  // same promise instance.
  const migrationPromise = fn();

  // Secondary handler on the migration promise itself: if fn() resolves or
  // rejects AFTER the race has already settled on timeout, emit a warning so
  // the late completion is visible in logs rather than silently discarded.
  migrationPromise.then(
    () => {
      if (raceSettled) {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        logger.warn({ key, elapsedSec }, "Detached migration: resolved after timeout — accounting is final, ignoring late success");
      }
    },
    () => {
      // Rejection already surfaced through the race's error handler below;
      // the empty handler here prevents a spurious unhandled-rejection event
      // from this secondary attachment.
    },
  );

  void Promise.race([migrationPromise, timeoutPromise]).then(
    () => {
      raceSettled = true;
      clearInterval(watchdog);
      clearTimeout(timeoutHandle);
      logger.info({ key }, "Detached migration: complete");
    },
    (err: unknown) => {
      raceSettled = true;
      clearInterval(watchdog);
      clearTimeout(timeoutHandle);
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      logger.error({ err, key, elapsedSec }, "Detached migration: failed or timed out");
    },
  );
}

/**
 * One-time cleanup: NULL out any article_sources.source_title values that
 * match the junk-title guard (bot-wall interstitials such as "Radware Bot
 * Manager Captcha") that were stored before the JS guard included those
 * patterns. Resets accessed_at so the citation backfill can re-fetch those
 * URLs and pick up the real title on the next run.
 */
async function applyClearJunkSourceTitlesMigration(): Promise<void> {
  const MIGRATION_KEY = "clear_junk_source_titles_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('app_migration:clear_junk_source_titles_v1'))`,
    );
    const recheck = await tx.execute(
      sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
    );
    if (recheck.rows.length > 0) return;

    const updated = await tx.execute(sql`
      UPDATE "article_sources"
      SET "source_title" = NULL,
          "accessed_at"  = NULL,
          "updated_at"   = now()
      WHERE "role" = 'evidence'
        AND "status" <> 'rejected'
        AND "source_title" IS NOT NULL
        AND "source_title" ~* ${
          `^\\W*(just a moment|checking your browser|checking the site|checking if the site|` +
          `verify(ing)? (you|that)|are you a robot|robot check|` +
          `human verification|bot verification|browser (check|verification)|attention required|` +
          `access denied|access restricted|access to this page|security check(point)?|` +
          `captcha|cloudflare|ddos|radware|bot manager|` +
          `please enable (javascript|cookies)|javascript is (disabled|required)|` +
          `enable javascript|unsupported browser|your browser is|` +
          `page not found|redirect notice|redirecting|one moment|please wait|` +
          `request rejected|request blocked|rate limit exceeded)`
        }
    `);
    await tx.execute(
      sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
    );
    logger.info(
      { cleared: (updated as { rowCount?: number }).rowCount ?? 0 },
      "applyClearJunkSourceTitlesMigration: cleared junk source titles",
    );
  });
}

export async function runStartupSeed(): Promise<void> {
  // ── BLOCKING migrations ───────────────────────────────────────────────────
  // These must finish before the HTTP server is considered ready. Keep them
  // fast: single-row INSERTs / UPDATEs, schema guards, seed inserts on an
  // empty table. Anything that scans a large table belongs in the DETACHED
  // section below.
  await ensureRuntimeTables();
  await seedBeats();
  await seedMemeTemplates();
  await seedUtmPresets();
  // Run the slug rename BEFORE seedAuthors. seedAuthors now only bootstraps an
  // EMPTY table (it never re-inserts individual missing slugs — that used to
  // resurrect admin-deleted authors on every prod reboot), but the ordering is
  // kept so a fresh-DB bootstrap still sees renames applied first.
  await applyPaulWardellSlugMigration();
  await seedAuthors();
  await applyWeeklyRotationMigration();
  await applyAuthorCleanupMigration();
  await applyBeatAdjacencyMigration();
  await applySourceDocBeatBackfillMigration();
  await applySourceDocBeatBackfillV2Migration();
  await applyAuthorSubBeatsSpecMigration();
  await applyAuthorPrimaryBeatNameSyncMigration();
  await applyTruthfulDatesMigration();
  await applyClusterAuthorFixMigration();
  await applyCiteTagScrubMigration();
  await applyKillPicsumMigration();
  await applyDefaultCardV2Migration();
  await applyDefaultCardV3Migration();
  await applyStarterFeedsSeedMigration();
  await applyGovInfoFeedsSeedMigration();
  await applyCaptchaBackfillMigration();
  await applySimhashFalseDupRepairMigration();
  await applyFalseDupFamilyRepairMigration();
  await applyAuthorityReclassifyV1Migration();
  await applyReviewArticleReclassifyMigration();
  await applyReviveRejectedClustersMigration();
  await applyClearJunkSourceTitlesMigration();

  // ── DETACHED migrations ───────────────────────────────────────────────────
  // These fire as background promises immediately after the blocking section
  // completes. The HTTP server is already listening and must not be held
  // waiting for potentially slow table scans. Use runDetachedMigration() for
  // any future migration that iterates a large table or does heavy I/O.
  // See the runDetachedMigration() JSDoc above for the idempotency contract.
  runDetachedMigration("cluster_label_backfill_v1", applyClusterLabelBackfillMigration);
  runDetachedMigration("govinfo_title_backfill_v1", applyGovInfoTitleBackfillMigration);
  runDetachedMigration("concept_term_title_case_fix_v1", applyConceptTermTitleCaseFixMigration);
  // Validate existing dictionary.com URLs — keeps entries dict.com actually has,
  // nulls misleading ones (redirects to a different term). Runs in background
  // after boot since it makes ~700 HEAD requests.
  runDetachedMigration("validate_dictionary_com_urls_v1", applyValidateDictionaryComUrlsMigration);

  // Living Coverage Map table (Task #345).
  // Keep in sync with lib/db/src/schema/coverageMap.ts.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "coverage_map_items" (
      "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "concept_id"          uuid NOT NULL REFERENCES "concepts"("id") ON DELETE CASCADE,
      "classification"      text NOT NULL DEFAULT 'insufficient_data',
      "evidence_strength"   real NOT NULL DEFAULT 0,
      "source_diversity"    real NOT NULL DEFAULT 0,
      "evidence_freshness"  real NOT NULL DEFAULT 0,
      "coverage_depth"      real NOT NULL DEFAULT 0,
      "article_uniqueness"  real NOT NULL DEFAULT 0,
      "reader_interest"     real NOT NULL DEFAULT 0,
      "update_urgency"      real NOT NULL DEFAULT 0,
      "saturation"          real NOT NULL DEFAULT 0,
      "opportunity_score"   real NOT NULL DEFAULT 0,
      "recommended_action"  text NOT NULL DEFAULT 'monitor_only',
      "score_breakdown"     jsonb,
      "provenance_json"     jsonb,
      "input_fingerprint"   text NOT NULL DEFAULT '',
      "editorial_state"     text NOT NULL DEFAULT 'none',
      "editorial_note"      text,
      "idea_id"             uuid REFERENCES "topic_ideas"("id") ON DELETE SET NULL,
      "radar_suggestion_id" uuid REFERENCES "cross_beat_radar_suggestions"("id") ON DELETE SET NULL,
      "calculated_at"       timestamp with time zone NOT NULL DEFAULT now(),
      "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at"          timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "coverage_map_items_concept_unique"
      ON "coverage_map_items" ("concept_id")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "coverage_map_items_classification_idx"
      ON "coverage_map_items" ("classification")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "coverage_map_items_opportunity_idx"
      ON "coverage_map_items" ("opportunity_score")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "coverage_map_items_editorial_state_idx"
      ON "coverage_map_items" ("editorial_state")
  `);

  // --- Story Watch (Task #348) -------------------------------------------
  // article_kind: standard|update visibility control.
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "article_kind" text NOT NULL DEFAULT 'standard'
  `);
  // story_chain_id: UUID linking update articles back to their original.
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "story_chain_id" uuid
  `);
  // chain_position: 1-based ordering within the chain.
  await db.execute(sql`
    ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "chain_position" integer
  `);
  // Indexes for efficient chain queries.
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "articles_story_chain_idx" ON "articles" ("story_chain_id")
  `);
  // watched / watched_at on story_clusters.
  await db.execute(sql`
    ALTER TABLE "story_clusters" ADD COLUMN IF NOT EXISTS "watched" boolean NOT NULL DEFAULT false
  `);
  await db.execute(sql`
    ALTER TABLE "story_clusters" ADD COLUMN IF NOT EXISTS "watched_at" timestamp with time zone
  `);
  // watched_last_viewed_at on site_settings (for NEW badge computation).
  await db.execute(sql`
    ALTER TABLE "site_settings" ADD COLUMN IF NOT EXISTS "watched_last_viewed_at" timestamp with time zone
  `);
  // story_update_signals — racing cooldown tracker (one row per cluster).
  // Keep in sync with lib/db/src/schema/storyUpdateSignals.ts.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "story_update_signals" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "cluster_id" uuid NOT NULL,
      "track_type" text,
      "triggering_doc_ids" text[],
      "original_article_id" uuid,
      "last_signal_at" timestamp with time zone NOT NULL DEFAULT now(),
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "story_update_signals_cluster_idx"
      ON "story_update_signals" ("cluster_id")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "story_update_signals_last_signal_idx"
      ON "story_update_signals" ("last_signal_at")
  `);
  // Signal lifecycle columns (consumed/exhausted tracking).
  await db.execute(sql`
    ALTER TABLE "story_update_signals" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'pending'
  `);
  await db.execute(sql`
    ALTER TABLE "story_update_signals" ADD COLUMN IF NOT EXISTS "retry_count" integer NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE "story_update_signals" ADD COLUMN IF NOT EXISTS "consumed_at" timestamp with time zone
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "story_update_signals_status_idx"
      ON "story_update_signals" ("status")
  `);
  // article_relations — curated chain and subject-sibling links.
  // Keep in sync with lib/db/src/schema/articleRelations.ts.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "article_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "article_a_id" uuid NOT NULL,
      "article_b_id" uuid NOT NULL,
      "kind" text NOT NULL,
      "confidence" text,
      "rationale" text,
      "shared_citation_count" text,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "article_relations_pair_kind_key"
      ON "article_relations" ("article_a_id", "article_b_id", "kind")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "article_relations_a_idx"
      ON "article_relations" ("article_a_id")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "article_relations_b_idx"
      ON "article_relations" ("article_b_id")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "article_relations_kind_idx"
      ON "article_relations" ("kind")
  `);
  // Intermediary-aggregator flag for article_sources rows (SciSpace, ResearchGate,
  // Semantic Scholar). Rows with this flag are suppressed from the public References
  // list so readers see the original journal, not the mirror copy. Source of truth
  // is lib/db/src/schema/articleSources.ts; idempotent ADD COLUMN IF NOT EXISTS.
  await db.execute(sql`
    ALTER TABLE "article_sources" ADD COLUMN IF NOT EXISTS "is_intermediary" boolean NOT NULL DEFAULT false
  `);
  // One-time backfill: mark existing aggregator-domain rows immediately after the
  // column is created so they are suppressed on the very next public-references
  // request. Idempotent: only updates rows still flagged false; safe to run on
  // every boot with negligible overhead (predicated on 3 literal domain values).
  await db.execute(sql`
    UPDATE "article_sources"
    SET "is_intermediary" = true
    WHERE "is_intermediary" = false
      AND "domain" IN ('scispace.com', 'researchgate.net', 'semanticscholar.org', 'academia.edu', 'jstor.org', 'statista.com')
  `);

  logger.info({ categories: CATEGORIES.length }, "Startup seed complete");
}

// ---------------------------------------------------------------------------
// Concept term title-case migration
// ---------------------------------------------------------------------------

async function applyConceptTermTitleCaseFixMigration(): Promise<void> {
  const MIGRATION_KEY = "concept_term_title_case_fix_v1";
  const already = await db.execute(
    sql`SELECT 1 FROM "app_migrations" WHERE "key" = ${MIGRATION_KEY} LIMIT 1`,
  );
  if (already.rows.length > 0) return;
  function toTitleCase(term: string): string {
    const STOP = new Set(["a","an","the","and","but","or","for","nor","on","at","to","by","in","of","up","as"]);
    return term.replace(/\S+/g, (word: string, offset: number) => {
      if (offset === 0 || !STOP.has(word.toLowerCase())) {
        return word.charAt(0).toUpperCase() + word.slice(1);
      }
      return word.toLowerCase();
    });
  }

  const concepts = await db
    .select({ id: conceptsTable.id, term: conceptsTable.term })
    .from(conceptsTable);

  let updated = 0;
  for (const concept of concepts) {
    const newTerm = toTitleCase(concept.term);
    if (newTerm !== concept.term) {
      await db
        .update(conceptsTable)
        .set({ term: newTerm, updatedAt: new Date() })
        .where(eq(conceptsTable.id, concept.id));
      updated++;
    }
  }
  await db.execute(
    sql`INSERT INTO "app_migrations" ("key") VALUES (${MIGRATION_KEY}) ON CONFLICT DO NOTHING`,
  );
  logger.info({ updated }, "concept term title-case fix complete");
}
