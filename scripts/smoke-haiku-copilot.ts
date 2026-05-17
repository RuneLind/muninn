#!/usr/bin/env bun
/**
 * Smoke for the Copilot backend of the Haiku router. Runs the decomposer
 * prompt through `callHaikuViaCopilot` and reports latency, tokens, and the
 * model Copilot actually used — so we can confirm the Haiku model ID we send
 * is accepted (or learn what Copilot remaps it to).
 *
 * Usage:
 *   bun scripts/smoke-haiku-copilot.ts                # default question
 *   bun scripts/smoke-haiku-copilot.ts "<question>"
 *
 * Requires the @github/copilot-sdk auth surface to be working locally
 * (typically: `gh auth login` with the Capra/NAV Copilot subscription).
 */

import { callHaikuViaCopilot } from "../src/ai/haiku-direct.ts";
import { DECOMPOSE_PROMPT } from "../src/ai/knowledge-decomposer.ts";
import { initDb, closeDb } from "../src/db/client.ts";
import { loadConfig } from "../src/config.ts";

initDb(loadConfig());

const question = process.argv[2]
  || "Hva er forskjellen mellom A001 og A002, og hva utløser hver av dem?";

const prompt = DECOMPOSE_PROMPT.replace("{QUESTION}", question);

console.log(`Question: ${question}`);
console.log("");

console.log("→ callHaikuViaCopilot (Copilot SDK) ...");
const t0 = performance.now();
try {
  const result = await callHaikuViaCopilot(prompt, {
    source: "smoke-haiku-copilot",
    entrypoint: "smoke-copilot",
    botName: "smoke",
  });
  const ms = performance.now() - t0;
  console.log(`  ✓ ${ms.toFixed(0)}ms · in=${result.inputTokens} out=${result.outputTokens} model=${result.model}`);
  console.log(`  result: ${result.result.slice(0, 200).replace(/\n/g, " ")}${result.result.length > 200 ? "…" : ""}`);
} catch (err) {
  console.error(`  ✗ failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

await new Promise((r) => setTimeout(r, 200));
await closeDb();
process.exit(process.exitCode ?? 0);
