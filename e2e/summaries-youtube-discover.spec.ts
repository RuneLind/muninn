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
 *
 * PR 3's seed bar runs last (it replaces the reader's shelf): Last 7 days over
 * the fake listing's two documents, both dated today, runs one search per seed
 * in turn, and the pick list caps a hand-picked set at five.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
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
  // The drawer's details probe, per video (`null` = the probe failed).
  details: {
    [NEW_B]: {
      description: "An invented description of the benchmark tour.",
      chapters: [
        { start: 0, title: "Invented intro" },
        { start: 125, title: "Invented results" },
      ],
      likeCount: 4321,
      viewCount: 2_400_100,
      uploadDate: "20250619",
      channelFollowerCount: 22_400,
      tags: ["benchmarks"],
    },
    [NEW_A]: null,
  },
};

/** The listing's second YouTube document: a seed for the seed bar (PR 3). */
const CAPTURED_DOC = "ai/e2e/E2E already captured.md";
/** A shelf no seed-bar run replaces (its seed is not in the listing). */
const BATCH_SEED = "ai/e2e/E2E batch seed.md";
const BATCH_IDS = ["e2eBatch001", "e2eBatch002"] as const;

/** A shelf seeded straight into the DB with five cards: the reader flow only ever makes two. */
const FOCUS_SEED = "ai/e2e/E2E focus seed.md";
const FOCUS_IDS = ["e2eFocus001", "e2eFocus002", "e2eFocus003", "e2eFocus004", "e2eFocus005"] as const;

/** Rows an earlier run of this spec left: a dismissed or queued video would join the known set. */
async function clearStoredRuns(): Promise<void> {
  const sql = postgres(TEST_DB, { max: 1, onnotice: () => {} });
  try {
    await sql`DELETE FROM youtube_discover_hits WHERE video_id IN (${NEW_A}, ${NEW_B}, ${NEW_C})`;
    await sql`DELETE FROM youtube_discover_runs WHERE seed_doc_id IN (${YT_DOC.id}, ${FOCUS_SEED}, ${CAPTURED_DOC})`;
    await sql`DELETE FROM youtube_discover_hits WHERE video_id LIKE 'e2eFocus%'`;
    await sql`DELETE FROM youtube_discover_runs WHERE seed_doc_id = ${BATCH_SEED}`;
    await sql`DELETE FROM youtube_discover_hits WHERE video_id LIKE 'e2eBatch%'`;
  } finally {
    await sql.end();
  }
}

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
  await clearStoredRuns();
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

