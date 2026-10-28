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
 *   5. **A Check belongs to its page (A9)**: leaving the page aborts the
 *      stream, and coming back does not let the old stream paint. So do the
 *      other ways off a page: an Ask answer, an issue graph (a tracker added
 *      to the listing by a route), a page that fails to load.
 *   6. **Check paints while it streams (A15)**: on `hub3.md` one verdict is on
 *      screen while another call is still held open, so a Check that wrote
 *      everything at its end fails here. A failed call shows on its row and
 *      is not counted (A12); an open Draft fix stays open across the repaints.
 *   7. **The call limit is said (A12)**: `hub4.md` has 11 pages to check.
 *   8. **A read-only ROOT keeps the tab (A15)**: `e2estalero`, a clone of the
 *      wiki registered in `WIKI_READONLY_ROOTS` on the main server, shows the
 *      tab and its count, and neither Check nor a verdict button sends a request.
 *
 * **What is stubbed and why.** The model only: the throwaway bot's Haiku router
 * goes to the Anthropic backend, and `ANTHROPIC_BASE_URL` points it at a
 * `node:http` fake on its own port. The confirm loop is not run (its first run
 * waits a minute after boot); its one output, a `status-line` verdict row, is
 * inserted under the key D22 defines — sha256 over `status-line/v3`, the
 * page, the line's text, its status words, the target, its `plan_status` and
 * its own title, joined by NUL — so this spec also pins that key formula from
 * outside the server.
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
const RO_WIKI = "e2estalero";
const BOT = "e2estalebot";
const DAY = 86_400_000;

const CONFIRMED_LINE = "- [[p]] is in-flight, two PRs open";
const UNCONFIRMED_LINE = "- [[p]] is a draft of the lock design";
const MODEL_ANSWER = '{"verdict":"stale","reason":"E2E: the pin moved on","edit":{"old":"landed on 23.05","new":"landed on 18.06","home":""}}';

/** The ways off a page other than opening another page (test 6b). */
const LEAVE_ROUTES = ["ask", "graph", "fail"] as const;
/** How a page left behind answers late (R2B4 1a): an error payload, a rejected
 *  fetch, a page after all, and an explainer's error payload, rejected fetch
 *  and page after all (each one of `loadExplainer`'s two `pageViewSeq` guards). */
const LATE_KINDS = ["error", "abort", "load", "explainer", "explainer-abort", "explainer-load"] as const;
/** Every way to change what the article pane shows, but a failed load (R2B4 1b). */
const VIEW_ROUTES = ["ask", "graph", "start", "explainer", "page"] as const;
const EXPLAINER = "docs/expl.html";

/** The part of a `GET /api/wiki/stale` answer a route rewrites. */
type StaleReportJson = { buckets?: { linking: { relPath: string; verdict?: Record<string, unknown> }[] } | null };

