/**
 * /wiki reader — the 📤 Share dialog, end-to-end.
 *
 * Three things no unit test can prove, and the first one is how a dialog on this
 * page has already broken once:
 *   1. **The dialog is opaque.** The chat dialog shipped fully TRANSPARENT because
 *      its background named `var(--bg-elevated)`, a token defined only in the chat
 *      page's own styles — an invalid declaration a pure test cannot see. Every
 *      dialog added to this page gets the computed-background assertion.
 *   2. **The format tabs switch**, and each shows its own rendering: Slack
 *      (mrkdwn, rendered by the shared browser renderer), Email (the inline-styled
 *      body), Markdown (the raw source). Telegram is NOT a tab in v1.
 *   3. **Copy writes the clipboard** — the actual `navigator.clipboard` path, read
 *      back through a granted permission rather than a stubbed API.
 *
 * NO MODEL CALLS AND NO SPEND: exactly one route is stubbed at the network
 * boundary — `POST /api/wiki/share`, replayed as a canned SSE body. The preset
 * fetch is real (it is read-only and model-free), so the picker, the prompt panel
 * and the request body are exercised against the real server.
 *
 * It boots its OWN muninn on a dedicated port with a temp `WIKI_EXTRA` wiki
 * (the `wiki-chat-dialog` pattern), pinned to a discovered bot so the preset route
 * resolves one.
 *
 * ENV PREREQUISITE: a working `.env` (`DATABASE_URL` at minimum) at the repo root.
 * PLATFORM TOKENS: `blankBotTokens()` keeps this muninn off Telegram/Slack.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { blankBotTokens } from "./blank-bot-tokens.ts";

const PORT = 3027;
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI = "e2e-share";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

/** Title (what the breadcrumb shows) vs page NAME (the file stem — what
 *  `index.resolve` takes, and what the client must post). */
const PAGE_NAME = "Wiki gardener";
const PAGE_STEM = "gardener";
/** A second page, so navigation away from the first can be driven. The store's
 *  page NAME is the file stem; the title is what the breadcrumb shows. */
const OTHER_STEM = "linter";
const OTHER_TITLE = "Wiki linter";
const PAGES: Record<string, string> = {
  "gardener.md": [
    "---",
    "title: Wiki gardener",
    "type: concept",
    "---",
    "",
    "# Wiki gardener",
    "",
    "The gardener clusters summaries into wiki-page proposals.",
    "",
  ].join("\n"),
  "linter.md": [
    "---",
    "title: Wiki linter",
    "type: concept",
    "---",
    "",
    "# Wiki linter",
    "",
    "The linter reports hygiene findings over the index.",
    "",
  ].join("\n"),
};

/** The canned post the stubbed route "generates". Markdown on the wire; the three
 *  renderings below are what the tabs must show. */
const MARKDOWN = "## Gardener\n\nIt clusters **summaries** into proposals.";
const SLACK = "*Gardener*\n\nIt clusters *summaries* into proposals.";
/** Carries a LINK on purpose: `formatEmailHtml` output is the exact rich text the
 *  copy button puts on the clipboard, so the "open in a new tab" fix has to be
 *  applied to the inserted preview and NOT baked into the renderer. */
const MAIL_HTML =
  '<h2 style="font-size:18px">Gardener</h2><p>It clusters <strong>summaries</strong> into ' +
  '<a href="https://example.com/proposals">proposals</a>.</p>';

/** The stub's SSE body: two deltas, then the three-string `done`, then `end`. */
function shareSseBody(): string {
  const frame = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    frame("delta", { type: "delta", text: "## Gardener\n\n" }) +
    frame("delta", { type: "delta", text: "It clusters **summaries** into proposals." }) +
    frame("done", { markdown: MARKDOWN, slack: SLACK, mailHtml: MAIL_HTML }) +
    frame("end", {})
  );
}