test("the reader links its stored run; the Discover page shows it as a shelf with a details drawer", async ({ page }) => {
  await openDoc(page, "youtube", YT_DOC.id, "evaluating coding agents");
  await page.locator("#docPanelDiscover").click();
  const panel = page.locator("#sumDiscover");
  await expect(panel.locator(".sum-discover-row")).toHaveCount(2, { timeout: 15_000 });
  const shelfLink = panel.locator("a.sum-discover-shelf");
  await expect(shelfLink).toHaveText("Saved as a shelf on Discover →");
  const href = await shelfLink.getAttribute("href");
  expect(href).toMatch(/^\/summaries\/discover#run-[0-9a-f-]{36}$/);
  await shelfLink.click();
  await expect(page).toHaveURL(`${BASE}${href}`);

  const shelf = page.locator(`section.dsc-shelf${href!.slice(href!.indexOf("#"))}`);
  await expect(shelf).toHaveClass(/dsc-target/);
  await expect(shelf.locator(".dsc-because")).toHaveText("Because you captured · ai/e2e · 2026-03-22");
  await expect(shelf.locator("h3 a")).toHaveText("E2E discover seed");
  await expect(shelf.locator("h3 a")).toHaveAttribute("href", `/summaries?doc=${encodeURIComponent(YT_DOC.id)}&source=youtube`);
  await expect(shelf.locator(".dsc-meta").first()).toContainText("5 videos searched · 2 you already have · 2 shown");
  await expect(shelf.locator(".dsc-q")).toHaveText(["agent evals deep dive", "coding agent benchmarks", "broken search"]);
  const cards = shelf.locator(".dsc-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).locator(".dsc-title")).toHaveText("Invented benchmark tour");
  await expect(cards.nth(0).locator(".dsc-thumb img")).toHaveAttribute("src", `https://i.ytimg.com/vi/${NEW_B}/mqdefault.jpg`);
  await expect(cards.nth(0).locator(".dsc-dur")).toHaveText("1:02:03");
  await expect(cards.nth(0).locator(".dsc-score")).toHaveText("95% match");
  await expect(cards.nth(0).locator(".dsc-why")).toHaveText("Invented reason B");

  // Sort: Shortest puts the 30:34 talk first.
  await page.locator("#dscSort").selectOption("short");
  await expect(cards.nth(0).locator(".dsc-title")).toHaveText("Invented eval talk");
  await page.locator("#dscSort").selectOption("score");

  // The drawer: details load once, play swaps in the no-cookie embed.
  await cards.nth(0).click();
  const drawer = page.locator("#dscDrawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator("h3")).toHaveText("Invented benchmark tour");
  await expect(drawer.locator(".dsc-chapters li")).toHaveText(["0:00Invented intro", "2:05Invented results"], { timeout: 10_000 });
  await expect(drawer.locator(".dsc-desc")).toHaveText("An invented description of the benchmark tour.");
  await expect(drawer.locator(".dsc-stats")).toContainText("4K likes");
  await expect(drawer.locator(".dsc-stats")).toContainText("22K subscribers");
  await expect(drawer.locator(".dsc-box")).toContainText("Invented reason B");
  await expect(drawer.locator("iframe")).toHaveCount(0);
  await drawer.getByRole("button", { name: "Play here" }).click();
  await expect(drawer.locator("iframe")).toHaveAttribute("src", `https://www.youtube-nocookie.com/embed/${NEW_B}?autoplay=1`);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  // A failed probe says so and offers a retry.
  await cards.nth(1).click();
  await expect(drawer.locator(".dsc-warn")).toContainText("YouTube did not answer", { timeout: 10_000 });
  await expect(drawer.getByRole("button", { name: "Try again" })).toBeVisible();
  await drawer.getByRole("button", { name: "✕ Close" }).click();
  await expect(drawer).toBeHidden();

  // The cached details come back after a reload without a second probe.
  await page.reload();
  await shelf.locator(".dsc-card").nth(0).click();
  await expect(drawer.locator(".dsc-chapters li")).toHaveCount(2);
});

test("one Undo restores every dismissal its toast covers", async ({ page }) => {
  await page.goto(`${BASE}/summaries/discover`);
  const shelf = page.locator("section.dsc-shelf").filter({ has: page.locator("h3 a", { hasText: "E2E discover seed" }) });
  const card = (title: string) => shelf.locator(".dsc-card").filter({ hasText: title });
  for (const title of ["Invented benchmark tour", "Invented eval talk"]) {
    await card(title).hover();
    await card(title).getByRole("button", { name: "Not interested" }).click();
    await expect(card(title)).toHaveCount(0);
  }
  await page.locator("#dscToast").getByRole("button", { name: "Undo" }).click();
  await expect(card("Invented benchmark tour")).toHaveCount(1);
  await expect(card("Invented eval talk")).toHaveCount(1);
  await page.reload();
  await expect(shelf.locator(".dsc-card")).toHaveCount(2);
});

test("re-renders keep the row's scroll, the playing video and focus; the drawer is a modal dialog; counts and layout agree", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${BASE}/summaries/discover`);
  const runId = await page
    .locator("section.dsc-shelf")
    .filter({ has: page.locator("h3 a", { hasText: "E2E discover seed" }) })
    .getAttribute("data-run");
  // By id: the title is rewritten below.
  const shelf = page.locator(`section.dsc-shelf[data-run="${runId}"]`);
  const card = (title: string) => shelf.locator(".dsc-card").filter({ hasText: title });
  const row = shelf.locator(".dsc-row");

  // The live region is in the page before any toast, so screen readers announce the first one.
  await expect(page.locator("#dscToast")).toHaveAttribute("role", "status");
  await expect(page.locator("#dscToast")).not.toHaveAttribute("hidden", /.*/);

  // A long unbroken seed title does not widen the page at phone width.
  await shelf.locator("h3 a").evaluate((a) => (a.textContent = "x".repeat(200)));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Scroll the row to its end, press Later on the last card: the row stays where it was, focus stays on the button.
  await row.evaluate((r) => (r.scrollLeft = r.scrollWidth));
  const before = await row.evaluate((r) => r.scrollLeft);
  expect(before).toBeGreaterThan(0);
  await card("Invented eval talk").getByRole("button", { name: "☆ Later" }).focus();
  await page.keyboard.press("Enter");
  await expect(card("Invented eval talk").locator('[data-act="later"]')).toHaveAttribute("aria-pressed", "true");
  expect(await row.evaluate((r) => r.scrollLeft)).toBe(before);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-act"))).toBe("later");
  await page.keyboard.press("Enter");
  await expect(card("Invented eval talk").locator('[data-act="later"]')).toHaveAttribute("aria-pressed", "false");

  // The drawer is a modal dialog; the page behind it is inert while it is open.
  await page.setViewportSize({ width: 1280, height: 800 });
  await card("Invented benchmark tour").click();
  const drawer = page.locator("#dscDrawer");
  await expect(drawer).toHaveAttribute("role", "dialog");
  await expect(drawer).toHaveAttribute("aria-modal", "true");
  const labelId = await drawer.getAttribute("aria-labelledby");
  await expect(page.locator(`#${labelId}`)).toHaveText("Invented benchmark tour");
  expect(await page.locator(".dsc-page").evaluate((el) => (el as HTMLElement).inert)).toBe(true);

  // Play, then let a re-render happen (Later in the drawer): the same iframe keeps playing.
  await drawer.getByRole("button", { name: "Play here" }).click();
  await drawer.locator("iframe").evaluate((f) => ((f as HTMLElement).dataset.mark = "kept"));
  await drawer.locator('[data-act="later"]').click();
  await expect(drawer.locator('[data-act="later"]')).toHaveAttribute("aria-pressed", "true");
  await expect(drawer.locator("iframe")).toHaveAttribute("data-mark", "kept");
  await drawer.locator('[data-act="later"]').click();
  await expect(drawer.locator('[data-act="later"]')).toHaveAttribute("aria-pressed", "false");

  // Dismissing from the drawer closes it and puts focus on a card, not on the page body.
  await drawer.getByRole("button", { name: "✕ Not interested" }).click();
  await expect(drawer).toBeHidden();
  expect(await page.locator(".dsc-page").evaluate((el) => (el as HTMLElement).inert)).toBe(false);
  expect(await page.evaluate(() => document.activeElement?.classList.contains("dsc-card"))).toBe(true);
  await page.locator("#dscToast").getByRole("button", { name: "Undo" }).click();
  await expect(card("Invented benchmark tour")).toHaveCount(1);

  // The shelf's "shown" follows the length filter, and an empty row's note spans the shelf.
  await page.locator("#dscLen").selectOption("1800");
  await expect(shelf.locator(".dsc-card")).toHaveCount(2);
  await expect(shelf.locator(".dsc-meta").first()).toContainText("2 shown");
  await page.locator("#dscLen").selectOption("600");
  await page.locator("#dscSort").selectOption("score");
  await shelf.locator(".dsc-card").first().evaluate(() => undefined);
  await page.evaluate(() => {
    const sel = document.getElementById("dscLen") as HTMLSelectElement;
    sel.add(new Option("Over 2 h", "7200"));
    sel.value = "7200";
    sel.dispatchEvent(new Event("change"));
  });
  await expect(shelf.locator(".dsc-meta").first()).toContainText("0 shown");
  const empty = shelf.locator(".dsc-empty");
  await expect(empty).toHaveText("Nothing at this length.");
  const widths = await shelf.evaluate((el) => ({ shelf: el.getBoundingClientRect().width, empty: el.querySelector(".dsc-empty")!.getBoundingClientRect().width }));
  expect(widths.empty).toBeGreaterThan(widths.shelf * 0.8);
});

test("Later, Dismiss with Undo and Summarize persist, and dismissed and queued videos are never suggested again", async ({ page, request }) => {
  const posts: unknown[] = [];
  await page.route("**/api/youtube/summarize", async (route) => {
    posts.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ job_id: "job-2" }) });
  });
  await page.goto(`${BASE}/summaries/discover`);
  const shelf = page.locator("section.dsc-shelf").filter({ has: page.locator("h3 a", { hasText: "E2E discover seed" }) });
  const card = (title: string) => shelf.locator(".dsc-card").filter({ hasText: title });

  // Later toggles and survives a reload.
  await card("Invented eval talk").getByRole("button", { name: "☆ Later" }).click();
  await expect(card("Invented eval talk").locator('[data-act="later"]')).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(card("Invented eval talk").locator('[data-act="later"]')).toHaveAttribute("aria-pressed", "true");

  // Dismiss, Undo, Dismiss again.
  await card("Invented benchmark tour").hover();
  await card("Invented benchmark tour").getByRole("button", { name: "Not interested" }).click();
  await expect(card("Invented benchmark tour")).toHaveCount(0);
  await expect(page.locator("#dscToast")).toContainText("Dismissed. It won't be suggested again.");
  await page.locator("#dscToast").getByRole("button", { name: "Undo" }).click();
  await expect(card("Invented benchmark tour")).toHaveCount(1);
  await card("Invented benchmark tour").hover();
  await card("Invented benchmark tour").getByRole("button", { name: "Not interested" }).click();
  await expect(card("Invented benchmark tour")).toHaveCount(0);

  // Summarize posts the capture route, then the card reads Queued, after a reload too.
  await card("Invented eval talk").getByRole("button", { name: "Summarize" }).click();
  await expect(card("Invented eval talk").getByRole("button", { name: "✓ Queued" })).toBeDisabled();
  expect(posts).toEqual([{ title: "Invented eval talk", url: `https://www.youtube.com/watch?v=${NEW_A}`, video_id: NEW_A }]);
  await page.reload();
  await expect(card("Invented benchmark tour")).toHaveCount(0);
  await expect(card("Invented eval talk").getByRole("button", { name: "✓ Queued" })).toBeDisabled();
  await expect(shelf.locator(".dsc-meta").first()).toContainText("1 shown");

  // A new run from the same seed: the dismissed and the queued video are known now.
  const res = await request.post(`${BASE}/api/summaries/discover`, { data: { source: "youtube", docId: YT_DOC.id } });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { results: { videoId: string }[]; known: number };
  expect(body.known).toBe(4);
  expect(body.results.map((r) => r.videoId)).toEqual([NEW_C]);
});

