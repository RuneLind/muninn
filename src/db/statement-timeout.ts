import type { Sql } from "postgres";
import { getDb } from "./client.ts";

const PG_MAX_STATEMENT_TIMEOUT_MS = 2_147_483_647;

export interface StatementTimeoutOption {
  /** Bound each statement in Postgres (lock waits included). Unset ⇒ no bound.
   *  Below 1 ms (0, negative, NaN, Infinity) throws: Postgres reads 0 as "no
   *  timeout", so a computed 0 would silently remove the bound it asked for.
   *  Above 2147483647 (Postgres's maximum) throws too, before the transaction. */
  statementTimeoutMs?: number;
}

/** Run `fn` on the pool, or — with a timeout — in a transaction whose
 *  `statement_timeout` (and connection check) is set LOCAL, so neither outlives
 *  that transaction on the pooled connection. A timed-out statement throws and its backend is
 *  freed, which a JS-side race cannot do. */
export async function withStatementTimeout<T>(opts: StatementTimeoutOption, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = getDb() as unknown as Sql;
  if (opts.statementTimeoutMs == null) return fn(sql);
  const floored = Math.floor(opts.statementTimeoutMs);
  if (!Number.isFinite(floored) || floored < 1 || floored > PG_MAX_STATEMENT_TIMEOUT_MS) {
    throw new RangeError(
      `withStatementTimeout: statementTimeoutMs must be 1 to ${PG_MAX_STATEMENT_TIMEOUT_MS}, got ${opts.statementTimeoutMs}`,
    );
  }
  const ms = String(floored);
  return (await sql.begin(async (_tx) => {
    const tx = _tx as unknown as Sql;
    // `client_connection_check_interval` (Postgres 14+, skipped below that): a
    // backend whose client was terminated mid-statement (`closeDb` with a
    // timeout) notices within 1 s and rolls back, instead of waiting out the lock.
    await tx`
      SELECT set_config('statement_timeout', ${ms}, true),
             CASE WHEN current_setting('server_version_num')::int >= 140000
                  THEN set_config('client_connection_check_interval', '1000', true) END`;
    return fn(tx);
  })) as T;
}
