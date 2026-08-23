import { test, expect, type Page } from "@playwright/test";

/**
 * The Jira draft card in the web chat.
 *
 * Drives the REAL page against a real server, because every rule this feature
 * lives by is a browser rule: the card binds to a bubble through
 * `data-message-id`, the listing is re-asked on thread load, and «Lagret»
 * survives a reload only because `saved_at` is on the row. None of that is
 * visible from a unit test of the pure module.
 *
 * It needs a melosys thread that already carries a finished thread-sourced draft
 * — it does NOT spend a model call. `JIRA_CARD_THREAD` / `JIRA_CARD_USER` /
 * `JIRA_CARD_DRAFT` name it; without them the file skips rather than failing on
 * a machine that has no such row.
 */

const THREAD = process.env.JIRA_CARD_THREAD ?? "";
const USER = process.env.JIRA_CARD_USER ?? "";
const DRAFT = process.env.JIRA_CARD_DRAFT ?? "";
const BOT = process.env.JIRA_CARD_BOT ?? "melosys";

test.skip(!THREAD || !USER || !DRAFT, "set JIRA_CARD_THREAD / _USER / _DRAFT to run");

async function openThread(page: Page): Promise<void> {
  await page.goto(`/chat?bot=${BOT}&thread=${THREAD}&user=${USER}`);
  // The card is adopted after the replay, off `GET /api/jira/drafts?thread=`.
  await expect(page.locator(`[data-jira-card="${DRAFT}"]`)).toBeVisible({ timeout: 20_000 });
}

test.describe("the draft card", () => {
  test("attaches under the bubble the draft came from, with its badges", async ({ page }) => {
    await openThread(page);
    const card = page.locator(`[data-jira-card="${DRAFT}"]`);

    // Bound to a bubble — and to the RIGHT one: the card's host must be the
    // message the row names, never "the last .msg-bot".
    const hostId = await card.evaluate((el) => el.closest(".msg-bot")?.getAttribute("data-message-id"));
    const rowMessageId = await page.evaluate(
      async (d) => (await (await fetch(`/api/jira/draft/${d}`)).json()).messageId,
      DRAFT,
    );
    expect(hostId).toBe(rowMessageId);

    // The FINALIZED text, not the raw reply: `## Referanser` is appended by the
    // server and exists nowhere in `messages.content`.
    await expect(card.locator(".jira-card-body")).toContainText("Referanser");
    await expect(card.locator(".jira-card-badge").first()).toBeVisible();
  });

  test("the stored message is NEVER rewritten — the card is the only place the finalized text lives", async ({
    page,
  }) => {
    await openThread(page);
    const stored = await page.evaluate(
      async (d) => (await (await fetch(`/api/jira/draft/${d}`)).json()).messageId,
      DRAFT,
    );
    // The bubble's own body predates finalize: no server-appended reference list.
    const bodyText = await page
      .locator(`.msg-bot[data-message-id="${stored}"] > .msg-body`)
      .innerText();
    expect(bodyText).not.toContain("## Referanser");
  });

  test("Kopier markdown puts the RAW markdown on the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openThread(page);
    await page.locator(`[data-jc-copy="${DRAFT}"]`).click();
    await expect(page.locator(`[data-jira-card="${DRAFT}"] .jira-card-msg`)).toContainText("kopiert");

    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const stored = await page.evaluate(
      async (d) => (await (await fetch(`/api/jira/draft/${d}`)).json()).markdown,
      DRAFT,
    );
    expect(clip).toBe(stored);
    // Markdown, byte for byte — what the Jira editor converts on paste.
    expect(clip).toContain("## ");
  });

  test("Lagre survives a reload — that is the whole reason saved_at exists", async ({ page }) => {
    // Start from a KNOWN-unsaved state, whatever earlier runs did.
    await page.request.fetch(`/api/jira/draft/${DRAFT}/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      data: "{}",
    });

    await openThread(page);
    const card = page.locator(`[data-jira-card="${DRAFT}"]`);
    // Already saved by the request above: the mark is what a reload restores.
    await expect(card.locator(".jira-card-saved")).toBeVisible();
    await expect(card.locator(`[data-jc-save="${DRAFT}"]`)).toHaveCount(0);

    await page.reload();
    await expect(page.locator(`[data-jira-card="${DRAFT}"] .jira-card-saved`)).toBeVisible({
      timeout: 20_000,
    });
  });

  test("switching thread away and back re-adopts it — the listing is the authority", async ({ page }) => {
    await openThread(page);
    // Any other thread in the sidebar.
    const others = page.locator(`.thread-item:not(.active)`);
    if ((await others.count()) === 0) test.skip();
    await others.first().click();
    await expect(page.locator(`[data-jira-card="${DRAFT}"]`)).toHaveCount(0);

    await page.locator(".thread-item.active").waitFor();
    await page.goto(`/chat?bot=${BOT}&thread=${THREAD}&user=${USER}`);
    await expect(page.locator(`[data-jira-card="${DRAFT}"]`)).toBeVisible({ timeout: 20_000 });
  });

  test("the 🧾 control opens the picker and no longer opens a tab", async ({ page, context }) => {
    await openThread(page);
    const before = context.pages().length;
    await page.locator("[data-je-btn]").last().click();
    await expect(page.locator("#jePanel")).toBeVisible();
    await expect(page.locator("#jePanel")).toContainText("kort under svaret");
    // Nothing was opened by opening the picker.
    expect(context.pages().length).toBe(before);
  });
});
