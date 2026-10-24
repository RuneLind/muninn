/**
 * /wiki rail — the reader's own **work-thread boundaries** (plan
 * `muninn-wiki-work-thread-grouping`, PR 4): Make own thread and Return to its
 * thread, Keep separate and Allow grouping, the Sessions stop (D19) and
 * `▸ split into N sessions`, Save as series with a write that lands and one
 * the route refuses (`k of N written`), the reverse through today's series
 * menu, a read-only wiki's row ⋯, two tabs, Reset, refused storage, reload
 * persistence, incomplete contributions and independent wiki settings.
 *
 * ONE muninn, TWELVE temp wikis, ONE fake `node:http` claude-usage:
 *
 *  - `wsbound` — thread T: `t-key` (b1, b2), `t-split` (b0, b1; b2 only
 *    touched it), `t-rest` (b2), one thread through the shared sessions; the RELATED pair
 *    `live-a` ↔ `live-b` (one session each, `related:`); a lone note.
 *  - `wsboundro` — the same files under `WIKI_READONLY_ROOTS`.
 *  - `wsbseries`, `wsbrefuse` — the related pair and the note only, for the
 *    two Save as series cases (each writes its own temp files).
 *  - `wsbcap` — four newer lone notes ahead of the related pair, so the pair
 *    is the fifth card (D20: the cap counts base cards).
 *  - `wsbcapf` — four busier lone plans ahead of a task thread whose key and
 *    rest pages sit in `drafts/`, so under `folder=plans` the thread is the
 *    fifth card showing two rows, `t-split` and `t-more`.
 *  - `wsbtwin` — the pair with an `.html` twin of `live-a` as the only page
 *    its session wrote (the twin's family, so `live-a` is the focus page);
 *    `wsbstale`, `wsbslow`, `wsbslowfail`, `wsbnorefresh`, `wsbgone`,
 *    `wsbcleared`, `wsbabort`, `wsbretry`, `wsbthrow` — the pair again, one per Save as
 *    series lifecycle case; `wsbtwinslow` — the pair, `live-a`'s session also
 *    writing a standalone `.html` (no markdown parent), whose row carries the
 *    row's own ⋯.
 *
 * Synthetic names only (D11: no NAV data). No model calls; the only wiki
 * writes are Save as series on the synthetic series wikis.
 *
 * SPAWN ENV: `e2eEnv()` blanks `CLAUDE_USAGE_URL`, so it is set AFTER it.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { workGroupKey } from "../src/dashboard/views/components/wiki-work-group-record.ts";

const PORT = e2ePort("wiki-rail-thread-boundaries");
const LEDGER_PORT = e2ePort("wiki-rail-thread-boundaries/ledger");
const BASE = `http://127.0.0.1:${PORT}`;
const LEDGER_BASE = `http://127.0.0.1:${LEDGER_PORT}`;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const B = "wsbound";
const BRO = "wsboundro";
const S = "wsbseries";
const R = "wsbrefuse";
const C = "wsbcap";
const CF = "wsbcapf";
/** Fix round 1 batch 2: an `.html`-twin child, a concurrent series writer,
 *  and the popover's lifecycle during a write. One wiki per writing test. */
const TW = "wsbtwin";
const ST = "wsbstale";
const SL = "wsbslow";
const SF = "wsbslowfail";
const NR = "wsbnorefresh";
const NG = "wsbgone";
const CL = "wsbcleared";
/** Fix round 2 batch 2: a network error mid-write, refusals the reader
 *  resolves in place, and other ⋯ openers during a held write. */
const AB = "wsbabort";
const RT = "wsbretry";
const TWS = "wsbtwinslow";
const TH = "wsbthrow";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();

const TKEY = "plans/t-key.md";
const TSPLIT = "plans/t-split.md";
const TREST = "plans/t-rest.md";
const LA = "plans/live-a.md";
const LB = "plans/live-b.md";
const LONE = "notes/lone.md";
const LAH = "plans/live-a.html";
/** An `.html` with no markdown parent: a focus page of its own. */
const LXH = "plans/live-notes.html";
const OTHER = "notes/other.md";
const BUSY = [1, 2, 3, 4].map((i) => `notes/busy-${i}.md`);
const BUSYP = [1, 2, 3, 4].map((i) => `plans/busy-${i}.md`);
const FKEY = "drafts/t-key.md";
const FREST = "drafts/t-rest.md";
const FMORE = "plans/t-more.md";

/** Per wiki: each session's focus pages, newest session first (b0 is 1 h ago). */
const SESSIONS: Record<string, string[][]> = {
  [B]: [[TSPLIT], [TKEY, TSPLIT], [TREST, TKEY], [LA], [LB], [LONE]],
  [BRO]: [[TSPLIT], [TKEY, TSPLIT], [TREST, TKEY], [LA], [LB], [LONE]],
  [S]: [[LA], [LB], [LONE]],
  [R]: [[LA], [LB], [LONE]],
  [C]: [...BUSY.map((p) => [p]), [LA], [LB]],
  // Four sessions on each busy plan (newest), then the task thread, then the pair.
  [CF]: [...[1, 2, 3, 4].flatMap(() => BUSYP.map((p) => [p])), [TSPLIT], [FKEY, TSPLIT], [FREST, FKEY], [FMORE, FREST], [LA], [LB]],
  [TW]: [[LAH], [LB], [LONE]],
  [ST]: [[LA], [LB], [LONE]],
  [SL]: [[LA], [LB], [LONE]],
  [SF]: [[LA], [LB], [LONE]],
  [NR]: [[LA], [LB], [LONE]],
  [NG]: [[LA], [LB], [LONE]],
  [CL]: [[LA], [LB], [LONE]],
  [AB]: [[LA], [LB], [LONE]],
  [RT]: [[LA], [LB], [LONE]],
  [TH]: [[LA], [LB], [LONE]],
  [TWS]: [[LA, LXH], [LB], [LONE]],
};

/** Per wiki: pages a session only TOUCHED (one edit, unnamed), by session
 *  index. b2 touches t-split after b0 and b1 first worked on it, so the touch
 *  is not the page's earliest edit (the created rule) and stays a touch row on
 *  T's focus page: a split of t-split must not count b2 (fix round 1, batch 6). */
const TOUCHES: Record<string, Record<number, string[]>> = {
  [B]: { 2: [TSPLIT] },
};

const roots: Record<string, string> = {};
let server: ChildProcess | undefined;
let ledger: Server | undefined;

function ledgerAnswer(res: import("node:http").ServerResponse, url: URL): void {
  const root = url.searchParams.get("root") ?? "";
  const wiki = Object.keys(roots).find((k) => roots[k] === root);
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const spec = (wiki && SESSIONS[wiki]) || [];
  if (url.searchParams.get("sessions") === "1") {
    if (!spec.length) return json({ error: "not found" }, 404);
    const sessions = spec.map((focus, i) => {
      const at = NOW - (i + 1) * HOUR;
      return {
        id: `b${i}`,
        provider: "claude",
        title: `session b${i}`,
        first: at - 30 * 60_000,
        last: at,
        bulk: false,
        text: { from: "prompt", paths: focus, links: [], files: [] },
        files: [
          ...focus.map((p) => ({ p, edits: 5, firstMs: at - 30 * 60_000, lastMs: at })),
          ...(TOUCHES[wiki!]?.[i] ?? []).map((p) => ({ p, edits: 1, firstMs: NOW - 20 * 60_000, lastMs: NOW - 10 * 60_000 })),
        ],
      };
    });
    const since = Number(url.searchParams.get("since"));
    const until = url.searchParams.has("until") ? Number(url.searchParams.get("until")) : Date.now();
    return json({ form: "sessions", root, since, until, limit: 200, truncated: false, sessions });
  }
  const until = url.searchParams.get("until");
  if (until) return json({ root, pages: [], pageCount: 0, bulk: 10, limit: 5000, truncated: false, until: Number(until) });
  const pages = [...new Set(spec.flat())].map((p, i) => ({ p, w: NOW - (i + 1) * HOUR, s: 1 }));
  json({ root, pages, pageCount: pages.length, bulk: 10, limit: 5000, truncated: false });
}

function startLedger(): Promise<Server> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/api/files") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected path" }));
      return;
    }
    ledgerAnswer(res, url);
  });
  return new Promise((resolve) => srv.listen(LEDGER_PORT, "127.0.0.1", () => resolve(srv)));
}

async function makeRoot(name: string, withTask: boolean, busy = false, twin = false): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-bounds-${name}-`));
  roots[name] = root;
  await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify({ activity: { agePenalty: 0, hubPenalty: 0, planBoost: 0, rows: 8 } }), "utf8");
  const write = async (rel: string, fm: string[], ago: number) => {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, ["---", ...fm, "created: 2025-01-01", "---", "", "Body.", ""].join("\n"), "utf8");
    const stamp = new Date(NOW - ago);
    await utimes(abs, stamp, stamp);
  };
  if (withTask) {
    await write(TKEY, ["title: Task key"], 2 * HOUR);
    await write(TSPLIT, ["title: Task split"], HOUR);
    await write(TREST, ["title: Task rest"], 3 * HOUR);
  }
  await write(LA, ["title: Living facts", "plan_status: active", "status_date: 2026-10-14"], 4 * HOUR);
  await write(LB, ["title: Reader lenses", "plan_status: active", "status_date: 2026-10-10", `related: ["[[${twin ? "plans/live-a.html" : "plans/live-a"}]]"]`], 5 * HOUR);
  if (twin) await writeFile(path.join(root, LAH), "<!doctype html><title>Living facts page</title><p>Twin.</p>\n", "utf8");
  if (name === TWS) await writeFile(path.join(root, LXH), "<!doctype html><title>Living notes page</title><p>Notes.</p>\n", "utf8");
  if (name === ST) await write(OTHER, ["title: Other note", "series: other"], 7 * HOUR);
  await write(LONE, ["title: Lone note", "type: note"], 6 * HOUR);
  for (let i = 1; i <= 3; i++) await write(`notes/old-${i}.md`, [`title: Old ${i}`], (10 + i) * DAY);
  if (busy) for (const [i, rel] of BUSY.entries()) await write(rel, [`title: Busy ${i + 1}`, "type: note"], (i + 1) * 60_000);
}

/** `wsbcapf`: the busy plans, the task thread with its key and rest in
 *  `drafts/`, the related pair. */
async function makeFolderCapRoot(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-bounds-${CF}-`));
  roots[CF] = root;
  await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify({ activity: { agePenalty: 0, hubPenalty: 0, planBoost: 0, rows: 8 } }), "utf8");
  const write = async (rel: string, fm: string[], ago: number) => {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, ["---", ...fm, "created: 2025-01-01", "---", "", "Body.", ""].join("\n"), "utf8");
    const stamp = new Date(NOW - ago);
    await utimes(abs, stamp, stamp);
  };
  await write(FKEY, ["title: Task key"], 2 * HOUR);
  await write(TSPLIT, ["title: Task split"], HOUR);
  await write(FREST, ["title: Task rest"], 3 * HOUR);
  await write(FMORE, ["title: Task more"], 3 * HOUR);
  await write(LA, ["title: Living facts"], 4 * HOUR);
  await write(LB, ["title: Reader lenses", `related: ["[[plans/live-a]]"]`], 5 * HOUR);
  for (const [i, rel] of BUSYP.entries()) await write(rel, [`title: Busy ${i + 1}`], (i + 1) * 60_000);
}

