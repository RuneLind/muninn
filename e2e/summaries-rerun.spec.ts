/**
 * `/summaries` — the doc panel's `↻ Re-run ▾` menu, end to end.
 *
 * A re-run rewrites a document that is already in the corpus, so the thing that
 * matters is not "did a summary come back" but "is the file still the same
 * file". Only this tier can see that: a spawned muninn, a fake huginn that
 * serves the SOURCE BYTES on `?raw=1` and records what comes back on
 * `POST /api/youtube/ingest`, and a throwaway `openai-compat` bot pointed at
 * the same fake so the summarize step spends no model call.
 *
 * What it pins, in order:
 *
 *   1. **One re-ingest**, whose frontmatter fields are BYTE-EQUAL to the stored
 *      ones except `summary_kind` — the rule huginn's "no document id, rewrite
 *      the whole file, fork `(2)` on a differing url" ingest makes load-bearing.
 *   2. **The appendix comes back byte-equal**, trimmed, under its own heading.
 *   3. **The panel body reloads** on the job's `complete`.
 *   4. **No source-drafter run**: exactly ONE model call for the whole re-run.
 *      A drafter would spend a second.
 *   5. **The vertical's reindex-window memory was told** — a `summarize` POST
 *      for the same video right afterwards is answered `duplicate`, and the
 *      fake's listing carries no url at all, so `recentIngests` is the ONLY
 *      guard that can have answered.
 *   6. A document with **no appendix** renders the transcript items disabled and
 *      says why; one whose appendix carries the **truncation note** says that.
 *   7. **Show prompt** renders the shared prompt modal over the panel, from a
 *      `prompt_snapshots` row seeded straight into Postgres.
 *
 * NOTHING is written under the repo's own `bots/`: the throwaway bot lives in a
 * temp `MUNINN_BOTS_DIR`. Ports come from `e2e/ports.ts` — never a literal.
 * Playwright runs this file under NODE, hence `node:http` and `postgres`.
 *
 * ENV PREREQUISITE: `bun run db:setup:test`.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("summaries-rerun");
const FAKE_PORT = e2ePort("summaries-rerun/fake");
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const BOT = "e2ererun";
const SOURCE = "youtube";
const COLLECTION = "youtube-summaries";

/** 11 URL-safe base64 characters — the frames seam's own id charset. */
const VIDEO_ID = "e2eRerun001";
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
/** The transcript-less document gets its OWN video, so the snapshot seeded for
 *  it cannot be superseded by the snapshot the re-run above writes: the prompt
 *  route answers with the LATEST capture row for a url, and both documents
 *  sharing one url made this file's last case depend on its first. */
const BARE_VIDEO_ID = "e2eRerun002";
const BARE_VIDEO_URL = `https://www.youtube.com/watch?v=${BARE_VIDEO_ID}`;

const DOC_FULL = "ai/general/E2E rerun talk.md";
const DOC_BARE = "ai/general/E2E rerun no transcript.md";
const DOC_CUT = "ai/general/E2E rerun truncated.md";

/** The exact appendix bytes the re-ingest must hand back. */
const TRANSCRIPT = "### [00:00:00]\n\nFirst window of invented speech.\n\n### [00:02:00]\n\nSecond window.";
const TRUNCATION_NOTE = "_(transcript truncated — the talk continues past this point.)_";

/** The frontmatter block of the full document, spelled the way huginn writes it. */
const FULL_FRONTMATTER = [
  "---",
  'date: "2026-09-01"',
  `url: "${VIDEO_URL}"`,
  'summary_kind: "standard"',
  'category: "ai/general"',
  'tags: "ai, general"',
  "---",
].join("\n");

const BARE_FRONTMATTER = FULL_FRONTMATTER.replace(VIDEO_URL, BARE_VIDEO_URL);

