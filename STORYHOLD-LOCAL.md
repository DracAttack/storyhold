# Storyhold local test environment

On Windows, double-click `Start Storyhold.cmd` in the repository root. It starts Storyhold in the background and returns immediately; use `Stop Storyhold.cmd` when you want to shut it down.

To connect AI, double-click `Configure Storyhold AI.cmd`. The first run creates a private settings file and opens it in Notepad. Paste one or more provider keys, save, then stop and restart Storyhold. The private settings file is ignored by Git.

The command-line alternative is:

```powershell
pnpm run storyhold:local
```

Then open <http://127.0.0.1:3000/> for the customer-facing Storyhold site.

The customer site is split into Home (`/`), Play (`/play`), and Credits (`/credits`). Signed-in customers also have a private Profile (`/profile`), My Worlds (`/profile/worlds`), and Import Writing (`/profile/import`). The local build cannot take payment; the pricing cards are there to test the commercial path and wording.

Creator world management remains at <http://127.0.0.1:3000/admin/worlds> for owner, admin, and creator accounts.

The default local-only account is:

- Email: `admin@storyhold.local`
- Password: `storyhold-dev`

The command builds the current frontend, starts the safe Storyhold backend, and keeps all data under `.storyhold-data`. Stop it with `Ctrl+C`; the data remains for the next run.

## What local mode does

- Runs on `127.0.0.1`, so it is available only on this PC.
- Replaces the imported public publishing site with Storyhold's customer landing page and redirects retired public article, category, glossary, and policy URLs back to it.
- Creates permanent player IDs with 40 starter credits. Ordinary player accounts cannot enter the creator workspace.
- Offers four free scene turns. A supported WebGPU browser uses the private cached Qwen model and spends no provider credits; unsupported browsers fall back to a connected storyteller. Browser preview state remains local to that page.
- Disables live play when no model provider is connected instead of presenting a deterministic or canned response as Storyhold gameplay.
- Keeps manuscript upload strictly inside the signed-in customer profile. A player can create a canonically isolated world, preserve an uploaded manuscript, run the first source pass, and see the initial characters, locations, factions, themes, and summary in My Worlds.
- Stores each credit balance on the player's account. Anonymous visitors can see preview packages but cannot add credits or import a world.
- Uses an embedded PostgreSQL-compatible database with pgvector.
- Enables Storyhold login, sessions, canonical player IDs, the shared vault schema, immutable starting contracts, and append-only state events.
- Creates multiple canonically isolated worlds inside the one shared vault.
- Runs campaign turns through a provider-neutral AI gateway, validates the proposed result, then stores the transcript, state changes, clock events, and compact memories under the canonical player, world, edition, campaign, and character IDs.
- Generates luck on the server before the AI call. The model can interpret a roll, but it cannot secretly reroll it, rewrite a locked start, or invent different ownership IDs.
- Shows players their visible history and promises while keeping unrevealed scheduled effects private. Hidden events can become visible only when their reveal conditions are reached.
- Charges one Storyhold credit only after an ordinary player's turn succeeds. Owner and admin accounts are unlimited in local development.
- Preserves uploaded source files and extracts PDF, EPUB, DOCX, Markdown, TXT, PPTX, XLSX, and OpenDocument formats into evidence-addressable passages.
- Automatically performs a private local inventory after relevant uploads and builds reviewable world breakdowns and character drafts. An extracted draft cannot silently become canon; approval creates a locked canonical character origin.
- Tracks every source by content fingerprint and analysis version. New or changed material is queued independently, so unchanged books do not need to be sent through the model again.
- Keeps unreviewed material in a durable AI backlog. When a provider is connected and Storyhold restarts, that backlog is picked up without re-uploading the files.
- Stores possible contradictions and continuity problems in a separate cohesion inbox. Classifying a proposal records a human decision but never edits canon automatically.
- Separates the creator workshop from the player-facing discrepancy injector. Players describe what seems inconsistent; they do not maintain source records or approve background analysis queues.
- Resolves evidence-backed discrepancy reports through append-only canon amendments. Original books, locked character origins, and locked campaign starts are never rewritten.
- Requests a continuity reason when source evidence is insufficient. Strong logical impossibilities can create an amendment; unsupported override attempts are rejected and recorded in an internal integrity ledger.
- Raises the internal evidence threshold after repeated unsupported or advantage-seeking override attempts. This integrity state is scoped by canonical player, world, and campaign IDs and is not shown as a punitive score in the player interface.
- Does not start the imported publishing, newsletter, social, cron, or AI automation jobs.
- Keeps the imported BrainHook admin pages available for capability auditing.

Image-only scanned PDFs currently need OCR before Storyhold can read their text. The upload remains recorded with a visible extraction warning.

## How AI works during development

Codex is used to build and test Storyhold, but this chat is not embedded in the running site.

With no model credentials, Storyhold runs a private development scanner automatically after upload. It extracts and chunks every document, identifies recurring terms, and creates reviewable character/name, location, and faction candidates without sending source text off this computer. The source remains marked `Waiting for AI review` after that local pass. This is useful for testing storage, retrieval boundaries, review, and canon promotion, but it does not perform deep character inference.

Signed-in campaign play still requires a connected premium storyteller. The browser model is a retrieval auditor and free-preview storyteller, not a silent replacement for premium campaign narration. It can identify references and retrieval questions before a turn; the server independently resolves those leads through locked canon.

## Lorekeeper local-first sequence

Canon Intake and play now use a layered system rather than making the largest
model rediscover every mechanical fact:

1. Deterministic parsing extracts structure, headings, exact mentions, and hard rules.
2. The loopback GLiNER2 pass proposes Storyhold-native entities, relations, intents, claims, actions, and state changes with exact evidence.
3. FastCoref links pronouns and abbreviated references to candidate identities without merging the candidates by itself.
4. NLI checks proposed literal relationships against their exact passages and separates support, contradiction, and uncertainty.
5. MiniLM ranks the full evidence pool quickly; BGE then gives the retained evidence a slower, higher-precision ordering.
6. Local Qwen synthesizes the ranked chapter evidence into reader-facing dossiers. A supported browser may perform an additional durable WebLLM audit, but neither local model can silently write canon.
7. The optional connected verifier reads the original evidence, checks every promoted finding, searches for omissions, and performs the final cross-book synthesis only after the local world is openable.
8. Campaign retrieval combines direct canonical lookup, aliases, one-hop graph expansion, lexical search, local embeddings, reciprocal-rank fusion, coverage checks, diversity selection, and extractive passage trimming before premium narration.
9. GLiNER2 reads the resulting scene again for unmodeled relationship and state-change leads. Those leads are stored in the turn receipt and never silently alter canon.