const card = (page: Page, rel: string) => page.locator(`#wikiList .wiki-thread-card[data-thread="thread:${rel}"]`);
const groupCard = (page: Page, key: string) => page.locator(`#wikiList .wiki-thread-card[data-thread-group="${key}"]`);
const threadRow = (page: Page, rel: string) => page.locator(`#wikiList .wiki-list-item.thread-row[data-relpath="${rel}"]`);
const groupBtn = (page: Page) => page.locator("[data-work-group-menu]");
const stored = (page: Page, wiki = B) => page.evaluate((k) => localStorage.getItem(k), workGroupKey(wiki));
const record = async (page: Page, wiki = B) => JSON.parse((await stored(page, wiki)) ?? "null");
const topKeys = (page: Page) =>
  page.locator("#wikiList > .wiki-thread-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-thread-group") ?? e.getAttribute("data-thread")));

async function openReader(page: Page, wiki: string = B): Promise<void> {
  await fetch(`${BASE}/api/wiki/pages?wiki=${wiki}&refresh=1`);
  const listing = page.waitForResponse((r) => r.url().includes("/api/wiki/pages") && r.url().includes(`wiki=${wiki}`) && r.ok());
  await page.goto(`${BASE}/wiki?wiki=${wiki}`);
  await listing;
  await expect(page.locator('.wiki-list-sec[data-section="activity"]')).toHaveCount(1);
}

/** Open a focus row's ⋯ (the series opener on a writable wiki, the row's own
 *  opener on a read-only one), revealed by the row's hover. */
async function rowMenu(page: Page, rel: string): Promise<void> {
  await threadRow(page, rel).hover();
  await threadRow(page, rel).locator("[data-series-menu], [data-thread-row-menu]").click();
}

/** Click a ⋯ opener once it is still in view. Its popover closes on a scroll
 *  that moves the opener; settling the scroll first keeps the click's own
 *  scroll out of the way. */
async function openMenu(loc: ReturnType<Page["locator"]>): Promise<void> {
  await loc.scrollIntoViewIfNeeded();
  await loc.page().waitForTimeout(150);
  await loc.click();
  await expect(loc.page().locator("#wikiWorkPop")).toHaveCount(1);
}

async function stop(page: Page, s: string): Promise<void> {
  await groupBtn(page).click();
  await page.locator(`[data-work-stop="${s}"]`).click();
  await expect(groupBtn(page)).toContainText(s[0]!.toUpperCase() + s.slice(1));
}

