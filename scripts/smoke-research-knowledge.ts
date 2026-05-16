#!/usr/bin/env bun
/**
 * One-shot smoke for Phase 2 — call research_knowledge on a registered bot
 * and print the response. Reads the muninn DB afterwards to verify the
 * trace tree shape. Use:
 *
 *   bun scripts/smoke-research-knowledge.ts <botName> "<question>"
 *
 * Default bot: melosys. Default question is a multi-part comparison.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import postgres from "postgres";

const botName = process.argv[2] || "melosys";
const question = process.argv[3] || "Hva er forskjellen mellom A001 og A002, og hva utløser hver av dem?";

const baseUrl = `http://127.0.0.1:9190/mcp/${botName}`;
console.log(`→ Connecting to ${baseUrl}`);

const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
const client = new Client({ name: "phase-2-smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

console.log(`→ Listing tools`);
const tools = await client.listTools();
console.log(`  found ${tools.tools.length}: ${tools.tools.map((t) => t.name).join(", ")}`);

console.log(`→ Calling research_knowledge`);
console.log(`  question: ${question}`);
const t0 = Date.now();
const result = await client.callTool({
  name: "research_knowledge",
  arguments: { question },
});
const elapsedMs = Date.now() - t0;
console.log(`  took ${elapsedMs}ms`);
console.log("");

// Print the rendered text response that the model would see.
const content = (result as { content?: Array<{ type: string; text?: string }> }).content || [];
for (const c of content) {
  if (c.type === "text" && c.text) {
    console.log(c.text.slice(0, 2000));
    if (c.text.length > 2000) console.log(`\n... (${c.text.length - 2000} more chars truncated)`);
  }
}

await client.close();
console.log("\n→ Querying muninn DB for the most recent research_knowledge trace");

const sql = postgres(process.env.DATABASE_URL || "postgresql://muninn:muninn@127.0.0.1:5435/muninn");
const root = await sql<Array<{ id: string; trace_id: string; bot_name: string; started_at: Date; duration_ms: number; status: string; attributes: unknown }>>`
  SELECT id, trace_id, bot_name, started_at, duration_ms, status, attributes
  FROM traces
  WHERE name = 'research_knowledge'
  ORDER BY started_at DESC
  LIMIT 1
`;
if (root.length === 0) {
  console.log("  ✗ No research_knowledge span found in DB");
  await sql.end();
  process.exit(1);
}
const r = root[0]!;
console.log(`  root span: id=${r.id.slice(0, 8)} traceId=${r.trace_id.slice(0, 8)} bot=${r.bot_name} status=${r.status} duration=${r.duration_ms}ms`);
console.log(`  attrs:    `, r.attributes);

const children = await sql<Array<{ id: string; parent_id: string | null; name: string; duration_ms: number; status: string; attributes: unknown }>>`
  SELECT id, parent_id, name, duration_ms, status, attributes
  FROM traces
  WHERE trace_id = ${r.trace_id}
    AND parent_id = ${r.id}
  ORDER BY started_at
`;
console.log(`  ${children.length} child span(s):`);
for (const ch of children) {
  console.log(`    - ${ch.name} (${ch.duration_ms}ms ${ch.status})`);
  if (ch.attributes && typeof ch.attributes === "object") {
    const attrs = ch.attributes as Record<string, unknown>;
    const { searchTrace, ...rest } = attrs;
    console.log(`      attrs:`, rest);
    if (searchTrace && typeof searchTrace === "object") {
      const st = searchTrace as { response?: { corrective?: unknown } };
      const corrective = st.response?.corrective;
      if (corrective) {
        console.log(`      corrective:`, corrective);
      }
    }
  }
}

await sql.end();
console.log("\n✓ Smoke complete");
