/**
 * «Ask Claude Code» in the /wiki reader (Discuss P1, mimir plan muninn-wiki-discuss).
 *
 * What the unit tests cannot reach:
 *
 *  1. **The chain from a real selection to the clipboard.** The selection's text
 *     is read by the browser (`readerSelectionText` is `Selection.toString` with
 *     the reader's additions hidden by CSS), counted in the live article, sent
 *     to the route and copied through `copyText`. A green locator test says
 *     nothing about any link of that.
 *  2. **The right lines for the hard shapes.** A sentence that appears twice on
 *     the page (the second is selected: the context the client reads around it
 *     decides), a bullet that opens in bold and holds inline code (the rendered
 *     text has neither marker), a selection past Explain's 1,500
 *     characters (offered, located whole), and a checklist row selected from
 *     its ✗ (the mark is hidden from the reading by CSS, the `[ ]` dropped by
 *     the collapse).
 *  4. **The controls as a keyboard user meets them.** A selection made or
 *     extended with Shift+ArrowRight is the one offered and quoted; Tab to the
 *     selection's control and press Enter; Escape closes the panel wherever
 *     focus is and returns focus to the control, which a late `selectionchange`
 *     does not hide; a passage selected with the mouse while the panel is
 *     open is the one a second activation asks about, and closing the panel
 *     keeps it; Copy is disabled while its request runs; a
 *     non-JSON answer shows its status. The whole-page control shows on an
 *     HTML explainer page too.
 *  5. **Off the page.** A selection inside a link's peek card offers no
 *     control; the start view closes the panel and removes the controls,
 *     and a page shown again brings them back.
 *  3. **The opt-in and the read-only wiki.** A wiki whose `.wiki-reader.json`
 *     does not set `discuss.handoff` shows neither control; a wiki in
 *     `WIKI_READONLY_ROOTS` still offers them, since nothing here calls a model.
 *
 * No model calls. Its own muninn with `e2eEnv()`, wikis in temp dirs through
 * `WIKI_EXTRA`, `WIKI_READONLY_ROOTS` set explicitly (`e2eEnv()` leaves it).
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import {
  DISCUSS_HANDOFF_PAGE_BTN_ID,
  DISCUSS_HANDOFF_PANEL_ID,
  DISCUSS_HANDOFF_SEL_BTN_ID,
} from "../src/dashboard/views/components/wiki-discuss-handoff.ts";

const PORT = e2ePort("wiki-discuss-handoff");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-handoff";
const RO_WIKI = "e2e-handoff-ro";
const OFF_WIKI = "e2e-handoff-off";
const REL = "plans/harbour.mdx";

/** Line numbers are pinned by the assertions below: keep them in step. */
const PAGE = [
  "---", //                                                          1
  "title: Harbour timetable",
  "---",
  "",
  "# Harbour timetable", //                                          5
  "",
  "## Brief",
  "",
  "The pier opens at six.",
  "", //                                                             10
  "- **B4, late.** The ferry's `dock_time` is earlier than the first bell.",
  "- The night route is unchanged.",
  "",
  '<Fold title="Design" summary="routes and stops" open="true">',
  "", //                                                             15
  "## Design",
  "",
  "Kari Nordmann checked it: The pier opens at six.",
  "",
  "</Fold>", //                                                      20
  "",
  "## Long", //                                                      22
  "",
  ...Array.from({ length: 30 }, (_, k) => `Line ${k} of the long section says something different about berth number ${k}.`), // 24-53
  "",
  "## Boards", //                                                    55
  "",
  "<Checklist>",
  "",
  "- [x] Order the new boards from the yard",
  "- [ ] Hang the new boards at the pier", //                       60
  "",
  "</Checklist>",
  "",
].join("\n");
const EXPLAINER = "notes/board.html";
/** A page whose middle links to its first section: a hover on the link shows a peek card. */
const PEEK_REL = "plans/peek.mdx";
const PEEK_PAGE = ["---", "title: Gate", "---", "", "# Gate", "", "## First", "", "The gate opens at dawn for the carts.", "", "## Middle", "", "See [the first part](#first) for it.", "", "## Last", "", "The gate shuts at dusk.", ""].join("\n");

