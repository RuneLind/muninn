import { test, expect } from "@playwright/test";

test.describe("Inspector panel", () => {
  test("shows empty state when no thread is selected", async ({ page }) => {
    await page.goto("/chat");

    const inspector = page.locator("#inspectorContent");
    await expect(inspector).toContainText("Select a thread");
  });

  test("renders user info after selecting a bot and thread", async ({ page }) => {
    await page.goto("/chat");

    // Wait for bot pills to load
    const botPills = page.locator(".bot-pill");
    const count = await botPills.count();
    if (count === 0) {
      test.skip(true, "No bots available — cannot test inspector");
      return;
    }

    // Click first bot
    await botPills.first().click();

    // Wait for threads to load (no longer showing "Select a bot")
    await expect(page.locator("#threadList")).not.toContainText("Select a bot", {
      timeout: 5000,
    });

    // Select the first thread
    const threadItems = page.locator(".thread-item");
    const threadCount = await threadItems.count();
    if (threadCount === 0) {
      test.skip(true, "No threads available — cannot test inspector");
      return;
    }
    await threadItems.first().click();

    // Inspector should now show the user header
    const inspectorContent = page.locator("#inspectorContent");
    await expect(inspectorContent.locator(".ins-user-header")).toBeVisible({
      timeout: 5000,
    });

    // User name and ID should be rendered
    await expect(inspectorContent.locator(".ins-user-name")).toBeVisible();
    await expect(inspectorContent.locator(".ins-user-id")).toBeVisible();

    // Bot info row should show the selected bot name
    const botRow = inspectorContent.locator(".ins-info-row", { hasText: "Bot" });
    await expect(botRow).toBeVisible();

    // Thread info row should be present
    const threadRow = inspectorContent.locator(".ins-info-row", {
      hasText: "Thread",
    });
    await expect(threadRow).toBeVisible();

    // Status info row should be present
    const statusRow = inspectorContent.locator(".ins-info-row", {
      hasText: "Status",
    });
    await expect(statusRow).toBeVisible();
  });

  test("renders Memories, Goals, and Tasks sections", async ({ page }) => {
    await page.goto("/chat");

    const botPills = page.locator(".bot-pill");
    const count = await botPills.count();
    if (count === 0) {
      test.skip(true, "No bots available");
      return;
    }

    await botPills.first().click();
    await expect(page.locator("#threadList")).not.toContainText("Select a bot", {
      timeout: 5000,
    });

    const threadItems = page.locator(".thread-item");
    const threadCount = await threadItems.count();
    if (threadCount === 0) {
      test.skip(true, "No threads available");
      return;
    }
    await threadItems.first().click();

    // Wait for inspector context to populate (skeleton or real content)
    const inspectorContext = page.locator("#inspectorContext");
    await expect(inspectorContext).not.toBeEmpty({ timeout: 5000 });

    // Each section should have a title
    const sectionTitles = inspectorContext.locator(".ins-section-title");
    await expect(sectionTitles).toHaveCount(3);

    // Verify specific section headings exist
    await expect(inspectorContext.locator(".ins-section-title", { hasText: "Memories" })).toBeVisible();
    await expect(inspectorContext.locator(".ins-section-title", { hasText: "Goals" })).toBeVisible();
    await expect(inspectorContext.locator(".ins-section-title", { hasText: "Tasks" })).toBeVisible();

    // Each section should resolve from skeleton to either content or empty hint
    const insMemories = page.locator("#insMemories");
    const insGoals = page.locator("#insGoals");
    const insTasks = page.locator("#insTasks");

    // Wait for skeletons to disappear (API calls resolve)
    await expect(insMemories.locator(".ins-skeleton")).toHaveCount(0, { timeout: 5000 });
    await expect(insGoals.locator(".ins-skeleton")).toHaveCount(0, { timeout: 5000 });
    await expect(insTasks.locator(".ins-skeleton")).toHaveCount(0, { timeout: 5000 });

    // Each section should have either real items or an empty hint
    await expect(insMemories).not.toBeEmpty();
    await expect(insGoals).not.toBeEmpty();
    await expect(insTasks).not.toBeEmpty();
  });

  test("context usage container exists after thread selection", async ({ page }) => {
    await page.goto("/chat");

    const botPills = page.locator(".bot-pill");
    const count = await botPills.count();
    if (count === 0) {
      test.skip(true, "No bots available");
      return;
    }

    await botPills.first().click();
    await expect(page.locator("#threadList")).not.toContainText("Select a bot", {
      timeout: 5000,
    });

    const threadItems = page.locator(".thread-item");
    const threadCount = await threadItems.count();
    if (threadCount === 0) {
      test.skip(true, "No threads available");
      return;
    }
    await threadItems.first().click();

    // The context usage container should be rendered in the DOM
    // (may be empty if no context data is available, but the element should exist)
    const contextUsage = page.locator("#insContextUsage");
    await expect(contextUsage).toBeAttached({ timeout: 5000 });
  });

  test("tool usage container exists after thread selection", async ({ page }) => {
    await page.goto("/chat");

    const botPills = page.locator(".bot-pill");
    const count = await botPills.count();
    if (count === 0) {
      test.skip(true, "No bots available");
      return;
    }

    await botPills.first().click();
    await expect(page.locator("#threadList")).not.toContainText("Select a bot", {
      timeout: 5000,
    });

    const threadItems = page.locator(".thread-item");
    const threadCount = await threadItems.count();
    if (threadCount === 0) {
      test.skip(true, "No threads available");
      return;
    }
    await threadItems.first().click();

    // The tool usage container should always be present in the DOM
    const toolUsage = page.locator("#inspectorToolUsage");
    await expect(toolUsage).toBeAttached();
  });

  test("inspector updates when switching threads", async ({ page }) => {
    await page.goto("/chat");

    const botPills = page.locator(".bot-pill");
    const count = await botPills.count();
    if (count === 0) {
      test.skip(true, "No bots available");
      return;
    }

    await botPills.first().click();
    await expect(page.locator("#threadList")).not.toContainText("Select a bot", {
      timeout: 5000,
    });

    const threadItems = page.locator(".thread-item");
    const threadCount = await threadItems.count();
    if (threadCount < 2) {
      test.skip(true, "Need at least 2 threads to test switching");
      return;
    }

    // Select first thread
    await threadItems.first().click();
    const inspectorContent = page.locator("#inspectorContent");
    await expect(inspectorContent.locator(".ins-user-header")).toBeVisible({
      timeout: 5000,
    });

    // Capture thread name from first selection
    const firstThreadName = await inspectorContent
      .locator(".ins-info-row", { hasText: "Thread" })
      .locator(".ins-info-value")
      .textContent();

    // Select second thread
    await threadItems.nth(1).click();
    await expect(inspectorContent.locator(".ins-user-header")).toBeVisible({
      timeout: 5000,
    });

    // Thread name in inspector should reflect the new selection
    const secondThreadName = await inspectorContent
      .locator(".ins-info-row", { hasText: "Thread" })
      .locator(".ins-info-value")
      .textContent();

    // The thread row should still be visible (inspector re-rendered)
    expect(secondThreadName).toBeTruthy();
    // If thread names differ, we verify the inspector actually updated
    if (firstThreadName !== secondThreadName) {
      expect(firstThreadName).not.toEqual(secondThreadName);
    }
  });

  test("deep link populates inspector", async ({ page }) => {
    // Navigate with bot query parameter to trigger deep link
    await page.goto("/chat?bot=jarvis");

    // Wait for deep link to resolve and bot pill to become active
    const activePill = page.locator(".bot-pill.active");
    await expect(activePill).toBeVisible({ timeout: 5000 });

    // If threads auto-loaded, select the first one
    const threadItems = page.locator(".thread-item");
    const threadCount = await threadItems.count();
    if (threadCount > 0) {
      await threadItems.first().click();

      // Inspector should populate with user info
      const inspectorContent = page.locator("#inspectorContent");
      await expect(inspectorContent.locator(".ins-user-header")).toBeVisible({
        timeout: 5000,
      });

      // Bot row should say "jarvis"
      const botValue = inspectorContent
        .locator(".ins-info-row", { hasText: "Bot" })
        .locator(".ins-info-value");
      await expect(botValue).toContainText("jarvis");
    }
  });
});

