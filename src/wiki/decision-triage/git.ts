/**
 * The one way page text reaches `git`. A `repos:` entry and a backticked token
 * come from a page, so each is checked here, every call runs with
 * `--literal-pathspecs` and `GIT_TERMINAL_PROMPT=0`, a read takes no optional
 * lock, and output stops at a line and byte bound instead of buffering.
 */

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { killProcessGroup } from "../commit.ts";
import type { RepoFact } from "./schema.ts";

const GIT_TIMEOUT_MS = 15_000;
export const GIT_FETCH_TIMEOUT_MS = 30_000;
const GIT_MAX_BYTES = 4_000_000;

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr?: string;
  /** Output reached `maxLines` or the byte bound; the process was killed. An exact
   *  `maxLines` of output reads as capped too: the facts carry this flag, and the
   *  prompt is frozen. */
  capped?: boolean;
  timedOut?: boolean;
}

export type GitRun = (cwd: string, args: readonly string[], opts?: { timeoutMs?: number; maxLines?: number }) => Promise<GitResult>;

/** The real runner. Its children get an allowlisted environment. */
export const realGit: GitRun = async (cwd, args, opts = {}) => {
  let proc;
  try {
    proc = Bun.spawn(["git", "--no-pager", "--no-optional-locks", "--literal-pathspecs", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Its own process group, so a timeout's kill reaches the transport child.
      detached: true,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? homedir(),
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
        LC_ALL: "C",
      },
    });
  } catch (err) {
    return { ok: false, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
  const running = proc;
  let out = "";
  let lines = 0;
  let capped = false;
  const decoder = new TextDecoder();
  const stderr = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  const collect = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      out += text;
      for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
      if ((opts.maxLines !== undefined && lines >= opts.maxLines) || out.length > GIT_MAX_BYTES) {
        capped = true;
        killProcessGroup(running);
        await reader.cancel().catch(() => {});
        break;
      }
    }
    const code = await running.exited;
    return { code, errText: await stderr.catch(() => "") };
  })();
  collect.catch(() => {}); // the losing branch must never surface as unhandled
  // A race, as in `runGit`: a transport child inherits the pipes, so a read awaited
  // after the kill can outlive the timeout.
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      killProcessGroup(running);
      resolve(null);
    }, timeoutMs);
  });
  const done = await Promise.race([collect, expiry]);
  clearTimeout(timer);
  if (done === null) void reader.cancel().catch(() => {});
  const timedOut = done === null && !capped;
  const errText = done?.errText || (timedOut ? `git ${args[0] ?? "?"} timed out after ${timeoutMs} ms` : "");
  if (capped && opts.maxLines !== undefined) out = out.split("\n").slice(0, opts.maxLines).join("\n");
  return {
    ok: capped || (done?.code === 0),
    stdout: out,
    ...(errText ? { stderr: errText } : {}),
    ...(capped ? { capped } : {}),
    ...(timedOut ? { timedOut } : {}),
  };
};

/** Lines reaching the model are cut here. */
export const GIT_LINE_CHARS = 300;
export const cutLine = (line: string) => (line.length > GIT_LINE_CHARS ? `${line.slice(0, GIT_LINE_CHARS)}…` : line);

const TOKEN_RE = /^[\p{L}\p{N}_./:-]+$/u;
const TOKEN_MAX_CHARS = 120;
export const TOKENS_PER_CARD = 8;