The broad search pool is deliberately much larger than the final prompt. A
typical turn may inspect hundreds of lexical/vector candidates and send only
18–32 diverse, evidence-centered passages after entity and coverage checks.
Scene packets are cached by campaign state and query, while internal traces
record cache use, candidate/selection counts, coverage, elapsed time, and the
local pre/post-check receipts. Provider usage remains in the private economy
ledger; customer credits buy the Storyhold experience, not a pass-through
receipt for a particular model bill.

Canon Intake is metered instead of carrying a flat product fee. Internally,
Storyhold calculates local extraction/index work from words, passages, and
sources; browser Qwen from its compact input/output units; and connected AI
from verified provider usage. Connected AI credit conversion is clamped to a
minimum 40% gross margin. The customer sees only one combined Storyhold-credit
amount, not component costs, model receipts, or margin data. Durable stage
receipts keep a failed/restarted pass from buying completed work twice.

Browser weights download on first use and remain in the browser cache when the
browser permits it. During Canon Intake the page explicitly asks the customer
to keep the page and browser open; every finished audit batch is saved, and the
world button remains disabled until local reading, browser audit, and connected
verification have actually completed.

Thumb feedback has two separate consent paths. Anonymous learning stores only
aggregate structural patterns—never prose, names, worlds, notes, or account
IDs. A second explicit setting can retain rated turns in a private, held
fine-tuning dataset. Held examples are not exported or trained automatically,
and revoking that setting deletes unapproved held examples.

Storyhold can connect to OpenAI, Anthropic, xAI, and Moonshot/Kimi. It can route narration, document analysis, and canon review to different providers, then fall back to another configured provider if the first connection fails. Routine play uses lower reasoning; uncertain, tactical, continuity-sensitive, or suspected rule-breaking actions automatically receive a deeper reasoning pass. Adult-mode requests use a deliberately narrow provider route instead of silently failing over to providers with different content rules.

When any supported provider is configured, Storyhold changes to connected analysis. Existing waiting sources are reviewed automatically after startup; future uploads are reviewed automatically after local indexing. It sends bounded, evidence-labelled source batches to the selected model, merges incremental results into the draft world model, and retains source passage IDs on the findings. Whole novels are processed across batches rather than placed into one enormous prompt. Provider charges apply, and the source text in each batch leaves this computer.

Perplexity is kept separate from the storyteller. It can provide paid search and embeddings for inherited Source Vault research and retrieval, but outside information never becomes a player's canon merely because a search result said it. Storyhold's free local embedding model remains the default.

An automatic connected pass only includes source fingerprints that are new, changed, or older than the current analysis version. The **Run full cohesion check** button deliberately rechecks all included sources and asks for confirmation before starting a billable full pass.

## Player discrepancy flow

The test version of the player-facing injector is visible near the top of each World Studio detail page:

1. The player enters one plain-language description of what does not add up.
2. Storyhold searches only that player's canonical world, edition, campaign, amendments, and locked event history.
3. Direct source support produces a proposed amendment the player can apply.
4. If evidence is insufficient, Storyhold asks why the existing fact cannot be right.
5. A strong consistency argument, such as a birth year occurring after the story begins, creates an append-only amendment automatically while leaving the exact unknown fact unresolved.
6. An unsupported explanation changes nothing. The attempt is recorded internally; repeated unsupported attempts increase the evidence threshold for that player in that world or campaign.

Campaign-scoped amendments also append a `canon_correction` world-state event and advance the campaign state version. They cannot mutate the locked campaign start contract. Creator retcons should eventually use a separate authorized editioning interface so legitimate authorship is never confused with player manipulation.

The simplest setup is to double-click `Configure Storyhold AI.cmd` and fill in one or more of these lines:

- `STORYHOLD_OPENAI_API_KEY` or `OPENAI_API_KEY`
- `STORYHOLD_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY`
- `STORYHOLD_XAI_API_KEY` or `XAI_API_KEY`
- `STORYHOLD_KIMI_API_KEY`, `KIMI_API_KEY`, or `MOONSHOT_API_KEY`
- `PERPLEXITY_API_KEY` for optional search and paid Source Vault embeddings

Optional routing settings include `STORYHOLD_NARRATOR_PROVIDER`, `STORYHOLD_ANALYSIS_PROVIDER`, `STORYHOLD_CANON_PROVIDER`, `STORYHOLD_ADULT_PROVIDER`, and `STORYHOLD_AI_FALLBACKS`. The example file documents all model overrides. Replit Secrets can use the same names later; the existing Replit Anthropic integration names remain supported.

Never commit or paste a real API key into a tracked repository file. `.storyhold.env` is intentionally ignored by Git.

### Private local GLiNER2 intake pass

Storyhold includes a managed GLiNER2 service for the inexpensive Canon Intake
stage. Unlike ordinary named-entity tools that recognize only people, places,
and companies, GLiNER2 receives Storyhold's current ontology:
characters, places, factions, institutions, governments, power structures,
creatures, species, technologies, vehicles, devices, weapons, powers, and
titles. It also proposes typed directional relationships such as literal family,
membership, species, form, title, power, control, location, and creation links.
Every result retains exact source evidence and remains a candidate until the
connected reviewer verifies meaning, direction, chronology, and omissions.

Install the pinned local runtime and base model once:

```powershell
.\scripts\install-storyhold-gliner.ps1
```

The normal Storyhold launcher then starts and stops the loopback service. Its
default settings are:

```text
STORYHOLD_LOCAL_NER_ENABLED=true
STORYHOLD_REQUIRE_FULL_LOCAL_INTAKE=true
STORYHOLD_LOCAL_ACCELERATION=auto
STORYHOLD_LOCAL_GLINER2_ENABLED=true
STORYHOLD_LOCAL_GLINER2_URL=http://127.0.0.1:8765/gliner2
STORYHOLD_LOCAL_GLINER2_MODEL=fastino/gliner2-base-v1
STORYHOLD_LOCAL_NER_URL=http://127.0.0.1:8765/gliner2
STORYHOLD_LOCAL_NER_MODEL=fastino/gliner2-base-v1
STORYHOLD_LOCAL_MINILM_ENABLED=true
STORYHOLD_LOCAL_MINILM_URL=http://127.0.0.1:8765/rerank/fast
STORYHOLD_LOCAL_MINILM_MODEL=cross-encoder/ms-marco-MiniLM-L6-v2
STORYHOLD_LOCAL_RERANKER_ENABLED=true
STORYHOLD_LOCAL_RERANKER_URL=http://127.0.0.1:8765/rerank/final
STORYHOLD_LOCAL_RERANKER_MODEL=BAAI/bge-reranker-v2-m3
STORYHOLD_LOCAL_BGE_MODEL=BAAI/bge-reranker-v2-m3
STORYHOLD_LOCAL_NLI_ENABLED=true
STORYHOLD_LOCAL_NLI_URL=http://127.0.0.1:8765/nli
STORYHOLD_LOCAL_NLI_MODEL=cross-encoder/nli-deberta-v3-xsmall
STORYHOLD_LOCAL_COREFERENCE_ENABLED=true
STORYHOLD_LOCAL_COREFERENCE_URL=http://127.0.0.1:8765/coreference
STORYHOLD_LOCAL_COREFERENCE_MODEL=biu-nlp/f-coref
STORYHOLD_LOCAL_QWEN_ENABLED=true
STORYHOLD_LOCAL_QWEN_URL=http://127.0.0.1:8765/qwen/audit
STORYHOLD_LOCAL_QWEN_MODEL=Qwen/Qwen3.5-4B-Instruct
STORYHOLD_LOCAL_QWEN_GPU_LAYERS=32
STORYHOLD_LOCAL_QWEN_BATCH_SIZE=512
STORYHOLD_LOCAL_QWEN_MICRO_BATCH_SIZE=128
STORYHOLD_LOCAL_QWEN_OFFLOAD_KQV=true
STORYHOLD_LOCAL_QWEN_VULKAN_DEVICE=1
STORYHOLD_LOCAL_MODELS_ALLOW_REMOTE=false
```

The runtime and models live under the ignored `.storyhold-runtime` directory.
The installer is the only step allowed to contact package/model hosts. Normal
Storyhold startup is offline and accepts only loopback endpoints. Canon Intake
runs the deterministic baseline, GLiNER2, FastCoref, NLI, MiniLM, and BGE in
sequence before Qwen synthesizes the promoted, evidence-bound candidates.
GLiNER 1 is not run in front of GLiNER2: the Storyhold ontology needs GLiNER2's
structured entity, relationship, and classification output, while the older
pass added substantial duplicate work. Qwen prefers the in-browser WebGPU
runtime on capable devices and automatically uses the installed local Q4_K_M
build of Qwen 3.5 4B Instruct when browser acceleration is unavailable.
The connected premium verifier remains a separate, optional decision after the
local world is openable. Only one local server model stays resident at a time.
`auto` uses CUDA when available
and otherwise CPU without changing model weights or skipping a stage. A missing
or incomplete required stage stops the intake visibly so a baseline-only result
cannot be mistaken for the completed product.

### Premium Review Recovery

Owner-started premium world reviews journal every request before dispatch and
save accepted responses and usage before updating coverage or canon. These
server-side records contain manuscript evidence and must remain private.
Journaled calls permit only one provider attempt; they do not silently retry
or switch providers.

An exact completed request can be read back from its journal without another
provider call, after integrity and current response validation checks. A changed
request, uncertain provider outcome, or missing durable response blocks automatic
redispatch. Earlier successful batches remain included in failed-run accounting.
Credit holds marked for reconciliation do not expire automatically; a new premium
review of that world is blocked while a provider outcome or retained hold remains
unresolved.

New premium runs freeze their selected passages, exact verification batches,
world context, model, partial-review flags, evidence fingerprint, and original
credit reservation before the first request. After an interruption or restart,
Storyhold leaves the review paused. The owner's Resume action restores that same
plan and hold, validates and replays completed responses, then sends only steps
not yet dispatched. It does not recompute a smaller review from the account's
already-reduced spendable balance, reset saved coverage, or reserve credits twice.

Resume requires a contiguous completed journal, unchanged evidence/owner guidance,
compatible execution version and model, usable recorded costs, and an original
hold that has not been settled or released. Current quoted costs must still fit
that hold before another request is dispatched. A temporary connection problem
leaves the plan available for another explicit Resume check. Uncertain, rejected,
or corrupted records remain blocked for reconciliation, not automatically retried.
Older reviews without a frozen plan are not retroactively declared resumable.
New mandatory-plan holds can be refunded if both plan and journal prove that work
stopped before its first dispatch; legacy holds are not assumed safe to refund.

Owners and administrators can open **Premium Recovery** in the private admin
workspace (`/admin/premium-recovery`). It shows recorded provider usage and the
original credit hold without exposing manuscript prompts or model responses.
Inspection alone never changes billing. A live worker, altered record, missing
original plan, or finalized/mismatched hold blocks settlement.

To permanently close an inactive review, inspect its latest state, check the
provider's records, and explicitly attest to every unresolved step with its
total charge (including already-recorded attempts) and a provider evidence
reference. Missing responses are not evidence of zero cost. An audit note and
final confirmation are required. The transaction settles only confirmed usage,
refunds unused reserved credits, and saves an append-only operator receipt.
It cannot debit beyond the original hold. An identical repeated submission
returns the same receipt; changed or stale submissions cannot charge again.

Finalization preserves the original journal and evidence, closes that run
permanently, and does not call AI or promote canon. A fresh premium review may
start only after all unresolved billing for that world is reconciled. Live
paused workers must stop safely before this operator workflow can be used.
Legacy/ambiguous funding, corrupted records, and costs exceeding the original
hold remain blocked for separate investigation. Do not clear journal rows or
release held credits merely to retry. Detached audit receipts survive world
deletion; deleting a world with active work or unresolved billing is blocked.
These worker-liveness checks target the current single-server local runtime.
Hosted or multi-process workers require durable worker leases and coordinated
cancellation before the same operator workflow is enabled across hosts.

Recovery regressions use simulated provider records, not paid inference.

### Premium Claim and Graph Verification

The existing premium batch call now requires a separate explicit decision for
every atomic claim supplied in its bounded candidate packet. A claim's subject,
predicate, value, polarity, epistemic holder, truth status, temporal boundaries,
and supersession target are fingerprinted together. Corrected or newly discovered
claims require their own decision and exact manuscript citations. A verified
belief remains a belief; it is not silently converted into objective fact.

Only `verified` decisions materialize claims. `rejected`, `disputed`,
`insufficient_evidence`, and `needs_more_evidence` remain in private receipts;
they do not authorize canon writes or automatically retrieve more sources.
Outside references and local candidate prose cannot supply manuscript evidence.
Malformed quotes, missing decisions, changed payloads, mixed scopes, and obsolete
response contracts fail closed. A syntactically valid quote is provenance, not
proof that the model's interpretation is correct; semantic quality still needs
evaluation against real manuscripts.

Validated packets and decisions are saved immutably inside the canon-save
transaction. Paid-call completion timestamps are server-stamped in the original
journal and reused on replay. Existing customer-owned claims remain protected.
Claims actually saved by that run receive an immutable link from their canonical
claim ID to the exact proposal, verifier decision, and reviewed payload. Unresolved
names and protected owner records cannot be mislabeled as new AI promotions.
Omitting or deferring a claim does not erase prior generated canon; a supported,
explicit supersession can still replace an earlier claim.