const page = (title: string, body: string, extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}\n`;

let root = "";
let roRoot = "";
let botsRoot = "";
let server: ChildProcess | undefined;
let roServer: ChildProcess | undefined;
let fake: Server | undefined;
let sql: ReturnType<typeof postgres> | null = null;
let modelCalls = 0;
/** Model calls on `notes/two.md` wait for this (test 5). */
let heldCalls = 0;
let releaseHeld: () => void = () => {};
let held = new Promise<void>((r) => (releaseHeld = r));
/** Model calls on `notes/slow.md` wait for this (test 6). */
let slowCalls = 0;
let releaseSlow: () => void = () => {};
let slow = new Promise<void>((r) => (releaseSlow = r));
/** Model calls on `notes/hold-*.md` wait for this (test 6b). */
let holdCalls = 0;
let releaseHold: () => void = () => {};
let hold = new Promise<void>((r) => (releaseHold = r));
/** Who sent each model request: the SDK (`Anthropic/JS …`) or the Claude CLI. */
const modelAgents: string[] = [];

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
const statusLineKey = (pageRel: string, text: string, said: string[], target: string, now: string, t: { title: string }) =>
  createHash("sha256")
    .update(["status-line/v3", pageRel, text, said.join(","), target, now, t.title].join("\0"))
    .digest("hex");

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
      WIKI_EXTRA: `${WIKI}=${root}=${WIKI}=${BOT},${RO_WIKI}=${roRoot}=${RO_WIKI}=${BOT}`,
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
  await write("notes/two.md", page("Two", "The pin in [[hub2]] landed on 23.05."));
  await write("hub2.md", page("Hub two", "First."));
  await write("hub3.md", page("Hub three", "First."));
  for (const n of ["fast", "slow", "bad"]) await write(`notes/${n}.md`, page(n, "The pin in [[hub3]] landed on 23.05."));
  await write("hub4.md", page("Hub four", "First."));
  for (let i = 1; i <= 11; i++) await write(`many/m${i}.md`, page(`M${i}`, "The pin in [[hub4]] landed on 23.05."));
  for (const n of LEAVE_ROUTES) {
    await write(`hub-${n}.md`, page(`Hub ${n}`, "First."));
    await write(`notes/hold-${n}.md`, page(`Hold ${n}`, `The pin in [[hub-${n}]] landed on 23.05.`));
  }
  // R2B4: each test gets pages of its own, so no verdict another test cached changes it.
  const hubs: [string, string, string[]][] = [
    ...LATE_KINDS.map((k): [string, string, string[]] => [`hub-late-${k}`, `The late-${k} hub moved.`, [`notes/hold-late-${k}`]]),
    ["hub-view", "The view hub moved.", ["notes/view-link"]],
    ["hub-other", "The other hub moved.", ["notes/other-link"]],
    ["hub-fold-a", "The fold-a hub moved.", ["notes/fold-a"]],
    ["hub-fold-b", "The fold-b hub moved.", ["notes/fold-b"]],
    ["hub-bad", "The bad hub moved.", ["notes/fast-bad", "notes/bad-row"]],
    ["hub-cap", "The cap hub moved.", Array.from({ length: 11 }, (_, i) => `cap/c${i + 1}`)],
    ["hub-notice", "The notice hub moved.", ["notes/notice-a", "notes/notice-b"]],
    ["hub-pin", "The pin hub moved.", ["notes/pin-link"]],
    ["hub-race", "The race hub moved.", ["notes/race-a", "notes/race-b"]],
    ["hub-recon", "The recon hub moved.", ["notes/recon-a", "notes/recon-b"]],
    ["hub-same", "The same hub moved.", ["notes/same-link"]],
  ];
  for (const [hub, , links] of hubs) {
    await write(`${hub}.md`, page(hub, "First."));
    for (const l of links) await write(`${l}.md`, page(l, `The pin in [[${hub}]] landed on 23.05.`));
  }
  for (const k of LATE_KINDS) await write(`late-${k}.md`, page(`Late ${k}`, "Never shown."));
  await write("docs/late-expl.html", "<!doctype html><title>Late expl</title><h1>Late expl</h1>");
  await write(EXPLAINER, "<!doctype html><title>Expl</title><h1>Expl</h1>");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"], now - 30 * DAY);
  // One commit per hub: a commit touching 10 or more files is a sweep, and a sweep dates no page.
  for (const [hub, moved] of hubs) {
    await write(`${hub}.md`, page(hub, moved));
    git(["add", "-A"]);
    git(["commit", "-q", "-m", `${hub}: moves`], now - DAY);
  }
  await write("hub.md", page("Hub", `${CONFIRMED_LINE}\n${UNCONFIRMED_LINE}\n\nThe pin moved.`));
  await write("hub2.md", page("Hub two", "Second hub. See [[p|the plan page]]."));
  await write("hub3.md", page("Hub three", "The third hub moved."));
  await write("hub4.md", page("Hub four", "The fourth hub moved."));
  for (const n of LEAVE_ROUTES) await write(`hub-${n}.md`, page(`Hub ${n}`, `The ${n} hub moved.`));
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "hub: the pin moves"], now - DAY);
  // The read-only root: the same history, so the same changed page and hits.
  roRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-stale-ro-"));
  execFileSync("git", ["clone", "-q", root, roRoot], { stdio: "ignore" });

  fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (req.method === "POST" && (req.url ?? "").startsWith("/v1/messages")) {
        modelCalls++;
        modelAgents.push(String(req.headers["user-agent"] ?? ""));
        if (body.includes("notes/two.md")) {
          heldCalls++;
          await Promise.race([held, new Promise((r) => setTimeout(r, 15_000))]);
        }
        if (body.includes("notes/hold-")) {
          holdCalls++;
          await Promise.race([hold, new Promise((r) => setTimeout(r, 15_000))]);
        }
        if (body.includes("notes/slow.md")) {
          slowCalls++;
          await Promise.race([slow, new Promise((r) => setTimeout(r, 20_000))]);
        }
        // `notes/bad*.md` gets an answer with no verdict: a failed call (A12).
        const text = body.includes("notes/bad") ? "I cannot tell." : MODEL_ANSWER;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "msg_e2e", type: "message", role: "assistant", model: "claude-haiku-e2e",
          content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => fake!.listen(FAKE_PORT, "127.0.0.1", r));

  sql = postgres(TEST_DB, { max: 2 });
  await sql`DELETE FROM wiki_stale_verdicts WHERE wiki IN (${WIKI}, ${RO_WIKI})`;
  // A HAIKU_BACKEND override row beats the bot's `haikuBackend` and the env.
  // `bun run test` on this database leaves one (`cli`), and the Claude CLI then
  // sends this fake 4 requests per Check call (A18).
  await sql`DELETE FROM role_overrides WHERE role = 'HAIKU_BACKEND'`;
  await sql`
    INSERT INTO wiki_stale_verdicts (wiki, kind, page, key_hash, verdict, reason, checked_by)
    VALUES (${WIKI}, 'status-line', 'hub.md', ${statusLineKey("hub.md", CONFIRMED_LINE, ["in-flight"], "plans/p.md", "shipped", { title: "P" })}, 'stale', 'E2E: the plan shipped', 'model:e2e'),
           (${RO_WIKI}, 'status-line', 'hub.md', ${statusLineKey("hub.md", CONFIRMED_LINE, ["in-flight"], "plans/p.md", "shipped", { title: "P" })}, 'stale', 'E2E: the plan shipped', 'model:e2e')
  `;

  server = boot(PORT, { WIKI_READONLY_ROOTS: roRoot });
  roServer = boot(RO_PORT, { MUNINN_WIKI_READONLY: "1" });
  await Promise.all([waitUp(BASE), waitUp(RO_BASE)]);
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  roServer?.kill("SIGTERM");
  fake?.close();
  try {
    if (sql) await sql`DELETE FROM wiki_stale_verdicts WHERE wiki IN (${WIKI}, ${RO_WIKI})`;
  } finally {
    await sql?.end();
  }
  await rm(root, { recursive: true, force: true });
  if (roRoot) await rm(roRoot, { recursive: true, force: true });
  await rm(botsRoot, { recursive: true, force: true });
});

async function openHub(p: Page, base = BASE, wiki = WIKI): Promise<void> {
  await p.goto(`${base}/wiki?wiki=${wiki}&relPath=${encodeURIComponent("hub.md")}`);
  await expect(p.locator(".wiki-article")).toContainText("The pin moved.");
}

async function openPage(p: Page, rel: string, text: string): Promise<void> {
  await p.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);
  await expect(p.locator(".wiki-article")).toContainText(text);
  await p.locator('.wiki-conn-tab[data-conntab="stale"]').click();
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
  // The badge adds its counts to the tab's tooltip; the tab's name stays (A12).
  await expect(tab).toHaveAttribute("title", "What a change to this page may have made untrue elsewhere\n1 stale status line · 1 linking page to check");
});

test("Check streams one model verdict into the tab and writes its row", async ({ page: p }) => {
  modelCalls = 0;
  modelAgents.length = 0;
  await openHub(p);
  await p.locator('.wiki-conn-tab[data-conntab="stale"]').click();
  await p.locator("#wikiStaleCheckBtn").click();
  const item = p.locator('[data-stale-linking="notes/old.md"]');
  await expect(item.locator(".wiki-stale-verdict")).toContainText("Out of date", { timeout: 20_000 });
  await expect(item).toContainText("E2E: the pin moved on");
  await item.locator(".wiki-stale-fix summary").click();
  await expect(item.locator(".wiki-stale-fix")).toContainText("landed on 18.06");
  // One SDK request: a Claude CLI call reaches this fake too, as several requests.
  expect(modelAgents.map((a) => a.split("/")[0])).toEqual(["Anthropic"]);
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
  const staleGets: string[] = [];
  p.on("request", (r) => {
    if (r.url().includes("/api/wiki/stale")) staleGets.push(r.url());
  });
  await openHub(p, RO_BASE);
  await expect(p.locator('.wiki-conn-tab[data-conntab="conn"]')).toBeVisible();
  await expect(p.locator('.wiki-conn-tab[data-conntab="stale"]')).toBeHidden();
  await expect(p.locator("#staleBody")).toBeHidden();
  // Both halves hold on their own (A15): the client never asks for the report
  // (the CSS hide alone would leave it fetched), and a click that reaches the
  // tab anyway leaves the rail on Connections, marked as the active tab (A12).
  await p.locator('.wiki-conn-tab[data-conntab="conn"]').click();
  await p.evaluate(() => (document.querySelector('.wiki-conn-tab[data-conntab="stale"]') as HTMLElement).click());
  await expect(p.locator('.wiki-conn-tab[data-conntab="conn"]')).toHaveClass(/\bactive\b/);
  await expect(p.locator('.wiki-conn-tab[data-conntab="stale"]')).not.toHaveClass(/\bactive\b/);
  await expect(p.locator("#connBody")).toBeVisible();
  expect(await p.locator("#staleBody").evaluate((el) => (el as HTMLElement).style.display)).toBe("none");
  expect(staleGets).toEqual([]);
  // The routes refuse there too.
  const res = await p.request.post(`${RO_BASE}/api/wiki/stale/verdict`, {
    headers: { "content-type": "application/json", origin: RO_BASE },
    data: { wiki: WIKI, page: "hub.md", kind: "status-line", line: 5, verdict: "true" },
  });
  expect(res.status()).toBe(403);
});

test("leaving a page mid-Check aborts its stream, and coming back paints nothing from it (A9)", async ({ page: p }) => {
  held = new Promise<void>((r) => (releaseHeld = r));
  heldCalls = 0;
  try {
    await p.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent("hub2.md")}`);
    await expect(p.locator(".wiki-article")).toContainText("Second hub.");
    await p.locator('.wiki-conn-tab[data-conntab="stale"]').click();
    const aborted = p.waitForEvent("requestfailed", (r) => r.url().includes("/api/wiki/stale/check"));
    await p.locator("#wikiStaleCheckBtn").click();
    await expect.poll(() => heldCalls, { timeout: 15_000 }).toBe(1);
    await p.locator(".wiki-article a", { hasText: "the plan page" }).click();
    await expect(p.locator(".wiki-article")).toContainText("The plan.");
    expect((await aborted).failure()?.errorText ?? "").toMatch(/abort/i);
    await p.goBack();
    await expect(p.locator(".wiki-article")).toContainText("Second hub.");
    await expect(p.locator('[data-stale-linking="notes/two.md"]')).toBeVisible();
    releaseHeld();
    // The server finishes the call it had in flight; no stream is left to paint it.
    await p.waitForTimeout(1_500);
    await expect(p.locator('[data-stale-linking="notes/two.md"] .wiki-stale-verdict')).toHaveCount(0);
    await expect(p.locator("#wikiStaleCheckBtn")).toBeEnabled();
    expect(heldCalls).toBe(1);
  } finally {
    releaseHeld();
  }
});

