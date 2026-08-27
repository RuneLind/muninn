import { test, expect, type Page } from "@playwright/test";

/**
 * `/agents` — the overview keeps refreshing when NOTHING is running, and the
 * page says which of the four stream states it is actually in.
 *
 * The page used to fetch `/api/agents/overview` exactly once (page load) and
 * then only when the `agent_runs` running-set signature changed. Three ways to
 * sit on a permanently dead page followed, and none of them is visible to tsc or
 * to a unit test: a load that raced a server restart wrote one err-note and
 * never retried; a reconnected EventSource re-delivered the same (usually empty)
 * running set, so no refetch fired; and with nothing running the rAF ticker is
 * stopped, so even the "N m ago" labels froze.
 *
 * The reconnect refetch itself needs a server restart under an open tab and is
 * verified by hand; everything else is pinned here.
 *
 * ⚠️ These specs run against the config's shared server, whose own command sets
 * `SCHEDULER_ENABLED=false`. The exact request counts below assume an IDLE
 * instance — with `reuseExistingServer` a developer's own server is used as-is,
 * so a live chat turn on it makes the first `agent_runs` snapshot non-empty,
 * which legitimately triggers one extra overview fetch. A failure here with a
 * count one too high means "something was running", not a regression.
 */

/** Read the poll interval out of the served page rather than hand-copying it —
 *  the constant lives inside the inline script, so a spec-side literal is free
 *  to drift out of sync with the page it is fast-forwarding past. */
async function pollIntervalMs(page: Page): Promise<number> {
  const html = await page.content();
  const m = html.match(/var OVERVIEW_POLL_MS = (\d+);/);
  expect(m, "the page must declare var OVERVIEW_POLL_MS — did the constant get renamed?").not.toBeNull();
  return Number(m![1]);
}

/** Stub `document.visibilityState`, then fire the event the page listens for. */
async function setVisibility(page: Page, state: string): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => value,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

function countOverviewRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/agents/overview")) seen.push(r.url());
  });
  return seen;
}

