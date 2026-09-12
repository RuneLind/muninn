/**
 * **Activity** at the top of the /wiki page rail, and the fold that `Recently
 * opened` became under it.
 *
 * What the unit tests cannot reach, and the reason this file exists:
 *
 *  1. **The dates are GIT's.** `rankActivity` is pure and takes a listing, but
 *     the listing's `gitCreatedMs`/`gitTouchedMs` come from one `git log` walk
 *     inside the index build. A unit test hands the ranking the numbers it
 *     wants; only a real repo proves the walk, the payload and the ranking agree
 *     about which page is new — so this wiki is a real git repo whose commits
 *     are BACKDATED, and every expected placement below is a consequence of
 *     those dates.
 *  2. **The section reaches the rail at all.** The weights travel
 *     `.wiki-reader.json` → index → `/api/wiki/pages` → the client's
 *     `setPagesData` → `renderList`. Every link is green with the chain broken,
 *     and the symptom is a section that never appears — or one that ignores the
 *     wiki's own row count.
 *  3. **`clear` still works from inside a `<summary>`.** The button now sits in
 *     the fold's summary, where a click's DEFAULT action is "toggle the
 *     details". Only `preventDefault` in the list's own handler keeps the two
 *     apart, and that is invisible from either module.
 *
 * No model calls: nothing here leaves the process.
 *
 * ENV PREREQUISITE / SPAWN ENV: as every other spec in this directory — a
 * working `.env` at the repo root, and `e2eEnv()` to keep this muninn off
 * Telegram/Slack and off the host's instance-profile flags.
 */

import { test, expect } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-rail-activity");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

/** The git-backed wiki, whose every expectation is a consequence of its commit dates. */
const WIKI = "e2e-activity";
/** The plain wiki, which exists only to prove the `.wiki-reader.json` override. */
const OTHER_WIKI = "e2e-activity-rows";

const DAY = 86_400_000;

const HUB = "concepts/hub.md";
const PLAN = "plans/young-plan.md";
const BRAND_NEW = "notes/brand-new.md";
const FRESH = [0, 1, 2, 3].map((i) => `notes/fresh-${i}.md`);
const LINKERS = [1, 2, 3, 4, 5, 6].map((i) => `concepts/link-${i}.md`);

/** Every page of the git wiki, so a count assertion says what it means. */
const ALL_PAGES = 1 + 1 + 1 + FRESH.length + LINKERS.length;
/** The default `rows`, which this wiki does not override. */
const DEFAULT_ROWS = 6;

function md(title: string, body: string, extra: string[] = []): string {
  return ["---", `title: ${title}`, ...extra, "---", "", body, ""].join("\n");
}

let server: ChildProcess | undefined;
let root = "";
let otherRoot = "";

/** `git` in the fixture repo, with BOTH date variables pinned — `git-dates.ts`
 *  reads the AUTHOR date (`%at`), and setting only one leaves the other on the
 *  wall clock. Identity is passed per command so the spec never depends on the
 *  developer's global git config. */
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

/** One backdated commit. Every commit here touches far fewer than
 *  `SWEEP_THRESHOLD` (10) files, so none of them classifies as a sweep and
 *  drops out of the `touched` map. */
function commit(atMs: number, message: string): void {
  git(["add", "-A"]);
  git(["commit", "-m", message], atMs);
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-activity-"));
  otherRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-activity-rows-"));
  const now = Date.now();

  // `plan` is not one of the built-in types, so the wiki declares it — which is
  // also what makes the plan boost reachable at all.
  await writeFile(
    path.join(root, ".wiki-reader.json"),
    JSON.stringify({ typeMap: { plans: "plan" } }),
    "utf8",
  );

  git(["init", "-q", "-b", "main"]);

  // T-60d — an old hub and the six pages that link to it. Its backlink count is
  // what the hub penalty acts on.
  await write(HUB, md("The hub", "Everything points here."));
  for (const rel of LINKERS) {
    await write(rel, md(`Linker ${rel}`, "See [[hub]] for the rest."));
  }
  commit(now - 60 * DAY, "the hub and its linkers");

  // T-3d — a plan is created.
  await write(PLAN, md("Young plan", "First draft.", ["plan_status: in-flight"]));
  commit(now - 3 * DAY, "start the plan");

  // T-2d — four ordinary pages are created and never touched again.
  for (const rel of FRESH) await write(rel, md(`Fresh ${rel}`, "Something new."));
  commit(now - 2 * DAY, "four fresh pages");

  // T-1d — the plan is edited, two days after it was created. That gap is what
  // makes this a CHANGE rather than the same writing session.
  await write(PLAN, md("Young plan", "Second draft, with more in it.", ["plan_status: in-flight"]));
  commit(now - DAY, "work on the plan");

  // Now — one brand-new page, and a touch to the 60-day-old hub. Both are
  // "today"; only one of them is news.
  await write(BRAND_NEW, md("Brand new", "Written just now."));
  await write(HUB, md("The hub", "Everything points here, still."));
  commit(now, "a new page, and a touch to the hub");

  // The second wiki is deliberately NOT a repo: with no git history every page
  // dates to its birthtime, they are written in the same instant, and the
  // ranking therefore ties them all at the top — which is exactly the state in
  // which "how many rows" is the only thing left to observe.
  await writeFile(
    path.join(otherRoot, ".wiki-reader.json"),
    JSON.stringify({ activity: { rows: 2 } }),
    "utf8",
  );
  for (const i of [1, 2, 3, 4]) {
    await writeFile(path.join(otherRoot, `p-${i}.md`), md(`Page ${i}`, "Body."), "utf8");
  }

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root},${OTHER_WIKI}=${otherRoot}`,
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
  if (otherRoot) await rm(otherRoot, { recursive: true, force: true });
});

type Page = import("@playwright/test").Page;

async function openRail(page: Page, wiki = WIKI): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${wiki}`);
  await expect(page.locator(".wiki-list-item").first()).toBeVisible();
}

