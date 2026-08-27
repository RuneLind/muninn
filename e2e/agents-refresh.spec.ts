import { test, expect } from "@playwright/test";

/**
 * `/agents` — the overview keeps refreshing when NOTHING is running.
 *
 * The page used to fetch `/api/agents/overview` exactly once (page load) and
 * then only when the `agent_runs` running-set signature changed. Three ways to
 * sit on a permanently dead page followed, and none of them is visible to tsc or
 * to a unit test: a load that raced a server restart wrote one err-note and
 * never retried; a reconnected EventSource re-delivered the same (usually empty)
 * running set, so no refetch fired; and with nothing running the rAF ticker is
 * stopped, so even the "N m ago" labels froze.
 *
 * These specs pin the two halves that can be driven deterministically — the
 * visibility-gated poll, and the one-fetch-at-boot rule the reconnect refetch
 * depends on (`sseEverConnected`; without it every connect would double-fetch).
 * The reconnect refetch itself needs a server restart under an open tab and is
 * verified by hand.
 *
 * Runs against the config's shared server, which has `SCHEDULER_ENABLED=false`
 * — nothing starts a run, so the request counts below are the page's own doing.
 */

/** Mirrors `OVERVIEW_POLL_MS` in `src/dashboard/views/agents-page.ts`. */
const OVERVIEW_POLL_MS = 30_000;

/** Stub `document.visibilityState`, then fire the event the page listens for. */
async function setVisibility(page: import("@playwright/test").Page, state: string): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => value,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

test.describe("Agents page: overview refresh", () => {
  test("polls the overview while visible, with no run starting", async ({ page }) => {
    const overviewRequests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/agents/overview")) overviewRequests.push(r.url());
    });

    await page.clock.install();
    await page.goto("/agents");
    await expect(page.locator("#recentCard")).toBeVisible();
    // Exactly one at boot: the init load. The SSE `onopen` deliberately does NOT
    // refetch on its FIRST connect (an overview hit is 4 DB queries), so a second
    // request here would mean that guard regressed.
    await expect.poll(() => overviewRequests.length).toBe(1);

    await page.clock.fastForward(OVERVIEW_POLL_MS + 1_000);

    // Nothing ran, nothing finished, the running set never changed — and the
    // page refreshed anyway. That is the whole point.
    await expect.poll(() => overviewRequests.length).toBeGreaterThanOrEqual(2);
  });

  test("a hidden tab does not poll, and returning to it refetches at once", async ({ page }) => {
    const overviewRequests: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/agents/overview")) overviewRequests.push(r.url());
    });

    await page.clock.install();
    await page.goto("/agents");
    await expect.poll(() => overviewRequests.length).toBe(1);

    // A background tab left open for a day must cost nothing.
    await setVisibility(page, "hidden");
    await page.clock.fastForward(OVERVIEW_POLL_MS * 3);
    await page.waitForTimeout(200);
    expect(overviewRequests).toHaveLength(1);

    // Coming back refreshes NOW rather than up to a poll late.
    await setVisibility(page, "visible");
    await expect.poll(() => overviewRequests.length).toBe(2);
  });
});
