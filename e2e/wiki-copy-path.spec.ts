/**
 * ⧉ Copy path in the /wiki reader's breadcrumb.
 *
 * What the unit tests cannot reach, and the reason this file exists:
 *
 *  1. **The root actually arrives.** `wikiPagePath` is a pure join; whether the
 *     reader hands it anything depends on a chain with four links — the route's
 *     `servedRoot`, the view's `__WIKI_ROOT__`, `readActiveWikiRoot`, and the
 *     button's `data-copy-path`. Every unit test in that chain is green with the
 *     chain broken, and the symptom is a button that copies a bare relPath.
 *  2. **Every registered wiki, not just mimir.** Both wikis here are temp
 *     directories registered through `WIKI_EXTRA`, and the assertion is the
 *     absolute path of THAT root — a reader that fell back to a default or to
 *     the other wiki's root would still copy something path-shaped.
 *  3. **It survives a navigation.** The breadcrumb's innerHTML is rewritten per
 *     page, so a direct listener works exactly once and the path is per-page
 *     state. The second half of the third case is the whole point.
 *  4. **It is NOT an egress control.** On a wiki registered in
 *     `WIKI_READONLY_ROOTS` the reader dims Share/Fact check/Discuss. Copying a
 *     path spends nothing and reaches nothing, so it must stay live — and a
 *     regression there is invisible on the writable wiki.
 *
 * No model calls: nothing here leaves the process except the clipboard write.
 *
 * ENV PREREQUISITE / SPAWN ENV: as every other spec in this directory — a
 * working `.env` at the repo root, and `e2eEnv()` to keep this muninn off
 * Telegram/Slack and off the host's instance-profile flags. `WIKI_READONLY_ROOTS`
 * is set EXPLICITLY rather than inherited: `e2eEnv()` deliberately leaves it
 * alone (it is a permission guard, not a profile flag), so the spec must own it.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import {
  COPY_PATH_BTN_ID,
  COPY_PATH_IDLE,
  COPY_PATH_OK,
} from "../src/dashboard/views/components/copy-path.ts";

/** The id the render keys on, imported rather than re-typed. */
const BTN = `#${COPY_PATH_BTN_ID}`;

const PORT = e2ePort("wiki-copy-path");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

/** The writable wiki, and the read-only one. Two ROOTS, one process. */
const WIKI = "e2e-copy";
const RO_WIKI = "e2e-copy-ro";

/** A page in a SUBFOLDER: its relPath carries a directory, which is the half a
 *  root-only or a stem-only implementation gets wrong. Its title is deliberately
 *  nothing like its filename — the breadcrumb's leaf is the title, so a button
 *  that copied the visible trail would copy a string naming no file. */
const PAGE = [
  "---",
  "title: OpenCode sessions in claude-usage: the same quantity, for once",
  "---",
  "",
  "# OpenCode sessions in claude-usage",
  "",
  "A page whose on-disk name and whose displayed title share nothing.",
  "",
].join("\n");

const OTHER_PAGE = ["---", "title: Second Page", "---", "", "# Second Page", "", "Another one.", ""].join("\n");

const RO_PAGE = ["---", "title: Read Only Page", "---", "", "# Read Only Page", "", "Look, don't touch.", ""].join("\n");

const PAGE_REL = "plans/opencode-sessions.md";
const OTHER_REL = "second-page.md";
const RO_REL = "read-only-page.md";

let server: ChildProcess | undefined;
let root = "";
let roRoot = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-copy-"));
  roRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-copy-ro-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, PAGE_REL), PAGE, "utf8");
  await writeFile(path.join(root, OTHER_REL), OTHER_PAGE, "utf8");
  await writeFile(path.join(roRoot, RO_REL), RO_PAGE, "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root},${RO_WIKI}=${roRoot}`,
      WIKI_READONLY_ROOTS: roRoot,
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
  if (roRoot) await rm(roRoot, { recursive: true, force: true });
});

