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
 *     the page (the second is selected: the occurrence number decides), and a
 *     bullet that opens in bold and holds inline code (the rendered text has
 *     neither marker).
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
  "- **R2, behind.** The page's `status_date` is older than the newest merge.",
  "- The night route is unchanged.",
  "",
  '<Fold title="Design" summary="routes and stops" open>',
  "", //                                                             15
  "## Design",
  "",
  "Kari Nordmann checked it: The pier opens at six.",
  "",
  "</Fold>", //                                                      20
  "",
].join("\n");

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
 *  as a reader would: the reader reads the selection on `mouseup`. */
async function select(page: Page, text: string, n: number, upTo?: string): Promise<void> {
  await page.evaluate(
    ({ text, n, upTo }) => {
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
      document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    },
    { text, n, upTo },
  );
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
    await select(page, "R2, behind", 1, "newest merge.");
    await page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`).click();
    const clip = await askAndCopy(page, "Which date does R2 read?");
    expect(clip).toContain("Passage (line 11, Harbour timetable › Brief):");
    expect(clip).toContain("> R2, behind. The page's status_date is older than the newest merge.");
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

  test("a wiki without discuss.handoff shows neither control", async ({ page }) => {
    await openPage(page, OFF_WIKI);
    await expect(page.locator(`#${DISCUSS_HANDOFF_PAGE_BTN_ID}`)).toBeHidden();
    await select(page, "The night route is unchanged.", 1);
    // Explain shows for the same selection: the selection was read.
    await expect(page.locator("#wikiExplainBtn")).toBeVisible();
    await expect(page.locator(`#${DISCUSS_HANDOFF_SEL_BTN_ID}`)).toBeHidden();
  });
});