test.beforeAll(async () => {
  await makeRoot(B, true);
  await makeRoot(BRO, true);
  await makeRoot(S, false);
  await makeRoot(R, false);
  await makeRoot(C, false, true);
  await makeFolderCapRoot();
  await makeRoot(TW, false, false, true);
  await makeRoot(TWS, false);
  for (const w of [ST, SL, SF, NR, NG, CL, AB, RT, TH]) await makeRoot(w, false);
  ledger = await startLedger();
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: Object.entries(roots)
        .map(([name, root]) => `${name}=${root}`)
        .join(","),
      WIKI_READONLY_ROOTS: roots[BRO]!,
      CLAUDE_USAGE_URL: LEDGER_BASE,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/wiki/pages?wiki=${B}`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
  const want: Record<string, number> = { [B]: 4, [BRO]: 4, [S]: 3, [R]: 3, [C]: 6, [CF]: 7, [TW]: 3, [ST]: 3, [SL]: 3, [SF]: 3, [NR]: 3, [NG]: 3, [CL]: 3, [AB]: 3, [RT]: 3, [TH]: 3, [TWS]: 3 };
  for (const wiki of Object.keys(want)) {
    const warm = Date.now() + 20_000;
    for (;;) {
      const b = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${wiki}&refresh=1`)).json()) as { work?: { threads: unknown[]; evidence?: unknown } };
      if (b.work?.threads.length === want[wiki]! && b.work?.evidence) break;
      if (Date.now() > warm) throw new Error(`the work-sessions memo never warmed for ${wiki}: ${JSON.stringify(b.work?.threads)}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise<void>((resolve) => (ledger ? ledger.close(() => resolve()) : resolve()));
  for (const root of Object.values(roots)) await rm(root, { recursive: true, force: true });
});

test.describe("Wiki rail: work-thread boundaries", () => {
  test("the fixture: one task thread of three pages, a RELATED pair, a lone note", async ({ page }) => {
    await openReader(page);
    expect(await topKeys(page)).toEqual([`thread:${TKEY}`, `group:anchor:${LA}`, `thread:${LONE}`]);
    await expect(card(page, TKEY).locator(".wiki-thread-meta")).toContainText("3 sessions");
  });

  test("Make own thread: the page gets its own card with exactly its sessions; reload keeps it; Return to its thread restores the thread", async ({ page }) => {
    await openReader(page);
    await rowMenu(page, TSPLIT);
    const item = page.locator("#wikiSeriesMenu [data-thread-split]");
    await expect(item).toContainText("Make own thread");
    // The opener is a page menu now that it holds both.
    await expect(threadRow(page, TSPLIT).locator("[data-series-menu]")).toHaveAttribute("aria-label", "Page menu");
    await item.click();
    await expect(card(page, TSPLIT)).toHaveCount(1);
    await expect(card(page, TSPLIT).locator(".wiki-thread-chip-own")).toHaveText("own thread");
    await expect(card(page, TSPLIT).locator(".wiki-thread-meta")).toContainText("2 sessions");
    // The remainder keeps its key (t-key is still its earliest page), two sessions.
    await expect(card(page, TKEY).locator(".wiki-thread-meta")).toContainText("2 sessions");
    const rec = await record(page);
    expect(rec.splits).toHaveLength(1);
    expect(rec.splits[0]).toMatchObject({ page: TSPLIT });
    expect(rec.splits[0].id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    // One home: t-split is a row in its own card only.
    await card(page, TSPLIT).locator(".wiki-thread-fold").click();
    await expect(threadRow(page, TSPLIT)).toHaveCount(1);
    await page.reload();
    await expect(card(page, TSPLIT).locator(".wiki-thread-chip-own")).toHaveText("own thread");
    // Return from the card's ⋯ (Related).
    await openMenu(card(page, TSPLIT).locator("[data-work-card-menu]"));
    await page.locator("#wikiWorkPop [data-work-return]").click();
    await expect(card(page, TSPLIT)).toHaveCount(0);
    await expect(card(page, TKEY).locator(".wiki-thread-meta")).toContainText("3 sessions");
    expect((await record(page)).splits).toBeUndefined();
  });

  test("splitting the thread's key page: the remainder takes the next earliest page as its key (a new fold key)", async ({ page }) => {
    await openReader(page);
    await rowMenu(page, TKEY);
    await page.locator("#wikiSeriesMenu [data-thread-split]").click();
    await expect(card(page, TKEY).locator(".wiki-thread-chip-own")).toHaveText("own thread");
    await expect(card(page, TKEY).locator(".wiki-thread-meta")).toContainText("2 sessions");
    // b2's t-rest event is the remainder's earliest.
    await expect(card(page, TREST)).toHaveCount(1);
    await expect(card(page, TREST).locator(".wiki-thread-meta")).toContainText("3 sessions");
  });

  test("Keep separate dissolves a group and persists; Allow grouping lets it form again", async ({ page }) => {
    await openReader(page);
    await groupCard(page, `group:anchor:${LA}`).locator(".wiki-thread-fold").click();
    const lb = page.locator(`.wiki-thread-gbody .wiki-thread-card[data-thread="thread:${LB}"]`);
    await openMenu(lb.locator("[data-work-card-menu]"));
    await page.locator("#wikiWorkPop [data-work-keep]").click();
    await expect(groupCard(page, `group:anchor:${LA}`)).toHaveCount(0);
    await expect(card(page, LB).locator(".wiki-thread-chip-own")).toHaveText("kept separate");
    expect((await record(page)).keptApart).toEqual([LB]);
    await page.reload();
    await expect(card(page, LB).locator(".wiki-thread-chip-own")).toHaveText("kept separate");
    await openMenu(card(page, LB).locator("[data-work-card-menu]"));
    await page.locator("#wikiWorkPop [data-work-allow]").click();
    await expect(groupCard(page, `group:anchor:${LA}`)).toHaveCount(1);
    expect((await record(page)).keptApart).toBeUndefined();
  });

  test("Keep separate on a child of the FIFTH card: the thread stays drawn in that card's place with its chip, and Allow grouping is reachable (D20)", async ({ page }) => {
    await openReader(page, C);
    const busy = BUSY.map((rel) => `thread:${rel}`);
    await expect.poll(() => topKeys(page)).toEqual([...busy, `group:anchor:${LA}`]);
    await groupCard(page, `group:anchor:${LA}`).locator(".wiki-thread-fold").click();
    await openMenu(page.locator(`.wiki-thread-gbody .wiki-thread-card[data-thread="thread:${LB}"] [data-work-card-menu]`));
    await page.locator("#wikiWorkPop [data-work-keep]").click();
    // The group dissolved; the kept-apart thread draws in the fifth card's place.
    await expect.poll(() => topKeys(page)).toEqual([...busy, `thread:${LA}`, `thread:${LB}`]);
    await expect(card(page, LB).locator(".wiki-thread-chip-own")).toHaveText("kept separate");
    expect((await record(page, C)).keptApart).toEqual([LB]);
    await openMenu(card(page, LB).locator("[data-work-card-menu]"));
    await page.locator("#wikiWorkPop [data-work-allow]").click();
    await expect.poll(() => topKeys(page)).toEqual([...busy, `group:anchor:${LA}`]);
    expect((await record(page, C)).keptApart).toBeUndefined();
  });

  test("Make own thread on both visible pages of the fifth card, a facet hiding the rest of its thread: both stay drawn in that card's place (D20)", async ({ page }) => {
    await openReader(page, CF);
    // The thread's key is t-rest: its earliest focus event, in the oldest session.
    await page.locator("#wikiFilters").evaluate((el) => ((el as HTMLDetailsElement).open = true));
    await page.selectOption("#wikiFolder", "plans");
    const busy = BUSYP.map((rel) => `thread:${rel}`);
    await expect.poll(() => topKeys(page)).toEqual([...busy, `thread:${FREST}`]);
    await card(page, FREST).locator(".wiki-thread-fold").click();
    await rowMenu(page, TSPLIT);
    await page.locator("#wikiSeriesMenu [data-thread-split]").click();
    await expect.poll(() => topKeys(page)).toEqual([...busy, `thread:${FREST}`, `thread:${TSPLIT}`]);
    // The second split leaves the remainder (key and rest, both in drafts/)
    // no row under the facet: both split pages hold the fifth card's place,
    // and the related pair stays cut.
    await rowMenu(page, FMORE);
    await page.locator("#wikiSeriesMenu [data-thread-split]").click();
    await expect.poll(() => topKeys(page)).toEqual([...busy, `thread:${TSPLIT}`, `thread:${FMORE}`]);
    await expect(card(page, FMORE).locator(".wiki-thread-chip-own")).toHaveText("own thread");
    await expect(groupCard(page, `group:anchor:${LA}`)).toHaveCount(0);
    expect((await record(page, CF)).splits.map((x: { page: string }) => x.page)).toEqual([TSPLIT, FMORE]);
    // Return to its thread from the card's ⋯: the page is back in the remainder, in the same place.
    await openMenu(card(page, FMORE).locator("[data-work-card-menu]"));
    await page.locator("#wikiWorkPop [data-work-return]").click();
    await expect.poll(() => topKeys(page)).toEqual([...busy, `thread:${FREST}`, `thread:${TSPLIT}`]);
  });

  test("the Sessions stop (D19): one card per session, newest first; a page two sessions focused is one row and one also in: link", async ({ page }) => {
    await openReader(page);
    await stop(page, "sessions");
    const cards = page.locator("#wikiList > .wiki-thread-card");
    await expect(cards).toHaveCount(5);
    await expect(cards.first()).toHaveAttribute("data-thread", "session:claude-code:b0");
    await expect(cards.first().locator(".wiki-thread-name")).toHaveText("session b0");
    await expect(cards.first().locator(".wiki-thread-pin")).toHaveCount(0);
    // b1 focused t-key and t-split; b0 (newer) owns t-split.
    await page.locator('#wikiList .wiki-thread-card[data-thread="session:claude-code:b1"] .wiki-thread-fold').click();
    await expect(threadRow(page, TSPLIT)).toHaveCount(1);
    await expect(threadRow(page, TKEY)).toHaveCount(1);
    await expect(page.locator('.wiki-thread-also-in[data-thread="session:claude-code:b1"] .wiki-thread-link')).toHaveText(["Task split"]);
    // No Make own thread on a session card's row.
    await rowMenu(page, TKEY);
    await expect(page.locator("#wikiSeriesMenu [data-thread-split]")).toHaveCount(0);
    expect((await record(page)).stop).toBe("sessions");
  });

  test("▸ split into N sessions shows the thread's rows under each session without changing the stop", async ({ page }) => {
    await openReader(page);
    const btn = page.locator(`[data-thread-sessions="thread:${TKEY}"]`);
    await expect(btn).toContainText("split into 3 sessions");
    await expect(btn).toHaveAttribute("aria-expanded", "false");
    await btn.click();
    await expect(page.locator(".wiki-thread-session")).toHaveCount(3);
    await expect(btn).toHaveAttribute("aria-expanded", "true");
    for (const rel of [TKEY, TSPLIT, TREST]) await expect(threadRow(page, rel)).toHaveCount(1);
    await expect(groupBtn(page)).toContainText("Related");
    await btn.click();
    await expect(page.locator(".wiki-thread-session")).toHaveCount(0);
  });

  test("a read-only wiki: the row ⋯ is its own opener holding Make own thread only, the split works, and no group offers Save as series", async ({ page }) => {
    await openReader(page, BRO);
    await expect(threadRow(page, TSPLIT).locator("[data-series-menu]")).toHaveCount(0);
    await expect(threadRow(page, TSPLIT).locator("[data-thread-row-menu]")).toHaveCount(1);
    await rowMenu(page, TSPLIT);
    await expect(page.locator("#wikiWorkPop [role=menuitem]")).toHaveCount(1);
    await page.locator("#wikiWorkPop [data-thread-split]").click();
    await expect(card(page, TSPLIT).locator(".wiki-thread-chip-own")).toHaveText("own thread");
    expect((await record(page, BRO)).splits).toHaveLength(1);
    await expect(groupCard(page, `group:anchor:${LA}`).locator("> .wiki-thread-acts [data-work-card-menu]")).toHaveCount(0);
    // Independent wiki settings: the writable copy holds nothing.
    expect(await stored(page, B)).toBeNull();
  });

  test("two tabs: a split in one and a kept-apart thread in the other both stay", async ({ context }) => {
    const a = await context.newPage();
    const b = await context.newPage();
    await openReader(a);
    await openReader(b);
    await rowMenu(a, TSPLIT);
    await a.locator("#wikiSeriesMenu [data-thread-split]").click();
    await expect(card(b, TSPLIT)).toHaveCount(1);
    await groupCard(b, `group:anchor:${LA}`).locator(".wiki-thread-fold").click();
    await openMenu(b.locator(`.wiki-thread-gbody .wiki-thread-card[data-thread="thread:${LB}"] [data-work-card-menu]`));
    await b.locator("#wikiWorkPop [data-work-keep]").click();
    await expect(card(a, LB).locator(".wiki-thread-chip-own")).toHaveText("kept separate");
    const rec = await record(a);
    expect(rec.splits.map((x: { page: string }) => x.page)).toEqual([TSPLIT]);
    expect(rec.keptApart).toEqual([LB]);
  });

  test("two tabs: a split one tab could not store survives the other tab's write and lands on its list once storage takes it (T4)", async ({ context }) => {
    const a = await context.newPage();
    const b = await context.newPage();
    // A's storage refuses the record until the test lets it through; A counts
    // as focused, so its next render may retry (R6).
    await a.addInitScript(([k]) => {
      const w = window as unknown as { __refuse: boolean };
      w.__refuse = true;
      document.hasFocus = () => true;
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === k && w.__refuse) throw new DOMException("quota", "QuotaExceededError");
        return set.call(this, key, value);
      };
    }, [workGroupKey(B)] as const);
    await openReader(a);
    await openReader(b);
    await rowMenu(a, TSPLIT);
    await a.locator("#wikiSeriesMenu [data-thread-split]").click();
    await expect(a.locator(".wiki-work-local")).toHaveText("this tab only");
    await groupCard(b, `group:anchor:${LA}`).locator(".wiki-thread-fold").click();
    await openMenu(b.locator(`.wiki-thread-gbody .wiki-thread-card[data-thread="thread:${LB}"] [data-work-card-menu]`));
    await b.locator("#wikiWorkPop [data-work-keep]").click();
    // A heard B's write: it shows B's kept-apart thread AND its own split.
    await expect(card(a, LB).locator(".wiki-thread-chip-own")).toHaveText("kept separate");
    await expect(card(a, TSPLIT).locator(".wiki-thread-chip-own")).toHaveText("own thread");
    await expect(a.locator(".wiki-work-local")).toHaveText("this tab only");
    await a.evaluate(() => ((window as unknown as { __refuse: boolean }).__refuse = false));
    // Any focused render retries: open and close the Group menu.
    await groupBtn(a).click();
    await a.keyboard.press("Escape");
    await expect(a.locator(".wiki-work-local")).toHaveCount(0);
    const rec = await record(b);
    expect(rec.splits.map((x: { page: string }) => x.page)).toEqual([TSPLIT]);
    expect(rec.keptApart).toEqual([LB]);
    await expect(card(b, TSPLIT).locator(".wiki-thread-chip-own")).toHaveText("own thread");
  });

  test("Reset your splits and groups (N) lists what does not apply and restores D1", async ({ page }) => {
    await page.addInitScript(([k]) => {
      if (localStorage.getItem("__seeded")) return;
      localStorage.setItem("__seeded", "1");
      localStorage.setItem(k!, JSON.stringify({ version: 1, stop: "threads", splits: [{ id: "a1", page: "plans/t-split.md" }, { id: "a2", page: "plans/gone.md" }], keptApart: ["notes/lone.md"] }));
    }, [workGroupKey(B)] as const);
    await openReader(page);
    await expect(card(page, TSPLIT)).toHaveCount(1);
    await groupBtn(page).click();
    const reset = page.locator("[data-work-reset]");
    await expect(reset).toContainText("Reset your splits and groups (3)");
    await expect(page.locator(".wiki-work-def")).toHaveText(["Own thread: plans/gone.md — the page is gone"]);
    await reset.click();
    await expect(page.locator(".wiki-work-menu")).toHaveCount(0);
    expect(await record(page)).toEqual({ version: 1 });
    await expect(groupBtn(page)).toContainText("Related");
    await expect(card(page, TSPLIT)).toHaveCount(0);
  });

  test("Reset keeps what this build does not read and a split another tab wrote since the menu opened", async ({ page }) => {
    await page.addInitScript(([k]) => {
      if (localStorage.getItem("__seeded")) return;
      localStorage.setItem("__seeded", "1");
      const record = {
        version: 1,
        stop: "threads",
        evidence: { series: false, future: 1 },
        splits: [{ id: "a1", page: "plans/t-split.md" }, { weird: true }],
        keptApart: ["notes/lone.md", 7],
        extra: "kept",
      };
      localStorage.setItem(k!, JSON.stringify(record));
    }, [workGroupKey(B)] as const);
    await openReader(page);
    await expect(card(page, TSPLIT)).toHaveCount(1);
    await groupBtn(page).click();
    // Another tab's write: a same-page setItem fires no storage event here.
    await page.evaluate((k) => {
      const r = JSON.parse(localStorage.getItem(k)!);
      r.splits.push({ id: "other", page: "gone/other.md" });
      localStorage.setItem(k, JSON.stringify(r));
    }, workGroupKey(B));
    await page.locator("[data-work-reset]").click();
    expect(await record(page)).toEqual({ version: 1, evidence: { future: 1 }, splits: [{ weird: true }, { id: "other", page: "gone/other.md" }], keptApart: [7], extra: "kept" });
    await expect(groupBtn(page)).toContainText("Related");
    await expect(card(page, TSPLIT)).toHaveCount(0);
  });

  test("at 100 splits and 50 kept-apart threads, Make own thread and Keep separate show unavailable with the reason, and a click writes nothing", async ({ page }) => {
    // Fix round 1, batch 3: the bounds are refused at write, so the menu says so.
    await page.addInitScript(([k]) => {
      if (localStorage.getItem("__seeded")) return;
      localStorage.setItem("__seeded", "1");
      const splits = Array.from({ length: 100 }, (_, i) => ({ id: `g${i}`, page: `gone/s-${i}.md` }));
      const keptApart = Array.from({ length: 50 }, (_, i) => `gone/k-${i}.md`);
      localStorage.setItem(k!, JSON.stringify({ version: 1, splits, keptApart }));
    }, [workGroupKey(B)] as const);
    await openReader(page);
    const before = await stored(page);
    await rowMenu(page, TSPLIT);
    const split = page.locator("#wikiSeriesMenu [data-thread-split]");
    await expect(split).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("#wikiSeriesMenu #wikiWorkPopWhy")).toHaveText("Unavailable: you have 100 splits; return some to their threads or forget some under Reset your splits and groups in the Work threads ▾ menu");
    await split.click({ force: true });
    await expect(card(page, TSPLIT)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await groupCard(page, `group:anchor:${LA}`).locator(".wiki-thread-fold").click();
    const lb = page.locator(`.wiki-thread-gbody .wiki-thread-card[data-thread="thread:${LB}"]`);
    await openMenu(lb.locator("[data-work-card-menu]"));
    const keep = page.locator("#wikiWorkPop [data-work-keep]");
    await expect(keep).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("#wikiWorkPop #wikiWorkPopWhy")).toHaveText("Unavailable: you keep 50 threads separate; allow grouping on some or forget some under Reset your splits and groups in the Work threads ▾ menu");
    await keep.click({ force: true });
    await expect(groupCard(page, `group:anchor:${LA}`)).toHaveCount(1);
    expect(await stored(page)).toBe(before);
  });

  test("Make own thread offered at 99 splits, then another tab takes the 100th: the click says why it did nothing", async ({ page }) => {
    await page.addInitScript(([k]) => {
      if (localStorage.getItem("__seeded")) return;
      localStorage.setItem("__seeded", "1");
      const splits = Array.from({ length: 99 }, (_, i) => ({ id: `g${i}`, page: `gone/s-${i}.md` }));
      localStorage.setItem(k!, JSON.stringify({ version: 1, splits }));
    }, [workGroupKey(B)] as const);
    await openReader(page);
    await rowMenu(page, TSPLIT);
    const split = page.locator("#wikiSeriesMenu [data-thread-split]");
    await expect(split).not.toHaveAttribute("aria-disabled", "true");
    // Another tab's write: a same-page setItem fires no storage event here.
    await page.evaluate((k) => {
      const r = JSON.parse(localStorage.getItem(k)!);
      r.splits.push({ id: "other", page: "gone/other.md" });
      localStorage.setItem(k, JSON.stringify(r));
    }, workGroupKey(B));
    await split.click();
    // Its own note, never Save as series' report line.
    const note = page.locator("#wikiWorkBoundaryStatus");
    await expect(note).toHaveText("Make own thread did nothing: you have 100 splits; return some to their threads or forget some under Reset your splits and groups in the Work threads ▾ menu");
    await expect(page.locator("#wikiWorkSeriesStatus")).toHaveCount(0);
    await expect(card(page, TSPLIT)).toHaveCount(0);
    expect((await record(page)).splits).toHaveLength(100);
    // The next boundary edit that lands clears the note (fix round 2, batch 3).
    await groupCard(page, `group:anchor:${LA}`).locator(".wiki-thread-fold").click();
    await openMenu(page.locator(`.wiki-thread-gbody .wiki-thread-card[data-thread="thread:${LB}"] [data-work-card-menu]`));
    await page.locator("#wikiWorkPop [data-work-keep]").click();
    await expect(card(page, LB).locator(".wiki-thread-chip-own")).toHaveText("kept separate");
    await expect(note).toHaveCount(0);
  });

  test("a stale tab's Allow grouping removes only the anchor it showed: another tab's newer anchor on the thread's page stays (fix round 2, batch 3)", async ({ page }) => {
    await page.addInitScript(([k]) => {
      if (localStorage.getItem("__seeded")) return;
      localStorage.setItem("__seeded", "1");
      localStorage.setItem(k!, JSON.stringify({ version: 1, keptApart: ["plans/t-split.md"] }));
    }, [workGroupKey(B)] as const);
    await openReader(page);
    await expect(card(page, TKEY).locator(".wiki-thread-chip-own")).toHaveText("kept separate");
    await openMenu(card(page, TKEY).locator("[data-work-card-menu]"));
    // Another tab made t-key its own thread and kept it separate; a same-page
    // setItem fires no storage event here, so this tab still draws T whole.
    await page.evaluate((k) => {
      localStorage.setItem(k, JSON.stringify({ version: 1, keptApart: ["plans/t-split.md", "plans/t-key.md"], splits: [{ id: "s1", page: "plans/t-key.md" }] }));
    }, workGroupKey(B));
    await page.locator("#wikiWorkPop [data-work-allow]").click();
    expect(await record(page)).toEqual({ version: 1, keptApart: [TKEY], splits: [{ id: "s1", page: TKEY }] });
    await expect(card(page, TKEY).locator(".wiki-thread-chip-own")).toHaveText("own thread");
  });

  test("a stale tab's Reset removes only the anchor it showed: another tab's newer anchor and split stay (fix round 2, batch 3)", async ({ page }) => {
    await page.addInitScript(([k]) => {
      if (localStorage.getItem("__seeded")) return;
      localStorage.setItem("__seeded", "1");
      localStorage.setItem(k!, JSON.stringify({ version: 1, keptApart: ["plans/t-split.md"] }));
    }, [workGroupKey(B)] as const);
    await openReader(page);
    await expect(card(page, TKEY).locator(".wiki-thread-chip-own")).toHaveText("kept separate");
    await groupBtn(page).click();
    await page.evaluate((k) => {
      localStorage.setItem(k, JSON.stringify({ version: 1, keptApart: ["plans/t-split.md", "plans/t-key.md"], splits: [{ id: "s1", page: "plans/t-key.md" }] }));
    }, workGroupKey(B));
    await page.locator("[data-work-reset]").click();
    expect(await record(page)).toEqual({ version: 1, keptApart: [TKEY], splits: [{ id: "s1", page: TKEY }] });
  });

  test("Forget in the reset area removes that one definition, keeps the menu open, and keeps the rest (fix round 2, batch 3)", async ({ page }) => {
    await page.addInitScript(([k]) => {
      if (localStorage.getItem("__seeded")) return;
      localStorage.setItem("__seeded", "1");
      localStorage.setItem(
        k!,
        JSON.stringify({ version: 1, splits: [{ id: "a1", page: "plans/t-split.md" }, { id: "a2", page: "plans/gone.md" }], keptApart: ["notes/gone-k.md"] }),
      );
    }, [workGroupKey(B)] as const);
    await openReader(page);
    await groupBtn(page).click();
    await expect(page.locator(".wiki-work-def")).toHaveText(["Own thread: plans/gone.md — the page is gone", "Kept separate: notes/gone-k.md — the page is gone"]);
    await page.locator('[data-work-forget-split="a2"]').click();
    expect(await record(page)).toEqual({ version: 1, splits: [{ id: "a1", page: TSPLIT }], keptApart: ["notes/gone-k.md"] });
    await expect(page.locator(".wiki-work-def")).toHaveText(["Kept separate: notes/gone-k.md — the page is gone"]);
    await expect(page.locator("[data-work-reset]")).toContainText("Reset your splits and groups (2)");
    await page.locator('[data-work-forget-anchor="notes/gone-k.md"]').click();
    expect(await record(page)).toEqual({ version: 1, splits: [{ id: "a1", page: TSPLIT }] });
    await expect(page.locator(".wiki-work-def")).toHaveCount(0);
    await expect(card(page, TSPLIT)).toHaveCount(1);
  });

  test("storage refuses the write: the split lives in this tab only and says so; a reload is back on the server's thread", async ({ page }) => {
    await page.addInitScript(([k]) => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === k) throw new DOMException("quota", "QuotaExceededError");
        return set.call(this, key, value);
      };
    }, [workGroupKey(B)] as const);
    await openReader(page);
    await rowMenu(page, TSPLIT);
    await page.locator("#wikiSeriesMenu [data-thread-split]").click();
    await expect(card(page, TSPLIT)).toHaveCount(1);
    await expect(page.locator(".wiki-work-local")).toHaveText("this tab only");
    await page.reload();
    await expect(card(page, TSPLIT)).toHaveCount(0);
  });

  test("contributions incomplete: Make own thread, ▸ split into N sessions and the Sessions stop are unavailable with the reason", async ({ page }) => {
    await page.route(
      (u) => u.pathname === "/api/wiki/pages" && u.searchParams.get("wiki") === B,
      async (route) => {
        const res = await route.fetch();
        const json = (await res.json()) as { work?: { evidence?: { contributions: unknown } } };
        if (json.work?.evidence) json.work.evidence.contributions = { complete: false, reasons: ["ledger-truncated"], cut: [], rows: [] };
        await route.fulfill({ response: res, json });
      },
    );
    await openReader(page);
    await rowMenu(page, TSPLIT);
    const item = page.locator("#wikiSeriesMenu [data-thread-split]");
    await expect(item).toHaveAttribute("aria-disabled", "true");
    await expect(item).toHaveAccessibleDescription("Unavailable: the session ledger was cut short");
    await page.keyboard.press("Escape");
    await expect(page.locator(`[data-thread-sessions="thread:${TKEY}"]`)).toHaveAttribute("aria-disabled", "true");
    await groupBtn(page).click();
    await expect(page.locator('[data-work-stop="sessions"]')).toHaveAttribute("title", "Unavailable: the session ledger was cut short");
  });

  test("Save as series: writes series: on both pages, the group re-forms by the series after the refresh, and today's series menu takes it back", async ({ page }) => {
    await openReader(page, S);
    const g = groupCard(page, `group:anchor:${LA}`);
    await expect(g).toHaveAttribute("class", /open/);
    await openMenu(g.locator("[data-work-card-menu]").first());
    await page.locator("#wikiWorkPop [data-work-save-series]").click();
    const key = page.locator("#wikiWorkPop [data-work-series-key]");
    await expect(key).toHaveValue("live-a");
    await expect(page.locator("#wikiWorkPop .wiki-work-series-child")).toHaveCount(2);
    await page.locator("#wikiWorkPop [data-work-series-go]").click();
    const sg = groupCard(page, "group:series:live-a");
    await expect(sg).toHaveCount(1);
    await expect(sg.locator(".wiki-thread-kind")).toHaveText("series");
    await expect(page.locator("#wikiWorkPop")).toHaveCount(0);
    // The open state moved onto the new fold key.
    await expect(sg).toHaveAttribute("class", /open/);
    for (const rel of [LA, LB]) expect(await readFile(path.join(roots[S]!, rel), "utf8")).toContain("series: live-a");
    // A series-named group offers no Save as series.
    await expect(sg.locator("[data-work-card-menu]")).toHaveCount(0);
    // The reverse is today's series menu, page by page.
    for (const rel of [LA, LB]) {
      const child = page.locator(`.wiki-thread-gbody .wiki-thread-card[data-thread="thread:${rel}"]`);
      if ((await child.count()) && !(await child.getAttribute("class"))!.includes("open")) await child.locator(".wiki-thread-fold").click();
      if (!(await threadRow(page, rel).count())) await card(page, rel).locator(".wiki-thread-fold").click();
      await rowMenu(page, rel);
      const listing = page.waitForResponse((r) => r.url().includes("/api/wiki/pages") && r.url().includes("refresh=1"));
      await page.locator('#wikiSeriesMenu [data-series-cmd="remove"]').click();
      await listing;
    }
    await expect(groupCard(page, `group:anchor:${LA}`)).toHaveCount(1);
    for (const rel of [LA, LB]) expect(await readFile(path.join(roots[S]!, rel), "utf8")).not.toContain("series:");
  });

  test("Save as series, refused on the second page: 1 of 2 written, the written page stays written, and the next offer joins that series", async ({ page }) => {
    let calls = 0;
    await page.route(
      (u) => u.pathname === "/api/wiki/series",
      async (route) => {
        calls++;
        if (calls === 2) return route.fulfill({ status: 409, json: { error: "the page changed (test)" } });
        return route.continue();
      },
    );
    await openReader(page, R);
    const g = groupCard(page, `group:anchor:${LA}`);
    await openMenu(g.locator("[data-work-card-menu]").first());
    await page.locator("#wikiWorkPop [data-work-save-series]").click();
    await page.locator("#wikiWorkPop [data-work-series-go]").click();
    const msg = page.locator("#wikiWorkPop .wiki-work-series-msg");
    await expect(msg).toContainText("1 of 2 written");
    await expect(msg).toContainText(`Not written: ${LB}`);
    expect(await readFile(path.join(roots[R]!, LA), "utf8")).toContain("series: live-a");
    expect(await readFile(path.join(roots[R]!, LB), "utf8")).not.toContain("series:");
    await page.keyboard.press("Escape");
    // One series among the pages now: the action joins it.
    await openMenu(groupCard(page, `group:anchor:${LA}`).locator("[data-work-card-menu]").first());
    await expect(page.locator("#wikiWorkPop [data-work-save-series]")).toContainText("Save as series «live-a»");
    await page.locator("#wikiWorkPop [data-work-save-series]").click();
    await expect(page.locator("#wikiWorkPop .wiki-work-series-key")).toContainText("Join the series «live-a»");
    await page.locator("#wikiWorkPop [data-work-series-go]").click();
    await expect(groupCard(page, "group:series:live-a")).toHaveCount(1);
    expect(await readFile(path.join(roots[R]!, LB), "utf8")).toContain("series: live-a");
  });
  // An `.html` twin is part of its markdown page's family (pick-up D1), so a
  // session that wrote only the twin anchors the group on the markdown page
  // and the twin is never a card or a group child of its own.
  test("Save as series on a group whose session wrote only an .html twin: its markdown parent is written, the refresh names the group by the series and the action leaves its menu", async ({ page }) => {
    await openReader(page, TW);
    const g = groupCard(page, `group:anchor:${LA}`);
    await expect(g).toHaveCount(1);
    await expect(page.locator(`#wikiList .wiki-thread-card[data-thread="thread:${LAH}"]`)).toHaveCount(0);
    await expect(groupCard(page, `group:anchor:${LAH}`)).toHaveCount(0);
    await openMenu(g.locator("[data-work-card-menu]").first());
    await page.locator("#wikiWorkPop [data-work-save-series]").click();
    await expect(page.locator("#wikiWorkPop [data-work-series-key]")).toHaveValue("live-a");
    await page.locator("#wikiWorkPop [data-work-series-go]").click();
    const sg = groupCard(page, "group:series:live-a");
    await expect(sg).toHaveCount(1);
    await expect(page.locator("#wikiWorkPop")).toHaveCount(0);
    await expect(groupCard(page, `group:anchor:${LA}`)).toHaveCount(0);
    await expect(sg.locator("[data-work-card-menu]")).toHaveCount(0);
    for (const rel of [LA, LB]) expect(await readFile(path.join(roots[TW]!, rel), "utf8")).toContain("series: live-a");
    expect(await readFile(path.join(roots[TW]!, LAH), "utf8")).not.toContain("series");
    // And after a reload, from the server's evidence alone.
    await openReader(page, TW);
    await expect(groupCard(page, "group:series:live-a")).toHaveCount(1);
  });

  test("Save as series re-checks the plan after the bases: a page another writer put into a series since the click is left alone, its label kept, and nothing is written", async ({ page }) => {
    await openReader(page, ST);
    const g = groupCard(page, `group:anchor:${LA}`);
    await openMenu(g.locator("[data-work-card-menu]").first());
    await page.locator("#wikiWorkPop [data-work-save-series]").click();
    await expect(page.locator("#wikiWorkPop .wiki-work-series-list.w")).toHaveCount(2);
    // The concurrent writer: Reader lenses becomes the labelled head of "other".
    const lb = path.join(roots[ST]!, LB);
    await writeFile(lb, ["---", "title: Reader lenses", "plan_status: active", "status_date: 2026-10-10", 'related: ["[[plans/live-a]]"]', "series: other", "series_label: Other work", "created: 2025-01-01", "---", "", "Body.", ""].join("\n"), "utf8");
    // The first rescan after the click: past any write the old snapshot made.
    const rescan = page.waitForResponse((r) => r.url().includes("/api/wiki/pages") && r.url().includes("refresh=1"));
    await page.locator("#wikiWorkPop [data-work-series-go]").click();
    await rescan;
    const msg = page.locator("#wikiWorkPop .wiki-work-series-msg");
    const after = await readFile(lb, "utf8");
    expect(after).toContain("series: other");
    expect(after).toContain("series_label: Other work");
    expect(await readFile(path.join(roots[ST]!, LA), "utf8")).not.toContain("series:");
    await expect(msg).toHaveText("Nothing written — joined another series since this menu opened: Reader lenses (in «Other work»)");
    await expect(page.locator("#wikiWorkPop [data-work-series-go]")).toBeDisabled();
  });

  test("while a Save as series write runs, Escape, an outside click, Cancel and the ⋯ cannot close its popover; the landed write closes it", async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(
      (u) => u.pathname === "/api/wiki/series",
      async (route) => {
        await gate;
        return route.continue();
      },
    );
    await openReader(page, SL);
    const g = groupCard(page, `group:anchor:${LA}`);
    const child = page.locator(`.wiki-thread-gbody .wiki-thread-card[data-thread="thread:${LA}"]`);
    if (!(await child.getAttribute("class"))!.includes("open")) await child.locator(".wiki-thread-fold").click();
    await expect(threadRow(page, LA)).toHaveCount(1);
    const opener = g.locator("[data-work-card-menu]").first();
    await openMenu(opener);
    await page.locator("#wikiWorkPop [data-work-save-series]").click();
    const posted = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/wiki/series");
    await page.locator("#wikiWorkPop [data-work-series-go]").click();
    await posted;
    await page.keyboard.press("Escape");
    await expect(page.locator("#wikiWorkPop")).toHaveCount(1);
    await page.mouse.click(5, 5);
    await expect(page.locator("#wikiWorkPop")).toHaveCount(1);
    await opener.click();
    await expect(page.locator("#wikiWorkPop")).toHaveCount(1);
    // A row's series ⋯ opens nothing beside it. Dispatched: a pointer click
    // here can land under the popover.
    await threadRow(page, LA).locator("[data-series-menu]").dispatchEvent("click");
    await expect(page.locator("#wikiSeriesMenu")).toHaveCount(0);
    await expect(page.locator("#wikiWorkPop")).toHaveCount(1);
    await expect(page.locator("#wikiWorkPop [data-work-series-cancel]")).toBeDisabled();
    await expect(page.locator("#wikiWorkPop .wiki-work-series-msg")).toHaveText("Saving…");
    release();
    await expect(groupCard(page, "group:series:live-a")).toHaveCount(1);
    await expect(page.locator("#wikiWorkPop")).toHaveCount(0);
  });

  test("Escape during a write that stops on the second page: the popover stays and shows 1 of 2 written", async ({ page }) => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(
      (u) => u.pathname === "/api/wiki/series",
      async (route) => {
        calls++;
        await gate;
        if (calls === 2) return route.fulfill({ status: 409, json: { error: "the page changed (test)" } });
        return route.continue();
      },
    );
    await openReader(page, SF);
    await openMenu(groupCard(page, `group:anchor:${LA}`).locator("[data-work-card-menu]").first());
    await page.locator("#wikiWorkPop [data-work-save-series]").click();
    const posted = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/wiki/series");
    await page.locator("#wikiWorkPop [data-work-series-go]").click();
    await posted;
    await page.keyboard.press("Escape");
    release();
    const msg = page.locator("#wikiWorkPop .wiki-work-series-msg");
    await expect(msg).toContainText("1 of 2 written");
    await expect(msg).toContainText(`Not written: ${LB}`);
    await expect(page.locator("#wikiWorkPop [data-work-series-go]")).toBeDisabled();
    // Reported, the popover is the reader's to close again.
    await page.keyboard.press("Escape");
    await expect(page.locator("#wikiWorkPop")).toHaveCount(0);
    // The refresh repainted the opener; Escape finds it again by its key.
    await expect(groupCard(page, `group:anchor:${LA}`).locator("[data-work-card-menu]").first()).toBeFocused();
  });

  test("a refresh that fails after the write says Saved — reload, and the popover stays to say it", async ({ page }) => {
    let posted = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(
      (u) => u.pathname === "/api/wiki/series",
      async (route) => {
        posted = true;
        await gate;
        return route.continue();
      },
    );
    await page.route(
      (u) => u.pathname === "/api/wiki/pages" && u.searchParams.get("refresh") === "1",
      (route) => (posted ? route.fulfill({ status: 500, body: "boom" }) : route.continue()),
    );
    await openReader(page, NR);
    await openMenu(groupCard(page, `group:anchor:${LA}`).locator("[data-work-card-menu]").first());
    await page.locator("#wikiWorkPop [data-work-save-series]").click();
    const req = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/wiki/series");
    await page.locator("#wikiWorkPop [data-work-series-go]").click();
    await req;
    release();
    await expect(page.locator("#wikiWorkPop .wiki-work-series-msg")).toHaveText("Saved — reload to see the updated list");
    await expect(page.locator("#wikiWorkPop [data-work-series-go]")).toBeDisabled();
    for (const rel of [LA, LB]) expect(await readFile(path.join(roots[NR]!, rel), "utf8")).toContain("series: live-a");
  });

  test("a write that moved a series' labelled head anyway says that series has no label now", async ({ page }) => {
    await page.route(
      (u) => u.pathname === "/api/wiki/series",
      (route) => route.fulfill({ status: 200, json: { hash: "h", written: true, clearedLabel: { series: "other" } } }),
    );
    await openReader(page, CL);
    await openMenu(groupCard(page, `group:anchor:${LA}`).locator("[data-work-card-menu]").first());
    await page.locator("#wikiWorkPop [data-work-save-series]").click();
    await page.locator("#wikiWorkPop [data-work-series-go]").click();
    await expect(page.locator("#wikiWorkPop .wiki-work-series-msg")).toContainText('A page was the head of "other" — that series has no label now');
  });

  test("a write whose popover is gone by its end reports in a status note instead", async ({ page }) => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(
      (u) => u.pathname === "/api/wiki/series",
      async (route) => {
        calls++;
        await gate;
        if (calls === 2) return route.fulfill({ status: 409, json: { error: "the page changed (test)" } });
        return route.continue();
      },
    );
    await openReader(page, NG);
    await openMenu(groupCard(page, `group:anchor:${LA}`).locator("[data-work-card-menu]").first());
    await page.locator("#wikiWorkPop [data-work-save-series]").click();
    const req = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/wiki/series");
    await page.locator("#wikiWorkPop [data-work-series-go]").click();
    await req;
    // Something outside the reader's controls removes the popover mid-write.
    await page.evaluate(() => document.getElementById("wikiWorkPop")?.remove());
    release();
    await expect(page.locator("#wikiWorkSeriesStatus")).toContainText("1 of 2 written");
  });
});

