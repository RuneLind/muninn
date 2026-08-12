/**
 * /summaries — the doc panel's 📤 Share button, end-to-end.
 *
 * The wiki reader's dialog is already smoked in `e2e/wiki-share.spec.ts`. What
 * only THIS file can see is everything the second mount adds:
 *
 *   1. **The dialog is styled here at all.** `/summaries` cannot import, so it
 *      loads the standalone bundle — and that bundle **tree-shakes
 *      `shareDialogStyles`** (nothing in the browser entrypoint references it),
 *      so the CSS has to be rendered SERVER-side by the page. Miss that and the
 *      dialog ships transparent and unpositioned, which is exactly how the chat
 *      dialog shipped once (`var(--bg-elevated)`, a token that page never
 *      defined). Hence the computed-background assertion, again.
 *   2. **It opens OVER the doc panel.** The panel is a `z-index: 1000` overlay
 *      here; the dialog ships 59/60 for /wiki, which has no overlay. Asserted by
 *      hit-testing, not by reading the stylesheet.
 *   3. **The `openSummaryDoc` seam.** /summaries has its own panel opener (not
 *      `docPanelScript`), and the doc the button acts on is held in module state
 *      that opener writes — so the POST must carry the `{source, docId}` of the
 *      document actually on screen.
 *   4. **One Escape closes the DIALOG, not the panel behind it.** Both listen on
 *      `document`; without the guard, one keypress threw away an un-copied post
 *      AND the article under it.
 *
 * NO MODEL CALLS AND NO SPEND: exactly one route is stubbed in the browser —
 * `POST /api/summaries/share`, replayed as a canned SSE body. The preset list is
 * fetched for real (read-only, model-free).
 *
 * huginn is not stubbed in the browser either: the spec boots a tiny fake
 * knowledge API and points this muninn's `KNOWLEDGE_API_URL` at it, so the
 * listing + document proxies are exercised as real HTTP.
 *
 * ENV PREREQUISITE: a working `.env` (`DATABASE_URL` at minimum) at the repo root.
 * PLATFORM TOKENS: `blankBotTokens()` keeps this muninn off Telegram/Slack.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { blankBotTokens } from "./blank-bot-tokens.ts";

const PORT = 3028;
const HUGINN_PORT = 3029;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

/** The capture document the panel opens. Its `source` is `youtube`, whose
 *  collection is `youtube-summaries` — the id/collection divergence the server
 *  adapter owns is invisible from here, which is the point. */
const SOURCE = "youtube";
const DOC_ID = "ai/claude-code/Subagents in practice.md";
const DOC_TITLE = "Subagents in practice";
/** Shaped like a real capture doc: bracketed breadcrumb on line 1, huginn's
 *  tags as YAML frontmatter. */
const DOC_TEXT = [
  "[youtube > ai/claude-code > Subagents in practice]",
  "---",
  "tags: [agents, cli]",
  "---",
  "",
  "## What it covers",
  "",
  "Subagents, and when they pay for themselves.",
  "",
].join("\n");

/** The canned post the stubbed route "generates". */
const MARKDOWN = "## Subagents\n\nThey pay off when **parallel**.";
const SLACK = "*Subagents*\n\nThey pay off when *parallel*.";
const MAIL_HTML = '<h2 style="font-size:18px">Subagents</h2><p>They pay off when parallel.</p>';

function shareSseBody(): string {
  const frame = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    frame("delta", { type: "delta", text: "## Subagents\n\n" }) +
    frame("done", { markdown: MARKDOWN, slack: SLACK, mailHtml: MAIL_HTML }) +
    frame("end", {})
  );
}

let server: ChildProcess | undefined;
let huginn: Server | undefined;

/**
 * A knowledge API just real enough for the listing + document proxies (Playwright
 * runs this file under NODE, so `node:http` rather than `Bun.serve`). Any other
 * path answers `{}` so a page probe degrades quietly instead of painting a
 * banner over the layout.
 */
async function startFakeHuginn(): Promise<Server> {
  const srv = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (p.startsWith("/api/collection/") && p.endsWith("/documents")) {
      const collection = p.slice("/api/collection/".length, -"/documents".length);
      return json({
        documents:
          collection === "youtube-summaries"
            ? [{ id: DOC_ID, title: DOC_TITLE, date: "2026-08-01", url: "https://example.com/v" }]
            : [],
      });
    }
    if (p.startsWith("/api/document/")) {
      return json({ id: DOC_ID, text: DOC_TEXT, url: "https://example.com/v" });
    }
    if (p === "/api/search") return json({ results: [] });
    return json({});
  });
  await new Promise<void>((resolve) => srv.listen(HUGINN_PORT, "127.0.0.1", resolve));
  return srv;
}