let server: ChildProcess | undefined;
let root = "";
let roRoot = "";
let offRoot = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-handoff-"));
  roRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-handoff-ro-"));
  offRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-handoff-off-"));
  for (const r of [root, roRoot, offRoot]) {
    await mkdir(path.join(r, "plans"), { recursive: true });
    await writeFile(path.join(r, REL), PAGE, "utf8");
  }
  await writeFile(path.join(root, PEEK_REL), PEEK_PAGE, "utf8");
  await mkdir(path.join(root, "notes"), { recursive: true });
  await writeFile(path.join(root, EXPLAINER), "<!doctype html><html><head><title>Board</title></head><body><h1>Board</h1><p>Departures.</p></body></html>", "utf8");
  const on = JSON.stringify({ discuss: { handoff: true } });
  await writeFile(path.join(root, ".wiki-reader.json"), on, "utf8");
  await writeFile(path.join(roRoot, ".wiki-reader.json"), on, "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root},${RO_WIKI}=${roRoot},${OFF_WIKI}=${offRoot}`,
      WIKI_READONLY_ROOTS: roRoot,
      // Off: the prompt then carries no card command, whatever the host has.
      PLAN_CARD_BIN: "",
    },
    stdio: "ignore",
    detached: true,
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
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
  }
  for (const r of [root, roRoot, offRoot]) if (r) await rm(r, { recursive: true, force: true });
});

