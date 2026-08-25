import { test, expect, type Page } from "@playwright/test";

/**
 * PR A acceptance 1 (client half) + 4 — the chat page's waterfall and phase pill
 * are scoped to the selected user, they STILL POPULATE, and the page never falls
 * back to the unscoped operator stream.
 *
 * The server-side filtering is unit-tested (`agent-status.test.ts`,
 * `sse-routes.test.ts`). What no unit test can reach is the client half in
 * `src/chat/views/page.ts`: the stream carries `?viewer=<id>`, re-opens when the
 * selected user changes, and does not open at all without one. A mistake there
 * does not fail loudly — it silently leaves the panel blank, or silently shows
 * everybody's runs, which is why this is a stated acceptance item.
 *
 * Every dependency is stubbed — the bot list, the user list and the event stream
 * — so the assertions hold on any instance regardless of what is in its DB.
 * Nothing here may `test.skip`: on a repo with no CI, a skipped acceptance test
 * is an acceptance item that silently did not run.
 */

const BOT = { name: "e2e-bot", showWaterfall: true, hasTelegram: false, hasSlack: false };
const USER = { userId: "viewer-1", username: "E2E Viewer", platform: "web" };

const RUN = {
  requestId: "req_e2e_1",
  botName: BOT.name,
  username: "alice",
  userId: USER.userId,
  phase: "calling_claude",
  model: "canary-model-9",
  connectorLabel: "Claude Code",
  startedAt: 1_700_000_000_000,
  tools: [],
  kind: "chat",
};

/** One canned `/api/events` body carrying the two frames the chat page reads. */
function cannedEvents(run: Record<string, unknown>, status: Record<string, unknown>): string {
  return [
    `event: agent_status`,
    `data: ${JSON.stringify(status)}`,
    ``,
    `event: request_progress`,
    `data: ${JSON.stringify(run)}`,
    ``,
    ``,
  ].join("\n");
}

/** Stub the page's three dependencies. Returns the `/api/events` URLs requested. */
async function stubChat(
  page: Page,
  opts: { users?: unknown[]; status?: Record<string, unknown>; run?: Record<string, unknown> } = {},
): Promise<string[]> {
  const eventUrls: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/events")) eventUrls.push(req.url());
  });

  await page.route("**/chat/bots", (route) =>
    route.fulfill({ json: { bots: [BOT], connectors: [] } }),
  );
  await page.route("**/api/users*", (route) =>
    route.fulfill({ json: { users: opts.users ?? [USER] } }),
  );
  await page.route("**/api/events*", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: cannedEvents(opts.run ?? RUN, opts.status ?? { phase: "calling_claude", username: "alice", detail: "Searching knowledge" }),
    }),
  );
  return eventUrls;
}

/** Pick the stubbed bot, which is what resolves a user and therefore a viewer. */
async function selectBot(page: Page): Promise<void> {
  await expect(page.locator(`.bot-pill[data-bot="${BOT.name}"]`)).toBeVisible();
  await page.locator(`.bot-pill[data-bot="${BOT.name}"]`).click();
}

test.describe("Chat page: viewer-scoped progress", () => {
  test("the phase pill and the waterfall both still populate", async ({ page }) => {
    await stubChat(page);
    await page.goto("/chat");
    await selectBot(page);

    await expect(page.locator("#agentStatus")).toHaveClass(/working/);
    await expect(page.locator("#agentPhase")).not.toBeEmpty();

    const panel = page.locator("#requestProgress");
    await expect(panel).toHaveClass(/visible/);
    // The run's own fields, not a neighbour's — this is what "A's waterfall
    // never names B's model" is asserted against once two people are on it.
    await expect(panel).toContainText("canary-model-9");
  });

  test("the stream carries the selected user, and that user IS the viewer", async ({ page }) => {
    const eventUrls = await stubChat(page);
    await page.goto("/chat");
    await selectBot(page);

    await expect
      .poll(() => eventUrls.some((u) => u.includes(`viewer=${USER.userId}`)), { timeout: 10_000 })
      .toBe(true);
    expect(
      await page.evaluate(() => (window as unknown as { __muninnViewerId: string | null }).__muninnViewerId),
    ).toBe(USER.userId);
  });

  test("a viewer change re-opens the stream against the new id", async ({ page }) => {
    const eventUrls = await stubChat(page);
    await page.goto("/chat");
    await selectBot(page);
    await expect.poll(() => eventUrls.length, { timeout: 10_000 }).toBeGreaterThan(0);

    await page.evaluate(() => {
      (window as unknown as { __muninnViewerId: string }).__muninnViewerId = "viewer-2";
      (window as unknown as { reconnectChatSse: () => void }).reconnectChatSse();
    });

    await expect
      .poll(() => eventUrls.some((u) => u.includes("viewer=viewer-2")), { timeout: 10_000 })
      .toBe(true);
  });

  test("with NO user to scope to, the page opens no stream at all", async ({ page }) => {
    // Fail closed. An unscoped `/api/events` is the operator stream, so falling
    // back to it here would render every user's phase and waterfall — the defect
    // this scoping removes — in the state least likely to be noticed.
    const eventUrls = await stubChat(page, { users: [] });
    await page.goto("/chat");
    await selectBot(page);

    // Give the page longer than it needs to have connected, then assert silence.
    await page.waitForTimeout(1500);
    expect(eventUrls).toEqual([]);
    await expect(page.locator("#requestProgress")).not.toHaveClass(/visible/);
  });
});
