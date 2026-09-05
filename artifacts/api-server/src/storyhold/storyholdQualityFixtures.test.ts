import assert from "node:assert/strict";
import test from "node:test";
import {
  enrichLocalCharacterFindings,
  guardLocalQwenDossierProjection,
  localDossierKnowledgeClaimIsUseful,
  localEvidenceBehavesLikeCharacter,
  localQwenClaimIsDurable,
  localQwenFactBelongsToCharacter,
  parseWorldFindingsFromModel,
} from "./worldAnalysis";
import {
  ALIEN_DIFFICULT_CHUNKS,
  ASHES_DIFFICULT_CHUNKS,
  DIFFICULT_RELATIONS,
  STORYHOLD_DIFFICULT_EXPECTATIONS,
} from "./storyholdQualityFixtures";

test("repeated sapient behavior promotes a misclassified entity without mistaking a contents page for characterization", () => {
  assert.equal(localEvidenceBehavesLikeCharacter("Echo", [{
    chunkId: "echo-speaks",
    sourceId: "ashes",
    quote: '"But we are born in batches of thousands," Echo said cautiously.',
  }, {
    chunkId: "echo-reacts",
    sourceId: "ashes",
    quote: "Echo's physical body wriggled with excitement when Alec gave her a name.",
  }]), true);

  assert.equal(localEvidenceBehavesLikeCharacter("Prometheus", [{
    chunkId: "contents",
    sourceId: "ashes",
    quote: "Chapter 1 Prometheus Chapter 2 Sanctuary Chapter 3 Prometheus",
  }, {
    chunkId: "technology",
    sourceId: "ashes",
    quote: "The Prometheus system restarted after the generator came online.",
  }]), false);
});

test("first-person POV evidence preserves explicit best-friend and family labels", () => {
  const chunks = [{
    id: "explicit-pov-relationships",
    sourceId: "ashes",
    sourceTitle: "ASHES",
    index: 1,
    sectionTitle: "Chapter 1 (Alec - Present)",
    content: "I had been traveling with my best friend, Michael, before the Trucker drove away and we were separated. I introduced my brother, Kendall, to the survivors. The monstrous form was proof of the symbiotic bond I shared with Echo. ‘This is Lilly. My... wife,’ I explained.",
  }];
  const findings = parseWorldFindingsFromModel({
    characters: ["Alec", "Michael", "Kendall", "Echo", "Trucker", "Lilly"].map((name) => ({
      name,
      mentionCount: 20,
      evidence: [{ chunkId: chunks[0]!.id, quote: chunks[0]!.content }],
    })),
  }, chunks);
  findings.characters.forEach((character) => { character.mentionCount = 20; });
  const enriched = enrichLocalCharacterFindings(findings, [], chunks);
  const alec = enriched.characters.find((character) => character.name === "Alec")!;
  const michael = enriched.characters.find((character) => character.name === "Michael")!;
  const kendall = enriched.characters.find((character) => character.name === "Kendall")!;
  const echo = enriched.characters.find((character) => character.name === "Echo")!;
  const trucker = enriched.characters.find((character) => character.name === "Trucker")!;
  const lilly = enriched.characters.find((character) => character.name === "Lilly")!;
  assert.equal(alec.relationshipWeb.find((connection) => connection.name === "Michael")?.relationship, "Best Friend");
  assert.equal(alec.relationshipWeb.find((connection) => connection.name === "Kendall")?.relationship, "Family");
  assert.equal(michael.relationshipWeb.find((connection) => connection.name === "Alec")?.relationship, "Best Friend");
  assert.equal(kendall.relationshipWeb.find((connection) => connection.name === "Alec")?.relationship, "Family");
  assert.equal(alec.relationshipWeb.find((connection) => connection.name === "Echo")?.relationship, "Symbiotic Bond");
  assert.equal(echo.relationshipWeb.find((connection) => connection.name === "Alec")?.relationship, "Symbiotic Bond");
  assert.notEqual(alec.relationshipWeb.find((connection) => connection.name === "Trucker")?.relationship, "Best Friend");
  assert.notEqual(michael.relationshipWeb.find((connection) => connection.name === "Trucker")?.relationship, "Best Friend");
  assert.notEqual(trucker.relationshipWeb.find((connection) => connection.name === "Michael")?.relationship, "Best Friend");
  assert.equal(alec.relationshipWeb.find((connection) => connection.name === "Lilly")?.relationship, "Partner");
  assert.equal(lilly.relationshipWeb.find((connection) => connection.name === "Alec")?.relationship, "Partner");
});

test("a targeted dossier migration retains the rest of the cast as relationship context", () => {
  const chunk = {
    id: "targeted-alec-relationships",
    sourceId: "ashes",
    sourceTitle: "ASHES",
    index: 1,
    sectionTitle: "Chapter 13 (Alec - Present)",
    content: "I had been traveling with my best friend, Michael, before we were separated. My sister Alicia fought like hell beside us. ‘This is Lilly. My... wife,’ I explained. The symbiotic bond I shared with Echo warned me of danger.",
  };
  const target = parseWorldFindingsFromModel({
    characters: [{
      name: "Alec Sumner",
      aliases: ["Alec"],
      mentionCount: 162,
      evidence: [{ chunkId: chunk.id, quote: chunk.content }],
    }],
  }, [chunk]);
  target.characters[0]!.mentionCount = 162;
  const context = parseWorldFindingsFromModel({
    characters: ["Michael", "Lilly Potter", "Echo", "Alicia"].map((name) => ({
      name,
      aliases: name === "Lilly Potter" ? ["Lilly"] : [],
      mentionCount: 50,
      evidence: [{ chunkId: chunk.id, quote: chunk.content }],
    })),
  }, [chunk]).characters;
  context.forEach((character) => { character.mentionCount = 50; });
  const alec = enrichLocalCharacterFindings(target, [], [chunk], [], context).characters[0]!;
  assert.equal(alec.relationshipWeb.find((connection) => connection.name === "Michael")?.relationship, "Best Friend");
  assert.equal(alec.relationshipWeb.find((connection) => connection.name === "Lilly Potter")?.relationship, "Partner");
  assert.equal(alec.relationshipWeb.find((connection) => connection.name === "Echo")?.relationship, "Symbiotic Bond");
  assert.equal(alec.relationshipWeb.find((connection) => connection.name === "Alicia")?.relationship, "Family");
});

