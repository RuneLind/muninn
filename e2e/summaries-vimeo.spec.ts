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
 *   6. A paste that lands WHILE a capture is streaming is a banner and nothing
 *      else: the running card is not repainted and its stream is not re-opened,
 *      so the whole summary still arrives.
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
 *     would not merely be slow — it would fail on CI. The bot lives in an OS
 *     TEMP directory the server is pointed at with `MUNINN_BOTS_DIR`; nothing is
 *     ever written under the repo's own `bots/` (see the BOT block below).
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
 * It lives in a fresh OS temp directory the spawned server is pointed at with
 * `MUNINN_BOTS_DIR`, and NOTHING is ever written under the repo's own `bots/`.
 *
 * That directory is process-external state shared with the developer's machine,
 * and the two bounds first claimed for a leftover there are both false:
 * `discoverBotsInternal` iterates raw `readdirSync` order, which is not
 * alphabetical (measured on this volume), so "the name sorts LAST" does not hold
 * and `resolveSummarizerBot`'s no-env fallback — the FIRST discovered bot — could
 * land on a dead `127.0.0.1:<port>`; and being invisible to `discoverBots()` is
 * no help at all, because every capture path resolves through
 * `discoverAllBots()`. Under local parallel workers, other specs' servers
 * discovered it too.
 *
 * The temp root is created per RUN and removed in `afterAll` and on a signal.
 */
const BOT = "zze2evimeo";
let botsRoot: string | undefined;

/** The happy-path video: oEmbed answers, the fixture stands in for its captions. */
const VIDEO_ID = "1223358361";
const VIDEO_URL = `https://vimeo.com/${VIDEO_ID}`;
/** A second capture, for the "pasted into the article box" case. */
const OTHER_ID = "1223642971";
const OTHER_URL = `https://vimeo.com/${OTHER_ID}`;
/** A third capture, held open mid-stream so a second paste can land on it. */
const HELD_ID = "1223777001";
const HELD_URL = `https://vimeo.com/${HELD_ID}`;
/** A fourth, held the same way, for the paste about a DIFFERENT url. */
const HELD2_ID = "1223777002";
const HELD2_URL = `https://vimeo.com/${HELD2_ID}`;
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
/**
 * Every path the fake was asked for that it does not play a role for.
 *
 * The catch-all used to answer `200 {}`, which makes the fake agree with any
 * request at all: a capture that called a huginn endpoint this file never
 * modelled got a plausible empty answer instead of a failure, so the spec could
 * pass while asserting nothing about that call. It 404s now, and the list is
 * asserted empty.
 */
let unexpected: string[] = [];
/**
 * When set, the fake's completion PAUSES between its two content chunks until
 * the spec resolves it. That is what makes "a paste that lands mid-stream" a
 * deterministic state rather than a race: the card is parked in `Summarizing`
 * with the first chunk already accumulated.
 */
let holdModel: Promise<void> | null = null;
let releaseModel: (() => void) | null = null;

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
  if (id === HELD_ID) {
    return { title: "E2E held talk", author_name: "x", duration: 140, upload_date: "2026-09-04 13:00:00" };
  }
  if (id === HELD2_ID) {
    return { title: "E2E held talk two", author_name: "x", duration: 160, upload_date: "2026-09-04 14:00:00" };
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
  if (holdModel) await holdModel;
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
      // The page's own knowledge-API banner probe, proxied through
      // `/api/search/health` on every /summaries load. It is a real call this
      // file makes; the 404 catch-all below is what surfaced it.
      if (p === "/health") return json({ status: "ok" });

      unexpected.push(`${req.method ?? "GET"} ${p}`);
      return json({ error: "unexpected path", path: p }, 404);
    })();
  });
  await new Promise<void>((resolve) => srv.listen(FAKE_PORT, "127.0.0.1", resolve));
  return srv;
}

/** Create the throwaway bot in a fresh temp root and return that root. */
function writeBot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "muninn-e2e-vimeo-bots-"));
  const dir = path.join(root, BOT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "CLAUDE.md"), "# e2e summarizer\n\nCreated by e2e/summaries-vimeo.spec.ts.\n");
  writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ connector: "openai-compat", model: "e2e-fake", baseUrl: `${FAKE}/v1`, timeoutMs: 60000 }, null, 2),
  );
  botsRoot = root;
  return root;
}

function removeBotsRoot(): void {
  if (botsRoot) rmSync(botsRoot, { recursive: true, force: true });
  botsRoot = undefined;
}

