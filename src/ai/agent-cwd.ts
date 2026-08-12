/**
 * Session home for muninn's own `claude -p` spawns.
 *
 * The Claude CLI derives two things from the process cwd: which folder under
 * `~/.claude/projects/` the session transcript lands in, and which CLAUDE.md /
 * `.claude/` surface it auto-loads. A cwd-less spawn inherited muninn's repo
 * root, so watcher runs filed their transcripts into the developer's own project
 * folder and paid ~18k prompt tokens per call to load muninn's CLAUDE.md
 * (measured — see the PR that added this module). They now run in a dedicated
 * empty dir outside the repo instead: the same trick as the bare `/tmp` the
 * benchmark judge used to hardcode, but per-caller and stable, so each caller's
 * runs group into their own project folder rather than one anonymous pile.
 *
 * Used unconditionally by `spawnHaiku` (`src/scheduler/executor.ts`) and by the
 * benchmark judge (`src/benchmarks/judge.ts`) — there is no longer any way for a
 * `spawnHaiku` caller to opt out. The callers that used to pass `bots/<name>/`
 * (email watcher, the memory/goal/schedule extractors, the prose reminders, the
 * research decomposer, fact-check extraction, wiki-remember, the devloop
 * classifier) sat INSIDE the repo, so the parent-directory walk loaded muninn's
 * own CLAUDE.md on every call — 33 900 cache_creation tokens, measured. They now
 * request what they actually needed from the bot folder explicitly instead:
 * `--mcp-config` via `SpawnHaikuOptions.botDir`, persona via `.system`.
 *
 * NOT used by the chat connector (`src/ai/executor.ts`) or `claude-sdk`, which
 * still run in `botConfig.dir` — a chat turn's tool surface genuinely wants the
 * bot folder, and its prompt is large enough that the CLAUDE.md load is a smaller
 * relative share. Out of scope here, deliberately.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getLog } from "../logging.ts";

const log = getLog("ai", "agent-cwd");

/** The muninn checkout — an agent cwd must never live inside it. */
const REPO_ROOT = resolve(import.meta.dir, "../..");

const DEFAULT_ROOT = join(homedir(), ".muninn", "agent-cwd");

/** Fallback bucket for spawns with no usable caller name. */
const SHARED_BUCKET = "shared";

/**
 * Every rejection and collapse below is a PERMANENT condition (a bad `.env`
 * line, a bot folder name), while the callers are watcher ticks — so an
 * unthrottled `log.warn` repeats forever at tick rate. Warn once per distinct
 * value, with a cap so a pathological caller can't grow the set without bound.
 */
const warned = new Set<string>();
const WARNED_MAX = 64;

function warnOnce(key: string, message: string, props: Record<string, unknown>): void {
  if (warned.has(key)) return;
  // Clear rather than stop admitting keys: a full set that keeps warning for every
  // NEW key would reinstate exactly the tick-rate flood this function prevents.
  if (warned.size >= WARNED_MAX) warned.clear();
  warned.add(key);
  log.warn(message, props);
}

/**
 * Names come from folder names under `bots/` (which discovery never
 * character-restricts) or from a hardcoded caller label — and the value becomes
 * a path segment. Anything outside the safe set collapses to the shared bucket:
 * loudly, because two collapsed bots would interleave in one transcript folder,
 * which is the confusion the per-caller split exists to prevent.
 */
function bucket(name?: string): string {
  const clean = name?.trim().toLowerCase() ?? "";
  if (/^[a-z0-9_][a-z0-9._-]*$/.test(clean) && !clean.includes("..")) return clean;
  if (clean) {
    warnOnce(`bucket:${clean}`, 'Name "{name}" is not path-safe — its agent sessions share the {bucket} cwd', {
      name, bucket: SHARED_BUCKET,
    });
  }
  return SHARED_BUCKET;
}

/**
 * Resolve symlinks in a path that may not exist yet: realpath the deepest
 * existing ancestor, then re-append the rest.
 *
 * `resolve()` alone is purely lexical, but the kernel resolves symlinks at
 * `chdir` time — so a symlink pointing into the checkout would give the spawned
 * CLI a real cwd inside the repo while every lexical check said otherwise.
 */
function realPathish(path: string): string | null {
  const tail: string[] = [];
  let head = path;
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch (err) {
      // Only ENOENT means "not created yet", which is normal for the leaf. EACCES /
      // ELOOP / ENOTDIR mean we cannot see where this path really points, so the
      // caller must treat it as unusable rather than trusting the lexical name.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return null;
      const parent = dirname(head);
      if (parent === head) return path;
      tail.push(basename(head));
      head = parent;
    }
  }
}

/**
 * Whether a path lands inside the muninn checkout.
 *
 * Case-folded on darwin/win32: the root filesystem here is case-insensitive
 * APFS, so `/Users/rune/source/private/MUNINN/agents` IS inside the checkout
 * even though a byte-wise prefix test says it isn't.
 */
