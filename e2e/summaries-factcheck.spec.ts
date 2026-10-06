/**
 * `/summaries` — the doc panel's ✓ Fact check section and the Latest rail badge.
 *
 * What only this tier can see: the saved result rendered in the real panel
 * (verdict chips, confidence chips, clickable sources), the "stale" pill, which
 * needs the server's own body hash to AGREE with the hash a row was saved under,
 * the rail badge, and the button's two outcomes in a browser.
 *
 * **What is stubbed and why.** A real check needs a web-tools connector
 * (claude-cli / claude-sdk) and live model calls, so the successful run is the
 * SSE route stubbed at the network boundary with `page.route` — the
 * `wiki-claim-retry.spec.ts` precedent — and the row it would have saved is
 * written from the stub, the way the route's `onDone` writes it. The real route
 * is still driven once: the throwaway bot is `openai-compat`, so the click
 * reaches the real preflight and its 503. Persist-on-done and the body cut are
 * unit-tested in `summaries-factcheck-routes.test.ts`.
 *
 * The transcript check's POST is stubbed the same way (a real one is a model
 * call through the Haiku router); its row is written from the stub and the
 * reload proves the SERVER-rendered join. Its route is unit- and DB-tested in
 * `summaries-factcheck-transcript.test.ts` / `summaries-transcript-check-db.test.ts`.
 *
 * Rows are seeded straight into `summary_factchecks`; the fake huginn is an
 * in-process `node:http` server; the bot lives in a temp `MUNINN_BOTS_DIR`.
 * Ports come from `e2e/ports.ts`.
 *
 * ENV PREREQUISITE: `bun run db:setup:test`.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { paintedContrast } from "./contrast.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";
import { createHash } from "node:crypto";
import { splitTranscript } from "../src/summaries/transcript-split.ts";

/** `factcheckBodySha256`, restated: that module's import graph reaches `bun`,
 *  which Playwright's Node cannot load. Restated for these fixtures only (no
 *  `## Visual reference`); a server that cut differently shows a stale pill on
 *  the fresh document and fails the first test. */
const factcheckBodySha256 = (text: string) =>
  createHash("sha256").update(splitTranscript(text).body.trim()).digest("hex");

const PORT = e2ePort("summaries-factcheck");
const FAKE_PORT = e2ePort("summaries-factcheck/huginn");
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const BOT = "e2efactcheck";
const COLLECTION = "youtube-summaries";
const TODAY = new Date().toISOString().slice(0, 10);

const DOC_FRESH = "health/e2e/E2E factcheck fresh.md";
const DOC_STALE = "health/e2e/E2E factcheck stale.md";
const DOC_PLAIN = "health/e2e/E2E factcheck unchecked.md";
/** Fresh web check, no transcript appendix: no transcript button for that reason alone. */
const DOC_NOTX = "health/e2e/E2E factcheck fresh no transcript.md";
/** Has a transcript, but its web check is stale: no transcript button for that reason alone. */
const DOC_STALE_TX = "health/e2e/E2E factcheck stale with transcript.md";

const frontmatter = (id: string) =>
  `---\ndate: "${TODAY}"\nurl: "https://www.youtube.com/watch?v=${encodeURIComponent(id).slice(-11)}"\ncategory: "health/e2e"\n---\n`;
const SOURCE_FILES: Record<string, string> = {
  [DOC_FRESH]: `${frontmatter(DOC_FRESH)}\nInvented sleep advice for a fixture.\n\n## Transcript\n\n### [00:00:00]\n\nInvented speech.\n`,
  [DOC_STALE]: `${frontmatter(DOC_STALE)}\nInvented caffeine claim, rewritten since its check.\n`,
  [DOC_PLAIN]: `${frontmatter(DOC_PLAIN)}\nAn invented summary nobody has checked.\n`,
  [DOC_NOTX]: `${frontmatter(DOC_NOTX)}\nInvented summary with no transcript.\n`,
  [DOC_STALE_TX]: `${frontmatter(DOC_STALE_TX)}\nInvented summary, rewritten since its check.\n\n## Transcript\n\n### [00:00:00]\n\nInvented speech.\n`,
};

/** The body the server reads: the raw file with its frontmatter stripped. */
const sourceText = (id: string) => SOURCE_FILES[id]!.replace(/^---\n[\s\S]*?\n---\n/, "");

