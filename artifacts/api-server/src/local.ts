import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { compare, hash } from "bcryptjs";
import cookieParser from "cookie-parser";
import { Pool } from "pg";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  initializeWorldStudio,
  registerWorldStudioRoutes,
} from "./storyhold/worldStudio";
import {
  continueDemoScene,
  getAiRuntimeStatus,
  type DemoSceneTurn,
} from "./storyhold/worldAnalysis";
import { acquireStoryholdVaultOwnership } from "./storyhold/vaultOwnership";
import {
  PostgresStoryholdAdapter,
  type StoryholdDb,
} from "./storyhold/postgresAdapter";
import { createStoryholdSourceVaultStorage } from "./storyhold/sourceVaultStorage";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(__dir, "../../..");
const localEnvPath = path.join(repoDir, ".storyhold.env");

// Local keys live in one ignored file beside package.json. Replit and other
// deployments continue to provide the same names through their secret store.
if (existsSync(localEnvPath)) {
  const localEnv = await readFile(localEnvPath, "utf8");
  for (const line of localEnv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    // Windows launchers and managed shells can inject an environment variable
    // as an empty string. Treat that the same as absent so an explicitly
    // configured local Storyhold value is not silently ignored.
    if (/^[A-Z][A-Z0-9_]*$/.test(name) && !process.env[name]?.trim())
      process.env[name] = value;
  }
}
const publicDir = path.join(repoDir, "artifacts", "site", "dist", "public");
const indexHtml = path.join(publicDir, "index.html");
function repoRelativePath(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return path.isAbsolute(value) ? value : path.resolve(repoDir, value);
}

const dataDir = repoRelativePath(
  process.env.STORYHOLD_LOCAL_DATA_DIR,
  path.join(repoDir, ".storyhold-data", "postgres"),
);
const storageRoot = repoRelativePath(
  process.env.STORYHOLD_LOCAL_STORAGE_ROOT,
  path.dirname(dataDir),
);
const isReplit = Boolean(process.env.REPL_ID || process.env.REPLIT_DEPLOYMENT);
const isPublishedDeployment = process.env.REPLIT_DEPLOYMENT === "1";
const managedDatabaseUrl = process.env.DATABASE_URL?.trim();
const usingManagedPostgres = Boolean(managedDatabaseUrl);
const applyingDevelopmentSchema =
  process.env.STORYHOLD_APPLY_DEVELOPMENT_SCHEMA === "1";
const confirmedDevelopmentDatabase =
  process.env.STORYHOLD_DATABASE_ENVIRONMENT === "development";
if (
  applyingDevelopmentSchema &&
  (isPublishedDeployment || !usingManagedPostgres || !confirmedDevelopmentDatabase)
) {
  throw new Error(
    "The Storyhold schema command requires the platform-bound development managed PostgreSQL environment.",
  );
}
if (isPublishedDeployment && !usingManagedPostgres) {
  throw new Error(
    "Published Storyhold requires Replit managed PostgreSQL (DATABASE_URL); PGlite is local-only.",
  );
}
if (isPublishedDeployment && !process.env.PRIVATE_OBJECT_DIR?.trim()) {
  throw new Error(
    "Published Storyhold requires Replit private App Storage (PRIVATE_OBJECT_DIR); local file storage is local-only.",
  );
}
const configuredCausalSecret =
  process.env.STORYHOLD_CAUSAL_SECRET?.trim() ||
  process.env.SESSION_SECRET?.trim();
const host =
  process.env.STORYHOLD_HOST || (isReplit ? "0.0.0.0" : "127.0.0.1");
const port = Number(process.env.PORT || "3000");
const cookieName = "storyhold.sid";
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
let startupState: "starting" | "ready" = "starting";
let startupDb: StoryholdDb | undefined;

async function markStartup(stage: string) {
  const message = `[storyhold] ${new Date().toISOString()} ${stage}`;
  if (isPublishedDeployment) {
    // Autoscale instances have no durable local filesystem. Keep startup
    // observability in process output rather than creating a local marker.
    process.stdout.write(`${message}\n`);
    return;
  }
  await writeFile(
    path.join(storageRoot, "startup-status.txt"),
    `${message}\n`,
    "utf8",
  );
}

function startupErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForPublishedSchema(db: StoryholdDb): Promise<void> {
  const deadline = Date.now() + 120_000;
  let lastFailure: unknown;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const schema = await db.query<{ release: string | null }>(
        "SELECT to_regclass('storyhold.schema_release_1') AS release",
      );
      if (schema.rows[0]?.release) return;
      lastFailure = new Error(
        "Storyhold managed PostgreSQL schema release 1 is not available yet.",
      );
    } catch (error) {
      lastFailure = error;
    }
    if (attempt === 1 || attempt % 5 === 0) {
      process.stderr.write(
        `[storyhold] Waiting for publish-time PostgreSQL schema readiness: ${startupErrorMessage(lastFailure)}\n`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(
    `Storyhold managed PostgreSQL did not become ready during startup: ${startupErrorMessage(lastFailure)}`,
    { cause: lastFailure },
  );
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT value: ${process.env.PORT}`);
}
if (isReplit && (!configuredCausalSecret || configuredCausalSecret.length < 32)) {
  throw new Error(
    "Set SESSION_SECRET or STORYHOLD_CAUSAL_SECRET to a private random value of at least 32 characters in Replit secrets before starting Storyhold.",
  );
}
if (!applyingDevelopmentSchema && !existsSync(indexHtml)) {
  throw new Error(
    "The Storyhold frontend has not been built. Run `pnpm run storyhold:local` from the repository root.",
  );
}

async function loadStoryholdIndexHtml() {
  return readFile(indexHtml, "utf8");
}

// Local development keeps its vault and startup marker together. Published
// Autoscale instances use managed PostgreSQL and private App Storage instead.
if (!isPublishedDeployment) {
  await mkdir(storageRoot, { recursive: true });
}
const app = express();
app.disable("x-powered-by");
if (isPublishedDeployment) app.set("trust proxy", 1);
app.get("/api/healthz", async (_req, res, next) => {
  if (startupState === "starting" || !startupDb) {
    res.status(503).json({ status: "starting", service: "storyhold" });
    return;
  }
  try {
    await startupDb.query("SELECT 1");
    res.json({ status: "ok", service: "storyhold" });
  } catch (error) {
    next(error);
  }
});

const server = app.listen(port, host, () => {
  void markStartup("health endpoint listening");
  process.stdout.write(
    `Storyhold startup health endpoint listening at http://${host}:${port}\n`,
  );
});