let server: ChildProcess | undefined;
let root = "";

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
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-share-"));
  for (const [name, body] of Object.entries(PAGES)) {
    await writeFile(path.join(root, name), body, "utf8");
  }
  const bot = await firstBotName();
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...blankBotTokens(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      // name=path[=collections][=synthesisBotPin] — no collections (share needs
      // none), pin so the preset route resolves a bot.
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

/** Every POST body the stub saw, so a test can assert the client→route contract
 *  (which the stub would otherwise hide completely). Reset per `openShare`. */
let posted: Record<string, unknown>[] = [];

/** Open the article and its Share dialog. The generate route is stubbed for every
 *  test in this file — no model call is ever made. */
async function openShare(page: import("@playwright/test").Page): Promise<void> {
  posted = [];
  await page.route("**/api/wiki/share", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posted.push(JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: shareSseBody(),
    });
  });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&page=${encodeURIComponent(PAGE_NAME)}`);
  await page.locator("#wikiShareBtn").click();
  await expect(page.locator("#wikiShare")).toBeVisible();
  // The preset fetch is real; wait for the picker it fills.
  await expect(page.locator("#wikiSharePreset")).toBeVisible();
}

async function generate(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("#wikiShareGen").click();
  await expect(page.locator(".wiki-share-tabs")).toBeVisible();
}

test.describe("Wiki reader: share dialog", () => {
  test("the dialog paints an OPAQUE background over the page", async ({ page }) => {
    await openShare(page);
    const bg = await page
      .locator("#wikiShare")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    // The chat dialog's bug rendered `rgba(0, 0, 0, 0)`.
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("transparent");
    const alpha = /rgba?\([^)]*?(?:,\s*([\d.]+))?\)$/.exec(bg)?.[1];
    if (alpha !== undefined) expect(Number(alpha)).toBeGreaterThan(0.9);
    await expect(page.locator("#wikiShareScrim")).toBeVisible();
  });

  test("the prompt is visible and editable, and switching preset replaces it", async ({ page }) => {
    await openShare(page);
    // The prompt panel is collapsed by default (the preset IS the prompt for most
    // shares) and its open state is STATE-held — a DOM-only `open` would collapse
    // under the reader on the first keystroke, since typing repaints the panel.
    await page.locator("#wikiSharePromptPanel summary").click();
    const prompt = page.locator("#wikiSharePrompt");
    await expect(prompt).toBeVisible();
    const first = await prompt.inputValue();
    expect(first.length).toBeGreaterThan(0);
    // Editing flags it — a reader can never generate from an edit they forgot.
    await prompt.fill("Write two bullets.");
    await expect(page.locator(".wiki-share-edited")).toBeVisible();
    // A different preset shows ITS instruction, not the stale edit.
    await page.locator("#wikiSharePreset").selectOption("slack-dev-security");
    await expect(prompt).not.toHaveValue("Write two bullets.");
    await expect(page.locator(".wiki-share-edited")).toHaveCount(0);
    // …and the panel is still open across that repaint.
    await expect(prompt).toBeVisible();
  });

  test("the POST body is the contract the route parses — `page` is the NAME", async ({ page }) => {
    // The stub hides this completely otherwise: a client that posted a relPath (or
    // dropped `wiki`/`preset`/`lang`) would pass every other test in this file and
    // fail against the real route, which resolves `page` with `index.resolve`.
    await openShare(page);
    await generate(page);
    expect(posted).toHaveLength(1);
    const body = posted[0]!;
    // The page NAME the store indexes by (the stem) — NOT the title, and not a
    // relPath (which carries directories and an extension the route would fail to
    // resolve). `?page=` in the URL is title-tolerant; this POST field is not.
    expect(body.page).toBe(PAGE_STEM);
    expect(String(body.page)).not.toContain(".md");
    expect(String(body.page)).not.toContain("/");
    expect(body.wiki).toBe(WIKI);
    expect(typeof body.preset).toBe("string");
    expect(String(body.preset).length).toBeGreaterThan(0);
    expect(["en", "nb"]).toContain(body.lang);
    // Unedited ⇒ no promptOverride at all (the route 400s a blank one, and echoing
    // the preset back would freeze wording the bot may since have overridden).
    expect(body.promptOverride).toBeUndefined();
  });

  test("Generate streams, then shows Slack | Email | Markdown — and no Telegram", async ({
    page,
  }) => {
    await openShare(page);
    await generate(page);
    const tabs = page.locator(".wiki-share-tab");
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toHaveText("Slack");
    await expect(tabs.nth(1)).toHaveText("Email");
    await expect(tabs.nth(2)).toHaveText("Markdown");
    await expect(page.locator("#wikiShare")).not.toContainText("Telegram");
  });

  test("each tab renders its OWN string", async ({ page }) => {
    await openShare(page);
    await generate(page);
    // Slack: the shared browser mrkdwn renderer turns *bold* into <strong>.
    const slack = page.locator(".wiki-share-slack");
    await expect(slack).toBeVisible();
    await expect(slack.locator("strong").first()).toHaveText("Gardener");
    // Email: the server's inline-styled body, verbatim.
    await page.locator('[data-share-tab="email"]').click();
    const mail = page.locator(".wiki-share-mail");
    await expect(mail).toBeVisible();
    await expect(mail.locator("h2")).toHaveText("Gardener");
    // Markdown: the raw source, shown as text (the `##` is visible, not a heading).
    await page.locator('[data-share-tab="markdown"]').click();
    const md = page.locator(".wiki-share-md");
    await expect(md).toBeVisible();
    await expect(md).toContainText("## Gardener");
    await expect(md).toContainText("**summaries**");
  });

  test("Copy writes the active tab's text to the real clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openShare(page);
    await generate(page);
    // Markdown tab: a plain-text write, which readText can read back verbatim.
    await page.locator('[data-share-tab="markdown"]').click();
    await page.locator("#wikiShareCopy").click();
    await expect(page.locator("#wikiShareCopy")).toContainText("Copied");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(MARKDOWN);
    // …and the Slack tab copies the mrkdwn, not the markdown.
    await page.locator('[data-share-tab="slack"]').click();
    await page.locator("#wikiShareCopy").click();
    await expect(page.locator("#wikiShareCopy")).toContainText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SLACK);
  });

  test("an over-budget Slack rendering warns before it is pasted", async ({ page }) => {
    // The acceptance test the campaign named: past ~4000 characters Slack turns a
    // paste into a collapsed file snippet nobody reads.
    const long = "x".repeat(4100);
    await page.route("**/api/wiki/share", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body:
          `event: done\ndata: ${JSON.stringify({ markdown: long, slack: long, mailHtml: "<p>x</p>" })}\n\n` +
          "event: end\ndata: {}\n\n",
      });
    });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&page=${encodeURIComponent(PAGE_NAME)}`);
    await page.locator("#wikiShareBtn").click();
    await expect(page.locator("#wikiSharePreset")).toBeVisible();
    await generate(page);
    await expect(page.locator(".wiki-share-warn")).toContainText("snippet");
    // …and it is a Slack-tab concern only.
    await page.locator('[data-share-tab="markdown"]').click();
    await expect(page.locator(".wiki-share-warn")).toHaveCount(0);
  });

  test("a link in the EMAIL preview opens in a new tab, not over the un-copied post", async ({
    page,
  }) => {
    // The dialog's state is module-held and does not survive a page load, so a
    // same-tab navigation from the preview destroys a finished post the reader has
    // not copied yet. The fix is preview-only by necessity: `mailHtml` IS the
    // clipboard payload, and a `target=` baked into `formatEmailHtml` would ride
    // into every pasted email.
    await openShare(page);
    await generate(page);
    await page.locator('[data-share-tab="email"]').click();
    const link = page.locator(".wiki-share-mail a");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
    // …and the copied rich text is still the SERVER's bytes, untouched.
    expect(MAIL_HTML).not.toContain("target=");
  });

  test("opening the dialog moves focus into it — it claims aria-modal", async ({ page }) => {
    // Focus left on the 📤 button behind the scrim is a lie to a screen reader,
    // and leaves a keyboard reader outside the panel Tab is trapped inside of.
    await openShare(page);
    const activeId = () => page.evaluate(() => document.activeElement?.id ?? "");
    const inPanel = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        return !!el && !!document.getElementById("wikiShare")?.contains(el);
      });
    expect(await inPanel()).toBe(true);
    // …and it lands on the PICKER, not on ✕. The loading paint (no picker yet)
    // parks focus on the dismiss button; the paint that brings the picker has to
    // take it, or the reader's first Tab starts from "close this dialog".
    // Measured before the fix: `wikiShareClose`, because the ✕ this module had
    // focused itself read as the reader already being somewhere.
    await expect.poll(activeId).toBe("wikiSharePreset");
  });

  test("a chip click does NOT yank focus back to the preset picker", async ({ page }) => {
    // The other half of the same bug. The language/tab chips carry no id, so the
    // render's focus capture returns null on a chip click — and a still-armed
    // autofocus answered that by moving focus onto the `<select>`, deterministically
    // on the first chip click of every open. The flag must retire on the picker
    // paint, so every later paint leaves focus alone.
    await openShare(page);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id ?? ""))
      .toBe("wikiSharePreset");
    await page.locator('[data-share-lang="nb"]').click();
    await expect(page.locator('[data-share-lang="nb"].is-active')).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.id ?? "")).not.toBe("wikiSharePreset");
  });

  test("a POINTER navigation can't strand the dialog — the scrim eats the click", async ({
    page,
  }) => {
    // Measured, not assumed: with the dialog open, a click on a left-list row does
    // not reach the row at all. The scrim is `position: fixed; inset: 0` above the
    // page, so the click lands there, reads as a click-away, and closes the dialog
    // WITHOUT navigating. (Tab is trapped in the panel, so the keyboard can't reach
    // those rows either.) This is why only `popstate` — the next test — could ever
    // leave the dialog pointing at a page the reader had left.
    await openShare(page);
    const row = page.locator(`.wiki-list-item[data-page="${OTHER_STEM}"]`);
    await expect(row).toBeVisible();
    await expect(
      page.locator("#wikiShareScrim").evaluate((el, r) => {
        const box = (r as HTMLElement).getBoundingClientRect();
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === el;
      }, await row.elementHandle()),
    ).resolves.toBe(true);
    // One real click: dialog gone, page unchanged.
    await row.click({ trial: false, force: true, position: { x: 5, y: 5 } }).catch(() => {});
    await expect(page.locator(".wiki-bc-cur")).toHaveText(PAGE_NAME);
  });

  test("Back/popstate CLOSES the dialog instead of stranding it on the page you left", async ({
    page,
  }) => {
    // popstate involves NO click, so the click-away listener never fires. A
    // surviving dialog then targets the page the reader has just left: Generate
    // would summarize the wrong article, under the new article's breadcrumb, and
    // the header would still name the old one. `renderBreadcrumb` closes it, the
    // same seam the Discuss dialog uses (`shouldCloseArticleChatOnNavigate`).
    // An SPA navigation (a list-row click pushes history), so Back is a real
    // `popstate` into `loadPage` — NOT a document reload, which would destroy the
    // dialog for free and prove nothing.
    await openShare(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#wikiShare")).toHaveCount(0);
    await page.locator(`.wiki-list-item[data-page="${OTHER_STEM}"]`).click();
    await expect(page.locator(".wiki-bc-cur")).toHaveText(OTHER_TITLE);

    await page.locator("#wikiShareBtn").click();
    await expect(page.locator("#wikiShare")).toBeVisible();
    await page.goBack();
    await expect(page.locator(".wiki-bc-cur")).toHaveText(PAGE_NAME);
    await expect(page.locator("#wikiShare")).toHaveCount(0);
    await expect(page.locator("#wikiShareScrim")).toHaveCount(0);
  });

  test("a 409 tells the reader when the page frees up, instead of failing opaquely", async ({
    page,
  }) => {
    // Readable only because the client consumes this route with fetch: an
    // EventSource exposes neither the status nor the body of a non-200.
    await page.route("**/api/wiki/share", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ state: "running", expiresAtMs: Date.now() + 45_000 }),
      });
    });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&page=${encodeURIComponent(PAGE_NAME)}`);
    await page.locator("#wikiShareBtn").click();
    await expect(page.locator("#wikiSharePreset")).toBeVisible();
    await page.locator("#wikiShareGen").click();
    await expect(page.locator(".wiki-share-status")).toContainText("already running");
    await expect(page.locator(".wiki-share-status")).toContainText("frees up");
  });
});