const answer = (verdicts: string[]) =>
  [
    "Invented lede.",
    ...verdicts.map(
      (v, i) =>
        `### ${v} Claim ${i + 1}/${verdicts.length} — invented claim ${i + 1}\n\nInvented reasoning.\n\nConfidence: ${v === "❌" ? 30 : 88}/100\n\nSources: [example.org](https://example.org/source-${i + 1})`,
    ),
  ].join("\n\n");
const claims = (verdicts: string[]) =>
  verdicts.map((v, i) => ({ index: i + 1, title: `invented claim ${i + 1}`, verdict: v, outcome: "verified", sources: [] }));

let server: ChildProcess | undefined;
let fake: Server | undefined;
let botsRoot: string | undefined;
let sql: ReturnType<typeof postgres> | null = null;

async function seed(docId: string, verdicts: string[], bodySha256: string): Promise<void> {
  await sql!`
    INSERT INTO summary_factchecks (collection, doc_id, url, body_sha256, answer, claims, bot_name, created_at)
    VALUES (${COLLECTION}, ${docId}, ${null}, ${bodySha256}, ${answer(verdicts)},
            ${sql!.json(claims(verdicts) as never)}, ${BOT}, now() - interval '2 hours')
    ON CONFLICT (collection, doc_id) DO UPDATE SET body_sha256 = EXCLUDED.body_sha256,
      answer = EXCLUDED.answer, claims = EXCLUDED.claims, created_at = EXCLUDED.created_at`;
}

async function startFake(): Promise<Server> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = decodeURIComponent(url.pathname);
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (p === `/api/collection/${COLLECTION}/documents`) {
      return json({
        documents: Object.keys(SOURCE_FILES).map((id, i) => ({
          id,
          date: TODAY,
          modifiedTime: `${TODAY}T0${i + 1}:00:00.000000`,
        })),
      });
    }
    if (p.startsWith("/api/collection/")) return json({ documents: [] });
    const m = /^\/api\/document\/([^/]+)\/(.+)$/.exec(p);
    if (m) {
      const raw = m[1] === COLLECTION ? SOURCE_FILES[m[2]!] : undefined;
      if (raw === undefined) return json({ detail: "not found" }, 404);
      if (url.searchParams.get("raw") === "1") {
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
        return res.end(raw);
      }
      return json({ id: m[2], text: sourceText(m[2]!) });
    }
    if (p === "/api/collections") return json({ collections: [{ name: COLLECTION }] });
    if (p === "/api/search") return json({ results: [] });
    return json({ status: "ok" });
  });
  await new Promise<void>((resolve) => srv.listen(FAKE_PORT, "127.0.0.1", resolve));
  return srv;
}

function writeBot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "muninn-e2e-factcheck-bots-"));
  const dir = path.join(root, BOT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "CLAUDE.md"), "# e2e fact-check summarizer\n\nCreated by e2e/summaries-factcheck.spec.ts.\n");
  // openai-compat has no web tools: the real route's preflight refuses it.
  writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ connector: "openai-compat", model: "e2e-fake", baseUrl: `${FAKE}/v1` }, null, 2),
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
// Re-raising signal handlers, registered in beforeAll — the summaries-rerun shape.
function handleSignal(signal: NodeJS.Signals): void {
  cleanup();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  process.kill(process.pid, signal);
}
const onSigint = () => handleSignal("SIGINT");
const onSigterm = () => handleSignal("SIGTERM");

test.beforeAll(async () => {
  sql = postgres(TEST_DB, { max: 2, onnotice: () => {} });
  // Migration 081 (idempotent), so a test database built before it still runs this file.
  await sql.unsafe(readFileSync(path.join(REPO_ROOT, "db/migrations/081-summary-factchecks-transcript.sql"), "utf8"));
  await sql`DELETE FROM summary_factchecks WHERE doc_id LIKE 'health/e2e/E2E factcheck%'`;
  await seed(DOC_FRESH, ["✅", "✅"], factcheckBodySha256(sourceText(DOC_FRESH)));
  await seed(DOC_STALE, ["✅", "❌"], "0".repeat(64));
  await seed(DOC_NOTX, ["❌", "✅"], factcheckBodySha256(sourceText(DOC_NOTX)));
  await seed(DOC_STALE_TX, ["❌", "✅"], "0".repeat(64));

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
    if (sql) await sql`DELETE FROM summary_factchecks WHERE doc_id LIKE 'health/e2e/E2E factcheck%'`;
  } finally {
    await sql?.end();
  }
});

