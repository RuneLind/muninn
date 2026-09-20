/**
 * FAMILIES and MONTHS in the /wiki reader's page rail — the render half of the
 * pure grouping rule (`wiki-groups.ts`) behind the head's `group families`
 * toggle.
 *
 * What the unit tests cannot reach, and the reason this file exists:
 *
 *  1. **The toggle is a chain, not a function.** Whether a family ever appears
 *     depends on the checkbox writing its sentinel into the folds store, the
 *     boot read painting the box from it, `renderList` calling `railGroups` with
 *     the wiki's own `projects` map, and the painter emitting a row that is not
 *     a page. Every unit test in that chain is green with the chain broken.
 *  2. **The count on screen.** `#wikiCount` counts emitted ROWS, and a group row
 *     is not one — a closed family has to lower it by exactly its members.
 *  3. **The fold and the toggle survive a reload.** Both live in the one folds
 *     key, per wiki, like the attachment folds.
 *  4. **The newest month's inverted default.** It is open with NO key stored and
 *     closed with one, which is the only place the store's one namespace holds
 *     two defaults — a browser is the only thing that can prove the click
 *     writes the key the reload then reads.
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
import {
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_KEY,
  RAIL_WIDTH_MIN,
} from "../src/dashboard/views/components/wiki-rail-width.ts";

const PORT = e2ePort("wiki-rail-families");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-fam";

/** Settled, so Activity claims none of these rows — every one of them would
 *  otherwise be lifted out of the very family this file is about. */
function md(title: string, extra: string[] = []): string {
  return ["---", `title: ${title}`, SETTLED_CREATED_LINE, ...extra, "---", "", "Body.", ""].join("\n");
}

/**
 * One folder holding the family rule's live cases at once:
 *
 *  - `plans/fam-slate-*`: nine `shipped` parents plus one `superseded` page
 *    naming a sibling in `superseded_by:`, so it is a rule-4 CHILD — ten members
 *    in total, which is the shape the roll-up `9 shipped · 1 superseded` comes
 *    from and one under the cap;
 *  - `plans/fam-pair-*`: two pages sharing a prefix, which must NOT fold —
 *    a pair sharing a name is a coincidence;
 *  - `plans/solo.mdx`: attached to nothing, in nothing;
 *  - `archive/`: five dated pages across two months.
 */
const SLATE = 9;
const PAGES: Array<[string, string]> = [
  ...Array.from({ length: SLATE }, (_, i): [string, string] => [
    `plans/fam-slate-${i + 1}.mdx`,
    md(`Slate piece ${i + 1}`, ["plan_status: shipped"]),
  ]),
  [
    "plans/fam-slate-retired.mdx",
    md("Slate retired piece", ["plan_status: superseded", "superseded_by: [[fam-slate-1]]"]),
  ],
  ["plans/fam-pair-one.mdx", md("Pair one")],
  ["plans/fam-pair-two.mdx", md("Pair two")],
  ["plans/solo.mdx", md("Solo page")],
  // Dated names AND matching `updated:` stamps, so the date sort orders them the
  // way their names read — every other fixture page shares one settled date and
  // falls through to the title tie-break, which says nothing about a month.
  ...(
    [
      ["2024-09-11", "Latest"],
      ["2024-09-02", "Later"],
      ["2024-08-28", "Mid"],
      ["2024-08-19", "Early"],
      ["2024-08-04", "Earlier"],
    ] as const
  ).map(([day, title]): [string, string] => [
    `archive/${day}-${title.toLowerCase()}.mdx`,
    md(`${title} archive page`, [`updated: ${day}`]),
  ]),
];

const FAMILY_KEY = "family:plans/fam-slate";
const ROLLUP = `${SLATE} shipped · 1 superseded`;
const MEMBER = "plans/fam-slate-1.mdx";
const RETIRED = "plans/fam-slate-retired.mdx";
const SOLO = "plans/solo.mdx";
const PAIR_ONE = "plans/fam-pair-one.mdx";

const ALL_PAGES = PAGES.length;
/** Rows in `plans/` with the family CLOSED: the two pair pages and the loner.
 *  Every fixture page carries the same settled date, so the default sort falls
 *  through to its title tie-break — hence written out rather than assumed. */
const PLANS_CLOSED = [PAIR_ONE, "plans/fam-pair-two.mdx", SOLO];
/** …and flat, with the toggle off: the two pair pages, the nine parents and the
 *  loner, all in title order, with no retired page (it is an attachment child of
 *  the first parent and its own group is closed). */
