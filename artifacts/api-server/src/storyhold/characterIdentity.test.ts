import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  characterAliasAttributions,
  chapterPerspective,
  composeFormalCharacterName,
  directlyAddressedAliasOfEstablishedCharacter,
  mergeGeneratedIdentityProfiles,
  mergeGeneratedIdentityRowsAtomic,
  nicknameAddressesPerspective,
  normalizeCharacterAliasAttribution,
  pairedSurnameReveals,
  repairGeneratedCharacterIdentities,
  resolveExplicitCharacterIdentities,
  resolveGeneratedTaxonomyPluralIdentities,
  selfDeclaredAliasAttributions,
  updateGeneratedIdentityPresentationAtomic,
  type ExplicitCharacterIdentityEntity,
  type IdentityChunk,
} from "./characterIdentity";

function chunk(content: string, chapterTitle = "Chapter 4 (Alec - Present)"): IdentityChunk {
  return {
    id: crypto.randomUUID(),
    sourceId: "10000000-0000-4000-8000-000000000001",
    sourceTitle: "Ashes of the Earth",
    content,
    metadata: { sectionTitle: chapterTitle },
  };
}

test("a paired surname reveal resolves both already-known characters", () => {
  const [reveal] = pairedSurnameReveals({
    content: 'I stared at them. "Lilly and James... Potter?" I asked.',
    knownGivenNames: ["Lilly", "James", "Alec"],
  });
  assert.deepEqual(reveal?.givenNames, ["Lilly", "James"]);
  assert.equal(reveal?.surname, "Potter");
  assert.match(reveal?.quote ?? "", /Lilly and James\.\.\. Potter\?/u);
});

test("a list of names without reveal punctuation is not treated as a surname", () => {
  const reveals = pairedSurnameReveals({
    content: "Lilly and James met Potter at the gate.",
    knownGivenNames: ["Lilly", "James", "Potter"],
  });
  assert.deepEqual(reveals, []);
});

test("an interrupted direct address establishes a short-form alias without fuzzy spelling", () => {
  const witness = directlyAddressedAliasOfEstablishedCharacter({
    canonicalNames: ["Mikael"],
    alias: "Mik",
    chunks: [chunk('Mikael opened his mouth to respond, but Elena cut in, urgency in her voice. "We have to move, Mik. Now."')],
  });
  assert.equal(witness?.attributedBy, "Elena");
  assert.match(witness?.quote ?? "", /Mikael opened his mouth[\s\S]+Mik\. Now/iu);
  assert.equal(directlyAddressedAliasOfEstablishedCharacter({
    canonicalNames: ["Mikael"],
    alias: "Mik",
    chunks: [chunk('Mikael watched Elena cross the room. Later, she asked Mik to close the door.')],
  }), null, "ordinary co-occurrence cannot merge two dossiers");
});

test("direct formal address composes Alec Sumner", () => {
  const result = composeFormalCharacterName({
    givenName: "Alec",
    content: 'Professor McCarrin looked at me. "Your nights seem consistently lengthy, Mr. Sumner. You should rest."',
    metadata: { sectionTitle: "Chapter 2 (Alec - Present)" },
  });
  assert.deepEqual(result, { name: "Alec Sumner", addressedAs: "Mr. Sumner" });
});

test("the formal surname remains inspectable after the name is composed", () => {
  const attributions = characterAliasAttributions({
    canonicalName: "Alec Sumner",
    aliases: ["Mr. Sumner"],
    knownCharacterNames: ["Alec Sumner", "Professor McCarrin"],
    chunks: [chunk('She scrutinized me. “Your nights seem consistently lengthy, Mr. Sumner.”')],
  });
  assert.equal(attributions[0]?.alias, "Mr. Sumner");
  assert.match(attributions[0]?.quote ?? "", /Mr\. Sumner/u);
  assert.doesNotMatch(attributions[0]?.explanation ?? "", /astronomy joke/iu);
});

test("a bare surname does not steal the attribution of a longer formal address", () => {
  const attributions = characterAliasAttributions({
    canonicalName: "Alec Sumner",
    aliases: ["Mr. Sumner", "Sumner"],
    knownCharacterNames: ["Alec Sumner", "Professor McCarrin"],
    chunks: [chunk('Professor McCarrin looked at me. "You should rest, Mr. Sumner."')],
  });
  assert.deepEqual(attributions.map((entry) => entry.alias), ["Mr. Sumner"]);
  assert.equal(attributions[0]?.attributedBy, "Professor McCarrin");
});

test("nickname evidence records who used each name and why", () => {
  const attributions = characterAliasAttributions({
    canonicalName: "Alec Sumner",
    aliases: ["Sir Alec", "Buzz", "Mr. Aldrin", "Little Alec"],
    knownCharacterNames: ["Alec Sumner", "David", "Lilly"],
    chunks: [
      chunk('David leaned toward me. "Sir Alec, shall we proceed?" I sighed.'),
      chunk('David grinned at me. "Buzz, get over here." I scowled at the nickname.'),
      chunk('David pointed at the sky. "Mr. Aldrin, you are the astronomy student." I rolled my eyes.'),
      chunk('Lilly studied me. "Little Alec... I never thought of what you might be like as a kid."'),
    ],
  });
  assert.deepEqual(
    attributions.map(({ alias, attributedBy, kind }) => ({ alias, attributedBy, kind })),
    [
      { alias: "Sir Alec", attributedBy: "David", kind: "honorific" },
      { alias: "Buzz", attributedBy: "David", kind: "nickname" },
      { alias: "Mr. Aldrin", attributedBy: "David", kind: "formal_address" },
      { alias: "Little Alec", attributedBy: "Lilly", kind: "descriptive_reference" },
    ],
  );
  assert.match(
    attributions.find((entry) => entry.alias === "Mr. Aldrin")?.explanation ?? "",
    /formal or teasing form of address/u,
  );
  assert.doesNotMatch(
    attributions.find((entry) => entry.alias === "Mr. Aldrin")?.explanation ?? "",
    /astronomy joke|reference or wordplay/iu,
  );
  const littleAlec = attributions.find((entry) => entry.alias === "Little Alec");
  assert.equal(littleAlec?.temporalScope, "single_scene");
  assert.match(littleAlec?.explanation ?? "", /is not a child in this scene/u);
  assert.deepEqual(littleAlec?.semanticLimits, [
    "Does not mean the character is a child in this scene.",
    "Does not turn past-timeline chapters into childhood chapters.",
  ]);
});

test("the Ashes Buzz scene is recognized as David naming Alec", () => {
  const content = `David's gaze remained fixed on me, his smirk never leaving his face. "You've earned my respect, Buzz," he said. I scowled at the nickname. “That had better not fuckin’ stick,” I muttered.`;
  assert.equal(nicknameAddressesPerspective({
    alias: "Buzz",
    canonicalName: "Alec Sumner",
    content,
    metadata: { sectionTitle: "Chapter 10 - Tipping the Scales (Alec - Present)" },
  }), true);
});

test("the Ashes Sir Alec and Little Alec scenes preserve their speakers", () => {
  const attributions = characterAliasAttributions({
    canonicalName: "Alec Sumner",
    aliases: ["Sir Alec", "Little Alec"],
    knownCharacterNames: ["Alec Sumner", "David", "Lilly"],
    chunks: [
      chunk('David chuckled at my outburst. “Sir Alec certainly has a temper, doesn\'t he?”'),
      chunk('Lilly stepped up behind me, peering in and looking around. "Little Alec... I never thought of what you might be like as a kid."'),
    ],
  });
  assert.deepEqual(
    attributions.map(({ alias, attributedBy }) => ({ alias, attributedBy })),
    [
      { alias: "Sir Alec", attributedBy: "David" },
      { alias: "Little Alec", attributedBy: "Lilly" },
    ],
  );
});

