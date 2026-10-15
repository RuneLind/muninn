/**
 * /wiki rail — the **Work threads** section (plan `muninn-wiki-work-threads`,
 * PR 5): the cards above Activity, the lift out of Activity and the series
 * ghost (D13), the 📌 surviving a reload (D7), no section when the ledger
 * 404s the sessions form (D11), both themes, and the 260 px rail.
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
import { threadPinKey } from "../src/dashboard/views/components/wiki-recents.ts";

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
    return json({ form: "sessions", root, sessions, truncated: false });
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
});