let vaultOwnership: Awaited<ReturnType<typeof acquireStoryholdVaultOwnership>> | undefined;
let db!: StoryholdDb;
if (usingManagedPostgres) {
  await markStartup("opening managed PostgreSQL");
  process.stdout.write("Opening Storyhold managed PostgreSQL...\n");
  db = new PostgresStoryholdAdapter(new Pool({ connectionString: managedDatabaseUrl }));
} else {
  await mkdir(dataDir, { recursive: true });
  vaultOwnership = await acquireStoryholdVaultOwnership(dataDir, {
    purpose: `Storyhold local server on ${host}:${port}`,
  });
  await markStartup("opening local vault");
  process.stdout.write("Opening Storyhold's local vault...\n");
  db = await PGlite.create({
    dataDir: vaultOwnership.dataDir,
    extensions: { vector },
  }) as unknown as StoryholdDb;
}
startupDb = db;
try {
  if (!usingManagedPostgres || applyingDevelopmentSchema) {
    if (!usingManagedPostgres) {
      process.env.STORYHOLD_PGLITE_RUNTIME = "true";
    } else {
      delete process.env.STORYHOLD_PGLITE_RUNTIME;
    }
    await markStartup("database opened; checking core schema");
    process.stdout.write("Database opened. Checking Storyhold's schema...\n");

  const schemaSql = String.raw`
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE SCHEMA IF NOT EXISTS storyhold;

  CREATE TABLE IF NOT EXISTS storyhold.players (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    display_name text NOT NULL DEFAULT '',
    credits integer NOT NULL DEFAULT 40 CHECK (credits >= 0),
    role text NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'creator', 'admin', 'owner')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  ALTER TABLE storyhold.players ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
  ALTER TABLE storyhold.players ADD COLUMN IF NOT EXISTS terms_version text;

  CREATE TABLE IF NOT EXISTS storyhold.sessions (
    token_hash text PRIMARY KEY,
    player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS storyhold.rulesets (
    id uuid PRIMARY KEY,
    owner_player_id uuid REFERENCES storyhold.players(id) ON DELETE SET NULL,
    canonical_key text NOT NULL UNIQUE,
    name text NOT NULL,
    definition jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS storyhold.worlds (
    id uuid PRIMARY KEY,
    owner_player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE RESTRICT,
    canonical_key text NOT NULL UNIQUE,
    name text NOT NULL,
    premise text NOT NULL DEFAULT '',
    state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS storyhold.characters (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    created_by_player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE RESTRICT,
    canonical_key text NOT NULL,
    name text NOT NULL,
    initial_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
    profile_locked_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (world_id, canonical_key)
  );

  CREATE TABLE IF NOT EXISTS storyhold.campaigns (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE RESTRICT,
    ruleset_id uuid REFERENCES storyhold.rulesets(id) ON DELETE RESTRICT,
    owner_player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE RESTRICT,
    canonical_key text NOT NULL UNIQUE,
    name text NOT NULL,
    start_contract jsonb NOT NULL DEFAULT '{}'::jsonb,
    start_locked_at timestamptz NOT NULL DEFAULT now(),
    state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS storyhold.campaign_members (
    campaign_id uuid NOT NULL REFERENCES storyhold.campaigns(id) ON DELETE CASCADE,
    player_id uuid NOT NULL REFERENCES storyhold.players(id) ON DELETE RESTRICT,
    character_id uuid REFERENCES storyhold.characters(id) ON DELETE RESTRICT,
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (campaign_id, player_id)
  );

  CREATE TABLE IF NOT EXISTS storyhold.world_state_events (
    id uuid PRIMARY KEY,
    campaign_id uuid NOT NULL REFERENCES storyhold.campaigns(id) ON DELETE CASCADE,
    sequence_number bigint NOT NULL CHECK (sequence_number > 0),
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    caused_by_player_id uuid REFERENCES storyhold.players(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (campaign_id, sequence_number)
  );

  -- One shared vault, partitioned at retrieval time by canonical IDs. This is
  -- intentionally not one database or vault per player.
  CREATE TABLE IF NOT EXISTS storyhold.vault_memory_chunks (
    id uuid PRIMARY KEY,
    world_id uuid NOT NULL REFERENCES storyhold.worlds(id) ON DELETE CASCADE,
    campaign_id uuid REFERENCES storyhold.campaigns(id) ON DELETE CASCADE,
    player_id uuid REFERENCES storyhold.players(id) ON DELETE RESTRICT,
    character_id uuid REFERENCES storyhold.characters(id) ON DELETE RESTRICT,
    memory_kind text NOT NULL,
    content text NOT NULL,
    compact_summary text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
    embedding vector(384),
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS vault_memory_world_scope
    ON storyhold.vault_memory_chunks (world_id, campaign_id, state_version);
  CREATE INDEX IF NOT EXISTS vault_memory_player_scope
    ON storyhold.vault_memory_chunks (player_id, campaign_id, state_version);

  CREATE INDEX IF NOT EXISTS vault_memory_text_search
    ON storyhold.vault_memory_chunks
    USING GIN (to_tsvector('simple', coalesce(compact_summary, content)));

  ALTER TABLE storyhold.vault_memory_chunks ADD COLUMN IF NOT EXISTS embedding_provider text;
  ALTER TABLE storyhold.vault_memory_chunks ADD COLUMN IF NOT EXISTS embedding_model text;
  ALTER TABLE storyhold.vault_memory_chunks ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz;

  -- Cross-game pattern learning is physically separate from canonical game
  -- memory so aggregate insights cannot silently rewrite a player's world.
  CREATE TABLE IF NOT EXISTS storyhold.pattern_insights (
    id uuid PRIMARY KEY,
    pattern_key text NOT NULL UNIQUE,
    aggregate_insight jsonb NOT NULL,
    contributing_game_count integer NOT NULL DEFAULT 0 CHECK (contributing_game_count >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  -- This table deliberately contains no player ID, world ID, prose, prompts,
  -- character names, or other canonical material. The fingerprint is a salted
  -- one-way campaign identifier used only to count distinct opted-in games.
  CREATE TABLE IF NOT EXISTS storyhold.pattern_contributions (
    pattern_key text NOT NULL,
    campaign_fingerprint text NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('success', 'mixed', 'failure', 'uncertain', 'none')),
    observation_count integer NOT NULL DEFAULT 1 CHECK (observation_count > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (pattern_key, campaign_fingerprint)
  );

  CREATE OR REPLACE FUNCTION storyhold.reject_locked_start_change()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF OLD.start_locked_at IS NOT NULL AND (
      NEW.world_id IS DISTINCT FROM OLD.world_id OR
      NEW.canon_edition_id IS DISTINCT FROM OLD.canon_edition_id OR
      NEW.ruleset_id IS DISTINCT FROM OLD.ruleset_id OR
      NEW.owner_player_id IS DISTINCT FROM OLD.owner_player_id OR
      NEW.perspective_character_id IS DISTINCT FROM OLD.perspective_character_id OR
      NEW.resolution_mode IS DISTINCT FROM OLD.resolution_mode OR
      NEW.start_contract IS DISTINCT FROM OLD.start_contract OR
      NEW.start_locked_at IS DISTINCT FROM OLD.start_locked_at
    ) THEN
      RAISE EXCEPTION 'A locked campaign start cannot be changed';
    END IF;
    RETURN NEW;
  END;
  $$;

  DROP TRIGGER IF EXISTS campaigns_lock_start_contract ON storyhold.campaigns;
  CREATE TRIGGER campaigns_lock_start_contract
    BEFORE UPDATE ON storyhold.campaigns
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_locked_start_change();

  CREATE OR REPLACE FUNCTION storyhold.reject_locked_character_origin_change()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF OLD.profile_locked_at IS NOT NULL AND (
      NEW.initial_profile IS DISTINCT FROM OLD.initial_profile OR
      NEW.profile_locked_at IS DISTINCT FROM OLD.profile_locked_at
    ) THEN
      RAISE EXCEPTION 'A locked character origin cannot be changed';
    END IF;
    RETURN NEW;
  END;
  $$;

  DROP TRIGGER IF EXISTS characters_lock_initial_profile ON storyhold.characters;
  CREATE TRIGGER characters_lock_initial_profile
    BEFORE UPDATE ON storyhold.characters
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_locked_character_origin_change();

  CREATE OR REPLACE FUNCTION storyhold.reject_event_mutation()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'Canonical world-state events are append-only';
  END;
  $$;

  DROP TRIGGER IF EXISTS world_state_events_append_only ON storyhold.world_state_events;
  CREATE TRIGGER world_state_events_append_only
    BEFORE UPDATE OR DELETE ON storyhold.world_state_events
    FOR EACH ROW EXECUTE FUNCTION storyhold.reject_event_mutation();
`;

  if (applyingDevelopmentSchema) {
    // A stale marker must never survive a partially failed schema application.
    await db.exec("DROP TABLE IF EXISTS storyhold.schema_release_1");
  }
  await db.exec(schemaSql);
  await markStartup("core schema ready; checking compatibility migrations");
  process.stdout.write("Core Storyhold schema ready. Checking world memory...\n");
  await db.exec(`
  ALTER TABLE storyhold.players ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '';
  ALTER TABLE storyhold.players ADD COLUMN IF NOT EXISTS credits integer NOT NULL DEFAULT 40 CHECK (credits >= 0);
`);
  await initializeWorldStudio(db);
  if (applyingDevelopmentSchema) {
    // Create this schema-only release sentinel last. Production startup checks
    // it so an interrupted development schema application cannot be published
    // as though the complete Storyhold schema were present.
    await db.exec(`
      CREATE TABLE storyhold.schema_release_1 (
        release integer PRIMARY KEY DEFAULT 1 CHECK (release = 1)
      )
    `);
  }
  await markStartup("world memory ready; completing local account setup");
  process.stdout.write("World memory and campaign play ready.\n");
  } else {
    // Published applications are read/write consumers of an already-published
    // schema. Schema changes belong to Replit's development/post-merge and
    // Publish flows, never to an application startup.
    await waitForPublishedSchema(db);
    await markStartup("managed PostgreSQL schema verified");
    process.stdout.write("Managed PostgreSQL schema verified.\n");
  }
  if (applyingDevelopmentSchema) {
    await db.close();
    process.stdout.write("Storyhold development managed PostgreSQL schema applied.\n");
    process.exit(0);
  }
await db.query("DELETE FROM storyhold.sessions WHERE expires_at <= now()");

const configuredOwnerEmail =
  process.env.STORYHOLD_LOCAL_ADMIN_EMAIL?.trim().toLowerCase();
const localEmail = (configuredOwnerEmail || "admin@storyhold.local")
  .trim()
  .toLowerCase();
const configuredOwnerPassword =
  process.env.STORYHOLD_LOCAL_ADMIN_PASSWORD?.trim();
if (
  isPublishedDeployment &&
  (!configuredOwnerPassword || configuredOwnerPassword === "storyhold-dev")
) {
  throw new Error(
    "Set STORYHOLD_LOCAL_ADMIN_PASSWORD to a private value in Replit deployment secrets.",
  );
}
const localPassword = configuredOwnerPassword || "storyhold-dev";
let existingPlayer = await db.query<{ id: string }>(
  "SELECT id FROM storyhold.players WHERE email = $1 LIMIT 1",
  [localEmail],
);
if (existingPlayer.rows.length === 0) {
  const existingOwners = await db.query<{ id: string }>(
    "SELECT id FROM storyhold.players WHERE role = 'owner' ORDER BY created_at ASC",
  );
  if (
    configuredOwnerEmail &&
    configuredOwnerPassword &&
    existingOwners.rows.length === 1
  ) {
    await db.query(
      "UPDATE storyhold.players SET email = $1, password_hash = $2 WHERE id = $3",
      [localEmail, await hash(localPassword, 12), existingOwners.rows[0].id],
    );
  } else {
    await db.query(
      `INSERT INTO storyhold.players (id, email, password_hash, display_name, credits, role)
       VALUES ($1, $2, $3, 'Storyhold Owner', 5000, 'owner')
       ON CONFLICT (email) DO NOTHING`,
      [randomUUID(), localEmail, await hash(localPassword, 12)],
    );
  }
  existingPlayer = await db.query<{ id: string }>(
    "SELECT id FROM storyhold.players WHERE email = $1 LIMIT 1",
    [localEmail],
  );
} else if (configuredOwnerPassword) {
  await db.query(
    "UPDATE storyhold.players SET password_hash = $1 WHERE id = $2",
    [await hash(localPassword, 12), existingPlayer.rows[0].id],
  );
}
await db.query(
  "UPDATE storyhold.players SET display_name = CASE WHEN display_name = '' THEN 'Storyhold Owner' ELSE display_name END, credits = GREATEST(credits, 5000) WHERE email = $1 AND role IN ('owner', 'admin')",
  [localEmail],
);

type LocalUser = {
  id: string;
  email: string;
  role: string;
  displayName: string;
  credits: number;
};
type AuthedRequest = Request & { localUser?: LocalUser };

function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function readSessionToken(req: Request): string | null {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[
    cookieName
  ];
  return typeof value === "string" && value.length <= 256 ? value : null;
}

async function resolveUser(req: Request): Promise<LocalUser | null> {
  const token = readSessionToken(req);
  if (!token) return null;
  const result = await db.query<LocalUser>(
    `SELECT p.id, p.email, p.role, p.display_name AS "displayName", p.credits
       FROM storyhold.sessions s
       JOIN storyhold.players p ON p.id = s.player_id
      WHERE s.token_hash = $1 AND s.expires_at > now()
      LIMIT 1`,
    [digestToken(token)],
  );
  return result.rows[0] ?? null;
}

async function requireUser(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) {
  const user = await resolveUser(req);
  if (!user) {
    res.status(401).json({ error: "Sign-in required." });
    return;
  }
  req.localUser = user;
  next();
}

const attempts = new Map<string, { count: number; resetAt: number }>();
function loginAllowed(email: string): boolean {
  const now = Date.now();
  const current = attempts.get(email);
  if (!current || current.resetAt <= now) {
    attempts.set(email, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  current.count += 1;
  return current.count <= 8;
}

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

type PlayerCredentialRow = LocalUser & { password_hash: string };

async function issueSession(res: Response, player: LocalUser) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionLifetimeMs);
  await db.query(
    "INSERT INTO storyhold.sessions (token_hash, player_id, expires_at) VALUES ($1, $2, $3)",
    [digestToken(token), player.id, expiresAt.toISOString()],
  );
  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isPublishedDeployment,
    maxAge: sessionLifetimeMs,
    path: "/",
  });
}

