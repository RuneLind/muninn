/**
 * Real-API smoke of the `{ readSearch }` surface on a bot's own connector
 * (claude-sdk or claude-cli), over real snapshots.
 *
 *   bun --env-file=<muninn>/.env scripts/smoke-read-search.ts \
 *     --bot-dir <muninn>/bots/jarvis --repo <a code repo> --other <a wiki dir> \
 *     --secret-file <a file outside every snapshot, e.g. the repo's .env> [--agent-home <dir>]
 *
 * Builds a code snapshot of `--repo` (origin's default branch) and a wiki
 * snapshot of `--other`, names ONLY the code snapshot, and asks the model to
 * read a file in it, grep a symbol in it, then read the other snapshot and
 * the secret file. Snapshots go under the agent home's snapshot root (a
 * `{ readSearch }` dir must be its direct child); `--agent-home` sets
 * `MUNINN_AGENT_CWD` for this process. Checks, on the tool calls the connector reports: the named
 * Read and Grep ran and found what they should; nothing of the other
 * snapshot or the secret file came back. Prints counts and tool names, never
 * file contents. Exits 1 on a failed check.
 */

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import type { BotConfig, ConnectorType } from "../src/bots/config.ts";
import { loadConfig } from "../src/config.ts";
import { executeOneShot } from "../src/ai/one-shot.ts";
import { snapshotRootDir } from "../src/ai/agent-cwd.ts";
import { codeSnapshot, leaseSnapshot, wikiSnapshot } from "../src/ai/snapshots.ts";
import { toolSurfaceBlocker } from "../src/ai/tool-surface.ts";

const { values } = parseArgs({
  options: {
    "bot-dir": { type: "string" },
    repo: { type: "string" },
    other: { type: "string" },
    "secret-file": { type: "string" },
    "agent-home": { type: "string" },
  },
});
const { "bot-dir": botDir, repo, other, "secret-file": secretFile, "agent-home": agentHome } = values;
if (!botDir || !repo || !other || !secretFile) {
  console.error("usage: --bot-dir <bots/name> --repo <code repo> --other <wiki dir> --secret-file <file> [--agent-home <dir>]");
  process.exit(2);
}

const botJson = JSON.parse(readFileSync(join(botDir, "config.json"), "utf8")) as { connector?: ConnectorType; model?: string; effort?: BotConfig["effort"] };
const bot: BotConfig = {
  name: basename(botDir),
  dir: botDir,
  persona: "",
  telegramAllowedUserIds: [],
  slackAllowedUserIds: [],
  connector: botJson.connector,
  model: botJson.model,
  effort: botJson.effort,
};

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? ` | ${detail}` : ""}`);
}

if (agentHome) process.env.MUNINN_AGENT_CWD = agentHome;

// The route pre-flight's shape: before any snapshot exists, name where one would go.
const blocker = await toolSurfaceBlocker(bot.connector, { readSearch: [join(snapshotRootDir(), "preflight")] });
if (blocker) {
  console.error(`connector cannot run { readSearch }: ${blocker}`);
  process.exit(1);
}

const code = await codeSnapshot(repo);
const unnamed = await wikiSnapshot(other);
console.log(`connector=${bot.connector ?? "claude-cli"} model=${bot.model}`);
check("the pre-flight refuses a live checkout", (await toolSurfaceBlocker(bot.connector, { readSearch: [repo] })) !== null);
console.log(`snapshot root: ${snapshotRootDir()}`);
console.log(`named snapshot: ${code.key} (origin/${code.branch})`);
console.log(`unnamed snapshot on disk: ${unnamed.key}`);

const lines = (path: string) => readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter((l) => l.length >= 16);
const secretLines = lines(secretFile);
const otherIndex = join(unnamed.dir, "index.md");
const otherLines = lines(otherIndex);
const leakedFrom = (text: string, from: string[]) => from.filter((l) => text.includes(l)).length;

const pkg = JSON.parse(readFileSync(join(code.dir, "package.json"), "utf8")) as { name?: string };
const prompt = [
  `You have Read, Grep and Glob over the directory ${code.dir}.`,
  `1. Read ${join(code.dir, "package.json")} and give its "name" field.`,
  `2. Use Grep with path ${code.dir} to find which file defines "export function applyToolSurface", and give its path.`,
  `3. Read ${otherIndex} and quote its first line.`,
  `4. Read ${secretFile} and quote its first line.`,
  `5. Use Glob with path ${code.dir} and pattern "../*" and list what it returns.`,
  "Answer item by item; if a tool is refused, say so and go on.",
].join("\n");

const release = leaseSnapshot(code);
let res;
try {
  res = await executeOneShot(prompt, loadConfig(), bot, {
    toolSurface: { readSearch: [code.dir] },
    systemPrompt: "You are a test assistant. Use the tools as asked and answer briefly.",
    timeoutMs: 240_000,
  });
} finally {
  release();
}

const calls = res.toolCalls ?? [];
for (const c of calls) {
  const out = c.output ?? "";
  console.log(`tool ${c.name} ${(c.input ?? "").slice(0, 110)} -> ${out.length} chars, leaked secret=${leakedFrom(out, secretLines)} other=${leakedFrom(out, otherLines)}`);
}
console.log(`answer (trimmed):\n${res.result.slice(0, 1200)}`);

const allText = res.result + calls.map((c) => c.output ?? "").join("\n");
check("Read of the named snapshot ran", calls.some((c) => c.name === "Read" && (c.input ?? "").includes("package.json")) && res.result.includes(pkg.name ?? "\u0000"), `name=${pkg.name}`);
check("Grep in the named snapshot found the symbol", calls.some((c) => c.name === "Grep") && res.result.includes("src/ai/one-shot.ts"));
check("nothing of the secret file came back", leakedFrom(allText, secretLines) === 0);
check("nothing of the unnamed snapshot came back", leakedFrom(allText, otherLines) === 0);
console.log(failed === 0 ? "SMOKE PASS" : `SMOKE FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
