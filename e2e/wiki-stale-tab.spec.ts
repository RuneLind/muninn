/**
 * The reader's STALE tab (plan muninn-wiki-drift-check, PR 2a), end to end.
 *
 * What no unit test can prove, and this spec exists for:
 *
 *   1. **The tab and its count render in the real reader** from the real
 *      `GET /api/wiki/stale` answer, and only a CONFIRMED status line shows
 *      (D11): the fixture page carries two hits, one with a confirmation row
 *      in the test database and one without.
 *   2. **Check streams through the real route, router and client bundle**:
 *      the click POSTs `/api/wiki/stale/check`, the server makes ONE Haiku
 *      call through the wiki's own bot (`haikuBackend: anthropic`), the fake
 *      Messages API answers it, the verdict lands in the tab as it streams and
 *      a verdict row lands in the database.
 *   3. **Still true writes a reader row that survives a reload**, and the count
 *      drops with it.
 *   4. **The tab is hidden on a read-only instance (D25)**: a second muninn
 *      with `MUNINN_WIKI_READONLY=1` on the same wiki.
 *
 * **What is stubbed and why.** The model only: the throwaway bot's Haiku router
 * goes to the Anthropic backend, and `ANTHROPIC_BASE_URL` points it at a
 * `node:http` fake on its own port. The confirm loop is not run (its first run
 * waits a minute after boot); its one output, a `status-line` verdict row, is
 * inserted under the key D22 defines — sha256 over `status-line`, the page,
 * the line's text, the target and its `plan_status`, joined by NUL — so this
 * spec also pins that key formula from outside the server.
 *
 * Ports from `e2e/ports.ts`; `e2eEnv()` blanks the platform tokens and the
 * instance-profile flags; the bot lives under a temp `MUNINN_BOTS_DIR`.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("wiki-stale-tab");
const RO_PORT = e2ePort("wiki-stale-tab/readonly");
const FAKE_PORT = e2ePort("wiki-stale-tab/fake");
const BASE = `http://127.0.0.1:${PORT}`;
const RO_BASE = `http://127.0.0.1:${RO_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2estale";
const BOT = "e2estalebot";
const DAY = 86_400_000;

const CONFIRMED_LINE = "- [[p]] is in-flight, two PRs open";
const UNCONFIRMED_LINE = "- [[p]] is a draft of the lock design";
const MODEL_ANSWER = '{"verdict":"stale","reason":"E2E: the pin moved on","edit":{"old":"landed on 23.05","new":"landed on 18.06","home":""}}';

const page = (title: string, body: string, extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}\n`;

let root = "";
let botsRoot = "";
let server: ChildProcess | undefined;
let roServer: ChildProcess | undefined;
let fake: Server | undefined;
let sql: ReturnType<typeof postgres> | null = null;
let modelCalls = 0;

function git(args: string[], atMs?: number): void {
  const date = atMs === undefined ? undefined : new Date(atMs).toISOString();
  execFileSync("git", ["-C", root, ...args], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "e2e",
      GIT_AUTHOR_EMAIL: "e2e@example.invalid",
      GIT_COMMITTER_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e2e@example.invalid",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  });
}

async function write(rel: string, body: string): Promise<void> {
  await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
  await writeFile(path.join(root, rel), body, "utf8");
}

/** D22's status-line key, spelled out independently of the server. */
const statusLineKey = (pageRel: string, text: string, target: string, now: string) =>
  createHash("sha256").update(["status-line", pageRel, text, target, now].join("\0")).digest("hex");

function boot(port: number, extra: Record<string, string>): ChildProcess {
  return spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(port),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      MUNINN_BOTS_DIR: botsRoot,
      WIKI_EXTRA: `${WIKI}=${root}=${WIKI}=${BOT}`,
      ANTHROPIC_API_KEY: "e2e-dummy-key",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
      HAIKU_BACKEND: "",
      ...extra,
    },
    stdio: "ignore",
  });
}

async function waitUp(base: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/live`)).ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`muninn did not start at ${base}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-stale-"));
  botsRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-stale-bots-"));
  await mkdir(path.join(botsRoot, BOT), { recursive: true });
  await writeFile(path.join(botsRoot, BOT, "CLAUDE.md"), "# e2e stale bot\n");
  await writeFile(path.join(botsRoot, BOT, "config.json"), JSON.stringify({ connector: "claude-cli", haikuBackend: "anthropic" }));

  const now = Date.now();
  git(["init", "-q", "-b", "main"]);
  await write("plans/p.md", page("P", "The plan.", "plan_status: shipped\n"));
  await write("notes/old.md", page("Old", "The pin in [[hub]] landed on 23.05."));
  await write("hub.md", page("Hub", "First."));
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"], now - 30 * DAY);
  await write("hub.md", page("Hub", `${CONFIRMED_LINE}\n${UNCONFIRMED_LINE}\n\nThe pin moved.`));
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "hub: the pin moves"], now - DAY);

  fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && (req.url ?? "").startsWith("/v1/messages")) {
        modelCalls++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "msg_e2e", type: "message", role: "assistant", model: "claude-haiku-e2e",
          content: [{ type: "text", text: MODEL_ANSWER }], stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => fake!.listen(FAKE_PORT, "127.0.0.1", r));

  sql = postgres(TEST_DB, { max: 2 });
  await sql`DELETE FROM wiki_stale_verdicts WHERE wiki = ${WIKI}`;
  await sql`
    INSERT INTO wiki_stale_verdicts (wiki, kind, page, key_hash, verdict, reason, checked_by)
    VALUES (${WIKI}, 'status-line', 'hub.md', ${statusLineKey("hub.md", CONFIRMED_LINE, "plans/p.md", "shipped")}, 'stale', 'E2E: the plan shipped', 'model:e2e')
  `;

  server = boot(PORT, {});
  roServer = boot(RO_PORT, { MUNINN_WIKI_READONLY: "1" });
  await Promise.all([waitUp(BASE), waitUp(RO_BASE)]);
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  roServer?.kill("SIGTERM");
  fake?.close();
  try {
    if (sql) await sql`DELETE FROM wiki_stale_verdicts WHERE wiki = ${WIKI}`;
  } finally {
    await sql?.end();
  }
  await rm(root, { recursive: true, force: true });
  await rm(botsRoot, { recursive: true, force: true });
});