async function open(page: Page, docId: string): Promise<void> {
  await page.goto(`${BASE}/summaries?source=youtube&doc=${encodeURIComponent(docId)}`);
  await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
  await expect(page.locator("#sumArticleMain")).toContainText(/invented/i, { timeout: 15_000 });
}
const railRow = (page: Page, docId: string) => page.locator(`#sumRailList .sum-latest-row[data-doc-id="${docId}"]`);

test("a saved check renders with chips, confidence bands and clickable sources; the rail carries badges", async ({ page }) => {
  await open(page, DOC_FRESH);
  const fc = page.locator("#sumFactcheck");
  await expect(fc).toBeVisible();
  await expect(fc.locator(".sum-fc-chip")).toHaveText(["✅ 2"]);
  await expect(fc.locator(".sum-fc-meta")).toHaveText("checked 2h ago");
  // The server's own hash of the summary equals the one the row was saved
  // under, so no stale pill.
  await expect(fc.locator(".sum-fc-stale")).toHaveCount(0);
  await expect(fc.locator(".wiki-fc-conf-chip.hi")).toHaveCount(2);
  const src = fc.locator('a[href="https://example.org/source-1"]');
  await expect(src).toHaveAttribute("target", "_blank");
  // Chrome, not article: the head opts out of selection, the answer text and
  // its source links stay selectable.
  expect(await fc.locator(".sum-fc-head").evaluate((el) => getComputedStyle(el).userSelect)).toBe("none");
  expect(await fc.locator(".sum-fc-answer").evaluate((el) => getComputedStyle(el).userSelect)).not.toBe("none");
  expect(await src.evaluate((el) => getComputedStyle(el).userSelect)).not.toBe("none");
  expect(await fc.evaluate((el) => el.nextElementSibling?.id)).toBe("sumArticleBody");

  await expect(railRow(page, DOC_FRESH).locator(".sum-fc-badge")).toHaveText("✓");
  await expect(railRow(page, DOC_STALE).locator(".sum-fc-badge")).toHaveText("❌1");
  await expect(railRow(page, DOC_PLAIN).locator(".sum-fc-badge")).toHaveCount(0);
});

test("a summary that changed since its check shows the stale pill", async ({ page }) => {
  await open(page, DOC_STALE);
  const fc = page.locator("#sumFactcheck");
  await expect(fc.locator(".sum-fc-stale")).toHaveText("stale");
  await expect(fc.locator(".sum-fc-chip")).toHaveText(["✅ 1", "❌ 1"]);
  await expect(fc.locator(".wiki-fc-conf-chip.lo")).toHaveCount(1);
});

test("the real route refuses a summarizer bot without web tools, and the panel says why", async ({ page }) => {
  await open(page, DOC_PLAIN);
  await expect(page.locator("#sumFactcheck")).toBeHidden();
  const btn = page.locator("#docPanelFactcheck");
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(page.locator("#sumFactcheck .sum-fc-err")).toContainText(`(${BOT}) can't run web fact-checks`);
  await expect(btn).toBeEnabled();
});

