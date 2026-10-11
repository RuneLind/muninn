/**
 * The Agent lens (reader lenses PR 5, D4/D7): the reader's third lens shows
 * the plan-card output for a plan page, word for word.
 *
 * What the unit tests cannot reach: the server's `agentLens` flag arriving in
 * the shell and becoming a button only on a plan page, the click reaching a
 * real spawn through the route, the pane painting the card byte for byte with
 * its size and cut list, the since/id inputs reaching argv, Agent never being
 * stored (D1), `?lens=agent` falling back to All where the lens is absent (D2),
 * the origin guard refusing a cross-site GET, and — the named acceptance — the
 * pane text equalling a direct `bun --no-env-file plan-card.ts <path> --json`
 * run with the same environment.
 *
 * Five muninns: a STUB `PLAN_CARD_BIN` (a `.ts` that echoes its argv and
 * environment names as the card), one with the variable unset (501, no
 * button), one with the REAL `~/.claude/skills/plan-card/plan-card.ts` (that
 * case skips itself where the skills repo is not checked out — CI), and the
 * nais profile at role user and admin (no button, no route). The fixture wikis
 * are OS temp dirs registered via `WIKI_EXTRA` and listed in
 * `WIKI_STAMP_ROOTS`, which is plan-card's roots variable too: `e2e-agent`
 * (English), and `e2e-agent-no` (`language: no`, with a `trackers` block so
 * graph mode has a toggle).
 *
 * Fix round 1 adds: leaving Agent restores the article and its head controls;
 * every reveal path (hash, pill) switches Agent to All; `?lens=agent` runs
 * once and is spent by the first render of any kind (a failed or rejected
 * load, the start view, an explainer); re-entering Agent runs again; a new
 * run aborts the one in flight; an in-place reload (a fact-check append) keeps
 * the card and starts no child; graph mode hides the pane; the card's leading
 * newline survives; the pane speaks the wiki's language.
 *
 * Fix round 2 adds: a pane built while graph mode is on stays hidden; an issue
 * graph spends `?lens=agent`; the live region is the status line, not the body.
 */

import { test, expect } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { ROLE_PAGE, ROLE_REL } from "./oppfolging-fixture.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const PORT = e2ePort("wiki-agent-lens");
const BASE = `http://127.0.0.1:${PORT}`;
const UNSET = `http://127.0.0.1:${e2ePort("wiki-agent-lens/unset")}`;
const REAL_PORT = e2ePort("wiki-agent-lens/real");
const REAL = `http://127.0.0.1:${REAL_PORT}`;
const NAIS_USER = `http://127.0.0.1:${e2ePort("wiki-agent-lens/nais-user")}`;
const NAIS_ADMIN = `http://127.0.0.1:${e2ePort("wiki-agent-lens/nais-admin")}`;
const REAL_BIN = path.join(homedir(), ".claude/skills/plan-card/plan-card.ts");
const HAS_REAL = existsSync(REAL_BIN);
const SECRET = "e2e-agent-lens-secret-0123456789";
const VIA_PROXY = { "x-forwarded-for": "203.0.113.9", "x-muninn-token": SECRET };

