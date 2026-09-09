import { randomUUID } from "node:crypto";
import type { StoryholdDb } from "./postgresAdapter";
import type { StoryholdSourceVaultStorage } from "./sourceVaultStorage";
import { createPrivateFileScanner, PRIVATE_FILE_MAX_BYTES, type PrivateFileScanner } from "./privateFileScanner";

type Db = Pick<StoryholdDb, "query" | "exec">;
type RootDb = Db & Pick<StoryholdDb, "transaction">;
type Job = { id: string; operation: "scan" | "cleanup"; object_key: string; item_id: string | null; attempts: number; lease_token: string };
const MAX_ATTEMPTS = 6;
const LEASE_SECONDS = 120;
export const privateFileSafetySchemaSql = String.raw`
  ALTER TABLE storyhold.character_workspace_items
    ADD COLUMN IF NOT EXISTS file_scan_state text NOT NULL DEFAULT 'pending'
      CHECK (file_scan_state IN ('pending','clean','quarantined'));
  ALTER TABLE storyhold.character_workspace_items
    ADD COLUMN IF NOT EXISTS file_scan_reason text;
  ALTER TABLE storyhold.character_workspace_items
    ADD COLUMN IF NOT EXISTS file_scanned_at timestamptz;
  ALTER TABLE storyhold.character_workspace_items
    ADD COLUMN IF NOT EXISTS file_scan_retry_pending boolean NOT NULL DEFAULT false;
  -- No cascading foreign keys: cleanup must survive removal of a world,
  -- dossier, account, or workspace item.
  CREATE TABLE IF NOT EXISTS storyhold.private_file_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    operation text NOT NULL CHECK (operation IN ('scan','cleanup')),
    object_key text NOT NULL,
    item_id uuid,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','failed')),
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    lease_until timestamptz,
    lease_token uuid,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(operation, object_key)
  );
  CREATE INDEX IF NOT EXISTS private_file_jobs_due
    ON storyhold.private_file_jobs(status, next_attempt_at);
  CREATE OR REPLACE FUNCTION storyhold.queue_workspace_private_file() RETURNS trigger AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      IF OLD.kind = 'file' THEN
        INSERT INTO storyhold.private_file_jobs(operation,object_key,item_id)
          VALUES ('cleanup', OLD.file_object_key, OLD.id)
          ON CONFLICT(operation,object_key) DO UPDATE SET
            status='pending', attempts=0, next_attempt_at=now(), lease_until=NULL, lease_token=NULL;
        -- Leave any scan job to notice the missing item and retire itself.
        -- Locking it here would invert scanner job/item lock order and could
        -- deadlock a user deletion against a completing scan.
      END IF;
      RETURN OLD;
    END IF;
    IF NEW.kind='file' AND NEW.file_scan_state='pending' THEN
      INSERT INTO storyhold.private_file_jobs(operation,object_key,item_id)
        VALUES ('scan',NEW.file_object_key,NEW.id) ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  DROP TRIGGER IF EXISTS workspace_private_file_queue ON storyhold.character_workspace_items;
  CREATE TRIGGER workspace_private_file_queue AFTER INSERT OR DELETE ON storyhold.character_workspace_items
    FOR EACH ROW EXECUTE FUNCTION storyhold.queue_workspace_private_file();
  -- Existing uploads were never scanned. They stay private/pending until a
  -- real verdict; upgrades do not grandfather them as safe.
  INSERT INTO storyhold.private_file_jobs(operation,object_key,item_id)
    SELECT 'scan',file_object_key,id FROM storyhold.character_workspace_items
      WHERE kind='file' AND file_scan_state='pending' ON CONFLICT DO NOTHING;
`;

export function workspaceFileScan(row: Record<string, unknown>) {
  return {
    state: row.file_scan_state === "clean" ? "clean" as const
      : row.file_scan_state === "quarantined" ? "quarantined" as const : "pending" as const,
    reason: row.file_scan_reason === "suspicious" ? "suspicious" as const
      : row.file_scan_reason === "scan_failed" ? "scan_failed" as const : null,
    checkedAt: row.file_scanned_at ? String(row.file_scanned_at) : null,
    retryPending: row.file_scan_state === "quarantined" && row.file_scan_reason === "scan_failed" && row.file_scan_retry_pending === true,
  };
}

