/**
 * `/summaries` — capture a Vimeo video by pasting its URL, end to end.
 *
 * Vimeo is the one capture vertical with NO Chrome extension: the whole entry
 * point is the URL field this PR adds, so the field is the acceptance surface.
 * What only this tier can see:
 *
 *   1. The paste reaches `POST /api/vimeo/summarize`, the job card appears, and
 *      the status walk really ends at `complete` with the summary on screen.
 *   2. A second paste of the same URL answers `duplicate` and starts NOTHING —
 *      no second job, no second capture. (This exercises dedup **state 3**, the
 *      recently-ingested map: the fake huginn's listing stays EMPTY throughout,
 *      exactly like a real reindex that has not caught up yet.)
 *   3. Each route refusal renders as a SENTENCE about the video rather than a
 *      generic failure — `not_public` and the 3 h cap are both driven here.
 *   4. A bare non-Vimeo link in the ARTICLE textarea still gets the Chrome
 *      extension alert, byte for byte, and POSTs nothing to the capture route.
 *   5. A Vimeo link pasted into that same textarea is forwarded to the capture —
 *      pasting into the wrong box works.
 *
 * NO MODEL SPEND, NO CHROMIUM, NO LIVE VIMEO. Three seams do it, and all three
 * are shipped code rather than test-only branches:
 *
 *   - `VIMEO_HARVEST_STUB` replaces the browser half with the committed `.vtt`
 *     fixture (PR 1/2's own backdoor, gated on the default serving profile);
 *   - `VIMEO_OEMBED_BASE` points the metadata half at the fake below;
 *   - the SUMMARIZER BOT is a throwaway `openai-compat` bot this file creates,
 *     whose `baseUrl` is the same fake. That is the cheapest honest path to a
 *     model-free summarize: the connector seam PR 2's unit tests use
 *     (`oneShot` / `mock.module`) does not exist in a spawned process, jarvis is
 *     `claude-sdk` and CI has no Anthropic credential at all, so a real call
 *     would not merely be slow — it would fail on CI. The bot folder is removed
 *     in `afterAll`; a leftover is inert-ish by construction (see BOT_DIR).
 *
 * ONE fake `node:http` server plays all three remote halves — Vimeo's oEmbed
 * endpoint, huginn, and the OpenAI-compatible model API — on different paths.
 * Playwright runs this file under NODE, hence `node:http`.
 *
 * ENV PREREQUISITE: `bun run db:setup:test` (the TEST database). Ports come from
 * `e2e/ports.ts` — never a literal.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("summaries-vimeo");
const FAKE_PORT = e2ePort("summaries-vimeo/fake");
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

/** The committed 928-cue fixture — resolved from this file, never a user path. */
const FIXTURE = path.join(REPO_ROOT, "src/vimeo/fixtures/totto-trust-but-verify.vtt");

/**
 * A throwaway summarizer bot, created and removed by this spec.
 *
 * `bots/*` is gitignored apart from jarvis, so it never dirties the tree. Two
 * things bound the blast radius of a leftover after a hard kill: the name sorts
 * LAST (`resolveSummarizerBot`'s no-env fallback is the FIRST discovered bot),
 * and it carries no platform token, so `discoverBots()` — the runtime that opens
 * Telegram/Slack connections — skips it entirely. It is still visible to
 * `discoverAllBots()`, which is exactly why it is removed in `afterAll` and
 * again before each run.
 */
const BOT = "zze2evimeo";
const BOT_DIR = path.join(REPO_ROOT, "bots", BOT);

/** The happy-path video: oEmbed answers, the fixture stands in for its captions. */
const VIDEO_ID = "1223358361";
const VIDEO_URL = `https://vimeo.com/${VIDEO_ID}`;
/** A second capture, for the "pasted into the article box" case. */
const OTHER_ID = "1223642971";
const OTHER_URL = `https://vimeo.com/${OTHER_ID}`;
/** oEmbed 404s on this one — "not public". */
const PRIVATE_URL = "https://vimeo.com/1";
/** 20 000 s of video — past the 3 h cap. */
const LONG_URL = "https://vimeo.com/9999999999";

const SUMMARY_LINE = "Trust, but verify.";
/** Byte-identical to the string in `sum-submit-form.ts`. */
const BARE_LINK_ALERT =
  "This looks like a bare link. YouTube and X posts are captured with the Muninn Chrome extension — open the page and click the extension. This form wants the pasted article text itself.";

let server: ChildProcess | undefined;
let fake: Server | undefined;
/** Every ingest body the fake received — one per capture that reached huginn. */
let ingests: unknown[] = [];
/** How many model calls were made. */
let modelCalls = 0;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
  });
}

/** oEmbed's answer for one video id, or null when it should 404. */
function oembedFor(id: string): Record<string, unknown> | null {
  if (id === VIDEO_ID) {
    return { title: "E2E talk", author_name: "x", duration: 100, upload_date: "2026-09-04 10:00:00" };
  }
  if (id === OTHER_ID) {
    return { title: "E2E talk two", author_name: "x", duration: 120, upload_date: "2026-09-04 11:00:00" };
  }
  if (id === "9999999999") {
    return { title: "E2E long talk", author_name: "x", duration: 20000, upload_date: "2026-09-04 12:00:00" };
  }
  return null;
}

