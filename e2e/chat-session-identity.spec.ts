import { test, expect, type Page } from "@playwright/test";

/**
 * PR C, client half — with a server-derived identity the chat page must not run
 * `loadUsersForBot` AT ALL.
 *
 * Not "must skip the /api/users fetch". That function issues
 * `GET /api/users?bot=` AND `GET /chat/bot-preferences/:botName/default-user` in
 * one `Promise.allSettled` — both of which §4 puts in the ADMIN zone — and it is
 * also what assigns `selectedUserId`/`selectedUsername`, which every downstream
 * fetch on the page depends on. Skipping only the first leaves an authenticated
 * client calling an admin route AND still picking its own id.
 *
 * The failure this guards against is not a 403 — it is the opposite. A client
 * that keeps calling those routes passes every server-side security assertion in
 * this campaign while quietly making the deferred zone model unshippable, and a
 * client that stops calling them but never sets an id renders a chat page that
 * cannot send anything. Both are invisible to a unit test.
 *
 * Everything is stubbed via `page.route`, so this runs against the shared 3011
 * server on any machine — no second muninn, no port, no MUNINN_AUTH on the
 * server at all. What is under test is the BRANCH in `page.ts`, and `/chat/me`
 * is the only input to it.
 */

const BOT = { name: "e2e-bot", showWaterfall: false, hasTelegram: false, hasSlack: false };
const PICKER_USER = { userId: "picked-from-dropdown", username: "Dropdown User", platform: "web" };
const SESSION = { mode: "session", userId: "session-user", displayName: "Session User", navIdent: null, provider: "local", role: "user" };
const LOCAL_ME = { mode: "local", userId: null, displayName: null, role: null };

interface Calls { admin: string[]; conversations: Record<string, unknown>[]; defaultUserWrites: string[] }

/** `me: null` means /chat/me is UNREACHABLE — distinct from "auth is off". */
async function stub(page: Page, me: Record<string, unknown> | null): Promise<Calls> {
  const calls: Calls = { admin: [], conversations: [], defaultUserWrites: [] };
  page.on("request", (req) => {
    const url = req.url();
    // The two admin-zone routes `loadUsersForBot` issues, and nothing else.
    if (url.includes("/api/users") || url.includes("/default-user")) calls.admin.push(url);
    if (url.includes("/default-user") && req.method() === "PUT") calls.defaultUserWrites.push(url);
  });

  await page.route("**/chat/me", (route) =>
    me === null ? route.fulfill({ status: 503, json: { error: "down" } }) : route.fulfill({ json: me }));
  await page.route("**/chat/bots", (route) => route.fulfill({ json: { bots: [BOT], connectors: [] } }));
  await page.route("**/api/users*", (route) => route.fulfill({ json: { users: [PICKER_USER] } }));
  await page.route("**/chat/bot-preferences/**", (route) => route.fulfill({ json: { userId: null } }));
  await page.route("**/chat/events*", (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "\n\n" }));
  await page.route("**/chat/conversations", async (route, req) => {
    if (req.method() === "POST") {
      calls.conversations.push(JSON.parse(req.postData() ?? "{}"));
      return route.fulfill({
        status: 201,
        json: { conversation: { id: "conv-1", type: "web", botName: BOT.name, userId: "x", username: "x", messages: [] } },
      });
    }
    return route.fulfill({ json: { conversations: [] } });
  });
  await page.route("**/chat/threads/**", (route) => route.fulfill({ json: { threads: [] } }));
  return calls;
}

async function selectBot(page: Page): Promise<void> {
  await expect(page.locator(`.bot-pill[data-bot="${BOT.name}"]`)).toBeVisible();
  await page.locator(`.bot-pill[data-bot="${BOT.name}"]`).click();
}

test.describe("Chat page: a server-derived identity", () => {
  test("the page calls NEITHER admin-zone route, and the picker is hidden", async ({ page }) => {
    const calls = await stub(page, SESSION);
    await page.goto("/chat");
    await selectBot(page);

    await expect(page.locator("#userSelectorContainer")).toBeHidden();
    // Give the page longer than it needs, then assert silence — the assertion
    // is an ABSENCE, so it has to outlast the thing it denies.
    await page.waitForTimeout(1500);
    expect(calls.admin, "loadUsersForBot ran despite a server-derived identity").toEqual([]);
  });

  test("the id and display name come from /chat/me, and the page can still send", async ({ page }) => {
    const calls = await stub(page, SESSION);
    await page.goto("/chat");
    await selectBot(page);

    // The half that breaks the product rather than the boundary: an id has to
    // be set, or the page renders and can never resolve a conversation.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __muninnViewerId: string | null }).__muninnViewerId),
        { timeout: 10_000 })
      .toBe(SESSION.userId);
    await expect.poll(() => calls.conversations.length, { timeout: 10_000 }).toBeGreaterThan(0);
    // The claim the client still sends is its own session id — the SERVER
    // overrides it either way (`requireOwnUser`), but a client sending the
    // dropdown's id would 403 on every turn.
    expect(calls.conversations[0]!.userId).toBe(SESSION.userId);
    expect(calls.conversations[0]!.username).toBe(SESSION.displayName);
  });

  test("an UNREACHABLE /chat/me fails CLOSED — no picker, no admin fetches, no user", async ({ page }) => {
    // The failure this replaces: a non-2xx or a network error landed in the
    // same branch as a valid mode:"local", so ONE flaky request made the page
    // show the picker and issue both admin-zone fetches on an authenticating
    // instance. Guessing a user is the one outcome that is wrong in both modes.
    const calls = await stub(page, null);
    await page.goto("/chat");
    await selectBot(page);

    await expect(page.locator("#userSelectorContainer")).toBeHidden();
    await page.waitForTimeout(2000); // longer than the one retry (300ms) needs
    expect(calls.admin, "the page fell back to the picker on an unreachable /chat/me").toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as { __muninnViewerId: string | null }).__muninnViewerId),
    ).toBeNull();
  });

  test("the authenticated page NEVER writes bot_default_user", async ({ page }) => {
    // That field's only writer was the dropdown, and six server-side readers
    // degrade silently without it — but the route that writes it is admin-zone
    // under §4, so the answer is `pinnedLocalUserId()` on the READ side, not a
    // client write. This asserts the client half of that split.
    const calls = await stub(page, SESSION);
    await page.goto("/chat");
    await selectBot(page);
    await page.waitForTimeout(1500);
    expect(calls.defaultUserWrites).toEqual([]);
  });

  test('with auth off — mode "local" — the picker and both routes come back', async ({ page }) => {
    // "Off is off", asserted from the browser. Without this, a client change
    // that silently disabled the dropdown everywhere would pass the two tests
    // above and break today's single-user muninn.
    const calls = await stub(page, LOCAL_ME);
    await page.goto("/chat");
    await selectBot(page);

    await expect(page.locator("#userSelectorContainer")).toBeVisible();
    await expect
      .poll(() => calls.admin.some((u) => u.includes("/api/users")), { timeout: 10_000 })
      .toBe(true);
    expect(calls.admin.some((u) => u.includes("/default-user"))).toBe(true);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __muninnViewerId: string | null }).__muninnViewerId),
        { timeout: 10_000 })
      .toBe(PICKER_USER.userId);
  });
});
