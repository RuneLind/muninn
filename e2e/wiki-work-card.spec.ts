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
 *  7. **Legible in every theme** — each explicit pick (Light, Dark, Reading,
 *     Light reading) and System under both OS schemes: every element that
 *     paints text, in every state (map, refusal, running, all done, error),
 *     clears 4.5:1 against what is painted behind it.
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
import { paintedMeasure, token } from "./contrast.ts";
import { WIKI_REFETCH_MIN_INTERVAL_MS } from "../src/dashboard/views/components/wiki-refresh.ts";

const PORT = e2ePort("wiki-work-card");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const FRESH = "e2e-wm-fresh";
const STALE = "e2e-wm-stale";
const DONE = "e2e-wm-done";
const NONE = "e2e-wm-none";
const LONG = "e2e-wm-long";
/** Wikis a test mutates on disk: one each, so a failed test leaves no state behind for the next. */
const FLIP = "e2e-wm-flip";
const GROW = "e2e-wm-grow";
const GROW_ERR = "e2e-wm-grow-err";
const GROW_LATE = "e2e-wm-grow-late";
const FB = "e2e-wm-fb";
/** Paints every element the card has: the contrast sweep's wiki. */
const SWEEP = "e2e-wm-sweep";
const LONG_WHY =
  "The two drafts of ⟦plans/alpha.mdx⟧ disagree on the name, the scope and the owner, and the review thread under the second draft has gone quiet for a week, so nobody has decided which of them the next slice builds on.";
const HOUR = 3_600_000;

function md(title: string): string {
  return `---\ntitle: ${title}\n---\n\nBody of ${title}.\n`;
}

type NeedFixture = { title: string; kind: string; why: string; action: string; pages: string[] };

const DEFAULT_NEEDS: NeedFixture[] = [
  { title: "Pick a name for ⟦plans/alpha.mdx⟧", kind: "decision", why: "Two drafts disagree.", action: "Choose one.", pages: ["plans/alpha.mdx"] },
  { title: "Resume beta", kind: "resume", why: "", action: "", pages: ["plans/beta.mdx"] },
];

function mapJson(wiki: string, runAtMs: number, needsYou: NeedFixture[] = DEFAULT_NEEDS): string {
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
    needsYou,
    themes: [],
    efforts: [
      { id: "alpha", name: "Alpha work", aliases: [], oneLine: "The alpha plan.", state: "active", pages: [{ id: "plans/alpha.mdx", role: "plan" }, { id: "plans/gone.mdx", role: "report" }], why: "", confidence: 1, next: "Ship it.", related: [], daily: [] },
      { id: "beta", name: "Beta work", aliases: [], oneLine: "", state: "cooling", pages: [{ id: "plans/beta.mdx", role: "plan" }], why: "", confidence: 1, next: "", related: [], daily: [] },
      { id: "gamma", name: "Gamma work", aliases: [], oneLine: "", state: "shipped", pages: [{ id: "plans/gamma.mdx", role: "plan" }], why: "", confidence: 1, next: "", related: [], daily: [] },
    ],
    loose: [],
  });
}

/** A stale map that renders every part of the card: all six states, a nested
 *  and a part-of sub-effort, an active day, `+N more`, a next step, a
 *  coverage warning, a clamped why and a Needs-you item with page links. */