function publicUser(user: LocalUser) {
  return {
    email: user.email,
    userId: user.id,
    role: user.role,
    displayName: user.displayName,
    credits: user.credits,
  };
}

async function loginHandler(req: Request, res: Response) {
  const email =
    typeof req.body?.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "";
  const password =
    typeof req.body?.password === "string" ? req.body.password : "";
  if (!email || !password || email.length > 320 || password.length > 1024) {
    res.status(400).json({ error: "Enter a valid email and password." });
    return;
  }
  if (!loginAllowed(email)) {
    res
      .status(429)
      .json({ error: "Too many attempts. Wait one minute and try again." });
    return;
  }

  const result = await db.query<PlayerCredentialRow>(
    `SELECT id, email, role, password_hash, display_name AS "displayName", credits
       FROM storyhold.players WHERE email = $1 LIMIT 1`,
    [email],
  );
  const player = result.rows[0];
  if (!player || !(await compare(password, player.password_hash))) {
    res.status(401).json({ error: "Email or password is incorrect." });
    return;
  }

  attempts.delete(email);
  await issueSession(res, player);
  res.json(publicUser(player));
}

async function meHandler(req: Request, res: Response) {
  const user = await resolveUser(req);
  if (!user) {
    res.status(401).json({ error: "No active session." });
    return;
  }
  res.json(publicUser(user));
}

