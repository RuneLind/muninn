/**
 * The owner-step check chips (mimir plan muninn-wiki-owner-step-checks, PR 2).
 * The probes are unit-tested (`src/wiki/step-checks/`), the route against a
 * temp wiki (`wiki-step-checks.test.ts`) and the chip's DOM half in happy-dom
 * (`wiki-step-checks-dom.test.ts`); what only the real reader and a real
 * muninn can show:
 *
 *  1. A step whose `env` key is in no `.env` reads «not yet»; one whose
 *     migration the e2e database has applied reads «checked»; one whose
 *     migration does not exist reads «not yet»; a step that names `restart`
 *     (which muninn cannot prove yet) reads «unknown» although its migration
 *     holds; a step with no tag gets none.
 *  2. The chip sits in the reader-only slot: the Done button's accessible name
 *     is the step's text alone, and Done still removes a chipped row, after
 *     which the page's chips come back for the steps left.
 *
 * One muninn on its own port (Done's scope needs WORK_MAP_WIKIS and
 * WIKI_ANSWER_WIKIS; the migration probe reads the test database), a temp git
 * wiki. Made-up fixtures. The server runs from the repo root, so the env probe
 * reads that `.env`'s key NAMES; a CI runner has none, which reads «not yet»
 * as well. ENV PREREQUISITE: `bun run db:setup:test` (it baselines every
 * migration, so 086 is applied).
 */

import { test, expect, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { assertPortFree, waitForOwnServer } from "./own-server.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("wiki-step-checks");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-step-checks";
const REL = "plans/e2e-checks.mdx";
const KEY = "E2E_STEP_CHECK_KEY_NOBODY_SETS";

const PAGE = [
  "---\ntitle: Check fixture\n---\n",
  "<NextMoves>\n",
  '<Lane kind="you">\n',
  `1. Add the key. <Check env="${KEY}" />`,
  '2. Apply the old migration. <Check migration="086" />',
  '3. Apply the missing migration. <Check migration="999" />',
  "4. Water the plants.",
  '5. Restart muninn. <Check migration="086" restart="3010" />',
  "\n</Lane>\n",
  "</NextMoves>\n",
].join("\n");

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid" };
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore", env: GIT_ENV });

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-step-checks-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, REL), PAGE, "utf8");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "e2e");
  git(root, "config", "user.email", "e2e@example.invalid");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  await assertPortFree(PORT);
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_DIR: "",
      WIKI_EXTRA: `${WIKI}=${root}`,
      WORK_MAP_WIKIS: WIKI,
      WIKI_ANSWER_WIKIS: WIKI,
      WIKI_ANSWER_OWNER: "Test Owner (T000001)",
    },
    stdio: "ignore",
  });
  await waitForOwnServer(server, `${BASE}/api/wiki/pages?wiki=${WIKI}`);
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
});

const row = (p: Page, text: string) => p.locator(".wiki-article .nm-lane.nm-you .nm-body li", { hasText: text });
const chip = (p: Page, text: string) => row(p, text).locator(":scope > .step-check > .step-chip");

async function openPage(p: Page): Promise<void> {
  await p.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
  await expect(p.locator(".wiki-article .next-moves")).toBeVisible();
  await p.locator(".wiki-article .nm-lane.nm-you").evaluate((d) => ((d as HTMLDetailsElement).open = true));
}

test.describe.serial("owner-step check chips", () => {
  test("each tagged step shows what its probes proved; the untagged one shows nothing", async ({ page: p }) => {
    await openPage(p);
    await expect(chip(p, "Apply the old migration")).toHaveText("✓ checked");
    await expect(chip(p, "Apply the old migration")).toHaveAttribute("data-state", "ok");
    await expect(chip(p, "Apply the old migration")).toHaveAttribute("title", "migration=086: migration 086 is applied on this machine's database");
    await expect(chip(p, "Apply the missing migration")).toHaveText("○ not yet");
    await expect(chip(p, "Add the key")).toHaveText("○ not yet");
    await expect(chip(p, "Add the key")).toHaveAttribute("title", new RegExp(`^env=${KEY}: ${KEY} is not in \\.env`));
    await expect(chip(p, "Restart muninn")).toHaveText("? unknown");
    await expect(chip(p, "Restart muninn")).toHaveAttribute("data-state", "unknown");
    await expect(chip(p, "Restart muninn")).toHaveAttribute("title", /restart=3010: muninn cannot prove this yet/);
    await expect(row(p, "Water the plants").locator(".step-check")).toHaveCount(0);
    await expect(p.locator(".wiki-article .step-chip")).toHaveCount(4);
  });

  test("the chip takes no part in Done's name, and Done removes a chipped row", async ({ page: p }) => {
    await openPage(p);
    const li = row(p, "Apply the missing migration");
    await expect(chip(p, "Apply the missing migration")).toBeVisible();
    const done = li.locator("[data-step-done]");
    await expect(done).toHaveAccessibleName("Done: Apply the missing migration.");
    await expect(row(p, "Apply the old migration").locator("[data-step-done]")).toHaveAccessibleName("Done: Apply the old migration.");
    await done.click();
    await expect(li.locator(".wiki-step-done-lines")).toContainText('3. Apply the missing migration. <Check migration="999" />');
    await li.locator("[data-step-done-confirm]").click();
    await expect(row(p, "Apply the missing migration")).toHaveCount(0);
    expect(await readFile(path.join(root, REL), "utf8")).not.toContain("missing migration");
    // The page rendered again with the new hash: the steps left get their chips.
    await p.locator(".wiki-article .nm-lane.nm-you").evaluate((d) => ((d as HTMLDetailsElement).open = true));
    await expect(chip(p, "Apply the old migration")).toHaveText("✓ checked");
    await expect(p.locator(".wiki-article .step-chip")).toHaveCount(3);
  });
});
