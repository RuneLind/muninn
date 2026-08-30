/**
 * Fact-check inline annotation — the READER's interactive layer (PR 4).
 *
 * What no unit test can prove: the server-rendered marks/chips/appendix actually
 * become an interactive layer in a real browser — a chip expands the evidence
 * cloned out of the collapsed appendix, the summary strip carries the run's date
 * and counts, and the layer toggle makes the article read clean underneath.
 *
 * Setup mirrors `wiki-integrate.spec.ts` (the precedent in this repo): the spec
 * boots its OWN muninn on a separate port with `WIKI_EXTRA` pointed at a
 * throwaway temp wiki holding a VERBATIM copy of the approved golden fixture
 * (`src/wiki/__fixtures__/factcheck-annotated-page.mdx`), rather than riding the
 * shared `webServer` (whose command carries no `WIKI_EXTRA`, and whose
 * `reuseExistingServer` would hand us a dev server without it).
 *
 * No model calls anywhere: everything under test is client-side behaviour over
 * markup the server renders from a file on disk.
 *
 * ENV PREREQUISITE + PLATFORM TOKENS: identical to `wiki-integrate.spec.ts` — a
 * working `.env` at the repo root, and every Telegram/Slack token blanked via the
 * shared `e2eEnv()` so this server can't 409-fight the running production
 * jarvis's long-poller.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-factcheck-reader");
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI_NAME = "e2e-factcheck";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const REL_PATH = "creatine-loading.mdx";
const FIXTURE = path.join(REPO_ROOT, "src/wiki/__fixtures__/factcheck-annotated-page.mdx");

/**
 * A SECOND page, written here rather than into the golden fixture: that file is
 * asserted BYTE-EXACT by `factcheck-appendix.test.ts`, so adding a fence to it
 * would break an unrelated contract. This one exists for one reason — the
 * golden appendix contains no code fence, which is why the evidence card's
 * code-block chrome had no regression coverage at its only production call
 * site and the whole fix could be deleted with every suite still green.
 */
const FENCE_REL_PATH = "fenced-claim.mdx";
const FENCE_CLAIM_CODE = "SELECT lean_mass FROM trials WHERE age >= 50;";
const FENCE_PAGE = [
  "---",
  "title: Fenced claim",
  "---",
  "",
  "# Fenced claim",
  "",
  '<Fact n="1" v="bad">The query counted every trial.</Fact>',
  "",
  "<!-- factcheck:start -->",
  '<FactCheck date="2026-08-30" ok="0" warn="0" bad="1">',
  "",
  "### ❌ Claim 1/1 — The query counted every trial",
  "",
  "It filtered on age, so it counted a subset:",
  "",
  "```sql",
  FENCE_CLAIM_CODE,
  "```",
  "",
  "Confidence: 90/100",
  "",
  "</FactCheck>",
  "<!-- factcheck:end -->",
  "",
].join("\n");

let root: string;
let server: ChildProcess | undefined;

/**
 * Console errors raised by OUR code. Two unrelated sources are filtered, both
 * artifacts of the harness rather than the feature: the fixture carries a
 * ```mermaid fence, so the reader injects the pinned mermaid CDN script (a
 * sandboxed/offline box logs a resource-load failure for it), and the throwaway
 * wiki has no huginn collections, so the reader's lazy `/api/wiki/similar` fetch
 * 404s by design. BOTH filters are narrowed to resource-load failures attributed
 * by URL — a bare `/mermaid/i` text match would also swallow a real exception
 * thrown from the mermaid enhancer. Uncaught page exceptions are collected
 * separately and are NEVER filtered.
 */
function collectErrors(page: Page): { console: string[]; page: string[] } {
  const out = { console: [] as string[], page: [] as string[] };
  // The console message for a failed fetch carries no URL, so the last >=400
  // response is tracked to attribute it.
  let lastFailedUrl = "";
  page.on("response", (r) => {
    if (r.status() >= 400) lastFailedUrl = r.url();
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    const url = msg.location()?.url || lastFailedUrl;
    const isLoadFailure = /Failed to load resource/i.test(text);
    if (isLoadFailure && /jsdelivr|mermaid/i.test(url)) return;
    if (isLoadFailure && /api\/wiki\/similar/.test(url)) return;
    out.console.push(text);
  });
  page.on("pageerror", (err) => out.page.push(String(err)));
  return out;
}

