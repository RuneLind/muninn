/**
 * SERIES in the /wiki reader — the rail's authored fold (`series:` /
 * `series_label:`) and the reader header a member carries.
 *
 * What the unit tests cannot reach, and the reason this file exists:
 *
 *  1. **The key travels.** A series only appears if the store parses the
 *     frontmatter, `toListing` leaves the two strings on the hot payload, the
 *     client type carries them, `renderList` calls `groupSeries` with
 *     `allPages`, and the painter emits a row that is not a page. Every unit
 *     test in that chain is green with the chain broken.
 *  2. **The claim really reaches the family rule.** The dissolution is a fact
 *     about what `renderList` subtracts before `railGroups`, which no unit test
 *     of either function can see.
 *  3. **The count on screen.** `#wikiCount` counts emitted ROWS; a ghost row is
 *     not one and a closed series lowers the count by exactly its members.
 *  4. **The row grew no seventh element.** `▸` must be INSIDE `.wiki-list-title`
 *     — a DOM child count is the only thing that can prove it.
 *  5. **Contrast in both themes**, measured against whatever actually paints
 *     behind the text rather than against a token named in the source.
 *
 * No model calls: nothing here leaves the process.
 *
 * ENV PREREQUISITE / SPAWN ENV: as every other spec in this directory — a
 * working `.env` at the repo root, and `e2eEnv()` to keep this muninn off
 * Telegram/Slack and off the host's instance-profile flags.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { SETTLED_CREATED_LINE, settleWikiMtimes } from "./settled-wiki.ts";
import { contrastOf } from "./contrast.ts";
import { PINS_KEY_PREFIX } from "../src/dashboard/views/components/wiki-recents.ts";
import {
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_KEY,
  RAIL_WIDTH_MIN,
} from "../src/dashboard/views/components/wiki-rail-width.ts";

const PORT = e2ePort("wiki-rail-series");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-series";
const SERIES_KEY = "series:prov";
const LABEL = "Wiki provenance";

/** Settled, so Activity claims none of these rows: a fresh series member would
 *  move its whole series into Activity, and every OTHER fixture page would be
 *  lifted, so the rail this file asserts about would be a list of Activity rows.
 *  The third wiki below (`WIKI3`) is the one place pages are left fresh. */
function md(title: string, extra: string[] = []): string {
  return ["---", `title: ${title}`, SETTLED_CREATED_LINE, ...extra, "---", "", "Body.", ""].join(
    "\n",
  );
}

/**
 * One wiki holding every series case at once:
 *
 *  - FOUR members of `series: prov` across three stems and three folders — the
 *    head (carrying `series_label:`) is the newest PLAN, so it also earns the
 *    `▸`; a shipped plan; a blog; and a page that is ALSO a stem-family member;
 *  - `plans/fam-slate-*`: three pages sharing a prefix, one of them that fourth
 *    series member — so the family drops to two and DISSOLVES;
 *  - `plans/other-slate-*`: three pages sharing a prefix and carrying no series,
 *    the control that proves the dissolution is the claim and not the fixture;
 *  - `plans/solo.mdx`: in nothing.
 */
const PLAN = "plans/prov-plan.mdx";
const STRIP = "plans/prov-strip.mdx";
const BLOG = "blogs/prov-explained.mdx";
const FAM_MEMBER = "plans/fam-slate-1.mdx";
const SOLO = "plans/solo.mdx";

const PAGES: Array<[string, string]> = [
  [
    PLAN,
    md("Wiki provenance plan", [
      "series: prov",
      `series_label: ${LABEL}`,
      "plan_status: in-flight",
      "status_date: 2026-09-01",
    ]),
  ],
  [
    STRIP,
    md("Provenance chain strip", [
      "series: prov",
      "plan_status: shipped",
      "status_date: 2026-05-01",
    ]),
  ],
  [BLOG, md("Provenance campaign explained", ["series: prov", "status_date: 2026-03-01"])],
  [
    // `Prov`, not `prov`: a CASE VARIANT of the same key. Two spellings are one
    // series — the folds store lower-cases what it compares, so keeping the case
    // minted two groups sharing one `data-fold-key`, one of which overwrote the
    // other's members. Reporting the variant is the wiki linter's job.
    FAM_MEMBER,
    md("Slate piece 1", ["series: Prov", "plan_status: shipped", "status_date: 2026-04-01"]),
  ],
  ["plans/fam-slate-2.mdx", md("Slate piece 2", ["plan_status: shipped"])],
  ["plans/fam-slate-3.mdx", md("Slate piece 3", ["plan_status: shipped"])],
  ["plans/other-slate-1.mdx", md("Other piece 1", ["plan_status: shipped"])],
  ["plans/other-slate-2.mdx", md("Other piece 2", ["plan_status: shipped"])],
  ["plans/other-slate-3.mdx", md("Other piece 3", ["plan_status: shipped"])],
  [SOLO, md("Solo page")],
];