const rowsIn = (page: Page, section: string) =>
  page.locator(`.wiki-list-item[data-section="${section}"]`);

const relPathsIn = (page: Page, section: string): Promise<string[]> =>
  rowsIn(page, section).evaluateAll((els) => els.map((el) => el.getAttribute("data-relpath") || ""));

/** Open each page in turn, waiting for its article. The LAST one is the page
 *  being read, and so the one `Recently opened` will not hold. */
async function readPages(page: Page, rels: string[]): Promise<void> {
  for (const rel of rels) {
    await page.locator(`.wiki-list-item[data-relpath="${rel}"]`).click();
    await expect(page.locator(".wiki-bc-cur")).toBeVisible();
    await expect(page.locator(".wiki-list-item.active")).toHaveAttribute("data-relpath", rel);
  }
}

test.describe("Wiki rail: Activity", () => {
  test("the git dates reach the listing", async () => {
    // The premise every placement below rests on. Asserted separately so a
    // broken git walk reads as "the dates never arrived" rather than as a
    // ranking bug.
    const res = await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`);
    const data = (await res.json()) as {
      pages: Array<{ relPath: string; gitCreatedMs?: number; gitTouchedMs?: number }>;
      activity?: Record<string, number>;
    };
    const byRel = new Map(data.pages.map((p) => [p.relPath, p]));
    expect(data.pages).toHaveLength(ALL_PAGES);
    const days = (ms?: number) => Math.round((Date.now() - (ms ?? 0)) / DAY);
    expect(days(byRel.get(HUB)!.gitCreatedMs)).toBe(60);
    expect(days(byRel.get(HUB)!.gitTouchedMs)).toBe(0);
    expect(days(byRel.get(PLAN)!.gitCreatedMs)).toBe(3);
    expect(days(byRel.get(PLAN)!.gitTouchedMs)).toBe(1);
    expect(days(byRel.get(BRAND_NEW)!.gitCreatedMs)).toBe(0);
    // …and the payload carries the resolved weights, defaults here.
    expect(data.activity?.rows).toBe(DEFAULT_ROWS);
  });

  test("Activity leads the rail: the new page first, then the young plan", async ({ page }) => {
    await openRail(page);
    const labels = await page.locator(".wiki-sec-label").allTextContents();
    expect(labels[0]).toBe("Activity");

    const activity = await relPathsIn(page, "activity");
    expect(activity).toHaveLength(DEFAULT_ROWS);
    expect(activity.slice(0, 2)).toEqual([BRAND_NEW, PLAN]);

    // The old hub was touched TODAY and is still not news: 60 days old, six
    // pages linking to it. That is the whole point of the ranking.
    expect(activity).not.toContain(HUB);
    // It is in the listing below, exactly once, like every other page.
    await expect(page.locator(`.wiki-list-item[data-relpath="${HUB}"]`)).toHaveCount(1);
    await expect(page.locator(".wiki-list-item")).toHaveCount(ALL_PAGES);
    await expect(page.locator("#wikiCount")).toHaveText(`${ALL_PAGES} / ${ALL_PAGES}`);
  });

  test("the glyph says which signal placed the row, and the title says why", async ({ page }) => {
    await openRail(page);
    const newRow = page.locator(`.wiki-list-item[data-relpath="${BRAND_NEW}"]`);
    await expect(newRow.locator(".wiki-act-glyph.new")).toHaveText("+");
    await expect(newRow).toHaveAttribute("title", /^created /);

    const changedRow = page.locator(`.wiki-list-item[data-relpath="${PLAN}"]`);
    await expect(changedRow.locator(".wiki-act-glyph.changed")).toHaveText("~");
    await expect(changedRow).toHaveAttribute("title", /^changed .* created .* hub ×/);

    // A listing row carries no glyph — the mark means "this is in Activity".
    await expect(
      page.locator(`.wiki-list-item[data-relpath="${HUB}"] .wiki-act-glyph`),
    ).toHaveCount(0);

    // The date cell is the age of the winning signal, relative.
    await expect(newRow.locator(".wiki-list-meta")).toHaveText("now");
    await expect(changedRow.locator(".wiki-list-meta")).toHaveText("1d");
  });

  test("Recently opened is folded under Activity, closed, and opens on click", async ({ page }) => {
    await openRail(page);
    // TWO pages the ranking does NOT lift, so opening them really produces a
    // `Recently opened` section rather than more Activity rows — and two,
    // because the page being READ is deliberately kept out of that section, so
    // one visit leaves nothing in it to fold.
    await readPages(page, [HUB, LINKERS[0]!]);

    const fold = page.locator(".wiki-rail-fold");
    await expect(fold).toHaveCount(1);
    await expect(fold).not.toHaveAttribute("open", /.*/);
    // The folded header is `Recently opened`, and it is the only fold.
    await expect(fold.locator("summary .wiki-sec-label")).toHaveText("Recently opened");
    expect(await relPathsIn(page, "recent")).toEqual([HUB]);
    // The page on screen is NOT in there — it is in the listing, highlighted.

    await fold.locator("summary .wiki-sec-label").click();
    await expect(fold).toHaveAttribute("open", /.*/);

    // …and it STAYS open across a re-render. `renderList` replaces the rows on
    // every keystroke and every navigation, so without the capture/re-apply the
    // reader's expansion is undone by their very next action.
    await page.fill("#wikiSearch", "hub");
    await page.fill("#wikiSearch", "");
    await expect(page.locator(".wiki-rail-fold")).toHaveAttribute("open", /.*/);
  });

  test("clear still clears from inside the summary, and does not toggle the fold", async ({
    page,
  }) => {
    await openRail(page);
    await readPages(page, [HUB, LINKERS[0]!]);
    await expect(page.locator(".wiki-rail-fold")).toHaveCount(1);

    // The `<details>` is captured BEFORE the click and read AFTER it: the list
    // re-renders synchronously, so the element is detached by then — and a
    // detached node still reports whether the click's default action toggled
    // it. That is the only way to tell "preventDefault held" from "the fold
    // toggled and the re-render hid the evidence".
    const outcome = await page.evaluate(() => {
      const el = document.querySelector(".wiki-rail-fold") as HTMLDetailsElement;
      const before = el.open;
      (el.querySelector("[data-clear-recents]") as HTMLElement).click();
      return { before, after: el.open, stillMounted: document.body.contains(el) };
    });
    expect(outcome.before).toBe(false);
    expect(outcome.after).toBe(false);
    expect(outcome.stillMounted).toBe(false);

    // The clear itself landed: the section is gone and so is the store entry.
    await expect(page.locator(".wiki-rail-fold")).toHaveCount(0);
    expect(await relPathsIn(page, "recent")).toEqual([]);
    // …and Activity is untouched by it.
    expect(await relPathsIn(page, "activity")).toHaveLength(DEFAULT_ROWS);
  });

  test("the page being read is never folded away — its .active row stays visible", async ({
    page,
  }) => {
    // Two pages, neither of them news (both 60 days old, far under the score
    // floor), so both are ordinary recents rather than Activity rows.
    await openRail(page);
    await page.locator(`.wiki-list-item[data-relpath="${LINKERS[0]}"]`).click();
    await expect(page.locator(".wiki-article")).toContainText("See");
    await page.locator(`.wiki-list-item[data-relpath="${HUB}"]`).click();
    await expect(page.locator(".wiki-article")).toContainText("Everything points here");

    // The one the reader is ON is in the listing, highlighted and on screen…
    const active = page.locator(".wiki-list-item.active");
    await expect(active).toHaveCount(1);
    await expect(active).toHaveAttribute("data-relpath", HUB);
    await expect(active).toBeVisible();
    expect(await active.evaluate((el) => !!el.closest("details.wiki-rail-fold"))).toBe(false);
    // …and the one they read BEFORE is the recall aid, inside the fold.
    expect(await relPathsIn(page, "recent")).toEqual([LINKERS[0]]);
  });

  test("a query hides Activity, exactly as it hides the other sections", async ({ page }) => {
    await openRail(page);
    await page.fill("#wikiSearch", "fresh");
    await expect(rowsIn(page, "activity")).toHaveCount(0);
    await expect(page.locator(".wiki-sec-label")).toHaveCount(0);
    await page.fill("#wikiSearch", "");
    await expect(rowsIn(page, "activity")).toHaveCount(DEFAULT_ROWS);
  });

  test("a wiki's `.wiki-reader.json` row count reaches the rail", async ({ page }) => {
    // Four pages, all equally new; the only thing that can decide how many rows
    // the section renders is the wiki's own `activity.rows`.
    const res = await fetch(`${BASE}/api/wiki/pages?wiki=${OTHER_WIKI}`);
    const data = (await res.json()) as { pages: unknown[]; activity?: Record<string, number> };
    expect(data.pages).toHaveLength(4);
    expect(data.activity?.rows).toBe(2);

    await openRail(page, OTHER_WIKI);
    await expect(rowsIn(page, "activity")).toHaveCount(2);
    await expect(page.locator(".wiki-list-item")).toHaveCount(4);
  });
});
