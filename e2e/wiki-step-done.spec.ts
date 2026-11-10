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
 *     lanes moved to the top; a lane that renders another number of rows than
 *     the server counted gets no button; a row that shows other text than its
 *     source (a wikilink's label, a tag in code) gets one.
 *  6. A write that returns after the reader left the page, or while the next
 *     page is still loading, does not pull the reader back to it; one that
 *     returns after its preview was cancelled still renders the page again.
 *  7. The preview sits under a task row's text, at the row's width, and wraps
 *     its lines inside that width.
 *  8. Escape and Cancel close the preview with focus back on its Done; each
 *     Done's name carries its step; after a write the page says so.
 *  9. A refusal says what the reader can do: Reload after a changed page,
 *     Remove off unless a retry can help, and a refusal whose preview has
 *     closed lands on the page.
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
const KEYS_REL = "plans/e2e-steps-keys.mdx";
const LINK_REL = "plans/e2e-steps-links.mdx";
const CANCEL_REL = "plans/e2e-steps-cancel.mdx";
const SETTLED_REL = "plans/e2e-steps-settled.mdx";
const FOLD_REL = "plans/e2e-steps-fold.mdx";

/** Steps whose rendered row is not their source text: a wikilink shows its label, a tag in code shows as text. */
const linkPage = () =>
  [
    "---\ntitle: Link fixture\n---\n",
    "<NextMoves>\n",
    '<Lane kind="you">\n',
    "1. Read [[plans/e2e-other|the other fixture]] before lunch.",
    "2. Wrap the claim in a `<Fact>` tag.",
    "\n</Lane>\n",
    "</NextMoves>\n",
  ].join("\n");

const LIVE_BLOCK = ["<NextMoves>\n", '<Lane kind="you">\n', "1. Oil the gate hinge.", "2. Stack the firewood.", "\n</Lane>\n", "</NextMoves>\n"];

/** A settled block (inside a resolved callout) above the live one. */
const settledPage = () =>
  [
    "---\ntitle: Settled fixture\n---\n",
    '<Callout resolved="2026-09-01" title="Closed">\n',
    "<NextMoves>\n",
    '<Lane kind="you">\n',
    "1. An old step nobody counts.",
    "\n</Lane>\n",
    "</NextMoves>\n",
    "</Callout>\n",
    ...LIVE_BLOCK,
  ].join("\n");

/** The only live block sits in a fold, which renders closed. */
const foldPage = () => ["---\ntitle: Fold fixture\n---\n", "Intro.\n", '<Fold title="The steps">\n', ...LIVE_BLOCK, "</Fold>\n"].join("\n");

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
  await writeFile(path.join(root, KEYS_REL), page("Keys fixture"), "utf8");
  await writeFile(path.join(root, LINK_REL), linkPage(), "utf8");
  await writeFile(path.join(root, CANCEL_REL), page("Cancel fixture"), "utf8");
  await writeFile(path.join(root, SETTLED_REL), settledPage(), "utf8");
  await writeFile(path.join(root, FOLD_REL), foldPage(), "utf8");
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
    // The two later steps take one line, and their text is not repeated.
    await expect(panel).toContainText("The 2 steps after it take new numbers: 2–3 become 1–2.");
    await expect(panel).not.toContainText("Sort the blue folders");
    await expect(panel.locator(".wiki-step-done-log")).toContainText("step-done | Step fixture");
    await expect(panel.locator(".wiki-step-done-log")).toContainText("- Step done: Water the plants: the ferns first.");
    await expect(panel).toContainText("if appending it fails, the page edit still stands");
    expect(await readFile(path.join(root, REL), "utf8")).toBe(page("Step fixture"));
  });

  test("Remove takes the step off, and a second step on the same page goes after it", async ({ page: p }) => {
    await openPage(p, REL);
    await markDone(p, "Water the plants");
    // The page says what happened, where the keyboard now is.
    const note = p.locator(".wiki-article .wiki-step-done-note");
    await expect(note).toHaveText("The step is removed from the page.");
    await expect(note).toHaveAttribute("role", "status");
    await expect(note).toBeFocused();
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
    // Remove cannot help now; Reload renders the changed page, and its Done works.
    await expect(li.locator("[data-step-done-confirm]")).toBeDisabled();
    await li.locator(".wiki-step-done-reload").click();
    await expect(p.locator(".wiki-article")).toContainText("Some intro text, edited elsewhere.");
    await expect(p.locator(".wiki-step-done-panel")).toHaveCount(0);
    await openYouLane(p);
    const again = step(p, "Sort the blue folders");
    await again.locator("[data-step-done]").click();
    await expect(again.locator(".wiki-step-done-lines")).toContainText("2. Sort the blue folders.");
    await expect(again.locator(".wiki-step-done-reload")).toBeHidden();
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

  test("a lane that renders another number of rows than the server counted gets no buttons", async ({ page: p }) => {
    // The server's list is altered in flight: it counts three rows in the fag lane, which renders two.
    await p.route("**/api/wiki/step-done?*", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { laneRows: number[] };
      body.laneRows[0] = 3;
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

test("a row that shows other text than its source still gets its Done: a wikilink's label, a tag in code", async ({ page: p }) => {
  await openPage(p, LINK_REL);
  const link = step(p, "the other fixture");
  const code = step(p, "Wrap the claim");
  // The rows show the label and the tag as text; the source holds the target and the ticks.
  await expect(link).toHaveText(/^Read the other fixture before lunch\./);
  await expect(code).toContainText("<Fact>");
  await expect(link.locator("[data-step-done]")).toHaveCount(1);
  await expect(code.locator("[data-step-done]")).toHaveCount(1);
  await link.locator("[data-step-done]").click();
  await expect(link.locator(".wiki-step-done-lines")).toHaveText(/1\. Read \[\[plans\/e2e-other\|the other fixture\]\] before lunch\./);
  await link.locator(".wiki-step-done-cancel").click();
  await code.locator("[data-step-done]").click();
  await expect(code.locator(".wiki-step-done-lines")).toContainText("2. Wrap the claim in a `<Fact>` tag.");
});

test("a write that lands after its preview was cancelled still renders the page again", async ({ page: p }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = false;
  await p.route("**/api/wiki/step-done", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && (req.postDataJSON() as { preview?: boolean }).preview !== true) {
      held = true;
      await gate;
    }
    await route.continue();
  });
  await openPage(p, CANCEL_REL);
  const li = step(p, "Sort the blue folders");
  await li.locator("[data-step-done]").click();
  await li.locator("[data-step-done-confirm]").click();
  await expect.poll(() => held).toBe(true);
  await li.locator(".wiki-step-done-cancel").click();
  await expect(li.locator(".wiki-step-done-panel")).toHaveCount(0);
  const written = p.waitForResponse((r) => r.url().endsWith("/api/wiki/step-done") && r.request().method() === "POST");
  release();
  expect((await (await written).json()).ok).toBe(true);
  // The page on screen is the page on disk again, and it says what happened.
  await expect(step(p, "Sort the blue folders")).toHaveCount(0);
  await expect(p.locator(".wiki-article .wiki-step-done-note")).toHaveText("The step is removed from the page.");
  expect(await readFile(path.join(root, CANCEL_REL), "utf8")).not.toContain("Sort the blue folders");
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
      // The removed line and the log entry wrap: nothing to scroll sideways for.
      const over = await panel.locator(".wiki-step-done-lines, .wiki-step-done-log").evaluateAll((els) => els.map((e) => e.scrollWidth - e.clientWidth));
      expect(over).toHaveLength(2);
      for (const px of over) expect(px).toBeLessThanOrEqual(1);
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

/** Answer every write (never a preview) with `answer()`, once `gate` lets it through. */
async function answerWrites(p: Page, answer: () => { status: number; json: Record<string, unknown> }, gate?: Promise<void>): Promise<{ held: () => boolean }> {
  let held = false;
  await p.route("**/api/wiki/step-done", async (route) => {
    const req = route.request();
    if (req.method() !== "POST" || (req.postDataJSON() as { preview?: boolean }).preview === true) return route.continue();
    held = true;
    await gate;
    await route.fulfill(answer());
  });
  return { held: () => held };
}

test.describe("the preview's keys, names and refusals", () => {
  test("Escape and Cancel close the preview and put focus back on its Done", async ({ page: p }) => {
    await openPage(p, KEYS_REL);
    const li = step(p, "Sort the blue folders");
    const done = li.locator("[data-step-done]");
    await done.click();
    await expect(li.locator("[data-step-done-confirm]")).toBeFocused();
    await p.keyboard.press("Escape");
    await expect(p.locator(".wiki-step-done-panel")).toHaveCount(0);
    await expect(done).toBeFocused();
    await done.click();
    await li.locator(".wiki-step-done-cancel").click();
    await expect(p.locator(".wiki-step-done-panel")).toHaveCount(0);
    await expect(done).toBeFocused();
    // Escape on the Done itself, where focus is while the preview is read.
    await done.click();
    await expect(li.locator("[data-step-done-confirm]")).toBeFocused();
    await done.focus();
    await p.keyboard.press("Escape");
    await expect(p.locator(".wiki-step-done-panel")).toHaveCount(0);
    await expect(done).toBeFocused();
  });

  test("each Done's name carries its step", async ({ page: p }) => {
    await openPage(p, KEYS_REL);
    await expect(step(p, "Water the plants").locator("[data-step-done]")).toHaveAccessibleName("Done: Water the plants: the ferns first.");
    await expect(step(p, "Sort the blue folders").locator("[data-step-done]")).toHaveAccessibleName("Done: Sort the blue folders.");
    await expect(step(p, "Wind the hall clock").locator("[data-step-done]")).toHaveText("Done");
  });

  test("a refusal a retry cannot change turns Remove off; a wiki being written leaves it on", async ({ page: p }) => {
    let answer = { status: 409, json: { error: "The Gardener holds this page.", held: true } as Record<string, unknown> };
    await answerWrites(p, () => answer);
    await openPage(p, KEYS_REL);
    const li = step(p, "Sort the blue folders");
    await li.locator("[data-step-done]").click();
    await li.locator("[data-step-done-confirm]").click();
    await expect(li.locator(".wiki-step-done-err")).toHaveText("The Gardener holds this page.");
    await expect(li.locator("[data-step-done-confirm]")).toBeDisabled();
    await expect(li.locator(".wiki-step-done-reload")).toBeHidden();
    await li.locator(".wiki-step-done-cancel").click();

    answer = { status: 409, json: { error: "A session is writing to this wiki. Try again in a moment.", locked: true } };
    await li.locator("[data-step-done]").click();
    await li.locator("[data-step-done-confirm]").click();
    await expect(li.locator(".wiki-step-done-err")).toHaveText("A session is writing to this wiki. Try again in a moment.");
    await expect(li.locator("[data-step-done-confirm]")).toBeEnabled();
    await expect(li.locator(".wiki-step-done-reload")).toBeHidden();
    expect(await readFile(path.join(root, KEYS_REL), "utf8")).toBe(page("Keys fixture"));
  });

  test("Escape closes the preview from a Remove that is off: while its write runs, and after a refusal", async ({ page: p }) => {
    let release!: () => void;
    let gate: Promise<void> | undefined = new Promise<void>((r) => (release = r));
    let writes = 0;
    await p.route("**/api/wiki/step-done", async (route) => {
      const req = route.request();
      if (req.method() !== "POST" || (req.postDataJSON() as { preview?: boolean }).preview === true) return route.continue();
      writes++;
      await gate;
      await route.fulfill({ status: 409, json: { error: "The Gardener holds this page.", held: true } });
    });
    await openPage(p, KEYS_REL);
    const li = step(p, "Sort the blue folders");
    const done = li.locator("[data-step-done]");
    const remove = li.locator("[data-step-done-confirm]");
    await done.click();
    await remove.click();
    await expect.poll(() => writes).toBe(1);
    // The write runs: Remove is off, keeps focus, and a second press sends nothing.
    await expect(remove).toBeDisabled();
    await expect(remove).toBeFocused();
    await p.keyboard.press("Enter");
    await remove.dispatchEvent("click");
    await p.keyboard.press("Escape");
    await expect(p.locator(".wiki-step-done-panel")).toHaveCount(0);
    await expect(done).toBeFocused();
    release();
    await expect(p.locator(".wiki-article .wiki-step-done-note")).toHaveText("Done did not remove «Sort the blue folders.»: The Gardener holds this page.");
    expect(writes).toBe(1);

    // After a refusal a retry cannot change, Remove stays off and still holds focus.
    gate = undefined;
    await done.click();
    await remove.click();
    await expect(li.locator(".wiki-step-done-err")).toHaveText("The Gardener holds this page.");
    await expect(remove).toBeDisabled();
    await expect(remove).toBeFocused();
    await remove.dispatchEvent("click");
    await p.keyboard.press("Escape");
    await expect(p.locator(".wiki-step-done-panel")).toHaveCount(0);
    await expect(done).toBeFocused();
    expect(writes).toBe(2);
  });

  test("Escape closes a preview that is still being read, and a second press on its Done does not", async ({ page: p }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let previews = 0;
    await p.route("**/api/wiki/step-done", async (route) => {
      const req = route.request();
      if (req.method() === "POST" && (req.postDataJSON() as { preview?: boolean }).preview === true) {
        previews++;
        await gate;
      }
      await route.continue();
    });
    await openPage(p, KEYS_REL);
    const li = step(p, "Sort the blue folders");
    const done = li.locator("[data-step-done]");
    await done.click();
    await expect.poll(() => previews).toBe(1);
    await expect(li.locator(".wiki-step-done-panel")).toHaveText("Reading what Done removes…");
    await expect(done).toBeFocused();
    await done.dispatchEvent("click");
    await expect(li.locator(".wiki-step-done-panel")).toHaveCount(1);
    await p.keyboard.press("Escape");
    await expect(p.locator(".wiki-step-done-panel")).toHaveCount(0);
    await expect(done).toBeFocused();
    release();
    // The preview that arrives for the closed panel opens nothing, and Done works again.
    await expect(done).toBeEnabled();
    await expect(p.locator(".wiki-step-done-panel")).toHaveCount(0);
    await done.click();
    await expect(li.locator("[data-step-done-confirm]")).toBeFocused();
    expect(previews).toBe(2);
  });

  test("the notice goes in the live block, not in a settled one above it", async ({ page: p }) => {
    await p.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(SETTLED_REL)}`);
    const live = p.locator(".wiki-article .next-moves", { hasText: "Stack the firewood" });
    await expect(live).toBeVisible();
    await live.locator(".nm-lane.nm-you").evaluate((d) => ((d as HTMLDetailsElement).open = true));
    // The settled block's step gets no Done.
    await expect(live.locator("[data-step-done]")).toHaveCount(2);
    await expect(p.locator(".wiki-article [data-step-done]")).toHaveCount(2);
    const li = live.locator(".nm-body li", { hasText: "Oil the gate hinge" });
    await li.locator("[data-step-done]").click();
    await li.locator("[data-step-done-confirm]").click();
    const note = p.locator(".wiki-article .wiki-step-done-note");
    await expect(note).toHaveText("The step is removed from the page.");
    await expect(note).toBeVisible();
    await expect(note).toBeFocused();
    expect(await note.evaluate((n) => n.parentElement?.classList.contains("next-moves") && !n.closest("details.callout-resolved"))).toBe(true);
    await expect(p.locator(".wiki-article .next-moves", { hasText: "Stack the firewood" }).locator(".wiki-step-done-note")).toHaveCount(1);
  });

  test("the notice goes above the article when the only live block is in a closed fold", async ({ page: p }) => {
    await p.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(FOLD_REL)}`);
    const fold = p.locator(".wiki-article details", { has: p.locator(".next-moves") }).first();
    await fold.evaluate((d) => ((d as HTMLDetailsElement).open = true));
    await youLane(p).evaluate((d) => ((d as HTMLDetailsElement).open = true));
    const li = step(p, "Oil the gate hinge");
    await li.locator("[data-step-done]").click();
    await li.locator("[data-step-done-confirm]").click();
    const note = p.locator(".wiki-article .wiki-step-done-note");
    await expect(note).toHaveText("The step is removed from the page.");
    await expect(note).toBeVisible();
    await expect(note).toBeFocused();
    // The page rendered again with its fold closed: the line is the article's first child, outside it.
    expect(await note.evaluate((n) => n === n.closest(".wiki-article")?.firstElementChild)).toBe(true);
  });

  test("an answer that is not the route's own offers Reload: a gateway's 504 page", async ({ page: p }) => {
    await p.route("**/api/wiki/step-done", async (route) => {
      const req = route.request();
      if (req.method() !== "POST" || (req.postDataJSON() as { preview?: boolean }).preview === true) return route.continue();
      await route.fulfill({ status: 504, contentType: "text/html", body: "<html><body>504 Gateway Time-out</body></html>" });
    });
    await openPage(p, KEYS_REL);
    const li = step(p, "Sort the blue folders");
    await li.locator("[data-step-done]").click();
    await li.locator("[data-step-done-confirm]").click();
    await expect(li.locator(".wiki-step-done-err")).toBeVisible();
    await expect(li.locator(".wiki-step-done-reload")).toBeVisible();
    await expect(li.locator(".wiki-step-done-err")).toHaveText("Done got an answer it cannot read. Reload the page to see whether the step is removed.");
    await expect(li.locator("[data-step-done-confirm]")).toBeDisabled();
    await li.locator(".wiki-step-done-reload").click();
    await expect(p.locator(".wiki-step-done-panel")).toHaveCount(0);
    await openYouLane(p);
    await expect(step(p, "Sort the blue folders").locator("[data-step-done]")).toBeVisible();
  });

  test("a refusal that arrives after its preview closed is shown on the page", async ({ page: p }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const writes = await answerWrites(p, () => ({ status: 409, json: { error: "The Gardener holds this page.", held: true } }), gate);
    await openPage(p, KEYS_REL);
    const li = step(p, "Sort the blue folders");
    await li.locator("[data-step-done]").click();
    await li.locator("[data-step-done-confirm]").click();
    await expect.poll(() => writes.held()).toBe(true);
    // Another step's Done closes the preview that is writing.
    // (By its own text: the open preview also names this step, as a renumbered line.)
    const other = youLane(p).locator(".nm-body li", { hasText: /^Wind the hall clock/ });
    await other.locator("[data-step-done]").click();
    await expect(other.locator("[data-step-done-confirm]")).toBeVisible();
    await expect(li.locator(".wiki-step-done-panel")).toHaveCount(0);
    release();
    const note = p.locator(".wiki-article .wiki-step-done-note");
    await expect(note).toHaveText("Done did not remove «Sort the blue folders.»: The Gardener holds this page.");
    await expect(note).toHaveAttribute("role", "alert");
    // The other step's preview is still open.
    await expect(other.locator("[data-step-done-confirm]")).toBeVisible();
  });
});
