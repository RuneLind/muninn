/**
 * The FIND PALETTE in the /wiki reader — `/` and ⌘K/Ctrl-K.
 *
 * What the unit tests cannot reach, and the reason this file exists:
 *
 *  1. **The key contract.** The palette's root stops every keydown, and the
 *     reader's own shortcuts (`]`, `f` → pane toggles and fullscreen, Escape →
 *     focus mode) are document listeners that would otherwise fire on a key
 *     typed in it. Only a real page has all of them installed at once.
 *  2. **The near map travels.** `/api/wiki/page` ships `near`, the shell keeps
 *     it beside the open page, and the ranking boosts by it — a one-hop page
 *     outranks an equal text match two hops away only if every link holds.
 *  3. **Open, close, focus.** Focus returns to whatever opened the palette, and
 *     ⌘K toggles it rather than reopening.
 *  4. **Timing and state the shell owns.** A key inside the 120 ms debounce, an
 *     IME composition, a listing that has not arrived (or failed), a deep-link
 *     boot's own page load, a background listing adoption, a Back press, a
 *     failed or aborted page load and an open Tools menu — each needs the real
 *     shell around the palette.
 *
 * Fixture: a temp wiki whose pages all share one mtime (`settleWikiMtimes`,
 * then `utimesSync` on the pair the near-boost case compares), because an
 * untracked temp wiki dates its pages by mtime and the recency term would
 * otherwise decide the order.
 *
 * No model calls: nothing here leaves the process.
 *
 * ENV PREREQUISITE / SPAWN ENV: as every other spec in this directory — a
 * working `.env` at the repo root, and `e2eEnv()` to keep this muninn off
 * Telegram/Slack and off the host's instance-profile flags.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { utimesSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { SETTLED_CREATED_LINE, settleWikiMtimes } from "./settled-wiki.ts";

const PORT = e2ePort("wiki-find");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-find";
const OPEN = "plans/open.mdx";

function md(title: string, fm: string[], body: string): string {
  return ["---", `title: ${title}`, SETTLED_CREATED_LINE, ...fm, "---", "", body, ""].join("\n");
}

/**
 *  - `open` links `hop1` and `bridge`; `bridge` links `far` — so `hop1` is one
 *    hop away and `far` two, with the SAME title.
 *  - `four-fix-rounds` — the two-word query and the `#500` number.
 *  - a series `two-words` labelled "Two words" (head `alpha`, member `beta`),
 *    plus a loose page that also says "member": the chip and the quoted `in:`.
 *  - `gamma-report` — a no-series page that out-scores a series group.
 *  - `shared-wiki` says "felles" only in its `status_note`; `wiki-glossary`
 *    shares just the word "wiki" — the full row and the partial row.
 *  - `ledger-totals` carries "ledger" but not "notes", and "widget" but not
 *    500: a partial row under "ledger notes", and no row at all under
 *    `widget #500` (`#<digits>` is required in both bands).
 */
const PAGES: Array<[string, string]> = [
  [OPEN, md("Open plan", [], "Links [[hop1]] and [[bridge]].")],
  ["plans/hop1.mdx", md("Ledger notes", [], "Near.")],
  ["plans/bridge.mdx", md("Bridge", [], "Links [[far]].")],
  ["notes/far.mdx", md("Ledger notes", [], "Far.")],
  ["archive/four-fix-rounds.mdx", md("Four fix rounds on widget #500", [], "The class check fired.")],
  ["plans/alpha.mdx", md("Alpha member", ["series: two-words", "series_label: Two words"], "x")],
  ["plans/beta.mdx", md("Beta member", ["series: two-words"], "x")],
  ["plans/loose.mdx", md("Loose member", [], "x")],
  ["plans/gamma-one.mdx", md("Gamma one", ["series: greek"], "x")],
  ["plans/gamma-two.mdx", md("Gamma two", ["series: greek"], "x")],
  ["plans/gamma-report.mdx", md("Gamma gamma report", ["tags: [gamma]", "description: All about gamma."], "x")],
  ["plans/shared-wiki.mdx", md("Shared wiki rollout", ["plan_status: active", "status_note: felles bucket live"], "x")],
  ["plans/wiki-glossary.mdx", md("Wiki glossary", [], "x")],
  ["plans/ledger-totals.mdx", md("Ledger totals for widget", [], "x")],
];

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-find-"));
  for (const [rel, body] of PAGES) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
  await settleWikiMtimes(root);
  const same = new Date("2024-01-02T12:00:00Z");
  utimesSync(path.join(root, "plans/hop1.mdx"), same, same);
  utimesSync(path.join(root, "notes/far.mdx"), same, same);

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