export function privateFileRetrySeconds(attempt: number) {
  return Math.min(3600, 30 * 2 ** Math.max(0, Math.min(10, attempt - 1)));
}

// Persist an orphan guard BEFORE uploading. Committing the item cancels it in
// the same transaction. A crashed upload is reclaimed after its grace period.
export async function stagePrivateFileUpload(db: Db, objectKey: string, itemId: string) {
  await db.query(`INSERT INTO storyhold.private_file_jobs(operation,object_key,item_id,next_attempt_at)
    VALUES ('cleanup',$1,$2,now()+interval '1 hour')`, [objectKey, itemId]);
}

export async function commitPrivateFileUpload(db: Db, objectKey: string) {
  const result = await db.query(`DELETE FROM storyhold.private_file_jobs WHERE operation='cleanup'
    AND object_key=$1 AND status='pending' AND attempts=0 AND next_attempt_at>now() RETURNING id`, [objectKey]);
  if (!result.rows.length) throw new Error("The upload expired before it could be saved. Please try again.");
}

export async function abandonPrivateFileUpload(db: Db, objectKey: string) {
  // A very late upload may finish after its original guard was already cleaned.
  // Reinsert instead of silently losing that orphan. Invalidate an old cleanup
  // lease so a deletion begun before the late upload cannot erase its new job.
  await db.query(`INSERT INTO storyhold.private_file_jobs(operation,object_key) VALUES ('cleanup',$1)
    ON CONFLICT(operation,object_key) DO UPDATE SET next_attempt_at=now(),updated_at=now(),
      status='pending',attempts=0,lease_token=NULL,lease_until=NULL,error_code=NULL`, [objectKey]);
}

export async function privateFileJobReport(db: Db) {
  // Deliberately omit object keys, filenames, item/world/user identifiers and
  // raw scanner/storage error text, including from operator responses.
  const result = await db.query(`SELECT id,operation,status,attempts,error_code,
    created_at,updated_at,next_attempt_at FROM storyhold.private_file_jobs
    ORDER BY (status='failed') DESC, created_at LIMIT 200`);
  return { jobs: result.rows };
}

