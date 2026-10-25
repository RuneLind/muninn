/**
 * `/summaries` — a web page pasted into the article form keeps its links.
 *
 * Plan muninn-summary-links, PR 2: the paste handler reads the clipboard's
 * `text/html` flavour and converts it with the shared walk
 * (`src/summaries/html-to-markdown.ts`), so `[text](href)` reaches the server;
 * the article vertical numbers the links for the model's `LINKS:` pick and
 * appends a `## Links` section built from that pick. Only this tier sees the
 * whole chain — a real browser paste event, the injected walk, the route, the
 * summarizer and the body huginn is handed.
 *
 * Fixture: a spawned muninn whose throwaway summarizer bot is an
 * `openai-compat` bot pointed at a `node:http` fake, which also plays huginn's
 * `POST /api/articles/ingest` and records what arrives. The fake model answers
 * `LINKS: 1, 2`, so the test proves the hrefs survive the paste, the prompt and
 * the render — not that a model picks well. No real model call, no write
 * outside the fake. Bot under `MUNINN_BOTS_DIR` (a temp dir), ports from
 * `e2e/ports.ts`. The markup and URLs are invented.
 *
 * ENV PREREQUISITE: `bun run db:setup:test`.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("summaries-paste-links");
const FAKE_PORT = e2ePort("summaries-paste-links/fake");
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const BOT = "e2epastelinks";

const PAPER = "https://example.org/invented-paper";
const HARNESS = "https://example.net/invented-harness";
const PASTED_HTML =
  '<meta charset="utf-8"><h2>An invented post</h2>' +
  `<p>It cites <a href="${PAPER}">the invented paper</a> and builds on ` +
  `<a href="${HARNESS}">an invented harness</a>, then states one finding.</p>`;

let server: ChildProcess | undefined;
let fake: Server | undefined;
let botsRoot: string | undefined;
let ingests: Array<Record<string, unknown>> = [];
let userPrompts: string[] = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
  });
}

async function startFake(): Promise<Server> {
  const srv = createServer((req, res) => {
    void (async () => {
      const p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      const json = (body: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (p === "/v1/chat/completions") {
        const body = JSON.parse((await readBody(req)) || "{}") as { messages?: Array<{ role: string; content: string }> };
        for (const m of body.messages ?? []) if (m.role === "user") userPrompts.push(m.content);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const chunk = (delta: Record<string, unknown>) =>
          `data: ${JSON.stringify({ model: "e2e-fake", choices: [{ index: 0, delta }] })}\n\n`;
        res.write(chunk({ content: "CATEGORY: ai/general\nLINKS: 1, 2\n\nSUMMARY:\n" }));
        res.write(chunk({ content: "### What it says\n- One invented finding.\n" }));
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      if (p === "/api/articles/ingest") {
        ingests.push(JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>);
        return json({ file_path: "ai/general/An invented post.md", similar: [] });
      }
      if (p === "/api/collections") return json({ collections: [] });
      if (p.endsWith("/documents")) return json({ documents: [] });
      if (p === "/api/search") return json({ results: [] });
      return json({ detail: "not in this fake" }, 404);
    })();
  });
  await new Promise<void>((resolve) => srv.listen(FAKE_PORT, "127.0.0.1", resolve));
  return srv;
}

function writeBot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "muninn-e2e-paste-links-bots-"));
  const dir = path.join(root, BOT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "CLAUDE.md"), "# e2e paste-links summarizer\n\nCreated by e2e/summaries-paste-links.spec.ts.\n");
  writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ connector: "openai-compat", model: "e2e-fake", baseUrl: `${FAKE}/v1`, timeoutMs: 60000 }, null, 2),
  );
  botsRoot = root;
  return root;
}

function cleanup(): void {
  server?.kill("SIGTERM");
  fake?.close();
  if (botsRoot) rmSync(botsRoot, { recursive: true, force: true });
  botsRoot = undefined;
}

// A hard kill skips `afterAll`; re-raise after cleaning up (the summaries-rerun shape).
function handleSignal(signal: NodeJS.Signals): void {
  cleanup();
  removeSignalHandlers();
  process.kill(process.pid, signal);
}
const onSigint = () => handleSignal("SIGINT");
const onSigterm = () => handleSignal("SIGTERM");
function removeSignalHandlers(): void {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}

test.beforeAll(async () => {
  fake = await startFake();
  const root = writeBot();
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      MUNINN_BOTS_DIR: root,
      SUMMARIZER_BOT: BOT,
      KNOWLEDGE_API_URL: FAKE,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/live`)).ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.afterAll(() => {
  cleanup();
  removeSignalHandlers();
});

test("pasted HTML with two anchors: both hrefs reach the prompt and the stored Links section", async ({ page }) => {
  ingests = [];
  userPrompts = [];
  await page.goto(`${BASE}/summaries`);
  await page.locator("#pasteToggleBtn").click();
  const box = page.locator("#articleText");
  await box.focus();

  // A real paste event with both clipboard flavours, the way a browser fires one.
  await box.evaluate((el, html) => {
    const data = new DataTransfer();
    data.setData("text/html", html);
    data.setData("text/plain", "It cites the invented paper and builds on an invented harness.");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, PASTED_HTML);
  await expect(box).toHaveValue(
    "## An invented post\n\n" +
      `It cites [the invented paper](${PAPER}) and builds on [an invented harness](${HARNESS}), then states one finding.`,
  );

  await page.locator("#submitBtn").click();
  await expect.poll(() => ingests.length, { timeout: 30_000 }).toBe(1);

  // The model was handed the numbered list of the paste's links.
  expect(userPrompts.at(-1)).toContain(
    `## Links in the text\n\n1. the invented paper — ${PAPER}\n2. an invented harness — ${HARNESS}`,
  );
  // The stored body: the summary, then the section with BOTH hrefs, the
  // LINKS line nowhere.
  const summary = String(ingests[0]!.summary);
  expect(summary).toBe(
    "### What it says\n- One invented finding.\n\n## Links\n\n" +
      `- 📄 [the invented paper](${PAPER}) · from text\n` +
      `- 📄 [an invented harness](${HARNESS}) · from text`,
  );
  expect(summary).not.toContain("LINKS:");
});
