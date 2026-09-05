import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  mergeWorldFindings,
  parseWorldFindingsFromModel,
  type AnalysisChunk,
  type WorldFindings,
} from "./worldAnalysis";
import { validateCuratedWorldFindings } from "./codexReviewReplay";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function jsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.resolve(filePath), "utf8")) as unknown;
}

function packetChunks(packet: unknown): AnalysisChunk[] {
  if (!isRecord(packet) || !isRecord(packet.sourceCorpus)) {
    throw new Error("The review packet omitted sourceCorpus.");
  }
  const rows = packet.sourceCorpus.chunks;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("The review packet contains no source passages.");
  }
  return rows.map((value, position) => {
    if (!isRecord(value)) throw new Error(`Passage ${position} is not an object.`);
    const id = typeof value.id === "string" ? value.id : "";
    const sourceId = typeof value.source_id === "string" ? value.source_id : "";
    const sourceTitle = typeof value.metadata === "object" && value.metadata &&
        typeof (value.metadata as JsonRecord).sourceTitle === "string"
      ? String((value.metadata as JsonRecord).sourceTitle)
      : "Imported source";
    const content = typeof value.content === "string" ? value.content : "";
    const index = Number(value.chunk_index);
    if (!id || !sourceId || !content || !Number.isInteger(index) || index < 0) {
      throw new Error(`Passage ${position} is missing its stable identity or content.`);
    }
    return { id, sourceId, sourceTitle, content, index };
  });
}

function countEvidence(value: unknown): number {
  let count = 0;
  const visit = (item: unknown, key = "") => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child, key);
      return;
    }
    if (!isRecord(item)) return;
    if (key === "evidence" && typeof item.chunkId === "string") count += 1;
    for (const [childKey, child] of Object.entries(item)) visit(child, childKey);
  };
  visit(value);
  return count;
}

const CANONICAL_ENTITY_NAMES = new Map<string, string>([
  ["alec", "Alec Sumner"],
  ["kendall", "Kendall Sumner"],
  ["dave", "David"],
  ["jim", "Jim Haskins"],
  ["tom", "Tom Bennett"],
  ["dissident matriarch", "Geela"],
  ["dave's raiders", "David's raiders"],
  ["anubsika", "Ragger"],
  ["ragger / anubsika", "Ragger"],
  ["anubsika / ragger", "Ragger"],
  ["queen", "Empress"],
  ["marlene", "Marlene's Changeling successor"],
  ["the original marlene", "Marlene (original human)"],
  ["antony / kondura", "Kondura"],
]);

const CANONICAL_ALIASES = new Map<string, string[]>([
  ["Alec Sumner", ["Alec"]],
  ["Kendall Sumner", ["Kendall"]],
  ["David", ["Dave"]],
  ["Jim Haskins", ["Jim", "Mayor Jim"]],
  ["Tom Bennett", ["Tom"]],
  ["Geela", ["Dissident Matriarch", "the Matriarch"]],
  ["Humanity", ["Human", "Humans"]],
  ["Hive Mind", ["The Hive"]],
  ["David's raiders", ["Dave's raiders"]],
  ["Alec's town community", ["Alec's town", "Present-day settlement"]],
  ["Alec's settlement", ["Present-day settlement"]],
  ["Marlene's Changeling successor", ["Marlene"]],
]);

const BOOK_TWO_SOURCE_ID = "356a7b64-37aa-4801-b2a2-fc13097dfe99";
const BOOK_ONE_SOURCE_ID = "9c0ba9f3-2058-4d7a-8918-c7637954f054";
const RELATIONSHIP_WEB_CANONICAL_NAMES = new Map<string, string>([
  ["molly / shanta", "Shanta"],
  ["michael's vit", "Michael's replacement Vit"],
  ["karagorn mentor", "Karagorn"],
  ["sanctuary turncoats", "Sanctuary survivors"],
  ["alec's town", "Alec's town community"],
]);

const MICHAEL_REPLACEMENT_VIT_EVIDENCE = [{
  chunkId: "fbca8752-95e3-4541-8d5d-5032f88a73ac",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "Once I pledged my utter servitude, the Empress bestowed upon me a new Vit. One to match your power.",
}, {
  chunkId: "8411de5e-396b-4d9c-aa13-9c76e44b07b2",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "My Vit exists within me, as my partner, but it does not have a true voice.",
}];
const MICHAEL_THRALL_IDENTITY_EVIDENCE = {
  chunkId: "f68572bf-76d3-4e9c-ad66-d54897c39f7a",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "I see the Empress has found a new Thrall.",
};
const MICHAEL_THRALL_STRENGTH_EVIDENCE = {
  chunkId: "fbca8752-95e3-4541-8d5d-5032f88a73ac",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "It batted my hands away with ease, spinning me away.",
};

// Character dossiers can carry fine-grained ability phrases that are useful
// prose but are not durable power-card identities. Reconcile only the cases
// where the reviewed corpus supports an existing canonical card. An empty
// target list intentionally removes the label from `powers`; the fuller
// capability prose remains on the dossier for a later, evidence-backed review.
const DOSSIER_POWER_RECONCILIATION = new Map<string, string[]>([
  ["alec sumner\0enhanced senses", ["Thermal vision", "Ultraviolet vision"]],
  ["alec sumner\0extreme physical force", ["Superhuman strength"]],
  ["alec sumner\0constellation-pattern allegiance response", []],
  ["echo\0regeneration", ["Rapid regeneration"]],
  ["echo\0neurochemical modulation", ["Echo neurochemical control"]],
  ["echo\0transformation", ["Hybrid transformation"]],
  ["echo\0enhanced perception", ["Thermal vision", "Ultraviolet vision"]],
  ["ragger\0multi-host shapeshifting", ["Stored-host transformation"]],
  ["ragger\0psychic intrusion", []],
  ["ragger\0genetic memory", []],
  ["ragger\0acid projection", []],
  ["ragger\0rapid growth and combat transformation", ["Stored-host transformation"]],
  ["ragger\0enhanced senses", []],
  ["geela\0matriarch physiology", []],
  ["geela\0extreme strength", []],
  ["michael\0thrall transformation", []],
  ["michael\0extreme strength", []],
  ["michael\0rapid healing", []],
  ["michael\0partial human/alien form", []],
  ["michael\0imperial psychic-network access through affiliation", []],
  ["shanta\0neural activity sensing", ["Mind Web"]],
  ["marlene's changeling successor\0reaver transformation", ["Changeling mimicry"]],
  ["marlene's changeling successor\0telepathic sensing", []],
  ["molly\0changeling transformation through shanta", ["Changeling mimicry"]],
  ["molly\0mind web access through shanta", ["Mind Web"]],
  ["kondura\0partial transformation", ["Changeling mimicry"]],
]);
const DOSSIER_POWER_REMOVALS = new Set([
  "alec sumner\0accelerated healing",
  "echo\0accelerated healing",
  "geela\0superhuman strength",
  "michael\0accelerated healing",
  "shanta\0telepathy",
]);
const ANTONY_KONDURA_IDENTITY_EVIDENCE = {
  chunkId: "7622a341-3413-4f7b-bf85-e3034c9e7c7e",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "I am… Kondura. My host is… Antony…",
};
const ANTONY_KONDURA_CONTROL_EVIDENCE = {
  chunkId: "c980c7de-9435-4dee-a626-baaeddb5f82f",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "I pivoted to find Antony - no, Kondura - wait, could it be Antony?",
};
const ANTONY_HUMAN_FORM_EVIDENCE = {
  chunkId: "762d8931-8a42-4bd3-9c84-21a7ecfcde46",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "Within moments, a teenage boy knelt before me",
};
const MARLENE_HOST_EVIDENCE = {
  chunkId: "f8ecb173-a7bb-47fe-9fd5-aa240edd10a8",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "I have held this host since the first days of our arrival.",
};
const MARLENE_DEATH_EVIDENCE = {
  chunkId: "f8ecb173-a7bb-47fe-9fd5-aa240edd10a8",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "The original Marlene is dead, I am sorry.",
};
const CHANGELING_MIMICRY_EVIDENCE = {
  chunkId: "90c0f0b3-7c9d-4136-8a27-b3bac60c0c76",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "The changelings, however, could swap between their original host’s appearance and their Turned forms.",
};
const TURNED_ACCELERATED_HEALING_EVIDENCE = {
  chunkId: "fa08c73c-51a4-4e86-8336-9c35ff0231fd",
  sourceId: BOOK_ONE_SOURCE_ID,
  quote: "They heal fast - incredibly fast. The damage I had seen was non-existent after just a few hours.",
};
const ALEC_ACCELERATED_HEALING_EVIDENCE = {
  chunkId: "43c5bf25-bcb5-4e21-8249-93fabc70c682",
  sourceId: BOOK_ONE_SOURCE_ID,
  quote: "Bullets tore through my body, leaving 158 fleeting wounds that healed almost instantly.",
};
const ECHO_NEURAL_RESCUE_EVIDENCE = {
  chunkId: "cb9a70f2-e298-4d40-b9d0-240dcf3eeac9",
  sourceId: BOOK_ONE_SOURCE_ID,
  quote: "There it was. A single speck, mote of consciousness, hanging in the dark, aching with sadness and regret and pain.",
};
const ECHO_HEART_RESTART_EVIDENCE = {
  chunkId: "cb9a70f2-e298-4d40-b9d0-240dcf3eeac9",
  sourceId: BOOK_ONE_SOURCE_ID,
  quote: "Thump. The heart beat once and then fell still. Several long seconds passed. Thump. Yes, yes! Thump.",
};
const ALEC_TRANSFORMATION_REGEN_EVIDENCE = {
  chunkId: "d89c40ae-e1ef-464f-b475-2a5477196acd",
  sourceId: BOOK_ONE_SOURCE_ID,
  quote: "Blood sprayed across the ground, only to be instantaneously healed by the pulsating energy coursing through me.",
};
const ALEC_IMMORTALITY_BELIEF_EVIDENCE = {
  chunkId: "e53626d1-3d90-4ccd-92d4-6766fad70a6d",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "Pretty sure I'm functionally immortal.",
};
const HYBRID_BOND_EVIDENCE = {
  chunkId: "d139466a-863e-4f48-8c54-e0110334df6e",
  sourceId: BOOK_ONE_SOURCE_ID,
  quote: "This monstrous form was proof of the symbiotic bond I shared with Echo; a fusion of two worlds that should have never met.",
};
const HYBRID_REVERSION_EVIDENCE = {
  chunkId: "8cfc2c3f-ce70-40b2-8481-466b61e74a03",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "Alec transforming from a nightmarish creature into his human form right before our eyes.",
};
const ECHO_INITIATES_TRANSFORMATION_EVIDENCE = {
  chunkId: "445293fc-2bd0-4c54-ae86-82169ea05f1d",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "So I forced you into your other form so they would run you off.",
};
const ECHO_TELEPATHY_EVIDENCE = {
  chunkId: "e4b6a2a8-f057-4b72-8915-d341e1f1b094",
  sourceId: BOOK_ONE_SOURCE_ID,
  quote: "You're in my head, a constant reminder of a fight I can't win.",
};
const MATRIARCH_TELEPATHY_EVIDENCE = {
  chunkId: "07e3445c-73f7-48f0-9d76-a8c7a15615ad",
  sourceId: BOOK_ONE_SOURCE_ID,
  quote: "the Matriarch repeated, this time telepathically, her command echoing in my mind",
};
const ALEC_TELEPATHY_EVIDENCE = {
  chunkId: "07e3445c-73f7-48f0-9d76-a8c7a15615ad",
  sourceId: BOOK_ONE_SOURCE_ID,
  quote: "I shot back mentally, pouring every ounce of defiance I had into the thought.",
};
const EMPRESS_TELEPATHY_EVIDENCE = {
  chunkId: "f7970c5b-0a6e-4079-9fe8-a41f278008af",
  sourceId: BOOK_ONE_SOURCE_ID,
  quote: "Her voice slips through the cracks in my skull. My queen. My mother.",
};
const RAGGER_TELEPATHY_EVIDENCE = {
  chunkId: "c94041c5-eacc-4b14-a294-8ead7d2fad8d",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "voice slipped through my mind almost too quickly to process.",
};
const ALEC_SUPERHUMAN_STRENGTH_EVIDENCE = {
  chunkId: "d89c40ae-e1ef-464f-b475-2a5477196acd",
  sourceId: BOOK_ONE_SOURCE_ID,
  quote: "Muscles bulged and multiplied at an unnatural rate, giving me strength beyond what any human could possess.",
};
const ALEC_TREE_STRENGTH_EVIDENCE = {
  chunkId: "5fa9fb2c-99f8-4c5f-abb8-aabed567b43d",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "Alec heaved against the fallen giant, his muscles straining as he shoved the tree aside.",
};
const ECHO_NEURAL_LINK_EVIDENCE = {
  chunkId: "b4529385-e6e4-4ed6-ab83-ec04c3c56ff4",
  sourceId: BOOK_ONE_SOURCE_ID,
  quote: "I dug several of my neural links into the spine, searching for a connection to the human's brain.",
};
const KARAGAUNT_FORM_EVIDENCE = {
  chunkId: "4b06c072-a93f-4f9b-9fb6-e1e2f3262f49",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "A tail that must have been three to four meters long, with a multi-faceted blade upon it.",
};
const ALEC_PARTIAL_TRANSFORMATION_EVIDENCE = {
  chunkId: "5ccc026e-31c0-4551-8c37-aebba880365f",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "Two additional pinkies burst forth from the side of his mutating hand",
};
const ALEC_PARTIAL_REVERSION_EVIDENCE = {
  chunkId: "df788065-d800-4427-bc65-2bcb37aae630",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "The additional fingers shriveled and were reabsorbed into the meat of his palm.",
};
const RAGGER_STORED_HOST_TRANSFORMATION_EVIDENCE = {
  chunkId: "f68572bf-76d3-4e9c-ad66-d54897c39f7a",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "I carry with me all the genetic patterns of my former hosts.",
};
const ECHO_NEUROCHEMICAL_EVIDENCE = {
  chunkId: "f8a9edf4-381f-4951-ad97-fdfeb06ac800",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "I stimulated your dopamine centers.",
};
const SHANTA_MIND_WEB_EVIDENCE = {
  chunkId: "13e4be77-f886-476e-9111-23c93b43a8ab",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "I make a Mind Web.",
};
const SHANTA_MIND_WEB_MONITORING_EVIDENCE = {
  chunkId: "13e4be77-f886-476e-9111-23c93b43a8ab",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "She can see and hear all Visharath brain activity about her.",
};
const PSYCHIC_MEMORY_TRANSFER_EVIDENCE = {
  chunkId: "f39d3ab4-407b-4609-a2bf-3220f9f97ffd",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "With a single mental strike, the Karagaunt shattered my defenses, a deluge of alien memories and revelations flooding my consciousness.",
};
const CHANGELING_SHARED_CONTROL_EVIDENCE = {
  chunkId: "16b0ded2-597b-43a8-95e2-d97e99505998",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "They took turns being in control, as many Turncoats did.",
};
const MARLENE_REAVER_TRANSFORMATION_EVIDENCE = {
  chunkId: "132be0e4-801c-4375-9663-5792edb540eb",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "Marlene's features began to warp and flow, bones and muscle writhed in grotesque undulations beneath her skin, until there, in her place, stood another Reaver.",
};
const KONDURA_MIMICRY_EVIDENCE = {
  chunkId: "762d8931-8a42-4bd3-9c84-21a7ecfcde46",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "Within moments, a teenage boy knelt before me, his features terrified but undeniably human.",
};
const MATRIARCH_ROYAL_JELLY_EVIDENCE = {
  chunkId: "5ffa9434-1b61-4237-b8a9-fa0c7daec6a9",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "Her royal jelly splashed over my wounds, the soothing balm staunching the damage everywhere but where the Destroyer itself had dispensed its venom into my face.",
};
const VORHEKT_DEFINITION_EVIDENCE = {
  chunkId: "817c4537-7b83-432f-a1b0-3c6fa32a20a7",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "a ritual in which a Vit melds new genetic material into their host",
};
const VORHEKT_VARIABILITY_EVIDENCE = {
  chunkId: "0c7efe00-1787-4fba-9406-2b287d29153f",
  sourceId: BOOK_TWO_SOURCE_ID,
  quote: "the Vorhekt has unpredictable effects in that it combines the host's DNA directly with the Vit inside of it to create a wholly new creature.",
};