test("an Ask answer, an issue graph and a page that fails to load each abort the Check, and nothing paints (A9)", async ({ page: p }) => {
  // The issue graph needs a tracker; the fixture wiki declares none.
  await p.route(
    (u) => u.pathname === "/api/wiki/pages",
    async (r) => {
      const res = await r.fetch();
      const json = (await res.json()) as Record<string, unknown>;
      await r.fulfill({ response: res, json: { ...json, trackers: [{ id: "jira", label: "Jira" }] } });
    },
  );
  await p.route((u) => u.pathname === "/api/wiki/ask", (r) => r.fulfill({ status: 200, contentType: "text/event-stream", body: "" }));
  const leave: Record<(typeof LEAVE_ROUTES)[number], () => Promise<void>> = {
    ask: async () => {
      await p.locator('.wiki-conn-tab[data-conntab="ask"]').click();
      await p.locator("#wikiAskInput").fill("What moved?");
      await p.locator("#wikiAskBtn").click();
      await expect(p.locator("#articleWrap")).toContainText("What moved?");
    },
    graph: async () => {
      await p.evaluate(() => {
        history.pushState({}, "", `${location.pathname}?wiki=e2estale&display=graph&issue=jira%3ADEMO-1`);
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect(p.locator("#articleWrap h1")).toHaveText("DEMO-1");
    },
    fail: async () => {
      await p.route((u) => u.pathname === "/api/wiki/page", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ error: "E2E page gone" }) }));
      await p.locator('[data-stale-linking="notes/hold-fail.md"] .wiki-stale-link').click();
      await expect(p.locator("#articleWrap")).toContainText("E2E page gone");
    },
  };
  for (const n of LEAVE_ROUTES) {
    hold = new Promise<void>((r) => (releaseHold = r));
    holdCalls = 0;
    try {
      await openPage(p, `hub-${n}.md`, `The ${n} hub moved.`);
      const aborted = p.waitForEvent("requestfailed", { predicate: (r) => r.url().includes("/api/wiki/stale/check"), timeout: 10_000 });
      await p.locator("#wikiStaleCheckBtn").click();
      await expect.poll(() => holdCalls, { timeout: 15_000 }).toBe(1);
      await leave[n]();
      expect((await aborted).failure()?.errorText ?? "", n).toMatch(/abort/i);
      releaseHold();
      // The server finishes the call it had in flight; no stream is left to paint it.
      await p.waitForTimeout(1_500);
      await expect(p.locator(`[data-stale-linking="notes/hold-${n}.md"] .wiki-stale-verdict`), n).toHaveCount(0);
    } finally {
      releaseHold();
    }
  }
});

