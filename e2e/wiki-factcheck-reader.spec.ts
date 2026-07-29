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
 * ENV PREREQUISITE + TELEGRAM: identical to `wiki-integrate.spec.ts` — a working
 * `.env` at the repo root, and every `TELEGRAM_BOT_TOKEN_*` blanked so this
 * process can't 409-fight the running production jarvis's long-poller.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PORT = 3022;
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI_NAME = "e2e-factcheck";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const REL_PATH = "creatine-loading.mdx";
const FIXTURE = path.join(REPO_ROOT, "src/wiki/__fixtures__/factcheck-annotated-page.mdx");

let root: string;
let server: ChildProcess | undefined;

/** Every `TELEGRAM_BOT_TOKEN_*` name we can see, mapped to "" — see the header. */
function blankTelegramTokens(): Record<string, string> {
  const names = new Set(Object.keys(process.env).filter((k) => k.startsWith("TELEGRAM_BOT_TOKEN_")));
  try {
    for (const line of readFileSync(path.join(REPO_ROOT, ".env"), "utf8").split("\n")) {
      const m = /^\s*(TELEGRAM_BOT_TOKEN_[A-Z0-9_]+)\s*=/i.exec(line);
      if (m) names.add(m[1]!);
    }
  } catch {
    /* no .env visible — the inherited names are all there is */
  }
  const blanked: Record<string, string> = {};
  for (const n of names) {
    blanked[n] = "";
    process.env[n] = "";
  }
  return blanked;
}

/**
 * Console errors raised by OUR code. Two unrelated sources are filtered, both
 * artifacts of the harness rather than the feature: the fixture carries a
 * ```mermaid fence, so the reader injects the pinned mermaid CDN script (a
 * sandboxed/offline box logs a resource-load failure for it), and the throwaway
 * wiki has no huginn collections, so the reader's lazy `/api/wiki/similar` fetch
 * 404s by design. Uncaught page exceptions are collected separately and are
 * NEVER filtered.
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
    if (/mermaid|jsdelivr/i.test(text)) return;
    if (lastFailedUrl && /Failed to load resource/i.test(text) && /api\/wiki\/similar/.test(lastFailedUrl)) return;
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
  await writeFile(path.join(root, "log.md"), "# Log\n", "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...blankTelegramTokens(),
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

    // Escape closes too.
    await chip7.click();
    await expect(page.locator(".wiki-article .fc-card")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator(".wiki-article .fc-card")).toHaveCount(0);
    await expect(chip7).toHaveAttribute("aria-expanded", "false");
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

    await expect(chip1).toBeVisible();
    await expect(appendix).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    await toggle.click();
    await expect(article).toHaveClass(/fc-off/);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(chip1).toBeHidden();
    await expect(appendix).toBeHidden();
    // The prose itself is untouched — the article still reads.
    await expect(article).toContainText("stored primarily in skeletal muscle");

    await toggle.click();
    await expect(article).not.toHaveClass(/fc-off/);
    await expect(chip1).toBeVisible();
    await expect(appendix).toBeVisible();
  });
});