/** The tokens a card names: backticked strings fit to search for, first ones first. */
export function cardTokens(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/`([^`\n]+)`/g)) {
    const t = m[1]!;
    if (t.length <= TOKEN_MAX_CHARS && !t.startsWith("-") && TOKEN_RE.test(t)) out.add(t);
    if (out.size === TOKENS_PER_CARD) break;
  }
  return [...out];
}

/** A `repos:` entry that may name a folder: anything else counts as not found. */
export function isSafeRepoName(name: string): boolean {
  return /^[\w.-]+$/.test(name) && name !== "." && name !== "..";
}

/** `DECISION_TRIAGE_REPO_ROOTS`, parsed: directories to search, and repos elsewhere. */
export interface RepoRoots {
  dirs: string[];
  named: Map<string, string>;
}

export function parseRepoRoots(value: string | null | undefined): RepoRoots {
  const roots: RepoRoots = { dirs: [], named: new Map() };
  const home = (p: string) => (p === "~" || p.startsWith("~/") ? path.join(homedir(), p.slice(1)) : p);
  for (const raw of (value ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq > 0) roots.named.set(entry.slice(0, eq).trim(), home(entry.slice(eq + 1).trim()));
    else roots.dirs.push(home(entry));
  }
  return roots;
}

/** The last path part of `origin`, without `.git`. */
export function originBasename(url: string): string {
  const last = url.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.endsWith(".git") ? last.slice(0, -4) : last;
}

/** The folder holding repo `name`, or why there is none. Exact on the origin's
 *  basename, case included: a case-folding disk opens an unrelated clone under
 *  the same letters, and a folder inside another repo reads that repo's origin. */
export async function findRepo(name: string, roots: RepoRoots, git: GitRun): Promise<{ dir: string } | { reason: string }> {
  if (!isSafeRepoName(name)) return { reason: "not a repo name" };
  const candidates = [...(roots.named.has(name) ? [roots.named.get(name)!] : []), ...roots.dirs.map((d) => path.join(d, name))];
  let reason = "no such folder under the roots";
  for (const dir of candidates) {
    const real = await realpath(dir).catch(() => null);
    if (!real) continue;
    const top = await git(real, ["rev-parse", "--show-toplevel"]);
    if (!top.ok || (await realpath(top.stdout.trim()).catch(() => null)) !== real) {
      reason = "the folder is not a repo's root";
      continue;
    }
    const origin = await git(real, ["remote", "get-url", "origin"]);
    if (!origin.ok) {
      reason = "no origin";
      continue;
    }
    if (originBasename(origin.stdout) === name) return { dir: real };
    reason = "origin names another repo";
  }
  return { reason };
}

/** `origin/<default branch>`: the remote's HEAD, else main, else master. Never
 *  local `HEAD`: checkouts sit on old feature branches. */
export async function defaultBranch(dir: string, git: GitRun): Promise<string | null> {
  const head = await git(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const named = head.ok ? head.stdout.trim().replace(/^origin\//, "") : "";
  for (const branch of named ? [named] : ["main", "master"]) {
    if (/^[\w./-]+$/.test(branch) && (await git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}^{commit}`])).ok) return branch;
  }
  return null;
}

/** A resolved repo: its fact, and where to read it. */
export interface ResolvedRepo {
  fact: RepoFact;
  dir?: string;
  branch?: string;
}

/** One repo, resolved once a run. The fetch is best effort, moves only the
 *  remote-tracking ref, and its failure is a fact rather than a refusal. */
export async function resolveRepo(name: string, roots: RepoRoots, git: GitRun, opts: { fetch: boolean }): Promise<ResolvedRepo> {
  const found = await findRepo(name, roots, git);
  if ("reason" in found) return { fact: { repo: name, found: false, reason: found.reason } };
  const { dir } = found;
  const branch = await defaultBranch(dir, git);
  if (!branch) return { fact: { repo: name, found: false, reason: "no origin default branch" } };
  let fetch: RepoFact["fetch"] = "skipped";
  if (opts.fetch) {
    const res = await git(dir, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "origin", branch], { timeoutMs: GIT_FETCH_TIMEOUT_MS });
    fetch = res.ok ? "ok" : { failed: res.timedOut ? "timed out" : cutLine((res.stderr ?? "").trim().split("\n")[0] ?? "") };
  }
  const tip = await git(dir, ["log", "-1", "--format=%cI", `refs/remotes/origin/${branch}`, "--"]);
  return { dir, branch, fact: { repo: name, found: true, ref: `origin/${branch}`, tipDate: tip.stdout.trim(), fetch } };
}