test("Check paints each verdict as it streams, shows a failed call on its row, and keeps an open Draft fix open (A15, A12)", async ({ page: p }) => {
  slow = new Promise<void>((r) => (releaseSlow = r));
  slowCalls = 0;
  try {
    await openPage(p, "hub3.md", "The third hub moved.");
    await p.locator("#wikiStaleCheckBtn").click();
    await expect.poll(() => slowCalls, { timeout: 15_000 }).toBe(1);
    // The slow call is still held, so the stream is still open: what shows now
    // was painted from the stream, not from a write at its end.
    const fast = p.locator('[data-stale-linking="notes/fast.md"]');
    await expect(fast.locator(".wiki-stale-verdict")).toContainText("Out of date", { timeout: 10_000 });
    const bad = p.locator('[data-stale-linking="notes/bad.md"]');
    await expect(bad.locator("[data-stale-row-error]")).toHaveText("Not checked: The model's answer could not be read.");
    await expect(p.locator("#wikiStaleProgress")).toHaveText("1 of 3 checked · 1 failed");
    await expect(p.locator("#wikiStaleCheckBtn")).toBeDisabled();
    expect(slowCalls).toBe(1);
    await fast.locator(".wiki-stale-fix summary").click();
    await expect(fast.locator(".wiki-stale-fix")).toHaveAttribute("open", "");
    releaseSlow();
    await expect(p.locator('[data-stale-linking="notes/slow.md"] .wiki-stale-verdict')).toContainText("Out of date", { timeout: 10_000 });
    await expect(p.locator("#wikiStaleCheckBtn")).toBeEnabled();
    // Repainted by the slow verdict and by the reload after the stream: still open.
    await expect(fast.locator(".wiki-stale-fix")).toHaveAttribute("open", "");
    await expect(bad.locator("[data-stale-row-error]")).toBeVisible();
    await expect(p.locator("#wikiStaleProgress")).toHaveText("2 of 3 checked · 1 failed");
    await expect(p.locator("#wikiStaleCheckBtn")).toHaveText("Check 1 page");
  } finally {
    releaseSlow();
  }
});

test("a verdict that is not saved says so above the report, and a page that fails to load clears the report (A12)", async ({ page: p }) => {
  await openPage(p, "hub3.md", "The third hub moved.");
  const verdictRoute = (u: URL) => u.pathname === "/api/wiki/stale/verdict";
  await p.route(verdictRoute, (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "E2E store down" }) }));
  await p.locator('[data-stale-linking="notes/fast.md"] [data-stale-verdict="true"]').click();
  // The notice, not the check bar's progress line, carries it: a page with no
  // check bar shows it the same way (the unit test renders that case).
  await expect(p.locator("[data-stale-notice]")).toHaveText("The verdict was not saved: E2E store down.");
  await expect(p.locator("#wikiStaleProgress")).not.toContainText("E2E store down");
  await p.unroute(verdictRoute);
  // The next page fails to load: the tab drops hub3's report and says why.
  await expect(p.locator("#wikiStaleCount")).not.toHaveText("");
  await p.route((u) => u.pathname === "/api/wiki/page", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ error: "E2E page gone" }) }));
  await p.locator('[data-stale-linking="notes/fast.md"] .wiki-stale-link').click();
  await expect(p.locator(".wiki-article, #articleWrap").first()).toContainText("E2E page gone");
  await expect(p.locator("#staleBody")).toHaveText("Stale check unavailable: the page did not load");
  await expect(p.locator("#wikiStaleCount")).toHaveText("");
});

