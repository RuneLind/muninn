/**
 * `/summaries` — the doc panel's 🔎 Find links, end to end through the real
 * options and save routes.
 *
 * What only this tier can see: the button appearing from the options route,
 * the candidate checklist, the per-candidate states and labels as the stream
 * lands, ✓ Accept writing the `found by search` line through the real save
 * path, the article reload that follows keeping the panel and its
 * `linksBaseHash` (so a second accept from the same panel saves too), and the
 * 409 an accept meets after an outside write.
 *
 * **What is faked and why.** huginn is an in-process `node:http` server whose
 * `/api/youtube/ingest` rewrites its in-memory file the way `write_summary`
 * does (frontmatter re-quoted, a blank line, the summary string), so the
 * reader, the raw read and the CAS all see the written file. The two
 * model-backed routes are stubbed at the network boundary with `page.route`
 * (the `summaries-factcheck.spec.ts` precedent): the candidates POST is one
 * Haiku-tier call, and the search POST runs a `{ web: true }` agent that only
 * a claude-cli/claude-sdk bot has — and its verification fetch refuses every
 * loopback address by design. The candidates stub answers the REAL
 * `linksBaseHash`, read from the real options route. The label rules, the run
 * bounds and the routes are unit-tested in `src/summaries/find-links.test.ts`
 * and `src/dashboard/routes/summaries-links.test.ts`. No model call is made.
 * The bot lives in a temp `MUNINN_BOTS_DIR`; ports come from `e2e/ports.ts`.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("summaries-find-links");
const FAKE_PORT = e2ePort("summaries-find-links/huginn");
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const BOT = "e2efindlinks";
const COLLECTION = "youtube-summaries";
const TODAY = new Date().toISOString().slice(0, 10);

// Invented documents (public repo: no live corpus).
const DOC_A = "ai/e2e/E2E links with section.md";
const DOC_B = "ai/e2e/E2E links bare.md";
const URL_A = "https://www.youtube.com/watch?v=e2eLinksAAA";
const URL_B = "https://www.youtube.com/watch?v=e2eLinksBBB";
const SUMMARY_A = "Lydia Hallie's article on Claude Code effort levels explains the dial.";
const SECTION_A = [
  "## Links",
  "",
  "- 📄 [Spending your effort](https://claude.example/blog/spending-your-effort) — Anthropic · from description",
  "",
  "_7 creator and social links in the description are not listed._",
].join("\n");
// Legacy UNQUOTED date; a section and a transcript.
const RAW_A = `---\ndate: 2026-03-22\nurl: "${URL_A}"\ncategory: "ai/e2e"\n---\n\n${SUMMARY_A}\n\n${SECTION_A}\n\n## Transcript\n\n### [00:00:00]\n\nInvented speech.\n`;
// No section, no transcript.
const RAW_B = `---\ndate: 2026-03-23\nurl: "${URL_B}"\ncategory: "ai/e2e"\n---\n\nA bare summary that names an invented benchmark report.\n`;

const MATCHED = {
  url: "https://claude.example/resources/articles/effort",
  title: "Claude Code effort level and model selection",
  detail: "Anthropic, Lydia Hallie",
  label: "matched",
};
const REACHABLE = { url: "https://docs.example/best-practices", title: "Claude Code best practices", detail: "", label: "reachable" };
const CANDIDATES = [
  { title: null, author: "Lydia Hallie", topic: "Lydia Hallie's article on Claude Code effort levels", kind: "post" },
  { title: null, author: null, topic: "an internal benchmark nobody published", kind: "doc" },
];

const files = new Map<string, string>();
const ingests: Record<string, unknown>[] = [];
let server: ChildProcess | undefined;
let fake: Server | undefined;
let botsRoot: string | undefined;

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
      const url = new URL(req.url ?? "/", "http://x");
      const p = decodeURIComponent(url.pathname);
      const json = (body: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (p === "/api/youtube/ingest") {
        const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
        ingests.push(body);
        const id = `${body.category}/${body.title}.md`;
        files.set(id, `---\ndate: ${JSON.stringify(body.date)}\nurl: ${JSON.stringify(body.url)}\ncategory: "${body.category}"\n---\n\n${String(body.summary)}`);
        return json({ file_path: id, similar: [] });
      }
      if (p === `/api/collection/${COLLECTION}/documents`) {
        return json({ documents: [...files.keys()].map((id) => ({ id, date: TODAY, modifiedTime: `${TODAY}T01:00:00.000000` })) });
      }
      if (p.startsWith("/api/collection/")) return json({ documents: [] });
      const m = /^\/api\/document\/([^/]+)\/(.+)$/.exec(p);
      if (m) {
        const file = m[1] === COLLECTION ? files.get(m[2]!) : undefined;
        if (!file) return json({ detail: "not found" }, 404);
        if (url.searchParams.get("raw") === "1") {
          res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
          return res.end(file);
        }
        const fmUrl = /^url: "([^"]+)"/m.exec(file)?.[1];
        return json({ id: m[2], url: fmUrl, text: file.replace(/^---\n[\s\S]*?\n---\n/, "") });
      }
      if (p === "/api/collections") return json({ collections: [{ name: COLLECTION }] });
      if (p === "/api/search") return json({ results: [] });
      return json({ status: "ok" });
    })();
  });
  await new Promise<void>((resolve) => srv.listen(FAKE_PORT, "127.0.0.1", resolve));
  return srv;
}

function writeBot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "muninn-e2e-findlinks-bots-"));
  const dir = path.join(root, BOT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "CLAUDE.md"), "# e2e Find links summarizer\n\nCreated by e2e/summaries-find-links.spec.ts.\n");
  // openai-compat at a dead port: nothing in this spec reaches a model.
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ connector: "openai-compat", model: "e2e-fake", baseUrl: `${FAKE}/v1` }, null, 2));
  botsRoot = root;
  return root;
}

function cleanup(): void {
  server?.kill("SIGTERM");
  fake?.close();
  if (botsRoot) rmSync(botsRoot, { recursive: true, force: true });
  botsRoot = undefined;
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
  files.set(DOC_A, RAW_A);
  files.set(DOC_B, RAW_B);
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
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
});

const sse = (events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

/** The two model-backed routes, stubbed; candidates carries the server's real hash. */
async function stubModelRoutes(page: Page, results: unknown[]): Promise<{ searches: unknown[] }> {
  const seen = { searches: [] as unknown[] };
  await page.route("**/api/summaries/links/candidates", async (route) => {
    const { source, docId } = JSON.parse(route.request().postData() ?? "{}") as { source: string; docId: string };
    const opts = (await (await fetch(`${BASE}/api/summaries/links/options?source=${source}&docId=${encodeURIComponent(docId)}`)).json()) as {
      linksBaseHash: string;
    };
    await route.fulfill({ json: { candidates: CANDIDATES, listed: 1, linksBaseHash: opts.linksBaseHash } });
  });
  await page.route("**/api/summaries/links/search", async (route) => {
    seen.searches.push(JSON.parse(route.request().postData() ?? "{}"));
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: sse([
        ["start", { total: 2 }],
        ["state", { type: "state", index: 0, state: "searching" }],
        ["state", { type: "state", index: 1, state: "searching" }],
        ["state", { type: "state", index: 0, state: "checking" }],
        ["result", { type: "result", index: 0, outcome: "found", results }],
        ["result", { type: "result", index: 1, outcome: "not_found", results: [] }],
        ["done", {}],
      ]),
    });
  });
  return seen;
}

