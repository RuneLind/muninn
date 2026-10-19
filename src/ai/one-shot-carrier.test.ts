/**
 * The carrier for model-call entry points typecheck cannot see.
 *
 * `executeOneShot`, `tracedOneShot` and `runCaptureOneShot` take a REQUIRED
 * `toolSurface`, so a new caller of those fails typecheck until it states its
 * surface. A caller that goes AROUND them — straight to `resolveConnector`,
 * to `executeClaudePrompt`, to a connector module's `executePrompt`, to any
 * value the Agent SDK exports (`query`, and `startup()`, whose `WarmQuery`
 * runs a model too), to a hand-built `["claude", …]` argv, or to a
 * `spawn("claude", …)` / Bun.$`claude …` command — carries no surface at all.
 * This test pins the exact set of such sites in `src/` (test files excluded): a
 * new one fails here, and so does a pattern that stops matching an allowed one.
 * A pattern with no allowed site is held by its own positive samples instead,
 * so no dead regex can pass.
 *
 * Out of reach: this is a regex scan of literal text, so it cannot follow a
 * value. A command name held in a variable (`const BIN = "claude";
 * Bun.spawn([BIN, …])`, `spawn(BIN, …)`, `process.env.CLAUDE_PATH ?? "claude"`,
 * Bun.$`${bin}`), a call through a library it does not name (`execa("claude")`)
 * or a member call `cp.exec("claude …")` (left out because `RegExp#exec` has the
 * same name) passes unseen. Review is the gate for those.
 */

import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");

/** The Agent SDK package (or a subpath of it) as a quoted module specifier. */
const SDK = String.raw`["']@anthropic-ai\/claude-agent-sdk(?:\/[^"']*)?["']`;

