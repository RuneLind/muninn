/**
 * /wiki rail — **grouped Work threads** (plan
 * `muninn-wiki-work-thread-grouping`, PR 3): the Group control and its menu
 * (mouse and keyboard), the Related and Areas stops, the group and child
 * cards, `+ N more threads`, the shared context line, the lift out of Activity
 * and its return when a child or the group closes, pins inside groups, facets
 * before the five-card cap with names that do not move, the preference record
 * (D17) across a reload, another tab, a refused write and a malformed value,
 * relations incomplete (Threads with a reason), no ledger (no section), a
 * read-only wiki, and the two new headers' width table at the 260 and 300 px
 * rails in both themes.
 *
 * ONE muninn, THREE temp wikis, ONE fake `node:http` claude-usage:
 *
 *  - `wsgroups` — eleven sessions, one focus page each, so eleven threads.
 *    `alpha-1`…`alpha-4` share `series: alpha` (a SERIES group of four, the
 *    first card); `misc/rel-1` and `notes/rel-2` are joined by `rel-2`'s
 *    `related:` entry (a RELATED group named by its anchor); `solo-1`…`solo-5`
 *    are lone threads, `solo-1` and `solo-2` sharing `project: proj-b` (a
 *    PROJECT group at Areas). The alpha-1 and alpha-2 sessions also touch
 *    `plans/ctx.md` (the shared context line).
 *  - `wsgroupsro` — the same files under `WIKI_READONLY_ROOTS`.
 *  - `wsgplain` — the ledger 404s the sessions form: no section (D11).
 *  - `wsgbroad` — five threads in one series `big` (`big-1`…`big-5`): a group
 *    whose pinned fifth child shows past the first three beside `+ 1 more`.
 *
 * Synthetic names only (D11 of the plan: no NAV data). No model calls, and the
 * only writes are the reader's own localStorage.
 *
 * Screenshots for the prototype comparison are written only when
 * `WIKI_GROUP_SHOTS` names a directory outside the repo; the case that takes
 * them asserts either way, so CI runs it and never skips.
 *
 * SPAWN ENV: `e2eEnv()` blanks `CLAUDE_USAGE_URL`, so it is set AFTER it.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { RAIL_WIDTH_KEY } from "../src/dashboard/views/components/wiki-rail-width.ts";
import { foldsKey, threadPinKey, type RailGroupCard, type RailThreadCard } from "../src/dashboard/views/components/wiki-recents.ts";
import { threadCardHeaderHtml, threadGroupHeaderHtml } from "../src/dashboard/views/components/wiki-thread-view.ts";
import { workGroupKey } from "../src/dashboard/views/components/wiki-work-group-record.ts";
import { WIKI_REFETCH_MIN_INTERVAL_MS } from "../src/dashboard/views/components/wiki-refresh.ts";

const PORT = e2ePort("wiki-rail-thread-groups");
const LEDGER_PORT = e2ePort("wiki-rail-thread-groups/ledger");
const BASE = `http://127.0.0.1:${PORT}`;
const LEDGER_BASE = `http://127.0.0.1:${LEDGER_PORT}`;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const GROUPS = "wsgroups";
const RO = "wsgroupsro";
const PLAIN = "wsgplain";
const BROAD = "wsgbroad";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.now();

const A = ["plans/alpha-1.md", "plans/alpha-2.md", "plans/alpha-3.md", "plans/alpha-4.md"];
const REL1 = "misc/rel-1.md";
const REL2 = "notes/rel-2.md";
const SOLO = ["notes/solo-1.md", "notes/solo-2.md", "notes/solo-3.md", "notes/solo-4.md", "notes/solo-5.md"];
const CTX = "plans/ctx.md";
/** One session per focus page, newest first: the order of the threads. */
const FOCUS = [...A, REL1, REL2, ...SOLO];
const BIG = [1, 2, 3, 4, 5].map((i) => `plans/big-${i}.md`);
/** Five pages the first two `big` sessions only touch: a shared context past three. */
const BCTX = [1, 2, 3, 4, 5].map((i) => `notes/bctx-${i}.md`);
/** The focus pages a wiki's ledger serves, newest first. */
const focusOf = (wiki: string | undefined) => (wiki === GROUPS || wiki === RO ? FOCUS : wiki === BROAD ? BIG : []);

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
  const live = wiki === GROUPS || wiki === RO;
  const focus = focusOf(wiki);
  if (url.searchParams.get("sessions") === "1") {
    if (!focus.length) return json({ error: "not found" }, 404);
    const sessions = focus.map((p, i) => {
      const at = NOW - (i + 1) * HOUR;
      const files: [string, number][] = [[p, 5]];
      if (live && i < 2) files.push([CTX, 1]);
      if (wiki === BROAD && i < 2) for (const c of BCTX) files.push([c, 1]);
      return {
        id: `g${i}`,
        provider: "claude",
        title: `session ${i}`,
        first: at - 30 * 60_000,
        last: at,
        bulk: false,
        text: { from: "prompt", paths: [p], links: [], files: [] },
        files: files.map(([f, edits]) => ({ p: f, edits, firstMs: at - 30 * 60_000, lastMs: at })),
      };
    });
    const since = Number(url.searchParams.get("since"));
    const until = url.searchParams.has("until") ? Number(url.searchParams.get("until")) : Date.now();
    return json({ form: "sessions", root, since, until, limit: 200, truncated: false, sessions });
  }
  const until = url.searchParams.get("until");
  if (until) {
    // ctx.md had a write before the window, so the sessions only TOUCH it.
    const pre = live ? [{ p: CTX, w: NOW - 20 * DAY, s: 1 }] : wiki === BROAD ? BCTX.map((p) => ({ p, w: NOW - 20 * DAY, s: 1 })) : [];
    return json({ root, pages: pre, pageCount: pre.length, bulk: 10, limit: 5000, truncated: false, until: Number(until) });
  }
  const pages = focus.map((p, i) => ({ p, w: NOW - (i + 1) * HOUR, s: 1 }));
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

