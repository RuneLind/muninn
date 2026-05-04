#!/usr/bin/env bun
/**
 * Kill stale muninn-related processes that hold MCP adapters open with
 * stale environments. Run when traces show inconsistent search-trace
 * behaviour after a config change, or any time you suspect orphan
 * benchmarks/dev-servers are intercepting bot traffic.
 *
 * Targets (in this order):
 *   1. Orphaned benchmark runs (`run-cell.ts`) — long-lived bun processes
 *      that each spawn a copilot-sdk client + MCP children. These respawn
 *      child processes the moment you `pkill` the children, so the parent
 *      must be killed first.
 *   2. Stale `knowledge_api_mcp_adapter` instances — captured `TRACE_DEFAULT`
 *      at module-load time, so an adapter spawned before HUGINN_TRACE_POINTER
 *      reached its env will never emit trace markers.
 *   3. Stale `@github/copilot/index.js --headless` MCP children — orphaned
 *      copilot-sdk subprocesses from old muninn or benchmark runs.
 *
 * Usage:
 *   bun run scripts/cleanup-stale-mcp.ts            # dry-run, just list
 *   bun run scripts/cleanup-stale-mcp.ts --kill     # send SIGTERM
 *   bun run scripts/cleanup-stale-mcp.ts --kill -9  # SIGKILL (use sparingly)
 *
 * Does NOT touch:
 *   - the foreground `bun run dev` (you control that yourself)
 *   - Claude Desktop's own MCP children (they belong to Claude.app)
 *   - knowledge_api_server.py (long-lived data process; restart manually if needed)
 */

import { $ } from "bun";

const args = new Set(Bun.argv.slice(2));
const dryRun = !args.has("--kill");
const signal = args.has("-9") ? "KILL" : "TERM";

interface Proc {
  pid: number;
  ppid: number;
  etime: string;
  command: string;
}

async function pgrep(pattern: string): Promise<number[]> {
  const out = await $`pgrep -f ${pattern}`.nothrow().text();
  return out.trim().split("\n").filter(Boolean).map(Number);
}

async function describe(pid: number): Promise<Proc | null> {
  const out = await $`ps -o pid=,ppid=,etime=,command= -p ${pid}`.nothrow().text();
  const line = out.trim();
  if (!line) return null;
  const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
  if (!m) return null;
  return { pid: Number(m[1]), ppid: Number(m[2]), etime: m[3]!, command: m[4]! };
}

async function killGroup(label: string, pattern: string): Promise<number> {
  const pids = await pgrep(pattern);
  if (pids.length === 0) {
    console.log(`✓ ${label}: none found`);
    return 0;
  }
  console.log(`\n${label} (${pids.length}):`);
  for (const pid of pids) {
    const p = await describe(pid);
    if (!p) continue;
    const cmd = p.command.length > 100 ? p.command.slice(0, 100) + "…" : p.command;
    console.log(`  PID ${p.pid} (ppid=${p.ppid}, age=${p.etime})  ${cmd}`);
  }
  if (dryRun) return pids.length;
  for (const pid of pids) {
    await $`kill -${signal} ${pid}`.nothrow().quiet();
  }
  console.log(`  → sent SIG${signal} to ${pids.length} process(es)`);
  return pids.length;
}

console.log(dryRun ? "Dry run — no processes will be killed (pass --kill to act)" : `Sending SIG${signal}`);

// Order matters: kill parents (benchmark runners) before children (their MCP adapters)
// would respawn instantly otherwise.
let total = 0;
total += await killGroup("Orphaned benchmark runs", "benchmarks/scripts/run-cell.ts");
total += await killGroup("Knowledge API MCP adapters", "knowledge_api_mcp_adapter");
total += await killGroup("Copilot SDK headless children", "@github/copilot/index.js --headless");

console.log(dryRun ? `\n${total} stale process(es) would be killed.` : `\nDone. ${total} process(es) targeted.`);

if (!dryRun && total > 0) {
  console.log("\nVerification:");
  await $`pgrep -af "knowledge_api_mcp_adapter|@github/copilot/index.js --headless|benchmarks/scripts/run-cell.ts"`.nothrow();
}
