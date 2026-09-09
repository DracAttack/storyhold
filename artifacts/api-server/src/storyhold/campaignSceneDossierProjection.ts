import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { mergeDossierProfiles } from "./worldStudio";
import { loadWorldEntityNameResolution } from "./worldKnowledge";

type Queryable = Pick<PGlite, "query">;

const NON_NAMES = new Set([
  "a", "an", "and", "but", "dawn", "he", "her", "hers", "his", "i", "if",
  "alliance", "captain", "city", "council", "empire", "forest", "gate", "guild", "harbor", "house", "in", "it", "its", "kingdom",
  "later", "moments", "morning", "night", "no", "order", "party", "river", "she",
  "rain", "the", "their", "them", "there", "they", "this", "throne", "tower", "we", "when", "while",
  "with", "yes", "you", "your",
]);

function text(value: unknown, maximum = 4_000) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function normalizedName(name: string) {
  return name.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    .replace(/\s+/g, " ").replace(/^(?:a|an|the)\s+/u, "");
}

function canonicalPart(name: string) {
  return normalizedName(name).replace(/\s+/g, "-").slice(0, 120);
}
function identities(row: Record<string, unknown>) {
  return [row.name, row.normalized_name, ...jsonArray(row.aliases)]
    .map((value) => normalizedName(text(value, 240))).filter(Boolean);
}
function sameIdentity(row: Record<string, unknown>, name: string) {
  return identities(row).includes(normalizedName(name));
}
function resolutionKey(name: string) {
  return name.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}