/** Fix round 2, batch 2: a network error mid-write, in-place retries, and
 *  the other ⋯ openers while a write runs. */
test.describe("Wiki rail: Save as series, network errors and retries", () => {
  test("the network drops the second write: 1 of 2 written with the error and the page left, the listing refreshed, the popover unlocked, no page error", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let calls = 0;
    await page.route(
      (u) => u.pathname === "/api/wiki/series",
      (route) => (++calls === 2 ? route.abort("connectionreset") : route.continue()),
    );
    await openReader(page, AB);
    await openMenu(groupCard(page, `group:anchor:${LA}`).locator("[data-work-card-menu]").first());
    await page.locator("#wikiWorkPop [data-work-save-series]").click();
    // The refresh after the writes, not the re-check's rescan before them.
    const refreshed = page.waitForRequest((r) => r.url().includes("/api/wiki/pages") && r.url().includes("refresh=1") && calls >= 2);
    await page.locator("#wikiWorkPop [data-work-series-go]").click();
    const msg = page.locator("#wikiWorkPop .wiki-work-series-msg");
    await expect(msg).toContainText(`1 of 2 written — stopped at ${LB}: Network error:`);
    await expect(msg).toContainText(`Not written: ${LB}`);
    await refreshed;
    await expect(page.locator("#wikiWorkPop [data-work-series-cancel]")).toBeEnabled();
    await expect(page.locator("#wikiWorkPop [data-work-series-go]")).toBeDisabled();
    expect(await readFile(path.join(roots[AB]!, LA), "utf8")).toContain("series: live-a");
    expect(await readFile(path.join(roots[AB]!, LB), "utf8")).not.toContain("series:");
    expect(errors).toEqual([]);
    await page.locator("#wikiWorkPop [data-work-series-cancel]").click();
    await expect(page.locator("#wikiWorkPop")).toHaveCount(0);
  });

  test("a refusal the reader can resolve in place keeps Write on: a failed re-read, then a key another writer took since; a new key then writes", async ({ page }) => {
    await openReader(page, RT);
    let failRescan = true;
    await page.route(
      (u) => u.pathname === "/api/wiki/pages" && u.searchParams.get("refresh") === "1",
      (route) => {
        if (!failRescan) return route.continue();
        failRescan = false;
        return route.fulfill({ status: 500, body: "boom" });
      },
    );
    await openMenu(groupCard(page, `group:anchor:${LA}`).locator("[data-work-card-menu]").first());
    await page.locator("#wikiWorkPop [data-work-save-series]").click();
    const key = page.locator("#wikiWorkPop [data-work-series-key]");
    const go = page.locator("#wikiWorkPop [data-work-series-go]");
    const msg = page.locator("#wikiWorkPop .wiki-work-series-msg");
    await expect(key).toHaveValue("live-a");
    await go.click();
    await expect(msg).toHaveText("Could not re-read the wiki listing — nothing written");
    await expect(go).toBeEnabled();
    await expect(key).toBeEnabled();
    // Another writer takes the key before the retry.
    await writeFile(path.join(roots[RT]!, "notes/late.md"), ["---", "title: Late note", "series: live-a", "created: 2025-01-01", "---", "", "Body.", ""].join("\n"), "utf8");
    await go.click();
    await expect(msg).toHaveText('"live-a" became a series here since this menu opened — nothing written; pick another key');
    await expect(go).toBeEnabled();
    await expect(key).toBeEnabled();
    for (const rel of [LA, LB]) expect(await readFile(path.join(roots[RT]!, rel), "utf8")).not.toContain("series:");
    await key.fill("fresh-key");
    await go.click();
    await expect(groupCard(page, "group:series:fresh-key")).toHaveCount(1);
    await expect(page.locator("#wikiWorkPop")).toHaveCount(0);
    for (const rel of [LA, LB]) expect(await readFile(path.join(roots[RT]!, rel), "utf8")).toContain("series: fresh-key");
  });

  test("anything unforeseen mid-run (a malformed re-read listing) still unlocks the popover and reports, with no page error", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await openReader(page, TH);
    await page.route(
      (u) => u.pathname === "/api/wiki/pages" && u.searchParams.get("refresh") === "1",
      (route) => route.fulfill({ status: 200, json: { pages: [null] } }),
    );
    await openMenu(groupCard(page, `group:anchor:${LA}`).locator("[data-work-card-menu]").first());
    await page.locator("#wikiWorkPop [data-work-save-series]").click();
    await page.locator("#wikiWorkPop [data-work-series-go]").click();
    const msg = page.locator("#wikiWorkPop .wiki-work-series-msg");
    await expect(msg).toContainText("Save as series stopped:");
    await expect(msg).toContainText("— reload to see what was written");
    await expect(page.locator("#wikiWorkPop [data-work-series-cancel]")).toBeEnabled();
    await expect(page.locator("#wikiWorkPop [data-work-series-go]")).toBeDisabled();
    expect(errors).toEqual([]);
    for (const rel of [LA, LB]) expect(await readFile(path.join(roots[TH]!, rel), "utf8")).not.toContain("series:");
  });

  test("while a write runs, ANOTHER card's ⋯ and a row's own ⋯ open nothing beside its popover", async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(
      (u) => u.pathname === "/api/wiki/series",
      async (route) => {
        await gate;
        return route.continue();
      },
    );
    await openReader(page, TWS);
    const g = groupCard(page, `group:anchor:${LA}`);
    const child = page.locator(`.wiki-thread-gbody .wiki-thread-card[data-thread="thread:${LA}"]`);
    if (!(await child.getAttribute("class"))!.includes("open")) await child.locator(".wiki-thread-fold").click();
    const rowOpener = threadRow(page, LXH).locator("[data-thread-row-menu]");
    const otherCard = page.locator(`.wiki-thread-gbody .wiki-thread-card[data-thread="thread:${LB}"] [data-work-card-menu]`);
    await expect(rowOpener).toHaveCount(1);
    await expect(otherCard).toHaveCount(1);
    await openMenu(g.locator("[data-work-card-menu]").first());
    await page.locator("#wikiWorkPop [data-work-save-series]").click();
    const posted = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/wiki/series");
    await page.locator("#wikiWorkPop [data-work-series-go]").click();
    await posted;
    const pop = page.locator("#wikiWorkPop");
    // Dispatched: a pointer click here can land under the popover.
    for (const opener of [otherCard, rowOpener]) {
      await opener.dispatchEvent("click");
      await expect(pop).toHaveCount(1);
      await expect(pop).toHaveAttribute("role", "dialog");
      await expect(page.locator("#wikiWorkPop .wiki-work-series-msg")).toHaveText("Saving…");
    }
    release();
    await expect(groupCard(page, "group:series:live-a")).toHaveCount(1);
    await expect(pop).toHaveCount(0);
  });
});

