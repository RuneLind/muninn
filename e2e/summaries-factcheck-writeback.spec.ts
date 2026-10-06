/**
 * `/summaries` — the Fact check section's ➕ Add to summary and ✎ Integrate
 * corrections, end to end through the real routes.
 *
 * What only this tier can see: the written-back document as the READER renders
 * it — the sentinel comments gone (the page renderers escape raw HTML, so a
 * missed one shows as literal `<!--` text), the `[!factcheck]` callout styled,
 * readable in both themes, on the `/summaries` article view and on the search
 * document page — plus the integrate preview's checkboxes deciding what is
 * written, and the re-run menu's warning afterwards.
 *
 * **What is faked and why.** huginn is an in-process `node:http` server whose
 * `/api/youtube/ingest` rewrites its in-memory file the way huginn's
 * `write_summary` does (frontmatter, a blank line, the summary string), so the
 * reader, the raw read and the CAS all see the written file. The integrate
 * model call is the throwaway `openai-compat` bot pointed at the same server's
 * `/v1/chat/completions`, which streams a canned edit list. The saved check is
 * seeded straight into `summary_factchecks` under the hash the server computes.
 * The bot lives in a temp `MUNINN_BOTS_DIR`; ports come from `e2e/ports.ts`.
 *
 * ENV PREREQUISITE: `bun run db:setup:test` (migration 080's `applied_at`).
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { paintedContrast } from "./contrast.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("summaries-factcheck-writeback");
const FAKE_PORT = e2ePort("summaries-factcheck-writeback/huginn");
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const BOT = "e2ewriteback";
const COLLECTION = "youtube-summaries";
const TODAY = new Date().toISOString().slice(0, 10);
const DOC = "health/e2e/E2E writeback.md";
const VIDEO_URL = "https://www.youtube.com/watch?v=e2eWrtBack1";

const CLAIM_1 = "The video says adults need 4 hours of sleep a night.";
const CLAIM_2 = "Caffeine has a half-life of about five hours.";
const SUMMARY = `${CLAIM_1}\n\n## Key takeaways\n\n- ${CLAIM_2}`;
const FRONTMATTER = `---\ndate: "${TODAY}"\nurl: "${VIDEO_URL}"\ncategory: "health/e2e"\ntags: "health, e2e"\n---\n`;
const ORIGINAL = `${FRONTMATTER}\n${SUMMARY}\n\n## Transcript\n\n### [00:00:00]\n\nInvented speech about sleep.\n`;

const EDIT_1_NEW =
  "The video says adults need 4 hours of sleep a night; sources say adults need 7 or more hours ([cdc.gov](https://www.cdc.gov/sleep)).";
const EDIT_2_NEW = "The video says caffeine has a half-life of about five hours; sources say 3–7 hours ([nih.gov](https://www.nih.gov/c)).";

const ANSWER = [
  "Two claims checked.",
  "",
  "### ❌ Claim 1/2 — Adults need 4 hours of sleep",
  "",
  "Sources say 7 or more hours.",
  "",
  "Confidence: 30/100",
  "",
  "Sources: [cdc.gov](https://www.cdc.gov/sleep)",
  "",
  "### ⚠️ Claim 2/2 — Caffeine half-life is five hours",
  "",
  "Sources give a range of 3–7 hours.",
  "",
  "Confidence: 60/100",
  "",
  "Sources: [nih.gov](https://www.nih.gov/c)",
].join("\n");

/** The server's checked text, restated for this fixture (no images, links or
 *  visual reference): the body above `## Transcript`, frontmatter stripped,
 *  trimmed. A server that cut differently 409s every write below. */
const checkedSha256 = (raw: string) =>
  createHash("sha256")
    .update(raw.replace(/^---\n[\s\S]*?\n---\n/, "").split("\n## Transcript")[0]!.replace(/<!-- factcheck:start -->[\s\S]*?<!-- factcheck:end -->\n?\n?/, "").trim())
    .digest("hex");

let file = ORIGINAL;
const ingests: Record<string, unknown>[] = [];
let modelCalls = 0;
let server: ChildProcess | undefined;
let fake: Server | undefined;
let botsRoot: string | undefined;
let sql: ReturnType<typeof postgres> | null = null;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
  });
}