test("a queued card offers no Later; a double click posts once; a failed queued write is said, not hidden", async ({ page }) => {
  const statePosts: unknown[] = [];
  let failState = false;
  await page.route("**/api/summaries/discover/state", async (route) => {
    statePosts.push(route.request().postDataJSON());
    if (failState) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Invented DB outage.", code: "internal" }) });
    else await route.continue();
  });
  await page.route("**/api/youtube/summarize", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ job_id: "job-3" }) }),
  );
  await page.goto(`${BASE}/summaries/discover`);
  // The previous test's last run is this seed's newest shelf: only the clickbait video is left.
  const shelf = page.locator("section.dsc-shelf").filter({ has: page.locator("h3 a", { hasText: "E2E discover seed" }) });
  const card = shelf.locator(".dsc-card").filter({ hasText: "Invented clickbait" });
  await expect(card).toHaveCount(1);

  await card.getByRole("button", { name: "☆ Later" }).dblclick();
  await expect(card.locator('[data-act="later"]')).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(300);
  expect(statePosts).toEqual([{ videoId: NEW_C, state: "later" }]);

  failState = true;
  await card.getByRole("button", { name: "Summarize" }).click();
  await expect(page.locator("#dscToast")).toContainText("Invented DB outage.");
  await expect(card.getByRole("button", { name: "Summarize" })).toBeEnabled();

  failState = false;
  await card.getByRole("button", { name: "Summarize" }).click();
  await expect(card.getByRole("button", { name: "✓ Queued" })).toBeDisabled();
  await expect(card.locator('[data-act="later"]')).toHaveCount(0);
  await page.reload();
  await expect(card.getByRole("button", { name: "✓ Queued" })).toBeDisabled();
  await expect(card.locator('[data-act="later"]')).toHaveCount(0);
});