const PLANS_FLAT = [
  PAIR_ONE,
  "plans/fam-pair-two.mdx",
  ...Array.from({ length: SLATE }, (_, i) => `plans/fam-slate-${i + 1}.mdx`),
  SOLO,
];

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-fam-"));
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
const toggle = (page: Page) => page.locator("#wikiGroupFamilies");

async function relPaths(page: Page): Promise<string[]> {
  return page
    .locator(".wiki-list-item")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-relpath") || ""));
}

/** The count the rail reports — `<shown> / <total>`. */
async function countText(page: Page): Promise<string> {
  return (await page.locator("#wikiCount").textContent()) ?? "";
}

/** Narrow to `plans/` so the archive's ten rows stay out of the family cases. */
async function selectFolder(page: Page, folder: string): Promise<void> {
  await page.locator("#wikiFilters").evaluate((el) => ((el as HTMLDetailsElement).open = true));
  await page.selectOption("#wikiFolder", folder);
}

/** Store a rail width. It is applied at boot, so the caller reloads after it. */
async function setRailWidth(page: Page, width: number): Promise<void> {
  await page.evaluate(
    (arg: { key: string; width: string }) => localStorage.setItem(arg.key, arg.width),
    { key: RAIL_WIDTH_KEY, width: String(width) },
  );
}

async function turnGroupingOn(page: Page): Promise<void> {
  await toggle(page).check();
  await expect(page.locator(".wiki-list-group").first()).toBeAttached();
}