/** One OpenAI-compatible streamed completion, in the CATEGORY/SUMMARY envelope
 *  every capture vertical's parser expects. */
async function writeCompletion(res: ServerResponse): Promise<void> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const chunk = (delta: Record<string, unknown>) =>
    `data: ${JSON.stringify({ model: "e2e-fake", choices: [{ index: 0, delta }] })}\n\n`;
  res.write(chunk({ content: "CATEGORY: tech\n\nSUMMARY:\n" }));
  // A real summarize is minutes; this delay is what makes `Summarizing` an
  // observable state on the card rather than a frame nobody can catch.
  await new Promise((r) => setTimeout(r, 600));
  res.write(chunk({ content: `## Key takeaways\n\n${SUMMARY_LINE}` }));
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

async function startFake(): Promise<Server> {
  const srv = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const p = decodeURIComponent(url.pathname);
      const json = (body: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      // --- Vimeo oEmbed (VIMEO_OEMBED_BASE) ---
      if (p === "/api/oembed.json") {
        const target = url.searchParams.get("url") ?? "";
        const id = /vimeo\.com\/(\d+)/.exec(target)?.[1] ?? "";
        const body = oembedFor(id);
        if (!body) return json({ error: "not found" }, 404);
        return json(body);
      }

      // --- The model API (the throwaway bot's baseUrl) ---
      if (p === "/v1/chat/completions") {
        modelCalls += 1;
        await readBody(req);
        return await writeCompletion(res);
      }

      // --- huginn (KNOWLEDGE_API_URL) ---
      if (p === "/api/vimeo/ingest") {
        ingests.push(JSON.parse((await readBody(req)) || "{}"));
        // A real reindex lags; the listing below deliberately never learns about
        // this document, so dedup has to come from the route's own map.
        await new Promise((r) => setTimeout(r, 300));
        return json({ file_path: "ai/general/E2E talk.md", similar: [] });
      }
      if (p.startsWith("/api/collection/") && p.endsWith("/documents")) {
        return json({ documents: [] });
      }
      if (p === "/api/search") return json({ results: [] });
      return json({});
    })();
  });
  await new Promise<void>((resolve) => srv.listen(FAKE_PORT, "127.0.0.1", resolve));
  return srv;
}

function writeBot(): void {
  rmSync(BOT_DIR, { recursive: true, force: true });
  mkdirSync(BOT_DIR, { recursive: true });
  writeFileSync(path.join(BOT_DIR, "CLAUDE.md"), "# e2e summarizer\n\nCreated by e2e/summaries-vimeo.spec.ts.\n");
  writeFileSync(
    path.join(BOT_DIR, "config.json"),
    JSON.stringify({ connector: "openai-compat", model: "e2e-fake", baseUrl: `${FAKE}/v1`, timeoutMs: 60000 }, null, 2),
  );
}

/** The statuses the card's badge went through, in order, without duplicates. */
async function installStatusRecorder(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __statuses?: string[] };
    w.__statuses = [];
    const badge = document.getElementById("statusBadge");
    if (!badge) return;
    new MutationObserver(() => {
      const text = (badge.querySelector(".status-text")?.textContent ?? "").trim();
      if (text && w.__statuses![w.__statuses!.length - 1] !== text) w.__statuses!.push(text);
    }).observe(badge, { childList: true, subtree: true, characterData: true });
  });
}

async function jobCount(request: import("@playwright/test").APIRequestContext): Promise<number> {
  const res = await request.get(`${BASE}/api/vimeo/jobs`);
  const body = (await res.json()) as { jobs?: unknown[] };
  return (body.jobs ?? []).length;
}

test.beforeAll(async () => {
  writeBot();
  fake = await startFake();
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      // AFTER the spread: both VIMEO_* names are in `AMBIENT_INSTANCE_ENV`, so
      // `e2eEnv()` blanks them and a spec that set them earlier would be handing
      // the server an empty string.
      VIMEO_OEMBED_BASE: FAKE,
      VIMEO_HARVEST_STUB: FIXTURE,
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      SUMMARIZER_BOT: BOT,
      KNOWLEDGE_API_URL: FAKE,
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
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  fake?.close();
  rmSync(BOT_DIR, { recursive: true, force: true });
});

// The dedup case reads state the capture case created, so a failure of the first
// must skip the second rather than reporting a second, derived failure.
test.describe.configure({ mode: "serial" });