test("a dismissed card hands focus to its neighbour without scrolling the row back; Play keeps focus in the dialog; closing the drawer cancels its details request", async ({ page }) => {
  const sql = postgres(TEST_DB, { max: 1, onnotice: () => {} });
  try {
    const [run] = await sql`
      INSERT INTO youtube_discover_runs (seed_doc_id, seed_title, seed_video_id, seed_category, queries, searched, known, origin)
      VALUES (${FOCUS_SEED}, 'E2E focus seed', NULL, 'ai/e2e', '[]'::jsonb, 5, 0, 'reader') RETURNING id`;
    for (const [i, id] of FOCUS_IDS.entries()) {
      await sql`
        INSERT INTO youtube_discover_hits (run_id, video_id, title, channel, duration_sec, view_count, score, why, query, rank)
        VALUES (${run!.id}, ${id}, ${`Focus card ${i + 1}`}, 'F', 600, 10, ${0.9 - i / 10}, 'invented', 'q', ${i + 1})`;
    }
  } finally {
    await sql.end();
  }
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${BASE}/summaries/discover`);
  const shelf = page.locator("section.dsc-shelf").filter({ has: page.locator("h3 a", { hasText: "E2E focus seed" }) });
  const row = shelf.locator(".dsc-row");
  const card4 = shelf.locator(`.dsc-card[data-video="${FOCUS_IDS[3]}"]`);
  await card4.scrollIntoViewIfNeeded();
  const before = await row.evaluate((r) => r.scrollLeft);
  expect(before).toBeGreaterThan(0);
  await card4.locator(".dsc-x").focus();
  await page.keyboard.press("Enter");
  await expect(card4).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-video"))).toBe(FOCUS_IDS[4]);
  expect(await row.evaluate((r) => r.scrollLeft)).toBeGreaterThan(0);
  await page.locator("#dscToast").getByRole("button", { name: "Undo" }).click();
  await expect(card4).toHaveCount(1);

  // Play by keyboard: focus lands on the player, inside the dialog.
  await page.setViewportSize({ width: 1280, height: 800 });
  await shelf.locator(`.dsc-card[data-video="${FOCUS_IDS[0]}"]`).click();
  const drawer = page.locator("#dscDrawer");
  await drawer.getByRole("button", { name: "Play here" }).focus();
  await page.keyboard.press("Enter");
  await expect(drawer.locator("iframe")).toHaveCount(1);
  expect(await page.evaluate(() => !!document.activeElement?.closest("#dscDrawer"))).toBe(true);
  // …and Escape still closes it (focus is not inside the cross-origin frame).
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  // Closing the drawer before the details answer cancels the request.
  const aborted: string[] = [];
  page.on("requestfailed", (r) => {
    if (r.url().endsWith("/api/summaries/discover/details") && (r.postDataJSON() as { videoId: string }).videoId === FOCUS_IDS[1])
      aborted.push(r.failure()?.errorText ?? "");
  });
  // Held until the drawer is closed, so the abort never races the 200 ms seam answer.
  let releaseHeld!: () => void;
  const held = new Promise<void>((r) => (releaseHeld = r));
  await page.route("**/api/summaries/discover/details", async (route) => {
    if ((route.request().postDataJSON() as { videoId: string }).videoId === FOCUS_IDS[1]) await held;
    await route.continue().catch(() => undefined);
  });
  await shelf.locator(`.dsc-card[data-video="${FOCUS_IDS[1]}"]`).click();
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  releaseHeld();
  await expect.poll(() => aborted.length).toBe(1);
  await page.unroute("**/api/summaries/discover/details");
});

test("focus survives the details answer on every drawer control; Undo returns focus to the card; the nav is inert behind the dialog", async ({ page }) => {
  await page.goto(`${BASE}/summaries/discover`);
  const shelf = page.locator("section.dsc-shelf").filter({ has: page.locator("h3 a", { hasText: "E2E focus seed" }) });
  const drawer = page.locator("#dscDrawer");
  const active = () =>
    page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return a ? a.dataset.act ?? a.dataset.fk ?? a.tagName : null;
    });
  // Each drawer control, focused while the details request is held, keeps focus when the answer re-renders the drawer.
  const controls: { video: string; key: string; focus: () => Promise<void> }[] = [
    { video: FOCUS_IDS[2], key: "close", focus: () => drawer.getByRole("button", { name: "✕ Close" }).focus() },
    { video: FOCUS_IDS[3], key: "later", focus: () => drawer.locator('[data-act="later"]').focus() },
    { video: FOCUS_IDS[4], key: "open", focus: () => drawer.getByRole("link", { name: "Open ↗" }).focus() },
    {
      video: FOCUS_IDS[0],
      key: "player",
      focus: async () => {
        await drawer.getByRole("button", { name: "Play here" }).focus();
        await page.keyboard.press("Enter");
      },
    },
  ];
  for (const c of controls) {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/summaries/discover/details", async (route) => {
      await held;
      await route.continue().catch(() => undefined);
    });
    await shelf.locator(`.dsc-card[data-video="${c.video}"]`).click();
    await expect(drawer.locator(".dsc-note")).toContainText("Loading");
    await c.focus();
    expect(await active()).toBe(c.key);
    release();
    await expect(drawer.locator(".dsc-note")).not.toContainText("Loading", { timeout: 10_000 });
    expect(await active(), `focus after the details answer, control ${c.key}`).toBe(c.key);
    await page.unroute("**/api/summaries/discover/details");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  }

  // The site nav is inert while the dialog is open.
  await shelf.locator(`.dsc-card[data-video="${FOCUS_IDS[1]}"]`).click();
  expect(await page.locator("header").evaluate((h) => (h as HTMLElement).inert)).toBe(true);
  await page.keyboard.press("Escape");
  expect(await page.locator("header").evaluate((h) => (h as HTMLElement).inert)).toBe(false);

  // Undo puts focus back on the card it restored.
  const card = shelf.locator(`.dsc-card[data-video="${FOCUS_IDS[2]}"]`);
  await card.locator(".dsc-x").focus();
  await page.keyboard.press("Enter");
  await expect(card).toHaveCount(0);
  await page.locator("#dscToast").getByRole("button", { name: "Undo" }).click();
  await expect(card).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-video"))).toBe(FOCUS_IDS[2]);
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
// lays out differently (phone, the 701–1000 px band, the breakpoint, the band
// where the controls wrap, desktop). Above 700 px the primary action stays on
// the title's row; from 1280 px everything fits on one row.
for (const width of [390, 800, 1000, 1100, 1280, 1440]) {
  test(`at ${width}px the panel header keeps its title and fits its controls`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openDoc(page, "youtube", YT_DOC.id, "evaluating coding agents");
    await expect(page.locator("#docPanelDiscover")).toBeVisible();
    await expect(page.locator("#docPanelTitle")).toBeVisible();
    const m = await page.evaluate(() => {
      const header = document.querySelector(".doc-panel-header") as HTMLElement;
      const title = document.getElementById("docPanelTitle")!;
      const followUp = document.getElementById("docPanelFollowUp")!;
      const box = header.getBoundingClientRect();
      const shown = Array.from(header.children).filter((el) => (el as HTMLElement).offsetParent !== null);
      const spill = shown
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.right > box.right + 1 || r.left < box.left - 1;
        })
        .map((el) => el.id || el.className);
      const mid = (el: Element) => {
        const r = el.getBoundingClientRect();
        return Math.round(r.top + r.height / 2);
      };
      const back = header.querySelector(".doc-panel-close")!;
      const left = (el: Element) => el.getBoundingClientRect().left;
      return {
        leftToRight: left(back) < left(title) && left(title) < left(followUp),
        titleWidth: title.getBoundingClientRect().width,
        spill,
        followUpRowGap: Math.abs(mid(followUp) - mid(title)),
        rows: new Set(shown.map((el) => Math.round(mid(el) / 10))).size,
      };
    });
    expect(m.spill).toEqual([]);
    expect(m.titleWidth).toBeGreaterThanOrEqual(120);
    if (width > 700) {
      expect(m.followUpRowGap).toBeLessThanOrEqual(4);
      expect(m.leftToRight).toBe(true);
    }
    if (width >= 1280) expect(m.rows).toBe(1);
  });
}

test("the seed bar searches from the last 7 days one seed at a time, and each lands as its own shelf (PR 3)", async ({ page }) => {
  await page.goto(`${BASE}/summaries/discover`);
  const week = page.getByRole("button", { name: "+ Last 7 days" });
  await week.click();
  await expect(week).toHaveAttribute("aria-expanded", "true");
  const panel = page.locator("#dscSeedPanel");
  await expect(panel.locator(".dsc-seed-list li")).toHaveCount(2);
  await expect(panel).toContainText("E2E discover seed");
  await expect(panel).toContainText("E2E already captured");

  const posts: { docId: string; origin: string }[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/summaries/discover") && r.method() === "POST") posts.push(r.postDataJSON());
  });
  await panel.getByRole("button", { name: "Search from 2 summaries" }).click();
  await expect(panel).toBeHidden();
  const progress = page.locator("#dscProgress");
  await expect(progress).toContainText("Searching 1 of 2");
  await expect(progress).toContainText("Done: 2 new shelves", { timeout: 20_000 });
  expect(posts.map((p) => p.origin)).toEqual(["page", "page"]);
  expect(posts.map((p) => p.docId).sort()).toEqual([CAPTURED_DOC, YT_DOC.id].sort());
  await expect(week).toBeEnabled();

  // Both shelves re-rendered from the stored runs without a reload.
  await expect(page.locator(".dsc-shelf", { hasText: "E2E already captured" })).toHaveCount(1);
  await expect(page.locator(".dsc-shelf", { hasText: "E2E discover seed" })).toHaveCount(1);
  const sql = postgres(TEST_DB, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`SELECT seed_doc_id, origin FROM youtube_discover_runs WHERE seed_doc_id = ${CAPTURED_DOC}`;
    expect(rows.map((r) => r.origin)).toEqual(["page"]);
  } finally {
    await sql.end();
  }

  // "Show the first" goes to a stored shelf.
  await progress.getByRole("link", { name: "Show the first" }).click();
  await expect(page.locator(".dsc-shelf.dsc-target")).toHaveCount(1);
});

test("the category and pick seed panels: newest per category, and a filter that keeps the pick (PR 3)", async ({ page }) => {
  await page.goto(`${BASE}/summaries/discover`);
  await page.getByRole("button", { name: "+ A category…" }).click();
  const panel = page.locator("#dscSeedPanel");
  await expect(panel.locator("#dscSeedCat")).toBeFocused();
  await expect(panel.locator("#dscSeedCat option")).toHaveText(["ai/e2e (2)"]);
  await expect(panel.getByRole("button", { name: "Search from 2 summaries" })).toBeEnabled();

  await page.getByRole("button", { name: "+ Pick summaries…" }).click();
  await expect(page.getByRole("button", { name: "+ A category…" })).toHaveAttribute("aria-expanded", "false");
  const filter = panel.locator("#dscSeedFilter");
  await expect(filter).toBeFocused();
  await expect(panel.getByRole("button", { name: "Search", exact: true })).toBeDisabled();
  await filter.fill("already");
  await expect(panel.locator("[data-pick]")).toHaveCount(1);
  await panel.locator("[data-pick]").check();
  await expect(panel.locator("#dscPickCount")).toHaveText("1 of 5 chosen");
  await expect(panel.getByRole("button", { name: "Search from 1 summary" })).toBeEnabled();
  // The pick survives a filter change.
  await filter.fill("");
  await expect(panel.locator("[data-pick]")).toHaveCount(2);
  await expect(panel.locator(`[data-pick="${CAPTURED_DOC}"]`)).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: "+ Pick summaries…" })).toBeFocused();
});

/** A fresh batch shelf, and no stored run for CAPTURED_DOC, so a Last 7 days run adds that shelf. */
async function seedBatchShelf(): Promise<void> {
  const sql = postgres(TEST_DB, { max: 1, onnotice: () => {} });
  try {
    await sql`DELETE FROM youtube_discover_runs WHERE seed_doc_id IN (${BATCH_SEED}, ${CAPTURED_DOC})`;
    await sql`DELETE FROM youtube_discover_hits WHERE video_id LIKE 'e2eBatch%'`;
    const [run] = await sql`
      INSERT INTO youtube_discover_runs (seed_doc_id, seed_title, seed_video_id, seed_category, queries, searched, known, origin)
      VALUES (${BATCH_SEED}, 'E2E batch seed', NULL, 'ai/e2e', '[]'::jsonb, 2, 0, 'reader') RETURNING id`;
    for (const [i, id] of BATCH_IDS.entries()) {
      await sql`
        INSERT INTO youtube_discover_hits (run_id, video_id, title, channel, duration_sec, view_count, score, why, query, rank)
        VALUES (${run!.id}, ${id}, ${`Batch card ${i + 1}`}, 'B', 600, 10, ${0.9 - i / 10}, 'invented', 'q', ${i + 1})`;
    }
  } finally {
    await sql.end();
  }
}

/** Answer the shelves GET with what the server read when asked, `ms` later. */
async function holdShelves(page: Page, ms: number): Promise<void> {
  await page.route("**/api/summaries/discover/shelves", async (route) => {
    const res = await route.fetch();
    await new Promise((r) => setTimeout(r, ms));
    await route.fulfill({ response: res });
  });
}

const batchShelf = (page: Page) => page.locator("section.dsc-shelf").filter({ has: page.locator("h3 a", { hasText: "E2E batch seed" }) });

test("starting a seed run by keyboard moves focus to the progress line (fix round 1 batch 3)", async ({ page }) => {
  await seedBatchShelf();
  await page.goto(`${BASE}/summaries/discover`);
  await page.getByRole("button", { name: "+ Last 7 days" }).click();
  const run = page.locator("#dscSeedPanel").getByRole("button", { name: /Search from/ });
  await run.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#dscProgress")).toBeFocused();
  await expect(page.locator("#dscProgress")).toContainText("Done", { timeout: 20_000 });
});

test("a Later pressed while a shelves re-read is in flight survives that re-read (fix round 1 batch 3)", async ({ page }) => {
  await seedBatchShelf();
  await page.goto(`${BASE}/summaries/discover`);
  await holdShelves(page, 1500);
  await page.getByRole("button", { name: "+ Last 7 days" }).click();
  const shelvesAsked = page.waitForRequest("**/api/summaries/discover/shelves");
  await page.locator("#dscSeedPanel").getByRole("button", { name: /Search from/ }).click();
  await shelvesAsked;
  const later = batchShelf(page).locator(`.dsc-card[data-video="${BATCH_IDS[0]}"] [data-act="later"]`);
  await later.click();
  await expect(later).toHaveAttribute("aria-pressed", "true");
  // The first re-read renders before the progress moves on: read once, no polling (the second re-read
  // would bring the write back inside a polling window and hide the overwrite).
  await expect(page.locator("#dscProgress")).toContainText("Searching 2 of 2", { timeout: 20_000 });
  expect(await later.getAttribute("aria-pressed")).toBe("true");
  await expect(page.locator("#dscProgress")).toContainText("Done", { timeout: 20_000 });
  await expect(later).toHaveAttribute("aria-pressed", "true");
});

test("shelves that land while the drawer is open wait until it closes; focus returns to the card (fix round 1 batch 3)", async ({ page }) => {
  await seedBatchShelf();
  await page.goto(`${BASE}/summaries/discover`);
  await holdShelves(page, 800);
  await page.getByRole("button", { name: "+ Last 7 days" }).click();
  await page.locator("#dscSeedPanel").getByRole("button", { name: /Search from/ }).click();
  const card = batchShelf(page).locator(`.dsc-card[data-video="${BATCH_IDS[0]}"]`);
  await card.click();
  const drawer = page.locator("#dscDrawer");
  await expect(drawer).toBeVisible();
  await expect(page.locator("#dscProgress")).toContainText("Done", { timeout: 20_000 });
  await expect(drawer).toBeVisible();
  const captured = page.locator(".dsc-shelf", { hasText: "E2E already captured" });
  await expect(captured).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(captured).toHaveCount(1);
  await expect(card).toBeFocused();
});

test("Undo after a run replaced the card's shelf focuses the restored card (fix round 1 batch 4)", async ({ page }) => {
  await seedBatchShelf();
  await page.goto(`${BASE}/summaries/discover`);
  // The re-read answers the batch shelf under a new run id: a newer run of its seed replaced it.
  await page.route("**/api/summaries/discover/shelves", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { shelves: { runId: string; seedDocId: string }[] };
    for (const s of body.shelves) if (s.seedDocId === BATCH_SEED) s.runId = "00000000-0000-4000-8000-0000000000b4";
    await route.fulfill({ response: res, json: body });
  });
  const card = (p: Page) => batchShelf(p).locator(`.dsc-card[data-video="${BATCH_IDS[0]}"]`);
  await card(page).locator('[data-act="dismiss"]').click();
  await expect(card(page)).toHaveCount(0);
  await page.getByRole("button", { name: "+ Last 7 days" }).click();
  await page.locator("#dscSeedPanel").getByRole("button", { name: /Search from/ }).click();
  await expect(page.locator("#dscProgress")).toContainText("Done", { timeout: 20_000 });
  await expect(batchShelf(page)).toHaveAttribute("data-run", "00000000-0000-4000-8000-0000000000b4");
  await page.locator("#dscToast [data-undo]").click();
  await expect(card(page)).toBeFocused();
});

test("a run that ends while the drawer is open is announced through the toast (fix round 1 batch 4)", async ({ page }) => {
  await seedBatchShelf();
  await page.goto(`${BASE}/summaries/discover`);
  await holdShelves(page, 500);
  await page.getByRole("button", { name: "+ Last 7 days" }).click();
  await page.locator("#dscSeedPanel").getByRole("button", { name: /Search from/ }).click();
  await batchShelf(page).locator(`.dsc-card[data-video="${BATCH_IDS[0]}"]`).click();
  await expect(page.locator("#dscDrawer")).toBeVisible();
  await expect(page.locator("#dscProgress")).toContainText("Done", { timeout: 20_000 });
  await expect(page.locator("#dscAnnounce")).toContainText("2 new shelves");
});

test("at 390px a long category name never widens the page (fix round 1 batch 4)", async ({ page }) => {
  const LONG = "ai/an-invented-category-name-that-is-far-too-long-for-a-phone/and-a-sub-folder";
  await page.route("**/api/summaries/discover/seeds", (route) =>
    route.fulfill({
      json: {
        docs: [{ id: `${LONG}/Invented.md`, title: "Invented", category: LONG, date: "2026-11-14" }],
        categories: [{ category: LONG, count: 1 }],
        now: Date.parse("2026-11-14T12:00:00Z"),
      },
    }),
  );
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${BASE}/summaries/discover`);
  await page.getByRole("button", { name: "+ A category…" }).click();
  await expect(page.locator("#dscSeedCat")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("a pick run clears the picks (fix round 1 batch 5)", async ({ page }) => {
  await seedBatchShelf();
  await page.goto(`${BASE}/summaries/discover`);
  await page.getByRole("button", { name: "+ Pick summaries…" }).click();
  const panel = page.locator("#dscSeedPanel");
  await panel.locator(`[data-pick="${CAPTURED_DOC}"]`).check();
  await panel.getByRole("button", { name: "Search from 1 summary" }).click();
  await expect(page.locator("#dscProgress")).toContainText("Done", { timeout: 20_000 });
  await page.getByRole("button", { name: "+ Pick summaries…" }).click();
  await expect(panel.locator("#dscPickCount")).toHaveText("0 of 5 chosen");
  await expect(panel.locator(`[data-pick="${CAPTURED_DOC}"]`)).not.toBeChecked();
});

test("a failed shelves re-read is said, with no link to a shelf that is not on the page (fix round 1 batch 5)", async ({ page }) => {
  await seedBatchShelf();
  await page.goto(`${BASE}/summaries/discover`);
  await page.route("**/api/summaries/discover/shelves", (route) => route.fulfill({ status: 500, json: { error: "down" } }));
  await page.getByRole("button", { name: "+ Last 7 days" }).click();
  await page.locator("#dscSeedPanel").getByRole("button", { name: /Search from/ }).click();
  const progress = page.locator("#dscProgress");
  await expect(progress).toContainText("Done", { timeout: 20_000 });
  await expect(progress).toContainText("could not be shown");
  await expect(progress.getByRole("link", { name: "Show the first" })).toHaveCount(0);
});

test("the seed listing is read again when it is over 10 minutes old (fix round 1 batch 5)", async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/summaries/discover/seeds")) reads++;
  });
  await page.goto(`${BASE}/summaries/discover`);
  // The age counts from the read, not from the page load: read 9 minutes in, reopen 2 minutes later.
  await page.clock.fastForward("09:00");
  const pick = page.getByRole("button", { name: "+ Pick summaries…" });
  await pick.click();
  await expect(page.locator("#dscSeedFilter")).toBeVisible();
  await pick.click();
  await page.clock.fastForward("02:00");
  await pick.click();
  await expect(page.locator("#dscSeedFilter")).toBeVisible();
  expect(reads).toBe(1);
  await pick.click();
  await page.clock.fastForward("11:00");
  await pick.click();
  await expect(page.locator("#dscSeedFilter")).toBeVisible();
  await expect.poll(() => reads).toBe(2);
});

