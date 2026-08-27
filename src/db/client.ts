import type postgres from "postgres";
import type { Config } from "../config.ts";
import { openPostgres } from "../../db/postgres-connection.ts";
import { getLog } from "../logging.ts";

const log = getLog("db", "client");

let sql: postgres.Sql | null = null;

export function initDb(config: Config): postgres.Sql {
  if (sql) throw new Error("Database already initialized — call closeDb() first");
  // `openPostgres`, not `postgres()`: on nais the injected URL carries the
  // Cloud SQL TLS material as query parameters that postgres.js would forward
  // into the startup packet, aborting the connection. See
  // `db/postgres-connection.ts`.
  const opened = openPostgres(config.databaseUrl, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    max_lifetime: 60 * 30,
  });
  if (opened.notes.length > 0) {
    log.info("Database TLS: {notes}", { notes: opened.notes.join("; ") });
  }
  sql = opened.sql;
  return sql;
}

export function getDb(): postgres.Sql {
  if (!sql) {
    throw new Error("Database not initialized — call initDb() first");
  }
  return sql;
}

export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
  }
}