test("saved alias hovercards follow the quote-local speaker when older names are nearby", () => {
  const sourceId = "31967e19-2fd8-42e8-85db-2291560144e2";
  const sourceTitle = "Two-volume manuscript";
  const evidence = [
    {
      id: "speaker-sir-alec",
      sourceId,
      sourceTitle,
      content: `I twisted in my seat and looked at Jim. "Jimmy, let me handle this." David chuckled at my outburst. “Sir Alec certainly has a temper, doesn't he?” Jim's jaw clenched as he tried to maintain his composure.`,
      metadata: { sectionTitle: "Chapter 10 (Alec - Present)" },
    },
    {
      id: "speaker-buzz",
      sourceId,
      sourceTitle,
      content: `Martin had spoken earlier. David's gaze remained fixed on me, his smirk never leaving his face. "You've earned my respect, Buzz," he said. I scowled at the nickname.`,
      metadata: { sectionTitle: "Chapter 10 (Alec - Present)" },
    },
    {
      id: "speaker-mister-aldrin",
      sourceId,
      sourceTitle,
      content: `"Nice accommodations you have here," I said dryly. David smiled. "Mr. Aldrin! What an honor to see you again!" He exclaimed. "Call me Dave, please." The guard remained outside.`,
      metadata: { sectionTitle: "Chapter 13 (Alec - Present)" },
    },
  ] satisfies IdentityChunk[];
  const attributions = characterAliasAttributions({
    canonicalName: "Alec Sumner",
    aliases: ["Sir Alec", "Buzz", "Mr. Aldrin"],
    // Deliberately omit David: a speaker's grammar, not a prior entity
    // classification, grounds attribution. The other names reproduce the
    // distractors that previously stole these quotations in a saved world.
    knownCharacterNames: ["Alec Sumner", "Jim Haskins", "Martin", "Raider Dave", "Dave"],
    chunks: evidence,
  });

  assert.deepEqual(
    attributions.map(({ alias, attributedBy, chunkId, sourceId: savedSourceId, sourceTitle: savedSourceTitle, chapterTitle }) => ({
      alias,
      attributedBy,
      chunkId,
      sourceId: savedSourceId,
      sourceTitle: savedSourceTitle,
      chapterTitle,
    })),
    [
      { alias: "Sir Alec", attributedBy: "David", chunkId: "speaker-sir-alec", sourceId, sourceTitle, chapterTitle: "Chapter 10 (Alec - Present)" },
      { alias: "Buzz", attributedBy: "David", chunkId: "speaker-buzz", sourceId, sourceTitle, chapterTitle: "Chapter 10 (Alec - Present)" },
      { alias: "Mr. Aldrin", attributedBy: "David", chunkId: "speaker-mister-aldrin", sourceId, sourceTitle, chapterTitle: "Chapter 13 (Alec - Present)" },
    ],
  );
  assert.deepEqual(attributions.map((entry) => entry.quote), evidence.map((entry) => entry.content));
  assert.match(attributions[0]?.quote ?? "", /David chuckled[\s\S]+Sir Alec/u);
  assert.match(attributions[1]?.quote ?? "", /David's gaze[\s\S]+Buzz/u);
  assert.match(attributions[2]?.quote ?? "", /David smiled[\s\S]+Mr\. Aldrin/u);
  assert.match(attributions[1]?.explanation ?? "", /uses this nickname/u);
  assert.match(attributions[2]?.explanation ?? "", /formal or teasing form of address/u);
  assert.doesNotMatch(
    `${attributions[1]?.explanation ?? ""} ${attributions[2]?.explanation ?? ""}`,
    /astronomy|reference or wordplay/iu,
  );
});

test("an alias receives reference wording only when its cited dialogue explicitly establishes it", () => {
  const [attribution] = characterAliasAttributions({
    canonicalName: "Mara Voss",
    aliases: ["Quixote"],
    knownCharacterNames: ["Mara Voss", "Elena"],
    chunks: [chunk(
      'Elena smiled. "Quixote, that is a literary reference to the novel." I scowled at the nickname.',
      "Chapter 6 (Mara - Present)",
    )],
  });
  assert.equal(attribution?.attributedBy, "Elena");
  assert.match(attribution?.explanation ?? "", /explicitly uses this as a reference or wordplay/u);
});

test("nickname discovery recognizes generic staged call-and-response wordplay", () => {
  assert.equal(nicknameAddressesPerspective({
    alias: "Sparrow",
    canonicalName: "Mara Voss",
    content: 'Elena waved. "Beacon to Sparrow. This is Harbor. Please respond." I laughed and shook my head.',
    metadata: { sectionTitle: "Chapter 6 (Mara - Present)" },
  }), true);
});

test("speaker attribution declines coordinated or ungrounded pronoun ambiguity", () => {
  const coordinated = characterAliasAttributions({
    canonicalName: "Alec Sumner",
    aliases: ["Sir Alec"],
    knownCharacterNames: ["Alec Sumner", "David", "Martin"],
    chunks: [chunk('David and Martin smiled. "Sir Alec, come over here."')],
  });
  assert.deepEqual(coordinated, []);

  const pronounOnly = characterAliasAttributions({
    canonicalName: "Alec Sumner",
    aliases: ["Buzz"],
    knownCharacterNames: ["Alec Sumner", "David", "Martin"],
    chunks: [chunk('The room fell silent. "You earned it, Buzz," he said. I scowled at the nickname.')],
  });
  assert.equal(pronounOnly.length, 1, "the cited nickname remains inspectable");
  assert.equal(pronounOnly[0]?.attributedBy, null, "an ungrounded pronoun must not invent a speaker");
});

test("a generic lowercase occurrence cannot hide a later explicit abbreviated vocative", () => {
  const attributions = characterAliasAttributions({
    canonicalName: "Lilly",
    aliases: ["Lil"],
    knownCharacterNames: ["Lilly", "Dave", "Kendall"],
    chunks: [chunk(
      `Dave shrugged. "That he ain't shared with lil' old me." ` +
      `Kendall studied me for a moment. Kendall said, "Lil, listen to me."`,
      "Chapter 8 - Fractures (Lilly - Present)",
    )],
  });
  assert.equal(attributions.length, 1);
  assert.equal(attributions[0]?.alias, "Lil");
  assert.equal(attributions[0]?.attributedBy, "Kendall");
  assert.match(attributions[0]?.quote ?? "", /Lil, listen to me/u);
});

test("legacy Little Alec metadata is repaired without turning Past into childhood", () => {
  const attribution = normalizeCharacterAliasAttribution({
    alias: "Little Alec",
    kind: "descriptive_reference",
    attributedBy: "Lilly",
    explanation: "Lilly uses this while reflecting on Alec Sumner as a child.",
    quote: "Lilly stepped behind me. Little Alec... I never thought of what you might be like as a kid.",
    chunkId: "chunk-1",
    sourceId: "source-1",
    sourceTitle: "Ashes of the Earth",
    chapterTitle: "Alec - Past",
    confidence: 0.94,
  });
  assert.equal(attribution?.temporalScope, "single_scene");
  assert.equal(attribution?.attributedBy, "Lilly");
  assert.match(attribution?.explanation ?? "", /not a child in this scene/u);
  assert.ok(attribution?.semanticLimits.some((limit) => /past-timeline chapters/u.test(limit)));
});

function identityEntity(input: Partial<ExplicitCharacterIdentityEntity> & Pick<ExplicitCharacterIdentityEntity, "id" | "name">): ExplicitCharacterIdentityEntity {
  return {
    aliases: [],
    entityType: "character",
    pullStatus: "active",
    scannerPresent: true,
    dossierId: `${input.id}-dossier`,
    mentionCount: 1,
    ...input,
  };
}

test("unattributed identity dialogue is not assigned to the chapter point-of-view character", () => {
  const entities = [
    identityEntity({ id: "alec", name: "Alec", mentionCount: 450 }),
    identityEntity({ id: "shanta", name: "Shanta", mentionCount: 30 }),
    identityEntity({ id: "vishtal", name: "Vishtal", entityType: "ambiguous", dossierId: null }),
    identityEntity({ id: "dave", name: "Dave", mentionCount: 60 }),
  ];
  const evidence = chunk(
    `The voices carried from beyond the wall. "I am Shanta." A pause followed. ` +
    `"I am Vishtal." Footsteps crossed the room. "I am Dave." ` +
    `Later, another voice insisted, "I am Shanta," someone said.`,
    "Chapter 12 (Alec - Present)",
  );
  assert.deepEqual(resolveExplicitCharacterIdentities({ entities, chunks: [evidence] }), []);
});

test("an explicit first-person speech tag can ground a point-of-view self-identity", () => {
  const entities = [
    identityEntity({ id: "alec", name: "Alec", mentionCount: 450 }),
    identityEntity({ id: "prometheus", name: "Prometheus", entityType: "ambiguous", dossierId: null }),
  ];
  const evidence = chunk('"Call me Prometheus," I said.', "Chapter 7 (Alec - Past)");
  const [resolution] = resolveExplicitCharacterIdentities({ entities, chunks: [evidence] });
  assert.equal(resolution?.survivorId, "alec");
  assert.deepEqual(resolution?.memberIds, ["alec", "prometheus"]);
});

test("a named self-naming quote plus unique POV continuity bridges a familiar-name split", () => {
  const entities = [
    identityEntity({ id: "david", name: "David", mentionCount: 87 }),
    identityEntity({ id: "raider-dave", name: "Raider Dave", aliases: ["Dave"], mentionCount: 60 }),
    identityEntity({ id: "alec", name: "Alec Sumner", aliases: ["Mr. Aldrin"], mentionCount: 450 }),
  ];
  const declaration = chunk(
    'David smiled. "Mr. Aldrin! What an honor to see you again!" He exclaimed. "Call me Dave, please."',
    "Chapter 3 (Alec - Present)",
  );
  const povContinuity = chunk(
    "I checked the perimeter before the others woke.",
    "Chapter 9 (Raider Dave - Present)",
  );
  const ordinaryPrepositions = chunk(
    "The crowd filled the space, its anger directed towards David. Later, a message arrived from Dave.",
    "Chapter 4 (Alec - Present)",
  );
  const [resolution] = resolveExplicitCharacterIdentities({
    entities,
    chunks: [declaration, povContinuity, ordinaryPrepositions],
  });
  assert.equal(resolution?.survivorId, "david");
  assert.deepEqual(resolution?.memberIds, ["david", "raider-dave"]);
  assert.ok(resolution?.aliases.includes("Dave"));
  assert.ok(resolution?.aliases.includes("Raider Dave"));
  assert.match(
    resolution?.attributions.find((entry) => entry.alias === "Dave")?.quote ?? "",
    /call me Dave/iu,
  );

  assert.deepEqual(resolveExplicitCharacterIdentities({
    entities,
    chunks: [declaration],
  }), [], "an action tag and familiar name alone are insufficient without POV continuity");
});

test("generated non-person taxonomy rows fold an evidence-backed regular plural without fuzzy merging", () => {
  const generated = {
    pullStatus: "active",
    scannerPresent: true,
    classificationSource: "local",
    reviewStatus: "candidate",
  };
  const [resolution] = resolveGeneratedTaxonomyPluralIdentities({
    entities: [{
      ...generated,
      id: "prowler",
      name: "Prowler",
      entityType: "creature",
      dossierId: "prowler-dossier",
      mentionCount: 24,
      evidence: [{ quote: "The Prowler hissed and raised its claws before lunging." }],
    }, {
      ...generated,
      id: "prowlers",
      name: "Prowlers",
      entityType: "creature",
      mentionCount: 12,
      evidence: [{ quote: "Prowlers were vicious killing machines, Turned canines bred for the hunt." }],
    }],
  });
  assert.equal(resolution?.survivorId, "prowler");
  assert.deepEqual(resolution?.memberIds, ["prowler", "prowlers"]);
  assert.deepEqual(resolution?.aliases, ["Prowlers"]);

  const [pluralHeavy] = resolveGeneratedTaxonomyPluralIdentities({
    entities: [{
      ...generated,
      id: "silencer",
      name: "Silencer",
      entityType: "creature",
      mentionCount: 2,
      evidence: [{ quote: "A Silencer creature unfolded its wings and hissed." }],
    }, {
      ...generated,
      id: "silencers",
      name: "Silencers",
      entityType: "creature",
      dossierId: "plural-dossier",
      mentionCount: 90,
      evidence: [{ quote: "Silencers are a winged subspecies that hunts by sound." }],
    }],
  });
  assert.equal(pluralHeavy?.survivorId, "silencer", "the singular lore concept stays canonical even when the plural owns the old dossier and most mentions");
  assert.deepEqual(pluralHeavy?.aliases, ["Silencers"]);

  assert.deepEqual(resolveGeneratedTaxonomyPluralIdentities({
    entities: [{
      ...generated,
      id: "person-singular",
      name: "Walker",
      entityType: "character",
      evidence: [{ quote: "Walker hissed through his teeth." }],
    }, {
      ...generated,
      id: "person-plural",
      name: "Walkers",
      entityType: "character",
      evidence: [{ quote: "The Walkers were a family." }],
    }],
  }), [], "person names are never merged by plural morphology");

  assert.deepEqual(resolveGeneratedTaxonomyPluralIdentities({
    entities: [{
      ...generated,
      id: "ares",
      name: "Are",
      entityType: "species",
      evidence: [{ quote: "The word Are appeared on the plaque." }],
    }, {
      ...generated,
      id: "ares-plural",
      name: "Ares",
      entityType: "species",
      evidence: [{ quote: "Ares was printed in another chapter." }],
    }],
  }), [], "regular spelling alone is insufficient without taxonomy evidence for both rows");
});

test("generated identity repair never copies or suppresses protected source or target rows", async () => {
  const generatedTarget: Record<string, unknown> = {
    id: "alec-entity",
    dossier_id: "alec-dossier",
    name: "Alec",
    aliases: [],
    alias_attributions: [],
    entity_type: "character",
    pull_status: "active",
    scanner_present: true,
    classification_source: "local",
    review_status: "candidate",
    mention_count: 100,
    mention_source_count: 1,
    evidence: [],
    details: [],
    summary: "Alec leads the survivors.",
    user_edited_at: null,
  };
  const protectedRows: Record<string, unknown>[] = [{
    id: "owner-surname-entity",
    dossier_id: "owner-surname-dossier",
    name: "Sumner",
    aliases: [],
    entity_type: "ambiguous",
    pull_status: "active",
    scanner_present: true,
    classification_source: "user",
    review_status: "user_confirmed",
    mention_count: 8,
    mention_source_count: 1,
    evidence: [],
    details: [],
    summary: "Owner record.",
    user_edited_at: null,
  }, {
    id: "confirmed-buzz-entity",
    dossier_id: "confirmed-buzz-dossier",
    name: "Buzz",
    aliases: [],
    entity_type: "ambiguous",
    pull_status: "active",
    scanner_present: true,
    classification_source: "local",
    review_status: "user_confirmed",
    mention_count: 7,
    mention_source_count: 1,
    evidence: [],
    details: [],
    summary: "Confirmed separate record.",
    user_edited_at: null,
  }, {
    id: "withheld-sir-entity",
    dossier_id: "withheld-sir-dossier",
    name: "Sir Alec",
    aliases: [],
    entity_type: "ambiguous",
    pull_status: "do_not_pull",
    scanner_present: true,
    classification_source: "local",
    review_status: "candidate",
    mention_count: 6,
    mention_source_count: 1,
    evidence: [],
    details: [],
    summary: "Owner withheld record.",
    user_edited_at: null,
  }, {
    id: "owner-target-entity",
    dossier_id: "owner-target-dossier",
    name: "Owner Hero",
    aliases: [],
    entity_type: "character",
    pull_status: "active",
    scanner_present: true,
    classification_source: "user",
    review_status: "user_confirmed",
    mention_count: 50,
    mention_source_count: 1,
    evidence: [],
    details: [],
    summary: "Customer-authored character.",
    user_edited_at: "2026-08-27T00:00:00.000Z",
  }];
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT entity.*, dossier.user_edited_at")) {
        return { rows: [generatedTarget, ...protectedRows] };
      }
      if (sql.includes("SELECT chunk.id, chunk.source_id, source.title AS source_title")) {
        return { rows: [{
          id: "formal",
          source_id: "book",
          source_title: "Novel",
          content: 'David studied me. "Your nights seem consistently lengthy, Mr. Sumner. You should rest."',
          metadata: { sectionTitle: "Chapter 4 (Alec - Present)" },
        }, {
          id: "buzz",
          source_id: "book",
          source_title: "Novel",
          content: 'David said, "Buzz, look at me." I scowled at the nickname.',
          metadata: { sectionTitle: "Chapter 5 (Alec - Present)" },
        }, {
          id: "sir",
          source_id: "book",
          source_title: "Novel",
          content: 'David said, "Sir Alec, come here."',
          metadata: { sectionTitle: "Chapter 6 (Alec - Present)" },
        }] };
      }
      if (sql.includes("WITH eligible AS") && params[0] === "alec-entity") {
        return { rows: [{ id: "alec-entity" }] };
      }
      return { rows: [] };
    },
  };
  const result = await repairGeneratedCharacterIdentities({
    db: db as never,
    worldId: "world",
    editionId: "edition",
    targetCharacterNames: ["Alec"],
  });
  assert.equal(result.merged, 0);
  assert.equal(generatedTarget.name, "Alec Sumner", "manuscript evidence may still improve the generated target");
  assert.ok(result.targetIdentitySurfaces.includes("Alec"));
  assert.ok(result.targetIdentitySurfaces.includes("Alec Sumner"),
    "the requested identity remains targeted after its canonical name is repaired");
  assert.equal((generatedTarget.aliases as string[]).includes("Sumner"), false);
  assert.equal((generatedTarget.aliases as string[]).includes("Buzz"), false);
  assert.equal((generatedTarget.aliases as string[]).includes("Sir Alec"), false);
  const protectedIds = new Set(protectedRows.flatMap((row) => [String(row.id), String(row.dossier_id)]));
  const mutatingProtectedCalls = calls.filter((call) =>
    /^\s*(?:UPDATE|DELETE|INSERT)\b/iu.test(call.sql) &&
    call.params.some((value) => protectedIds.has(String(value)))
  );
  assert.deepEqual(mutatingProtectedCalls, [], "protected entity and dossier IDs never reach a mutating statement");
});

