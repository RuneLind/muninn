/**
 * `/summaries/prompts` — the capture-prompt matrix, in a browser.
 *
 * What only this tier can see:
 *
 *   1. The page really renders one row per capture source, and the two
 *      short-video rows carry the "hand-rolled envelope, no kind" chip in a cell
 *      that SPANS the kind columns rather than leaving them empty.
 *   2. Clicking a cell opens that cell's drawer, and the system prompt in it is
 *      tinted by SPANS — one element per prompt piece — rather than by a regex
 *      over the finished text.
 *   3. A per-bot `prompts/captureSummary.deep.md` written to disk turns the
 *      YouTube `deep` cell's override marker from "not present" to "present",
 *      and the structure span in that cell's drawer becomes the FILE's content.
 *      That is the whole loop the page exists for: change a file, see the prompt
 *      the capture will send.
 *
 * NO MODEL SPEND, NO HUGINN. The page composes prompts from the verticals' own
 * builders and calls nothing; `KNOWLEDGE_API_URL` is pointed at a port nothing
 * binds, so a page that reached for huginn would fail here rather than quietly
 * answering off the developer's own instance.
 *
 * The bot is a throwaway under `MUNINN_BOTS_DIR`, never under the repo's own
 * `bots/`, and it is a CLAUDE-CLI bot on purpose: `resolveCapturePresets` drops
 * the `deep` kind on every connector that cannot name the opus model, so an
 * `openai-compat` bot would have no `deep` column for case 3 to be about.
 *
 * The server is RESTARTED between case 2 and case 3: a bot's `prompts/` dir is
 * read at discovery, so a file written into a running server's bot is invisible
 * to it. `mode: "serial"` is what makes that ordering a fact rather than a hope.
 *
 * ENV PREREQUISITE: `bun run db:setup:test`. Ports come from `e2e/ports.ts`.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("summaries-prompts");
const DEAD_HUGINN = e2ePort("summaries-prompts/dead-huginn");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const BOT = "zze2eprompts";
let botsRoot: string | undefined;
let server: ChildProcess | undefined;

/**
 * The override this spec writes in case 3 — ONE line, because the structure
 * piece re-indents every line after the first and a single line is therefore
 * equal to the file's own text. Invented, like every fixture in this public
 * repo.
 */
const OVERRIDE_BODY = "- One bullet only, from the per-bot override file.";

function writeBot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "muninn-e2e-prompts-bots-"));
  mkdirSync(path.join(root, BOT), { recursive: true });
  writeFileSync(
    path.join(root, BOT, "CLAUDE.md"),
    "# e2e prompts bot\n\nCreated by e2e/summaries-prompts.spec.ts.\n",
  );
  // No `connector` key at all ⇒ `claude-cli`, which is what makes the `deep`
  // kind reachable. Nothing here ever spawns the CLI: the page runs no model.
  writeFileSync(path.join(root, BOT, "config.json"), JSON.stringify({ model: "sonnet" }, null, 2));
  botsRoot = root;
  return root;
}

function overridePath(): string {
  return path.join(botsRoot!, BOT, "prompts", "captureSummary.deep.md");
}

function removeBotsRoot(): void {
  if (botsRoot) rmSync(botsRoot, { recursive: true, force: true });
  botsRoot = undefined;
}

