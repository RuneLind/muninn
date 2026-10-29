/**
 * The Your work card (plan `muninn-wiki-work-map`, P2) as wired into the /wiki
 * start view.
 *
 * The rendering rules are unit-tested (`wiki-work-card.test.ts`); what only a
 * real page can hold:
 *
 *  1. **The slot choice.** A wiki whose listing carries `workMap` shows the
 *     card and makes NO `/api/wiki/digest` request (What's new's model call
 *     stops there); a wiki without a map still shows What's new.
 *  2. **The card against a seeded `.work-map.json`**: its age, coverage, a
 *     marker to a gone page as plain text, the stale mark past 26 h, ↻ hidden
 *     when the GET says not organizable.
 *  3. **✓ dismiss persists across a reload and clears when `runAt` changes** —
 *     the localStorage half and the listing's mtime-cached `runAt`.
 *  4. **↻'s refusal copy**, against a stubbed GET (`organizable: true`) and a
 *     stubbed 429: no run is started, so no model call.
 *  5. **A background adopt leaves the start cards alone**: a no-map wiki's
 *     digest is asked for no more often than before and its in-flight ↻ stays
 *     disabled; a lane the reader opened stays open across a repaint.
 *  6. **A ↻ poll whose GET keeps failing settles** and re-enables ↻; a first
 *     GET answered 4xx, or failing on the network twice, yields What's new.
 *     ✓ lasts the page's life when localStorage throws.
 *  7. **Legible in both themes**: text colours resolve to their tokens (read on
 *     a body probe) and clear 4.5:1 against what is painted behind them.
 *
 * One muninn on its own port over four temp wikis. `SCHEDULER_ENABLED=false`
 * keeps the work-map loop off and every wiki not organizable. No model calls.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { paintedContrast, token } from "./contrast.ts";
import { WIKI_REFETCH_MIN_INTERVAL_MS } from "../src/dashboard/views/components/wiki-refresh.ts";

const PORT = e2ePort("wiki-work-card");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const FRESH = "e2e-wm-fresh";
const STALE = "e2e-wm-stale";
const DONE = "e2e-wm-done";
const NONE = "e2e-wm-none";
const HOUR = 3_600_000;

function md(title: string): string {
  return `---\ntitle: ${title}\n---\n\nBody of ${title}.\n`;
}

function mapJson(wiki: string, runAtMs: number): string {
  return JSON.stringify({
    version: 1,
    wiki,
    runAtMs,
    model: "test-model",
    coverage: {
      sessionsSinceMs: runAtMs - 8 * 24 * HOUR,
      sessionsAsOfMs: runAtMs,
      touchWindowDays: 28,
      activePages: 3,
      threads: 2,
      logEntries: 120,
      logEntriesInWindow: 150,
      digestChars: 4000,
      metadataFilter: { degraded: false },
      warnings: [],
    },
    summary: "Alpha moves on ⟦plans/alpha.mdx⟧; the old ⟦plans/gone.mdx⟧ was removed.",
    needsYou: [
      { title: "Pick a name for ⟦plans/alpha.mdx⟧", kind: "decision", why: "Two drafts disagree.", action: "Choose one.", pages: ["plans/alpha.mdx"] },
      { title: "Resume beta", kind: "resume", why: "", action: "", pages: ["plans/beta.mdx"] },
    ],
    themes: [],
    efforts: [
      { id: "alpha", name: "Alpha work", aliases: [], oneLine: "The alpha plan.", state: "active", pages: [{ id: "plans/alpha.mdx", role: "plan" }, { id: "plans/gone.mdx", role: "report" }], why: "", confidence: 1, next: "Ship it.", related: [], daily: [] },
      { id: "beta", name: "Beta work", aliases: [], oneLine: "", state: "cooling", pages: [{ id: "plans/beta.mdx", role: "plan" }], why: "", confidence: 1, next: "", related: [], daily: [] },
      { id: "gamma", name: "Gamma work", aliases: [], oneLine: "", state: "shipped", pages: [{ id: "plans/gamma.mdx", role: "plan" }], why: "", confidence: 1, next: "", related: [], daily: [] },
    ],
    loose: [],
  });
}

let server: ChildProcess | undefined;
const roots: Record<string, string> = {};

async function seedWiki(name: string, runAtMs: number | null): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-${name}-`));
  roots[name] = root;
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, "plans/alpha.mdx"), md("Alpha plan"), "utf8");
  await writeFile(path.join(root, "plans/beta.mdx"), md("Beta plan"), "utf8");
  await writeFile(path.join(root, "plans/gamma.mdx"), md("Gamma plan"), "utf8");
  if (runAtMs !== null) await writeFile(path.join(root, ".work-map.json"), mapJson(name, runAtMs), "utf8");
}

test.beforeAll(async () => {
  const now = Date.now();
  await seedWiki(FRESH, now - 2 * HOUR);
  await seedWiki(STALE, now - 30 * HOUR);
  await seedWiki(DONE, now - 3 * HOUR);
  await seedWiki(NONE, null);
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WORK_MAP_WIKIS: "",
      WIKI_DIR: "",
      WIKI_EXTRA: [FRESH, STALE, DONE, NONE].map((n) => `${n}=${roots[n]}`).join(","),
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/wiki/pages?wiki=${NONE}`);
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
  for (const r of Object.values(roots)) await rm(r, { recursive: true, force: true });
});

/** Open a wiki's start view, recording every `/api/wiki/digest` request. */
async function openStart(page: Page, wiki: string): Promise<string[]> {
  const digests: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/wiki/digest") digests.push(r.url());
  });
  await page.goto(`${BASE}/wiki?wiki=${wiki}`);
  await expect(page.locator(".wiki-start")).toBeVisible();
  return digests;
}

