import type { AiRuntimeStatus } from "@/lib/storyholdApi";

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/storyhold`;

export type StoryholdAccount = {
  email: string;
  userId: string;
  role: string;
  displayName: string;
  credits: number;
};

export type DemoChatResponse = {
  sessionId: string;
  reply: string;
  turnNumber: number;
  remainingTurns: number;
  limitReached: boolean;
  contextUsed: number;
  contextLimit: number;
  runtime: AiRuntimeStatus;
};

export type DemoAvailability = {
  available: boolean;
  label: string;
  message: string;
};

async function jsonResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : `Storyhold request failed (${response.status}).`,
    );
  }
  return body as T;
}

export async function registerStoryholdAccount(input: {
  displayName: string;
  email: string;
  password: string;
  acceptedTerms: boolean;
  termsVersion: string;
}): Promise<StoryholdAccount> {
  return jsonResponse(
    await fetch(`${apiBase}/auth/register`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function signInStoryholdAccount(input: {
  email: string;
  password: string;
}): Promise<StoryholdAccount> {
  return jsonResponse(
    await fetch(`${apiBase}/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function continueDemoChat(input: {
  premise: string;
  message: string;
  sessionId?: string;
}): Promise<DemoChatResponse> {
  return jsonResponse(
    await fetch(`${apiBase}/demo/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function getDemoAvailability(): Promise<DemoAvailability> {
  return jsonResponse(
    await fetch(`${apiBase}/demo/status`, {
      headers: { Accept: "application/json" },
    }),
  );
}
