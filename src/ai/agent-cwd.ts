/**
 * Session home for muninn's own `claude -p` spawns.
 *
 * The Claude CLI derives two things from the process cwd: which folder under
 * `~/.claude/projects/` the session transcript lands in, and which CLAUDE.md /
 * `.claude/` surface it auto-loads. A cwd-less spawn inherited muninn's repo
 * root, so watcher runs filed their transcripts into the developer's own project
 * folder and paid ~18k prompt tokens per call to load muninn's CLAUDE.md
 * (measured — see the PR that added this module). They now run in a dedicated
 * empty dir outside the repo instead: the same trick as `cwd: "/tmp"` in
 * `src/benchmarks/judge.ts`, but per-bot and stable, so each bot's runs group
 * into their own project folder rather than one anonymous pile.
 *
 * Callers that pass an explicit cwd keep it — the email watcher needs
 * `bots/<name>/` for Gmail MCP discovery, the extractors for the bot persona.
 * Those dirs are INSIDE the repo, so they still load the repo's CLAUDE.md via
 * parent-directory walk; only their transcript folder differs. Cutting that
 * needs `--mcp-config` + `--system-prompt` (what `src/ai/executor.ts` does for
 * the chat connector), not a cwd change.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { getLog } from "../logging.ts";

const log = getLog("ai", "agent-cwd");

/** The muninn checkout — an agent cwd must never live inside it. */
const REPO_ROOT = resolve(import.meta.dir, "../..");

const DEFAULT_ROOT = join(homedir(), ".muninn", "agent-cwd");

/** Fallback bucket for spawns with no usable bot name. */
const SHARED_BUCKET = "shared";

/**
 * Bot names come from folder names under `bots/`, which discovery never
 * character-restricts — and this value becomes a path segment. Anything outside
 * the safe set collapses to the shared bucket (loudly: two collapsed bots would
 * interleave in one transcript folder, which is the confusion the per-bot split
 * exists to prevent).
 */
function bucket(botName?: string): string {
  const name = botName?.trim().toLowerCase() ?? "";
  if (/^[a-z0-9_][a-z0-9._-]*$/.test(name) && !name.includes("..")) return name;
  if (name) {
    log.warn('Bot name "{botName}" is not path-safe — its agent sessions share the {bucket} cwd', {
      botName, bucket: SHARED_BUCKET,
    });
  }
  return SHARED_BUCKET;
}

/**
 * Root under which per-bot agent cwds live. `MUNINN_AGENT_CWD` overrides it.
 *
 * A relative override resolves against `process.cwd()` — which for muninn IS the
 * repo root — so `MUNINN_AGENT_CWD=.agents` would silently reinstate both
 * symptoms this module exists to remove. Any override resolving inside the
 * checkout is therefore refused rather than honored.
 */
export function agentCwdRoot(): string {
  const override = process.env.MUNINN_AGENT_CWD?.trim();
  if (!override) return DEFAULT_ROOT;
  const abs = resolve(override);
  if (abs === REPO_ROOT || abs.startsWith(REPO_ROOT + sep)) {
    log.warn(
      "MUNINN_AGENT_CWD={override} resolves inside the muninn checkout ({abs}) — ignoring it and using {fallback}, " +
        "otherwise agent sessions would reload the repo CLAUDE.md and land in the repo's own project folder.",
      { override, abs, fallback: DEFAULT_ROOT },
    );
    return DEFAULT_ROOT;
  }
  return abs;
}

/**
 * The cwd a muninn-spawned `claude` process should run in — created on first use.
 *
 * Deliberately un-memoized: the dir can vanish under a long-lived process (a
 * `~/.muninn` cleanup, or a `$TMPDIR` override that macOS reaps), and a cached
 * path would then make every spawn fail with ENOENT *before* the caller's
 * try/catch, so a watcher would look like it made no model call at all. One
 * `mkdirSync` per watcher tick is not a cost worth that failure mode.
 *
 * On mkdir failure it degrades to a private temp dir rather than throwing: a
 * watcher that can't classify is worse than a less tidy project folder. Still a
 * fresh dir per degrade, never bare `$TMPDIR` — the CLI would treat the whole
 * temp dir as the project and read whatever another tool dropped there.
 */
export function resolveAgentCwd(botName?: string): string {
  const dir = join(agentCwdRoot(), bucket(botName));
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch (err) {
    log.warn("Could not create agent cwd {dir}, falling back to a temp dir: {error}", {
      dir,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      return mkdtempSync(join(tmpdir(), "muninn-agent-"));
    } catch {
      return tmpdir();
    }
  }
}

/**
 * Resolve the cwd for one `claude -p` spawn: the caller's explicit choice wins,
 * otherwise muninn's agent home. Exported as its own function so the precedence
 * is pinned by a test — inverting it inside the spawn call would break the email
 * watcher's Gmail MCP discovery and the extractors' persona, invisibly.
 */
export function spawnCwd(explicitCwd: string | undefined, botName?: string): string {
  return explicitCwd ?? resolveAgentCwd(botName);
}
