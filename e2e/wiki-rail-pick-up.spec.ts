/**
 * /wiki rail — the **Pick up** strip and the cards' **age chip** (plan
 * `muninn-wiki-pick-up`, PR 3: D2, D5, D6, D11, D12, D14): five rows newest
 * first from focus rows only (a touch never shows, a page and its `.html`
 * attachment are one row); a click and Enter open the card that draws the
 * page (through a closed group and `+ N more threads`), scroll it into view
 * and highlight the row; a page no drawn card holds opens itself; a strip row
 * adds no page row, no `data-relpath`, no current-page mark and nothing to
 * `#wikiCount`; the fold survives a reload; the strip hides during a search;
 * and every card shows an age chip in both themes, its colours the tokens
 * resolved on a body probe.
 *
 * A browser is needed because the chain is `/api/files?sessions=1` → the
 * work-sessions memo → `work` (and its evidence) on the listing →
 * `railInputFor` → `buildRail` → `renderList`, and the jump writes folds and
 * presses `+ N more` through the same handlers a reader's clicks do; the unit
 * tests (`wiki-pick-up.test.ts`) hand `buildRail` its input.
 *
 * ONE muninn, ONE temp wiki (`wspickup`), ONE fake `node:http` claude-usage.
 * Nine sessions, one focus page each, by recency of focus:
 *
 *  - `alpha-4` (0.5 h, 2 edits) — the fourth child of the `alpha` SERIES group,
 *    behind `+ 1 more threads`. Its session also edits `ctx.md` once at
 *    0.25 h: a page with a write before the window, so a touch (the newest
 *    event of all, which the strip must not show).
 *  - `solo-5` (1.5 h, 2 edits) — a lone thread sixth by work score: past the
 *    five-card cap, so its row opens the page (D12).
 *  - `alpha-1` (6 h, 40 edits, plus 1 on `alpha-1.html`, its stem attachment),
 *    `alpha-2` (7 h), `alpha-3` (8 h) — the group's three drawn children.
 *  - `solo-1`…`solo-4` (9–12 h) — the four lone cards after the group.
 *
 * Synthetic names only. No model calls; the only writes are the reader's own
 * localStorage.
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

const PORT = e2ePort("wiki-rail-pick-up");
const LEDGER_PORT = e2ePort("wiki-rail-pick-up/ledger");
const BASE = `http://127.0.0.1:${PORT}`;
const LEDGER_BASE = `http://127.0.0.1:${LEDGER_PORT}`;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const WIKI = "wspickup";
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.now();

const A = ["plans/alpha-1.md", "plans/alpha-2.md", "plans/alpha-3.md", "plans/alpha-4.md"];
const A1_HTML = "plans/alpha-1.html";
const SOLO = ["notes/solo-1.md", "notes/solo-2.md", "notes/solo-3.md", "notes/solo-4.md", "notes/solo-5.md"];
const CTX = "notes/ctx.md";

/** id, hours ago, the page the prompt names, files written with their edits
 *  (and, per file, its own hours ago when it differs). */
const SESSIONS: { id: string; at: number; named: string; files: [string, number, number?][] }[] = [
  { id: "g4", at: 0.5, named: A[3]!, files: [[A[3]!, 2], [CTX, 1, 0.25]] },
  { id: "s5", at: 1.5, named: SOLO[4]!, files: [[SOLO[4]!, 2]] },
  { id: "g1", at: 6, named: A[0]!, files: [[A[0]!, 40], [A1_HTML, 1]] },
  { id: "g2", at: 7, named: A[1]!, files: [[A[1]!, 30]] },
  { id: "g3", at: 8, named: A[2]!, files: [[A[2]!, 20]] },
  { id: "s1", at: 9, named: SOLO[0]!, files: [[SOLO[0]!, 20]] },
  { id: "s2", at: 10, named: SOLO[1]!, files: [[SOLO[1]!, 15]] },
  { id: "s3", at: 11, named: SOLO[2]!, files: [[SOLO[2]!, 12]] },
  { id: "s4", at: 12, named: SOLO[3]!, files: [[SOLO[3]!, 10]] },
];
/** The strip's rows, newest focus first. */
const STRIP = [A[3]!, SOLO[4]!, A[0]!, A[1]!, A[2]!];

let root = "";
let server: ChildProcess | undefined;
let ledger: Server | undefined;

