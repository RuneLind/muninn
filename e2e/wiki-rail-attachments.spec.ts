/**
 * ATTACHMENTS in the /wiki reader's page rail — the render half of the store's
 * pairing pass (`pairAttachments`, `src/wiki/store.ts`).
 *
 * What the unit tests cannot reach, and the reason this file exists:
 *
 *  1. **The chain that renders a group.** `buildRail` is a pure arrangement;
 *     whether a chip ever appears depends on the listing carrying
 *     `children`/`parent`/`pairedBy` through `/api/wiki/pages`, the painter
 *     emitting the button, and the click reaching `toggleFolded`. Every unit
 *     test in that chain is green with the chain broken.
 *  2. **The count on screen.** `#wikiCount` is derived from `rail.shown`, and a
 *     closed fold lowers it — the one number that says the rail is not hiding
 *     rows it still claims to be showing.
 *  3. **The un-dropped `.html` is a real page.** It used to be dropped from the
 *     index entirely: it has to OPEN from its row while `?name=<stem>` still
 *     answers with the markdown page.
 *  4. **The fold survives a reload.** Per wiki, in localStorage, like the pins.
 *  5. **A query flattens it.** The rows are the search's rows — a hit inside a
 *     closed group is a result the reader asked for and cannot see.
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
import {
  RAIL_TITLE_MIN,
  RAIL_WIDTH_KEY,
} from "../src/dashboard/views/components/wiki-rail-width.ts";
import { SETTLED_CREATED_LINE, settleWikiMtimes } from "./settled-wiki.ts";
import { contrastOf } from "./contrast.ts";

const PORT = e2ePort("wiki-rail-attachments");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-attach";

/** Settled, so the rail's Activity section claims none of these rows — this file
 *  is about the groups, and a fixture written a millisecond ago is all news. */
function md(title: string, extra: string[] = [], body = "Body."): string {
  return ["---", `title: ${title}`, SETTLED_CREATED_LINE, ...extra, "---", "", body, ""].join("\n");
}

