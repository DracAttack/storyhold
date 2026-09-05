import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// An idle pooled connection can be dropped by the database server (Neon closes
// idle connections aggressively). Without an "error" listener the pool re-emits
// that as an unhandled 'error' event, which terminates the whole Node process —
// this crash-looped production. Log it and keep serving; the pool discards the
// dead client and opens a fresh one on the next query.
pool.on("error", (err) => {
  console.error("[db] idle pool client error (recovered, pool will reconnect):", err);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
