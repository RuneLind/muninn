/**
 * /wiki rail — the **Work threads** section (plan `muninn-wiki-work-threads`,
 * PR 5): the cards above Activity, the lift out of Activity and the series
 * ghost (D13), the 📌 surviving a reload (D7), the renderer's re-anchor write
 * as the pinned thread grows and ages (D7), two tabs sharing the pin — and
 * two whose listings disagree writing at most once each, a `clear()` in one
 * unpinning the other, a quota refusing the write (D7, the pin's state table
 * in `src/wiki/CLAUDE.md`; writes counted by wrapping `Storage.prototype`), no
 * section when the ledger 404s the sessions form (D11), both themes, the
 * 260 px rail, the header's width table (every row through the real renderer,
 * run on CI's Linux DejaVu fonts too) and the 📌's resting/pressed look in
 * forced colours. The re-anchor stages rewrite the listing in the browser
 * (`page.route`), since the server's memo cannot be moved forward in time.
 *
 * A browser is needed because the chain is `/api/files?sessions=1` → the
 * work-sessions memo → `work` on the listing → `setPagesData` → `railInputFor`
 * → `buildRail` → `renderList`, and the pin and fold state live in
 * localStorage across a reload; the unit tests hand `buildRail` its cards.
 *
 * ONE muninn, TWO temp wikis, ONE fake `node:http` claude-usage:
 *
 *  - `wsthreads` — the ledger answers the sessions form: sessions a1 and a2
 *    share `plans/alpha.mdx` (one thread, focus alpha + alpha-two, alpha-notes
 *    touched); b1 focuses `notes/beta.md` (a second thread). `alpha.mdx` is the
 *    fullest card row a page can carry — pill, ⚑, ✋ 12, NEW, the work bar and
 *    twelve attachments' chip. alpha, alpha-two and alpha-old share
 *    `series: alpha`, so the lift leaves two ghosts in it.
 *  - `wsplain` — the same ledger 404s the sessions form, so no page carries
 *    `work` and the rail has no section.
 *
 * Synthetic names only (D21). No model calls and no writes.
 *
 * ENV PREREQUISITE: a working `.env` (`DATABASE_URL` at minimum) at the repo
 * root — the spawned `src/index.ts` boots the full process.
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
import { paintedContrast } from "./contrast.ts";
import { RAIL_WIDTH_KEY } from "../src/dashboard/views/components/wiki-rail-width.ts";
import { threadPinKey, type RailThreadCard } from "../src/dashboard/views/components/wiki-recents.ts";
import { threadCardHeaderHtml } from "../src/dashboard/views/components/wiki-thread-view.ts";
import { WIKI_REFETCH_MIN_INTERVAL_MS } from "../src/dashboard/views/components/wiki-refresh.ts";

const PORT = e2ePort("wiki-rail-threads");
const LEDGER_PORT = e2ePort("wiki-rail-threads/ledger");
const BASE = `http://127.0.0.1:${PORT}`;
const LEDGER_BASE = `http://127.0.0.1:${LEDGER_PORT}`;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const THREADS = "wsthreads";
const PLAIN = "wsplain";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.now();

const ALPHA = "plans/alpha.mdx";
const ALPHA_TWO = "plans/alpha-two.mdx";
const ALPHA_OLD = "plans/alpha-old.mdx";
const ALPHA_NOTES = "notes/alpha-notes.md";
const BETA = "notes/beta.md";
const FILLERS = ["notes/c1.md", "notes/c2.md", "notes/c3.md", "notes/c4.md", "notes/c5.md", "notes/c6.md"];
const ATTACHED = 12;

/** The three sessions: hours ago, the pages the first prompt names, the files
 *  written with their edits. */
const SESSIONS = [
  { id: "a1", at: 1, named: [ALPHA], files: [[ALPHA, 20], [ALPHA_NOTES, 1]] },
  { id: "a2", at: 3, named: [ALPHA, ALPHA_TWO], files: [[ALPHA, 6], [ALPHA_TWO, 6]] },
  { id: "b1", at: 5, named: [BETA], files: [[BETA, 4]] },
] as const;
/** Pages with a write before the window, so the created rule cannot make them
 *  focus — alpha-notes stays a touch. */
const PRE = [ALPHA_TWO, ALPHA_NOTES, BETA];

const day = (ago: number) => {
  const d = new Date(NOW - ago * DAY);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
  if (url.searchParams.get("sessions") === "1") {
    // D11: an older ledger without the form.
    if (wiki !== THREADS) return json({ error: "not found" }, 404);
    const sessions = SESSIONS.map((s) => {
      const at = NOW - s.at * HOUR;
      return {
        id: s.id,
        provider: "claude",
        title: `session ${s.id}`,
        first: at - 30 * 60_000,
        last: at,
        bulk: false,
        text: { from: "prompt", paths: [...s.named], links: [], files: [] },
        files: s.files.map(([p, edits]) => ({ p, edits, firstMs: at - 30 * 60_000, lastMs: at })),
      };
    });
    // The real answer's shape (claude-usage `src/routes.ts`): it echoes the
    // window and the limit too, `until` defaulting to now.
    const since = Number(url.searchParams.get("since"));
    const until = url.searchParams.has("until") ? Number(url.searchParams.get("until")) : Date.now();
    return json({ form: "sessions", root, since, until, limit: 200, truncated: false, sessions });
  }
  const until = url.searchParams.get("until");
  if (until) {
    const pre = wiki === THREADS ? PRE.map((p) => ({ p, w: NOW - 20 * DAY, s: 1 })) : [];
    return json({ root, pages: pre, pageCount: pre.length, bulk: 10, limit: 5000, truncated: false, until: Number(until) });
  }
  const pages =
    wiki === THREADS ? SESSIONS.flatMap((s) => s.files.map(([p]) => ({ p, w: NOW - s.at * HOUR, s: 1 }))) : [];
  json({ root, pages, pageCount: pages.length, bulk: 10, limit: 5000, truncated: false });
}

function startLedger(): Promise<Server> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/api/files") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected path", path: url.pathname }));
      return;
    }
    ledgerAnswer(res, url);
  });
  return new Promise((resolve) => srv.listen(LEDGER_PORT, "127.0.0.1", () => resolve(srv)));
}

