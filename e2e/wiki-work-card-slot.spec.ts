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
 *  7. **A page declared after the run (P6)** joins its effort on a listing
 *     refresh though the run did not move: its step on the board, and first on
 *     the effort page.
 *
 * One muninn on its own port over the temp wikis `wiki-work-card-fixture.ts`
 * seeds. `SCHEDULER_ENABLED=false` keeps the work-map loop off and every wiki
 * not organizable. No model calls.
 */

import { test, expect, type Page } from "@playwright/test";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { e2ePort } from "./ports.ts";
import { token } from "./contrast.ts";
import { WIKI_REFETCH_MIN_INTERVAL_MS } from "../src/dashboard/views/components/wiki-refresh.ts";
import {
  FRESH,
  STALE,
  DONE,
  NONE,
  LONG,
  FLIP,
  GROW,
  GROW_ERR,
  GROW_LATE,
  FB,
  P_LOAD,
  P_LATE,
  P_LATE5,
  P_POST,
  P_POLL,
  P_FOCUS,
  P_DUP,
  P_WHY,
  DECL,
  BOARD,
  LONG_WHY,
  HOUR,
  WHY_CLAMPED_AT,
  WHY_FITS_AT,
  mapJson,
  roots,
  openStart,
  openSettled,
  forceAdopt,
  boardCard,
  pressPoint,
  DIGEST_OK,
  organizable,
  useWorkCardServer,
} from "./wiki-work-card-fixture.ts";

const PORT = e2ePort("wiki-work-card-slot");
const BASE = `http://127.0.0.1:${PORT}`;
useWorkCardServer(PORT);

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
  // An effort name is a link and reads as one at rest, not only on hover.
  await expect(card.locator('a.wiki-wm-effort-name[data-effort-link="alpha"]')).toHaveCSS("text-decoration-line", "underline");
  // The columns: Waiting on you and Moving open, the other three folded.
  await expect(card.locator("details.wiki-wm-col")).toHaveCount(5);
  await expect(card.locator('[data-wm-lane="you"]')).toHaveAttribute("open", "");
  await expect(card.locator('[data-wm-lane="moving"]')).toHaveAttribute("open", "");
  for (const id of ["cooling", "quiet", "shipped"]) await expect(card.locator(`[data-wm-lane="${id}"]`)).not.toHaveAttribute("open", "");
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
  await openSettled(page, LONG);
  const card = page.locator("#wikiWorkCard");
  const text = card.locator(".wiki-wm-why-text");
  const more = card.locator(".wiki-wm-why-more");
  const lines = () => text.evaluate((el) => Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)));
  await expect.poll(lines).toBe(2);
  await expect.poll(() => text.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
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
  await expect.poll(lines).toBeGreaterThan(2);
  await expect(more).toBeFocused();
  await page.keyboard.press("Space");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect.poll(lines).toBe(2);
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
  // Settled so this test is about the why alone: a checks answer waiting on a selection has its own tests.
  await openSettled(page, LONG);
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
  await openSettled(page, LONG);
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

test("a page declared after the load joins its effort on a listing refresh: its step on the board, the page first on the effort page (P6)", async ({ page }) => {
  await page.clock.install();
  await openStart(page, DECL);
  const alpha = page.locator('#wikiWorkCard .wiki-wm-effort[data-effort-id="alpha"]');
  await expect(alpha.locator(".wiki-wm-pills")).toHaveCount(0);
  // The run does not move: only the listing learns of the declaration.
  await writeFile(path.join(roots[DECL]!, "plans/declared-today.mdx"), `---\ntitle: Declared today\neffort: alpha\n---\n\n<NextMoves>\n\n<Lane kind="you">\n\n- One\n\n</Lane>\n\n</NextMoves>\n`, "utf8");
  await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#wikiList")).toContainText("Declared today");
  // On the board without a reload, and one click from its page.
  await expect(alpha.locator(".wiki-wm-pill")).toHaveText(["1 step"]);
  await alpha.locator("a.wiki-wm-effort-name").click();
  await expect(page.locator(".wiki-effort a[data-relpath]").first()).toHaveText("Declared today");
});

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
  await openSettled(page, FRESH);
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
  const link = card.locator('.wiki-wm-link[data-relpath="plans/alpha.mdx"]').nth(1);
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

// ── Class check (round 3): one slot state, one focus resolver, card CSS keeps
// its interactive states. The slot transitions are unit-tested in
// `wiki-start-slot.test.ts`; these pin the wiring.

/** Hold the first `/api/wiki/work-map` GET until `release` is called. */
async function holdFirstGet(page: Page, opts: { status?: number } = {}) {
  const st = { gets: 0, release: null as null | (() => Promise<void>) };
  await page.route("**/api/wiki/work-map?*", async (route) => {
    st.gets++;
    if (st.gets !== 1) return route.continue();
    if (opts.status) {
      st.release = () => route.fulfill({ status: opts.status!, json: { error: "x" } });
      return;
    }
    const body = await (await route.fetch()).json();
    st.release = () => route.fulfill({ json: body });
  });
  return st;
}

const activeDesc = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return !a || a === document.body ? "body" : `${a.tagName.toLowerCase()}${a.id ? "#" + a.id : ""}.${a.className}`;
  });

