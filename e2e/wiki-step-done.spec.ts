/**
 * Done on a `<Lane kind="you">` step (mimir plan muninn-wiki-first-screen-claims,
 * PR 1). The edit is unit-tested (`src/format/step-done.test.ts`) and the route
 * against the test database (`wiki-step-done-db.test.ts`); what only the reader
 * can show:
 *
 *  1. Done shows a preview with the line that goes and the log.md entry, and
 *     writes nothing until the second click.
 *  2. Remove takes the step off the page; the page renders again, and a second
 *     step on the same page can then be removed (the new hash is used).
 *  3. The lane's last step takes the lane with it; the waiting lane stays.
 *  4. A page changed underneath after the preview gets the refusal text.
 *
 * One muninn on its own port (the close route's scope needs WORK_MAP_WIKIS and
 * WIKI_ANSWER_WIKIS), the test database (the Gardener-held check reads it), a
 * temp git wiki. Made-up fixtures. `SCHEDULER_ENABLED=false`: no model call.
 * ENV PREREQUISITE: `bun run db:setup:test`.
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

const PORT = e2ePort("wiki-step-done");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-step-done";
const REL = "plans/e2e-steps.mdx";
const STALE_REL = "plans/e2e-steps-stale.mdx";

const page = (title: string) =>
  [
    `---\ntitle: ${title}\n---\n`,
    "Some intro text.\n",
    "<NextMoves>\n",
    '<Lane kind="you">\n',
    "1. **Water the plants:** the ferns first.",
    "2. Sort the blue folders.",
    "3. Wind the hall clock.",
    "\n</Lane>\n",
    '<Lane kind="waiting" who="Someone Else">\n',
    "- The parcel from the shop.",
    "\n</Lane>\n",
    "</NextMoves>\n",
  ].join("\n");

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid" };
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore", env: GIT_ENV });

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-step-done-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, REL), page("Step fixture"), "utf8");
  await writeFile(path.join(root, STALE_REL), page("Stale fixture"), "utf8");
  git(root, "init", "-q", "-b", "main");
  // The route's commit spawns git with no author env.
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

const youLane = (p: Page) => p.locator(".wiki-article .nm-lane.nm-you");
const step = (p: Page, text: string) => youLane(p).locator(".nm-body li", { hasText: text });

async function openPage(p: Page, rel: string): Promise<void> {
  await p.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);
  await expect(p.locator(".wiki-article .next-moves")).toBeVisible();
  await openYouLane(p);
}

async function openYouLane(p: Page): Promise<void> {
  if (await youLane(p).count()) await youLane(p).evaluate((d) => ((d as HTMLDetailsElement).open = true));
}

async function markDone(p: Page, text: string): Promise<void> {
  const li = step(p, text);
  await li.locator("[data-step-done]").click();
  await li.locator("[data-step-done-confirm]").click();
  await expect(step(p, text)).toHaveCount(0);
  await openYouLane(p);
}

test.describe.serial("Done on a you step", () => {
  test("Done previews the line and the log entry, and writes nothing yet", async ({ page: p }) => {
    await openPage(p, REL);
    const li = step(p, "Water the plants");
    await expect(li.locator("[data-step-done]")).toHaveCount(1);
    await li.locator("[data-step-done]").click();
    const panel = li.locator(".wiki-step-done-panel");
    await expect(panel.locator(".wiki-step-done-lines")).toContainText("1. **Water the plants:** the ferns first.");
    await expect(panel).toContainText("2. Sort the blue folders. → 1. Sort the blue folders.");
    await expect(panel.locator(".wiki-step-done-log")).toContainText("step-done | Step fixture");
    await expect(panel.locator(".wiki-step-done-log")).toContainText("- Step done: Water the plants: the ferns first.");
    await expect(panel).toContainText("if appending it fails, the page edit still stands");
    expect(await readFile(path.join(root, REL), "utf8")).toBe(page("Step fixture"));
  });

  test("Remove takes the step off, and a second step on the same page goes after it", async ({ page: p }) => {
    await openPage(p, REL);
    await markDone(p, "Water the plants");
    // The list still starts at 1: the next item took the number.
    expect(await readFile(path.join(root, REL), "utf8")).toContain("1. Sort the blue folders.");
    await expect(youLane(p).locator(".nm-body ol")).not.toHaveAttribute("start", /.+/);
    await markDone(p, "Sort the blue folders");
    const text = await readFile(path.join(root, REL), "utf8");
    expect(text).not.toContain("Sort the blue folders");
    expect(text).toContain("Wind the hall clock.");
    expect(await readFile(path.join(root, "log.md"), "utf8")).toContain("- Step done: Sort the blue folders.");
  });

  test("the last step takes its lane with it; the waiting lane stays", async ({ page: p }) => {
    await openPage(p, REL);
    await markDone(p, "Wind the hall clock");
    await expect(youLane(p)).toHaveCount(0);
    await expect(p.locator(".wiki-article .nm-lane.nm-waiting")).toHaveCount(1);
    const text = await readFile(path.join(root, REL), "utf8");
    expect(text).not.toContain('<Lane kind="you">');
    expect(text).toContain('<Lane kind="waiting" who="Someone Else">');
  });

  test("a page changed underneath after the preview gets the refusal", async ({ page: p }) => {
    await openPage(p, STALE_REL);
    const li = step(p, "Sort the blue folders");
    await li.locator("[data-step-done]").click();
    await expect(li.locator("[data-step-done-confirm]")).toBeVisible();
    const changed = page("Stale fixture").replace("Some intro text.", "Some intro text, edited elsewhere.");
    await writeFile(path.join(root, STALE_REL), changed, "utf8");
    git(root, "commit", "-q", "-am", "edited elsewhere");
    await li.locator("[data-step-done-confirm]").click();
    await expect(li.locator(".wiki-step-done-err")).toHaveText("The page changed since it was shown. Reload it and try again.");
    expect(await readFile(path.join(root, STALE_REL), "utf8")).toBe(changed);
  });
});
