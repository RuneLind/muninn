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
 *   3. **The panel body reloads with the NEW summary** on the job's `complete`,
 *      through a fake that reproduces huginn's listing lag — it goes on serving
 *      the pre-ingest copy for two more reads, so a panel that reloads once and
 *      announces the result renders the old body under a line calling it new.
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

/**
 * The SHORT-VIDEO half, reachable since muninn #544 and PR 4's appendix: a
 * stored TikTok capture whose transcript is FLAT whisper prose (no
 * `### [HH:MM:SS]` windows) and whose frontmatter is the full set huginn writes.
 */
const TIKTOK_COLLECTION = "tiktok-summaries";
const TIKTOK_DOC = "ai/general/E2E rerun short video.md";
const TIKTOK_URL = "https://www.tiktok.com/@invented/video/7000000000000000000";
const TIKTOK_TRANSCRIPT =
  "So the first thing you notice is that nothing here is real. " +
  "Then the second thing, which is that this fixture was invented for a public repo.";
const TIKTOK_FRONTMATTER = [
  "---",
  'date: "2026-09-02"',
  `url: "${TIKTOK_URL}"`,
  'author: "an invented account"',
  'summary_kind: "standard"',
  'category: "ai/general"',
  'tags: "ai, general"',
  "---",
].join("\n");

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

/** Per COLLECTION now, since the short-video case lives in another one. */
const SOURCE_FILES: Record<string, Record<string, string>> = {
  [COLLECTION]: {
    [DOC_FULL]: `${FULL_FRONTMATTER}\n\nThe stored summary body.\n\n## Transcript\n\n${TRANSCRIPT}\n`,
    [DOC_BARE]: `${BARE_FRONTMATTER}\n\nA summary with no stored transcript.\n`,
    [DOC_CUT]: `${FULL_FRONTMATTER}\n\nA truncated capture.\n\n## Transcript\n\n${TRANSCRIPT}\n\n${TRUNCATION_NOTE}\n`,
  },
  [TIKTOK_COLLECTION]: {
    [TIKTOK_DOC]: `${TIKTOK_FRONTMATTER}\n\nThe stored short-video summary.\n\n## Transcript\n\n${TIKTOK_TRANSCRIPT}\n`,
  },
};

const DOC_URLS: Record<string, string> = {
  [DOC_FULL]: VIDEO_URL,
  [DOC_BARE]: BARE_VIDEO_URL,
  [DOC_CUT]: VIDEO_URL,
  [TIKTOK_DOC]: TIKTOK_URL,
};

const NEW_SUMMARY_LINE = "A re-run summary of invented material.";

let server: ChildProcess | undefined;
let fake: Server | undefined;
let botsRoot: string | undefined;
let sql: ReturnType<typeof postgres> | null = null;

let ingests: Array<Record<string, unknown>> = [];
let modelCalls = 0;
/** Every system prompt the spawned muninn actually SENT. Recorded on the fake,
 *  never through `page.route` — the model call leaves the server, not the tab. */
let systemPrompts: string[] = [];
let unexpected: string[] = [];
/** Every path the fake was asked for, so a drafter or a wiki write is visible. */
let paths: string[] = [];

/**
 * Held until the test says otherwise, so the model call — and with it the whole
 * job — cannot finish before an assertion about the RUNNING state is made.
 *
 * Without it "the menu closed" is unfalsifiable: the job settles in
 * milliseconds against this fake, and the `complete` handler closes the menu
 * too, so the assertion passes whether the click closed it or not.
 */
let releaseModel: () => void = () => {};
let modelGate: Promise<void> = Promise.resolve();

/**
 * huginn's LISTING LAG, faked: the ingest writes the file, and the document
 * endpoint keeps serving the pre-ingest copy for a few reads afterwards. This is
 * the real behaviour (the re-index is a background job) and it is what the
 * panel's post-`complete` reload has to survive — reloading immediately renders
 * the OLD body under a line claiming it is the new one.
 */