test("persisted taxonomy repair transfers a plural-owned dossier and counts to the singular canonical row", async () => {
  const singular: Record<string, unknown> = {
    id: "silencer",
    dossier_id: null,
    name: "Silencer",
    aliases: [],
    entity_type: "creature",
    pull_status: "active",
    scanner_present: true,
    classification_source: "local",
    review_status: "candidate",
    mention_count: 2,
    mention_source_count: 1,
    evidence: [{ quote: "A Silencer creature unfolded its wings and hissed." }],
    details: [],
    summary: "",
    user_edited_at: null,
  };
  const plural: Record<string, unknown> = {
    id: "silencers",
    dossier_id: "plural-dossier",
    name: "Silencers",
    aliases: [],
    entity_type: "creature",
    pull_status: "active",
    scanner_present: true,
    classification_source: "local",
    review_status: "candidate",
    mention_count: 90,
    mention_source_count: 2,
    evidence: [{ quote: "Silencers are a winged subspecies that hunts by sound." }],
    details: ["Winged subspecies"],
    summary: "Silencers are winged hunters.",
    user_edited_at: null,
  };
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql.includes("SELECT entity.*, dossier.user_edited_at")) return { rows: [singular, plural] };
      if (sql.includes("eligible AS")) return { rows: [{ source_entity_id: String(params[0]) }] };
      return { rows: [] };
    },
  };
  const result = await repairGeneratedCharacterIdentities({
    db: db as never,
    worldId: "world",
    editionId: "edition",
  });
  assert.equal(result.merged, 1);
  assert.equal(singular.dossier_id, "plural-dossier");
  assert.equal(plural.pull_status, "merged");
  const entityMerge = calls.find((call) =>
    /eligible AS/iu.test(call.sql) && call.params[0] === "silencers"
  );
  assert.match(entityMerge?.sql ?? "", /dossier_id = COALESCE\(target\.dossier_id, source\.dossier_id\)/iu);
  assert.match(entityMerge?.sql ?? "", /mention_count = target\.mention_count \+ source\.mention_count/iu);
  assert.equal(entityMerge?.params[6], null);
  assert.equal(entityMerge?.params[7], "plural-dossier");
  assert.match(entityMerge?.sql ?? "", /WHERE \$7::uuid IS NULL AND dossier\.id = \$8::uuid/iu);
  assert.match(entityMerge?.sql ?? "", /WHERE dossier\.id = \$8::uuid AND \$7::uuid IS NOT NULL/iu);
});