/** The batch shelf, plus a stored CAPTURED_DOC shelf with two invented cards that a Last 7 days run replaces. */
async function seedBatchAndCapturedShelves(): Promise<string> {
  await seedBatchShelf();
  const sql = postgres(TEST_DB, { max: 1, onnotice: () => {} });
  try {
    await sql`DELETE FROM youtube_discover_hits WHERE video_id LIKE 'e2eCapt%'`;
    const [run] = await sql`
      INSERT INTO youtube_discover_runs (seed_doc_id, seed_title, seed_video_id, seed_category, queries, searched, known, origin)
      VALUES (${CAPTURED_DOC}, 'E2E already captured', ${KNOWN}, 'ai/e2e', '[]'::jsonb, 2, 0, 'reader') RETURNING id`;
    for (const [i, id] of ["e2eCapt0001", "e2eCapt0002"].entries()) {
      await sql`
        INSERT INTO youtube_discover_hits (run_id, video_id, title, channel, duration_sec, view_count, score, why, query, rank)
        VALUES (${run!.id}, ${id}, ${`Captured card ${i + 1}`}, 'C', 600, 10, ${0.9 - i / 10}, 'invented', 'q', ${i + 1})`;
    }
    return run!.id as string;
  } finally {
    await sql.end();
  }
}