test("a wiki with a map shows the card and never asks for the digest", async ({ page }) => {
  const digests = await openStart(page, FRESH);
  const card = page.locator("#wikiWorkCard");
  await expect(card).toBeVisible();
  await expect(card.locator(".wiki-wn-title")).toHaveText("Your work");
  await expect(card.locator(".wiki-wm-age")).toHaveText("organized 2 h ago");
  await expect(card.locator(".wiki-wm-stale")).toHaveCount(0);
  await expect(card.locator(".wiki-wm-coverage")).toContainText("3 active pages · 2 threads · log: the newest 120 of 150 shown");
  // A live marker is a reader link; a marker to a gone page is plain text.
  await expect(card.locator('.wiki-wm-summary a[data-relpath="plans/alpha.mdx"]')).toHaveText("Alpha plan");
  await expect(card.locator('.wiki-wm-summary a[data-relpath="plans/gone.mdx"]')).toHaveCount(0);
  await expect(card.locator(".wiki-wm-summary")).toContainText("the old gone was removed");
  // Lanes: Moving open, the other two closed.
  await expect(card.locator('[data-wm-lane="moving"]')).toHaveAttribute("open", "");
  await expect(card.locator('[data-wm-lane="cooling"]')).not.toHaveAttribute("open", "");
  await expect(card.locator('[data-wm-lane="quiet"]')).not.toHaveAttribute("open", "");
  // Not organizable on this instance: no ↻.
  await expect(card.locator("#wikiWorkMapRefresh")).toHaveCount(0);
  await expect(page.locator("#wikiWhatsNew")).toBeHidden();
  // Give a late digest fetch the chance to happen before asserting it did not.
  await page.waitForTimeout(500);
  expect(digests).toEqual([]);
  // A page link opens the page in the reader.
  await card.locator('.wiki-wm-summary a[data-relpath="plans/alpha.mdx"]').click();
  await expect(page.locator(".wiki-start")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("relPath")).toBe("plans/alpha.mdx");
});

test("a map older than 26 h carries the stale mark", async ({ page }) => {
  await openStart(page, STALE);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator(".wiki-wm-age")).toHaveText("organized 30 h ago");
  await expect(card.locator(".wiki-wm-stale")).toHaveText("stale");
});

