import { Storage } from "@google-cloud/storage";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

function getPublicSearchPaths(): string[] {
  const raw = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
  const paths = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (paths.length === 0) {
    throw new Error(
      "PUBLIC_OBJECT_SEARCH_PATHS not set. Object storage has not been provisioned.",
    );
  }
  return paths;
}

function parsePath(fullPath: string): { bucketName: string; objectName: string } {
  const trimmed = fullPath.startsWith("/") ? fullPath.slice(1) : fullPath;
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    throw new Error(`Invalid object storage path: ${fullPath}`);
  }
  return { bucketName: trimmed.slice(0, slash), objectName: trimmed.slice(slash + 1) };
}

/**
 * Stable storage key + served URL of the branded "BrainHook on black" default
 * card (brand mark + wordmark + tagline). This is the SINGLE universal image
 * fallback: whenever a real hero image cannot be produced (model refusal, AI
 * disabled, a missing binary, or a legacy stock-photo URL) we resolve to this
 * card — we NEVER fall back to a random stock photo. The object is uploaded
 * idempotently at startup by `ensureDefaultShareCard()` (services/shareImage.ts),
 * and the same artwork is mirrored as the site's homepage `/opengraph.jpg`.
 *
 * The key is versioned (`-v2`): public objects are served `immutable`, so when
 * the branded artwork is replaced we must bump the key (and repoint existing DB
 * rows via a guarded migration) — otherwise caches keep serving the old card
 * for up to a year.
 */
export const DEFAULT_SHARE_CARD_PATH = "brand/default-card-v3.png";
export const DEFAULT_SHARE_CARD_URL = `/api/storage/public-objects/${DEFAULT_SHARE_CARD_PATH}`;

/**
 * List all files in the public search path, optionally under a sub-prefix.
 * Returns lightweight metadata; keys are relative to the public search path
 * (match the path segment after /api/storage/public-objects/).
 */
export async function listPublicObjects(prefix?: string): Promise<
  Array<{ key: string; url: string; size: number; contentType: string; createdAt: string }>
> {
  const [searchPath] = getPublicSearchPaths();
  // Round-trip through parsePath to get bucket + base object prefix.
  // uploadPublicBuffer calls parsePath(`${searchPath}/${filePath}`), so the
  // base prefix is the objectName of parsePath(`${searchPath}/DUMMY`) minus "DUMMY".
  const { bucketName, objectName: raw } = parsePath(`${searchPath}/DUMMY`);
  const basePrefix = raw.slice(0, -"DUMMY".length); // e.g. "public/" or ""
  const fullPrefix = prefix ? `${basePrefix}${prefix}` : basePrefix;
  const [files] = await objectStorageClient.bucket(bucketName).getFiles({ prefix: fullPrefix });
  return files
    .filter((f) => !f.name.endsWith("/")) // skip directory markers
    .map((f) => {
      const key = f.name.slice(basePrefix.length);
      return {
        key,
        url: `/api/storage/public-objects/${key}`,
        size: Number(f.metadata.size ?? 0),
        contentType: String(f.metadata.contentType ?? "image/jpeg"),
        createdAt: String(f.metadata.timeCreated ?? ""),
      };
    });
}

/**
 * Upload a buffer into the public search path so it is reachable via
 * GET /api/storage/public-objects/<filePath>. Returns the relative file path
 * (without the public-objects prefix) so callers can store it.
 */
export async function uploadPublicBuffer(
  filePath: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  const [searchPath] = getPublicSearchPaths();
  const { bucketName, objectName } = parsePath(`${searchPath}/${filePath}`);
  const file = objectStorageClient.bucket(bucketName).file(objectName);
  await file.save(body, {
    contentType,
    resumable: false,
    metadata: { cacheControl: "public, max-age=31536000, immutable" },
  });
  return filePath;
}

/**
 * Find a public object by its file path (relative to any public search path).
 */
export async function findPublicObject(filePath: string) {
  for (const searchPath of getPublicSearchPaths()) {
    const { bucketName, objectName } = parsePath(`${searchPath}/${filePath}`);
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    const [exists] = await file.exists();
    if (exists) return file;
  }
  return null;
}

const POSITIVE_TTL_MS = 365 * 24 * 60 * 60 * 1000; // images are immutable
const NEGATIVE_TTL_MS = 5 * 60 * 1000; // re-check soon in case it gets uploaded
const existsCache = new Map<string, { exists: boolean; expires: number }>();

/**
 * Best-effort delete of a public object by its file path (relative to a public
 * search path). Returns true if a file existed and was deleted. Also clears the
 * existence cache so a later re-upload at the same key is picked up.
 */
export async function deletePublicObject(filePath: string): Promise<boolean> {
  const file = await findPublicObject(filePath);
  existsCache.delete(filePath);
  if (!file) return false;
  await file.delete({ ignoreNotFound: true });
  return true;
}

/**
 * Cached existence check for a public object. Positive results are cached for a
 * year (uploaded keys are immutable); negative results for a few minutes so a
 * later upload/regeneration is picked up. Used to substitute a placeholder for
 * hero images whose binary is missing (e.g. after a dev DB resync from prod),
 * so clients never request a known-404 URL.
 */
export async function publicObjectExists(filePath: string): Promise<boolean> {
  const now = Date.now();
  const cached = existsCache.get(filePath);
  if (cached && cached.expires > now) return cached.exists;
  const exists = (await findPublicObject(filePath)) !== null;
  existsCache.set(filePath, {
    exists,
    expires: now + (exists ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
  });
  return exists;
}

/**
 * Download the raw bytes of a public object by its file path (relative to any
 * public search path). Returns null when the object does not exist or the
 * download fails. Used to embed hero images as base64 data URIs in satori cards.
 */
export async function downloadPublicBuffer(filePath: string): Promise<Buffer | null> {
  const file = await findPublicObject(filePath);
  if (!file) return null;
  try {
    const [data] = await file.download();
    return data;
  } catch {
    return null;
  }
}
