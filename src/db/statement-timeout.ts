import type { Sql } from "postgres";
import { getDb } from "./client.ts";

export interface StatementTimeoutOption {
  /** Bound each statement in Postgres (lock waits included). Unset ⇒ no bound. */
  statementTimeoutMs?: number;
}

/** Run `fn` on the pool, or — with a timeout — in a transaction whose
 *  `statement_timeout` is set LOCAL, so it never outlives that transaction on
 *  the pooled connection. A timed-out statement throws and its backend is
 *  freed, which a JS-side race cannot do. */
export async function withStatementTimeout<T>(opts: StatementTimeoutOption, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = getDb() as unknown as Sql;
  if (opts.statementTimeoutMs == null) return fn(sql);
  const ms = String(Math.max(1, Math.floor(opts.statementTimeoutMs)));
  return (await sql.begin(async (_tx) => {
    const tx = _tx as unknown as Sql;
    await tx`SELECT set_config('statement_timeout', ${ms}, true)`;
    return fn(tx);
  })) as T;
}
