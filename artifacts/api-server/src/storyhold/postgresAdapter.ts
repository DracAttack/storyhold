import type { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";

/**
 * The small database surface used by Storyhold's persistence modules. PGlite
 * implements the same shape locally; this adapter gives managed PostgreSQL an
 * equivalent, deliberately limited surface.
 */
export type StoryholdDb = Pick<PGlite, "query" | "exec" | "close" | "transaction">;

type Queryable = Pick<PoolClient, "query">;

class PostgresTransaction {
  constructor(private readonly client: Queryable) {}

  query: PGlite["query"] = async (text, values) => {
    const result = await this.client.query(text, values);
    return { rows: result.rows, fields: [] };
  };

  exec: PGlite["exec"] = async (sql) => {
    await this.client.query(sql);
    return [];
  };

}

export class PostgresStoryholdAdapter implements StoryholdDb {
  constructor(private readonly pool: Pool) {}

  query: PGlite["query"] = async (text, values) => {
    const result = await this.pool.query(text, values);
    return { rows: result.rows, fields: [] };
  };

  exec: PGlite["exec"] = async (sql) => {
    await this.pool.query(sql);
    return [];
  };

  transaction: PGlite["transaction"] = async (callback) => {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(new PostgresTransaction(client) as never);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // Preserve the callback/commit failure: it is the useful failure to
        // callers, while still ensuring the checked-out client is released.
        console.error("Storyhold transaction rollback failed:", rollbackError);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}