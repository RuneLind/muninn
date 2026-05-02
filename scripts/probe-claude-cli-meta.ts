/**
 * Probe: does Claude CLI's --output-format stream-json surface MCP `_meta`
 * in tool_result events?
 *
 * If yes → Phase 2 (out-of-band trace channel via _meta) works for claude-cli
 *         and we can delete the parse-before-truncate hack + divert-rewrite.
 * If no  → claude-cli needs a fallback (e.g. trace-id pointer + Huginn store).
 *
 * Run: bun run scripts/probe-claude-cli-meta.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SERVER_PATH = resolve(__dirname, "probe-meta-mcp-server.py");
const META_MARKER = "META_PROBE_MARKER_42";
const STRUCTURED_MARKER = "STRUCTURED_PROBE_MARKER_99";

const tmp = mkdtempSync(join(tmpdir(), "claude-meta-probe-"));
const mcpConfig = {
  mcpServers: {
    probe: {
      type: "stdio",
      command: "uv",
      args: ["run", "--with", "mcp", SERVER_PATH],
    },
  },
};
const cfgPath = join(tmp, ".mcp.json");
writeFileSync(cfgPath, JSON.stringify(mcpConfig, null, 2));

console.log(`[probe] tmp dir: ${tmp}`);
console.log(`[probe] mcp config: ${cfgPath}`);

const args = [
  "claude",
  "-p",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--mcp-config", cfgPath,
  "--allowedTools", "mcp__probe__echo",
  "--",
  "Call the mcp__probe__echo tool with text='hello' and report what it returned.",
];

console.log(`[probe] running: ${args.join(" ")}`);
const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", cwd: tmp });

const stdout = await new Response(proc.stdout).text();
const stderr = await new Response(proc.stderr).text();
const exitCode = await proc.exited;

console.log(`[probe] exit code: ${exitCode}`);
if (stderr.trim()) console.log(`[probe] stderr (first 500 chars):\n${stderr.slice(0, 500)}`);

console.log("\n[probe] === scanning NDJSON ===");
const lines = stdout.split("\n").filter((l) => l.trim());
let foundToolResult = false;
let foundMetaInToolResult = false;
let foundMetaMarkerAnywhere = false;
let foundStructuredMarkerAnywhere = false;

for (const line of lines) {
  if (line.includes(META_MARKER)) foundMetaMarkerAnywhere = true;
  if (line.includes(STRUCTURED_MARKER)) foundStructuredMarkerAnywhere = true;
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  // Inspect the event-level tool_use_result field (outside message.content) —
  // this might be a CLI-internal channel that doesn't reach the model.
  if (event.type === "user" && event.tool_use_result !== undefined) {
    console.log(`[probe] event.tool_use_result top-level keys: ${
      typeof event.tool_use_result === "object"
        ? Object.keys(event.tool_use_result).join(", ")
        : typeof event.tool_use_result
    }`);
    console.log(`[probe] event.tool_use_result raw (first 600 chars): ${
      JSON.stringify(event.tool_use_result).slice(0, 600)
    }`);
  }
  if (event.type === "user" && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block?.type === "tool_result") {
        foundToolResult = true;
        console.log(`[probe] tool_result block keys: ${Object.keys(block).join(", ")}`);
        console.log(`[probe] tool_result.content shape: ${JSON.stringify(block.content).slice(0, 300)}`);
        if (block._meta !== undefined || block.meta !== undefined) {
          foundMetaInToolResult = true;
          console.log(`[probe] *** _meta found on tool_result: ${JSON.stringify(block._meta ?? block.meta)}`);
        }
        // Check if _meta is nested inside content
        if (Array.isArray(block.content)) {
          for (const part of block.content) {
            if (part && typeof part === "object" && (part._meta || part.meta)) {
              console.log(`[probe] *** _meta found INSIDE content block: ${JSON.stringify(part._meta ?? part.meta)}`);
            }
          }
        }
      }
    }
  }
}

console.log("\n[probe] === SUMMARY ===");
console.log(`  _meta marker            anywhere in NDJSON: ${foundMetaMarkerAnywhere}`);
console.log(`  structuredContent marker anywhere in NDJSON: ${foundStructuredMarkerAnywhere}`);
console.log(`  tool_result block found:                     ${foundToolResult}`);
console.log(`  _meta on tool_result:                        ${foundMetaInToolResult}`);
console.log(`\n  → _meta side-channel viable for claude-cli? ${foundMetaMarkerAnywhere ? "YES" : "NO"}`);
console.log(`  → structuredContent viable for claude-cli?  ${foundStructuredMarkerAnywhere ? "YES" : "NO"}`);

// Also dump every line that contains "meta" or any marker, regardless of which
// event carried it.
console.log("\n[probe] === every line containing 'meta' or 'structured' or markers ===");
for (const line of lines) {
  if (
    line.toLowerCase().includes("meta") ||
    line.toLowerCase().includes("structured") ||
    line.includes(META_MARKER) ||
    line.includes(STRUCTURED_MARKER)
  ) {
    console.log(line.slice(0, 500));
  }
}

if (!foundToolResult) {
  console.log("\n[probe] No tool_result found. Raw NDJSON dump (first 4000 chars):");
  console.log(stdout.slice(0, 4000));
}

rmSync(tmp, { recursive: true, force: true });
