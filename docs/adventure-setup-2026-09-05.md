# Original Adventure Setup

New original quickstart adventures now prepare an adventure foundation before
accepting the first player choice. Imported manuscript campaigns retain their
existing canon workflow. Preparation runs only after an explicit POST, never a
GET or progress poll.

## Saved Foundation

- A public opening for an unplayed game and an immediately actionable objective.
- A private world foundation: setting baseline, identity secrecy, broader forces,
  and unanswered questions with fair discovery boundaries.
- Two to five NPCs with private motives; unmet NPCs stay private.
- One to four secrets with clues and discovery approaches.
- Two to three private scheduled pressures measured in game time.
- Contingent goal steps and alternative paths, not predetermined events.

The Director receives the foundation along with current state on later turns.
The Narrator receives only approved public direction, not the private plan.
Current committed facts outrank initial intentions. A due pressure must be
interpreted in light of intervening actions, not imposed after its cause was
prevented. The existing engine can resolve a due clock without inventing its
conditional consequence.

The immediate objective is mechanically tracked. Later conditional goals are
currently private planning notes; automatic activation of subsequent tracked
objectives and earned positive rewards still needs a bounded authority path.

## Execution and Safety

`POST /api/storyhold/campaigns/:campaignId/setup` freezes the context and prompt.
Manual owner testing queues that exact request under the existing Manual
Storyteller operator page. An operator submits a fingerprint-bound plan, and
normal persistence applies it. No provider or credits are used in manual mode.
Ordinary configured execution uses the Director gateway and existing metered
reservation/result-journal/settlement system. Actual provider operation was not
called during this implementation test.

Application is transactional and idempotent. It preserves saved turns, elapsed
time, locked seeds, existing NPC summaries, and stats. A generic location label
may be named, and an empty objective list gains the opening goal. Changed state
or a pending turn prevents application. Branch snapshot v4 carries only the
setup that existed at the selected checkpoint, without replaying goals or clocks.

Validation bounds structure, references, copied private text, and existing
location/objective preservation. It does not prove semantic consistency of all
generated prose; live storytelling still needs continued qualitative testing.

## Taco Hell Verification

Campaign `ea8081d4-e2b7-49f4-98ae-3edccc7442e7` received a continuation setup via
the manual queue, then a pre-play operator refinement after qualitative review.
Both saved turns compare exactly with the pre-change snapshot. Game time remains
one minute; the campaign version advanced from 3 to 5 only for setup/refinement
records. The public goal is **Deal With the Waiting Pickup Order**. Mara's
existing record and the waiting customer's public summary were preserved.

The initial coincidental `crossing residue` at Taco Hell was removed. The revised
foundation explicitly makes Azurea's demon-lord identity secret, Taco Hell an
ordinary workplace rather than a magical nexus, and cross-realm answers dependent
on earned, independent evidence. Unmet cast, secrets, pressures, and the broader
foundation did not appear in the player response or UI. No new opening was
appended to this already-played campaign.

The owner balance remained 5,000 credits. Setup POST replay and duplicate manual
completion made no additional state change. Local Python remained idle. Server
was closed through its graceful endpoint and its ownership lease released before
restart; no forced process kill or database file operation was used.

Verification: 120 targeted tests across setup, branches, manual storytelling,
campaign play/policy, and RPG turn deltas passed; API/site TypeScript checks and
site build passed. Desktop/mobile-width UI checks found no page errors or private
plan leakage. Existing Vite sourcemap and bundle-size warnings remain.

Other previously identified follow-ups: harmless dialogue should not receive an
arbitrary failure check; exact fact-paraphrase validation is still too brittle.