const DEFAULT_EDITS = [
  { claimIndex: 1, verdict: "❌", old: CLAIM_1, new: EDIT_1_NEW, reason: "attributed" },
  { claimIndex: 2, verdict: "⚠️", old: CLAIM_2, new: EDIT_2_NEW, reason: "attributed" },
];
/** What the fake model proposes; a test that needs another preview swaps it. */
let completionEdits: unknown[] = DEFAULT_EDITS;
/** Held before the ingest answers, so a test can act while Add or Apply runs. */
let ingestDelayMs = 0;
/** Held before the model answers, so a test can act while a propose runs. */
let completionDelayMs = 0;
/** What the fake `/api/search` answers. */
let searchResults: unknown[] = [];

function writeCompletion(res: ServerResponse): void {
  const content = JSON.stringify({ edits: completionEdits });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(`data: ${JSON.stringify({ model: "e2e-fake", choices: [{ index: 0, delta: { content } }] })}\n\n`);
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
      if (p === "/v1/chat/completions") {
        modelCalls += 1;
        await readBody(req);
        if (completionDelayMs) await new Promise((r) => setTimeout(r, completionDelayMs));
        return writeCompletion(res);
      }
      if (p === "/api/youtube/ingest") {
        const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
        ingests.push(body);
        if (ingestDelayMs) await new Promise((r) => setTimeout(r, ingestDelayMs));
        file = `---\ndate: "${body.date}"\nurl: "${body.url}"\ncategory: "${body.category}"\ntags: "health, e2e"\n---\n\n${String(body.summary)}`;
        return json({ file_path: `${body.category}/${body.title}.md`, similar: [] });
      }
      if (p === `/api/collection/${COLLECTION}/documents`) {
        return json({ documents: [{ id: DOC, date: TODAY, modifiedTime: `${TODAY}T01:00:00.000000` }] });
      }
      if (p.startsWith("/api/collection/")) return json({ documents: [] });
      const m = /^\/api\/document\/([^/]+)\/(.+)$/.exec(p);
      if (m) {
        if (m[1] !== COLLECTION || m[2] !== DOC) return json({ detail: "not found" }, 404);
        if (url.searchParams.get("raw") === "1") {
          res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
          return res.end(file);
        }
        return json({ id: DOC, url: VIDEO_URL, text: file.replace(/^---\n[\s\S]*?\n---\n/, "") });
      }
      if (p === "/api/collections") return json({ collections: [{ name: COLLECTION }] });
      if (p === "/api/search") return json({ results: searchResults });
      return json({ status: "ok" });
    })();
  });
  await new Promise<void>((resolve) => srv.listen(FAKE_PORT, "127.0.0.1", resolve));
  return srv;
}

function writeBot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "muninn-e2e-writeback-bots-"));
  const dir = path.join(root, BOT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "CLAUDE.md"), "# e2e write-back summarizer\n\nCreated by e2e/summaries-factcheck-writeback.spec.ts.\n");
  writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ connector: "openai-compat", model: "e2e-fake", baseUrl: `${FAKE}/v1` }, null, 2),
  );
  botsRoot = root;
  return root;
}

