import { db, beatsTable } from "@workspace/db";
import { asc, sql } from "drizzle-orm";

export interface ReorderedBeat {
  id: string;
  sortOrder: number;
}

// Reorder beats by accepting a fully-specified list of beat ids in the desired
// display order. Any beats not present in `requestedIds` are pushed to the end
// in their existing relative order so a partial payload can never silently drop
// or duplicate rows. The whole rewrite runs in a single transaction.
export async function reorderBeats(requestedIds: string[]): Promise<ReorderedBeat[]> {
  await db.transaction(async (tx) => {
    // Lock every beat row up-front in a deterministic (id-sorted) order so
    // two concurrent reorder requests always acquire locks in the same
    // sequence — preventing deadlocks and lost-update races.
    const all = await tx.execute<{ id: string }>(sql`SELECT id FROM beats ORDER BY id FOR UPDATE`);
    const allIds = (all.rows ?? []).map((r) => r.id);
    const known = new Set(allIds);
    // Build the final order: caller's requested ids first (deduped, validated),
    // then any remaining beats in their existing display order so a partial
    // payload never drops or duplicates rows.
    const existingOrder = await tx
      .select({ id: beatsTable.id })
      .from(beatsTable)
      .orderBy(asc(beatsTable.sortOrder), asc(beatsTable.name));
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const id of requestedIds) {
      if (known.has(id) && !seen.has(id)) {
        ordered.push(id);
        seen.add(id);
      }
    }
    for (const row of existingOrder) if (!seen.has(row.id)) ordered.push(row.id);
    // Single CASE-based UPDATE so the rewrite is one SQL statement.
    if (ordered.length > 0) {
      // Cast the THEN value to int. Without the cast, node-postgres sends the
      // numeric index as an untyped parameter that PostgreSQL resolves as text,
      // so the whole CASE expression becomes text and the assignment to the
      // integer `sort_order` column fails with: "column \"sort_order\" is of
      // type integer but expression is of type text".
      const cases = sql.join(
        ordered.map((id, i) => sql`WHEN ${id}::uuid THEN ${i}::int`),
        sql.raw(" "),
      );
      await tx.execute(sql`
        UPDATE beats
        SET sort_order = CASE id ${cases} END,
            updated_at = NOW()
        WHERE id IN (${sql.join(ordered.map((id) => sql`${id}::uuid`), sql.raw(", "))})
      `);
    }
  });
  const rows = await db
    .select()
    .from(beatsTable)
    .orderBy(asc(beatsTable.sortOrder), asc(beatsTable.name));
  return rows.map((b) => ({ id: b.id, sortOrder: b.sortOrder }));
}
