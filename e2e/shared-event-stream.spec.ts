import { test, expect, type Page } from "@playwright/test";

/**
 * One `/api/events` connection for every home and /agents tab of a browser
 * (`src/dashboard/views/components/shared-sse.ts`).
 *
 * What a unit test cannot show: real Web Locks and BroadcastChannel across
 * real tabs of one browser context, the server's real opening burst replayed
 * to a tab that joins late, and the next tab opening its own stream when the
 * leading tab closes. Every tab here is in ONE context, as tabs of one Chrome
 * profile are; each test gets a fresh context, so no lock crosses tests.
 *
 * Runs against the config's shared server (3011, `SCHEDULER_ENABLED=false`):
 * read-only, no fixture.
 *
 * An init script wraps `sharedSseClient` as the helpers bundle publishes it,
 * so each page records the frames its own handlers received (`__seen`): the
 * evidence that a follower got the opening snapshot, not just a status label.
 */

declare global {
  interface Window {
    __seen?: string[];
  }
}

async function recordHandlers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__seen = [];
    let fn: unknown;
    Object.defineProperty(window, "sharedSseClient", {
      configurable: true,
      get: () => fn,
      set: (real: (url: string, h: Record<string, (e: Event) => void>, o?: unknown) => unknown) => {
        fn = (url: string, handlers: Record<string, (e: Event) => void>, opts?: unknown) => {
          const wrapped: Record<string, (e: Event) => void> = {};
          for (const [name, h] of Object.entries(handlers)) {
            wrapped[name] = (e: Event) => {
              window.__seen!.push(name);
              h(e);
            };
          }
          return real(url, wrapped, opts);
        };
      },
    });
  });
}

const seen = (page: Page) => page.evaluate(() => window.__seen ?? []);
const count = (list: string[], name: string) => list.filter((n) => n === name).length;

test("home and /agents tabs in one browser share one /api/events stream; the next tab takes over when the leader closes", async ({ context }) => {
  const streams: string[] = [];
  context.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/events") streams.push(r.url());
  });

  const leader = await context.newPage();
  await recordHandlers(leader);
  await leader.goto("/agents");
  await expect(leader.locator("#agMeta")).toHaveText(/live over SSE/);
  await expect.poll(() => seen(leader)).toContain("agent_runs");

  // A home tab joins: it shows Connected and gets the opening burst replayed.
  const home = await context.newPage();
  await recordHandlers(home);
  await home.goto("/");
  await expect(home.locator("#statusText")).toHaveText("Connected");
  await expect.poll(async () => {
    const s = await seen(home);
    return ["onopen", "stats", "agent_status", "request_progress", "agent_runs"].every((n) => s.includes(n));
  }).toBe(true);

  // A second /agents tab joins too: live, with the agent_runs snapshot.
  const agents2 = await context.newPage();
  await recordHandlers(agents2);
  await agents2.goto("/agents");
  await expect(agents2.locator("#agMeta")).toHaveText(/live over SSE/);
  await expect.poll(() => seen(agents2)).toContain("agent_runs");

  // Three tabs, one connection.
  await home.waitForTimeout(500);
  expect(streams).toHaveLength(1);

  // The leader goes: one of the others opens its own stream, and both stay live.
  const homeRunsBefore = count(await seen(home), "agent_runs");
  const agentsRunsBefore = count(await seen(agents2), "agent_runs");
  await leader.close();
  await expect.poll(() => streams.length).toBe(2);
  // The new stream's opening snapshot reaches both remaining tabs.
  await expect.poll(async () => count(await seen(home), "agent_runs")).toBeGreaterThan(homeRunsBefore);
  await expect.poll(async () => count(await seen(agents2), "agent_runs")).toBeGreaterThan(agentsRunsBefore);
  await expect(home.locator("#statusText")).toHaveText("Connected");
  await expect(agents2.locator("#agMeta")).toHaveText(/live over SSE/);
  await home.waitForTimeout(500);
  expect(streams).toHaveLength(2);
});

test("a takeover does not add the activity feed's rows again on the remaining home tab", async ({ context }) => {
  const streams: string[] = [];
  context.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/events") streams.push(r.url());
  });
  const rows = (p: Page) => p.locator("#feed [data-feed-event]").count();

  const leader = await context.newPage();
  await recordHandlers(leader);
  await leader.goto("/");
  await expect(leader.locator("#statusText")).toHaveText("Connected");
  const home = await context.newPage();
  await recordHandlers(home);
  await home.goto("/");
  await expect(home.locator("#statusText")).toHaveText("Connected");
  // The server's startup lines are in its activity replay, so the feed is not empty.
  await expect.poll(async () => count(await seen(home), "activity")).toBeGreaterThan(0);
  await home.waitForTimeout(500);
  const before = await rows(home);
  expect(before).toBeGreaterThan(0);

  const runsBefore = count(await seen(home), "agent_runs");
  await leader.close();
  await expect.poll(() => streams.length).toBe(2);
  // The new stream's burst (activity replay first, agent_runs last) has reached this tab.
  await expect.poll(async () => count(await seen(home), "agent_runs")).toBeGreaterThan(runsBefore);
  await home.waitForTimeout(300);
  expect(await rows(home)).toBe(before);
});
