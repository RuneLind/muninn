/**
 * Holds a connector row inserted and not committed on a connection of its
 * own, so a seed racing it waits on the unique index the way a second boot
 * does. Used by the seed race tests in `src/db/`.
 */
import { openPostgres } from "../../db/postgres-connection.ts";
import { TEST_DATABASE_URL } from "./test-db-url.ts";

export async function holdUncommittedConnector(connectorType: string, model: string | null, baseUrl: string | null) {
  const { sql } = openPostgres(TEST_DATABASE_URL, { max: 2, onnotice: () => {} });
  const conn = await sql.reserve();
  await conn`BEGIN`;
  await conn`INSERT INTO connectors (name, description, connector_type, model, base_url)
             VALUES ('held', 'race', ${connectorType}, ${model}, ${baseUrl})`;
  const [{ pid }] = (await conn`SELECT pg_backend_pid() AS pid`) as unknown as [{ pid: number }];
  return {
    /** Wait until `n` other sessions are blocked behind this transaction. */
    async waitForBlocked(n: number, timeoutMs = 10_000): Promise<void> {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const [{ count }] = (await sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`) as unknown as [{ count: number }];
        if (count >= n) return;
        if (Date.now() > until) throw new Error(`only ${count} of ${n} sessions blocked behind the held insert`);
        await Bun.sleep(20);
      }
    },
    async commit(): Promise<void> {
      await conn`COMMIT`;
    },
    async end(): Promise<void> {
      conn.release();
      await sql.end();
    },
  };
}