let pendingNewBody: string | null = null;
let staleReads = 0;
/** Fewer than the client's own retry budget, so the reload really does land. */
const STALE_READS = 2;

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
        const body = JSON.parse((await readBody(req)) || "{}") as {
          messages?: Array<{ role: string; content: string }>;
        };
        for (const m of body.messages ?? []) if (m.role === "system") systemPrompts.push(m.content);
        await modelGate;
        return writeCompletion(res);
      }

      if (p === "/api/youtube/ingest") {
        const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
        ingests.push(body);
        // The file really is rewritten — and the document endpoint goes on
        // serving the old copy for `STALE_READS` more reads, which is the lag.
        pendingNewBody = `${FULL_FRONTMATTER}\n\n${String(body.summary ?? "")}`;
        staleReads = STALE_READS;
        return json({ file_path: DOC_FULL, similar: [] });
      }

      // The SHORT-VIDEO ingest. No listing lag faked here — the lag itself is
      // pinned on the YouTube path above, and repeating it would only make this
      // case slower to fail.
      if (p === "/api/tiktok/ingest") {
        const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
        ingests.push(body);
        SOURCE_FILES[TIKTOK_COLLECTION]![TIKTOK_DOC] =
          `${TIKTOK_FRONTMATTER}\n\n${String(body.summary ?? "")}`;
        return json({ file_path: TIKTOK_DOC, similar: [] });
      }

      if (p.startsWith("/api/collection/") && p.endsWith("/documents")) {
        const collection = p.slice("/api/collection/".length, -"/documents".length);
        const files = SOURCE_FILES[collection];
        if (!files) return json({ documents: [] });
        // DELIBERATELY no `url` on any row: `findExistingByVideoId` needs one to
        // resolve a video id, so the listing can never answer `duplicate`. That
        // is what makes the duplicate assertion below evidence about
        // `recentIngests` rather than about the listing.
        return json({
          documents: Object.keys(files).map((id) => ({
            id,
            title: id.split("/").pop()!.replace(/\.md$/, ""),
            date: "2026-09-01",
          })),
        });
      }

      const docMatch = /^\/api\/document\/([^/]+)\/(.+)$/.exec(p);
      if (docMatch) {
        const collection = docMatch[1]!;
        const id = docMatch[2]!;
        const files = SOURCE_FILES[collection];
        if (!files) return json({ detail: "not found" }, 404);

        // The RAW source file — the whole point of the vertical slice.
        if (url.searchParams.get("raw") === "1") {
          const raw = files[id];
          if (raw === undefined) return json({ detail: "not found" }, 404);
          res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
          return res.end(raw);
        }

        // The CLEANED JSON form the doc panel renders from — a breadcrumb on
        // top, exactly as huginn's converter writes it.
        if (id === DOC_FULL && pendingNewBody !== null) {
          if (staleReads > 0) staleReads -= 1;
          else {
            files[DOC_FULL] = pendingNewBody;
            pendingNewBody = null;
          }
        }
        const body = files[id];
        if (body === undefined) return json({ detail: "not found" }, 404);
        const withoutFrontmatter = body.split("\n---\n").slice(1).join("\n---\n");
        return json({
          id,
          url: DOC_URLS[id],
          text: `[${collection} > ai/general]\n${withoutFrontmatter}`,
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

function removeBotsRoot(): void {
  if (botsRoot) rmSync(botsRoot, { recursive: true, force: true });
  botsRoot = undefined;
}

/**
 * A hard kill (Ctrl-C, a CI cancel) skips `afterAll`, and this file leaves three
 * things behind: a spawned muninn holding PORT, a `node:http` fake holding
 * FAKE_PORT, and a temp bots root. The `summaries-vimeo.spec.ts` shape, for the
 * two reasons measured there:
 *
 * 1. **It RE-RAISES.** Registering ANY listener for SIGINT/SIGTERM suppresses
 *    Node's default termination, so the handler removes itself and re-sends the
 *    same signal, which now finds no listener.
 * 2. **Registered in `beforeAll`, removed in `afterAll`,** never at import: a
 *    Playwright worker is reused across spec files, so import-time registration
 *    accumulates one handler per file for the worker's whole lifetime, each
 *    pointing at a `botsRoot` it no longer owns.
 */
function handleSignal(signal: NodeJS.Signals): void {
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

test.beforeAll(async () => {
  sql = postgres(TEST_DB, { max: 2 });
  await sql`DELETE FROM prompt_snapshots WHERE trace_id = ${SNAPSHOT_TRACE_ID}`;
  await sql`
    INSERT INTO prompt_snapshots (trace_id, system_prompt, user_prompt, pass, kind, source_url)
    VALUES (${SNAPSHOT_TRACE_ID}, ${"E2E stored system prompt."}, ${"E2E stored user prompt."}, ${"claude"}, ${"capture"}, ${BARE_VIDEO_URL})
  `;

  fake = await startFake();
  const root = writeBot();
  addSignalHandlers();
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
  removeBotsRoot();
  removeSignalHandlers();
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
    systemPrompts = [];
    paths = [];
    pendingNewBody = null;
    staleReads = 0;
    // Both re-run cases REWRITE their document in the fake, so the fixtures are
    // restored between them — otherwise the second run of a file would read the
    // first run's output as the stored capture.
    SOURCE_FILES[COLLECTION]![DOC_FULL] =
      `${FULL_FRONTMATTER}\n\nThe stored summary body.\n\n## Transcript\n\n${TRANSCRIPT}\n`;
    SOURCE_FILES[TIKTOK_COLLECTION]![TIKTOK_DOC] =
      `${TIKTOK_FRONTMATTER}\n\nThe stored short-video summary.\n\n## Transcript\n\n${TIKTOK_TRANSCRIPT}\n`;
    modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
  });

  test.afterEach(() => {
    // A test that never released the gate must not leave a spawned muninn's
    // request hanging into the next one.
    releaseModel();
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

    // The menu closes on the CLICK that starts the run, and the status line
    // takes over — both asserted while the model call is still held open by the
    // fake. Asserted after the job settles instead, "the menu is hidden" is
    // unfalsifiable: the `complete` handler closes it too.
    await expect(page.locator("#docPanelRerunStatus")).toContainText("Re-run", { timeout: 15_000 });
    await expect(menu).toBeHidden();
    expect(ingests).toHaveLength(0);
    releaseModel();

    // 3. The panel body reloads with the new summary on `complete` — and the
    //    fake serves the PRE-INGEST body for the first two reads afterwards, the
    //    listing lag, so this only passes if the client re-reads until the
    //    document really has changed rather than reloading once and claiming it.
    await expect(page.locator("#docPanelRerunStatus")).toContainText(
      "Re-run finished — the summary below is the new one.",
      { timeout: 60_000 },
    );
    await expect(page.locator("#sumArticleMain")).toContainText(NEW_SUMMARY_LINE);
    await expect(page.locator("#sumArticleMain")).not.toContainText("The stored summary body.");

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


  test("a SHORT-VIDEO document re-runs from its flat appendix, with a frameless prompt", async ({ page }) => {
    // The half muninn #544 made reachable: TikTok and X video are one capture
    // job now, and PR 4 files their whisper transcript under `## Transcript`.
    // Everything about the re-run that is short-video-specific is here — the
    // shared builders, the vertical's own spec, and the FLAT capper.
    await page.goto(`${BASE}/summaries?source=tiktok&doc=${encodeURIComponent(TIKTOK_DOC)}`);
    await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
    await expect(page.locator("#sumArticleMain")).toContainText("The stored short-video summary.");

    await page.locator("#docPanelRerun").click();
    const menu = page.locator("#docPanelRerunMenu");
    await expect(menu).toBeVisible();
    const same = menu.getByRole("menuitem", { name: "Same settings again" });
    await expect(same).toBeEnabled();
    await same.click();
    releaseModel();

    await expect(page.locator("#docPanelRerunStatus")).toContainText(
      "Re-run finished — the summary below is the new one.",
      { timeout: 60_000 },
    );

    // ONE ingest, every field equal but `summary_kind` (which "same settings
    // again" re-sends at its stored value — the point is that it was sent).
    expect(ingests).toHaveLength(1);
    const body = ingests[0]!;
    expect(body.title).toBe("E2E rerun short video");
    expect(body.category).toBe("ai/general");
    expect(body.url).toBe(TIKTOK_URL);
    expect(body.date).toBe("2026-09-02");
    expect(body.author).toBe("an invented account");
    expect(body.summary_kind).toBe("standard");

    // The appendix, byte-equal after the trim.
    const summary = String(body.summary);
    expect(summary.endsWith(`\n\n## Transcript\n\n${TIKTOK_TRANSCRIPT}\n`)).toBe(true);
    expect(summary).toContain(NEW_SUMMARY_LINE);

    // The system prompt the model was actually sent is the ZERO-FRAME form:
    // a re-run has no work dir and no JPEGs, so an instruction to read them —
    // or not to narrate them — is an order about material that is not there.
    expect(systemPrompts).toHaveLength(1);
    expect(systemPrompts[0]).not.toMatch(/frames?/i);
    expect(systemPrompts[0]).toContain("from its speech transcript");
    expect(modelCalls).toBe(1);
  });

  test("exactly ONE stream per re-run, and it is handed to the shelf on close", async ({ page }) => {
    // Two failures, one property: a second `connectSSE` at `startRerun` puts two
    // EventSources on one job (the shelf card is behind a fixed scrim, so the
    // second is fan-out nobody can see), and dropping the hand-off leaves the
    // card dead once the panel closes.
    const streamRequests: string[] = [];
    page.on("request", (r) => {
      const u = r.url();
      if (u.includes("/stream/")) streamRequests.push(u);
    });

    await page.goto(`${BASE}/summaries?source=${SOURCE}&doc=${encodeURIComponent(DOC_FULL)}`);
    await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
    await page.locator("#docPanelRerun").click();
    await page.locator("#docPanelRerunMenu").getByRole("menuitem", { name: "Same settings again" }).click();
    await expect(page.locator("#docPanelRerunStatus")).toContainText("Re-run", { timeout: 15_000 });

    // While the panel is open: the panel's own stream and nothing else.
    await expect.poll(() => streamRequests.length, { timeout: 15_000 }).toBe(1);
    releaseModel();
    await expect(page.locator("#docPanelRerunStatus")).toContainText(
      "Re-run finished — the summary below is the new one.",
      { timeout: 60_000 },
    );
    // The job settled while the panel was open, so it closed its own stream and
    // never needed the hand-off — still one.
    expect(streamRequests).toHaveLength(1);
  });

  test("the menu is keyboard-operable: arrows walk it, Escape gives focus back", async ({ page }) => {
    await page.goto(`${BASE}/summaries?source=${SOURCE}&doc=${encodeURIComponent(DOC_FULL)}`);
    await expect(page.locator("#docOverlay")).toHaveClass(/visible/);

    const btn = page.locator("#docPanelRerun");
    await btn.focus();
    await btn.press("Enter");
    const menu = page.locator("#docPanelRerunMenu");
    await expect(menu).toBeVisible();

    // Opening focuses the FIRST enabled item.
    const focusedText = () => page.evaluate(() => document.activeElement?.textContent ?? "");
    await expect.poll(focusedText).toContain("Same settings again");

    // ArrowDown walks forward, ArrowUp comes back — the enabled items only.
    await page.keyboard.press("ArrowDown");
    const second = await focusedText();
    expect(second).not.toContain("Same settings again");
    expect(second.length).toBeGreaterThan(0);
    await page.keyboard.press("ArrowUp");
    await expect.poll(focusedText).toContain("Same settings again");

    // Escape closes the menu and puts the caret back on the button that opened
    // it. Without that, dismissing drops focus on <body> behind a still-open
    // scrim, which for a keyboard reader is the end of the road.
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    const focusedId = await page.evaluate(() => document.activeElement?.id ?? "");
    expect(focusedId).toBe("docPanelRerun");
    // …and the panel itself is still open: the menu's Escape is handled first.
    await expect(page.locator("#docOverlay")).toHaveClass(/visible/);

    expect(modelCalls).toBe(0);
    expect(ingests).toHaveLength(0);
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