Structured relationships and entity rules/abilities now require their own
explicit decisions in the same premium call. Direction, status, time interval,
rule kind, trigger, effect, and descriptive wording are part of the reviewed
payload. Separate historical intervals remain separate relationships. Existing
deterministic relationship checks are vetoes: a verifier cannot promote a
figurative parent as a literal one or silently change a reviewed relationship's
meaning during persistence. Validated decisions are saved in immutable graph
receipts; actual canonical relation/rule IDs link to the exact decisions that
authorized them. Discarded paraphrases retain their own supporting evidence and
count toward verified passage coverage without borrowing citations for another
wording.

The paid path no longer creates faction memberships from free-form dossier
text. A membership needs a separately verified, active, undated `member_of`
relationship. Dated or former memberships remain in the relationship graph
without becoming timeless faction membership rows. Missing or deferred graph
findings do not delete previous generated relationships or rules; owner edits
remain protected. Premium review omission also must not hide existing graph
endpoints, suppress their dossiers, or erase their source contributions. An
owner's deliberate hide is still respected. Conflicting verified rules are held
for review with the actual competing descriptions, conditions, and effects
shown. A changed existing verified rule requires resolution rather than silent
replacement. A single active, unedited local rule is still a baseline proposal:
premium verification may correct it and records the exact decision authorizing
that upgrade. Retired rules, owner edits, and ambiguous existing variants remain
protected.

Premium world reviews now also require explicit decisions for meaningful stat
estimates. Each proposal binds the finding family, exact entity name, stat,
integer score, and complete rationale. Neutral unknown placeholders do not
require decisions. A verified estimate needs exact manuscript evidence; the
review prompt distinguishes observed actions from hypothetical abilities,
transformed states, and abilities that change over time. Scores remain game
estimates, not facts mathematically entailed by a passage. Live calibration is
still required.

Raw scores in ordinary model-returned dossiers cannot bypass this contract.
Verified estimates are re-projected after linked-body inference and again after
named-entity reclassification, so an inherited or reclassified score cannot
borrow another entity family's approval. Conflicting verified score/rationale
variants remain in receipts without selecting a winner. Identical variants
select one exact verified payload; their confidence/evidence are not combined
into an unreviewed value. Projection requires an exact name/family and a returned
ordinary record; omitted or renamed records can have durable decisions without
receiving updates. Deferred-application diagnostics remain to be added.

Stat receipts are immutable and saved in the same transaction as canon writes.
Links record the actual canonical entity/dossier ID and exact authorizing
decision only when the persisted estimate matches. Protected owner records,
inactive/ambiguous records, and mismatches do not receive links. World-rule
estimates have receipts but no entity link because that finding family has no
standalone canonical entity mapping. Rejected or omitted estimates do not erase
existing local/owner values, and preserving an old value does not newly verify
it. A reviewed correction can replace a higher-confidence old generated score.

Individual premium dossier reruns now use the same explicit stat-decision
contract in their existing single provider call. Two fixed internal groups
(six stats plus acrobatics) cover all seven stats without adding another model
stage or rereading the sources in a second request. Quote and execution share
the exact prompt builder and reserve 2,500 additional reply tokens for these
decisions (6,000 total for focused; 9,500 for full). These are maximum reply
allowances, not measured usage or flat customer charges. Non-stat cultural
reference and term reviews retain their original reply allowances. Each new
estimate is bound to the unchanged canonical entity ID, name, category, world,
edition, review UUID, selected source text, and supplied owner direction. Raw
ordinary estimates cannot bypass the gate. A stat-only response can succeed
with a verified estimate; empty/rejected-only output without useful findings
does not count as a successful dossier review.

The two dossier stat groups share one printed contract rather than two copies.
Their separate fingerprints, all candidate payloads across seven stats, prior confidence and
in-scope candidate citation links remain present. Full manuscript passages still
appear once. The premium response schema now requests verified stat decisions
directly instead of first requesting raw scores and then overriding that request.
Legacy/local schema behavior and world-review prompt defaults are unchanged.
This changes prompt rendering, not receipt fingerprints, saved-response validation,
model selection, reply allowances, or the number of AI calls. A synthetic 14/28-
passage, seven-stat creature fixture shrank from 32,613/48,061 to 28,152/43,600
prompt characters (13.7%/9.3%). These are character measurements, not provider
token counts or a production cost/latency benchmark. Throwaway instruction-string
building and a duplicate same-boundary receipt check were also removed; independent
provider-response, saved-data and canonical-write validations remain.

World review and individual dossier persistence share the current-faction
membership projection rule. Former, disputed, conditional, unknown and dated
links remain relationships without becoming timeless current membership rows.
Only a character or creature linked to a faction can create those rows; alias
labels resolve through canonical endpoint IDs before their types are checked.
Existing owner-assigned memberships are preserved. This prevents a chronology
flattening bug; it is not the still-pending full dossier graph-decision gate.

Dossier stat receipts and application links have their own immutable tables;
they do not manufacture intake runs. Persistence locks/rechecks the target and
character dossier, and rechecks every selected manuscript passage and its
source eligibility before saving premium output. Renamed/reclassified,
merged/hidden/deleted targets and changed/removed/excluded source passages fail
before saving. Owner edits and omitted estimates remain intact. Browser/server
Qwen reviews keep their existing source-citation checks and remain available
without premium receipts. New local scores remain provisional, and a local
rerun cannot overwrite a current exact premium-receipt-backed score (whether
approved by world intake or a dossier rerun). An old link does not protect a
later changed value as though that value had been reviewed.

Private stat-contract diagnostics remain in server logs rather than customer
error messages. These checks operate on the dossier route's selected passages;
they do not make focused/full retrieval exhaustive or independently establish
the literary accuracy of an interpretation.

Individual paid dossier calls now have a separate durable provider-call journal.
Before dispatch, the exact request, source/context snapshot, canonical revision,
account/entity/edition scope and original credit reservation are saved. Only one
unfinalized paid call per entity can dispatch. Dossier requests disable provider
fallback and SDK retries; a failure does not silently start another billable
attempt. Local Qwen behavior when no premium provider is configured is unchanged.

Completed responses are saved before canonical application. Reopening Review This
Dossier finds the pending review and offers Resume Saved Review using its original
depth and directions, even if the provider configuration has since changed. Resume
follows the dossier's original edition, not a subsequently changed world default.
It does not invoke a provider or browser model, reserve again, or re-read a different
selection of evidence. Canon writes, all known-attempt usage rows, credit settlement
and the immutable client outcome commit together. A failed save rolls them back
while preserving the paid response for retry. Repeated successful submissions
return the same saved outcome, not another charge or canonical update.

