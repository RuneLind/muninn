/**
 * `wiki-stale.ts --handoff`: checkpoint-handoff's Stale step as two calls,
 * with the session's own fixes between them.
 *
 *   bun --no-env-file scripts/wiki-stale.ts --handoff --pages <abs path>… [--session <id>]
 *       [--wiki <name>] [--main <abs dir>] [--as-of YYYY-MM-DD] [--base-url <url>]
 *   … the same, plus --check, once the session committed its fixes.
 *
 * Pages are absolute paths (or `~/…`) in the main checkout or a worktree; a
 * relative one is refused with a line, since the caller's cwd is not the
 * wiki's. git maps each to its wiki-relative path and its repo's main
 * checkout (`--git-common-dir`), so a worktree page and its main-checkout
 * copy are one page. The wiki's name is the main checkout's folder name
 * (`mimir`, `melosys-kode-wiki`) unless `--wiki` names it; `--main`
 * overrides the main checkout. Pages in several repos are several wikis, each
 * with its own gate and `Stale:` line.
 *
 * - First call: per wiki, the gate (on the default branch: `git pull
 *   --ff-only <remote> <default>`, never a stash, reset or switch; each page
 *   committed / uncommitted / carried / NOT carried / deleted), the fix path
 *   that fits the gate, the free report, then «fix by hand»: the hits and the
 *   To-check pages on the session's own pages, and nothing else. Nothing is
 *   saved between the calls.
 * - `--check`: the gate again, the reports (not printed), then Check and the
 *   sends when the gate passes and at most {@link COSTED_PAGE_CAP} pages would
 *   spend model calls (a page whose To-check verdicts are all cached costs
 *   nothing and is checked whatever the count), then one `Stale:` line per
 *   wiki, ready to paste, its `to check:` part with each reason in brackets:
 *   what is open now (own items still not settled, own pages the reports did
 *   not read the session's text of, To-check pages), never what was fixed.
 *   Once the reports hit their deadline only the cached pages Check (the cap
 *   cannot be counted on missing reports), and no Check starts that could run
 *   past the printed bound.
 *
 * Exits 0 always (D13), unless a SIGINT, SIGTERM or SIGHUP stops it (128 +
 * the signal, its git calls ended first): every outcome, a usage error and a missing git
 * included, ends in a `Stale:` line. git runs through {@link runGit}: no
 * shell, a bound per call, no prompt (`GIT_TERMINAL_PROMPT=0`; ssh in batch
 * mode unless the user configured their own ssh command).
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  CHECK_PAGE_DEADLINE_MS,
  RUN_DEADLINE_MS,
  SEND_DEADLINE_MS,
  isOwnPage,
  newLedger,
  parseStaleArgs,
  runWikiStale,
  verdictTag,
  type FetchJson,
  type PostJson,
  type PostSse,
  type StaleLedger,
} from "./wiki-stale.ts";

type Json = Record<string, any>;

/** Pages that may spend model calls in one handoff Check (each ≤10 calls, ≤5 min). */
export const COSTED_PAGE_CAP = 3;
/** The route's own cap on one page's calls (`CHECK_MAX_CALLS`). */
const CALLS_PER_PAGE = 10;
/** `git pull`: a network call. Every other git call reads local files. */
export const PULL_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 10_000;
/** The run bound's margin for local work between its timed steps (parsing, printing): a choice, not a measurement. */
const STEP_MARGIN_MS = 2_000;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** git is not on PATH. */
  missing?: boolean;
  timedOut?: boolean;
}
export type Git = (args: string[], cwd: string, timeoutMs?: number) => Promise<GitResult>;

/** Repo-aiming variables a caller (a git hook, another repo's shell) can leak; each call finds its repo from `cwd`. */
const REPO_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX"];
/** After the SIGTERM, how long git may take to remove its lock files and exit before the group gets SIGKILL. */
const TERM_GRACE_MS = 1_000;
/** After the SIGKILL, how long the pipes may take to close before the call returns without the rest. */
const PIPE_GRACE_MS = 500;
/** Process groups of the git calls still running: a signal or exit of this process ends them too. */
const liveGroups = new Set<number>();
const signalGroup = (pgid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    return false;
  }
};
/** SIGTERM every live group, wait up to TERM_GRACE_MS for them to go (synchronously: an exit handler cannot await), then SIGKILL the rest. */
function endLiveGroups() {
  const groups = [...liveGroups];
  liveGroups.clear();
  for (const g of groups) signalGroup(g, "SIGTERM");
  const tick = new Int32Array(new SharedArrayBuffer(4));
  for (const end = Date.now() + TERM_GRACE_MS; Date.now() < end && groups.some((g) => signalGroup(g, 0 as any)); ) Atomics.wait(tick, 0, 0, 20);
  for (const g of groups) signalGroup(g, "SIGKILL");
}
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", endLiveGroups);
  for (const [sig, n] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]] as const) process.on(sig, () => process.exit(128 + n));
}
/** The ssh a network call gets when the user configured none. */
const BATCH_SSH = "ssh -o BatchMode=yes -o ConnectTimeout=10";
const NETWORK_VERBS = new Set(["pull", "fetch", "push", "ls-remote", "clone"]);
/** The subcommand, past any leading `-c k=v` / `-C dir` options. */
function verbOf(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c" || args[i] === "-C") i++;
    else if (!args[i]!.startsWith("-")) return args[i];
  }
  return undefined;
}

/**
 * Run git without a shell, bounded, and never waiting on a prompt. git runs
 * in its own process group, so a timeout ends `git fetch`, a remote helper
 * and ssh with it: SIGTERM first, so git removes its lock files, then SIGKILL
 * after {@link TERM_GRACE_MS}. The call returns by the bound plus both graces
 * even if a process that left the group still holds a pipe open. A SIGINT,
 * SIGTERM or SIGHUP to this process, or its exit, ends every running call's
 * group the same way first.
 */
