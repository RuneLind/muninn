#!/usr/bin/env bun
/**
 * A/B latency smoke for the haiku-direct adapter. Runs the same decomposer
 * prompt through:
 *   1. spawnHaiku() — Claude CLI subprocess (today's behaviour)
 *   2. callHaikuDirect() — direct @anthropic-ai/sdk call
 *
 * Reports per-run latency and token counts so we can confirm the SDK path
 * really is 5–10× faster on the decomposer hot path before broadening.
 *
 * Usage:
 *   bun scripts/smoke-haiku-direct.ts           # default question
 *   bun scripts/smoke-haiku-direct.ts "<q>"     # custom question
 *
 * Requires one of ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN for the
 * direct path. Bun auto-loads .env, so setting it there is enough.
 */

import { spawnHaiku } from "../src/scheduler/executor.ts";
import { callHaikuDirect, hasHaikuDirectAuth } from "../src/ai/haiku-direct.ts";
import { initDb, closeDb } from "../src/db/client.ts";
import { loadConfig } from "../src/config.ts";

// trackUsage inside both backends needs the DB initialised, even though we
// don't care about the row in this smoke. Init it up-front and close at exit.
initDb(loadConfig());

const question = process.argv[2]
  || "Hva er forskjellen mellom A001 og A002, og hva utløser hver av dem?";

const DECOMPOSE_PROMPT = `You decompose a single user question into the smallest set of focused sub-questions needed to answer it well.

Rules:
- Return 1 sub-question when the input is a simple lookup (one topic, one fact). This is the cheap path — prefer it.
- Return 2–4 sub-questions only when the input asks for a comparison, has distinct parts ("X and Y"), or chains facts across topics.
- Never return 0 or more than 4. If you would, return 1 with the original question verbatim.
- Each sub-question stands alone: a downstream knowledge-base search must be able to answer it without the others.
- Keep sub-questions tight — they will be sent to a retrieval service, not back to a person.

Respond with ONLY valid JSON (no markdown fences, no commentary):
{"subQuestions": ["..."], "rationale": "short reason for the choice"}

Question to decompose:
"""
${question}
"""`;

if (!hasHaikuDirectAuth()) {
  console.error("✗ Neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN is set.");
  console.error("  Run `claude setup-token` (interactive) and add the token to .env, or set ANTHROPIC_API_KEY.");
  process.exit(1);
}

console.log(`Question: ${question}`);
console.log("");

// 1. CLI baseline
console.log("→ spawnHaiku (Claude CLI subprocess) ...");
const cliStart = performance.now();
let cliResult: Awaited<ReturnType<typeof spawnHaiku>>;
try {
  cliResult = await spawnHaiku(DECOMPOSE_PROMPT, {
    source: "smoke-haiku-direct",
    entrypoint: "smoke-cli",
    botName: "smoke",
  });
} catch (err) {
  console.error(`  ✗ failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const cliMs = performance.now() - cliStart;
console.log(`  ✓ ${cliMs.toFixed(0)}ms · in=${cliResult.inputTokens} out=${cliResult.outputTokens} model=${cliResult.model}`);
console.log(`  result: ${cliResult.result.slice(0, 200).replace(/\n/g, " ")}${cliResult.result.length > 200 ? "…" : ""}`);
console.log("");

// 2. Direct SDK
console.log("→ callHaikuDirect (Anthropic SDK) ...");
const sdkStart = performance.now();
let sdkResult: Awaited<ReturnType<typeof callHaikuDirect>>;
try {
  sdkResult = await callHaikuDirect(DECOMPOSE_PROMPT, {
    source: "smoke-haiku-direct",
    entrypoint: "smoke-sdk",
    botName: "smoke",
  });
} catch (err) {
  console.error(`  ✗ failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const sdkMs = performance.now() - sdkStart;
console.log(`  ✓ ${sdkMs.toFixed(0)}ms · in=${sdkResult.inputTokens} out=${sdkResult.outputTokens} model=${sdkResult.model}`);
console.log(`  result: ${sdkResult.result.slice(0, 200).replace(/\n/g, " ")}${sdkResult.result.length > 200 ? "…" : ""}`);
console.log("");

const speedup = cliMs / sdkMs;
console.log("─".repeat(60));
console.log(`Speedup: ${speedup.toFixed(2)}× (CLI ${cliMs.toFixed(0)}ms → SDK ${sdkMs.toFixed(0)}ms)`);
console.log(`Saved per call: ${(cliMs - sdkMs).toFixed(0)}ms`);

// Give trackUsage's fire-and-forget INSERTs a moment to land, then close pool.
await new Promise((r) => setTimeout(r, 200));
await closeDb();