test("dismissing from the drawer after a held run replaced its shelf keeps focus on that seed's new shelf (fix round 2 batch 2)", async ({ page }) => {
  const oldRun = await seedBatchAndCapturedShelves();
  await page.goto(`${BASE}/summaries/discover`);
  await holdShelves(page, 800);
  await page.getByRole("button", { name: "+ Last 7 days" }).click();
  await page.locator("#dscSeedPanel").getByRole("button", { name: /Search from/ }).click();
  const captured = page.locator("section.dsc-shelf").filter({ has: page.locator("h3 a", { hasText: "E2E already captured" }) });
  await captured.locator('.dsc-card[data-video="e2eCapt0001"]').click();
  await expect(page.locator("#dscDrawer")).toBeVisible();
  await expect(page.locator("#dscProgress")).toContainText("Done", { timeout: 20_000 });
  await page.locator("#dscDrawer").getByRole("button", { name: "✕ Not interested" }).click();
  await expect(page.locator("#dscDrawer")).toBeHidden();
  // The held shelves were applied by the dismiss's render: the seed's shelf is its new run.
  await expect(captured).not.toHaveAttribute("data-run", oldRun);
  expect(await page.evaluate(() => document.activeElement?.closest("section.dsc-shelf")?.querySelector("h3")?.textContent ?? "BODY")).toContain(
    "E2E already captured",
  );
});