export function gitRunner(bin = "git", baseEnv: Record<string, string | undefined> = process.env): Git {
  const run: Git = async (args, cwd, timeoutMs = GIT_TIMEOUT_MS) => {
    const env: Record<string, string | undefined> = { ...baseEnv, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
    for (const k of REPO_ENV) delete env[k];
    // The user's own ssh (GIT_SSH_COMMAND, core.sshCommand, GIT_SSH) wins and runs as configured; only plain ssh gets batch mode.
    if (NETWORK_VERBS.has(verbOf(args) ?? "") && !env.GIT_SSH_COMMAND && !env.GIT_SSH) {
      const cfg = await run(["config", "--get", "core.sshCommand"], cwd);
      if (cfg.code !== 0 || !cfg.stdout.trim()) env.GIT_SSH_COMMAND = BATCH_SSH;
    }
    hookExit();
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([bin, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env, detached: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { code: -1, stdout: "", stderr: msg, missing: /ENOENT|not found|No such file/i.test(msg) };
    }
    const pgid = proc.pid;
    liveGroups.add(pgid);
    const kill = (sig: NodeJS.Signals) => signalGroup(pgid, sig) || proc.kill(sig);
    let timedOut = false;
    let release: () => void = () => {};
    const released = new Promise<void>((r) => (release = r));
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      // Not cleared when the call returns: a group member that outlived git's exit still gets the SIGKILL.
      setTimeout(() => {
        if (liveGroups.delete(pgid)) kill("SIGKILL");
        setTimeout(release, PIPE_GRACE_MS);
      }, TERM_GRACE_MS);
    }, timeoutMs);
    const chunks = { stdout: "", stderr: "" };
    const drain = async (name: "stdout" | "stderr") => {
      const dec = new TextDecoder();
      try {
        const reader = (proc[name] as ReadableStream<Uint8Array>).getReader();
        for (let r = await reader.read(); !r.done; r = await reader.read()) chunks[name] += dec.decode(r.value, { stream: true });
      } catch {
        // A pipe torn down by the kill: keep what arrived.
      }
    };
    try {
      const drained = Promise.all([drain("stdout"), drain("stderr")]);
      const code = await proc.exited;
      await Promise.race([drained, released]);
      return { code: timedOut ? -1 : code, stdout: chunks.stdout, stderr: chunks.stderr, ...(timedOut ? { timedOut } : {}) };
    } finally {
      clearTimeout(timer);
      if (!timedOut) liveGroups.delete(pgid);
    }
  };
  return run;
}

const home = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p);
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
/**
 * Git's error in its stderr: the error:/fatal: line, else the first line that is not a hint.
 * Git's generic «could not read from remote» epilogue is no error line: ssh's own line before it names the cause.
 */
const gitError = (s: string) => {
  const ls = s.split("\n").map((l) => l.trim()).filter(Boolean);
  return ls.find((l) => /^(error|fatal):/i.test(l) && !/^fatal: could not read from remote repository/i.test(l)) ?? ls.find((l) => !/^hint:/i.test(l)) ?? "";
};

/** One page the session names, mapped through git. */
export interface PageRef {
  given: string;
  abs: string;
  /** Wiki-relative, posix. */
  rel: string;
  /** The repo's main checkout (real path). */
  main: string;
  /** The checkout the path is in, when it is not the main one. */
  worktree?: string;
  exists: boolean;
}

/** Map an absolute page path to its wiki-relative path and its repo's main checkout. */
export async function resolvePage(given: string, git: Git): Promise<PageRef | { given: string; skip: string }> {
  const abs = home(given.trim());
  if (!path.isAbsolute(abs)) return { given, skip: "not an absolute path" };
  // A deleted page (or its deleted folder): ask git from the nearest folder that exists.
  let anc = path.dirname(abs);
  while (!existsSync(anc) && anc !== path.dirname(anc)) anc = path.dirname(anc);
  const r = await git(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], anc);
  if (r.missing) return { given, skip: "git not found" };
  if (r.code !== 0) return { given, skip: "not in a git checkout" };
  const [top, common] = r.stdout.trim().split("\n");
  if (!top || !common) return { given, skip: "not in a git checkout" };
  const topReal = real(top);
  const rel = path.relative(topReal, path.join(real(anc), path.relative(anc, abs))).split(path.sep).join("/");
  if (!rel || rel.startsWith("..")) return { given, skip: "not in a git checkout" };
  const main = path.basename(common) === ".git" ? real(path.dirname(common)) : topReal;
  return { given, abs, rel, main, ...(topReal !== main ? { worktree: topReal } : {}), exists: existsSync(abs) && statSync(abs).isFile() };
}

export type PageState = "committed" | "uncommitted" | "carried" | "not-carried" | "main-uncommitted" | "deleted" | "deleted-uncommitted" | "missing";
export interface Gate {
  main: string;
  branch?: string;
  defaultBranch?: string;
  remote?: string;
  /** The pull's outcome or why there was none. */
  note?: string;
  /** Why Check may not run; undefined when it may. */
  skip?: string;
  /** A skip for the whole checkout (branch, pull, not a checkout): no page's report reads the session's text. */
  wideSkip?: string;
  /** What the session does to land its fixes. */
  fixPath: string;
  /** Each worktree the fix path carries from, and its branch (undefined: detached HEAD, named by its short sha). */
  carries?: { worktree: string; branch?: string; sha?: string }[];
  lines: string[];
  pages: (PageRef & { state: PageState })[];
}

/**
 * The gate for one main checkout: pull on the default branch, then each
 * page's state. Pulls only (`--ff-only`); never stashes, resets or switches.
 */
