import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  // `user_sessions` and `app_migrations` are runtime-only tables created and
  // maintained by idempotent raw DDL in the API server's startup seed
  // (`ensureRuntimeTables`), deliberately NOT part of the Drizzle schema. Without
  // this filter, `drizzle-kit push` sees them as untracked tables and, when a new
  // managed table is added, asks an interactive "is this a rename of
  // user_sessions/app_migrations?" prompt — which has no TTY during deploy and
  // surfaces as a schema conflict that blocks publishing. Excluding them makes the
  // diff unambiguous and non-interactive while leaving the tables untouched.
  tablesFilter: [
    "!user_sessions",
    "!app_migrations",
    "!background_jobs",
    "!cron_job_runs",
  ],
});