test.describe("Agents page: overview refresh", () => {
  test("polls the overview while visible, with no run starting", async ({ page }) => {
    const requests = countOverviewRequests(page);

    await page.clock.install();
    await page.goto("/agents");
    await expect(page.locator("#recentCard")).toBeVisible();
    const pollMs = await pollIntervalMs(page);

    // Exactly one at boot: the init load. The SSE `onopen` deliberately does NOT
    // refetch on a FIRST connect whose init load succeeded (an overview hit is
    // five DB queries), so a second request here would mean that guard regressed.
    // Asserted after a settle window rather than by polling up to 1, so the
    // guard is pinned instead of raced.
    await page.waitForTimeout(500);
    expect(requests).toHaveLength(1);

    await page.clock.fastForward(pollMs + 1_000);

    // Nothing ran, nothing finished, the running set never changed — and the
    // page refreshed anyway. That is the whole point.
    await expect.poll(() => requests.length).toBeGreaterThanOrEqual(2);
  });

  test("a hidden tab does not poll, and returning to it refetches at once", async ({ page }) => {
    const requests = countOverviewRequests(page);

    await page.clock.install();
    await page.goto("/agents");
    await expect(page.locator("#recentCard")).toBeVisible();
    const pollMs = await pollIntervalMs(page);
    await page.waitForTimeout(500);
    expect(requests).toHaveLength(1);

    // A background tab left open for a day must cost nothing.
    await setVisibility(page, "hidden");
    await page.clock.fastForward(pollMs * 3);
    await page.waitForTimeout(200);
    expect(requests).toHaveLength(1);

    // Coming back refreshes NOW rather than up to a poll late.
    await setVisibility(page, "visible");
    await expect.poll(() => requests.length).toBe(2);
  });

  test("the tab-return refetch shares the poll's floor", async ({ page }) => {
    const requests = countOverviewRequests(page);

    await page.clock.install();
    await page.goto("/agents");
    await expect(page.locator("#recentCard")).toBeVisible();
    await page.waitForTimeout(500);
    expect(requests).toHaveLength(1);

    // On macOS mere window occlusion flips visibilityState, so cmd-tabbing
    // between two overlapping windows must not buy one overview assembly per
    // switch. No clock advance here: every cycle is inside the floor.
    for (let i = 0; i < 8; i++) {
      await setVisibility(page, "hidden");
      await setVisibility(page, "visible");
    }
    await page.waitForTimeout(300);
    expect(requests).toHaveLength(1);
  });

  test("a dead stream stops the LIVE zone, not the data half", async ({ page }) => {
    const requests = countOverviewRequests(page);
    // What an expired session or a role-denied /api/events answers. EventSource
    // does not retry a non-200 — readyState goes to 2 and stays.
    await page.route("**/api/events*", (route) => route.fulfill({ status: 403, body: "denied" }));

    await page.clock.install();
    await page.goto("/agents");
    await expect(page.locator("#recentCard")).toBeVisible();
    const pollMs = await pollIntervalMs(page);

    // The live zone is over until a reload — say that, and say it is the live
    // zone. The overview is a DIFFERENT route and nothing here has refused it.
    await expect(page.locator("#agMeta")).toHaveText(/live updates off — reload to reconnect/);

    const before = requests.length;
    await page.clock.fastForward(pollMs + 1_000);
    await expect.poll(() => requests.length).toBeGreaterThan(before);
  });

  test("a transient proxy error on the stream does not freeze the page", async ({ page }) => {
    const requests = countOverviewRequests(page);
    // A tailnet/nginx front end answering 502 for 200ms while the backend blips.
    // EventSource still dies permanently, but the overview never stopped working
    // — and this used to leave the whole page frozen until a manual reload.
    let firstEvents = true;
    await page.route("**/api/events*", (route) => {
      if (firstEvents) {
        firstEvents = false;
        return route.fulfill({ status: 502, body: "bad gateway" });
      }
      return route.fallback();
    });

    await page.clock.install();
    await page.goto("/agents");
    await expect(page.locator("#recentCard")).toBeVisible();
    const pollMs = await pollIntervalMs(page);
    await page.waitForTimeout(500);

    const before = requests.length;
    await page.clock.fastForward(pollMs + 1_000);
    await expect.poll(() => requests.length).toBeGreaterThan(before);
  });

  test("an overview route that refuses us stops the poll", async ({ page }) => {
    const requests = countOverviewRequests(page);
    // The case that DOES justify stopping: the data route itself is answering
    // 403 to every request, so polling it twice a minute from every open tab
    // buys nothing. The stream is denied too — that is what an expired session
    // actually looks like, and it also makes the count deterministic: a LIVE
    // EventSource may legitimately reconnect mid-test, and a reconnect refetch
    // is not a poll. (The other direction — a dead stream must NOT stop the
    // data half — is pinned by its own case above.)
    await page.route("**/api/events*", (route) => route.fulfill({ status: 403, body: "denied" }));
    await page.route("**/api/agents/overview*", (route) =>
      route.fulfill({ status: 403, body: "{}" }),
    );

    await page.clock.install();
    await page.goto("/agents");
    await expect(page.locator("#agMeta")).toHaveText(/disconnected — reload the page/);
    const pollMs = await pollIntervalMs(page);

    const afterDenial = requests.length;
    await page.clock.fastForward(pollMs * 3);
    await page.waitForTimeout(300);
    expect(requests).toHaveLength(afterDenial);
  });

  test("a page that has never connected does not claim to be reconnecting", async ({ page }) => {
    const requests = countOverviewRequests(page);
    // The stream's first attempt is dropped mid-handshake — a page opened while
    // a --watch server is restarting. It has never connected, so "reconnecting…"
    // is false; and treating it as a reconnect would also make the first real
    // connect fire a second boot fetch.
    let attempts = 0;
    await page.route("**/api/events*", (route) => {
      attempts += 1;
      if (attempts <= 2) return route.abort("connectionreset");
      return route.fallback();
    });

    await page.goto("/agents");
    await expect(page.locator("#recentCard")).toBeVisible();
    // Anchored: /connecting…/ alone also matches "REconnecting…", which is the
    // very claim under test.
    await expect(page.locator("#agMeta")).toHaveText(/^connecting…/);
    await expect(page.locator("#agMeta")).not.toHaveText(/reconnecting/);

    // …and the first real connect must not count as a RE-connect, which would
    // fire a second boot fetch.
    await page.waitForTimeout(1_000);
    expect(requests).toHaveLength(1);
  });

  test("a persistently failing overview retries once, not every 3 seconds", async ({ page }) => {
    const requests = countOverviewRequests(page);
    // A 500 is a server that is down, not one refusing us, so the fast retry is
    // right — ONCE. Per failure it would be a 3s poll: 10x the interval the
    // whole design is cost-gated around.
    await page.route("**/api/agents/overview*", (route) => route.fulfill({ status: 500, body: "{}" }));

    // REAL time deliberately: under a fake clock `fastForward` runs the timers
    // synchronously while the fetch rejections resolve afterwards, so a retry
    // CASCADE never forms and the assertion proves nothing. 11 s is three retry
    // intervals and well inside one 30 s poll, so every request in the window is
    // either the boot load or a retry.
    await page.goto("/agents");
    await expect(page.locator("#recentCard")).toBeVisible();
    await page.waitForTimeout(11_000);

    // Boot load + at most one fast retry. Per-failure, this window holds four.
    expect(requests.length).toBeLessThanOrEqual(2);
  });

  test("a boot load that failed retries without waiting out a poll interval", async ({ page }) => {
    const requests = countOverviewRequests(page);
    // The original failure: the page is opened while the server is restarting,
    // so the init load 500s and the page used to sit on that one err-note
    // forever. Recovery must not depend on the stream reconnecting (it never
    // dropped) or on the 30s poll (that is the old bug in slower form).
    let first = true;
    await page.route("**/api/agents/overview*", (route) => {
      if (first) {
        first = false;
        return route.fulfill({ status: 500, body: "{}" });
      }
      return route.fallback();
    });

    await page.goto("/agents");
    await expect(page.locator("#recentCard")).toBeVisible();

    // No clock manipulation: if this passed only via the 30s poll it would be
    // meaningless, so it must land well inside one poll interval.
    await expect.poll(() => requests.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    await expect(page.locator("#errBox")).toHaveText("");
  });
});
