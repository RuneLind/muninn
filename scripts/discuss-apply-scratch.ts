/**
 * A muninn of its own over a scratch copy of a wiki with NO git remote, for
 * Discuss P4's Apply on real pages (mimir plan muninn-wiki-discuss: the named
 * test and the counted edits). The copy is what Apply writes and commits.
 *
 *   bun scripts/discuss-apply-scratch.ts --src <wiki root> [--name mimir-scratch] \
 *     [--bot jarvis] [--into <dir>] [--port <n>] [--keep-env NAME,NAME] [--check]
 *
 * In order, stopping at the first failure:
 *  1. copies `--src` (its `.git` included, so uncommitted pages come along as
 *     they are) into `--into`, default a new temp dir;
 *  2. removes every remote of the copy and checks that `git remote` prints
 *     nothing: the wiki has no owning bot, and Apply on a wiki no bot owns
 *     pushes by default, so an empty `git remote` is the only guard;
 *  3. checks that the `_test` database (`MUNINN_TEST_DATABASE_URL`, else
 *     `muninn_test`) holds P2b's `wiki_discuss_turns`; run
 *     `bun run db:setup:test` first when it does not;
 *  4. starts `bun run src/index.ts` with `e2eEnv()` (every platform token
 *     blanked, so no bot polls Telegram or Slack), `SCHEDULER_ENABLED=false`,
 *     that database, a free port, and `WIKI_EXTRA=<name>=<copy>==<bot>`: the
 *     pin picks `<bot>`'s connector for the turn. It does not make `<bot>` the
 *     wiki's owner. `e2eEnv()` blanks the repo roots; they are set back by name
 *     (`DECISION_TRIAGE_REPO_ROOTS` from this process's env, which Bun loads
 *     from `.env`), and so is every name in `--keep-env`. The plan-card command
 *     stays blank: the copy is not a plan-card root, so turns run without the
 *     card. `MUNINN_BOTS_DIR` is this process's value, else `<repo>/bots`.
 *
 * Then it prints the reader URL and a `scripts/wiki-discuss.ts` line for a
 * turn, and runs until Ctrl-C. `--check` stops the muninn once it answers.
 */
import { createServer } from "node:net";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { e2eEnv } from "../e2e/e2e-env.ts";
import { TEST_DATABASE_URL } from "../src/test/test-db-url.ts";

const { values } = parseArgs({
  options: {
    src: { type: "string" },
    name: { type: "string", default: "mimir-scratch" },
    bot: { type: "string", default: "jarvis" },
    into: { type: "string" },
    port: { type: "string" },
    "keep-env": { type: "string", default: "" },
    check: { type: "boolean", default: false },
  },
});

function fail(msg: string): never {
  console.error(`discuss-apply-scratch: ${msg}`);
  process.exit(1);
}

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) fail(`git ${args.join(" ")} in ${dir}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

if (!values.src) fail("--src <wiki root> is required");
const src = path.resolve(values.src);
if (!existsSync(path.join(src, ".git"))) fail(`${src} is not the root of a git work tree`);
const repoRoot = path.resolve(import.meta.dir, "..");

// 1. The copy.
const dest = values.into ? path.resolve(values.into) : path.join(mkdtempSync(path.join(tmpdir(), "discuss-apply-")), values.name);
if (existsSync(dest)) fail(`${dest} exists already; name a new directory`);
cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
console.log(`copied ${src} → ${dest}`);

// 2. No remote.
for (const remote of git(dest, "remote").split("\n").map((r) => r.trim()).filter(Boolean)) git(dest, "remote", "remove", remote);
const remotes = git(dest, "remote");
if (remotes.trim() !== "") fail(`git remote still prints ${JSON.stringify(remotes)}; refusing to start (Apply would push)`);
console.log(`git remote in the copy prints nothing`);

// 3. The database.
const dbUrl = TEST_DATABASE_URL;
const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });
try {
  const [row] = await sql`SELECT to_regclass('public.wiki_discuss_turns') IS NOT NULL AS ok`;
  if (!row?.ok) fail(`${new URL(dbUrl).pathname.slice(1)} has no wiki_discuss_turns; run bun run db:setup:test`);
} catch (err) {
  fail(`cannot read ${new URL(dbUrl).pathname.slice(1)}: ${(err as Error).message}`);
} finally {
  await sql.end({ timeout: 2 });
}
console.log(`database ${new URL(dbUrl).pathname.slice(1)} holds wiki_discuss_turns`);

// 4. The muninn.
const port = values.port ? Number(values.port) : await freePort();
const kept: Record<string, string> = {};
for (const name of ["DECISION_TRIAGE_REPO_ROOTS", ...values["keep-env"].split(",").map((s) => s.trim()).filter(Boolean)]) {
  if (process.env[name] !== undefined) kept[name] = process.env[name]!;
}
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  ...e2eEnv(),
  ...kept,
  DATABASE_URL: dbUrl,
  DASHBOARD_PORT: String(port),
  DASHBOARD_HOST: "127.0.0.1",
  SCHEDULER_ENABLED: "false",
  WIKI_EXTRA: `${values.name}=${dest}==${values.bot}`,
  MUNINN_BOTS_DIR: process.env.MUNINN_BOTS_DIR || path.join(repoRoot, "bots"),
  PLAN_CARD_BIN: "",
  LOG_DIR: "none",
};
const child = Bun.spawn(["bun", "run", "src/index.ts"], { cwd: repoRoot, env, stdout: "inherit", stderr: "inherit", detached: true });
const stop = () => {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => {
  stop();
  process.exit(130);
});

const base = `http://127.0.0.1:${port}`;
const deadline = Date.now() + 60_000;
for (;;) {
  try {
    const res = await fetch(`${base}/api/wiki/pages?wiki=${encodeURIComponent(values.name)}`);
    if (res.ok) break;
  } catch {
    /* not up yet */
  }
  if (child.exitCode !== null) fail(`muninn exited with ${child.exitCode} before it answered`);
  if (Date.now() > deadline) {
    stop();
    fail(`muninn did not answer on ${base} within 60 s`);
  }
  await Bun.sleep(500);
}
console.log(`muninn answers on ${base}, wiki ${values.name} pinned to ${values.bot}, kept ${Object.keys(kept).join(", ") || "no repo roots"}`);
if (values.check) {
  stop();
  await child.exited;
  console.log("--check: stopped");
  process.exit(0);
}
console.log(
  [
    "",
    `Reader: ${base}/wiki?wiki=${encodeURIComponent(values.name)}&relPath=${encodeURIComponent("plans/muninn-wiki-first-screen-claims.mdx")}`,
    `A turn from the shell: bun scripts/wiki-discuss.ts --url ${base} --wiki ${values.name} --page plans/muninn-wiki-first-screen-claims.mdx --selection "R2, behind." --question "…"`,
    `Its edit: curl -s -X POST ${base}/api/wiki/discuss/apply -H 'content-type: application/json' -d '{"turnId":"<id>","preview":true}'`,
    "Ctrl-C stops it; the copy stays.",
  ].join("\n"),
);
await child.exited;
