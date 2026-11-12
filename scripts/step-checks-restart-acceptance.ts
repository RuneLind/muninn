/**
 * Acceptance for the `restart=` step check against REAL muninn processes
 * (mimir plan muninn-wiki-owner-step-checks, PR 2b). Run by hand:
 *
 *   bun scripts/step-checks-restart-acceptance.ts
 *
 * Each scenario boots `src/index.ts` (or `bun --watch src/index.ts`) through
 * the e2e env (`e2eEnv()`, the test database, a port of its own outside the
 * e2e registry) on its OWN temp copy of this checkout's tracked files: a fresh
 * git repo (tracked and untracked-but-not-ignored files, so an uncommitted change is in it) whose `origin` is a local bare clone, so the checkout half reads
 * `ok`, and whose files can be edited without touching this checkout. Copied
 * files get an mtime a minute in the past, as a real checkout's would be.
 * Answers are read from `GET /api/wiki/step-checks` on a temp wiki whose one
 * `you` step names `restart=<port>` (and one names a port nobody listens on).
 * The route caches a probe for 30 s, so a scenario that asks twice waits that
 * out. ENV PREREQUISITE: `bun run db:setup:test`. Not part of any test chain:
 * it takes about two minutes and spawns six servers.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "../e2e/e2e-env.ts";
import { assertPortFree, waitForOwnServer } from "../e2e/own-server.ts";
import { E2E_PORTS } from "../e2e/ports.ts";
import { TEST_DATABASE_URL } from "../src/test/test-db-url.ts";

const REPO = path.resolve(import.meta.dir, "..");
/** One port per scenario, outside the e2e registry (checked below) so no spec run collides with this script. */
const PORTS = { "edit-revert": 3290, untracked: 3291, env: 3292, "boot-window": 3293, bundle: 3294, watch: 3295, routes: 3296 } as const;
type Scenario = keyof typeof PORTS;
const taken = new Set<number>(Object.values(E2E_PORTS));
for (const p of Object.values(PORTS)) if (taken.has(p)) throw new Error(`port ${p} is in the e2e registry`);
const WIKI = "restart-acceptance";
const REL = "plans/restart.mdx";
const TTL_WAIT_MS = 31_000;
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "ignore"] }).toString();

const BASE = mkdtempSync(path.join(tmpdir(), "muninn-restart-acceptance-"));
const children: ChildProcess[] = [];
const results: string[] = [];

/** The nearest `node_modules` above this checkout (a worktree has none of its own). */
function nodeModules(): string {
  for (let d = REPO; d !== path.dirname(d); d = path.dirname(d)) if (existsSync(path.join(d, "node_modules"))) return path.join(d, "node_modules");
  throw new Error("no node_modules above the checkout");
}

/** A temp copy of the tracked files, committed, with a bare `origin` holding that commit. */
function copyCheckout(name: string): string {
  const co = path.join(BASE, name, "muninn");
  mkdirSync(co, { recursive: true });
  const files = git(REPO, "ls-files", "-z", "-co", "--exclude-standard").split("\0").filter(Boolean);
  const past = new Date(Date.now() - 60_000);
  for (const f of files) {
    const from = path.join(REPO, f);
    if (!existsSync(from)) continue;
    mkdirSync(path.dirname(path.join(co, f)), { recursive: true });
    cpSync(from, path.join(co, f));
  }
  writeFileSync(path.join(co, ".env"), "RESTART_ACCEPTANCE_FIXTURE=1\n");
  symlinkSync(nodeModules(), path.join(co, "node_modules"));
  git(co, "init", "-q", "-b", "main");
  git(co, "add", "-A");
  git(co, "commit", "-q", "-m", "copy");
  git(path.join(BASE, name), "clone", "-q", "--bare", co, path.join(BASE, name, "origin.git"));
  git(co, "remote", "add", "origin", path.join(BASE, name, "origin.git"));
  for (const f of [...files, ".env"]) if (existsSync(path.join(co, f))) utimesSync(path.join(co, f), past, past);
  return co;
}

function wiki(port: number): string {
  const root = path.join(BASE, `wiki-${port}`);
  mkdirSync(path.join(root, "plans"), { recursive: true });
  const page = ["---\ntitle: Restart\n---\n", "<NextMoves>\n", '<Lane kind="you">\n', `1. Restart muninn. <Check restart="${port}" />`, '2. Restart the other one. <Check restart="1" />', "\n</Lane>\n", "</NextMoves>\n"].join("\n");
  writeFileSync(path.join(root, REL), page);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  return root;
}

