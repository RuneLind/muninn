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
 * ONE muninn, FIVE temp wikis, ONE fake `node:http` claude-usage:
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
 *  - `wsgfocus` — the focus table's wiki: a series and a thread whose keys
 *    carry a `"` (see the last describe block).
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
/** `wsgfocus` (the focus-restore table): a series whose name and a lone
 *  thread whose path carry a `"`, so every key the restore looks up needs
 *  `CSS.escape`. Five series threads (`+ 2 more`), three lone ones. */
const FOCUSW = "wsgfocus";
const FSERIES = 'q"t';
const FQ = [1, 2, 3, 4, 5].map((i) => `plans/fq-${i}.md`);
const FLONE = ['notes/l"one.md', "notes/lone-2.md", "notes/lone-3.md"];
const FFOCUS = [...FQ, ...FLONE];
/** The focus pages a wiki's ledger serves, newest first. */
const focusOf = (wiki: string | undefined) =>
  wiki === GROUPS || wiki === RO ? FOCUS : wiki === BROAD ? BIG : wiki === FOCUSW ? FFOCUS : [];
/** Pages the first two sessions only touch (a shared context past three). */
const ctxOf = (wiki: string | undefined) => (wiki === BROAD || wiki === FOCUSW ? BCTX : []);

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
      if (i < 2) for (const c of ctxOf(wiki)) files.push([c, 1]);
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
    // PR 4's focus rows: a second session on the focus wiki's first lone
    // thread, so that card offers `▸ split into 2 sessions`. One edit, 7.5
    // days old (named in its prompt, so a focus): it adds 0.07 raw, which
    // leaves the card order as it was.
    if (wiki === FOCUSW) {
      const at = NOW - 180 * HOUR;
      sessions.push({
        id: "gx",
        provider: "claude",
        title: "session gx",
        first: at - 30 * 60_000,
        last: at,
        bulk: false,
        text: { from: "prompt", paths: [FLONE[0]!], links: [], files: [] },
        files: [{ p: FLONE[0]!, edits: 1, firstMs: at - 30 * 60_000, lastMs: at }],
      });
    }
    const since = Number(url.searchParams.get("since"));
    const until = url.searchParams.has("until") ? Number(url.searchParams.get("until")) : Date.now();
    return json({ form: "sessions", root, since, until, limit: 200, truncated: false, sessions });
  }
  const until = url.searchParams.get("until");
  if (until) {
    // ctx.md had a write before the window, so the sessions only TOUCH it.
    const pre = live ? [{ p: CTX, w: NOW - 20 * DAY, s: 1 }] : ctxOf(wiki).map((p) => ({ p, w: NOW - 20 * DAY, s: 1 }));
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

async function makeFocusRoot(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-groups-${FOCUSW}-`));
  roots[FOCUSW] = root;
  await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify({ activity: { agePenalty: 0, hubPenalty: 0, planBoost: 0, rows: 8 } }), "utf8");
  const write = async (rel: string, fm: string[], ago: number) => {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, ["---", ...fm, "created: 2025-01-01", "---", "", "Body.", ""].join("\n"), "utf8");
    const stamp = new Date(NOW - ago);
    await utimes(abs, stamp, stamp);
  };
  for (const [i, rel] of FQ.entries()) await write(rel, [`title: Quote ${i + 1}`, `series: '${FSERIES}'`], (i + 1) * HOUR);
  for (const [i, rel] of FLONE.entries()) await write(rel, [`title: Lone ${i + 1}`], (6 + i) * HOUR);
  for (const [i, rel] of BCTX.entries()) await write(rel, [`title: Focus context ${i + 1}`], 20 * DAY);
  // Bookkeeping pages: the rail's foldable section header.
  for (const rel of ["index.md", "log.md"]) await write(rel, [`title: ${rel}`], 30 * DAY);
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
                ageMs: span.last,
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
                focus: [], created: [], touched: [], movesYou: moves, score: 1, sessions: sessionsOf(n, span), ageMs: span.last,
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
  await makeFocusRoot();
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
  for (const wiki of [GROUPS, RO, BROAD, FOCUSW]) {
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
    // Four stops since PR 4 (Sessions first).
    await expect(menu(page).getByRole("group", { name: "Group work by" }).getByRole("menuitemradio")).toHaveCount(4);
    await expect(menu(page).getByRole("group", { name: "Connect threads by" }).getByRole("menuitemcheckbox")).toHaveCount(3);
    // Each heading is the group's name only, not also a line inside it.
    for (const name of ["Group work by", "Connect threads by"])
      expect(await menu(page).getByRole("group", { name }).ariaSnapshot()).not.toMatch(new RegExp(`^\\s*- text: ${name}`, "m"));
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

  // Fix round 2 batch 2. Safari does not focus a clicked button, so a JS
  // `.click()` stands in for its click on the options button.
  const optionsOpen = (p: Page) => p.evaluate(() => !(document.getElementById("wikiOptions") as HTMLElement).hidden);
  const clickOptionsWithoutFocus = (p: Page) => p.evaluate(() => document.getElementById("wikiOptionsBtn")!.click());
  /** Arm a flag that the next rail repaint sets. */
  const armRepaint = (p: Page) =>
    p.evaluate(() => {
      const w = window as unknown as { __repainted: boolean; __repaintObs?: MutationObserver };
      w.__repaintObs?.disconnect();
      w.__repainted = false;
      w.__repaintObs = new MutationObserver(() => (w.__repainted = true));
      w.__repaintObs.observe(document.getElementById("wikiList")!, { childList: true });
    });
  const repainted = (p: Page) => expect.poll(() => p.evaluate(() => (window as unknown as { __repainted: boolean }).__repainted)).toBe(true);
  /** Another tab flips Same issue; `b` repaints from the storage event. */
  async function writeInOtherTab(a: Page, b: Page): Promise<void> {
    await armRepaint(b);
    await groupBtn(a).click();
    await a.locator('[data-work-evidence="issue"]').click();
    await groupBtn(a).click();
    await repainted(b);
  }
  const activeAttr = (p: Page, attr: string) => p.evaluate((a) => document.activeElement?.getAttribute(a) ?? null, attr);

  test("focus: with the menu open, a click on the options button that moves no focus opens the pane and keeps it open", async ({ page }) => {
    await openReader(page);
    await openMenuOnSeries(page);
    await clickOptionsWithoutFocus(page);
    await expect(menu(page)).toHaveCount(0);
    expect(await optionsOpen(page)).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-work-group-menu"))).toBe(false);
  });

  test("focus: another tab's write keeps focus on the Group button and leaves an options pane it did not open standing", async ({ context }) => {
    const a = await context.newPage();
    const b = await context.newPage();
    await openReader(a);
    await openReader(b);
    await groupBtn(b).focus();
    await clickOptionsWithoutFocus(b);
    expect(await optionsOpen(b)).toBe(true);
    await writeInOtherTab(a, b);
    expect(await b.evaluate(() => document.activeElement?.hasAttribute("data-work-group-menu"))).toBe(true);
    expect(await optionsOpen(b)).toBe(true);
  });

  test("focus: another tab's write keeps focus on the shared context's +N, a group's 📌 and a child's fold", async ({ context }) => {
    const a = await context.newPage();
    const b = await context.newPage();
    await openReader(a, BROAD);
    await openReader(b, BROAD);
    await body(b, "group:series:big").locator(".wiki-thread-ctx-more").focus();
    await writeInOtherTab(a, b);
    expect(await activeAttr(b, "data-thread-ctx-more")).toBe("group:series:big");
    await groupCard(b, "group:series:big").locator(".wiki-thread-pin").first().focus();
    await writeInOtherTab(a, b);
    expect(await b.evaluate(() => document.activeElement?.closest(".wiki-thread-card")?.getAttribute("data-thread-group"))).toBe("group:series:big");
    expect(await b.evaluate(() => document.activeElement?.hasAttribute("data-thread-pin"))).toBe(true);
    const childFold = body(b, "group:series:big").locator(".wiki-thread-card").nth(1).locator(".wiki-thread-fold");
    const foldKey = await childFold.getAttribute("data-fold-key");
    await childFold.focus();
    await writeInOtherTab(a, b);
    expect(foldKey).toBeTruthy();
    expect(await activeAttr(b, "data-fold-key")).toBe(foldKey);
  });

  test("focus: a window-focus refetch that repaints keeps focus on + N more threads", async ({ page }) => {
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
    await body(page, "group:series:alpha").locator(".wiki-thread-more").focus();
    renamed = true;
    const refetched = page.waitForResponse((r) => r.url().includes("/api/wiki/pages") && r.url().includes(`wiki=${GROUPS}`) && r.url().includes("refresh=1"));
    await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refetched;
    await expect(page.locator('.wiki-list-item[data-relpath="notes/old-1.md"]')).toContainText("Old 1, renamed");
    expect(await activeAttr(page, "data-thread-more")).toBe("group:series:alpha");
  });

  test("focus: in focus mode one Escape leaves focus mode and leaves the hidden menu open", async ({ page }) => {
    await openReader(page);
    await groupBtn(page).click();
    await expect(menu(page)).toBeVisible();
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.locator("body").press("f");
    await expect(page.locator(".wiki-layout")).toHaveClass(/focus-mode/);
    await page.locator("body").press("Escape");
    await expect(page.locator(".wiki-layout")).not.toHaveClass(/focus-mode/);
    await expect(menu(page)).toBeVisible();
  });

  test("focus: Escape from the search box closes the menu and leaves focus in the search box", async ({ page }) => {
    await openReader(page);
    await groupBtn(page).click();
    await expect(menu(page)).toBeVisible();
    await page.locator("#wikiSearch").focus();
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("wikiSearch");
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
    // ArrowDown on the button opens; Home is the first stop (Sessions, PR 4);
    // one down is Threads; Enter picks it.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Home");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-work-stop"))).toBe("sessions");
    await page.keyboard.press("ArrowDown");
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

  test("forced colours drop the shadows: an open group's body and a closed group's stack keep an edge that costs no layout", async ({ page }) => {
    const stackSel = `#wikiList > .wiki-thread-card[data-thread-group="group:anchor:${REL1}"]`;
    const gbodySel = `.wiki-thread-gbody[data-thread-group-body="group:series:alpha"]`;
    /** Widths and heights the forced-colours edges must leave alone. */
    const layout = () =>
      page.evaluate(
        ([stackSel, gbodySel]) => {
          const box = (sel: string) => {
            const r = document.querySelector(sel)!.getBoundingClientRect();
            return { w: r.width, h: r.height };
          };
          const rows = Array.from(document.querySelectorAll(`${gbodySel} .wiki-list-item.thread-row`)).map((e) => e.getBoundingClientRect().width);
          return { rows, stackLabel: box(`${stackSel} .wiki-thread-label`), stack: box(stackSel) };
        },
        [stackSel, gbodySel] as const,
      );
    const edges = (sel: string, pseudo: string | null) =>
      page.locator(sel).evaluate((e, pseudo) => {
        const s = getComputedStyle(e, pseudo);
        const side = (k: string) => `${s.getPropertyValue(`border-${k}-style`)} ${s.getPropertyValue(`border-${k}-width`)}`;
        return { content: s.content, position: s.position, shadow: s.boxShadow, top: side("top"), left: side("left"), right: side("right"), bottom: side("bottom") };
      }, pseudo);
    for (const rail of [260, 200]) {
      await page.emulateMedia({ forcedColors: "none" });
      await page.addInitScript(([key, w]) => localStorage.setItem(key as string, String(w)), [RAIL_WIDTH_KEY, rail] as const);
      await page.setViewportSize({ width: rail === 200 ? 445 : 1400, height: 900 });
      await openReader(page);
      await expect(groupCard(page, `group:anchor:${REL1}`)).not.toHaveClass(/\bopen\b/);
      const normal = await layout();
      expect(normal.rows.length).toBeGreaterThan(0);
      await page.emulateMedia({ forcedColors: "active" });
      // The rows inside the body keep today's width, the closed stack keeps
      // its height (no header grows a line), and its label loses no room. The
      // label can GAIN room: on Linux forced colours draw the 📌 as a narrower
      // text glyph (CI measured 188 against 185), so it is a floor, not equal.
      const forced = await layout();
      expect.soft(forced.rows, `rail ${rail} rows`).toEqual(normal.rows);
      expect.soft(forced.stack.h, `rail ${rail} stack height`).toBe(normal.stack.h);
      expect.soft(forced.stack.w, `rail ${rail} stack width`).toBe(normal.stack.w);
      expect.soft(forced.stackLabel.h, `rail ${rail} label height`).toBe(normal.stackLabel.h);
      expect.soft(forced.stackLabel.w, `rail ${rail} label width`).toBeGreaterThanOrEqual(normal.stackLabel.w);
    }
    // The open series group: its body's outline was a box shadow, gone here;
    // an ::after draws its sides and bottom, never its top (the open header
    // closes it there), and the body itself takes no border.
    const gbody = await edges(gbodySel, null);
    expect.soft(gbody.shadow).toBe("none");
    // The ::after is laid over the body's own box, and the stack's over its card's.
    expect.soft(gbody.position).toBe("relative");
    for (const side of [gbody.top, gbody.left, gbody.right, gbody.bottom]) expect.soft(side).toMatch(/ 0px$/);
    const gedge = await edges(gbodySel, "::after");
    for (const side of [gedge.left, gedge.right, gedge.bottom]) expect.soft(side).toBe("solid 2px");
    expect.soft(gedge.top).toMatch(/ 0px$/);
    // The closed related group: its stack was a box shadow; a second edge
    // stands in, drawn by an ::after, so its own border stays 1 px.
    const stack = await edges(stackSel, null);
    expect.soft(stack.shadow).toBe("none");
    expect.soft(stack.position).toBe("relative");
    expect.soft(stack.right).toBe("solid 1px");
    expect.soft(stack.bottom).toBe("solid 1px");
    const sedge = await edges(stackSel, "::after");
    expect.soft(sedge.right).toBe("solid 1px");
    expect.soft(sedge.bottom).toBe("solid 1px");
    expect.soft(sedge.top).toMatch(/ 0px$/);
    expect.soft(sedge.left).toMatch(/ 0px$/);
    // The open group's header is not a stack: no second edge.
    expect.soft((await edges(`#wikiList > .wiki-thread-card[data-thread-group="group:series:alpha"]`, "::after")).content).toBe("none");
    // A closed thread card is not stacked.
    const solo = await edges(`#wikiList > .wiki-thread-card[data-thread="thread:${SOLO[0]}"]`, null);
    expect.soft(solo.right).toBe("solid 1px");
    expect.soft((await edges(`#wikiList > .wiki-thread-card[data-thread="thread:${SOLO[0]}"]`, "::after")).content).toBe("none");
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

  test("the group and child headers' width table: every row fits at 260 and 300 px in both themes and forced colours, nothing cut", async ({ page }) => {
    test.setTimeout(240_000);
    const groups = groupRows();
    const kids = childRows();
    const font = process.env.PW_TEST_CONNECT_WS_ENDPOINT ? "remote" : process.platform;
    const failures: string[] = [];
    const widest = new Map<string, number>();
    /** The narrowest label per kind and rail, normal vs forced colours. */
    const labels = new Map<string, number>();
    const passes = [
      { rail: 260, win: 1400, scheme: "light" },
      { rail: 260, win: 1400, scheme: "dark" },
      { rail: 300, win: 1400, scheme: "light" },
      { rail: 300, win: 1400, scheme: "dark" },
      { rail: 200, win: 445, scheme: "light" },
      // Forced colours: the group's edges are drawn without layout, so the table holds there too.
      { rail: 260, win: 1400, scheme: "light", forced: true },
      { rail: 200, win: 445, scheme: "light", forced: true },
    ] as const;
    for (const p of passes) {
      const forced = "forced" in p;
      await page.emulateMedia({ colorScheme: p.scheme, forcedColors: forced ? "active" : "none" });
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
        const at = `${font} ${p.rail}/${p.scheme}${forced ? "/forced" : ""} [${m.id}]`;
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
        if (p.scheme === "light" && p.rail !== 300) {
          const lk = `${m.kind} @${p.rail}${forced ? " forced" : ""}`;
          labels.set(lk, Math.min(labels.get(lk) ?? Infinity, m.fit.label));
        }
        if (p.rail >= 260 && p.scheme === "light" && !forced) {
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
    // Forced colours cost no label width: the narrowest label is never below
    // normal's (it can be wider where the 📌 renders as a text glyph).
    for (const kind of ["group", "child"]) for (const rail of [260, 200]) expect.soft(labels.get(`${kind} @${rail} forced`), `${kind} @${rail}`).toBeGreaterThanOrEqual(labels.get(`${kind} @${rail}`)!);
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


/**
 * Keep focus after updates, by enumeration (fix round 3, the class check). The
 * invariant: a `#wikiList` repaint never moves focus by itself; when the swap
 * dropped focus from a rail control, the same control, found again by its own
 * key, gets it back. One row per repaint cause × control; a row passes when
 * focus ends on the control it started on (or, for the Group menu's own edit,
 * on the item that handler focuses) and an options pane opened without moving
 * focus is still open. Clicks are JS `.click()`s, which move no focus — Safari's
 * click on a button.
 *
 * The wiki is `wsgfocus`: its series name and one thread's path carry a `"`,
 * so every lookup needs `CSS.escape`. The series group is stored open, so it
 * stays open when a pin moves another card first; that move also flips its
 * fold key between `closed:group:…` and `group:…`.
 */
test.describe("Wiki rail: focus after a repaint", () => {
  const QGROUP = `group:series:${FSERIES}`;
  /** A kept-apart anchor no thread holds: the record has a Reset item and no card moves. */
  const FDORMANT = "notes/none.md";
  /** A CSS string literal: JSON's escapes are CSS's for `"` and `\`. */
  const lit = (v: string) => JSON.stringify(v);
  const qCard = (p: Page) => p.locator(`#wikiList > .wiki-thread-card[data-thread-group=${lit(QGROUP)}]`);
  const qBody = (p: Page) => p.locator(`.wiki-thread-gbody[data-thread-group-body=${lit(QGROUP)}]`);
  const loneCard = (p: Page, rel: string) => p.locator(`#wikiList > .wiki-thread-card[data-thread=${lit(`thread:${rel}`)}]`);

  type Control = { name: string; menu?: boolean; loc: (p: Page) => ReturnType<Page["locator"]> };
  const CONTROLS: Control[] = [
    { name: "Group button", loc: (p) => groupBtn(p) },
    { name: "stop item", menu: true, loc: (p) => p.locator('#wikiList [data-work-stop="areas"]') },
    { name: "evidence item", menu: true, loc: (p) => p.locator('#wikiList [data-work-evidence="series"]') },
    { name: "group fold", loc: (p) => qCard(p).locator(".wiki-thread-fold").first() },
    { name: "child fold", loc: (p) => qBody(p).locator(".wiki-thread-card").nth(1).locator(".wiki-thread-fold") },
    { name: "thread fold", loc: (p) => loneCard(p, FLONE[0]!).locator(".wiki-thread-fold") },
    { name: "group 📌", loc: (p) => qCard(p).locator(".wiki-thread-pin").first() },
    { name: "child 📌", loc: (p) => qBody(p).locator(".wiki-thread-card").nth(1).locator(".wiki-thread-pin") },
    { name: "thread 📌", loc: (p) => loneCard(p, FLONE[0]!).locator(".wiki-thread-pin") },
    { name: "+ N more threads", loc: (p) => qBody(p).locator(".wiki-thread-more") },
    // PR 4: a child's ⋯, a lone card's ⋯, `▸ split into N sessions` and the
    // Group menu's Reset item (the seeded record holds a dormant anchor).
    { name: "child ⋯", loc: (p) => qBody(p).locator(".wiki-thread-card").nth(1).locator("[data-work-card-menu]") },
    { name: "thread ⋯", loc: (p) => loneCard(p, FLONE[0]!).locator("[data-work-card-menu]") },
    { name: "split into sessions", loc: (p) => p.locator(`#wikiList [data-thread-sessions=${lit(`thread:${FLONE[0]}`)}]`) },
    { name: "Reset item", menu: true, loc: (p) => p.locator("#wikiList [data-work-reset]") },
    { name: "shared context +N", loc: (p) => qBody(p).locator(".wiki-thread-ctx-more") },
    { name: "Activity series fold", loc: (p) => p.locator("#wikiList .wiki-list-group.series .wiki-group-fold").first() },
    { name: "Bookkeeping fold", loc: (p) => p.locator("#wikiList .wiki-sec-fold").first() },
    { name: "search box (outside)", loc: (p) => p.locator("#wikiSearch") },
    { name: "options button (outside)", loc: (p) => p.locator("#wikiOptionsBtn") },
  ];

  /** The focused element as `kind:key`, a fold under either spelling. */
  const focusKey = (p: Page) =>
    p.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return "BODY";
      if (el.id) return `#${el.id}`;
      const a = (n: string) => el.getAttribute(n);
      for (const [attr, kind] of [
        ["data-work-stop", "stop"],
        ["data-work-evidence", "evidence"],
        ["data-thread-more", "more"],
        ["data-thread-ctx-more", "ctx"],
        ["data-work-card-menu", "cardmenu"],
        ["data-thread-sessions", "split"],
        ["data-work-reset", "reset"],
      ] as const) {
        if (a(attr) !== null) return `${kind}:${a(attr)}`;
      }
      if (a("data-fold-key") !== null) return `fold:${a("data-fold-key")!.replace(/^closed:/, "")}`;
      if (el.hasAttribute("data-thread-pin")) {
        const c = el.closest(".wiki-thread-card")!;
        return c.hasAttribute("data-thread-group") ? `pin:${c.getAttribute("data-thread-group")}` : `pin:${c.getAttribute("data-thread")}`;
      }
      if (el.hasAttribute("data-work-group-menu")) return "group-button";
      return `${el.tagName}.${el.className}`;
    });
  const optionsOpen = (p: Page) => p.evaluate(() => !(document.getElementById("wikiOptions") as HTMLElement).hidden);
  const jsClick = (p: Page, sel: string) => p.evaluate((s) => (document.querySelector(s) as HTMLElement).click(), sel);
  const foldKeyOf = (p: Page) => qCard(p).locator(".wiki-thread-fold").first().getAttribute("data-fold-key");
  const firstCard = (p: Page) => cards(p).first().evaluate((e) => e.getAttribute("data-thread-group") ?? e.getAttribute("data-thread"));

  async function setMenu(p: Page, open: boolean): Promise<void> {
    if ((await menu(p).count()) === (open ? 1 : 0)) return;
    await jsClick(p, "#wikiList [data-work-group-menu]");
    await expect(menu(p)).toHaveCount(open ? 1 : 0);
  }
  const armRepaint = (p: Page) =>
    p.evaluate(() => {
      const w = window as unknown as { __rp: boolean; __rpObs?: MutationObserver };
      w.__rpObs?.disconnect();
      w.__rp = false;
      w.__rpObs = new MutationObserver(() => (w.__rp = true));
      w.__rpObs.observe(document.getElementById("wikiList")!, { childList: true });
    });
  const repaintSeen = (p: Page) => p.evaluate(() => (window as unknown as { __rp: boolean }).__rp);
  /** Wait for a repaint, then until the rail has been still for 300 ms. */
  async function settle(p: Page, needRepaint: boolean): Promise<boolean> {
    let seen = !needRepaint;
    for (let t = Date.now(); !seen && Date.now() - t < 10_000; ) {
      seen = await repaintSeen(p);
      if (!seen) await new Promise((r) => setTimeout(r, 50));
    }
    for (let quiet = false; !quiet; ) {
      await armRepaint(p);
      await new Promise((r) => setTimeout(r, 300));
      quiet = !(await repaintSeen(p));
    }
    return seen;
  }

  type Cause = {
    name: string;
    /** The control the handler itself focuses after its render; it wins. */
    explicit?: string;
    /** The cause is a click outside the open menu, which closes it: menu items are n/a. */
    closesMenu?: boolean;
    /** No options pane for this cause (the handler's own focus move closes it, by design). */
    noPane?: boolean;
    /** Checked after the cause: it really reordered the cards and flipped the group's fold key. */
    reorders?: boolean;
    clock?: boolean;
    setup?: (p: Page) => Promise<void>;
    prep?: (p: Page, i: number) => Promise<void>;
    fire: (p: Page, i: number) => Promise<void>;
  };

  const storageEvent = (p: Page, key: string, value: string | null) =>
    p.evaluate(
      ([k, v]) => {
        if (v === null) localStorage.removeItem(k!);
        else localStorage.setItem(k!, v);
        window.dispatchEvent(new StorageEvent("storage", { key: k, newValue: v, storageArea: localStorage }));
      },
      [key, value] as const,
    );
  /** A held `/api/wiki/page` load: `entered` once the request is in, `release()` lets it through. */
  type Gate = { entered: Promise<void>; enter: () => void; wait: Promise<void>; release: () => void; fail: boolean };
  let gate: Gate | null = null;
  const holdPageLoads = (p: Page) =>
    p.route(
      (u) => u.pathname === "/api/wiki/page",
      async (route) => {
        const g = gate;
        if (!g) return route.continue();
        g.enter();
        await g.wait;
        return g.fail ? route.fulfill({ json: { error: "Page not found (test)" } }) : route.continue();
      },
    );
  function newGate(fail: boolean): void {
    const g = { fail } as Gate;
    g.entered = new Promise<void>((r) => (g.enter = r));
    g.wait = new Promise<void>((r) => (g.release = r));
    gate = g;
  }
  async function heldLoad(p: Page, i: number, fail: boolean): Promise<void> {
    newGate(fail);
    await jsClick(p, `#wikiList .wiki-list-item[data-relpath=${lit(BCTX[1 + (i % 2)]!)}]`);
    await gate!.entered;
  }

  let renamed = 0;
  const CAUSES: Cause[] = [
    {
      name: "storage: another tab's grouping edit",
      fire: (p, i) => storageEvent(p, workGroupKey(FOCUSW), JSON.stringify({ version: 1, evidence: { issue: i % 2 === 1 }, keptApart: [FDORMANT] })),
    },
    {
      name: "storage: another tab's pin reorders the cards",
      reorders: true,
      fire: (p, i) => storageEvent(p, threadPinKey(FOCUSW), i % 2 === 0 ? FLONE[2]! : null),
    },
    {
      name: "window-focus refetch",
      clock: true,
      setup: (p) =>
        p.route(
          (u) => u.pathname === "/api/wiki/pages" && u.searchParams.get("wiki") === FOCUSW,
          async (route) => {
            const res = await route.fetch();
            const json = (await res.json()) as { pages: { relPath: string; title: string }[] };
            for (const pg of json.pages) if (pg.relPath === BCTX[4]) pg.title = `Focus context 5 (${renamed})`;
            await route.fulfill({ response: res, json });
          },
        ),
      fire: async (p) => {
        renamed++;
        await p.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
        await p.evaluate(() => window.dispatchEvent(new Event("focus")));
      },
    },
    {
      name: "popstate: Back from a page",
      prep: async (p) => {
        await jsClick(p, `#wikiList .wiki-list-item[data-relpath=${lit(BCTX[0]!)}]`);
        await expect(p.locator("#articleWrap .wiki-article")).toHaveCount(1);
        await settle(p, false);
      },
      fire: (p) => p.evaluate(() => history.back()),
    },
    { name: "a slow page load lands", setup: holdPageLoads, prep: (p, i) => heldLoad(p, i, false), fire: async () => gate!.release() },
    { name: "a slow page load fails", setup: holdPageLoads, prep: (p, i) => heldLoad(p, i, true), fire: async () => gate!.release() },
    {
      name: "the Group menu's own edit",
      explicit: 'evidence:issue',
      noPane: true,
      prep: (p) => setMenu(p, true),
      fire: (p) => jsClick(p, '#wikiList [data-work-evidence="issue"]'),
    },
    { name: "a click on another fold", closesMenu: true, fire: (p) => jsClick(p, `#wikiList [data-thread=${lit(`thread:${FLONE[1]}`)}] .wiki-thread-fold`) },
    {
      name: "a click on another 📌 reorders the cards",
      closesMenu: true,
      reorders: true,
      fire: (p) => jsClick(p, `#wikiList [data-thread=${lit(`thread:${FLONE[2]}`)}] .wiki-thread-pin`),
    },
  ];

  type Row = { cause: string; control: string; before: string; after: string; pane: boolean | null; ok: boolean; note: string };
  const tableDir = process.env.WIKI_FOCUS_TABLE;

  for (const cause of CAUSES) {
    test(`focus table: ${cause.name}`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.addInitScript(([k, v, gk, gv]) => {
        if (localStorage.getItem("__seeded")) return;
        localStorage.setItem("__seeded", "1");
        localStorage.setItem(k!, v!);
        localStorage.setItem(gk!, gv!);
      }, [foldsKey(FOCUSW), JSON.stringify([QGROUP, `thread:${FLONE[0]}`]), workGroupKey(FOCUSW), JSON.stringify({ version: 1, keptApart: [FDORMANT] })] as const);
      if (cause.clock) await page.clock.install();
      await cause.setup?.(page);
      await openReader(page, FOCUSW);
      expect(await foldKeyOf(page)).toBe(`closed:${QGROUP}`);
      const rows: Row[] = [];
      for (const [i, control] of CONTROLS.entries()) {
        const base = { cause: cause.name, control: control.name };
        if (control.menu && cause.closesMenu) {
          rows.push({ ...base, before: "-", after: "-", pane: null, ok: true, note: "n/a: the click closes the menu" });
          continue;
        }
        await cause.prep?.(page, i);
        await setMenu(page, !!control.menu || cause.explicit !== undefined);
        await control.loc(page).focus();
        // A click on the options button closes an open Group menu, so a menu item never sits beside an open pane.
        const pane = !cause.noPane && !control.menu;
        if (pane) await jsClick(page, "#wikiOptionsBtn");
        const before = await focusKey(page);
        expect(before, `${control.name} took focus`).not.toBe("BODY");
        if (pane) expect(await optionsOpen(page)).toBe(true);
        const orderBefore = [await firstCard(page), await foldKeyOf(page)];
        await armRepaint(page);
        await cause.fire(page, i);
        const seen = await settle(page, true);
        const after = await focusKey(page);
        const paneAfter = pane ? await optionsOpen(page) : null;
        const notes: string[] = [];
        if (!seen) notes.push("no repaint");
        if (cause.reorders) {
          const orderAfter = [await firstCard(page), await foldKeyOf(page)];
          if (orderAfter[0] === orderBefore[0] || orderAfter[1] === orderBefore[1]) notes.push(`no reorder ${JSON.stringify(orderAfter)}`);
        }
        const want = cause.explicit ?? before;
        if (after !== want) notes.push(`focus on ${after}, want ${want}`);
        if (pane && !paneAfter) notes.push("pane closed");
        rows.push({ ...base, before, after, pane: paneAfter, ok: notes.length === 0, note: notes.join("; ") });
        if (paneAfter) await jsClick(page, "#wikiOptionsBtn");
        await setMenu(page, false);
      }
      if (tableDir) await writeFile(path.join(tableDir, `${cause.name.replace(/[^a-z0-9]+/gi, "-")}.json`), JSON.stringify(rows, null, 1));
      expect(rows.filter((r) => !r.ok).map((r) => `${r.control}: ${r.note}`)).toEqual([]);
    });
  }
});
