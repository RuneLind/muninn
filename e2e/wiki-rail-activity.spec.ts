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
 *     the fold's summary, and whether that costs anything is a browser question
 *     no unit test can ask. (It does not: a <button> is its own activation
 *     target, so the click never reaches the <details> as a toggle — measured
 *     here, and the case below is what keeps measuring it.)
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
/** A third plain wiki asking for MORE rows than the first ceiling allowed, so the
 *  raised `ACTIVITY_ROWS_MAX` is proved through the whole chain rather than only
 *  in the parser: `.wiki-reader.json` → the resolved payload → the client's own
 *  re-parse → the rendered rows. */
const MANY_WIKI = "e2e-activity-many";
const MANY_ROWS = 20;
const MANY_PAGES = 22;

const DAY = 86_400_000;

/** Older than the rail's relative window (99 days), so its row can only render a
 *  calendar date. The one page here whose date is past that seam. */
const ANCIENT = "notes/ancient.md";
const ANCIENT_DAYS = 200;
const HUB = "concepts/hub.md";
const PLAN = "plans/young-plan.md";
const BRAND_NEW = "notes/brand-new.md";
const FRESH = [0, 1, 2, 3].map((i) => `notes/fresh-${i}.md`);
const LINKERS = [1, 2, 3, 4, 5, 6].map((i) => `concepts/link-${i}.md`);

/** Every page of the git wiki, so a count assertion says what it means. */
const ALL_PAGES = 1 + 1 + 1 + 1 + FRESH.length + LINKERS.length;
/** The default `rows`, which this wiki does not override. */
const DEFAULT_ROWS = 6;

function md(title: string, body: string, extra: string[] = []): string {
  return ["---", `title: ${title}`, ...extra, "---", "", body, ""].join("\n");
}