const ALL_PAGES = PAGES.length;
/** The roll-up over all four members: the head is in-flight, two are shipped
 *  (the chain strip and the slate piece), and the blog counts under its FOLDER
 *  because it declares no `plan_status`. */
const ROLLUP = "1 in-flight · 2 shipped · 1 blog";
/** Newest first by `status_date`. */
const MEMBERS = [PLAN, STRIP, FAM_MEMBER, BLOG];

/**
 * A SECOND wiki, for the two cases the fixture above cannot hold:
 *
 *  - a `superseded` member whose SUCCESSOR is in no series. The membership rule
 *    counts that page nowhere, so the reader header has a body the open page is
 *    not in — and pairing it costs its successor an attachment fold, which
 *    would be a second `.wiki-list-group` in a wiki whose group count is the
 *    claim of four cases above;
 *  - an over-long series LABEL, which the fixture above cannot carry either: its
 *    label is asserted verbatim eight times.
 */
const WIKI2 = "e2e-series-orphan";
const ORPHAN_LABEL =
  "Orphan retirement series with a label far past what a 260px rail can show";
const ORPHAN_LIVE = "plans/orphan-live.mdx";
const ORPHAN_RETIRED = "plans/orphan-retired.mdx";
const ORPHAN_SUCCESSOR = "plans/orphan-successor.mdx";
const ORPHAN_PAGES: Array<[string, string]> = [
  [
    ORPHAN_LIVE,
    md("Orphan live plan", [
      "series: orphan",
      `series_label: ${ORPHAN_LABEL}`,
      "plan_status: in-flight",
      "status_date: 2026-09-02",
    ]),
  ],
  [
    // Carries the key AND a successor that does not: a rule-4 child of a page
    // outside the series.
    ORPHAN_RETIRED,
    md("Orphan retired plan", [
      "series: orphan",
      "plan_status: superseded",
      "status_date: 2026-09-01",
      "superseded_by: orphan-successor",
    ]),
  ],
  [ORPHAN_SUCCESSOR, md("Orphan successor")],
];

/**
 * A THIRD wiki, for the one rule the settled fixtures above exclude by
 * construction: a series Activity ranked renders AT its Activity slot. Five
 * members, all settled except two signals:
 *
 *  - `ACT_FRESH`, a member written "now" — Activity ranks it, so the series
 *    moves into Activity with this page peeked under its row;
 *  - `ACT_DIAGRAM`, a fresh `.html` embedded in the settled `ACT_HOST` member —
 *    it ranks FOR its host, so the host is peeked and the diagram stays under
 *    it instead of standing in Activity on its own.
 *
 * The other three members stay behind the `+N more` row.
 */
const WIKI3 = "e2e-series-activity";
const ACT_KEY = "series:act";
const ACT_FRESH = "plans/act-fresh.mdx";
const ACT_HOST = "flows/act-host.mdx";
const ACT_DIAGRAM = "flows/act-host-diagram.html";
const ACT_PAGES: Array<[string, string]> = [
  [ACT_FRESH, md("Act fresh plan", ["series: act", "series_label: Act work", "status_date: 2026-09-01"])],
  [
    ACT_HOST,
    [
      "---",
      "title: Act host overview",
      SETTLED_CREATED_LINE,
      "series: act",
      "status_date: 2026-08-01",
      "---",
      "",
      '<Embed src="./act-host-diagram.html" height="400" title="Diagram" />',
      "",
    ].join("\n"),
  ],
  [ACT_DIAGRAM, "<!doctype html><title>Act host diagram</title><p>Diagram.</p>\n"],
  ["plans/act-old-1.mdx", md("Act old 1", ["series: act", "status_date: 2026-07-01"])],
  ["plans/act-old-2.mdx", md("Act old 2", ["series: act", "status_date: 2026-06-01"])],
  ["plans/act-old-3.mdx", md("Act old 3", ["series: act", "status_date: 2026-05-01"])],
  ["plans/act-loose.mdx", md("Act loose page")],
];

let server: ChildProcess | undefined;
let root = "";
let root2 = "";
let root3 = "";

async function writeWiki(dir: string, pages: Array<[string, string]>): Promise<void> {
  for (const [rel, body] of pages) {
    await mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(dir, rel), body, "utf8");
  }
  await settleWikiMtimes(dir);
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-series-"));
  await writeWiki(root, PAGES);
  root2 = await mkdtemp(path.join(tmpdir(), "muninn-e2e-series-orphan-"));
  await writeWiki(root2, ORPHAN_PAGES);
  root3 = await mkdtemp(path.join(tmpdir(), "muninn-e2e-series-activity-"));
  await writeWiki(root3, ACT_PAGES);
  // Un-settle the two fresh signals: `writeWiki` backdated every mtime.
  const now = new Date();
  for (const rel of [ACT_FRESH, ACT_DIAGRAM]) await utimes(path.join(root3, rel), now, now);

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root},${WIKI2}=${root2},${WIKI3}=${root3}`,
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
  if (root2) await rm(root2, { recursive: true, force: true });
  if (root3) await rm(root3, { recursive: true, force: true });
});

type Page = import("@playwright/test").Page;

async function openWiki(page: Page, wiki: string, params = ""): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${wiki}${params}`);
  await expect(page.locator(".wiki-list-item").first()).toBeAttached();
}