test("the run outcome under the drawer leaves a pending Undo alone (fix round 2 batch 2)", async ({ page }) => {
  await seedBatchShelf();
  await page.goto(`${BASE}/summaries/discover`);
  await holdShelves(page, 500);
  await page.getByRole("button", { name: "+ Last 7 days" }).click();
  await page.locator("#dscSeedPanel").getByRole("button", { name: /Search from/ }).click();
  // Dismiss after the run started: the toast's 5 s then has to outlast only the rest of the run.
  await batchShelf(page).locator(`.dsc-card[data-video="${BATCH_IDS[1]}"] [data-act="dismiss"]`).click();
  await expect(page.locator("#dscToast")).toContainText("Dismissed");
  await batchShelf(page).locator(`.dsc-card[data-video="${BATCH_IDS[0]}"]`).click();
  await expect(page.locator("#dscProgress")).toContainText("Done", { timeout: 20_000 });
  await expect(page.locator("#dscAnnounce")).toContainText("2 new shelves");
  await expect(page.locator("#dscToast")).toContainText("Dismissed");
  await expect(page.locator("#dscToast")).not.toContainText("new shelves");
});

test("Undo from the toast while the drawer is open keeps focus in the drawer (fix round 2 batch 2)", async ({ page }) => {
  await seedBatchShelf();
  await page.goto(`${BASE}/summaries/discover`);
  await batchShelf(page).locator(`.dsc-card[data-video="${BATCH_IDS[1]}"] [data-act="dismiss"]`).click();
  await batchShelf(page).locator(`.dsc-card[data-video="${BATCH_IDS[0]}"]`).click();
  await expect(page.locator("#dscDrawer")).toBeVisible();
  await page.locator("#dscToast [data-undo]").click();
  await expect(batchShelf(page).locator(`.dsc-card[data-video="${BATCH_IDS[1]}"]`)).toHaveCount(1);
  expect(await page.evaluate(() => !!document.activeElement?.closest("#dscDrawer"))).toBe(true);
});

test("a failed re-read of a stale listing keeps the old one usable and says so (fix round 2 batch 3)", async ({ page }) => {
  await page.clock.install();
  await page.goto(`${BASE}/summaries/discover`);
  const pick = page.getByRole("button", { name: "+ Pick summaries…" });
  await pick.click();
  await expect(page.locator("#dscSeedFilter")).toBeVisible();
  await pick.click();
  await page.route("**/api/summaries/discover/seeds", (route) => route.fulfill({ status: 500, json: { error: "down" } }));
  await page.clock.fastForward("11:00");
  await pick.click();
  await expect(page.locator("#dscSeedPanel")).toContainText("Could not refresh");
  await expect(page.locator("#dscSeedFilter")).toBeVisible();
  await expect(page.locator("#dscSeedPanel [data-pick]")).toHaveCount(2);
});

test("a re-read that fails and a later one that lands: the shelves are shown, the link kept (fix round 2 batch 3)", async ({ page }) => {
  await seedBatchShelf();
  await page.goto(`${BASE}/summaries/discover`);
  let reads = 0;
  await page.route("**/api/summaries/discover/shelves", async (route) => {
    reads++;
    if (reads === 1) return route.fulfill({ status: 500, json: { error: "down" } });
    return route.continue();
  });
  await page.getByRole("button", { name: "+ Last 7 days" }).click();
  await page.locator("#dscSeedPanel").getByRole("button", { name: /Search from/ }).click();
  const progress = page.locator("#dscProgress");
  await expect(progress).toContainText("Done", { timeout: 20_000 });
  await expect(progress).not.toContainText("could not be shown");
  await expect(progress.getByRole("link", { name: "Show the first" })).toHaveCount(1);
});

test("picks stay when another mode runs, and a pick that failed stays for a retry (fix round 2 batch 3)", async ({ page }) => {
  await seedBatchShelf();
  await page.goto(`${BASE}/summaries/discover`);
  const panel = page.locator("#dscSeedPanel");
  await page.getByRole("button", { name: "+ Pick summaries…" }).click();
  await panel.locator(`[data-pick="${CAPTURED_DOC}"]`).check();
  await page.getByRole("button", { name: "+ A category…" }).click();
  await panel.getByRole("button", { name: /Search from/ }).click();
  await expect(page.locator("#dscProgress")).toContainText("Done", { timeout: 20_000 });
  await page.getByRole("button", { name: "+ Pick summaries…" }).click();
  await expect(panel.locator("#dscPickCount")).toHaveText("1 of 5 chosen");

  await page.route("**/api/summaries/discover", (route) =>
    route.request().method() === "POST" ? route.fulfill({ status: 502, json: { error: "model down", code: "model_failed" } }) : route.continue(),
  );
  await panel.getByRole("button", { name: "Search from 1 summary" }).click();
  await expect(page.locator("#dscProgress")).toContainText("1 failed", { timeout: 20_000 });
  await page.getByRole("button", { name: "+ Pick summaries…" }).click();
  await expect(panel.locator("#dscPickCount")).toHaveText("1 of 5 chosen");
});

/** The seeds route answers `docs` (one category each) on the next read: a listing that changed. */
async function routeSeeds(page: Page, docs: { id: string; category: string }[]): Promise<void> {
  await page.unroute("**/api/summaries/discover/seeds");
  await page.route("**/api/summaries/discover/seeds", (route) =>
    route.fulfill({
      json: {
        docs: docs.map((d) => ({ id: d.id, title: d.id.split("/").pop()!.replace(/\.md$/, ""), category: d.category, date: "2026-11-14" })),
        categories: [...new Set(docs.map((d) => d.category))].map((category) => ({ category, count: docs.filter((d) => d.category === category).length })),
        now: Date.parse("2026-11-14T12:00:00Z"),
      },
    }),
  );
}