test("a wiki without a map still renders What's new", async ({ page }) => {
  // The digest is stubbed at the network boundary: no model call.
  await page.route("**/api/wiki/digest*", (route) =>
    route.fulfill({
      json: { digest: { bullets: "- x", html: "<ul><li>Something changed</li></ul>", generatedAt: Date.now(), logMtimeMs: 0, entryCount: 1, fromDate: "2026-10-28", toDate: "2026-10-29" } },
    }),
  );
  const listing = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${NONE}`)).json()) as Record<string, unknown>;
  expect("workMap" in listing).toBe(false);
  const digests = await openStart(page, NONE);
  await expect(page.locator("#wikiWhatsNew")).toBeVisible();
  await expect(page.locator("#wikiWhatsNew")).toContainText("Something changed");
  await expect(page.locator("#wikiWorkCard")).toBeHidden();
  expect(digests.length).toBeGreaterThan(0);
});

let lateN = 0;
/** Force a background listing adopt: a page lands on disk, the client throttle
 *  passes, the tab regains focus — an unchanged listing is never adopted. */
async function forceAdopt(page: Page, wiki: string): Promise<void> {
  const title = `Late page ${++lateN}`;
  await writeFile(path.join(roots[wiki]!, `late-${lateN}.md`), md(title), "utf8");
  await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#wikiList")).toContainText(title);
  await page.waitForTimeout(300);
}

test("a no-map wiki asks for the digest no more often across adopts after a digest error", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: { digest: null, error: "connector busy" } }));
  await page.clock.install();
  const digests = await openStart(page, NONE);
  const wn = page.locator("#wikiWhatsNew");
  await expect(wn).toContainText("connector busy");
  expect(digests).toHaveLength(1);
  await forceAdopt(page, NONE);
  await forceAdopt(page, NONE);
  expect(digests).toHaveLength(1);
  await expect(wn).toContainText("connector busy");
  await expect(wn.locator("#wikiWhatsNewRetry")).toBeVisible();
});

test("What's new's in-flight ↻ stays disabled across an adopt", async ({ page }) => {
  const digest = { bullets: "- x", html: "<ul><li>Something changed</li></ul>", generatedAt: Date.now(), logMtimeMs: 0, entryCount: 1, fromDate: "2026-10-28", toDate: "2026-10-29" };
  let release: (() => Promise<void>) | null = null;
  await page.route("**/api/wiki/digest*", (route) => {
    if (!route.request().url().includes("refresh=1")) return route.fulfill({ json: { digest } });
    release = () => route.fulfill({ json: { digest } });
  });
  await page.clock.install();
  await openStart(page, NONE);
  const spin = page.locator("#wikiWhatsNewRefresh");
  await expect(spin).toBeEnabled();
  await spin.click();
  await expect(spin).toBeDisabled();
  await expect.poll(() => release !== null).toBe(true);
  await forceAdopt(page, NONE);
  await expect(spin).toBeDisabled();
  await expect(spin).toHaveClass(/spinning/);
  await release!();
  await expect(spin).toBeEnabled();
});

test("a lane the reader opened stays open across a repaint", async ({ page }) => {
  await openStart(page, FRESH);
  const card = page.locator("#wikiWorkCard");
  const cooling = card.locator('[data-wm-lane="cooling"]');
  await cooling.locator("summary").click();
  await expect(cooling).toHaveAttribute("open", "");
  // ✓ repaints the card.
  await card.locator('[data-wm-done="0"]').click();
  await expect(card.locator("[data-wm-need]")).toHaveCount(1);
  await expect(cooling).toHaveAttribute("open", "");
  // A start-tab switch rebuilds the card's slot.
  await page.locator('.wiki-tab[data-tab="timeline"]').click();
  await page.locator('.wiki-tab[data-tab="hubs"]').click();
  await expect(cooling).toHaveAttribute("open", "");
  await expect(card.locator('[data-wm-lane="quiet"]')).not.toHaveAttribute("open", "");
  // The reader can close the lane that starts open, and it stays closed.
  await card.locator('[data-wm-lane="moving"] summary').click();
  await card.locator("#wikiWorkMapRestore").click();
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await expect(card.locator('[data-wm-lane="moving"]')).not.toHaveAttribute("open", "");
});

test("a ↻ poll whose GET keeps failing settles and re-enables ↻", async ({ page }) => {
  let failing = false;
  let fails = 0;
  await page.route("**/api/wiki/work-map?*", async (route) => {
    if (failing) {
      fails++;
      return route.fulfill({ status: 500, json: { error: "boom" } });
    }
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: true, lastSuccessAt: Date.now() - 60 * 60_000 } });
  });
  await page.route("**/api/wiki/work-map/refresh*", (route) => route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } }));
  await page.clock.install();
  await openStart(page, FRESH);
  const btn = page.locator("#wikiWorkMapRefresh");
  await btn.click();
  await expect(page.locator("#wikiWorkMapStatus")).toContainText("Organizing…");
  failing = true;
  // Advance in small steps: a poll is scheduled only once the POST's body is read.
  await expect
    .poll(async () => {
      await page.clock.runFor(2_500);
      return fails;
    }, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(3);
  await expect(page.locator("#wikiWorkMapStatus")).toHaveText("Couldn’t check on the re-organize — reload to see the new map.");
  await expect(btn).toBeEnabled();
});

test("✓ dismiss survives a reload and clears when the run time changes", async ({ page }) => {
  await openStart(page, DONE);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await card.locator('[data-wm-done="0"]').click();
  await expect(card.locator("[data-wm-need]")).toHaveCount(1);
  await expect(card.locator("#wikiWorkMapRestore")).toHaveText("1 done · show");
  await page.reload();
  await expect(card.locator(".wiki-wm-need-title")).toHaveText(["Resume beta"]);
  // A new run: same items, new runAt — the next run starts clean.
  await writeFile(path.join(roots[DONE]!, ".work-map.json"), mapJson(DONE, Date.now() - HOUR), "utf8");
  await page.reload();
  await expect(card.locator(".wiki-wm-age")).toHaveText("organized 1 h ago");
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
});

test("↻ shows when organizable and states a 429 refusal", async ({ page }) => {
  await page.route("**/api/wiki/work-map?*", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: true, lastSuccessAt: Date.now() - 5 * 60_000 } });
  });
  let posted: { contentType: string | null; url: string } | null = null;
  await page.route("**/api/wiki/work-map/refresh*", (route) => {
    posted = { contentType: route.request().headers()["content-type"] ?? null, url: route.request().url() };
    return route.fulfill({ status: 429, json: { error: "ran recently", lastSuccessAt: Date.now() - 5 * 60_000, retryAfterMs: 5 * 60_000 } });
  });
  await openStart(page, FRESH);
  const btn = page.locator("#wikiWorkMapRefresh");
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute("title", "Re-organize — last run 5 min ago");
  await btn.click();
  await expect(page.locator("#wikiWorkMapStatus")).toHaveText("Ran 5 min ago — try again in 5 min.");
  // The repaint keeps focus on ↻.
  await expect(btn).toBeFocused();
  expect(posted).not.toBeNull();
  expect(posted!.contentType).toContain("application/json");
  expect(posted!.url).not.toContain("force");
});

const DIGEST_OK = { digest: { bullets: "- x", html: "<ul><li>Something changed</li></ul>", generatedAt: Date.now(), logMtimeMs: 0, entryCount: 1, fromDate: "2026-10-28", toDate: "2026-10-29" } };

test("a work-map GET the instance refuses (4xx) falls back to What's new", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  await page.route("**/api/wiki/work-map?*", (route) => route.fulfill({ status: 400, json: { error: "wiki is required" } }));
  await openStart(page, FRESH);
  await expect(page.locator("#wikiWhatsNew")).toContainText("Something changed");
  await expect(page.locator("#wikiWorkCard")).toBeHidden();
});

test("a work-map GET that fails on the network twice falls back to What's new", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  let gets = 0;
  await page.route("**/api/wiki/work-map?*", (route) => {
    gets++;
    return route.abort();
  });
  await openStart(page, FRESH);
  await expect(page.locator("#wikiWhatsNew")).toContainText("Something changed");
  await expect(page.locator("#wikiWorkCard")).toBeHidden();
  expect(gets).toBe(2);
});

test("✓ dismiss lasts the page's life when storage throws", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
  });
  await openStart(page, FRESH);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await card.locator('[data-wm-done="0"]').click();
  await expect(card.locator("[data-wm-need]")).toHaveCount(1);
  // A start-tab switch repaints the card from the done store.
  await page.locator('.wiki-tab[data-tab="timeline"]').click();
  await page.locator('.wiki-tab[data-tab="hubs"]').click();
  await expect(card.locator("[data-wm-need]")).toHaveCount(1);
  await card.locator("#wikiWorkMapRestore").click();
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
});

for (const scheme of ["light", "dark"] as const) {
  test(`legible in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openStart(page, FRESH);
    const card = page.locator("#wikiWorkCard");
    await expect(card).toBeVisible();
    const name = card.locator(".wiki-wm-effort-name").first();
    const link = card.locator(".wiki-wm-summary a").first();
    const coverage = card.locator(".wiki-wm-coverage");
    expect(await name.evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--text-primary"));
    expect(await link.evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--accent-light"));
    expect(await coverage.evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--text-dim"));
    for (const loc of [name, link, card.locator(".wiki-wm-summary"), card.locator(".wiki-wm-why").first()]) {
      expect(await paintedContrast(loc)).toBeGreaterThanOrEqual(4.5);
    }
    // The dimmer meta lines are held to the large-text/UI floor.
    for (const loc of [coverage, card.locator(".wiki-wm-age")]) {
      expect(await paintedContrast(loc)).toBeGreaterThanOrEqual(3);
    }
  });
}