async function logoutHandler(req: Request, res: Response) {
  const token = readSessionToken(req);
  if (token) {
    await db.query("DELETE FROM storyhold.sessions WHERE token_hash = $1", [
      digestToken(token),
    ]);
  }
  res.clearCookie(cookieName, {
    httpOnly: true,
    sameSite: "lax",
    secure: isPublishedDeployment,
    path: "/",
  });
  res.status(204).end();
}

app.post("/api/admin/login", loginHandler);
app.get("/api/admin/me", meHandler);
app.post("/api/admin/logout", logoutHandler);
app.post("/api/storyhold/auth/login", loginHandler);
app.get("/api/storyhold/auth/me", meHandler);
app.post("/api/storyhold/auth/logout", logoutHandler);

app.post("/api/storyhold/auth/register", async (req, res) => {
  const email =
    typeof req.body?.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "";
  const password =
    typeof req.body?.password === "string" ? req.body.password : "";
  const requestedName =
    typeof req.body?.displayName === "string"
      ? req.body.displayName.replace(/\s+/g, " ").trim().slice(0, 80)
      : "";
  const acceptedTerms = req.body?.acceptedTerms === true;
  const termsVersion =
    typeof req.body?.termsVersion === "string"
      ? req.body.termsVersion.trim().slice(0, 40)
      : "";
  if (
    !email ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    res.status(400).json({ error: "Enter a valid email address." });
    return;
  }
  if (password.length < 8 || password.length > 128) {
    res.status(400).json({ error: "Use a password between 8 and 128 characters." });
    return;
  }
  if (!acceptedTerms || termsVersion !== "2026-08-23") {
    res.status(400).json({ error: "Accept the current Terms of Use and Privacy notice to create an account." });
    return;
  }
  if (!loginAllowed(email)) {
    res
      .status(429)
      .json({ error: "Too many attempts. Wait one minute and try again." });
    return;
  }
  const existing = await db.query<{ id: string }>(
    "SELECT id FROM storyhold.players WHERE email = $1 LIMIT 1",
    [email],
  );
  if (existing.rows[0]) {
    res.status(409).json({ error: "An account already exists for that email." });
    return;
  }
  const player: LocalUser = {
    id: randomUUID(),
    email,
    role: "player",
    displayName: requestedName || email.split("@")[0]!.slice(0, 80),
    credits: 40,
  };
  await db.query(
    `INSERT INTO storyhold.players
      (id, email, password_hash, display_name, credits, role, terms_accepted_at, terms_version)
     VALUES ($1, $2, $3, $4, $5, 'player', now(), $6)`,
    [
      player.id,
      player.email,
      await hash(password, 12),
      player.displayName,
      player.credits,
      termsVersion,
    ],
  );
  attempts.delete(email);
  await issueSession(res, player);
  res.status(201).json(publicUser(player));
});

