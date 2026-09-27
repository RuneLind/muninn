/**
 * `/wiki/gardener` — the backlog strip's ONE error note.
 *
 * A refused strip action (a 415 from a tab older than the server, a 409 on the
 * gardener mutex) shows `<verb> failed: <server error>` in a `.bk-err` note.
 * The rule this file pins:
 *
 *   - the note survives a poll re-render while the control it names is shown;
 *   - it clears when that control is no longer rendered (a drain settles and
 *     its Cancel button goes), and when a later strip action starts;
 *   - at most one note shows at a time.
 *
 * The verb POSTs reach a REAL muninn: a throwaway bot under `MUNINN_BOTS_DIR`
 * with a wiki-gardener watcher this file seeds and deletes. The 415 is forced
 * by rewriting the request in `page.route` to drop its content type — the
 * request a pre-gate bundle sends. The backlog GET is real too, with three
 * fields patched in (an interrupted run, a live drain's progress, a drainable
 * count), because driving a real drain needs huginn and a model.
 *
 * Playwright runs this file under NODE — hence `postgres`, not `Bun.sql`.
 */

import { test, expect, type Page, type Route } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("gardener-backlog-error");
const DEAD_HUGINN = `http://127.0.0.1:${e2ePort("gardener-backlog-error/dead-huginn")}`;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const BOT = "e2egardenerr";
const USER_ID = "e2e-gardener-backlog-error";
const REFUSED = "This endpoint takes application/json.";

let server: ChildProcess | undefined;
let sql: ReturnType<typeof postgres> | null = null;
let tmpRoot = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "e2e-gardener-err-"));
  const botDir = path.join(tmpRoot, "bots", BOT);
  const wikiDir = path.join(tmpRoot, "wiki");
  mkdirSync(botDir, { recursive: true });
  mkdirSync(wikiDir, { recursive: true });
  writeFileSync(path.join(wikiDir, "index.md"), "# Index\n");
  writeFileSync(path.join(botDir, "CLAUDE.md"), "# throwaway e2e bot\n");
  writeFileSync(path.join(botDir, "config.json"), JSON.stringify({ wikiDir }));

  sql = postgres(TEST_DB, { max: 2, onnotice: () => {} });
  await cleanRows();
  await sql`INSERT INTO users (id, username, display_name, platform)
            VALUES (${USER_ID}, ${USER_ID}, 'E2E Gardener Error', 'web')`;
  // Every backlog verb 404s without a seeded wiki-gardener watcher.
  await sql`INSERT INTO watchers (user_id, bot_name, name, type, config, interval_ms)
            VALUES (${USER_ID}, ${BOT}, 'e2e wiki gardener', 'wiki-gardener', '{}'::jsonb, 604800000)`;

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      MUNINN_BOTS_DIR: path.join(tmpRoot, "bots"),
      KNOWLEDGE_API_URL: DEAD_HUGINN,
      SCHEDULER_ENABLED: "false",
      LOG_DIR: "none",
      [`TELEGRAM_BOT_TOKEN_${BOT.toUpperCase()}`]: "",
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

test.afterAll(async () => {
  server?.kill("SIGTERM");
  try {
    if (sql) await cleanRows();
  } finally {
    await sql?.end();
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  }
});

/** The watcher's snapshots go with it (`ON DELETE CASCADE`). */
async function cleanRows(): Promise<void> {
  await sql!`DELETE FROM watchers WHERE bot_name = ${BOT}`;
  await sql!`DELETE FROM users WHERE id = ${USER_ID}`;
}

type StripState = "banner" | "running" | "settled";

interface Harness {
  /** Which strip the patched GET describes. */
  state: StripState;
  /** Verbs (`backlog-recover`, …) whose POST is sent with no content type. */
  strip: Set<string>;
  /** Verbs answered by the test instead of the server (the run path). */
  fake: Map<string, { status: number; json: unknown }>;
  /** `<verb> → <status>` for every verb POST, in order. */
  seen: string[];
  /** Backlog GETs served, so a wait can prove a poll tick happened. */
  gets: number;
}

async function openStrip(page: Page, h: Harness): Promise<void> {
  await page.route("**/api/wiki/ingest-backlog*", async (route: Route) => {
    // The inspector's per-doc list: unpatched, and possibly still in flight when
    // the test ends.
    if (new URL(route.request().url()).searchParams.has("docs")) {
      await route.continue().catch(() => {});
      return;
    }
    const res = await route.fetch();
    const data = await res.json();
    h.gets += 1;
    data.queued = 5;
    data.remaining = 3;
    data.batchSize = 3;
    data.offeredStillQueued = 2;
    data.interrupted = h.state === "banner" ? { at: Date.now() - 60_000, batchSize: 3, drafted: 1 } : null;
    if (h.state === "running") {
      data.running = true;
      data.progress = {
        stage: "drafting",
        draftsDone: 1,
        draftsTotal: 3,
        startedAt: Date.now() - 30_000,
        cancelRequested: false,
      };
    }
    await route.fulfill({ response: res, json: data });
  });
  await page.route("**/api/wiki/gardener/backlog-*", async (route: Route) => {
    const req = route.request();
    const verb = new URL(req.url()).pathname.split("/").pop()!;
    const fake = h.fake.get(verb);
    if (fake) {
      h.seen.push(`${verb} → ${fake.status} (fake)`);
      await route.fulfill({ status: fake.status, json: fake.json });
      return;
    }
    let res;
    if (h.strip.has(verb)) {
      const headers = { ...req.headers() };
      delete headers["content-type"];
      res = await route.fetch({ headers, postData: "" });
    } else {
      res = await route.fetch();
    }
    h.seen.push(`${verb} → ${res.status()}`);
    await route.fulfill({ response: res });
  });
  await page.goto(`${BASE}/wiki/gardener?bot=${BOT}`);
}