async function makeRoot(name: string): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-groups-${name}-`));
  roots[name] = root;
  await writeFile(
    path.join(root, ".wiki-reader.json"),
    JSON.stringify({ activity: { agePenalty: 0, hubPenalty: 0, planBoost: 0, rows: 8 }, project: { frontmatter: ["project"] } }),
    "utf8",
  );
  const write = async (rel: string, fm: string[], ago: number, body = "Body.") => {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, ["---", ...fm, "created: 2025-01-01", "---", "", body, ""].join("\n"), "utf8");
    const stamp = new Date(NOW - ago);
    await utimes(abs, stamp, stamp);
  };
  await write(A[0]!, ["title: Alpha one — the lead", "series: alpha", "series_label: Alpha series", "project: proj-a"], HOUR);
  await write(A[1]!, ["title: Alpha two", "series: alpha"], 2 * HOUR);
  await write(A[2]!, ["title: Alpha three", "series: alpha"], 3 * HOUR);
  await write(A[3]!, ["title: Alpha four", "series: alpha"], 4 * HOUR);
  await write(REL1, ["title: Rel one"], 5 * HOUR);
  await write(REL2, ["title: Rel two", 'related: ["[[misc/rel-1]]"]'], 6 * HOUR);
  for (const [i, rel] of SOLO.entries()) await write(rel, [`title: Solo ${i + 1}`, ...(i < 2 ? ["project: proj-b"] : [])], (7 + i) * HOUR);
  await write(CTX, ["title: Shared context page"], 20 * DAY);
  for (let i = 1; i <= 4; i++) await write(`notes/old-${i}.md`, [`title: Old ${i}`], (10 + i) * DAY);
}

async function makeBroadRoot(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-groups-${BROAD}-`));
  roots[BROAD] = root;
  await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify({ activity: { agePenalty: 0, hubPenalty: 0, planBoost: 0, rows: 8 } }), "utf8");
  for (const [i, rel] of BIG.entries()) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, ["---", `title: Big ${i + 1}`, "series: big", "created: 2025-01-01", "---", "", "Body.", ""].join("\n"), "utf8");
    const stamp = new Date(NOW - (i + 1) * HOUR);
    await utimes(abs, stamp, stamp);
  }
  for (const [i, rel] of BCTX.entries()) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, ["---", `title: Broad context ${i + 1}`, "created: 2025-01-01", "---", "", "Body.", ""].join("\n"), "utf8");
    const stamp = new Date(NOW - 20 * DAY);
    await utimes(abs, stamp, stamp);
  }
}

const cards = (page: Page) => page.locator("#wikiList > .wiki-thread-card");
const groupCard = (page: Page, key: string) => page.locator(`#wikiList > .wiki-thread-card[data-thread-group="${key}"]`);
const body = (page: Page, key: string) => page.locator(`.wiki-thread-gbody[data-thread-group-body="${key}"]`);
const relsIn = (page: Page, s: string) =>
  page.locator(`.wiki-list-item[data-section="${s}"]`).evaluateAll((els) => els.map((e) => e.getAttribute("data-relpath")));
const groupBtn = (page: Page) => page.locator("[data-work-group-menu]");
const menu = (page: Page) => page.locator(".wiki-work-menu");
const stored = (page: Page, wiki = GROUPS) => page.evaluate((k) => localStorage.getItem(k), workGroupKey(wiki));
/** Top-level cards as `kind:key`, the shape a test compares. */
const cardKeys = (page: Page) =>
  cards(page).evaluateAll((els) => els.map((e) => (e.hasAttribute("data-thread-group") ? `group:${e.getAttribute("data-thread-group")}` : `thread:${e.getAttribute("data-thread")}`)));

async function openReader(page: Page, wiki: string = GROUPS): Promise<void> {
  await fetch(`${BASE}/api/wiki/pages?wiki=${wiki}&refresh=1`);
  const listing = page.waitForResponse((r) => r.url().includes("/api/wiki/pages") && r.url().includes(`wiki=${wiki}`) && r.ok());
  await page.goto(`${BASE}/wiki?wiki=${wiki}`);
  await listing;
  await expect(page.locator('.wiki-list-sec[data-section="activity"]')).toHaveCount(1);
}

/** How one header fits (the threads spec's harness, for the two new headers):
 *  every text run inside the fold and the rail, the fold clear of the 📌,
 *  nothing cut by a clipping box, and each declared line's line count. */
const headerFit = (cardEl: Element) => {
  const r = (e: Element | Range) => e.getBoundingClientRect();
  const fold = cardEl.querySelector(".wiki-thread-fold")!;
  const pin = cardEl.querySelector(".wiki-thread-pin")!;
  const rail = document.querySelector(".wiki-layout > .wiki-pane:first-child")!;
  const label = cardEl.querySelector(".wiki-thread-label")!;
  const name = cardEl.querySelector(".wiki-thread-name")!;
  const issues: string[] = [];
  const linesOf = (el: Element) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const box = r(el);
    const tops = new Set(
      Array.from(range.getClientRects())
        .filter((b) => b.width > 0 && b.top + b.height / 2 <= box.bottom)
        .map((b) => Math.round(b.top + b.height / 2)),
    );
    const sorted = [...tops].sort((a, b) => a - b);
    return sorted.filter((t, i) => i === 0 || t - sorted[i - 1]! > 3).length;
  };
  const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
  const parts: Array<{ text: string; width: number }> = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (!t.data.trim() || t.parentElement!.closest(".wiki-sr-only")) continue;
    const range = document.createRange();
    range.selectNodeContents(t);
    const rects = Array.from(range.getClientRects()).filter((b) => b.width > 0);
    const byLine = new Map<number, { l: number; r: number }>();
    for (const b of rects) {
      const k = Math.round(b.top + b.height / 2);
      const o = byLine.get(k);
      byLine.set(k, { l: Math.min(o?.l ?? b.left, b.left), r: Math.max(o?.r ?? b.right, b.right) });
    }
    parts.push({ text: t.data, width: [...byLine.values()].reduce((s, x) => s + x.r - x.l, 0) });
    if (!rects.length) issues.push(`"${t.data}" draws no glyph`);
    for (const b of rects) {
      if (b.left < r(fold).left - 0.5 || b.right > r(fold).right + 0.5) issues.push(`"${t.data}" leaves the fold`);
      if (b.right > r(rail).right + 0.5) issues.push(`"${t.data}" leaves the rail`);
      for (let a = t.parentElement!; a !== cardEl; a = a.parentElement!) {
        const cs = getComputedStyle(a);
        if (cs.overflowX !== "visible" && (b.left < r(a).left - 0.5 || b.right > r(a).right + 0.5)) issues.push(`"${t.data}" cut by .${a.className}`);
        const clampedName = a === name && linesOf(name) === 2;
        if (cs.overflowY !== "visible" && !clampedName && (b.top < r(a).top - 0.5 || b.bottom > r(a).bottom + 0.5)) issues.push(`"${t.data}" cut vertically by .${a.className}`);
      }
    }
  }
  if (r(fold).right > r(pin).left + 0.5) issues.push("the fold runs under the 📌");
  if (r(pin).right > r(rail).right + 0.5) issues.push("the 📌 leaves the rail");
  const lines = Array.from(cardEl.querySelectorAll(".wiki-thread-line")).map((l) => ({ cls: l.className, lines: linesOf(l) }));
  const partLines = Array.from(cardEl.querySelectorAll(".wiki-thread-line > span")).map((q) => ({ text: q.textContent, lines: linesOf(q) }));
  return { issues, nameLines: linesOf(name), lines, partLines, label: r(label).width, parts };
};