async function openRail(page: Page, params = ""): Promise<void> {
  await openWiki(page, WIKI, params);
}

/** The reader on one page of one wiki, waited for by its own H1 — the article
 *  head is what every series-header case reads. */
async function openPage(page: Page, wiki: string, rel: string, title: string): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${wiki}&relPath=${encodeURIComponent(rel)}`);
  await expect(page.locator(".wiki-article-head h1")).toHaveText(title);
}

const row = (page: Page, rel: string) => page.locator(`.wiki-list-item[data-relpath="${rel}"]`);
const groupRow = (page: Page, key: string) => page.locator(`.wiki-list-group[data-group="${key}"]`);
const seriesRow = (page: Page) => groupRow(page, SERIES_KEY);
const seriesFold = (page: Page) => seriesRow(page).locator(".wiki-group-fold");

async function relPaths(page: Page): Promise<string[]> {
  return page
    .locator(".wiki-list-item")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-relpath") || ""));
}

/** The count the rail reports — `<shown> / <total>`. */
async function countText(page: Page): Promise<string> {
  return (await page.locator("#wikiCount").textContent()) ?? "";
}

async function selectFolder(page: Page, folder: string): Promise<void> {
  await page.locator("#wikiFilters").evaluate((el) => ((el as HTMLDetailsElement).open = true));
  await page.selectOption("#wikiFolder", folder);
}

/** Pin one page for THIS wiki, the way the rail's own store spells it. Applied
 *  at boot, so the caller reloads after it. */
async function pinPage(page: Page, rel: string): Promise<void> {
  await page.evaluate(
    (arg: { key: string; value: string }) => localStorage.setItem(arg.key, arg.value),
    { key: PINS_KEY_PREFIX + WIKI, value: JSON.stringify([rel]) },
  );
}

/** Apply a rail width the way the reader's own store spells it. Applied at
 *  boot, so the caller reloads after it. */
async function setRailWidth(page: Page, px: number): Promise<void> {
  await page.evaluate(
    (arg: { key: string; value: string }) => localStorage.setItem(arg.key, arg.value),
    { key: RAIL_WIDTH_KEY, value: String(px) },
  );
}

test.describe("Wiki rail: a series Activity ranked", () => {
  const activityRow = (page: Page, rel: string) =>
    page.locator(`.wiki-list-item[data-section="activity"][data-relpath="${rel}"]`);

  test("renders AT its Activity slot, peeking the ranked members, with `+N more`", async ({ page }) => {
    await openWiki(page, WIKI3);
    await expect(page.locator(`.wiki-list-group[data-section="activity"][data-group="${ACT_KEY}"]`)).toBeVisible();
    // Nothing else is a series, so there is no `Series` block at all.
    await expect(page.locator('.wiki-list-sec[data-section="series"]')).toHaveCount(0);
    await expect(activityRow(page, ACT_FRESH)).toBeVisible();
    // The diagram ranked for its host: the HOST is peeked, the diagram is not a
    // loose Activity row (it sat alone in Activity, orphaned, before this rule).
    await expect(activityRow(page, ACT_HOST)).toBeVisible();
    await expect(page.locator(`.wiki-list-item[data-relpath="${ACT_DIAGRAM}"]`)).toHaveCount(0);
    await expect(activityRow(page, ACT_HOST).locator(".wiki-fold-chip")).toBeVisible();
    await expect(page.locator(".wiki-list-more")).toHaveText("+3 more");
    // 2 peek rows + the loose page; the three hidden members and the diagram are not rows.
    expect(await countText(page)).toMatch(/^3 \/ /);
  });

  test("`+N more` opens the series in place, and the row is not counted", async ({ page }) => {
    await openWiki(page, WIKI3);
    await page.locator(".wiki-list-more").click();
    await expect(page.locator(".wiki-list-more")).toHaveCount(0);
    const members = page.locator('.wiki-list-item.member[data-section="activity"]');
    await expect(members).toHaveCount(5);
    expect(await countText(page)).toMatch(/^6 \/ /);
    // The same fold key as the series row, so a reload keeps it open.
    await page.reload();
    await expect(page.locator('.wiki-list-item.member[data-section="activity"]')).toHaveCount(5);
    await page.locator(`.wiki-list-group[data-group="${ACT_KEY}"] .wiki-group-fold`).click();
    await expect(page.locator(".wiki-list-more")).toHaveText("+3 more");
  });
});

/**
 * The series RAIL as painted: every element of `#wikiList` from the series row
 * on, with its `::after` — whether it draws one, in which colour, how far from
 * its bottom edge, and the gap to the element before it. A run is the series
 * row plus the `.wiki-series-cont` siblings after it.
 */
