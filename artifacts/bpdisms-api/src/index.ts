import { sql } from "drizzle-orm";
import { db, bpdismsAppSettingsTable, bpdismsPostingSlotsTable } from "@workspace/db";
import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

/**
 * Idempotent boot DDL, mirroring the repo convention (ensureRuntimeTables in
 * the main api-server): keeps fresh/reset dev databases in sync with the
 * schema in lib/db/src/schema/bpdisms.ts (the source of truth) without a
 * manual `push`. All statements are IF NOT EXISTS and safe to re-run.
 */
async function ensureBpdismsTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS bpdisms_app_settings (
      id serial PRIMARY KEY,
      timezone text NOT NULL DEFAULT 'America/Phoenix',
      destination_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS bpdisms_posting_slots (
      id serial PRIMARY KEY,
      time_of_day text NOT NULL,
      days_of_week_json text NOT NULL DEFAULT '["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]',
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS bpdisms_social_posts (
      id serial PRIMARY KEY,
      image_url text NOT NULL,
      image_storage_key text NOT NULL,
      original_filename text NOT NULL,
      caption text NOT NULL DEFAULT '',
      scheduled_at timestamptz NOT NULL,
      timezone text NOT NULL DEFAULT 'America/Phoenix',
      status text NOT NULL DEFAULT 'draft',
      provider text NOT NULL DEFAULT 'zernio',
      provider_post_id text,
      provider_response_json text,
      error_message text,
      retry_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      posted_at timestamptz
    )
  `);
}

/**
 * Seed-if-empty: only runs when the tables have zero rows, so it can never
 * overwrite user edits (see seed-existing-row-updates convention). Values
 * mirror the original BPD-isms deployment: Phoenix timezone, the existing
 * Facebook destination, and three daily posting slots.
 */
async function seedBpdismsDefaults(): Promise<void> {
  const [settings] = await db.select().from(bpdismsAppSettingsTable).limit(1);
  if (!settings) {
    // Read the destination ID from the environment so a dev/restored instance
    // never seeds the live Facebook destination by accident. On a fresh
    // production deployment set BPDISMS_DESTINATION_ID to the real Page ID;
    // a dev instance without the var starts with null and requires manual config
    // in Settings before any post can be scheduled.
    const destinationId = process.env.BPDISMS_DESTINATION_ID ?? null;
    await db.insert(bpdismsAppSettingsTable).values({
      timezone: "America/Phoenix",
      destinationId,
    });
    logger.info({ destinationId: destinationId ?? "(none)" }, "Seeded bpdisms_app_settings defaults");
  }

  const [slot] = await db.select().from(bpdismsPostingSlotsTable).limit(1);
  if (!slot) {
    await db.insert(bpdismsPostingSlotsTable).values([
      { timeOfDay: "09:00" },
      { timeOfDay: "14:00" },
      { timeOfDay: "18:00" },
    ]);
    logger.info("Seeded bpdisms_posting_slots defaults");
  }
}

async function main(): Promise<void> {
  await ensureBpdismsTables();
  await seedBpdismsDefaults();

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal error during startup");
  process.exit(1);
});
