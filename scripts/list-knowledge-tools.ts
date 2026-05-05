#!/usr/bin/env bun
import { connectToServer, disconnectAll, loadMcpConfig } from "../src/dashboard/mcp-client.ts";

const BOT = "melosys";
const SERVER = "knowledge";
const BOT_DIR = "/Users/rune/source/private/muninn/bots/melosys";

const cfg = await loadMcpConfig(BOT_DIR);
if (!cfg) throw new Error("no mcp config");
const server = cfg.mcpServers[SERVER];
if (!server) throw new Error("no knowledge server");

const { tools } = await connectToServer(BOT, SERVER, server, BOT_DIR);
for (const t of tools) {
  console.log(`\n## ${t.name}`);
  if (t.description) console.log(t.description.split("\n").slice(0, 2).join("\n"));
  console.log("INPUT SCHEMA:");
  console.log(JSON.stringify(t.inputSchema?.properties, null, 2).slice(0, 1200));
}
await disconnectAll();
