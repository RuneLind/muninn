/**
 * `/summaries` — the doc panel's ▶ Find on YouTube, end to end through the
 * REAL `POST /api/summaries/discover`.
 *
 * What only this tier can see: the button appearing on a YouTube document and
 * not on a Vimeo one, the section mounting above the article, the loading
 * state, the ranked list as the route answers it (seed and already-captured
 * videos gone — the known set read from the fake huginn listing), the title
 * linking to the watch URL built from the id in a new tab, and Summarize
 * posting `{title, url, video_id}` to `/api/youtube/summarize` once per click,
 * then showing "Started" (button disabled) or the error (button enabled, so a
 * transient refusal can be retried).
 *
 * **What is faked and why.** huginn is an in-process `node:http` server
 * serving the two documents, their raw files and the `youtube-summaries`
 * listing. muninn is booted through `e2e/youtube-discover-boot.ts`, which cans
 * the two model calls and the yt-dlp search in-process (`discoverTestSeam`);
 * everything after those seams is production code. The Summarize POST is
 * answered by `page.route`: the real capture route would start a yt-dlp probe
 * and a transcript fetch for an invented id, and it has its own tests — this
 * spec proves what the panel sends and how it reads the answer. Invented ids
 * and titles only (public repo). Ports come from `e2e/ports.ts`.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("summaries-youtube-discover");
const FAKE_PORT = e2ePort("summaries-youtube-discover/huginn");
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const BOT = "e2eytdiscover";
const TODAY = new Date().toISOString().slice(0, 10);

const SEED = "e2eSeed0001";
const KNOWN = "e2eKnown001";
const NEW_A = "e2eNewAAA01";
const NEW_B = "e2eNewBBB02";
const NEW_C = "e2eNewCCC03";

const YT_DOC = { collection: "youtube-summaries", id: "ai/e2e/E2E discover seed.md" };
const VIMEO_DOC = { collection: "vimeo-summaries", id: "ai/e2e/E2E vimeo talk.md" };
const FILES: Record<string, Record<string, string>> = {
  [YT_DOC.collection]: {
    [YT_DOC.id]: `---\ndate: "2026-03-22"\nurl: "https://www.youtube.com/watch?v=${SEED}"\ncategory: "ai/e2e"\n---\n\nAn invented summary about evaluating coding agents.\n`,
    "ai/e2e/E2E already captured.md": `---\ndate: "2026-03-21"\nurl: "https://www.youtube.com/watch?v=${KNOWN}"\ncategory: "ai/e2e"\n---\n\nAnother invented summary.\n`,
  },
  [VIMEO_DOC.collection]: {
    [VIMEO_DOC.id]: `---\ndate: "2026-03-20"\nurl: "https://vimeo.com/123456789"\ncategory: "ai/e2e"\n---\n\nAn invented conference talk.\n`,
  },
};

const hit = (id: string, title: string, channel: string, durationSec: number, viewCount: number) => ({
  videoId: id,
  title,
  channel,
  durationSec,
  viewCount,
  url: `https://www.youtube.com/watch?v=${id}`,
});
const FIXTURE = {
  queries: JSON.stringify([
    { query: "agent evals deep dive", why: "same topic" },
    { query: "coding agent benchmarks", why: "adjacent" },
    { query: "broken search", why: "fails" },
  ]),
  // Over the fresh list [NEW_A, NEW_B, NEW_C]: B ranks first, C is omitted.
  rank: JSON.stringify([
    { n: 1, score: 0.7, why: "Invented reason A" },
    { n: 2, score: 0.95, why: "Invented reason B" },
  ]),
  search: {
    "agent evals deep dive": [hit(SEED, "The seed itself", "Seed Channel", 900, 10), hit(NEW_A, "Invented eval talk", "Channel A", 1834, 12345)],
    "coding agent benchmarks": [hit(KNOWN, "Already captured", "K", 60, 1), hit(NEW_B, "Invented benchmark tour", "Channel B", 3723, 2_400_000), hit(NEW_C, "Invented clickbait", "C", 30, 5)],
    "broken search": null,
  },
};

let server: ChildProcess | undefined;
let fake: Server | undefined;
let tmpRoot: string | undefined;

async function startFake(): Promise<Server> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = decodeURIComponent(url.pathname);
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const list = /^\/api\/collection\/([^/]+)\/documents$/.exec(p);
    if (list) {
      const docs = FILES[list[1]!] ?? {};
      return json({
        documents: Object.entries(docs).map(([id, raw]) => ({
          id,
          url: /^url: "([^"]+)"/m.exec(raw)?.[1],
          date: TODAY,
          modifiedTime: `${TODAY}T01:00:00.000000`,
        })),
      });
    }
    const m = /^\/api\/document\/([^/]+)\/(.+)$/.exec(p);
    if (m) {
      const file = FILES[m[1]!]?.[m[2]!];
      if (!file) return json({ detail: "not found" }, 404);
      if (url.searchParams.get("raw") === "1") {
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
        return res.end(file);
      }
      return json({ id: m[2], url: /^url: "([^"]+)"/m.exec(file)?.[1], text: file.replace(/^---\n[\s\S]*?\n---\n/, "") });
    }
    if (p === "/api/collections") return json({ collections: Object.keys(FILES).map((name) => ({ name })) });
    if (p === "/api/search") return json({ results: [] });
    return json({ status: "ok" });
  });
  await new Promise<void>((resolve) => srv.listen(FAKE_PORT, "127.0.0.1", resolve));
  return srv;
}

function writeFixtures(): { botsRoot: string; fixture: string } {
  const root = mkdtempSync(path.join(tmpdir(), "muninn-e2e-ytdiscover-"));
  const dir = path.join(root, "bots", BOT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "CLAUDE.md"), "# e2e Find on YouTube summarizer\n\nCreated by e2e/summaries-youtube-discover.spec.ts.\n");
  // The model calls are canned, so this connector is never spawned.
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ connector: "claude-sdk" }, null, 2));
  const fixture = path.join(root, "fixture.json");
  writeFileSync(fixture, JSON.stringify(FIXTURE));
  tmpRoot = root;
  return { botsRoot: path.join(root, "bots"), fixture };
}

function cleanup(): void {
  server?.kill("SIGTERM");
  fake?.close();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = undefined;
}
function handleSignal(signal: NodeJS.Signals): void {
  cleanup();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  process.kill(process.pid, signal);
}
const onSigint = () => handleSignal("SIGINT");
const onSigterm = () => handleSignal("SIGTERM");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fake = await startFake();
  const { botsRoot, fixture } = writeFixtures();
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  server = spawn("bun", ["run", "e2e/youtube-discover-boot.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      MUNINN_BOTS_DIR: botsRoot,
      SUMMARIZER_BOT: BOT,
      KNOWLEDGE_API_URL: FAKE,
      YOUTUBE_DISCOVER_E2E_FIXTURE: fixture,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/live`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.afterAll(() => {
  cleanup();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
});

async function openDoc(page: Page, source: string, docId: string, text: string): Promise<void> {
  await page.goto(`${BASE}/summaries?source=${source}&doc=${encodeURIComponent(docId)}`);
  await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
  await expect(page.locator("#sumArticleMain")).toContainText(text, { timeout: 15_000 });
}

test("a Vimeo document gets no button", async ({ page }) => {
  await openDoc(page, "vimeo", VIMEO_DOC.id, "invented conference talk");
  await expect(page.locator("#docPanelDiscover")).toBeHidden();
  await expect(page.locator("#sumDiscover")).toHaveCount(0);
});

test("lists the ranked new videos, then Summarize posts once per click, and an error can be retried", async ({ page }) => {
  const posts: unknown[] = [];
  await page.route("**/api/youtube/summarize", async (route) => {
    const req = route.request();
    posts.push({ body: req.postDataJSON(), ct: req.headers()["content-type"] });
    const body = req.postDataJSON() as { video_id: string };
    if (body.video_id === NEW_A && posts.filter((p) => (p as { body: { video_id: string } }).body.video_id === NEW_A).length === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Invented refusal.", code: "x" }) });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ job_id: "job-1", dashboard_url: "/summaries?source=youtube&job=job-1" }) });
    }
  });

  await openDoc(page, "youtube", YT_DOC.id, "evaluating coding agents");
  const btn = page.locator("#docPanelDiscover");
  await expect(btn).toBeVisible();
  await btn.click();
  const panel = page.locator("#sumDiscover");
  await expect(panel.locator(".sum-discover-note")).toContainText("Writing search queries");
  // Above the article body.
  expect(
    await page.evaluate(() => {
      const d = document.getElementById("sumDiscover");
      const body = document.getElementById("sumArticleBody");
      return !!d && !!body && (d.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }),
  ).toBe(true);

  const rows = panel.locator(".sum-discover-row");
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  // Seed and known dropped (5 found, 2 already summarized), ranked by score, C omitted by the gate.
  await expect(panel.locator(".sum-discover-note").first()).toContainText("5 found, 2 already summarized");
  await expect(panel.locator(".sum-discover-note").first()).toContainText("agent evals deep dive");
  const first = rows.nth(0).locator("a.sum-discover-title");
  await expect(first).toHaveText("Invented benchmark tour");
  await expect(first).toHaveAttribute("href", `https://www.youtube.com/watch?v=${NEW_B}`);
  await expect(first).toHaveAttribute("target", "_blank");
  await expect(first).toHaveAttribute("rel", "noopener");
  await expect(rows.nth(0).locator(".sum-discover-meta")).toHaveText("Channel B · 1:02:03 · 2.4M views");
  await expect(rows.nth(0).locator(".sum-discover-why")).toHaveText("Invented reason B");
  await expect(rows.nth(1).locator("a.sum-discover-title")).toHaveText("Invented eval talk");
  await expect(rows.nth(1).locator(".sum-discover-meta")).toHaveText("Channel A · 30:34 · 12.3k views");
  await expect(panel).not.toContainText("Invented clickbait");
  await expect(panel).not.toContainText("Already captured");
  await expect(panel).not.toContainText("The seed itself");
  expect(posts).toHaveLength(0); // D2: nothing is captured without a click.

  const sumB = rows.nth(0).getByRole("button", { name: "Summarize" });
  await sumB.click();
  await expect(rows.nth(0).locator(".sum-discover-status")).toContainText("Started");
  await expect(sumB).toBeDisabled();
  await expect(rows.nth(0).locator(".sum-discover-status a")).toHaveAttribute("href", "/summaries?source=youtube&job=job-1");

  const sumA = rows.nth(1).getByRole("button", { name: "Summarize" });
  await sumA.click();
  await expect(rows.nth(1).locator(".sum-discover-status")).toHaveText("Invented refusal.");
  await expect(rows.nth(1).locator(".sum-discover-status")).toHaveClass(/error/);
  // An error leaves the row retryable (a transient 503 must not need a reload); the retry succeeds.
  await expect(sumA).toBeEnabled();
  await sumA.click();
  await expect(rows.nth(1).locator(".sum-discover-status")).toContainText("Started");
  await expect(sumA).toBeDisabled();
  await sumB.click({ force: true });

  const bodyA = { title: "Invented eval talk", url: `https://www.youtube.com/watch?v=${NEW_A}`, video_id: NEW_A };
  expect(posts).toEqual([
    { body: { title: "Invented benchmark tour", url: `https://www.youtube.com/watch?v=${NEW_B}`, video_id: NEW_B }, ct: "application/json" },
    { body: bodyA, ct: "application/json" },
    { body: bodyA, ct: "application/json" },
  ]);
});