test("another character's spouse is not assigned to the point-of-view character", () => {
  const chunk = {
    id: "alec-other-spouses",
    sourceId: "ashes",
    sourceTitle: "ASHES",
    index: 2,
    sectionTitle: "Chapter 15 (Alec - Past)",
    content: "The man swallowed. ‘I'm Nate.’ He gestured beside him. ‘This is my wife, Rachel.’ Later, I expected Allie but found Maria, Father Kelp's wife.",
  };
  const target = parseWorldFindingsFromModel({
    characters: [{ name: "Alec Sumner", aliases: ["Alec"], mentionCount: 100, evidence: [{ chunkId: chunk.id, quote: chunk.content }] }],
  }, [chunk]);
  target.characters[0]!.mentionCount = 100;
  const context = parseWorldFindingsFromModel({
    characters: ["Nate", "Rachel", "Allie", "Maria", "Father Kelp"].map((name) => ({
      name,
      mentionCount: 20,
      evidence: [{ chunkId: chunk.id, quote: chunk.content }],
    })),
  }, [chunk]).characters;
  context.forEach((character) => { character.mentionCount = 20; });
  const alec = enrichLocalCharacterFindings(target, [], [chunk], [], context).characters[0]!;
  for (const name of ["Nate", "Rachel", "Allie", "Maria", "Father Kelp"]) {
    assert.notEqual(
      alec.relationshipWeb.find((connection) => connection.name === name)?.relationship,
      "Partner",
      `${name} must not inherit another character's spouse label`,
    );
  }
});

