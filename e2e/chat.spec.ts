import { test, expect, type Page } from "@playwright/test";

/**
 * Keep the page in its PRE-SELECTION state for the assertions that describe it.
 *
 * `init()` auto-selects the first bot on load, which resolves a user, loads that
 * user's threads and selects the most recent one — enabling the composer. So
 * "initially" is a race against that chain, and on a database with content the
 * chain wins: `input is disabled initially` failed on CI and reproduced locally
 * 1-in-4 against a seeded DB. It passes on a developer's machine only because the
 * first bot's first user happens to have nothing to select.
 *
 * Holding `/chat/bots` open (a route handler that never fulfils) blocks `init()`
 * at its first await, so these three assert the server-rendered initial DOM —
 * which is what they were always describing. Only the tests that mean "before
 * anything is selected" use it; the ones that select a bot must not.
 */
async function holdBotList(page: Page): Promise<void> {
  await page.route("**/chat/bots", () => {
    /* deliberately never fulfilled — released when the context closes */
  });
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
    await holdBotList(page);
    await page.goto("/chat");

    const threadList = page.locator("#threadList");
    await expect(threadList).toContainText("Select a bot");
  });

  test("chat area shows 'Select a thread' initially", async ({ page }) => {
    await holdBotList(page);
    await page.goto("/chat");

    const chatMessages = page.locator("#chatMessages");
    await expect(chatMessages).toContainText("Select a thread from the sidebar");
  });

  test("input is disabled initially", async ({ page }) => {
    await holdBotList(page);
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
   * The chat page never opens an UNSCOPED `/api/events`.
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
   */
  test("never opens an unscoped event stream", async ({ page }) => {
    const eventUrls: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/events")) eventUrls.push(req.url());
    });

    await page.goto("/chat");
    const pills = page.locator(".bot-pill");
    if (await pills.count()) await pills.first().click();
    await page.waitForTimeout(1500);

    expect(eventUrls.filter((u) => !u.includes("viewer="))).toEqual([]);
  });
});