const WIKI = "e2e-agent";
const PLAN = "plans/agent-plan.mdx";
const NOTE = "notes/plain-note.md";
const EXPLAINER = "notes/explainer.html";
const WIKI_NO = "e2e-agent-no";
const CASES = ["- id: MEL-1", "  status: hold", "- id: MEL-3", "  status: none", "- id: MEL-4", "  status: none", ""].join("\n");
const PLAN_PAGE = [
  "---",
  "title: Agent plan",
  "plan_status: in-flight",
  "status_date: 2026-10-07",
  "---",
  "",
  "# Agent plan",
  "",
  "## Brief",
  "",
  "<StatusRows>",
  "",
  "- **Status:** in-flight · next: PR 5",
  "",
  "</StatusRows>",
  "",
  "<DecisionLog>",
  "",
  "- **D1** — The lens shows the real card. Rune, 08.10.2026.",
  "- **S1** — Open question, asked 09.10.",
  "",
  "</DecisionLog>",
  "",
  "## Current state",
  "",
  "Working on D1 (`src/main/Gate.kt:120-128`).",
  "",
  '<CaseBoard src="data/cases.yaml" />',
  "",
  '<Fold title="Older log">',
  "",
  "<DecisionLog>",
  "",
  "- **D2** — An older decision. Rune, 01.10.2026.",
  "",
  "</DecisionLog>",
  "",
  "</Fold>",
  "",
].join("\n");
const NOTE_PAGE = ["---", "title: Plain note", "---", "", "# Plain note", "", "No plan here.", ""].join("\n");

const servers: ChildProcess[] = [];
let root = "";
let rootNo = "";
let stub = "";
let runs = "";
let botsDir = "";

function boot(port: number, env: Record<string, string>): void {
  servers.push(
    spawn("bun", ["run", "src/index.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...e2eEnv(),
        DASHBOARD_PORT: String(port),
        DASHBOARD_HOST: "127.0.0.1",
        SCHEDULER_ENABLED: "false",
        DATABASE_URL: TEST_DB,
        WIKI_EXTRA: `${WIKI}=${root},${WIKI_NO}=${rootNo}`,
        WIKI_STAMP_ROOTS: `${root}:${rootNo}`,
        ...env,
      },
      stdio: "ignore",
    }),
  );
}

async function waitUp(base: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/live`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("muninn did not start on " + base);
    await new Promise((r) => setTimeout(r, 400));
  }
}

test.beforeAll(async ({}, info) => {
  info.setTimeout(120_000);
  root = realpathSync(await mkdtemp(path.join(tmpdir(), "muninn-e2e-agent-")));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await mkdir(path.join(root, "notes"), { recursive: true });
  await writeFile(path.join(root, PLAN), PLAN_PAGE, "utf8");
  await writeFile(path.join(root, NOTE), NOTE_PAGE, "utf8");
  await writeFile(path.join(root, EXPLAINER), "<!doctype html><title>Explainer</title><h1>Explainer</h1>", "utf8");
  await mkdir(path.join(root, "plans", "data"), { recursive: true });
  await writeFile(path.join(root, "plans", "data", "cases.yaml"), CASES, "utf8");
  rootNo = realpathSync(await mkdtemp(path.join(tmpdir(), "muninn-e2e-agent-no-")));
  await mkdir(path.join(rootNo, "plans"), { recursive: true });
  // The shared Oppfølging page with role lanes, made a plan page: «Se som rolle».
  await writeFile(path.join(rootNo, ROLE_REL), ROLE_PAGE.replace("---\n", "---\nplan_status: in-flight\n"), "utf8");
  await writeFile(path.join(rootNo, PLAN), PLAN_PAGE.replace("(`src/main/Gate.kt:120-128`)", "").replace('<CaseBoard src="data/cases.yaml" />', ""), "utf8");
  await writeFile(
    path.join(rootNo, ".wiki-reader.json"),
    JSON.stringify({ language: "no", roleKeys: ["fag", "utvikler"], trackers: [{ id: "jira", projects: ["DEMO"], hosts: ["example.invalid"] }] }),
    "utf8",
  );
  stub = path.join(root, "..", `plan-card-stub-${process.pid}.ts`);
  runs = path.join(root, "..", `plan-card-runs-${process.pid}.txt`);
  await writeFile(
    stub,
    [
      "import { appendFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(runs)}, JSON.stringify(args) + "\\n");`,
      "if (args.includes('SLOW')) await Bun.sleep(800);",
      "const env = Object.keys(process.env).sort().join(',');",
      "const lead = args.includes('LEADLF') ? '\\n' : '';",
      "const text = lead + '# Stub card\\nARGS ' + JSON.stringify(args) + '\\nENV ' + env + '\\nMUNINN ' + process.env.PLAN_CARD_MUNINN_URL;",
      "console.log(JSON.stringify({ text, chars: text.length, cuts: [{ section: 'brief', pointer: 'Brief continues, sed -n 9,20p /x/p.mdx', start: 9, end: 20, file: '/x/p.mdx' }] }));",
      "",
    ].join("\n"),
    "utf8",
  );
  botsDir = await mkdtemp(path.join(tmpdir(), "muninn-e2e-agent-bots-"));
  await mkdir(path.join(botsDir, "e2e-agent-bot"));
  await writeFile(path.join(botsDir, "e2e-agent-bot", "CLAUDE.md"), "# throwaway e2e bot, no wiki\n", "utf8");

  boot(PORT, { PLAN_CARD_BIN: stub });
  boot(e2ePort("wiki-agent-lens/unset"), {});
  if (HAS_REAL) boot(REAL_PORT, { PLAN_CARD_BIN: REAL_BIN });
  for (const [name, role] of [["wiki-agent-lens/nais-user", "user"], ["wiki-agent-lens/nais-admin", "admin"]] as const) {
    const port = e2ePort(name);
    boot(port, {
      PLAN_CARD_BIN: stub,
      MUNINN_PROFILE: "nais",
      MUNINN_AUTH: "local",
      MUNINN_LOCAL_TOKEN: SECRET,
      MUNINN_LOCAL_USER: "e2e-agent-reader",
      MUNINN_LOCAL_ROLE: role,
      MUNINN_ADMIN_IDENTS: "A123456",
      MUNINN_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
      WIKI_READONLY_ROOTS: root,
      MUNINN_BOTS_DIR: botsDir,
    });
  }
  await Promise.all([BASE, UNSET, NAIS_USER, NAIS_ADMIN, ...(HAS_REAL ? [REAL] : [])].map(waitUp));
});