const palette = (page: Page) => page.locator("#wikiFind");
const input = (page: Page) => page.locator("#wikiFindInput");
const rows = (page: Page) => page.locator("#wikiFindList .wiki-find-row");
/** Rows in the full band — every free word hit, no `partial m/n` pill. */
const fullRows = (page: Page) => rows(page).filter({ hasNot: page.locator(".wiki-find-partial") });

/** "ledger notes": the two full matches, then `ledger-totals` as a partial row. */
async function expectLedgerNotes(page: Page, first: string, second: string): Promise<void> {
  await expect(fullRows(page)).toHaveCount(2);
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).first()).toHaveAttribute("data-relpath", first);
  await expect(rows(page).nth(1)).toHaveAttribute("data-relpath", second);
  await expect(rows(page).nth(2)).toHaveAttribute("data-relpath", "plans/ledger-totals.mdx");
  await expect(rows(page).nth(2).locator(".wiki-find-partial")).toHaveText("partial 1/2");
}

async function openReader(page: Page): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(OPEN)}`);
  await expect(page.locator(".wiki-article-head h1")).toHaveText("Open plan");
  await expect(page.locator("#wikiList .wiki-list-item").first()).toBeVisible();
}

async function find(page: Page, query: string): Promise<void> {
  await page.locator("body").press("/");
  await expect(palette(page)).toBeVisible();
  await input(page).fill(query);
  await expect(rows(page).first()).toBeVisible();
}

test("`/` opens with the input empty and focused", async ({ page }) => {
  await openReader(page);
  await page.locator("body").press("/");
  await expect(palette(page)).toBeVisible();
  await expect(input(page)).toHaveValue("");
  await expect(input(page)).toBeFocused();
  await expect(palette(page)).toHaveAttribute("role", "dialog");
  await expect(palette(page)).toHaveAttribute("aria-modal", "true");
});

test("ControlOrMeta+K opens, and pressed again closes and stays closed", async ({ page }) => {
  await openReader(page);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page)).toHaveCount(0);
  await page.waitForTimeout(200);
  await expect(palette(page)).toHaveCount(0);
});

test("`/` typed in the rail search box stays a `/` and opens nothing", async ({ page }) => {
  await openReader(page);
  await page.locator("#wikiSearch").click();
  await page.keyboard.type("a/b");
  await expect(page.locator("#wikiSearch")).toHaveValue("a/b");
  await expect(palette(page)).toHaveCount(0);
});

test("focus returns to the opener after close", async ({ page }) => {
  await openReader(page);
  await page.locator("#wikiSearch").click();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(input(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  await expect(page.locator("#wikiSearch")).toBeFocused();
});

test("on a chip, `]`, `f` and `t` change nothing; Enter applies the chip; Escape closes", async ({ page }) => {
  await openReader(page);
  const layoutClass = await page.locator(".wiki-layout").getAttribute("class");
  await find(page, "member");
  const chip = page.locator("#wikiFindChips .wiki-find-chip").first();
  await expect(chip).toContainText("Two words");
  await page.keyboard.press("Tab");
  await expect(chip).toBeFocused();

  const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? "");
  await page.keyboard.press("]");
  await page.keyboard.press("f");
  // `t` is the theme cycle — a document listener that knows nothing about
  // dialogs, so only the palette root's stop keeps it from firing here. (The
  // pane keys refuse inside any `role="dialog"` on their own.)
  await page.keyboard.press("t");
  await expect(page.locator(".wiki-layout")).toHaveAttribute("class", layoutClass ?? "");
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  expect(await page.evaluate(() => document.documentElement.dataset.theme ?? "")).toBe(theme);
  await expect(palette(page)).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(input(page)).toHaveValue("member series:two-words");
  await expect(rows(page)).toHaveCount(2);

  // Escape from a NON-input focus closes too.
  await page.keyboard.press("Tab");
  await expect(input(page)).not.toBeFocused();
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
});

test("a two-word query ranks the expected page first; `#<digits>` finds a numbered title", async ({ page }) => {
  await openReader(page);
  await find(page, "fix rounds");
  await expect(rows(page).first().locator(".wiki-find-title")).toHaveText("Four fix rounds on widget #500");
  await expect(fullRows(page)).toHaveCount(1);
  await input(page).fill("#500");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().locator(".wiki-find-title")).toHaveText("Four fix rounds on widget #500");
  // `#<digits>` stays required: "Ledger totals for widget" hits widget, not 500, and is no row at all.
  // "widget" alone lists both first, so the drop to one row proves the fresh list rendered.
  await input(page).fill("widget");
  await expect(rows(page)).toHaveCount(2);
  await input(page).fill("widget #500");
  await expect(rows(page)).toHaveCount(1);
  await expect(fullRows(page)).toHaveCount(1);
  await expect(rows(page).first()).toHaveAttribute("data-relpath", "archive/four-fix-rounds.mdx");
});

