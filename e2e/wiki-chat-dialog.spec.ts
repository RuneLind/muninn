/**
 * /wiki reader — the "start a chat from here" DIALOG, end-to-end.
 *
 * Three things no unit test can prove, and all three are how this surface actually
 * broke:
 *   1. **The dialog is opaque.** Its `background` was
 *      `var(--bg-elevated, var(--bg-secondary))` and NEITHER token is defined on
 *      /wiki (`--bg-elevated` exists only in the chat page's own styles), so the
 *      whole declaration was invalid and the panel rendered fully TRANSPARENT with
 *      the article text showing through it. A pure test cannot see a computed
 *      style; only a browser can.
 *   2. **An empty Ask box is not a dead end.** Direct mode used to read its
 *      question from `#wikiAskInput` — the box the anchored popover sat on top of —
 *      so "New chat" on an empty box asked for a question while covering the only
 *      field that could supply one.
 *   3. **Both openers land in the same dialog**, with the article context and
 *      starter questions that belong to each.
 *
 * Since the 2026-08 cut-2 extraction it also carries a FOURTH job: the dialog's
 * whole DOM half lives in `views/components/wiki-chat-options.ts` and registers
 * its own document listeners, wired by the single `initChatOptions({…})` call in
 * `wiki-browser.ts`. Deleting that call leaves `tsc --noEmit` clean and every unit
 * test green (they drive the module's exports and its listeners directly), and the
 * only symptom is a reader whose New chat / Discuss / ⚙ buttons do nothing at all.
 * The first test below pins exactly that seam; every other test here would also go
 * red, which is the point — nothing about this dialog survives an unwired shell.
 *
 * NO MODEL CALLS and NO WRITES: the dialog's only fetch is the read-only
 * `GET /api/wiki/chat-target`, and "Start chat →" is deliberately never clicked
 * (that would create a real thread and seed it). Every assertion is about the
 * dialog itself.
 *
 * It boots its OWN muninn on a dedicated port with a temp `WIKI_EXTRA` wiki (the
 * `wiki-status-facet` pattern) rather than riding the shared dev server: the
 * suggestions are derived from page data, so the spec needs pages it authored.
 *
 * The temp wiki is registered with a SYNTHESIS-BOT PIN (`WIKI_EXTRA`'s 4th
 * segment) — a standalone wiki with neither owner nor pin resolves no chat target
 * at all and the dialog renders a bot picker instead of the fields. The pin names
 * the first discovered bot, resolved from `bots/` at setup so the spec doesn't
 * hardcode an install's bot name.
 *
 * ENV PREREQUISITE: the same one every other e2e spec has — a working `.env`
 * (`DATABASE_URL` at minimum) at the repo root, since `src/index.ts` boots the
 * full process.
 *
 * SPAWN ENV: `e2eEnv()` keeps this muninn off Telegram/Slack, and blanks the
 * instance-profile flags (`MUNINN_WIKI_READONLY`, `SYNC_REPOS`, `MUNINN_AUTH`…)
 * so a spawned server behaves the same on every host — a
 * second long-poller on a live token 409-fights the running production bot.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-chat-dialog");
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI = "e2e-chat";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

/** The page the Discuss dialog acts on. `updated` is what unlocks the "What
 *  changed since" chip; the link makes "How it connects" resolvable. */
const PAGES: Record<string, string> = {
  "gardener.md": [
    "---",
    "title: Wiki gardener",
    "type: concept",
    "updated: 2026-07-30",
    "description: How clustering works.",
    "---",
    "",
    "# Wiki gardener",
    "",
    "The gardener clusters summaries into wiki-page proposals. See [[Backlog drain]].",
    "",
  ].join("\n"),
  "backlog-drain.md": [
    "---",
    "title: Backlog drain",
    "type: concept",
    "---",
    "",
    "# Backlog drain",
    "",
    "Body.",
    "",
  ].join("\n"),
};

let server: ChildProcess | undefined;
let root = "";

/** First discovered bot folder — the same rule `discoverAllBots` applies, so the
 *  pin can resolve. A bot folder is a directory carrying a CLAUDE.md. */