/**
 * A hard kill (Ctrl-C, a CI cancel) skips `afterAll`. The temp root is outside
 * the repo either way, but leaving one per aborted run is still litter.
 *
 * ⚠️ Two things about this are load-bearing, both measured:
 *
 * 1. **It RE-RAISES.** Registering ANY listener for SIGINT/SIGTERM suppresses
 *    Node's default termination — measured, a process whose only listener was a
 *    cleanup function survived a self-sent SIGINT and kept running. So the
 *    handler removes itself and re-sends the same signal, which now finds no
 *    listener and terminates with the right status. Without that, Ctrl-C on a
 *    Playwright worker running this file left the worker (and the muninn it
 *    spawned) alive.
 * 2. **They are registered in `beforeAll` and removed in `afterAll`,** not at
 *    module import. A Playwright worker is reused across spec files, so
 *    import-time registration accumulates a listener per file for the whole
 *    worker lifetime and leaves this file's handler armed — pointing at a
 *    `botsRoot` it no longer owns — long after its own tests are done.
 */
function handleSignal(signal: NodeJS.Signals): void {
  // The spawned muninn and the fake are `afterAll`'s to stop, and a hard kill
  // skips `afterAll` — measured, a Ctrl-C mid-run left a `bun run src/index.ts`
  // bound to this file's port, so the NEXT run's server never came up and its
  // first case timed out on `/api/live`. Same order as `afterAll`.
  server?.kill("SIGTERM");
  fake?.close();
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

/**
 * Make sure VIDEO_URL is in the route's recently-ingested map — the state the
 * dedup cases read.
 *
 * The first case is what puts it there on a full run, and `mode: "serial"`
 * pins that order. Under `--grep` the first case may not RUN, and a case that
 * assumed it did was answered with a fresh job instead of `duplicate` and
 * failed on its own banner — a failure about test selection, not about the
 * property. So a case that depends on the capture ASKS for it: a `duplicate`
 * answer is the state already; a `job_id` is a capture this call waits out.
 * Any other answer is a real failure and is reported as one.
 */
async function ensureCaptured(request: import("@playwright/test").APIRequestContext): Promise<void> {
  const res = await request.post(`${BASE}/api/vimeo/summarize`, { data: { url: VIDEO_URL } });
  const body = (await res.json()) as { duplicate?: boolean; job_id?: string; error?: string };
  if (body.duplicate) return;
  if (!body.job_id) throw new Error(`ensureCaptured: unexpected answer ${JSON.stringify(body)}`);
  const deadline = Date.now() + 60_000;
  for (;;) {
    const jobs = (await (await request.get(`${BASE}/api/vimeo/jobs`)).json()) as {
      jobs?: Array<{ id: string; status: string }>;
    };
    const job = (jobs.jobs ?? []).find((j) => j.id === body.job_id);
    if (job?.status === "complete") return;
    if (job?.status === "error") throw new Error("ensureCaptured: the seeding capture failed");
    if (Date.now() > deadline) throw new Error("ensureCaptured: the seeding capture did not complete");
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function jobCount(request: import("@playwright/test").APIRequestContext): Promise<number> {
  const res = await request.get(`${BASE}/api/vimeo/jobs`);
  const body = (await res.json()) as { jobs?: unknown[] };
  return (body.jobs ?? []).length;
}

test.beforeAll(async () => {
  fake = await startFake();
  const root = writeBot();
  addSignalHandlers();
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
      // The bot roster this server discovers — a temp directory holding exactly
      // the throwaway bot, so nothing under the repo's `bots/` is written or
      // read. In `AMBIENT_INSTANCE_ENV`, hence after the `e2eEnv()` spread.
      MUNINN_BOTS_DIR: root,
      // Explicit regardless: `resolveSummarizerBot`'s fallback is positional,
      // and a role_overrides row in the test DB would otherwise re-point it.
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
  removeBotsRoot();
  removeSignalHandlers();
  // Nothing in this file asked the fake for a path it does not play. Asserted
  // here rather than inside the last case, so a FILTERED run (`--grep`) that
  // never reaches that case still checks it.
  expect(unexpected).toEqual([]);
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
    // The fake model API really answered this capture — i.e. the throwaway bot
    // is what ran, so "no model spend" in the next case means something.
    expect(modelCalls).toBeGreaterThan(0);
    expect(ingests).toHaveLength(1);
    expect(ingests[0]).toMatchObject({ url: VIDEO_URL, caption_kind: "stub", duration_sec: 100 });
    expect(await jobCount(page.request)).toBe(1);
  });

  test("pasting the same URL again says 'Already captured' and starts nothing", async ({ page }) => {
    const jobsBefore = await jobCount(page.request);

    await page.goto(`${BASE}/summaries`);
    await page.locator("#captureUrl").fill(VIDEO_URL);
    await page.locator("#captureUrlBtn").click();

    const banner = page.locator("#errorBanner");
    await expect(banner).toContainText("Already captured");
    await expect(banner).toHaveClass(/notice/);
    await expect(banner.locator("a")).toHaveAttribute("href", /doc=/);
    await expect(page.locator("#statusBadge .status-text")).toHaveText("Already captured");

    // Nothing ran: no new job, no second harvest. The fake's listing is still
    // EMPTY, so this answer came from the route's recently-ingested map — dedup
    // state 3, the reindex window.
    //
    // `jobCount` is the property, not the model-call count: a capture that DID
    // start would be a job here, while its model call lands whenever the
    // harvest finishes and a `modelCalls` read is a race against it.
    expect(await jobCount(page.request)).toBe(jobsBefore);
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

    await expect(page.locator("#errorBanner")).toHaveText("Longer than the 3h cap (5h 33m)");
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

  test("a paste that lands mid-capture is a banner only — the running card keeps streaming", async ({ page }) => {
    test.setTimeout(120_000);
    // The model call parks between its two chunks until this resolves, so the
    // card below really is mid-stream rather than racing one.
    holdModel = new Promise<void>((resolve) => { releaseModel = resolve; });

    await page.goto(`${BASE}/summaries`);
    await page.locator("#captureUrl").fill(HELD_URL);
    await page.locator("#captureUrlBtn").click();

    // Parked mid-stream: the first chunk is on the card and the second is held.
    await expect(page.locator("#statusBadge .status-text")).toHaveText("Summarizing", { timeout: 60_000 });
    await expect(page.locator("#summaryArea")).toContainText("CATEGORY: tech");

    // The same url again, while that capture is streaming. The route answers
    // `in_flight`; the page must render it as the banner and touch NOTHING else.
    await page.locator("#captureUrl").fill(HELD_URL);
    await page.locator("#captureUrlBtn").click();
    await expect(page.locator("#errorBanner")).toContainText("Already being captured");
    await expect(page.locator("#errorBanner")).toHaveClass(/notice/);
    // Not repainted: the badge still belongs to the running job, and the title is
    // the video's, not the pasted address.
    await expect(page.locator("#statusBadge .status-text")).toHaveText("Summarizing");
    await expect(page.locator("#jobTitle")).toHaveText("E2E held talk");
    await expect(page.locator("#summaryArea")).toContainText("CATEGORY: tech");

    releaseModel!();
    holdModel = null;

    // The stream was never re-opened, so the rest of the summary still arrives —
    // and the WHOLE text is there, not just the part that came after the paste.
    await expect(page.locator("#statusBadge .status-text")).toHaveText("Complete", { timeout: 60_000 });
    await expect(page.locator("#summaryArea")).toContainText("CATEGORY: tech");
    await expect(page.locator("#summaryArea")).toContainText(SUMMARY_LINE);
    // A completed capture does not sit under "Already being captured" — that
    // notice was about THIS job, and it is answered now.
    await expect(page.locator("#errorBanner")).not.toHaveClass(/visible/);
  });

  test("a banner about ANOTHER url survives the running job's completion", async ({ page }) => {
    test.setTimeout(120_000);
    // The mirror of the case above, and the reason the clear is conditional.
    // Mid-stream, an answer about a second url is the banner AND NOTHING ELSE —
    // the card belongs to the running job — so that banner is the only feedback
    // the paste gets. Clearing it whenever any job completes erased the answer.
    // BEFORE the hold: the seeding capture, if one runs, must not park on it.
    await ensureCaptured(page.request);
    holdModel = new Promise<void>((resolve) => { releaseModel = resolve; });

    await page.goto(`${BASE}/summaries`);
    await page.locator("#captureUrl").fill(HELD2_URL);
    await page.locator("#captureUrlBtn").click();
    await expect(page.locator("#statusBadge .status-text")).toHaveText("Summarizing", { timeout: 60_000 });

    // A DIFFERENT url, already captured (the first case, or `ensureCaptured`
    // above under `--grep`) ⇒ `duplicate`.
    await page.locator("#captureUrl").fill(VIDEO_URL);
    await page.locator("#captureUrlBtn").click();
    const banner = page.locator("#errorBanner");
    await expect(banner).toContainText("Already captured");
    await expect(banner).toHaveClass(/visible/);
    await expect(banner.locator("a")).toHaveAttribute("href", /doc=/);

    releaseModel!();
    holdModel = null;

    await expect(page.locator("#statusBadge .status-text")).toHaveText("Complete", { timeout: 60_000 });
    // Still there: the answer about VIDEO_URL is not this job's to erase, and
    // its link is the only way the reader reaches that summary.
    await expect(banner).toContainText("Already captured");
    await expect(banner).toHaveClass(/visible/);
    await expect(banner.locator("a")).toHaveAttribute("href", /doc=/);
  });
});
