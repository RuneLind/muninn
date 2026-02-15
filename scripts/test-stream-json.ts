#!/usr/bin/env bun
/**
 * Phase 0: Verify Claude CLI --output-format stream-json event schema.
 *
 * Verified schema (Claude Code CLI v2.1+):
 *
 * Top-level NDJSON event types:
 *   "system"    — init, session_id, tools[], mcp_servers[]
 *   "assistant" — complete assistant turn with content blocks (text, tool_use, thinking)
 *   "user"      — tool_result blocks fed back to Claude
 *   "result"    — final line: text result, usage, cost, duration, num_turns
 *
 * Tool calls appear in assistant messages:
 *   { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } }
 *
 * Tool results appear in user messages:
 *   { type: "user", message: { content: [{ type: "tool_result", tool_use_id, content, is_error }] } }
 *
 * MCP tools use qualified names: mcp__<server>__<tool>
 *
 * Usage:
 *   bun scripts/test-stream-json.ts [prompt]
 *
 * NOTE: Cannot run from within a Claude Code session (nested session protection).
 *       Run from a regular terminal instead.
 */

const prompt = process.argv[2] ?? "say hello in one sentence";

console.log(`\n=== Testing --output-format stream-json ===`);
console.log(`Prompt: "${prompt}"\n`);

const proc = Bun.spawn(
  ["claude", "-p", prompt, "--output-format", "stream-json", "--model", "haiku"],
  {
    cwd: `${import.meta.dir}/../bots/jarvis`,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, CLAUDECODE: "", CLAUDE_CODE_ENTRYPOINT: "" },
  },
);

const stdout = await new Response(proc.stdout).text();
const stderr = await new Response(proc.stderr).text();
const exitCode = await proc.exited;

if (stderr.trim()) {
  console.log("=== STDERR ===");
  console.log(stderr.slice(0, 1000));
}

console.log(`Exit code: ${exitCode}\n`);
console.log(`=== RAW NDJSON LINES (${stdout.split("\n").filter(l => l.trim()).length} lines) ===\n`);

const types = new Set<string>();
const toolNames: string[] = [];

for (const line of stdout.split("\n")) {
  if (!line.trim()) continue;

  try {
    const event = JSON.parse(line);
    const type = event.type ?? "unknown";
    types.add(type);

    const preview = JSON.stringify(event).slice(0, 200);
    console.log(`[${type}] ${preview}`);

    // Check for tool use in assistant messages
    if (type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "tool_use") {
          toolNames.push(block.name);
          console.log(`  >>> TOOL USE: ${block.name} (id: ${block.id})`);
          console.log(`      Input: ${JSON.stringify(block.input).slice(0, 200)}`);
        }
      }
    }

    // Check for tool results in user messages
    if (type === "user" && event.message?.content) {
      const content = Array.isArray(event.message.content) ? event.message.content : [];
      for (const block of content) {
        if (block.type === "tool_result") {
          console.log(`  >>> TOOL RESULT: ${block.tool_use_id} (error: ${block.is_error})`);
        }
      }
    }

    // Result summary
    if (type === "result") {
      console.log(`  >>> RESULT: turns=${event.num_turns}, duration=${event.duration_ms}ms, api=${event.duration_api_ms}ms`);
      console.log(`      Tokens: in=${event.usage?.input_tokens}, out=${event.usage?.output_tokens}`);
      console.log(`      Cost: $${event.total_cost_usd}`);
    }
  } catch {
    console.log(`[PARSE ERROR] ${line.slice(0, 200)}`);
  }
}

console.log(`\n=== SUMMARY ===`);
console.log(`Event types seen: ${[...types].join(", ")}`);
console.log(`Tool calls: ${toolNames.length > 0 ? toolNames.join(", ") : "none"}`);
console.log(`Total NDJSON lines: ${stdout.split("\n").filter(l => l.trim()).length}`);