test("Check says when it stopped at its call limit and how many pages remain (A12)", async ({ page: p }) => {
  await openPage(p, "hub4.md", "The fourth hub moved.");
  await expect(p.locator("#wikiStaleCheckBtn")).toHaveText("Check 11 pages");
  await p.locator("#wikiStaleCheckBtn").click();
  await expect(p.locator("[data-stale-cap]")).toHaveText("Check makes at most 10 calls at a time: 1 page still to check. Check again for the rest.", { timeout: 20_000 });
  // The limit line reads at the body text's contrast, not the dim note's (AA 4.5:1).
  const tokenColor = await p.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--text-secondary)";
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  expect(await p.locator("[data-stale-cap]").evaluate((el) => getComputedStyle(el).color)).toBe(tokenColor);
  await expect(p.locator("#wikiStaleCheckBtn")).toHaveText("Check 1 page");
  await expect(p.locator("#wikiStaleProgress")).toHaveText("10 of 11 checked");
});

test("a read-only root keeps the tab, and Check and the verdict buttons send nothing (A15)", async ({ page: p }) => {
  const posts: string[] = [];
  p.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/wiki/stale/")) posts.push(r.url());
  });
  await openHub(p, BASE, RO_WIKI);
  const tab = p.locator('.wiki-conn-tab[data-conntab="stale"]');
  await expect(tab).toBeVisible();
  await expect(p.locator("#wikiStaleCount")).toHaveText("1 · 1");
  await tab.click();
  await expect(p.locator("#staleBody")).toContainText(CONFIRMED_LINE);
  await p.locator("#wikiStaleCheckBtn").click();
  await p.locator('[data-stale-hit] [data-stale-verdict="true"]').click();
  await p.locator('[data-stale-linking="notes/old.md"] [data-stale-verdict="not-status"]').click();
  await p.waitForTimeout(500);
  expect(posts).toEqual([]);
  await expect(p.locator("#wikiStaleCheckBtn")).toHaveText("Check 1 page");
  // The routes refuse there too.
  const res = await p.request.post(`${BASE}/api/wiki/stale/check`, {
    headers: { "content-type": "application/json", origin: BASE },
    data: { wiki: RO_WIKI, page: "hub.md" },
  });
  expect(res.status()).toBe(403);
  const rows = await sql!`SELECT kind FROM wiki_stale_verdicts WHERE wiki = ${RO_WIKI} AND checked_by <> 'model:e2e'`;
  expect(rows.length).toBe(0);
});

/** Open `rel` the way Back/Forward does: a popstate, no click. */
async function nav(p: Page, rel: string | null): Promise<void> {
  await p.evaluate(([r, wiki]) => {
    history.pushState(r ? { relPath: r } : {}, "", `${location.pathname}?wiki=${wiki}` + (r ? `&relPath=${encodeURIComponent(r)}` : ""));
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [rel, WIKI] as const);
}

/** Hold `/api/wiki/page` for `rel` until `release()`, then answer it as `kind` ("load": the real page). */
async function holdPageThenFail(p: Page, rel: string, kind: "error" | "abort" | "load"): Promise<{ release: () => void; asked: Promise<void> }> {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let markAsked: () => void = () => {};
  const asked = new Promise<void>((r) => (markAsked = r));
  await p.route(
    (u) => u.pathname === "/api/wiki/page" && u.searchParams.get("relPath") === rel,
    async (r) => {
      markAsked();
      await gate;
      if (kind === "abort") await r.abort();
      else if (kind === "load") await r.continue();
      else await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ error: "E2E late gone" }) });
    },
  );
  return { release, asked };
}

test("a page left behind that fails late leaves the next page's report and its Check alone (R2B4 1a)", async ({ page: p }) => {
  for (const k of LATE_KINDS) {
    hold = new Promise<void>((r) => (releaseHold = r));
    holdCalls = 0;
    try {
      await openPage(p, "hub-view.md", "The view hub moved.");
      const expl = k.startsWith("explainer");
      const lateRel = expl ? "docs/late-expl.html" : `late-${k}.md`;
      const how = k === "explainer" ? "error" : expl ? (k.slice("explainer-".length) as "abort" | "load") : (k as "error" | "abort" | "load");
      const late = await holdPageThenFail(p, lateRel, how);
      const checkFailed: string[] = [];
      p.on("requestfailed", (r) => {
        if (r.url().includes("/api/wiki/stale/check")) checkFailed.push(k);
      });
      await nav(p, lateRel);
      await late.asked;
      await nav(p, `hub-late-${k}.md`);
      await expect(p.locator(".wiki-article"), k).toContainText(`The late-${k} hub moved.`);
      const row = p.locator(`[data-stale-linking="notes/hold-late-${k}.md"]`);
      await expect(row, k).toBeVisible();
      await p.locator("#wikiStaleCheckBtn").click();
      await expect.poll(() => holdCalls, { timeout: 15_000 }).toBe(1);
      late.release();
      // The late failure lands; it belongs to a page no longer on screen.
      await p.waitForTimeout(800);
      await expect(p.locator(".wiki-article"), k).toContainText(`The late-${k} hub moved.`);
      await expect(p.locator(".wiki-article"), k).not.toContainText("Never shown.");
      await expect(p.locator("#staleBody"), k).not.toContainText("Stale check unavailable");
      await expect(row, k).toBeVisible();
      await expect(p.locator("#wikiStaleCheckBtn"), k).toBeDisabled();
      releaseHold();
      await expect(row.locator(".wiki-stale-verdict"), k).toContainText("Out of date", { timeout: 10_000 });
      expect(checkFailed, k).toEqual([]);
    } finally {
      releaseHold();
      await p.unrouteAll({ behavior: "ignoreErrors" });
    }
  }
});

