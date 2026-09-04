/**
 * `/summaries` — the doc panel's 🗑 Delete, end to end.
 *
 * The one destructive affordance on the page, so it gets the executable tier:
 * a spawned muninn against the TEST database and a fake huginn, with the two
 * proposal rows the delete must treat differently seeded into `wiki_proposals`
 * (a `draft` source page written from the doc, and an `applied` one). What only
 * this tier can see:
 *
 *   1. The confirm dialog names the doc AND says the draft goes with it — the
 *      consent text, not the notice.
 *   2. Huginn receives the DELETE for the right collection/id (the client posts
 *      the COLLECTION read off the injected source map, not the source id).
 *   3. The draft row is gone, the applied row is kept — read back from Postgres.
 *   4. The panel closes, the shelf row is gone, and the page-level notice names
 *      both the deleted draft and the kept page. A failure is a notice too, ON
 *      the page after the panel closed — a notice painted behind the panel's
 *      fixed scrim is one nobody sees.
 *
 * NO MODEL CALLS AND NO SPEND. The route needs a seeded `wiki-gardener` watcher
 * for the bot; one is inserted (and removed) here when the test DB has none.
 * Playwright runs this file under NODE — hence `node:http` and `postgres`.
 *
 * ENV PREREQUISITE: `bun run db:setup:test` (the TEST database). Ports come from
 * `e2e/ports.ts` — never a literal.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("summaries-delete");
const HUGINN_PORT = e2ePort("summaries-delete/huginn");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

/** The only bot CI has, and the registry's default wiki — the delete target. */
const BOT = "jarvis";
const SOURCE = "youtube";
const COLLECTION = "youtube-summaries";
const DOC_ID = "ai/e2e/Delete this summary.md";
const DOC_TITLE = "Delete this summary";
const TOPIC_DRAFT = "e2e-summaries-delete-draft";
const TOPIC_APPLIED = "e2e-summaries-delete-applied";
const USER_ID = "e2e-summaries-delete";

let server: ChildProcess | undefined;
let huginn: Server | undefined;
let sql: ReturnType<typeof postgres> | null = null;
let seededWatcherId: string | null = null;
/** Every DELETE path the fake huginn received. */
let deletes: string[] = [];
/** When set, the listing answers 500 — the post-delete refetch failure path. */
let failListing = false;
/** A doc with the SAME id in another vertical: a delete must leave its row alone. */
const OTHER_SOURCE = "x-article";
const OTHER_COLLECTION = "x-articles";
/** The listing keeps carrying the doc AFTER the delete — deliberately. Huginn's
 *  listing lags its reindex, so the refetch the client runs after the status
 *  poll can re-render the row; the row staying gone is the client pulling it
 *  again AFTER that re-render, which is what the last assertion pins. */

async function startFakeHuginn(): Promise<Server> {
  const srv = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "DELETE") {
      deletes.push(p);
      return json({
        status: "deleted",
        movedTo: "/tmp/deleted/x.md",
        reindex: { [COLLECTION]: "started" },
      });
    }
    if (p.startsWith("/api/collection/") && p.endsWith("/documents")) {
      if (failListing) {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "listing down" }));
      }
      const collection = p.slice("/api/collection/".length, -"/documents".length);
      return json({
        documents:
          collection === COLLECTION || collection === OTHER_COLLECTION
            ? [{ id: DOC_ID, title: DOC_TITLE, date: "2026-09-01", url: "https://example.com/v" }]
            : [],
      });
    }
    if (p.startsWith("/api/document/")) {
      return json({ id: DOC_ID, text: `[youtube > ai/e2e > ${DOC_TITLE}]\n\n## Body\n\nhello`, url: "https://example.com/v" });
    }
    if (p.endsWith("/update-status")) return json({ status: "succeeded" });
    if (p === "/api/search") return json({ results: [] });
    return json({});
  });
  await new Promise<void>((resolve) => srv.listen(HUGINN_PORT, "127.0.0.1", resolve));
  return srv;
}

/** Passed through `sql.json`, never pre-stringified: postgres.js infers jsonb
 *  from the cast and JSON-encodes a string parameter AGAIN, storing a JSON
 *  string the `@>` containment can never match (measured: the first run of this
 *  spec deleted nothing and reported so). */
const SOURCE_DOCS = [{ collection: COLLECTION, docId: DOC_ID, title: DOC_TITLE, url: "https://example.com/v" }];

async function seedProposals(): Promise<void> {
  await sql!`DELETE FROM wiki_proposals WHERE bot_name = ${BOT} AND topic_key IN (${TOPIC_DRAFT}, ${TOPIC_APPLIED})`;
  await sql!`INSERT INTO wiki_proposals (bot_name, topic_key, kind, mode, target_path, draft, source_docs, status)
            VALUES (${BOT}, ${TOPIC_DRAFT}, 'source', 'create', ${"sources/" + TOPIC_DRAFT + ".mdx"}, '---\ntype: source\n---\n# x', ${sql!.json(SOURCE_DOCS as never)}, 'draft'),
                   (${BOT}, ${TOPIC_APPLIED}, 'source', 'create', ${"sources/" + TOPIC_APPLIED + ".mdx"}, '---\ntype: source\n---\n# y', ${sql!.json(SOURCE_DOCS as never)}, 'applied')`;
}