const demoTurnLimit = 4;
const demoContextLimit = 5_000;
const demoSessionLifetimeMs = 60 * 60 * 1000;
type DemoSession = {
  id: string;
  premise: string;
  turns: number;
  context: DemoSceneTurn[];
  expiresAt: number;
};
const demoSessions = new Map<string, DemoSession>();

app.get("/api/storyhold/demo/status", (_req, res) => {
  const runtime = getAiRuntimeStatus("demo_scene");
  res.json({
    available: runtime.configured,
    label: runtime.configured ? "Live storyteller ready" : "Live storyteller offline",
    message: runtime.configured
      ? "The Storyhold storyteller is ready for a free scene."
      : "No AI storyteller is connected to this local build yet.",
  });
});

function cleanPublicText(value: unknown, limit: number): string {
  return typeof value === "string"
    ? value.replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, limit)
    : "";
}

function trimDemoContext(context: DemoSceneTurn[]): DemoSceneTurn[] {
  const kept = context.slice(-8);
  while (
    kept.length > 2 &&
    kept.reduce((total, turn) => total + turn.content.length, 0) >
      demoContextLimit
  ) {
    kept.shift();
  }
  return kept;
}

app.post("/api/storyhold/demo/chat", async (req, res) => {
  if (!getAiRuntimeStatus("demo_scene").configured) {
    res.status(503).json({
      error:
        "The live storyteller is not connected in this build yet. Storyhold will not substitute a canned response.",
    });
    return;
  }
  const now = Date.now();
  for (const [id, session] of demoSessions) {
    if (session.expiresAt <= now) demoSessions.delete(id);
  }
  const requestedSessionId = cleanPublicText(req.body?.sessionId, 80);
  const message = cleanPublicText(req.body?.message, 700);
  const suppliedPremise = cleanPublicText(req.body?.premise, 1_200);
  if (message.length < 2) {
    res.status(400).json({ error: "Give Storyhold an action or a line of dialogue." });
    return;
  }
  let session = requestedSessionId
    ? demoSessions.get(requestedSessionId)
    : undefined;
  if (!session) {
    session = {
      id: randomUUID(),
      premise:
        suppliedPremise ||
        "I step into an unfamiliar world and discover that someone has been waiting for me.",
      turns: 0,
      context: [],
      expiresAt: now + demoSessionLifetimeMs,
    };
    demoSessions.set(session.id, session);
  }
  if (session.turns >= demoTurnLimit) {
    res.status(402).json({
      error: "The free scene is complete. Create an account to preserve it and continue with credits.",
      sessionId: session.id,
      remainingTurns: 0,
      limitReached: true,
    });
    return;
  }
  const turnNumber = session.turns + 1;
  const result = await continueDemoScene({
    premise: session.premise,
    playerMessage: message,
    context: session.context,
    turnNumber,
  });
  if (!result.runtime.configured) {
    res.status(503).json({
      error:
        "The live storyteller became unavailable. Your turn was not counted; please try again later.",
    });
    return;
  }
  session.context.push(
    { role: "player", content: message },
    { role: "storyhold", content: result.response },
  );
  session.context = trimDemoContext(session.context);
  session.turns = turnNumber;
  session.expiresAt = now + demoSessionLifetimeMs;
  const remainingTurns = Math.max(0, demoTurnLimit - turnNumber);
  res.json({
    sessionId: session.id,
    reply: result.response,
    turnNumber,
    remainingTurns,
    limitReached: remainingTurns === 0,
    contextUsed: session.context.reduce(
      (total, turn) => total + turn.content.length,
      0,
    ),
    contextLimit: demoContextLimit,
    runtime: result.runtime,
  });
});