/** The two new headers' width table rows, built by the real renderers. */
const TABLE_NOW = new Date(2026, 9, 15, 10, 0).getTime();
const at = (mo: number, d: number, h: number, m: number) => new Date(2026, mo, d, h, m).getTime();
const SPANS = [
  { form: "cross-day, older → yesterday", first: at(9, 12, 5, 21), last: at(9, 14, 23, 51) },
  { form: "cross-day, yesterday → today", first: at(9, 14, 5, 21), last: at(9, 15, 9, 45) },
] as const;
const NAMES = ["Alpha", "Alpha work on the long-running migration of every remaining reader surface to the new store"];
const sessionsOf = (n: number, span: (typeof SPANS)[number]) =>
  Array.from({ length: n }, (_, i) => ({ id: `w${i}`, provider: "claude", title: "", first: i === 0 ? span.first : span.first + 1000, last: i === 0 ? span.last : span.last - 1000 }));
function groupRows(): { id: string; html: string }[] {
  const rows: { id: string; html: string }[] = [];
  for (const threads of [2, 17])
    for (const n of [1, 12, 123])
      for (const moves of [0, 999])
        for (const span of SPANS)
          for (const [ni, name] of NAMES.entries())
            for (const label of ["series", "related", "project"] as const) {
              const card: RailGroupCard = {
                group: true, key: "x", foldKey: "group:anchor:x", toggleKey: "group:anchor:x", open: false, label, name,
                pinned: false, pinAnchor: "x", anchorVisible: !(threads === 17 && n === 123), threads,
                sessions: sessionsOf(n, span), movesYou: moves, children: [], hidden: 0, context: [], witnesses: [], score: 1,
              };
              rows.push({ id: `group ${threads}t ${n}s ✋${moves || "-"} ${span.form} name${ni} ${label}`, html: threadGroupHeaderHtml(card, true, TABLE_NOW, moves > 0) });
            }
  return rows;
}
const WHYS = ["anchor", "↔ 1 link", "↔ 12 links · ABCD-12345 +3 · series · project"];
const ALSO = [[], ["A long series label that names a whole piece of work"]];
function childRows(): { id: string; html: string }[] {
  const rows: { id: string; html: string }[] = [];
  for (const n of [1, 12, 123])
    for (const moves of [0, 999])
      for (const span of SPANS)
        for (const [ni, name] of NAMES.entries())
          for (const why of WHYS)
            for (const also of ALSO) {
              const card: RailThreadCard = {
                key: "x", foldKey: "thread:x", toggleKey: "thread:x", name, open: false, pinned: false, pinAnchor: "x",
                focus: [], created: [], touched: [], movesYou: moves, score: 1, sessions: sessionsOf(n, span),
                child: { anchor: why === "anchor", why, witnesses: [], also },
              };
              rows.push({ id: `child ${n}s ✋${moves || "-"} ${span.form} name${ni} why${WHYS.indexOf(why)} also${also.length}`, html: threadCardHeaderHtml(card, true, TABLE_NOW, moves > 0) });
            }
  return rows;
}

test.beforeAll(async () => {
  await makeRoot(GROUPS);
  await makeRoot(RO);
  await makeRoot(PLAIN);
  await makeBroadRoot();
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
      WIKI_READONLY_ROOTS: roots[RO]!,
      CLAUDE_USAGE_URL: LEDGER_BASE,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/wiki/pages?wiki=${GROUPS}`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
  for (const wiki of [GROUPS, RO, BROAD]) {
    const warm = Date.now() + 20_000;
    for (;;) {
      const b = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${wiki}&refresh=1`)).json()) as { work?: { threads: unknown[]; evidence?: unknown } };
      if (b.work?.threads.length === focusOf(wiki).length && b.work.evidence) break;
      if (Date.now() > warm) throw new Error("the work-sessions memo never warmed for " + wiki);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise<void>((resolve) => (ledger ? ledger.close(() => resolve()) : resolve()));
  for (const root of Object.values(roots)) await rm(root, { recursive: true, force: true });
});