test("a check streams progress, renders its verdicts, and the saved row survives a reload", async ({ page }) => {
  await open(page, DOC_PLAIN);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route("**/api/summaries/factcheck?*", async (route) => {
    const frames = (events: Array<[string, unknown]>) =>
      events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
    // The row the real route's onDone would have written.
    await seed(DOC_PLAIN, ["✅", "❌"], factcheckBodySha256(sourceText(DOC_PLAIN)));
    await held;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: frames([
        ["claims", { type: "claims", claims: [{ index: 1, title: "invented claim 1" }, { index: 2, title: "invented claim 2" }] }],
        ["claim_result", { type: "claim_result", index: 1, verdict: "✅", outcome: "verified", markdown: "" }],
        ["claim_result", { type: "claim_result", index: 2, verdict: "❌", outcome: "verified", markdown: "" }],
        ["done", { type: "done", answer: answer(["✅", "❌"]), saved: true, checkedAt: Date.now(), claimCount: 2 }],
        ["answer_html", { html: '<h4>❌ Claim 2/2 — invented claim 2</h4>\n<span class="wiki-fc-conf-line"><span class="wiki-fc-conf-key">Confidence</span><span class="wiki-fc-conf-chip lo">30/100</span></span>', cited: [] }],
        ["end", {}],
      ]),
    });
  });
  const btn = page.locator("#docPanelFactcheck");
  await btn.click();
  // While the run is open: the progress view, and the button cannot start a second run.
  await expect(page.locator("#sumFactcheck")).toContainText("checking against the web");
  await expect(btn).toBeDisabled();
  release();

  const fc = page.locator("#sumFactcheck");
  await expect(fc.locator(".sum-fc-chip")).toHaveText(["✅ 1", "❌ 1"]);
  await expect(fc.locator(".sum-fc-meta")).toHaveText("checked just now");
  await expect(fc.locator(".sum-fc-err")).toHaveCount(0);
  await expect(fc.locator(".sum-fc-answer .wiki-fc-conf-chip.lo")).toHaveText("30/100");
  await expect(railRow(page, DOC_PLAIN).locator(".sum-fc-badge")).toHaveText("❌1");

  await page.unroute("**/api/summaries/factcheck?*");
  await open(page, DOC_PLAIN);
  await expect(page.locator("#sumFactcheck .sum-fc-chip")).toHaveText(["✅ 1", "❌ 1"]);
  await expect(page.locator("#sumFactcheck .sum-fc-stale")).toHaveCount(0);
});

const sse = (events: Array<[string, unknown]>) =>
  events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");

test("a partial re-check keeps the earlier result and says so; a newer saved result clears the notice", async ({ page }) => {
  await open(page, DOC_FRESH);
  await expect(page.locator("#sumFactcheck .sum-fc-chip")).toHaveText(["✅ 2"]);
  await page.route("**/api/summaries/factcheck?*", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: sse([
        ["claims", { type: "claims", claims: [{ index: 1, title: "invented claim 1" }, { index: 2, title: "invented claim 2" }] }],
        ["claim_result", { type: "claim_result", index: 1, verdict: "✅", outcome: "verified", markdown: "" }],
        ["claim_result", { type: "claim_result", index: 2, verdict: "❓", outcome: "error", markdown: "" }],
        ["done", { type: "done", answer: answer(["✅", "❓"]), saved: false, reason: "partial", claimCount: 1 }],
        ["end", {}],
      ]),
    }),
  );
  await page.locator("#sumFactcheck .sum-fc-recheck").click();
  const fc = page.locator("#sumFactcheck");
  await expect(fc.locator(".sum-fc-err")).toHaveText("Partial run, earlier result kept.");
  await expect(fc.locator(".sum-fc-chip")).toHaveText(["✅ 2"]);
  await page.unroute("**/api/summaries/factcheck?*");

  // A new run starts with no notice of its own, and a clean finish leaves none.
  let releaseRun: () => void = () => {};
  const runHeld = new Promise<void>((r) => { releaseRun = r; });
  await page.route("**/api/summaries/factcheck?*", async (route) => {
    await runHeld;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: sse([
        ["claims", { type: "claims", claims: [{ index: 1, title: "invented claim 1" }] }],
        ["claim_result", { type: "claim_result", index: 1, verdict: "✅", outcome: "verified", markdown: "" }],
        ["done", { type: "done", answer: answer(["✅"]), saved: true, checkedAt: Date.now() - 3_600_000, claimCount: 1 }],
        ["end", {}],
      ]),
    });
  });
  await fc.locator(".sum-fc-recheck").click();
  await expect(fc).toContainText("checking against the web");
  await expect(fc.locator(".sum-fc-err")).toHaveCount(0);
  releaseRun();
  await expect(fc.locator(".sum-fc-chip")).toHaveText(["✅ 1"]);
  await expect(fc.locator(".sum-fc-err")).toHaveCount(0);
  await page.unroute("**/api/summaries/factcheck?*");

  // A newer saved result (another tab, the next real run) replaces the notice.
  await sql!`UPDATE summary_factchecks SET created_at = now() WHERE doc_id = ${DOC_FRESH}`;
  await railRow(page, DOC_STALE).click();
  await expect(page.locator("#sumFactcheck .sum-fc-stale")).toHaveText("stale");
  await railRow(page, DOC_FRESH).click();
  await expect(fc.locator(".sum-fc-meta")).toHaveText("checked just now");
  await expect(fc.locator(".sum-fc-err")).toHaveCount(0);
  await seed(DOC_FRESH, ["✅", "✅"], factcheckBodySha256(sourceText(DOC_FRESH)));
});

