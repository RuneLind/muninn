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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

/** Settled, so Activity claims none of these rows. A series member would not be
 *  lifted by Activity anyway — that is one of the rules here — but every OTHER
 *  fixture page would be, and the rail this file asserts about would be a list
 *  of Activity rows. */
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

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-series-"));
  for (const [rel, body] of PAGES) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
  await settleWikiMtimes(root);

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root}`,
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
});

type Page = import("@playwright/test").Page;

async function openRail(page: Page, params = ""): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}${params}`);
  await expect(page.locator(".wiki-list-item").first()).toBeAttached();
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

test.describe("Wiki rail: series", () => {
  test("ONE series row, always on — no toggle, no query", async ({ page }) => {
    await openRail(page);
    // The `group families` toggle is OFF and the series is there anyway: it is
    // an authored key, not a name heuristic.
    await expect(page.locator("#wikiGroupFamilies")).not.toBeChecked();
    await expect(page.locator(".wiki-list-group")).toHaveCount(1);
    await expect(seriesRow(page).locator(".wiki-group-label")).toContainText(LABEL);
    await expect(seriesRow(page).locator(".wiki-fold-chip-label")).toHaveText(ROLLUP);
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
    // The chip still counts it: the census is a fact about the series.
    await expect(seriesRow(page).locator(".wiki-fold-chip-label")).toHaveText(ROLLUP);
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

  test("the accent rule costs the series row no width — its mid matches a family's", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openRail(page);
    await page.locator("#wikiGroupFamilies").check();
    await expect(groupRow(page, "family:plans/other-slate")).toHaveCount(1);
    // `.wiki-list-mid` is what `RAIL_GROUP_CHIP_SWITCH`'s container query
    // measures, so a 2px difference moves the chip's breakpoint on series rows
    // alone — the 2px border is paid back out of the fold's own left padding.
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
      test(`the \`N of M shown\` census is fully visible at ${width}px, ${scheme}`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.emulateMedia({ colorScheme: scheme });
        await openRail(page);
        await setRailWidth(page, width);
        await openRail(page);
        await selectFolder(page, "plans");
        const sub = seriesRow(page).locator(".wiki-group-sub");
        await expect(sub).toHaveText("3 of 4 shown");
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
      expect(
        await contrastOf(seriesRow(page).locator(".wiki-fold-chip-label")),
      ).toBeGreaterThanOrEqual(4.5);
      // …and in the state the reader clicks it in: hovered, which paints a
      // background of its own behind the transparent chip.
      await seriesRow(page).locator(".wiki-group-label").hover();
      expect(await contrastOf(seriesRow(page).locator(".wiki-group-label"))).toBeGreaterThanOrEqual(
        4.5,
      );

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