const SOURCE_FILES: Record<string, string> = {
  [DOC_FULL]: `${FULL_FRONTMATTER}\n\nThe stored summary body.\n\n## Transcript\n\n${TRANSCRIPT}\n`,
  [DOC_BARE]: `${BARE_FRONTMATTER}\n\nA summary with no stored transcript.\n`,
  [DOC_CUT]: `${FULL_FRONTMATTER}\n\nA truncated capture.\n\n## Transcript\n\n${TRANSCRIPT}\n\n${TRUNCATION_NOTE}\n`,
};

const DOC_URLS: Record<string, string> = {
  [DOC_FULL]: VIDEO_URL,
  [DOC_BARE]: BARE_VIDEO_URL,
  [DOC_CUT]: VIDEO_URL,
};

const NEW_SUMMARY_LINE = "A re-run summary of invented material.";

let server: ChildProcess | undefined;
let fake: Server | undefined;
let botsRoot: string | undefined;
let sql: ReturnType<typeof postgres> | null = null;

let ingests: Array<Record<string, unknown>> = [];
let modelCalls = 0;
let unexpected: string[] = [];
/** Every path the fake was asked for, so a drafter or a wiki write is visible. */
let paths: string[] = [];

const SNAPSHOT_TRACE_ID = "5f6e7d8c-9a0b-4c1d-8e2f-3a4b5c6d7e8f";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
  });
}

function writeCompletion(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const chunk = (delta: Record<string, unknown>) =>
    `data: ${JSON.stringify({ model: "e2e-fake", choices: [{ index: 0, delta }] })}\n\n`;
  res.write(chunk({ content: "CATEGORY: ai/general\n\nSUMMARY:\n" }));
  res.write(chunk({ content: `\n${NEW_SUMMARY_LINE}\n` }));
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

async function startFake(): Promise<Server> {
  const srv = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const p = decodeURIComponent(url.pathname);
      paths.push(`${req.method ?? "GET"} ${p}`);
      const json = (body: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      if (p === "/v1/chat/completions") {
        modelCalls += 1;
        return writeCompletion(res);
      }

      if (p === "/api/youtube/ingest") {
        ingests.push(JSON.parse((await readBody(req)) || "{}"));
        return json({ file_path: DOC_FULL, similar: [] });
      }

      if (p.startsWith("/api/collection/") && p.endsWith("/documents")) {
        const collection = p.slice("/api/collection/".length, -"/documents".length);
        if (collection !== COLLECTION) return json({ documents: [] });
        // DELIBERATELY no `url` on any row: `findExistingByVideoId` needs one to
        // resolve a video id, so the listing can never answer `duplicate`. That
        // is what makes the duplicate assertion below evidence about
        // `recentIngests` rather than about the listing.
        return json({
          documents: Object.keys(SOURCE_FILES).map((id) => ({
            id,
            title: id.split("/").pop()!.replace(/\.md$/, ""),
            date: "2026-09-01",
          })),
        });
      }

      // The RAW source file — the whole point of the vertical slice.
      if (p.startsWith(`/api/document/${COLLECTION}/`) && url.searchParams.get("raw") === "1") {
        const id = p.slice(`/api/document/${COLLECTION}/`.length);
        const body = SOURCE_FILES[id];
        if (body === undefined) return json({ detail: "not found" }, 404);
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
        return res.end(body);
      }

      // The CLEANED JSON form the doc panel renders from — a breadcrumb on top,
      // exactly as huginn's converter writes it.
      if (p.startsWith(`/api/document/${COLLECTION}/`)) {
        const id = p.slice(`/api/document/${COLLECTION}/`.length);
        const body = SOURCE_FILES[id];
        if (body === undefined) return json({ detail: "not found" }, 404);
        const withoutFrontmatter = body.split("\n---\n").slice(1).join("\n---\n");
        return json({
          id,
          url: DOC_URLS[id],
          text: `[${COLLECTION} > ai/general]\n${withoutFrontmatter}`,
        });
      }

      if (p === "/api/search") return json({ results: [] });
      if (p === "/health") return json({ status: "ok" });

      unexpected.push(`${req.method ?? "GET"} ${p}`);
      return json({ error: "unexpected path", path: p }, 404);
    })();
  });
  await new Promise<void>((resolve) => srv.listen(FAKE_PORT, "127.0.0.1", resolve));
  return srv;
}