async function boot(name: Scenario, opts: { watch?: boolean; onSpawn?: (co: string) => void } = {}): Promise<{ co: string; port: number }> {
  const port = PORTS[name];
  const co = copyCheckout(name);
  const root = wiki(port);
  await assertPortFree(port);
  const child = spawn("bun", [...(opts.watch ? ["--watch"] : ["run"]), "src/index.ts"], {
    cwd: co,
    env: { ...process.env, ...e2eEnv(), DATABASE_URL: TEST_DATABASE_URL, DASHBOARD_PORT: String(port), DASHBOARD_HOST: "127.0.0.1", SCHEDULER_ENABLED: "false", WIKI_DIR: "", WIKI_EXTRA: `${WIKI}=${root}`, WORK_MAP_WIKIS: WIKI, WIKI_ANSWER_WIKIS: WIKI, WIKI_ANSWER_OWNER: "Test Owner (T000001)", DECISION_TRIAGE_REPO_ROOTS: "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => void (stderr = (stderr + d.toString()).slice(-4_000)));
  child.on("exit", (code) => code && code !== 143 && results.push(`INFO  ${name} exited ${code}: ${stderr.trim().split("\n").slice(-5).join(" | ")}`));
  children.push(child);
  opts.onSpawn?.(co);
  await waitForOwnServer(child, `http://127.0.0.1:${port}/api/wiki/pages?wiki=${WIKI}`, 60_000);
  // The boot fingerprint is taken 2 s after listening.
  await Bun.sleep(5_000);
  return { co, port };
}

async function ask(port: number): Promise<{ own: string; other: string }> {
  const body = (await (await fetch(`http://127.0.0.1:${port}/api/wiki/step-checks?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`)).json()) as { steps: { machines: { probes: { state: string; why: string }[] }[] }[] };
  const line = (i: number) => {
    const p = body.steps[i]!.machines[0]!.probes[0]!;
    return `${p.state} — ${p.why}`;
  };
  return { own: line(0), other: line(1) };
}

function record(scenario: string, got: string, want: string): void {
  const pass = got.startsWith(want);
  results.push(`${pass ? "PASS" : "FAIL"}  ${scenario}: ${got}`);
}

const append = (co: string, rel: string, text: string) => writeFileSync(path.join(co, rel), readFileSync(path.join(co, rel), "utf8") + text);
const SRC = "src/wiki/step-checks/answer.ts";
const BUNDLE_SRC = "src/dashboard/views/components/wiki-shell-client.ts";
const wikiAssetPath = async (port: number) => /\/wiki\/assets\/wiki\.[0-9a-f]+\.js/.exec(await (await fetch(`http://127.0.0.1:${port}/wiki?wiki=${WIKI}`)).text())?.[0] ?? "none";

async function editRevert(): Promise<void> {
  const { co, port } = await boot("edit-revert");
  const first = await ask(port);
  record("fresh boot", first.own, "ok");
  record("wrong port", first.other, `unknown — this muninn listens on ${port}`);
  const before = readFileSync(path.join(co, SRC));
  append(co, SRC, "\n// edited\n");
  await Bun.sleep(TTL_WAIT_MS);
  record("source edited", (await ask(port)).own, "not-yet");
  writeFileSync(path.join(co, SRC), before);
  await Bun.sleep(TTL_WAIT_MS);
  record("edit reverted byte for byte", (await ask(port)).own, "ok");
}

async function untracked(): Promise<void> {
  const { co, port } = await boot("untracked");
  writeFileSync(path.join(co, "src", "new-untracked-file.ts"), "export {};\n");
  record("untracked file added", (await ask(port)).own, "not-yet");
}

async function envChange(): Promise<void> {
  const { co, port } = await boot("env");
  writeFileSync(path.join(co, ".env"), "RESTART_ACCEPTANCE_FIXTURE=2\n");
  record(".env bytes changed", (await ask(port)).own, "not-yet");
}

async function bootWindow(): Promise<void> {
  const { port } = await boot("boot-window", {
    onSpawn: (co) => setTimeout(() => append(co, SRC, "\n// edited while booting\n"), 300),
  });
  record("edited during the boot window", (await ask(port)).own, "unknown — a file changed while muninn was starting");
}

async function staleBundle(): Promise<void> {
  const { co, port } = await boot("bundle");
  const before = readFileSync(path.join(co, BUNDLE_SRC));
  append(co, BUNDLE_SRC, "\nconsole.debug('edited before the first /wiki');\n");
  const asset = await wikiAssetPath(port);
  writeFileSync(path.join(co, BUNDLE_SRC), before);
  record(`bundle built from an edit that was then reverted (asset ${asset})`, (await ask(port)).own, "not-yet");
}

async function watch(): Promise<void> {
  const { co, port } = await boot("watch", { watch: true });
  const asset = await wikiAssetPath(port);
  const before = readFileSync(path.join(co, BUNDLE_SRC));
  append(co, BUNDLE_SRC, "\nconsole.debug('edited under --watch');\n");
  await Bun.sleep(3_000);
  const after = await wikiAssetPath(port);
  results.push(`INFO  --watch: bundle source edited, served asset ${asset === after ? "UNCHANGED (no rebuild, no reload)" : `changed ${asset} -> ${after}`}`);
  record("--watch, bundle source edited after the bundle was served", (await ask(port)).own, "not-yet");
  writeFileSync(path.join(co, BUNDLE_SRC), before);
  // A server-graph edit reloads the process in place; its files are then younger than the margin.
  append(co, SRC, "\n// edited under --watch\n");
  await Bun.sleep(8_000);
  record("--watch, server source edited (reload)", (await ask(port)).own, "unknown");
}

/** A muninn that has served its pages, whose bundles are built: still ok, no module loaded late. */
async function servedPages(): Promise<void> {
  const { port } = await boot("routes");
  for (const p of ["/", "/wiki?wiki=" + WIKI, `/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`, "/traces", "/chat", "/models", "/agents", "/summaries", "/plans", "/logs", "/api/wiki/pages?wiki=" + WIKI]) await fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.arrayBuffer());
  const asset = await wikiAssetPath(port);
  await fetch(`http://127.0.0.1:${port}${asset}`).then((r) => r.arrayBuffer());
  record("after serving 11 pages and the reader bundle", (await ask(port)).own, "ok");
}

try {
  await Promise.all([servedPages(), editRevert(), untracked(), envChange(), bootWindow(), staleBundle(), watch()].map((p) => p.catch((err) => results.push(`FAIL  ${err instanceof Error ? err.message : String(err)}`))));
} finally {
  for (const c of children) c.kill("SIGTERM");
  await Bun.sleep(500);
  rmSync(BASE, { recursive: true, force: true });
}
for (const line of results) console.log(line);
process.exit(results.some((l) => l.startsWith("FAIL")) ? 1 : 0);
