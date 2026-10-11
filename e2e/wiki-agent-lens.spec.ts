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
 * nais profile at role user and admin (no button, no route). The fixture wiki
 * is an OS temp dir registered via `WIKI_EXTRA` and listed in
 * `WIKI_STAMP_ROOTS`, which is plan-card's roots variable too.
 */

import { test, expect } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
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
  "Working on D1.",
  "",
].join("\n");
const NOTE_PAGE = ["---", "title: Plain note", "---", "", "# Plain note", "", "No plan here.", ""].join("\n");

const servers: ChildProcess[] = [];
let root = "";
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
        WIKI_EXTRA: `${WIKI}=${root}`,
        WIKI_STAMP_ROOTS: root,
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
      "const text = '# Stub card\\nARGS ' + JSON.stringify(args) + '\\nENV ' + env + '\\nMUNINN ' + process.env.PLAN_CARD_MUNINN_URL;",
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