Application compares the frozen story state against current target/dossier content,
owner directions, entity identities/aliases, incident relationships, rules,
memberships, source inventory/chronology, selected passage contents and world
premise. Changed canon prevents the older response from applying. Known completed
or rejected usage can still be settled exactly once without applying that response.
Actual routed models and every known attempt remain in the private usage ledger.
Owner/admin accounts record usage with zero charged credits.

A timeout, transport failure or lost response with uncertain usage is not treated
as a free failure. Its hold remains retained and automatic retries are blocked.
This journal cannot recover response bytes that never reached durable storage;
those outcomes need explicit provider reconciliation. An operator reconciliation
workflow for these new individual-dossier records is still pending; the existing
world-review recovery screen does not yet manage them. No automatic refunds or
speculative redispatches are enabled for them.

Offline verification for this iteration: 626 passing regression tests covering
world review, dossier stat validation, saved calls, accounting, canonical state
checks and gateway behavior, plus 10 route/UI source-wiring guards. API and site
TypeScript checks pass. Source-wiring guards are not HTTP/browser integration
tests; no live provider or live-world migration was run for this iteration.

Unlike world review, individual reruns still use their older claim/relationship/
rule verification path. Generated dossier prose continues to use the existing
evidence validation: these gates do not yet independently verify every biography
sentence, alias/identity assertion, free-form relationship description,
socio-political estimate, or synthesized chronology event. Historical receipt
links are audit history, not a blanket verification of later dossier edits.

Claim, graph, and stat decisions share each verification call; there is no second paid
extraction pass. Relevant local findings are collected before sizing, without
the former 64,000-character selection cutoff. Frozen pages contain at most six
finding entries and 64,000 JSON characters each, across all finding families:
claims, relationships, rules, individual stats, characters, places, chapter/event summaries, and
the other ordinary findings. Exact duplicate candidate JSON may be shared, but
distinct payloads, evidence, and confidence are retained. In-batch citations
are no longer reduced to four references; citations outside that source batch
are still excluded. Summary/genre/atmosphere/theme context keeps its existing
short excerpts; it is not an authoritative full-book finding inventory. Each
meaningful stat is its own work unit; ordinary record units omit estimates, and
stat-only units carry minimal identifying wrappers, not duplicated biographies.

Each page receives the full original source batch. The first page also performs
source discovery; later pages may return only their assigned ordinary finding
families plus explicit claim/graph/stat decisions and coverage. They cannot rewrite
world metadata or unassigned finding families. Sources with no relevant
candidates still receive one source-reading page. A single finding too large
for an otherwise empty page fails before dispatch; it is never truncated or
silently skipped. Splitting such an individual record into linked review units
is not yet implemented.

Every page's actual prompt and 16,000-token reply allowance are reserved.
Chronology retains its 8,000-token cap, with group limits based on source batches,
not candidate-page count. Dense packets therefore incur additional verification
calls and repeated source context; the reservation includes that overhead.
Missing saved local findings prevent a premium reservation.

Page preparation snapshots and packs each source inventory once per invocation,
instead of rescanning the entire inventory for every outgoing page. Premium
aggregation and partial-review merges retain all returned question, recurring
term, and cohesion entries rather than applying the former 40/40/80 overview
caps. Existing per-dossier field/evidence compaction is unchanged; this is not
yet an exact per-sentence preservation or verification guarantee.

Execution-plan version 2 freezes global `verification:N` step keys, source-batch
membership, candidate keys, and complete relevant-inventory fingerprints before
dispatch. Rebuilding different boundaries is a failure, not an automatic retry.
Resume reuses journaled completed page responses and counts their usage once.
A source batch receives durable coverage only after every page succeeds; one
page's `no_findings` cannot erase another's verified evidence. Final coverage
validates every repeated source copy, then counts original passages once.
Chronology cannot start before all frozen verification pages finish.

Packet version 6 blocks execution of older prompt contracts without changing
old credit holds or rewriting historical evidence. Complete-inventory pages
have their own nested version 3 contract for separate stat work units. Older execution plans and legacy
typed-only page contracts remain readable for inspection and reconciliation;
they are not silently upgraded to the new page layout.

Pagination preserves every entry in the relevant saved inventory. Relevance
still depends on matching source citations or candidate labels: this does not
prove that extraction or retrieval has found every fact in the manuscript.
Six-candidate pages reduce the mandatory-decision output load, but ordinary
prose and newly discovered findings can still exhaust a model's reply allowance.
Truncation remains a validation failure, never successful verification.
Offline capacity fixtures
use sizing heuristics, not a measured tokenizer or paid model benchmark.

Still pending: operator reconciliation for uncertain dossier-call outcomes;
extend the world atomic-claim gate to dossier reruns; equivalent decision gates
and bounded output work units for remaining finding families and chronology
synthesis; clear per-field/deferred verification status; linked
subdivision of oversized individual findings; an authorized live-provider
end-to-end accuracy, recovery, and cost test; and coordinated worker leases
before hosted multi-worker recovery. No historical world is automatically rerun
by this change, and old source coverage does not imply new stat verification.

### Dossier Relationship and Rule Verification

New connected dossier reviews now reuse the world graph verifier and canonical
writer. Small inventories stay in the existing dossier/stat request; dense
inventories use bounded continuation requests, not another extraction stage.
The frozen input includes the target's incident relationships, active
rules, exact source passages, owner directions, and allowed canonical IDs and
aliases. Hidden/merged endpoints are not eligible new links. Each candidate
requires an explicit decision; raw relationship/rule arrays cannot bypass it.
Direction, figurative kinship, status, temporal boundaries and rule conditions
use the shared checks. Biography text cannot borrow a relationship-only citation
as its entire evidence check; atomic sentence-level verification is still pending.

Version 2 freezes and packs the complete incident graph inventory into pages of
at most 12 distinct candidates and 64,000 candidate-envelope UTF-8 bytes, with
up to 4 new findings per response. Exact semantic duplicates retain their distinct
valid evidence anchors. The first page contains dossier prose, stats and graph
decisions (12,500 focused / 16,000 full reply tokens for stat-bearing records).
Additional pages have a 6,500-token reply allowance and may return only graph
decisions, never replacement biography, aliases or stats. Every assigned candidate
needs a verdict, including rejected or unresolved ones. Missing, reordered or
changed pages cannot be promoted. Oversized individual candidates and the
1,024-page safety limit still fail before dispatch instead of truncating.

