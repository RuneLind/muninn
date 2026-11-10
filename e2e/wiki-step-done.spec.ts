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
 *  5. Each Done is tied to the step its row shows, after the viewer's role
 *     lanes moved to the top; a row whose text is not its step gets no button.
 *  6. A write that returns after the reader left the page, or while the next
 *     page is still loading, does not pull the reader back to it.
 *  7. The preview sits under a task row's text, at the row's width.
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
const ROLE_REL = "plans/e2e-steps-roles.mdx";
const MATCH_REL = "plans/e2e-steps-match.mdx";
const NAV_REL = "plans/e2e-steps-nav.mdx";
const NAV2_REL = "plans/e2e-steps-nav-2.mdx";
const OTHER_REL = "plans/e2e-other.mdx";
const TASK_REL = "plans/e2e-steps-tasks.mdx";

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

/** Two role lanes: the owner is in `utvikler`, so the reader moves the second lane to the top. */
const rolePage = (title: string, alpha = ["Alpha one.", "Alpha two."], beta = ["Beta one.", "Beta two."]) =>
  [
    `---\ntitle: ${title}\n---\n`,
    "<NextMoves>\n",
    '<Lane kind="you" role="fag">\n',
    ...alpha.map((t, i) => `${i + 1}. ${t}`),
    "\n</Lane>\n",
    '<Lane kind="you" role="utvikler">\n',
    ...beta.map((t, i) => `${i + 1}. ${t}`),
    "\n</Lane>\n",
    "</NextMoves>\n",
  ].join("\n");

const taskPage = () =>
  [
    "---\ntitle: Task fixture\n---\n",
    "<NextMoves>\n",
    '<Lane kind="you">\n',
    "- [ ] Mend the long garden fence behind the old apple trees before the first winter storm comes in.",
    "- [ ] Paint the shed.",
    "",
    "1. Sweep the porch and the three stone steps down to the garden gate, then rinse the doormat.",
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
  await writeFile(path.join(root, ROLE_REL), rolePage("Role fixture"), "utf8");
  await writeFile(path.join(root, MATCH_REL), rolePage("Match fixture"), "utf8");
  await writeFile(path.join(root, NAV_REL), page("Nav fixture"), "utf8");
  await writeFile(path.join(root, NAV2_REL), page("Nav fixture two"), "utf8");
  await writeFile(path.join(root, OTHER_REL), "---\ntitle: Other fixture\n---\n\nNothing to do here.\n", "utf8");
  await writeFile(path.join(root, TASK_REL), taskPage(), "utf8");
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
      // The owner is in `utvikler`: the reader puts that role's lane first.
      WIKI_ANSWER_GROUPS: "fag=A111111;utvikler=T000001",
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

const roleLane = (p: Page, role: string) => p.locator(`.wiki-article .nm-lane.nm-you[data-role="${role}"]`);
const roleRow = (p: Page, text: string) => p.locator(".wiki-article .nm-lane.nm-you .nm-body li", { hasText: text });

async function openRolePage(p: Page, rel: string): Promise<void> {
  await p.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);
  await expect(p.locator(".wiki-article .next-moves")).toBeVisible();
  await p.locator(".wiki-article .nm-lane.nm-you").evaluateAll((ds) => ds.forEach((d) => ((d as HTMLDetailsElement).open = true)));
  // The precondition the pairing has to survive: DOM order is not source order.
  expect(await p.locator(".wiki-article .nm-lane.nm-you").evaluateAll((ds) => ds.map((d) => (d as HTMLElement).dataset.role))).toEqual(["utvikler", "fag"]);
}

async function previewOf(p: Page, text: string): Promise<string> {
  const li = roleRow(p, text);
  await li.locator("[data-step-done]").click();
  const lines = li.locator(".wiki-step-done-panel .wiki-step-done-lines");
  await expect(lines).toBeVisible();
  const shown = (await lines.textContent()) ?? "";
  await li.locator(".wiki-step-done-cancel").click();
  return shown;
}