test("a re-read drops picks and a category the new listing no longer has (fix round 2 batch 4)", async ({ page }) => {
  await page.clock.install();
  await routeSeeds(page, [
    { id: "old/Gone talk.md", category: "old" },
    { id: "new/Kept talk.md", category: "new" },
  ]);
  await page.goto(`${BASE}/summaries/discover`);
  const panel = page.locator("#dscSeedPanel");
  await page.getByRole("button", { name: "+ Pick summaries…" }).click();
  await panel.locator('[data-pick="old/Gone talk.md"]').check();
  await page.getByRole("button", { name: "+ A category…" }).click();
  await panel.locator("#dscSeedCat").selectOption("old");
  await page.getByRole("button", { name: "+ A category…" }).click();
  await routeSeeds(page, [{ id: "new/Kept talk.md", category: "new" }]);
  await page.clock.fastForward("11:00");
  await page.getByRole("button", { name: "+ A category…" }).click();
  await expect(panel.locator("#dscSeedCat")).toHaveValue("new");
  await expect(panel.getByRole("button", { name: "Search from 1 summary" })).toBeEnabled();
  await page.getByRole("button", { name: "+ Pick summaries…" }).click();
  await expect(panel.locator("#dscPickCount")).toHaveText("0 of 5 chosen");
});

test("a successful re-read clears the refresh warning (fix round 2 batch 4)", async ({ page }) => {
  await page.clock.install();
  await page.goto(`${BASE}/summaries/discover`);
  const pick = page.getByRole("button", { name: "+ Pick summaries…" });
  await pick.click();
  await expect(page.locator("#dscSeedFilter")).toBeVisible();
  await pick.click();
  await page.route("**/api/summaries/discover/seeds", (route) => route.fulfill({ status: 500, json: { error: "down" } }));
  await page.clock.fastForward("11:00");
  await pick.click();
  await expect(page.locator("#dscSeedPanel")).toContainText("Could not refresh");
  await pick.click();
  await page.unroute("**/api/summaries/discover/seeds");
  await pick.click();
  await expect(page.locator("#dscSeedFilter")).toBeVisible();
  await expect(page.locator("#dscSeedPanel")).not.toContainText("Could not refresh");
});

test("a re-read keeps every pick and the category the new listing still has (fix round 2 batch 7)", async ({ page }) => {
  await page.clock.install();
  await routeSeeds(page, [
    { id: "a/One.md", category: "a" },
    { id: "a/Two.md", category: "a" },
    { id: "b/Three.md", category: "b" },
    { id: "b/Gone.md", category: "b" },
  ]);
  await page.goto(`${BASE}/summaries/discover`);
  const panel = page.locator("#dscSeedPanel");
  await page.getByRole("button", { name: "+ Pick summaries…" }).click();
  for (const id of ["a/One.md", "a/Two.md", "b/Three.md", "b/Gone.md"]) await panel.locator(`[data-pick="${id}"]`).check();
  await page.getByRole("button", { name: "+ A category…" }).click();
  await panel.locator("#dscSeedCat").selectOption("b");
  await page.getByRole("button", { name: "+ A category…" }).click();
  // The new listing orders "a" first and drops two picks: the kept category and the two kept picks stay.
  await routeSeeds(page, [
    { id: "a/One.md", category: "a" },
    { id: "a/New.md", category: "a" },
    { id: "a/Newer.md", category: "a" },
    { id: "b/Three.md", category: "b" },
  ]);
  await page.clock.fastForward("11:00");
  await page.getByRole("button", { name: "+ A category…" }).click();
  await expect(panel.locator("#dscSeedCat")).toHaveValue("b");
  await page.getByRole("button", { name: "+ Pick summaries…" }).click();
  await expect(panel.locator("#dscPickCount")).toHaveText("2 of 5 chosen");
  await expect(panel.locator('[data-pick="a/One.md"]')).toBeChecked();
  await expect(panel.locator('[data-pick="b/Three.md"]')).toBeChecked();
});

test("the listing is not read again at 9 min 59 s, and is at 10 min 1 s (fix round 2 batch 7)", async ({ page }) => {
  await page.clock.install();
  let reads = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/summaries/discover/seeds")) reads++;
  });
  await page.goto(`${BASE}/summaries/discover`);
  const pick = page.getByRole("button", { name: "+ Pick summaries…" });
  await pick.click();
  await expect(page.locator("#dscSeedFilter")).toBeVisible();
  await pick.click();
  await page.clock.fastForward("09:59");
  await pick.click();
  await expect(page.locator("#dscSeedFilter")).toBeVisible();
  expect(reads).toBe(1);
  await pick.click();
  await page.clock.fastForward("00:02");
  await pick.click();
  await expect.poll(() => reads).toBe(2);
});

test("the announcer stays outside the drawer's inert set (fix round 2 batch 7)", async ({ page }) => {
  await seedBatchShelf();
  await page.goto(`${BASE}/summaries/discover`);
  await batchShelf(page).locator(`.dsc-card[data-video="${BATCH_IDS[0]}"]`).click();
  await expect(page.locator("#dscDrawer")).toBeVisible();
  expect(await page.evaluate(() => !document.getElementById("dscAnnounce")?.closest("[inert]"))).toBe(true);
  expect(await page.evaluate(() => !!document.getElementById("dscProgress")?.closest("[inert]"))).toBe(true);
});

test("closing the drawer from the backdrop after a held run replaced its shelf focuses the card on the new run (fix round 2 batch 8)", async ({ page }) => {
  await seedBatchShelf();
  await page.goto(`${BASE}/summaries/discover`);
  const NEW_RUN = "00000000-0000-4000-8000-0000000000b8";
  await page.route("**/api/summaries/discover/shelves", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { shelves: { runId: string; seedDocId: string }[] };
    for (const sh of body.shelves) if (sh.seedDocId === BATCH_SEED) sh.runId = NEW_RUN;
    await new Promise((r) => setTimeout(r, 500));
    await route.fulfill({ response: res, json: body });
  });
  await page.getByRole("button", { name: "+ Last 7 days" }).click();
  await page.locator("#dscSeedPanel").getByRole("button", { name: /Search from/ }).click();
  await batchShelf(page).locator(`.dsc-card[data-video="${BATCH_IDS[0]}"]`).click();
  await expect(page.locator("#dscDrawer")).toBeVisible();
  await expect(page.locator("#dscProgress")).toContainText("Done", { timeout: 20_000 });
  await page.locator("#dscDrawerBg").click({ position: { x: 10, y: 10 } });
  await expect(page.locator("#dscDrawer")).toBeHidden();
  await expect(page.locator(`.dsc-card[data-run="${NEW_RUN}"][data-video="${BATCH_IDS[0]}"]`)).toBeFocused();
});