async function openHub(p: Page, base = BASE): Promise<void> {
  await p.goto(`${base}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent("hub.md")}`);
  await expect(p.locator(".wiki-article")).toContainText("The pin moved.");
}

test("the tab counts the confirmed line and the page to check, and hides the unconfirmed hit", async ({ page: p }) => {
  await openHub(p);
  const tab = p.locator('.wiki-conn-tab[data-conntab="stale"]');
  await expect(tab).toBeVisible();
  await expect(p.locator("#wikiStaleCount")).toHaveText("1 · 1");
  await tab.click();
  const body = p.locator("#staleBody");
  await expect(body).toBeVisible();
  await expect(body.locator(".wiki-stale-head")).toHaveText("⚠ 1 stale status line · 1 linking page to check");
  await expect(body).toContainText(CONFIRMED_LINE);
  await expect(body).toContainText("E2E: the plan shipped");
  await expect(body).not.toContainText("draft of the lock design");
  await expect(body.locator('[data-bucket="toCheck"]')).toContainText("Old");
});

test("Check streams one model verdict into the tab and writes its row", async ({ page: p }) => {
  modelCalls = 0;
  await openHub(p);
  await p.locator('.wiki-conn-tab[data-conntab="stale"]').click();
  await p.locator("#wikiStaleCheckBtn").click();
  const item = p.locator('[data-stale-linking="notes/old.md"]');
  await expect(item.locator(".wiki-stale-verdict")).toContainText("Out of date", { timeout: 20_000 });
  await expect(item).toContainText("E2E: the pin moved on");
  await item.locator(".wiki-stale-fix summary").click();
  await expect(item.locator(".wiki-stale-fix")).toContainText("landed on 18.06");
  expect(modelCalls).toBe(1);
  const rows = await sql!`SELECT kind, page, verdict, checked_by FROM wiki_stale_verdicts WHERE wiki = ${WIKI} AND kind = 'passage'`;
  expect(rows.map((r) => ({ ...r }))).toEqual([{ kind: "passage", page: "notes/old.md", verdict: "stale", checked_by: `model:${BOT}` }]);
  // A second Check reads the cached verdict: no second call.
  await expect(p.locator("#wikiStaleCheckBtn")).toHaveText("Check again");
  await p.locator("#wikiStaleCheckBtn").click();
  await expect(p.locator("#wikiStaleProgress")).toHaveText("1 of 1 checked");
  expect(modelCalls).toBe(1);
});

test("Still true writes a reader row that survives a reload, and the count drops", async ({ page: p }) => {
  await openHub(p);
  await p.locator('.wiki-conn-tab[data-conntab="stale"]').click();
  await p.locator('[data-stale-hit] [data-stale-verdict="true"]').click();
  await expect(p.locator("#wikiStaleCount")).toHaveText("0 · 1");
  await p.reload();
  await expect(p.locator("#wikiStaleCount")).toHaveText("0 · 1");
  await p.locator('.wiki-conn-tab[data-conntab="stale"]').click();
  await expect(p.locator("#staleBody")).not.toContainText(CONFIRMED_LINE);
  const rows = await sql!`SELECT verdict, checked_by FROM wiki_stale_verdicts WHERE wiki = ${WIKI} AND kind = 'status-line'`;
  expect(rows.map((r) => ({ ...r }))).toEqual([{ verdict: "true", checked_by: "reader" }]);
});

test("a read-only instance hides the tab (D25)", async ({ page: p }) => {
  await openHub(p, RO_BASE);
  await expect(p.locator('.wiki-conn-tab[data-conntab="conn"]')).toBeVisible();
  await expect(p.locator('.wiki-conn-tab[data-conntab="stale"]')).toBeHidden();
  await expect(p.locator("#staleBody")).toBeHidden();
  // The routes refuse there too.
  const res = await p.request.post(`${RO_BASE}/api/wiki/stale/verdict`, {
    headers: { "content-type": "application/json", origin: RO_BASE },
    data: { wiki: WIKI, page: "hub.md", kind: "status-line", line: 5, verdict: "true" },
  });
  expect(res.status()).toBe(403);
});