async function openDoc(page: Page, docId: string, text: string): Promise<void> {
  await page.goto(`${BASE}/summaries?source=youtube&doc=${encodeURIComponent(docId)}`);
  await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
  await expect(page.locator("#sumArticleMain")).toContainText(text, { timeout: 15_000 });
}

async function findAndSearch(page: Page, firstLabel = "matched"): Promise<void> {
  const btn = page.locator("#docPanelFindLinks");
  await expect(btn).toBeVisible();
  await btn.click();
  const panel = page.locator("#sumLinks");
  await expect(panel.locator(".sum-links-row")).toHaveCount(2);
  await expect(panel.locator("[data-pick]:checked")).toHaveCount(2);
  await panel.getByRole("button", { name: "Search 2 selected" }).click();
  await expect(panel.locator('.sum-links-row[data-row="0"] .sum-links-label').first()).toHaveText(firstLabel);
  await expect(panel.locator('.sum-links-row[data-row="1"] .sum-links-state')).toHaveText("not found");
}

test("a matched result accepted from the panel lands as a found-by-search line; a second accept saves too", async ({ page }) => {
  const seen = await stubModelRoutes(page, [MATCHED, REACHABLE]);
  await openDoc(page, DOC_A, "Lydia Hallie");
  await findAndSearch(page);
  expect(seen.searches).toHaveLength(1);
  const panel = page.locator("#sumLinks");

  await panel.locator(`[data-accept="${MATCHED.url}"]`).click();
  await expect(panel.locator(".sum-links-msg")).toHaveText("Saved to the Links section.");
  const after1 = files.get(DOC_A)!;
  expect(after1).toContain(`- 🔎 [${MATCHED.title}](${MATCHED.url}) — Anthropic, Lydia Hallie · found by search\n\n_7 creator`);
  expect(after1).toContain('date: "2026-03-22"');
  // The reloaded article shows it, and the panel survived the reload.
  await expect(page.locator(`#sumArticleMain a[href="${MATCHED.url}"]`).first()).toBeVisible();
  await expect(panel.getByText("✓ Saved")).toBeVisible();

  await panel.locator(`[data-accept="${REACHABLE.url}"]`).click();
  await expect(panel.locator(".sum-links-saved")).toHaveCount(2);
  const after2 = files.get(DOC_A)!;
  expect(after2).toContain(`found by search\n- 🔎 [${REACHABLE.title}](${REACHABLE.url}) · found by search\n\n_7 creator`);
  expect(after2).toMatch(/not listed\._\n\n## Transcript\n\n### \[00:00:00\]/);
  expect(ingests).toHaveLength(2);
});

test("a document with no section and no transcript gets one, and a second accept saves", async ({ page }) => {
  await stubModelRoutes(page, [MATCHED, REACHABLE]);
  await openDoc(page, DOC_B, "invented benchmark");
  await findAndSearch(page);
  const panel = page.locator("#sumLinks");
  await panel.locator(`[data-accept="${MATCHED.url}"]`).click();
  await expect(panel.locator(".sum-links-msg")).toHaveText("Saved to the Links section.");
  await panel.locator(`[data-accept="${REACHABLE.url}"]`).click();
  await expect(panel.locator(".sum-links-saved")).toHaveCount(2);
  expect(files.get(DOC_B)!).toMatch(
    /invented benchmark report\.\n\n## Links\n\n- 🔎 \[Claude Code effort level and model selection\]\(https:\/\/claude\.example\/resources\/articles\/effort\) — Anthropic, Lydia Hallie · found by search\n- 🔎 \[Claude Code best practices\]/,
  );
  await expect(page.locator("#sumArticleMain").getByRole("heading", { name: "Links" })).toBeVisible();
});

test("an accept after an outside write answers 409 and writes nothing", async ({ page }) => {
  const NEW_URL = "https://papers.example/effort.pdf";
  await stubModelRoutes(page, [{ url: NEW_URL, title: "Effort paper", detail: "", label: "unread" }]);
  await openDoc(page, DOC_A, "Lydia Hallie");
  await findAndSearch(page, "reachable, not read");
  // A re-run lands in between: the body moves.
  files.set(DOC_A, files.get(DOC_A)!.replace("explains the dial.", "explains the dial, re-run."));
  const before = ingests.length;
  const panel = page.locator("#sumLinks");
  await panel.locator(`[data-accept="${NEW_URL}"]`).click();
  await expect(panel.locator(".sum-links-msg.error")).toContainText("The summary changed since Find links read it");
  expect(ingests.length).toBe(before);
  expect(files.get(DOC_A)!).not.toContain(NEW_URL);
});