async function railRun(page: Page, groupKey: string) {
  // Off the rail first: a hovered member lightens its own segment, and the
  // pointer is left on one after a click on `+N more`.
  await page.mouse.move(0, 0);
  return page.evaluate((key: string) => {
    const kids = Array.from(document.querySelectorAll("#wikiList > *"));
    const start = kids.findIndex((el) => el.getAttribute("data-group") === key);
    return kids.slice(start, start + 12).map((el, i, arr) => {
      const after = getComputedStyle(el, "::after");
      const r = el.getBoundingClientRect();
      const prev = i > 0 ? arr[i - 1]!.getBoundingClientRect() : null;
      return {
        cont: el.classList.contains("wiki-series-cont"),
        drawn: after.content !== "none" && after.content !== "normal",
        colour: after.backgroundColor,
        bottom: after.bottom,
        gap: prev ? r.top - prev.bottom : 0,
      };
    });
  }, groupKey);
}

test.describe("Wiki rail: the series rail", () => {
  // The rows are flat siblings, so the rail is one pseudo-element per row and
  // it only reads as ONE line if every row of the run draws it, flush with the
  // next, and the row after the run does not.
  const checkRun = (run: Awaited<ReturnType<typeof railRun>>, length: number) => {
    const inRun = run.slice(0, length);
    expect(inRun.slice(1).every((r) => r.cont)).toBe(true);
    for (const r of inRun) expect(r.drawn).toBe(true);
    expect(new Set(inRun.map((r) => r.colour)).size).toBe(1);
    for (const r of inRun.slice(1)) expect(Math.abs(r.gap)).toBeLessThan(0.5);
    // Capped on the last row of the run and nowhere before it.
    expect(inRun.slice(0, -1).map((r) => r.bottom)).toEqual(inRun.slice(0, -1).map(() => "0px"));
    expect(inRun.at(-1)!.bottom).toBe("4px");
    // …and the row after the run is outside it.
    const next = run[length];
    if (next) {
      expect(next.cont).toBe(false);
      expect(next.drawn && next.colour === inRun[0]!.colour).toBe(false);
    }
  };

  test("runs from an Activity series row through its peek and `+N more`, then stops", async ({ page }) => {
    await openWiki(page, WIKI3);
    await expect(page.locator(".wiki-list-more")).toHaveText("+3 more");
    // Series row, the peeked members, `+N more`.
    const closed = await railRun(page, ACT_KEY);
    const closedLen = closed.findIndex((r, i) => i > 0 && !r.cont);
    expect(closedLen).toBeGreaterThan(2);
    checkRun(closed, closedLen);

    await page.locator(".wiki-list-more").click();
    await expect(page.locator(".wiki-list-more")).toHaveCount(0);
    const open = await railRun(page, ACT_KEY);
    const openLen = open.findIndex((r, i) => i > 0 && !r.cont);
    checkRun(open, openLen === -1 ? open.length : openLen);
  });

  // Forced colours (Windows High Contrast) repaint every background as Canvas,
  // which erases a rail drawn as a background — the border it replaced was
  // repainted as a visible colour. The rail must stay distinct from the pane.
  test("the rail survives forced colours — on every row of the run, hovered too", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await openWiki(page, WIKI3);
    await page.locator(".wiki-list-more").click();
    await expect(page.locator(".wiki-list-more")).toHaveCount(0);
    const pane = await page
      .locator(".wiki-pane")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const rails = async () => {
      await page.mouse.move(0, 0);
      return page.evaluate((key: string) => {
        const kids = Array.from(document.querySelectorAll("#wikiList > *"));
        const start = kids.findIndex((el) => el.getAttribute("data-group") === key);
        const run = [kids[start]!];
        for (let i = start + 1; kids[i]?.classList.contains("wiki-series-cont"); i++) run.push(kids[i]!);
        return run.map((el) => getComputedStyle(el, "::after").backgroundColor);
      }, ACT_KEY);
    };
    const run = await rails();
    expect(run.length).toBeGreaterThan(2);
    for (const c of run) expect(c).not.toBe(pane);
    // A hovered member is the row the reader is about to click, and its hover
    // colour must not win the cascade back to Canvas.
    const member = page.locator('.wiki-list-item.member.wiki-series-cont[data-section="activity"]').first();
    await member.hover();
    expect(await member.evaluate((el) => getComputedStyle(el, "::after").backgroundColor)).not.toBe(pane);
  });

  test("a FOLDED series row caps its own rail", async ({ page }) => {
    await openRail(page);
    const run = await railRun(page, SERIES_KEY);
    expect(run[0]!.drawn).toBe(true);
    expect(run[0]!.bottom).toBe("4px");
    expect(run[1]?.cont ?? false).toBe(false);
  });
});