test("the button stays disabled for a running document while its article is still loading", async ({ page }) => {
  await open(page, DOC_PLAIN);
  let releaseRun: () => void = () => {};
  const runHeld = new Promise<void>((r) => { releaseRun = r; });
  await page.route("**/api/summaries/factcheck?*", async (route) => {
    await runHeld;
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse([["app_error", { message: "stub ended" }], ["end", {}]]) });
  });
  const btn = page.locator("#docPanelFactcheck");
  await btn.click();
  await expect(btn).toBeDisabled();

  await railRow(page, DOC_STALE).click();
  await expect(page.locator("#sumFactcheck .sum-fc-stale")).toHaveText("stale");
  await expect(btn).toBeEnabled();

  let releaseDoc: () => void = () => {};
  const docHeld = new Promise<void>((r) => { releaseDoc = r; });
  await page.route((u) => u.pathname.includes("/document/") && u.pathname.includes("unchecked"), async (route) => {
    await docHeld;
    await route.continue();
  });
  await railRow(page, DOC_PLAIN).click();
  await expect(page.locator("#sumArticleMain")).toContainText("Loading");
  await expect(btn).toBeDisabled();
  releaseDoc();
  releaseRun();
  await expect(btn).toBeEnabled();
});

test("the section's text clears AA in both themes", async ({ page }) => {
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, DOC_STALE);
    const fc = page.locator("#sumFactcheck");
    for (const [name, loc] of [
      ["title", fc.locator(".sum-fc-title")],
      ["meta", fc.locator(".sum-fc-meta")],
      ["stale pill", fc.locator(".sum-fc-stale")],
      ["chip", fc.locator(".sum-fc-chip").first()],
      ["badge", railRow(page, DOC_STALE).locator(".sum-fc-badge")],
    ] as const) {
      expect(await paintedContrast(loc), `${scheme} ${name}`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

/** The server's `transcriptSha256(documentTranscript(...))`, restated for these fixtures. */
const transcriptSha = (id: string) => createHash("sha256").update(splitTranscript(sourceText(id)).transcript!.trim()).digest("hex");

/** The columns the real transcript POST writes, for a stub that stands in for it. */
async function saveTranscriptCheck(check: unknown, sha: string): Promise<void> {
  await sql!`UPDATE summary_factchecks SET transcript_claims = ${sql!.json(check as never)}, transcript_sha256 = ${sha}
             WHERE collection = ${COLLECTION} AND doc_id = ${DOC_FRESH}`;
}
const resetFresh = async () => {
  await sql!`UPDATE summary_factchecks SET transcript_claims = NULL, transcript_sha256 = NULL WHERE doc_id = ${DOC_FRESH}`;
  await seed(DOC_FRESH, ["✅", "✅"], factcheckBodySha256(sourceText(DOC_FRESH)));
};
const TX_ROUTE = "**/api/summaries/factcheck/transcript";
const held = () => {
  let release: () => void = () => {};
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
};

test("the transcript button needs a transcript AND a fresh web check", async ({ page }) => {
  // Fresh web check, no transcript appendix.
  await open(page, DOC_NOTX);
  await expect(page.locator("#sumFactcheck .sum-fc-chip").first()).toBeVisible();
  await expect(page.locator("#sumFactcheck .sum-fc-stale")).toHaveCount(0);
  await expect(page.locator("#sumFactcheck .sum-fc-txbtn")).toHaveCount(0);
  // A transcript, but the web check is stale: re-check first.
  await open(page, DOC_STALE_TX);
  await expect(page.locator("#sumFactcheck .sum-fc-stale")).toHaveText("stale");
  await expect(page.locator("#sumFactcheck .sum-fc-txbtn")).toHaveCount(0);
});

test("the transcript check: running state, joins its chip to the web verdict, survives a reload, AA for every chip", async ({ page }) => {
  await seed(DOC_FRESH, ["❌", "✅", "⚠️"], factcheckBodySha256(sourceText(DOC_FRESH)));
  try {
    await open(page, DOC_FRESH);
    const fc = page.locator("#sumFactcheck");
    const btn = fc.locator(".sum-fc-txbtn");
    await expect(btn).toHaveText("⧉ Check transcript");
    await expect(fc.locator(".sum-fc-tx")).toHaveCount(0);

    const gate = held();
    const bodies: string[] = [];
    await page.route(TX_ROUTE, async (route) => {
      bodies.push(route.request().postData() ?? "");
      const check = {
        claims: [
          { index: 1, verdict: "supported", note: "Invented speech." },
          { index: 2, verdict: "not in transcript", note: "never said" },
          { index: 3, verdict: "contradicts transcript", note: "said the opposite" },
        ],
        cut: { truncated: false, keptChars: 30, totalChars: 30 },
        model: "stub",
        botName: BOT,
        checkedAt: Date.now(),
      };
      // The document's own transcript hash: not stale.
      await saveTranscriptCheck(check, transcriptSha(DOC_FRESH));
      await gate.promise;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: check, cutNote: null, html: '<div class="sum-fc-tx">stub block</div>' }),
      });
    });
    await btn.click();
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveText("checking transcript…");
    // A web re-check started now would land a new claim set under this run.
    await expect(fc.locator(".sum-fc-recheck")).toBeDisabled();
    gate.release();
    await expect(fc.locator(".sum-fc-tx")).toHaveText("stub block");
    await expect(btn).toHaveText("↻ Transcript");
    await expect(fc.locator(".sum-fc-recheck")).toBeEnabled();
    expect(JSON.parse(bodies[0]!)).toEqual({ source: "youtube", docId: DOC_FRESH });
    await page.unroute(TX_ROUTE);

    // Reload: the block is the server's, joined by index to the web verdicts.
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, DOC_FRESH);
      const row = (i: number) => fc.locator(`.sum-fc-tx li[data-claim-index="${i}"]`);
      await expect(row(1).locator(".sum-fc-v")).toHaveText("❌");
      await expect(row(1).locator(".sum-fc-tchip")).toHaveText("transcript: supported");
      await expect(row(1).locator(".sum-fc-tx-read")).toHaveText("the source got it wrong");
      await expect(row(2).locator(".sum-fc-tchip")).toHaveText("transcript: not in transcript");
      await expect(row(3).locator(".sum-fc-tchip")).toHaveText("transcript: contradicts transcript");
      await expect(row(3).locator(".sum-fc-tx-read")).toHaveText("the summary misreports the source");
      await expect(fc.locator(".sum-fc-tx .sum-fc-stale")).toHaveCount(0);
      for (const [name, loc] of [
        ["supported chip", row(1).locator(".sum-fc-tchip")],
        ["not-in-transcript chip", row(2).locator(".sum-fc-tchip")],
        ["contradicts chip", row(3).locator(".sum-fc-tchip")],
        ["reading", row(1).locator(".sum-fc-tx-read")],
        ["note", row(1).locator(".sum-fc-tx-note")],
        ["button", fc.locator(".sum-fc-txbtn")],
      ] as const) {
        expect(await paintedContrast(loc), `${scheme} ${name}`).toBeGreaterThanOrEqual(4.5);
      }
    }

    // A transcript that changed since its check marks the block stale.
    await sql!`UPDATE summary_factchecks SET transcript_sha256 = ${"0".repeat(64)} WHERE doc_id = ${DOC_FRESH}`;
    await open(page, DOC_FRESH);
    await expect(fc.locator(".sum-fc-tx .sum-fc-stale")).toHaveText("stale");
  } finally {
    await resetFresh();
  }
});