test("presentation attributions survive the identity merge that immediately follows", async () => {
  const base = {
    aliases: [], alias_attributions: [], entity_type: "character", pull_status: "active",
    scanner_present: true, classification_source: "local", review_status: "candidate",
    mention_source_count: 1, evidence: [], details: [], user_edited_at: null,
    dossier_profile: {}, dossier_axis_estimate: {}, dossier_alias_attributions: [],
  };
  const david = { ...base, id: "david", dossier_id: "david-dossier", name: "David", mention_count: 87 };
  const dave = { ...base, id: "dave", dossier_id: "dave-dossier", name: "Raider Dave", aliases: ["Dave"], mention_count: 60 };
  const mergeParams: unknown[][] = [];
  const db = { async query(sql: string, params: unknown[] = []) {
    if (sql.includes("SELECT entity.*, dossier.user_edited_at")) return { rows: [david, dave] };
    if (sql.includes("SELECT chunk.id, chunk.source_id")) return { rows: [{
      id: "self-name", source_id: "book", source_title: "Novel",
      content: 'David smiled. "Call me Dave, please," he said.',
      metadata: { sectionTitle: "Chapter 8 (David - Present)" },
    }, {
      id: "pov", source_id: "book", source_title: "Novel",
      content: "I watched the gate while the others slept.",
      metadata: { sectionTitle: "Chapter 9 (Raider Dave - Present)" },
    }] };
    if (sql.startsWith("WITH eligible AS")) return { rows: [{ id: String(params[0]) }] };
    if (sql.startsWith("WITH locked_dossiers AS")) {
      mergeParams.push(params);
      return { rows: [{ source_entity_id: String(params[0]) }] };
    }
    return { rows: [] };
  } };
  await repairGeneratedCharacterIdentities({ db: db as never, worldId: "world", editionId: "edition" });
  assert.equal(mergeParams.length, 1);
  const persisted = JSON.parse(String(mergeParams[0]?.[3])) as Array<Record<string, unknown>>;
  const attribution = persisted.find((entry) => entry.alias === "Dave");
  assert.equal(attribution?.attributedBy, "David");
  assert.match(String(attribution?.quote), /Call me Dave/u);
});

test("targeted deep discovery still applies whole-world explicit identity merges without scanning non-target nicknames", async () => {
  const base = {
    aliases: [], alias_attributions: [], pull_status: "active", scanner_present: true,
    classification_source: "local", review_status: "candidate", mention_source_count: 1,
    evidence: [], details: [], summary: "", user_edited_at: null,
    dossier_axis_user_changed_at: null, dossier_axis_user_override: null,
    dossier_profile: {}, dossier_axis_estimate: {}, dossier_alias_attributions: [],
  };
  const alec = {
    ...base, id: "alec", dossier_id: "alec-dossier", name: "Alec",
    entity_type: "character", mention_count: 100,
  };
  const buzz = {
    ...base, id: "buzz", dossier_id: null, name: "Buzz",
    entity_type: "ambiguous", mention_count: 2,
  };
  const david = {
    ...base, id: "david", dossier_id: "david-dossier", name: "David",
    entity_type: "character", mention_count: 87,
  };
  const raiderDave = {
    ...base, id: "raider-dave", dossier_id: "raider-dave-dossier", name: "Raider Dave",
    aliases: ["Dave"], entity_type: "character", mention_count: 60,
  };
  const captainDave = {
    ...base, id: "captain-dave", dossier_id: null, name: "Captain Dave",
    entity_type: "title", mention_count: 1,
  };
  const rows = [alec, buzz, david, raiderDave, captainDave];
  const presentationCalls: unknown[][] = [];
  const mergeCalls: unknown[][] = [];
  const db = { async query(sql: string, params: unknown[] = []) {
    if (sql.includes("SELECT entity.*, dossier.user_edited_at")) return { rows };
    if (sql.includes("SELECT chunk.id, chunk.source_id, source.title AS source_title")) {
      return { rows: [{
        id: "dave-reveal", source_id: "book", source_title: "Novel",
        content: "David smiled. “Call me Dave, please,” he said.",
        metadata: { sectionTitle: "Chapter 1 (David - Present)" },
      }, {
        id: "alec-nickname", source_id: "book", source_title: "Novel",
        content: "David said, “Buzz, look at me.” I scowled at the nickname.",
        metadata: { sectionTitle: "Chapter 2 (Alec - Present)" },
      }, {
        id: "david-nickname", source_id: "book", source_title: "Novel",
        content: "Martin said, “Captain Dave, look at me.” I scowled at the nickname.",
        metadata: { sectionTitle: "Chapter 3 (David - Present)" },
      }] };
    }
    if (sql.includes("WITH eligible AS")) {
      presentationCalls.push(params);
      return { rows: [{ id: String(params[0]) }] };
    }
    if (sql.includes("WITH locked_dossiers AS")) {
      mergeCalls.push(params);
      return { rows: [{ source_entity_id: String(params[0]) }] };
    }
    return { rows: [] };
  } };

  const result = await repairGeneratedCharacterIdentities({
    db: db as never,
    worldId: "world",
    editionId: "edition",
    targetCharacterNames: ["Alec"],
  });

  assert.deepEqual(
    mergeCalls.map((params) => [String(params[0]), String(params[1])]).sort(),
    [["buzz", "alec"], ["raider-dave", "david"]],
  );
  assert.deepEqual(
    presentationCalls.map((params) => String(params[0])).sort(),
    ["alec", "david"],
  );
  const alecPresentation = presentationCalls.find((params) => params[0] === "alec");
  const davidPresentation = presentationCalls.find((params) => params[0] === "david");
  assert.ok((JSON.parse(String(alecPresentation?.[4])) as string[]).includes("Buzz"));
  const davidAliases = JSON.parse(String(davidPresentation?.[4])) as string[];
  assert.ok(davidAliases.includes("Dave"));
  assert.ok(davidAliases.includes("Raider Dave"));
  const davidAttributions = JSON.parse(String(davidPresentation?.[5])) as Array<Record<string, unknown>>;
  const daveAttribution = davidAttributions.find((entry) => entry.alias === "Dave");
  assert.equal(daveAttribution?.attributedBy, "David");
  assert.match(String(daveAttribution?.quote), /Call me Dave/u);
  assert.equal(result.merged, 2);
  assert.equal(captainDave.pull_status, "active");
  assert.ok(!mergeCalls.some((params) => params.some((value) => value === "captain-dave")));
});

test("a targeted merged-member surface follows the surviving canonical identity", async () => {
  const base = {
    alias_attributions: [], pull_status: "active", scanner_present: true,
    classification_source: "local", review_status: "candidate", mention_source_count: 1,
    evidence: [], details: [], summary: "", user_edited_at: null,
    dossier_axis_user_changed_at: null, dossier_axis_user_override: null,
    dossier_profile: {}, dossier_axis_estimate: {}, dossier_alias_attributions: [],
  };
  const david = {
    ...base, id: "david", dossier_id: "david-dossier", name: "David", aliases: [],
    entity_type: "character", mention_count: 87,
  };
  const raiderDave = {
    ...base, id: "raider-dave", dossier_id: "raider-dave-dossier", name: "Raider Dave",
    aliases: ["Dave"], entity_type: "character", mention_count: 60,
  };
  const mergeCalls: unknown[][] = [];
  const db = { async query(sql: string, params: unknown[] = []) {
    if (sql.includes("SELECT entity.*, dossier.user_edited_at")) return { rows: [david, raiderDave] };
    if (sql.includes("SELECT chunk.id, chunk.source_id, source.title AS source_title")) {
      return { rows: [{
        id: "self-name", source_id: "book", source_title: "Novel",
        content: 'David smiled. "Call me Dave, please," he said.',
        metadata: { sectionTitle: "Chapter 8 (David - Present)" },
      }, {
        id: "raider-pov", source_id: "book", source_title: "Novel",
        content: "I watched the gate while the others slept.",
        metadata: { sectionTitle: "Chapter 9 (Raider Dave - Present)" },
      }] };
    }
    if (sql.includes("WITH eligible AS")) return { rows: [{ id: String(params[0]) }] };
    if (sql.includes("WITH locked_dossiers AS")) {
      mergeCalls.push(params);
      return { rows: [{ source_entity_id: String(params[0]) }] };
    }
    return { rows: [] };
  } };

  const result = await repairGeneratedCharacterIdentities({
    db: db as never,
    worldId: "world",
    editionId: "edition",
    targetCharacterNames: ["Raider Dave"],
  });

  assert.equal(result.merged, 1);
  assert.deepEqual(
    mergeCalls.map((params) => [String(params[0]), String(params[1])]),
    [["raider-dave", "david"]],
  );
  assert.ok(result.targetIdentitySurfaces.includes("Raider Dave"));
  assert.ok(result.targetIdentitySurfaces.includes("Dave"));
  assert.ok(result.targetIdentitySurfaces.includes("David"),
    "the merged member request must select the surviving dossier");
});