test("an adopt that brings a map hides What's new while the card's GET is held, and sends no digest", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  const st = await holdFirstGet(page);
  await page.clock.install();
  const digests = await openStart(page, P_LOAD);
  const wn = page.locator("#wikiWhatsNew");
  const card = page.locator("#wikiWorkCard");
  await expect(wn).toContainText("Something changed");
  expect(digests).toHaveLength(1);
  await writeFile(path.join(roots[P_LOAD]!, ".work-map.json"), mapJson(P_LOAD, Date.now() - HOUR), "utf8");
  await forceAdopt(page, P_LOAD);
  await expect.poll(() => st.release !== null).toBe(true);
  await expect(wn).toBeHidden();
  await expect(card).toBeHidden();
  // What's new's ↻ is still in the DOM: a click on it sends nothing.
  await page.evaluate(() => document.getElementById("wikiWhatsNewRefresh")!.click());
  // A tab switch while the GET is held keeps both hidden.
  await page.locator('.wiki-tab[data-tab="timeline"]').click();
  await page.locator('.wiki-tab[data-tab="hubs"]').click();
  await expect(wn).toBeHidden();
  await expect(card).toBeHidden();
  await page.waitForTimeout(300);
  expect(digests).toHaveLength(1);
  await st.release!();
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await expect(wn).toBeHidden();
  expect(digests).toHaveLength(1);
});

test("a map GET answered after the map dropped does not repaint the card", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  const st = await holdFirstGet(page);
  await page.clock.install();
  await openStart(page, P_LATE);
  const card = page.locator("#wikiWorkCard");
  const wn = page.locator("#wikiWhatsNew");
  await expect.poll(() => st.release !== null).toBe(true);
  await rm(path.join(roots[P_LATE]!, ".work-map.json"));
  await forceAdopt(page, P_LATE);
  await expect(wn).toContainText("Something changed");
  await st.release!();
  await page.waitForTimeout(500);
  await expect(card).toBeHidden();
  await expect(wn).toBeVisible();
  // The map comes back with a new run time: one fresh GET paints the card.
  await writeFile(path.join(roots[P_LATE]!, ".work-map.json"), mapJson(P_LATE, Date.now() - HOUR), "utf8");
  await forceAdopt(page, P_LATE);
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await expect(wn).toBeHidden();
  expect(st.gets).toBe(2);
});

