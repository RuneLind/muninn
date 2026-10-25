/**
 * `/summaries` — the doc panel's 🔎 Find links, end to end through the REAL
 * options, candidates, search (SSE) and save routes.
 *
 * What only this tier can see: the button appearing from the options route,
 * the section mounting above the article body, the candidate checklist, the
 * per-candidate states and labels as the stream lands, ✓ Accept writing the
 * `found by search` line through the real save path from the server-held
 * verified result, the article reload that follows keeping the panel (so a
 * second accept from the same panel saves too), the 409 an accept meets after
 * an outside write, and — the R2 case — that reloading the article after an
 * outside write does NOT re-baseline the panel, so a stale result still meets
 * the 409.
 *
 * **What is faked and why.** huginn is an in-process `node:http` server whose
 * `/api/youtube/ingest` rewrites its in-memory file the way `write_summary`
 * does (frontmatter re-quoted, a blank line, the summary string). muninn is
 * booted through `e2e/find-links-boot.ts`, which cans the two model calls and
 * the page fetch in-process (`findLinksTestSeam`): the candidates call answers
 * a fixed list, each web agent a fixed manifest, and `safeFetchPage` a map of
 * invented pages — muninn's own fetch refuses every loopback address by
 * design, so a fake page server cannot stand in for it. Everything after those
 * three seams is the production code. The bot is a `claude-sdk` bot in a temp
 * `MUNINN_BOTS_DIR` (the web-tools gate needs one); nothing reaches a model.
 * Ports come from `e2e/ports.ts`.
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
const SECTION = [
  "## Links",
  "",
  "- 📄 [Spending your effort](https://claude.example/blog/spending-your-effort) — Anthropic · from description",
  "",
  "_7 creator and social links in the description are not listed._",
].join("\n");
const SUMMARY = "Lydia Hallie's article on Claude Code effort levels explains the dial, and an internal benchmark report backs it.";
const withSection = (url: string) =>
  `---\ndate: 2026-03-22\nurl: "${url}"\ncategory: "ai/e2e"\n---\n\n${SUMMARY}\n\n${SECTION}\n\n## Transcript\n\n### [00:00:00]\n\nInvented speech.\n`;
const DOCS = {
  // Legacy UNQUOTED date; a section and a transcript.
  a: { id: "ai/e2e/E2E links with section.md", raw: withSection("https://www.youtube.com/watch?v=e2eLinksAAA") },
  // No section, no transcript.
  b: {
    id: "ai/e2e/E2E links bare.md",
    raw: `---\ndate: 2026-03-23\nurl: "https://www.youtube.com/watch?v=e2eLinksBBB"\ncategory: "ai/e2e"\n---\n\n${SUMMARY}\n`,
  },
  c: { id: "ai/e2e/E2E links outside write.md", raw: withSection("https://www.youtube.com/watch?v=e2eLinksCCC") },
  d: { id: "ai/e2e/E2E links reload.md", raw: withSection("https://www.youtube.com/watch?v=e2eLinksDDD") },
};

const MATCHED_URL = "https://claude.example/resources/articles/effort";
const PDF_URL = "https://papers.example/effort.pdf";
const C_HALLIE = { title: null, author: "Lydia Hallie", topic: "Lydia Hallie's article on Claude Code effort levels", kind: "post" };
const C_NONE = { title: null, author: null, topic: "an internal benchmark report", kind: "doc" };
const FIXTURE = {
  // The second is the section's own line: the server drops it as listed.
  candidates: [C_HALLIE, { title: "Spending your effort", author: null, topic: "the claude.dev post", kind: "post" }, C_NONE],
  agents: {
    [C_HALLIE.topic]: JSON.stringify({
      results: [
        { url: MATCHED_URL, title: "x", quote: "" },
        { url: PDF_URL, title: "The effort paper", quote: "" },
      ],
    }),
    [C_NONE.topic]: JSON.stringify({ results: [{ url: "https://invented.example/nothing", title: "x", quote: "nothing" }] }),
  },
  pages: {
    [MATCHED_URL]: {
      finalUrl: MATCHED_URL,
      contentType: "text/html",
      text: `<title>Claude Code effort level and model selection</title><meta property="og:site_name" content="Anthropic"><p>${"By Lydia Hallie, on picking an effort level. ".repeat(20)}</p>`,
    },
    [PDF_URL]: { finalUrl: PDF_URL, contentType: "application/pdf", text: null },
  },
};
const MATCHED_LINE = `- 🔎 [Claude Code effort level and model selection](${MATCHED_URL}) — Anthropic, Lydia Hallie · found by search`;
// D19 8: a PDF line takes the candidate's title, else its topic — never the manifest's «The effort paper».
const PDF_LINE = `- 🔎 [${C_HALLIE.topic}](${PDF_URL}) · found by search`;

const files = new Map<string, string>();
const ingests: Record<string, unknown>[] = [];
let server: ChildProcess | undefined;
let fake: Server | undefined;
let tmpRoot: string | undefined;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
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

function writeFixtures(): { botsRoot: string; fixture: string } {
  const root = mkdtempSync(path.join(tmpdir(), "muninn-e2e-findlinks-"));
  const dir = path.join(root, "bots", BOT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "CLAUDE.md"), "# e2e Find links summarizer\n\nCreated by e2e/summaries-find-links.spec.ts.\n");
  // claude-sdk: the web-tools gate needs one. The model calls are canned, so it is never spawned.
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
  for (const d of Object.values(DOCS)) files.set(d.id, d.raw);
  fake = await startFake();
  const { botsRoot, fixture } = writeFixtures();
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  server = spawn("bun", ["run", "e2e/find-links-boot.ts"], {
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
      FIND_LINKS_E2E_FIXTURE: fixture,
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

async function openDoc(page: Page, docId: string, text: string): Promise<void> {
  await page.goto(`${BASE}/summaries?source=youtube&doc=${encodeURIComponent(docId)}`);
  await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
  await expect(page.locator("#sumArticleMain")).toContainText(text, { timeout: 15_000 });
}

/** Click 🔎, check the two unlisted candidates are offered and selected, search, wait for both rows to land. */
async function findAndSearch(page: Page): Promise<void> {
  const btn = page.locator("#docPanelFindLinks");
  await expect(btn).toBeVisible();
  await btn.click();
  const panel = page.locator("#sumLinks");
  await expect(panel.locator(".sum-links-row")).toHaveCount(2);
  await expect(panel.locator(".sum-links-note").first()).toContainText("1 already in Links");
  await expect(panel.locator("[data-pick]:checked")).toHaveCount(2);
  await panel.getByRole("button", { name: "Search 2 selected" }).click();
  await expect(panel.locator('.sum-links-row[data-row="0"] .sum-links-label').first()).toHaveText("matched");
  await expect(panel.locator('.sum-links-row[data-row="0"] .sum-links-label').nth(1)).toHaveText("reachable, not read");
  await expect(panel.locator('.sum-links-row[data-row="1"] .sum-links-state')).toHaveText("not found");
}