test("a word only the status_note carries finds the page; a page hitting fewer words follows, marked partial", async ({ page }) => {
  await openReader(page);
  await find(page, "felles wiki");
  await expect(rows(page)).toHaveCount(2);
  const [full, partial] = [rows(page).first(), rows(page).nth(1)];
  await expect(full).toHaveAttribute("data-relpath", "plans/shared-wiki.mdx");
  await expect(full.locator(".wiki-find-partial")).toHaveCount(0);
  await expect(partial).toHaveAttribute("data-relpath", "plans/wiki-glossary.mdx");
  await expect(partial.locator(".wiki-find-partial")).toHaveText("partial 1/2");
  await expect(partial.locator(".wiki-find-title mark")).toHaveText(["Wiki"]);
});

test('`in:"two words"` narrows to the series by its label', async ({ page }) => {
  await openReader(page);
  await find(page, 'member in:"two words"');
  await expect(rows(page)).toHaveCount(2);
  const titles = await rows(page).locator(".wiki-find-title").allTextContents();
  expect(titles.sort()).toEqual(["Alpha member", "Beta member"]);
});

test("a one-hop page outranks an equal text match two hops away", async ({ page }) => {
  await openReader(page);
  const near = (await (await fetch(`${BASE}/api/wiki/page?wiki=${WIKI}&relPath=${encodeURIComponent(OPEN)}`)).json())
    .near as Record<string, number>;
  expect(near["plans/hop1.mdx"]).toBeGreaterThan(near["notes/far.mdx"] ?? 0);
  expect(near["notes/far.mdx"]).toBeGreaterThan(0);
  await find(page, "ledger notes");
  await expectLedgerNotes(page, "plans/hop1.mdx", "notes/far.mdx");
});

test("a no-series best match is the first row", async ({ page }) => {
  await openReader(page);
  await find(page, "gamma");
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).first()).toHaveAttribute("data-relpath", "plans/gamma-report.mdx");
  // The series group is there too — below the no-series row, not above it.
  await expect(page.locator("#wikiFindList .wiki-find-group")).toHaveCount(1);
});

test("Enter opens the active row", async ({ page }) => {
  await openReader(page);
  await find(page, "fix rounds");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
  await expect(page.locator(".wiki-article-head h1")).toHaveText("Four fix rounds on widget #500");
  expect(new URL(page.url()).searchParams.get("relPath")).toBe("archive/four-fix-rounds.mdx");
});

test("Escape in focus mode closes the palette and keeps focus mode", async ({ page }) => {
  await openReader(page);
  await page.locator("body").press("f");
  await expect(page.locator(".wiki-layout")).toHaveClass(/focus-mode/);
  await page.locator("body").press("/");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  await expect(page.locator(".wiki-layout")).toHaveClass(/focus-mode/);
});

const h1 = (page: Page) => page.locator(".wiki-article-head h1");

/** Dispatch keydowns on the input synchronously — every one lands inside the
 *  debounce, which `page.keyboard` cannot promise. */
