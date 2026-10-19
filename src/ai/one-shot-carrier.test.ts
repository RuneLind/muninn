/**
 * The carrier for model-call entry points typecheck cannot see.
 *
 * `executeOneShot`, `tracedOneShot` and `runCaptureOneShot` take a REQUIRED
 * `toolSurface`, so a new caller of those fails typecheck until it states its
 * surface. A caller that goes AROUND them — straight to `resolveConnector`,
 * to `executeClaudePrompt`, to a connector module's `executePrompt`, or to a
 * hand-built `["claude", …]` argv — carries no surface at all. This test pins
 * the exact set of such sites in `src/` (test files excluded): a new one fails
 * here, and so does a pattern that stops matching an allowed one, so a dead
 * regex cannot pass.
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