async function makeRoot(name: string): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-threads-${name}-`));
  roots[name] = root;
  // Penalties off, six Activity rows: the order is a function of the fixture.
  await writeFile(
    path.join(root, ".wiki-reader.json"),
    JSON.stringify({ activity: { agePenalty: 0, hubPenalty: 0, planBoost: 0, rows: 6 } }),
    "utf8",
  );
  const write = async (rel: string, body: string, mtimeAgoMs: number) => {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body, "utf8");
    const stamp = new Date(NOW - mtimeAgoMs);
    await utimes(abs, stamp, stamp);
  };
  const md = (title: string, extra: string[] = [], created = day(40), body: string[] = ["Body."]) =>
    ["---", `title: ${title}`, `created: ${created}`, ...extra, "---", "", ...body, ""].join("\n");
  const steps = [
    "<NextMoves>",
    "",
    '<Lane kind="you" who="Du">',
    "",
    ...Array.from({ length: 12 }, (_, i) => `${i + 1}. **Step ${i + 1}.**`),
    "",
    "</Lane>",
    "",
    "</NextMoves>",
  ];
  await write(
    ALPHA,
    md("Alpha work — the long tail", ["plan_status: in-flight", "followups: open", "series: alpha", "series_label: Alpha series"], day(0), steps),
    1 * HOUR,
  );
  await write(ALPHA_TWO, md("Alpha two", ["series: alpha"]), 3 * HOUR);
  await write(ALPHA_OLD, md("Alpha old", ["series: alpha"]), 30 * DAY);
  await write(ALPHA_NOTES, md("Alpha notes"), 10 * DAY);
  await write(BETA, md("Beta work"), 5 * HOUR);
  for (const [i, rel] of FILLERS.entries()) await write(rel, md(`Filler ${i + 1}`), (i + 1) * DAY);
  for (let i = 1; i <= ATTACHED; i++) {
    await write(
      `plans/alpha-prototype-${i}.html`,
      `<!doctype html><html><head><title>alpha mock ${i}</title></head><body><p>x</p></body></html>`,
      40 * DAY,
    );
  }
}

const sec = (page: Page, s: string) => page.locator(`.wiki-list-sec[data-section="${s}"]`);
const cards = (page: Page) => page.locator(".wiki-thread-card");
const rowsIn = (page: Page, s: string) => page.locator(`.wiki-list-item[data-section="${s}"]`);
const relsIn = (page: Page, s: string) => rowsIn(page, s).evaluateAll((els) => els.map((e) => e.getAttribute("data-relpath")));

async function openReader(page: Page, wiki: string): Promise<void> {
  await fetch(`${BASE}/api/wiki/pages?wiki=${wiki}&refresh=1`);
  const listing = page.waitForResponse(
    (r) => r.url().includes("/api/wiki/pages") && r.url().includes(`wiki=${wiki}`) && r.ok(),
  );
  await page.goto(`${BASE}/wiki?wiki=${wiki}`);
  await listing;
  await expect(sec(page, "activity")).toHaveCount(1);
}

/** The listing the reader is served, one stage further on (D7): `grown` —
 *  alpha's thread gains alpha-notes as its newest focus page; `aged` — then
 *  alpha's own last focus leaves the window, so the server drops it from the
 *  thread, which lives on; `grownOlder` — alpha-notes joins as a focus page
 *  OLDER than alpha, the listing a tab loaded before alpha-notes was last
 *  worked on (its newest page is still alpha). Built from the real answer. */
type Stage = "real" | "grown" | "aged" | "grownOlder";
interface ListingBody {
  pages: Array<{ relPath: string; work?: { focusMs?: number; events: unknown[] } }>;
  work?: { threads: Array<{ key: string; pages: string[]; touched: string[] }> };
}
function staged(body: ListingBody, stage: Stage): ListingBody {
  if (stage === "real") return body;
  const alpha = body.pages.find((p) => p.relPath === ALPHA)!;
  const notes = body.pages.find((p) => p.relPath === ALPHA_NOTES)!;
  const newest = alpha.work!.focusMs! + (stage === "grownOlder" ? -30 : 30) * 60_000;
  notes.work = { ...alpha.work!, focusMs: newest, events: [[newest, 5, "focus"]] };
  const t = body.work!.threads.find((x) => x.pages.includes(ALPHA))!;
  t.pages = [...t.pages, ALPHA_NOTES];
  t.touched = t.touched.filter((p) => p !== ALPHA_NOTES);
  if (stage === "aged") {
    delete alpha.work;
    t.pages = t.pages.filter((p) => p !== ALPHA);
  }
  return body;
}

/** Serve `page` the THREADS listing at a stage the test moves. */
async function stageListings(page: Page): Promise<{ set: (s: Stage) => void }> {
  let stage: Stage = "real";
  await page.route(
    (u) => u.pathname === "/api/wiki/pages" && u.searchParams.get("wiki") === THREADS,
    async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: staged((await res.json()) as ListingBody, stage) });
    },
  );
  return { set: (s) => (stage = s) };
}

/** A card by its name: the alpha thread is keyed on its earliest focus page. */
const card = (page: Page, name: string) =>
  page.locator(".wiki-thread-card").filter({ has: page.locator(".wiki-thread-name", { hasText: name }) });
const ALPHA_CARD = "Alpha work";
const storedPin = (page: Page) => page.evaluate((k) => localStorage.getItem(k), threadPinKey(THREADS));

/** Count this tab's writes of the pin key (`setItem` and `removeItem`), and —
 *  with `refuse` — make every `setItem` of it throw, as a full quota does. */
async function watchPinWrites(page: Page, refuse = false): Promise<void> {
  await page.addInitScript(
    ([key, refuse]) => {
      const w = window as unknown as { __pinWrites: number };
      w.__pinWrites = 0;
      const set = Storage.prototype.setItem;
      const remove = Storage.prototype.removeItem;
      Storage.prototype.setItem = function (k: string, v: string) {
        if (k !== key) return set.call(this, k, v);
        w.__pinWrites++;
        if (refuse) throw new DOMException("quota", "QuotaExceededError");
        return set.call(this, k, v);
      };
      Storage.prototype.removeItem = function (k: string) {
        if (k === key) w.__pinWrites++;
        return remove.call(this, k);
      };
    },
    [threadPinKey(THREADS), refuse] as const,
  );
}
const pinWrites = (page: Page) => page.evaluate(() => (window as unknown as { __pinWrites: number }).__pinWrites);

/** The header's WIDTH TABLE (`src/wiki/CLAUDE.md`, Work threads), built by the
 *  real renderer: every session count (1, 2-digit, 3-digit) × ✋ (absent, as on
 *  nais, and 1–3 digits) × span form × name (short, long enough to clamp). The
 *  fixture's own threads are a few hours long and two sessions wide. */
const TABLE_NOW = new Date(2026, 9, 15, 10, 0).getTime();
const at = (mo: number, d: number, h: number, m: number) => new Date(2026, mo, d, h, m).getTime();
const SPANS = [
  { form: "same day, today", first: at(9, 15, 8, 1), last: at(9, 15, 9, 45) },
  { form: "same day, yesterday", first: at(9, 14, 5, 21), last: at(9, 14, 23, 51) },
  { form: "same day, older", first: at(9, 12, 5, 21), last: at(9, 12, 23, 51) },
  { form: "cross-day, yesterday → today", first: at(9, 14, 5, 21), last: at(9, 15, 9, 45) },
  { form: "cross-day, older → yesterday", first: at(9, 12, 5, 21), last: at(9, 14, 23, 51) },
  { form: "cross-day, older → older", first: at(9, 8, 5, 21), last: at(9, 12, 23, 51) },
  { form: "cross-month → yesterday", first: at(8, 30, 5, 21), last: at(9, 14, 23, 51) },
] as const;
const NAMES = ["Alpha work", "Alpha work on the long-running migration of every remaining reader surface to the new store"];
interface TableRow {
  id: string;
  html: string;
}
function headerTable(): TableRow[] {
  const rows: TableRow[] = [];
  for (const n of [1, 12, 123])
    for (const moves of [0, 7, 88, 999])
      for (const span of SPANS)
        for (const [ni, name] of NAMES.entries()) {
          const card: RailThreadCard = {
            key: "x", foldKey: "thread:x", toggleKey: "thread:x", name, open: false, pinned: false,
            pinAnchor: "x", focus: [], created: [], touched: [], movesYou: moves, score: 1,
            sessions: Array.from({ length: n }, (_, i) => ({
              id: `w${i}`, provider: "claude", title: "",
              first: i === 0 ? span.first : span.first + 1000,
              last: i === 0 ? span.last : span.last - 1000,
            })),
          };
          const id = `${n}s ✋${moves || "-"} ${span.form} name${ni}`;
          rows.push({ id, html: threadCardHeaderHtml(card, true, TABLE_NOW, moves > 0) });
        }
  return rows;
}

/** How one header fits, measured in the page per child: every text run inside
 *  the fold's box and the rail, the fold clear of the 📌, nothing cut by a
 *  clipping box (a 0-px box with hidden text counts — the glyphs are measured,
 *  not the computed style), and the lines each declared line takes. The name
 *  clamps at two lines (the browser draws the clamp's ellipsis), so only its
 *  vertical overflow is allowed, and only at two lines. */
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
    // Only the lines the element's own box shows: a clamped name's hidden lines still have rects.
    const box = r(el);
    const tops = new Set(
      Array.from(range.getClientRects())
        .filter((b) => b.width > 0 && b.top + b.height / 2 <= box.bottom)
        .map((b) => Math.round(b.top + b.height / 2)),
    );
    const sorted = [...tops].sort((a, b) => a - b);
    // Two centres within 3 px are one line (an emoji's box sits a little lower).
    return sorted.filter((t, i) => i === 0 || t - sorted[i - 1]! > 3).length;
  };
  const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
  const parts: Array<{ text: string; width: number }> = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (!t.data.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(t);
    const rects = Array.from(range.getClientRects()).filter((b) => b.width > 0);
    // Per line, the union of its rects (an ellipsis adds a second, overlapping one).
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
        if (cs.overflowX !== "visible" && (b.left < r(a).left - 0.5 || b.right > r(a).right + 0.5))
          issues.push(`"${t.data}" cut by .${a.className} (${Math.round(b.width)} px of text in ${Math.round(r(a).width)} px)`);
        const clampedName = a === name && linesOf(name) === 2;
        if (cs.overflowY !== "visible" && !clampedName && (b.top < r(a).top - 0.5 || b.bottom > r(a).bottom + 0.5))
          issues.push(`"${t.data}" cut vertically by .${a.className}`);
      }
    }
  }
  if (r(fold).right > r(pin).left + 0.5) issues.push("the fold runs under the 📌");
  if (r(pin).right > r(rail).right + 0.5) issues.push("the 📌 leaves the rail");
  if (r(pin).width < 24 || r(pin).height < 24) issues.push(`the 📌 is ${r(pin).width}×${r(pin).height}`);
  const lines = Array.from(cardEl.querySelectorAll(".wiki-thread-line")).map((l) => ({ cls: l.className, lines: linesOf(l) }));
  const partLines = Array.from(cardEl.querySelectorAll(".wiki-thread-line > span")).map((q) => ({ text: q.textContent, lines: linesOf(q) }));
  return { issues, nameLines: linesOf(name), lines, partLines, label: r(label).width, parts };
};

/** The 📌's pixels, off a screenshot (an emoji has no CSS colour): against
 *  the button's top-left padding pixel, the ink's median contrast, its widest
 *  chroma (a grey pin has none, a pressed one is red), and the share of the
 *  box held by the most common non-background colour — a solid square there is
 *  a backplate the filter has painted, not a glyph (measured: under 1% for the
 *  glyph alone, 11% with forced colours' backplate darkened to grey). */
async function pinPixels(page: Page, pin: import("@playwright/test").Locator) {
  const png = (await pin.screenshot({ animations: "disabled" })).toString("base64");
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const lum = (i: number) => {
      const ch = (v: number) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(d[i]!) + 0.7152 * ch(d[i + 1]!) + 0.0722 * ch(d[i + 2]!);
    };
    const bg = lum(0);
    const bgKey = `${d[0]},${d[1]},${d[2]}`;
    const ratios: number[] = [];
    const counts = new Map<string, number>();
    let chroma = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = lum(i);
      const r = (Math.max(l, bg) + 0.05) / (Math.min(l, bg) + 0.05);
      if (r > 1.1) {
        ratios.push(r);
        chroma = Math.max(chroma, Math.max(d[i]!, d[i + 1]!, d[i + 2]!) - Math.min(d[i]!, d[i + 1]!, d[i + 2]!));
      }
      const key = `${d[i]},${d[i + 1]},${d[i + 2]}`;
      if (key !== bgKey) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    ratios.sort((a, b) => a - b);
    const at = (q: number) => ratios[Math.floor(ratios.length * q)] ?? 1;
    const top = Math.max(0, ...counts.values());
    // The median ink pixel: half the glyph, anti-aliased edge included.
    return { bg, ink: ratios.length, p50: at(0.5), chroma, square: top / (d.length / 4) };
  }, png);
}

test.beforeAll(async () => {
  await makeRoot(THREADS);
  await makeRoot(PLAIN);
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
      CLAUDE_USAGE_URL: LEDGER_BASE,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/wiki/pages?wiki=${THREADS}`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
  // The work-sessions memo refreshes in the background: wait for both threads.
  const warm = Date.now() + 20_000;
  for (;;) {
    const body = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${THREADS}&refresh=1`)).json()) as {
      work?: { threads: unknown[] };
    };
    if (body.work?.threads.length === 2) break;
    if (Date.now() > warm) throw new Error("the work-sessions memo never warmed for " + THREADS);
    await new Promise((r) => setTimeout(r, 300));
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise<void>((resolve) => (ledger ? ledger.close(() => resolve()) : resolve()));
  for (const root of Object.values(roots)) await rm(root, { recursive: true, force: true });
});

test.describe("Wiki rail: Work threads", () => {
  test("the section sits above Activity; the open card lifts its pages out of Activity, which still holds six rows", async ({
    page,
  }) => {
    await openReader(page, THREADS);
    // Section order: Work threads, then Activity.
    const sections = await page
      .locator(".wiki-list-sec")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-section")));
    expect(sections.slice(0, 2)).toEqual(["threads", "activity"]);
    await expect(cards(page)).toHaveCount(2);
    // The first card is the alpha thread, open, named by its top page cut at " — ".
    await expect(cards(page).nth(0).locator(".wiki-thread-name")).toHaveText("Alpha work");
    await expect(cards(page).nth(0).locator(".wiki-thread-fold")).toHaveAttribute("aria-expanded", "true");
    await expect(cards(page).nth(0).locator(".wiki-thread-meta")).toContainText("2 sessions");
    await expect(cards(page).nth(0).locator(".wiki-thread-meta")).toContainText("✋ 12");
    await expect(cards(page).nth(1).locator(".wiki-thread-fold")).toHaveAttribute("aria-expanded", "false");
    expect(await relsIn(page, "threads")).toEqual([ALPHA, ALPHA_TWO]);
    // NEW on the page created inside the window, the work bar on both.
    await expect(rowsIn(page, "threads").nth(0).locator(".wiki-new-tag")).toHaveCount(1);
    await expect(rowsIn(page, "threads").nth(1).locator(".wiki-new-tag")).toHaveCount(0);
    await expect(rowsIn(page, "threads").locator(".wiki-work-bar")).toHaveCount(2);
    // The touched line is links, not rows.
    await expect(page.locator(".wiki-thread-touched .wiki-thread-link")).toHaveText(["Alpha notes"]);
    await expect(page.locator(`.wiki-list-item[data-relpath="${ALPHA_NOTES}"]`)).toHaveCount(1);
    // Activity: six rows, neither lifted page; beta's card is closed, so beta stays.
    const activity = await relsIn(page, "activity");
    expect(activity).toHaveLength(6);
    expect(activity).not.toContain(ALPHA);
    expect(activity).not.toContain(ALPHA_TWO);
    expect(activity).toContain(BETA);
    // Every page is one row.
    for (const rel of [ALPHA, ALPHA_TWO, BETA]) await expect(page.locator(`.wiki-list-item[data-relpath="${rel}"]`)).toHaveCount(1);
  });

  test("a card row shows its worked-on age whatever the rail sort", async ({ page }) => {
    await openReader(page, THREADS);
    const meta = page.locator(`.wiki-list-item[data-section="threads"][data-relpath="${ALPHA}"] .wiki-list-meta`);
    for (const mode of ["backlinks", "title", "created"]) {
      await page.selectOption("#wikiSort", mode);
      await expect(meta, mode).toHaveClass(/\bworked\b/);
      await expect(meta, mode).toHaveAttribute("title", /\(worked\)/);
      await expect(meta, mode).not.toContainText("←");
    }
    // The sort took: under backlinks a plain listing row counts links instead.
    await page.selectOption("#wikiSort", "backlinks");
    expect(await page.locator(".wiki-list-meta", { hasText: "←" }).count()).toBeGreaterThan(0);
  });

  test("the series shows the lifted members as ghosts reading 'in a work thread above'; closing the card hands them back", async ({
    page,
  }) => {
    await openReader(page, THREADS);
    const series = page.locator('.wiki-list-group.series[data-section="series"] .wiki-group-fold');
    await series.click();
    const ghosts = page.locator(".wiki-list-ghost");
    await expect(ghosts).toHaveCount(2);
    await expect(ghosts.locator(".wiki-list-ghost-note")).toHaveText(["in a work thread above", "in a work thread above"]);
    expect(await ghosts.evaluateAll((els) => els.map((e) => e.getAttribute("data-ghost-relpath")).sort())).toEqual([ALPHA_TWO, ALPHA].sort());
    // Close the alpha card: nothing is lifted, alpha ranks in Activity again.
    await cards(page).nth(0).locator(".wiki-thread-fold").click();
    await expect(rowsIn(page, "threads")).toHaveCount(0);
    expect(await relsIn(page, "activity")).toContain(ALPHA);
    await expect(page.locator(".wiki-list-ghost")).toHaveCount(0);
  });

  test("the 📌 puts its thread first and open, and survives a reload", async ({ page }) => {
    await openReader(page, THREADS);
    await cards(page).nth(1).locator(".wiki-thread-pin").click();
    await expect(cards(page).nth(0).locator(".wiki-thread-name")).toHaveText("Beta work");
    await expect(cards(page).nth(0)).toHaveClass(/\bpinned\b/);
    await expect(cards(page).nth(0).locator(".wiki-thread-pin")).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate((k) => localStorage.getItem(k), threadPinKey(THREADS))).toBe(BETA);
    await page.reload();
    await expect(sec(page, "threads")).toHaveCount(1);
    await expect(cards(page).nth(0).locator(".wiki-thread-name")).toHaveText("Beta work");
    await expect(cards(page).nth(0)).toHaveClass(/\bpinned\b/);
    expect(await relsIn(page, "threads")).toEqual([BETA]);
    // Unpin: the order is the work order again.
    await cards(page).nth(0).locator(".wiki-thread-pin").click();
    await expect(cards(page).nth(0).locator(".wiki-thread-name")).toHaveText("Alpha work");
    expect(await page.evaluate((k) => localStorage.getItem(k), threadPinKey(THREADS))).toBeNull();
  });

  test("the renderer re-anchors the pin as its thread grows and stores it, so the pin outlives the page it was set on (D7)", async ({
    page,
  }) => {
    const stage = await stageListings(page);
    await openReader(page, THREADS);
    await card(page, ALPHA_CARD).locator(".wiki-thread-pin").click();
    expect(await storedPin(page)).toBe(ALPHA);
    // The thread gains a newer focus page: the render moves the pin there and
    // writes it, with no click.
    stage.set("grown");
    await page.reload();
    await expect(card(page, ALPHA_CARD).locator(".wiki-thread-pin")).toHaveAttribute("data-thread-pin", ALPHA_NOTES);
    await expect.poll(() => storedPin(page)).toBe(ALPHA_NOTES);
    await expect(cards(page).nth(0).locator(".wiki-thread-name")).toHaveText(ALPHA_CARD);
    await expect(cards(page).nth(0)).toHaveClass(/\bpinned\b/);
    // The page the pin was set on ages out of the thread, which lives on: still
    // pinned, from the stored anchor alone.
    stage.set("aged");
    await page.reload();
    // (The card is renamed: its top page is gone.)
    await expect(cards(page).nth(0)).toHaveClass(/\bpinned\b/);
    await expect(cards(page).nth(0).locator(".wiki-thread-pin")).toHaveAttribute("data-thread-pin", ALPHA_NOTES);
    const rows = await relsIn(page, "threads");
    expect(rows).toEqual(expect.arrayContaining([ALPHA_TWO, ALPHA_NOTES]));
    expect(rows).not.toContain(ALPHA);
    expect(await storedPin(page)).toBe(ALPHA_NOTES);
  });

  test("across tabs: a tab adopts another tab's unpin and repin, and never writes its stale pin over one (D7)", async ({
    context,
  }) => {
    const a = await context.newPage();
    const b = await context.newPage();
    const stageB = await stageListings(b);
    await openReader(a, THREADS);
    await card(a, ALPHA_CARD).locator(".wiki-thread-pin").click();
    expect(await storedPin(a)).toBe(ALPHA);
    await b.clock.install();
    await openReader(b, THREADS);
    await expect(card(b, ALPHA_CARD)).toHaveClass(/\bpinned\b/);

    // A unpins: B repaints from the storage event, with no reload or refetch.
    await card(a, ALPHA_CARD).locator(".wiki-thread-pin").click();
    expect(await storedPin(a)).toBeNull();
    await expect(card(b, ALPHA_CARD)).not.toHaveClass(/\bpinned\b/);
    // A repins: B follows.
    await card(a, ALPHA_CARD).locator(".wiki-thread-pin").click();
    await expect(card(b, ALPHA_CARD)).toHaveClass(/\bpinned\b/);

    // The race the event cannot close: storage changes and B renders before it
    // hears. A tab's own write fires no storage event in that tab, so clearing
    // the key from B leaves B holding its stale pin. B then refetches a listing
    // where that pin would re-anchor (the thread grew): it must write nothing.
    await b.evaluate((k) => localStorage.removeItem(k), threadPinKey(THREADS));
    stageB.set("grown");
    const refetched = b.waitForResponse((r) => r.url().includes("/api/wiki/pages") && r.url().includes(`wiki=${THREADS}`));
    await b.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
    await b.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refetched;
    await expect(card(b, ALPHA_CARD).locator(".wiki-thread-pin")).toHaveAttribute("data-thread-pin", ALPHA_NOTES);
    await expect(card(b, ALPHA_CARD)).not.toHaveClass(/\bpinned\b/);
    expect(await storedPin(b)).toBeNull();
  });

  test("across tabs: two tabs whose listings disagree on the pinned thread's newest page write at most once each — no write loop (D7)", async ({
    context,
  }) => {
    // B loaded before alpha-notes was last worked on (its newest alpha page is
    // alpha); A loaded after (alpha-notes). Each would re-anchor the pin to its
    // own page. A storage event's repaint writes nothing, so the pair settles.
    const b = await context.newPage();
    await watchPinWrites(b);
    (await stageListings(b)).set("grownOlder");
    await openReader(b, THREADS);
    await card(b, ALPHA_CARD).locator(".wiki-thread-pin").click();
    expect(await storedPin(b)).toBe(ALPHA);
    const a = await context.newPage();
    await watchPinWrites(a);
    (await stageListings(a)).set("grown");
    await openReader(a, THREADS);
    await expect.poll(() => storedPin(a)).toBe(ALPHA_NOTES);
    // Let any loop run: with one, both counters climb by hundreds a second.
    await a.waitForTimeout(1_500);
    expect(await pinWrites(a)).toBeLessThanOrEqual(1);
    expect(await pinWrites(b)).toBeLessThanOrEqual(1);
    expect(await storedPin(a)).toBe(ALPHA_NOTES);
    // Both still show the alpha thread pinned.
    await expect(card(a, ALPHA_CARD)).toHaveClass(/\bpinned\b/);
    await expect(card(b, ALPHA_CARD)).toHaveClass(/\bpinned\b/);
  });

  test("across tabs: a localStorage.clear() in another tab unpins this one (D7)", async ({ context }) => {
    const a = await context.newPage();
    const b = await context.newPage();
    await openReader(a, THREADS);
    await card(a, ALPHA_CARD).locator(".wiki-thread-pin").click();
    await openReader(b, THREADS);
    await expect(card(b, ALPHA_CARD)).toHaveClass(/\bpinned\b/);
    await a.evaluate(() => localStorage.clear());
    await expect(card(b, ALPHA_CARD)).not.toHaveClass(/\bpinned\b/);
    expect(await storedPin(b)).toBeNull();
  });

  test("a storage that refuses the write keeps the tab's pin through a re-anchor (D7)", async ({ page }) => {
    await watchPinWrites(page, true);
    const stage = await stageListings(page);
    await page.clock.install();
    await openReader(page, THREADS);
    await card(page, ALPHA_CARD).locator(".wiki-thread-pin").click();
    await expect(card(page, ALPHA_CARD)).toHaveClass(/\bpinned\b/);
    expect(await storedPin(page)).toBeNull();
    // The thread grows; the refetch's render re-anchors the pin. The write is
    // refused again, and the tab keeps the pin it holds.
    stage.set("grown");
    const refetched = page.waitForResponse((r) => r.url().includes("/api/wiki/pages") && r.url().includes(`wiki=${THREADS}`));
    await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refetched;
    await expect(card(page, ALPHA_CARD).locator(".wiki-thread-pin")).toHaveAttribute("data-thread-pin", ALPHA_NOTES);
    await expect(card(page, ALPHA_CARD)).toHaveClass(/\bpinned\b/);
    await expect(cards(page).nth(0).locator(".wiki-thread-name")).toHaveText(ALPHA_CARD);
    expect(await storedPin(page)).toBeNull();
    expect(await pinWrites(page)).toBeGreaterThanOrEqual(2);
  });

  test("keyboard: Enter on a card's fold, a 📌 and a group fold leaves focus on the same control", async ({ page }) => {
    await openReader(page, THREADS);
    // Which control has focus: its class and the card (or group key) it belongs to.
    const focused = () =>
      page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        if (!a || a === document.body) return "body";
        const card = a.closest(".wiki-thread-card");
        return `${a.className.split(" ")[0]}@${card ? card.getAttribute("data-thread") : a.getAttribute("data-fold-key")}`;
      });
    const beta = await cards(page).nth(1).getAttribute("data-thread");
    expect(beta).toBeTruthy();
    // The second card's fold: opens, keeps focus, and the next Tab is its 📌.
    await cards(page).nth(1).locator(".wiki-thread-fold").focus();
    await page.keyboard.press("Enter");
    await expect(cards(page).nth(1).locator(".wiki-thread-fold")).toHaveAttribute("aria-expanded", "true");
    expect(await focused()).toBe(`wiki-thread-fold@${beta}`);
    await page.keyboard.press("Tab");
    expect(await focused()).toBe(`wiki-thread-pin@${beta}`);
    // The 📌 by keyboard: the card moves to the top, and focus moves with it.
    await page.keyboard.press("Enter");
    await expect(cards(page).nth(0)).toHaveAttribute("data-thread", beta!);
    await expect(cards(page).nth(0).locator(".wiki-thread-pin")).toHaveAttribute("aria-pressed", "true");
    expect(await focused()).toBe(`wiki-thread-pin@${beta}`);
    // …and again to unpin: back to second place, focus still on its 📌.
    await page.keyboard.press("Enter");
    await expect(cards(page).nth(1)).toHaveAttribute("data-thread", beta!);
    expect(await focused()).toBe(`wiki-thread-pin@${beta}`);
    // A group fold shares the handler: the series group keeps focus too.
    const series = page.locator('.wiki-list-group.series[data-section="series"] .wiki-group-fold');
    const seriesKey = await series.getAttribute("data-fold-key");
    await series.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".wiki-list-ghost")).toHaveCount(2);
    const after = await focused();
    expect(after.startsWith("wiki-group-fold@"), after).toBe(true);
    expect(after.replace(/^wiki-group-fold@(closed:)?/, ""), after).toBe(seriesKey!.replace(/^closed:/, ""));
  });

  test("no section, no bars, when the ledger 404s the sessions form (D11)", async ({ page }) => {
    const body = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${PLAIN}&refresh=1`)).json()) as { work?: unknown };
    expect(body.work).toBeUndefined();
    await openReader(page, PLAIN);
    await expect(sec(page, "threads")).toHaveCount(0);
    await expect(cards(page)).toHaveCount(0);
    await expect(page.locator(".wiki-work-bar")).toHaveCount(0);
    expect(await relsIn(page, "activity")).toHaveLength(6);
  });

  test("both themes: the card's text reads at 4.5:1", async ({ page }, testInfo) => {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.addInitScript(([key]) => localStorage.setItem(key as string, "300"), [RAIL_WIDTH_KEY] as const);
      await page.setViewportSize({ width: 1400, height: 900 });
      await openReader(page, THREADS);
      for (const sel of [".wiki-thread-name", ".wiki-thread-meta", ".wiki-thread-link", ".wiki-thread-touched-label"]) {
        const c = await paintedContrast(page.locator(sel).first());
        expect(c, `${sel} in ${scheme}`).toBeGreaterThanOrEqual(4.5);
      }
      // The fold state persists across the loop's reloads: open it only if closed.
      const fold = page.locator('.wiki-list-group.series[data-section="series"] .wiki-group-fold');
      if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
      const ghost = await paintedContrast(page.locator(".wiki-list-ghost-note").first());
      expect(ghost, `ghost note in ${scheme}`).toBeGreaterThanOrEqual(4.5);
      // The section, for the PR body.
      const box = await page.evaluate(() => {
        const top = document.querySelector('.wiki-list-sec[data-section="threads"]')!.getBoundingClientRect();
        const last = document.querySelector('.wiki-list-sec[data-section="activity"]')!.getBoundingClientRect();
        return { x: top.left, y: top.top, width: top.width, height: last.top - top.top };
      });
      await page.screenshot({ path: testInfo.outputPath(`work-threads-${scheme}.png`), clip: box });
    }
  });

  test("the 260 px rail: the fullest card row keeps one meta line, and the header stays inside the rail", async ({ page }) => {
    for (const width of [260, 300]) {
      await page.addInitScript(([key, w]) => localStorage.setItem(key as string, String(w)), [RAIL_WIDTH_KEY, width] as const);
      await page.setViewportSize({ width: 1400, height: 900 });
      await openReader(page, THREADS);
      const own = await page.locator(".wiki-thread-card").first().evaluate(headerFit);
      expect(own.issues, `${width} fixture card: ${JSON.stringify(own)}`).toEqual([]);
      const g = await page.locator(`.wiki-list-item[data-section="threads"][data-relpath="${ALPHA}"]`).evaluate((el) => {
        const rect = (e: Element) => e.getBoundingClientRect();
        const rowRight = rect(el).right - parseFloat(getComputedStyle(el).paddingRight);
        const sub = el.querySelector(".wiki-list-sub") as HTMLElement;
        const marks = Array.from(
          sub.querySelectorAll(".wiki-status, .wiki-followup-flag, .wiki-moves-flag, .wiki-new-tag, .wiki-work-bar, .wiki-fold-chip"),
        );
        const mids = marks.map((m) => rect(m).top + rect(m).height / 2);
        const label = Array.from(sub.querySelectorAll(".wiki-fold-chip-label, .wiki-fold-chip-counts")).find(
          (e) => getComputedStyle(e).display !== "none",
        ) as HTMLElement;
        const card = document.querySelector(".wiki-thread-card")!;
        const rail = document.querySelector(".wiki-layout > .wiki-pane:first-child")!;
        const pin = card.querySelector(".wiki-thread-pin")!;
        const meta = card.querySelector(".wiki-thread-meta") as HTMLElement;
        return {
          rail: Math.round(rect(rail).width),
          marks: marks.length,
          spread: Math.max(...mids) - Math.min(...mids),
          pastRow: marks.filter((m) => rect(m).right > rowRight + 0.5).length,
          subOverflow: sub.scrollWidth - sub.clientWidth,
          labelClipped: label.scrollWidth - label.clientWidth > 1,
          pinInRail: rect(pin).right <= rect(rail).right + 0.5,
          metaOverflow: meta.scrollWidth - meta.clientWidth,
          listOverflow: (document.getElementById("wikiList") as HTMLElement).scrollWidth - (document.getElementById("wikiList") as HTMLElement).clientWidth,
        };
      });
      const at = `${width}: ${JSON.stringify(g)}`;
      expect(g.rail, at).toBe(width);
      expect(g.marks, at).toBe(6);
      expect(g.spread, `one meta line, ${at}`).toBeLessThan(6);
      expect(g.pastRow, at).toBe(0);
      expect(g.subOverflow, at).toBeLessThanOrEqual(0);
      expect(g.labelClipped, at).toBe(false);
      expect(g.pinInRail, at).toBe(true);
      expect(g.metaOverflow, at).toBeLessThanOrEqual(0);
      expect(g.listOverflow, at).toBeLessThanOrEqual(0);
    }
  });

  test("the header's width table: every row fits at 260 and 300 px in both themes, nothing cut, each meta line one line", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const rows = headerTable();
    const font = process.env.PW_TEST_CONNECT_WS_ENDPOINT ? "linux" : "local";
    const failures: string[] = [];
    const widest = new Map<string, number>();
    const passes = [
      { rail: 260, viewport: 1400, scheme: "light" },
      { rail: 260, viewport: 1400, scheme: "dark" },
      { rail: 300, viewport: 1400, scheme: "light" },
      { rail: 300, viewport: 1400, scheme: "dark" },
      // Under 260 only through the viewport bound (a 445 px window): the meta
      // lines may wrap at their separators, but nothing may be cut.
      { rail: 200, viewport: 445, scheme: "light" },
      // A 330 px window: the widest part is wider than the line, so it wraps
      // inside itself rather than running under the 📌.
      { rail: 148, viewport: 330, scheme: "light" },
    ] as const;
    for (const p of passes) {
      await page.emulateMedia({ colorScheme: p.scheme });
      await page.addInitScript(([key, w]) => localStorage.setItem(key as string, String(w)), [RAIL_WIDTH_KEY, p.rail] as const);
      await page.setViewportSize({ width: p.viewport, height: 900 });
      await openReader(page, THREADS);
      // Every table row, through the real renderer, after the fixture's cards.
      await page.locator(".wiki-thread-card").last().evaluate((el, html) => el.insertAdjacentHTML("afterend", html), rows.map((r) => r.html).join(""));
      const all = page.locator(".wiki-thread-card");
      const total = await all.count();
      const fits: Array<Awaited<ReturnType<typeof headerFit>>> = [];
      for (let i = total - rows.length; i < total; i++) fits.push(await all.nth(i).evaluate(headerFit));
      const railW = await page.locator(".wiki-layout > .wiki-pane:first-child").evaluate((e) => Math.round(e.getBoundingClientRect().width));
      expect(railW, `${JSON.stringify(p)}`).toBe(p.rail);
      const list = await page.locator("#wikiList").evaluate((e) => e.scrollWidth - e.clientWidth);
      if (list > 0 && p.rail >= 200) failures.push(`${p.rail}/${p.scheme}: #wikiList scrolls ${list} px sideways`);
      for (const [i, f] of fits.entries()) {
        const at = `${font} ${p.rail}/${p.scheme} [${rows[i]!.id}]`;
        for (const issue of f.issues) failures.push(`${at}: ${issue}`);
        if (f.lines.length !== 2) failures.push(`${at}: ${f.lines.length} meta lines, not 2`);
        const maxLines = p.rail >= 260 ? 1 : p.rail >= 200 ? 2 : 4;
        for (const l of f.lines) if (l.lines > maxLines) failures.push(`${at}: .${l.cls} takes ${l.lines} lines`);
        // Down to 200 px a line breaks only BETWEEN its parts.
        if (p.rail >= 200) for (const q of f.partLines) if (q.lines > 1) failures.push(`${at}: "${q.text}" breaks inside itself`);
        if (f.nameLines > 2) failures.push(`${at}: the name takes ${f.nameLines} lines`);
        if (p.rail >= 260 && p.scheme === "light") {
          widest.set(`label @${p.rail}`, Math.min(widest.get(`label @${p.rail}`) ?? Infinity, f.label));
          for (const part of f.parts)
            if (!NAMES.includes(part.text)) widest.set(part.text, Math.max(widest.get(part.text) ?? 0, part.width));
        }
      }
    }
    // The width table for src/wiki/CLAUDE.md and the PR body.
    console.log(`[width table, ${font}] ` + JSON.stringify(Object.fromEntries([...widest].map(([k, v]) => [k, Math.round(v * 10) / 10]))));
    // By kind (the row and the text left out), so a red run reads at a glance.
    const kinds = new Map<string, number>();
    for (const f of failures) {
      const k = f.replace(/\[[^\]]*\]/, "").replace(/"[^"]*"/, "…").replace(/\(\d+ px of text in \d+ px\)/, "");
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    expect(failures.slice(0, 20), `${failures.length} failures: ${JSON.stringify(Object.fromEntries(kinds))}`).toEqual([]);
  });

  test("the 📌 keeps one name while aria-pressed flips, and is a 24 px target; the fold's name carries the meta", async ({ page }) => {
    await openReader(page, THREADS);
    const pin = cards(page).nth(1).locator(".wiki-thread-pin");
    await expect(pin).toHaveAccessibleName("Pin this work thread first");
    await expect(pin).toHaveAttribute("aria-pressed", "false");
    const box = (await pin.boundingBox())!;
    expect(box.width, JSON.stringify(box)).toBeGreaterThanOrEqual(24);
    expect(box.height, JSON.stringify(box)).toBeGreaterThanOrEqual(24);
    await pin.click();
    const pressed = cards(page).nth(0).locator(".wiki-thread-pin");
    await expect(pressed).toHaveAttribute("aria-pressed", "true");
    await expect(pressed).toHaveAccessibleName("Pin this work thread first");
    // The hover tells a mouse user the state and what a click does; the name
    // stays fixed, so a screen reader hears no "Unpin …, pressed".
    await expect(pressed).toHaveAttribute("title", "Pinned first. Click to unpin");
    await expect(pressed).toHaveAccessibleDescription("Pinned first. Click to unpin");
    expect(await cards(page).nth(0).ariaSnapshot()).toContain('button "Pin this work thread first" [pressed]');
    await pressed.click();
    await expect(cards(page).nth(1).locator(".wiki-thread-pin")).toHaveAttribute("title", "Pin this work thread first");
    await expect(cards(page).nth(0).locator(".wiki-thread-name")).toHaveText("Alpha work");
    // The fold's name speaks the meta; its description (the hover) does not
    // repeat it, and still lists the sessions.
    const fold = cards(page).nth(0).locator(".wiki-thread-fold");
    await expect(fold).toHaveAccessibleName(/Alpha work.*2 sessions.*✋ 12/);
    await expect(fold).toHaveAccessibleDescription(/session a1/);
    await expect(fold).not.toHaveAccessibleDescription(/sessions|✋/);
  });

  test("both themes, by the OS and by the theme toggle: the resting 📌's median ink pixel reads at 3:1 against the rail", async ({
    page,
  }) => {
    // The toggle's html[data-theme] beats the OS preference: each forced theme
    // is measured under the OPPOSITE OS scheme, so a missing or swapped
    // override line paints the other theme's pin.
    const cases = [
      { os: "light", forced: null, theme: "light" },
      { os: "dark", forced: null, theme: "dark" },
      { os: "dark", forced: "light", theme: "light" },
      { os: "light", forced: "dark", theme: "dark" },
    ] as const;
    for (const { os, forced, theme } of cases) {
      await page.emulateMedia({ colorScheme: os });
      await openReader(page, THREADS);
      await page.evaluate((t) => {
        if (t) document.documentElement.setAttribute("data-theme", t);
        else document.documentElement.removeAttribute("data-theme");
      }, forced);
      const pin = cards(page).nth(1).locator(".wiki-thread-pin");
      await expect(pin).toHaveAttribute("aria-pressed", "false");
      await page.mouse.move(0, 0);
      const c = await pinPixels(page, pin);
      const at = `resting 📌, OS ${os}, toggle ${forced ?? "none"}: ${JSON.stringify(c)}`;
      // The rail really is the theme under test, so the case measures that theme.
      expect(c.bg > 0.5, at).toBe(theme === "light");
      expect(c.ink, at).toBeGreaterThan(20);
      expect(c.p50, at).toBeGreaterThanOrEqual(3);
    }
  });

  test("the pressed 📌 is the coloured pin and the resting one grey, in both themes and in forced colours, with no backplate square", async ({
    page,
  }) => {
    // Forced colours by the OS scheme and by the theme toggle, whose
    // html[data-theme] rules out-rank the OS ones.
    const cases = [
      { forcedColors: "none", colorScheme: "light", toggle: null },
      { forcedColors: "none", colorScheme: "dark", toggle: null },
      { forcedColors: "active", colorScheme: "light", toggle: null },
      { forcedColors: "active", colorScheme: "dark", toggle: null },
      { forcedColors: "active", colorScheme: "dark", toggle: "light" },
      { forcedColors: "active", colorScheme: "light", toggle: "dark" },
    ] as const;
    for (const { forcedColors, colorScheme, toggle } of cases) {
        await page.emulateMedia({ colorScheme, forcedColors });
        await openReader(page, THREADS);
        if (toggle) await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), toggle);
        const resting = cards(page).nth(1).locator(".wiki-thread-pin");
        await expect(resting).toHaveAttribute("aria-pressed", "false");
        await page.mouse.move(0, 0);
        const rest = await pinPixels(page, resting);
        await resting.click();
        const pressed = cards(page).nth(0).locator(".wiki-thread-pin");
        await expect(pressed).toHaveAttribute("aria-pressed", "true");
        await page.mouse.move(0, 0);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        const on = await pinPixels(page, pressed);
        await pressed.click();
        await expect(cards(page).nth(0).locator(".wiki-thread-pin")).toHaveAttribute("aria-pressed", "false");
        const at = `${forcedColors} ${colorScheme} toggle ${toggle}: resting ${JSON.stringify(rest)}, pressed ${JSON.stringify(on)}`;
        console.log(`[pin] ${at}`);
        expect(rest.chroma, `the resting 📌 is grey, ${at}`).toBeLessThan(16);
        expect(on.chroma, `the pressed 📌 keeps its colour, ${at}`).toBeGreaterThan(80);
        expect(rest.p50, `the resting 📌 reads at 3:1, ${at}`).toBeGreaterThanOrEqual(3);
        for (const [state, px] of [["resting", rest], ["pressed", on]] as const)
          expect(px.square, `no solid square behind the ${state} 📌, ${at}`).toBeLessThan(0.04);
      }
  });

  test("a card's newest series plan: the latest dot sits on the card's rule, and the rule shows above and below it", async ({ page }) => {
    await openReader(page, THREADS);
    const row = page.locator(`.wiki-list-item.thread-row.latest[data-relpath="${ALPHA}"]`);
    await expect(row).toHaveCount(1);
    const g = await row.evaluate((el) => {
      const box = (pseudo: string) => {
        const cs = getComputedStyle(el, pseudo);
        const h = el.getBoundingClientRect().height;
        const left = parseFloat(cs.left);
        const top = parseFloat(cs.top);
        const height = cs.height === "auto" ? h - top - parseFloat(cs.bottom) : parseFloat(cs.height);
        return { left, right: left + parseFloat(cs.width), top, bottom: top + height, content: cs.content };
      };
      return { rule: box("::before"), dot: box("::after") };
    });
    const at = JSON.stringify(g);
    expect(g.rule.content, at).not.toBe("none");
    expect(g.dot.content, at).not.toBe("none");
    const mid = (b: { left: number; right: number }) => (b.left + b.right) / 2;
    expect(Math.abs(mid(g.dot) - mid(g.rule)), `dot centred on the rule, ${at}`).toBeLessThanOrEqual(0.5);
    // The dot's 2px ring included: the rule is still drawn above and below it.
    expect(g.dot.top - 2 - g.rule.top, `rule above the dot, ${at}`).toBeGreaterThanOrEqual(3);
    expect(g.rule.bottom - (g.dot.bottom + 2), `rule below the dot, ${at}`).toBeGreaterThanOrEqual(3);
  });
});
