import { test, expect } from "@playwright/test";

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
    await page.goto("/chat");

    const threadList = page.locator("#threadList");
    await expect(threadList).toContainText("Select a bot");
  });

  test("chat area shows 'Select a thread' initially", async ({ page }) => {
    await page.goto("/chat");

    const chatMessages = page.locator("#chatMessages");
    await expect(chatMessages).toContainText("Select a thread from the sidebar");
  });

  test("input is disabled initially", async ({ page }) => {
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
  test("connects to SSE endpoint", async ({ page }) => {
    // Intercept SSE request
    const ssePromise = page.waitForRequest(
      (req) => req.url().includes("/api/events"),
      { timeout: 5000 }
    );

    await page.goto("/chat");

    const sseReq = await ssePromise;
    expect(sseReq.url()).toContain("/api/events");
  });
});