function ledgerAnswer(res: import("node:http").ServerResponse, url: URL): void {
  const json = (body: unknown, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const at = (h: number) => NOW - h * HOUR;
  if (url.searchParams.get("sessions") === "1") {
    const sessions = SESSIONS.map((s) => ({
      id: s.id,
      provider: "claude",
      title: `session ${s.id}`,
      first: at(s.at) - 30 * 60_000,
      last: Math.max(...s.files.map(([, , h]) => at(h ?? s.at))),
      bulk: false,
      text: { from: "prompt", paths: [s.named], links: [], files: [] },
      files: s.files.map(([p, edits, h]) => ({ p, edits, firstMs: at(h ?? s.at) - 30 * 60_000, lastMs: at(h ?? s.at) })),
    }));
    const since = Number(url.searchParams.get("since"));
    const until = url.searchParams.has("until") ? Number(url.searchParams.get("until")) : Date.now();
    return json({ form: "sessions", root, since, until, limit: 200, truncated: false, sessions });
  }
  const until = url.searchParams.get("until");
  if (until) {
    // ctx.md had a write before the window, so g4 only TOUCHES it.
    const pre = [{ p: CTX, w: NOW - 20 * DAY, s: 1 }];
    return json({ root, pages: pre, pageCount: pre.length, bulk: 10, limit: 5000, truncated: false, until: Number(until) });
  }
  const pages = SESSIONS.flatMap((s) => s.files.map(([p, , h]) => ({ p, w: at(h ?? s.at), s: 1 })));
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

async function makeRoot(): Promise<void> {
  root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-pickup-${WIKI}-`));
  await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify({ activity: { agePenalty: 0, hubPenalty: 0, planBoost: 0, rows: 8 } }), "utf8");
  const write = async (rel: string, text: string, agoMs: number) => {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, text, "utf8");
    const stamp = new Date(NOW - agoMs);
    await utimes(abs, stamp, stamp);
  };
  const md = (fm: string[]) => ["---", ...fm, "created: 2025-01-01", "---", "", "Body.", ""].join("\n");
  for (const [i, rel] of A.entries()) await write(rel, md([`title: Alpha ${i + 1}`, "series: alpha", "series_label: Alpha series"]), (6 + i) * HOUR);
  await write(A1_HTML, `<!doctype html><html><head><title>Alpha 1 page</title></head><body><p>x</p></body></html>`, 6 * HOUR);
  for (const [i, rel] of SOLO.entries()) await write(rel, md([`title: Solo ${i + 1}`]), (9 + i) * HOUR);
  await write(CTX, md(["title: Shared context page"]), 20 * DAY);
  for (let i = 1; i <= 4; i++) await write(`notes/old-${i}.md`, md([`title: Old ${i}`]), (10 + i) * DAY);
}

test.beforeAll(async () => {
  await makeRoot();
  ledger = await startLedger();
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root}`,
      CLAUDE_USAGE_URL: LEDGER_BASE,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
  const warm = Date.now() + 20_000;
  for (;;) {
    const b = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}&refresh=1`)).json()) as { work?: { threads: unknown[]; evidence?: unknown } };
    if (b.work?.threads.length === SESSIONS.length && b.work.evidence) break;
    if (Date.now() > warm) throw new Error("the work-sessions memo never warmed: " + JSON.stringify(b.work?.threads.length));
    await new Promise((r) => setTimeout(r, 300));
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise<void>((resolve) => (ledger ? ledger.close(() => resolve()) : resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});

const strip = (page: Page) => page.locator("#wikiList .wiki-pickup");
const stripRows = (page: Page) => page.locator("#wikiList .wiki-pickup-row");
const stripRow = (page: Page, rel: string) => page.locator(`#wikiList .wiki-pickup-row[data-pickup="${rel}"]`);
const header = (page: Page) => page.locator('#wikiList .wiki-list-sec[data-section="pickup"]');
const cardOf = (page: Page, rel: string) => page.locator(`#wikiList .wiki-thread-card[data-thread="thread:${rel}"]`);
const threadRow = (page: Page, rel: string) => page.locator(`#wikiList .wiki-list-item[data-section="threads"][data-relpath="${rel}"]`);
const GROUP = "group:series:alpha";
const groupCard = (page: Page) => page.locator(`#wikiList > .wiki-thread-card[data-thread-group="${GROUP}"]`);

async function openReader(page: Page, query = ""): Promise<void> {
  const listing = page.waitForResponse((r) => r.url().includes("/api/wiki/pages") && r.url().includes(`wiki=${WIKI}`) && r.ok());
  await page.goto(`${BASE}/wiki?wiki=${WIKI}${query}`);
  await listing;
  await expect(page.locator('.wiki-list-sec[data-section="threads"]')).toHaveCount(1);
}

test.describe("Wiki rail: Pick up", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  test("five rows newest first, focus only: no touch, one row for a page and its attachment, above Work threads", async ({ page }) => {
    await openReader(page);
    await expect(stripRows(page)).toHaveCount(5);
    expect(await stripRows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-pickup")))).toEqual(STRIP);
    // The header: foldable, open by default, its count the rows.
    await expect(header(page).locator(".wiki-sec-label")).toHaveText("Pick up");
    await expect(header(page).locator(".wiki-sec-count")).toHaveText("5");
    await expect(header(page).locator("[data-fold-key]")).toHaveAttribute("aria-expanded", "true");
    // Above Work threads, in DOM order.
    const order = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#wikiList > .wiki-list-sec, #wikiList > .wiki-pickup")).map((e) => e.getAttribute("data-section")),
    );
    expect(order.slice(0, 3)).toEqual(["pickup", "pickup", "threads"]);
    // Line 1 the age and title, line 2 edits, sessions and the drawing card.
    const first = stripRow(page, A[3]!);
    await expect(first.locator(".wiki-pickup-title")).toHaveText("Alpha 4");
    await expect(first.locator(".wiki-pickup-age")).toContainText("now");
    await expect(first.locator(".wiki-pickup-meta")).toHaveText("2 edits · 1 session · in Alpha 4");
    await expect(stripRow(page, A[0]!).locator(".wiki-pickup-meta")).toHaveText("41 edits · 1 session · in Alpha 1");
    await expect(stripRow(page, SOLO[4]!).locator(".wiki-pickup-meta")).toHaveText("2 edits · 1 session · not in Work threads");
    await expect(stripRow(page, SOLO[4]!)).toHaveAttribute("data-pickup-to", "page");
  });

  test("pointers, not rows: no data-relpath, no current-page mark, no page row added, #wikiCount unchanged", async ({ page }) => {
    await openReader(page, `&relPath=${encodeURIComponent(A[0]!)}`);
    await expect(stripRows(page)).toHaveCount(5);
    await expect(strip(page).locator("[data-relpath]")).toHaveCount(0);
    await expect(strip(page).locator(".active")).toHaveCount(0);
    await expect(stripRow(page, A[0]!)).not.toHaveClass(/active/);
    const rels = await page.locator("#wikiList .wiki-list-item[data-relpath]").evaluateAll((els) => els.map((e) => e.getAttribute("data-relpath")));
    expect(new Set(rels).size).toBe(rels.length);
    const open = await page.locator("#wikiCount").textContent();
    // Folding the strip moves no page row and no count.
    await header(page).locator("[data-fold-key]").click();
    await expect(strip(page)).toHaveCount(0);
    expect(await page.locator("#wikiCount").textContent()).toBe(open);
    const after = await page.locator("#wikiList .wiki-list-item[data-relpath]").evaluateAll((els) => els.map((e) => e.getAttribute("data-relpath")));
    expect(after).toEqual(rels);
    await header(page).locator("[data-fold-key]").click();
    await expect(strip(page)).toHaveCount(1);
  });

  test("a click opens the card through + N more, scrolls it into view and highlights the row", async ({ page }) => {
    await openReader(page);
    await expect(groupCard(page).locator(".wiki-thread-fold")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`[data-thread-more="${GROUP}"]`)).toHaveText(/\+ 1 more thread/);
    await expect(cardOf(page, A[3]!)).toHaveCount(0);
    await stripRow(page, A[3]!).click();
    await expect(cardOf(page, A[3]!).locator(".wiki-thread-fold")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`[data-thread-more="${GROUP}"]`)).toHaveCount(0);
    await expect(threadRow(page, A[3]!)).toHaveClass(/pickup-hl/);
    await expect(threadRow(page, A[3]!)).toBeInViewport();
    // One highlighted row, and the strip is unchanged.
    await expect(page.locator("#wikiList .pickup-hl")).toHaveCount(1);
    await expect(stripRows(page)).toHaveCount(5);
  });

  test("Enter does the same through a closed group, and focus stays on the strip row", async ({ page }) => {
    await openReader(page);
    await groupCard(page).locator(".wiki-thread-fold").click();
    await expect(groupCard(page).locator(".wiki-thread-fold")).toHaveAttribute("aria-expanded", "false");
    await expect(threadRow(page, A[1]!)).toHaveCount(0);
    await stripRow(page, A[1]!).focus();
    await page.keyboard.press("Enter");
    await expect(groupCard(page).locator(".wiki-thread-fold")).toHaveAttribute("aria-expanded", "true");
    await expect(cardOf(page, A[1]!).locator(".wiki-thread-fold")).toHaveAttribute("aria-expanded", "true");
    await expect(threadRow(page, A[1]!)).toHaveClass(/pickup-hl/);
    await expect(threadRow(page, A[1]!)).toBeInViewport();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-pickup"))).toBe(A[1]);
    // A second Enter on a row whose card is drawn open only reveals it.
    await page.keyboard.press("Enter");
    await expect(threadRow(page, A[1]!)).toHaveClass(/pickup-hl/);
    await expect(cardOf(page, A[1]!).locator(".wiki-thread-fold")).toHaveAttribute("aria-expanded", "true");
  });

  test("a page no drawn card holds opens the page itself (D12)", async ({ page }) => {
    await openReader(page);
    await expect(page.locator(`#wikiList .wiki-thread-card[data-thread="thread:${SOLO[4]}"]`)).toHaveCount(0);
    await stripRow(page, SOLO[4]!).click();
    await page.waitForURL((u) => u.searchParams.get("relPath") === SOLO[4]);
    await expect(page.locator("#articleWrap h1").first()).toContainText("Solo 5");
  });

  test("the fold survives a reload, per wiki", async ({ page }) => {
    await openReader(page);
    await header(page).locator("[data-fold-key]").click();
    await expect(strip(page)).toHaveCount(0);
    await expect(header(page).locator("[data-fold-key]")).toHaveAttribute("aria-expanded", "false");
    await expect(header(page).locator(".wiki-sec-count")).toHaveText("5");
    await openReader(page);
    await expect(header(page).locator("[data-fold-key]")).toHaveAttribute("aria-expanded", "false");
    await expect(strip(page)).toHaveCount(0);
    await header(page).locator("[data-fold-key]").click();
    await expect(stripRows(page)).toHaveCount(5);
    await openReader(page);
    await expect(stripRows(page)).toHaveCount(5);
  });

  test("the strip hides while a search query is active", async ({ page }) => {
    await openReader(page);
    await page.fill("#wikiSearch", "solo");
    await expect(header(page)).toHaveCount(0);
    await expect(strip(page)).toHaveCount(0);
    await page.fill("#wikiSearch", "");
    await expect(stripRows(page)).toHaveCount(5);
  });

  test("every card shows an age chip in both themes, painted with the tokens a body probe resolves", async ({ page }) => {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await openReader(page);
      // Open the group's + 1 more, so every child card is drawn.
      await page.locator(`[data-thread-more="${GROUP}"]`).click();
      const chips = await page.evaluate(() => {
        const probe = document.createElement("div");
        document.body.append(probe);
        const token = (v: string) => {
          probe.style.color = `var(${v})`;
          return getComputedStyle(probe).color;
        };
        const text = token("--text-secondary");
        const border = token("--border-secondary");
        probe.remove();
        return Array.from(document.querySelectorAll("#wikiList .wiki-thread-card")).map((c) => {
          const chip = c.querySelector(":scope > .wiki-thread-fold .wiki-thread-age") as HTMLElement | null;
          const cs = chip ? getComputedStyle(chip) : null;
          return {
            card: c.getAttribute("data-thread") ?? c.getAttribute("data-thread-group"),
            text: chip?.textContent ?? null,
            color: cs?.color === text,
            border: cs?.borderTopColor === border,
          };
        });
      });
      // The group, its four children and the four lone cards.
      expect(chips, scheme).toHaveLength(9);
      for (const c of chips) {
        expect(c.text, `${c.card} in ${scheme}`).toMatch(/^(now|\d+h|\d+d)$/);
        expect(c.color && c.border, `${c.card} in ${scheme}`).toBe(true);
      }
      // D14: the span line is `since <first>`; no `→ last` end anywhere.
      await expect(page.locator("#wikiList .wiki-thread-to")).toHaveCount(0);
      await expect(page.locator("#wikiList .wiki-thread-since").first()).toHaveText("since");
    }
  });

  test("the strip at the 260 px rail: each row two lines, inside the rail, nothing spilling", async ({ page }) => {
    for (const width of [260, 300]) {
      await page.addInitScript(([key, w]) => localStorage.setItem(key as string, String(w)), [RAIL_WIDTH_KEY, width] as const);
      await openReader(page);
      const fit = await page.evaluate(() => {
        const rail = document.querySelector(".wiki-layout > .wiki-pane:first-child")!.getBoundingClientRect();
        return Array.from(document.querySelectorAll<HTMLElement>("#wikiList .wiki-pickup-row")).map((row) => {
          const r = row.getBoundingClientRect();
          const lines = (el: HTMLElement) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
          const title = row.querySelector<HTMLElement>(".wiki-pickup-title")!;
          const meta = row.querySelector<HTMLElement>(".wiki-pickup-meta")!;
          return { right: r.right <= rail.right + 0.5, titleLines: lines(title), metaLines: lines(meta), overflow: row.scrollWidth - row.clientWidth };
        });
      });
      expect(fit, `${width}`).toHaveLength(5);
      for (const f of fit) expect(f, `${width}`).toEqual({ right: true, titleLines: 1, metaLines: 1, overflow: 0 });
    }
  });
});