test("generated identity merge is one atomic retry-safe claim", async () => {
  let attempt = 0;
  let sourceActive = true;
  let targetMentions = 10;
  const db = {
    async query(sql: string, params: unknown[] = []) {
      assert.match(sql, /^WITH (?:locked_dossiers AS[\s\S]+?, )?eligible AS/iu);
      attempt += 1;
      if (attempt === 1) throw new Error("injected database failure");
      if (!sourceActive) return { rows: [] };
      sourceActive = false;
      targetMentions += 5;
      return { rows: [{ source_entity_id: String(params[0]) }] };
    },
  };
  const source = {
    id: "source", dossier_id: "source-dossier", name: "Dave", aliases: [],
    dossier_profile: { secrets: ["Source-only fact"] }, dossier_axis_estimate: {},
  };
  const target = {
    id: "target", dossier_id: "target-dossier", name: "David", aliases: ["Dave"],
    dossier_profile: { traits: ["Watchful"] }, dossier_axis_estimate: {},
  };
  await assert.rejects(() => mergeGeneratedIdentityRowsAtomic({
    db: db as never, source, target, aliases: ["Dave"],
  }), /injected database failure/u);
  assert.equal(sourceActive, true);
  assert.equal(targetMentions, 10, "a failed statement commits none of the merge");
  assert.equal(await mergeGeneratedIdentityRowsAtomic({
    db: db as never, source, target, aliases: ["Dave"],
  }), true);
  assert.equal(targetMentions, 15);
  assert.equal(await mergeGeneratedIdentityRowsAtomic({
    db: db as never, source, target, aliases: ["Dave"],
  }), false);
  assert.equal(targetMentions, 15, "retrying after the source was claimed cannot double counts or evidence");
});

test("both-populated character and creature dossiers retain structured facts before source suppression", async () => {
  const targetProfile = {
    traits: ["Protective"],
    powers: ["Transformation"],
    relationshipWeb: [{ name: "Lilly", relationship: "Partner", evidence: ["target-evidence"] }],
    estimatedStats: {
      Strength: { score: 14, confidence: 0.8, rationale: "Target", evidence: ["target-stat"] },
    },
  };
  const sourceProfile = {
    traits: ["Protective", "Defiant"],
    secrets: ["Source-only secret"],
    relationshipWeb: [{ name: "Lilly", relationship: "Partner", evidence: ["source-evidence"] }, {
      name: "Allie", relationship: "Parent", evidence: ["source-parent"] },
    ],
    estimatedStats: {
      Strength: { score: 9, confidence: 0.4, rationale: "Weaker source", evidence: ["source-stat"] },
      Perception: { score: 16, confidence: 0.9, rationale: "Source", evidence: ["source-perception"] },
    },
  };
  const merged = mergeGeneratedIdentityProfiles(targetProfile, sourceProfile);
  assert.deepEqual(merged.traits, ["Protective", "Defiant"]);
  assert.deepEqual(merged.secrets, ["Source-only secret"]);
  const web = merged.relationshipWeb as Array<Record<string, unknown>>;
  assert.equal(web.length, 2);
  assert.deepEqual(web[0]?.evidence, ["target-evidence", "source-evidence"]);
  const stats = merged.estimatedStats as Record<string, Record<string, unknown>>;
  assert.equal(stats.Strength?.score, 14);
  assert.deepEqual(stats.Strength?.evidence, ["target-stat", "source-stat"]);
  assert.equal(stats.Perception?.score, 16);

  const persistedProfiles: Record<string, unknown>[] = [];
  const persistedRoles: string[] = [];
  const persistedSql: string[] = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      persistedProfiles.push(JSON.parse(String(params[4])) as Record<string, unknown>);
      persistedRoles.push(String(params[8]));
      persistedSql.push(sql);
      return { rows: [{ source_entity_id: String(params[0]) }] };
    },
  };
  for (const [targetName, sourceName] of [["David", "Raider Dave"], ["Prowler", "Prowlers"]]) {
    assert.equal(await mergeGeneratedIdentityRowsAtomic({
      db: db as never,
      target: {
        id: `${targetName}-target`, dossier_id: `${targetName}-dossier`, name: targetName,
        dossier_profile: targetProfile, dossier_role: "Supporting Character", dossier_axis_estimate: { confidence: 0.7, label: "Target axis" },
      },
      source: {
        id: `${sourceName}-source`, dossier_id: `${sourceName}-dossier`, name: sourceName,
        dossier_profile: sourceProfile, dossier_role: "Point-of-View Character", dossier_axis_estimate: { confidence: 0.9, label: "Source axis" },
      },
      aliases: [sourceName],
    }), true);
  }
  assert.equal(persistedProfiles.length, 2);
  assert.deepEqual(persistedRoles, ["Point-of-View Character", "Point-of-View Character"]);
  assert.ok(persistedSql.every((sql) => /count\(DISTINCT COALESCE\(item->>'sourceId'/u.test(sql)),
    "overlapping manuscript evidence is counted as a distinct source union, not summed");
  for (const profile of persistedProfiles) {
    assert.deepEqual(profile.traits, ["Protective", "Defiant"]);
    assert.deepEqual(profile.secrets, ["Source-only secret"]);
    assert.equal((profile.estimatedStats as Record<string, Record<string, unknown>>).Perception?.score, 16);
  }
});