async function keysNow(page: Page, steps: Array<{ value?: string; key?: string; init?: Record<string, unknown> }>) {
  await page.evaluate((list) => {
    const box = document.getElementById("wikiFindInput") as HTMLInputElement;
    for (const s of list) {
      if (s.value !== undefined) {
        box.value = s.value;
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (s.key) {
        box.dispatchEvent(new KeyboardEvent("keydown", { key: s.key, bubbles: true, cancelable: true, ...(s.init ?? {}) }));
      }
    }
  }, steps);
}

test("Enter right after typing opens the FRESH top row, whatever the stale list's active row was", async ({ page }) => {
  await openReader(page);
  await find(page, "member");
  await keysNow(page, [{ key: "ArrowDown" }, { value: "gamma" }, { key: "Enter" }]);
  await expect(palette(page)).toHaveCount(0);
  await expect(h1(page)).toHaveText("Gamma gamma report");
});

test("an arrow inside the debounce moves over the fresh results", async ({ page }) => {
  await openReader(page);
  await find(page, "member");
  // Stale list: active row 1. Fresh "gamma" list: report, gamma-one, gamma-two.
  await keysNow(page, [{ key: "ArrowDown" }, { value: "gamma" }, { key: "ArrowDown" }, { key: "Enter" }]);
  await expect(palette(page)).toHaveCount(0);
  await expect(h1(page)).toHaveText("Gamma one");
});

test("Enter and Escape during an IME composition do nothing palette-specific", async ({ page }) => {
  await openReader(page);
  await find(page, "fix rounds");
  await keysNow(page, [
    { key: "Enter", init: { isComposing: true } },
    { key: "Escape", init: { isComposing: true } },
    { key: "Enter", init: { keyCode: 229 } },
  ]);
  await expect(palette(page)).toBeVisible();
  await expect(h1(page)).toHaveText("Open plan");
});

test("Space on a focused result row opens it", async ({ page }) => {
  await openReader(page);
  await find(page, "fix rounds");
  await page.keyboard.press("Tab");
  await expect(rows(page).first()).toBeFocused();
  await page.keyboard.press(" ");
  await expect(palette(page)).toHaveCount(0);
  await expect(h1(page)).toHaveText("Four fix rounds on widget #500");
});

test("`/` with the Tools menu open does not open the palette", async ({ page }) => {
  await openReader(page);
  const tools = page.locator("details.nav-dropdown").first();
  await tools.locator("summary").click();
  await expect(tools).toHaveAttribute("open", "");
  await page.keyboard.press("/");
  await page.waitForTimeout(150);
  await expect(palette(page)).toHaveCount(0);
  // Checked separately: ⌘K toggles, so pressed after an opening `/` it would close.
  await page.keyboard.press("ControlOrMeta+k");
  await page.waitForTimeout(150);
  await expect(palette(page)).toHaveCount(0);
});

test("Back with the palette open closes it", async ({ page }) => {
  await openReader(page);
  await find(page, "fix rounds");
  await page.keyboard.press("Enter");
  await expect(h1(page)).toHaveText("Four fix rounds on widget #500");
  await find(page, "gamma");
  await page.goBack();
  await expect(h1(page)).toHaveText("Open plan");
  await expect(palette(page)).toHaveCount(0);
});

test("Back to the start view with the palette open closes it", async ({ page }) => {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
  await expect(page.locator("#wikiList .wiki-list-item").first()).toBeVisible();
  await find(page, "fix rounds");
  await page.keyboard.press("Enter");
  await expect(h1(page)).toHaveText("Four fix rounds on widget #500");
  await find(page, "gamma");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Knowledge Wiki" })).toBeVisible();
  await expect(palette(page)).toHaveCount(0);
});

test("a palette opened before the listing arrives says so, then ranks it", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(/\/api\/wiki\/pages\?/, async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}`, { waitUntil: "domcontentloaded" });
  await page.locator("body").press("/");
  await expect(palette(page)).toBeVisible();
  await input(page).fill("gamma");
  // Past the debounce, so only the listing's arrival can re-render the list.
  await page.waitForTimeout(400);
  await expect(page.locator("#wikiFindList .wiki-find-empty")).toHaveText("Loading pages…");
  release();
  await expect(rows(page)).toHaveCount(3);
});

test("after a failed page load the previous page's closeness no longer boosts", async ({ page }) => {
  await openReader(page);
  await page.evaluate((wiki) => {
    history.pushState({}, "", `/wiki?wiki=${wiki}&relPath=${encodeURIComponent("plans/missing.mdx")}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, WIKI);
  await expect(page.locator("#articleWrap .wiki-empty-state")).toBeVisible();
  await find(page, "ledger notes");
  // Equal text, equal dates, no closeness: the relPath tie-break decides.
  await expectLedgerNotes(page, "notes/far.mdx", "plans/hop1.mdx");
});