test("the section mounts above the article; a matched result lands as a found-by-search line; a second accept saves too", async ({ page }) => {
  await openDoc(page, DOCS.a.id, "Lydia Hallie");
  await findAndSearch(page);
  // Panel order: Find links sits above the article body.
  expect(
    await page.evaluate(() => {
      const links = document.getElementById("sumLinks");
      const body = document.getElementById("sumArticleBody");
      return !!links && !!body && (links.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }),
  ).toBe(true);
  const panel = page.locator("#sumLinks");

  await panel.locator(`[data-accept="${MATCHED_URL}"]`).click();
  await expect(panel.locator(".sum-links-msg")).toHaveText("Saved to the Links section.");
  const after1 = files.get(DOCS.a.id)!;
  expect(after1).toContain(`from description\n${MATCHED_LINE}\n\n_7 creator`);
  expect(after1).toContain('date: "2026-03-22"');
  // The reloaded article shows it, and the panel survived the reload.
  await expect(page.locator(`#sumArticleMain a[href="${MATCHED_URL}"]`).first()).toBeVisible();
  await expect(panel.getByText("✓ Saved")).toBeVisible();

  await panel.locator(`[data-accept="${PDF_URL}"]`).click();
  await expect(panel.locator(".sum-links-saved")).toHaveCount(2);
  const after2 = files.get(DOCS.a.id)!;
  expect(after2).toContain(`${MATCHED_LINE}\n${PDF_LINE}\n\n_7 creator`);
  expect(after2).toMatch(/not listed\._\n\n## Transcript\n\n### \[00:00:00\]/);
});

test("a document with no section and no transcript gets one, and a second accept saves", async ({ page }) => {
  await openDoc(page, DOCS.b.id, "Lydia Hallie");
  await page.locator("#docPanelFindLinks").click();
  const panel = page.locator("#sumLinks");
  // No section: nothing is listed, so all three candidates are offered.
  await expect(panel.locator(".sum-links-row")).toHaveCount(3);
  await panel.getByRole("button", { name: "Search 3 selected" }).click();
  await expect(panel.locator('.sum-links-row[data-row="0"] .sum-links-label').first()).toHaveText("matched");
  await panel.locator(`[data-accept="${MATCHED_URL}"]`).click();
  await expect(panel.locator(".sum-links-msg")).toHaveText("Saved to the Links section.");
  await panel.locator(`[data-accept="${PDF_URL}"]`).click();
  await expect(panel.locator(".sum-links-saved")).toHaveCount(2);
  expect(files.get(DOCS.b.id)!).toBe(
    `---\ndate: "2026-03-23"\nurl: "https://www.youtube.com/watch?v=e2eLinksBBB"\ncategory: "ai/e2e"\n---\n\n${SUMMARY}\n\n## Links\n\n${MATCHED_LINE}\n${PDF_LINE}\n`,
  );
  await expect(page.locator("#sumArticleMain").getByRole("heading", { name: "Links" })).toBeVisible();
});

test("an accept after an outside write answers 409 and writes nothing", async ({ page }) => {
  await openDoc(page, DOCS.c.id, "Lydia Hallie");
  await findAndSearch(page);
  // A re-run lands in between: the body moves.
  files.set(DOCS.c.id, files.get(DOCS.c.id)!.replace("explains the dial", "explains the dial, re-run"));
  const before = ingests.length;
  const panel = page.locator("#sumLinks");
  await panel.locator(`[data-accept="${MATCHED_URL}"]`).click();
  await expect(panel.locator(".sum-links-msg.error")).toContainText("The summary changed since Find links read it");
  expect(ingests.length).toBe(before);
  expect(files.get(DOCS.c.id)!).not.toContain(MATCHED_URL);
});

test("R2: reloading the article after an outside write keeps the panel's baseline, so a stale result still meets the 409", async ({ page }) => {
  await openDoc(page, DOCS.d.id, "Lydia Hallie");
  await findAndSearch(page);
  files.set(DOCS.d.id, files.get(DOCS.d.id)!.replace("explains the dial", "explains the dial, fact-checked"));
  // The article reload the panel survives (what a save, or reopening the doc, does).
  await page.evaluate((id) => (globalThis as unknown as { openSummaryDoc: (a: string, b: string, c: string) => void }).openSummaryDoc(id, "", "youtube"), DOCS.d.id);
  await expect(page.locator("#sumArticleMain")).toContainText("fact-checked", { timeout: 15_000 });
  const panel = page.locator("#sumLinks");
  await expect(panel.locator(`[data-accept="${MATCHED_URL}"]`)).toBeVisible();
  const before = ingests.length;
  await panel.locator(`[data-accept="${MATCHED_URL}"]`).click();
  await expect(panel.locator(".sum-links-msg.error")).toContainText("The summary changed since Find links read it");
  expect(ingests.length).toBe(before);
});