test("atomic identity merge executes once against the persisted schema shape", async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.character_dossiers (
      id uuid PRIMARY KEY, name text NOT NULL, normalized_name text NOT NULL,
      aliases jsonb NOT NULL DEFAULT '[]', alias_attributions jsonb NOT NULL DEFAULT '[]',
      mention_count integer NOT NULL DEFAULT 0, mention_source_count integer NOT NULL DEFAULT 0,
      role text NOT NULL DEFAULT '',
      summary text NOT NULL DEFAULT '', profile jsonb NOT NULL DEFAULT '{}', evidence jsonb NOT NULL DEFAULT '[]',
      confidence real NOT NULL DEFAULT 0, axis_estimate jsonb NOT NULL DEFAULT '{}',
      axis_user_override jsonb, axis_user_changed_at timestamptz, user_edited_at timestamptz,
      dossier_status text NOT NULL DEFAULT 'active', updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE storyhold.world_entities (
      id uuid PRIMARY KEY, name text NOT NULL, normalized_name text NOT NULL,
      aliases jsonb NOT NULL DEFAULT '[]', alias_attributions jsonb NOT NULL DEFAULT '[]', dossier_id uuid,
      mention_count integer NOT NULL DEFAULT 0, mention_source_count integer NOT NULL DEFAULT 0,
      summary text NOT NULL DEFAULT '', evidence jsonb NOT NULL DEFAULT '[]', details jsonb NOT NULL DEFAULT '[]',
      pull_status text NOT NULL DEFAULT 'active', scanner_present boolean NOT NULL DEFAULT true,
      merged_into_entity_id uuid, classification_source text NOT NULL DEFAULT 'local',
      review_status text NOT NULL DEFAULT 'candidate', updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE storyhold.character_dossier_source_contributions (
      id uuid PRIMARY KEY, dossier_id uuid NOT NULL, source_id uuid NOT NULL,
      world_id uuid NOT NULL, canon_edition_id uuid NOT NULL, last_analysis_run_id uuid,
      aliases jsonb NOT NULL DEFAULT '[]', role text NOT NULL DEFAULT '', summary text NOT NULL DEFAULT '',
      profile jsonb NOT NULL DEFAULT '{}', evidence jsonb NOT NULL DEFAULT '[]', confidence real NOT NULL DEFAULT 0,
      axis_estimate jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (dossier_id, source_id)
    );
  `);
  const targetId = "00000000-0000-4000-8000-000000000201";
  const sourceId = "00000000-0000-4000-8000-000000000202";
  const targetDossierId = "00000000-0000-4000-8000-000000000203";
  const sourceDossierId = "00000000-0000-4000-8000-000000000204";
  await db.query(
    `INSERT INTO storyhold.character_dossiers
       (id, name, normalized_name, mention_count, mention_source_count, profile, evidence)
     VALUES ($1, 'David', 'david', 10, 5, $2::jsonb, '[{"quote":"target","sourceId":"book-a"}]'),
            ($3, 'Raider Dave', 'raider dave', 5, 3, $4::jsonb, '[{"quote":"source","sourceId":"book-b"}]')`,
    [targetDossierId, jsonForTest({ traits: ["Watchful"] }), sourceDossierId, jsonForTest({ secrets: ["Hidden history"] })],
  );
  await db.query(
    `INSERT INTO storyhold.world_entities
       (id, name, normalized_name, dossier_id, mention_count, mention_source_count, evidence)
     VALUES ($1, 'David', 'david', $2, 10, 5, '[{"quote":"target","sourceId":"book-a"}]'),
            ($3, 'Raider Dave', 'raider dave', $4, 5, 3, '[{"quote":"source","sourceId":"book-b"}]')`,
    [targetId, targetDossierId, sourceId, sourceDossierId],
  );
  await db.query(
    "UPDATE storyhold.character_dossiers SET dossier_status = 'suppressed' WHERE id = $1",
    [targetDossierId],
  );
  const source = {
    id: sourceId, name: "Raider Dave", dossier_id: sourceDossierId,
    dossier_profile: { secrets: ["Hidden history"] }, dossier_axis_estimate: {},
  };
  const target = {
    id: targetId, name: "David", dossier_id: targetDossierId,
    dossier_profile: { traits: ["Watchful"] }, dossier_axis_estimate: {},
  };
  assert.equal(await mergeGeneratedIdentityRowsAtomic({ db, source, target, aliases: ["Dave", "Raider Dave"] }), true);
  assert.equal(await mergeGeneratedIdentityRowsAtomic({ db, source, target, aliases: ["Dave", "Raider Dave"] }), false);
  const [entity, dossier, retiredDossier] = await Promise.all([
    db.query<Record<string, unknown>>(`SELECT * FROM storyhold.world_entities WHERE id = $1`, [targetId]),
    db.query<Record<string, unknown>>(`SELECT * FROM storyhold.character_dossiers WHERE id = $1`, [targetDossierId]),
    db.query<Record<string, unknown>>(`SELECT * FROM storyhold.character_dossiers WHERE id = $1`, [sourceDossierId]),
  ]);
  assert.equal(entity.rows[0]?.mention_count, 15);
  assert.equal(entity.rows[0]?.mention_source_count, 5);
  assert.deepEqual((dossier.rows[0]?.profile as Record<string, unknown>).traits, ["Watchful"]);
  assert.deepEqual((dossier.rows[0]?.profile as Record<string, unknown>).secrets, ["Hidden history"]);
  assert.equal(dossier.rows[0]?.mention_count, 15);
  assert.equal(dossier.rows[0]?.dossier_status, "active",
    "the surviving visible entity's generated dossier is restored after an atomic merge");
  assert.equal(dossier.rows[0]?.mention_source_count, 5,
    "capped representative evidence cannot lower an established source count");
  assert.equal(retiredDossier.rows[0]?.dossier_status, "suppressed");

  const unionTargetId = "00000000-0000-4000-8000-000000000209";
  const unionSourceId = "00000000-0000-4000-8000-000000000210";
  const unionTargetDossierId = "00000000-0000-4000-8000-000000000211";
  const unionSourceDossierId = "00000000-0000-4000-8000-000000000212";
  await db.query(`INSERT INTO storyhold.character_dossiers
    (id,name,normalized_name,mention_source_count,evidence) VALUES
    ($1,'One','one',1,'[{"sourceId":"a"},{"sourceId":"b"}]'),
    ($2,'Two','two',1,'[{"sourceId":"b"},{"sourceId":"c"}]')`, [unionTargetDossierId, unionSourceDossierId]);
  await db.query(`INSERT INTO storyhold.world_entities
    (id,name,normalized_name,dossier_id,mention_source_count,evidence) VALUES
    ($1,'One','one',$2,1,'[{"sourceId":"a"},{"sourceId":"b"}]'),
    ($3,'Two','two',$4,1,'[{"sourceId":"b"},{"sourceId":"c"}]')`,
  [unionTargetId, unionTargetDossierId, unionSourceId, unionSourceDossierId]);
  assert.equal(await mergeGeneratedIdentityRowsAtomic({ db,
    target: { id: unionTargetId, name: "One", dossier_id: unionTargetDossierId, dossier_profile: {}, dossier_axis_estimate: {} },
    source: { id: unionSourceId, name: "Two", dossier_id: unionSourceDossierId, dossier_profile: {}, dossier_axis_estimate: {} },
    aliases: ["Two"],
  }), true);
  assert.equal((await db.query<{ mention_source_count: number }>(
    `SELECT mention_source_count FROM storyhold.character_dossiers WHERE id = $1`, [unionTargetDossierId],
  )).rows[0]?.mention_source_count, 3, "a larger disjoint observed union raises the source count");

  await db.query(`UPDATE storyhold.world_entities SET pull_status = 'do_not_pull' WHERE id = $1`, [targetId]);
  assert.equal(await updateGeneratedIdentityPresentationAtomic({
    db,
    entityId: targetId,
    dossierId: targetDossierId,
    name: "Changed After Stale Read",
    aliases: ["Changed"],
    attributions: [],
  }), false, "the locked boundary rechecks a pull decision made after the caller's read");
  assert.equal((await db.query<{ name: string }>(`SELECT name FROM storyhold.world_entities WHERE id = $1`, [targetId])).rows[0]?.name, "David");

  await db.query(`UPDATE storyhold.world_entities SET pull_status = 'active' WHERE id = $1`, [targetId]);
  await db.query(`UPDATE storyhold.character_dossiers SET user_edited_at = now() WHERE id = $1`, [targetDossierId]);
  assert.equal(await updateGeneratedIdentityPresentationAtomic({
    db,
    entityId: targetId,
    dossierId: targetDossierId,
    name: "Changed After Customer Edit",
    aliases: ["Changed"],
    attributions: [],
  }), false, "the locked boundary rechecks a dossier edit made after the caller's read");
  assert.equal((await db.query<{ name: string }>(`SELECT name FROM storyhold.world_entities WHERE id = $1`, [targetId])).rows[0]?.name, "David");

  const lateTargetId = "00000000-0000-4000-8000-000000000205";
  const lateSourceId = "00000000-0000-4000-8000-000000000206";
  const lateTargetDossierId = "00000000-0000-4000-8000-000000000207";
  const lateSourceDossierId = "00000000-0000-4000-8000-000000000208";
  await db.query(
    `INSERT INTO storyhold.character_dossiers (id, name, normalized_name, mention_count)
     VALUES ($1, 'Target', 'target', 3), ($2, 'Source', 'source', 4)`,
    [lateTargetDossierId, lateSourceDossierId],
  );
  await db.query(
    `INSERT INTO storyhold.world_entities (id, name, normalized_name, dossier_id, mention_count)
     VALUES ($1, 'Target', 'target', $2, 3), ($3, 'Source', 'source', $4, 4)`,
    [lateTargetId, lateTargetDossierId, lateSourceId, lateSourceDossierId],
  );
  const lateSource = { id: lateSourceId, name: "Source", dossier_id: lateSourceDossierId, dossier_profile: {}, dossier_axis_estimate: {} };
  const lateTarget = { id: lateTargetId, name: "Target", dossier_id: lateTargetDossierId, dossier_profile: {}, dossier_axis_estimate: {} };
  await db.query(`UPDATE storyhold.character_dossiers SET user_edited_at = now() WHERE id = $1`, [lateSourceDossierId]);
  assert.equal(await mergeGeneratedIdentityRowsAtomic({ db, source: lateSource, target: lateTarget, aliases: ["Source"] }), false);
  assert.equal((await db.query<{ mention_count: number }>(`SELECT mention_count FROM storyhold.world_entities WHERE id = $1`, [lateTargetId])).rows[0]?.mention_count, 3);
  assert.equal((await db.query<{ pull_status: string }>(`SELECT pull_status FROM storyhold.world_entities WHERE id = $1`, [lateSourceId])).rows[0]?.pull_status, "active");
});

test("source-only dossier transfer stays synchronized and respects persisted ownership", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA storyhold;
      CREATE TABLE storyhold.character_dossiers (
        id uuid PRIMARY KEY, name text NOT NULL, normalized_name text NOT NULL,
        aliases jsonb NOT NULL DEFAULT '[]', alias_attributions jsonb NOT NULL DEFAULT '[]',
        mention_count integer NOT NULL DEFAULT 0, mention_source_count integer NOT NULL DEFAULT 0,
        role text NOT NULL DEFAULT '', summary text NOT NULL DEFAULT '',
        profile jsonb NOT NULL DEFAULT '{}', evidence jsonb NOT NULL DEFAULT '[]',
        confidence real NOT NULL DEFAULT 0, axis_estimate jsonb NOT NULL DEFAULT '{}',
        axis_user_override jsonb, axis_user_changed_at timestamptz, user_edited_at timestamptz,
        dossier_status text NOT NULL DEFAULT 'active', updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE storyhold.world_entities (
        id uuid PRIMARY KEY, name text NOT NULL, normalized_name text NOT NULL,
        aliases jsonb NOT NULL DEFAULT '[]', alias_attributions jsonb NOT NULL DEFAULT '[]',
        dossier_id uuid, mention_count integer NOT NULL DEFAULT 0,
        mention_source_count integer NOT NULL DEFAULT 0, summary text NOT NULL DEFAULT '',
        evidence jsonb NOT NULL DEFAULT '[]', details jsonb NOT NULL DEFAULT '[]',
        pull_status text NOT NULL DEFAULT 'active', scanner_present boolean NOT NULL DEFAULT true,
        merged_into_entity_id uuid, classification_source text NOT NULL DEFAULT 'local',
        review_status text NOT NULL DEFAULT 'candidate',
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE storyhold.character_dossier_source_contributions (
        id uuid PRIMARY KEY, dossier_id uuid NOT NULL, source_id uuid NOT NULL,
        world_id uuid NOT NULL, canon_edition_id uuid NOT NULL, last_analysis_run_id uuid,
        aliases jsonb NOT NULL DEFAULT '[]', role text NOT NULL DEFAULT '',
        summary text NOT NULL DEFAULT '', profile jsonb NOT NULL DEFAULT '{}',
        evidence jsonb NOT NULL DEFAULT '[]', confidence real NOT NULL DEFAULT 0,
        axis_estimate jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (dossier_id, source_id)
      );
    `);
    const targetId = "00000000-0000-4000-8000-000000000301";
    const sourceId = "00000000-0000-4000-8000-000000000302";
    const sourceDossierId = "00000000-0000-4000-8000-000000000303";
    await db.query(
      `INSERT INTO storyhold.character_dossiers
        (id, name, normalized_name, aliases, mention_count, mention_source_count,
         summary, evidence, dossier_status)
       VALUES ($1, 'Prowlers', 'prowlers', '[]', 12, 1,
         'Prowlers are pack predators.', '[{"sourceId":"book-b","quote":"The Prowlers snarled."}]',
         'suppressed')`,
      [sourceDossierId],
    );
    await db.query(
      `INSERT INTO storyhold.world_entities
        (id, name, normalized_name, dossier_id, mention_count, mention_source_count,
         summary, evidence)
       VALUES
        ($1, 'Prowler', 'prowler', NULL, 24, 2, 'A pack predator.',
         '[{"sourceId":"book-a","quote":"A Prowler hunted."},{"sourceId":"book-c","quote":"The Prowler lunged."}]'),
        ($2, 'Prowlers', 'prowlers', $3, 12, 1, 'Prowlers are pack predators.',
         '[{"sourceId":"book-b","quote":"The Prowlers snarled."}]')`,
      [targetId, sourceId, sourceDossierId],
    );
    assert.equal(await mergeGeneratedIdentityRowsAtomic({
      db,
      target: {
        id: targetId, name: "Prowler", dossier_id: null,
        dossier_profile: {}, dossier_axis_estimate: {},
      },
      source: {
        id: sourceId, name: "Prowlers", dossier_id: sourceDossierId,
        dossier_profile: {}, dossier_axis_estimate: {},
      },
      aliases: ["Prowlers"],
    }), true);
    const [targetResult, sourceResult, dossierResult] = await Promise.all([
      db.query<Record<string, unknown>>(`SELECT * FROM storyhold.world_entities WHERE id = $1`, [targetId]),
      db.query<Record<string, unknown>>(`SELECT * FROM storyhold.world_entities WHERE id = $1`, [sourceId]),
      db.query<Record<string, unknown>>(`SELECT * FROM storyhold.character_dossiers WHERE id = $1`, [sourceDossierId]),
    ]);
    const transferredTarget = targetResult.rows[0]!;
    const retiredSource = sourceResult.rows[0]!;
    const transferredDossier = dossierResult.rows[0]!;
    assert.equal(transferredTarget.dossier_id, sourceDossierId);
    assert.equal(transferredTarget.mention_count, 36);
    assert.equal(transferredTarget.mention_source_count, 3);
    assert.deepEqual(transferredTarget.aliases, ["Prowlers"]);
    assert.equal(retiredSource.pull_status, "merged");
    assert.equal(retiredSource.scanner_present, false);
    assert.equal(retiredSource.merged_into_entity_id, targetId);
    assert.equal(transferredDossier.name, "Prowler");
    assert.equal(transferredDossier.normalized_name, "prowler");
    assert.equal(transferredDossier.dossier_status, "active");
    assert.deepEqual(transferredDossier.aliases, ["Prowlers"]);
    assert.equal(transferredDossier.mention_count, 36);
    assert.equal(transferredDossier.mention_source_count, 3);

    const editedTargetId = "00000000-0000-4000-8000-000000000304";
    const editedSourceId = "00000000-0000-4000-8000-000000000305";
    const editedDossierId = "00000000-0000-4000-8000-000000000306";
    await db.query(
      `INSERT INTO storyhold.character_dossiers
        (id, name, normalized_name, aliases, mention_count, user_edited_at)
       VALUES ($1, 'Owner Plurals', 'owner plurals', '["Owner Form"]', 7, now())`,
      [editedDossierId],
    );
    await db.query(
      `INSERT INTO storyhold.world_entities
        (id, name, normalized_name, dossier_id, mention_count)
       VALUES ($1, 'Owner Singular', 'owner singular', NULL, 5),
              ($2, 'Owner Plurals', 'owner plurals', $3, 7)`,
      [editedTargetId, editedSourceId, editedDossierId],
    );
    const editedBefore = await Promise.all([
      db.query<Record<string, unknown>>(`SELECT * FROM storyhold.world_entities WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[editedTargetId, editedSourceId]]),
      db.query<Record<string, unknown>>(`SELECT * FROM storyhold.character_dossiers WHERE id = $1`,
        [editedDossierId]),
    ]);
    assert.equal(await mergeGeneratedIdentityRowsAtomic({
      db,
      target: {
        id: editedTargetId, name: "Owner Singular", dossier_id: null,
        dossier_profile: {}, dossier_axis_estimate: {},
      },
      source: {
        id: editedSourceId, name: "Owner Plurals", dossier_id: editedDossierId,
        dossier_profile: {}, dossier_axis_estimate: {},
      },
      aliases: ["Owner Plurals"],
    }), false);
    const editedAfter = await Promise.all([
      db.query<Record<string, unknown>>(`SELECT * FROM storyhold.world_entities WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[editedTargetId, editedSourceId]]),
      db.query<Record<string, unknown>>(`SELECT * FROM storyhold.character_dossiers WHERE id = $1`,
        [editedDossierId]),
    ]);
    assert.deepEqual(editedAfter[0].rows, editedBefore[0].rows,
      "a customer-edited source dossier cannot transfer or retire its entity");
    assert.deepEqual(editedAfter[1].rows, editedBefore[1].rows);

    const ownerTargetId = "00000000-0000-4000-8000-000000000307";
    const ownerSourceId = "00000000-0000-4000-8000-000000000308";
    const generatedDossierId = "00000000-0000-4000-8000-000000000309";
    await db.query(
      `INSERT INTO storyhold.character_dossiers (id, name, normalized_name, mention_count)
       VALUES ($1, 'Generated Variant', 'generated variant', 3)`,
      [generatedDossierId],
    );
    await db.query(
      `INSERT INTO storyhold.world_entities
        (id, name, normalized_name, dossier_id, mention_count, review_status)
       VALUES ($1, 'Owner Canon', 'owner canon', NULL, 9, 'user_confirmed'),
              ($2, 'Generated Variant', 'generated variant', $3, 3, 'candidate')`,
      [ownerTargetId, ownerSourceId, generatedDossierId],
    );
    assert.equal(await mergeGeneratedIdentityRowsAtomic({
      db,
      target: {
        id: ownerTargetId, name: "Owner Canon", dossier_id: null,
        dossier_profile: {}, dossier_axis_estimate: {},
      },
      source: {
        id: ownerSourceId, name: "Generated Variant", dossier_id: generatedDossierId,
        dossier_profile: {}, dossier_axis_estimate: {},
      },
      aliases: ["Generated Variant"],
    }), false);
    assert.equal((await db.query<{ dossier_id: string | null; mention_count: number }>(
      `SELECT dossier_id, mention_count FROM storyhold.world_entities WHERE id = $1`,
      [ownerTargetId],
    )).rows[0]?.dossier_id, null);
    assert.equal((await db.query<{ pull_status: string }>(
      `SELECT pull_status FROM storyhold.world_entities WHERE id = $1`,
      [ownerSourceId],
    )).rows[0]?.pull_status, "active");
    assert.equal((await db.query<{ name: string; mention_count: number }>(
      `SELECT name, mention_count FROM storyhold.character_dossiers WHERE id = $1`,
      [generatedDossierId],
    )).rows[0]?.name, "Generated Variant");
  } finally {
    await db.close();
  }
});