test.beforeAll(async () => {
  sql = postgres(TEST_DB, { max: 2 });
  // The route 404s without a seeded wiki-gardener watcher for the bot.
  const [existing] = await sql<{ id: string }[]>`SELECT id FROM watchers WHERE bot_name = ${BOT} AND type = 'wiki-gardener' LIMIT 1`;
  if (!existing) {
    await sql`INSERT INTO users (id, username, display_name, platform) VALUES (${USER_ID}, ${USER_ID}, 'E2E Summaries Delete', 'web') ON CONFLICT (id) DO NOTHING`;
    const [w] = await sql<{ id: string }[]>`INSERT INTO watchers (user_id, bot_name, name, type, config, interval_ms)
                 VALUES (${USER_ID}, ${BOT}, 'e2e wiki gardener', 'wiki-gardener', '{}'::jsonb, 604800000) RETURNING id`;
    seededWatcherId = w!.id;
  }

  huginn = await startFakeHuginn();
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      KNOWLEDGE_API_URL: `http://127.0.0.1:${HUGINN_PORT}`,
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
  huginn?.close();
  try {
    if (sql) {
      await sql`DELETE FROM wiki_proposals WHERE bot_name = ${BOT} AND topic_key IN (${TOPIC_DRAFT}, ${TOPIC_APPLIED})`;
      if (seededWatcherId) {
        await sql`DELETE FROM watchers WHERE id = ${seededWatcherId}`;
        await sql`DELETE FROM users WHERE id = ${USER_ID}`;
      }
    }
  } finally {
    await sql?.end();
  }
});

test.describe("Summaries: doc-panel delete", () => {
  test.beforeEach(async () => {
    deletes = [];
    failListing = false;
    await seedProposals();
  });

  test("deletes the summary from huginn and the draft written from it, keeps the applied page, and says so", async ({ page }) => {
    const dialogs: string[] = [];
    const deletePosts: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/backlog-doc-delete")) deletePosts.push(req.url());
    });
    page.on("dialog", async (d) => {
      dialogs.push(d.message());
      await d.accept();
    });

    await page.goto(`${BASE}/summaries?source=${SOURCE}&doc=${encodeURIComponent(DOC_ID)}`);
    await expect(page.locator("#docOverlay")).toHaveClass(/visible/);
    await expect(page.locator("#docPanelTitle")).toHaveText(DOC_TITLE);
    // Shelf tab is behind the panel; the row is there (data-doc-id + data-source).
    const row = page.locator(`#shelfList [data-doc-id="${DOC_ID}"][data-source="${SOURCE}"]`);
    await expect(row).toHaveCount(1);
    // Same id, other vertical — must survive the delete (doc ids are collection-relative).
    const otherRow = page.locator(`#shelfList [data-doc-id="${DOC_ID}"][data-source="${OTHER_SOURCE}"]`);
    await expect(otherRow).toHaveCount(1);

    const btn = page.locator("#docPanelDelete");
    await expect(btn).toBeVisible();
    await btn.click();

    // 1. The consent text: the doc, the collection, and the draft.
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toContain(`Delete "${DOC_TITLE}"?`);
    expect(dialogs[0]).toContain(COLLECTION);
    expect(dialogs[0]).toContain("deletes the wiki draft written from it");

    // 4. Panel closed, notice names the draft and the kept page, row gone.
    await expect(page.locator("#docOverlay")).not.toHaveClass(/visible/);
    const notice = page.locator("#deleteNotice");
    await expect(notice).toHaveClass(/visible/);
    await expect(notice).toContainText(`Deleted "${DOC_TITLE}" and 1 wiki draft written from it`);
    await expect(notice).toContainText(`kept the applied page sources/${TOPIC_APPLIED}.mdx`);
    await expect(notice).not.toHaveClass(/err/);
    await expect(row).toHaveCount(0);
    // The button is reusable for the next doc, not stuck disabled behind the poll.
    await expect(btn).toBeEnabled();

    // 2. Huginn got exactly one DELETE, for the collection (not the source id) —
    //    and the client named its wiki EXPLICITLY rather than riding the route's
    //    request defaults (a WIKI_DIR instance answers those with a 404).
    expect(deletes).toEqual([`/api/document/${COLLECTION}/${DOC_ID}`]);
    expect(deletePosts).toHaveLength(1);
    expect(new URL(deletePosts[0]!).searchParams.get("wiki")).toBe(BOT);

    // 3. The rows, read back.
    const rows = await sql!<{ topic_key: string; status: string }[]>`
      SELECT topic_key, status FROM wiki_proposals WHERE bot_name = ${BOT} AND topic_key IN (${TOPIC_DRAFT}, ${TOPIC_APPLIED}) ORDER BY topic_key`;
    expect(rows).toEqual([{ topic_key: TOPIC_APPLIED, status: "applied" }]);

    // After the reindex poll and refetch the row must STAY gone (the refetch
    // re-renders the shelf; a removal that ran before the re-render is inert).
    await page.waitForTimeout(3000);
    await expect(row).toHaveCount(0);
    await expect(otherRow).toHaveCount(1);
  });

  test("a listing that fails after the delete is said, not hidden behind a green notice", async ({ page }) => {
    page.on("dialog", (d) => d.accept());
    await page.goto(`${BASE}/summaries?source=${SOURCE}&doc=${encodeURIComponent(DOC_ID)}`);
    await expect(page.locator("#docPanelTitle")).toHaveText(DOC_TITLE);
    failListing = true;
    await page.locator("#docPanelDelete").click();
    const notice = page.locator("#deleteNotice");
    // The delete itself succeeded; the refetch could not — both facts in one line,
    // in the error tone. (Timeout covers the reindex poll before the refetch.)
    await expect(notice).toContainText("the listing could not be reloaded", { timeout: 15_000 });
    await expect(notice).toContainText(`Deleted "${DOC_TITLE}"`);
    await expect(notice).toHaveClass(/err/);
    expect(deletes).toHaveLength(1);
  });
});