test.beforeAll(async () => {
  huginn = await startFakeHuginn();
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...blankBotTokens(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      KNOWLEDGE_API_URL: `http://127.0.0.1:${HUGINN_PORT}`,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/summaries/share/presets`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  huginn?.close();
});

/** Every POST body the stub saw — otherwise the stub hides the client→route
 *  contract completely. Reset per `openPanel`. */
let posted: Record<string, unknown>[] = [];

/** Open the doc panel on a real summary document, with the generate route
 *  stubbed. The deep link runs the SAME `openSummaryDoc` a Shelf row click runs. */
async function openPanel(page: import("@playwright/test").Page): Promise<void> {
  posted = [];
  await page.route("**/api/summaries/share", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posted.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: shareSseBody(),
    });
  });
  await page.goto(`${BASE}/summaries?source=${SOURCE}&doc=${encodeURIComponent(DOC_ID)}`);
  await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
  await expect(page.locator("#docPanelTitle")).toHaveText(DOC_TITLE);
  // The real document, through the real proxy against the fake huginn.
  await expect(page.locator("#sumArticleMain")).toContainText("when they pay for themselves");
}

async function openShare(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("#docPanelShare").click();
  await expect(page.locator("#wikiShare")).toBeVisible();
  await expect(page.locator("#wikiSharePreset")).toBeVisible();
}

test.describe("Summaries: doc-panel share", () => {
  test("the Share button is in the panel header and opens the dialog", async ({ page }) => {
    await openPanel(page);
    const btn = page.locator("#docPanelShare");
    await expect(btn).toBeVisible();
    await expect(btn).toContainText("Share");
    await expect(page.locator("#wikiShare")).toHaveCount(0);
    await openShare(page);
  });

  test("the dialog paints an OPAQUE background — the bundle tree-shakes its CSS", async ({
    page,
  }) => {
    await openPanel(page);
    await openShare(page);
    const bg = await page
      .locator("#wikiShare")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("transparent");
    const alpha = /rgba?\([^)]*?(?:,\s*([\d.]+))?\)$/.exec(bg)?.[1];
    if (alpha !== undefined) expect(Number(alpha)).toBeGreaterThan(0.9);
    // The rest of the stylesheet came along too — an unpositioned dialog would
    // be `static`, i.e. rendered inline at the bottom of the document.
    expect(await page.locator("#wikiShare").evaluate((el) => getComputedStyle(el).position)).toBe(
      "fixed",
    );
    await expect(page.locator("#wikiShareScrim")).toBeVisible();
  });

  test("it stacks OVER the doc panel, and its controls are reachable", async ({ page }) => {
    // The panel is a z-index:1000 overlay on this page while the dialog ships
    // 59/60 for /wiki — without the page-scoped override the dialog renders
    // UNDER the article it was opened from. Hit-tested, not read off the CSS.
    await openPanel(page);
    await openShare(page);
    const hit = await page.locator("#wikiShare").evaluate((el) => {
      const box = el.getBoundingClientRect();
      const at = document.elementFromPoint(box.x + box.width / 2, box.y + 8);
      return { insideDialog: !!at && el.contains(at), tag: at?.tagName ?? "" };
    });
    expect(hit.insideDialog).toBe(true);
    // …and the scrim covers the panel, so a click outside the dialog can't
    // reach the article beneath it.
    const overPanel = await page.evaluate(() => {
      const scrim = document.getElementById("wikiShareScrim");
      const panelEl = document.querySelector(".doc-panel") as HTMLElement | null;
      if (!scrim || !panelEl) return false;
      const b = panelEl.getBoundingClientRect();
      return document.elementFromPoint(b.x + b.width / 2, b.y + b.height - 20) === scrim;
    });
    expect(overPanel).toBe(true);
    // Reachability: a real click on a dialog control lands on it and takes.
    await page.locator('[data-share-lang="nb"]').click();
    await expect(page.locator('[data-share-lang="nb"].is-active')).toBeVisible();
  });

  test("Generate posts {source, docId} — never a collection — and shows the three tabs", async ({
    page,
  }) => {
    await openPanel(page);
    await openShare(page);
    await page.locator("#wikiShareGen").click();
    await expect(page.locator(".wiki-share-tabs")).toBeVisible();

    expect(posted).toHaveLength(1);
    const body = posted[0]!;
    expect(body.source).toBe(SOURCE);
    expect(body.docId).toBe(DOC_ID);
    // The collection is a server-side registration detail; the client must not
    // know it (and must not send the wiki surface's fields either).
    expect(JSON.stringify(body)).not.toContain("youtube-summaries");
    expect(body.wiki).toBeUndefined();
    expect(body.page).toBeUndefined();
    expect(typeof body.preset).toBe("string");
    expect(["en", "nb"]).toContain(body.lang);
    expect(body.promptOverride).toBeUndefined();

    const tabs = page.locator(".wiki-share-tab");
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toHaveText("Slack");
    await expect(page.locator("#wikiShare")).not.toContainText("Telegram");
    await page.locator('[data-share-tab="markdown"]').click();
    await expect(page.locator(".wiki-share-md")).toContainText("## Subagents");
  });

  test("one Escape closes the DIALOG and leaves the article open", async ({ page }) => {
    // Both the dialog and the doc panel listen for Escape on `document`. Without
    // the panel's guard, one keypress dismissed the dialog AND the article under
    // it — losing a finished post and the reader's place at once.
    await openPanel(page);
    await openShare(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#wikiShare")).toHaveCount(0);
    await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
    // …and a second Escape now closes the panel, as it always did.
    await page.keyboard.press("Escape");
    await expect(page.locator("#docOverlay")).not.toHaveClass(/visible/);
  });

  test("a click on the panel's Back button is EATEN by the scrim", async ({ page }) => {
    // Measured, not assumed (the wiki reader's pointer-navigation finding, one
    // layer up): with the dialog open, a pointer click aimed at ← Back lands on
    // the scrim instead, reads as a click-away, and closes the DIALOG — the
    // article underneath is never dismissed out from under an un-copied post.
    await openPanel(page);
    await openShare(page);
    const box = (await page.locator(".doc-panel-close").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator("#wikiShare")).toHaveCount(0);
    await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
    // …and now that the scrim is gone, Back closes the panel as it always did.
    await page.locator(".doc-panel-close").click();
    await expect(page.locator("#docOverlay")).not.toHaveClass(/visible/);
  });

  test("retargeting or closing the panel takes the dialog with it", async ({ page }) => {
    // The dialog's state is module-held: left open over a retargeted (or closed)
    // panel it would name a document nothing is showing, and Generate would
    // still summarize it. Driven through the seams themselves, because the scrim
    // makes both paths unreachable by pointer while the dialog is up.
    await openPanel(page);
    await openShare(page);
    await page.evaluate(() =>
      (globalThis as unknown as { openSummaryDoc: (a: string, b: string, c: string) => void })
        .openSummaryDoc("ai/other/Another.md", "", "youtube"),
    );
    await expect(page.locator("#wikiShare")).toHaveCount(0);
    await expect(page.locator("#docPanelTitle")).toHaveText("Another");

    await openShare(page);
    await page.evaluate(() =>
      (globalThis as unknown as { closeDocPanel: () => void }).closeDocPanel(),
    );
    await expect(page.locator("#wikiShare")).toHaveCount(0);
    await expect(page.locator("#wikiShareScrim")).toHaveCount(0);
    await expect(page.locator("#docOverlay")).not.toHaveClass(/visible/);
  });

  test("closing hands focus BACK to the Share button, not to the body behind the panel", async ({
    page,
  }) => {
    // The dialog pulls focus into itself on open (it claims `aria-modal`). Closing
    // removed the panel from under `document.activeElement`, which the browser
    // resets to `<body>` — here that is BEHIND a still-open doc-panel overlay, so
    // the reader's next Tab walks the page under the article they are reading.
    await openPanel(page);
    await openShare(page);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id ?? ""))
      .toBe("wikiSharePreset");
    await page.keyboard.press("Escape");
    await expect(page.locator("#wikiShare")).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.id ?? "")).toBe("docPanelShare");
  });

  test("an UNREGISTERED source hides the button — it has no route that could serve it", async ({
    page,
  }) => {
    // `docApiBase` falls back to `/api/youtube` for an unknown source, so a
    // hand-edited `?source=bogus` deep link opened a panel with a live Share
    // button whose POST could only ever 400.
    await openPanel(page);
    await expect(page.locator("#docPanelShare")).toBeVisible();
    await page.evaluate(() =>
      (globalThis as unknown as { openSummaryDoc: (a: string, b: string, c: string) => void })
        .openSummaryDoc("ai/other/Another.md", "", "myspace"),
    );
    await expect(page.locator("#docPanelTitle")).toHaveText("Another");
    await expect(page.locator("#docPanelShare")).toBeHidden();
    // …and it comes back for the next registered document.
    await page.evaluate(() =>
      (globalThis as unknown as { openSummaryDoc: (a: string, b: string, c: string) => void })
        .openSummaryDoc("ai/other/Another.md", "", "youtube"),
    );
    await expect(page.locator("#docPanelShare")).toBeVisible();
  });

  test("the preset list is the SUMMARIZER bot's, served without a wiki", async ({ page }) => {
    // Fetched for real. A /summaries share has no wiki to own it, so the list
    // comes from `/api/summaries/share/presets` — the wiki route would 404 on a
    // missing `?wiki=` and leave the dialog stuck on "Loading presets…".
    await openPanel(page);
    await openShare(page);
    const options = page.locator("#wikiSharePreset option");
    expect(await options.count()).toBeGreaterThan(1);
    await expect(page.locator("#wikiSharePreset")).toContainText("Slack");
    await expect(page.locator("#wikiShare")).not.toContainText("Loading presets");
  });
});
