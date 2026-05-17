#!/usr/bin/env bun
/**
 * Smoke for the claude-sdk connector — verifies that text streams in
 * incrementally (per-token text_delta events) instead of arriving as one
 * blob at the end of the turn.
 *
 * Prints the wall-clock time-to-first-delta, total delta count, and a
 * histogram of inter-delta gaps. A correctly-streaming connector should
 * show first-delta within ~1s and dozens-to-hundreds of deltas for a
 * multi-sentence answer.
 *
 * Usage:
 *   bun scripts/smoke-claude-sdk-stream.ts           # default question
 *   bun scripts/smoke-claude-sdk-stream.ts "<q>"     # custom question
 *
 * Requires one of ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.
 */

import { executePrompt } from "../src/ai/connectors/claude-sdk.ts";
import { hasHaikuDirectAuth } from "../src/ai/haiku-direct.ts";
import { loadConfig } from "../src/config.ts";
import type { BotConfig } from "../src/bots/config.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

if (!hasHaikuDirectAuth()) {
  console.error("✗ Neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set.");
  console.error("  Set one in .env, then re-run.");
  process.exit(1);
}

const question = process.argv[2]
  || "Explain what an LRU cache is in 3 short sentences.";

const dir = mkdtempSync(join(tmpdir(), "claude-sdk-smoke-"));
writeFileSync(join(dir, "CLAUDE.md"), "You are a concise technical assistant.");

const botConfig: BotConfig = {
  name: "smoke",
  dir,
  persona: "You are a concise technical assistant.",
  telegramAllowedUserIds: [],
  slackAllowedUserIds: [],
  model: "claude-sonnet-4-6",
};

const config = loadConfig();

console.log(`Question: ${question}`);
console.log("");
console.log("→ claude-sdk connector (model=claude-sonnet-4-6) ...");

const start = performance.now();
let firstDeltaAt: number | null = null;
let lastDeltaAt = start;
const gaps: number[] = [];
let deltaCount = 0;
let deltaBytes = 0;

try {
  const result = await executePrompt(
    question,
    config,
    botConfig,
    "You are a concise technical assistant. Answer in 2-3 short sentences.",
    (ev) => {
      const now = performance.now();
      if (ev.type === "text_delta") {
        if (firstDeltaAt === null) firstDeltaAt = now;
        gaps.push(now - lastDeltaAt);
        lastDeltaAt = now;
        deltaCount++;
        deltaBytes += ev.text.length;
        // Print delta inline so you can watch it stream
        process.stdout.write(ev.text);
      }
    },
  );
  const totalMs = performance.now() - start;
  console.log("\n");
  console.log("─".repeat(60));
  if (firstDeltaAt === null) {
    console.log(`✗ NO STREAMING — 0 text_delta events received over ${totalMs.toFixed(0)}ms`);
    console.log(`  Full answer arrived as one blob: ${result.result.length} chars`);
    process.exit(2);
  }
  const ttfd = firstDeltaAt - start;
  const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const maxGap = Math.max(...gaps);
  console.log(`✓ Streaming OK`);
  console.log(`  Time-to-first-delta: ${ttfd.toFixed(0)}ms`);
  console.log(`  Total time:          ${totalMs.toFixed(0)}ms`);
  console.log(`  Deltas:              ${deltaCount} (${deltaBytes} chars total)`);
  console.log(`  Inter-delta gap:     mean=${meanGap.toFixed(0)}ms max=${maxGap.toFixed(0)}ms`);
  console.log(`  Tokens:              in=${result.inputTokens} out=${result.outputTokens} model=${result.model}`);
} catch (err) {
  console.error(`\n✗ failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  rmSync(dir, { recursive: true });
}