test.afterAll(async () => {
  for (const s of servers) s.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
  if (rootNo) await rm(rootNo, { recursive: true, force: true });
  if (botsDir) await rm(botsDir, { recursive: true, force: true });
  for (const f of [stub, runs]) if (f) await rm(f, { force: true });
});

const pageUrl = (base: string, rel: string, extra = "") => `${base}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}${extra}`;

test.describe("Wiki reader: the Agent lens", () => {
  test("the button runs plan-card and the pane shows its card word for word", async ({ page }) => {
    await page.goto(pageUrl(BASE, PLAN));
    const agent = page.locator('.wiki-lens-switch button[data-lens="agent"]');
    await expect(agent).toBeVisible();
    // Opening the page starts no child (D1).
    await expect(page.locator(".wiki-agent-pane")).toHaveCount(0);
    await agent.click();
    const pane = page.locator(".wiki-agent-pane");
    const text = pane.locator(".wiki-agent-text");
    await expect(text).toContainText("# Stub card");
    await expect(page.locator(".wiki-article")).toBeHidden();
    const shown = await text.textContent();
    expect(shown).toContain(`ARGS ${JSON.stringify([path.join(root, PLAN), "--json"])}`);
    expect(shown).toContain(`MUNINN http://127.0.0.1:${PORT}`);
    // The child's environment is the allowlist; muninn's own secrets stay out.
    const env = shown!.split("\n").find((l) => l.startsWith("ENV "))!.slice(4).split(",");
    expect(env).toContain("PLAN_CARD_MUNINN_URL");
    expect(env).toContain("WIKI_STAMP_ROOTS");
    expect(env).toContain("PATH");
    for (const secret of ["DATABASE_URL", "WIKI_EXTRA", "DASHBOARD_PORT", "PLAN_CARD_BIN"]) expect(env).not.toContain(secret);
    await expect(pane.locator(".wiki-agent-meta")).toHaveText(new RegExp(`^${shown!.length.toLocaleString("en-US")} / 12,000 chars · `));
    await expect(pane.locator(".wiki-agent-cuts li")).toHaveText(["brief L9-20 p.mdx — Brief continues, sed -n 9,20p /x/p.mdx"]);

    // since and id reach argv, validated.
    await pane.locator('input[name="since"]').fill("2026-10-07");
    await pane.locator('input[name="id"]').fill("S1");
    await pane.getByRole("button", { name: "Run plan-card" }).click();
    await expect(text).toContainText(`ARGS ${JSON.stringify([path.join(root, PLAN), "--since", "2026-10-07", "--id", "S1", "--json"])}`);
    await pane.locator('input[name="id"]').fill("-rf");
    await pane.getByRole("button", { name: "Run plan-card" }).click();
    await expect(pane.locator(".wiki-agent-error")).toContainText("(400)");

    // Agent is never stored (D1): a reload opens All, and starts no child.
    expect(await page.evaluate(() => localStorage.getItem("muninn.wiki.lens.v1"))).not.toBe("agent");
    await page.reload();
    await expect(page.locator(".wiki-article")).toHaveClass(/lens-all/);
    await expect(page.locator(".wiki-agent-pane")).toHaveCount(0);
  });

  test("a page without plan_status has no Agent button, and ?lens=agent there is All", async ({ page }) => {
    await page.goto(pageUrl(BASE, NOTE, "&lens=agent"));
    await expect(page.locator(".wiki-article")).toHaveClass(/lens-all/);
    await expect(page.locator('button[data-lens="agent"]')).toHaveCount(0);
    expect((await fetch(`${BASE}/api/wiki/plan-card?wiki=${WIKI}&relPath=${encodeURIComponent(NOTE)}`)).status).toBe(404);
  });

  test("one child per page and argument set: concurrent requests share it", async () => {
    await rm(runs, { force: true });
    const url = `${BASE}/api/wiki/plan-card?wiki=${WIKI}&relPath=${encodeURIComponent(PLAN)}&id=SLOW`;
    const [a, b] = await Promise.all([fetch(url), fetch(url)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect((await a.json()).text).toBe((await b.json()).text);
    expect((await readFile(runs, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  test("a cross-site GET is refused by the origin guard before any child starts", async () => {
    await rm(runs, { force: true });
    const url = `${BASE}/api/wiki/plan-card?wiki=${WIKI}&relPath=${encodeURIComponent(PLAN)}`;
    expect((await fetch(url, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await fetch(url, { headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect(existsSync(runs)).toBe(false);
  });

  test("with PLAN_CARD_BIN unset there is no button and the route answers 501", async ({ page }) => {
    await page.goto(pageUrl(UNSET, PLAN));
    await expect(page.locator(".wiki-article")).toBeVisible();
    await expect(page.locator('button[data-lens="agent"]')).toHaveCount(0);
    const res = await fetch(`${UNSET}/api/wiki/plan-card?wiki=${WIKI}&relPath=${encodeURIComponent(PLAN)}`);
    expect(res.status).toBe(501);
    expect((await res.json()).error).toContain("PLAN_CARD_BIN");
  });

  test("on the nais profile no viewer gets the lens, and the route is absent", async () => {
    for (const base of [NAIS_USER, NAIS_ADMIN]) {
      const res = await fetch(`${base}/api/wiki/page?wiki=${WIKI}&relPath=${encodeURIComponent(PLAN)}`, { headers: VIA_PROXY });
      expect([base, res.status]).toEqual([base, 200]);
      expect(((await res.json()) as { reader: { agentLens: boolean } }).reader.agentLens).toBe(false);
      const route = await fetch(`${base}/api/wiki/plan-card?wiki=${WIKI}&relPath=${encodeURIComponent(PLAN)}`, { headers: VIA_PROXY });
      expect([base, route.status]).not.toContainEqual(200);
      expect([403, 404]).toContain(route.status);
    }
  });

  test("leaving Agent restores the article: to All and to Overview, head controls and folds included", async ({ page }) => {
    await page.goto(pageUrl(BASE, PLAN));
    const article = page.locator(".wiki-article");
    const pane = page.locator(".wiki-agent-pane");
    const lineRefs = page.locator(".wiki-article-head .wiki-lineref-toggle");
    const noneFold = article.locator('.cb-group[data-status="none"] .cb-nonemore');
    const olderLog = article.locator("details.fold#older-log");
    await expect(lineRefs).toBeVisible();
    await expect(noneFold).toBeVisible();
    await page.locator('.wiki-lens-switch button[data-lens="agent"]').click();
    await expect(pane.locator(".wiki-agent-text")).toContainText("# Stub card");
    await expect(article).toBeHidden();
    // The article-only head controls go with the article (item 15).
    await expect(lineRefs).toBeHidden();
    await page.locator('.wiki-lens-switch button[data-lens="all"]').click();
    await expect(article).toBeVisible();
    await expect(pane).toBeHidden();
    await expect(lineRefs).toBeVisible();
    await expect(noneFold).toBeVisible();
    await expect(olderLog).not.toHaveAttribute("open", "");
    await page.locator('.wiki-lens-switch button[data-lens="agent"]').click();
    await expect(article).toBeHidden();
    await page.locator('.wiki-lens-switch button[data-lens="overview"]').click();
    await expect(article).toBeVisible();
    await expect(pane).toBeHidden();
    // Overview hides line refs (and its toggle) and the `none` group, and opens
    // the fold holding a DecisionLog (D41).
    await expect(lineRefs).toBeHidden();
    await expect(noneFold).toBeHidden();
    await expect(olderLog).toHaveAttribute("open", "");
  });

  test("a reveal while in Agent switches to All for this view: a hash and a header pill", async ({ page }) => {
    await page.goto(pageUrl(BASE, PLAN));
    const article = page.locator(".wiki-article");
    const agent = page.locator('.wiki-lens-switch button[data-lens="agent"]');
    await agent.click();
    await expect(page.locator(".wiki-agent-text")).toContainText("# Stub card");
    await page.evaluate(() => {
      location.hash = "#d1";
    });
    await expect(article).toHaveClass(/lens-all/);
    await expect(article.locator("li.dl-item#d1")).toBeVisible();
    await expect(page.locator(".wiki-agent-pane")).toBeHidden();
    // A header pill, from Agent again.
    await agent.click();
    await expect(article).toBeHidden();
    await page.locator(".wiki-article-head .wiki-count-pill").first().click();
    await expect(article).toHaveClass(/lens-all/);
    await expect(article).toBeVisible();
    // Neither reveal stored a lens.
    expect(await page.evaluate(() => localStorage.getItem("muninn.wiki.lens.v1"))).toBeNull();
  });

  test("?lens=agent where offered runs plan-card once, leaves the URL and is not stored", async ({ page }) => {
    await rm(runs, { force: true });
    await page.goto(pageUrl(BASE, PLAN, "&lens=agent"));
    await expect(page.locator(".wiki-agent-text")).toContainText("# Stub card");
    await expect(page.locator(".wiki-article")).toBeHidden();
    expect(new URL(page.url()).searchParams.has("lens")).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem("muninn.wiki.lens.v1"))).toBeNull();
    expect((await readFile(runs, "utf8")).trim().split("\n")).toHaveLength(1);
    await page.reload();
    await expect(page.locator(".wiki-article")).toHaveClass(/lens-all/);
    await expect(page.locator(".wiki-agent-pane")).toHaveCount(0);
    expect((await readFile(runs, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  test("a failed load spends ?lens=agent: the next plan opens in All and runs nothing", async ({ page }) => {
    await rm(runs, { force: true });
    await page.goto(pageUrl(BASE, "plans/missing.mdx", "&lens=agent"));
    await expect(page.locator("#articleWrap .wiki-empty-state")).toBeVisible();
    await page.locator(`.wiki-list-item[data-relpath="${PLAN}"]`).first().click();
    await expect(page.locator(".wiki-article")).toHaveClass(/lens-all/);
    await expect(page.locator(".wiki-agent-pane")).toHaveCount(0);
    expect(existsSync(runs)).toBe(false);
  });

  test("an explainer and a rejected page fetch spend ?lens=agent too", async ({ page }) => {
    await rm(runs, { force: true });
    const plan = page.locator(`.wiki-list-item[data-relpath="${PLAN}"]`).first();
    // An explainer has no lens.
    await page.goto(pageUrl(BASE, EXPLAINER, "&lens=agent"));
    await expect(page.locator(".wiki-explainer-frame")).toBeVisible();
    await plan.click();
    await expect(page.locator(".wiki-article")).toHaveClass(/lens-all/);
    // A page fetch that rejects (not an error payload: the network failed).
    let failOnce = true;
    await page.route("**/api/wiki/page?**", (route) => {
      if (failOnce) {
        failOnce = false;
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(pageUrl(BASE, PLAN, "&lens=agent"));
    await expect(page.locator("#articleWrap .wiki-empty-state")).toContainText("Failed to load page");
    await plan.click();
    await expect(page.locator(".wiki-article")).toHaveClass(/lens-all/);
    await expect(page.locator(".wiki-agent-pane")).toHaveCount(0);
    expect(existsSync(runs)).toBe(false);
  });

  test("the start view spends ?lens=agent: a plan opened from it is All and runs nothing", async ({ page }) => {
    await rm(runs, { force: true });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&lens=agent`);
    await expect.poll(() => new URL(page.url()).searchParams.has("lens")).toBe(false);
    await page.locator(`.wiki-list-item[data-relpath="${PLAN}"]`).first().click();
    await expect(page.locator(".wiki-article")).toHaveClass(/lens-all/);
    await expect(page.locator(".wiki-agent-pane")).toHaveCount(0);
    expect(existsSync(runs)).toBe(false);
  });

  test("re-entering Agent runs plan-card again with the inputs on screen", async ({ page }) => {
    await rm(runs, { force: true });
    await page.goto(pageUrl(BASE, PLAN));
    const agent = page.locator('.wiki-lens-switch button[data-lens="agent"]');
    const text = page.locator(".wiki-agent-text");
    await agent.click();
    await expect(text).toContainText("# Stub card");
    await page.locator('.wiki-agent-pane input[name="id"]').fill("S1");
    await page.locator('.wiki-lens-switch button[data-lens="all"]').click();
    await agent.click();
    await expect(text).toContainText('"--id","S1"');
    const lines = (await readFile(runs, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toEqual([path.join(root, PLAN), "--id", "S1", "--json"]);
  });

  test("a new run aborts the one in flight; the body announces and the card keeps its leading newline", async ({ page }) => {
    await page.goto(pageUrl(BASE, PLAN));
    await page.locator('.wiki-lens-switch button[data-lens="agent"]').click();
    const pane = page.locator(".wiki-agent-pane");
    const body = pane.locator(".wiki-agent-body");
    await expect(pane.locator(".wiki-agent-text")).toContainText("# Stub card");
    // The live region is the short status line, not the card's body.
    await expect(body).not.toHaveAttribute("aria-live", /.*/);
    await expect(pane.locator('.wiki-agent-live[role="status"]')).toHaveAttribute("aria-live", "polite");
    await expect(pane.locator(".wiki-agent-live")).toHaveText(/^plan-card done: [\d,]+ chars$/);
    await expect(body).toHaveAttribute("aria-busy", "false");
    const aborted: string[] = [];
    page.on("requestfailed", (r) => {
      if (r.url().includes("/api/wiki/plan-card")) aborted.push(new URL(r.url()).searchParams.get("id") ?? "");
    });
    const id = pane.locator('input[name="id"]');
    await id.fill("SLOW");
    await pane.locator('button[type="submit"]').click();
    await expect(body).toHaveAttribute("aria-busy", "true");
    await id.fill("LEADLF");
    await pane.locator('button[type="submit"]').click();
    await expect(pane.locator(".wiki-agent-text")).toContainText('"LEADLF"');
    await expect.poll(() => aborted).toEqual(["SLOW"]);
    // Word for word: the card's first character is its newline.
    expect((await pane.locator(".wiki-agent-text").textContent())!.startsWith("\n# Stub card")).toBe(true);
    // Late SLOW answer, if any, never repaints over the newer card.
    await page.waitForTimeout(1000);
    await expect(pane.locator(".wiki-agent-text")).toContainText('"LEADLF"');
    // A navigation aborts the run in flight too.
    await id.fill("SLOW");
    await pane.locator('button[type="submit"]').click();
    await expect(body).toHaveAttribute("aria-busy", "true");
    await page.locator(`.wiki-list-item[data-relpath="${NOTE}"]`).first().click();
    await expect.poll(() => aborted).toEqual(["SLOW", "SLOW"]);
  });

  test("an in-place reload in Agent keeps the card and inputs, marks it stale, and starts no child", async ({ page }) => {
    const appends: unknown[] = [];
    await page.route("**/api/wiki/factcheck?**", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: `event: done\ndata: ${JSON.stringify({ answer: "All good.", baseHash: "h1" })}\n\n`,
      }),
    );
    await page.route("**/api/wiki/factcheck/append", (route) => {
      appends.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ written: true }) });
    });
    await page.goto(pageUrl(BASE, PLAN));
    await page.locator('.wiki-lens-switch button[data-lens="agent"]').click();
    const pane = page.locator(".wiki-agent-pane");
    await pane.locator('input[name="id"]').fill("D1");
    await pane.locator('button[type="submit"]').click();
    await expect(pane.locator(".wiki-agent-text")).toContainText('"--id","D1"');
    const card = await pane.locator(".wiki-agent-text").textContent();
    await rm(runs, { force: true });
    await page.locator("#wikiFactcheckArticleBtn").dispatchEvent("mousedown");
    await expect(page.locator("#wikiFactcheckAppendBtn")).toBeEnabled();
    await page.locator("#wikiFactcheckAppendBtn").click();
    await expect.poll(() => appends.length).toBe(1);
    // The reloaded page is back in Agent, with the same card and inputs.
    await expect(page.locator(".wiki-article")).toHaveClass(/lens-agent/);
    await expect(pane.locator(".wiki-agent-stale")).toBeVisible();
    await expect(pane.locator(".wiki-agent-text")).toHaveText(card!);
    await expect(pane.locator('input[name="id"]')).toHaveValue("D1");
    await page.waitForTimeout(500);
    expect(existsSync(runs)).toBe(false);
    // The Run button refreshes it.
    await pane.locator('button[type="submit"]').click();
    await expect(pane.locator(".wiki-agent-stale")).toBeHidden();
    await expect.poll(() => existsSync(runs)).toBe(true);
  });

  test("«Se som rolle» acts on the article, so Agent hides it", async ({ page }) => {
    await page.goto(pageUrl(BASE, ROLE_REL).replace(`wiki=${WIKI}`, `wiki=${WIKI_NO}`));
    const roleView = page.locator(".wiki-article-head .wiki-role-view");
    await expect(roleView).toBeVisible();
    await page.locator('.wiki-lens-switch button[data-lens="agent"]').click();
    await expect(page.locator(".wiki-agent-text")).toContainText("# Stub card");
    await expect(roleView).toBeHidden();
    await page.locator('.wiki-lens-switch button[data-lens="all"]').click();
    await expect(roleView).toBeVisible();
  });

  test("graph mode hides the Agent pane with the article; a language: no wiki gets Norwegian words", async ({ page }) => {
    await page.goto(pageUrl(BASE, PLAN).replace(`wiki=${WIKI}`, `wiki=${WIKI_NO}`));
    await page.locator('.wiki-lens-switch button[data-lens="agent"]').click();
    const pane = page.locator(".wiki-agent-pane");
    await expect(pane.locator(".wiki-agent-text")).toContainText("# Stub card");
    await expect(pane.locator('button[type="submit"]')).toHaveText("Kjør plan-card");
    await expect(pane.locator(".wiki-agent-meta")).toContainText(" tegn · ");
    await page.locator("#wikiGraphToggle").click();
    await expect(pane).toBeHidden();
    await page.locator("#wikiGraphToggle").click();
    await expect(pane).toBeVisible();
  });

  test("graph mode first, then Agent: the pane built in graph mode is hidden, and shows when graph mode ends", async ({ page }) => {
    await page.goto(pageUrl(BASE, PLAN).replace(`wiki=${WIKI}`, `wiki=${WIKI_NO}`));
    await page.locator("#wikiGraphToggle").click();
    await expect(page.locator("#wikiGraph")).toBeVisible();
    await page.locator('.wiki-lens-switch button[data-lens="agent"]').click();
    const pane = page.locator(".wiki-agent-pane");
    await expect(pane).toHaveCount(1);
    await expect(pane.locator(".wiki-agent-text")).toContainText("# Stub card");
    await expect(pane).toBeHidden();
    await expect(page.locator("#wikiGraph")).toBeVisible();
    await page.locator("#wikiGraphToggle").click();
    await expect(pane).toBeVisible();
  });

  test("an issue graph spends ?lens=agent: a plan opened from it is All and runs nothing", async ({ page }) => {
    await rm(runs, { force: true });
    await page.goto(`${BASE}/wiki?wiki=${WIKI_NO}&display=graph&issue=${encodeURIComponent("jira:DEMO-1")}&lens=agent`);
    await expect(page.locator("#articleWrap h1")).toHaveText("DEMO-1");
    await expect.poll(() => new URL(page.url()).searchParams.has("lens")).toBe(false);
    await page.locator(`.wiki-list-item[data-relpath="${PLAN}"]`).first().click();
    await expect(page.locator(".wiki-article")).toHaveClass(/lens-all/);
    await expect(page.locator(".wiki-agent-pane")).toHaveCount(0);
    expect(existsSync(runs)).toBe(false);
  });

  test("the pane equals a direct run of the real plan-card with the same environment", async ({ page }) => {
    test.skip(!HAS_REAL, `no plan-card at ${REAL_BIN} (the claude-skills repo is not checked out here, as on CI)`);
    test.setTimeout(60_000);
    await page.goto(pageUrl(REAL, PLAN));
    await page.locator('.wiki-lens-switch button[data-lens="agent"]').click();
    const text = page.locator(".wiki-agent-pane .wiki-agent-text");
    await expect(text).toContainText("# Agent plan", { timeout: 30_000 });
    const shown = await text.textContent();

    // muninn's child env, rebuilt: the allowlist plus PLAN_CARD_MUNINN_URL.
    const env: Record<string, string> = { PLAN_CARD_MUNINN_URL: REAL, WIKI_STAMP_ROOTS: root };
    for (const name of ["PATH", "HOME", "TMPDIR"]) if (process.env[name]) env[name] = process.env[name]!;
    const direct = spawnSync("bun", ["--no-env-file", REAL_BIN, path.join(root, PLAN), "--json"], { env, encoding: "utf8" });
    expect(direct.status).toBe(0);
    const card = JSON.parse(direct.stdout) as { text: string; chars: number };
    expect(shown).toBe(card.text);
    await expect(page.locator(".wiki-agent-pane .wiki-agent-meta")).toHaveText(new RegExp(`^${card.chars.toLocaleString("en-US")} / 12,000 chars`));
  });
});