test("a 5xx GET answered after the map dropped does not show the card's Retry", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  const st = await holdFirstGet(page, { status: 503 });
  await page.clock.install();
  await openStart(page, P_LATE5);
  const card = page.locator("#wikiWorkCard");
  const wn = page.locator("#wikiWhatsNew");
  await expect.poll(() => st.release !== null).toBe(true);
  await rm(path.join(roots[P_LATE5]!, ".work-map.json"));
  await forceAdopt(page, P_LATE5);
  await expect(wn).toContainText("Something changed");
  await st.release!();
  await page.waitForTimeout(500);
  await expect(card).toBeHidden();
  await expect(wn).toBeVisible();
});

test("a ↻ POST answered after the map dropped starts no poll", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  const st = await organizable(page);
  let releasePost: null | (() => Promise<void>) = null;
  await page.route("**/api/wiki/work-map/refresh*", (route) => {
    releasePost = () => route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } });
  });
  await page.clock.install();
  await openStart(page, P_POST);
  const card = page.locator("#wikiWorkCard");
  const wn = page.locator("#wikiWhatsNew");
  await card.locator("#wikiWorkMapRefresh").click();
  await expect.poll(() => releasePost !== null).toBe(true);
  await rm(path.join(roots[P_POST]!, ".work-map.json"));
  await forceAdopt(page, P_POST);
  await expect(card).toBeHidden();
  await expect(wn).toContainText("Something changed");
  const n = st.gets;
  await releasePost!();
  for (let i = 0; i < 6; i++) await page.clock.runFor(5_000);
  await page.waitForTimeout(300);
  expect(st.gets).toBe(n);
  await expect(card).toBeHidden();
});

test("a ↻ poll in flight when the map drops stops and paints nothing", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  let hold: null | (() => Promise<void>) = null;
  const st = await organizable(page, (n, f) => {
    if (n !== 2) return false;
    hold = f;
    return true;
  });
  await page.route("**/api/wiki/work-map/refresh*", (route) => route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } }));
  await page.clock.install();
  await openStart(page, P_POLL);
  const card = page.locator("#wikiWorkCard");
  const wn = page.locator("#wikiWhatsNew");
  await card.locator("#wikiWorkMapRefresh").click();
  await expect(page.locator("#wikiWorkMapStatus")).toContainText("Organizing…");
  await expect
    .poll(async () => {
      await page.clock.runFor(1_000);
      return hold !== null;
    })
    .toBe(true);
  await rm(path.join(roots[P_POLL]!, ".work-map.json"));
  await forceAdopt(page, P_POLL);
  await expect(card).toBeHidden();
  const n = st.gets;
  await hold!();
  for (let i = 0; i < 6; i++) await page.clock.runFor(5_000);
  await page.waitForTimeout(300);
  expect(st.gets).toBe(n);
  await expect(card).toBeHidden();
  await expect(wn).toBeVisible();
});

test("a ✓ whose next sibling shares its key moves focus past it, to the next remaining ✓", async ({ page }) => {
  await openStart(page, P_DUP);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator("[data-wm-need]")).toHaveCount(3);
  await card.locator('[data-wm-done="0"]').focus();
  await page.keyboard.press("Enter");
  // Both "Same" items share one key, so one ✓ dismisses both.
  await expect(card.locator("[data-wm-need]")).toHaveCount(1);
  await expect(card.locator('[data-wm-done="2"]')).toBeFocused();
});

test("focus inside the card moves to What's new's heading when an adopt drops the map", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  await page.clock.install();
  await openStart(page, P_FOCUS);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await card.locator('[data-wm-done="0"]').focus();
  await rm(path.join(roots[P_FOCUS]!, ".work-map.json"));
  await forceAdopt(page, P_FOCUS);
  await expect(card).toBeHidden();
  await expect(page.locator("#wikiWhatsNew")).toContainText("Something changed");
  await expect.poll(() => activeDesc(page)).toBe("span.wiki-wn-title");
  await expect(page.locator("#wikiWhatsNew .wiki-wn-title")).toBeFocused();
});

