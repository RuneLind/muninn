import postgres from "postgres";
import type { Config } from "../config.ts";

let sql: postgres.Sql | null = null;

export function initDb(config: Config): postgres.Sql {
  if (sql) throw new Error("Database already initialized — call closeDb() first");
  sql = postgres(config.databaseUrl, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    max_lifetime: 60 * 30,
  });
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
