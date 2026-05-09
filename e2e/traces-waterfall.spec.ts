import { test, expect } from "@playwright/test";

test.describe("Traces waterfall", () => {
  test("loads /traces without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/traces");
    await expect(page).toHaveTitle(/Muninn.*Traces/);
    await page.waitForLoadState("networkidle");
    expect(errors).toEqual([]);
  });

  test("clicking a trace row opens the waterfall and clicking a span shows details", async ({
    page,
  }) => {
    await page.goto("/traces");
    await page.waitForLoadState("networkidle");

    const firstTraceRow = page.locator(".trace-table tbody tr[data-trace]").first();
    if ((await firstTraceRow.count()) === 0) {
      test.skip(true, "No traces in DB — cannot exercise waterfall");
    }

    await firstTraceRow.click();
    await expect(page.locator("#waterfallContainer")).toHaveClass(/visible/);
    await expect(page.locator("#waterfall .waterfall-bar").first()).toBeVisible();

    await page.locator("#waterfall .waterfall-bar").first().click();
    await expect(page.locator("#spanDetails")).toHaveClass(/visible/);

    // Esc closes the drawer first
    await page.keyboard.press("Escape");
    await expect(page.locator("#spanDetails")).not.toHaveClass(/visible/);

    // Esc again closes the waterfall
    await page.keyboard.press("Escape");
    await expect(page.locator("#waterfallContainer")).not.toHaveClass(/visible/);
  });
});
