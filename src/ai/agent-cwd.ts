/**
 * Session home for muninn's own CLI agents.
 *
 * `spawnHaiku` runs `claude -p`, and the Claude CLI derives two separate things
 * from the process cwd: which folder under `~/.claude/projects/` the session
 * transcript lands in, and which CLAUDE.md / `.claude/` surface (skills, hooks,
 * settings) it auto-loads. The watcher gate + digest calls passed no cwd at all,
 * so they inherited muninn's repo root and got both wrong:
 *
 *  - **Noise.** 1043 of the 1825 transcripts in
 *    `~/.claude/projects/-Users-rune-source-private-muninn/` were watcher runs,
 *    drowning the developer's own sessions in claude-usage and `/resume`.
 *  - **Cost.** Measured on one real `watcher-anthropic` gate run (transcript
 *    `00b181e1-…`): `input_tokens: 10` against `cache_creation: 36849` +
 *    `cache_read: 19368` — a short classifier prompt paying to load muninn's
 *    38 KB CLAUDE.md, CLAUDE.local.md and repo `.claude/` on every tick.
 *
 * So these spawns get a dedicated empty directory outside the repo. Same trick
 * the benchmark judge already uses (`cwd: "/tmp"`, see `src/benchmarks/judge.ts`),
 * but per-bot and stable, so each bot's agent runs group into their own project
 * folder instead of one anonymous `-tmp` pile.
 *
 * Callers that pass an explicit cwd are untouched: the email watcher and the
 * memory/goal/schedule extractors run with `cwd: bots/<name>/` deliberately
 * (Gmail MCP discovery via the bot's `.mcp.json`, bot persona from its
 * CLAUDE.md) and keep it.
 */

import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getLog } from "../logging.ts";

const log = getLog("ai", "agent-cwd");

/** Directories already created this process — mkdir is cheap but not free per watcher tick. */
const ensured = new Set<string>();

/** Fallback bucket for spawns with no bot in hand (none today; defensive). */
const SHARED_BUCKET = "shared";

/**
 * Bot names come from folder names under `bots/`, so they're already tame — but
 * this value becomes a path segment, so anything outside the safe set collapses
 * to the shared bucket rather than escaping the root.
 */
function bucket(botName?: string): string {
  const name = botName?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9._-]*$/.test(name) && !name.includes("..") ? name : SHARED_BUCKET;
}

/** Root under which per-bot agent cwds live. `MUNINN_AGENT_CWD` overrides. */
export function agentCwdRoot(): string {
  const override = process.env.MUNINN_AGENT_CWD?.trim();
  return override ? resolve(override) : join(homedir(), ".muninn", "agent-cwd");
}

/**
 * The cwd a muninn-spawned `claude` process should run in — created on first use.
 *
 * On mkdir failure this degrades to the OS temp dir rather than throwing: a
 * watcher that can't classify is a worse outcome than a slightly less tidy
 * project folder, and temp still keeps the run out of the repo.
 */
export function resolveAgentCwd(botName?: string): string {
  const dir = join(agentCwdRoot(), bucket(botName));
  if (ensured.has(dir)) return dir;
  try {
    mkdirSync(dir, { recursive: true });
    ensured.add(dir);
    return dir;
  } catch (err) {
    log.warn("Could not create agent cwd {dir}, falling back to temp: {error}", {
      dir,
      error: err instanceof Error ? err.message : String(err),
    });
    return tmpdir();
  }
}
