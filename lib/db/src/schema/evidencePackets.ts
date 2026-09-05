import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  uuid,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// --- Evidence packets (Task #200) --------------------------------------
// A cheap-AI editorial screen applied to an already-qualified story cluster.
// The screen makes a FORCED editorial decision (a strict enum — never a
// "maybe") and captures the evidence it reasoned over in an IMMUTABLE,
// VERSIONED packet: rows are insert-only, one per (cluster_id, version), so a
// packet is a durable snapshot of what the sources looked like at decision
// time. Re-screening a cluster whose sources changed inserts a NEW version; the
// old versions are never mutated. The packet is authority-ordered and carries
// extracted claims, contradictions, quote candidates, timestamps and the
// retrieval context (what the vault-first gate found before any paid research).
//
// Contract-first schema; the table + indexes are also created idempotently at
// boot by ensureRuntimeTables (services/seed.ts) so fresh/reset dev DBs heal
// without a manual `push`. NO paid AI is stored here beyond the recorded model.

// The forced editorial verdict. There is no "maybe": every screen resolves to
// exactly one of these. reject_* = do not cover (with a do-not-draft reason);
// approve_research = worth pursuing but needs more sourcing before drafting;
// approve_draft = ready to draft; needs_human_editor = the model is not
// confident enough to auto-decide and defers to an editor.
export const EVIDENCE_DECISION = [
  "reject_duplicate",
  "reject_too_thin",
  "reject_low_authority",
  "reject_stale",
  "reject_out_of_beat",
  "reject_too_risky",
  "approve_research",
  "approve_draft",
  "needs_human_editor",
] as const;
export type EvidenceDecision = (typeof EVIDENCE_DECISION)[number];

// How much research the packet build actually used. vault_only = only the
// newsroom's own memory (chunks + existing articles + prior packets), no paid
// call. sonar = one paid Perplexity Sonar call. deep_research = the (slower,
// pricier) sonar-deep-research model. Deep research is OFF by default; the
// vault-first gate only escalates to a paid mode when explicitly requested and
// within budget.
export const EVIDENCE_RESEARCH_MODE = ["vault_only", "sonar", "deep_research"] as const;
export type EvidenceResearchMode = (typeof EVIDENCE_RESEARCH_MODE)[number];

// The editorial role a source plays inside a packet. Assigned deterministically
// at packet-build time from its authority tier + whether it mentions the story's
// required entities. `core_evidence` and `primary_record` are the only roles
// that count toward the packet-locking gate; framing/context roles ride along
// for the writer; `background_only` marks topic-adjacent sources that never
// mention the main entity/event (kept sparingly, never gate-counted).
export const PACKET_SOURCE_ROLE = [
  "core_evidence",
  "primary_record",
  "prosecution_framing",
  "defense_or_advocacy_framing",
  "reported_context",
  "background_only",
] as const;
export type PacketSourceRole = (typeof PACKET_SOURCE_ROLE)[number];

// A source snapshotted into a packet, ordered strongest authority first.
// `role` is optional: packets built before role assignment existed have none.
export interface PacketSource {
  id: string;
  url: string;
  domain: string;
  title: string | null;
  author: string | null;
  authorityTier: string;
  lifecycleStatus: string;
  publishedAt: string | null;
  fetchedAt: string | null;
  excerptOnly: boolean;
  paywallDetected: boolean;
  sourceFamilyId: string | null;
  role?: PacketSourceRole | null;
}

// A supporting text chunk retrieved from the vault for this cluster's topic.
export interface PacketChunk {
  chunkId: string;
  documentId: string;
  content: string;
  similarity: number;
}

// An extracted factual claim + the packet sources (by id) that support it.
export interface PacketClaim {
  text: string;
  sourceIds: string[];
}

// A conflict between sources (e.g. differing figures/timelines).
export interface PacketContradiction {
  summary: string;
  sourceIds: string[];
}

// A candidate quotation: exact text + attribution + the source it came from.
// offsets are populated only WHERE AVAILABLE (the vault stores chunk text, not
// character offsets, so these are null today). `verified` = the exact text was
// found in the stored source; `allowedToQuote` additionally requires the source
// policy to permit quoting (active, fetch-allowed, not paywalled).
export interface PacketQuote {
  text: string;
  attribution: string;
  sourceId: string | null;
  offsetStart: number | null;
  offsetEnd: number | null;
  verified: boolean;
  allowedToQuote: boolean;
}