async function openPage(page: Page, wiki: string): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${wiki}&relPath=${encodeURIComponent(REL)}`);
  await expect(page.locator(".wiki-article")).toContainText("The night route is unchanged.");
}

/** Select the `n`-th (1-based) text node match of `text` in the article, from
 *  its start to the end of `upTo` (or of `text`), and release the mouse there
 *  as a reader would (Explain and Fact check show on that `mouseup`; the
 *  handoff follows `selectionchange`). `mouseup: false` dispatches none. */
async function select(page: Page, text: string, n: number, upTo?: string, mouseup = true): Promise<void> {
  await page.evaluate(
    ({ text, n, upTo, mouseup }) => {
      const article = document.querySelector(".wiki-article")!;
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      let k = 0;
      let start: [Text, number] | null = null;
      let end: [Text, number] | null = null;
      for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
        if (!start) {
          const i = t.data.indexOf(text);
          if (i !== -1 && ++k === n) {
            start = [t, i];
            if (!upTo) {
              end = [t, i + text.length];
              break;
            }
          }
        }
        if (start && upTo) {
          const j = t.data.indexOf(upTo);
          if (j !== -1) {
            end = [t, j + upTo.length];
            break;
          }
        }
      }
      if (!start || !end) throw new Error(`no selection for ${text}`);
      const r = document.createRange();
      r.setStart(start[0], start[1]);
      r.setEnd(end[0], end[1]);
      const sel = getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
      if (mouseup) document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    },
    { text, n, upTo, mouseup },
  );
}

/** Select the first `text` in the article with a real mouse drag, from its
 *  first character's left edge to its last character's right edge. */
async function dragSelect(page: Page, text: string): Promise<void> {
  const at = await page.evaluate((text) => {
    const article = document.querySelector(".wiki-article")!;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
      const i = t.data.indexOf(text);
      if (i === -1) continue;
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + text.length);
      const rects = r.getClientRects();
      const a = rects[0]!;
      const b = rects[rects.length - 1]!;
      return { x0: a.left + 1, y0: a.top + a.height / 2, x1: b.right - 1, y1: b.top + b.height / 2 };
    }
    throw new Error(`no text ${text}`);
  }, text);
  await page.mouse.move(at.x0, at.y0);
  await page.mouse.down();
  await page.mouse.move(at.x1, at.y1, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(text);
}

async function askAndCopy(page: Page, question: string): Promise<string> {
  const panel = page.locator(`#${DISCUSS_HANDOFF_PANEL_ID}`);
  await expect(panel).toBeVisible();
  await panel.locator("textarea.wiki-handoff-q").fill(question);
  await panel.locator("[data-handoff=copy]").click();
  await expect(panel.locator(".wiki-handoff-status")).toContainText("Copied");
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe("Wiki reader: Ask Claude Code", () => {
  test("a sentence that appears twice: the second one's own line", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openPage(page, WIKI);
    await select(page, "The pier opens at six.", 2);
    const btn = page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`);
    await expect(btn).toBeVisible();
    await btn.click();
    // The panel is not a dialog: the reader's single-key shortcuts stay on outside it.
    await expect(page.locator(`#${DISCUSS_HANDOFF_PANEL_ID}`)).not.toHaveAttribute("role", "dialog");
    const clip = await askAndCopy(page, "When does it open on Sundays?");
    expect(clip).toContain(`Page: ${root}/${REL}`);
    expect(clip).toContain("Passage (line 18, Harbour timetable › Design):");
    expect(clip).toContain("> The pier opens at six.");
    expect(clip).toContain("Question: When does it open on Sundays?");
    expect(clip).not.toContain("plan-card");
  });

  test("a bullet that opens in bold and holds inline code", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openPage(page, WIKI);
    await select(page, "B4, late", 1, "first bell.");
    await page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`).click();
    const clip = await askAndCopy(page, "Which time does B4 read?");
    expect(clip).toContain("Passage (line 11, Harbour timetable › Brief):");
    expect(clip).toContain("> B4, late. The ferry's dock_time is earlier than the first bell.");
    expect(clip).toContain(`${root}/${REL}`);
  });

  test("the whole page from the breadcrumb: the path and no line range", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openPage(page, WIKI);
    await page.locator(`#${DISCUSS_HANDOFF_PAGE_BTN_ID}`).click();
    const clip = await askAndCopy(page, "What is this page for?");
    expect(clip).toContain(`Page: ${root}/${REL}`);
    expect(clip).toContain("Question about the whole page: What is this page for?");
    expect(clip).not.toMatch(/\blines? \d/);
  });

  test("a read-only wiki still offers it", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openPage(page, RO_WIKI);
    await expect(page.locator("body.wiki-readonly-wiki")).toHaveCount(1);
    const pageBtn = page.locator(`#${DISCUSS_HANDOFF_PAGE_BTN_ID}`);
    await expect(pageBtn).toBeVisible();
    await expect(pageBtn).toHaveCSS("opacity", "1");
    await select(page, "The night route is unchanged.", 1);
    await page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`).click();
    const clip = await askAndCopy(page, "Is it?");
    expect(clip).toContain(`${roRoot}/${REL}`);
    expect(clip).toContain("Passage (line 12,");
  });

  test("a selection past Explain's 1,500 characters: offered, and its range runs to its end", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openPage(page, WIKI);
    await select(page, "Line 0 of the long section", 1, "berth number 29.");
    expect(await page.evaluate(() => getSelection()!.toString().length)).toBeGreaterThan(1500);
    await expect(page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`)).toBeVisible();
    await expect(page.locator("#wikiExplainBtn")).toBeHidden();
    await page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`).click();
    const clip = await askAndCopy(page, "Which berths?");
    expect(clip).toContain("Passage (lines 24–53, Harbour timetable › Long):");
  });

  test("a checklist row selected from its ✗ mark: its own line, the mark not quoted", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openPage(page, WIKI);
    await select(page, "✗", 1, "at the pier");
    await page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`).click();
    const clip = await askAndCopy(page, "Who hangs them?");
    expect(clip).toContain("Passage (line 60, Harbour timetable › Boards):");
    expect(clip).toContain("> Hang the new boards at the pier");
    expect(clip).not.toContain("✗");
  });

  test("keyboard: Tab to the control, Enter opens; Escape with focus on the page closes and returns focus", async ({ page }) => {
    await openPage(page, WIKI);
    // No mouseup: Explain and Fact check stay hidden, the handoff shows.
    await select(page, "The night route is unchanged.", 1, undefined, false);
    const btn = page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`);
    await expect(btn).toBeVisible();
    // Reach the control from the nearest shown control before it, as Tab does.
    await btn.evaluate((b) => {
      let el = b.previousElementSibling as HTMLElement | null;
      while (el && (el.tagName !== "BUTTON" || el.offsetParent === null)) el = el.previousElementSibling as HTMLElement | null;
      if (!el) throw new Error("no shown control before the handoff");
      el.focus();
    });
    await page.keyboard.press("Tab");
    await expect(btn).toBeFocused();
    await page.keyboard.press("Enter");
    const panel = page.locator(`#${DISCUSS_HANDOFF_PANEL_ID}`);
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("role", "group");
    await expect(panel.locator("textarea.wiki-handoff-q")).toHaveAttribute("maxlength", "2000");
    // Focus off the panel (as the fallback copy leaves it), then Escape.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(btn).toBeFocused();
  });

  test("a selection made with the keyboard only shows the control, and the prompt quotes it", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openPage(page, WIKI);
    // Chromium moves a caret in plain text only under caret browsing, which a
    // test cannot switch on: the start is a one-character selection, too short
    // to offer, set by script. Shift+ArrowRight makes the rest; no mouse event.
    await page.evaluate(() => {
      const article = document.querySelector(".wiki-article")!;
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
        const i = t.data.indexOf("The night route");
        if (i !== -1) return void getSelection()!.setBaseAndExtent(t, i, t, i + 1);
      }
      throw new Error("no start text");
    });
    const btn = page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`);
    await page.waitForTimeout(150);
    await expect(btn).toBeHidden();
    const passage = "The night route is unchanged.";
    for (let i = 1; i < passage.length; i++) await page.keyboard.press("Shift+ArrowRight");
    expect(await page.evaluate(() => getSelection()!.toString())).toBe(passage);
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(page.locator(`#${DISCUSS_HANDOFF_PANEL_ID} .wiki-handoff-quote`)).toHaveText(passage);
    const clip = await askAndCopy(page, "Since when?");
    expect(clip).toContain("Passage (line 12, Harbour timetable › Brief):");
    expect(clip).toContain(`> ${passage}`);
  });

  test("a mouse selection extended with Shift+ArrowRight: the panel and the prompt hold the extended selection", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openPage(page, WIKI);
    await select(page, "The night route", 1);
    const btn = page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`);
    await expect(btn).toBeVisible();
    for (let i = 0; i < " is unchanged.".length; i++) await page.keyboard.press("Shift+ArrowRight");
    const live = await page.evaluate(() => getSelection()!.toString());
    expect(live).toBe("The night route is unchanged.");
    // At once, before the selection has settled: opening reads it as it is now.
    await btn.click();
    await expect(page.locator(`#${DISCUSS_HANDOFF_PANEL_ID} .wiki-handoff-quote`)).toHaveText(live);
    const clip = await askAndCopy(page, "Since when?");
    expect(clip).toContain(`> ${live}`);
  });

  test("a selectionchange that arrives after the panel closed keeps the control, its focus and the selection", async ({ page }) => {
    await openPage(page, WIKI);
    await select(page, "The night route is unchanged.", 1);
    const btn = page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`);
    await btn.click();
    const panel = page.locator(`#${DISCUSS_HANDOFF_PANEL_ID}`);
    await expect(panel.locator("textarea.wiki-handoff-q")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(btn).toBeFocused();
    // The event focus in the question box queued, delivered late (the order a real browser sometimes takes).
    await page.evaluate(() => document.dispatchEvent(new Event("selectionchange")));
    await page.waitForTimeout(200);
    await expect(btn).toBeVisible();
    await expect(btn).toBeFocused();
    expect(await page.evaluate(() => getSelection()!.toString())).toBe("The night route is unchanged.");
  });

  test("a passage selected with the mouse while the panel is open: activating the control asks about it", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openPage(page, WIKI);
    // No mouseup: Explain stays hidden, so the drag's press hides nothing and the article does not move under it.
    await select(page, "The pier opens at six.", 1, undefined, false);
    const btn = page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`);
    await btn.click();
    const panel = page.locator(`#${DISCUSS_HANDOFF_PANEL_ID}`);
    await expect(panel.locator(".wiki-handoff-quote")).toHaveText("The pier opens at six.");
    await dragSelect(page, "The night route is unchanged.");
    await expect(panel).toBeVisible();
    await btn.click();
    await expect(panel.locator(".wiki-handoff-quote")).toHaveText("The night route is unchanged.");
    const clip = await askAndCopy(page, "Since when?");
    expect(clip).toContain("Passage (line 12, Harbour timetable › Brief):");
    expect(clip).toContain("> The night route is unchanged.");
  });

  test("closing the panel keeps a selection made while it was open", async ({ page }) => {
    await openPage(page, WIKI);
    await select(page, "The pier opens at six.", 1, undefined, false); // no mouseup: see the test above
    const btn = page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`);
    await btn.click();
    const panel = page.locator(`#${DISCUSS_HANDOFF_PANEL_ID}`);
    await expect(panel).toBeVisible();
    await dragSelect(page, "The night route is unchanged.");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    expect(await page.evaluate(() => getSelection()!.toString())).toBe("The night route is unchanged.");
    await page.waitForTimeout(150);
    await expect(btn).toBeVisible();
    expect(await page.evaluate(() => getSelection()!.toString())).toBe("The night route is unchanged.");
  });

  test("Copy is disabled while its request runs, and a non-JSON answer shows its status", async ({ page }) => {
    await openPage(page, WIKI);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/wiki/discuss/handoff", async (route) => {
      await held;
      await route.fulfill({ status: 502, contentType: "text/html", body: "<html>Bad gateway</html>" });
    });
    await page.locator(`#${DISCUSS_HANDOFF_PAGE_BTN_ID}`).click();
    const panel = page.locator(`#${DISCUSS_HANDOFF_PANEL_ID}`);
    await panel.locator("textarea.wiki-handoff-q").fill("Anything?");
    await panel.locator("[data-handoff=copy]").click();
    await expect(panel.locator("[data-handoff=copy]")).toBeDisabled();
    release();
    await expect(panel.locator(".wiki-handoff-status")).toHaveText("The prompt could not be built (502).");
    await expect(panel.locator("[data-handoff=copy]")).toBeEnabled();
  });

  test("an HTML explainer page offers the whole-page control", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(EXPLAINER)}`);
    await expect(page.locator("iframe.wiki-explainer-frame")).toBeVisible();
    const pageBtn = page.locator(`#${DISCUSS_HANDOFF_PAGE_BTN_ID}`);
    await expect(pageBtn).toBeVisible();
    await pageBtn.click();
    const clip = await askAndCopy(page, "What does the board show?");
    expect(clip).toContain(`Page: ${root}/${EXPLAINER}`);
    expect(clip).toContain("Question about the whole page: What does the board show?");
  });

  test("a selection inside a link's peek card offers no control: the card is not the page", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(PEEK_REL)}`);
    await expect(page.locator(".wiki-article")).toContainText("The gate shuts at dusk.");
    const btn = page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`);
    await select(page, "The gate opens at dawn", 1, "for the carts.");
    await expect(btn).toBeVisible();
    await page.locator(".wiki-article a", { hasText: "the first part" }).hover();
    const peek = page.locator(".wiki-article .wiki-ref-peek");
    await expect(peek).toContainText("The gate opens at dawn");
    await peek.evaluate((card) => {
      const w = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      for (let t = w.nextNode() as Text | null; t; t = w.nextNode() as Text | null) {
        const i = t.data.indexOf("The gate opens");
        if (i === -1) continue;
        getSelection()!.setBaseAndExtent(t, i, t, t.data.length);
        return;
      }
      throw new Error("no text in the peek card");
    });
    await page.waitForTimeout(200);
    await expect(peek).toBeVisible();
    await expect(btn).toBeHidden();
  });

  test("leaving the page for the start view closes the panel and hides the controls; a page brings them back", async ({ page }) => {
    await openPage(page, WIKI);
    const panel = page.locator(`#${DISCUSS_HANDOFF_PANEL_ID}`);
    await page.locator(`#${DISCUSS_HANDOFF_PAGE_BTN_ID}`).click();
    await expect(panel).toBeVisible();
    await page.locator(".wiki-bc-wiki").click();
    await expect(page).not.toHaveURL(/relPath=/);
    await expect(panel).toBeHidden();
    await expect(page.locator(`#${DISCUSS_HANDOFF_PAGE_BTN_ID}`)).toHaveCount(0);
    await expect(page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`)).toHaveCount(0);
    await page.goBack();
    await expect(page.locator(".wiki-article")).toContainText("The night route is unchanged.");
    await expect(page.locator(`#${DISCUSS_HANDOFF_PAGE_BTN_ID}`)).toBeVisible();
    await select(page, "The night route is unchanged.", 1);
    await expect(page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`)).toBeVisible();
  });

  test("a wiki without discuss.handoff shows neither control", async ({ page }) => {
    await openPage(page, OFF_WIKI);
    await expect(page.locator(`#${DISCUSS_HANDOFF_PAGE_BTN_ID}`)).toHaveCount(0);
    await select(page, "The night route is unchanged.", 1);
    // Explain shows for the same selection: the selection was read.
    await expect(page.locator("#wikiExplainBtn")).toBeVisible();
    await expect(page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`)).toHaveCount(0);
  });
});