function insideRepo(path: string): boolean {
  // Folded on platform, not on the volume: a case-SENSITIVE mac volume would refuse
  // a legitimately distinct case-variant root. Fail-safe direction, negligible impact.
  const fold = (p: string) =>
    process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p;
  const resolved = realPathish(path);
  const root = realPathish(REPO_ROOT);
  // Unresolvable ⇒ refuse: we cannot prove it lands outside the checkout.
  if (resolved === null || root === null) return true;
  const candidate = fold(resolved);
  const repo = fold(root);
  return candidate === repo || candidate.startsWith(repo + sep);
}

/**
 * Root under which per-caller agent cwds live. `MUNINN_AGENT_CWD` overrides it.
 *
 * Two classes of override are refused rather than honored, both because they
 * silently reinstate the symptoms this module exists to remove:
 *  - **Non-absolute.** A relative value resolves against `process.cwd()`, which
 *    is the repo root for `bun run dev` but something else entirely under
 *    launchd / Docker `WORKDIR` / `bun --cwd` — so it is unpredictable, not just
 *    in-repo-risky. No caller has a use for a relative agent root. (This also
 *    catches an unexpanded `~/.muninn/...` written literally into `.env`.)
 *  - **Inside the checkout**, symlinks and filesystem case included.
 */
export function agentCwdRoot(): string {
  const override = process.env.MUNINN_AGENT_CWD?.trim();
  if (!override) return DEFAULT_ROOT;

  if (!isAbsolute(override)) {
    warnOnce(
      `rel:${override}`,
      "MUNINN_AGENT_CWD={override} is not an absolute path — ignoring it and using {fallback}. " +
        "A relative value resolves against the process cwd, which differs between `bun run dev` and a service unit.",
      { override, fallback: DEFAULT_ROOT },
    );
    return DEFAULT_ROOT;
  }

  const abs = resolve(override);
  if (dirname(abs) === abs) {
    // The filesystem root. Harmless as a normal user (mkdir EACCES ⇒ degrade), but
    // muninn also ships a docker-compose path running as root, where this would
    // create real top-level `/jarvis`, `/shared`, … dirs and make the CLI treat `/`
    // as the project.
    warnOnce(`root:${abs}`, "MUNINN_AGENT_CWD={override} is the filesystem root — ignoring it and using {fallback}.", {
      override, fallback: DEFAULT_ROOT,
    });
    return DEFAULT_ROOT;
  }
  if (insideRepo(abs)) {
    warnOnce(
      `repo:${abs}`,
      "MUNINN_AGENT_CWD={override} resolves inside the muninn checkout ({abs}) — ignoring it and using {fallback}, " +
        "otherwise agent sessions would reload the repo CLAUDE.md and land in the repo's own project folder.",
      { override, abs, fallback: DEFAULT_ROOT },
    );
    return DEFAULT_ROOT;
  }
  return abs;
}

/**
 * The one temp dir this process degrades to, reused while it exists.
 *
 * Deliberately memoized even though {@link resolveAgentCwd} is not: mkdir
 * failure is a PERSISTENT condition (unwritable `$HOME`, read-only volume), so
 * an un-memoized degrade would mint a fresh temp dir — and a fresh
 * `~/.claude/projects/` folder — on every watcher tick, which is worse noise
 * than the problem this module fixes. The `existsSync` re-check keeps it honest
 * if the dir is reaped.
 */
let degradeDir: string | undefined;

function degradedCwd(): string {
  if (degradeDir && existsSync(degradeDir)) return degradeDir;
  try {
    degradeDir = mkdtempSync(join(tmpdir(), "muninn-agent-"));
    return degradeDir;
  } catch {
    // Nothing left to try; bare $TMPDIR at least exists.
    return tmpdir();
  }
}

/**
 * The cwd a muninn-spawned `claude` process should run in — created on first use.
 *
 * The happy path is deliberately un-memoized: the dir can vanish under a
 * long-lived process (a `~/.muninn` cleanup, a reaped `$TMPDIR`), and a cached
 * path would then make every spawn fail with ENOENT *before* the caller's
 * try/catch, so a watcher would look like it made no model call at all. One
 * `mkdirSync` per watcher tick is not a cost worth that failure mode.
 *
 * On mkdir failure it degrades to {@link degradedCwd} rather than throwing: a
 * watcher that can't classify is worse than a less tidy project folder.
 */
export function resolveAgentCwd(name?: string): string {
  const dir = join(agentCwdRoot(), bucket(name));
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch (err) {
    warnOnce(
      `mkdir:${dir}`,
      "Could not create agent cwd {dir}, falling back to the shared temp dir {fallback} — " +
        "while this lasts, ALL callers share one cwd and one ~/.claude/projects/ folder: {error}",
      { dir, fallback: degradedCwd(), error: err instanceof Error ? err.message : String(err) },
    );
    return degradedCwd();
  }
}