test("every view off a page drops its report, and an explainer never shows the last page's (R2B4 1b)", async ({ page: p }) => {
  const row = p.locator('[data-stale-linking="notes/view-link.md"]');
  const empty = "Select a page to see what may be stale.";
  const leave: Record<(typeof VIEW_ROUTES)[number], () => Promise<void>> = {
    ask: async () => {
      await p.locator('.wiki-conn-tab[data-conntab="ask"]').click();
      await p.locator("#wikiAskInput").fill("What moved?");
      await p.locator("#wikiAskBtn").click();
      await expect(p.locator("#articleWrap")).toContainText("What moved?");
      await expect(p.locator("#staleBody")).toHaveText(empty);
    },
    graph: async () => {
      await p.evaluate(() => {
        history.pushState({}, "", `${location.pathname}?wiki=e2estale&display=graph&issue=jira%3ADEMO-1`);
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect(p.locator("#articleWrap h1")).toHaveText("DEMO-1");
      await expect(p.locator("#staleBody")).toHaveText(empty);
    },
    start: async () => {
      await nav(p, null);
      await expect(p.locator(".wiki-start")).toBeVisible();
      await expect(p.locator("#staleBody")).toHaveText(empty);
    },
    explainer: async () => {
      // Its page response is held: until it lands the tab shows no report, not the last page's.
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      await p.route((u) => u.pathname === "/api/wiki/page" && u.searchParams.get("relPath") === EXPLAINER, async (r) => {
        await gate;
        await r.continue();
      });
      await nav(p, EXPLAINER);
      await expect(p.locator(".wiki-explainer-frame")).toBeVisible();
      await expect(row).toHaveCount(0);
      await expect(p.locator("#wikiStaleCount")).toHaveText("");
      release();
    },
    page: async () => {
      await nav(p, "hub-other.md");
      await expect(p.locator(".wiki-article")).toContainText("The other hub moved.");
      await expect(p.locator('[data-stale-linking="notes/other-link.md"]')).toBeVisible();
    },
  };
  await p.route(
    (u) => u.pathname === "/api/wiki/pages",
    async (r) => {
      const res = await r.fetch();
      const json = (await res.json()) as Record<string, unknown>;
      await r.fulfill({ response: res, json: { ...json, trackers: [{ id: "jira", label: "Jira" }] } });
    },
  );
  await p.route((u) => u.pathname === "/api/wiki/ask", (r) => r.fulfill({ status: 200, contentType: "text/event-stream", body: "" }));
  for (const v of VIEW_ROUTES) {
    await openPage(p, "hub-view.md", "The view hub moved.");
    await expect(row, v).toBeVisible();
    await expect(p.locator("#wikiStaleCount"), v).toHaveText("0 · 1");
    await leave[v]();
    await expect(row, v).toHaveCount(0);
  }
});

test("a fold stays as the reader left it on that page only (R2B4 2)", async ({ page: p }) => {
  await openPage(p, "hub-fold-a.md", "The fold-a hub moved.");
  const toCheck = p.locator('[data-bucket="toCheck"]');
  await expect(toCheck).toHaveAttribute("open", "");
  await toCheck.locator("summary").click();
  await expect(toCheck).not.toHaveAttribute("open", "");
  // Check repaints the tab on every frame and reloads it at the end: the fold holds.
  await p.locator("#wikiStaleCheckBtn").click();
  await expect(p.locator('[data-stale-linking="notes/fold-a.md"] .wiki-stale-verdict')).toHaveCount(1, { timeout: 15_000 });
  await expect(p.locator("#wikiStaleCheckBtn")).toHaveText("Check again");
  await expect(toCheck).not.toHaveAttribute("open", "");
  // The next page has its own folds: To check opens there.
  await nav(p, "hub-fold-b.md");
  await expect(p.locator(".wiki-article")).toContainText("The fold-b hub moved.");
  await expect(p.locator('[data-stale-linking="notes/fold-b.md"]')).toBeVisible();
  await expect(toCheck).toHaveAttribute("open", "");
});

test("a reader verdict clears that row's Check error and the stale progress line (R2B4 3)", async ({ page: p }) => {
  await openPage(p, "hub-bad.md", "The bad hub moved.");
  await p.locator("#wikiStaleCheckBtn").click();
  const bad = p.locator('[data-stale-linking="notes/bad-row.md"]');
  await expect(bad.locator("[data-stale-row-error]")).toBeVisible({ timeout: 15_000 });
  await expect(p.locator("#wikiStaleCheckBtn")).toBeEnabled();
  await expect(p.locator("#wikiStaleProgress")).toHaveText("1 of 2 checked · 1 failed");
  await bad.locator('[data-stale-verdict="true"]').click();
  await expect(bad.locator(".wiki-stale-verdict")).toContainText("Still true");
  await expect(bad.locator("[data-stale-row-error]")).toHaveCount(0);
  await expect(p.locator("#wikiStaleCheckBtn")).toHaveText("Check again");
  await expect(p.locator("#wikiStaleProgress")).toHaveText("2 of 2 checked");
});

test("a reader verdict on the page Check left at its limit clears the limit line (R2B4 3)", async ({ page: p }) => {
  await openPage(p, "hub-cap.md", "The cap hub moved.");
  await p.locator("#wikiStaleCheckBtn").click();
  const cap = p.locator("[data-stale-cap]");
  await expect(cap).toContainText("1 page still to check", { timeout: 20_000 });
  const left = p.locator('[data-bucket="toCheck"] .wiki-stale-item').filter({ hasNot: p.locator(".wiki-stale-verdict") });
  await expect(left).toHaveCount(1);
  await left.locator('[data-stale-verdict="true"]').click();
  await expect(p.locator("#wikiStaleCheckBtn")).toHaveText("Check again");
  await expect(cap).toHaveCount(0);
  await expect(p.locator('[data-bucket="toCheck"] .wiki-stale-item .wiki-stale-verdict')).toHaveCount(11);
});

test("an unsaved-verdict notice is inserted once and cleared by the next saved verdict (R2B4)", async ({ page: p }) => {
  await openPage(p, "hub-notice.md", "The notice hub moved.");
  const verdictRoute = (u: URL) => u.pathname === "/api/wiki/stale/verdict";
  await p.route(verdictRoute, (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "E2E store down" }) }));
  await p.locator('[data-stale-linking="notes/notice-a.md"] [data-stale-verdict="true"]').click();
  const notice = p.locator("[data-stale-notice]");
  await expect(notice).toHaveText("The verdict was not saved: E2E store down.");
  await expect(notice).toHaveAttribute("role", "alert");
  await notice.evaluate((el) => {
    const n = el as HTMLElement & { e2eMark?: number; e2eWrites?: number };
    n.e2eMark = 1;
    n.e2eWrites = 0;
    new MutationObserver((recs) => (n.e2eWrites! += recs.length)).observe(n, { childList: true, characterData: true, subtree: true });
  });
  // Check repaints the tab several times: the alert node is the same one, never
  // re-inserted, and its unchanged text is never written again (one announcement).
  await p.locator("#wikiStaleCheckBtn").click();
  await expect(p.locator('[data-stale-linking="notes/notice-a.md"] .wiki-stale-verdict')).toHaveCount(1, { timeout: 15_000 });
  await expect(p.locator("#wikiStaleCheckBtn")).toBeEnabled();
  expect(await notice.evaluate((el) => (el as HTMLElement & { e2eMark?: number }).e2eMark)).toBe(1);
  await expect(notice).toHaveText("The verdict was not saved: E2E store down.");
  expect(await notice.evaluate((el) => (el as HTMLElement & { e2eWrites?: number }).e2eWrites)).toBe(0);
  await p.unroute(verdictRoute);
  await p.locator('[data-stale-linking="notes/notice-b.md"] [data-stale-verdict="true"]').click();
  await expect(p.locator('[data-stale-linking="notes/notice-b.md"] .wiki-stale-verdict')).toContainText("Still true");
  await expect(notice).toBeHidden();
  await expect(notice).not.toHaveText(/./);
});

