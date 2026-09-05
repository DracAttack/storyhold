import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Loader2, Radio, Send, Shield, WifiOff } from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import type { StoryholdScenario } from "@/lib/storyholdScenarios";
import {
  continueDemoChat,
  getDemoAvailability,
} from "@/lib/storyholdPublicApi";
import { useCustomerAccount } from "./customer-shell";

type ChatMessage = {
  id: string;
  role: "player" | "storyhold";
  content: string;
};

const FREE_TURNS = 4;

type DemoConsoleProps = {
  scenario?: StoryholdScenario;
  onSessionLockChange?: (locked: boolean) => void;
};

export function DemoConsole({ scenario, onSessionLockChange }: DemoConsoleProps) {
  const auth = useAuth();
  const { openAccount } = useCustomerAccount();
  const [availability, setAvailability] = useState<"checking" | "online" | "offline">(
    "checking",
  );
  const [statusMessage, setStatusMessage] = useState("Checking the storyteller...");
  const [premise, setPremise] = useState(
    scenario?.premise ??
      "I am a compromised executive of a vast off-world corporation. A containment alarm begins during a board meeting.",
  );
  const [input, setInput] = useState(scenario?.openingMove ?? "");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [remainingTurns, setRemainingTurns] = useState(FREE_TURNS);
  const [busy, setBusy] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void getDemoAvailability()
      .catch(() => ({
        available: false,
        label: "Storyteller offline",
        message: "No connected storyteller is available.",
      }))
      .then((server) => {
        if (!active) return;
        setAvailability(server.available ? "online" : "offline");
        setStatusMessage(server.message);
        if (server.available) {
          setMessages([
            {
              id: "welcome",
              role: "storyhold",
              content:
                "Set the world, tell me who you are, then make your first move. You have four turns to try Storyhold.",
            },
          ]);
        }
      })
      .catch(() => {
        if (!active) return;
        setAvailability("offline");
        setStatusMessage("The storyteller could not be reached in this local build.");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!scenario || sessionId) return;
    setPremise(scenario.premise);
    setInput(scenario.openingMove);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [scenario, sessionId]);

  useEffect(() => {
    onSessionLockChange?.(Boolean(sessionId));
  }, [onSessionLockChange, sessionId]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const action = input.trim();
    if (
      action.length < 2 ||
      busy ||
      remainingTurns === 0 ||
      availability !== "online"
    ) {
      return;
    }
    const playerMessage: ChatMessage = {
      id: `player-${Date.now()}`,
      role: "player",
      content: action,
    };
    setMessages((current) => [...current, playerMessage]);
    setInput("");
    setBusy(true);
    try {
      const result = await continueDemoChat({ premise, message: action, sessionId });
      setSessionId(result.sessionId);
      setRemainingTurns(result.remainingTurns);
      setMessages((current) => [
        ...current,
        {
          id: `storyhold-${result.turnNumber}`,
          role: "storyhold",
          content: result.reply,
        },
      ]);
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "The storyteller could not continue.";
      setAvailability("offline");
      setStatusMessage(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const online = availability === "online";

  return (
    <div id="scene-console" className="scroll-mt-32 overflow-hidden rounded-3xl border border-white/10 bg-[#100f12] shadow-[0_35px_90px_rgba(0,0,0,0.45)]">
      <div className="flex items-center justify-between border-b border-white/8 bg-white/[0.025] px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          {availability === "checking" ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : online ? (
            <Radio className="h-4 w-4 text-emerald-400" />
          ) : (
            <WifiOff className="h-4 w-4 text-amber-300" />
          )}
          <span className="text-xs font-semibold uppercase tracking-[0.18em]">
            {availability === "checking"
              ? "Checking"
              : online
                ? "Live storyteller"
                : "Storyteller offline"}
          </span>
        </div>
        <span className="max-w-[48%] truncate text-xs text-muted-foreground">
          {scenario?.title ?? (online ? "4 free turns" : "Local build")}
        </span>
      </div>

      <div className="border-b border-white/8 px-4 py-4 sm:px-5">
        <Label htmlFor="demo-premise" className="text-[11px] uppercase tracking-[0.16em] text-primary">
          Your starting point
        </Label>
        <Textarea
          id="demo-premise"
          value={premise}
          onChange={(event) => setPremise(event.target.value)}
          disabled={Boolean(sessionId) || !online}
          className="mt-2 min-h-24 resize-none rounded-xl border-white/10 bg-black/20 text-sm leading-6 disabled:opacity-60"
          maxLength={1_200}
        />
      </div>

      <div ref={transcriptRef} className="h-[360px] space-y-4 overflow-y-auto px-4 py-5 sm:px-5">
        {!online ? (
          <div className="grid h-full place-items-center">
            <div className="max-w-md rounded-2xl border border-amber-300/20 bg-amber-300/[0.05] p-6 text-center">
              {availability === "checking" ? (
                <Loader2 className="mx-auto h-7 w-7 animate-spin text-primary" />
              ) : (
                <WifiOff className="mx-auto h-7 w-7 text-amber-300" />
              )}
              <h2 className="mt-4 font-serif text-2xl font-bold">
                {availability === "checking" ? "Waking the storyteller" : "No canned story in its place."}
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                {statusMessage} Storyhold will wait until the storyteller is available instead of inventing a canned reply.
              </p>
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={
                message.role === "player"
                  ? "ml-8 rounded-xl rounded-br-sm bg-primary px-4 py-3 text-sm leading-6 text-primary-foreground"
                  : "mr-5 rounded-xl rounded-bl-sm border border-white/8 bg-white/[0.035] px-4 py-3 text-sm leading-6 text-foreground/90"
              }
            >
              {message.role === "storyhold" ? (
                <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
                  <Shield className="h-3 w-3" /> Storyhold
                </div>
              ) : null}
              <p className="whitespace-pre-line">{message.content}</p>
            </div>
          ))
        )}
        {busy ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" /> The world is answering...
          </div>
        ) : null}
      </div>

      <div className="border-t border-white/8 p-4 sm:p-5">
        {!online ? (
          <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center"><p className="text-sm text-muted-foreground">Live controls will appear when a storyteller connection is configured.</p><Button asChild size="sm" variant="outline"><Link href={auth.email ? "/profile/worlds" : "/profile"}>{auth.email ? "Open my worlds" : "Build a world"}<ArrowRight className="ml-2 h-4 w-4" /></Link></Button></div>
        ) : remainingTurns > 0 ? (
          <form onSubmit={submit} className="flex gap-2">
            <Input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={online ? "What do you do?" : "Live play is unavailable"}
              className="h-11 rounded-xl border-white/10 bg-black/25"
              maxLength={700}
              disabled={!online || busy}
            />
            <Button
              type="submit"
              size="icon"
              className="h-11 w-11 shrink-0 rounded-xl"
              disabled={!online || busy || input.trim().length < 2}
              aria-label="Continue scene"
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
        ) : (
          <div className="rounded-2xl border border-primary/25 bg-primary/[0.07] p-4">
            <p className="font-semibold">Your free preview is complete.</p>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {auth.email
                ? "Open your worlds to begin building a lasting adventure."
                : "Create an account to build worlds and prepare longer adventures."}
            </p>
            {auth.email ? (
              <Button asChild className="mt-3 h-9 rounded-lg px-4">
                <Link href="/profile/worlds">
                  Open my worlds <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            ) : (
              <Button
                onClick={() => openAccount("register")}
                className="mt-3 h-9 rounded-lg px-4"
              >
                Create free account <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            )}
          </div>
        )}
        {online ? <div className="mt-3 flex items-center justify-between gap-4 text-[11px] text-muted-foreground">
          <div className="flex gap-1.5" aria-label={`${remainingTurns} free turns remaining`}>
            {Array.from({ length: FREE_TURNS }).map((_, index) => (
              <span
                key={index}
                className={`h-1.5 w-7 rounded-full ${
                  index < FREE_TURNS - remainingTurns ? "bg-primary" : "bg-white/10"
                }`}
              />
            ))}
          </div>
          <span>{remainingTurns} free turns remaining</span>
        </div> : null}
      </div>
    </div>
  );
}