/** Fix round 1, batch 5: focus after an edit, keyboard reach, ARIA. */
test.describe("Wiki rail: boundary controls by keyboard", () => {
  /** Tab from the focused element until `target` has focus; false after `max` presses. */
  async function tabTo(page: Page, target: ReturnType<Page["locator"]>, max = 20): Promise<boolean> {
    for (let i = 0; i < max; i++) {
      await page.keyboard.press("Tab");
      if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return true;
    }
    return false;
  }

  test("focus after each boundary edit lands on the card it acted on, never <body>", async ({ page }) => {
    await openReader(page);
    await groupCard(page, `group:anchor:${LA}`).locator(".wiki-thread-fold").click();
    // Keep separate: the kept-apart card's ⋯.
    await openMenu(page.locator(`.wiki-thread-gbody .wiki-thread-card[data-thread="thread:${LB}"] [data-work-card-menu]`));
    await page.locator("#wikiWorkPop [data-work-keep]").click();
    await expect(card(page, LB).locator(".wiki-thread-chip-own")).toHaveText("kept separate");
    await expect(card(page, LB).locator("[data-work-card-menu]")).toBeFocused();
    // Allow grouping: the same thread's ⋯, now a child of the re-formed group.
    await openMenu(card(page, LB).locator("[data-work-card-menu]"));
    await page.locator("#wikiWorkPop [data-work-allow]").click();
    await expect(groupCard(page, `group:anchor:${LA}`)).toHaveCount(1);
    await expect(page.locator(`#wikiList [data-work-card-menu="thread:${LB}"]`)).toBeFocused();
    // Make own thread: the split card's fold.
    await rowMenu(page, TSPLIT);
    await page.locator("#wikiSeriesMenu [data-thread-split]").click();
    await expect(card(page, TSPLIT).locator(".wiki-thread-fold")).toBeFocused();
    // Escape after a repaint while the popover is open: its opener, by key.
    await openMenu(card(page, TSPLIT).locator("[data-work-card-menu]"));
    // Another tab's edit that moves no card: the rail repaints under the popover.
    const repainted = await page.evaluate((k) => {
      const r = JSON.parse(localStorage.getItem(k)!);
      r.evidence = { issue: false };
      const v = JSON.stringify(r);
      localStorage.setItem(k, v);
      const before = document.querySelector("#wikiList [data-work-card-menu]");
      window.dispatchEvent(new StorageEvent("storage", { key: k, newValue: v, storageArea: localStorage }));
      return !!before && !before.isConnected;
    }, workGroupKey(B));
    expect(repainted).toBe(true);
    await expect(page.locator("#wikiWorkPop")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator("#wikiWorkPop")).toHaveCount(0);
    await expect(card(page, TSPLIT).locator("[data-work-card-menu]")).toBeFocused();
    // Return to its thread: the card that took the page back.
    await openMenu(card(page, TSPLIT).locator("[data-work-card-menu]"));
    await page.locator("#wikiWorkPop [data-work-return]").click();
    await expect(card(page, TSPLIT)).toHaveCount(0);
    await expect(card(page, TKEY).locator(".wiki-thread-fold")).toBeFocused();
  });

  test("keyboard: Tab reaches a focus row's page menu; Enter opens it on Make own thread; the arrows and End move; Enter splits", async ({ page }) => {
    await openReader(page);
    const opener = threadRow(page, TSPLIT).locator("[data-series-menu]");
    await card(page, TKEY).locator(".wiki-thread-fold").focus();
    expect(await tabTo(page, opener)).toBe(true);
    // Shown while it has focus, not only on hover.
    await expect.poll(() => opener.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await page.keyboard.press("Enter");
    const menuEl = page.locator("#wikiSeriesMenu");
    await expect(menuEl).toHaveCount(1);
    const split = menuEl.locator("[data-thread-split]");
    await expect(split).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(split).not.toBeFocused();
    expect(await menuEl.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await split.focus();
    // ArrowUp on the first item wraps to the last, the new-key field, whose
    // keys are its own from there (fix round 2, batch 4).
    const field = menuEl.locator("[data-series-input]");
    await page.keyboard.press("ArrowUp");
    await expect(field).toBeFocused();
    // End from an item: the last item.
    await split.focus();
    await page.keyboard.press("End");
    await expect(field).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menuEl).toHaveCount(0);
    await expect(opener).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(split).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(card(page, TSPLIT).locator(".wiki-thread-chip-own")).toHaveText("own thread");
    await expect(card(page, TSPLIT).locator(".wiki-thread-fold")).toBeFocused();
    // The card's ⋯ by keyboard: Enter opens on Return; Tab closes back to it.
    const cardMenu = card(page, TSPLIT).locator("[data-work-card-menu]");
    await cardMenu.focus();
    await page.keyboard.press("Enter");
    const ret = page.locator("#wikiWorkPop [data-work-return]");
    await expect(ret).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(ret).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator("#wikiWorkPop")).toHaveCount(0);
    await expect(cardMenu).toBeFocused();
    await expect(cardMenu).toHaveAttribute("aria-expanded", "false");
  });

  test("keyboard on a read-only wiki: Tab reaches the row's own ⋯ and Enter opens Make own thread; Escape returns to it", async ({ page }) => {
    await openReader(page, BRO);
    const opener = threadRow(page, TSPLIT).locator("[data-thread-row-menu]");
    await card(page, TKEY).locator(".wiki-thread-fold").focus();
    expect(await tabTo(page, opener)).toBe(true);
    await page.keyboard.press("Enter");
    await expect(page.locator("#wikiWorkPop [data-thread-split]")).toBeFocused();
    await expect(page.locator("#wikiWorkPop")).toHaveAccessibleName("Page menu for Task split");
    await page.keyboard.press("Escape");
    await expect(page.locator("#wikiWorkPop")).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test("a11y: the ⋯ popover is named for its card; Save as series' confirm view is a labelled non-modal dialog", async ({ page }) => {
    await openReader(page, C);
    const g = groupCard(page, `group:anchor:${LA}`);
    await g.locator(".wiki-thread-fold").click();
    await openMenu(page.locator(`.wiki-thread-gbody .wiki-thread-card[data-thread="thread:${LB}"] [data-work-card-menu]`));
    const pop = page.locator("#wikiWorkPop");
    await expect(pop).toHaveAttribute("role", "menu");
    await expect(pop).toHaveAccessibleName("More for the thread Reader lenses");
    await page.keyboard.press("Escape");
    const opener = g.locator("> .wiki-thread-acts [data-work-card-menu]");
    await openMenu(opener);
    await expect(pop).toHaveAccessibleName("More for the group Living facts");
    await page.locator("#wikiWorkPop [data-work-save-series]").click();
    await expect(pop).toHaveAttribute("role", "dialog");
    await expect(pop).toHaveAttribute("aria-modal", "false");
    await expect(pop).toHaveAccessibleName("Save «Living facts» as a series");
    await expect(pop).toMatchAriaSnapshot(`
      - dialog "Save «Living facts» as a series":
        - textbox "New series key"
        - button "Write 2 pages"
        - button "Cancel"
    `);
    await page.locator("#wikiWorkPop [data-work-series-cancel]").click();
    await expect(pop).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test("a11y: a disabled ▸ split into N sessions is named by its label and described by its reason", async ({ page }) => {
    await page.route(
      (u) => u.pathname === "/api/wiki/pages" && u.searchParams.get("wiki") === B,
      async (route) => {
        const res = await route.fetch();
        const json = (await res.json()) as { work?: { evidence?: { contributions: unknown } } };
        if (json.work?.evidence) json.work.evidence.contributions = { complete: false, reasons: ["ledger-truncated"], cut: [], rows: [] };
        await route.fulfill({ response: res, json });
      },
    );
    await openReader(page);
    const btn = page.locator(`[data-thread-sessions="thread:${TKEY}"]`);
    await expect(btn).toHaveAttribute("aria-disabled", "true");
    await expect(btn).toHaveAccessibleName("split into 3 sessions in Task split");
    const by = await btn.getAttribute("aria-describedby");
    expect(by).toBeTruthy();
    await expect(page.locator(`[id="${by}"]`)).toHaveText("Unavailable: the session ledger was cut short");
    await expect(btn).toHaveAccessibleDescription("Unavailable: the session ledger was cut short");
  });

  /** Another tab's edit that moves no card: the rail repaints in place. Answers
   *  whether the node `sel` found before is gone after. */
  const repaint = (page: Page, sel: string) =>
    page.evaluate(
      ([k, s]) => {
        const r = JSON.parse(localStorage.getItem(k!) ?? "{}");
        r.evidence = { issue: !(r.evidence?.issue ?? false) };
        const v = JSON.stringify(r);
        localStorage.setItem(k!, v);
        const before = document.querySelector(s!);
        window.dispatchEvent(new StorageEvent("storage", { key: k!, newValue: v, storageArea: localStorage }));
        return !!before && !before.isConnected;
      },
      [workGroupKey(B), sel] as const,
    );

  /** Split t-split and draw its card open, so its row and the row's ⋯ show. */
  async function splitAndOpen(page: Page): Promise<void> {
    await openReader(page);
    await rowMenu(page, TSPLIT);
    await page.locator("#wikiSeriesMenu [data-thread-split]").click();
    await expect(card(page, TSPLIT)).toHaveCount(1);
    const sf = card(page, TSPLIT).locator(":scope > .wiki-thread-fold");
    if ((await sf.getAttribute("aria-expanded")) !== "true") await sf.click();
    await expect(threadRow(page, TSPLIT)).toHaveCount(1);
  }

  test("a repaint with focus on a thread row's page menu keeps it there, by its page (fix round 2, batch 4)", async ({ page }) => {
    await splitAndOpen(page);
    const opener = threadRow(page, TSPLIT).locator("[data-series-menu]");
    await opener.focus();
    expect(await repaint(page, `#wikiList .wiki-list-item.thread-row[data-relpath="${TSPLIT}"] [data-series-menu]`)).toBe(true);
    await expect(opener).toBeFocused();
  });

  test("Escape in a thread row's page menu after a repaint returns to the row's ⋯ by its page, never <body> (fix round 2, batch 4)", async ({ page }) => {
    await splitAndOpen(page);
    const opener = threadRow(page, TSPLIT).locator("[data-series-menu]");
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#wikiSeriesMenu [data-work-return]")).toBeFocused();
    expect(await repaint(page, `#wikiList .wiki-list-item.thread-row[data-relpath="${TSPLIT}"] [data-series-menu]`)).toBe(true);
    await expect(page.locator("#wikiSeriesMenu")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator("#wikiSeriesMenu")).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    await expect(opener).toBeFocused();
  });

  test("Return from a row's page menu focuses the card that took the page back, not the row's ⋯ (fix round 2, batch 4)", async ({ page }) => {
    await splitAndOpen(page);
    const parentFold = card(page, TKEY).locator(":scope > .wiki-thread-fold");
    if ((await parentFold.getAttribute("aria-expanded")) !== "true") await parentFold.click();
    await rowMenu(page, TSPLIT);
    await page.locator("#wikiSeriesMenu [data-work-return]").click();
    await expect(card(page, TSPLIT)).toHaveCount(0);
    // The returned row is drawn in the open parent card, ⋯ and all: the fold
    // wins over that opener.
    await expect(threadRow(page, TSPLIT).locator("[data-series-menu]")).toHaveCount(1);
    await expect(parentFold).toBeFocused();
  });

  test("keys inside a ⋯ menu stay the menu's: f and ] leave the layout alone, Escape closes the menu without leaving focus mode (fix round 2, batch 4)", async ({ page }) => {
    await openReader(page);
    const layout = page.locator(".wiki-layout");
    const opener = threadRow(page, TSPLIT).locator("[data-series-menu]");
    await opener.focus();
    await page.keyboard.press("Enter");
    const split = page.locator("#wikiSeriesMenu [data-thread-split]");
    await expect(split).toBeFocused();
    await page.keyboard.press("f");
    await page.keyboard.press("]");
    await expect(layout).not.toHaveClass(/focus-mode/);
    await expect(layout).not.toHaveClass(/right-collapsed/);
    await expect(split).toBeFocused();
    // Focus mode entered with the menu open (its rail hidden, the body-level
    // menu still up): Escape is the menu's.
    await layout.evaluate((el) => el.classList.add("focus-mode"));
    await page.keyboard.press("Escape");
    await expect(page.locator("#wikiSeriesMenu")).toHaveCount(0);
    await expect(layout).toHaveClass(/focus-mode/);
    // The work popover the same, on a read-only wiki.
    await openReader(page, BRO);
    await threadRow(page, TSPLIT).locator("[data-thread-row-menu]").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#wikiWorkPop [data-thread-split]")).toBeFocused();
    await page.keyboard.press("f");
    await expect(layout).not.toHaveClass(/focus-mode/);
    await expect(page.locator("#wikiWorkPop")).toHaveCount(1);
  });

  test("the arrows never leave the page menu's new-key field (fix round 2, batch 4)", async ({ page }) => {
    await openReader(page);
    await threadRow(page, TSPLIT).locator("[data-series-menu]").focus();
    await page.keyboard.press("Enter");
    const field = page.locator("#wikiSeriesMenu [data-series-input]");
    await page.keyboard.press("End");
    await expect(field).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(field).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(field).toBeFocused();
  });

  test("the arrows are not a plain row's series menu's: they stay in its field (fix round 2, batch 4)", async ({ page }) => {
    // A plain row's series menu opens on its field, beside a join item.
    await openReader(page, ST);
    const row = page.locator(`#wikiList .wiki-list-item:not(.thread-row)[data-relpath="notes/old-1.md"]`);
    await row.hover();
    await row.locator("[data-series-menu]").click();
    const plain = page.locator("#wikiSeriesMenu [data-series-input]");
    await expect(plain).toBeFocused();
    await expect(page.locator("#wikiSeriesMenu [role^='menuitem']").first()).toHaveCount(1);
    await page.keyboard.press("ArrowDown");
    await expect(plain).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(plain).toBeFocused();
    // Its items do not take them either: only the page menu and the work
    // popover do.
    const join = page.locator("#wikiSeriesMenu [role^='menuitem']").first();
    await join.focus();
    await page.keyboard.press("ArrowDown");
    await expect(join).toBeFocused();
  });

  test("a ⋯ click whose own scroll lands after the popover opens keeps it open; a later scroll of the rail closes it (fix round 2, batch 4)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 420 });
    await openReader(page);
    await groupCard(page, `group:anchor:${LA}`).locator(".wiki-thread-fold").click();
    const opener = page.locator(`.wiki-thread-gbody .wiki-thread-card[data-thread="thread:${LB}"] [data-work-card-menu]`);
    await opener.scrollIntoViewIfNeeded();
    // The click scrolls the rail itself (as a focus or scroll-into-view does):
    // the rail moves before the popover opens, its scroll event after.
    await page.waitForTimeout(150);
    const room = await page.evaluate(() => {
      const list = document.getElementById("wikiList")!;
      document.addEventListener("click", () => (list.scrollTop += list.scrollTop >= 20 ? -20 : 20), { capture: true, once: true });
      return list.scrollHeight - list.clientHeight;
    });
    expect(room).toBeGreaterThanOrEqual(20);
    const top = () => page.evaluate(() => document.getElementById("wikiList")!.scrollTop);
    const before = await top();
    await opener.click();
    await page.waitForTimeout(250);
    expect(await top()).not.toBe(before);
    await expect(page.locator("#wikiWorkPop")).toHaveCount(1);
    await expect(page.locator("#wikiWorkPop [data-work-keep]")).toBeFocused();
    // The reader scrolls the rail with the popover up: it closes.
    await page.evaluate(() => (document.getElementById("wikiList")!.scrollTop += document.getElementById("wikiList")!.scrollTop >= 20 ? -20 : 20));
    await expect(page.locator("#wikiWorkPop")).toHaveCount(0);
  });
});

/**
 * Class check (round 3): focus after each reset-area action. Reset renders
 * above every entry, so a Forget whose focus fell to the first match of a
 * combined selector landed on Reset, and a second Enter wiped the record.
 * Each row: the record seeded, the key pressed on one control, the control
 * that must hold focus after the write and the repaint.
 */
test.describe("Wiki rail: reset-area focus (class check)", () => {
  const G = (i: number) => ({ id: `g${i}`, page: `gone/s-${i}.md` });
  const ANCHOR = "notes/gone-k.md";
  const FULL = { version: 1, stop: "areas", splits: [G(1), G(2), G(3)], keptApart: [ANCHOR] };
  const split = (id: string) => `[data-work-forget-split="${id}"]`;
  const anchor = (p: string) => `[data-work-forget-anchor="${p}"]`;
  const CHECKED_STOP = '[data-work-stop][aria-checked="true"]';

  async function seedAndOpen(page: Page, rec: unknown): Promise<void> {
    await page.addInitScript(
      ([k, v]) => {
        if (localStorage.getItem("__seeded")) return;
        localStorage.setItem("__seeded", "1");
        localStorage.setItem(k!, v!);
      },
      [workGroupKey(B), JSON.stringify(rec)] as const,
    );
    await openReader(page);
    await groupBtn(page).click();
    await expect(page.locator(".wiki-work-menu")).toHaveCount(1);
  }

  const forgets = (page: Page) =>
    page.locator("#wikiList .wiki-work-menu [data-work-forget-split], #wikiList .wiki-work-menu [data-work-forget-anchor]").evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-work-forget-split") ?? `anchor:${e.getAttribute("data-work-forget-anchor")}`),
    );

  const rows: { name: string; rec: unknown; on: string; key: string; focus: string; left: string[] }[] = [
    { name: "Forget the first entry (Enter): the next entry's Forget", rec: FULL, on: split("g1"), key: "Enter", focus: split("g2"), left: ["g2", "g3", `anchor:${ANCHOR}`] },
    { name: "Forget a middle entry (Enter): the next entry's Forget", rec: FULL, on: split("g2"), key: "Enter", focus: split("g3"), left: ["g1", "g3", `anchor:${ANCHOR}`] },
    { name: "Forget a middle entry (Space): the next entry's Forget", rec: FULL, on: split("g2"), key: " ", focus: split("g3"), left: ["g1", "g3", `anchor:${ANCHOR}`] },
    { name: "Forget the last entry (an anchor): the previous entry's Forget", rec: FULL, on: anchor(ANCHOR), key: "Enter", focus: split("g3"), left: ["g1", "g2", "g3"] },
    // An active split (t-split) and an active anchor (live-b) keep Reset in the
    // menu with no entry left under it, so the fallback must skip it.
    { name: "Forget the only entry (a split): the menu's checked stop, the menu open", rec: { version: 1, stop: "areas", splits: [{ id: "a1", page: TSPLIT }, G(1)] }, on: split("g1"), key: "Enter", focus: CHECKED_STOP, left: [] },
    { name: "Forget the only entry (an anchor): the menu's checked stop", rec: { version: 1, keptApart: [LB, ANCHOR] }, on: anchor(ANCHOR), key: "Enter", focus: CHECKED_STOP, left: [] },
  ];

  for (const row of rows) {
    test(`keyboard: ${row.name}`, async ({ page }) => {
      await seedAndOpen(page, row.rec);
      await page.locator(`#wikiList .wiki-work-menu ${row.on}`).focus();
      await page.keyboard.press(row.key === " " ? "Space" : row.key);
      await expect(page.locator(".wiki-work-menu")).toHaveCount(1);
      expect(await forgets(page)).toEqual(row.left);
      await expect(page.locator(`#wikiList .wiki-work-menu ${row.focus}`)).toBeFocused();
      await expect(page.locator("[data-work-reset]")).toHaveCount(1);
      await expect(page.locator("[data-work-reset]:focus")).toHaveCount(0);
    });
  }

  test("keyboard: Reset closes the menu and focuses the Group button", async ({ page }) => {
    await seedAndOpen(page, FULL);
    await page.locator("[data-work-reset]").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".wiki-work-menu")).toHaveCount(0);
    await expect(groupBtn(page)).toBeFocused();
    expect(await record(page)).toEqual({ version: 1 });
  });

  test("mouse: Forget a middle entry follows the same rule", async ({ page }) => {
    await seedAndOpen(page, FULL);
    await page.locator(split("g2")).click();
    await expect(page.locator(split("g3"))).toBeFocused();
  });

  test("the repro: Enter on Forget, then Enter again forgets the next entry and never resets", async ({ page }) => {
    await seedAndOpen(page, FULL);
    await page.locator(split("g2")).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    expect(await record(page)).toEqual({ version: 1, stop: "areas", splits: [G(1)], keptApart: [ANCHOR] });
    await expect(page.locator(".wiki-work-menu")).toHaveCount(1);
    await expect(page.locator(anchor(ANCHOR))).toBeFocused();
  });

  // The verify pass's survivors E4 and E5: both actions clear a standing
  // boundary note (one stands in, by id, as the note the click handlers find).
  for (const [what, act] of [
    ["Reset", (page: Page) => page.locator("[data-work-reset]").click()],
    ["Forget", (page: Page) => page.locator(split("g1")).click()],
  ] as const) {
    test(`${what} clears the boundary status note`, async ({ page }) => {
      await seedAndOpen(page, FULL);
      await page.evaluate(() => {
        const el = document.createElement("div");
        el.id = "wikiWorkBoundaryStatus";
        el.textContent = "Make own thread did nothing";
        document.body.appendChild(el);
      });
      await expect(page.locator("#wikiWorkBoundaryStatus")).toHaveCount(1);
      await act(page);
      await expect(page.locator("#wikiWorkBoundaryStatus")).toHaveCount(0);
    });
  }
});