export async function runGate(main: string, pages: PageRef[], git: Git, opts: { pull?: boolean } = {}): Promise<Gate> {
  const lines: string[] = [];
  const g: Gate = { main, fixPath: "", lines, pages: [] };
  const skip = (why: string) => (g.skip ??= why);
  const top = await git(["rev-parse", "--show-toplevel"], main);
  if (top.missing) {
    g.wideSkip = skip("git not found");
    g.fixPath = `fix your own lines by hand in ${main} and commit them with your own git`;
    lines.push("gate: git not found — Check skip");
    return g;
  }
  if (top.code !== 0) {
    g.wideSkip = skip(`${main} is not a git checkout`);
    g.fixPath = "fix your own lines by hand";
    lines.push(`gate: Check skip — ${g.skip}`);
    return g;
  }
  const ok = async (args: string[]) => (await git(args, main)).code === 0;
  const out = async (args: string[]) => {
    const r = await git(args, main);
    return r.code === 0 ? r.stdout.trim() : "";
  };
  g.branch = (await out(["symbolic-ref", "--short", "-q", "HEAD"])) || undefined;
  const remotes = (await out(["remote"])).split("\n").filter(Boolean);
  g.remote = remotes.includes("origin") ? "origin" : remotes[0];
  let def = g.remote ? (await out(["symbolic-ref", "--short", "-q", `refs/remotes/${g.remote}/HEAD`])).replace(`${g.remote}/`, "") : "";
  if (!def) {
    for (const b of ["main", "master"]) if (!def && (await ok(["show-ref", "--verify", "-q", `refs/heads/${b}`]))) def = b;
  }
  if (!def) def = (await out(["config", "init.defaultBranch"])) || "main";
  g.defaultBranch = def;
  const onDefault = g.branch === def;
  if (!onDefault) {
    skip(`main checkout on ${g.branch ?? "a detached HEAD"}, not ${def}`);
    g.note = g.skip;
  } else if (!g.remote) {
    g.note = "no remote, nothing to pull";
  } else if (opts.pull !== false) {
    const before = await out(["rev-parse", "HEAD"]);
    // Never stash another session's edits, never rebase: the flags beat merge.autoStash, rebase.autoStash and pull.rebase.
    const r = await git(["-c", "merge.autoStash=false", "-c", "rebase.autoStash=false", "pull", "--ff-only", "--no-rebase", "--no-autostash", "--quiet", g.remote, def], main, PULL_TIMEOUT_MS);
    const err = gitError(r.stderr) || `exit ${r.code}`;
    if (r.code === 0) {
      const n = before ? Number(await out(["rev-list", "--count", `${before}..HEAD`])) || 0 : 0;
      g.note = n ? `pulled ${n} commit(s) from ${g.remote}/${def}` : `up to date with ${g.remote}/${def}`;
    } else if (!r.timedOut && AUTH_FAILURE.test(r.stderr)) {
      g.note = `not authorized — could not authenticate to ${g.remote} (${err}); the main checkout is as last pulled`;
    } else if (r.timedOut || /could not resolve|unable to access|could not read from remote|connection (refused|timed out)|network is unreachable|operation timed out/i.test(r.stderr)) {
      g.note = `offline — could not reach ${g.remote} (${r.timedOut ? `no answer in ${PULL_TIMEOUT_MS / 1000} s` : err}); the main checkout is as last pulled`;
    } else if (/couldn't find remote ref|no such ref/i.test(r.stderr)) {
      g.note = `no upstream — ${g.remote} has no branch ${def}; nothing to pull`;
    } else {
      skip(`git pull --ff-only refused (${err})`);
      g.note = g.skip;
    }
  }
  if (g.skip) g.wideSkip = g.skip;
  lines.push(`gate: ${g.note ?? `on ${def}`}`);

  /**
   * Status, and the working bytes against HEAD's blob: skip-worktree, assume-unchanged and an ignore rule hide an
   * edit from status, not from Check. `hash-object` applies the path's clean filters, as `git add` would.
   */
  const dirtyIn = async (cwd: string, rel: string, exists: boolean) => {
    const run = async (args: string[]) => {
      const r = await git(args, cwd);
      return r.code === 0 ? r.stdout.trim() : "";
    };
    if ((await run(["status", "--porcelain", "--", rel])) !== "") return true;
    const blob = await run(["rev-parse", "-q", "--verify", `HEAD:${rel}`]);
    if (!exists) return blob !== "";
    const hash = await run(["hash-object", "--", rel]);
    return !hash || hash !== blob;
  };
  /** Any uncommitted tracked edit in the main checkout, or a page's main copy that differs from HEAD. */
  let mainEdits = (await out(["status", "--porcelain", "--untracked-files=no"])) !== "";
  for (const p of pages) {
    let state: PageState;
    if (!p.worktree) {
      const dirty = await dirtyIn(main, p.rel, p.exists);
      mainEdits ||= dirty;
      if (p.exists) state = dirty ? "uncommitted" : "committed";
      else if (dirty) state = "deleted-uncommitted";
      else state = (await out(["log", "-1", "--format=%h", "--", p.rel])) ? "deleted" : "missing";
    } else {
      // Carried means the worktree's committed text is the main checkout's clean, committed text: what Check reads.
      const wtOut = async (args: string[]) => {
        const r = await git(args, p.worktree!);
        return r.code === 0 ? r.stdout.trim() : "";
      };
      const wtDirty = await dirtyIn(p.worktree, p.rel, p.exists);
      const mainDirty = await dirtyIn(main, p.rel, existsSync(path.join(main, p.rel)));
      mainEdits ||= mainDirty;
      const wtBlob = await wtOut(["rev-parse", "-q", "--verify", `HEAD:${p.rel}`]);
      const mainBlob = await out(["rev-parse", "-q", "--verify", `HEAD:${p.rel}`]);
      if (wtDirty) state = p.exists ? "uncommitted" : "deleted-uncommitted";
      else if (!p.exists) state = mainBlob || existsSync(path.join(main, p.rel)) ? "not-carried" : (await wtOut(["log", "-1", "--format=%h", "--", p.rel])) ? "deleted" : "missing";
      else if (mainDirty) state = "main-uncommitted";
      else state = wtBlob && wtBlob === mainBlob ? "carried" : "not-carried";
    }
    g.pages.push({ ...p, state });
    const where = p.worktree ? ` (worktree ${p.worktree})` : "";
    const say: Record<PageState, string> = {
      committed: `committed ${p.rel}`,
      uncommitted: `uncommitted ${p.rel}${where} — commit your own edits to it path-scoped before --check, never hunks you did not make`,
      carried: `carried ${p.rel}${where}`,
      "not-carried": `NOT carried ${p.rel}${where} — the main checkout lacks your text`,
      "main-uncommitted": `NOT carried ${p.rel}${where} — the main copy has uncommitted edits, which Check would read instead of your commit`,
      deleted: `deleted ${p.rel}${where} — not a page to Check`,
      "deleted-uncommitted": `deleted ${p.rel}${where}, uncommitted — commit the deletion before --check`,
      missing: `no such page ${p.rel} — not in the checkout or its history`,
    };
    lines.push(`gate: ${say[state]}`);
    if (state === "uncommitted" || state === "deleted-uncommitted") skip(`uncommitted edits on ${p.rel}`);
    if (state === "not-carried") skip(`the main checkout lacks your text of ${p.rel}`);
    if (state === "main-uncommitted") skip(`uncommitted edits on the main copy of ${p.rel}`);
  }
  const froms = [...new Set(g.pages.filter((p) => p.worktree && ["not-carried", "uncommitted", "deleted-uncommitted"].includes(p.state)).map((p) => p.worktree!))];
  for (const from of froms) {
    const b = (await git(["symbolic-ref", "--short", "-q", "HEAD"], from)).stdout.trim();
    const sha = b ? "" : (await git(["rev-parse", "--short", "HEAD"], from)).stdout.trim();
    (g.carries ??= []).push({ worktree: from, ...(b ? { branch: b } : {}), ...(sha ? { sha } : {}) });
  }
  // Commits on the default branch not on the remote: a worktree's push would leave the main checkout unable to pull.
  const ahead = g.remote && onDefault ? Number(await out(["rev-list", "--count", `refs/remotes/${g.remote}/${def}..HEAD`])) || 0 : 0;
  g.fixPath = fixPath(g, mainEdits, ahead > 0);
  lines.push(g.skip ? `gate: Check skip — ${g.skip}` : "gate: Check may run");
  lines.push(`fix path: ${g.fixPath}`);
  return g;
}

