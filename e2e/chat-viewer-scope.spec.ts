import { test, expect } from "@playwright/test";

/**
 * PR A acceptance 1 (client half) + 4 — the chat page's waterfall and phase pill
 * are scoped to the selected user, and they STILL POPULATE.
 *
 * The server-side filtering is unit-tested (`agent-status.test.ts`,
 * `sse-routes.test.ts`). What no unit test can reach is the pair of client edits
 * PR A made to `src/chat/views/page.ts`: the stream now carries `?viewer=<id>`
 * and re-opens when the selected user changes. A mistake there does not fail
 * loudly — it silently leaves the panel blank, which is why "it still populates"
 * is a stated acceptance item rather than an assumption.
 *
 * The SSE stream is served from a route interception, so these assertions need
 * no live model turn and no particular DB contents.
 */

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

const RUN = {
  requestId: "req_e2e_1",
  botName: "jarvis",
  username: "alice",
  userId: "user-a",
  phase: "calling_claude",
  model: "canary-model-9",
  connectorLabel: "Claude Code",
  startedAt: Date.now(),
  tools: [],
  kind: "chat",
};

test.describe("Chat page: viewer-scoped progress", () => {
  test("the phase pill still populates from the scoped stream", async ({ page }) => {
    await page.route("**/api/events*", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: cannedEvents(RUN, { phase: "calling_claude", username: "alice", detail: "Searching knowledge" }),
      }),
    );

    await page.goto("/chat");

    // The pill renders regardless of a bot's showWaterfall setting — it is the
    // half that survives suppression, so it needs no bot selection.
    await expect(page.locator("#agentStatus")).toHaveClass(/working/);
    await expect(page.locator("#agentPhase")).not.toBeEmpty();
  });

  test("the waterfall still populates for a bot that renders one", async ({ page }) => {
    await page.route("**/api/events*", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: cannedEvents(RUN, { phase: "calling_claude", username: "alice" }),
      }),
    );

    await page.goto("/chat");
    await expect(page.locator(".bot-pill").first()).toBeVisible();

    // `window._suppressWaterfall` starts true and is resolved from the selected
    // bot's config, so a bot must be picked — and one that renders a waterfall.
    const bots: { name: string; showWaterfall?: boolean }[] =
      await (await page.request.get("/chat/bots")).json().then((b) => b.bots ?? b);
    const withWaterfall = bots.find((b) => b.showWaterfall !== false);
    test.skip(!withWaterfall, "no configured bot renders a waterfall on this instance");

    await page.locator(`.bot-pill[data-bot="${withWaterfall!.name}"]`).click();

    const panel = page.locator("#requestProgress");
    await expect(panel).toHaveClass(/visible/);
    // The run's own fields, not a neighbour's — this is what "A's waterfall
    // never names B's model" is asserted against once two people are on it.
    await expect(panel).toContainText("canary-model-9");
  });

  test("a viewer change re-opens the stream carrying that id", async ({ page }) => {
    const eventUrls: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/events")) eventUrls.push(req.url());
    });
    await page.route("**/api/events*", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: cannedEvents(RUN, { phase: "idle" }),
      }),
    );

    await page.goto("/chat");
    await expect.poll(() => eventUrls.length, { timeout: 10_000 }).toBeGreaterThan(0);
    // The first connect happens before any user is known, so it is unscoped —
    // that is deliberate, and it is why a RECONNECT has to exist at all.
    expect(eventUrls[0]).not.toContain("viewer=");

    // Drive the seam the user selector drives. Done directly rather than through
    // the dropdown because an instance with no `users` rows has nothing to
    // select, and this assertion is about the stream, not about the DB.
    await page.evaluate(() => {
      (window as unknown as { __muninnViewerId: string }).__muninnViewerId = "user-a";
      (window as unknown as { reconnectChatSse: () => void }).reconnectChatSse();
    });

    await expect
      .poll(() => eventUrls.some((u) => u.includes("viewer=user-a")), { timeout: 10_000 })
      .toBe(true);
  });

  test("the selected user IS the viewer", async ({ page }) => {
    await page.route("**/api/events*", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: cannedEvents(RUN, { phase: "idle" }),
      }),
    );

    await page.goto("/chat");
    await expect(page.locator(".bot-pill").first()).toBeVisible();
    await page.locator(".bot-pill").first().click();

    // `#userSelector` is populated from `/api/users`; an instance with no chat
    // users has no viewer to assert on, and that is an environment fact rather
    // than a failure — the previous test covers the stream half regardless.
    let userId = "";
    try {
      await expect
        .poll(async () => await page.locator("#userSelector").inputValue(), { timeout: 5_000 })
        .not.toBe("");
      userId = await page.locator("#userSelector").inputValue();
    } catch {
      test.skip(true, "no chat users in this instance's DB — nothing to scope to");
    }

    expect(
      await page.evaluate(() => (window as unknown as { __muninnViewerId: string | null }).__muninnViewerId),
    ).toBe(userId);
  });
});