test("'less' on a why that no longer clamps keeps focus in the card", async ({ page }) => {
  await page.setViewportSize({ width: WHY_CLAMPED_AT, height: 844 });
  await openStart(page, P_WHY);
  const card = page.locator("#wikiWorkCard");
  const text = card.locator(".wiki-wm-why-text");
  const more = card.locator(".wiki-wm-why-more");
  await expect(more).toBeVisible();
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await page.setViewportSize({ width: WHY_FITS_AT, height: 844 });
  // The card is wide enough now that the closed text fits its two lines.
  await expect.poll(() => text.evaluate((el) => el.scrollHeight <= Math.ceil(2 * parseFloat(getComputedStyle(el).lineHeight)) + 1)).toBe(true);
  await expect(more).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card.locator(".wiki-wm-why")).not.toHaveClass(/\bopen\b/);
  await expect(more).toBeHidden();
  expect(await activeDesc(page)).not.toBe("body");
  await expect(text).toBeFocused();
});

for (const theme of [
  { label: "Light", stored: "light", scheme: "dark" as const },
  { label: "Dark", stored: "dark", scheme: "light" as const },
]) {
  test(`↻ and Retry inside the card change colour on hover in the ${theme.label} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme.scheme });
    await page.addInitScript((v) => localStorage.setItem("muninn-theme", v), theme.stored);
    await organizable(page);
    await openSettled(page, FRESH);
    const color = (sel: string) => page.locator(sel).evaluate((el) => getComputedStyle(el).color);
    const accent = await token(page, "--accent-light");
    const btn = page.locator("#wikiWorkMapRefresh");
    const rest = await color("#wikiWorkMapRefresh");
    expect(rest).not.toBe(accent);
    await btn.hover();
    await expect.poll(() => color("#wikiWorkMapRefresh")).toBe(accent);
    await page.unroute("**/api/wiki/work-map?*");
    await page.route("**/api/wiki/work-map?*", (route) => route.fulfill({ status: 503, json: { error: "down" } }));
    await page.reload();
    const retry = page.locator("#wikiWorkMapRetry");
    await expect(retry).toBeVisible();
    await page.mouse.move(0, 0);
    const retryRest = await color("#wikiWorkMapRetry");
    expect(retryRest).not.toBe(accent);
    await retry.hover();
    await expect.poll(() => color("#wikiWorkMapRetry")).toBe(accent);
  });
}

test("an inbox load landing mid-press waits for the release, then paints", async ({ page }) => {
  let releaseInbox: () => void = () => {};
  const gate = new Promise<void>((r) => { releaseInbox = r; });
  let served = 0;
  await page.route("**/api/wiki/decision-inbox**", async (route) => {
    await gate;
    served++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ wiki: "x", cards: [{ relPath: "plans/a.mdx", id: "ZZQ1", title: "ZZ title", body: "Which?", choices: [], recommendation: null, targets: [], added: null, laneSince: null, answers: [], hint: null, viewerAnswered: false, lane: "ask" }] }) });
  });
  await openStart(page, BOARD);
  const card = boardCard(page);
  await expect(card.locator(".wiki-wm-strip")).toBeVisible();
  await card.locator(".wiki-wm-strip").evaluate((el) => el.setAttribute("data-before-repaint", ""));
  const start = await pressPoint(card);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2, start.y + 2, { steps: 6 });
  await page.mouse.move(start.x, start.y, { steps: 6 });
  await expect.poll(() => page.evaluate(() => getSelection()!.isCollapsed)).toBe(true);
  releaseInbox();
  await expect.poll(() => served).toBe(1);
  await page.waitForTimeout(300);
  await expect(card.locator("[data-before-repaint]")).toHaveCount(1);
  await page.mouse.up();
  await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
  await expect(card.locator("#wikiWorkInbox")).toContainText("ZZ title");
});