test("a deep-link boot keeps a palette opened before the listing landed: rows ranked, focus in the input", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(/\/api\/wiki\/pages\?/, async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(OPEN)}`, { waitUntil: "domcontentloaded" });
  await page.locator("body").press("/");
  await expect(palette(page)).toBeVisible();
  await input(page).fill("gamma");
  await page.waitForTimeout(400);
  release();
  // The boot render's own page load (`?relPath=`) runs after the listing lands.
  await expect(h1(page)).toHaveText("Open plan");
  await expect(palette(page)).toBeVisible();
  await expect(input(page)).toHaveValue("gamma");
  await expect(rows(page)).toHaveCount(3);
  await expect(input(page)).toBeFocused();
});

test("a background listing adoption keeps focus inside an open palette", async ({ page }) => {
  await page.clock.install();
  // The focus refetch asks with `?refresh=1`; give it one more page, so the
  // fingerprint differs and the start view adopts it.
  await page.route(/\/api\/wiki\/pages\?.*refresh=1/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.pages.push({ ...body.pages[0], name: "zeta-extra", title: "Zeta extra", relPath: "plans/zeta-extra.mdx" });
    await route.fulfill({ response: res, json: body });
  });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
  await expect(page.locator("#wikiList .wiki-list-item").first()).toBeVisible();
  await page.locator("body").press("/");
  await input(page).fill("gamma");
  await page.clock.runFor(300);
  await expect(rows(page)).toHaveCount(3);
  await page.keyboard.press("Tab"); // the chip
  await page.keyboard.press("Tab"); // the first row
  await expect(rows(page).first()).toBeFocused();
  const refetch = page.waitForResponse(/\/api\/wiki\/pages\?.*refresh=1/);
  await page.clock.fastForward(31_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await refetch;
  // The adoption has run once the rail lists the extra page.
  await expect(page.locator('#wikiList [data-relpath="plans/zeta-extra.mdx"]')).toHaveCount(1);
  expect(await page.evaluate(() => !!document.activeElement?.closest("#wikiFind"))).toBe(true);
  const layoutClass = await page.locator(".wiki-layout").getAttribute("class");
  await page.keyboard.press("f");
  await expect(page.locator(".wiki-layout")).toHaveAttribute("class", layoutClass ?? "");
  await expect(palette(page)).toBeVisible();
});

test("after an ABORTED page load the previous page's closeness no longer boosts", async ({ page }) => {
  await openReader(page);
  await page.route(/\/api\/wiki\/page\?/, (route) => route.abort());
  await page.evaluate((wiki) => {
    history.pushState({}, "", `/wiki?wiki=${wiki}&relPath=${encodeURIComponent("plans/bridge.mdx")}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, WIKI);
  await expect(page.locator("#articleWrap .wiki-empty-state")).toContainText("Failed to load page");
  await find(page, "ledger notes");
  await expectLedgerNotes(page, "notes/far.mdx", "plans/hop1.mdx");
});

test("a failed boot listing says so in an open palette instead of loading forever", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(/\/api\/wiki\/pages\?/, async (route) => {
    await gate;
    await route.abort();
  });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}`, { waitUntil: "domcontentloaded" });
  await page.locator("body").press("/");
  await expect(page.locator("#wikiFindList .wiki-find-empty")).toHaveText("Loading pages…");
  release();
  await expect(page.locator("#wikiFindList .wiki-find-empty")).toHaveText("Couldn't load pages.");
});