function sweepMapJson(runAtMs: number): string {
  const m = JSON.parse(mapJson(SWEEP, runAtMs, [
    { title: "Settle ⟦plans/alpha.mdx⟧", kind: "decision", why: LONG_WHY, action: "Pick one draft.", pages: ["plans/beta.mdx", "plans/gamma.mdx"] },
    { title: "Resume beta", kind: "resume", why: "Quiet a week.", action: "", pages: [] },
  ])) as Record<string, unknown> & { coverage: Record<string, unknown> };
  m.coverage.warnings = ["Active pages fell from 90 to 30."];
  const today = new Date().toISOString().slice(0, 10);
  const e = (id: string, state: string, pages: string[], extra: Record<string, unknown> = {}) => ({
    id, name: `${id} work`, aliases: [], oneLine: `The ${id} effort.`, state, pages: pages.map((p) => ({ id: p, role: "plan" })), why: "", confidence: 1, next: "", related: [], daily: [], ...extra,
  });
  m.efforts = [
    e("active", "active", ["plans/alpha.mdx", "plans/p1.mdx", "plans/p2.mdx", "plans/p3.mdx", "plans/p4.mdx", "plans/p5.mdx", "plans/p6.mdx"], { next: "Ship ⟦plans/alpha.mdx⟧.", daily: [{ day: today, commits: 2, sessions: 1 }] }),
    e("nested", "proposed", ["plans/p1.mdx"], { parent: "active" }),
    e("blocked", "blocked", ["plans/beta.mdx"]),
    e("cooling", "cooling", ["plans/beta.mdx"]),
    e("partof", "active", ["plans/gamma.mdx"], { parent: "cooling" }),
    e("quiet", "quiet", ["plans/gamma.mdx"]),
    e("shipped", "shipped", ["plans/gamma.mdx"]),
  ];
  return JSON.stringify(m);
}

let server: ChildProcess | undefined;
const roots: Record<string, string> = {};

