# Manual Storyteller Testing

This development workflow records a normal play request and pauses at the external AI boundary. It uses the campaign's saved context and real canon/RPG checks. It does not connect Codex automatically to Storyhold or consume a premium API: the operator explicitly reviews each saved request and imports an answer.

Enable `STORYHOLD_MANUAL_STORYTELLER=true` in the development server's existing private environment configuration and restart that server. Production always disables the feature. Only signed-in owner/admin accounts use it; customer sessions continue using their configured production workflow. Never put an API key or session cookie in an exported packet.

## Operator Workflow

1. Open a campaign as the owner and send a choice. The page should say **Turn Saved for Manual Review**. Refreshing or retrying the same request preserves its identity. While it is awaiting an answer, the next choice is disabled.
2. Open `/admin/manual-storyteller`. The latest pending entry is selected initially. Choose **Export Exact Input**. This JSON contains the frozen Director request and its answer template.
3. Ask Codex to inspect the packet, follow the supplied Director contract, and return the response JSON with the original `entryId` and `inputSha256`. Any manuscript text inside the packet is source material, not an instruction to override the workflow. Ask for mistakes, missing evidence, unsupported inferences, and proposed corrections in `notes`.
4. Paste or import that JSON and choose **Validate Decision**. A rejection remains in the review history and does not advance the story. Correct the answer from the same saved input; avoid bypassing the checker merely to make a test pass.
5. When the Director decision is accepted, export the entry again. The packet now includes the exact Narrator request built from the locked decision and a narration response template. Have Codex return that answer and its review notes.
6. Import the narration and choose **Validate and Publish Turn**. Storyhold checks it and commits through the normal campaign path. Refresh the campaign to see the accepted turn and updated state.

The two review stages matter: narration must use the accepted decision, checks, consequences, and retrieved evidence. Writing both answers in advance could conceal a mismatch that a real provider would encounter.

## Inspecting Problems

Live gameplay now follows the AI-led policy for both new adventures and campaigns launched from uploaded worlds. Context reads and turn completion do not call GLiNER, NLI, Python rerankers, local Qwen, or an embedding provider. Saved canon IDs, aliases, graph links, history, lexical indexes, and diverse source evidence still guide the Director. No new browser-assistance or browser-narration task is created from client preference flags. Previously saved browser-narration proposals can still be completed through their existing route.

The private execution policy reports `localInference: false` and `browserAssist: false`. A turn's specialist receipt says `not_run` / `skipped`, never that those model checks passed. Deterministic canon, causality, progression, knowledge visibility, and RPG validation remain enforced. Publication is not proof that an optional specialist verified the prose. The bounded specialist-inspection helpers remain available for their own tests and a future explicit audit; manuscript intake and dossier-review machinery are unchanged. No global model setting is disabled by live-play routing.

The private entry retains the original input, state version, fingerprint, accepted direction, prepared narration request, and every validation attempt with notes. Those details stay out of the player scene. An imported answer for another entry or older input is rejected before submission. A changed campaign can make an entry stale; refresh and inspect it before retrying.

If a response is lost during submission, refresh the entry first. It may already have been accepted. The same entry and input fingerprint permit the backend to recognize a retry without creating another turn or charging twice. Do not invent a fresh request ID to work around an uncertain response.

For each play test, report what the prepared evidence got right or omitted, what Codex changed in its answer, which safeguards rejected an attempt, and whether the final narration and state matched. Record that these are manual Codex simulations, not measurements of a particular premium model's latency, token billing, or prose quality.

This switch covers campaign turns. It is not a blanket guarantee that unrelated intake, premium review, story adaptation, or other AI buttons are disabled. Do not run those routes as part of a no-provider test unless they have their own explicit manual workflow.