function html(title: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p></body></html>`;
}

/**
 * The fixture is one folder holding every pairing rule at once:
 *
 *  - `x.mdx` with two `-prototype` siblings (rule 2) and a superseded page
 *    pointing at it (rule 4) — three children, two kinds, so the chip has to say
 *    both;
 *  - `y.md` with a same-stem `y.html` (rule 1) — the case that used to be
 *    dropped from the index outright;
 *  - `lone.md`, attached to nothing, so "every row is in a group" cannot pass;
 *  - `w.mdx`, the WORST row the rail can be asked to draw: a status pill, a ⚑
 *    follow-up flag and a chip whose label carries two-digit counts of BOTH
 *    kinds (`10 attached · 10 superseded`). Every optional element of a row at
 *    once, which is the shape the layout rules below are sized against;
 *  - `v.mdx`, a LONG-titled group row. Every other fixture page has a short
 *    title, and that is what hid the defect the sweep over the real wiki found:
 *    with the title flexing from its CONTENT width it out-weighs the chip in the
 *    shrink distribution, so 6 of mimir's 8 real group rows rendered `1 atta…`
 *    while their titles sat comfortably above the floor.
 */
const WORST_CHILDREN = 10;

const PAGES: Array<[string, string]> = [
  ["plans/x.mdx", md("X plan")],
  ["plans/x-prototype.html", html("X prototype")],
  ["plans/x-prototype-2.html", html("X prototype two")],
  ["plans/z.mdx", md("Z retired plan", ["superseded_by: [[x]]"])],
  ["plans/y.md", md("Y page")],
  ["plans/y.html", html("Y diagram")],
  ["plans/lone.md", md("Lone page")],
  ["plans/w.mdx", md("W worst row plan", ["plan_status: shipped", "followups: open"])],
  ["plans/v.mdx", md("Zz a rail title long enough to out-weigh its own group chip")],
  ["plans/v-prototype.html", html("Zz mock")],
  ...Array.from({ length: WORST_CHILDREN }, (_, i): [string, string] => [
    `plans/w-prototype-${i + 1}.html`,
    html(`W mock ${i + 1}`),
  ]),
  ...Array.from({ length: WORST_CHILDREN }, (_, i): [string, string] => [
    `plans/w-old-${i + 1}.md`,
    md(`W retired ${i + 1}`, ["superseded_by: [[w]]"]),
  ]),
];

const X = "plans/x.mdx";
const W = "plans/w.mdx";
const V = "plans/v.mdx";
const Y = "plans/y.md";
const Y_HTML = "plans/y.html";
const PROTO = "plans/x-prototype.html";
const PROTO2 = "plans/x-prototype-2.html";
const Z = "plans/z.mdx";
const LONE = "plans/lone.md";

/** Every page the index holds — the `.html` twins included, which is the change. */
const ALL_PAGES = PAGES.length;

/**
 * Row order on screen. Every fixture page carries the same settled date, so the
 * default "Recently updated" sort falls through to its title tie-break — which
 * is why these are written out rather than assumed to follow the file list.
 */
const CLOSED_ORDER = [LONE, W, X, Y, V];
/** …and with `x`'s group open: its children follow it, in the same sort. */
const OPEN_ORDER = [LONE, W, X, PROTO, PROTO2, Z, Y, V];
/** Rows on screen with both groups CLOSED: the two parents plus the loner. */
const CLOSED_ROWS = CLOSED_ORDER.length;

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-attach-"));
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

async function openRail(page: Page): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
  await expect(page.locator(".wiki-list-item").first()).toBeAttached();
}

const row = (page: Page, rel: string) => page.locator(`.wiki-list-item[data-relpath="${rel}"]`);

async function relPaths(page: Page): Promise<string[]> {
  return page
    .locator(".wiki-list-item")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-relpath") || ""));
}

/** The count the rail reports — `<shown> / <total>`. */
async function countText(page: Page): Promise<string> {
  return (await page.locator("#wikiCount").textContent()) ?? "";
}

test.describe("Wiki rail: attachments", () => {
  test("the listing carries the pairing, and the un-dropped .html is a page", async () => {
    const res = await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`);
    const data = (await res.json()) as {
      pages: Array<{ relPath: string; parent?: string; pairedBy?: string; children?: string[] }>;
    };
    const by = new Map(data.pages.map((p) => [p.relPath, p]));
    expect(by.size).toBe(ALL_PAGES);
    // The PARENT link is what rides the wire; the store's `children` array is
    // stripped, since the rail rebuilds each group from the pages the facets left.
    expect(by.get(X)!.children).toBeUndefined();
    expect(data.pages.filter((p) => p.parent === X).map((p) => p.relPath).sort()).toEqual(
      [PROTO, PROTO2, Z].sort(),
    );
    expect(by.get(PROTO)!).toMatchObject({ parent: X, pairedBy: "suffix" });
    expect(by.get(Z)!).toMatchObject({ parent: X, pairedBy: "superseded" });
    expect(by.get(Y_HTML)!).toMatchObject({ parent: Y, pairedBy: "stem" });
    // The attachment is a page in its own right…
    const child = await fetch(`${BASE}/api/wiki/page?wiki=${WIKI}&relPath=${encodeURIComponent(Y_HTML)}`);
    expect(child.status).toBe(200);
    // …and the STEM still answers with the markdown page.
    const byName = await fetch(`${BASE}/api/wiki/page?wiki=${WIKI}&name=y`);
    expect(((await byName.json()) as { meta: { relPath: string } }).meta.relPath).toBe(Y);
  });

  // A name-only navigation — `?page=<stem>` at boot and on popstate, the click
  // delegate's no-relPath fallback, an Ask citation, a chat wiki citation — used
  // to open the DIAGRAM: the listing is relPath-ordered, so `plans/y.html` was
  // the first `name === "y"` match and the explainer branch took it. The server
  // never agreed: an attachment registers no stem key, so `?name=y` answers the
  // markdown page.
  test("a name-only navigation opens the PAGE, never its attachment", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&page=y`);
    await expect(page.locator(".wiki-list-item").first()).toBeAttached();
    await expect(page.locator("#articleWrap")).toContainText("Y page");
    await expect(page.locator(".wiki-explainer-frame")).toHaveCount(0);
    await expect(row(page, Y)).toHaveClass(/active/);

    // The same lookup, reached the way an Ask citation reaches it: a link
    // carrying `data-page` and no `data-relpath`, handled by the shell's own
    // click delegate. (Driving a real Ask answer would cost a model call.)
    await openRail(page);
    await page.evaluate(() => {
      const a = document.createElement("a");
      a.setAttribute("data-page", "y");
      a.id = "e2e-citation";
      a.textContent = "Y";
      document.getElementById("articleWrap")!.appendChild(a);
    });
    await page.click("#e2e-citation");
    await expect(page.locator("#articleWrap")).toContainText("Y page");
    await expect(page.locator(".wiki-explainer-frame")).toHaveCount(0);
  });

  test("groups start CLOSED: chips say what is inside, and the count agrees with the rows", async ({
    page,
  }) => {
    await openRail(page);
    expect(await relPaths(page)).toEqual(CLOSED_ORDER);
    expect(await countText(page)).toBe(`${CLOSED_ROWS} / ${ALL_PAGES}`);
    await expect(row(page, X).locator(".wiki-fold-chip")).toContainText("2 attached · 1 superseded");
    await expect(row(page, Y).locator(".wiki-fold-chip")).toContainText("1 attached");
    await expect(row(page, LONE).locator(".wiki-fold-chip")).toHaveCount(0);
    await expect(row(page, X).locator(".wiki-fold-chip")).toHaveAttribute("aria-expanded", "false");
  });

  test("the chip OPENS the group; the row still opens the page", async ({ page }) => {
    await openRail(page);
    await row(page, X).locator(".wiki-fold-chip").click();
    expect(await relPaths(page)).toEqual(OPEN_ORDER);
    expect(await countText(page)).toBe(`${CLOSED_ROWS + 3} / ${ALL_PAGES}`);
    await expect(row(page, X).locator(".wiki-fold-chip")).toHaveAttribute("aria-expanded", "true");
    // The children are child rows, and they say why they fold.
    await expect(row(page, PROTO)).toHaveClass(/child/);
    await expect(row(page, Z)).toHaveAttribute("title", /Superseded by "X plan"/);
    // The chip did NOT navigate — the start view is still up.
    await expect(page.locator(".wiki-start")).toBeVisible();
    // …and a click on the ROW does open the page.
    await row(page, PROTO).click();
    await expect(page.locator("#articleWrap")).toContainText("X prototype");
  });

  test("the stored fold survives a reload, and closes again on a second click", async ({ page }) => {
    await openRail(page);
    await row(page, X).locator(".wiki-fold-chip").click();
    await openRail(page); // same context ⇒ same localStorage
    expect(await relPaths(page)).toContain(PROTO);
    await row(page, X).locator(".wiki-fold-chip").click();
    expect(await relPaths(page)).toEqual(CLOSED_ORDER);
    await openRail(page);
    expect(await relPaths(page)).toEqual(CLOSED_ORDER);
  });

  test("the OPEN page's group is expanded, whatever the store holds", async ({ page }) => {
    await openRail(page);
    // Nothing is open yet, so the group is closed and the child is not a row.
    expect(await relPaths(page)).not.toContain(Y_HTML);
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(Y_HTML)}`);
    await expect(page.locator(".wiki-list-item").first()).toBeAttached();
    // The reader is ON the attachment — the rail must not be hiding it.
    await expect(row(page, Y_HTML)).toHaveClass(/active/);
    expect(await relPaths(page)).toContain(Y_HTML);
    // …and the chip on that group is not a toggle: `isOpen` is `forced || stored`,
    // so a click could only write a stored key with nothing on screen to show for
    // it. It is disabled (a disabled button dispatches no click at all) and says
    // why on hover.
    const chip = row(page, Y).locator(".wiki-fold-chip");
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    await expect(chip).toBeDisabled();
    await expect(chip).toHaveAttribute("title", /open page is in this group/);
    await chip.click({ force: true });
    expect(await relPaths(page)).toContain(Y_HTML);
  });

  // The rail's own minimum width. `#wikiList` scrolling sideways hides the ★, the
  // date and half the title behind a scrollbar nothing tells the reader about.
  test("the chip does not push the rail into a horizontal scroll", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await openRail(page);
    const overflow = await page.locator("#wikiList").evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      chip: !!el.querySelector(".wiki-fold-chip"),
    }));
    expect(overflow.chip).toBe(true); // the case is only about a rail WITH a chip
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });

  /**
   * The row's layout rules, over BOTH row shapes and BOTH rail widths, asserted
   * as the three properties they exist to guarantee rather than as the numbers
   * one machine produced:
   *
   *  - the TITLE never goes under its floor (`RAIL_TITLE_MIN`). Rounds 1 and 2
   *    both distributed the shortfall proportionally — the chip shrank, then the
   *    title got a 40% basis — and a proportion of too little is still too
   *    little: at the 260px rail the worst row measured 10.0px of title, which
   *    is a named page with no name on it and the hover Playwright reports as
   *    "element is not visible";
   *  - whichever chip label is PAINTED is whole. `10 · 1` is what `10 · 10`
   *    clips to, so a clipped count is not a smaller count, it is a wrong one;
   *  - and neither is bought with a sideways scroll of `#wikiList`.
   *
   * Which FORM the chip is in is deliberately NOT asserted: it is a measurement
   * about this machine's font metrics, and the degrade (full → compact) is the
   * safe direction. The three properties above hold in either form.
   */
  test("both row shapes keep the title floor and an unclipped count, at both rail widths", async ({
    page,
  }) => {
    for (const [width, height] of [
      [1280, 720],
      [420, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      await openRail(page);
      // X is an ordinary group row; W carries every optional element a row can
      // have at once — status pill, ⚑ follow-up flag, and two-digit counts of
      // both kinds in the chip; V carries a title long enough to compete with
      // the chip for the pair's width.
      for (const [rel, words] of [
        [X, "2 attached · 1 superseded"],
        [W, "10 attached · 10 superseded"],
        [V, "1 attached"],
      ] as const) {
        const m = await row(page, rel).evaluate((el) => {
          const q = (s: string) => el.querySelector(s) as HTMLElement | null;
          const full = q(".wiki-fold-chip-label");
          const counts = q(".wiki-fold-chip-counts");
          const shown = full && getComputedStyle(full).display !== "none" ? full : counts;
          const mid = q(".wiki-list-mid")!;
          const end = q(".wiki-list-end")!;
          return {
            title: q(".wiki-list-title")!.getBoundingClientRect().width,
            label: shown?.textContent ?? "",
            labelWidth: shown ? shown.getBoundingClientRect().width : 0,
            labelScroll: shown ? shown.scrollWidth : 0,
            labelClient: shown ? shown.clientWidth : 0,
            hover: q(".wiki-fold-chip")?.getAttribute("title") ?? "",
            aria: q(".wiki-fold-chip")?.getAttribute("aria-label") ?? "",
            midScroll: mid.scrollWidth,
            midClient: mid.clientWidth,
            // How far the ★+date slot's right edge sits from the row's own
            // content edge — 0 when it is flush right, whichever line it is on.
            endGap:
              el.getBoundingClientRect().right - 10 - end.getBoundingClientRect().right,
          };
        });
        const where = `${rel} at ${width}px`;
        expect(m.title, `title floor, ${where}`).toBeGreaterThanOrEqual(RAIL_TITLE_MIN);
        expect(m.labelWidth, `chip label painted, ${where}`).toBeGreaterThan(0);
        expect(m.labelScroll, `chip label unclipped, ${where}`).toBeLessThanOrEqual(m.labelClient);
        // The counts themselves, whichever form is on screen — the full label
        // opens with them, so one assertion covers both.
        expect(m.label.replace(/\s+/g, " "), `counts intact, ${where}`).toContain(
          words.split(" ")[0]!,
        );
        // The compact form is the words MOVED, not dropped: both the hover and
        // the accessible name carry the full label in either form.
        expect(m.hover, `hover carries the words, ${where}`).toContain(words);
        expect(m.aria, `accessible name carries the words, ${where}`).toContain(words);
        // The pair itself must fit the space it was given — a chip overflowing
        // `.wiki-list-mid` lands on the status pill and is invisible to a check
        // on `#wikiList`, which the row's own padding absorbs.
        expect(m.midScroll, `title+chip fit their box, ${where}`).toBeLessThanOrEqual(m.midClient);
        // …and the ★+date stay flush right, including on the second line of a
        // row that wrapped, where nothing grows to push them there.
        expect(m.endGap, `end slot flush right, ${where}`).toBeLessThanOrEqual(1);
      }
      // The title is also a HOVER target — the CI failure this class produced was
      // a `hover` timing out on a 0-width element, not a wrong number.
      const title = row(page, W).locator(".wiki-list-title");
      await expect(title).toBeVisible();
      await title.hover({ timeout: 2_000 });
      const overflow = await page.locator("#wikiList").evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(overflow.scrollWidth, `no sideways scroll at ${width}px`).toBeLessThanOrEqual(
        overflow.clientWidth,
      );
    }
  });

  /**
   * The two breakpoints are one design decision, and this is it: a chip whose
   * label is short keeps its WORDS where a long one has already had to give them
   * up. Driven at a rail width between the two thresholds (330px, set the way a
   * reader sets it — the stored width), so the reading is ~35px clear of either
   * one rather than riding the 5px margin the default rail leaves.
   */
  test("at a mid-width rail the short chip keeps its words and the long one does not", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addInitScript(
      ([key, width]) => localStorage.setItem(key as string, String(width)),
      [RAIL_WIDTH_KEY, 330] as const,
    );
    await openRail(page);
    const formOf = (rel: string) =>
      row(page, rel).evaluate((el) => {
        const full = el.querySelector(".wiki-fold-chip-label") as HTMLElement;
        return getComputedStyle(full).display !== "none" ? "full" : "compact";
      });
    // `1 attached` fits beside the title floor here…
    expect(await formOf(V)).toBe("full");
    // …and `2 attached · 1 superseded`, twice the width, does not.
    expect(await formOf(X)).toBe("compact");
  });

  // A LIFTED child: the reader pinned it, so it renders under Pinned rather than
  // inside its parent's group. It keeps the hover sentence (still true) and loses
  // the indent + left rule (they would claim a parentage the rail invented at
  // that spot), and the parent's chip stops counting it — it is on screen.
  test("a PINNED child is lifted out of the group: no indent, the sentence stays, the chip drops it", async ({
    page,
  }) => {
    await openRail(page);
    await row(page, X).locator(".wiki-fold-chip").click();
    // Hovered first: the ★ is hidden — and pointer-events:none — until the row
    // is hovered on a pointer device.
    await row(page, PROTO).hover();
    await row(page, PROTO).locator(".wiki-pin").click();
    await expect(row(page, PROTO).locator(".wiki-pin")).toHaveAttribute("aria-pressed", "true");
    // Closed again, and reloaded: the pin and the fold both come back from
    // localStorage, so this is the state a returning reader is in.
    await row(page, X).locator(".wiki-fold-chip").click();
    await openRail(page);

    const pinned = page.locator(`.wiki-list-item[data-section="pinned"][data-relpath="${PROTO}"]`);
    await expect(pinned).toHaveCount(1);
    expect(await pinned.evaluate((el) => el.classList.contains("child"))).toBe(false);
    await expect(pinned).toHaveAttribute("title", /Attached under "X plan"/);
    // The group is closed and the child is NOT in it — the chip says so.
    expect(await relPaths(page)).toEqual([PROTO, LONE, W, X, Y, V]);
    await expect(row(page, X).locator(".wiki-fold-chip")).toContainText("1 attached · 1 superseded");
  });

  test("a query FLATTENS the rail — every match is a row, none folded away", async ({ page }) => {
    await openRail(page);
    // "x prototype" and not "prototype": the worst-shape group's ten mocks are
    // named `w-prototype-N`, which the query matches on `name`.
    await page.fill("#wikiSearch", "x prototype");
    expect(await relPaths(page)).toEqual([PROTO, PROTO2]);
    await expect(page.locator(".wiki-fold-chip")).toHaveCount(0);
    await page.fill("#wikiSearch", "");
    expect(await relPaths(page)).toEqual(CLOSED_ORDER);
  });

  test("Bookkeeping starts collapsed and its header carries the count", async ({ page }) => {
    // Written HERE rather than in the fixture above, so the other cases keep a
    // rail with no bookkeeping tail at all. The index is TTL-cached, so the
    // server is told to rescan before the page is opened — the reader's own boot
    // load deliberately does not send `refresh=1`.
    await writeFile(path.join(root, "plans/index.md"), md("Plans index"), "utf8");
    await settleWikiMtimes(root);
    try {
      await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}&refresh=1`);
      await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
      await expect(page.locator(".wiki-list-item").first()).toBeAttached();
      const fold = page.locator(".wiki-sec-fold");
      await expect(fold).toContainText("Bookkeeping");
      await expect(fold.locator(".wiki-sec-count")).toHaveText("1");
      await expect(fold).toHaveAttribute("aria-expanded", "false");
      expect(await relPaths(page)).not.toContain("plans/index.md");
      await fold.click();
      expect(await relPaths(page)).toContain("plans/index.md");
    } finally {
      await rm(path.join(root, "plans/index.md"), { force: true });
    }
  });

  // Both themes, every state the text is READ in, and measured rather than
  // eyeballed: these are counts, so 4.5:1 is the floor, and the background is
  // whatever actually paints behind the element — which is the half a
  // `toHaveCSS("color", <token>)` assertion cannot see. The row's own HOVER is
  // the state a reader clicks the chip in, and it paints --bg-surface behind a
  // transparent chip, where --text-muted measures 4.42:1 in the light theme.
  for (const scheme of ["light", "dark"] as const) {
    test(`the chip, the count pill and the child rail are legible in the ${scheme} theme`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      // A bookkeeping page, so the section header's count pill is on screen too.
      // Written here and removed after, like the Bookkeeping case below.
      await writeFile(path.join(root, "plans/index.md"), md("Plans index"), "utf8");
      await settleWikiMtimes(root);
      try {
        await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}&refresh=1`);
        await openRail(page);
        const chip = row(page, X).locator(".wiki-fold-chip");

        expect(await contrastOf(chip)).toBeGreaterThanOrEqual(4.5);
        // …in the state the reader clicks it in: the ROW hovered, which paints
        // --bg-surface behind a transparent chip. Aimed LEFT OF THE CHIP, not at
        // the row box — Playwright aims at an element.s centre, and the row.s
        // centre lands ON the chip, where the chip.s OWN :hover rule answers and
        // this case measures nothing (measured: it did). The point is computed
        // from the two boxes and moved to with the mouse rather than hovering the
        // title element, so a title the layout has squeezed narrow still leaves a
        // reachable point (on the runner it had squeezed it to ZERO, and hovering
        // it timed out on "element is not visible").
        await hoverRowLeftOfChip(page, X);
        expect(await chip.evaluate((el) => el.matches(":hover"))).toBe(false);
        expect(await contrastOf(chip)).toBeGreaterThanOrEqual(4.5);
        // …and the section header's count, which paints its own background.
        expect(await contrastOf(page.locator(".wiki-sec-fold .wiki-sec-count"))).toBeGreaterThanOrEqual(4.5);

        // The child rail: a CHILD row carries the left rule that makes the group
        // read as one block. Open the fold first — closed, there is no child row.
        await chip.click();
        const railColor = await row(page, PROTO).evaluate(
          (el) => getComputedStyle(el, "::before").backgroundColor,
        );
        expect(railColor).not.toBe("rgba(0, 0, 0, 0)");
      } finally {
        await rm(path.join(root, "plans/index.md"), { force: true });
        await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}&refresh=1`);
      }
    });
  }
});

/** Hover a group row at a point the CHIP does not occupy: halfway between the
 *  row's left edge and the chip's, on the row's own FIRST line. The chip paints
 *  its own `:hover`, so any point inside it measures that rule instead of the
 *  row's — and an element-centred hover on the title is at the mercy of how wide
 *  the layout left the title.
 *
 *  It asserts the ROW really took the hover, not merely that the chip did not:
 *  "the point is left of the chip" is arithmetic, true whether or not a pointer
 *  ever arrived, so a `matches(":hover") === false` on the chip alone is
 *  satisfied by the mouse never having moved. The row is scrolled into view
 *  first, since `mouse.move` takes VIEWPORT coordinates and a box below the fold
 *  would be hovered at a point on some other row. */
async function hoverRowLeftOfChip(page: Page, rel: string): Promise<void> {
  const target = row(page, rel);
  await target.scrollIntoViewIfNeeded();
  const rowBox = await target.boundingBox();
  const chipBox = await target.locator(".wiki-fold-chip").boundingBox();
  if (!rowBox || !chipBox) throw new Error(`no box for ${rel} (row or chip)`);
  // The chip's own centre line, not the row's: a row that wrapped to two lines
  // has its centre between them, where the chip is not and neither is the title.
  await page.mouse.move((rowBox.x + chipBox.x) / 2, chipBox.y + chipBox.height / 2);
  expect(await target.evaluate((el) => el.matches(":hover"))).toBe(true);
}
