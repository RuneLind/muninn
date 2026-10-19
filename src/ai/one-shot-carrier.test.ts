/**
 * The carrier for model-call entry points typecheck cannot see.
 *
 * `executeOneShot`, `tracedOneShot` and `runCaptureOneShot` take a REQUIRED
 * `toolSurface`, so a new caller of those fails typecheck until it states its
 * surface. A caller that goes AROUND them — straight to `resolveConnector`,
 * to `executeClaudePrompt`, to a connector module's `executePrompt`, to the
 * Agent SDK's `query`, to a hand-built `["claude", …]` argv, or to a
 * `spawn("claude", …)` / Bun.$`claude …` command — carries no surface at all.
 * This test pins the exact set of such sites in `src/` (test files excluded): a
 * new one fails here, and so does a pattern that stops matching an allowed one.
 * A pattern with no allowed site is held by its own positive samples instead,
 * so no dead regex can pass.
 */

import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");

const PATTERNS: Record<string, RegExp> = {
  // A call, not the definition or a mention in prose.
  "resolveConnector call": /(?<!function\s)\bresolveConnector\s*\(/g,
  "executeClaudePrompt reference": /\bexecuteClaudePrompt\b(?!\s*\()|(?<!function\s)\bexecuteClaudePrompt\s*\(/g,
  "connector executePrompt import":
    /import\s*\{[^}]*\bexecutePrompt\b[^}]*\}\s*from\s*["'][^"']*connectors\/[^"']+["']|import\(\s*["'][^"']*connectors\/(?:claude-cli|claude-sdk|copilot-sdk|openai-compat)(?:\.ts)?["']\s*\)[\s\S]{0,120}?\.executePrompt\b/g,
  "claude argv literal": /\[\s*["']claude["']/g,
  // A value import of `query` (named, namespace or dynamic); `import type` is no call.
  "agent SDK query import":
    /import\s+(?!type\s)\{[^}]*\bquery\b[^}]*\}\s*from\s*["']@anthropic-ai\/claude-agent-sdk["']|import\s+\*\s+as\s+\w+\s+from\s*["']@anthropic-ai\/claude-agent-sdk["']|import\(\s*["']@anthropic-ai\/claude-agent-sdk["']\s*\)/g,
  "claude command string": /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*["'`]claude\b|\$\s*`\s*claude\b/g,
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
  "agent SDK query import": {
    hit: [
      'import { query } from "@anthropic-ai/claude-agent-sdk";',
      'import { type Options, query as q } from "@anthropic-ai/claude-agent-sdk";',
      'import * as sdk from "@anthropic-ai/claude-agent-sdk";',
      'const m = await import("@anthropic-ai/claude-agent-sdk");',
    ],
    miss: [
      'import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";',
      'import type { query } from "@anthropic-ai/claude-agent-sdk";',
      'import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";',
    ],
  },
  "claude command string": {
    hit: ['spawn("claude", ["-p"])', "execFileSync('claude', [])", "await $`claude -p ${x}`", "Bun.$`claude --version`"],
    miss: ['spawn("claudette")', "$`ls claude`"],
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
  "agent SDK query import|ai/connectors/claude-sdk.ts": 1,
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