test("directly worded history and naming facts survive without relying on Qwen's proposal mix", () => {
  const chunks = [{
    id: "durable-local-biography",
    sourceId: "ashes",
    sourceTitle: "ASHES",
    index: 2,
    sectionTitle: "Chapter 3 (Alec - Present)",
    content: "Michael had to drop out of school and work to keep the lights on, relying on me for support. Michael, now alone, declared himself an emancipated adult and asked to move in with my family. The voice faltered. ‘Echo,’ I said firmly. ‘Their name is Echo.’ Echo's physical body wriggled with excitement as they received a name.",
  }];
  const findings = parseWorldFindingsFromModel({
    characters: ["Alec", "Michael", "Echo"].map((name) => ({
      name,
      mentionCount: 20,
      evidence: [{ chunkId: chunks[0]!.id, quote: chunks[0]!.content }],
    })),
  }, chunks);
  findings.characters.forEach((character) => { character.mentionCount = 20; });
  const enriched = enrichLocalCharacterFindings(findings, [], chunks);
  const michael = enriched.characters.find((character) => character.name === "Michael")!;
  const echo = enriched.characters.find((character) => character.name === "Echo")!;
  assert.match(michael.summary, /drop(?:ped)? out of school/iu);
  assert.match(michael.summary, /emancipated adult/iu);
  assert.ok(michael.history.some((entry) => /Alec's family/iu.test(entry)));
  assert.match(echo.summary, /receives their name from Alec/iu);
  assert.ok(echo.origins.some((entry) => /visible excitement/iu.test(entry)));
});

test("an object near family language is not turned into a relative", () => {
  const chunks = [0, 1].map((index) => ({
    id: `glass-is-an-object-${index}`,
    sourceId: "ashes",
    sourceTitle: "ASHES",
    index,
    sectionTitle: `Chapter ${index + 1} (Alec - Present)`,
    content: index === 0
      ? "Alec returned to the cabin. My mother handed me the cold glass and patted my shoulder. I emptied the glass before leaving."
      : "Alec ducked when the window broke. I heard the glass shatter behind me and ran toward my family.",
  }));
  const findings = parseWorldFindingsFromModel({
    characters: [{ name: "Alec", mentionCount: 20, evidence: chunks.map((chunk) => ({ chunkId: chunk.id, quote: chunk.content })) }],
    devices: [{ name: "Glass", mentionCount: 5, confidence: 0.8, evidence: chunks.map((chunk) => ({ chunkId: chunk.id, quote: chunk.content })) }],
  }, chunks);
  findings.characters[0]!.mentionCount = 20;
  findings.devices[0]!.mentionCount = 5;
  const alec = enrichLocalCharacterFindings(findings, [], chunks).characters[0]!;
  assert.notEqual(
    alec.relationshipWeb.find((connection) => connection.name === "Glass")?.relationship,
    "Family",
  );
  assert.doesNotMatch(alec.summary, /glass\s+is\s+part\s+of.*family/iu);
});

test("local dossier history rejects incidental thought as biography", () => {
  assert.equal(
    localQwenClaimIsDurable("history", "Alec Sumner recalls a moment where he was lost in thought longer than he realized."),
    false,
  );
  assert.equal(
    localQwenClaimIsDurable("history", "Alec Sumner survived the attack and returned to Sanctuary."),
    true,
  );
  assert.equal(
    localQwenClaimIsDurable("fear", "Alec Sumner realized there was nowhere left to hide or die."),
    false,
  );
  assert.equal(
    localQwenClaimIsDurable("fear", "Alec Sumner fears that revealing his true nature will endanger the people around him."),
    true,
  );
  assert.equal(
    localQwenClaimIsDurable("history", "Mara gestured toward a curious setup near the front door, which had escaped Rowan's notice."),
    false,
  );
  assert.equal(
    localQwenClaimIsDurable("history", "Mara's body hit the ground with a thud after the door caught her off guard."),
    false,
  );
  assert.equal(
    localQwenClaimIsDurable("history", "Mara, then Rowan and Vale, and finally lingered on Ilya, who returned her look."),
    false,
  );
  assert.equal(
    localQwenClaimIsDurable("fear", "Dread knotted Mara's forehead as her eyes widened."),
    false,
  );
});

test("the local model can enrich but cannot erase deterministic dossier facts", () => {
  const chunk = {
    id: "projection-guard",
    sourceId: "novel",
    sourceTitle: "Novel",
    index: 0,
    sectionTitle: "Chapter 1 (Mara - Present)",
    content: "Mara protects the crew. Echo lives within Mara's mind, and together they can transform.",
  };
  const base = parseWorldFindingsFromModel({
    characters: [{
      name: "Mara",
      aliases: ["Mara", "Mara Mara", "Captain Mara"],
      summary: "A seasoned salvage captain, Mara keeps her crew alive through dangerous retrievals. Mara is fiercely protective and accepts responsibility for difficult choices. Her planning and suspicion shape how she approaches unfamiliar threats. Echo is a nonhuman symbiont living within Mara's mind, and they can transform together. Mara knows alien vessels used Jupiter as a shield from scans. Mara's body hit the ground with a thud after a door caught her off guard.",
      fears: ["Mara's eyes widened in fear.", "Mara fears that revealing Echo will endanger her crew."],
      history: ["Mara gestured toward a curious setup near the front door, which had escaped Rowan's notice.", "Mara survived the station's destruction and returned home."],
      knowledge: ["Knows Savior of the world.", "Knows the old access codes.", "Mara knows alien vessels used Jupiter as a shield from scans."],
      mentionCount: 30,
      evidence: [{ chunkId: chunk.id, quote: chunk.content }],
    }],
  }, [chunk]).characters[0]!;
  const candidate = {
    ...base,
    aliases: [...base.aliases, "Captain Mara", "Mara Mara"],
    summary: "Mara is fiercely protective of her crew. Mara plans before she takes risks. Mara accepts responsibility for difficult choices. Mara is alert to danger. Mara opened the hatch and looked into the corridor. Qwen extraction remains provisional. Mara refuses to abandon people who depend on her.",
    traits: [...base.traits, "Mara opened the hatch."],
    fears: [...base.fears, "Dread knotted Mara's forehead as her eyes widened."],
    history: [...base.history, "Mara walked through the corridor.", "Mara, then Rowan and Vale, and finally lingered on Ilya, who returned her look.", "Mara chuckled after Rowan left."],
    knowledge: [...base.knowledge, "Mara knows the ship's emergency access codes."],
  };
  const guarded = guardLocalQwenDossierProjection(base, candidate);
  assert.deepEqual(guarded.aliases, ["Captain Mara"]);
  assert.match(guarded.summary, /seasoned salvage captain/iu);
  assert.match(guarded.summary, /Her planning and suspicion/iu);
  assert.match(guarded.summary, /symbiont living within Mara's mind/iu);
  assert.match(guarded.summary, /refuses to abandon people/iu);
  assert.doesNotMatch(guarded.summary, /opened the hatch|Qwen|provisional|Jupiter|body hit the ground/iu);
  assert.ok(!guarded.traits.some((entry) => /opened the hatch/iu.test(entry)));
  assert.deepEqual(guarded.history, ["Mara survived the station's destruction and returned home."]);
  assert.deepEqual(guarded.fears, ["Mara fears that revealing Echo will endanger her crew."]);
  assert.deepEqual(guarded.knowledge, [
    "Knows the old access codes.",
    "Mara knows the ship's emergency access codes.",
  ]);
});

test("dossier projection promotes defining facts and rejects proof-shaped scene fragments", () => {
  const chunk = {
    id: "proof-shaped-projection",
    sourceId: "novel",
    sourceTitle: "Novel",
    index: 0,
    sectionTitle: "Chapter 8 (Mara - Present)",
    content: "Mara is the host of Nyx, an alien symbiont living within her mind. Together they can transform into a towering six-eyed form.",
  };
  const base = parseWorldFindingsFromModel({
    characters: [{
      name: "Mara Vale",
      aliases: ["Mara Vale", "Mara Vale Mara Vale", "Captain Vale"],
      role: "Central Point-of-View Character",
      summary: "A seasoned expedition captain, Mara Vale is fiercely protective, tactical, and responsible for her crew. Mara Vale suddenly became aware that Rowan was waving a hand in front of their face. Mara Vale raised an eyebrow at the damaged plumbing. Mara Vale's fingers transformed into razor-sharp spears and punctured his torso. Nyx is an alien symbiont living within Mara Vale's mind. Mara Vale and Nyx can transform together into a towering, six-eyed nonhuman form.",
      history: [
        "Mara Vale suddenly became aware that Rowan was waving a hand in front of their face.",
        "Mara Vale's fingers transformed into razor-sharp spears and punctured his torso.",
        "Mara Vale survived the station's destruction and returned home.",
      ],
      origins: [
        "Mara Vale raised an eyebrow and considered hiring a plumber.",
        "Mara Vale came from a remote coastal settlement.",
      ],
      mentionCount: 40,
      evidence: [{ chunkId: chunk.id, quote: chunk.content }],
    }],
  }, [chunk]).characters[0]!;
  const candidate = {
    ...base,
    summary: `${base.summary} Mara Vale refuses to abandon people who depend on her. Mara Vale, then Rowan and Ilya, and finally lingered on Nyx, who returned her look.`,
    history: [...base.history, "Mara Vale chuckled after Rowan left."],
  };

  const guarded = guardLocalQwenDossierProjection(base, candidate);
  const summarySentences = guarded.summary.split(/(?<=[.!?])\s+/u);
  assert.ok(summarySentences.length >= 3 && summarySentences.length <= 5);
  assert.match(summarySentences[0]!, /seasoned expedition captain/iu);
  assert.match(guarded.summary, /symbiont living within Mara Vale's mind/iu);
  assert.match(guarded.summary, /transform together into a towering, six-eyed nonhuman form/iu);
  assert.match(guarded.summary, /refuses to abandon people/iu);
  assert.doesNotMatch(
    guarded.summary,
    /became aware|waving a hand|raised an eyebrow|punctured his torso|then Rowan and Ilya|chuckled/iu,
  );
  assert.deepEqual(guarded.aliases, ["Captain Vale"]);
  assert.deepEqual(guarded.history, ["Mara Vale survived the station's destruction and returned home."]);
  assert.deepEqual(guarded.origins, ["Mara Vale came from a remote coastal settlement."]);
});

test("saved replay summaries are rebuilt from structured identity instead of scene prose", () => {
  const chunk = {
    id: "saved-replay-shape",
    sourceId: "novel",
    sourceTitle: "Novel",
    index: 0,
    sectionTitle: "Chapter 10 (Mara Vale - Present)",
    content: "Nyx lives within Mara Vale's mind. They share thoughts and transform together into a towering six-eyed form.",
  };
  const base = parseWorldFindingsFromModel({
    characters: [{
      name: "Mara Vale",
      role: "Central Point-of-View Character",
      summary: "Mara Vale hung up, the weight of responsibility for their safety pressing down on her. Mara Vale watched the door while the provisional dossier was assembled.",
      traits: [
        "Protective of others",
        "Willing to shoulder responsibility",
        "Practical and strategic under pressure",
      ],
      capabilities: [
        "Mara Vale and Nyx can communicate and share thoughts within the same mind.",
        "Mara Vale's transformed form demonstrates extraordinary physical strength.",
      ],
      powers: [
        "Mara Vale can physically transform.",
        "Mara Vale and Nyx can transform together into a towering, six-eyed nonhuman form.",
      ],
      history: ["Mara Vale survived the station's destruction and returned home."],
      relationships: ["Nyx: Symbiotic Bond"],
      relationshipWeb: [{
        name: "Nyx",
        relationship: "Symbiotic Bond",
        summary: "Mara Vale and Nyx share a symbiotic bond.",
        sentiment: "allied",
        evidence: [{ chunkId: chunk.id, sourceId: chunk.sourceId, quote: chunk.content }],
      }],
      mentionCount: 40,
      evidence: [{ chunkId: chunk.id, quote: chunk.content }],
    }],
  }, [chunk]).characters[0]!;
  const candidate = {
    ...base,
    summary: `${base.summary} Mara Vale stepped into the corridor and paused beside the hatch. Connected AI must verify these provisional claims.`,
  };

  const guarded = guardLocalQwenDossierProjection(base, candidate);
  const sentences = guarded.summary.split(/(?<=[.!?])\s+/u);
  assert.ok(sentences.length >= 3 && sentences.length <= 5);
  assert.match(guarded.summary, /Mara Vale is protective of others/iu);
  assert.match(guarded.summary, /Nyx lives within Mara Vale's mind/iu);
  assert.match(guarded.summary, /transform together into a towering, six-eyed nonhuman form/iu);
  assert.match(guarded.summary, /survived the station's destruction/iu);
  assert.equal(guarded.summary.match(/\btransform\w*\b/giu)?.length, 1);
  assert.doesNotMatch(guarded.summary, /hung up|weight of responsibility|watched the door|stepped into|paused beside|Connected AI|provisional/iu);
});

test("saved dossier projection requires pair-bound transformation evidence", () => {
  const chunk = {
    id: "pair-bound-transformation",
    sourceId: "embers",
    sourceTitle: "EMBERS",
    index: 220,
    sectionTitle: "Chapter 63 (Alec Sumner - Present)",
    content: "Lilly waited near the doorway. Echo released herself from her chains and our transformation began. Alec Sumner and Echo transformed together into a six-eyed nonhuman form.",
  };
  const base = parseWorldFindingsFromModel({
    characters: [{
      name: "Alec Sumner",
      summary: "Alec Sumner is protective and practical. Alec Sumner and Lilly can transform together into a powerful nonhuman form. Alec Sumner and Echo can transform together into a six-eyed nonhuman form.",
      traits: ["Protective of others", "Practical and strategic under pressure"],
      powers: [
        "Alec Sumner and Lilly can transform together into a powerful nonhuman form.",
        "Alec Sumner and Echo can transform together into a six-eyed nonhuman form.",
      ],
      capabilities: [
        "Alec Sumner and Lilly can transform together into a powerful nonhuman form.",
        "Alec Sumner and Echo can transform together into a six-eyed nonhuman form.",
      ],
      evidence: [{ chunkId: chunk.id, sourceId: chunk.sourceId, quote: chunk.content }],
    }],
  }, [chunk]).characters[0]!;

  const guarded = guardLocalQwenDossierProjection(base, base);
  assert.match(guarded.summary, /Alec Sumner and Echo can transform together/iu);
  assert.doesNotMatch(guarded.summary, /Alec Sumner and Lilly can transform together/iu);
  assert.deepEqual(guarded.powers, [
    "Alec Sumner and Echo can transform together into a six-eyed nonhuman form.",
  ]);
  assert.deepEqual(guarded.capabilities, [
    "Alec Sumner and Echo can transform together into a six-eyed nonhuman form.",
  ]);
});

test("a host-first saved capability restores the symbiont dossier's joint power", () => {
  const chunk = {
    id: "reverse-saved-transformation",
    sourceId: "novel",
    sourceTitle: "Novel",
    index: 12,
    sectionTitle: "Chapter 12 (Calder Vale - Present)",
    content: "Nyx is an alien symbiont living within Calder Vale's mind. Calder Vale and Nyx transformed together into a nine-foot, six-eyed nonhuman form.",
  };
  const base = parseWorldFindingsFromModel({
    characters: [{
      name: "Nyx",
      summary: "Nyx shares a living symbiotic bond with Calder Vale.",
      capabilities: [
        "Calder Vale and Nyx can transform together into a nine-foot, six-eyed nonhuman form.",
      ],
      powers: [],
      relationships: ["Calder Vale: Symbiotic Bond"],
      relationshipWeb: [{
        name: "Calder Vale",
        relationship: "Symbiotic Bond",
        summary: "Nyx and Calder Vale share a symbiotic bond.",
        sentiment: "allied",
        evidence: [{
          chunkId: chunk.id,
          sourceId: chunk.sourceId,
          quote: chunk.content,
          sectionTitle: chunk.sectionTitle,
        }],
      }],
      evidence: [{
        chunkId: chunk.id,
        sourceId: chunk.sourceId,
        quote: chunk.content,
        sectionTitle: chunk.sectionTitle,
      }],
    }],
  }, [chunk]).characters[0]!;

  const guarded = guardLocalQwenDossierProjection(base, base);
  assert.match(guarded.summary, /Nyx is an alien symbiont living within Calder Vale's mind/iu);
  assert.deepEqual(guarded.powers, [
    "Calder Vale and Nyx can transform together into a nine-foot, six-eyed nonhuman form.",
  ]);
});

test("saved dossier projection collapses semantic duplicates and weak scene urges", () => {
  const chunk = {
    id: "saved-semantic-duplicates",
    sourceId: "novel",
    sourceTitle: "Novel",
    index: 4,
    sectionTitle: "Chapter 4",
    content: "The durable facts represented by this generated dossier were established across the manuscript.",
  };
  const alec = parseWorldFindingsFromModel({
    characters: [{
      name: "Alec Sumner",
      summary: "Alec Sumner is protective and practical.",
      capabilities: [
        "Alec Sumner fights with clawed hands that rip through armor like tissue paper.",
        "Alec Sumner possesses clawed hands capable of ripping through armor like tissue paper.",
        "Alec Sumner fights with a clawed hand that rips through armor like tissue paper.",
        "Alec Sumner can initiate a change into another body.",
        "Alec Sumner can initiate a change into another body without too much effort.",
      ],
      motivations: [
        "Alec Sumner wanted to turn away - but that would be cowardly.",
        "Alec Sumner vowed to protect the settlement's children.",
      ],
      evidence: [{ chunkId: chunk.id, sourceId: chunk.sourceId, quote: chunk.content }],
    }],
  }, [chunk]).characters[0]!;
  const guardedAlec = guardLocalQwenDossierProjection(alec, alec);
  assert.equal(guardedAlec.capabilities.filter((value) => /clawed?\s+hands?.*armor/iu.test(value)).length, 1);
  assert.deepEqual(
    guardedAlec.capabilities.filter((value) => /initiate a change into another body/iu.test(value)),
    ["Alec Sumner can initiate a change into another body without too much effort."],
  );
  assert.deepEqual(guardedAlec.motivations, [
    "Alec Sumner vowed to protect the settlement's children.",
  ]);

  const michael = parseWorldFindingsFromModel({
    characters: [{
      name: "Michael",
      summary: "Michael is resourceful and loyal.",
      history: [
        "Michael had to drop out of school and work to keep the lights on, relying on Alec for support.",
        "Michael dropped out of school to work and keep the lights on.",
      ],
      evidence: [{ chunkId: chunk.id, sourceId: chunk.sourceId, quote: chunk.content }],
    }],
  }, [chunk]).characters[0]!;
  assert.deepEqual(guardLocalQwenDossierProjection(michael, michael).history, [
    "Michael had to drop out of school and work to keep the lights on, relying on Alec for support.",
  ]);

  const kendall = parseWorldFindingsFromModel({
    characters: [{
      name: "Kendall",
      summary: "Kendall is capable in a confrontation, resilient under danger and strain, physically formidable, and resilient under injury and strain. Kendall is capable in a confrontation, resilient through danger and injury, emotionally direct and deeply invested in others, and inclined to use humor under pressure.",
      traits: [
        "Capable in a confrontation",
        "Resilient through danger and injury",
        "Emotionally direct and deeply invested in others",
        "Inclined to use humor under pressure",
      ],
      evidence: [{ chunkId: chunk.id, sourceId: chunk.sourceId, quote: chunk.content }],
    }],
  }, [chunk]).characters[0]!;
  const guardedKendall = guardLocalQwenDossierProjection(kendall, kendall);
  assert.equal(guardedKendall.summary.match(/Kendall is capable in a confrontation/giu)?.length, 1);
  assert.match(guardedKendall.summary, /emotionally direct and deeply invested/iu);
});

test("saved dossier finalization keeps durable decisions and structured relationship shapes", () => {
  const chunk = {
    id: "saved-profile-shapes",
    sourceId: "novel",
    sourceTitle: "Novel",
    index: 8,
    sectionTitle: "Chapter 8",
    content: "Mara moved in with Rowan's family after leaving school. Mara refused to abandon the refugees. Mara and Rowan share a symbiotic bond.",
  };
  const base = parseWorldFindingsFromModel({
    characters: [{
      name: "Mara Vale",
      summary: "Mara Vale is protective, practical, and loyal. Mara Vale could escape to the northern forests, survive there. Mara Vale refused to accept that fate. Mara Vale refused to let those creatures survive the inferno where they had taken the life of her friend.",
      traits: [
        "Mara Vale acted as a joker.",
        "Inclined to use humor under pressure",
      ],
      motivations: [
        "Mara Vale decided to keep the refugees' route secret.",
        "Mara Vale refused to abandon the refugees.",
        "Mara Vale plans to reach the northern forests and build a refuge there.",
        "Mara Vale could escape to the northern forests, survive there.",
        "Mara Vale refused to accept that fate.",
        "Mara Vale refused to let those attackers survive the fire.",
      ],
      history: [
        "Mara Vale could escape to the northern forests, survive there.",
        "Mara Vale escaped to the northern forests and survived there.",
        "Mara Vale refused to accept that fate.",
        "Mara Vale refused to let those attackers escape through the burning gate.",
      ],
      relationships: [
        "Mara Vale moved in with Rowan's family.",
        "Mara Vale views the bonded human as a valuable asset.",
        "Rowan: Symbiotic Bond",
      ],
      evidence: [{ chunkId: chunk.id, sourceId: chunk.sourceId, quote: chunk.content }],
    }],
  }, [chunk]).characters[0]!;
  base.relationshipWeb = [{
    name: "Rowan",
    relationship: "Symbiotic Bond",
    summary: "Mara Vale and Rowan share a symbiotic bond.",
    sentiment: "allied",
    evidence: [{ chunkId: chunk.id, sourceId: chunk.sourceId, quote: chunk.content }],
  }];

  const guarded = guardLocalQwenDossierProjection(base, base);
  assert.doesNotMatch(guarded.summary, /could escape to the northern forests|refused to accept that fate|refused to let those (?:attackers|creatures)/iu);
  assert.deepEqual(guarded.motivations, [
    "Mara Vale decided to keep the refugees' route secret.",
    "Mara Vale refused to abandon the refugees.",
    "Mara Vale plans to reach the northern forests and build a refuge there.",
  ]);
  assert.deepEqual(guarded.traits, ["Inclined to use humor under pressure"]);
  assert.deepEqual(guarded.relationships, ["Rowan: Symbiotic Bond"]);
  assert.deepEqual(guarded.history, [
    "Mara Vale escaped to the northern forests and survived there.",
    "Mara Vale moved in with Rowan's family.",
  ]);
  assert.equal(guarded.relationshipWeb.length, 1);
  assert.equal(localQwenClaimIsDurable(
    "history",
    "If the city fell, Mara Vale would escape to the northern forests.",
  ), false);
  assert.equal(localQwenClaimIsDurable(
    "history",
    "Mara Vale considered escaping to the northern forests.",
  ), false);
  assert.equal(localQwenClaimIsDurable(
    "capability",
    "Mara Vale could survive in extreme cold without shelter.",
  ), true);
});

test("saved role metadata cannot leave a stale central-POV sentence in the portrait", () => {
  const chunk = {
    id: "saved-role-drift",
    sourceId: "novel",
    sourceTitle: "Novel",
    index: 0,
    sectionTitle: "Chapter 4 (Mara - Present)",
    content: "Mara kept the frightened crew together and planned their escape.",
  };
  const base = parseWorldFindingsFromModel({
    characters: [{
      name: "Mara Vale",
      aliases: ["Mara"],
      role: "Point-of-View Character",
      summary: "Mara Vale is protective of others and a practical strategist. As a central point-of-view character, Mara Vale's choices and perspective anchor the story.",
      traits: ["Protective of others", "Practical and strategic under pressure"],
      mentionCount: 20,
      evidence: [{ chunkId: chunk.id, quote: chunk.content }],
    }],
  }, [chunk]).characters[0]!;
  const guarded = guardLocalQwenDossierProjection(base, {
    ...base,
    role: "Central Point-of-View Character",
    summary: `${base.summary} Mara Vale is a central point-of-view character in the story.`,
  });

  assert.equal(guarded.role, "Point-of-View Character");
  assert.match(guarded.summary, /protective of others/iu);
  assert.doesNotMatch(guarded.summary, /central point-of-view|point-of-view character in the story/iu);
});

test("a pair-bound mind passage promotes the internal symbiont fact despite a shortened alias", () => {
  const chunk = {
    id: "saved-shared-mind-alias",
    sourceId: "novel",
    sourceTitle: "Novel",
    index: 0,
    sectionTitle: "Chapter 4 (Mara - Present)",
    content: "Nyx's voice roared in my mind while I tried to answer.",
  };
  const base = parseWorldFindingsFromModel({
    characters: [{
      name: "Mara Vale",
      aliases: ["Mara"],
      role: "Point-of-View Character",
      summary: "Mara Vale shares a living symbiotic bond with Nyx.",
      traits: ["Protective of others"],
      relationships: ["Nyx: Symbiotic Bond"],
      relationshipWeb: [{
        name: "Nyx",
        relationship: "Symbiotic Bond",
        summary: "Mara and Nyx share a symbiotic bond.",
        sentiment: "allied",
        evidence: [{ chunkId: chunk.id, sourceId: chunk.sourceId, quote: chunk.content }],
      }],
      mentionCount: 20,
      evidence: [{ chunkId: chunk.id, quote: chunk.content }],
    }],
  }, [chunk]).characters[0]!;
  const guarded = guardLocalQwenDossierProjection(base, {
    ...base,
    summary: "Mara Vale has a living symbiotic bond.",
  });

  assert.match(guarded.summary, /Nyx lives within Mara Vale's mind/iu);
  assert.doesNotMatch(guarded.summary, /has a living symbiotic bond\.$/iu);
});

test("the symbiont dossier preserves the reverse direction of a pair-bound shared mind", () => {
  const chunk = {
    id: "saved-shared-mind-reverse",
    sourceId: "novel",
    sourceTitle: "Novel",
    index: 0,
    sectionTitle: "Chapter 4 (Calder - Present)",
    content: "Nyx's voice roared in my mind while I tried to answer.",
  };
  const base = parseWorldFindingsFromModel({
    characters: [{
      name: "Nyx",
      role: "Symbiotic Companion",
      summary: "Nyx shares a living symbiotic bond with Calder Vale.",
      relationships: ["Calder Vale: Symbiotic Bond"],
      relationshipWeb: [{
        name: "Calder Vale",
        relationship: "Symbiotic Bond",
        summary: "Nyx and Calder Vale share a symbiotic bond.",
        sentiment: "allied",
        evidence: [{
          chunkId: chunk.id,
          sourceId: chunk.sourceId,
          quote: chunk.content,
          sectionTitle: chunk.sectionTitle,
        }],
      }],
      mentionCount: 20,
      evidence: [{ chunkId: chunk.id, sourceId: chunk.sourceId, quote: chunk.content }],
    }],
  }, [chunk]).characters[0]!;
  const guarded = guardLocalQwenDossierProjection(base, {
    ...base,
    summary: "Nyx has a living symbiotic bond with Calder Vale.",
  });

  assert.match(guarded.summary, /Nyx lives within Calder Vale's mind/iu);
  assert.doesNotMatch(guarded.summary, /Nyx shares a living symbiotic bond with Calder Vale\.$/iu);
});

test("explicit self-identification and titles reach the local portrait", () => {
  const chunk = {
    id: "explicit-self-identification",
    sourceId: "novel",
    sourceTitle: "Novel",
    index: 0,
    sectionTitle: "Prologue (Tarin - Present)",
    content: '"I am Kaelor Venn, creator, ruler and General of the old guard, known among the frontier as the Warden," Tarin said.',
  };
  const findings = parseWorldFindingsFromModel({
    characters: [{
      name: "Tarin",
      aliases: ["Kaelor Venn", "Warden"],
      mentionCount: 20,
      evidence: [{ chunkId: chunk.id, quote: chunk.content }],
    }],
  }, [chunk]);
  findings.characters[0]!.mentionCount = 20;
  const tarin = enrichLocalCharacterFindings(findings, [], [chunk]).characters[0]!;
  assert.match(tarin.summary, /Tarin identifies themself as Kaelor Venn/iu);
  assert.match(tarin.summary, /creator, ruler, and general/iu);
  assert.match(tarin.summary, /also known as Warden/iu);
  assert.ok(tarin.history.some((entry) => /identifies themself as Kaelor Venn/iu.test(entry)));
});

test("self-identification binds only the speaker's own titles", () => {
  const chunk = {
    id: "explicit-self-title-binding",
    sourceId: "novel",
    sourceTitle: "Novel",
    index: 0,
    sectionTitle: "Prologue (Tarin - Present)",
    content: '"I am Kaelor Venn. The fallen high regent of the old empire, once second only to the Queen herself. First Kaelor, the Protector, ruler and General of the flagship, and known to your kind as \'the Warden\'."',
  };
  const findings = parseWorldFindingsFromModel({
    characters: [{
      name: "Tarin",
      aliases: ["Kaelor Venn", "Warden"],
      mentionCount: 20,
      evidence: [{ chunkId: chunk.id, quote: chunk.content }],
    }],
  }, [chunk]);
  findings.characters[0]!.mentionCount = 20;
  const tarin = enrichLocalCharacterFindings(findings, [], [chunk]).characters[0]!;

  assert.match(tarin.summary, /identifies themself as Kaelor Venn/iu);
  assert.match(tarin.summary, /high regent/iu);
  assert.match(tarin.summary, /protector, ruler, and general/iu);
  assert.match(tarin.summary, /also known as Warden/iu);
  assert.doesNotMatch(tarin.summary, /(?:,|as) queen\b/iu);
});

test("label fragments are not promoted as character knowledge", () => {
  assert.equal(localDossierKnowledgeClaimIsUseful("Knows Savior of the world."), false);
  assert.equal(localDossierKnowledgeClaimIsUseful("Knows the old access codes."), true);
  assert.equal(localDossierKnowledgeClaimIsUseful("Mara knows that the station is compromised."), true);
  assert.equal(localDossierKnowledgeClaimIsUseful("Mara knows alien vessels used Jupiter as a shield from scans."), false);
  assert.equal(localDossierKnowledgeClaimIsUseful("Mara believes she is not crazy despite Rowan's doubts."), false);
  assert.equal(localDossierKnowledgeClaimIsUseful("Mara believes humanity can break the invaders' control."), true);
  assert.equal(
    localDossierKnowledgeClaimIsUseful("Storyhold's local pass knows the old access codes."),
    false,
  );
});

test("explicit bodily transformation reaches the portrait without a preclassified form edge", () => {
  const chunk = {
    id: "generic-form-change",
    sourceId: "novel",
    sourceTitle: "Novel",
    index: 0,
    sectionTitle: "Chapter 8 (Rowan - Present)",
    content: "Tarin looked at Rowan and told her to leave. As he spoke, his legs swelled and lengthened, his fur fell away, and his muscles bulged beneath gray skin. He began to take on the familiar form of the Prowlers. Tarin twisted and stretched until he towered above Rowan.",
  };
  const findings = parseWorldFindingsFromModel({
    characters: [{
      name: "Tarin",
      mentionCount: 20,
      evidence: [{ chunkId: chunk.id, quote: chunk.content }],
    }],
  }, [chunk]);
  findings.characters[0]!.mentionCount = 20;
  const tarin = enrichLocalCharacterFindings(findings, [], [chunk]).characters[0]!;
  assert.match(tarin.summary, /Tarin can physically transform into the form of the Prowlers/iu);
  assert.ok(tarin.powers.some((power) => /transform into the form of the Prowlers/iu.test(power)));
  assert.ok(tarin.capabilities.some((capability) => /Prowlers form visibly changes their body/iu.test(capability)));
  assert.ok(tarin.evidence.some((entry) => entry.chunkId === chunk.id && /form of the Prowlers/iu.test(entry.quote)));
});

test("first-person evidence from another point of view is not assigned to Alec", () => {
  const quote = "I could remove the debris alone, but doing so would risk revealing my true nature.";
  assert.equal(localQwenFactBelongsToCharacter({
    name: "Alec Sumner",
    aliases: ["Alec"],
    chapter: "Prologue: An Old Dog's Tale",
    quote,
  }), false);
  assert.equal(localQwenFactBelongsToCharacter({
    name: "Alec Sumner",
    aliases: ["Alec"],
    chapter: "Chapter 1 (Alec - Present)",
    quote,
  }), true);
});

test("local stat evidence rejects hypotheticals and noun-only keyword collisions", () => {
  const chunk = {
    id: "alec-stat-guard",
    sourceId: "ashes",
    sourceTitle: "ASHES",
    index: 3,
    sectionTitle: "Chapter 4 (Alec - Present)",
    content: "Alec wondered whether he could survive the blast. Buildings surrounded the road.",
  };
  const findings = parseWorldFindingsFromModel({
    characters: [{
      name: "Alec",
      mentionCount: 20,
      evidence: [{ chunkId: chunk.id, quote: chunk.content }],
    }],
  }, [chunk]);
  findings.characters[0]!.mentionCount = 20;
  const alec = enrichLocalCharacterFindings(findings, [{
    signalType: "story_action",
    fields: { actor: ["Alec"], action: ["could survive the blast"] },
    score: 0.8,
    chunkId: chunk.id,
    sourceId: chunk.sourceId,
    quote: "Alec wondered whether he could survive the blast.",
  }, {
    signalType: "story_action",
    fields: { actor: ["Alec"], action: ["Buildings surrounded the road"] },
    score: 0.8,
    chunkId: chunk.id,
    sourceId: chunk.sourceId,
    quote: "Buildings surrounded the road.",
  }], [chunk]).characters[0]!;
  assert.equal(alec.estimatedStats.constitution.evidence.length, 0);
  assert.equal(alec.estimatedStats.intelligence.evidence.length, 0);
});

test("ASHES fixtures preserve metaphorical family, manifested forms, and Sanctuary as a place", () => {
  const findings = parseWorldFindingsFromModel({
    characters: [
      { name: "Alec", aliases: ["Sir Alec"], role: "Detected character candidate", evidence: [{ chunkId: "ashes-alec-echo-one", quote: ASHES_DIFFICULT_CHUNKS[0]!.content }] },
      { name: "Echo", evidence: [{ chunkId: "ashes-alec-echo-one", quote: ASHES_DIFFICULT_CHUNKS[0]!.content }] },
      { name: "Michael", evidence: [{ chunkId: "ashes-michael-thrall", quote: ASHES_DIFFICULT_CHUNKS[2]!.content }] },
      { name: "Ragger", aliases: ["Anubis", "Anubsika", "Old Dog"], evidence: [{ chunkId: "ashes-ragger-identity", quote: ASHES_DIFFICULT_CHUNKS[3]!.content }] },
    ],
    locations: [
      { name: "Sanctuary", evidence: [{ chunkId: "ashes-coop-sanctuary", quote: ASHES_DIFFICULT_CHUNKS[4]!.content }] },
      { name: "Co-op", evidence: [{ chunkId: "ashes-coop-sanctuary", quote: ASHES_DIFFICULT_CHUNKS[4]!.content }] },
      { name: "aisle", confidence: 0.9, evidence: [{ chunkId: "ashes-generic-inventory-noise", quote: ASHES_DIFFICULT_CHUNKS[5]!.content }] },
    ],
    creatures: [
      { name: "Thrall", evidence: [{ chunkId: "ashes-michael-thrall", quote: ASHES_DIFFICULT_CHUNKS[2]!.content }] },
      { name: "Visharath", evidence: [{ chunkId: "ashes-alec-echo-mind", quote: ASHES_DIFFICULT_CHUNKS[6]!.content }] },
      { name: "animal", confidence: 0.9, evidence: [{ chunkId: "ashes-generic-inventory-noise", quote: ASHES_DIFFICULT_CHUNKS[5]!.content }] },
    ],
    devices: [{ name: "alarm", confidence: 0.9, evidence: [{ chunkId: "ashes-generic-inventory-noise", quote: ASHES_DIFFICULT_CHUNKS[5]!.content }] }],
    weapons: [{ name: "ammunition", confidence: 0.9, evidence: [{ chunkId: "ashes-generic-inventory-noise", quote: ASHES_DIFFICULT_CHUNKS[5]!.content }] }],
    powers: [{ name: "abilities", confidence: 0.9, evidence: [{ chunkId: "ashes-generic-inventory-noise", quote: ASHES_DIFFICULT_CHUNKS[5]!.content }] }],
  }, ASHES_DIFFICULT_CHUNKS);
  findings.characters.forEach((character) => { character.mentionCount = 20; });
  findings.locations.forEach((location) => { location.mentionCount = 20; });
  const enriched = enrichLocalCharacterFindings(
    findings,
    [],
    ASHES_DIFFICULT_CHUNKS,
    DIFFICULT_RELATIONS,
  );
  const alec = enriched.characters.find((character) => character.name === "Alec")!;
  const echo = enriched.characters.find((character) => character.name === "Echo")!;
  const michael = enriched.characters.find((character) => character.name === "Michael")!;
  const ragger = enriched.characters.find((character) => character.name === "Ragger")!;

  for (const required of STORYHOLD_DIFFICULT_EXPECTATIONS.alec.requiredConnections) {
    assert.ok(alec.relationshipWeb.some((connection) => connection.name === required));
  }
  assert.ok(alec.relationshipWeb.some((connection) => connection.name === "Echo" && connection.relationship === "Familial Bond"));
  assert.ok(!alec.relationshipWeb.some((connection) => connection.relationship === STORYHOLD_DIFFICULT_EXPECTATIONS.alec.forbiddenRelationship));
  assert.ok(!alec.relationshipWeb.some((connection) => ["aisle", "alarm", "ammunition", "animal", "abilities"].includes(connection.name)));
  assert.match(alec.summary, /host of Echo, a Visharath symbiont/iu);
  assert.match(alec.summary, /transform together into a nine-foot, six-eyed nonhuman form/iu);
  assert.doesNotMatch(alec.summary, /counts .* among their closest friends|is partnered with/iu);
  assert.ok(alec.capabilities.some((capability) => /share thoughts within the same mind/iu.test(capability)));
  assert.ok(alec.capabilities.some((capability) => capability.includes("extraordinary physical strength and nonhuman sensory perception")));
  assert.ok(alec.powers.some((power) => /transform together/iu.test(power)));
  assert.ok(alec.powers.every((power) => !/and Visharath can transform/iu.test(power)));
  assert.ok(alec.physicalCharacteristics.some((description) => /nine feet tall and six-eyed/iu.test(description)));
  assert.equal(alec.estimatedStats.strength.score, 16);
  assert.ok(alec.estimatedStats.strength.evidence.some((entry) => entry.chunkId === "ashes-alec-echo-transformation"));
  assert.match(alec.estimatedStats.strength.rationale, /nine-foot body.*extraordinary physical strength/iu);
  assert.match(echo.summary, /Echo is a Visharath symbiont living within Alec's mind/iu);
  assert.ok(echo.powers.some((power) => /Echo and Alec can transform together into a nine-foot, six-eyed nonhuman form/iu.test(power)));
  assert.ok(michael.relationshipWeb.some((connection) => connection.name === "Thrall" && connection.relationship === "Manifests As"));
  assert.deepEqual(new Set(ragger.aliases), new Set(STORYHOLD_DIFFICULT_EXPECTATIONS.ragger.aliases));
  assert.notEqual(findings.locations[0]!.name, findings.locations[1]!.name);
});

test("ALIEN fixture produces Addison's core relationship shape without process boilerplate", () => {
  const findings = parseWorldFindingsFromModel({
    characters: [
      { name: "Addison Gray", aliases: ["Addison", "Captain Gray"], role: "Detected character candidate", evidence: ALIEN_DIFFICULT_CHUNKS.map((chunk) => ({ chunkId: chunk.id, quote: chunk.content })) },
      { name: "Driver", evidence: [{ chunkId: "alien-addison-one", quote: ALIEN_DIFFICULT_CHUNKS[0]!.content }] },
      { name: "Fariah", evidence: [{ chunkId: "alien-addison-two", quote: ALIEN_DIFFICULT_CHUNKS[1]!.content }] },
    ],
    factions: [{ name: "Rust Raptor Crew", evidence: [{ chunkId: "alien-addison-one", quote: ALIEN_DIFFICULT_CHUNKS[0]!.content }] }],
    locations: [{ name: "LV-2032", evidence: [{ chunkId: "alien-addison-one", quote: ALIEN_DIFFICULT_CHUNKS[0]!.content }] }],
  }, ALIEN_DIFFICULT_CHUNKS);
  findings.characters.forEach((character) => { character.mentionCount = 20; });
  const addison = enrichLocalCharacterFindings(
    findings,
    [],
    ALIEN_DIFFICULT_CHUNKS,
    DIFFICULT_RELATIONS,
  ).characters.find((character) => character.name === "Addison Gray")!;

  for (const required of STORYHOLD_DIFFICULT_EXPECTATIONS.addison.requiredConnections) {
    assert.ok(addison.relationshipWeb.some((connection) => connection.name === required));
  }
  assert.doesNotMatch(addison.summary, /Storyhold|model|analysis|passage count|provisional|backend/iu);
});