// The model sometimes puts roles, family relationships, creature forms, and
// titles in `aliases`. Those values are useful facts, but they are not names;
// retaining them as aliases makes later same-person matching unsafe. They are
// already represented by typed relations, title cards, creature cards, powers,
// or dossier prose in the curated reviews.
const NON_NAME_CHARACTER_ALIASES = new Map<string, Set<string>>([
  ["Alec Sumner", new Set(["the destroyer", "karagaunt", "the stalker", "chief"])],
  ["David", new Set(["raider dave"])],
  ["Echo", new Set(["alec's vit", "daughter"])],
  ["Kendall Sumner", new Set(["little brother"])],
  ["Lilly", new Set(["alec's wife"])],
  ["Ragger", new Set(["first karagorn", "protector", "fallen high regent", "god of death"])],
  ["Geela", new Set(["dissident matriarch", "the matriarch", "matriarch"])],
  ["Michael", new Set(["the thrall", "second destroyer", "alec's brother"])],
  ["Shanta", new Set(["nodule", "mind web creator"])],
  ["Jim Haskins", new Set(["mayor jim", "town leader"])],
  ["Marlene", new Set(["the original marlene's changeling successor"])],
  ["Mathis", new Set(["big guy"])],
  ["Amy Sumner", new Set(["alec's mother"])],
  ["Molly", new Set(["shanta's host", "little girl"])],
  ["Danny", new Set(["storyteller"])],
]);

const COMPOUND_ENTITY_NAMES = new Map<string, string>([
  ["alec and echo", "Alec Sumner and Echo"],
  ["alec / echo", "Alec Sumner / Echo"],
  ["alec and echo bond", "Alec Sumner and Echo bond"],
  ["alec and echo's blood", "Alec Sumner and Echo's blood"],
  ["alec and echo's bones", "Alec Sumner and Echo's bones"],
  ["alec's transformation", "Alec Sumner's transformation"],
  ["alec's body", "Alec Sumner's body"],
  ["alec's family", "Alec Sumner's family"],
  ["kendall and lilly", "Kendall Sumner and Lilly"],
  ["sarah and alec", "Sarah and Alec Sumner"],
]);

function canonicalEntityName(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return CANONICAL_ENTITY_NAMES.get(trimmed.toLocaleLowerCase()) ??
    COMPOUND_ENTITY_NAMES.get(trimmed.toLocaleLowerCase()) ?? trimmed;
}