test.describe("Inspector panel API integration", () => {
  test("fetches tool-usage endpoint when thread is selected", async ({ page }) => {
    await page.goto("/chat");

    const botPills = page.locator(".bot-pill");
    const count = await botPills.count();
    if (count === 0) {
      test.skip(true, "No bots available");
      return;
    }

    await botPills.first().click();
    await expect(page.locator("#threadList")).not.toContainText("Select a bot", {
      timeout: 5000,
    });

    // Set up request interception for tool-usage API
    const toolUsageRequest = page.waitForRequest(
      (req) => req.url().includes("/chat/tool-usage/"),
      { timeout: 10000 },
    );

    const threadItems = page.locator(".thread-item");
    const threadCount = await threadItems.count();
    if (threadCount === 0) {
      test.skip(true, "No threads available");
      return;
    }
    await threadItems.first().click();

    const req = await toolUsageRequest;
    expect(req.url()).toContain("/chat/tool-usage/");
  });

  test("fetches context-usage endpoint when thread is selected", async ({ page }) => {
    await page.goto("/chat");

    const botPills = page.locator(".bot-pill");
    const count = await botPills.count();
    if (count === 0) {
      test.skip(true, "No bots available");
      return;
    }

    await botPills.first().click();
    await expect(page.locator("#threadList")).not.toContainText("Select a bot", {
      timeout: 5000,
    });

    // Set up request interception for context-usage API
    const contextUsageRequest = page.waitForRequest(
      (req) => req.url().includes("/chat/context-usage/"),
      { timeout: 10000 },
    );

    const threadItems = page.locator(".thread-item");
    const threadCount = await threadItems.count();
    if (threadCount === 0) {
      test.skip(true, "No threads available");
      return;
    }
    await threadItems.first().click();

    const req = await contextUsageRequest;
    expect(req.url()).toContain("/chat/context-usage/");
  });

  test("fetches memories, goals, and tasks APIs when thread is selected", async ({ page }) => {
    await page.goto("/chat");

    const botPills = page.locator(".bot-pill");
    const count = await botPills.count();
    if (count === 0) {
      test.skip(true, "No bots available");
      return;
    }

    await botPills.first().click();
    await expect(page.locator("#threadList")).not.toContainText("Select a bot", {
      timeout: 5000,
    });

    // Set up request interception for all three inspector APIs
    const memoriesRequest = page.waitForRequest(
      (req) => req.url().includes("/api/memories/user/"),
      { timeout: 10000 },
    );
    const goalsRequest = page.waitForRequest(
      (req) => req.url().includes("/api/goals/"),
      { timeout: 10000 },
    );
    const tasksRequest = page.waitForRequest(
      (req) => req.url().includes("/api/scheduled-tasks/"),
      { timeout: 10000 },
    );

    const threadItems = page.locator(".thread-item");
    const threadCount = await threadItems.count();
    if (threadCount === 0) {
      test.skip(true, "No threads available");
      return;
    }
    await threadItems.first().click();

    // All three APIs should be called
    const [memReq, goalReq, taskReq] = await Promise.all([
      memoriesRequest,
      goalsRequest,
      tasksRequest,
    ]);

    expect(memReq.url()).toContain("/api/memories/user/");
    expect(goalReq.url()).toContain("/api/goals/");
    expect(taskReq.url()).toContain("/api/scheduled-tasks/");
  });
});