function harness(state: StripState): Harness {
  return { state, strip: new Set(), fake: new Map(), seen: [], gets: 0 };
}

/** The action notes. `.bk-err` is also the strip's own "(some sources
 *  unavailable)" status, which a dead huginn puts there; it is not one. */
const notes = (page: Page) =>
  page.locator("#gardBacklog .bk-err", { hasNotText: "some sources unavailable" });

test("a refused verb shows `<verb> failed: …`, and one note replaces another", async ({ page }) => {
  const h = harness("banner");
  h.strip = new Set(["backlog-recover", "backlog-dismiss", "backlog-run"]);
  await openStrip(page, h);
  await page.locator("#gardBacklog .bk-recover").click();
  await expect(notes(page)).toHaveText([` recover failed: ${REFUSED}`]);

  await page.locator("#gardBacklog .bk-dismiss").click();
  await expect(notes(page)).toHaveText([` dismiss failed: ${REFUSED}`]);

  // The run path draws its own note: it replaces the verb's instead of stacking.
  await page.locator('#gardBacklog [data-backlog-action="confirm"]').click();
  await page.locator("#gardBacklog .bk-start").click();
  await expect.poll(() => h.seen.length).toBe(3);
  await expect(notes(page)).toHaveText([` ${REFUSED}`]);
  // Opening the inspector re-renders the strip; the Drain control is still there.
  await page.locator('#gardBacklog [data-backlog-inspect="drainable"]').click();
  await expect(page.locator("#gardBacklog .bk-inspector-close")).toHaveCount(1);
  await expect(notes(page)).toHaveText([` ${REFUSED}`]);

  // The refusals are the real server's 415s, not a test double.
  expect(h.seen).toEqual(["backlog-recover → 415", "backlog-dismiss → 415", "backlog-run → 415"]);
});

test("the note survives a poll tick while its control shows, and clears when the drain settles", async ({ page }) => {
  const h = harness("running");
  h.strip = new Set(["backlog-cancel"]);
  await openStrip(page, h);
  await page.locator("#gardBacklog .bk-cancel-run").click();
  await expect(notes(page)).toHaveText([` cancel failed: ${REFUSED}`]);

  // The drain poller re-renders every 3 s; the Cancel button is still there.
  const before = h.gets;
  await expect.poll(() => h.gets, { timeout: 8_000 }).toBeGreaterThan(before + 1);
  await expect(page.locator("#gardBacklog .bk-cancel-run")).toHaveCount(1);
  await expect(notes(page)).toHaveText([` cancel failed: ${REFUSED}`]);

  // The drain settles: the Cancel button leaves the strip, and so does its note.
  h.state = "settled";
  // Same render that drops the button; the poller stops after its final refresh.
  await expect(page.locator("#gardBacklog .bk-cancel-run")).toHaveCount(0, { timeout: 10_000 });
  await expect(notes(page)).toHaveCount(0);
  expect(h.seen).toEqual(["backlog-cancel → 415"]);
});

test("a later strip action that succeeds clears the note; a reload shows none", async ({ page }) => {
  const h = harness("banner");
  h.strip = new Set(["backlog-recover", "backlog-reset"]);
  await openStrip(page, h);

  // A successful verb. The banner (Recover's control) stays, so only the
  // success can clear the note.
  await page.locator("#gardBacklog .bk-recover").click();
  await expect(notes(page)).toHaveText([` recover failed: ${REFUSED}`]);
  await page.locator("#gardBacklog .bk-dismiss").click();
  await expect.poll(() => h.seen.at(-1)).toBe("backlog-dismiss → 200");
  await expect(notes(page)).toHaveCount(0);

  // A successful run start. Answered here, since a real `started` would start a
  // drain; `running` is the server's own answer when one is already in flight.
  // Reset's control stays rendered, so only the start of the run can clear it.
  await page.locator("#gardBacklog .bk-reset").click();
  await expect(notes(page)).toHaveText([` reset failed: ${REFUSED}`]);
  h.fake.set("backlog-run", { status: 200, json: { state: "running" } });
  await page.locator('#gardBacklog [data-backlog-action="confirm"]').click();
  await page.locator("#gardBacklog .bk-start").click();
  await expect.poll(() => h.seen.at(-1)).toBe("backlog-run → 200 (fake)");
  await expect(notes(page)).toHaveCount(0);

  // A page refresh starts with no note.
  await page.locator("#gardBacklog .bk-recover").click();
  await expect(notes(page)).toHaveCount(1);
  await page.reload();
  await expect(page.locator("#gardBacklog .bk-recover")).toHaveCount(1);
  await expect(notes(page)).toHaveCount(0);
});