test("the route refuses a non-YouTube source and a missing document", async ({ request }) => {
  const vimeo = await request.post(`${BASE}/api/summaries/discover`, { data: { source: "vimeo", docId: VIMEO_DOC.id } });
  expect(vimeo.status()).toBe(400);
  expect((await vimeo.json()).code).toBe("not_youtube");
  const gone = await request.post(`${BASE}/api/summaries/discover`, { data: { source: "youtube", docId: "ai/e2e/Gone.md" } });
  expect(gone.status()).toBe(404);
});

// The header with every control a YouTube document shows: the title keeps real
// width and no control spills out of the header, at every width the reader
// lays out differently (phone, the 701–1000 px band, the breakpoint, desktop).
for (const width of [390, 800, 1000, 1440]) {
  test(`at ${width}px the panel header keeps its title and fits its controls`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openDoc(page, "youtube", YT_DOC.id, "evaluating coding agents");
    await expect(page.locator("#docPanelDiscover")).toBeVisible();
    await expect(page.locator("#docPanelTitle")).toBeVisible();
    const m = await page.evaluate(() => {
      const header = document.querySelector(".doc-panel-header") as HTMLElement;
      const title = document.getElementById("docPanelTitle")!;
      const box = header.getBoundingClientRect();
      const spill = [...header.children]
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.right > box.right + 1 || r.left < box.left - 1;
        })
        .map((el) => el.id || el.className);
      return { titleWidth: title.getBoundingClientRect().width, spill };
    });
    expect(m.spill).toEqual([]);
    expect(m.titleWidth).toBeGreaterThanOrEqual(120);
  });
}