function jsonForTest(value: unknown): string {
  return JSON.stringify(value);
}

test("a self-declared callsign keeps an exact attribution after its source row was merged", () => {
  const evidence = chunk(
    "I called myself Prometheus, explaining it was the last movie I'd seen.",
    "Chapter 7 (Alec - Past)",
  );
  const [attribution] = selfDeclaredAliasAttributions({
    canonicalName: "Alec Sumner",
    aliases: ["Prometheus"],
    chunks: [evidence],
  });
  assert.equal(attribution?.alias, "Prometheus");
  assert.equal(attribution?.kind, "nickname");
  assert.equal(attribution?.attributedBy, "Alec Sumner");
  assert.equal(attribution?.chunkId, evidence.id);
  assert.match(attribution?.quote ?? "", /I called myself Prometheus/iu);
  assert.equal(attribution?.confidence, 0.99);

  assert.deepEqual(selfDeclaredAliasAttributions({
    canonicalName: "Alec Sumner",
    aliases: ["Prometheus"],
    chunks: [chunk(
      "I called myself Prometheus, explaining it was the last movie I'd seen.",
      "Chapter 7 (Lilly - Past)",
    )],
  }), [], "another character's POV cannot donate a first-person callsign");
});

test("an explicitly named speaker can still state a durable identity", () => {
  const entities = [
    identityEntity({ id: "shanta", name: "Shanta", mentionCount: 30 }),
    identityEntity({ id: "vishtal", name: "Vishtal", entityType: "ambiguous", dossierId: null }),
  ];
  const [resolution] = resolveExplicitCharacterIdentities({
    entities,
    chunks: [chunk('Shanta said, "I am Vishtal."', "Chapter 12 (Alec - Present)")],
  });
  assert.equal(resolution?.survivorId, "shanta");
  assert.deepEqual(resolution?.memberIds, ["shanta", "vishtal"]);
});

test("deictic and common-noun predicates and questioned identities do not merge dossiers", () => {
  const entities = [
    identityEntity({ id: "alec", name: "Alec", mentionCount: 450 }),
    identityEntity({ id: "here", name: "here", entityType: "ambiguous", dossierId: null }),
    identityEntity({ id: "family", name: "family", entityType: "term", dossierId: null }),
    identityEntity({ id: "that-thing", name: "that thing", entityType: "ambiguous", dossierId: null }),
    identityEntity({ id: "shanta", name: "Shanta", mentionCount: 30 }),
  ];
  const evidence = chunk(
    `Alec said, "I am here. I am family. I was that thing." ` +
    `Alec later asked, "I was that thing? You think I was Shanta?"`,
    "Chapter 12 (Alec - Present)",
  );
  assert.deepEqual(resolveExplicitCharacterIdentities({ entities, chunks: [evidence] }), []);
});