async function seedRow(): Promise<void> {
  await sql!`DELETE FROM summary_factchecks WHERE doc_id = ${DOC}`;
  const claims = [
    { index: 1, title: "Adults need 4 hours of sleep", verdict: "❌", outcome: "verified", sources: [] },
    { index: 2, title: "Caffeine half-life is five hours", verdict: "⚠️", outcome: "verified", sources: [] },
  ];
  await sql!`
    INSERT INTO summary_factchecks (collection, doc_id, url, body_sha256, answer, claims, bot_name, created_at)
    VALUES (${COLLECTION}, ${DOC}, ${VIDEO_URL}, ${checkedSha256(file)}, ${ANSWER},
            ${sql!.json(claims as never)}, ${BOT}, now() - interval '1 hour')`;
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
  sql = postgres(TEST_DB, { max: 2 });
  await seedRow();
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

test.afterAll(async () => {
  cleanup();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  try {
    if (sql) await sql`DELETE FROM summary_factchecks WHERE doc_id = ${DOC}`;
  } finally {
    await sql?.end();
  }
});

async function open(page: Page): Promise<void> {
  await page.goto(`${BASE}/summaries?source=youtube&doc=${encodeURIComponent(DOC)}`);
  await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
  await expect(page.locator("#sumArticleMain")).toContainText("adults need 4 hours", { timeout: 15_000 });
  await expect(page.locator("#sumFactcheck .sum-fc-chip").first()).toBeVisible();
}

async function row(): Promise<{ body_sha256: string; applied_at: Date | null }> {
  const rows = await sql!<{ body_sha256: string; applied_at: Date | null }[]>`
    SELECT body_sha256, applied_at FROM summary_factchecks WHERE doc_id = ${DOC}`;
  return rows[0]!;
}

test("➕ Add writes the block; the reader drops the sentinels and styles the callout", async ({ page }) => {
  const before = await row();
  await open(page);
  const fc = page.locator("#sumFactcheck");
  await fc.getByRole("button", { name: "➕ Add to summary" }).click();
  await expect(fc.locator(".sum-fc-wb-msg.ok")).toContainText("Added the Fact check section");

  const main = page.locator("#sumArticleMain");
  const callout = main.locator("blockquote.sum-fc-callout");
  await expect(callout).toBeVisible();
  await expect(callout.locator(".sum-fc-callout-title")).toHaveText("✓ Claims checked against the web");
  await expect(main.getByRole("heading", { name: /^Fact check \(\d{4}-\d{2}-\d{2}\)$/ })).toBeVisible();
  expect(await main.innerText()).not.toContain("<!--");
  expect(await main.innerText()).not.toContain("factcheck:start");
  expect(await main.innerText()).not.toContain("[!factcheck]");
  // The prose is untouched and the checked text's hash with it.
  await expect(main).toContainText(CLAIM_1);
  expect(file).toContain("<!-- factcheck:start -->");
  expect(file.indexOf("## Fact check")).toBeLessThan(file.indexOf("## Transcript"));
  const after = await row();
  expect(after.body_sha256).toBe(before.body_sha256);
  expect(after.applied_at).toBeNull();
  // The section stays fresh: the stale pill would mean the hash moved.
  await expect(fc.locator(".sum-fc-stale")).toHaveCount(0);
});

test("the callout reads at AA in both themes", async ({ page }) => {
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page);
    const callout = page.locator("#sumArticleMain blockquote.sum-fc-callout");
    await expect(callout).toBeVisible();
    for (const [name, loc] of [
      ["callout title", callout.locator(".sum-fc-callout-title")],
      ["callout text", callout.locator("p").nth(1)],
      ["Add button", page.locator("#sumFactcheck .sum-fc-wb-btn").first()],
    ] as const) {
      expect(await paintedContrast(loc), `${scheme} ${name}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("the search document page renders the block the same way", async ({ page }) => {
  await page.goto(`${BASE}/search/document/${COLLECTION}/${DOC.split("/").map(encodeURIComponent).join("/")}`);
  const content = page.locator("#docContent");
  await expect(content.locator("blockquote.sum-fc-callout")).toBeVisible({ timeout: 15_000 });
  expect(await content.innerText()).not.toContain("<!--");
  expect(await content.innerText()).not.toContain("[!factcheck]");
});

test("✎ Integrate previews per edit; only the checked one is written, attributed, with the block", async ({ page }) => {
  await open(page);
  const fc = page.locator("#sumFactcheck");
  await fc.getByRole("button", { name: "✎ Integrate corrections" }).click();
  await expect(fc.locator(".sum-fc-int-edit")).toHaveCount(2);
  expect(modelCalls).toBe(1);
  // Leave claim 2 un-integrated.
  await fc.locator('.sum-fc-int-cb[data-edit-idxs="1"]').uncheck();
  await fc.getByRole("button", { name: "Apply selected" }).click();
  await expect(fc.locator(".sum-fc-wb-msg.ok")).toContainText("Integrated 1 correction");

  const main = page.locator("#sumArticleMain");
  await expect(main).toContainText("sources say adults need 7 or more hours");
  await expect(main).toContainText(CLAIM_2);
  await expect(main.locator("blockquote.sum-fc-callout")).toHaveCount(1);
  expect(await main.innerText()).not.toContain("<!--");
  await expect(fc.locator("[data-wb-applied]")).toBeVisible();
  await expect(fc.getByRole("button", { name: "✎ Integrate corrections" })).toHaveCount(0);

  const r = await row();
  expect(r.applied_at).not.toBeNull();
  expect(r.body_sha256).toBe(checkedSha256(file));
  expect(file).toContain("## Transcript\n\n### [00:00:00]\n\nInvented speech about sleep.");

  // D13: the re-run menu says a re-run drops the corrections.
  await page.locator("#docPanelRerun").click();
  await expect(page.locator('#docPanelRerunMenu [data-rerun-warn="factcheck-applied"]')).toContainText("drops them");
});

test("a summary changed after the integrate shows the re-check notice, not an Integrate button", async ({ page }) => {
  file = file.replace("## Key takeaways", "## Key points");
  await open(page);
  const fc = page.locator("#sumFactcheck");
  await expect(fc.locator('[data-wb-notice="changed-since-apply"]')).toHaveText(
    "Summary changed since the integrate — re-check to re-apply.",
  );
  await expect(fc.getByRole("button", { name: "✎ Integrate corrections" })).toHaveCount(0);
  await expect(fc.getByRole("button", { name: "➕ Add to summary" })).toHaveCount(0);
});

// ── Fix round 1 ──────────────────────────────────────────────────────────────

async function reset(): Promise<void> {
  file = ORIGINAL;
  completionEdits = DEFAULT_EDITS;
  ingestDelayMs = 0;
  completionDelayMs = 0;
  await seedRow();
}

async function closePanel(page: Page): Promise<void> {
  await page.locator(".doc-panel-close").click();
  await expect(page.locator("#docOverlay")).not.toHaveClass(/visible/);
}

async function reopen(page: Page): Promise<void> {
  await page.evaluate(([id, src]) => (globalThis as unknown as { openSummaryDoc: (a: string, b: string, c: string) => void }).openSummaryDoc(id!, "", src!), [DOC, "youtube"]);
  await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
  await expect(page.locator("#sumFactcheck .sum-fc-chip").first()).toBeVisible();
}

test("after ➕ Add the section says it is added; the message clears on reopen", async ({ page }) => {
  await reset();
  await open(page);
  const fc = page.locator("#sumFactcheck");
  await fc.getByRole("button", { name: "➕ Add to summary" }).click();
  await expect(fc.locator(".sum-fc-wb-msg.ok")).toContainText("Added the Fact check section");
  await expect(fc.locator("[data-wb-added]")).toHaveText("Fact check section added");
  await expect(fc.getByRole("button", { name: "➕ Add to summary" })).toHaveCount(0);
  await closePanel(page);
  await reopen(page);
  await expect(fc.locator("[data-wb-added]")).toBeVisible();
  await expect(fc.locator(".sum-fc-wb-msg")).toHaveCount(0);
  // The re-run menu names the block a re-run would drop.
  await page.locator("#docPanelRerun").click();
  await expect(page.locator('#docPanelRerunMenu [data-rerun-warn="factcheck-block"]')).toContainText("Fact check section");
});

test("closing the panel while Apply runs keeps it closed", async ({ page }) => {
  await reset();
  await open(page);
  const fc = page.locator("#sumFactcheck");
  await fc.getByRole("button", { name: "✎ Integrate corrections" }).click();
  await expect(fc.locator(".sum-fc-int-edit")).toHaveCount(2);
  ingestDelayMs = 1500;
  const n = ingests.length;
  await fc.getByRole("button", { name: "Apply selected" }).click();
  await closePanel(page);
  await expect.poll(() => ingests.length).toBe(n + 1);
  await page.waitForTimeout(2500);
  await expect(page.locator("#docOverlay")).not.toHaveClass(/visible/);
});

test("after Apply, ✎ Integrate stays hidden until the saved row is re-read", async ({ page }) => {
  await reset();
  await open(page);
  const fc = page.locator("#sumFactcheck");
  await fc.getByRole("button", { name: "✎ Integrate corrections" }).click();
  await expect(fc.locator(".sum-fc-int-edit")).toHaveCount(2);
  // The re-read after the write is slow: that is the window under test.
  await page.route("**/api/summaries/factcheck/result**", async (route) => {
    await new Promise((r) => setTimeout(r, 3000));
    await route.continue().catch(() => {});
  });
  await fc.getByRole("button", { name: "Apply selected" }).click();
  await expect(fc.locator(".sum-fc-wb-msg.ok")).toContainText("Integrated", { timeout: 15_000 });
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    expect(await fc.getByRole("button", { name: "✎ Integrate corrections" }).count()).toBe(0);
    await page.waitForTimeout(100);
  }
  await page.unroute("**/api/summaries/factcheck/result**");
  await expect(fc.locator("[data-wb-applied]")).toBeVisible({ timeout: 15_000 });
  await expect(fc.getByRole("button", { name: "✎ Integrate corrections" })).toHaveCount(0);
});

test("a new web result drops the open preview", async ({ page }) => {
  await reset();
  await open(page);
  const fc = page.locator("#sumFactcheck");
  await fc.getByRole("button", { name: "✎ Integrate corrections" }).click();
  await expect(fc.locator(".sum-fc-int-edit")).toHaveCount(2);
  await sql!`UPDATE summary_factchecks SET created_at = now() WHERE doc_id = ${DOC}`;
  await closePanel(page);
  await reopen(page);
  await expect(fc.getByRole("button", { name: "✎ Integrate corrections" })).toBeVisible();
  await expect(fc.locator(".sum-fc-int-edit")).toHaveCount(0);
});

test("a propose that returns after a new web result is dropped", async ({ page }) => {
  await reset();
  await open(page);
  const fc = page.locator("#sumFactcheck");
  completionDelayMs = 3000;
  const calls = modelCalls;
  await fc.getByRole("button", { name: "✎ Integrate corrections" }).click();
  await expect.poll(() => modelCalls).toBe(calls + 1);
  // A re-check lands while the editor model is still answering.
  await sql!`UPDATE summary_factchecks SET created_at = now() WHERE doc_id = ${DOC}`;
  await closePanel(page);
  await reopen(page);
  // The new result is on screen while the propose is still out…
  await expect(fc.locator(".sum-fc-meta")).toContainText("just now");
  await expect(fc.getByRole("button", { name: "Proposing…" })).toBeVisible();
  // …and when the propose lands it is dropped, not shown for the new result.
  await expect(fc.getByRole("button", { name: "Proposing…" })).toHaveCount(0, { timeout: 15_000 });
  expect(await fc.locator(".sum-fc-int-edit").count()).toBe(0);
  await expect(fc.getByRole("button", { name: "✎ Integrate corrections" })).toBeVisible();
  completionDelayMs = 0;
});

test("the integrate preview reads at AA in both themes", async ({ page }) => {
  await reset();
  // A multi-line edit (diff context lines, a trailing context line) and one that
  // cannot anchor (the "not applied" list).
  completionEdits = [
    {
      claimIndex: 1,
      verdict: "❌",
      old: `${CLAIM_1}\n\n## Key takeaways`,
      new: `${EDIT_1_NEW}\n\n## Key takeaways`,
      reason: "attributed",
    },
    { claimIndex: 2, verdict: "⚠️", old: "Not in the summary at all.", new: EDIT_2_NEW, reason: "attributed" },
  ];
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page);
    const fc = page.locator("#sumFactcheck");
    await fc.getByRole("button", { name: "✎ Integrate corrections" }).click();
    await expect(fc.locator(".sum-fc-int-edit")).toHaveCount(1);
    for (const [name, loc] of [
      ["Apply button", fc.getByRole("button", { name: "Apply selected" })],
      ["context line", fc.locator(".sum-fc-int-ctx").first()],
      ["diff context", fc.locator(".d-ctx").last()],
      ["not-applied list", fc.locator(".sum-fc-int-dropped summary")],
    ] as const) {
      await expect(loc).toBeVisible();
      expect(await paintedContrast(loc), `${scheme} ${name}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("a re-run after the corrections are gone says re-check, not 'integrated'", async ({ page }) => {
  await reset();
  await open(page);
  const fc = page.locator("#sumFactcheck");
  await fc.getByRole("button", { name: "✎ Integrate corrections" }).click();
  await fc.getByRole("button", { name: "Apply selected" }).click();
  await expect(fc.locator("[data-wb-applied]")).toBeVisible({ timeout: 15_000 });
  // A re-run regenerated the summary: the integrated text is gone.
  file = ORIGINAL;
  await closePanel(page);
  await reopen(page);
  await page.locator("#docPanelRerun").click();
  const menu = page.locator("#docPanelRerunMenu");
  await expect(menu.locator('[data-rerun-warn="factcheck-stale"]')).toContainText("re-check to re-apply");
  await expect(menu.locator('[data-rerun-warn="factcheck-applied"]')).toHaveCount(0);
});

test("/search chunk previews show no sentinel text or callout marker", async ({ page }) => {
  searchResults = [
    {
      id: DOC,
      title: "E2E writeback",
      collection: COLLECTION,
      relevance: 0.9,
      matchedChunks: [
        {
          heading: "Fact check (2026-10-06)",
          relevance: 0.9,
          content:
            "[youtube > health > E2E writeback]\n## Fact check (2026-10-06)\n\n> [!factcheck] Claims checked against the web\n>\n> **❌ Claim 1/2 — sleep**\n<!-- factcheck:end -->",
        },
        { heading: "Summary", relevance: 0.8, content: "Lede about sleep.\n<!-- factcheck:start -->" },
      ],
    },
  ];
  await page.goto(`${BASE}/search`);
  await page.locator("#searchInput").fill("sleep claims");
  await page.locator("#searchBtn").click();
  const results = page.locator("#results");
  await expect(results.locator(".result-card")).toHaveCount(1);
  await results.locator(".result-chunks-toggle").click();
  const text = await results.innerText();
  expect(text).not.toContain("<!--");
  expect(text).not.toContain("factcheck:");
  expect(text).not.toContain("[!factcheck]");
  expect(text).toContain("✓ Claims checked against the web");
  searchResults = [];
});

// ── Fix round 2 ──────────────────────────────────────────────────────────────

const sse = (events: Array<[string, unknown]>) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

/** ↻ Re-check, stubbed at the network boundary (a real check needs web tools):
 *  the row the route would save is written first, then the stream's frames. */
async function stubRecheck(page: Page): Promise<void> {
  await page.route("**/api/summaries/factcheck?*", async (route) => {
    const [r] = await sql!<{ created_at: Date }[]>`
      UPDATE summary_factchecks SET created_at = now() WHERE doc_id = ${DOC} RETURNING created_at`;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: sse([
        ["claims", { type: "claims", claims: [{ index: 1, title: "Adults need 4 hours of sleep" }, { index: 2, title: "Caffeine half-life is five hours" }] }],
        ["claim_result", { type: "claim_result", index: 1, verdict: "❌", outcome: "verified", markdown: "" }],
        ["claim_result", { type: "claim_result", index: 2, verdict: "⚠️", outcome: "verified", markdown: "" }],
        ["done", { type: "done", answer: ANSWER, saved: true, checkedAt: r!.created_at.getTime(), claimCount: 2 }],
        ["end", {}],
      ]),
    });
  });
}

test("a re-check that lands during Apply: the write still reports its outcome and the article reloads", async ({ page }) => {
  await reset();
  await open(page);
  const fc = page.locator("#sumFactcheck");
  await fc.getByRole("button", { name: "✎ Integrate corrections" }).click();
  await expect(fc.locator(".sum-fc-int-edit")).toHaveCount(2);
  await stubRecheck(page);
  ingestDelayMs = 2500;
  const n = ingests.length;
  await fc.getByRole("button", { name: "Apply selected" }).click();
  await expect.poll(() => ingests.length).toBe(n + 1);
  await fc.locator(".sum-fc-recheck").click();
  await expect(fc.locator(".sum-fc-meta")).toHaveText("checked just now");
  await expect(fc.locator(".sum-fc-wb-msg.error")).toContainText("re-checked during apply", { timeout: 15_000 });
  await expect(page.locator("#sumArticleMain")).toContainText("sources say adults need 7 or more hours");
  expect((await row()).applied_at).toBeNull();
  await page.unroute("**/api/summaries/factcheck?*");
});

test("a re-check that lands during ➕ Add: the write still reports and the article shows the block", async ({ page }) => {
  await reset();
  await open(page);
  const fc = page.locator("#sumFactcheck");
  await stubRecheck(page);
  ingestDelayMs = 2500;
  const n = ingests.length;
  await fc.getByRole("button", { name: "➕ Add to summary" }).click();
  await expect.poll(() => ingests.length).toBe(n + 1);
  await fc.locator(".sum-fc-recheck").click();
  await expect(fc.locator(".sum-fc-meta")).toHaveText("checked just now");
  await expect(fc.locator(".sum-fc-wb-msg.ok")).toContainText("Added the Fact check section", { timeout: 15_000 });
  await expect(page.locator("#sumArticleMain blockquote.sum-fc-callout")).toBeVisible();
  await page.unroute("**/api/summaries/factcheck?*");
});

test("a new web result clears a message about the old one", async ({ page }) => {
  await reset();
  await open(page);
  const fc = page.locator("#sumFactcheck");
  await fc.getByRole("button", { name: "✎ Integrate corrections" }).click();
  await expect(fc.locator(".sum-fc-int-edit")).toHaveCount(2);
  for (const cb of await fc.locator(".sum-fc-int-cb").all()) await cb.uncheck();
  await fc.getByRole("button", { name: "Apply selected" }).click();
  await expect(fc.locator(".sum-fc-wb-msg.error")).toContainText("Select at least one edit");
  await stubRecheck(page);
  await fc.locator(".sum-fc-recheck").click();
  await expect(fc.locator(".sum-fc-meta")).toHaveText("checked just now");
  await expect(fc.getByRole("button", { name: "✎ Integrate corrections" })).toBeVisible();
  await expect(fc.locator(".sum-fc-wb-msg")).toHaveCount(0);
  await expect(fc.locator(".sum-fc-int-edit")).toHaveCount(0);
  await page.unroute("**/api/summaries/factcheck?*");
});

test("a claim split into two edits is one checkbox, and Apply writes both halves", async ({ page }) => {
  await reset();
  completionEdits = [
    { claimIndex: 1, verdict: "❌", old: "The video says adults need 4 hours", new: "The video says adults need only 4 hours", reason: "first half" },
    { claimIndex: 1, verdict: "❌", old: "of sleep a night.", new: "of sleep a night; sources say adults need 7 or more hours ([cdc.gov](https://www.cdc.gov/sleep)).", reason: "second half" },
    DEFAULT_EDITS[1]!,
  ];
  await open(page);
  const fc = page.locator("#sumFactcheck");
  await fc.getByRole("button", { name: "✎ Integrate corrections" }).click();
  await expect(fc.locator(".sum-fc-int-edit")).toHaveCount(2);
  await expect(fc.locator(".sum-fc-int-cb")).toHaveCount(2);
  await expect(fc.locator(".sum-fc-int-diff")).toHaveCount(3);
  await fc.locator('.sum-fc-int-cb[data-edit-idxs="2"]').uncheck();
  await fc.getByRole("button", { name: "Apply selected" }).click();
  await expect(fc.locator(".sum-fc-wb-msg.ok")).toContainText("Integrated 2 correction");
  expect(file).toContain("The video says adults need only 4 hours of sleep a night; sources say adults need 7 or more hours");
  expect(file).toContain(CLAIM_2);
});

test("unchecking a split claim leaves both its halves out", async ({ page }) => {
  await reset();
  completionEdits = [
    { claimIndex: 1, verdict: "❌", old: "The video says adults need 4 hours", new: "The video says adults need only 4 hours", reason: "first half" },
    { claimIndex: 1, verdict: "❌", old: "of sleep a night.", new: "of sleep a night; sources say adults need 7 or more hours ([cdc.gov](https://www.cdc.gov/sleep)).", reason: "second half" },
    DEFAULT_EDITS[1]!,
  ];
  await open(page);
  const fc = page.locator("#sumFactcheck");
  await fc.getByRole("button", { name: "✎ Integrate corrections" }).click();
  await fc.locator('.sum-fc-int-cb[data-edit-idxs="0,1"]').uncheck();
  await fc.getByRole("button", { name: "Apply selected" }).click();
  await expect(fc.locator(".sum-fc-wb-msg.ok")).toContainText("Integrated 1 correction");
  expect(file).toContain(CLAIM_1);
  expect(file).toContain(EDIT_2_NEW);
});