function writeBot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "muninn-e2e-rerun-bots-"));
  const dir = path.join(root, BOT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "CLAUDE.md"), "# e2e rerun summarizer\n\nCreated by e2e/summaries-rerun.spec.ts.\n");
  writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ connector: "openai-compat", model: "e2e-fake", baseUrl: `${FAKE}/v1`, timeoutMs: 60000 }, null, 2),
  );
  botsRoot = root;
  return root;
}

test.beforeAll(async () => {
  sql = postgres(TEST_DB, { max: 2 });
  await sql`DELETE FROM prompt_snapshots WHERE trace_id = ${SNAPSHOT_TRACE_ID}`;
  await sql`
    INSERT INTO prompt_snapshots (trace_id, system_prompt, user_prompt, pass, kind, source_url)
    VALUES (${SNAPSHOT_TRACE_ID}, ${"E2E stored system prompt."}, ${"E2E stored user prompt."}, ${"claude"}, ${"capture"}, ${BARE_VIDEO_URL})
  `;

  fake = await startFake();
  const root = writeBot();
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      // Both in `AMBIENT_INSTANCE_ENV`, hence after the `e2eEnv()` spread.
      MUNINN_BOTS_DIR: root,
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
  if (botsRoot) rmSync(botsRoot, { recursive: true, force: true });
  try {
    if (sql) await sql`DELETE FROM prompt_snapshots WHERE trace_id = ${SNAPSHOT_TRACE_ID}`;
  } finally {
    await sql?.end();
  }
  expect(unexpected).toEqual([]);
});