test("a possessive name after I am describes a relationship rather than an identity", () => {
  const entities = [
    identityEntity({ id: "alec", name: "Alec", mentionCount: 450 }),
    identityEntity({ id: "shanta", name: "Shanta", mentionCount: 30 }),
    identityEntity({ id: "dave", name: "Dave", mentionCount: 60 }),
  ];
  const evidence = chunk(
    `Alec said, "I am Shanta's father." Alec added, "I am Dave’s friend."`,
    "Chapter 12 (Alec - Present)",
  );
  assert.deepEqual(resolveExplicitCharacterIdentities({ entities, chunks: [evidence] }), []);
});

test("actual Ashes-shaped adjacent dialogue resolves Ragger, Anubsika, and Anubis without absorbing the Destroyer", () => {
  const entities = [
    identityEntity({ id: "ragger", name: "Ragger", mentionCount: 173 }),
    identityEntity({ id: "alec", name: "Alec", mentionCount: 450 }),
    identityEntity({ id: "anubsika", name: "Anubsika", entityType: "ambiguous", dossierId: null, mentionCount: 2 }),
    identityEntity({ id: "anubis", name: "Anubis", entityType: "term", dossierId: null, pullStatus: "do_not_pull" }),
    identityEntity({ id: "destroyer", name: "The Destroyer", mentionCount: 12 }),
    identityEntity({ id: "turncoats", name: "Turncoats and Changelings", entityType: "ambiguous", dossierId: null }),
  ];
  const evidence = chunk(
    `"In our tongue, he is known as 'The Destroyer'," Ragger intoned, watching the distant figure. ` +
    `Later, Ragger seemed to swell, his posture suddenly regal. "I am Anubsika," he declared, and the room fell silent. ` +
    `"The fallen high regent of the Vit Empire, once second only to the Queen herself. First Karagorn, the Protector, ruler and General of the flagship Iron Skies, and known to your kind as 'Anubis' - the Ancient God of Death." ` +
    `Ragger frowned. "I am surrounded by Turncoats and Changelings, not one of them."`,
    "Chapter 42 (Alec - Present)",
  );
  const [resolution] = resolveExplicitCharacterIdentities({ entities, chunks: [evidence] });
  assert.equal(resolution?.survivorId, "ragger");
  assert.deepEqual(resolution?.memberIds, ["anubis", "anubsika", "ragger"]);
  assert.ok(resolution?.aliases.includes("Anubsika"));
  assert.ok(resolution?.aliases.includes("Anubis"));
  assert.ok(!resolution?.memberIds.includes("destroyer"));
  assert.ok(!resolution?.memberIds.includes("turncoats"));
  assert.ok(!resolution?.memberIds.includes("alec"));
  assert.match(resolution?.attributions.find((entry) => entry.alias === "Anubis")?.quote ?? "", /known to your kind as 'Anubis'/u);
});

test("multiline preceding dialogue does not hide Ragger's Anubsika and Anubis reveal", () => {
  const entities = [
    identityEntity({ id: "ragger", name: "Ragger", mentionCount: 158 }),
    identityEntity({ id: "anubsika", name: "Anubsika", entityType: "ambiguous", dossierId: null, mentionCount: 2 }),
    identityEntity({
      id: "anubis",
      name: "Anubis",
      entityType: "species",
      dossierId: null,
      scannerPresent: false,
      mentionCount: 5,
    }),
  ];
  const evidence = chunk(
    `"A genetic anomaly within our species, or so we are led to believe. In truth, he represents the pinnacle of our evolution.\n\n` +
    `Again and again, rising on new worlds to destroy her." "And who the fuck are you?" someone hurled the question from the crowd. ` +
    `Ragger seemed to swell, his presence filling the room. "I am Anubsika," he declared, his voice a sepulchral whisper. ` +
    `"The fallen high regent of the Vit Empire, once second only to the Queen herself. First Karagorn, the Protector, ` +
    `ruler and General of the flagship Iron Skies, and known to your kind as 'Anubis' - the Ancient God of Death."`,
    "Chapter 15 - Fracture (Lilly - Present)",
  );
  const [resolution] = resolveExplicitCharacterIdentities({ entities, chunks: [evidence] });
  assert.equal(resolution?.survivorId, "ragger");
  assert.deepEqual(resolution?.memberIds, ["anubis", "anubsika", "ragger"]);
  assert.match(resolution?.attributions.find((entry) => entry.alias === "Anubis")?.quote ?? "", /known to your kind as 'Anubis'/u);
});

test("a direct species-membership claim does not merge the species into its speaker", () => {
  const result = resolveExplicitCharacterIdentities({
    entities: [
      identityEntity({ id: "ragger", name: "Ragger", mentionCount: 158 }),
      identityEntity({ id: "vit", name: "Vit", entityType: "species", dossierId: null, mentionCount: 40 }),
    ],
    chunks: [chunk('Ragger said, "I am Vit."', "Chapter 15 (Lilly - Present)")],
  });
  assert.deepEqual(result, []);
});

test("an uncommon temporal suffix is removed from the chapter perspective", () => {
  assert.equal(chapterPerspective({ sectionTitle: "Chapter 10 - Perspective (Ragger - Eons Ago)" }), "Ragger");
  assert.equal(chapterPerspective({ perspective: "Ragger - Eons Ago" }), "Ragger");
});

test("explicit identity union is order-independent and keeps the established speaking dossier", () => {
  const entities = [
    identityEntity({ id: "ragger", name: "Ragger", mentionCount: 173 }),
    identityEntity({ id: "anubsika", name: "Anubsika", mentionCount: 3 }),
    identityEntity({ id: "anubis", name: "Anubis", entityType: "title", dossierId: null }),
  ];
  const evidence = chunk(
    `Ragger drew himself upright. "I am Anubsika," he declared. "Among humans, I am known as Anubis."`,
    "Chapter 42",
  );
  const forward = resolveExplicitCharacterIdentities({ entities, chunks: [evidence] });
  const reversed = resolveExplicitCharacterIdentities({ entities: [...entities].reverse(), chunks: [evidence] });
  assert.deepEqual(forward, reversed);
  assert.equal(forward[0]?.survivorId, "ragger");
});

test("explicit prose variants can absorb ambiguous, title, and term candidates", () => {
  const entities = [
    identityEntity({ id: "valen", name: "Valen", mentionCount: 80 }),
    identityEntity({ id: "arcturus", name: "Arcturus", entityType: "ambiguous", dossierId: null }),
    identityEntity({ id: "daystar", name: "Daystar", entityType: "ambiguous", dossierId: null }),
    identityEntity({ id: "wayfinder", name: "Wayfinder", entityType: "title", dossierId: null }),
    identityEntity({ id: "lantern", name: "Lantern", entityType: "term", dossierId: null }),
    identityEntity({ id: "star-speaker", name: "Star-Speaker", entityType: "term", dossierId: null }),
  ];
  const evidence = chunk(
    `Valen said, "I am Arcturus, known to human kind as Daystar, known among the northern courts as Wayfinder, called by my people the Lantern, and my name is rendered as Star-Speaker."`,
    "Chapter 9",
  );
  const [resolution] = resolveExplicitCharacterIdentities({ entities, chunks: [evidence] });
  assert.equal(resolution?.survivorId, "valen");
  assert.deepEqual(resolution?.memberIds, ["arcturus", "daystar", "lantern", "star-speaker", "valen", "wayfinder"]);
});

test("Osiris and Zeus can resolve while Osirita and the planetary sense of Jupiter remain separate", () => {
  const entities = [
    identityEntity({ id: "osiris", name: "Osiris", mentionCount: 40 }),
    identityEntity({ id: "zeus", name: "Zeus", entityType: "ambiguous", dossierId: null }),
    identityEntity({ id: "jupiter", name: "Jupiter", mentionCount: 20 }),
    identityEntity({ id: "osirita", name: "Osirita", mentionCount: 25 }),
    identityEntity({ id: "ragger", name: "Ragger", mentionCount: 100 }),
  ];
  const identityEvidence = chunk("The oldest account names Osiris, who later became known as Jupiter and Zeus.", "Appendix");
  const planetEvidence = chunk("The projector displayed an image of Jupiter and its moon Io from orbit.", "Chapter 3");
  const [resolution] = resolveExplicitCharacterIdentities({ entities, chunks: [identityEvidence, planetEvidence] });
  assert.equal(resolution?.survivorId, "osiris");
  assert.deepEqual(resolution?.memberIds, ["osiris", "zeus"]);
  assert.ok(resolution?.aliases.includes("Jupiter"));
  assert.match(
    resolution?.attributions.find((entry) => entry.alias === "Jupiter")?.quote ?? "",
    /known as Jupiter and Zeus/u,
  );
  assert.ok(!resolution?.memberIds.includes("jupiter"));
  assert.ok(!resolution?.memberIds.includes("osirita"));
  assert.ok(!resolution?.memberIds.includes("ragger"));
});

test("qualified identity speculation does not merge dossiers", () => {
  const result = resolveExplicitCharacterIdentities({
    entities: [
      identityEntity({ id: "ragger", name: "Ragger", mentionCount: 100 }),
      identityEntity({ id: "anubis", name: "Anubis", entityType: "ambiguous", dossierId: null }),
    ],
    chunks: [chunk('Ragger hesitated. "I might be Anubis," he said.', "Chapter 2")],
  });
  assert.deepEqual(result, []);
});
