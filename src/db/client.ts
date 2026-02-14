import postgres from "postgres";
import type { Config } from "../config.ts";

let sql: postgres.Sql | null = null;

export function initDb(config: Config, urlOverride?: string): postgres.Sql {
  sql = postgres(urlOverride ?? config.databaseUrl, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return sql;
}

/**
 * Ensure the simulator database exists and has the schema applied.
 * Connects to the main DB to create the database, then applies init.sql if needed.
 */
export async function ensureSimulatorDb(mainUrl: string, simulatorUrl: string): Promise<void> {
  const dbName = new URL(simulatorUrl).pathname.split("/").filter(Boolean).pop() ?? "javrvis_simulator";

  // Connect to main DB to create the simulator DB if it doesn't exist
  const mainSql = postgres(mainUrl, { max: 1, connect_timeout: 10 });
  try {
    const exists = await mainSql`
      SELECT 1 FROM pg_database WHERE datname = ${dbName}
    `;
    if (exists.length === 0) {
      // CREATE DATABASE can't be parameterized — use unsafe with validated name
      if (!/^[a-zA-Z0-9_]+$/.test(dbName)) throw new Error(`Invalid DB name: ${dbName}`);
      await mainSql.unsafe(`CREATE DATABASE ${dbName}`);
      console.log(`[simulator] Created database ${dbName}`);
    }
  } finally {
    await mainSql.end();
  }

  // Connect to simulator DB and apply schema if tables are missing
  const simSql = postgres(simulatorUrl, { max: 1, connect_timeout: 10 });
  try {
    const tables = await simSql`
      SELECT 1 FROM information_schema.tables WHERE table_name = 'messages' AND table_schema = 'public'
    `;
    if (tables.length === 0) {
      const initSqlPath = new URL("../../db/init.sql", import.meta.url).pathname;
      const initContent = await Bun.file(initSqlPath).text();
      await simSql.unsafe(initContent);
      console.log(`[simulator] Applied schema to ${dbName}`);
    }
  } finally {
    await simSql.end();
  }
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