/**
 * Class check (round 3): where focus goes when a ⋯ popover closes. One row per
 * reachable cell of cause × opener state × popover; the table itself is the
 * comment at `PopCloseCause` in `wiki-browser.ts`. A key close returns focus
 * to the opener (re-found by key after a repaint); a click elsewhere never
 * moves it; a scroll or resize moves it only out of the removed popover.
 */
test.describe("Wiki rail: popover close focus (class check)", () => {
  type Pop = "page menu" | "work popover";
  const MENU = { "page menu": "#wikiSeriesMenu", "work popover": "#wikiWorkPop" } as const;
  const pageOpener = (page: Page) => threadRow(page, TSPLIT).locator("[data-series-menu]");
  const workOpener = (page: Page) => card(page, TKEY).locator("> .wiki-thread-acts [data-work-card-menu]");
  const opener = (page: Page, pop: Pop) => (pop === "page menu" ? pageOpener(page) : workOpener(page));
  const search = (page: Page) => page.locator("#wikiSearch");
  const loneFold = (page: Page) => card(page, LONE).locator(":scope > .wiki-thread-fold");
  const rail = (page: Page) => page.locator("#wikiList");

  /** Another tab's edit that moves no card: the rail repaints in place. True
   *  when the opener node was replaced. */
  const repaint = (page: Page, pop: Pop) =>
    page.evaluate(
      ([k, s]) => {
        const r = JSON.parse(localStorage.getItem(k!) ?? '{"version":1}');
        r.evidence = { issue: !(r.evidence?.issue ?? false) };
        const v = JSON.stringify(r);
        localStorage.setItem(k!, v);
        const before = document.querySelector(s!);
        window.dispatchEvent(new StorageEvent("storage", { key: k!, newValue: v, storageArea: localStorage }));
        return !!before && !before.isConnected;
      },
      [workGroupKey(B), pop === "page menu" ? `#wikiList .wiki-list-item.thread-row[data-relpath="${TSPLIT}"] [data-series-menu]` : `#wikiList [data-work-card-menu="thread:${TKEY}"]`] as const,
    );

  /** Scroll the rail by 20 px, the opener with it. */
  const scrollRail = (page: Page) =>
    rail(page).evaluate((list) => {
      list.scrollTop += list.scrollTop >= 20 ? -20 : 20;
    });

  /** Open `pop` from its opener by keyboard; focus lands on its first item. */
  async function open(page: Page, pop: Pop): Promise<void> {
    const o = opener(page, pop);
    await o.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await o.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(MENU[pop])).toHaveCount(1);
    await expect(page.locator(`${MENU[pop]} [role="menuitem"]`).first()).toBeFocused();
  }

  type Row = { name: string; pop: Pop; act: (page: Page) => Promise<unknown>; focus: (page: Page) => ReturnType<Page["locator"]> | "body"; open?: boolean };
  const both = (f: (pop: Pop) => Row[]): Row[] => [...f("page menu"), ...f("work popover")];
  const rows: Row[] = [
    ...both((pop) => [
      { name: "Escape", pop, act: (p) => p.keyboard.press("Escape"), focus: (p) => opener(p, pop) },
      {
        name: "Escape after a repaint: the opener by its key",
        pop,
        act: async (p) => {
          expect(await repaint(p, pop)).toBe(true);
          await expect(p.locator(MENU[pop])).toHaveCount(1);
          await p.keyboard.press("Escape");
        },
        focus: (p) => opener(p, pop),
      },
      {
        name: "its opener clicked again",
        pop,
        act: async (p) => {
          // The row's ⋯ shows on hover; with focus in the menu it is hidden.
          if (pop === "page menu") await threadRow(p, TSPLIT).hover();
          await opener(p, pop).click();
        },
        focus: (p) => opener(p, pop),
      },
      { name: "outside click on another card's fold: that fold", pop, act: (p) => loneFold(p).click(), focus: loneFold },
      {
        name: "outside click on another card's fold after a repaint: that fold",
        pop,
        act: async (p) => {
          expect(await repaint(p, pop)).toBe(true);
          await loneFold(p).click();
        },
        focus: loneFold,
      },
      { name: "outside click into the search box", pop, act: (p) => search(p).click(), focus: search },
      {
        name: "outside click into the search box after a repaint",
        pop,
        act: async (p) => {
          expect(await repaint(p, pop)).toBe(true);
          await search(p).click();
        },
        focus: search,
      },
      { name: "outside click on the page body", pop, act: (p) => p.mouse.click(1000, 300), focus: () => "body" },
      { name: "a rail scroll with focus in the popover: the opener", pop, act: scrollRail, focus: (p) => opener(p, pop) },
      {
        name: "a rail scroll with focus outside the popover: focus stays",
        pop,
        act: async (p) => {
          await search(p).focus();
          await expect(p.locator(MENU[pop])).toHaveCount(1);
          await scrollRail(p);
        },
        focus: search,
      },
      {
        name: "a rail scroll after a repaint with focus in the popover: the opener by its key",
        pop,
        act: async (p) => {
          expect(await repaint(p, pop)).toBe(true);
          await scrollRail(p);
        },
        focus: (p) => opener(p, pop),
      },
      { name: "a resize with focus in the popover: the opener", pop, act: (p) => p.setViewportSize({ width: 1200, height: 400 }), focus: (p) => opener(p, pop) },
      {
        name: "a resize with focus outside the popover: focus stays",
        pop,
        act: async (p) => {
          await search(p).focus();
          await p.setViewportSize({ width: 1200, height: 400 });
        },
        focus: search,
      },
      {
        name: "a repaint closes nothing and keeps the popover's own focus",
        pop,
        act: async (p) => expect(await repaint(p, pop)).toBe(true),
        focus: (p) => p.locator(`${MENU[pop]} [role="menuitem"]`).first(),
        open: true,
      },
    ]),
    { name: "Tab: the opener", pop: "work popover", act: (p) => p.keyboard.press("Tab"), focus: workOpener },
    { name: "Shift+Tab: the opener", pop: "work popover", act: (p) => p.keyboard.press("Shift+Tab"), focus: workOpener },
    {
      name: "Tab after a repaint: the opener by its key",
      pop: "work popover",
      act: async (p) => {
        expect(await repaint(p, "work popover")).toBe(true);
        await p.keyboard.press("Tab");
      },
      focus: workOpener,
    },
    {
      // The verify pass's survivor: the scroll handler measures the opener
      // the repaint put in place, not the detached node.
      name: "a repaint, then a scroll that does not move the opener: the popover stays",
      pop: "work popover",
      act: async (p) => {
        expect(await repaint(p, "work popover")).toBe(true);
        await p.evaluate(() => document.dispatchEvent(new Event("scroll")));
        await p.waitForTimeout(100);
      },
      focus: (p) => p.locator("#wikiWorkPop [data-work-keep]"),
      open: true,
    },
    { name: "Make own thread: the split card's fold", pop: "page menu", act: (p) => p.keyboard.press("Enter"), focus: (p) => card(p, TSPLIT).locator(":scope > .wiki-thread-fold") },
    { name: "Keep separate: the kept-apart card's ⋯", pop: "work popover", act: (p) => p.keyboard.press("Enter"), focus: workOpener },
  ];

  for (const row of rows) {
    test(`${row.pop}: ${row.name}`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 420 });
      await openReader(page);
      const room = await rail(page).evaluate((l) => l.scrollHeight - l.clientHeight);
      expect(room).toBeGreaterThanOrEqual(20);
      await open(page, row.pop);
      await row.act(page);
      await expect(page.locator(MENU[row.pop])).toHaveCount(row.open ? 1 : 0);
      const want = row.focus(page);
      if (want === "body") {
        expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
      } else {
        await expect(want).toBeFocused();
      }
    });
  }

  // The probe scenarios, from a split card's row (its page menu's opener
  // sits in a card a fold click repaints).
  async function splitAndOpenRow(page: Page): Promise<void> {
    await openReader(page);
    await rowMenu(page, TSPLIT);
    await page.locator("#wikiSeriesMenu [data-thread-split]").click();
    await expect(card(page, TSPLIT)).toHaveCount(1);
    const sf = card(page, TSPLIT).locator(":scope > .wiki-thread-fold");
    if ((await sf.getAttribute("aria-expanded")) !== "true") await sf.click();
    await expect(threadRow(page, TSPLIT)).toHaveCount(1);
    await rowMenu(page, TSPLIT);
    await expect(page.locator("#wikiSeriesMenu")).toHaveCount(1);
  }

  test("probe 1: another card's fold clicked with a split row's page menu open keeps focus on that fold", async ({ page }) => {
    await splitAndOpenRow(page);
    const other = card(page, TKEY).locator(":scope > .wiki-thread-fold");
    await other.click();
    await expect(page.locator("#wikiSeriesMenu")).toHaveCount(0);
    await expect(other).toBeFocused();
  });

  test("probe 2: a click into the search box after a repaint with the page menu open keeps focus in the search box", async ({ page }) => {
    await splitAndOpenRow(page);
    expect(await repaint(page, "page menu")).toBe(true);
    await expect(page.locator("#wikiSeriesMenu")).toHaveCount(1);
    await search(page).click();
    await expect(page.locator("#wikiSeriesMenu")).toHaveCount(0);
    await expect(search(page)).toBeFocused();
    await page.keyboard.type("zz");
    await expect(search(page)).toHaveValue("zz");
  });

  // The verify pass's survivor: Home in the arrow-key delegate. A page menu
  // with an item between its boundary item and its field: the series wiki's
  // `other` join item.
  test("Home in a page menu moves to its first item", async ({ page }) => {
    await openReader(page, ST);
    const row = page.locator(`#wikiList .wiki-list-item.thread-row[data-relpath="${LA}"]`);
    await row.locator("[data-series-menu]").focus();
    await page.keyboard.press("Enter");
    const items = page.locator("#wikiSeriesMenu [role^='menuitem']");
    await expect(items.first()).toBeFocused();
    expect(await items.count()).toBeGreaterThanOrEqual(2);
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(items.first()).toBeFocused();
  });
});