const PATTERNS: Record<string, RegExp> = {
  // A call, not the definition or a mention in prose.
  "resolveConnector call": /(?<!function\s)\bresolveConnector\s*\(/g,
  "executeClaudePrompt reference": /\bexecuteClaudePrompt\b(?!\s*\()|(?<!function\s)\bexecuteClaudePrompt\s*\(/g,
  "connector executePrompt import":
    /import\s*\{[^}]*\bexecutePrompt\b[^}]*\}\s*from\s*["'][^"']*connectors\/[^"']+["']|import\(\s*["'][^"']*connectors\/(?:claude-cli|claude-sdk|copilot-sdk|openai-compat)(?:\.ts)?["']\s*\)[\s\S]{0,120}?\.executePrompt\b/g,
  "claude argv literal": /\[\s*["']claude["']/g,
  // Any value binding from the Agent SDK: named, default, namespace, re-export,
  // dynamic import or require. A clause whose every member is `type` brings in no call.
  "agent SDK value import": new RegExp(
    [
      String.raw`\b(?:import|export)\s*(?:[\w$]+\s*,\s*)?\{\s*(?:type\s+[\w$]+(?:\s+as\s+[\w$]+)?\s*,\s*)*(?!type\s)[\w$][^}]*\}\s*from\s*${SDK}`,
      String.raw`\b(?:import|export)(?:\s+[\w$]+|\s*\*(?:\s*as\s+[\w$]+)?)\s*(?:,\s*(?:\{[^}]*\}|\*\s*as\s+[\w$]+)\s*)?from\s*${SDK}`,
      String.raw`\b(?:import|require)\s*\(\s*${SDK}\s*\)`,
    ].join("|"),
    "g",
  ),
  // A whole-word `claude` command; a member `.exec(` is RegExp#exec, not a spawn.
  "claude command string":
    /(?:\b(?:spawn|spawnSync|execSync|execFile|execFileSync)|(?<![.\w$])exec)\(\s*["'`]claude(?=[\s"'`])|\$\s*`\s*claude\b/g,
};

/** Sites each pattern must match, so a pattern with no allowed site cannot go dead unseen. */
const SAMPLES: Record<string, { hit: string[]; miss: string[] }> = {
  "resolveConnector call": { hit: ["resolveConnector(bot)"], miss: ["function resolveConnector(b) {}"] },
  "executeClaudePrompt reference": { hit: ["const f = executeClaudePrompt;"], miss: ["function executeClaudePrompt() {}"] },
  "connector executePrompt import": {
    hit: ['import { executePrompt } from "./connectors/claude-cli.ts";'],
    miss: ['import { executePrompt } from "./other.ts";'],
  },
  "claude argv literal": { hit: ['Bun.spawn(["claude", "-p"])'], miss: ['["claudette"]'] },
  "agent SDK value import": {
    hit: [
      'import { query } from "@anthropic-ai/claude-agent-sdk";',
      'import { type Options, query as q } from "@anthropic-ai/claude-agent-sdk";',
      'import * as sdk from "@anthropic-ai/claude-agent-sdk";',
      'const m = await import("@anthropic-ai/claude-agent-sdk");',
      'import { startup } from "@anthropic-ai/claude-agent-sdk";',
      'export { query as _q } from "@anthropic-ai/claude-agent-sdk";',
      'const sdk = require("@anthropic-ai/claude-agent-sdk");',
      'import{query}from"@anthropic-ai/claude-agent-sdk"',
      'import sdk from "@anthropic-ai/claude-agent-sdk";',
      'import sdk, { type Options } from "@anthropic-ai/claude-agent-sdk";',
      'export * from "@anthropic-ai/claude-agent-sdk";',
      'import*as sdk from"@anthropic-ai/claude-agent-sdk"',
    ],
    miss: [
      'import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";',
      'import type { query } from "@anthropic-ai/claude-agent-sdk";',
      'import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";',
      'import { type query } from "@anthropic-ai/claude-agent-sdk";',
      'import { type Options, type SDKMessage as M } from "@anthropic-ai/claude-agent-sdk";',
      'export type { Options } from "@anthropic-ai/claude-agent-sdk";',
      'export type * from "@anthropic-ai/claude-agent-sdk";',
      'import type Sdk from "@anthropic-ai/claude-agent-sdk";',
      'import type * as T from "@anthropic-ai/claude-agent-sdk";',
      'import { query } from "./other.ts";',
    ],
  },
  "claude command string": {
    hit: [
      'spawn("claude", ["-p"])',
      "execFileSync('claude', [])",
      "await $`claude -p ${x}`",
      "Bun.$`claude --version`",
      'exec("claude -p hi")',
      'cp.spawn("claude -p")',
    ],
    miss: ['spawn("claudette")', "$`ls claude`", 're.exec("claude-sonnet-4-5")', 're.exec("claude 2.1.3")', 'spawn("claude-foo")'],
  },
};

/** `<pattern>|<file>` → match count. Exactly the sites on main when the carrier landed. */
const ALLOWED: Record<string, number> = {
  "resolveConnector call|ai/one-shot.ts": 1,
  "resolveConnector call|core/message-processor.ts": 1,
  "resolveConnector call|scheduler/task-executor.ts": 1,
  "executeClaudePrompt reference|ai/connectors/claude-cli.ts": 1,
  "connector executePrompt import|ai/connector.ts": 4,
  "claude argv literal|ai/executor.ts": 1,
  "claude argv literal|benchmarks/judge.ts": 1,
  "claude argv literal|scheduler/executor.ts": 1,
  // `claude --version`, the fenced surfaces' version gate: no model call.
  "claude argv literal|ai/tool-surface.ts": 1,
  "agent SDK value import|ai/connectors/claude-sdk.ts": 1,
};

/** Line comments and block comments out, so prose naming a function is not a site. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

test("model-call entry points outside the tool-surface seam are exactly the allowed set", async () => {
  const found: Record<string, number> = {};
  for (const rel of new Glob("**/*.{ts,tsx,js,mjs}").scanSync(SRC)) {
    if (/\.test\.(ts|tsx|js|mjs)$/.test(rel)) continue;
    const text = stripComments(await Bun.file(join(SRC, rel)).text());
    for (const [name, re] of Object.entries(PATTERNS)) {
      const count = [...text.matchAll(re)].length;
      if (count > 0) found[`${name}|${rel}`] = count;
    }
  }
  expect(found).toEqual(ALLOWED);
});

test("every pattern matches its samples and only them", () => {
  expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(PATTERNS).sort());
  for (const [name, re] of Object.entries(PATTERNS)) {
    for (const hit of SAMPLES[name]!.hit) expect([name, hit, [...hit.matchAll(re)].length]).toEqual([name, hit, 1]);
    for (const miss of SAMPLES[name]!.miss) expect([name, miss, [...miss.matchAll(re)].length]).toEqual([name, miss, 0]);
  }
});