test.describe.serial("Done after the role lanes moved", () => {
  test("each row's Done previews and removes that row's step, in both lanes", async ({ page: p }) => {
    await openRolePage(p, ROLE_REL);
    expect(await previewOf(p, "Alpha one")).toContain("1. Alpha one.");
    expect(await previewOf(p, "Alpha two")).toContain("2. Alpha two.");
    expect(await previewOf(p, "Beta one")).toContain("1. Beta one.");
    expect(await previewOf(p, "Beta two")).toContain("2. Beta two.");

    const alpha = roleRow(p, "Alpha one");
    await alpha.locator("[data-step-done]").click();
    await alpha.locator("[data-step-done-confirm]").click();
    await expect(roleRow(p, "Alpha one")).toHaveCount(0);
    expect(await readFile(path.join(root, ROLE_REL), "utf8")).toBe(rolePage("Role fixture", ["Alpha two."]));

    await p.locator(".wiki-article .nm-lane.nm-you").evaluateAll((ds) => ds.forEach((d) => ((d as HTMLDetailsElement).open = true)));
    const beta = roleRow(p, "Beta two");
    await beta.locator("[data-step-done]").click();
    await expect(beta.locator(".wiki-step-done-lines")).toContainText("2. Beta two.");
    await beta.locator("[data-step-done-confirm]").click();
    await expect(roleRow(p, "Beta two")).toHaveCount(0);
    expect(await readFile(path.join(root, ROLE_REL), "utf8")).toBe(rolePage("Role fixture", ["Alpha two."], ["Beta one."]));
  });

  test("a lane with a row whose text is not its step gets no buttons", async ({ page: p }) => {
    // The server's list is altered in flight: the fag lane's second step names other text.
    await p.route("**/api/wiki/step-done?*", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { steps: { text: string }[] };
      for (const s of body.steps) if (s.text === "Alpha two.") s.text = "Polish the brass door knob.";
      await route.fulfill({ response: res, json: body });
    });
    await openRolePage(p, MATCH_REL);
    // Both lanes are settled in the one callback that answers the list: once the
    // page is idle and the other lane has its buttons, none can still arrive here.
    await expect(roleLane(p, "utvikler").locator("[data-step-done]")).toHaveCount(2);
    await p.waitForLoadState("networkidle");
    await expect(roleLane(p, "utvikler").locator("[data-step-done]")).toHaveCount(2);
    await expect(roleLane(p, "fag").locator("li", { hasText: "Alpha one" })).toBeVisible();
    expect(await roleLane(p, "fag").locator("[data-step-done]").count()).toBe(0);
  });
});

test("a write that returns after the reader left the page leaves the new page on screen", async ({ page: p }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = false;
  await p.route("**/api/wiki/step-done", async (route) => {
    const body = route.request().method() === "POST" ? (route.request().postDataJSON() as { preview?: boolean }) : {};
    if (route.request().method() === "POST" && body.preview !== true) {
      held = true;
      await gate;
    }
    await route.continue();
  });
  await openPage(p, NAV_REL);
  const li = step(p, "Wind the hall clock");
  await li.locator("[data-step-done]").click();
  await li.locator("[data-step-done-confirm]").click();
  await expect.poll(() => held).toBe(true);
  await p.locator(`.wiki-list-item[data-relpath="${OTHER_REL}"]`).first().click();
  await expect(p.locator(".wiki-article-head h1")).toHaveText("Other fixture");
  const historyLength = await p.evaluate(() => history.length);
  const oldPageLoad = p.waitForRequest((r) => r.url().includes("/api/wiki/page") && r.url().includes(encodeURIComponent(NAV_REL)), { timeout: 2_000 }).catch(() => null);
  const written = p.waitForResponse((r) => r.url().endsWith("/api/wiki/step-done") && r.request().method() === "POST");
  release();
  expect((await (await written).json()).ok).toBe(true);
  expect(await oldPageLoad).toBeNull();
  await expect(p.locator(".wiki-article-head h1")).toHaveText("Other fixture");
  expect(new URL(p.url()).searchParams.get("relPath")).toBe(OTHER_REL);
  expect(await p.evaluate(() => history.length)).toBe(historyLength);
  expect(await readFile(path.join(root, NAV_REL), "utf8")).not.toContain("Wind the hall clock");
});