test("a transcript answer for a web result that has since been replaced is dropped", async ({ page }) => {
  await seed(DOC_FRESH, ["❌", "✅"], factcheckBodySha256(sourceText(DOC_FRESH)));
  try {
    await open(page, DOC_FRESH);
    const fc = page.locator("#sumFactcheck");
    await expect(fc.locator(".sum-fc-meta")).toHaveText("checked 2h ago");
    const gate = held();
    await page.route(TX_ROUTE, async (route) => {
      await gate.promise;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: {}, cutNote: null, html: '<div class="sum-fc-tx">late block</div>' }),
      });
    });
    await fc.locator(".sum-fc-txbtn").click();
    await expect(fc.locator(".sum-fc-txbtn")).toBeDisabled();
    // Another tab re-checks the web claims meanwhile; reopening loads that result.
    await sql!`UPDATE summary_factchecks SET created_at = now(), transcript_claims = NULL, transcript_sha256 = NULL WHERE doc_id = ${DOC_FRESH}`;
    await railRow(page, DOC_STALE).click();
    await expect(page.locator("#sumFactcheck .sum-fc-stale")).toHaveText("stale");
    await railRow(page, DOC_FRESH).click();
    await expect(fc.locator(".sum-fc-meta")).toHaveText("checked just now");
    gate.release();
    await expect(fc.locator(".sum-fc-txbtn")).toBeEnabled();
    await expect(fc.locator(".sum-fc-tx")).toHaveCount(0);
    await page.unroute(TX_ROUTE);
  } finally {
    await resetFresh();
  }
});

