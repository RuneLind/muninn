/**
 * The article pane's one view owner, in a real browser (architecture review
 * 2026-11-16, B6: F21 and F22).
 *
 * What the happy-dom boot tests cannot prove: that the real client bundle, served
 * by a booted muninn, keeps a stored Ask turn's view clean while another turn
 * streams (F21), and that a page response held past a view change paints nothing
 * (F22), in a browser's own event loop and rAF timing.
 *
 * **What is stubbed and why.** The Ask stream is an `EventSource` the page opens;
 * a network stub delivers a whole body at once, and F21 needs events to arrive
 * AFTER the reader has clicked. So an init script replaces `EventSource` with a
 * fake the test drives (`window.__askStreams`). `/api/wiki/remember` is stubbed
 * at the network boundary to read what Remember posts; it would call a model.
 * Everything else is real: the server, the wiki, the bundle, the session
 * rehydrate from localStorage.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-ask-pane-view");
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI_NAME = "e2e-ask-pane";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const STORED = [{ question: "What did we decide?", answer: "We decided X.", citations: [], cited: [], html: "<p>We decided X.</p>", askedAt: 1_700_000_000_000 }];

/** The fake `EventSource`: every instance lands in `window.__askStreams`, and
 *  `window.__emit(i, type, data)` dispatches one server event into instance i. */
const FAKE_EVENT_SOURCE = `
  (() => {
    const all = [];
    class FakeEventSource {
      constructor(url) { this.url = String(url); this.readyState = 1; this.h = new Map(); this.onopen = null; this.onerror = null; all.push(this); }
      addEventListener(t, fn) { this.h.set(t, [...(this.h.get(t) || []), fn]); }
      removeEventListener() {}
      close() { this.readyState = 2; }
    }
    window.EventSource = FakeEventSource;
    window.__askStreams = all;
    window.__emit = (i, type, data) => {
      for (const fn of all[i].h.get(type) || []) fn(new MessageEvent(type, { data: JSON.stringify(data) }));
    };
  })();
`;

const emit = (page: Page, i: number, type: string, data: unknown) =>
  page.evaluate(([i, type, data]) => (window as unknown as { __emit(i: number, t: string, d: unknown): void }).__emit(i as number, type as string, data), [i, type, data] as const);
const histItem = (page: Page, q: string) => page.locator(".wiki-ask-hist-item", { hasText: q });
const nextFrame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

let root: string;
let server: ChildProcess | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-ask-pane-"));
  await writeFile(path.join(root, "alpha.md"), "---\ntitle: Alpha\n---\n\n# Alpha\n\nAlpha body.\n", "utf8");
  await writeFile(path.join(root, "beta.md"), "---\ntitle: Beta\n---\n\n# Beta\n\nBeta body.\n", "utf8");
  await writeFile(path.join(root, "log.md"), "# Log\n", "utf8");
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...e2eEnv(), DASHBOARD_PORT: String(PORT), DASHBOARD_HOST: "127.0.0.1", SCHEDULER_ENABLED: "false", WIKI_EXTRA: `${WIKI_NAME}=${root}` },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI_NAME}`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.afterAll(async () => {
  server?.kill();
  if (root) await rm(root, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(FAKE_EVENT_SOURCE);
  await page.goto(`${BASE}/wiki?wiki=${WIKI_NAME}`, { waitUntil: "domcontentloaded" });
  const wikiName = await page.evaluate(() => (window as { __WIKI_NAME__?: string }).__WIKI_NAME__ ?? "");
  await page.evaluate(([k, v]) => localStorage.setItem(k!, v!), [`wikiAskSession:${wikiName}`, JSON.stringify(STORED)]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('.wiki-conn-tab[data-conntab="ask"]').click();
  await expect(histItem(page, "What did we decide?")).toBeVisible();
});

test("F21: a stored turn opened mid-stream never shows the live turn's text, and Remember posts its own answer", async ({ page }) => {
  const remembered: unknown[] = [];
  await page.route(
    (u) => u.pathname === "/api/wiki/remember",
    async (route) => {
      remembered.push(JSON.parse(route.request().postData() ?? "{}"));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ saved: true, summary: "ok" }) });
    },
  );
  await page.locator("#wikiAskInput").fill("Live question?");
  await page.locator("#wikiAskBtn").click();
  await emit(page, 0, "delta", { text: "LIVE-ONE " });
  await expect(page.locator("#askAnswerBody")).toContainText("LIVE-ONE");

  await histItem(page, "What did we decide?").click();
  const wrap = page.locator("#articleWrap");
  const historyShown = async (step: string) => {
    await nextFrame(page);
    const html = await wrap.innerHTML();
    console.log(`[F21] after ${step}: shows stored answer=${html.includes("We decided X.")} live text=${html.includes("LIVE")}`);
    expect(html).toContain("We decided X.");
    expect(html).not.toContain("LIVE");
  };
  await emit(page, 0, "sources", { citations: [{ n: 1, collection: "c", docId: "d", title: "LIVE-SRC", badge: "b", relevance: 1 }] });
  await historyShown("sources");
  await emit(page, 0, "delta", { text: "LIVE-TWO" });
  await historyShown("delta");
  await emit(page, 0, "done", { answer: "LIVE-ONE LIVE-TWO final", cited: [1] });
  await historyShown("done");
  await emit(page, 0, "answer_html", { html: "<p>LIVE-HTML final</p>", cited: [1] });
  await historyShown("answer_html");

  await histItem(page, "Live question?").click();
  await expect(page.locator("#askAnswerBody")).toContainText("LIVE-HTML final");
  await expect(page.locator("#askAnswerSources")).toContainText("LIVE-SRC");
  console.log(`[F21] live turn re-opened: ${(await page.locator("#askAnswerBody").innerText()).trim()} | sources: ${(await page.locator("#askAnswerSources").innerText()).replace(/\s+/g, " ").trim()}`);

  await histItem(page, "What did we decide?").click();
  await page.locator("#wikiRememberBtn").click();
  await expect.poll(() => remembered.length).toBe(1);
  console.log(`[F21] Remember posted: ${JSON.stringify(remembered[0])}`);
  expect(remembered[0]).toMatchObject({ question: "What did we decide?", answer: "We decided X." });
});

test("F22: a page response held past an Ask answer paints nothing; the answer and its panes stay", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(
    (u) => u.pathname === "/api/wiki/page" && u.searchParams.get("relPath") === "beta.md",
    async (route) => {
      await held;
      await route.continue();
    },
  );
  await page.locator('#wikiList .wiki-list-item[data-relpath="beta.md"]').click();
  await page.waitForTimeout(200);
  await histItem(page, "What did we decide?").click();
  await expect(page.locator("#askAnswerBody")).toContainText("We decided X.");
  const responded = page.waitForResponse((r) => r.url().includes("relPath=beta.md"));
  release();
  await responded;
  await page.waitForTimeout(300);
  const article = (await page.locator("#articleWrap").innerText()).replace(/\s+/g, " ").slice(0, 120);
  console.log(`[F22] after the held beta.md response: ${article}`);
  await expect(page.locator("#askAnswerBody")).toContainText("We decided X.");
  await expect(page.locator("#articleWrap")).not.toContainText("Beta body.");
  await expect(page.locator("#wikiBreadcrumb")).toBeHidden();
});