test("a page that fails to load clears the report on every failure path (R2B4)", async ({ page: p }) => {
  const paths: [string, string, "error" | "abort"][] = [
    ["markdown reject", "late-abort.md", "abort"],
    ["explainer error", EXPLAINER, "error"],
    ["explainer reject", EXPLAINER, "abort"],
  ];
  for (const [name, rel, kind] of paths) {
    await openPage(p, "hub-pin.md", "The pin hub moved.");
    await expect(p.locator('[data-stale-linking="notes/pin-link.md"]'), name).toBeVisible();
    const fail = await holdPageThenFail(p, rel, kind);
    fail.release();
    await nav(p, rel);
    await expect(p.locator("#staleBody"), name).toHaveText("Stale check unavailable: the page did not load");
    await expect(p.locator("#wikiStaleCount"), name).toHaveText("");
    await p.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("an older report that answers late does not replace a newer one (R2B4 1)", async ({ page: p }) => {
  await openPage(p, "hub-race.md", "The race hub moved.");
  // The report after the first verdict is read from the server at once but handed over late.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let gets = 0;
  await p.route(
    (u) => u.pathname === "/api/wiki/stale",
    async (r) => {
      if (++gets > 1) return r.continue();
      const res = await r.fetch();
      await gate;
      await r.fulfill({ response: res });
    },
  );
  const a = p.locator('[data-stale-linking="notes/race-a.md"]');
  const b = p.locator('[data-stale-linking="notes/race-b.md"]');
  await a.locator('[data-stale-verdict="true"]').click();
  await expect.poll(() => gets).toBe(1);
  await b.locator('[data-stale-verdict="true"]').click();
  await expect(b.locator(".wiki-stale-verdict")).toContainText("Still true");
  await expect(a.locator(".wiki-stale-verdict")).toContainText("Still true");
  release();
  await p.waitForTimeout(800);
  await expect(b.locator(".wiki-stale-verdict")).toContainText("Still true");
});

test("the reloaded report clears a failed Check row only where a reader gave the verdict (R2B4 3)", async ({ page: p }) => {
  await openPage(p, "hub-recon.md", "The recon hub moved.");
  const a = p.locator('[data-stale-linking="notes/recon-a.md"]');
  const b = p.locator('[data-stale-linking="notes/recon-b.md"]');
  await expect(b).toBeVisible();
  // Check fails on both rows; the report read after it carries a reader verdict
  // on one and a model verdict (another tab's Check) on the other.
  let checked = false;
  await p.route(
    (u) => u.pathname === "/api/wiki/stale/check",
    (r) => {
      checked = true;
      const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      return r.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body:
          frame("start", { changed: "hub-recon.md", toCheck: 2, cached: 0, toCall: 2, left: 0 }) +
          frame("error", { relPath: "notes/recon-a.md", message: "E2E call failed" }) +
          frame("error", { relPath: "notes/recon-b.md", message: "E2E call failed" }) +
          frame("done", { left: 0 }),
      });
    },
  );
  await p.route(
    (u) => u.pathname === "/api/wiki/stale",
    async (r) => {
      const res = await r.fetch();
      if (!checked) return r.fulfill({ response: res });
      const json = (await res.json()) as StaleReportJson;
      for (const l of json.buckets?.linking ?? []) {
        if (l.relPath === "notes/recon-a.md") l.verdict = { verdict: "true", checkedBy: "reader" };
        if (l.relPath === "notes/recon-b.md") l.verdict = { verdict: "stale", reason: "E2E model verdict", checkedBy: "model:e2e" };
      }
      return r.fulfill({ response: res, json });
    },
  );
  await p.locator("#wikiStaleCheckBtn").click();
  await expect(a.locator(".wiki-stale-by")).toHaveText("by a reader");
  await expect(b.locator(".wiki-stale-verdict")).toContainText("E2E model verdict");
  await expect(a.locator("[data-stale-row-error]")).toHaveCount(0);
  await expect(b.locator("[data-stale-row-error]")).toHaveText("Not checked: E2E call failed");
  await p.unrouteAll({ behavior: "ignoreErrors" });
});

test("opening the page on screen again keeps its folds and its notice (R2B4)", async ({ page: p }) => {
  await openPage(p, "hub-same.md", "The same hub moved.");
  const verdictRoute = (u: URL) => u.pathname === "/api/wiki/stale/verdict";
  await p.route(verdictRoute, (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "E2E store down" }) }));
  await p.locator('[data-stale-linking="notes/same-link.md"] [data-stale-verdict="true"]').click();
  const notice = p.locator("[data-stale-notice]");
  await expect(notice).toHaveText("The verdict was not saved: E2E store down.");
  await p.unroute(verdictRoute);
  const toCheck = p.locator('[data-bucket="toCheck"]');
  await toCheck.locator("summary").click();
  await expect(toCheck).not.toHaveAttribute("open", "");
  // The rail row of the page on screen: a fresh page load of the same page.
  const reloaded = p.waitForResponse((r) => r.url().includes("/api/wiki/page?") && r.url().includes("hub-same.md"));
  const restale = p.waitForResponse((r) => r.url().includes("/api/wiki/stale?") && r.url().includes("hub-same.md"));
  await p.locator('.wiki-list-item[data-relpath="hub-same.md"]').first().click();
  await reloaded;
  await restale;
  await p.waitForTimeout(300);
  await expect(p.locator('[data-stale-linking="notes/same-link.md"]')).toBeAttached();
  await expect(notice).toHaveText("The verdict was not saved: E2E store down.");
  await expect(toCheck).not.toHaveAttribute("open", "");
});