test("reopening a document while its transcript check runs does not wipe the block it then shows", async ({ page }) => {
  await seed(DOC_FRESH, ["❌", "✅"], factcheckBodySha256(sourceText(DOC_FRESH)));
  try {
    await open(page, DOC_FRESH);
    const fc = page.locator("#sumFactcheck");
    const post = held();
    await page.route(TX_ROUTE, async (route) => {
      await post.promise;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: {}, cutNote: null, html: '<div class="sum-fc-tx">fresh block</div>' }),
      });
    });
    await fc.locator(".sum-fc-txbtn").click();
    await expect(fc.locator(".sum-fc-txbtn")).toBeDisabled();

    // The reopen's /result is read BEFORE the POST lands (no transcript yet) and answered after it.
    const resultGate = held();
    let fetched: () => void = () => {};
    const resultFetched = new Promise<void>((r) => { fetched = r; });
    await page.route(
      (u) => u.pathname === "/api/summaries/factcheck/result" && u.searchParams.get("docId") === DOC_FRESH,
      async (route) => {
        const response = await route.fetch();
        fetched();
        await resultGate.promise;
        await route.fulfill({ response });
      },
    );
    await railRow(page, DOC_STALE).click();
    await expect(page.locator("#sumFactcheck .sum-fc-stale")).toHaveText("stale");
    await railRow(page, DOC_FRESH).click();
    await resultFetched;
    post.release();
    await expect(fc.locator(".sum-fc-tx")).toHaveText("fresh block");
    const late = page.waitForResponse((r) => r.url().includes("/api/summaries/factcheck/result"));
    resultGate.release();
    await late;
    await page.waitForTimeout(300);
    await expect(fc.locator(".sum-fc-tx")).toHaveText("fresh block");
    await page.unroute(TX_ROUTE);
  } finally {
    await resetFresh();
  }
});

test("a transcript error notice clears on reopen and when a new web result lands", async ({ page }) => {
  await seed(DOC_FRESH, ["❌", "✅"], factcheckBodySha256(sourceText(DOC_FRESH)));
  try {
    await open(page, DOC_FRESH);
    const fc = page.locator("#sumFactcheck");
    await page.route(TX_ROUTE, (route) =>
      route.fulfill({ status: 502, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Transcript check failed: stub down" }) }),
    );
    await fc.locator(".sum-fc-txbtn").click();
    await expect(fc.locator(".sum-fc-err")).toHaveText("Transcript check failed: stub down");
    await railRow(page, DOC_STALE).click();
    await expect(page.locator("#sumFactcheck .sum-fc-stale")).toHaveText("stale");
    await railRow(page, DOC_FRESH).click();
    await expect(fc.locator(".sum-fc-meta")).toHaveText("checked 2h ago");
    await expect(fc.locator(".sum-fc-err")).toHaveCount(0);

    await fc.locator(".sum-fc-txbtn").click();
    await expect(fc.locator(".sum-fc-err")).toHaveText("Transcript check failed: stub down");
    await page.unroute(TX_ROUTE);
    await page.route("**/api/summaries/factcheck?*", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sse([
          ["claims", { type: "claims", claims: [{ index: 1, title: "invented claim 1" }] }],
          ["claim_result", { type: "claim_result", index: 1, verdict: "✅", outcome: "verified", markdown: "" }],
          ["done", { type: "done", answer: answer(["✅"]), saved: true, checkedAt: Date.now(), claimCount: 1 }],
          ["end", {}],
        ]),
      }),
    );
    await fc.locator(".sum-fc-recheck").click();
    await expect(fc.locator(".sum-fc-chip")).toHaveText(["✅ 1"]);
    await expect(fc.locator(".sum-fc-err")).toHaveCount(0);
    await page.unroute("**/api/summaries/factcheck?*");
  } finally {
    await resetFresh();
  }
});