test.describe("Wiki rail: grouped work threads", () => {
  test("defaults (D1): Related with every box checked; a series group first, open with its first child; five cards hold nine of eleven threads", async ({
    page,
  }) => {
    await openReader(page);
    await expect(groupBtn(page)).toContainText("Related");
    expect(await stored(page)).toBeNull();
    expect(await cardKeys(page)).toEqual([
      "group:group:series:alpha",
      `group:group:anchor:${REL1}`,
      `thread:thread:${SOLO[0]}`,
      `thread:thread:${SOLO[1]}`,
      `thread:thread:${SOLO[2]}`,
    ]);
    const alpha = groupCard(page, "group:series:alpha");
    await expect(alpha.locator(".wiki-thread-kind")).toHaveText("series");
    await expect(alpha.locator(".wiki-thread-name")).toContainText("Alpha series");
    await expect(alpha.locator(".wiki-thread-meta")).toContainText("4 threads · 4 sessions");
    await expect(alpha.locator(".wiki-thread-fold")).toHaveAttribute("aria-expanded", "true");
    await expect(alpha.locator(".wiki-thread-disclose")).toContainText("Hide 4 threads");
    // Three children show, the anchor open; `+ 1 more thread` holds the fourth.
    const kids = body(page, "group:series:alpha").locator(".wiki-thread-card");
    await expect(kids).toHaveCount(3);
    await expect(kids.nth(0).locator(".wiki-thread-fold")).toHaveAttribute("aria-expanded", "true");
    await expect(kids.nth(1).locator(".wiki-thread-fold")).toHaveAttribute("aria-expanded", "false");
    await expect(kids.nth(0).locator(".wiki-thread-why")).toHaveText("anchor");
    await expect(kids.nth(1).locator(".wiki-thread-why")).toContainText("↔ series");
    // Its text, then a screen-reader-only group name (the a11y case below).
    await expect(body(page, "group:series:alpha").locator(".wiki-thread-more")).toHaveText("+ 1 more thread in Alpha series");
    // Shared context: the touched page, once, not per child.
    await expect(body(page, "group:series:alpha").locator(".wiki-thread-context .wiki-thread-link")).toHaveText(["Shared context page"]);
    await expect(page.locator(".wiki-thread-touched")).toHaveCount(0);
    // The RELATED group is named by its anchor.
    const rel = groupCard(page, `group:anchor:${REL1}`);
    await expect(rel.locator(".wiki-thread-kind")).toHaveText("related");
    await expect(rel.locator(".wiki-thread-name")).toContainText("Rel one");
    // Parent and child folds have distinct accessible names.
    const parentName = await alpha.locator(".wiki-thread-fold").evaluate((e) => e.textContent);
    const childName = await kids.nth(0).locator(".wiki-thread-fold").evaluate((e) => e.textContent);
    expect(parentName).not.toBe(childName);
    // The menu: Related checked, all three boxes checked, card counts per stop.
    await groupBtn(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(page.locator('[data-work-stop="related"]')).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('[data-work-stop="threads"] .wiki-work-n')).toHaveText("11");
    await expect(page.locator('[data-work-stop="related"] .wiki-work-n')).toHaveText("7");
    for (const k of ["related", "issue", "series"]) await expect(page.locator(`[data-work-evidence="${k}"]`)).toHaveAttribute("aria-checked", "true");
  });

  test("the open child alone leaves Activity; closing the child, then the group, returns its rows; a series ghost marks the lift", async ({ page }) => {
    await openReader(page);
    const threadRows = await relsIn(page, "threads");
    expect(threadRows).toEqual([A[0]]);
    expect(await relsIn(page, "activity")).not.toContain(A[0]);
    // alpha-1 is a series member: its open series shows a ghost for the lifted row.
    await page.locator(".wiki-list-group.series .wiki-group-fold").first().click();
    const ghost = page.locator(`.wiki-list-ghost[data-ghost-relpath="${A[0]}"][data-ghost-reason="thread"]`);
    await expect(ghost).toHaveCount(1);
    // Close the child: the row returns to its series, the ghost goes, no thread row is left.
    await body(page, "group:series:alpha").locator(".wiki-thread-card").nth(0).locator(".wiki-thread-fold").click();
    expect(await relsIn(page, "threads")).toEqual([]);
    await expect(ghost).toHaveCount(0);
    await expect(page.locator(`.wiki-list-item[data-relpath="${A[0]}"]`)).toHaveCount(1);
    // Open the second child instead; then close the whole group.
    await body(page, "group:series:alpha").locator(".wiki-thread-card").nth(1).locator(".wiki-thread-fold").click();
    expect(await relsIn(page, "threads")).toEqual([A[1]]);
    await groupCard(page, "group:series:alpha").locator(".wiki-thread-fold").click();
    expect(await relsIn(page, "threads")).toEqual([]);
    await expect(body(page, "group:series:alpha")).toHaveCount(0);
    // Every page is one row at most.
    for (const rel of FOCUS) expect(await page.locator(`.wiki-list-item[data-relpath="${rel}"]`).count()).toBeLessThanOrEqual(1);
  });

  test("+ N more threads shows the rest, and focus lands on the first child it revealed", async ({ page }) => {
    await openReader(page);
    const more = body(page, "group:series:alpha").locator(".wiki-thread-more");
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(body(page, "group:series:alpha").locator(".wiki-thread-card")).toHaveCount(4);
    await expect(body(page, "group:series:alpha").locator(".wiki-thread-more")).toHaveCount(0);
    const focused = await page.evaluate(() => document.activeElement?.closest(".wiki-thread-card")?.getAttribute("data-thread"));
    expect(focused).toBe(`thread:${A[3]}`);
  });

  // Fix round 1 batch 3 (F1): the pinned fifth child is drawn before the press
  // and moves to its own place after it; focus goes to big-4, the one revealed.
  test("+ N more threads with a pinned child past the first three: focus lands on the child the press revealed", async ({ page }) => {
    await page.addInitScript(([k, v]) => localStorage.setItem(k as string, v as string), [threadPinKey(BROAD), BIG[4]!] as const);
    await openReader(page, BROAD);
    const kids = body(page, "group:series:big").locator(".wiki-thread-card");
    await expect(kids).toHaveCount(4);
    expect(await kids.evaluateAll((els) => els.map((e) => e.getAttribute("data-thread")))).toEqual([BIG[0], BIG[1], BIG[2], BIG[4]].map((r) => `thread:${r}`));
    const more = body(page, "group:series:big").locator(".wiki-thread-more");
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(kids).toHaveCount(5);
    const focused = await page.evaluate(() => document.activeElement?.closest(".wiki-thread-card")?.getAttribute("data-thread"));
    expect(focused).toBe(`thread:${BIG[3]}`);
  });

  // Fix round 1 batch 4 (F3): each group's `+ N more threads` names its group,
  // and the shared context past three is a button that opens the full list.
  test("a11y: + N more threads names its group; the shared context's +N opens the rest in place, focus on the first it revealed", async ({ page }) => {
    await openReader(page);
    await expect(body(page, "group:series:alpha").locator(".wiki-thread-more")).toHaveAccessibleName("+ 1 more thread in Alpha series");
    await openReader(page, BROAD);
    const ctx = body(page, "group:series:big").locator(".wiki-thread-context");
    await expect(ctx.locator(".wiki-thread-link")).toHaveCount(3);
    const plus = ctx.getByRole("button", { name: /^\+2 more shared pages in / });
    await expect(plus).toHaveCount(1);
    await plus.focus();
    await page.keyboard.press("Enter");
    await expect(ctx.locator(".wiki-thread-link")).toHaveCount(5);
    await expect(ctx.locator(".wiki-thread-ctx-more")).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Broad context 4");
  });

  // Fix round 1 batch 4 (F1): a rail control clicked while the menu is open
  // closes the menu in its own render and keeps its focus.
  test("menu open: a click on a child's fold or a 📌 closes the menu in ONE render and keeps focus on what was pressed", async ({ page }) => {
    await openReader(page);
    const countRenders = () =>
      page.evaluate(() => {
        const w = window as unknown as { __renders: number; __obs?: MutationObserver };
        w.__obs?.disconnect();
        w.__renders = 0;
        w.__obs = new MutationObserver((rs) => {
          for (const r of rs) if (r.addedNodes.length || r.removedNodes.length) w.__renders++;
        });
        w.__obs.observe(document.getElementById("wikiList")!, { childList: true });
      });
    const renders = () => page.evaluate(() => (window as unknown as { __renders: number }).__renders);
    // Cards below the open menu (the menu covers the first ones).
    const solo = `thread:${SOLO[2]}`;
    const card = page.locator(`#wikiList > .wiki-thread-card[data-thread="${solo}"]`);
    await groupBtn(page).click();
    await expect(menu(page)).toBeVisible();
    const was = await card.locator(".wiki-thread-fold").getAttribute("aria-expanded");
    await countRenders();
    await card.locator(".wiki-thread-fold").click();
    await expect(menu(page)).toHaveCount(0);
    await expect(card.locator(".wiki-thread-fold")).toHaveAttribute("aria-expanded", was === "true" ? "false" : "true");
    expect(await renders()).toBe(1);
    expect(await page.evaluate(() => document.activeElement?.closest(".wiki-thread-card")?.getAttribute("data-thread"))).toBe(solo);
    expect(await page.evaluate(() => document.activeElement?.classList.contains("wiki-thread-fold"))).toBe(true);
    // The 📌 the same way: the card moves first, focus follows it.
    await groupBtn(page).click();
    await expect(menu(page)).toBeVisible();
    await countRenders();
    await card.locator(".wiki-thread-pin").click();
    await expect(menu(page)).toHaveCount(0);
    expect(await renders()).toBe(1);
    expect(await page.evaluate(() => document.activeElement?.closest(".wiki-thread-card")?.getAttribute("data-thread"))).toBe(solo);
    expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-thread-pin"))).toBe(true);
  });

  // Fix round 1 batch 4 (F2): the disabled boxes say why, and the two sets are named groups.
  test("a11y: the menu's two sets are labelled groups; a disabled box is described by its reason", async ({ page }) => {
    await openReader(page);
    await groupBtn(page).click();
    await expect(menu(page).getByRole("group", { name: "Group work by" }).getByRole("menuitemradio")).toHaveCount(3);
    await expect(menu(page).getByRole("group", { name: "Connect threads by" }).getByRole("menuitemcheckbox")).toHaveCount(3);
    await expect(page.locator('[data-work-evidence="series"]')).toHaveAccessibleDescription("");
    await page.locator('[data-work-stop="threads"]').click();
    await groupBtn(page).click();
    for (const k of ["related", "issue", "series"])
      await expect(page.locator(`[data-work-evidence="${k}"]`)).toHaveAccessibleDescription("Applies to Related and Areas.");
    await expect(menu(page).getByRole("menuitemcheckbox", { name: "Same series" })).toHaveAttribute("aria-disabled", "true");
  });

  // Fix round 1 batch 3 (focus loss): a repaint nobody in this tab asked for
  // keeps focus on the open menu's item, and Escape still closes the menu.
  const menuFocus = (p: Page) => p.evaluate(() => document.activeElement?.getAttribute("data-work-evidence") ?? document.activeElement?.tagName ?? null);
  async function openMenuOnSeries(p: Page): Promise<void> {
    await groupBtn(p).focus();
    await p.keyboard.press("Enter");
    await p.keyboard.press("End");
    expect(await menuFocus(p)).toBe("series");
  }
  async function escapeReturnsToButton(p: Page): Promise<void> {
    await p.keyboard.press("Escape");
    await expect(menu(p)).toHaveCount(0);
    expect(await p.evaluate(() => document.activeElement?.hasAttribute("data-work-group-menu"))).toBe(true);
  }

  test("focus: another tab's write repaints this tab's open menu with focus kept on its item; Escape still closes it", async ({ context }) => {
    const a = await context.newPage();
    const b = await context.newPage();
    await openReader(a);
    await openReader(b);
    await openMenuOnSeries(b);
    await groupBtn(a).click();
    await a.locator('[data-work-evidence="issue"]').click();
    await expect(b.locator('[data-work-evidence="issue"]')).toHaveAttribute("aria-checked", "false");
    await expect(menu(b)).toBeVisible();
    expect(await menuFocus(b)).toBe("series");
    await escapeReturnsToButton(b);
  });

  test("focus: Escape closes the open menu even when focus has fallen to the page", async ({ page }) => {
    await openReader(page);
    await openMenuOnSeries(page);
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    expect(await menuFocus(page)).toBe("BODY");
    await escapeReturnsToButton(page);
  });

  test("focus: a window-focus refetch that repaints keeps focus on the open menu's item; Escape still closes it", async ({ page }) => {
    let renamed = false;
    await page.route(
      (u) => u.pathname === "/api/wiki/pages" && u.searchParams.get("wiki") === GROUPS,
      async (route) => {
        const res = await route.fetch();
        const json = (await res.json()) as { pages: { relPath: string; title: string }[] };
        if (renamed) for (const p of json.pages) if (p.relPath === "notes/old-1.md") p.title = "Old 1, renamed";
        await route.fulfill({ response: res, json });
      },
    );
    await page.clock.install();
    await openReader(page);
    await openMenuOnSeries(page);
    renamed = true;
    const refetched = page.waitForResponse((r) => r.url().includes("/api/wiki/pages") && r.url().includes(`wiki=${GROUPS}`) && r.url().includes("refresh=1"));
    await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refetched;
    await expect(page.locator('.wiki-list-item[data-relpath="notes/old-1.md"]')).toContainText("Old 1, renamed");
    await expect(menu(page)).toBeVisible();
    expect(await menuFocus(page)).toBe("series");
    await escapeReturnsToButton(page);
  });

  test("keyboard: the Group menu opens, moves, toggles a box in place, picks a stop and closes back on its button", async ({ page }) => {
    await openReader(page);
    await groupBtn(page).focus();
    await page.keyboard.press("Enter");
    await expect(menu(page)).toBeVisible();
    await expect(groupBtn(page)).toHaveAttribute("aria-expanded", "true");
    // Focus starts on the checked stop.
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-work-stop"))).toBe("related");
    // Down to the boxes: Areas, then the three boxes; End is the last box.
    await page.keyboard.press("End");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-work-evidence"))).toBe("series");
    // Space clears Same series: the alpha group dissolves, the menu stays, focus stays.
    await page.keyboard.press(" ");
    await expect(page.locator('[data-work-evidence="series"]')).toHaveAttribute("aria-checked", "false");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-work-evidence"))).toBe("series");
    await expect(groupCard(page, "group:series:alpha")).toHaveCount(0);
    expect(JSON.parse((await stored(page))!)).toEqual({ version: 1, evidence: { series: false } });
    // Escape closes and returns focus to the button.
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-work-group-menu"))).toBe(true);
    // ArrowDown on the button opens; Home is the first stop; Enter picks Threads.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Home");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-work-stop"))).toBe("threads");
    await page.keyboard.press("Enter");
    await expect(menu(page)).toHaveCount(0);
    await expect(groupBtn(page)).toContainText("Threads");
    expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-work-group-menu"))).toBe(true);
    expect(JSON.parse((await stored(page))!)).toEqual({ version: 1, evidence: { series: false }, stop: "threads" });
    // At Threads the boxes show disabled and keep their values.
    await groupBtn(page).click();
    await expect(page.locator('[data-work-evidence="series"]')).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator('[data-work-evidence="series"]')).toHaveAttribute("aria-checked", "false");
    await expect(page.locator('[data-work-evidence="related"]')).toHaveAttribute("aria-checked", "true");
    // aria-disabled: Playwright would wait for it to enable, so the click is forced.
    await page.locator('[data-work-evidence="related"]').click({ force: true });
    await expect(page.locator('[data-work-evidence="related"]')).toHaveAttribute("aria-checked", "true");
    // A click outside closes it.
    await page.locator(".wiki-list-sec[data-section='activity']").click();
    await expect(menu(page)).toHaveCount(0);
  });

  test("Threads draws today's cards: no group card, the first five threads", async ({ page }) => {
    await page.addInitScript(([k, v]) => localStorage.setItem(k as string, v as string), [workGroupKey(GROUPS), JSON.stringify({ version: 1, stop: "threads" })] as const);
    await openReader(page);
    await expect(groupBtn(page)).toContainText("Threads");
    expect(await cardKeys(page)).toEqual(FOCUS.slice(0, 5).map((r) => `thread:thread:${r}`));
    await expect(page.locator(".wiki-thread-group, .wiki-thread-gbody, .wiki-thread-why")).toHaveCount(0);
  });

  test("Areas joins the shared project; a saved choice survives a reload per wiki and leaves the read-only copy on Related", async ({ page }) => {
    await openReader(page);
    await groupBtn(page).click();
    await page.locator('[data-work-stop="areas"]').click();
    await expect(groupBtn(page)).toContainText("Areas");
    await expect(groupCard(page, "group:project:proj-b")).toHaveCount(1);
    await expect(groupCard(page, "group:project:proj-b").locator(".wiki-thread-kind")).toHaveText("project");
    await page.reload();
    await expect(groupBtn(page)).toContainText("Areas");
    await expect(groupCard(page, "group:project:proj-b")).toHaveCount(1);
    await openReader(page, RO);
    await expect(groupBtn(page)).toContainText("Related");
  });

  test("a read-only wiki: the control works, and the choice is its own", async ({ page }) => {
    await openReader(page, RO);
    await expect(groupCard(page, "group:series:alpha")).toHaveCount(1);
    await groupBtn(page).click();
    await page.locator('[data-work-stop="threads"]').click();
    await expect(groupBtn(page)).toContainText("Threads");
    expect(JSON.parse((await stored(page, RO))!)).toEqual({ version: 1, stop: "threads" });
    expect(await stored(page, GROUPS)).toBeNull();
  });

  test("forced colours drop the shadows: an open group's body and a closed group's stack keep a real border", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await openReader(page);
    const edges = (sel: string) =>
      page.locator(sel).evaluate((e) => {
        const s = getComputedStyle(e);
        const side = (k: "Left" | "Right" | "Bottom") => `${s.getPropertyValue(`border-${k.toLowerCase()}-style`)} ${s.getPropertyValue(`border-${k.toLowerCase()}-width`)}`;
        return { shadow: s.boxShadow, left: side("Left"), right: side("Right"), bottom: side("Bottom") };
      });
    // The open series group: its body's outline was a box shadow, gone here.
    const gbody = await edges(`.wiki-thread-gbody[data-thread-group-body="group:series:alpha"]`);
    expect.soft(gbody.shadow).toBe("none");
    for (const side of [gbody.left, gbody.right, gbody.bottom]) expect.soft(side).toBe("solid 2px");
    // The closed related group: its stack was a box shadow; a double edge stands in.
    await expect(groupCard(page, `group:anchor:${REL1}`)).not.toHaveClass(/\bopen\b/);
    const stack = await edges(`#wikiList > .wiki-thread-card[data-thread-group="group:anchor:${REL1}"]`);
    expect.soft(stack.shadow).toBe("none");
    expect.soft(stack.right).toBe("double 3px");
    expect.soft(stack.bottom).toBe("double 3px");
    // A closed thread card is not stacked.
    const solo = await edges(`#wikiList > .wiki-thread-card[data-thread="thread:${SOLO[0]}"]`);
    expect.soft(solo.right).toBe("solid 1px");
  });

  test("facets apply before the cap and never rename a group; a hidden anchor says so", async ({ page }) => {
    await openReader(page);
    // folder=notes: the alpha group and rel-1 (the anchor, in misc/) are out.
    await page.locator("#wikiFilters").evaluate((el) => ((el as HTMLDetailsElement).open = true));
    await page.selectOption("#wikiFolder", "notes");
    const rel = groupCard(page, `group:anchor:${REL1}`);
    await expect(rel.locator(".wiki-thread-name")).toContainText("Rel one");
    await expect(rel.locator(".wiki-thread-meta")).toContainText("anchor outside the filters");
    await expect(rel.locator(".wiki-thread-meta")).toContainText("1 thread");
    // The cap is taken after the drop: solo-4 is in now.
    expect(await cardKeys(page)).toEqual([`group:group:anchor:${REL1}`, ...SOLO.slice(0, 4).map((r) => `thread:thread:${r}`)]);
  });

  test("pins in groups: a child's 📌 moves its group first and marks the child; the group's 📌 clears it; both survive a reload", async ({ page }) => {
    await openReader(page);
    const rel = groupCard(page, `group:anchor:${REL1}`);
    await rel.locator(".wiki-thread-fold").click();
    const rel2 = body(page, `group:anchor:${REL1}`).locator(`.wiki-thread-card[data-thread="thread:${REL2}"]`);
    await rel2.locator(".wiki-thread-pin").click();
    expect(await page.evaluate((k) => localStorage.getItem(k), threadPinKey(GROUPS))).toBe(REL2);
    expect((await cardKeys(page))[0]).toBe(`group:group:anchor:${REL1}`);
    await expect(groupCard(page, `group:anchor:${REL1}`)).toHaveClass(/\bpinned\b/);
    await expect(groupCard(page, `group:anchor:${REL1}`).locator(".wiki-thread-pin")).toHaveAttribute("aria-pressed", "true");
    await expect(rel2.locator(".wiki-thread-pin")).toHaveAttribute("aria-pressed", "true");
    await expect(body(page, `group:anchor:${REL1}`).locator(`.wiki-thread-card[data-thread="thread:${REL1}"] .wiki-thread-pin`)).toHaveAttribute("aria-pressed", "false");
    await page.reload();
    expect((await cardKeys(page))[0]).toBe(`group:group:anchor:${REL1}`);
    // The group's 📌, pressed, clears the pin; focus stays on it.
    const gpin = groupCard(page, `group:anchor:${REL1}`).locator(".wiki-thread-pin");
    await gpin.focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate((k) => localStorage.getItem(k), threadPinKey(GROUPS))).toBeNull();
    expect((await cardKeys(page))[0]).toBe("group:group:series:alpha");
    expect(await page.evaluate(() => document.activeElement?.closest(".wiki-thread-card")?.getAttribute("data-thread-group"))).toBe(`group:anchor:${REL1}`);
    // The group's 📌, unpressed, pins the anchor.
    await groupCard(page, `group:anchor:${REL1}`).locator(".wiki-thread-pin").click();
    expect(await page.evaluate((k) => localStorage.getItem(k), threadPinKey(GROUPS))).toBe(REL1);
  });

  test("across tabs: a stop change in one tab repaints the other, which writes nothing back", async ({ context }) => {
    await context.addInitScript(([key]) => {
      const w = window as unknown as { __recordWrites: number };
      w.__recordWrites = 0;
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k: string, v: string) {
        if (k === key) w.__recordWrites++;
        return set.call(this, k, v);
      };
    }, [workGroupKey(GROUPS)] as const);
    const a = await context.newPage();
    const b = await context.newPage();
    await openReader(a);
    await openReader(b);
    await groupBtn(a).click();
    await a.locator('[data-work-stop="threads"]').click();
    await expect(groupBtn(b)).toContainText("Threads");
    await expect(b.locator(".wiki-thread-group")).toHaveCount(0);
    expect(await b.evaluate(() => (window as unknown as { __recordWrites: number }).__recordWrites)).toBe(0);
    // b's next choice merges onto a's record.
    await groupBtn(b).click();
    await b.locator('[data-work-evidence="issue"]').click({ force: true }); // disabled at Threads: no write
    await b.locator('[data-work-stop="related"]').click();
    await groupBtn(b).click();
    await b.locator('[data-work-evidence="issue"]').click();
    await expect(groupBtn(a)).toContainText("Related");
    expect(JSON.parse((await stored(a))!)).toEqual({ version: 1, stop: "related", evidence: { issue: false } });
    expect(await a.evaluate(() => (window as unknown as { __recordWrites: number }).__recordWrites)).toBe(1);
  });

  test("a refused write keeps the choice in this tab and says so; a reload is back on D1", async ({ page }) => {
    await page.addInitScript(([key]) => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k: string, v: string) {
        if (k === key) throw new DOMException("quota", "QuotaExceededError");
        return set.call(this, k, v);
      };
    }, [workGroupKey(GROUPS)] as const);
    await openReader(page);
    await groupBtn(page).click();
    await page.locator('[data-work-stop="threads"]').click();
    await expect(groupBtn(page)).toContainText("Threads");
    await expect(page.locator(".wiki-work-local")).toHaveText("this tab only");
    expect(await stored(page)).toBeNull();
    await page.reload();
    await expect(groupBtn(page)).toContainText("Related");
  });

  test("refused writes: a second edit keeps the first one this tab made", async ({ page }) => {
    await page.addInitScript(([key]) => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k: string, v: string) {
        if (k === key) throw new DOMException("quota", "QuotaExceededError");
        return set.call(this, k, v);
      };
    }, [workGroupKey(GROUPS)] as const);
    await openReader(page);
    await groupBtn(page).click();
    await page.locator('[data-work-evidence="series"]').click();
    await expect(page.locator('[data-work-evidence="series"]')).toHaveAttribute("aria-checked", "false");
    await page.locator('[data-work-evidence="related"]').click();
    await expect(page.locator('[data-work-evidence="related"]')).toHaveAttribute("aria-checked", "false");
    await expect(page.locator('[data-work-evidence="series"]')).toHaveAttribute("aria-checked", "false");
    await page.locator('[data-work-stop="areas"]').click();
    await expect(groupBtn(page)).toContainText("Areas");
    await groupBtn(page).click();
    await expect(page.locator('[data-work-evidence="series"]')).toHaveAttribute("aria-checked", "false");
    await expect(page.locator('[data-work-evidence="related"]')).toHaveAttribute("aria-checked", "false");
    await expect(page.locator(".wiki-work-local")).toHaveText("this tab only");
    expect(await stored(page)).toBeNull();
  });

  test("a malformed record reads as D1, and the first edit replaces it", async ({ page }) => {
    await openReader(page);
    const raws = ["{", ...[null, "1", 0, 1.5].map((version) => JSON.stringify({ version, stop: "threads" }))];
    for (const raw of raws) {
      await page.evaluate(([k, v]) => localStorage.setItem(k as string, v as string), [workGroupKey(GROUPS), raw] as const);
      await openReader(page);
      await expect(groupBtn(page), raw).toContainText("Related");
      await expect(groupCard(page, "group:series:alpha"), raw).toHaveCount(1);
      await groupBtn(page).click();
      await page.locator('[data-work-stop="areas"]').click();
      await expect(groupBtn(page), raw).toContainText("Areas");
      await expect(page.locator(".wiki-work-local"), raw).toHaveCount(0);
      expect(JSON.parse((await stored(page))!), raw).toEqual({ version: 1, stop: "areas" });
    }
    // A version-1 record is held, whatever its fields: an invalid field reads as its D1 default.
    const invalid = JSON.stringify({ version: 1, stop: "nope", evidence: { series: "x" } });
    await page.evaluate(([k, v]) => localStorage.setItem(k as string, v as string), [workGroupKey(GROUPS), invalid] as const);
    await openReader(page);
    await expect(groupBtn(page)).toContainText("Related");
    await expect(groupCard(page, "group:series:alpha")).toHaveCount(1);
  });

  test("a later build's record reads as D1 and is never written over: an edit stays in this tab and says so (C4)", async ({ page }) => {
    const later = JSON.stringify({ version: 9, stop: "threads", newThing: 1 });
    await openReader(page);
    await page.evaluate(([k, v]) => localStorage.setItem(k as string, v as string), [workGroupKey(GROUPS), later] as const);
    await openReader(page);
    await expect(groupBtn(page)).toContainText("Related");
    await groupBtn(page).click();
    await page.locator('[data-work-stop="areas"]').click();
    await expect(groupBtn(page)).toContainText("Areas");
    await expect(page.locator(".wiki-work-local")).toHaveText("this tab only");
    expect(await stored(page)).toBe(later);
  });

  test("relations incomplete: Related draws Threads with the reason and keeps the choice", async ({ page }) => {
    await page.route(
      (u) => u.pathname === "/api/wiki/pages" && u.searchParams.get("wiki") === GROUPS,
      async (route) => {
        const res = await route.fetch();
        const json = (await res.json()) as { work: { evidence: { relations: { complete: boolean; reasons: string[] } } } };
        json.work.evidence.relations.complete = false;
        json.work.evidence.relations.reasons = ["relations-cap"];
        await route.fulfill({ response: res, json });
      },
    );
    await openReader(page);
    await expect(groupBtn(page)).toContainText("Threads !");
    await expect(groupBtn(page)).toHaveAttribute("title", /Related is unavailable \(the relation lists hit their limit\)/);
    expect(await cardKeys(page)).toEqual(FOCUS.slice(0, 5).map((r) => `thread:thread:${r}`));
    await groupBtn(page).click();
    await expect(page.locator('[data-work-stop="related"]')).toHaveAttribute("aria-checked", "true");
    await expect(page.locator('[data-work-stop="related"] small')).toContainText("Unavailable: the relation lists hit their limit");
    expect(await stored(page)).toBeNull();
  });

  test("no ledger: no section and no control (D11)", async ({ page }) => {
    await openReader(page, PLAIN);
    await expect(page.locator('.wiki-list-sec[data-section="threads"]')).toHaveCount(0);
    await expect(groupBtn(page)).toHaveCount(0);
  });

  test("group folds are their own namespace: closing a group stores group:…, its child keeps thread:…", async ({ page }) => {
    await openReader(page);
    await groupCard(page, "group:series:alpha").locator(".wiki-thread-fold").click();
    await groupCard(page, "group:series:alpha").locator(".wiki-thread-fold").click();
    await body(page, "group:series:alpha").locator(".wiki-thread-card").nth(1).locator(".wiki-thread-fold").click();
    const folds = JSON.parse((await page.evaluate((k) => localStorage.getItem(k), foldsKey(GROUPS)))!) as string[];
    expect(folds).toContain(`thread:${A[1]}`);
    expect(folds.some((k) => k.includes("group:series:alpha"))).toBe(false);
    await groupCard(page, "group:series:alpha").locator(".wiki-thread-fold").click();
    const after = JSON.parse((await page.evaluate((k) => localStorage.getItem(k), foldsKey(GROUPS)))!) as string[];
    expect(after).toContain("closed:group:series:alpha");
  });

  test("the group and child headers' width table: every row fits at 260 and 300 px in both themes, nothing cut", async ({ page }) => {
    test.setTimeout(240_000);
    const groups = groupRows();
    const kids = childRows();
    const font = process.env.PW_TEST_CONNECT_WS_ENDPOINT ? "remote" : process.platform;
    const failures: string[] = [];
    const widest = new Map<string, number>();
    const passes = [
      { rail: 260, win: 1400, scheme: "light" },
      { rail: 260, win: 1400, scheme: "dark" },
      { rail: 300, win: 1400, scheme: "light" },
      { rail: 300, win: 1400, scheme: "dark" },
      { rail: 200, win: 445, scheme: "light" },
    ] as const;
    for (const p of passes) {
      await page.emulateMedia({ colorScheme: p.scheme });
      await page.addInitScript(([key, w]) => localStorage.setItem(key as string, String(w)), [RAIL_WIDTH_KEY, p.rail] as const);
      await page.setViewportSize({ width: p.win, height: 900 });
      await openReader(page);
      // Group headers at the top level, child headers inside an open group body.
      await cards(page).last().evaluate((el, html) => el.insertAdjacentHTML("afterend", html), groups.map((r) => r.html).join(""));
      await body(page, "group:series:alpha").locator(".wiki-thread-card").last().evaluate((el, html) => el.insertAdjacentHTML("afterend", html), kids.map((r) => r.html).join(""));
      const top = cards(page);
      const topTotal = await top.count();
      const inBody = body(page, "group:series:alpha").locator(".wiki-thread-card");
      const bodyTotal = await inBody.count();
      const measured: Array<{ id: string; kind: "group" | "child"; fit: Awaited<ReturnType<typeof headerFit>> }> = [];
      for (let i = 0; i < groups.length; i++) measured.push({ id: groups[i]!.id, kind: "group", fit: await top.nth(topTotal - groups.length + i).evaluate(headerFit) });
      for (let i = 0; i < kids.length; i++) measured.push({ id: kids[i]!.id, kind: "child", fit: await inBody.nth(bodyTotal - kids.length + i).evaluate(headerFit) });
      const list = await page.locator("#wikiList").evaluate((e) => e.scrollWidth - e.clientWidth);
      if (list > 0) failures.push(`${p.rail}/${p.scheme}: #wikiList scrolls ${list} px sideways`);
      for (const m of measured) {
        const at = `${font} ${p.rail}/${p.scheme} [${m.id}]`;
        for (const issue of m.fit.issues) failures.push(`${at}: ${issue}`);
        // Tally and span: one line each at 260 and 300; two below.
        const maxLines = p.rail >= 260 ? 1 : 2;
        for (const l of m.fit.lines) {
          if (l.cls.includes("wiki-thread-why")) continue;
          if (l.lines > maxLines) failures.push(`${at}: .${l.cls} takes ${l.lines} lines`);
        }
        // A part never breaks inside itself (the chip may, past the line).
        // At 260 and 300 the also chip (its label cut to 24 characters) is one line too.
        for (const q of m.fit.partLines)
          if (q.lines > 1 && (p.rail >= 260 || !String(q.text).startsWith("also "))) failures.push(`${at}: "${q.text}" breaks inside itself`);
        if (m.fit.nameLines > 2) failures.push(`${at}: the name takes ${m.fit.nameLines} lines`);
        if (p.rail >= 260 && p.scheme === "light") {
          const lk = `${m.kind} label @${p.rail}`;
          widest.set(lk, Math.min(widest.get(lk) ?? Infinity, m.fit.label));
          for (const part of m.fit.parts) if (!NAMES.includes(part.text)) widest.set(part.text, Math.max(widest.get(part.text) ?? 0, part.width));
          const why = m.fit.lines.find((l) => l.cls.includes("wiki-thread-why"));
          const form = m.kind === "child" ? m.id.replace(/^.* (why\d also\d)$/, "$1") : "anchor outside";
          if (why) widest.set(`why lines @${p.rail} ${form}`, Math.max(widest.get(`why lines @${p.rail} ${form}`) ?? 0, why.lines));
        }
      }
    }
    console.log(`[group width table, ${font}] ` + JSON.stringify(Object.fromEntries([...widest].map(([k, v]) => [k, Math.round(v * 10) / 10]))));
    const kinds = new Map<string, number>();
    for (const f of failures) {
      const k = f.replace(/\[[^\]]*\]/, "").replace(/"[^"]*"/, "…");
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    expect(failures.slice(0, 20), `${failures.length} failures: ${JSON.stringify(Object.fromEntries(kinds))}`).toEqual([]);
  });

  test("both themes at 260 and 300 px: the open menu stays inside the rail and the list never scrolls sideways", async ({ page }) => {
    // With WIKI_GROUP_SHOTS set (a directory outside the repo), each state is
    // also saved for the comparison with the real-reader prototype.
    const dir = process.env.WIKI_GROUP_SHOTS;
    for (const rail of [260, 300])
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.addInitScript(([key, w]) => localStorage.setItem(key as string, String(w)), [RAIL_WIDTH_KEY, rail] as const);
        await page.setViewportSize({ width: 1300, height: 1100 });
        await openReader(page);
        const pane = page.locator(".wiki-layout > .wiki-pane:first-child");
        if (dir) await pane.screenshot({ path: path.join(dir, `groups-${rail}-${scheme}.png`) });
        await groupBtn(page).click();
        const [m, r] = await Promise.all([menu(page).boundingBox(), pane.boundingBox()]);
        expect(m!.x, `${rail}/${scheme}`).toBeGreaterThanOrEqual(r!.x);
        expect(m!.x + m!.width, `${rail}/${scheme}`).toBeLessThanOrEqual(r!.x + r!.width + 0.5);
        expect(await page.locator("#wikiList").evaluate((e) => e.scrollWidth - e.clientWidth), `${rail}/${scheme}`).toBe(0);
        if (dir) await pane.screenshot({ path: path.join(dir, `groups-menu-${rail}-${scheme}.png`) });
      }
  });
});