/**
 * A pull failure that is the credentials, not the network: ssh's key or password refusal, host keys, https logins,
 * a 401/403, a repository the login cannot see. A bare «Permission denied» is a local file git cannot write: refused.
 */
const AUTH_FAILURE = /permission denied \(|permission denied, please try again|host key verification failed|authentication failed|could not read (username|password)|returned error: 40[13]|repository not found|permission to \S+ denied to /i;

/** Quote a word for a POSIX shell when it needs it. */
export const shq = (s: string) => (/^[A-Za-z0-9_\/.@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

const LABEL: Record<PageState, string> = {
  committed: "committed",
  uncommitted: "uncommitted",
  carried: "carried",
  "not-carried": "not carried",
  "main-uncommitted": "main copy uncommitted",
  deleted: "deleted",
  "deleted-uncommitted": "deleted, uncommitted",
  missing: "missing",
};

/**
 * Where the session lands its own fixes, given the gate. A runnable carry is printed in one cell only: the main
 * checkout has no uncommitted tracked edit and no unpushed commit, no session page is in it, and exactly one
 * worktree needs a carry. Every other cell lists the pages' states and the by-hand line. No printed text rebases,
 * stashes, resets or forces, and none tells the session to commit edits it did not make.
 */
function fixPath(g: Gate, mainEdits: boolean, mainAhead: boolean): string {
  const def = g.defaultBranch ?? "main";
  const m = shq(g.main);
  if (g.branch !== def) {
    // Check reads the main checkout, which stays where it is; the fixes still land on the default branch.
    return g.remote
      ? `fix in a worktree: git -C ${m} worktree add <dir> ${g.remote}/${def}; commit there, git push ${g.remote} HEAD:${def}. Check skips until ${m} is back on ${def}`
      : `fix in a worktree on ${def}: git -C ${m} worktree add <dir> ${def}; commit there (no remote: the commit moves ${def} itself). Check skips until ${m} is back on ${def}`;
  }
  if (g.remote && g.skip?.startsWith("git pull")) {
    return `fix in a worktree: git -C ${m} worktree add <dir> ${g.remote}/${def}; commit there, git push ${g.remote} HEAD:${def}. Check skips until ${m} pulls cleanly`;
  }
  const byHand = `carry your commits into ${m} by hand (merge or cherry-pick), commit only your own edits, then rerun --handoff`;
  const notes = g.pages
    .filter((p) => p.state === "main-uncommitted")
    .map((p) => `the main copy of ${p.rel} holds uncommitted edits, probably another session's: Check skips it; leave them, and rerun once that session has committed, or list ${p.rel} in your resume prompt`);
  const carries = g.carries ?? [];
  const mainPages = g.pages.filter((p) => !p.worktree);
  if (!carries.length) {
    if (!mainPages.length && g.pages.length) return notes.length ? notes.join("; ") : `nothing to carry into ${m}`;
    const base = g.remote
      ? `commit your fixes path-scoped in ${m}, then push ${def}; this also pushes any other commits on ${def} that are not pushed yet — check git -C ${m} log ${g.remote}/${def}..${def} first`
      : `commit your fixes path-scoped in ${m} (no remote, nothing to push)`;
    return [base, ...notes].join("; ");
  }
  const named = (c: (typeof carries)[number]) => `worktree ${shq(c.worktree)} (${c.branch ? `branch ${c.branch}` : `detached HEAD: ${c.sha ?? "?"}`})`;
  if (carries.length === 1 && !mainEdits && !mainAhead && !mainPages.length) {
    const c = carries[0]!;
    const w = shq(c.worktree);
    // A detached worktree's HEAD moves when the session commits its fixes, so the merge reads it at run time.
    const head = c.branch ? shq(c.branch) : `"$(git -C ${w} rev-parse HEAD)"`;
    const carry = g.remote
      ? `${named(c)}: commit your fixes path-scoped there, then git -C ${w} push ${g.remote} HEAD:${def}; the --check call pulls it into ${m}`
      : `${named(c)}: commit your fixes path-scoped there, then git -C ${m} merge --ff-only --no-autostash ${head}`;
    return `${carry}; if git refuses (any reason: not a fast-forward, a hook, a protected branch, local edits), ${byHand}`;
  }
  // Any other cell has no carry that is safe to print: list what is where, then the by-hand line.
  const list = (ps: typeof g.pages) => ps.map((p) => `${p.rel} ${LABEL[p.state]}`).join(", ");
  const steps: string[] = [];
  if (mainPages.length) steps.push(`main checkout ${m}: ${list(mainPages)}`);
  const wts = [...new Set(g.pages.filter((p) => p.worktree).map((p) => p.worktree!))];
  for (const w of wts) {
    const c = carries.find((x) => x.worktree === w);
    steps.push(`${c ? named(c) : `worktree ${shq(w)}`}: ${list(g.pages.filter((p) => p.worktree === w))}`);
  }
  if (mainEdits && !notes.length) steps.push(`${m} holds uncommitted edits: leave any you did not make`);
  if (mainAhead) steps.push(`${def} in ${m} has commits not on ${g.remote}`);
  steps.push(...notes, byHand);
  return steps.join("; ");
}

/** One thing the session fixes by hand on its own pages. */
export interface OwnItem {
  kind: "hit" | "toCheck";
  page: string;
  /** hit: the status line's text and target; toCheck: the changed page. */
  text: string;
  target: string;
  line: number;
  /** What the reports, and on `--check` this run's Check, say of it. `settled` asks nothing of the session. */
  state: "stale" | "unconfirmed" | "unsure" | "unchecked" | "settled";
}
/** Tags that ask nothing of the session. */
const SETTLED = new Set(["true", "not-status", "fixed"]);
const stateOf = (verdict: unknown, none: OwnItem["state"]): OwnItem["state"] =>
  typeof verdict !== "string" ? none : SETTLED.has(verdict) ? "settled" : verdict === "unsure" ? "unsure" : "stale";

/**
 * The hits and To-check pages on the run's own pages (D12), settled ones
 * included. A hit with no confirmation is stale; an own To-check page takes
 * this run's Check verdict over the report's cached one.
 */
export function ownItems(reports: Json[], isOwn: (rel: string) => boolean, checks: StaleLedger["checks"] = {}): OwnItem[] {
  const items: OwnItem[] = [];
  for (const r of reports) {
    for (const h of r.hits ?? []) {
      const c = h.confirmation;
      const state = c === "unconfirmed" ? "unconfirmed" : stateOf(c && typeof c === "object" ? c.verdict : undefined, "stale");
      items.push({ kind: "hit", page: r.page.relPath, text: String(h.text ?? ""), target: h.target, line: h.line, state });
    }
    for (const l of r.buckets?.linking ?? []) {
      if (l.bucket !== "toCheck" || !isOwn(l.relPath)) continue;
      const checked = checks[r.page.relPath]?.verdicts.find((v) => v.relPath === l.relPath)?.verdict;
      const state = stateOf(checked ?? l.verdict?.verdict, "unchecked");
      items.push({ kind: "toCheck", page: l.relPath, text: "", target: r.page.relPath, line: l.passages?.find((p: Json) => p.claim)?.line ?? 0, state });
    }
  }
  return items;
}
const ownLabel = (i: OwnItem) => (i.kind === "hit" ? `${i.state} status line L${i.line}, yours` : `${i.state}, yours`);

/** A To-check page Check would call the model for: no verdict on its current passage. */
const uncached = (r: Json) => (r.buckets?.linking ?? []).filter((l: Json) => l.bucket === "toCheck" && !l.verdict);
const toCheckOf = (r: Json) => (r.buckets?.linking ?? []).filter((l: Json) => l.bucket === "toCheck");

/** Which pages Check runs on: every changed page whose To-check verdicts are all cached, and the costed ones while they fit the cap. */
export function planChecks(reports: Json[], cap = COSTED_PAGE_CAP): { check: string[]; costed: string[]; free: string[]; overCap: boolean } {
  const withToCheck = reports.filter((r) => toCheckOf(r).length);
  const costed = withToCheck.filter((r) => uncached(r).length).map((r) => r.page.relPath as string);
  const free = withToCheck.filter((r) => !uncached(r).length).map((r) => r.page.relPath as string);
  const overCap = costed.length > cap;
  return { check: overCap ? free : [...free, ...costed], costed, free, overCap };
}

const MISSING = "not in the main checkout";
/** A report error as the session reads it. */
const pageErrorWhy = (error: string) => (error.startsWith("no page ") ? MISSING : error);
/** The gate states the session must act on before a report reads its text, and the reason the line gives. */
const ACT_ON: Partial<Record<PageState, string>> = {
  uncommitted: "uncommitted",
  "not-carried": "not carried",
  "main-uncommitted": "the main copy has uncommitted edits",
  "deleted-uncommitted": "deleted, uncommitted",
  missing: MISSING,
};
/** The gate states no report is asked for. */
const NOT_ASKED = new Set<PageState>(["deleted", "deleted-uncommitted", "missing"]);

/**
 * The `Stale:` line's precedence: each page gets the entry of its lowest level, one wording per state.
 * 1 wide gate skip, 2 gate state to act on, 3 no report, 4 Check skipped (To-check pages not the session's),
 * 5 own items, 6 To-check verdicts. 4 and 6 apply to pages that are not the session's, 5 to its own, so
 * their relative order never decides an entry.
 */
const WIDE = 1, GATE = 2, UNREPORTED = 3, SKIPPED = 4, OWN = 5, VERDICT = 6;

/**
 * The `Stale:` line for one wiki, from what the second call got. Every
 * completed part counts, whatever failed after it. It covers every session
 * page (`--pages` and the work memo's) and every To-check page with an open
 * outcome; «nothing stale» only when none is open, a report was read and no
 * gate skip held for the whole checkout.
 */
export function staleLine(o: {
  wiki: string;
  ledger: StaleLedger;
  /** The `--pages` pages in gate order; no `state` when the gate stopped before reading the pages. */
  pages: { rel: string; state?: PageState }[];
  /** `--session`'s id: its pages are `ledger.sessionPages`, unknown when the memo was not answered. */
  session?: string;
  isOwn: (rel: string) => boolean;
  /** Why Check did not run at all (the gate, readonly, no muninn). */
  checkSkipped?: string;
  /** Pages left unchecked because they are over the cap. */
  overCap: string[];
  /** Changed pages whose Check the run did not start, and why (the reports' deadline, the run's bound). */
  checkSkips?: Record<string, string>;
  /** A gate skip for the whole checkout: no report reads the session's text. */
  wideSkip?: string;
}): string {
  const { ledger: L, wiki } = o;
  const key = (p: string) => p.toLowerCase();
  const memo = L.sessionPages ?? [];
  /** Session pages in order: `--pages`, then the memo's. */
  const order = new Map<string, number>();
  for (const p of [...o.pages.map((x) => x.rel), ...memo]) if (!order.has(key(p))) order.set(key(p), order.size);
  const list = new Map<string, { page: string; level: number; why: string }>();
  const add = (level: number, page: string, why: string) => {
    const cur = list.get(key(page));
    if (!cur || level < cur.level) list.set(key(page), { page: cur?.page ?? page, level, why });
  };

  const session = [...o.pages.map((p) => p.rel), ...memo];
  if (o.wideSkip) for (const p of session) add(WIDE, p, `not re-read: ${o.wideSkip}`);
  for (const p of o.pages) {
    const why = p.state && ACT_ON[p.state];
    if (why) add(GATE, p.rel, `not re-read: ${why}`);
  }
  const reported = new Set(L.reports.map((r) => key(String(r.page.relPath))));
  const asked = [...o.pages.filter((p) => p.state && !NOT_ASKED.has(p.state)).map((p) => p.rel), ...memo];
  for (const p of asked) {
    if (reported.has(key(p))) continue;
    const e = L.pageErrors.find((x) => key(x.page) === key(p));
    const why = e ? pageErrorWhy(e.error) : (L.stopped ?? "no report");
    add(UNREPORTED, p, why === MISSING ? `not re-read: ${MISSING}` : `not reported: ${why}`);
  }
  for (const i of ownItems(L.reports, o.isOwn, L.checks)) if (i.state !== "settled") add(OWN, i.page, ownLabel(i));

  let sent = 0;
  const sendOf = new Map(L.sends.map((s) => [`${s.changed}\u0001${s.linking}`, s]));
  for (const r of L.reports) {
    const changed = r.page.relPath as string;
    const rec = L.checks[changed];
    const overCap = o.overCap.includes(changed);
    for (const l of toCheckOf(r)) {
      if (o.isOwn(l.relPath)) continue;
      const tag = l.verdict?.verdict as string | undefined;
      if (!rec) {
        if (tag && SETTLED.has(tag)) continue;
        const why = o.checkSkipped ?? o.checkSkips?.[changed] ?? (overCap ? `over ${COSTED_PAGE_CAP} pages` : L.readonly ? `readonly ${L.readonly}` : "no Check");
        add(SKIPPED, l.relPath, `Check skipped: ${why}`);
        continue;
      }
      let v = rec.verdicts.find((x) => x.relPath === l.relPath);
      if (!v) {
        // No verdict this run: the cached one stands; only an uncached page is a failure.
        const err = rec.errors.find((x) => x.relPath === l.relPath);
        const failed = err ? "check error" : rec.failure ? rec.failure : rec.start?.left ? "left for another Check" : "no verdict";
        if (!tag) {
          add(VERDICT, l.relPath, failed);
          continue;
        }
        if (tag === "stale") {
          add(VERDICT, l.relPath, `stale, not sent: ${failed}`);
          continue;
        }
        v = l.verdict as Json;
      }
      if (SETTLED.has(v.verdict)) continue;
      if (v.verdict === "unsure") {
        add(VERDICT, l.relPath, "unsure");
        continue;
      }
      if (v.verdict !== "stale") {
        add(VERDICT, l.relPath, verdictTag(v).slice(1, -1));
        continue;
      }
      const s = sendOf.get(`${changed}\u0001${l.relPath}`);
      if (s?.outcome === "sent") sent++;
      else if (s?.outcome === "no-edit") add(VERDICT, l.relPath, "stale, no drafted edit — fix in the reader");
      else if (s?.outcome === "refused") add(VERDICT, l.relPath, `refused: ${s.error ?? "?"}`);
      else if (s?.outcome === "error") add(VERDICT, l.relPath, "not sent: muninn not reachable");
      else if (s?.outcome === "own") add(VERDICT, l.relPath, "stale, yours");
      else add(VERDICT, l.relPath, `not sent: ${L.sendsStopped ?? (L.readonly ? "readonly" : "no send")}`);
    }
  }

  const rank = (k: string, i: number) => order.get(k) ?? order.size + i;
  const entries = [...list].map(([k, e], i) => ({ ...e, at: rank(k, i) })).sort((a, b) => a.at - b.at);
  const parts: string[] = [];
  if (sent) parts.push(`${sent} fixes sent to the Gardener`);
  if (o.session && !L.sessionPages) parts.push(`session ${o.session}'s pages not known (${L.stopped ?? "no answer"})`);
  if (entries.length) parts.push(`to check: ${entries.map((e) => `${e.page} (${e.why})`).join(", ")}`);
  if (!parts.length) {
    const deleted = o.pages.filter((p) => p.state === "deleted").map((p) => p.rel);
    parts.push(
      o.wideSkip ? `not checked (${o.wideSkip})`
      : L.stopped ? `not checked (${L.stopped})`
      : L.reports.length ? "nothing stale on the changed pages"
      : deleted.length ? `deleted only: ${deleted.join(", ")} — nothing to check`
      : "nothing to check: no page changed",
    );
  }
  if (L.readonly) parts.push(`check unavailable: readonly ${L.readonly}`);
  return `Stale: ${wiki} — ${parts.join("; ")}`;
}

export interface HandoffDeps {
  git?: Git;
  fetchJson?: FetchJson;
  postSse?: PostSse;
  postJson?: PostJson;
  env?: Record<string, string | undefined>;
  write?: (line: string) => void;
  deadlineMs?: number;
  checkDeadlineMs?: number;
  sendDeadlineMs?: number;
  /** The script path printed in the «then run» line. */
  scriptPath?: string;
  /** The clock the run's bound is measured on. */
  now?: () => number;
}

/** `--handoff [--check]`: never throws; the last line of each wiki is its `Stale:` line. */
export async function runHandoff(argv: readonly string[], deps: HandoffDeps = {}): Promise<string[]> {
  const out: string[] = [];
  const say = (...lines: string[]) => {
    for (const l of lines) {
      out.push(l);
      deps.write?.(l);
    }
  };
  try {
    await handoff(argv, deps, say);
  } catch (err) {
    say(`Stale: not checked (wiki-stale --handoff failed: ${err instanceof Error ? err.message : String(err)})`);
  }
  return out;
}

async function handoff(argv: readonly string[], deps: HandoffDeps, say: (...l: string[]) => void): Promise<void> {
  const { args, errors } = parseStaleArgs(argv);
  const git = deps.git ?? gitRunner();
  const notChecked = (why: string) => say(`Stale: not checked (${why})`);
  if (args.json) errors.push("--json does not combine with --handoff");
  if (args.send) errors.push("--handoff sends by itself with --check; drop --send");
  if (errors.length) {
    say(...errors.map((e) => `wiki-stale: ${e}`));
    return notChecked(`usage: ${errors[0]}`);
  }
  let mainOverride: string | undefined;
  if (args.main !== undefined) {
    const m = home(args.main);
    if (!path.isAbsolute(m)) {
      say(`wiki-stale: --main must be an absolute path (or ~/…), not ${args.main}`);
      return notChecked("--main is not an absolute path");
    }
    mainOverride = real(m);
  }

  // Map each page to its repo; a page that cannot be mapped is a line.
  const groups = new Map<string, PageRef[]>();
  let gitMissing = false;
  for (const given of args.pages) {
    const r = await resolvePage(given, git);
    if ("skip" in r) {
      if (r.skip === "git not found") gitMissing = true;
      say(`skipped ${given} — ${r.skip}`);
      continue;
    }
    const main = mainOverride ?? r.main;
    if (mainOverride && r.main !== mainOverride) {
      say(`skipped ${given} — not in ${mainOverride}`);
      continue;
    }
    groups.set(main, [...(groups.get(main) ?? []), r]);
  }
  if (gitMissing && !groups.size) return notChecked("git not found — fix your own lines by hand");
  if (!groups.size && args.session && !args.pages.length) {
    if (!mainOverride) {
      say("wiki-stale: --handoff with --session and no --pages needs --main (the wiki's main checkout)");
      return notChecked("--session without --pages or --main");
    }
    groups.set(mainOverride, []);
  }
  if (!groups.size) return notChecked(args.pages.length ? "no page could be mapped to a wiki" : "no wiki page changed");
  if (args.wiki && groups.size > 1) {
    say(`wiki-stale: --wiki names one wiki, but the pages are in ${groups.size} repos: ${[...groups.keys()].join(", ")}`);
    return notChecked("--wiki with pages in several repos");
  }

  for (const [main, pages] of groups) {
    const wiki = args.wiki ?? path.basename(main);
    say(`== ${wiki} (${main})`);
    try {
      await oneWiki(wiki, main, pages, args, deps, git, say);
    } catch (err) {
      say(`Stale: ${wiki} — not checked (wiki-stale --handoff failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  }
}

async function oneWiki(
  wiki: string,
  main: string,
  pages: PageRef[],
  args: ReturnType<typeof parseStaleArgs>["args"],
  deps: HandoffDeps,
  git: Git,
  say: (...l: string[]) => void,
): Promise<void> {
  const second = args.check;
  const now = deps.now ?? Date.now;
  const started = now();
  const gate = await runGate(main, pages, git);
  // The run's bound counts from here: the gate's git calls are bounded one by one, not together, so its time is measured.
  const gated = now();
  say(...gate.lines);
  if (!second && gate.skip) say(`  (a --check call now would skip Check: ${gate.skip})`);
  // A page named by its main copy and its worktree copy is one page to report.
  const reportable = [...new Set(gate.pages.filter((p) => !NOT_ASKED.has(p.state)).map((p) => p.rel))];
  const dropped = gate.pages.filter((p) => p.state === "deleted" || p.state === "deleted-uncommitted").map((p) => p.rel);
  // The session's `--pages` for the Stale line; a gate that stopped before the pages leaves them without a state.
  const linePages: { rel: string; state?: PageState }[] = gate.pages.length ? gate.pages : pages;
  const line = (ledger: StaleLedger, extra: Partial<Parameters<typeof staleLine>[0]> = {}) =>
    staleLine({
      wiki,
      ledger,
      pages: linePages,
      isOwn: () => true,
      overCap: [],
      ...(args.session ? { session: args.session } : {}),
      ...(gate.wideSkip ? { wideSkip: gate.wideSkip } : {}),
      ...extra,
    });
  if (!reportable.length && !args.session) {
    // Nothing for muninn to read: deleted or missing pages only, or a gate that stopped before the pages.
    if (!second) say("fix by hand: nothing");
    return void say(line(newLedger()));
  }

  const ledger = newLedger();
  const common = [
    "--wiki", wiki,
    ...(reportable.length ? ["--pages", ...reportable] : []),
    ...(args.session ? ["--session", args.session] : []),
    ...(args.asOf ? ["--as-of", args.asOf] : []),
    ...(args.baseUrl ? ["--base-url", args.baseUrl] : []),
  ];
  const runDeps = {
    ...(deps.fetchJson ? { fetchJson: deps.fetchJson } : {}),
    ...(deps.postSse ? { postSse: deps.postSse } : {}),
    ...(deps.postJson ? { postJson: deps.postJson } : {}),
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
    ...(deps.checkDeadlineMs !== undefined ? { checkDeadlineMs: deps.checkDeadlineMs } : {}),
    ...(deps.sendDeadlineMs !== undefined ? { sendDeadlineMs: deps.sendDeadlineMs } : {}),
    write: (l: string) => say(l),
    ledger,
  };
  const ownRels = new Set([...reportable, ...dropped]);
  const isOwn = (rel: string) => isOwnPage(rel, new Set([...ownRels, ...(ledger.sessionPages ?? []), ...ledger.reports.map((r) => r.page.relPath as string)]), []);

  if (!second) {
    await runWikiStale(common, runDeps);
    if (ledger.stopped && !ledger.reports.length) {
      // No report: there is nothing for a --check call to add (D13).
      say(`fix by hand: no report (${ledger.stopped}) — read your own pages for status lines yourself`);
      return void say(`Stale: ${wiki} — not checked (${ledger.stopped})`);
    }
    const items = ownItems(ledger.reports, isOwn).filter((i) => i.state !== "settled");
    // A page with no report has no items: the list is partial, and says which pages it lacks.
    const reported = new Set(ledger.reports.map((r) => String(r.page.relPath).toLowerCase()));
    const noReport = reportable
      .filter((p) => !reported.has(p.toLowerCase()))
      .map((p) => {
        const e = ledger.pageErrors.find((x) => x.page.toLowerCase() === p.toLowerCase());
        return `${p} (${e ? pageErrorWhy(e.error) : (ledger.stopped ?? "not reported")})`;
      });
    say("fix by hand (your own pages; every other page goes through --check's sends):");
    if (!items.length && !noReport.length) say("  nothing");
    for (const i of items) {
      say(i.kind === "hit" ? `  ${i.page} L${i.line} after [[${i.target}]]: ${i.text.slice(0, 160)}` : `  ${i.page} L${i.line} — to check after ${i.target}: read it against the change`);
    }
    if (noReport.length) say(`  not complete — no report for ${noReport.join(", ")}: read those pages for status lines yourself`);
    say(`then: commit (and push) those fixes by the fix path, then run the same command with --check`);
    return;
  }

  let plan: ReturnType<typeof planChecks> | undefined;
  /** Changed pages whose Check this run did not start, and why. */
  const checkSkips: Record<string, string> = {};
  const reportMs = deps.deadlineMs ?? RUN_DEADLINE_MS;
  const checkMs = deps.checkDeadlineMs ?? CHECK_PAGE_DEADLINE_MS;
  const sendMs = deps.sendDeadlineMs ?? SEND_DEADLINE_MS;
  /** Measured from the gate's end; the printed minutes add the gate's measured time. */
  let boundMs = Infinity;
  const runMin = () => Math.ceil((gated - started + boundMs) / 60_000);
  const checkArgs = gate.skip ? [] : ["--check", "--send"];
  await runWikiStale([...common, ...checkArgs], {
    ...runDeps,
    printReports: false,
    planChecks: (reports) => {
      plan = planChecks(reports);
      if (!reports.length) return [];
      // Past the reports' deadline the cap cannot be counted: the reported pages that spend model calls skip, the cached ones run.
      const cut = ledger.reportDeadline ? `muninn did not answer in ${reportMs / 1000} s` : undefined;
      if (cut) for (const p of plan.costed) checkSkips[p] = cut;
      const check = cut ? plan.free : plan.check;
      const costed = cut || plan.overCap ? 0 : plan.costed.length;
      boundMs = reportMs + STEP_MARGIN_MS + check.length * checkMs + sendMs;
      const why = cut ? ` — the reports stopped (${cut}), so only the ${plan.free.length} cached one(s) run` : plan.overCap ? ` — over ${COSTED_PAGE_CAP}, so only the ${plan.free.length} cached one(s) run` : "";
      say(
        `Check: ${plan.costed.length} page(s) spend model calls${why}, ${plan.free.length} cached only; ` +
          `bound ≤ ${costed * CALLS_PER_PAGE} model calls, ≤ ${runMin()} min for the whole run (the gate took ${Math.ceil((gated - started) / 1000)} s)`,
      );
      return check;
    },
    // No Check starts that could end, with the sends after it, past the printed bound.
    beforeCheck: (p) => {
      if (now() - gated + checkMs + sendMs <= boundMs) return true;
      const min = runMin();
      checkSkips[p] = `past the ${min}-min bound`;
      say(`wiki-stale: check ${p} not started — it could run past the ${min}-min bound`);
      return false;
    },
  });
  const checkSkipped = gate.skip ?? (ledger.readonly ? `readonly ${ledger.readonly}` : undefined);
  say(line(ledger, { isOwn, ...(checkSkipped ? { checkSkipped } : {}), overCap: plan?.overCap ? plan.costed : [], checkSkips }));
}