async function firstBotName(): Promise<string> {
  const entries = await readdir(path.join(REPO_ROOT, "bots"), { withFileTypes: true });
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    try {
      await stat(path.join(REPO_ROOT, "bots", e.name, "CLAUDE.md"));
      return e.name;
    } catch { /* not a bot folder */ }
  }
  throw new Error("no bot folder with a CLAUDE.md — this spec needs one to pin");
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-chatdlg-"));
  for (const [name, body] of Object.entries(PAGES)) {
    await writeFile(path.join(root, name), body, "utf8");
  }
  const bot = await firstBotName();
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      // name=path[=collections][=synthesisBotPin] — no collections (the dialog
      // needs none), pin so a chat target resolves.
      WIKI_EXTRA: `${WIKI}=${root}==${bot}`,
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
});

/** Open the Ask tab's "New chat" dialog and wait for the target to resolve. */
async function openDirect(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
  await page.locator(String.raw`.wiki-conn-tab[data-conntab="ask"]`).click();
  await page.locator("#wikiNewChatBtn").click();
  await expect(page.locator("#wikiChatOpt")).toBeVisible();
}

test.describe("Wiki reader: chat dialog", () => {
  test("the shell WIRES the dialog — both openers reach the module's listeners", async ({
    page,
  }) => {
    // The seam is `initChatOptions({…})` in `wiki-browser.ts`: it injects the port
    // AND registers the module's document listeners. Without it the buttons still
    // render (their markup is the shell's) and nothing at all happens on click —
    // invisible to tsc and to every unit test.
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    await page.locator(String.raw`.wiki-conn-tab[data-conntab="ask"]`).click();
    await page.locator("#wikiNewChatBtn").click();
    await expect(page.locator("#wikiChatOpt")).toBeVisible();
    // The panel is the module's, painted from its own state.
    await expect(page.locator("#wikiChatOpt")).toContainText("New chat from this wiki");
    // Its close button is delegated by the same listener set.
    await page.locator("#wikiChatOptClose").click();
    await expect(page.locator("#wikiChatOpt")).toHaveCount(0);

    // The article opener goes through the same wiring — and through the port,
    // which is the only way it can know which page is open.
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&page=${encodeURIComponent("Wiki gardener")}`);
    await page.locator("#wikiDiscussBtn").click();
    await expect(page.locator("#wikiChatOpt")).toBeVisible();
    await expect(page.locator(".wiki-chatopt-ctx")).toContainText("Wiki gardener");
  });

  test("the dialog paints an OPAQUE background over the page", async ({ page }) => {
    await openDirect(page);
    const bg = await page
      .locator("#wikiChatOpt")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    // The bug rendered `rgba(0, 0, 0, 0)`. Anything with a real alpha is a pass;
    // asserting the exact token would just re-encode the stylesheet.
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("transparent");
    const alpha = /rgba?\([^)]*?(?:,\s*([\d.]+))?\)$/.exec(bg)?.[1];
    if (alpha !== undefined) expect(Number(alpha)).toBeGreaterThan(0.9);
    // …and it sits above a scrim, which is what makes the text behind it recede
    // instead of colliding with it.
    await expect(page.locator("#wikiChatOptScrim")).toBeVisible();
  });

  test("an EMPTY Ask box is no longer a dead end — the dialog owns the question", async ({
    page,
  }) => {
    await openDirect(page);
    // The field that used to be missing entirely in this mode.
    const box = page.locator("#wikiChatOptQ");
    await expect(box).toBeVisible();
    await expect(box).toHaveValue("");
    // Send is blocked on an empty question (the route 400s it)…
    await expect(page.locator("#wikiChatOptSend")).toBeDisabled();
    await expect(page.locator("#wikiChatOptStatus")).toContainText("Type a question first.");
    // …and typing IN THE DIALOG un-blocks it, with no reference to the Ask box.
    await box.fill("What is the gardener actually for?");
    await expect(page.locator("#wikiChatOptSend")).toBeEnabled();
    // The Ask box is left exactly as it was — the dialog never writes to it.
    await expect(page.locator("#wikiAskInput")).toHaveValue("");
  });

  test("a draft in the Ask box is PREFILLED once, and the box is left alone", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    await page.locator(String.raw`.wiki-conn-tab[data-conntab="ask"]`).click();
    await page.locator("#wikiAskInput").fill("half-written thought");
    await page.locator("#wikiNewChatBtn").click();
    await expect(page.locator("#wikiChatOptQ")).toHaveValue("half-written thought");
    await expect(page.locator("#wikiAskInput")).toHaveValue("half-written thought");
  });

  test("a starter chip FILLS the box and leaves it editable — never a one-click send", async ({
    page,
  }) => {
    await openDirect(page);
    const chip = page.locator(".wiki-chatopt-chip").first();
    await expect(chip).toBeVisible();
    await chip.click();
    const box = page.locator("#wikiChatOptQ");
    await expect(box).not.toHaveValue("");
    // Still a draft: editable, and nothing has been posted (the dialog is open and
    // shows no success link).
    await box.fill((await box.inputValue()) + " (edited)");
    await expect(box).toHaveValue(/\(edited\)$/);
    await expect(page.locator(".wiki-chatopt-done")).toHaveCount(0);
    await expect(page.locator("#wikiChatOpt")).toBeVisible();
  });

  test("the pickers are COLLAPSED behind ⚙ Options, with the summary reporting them", async ({
    page,
  }) => {
    await openDirect(page);
    // Collapsed: the three fields that used to greet the reader are not rendered.
    await expect(page.locator("#wikiChatOptConn")).toHaveCount(0);
    await expect(page.locator("#wikiChatOptName")).toHaveCount(0);
    const summary = page.locator(".wiki-chatopt-sum");
    await expect(summary).toBeVisible();
    // With an empty question there is nothing to name the thread after yet, and the
    // summary says so by omission rather than reporting the generic fallback the
    // name-chip row also refuses to offer.
    await expect(summary).not.toContainText("thread");
    await page.locator("#wikiChatOptQ").fill("What is the gardener actually for?");
    await expect(summary).toContainText("thread");
    // Expanding reveals the pickers, plus the thread-name chips.
    await page.locator("#wikiChatOptAdv").click();
    await expect(page.locator("#wikiChatOptConn")).toBeVisible();
    await expect(page.locator("#wikiChatOptName")).toBeVisible();
    await expect(page.locator(".wiki-chatopt-namechips")).toBeVisible();
  });

  test("a thread-name chip writes the field and the summary follows it", async ({ page }) => {
    await openDirect(page);
    await page.locator("#wikiChatOptQ").fill("Why is the cluster cap three?");
    await page.locator("#wikiChatOptAdv").click();
    const fromQuestion = page.locator('.wiki-chatopt-namechips [data-chat-name]').first();
    await fromQuestion.click();
    const typed = await page.locator("#wikiChatOptName").inputValue();
    expect(typed).not.toBe("");
    await expect(page.locator(".wiki-chatopt-sum")).toContainText(typed);
    // The "default" chip clears it again — `threadName: ""` is what makes the route
    // derive the name itself.
    await page.locator('.wiki-chatopt-namechips [data-chat-name=""]').click();
    await expect(page.locator("#wikiChatOptName")).toHaveValue("");
  });

  test("Discuss opens the SAME dialog, with the article context and page-specific chips", async ({
    page,
  }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&page=${encodeURIComponent("Wiki gardener")}`);
    await page.locator("#wikiDiscussBtn").click();
    const panel = page.locator("#wikiChatOpt");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Discuss this article");
    // Context in its OWN block — this is where the squashed "Page says" excerpt
    // moved to, above the question rather than between the fields.
    const ctx = page.locator(".wiki-chatopt-ctx");
    await expect(ctx).toContainText("Wiki gardener");
    await expect(ctx).toContainText("How clustering works.");
    // Empty question box + page-derived starter chips.
    await expect(page.locator("#wikiChatOptQ")).toHaveValue("");
    await expect(panel).toContainText("Ask about this page");
    await expect(panel).toContainText("What changed since");
    // Clicking one names the page in the question that lands in the box.
    await page.locator('.wiki-chatopt-chip[data-chat-q]').first().click();
    await expect(page.locator("#wikiChatOptQ")).toHaveValue(/Wiki gardener/);
    // The thread is named after the PAGE, not the question — that is what makes a
    // second Discuss land in the same thread.
    await expect(page.locator(".wiki-chatopt-sum")).toContainText("wiki gardener");
  });

  test("a chip click does not scroll Send off screen on a short viewport", async ({ page }) => {
    // `captureChatOptFocus` returns null for any focused element without an id —
    // which every chip is — so a `!focus` autofocus gate re-focused the textarea on
    // every chip click and scrolled the dialog back to the top.
    // Article mode has the most content (context row + six chips), and the viewport
    // is shrunk AFTER opening — the breadcrumb's Discuss button is itself off screen
    // at this height.
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&page=${encodeURIComponent("Wiki gardener")}`);
    await page.locator("#wikiDiscussBtn").click();
    await expect(page.locator("#wikiChatOpt")).toBeVisible();
    await page.setViewportSize({ width: 900, height: 320 });
    const panel = page.locator("#wikiChatOpt");
    await panel.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const before = await panel.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(0);
    await page.locator(".wiki-chatopt-chip[data-chat-q]").first().click();
    // Not an exact match: filling the question REMOVES the "Type a question first."
    // line, so the panel gets ~16px shorter and the browser clamps the scroll to the
    // new maximum. What must not happen is a reset to the top.
    const after = await panel.evaluate((el) => el.scrollTop);
    expect(after).toBeGreaterThan(before / 2);
    // The point of all of it: Send is still where the reader can press it.
    await expect(page.locator("#wikiChatOptSend")).toBeInViewport();
    // …and the chip still did its job.
    await expect(page.locator("#wikiChatOptQ")).not.toHaveValue("");
  });

  test("a click-away does not silently discard a question the reader typed", async ({ page }) => {
    // With a scrim, EVERY outside click lands on the scrim — so one stray click over
    // a dimmed page used to throw away a composed question with no confirmation.
    await openDirect(page);
    await page.locator("#wikiChatOptQ").fill("a question worth keeping");
    await page.locator("#wikiChatOptScrim").click({ position: { x: 30, y: 30 } });
    await expect(page.locator("#wikiChatOpt")).toBeVisible();
    await expect(page.locator("#wikiChatOptStatus")).toContainText("Press Esc again");
    await expect(page.locator("#wikiChatOptQ")).toHaveValue("a question worth keeping");
    // A second deliberate dismissal does close it.
    await page.locator("#wikiChatOptScrim").click({ position: { x: 30, y: 30 } });
    await expect(page.locator("#wikiChatOpt")).toHaveCount(0);
  });

  test("editing the thread name re-arms the discard confirmation it cleared", async ({ page }) => {
    // The name paths cleared the status line — the only thing announcing an armed
    // Escape — but left `escArmed` set, so the NEXT single Escape discarded a typed
    // question with no warning ever on screen.
    await openDirect(page);
    await page.locator("#wikiChatOptQ").fill("still composing this");
    await page.keyboard.press("Escape");
    await expect(page.locator("#wikiChatOptStatus")).toContainText("Press Esc again");
    await page.locator("#wikiChatOptAdv").click();
    await page.locator("#wikiChatOptName").fill("my-thread");
    await expect(page.locator("#wikiChatOptStatus")).not.toContainText("Press Esc again");
    // Disarmed: this Escape warns again instead of discarding.
    await page.keyboard.press("Escape");
    await expect(page.locator("#wikiChatOpt")).toBeVisible();
    await expect(page.locator("#wikiChatOptStatus")).toContainText("Press Esc again");
  });

  test("Tab stays inside the dialog — it claims aria-modal", async ({ page }) => {
    await openDirect(page);
    await expect(page.locator("#wikiChatOpt")).toHaveAttribute("aria-modal", "true");
    // Walk well past the dialog's own controls; focus must never leave it.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(
        () => !!document.getElementById("wikiChatOpt")?.contains(document.activeElement),
      );
      expect(inside).toBe(true);
    }
  });

  test("Escape confirms before discarding a typed question, and the scrim dismisses", async ({
    page,
  }) => {
    await openDirect(page);
    await page.locator("#wikiChatOptQ").fill("something I typed");
    await page.keyboard.press("Escape");
    // Still open, and it says why.
    await expect(page.locator("#wikiChatOpt")).toBeVisible();
    await expect(page.locator("#wikiChatOptStatus")).toContainText("Press Esc again");
    await page.keyboard.press("Escape");
    await expect(page.locator("#wikiChatOpt")).toHaveCount(0);
    // The scrim goes with it — left behind, it would swallow every click on the page.
    await expect(page.locator("#wikiChatOptScrim")).toHaveCount(0);

    // A PREFILLED question is reproducible, so it closes on the first Escape.
    await page.locator("#wikiAskInput").fill("a draft");
    await page.locator("#wikiNewChatBtn").click();
    await expect(page.locator("#wikiChatOpt")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#wikiChatOpt")).toHaveCount(0);
  });
});