One credit reservation covers every planned request, including repeated frozen
source context. Dense dossiers therefore can cost more than a single request;
small dossiers remain one request. Each paid page has an immutable child journal
under the real dossier review. Completed pages are reused on resume; known usage
across all pages and prior billable attempts is settled once by the existing
accounting path. Unknown/dispatched paid outcomes block automatic retry and keep
the hold. A changed source, owner constraint, model connection or insufficient
original hold pauses further dispatch for review. All-complete saved results can
finish without any provider connection. No live cost benchmark is claimed.

Pagination expands candidate coverage, not manuscript retrieval: focused/full
passage-selection limits are unchanged. The complete ordered receipt bundle is
required before canon is updated. Cross-page disagreement about an identical
candidate blocks its promotion and reports a conflict; it does not delete existing
canon. An all-rejected/unresolved review is audited and billed but leaves the
unchanged dossier and its verification status alone. Atomic biography/identity
verification and per-field status remain separate unfinished work.

The existing paid dossier journal holds a private, immutable verification bundle
checked against each exact saved response and actual routed model. Existing graph
verification-link tables now accept either a real world-analysis reference or a
real dossier-call reference, never both. No fake intake run or duplicate graph
table is created; the new child table records paid dispatches only. Source
validation, graph/stat persistence, credit settlement
and finalization stay within the existing transaction. Failed application keeps
the saved paid response for recovery. Modern context serialization survives
PostgreSQL JSONB key ordering, including owner directions.

Owner-edited records and conflicting rules remain protected by the shared writer.
Relationship displays receive only changes actually applied to canonical rows,
not proposals skipped by owner/category checks. Historical or conditional
membership never becomes unconditional current faction membership. Conflict and
legacy-review warnings are included in the saved response and shown on completion.

Older paid responses retain their original parsing/stat contract. Completed
responses can resume without another provider call. Version 1 graph requests
retain their original 12-candidate bound and are never silently repacked. For
pre-graph legacy responses, raw graph/display changes are held back,
with a warning; they cannot gain proof they never supplied. Existing canon is
not deleted. Legacy owner-direction JSON key-order repair still needs an
original-request-backed recovery path; new graph-enabled requests fix that issue
without changing historical fingerprints. No historical dossier is rerun or
silently upgraded. These changes were checked with offline fixtures and temporary
PGlite databases, not applied to the running user's world during this iteration.
Validation uses unit, source-wiring and temporary-database regressions plus server
and site TypeScript checks. These are offline checks, not a live-provider or
browser walkthrough. Historical worlds, live credit balances and provider
requests are not changed by these tests.
Paging validation: 277 related regressions and 2 additional root-persistence
database tests passed. The latter exercise multi-page graph/stat rollback and
offline replay, and an all-rejected review's unchanged dossier plus once-only
accounting. They do not claim coverage of the outer mention-refresh wrapper.

### Per-Item Dossier Evidence

New connected dossier requests also freeze `proseReview: {version: 1}`. This
uses the existing premium claim decision contract inside the first paid request,
not a second model pass. Every proposed summary sentence, alias, detail, role,
trait, motivation, fear, capability, history/origin, power, moral description,
physical description, knowledge item or secret has its own exact manuscript
citations, verdict, confidence and explanation. Ordinary response prose cannot
bypass this gate. The source-backed display order is saved with the receipt;
approved text is not rewritten after verification.

The first request permits up to 24 proposed items for focused review or 40 for
full review, counting rejected/deferred items too, with at most six summary
sentences. Its additional reply allowance is 8,000 / 12,000 tokens respectively
and is included in the original reservation: the stat-bearing totals are now
20,500 / 28,000 before any graph-only continuation requests. These are maximum
reply budgets, not predicted usage or live model compatibility/quality results.
Existing character prose is supplied as untrusted context without repeating
stat/graph inventories. Graph continuation requests cannot invent or overwrite
the first response's prose. Limits fail explicitly rather than truncating proof.

The contract fixes the subject's canonical ID/category, rejects alias collisions
and renames/merges, and preserves polarity, epistemic holder, truth status and
temporal boundaries. Beliefs, rumors, lies, negatives and dated assertions receive
readable qualifiers; they are not flattened into unconditional present-day facts.
Numeric socio-political estimates remain unchanged until a dedicated verification
contract exists; a biography citation cannot authorize an axis change.

Private journal bundle version 3 binds complete graph pages and ordered prose to
the first actual paid response, resolved model and saved completion time. A modern
successful finalization requires that bundle. Verified items use the shared
Lorekeeper `world_knowledge_claims` writer and existing verification-link table
with a real dossier-review reference, never a fabricated world-analysis run.
Only actual canonical writes may supply display text. Owner-controlled fields,
owner-confirmed records and edited dossiers are preserved. Earlier claims are not
deleted or implicitly superseded by omissions. Modern canon fingerprints also
include claims involving the reviewed entity; legacy version-1 hashes are unchanged.
Quality checks treat known dossier text fields as additive propositions: two
different summary sentences or aliases are not competing scalar values. Exact
opposing polarities still produce a readable warning when proposition, truth
status, viewpoint and time match. Ordinary non-dossier claim checks are unchanged.

Claims, proof links, dossier updates and accounting share the existing atomic
save transaction. Stored dossier lists and the dossier-review merge now preserve
complete text and all entries independently of extraction/prompt budgets. The
exact-display guard remains: any future lossy transformation stops the transaction
with the paid response retained for recovery. All-rejected reviews retain their
private evidence decisions and settle actual usage without upgrading untouched
dossier content.

This verifies every newly proposed display item, not every previously stored
sentence. Older saved requests keep their exact contract and cannot acquire new
proof retroactively. These are source-quote and exact-payload checks over one
model's decisions, not an independent second-model audit or a guarantee of semantic
truth. The following sections add field-level status/citations and exhaustive
prior-prose inventory review. World Clock event verification and a live
accuracy/cost benchmark remain separate work.
Validation: 369 related offline regressions passed, with additional targeted
prose/source-quality checks passing; server and site TypeScript checks passed.
Temporary-database tests include actual root save/rollback/replay, owner-field
withholding, all-rejected no-op, and unchanged-review accounting. Follow-up
fixtures replace the former capacity-rejection case with lossless save/read/replay
of larger lists and long stored entries. No real model calls, manuscript reruns or
customer credit charges were made for this iteration.

### Dossier Storage and Per-Section Evidence Follow-Up

The old 40-item profile and 80-item review-merge ceilings are no longer canonical
storage limits. Existing long entries, case-distinct text, aliases, details and
connection evidence survive dossier review, public serialization and subsequent
manual edits. Partial character PATCH requests preserve omitted sections. Exact
duplicate connection displays are combined without merging different temporal
accounts. Newly generated claims still obey their explicit per-request text,
evidence and output budgets. The global JSON request-body safety limit remains;
an oversized manual edit fails rather than silently shortening stored content.