test("a write that returns while the next page is still loading does not replace it", async ({ page: p }) => {
  const IN_FLIGHT_REL = NAV2_REL;
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>((r) => (releaseWrite = r));
  let releasePage!: () => void;
  const pageGate = new Promise<void>((r) => (releasePage = r));
  let writeHeld = false;
  let pageHeld = false;
  await p.route("**/api/wiki/step-done", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && (req.postDataJSON() as { preview?: boolean }).preview !== true) {
      writeHeld = true;
      await writeGate;
    }
    await route.continue();
  });
  await openPage(p, IN_FLIGHT_REL);
  await p.route(`**/api/wiki/page?relPath=${encodeURIComponent(OTHER_REL)}*`, async (route) => {
    pageHeld = true;
    await pageGate;
    await route.continue();
  });
  const li = step(p, "Wind the hall clock");
  await li.locator("[data-step-done]").click();
  await li.locator("[data-step-done-confirm]").click();
  await expect.poll(() => writeHeld).toBe(true);
  await p.locator(`.wiki-list-item[data-relpath="${OTHER_REL}"]`).first().click();
  await expect.poll(() => pageHeld).toBe(true);
  // The write returns first, while the old article is still on screen.
  const written = p.waitForResponse((r) => r.url().endsWith("/api/wiki/step-done") && r.request().method() === "POST");
  const oldPageLoad = p.waitForRequest((r) => r.url().includes("/api/wiki/page") && r.url().includes(encodeURIComponent(IN_FLIGHT_REL)), { timeout: 2_000 }).catch(() => null);
  releaseWrite();
  expect((await (await written).json()).ok).toBe(true);
  expect(await oldPageLoad).toBeNull();
  releasePage();
  await expect(p.locator(".wiki-article-head h1")).toHaveText("Other fixture");
  expect(new URL(p.url()).searchParams.get("relPath")).toBe(OTHER_REL);
});

for (const width of [390, 1280]) {
  test(`the preview sits under a task row's text at the row's width (${width} px)`, async ({ page: p }) => {
    await p.setViewportSize({ width, height: 900 });
    // The text column without any button: the step list is refused once.
    await p.route("**/api/wiki/step-done?*", (route) => route.fulfill({ status: 404, json: { error: "none" } }));
    await openPage(p, TASK_REL);
    const row = step(p, "Mend the long garden fence");
    await expect(row).toHaveClass(/check-item/);
    const bare = (await row.locator(".check-text").boundingBox())!;
    await p.unroute("**/api/wiki/step-done?*");

    await openPage(p, TASK_REL);
    const text = row.locator(".check-text");
    await expect(row.locator("[data-step-done]")).toHaveCount(1);
    const before = (await text.boundingBox())!;
    // The button does not narrow the text column or move it.
    expect(Math.abs(before.x - bare.x)).toBeLessThanOrEqual(1);
    expect(before.width).toBeGreaterThanOrEqual(bare.width - 1);

    for (const r of [row, step(p, "Sweep the porch")]) {
      const col = (await r.locator(".check-text").count()) ? r.locator(".check-text") : null;
      const colBefore = col ? (await col.boundingBox())! : null;
      await r.locator("[data-step-done]").click();
      const panel = r.locator(".wiki-step-done-panel");
      await expect(panel.locator(".wiki-step-done-lines")).toBeVisible();
      const box = (await panel.boundingBox())!;
      if (col && colBefore) {
        const after = (await col.boundingBox())!;
        expect(Math.abs(after.width - colBefore.width)).toBeLessThanOrEqual(1);
        // Under the text, not beside it.
        expect(box.y).toBeGreaterThanOrEqual(after.y + after.height - 1);
      }
      const content = await r.evaluate((li) => {
        const rect = li.getBoundingClientRect();
        const cs = getComputedStyle(li);
        const left = rect.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
        const right = rect.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
        return { x: left, width: right - left };
      });
      expect(Math.abs(box.x - content.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.width - content.width)).toBeLessThanOrEqual(1);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      const scroll = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(scroll.sw).toBeLessThanOrEqual(scroll.cw);
    }
  });
}