test.describe("Wiki rail: series", () => {
  test("ONE series row, always on — no toggle, no query", async ({ page }) => {
    await openRail(page);
    // The `group families` toggle is OFF and the series is there anyway: it is
    // an authored key, not a name heuristic.
    await expect(page.locator("#wikiGroupFamilies")).not.toBeChecked();
    await expect(page.locator(".wiki-list-group")).toHaveCount(1);
    await expect(seriesRow(page).locator(".wiki-group-label")).toContainText(LABEL);
    await expect(seriesRow(page).locator(".wiki-group-rollup")).toHaveText(ROLLUP);
    // Only the two coloured statuses carry a class: the status word is free
    // frontmatter, so it never becomes a class name of its own.
    const tones = await seriesRow(page)
      .locator(".wiki-rollup-part")
      .evaluateAll((els) => els.map((el) => el.className));
    expect(tones).toEqual([
      "wiki-rollup-part s-in-flight",
      "wiki-rollup-part s-shipped",
      "wiki-rollup-part",
    ]);
    await expect(seriesFold(page)).toHaveAttribute("aria-expanded", "false");
    // Closed by default: the four members are off the list…
    const rel = await relPaths(page);
    for (const m of MEMBERS) expect(rel, m).not.toContain(m);
    // …and `#wikiCount` went down by exactly them.
    expect(await countText(page)).toBe(`${ALL_PAGES - MEMBERS.length} / ${ALL_PAGES}`);
  });

  test("the row OPENS into its members, newest first, across folders", async ({ page }) => {
    await openRail(page);
    await seriesFold(page).click();
    await expect(seriesFold(page)).toHaveAttribute("aria-expanded", "true");
    const rel = await relPaths(page);
    // The four members are contiguous and in `status_date` order.
    const seen = rel.filter((r) => (MEMBERS as string[]).includes(r));
    expect(seen).toEqual(MEMBERS);
    expect(rel.indexOf(MEMBERS[3]!) - rel.indexOf(MEMBERS[0]!)).toBe(3);
    // Every member says which series it is in.
    await expect(row(page, BLOG)).toHaveClass(/member/);
    await expect(row(page, BLOG)).toHaveAttribute("title", new RegExp(`In the ${LABEL} series`));
    // The group row is not a page: it opened nothing.
    await expect(page.locator(".wiki-start")).toBeVisible();
    expect(await countText(page)).toBe(`${ALL_PAGES} / ${ALL_PAGES}`);
  });

  test("a member is not ALSO a plain row, a family row or a blogs row", async ({ page }) => {
    await openRail(page);
    await page.locator("#wikiGroupFamilies").check();
    await expect(page.locator(".wiki-list-group").first()).toBeAttached();
    await seriesFold(page).click();
    const rel = await relPaths(page);
    // Exactly one row per member, and each is a series member row.
    for (const m of MEMBERS) {
      expect(rel.filter((r) => r === m), m).toHaveLength(1);
      await expect(row(page, m), m).toHaveClass(/member/);
      await expect(row(page, m), m).toHaveAttribute("title", new RegExp(`${LABEL} series`));
    }
    // The family the series took a member from DISSOLVED…
    await expect(groupRow(page, "family:plans/fam-slate")).toHaveCount(0);
    expect(rel).toContain("plans/fam-slate-2.mdx");
    expect(rel).toContain("plans/fam-slate-3.mdx");
    // …while the untouched three-page prefix beside it still folds, which is
    // what makes the dissolution the CLAIM's doing and not the fixture's.
    await expect(groupRow(page, "family:plans/other-slate")).toHaveCount(1);
  });

  test("the `▸` on the newest plan is INSIDE the title — no seventh element", async ({ page }) => {
    await openRail(page);
    await seriesFold(page).click();
    const latest = row(page, PLAN);
    await expect(latest.locator(".wiki-list-title .wiki-latest-glyph")).toHaveText("▸");
    await expect(latest).toHaveAttribute("title", /newest plan in this series/);
    // No other row carries it.
    await expect(page.locator(".wiki-latest-glyph")).toHaveCount(1);
    // The row's own child count is unchanged against a sibling that is not the
    // latest — same section, same chrome, one glyph of difference.
    const childCounts = await page.evaluate(
      (arg: { latest: string; plain: string }) => {
        const count = (rel: string) =>
          document.querySelector(`.wiki-list-item[data-relpath="${rel}"]`)!.children.length;
        return { latest: count(arg.latest), plain: count(arg.plain) };
      },
      { latest: PLAN, plain: STRIP },
    );
    expect(childCounts.latest).toBe(childCounts.plain);
  });

  test("a PINNED member is a real row above and a GHOST row inside", async ({ page }) => {
    await openRail(page);
    await pinPage(page, FAM_MEMBER);
    await openRail(page);
    await seriesFold(page).click();
    // One real row, under Pinned.
    const pinned = row(page, FAM_MEMBER);
    await expect(pinned).toHaveCount(1);
    await expect(pinned).toHaveAttribute("data-section", "pinned");
    // …and a ghost inside the fold, which is not a `.wiki-list-item` and so
    // cannot be a second row for the same page.
    const ghost = page.locator(`.wiki-list-ghost[data-ghost-relpath="${FAM_MEMBER}"]`);
    await expect(ghost).toHaveCount(1);
    await expect(ghost).toContainText("pinned above");
    // The roll-up still counts it: the census is a fact about the series.
    await expect(seriesRow(page).locator(".wiki-group-rollup")).toHaveText(ROLLUP);
    // And the page is counted ONCE.
    expect(await countText(page)).toBe(`${ALL_PAGES} / ${ALL_PAGES}`);
    await page.evaluate((key: string) => localStorage.removeItem(key), PINS_KEY_PREFIX + WIKI);
  });

  test("under a folder facet the row says `N of M shown`", async ({ page }) => {
    await openRail(page);
    await selectFolder(page, "plans");
    await expect(seriesRow(page).locator(".wiki-group-sub")).toHaveText("3 of 4 shown");
    await seriesFold(page).click();
    const rel = await relPaths(page);
    expect(rel).toContain(PLAN);
    expect(rel).toContain(STRIP);
    expect(rel).toContain(FAM_MEMBER);
    expect(rel).not.toContain(BLOG);
    // …and with the whole series on screen it says nothing at all.
    await selectFolder(page, "");
    await expect(seriesRow(page).locator(".wiki-group-sub")).toHaveCount(0);
  });

  test("a QUERY flattens the series", async ({ page }) => {
    await openRail(page);
    await page.fill("#wikiSearch", "provenance");
    await expect(page.locator(".wiki-list-group")).toHaveCount(0);
    await expect(page.locator(".wiki-latest-glyph")).toHaveCount(0);
    const rel = await relPaths(page);
    expect(rel).toContain(PLAN);
    expect(rel).toContain(BLOG);
    await page.fill("#wikiSearch", "");
    await expect(page.locator(".wiki-list-group")).toHaveCount(1);
  });

  test("the fold survives a reload, and the OPEN page forces it open inertly", async ({ page }) => {
    await openRail(page);
    await seriesFold(page).click();
    await openRail(page); // same context ⇒ same localStorage
    await expect(seriesFold(page)).toHaveAttribute("aria-expanded", "true");
    expect(await relPaths(page)).toContain(BLOG);
    await seriesFold(page).click();
    await openRail(page);
    expect(await relPaths(page)).not.toContain(BLOG);

    // On a member's own page the fold is open whatever the store holds, and its
    // control says so rather than pretending to toggle.
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(BLOG)}`);
    await expect(page.locator(".wiki-list-item").first()).toBeAttached();
    await expect(row(page, BLOG)).toHaveClass(/active/);
    await expect(seriesFold(page)).toHaveAttribute("aria-expanded", "true");
    await expect(seriesFold(page)).toBeDisabled();
    await expect(seriesFold(page)).toHaveAttribute("title", /open page is in this group/);
    await seriesFold(page).click({ force: true });
    expect(await relPaths(page)).toContain(BLOG);
  });

  test("the reader header names the series, the count and where to continue", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(STRIP)}`);
    const head = page.locator(".wiki-series-head");
    await expect(head).toBeVisible();
    await expect(head.locator(".wiki-series-name")).toHaveText(LABEL);
    await expect(head.locator(".wiki-series-count")).toHaveText("4 pages");
    await expect(head.locator(".wiki-series-continue")).toContainText("continue at:");
    await expect(head.locator(".wiki-series-go")).toHaveText("Wiki provenance plan");
    // The timeline is oldest → newest with the open page marked.
    const steps = head.locator(".wiki-series-step-title");
    await expect(steps).toHaveText([
      "Provenance campaign explained",
      "Slate piece 1",
      "Provenance chain strip",
      "Wiki provenance plan",
    ]);
    await expect(head.locator(".wiki-series-step.current .wiki-series-step-title")).toHaveText(
      "Provenance chain strip",
    );
    // `continue at:` opens it.
    await head.locator(".wiki-series-go").click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Wiki provenance plan");
  });

  test("on the newest plan, `continue at:` names the NEXT-newest plan", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(PLAN)}`);
    const head = page.locator(".wiki-series-head");
    await expect(head.locator(".wiki-series-go")).toHaveText("Provenance chain strip");
    // …and never the page the reader already has open.
    await expect(head.locator(".wiki-series-go")).not.toHaveText("Wiki provenance plan");
  });

  test("a page in no series gets no header at all", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(SOLO)}`);
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Solo page");
    await expect(page.locator(".wiki-series-head")).toHaveCount(0);
  });

  test("a RETIRED page whose successor is in no series gets no header either", async ({ page }) => {
    // The control first: the one page the membership rule DOES count carries the
    // header, so the case below is about membership and not about this wiki.
    await openPage(page, WIKI2, ORPHAN_LIVE, "Orphan live plan");
    const head = page.locator(".wiki-series-head");
    await expect(head.locator(".wiki-series-count")).toHaveText("1 page");
    await expect(head.locator(".wiki-series-step.current .wiki-series-step-title")).toHaveText(
      "Orphan live plan",
    );

    // The retired page carries the same key and counts NOWHERE: it renders under
    // a successor that is in no series. Its own key still resolves to a series
    // with a member in it, so a `members.length` guard let the header paint
    // `1 page` and a timeline over a body the open page is not in.
    await openPage(page, WIKI2, ORPHAN_RETIRED, "Orphan retired plan");
    await expect(page.locator(".wiki-series-head")).toHaveCount(0);
  });

  test("an over-long series label CLAMPS at two lines rather than spilling the row", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openWiki(page, WIKI2);
    await setRailWidth(page, RAIL_WIDTH_MIN);
    await openWiki(page, WIKI2);
    const name = groupRow(page, "series:orphan").locator(".wiki-group-name");
    await expect(name).toHaveText(ORPHAN_LABEL);
    // The name has the whole row now that the roll-up is on its own line, so it
    // wraps like a page title and clips at the second line. The HEIGHT is the
    // proof: Chromium reports this box's display as \`flow-root\`, not
    // \`-webkit-box\`, so the computed styles alone say little.
    const fit = await name.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        clamp: cs.webkitLineClamp,
        lineHeight: parseFloat(cs.lineHeight),
        client: el.clientHeight,
        scroll: el.scrollHeight,
      };
    });
    expect(fit.clamp).toBe("2");
    expect(fit.client).toBeGreaterThan(1.5 * fit.lineHeight);
    expect(fit.client).toBeLessThanOrEqual(2 * fit.lineHeight + 1);
    expect(fit.scroll).toBeGreaterThan(fit.client);
  });

  test("a CASE VARIANT of the key is the same series, not a second one", async ({ page }) => {
    await openRail(page);
    // One group row, one fold key, and the variant member inside it — the whole
    // series, whichever way its four pages spell the key.
    await expect(page.locator(".wiki-list-group")).toHaveCount(1);
    await expect(seriesRow(page)).toHaveCount(1);
    await seriesFold(page).click();
    const rel = await relPaths(page);
    for (const m of MEMBERS) expect(rel, m).toContain(m);
    await expect(row(page, FAM_MEMBER)).toHaveClass(/member/);
  });

  test("the accent rail costs the series row no width — its mid matches a family's", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openRail(page);
    await page.locator("#wikiGroupFamilies").check();
    await expect(groupRow(page, "family:plans/other-slate")).toHaveCount(1);
    // The rail is an absolute pseudo-element, not a border, so the series row's
    // `.wiki-list-mid` is exactly a family row's — a border here cost 2px.
    const mids = await page.evaluate(() => {
      const mid = (el: Element) =>
        (el.querySelector(".wiki-list-mid") as HTMLElement).getBoundingClientRect().width;
      const groups = Array.from(document.querySelectorAll(".wiki-list-group"));
      return {
        series: mid(groups.find((g) => g.classList.contains("series"))!),
        family: mid(groups.find((g) => !g.classList.contains("series"))!),
      };
    });
    expect(mids.series).toBeCloseTo(mids.family, 1);
  });

  test("the reader header counts the SAME pages the fold does", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(STRIP)}`);
    const head = page.locator(".wiki-series-head");
    await expect(head.locator(".wiki-series-count")).toHaveText(`${MEMBERS.length} pages`);
    // …including the member whose key is spelled differently, which a header
    // filtering `allPages` on the raw string dropped.
    const titles = await head.locator(".wiki-series-step-title").allTextContents();
    expect(titles).toHaveLength(MEMBERS.length);
    expect(titles).toContain("Slate piece 1");
    // Every step carries the day the fold ordered it by — none is blank.
    const days = await head.locator(".wiki-series-step-date").allTextContents();
    expect(days.filter((d) => d.trim() !== "")).toHaveLength(MEMBERS.length);

    // …and the page whose OWN key is the case variant gets the same header,
    // which is what makes the membership helper's fold load-bearing on both
    // sides rather than only on the one spelling the majority wrote.
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(FAM_MEMBER)}`);
    await expect(head.locator(".wiki-series-name")).toHaveText(LABEL);
    await expect(head.locator(".wiki-series-count")).toHaveText(`${MEMBERS.length} pages`);
  });

  // The census is the one thing on a group row a reader is asked to READ, and
  // `toHaveText` passes on a fully clipped element — it reads the DOM, not the
  // paint. Measured at the shipped default and at the narrowest rail, in both
  // themes, because the label beside it is what ate the width.
  for (const scheme of ["light", "dark"] as const) {
    for (const width of [RAIL_WIDTH_DEFAULT, RAIL_WIDTH_MIN]) {
      test(`the roll-up and the \`N of M shown\` census are fully visible at ${width}px, ${scheme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await openRail(page);
        await setRailWidth(page, width);
        await openRail(page);
        await selectFolder(page, "plans");
        await expect(seriesRow(page).locator(".wiki-group-sub")).toHaveText("3 of 4 shown");
        for (const sel of [".wiki-group-sub", ".wiki-group-rollup"]) {
          const sub = seriesRow(page).locator(sel);
          // ⚠️ `clientWidth`/`scrollWidth` alone CANNOT see this failure: the
          // shipped census was an INLINE `<small>`, whose two are both 0, so the
          // check passed on an element painting 15px of its 65. What it was
          // clipped by is an ANCESTOR's overflow, so the measurement has to walk
          // up to every clipping box and intersect.
          const fit = await sub.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            let clipLeft = -Infinity;
            let clipRight = Infinity;
            for (let n = el.parentElement; n; n = n.parentElement) {
              if (getComputedStyle(n).overflowX === "visible") continue;
              const r = n.getBoundingClientRect();
              clipLeft = Math.max(clipLeft, r.left);
              clipRight = Math.min(clipRight, r.right);
            }
            return {
              natural: rect.width,
              visible: Math.max(0, Math.min(rect.right, clipRight) - Math.max(rect.left, clipLeft)),
              client: el.clientWidth,
              scroll: el.scrollWidth,
            };
          });
          expect(fit.natural).toBeGreaterThan(0);
          // Every pixel the census lays out is a pixel that gets painted…
          expect(fit.visible).toBeGreaterThanOrEqual(fit.natural - 0.5);
          // …and its own box does not ellipsize the words either.
          expect(fit.client).toBeGreaterThanOrEqual(fit.scroll);
          expect(await contrastOf(sub)).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }

  // Both themes, measured rather than eyeballed — these are a label, a name and
  // a title, so 4.5:1 is the floor, and the background is whatever actually
  // paints behind the element, which a `toHaveCSS("color", <token>)` assertion
  // cannot see.
  for (const scheme of ["light", "dark"] as const) {
    test(`the series row and header are legible in the ${scheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openRail(page);
      await selectFolder(page, "plans");
      expect(await contrastOf(seriesRow(page).locator(".wiki-group-label"))).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(await contrastOf(seriesRow(page).locator(".wiki-group-sub"))).toBeGreaterThanOrEqual(
        4.5,
      );
      // The roll-up line, and each count in it: the live statuses carry colours
      // of their own, so the line's colour alone would not see a failing part.
      expect(await contrastOf(seriesRow(page).locator(".wiki-group-rollup"))).toBeGreaterThanOrEqual(
        4.5,
      );
      for (const part of await seriesRow(page).locator(".wiki-rollup-part").all()) {
        expect(await contrastOf(part)).toBeGreaterThanOrEqual(4.5);
      }
      // …and in the state the reader clicks it in: hovered, which recolours the
      // name and the roll-up line.
      await seriesRow(page).locator(".wiki-group-label").hover();
      expect(await contrastOf(seriesRow(page).locator(".wiki-group-label"))).toBeGreaterThanOrEqual(
        4.5,
      );
      for (const part of await seriesRow(page).locator(".wiki-rollup-part, .wiki-group-rollup").all()) {
        expect(await contrastOf(part)).toBeGreaterThanOrEqual(4.5);
      }

      await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(STRIP)}`);
      const head = page.locator(".wiki-series-head");
      expect(await contrastOf(head.locator(".wiki-series-name"))).toBeGreaterThanOrEqual(4.5);
      expect(await contrastOf(head.locator(".wiki-series-count"))).toBeGreaterThanOrEqual(4.5);
      expect(await contrastOf(head.locator(".wiki-series-go"))).toBeGreaterThanOrEqual(4.5);
      expect(
        await contrastOf(head.locator(".wiki-series-step-title").first()),
      ).toBeGreaterThanOrEqual(4.5);
      // The DATE is text the reader is asked for and it appears nowhere else on
      // the step, so it takes the same floor as the title beside it.
      expect(
        await contrastOf(head.locator(".wiki-series-step-date").first()),
      ).toBeGreaterThanOrEqual(4.5);
    });

    // Its own case, so a failing date cell cannot mask it: the `▸` is the whole
    // claim "this is the plan to continue in" compressed into one mark, and it
    // is the only thing on that row saying so.
    test(`the \`▸\` on the newest plan is legible in the ${scheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openRail(page);
      await seriesFold(page).click();
      const glyph = page.locator(".wiki-latest-glyph");
      await expect(glyph).toHaveCount(1);
      expect(await contrastOf(glyph)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