test("a page load left for the start view leaves no navigation in flight: a fresh listing lands there (R2B4)", async ({ page: p }) => {
  await p.clock.install();
  await openPage(p, "hub-view.md", "The view hub moved.");
  const late = await holdPageThenFail(p, "late-load.md", "load");
  await nav(p, "late-load.md");
  await late.asked;
  await nav(p, null);
  await expect(p.locator(".wiki-start")).toBeVisible();
  const landed = p.waitForResponse((r) => r.url().includes("/api/wiki/page?") && r.url().includes("late-load.md"));
  late.release();
  await landed;
  await p.waitForTimeout(300);
  await expect(p.locator(".wiki-start")).toBeVisible();
  // A page written after load; past the refetch throttle the tab regains focus.
  await write("notes/listed-late.md", page("Listed late", "Written after the reader loaded."));
  const listed = p.waitForResponse((r) => r.url().includes("/api/wiki/pages") && r.url().includes("refresh=1"));
  await p.clock.fastForward(31_000);
  await p.evaluate(() => window.dispatchEvent(new Event("focus")));
  await listed;
  // The start view adopts it; a navigation left in flight would stash it.
  await expect(p.locator('.wiki-list-item[data-relpath="notes/listed-late.md"]').first()).toBeAttached();
  await p.unrouteAll({ behavior: "ignoreErrors" });
});