test.describe("Summaries: the doc panel's ↻ Re-run menu", () => {
  test.beforeEach(() => {
    ingests = [];
    modelCalls = 0;
    paths = [];
  });

  test("re-runs from the stored transcript and rewrites the SAME document", async ({ page }) => {
    await page.goto(`${BASE}/summaries?source=${SOURCE}&doc=${encodeURIComponent(DOC_FULL)}`);
    await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
    await expect(page.locator("#sumArticleMain")).toContainText("The stored summary body.");

    // The listing really does carry no url — the precondition that makes the
    // duplicate assertion at the end evidence about `recentIngests`.
    const listing = (await (
      await fetch(`${FAKE}/api/collection/${COLLECTION}/documents`)
    ).json()) as { documents: Array<{ url?: string }> };
    expect(listing.documents.every((d) => d.url === undefined)).toBe(true);

    const menuBtn = page.locator("#docPanelRerun");
    await expect(menuBtn).toBeVisible();
    await menuBtn.click();

    const menu = page.locator("#docPanelRerunMenu");
    await expect(menu).toBeVisible();
    const same = menu.getByRole("menuitem", { name: "Same settings again" });
    await expect(same).toBeEnabled();
    // The copy the alignment contract names: a re-run without media.
    await expect(menu).toContainText("No media is re-fetched");
    await same.click();

    // The menu closes and the status line takes over.
    await expect(menu).toBeHidden();
    await expect(page.locator("#docPanelRerunStatus")).toContainText("Re-run", { timeout: 15_000 });

    // 3. The panel body reloads with the new summary on `complete`.
    await expect(page.locator("#docPanelRerunStatus")).toContainText("Re-run finished", { timeout: 60_000 });

    // 1. ONE re-ingest, every frontmatter field byte-equal but `summary_kind`.
    expect(ingests).toHaveLength(1);
    const body = ingests[0]!;
    expect(body.url).toBe(VIDEO_URL);
    expect(body.date).toBe("2026-09-01");
    expect(body.title).toBe("E2E rerun talk");
    expect(body.category).toBe("ai/general");
    // "Same settings again" ran the STORED kind, so this one is equal too — the
    // point being that the route sent it rather than dropping the key.
    expect(body.summary_kind).toBe("standard");

    // 2. The appendix, byte-equal after the trim.
    const summary = String(body.summary);
    expect(summary.endsWith(`\n\n## Transcript\n\n${TRANSCRIPT}\n`)).toBe(true);
    expect(summary).toContain(NEW_SUMMARY_LINE);

    // 4. Exactly one model call: no source-drafter run rode along, and nothing
    //    reached a wiki or gardener route on the fake.
    expect(modelCalls).toBe(1);
    expect(paths.filter((x) => x.includes("/api/wiki/"))).toEqual([]);

    // 5. The reindex-window memory was told: a capture POST for the same video
    //    is answered `duplicate`, and only `recentIngests` can have answered it.
    const dup = await fetch(`${BASE}/api/youtube/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ video_id: VIDEO_ID, url: VIDEO_URL, title: "E2E rerun talk" }),
    });
    const dupBody = (await dup.json()) as { duplicate?: boolean; document_id?: string };
    expect(dupBody.duplicate).toBe(true);
    expect(dupBody.document_id).toBe(DOC_FULL);

    // The re-run's own prompt snapshot landed under the STORED url — the key
    // `GET /api/summaries/prompt?url=` reads, so the document keeps ONE
    // addressable prompt rather than gaining one per run.
    const rows = await sql!<{ n: string }[]>`
      SELECT count(*)::text AS n FROM prompt_snapshots WHERE kind = 'capture' AND source_url = ${VIDEO_URL}`;
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    await sql!`DELETE FROM prompt_snapshots WHERE kind = 'capture' AND source_url = ${VIDEO_URL}`;
  });

  test("a document with no appendix disables the transcript items and says why", async ({ page }) => {
    await page.goto(`${BASE}/summaries?source=${SOURCE}&doc=${encodeURIComponent(DOC_BARE)}`);
    await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
    await page.locator("#docPanelRerun").click();

    const menu = page.locator("#docPanelRerunMenu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Same settings again" })).toBeDisabled();
    await expect(menu).toContainText("stored no transcript");
    // Full re-fetch is its own item and is NOT disabled for the same reason —
    // it is disabled because the server says it is not available yet, and the
    // menu shows that reason instead of hiding it.
    await expect(menu).toContainText("A full re-fetch is not available yet");
    expect(ingests).toHaveLength(0);
    expect(modelCalls).toBe(0);
  });

  test("a truncated appendix says so before the reader spends a run on it", async ({ page }) => {
    await page.goto(`${BASE}/summaries?source=${SOURCE}&doc=${encodeURIComponent(DOC_CUT)}`);
    await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
    await page.locator("#docPanelRerun").click();
    const menu = page.locator("#docPanelRerunMenu");
    await expect(menu).toContainText("truncated at capture");
    await expect(menu.getByRole("menuitem", { name: "Same settings again" })).toBeEnabled();
  });

  test("Show prompt renders the stored snapshot over the panel", async ({ page }) => {
    await page.goto(`${BASE}/summaries?source=${SOURCE}&doc=${encodeURIComponent(DOC_BARE)}`);
    await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
    await page.locator("#docPanelRerun").click();
    await page.locator("#docPanelRerunMenu").getByRole("menuitem", { name: "Show prompt" }).click();

    const backdrop = page.locator("#promptModalBackdrop");
    await expect(backdrop).toHaveClass(/visible/, { timeout: 15_000 });
    await expect(page.locator("#promptContent")).toContainText("E2E stored user prompt.");
    // It has to sit ABOVE the doc panel it opened over, or the reader sees the
    // scrim and none of the prompt.
    const z = await backdrop.evaluate((el) => getComputedStyle(el).zIndex);
    expect(Number(z)).toBeGreaterThan(1000);
    // The system tab is the modal's own control, reused rather than copied.
    await page.locator("#tabSystem").click();
    await expect(page.locator("#promptContent")).toContainText("E2E stored system prompt.");
    // The trace behind this seeded row does not exist, so no waterfall is offered.
    await expect(page.locator("#docPanelRerunStatus")).toContainText("no waterfall");
    expect(modelCalls).toBe(0);
  });
});