export function createPrivateFileWorker(db: RootDb, storage: StoryholdSourceVaultStorage,
  scanner: PrivateFileScanner = createPrivateFileScanner()) {
  let active: Promise<void> | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("private_file_timeout")), milliseconds);
      })]);
    } finally { if (timeout) clearTimeout(timeout); }
  }

  async function runOne(): Promise<boolean> {
    // Exhaustion covers repeated process crashes as well as handled errors.
    await db.query(`WITH exhausted AS (
      UPDATE storyhold.private_file_jobs SET status='failed',error_code='retry_exhausted',
        lease_token=NULL,lease_until=NULL,updated_at=now()
      WHERE status<>'failed' AND attempts >= $1 AND (lease_until IS NULL OR lease_until < now())
      RETURNING item_id,operation,object_key)
      UPDATE storyhold.character_workspace_items item SET file_scan_state='quarantined',
        file_scan_reason='scan_failed',file_scan_retry_pending=false,file_scanned_at=now(),updated_at=now()
      FROM exhausted WHERE exhausted.operation='scan' AND item.id=exhausted.item_id
        AND item.file_object_key=exhausted.object_key`, [MAX_ATTEMPTS]);
    const leaseToken = randomUUID();
    const claimed = await db.query<Job>(`WITH next_job AS (
      SELECT id FROM storyhold.private_file_jobs WHERE attempts < $1
        AND ((status='pending' AND next_attempt_at<=now()) OR (status='running' AND lease_until<now()))
      ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE storyhold.private_file_jobs job SET status='running',attempts=attempts+1,
        lease_token=$2, lease_until=now()+$3*interval '1 second', updated_at=now()
      FROM next_job WHERE job.id=next_job.id RETURNING job.*`, [MAX_ATTEMPTS, leaseToken, LEASE_SECONDS]);
    const job = claimed.rows[0];
    if (!job) return false;
    try {
      if (job.operation === "cleanup") {
        // A slow upload may have completed after its guard became eligible.
        const live = await db.query(`SELECT id FROM storyhold.character_workspace_items WHERE file_object_key=$1`, [job.object_key]);
        if (!live.rows.length) await bounded(storage.deleteSource(job.object_key), 30_000);
        await db.query(`DELETE FROM storyhold.private_file_jobs WHERE id=$1 AND lease_token=$2`, [job.id, leaseToken]);
      } else {
        const item = await db.query<{ file_size: number }>(`SELECT file_size FROM storyhold.character_workspace_items
          WHERE id=$1 AND file_object_key=$2 AND kind='file' AND file_scan_state<>'clean'`, [job.item_id, job.object_key]);
        if (!item.rows.length) {
          await db.query(`DELETE FROM storyhold.private_file_jobs WHERE id=$1 AND lease_token=$2`, [job.id, leaseToken]);
          return true;
        }
        const acquisition = storage.downloadSource(job.object_key);
        const stream = await bounded(acquisition, 10_000).catch((error) => {
          // An SDK may not support cancellation. Dispose of a stream that
          // arrives after this job's acquisition deadline instead of leaking it.
          void acquisition.then((lateStream) => lateStream.destroy(), () => undefined);
          throw error;
        });
        const chunks: Buffer[] = [];
        let size = 0;
        const readTimeout = setTimeout(() => stream.destroy(new Error("read_timeout")), 30_000);
        try {
          for await (const raw of stream) {
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            size += chunk.length;
            if (size > PRIVATE_FILE_MAX_BYTES) throw new Error("scan_size_invalid");
            chunks.push(chunk);
          }
        } finally { clearTimeout(readTimeout); stream.destroy(); }
        if (size !== Number(item.rows[0]!.file_size)) throw new Error("scan_size_invalid");
        const verdict = await bounded(scanner(Buffer.concat(chunks)), 35_000);
        if (verdict !== "clean" && verdict !== "suspicious") throw new Error("invalid_verdict");
        await db.transaction(async (tx) => {
          const own = await tx.query(`SELECT id FROM storyhold.private_file_jobs WHERE id=$1 AND lease_token=$2
            AND status='running' AND lease_until>now() FOR UPDATE`, [job.id, leaseToken]);
          if (!own.rows.length) return;
          await tx.query(`UPDATE storyhold.character_workspace_items SET file_scan_state=$3,
            file_scan_reason=$4,file_scan_retry_pending=false,file_scanned_at=now(),updated_at=now()
            WHERE id=$1 AND file_object_key=$2`, [job.item_id, job.object_key,
            verdict === "clean" ? "clean" : "quarantined", verdict === "clean" ? null : "suspicious"]);
          await tx.query(`DELETE FROM storyhold.private_file_jobs WHERE id=$1 AND lease_token=$2`, [job.id, leaseToken]);
        });
      }
    } catch {
      await db.transaction(async (tx) => {
        const failed = await tx.query(`UPDATE storyhold.private_file_jobs SET status=$3,
          error_code=$4,lease_until=NULL,lease_token=NULL,next_attempt_at=now()+$5*interval '1 second',updated_at=now()
          WHERE id=$1 AND lease_token=$2 RETURNING id`, [job.id, leaseToken,
          job.attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          job.operation === "scan" ? "scan_failed" : "storage_delete_failed", privateFileRetrySeconds(job.attempts)]);
        if (failed.rows.length && job.operation === "scan") {
          await tx.query(`UPDATE storyhold.character_workspace_items SET file_scan_state='quarantined',
            file_scan_reason='scan_failed',file_scan_retry_pending=$3,file_scanned_at=now(),updated_at=now()
            WHERE id=$1 AND file_object_key=$2`, [job.item_id, job.object_key, job.attempts < MAX_ATTEMPTS]);
        }
      });
    }
    return true;
  }
  function tick() {
    if (stopped) return Promise.resolve();
    if (active) return active;
    active = (async () => { for (let n = 0; n < 4 && !stopped; n++) { if (!(await runOne())) break; } })()
      .catch(() => { process.stderr.write("Storyhold private-file worker needs attention; jobs remain queued.\n"); })
      .finally(() => { active = null; });
    return active;
  }
  return {
    tick,
    start() { if (!timer) { timer = setInterval(() => void tick(), 5000); timer.unref(); void tick(); } },
    async stop() { stopped = true; if (timer) clearInterval(timer); await active; },
  };
}