function regexEscape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function establishedMentionCandidate(prose: string, label: string) {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${regexEscape(label).replace(/\\ /g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu");
  const matches = [...prose.matchAll(pattern)];
  if (!matches.length) return null;
  return {
    name: label,
    count: matches.length,
    active: matches.some((match) => {
      const after = prose.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 48);
      return /^\s*(?:said|says|asked|asks|replied|replies|walked|walks|ran|runs|stood|stands|looked|looks|turned|turns|drew|draws)\b/iu.test(after);
    }),
  };
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function deterministicUuid(value: string) {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * This intentionally has no model dependency.  It recognizes only ordinary
 * proper-name surfaces and requires a second occurrence (or a speech/action
 * construction) before it creates a new character card.  Existing cards get
 * scene evidence for a single unambiguous mention.
 */
export function namedCharactersInAcceptedScene(prose: string) {
  const counts = new Map<string, { name: string; count: number; active: boolean }>();
  const pattern = /\b([A-Z][\p{L}'’-]{1,}(?:\s+[A-Z][\p{L}'’-]{1,})?)\b/gu;
  for (const match of prose.matchAll(pattern)) {
    const name = match[1]!.trim().replace(/^(?:Captain|Commander|Doctor|Dr|Lady|Lord|Sir)\s+/u, "");
    const normalized = normalizedName(name);
    if (!normalized || normalized.split(" ").some((word) => NON_NAMES.has(word)) ||
      name.split(/\s+/).length > 2) continue;
    const prior = counts.get(normalized) ?? { name, count: 0, active: false };
    prior.count += 1;
    // A named speaker/actor is defensible even if their name only occurs once.
    const after = prose.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 48);
    prior.active ||= /^\s*(?:said|says|asked|asks|replied|replies|walked|walks|ran|runs|stood|stands|looked|looks|turned|turns|drew|draws)\b/iu.test(after);
    counts.set(normalized, prior);
  }
  return [...counts.values()];
}

export async function projectAcceptedCampaignSceneDossiers(params: {
  db: Queryable;
  worldId: string;
  canonEditionId: string;
  campaignId: string;
  turnId: string;
  stateVersion: number;
  narration: string;
  sceneSummary: string;
}) {
  const narration = text(params.narration, 12_000);
  const sceneSummary = text(params.sceneSummary, 1_000);
  if (!narration) return;
  const evidence = {
    kind: "accepted_campaign_scene",
    campaignId: params.campaignId,
    turnId: params.turnId,
    stateVersion: params.stateVersion,
    quote: narration.slice(0, 1_500),
  };
  // A turn is the durable projection identity. Narration can be revised while a
  // crashed transaction is recovered; that must repair, not duplicate, it.
  const evidenceFingerprint = fingerprint({ campaignId: params.campaignId, turnId: params.turnId });
  // Serialize the whole empty-world discovery window, not merely an existing
  // row. All campaign transactions introducing characters in this edition use
  // the same lock and therefore cannot race either unique constraint.
  await params.db.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`campaign-scene-dossiers:${params.worldId}:${params.canonEditionId}`],
  );
  let nameResolution = await loadWorldEntityNameResolution({
    db: params.db,
    worldId: params.worldId,
    editionId: params.canonEditionId,
    targetEntityTypes: ["character"],
    mentionedInText: narration,
  });
  // Resolve the complete accepted passage against established labels before
  // applying conservative unknown-name heuristics. This preserves valid names
  // such as Dawn and Captain Nera.
  const established = [...nameResolution.idsByName.entries()]
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([label]) => establishedMentionCandidate(narration, label))
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
  let unmatchedProse = narration;
  for (const candidate of established.sort((a, b) => b.name.length - a.name.length)) {
    unmatchedProse = unmatchedProse.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${regexEscape(candidate.name).replace(/\\ /g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu"),
      (match) => " ".repeat(match.length),
    );
  }
  const candidates = [
    ...established,
    ...namedCharactersInAcceptedScene(unmatchedProse),
  ].sort((left, right) => normalizedName(left.name).localeCompare(normalizedName(right.name)));
  for (const candidate of candidates) {
    const resolvedEntityId = nameResolution.idsByName.get(resolutionKey(candidate.name));
    if (resolvedEntityId === null) continue;
    const existingResult = resolvedEntityId
      ? await params.db.query<Record<string, unknown>>(
      `SELECT entity.*, dossier.profile AS dossier_profile, dossier.summary AS dossier_summary,
              dossier.evidence AS dossier_evidence, dossier.user_edited_at
         FROM storyhold.world_entities entity
         LEFT JOIN storyhold.character_dossiers dossier ON dossier.id = entity.dossier_id
        WHERE entity.id=$1 AND entity.world_id = $2 AND entity.canon_edition_id = $3
        FOR UPDATE OF entity`,
      [resolvedEntityId, params.worldId, params.canonEditionId],
    ) : { rows: [] as Record<string, unknown>[] };
    let entity = existingResult.rows[0];
    // Dossier aliases are fallback repair evidence only when canonical entity
    // resolution found nothing. They cannot poison or redirect an active card.
    const candidateNormalizedName = normalizedName(candidate.name);
    const dossierRows = !entity ? await params.db.query<Record<string, unknown>>(
      `SELECT * FROM storyhold.character_dossiers
        WHERE world_id=$1 AND canon_edition_id=$2 AND dossier_status='active'
          AND (
            normalized_name=$3 OR EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(aliases) AS alias(value)
               WHERE regexp_replace(
                 trim(regexp_replace(
                   lower(normalize(alias.value, NFKC)),
                   '[^[:alnum:]]+', ' ', 'g'
                 )),
                 '^(a|an|the)\\s+', '', 'g'
               )=$3
            )
          )
        FOR UPDATE`,
      [params.worldId, params.canonEditionId, candidateNormalizedName],
    ) : { rows: [] as Record<string, unknown>[] };
    const matchingDossiers = dossierRows.rows.filter((row) => sameIdentity(row, candidate.name));
    let dossierOnly = matchingDossiers.length === 1 ? matchingDossiers[0] : undefined;
    // Alias collisions are not identity evidence. A turn must never choose
    // between two established people merely because they share a nickname.
    if (matchingDossiers.length > 1) continue;
    if (!entity && dossierOnly) {
      const owner = (await params.db.query<Record<string, unknown>>(
        `SELECT * FROM storyhold.world_entities
          WHERE world_id=$1 AND canon_edition_id=$2 AND dossier_id=$3
          LIMIT 2 FOR UPDATE`,
        [params.worldId, params.canonEditionId, dossierOnly.id],
      )).rows;
      // Never steal or duplicate an owned dossier. A merged owner may resolve
      // to an active canonical character; hidden/deleted/non-scanner owners do
      // not permit campaign projection.
      if (owner.length) {
        let canonicalId = typeof owner[0]?.id === "string"
          ? nameResolution.canonicalIdByEntityId.get(owner[0].id)
          : undefined;
        if (!canonicalId && typeof owner[0]?.id === "string") {
          canonicalId = (await params.db.query<{ id: string }>(
            `WITH RECURSIVE owner_chain AS (
               SELECT id, entity_type, pull_status, scanner_present, merged_into_entity_id
                 FROM storyhold.world_entities
                WHERE id=$1 AND world_id=$2 AND canon_edition_id=$3
               UNION ALL
               SELECT target.id, target.entity_type, target.pull_status,
                      target.scanner_present, target.merged_into_entity_id
                 FROM storyhold.world_entities target
                 JOIN owner_chain source ON target.id=source.merged_into_entity_id
                WHERE target.world_id=$2 AND target.canon_edition_id=$3
             )
             SELECT id FROM owner_chain
              WHERE pull_status='active' AND scanner_present=true AND entity_type='character'
              LIMIT 1`,
            [owner[0].id, params.worldId, params.canonEditionId],
          )).rows[0]?.id;
        }
        if (!canonicalId) continue;
        entity = (await params.db.query<Record<string, unknown>>(
          `SELECT entity.*, dossier.profile AS dossier_profile, dossier.summary AS dossier_summary,
                  dossier.evidence AS dossier_evidence, dossier.user_edited_at
             FROM storyhold.world_entities entity
             LEFT JOIN storyhold.character_dossiers dossier ON dossier.id=entity.dossier_id
            WHERE entity.id=$1 FOR UPDATE OF entity`,
          [canonicalId],
        )).rows[0];
        dossierOnly = undefined;
      }
    }
    // Do not create a card just because a setup/planning document named someone:
    // this runs only for committed narration, and creation has a conservative
    // prose-evidence threshold.
    if (!entity && !dossierOnly && (candidate.count < 2 || !candidate.active)) continue;
    if (!entity && !dossierOnly) {
      const dossierId = deterministicUuid(`dossier:${params.worldId}:${params.canonEditionId}:${normalizedName(candidate.name)}`);
      const entityId = deterministicUuid(`entity:${params.worldId}:${params.canonEditionId}:${normalizedName(candidate.name)}`);
      const profile = mergeDossierProfiles({}, { history: [sceneSummary || narration] });
      const key = `campaign-scene-${params.campaignId}-${canonicalPart(candidate.name)}`;
      await params.db.query(
        `INSERT INTO storyhold.character_dossiers
          (id, world_id, canon_edition_id, canonical_key, normalized_name, name,
           summary, profile, evidence, confidence, mention_count, mention_source_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,.65,1,1)
         ON CONFLICT (world_id, canon_edition_id, normalized_name) DO NOTHING`,
        [dossierId, params.worldId, params.canonEditionId, key, normalizedName(candidate.name),
          candidate.name, `Observed in an accepted campaign scene: ${sceneSummary || narration.slice(0, 500)}`,
          JSON.stringify(profile), JSON.stringify([{ ...evidence, fingerprint: evidenceFingerprint }])],
      );
      const winningDossier = (await params.db.query<{ id: string }>(
        `SELECT id FROM storyhold.character_dossiers
          WHERE world_id=$1 AND canon_edition_id=$2 AND normalized_name=$3 FOR UPDATE`,
        [params.worldId, params.canonEditionId, normalizedName(candidate.name)],
      )).rows[0];
      if (!winningDossier) continue;
      await params.db.query(
        `INSERT INTO storyhold.world_entities
          (id, world_id, canon_edition_id, dossier_id, canonical_key, normalized_name,
           name, entity_type, summary, details, evidence, mention_count, mention_source_count,
           confidence, classification_source, review_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'character',$8,$9::jsonb,$10::jsonb,1,1,.65,'local','candidate')
         ON CONFLICT (world_id, canon_edition_id, normalized_name) DO NOTHING`,
        [entityId, params.worldId, params.canonEditionId, winningDossier.id, key,
          normalizedName(candidate.name), candidate.name,
          `Observed in an accepted campaign scene: ${sceneSummary || narration.slice(0, 500)}`,
          JSON.stringify(sceneSummary ? [sceneSummary] : []),
          JSON.stringify([{ ...evidence, fingerprint: evidenceFingerprint }])],
      );
      nameResolution = await loadWorldEntityNameResolution({
        db: params.db, worldId: params.worldId, editionId: params.canonEditionId,
        targetEntityTypes: ["character"],
        mentionedInText: narration,
      });
      const winnerId = nameResolution.idsByName.get(resolutionKey(candidate.name));
      if (typeof winnerId === "string") {
        entity = (await params.db.query<Record<string, unknown>>(
          `SELECT entity.*, dossier.profile AS dossier_profile, dossier.summary AS dossier_summary,
                  dossier.evidence AS dossier_evidence, dossier.user_edited_at
             FROM storyhold.world_entities entity
             LEFT JOIN storyhold.character_dossiers dossier ON dossier.id=entity.dossier_id
            WHERE entity.id=$1 FOR UPDATE OF entity`,
          [winnerId],
        )).rows[0];
      }
    }
    // A dossier can legitimately outlive an entity card. Reattach/create a
    // card deterministically, without stealing a dossier held by another row.
    if (!entity && dossierOnly) {
      const entityId = deterministicUuid(`entity:${params.worldId}:${params.canonEditionId}:${normalizedName(candidate.name)}`);
      const key = `scene-character-${fingerprint({ world: params.worldId, name: normalizedName(candidate.name) }).slice(0, 32)}`;
      await params.db.query(
        `INSERT INTO storyhold.world_entities
          (id, world_id, canon_edition_id, dossier_id, canonical_key, normalized_name, name,
           entity_type, summary, evidence, mention_count, mention_source_count, confidence, classification_source, review_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'character',$8,$9::jsonb,0,0,.65,'local','candidate')
         ON CONFLICT (world_id, canon_edition_id, normalized_name) DO NOTHING`,
        [entityId, params.worldId, params.canonEditionId, dossierOnly.id, key, normalizedName(candidate.name),
          dossierOnly.name, dossierOnly.summary, JSON.stringify([])],
      );
      entity = (await params.db.query<Record<string, unknown>>(
        `SELECT entity.*, dossier.profile AS dossier_profile, dossier.summary AS dossier_summary,
                dossier.evidence AS dossier_evidence, dossier.user_edited_at
           FROM storyhold.world_entities entity LEFT JOIN storyhold.character_dossiers dossier ON dossier.id=entity.dossier_id
          WHERE entity.world_id=$1 AND entity.canon_edition_id=$2 AND entity.normalized_name=$3 FOR UPDATE OF entity`,
        [params.worldId, params.canonEditionId, normalizedName(candidate.name)],
      )).rows[0];
      if (!entity) continue;
    }
    if (!entity) continue;
    if (entity.entity_type !== "character") continue;
    const entityEvidence = jsonArray(entity.evidence);
    const entityAlreadyProjected = entityEvidence.some((item) =>
      item && typeof item === "object" &&
      (item as Record<string, unknown>).fingerprint === evidenceFingerprint,
    );
    const mergedEvidence = entityAlreadyProjected
      ? entityEvidence : [...entityEvidence, { ...evidence, fingerprint: evidenceFingerprint }];
    const details = jsonArray(entity.details);
    await params.db.query(
      `UPDATE storyhold.world_entities
          SET evidence=$2::jsonb, details=$3::jsonb,
              mention_count=mention_count + CASE WHEN $4 THEN 0 ELSE 1 END,
              mention_source_count=mention_source_count + CASE WHEN $4 THEN 0 ELSE 1 END, updated_at=now()
        WHERE id=$1`,
      [entity.id, JSON.stringify(mergedEvidence),
        JSON.stringify(sceneSummary && !details.includes(sceneSummary) ? [...details, sceneSummary] : details),
        entityAlreadyProjected],
    );
    if (typeof entity.dossier_id !== "string") {
      const dossierId = deterministicUuid(`dossier:${params.worldId}:${params.canonEditionId}:${normalizedName(text(entity.name, 240))}`);
      const key = `campaign-scene-${params.campaignId}-${canonicalPart(text(entity.name, 240))}`;
      const profile = mergeDossierProfiles({}, { history: [sceneSummary || narration] });
      await params.db.query(
        `INSERT INTO storyhold.character_dossiers
          (id, world_id, canon_edition_id, canonical_key, normalized_name, name,
           summary, profile, evidence, confidence, mention_count, mention_source_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,.65,1,1)
         ON CONFLICT (world_id, canon_edition_id, normalized_name) DO NOTHING`,
        [dossierId, params.worldId, params.canonEditionId, key,
          normalizedName(text(entity.name, 240)), text(entity.name, 240),
          `Observed in an accepted campaign scene: ${sceneSummary || narration.slice(0, 500)}`,
          JSON.stringify(profile), JSON.stringify(mergedEvidence)],
      );
      const saved = await params.db.query<{ id: string }>(
        `SELECT id FROM storyhold.character_dossiers WHERE world_id=$1 AND canon_edition_id=$2
           AND normalized_name=$3`,
        [params.worldId, params.canonEditionId, normalizedName(text(entity.name, 240))],
      );
      if (saved.rows[0]) await params.db.query(
        "UPDATE storyhold.world_entities SET dossier_id=$2, updated_at=now() WHERE id=$1 AND dossier_id IS NULL",
        [entity.id, saved.rows[0].id],
      );
      if (!saved.rows[0]) continue;
      entity = (await params.db.query<Record<string, unknown>>(
        `SELECT entity.*, dossier.profile AS dossier_profile, dossier.summary AS dossier_summary,
                dossier.evidence AS dossier_evidence, dossier.user_edited_at
           FROM storyhold.world_entities entity
           JOIN storyhold.character_dossiers dossier ON dossier.id=entity.dossier_id
          WHERE entity.id=$1 FOR UPDATE OF entity`,
        [entity.id],
      )).rows[0];
      if (!entity) continue;
    }
    const dossierEvidence = jsonArray(entity.dossier_evidence);
    const dossierAlreadyProjected = dossierEvidence.some((item) =>
      item && typeof item === "object" && (item as Record<string, unknown>).fingerprint === evidenceFingerprint,
    );
    const nextDossierEvidence = dossierAlreadyProjected
      ? dossierEvidence : [...dossierEvidence, { ...evidence, fingerprint: evidenceFingerprint }];
    const edited = Boolean(entity.user_edited_at);
    const profile = edited ? entity.dossier_profile : mergeDossierProfiles(
      entity.dossier_profile,
      { history: [sceneSummary || narration] },
    );
    await params.db.query(
      `UPDATE storyhold.character_dossiers
          SET evidence=$2::jsonb, mention_count=mention_count + CASE WHEN $5 THEN 0 ELSE 1 END,
              mention_source_count=mention_source_count + CASE WHEN $5 THEN 0 ELSE 1 END,
              profile=CASE WHEN user_edited_at IS NULL THEN $3::jsonb ELSE profile END,
              summary=CASE WHEN user_edited_at IS NULL AND summary='' THEN $4 ELSE summary END,
              updated_at=now()
        WHERE id=$1`,
      [entity.dossier_id, JSON.stringify(nextDossierEvidence), JSON.stringify(profile),
        `Observed in an accepted campaign scene: ${sceneSummary || narration.slice(0, 500)}`,
        dossierAlreadyProjected],
    );
  }
}