app.get(
  "/api/storyhold/status",
  requireUser,
  async (req: AuthedRequest, res) => {
    const counts = await db.query<{
      players: number;
      worlds: number;
      campaigns: number;
      memories: number;
      sources: number;
      character_drafts: number;
      pending_ai_reviews: number;
      cohesion_proposals: number;
      discrepancy_reports: number;
      canon_amendments: number;
      integrity_signals: number;
    }>(`
    SELECT
      (SELECT count(*)::int FROM storyhold.players) AS players,
      (SELECT count(*)::int FROM storyhold.worlds) AS worlds,
      (SELECT count(*)::int FROM storyhold.campaigns) AS campaigns,
      (SELECT count(*)::int FROM storyhold.vault_memory_chunks) AS memories,
      (SELECT count(*)::int FROM storyhold.world_sources) AS sources,
      (SELECT count(*)::int FROM storyhold.character_drafts WHERE review_status = 'draft') AS character_drafts,
      (SELECT count(*)::int FROM storyhold.world_sources WHERE ai_review_status IN ('waiting', 'queued', 'running')) AS pending_ai_reviews,
      (SELECT count(*)::int FROM storyhold.cohesion_proposals WHERE review_status = 'pending') AS cohesion_proposals,
      (SELECT count(*)::int FROM storyhold.canon_discrepancy_reports) AS discrepancy_reports,
      (SELECT count(*)::int FROM storyhold.canon_amendments) AS canon_amendments,
      (SELECT count(*)::int FROM storyhold.canon_integrity_signals) AS integrity_signals
  `);
    const vectorVersion = await db.query<{ extversion: string }>(
      "SELECT extversion FROM pg_extension WHERE extname = 'vector' LIMIT 1",
    );
    res.json({
      status: "ready",
      project: "Storyhold",
      schemaVersion: 6,
      user: req.localUser,
      database: {
        engine: usingManagedPostgres ? "Managed PostgreSQL" : "PostgreSQL-compatible PGlite",
        persistent: true,
        vectorSearch: vectorVersion.rows[0]?.extversion ?? "unavailable",
        location: usingManagedPostgres ? "managed PostgreSQL" : ".storyhold-data/postgres",
      },
      canonicalModel: {
        singleSharedVault: true,
        scopedBy: [
          "playerId",
          "worldId",
          "canonEditionId",
          "sourceId",
          "campaignId",
          "characterId",
          "stateVersion",
        ],
        immutableStarts: true,
        appendOnlyStateEvents: true,
        aggregatePatternsSeparated: true,
      },
      counts: counts.rows[0] ?? {
        players: 0,
        worlds: 0,
        campaigns: 0,
        memories: 0,
        sources: 0,
        character_drafts: 0,
        pending_ai_reviews: 0,
        cohesion_proposals: 0,
        discrepancy_reports: 0,
        canon_amendments: 0,
        integrity_signals: 0,
      },
    });
  },
);