async function openFixturePage(page: Page): Promise<void> {
  // domcontentloaded, not networkidle: the reader keeps polling/streaming surfaces
  // alive, so networkidle never fires (the /agents lesson).
  await page.goto(`${BASE}/wiki?wiki=${WIKI_NAME}&relPath=${encodeURIComponent(REL_PATH)}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator(".wiki-article")).toContainText("Creatine loading");
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-fc-"));
  await writeFile(path.join(root, REL_PATH), readFileSync(FIXTURE, "utf8"), "utf8");
  await writeFile(path.join(root, FENCE_REL_PATH), FENCE_PAGE, "utf8");
  await writeFile(path.join(root, "log.md"), "# Log\n", "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI_NAME}=${root}`,
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI_NAME}`);
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

test.describe("Fact-check reader interaction", () => {
  test("chips expand evidence cloned from the appendix, and close again", async ({ page }) => {
    const errs = collectErrors(page);
    await openFixturePage(page);

    const chips = page.locator(".wiki-article .fc-chip");
    await expect(chips).toHaveCount(8);

    const chip4 = page.locator('.wiki-article .fc-chip[data-fact="4"]');
    await expect(chip4).toHaveAttribute("aria-expanded", "false");
    await chip4.click();

    // The card carries the CLAIM-4 evidence — heading, the `Was:` original, and
    // the confidence line — cloned out of the collapsed appendix.
    const card = page.locator('.wiki-article .fc-card[data-fc-card="4"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText("Claim 4/8");
    await expect(card).toContainText("Was: Roughly 1kg of additional lean muscle mass");
    await expect(card).toContainText("Confidence: 85/100");
    await expect(chip4).toHaveAttribute("aria-expanded", "true");
    // The clone must not duplicate the appendix's addressable id.
    await expect(page.locator("#fc-claim-4")).toHaveCount(1);
    // Focus stays on the chip that opened it.
    await expect(chip4).toBeFocused();

    // Clicking the same chip again closes it.
    await chip4.click();
    await expect(page.locator(".wiki-article .fc-card")).toHaveCount(0);
    await expect(chip4).toHaveAttribute("aria-expanded", "false");

    expect(errs.page).toEqual([]);
    expect(errs.console).toEqual([]);
  });

  test("an INLINE chip's card lands after the whole inline run, not mid-sentence", async ({
    page,
  }) => {
    await openFixturePage(page);
    // Chip 1 sits in the opening paragraph. `formatWebHtml` emits no <p>, so that
    // paragraph is bare text nodes with the mark + chip as DIRECT children of
    // .wiki-article — the case where a naive "block containing the chip" walk
    // returns the chip itself and splices the card into the middle of a sentence.
    await page.locator('.wiki-article .fc-chip[data-fact="1"]').click();
    await expect(page.locator('.wiki-article .fc-card[data-fc-card="1"]')).toBeVisible();

    const placement = await page.evaluate(() => {
      const card = document.querySelector('.wiki-article .fc-card[data-fc-card="1"]')!;
      const prev = card.previousSibling;
      const next = card.nextElementSibling;
      const BLOCK = /^(P|DIV|UL|OL|LI|TABLE|PRE|BLOCKQUOTE|SECTION|DETAILS|HR|H[1-6])$/;
      return {
        // Everything before the card is the tail of the paragraph's inline run …
        prevText: (prev?.textContent ?? "").trim(),
        prevIsBlock: prev?.nodeType === 1 && BLOCK.test((prev as Element).tagName),
        // … and the next sibling is the block that ended it.
        nextTag: next?.tagName ?? "",
        nextIsBlock: !!next && BLOCK.test(next.tagName),
      };
    });

    // The sentence the chip lives in is complete before the card — a mid-sentence
    // splice would leave this text ending inside the clause instead.
    expect(placement.prevIsBlock).toBe(false);
    expect(placement.prevText.endsWith("misread lab marker.")).toBe(true);
    expect(placement.nextIsBlock).toBe(true);
    expect(placement.nextTag).toBe("H3");
  });

  test("a second chip replaces the open card; close button and Escape both close it", async ({
    page,
  }) => {
    await openFixturePage(page);
    const chip4 = page.locator('.wiki-article .fc-chip[data-fact="4"]');
    const chip7 = page.locator('.wiki-article .fc-chip[data-fact="7"]');

    await chip4.click();
    await chip7.click();
    await expect(page.locator(".wiki-article .fc-card")).toHaveCount(1);
    await expect(page.locator('.wiki-article .fc-card[data-fc-card="7"]')).toBeVisible();
    await expect(chip4).toHaveAttribute("aria-expanded", "false");
    await expect(chip7).toHaveAttribute("aria-expanded", "true");

    // Close affordance on the card.
    await page.locator(".wiki-article .fc-card-close").click();
    await expect(page.locator(".wiki-article .fc-card")).toHaveCount(0);
    await expect(chip7).toHaveAttribute("aria-expanded", "false");

    // Escape closes too — when focus is inside the annotation.
    await chip7.click();
    await expect(page.locator(".wiki-article .fc-card")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator(".wiki-article .fc-card")).toHaveCount(0);
    await expect(chip7).toHaveAttribute("aria-expanded", "false");

    // …but Escape from OUTSIDE the article is somebody else's key: the card stays
    // and focus must not be yanked back into the prose.
    await chip7.click();
    const search = page.locator("#wikiSearch");
    await search.focus();
    await page.keyboard.press("Escape");
    await expect(page.locator(".wiki-article .fc-card")).toHaveCount(1);
    await expect(search).toBeFocused();
  });

  test("the summary strip shows the run date and verdict counts", async ({ page }) => {
    await openFixturePage(page);
    const bar = page.locator(".wiki-article .fc-toolbar");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("Fact-checked");
    await expect(bar).toContainText("2026-07-29");
    await expect(bar).toContainText("6 confirmed");
    await expect(bar).toContainText("1 needs care");
    await expect(bar).toContainText("1 corrected");
  });

  test("the layer toggle hides marks, chips and the appendix, then restores them", async ({
    page,
  }) => {
    await openFixturePage(page);
    const article = page.locator(".wiki-article");
    const toggle = page.locator(".wiki-article .fc-toolbar-toggle");
    const chip1 = page.locator('.wiki-article .fc-chip[data-fact="1"]');
    const appendix = page.locator(".wiki-article .fc-block");
    const counts = page.locator(".wiki-article .fc-toolbar-summary");

    await expect(chip1).toBeVisible();
    await expect(appendix).toBeVisible();
    await expect(counts).toBeVisible();
    // The label IS the state — a toggle button carrying aria-pressed too would
    // announce "Hide fact-check layer, pressed".
    await expect(toggle).toHaveText("Hide fact-check layer");
    await expect(toggle).not.toHaveAttribute("aria-pressed", /.*/);

    await toggle.click();
    await expect(article).toHaveClass(/fc-off/);
    await expect(toggle).toHaveText("Show fact-check layer");
    await expect(chip1).toBeHidden();
    await expect(appendix).toBeHidden();
    // Layer off means OFF: the toolbar's date + counts go with it (only the
    // toggle itself stays reachable).
    await expect(counts).toBeHidden();
    await expect(toggle).toBeVisible();
    // The prose itself is untouched — the article still reads.
    await expect(article).toContainText("stored primarily in skeletal muscle");

    await toggle.click();
    await expect(article).not.toHaveClass(/fc-off/);
    await expect(chip1).toBeVisible();
    await expect(appendix).toBeVisible();
    await expect(counts).toBeVisible();
  });
});

test.describe("Evidence card: a fence inside a claim", () => {
  test("the card's copy button is LIVE, not a cloned corpse", async ({ page, context }) => {
    // `buildCard` clones an appendix section whose fences the article enhancer
    // has ALREADY wrapped. A clone carries the wrapper and the bar but NOT the
    // listeners, so without `unwrapCodeBlockChrome` + a re-enhance the reader
    // gets a Copy button that does nothing, forever — and the first attempt at
    // fixing it (marker-strip only, copied from the CodeTabs idiom) produced
    // TWO stacked bars with the outer one still dead. Both shapes are asserted.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(
      `${BASE}/wiki?wiki=${WIKI_NAME}&relPath=${encodeURIComponent(FENCE_REL_PATH)}`,
      { waitUntil: "domcontentloaded" },
    );
    // NB not a title assertion: `stripTitle` removes an H1 matching the
    // frontmatter title, so the words never appear in the article body.
    await expect(page.locator('.wiki-article .fc-chip[data-fact="1"]')).toBeVisible();

    // Seed the clipboard so "the button did nothing" is distinguishable from
    // "the button copied an empty string".
    await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));

    await page.locator('.wiki-article .fc-chip[data-fact="1"]').click();
    const card = page.locator('.wiki-article .fc-card[data-fc-card="1"]');
    await expect(card).toBeVisible();

    // Exactly one bar and one button — not the nested pair.
    await expect(card.locator(".fence")).toHaveCount(1);
    await expect(card.locator(".fence .fence")).toHaveCount(0);
    await expect(card.locator(".fence-copy")).toHaveCount(1);

    const copy = card.locator(".fence-copy");
    await card.locator(".fence").hover();
    await copy.click();
    await expect(copy).toHaveClass(/is-done/);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(FENCE_CLAIM_CODE);
  });
});

