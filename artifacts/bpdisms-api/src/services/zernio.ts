import { logger } from "../lib/logger";

const API_BASE = process.env.ZERNIO_API_BASE_URL ?? "https://zernio.com/api/v1";

// Namespaced secret so this imported app can never accidentally share (or
// clobber) the main BrainHook app's ZERNIO_API_KEY — the two apps post to
// different Facebook destinations with different Zernio accounts.
function getApiKey(): string {
  const key = process.env.BPDISMS_ZERNIO_API_KEY;
  if (!key) {
    throw new Error("BPDISMS_ZERNIO_API_KEY environment variable is not set");
  }
  return key;
}

/**
 * True only when the operator has explicitly opted this instance in to live
 * Facebook posting by setting BPDISMS_POSTING_ENABLED=true.
 *
 * Deliberately stricter than the main BrainHook guard (NODE_ENV !== "development"):
 * NODE_ENV=production is set on ANY deployment including previews, restored
 * snapshots, and staging instances that happen to have the Zernio key injected.
 * An explicit boolean flag means only the designated production instance can fire
 * real posts — a dev/preview instance without this env var is safe by default.
 *
 * BPDISMS_ZERNIO_API_KEY must also be present; the flag alone is not enough.
 */
export function isPostingAllowed(): boolean {
  return (
    process.env.BPDISMS_POSTING_ENABLED === "true" &&
    Boolean(process.env.BPDISMS_ZERNIO_API_KEY)
  );
}

async function zernioRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const key = getApiKey();
  const url = `${API_BASE}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = { raw: await res.text() };
  }

  return { ok: res.ok, status: res.status, data };
}

export async function testConnection(): Promise<{
  connected: boolean;
  message: string;
}> {
  try {
    getApiKey();
  } catch {
    return { connected: false, message: "BPDISMS_ZERNIO_API_KEY is not configured" };
  }

  try {
    const result = await zernioRequest("GET", "/posts?limit=1");
    if (result.ok) {
      return { connected: true, message: "Connected to Zernio" };
    }
    if (result.status === 401) {
      return { connected: false, message: "Zernio authentication failed — check your API key" };
    }
    return {
      connected: false,
      message: `Zernio returned status ${result.status}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Zernio connection test failed");
    return { connected: false, message: `Connection failed: ${message}` };
  }
}

export async function scheduleFacebookPost(params: {
  imageUrl: string;
  caption: string;
  scheduledAt: Date;
  timezone: string;
  destinationId: string;
}): Promise<{ providerPostId: string; responseJson: string }> {
  // Hard gate: never reach Zernio unless this instance has explicitly opted in.
  // This prevents a dev/preview/restored instance from firing real FB posts even
  // if the API key happens to be present in the environment.
  if (!isPostingAllowed()) {
    throw new Error(
      "Live posting is disabled on this instance. Set BPDISMS_POSTING_ENABLED=true to enable.",
    );
  }

  const { imageUrl, caption, scheduledAt, destinationId } = params;

  const payload = {
    platforms: [{ platform: "facebook", accountId: destinationId }],
    content: caption,
    mediaItems: [{ type: "image", url: imageUrl }],
    scheduledFor: scheduledAt.toISOString(),
  };

  const result = await zernioRequest("POST", "/posts", payload);

  if (!result.ok) {
    const errData = result.data as Record<string, unknown>;
    const msg =
      (errData?.message as string) ||
      (errData?.error as string) ||
      `Zernio scheduling failed with status ${result.status}`;

    if (result.status === 401) {
      throw new Error("Zernio authentication failed — check your API key");
    }
    throw new Error(msg);
  }

  const data = result.data as Record<string, unknown>;
  const post = (data?.post ?? data) as Record<string, unknown>;
  const providerPostId = (post?._id ?? post?.id ?? "") as string;

  return {
    providerPostId: String(providerPostId),
    responseJson: JSON.stringify(result.data),
  };
}

export async function getPostStatus(
  providerPostId: string,
): Promise<{ status: string; responseJson: string } | { unsupported: true }> {
  try {
    const result = await zernioRequest("GET", `/posts/${providerPostId}`);
    if (result.status === 404) {
      return { status: "unknown", responseJson: JSON.stringify(result.data) };
    }
    if (!result.ok) {
      return { status: "error", responseJson: JSON.stringify(result.data) };
    }
    const data = result.data as Record<string, unknown>;
    const post = (data?.post ?? data) as Record<string, unknown>;
    const status = (post?.status ?? "unknown") as string;
    return { status, responseJson: JSON.stringify(result.data) };
  } catch (err) {
    logger.error({ err, providerPostId }, "getPostStatus failed");
    return { unsupported: true };
  }
}

async function zernioGet(
  path: string,
  label: string,
): Promise<{ ok: true; data: unknown } | { ok: false; status: number; message: string }> {
  const result = await zernioRequest("GET", path);
  if (!result.ok) {
    const data = result.data as Record<string, unknown>;
    const message =
      (data?.message as string) ||
      (data?.error as string) ||
      (result.status === 401
        ? "Zernio authentication failed — check your API key"
        : `Zernio ${label} request failed with status ${result.status}`);
    return { ok: false, status: result.status, message };
  }
  return { ok: true, data: result.data };
}

export async function getAnalytics(): Promise<
  { ok: true; data: unknown } | { ok: false; status: number; message: string }
> {
  return zernioGet("/analytics?limit=50", "analytics");
}

export async function getBestTimes(): Promise<
  { ok: true; data: unknown } | { ok: false; status: number; message: string }
> {
  return zernioGet("/analytics/best-time", "best-time");
}

export async function getAccounts(): Promise<
  { ok: true; data: unknown } | { ok: false; status: number; message: string }
> {
  return zernioGet("/accounts", "accounts");
}

export async function cancelPost(
  providerPostId: string,
): Promise<{ cancelled: boolean; message: string } | { unsupported: true }> {
  try {
    const result = await zernioRequest("DELETE", `/posts/${providerPostId}`);
    if (result.ok) {
      return { cancelled: true, message: "Post cancelled" };
    }
    if (result.status === 404) {
      return { cancelled: true, message: "Post already gone on Zernio" };
    }
    const data = result.data as Record<string, unknown>;
    return {
      cancelled: false,
      message: (data?.message as string) ?? `Cancel failed with status ${result.status}`,
    };
  } catch (err) {
    logger.error({ err, providerPostId }, "cancelPost failed");
    return { unsupported: true };
  }
}