Long character/entity sections offer Show More, Show All and Show Fewer while
editing still receives the whole list. These display windows never become save
limits. Other local maintenance/extraction adapters still have their own bounded
working sets and are not represented as an exhaustive historical prose audit.

The owner-only character and entity dossier pages now include a collapsed
Evidence by Section panel. Its read-only projection uses exact currently visible
text, not the dossier-wide review flag. It requires a finalized paid review, an
intact ordered prose receipt, matching current canonical claim/link payloads and
still-available manuscript evidence in the same world/edition. Complete summaries
must match the original ordered verified sentences; fragments, reordered text and
removed qualifiers cannot borrow proof. Lists report exact item coverage. A
missing, excluded/reference, edited or out-of-edition source removes that proof's
authority without deleting the dossier. Author text remains author-controlled.
Unlinked historical/local text means no saved item-level review, not an assertion
that the text is wrong. Private prompts, review IDs and model details are not
returned. GET requests do not dispatch models or reserve credits. Evidence
refreshes after edits/reviews; unchanged editor text keeps its original item
boundaries, including embedded newlines and punctuation inside aliases.

Validation for this follow-up: 405 related offline backend regressions passed,
as did 63 dossier/world-studio checks (some helper coverage overlaps), 12 targeted
site tests and both scoped API/site TypeScript checks. Tests use synthetic saved
responses and temporary databases; source-wiring tests are not a live HTTP or
browser walkthrough. No premium call, manuscript rerun, customer credit charge,
or historical canon migration was performed.

### Complete Existing-Prose Inventory Review

New connected dossier reviews now freeze every existing prose slot before prompt
limits are applied: full summaries, aliases, entity details, character sections,
roles and plain connection notes, with their original field, origin, index and
complete text. Repeated text in different stored slots remains distinct. This is
not a second numeric-stat or structured-relationship contract; those fields keep
their dedicated verification paths.

Paid saves preserve original list slots (including repeated wording) and only
deduplicate incoming additions. The UI can still show exact duplicate text once;
its evidence result then accounts for every original occurrence, surfacing any
contradiction or missing evidence. Raw current storage is checked separately from
the serialized display, so removed/reordered slots or a new unchecked occurrence
cannot inherit another slot's audit. Completing an audit without new canon edits
reports the reviewed entry count rather than saying no review status changed.

The existing graph/new-prose requests run first. Saved audit pages then cover the
entire old-text inventory, at most ten items and 64KB of item data per page, with
a 1,024-page safety bound. An indivisible oversized item fails preparation instead
of being silently clipped. Empty inventories add no audit request. Each audit
request has a 16,000-token maximum output allowance, included in the original
reservation before dispatch. That allowance is not measured consumption or a
customer price estimate. Every page repeats its selected manuscript/context
packet; live provider compatibility, latency and cost still need benchmarking.

Every old item receives exactly one source-supported, contradicted or
needs-more-evidence judgment. Supporting/contrary quotes must occur in the exact
supplied manuscript passages. Whole summaries are audited as written, not split
using guessed sentence boundaries. Missing context, chronology, beliefs,
metaphors and intentionally unresolved outcomes must not be treated as automatic
contradictions. Retrieval requests are saved as follow-up leads, not executed as
an unbounded retry loop. These checks authenticate the quote/payload boundaries;
they do not independently prove the model's semantic interpretation.

Request namespace v3 and private proof bundle4 bind every ordered graph and
old-prose page to its actual saved response, resolved model and completion time.
Interrupted runs reuse completed pages. Unknown paid outcomes remain held for
recovery rather than being retried automatically. A new-contract finalization
cannot downgrade to earlier proof, even when the old inventory is empty. Old
requests retain their earlier replay contracts; no historical response gains
proof retroactively.

Old-prose judgments do not create canonical claims, rewrite a dossier or delete
the author's text. Separately verified new claims still use the existing
canonical writer and owner protections. Evidence by Section distinguishes
Canon-Verified new claims from Source-Supported old wording, Needs Attention and
Needs More Evidence. It uses only exact current content and current scoped
manuscript evidence; newer unresolved judgments cannot borrow an older green
status. Private journal/request/model details remain private.

This covers every existing text item, not every possible passage in the books.
Focused/full base passage selection remains bounded. Items unsupported by that
selected context stay unresolved; the next section adds targeted expansion for
a later, explicitly started review. No real manuscripts, saved customer worlds or credit balances were
changed while implementing this feature, and no paid AI call was made.

Validation: 444 related offline backend tests passed, including real temporary
database saves, atomic rollback, replay, incomplete/uncertain pages, duplicate-slot
retention and raw-to-visible evidence projection. Thirteen targeted dossier UI
tests and scoped API/site TypeScript checks passed. Route-wiring guards are source
checks, not a live HTTP or browser walkthrough. No live model-quality result is
implied by these synthetic fixtures.

Still pending after this prose-audit iteration: dedicated compass and event
contracts, legacy/uncertain recovery and hosted coordination. Live
accuracy, provider compatibility and actual cost benchmarking are not covered by
offline fixtures.

### Targeted Passages for Unresolved Dossier Details

Preparing a fresh connected dossier review now uses unresolved old-text audit
questions to search the whole eligible manuscript corpus of that world/edition.
It loads only the owner's completed, successfully finalized bundle4 journals;
the newest applicable decision for each exact stored slot wins. Newer supported
or contradicted judgments suppress older unresolved requests. Removed/reordered
fields cannot lend their old requests to different text. Changed or newly added
source material may be searched because a retrieval lead is not proof.

This step is deterministic local text search, not another LLM call, an embedding
request, a Python process or an internet search. It ranks specific words and
phrases from the old item and its saved questions across all eligible chapters.
The target's name alone is insufficient. Original name/point-of-view/guidance
passages are retained; the expansion adds up to eight whole passages/64KB for a
focused review or sixteen/128KB for a full review. Items receive a first matching
passage before a second is allocated, and same-source adjacent passages add
attribution/time context when space remains. Unchanged already-reviewed text is
not repeatedly added as new evidence. All applicable earlier audits contribute
to that history, preventing follow-up searches from alternating between the same
passage sets. Distinct historical text versions are retained: a genuinely new
edit may be selected, but reverting to an already-read version does not make it
new evidence again. No chunk is clipped to fit the allowance.

Every unresolved slot receives a recorded search outcome, including no match,
already-selected/previously-reviewed evidence and matches deferred by the packet
budget. Diagnostic hit lists keep the top eight IDs plus the full match count;
this bounds journal metadata without limiting corpus search or dropping items.
Counts in the existing passage preview describe search leads, not verified
facts or resolved canon. Candidate results can be irrelevant, and lexical search
can miss paraphrases or implicit references; real-model accuracy is still untested.
Reference uploads, excluded/unready sources, mismatched source editions/worlds
and other owners' manuscripts are not eligible for this evidence packet. This
does not disable separate background-reference or Lorekeeper workflows.