test.describe("Wiki rail: families and months", () => {
  test("the toggle is OFF by default and the rail is flat", async ({ page }) => {
    await openRail(page);
    await selectFolder(page, "plans");
    await expect(toggle(page)).not.toBeChecked();
    expect(await relPaths(page)).toEqual(PLANS_FLAT);
    await expect(page.locator(".wiki-list-group")).toHaveCount(0);
    expect(await countText(page)).toBe(`${PLANS_FLAT.length} / ${ALL_PAGES}`);
  });

  test("ON: the slate folds to one row with its roll-up, and the pair does not fold", async ({
    page,
  }) => {
    await openRail(page);
    await selectFolder(page, "plans");
    await turnGroupingOn(page);
    // One group row, standing for the nine parents…
    await expect(page.locator(".wiki-list-group")).toHaveCount(1);
    const group = groupRow(page, FAMILY_KEY);
    await expect(group.locator(".wiki-group-label")).toHaveText("fam-slate-*");
    // …and the roll-up counts the superseded CHILD with them: it is a member of
    // the slate wherever the rail happens to draw it.
    await expect(group.locator(".wiki-fold-chip-label")).toHaveText(ROLLUP);
    await expect(group.locator(".wiki-group-fold")).toHaveAttribute("aria-expanded", "false");
    // The two-page prefix and the loner are ordinary rows.
    expect(await relPaths(page)).toEqual(PLANS_CLOSED);
    // …and `#wikiCount` went down by exactly the members the fold is hiding.
    expect(await countText(page)).toBe(`${PLANS_CLOSED.length} / ${ALL_PAGES}`);
  });

  test("the group row OPENS the family; its members are member rows", async ({ page }) => {
    await openRail(page);
    await selectFolder(page, "plans");
    await turnGroupingOn(page);
    await groupRow(page, FAMILY_KEY).locator(".wiki-group-fold").click();
    expect(await relPaths(page)).toEqual(PLANS_FLAT);
    expect(await countText(page)).toBe(`${PLANS_FLAT.length} / ${ALL_PAGES}`);
    await expect(groupRow(page, FAMILY_KEY).locator(".wiki-group-fold")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(row(page, MEMBER)).toHaveClass(/member/);
    await expect(row(page, MEMBER)).toHaveAttribute("title", /In the fam-slate-\* family/);
    // The group row is not a page: it opened nothing.
    await expect(page.locator(".wiki-start")).toBeVisible();
    // A member's own attachment group still works INSIDE the family, and its
    // child row carries both markers.
    await row(page, MEMBER).locator(".wiki-fold-chip").click();
    await expect(row(page, RETIRED)).toHaveClass(/member/);
    await expect(row(page, RETIRED)).toHaveClass(/child/);
  });

  test("the toggle and a fold both survive a reload", async ({ page }) => {
    await openRail(page);
    await selectFolder(page, "plans");
    await turnGroupingOn(page);
    await groupRow(page, FAMILY_KEY).locator(".wiki-group-fold").click();

    await openRail(page); // same context ⇒ same localStorage
    await selectFolder(page, "plans");
    await expect(toggle(page)).toBeChecked();
    expect(await relPaths(page)).toEqual(PLANS_FLAT);

    // …and closing it again is remembered the same way.
    await groupRow(page, FAMILY_KEY).locator(".wiki-group-fold").click();
    await openRail(page);
    await selectFolder(page, "plans");
    expect(await relPaths(page)).toEqual(PLANS_CLOSED);

    // Turning the toggle back off leaves the rail flat, whatever is stored.
    await toggle(page).uncheck();
    expect(await relPaths(page)).toEqual(PLANS_FLAT);
    await expect(page.locator(".wiki-list-group")).toHaveCount(0);
  });

  test("the OPEN page's family is expanded, with a chip that does not pretend to toggle", async ({
    page,
  }) => {
    await openRail(page);
    await selectFolder(page, "plans");
    await turnGroupingOn(page);
    expect(await relPaths(page)).not.toContain(MEMBER);

    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(MEMBER)}`);
    await expect(page.locator(".wiki-list-item").first()).toBeAttached();
    await expect(row(page, MEMBER)).toHaveClass(/active/);
    expect(await relPaths(page)).toContain(MEMBER);
    const fold = groupRow(page, FAMILY_KEY).locator(".wiki-group-fold");
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(fold).toBeDisabled();
    await expect(fold).toHaveAttribute("title", /open page is in this group/);
    await fold.click({ force: true });
    expect(await relPaths(page)).toContain(MEMBER);
  });

  test("a query FLATTENS the rail — no group rows, nothing folded away", async ({ page }) => {
    await openRail(page);
    await selectFolder(page, "plans");
    await turnGroupingOn(page);
    await page.fill("#wikiSearch", "slate piece");
    await expect(page.locator(".wiki-list-group")).toHaveCount(0);
    expect(await relPaths(page)).toEqual(
      Array.from({ length: SLATE }, (_, i) => `plans/fam-slate-${i + 1}.mdx`),
    );
    await page.fill("#wikiSearch", "");
    expect(await relPaths(page)).toEqual(PLANS_CLOSED);
  });

  test("the archive folds by MONTH under a date sort, newest open", async ({ page }) => {
    await openRail(page);
    await turnGroupingOn(page);
    await selectFolder(page, "archive");
    const labels = await page
      .locator(".wiki-group-label")
      .evaluateAll((els) => els.map((el) => el.textContent));
    expect(labels).toEqual(["2024-09", "2024-08"]);
    // The newest month is open with NOTHING stored, the older one closed.
    expect(await relPaths(page)).toEqual([
      "archive/2024-09-11-latest.mdx",
      "archive/2024-09-02-later.mdx",
    ]);
    await expect(groupRow(page, "month:2024-09").locator(".wiki-fold-chip-label")).toHaveText(
      "2 pages",
    );
    await expect(groupRow(page, "month:2024-08").locator(".wiki-fold-chip-label")).toHaveText(
      "3 pages",
    );

    // Clicking the newest month CLOSES it — the one key whose presence means the
    // opposite — and the click is remembered across a reload like any other.
    await groupRow(page, "month:2024-09").locator(".wiki-group-fold").click();
    expect(await relPaths(page)).toEqual([]);
    await openRail(page);
    await selectFolder(page, "archive");
    expect(await relPaths(page)).toEqual([]);
    await groupRow(page, "month:2024-08").locator(".wiki-group-fold").click();
    expect(await relPaths(page)).toEqual([
      "archive/2024-08-28-mid.mdx",
      "archive/2024-08-19-early.mdx",
      "archive/2024-08-04-earlier.mdx",
    ]);

    // …and under a NON-date sort the archive is FAMILIES again — which in a
    // folder of nothing but dated names means NO group at all: a bare date is
    // never a family candidate (a month is what the month grouping owns), so the
    // five rows render flat rather than under a `2024-08-*` row that says what
    // the date column already says.
    await page.selectOption("#wikiSort", "title");
    await expect(page.locator(".wiki-list-group")).toHaveCount(0);
    // Title A–Z: Earlier · Early · Later · Latest · Mid.
    expect(await relPaths(page)).toEqual([
      "archive/2024-08-04-earlier.mdx",
      "archive/2024-08-19-early.mdx",
      "archive/2024-09-02-later.mdx",
      "archive/2024-09-11-latest.mdx",
      "archive/2024-08-28-mid.mdx",
    ]);
  });

  test("the head's three controls do not push the rail into a horizontal scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await openRail(page);
    await turnGroupingOn(page);
    const overflow = await page.locator(".wiki-browse-head").evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    const list = await page.locator("#wikiList").evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      group: !!el.querySelector(".wiki-list-group"),
    }));
    expect(list.group).toBe(true);
    expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
  });

  test("the roll-up's WORDS are readable at the shipped rail width", async ({ page }) => {
    // The whole point of a roll-up is the words: `9 shipped · 1 superseded`
    // answers "is this slate finished?" and `9 · 1` does not. Priced at the
    // ATTACHMENT chip's breakpoint it was `display:none` at a mid of 253.6px,
    // which is exactly the 300px default — hover-only on every rail anybody has.
    await page.setViewportSize({ width: 1400, height: 900 });
    await openRail(page);
    await setRailWidth(page, RAIL_WIDTH_DEFAULT);
    await openRail(page);
    await selectFolder(page, "plans");
    await turnGroupingOn(page);
    const label = groupRow(page, FAMILY_KEY).locator(".wiki-fold-chip-label");
    await expect(label).toBeVisible();
    await expect(label).toHaveText(ROLLUP);
    await expect(groupRow(page, FAMILY_KEY).locator(".wiki-fold-chip-counts")).toBeHidden();

    // …and at the narrow rail the counts take over rather than the words
    // clipping, which is the rule the two page-row breakpoints already state.
    await setRailWidth(page, RAIL_WIDTH_MIN);
    await openRail(page);
    await selectFolder(page, "plans");
    await expect(groupRow(page, FAMILY_KEY).locator(".wiki-fold-chip-label")).toBeHidden();
    await expect(groupRow(page, FAMILY_KEY).locator(".wiki-fold-chip-counts")).toBeVisible();
  });

  test("the sort row wraps the TOGGLE, never the count", async ({ page }) => {
    // Measured, because the first cut claimed the toggle wrapped and it was
    // `#wikiCount` that did — alone, left-aligned under the select. The rule:
    // the select and the count keep line one at every rail width, and the toggle
    // is what takes a second line when it does not fit.
    await page.setViewportSize({ width: 1400, height: 900 });
    for (const width of [RAIL_WIDTH_MIN, RAIL_WIDTH_DEFAULT, 312]) {
      await openRail(page);
      await setRailWidth(page, width);
      await openRail(page);
      const box = await page.evaluate(() => {
        const r = (sel: string) => {
          const b = document.querySelector(sel)!.getBoundingClientRect();
          return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
        };
        return { sort: r("#wikiSort"), count: r("#wikiCount"), toggle: r(".wiki-group-toggle") };
      });
      const sameLine = (a: { top: number; bottom: number }, b: { top: number; bottom: number }) =>
        a.top < b.bottom && b.top < a.bottom;
      // The count shares the select's line at every width, and stays to its right.
      expect(sameLine(box.sort, box.count), `count on the select's line at ${width}`).toBe(true);
      expect(box.count.left).toBeGreaterThanOrEqual(box.sort.right);
      // The toggle is on that line or under it — never overlapping either.
      if (sameLine(box.sort, box.toggle)) {
        expect(box.toggle.left).toBeGreaterThanOrEqual(box.count.right);
      } else {
        expect(box.toggle.top).toBeGreaterThanOrEqual(box.sort.bottom);
      }
    }
  });

  // Both themes, measured rather than eyeballed — these are a label, a count and
  // a control's text, so 4.5:1 is the floor, and the background is whatever
  // actually paints behind the element, which a `toHaveCSS("color", <token>)`
  // assertion cannot see.
  for (const scheme of ["light", "dark"] as const) {
    test(`the group label, the roll-up and the toggle are legible in the ${scheme} theme`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openRail(page);
      await selectFolder(page, "plans");
      await turnGroupingOn(page);
      const group = groupRow(page, FAMILY_KEY);
      expect(await contrastOf(group.locator(".wiki-group-label"))).toBeGreaterThanOrEqual(4.5);
      expect(await contrastOf(group.locator(".wiki-fold-chip-label"))).toBeGreaterThanOrEqual(4.5);
      expect(await contrastOf(page.locator(".wiki-group-toggle"))).toBeGreaterThanOrEqual(4.5);
      // …and in the state the reader clicks the group row in: hovered, which
      // paints a background of its own behind the transparent chip.
      await group.locator(".wiki-group-label").hover();
      expect(await contrastOf(group.locator(".wiki-group-label"))).toBeGreaterThanOrEqual(4.5);
      expect(await contrastOf(group.locator(".wiki-fold-chip-label"))).toBeGreaterThanOrEqual(4.5);
    });
  }
});