let server: ChildProcess | undefined;
let root = "";
let otherRoot = "";
let manyRoot = "";

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
  manyRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-activity-many-"));
  const now = Date.now();

  // `plan` is not one of the built-in types, so the wiki declares it — which is
  // also what makes the plan boost reachable at all.
  await writeFile(
    path.join(root, ".wiki-reader.json"),
    JSON.stringify({ typeMap: { plans: "plan" } }),
    "utf8",
  );

  git(["init", "-q", "-b", "main"]);

  // T-200d — one page older than the rail's relative window, committed FIRST so
  // history order matches date order. Nothing ever touches it again, so it scores
  // under the floor and stays a plain listing row.
  await write(ANCIENT, md("Ancient note", "Written long ago."));
  commit(now - ANCIENT_DAYS * DAY, "the ancient note");

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

  // The third wiki, same all-brand-new shape, with MORE pages than the rows it
  // asks for — so the rendered count can only be the wiki's own number.
  await writeFile(
    path.join(manyRoot, ".wiki-reader.json"),
    JSON.stringify({ activity: { rows: MANY_ROWS } }),
    "utf8",
  );
  for (let i = 1; i <= MANY_PAGES; i++) {
    await writeFile(path.join(manyRoot, `m-${i}.md`), md(`Many ${i}`, "Body."), "utf8");
  }

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root},${OTHER_WIKI}=${otherRoot},${MANY_WIKI}=${manyRoot}`,
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
  if (manyRoot) await rm(manyRoot, { recursive: true, force: true });
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

/** `YYYY-MM-DD` in the runner's own timezone, the way `localDay` builds it. Derived
 *  from the stamp the payload reports rather than from a literal, or the case would
 *  pass only in one timezone and only on one day. */
function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The update stamp the listing carries for a page — the signal the default
 *  `Recently updated` sort, and so every rail row's date, is derived from. */
async function updateStampOf(relPath: string): Promise<number> {
  const res = await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`);
  const data = (await res.json()) as {
    pages: Array<{ relPath: string; gitTouchedMs?: number; gitCreatedMs?: number }>;
  };
  const p = data.pages.find((x) => x.relPath === relPath);
  if (!p) throw new Error(`no listing row for ${relPath}`);
  const ms = p.gitTouchedMs ?? p.gitCreatedMs;
  if (!ms) throw new Error(`no git stamp for ${relPath}`);
  return ms;
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

    // The TITLE element is two thirds of the row and carries a `title=` of its
    // own, which wins over the row's wherever the pointer actually lands — so
    // the derivation has to be on it too, under the page's own name.
    await expect(changedRow.locator(".wiki-list-title")).toHaveAttribute(
      "title",
      /^Young plan\nchanged .* hub ×/s,
    );

    // A listing row carries no glyph — the mark means "this is in Activity".
    await expect(
      page.locator(`.wiki-list-item[data-relpath="${HUB}"] .wiki-act-glyph`),
    ).toHaveCount(0);

    // The date cell is the age of the winning signal, relative.
    await expect(newRow.locator(".wiki-list-meta")).toHaveText("now");
    await expect(changedRow.locator(".wiki-list-meta")).toHaveText("1d");

    // The glyphs resolve to the TOKENS they are declared with, compared against
    // the same tokens read off a probe in this document — a literal colour here
    // would pass against any theme and pin nothing. `--tok-str` rather than
    // `--status-success` is a contrast decision (see the CSS comment); a revert
    // to the plain status green has to fail something. The last line holds
    // because Playwright's default colorScheme is LIGHT, which is the theme the
    // swap was made for; in dark the two tokens are the same value.
    const token = (name: string) =>
      page.evaluate((n) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${n})`;
        document.body.appendChild(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      }, name);
    await expect(newRow.locator(".wiki-act-glyph.new")).toHaveCSS("color", await token("--tok-str"));
    await expect(changedRow.locator(".wiki-act-glyph.changed")).toHaveCSS(
      "color",
      await token("--accent-light"),
    );
    expect(await token("--tok-str")).not.toBe(await token("--status-success"));
  });

  test("a query hides Activity, exactly as it hides Pinned", async ({ page }) => {
    await openRail(page);
    await page.fill("#wikiSearch", "fresh");
    await expect(rowsIn(page, "activity")).toHaveCount(0);
    await expect(page.locator(".wiki-sec-label")).toHaveCount(0);
    await page.fill("#wikiSearch", "");
    await expect(rowsIn(page, "activity")).toHaveCount(DEFAULT_ROWS);
  });

  test("a row past 99 days shows its DATE, and the meta keeps the full date on hover", async ({
    page,
  }) => {
    // The seam this case exists for: `formatRailAge` counts days up to 99 and
    // names the day after that. A unit test pins the arithmetic; only a real
    // backdated repo proves the rail asks it about the same stamp the listing
    // sorted on — and that the date survives the trip through the payload.
    const stamp = await updateStampOf(ANCIENT);
    expect(Math.round((Date.now() - stamp) / DAY)).toBe(ANCIENT_DAYS);
    const day = localDay(stamp);

    await openRail(page);
    const meta = page.locator(`.wiki-list-item[data-relpath="${ANCIENT}"] .wiki-list-meta`);
    await expect(meta).toHaveText(day);
    // The hover date is on the META element, not the row: a child's own `title=`
    // wins over its ancestors' wherever the pointer lands, so a title left on the
    // row would be unreachable over the cell it describes.
    await expect(meta).toHaveAttribute("title", day);
  });

  test("a row inside the window shows `Nd` and carries the full date as its title", async ({
    page,
  }) => {
    // 60 days old and never touched since — inside the 99-day window, so the cell
    // counts days while the tooltip still says which day.
    const stamp = await updateStampOf(LINKERS[0]!);
    expect(Math.round((Date.now() - stamp) / DAY)).toBe(60);

    await openRail(page);
    const meta = page.locator(`.wiki-list-item[data-relpath="${LINKERS[0]}"] .wiki-list-meta`);
    await expect(meta).toHaveText("60d");
    await expect(meta).toHaveAttribute("title", localDay(stamp));
  });

  test("a Pinned row shows the compact age too, not a bare date", async ({ page }) => {
    // Pinned is a different claim path through `buildRail` than Activity and the
    // listing, and it used to render `pageDateLabel` directly — so the compact age
    // has to be proved on a row the rail LIFTED, not only on a listing row.
    const stamp = await updateStampOf(LINKERS[1]!);
    await openRail(page);
    // ★ is hover-only on an unpinned row, and the section it creates appears on the
    // NEXT render — both the `wiki-rail-pins` spec's rules, not this feature's.
    const row = page.locator(`.wiki-list-item[data-relpath="${LINKERS[1]}"]`);
    await row.hover();
    await row.locator(".wiki-pin").click();
    await expect(row.locator(".wiki-pin")).toHaveAttribute("aria-pressed", "true");
    await page.fill("#wikiSearch", "zzz-no-such-page");
    await page.fill("#wikiSearch", "");

    const pinned = page.locator(`.wiki-list-item[data-section="pinned"]`);
    await expect(pinned).toHaveCount(1);
    await expect(pinned).toHaveAttribute("data-relpath", LINKERS[1]!);
    await expect(pinned.locator(".wiki-list-meta")).toHaveText("60d");
    await expect(pinned.locator(".wiki-list-meta")).toHaveAttribute("title", localDay(stamp));
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

  test(`a wiki may ask for ${MANY_ROWS} rows, past the first ceiling of 12`, async ({ page }) => {
    // 22 equally-new pages and a wiki asking for 20: the count rendered can only
    // come from the wiki's own `rows`, and a clamp still set to 12 fails here.
    const res = await fetch(`${BASE}/api/wiki/pages?wiki=${MANY_WIKI}`);
    const data = (await res.json()) as { pages: unknown[]; activity?: Record<string, number> };
    expect(data.pages).toHaveLength(MANY_PAGES);
    expect(data.activity?.rows).toBe(MANY_ROWS);

    await openRail(page, MANY_WIKI);
    await expect(rowsIn(page, "activity")).toHaveCount(MANY_ROWS);
    await expect(page.locator(".wiki-list-item")).toHaveCount(MANY_PAGES);
  });
});
