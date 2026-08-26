import { test, expect, type Page } from "@playwright/test";

/**
 * Put the page in its PRE-SELECTION state WITHOUT stopping the client.
 *
 * `init()` auto-selects the first bot, which resolves a user, loads that user's
 * threads and selects the most recent one — enabling the composer. So "initially"
 * was a race against that chain, and on a database with content the chain wins:
 * `input is disabled initially` failed on CI and reproduced locally 1-in-4
 * against a seeded DB. It passes on a developer's machine only because the first
 * bot's first user happens to have nothing to select.
 *
 * The fix is NOT to block the chain. An earlier version held `/chat/bots` open so
 * `init()` stalled at its first await — which made all three assertions read
 * strings that are literally in the server template (`src/chat/views/page.ts`),
 * with no client code running at all. A regression that enabled the composer
 * before a thread was selected — the exact defect `input is disabled initially`
 * exists to catch — would then have passed.
 *
 * So the bot list is served REAL and only the USER lookup is emptied. `selectBot`
 * runs end to end, `loadUsersForBot` finds nobody, `loadThreads` takes its
 * `!selectedUserId` branch and paints "Select a bot", and the composer stays
 * disabled because `selectThread` never runs. Same observable state, reached by
 * executing the code that is under test.
 */
async function withNoResolvableUser(page: Page): Promise<void> {
  await page.route("**/api/users*", (route) => route.fulfill({ json: { users: [] } }));
  await page.route("**/chat/bot-preferences/*/default-user", (route) =>
    route.fulfill({ json: { userId: null } }),
  );
}

test.describe("Chat page", () => {
  test("loads and shows bot selector", async ({ page }) => {
    await page.goto("/chat");
    await expect(page).toHaveTitle("Muninn Chat");

    // Bot selector pills should appear in the header
    const botSelector = page.locator(".bot-selector");
    await expect(botSelector).toBeVisible();
  });

  test("shows three-panel layout", async ({ page }) => {
    await page.goto("/chat");

    // Left sidebar
    await expect(page.locator(".sim-sidebar")).toBeVisible();
    // Center chat
    await expect(page.locator(".sim-chat")).toBeVisible();
    // Right inspector
    await expect(page.locator(".sim-inspector")).toBeVisible();
  });

  test("sidebar shows 'Select a bot' initially", async ({ page }) => {
    await withNoResolvableUser(page);
    await page.goto("/chat");

    const threadList = page.locator("#threadList");
    await expect(threadList).toContainText("Select a bot");
  });

  test("chat area shows 'Select a thread' initially", async ({ page }) => {
    await withNoResolvableUser(page);
    await page.goto("/chat");

    const chatMessages = page.locator("#chatMessages");
    await expect(chatMessages).toContainText("Select a thread from the sidebar");
  });

  test("input is disabled initially", async ({ page }) => {
    await withNoResolvableUser(page);
    await page.goto("/chat");

    const input = page.locator("#chatInput");
    await expect(input).toBeDisabled();

    const sendBtn = page.locator("#chatSend");
    await expect(sendBtn).toBeDisabled();
  });

  test("bot selection loads threads", async ({ page }) => {
    await page.goto("/chat");

    // Wait for bot pills to load
    const botPills = page.locator(".bot-pill");
    const count = await botPills.count();

    if (count > 0) {
      // Click first bot
      await botPills.first().click();

      // Thread list should update (no longer showing "Select a bot")
      await expect(page.locator("#threadList")).not.toContainText("Select a bot");
    }
  });

  test("deep link selects bot", async ({ page }) => {
    // Navigate with bot query parameter
    await page.goto("/chat?bot=jarvis");

    // Wait for the bot pill to become active (deep link triggers async selectBot)
    const activePill = page.locator(".bot-pill.active");
    await expect(activePill).toBeVisible({ timeout: 5000 });
    await expect(activePill).toContainText("jarvis", { ignoreCase: true });
  });

  test("new thread button exists", async ({ page }) => {
    await page.goto("/chat");

    const newThreadBtn = page.locator("#newThreadBtn");
    await expect(newThreadBtn).toBeVisible();
    await expect(newThreadBtn).toContainText("New Thread");
  });

  test("thread modal opens and closes", async ({ page }) => {
    await page.goto("/chat");

    const modal = page.locator("#threadModalBackdrop");

    // Modal should be hidden initially
    await expect(modal).not.toBeVisible();

    // Click new thread button
    await page.locator("#newThreadBtn").click();

    // Modal should appear
    await expect(modal).toBeVisible();

    // Close modal
    await page.locator("#threadModalClose").click();

    // Modal should be hidden again
    await expect(modal).not.toBeVisible();
  });

  test("thread modal has required fields", async ({ page }) => {
    await page.goto("/chat");

    await page.locator("#newThreadBtn").click();

    await expect(page.locator("#threadModalName")).toBeVisible();
    await expect(page.locator("#threadModalDesc")).toBeVisible();
    await expect(page.locator("#threadModalConnector")).toBeVisible();
    await expect(page.locator("#threadModalSave")).toBeVisible();
    await expect(page.locator("#threadModalCancel")).toBeVisible();
  });

  test("inspector shows empty state initially", async ({ page }) => {
    await page.goto("/chat");

    const inspector = page.locator("#inspectorContent");
    await expect(inspector).toContainText("Select a thread");
  });
});

test.describe("Chat SSE connection", () => {
  /**
   * The chat page never opens an UNSCOPED event stream — and never touches
   * `/api/events` at all.
   *
   * This replaced a "connects to the SSE endpoint" assertion, which encoded the
   * old contract: connect immediately, unfiltered. The page now waits for a
   * viewer and opens `?viewer=<id>` — and opens nothing at all without one,
   * because an unscoped stream is the operator's and would render every user's
   * phase and waterfall here. That makes "did it connect?" depend on whether
   * this instance has any chat users, so the assertion that survives on every
   * host is the negative one. The positive half — that it DOES connect, scoped,
   * once a user resolves — is `chat-viewer-scope.spec.ts`, which stubs the bot
   * and user lists so it holds regardless of the DB.
   *
   * PR D added the second half: the page consumes `/chat/events`, which serves
   * only the phase pill and the waterfall. `/api/events` also replays 50
   * activity events with the full message text of every turn plus a
   * process-wide `agent_runs` snapshot, and is now denied to role `user`, so a
   * page still reaching for it is both a leak and a broken panel.
   */
  test("never opens an unscoped event stream, and never touches /api/events", async ({ page }) => {
    const chatEventUrls: string[] = [];
    const operatorStreamUrls: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/chat/events")) chatEventUrls.push(url);
      else if (url.includes("/api/events")) operatorStreamUrls.push(url);
    });

    await page.goto("/chat");
    const pills = page.locator(".bot-pill");
    if (await pills.count()) await pills.first().click();
    await page.waitForTimeout(1500);

    expect(chatEventUrls.filter((u) => !u.includes("viewer="))).toEqual([]);
    expect(operatorStreamUrls, "the chat page reached for the operator stream").toEqual([]);
  });
});
