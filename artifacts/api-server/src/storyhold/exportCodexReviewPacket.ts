import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import {
  bindCodexReviewPacketQueryResults,
  fingerprintedRowSet,
  normalizeReviewPacketValue,
  reviewPacketFingerprint,
} from "./exportCodexReviewPacketCore";

type Row = Record<string, unknown>;
type ReviewDb = Pick<PGlite, "exec" | "query" | "close">;

const [dataDirArgument, worldId, outputArgument] = process.argv.slice(2);
if (!dataDirArgument || !worldId || !outputArgument) {
  throw new Error(
    "Usage: exportCodexReviewPacket <closed-staged-data-dir> <world-id> <output-json>",
  );
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sum(rows: Row[], key: string): number {
  return rows.reduce((total, row) => total + number(row[key]), 0);
}

function countsBy(rows: Row[], key: string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = text(row[key]) || "(empty)";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

async function ensureClosedExistingDataDirectory(dataDir: string) {
  await access(dataDir);
  const details = await stat(dataDir);
  if (!details.isDirectory()) throw new Error(`${dataDir} is not a directory.`);
  await access(path.join(dataDir, "PG_VERSION"));
  const pidPath = path.join(dataDir, "postmaster.pid");
  try {
    const pidText = await readFile(pidPath, "utf8");
    const pid = Number(pidText.split(/\r?\n/u)[0]);
    // PGlite deliberately leaves -42 as its closed embedded-postgres sentinel.
    // Any ordinary positive PID remains a hard stop even if it appears stale;
    // callers must use a clean staging copy rather than guessing about locks.
    if (pid === -42) return;
    if (Number.isInteger(pid) && pid > 0)
      throw new Error(
        `Refusing to open ${dataDir}: postmaster PID ${pid} is present. Stop or copy the vault first.`,
      );
    throw new Error(
      `Refusing to open ${dataDir}: postmaster.pid has an unrecognized first line. Use a cleanly closed staging copy.`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function tableExists(db: ReviewDb, table: string): Promise<boolean> {
  const result = await db.query<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'storyhold' AND table_name = $1
     ) AS found`,
    [table],
  );
  return Boolean(result.rows[0]?.found);
}

async function rows(
  db: ReviewDb,
  sql: string,
  parameters: unknown[] = [],
): Promise<Row[]> {
  const result = await db.query<Row>(sql, parameters);
  return normalizeReviewPacketValue(result.rows) as Row[];
}

async function optionalRows(
  db: ReviewDb,
  missingTables: string[],
  table: string,
  sql: string,
  parameters: unknown[] = [],
): Promise<Row[]> {
  if (!(await tableExists(db, table))) {
    missingTables.push(table);
    return [];
  }
  return rows(db, sql, parameters);
}

function sourceCorpusInvariant(params: {
  sources: Row[];
  chunks: Row[];
  pages: Row[];
}) {
  const sourceManifest = params.sources.map((source) => ({
    id: source.id,
    canonEditionId: source.canon_edition_id,
    contentHash: source.content_hash,
    extractedTextFingerprint: reviewPacketFingerprint(source.extracted_text ?? ""),
    byteSize: source.byte_size,
    wordCount: source.word_count,
    charCount: source.char_count,
    chunkCount: source.chunk_count,
    pageCount: source.page_count,
    originalFilename: source.original_filename,
    rawFilePath: source.raw_file_path,
  }));
  const chunkManifest = params.chunks.map((chunk) => ({
    id: chunk.id,
    sourceId: chunk.source_id,
    chunkIndex: chunk.chunk_index,
    contentHash: chunk.content_hash,
    contentFingerprint: reviewPacketFingerprint(chunk.content ?? ""),
    metadata: chunk.metadata ?? {},
  }));
  const pageManifest = params.pages.map((page) => ({
    id: page.id,
    sourceId: page.source_id,
    pageIndex: page.page_index,
    startOffset: page.start_offset,
    endOffset: page.end_offset,
    charCount: page.char_count,
    contentHash: page.content_hash,
  }));
  return {
    sourceCount: params.sources.length,
    chunkCount: params.chunks.length,
    pageCount: params.pages.length,
    wordCount: sum(params.sources, "word_count"),
    charCount: sum(params.sources, "char_count"),
    sourceManifest,
    fingerprint: reviewPacketFingerprint({ sourceManifest, chunkManifest, pageManifest }),
  };
}

async function campaignTableRows(
  db: ReviewDb,
  missingTables: string[],
  worldIdValue: string,
) {
  const directTables = [
    { table: "campaign_members", order: "item.campaign_id, item.player_id" },
    { table: "campaign_turns", order: "item.campaign_id, item.turn_number, item.id" },
    { table: "campaign_entity_snapshots", order: "item.campaign_id, item.entity_id" },
    { table: "campaign_state_summaries", order: "item.campaign_id, item.entity_type, item.canonical_key, item.id" },
    { table: "campaign_turn_requests", order: "item.campaign_id, item.created_at, item.id" },
    { table: "campaign_turn_proposals", order: "item.campaign_id, item.created_at, item.id" },
    { table: "campaign_facts", order: "item.campaign_id, item.state_version, item.fact_key, item.id" },
    { table: "campaign_epistemic_assertions", order: "item.campaign_id, item.state_version, item.assertion_key, item.id" },
    { table: "campaign_novelty_ledger", order: "item.campaign_id, item.state_version, item.id" },
    { table: "campaign_turn_snapshots", order: "item.campaign_id, item.before_state_version, item.id" },
    { table: "campaign_checkpoints", order: "item.campaign_id, item.state_version, item.created_at, item.id" },
    { table: "campaign_branches", order: "item.campaign_id, item.created_at, item.id" },
    { table: "campaign_runtime_rules", order: "item.campaign_id, item.canonical_key, item.id" },
  ];
  const output: Record<string, Row[]> = {};
  for (const entry of directTables) {
    output[entry.table] = await optionalRows(
      db,
      missingTables,
      entry.table,
      `SELECT item.* FROM storyhold.${entry.table} item
         JOIN storyhold.campaigns campaign ON campaign.id = item.campaign_id
        WHERE campaign.world_id = $1
        ORDER BY ${entry.order}`,
      [worldIdValue],
    );
  }
  output.campaign_turn_proposal_versions = await optionalRows(
    db,
    missingTables,
    "campaign_turn_proposal_versions",
    `SELECT version.* FROM storyhold.campaign_turn_proposal_versions version
       JOIN storyhold.campaign_turn_proposals proposal ON proposal.id = version.proposal_id
       JOIN storyhold.campaigns campaign ON campaign.id = proposal.campaign_id
      WHERE campaign.world_id = $1
      ORDER BY proposal.campaign_id, version.proposal_id, version.revision`,
    [worldIdValue],
  );
  return output;
}

async function exportPacket(db: ReviewDb, worldIdValue: string, dataDir: string) {
  const missingTables: string[] = [];
  const worldRows = await rows(
    db,
    "SELECT * FROM storyhold.worlds WHERE id = $1 LIMIT 1",
    [worldIdValue],
  );
  const world = worldRows[0];
  if (!world) throw new Error(`World ${worldIdValue} was not found.`);
  const ownerId = text(world.owner_player_id);
  const editions = await rows(
    db,
    `SELECT * FROM storyhold.canon_editions
      WHERE world_id = $1 ORDER BY created_at ASC, id ASC`,
    [worldIdValue],
  );
  const edition = editions[0];
  if (!edition) throw new Error(`World ${worldIdValue} has no canon edition.`);
  const editionId = text(edition.id);

  const sources = await rows(
    db,
    `SELECT * FROM storyhold.world_sources
      WHERE world_id = $1 AND canon_edition_id = $2
      ORDER BY chronology_order, sort_order, created_at, id`,
    [worldIdValue, editionId],
  );
  const chunks = await rows(
    db,
    `SELECT chunk.id, chunk.source_id, chunk.world_id, chunk.canon_edition_id,
            chunk.chunk_index, chunk.content, chunk.content_hash,
            chunk.char_count, chunk.metadata, chunk.embedding_provider,
            chunk.embedding_model, chunk.embedding_updated_at, chunk.created_at
       FROM storyhold.world_source_chunks chunk
       JOIN storyhold.world_sources source ON source.id = chunk.source_id
      WHERE chunk.world_id = $1 AND chunk.canon_edition_id = $2
      ORDER BY source.chronology_order, source.sort_order, chunk.chunk_index, chunk.id`,
    [worldIdValue, editionId],
  );
  const pages = await optionalRows(
    db,
    missingTables,
    "world_source_pages",
    `SELECT page.* FROM storyhold.world_source_pages page
       JOIN storyhold.world_sources source ON source.id = page.source_id
      WHERE page.world_id = $1 AND page.canon_edition_id = $2
      ORDER BY source.chronology_order, source.sort_order, page.page_index, page.id`,
    [worldIdValue, editionId],
  );

  const {
    chapterSummaries,
    clockEvents,
    eventParticipants,
    entities,
    dossiers,
    dossierContributions,
    relations,
    memberships,
    rules,
    entityActions,
    claims,
    mentions,
    coreferenceMentions,
    qualityFindings,
    breakdowns,
    characterDrafts,
    cohesionProposals,
    discrepancyReports,
    canonAmendments,
    canonIntegritySignals,
    playerCanonIntegrity,
    analysisRuns,
    analysisCoverage,
    aiUsage,
    account,
    creditReservations,
    creditLedger,
    canonicalCharacters,
    campaigns,
    worldStateEvents,
    vaultMemories,
  } = bindCodexReviewPacketQueryResults(await Promise.all([
    optionalRows(db, missingTables, "world_chapter_summaries",
      "SELECT * FROM storyhold.world_chapter_summaries WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY source_id, source_order, id", [worldIdValue, editionId]),
    optionalRows(db, missingTables, "world_clock_events",
      "SELECT * FROM storyhold.world_clock_events WHERE world_id = $1 ORDER BY campaign_id NULLS FIRST, chronology_order, created_at, id", [worldIdValue]),
    optionalRows(db, missingTables, "world_event_participants",
      `SELECT participant.*, entity.name AS entity_name, event.canonical_key AS event_canonical_key
         FROM storyhold.world_event_participants participant
         JOIN storyhold.world_entities entity ON entity.id = participant.entity_id
         JOIN storyhold.world_clock_events event ON event.id = participant.event_id
        WHERE participant.world_id = $1 AND participant.canon_edition_id = $2
        ORDER BY participant.event_id, participant.participant_role, participant.entity_id`, [worldIdValue, editionId]),
    optionalRows(db, missingTables, "world_entities",
      "SELECT * FROM storyhold.world_entities WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY entity_type, normalized_name, id", [worldIdValue, editionId]),
    optionalRows(db, missingTables, "character_dossiers",
      "SELECT * FROM storyhold.character_dossiers WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY normalized_name, id", [worldIdValue, editionId]),
    optionalRows(db, missingTables, "character_dossier_source_contributions",
      "SELECT * FROM storyhold.character_dossier_source_contributions WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY dossier_id, source_id, id", [worldIdValue, editionId]),
    optionalRows(db, missingTables, "world_entity_relations",
      `SELECT relation.*, source.name AS source_name, target.name AS target_name
         FROM storyhold.world_entity_relations relation
         JOIN storyhold.world_entities source ON source.id = relation.source_entity_id
         JOIN storyhold.world_entities target ON target.id = relation.target_entity_id
        WHERE relation.world_id = $1 AND relation.canon_edition_id = $2
        ORDER BY relation.source_entity_id, relation.relation_type, relation.target_entity_id, relation.id`, [worldIdValue, editionId]),
    optionalRows(db, missingTables, "world_entity_faction_memberships",
      `SELECT membership.*, entity.name AS entity_name, faction.name AS faction_name
         FROM storyhold.world_entity_faction_memberships membership
         JOIN storyhold.world_entities entity ON entity.id = membership.entity_id
         JOIN storyhold.world_entities faction ON faction.id = membership.faction_entity_id
        WHERE entity.world_id = $1 AND entity.canon_edition_id = $2
        ORDER BY membership.entity_id, membership.faction_entity_id`, [worldIdValue, editionId]),
    optionalRows(db, missingTables, "world_entity_rules",
      "SELECT * FROM storyhold.world_entity_rules WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY entity_id, canonical_key, id", [worldIdValue, editionId]),
    optionalRows(db, missingTables, "world_entity_actions",
      "SELECT * FROM storyhold.world_entity_actions WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY created_at, id", [worldIdValue, editionId]),
    optionalRows(db, missingTables, "world_knowledge_claims",
      "SELECT * FROM storyhold.world_knowledge_claims WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY fingerprint, id", [worldIdValue, editionId]),
    optionalRows(db, missingTables, "world_entity_mentions",
      "SELECT * FROM storyhold.world_entity_mentions WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY source_id, chunk_id, start_offset, id", [worldIdValue, editionId]),
    optionalRows(db, missingTables, "world_coreference_mentions",
      "SELECT * FROM storyhold.world_coreference_mentions WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY source_id, chunk_id, start_offset, id", [worldIdValue, editionId]),
    optionalRows(db, missingTables, "world_quality_findings",
      "SELECT * FROM storyhold.world_quality_findings WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY fingerprint, id", [worldIdValue, editionId]),
    optionalRows(db, missingTables, "world_breakdowns",
      "SELECT * FROM storyhold.world_breakdowns WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY version, id", [worldIdValue, editionId]),
    optionalRows(db, missingTables, "character_drafts",
      "SELECT * FROM storyhold.character_drafts WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY created_at, id", [worldIdValue, editionId]),
    optionalRows(db, missingTables, "cohesion_proposals",
      "SELECT * FROM storyhold.cohesion_proposals WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY created_at, id", [worldIdValue, editionId]),
    optionalRows(db, missingTables, "canon_discrepancy_reports",
      "SELECT * FROM storyhold.canon_discrepancy_reports WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY created_at, id", [worldIdValue, editionId]),
    optionalRows(db, missingTables, "canon_amendments",
      "SELECT * FROM storyhold.canon_amendments WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY created_at, id", [worldIdValue, editionId]),
    optionalRows(db, missingTables, "canon_integrity_signals",
      "SELECT * FROM storyhold.canon_integrity_signals WHERE world_id = $1 ORDER BY created_at, id", [worldIdValue]),
    optionalRows(db, missingTables, "player_canon_integrity",
      "SELECT * FROM storyhold.player_canon_integrity WHERE world_id = $1 ORDER BY created_at, id", [worldIdValue]),
    optionalRows(db, missingTables, "world_analysis_runs",
      "SELECT * FROM storyhold.world_analysis_runs WHERE world_id = $1 AND canon_edition_id = $2 ORDER BY created_at, id", [worldIdValue, editionId]),
    optionalRows(db, missingTables, "world_analysis_chunk_coverage",
      `SELECT coverage.* FROM storyhold.world_analysis_chunk_coverage coverage
         JOIN storyhold.world_analysis_runs run ON run.id = coverage.analysis_run_id
        WHERE run.world_id = $1 AND run.canon_edition_id = $2
        ORDER BY run.created_at, coverage.source_id, coverage.chunk_index, coverage.chunk_id`, [worldIdValue, editionId]),
    optionalRows(db, missingTables, "ai_usage_ledger",
      "SELECT * FROM storyhold.ai_usage_ledger WHERE world_id = $1 ORDER BY created_at, id", [worldIdValue]),
    rows(db, "SELECT id, email, display_name, credits, role, created_at, updated_at FROM storyhold.players WHERE id = $1 LIMIT 1", [ownerId]),
    optionalRows(db, missingTables, "credit_reservations",
      "SELECT * FROM storyhold.credit_reservations WHERE player_id = $1 ORDER BY created_at, id", [ownerId]),
    optionalRows(db, missingTables, "credit_ledger",
      "SELECT * FROM storyhold.credit_ledger WHERE player_id = $1 ORDER BY created_at, id", [ownerId]),
    rows(db, "SELECT * FROM storyhold.characters WHERE world_id = $1 AND scope_kind = 'world' ORDER BY canonical_key, id", [worldIdValue]),
    rows(db, "SELECT * FROM storyhold.campaigns WHERE world_id = $1 ORDER BY created_at, id", [worldIdValue]),
    rows(db, `SELECT event.* FROM storyhold.world_state_events event
      JOIN storyhold.campaigns campaign ON campaign.id = event.campaign_id
      WHERE campaign.world_id = $1 ORDER BY event.campaign_id, event.sequence_number, event.id`, [worldIdValue]),
    rows(db, "SELECT * FROM storyhold.vault_memory_chunks WHERE world_id = $1 ORDER BY campaign_id NULLS FIRST, state_version, created_at, id", [worldIdValue]),
  ]));

  const campaignTables = await campaignTableRows(db, missingTables, worldIdValue);
  const protectedEntityDossierIds = new Set(
    entities
      .filter((row) =>
        row.classification_source === "user" ||
        row.review_status === "user_confirmed" ||
        row.pull_status !== "active")
      .map((row) => text(row.dossier_id))
      .filter(Boolean),
  );
  const userProtected = {
    canonicalCharacters,
    entities: entities.filter((row) =>
      row.classification_source === "user" || row.review_status === "user_confirmed" || row.pull_status !== "active"),
    dossiers: dossiers
      .filter((row) =>
        (row.user_edited_at !== null && row.user_edited_at !== undefined) ||
        (row.axis_user_override !== null && row.axis_user_override !== undefined) ||
        protectedEntityDossierIds.has(text(row.id)))
      .map((row) => ({
        id: row.id,
        customerProtected: true,
        name: row.name,
        aliases: row.aliases,
        role: row.role,
        summary: row.summary,
        profile: row.profile,
        evidence: row.evidence,
        confidence: row.confidence,
        dossier_status: row.dossier_status,
        axis_user_override: row.axis_user_override ?? null,
        axis_user_changed_at: row.axis_user_changed_at ?? null,
      })),
    relations: relations.filter((row) => row.assignment_source === "user"),
    memberships: memberships.filter((row) => row.assignment_source === "user"),
    rules: rules.filter((row) => row.assignment_source === "user"),
    claims: claims.filter((row) => row.assignment_source === "user"),
    eventParticipants: eventParticipants.filter((row) => row.assignment_source === "user"),
    chapterSummaries: chapterSummaries.filter((row) => row.summary_source === "user"),
    entityActions,
    manualWorldClockEvents: clockEvents.filter((row) => {
      if (row.campaign_id) return false;
      const key = text(row.canonical_key);
      return !key.startsWith("canon-event-") &&
        !key.startsWith("codex-canon-") &&
        !key.startsWith("source-chapter-v1-");
    }),
    discrepancyReports,
    canonAmendments,
    canonIntegritySignals,
    playerCanonIntegrity,
  };
  const campaignState = {
    campaigns,
    worldStateEvents,
    vaultMemories,
    tables: campaignTables,
  };
  const campaignTableSummary = Object.fromEntries(
    Object.entries(campaignTables).map(([table, tableRows]) => [table, fingerprintedRowSet(tableRows)]),
  );
  const sourceInvariant = sourceCorpusInvariant({ sources, chunks, pages });
  const protectedUserCanonInvariant = {
    ...fingerprintedRowSet(Object.values(userProtected).flat()),
    groups: Object.fromEntries(
      Object.entries(userProtected).map(([key, value]) => [key, fingerprintedRowSet(value)]),
    ),
  };
  const campaignInvariant = {
    campaigns: fingerprintedRowSet(campaigns),
    worldStateEvents: fingerprintedRowSet(worldStateEvents),
    vaultMemories: fingerprintedRowSet(vaultMemories),
    tables: campaignTableSummary,
    fingerprint: reviewPacketFingerprint(campaignState),
  };
  const economyInvariant = {
    account: account[0] ?? null,
    reservations: fingerprintedRowSet(creditReservations),
    ledger: fingerprintedRowSet(creditLedger),
    usage: fingerprintedRowSet(aiUsage),
    fingerprint: reviewPacketFingerprint({ account, creditReservations, creditLedger, aiUsage }),
  };

  const currentState = {
    chapterSummaries,
    clockEvents,
    eventParticipants,
    entities,
    dossiers,
    dossierContributions,
    relations,
    memberships,
    rules,
    entityActions,
    claims,
    mentions,
    coreferenceMentions,
    qualityFindings,
    breakdowns,
    characterDrafts,
    cohesionProposals,
    discrepancyReports,
    canonAmendments,
    canonIntegritySignals,
    playerCanonIntegrity,
    analysisRuns,
    analysisCoverage,
  };
  const summary = {
    sources: {
      count: sources.length,
      words: sum(sources, "word_count"),
      characters: sum(sources, "char_count"),
      passages: chunks.length,
      pages: pages.length,
      chapters: chapterSummaries.length,
      processingStatus: countsBy(sources, "processing_status"),
      localReviewStatus: countsBy(sources, "local_scan_status"),
      aiReviewStatus: countsBy(sources, "ai_review_status"),
    },
    entities: {
      count: entities.length,
      byType: countsBy(entities, "entity_type"),
      byPullStatus: countsBy(entities, "pull_status"),
      byReviewStatus: countsBy(entities, "review_status"),
      activeAndPresent: entities.filter((row) => row.pull_status === "active" && row.scanner_present === true).length,
    },
    dossiers: {
      count: dossiers.length,
      byStatus: countsBy(dossiers, "dossier_status"),
      contributions: dossierContributions.length,
    },
    knowledge: {
      relations: relations.length,
      memberships: memberships.length,
      rules: rules.length,
      claims: claims.length,
      claimsByTruthStatus: countsBy(claims, "truth_status"),
      mentions: mentions.length,
      mentionsByResolution: countsBy(mentions, "resolution_status"),
      coreferenceMentions: coreferenceMentions.length,
    },
    chronology: {
      chaptersBySource: countsBy(chapterSummaries, "source_id"),
      chaptersBySummarySource: countsBy(chapterSummaries, "summary_source"),
      clockEvents: clockEvents.length,
      clockEventsByKind: countsBy(clockEvents, "event_kind"),
      eventParticipants: eventParticipants.length,
    },
    quality: {
      total: qualityFindings.length,
      open: qualityFindings.filter((row) => row.finding_status === "open").length,
      bySeverity: countsBy(qualityFindings, "severity"),
      byCategory: countsBy(qualityFindings, "category"),
    },
    analysis: {
      runs: analysisRuns.length,
      runsByStatus: countsBy(analysisRuns, "status"),
      runsByKind: countsBy(analysisRuns, "analysis_kind"),
      coverageRows: analysisCoverage.length,
      coverageByStatus: countsBy(analysisCoverage, "status"),
      latestRun: analysisRuns.at(-1) ?? null,
    },
    economy: {
      accountCredits: number(account[0]?.credits),
      reservations: creditReservations.length,
      creditLedgerEntries: creditLedger.length,
      worldAiUsageEntries: aiUsage.length,
      worldCostMicros: sum(aiUsage, "cost_micros"),
      worldCreditsCharged: sum(aiUsage, "credits_charged"),
    },
    campaigns: {
      campaigns: campaigns.length,
      stateEvents: worldStateEvents.length,
      memoryChunks: vaultMemories.length,
      memoryByKind: countsBy(vaultMemories, "memory_kind"),
      tables: Object.fromEntries(
        Object.entries(campaignTables).map(([key, value]) => [key, value.length]),
      ),
    },
  };

  const packetWithoutIntegrity = {
    schemaVersion: "storyhold.codex-review-packet.v1",
    exportedAt: new Date().toISOString(),
    exportMode: "read-only-transaction",
    dataDirectory: dataDir,
    missingOptionalTables: [...new Set(missingTables)].sort(),
    world,
    editions,
    selectedEditionId: editionId,
    sourceCorpus: { sources, chunks, pages },
    currentState,
    accountAndUsage: { account: account[0] ?? null, aiUsage, creditReservations, creditLedger },
    campaignAndMemory: {
      campaigns,
      counts: summary.campaigns,
      tableFingerprints: campaignTableSummary,
      worldStateEvents: fingerprintedRowSet(worldStateEvents),
      vaultMemories: fingerprintedRowSet(vaultMemories),
    },
    summary,
    invariants: {
      sourceCorpus: sourceInvariant,
      protectedUserCanon: protectedUserCanonInvariant,
      campaignState: campaignInvariant,
      accountEconomy: economyInvariant,
      protectedCombinedFingerprint: reviewPacketFingerprint({
        sourceCorpus: sourceInvariant.fingerprint,
        protectedUserCanon: protectedUserCanonInvariant.fingerprint,
        campaignState: campaignInvariant.fingerprint,
        accountEconomy: economyInvariant.fingerprint,
      }),
    },
  };
  return {
    ...packetWithoutIntegrity,
    integrity: {
      algorithm: "sha256",
      packetFingerprint: reviewPacketFingerprint(packetWithoutIntegrity),
      currentStateFingerprint: reviewPacketFingerprint(currentState),
    },
  };
}

if (!UUID_PATTERN.test(worldId)) throw new Error(`Invalid world UUID: ${worldId}`);
const dataDir = path.resolve(dataDirArgument);
const outputPath = path.resolve(outputArgument);
await ensureClosedExistingDataDirectory(dataDir);

const db = await PGlite.create({ dataDir, extensions: { vector } });
let packet: unknown;
let transactionOpen = false;
try {
  await db.exec("BEGIN TRANSACTION READ ONLY");
  transactionOpen = true;
  packet = await exportPacket(db, worldId, dataDir);
  await db.exec("ROLLBACK");
  transactionOpen = false;
} finally {
  if (transactionOpen) await db.exec("ROLLBACK").catch(() => undefined);
  await db.close();
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
const normalizedPacket = packet as {
  summary: { sources: { count: number; words: number; passages: number } };
  integrity: { packetFingerprint: string };
};
process.stdout.write(
  `Exported ${normalizedPacket.summary.sources.count} sources, ` +
    `${normalizedPacket.summary.sources.words} words, and ` +
    `${normalizedPacket.summary.sources.passages} passages to ${outputPath}.\n` +
    `Packet fingerprint: ${normalizedPacket.integrity.packetFingerprint}\n`,
);
