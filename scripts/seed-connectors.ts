/**
 * Seed default AI connectors into the database.
 *
 * Creates standard connector entries for common AI backends.
 * Safe to run multiple times — skips entries that already exist
 * (unique on connector_type + model + base_url).
 *
 * Usage:
 *   bun scripts/seed-connectors.ts
 *   bun run db:seed-connectors
 *
 * Examples:
 *   # Seed defaults (claude-cli, copilot-sdk)
 *   bun scripts/seed-connectors.ts
 *
 *   # Add a custom Ollama connector
 *   bun scripts/seed-connectors.ts --add openai-compat qwen3.5:35b http://localhost:11434/v1
 */
import postgres from "postgres";
import { loadConfig } from "../src/config.ts";

const config = loadConfig();
const sql = postgres(config.databaseUrl, { max: 1 });

interface ConnectorSeed {
  name: string;
  connectorType: string;
  model: string | null;
  baseUrl: string | null;
}

const DEFAULTS: ConnectorSeed[] = [
  { name: "claude-cli", connectorType: "claude-cli", model: null, baseUrl: null },
  { name: "copilot-sdk claude-sonnet-4-6", connectorType: "copilot-sdk", model: "claude-sonnet-4-6", baseUrl: null },
];

async function seedConnector(c: ConnectorSeed): Promise<boolean> {
  try {
    const [row] = await sql`
      INSERT INTO connectors (name, description, connector_type, model, base_url)
      VALUES (${c.name}, ${"Seeded by seed-connectors script"}, ${c.connectorType}, ${c.model}, ${c.baseUrl})
      ON CONFLICT (connector_type, COALESCE(model, ''), COALESCE(base_url, '')) DO NOTHING
      RETURNING id
    `;
    if (row) {
      console.log(`  ✓ ${c.name} (created)`);
      return true;
    }
    console.log(`  - ${c.name} (already exists)`);
    return false;
  } catch (err) {
    console.error(`  ✗ ${c.name}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);

  // --add <type> <model> [baseUrl]
  if (args[0] === "--add" && args[1]) {
    const connectorType = args[1];
    const model = args[2] || null;
    const baseUrl = args[3] || null;
    let name = connectorType;
    if (model) name += ` ${model}`;

    console.log("Adding connector:");
    await seedConnector({ name, connectorType, model, baseUrl });
    await sql.end();
    return;
  }

  console.log("Seeding default connectors:");
  let created = 0;
  for (const c of DEFAULTS) {
    if (await seedConnector(c)) created++;
  }

  // Also seed from bot configs if any exist
  try {
    const { discoverAllBots } = await import("../src/bots/config.ts");
    const bots = discoverAllBots();
    if (bots.length > 0) {
      console.log("\nSeeding from bot configs:");
      for (const bot of bots) {
        const connectorType = bot.connector ?? "claude-cli";
        const model = bot.model ?? null;
        const baseUrl = bot.baseUrl ?? null;
        let name = connectorType;
        if (model) name += ` ${model}`;
        if (await seedConnector({ name, connectorType, model, baseUrl })) created++;
      }
    }
  } catch {}

  console.log(`\nDone. Created ${created} connector(s).`);

  // Show current connectors
  const rows = await sql`SELECT name, connector_type, model, base_url FROM connectors ORDER BY name`;
  if (rows.length > 0) {
    console.log("\nCurrent connectors:");
    for (const r of rows) {
      let label = `  ${r.name}`;
      if (r.base_url) label += ` (${r.base_url})`;
      console.log(label);
    }
  }

  await sql.end();
}

await main();