async function startServer(): Promise<void> {
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      // In `AMBIENT_INSTANCE_ENV`, hence after the `e2eEnv()` spread.
      MUNINN_BOTS_DIR: botsRoot!,
      // Explicit regardless: `resolveSummarizerBot`'s fallback is positional and
      // a role_overrides row in the test DB would otherwise re-point it.
      SUMMARIZER_BOT: BOT,
      KNOWLEDGE_API_URL: `http://127.0.0.1:${DEAD_HUGINN}`,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/live`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function stopServer(): Promise<void> {
  if (!server) return;
  server.kill("SIGTERM");
  server = undefined;
  // Wait for the port to be free, or the respawn races the old process's bind.
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await fetch(`${BASE}/api/live`);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error("the muninn on port " + PORT + " did not stop");
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * A hard kill (Ctrl-C, a CI cancel) skips `afterAll`. Registered in `beforeAll`
 * and removed in `afterAll`, and it RE-RAISES: a listener suppresses Node's own
 * termination, so the handler removes itself and re-sends the signal. Both rules
 * are `e2e/summaries-vimeo.spec.ts`'s, measured there.
 */
function handleSignal(signal: NodeJS.Signals): void {
  server?.kill("SIGTERM");
  removeBotsRoot();
  removeSignalHandlers();
  process.kill(process.pid, signal);
}
const onSigint = () => handleSignal("SIGINT");
const onSigterm = () => handleSignal("SIGTERM");
function addSignalHandlers(): void {
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
}
function removeSignalHandlers(): void {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}

test.beforeAll(async () => {
  writeBot();
  addSignalHandlers();
  await startServer();
});

test.afterAll(async () => {
  await stopServer();
  removeBotsRoot();
  removeSignalHandlers();
});

// Case 3 restarts the server after writing a file; the earlier cases must see
// the bot WITHOUT it.
test.describe.configure({ mode: "serial" });

/** Open the drawer of one cell and return its locator. */
async function openCell(page: Page, sourceId: string, kindId: string | null) {
  const id = `pm-drawer-${sourceId}--${kindId ?? "nokind"}`;
  await page.locator(`.pm-cell-btn[data-drawer="${id}"]`).click();
  const drawer = page.locator(`#${id}`);
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe("Summaries: the capture-prompt matrix", () => {
  test("/summaries links to it — the page's only entry point", async ({ page }) => {
    await page.goto(`${BASE}/summaries`);
    const link = page.locator("#promptsLink");
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/summaries/prompts");
    await link.click();
    await expect(page).toHaveURL(/\/summaries\/prompts$/);
    await expect(page.locator("h2")).toHaveText("Capture prompts");
  });

  test("one row per capture source, with the short-video cells spanning the kinds", async ({ page }) => {
    await page.goto(`${BASE}/summaries/prompts`);

    // The kind columns are what a claude-cli bot with no per-bot kinds offers.
    expect(
      await page.locator("thead th").evaluateAll((ths) => ths.map((t) => t.textContent!.trim())),
    ).toEqual(["Source", "Standard", "Deep (opus, full thinking)", "Talk notes (timeline)"]);

    expect(
      await page.locator("tbody tr").evaluateAll((trs) => trs.map((t) => t.getAttribute("data-source"))),
    ).toEqual(["youtube", "vimeo", "tiktok", "x-video", "x-article", "article", "anthropic"]);

    // A kind-ful source has one cell per kind…
    await expect(page.locator('tr[data-source="youtube"] td.pm-cell')).toHaveCount(3);
    // …and a kind-less one has ONE, spanning them, carrying the chip that says why.
    for (const source of ["tiktok", "x-video"]) {
      const cells = page.locator(`tr[data-source="${source}"] td.pm-cell`);
      await expect(cells).toHaveCount(1);
      await expect(cells).toHaveAttribute("colspan", "3");
      await expect(cells.locator(".pm-chip").first()).toHaveText("hand-rolled envelope, no kind");
    }
    // The text verticals say the other sentence — a different envelope, same
    // absence of a kind.
    for (const source of ["x-article", "article", "anthropic"]) {
      const cells = page.locator(`tr[data-source="${source}"] td.pm-cell`);
      await expect(cells).toHaveCount(1);
      await expect(cells.locator(".pm-chip").first()).toHaveText("shared envelope, no kind");
    }
  });

  test("a cell's drawer carries the prompts, tinted by SPANS, and the override is absent", async ({ page }, testInfo) => {
    await page.goto(`${BASE}/summaries/prompts`);

    const deep = await openCell(page, "youtube", "deep");
    // The system prompt is a sequence of piece spans, not one blob a regex
    // coloured afterwards.
    const pieceIds = await deep
      .locator(".pm-system .pm-piece")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-piece")));
    expect(pieceIds).toEqual(["intro", "envelope", "structure", "rider-windowed", "context"]);
    // …and the spans really are the prompt: their concatenation is the whole text.
    const joined = await deep.locator(".pm-system .pm-piece").evaluateAll((els) => els.map((e) => e.textContent).join(""));
    expect(joined).toBe(await deep.locator(".pm-system").textContent());
    expect(joined).toContain("Summarize the following YouTube video transcript.");
    expect(joined).toContain("Video URL: https://www.youtube.com/watch?v=placeholder");

    // The user prompt is the run's own builder over the fixed placeholder input.
    const drawerText = (await deep.textContent()) ?? "";
    expect(drawerText).toContain("### [00:02:00]");
    expect(drawerText).toContain("/tmp/muninn-capture-placeholder/frames/60.jpg — chart:");
    expect(drawerText).toContain("<takeaway>");

    // No file on disk yet.
    await expect(deep.locator("[data-override]")).toHaveText("not present");
    await expect(deep.locator(".pm-path")).toContainText(`/${BOT}/prompts/captureSummary.deep.md`);
    await page.screenshot({ path: testInfo.outputPath("youtube-deep.png"), fullPage: true });

    // A short-video cell: the hand-rolled envelope, and no override file at all.
    const tiktok = await openCell(page, "tiktok", null);
    await expect(deep).toBeHidden(); // one drawer at a time
    const tiktokPieces = await tiktok
      .locator(".pm-system .pm-piece")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-piece")));
    expect(tiktokPieces).toEqual(["envelope", "structure", "no-commentary", "context"]);
    await expect(tiktok).toContainText("Summarize the following TikTok video");
    await expect(tiktok).toContainText("produce NO commentary");
    await expect(tiktok).toContainText("no kind picker");
    await expect(tiktok.locator("[data-override]")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("tiktok.png"), fullPage: true });
  });

  test("every row names the axes the page pinned, and the Vimeo cell shows its windowed rider", async ({ page }) => {
    await page.goto(`${BASE}/summaries/prompts`);

    // A skeleton is only honest if it says which branch it took.
    await expect(page.locator('[data-fixed="youtube"]')).toContainText("windowed transcript: yes");
    await expect(page.locator('[data-fixed="vimeo"]')).toContainText("captions: auto-generated");
    await expect(page.locator('[data-fixed="vimeo"]')).toContainText("output language: English");
    await expect(page.locator('[data-fixed="anthropic"]')).toContainText("framing: Anthropic release");
    await expect(page.locator('[data-fixed="anthropic"]')).toContainText("linked-content rider: absent");
    await expect(page.locator('[data-fixed="article"]')).toContainText("author and url: both present");
    // The two short-video rows: their SYSTEM prompt has no branch, but both user
    // builders branch on an empty transcript and on an empty frame list, and the
    // page pins the present form of each. The row said "no branch" until then.
    for (const id of ["tiktok", "x-video"]) {
      await expect(page.locator(`[data-fixed="${id}"]`)).toContainText("transcript: present");
      await expect(page.locator(`[data-fixed="${id}"]`)).toContainText("keyframes: present");
    }
    // No row renders the old empty-axes wording any more.
    await expect(page.locator(".pm-fixed", { hasText: "no branch" })).toHaveCount(0);

    // Vimeo's windowed rider is a span of its own, tinted as a rider rather than
    // buried in the intro — and the cell carries the chip that names it.
    const vimeo = await openCell(page, "vimeo", "standard");
    const pieceIds = await vimeo
      .locator(".pm-system .pm-piece")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-piece")));
    expect(pieceIds).toEqual([
      "intro",
      "rider-windowed",
      // The intro block's own trailing separator — intro bytes, intro span.
      "intro",
      "envelope",
      "structure",
      "context",
      "rider-auto-caption",
      "rider-language",
    ]);
    const joined = await vimeo
      .locator(".pm-system .pm-piece")
      .evaluateAll((els) => els.map((e) => e.textContent).join(""));
    expect(joined).toBe(await vimeo.locator(".pm-system").textContent());
    // One per kind column — the chip belongs to the CELL, and this bot offers three.
    await expect(page.locator('tr[data-source="vimeo"] td.pm-cell')).toHaveCount(3);
    await expect(
      page.locator('tr[data-source="vimeo"] .pm-chip', { hasText: "windowed transcript rider" }),
    ).toHaveCount(3);
  });

  test("the table is labelled, and every cell button has a name a chip bag cannot give it", async ({ page }) => {
    await page.goto(`${BASE}/summaries/prompts`);
    await expect(page.locator("table.pm-table caption")).toContainText("Capture sources down");
    expect(
      await page
        .locator(".pm-cell-btn")
        .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))),
    ).toEqual([
      "Open the youtube/standard prompt",
      "Open the youtube/deep prompt",
      "Open the youtube/talk-notes prompt",
      "Open the vimeo/standard prompt",
      "Open the vimeo/deep prompt",
      "Open the vimeo/talk-notes prompt",
      "Open the tiktok/no kind prompt",
      "Open the x-video/no kind prompt",
      "Open the x-article/no kind prompt",
      "Open the article/no kind prompt",
      "Open the anthropic/no kind prompt",
    ]);
  });

  /**
   * The whole document must never scroll sideways: the table has its own
   * scroller, but the drawer's `<code class="pm-path">` is a single unbreakable
   * ~70-character bot path OUTSIDE it, and without `overflow-wrap` it pushed the
   * page wider than the viewport on a phone.
   */
  test("at 390 px, with a drawer open, the document does not scroll sideways", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto(`${BASE}/summaries/prompts`);
    await openCell(page, "youtube", "deep");
    // The path really is on the page and really is long — otherwise this passes
    // for want of anything to overflow.
    const pathText = (await page.locator(".pm-drawer:not([hidden]) .pm-path").textContent()) ?? "";
    expect(pathText.length).toBeGreaterThan(40);
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  /**
   * Every tinted span and the "not present" badge, as CONTRAST RATIOS computed
   * from what the browser resolved — never a comparison of a token against a
   * re-typed literal, which passes whatever the value is. Both themes: the tint
   * ramp this page started on read fine on dark and failed AA on light.
   */
  for (const scheme of ["dark", "light"] as const) {
    test(`every prompt tint and the absent badge clear 4.5:1 — ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${BASE}/summaries/prompts`);
      await openCell(page, "vimeo", "standard");

      const ratios = await page.evaluate(() => {
        const lum = (css: string): number => {
          const [r, g, b] = css.match(/[\d.]+/g)!.slice(0, 3).map((n) => Number(n) / 255);
          const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
          return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
        };
        const ratio = (fg: string, bg: string): number => {
          const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
          return (hi! + 0.05) / (lo! + 0.05);
        };
        const out: Record<string, number> = {};
        // The background is read off the one VISIBLE prompt block (every drawer
        // shares the rule); the spans come from every drawer on the page, so a
        // piece that only appears in a closed one is measured too.
        const pre = document.querySelector(".pm-drawer:not([hidden]) .pm-system")!;
        const preBg = getComputedStyle(pre).backgroundColor;
        for (const span of Array.from(document.querySelectorAll<HTMLElement>(".pm-system .pm-piece"))) {
          out[span.dataset["piece"]!] = ratio(getComputedStyle(span).color, preBg);
        }
        const badge = document.querySelector<HTMLElement>(".pm-drawer:not([hidden]) .pm-badge-off")!;
        const bs = getComputedStyle(badge);
        out["badge-off"] = ratio(bs.color, bs.backgroundColor);
        return out;
      });

      // The probe found real elements, not an empty set that trivially passes.
      expect(Object.keys(ratios).sort()).toEqual([
        "badge-off",
        "context",
        "envelope",
        "intro",
        "no-commentary",
        "rider-auto-caption",
        "rider-language",
        "rider-windowed",
        "structure",
      ]);
      for (const [name, value] of Object.entries(ratios)) {
        expect(value, `${name} on ${scheme}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  test("a per-bot captureSummary.deep.md becomes the deep cell's structure, marked present", async ({ page }) => {
    test.setTimeout(90_000);
    mkdirSync(path.dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), OVERRIDE_BODY);
    // A bot's `prompts/` dir is read at DISCOVERY, so the running server cannot
    // see the file that was just written.
    await stopServer();
    await startServer();

    await page.goto(`${BASE}/summaries/prompts`);
    const deep = await openCell(page, "youtube", "deep");
    await expect(deep.locator("[data-override]")).toHaveText("present");
    // The tinted structure span IS the file's content — the loop the page is for.
    await expect(deep.locator(".pm-system .pm-piece-structure")).toHaveText(OVERRIDE_BODY);
    // The shipped bullets it replaced are gone from this cell…
    await expect(deep.locator(".pm-system")).not.toContainText("Then a `## Key takeaways` section FIRST");
    // …and only from this cell: `standard` still ships its own.
    const standard = await openCell(page, "youtube", "standard");
    await expect(standard.locator(".pm-system")).toContainText("Then a `## Key takeaways` section FIRST");
    await expect(standard.locator("[data-override]")).toHaveText("not present");
  });
});