function uniqueValues(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function splitConflatedCharacters(rows: JsonRecord[]): JsonRecord[] {
  const result: JsonRecord[] = [];
  for (const row of rows) {
    const name = typeof row.name === "string" ? row.name.trim().toLocaleLowerCase() : "";
    if (name === "antony / kondura") {
      const sharedRelationship = [{
        name: "Kondura",
        relationship: "human host sharing one body",
        summary: "Kondura explicitly identifies Antony as the human host, while the viewpoint cannot reliably tell which consciousness is acting.",
        sentiment: "unknown",
        evidence: [ANTONY_KONDURA_IDENTITY_EVIDENCE, ANTONY_KONDURA_CONTROL_EVIDENCE],
      }];
      result.push({
        name: "Antony",
        aliases: [],
        role: "Teenage human host who shares a Changeling body with Kondura.",
        summary: "Kondura identifies Antony as the human host. Lilly sees their shared body take Antony's teenage human form, but the narration explicitly cannot determine whether Antony or Kondura is controlling it in a later exchange.",
        traits: [],
        motivations: [],
        fears: [],
        capabilities: [],
        history: ["Kondura identifies Antony as the human host in their shared Changeling body."],
        origins: ["Human host."],
        powers: [],
        moralSystem: [],
        physicalCharacteristics: ["Teenage boy; this is the human form of the body shared with Kondura."],
        relationships: ["Human host sharing one body with Kondura; current control is unresolved."],
        relationshipWeb: sharedRelationship,
        knowledge: [],
        secrets: ["The text does not resolve whether Antony or Kondura controls the shared body in every scene."],
        factionMemberships: [],
        evidence: [ANTONY_KONDURA_IDENTITY_EVIDENCE, ANTONY_HUMAN_FORM_EVIDENCE, ANTONY_KONDURA_CONTROL_EVIDENCE],
        confidence: 0.98,
        reviewStatus: "verified",
      });
      result.push({
        ...structuredClone(row),
        name: "Kondura",
        aliases: [],
        role: "Vit Changeling sharing a body with the teenage human host Antony and seeking Sanctuary.",
        summary: "Kondura names itself and separately identifies Antony as its human host. The shared body reaches ruined Sanctuary, takes Antony's teenage human form, accepts Lilly's offer of safety, and seeks food; the viewpoint explicitly remains uncertain which consciousness is acting at a given moment.",
        origins: ["Vit Changeling sharing a body with the human host Antony."],
        relationships: ["Shares one body with Antony.", "Lilly offers the pair safety, food, and a place among Sanctuary's survivors."],
        relationshipWeb: [{
          name: "Antony",
          relationship: "Vit sharing one body with its human host",
          summary: "Kondura explicitly calls Antony its host, but scene-level control of their shared body is uncertain.",
          sentiment: "unknown",
          evidence: [ANTONY_KONDURA_IDENTITY_EVIDENCE, ANTONY_KONDURA_CONTROL_EVIDENCE],
        }, ...(Array.isArray(row.relationshipWeb) ? row.relationshipWeb : [])],
        evidence: uniqueObjectValues([
          ANTONY_KONDURA_IDENTITY_EVIDENCE,
          ANTONY_HUMAN_FORM_EVIDENCE,
          ANTONY_KONDURA_CONTROL_EVIDENCE,
          ...(Array.isArray(row.evidence) ? row.evidence : []),
        ]),
      });
      continue;
    }
    const isMarleneSuccessor = name === "marlene" &&
      (Array.isArray(row.evidence) && row.evidence.some((item) =>
        isRecord(item) && item.chunkId === MARLENE_DEATH_EVIDENCE.chunkId
      ));
    if (isMarleneSuccessor) {
      result.push({
        ...structuredClone(row),
        name: "Marlene's Changeling successor",
        aliases: uniqueValues([...(Array.isArray(row.aliases) ? row.aliases : []), "Marlene"]),
        role: "Unnamed Turncoat Changeling who uses Marlene's body and social identity, co-leads Alec's town, and loves Jim.",
        summary: "An unnamed Changeling has held the original human Marlene as a host since the first days of the invasion. The original Marlene is dead; the successor continues using her body and name, helps lead the town, belongs to the Turncoats, and affirms genuine love for Jim.",
        origins: ["Unnamed Vit Changeling using the deceased original human Marlene's body and social identity."],
        evidence: uniqueObjectValues([
          MARLENE_HOST_EVIDENCE,
          MARLENE_DEATH_EVIDENCE,
          ...(Array.isArray(row.evidence) ? row.evidence : []),
        ]),
      });
      result.push({
        name: "Marlene (original human)",
        aliases: ["original Marlene"],
        role: "Deceased human host whose body and social identity are used by an unnamed Changeling successor.",
        summary: "The present Changeling says it has held the human Marlene as a host since the first days of the invasion and states that the original Marlene is dead. The successor regrets her death and believes they might otherwise have been friends; the manuscript provides no independent account of the original woman's character or agency.",
        traits: [],
        motivations: [],
        fears: [],
        capabilities: [],
        history: ["Became the host used by an unnamed Changeling during the first days of the invasion.", "Confirmed dead by the Changeling successor."],
        origins: ["Human."],
        powers: [],
        moralSystem: [],
        physicalCharacteristics: [],
        relationships: ["Former human host and assumed identity of Marlene's Changeling successor."],
        relationshipWeb: [{
          name: "Marlene's Changeling successor",
          relationship: "former human host and assumed identity",
          summary: "The unnamed Changeling says it held Marlene as its host and continues using her identity after the original human's death.",
          sentiment: "unknown",
          evidence: [MARLENE_HOST_EVIDENCE, MARLENE_DEATH_EVIDENCE],
        }],
        knowledge: [],
        secrets: [],
        factionMemberships: [],
        evidence: [MARLENE_HOST_EVIDENCE, MARLENE_DEATH_EVIDENCE],
        confidence: 0.99,
        reviewStatus: "verified",
      });
      continue;
    }
    result.push(row);
  }
  return result;
}

function uniqueObjectValues<T>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeArrayValues(left: unknown, right: unknown): unknown[] {
  const values = [
    ...(Array.isArray(left) ? left : []),
    ...(Array.isArray(right) ? right : []),
  ];
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function namedRows(record: JsonRecord, key: string): JsonRecord[] {
  const rows = record[key];
  return Array.isArray(rows) ? rows.filter(isRecord) : [];
}

function mergeNamedRow(target: JsonRecord[], incoming: JsonRecord): void {
  const name = typeof incoming.name === "string" ? incoming.name.trim() : "";
  if (!name) return;
  const current = target.find((row) =>
    typeof row.name === "string" && row.name.toLocaleLowerCase() === name.toLocaleLowerCase()
  );
  if (!current) {
    target.push(incoming);
    return;
  }
  for (const key of ["aliases", "details", "relationships", "evidence", "factionMemberships"]) {
    current[key] = mergeArrayValues(current[key], incoming[key]);
  }
  if ((!current.summary || String(current.summary).length < String(incoming.summary ?? "").length) && incoming.summary) {
    current.summary = incoming.summary;
  }
  current.confidence = Math.max(Number(current.confidence) || 0, Number(incoming.confidence) || 0);
}

function moveNamedRow(
  record: JsonRecord,
  from: string,
  to: string,
  sourceName: string,
  canonicalName = sourceName,
): void {
  const source = namedRows(record, from);
  const moved = source.filter((row) =>
    typeof row.name === "string" && row.name.toLocaleLowerCase() === sourceName.toLocaleLowerCase()
  );
  if (moved.length === 0) return;
  record[from] = source.filter((row) => !moved.includes(row));
  const target = namedRows(record, to);
  for (const row of moved) {
    const oldName = String(row.name);
    row.name = canonicalName;
    row.aliases = uniqueValues([
      ...(Array.isArray(row.aliases) ? row.aliases : []),
      ...(oldName.toLocaleLowerCase() === canonicalName.toLocaleLowerCase() ? [] : [oldName]),
      ...(CANONICAL_ALIASES.get(canonicalName) ?? []),
    ]);
    mergeNamedRow(target, row);
  }
  record[to] = target;
}

function renameNamedRow(record: JsonRecord, category: string, sourceName: string, canonicalName: string): void {
  const rows = namedRows(record, category);
  for (const row of rows) {
    if (typeof row.name !== "string" || row.name.toLocaleLowerCase() !== sourceName.toLocaleLowerCase()) continue;
    const oldName = row.name;
    row.name = canonicalName;
    row.aliases = uniqueValues([
      ...(Array.isArray(row.aliases) ? row.aliases : []),
      oldName,
      ...(CANONICAL_ALIASES.get(canonicalName) ?? []),
    ]);
  }
  const merged: JsonRecord[] = [];
  for (const row of rows) mergeNamedRow(merged, row);
  record[category] = merged;
}

function removeAliases(record: JsonRecord, category: string, name: string, aliases: string[]): void {
  const blocked = new Set(aliases.map((alias) => alias.toLocaleLowerCase()));
  for (const row of namedRows(record, category)) {
    if (typeof row.name !== "string" || row.name.toLocaleLowerCase() !== name.toLocaleLowerCase()) continue;
    row.aliases = uniqueValues(Array.isArray(row.aliases) ? row.aliases : [])
      .filter((alias) => !blocked.has(alias.toLocaleLowerCase()));
  }
}

function absorbAnubsikaTitleIntoRagger(record: JsonRecord): void {
  const titles = namedRows(record, "titles");
  const anubsikaRows = titles.filter((row) =>
    typeof row.name === "string" && row.name.toLocaleLowerCase() === "anubsika"
  );
  if (anubsikaRows.length === 0) return;
  const characters = namedRows(record, "characters");
  const ragger = characters.find((row) =>
    typeof row.name === "string" && row.name.toLocaleLowerCase() === "ragger"
  );
  if (ragger) {
    ragger.aliases = uniqueValues([
      ...(Array.isArray(ragger.aliases) ? ragger.aliases : []),
      "Anubsika",
      "Anubis",
    ]);
    ragger.evidence = uniqueObjectValues([
      ...(Array.isArray(ragger.evidence) ? ragger.evidence : []),
      ...anubsikaRows.flatMap((row) => Array.isArray(row.evidence) ? row.evidence : []),
    ]);
  }
  record.titles = titles.filter((row) => !anubsikaRows.includes(row));
}

type MembershipRule = {
  target?: string;
  relationType?: string;
  status?: string;
  keep?: boolean;
};

const MEMBERSHIP_RULES = new Map<string, MembershipRule>([
  ["alec's early survivor group", { target: "Alec's convoy", relationType: "member_of", status: "former" }],
  ["present-day settlement prisoner", {}],
  ["alec and echo symbiosis", {}],
  ["visharath", { target: "Visharath", relationType: "species_of", status: "active" }],
  ["sanctuary survivors", { target: "Sanctuary survivors", keep: true }],
  ["sanctuary survivors (deceased member)", { target: "Sanctuary survivors", relationType: "member_of", status: "former" }],
  ["thralls", {}],
  ["alec's town (former resident and scout leader)", { target: "Alec's town community", relationType: "member_of", status: "former" }],
  ["former colony core", { target: "The colony", relationType: "member_of", status: "former" }],
  ["vit empire (former)", { target: "Vit Empire", relationType: "member_of", status: "former" }],
  ["ancient earth scouting party (former)", { target: "Ancient Earth scouting party", relationType: "member_of", status: "former" }],
  ["dave's raiders (former leader)", { target: "David's raiders", relationType: "leads", status: "former" }],
  ["alec's town (former/conditional)", { target: "Alec's town community", relationType: "member_of", status: "conditional" }],
  ["kendall's rescue coalition (implied by later camp presence)", { target: "Kendall's rescue coalition", relationType: "member_of", status: "unknown" }],
  ["kendall's rescue coalition (later presence, exact status uncertain)", { target: "Kendall's rescue coalition", relationType: "member_of", status: "unknown" }],
  ["slcpd (former)", { target: "Salt Lake City Police Department", relationType: "member_of", status: "former" }],
  ["old colony core", { target: "The colony", keep: true }],
  ["father kelp's refuge", { target: "Father Kelp's refuge", relationType: "participates_in", status: "active" }],
  ["alec's college", { target: "Alec's college", relationType: "participates_in", status: "former" }],
  ["present-day settlement", { target: "Alec's town community", keep: true }],
  ["alec's town", { target: "Alec's town community", keep: true }],
  ["dave's raiders", { target: "David's raiders", keep: true }],
]);

function normalizeCodexGroup(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const record = structuredClone(value) as JsonRecord;

  moveNamedRow(record, "factions", "species", "Visharath");
  moveNamedRow(record, "ambiguous", "species", "Abbrakor");
  moveNamedRow(record, "ambiguous", "factions", "Turned");
  moveNamedRow(record, "institutions", "governments", "Visharath Council");
  moveNamedRow(record, "ambiguous", "locations", "Sanctuary");
  moveNamedRow(record, "locations", "institutions", "Hill Air Force Base");
  moveNamedRow(record, "locations", "institutions", "Tooele Army Depot");
  moveNamedRow(record, "titles", "creatures", "Matriarch");
  moveNamedRow(record, "titles", "creatures", "Thrall");
  const anubsikaTitleEvidence = namedRows(record, "titles")
    .filter((row) => typeof row.name === "string" && row.name.toLocaleLowerCase() === "anubsika")
    .flatMap((row) => Array.isArray(row.evidence) ? row.evidence : []);
  renameNamedRow(record, "titles", "Queen", "Empress");
  absorbAnubsikaTitleIntoRagger(record);
  renameNamedRow(record, "species", "Human", "Humanity");
  renameNamedRow(record, "powerStructures", "The Hive", "Hive Mind");
  renameNamedRow(record, "factions", "Dave's raiders", "David's raiders");
  renameNamedRow(record, "factions", "Alec's town", "Alec's town community");
  renameNamedRow(record, "locations", "Present-day settlement", "Alec's settlement");
  removeAliases(record, "factions", "Vit Empire", ["the Hive"]);
  removeAliases(record, "governments", "The Empress and Council", ["Vit Empire"]);
  removeAliases(record, "titles", "Empress", ["mother"]);

  const relationRows = namedRows(record, "entityRelations");
  const sourceCharacters = namedRows(record, "characters");
  const hadAntonyKondura = sourceCharacters.some((character) =>
    typeof character.name === "string" && character.name.toLocaleLowerCase() === "antony / kondura"
  );
  const hadMarleneSuccessor = sourceCharacters.some((character) =>
    typeof character.name === "string" && character.name.toLocaleLowerCase() === "marlene" &&
    Array.isArray(character.evidence) && character.evidence.some((item) =>
      isRecord(item) && item.chunkId === MARLENE_DEATH_EVIDENCE.chunkId
    )
  );
  const hadMichaelReplacementVit = sourceCharacters.some((character) =>
    Array.isArray(character.relationshipWeb) && character.relationshipWeb.some((relationship) =>
      isRecord(relationship) &&
      typeof relationship.name === "string" &&
      relationship.name.trim().toLocaleLowerCase() === "michael's vit"
    )
  );
  const characters = splitConflatedCharacters(sourceCharacters);
  for (const character of characters) {
    const originalName = typeof character.name === "string" ? character.name.trim() : "";
    const canonicalName = canonicalEntityName(originalName);
    character.name = canonicalName;
    const nonNameAliases = NON_NAME_CHARACTER_ALIASES.get(canonicalName) ?? new Set<string>();
    character.aliases = uniqueValues([
      ...(Array.isArray(character.aliases) ? character.aliases : []),
      ...(originalName && originalName.toLocaleLowerCase() !== canonicalName.toLocaleLowerCase() ? [originalName] : []),
      ...(CANONICAL_ALIASES.get(canonicalName) ?? []),
    ]).filter((alias) =>
      alias.toLocaleLowerCase() !== canonicalName.toLocaleLowerCase() &&
      !nonNameAliases.has(alias.toLocaleLowerCase())
    );
    if (Array.isArray(character.relationshipWeb)) {
      for (const relationship of character.relationshipWeb) {
        if (isRecord(relationship)) relationship.name = canonicalEntityName(relationship.name);
      }
    }
    const cleanedMemberships: string[] = [];
    for (const membership of Array.isArray(character.factionMemberships) ? character.factionMemberships : []) {
      if (typeof membership !== "string") continue;
      // Michael's imperial alignment is already represented by the cited
      // controlled_by relation to the Empress and Council.  The customer's
      // existing canon merges the old "Vit Empire" faction card into the
      // Visharath species card, so retaining this as a faction membership
      // would either create a duplicate faction or attach him to a species
      // through the wrong relationship type.
      if (
        canonicalName === "Michael" &&
        membership.trim().toLocaleLowerCase() === "vit empire"
      ) {
        continue;
      }
      const rule = MEMBERSHIP_RULES.get(membership.trim().toLocaleLowerCase());
      if (!rule) {
        cleanedMemberships.push(membership.trim());
        continue;
      }
      if (rule.keep && rule.target) cleanedMemberships.push(rule.target);
      if (rule.relationType && rule.target) {
        relationRows.push({
          subject: canonicalName,
          relationType: rule.relationType,
          target: rule.target,
          status: rule.status ?? "active",
          summary: `${canonicalName} has a source-grounded ${rule.status ?? "active"} connection to ${rule.target}.`,
          validFromLabel: "",
          validUntilLabel: "",
          evidence: Array.isArray(character.evidence) ? character.evidence : [],
          confidence: Number(character.confidence) || 0.75,
          reviewStatus: "verified",
        });
      }
    }
    character.factionMemberships = uniqueValues(cleanedMemberships);
  }
  record.characters = characters;

  // Michael and the unnamed Vit placed in him by the Empress share a body,
  // but they are not one identity.  Keep the passenger as its own indexed
  // creature and connect the two instead of resolving "Michael's Vit" to
  // Michael's character card.
  if (hadMichaelReplacementVit) {
    const creatures = namedRows(record, "creatures");
    mergeNamedRow(creatures, {
      name: "Michael's replacement Vit",
      aliases: ["Michael's Vit", "the replacement Vit"],
      summary: "The unnamed Vit bestowed on Michael by the Empress after his first Vit was ordered to leave. Michael describes it as an internal partner capable of matching Alec and Echo's power, but says it has no true voice; the text does not establish that it shares Echo's independent personhood.",
      details: [
        "Distinct from Michael's human consciousness and from the first Vit that imprisoned him after Starfall.",
        "Its exact agency, memories, motives, and classification remain unresolved at the Book Two frontier.",
      ],
      relationships: ["Lives within Michael as an unequal or incompletely understood partner."],
      factionMemberships: [],
      confidence: 0.99,
      evidence: MICHAEL_REPLACEMENT_VIT_EVIDENCE,
      reviewStatus: "verified",
    });
    record.creatures = creatures;
    relationRows.push({
      subject: "Michael",
      relationType: "related_to",
      target: "Michael's replacement Vit",
      status: "active",
      summary: "Michael contains an unnamed replacement Vit bestowed by the Empress; he calls it a partner but says it has no true voice.",
      validFromLabel: "after the Empress restored Michael's agency",
      validUntilLabel: "",
      evidence: MICHAEL_REPLACEMENT_VIT_EVIDENCE,
      confidence: 0.99,
      reviewStatus: "verified",
    });
  }

  if (hadAntonyKondura) {
    relationRows.push(
      {
        subject: "Antony",
        relationType: "related_to",
        target: "Kondura",
        status: "active",
        summary: "Antony is the human host sharing one body with the Vit Kondura; which consciousness controls the body in a given scene remains uncertain.",
        validFromLabel: "before arrival at Sanctuary",
        validUntilLabel: "",
        evidence: [ANTONY_KONDURA_IDENTITY_EVIDENCE, ANTONY_KONDURA_CONTROL_EVIDENCE],
        confidence: 0.99,
        reviewStatus: "verified",
      },
      {
        subject: "Kondura",
        relationType: "related_to",
        target: "Antony",
        status: "active",
        summary: "Kondura identifies Antony as its human host and shares Antony's body and human form.",
        validFromLabel: "before arrival at Sanctuary",
        validUntilLabel: "",
        evidence: [ANTONY_KONDURA_IDENTITY_EVIDENCE, ANTONY_HUMAN_FORM_EVIDENCE],
        confidence: 0.99,
        reviewStatus: "verified",
      },
    );
  }
  if (hadMarleneSuccessor) {
    relationRows.push(
      {
        subject: "Marlene's Changeling successor",
        relationType: "related_to",
        target: "Marlene (original human)",
        status: "active",
        summary: "The unnamed Changeling assumed the original human Marlene's body and social identity after taking her as a host during the invasion.",
        validFromLabel: "first days of the invasion",
        validUntilLabel: "",
        evidence: [MARLENE_HOST_EVIDENCE, MARLENE_DEATH_EVIDENCE],
        confidence: 0.99,
        reviewStatus: "verified",
      },
      {
        subject: "Marlene (original human)",
        relationType: "related_to",
        target: "Marlene's Changeling successor",
        status: "former",
        summary: "The original human Marlene formerly hosted the unnamed Changeling that continues using her body and identity after her death.",
        validFromLabel: "first days of the invasion",
        validUntilLabel: "original Marlene's death",
        evidence: [MARLENE_HOST_EVIDENCE, MARLENE_DEATH_EVIDENCE],
        confidence: 0.99,
        reviewStatus: "verified",
      },
    );
  }

  const vitEmpire = namedRows(record, "factions").find((row) => row.name === "Vit Empire");
  const imperialGovernment = namedRows(record, "governments").find((row) => row.name === "The Empress and Council");
  const hiveMind = namedRows(record, "powerStructures").find((row) => row.name === "Hive Mind");
  const imperialEvidence = uniqueObjectValues([
    ...(Array.isArray(imperialGovernment?.evidence) ? imperialGovernment.evidence : []),
    ...(Array.isArray(vitEmpire?.evidence) ? vitEmpire.evidence : []),
  ]).slice(0, 5);
  if (vitEmpire && imperialGovernment && imperialEvidence.length > 0) {
    relationRows.push({
      subject: "Vit Empire",
      relationType: "controlled_by",
      target: "The Empress and Council",
      status: "active",
      summary: "The Empress and Council govern the Vit Empire; the regime and empire are linked but remain distinct typed cards.",
      validFromLabel: "imperial rule",
      validUntilLabel: "",
      evidence: imperialEvidence,
      confidence: 0.96,
      reviewStatus: "verified",
    });
  }
  if (hiveMind && imperialGovernment) {
    const hiveEvidence = uniqueObjectValues([
      ...(Array.isArray(hiveMind.evidence) ? hiveMind.evidence : []),
      ...(Array.isArray(imperialGovernment.evidence) ? imperialGovernment.evidence : []),
    ]).slice(0, 5);
    if (hiveEvidence.length > 0) {
      relationRows.push({
        subject: "Hive Mind",
        relationType: "controlled_by",
        target: "The Empress and Council",
        status: "active",
        summary: "The Empress controls the imperial psychic order represented by the Hive Mind.",
        validFromLabel: "imperial rule",
        validUntilLabel: "",
        evidence: hiveEvidence,
        confidence: 0.92,
        reviewStatus: "verified",
      });
    }
  }

  // These are real Book Two communities, not status suffixes and not aliases
  // for Book One's North Carolina cabin group. Materialize a card whenever a
  // reviewed character establishes the membership so relation endpoints have
  // a durable canonical entity without inventing cross-book continuity.
  const factions = namedRows(record, "factions");
  for (const [name, summary] of [
    ["The colony", "The survivor colony whose membership, leadership, and exclusion vote shape the Book Two rescue party."],
    ["Sanctuary survivors", "The survivors and resistance members associated with Sanctuary before and after its destruction."],
  ] as const) {
    const members = characters.filter((character) =>
      Array.isArray(character.factionMemberships) &&
      character.factionMemberships.some((membership) =>
        typeof membership === "string" && membership.toLocaleLowerCase() === name.toLocaleLowerCase()
      )
    );
    const relatedEvidence = [
      ...members.flatMap((character) => Array.isArray(character.evidence) ? character.evidence : []),
      ...relationRows
        .filter((relation) =>
          typeof relation.target === "string" &&
          relation.target.toLocaleLowerCase() === name.toLocaleLowerCase()
        )
        .flatMap((relation) => Array.isArray(relation.evidence) ? relation.evidence : []),
    ].slice(0, 5);
    if (relatedEvidence.length > 0) {
      mergeNamedRow(factions, {
        name,
        aliases: [],
        summary,
        details: [],
        relationships: [],
        factionMemberships: [],
        confidence: 0.78,
        evidence: relatedEvidence,
      });
    }
  }
  record.factions = factions;

  for (const relation of relationRows) {
    relation.subject = canonicalEntityName(relation.subject);
    const rawTarget = typeof relation.target === "string" ? relation.target.trim() : "";
    if (relation.relationType === "member_of" && ["alec's town", "present-day settlement"].includes(rawTarget.toLocaleLowerCase())) {
      relation.target = "Alec's town community";
    } else {
      relation.target = canonicalEntityName(rawTarget);
    }
    if (
      relation.relationType === "holds_title" &&
      ["matriarch", "thrall"].includes(String(relation.target).toLocaleLowerCase())
    ) {
      relation.relationType = "classified_as";
    }
  }
  record.entityRelations = relationRows;

  for (const rule of namedRows(record, "entityRules")) rule.entity = canonicalEntityName(rule.entity);
  const claims = namedRows(record, "claims");
  for (const claim of claims) {
    if (
      hadMarleneSuccessor &&
      typeof claim.subject === "string" && claim.subject.toLocaleLowerCase() === "marlene" &&
      typeof claim.predicate === "string" && claim.predicate.toLocaleLowerCase() === "identity continuity"
    ) {
      claim.subject = "Marlene's Changeling successor";
      claim.predicate = "assumed identity";
      claim.value = "Uses the deceased original human Marlene's body and social identity.";
      claim.epistemicHolder = "Marlene's Changeling successor";
    }
    claim.subject = canonicalEntityName(claim.subject);
    claim.epistemicHolder = canonicalEntityName(claim.epistemicHolder);
  }
  if (hadAntonyKondura) {
    claims.push(
      {
        subject: "Antony",
        predicate: "human host of",
        value: "Kondura",
        epistemicHolder: "Kondura",
        truthStatus: "fact",
        validFromLabel: "before arrival at Sanctuary",
        validUntilLabel: "",
        evidence: [ANTONY_KONDURA_IDENTITY_EVIDENCE],
        confidence: 0.99,
        reviewStatus: "verified",
      },
      {
        subject: "Kondura",
        predicate: "current bodily control",
        value: "It is uncertain whether Kondura or Antony controls the shared body in every scene.",
        epistemicHolder: "Lilly",
        truthStatus: "unknown",
        validFromLabel: "arrival at ruined Sanctuary",
        validUntilLabel: "",
        evidence: [ANTONY_KONDURA_CONTROL_EVIDENCE],
        confidence: 0.99,
        reviewStatus: "verified",
      },
    );
  }
  if (hadMarleneSuccessor) {
    claims.push({
      subject: "Marlene (original human)",
      predicate: "life status",
      value: "dead",
      epistemicHolder: "Marlene's Changeling successor",
      truthStatus: "fact",
      validFromLabel: "first days of the invasion",
      validUntilLabel: "",
      evidence: [MARLENE_DEATH_EVIDENCE],
      confidence: 0.99,
      reviewStatus: "verified",
    });
  }
  if (anubsikaTitleEvidence.length > 0) {
    claims.push({
      subject: "Ragger",
      predicate: "ancient personal name",
      value: "Anubsika",
      epistemicHolder: "",
      truthStatus: "fact",
      validFromLabel: "ancient Vit Empire service",
      validUntilLabel: "",
      evidence: anubsikaTitleEvidence,
      confidence: 0.99,
      reviewStatus: "verified",
    });
  }
  record.claims = claims;
  for (const chapter of namedRows(record, "chapterSummaries")) {
    chapter.perspective = canonicalEntityName(chapter.perspective);
  }
  for (const event of namedRows(record, "chronology")) {
    for (const key of ["actors", "targets", "witnesses"]) {
      event[key] = Array.isArray(event[key]) ? event[key].map(canonicalEntityName) : [];
    }
  }
  return record;
}

function preserveCrossBookCharacterNarratives(
  groups: WorldFindings[],
  merged: WorldFindings,
  chunks: AnalysisChunk[],
): void {
  const sourceTitleByChunk = new Map(chunks.map((chunk) => [chunk.id, chunk.sourceTitle]));
  for (const character of merged.characters) {
    const contributions = groups
      .map((group) => group.characters.find((candidate) =>
        candidate.name.toLocaleLowerCase() === character.name.toLocaleLowerCase()
      ))
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    if (contributions.length < 2) continue;
    character.role = contributions.map((contribution) => {
      const label = sourceTitleByChunk.get(contribution.evidence[0]?.chunkId ?? "") ?? "Source";
      return `${label}: ${contribution.role}`;
    }).join(" | ");
    character.summary = contributions.map((contribution) => {
      const label = sourceTitleByChunk.get(contribution.evidence[0]?.chunkId ?? "") ?? "Source";
      return `${label}: ${contribution.summary}`;
    }).join(" ");
  }
}

const ACTIVE_ENTITY_COLLECTIONS = [
  "characters",
  "locations",
  "factions",
  "institutions",
  "governments",
  "powerStructures",
  "creatures",
  "species",
  "technologies",
  "vehicles",
  "devices",
  "weapons",
  "powers",
  "titles",
  "ambiguous",
] as const;

type ActiveLabelCollision = {
  label: string;
  owners: string[];
};

function activeEntityRows(findings: WorldFindings): Array<{
  owner: string;
  name: string;
  aliases: string[];
}> {
  const record = findings as unknown as JsonRecord;
  return ACTIVE_ENTITY_COLLECTIONS.flatMap((category) =>
    namedRows(record, category).map((row) => {
      const name = typeof row.name === "string" ? row.name.trim() : "";
      return {
        owner: `${category}:${name.toLocaleLowerCase()}`,
        name,
        aliases: uniqueValues(Array.isArray(row.aliases) ? row.aliases : []),
      };
    })
  );
}

export function activeLabelCollisions(findings: WorldFindings): ActiveLabelCollision[] {
  const ownersByLabel = new Map<string, Set<string>>();
  for (const row of activeEntityRows(findings)) {
    for (const label of [row.name, ...row.aliases]) {
      const key = label.trim().toLocaleLowerCase();
      if (!key) continue;
      const owners = ownersByLabel.get(key) ?? new Set<string>();
      owners.add(row.owner);
      ownersByLabel.set(key, owners);
    }
  }
  return [...ownersByLabel.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([label, owners]) => ({ label, owners: [...owners].sort() }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function pruneAmbiguousEntityAliases(findings: WorldFindings): void {
  const record = findings as unknown as JsonRecord;
  const rows = ACTIVE_ENTITY_COLLECTIONS.flatMap((category) =>
    namedRows(record, category).map((row) => ({ category, row }))
  );
  const canonicalOwners = new Map<string, Set<string>>();
  const aliasOwners = new Map<string, Set<string>>();
  for (const { category, row } of rows) {
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name) continue;
    const owner = `${category}:${name.toLocaleLowerCase()}`;
    const nameKey = name.toLocaleLowerCase();
    const named = canonicalOwners.get(nameKey) ?? new Set<string>();
    named.add(owner);
    canonicalOwners.set(nameKey, named);
    for (const alias of uniqueValues(Array.isArray(row.aliases) ? row.aliases : [])) {
      const aliasKey = alias.toLocaleLowerCase();
      const aliased = aliasOwners.get(aliasKey) ?? new Set<string>();
      aliased.add(owner);
      aliasOwners.set(aliasKey, aliased);
    }
  }
  for (const { category, row } of rows) {
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name) continue;
    const owner = `${category}:${name.toLocaleLowerCase()}`;
    row.aliases = uniqueValues(Array.isArray(row.aliases) ? row.aliases : [])
      .filter((alias) => {
        const key = alias.toLocaleLowerCase();
        if (key === name.toLocaleLowerCase()) return false;
        const named = canonicalOwners.get(key);
        if (named && (named.size > 1 || !named.has(owner))) return false;
        const aliased = aliasOwners.get(key);
        return !aliased || (aliased.size === 1 && aliased.has(owner));
      });
  }
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function evidenceForExactName(
  chunks: AnalysisChunk[],
  searchName: string,
): JsonRecord[] {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapedPattern(searchName)}(?![\\p{L}\\p{N}_])`, "iu");
  for (const chunk of chunks) {
    const match = pattern.exec(chunk.content);
    if (!match) continue;
    const start = Math.max(0, match.index - 110);
    const end = Math.min(chunk.content.length, match.index + searchName.length + 190);
    const quote = chunk.content.slice(start, end).normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (!quote || quote.length > 500) continue;
    return [{ chunkId: chunk.id, sourceId: chunk.sourceId, quote }];
  }
  return [];
}

const CLEAR_NAMED_PARTICIPANTS: Array<{
  name: string;
  searchName?: string;
  role: string;
  evidence?: JsonRecord[];
}> = [
  { name: "Maria", role: "Father Kelp's wife and a named member of his refuge." },
  { name: "Stali", role: "Named survivor who participates in the Book Two rescue narrative." },
  { name: "Esther", role: "Named member of Alec's early survivor group whose later outcome remains unresolved." },
  { name: "Kenzie", role: "Named person whose outcome remains unresolved in Book One." },
  { name: "Ron", role: "Named participant in the early invasion narrative." },
  { name: "Nate", role: "Named participant in the early invasion narrative." },
  { name: "Ben", role: "Named participant in the early invasion narrative." },
  { name: "Rachel", role: "Named participant in the early invasion narrative." },
  { name: "Jairo", role: "Named participant in the early invasion narrative." },
  {
    name: "Amy (college classmate)",
    searchName: "Amy",
    role: "Alec's college math classmate found dead during the opening invasion.",
    evidence: [{
      chunkId: "ea552635-edfc-40bb-a0a9-7a071ff6559d",
      sourceId: "9c0ba9f3-2058-4d7a-8918-c7637954f054",
      quote: "Amy... She's from my math class… We co-wrote a paper on statistics last year…",
    }],
  },
  { name: "Ethan", role: "Named participant in the early invasion narrative." },
  { name: "Judy", role: "Named participant in the survivor narrative." },
  { name: "Osirita", role: "Named member of Ragger's ancient Earth scouting party." },
  { name: "Horusana", role: "Named member of Ragger's ancient Earth scouting party." },
  { name: "Ka-Set", role: "Named member of Ragger's ancient Earth scouting party." },
  { name: "Raka", role: "Named member of Ragger's ancient Earth scouting party." },
];

function materializeClearReferentialCards(findings: WorldFindings, chunks: AnalysisChunk[]): void {
  const record = findings as unknown as JsonRecord;
  const characters = namedRows(record, "characters");
  const knownCharacterLabels = new Set(characters.flatMap((character) => [
    typeof character.name === "string" ? character.name.toLocaleLowerCase() : "",
    ...uniqueValues(Array.isArray(character.aliases) ? character.aliases : []).map((alias) => alias.toLocaleLowerCase()),
  ]));
  for (const participant of CLEAR_NAMED_PARTICIPANTS) {
    if (knownCharacterLabels.has(participant.name.toLocaleLowerCase())) continue;
    const evidence = participant.evidence ?? evidenceForExactName(chunks, participant.searchName ?? participant.name);
    if (evidence.length === 0) continue;
    characters.push({
      name: participant.name,
      aliases: [],
      role: participant.role,
      summary: `${participant.role} The current source evidence does not support a fuller dossier without additional review.`,
      traits: [], motivations: [], fears: [], capabilities: [], history: [], origins: [], powers: [],
      moralSystem: [], physicalCharacteristics: [], relationships: [], relationshipWeb: [],
      knowledge: [], secrets: [], factionMemberships: [], evidence, confidence: 0.76, reviewStatus: "candidate",
    });
    knownCharacterLabels.add(participant.name.toLocaleLowerCase());
  }
  record.characters = characters;

  const relations = namedRows(record, "entityRelations");
  const securityRelation = relations.find((relation) => relation.target === "Present settlement security");
  if (securityRelation && Array.isArray(securityRelation.evidence)) {
    const institutions = namedRows(record, "institutions");
    mergeNamedRow(institutions, {
      name: "Alec's town security",
      aliases: ["Present settlement security"],
      summary: "The settlement security function led by Tom Bennett.",
      details: [], relationships: [], factionMemberships: [],
      evidence: securityRelation.evidence,
      confidence: Number(securityRelation.confidence) || 0.9,
    });
    record.institutions = institutions;
  }
  const changelingRelation = relations.find((relation) => relation.target === "Changeling");
  if (changelingRelation && Array.isArray(changelingRelation.evidence)) {
    const creatures = namedRows(record, "creatures");
    mergeNamedRow(creatures, {
      name: "Changeling",
      aliases: [],
      summary: "A Vit-and-human-host configuration able to present the host's human appearance while sharing bodily control.",
      details: [], relationships: [], factionMemberships: [],
      evidence: changelingRelation.evidence,
      confidence: Number(changelingRelation.confidence) || 0.9,
    });
    record.creatures = creatures;
  }
}

const CHRONOLOGY_LOCATION_NAMES = new Map<string, string>([
  ["sanctuary ruins", "Sanctuary"],
  ["present-day settlement", "Alec's settlement"],
  ["brightview", "Brightview / Brighton, Florida"],
  ["brighton, florida", "Brightview / Brighton, Florida"],
  ["brightview or brighton, florida", "Brightview / Brighton, Florida"],
  ["alec's settlement gate", "Alec's settlement gate"],
  ["alec's town assembly hall", "Alec's town assembly hall"],
  ["ambush site", "Ambush site"],
  ["florida", "Florida"],
  ["forest near mountain camp", "Forest near mountain camp"],
  ["mountain camp", "Mountain camp"],
  ["old colony command center", "Old colony command center"],
  ["outside alec's town", "Outskirts of Alec's settlement"],
  ["present settlement holding cell", "Present settlement holding cell"],
  ["present-day settlement aquifer intake", "Alec's settlement aquifer intake"],
  ["queen's inner sanctum", "Queen's inner sanctum"],
  ["ragger's warehouse", "Ragger's warehouse"],
  ["recreation center", "Recreation center"],
  ["river camp", "River camp"],
  ["route toward north carolina", "Route toward North Carolina"],
  ["san diego pediatric hospital", "San Diego pediatric hospital"],
  ["supermarket", "Supermarket"],
  ["town freezer-cell", "Town freezer-cell"],
  ["woods near the cabin community", "Woods near the cabin community"],
  ["woods near the old colony", "Woods near the old colony"],
]);

const CHRONOLOGY_LOCATION_PARENTS = new Map<string, {
  target: string;
  relationType: "located_in" | "related_to";
}>([
  ["Alec's settlement gate", { target: "Alec's settlement", relationType: "located_in" }],
  ["Alec's town assembly hall", { target: "Alec's settlement", relationType: "located_in" }],
  ["Outskirts of Alec's settlement", { target: "Alec's settlement", relationType: "related_to" }],
  ["Present settlement holding cell", { target: "Alec's settlement", relationType: "located_in" }],
  ["Alec's settlement aquifer intake", { target: "Alec's settlement", relationType: "located_in" }],
  ["Town freezer-cell", { target: "Alec's settlement", relationType: "located_in" }],
  ["Queen's inner sanctum", { target: "Vit council ship", relationType: "located_in" }],
  ["Forest near mountain camp", { target: "Mountain camp", relationType: "related_to" }],
  ["Woods near the cabin community", { target: "Alec's family cabin", relationType: "related_to" }],
  ["Old colony command center", { target: "The colony", relationType: "related_to" }],
  ["Woods near the old colony", { target: "The colony", relationType: "related_to" }],
]);

function materializeChronologyLocations(findings: WorldFindings): void {
  const record = findings as unknown as JsonRecord;
  renameNamedRow(record, "locations", "Brightview", "Brightview / Brighton, Florida");
  renameNamedRow(record, "locations", "Brighton, Florida", "Brightview / Brighton, Florida");
  const locations = namedRows(record, "locations");
  const brightview = locations.find((row) => row.name === "Brightview / Brighton, Florida");
  if (brightview) {
    brightview.aliases = uniqueValues([
      ...(Array.isArray(brightview.aliases) ? brightview.aliases : []),
      "Brightview",
      "Brighton, Florida",
      "Brightview or Brighton, Florida",
    ]);
  }

  const originalLocationsByCanonical = new Map<string, Set<string>>();
  const eventsByCanonical = new Map<string, WorldFindings["chronology"]>();
  for (const event of findings.chronology) {
    event.locations = uniqueValues((event.locations ?? []).map((rawLocation) => {
      const canonical = CHRONOLOGY_LOCATION_NAMES.get(rawLocation.toLocaleLowerCase()) ?? rawLocation;
      const originals = originalLocationsByCanonical.get(canonical) ?? new Set<string>();
      originals.add(rawLocation);
      originalLocationsByCanonical.set(canonical, originals);
      const events = eventsByCanonical.get(canonical) ?? [];
      if (!events.includes(event)) events.push(event);
      eventsByCanonical.set(canonical, events);
      return canonical;
    }));
  }

  const activeLabels = new Set(activeEntityRows(findings).flatMap((row) =>
    [row.name, ...row.aliases].map((label) => label.toLocaleLowerCase())
  ));
  const relations = namedRows(record, "entityRelations");
  for (const [canonical, events] of eventsByCanonical) {
    if (activeLabels.has(canonical.toLocaleLowerCase())) continue;
    const evidence = uniqueObjectValues(events.flatMap((event) => event.evidence)).slice(0, 5);
    if (evidence.length === 0) continue;
    const aliases = [...(originalLocationsByCanonical.get(canonical) ?? new Set<string>())]
      .filter((alias) => alias.toLocaleLowerCase() !== canonical.toLocaleLowerCase());
    const eventNames = uniqueValues(events.map((event) => event.name));
    const parent = CHRONOLOGY_LOCATION_PARENTS.get(canonical);
    mergeNamedRow(locations, {
      name: canonical,
      aliases,
      summary: `A source-grounded setting for the indexed event${eventNames.length === 1 ? "" : "s"}: ${eventNames.join("; ")}.`,
      details: eventNames,
      relationships: parent ? [`${parent.relationType === "located_in" ? "Located in" : "Associated with"} ${parent.target}.`] : [],
      factionMemberships: [],
      evidence,
      confidence: Math.max(...events.map((event) => event.confidence ?? 0.7), 0.7),
      reviewStatus: "verified",
    });
    activeLabels.add(canonical.toLocaleLowerCase());
    for (const alias of aliases) activeLabels.add(alias.toLocaleLowerCase());
    if (parent) {
      relations.push({
        subject: canonical,
        relationType: parent.relationType,
        target: parent.target,
        status: "active",
        summary: `${canonical} is ${parent.relationType === "located_in" ? "a sublocation of" : "geographically associated with"} ${parent.target}.`,
        validFromLabel: "",
        validUntilLabel: "",
        evidence,
        confidence: Math.max(...events.map((event) => event.confidence ?? 0.7), 0.7),
        reviewStatus: "verified",
      });
    }
  }
  record.locations = locations;
  record.entityRelations = relations;
}

const REFERENCE_CANONICAL_NAMES = new Map<string, string>([
  ["ragger / anubsika", "Ragger"],
  ["anubsika", "Ragger"],
  ["present-day settlement", "Alec's settlement"],
  ["present settlement security", "Alec's town security"],
  ["karagorn mentor", "Karagorn"],
  ["ancient scouting party", "Ancient Earth scouting party"],
  ["rescue coalition", "Kendall's rescue coalition"],
  ["town assembly", "Alec's town assembly"],
  ["community assembly", "Alec's town assembly"],
  ["alec's town", "Alec's town community"],
  ["hill objective", "Hill Air Force Base"],
  ["ordinary vit", "Vit"],
  ["the hive", "Hive Mind"],
  ["lilly at the reunion", "Lilly"],
  ["lilly at the ending", "Lilly"],
  ["ragger, as reported by alec", "Ragger"],
]);

function normalizeCompiledClaims(findings: WorldFindings): void {
  const claims = findings.claims ?? [];
  const normalized: typeof claims = [];
  for (const original of claims) {
    const claim = structuredClone(original);
    const subjectKey = claim.subject.toLocaleLowerCase();
    if (claim.truthStatus === "fact") claim.epistemicHolder = "";
    else claim.epistemicHolder = REFERENCE_CANONICAL_NAMES.get(claim.epistemicHolder.toLocaleLowerCase()) ?? claim.epistemicHolder;
    if (subjectKey === "alec sumner and echo bond") {
      claim.subject = "Alec Sumner";
      claim.predicate = "bond with Echo is";
    } else if (subjectKey === "visharath war") {
      claim.subject = "Visharath";
      claim.predicate = "war status may no longer be";
    } else if (subjectKey === "visharath individuality") {
      claim.subject = "Visharath";
      claim.predicate = "individuality is";
    } else if (subjectKey === "alec sumner's transformation") {
      claim.subject = "Alec Sumner";
      claim.predicate = "transformation may be enabled by";
    } else if (subjectKey === "alec sumner and echo's blood") {
      claim.subject = "Alec Sumner";
      claim.predicate = "shared blood with Echo may combine";
    } else if (subjectKey === "alec sumner and echo's bones") {
      claim.subject = "Alec Sumner";
      claim.predicate = "shared bones with Echo contain";
    } else if (subjectKey === "alec sumner's body") {
      claim.subject = "Alec Sumner";
      claim.predicate = "body was";
    } else if (subjectKey === "present-day settlement") {
      claim.subject = "Alec's town community";
    } else if (subjectKey === "alec sumner's family") {
      claim.subject = "Lilly";
      claim.predicate = "continued search for Alec with Kendall Sumner";
      normalized.push({ ...structuredClone(claim), subject: "Kendall Sumner", predicate: "continued search for Alec with Lilly" });
    } else if (subjectKey === "kendall sumner and lilly") {
      claim.subject = "Kendall Sumner";
      claim.predicate = "mutual romantic feelings with";
      claim.value = "Lilly";
      normalized.push({ ...structuredClone(claim), subject: "Lilly", value: "Kendall Sumner" });
    } else if (subjectKey === "sarah and alec sumner") {
      claim.subject = "Sarah";
      claim.predicate = "sexual encounter with";
      claim.value = "Alec Sumner";
    }
    normalized.push(claim);
  }
  findings.claims = normalized;
}

export function normalizeCompiledRules(findings: WorldFindings): void {
  const record = findings as unknown as JsonRecord;
  renameNamedRow(record, "powers", "Changeling human mimicry", "Changeling mimicry");
  renameNamedRow(record, "powers", "Matriarch royal jelly", "Empress's royal jelly");
  const normalized: WorldFindings["entityRules"] = [];
  let vorhektEvidence: JsonRecord[] = [];
  let vorhektConfidence = 0.9;

  for (const original of findings.entityRules) {
    const rule = structuredClone(original);
    const entityKey = rule.entity.trim().toLocaleLowerCase();
    if (entityKey === "alec sumner and echo" || entityKey === "alec sumner / echo") {
      // These biological rules govern the shared body. Store the same cited
      // rule on both canonical dossiers instead of inventing a compound card
      // that neither retrieval nor the dossier UI can resolve.
      normalized.push({ ...structuredClone(rule), entity: "Alec Sumner" });
      normalized.push({ ...structuredClone(rule), entity: "Echo" });
      continue;
    }
    if (entityKey === "present-day settlement") {
      rule.entity = "Alec's town assembly";
    } else if (entityKey === "earth after invasion") {
      rule.entity = "Earth";
    } else if (entityKey === "vorhekt / vannak" || entityKey === "vorhekt") {
      rule.entity = "Vorhekt";
      vorhektEvidence = uniqueObjectValues([
        ...vorhektEvidence,
        ...(Array.isArray(rule.evidence)
          ? structuredClone(rule.evidence) as unknown as JsonRecord[]
          : []),
      ]);
      vorhektConfidence = Math.max(
        vorhektConfidence,
        Number(rule.confidence) || 0.9,
      );
    }
    normalized.push(rule);
  }

  const unique = new Map<string, WorldFindings["entityRules"][number]>();
  for (const rule of normalized) {
    const key = `${rule.entity.trim().toLocaleLowerCase()}\n${rule.name.trim().toLocaleLowerCase()}`;
    const existing = unique.get(key);
    if (!existing) unique.set(key, rule);
    else existing.evidence = uniqueObjectValues([...existing.evidence, ...rule.evidence]) as typeof existing.evidence;
  }
  findings.entityRules = [...unique.values()];

  if (vorhektEvidence.length > 0) {
    const powers = namedRows(record, "powers");
    mergeNamedRow(powers, {
      name: "Vorhekt",
      aliases: ["The Joining"],
      summary: "A Vit ritual for melding new genetic material into a host, with outcomes that vary by transfer method and participants.",
      details: ["Can involve injection, consumption, or complete Vit-to-host cocooning."],
      relationships: ["A complete Vannak form of the ritual can produce a Vannat."],
      factionMemberships: [],
      evidence: vorhektEvidence,
      confidence: vorhektConfidence,
      reviewStatus: "verified",
    });
    record.powers = powers;
  }

  // Character dossiers can name an ability before the dedicated power card is
  // extracted. Materialize this central setting rule from its direct passage
  // so the Hold does not leave it as a generic "Observed in …" candidate.
  const powers = namedRows(record, "powers");
  const changelingMimicry = powers.find((row) =>
    typeof row.name === "string" && row.name.toLocaleLowerCase() === "changeling mimicry"
  );
  const groundedMimicry: JsonRecord = {
    name: "Changeling mimicry",
    aliases: ["Changeling transformation"],
    summary: "Changelings can alternate between their original human host's appearance and a Turned form while the host and Vit share control of the body.",
    details: ["The ability is associated with genetically compatible human hosts who had hereditary forms of cancer."],
    relationships: ["Observed in Molly/Shanta and Marlene's Changeling successor."],
    factionMemberships: [],
    evidence: [CHANGELING_MIMICRY_EVIDENCE],
    confidence: 0.99,
    reviewStatus: "verified",
  };
  if (changelingMimicry) Object.assign(changelingMimicry, groundedMimicry);
  else powers.push(groundedMimicry);

  const groundedPowerOverrides: JsonRecord[] = [
    {
      name: "Hybrid transformation",
      aliases: [],
      summary: "Alec and Echo can reversibly transition their shared body between a human appearance and a towering combat form; Echo can initiate the change when she has control.",
      details: ["This card describes the reversible shared-body transition; Karagaunt transformation describes the resulting combat morphology."],
      relationships: ["Observed in Alec Sumner and Echo"],
      factionMemberships: [],
      evidence: [
        HYBRID_BOND_EVIDENCE,
        HYBRID_REVERSION_EVIDENCE,
        ECHO_INITIATES_TRANSFORMATION_EVIDENCE,
      ],
      confidence: 0.99,
      reviewStatus: "verified",
    },
    {
      name: "Telepathy",
      aliases: [],
      summary: "Alec, Echo, Matriarchs, Ragger, and the Empress can communicate directly through another being's mind.",
      details: ["The range, authority, and resistance involved vary by speaker and target."],
      relationships: ["Observed in Alec Sumner", "Observed in Echo", "Observed in Geela", "Observed in Ragger", "Observed in the Empress"],
      factionMemberships: [],
      evidence: [
        ECHO_TELEPATHY_EVIDENCE,
        MATRIARCH_TELEPATHY_EVIDENCE,
        ALEC_TELEPATHY_EVIDENCE,
        RAGGER_TELEPATHY_EVIDENCE,
        EMPRESS_TELEPATHY_EVIDENCE,
      ],
      confidence: 0.99,
      reviewStatus: "verified",
    },
    {
      name: "Superhuman strength",
      aliases: [],
      summary: "Alec's transformed musculature grants strength beyond a human body, including the demonstrated ability to shove aside a fallen tree.",
      details: [],
      relationships: ["Observed in Alec Sumner"],
      factionMemberships: [],
      evidence: [ALEC_SUPERHUMAN_STRENGTH_EVIDENCE, ALEC_TREE_STRENGTH_EVIDENCE],
      confidence: 0.99,
      reviewStatus: "verified",
    },
    {
      name: "Accelerated healing",
      aliases: [],
      summary: "Turned can heal severe damage within hours, substantially faster than an ordinary human body.",
      details: ["This card describes the general Turned baseline; Rapid regeneration describes Alec and Echo's more extreme instant repair."],
      relationships: ["Observed in the Turned"],
      factionMemberships: [],
      evidence: [TURNED_ACCELERATED_HEALING_EVIDENCE],
      confidence: 0.99,
      reviewStatus: "verified",
    },
    {
      name: "Neural resuscitation",
      aliases: [],
      summary: "Echo connects neural links to Alec's spine, locates and shelters his fading consciousness, and his stopped heartbeat resumes.",
      details: ["The sequence directly depicts neural connection, preservation of consciousness, and the return of a sustained heartbeat."],
      relationships: ["Observed in Echo", "Applied to Alec Sumner"],
      factionMemberships: [],
      evidence: [
        ECHO_NEURAL_LINK_EVIDENCE,
        ECHO_NEURAL_RESCUE_EVIDENCE,
        ECHO_HEART_RESTART_EVIDENCE,
      ],
      confidence: 0.99,
      reviewStatus: "verified",
    },
    {
      name: "Karagaunt transformation",
      aliases: [],
      summary: "Alec's combat form is a nine-foot, constellation-skinned morphology with a crest, tendrils, altered limbs, blades, and a long bladed tail.",
      details: ["This card describes the combat form's anatomy; Hybrid transformation describes the reversible transition into and out of it."],
      relationships: ["Observed in Alec Sumner"],
      factionMemberships: [],
      evidence: [KARAGAUNT_FORM_EVIDENCE, HYBRID_BOND_EVIDENCE],
      confidence: 0.99,
      reviewStatus: "verified",
    },
    {
      name: "Rapid regeneration",
      aliases: [],
      summary: "Alec's transformed body seals ruptured tissue during transformation and closes numerous gunshot wounds almost instantly; Alec later describes himself, with uncertainty, as functionally immortal.",
      details: ["The manuscript directly demonstrates rapid tissue repair; literal immortality remains Alec's own assessment."],
      relationships: ["Observed in Alec Sumner and Echo"],
      factionMemberships: [],
      evidence: [
        ALEC_TRANSFORMATION_REGEN_EVIDENCE,
        ALEC_ACCELERATED_HEALING_EVIDENCE,
        ALEC_IMMORTALITY_BELIEF_EVIDENCE,
      ],
      confidence: 0.98,
      reviewStatus: "verified",
    },
    {
      name: "Partial shapeshifting",
      aliases: [],
      summary: "Alec can transform and then reabsorb a single limb or feature without completing a full-body transformation.",
      details: ["Ragger's complete shift into a stored former-host pattern is indexed separately."],
      relationships: ["Observed in Alec Sumner"],
      factionMemberships: [],
      evidence: [ALEC_PARTIAL_TRANSFORMATION_EVIDENCE, ALEC_PARTIAL_REVERSION_EVIDENCE],
      confidence: 0.99,
      reviewStatus: "verified",
    },
    {
      name: "Stored-host transformation",
      aliases: ["Former-host pattern transformation"],
      summary: "Ragger can retain genetic patterns from former hosts and complete a full-body shift into one of those stored forms.",
      details: ["The demonstrated shift turns his dog body into an enlarged Prowler-like form."],
      relationships: ["Observed in Ragger"],
      factionMemberships: [],
      evidence: [RAGGER_STORED_HOST_TRANSFORMATION_EVIDENCE],
      confidence: 0.99,
      reviewStatus: "verified",
    },
    {
      name: "Echo neurochemical control",
      aliases: [],
      summary: "Echo can stimulate Alec's dopamine centers, demonstrating targeted influence over his nervous system.",
      details: [],
      relationships: ["Observed in Echo", "Applied to Alec Sumner"],
      factionMemberships: [],
      evidence: [ECHO_NEUROCHEMICAL_EVIDENCE],
      confidence: 0.99,
      reviewStatus: "verified",
    },
    {
      name: "Mind Web",
      aliases: [],
      summary: "Shanta creates a Mind Web that can monitor nearby Visharath brain activity.",
      details: ["The text attributes the ability to Shanta; Molly is Shanta's human host."],
      relationships: ["Observed in Shanta"],
      factionMemberships: [],
      evidence: [SHANTA_MIND_WEB_EVIDENCE, SHANTA_MIND_WEB_MONITORING_EVIDENCE],
      confidence: 0.99,
      reviewStatus: "verified",
    },
    {
      name: "Psychic memory transfer",
      aliases: [],
      summary: "An ancient Karagaunt breaks Anubsika's mental defenses and forces alien memories and suppressed revelations into his consciousness.",
      details: ["The wielding Karagaunt is unnamed; Ragger, then called Anubsika, receives the memories."],
      relationships: ["Applied to Ragger as Anubsika"],
      factionMemberships: [],
      evidence: [PSYCHIC_MEMORY_TRANSFER_EVIDENCE],
      confidence: 0.99,
      reviewStatus: "verified",
    },
    {
      name: "Changeling mimicry",
      aliases: ["Changeling transformation"],
      summary: "Changelings can alternate between their human host's appearance and a Turned form, while host and Vit may take turns controlling the shared body.",
      details: ["The ability is directly demonstrated by Marlene's Changeling successor and Kondura in Antony's body."],
      relationships: ["Observed in Shanta and Molly", "Observed in Marlene's Changeling successor", "Observed in Kondura"],
      factionMemberships: [],
      evidence: [
        CHANGELING_MIMICRY_EVIDENCE,
        CHANGELING_SHARED_CONTROL_EVIDENCE,
        MARLENE_REAVER_TRANSFORMATION_EVIDENCE,
        KONDURA_MIMICRY_EVIDENCE,
      ],
      confidence: 0.99,
      reviewStatus: "verified",
    },
    {
      name: "Empress's royal jelly",
      aliases: ["Royal jelly"],
      summary: "The ancient Empress's royal jelly can staunch catastrophic wounds, although it does not reverse every form of damage.",
      details: ["The observed treatment fails to repair the ancient Destroyer's venom injury; the text does not establish this as a general Matriarch ability."],
      relationships: ["Observed in the ancient Empress"],
      factionMemberships: [],
      evidence: [MATRIARCH_ROYAL_JELLY_EVIDENCE],
      confidence: 0.99,
      reviewStatus: "verified",
    },
    {
      name: "Vorhekt",
      aliases: ["The Joining"],
      summary: "The Vorhekt is a ritual in which a Vit combines new genetic material with a host to create a new organism, with unpredictable results.",
      details: ["Methods described include injection, consumption, and complete Vit-to-host cocooning."],
      relationships: [],
      factionMemberships: [],
      evidence: [VORHEKT_DEFINITION_EVIDENCE, VORHEKT_VARIABILITY_EVIDENCE],
      confidence: 0.98,
      reviewStatus: "verified",
    },
  ];
  for (const override of groundedPowerOverrides) {
    const name = typeof override.name === "string" ? override.name.toLocaleLowerCase() : "";
    const existing = powers.find((row) =>
      typeof row.name === "string" && row.name.toLocaleLowerCase() === name
    );
    if (existing) Object.assign(existing, override);
    else powers.push(override);
  }
  record.powers = powers;
}

export function normalizeCompiledRelationshipWeb(findings: WorldFindings): void {
  for (const character of findings.characters) {
    character.relationshipWeb = character.relationshipWeb.map((relationship) => ({
      ...relationship,
      name: RELATIONSHIP_WEB_CANONICAL_NAMES.get(
        relationship.name.trim().toLocaleLowerCase(),
      ) ?? relationship.name,
    }));
  }
}

export function reconcileCompiledDossierPowers(findings: WorldFindings): void {
  const ownersByLabel = new Map<string, Set<string>>();
  for (const power of findings.powers) {
    for (const label of [power.name, ...(power.aliases ?? [])]) {
      const key = label.trim().toLocaleLowerCase();
      if (!key) continue;
      const owners = ownersByLabel.get(key) ?? new Set<string>();
      owners.add(power.name);
      ownersByLabel.set(key, owners);
    }
  }

  const resolve = (label: string): string => {
    const owners = ownersByLabel.get(label.trim().toLocaleLowerCase());
    return owners?.size === 1 ? [...owners][0]! : "";
  };

  for (const character of findings.characters) {
    const reconciled: string[] = [];
    for (const rawPower of character.powers) {
      const direct = resolve(rawPower);
      if (direct) {
        reconciled.push(direct);
        continue;
      }
      const key = `${character.name.trim().toLocaleLowerCase()}\0${rawPower.trim().toLocaleLowerCase()}`;
      const replacements = DOSSIER_POWER_RECONCILIATION.get(key) ?? [];
      for (const replacement of replacements) {
        const canonical = resolve(replacement);
        if (canonical) reconciled.push(canonical);
      }
    }
    character.powers = uniqueValues(reconciled).filter((power) =>
      !DOSSIER_POWER_REMOVALS.has(
        `${character.name.trim().toLocaleLowerCase()}\0${power.toLocaleLowerCase()}`,
      )
    );
  }

  const unresolved = findings.characters.flatMap((character) =>
    character.powers
      .filter((power) => !resolve(power))
      .map((power) => `${character.name}: ${power}`)
  );
  if (unresolved.length > 0) {
    throw new Error(
      `The compiled review retained dossier powers without one canonical card: ${unresolved.join(", ")}`,
    );
  }
}

export function materializeCreatureFormsAndStats(findings: WorldFindings): void {
  const michael = findings.characters.find((character) => character.name === "Michael");
  const thrall = findings.creatures.find((creature) => creature.name === "Thrall");
  if (!michael || !thrall) return;

  // The manuscript names Michael as the current Thrall and then demonstrates
  // the form's physical force. Keep the manifested creature card distinct,
  // but let its dossier carry the same grounded D20 estimate as the person
  // while he is in that body.
  thrall.estimatedStats = Object.fromEntries(
    Object.entries(michael.estimatedStats).map(([name, stat]) => [name, { ...stat }]),
  ) as typeof michael.estimatedStats;
  thrall.evidence = [...new Map([
    ...thrall.evidence,
    MICHAEL_THRALL_IDENTITY_EVIDENCE,
    MICHAEL_THRALL_STRENGTH_EVIDENCE,
  ].map((reference) => [`${reference.chunkId}:${reference.quote}`, reference])).values()];

  if (!findings.entityRelations.some((relation) =>
    relation.subject === "Michael" && relation.relationType === "has_form" && relation.target === "Thrall"
  )) {
    findings.entityRelations.push({
      subject: "Michael",
      relationType: "has_form",
      target: "Thrall",
      status: "active",
      summary: "Michael is the Empress's current Thrall; this is his manifested Vannat body, not merely an associated creature.",
      validFromLabel: "after his Starfall capture and transformation",
      validUntilLabel: "",
      evidence: [MICHAEL_THRALL_IDENTITY_EVIDENCE, MICHAEL_THRALL_STRENGTH_EVIDENCE],
      confidence: 0.99,
      reviewStatus: "verified",
    });
  }
}

function normalizeCompiledReferences(findings: WorldFindings): void {
  const record = findings as unknown as JsonRecord;
  const visharath = namedRows(record, "species").find((row) =>
    typeof row.name === "string" && row.name.toLocaleLowerCase() === "visharath"
  );
  if (visharath) {
    // "Turned" is the host/caste faction in this canon, not an interchangeable
    // species name. Keeping the article-prefixed phrase as a Visharath alias
    // would silently route faction references to the species card.
    visharath.aliases = uniqueValues(
      Array.isArray(visharath.aliases) ? visharath.aliases : [],
    ).filter((alias) => alias.toLocaleLowerCase() !== "the turned");
  }
  const relations = namedRows(record, "entityRelations");
  for (const relation of relations) {
    const target = typeof relation.target === "string" ? relation.target : "";
    if (relation.relationType === "leads" && target.toLocaleLowerCase() === "present-day settlement") {
      relation.target = "Alec's town community";
    } else {
      relation.target = REFERENCE_CANONICAL_NAMES.get(target.toLocaleLowerCase()) ?? target;
    }
    const subject = typeof relation.subject === "string" ? relation.subject : "";
    relation.subject = REFERENCE_CANONICAL_NAMES.get(subject.toLocaleLowerCase()) ?? subject;
  }
  record.entityRelations = relations;

  const activeRows = activeEntityRows(findings);
  const canonicalNames = new Map(activeRows.map((row) => [row.name.toLocaleLowerCase(), row.name]));
  const aliasOwners = new Map<string, Set<string>>();
  for (const row of activeRows) {
    for (const alias of row.aliases) {
      const owners = aliasOwners.get(alias.toLocaleLowerCase()) ?? new Set<string>();
      owners.add(row.name);
      aliasOwners.set(alias.toLocaleLowerCase(), owners);
    }
  }
  const resolve = (label: string): string => {
    const direct = REFERENCE_CANONICAL_NAMES.get(label.toLocaleLowerCase()) ?? label;
    const canonical = canonicalNames.get(direct.toLocaleLowerCase());
    if (canonical) return canonical;
    const aliases = aliasOwners.get(direct.toLocaleLowerCase());
    return aliases?.size === 1 ? [...aliases][0]! : "";
  };
  for (const event of findings.chronology) {
    event.actors = uniqueValues((event.actors ?? []).map(resolve).filter(Boolean));
    event.targets = uniqueValues((event.targets ?? []).map(resolve).filter(Boolean));
    event.witnesses = uniqueValues((event.witnesses ?? []).map(resolve).filter(Boolean));
  }
}

const ANCIENT_CHRONOLOGY_ORDER = [
  "Anubsika kills the earlier Destroyer and learns the suppressed origin",
  "Ragger's scouting party arrives on ancient Earth and fractures",
] as const;

const BOOK_TWO_CHAPTER_FIVE_KEY = `${BOOK_TWO_SOURCE_ID}:chapter-5`;
const BOOK_TWO_REUNION_EVENT = "Alec meets Ragger while the searchers reach his settlement";

const OLD_DOG_LABEL = "Old Dog narrator";
const OLD_DOG_EVENT = "The Old Dog prepares humanity";

/**
 * Resolve a deliberately concealed Book One identity once Book Two supplies
 * the matching ancient name, Earth mission, duration, myth-making role, and
 * confession. Per-source review correctly kept the prologue narrator
 * unresolved; a complete-edition review must revisit that uncertainty rather
 * than carrying an obsolete placeholder into the final Hold.
 */
export function resolveCompiledIdentityReveals(findings: WorldFindings): void {
  const ragger = findings.characters.find((character) =>
    character.name.toLocaleLowerCase() === "ragger"
  );
  const oldDog = findings.ambiguous.find((item) =>
    item.name.toLocaleLowerCase() === OLD_DOG_LABEL.toLocaleLowerCase()
  );
  if (!ragger || !oldDog) return;
  const oldDogEvent = findings.chronology.find((event) => event.name === OLD_DOG_EVENT);

  const aliases = new Set(ragger.aliases.map((alias) => alias.toLocaleLowerCase()));
  const laterRevealIsGrounded = aliases.has("anubsika") && aliases.has("anubis") &&
    /millennia|six thousand/iu.test(ragger.summary) &&
    /warn(?:ed|ing)? humanity|humanity through myth/iu.test(ragger.summary) &&
    ragger.evidence.some((item) => /I am Anubsika/iu.test(item.quote));
  const earlierIdentityMatches = /dog-bodied|doglike|stray/iu.test(oldDog.summary) &&
    /humanity/iu.test(oldDog.summary) &&
    Boolean(oldDogEvent) && /six thousand/iu.test(oldDogEvent?.summary ?? "") &&
    /myth|scripture|dream|war/iu.test(oldDogEvent?.summary ?? "");
  if (!laterRevealIsGrounded || !earlierIdentityMatches) return;

  ragger.aliases = uniqueValues([
    ...ragger.aliases,
    OLD_DOG_LABEL,
    "Old Dog",
    "ancient Jackal",
  ]);
  ragger.evidence = uniqueObjectValues([
    ...ragger.evidence,
    ...oldDog.evidence,
  ]) as typeof ragger.evidence;
  ragger.history = uniqueValues([
    ...ragger.history,
    "Spent nearly six thousand years watching Earth and preparing humanity through myth, scripture, dreams, and lessons encoded in war.",
  ]);
  findings.ambiguous = findings.ambiguous.filter((item) => item !== oldDog);

  const prologue = findings.chapterSummaries.find((chapter) =>
    chapter.chapterKey.endsWith(":prologue") && /Old Dog/iu.test(chapter.chapterTitle)
  );
  if (prologue) {
    prologue.perspective = "Ragger / Anubsika (identity revealed in Book Two)";
    prologue.summary = "Ragger—still unnamed in the Book One prologue, but later identified as Anubsika and remembered as Anubis—senses the return of the Empress and her collective after nearly six thousand years of hiding on Earth. He resists her command, severs the psychic link at terrible cost, and reflects on killing the scouting companions who betrayed their mission. Rather than reveal himself, he has seeded humanity's myths, scripture, dreams, and concepts of war with warnings and lessons intended to prepare them. As the invasion approaches, he apologizes to humanity and admits that only some will survive.";
    prologue.majorEvents = prologue.majorEvents.map((event) =>
      event.replace(/^The narrator\b/iu, "Ragger").replace(/^He\b/iu, "Ragger")
    );
  }

  if (oldDogEvent) {
    const revealEvidence = ragger.evidence.filter((item) =>
      /I am Anubsika|arrived on your world approximately six thousand years ago/iu.test(item.quote)
    );
    oldDogEvent.summary = "Ragger—then known as Anubsika and later remembered by humanity as Anubis—spends nearly six thousand years watching Earth and indirectly preparing humanity through myth, scripture, dreams, and patterns of war rather than revealing himself.";
    oldDogEvent.actors = ["Ragger"];
    oldDogEvent.evidence = uniqueObjectValues([
      ...oldDogEvent.evidence,
      ...revealEvidence,
    ]) as typeof oldDogEvent.evidence;
  }

  for (const claim of findings.claims ?? []) {
    if (claim.subject.toLocaleLowerCase() === OLD_DOG_LABEL.toLocaleLowerCase()) {
      claim.subject = "Ragger";
    }
    if (claim.epistemicHolder.toLocaleLowerCase() === OLD_DOG_LABEL.toLocaleLowerCase()) {
      claim.epistemicHolder = "Ragger";
    }
  }
  for (const relation of findings.entityRelations) {
    if (relation.subject.toLocaleLowerCase() === OLD_DOG_LABEL.toLocaleLowerCase()) relation.subject = "Ragger";
    if (relation.target.toLocaleLowerCase() === OLD_DOG_LABEL.toLocaleLowerCase()) relation.target = "Ragger";
  }
  for (const rule of findings.entityRules) {
    if (rule.entity.toLocaleLowerCase() === OLD_DOG_LABEL.toLocaleLowerCase()) rule.entity = "Ragger";
  }
  findings.openQuestions = findings.openQuestions.filter((question) =>
    !/unnamed Old Dog narrator|who is the .*Old Dog narrator/iu.test(question)
  );
  findings.cohesionProposals = findings.cohesionProposals.filter((proposal) =>
    !(proposal.kind === "identity" &&
      proposal.subject.toLocaleLowerCase() === OLD_DOG_LABEL.toLocaleLowerCase())
  );
}

/**
 * Reconcile cross-book time before the curated review is replayed. Each book
 * is reviewed independently, so concatenating otherwise-correct findings can
 * put an ancient flashback after the first book's present day. This step also
 * attaches a connective chapter to the existing event it develops instead of
 * inventing a chapter-shaped clock entry.
 */
export function normalizeCompiledChronology(
  findings: Pick<WorldFindings, "chapterSummaries" | "chronology">,
): void {
  const chapterFive = findings.chapterSummaries.find(
    (chapter) => chapter.chapterKey === BOOK_TWO_CHAPTER_FIVE_KEY,
  );
  const reunion = findings.chronology.find((event) => event.name === BOOK_TWO_REUNION_EVENT);
  if (chapterFive && reunion) {
    reunion.sourceChapterKeys = uniqueValues([
      ...(reunion.sourceChapterKeys ?? []),
      BOOK_TWO_CHAPTER_FIVE_KEY,
    ]);
    reunion.evidence = uniqueObjectValues([
      ...reunion.evidence,
      ...chapterFive.evidence,
    ]) as typeof reunion.evidence;
    reunion.summary = "Alec flees the attention in town and confronts a speaking coyote at the river, where Ragger reveals enough power and history to begin a negotiated meeting. During the same interval, Kendall's search party reaches Alec's settlement; local testimony and the accumulated evidence further confirm that the Stalker-like protector is Alec, while Molly and Ragger explain Changelings, the breadth of the Turncoats, and their doubts about the official Abbrakor story. The two approaches run in parallel rather than a proven minute-by-minute order.";
  }

  const ancient = ANCIENT_CHRONOLOGY_ORDER.flatMap((name) => {
    const event = findings.chronology.find((candidate) => candidate.name === name);
    return event ? [event] : [];
  });
  const ancientNames = new Set(ANCIENT_CHRONOLOGY_ORDER);
  findings.chronology = [
    ...ancient,
    ...findings.chronology.filter((event) => !ancientNames.has(
      event.name as typeof ANCIENT_CHRONOLOGY_ORDER[number],
    )),
  ];
}

export function mergeCodexReviewFindings(
  groups: unknown[],
  chunks: AnalysisChunk[],
): WorldFindings {
  if (groups.length === 0) throw new Error("At least one findings file is required.");
  // Normalize each independently reviewed source before merging it. This
  // scopes local chapter labels (for example, two different `chapter-1`
  // values) before they can collide across books.
  const parsedGroups = groups.map((group) =>
    parseWorldFindingsFromModel(normalizeCodexGroup(group), chunks)
  );
  const merged = parsedGroups.slice(1).reduce(
    (current, next) => mergeWorldFindings(current, next, {
      preferIncomingSummary: false,
    }),
    parsedGroups[0]!,
  );
  // A complete-edition review must describe every supplied volume. Keeping
  // only the first group's summary made a correctly indexed sequel look as if
  // Storyhold had never read it. Preserve each independently grounded source
  // summary in reading order while the structured merge handles deduplication.
  merged.summary = uniqueValues(
    parsedGroups.map((group) => group.summary.trim()).filter(Boolean),
  ).join("\n\n");
  preserveCrossBookCharacterNarratives(parsedGroups, merged, chunks);
  resolveCompiledIdentityReveals(merged);
  materializeClearReferentialCards(merged, chunks);
  materializeChronologyLocations(merged);
  normalizeCompiledClaims(merged);
  normalizeCompiledRules(merged);
  reconcileCompiledDossierPowers(merged);
  materializeCreatureFormsAndStats(merged);
  normalizeCompiledRelationshipWeb(merged);
  normalizeCompiledReferences(merged);
  normalizeCompiledChronology(merged);
  pruneAmbiguousEntityAliases(merged);
  // This is the exact production parser used for connected model responses.
  // It discards unsupported rows and validates every quote against a current
  // passage before the replay server is allowed to expose the artifact.
  const parsed = parseWorldFindingsFromModel(merged as unknown, chunks);
  pruneAmbiguousEntityAliases(parsed);
  const collisions = activeLabelCollisions(parsed);
  if (collisions.length > 0) {
    throw new Error(`The compiled review has ambiguous active labels: ${JSON.stringify(collisions)}`);
  }
  if (countEvidence(parsed) === 0) {
    throw new Error("The compiled review contains no current exact-quote evidence.");
  }
  return validateCuratedWorldFindings(parsed);
}

async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length < 3) {
    throw new Error(
      "Usage: compileCodexReviewFindings <before-packet.json> <output.json> <findings-1.json> [findings-2.json ...]",
    );
  }
  const [packetPath, outputPath, ...findingPaths] = args;
  const chunks = packetChunks(await jsonFile(packetPath!));
  const groups = await Promise.all(
    findingPaths.map((filePath) => jsonFile(filePath)),
  );
  const merged = mergeCodexReviewFindings(groups, chunks);
  const resolvedOutput = path.resolve(outputPath!);
  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    output: resolvedOutput,
    passages: chunks.length,
    chapters: merged.chapterSummaries.length,
    chronologyEvents: merged.chronology.length,
    characters: merged.characters.length,
    entities:
      merged.locations.length + merged.factions.length +
      merged.institutions.length + merged.governments.length +
      merged.powerStructures.length + merged.creatures.length +
      merged.species.length + merged.technologies.length +
      merged.vehicles.length + merged.devices.length +
      merged.weapons.length + merged.powers.length + merged.titles.length +
      merged.ambiguous.length,
    relations: merged.entityRelations.length,
    rules: merged.entityRules.length,
    claims: merged.claims?.length ?? 0,
    evidenceReferences: countEvidence(merged),
  }, null, 2));
}

if (
  process.env.NODE_ENV !== "test" &&
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