// What the vault-first gate found before (and whether it escalated to) paid
// research — recorded for transparency and reproducibility.
export interface PacketRetrievalContext {
  query: string;
  vaultHitCount: number;
  existingArticleTitles: string[];
  priorPacketVersion: number | null;
  priorDecision: string | null;
  sonarUsed: boolean;
  researchNote: string | null;
  generatedAt: string;
  // Entities/event terms extracted from the idea that every core source must
  // mention (relevance gate). Optional: legacy packets predate the gate.
  requiredEntities?: string[];
}

export const evidencePacketsTable = pgTable(
  "evidence_packets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // The cluster this packet screens (no DB FK to keep boot-DDL healing simple
    // — set null / left dangling in app on cluster delete).
    clusterId: uuid("cluster_id").notNull(),
    // Monotonic per-cluster version (1, 2, 3, …). Rows are insert-only, so the
    // highest version for a cluster is its current packet.
    version: integer("version").notNull(),
    // Snapshot of the cluster's beat + label at decision time (immutable).
    beatSlug: text("beat_slug").notNull(),
    beat: text("beat").notNull(),
    label: text("label").notNull(),

    decision: text("decision", { enum: EVIDENCE_DECISION }).notNull(),
    decisionReasons: jsonb("decision_reasons").$type<string[]>().notNull().default([]),
    // Populated for every reject_* / needs_human_editor decision (why NOT to
    // draft). Null when the decision is approve_draft.
    doNotDraftReason: text("do_not_draft_reason"),

    researchMode: text("research_mode", { enum: EVIDENCE_RESEARCH_MODE })
      .notNull()
      .default("vault_only"),
    // The AI model that made the decision (for cost/quality attribution).
    model: text("model").notNull(),

    sources: jsonb("sources").$type<PacketSource[]>().notNull().default([]),
    supportingChunks: jsonb("supporting_chunks").$type<PacketChunk[]>().notNull().default([]),
    claims: jsonb("claims").$type<PacketClaim[]>().notNull().default([]),
    contradictions: jsonb("contradictions").$type<PacketContradiction[]>().notNull().default([]),
    quoteCandidates: jsonb("quote_candidates").$type<PacketQuote[]>().notNull().default([]),
    retrievalContext: jsonb("retrieval_context")
      .$type<PacketRetrievalContext>()
      .notNull()
      .default({
        query: "",
        vaultHitCount: 0,
        existingArticleTitles: [],
        priorPacketVersion: null,
        priorDecision: null,
        sonarUsed: false,
        researchNote: null,
        generatedAt: "",
      }),

    // Fingerprint of the member sources at build time (ids + lifecycle + updated
    // timestamps). The auto-screen skips rebuilding when the latest packet's
    // fingerprint is unchanged, so a stable cluster is screened only once.
    sourcesFingerprint: text("sources_fingerprint").notNull().default(""),
    sourceCount: integer("source_count").notNull().default(0),
    topAuthorityTier: text("top_authority_tier"),

    // Source retraction impact (Task #329). Set to true when the retraction
    // cascade detects that one or more sources snapshotted in this packet have
    // transitioned to a non-active lifecycle status (retracted / unavailable /
    // stale / superseded). Packets are insert-only (rows are never mutated after
    // creation), but this mutable flag sits outside the snapshot semantics: it
    // is a live health signal, not part of the immutable decision record. The
    // flag is purely advisory — the packet's decision stands; editors use it to
    // know which packets may need a fresh screen.
    stalePacket: boolean("stale_packet").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("evidence_packets_cluster_version_key").on(t.clusterId, t.version),
    index("evidence_packets_cluster_idx").on(t.clusterId),
    index("evidence_packets_decision_idx").on(t.decision),
    index("evidence_packets_created_idx").on(t.createdAt),
  ],
);

export const insertEvidencePacketSchema = createInsertSchema(evidencePacketsTable).omit({
  id: true,
  createdAt: true,
});
export type EvidencePacket = typeof evidencePacketsTable.$inferSelect;
export type InsertEvidencePacket = z.infer<typeof insertEvidencePacketSchema>;