async function seedWiki(name: string, runAtMs: number | null, needsYou?: NeedFixture[]): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-${name}-`));
  roots[name] = root;
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, "plans/alpha.mdx"), md("Alpha plan"), "utf8");
  await writeFile(path.join(root, "plans/beta.mdx"), md("Beta plan"), "utf8");
  await writeFile(path.join(root, "plans/gamma.mdx"), md("Gamma plan"), "utf8");
  if (runAtMs !== null) await writeFile(path.join(root, ".work-map.json"), mapJson(name, runAtMs, needsYou), "utf8");
}

test.beforeAll(async () => {
  const now = Date.now();
  await seedWiki(FRESH, now - 2 * HOUR);
  await seedWiki(STALE, now - 30 * HOUR);
  await seedWiki(DONE, now - 3 * HOUR);
  await seedWiki(NONE, null);
  await seedWiki(LONG, now - 2 * HOUR, [{ title: "Settle alpha", kind: "decision", why: LONG_WHY, action: "Pick one draft and close the other.", pages: [] }]);
  await seedWiki(FLIP, now - 2 * HOUR);
  await seedWiki(GROW, null);
  await seedWiki(GROW_ERR, null);
  await seedWiki(GROW_LATE, null);
  await seedWiki(FB, now - 2 * HOUR);
  await seedWiki(SWEEP, null);
  for (let i = 1; i <= 6; i++) await writeFile(path.join(roots[SWEEP]!, `plans/p${i}.mdx`), md(`Page ${i}`), "utf8");
  await writeFile(path.join(roots[SWEEP]!, ".work-map.json"), sweepMapJson(now - 30 * HOUR), "utf8");
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
      WIKI_EXTRA: [FRESH, STALE, DONE, NONE, LONG, FLIP, GROW, GROW_ERR, GROW_LATE, FB, SWEEP].map((n) => `${n}=${roots[n]}`).join(","),
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
  // An inline page link is bounded at rest, not only on hover.
  await expect(card.locator('.wiki-wm-summary a[data-relpath="plans/alpha.mdx"]')).toHaveCSS("text-decoration-line", "underline");
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

test("a long Needs-you why is clamped to two lines and opens from its keyboard control", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await openStart(page, LONG);
  const card = page.locator("#wikiWorkCard");
  const text = card.locator(".wiki-wm-why-text");
  const more = card.locator(".wiki-wm-why-more");
  const lines = () => text.evaluate((el) => Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)));
  expect(await lines()).toBe(2);
  expect(await text.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(text).toHaveAttribute("title", LONG_WHY.replace("⟦plans/alpha.mdx⟧", "Alpha plan"));
  await expect(card.locator(".wiki-wm-action")).toBeVisible();
  await expect(more).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(more).toHaveAttribute("aria-controls", (await text.getAttribute("id"))!);
  await expect(more).toHaveCSS("cursor", "pointer");
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => text.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  expect(await lines()).toBeGreaterThan(2);
  await expect(more).toBeFocused();
  await page.keyboard.press("Space");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  expect(await lines()).toBe(2);
});

test("a why that fits its two lines offers no expand control", async ({ page }) => {
  await openStart(page, FRESH);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator(".wiki-wm-why-text")).toHaveText("Two drafts disagree.");
  await expect(card.locator(".wiki-wm-why-more")).toBeHidden();
  await expect(card.locator(".wiki-wm-why-text")).not.toHaveCSS("cursor", "pointer");
  await expect(card.locator(".wiki-wm-why")).not.toHaveCSS("cursor", "pointer");
});

test("selecting text in an opened why leaves it open", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await openStart(page, LONG);
  const card = page.locator("#wikiWorkCard");
  const text = card.locator(".wiki-wm-why-text");
  await card.locator(".wiki-wm-why-more").click();
  await expect(card.locator(".wiki-wm-why")).toHaveClass(/\bopen\b/);
  const box = (await text.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 4, { steps: 8 });
  await page.mouse.up();
  expect((await page.evaluate(() => String(getSelection()))).length).toBeGreaterThan(20);
  await expect(card.locator(".wiki-wm-why")).toHaveClass(/\bopen\b/);
  await expect(card.locator(".wiki-wm-why-more")).toHaveAttribute("aria-expanded", "true");
  // A plain click on the text does not toggle it either.
  await text.click({ position: { x: 4, y: 4 } });
  await expect(card.locator(".wiki-wm-why")).toHaveClass(/\bopen\b/);
});

test("an opened why and focus on its control survive a ↻ poll repaint", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  let gets = 0;
  await page.route("**/api/wiki/work-map?*", async (route) => {
    gets++;
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: true, lastSuccessAt: Date.now() - 60 * 60_000 } });
  });
  await page.route("**/api/wiki/work-map/refresh*", (route) => route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } }));
  await page.clock.install();
  await openStart(page, LONG);
  const card = page.locator("#wikiWorkCard");
  await card.locator("#wikiWorkMapRefresh").click();
  await expect(page.locator("#wikiWorkMapStatus")).toContainText("Organizing…");
  const more = card.locator(".wiki-wm-why-more");
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() => document.querySelector("#wikiWorkCard .wiki-wm-summary")!.setAttribute("data-before-repaint", ""));
  const n = gets;
  await expect
    .poll(async () => {
      await page.clock.runFor(1_000);
      return gets;
    })
    .toBeGreaterThan(n);
  await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(card.locator(".wiki-wm-why")).toHaveClass(/\bopen\b/);
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

test("a ↻ poll GET that succeeds resets the failure count", async ({ page }) => {
  let polling = false;
  let polls = 0;
  // fail, fail, ok (still pending), fail, fail, then pending for good.
  const plan = ["fail", "fail", "ok", "fail", "fail"];
  await page.route("**/api/wiki/work-map?*", async (route) => {
    const step = polling ? (plan[polls++] ?? "ok") : "ok";
    if (step === "fail") return route.fulfill({ status: 500, json: { error: "boom" } });
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: true, running: false, lastSuccessAt: Date.now() - 60 * 60_000 } });
  });
  await page.route("**/api/wiki/work-map/refresh*", (route) => route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } }));
  await page.clock.install();
  await openStart(page, FRESH);
  const btn = page.locator("#wikiWorkMapRefresh");
  await btn.click();
  await expect(page.locator("#wikiWorkMapStatus")).toContainText("Organizing…");
  polling = true;
  await expect
    .poll(async () => {
      await page.clock.runFor(2_500);
      return polls;
    }, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(plan.length);
  // Let the fifth answer settle; on the fixed code the next poll starts.
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(100);
    await page.clock.runFor(2_500);
  }
  await expect(page.locator("#wikiWorkMapStatus")).toContainText("Organizing…");
  await expect(btn).toBeDisabled();
  expect(polls).toBeGreaterThan(plan.length);
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
  let gets = 0;
  await page.route("**/api/wiki/work-map?*", (route) => {
    gets++;
    return route.fulfill({ status: 400, json: { error: "wiki is required" } });
  });
  await openStart(page, FRESH);
  await expect(page.locator("#wikiWhatsNew")).toContainText("Something changed");
  await expect(page.locator("#wikiWorkCard")).toBeHidden();
  // Longer than the network retry's delay: a refusal is not retried.
  await page.waitForTimeout(2_500);
  expect(gets).toBe(1);
});

test("a work-map GET answered 5xx keeps the card's Retry", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  let gets = 0;
  await page.route("**/api/wiki/work-map?*", (route) => {
    gets++;
    return route.fulfill({ status: 503, json: { error: "down" } });
  });
  await openStart(page, FRESH);
  await expect(page.locator("#wikiWorkCard #wikiWorkMapRetry")).toBeVisible();
  await expect(page.locator("#wikiWhatsNew")).toBeHidden();
  await page.waitForTimeout(2_500);
  expect(gets).toBe(1);
});

test("a work-map GET answered 2xx with a non-JSON body falls back once, without a retry", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  let gets = 0;
  await page.route("**/api/wiki/work-map?*", (route) => {
    gets++;
    return route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>Sign in</body></html>" });
  });
  await openStart(page, FRESH);
  await expect(page.locator("#wikiWhatsNew")).toContainText("Something changed");
  await expect(page.locator("#wikiWorkCard")).toBeHidden();
  await page.waitForTimeout(2_500);
  expect(gets).toBe(1);
});

test("a work-map GET that fails on the network twice falls back to What's new", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  const at: number[] = [];
  await page.route("**/api/wiki/work-map?*", (route) => {
    at.push(Date.now());
    return route.abort();
  });
  await openStart(page, FRESH);
  await expect(page.locator("#wikiWhatsNew")).toContainText("Something changed");
  await expect(page.locator("#wikiWorkCard")).toBeHidden();
  expect(at).toHaveLength(2);
  // The retry waits out a restart blip instead of firing in the same instant.
  expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(1_000);
});

test("after a twice-failed work-map GET, an adopt with a new run time brings the card", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  let gets = 0;
  await page.route("**/api/wiki/work-map?*", (route) => {
    gets++;
    return gets <= 2 ? route.abort() : route.continue();
  });
  await page.clock.install();
  await openStart(page, FB);
  const wn = page.locator("#wikiWhatsNew");
  const card = page.locator("#wikiWorkCard");
  await expect
    .poll(async () => {
      await page.clock.runFor(500);
      return gets;
    })
    .toBe(2);
  await expect(wn).toContainText("Something changed");
  await expect(card).toBeHidden();
  // The same run time: the fallback holds, no new GET.
  await forceAdopt(page, FB);
  expect(gets).toBe(2);
  await expect(wn).toBeVisible();
  // A new run: the card takes the slot back.
  await writeFile(path.join(roots[FB]!, ".work-map.json"), mapJson(FB, Date.now() - HOUR), "utf8");
  await forceAdopt(page, FB);
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await expect(wn).toBeHidden();
  expect(gets).toBe(3);
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

test("an adopt that drops the map brings What's new back, and one that restores it brings the card", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  await page.clock.install();
  const digests = await openStart(page, FLIP);
  const card = page.locator("#wikiWorkCard");
  const wn = page.locator("#wikiWhatsNew");
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  expect(digests).toHaveLength(0);
  await rm(path.join(roots[FLIP]!, ".work-map.json"));
  await forceAdopt(page, FLIP);
  await expect(card).toBeHidden();
  await expect(wn).toContainText("Something changed");
  await forceAdopt(page, FLIP);
  expect(digests).toHaveLength(1);
  await writeFile(path.join(roots[FLIP]!, ".work-map.json"), mapJson(FLIP, Date.now() - HOUR), "utf8");
  await forceAdopt(page, FLIP);
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await expect(wn).toBeHidden();
  expect(digests).toHaveLength(1);
});

test("a map that comes and goes on adopts keeps What's new's in-flight ↻", async ({ page }) => {
  let release: (() => Promise<void>) | null = null;
  await page.route("**/api/wiki/digest*", (route) => {
    if (!route.request().url().includes("refresh=1")) return route.fulfill({ json: DIGEST_OK });
    release = () => route.fulfill({ json: DIGEST_OK });
  });
  await page.clock.install();
  const digests = await openStart(page, GROW);
  const card = page.locator("#wikiWorkCard");
  const wn = page.locator("#wikiWhatsNew");
  const spin = page.locator("#wikiWhatsNewRefresh");
  await spin.click();
  await expect(spin).toBeDisabled();
  await expect.poll(() => release !== null).toBe(true);
  await writeFile(path.join(roots[GROW]!, ".work-map.json"), mapJson(GROW, Date.now() - HOUR), "utf8");
  await forceAdopt(page, GROW);
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await expect(wn).toBeHidden();
  await rm(path.join(roots[GROW]!, ".work-map.json"));
  await forceAdopt(page, GROW);
  await expect(card).toBeHidden();
  await expect(wn).toBeVisible();
  await expect(spin).toBeDisabled();
  await release!();
  await expect(spin).toBeEnabled();
  await expect(card).toBeHidden();
  expect(digests).toHaveLength(2);
});

test("a What's new ↻ that lands while the card holds the slot stays hidden until the map goes", async ({ page }) => {
  let release: (() => Promise<void>) | null = null;
  const fresh = { digest: { ...DIGEST_OK.digest, html: "<ul><li>Fresher news</li></ul>" } };
  await page.route("**/api/wiki/digest*", (route) => {
    if (!route.request().url().includes("refresh=1")) return route.fulfill({ json: DIGEST_OK });
    release = () => route.fulfill({ json: fresh });
  });
  await page.clock.install();
  await openStart(page, GROW_LATE);
  const card = page.locator("#wikiWorkCard");
  const wn = page.locator("#wikiWhatsNew");
  await page.locator("#wikiWhatsNewRefresh").click();
  await expect.poll(() => release !== null).toBe(true);
  await writeFile(path.join(roots[GROW_LATE]!, ".work-map.json"), mapJson(GROW_LATE, Date.now() - HOUR), "utf8");
  await forceAdopt(page, GROW_LATE);
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await release!();
  await expect(wn).toContainText("Fresher news");
  await expect(wn).toBeHidden();
  await expect(card).toBeVisible();
  await rm(path.join(roots[GROW_LATE]!, ".work-map.json"));
  await forceAdopt(page, GROW_LATE);
  await expect(wn).toBeVisible();
  await expect(wn).toContainText("Fresher news");
  await expect(page.locator("#wikiWhatsNewRefresh")).toBeEnabled();
});

test("a map that comes and goes on adopts keeps What's new's error and asks for the digest once", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: { digest: null, error: "connector busy" } }));
  await page.clock.install();
  const digests = await openStart(page, GROW_ERR);
  const card = page.locator("#wikiWorkCard");
  const wn = page.locator("#wikiWhatsNew");
  await expect(wn).toContainText("connector busy");
  await writeFile(path.join(roots[GROW_ERR]!, ".work-map.json"), mapJson(GROW_ERR, Date.now() - HOUR), "utf8");
  await forceAdopt(page, GROW_ERR);
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await expect(wn).toBeHidden();
  await rm(path.join(roots[GROW_ERR]!, ".work-map.json"));
  await forceAdopt(page, GROW_ERR);
  await expect(card).toBeHidden();
  await expect(wn).toContainText("connector busy");
  await expect(wn.locator("#wikiWhatsNewRetry")).toBeVisible();
  expect(digests).toHaveLength(1);
});

test("focus on a ✓ or a page link survives a ↻ poll repaint", async ({ page }) => {
  let gets = 0;
  await page.route("**/api/wiki/work-map?*", async (route) => {
    gets++;
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: true, lastSuccessAt: Date.now() - 60 * 60_000 } });
  });
  await page.route("**/api/wiki/work-map/refresh*", (route) => route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } }));
  await page.clock.install();
  await openStart(page, FRESH);
  const card = page.locator("#wikiWorkCard");
  await card.locator("#wikiWorkMapRefresh").click();
  await expect(page.locator("#wikiWorkMapStatus")).toContainText("Organizing…");
  const repaint = async () => {
    await page.evaluate(() => document.querySelector("#wikiWorkCard .wiki-wm-summary")!.setAttribute("data-before-repaint", ""));
    const n = gets;
    await expect
      .poll(async () => {
        await page.clock.runFor(1_000);
        return gets;
      })
      .toBeGreaterThan(n);
    await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
  };
  const done = card.locator('[data-wm-done="1"]');
  await done.focus();
  await repaint();
  await expect(done).toBeFocused();
  const link = card.locator('.wiki-wm-link[data-relpath="plans/alpha.mdx"]').nth(2);
  await link.focus();
  await repaint();
  await expect(link).toBeFocused();
});

test("a ✓ pressed from the keyboard moves focus to the next ✓, then to the restore control", async ({ page }) => {
  await openStart(page, FRESH);
  const card = page.locator("#wikiWorkCard");
  await card.locator('[data-wm-done="0"]').focus();
  await page.keyboard.press("Enter");
  await expect(card.locator("[data-wm-need]")).toHaveCount(1);
  await expect(card.locator('[data-wm-done="1"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card.locator("[data-wm-need]")).toHaveCount(0);
  await expect(card.locator("#wikiWorkMapRestore")).toBeFocused();
});

/** Every theme a reader can end up in: an explicit pick stored under
 *  `muninn-theme` (a base or a palette), or nothing stored and the OS scheme. */
const THEMES: { label: string; stored: string | null; scheme: "light" | "dark" }[] = [
  { label: "Light", stored: "light", scheme: "dark" },
  { label: "Dark", stored: "dark", scheme: "light" },
  { label: "Reading mode", stored: "reading", scheme: "light" },
  { label: "Light reading mode", stored: "paper-light", scheme: "dark" },
  { label: "System light", stored: null, scheme: "light" },
  { label: "System dark", stored: null, scheme: "dark" },
];

/** Every element in the card that paints its own text, measured where it sits
 *  (no `.first()`: one class can sit on two boxes). Returns the ratios and the
 *  classes of every visible element, for the coverage check. */
async function sweepCard(page: Page, label: string): Promise<{ low: string[]; min: number; classes: string[] }> {
  const card = page.locator("#wikiWorkCard");
  const measure = await paintedMeasure(page);
  const { what, ratios, classes } = await card.evaluate((root, measure) => {
    const what: string[] = [];
    const ratios: number[] = [];
    const classes: string[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      if (!el.checkVisibility({ visibilityProperty: true })) continue;
      classes.push(...Array.from(el.classList));
      if (!Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())) continue;
      what.push(`${el.tagName.toLowerCase()}.${Array.from(el.classList).join(".")} "${el.textContent!.trim().slice(0, 30)}"`);
      ratios.push(measure(el, false, false));
    }
    return { what, ratios, classes };
  }, measure);
  expect(what.length, `${label}: nothing to measure`).toBeGreaterThan(0);
  const low = ratios.flatMap((r, i) => (r < 4.5 ? [`${label}: ${what[i]} ${r.toFixed(2)}`] : []));
  const min = Math.min(...ratios);
  return { low, min, classes };
}

/** The `.wiki-wm-*` / `.wm-state-*` classes the stylesheet styles: each must be
 *  painted in some swept state, or the sweep never measured it. */
async function styledCardClasses(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        const sel = (rule as CSSStyleRule).selectorText;
        if (sel) for (const m of sel.matchAll(/\.((?:wiki-wm|wm-state)-[\w-]+)/g)) out.add(m[1]!);
      }
    }
    return [...out].sort();
  });
}

for (const theme of THEMES) {
  test(`legible in the ${theme.label} theme, in every state the card paints`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: theme.scheme });
    await page.addInitScript((v) => {
      if (v === null) localStorage.removeItem("muninn-theme");
      else localStorage.setItem("muninn-theme", v);
    }, theme.stored);
    await page.route("**/api/wiki/work-map?*", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      await route.fulfill({ json: { ...body, organizable: true, lastSuccessAt: Date.now() - 31 * HOUR, lastAttempt: { at: Date.now() - 10 * 60_000, outcome: "failed", error: "model timed out" } } });
    });
    let posts = 0;
    await page.route("**/api/wiki/work-map/refresh*", (route) =>
      ++posts === 1
        ? route.fulfill({ status: 429, json: { error: "ran recently", lastSuccessAt: Date.now() - 5 * 60_000, retryAfterMs: 5 * 60_000 } })
        : route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } }),
    );
    await page.clock.install();
    await openStart(page, SWEEP);
    const card = page.locator("#wikiWorkCard");
    await expect(card.locator(".wiki-wm-stale")).toBeVisible();
    expect(await card.locator(".wiki-wm-effort-name").first().evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--text-primary"));
    expect(await card.locator(".wiki-wm-summary a").first().evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--accent-light"));
    const low: string[] = [];
    const seen = new Set<string>();
    const mins: number[] = [];
    const sweep = async (label: string) => {
      const r = await sweepCard(page, label);
      low.push(...r.low);
      mins.push(r.min);
      r.classes.forEach((c) => seen.add(c));
    };
    // The map: every lane open, the long why opened, the last attempt's warning.
    await card.evaluate((root) => root.querySelectorAll("details").forEach((d) => (d.open = true)));
    await card.locator(".wiki-wm-why-more:visible").click();
    await expect(card.locator(".wiki-wm-why.open")).toHaveCount(1);
    await expect(card.locator("#wikiWorkMapStatus.warn")).toBeVisible();
    await sweep("map");
    // ↻ refused (warn), then running (plain), ↻ disabled.
    await card.locator("#wikiWorkMapRefresh").click();
    await expect(card.locator("#wikiWorkMapStatus")).toHaveText("Ran 5 min ago — try again in 5 min.");
    await sweep("refusal");
    const posted = page.waitForResponse("**/api/wiki/work-map/refresh*");
    await card.locator("#wikiWorkMapRefresh").click();
    await posted;
    await expect(card.locator("#wikiWorkMapStatus")).toContainText("Organizing…");
    await page.waitForTimeout(200);
    await sweep("running");
    // Every item done: the restore control and the empty line.
    while ((await card.locator("[data-wm-done]").count()) > 0) await card.locator("[data-wm-done]").first().click();
    await expect(card.locator(".wiki-wm-empty")).toBeVisible();
    await expect(card.locator("#wikiWorkMapRestore")).toBeVisible();
    await sweep("empty");
    // The GET answered 5xx: the card's error and Retry.
    await page.unroute("**/api/wiki/work-map?*");
    await page.route("**/api/wiki/work-map?*", (route) => route.fulfill({ status: 503, json: { error: "down" } }));
    await page.reload();
    await expect(card.locator("#wikiWorkMapRetry")).toBeVisible();
    await sweep("error");
    expect((await styledCardClasses(page)).filter((c) => !seen.has(c))).toEqual([]);
    console.log(`contrast min ${theme.label}: ${Math.min(...mins).toFixed(2)} (${["map", "refusal", "running", "empty", "error"].map((l, i) => `${l} ${mins[i]!.toFixed(2)}`).join(", ")})`);
    expect(low).toEqual([]);
  });
}