/** Open a page by relPath and wait for the breadcrumb's button to be there. */
async function openPage(
  page: import("@playwright/test").Page,
  wiki: string,
  relPath: string,
): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${wiki}&relPath=${encodeURIComponent(relPath)}`);
  await expect(page.locator(BTN)).toBeVisible();
}

test.describe("Wiki reader: ⧉ Copy path", () => {
  test("copies the page's ABSOLUTE on-disk path, folder and all", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openPage(page, WIKI, PAGE_REL);

    const btn = page.locator(BTN);
    await btn.click();
    await expect(btn).toHaveText(COPY_PATH_OK);

    // The acceptance: this is the string that reaches an agent brief.
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${root}/${PAGE_REL}`);
  });

  test("says what it will copy BEFORE the click, and it is not the breadcrumb text", async ({
    page,
  }) => {
    await openPage(page, WIKI, PAGE_REL);
    const btn = page.locator(BTN);
    await expect(btn).toHaveAttribute("title", `Copy ${root}/${PAGE_REL}`);
    await expect(btn).toHaveAttribute("aria-label", new RegExp(`${root}/${PAGE_REL}$`));

    // The trail's leaf is the TITLE — the reason a copy button is needed at all,
    // and the string a "copy what you see" implementation would have handed over.
    await expect(page.locator(".wiki-bc-cur")).toContainText("the same quantity, for once");
  });

  test("follows a navigation instead of copying the page you arrived on", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openPage(page, WIKI, PAGE_REL);

    // Same tab, no reload: the breadcrumb is re-rendered, which is where a direct
    // listener dies and where a stale `data-copy-path` would survive.
    await page.locator(`.wiki-list-item[data-relpath="${OTHER_REL}"]`).click();
    await expect(page.locator(".wiki-bc-cur")).toContainText("Second Page");

    const btn = page.locator(BTN);
    await expect(btn).toHaveAttribute("title", `Copy ${root}/${OTHER_REL}`);
    await btn.click();
    await expect(btn).toHaveText(COPY_PATH_OK);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${root}/${OTHER_REL}`);
  });

  test("stays live on a READ-ONLY wiki, where its egress neighbours are dimmed", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openPage(page, RO_WIKI, RO_REL);

    // The wiki really is registered read-only — otherwise the second half of
    // this test proves nothing about the dim.
    await expect(page.locator("body.wiki-readonly-wiki")).toHaveCount(1);
    await expect(page.locator("#wikiShareBtn")).toHaveCSS("opacity", "0.45");

    const btn = page.locator(BTN);
    await expect(btn).toHaveCSS("opacity", "1");
    await btn.click();
    await expect(btn).toHaveText(COPY_PATH_OK);
    // …and the root it copies is the READ-ONLY wiki's, not the other one's.
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${roRoot}/${RO_REL}`);
  });

  /**
   * The regression the first version of this spec structurally could not see,
   * now stated as the RULE the CSS comment used to spell out as a table.
   *
   * `.wiki-bc-trail` is the breadcrumb row's ONLY shrinkable item, so every
   * action button added to that row comes out of the trail's width. Measured on
   * the unfixed commit: 27px at 1280 (the common laptop width) and 0px at 800,
   * where the last action hung 72px past the pane and the whole document
   * scrolled sideways. Every other assertion in this file stayed green —
   * `toContainText` reads `textContent`, which is intact at 3px wide.
   *
   * ⚠️ **Two axes, and the second is the one three rounds of hand-sweeping
   * missed.** Width is the obvious one. The other is HOW MANY buttons are in
   * the row: ✨ Explain and ✓ Fact check are hidden until the reader selects
   * text, so every measurement taken without a selection is of a row two items
   * shorter than the one a reader who is about to explain a passage sees. The
   * cases below run both.
   *
   * What is asserted is the rule, not a layout: the trail stays legible and the
   * row never overflows its pane. The extra `noWrap` pin (no selection only)
   * exists because a basis large enough to wrap everywhere costs ~29px of
   * article height on every laptop forever — that is how round 1's fix
   * regressed 1024–1550 while every assertion above it still passed.
   */
  async function breadcrumbGeometry(page: import("@playwright/test").Page) {
    return page.evaluate(() => {
      const trail = document.querySelector(".wiki-bc-trail");
      const bc = document.querySelector(".wiki-breadcrumb");
      const share = document.querySelector("#wikiShareBtn");
      const pane = bc?.parentElement;
      const t = trail!.getBoundingClientRect();
      const sh = share!.getBoundingClientRect();
      return {
        trail: t.width,
        shareOverflow: sh.right - pane!.getBoundingClientRect().right,
        docOverflow: document.documentElement.scrollWidth - window.innerWidth,
        // Did the row wrap? Compared by the TOP EDGES of the first and last
        // items, not by dividing the row's height by a pixel constant — a
        // constant misreports the moment a font size, a zoom level or a theme
        // changes the line box, and would then fail as a wrap regression that
        // is not one.
        wrapped: sh.top > t.top + 4,
      };
    });
  }

  /** Select a run of article text, which is what reveals ✨ Explain and ✓ Fact
   *  check — two more items in the row under test. */
  async function selectArticleText(page: import("@playwright/test").Page): Promise<void> {
    await page.evaluate(() => {
      // The article body, not a `p`: `formatWebHtml` emits prose as text nodes
      // under `.wiki-article`, so this fixture page has no paragraph element at
      // all and a `p` selector silently selects nothing.
      const body = document.querySelector(".wiki-article");
      if (!body) throw new Error("no article body to select");
      const r = document.createRange();
      r.selectNodeContents(body);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
      // The reveal is wired to `mouseup` on #articleWrap (selectionchange only
      // HIDES), so a programmatic selection has to dispatch the event the
      // reader's drag would have.
      document.getElementById("articleWrap")!.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true }),
      );
    });
    await expect(page.locator("#wikiExplainBtn")).toBeVisible();
  }

  for (const width of [1440, 1280, 1024, 800]) {
    test(`the trail stays legible and the row does not overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openPage(page, WIKI, PAGE_REL);

      const m = await breadcrumbGeometry(page);
      expect(m.trail).toBeGreaterThan(120);
      expect(m.shareOverflow).toBeLessThanOrEqual(0);
      expect(m.docOverflow).toBeLessThanOrEqual(0);
      // …and the row does not double where it does not have to.
      if (width === 1440 || width === 1024) expect(m.wrapped).toBe(false);

      // The other axis: with a selection live the row carries two more buttons.
      // The rule must still hold; whether it wraps to do so is the CSS's choice.
      await selectArticleText(page);
      const sel = await breadcrumbGeometry(page);
      expect(sel.trail).toBeGreaterThan(120);
      expect(sel.shareOverflow).toBeLessThanOrEqual(0);
      expect(sel.docOverflow).toBeLessThanOrEqual(0);
    });
  }

  test("is icon-only, and the tooltip carries what the dropped label used to", async ({ page }) => {
    await openPage(page, WIKI, PAGE_REL);
    const btn = page.locator(BTN);

    // The words are gone — that is the point of the control being a glyph.
    // (An exact `toHaveText` already excludes "Copy path"; a second
    // `not.toContain` beside it asserts nothing the first does not.)
    await expect(btn).toHaveText(COPY_PATH_IDLE);

    // …and what replaced them says MORE than they did: the exact string.
    await expect(btn).toHaveAttribute("title", `Copy ${root}/${PAGE_REL}`);
    await expect(btn).toHaveAttribute("aria-label", `Copy this page's file path: ${root}/${PAGE_REL}`);

    // The whole reason for the change: the button's own width. The labelled
    // version measured 96px on this row; a glyph must not creep back toward it
    // — and must not collapse either, which an upper bound alone would pass.
    const box = await btn.boundingBox();
    expect(box!.width).toBeLessThan(48);
    expect(box!.width).toBeGreaterThan(20);
  });

  test("a second click's confirmation is not erased by the first click's timer", async ({
    page,
    context,
  }) => {
    // Each click used to schedule its own revert, so the first one wiped the
    // second's "Copied" — a copy that DID happen reading as a dead control.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openPage(page, WIKI, PAGE_REL);
    const btn = page.locator(BTN);

    await btn.click();
    await expect(btn).toHaveText(COPY_PATH_OK);
    await page.waitForTimeout(1200);
    await btn.click();
    await expect(btn).toHaveText(COPY_PATH_OK);

    // Past the FIRST click's deadline (1600ms), inside the second's.
    await page.waitForTimeout(600);
    await expect(btn).toHaveText(COPY_PATH_OK);
    // The accessible name moves with the text — an aria-label overrides the
    // button's text, so a static one silences the only feedback there is.
    // The button shows a GLYPH; the accessible name still says the words, which
    // is the half a screen reader hears.
    await expect(btn).toHaveAttribute("aria-label", new RegExp(`^Copied — Copy this page`));

    // …and it does go back on its own.
    await expect(btn).toHaveText(COPY_PATH_IDLE, { timeout: 4000 });
    await expect(btn).toHaveAttribute("aria-label", `Copy this page's file path: ${root}/${PAGE_REL}`);
  });
});
