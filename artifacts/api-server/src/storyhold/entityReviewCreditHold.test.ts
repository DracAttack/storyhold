import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { creditEconomySchemaSql, releaseCreditReservation, releaseExpiredCreditReservations, reserveCredits } from "./creditEconomy";

const playerId = "00000000-0000-4000-8000-000000000971";
async function database() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA storyhold;
    CREATE TABLE storyhold.players (id uuid PRIMARY KEY, role text NOT NULL, credits integer NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE storyhold.worlds (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.campaigns (id uuid PRIMARY KEY);
    CREATE TABLE storyhold.ai_usage_ledger (id uuid PRIMARY KEY);`);
  await db.exec(creditEconomySchemaSql);
  await db.query("INSERT INTO storyhold.players (id, role, credits) VALUES ($1, 'player', 100)", [playerId]);
  return db;
}

test("retained dossier journal holds survive generic errors, explicit-looking reasons, and expiry", async () => {
  const db = await database();
  try {
    const hold = await reserveCredits(db, { playerId, operation: "entity_review", requestId: "dossier-journal-1", requiredCredits: 20,
      metadata: { retainUntilReconciled: true, entityReviewJournalId: "dossier-journal-1" } });
    await db.query("UPDATE storyhold.credit_reservations SET expires_at = now() - interval '1 hour' WHERE id = $1", [hold.id]);
    const before = (await db.query("SELECT * FROM storyhold.credit_reservations WHERE id = $1", [hold.id])).rows;
    for (const reason of ["failed to save dossier", "expired before settlement", "provider reconciliation confirmed no charge", "user retry", ""]) {
      await releaseCreditReservation(db, hold.id, reason);
    }
    assert.equal(await releaseExpiredCreditReservations(db, playerId), 0);
    assert.deepEqual((await db.query("SELECT * FROM storyhold.credit_reservations WHERE id = $1", [hold.id])).rows, before);
    assert.equal((await db.query<{ credits: number }>("SELECT credits FROM storyhold.players WHERE id = $1", [playerId])).rows[0]!.credits, 80);
    assert.equal((await db.query("SELECT id FROM storyhold.credit_ledger WHERE entry_kind = 'release'")).rows.length, 0);
  } finally { await db.close(); }
});

test("ordinary unused dossier holds remain refundable and world-review release behavior is unchanged", async () => {
  const db = await database();
  try {
    const ordinary = await reserveCredits(db, { playerId, operation: "entity_review", requestId: "unused-dossier", requiredCredits: 10 });
    await releaseCreditReservation(db, ordinary.id, "stopped before dispatch");
    assert.equal((await db.query<{ status: string }>("SELECT status FROM storyhold.credit_reservations WHERE id = $1", [ordinary.id])).rows[0]!.status, "released");
    const world = await reserveCredits(db, { playerId, operation: "world_analysis", requestId: "world-review", requiredCredits: 10,
      metadata: { retainUntilReconciled: true } });
    await releaseCreditReservation(db, world.id, "expired before settlement");
    assert.equal((await db.query<{ status: string }>("SELECT status FROM storyhold.credit_reservations WHERE id = $1", [world.id])).rows[0]!.status, "reserved");
    await releaseCreditReservation(db, world.id, "provider reconciliation confirmed no charge");
    assert.equal((await db.query<{ status: string }>("SELECT status FROM storyhold.credit_reservations WHERE id = $1", [world.id])).rows[0]!.status, "released");
    assert.equal((await db.query<{ credits: number }>("SELECT credits FROM storyhold.players WHERE id = $1", [playerId])).rows[0]!.credits, 100);
  } finally { await db.close(); }
});
