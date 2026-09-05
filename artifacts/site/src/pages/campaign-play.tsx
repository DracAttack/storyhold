import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  Bot,
  BookOpenCheck,
  BookmarkPlus,
  Check,
  CircleHelp,
  Clock3,
  Coins,
  Dice5,
  Eye,
  GitBranch,
  Loader2,
  LockKeyhole,
  RotateCcw,
  Send,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Link, useLocation, useParams } from "wouter";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ProfileFrame } from "@/components/customer/profile-frame";
import { CampaignRpgStatePanel } from "@/components/customer/campaign-rpg-state-panel";
import { CampaignCheckResult } from "@/components/customer/campaign-check-result";
import { AdventureSetupCard } from "@/components/customer/adventure-setup-card";
import { useAuth } from "@/lib/auth";
import {
  CAMPAIGN_INPUT_MODES,
  campaignInputModes,
  safeCampaignInputMode,
} from "@/lib/campaignInputModes";
import { enforceStoryFirstRpgState } from "@/lib/campaignRpgState";
import { isManualQueuedResponse, manualTurnIsPending } from "@/lib/manualStorytellerApi";
import { adventureSetupBlocksPlay, adventureSetupIsPending, adventureSetupOpening, prepareAdventureSetup } from "@/lib/adventureSetupApi";
import { useSeo } from "@/lib/seo";
import {
  inspectBrowserLorekeeper,
  persistBrowserModelCache,
  runBrowserCampaignNarration,
} from "@/lib/browserLorekeeper";
import { browserLorekeeperIsEnabled } from "@/lib/browserLorekeeperSettings";
import {
  acquireCampaignBranchRequest,
  acquireCampaignRerollRequest,
  acquireCampaignTurnRequest,
  clearPendingCampaignBranchRequest,
  clearPendingCampaignRerollRequest,
  clearPendingCampaignTurnRequest,
  readPendingCampaignBranchRequest,
  readPendingCampaignRerollRequest,
  readPendingCampaignTurnRequest,
  type PendingCampaignBranchRequest,
  type PendingCampaignRerollRequest,
  type PendingCampaignTurnRequest,
} from "@/lib/campaignRequestPersistence";
import {
  acceptCampaignTurnProposal,
  activateCampaignBranch,
  createCampaignBranch,
  createCampaignCheckpoint,
  createCampaignTurnProposal,
  discardCampaignTurnProposal,
  getCampaignPlay,
  regenerateCampaignTurnProposal,
  rerollCampaignTurnProposal,
  submitCampaignBrowserNarration,
  updateCampaignBranch,
  updateCampaignTurnFeedback,
  type CampaignPlaySession,
  type CampaignInputMode,
  type CampaignTurn,
  type LorekeeperFeedbackTag,
  type ProposalMutationResponse,
  StoryholdApiError,
} from "@/lib/storyholdApi";

const FEEDBACK_ASPECTS: Array<{ id: LorekeeperFeedbackTag; label: string }> = [
  { id: "pacing", label: "Pacing" },
  { id: "canon", label: "Canon" },
  { id: "continuity", label: "Continuity" },
  { id: "lore", label: "Lore" },
  { id: "character_voice", label: "Character" },
  { id: "challenge", label: "Challenge" },
  { id: "creativity", label: "Creativity" },
  { id: "prose", label: "Prose" },
  { id: "consequences", label: "Consequences" },
];

function requestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `turn_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function providerLabel(value: string): string {
  if (value === "xai") return "Grok";
  if (value === "openai") return "OpenAI";
  if (value === "anthropic") return "Anthropic";
  if (value === "kimi") return "Kimi";
  if (value === "openrouter") return "OpenRouter";
  return "Storyhold";
}

function outcomeLabel(turn: Pick<CampaignTurn, "outcome">) {
  if (turn.outcome === "none") return null;
  return turn.outcome.charAt(0).toUpperCase() + turn.outcome.slice(1);
}

function visibleOutcomeLabel(
  turn: Pick<CampaignTurn, "outcome" | "check">,
  mode: CampaignPlaySession["campaign"]["resolutionMode"],
) {
  if (mode === "custom" && turn.check && !turn.check.result) return null;
  return outcomeLabel(turn);
}

function inputModeLabel(mode: CampaignInputMode | undefined) {
  return CAMPAIGN_INPUT_MODES.find((option) => option.id === (mode ?? "action"))?.label ?? "Action";
}

function configuredText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export default function CampaignPlay() {
  const auth = useAuth();
  const [, navigate] = useLocation();
  const { id = "" } = useParams<{ id: string }>();
  const [session, setSession] = useState<CampaignPlaySession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState("");
  const [inputMode, setInputMode] = useState<CampaignInputMode>("action");
  const [pendingAction, setPendingAction] = useState("");
  const [pendingInputMode, setPendingInputMode] = useState<CampaignInputMode>("action");
  const [sending, setSending] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [localAssistMessage, setLocalAssistMessage] = useState("");
  const [proposalBusy, setProposalBusy] = useState<"accept" | "regenerate" | "reroll" | "discard" | null>(null);
  const [branchStatusBusy, setBranchStatusBusy] = useState<string | null>(null);
  const [checkpointBusy, setCheckpointBusy] = useState(false);
  const [pricedChoice, setPricedChoice] = useState<
    { kind: "reroll" } | { kind: "branch"; checkpointId: string } | null
  >(null);
  const [feedbackBusy, setFeedbackBusy] = useState<string | null>(null);
  const [lastCreditsUsed, setLastCreditsUsed] = useState<number | null>(null);
  const pendingTurnRequestRef = useRef<PendingCampaignTurnRequest | null>(null);
  const pendingRerollRequestRef = useRef<PendingCampaignRerollRequest | null>(null);
  const pendingBranchRequestRef = useRef<PendingCampaignBranchRequest | null>(null);
  const narrationRecoveryRef = useRef("");
  const endRef = useRef<HTMLDivElement | null>(null);
  const campaignIdRef = useRef(id);
  campaignIdRef.current = id;
  const setupBlocksPlay = adventureSetupBlocksPlay(session?.adventureSetup);
  const opening = adventureSetupOpening(session?.adventureSetup);

  useSeo({
    title: session?.campaign.name || "Continue campaign",
    description: "Continue a persistent Storyhold campaign.",
    canonicalPath: `/profile/campaigns/${id}/play`,
    noindex: true,
  });

  useEffect(() => {
    pendingTurnRequestRef.current = null;
    pendingRerollRequestRef.current = null;
    pendingBranchRequestRef.current = null;
    if (!auth.email || !id) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    setSetupBusy(false);
    setSetupError(null);
    void getCampaignPlay(id)
      .then(async (response) => {
        if (!active) return;
        if (auth.userId) {
          const pendingTurn = readPendingCampaignTurnRequest({
            playerId: auth.userId,
            campaignId: response.campaign.id,
          });
          if (
            pendingTurn &&
            (pendingTurn.requestId === response.pendingProposal?.requestId ||
              pendingTurn.requestId === response.pendingManualTurn?.requestId ||
              (response.manualStorytellerEnabled && !response.pendingManualTurn && !response.pendingTurnRequest))
          ) {
            clearPendingCampaignTurnRequest({
              playerId: auth.userId,
              campaignId: response.campaign.id,
              requestId: pendingTurn.requestId,
            });
            pendingTurnRequestRef.current = null;
          } else if (response.pendingTurnRequest && !manualTurnIsPending(response.pendingManualTurn)) {
            clearPendingCampaignTurnRequest({
              playerId: auth.userId,
              campaignId: response.campaign.id,
            });
            const restored = await acquireCampaignTurnRequest({
              playerId: auth.userId,
              campaignId: response.campaign.id,
              action: response.pendingTurnRequest.action,
              inputMode: response.pendingTurnRequest.inputMode,
              createRequestId: () => response.pendingTurnRequest!.requestId,
            });
            if (!active) return;
            pendingTurnRequestRef.current = restored;
            setAction(response.pendingTurnRequest.action);
            setInputMode(response.pendingTurnRequest.inputMode);
            setError(
              "Storyhold restored your unfinished choice. Send it again to continue the same saved attempt.",
            );
          } else {
            pendingTurnRequestRef.current = pendingTurn;
          }
          pendingRerollRequestRef.current = readPendingCampaignRerollRequest({
            playerId: auth.userId,
            campaignId: response.campaign.id,
          });
          const pendingBranch = readPendingCampaignBranchRequest({
            playerId: auth.userId,
            campaignId: response.campaign.id,
          });
          // Even when the server already has the matching branch, keep its
          // paid request identity until free activation succeeds. A lost
          // create response can therefore be retried without a second charge.
          pendingBranchRequestRef.current = pendingBranch;
        }
        setSession(response);
      })
      .catch((reason) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "This campaign could not be opened.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [auth.email, auth.userId, id]);

  useEffect(() => {
    if (!session || !adventureSetupIsPending(session.adventureSetup)) return;
    const campaignId = session.campaign.id;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        // Progress checks are read-only and never ask the storyteller to run.
        const response = await getCampaignPlay(campaignId, controller.signal);
        if (controller.signal.aborted || campaignIdRef.current !== campaignId) return;
        setSession(response);
        setSetupError(null);
        if (!adventureSetupIsPending(response.adventureSetup)) return;
      } catch {
        if (controller.signal.aborted) return;
        setSetupError("Your beginning is saved. Reconnecting to your adventure…");
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 4_000);
    };
    timer = setTimeout(refresh, 4_000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [session?.campaign.id, session?.adventureSetup?.status]);

  const prepareAdventure = async () => {
    if (!session || setupBusy || adventureSetupIsPending(session.adventureSetup)) return;
    const campaignId = session.campaign.id;
    setSetupBusy(true);
    setSetupError(null);
    try {
      const response = await prepareAdventureSetup(campaignId);
      if (campaignIdRef.current !== campaignId) return;
      setSession((current) => current?.campaign.id === campaignId
        ? { ...current, adventureSetup: response.adventureSetup }
        : current);
      // Refresh the public goals and location that preparation just made available.
      const refreshed = await getCampaignPlay(campaignId);
      if (campaignIdRef.current === campaignId) setSession(refreshed);
      void auth.refresh();
    } catch {
      if (campaignIdRef.current !== campaignId) return;
      // The campaign-bound request may have succeeded despite a lost response.
      try {
        const refreshed = await getCampaignPlay(campaignId);
        if (campaignIdRef.current !== campaignId) return;
        setSession(refreshed);
        if (!adventureSetupBlocksPlay(refreshed.adventureSetup) || adventureSetupIsPending(refreshed.adventureSetup)) return;
      } catch { /* Preserve the saved beginning and its retry action. */ }
      if (campaignIdRef.current === campaignId) setSetupError("Preparation could not finish. Your beginning is saved; try again.");
    } finally {
      if (campaignIdRef.current === campaignId) setSetupBusy(false);
    }
  };

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [session?.turns.length, session?.pendingProposal?.revision, pendingAction]);

  useEffect(() => {
    if (!session) return;
    const safeMode = safeCampaignInputMode(
      session.campaign.experienceMode,
      inputMode,
    );
    if (safeMode !== inputMode) setInputMode(safeMode);
  }, [inputMode, session?.campaign.experienceMode]);

  const completeBrowserNarration = async (
    response: ProposalMutationResponse,
  ): Promise<ProposalMutationResponse> => {
    const task = response.proposal.browserNarrationTask;
    if (!task || !session) return response;
    if (!browserLorekeeperIsEnabled()) {
      setLocalAssistMessage("Storyhold is finishing the locked outcome…");
      return regenerateCampaignTurnProposal({
        campaignId: session.campaign.id,
        proposalId: response.proposal.id,
      });
    }
    const capability = await inspectBrowserLorekeeper();
    if (!capability.supported) {
      setLocalAssistMessage("Storyhold is finishing the locked outcome…");
      return regenerateCampaignTurnProposal({
        campaignId: session.campaign.id,
        proposalId: response.proposal.id,
      });
    }
    let local;
    try {
      await persistBrowserModelCache();
      local = await runBrowserCampaignNarration({
        task,
        recentTurns: session.turns.map((turn) => ({
          playerAction: turn.playerAction,
          narration: turn.narration,
          sceneSummary: turn.sceneSummary,
        })),
        capability,
        onProgress: (progress) => setLocalAssistMessage(progress.message),
      });
    } catch {
      setLocalAssistMessage("Storyhold is continuing the locked outcome…");
      return regenerateCampaignTurnProposal({
        campaignId: session.campaign.id,
        proposalId: response.proposal.id,
      });
    }
    try {
      return await submitCampaignBrowserNarration({
        campaignId: session.campaign.id,
        proposalId: response.proposal.id,
        narration: local.narration,
        model: local.model,
        usage: local.usage,
      });
    } catch (reason) {
      if (
        !(reason instanceof StoryholdApiError) ||
        reason.payload.code !== "BROWSER_NARRATION_CANON_REPAIR_REQUIRED"
      ) throw reason;
      // A local draft can be structurally faithful yet phrase an objective
      // canon contradiction. The server's NLI gate rejects it before display;
      // Storyhold then repairs prose around the same locked result.
      setLocalAssistMessage("Lorekeeper caught a canon conflict. Storyhold is repairing the wording…");
      return regenerateCampaignTurnProposal({
        campaignId: session.campaign.id,
        proposalId: response.proposal.id,
      });
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextAction = action.trim();
    if (!nextAction || !session || !auth.userId || sending || setupBlocksPlay || setupBusy || session.pendingProposal || manualTurnIsPending(session.pendingManualTurn)) return;
    const playerId = auth.userId;
    const campaignId = session.campaign.id;
    const submittedInputMode = safeCampaignInputMode(
      session.campaign.experienceMode,
      inputMode,
    );
    setSending(true);
    setPendingAction(nextAction);
    setPendingInputMode(submittedInputMode);
    setAction("");
    setError(null);
    try {
      const pendingRequest = await acquireCampaignTurnRequest({
        playerId,
        campaignId,
        action: nextAction,
        inputMode: submittedInputMode,
        createRequestId: requestId,
        pendingRequest: pendingTurnRequestRef.current,
      });
      pendingTurnRequestRef.current = pendingRequest;
      // Live choices go directly to the campaign's AI-and-rules path. Browser
      // intelligence preferences apply to other workflows, not this send.
      const initialResponse = await createCampaignTurnProposal({
        campaignId,
        action: nextAction,
        inputMode: submittedInputMode,
        requestId: pendingRequest.requestId,
      });
      if (isManualQueuedResponse(initialResponse)) {
        clearPendingCampaignTurnRequest({ playerId, campaignId, requestId: pendingRequest.requestId });
        pendingTurnRequestRef.current = null;
        setLastCreditsUsed(0);
        if (initialResponse.manualTurn.status === "completed") {
          setSession(await getCampaignPlay(campaignId));
        } else {
          setSession((current) => current ? {
            ...current,
            pendingManualTurn: initialResponse.manualTurn,
            pendingTurnRequest: null,
          } : current);
        }
        return;
      }
      const response = initialResponse;
      clearPendingCampaignTurnRequest({
        playerId,
        campaignId,
        requestId: pendingRequest.requestId,
      });
      if (pendingTurnRequestRef.current?.requestId === pendingRequest.requestId) {
        pendingTurnRequestRef.current = null;
      }
      setLastCreditsUsed(response.creditsUsed ?? null);
      setSession((current) => {
        if (!current) return current;
        return {
          ...current,
          pendingProposal: response.proposal,
          pendingTurnRequest: null,
          credits: response.creditsRemaining ?? current.credits,
          unlimitedCredits:
            response.unlimitedCredits ?? current.unlimitedCredits,
          runtime: response.runtime ?? current.runtime,
        };
      });
      void auth.refresh();
    } catch (reason) {
      setAction(nextAction);
      const message =
        reason instanceof Error
          ? reason.message
          : "The storyteller could not resolve that turn.";
      setError(message);
      toast.error(message);
    } finally {
      setPendingAction("");
      setLocalAssistMessage("");
      setSending(false);
    }
  };

  const refreshManualTurn = async () => {
    if (!session || sending) return;
    setSending(true);
    try {
      setSession(await getCampaignPlay(session.campaign.id));
      setError(null);
    } catch {
      setError("The saved turn could not be refreshed. Try again in a moment.");
    } finally { setSending(false); }
  };

  useEffect(() => {
    // Resume only an already-saved browser narration task. New live choices
    // never request one, but older pending drafts must remain finishable.
    const proposal = session?.pendingProposal;
    if (!proposal?.browserNarrationTask || session?.manualStorytellerEnabled || sending || proposalBusy) return;
    if (narrationRecoveryRef.current === proposal.id) return;
    narrationRecoveryRef.current = proposal.id;
    let active = true;
    setSending(true);
    setLocalAssistMessage("Finishing the saved narration…");
    void completeBrowserNarration({ proposal })
      .then((response) => {
        if (!active) return;
        setLastCreditsUsed(response.creditsUsed ?? null);
        setSession((current) => current ? {
          ...current,
          pendingProposal: response.proposal,
          credits: response.creditsRemaining ?? current.credits,
          unlimitedCredits: response.unlimitedCredits ?? current.unlimitedCredits,
          runtime: response.runtime ?? current.runtime,
        } : current);
        void auth.refresh();
      })
      .catch((reason) => {
        if (!active) return;
        const message = reason instanceof Error
          ? reason.message
          : "The saved narration could not be completed.";
        setError(message);
        toast.error(message);
      })
      .finally(() => {
        if (!active) return;
        setSending(false);
        setLocalAssistMessage("");
      });
    return () => { active = false; };
  }, [session?.pendingProposal?.id, session?.pendingProposal?.browserNarrationTask?.proposalId, session?.manualStorytellerEnabled]);

  const acceptProposal = async () => {
    if (!session?.pendingProposal || proposalBusy) return;
    const acceptedProposal = session.pendingProposal;
    setProposalBusy("accept");
    setError(null);
    try {
      const response = await acceptCampaignTurnProposal({
        campaignId: session.campaign.id,
        proposalId: session.pendingProposal.id,
      });
      setSession((current) => {
        if (!current) return current;
        const exists = current.turns.some((turn) => turn.id === response.turn.id);
        return {
          ...current,
          turns: exists ? current.turns : [...current.turns, response.turn],
          pendingProposal: null,
          campaign: {
            ...current.campaign,
            currentTimeLabel: response.currentTimeLabel || current.campaign.currentTimeLabel,
            worldTimeMinutes: response.worldTimeMinutes ?? current.campaign.worldTimeMinutes,
            stateVersion: response.stateVersion ?? current.campaign.stateVersion,
          },
          clockEvents: response.clockEvents ?? current.clockEvents,
          knownState: response.knownState ?? current.knownState,
          rpgState: response.rpgState ?? current.rpgState,
          credits: response.creditsRemaining ?? current.credits,
          unlimitedCredits: response.unlimitedCredits ?? current.unlimitedCredits,
          runtime: response.runtime ?? current.runtime,
        };
      });
      toast.success("Turn committed to this campaign.");
      if (auth.userId) {
        clearPendingCampaignTurnRequest({
          playerId: auth.userId,
          campaignId: session.campaign.id,
          requestId: acceptedProposal.requestId,
        });
        clearPendingCampaignRerollRequest({
          playerId: auth.userId,
          campaignId: session.campaign.id,
          sourceProposalId:
            acceptedProposal.rerolledFromProposalId ?? acceptedProposal.id,
        });
        pendingTurnRequestRef.current = null;
        pendingRerollRequestRef.current = null;
      }
      void auth.refresh();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "The draft could not be committed.";
      setError(message);
      toast.error(message);
    } finally {
      setProposalBusy(null);
    }
  };

  const saveTurnFeedback = async (
    turn: CampaignTurn,
    rating: -1 | 1,
    tags = turn.feedback?.tags ?? [],
    note = turn.feedback?.note ?? "",
  ) => {
    if (!session || feedbackBusy) return;
    setFeedbackBusy(turn.id);
    try {
      const response = await updateCampaignTurnFeedback({
        campaignId: session.campaign.id,
        turnId: turn.id,
        rating,
        tags,
        note,
      });
      setSession((current) =>
        current
          ? {
              ...current,
              turns: current.turns.map((entry) =>
                entry.id === turn.id
                  ? { ...entry, feedback: response.feedback }
                  : entry,
              ),
            }
          : current,
      );
      toast.success(
        rating === 1
          ? "Lorekeeper will favor more play like this."
          : "Lorekeeper will steer away from this pattern.",
      );
    } catch (reason) {
      toast.error(
        reason instanceof Error
          ? reason.message
          : "Lorekeeper could not save that feedback.",
      );
    } finally {
      setFeedbackBusy(null);
    }
  };

  const toggleFeedbackAspect = (
    turn: CampaignTurn,
    tag: LorekeeperFeedbackTag,
  ) => {
    if (!turn.feedback) return;
    const tags = turn.feedback.tags.includes(tag)
      ? turn.feedback.tags.filter((value) => value !== tag)
      : [...turn.feedback.tags, tag];
    void saveTurnFeedback(turn, turn.feedback.rating, tags);
  };

  const regenerateProposal = async () => {
    if (!session?.pendingProposal || session.manualStorytellerEnabled || proposalBusy) return;
    setProposalBusy("regenerate");
    setError(null);
    try {
      const response = await regenerateCampaignTurnProposal({
        campaignId: session.campaign.id,
        proposalId: session.pendingProposal.id,
      });
      setLastCreditsUsed(response.creditsUsed ?? null);
      setSession((current) =>
        current
          ? {
              ...current,
              pendingProposal: response.proposal,
              credits: response.creditsRemaining ?? current.credits,
              unlimitedCredits: response.unlimitedCredits ?? current.unlimitedCredits,
              runtime: response.runtime ?? current.runtime,
            }
          : current,
      );
      toast.success("Prose regenerated. The resolved outcome did not change.");
      void auth.refresh();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "The prose could not be regenerated.";
      setError(message);
      toast.error(message);
    } finally {
      setProposalBusy(null);
    }
  };

  const rerollProposal = async () => {
    if (!session?.pendingProposal || session.manualStorytellerEnabled || !auth.userId || proposalBusy) return;
    const playerId = auth.userId;
    const campaignId = session.campaign.id;
    const visibleProposal = session.pendingProposal;
    setProposalBusy("reroll");
    setError(null);
    try {
      const pendingRequest = acquireCampaignRerollRequest({
        playerId,
        campaignId,
        currentProposalId: visibleProposal.id,
        currentRerolledFromProposalId: visibleProposal.rerolledFromProposalId,
        pendingRequest: pendingRerollRequestRef.current,
      });
      pendingRerollRequestRef.current = pendingRequest;
      const response = await rerollCampaignTurnProposal({
        campaignId,
        proposalId: pendingRequest.sourceProposalId,
      });
      clearPendingCampaignRerollRequest({
        playerId,
        campaignId,
        sourceProposalId: pendingRequest.sourceProposalId,
      });
      if (
        pendingRerollRequestRef.current?.sourceProposalId ===
        pendingRequest.sourceProposalId
      ) {
        pendingRerollRequestRef.current = null;
      }
      setLastCreditsUsed(response.creditsUsed ?? null);
      setSession((current) =>
        current
          ? {
              ...current,
              pendingProposal: response.proposal,
              credits: response.creditsRemaining ?? current.credits,
              unlimitedCredits: response.unlimitedCredits ?? current.unlimitedCredits,
              runtime: response.runtime ?? current.runtime,
            }
          : current,
      );
      toast.success(
        session.campaign.experienceMode === "solo"
          ? session.unlimitedCredits
            ? "Outcome rerolled. Your unlimited testing account was not charged."
            : `Outcome rerolled for ${session.productPricing.rerollCredits} credits.`
          : "Outcome rerolled. Author mode was not charged.",
      );
      void auth.refresh();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "The outcome could not be rerolled.";
      setError(message);
      toast.error(message);
    } finally {
      setProposalBusy(null);
    }
  };

  const discardProposal = async () => {
    if (!session?.pendingProposal || proposalBusy) return;
    const discardedProposal = session.pendingProposal;
    setProposalBusy("discard");
    setError(null);
    try {
      await discardCampaignTurnProposal({
        campaignId: session.campaign.id,
        proposalId: session.pendingProposal.id,
      });
      setAction(session.pendingProposal.playerAction);
      setInputMode(session.pendingProposal.inputMode);
      setSession((current) => (current ? { ...current, pendingProposal: null } : current));
      if (auth.userId) {
        clearPendingCampaignTurnRequest({
          playerId: auth.userId,
          campaignId: session.campaign.id,
          requestId: discardedProposal.requestId,
        });
        clearPendingCampaignRerollRequest({
          playerId: auth.userId,
          campaignId: session.campaign.id,
          sourceProposalId:
            discardedProposal.rerolledFromProposalId ?? discardedProposal.id,
        });
        pendingTurnRequestRef.current = null;
        pendingRerollRequestRef.current = null;
      }
      toast.success("Draft discarded. Nothing was added to canon.");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "The draft could not be discarded.";
      setError(message);
      toast.error(message);
    } finally {
      setProposalBusy(null);
    }
  };

  const saveCheckpoint = async () => {
    if (!session || checkpointBusy) return;
    setCheckpointBusy(true);
    try {
      const response = await createCampaignCheckpoint({ campaignId: session.campaign.id });
      setSession((current) =>
        current ? { ...current, checkpoints: [response.checkpoint, ...current.checkpoints] } : current,
      );
      toast.success("Checkpoint saved.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The checkpoint could not be saved.");
    } finally {
      setCheckpointBusy(false);
    }
  };

  const forkCheckpoint = async (checkpointId: string) => {
    if (!session || !auth.userId || checkpointBusy) return;
    setCheckpointBusy(true);
    try {
      const mode = session.campaign.experienceMode === "author" ? "writer" : "alternate";
      const pendingRequest = acquireCampaignBranchRequest({
        playerId: auth.userId,
        campaignId: session.campaign.id,
        checkpointId,
        name: `${session.campaign.experienceMode === "author" ? "Author" : "Alternate"} branch ${session.branches.length + 1}`,
        mode,
        createRequestId: requestId,
        pendingRequest: pendingBranchRequestRef.current,
      });
      pendingBranchRequestRef.current = pendingRequest;
      const response = await createCampaignBranch({
        campaignId: session.campaign.id,
        checkpointId: pendingRequest.checkpointId,
        requestId: pendingRequest.requestId,
        name: pendingRequest.name,
        mode: pendingRequest.mode,
      });
      setSession((current) =>
        current
          ? {
              ...current,
              branches: [response.branch, ...current.branches.filter((branch) => branch.id !== response.branch.id)],
              credits: response.creditsRemaining ?? current.credits,
              unlimitedCredits: response.unlimitedCredits ?? current.unlimitedCredits,
            }
          : current,
      );
      const activation = await activateCampaignBranch({
        campaignId: session.campaign.id,
        branchId: response.branch.id,
      });
      if (activation.creditsUsed !== 0) {
        throw new Error("Opening a newly purchased timeline must not use more credits.");
      }
      clearPendingCampaignBranchRequest({
        playerId: auth.userId,
        campaignId: session.campaign.id,
        requestId: pendingRequest.requestId,
      });
      pendingBranchRequestRef.current = null;
      toast.success(
        session.campaign.experienceMode === "solo"
          ? session.unlimitedCredits
            ? "Alternate branch created. Your unlimited testing account was not charged."
            : `Alternate branch created for ${session.productPricing.branchCredits} credits.`
          : "Author branch created. Author mode was not charged.",
      );
      void auth.refresh();
      navigate(`/profile/campaigns/${activation.campaignId}/play`);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The writer branch could not be created.");
    } finally {
      setCheckpointBusy(false);
    }
  };

  const openBranch = async (branchId: string) => {
    if (!session || branchStatusBusy) return;
    setBranchStatusBusy(branchId);
    try {
      const response = await activateCampaignBranch({
        campaignId: session.campaign.id,
        branchId,
      });
      if (response.creditsUsed !== 0) {
        throw new Error("Opening an existing timeline must not use credits.");
      }
      const branch = session.branches.find((item) => item.id === branchId);
      const pendingRequest = pendingBranchRequestRef.current;
      if (
        auth.userId &&
        branch?.requestId &&
        pendingRequest?.requestId === branch.requestId
      ) {
        clearPendingCampaignBranchRequest({
          playerId: auth.userId,
          campaignId: session.campaign.id,
          requestId: pendingRequest.requestId,
        });
        pendingBranchRequestRef.current = null;
      }
      navigate(`/profile/campaigns/${response.campaignId}/play`);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The timeline could not be opened.");
    } finally {
      setBranchStatusBusy(null);
    }
  };

  const changeBranchStatus = async (branchId: string, status: "draft" | "archived") => {
    if (!session) return;
    setBranchStatusBusy(branchId);
    try {
      const response = await updateCampaignBranch({ campaignId: session.campaign.id, branchId, status });
      setSession((current) => current ? {
        ...current,
        branches: current.branches.map((branch) =>
          branch.id === branchId ? { ...branch, ...response.branch } : branch,
        ).sort((left, right) =>
          Number(left.status === "archived") - Number(right.status === "archived") ||
          new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
        ),
      } : current);
      toast.success(status === "archived" ? "Timeline archived." : "Timeline restored.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The branch could not be updated.");
    } finally {
      setBranchStatusBusy(null);
    }
  };

  return (
    <ProfileFrame>
      {session ? (
        <Link
          href={`/profile/worlds/${session.campaign.worldId}`}
          className="inline-flex items-center text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to {session.campaign.worldName}
        </Link>
      ) : (
        <Link
          href="/profile/worlds"
          className="inline-flex items-center text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to my worlds
        </Link>
      )}

      {loading ? (
        <div className="grid min-h-[55vh] place-items-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : error && !session ? (
        <Card className="mt-8 rounded-3xl border-red-400/20 bg-red-400/[0.05] p-7">
          <h1 className="font-serif text-3xl font-bold">This Campaign Could Not Be Opened.</h1>
          <p className="mt-3 text-sm text-muted-foreground">{error}</p>
        </Card>
      ) : session ? (
        <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_290px]">
          <section className="min-w-0 overflow-hidden rounded-3xl border border-white/10 bg-[#121115] shadow-2xl">
            <header className="border-b border-white/8 bg-black/20 px-5 py-5 sm:px-7">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                    {session.campaign.worldName}
                  </p>
                  <h1 className="mt-2 font-serif text-3xl font-bold">
                    {session.campaign.name}
                  </h1>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Playing as {session.campaign.characterName || "your character"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {session.turns.length ? (
                    <Link
                      href={`/profile/campaigns/${session.campaign.id}/story`}
                      className="inline-flex h-9 items-center rounded-lg border border-primary/25 bg-primary/[0.08] px-3 text-xs font-semibold text-primary transition-colors hover:bg-primary/[0.14]"
                    >
                      <BookOpenCheck className="mr-1.5 h-3.5 w-3.5" /> Story Studio
                    </Link>
                  ) : null}
                  <Badge
                    variant="outline"
                    className={
                      session.runtime.configured || session.manualStorytellerEnabled
                        ? "w-fit border-emerald-400/25 text-emerald-300"
                        : "w-fit border-amber-400/25 text-amber-200"
                    }
                  >
                    {session.runtime.configured || session.manualStorytellerEnabled ? (
                      <Wifi className="mr-1.5 h-3.5 w-3.5" />
                    ) : (
                      <WifiOff className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    {session.manualStorytellerEnabled ? "Manual Test Mode" : session.runtime.configured
                      ? auth.unlimitedCredits
                        ? `${providerLabel(session.runtime.provider)} ready`
                        : "Storyteller ready"
                      : "Storyteller offline"}
                  </Badge>
                </div>
                {session.lineage?.length ? (
                  <div className="mt-4 rounded-2xl border border-primary/20 bg-primary/[0.06] px-4 py-3 text-xs">
                    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 font-semibold text-primary">
                          <GitBranch className="h-3.5 w-3.5" /> Isolated timeline
                        </p>
                        <p className="mt-1 truncate text-muted-foreground">
                          {session.lineage.map((node) => node.branchName).join(" → ")}
                        </p>
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          From {session.lineage.at(-1)?.sourceCampaignName} · {session.lineage.at(-1)?.checkpointName}
                        </p>
                      </div>
                      <Link
                        href={`/profile/campaigns/${session.lineage.at(-1)?.sourceCampaignId}/play`}
                        className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-primary/25 px-3 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/10"
                      >
                        <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Parent timeline
                      </Link>
                    </div>
                  </div>
                ) : null}
              </div>
            </header>

            <div className="max-h-[64vh] min-h-[430px] overflow-y-auto px-4 py-6 sm:px-7">
              <AdventureSetupCard
                setup={session.adventureSetup}
                busy={setupBusy}
                error={setupError}
                onPrepare={() => void prepareAdventure()}
                context={{
                  worldName: session.campaign.worldName,
                  premise: configuredText(session.campaign.lockedSettings.worldContract.premise),
                  tone: configuredText(session.campaign.lockedSettings.worldContract.tone),
                  characterName: session.campaign.characterName,
                  characterConcept: configuredText(session.campaign.lockedSettings.character.concept),
                  initialObjective: configuredText(session.campaign.lockedSettings.character.initialObjective),
                }}
              />
              {opening ? (
                <section aria-label="Your Adventure Begins" className="mb-7 rounded-2xl border border-white/8 bg-black/15 p-5">
                  <h2 className="font-serif text-xl font-bold text-primary">Your Adventure Begins</h2>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-foreground/90">{opening}</p>
                </section>
              ) : null}
              {session.turns.length === 0 && !setupBlocksPlay && !opening ? (
                <div className="mx-auto max-w-xl py-12 text-center">
                  <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-primary/25 bg-primary/10 text-primary">
                    <Sparkles className="h-6 w-6" />
                  </span>
                  <h2 className="mt-5 font-serif text-3xl font-bold">The Beginning Is Locked.</h2>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">
                    Your sources, character origin, and opening state are fixed. Say what you do,
                    say what you notice, or simply speak in character.
                  </p>
                  {session.clockEvents[0]?.summary ? (
                    <div className="mt-6 rounded-2xl border border-white/8 bg-black/20 p-4 text-left text-sm leading-6 text-foreground/85">
                      {session.clockEvents[0].summary}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="space-y-7">
                {session.turns.map((turn) => (
                  <div key={turn.id} className="space-y-4">
                    <div className="ml-auto max-w-[86%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground shadow-lg">
                      {turn.playerAction}
                    </div>
                    <article className="max-w-3xl rounded-2xl rounded-tl-md border border-white/8 bg-white/[0.025] p-5">
                      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1.5 font-semibold text-foreground/80">
                          <Bot className="h-3.5 w-3.5 text-primary" /> Storyhold
                        </span>
                        <span>Turn {turn.turnNumber}</span>
                        <Badge variant="outline" className="h-5 border-primary/20 px-1.5 text-[10px] text-primary">
                          {inputModeLabel(turn.inputMode)}
                        </Badge>
                        {visibleOutcomeLabel(turn, session.campaign.resolutionMode) ? (
                          <Badge variant="outline" className="h-5 border-white/10 px-1.5 text-[10px]">
                            {visibleOutcomeLabel(turn, session.campaign.resolutionMode)}
                          </Badge>
                        ) : null}
                        {turn.roll && !turn.check ? (
                          <span className="flex items-center gap-1">
                            <Dice5 className="h-3.5 w-3.5" />
                            {turn.roll.d20 === null
                              ? `Luck ${turn.roll.percentile}`
                              : `d20 ${turn.roll.d20}`}
                          </span>
                        ) : null}
                        <span className="flex items-center gap-1">
                          <LockKeyhole className="h-3.5 w-3.5" /> Committed
                        </span>
                      </div>
                      <div className="whitespace-pre-wrap font-serif text-[17px] leading-8 text-foreground/92">
                        {turn.narration}
                      </div>
                      <CampaignCheckResult
                        check={turn.check}
                        resolutionMode={session.campaign.resolutionMode}
                      />
                      <div className="mt-4 border-t border-white/8 pt-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="mr-1 text-[11px] text-muted-foreground">
                            Teach Lorekeeper what you enjoy
                          </span>
                          <button
                            type="button"
                            aria-label="I liked this turn"
                            aria-pressed={turn.feedback?.rating === 1}
                            disabled={feedbackBusy !== null}
                            onClick={() => void saveTurnFeedback(turn, 1)}
                            className={`rounded-lg border p-1.5 transition-colors disabled:opacity-50 ${turn.feedback?.rating === 1 ? "border-emerald-300/40 bg-emerald-300/10 text-emerald-200" : "border-white/8 text-muted-foreground hover:text-foreground"}`}
                          >
                            {feedbackBusy === turn.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <ThumbsUp className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            aria-label="I disliked this turn"
                            aria-pressed={turn.feedback?.rating === -1}
                            disabled={feedbackBusy !== null}
                            onClick={() => void saveTurnFeedback(turn, -1)}
                            className={`rounded-lg border p-1.5 transition-colors disabled:opacity-50 ${turn.feedback?.rating === -1 ? "border-amber-300/40 bg-amber-300/10 text-amber-100" : "border-white/8 text-muted-foreground hover:text-foreground"}`}
                          >
                            {feedbackBusy === turn.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <ThumbsDown className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </div>
                        {turn.feedback ? (
                          <>
                            <div className="mt-2 flex flex-wrap gap-1.5" aria-label="What this feedback is about">
                              {FEEDBACK_ASPECTS.map((aspect) => (
                                <button
                                  key={aspect.id}
                                  type="button"
                                  aria-pressed={turn.feedback?.tags.includes(aspect.id)}
                                  disabled={feedbackBusy !== null}
                                  onClick={() => toggleFeedbackAspect(turn, aspect.id)}
                                  className={`rounded-full border px-2 py-1 text-[10px] transition-colors disabled:opacity-50 ${turn.feedback?.tags.includes(aspect.id) ? "border-primary/35 bg-primary/10 text-primary" : "border-white/8 text-muted-foreground hover:text-foreground"}`}
                                >
                                  {aspect.label}
                                </button>
                              ))}
                            </div>
                            <details className="mt-2 text-[11px] text-muted-foreground">
                              <summary className="cursor-pointer hover:text-foreground">
                                What did you like or dislike?
                              </summary>
                              <Textarea
                                key={`${turn.id}-${turn.feedback.updatedAt ?? "feedback"}`}
                                defaultValue={turn.feedback.note}
                                maxLength={500}
                                disabled={feedbackBusy !== null}
                                placeholder="Example: I prefer the egg lifecycle here, not the black-goo interpretation."
                                className="mt-2 min-h-16 bg-black/20 text-xs leading-5"
                                onBlur={(event) => {
                                  const note = event.currentTarget.value.trim();
                                  if (note !== turn.feedback?.note) {
                                    void saveTurnFeedback(
                                      turn,
                                      turn.feedback?.rating ?? 1,
                                      turn.feedback?.tags ?? [],
                                      note,
                                    );
                                  }
                                }}
                              />
                              <p className="mt-1 leading-5">
                                {session.campaign.experienceMode === "author"
                                  ? "Author guidance can shape future canon, but committed history changes only through a deliberate branch or canon amendment."
                                  : "Continuity, lore, character, pacing, and prose notes guide future turns. Disliking a loss or difficulty does not reverse a committed consequence; use an alternate branch to diverge."}
                              </p>
                            </details>
                          </>
                        ) : null}
                      </div>
                    </article>
                  </div>
                ))}
                {manualTurnIsPending(session.pendingManualTurn) ? (
                  <div role="status" className="rounded-2xl border border-primary/20 bg-primary/[0.06] p-5">
                    <p className="font-semibold">Turn Saved for Manual Review</p>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      Your choice is saved. Ask Codex to process the latest test entry, then refresh here to see the completed story response. This test uses no premium API calls or credits.
                    </p>
                    {session.pendingManualTurn?.error ? <p className="mt-2 text-sm text-amber-200">This answer needs a correction in the private test queue.</p> : null}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button type="button" variant="outline" disabled={sending} onClick={refreshManualTurn}>
                        <RotateCcw className="mr-2 h-4 w-4" /> Refresh Story
                      </Button>
                      {session.manualStorytellerEnabled && ["owner", "admin"].includes(auth.role ?? "") ? (
                        <Link href="/admin/manual-storyteller" className="inline-flex items-center rounded-md border px-3 py-2 text-sm">Open Test Queue</Link>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {session.pendingProposal ? (
                  <div className="space-y-4">
                    <div className="ml-auto max-w-[86%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground shadow-lg">
                      <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.14em] opacity-70">
                        {inputModeLabel(session.pendingProposal.inputMode)}
                      </span>
                      {session.pendingProposal.playerAction}
                    </div>
                    <article className="max-w-3xl rounded-2xl rounded-tl-md border border-amber-300/20 bg-amber-300/[0.035] p-5">
                      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1.5 font-semibold text-foreground/80">
                          <Bot className="h-3.5 w-3.5 text-primary" /> Storyhold
                        </span>
                        <Badge className="h-5 bg-amber-300/15 px-1.5 text-[10px] text-amber-100 hover:bg-amber-300/15">
                          Draft · Not Canon
                        </Badge>
                        {visibleOutcomeLabel(
                          session.pendingProposal,
                          session.campaign.resolutionMode,
                        ) ? (
                          <Badge variant="outline" className="h-5 border-white/10 px-1.5 text-[10px]">
                            {visibleOutcomeLabel(
                              session.pendingProposal,
                              session.campaign.resolutionMode,
                            )}
                          </Badge>
                        ) : null}
                        <span className="flex items-center gap-1">
                          <LockKeyhole className="h-3.5 w-3.5" /> Outcome locked
                        </span>
                        <span>Prose revision {session.pendingProposal.revision}</span>
                      </div>
                      <div className="whitespace-pre-wrap font-serif text-[17px] leading-8 text-foreground/92">
                        {session.pendingProposal.browserNarrationTask ? (
                          <span className="flex items-center gap-3 font-sans text-sm text-muted-foreground">
                            {session.manualStorytellerEnabled ? "This earlier draft is paused. Discard it to send a new manual test turn." : <><Loader2 className="h-4 w-4 animate-spin text-primary" />{localAssistMessage || "Storyhold is writing the locked outcome…"}</>}
                          </span>
                        ) : session.pendingProposal.narration}
                      </div>
                      <CampaignCheckResult
                        check={session.pendingProposal.check}
                        resolutionMode={session.campaign.resolutionMode}
                      />
                      <div className="mt-5 flex flex-wrap gap-2 border-t border-white/8 pt-4">
                        <Button
                          type="button"
                          onClick={acceptProposal}
                          disabled={proposalBusy !== null || sending || Boolean(session.pendingProposal.browserNarrationTask)}
                          className="rounded-xl"
                        >
                          {proposalBusy === "accept" ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Check className="mr-2 h-4 w-4" />
                          )}
                          Accept and commit
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={regenerateProposal}
                          disabled={proposalBusy !== null || sending || Boolean(session.pendingProposal.browserNarrationTask) || session.manualStorytellerEnabled}
                          className="rounded-xl"
                        >
                          {proposalBusy === "regenerate" ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <RotateCcw className="mr-2 h-4 w-4" />
                          )}
                          Rewrite prose
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setPricedChoice({ kind: "reroll" })}
                          disabled={proposalBusy !== null || sending || Boolean(session.pendingProposal.browserNarrationTask) || session.manualStorytellerEnabled}
                          className="rounded-xl border-amber-300/25 text-amber-100 hover:bg-amber-300/10"
                        >
                          {proposalBusy === "reroll" ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Dice5 className="mr-2 h-4 w-4" />
                          )}
                          Re-roll outcome · {session.campaign.experienceMode === "author" ? "Free in Author mode" : session.unlimitedCredits ? `Included (normally ${session.productPricing.rerollCredits})` : `${session.productPricing.rerollCredits} credits`}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={discardProposal}
                          disabled={proposalBusy !== null || sending || (Boolean(session.pendingProposal.browserNarrationTask) && !session.manualStorytellerEnabled)}
                          className="rounded-xl text-muted-foreground hover:text-red-200"
                        >
                          {proposalBusy === "discard" ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="mr-2 h-4 w-4" />
                          )}
                          Discard
                        </Button>
                      </div>
                      <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
                        Rewrite changes the wording while keeping the same events and outcome. Re-roll creates a genuinely different outcome; it costs 250 credits only in Solo Play.
                      </p>
                    </article>
                  </div>
                ) : null}
                {pendingAction ? (
                  <div className="space-y-4">
                    <div className="ml-auto max-w-[86%] rounded-2xl rounded-br-md bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground">
                      <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.14em] opacity-70">
                        {inputModeLabel(pendingInputMode)}
                      </span>
                      {pendingAction}
                    </div>
                    <div className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.025] p-5 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      {localAssistMessage || (session.manualStorytellerEnabled ? "Saving Your Choice for Manual Review…" : "Storyhold is resolving the outcome and drafting the scene…")}
                    </div>
                  </div>
                ) : null}
                <div ref={endRef} />
              </div>
            </div>

            <form onSubmit={submit} className="border-t border-white/8 bg-black/20 p-4 sm:p-5">
              {error ? (
                <p className="mb-3 rounded-xl border border-red-400/20 bg-red-400/[0.05] px-3 py-2 text-sm text-red-200">
                  {error}
                </p>
              ) : null}
              {!session.runtime.configured && !session.manualStorytellerEnabled ? (
                <p className="mb-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] px-3 py-2 text-sm text-amber-100">
                  Connect at least one storyteller in Storyhold’s private local settings before playing.
                </p>
              ) : null}
              {session.manualStorytellerEnabled && !manualTurnIsPending(session.pendingManualTurn) ? (
                <p className="mb-3 rounded-xl border border-primary/20 bg-primary/[0.05] px-3 py-2 text-sm text-muted-foreground">
                  Manual Test Mode: sending saves the turn for review. No premium API calls or credits are used.
                </p>
              ) : null}
              {session.pendingProposal ? (
                <p className="mb-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.05] px-3 py-2 text-sm text-amber-100">
                  Accept, rewrite, or discard the pending draft before entering another choice.
                </p>
              ) : null}
              <div className="mb-3">
                <div
                  role="group"
                  aria-label="How Storyhold should read this message"
                  className={`grid gap-1 rounded-xl border border-white/8 bg-[#0e0d10] p-1 ${session.campaign.experienceMode === "author" ? "grid-cols-3" : "grid-cols-2"}`}
                >
                  {campaignInputModes(session.campaign.experienceMode).map((option) => {
                    const selected = inputMode === option.id;
                    const Icon = option.id === "question" ? CircleHelp : option.id === "event" ? Sparkles : Dice5;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={selected}
                        disabled={setupBlocksPlay || setupBusy || sending || Boolean(session.pendingProposal) || manualTurnIsPending(session.pendingManualTurn) || (!session.runtime.configured && !session.manualStorytellerEnabled)}
                        onClick={() => setInputMode(option.id)}
                        className={`flex items-center justify-center rounded-lg px-2 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                          selected
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : "text-muted-foreground hover:bg-white/[0.045] hover:text-foreground"
                        }`}
                      >
                        <Icon className="mr-1.5 h-3.5 w-3.5" /> {option.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 px-1 text-[11px] leading-4 text-muted-foreground">
                  {CAMPAIGN_INPUT_MODES.find((option) => option.id === inputMode)?.helper}
                </p>
              </div>
              <div className="flex items-end gap-3">
                <Textarea
                  value={action}
                  onChange={(event) => setAction(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={CAMPAIGN_INPUT_MODES.find((option) => option.id === inputMode)?.placeholder}
                  maxLength={4_000}
                  disabled={setupBlocksPlay || setupBusy || sending || Boolean(session.pendingProposal) || manualTurnIsPending(session.pendingManualTurn) || (!session.runtime.configured && !session.manualStorytellerEnabled)}
                  className="min-h-20 resize-y rounded-2xl bg-[#0e0d10]"
                />
                <Button
                  type="submit"
                  size="icon"
                  disabled={setupBlocksPlay || setupBusy || sending || Boolean(session.pendingProposal) || manualTurnIsPending(session.pendingManualTurn) || !action.trim() || (!session.runtime.configured && !session.manualStorytellerEnabled)}
                  className="h-12 w-12 shrink-0 rounded-xl"
                  aria-label={`Send ${inputMode}`}
                >
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-muted-foreground">
                <span>Enter sends · Shift+Enter adds a line</span>
                <span>{session.manualStorytellerEnabled ? "The reviewed response appears after refresh." : "Only a turn you accept becomes part of the story."}</span>
              </div>
            </form>
          </section>

          <aside className="space-y-4">
            {session.rpgState ? (
              <CampaignRpgStatePanel
                state={enforceStoryFirstRpgState(
                  session.rpgState,
                  session.campaign.resolutionMode,
                )}
              />
            ) : null}

            <Card className="rounded-2xl border-white/8 bg-white/[0.025] p-5">
              <div className="flex items-center gap-2 text-primary">
                <Clock3 className="h-4 w-4" />
                <p className="text-xs font-semibold uppercase tracking-[0.16em]">World Clock</p>
              </div>
              <p className="mt-3 font-serif text-xl font-bold">
                {session.campaign.currentTimeLabel || "The beginning"}
              </p>
              <div className="mt-4 space-y-3">
                {session.clockEvents.slice(-6).reverse().map((clockEvent) => (
                  <div key={clockEvent.id} className="border-l border-primary/25 pl-3">
                    <p className="text-sm font-semibold">{clockEvent.title}</p>
                    <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">
                      {clockEvent.summary}
                    </p>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="rounded-2xl border-white/8 bg-white/[0.025] p-5">
              <div className="flex items-center gap-2 text-primary">
                <Eye className="h-4 w-4" />
                <p className="text-xs font-semibold uppercase tracking-[0.16em]">
                  What {session.campaign.characterName || "you"} knows
                </p>
              </div>
              {session.knownState?.length ? (
                <div className="mt-4 space-y-3">
                  {session.knownState.slice(0, 7).map((known) => (
                    <div key={known.id} className="border-l border-primary/20 pl-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-semibold">{known.subject}</p>
                        <span className="shrink-0 text-[9px] font-bold uppercase tracking-[0.12em] text-muted-foreground/70">
                          {known.layer.replaceAll("_", " ")}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">
                        {known.summary}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  Confirmed discoveries, beliefs, and claims will collect here without exposing hidden reality.
                </p>
              )}
            </Card>

            <Card className="rounded-2xl border-white/8 bg-white/[0.025] p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-primary">
                  <BookmarkPlus className="h-4 w-4" />
                  <p className="text-xs font-semibold uppercase tracking-[0.16em]">
                    Checkpoints
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={checkpointBusy || Boolean(session.pendingProposal)}
                  onClick={saveCheckpoint}
                  className="h-8 rounded-lg px-2 text-[11px]"
                >
                  {checkpointBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                </Button>
              </div>
              {session.checkpoints?.length ? (
                <div className="mt-4 space-y-3">
                  {session.checkpoints.slice(0, 4).map((checkpoint) => (
                    <div key={checkpoint.id} className="rounded-xl border border-white/8 bg-black/15 p-3">
                      <p className="text-sm font-semibold">{checkpoint.name}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {checkpoint.worldTimeLabel || "The Beginning"}
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={checkpointBusy}
                        onClick={() => setPricedChoice({ kind: "branch", checkpointId: checkpoint.id })}
                        className="mt-2 h-7 px-0 text-[11px] text-primary hover:bg-transparent hover:text-primary/80"
                      >
                        <GitBranch className="mr-1.5 h-3.5 w-3.5" /> {session.campaign.experienceMode === "author" ? "Create author branch · Free" : session.unlimitedCredits ? `Create alternate branch · Included (normally ${session.productPricing.branchCredits})` : `Create alternate branch · ${session.productPricing.branchCredits} credits`}
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  Save an immutable point before exploring {session.campaign.experienceMode === "author" ? "another author-controlled direction" : "an alternate game timeline"}.
                </p>
              )}
              {session.branches?.length ? (
                <details className="mt-4 border-t border-white/8 pt-3" open>
                  <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                    {session.campaign.experienceMode === "author" ? "Author drafts" : "Alternate timelines"}
                    <span className="ml-2 text-primary">{session.branches.length}</span>
                  </summary>
                  <div className="mt-3 space-y-2">
                  {session.branches.map((branch) => (
                    <div key={branch.id} className={`rounded-xl border p-3 text-xs ${branch.status === "archived" ? "border-white/5 bg-black/10 opacity-60" : "border-white/8 bg-black/15"}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0"><p className="truncate font-semibold">{branch.name}</p><p className="mt-1 text-[10px] text-muted-foreground">From {branch.checkpointName} · {branch.worldTimeLabel || "The Beginning"}</p></div>
                        <Badge variant="outline" className="h-5 shrink-0 border-white/10 px-1.5 text-[9px]">{branch.status === "archived" ? "Archived" : "Isolated"}</Badge>
                      </div>
                      {branch.checkpointNote ? <p className="mt-2 line-clamp-2 leading-4 text-muted-foreground">{branch.checkpointNote}</p> : null}
                      {branch.lastSceneSummary ? <p className="mt-2 line-clamp-2 leading-4 text-foreground/75">{branch.lastSceneSummary}</p> : null}
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        {branch.status !== "archived" ? (
                          <Button type="button" size="sm" variant="ghost" disabled={branchStatusBusy === branch.id} className="h-7 px-0 text-[10px] text-primary hover:bg-transparent hover:text-primary/80" onClick={() => void openBranch(branch.id)}>
                            {branchStatusBusy === branch.id ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <GitBranch className="mr-1.5 h-3 w-3" />}
                            {branch.playableCampaignId ? "Resume timeline" : "Open timeline"}
                          </Button>
                        ) : null}
                        <Button type="button" size="sm" variant="ghost" disabled={branchStatusBusy === branch.id} className="h-7 px-0 text-[10px] text-muted-foreground hover:bg-transparent hover:text-primary" onClick={() => void changeBranchStatus(branch.id, branch.status === "archived" ? "draft" : "archived")}>
                          {branchStatusBusy === branch.id ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : branch.status === "archived" ? <RotateCcw className="mr-1.5 h-3 w-3" /> : <Trash2 className="mr-1.5 h-3 w-3" />}
                          {branch.status === "archived" ? "Restore to branch list" : "Archive this branch"}
                        </Button>
                      </div>
                    </div>
                  ))}
                  </div>
                </details>
              ) : null}
            </Card>

            <Card className="rounded-2xl border-white/8 bg-white/[0.025] p-5">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Coins className="h-4 w-4 text-primary" /> Credits
                </span>
                <strong>{session.unlimitedCredits ? "Unlimited" : session.credits}</strong>
              </div>
              {!session.unlimitedCredits && lastCreditsUsed !== null ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Last turn used {lastCreditsUsed} credit{lastCreditsUsed === 1 ? "" : "s"}.
                </p>
              ) : null}
              <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <LockKeyhole className="h-4 w-4 text-primary" /> Starting state
                </span>
                <strong>Locked</strong>
              </div>
              <p className="mt-4 text-xs leading-5 text-muted-foreground">
                Credit use follows the scene's length, memory, and reasoning needs. Storyhold returns any credits the finished turn did not need. Hidden timers remain hidden until their conditions are met.
              </p>
            </Card>

            {auth.unlimitedCredits ? (
              <Card className="rounded-2xl border-white/8 bg-white/[0.025] p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
                  Connections
                </p>
                <div className="mt-3 space-y-2">
                  {session.runtime.providers.map((provider) => (
                    <div key={provider.id} className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-muted-foreground">{provider.label}</span>
                      <span className={provider.configured ? "text-emerald-300" : "text-muted-foreground/60"}>
                        {provider.configured ? "Ready" : "Not connected"}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}
          </aside>
        </div>
      ) : null}
      <AlertDialog
        open={pricedChoice !== null}
        onOpenChange={(open) => {
          if (!open) setPricedChoice(null);
        }}
      >
        <AlertDialogContent className="border-primary/35 bg-[#111014] shadow-2xl shadow-black/75 sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif text-2xl">
              {pricedChoice?.kind === "reroll" ? "Re-roll this outcome?" : "Create a new timeline branch?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="leading-6">
              {pricedChoice?.kind === "reroll"
                ? session?.campaign.experienceMode === "solo"
                  ? session.unlimitedCredits
                    ? `Storyhold will discard this pending result and make a genuinely new causal roll. The standard price is ${session.productPricing.rerollCredits} credits; your unlimited testing account will not be charged.`
                    : `Storyhold will discard this pending result and make a genuinely new causal roll. This costs ${session.productPricing.rerollCredits} credits.`
                  : "Storyhold will discard this pending result and make a genuinely new causal roll. Author mode is not charged."
                : session?.campaign.experienceMode === "solo"
                  ? session.unlimitedCredits
                    ? `The current canon remains intact and Storyhold opens an isolated, playable do-over from this checkpoint. The standard one-time price is ${session.productPricing.branchCredits} credits; your unlimited testing account will not be charged. Resuming it later is free.`
                    : `The current canon remains intact and Storyhold opens an isolated, playable do-over from this checkpoint. This costs ${session.productPricing.branchCredits} credits once; resuming it later is free.`
                  : "The current canon remains intact and Storyhold opens an isolated, playable author-controlled branch. Author mode and later resumes are not charged."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current timeline</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const choice = pricedChoice;
                setPricedChoice(null);
                if (choice?.kind === "reroll") void rerollProposal();
                if (choice?.kind === "branch") void forkCheckpoint(choice.checkpointId);
              }}
              className="bg-primary text-primary-foreground"
            >
              {pricedChoice?.kind === "reroll"
                ? session?.campaign.experienceMode === "solo"
                  ? session.unlimitedCredits
                    ? "Re-roll (included)"
                    : `Spend ${session.productPricing.rerollCredits} credits`
                  : "Re-roll for free"
                : session?.campaign.experienceMode === "solo"
                  ? session.unlimitedCredits
                    ? "Create and open (included)"
                    : `Spend ${session.productPricing.branchCredits} and open`
                  : "Create and open free branch"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ProfileFrame>
  );
}