The new whole passages enter the actual graph, stat, new-prose and old-prose
requests, their predispatch cost reservation, and the existing immutable saved
context. Search diagnostics remain private except for customer-facing counts.
Existing paid work never grows a new search on resume or finalization: it uses
the same saved passages and charges. Missing-evidence judgments do not trigger
another paid call automatically. This is a fresh-review improvement, not an
automatic retry loop or an in-progress historical-request migration.

No premium providers, live manuscript reruns, live world changes or customer
credit charges were used to implement or test this step. Credit pricing rules,
model selection, worker deployment and intake sequencing remain unchanged.

Validation: 471 related backend regressions passed. After the final cumulative
reading-history fix, all 59 targeted retrieval/source/prompt/replay/wiring checks
passed again, including new cycle and historical-text-version cases. Eighteen
targeted dossier UI checks and both scoped TypeScript checks passed. Temporary
databases and synthetic provider responses verify source boundaries and wiring;
the AST guards are not live HTTP/browser tests, and these results do not measure
real provider accuracy, latency or cost.

### Source-Backed Compass Reviews

Fresh connected **character dossier reviews** now include one explicit compass
interpretation in the first graph/stat/prose request. This adds no separate
model call. The predispatch reservation includes an additional 2,000 maximum
output tokens for this response; existing credit prices and model choices are
unchanged. Local runs and previously saved requests retain their old contracts.

The result assesses the whole economic/authority estimate, label, rationale,
time bounds and viewpoint together. Both axes require their own relevant exact
manuscript support; a general biography quote does not suffice. Self-description
and another character's opinion retain a fixed canonical holder. Numbers remain
interpretations, not objective facts, immutable canon, morality or RPG rules.
Unspecified time bounds do not mean that an early-book belief remains current.

New request namespace `storyhold:entity-review-request:v4` and private bundle
version 5 bind the compass to the actual first saved provider response, resolved
model, completion time, source text and canonical target. The existing page
inventory, credit hold, recovery journal and atomic finalization are reused.
Older bundles 1–4 cannot acquire this authority on replay. Existing graph/prose
proof and targeted-prose retrieval readers recognize the additive bundle.

The dedicated writer stores only a supported complete interpretation. It
rechecks the owned world/edition/entity, dossier link, unchanged old estimate
and submitted manuscripts. Author-edited dossiers and manual compass overrides
are preserved. Missing or disputed evidence completes the review without
clearing the current estimate or automatically dispatching another paid call.
Ordinary local, maintenance and world-review writes preserve an existing
perspective-qualified compass verbatim rather than stripping its source/time
metadata. This is a conservative retention rule, not a verification shortcut.

The owner dossier displays a compact source-backed interpretation or an explicit
unreviewed/needs-evidence/needs-attention state. Confidence alone no longer
unlocks the compass. Saved estimates remain accessible, with qualified
time/viewpoint and source passages in collapsible details. Current evidence
status requires exact finalized journal proof and unchanged source text; a
newer applicable inconclusive review supersedes an older reassuring status.
Public/shared world pages do not expose the private request or provider data.

This step covers dossier reruns, not a new whole-world compass pass. Applying
equivalent verification to world-level compass estimates and World Clock
events/participants/causal edges is still pending. Clock follow-up must also
address edition-scoped event identities, omission-based deletions that can
remove owner links, and post-review merging of incompatible event details.

Validation uses synthetic provider responses, pure contract/prompt tests and
temporary PGlite databases with real journal/proof/finalization functions.
There were no paid calls, manuscript reruns, live world edits, deployments or
server restarts. Quote matching verifies source occurrence, not the truth of a
model's interpretation; live semantic accuracy, latency and cost remain untested.

Validation results: 49 focused backend checks (27 compass and 22 route checks)
and 20 related site checks passed after the final fixes, as did both scoped
TypeScript checks and `git diff --check`. The broader 474-check backend run had
472 passes and two old static route-shape failures; both affected route suites
were corrected/rechecked in the passing focused run. There was no full second
474-check run and no live browser/provider walkthrough.

### Local GPU Setup

On an NVIDIA development computer, install the official CUDA-enabled PyTorch
runtime once with:

```powershell
pnpm run storyhold:enable-cuda
```

Qwen's GGUF runtime uses llama.cpp separately from the PyTorch readers. On the
current Python 3.13 development environment, install and verify the official
Vulkan-enabled llama.cpp wheel with:

```powershell
pnpm run storyhold:enable-llama-gpu
pnpm run storyhold:verify-llama-gpu
```

On this Acer Nitro 5, Vulkan device `1` is the NVIDIA RTX 3050 and Storyhold
keeps the benchmarked maximum of 32 offloaded layers with Qwen's full
16,384-token context. A physical micro-batch of 128 subdivides the same logical
512-token prompt batch so repeated audits have substantially more transient
compute-buffer headroom than llama.cpp's former 512-token micro-batch. The
tradeoff is somewhat slower prompt ingestion. It does not alter Qwen's weights,
evidence window, output settings, or answer quality, and it does not skip an
intake stage or substitute a smaller reader. K/Q/V work remains on the GPU by
default. An operator who needs still more display-GPU headroom can set
`STORYHOLD_LOCAL_QWEN_OFFLOAD_KQV=false`; that is slower but remains
quality-neutral.

The local/future-worker boundary, safety gates, and deliberately dormant hosted
design are documented in [LOREKEEPER-WORKER-ARCHITECTURE.md](./LOREKEEPER-WORKER-ARCHITECTURE.md).

## Optional local overrides

Set these environment variables before starting if needed:

- `PORT`
- `STORYHOLD_LOCAL_ADMIN_EMAIL`
- `STORYHOLD_LOCAL_ADMIN_PASSWORD`
- `STORYHOLD_LOCAL_DATA_DIR`
- `STORYHOLD_LOCAL_STORAGE_ROOT`
- `STORYHOLD_LOCAL_QWEN_BATCH_SIZE` (logical prompt batch; default `512`)
- `STORYHOLD_LOCAL_QWEN_MICRO_BATCH_SIZE` (physical compute batch; default `128`)
- `STORYHOLD_LOCAL_QWEN_OFFLOAD_KQV` (default `true`; set `false` only for extra VRAM headroom)

This embedded database and local file archive are development adapters. A future Replit or commercial deployment should use managed PostgreSQL/pgvector, private object storage for original uploads, and production authentication. Existing Replit files and the original production startup remain intact.