test.describe("Summaries: capture a Vimeo URL", () => {
  test("a pasted URL walks the job card to complete", async ({ page }) => {
    // The capture is a stubbed harvest plus a faked model call, but it is still
    // an SSE-driven multi-phase job; the default 30 s is tight for it.
    test.setTimeout(90_000);
    const posts: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/api/vimeo/summarize")) posts.push(req.url());
    });

    await page.goto(`${BASE}/summaries`);
    await installStatusRecorder(page);

    await page.locator("#captureUrl").fill(VIDEO_URL);
    await page.locator("#captureUrlBtn").click();

    // The card appears and the field clears (the capture was adopted).
    await expect(page.locator("#jobCard")).toBeVisible();
    await expect(page.locator("#captureUrl")).toHaveValue("");

    await expect(page.locator("#statusBadge .status-text")).toHaveText("Complete", { timeout: 60_000 });
    await expect(page.locator("#summaryArea")).toContainText(SUMMARY_LINE);
    // The card's title links to the video the reader pasted.
    await expect(page.locator("#jobTitle a")).toHaveAttribute("href", VIDEO_URL);

    // The walk, not just its end state.
    const statuses = (await page.evaluate(() => (window as unknown as { __statuses: string[] }).__statuses)) ?? [];
    expect(statuses).toContain("Summarizing");
    expect(statuses).toContain("Indexing");
    expect(statuses[statuses.length - 1]).toBe("Complete");
    expect(statuses.indexOf("Summarizing")).toBeLessThan(statuses.indexOf("Indexing"));

    expect(posts).toHaveLength(1);
    expect(ingests).toHaveLength(1);
    expect(ingests[0]).toMatchObject({ url: VIDEO_URL, caption_kind: "stub", duration_sec: 100 });
    expect(await jobCount(page.request)).toBe(1);
  });

  test("pasting the same URL again says 'Already captured' and starts nothing", async ({ page }) => {
    const modelCallsBefore = modelCalls;
    const jobsBefore = await jobCount(page.request);

    await page.goto(`${BASE}/summaries`);
    await page.locator("#captureUrl").fill(VIDEO_URL);
    await page.locator("#captureUrlBtn").click();

    const banner = page.locator("#errorBanner");
    await expect(banner).toContainText("Already captured");
    await expect(banner).toHaveClass(/notice/);
    await expect(banner.locator("a")).toHaveAttribute("href", /doc=/);
    await expect(page.locator("#statusBadge .status-text")).toHaveText("Already captured");

    // Nothing ran: no new job, no second harvest, no second model call. The
    // fake's listing is still EMPTY, so this answer came from the route's
    // recently-ingested map — dedup state 3, the reindex window.
    expect(await jobCount(page.request)).toBe(jobsBefore);
    expect(modelCalls).toBe(modelCallsBefore);
    expect(ingests).toHaveLength(1);
  });

  test("a video Vimeo will not describe is a sentence, and starts no job", async ({ page }) => {
    const jobsBefore = await jobCount(page.request);
    await page.goto(`${BASE}/summaries`);
    await page.locator("#captureUrl").fill(PRIVATE_URL);
    await page.locator("#captureUrlBtn").click();

    await expect(page.locator("#errorBanner")).toHaveText("Vimeo says this video is not public");
    await expect(page.locator("#statusBadge .status-text")).toHaveText("Error");
    // A refusal leaves the reader's text where they can fix it.
    await expect(page.locator("#captureUrl")).toHaveValue(PRIVATE_URL);
    expect(await jobCount(page.request)).toBe(jobsBefore);
  });

  test("a video past the 3 h cap says so, with the measurement", async ({ page }) => {
    const jobsBefore = await jobCount(page.request);
    await page.goto(`${BASE}/summaries`);
    await page.locator("#captureUrl").fill(LONG_URL);
    await page.locator("#captureUrlBtn").click();

    await expect(page.locator("#errorBanner")).toHaveText("Longer than the 3 h cap (5h 33m)");
    expect(await jobCount(page.request)).toBe(jobsBefore);
  });

  test("a bare non-Vimeo link in the article box still points at the Chrome extension", async ({ page }) => {
    const posts: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/api/vimeo/summarize")) posts.push(req.url());
    });
    const dialogs: string[] = [];
    page.on("dialog", async (d) => {
      dialogs.push(d.message());
      await d.accept();
    });

    await page.goto(`${BASE}/summaries`);
    await page.locator("#pasteToggleBtn").click();
    await page.locator("#articleText").fill("https://youtube.com/watch?v=abc");
    await page.locator("#submitBtn").click();

    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toBe(BARE_LINK_ALERT);
    expect(posts).toEqual([]);
  });

  test("a Vimeo link in the article box is forwarded to the same capture", async ({ page }) => {
    test.setTimeout(90_000);
    const dialogs: string[] = [];
    page.on("dialog", async (d) => {
      dialogs.push(d.message());
      await d.accept();
    });

    await page.goto(`${BASE}/summaries`);
    await page.locator("#pasteToggleBtn").click();
    await page.locator("#articleText").fill(OTHER_URL);
    await page.locator("#submitBtn").click();

    await expect(page.locator("#jobCard")).toBeVisible();
    await expect(page.locator("#statusBadge .status-text")).toHaveText("Complete", { timeout: 60_000 });
    await expect(page.locator("#summaryArea")).toContainText(SUMMARY_LINE);
    await expect(page.locator("#articleText")).toHaveValue("");
    expect(dialogs).toEqual([]);
  });
});