registerWorldStudioRoutes({
  app,
  db,
  requireUser,
  sourceVaultStorage: createStoryholdSourceVaultStorage(storageRoot),
});

// The embedded local vault must be allowed to flush, and managed PostgreSQL
// must release its pool, before this Node process exits. This loopback-only
// endpoint lets the desktop stop script ask for an orderly shutdown.
if (!isPublishedDeployment) {
  app.post("/api/storyhold/local/shutdown", (_req, res) => {
    res.status(202).json({ status: "stopping" });
    res.on("finish", () => setImmediate(() => void shutdown()));
  });
}

app.use("/api", (_req, res) => {
  res.status(404).json({
    error: "That Storyhold API route does not exist.",
  });
});

app.use(express.static(publicDir, { index: false }));
app.get(/.*/, async (_req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(await loadStoryholdIndexHtml());
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[storyhold] ${message}\n`);
  if (!res.headersSent) {
    const typed = error as { type?: string };
    if (typed?.type === "entity.too.large") {
      res
        .status(413)
        .json({
          error: "That upload is larger than Storyhold's 100 MB local limit.",
        });
    } else {
      res.status(500).json({ error: "Storyhold server error." });
    }
  }
});

startupState = "ready";
void markStartup("ready");
process.stdout.write(
  `Storyhold server ready at http://${host}:${port}\n`,
);
process.stdout.write(
  usingManagedPostgres ? "Database: Managed PostgreSQL\n" : `Database: ${dataDir}\n`,
);
if (isPublishedDeployment) {
  process.stdout.write("Owner sign-in configured through deployment secrets.\n");
} else {
  // Local logs may be shared for troubleshooting; never place the generated
  // administrator password in a process log.
  process.stdout.write(`Local administrator account ready: ${localEmail}\n`);
}

let shutdownStarted = false;

async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  server.close(async () => {
    await startupDb?.close();
    await vaultOwnership?.release();
    process.exit(0);
  });
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
} catch (startupError) {
  process.stderr.write(
    `[storyhold] Startup failed: ${startupErrorMessage(startupError)}\n`,
  );
  await markStartup("startup failed; closing database").catch(() => undefined);
  try {
    server.close();
    await startupDb?.close();
    await vaultOwnership?.release();
    await markStartup("startup failed; database closed").catch(() => undefined);
  } catch (closeError) {
    process.stderr.write(`[storyhold] Startup cleanup failed: ${closeError instanceof Error ? closeError.message : String(closeError)}\n`);
  }
  throw startupError;
}
