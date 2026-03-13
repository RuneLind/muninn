import type postgres from "postgres";
import { getDb } from "./client.ts";
import type { BotConfig, ConnectorType } from "../bots/config.ts";
import { getLog } from "../logging.ts";

type Sql = postgres.Sql;

const log = getLog("db", "connectors");

export interface Connector {
  id: string;
  name: string;
  description?: string;
  connectorType: ConnectorType;
  model?: string;
  baseUrl?: string;
  thinkingMaxTokens?: number;
  timeoutMs?: number;
  createdAt: number;
  updatedAt: number;
}

function rowToConnector(r: Record<string, unknown>): Connector {
  return {
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string) ?? undefined,
    connectorType: r.connector_type as ConnectorType,
    model: (r.model as string) ?? undefined,
    baseUrl: (r.base_url as string) ?? undefined,
    thinkingMaxTokens: r.thinking_max_tokens != null ? Number(r.thinking_max_tokens) : undefined,
    timeoutMs: r.timeout_ms != null ? Number(r.timeout_ms) : undefined,
    createdAt: new Date(r.created_at as string).getTime(),
    updatedAt: new Date(r.updated_at as string).getTime(),
  };
}

export async function listConnectors(): Promise<Connector[]> {
  const sql = getDb();
  const rows = await sql`SELECT * FROM connectors ORDER BY name`;
  return rows.map(rowToConnector);
}

export async function getConnector(id: string): Promise<Connector | null> {
  const sql = getDb();
  const [row] = await sql`SELECT * FROM connectors WHERE id = ${id}`;
  return row ? rowToConnector(row) : null;
}

export async function createConnector(data: {
  name: string;
  description?: string;
  connectorType: ConnectorType;
  model?: string;
  baseUrl?: string;
  thinkingMaxTokens?: number;
  timeoutMs?: number;
}): Promise<Connector> {
  const sql = getDb();
  const [row] = await sql`
    INSERT INTO connectors (name, description, connector_type, model, base_url, thinking_max_tokens, timeout_ms)
    VALUES (
      ${data.name},
      ${data.description ?? null},
      ${data.connectorType},
      ${data.model ?? null},
      ${data.baseUrl ?? null},
      ${data.thinkingMaxTokens ?? null},
      ${data.timeoutMs ?? null}
    )
    RETURNING *
  `;
  return rowToConnector(row!);
}

export async function updateConnector(
  id: string,
  data: {
    name?: string;
    description?: string | null;
    connectorType?: ConnectorType;
    model?: string | null;
    baseUrl?: string | null;
    thinkingMaxTokens?: number | null;
    timeoutMs?: number | null;
  },
): Promise<Connector | null> {
  const sql = getDb();
  // Build update object — only include fields that are explicitly provided
  // undefined = not provided (keep existing), null = explicitly clear
  const updateObj: Record<string, unknown> = {};
  const cols: string[] = [];
  if (data.name !== undefined) { updateObj.name = data.name; cols.push("name"); }
  if (data.description !== undefined) { updateObj.description = data.description; cols.push("description"); }
  if (data.connectorType !== undefined) { updateObj.connector_type = data.connectorType; cols.push("connector_type"); }
  if (data.model !== undefined) { updateObj.model = data.model; cols.push("model"); }
  if (data.baseUrl !== undefined) { updateObj.base_url = data.baseUrl; cols.push("base_url"); }
  if (data.thinkingMaxTokens !== undefined) { updateObj.thinking_max_tokens = data.thinkingMaxTokens; cols.push("thinking_max_tokens"); }
  if (data.timeoutMs !== undefined) { updateObj.timeout_ms = data.timeoutMs; cols.push("timeout_ms"); }

  if (cols.length === 0) {
    const [row] = await sql`SELECT * FROM connectors WHERE id = ${id}`;
    return row ? rowToConnector(row) : null;
  }

  const [row] = await sql`
    UPDATE connectors SET ${sql(updateObj, ...cols)}
    WHERE id = ${id}
    RETURNING *
  `;
  return row ? rowToConnector(row) : null;
}

export async function deleteConnector(id: string): Promise<boolean> {
  const sql = getDb();
  try {
    const result = await sql`DELETE FROM connectors WHERE id = ${id}`;
    return result.count > 0;
  } catch (err: unknown) {
    // FK violation — threads reference this connector
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23503") {
      throw new Error("Cannot delete connector: it is referenced by one or more threads");
    }
    throw err;
  }
}

/** Seed connector entries from bot configs if table is empty.
 *  Also ensures a copilot-sdk entry always exists.
 *  Deduplicates by connector_type + model + base_url. */
export async function seedConnectorsFromBotConfigs(botConfigs: BotConfig[]): Promise<number> {
  const sql = getDb();

  return await sql.begin(async (_tx) => {
    const tx = _tx as unknown as Sql;
    const [row] = await tx`SELECT COUNT(*)::int AS count FROM connectors`;
    if ((row as Record<string, unknown>).count as number > 0) {
      // Even if table is populated, ensure copilot-sdk entry exists
      await ensureCopilotConnector(tx);
      return 0;
    }

    const seen = new Set<string>();
    let created = 0;

    // Seed from bot configs
    for (const bot of botConfigs) {
      created += await seedOne(tx, seen, {
        connectorType: bot.connector ?? "claude-cli",
        model: bot.model ?? null,
        baseUrl: bot.baseUrl ?? null,
        thinkingMaxTokens: bot.thinkingMaxTokens ?? null,
        timeoutMs: bot.timeoutMs ?? null,
      });
    }

    // Always include a copilot-sdk entry
    created += await seedOne(tx, seen, {
      connectorType: "copilot-sdk",
      model: "claude-sonnet-4-6",
      baseUrl: null,
      thinkingMaxTokens: null,
      timeoutMs: null,
    });

    return created;
  });
}

async function seedOne(
  tx: Sql,
  seen: Set<string>,
  config: { connectorType: string; model: string | null; baseUrl: string | null; thinkingMaxTokens: number | null; timeoutMs: number | null },
): Promise<number> {
  const key = `${config.connectorType}|${config.model ?? ""}|${config.baseUrl ?? ""}`;
  if (seen.has(key)) return 0;
  seen.add(key);

  let name = config.connectorType;
  if (config.model) name += ` ${config.model}`;

  await tx`
    INSERT INTO connectors (name, description, connector_type, model, base_url, thinking_max_tokens, timeout_ms)
    VALUES (${name}, ${"Auto-seeded"}, ${config.connectorType}, ${config.model}, ${config.baseUrl}, ${config.thinkingMaxTokens}, ${config.timeoutMs})
  `;
  log.info("Seeded connector \"{name}\" ({type})", { name, type: config.connectorType });
  return 1;
}

async function ensureCopilotConnector(tx: Sql): Promise<void> {
  const [existing] = await tx`SELECT 1 FROM connectors WHERE connector_type = 'copilot-sdk' LIMIT 1`;
  if (existing) return;
  await tx`
    INSERT INTO connectors (name, description, connector_type, model)
    VALUES ('copilot-sdk claude-sonnet-4-6', 'Auto-seeded', 'copilot-sdk', 'claude-sonnet-4-6')
  `;
  log.info("Seeded missing copilot-sdk connector");
}
