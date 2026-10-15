/**
 * /wiki rail — worked-on SUBSTITUTION in the **Activity** ranking, and the
 * per-wiki `workedGate` in front of it (plan acceptance 6: above the gate the
 * rows change to the pages a session wrote; below it the ranking is what it was).
 *
 * A browser is needed because the chain is `/api/files` → the store's memo →
 * `workedMs` on the listing → `setPagesData`'s one gate measurement →
 * `renderList`; a unit test can hand the ranker a verdict but cannot prove the
 * verdict is measured once over the whole payload.
 *
 * ONE muninn, FIVE temp wikis, ONE fake `node:http` claude-usage. Four hold the
 * SAME eight pages; the fifth, `wswork`, holds its own. The update signal is
 * the file mtime (the roots are not git repos, so mtime is trusted outright)
 * and is set to an exact offset, so every score is a function of the fixture
 * alone. The four differ only in what the ledger answers:
 *
 *  - `wsopen` — 5 of 8 candidates covered (62.5%), gate open at the default 60.
 *    Worked dates are both OLDER (the sweep shape: demote) and NEWER (promote)
 *    than the mtimes.
 *  - `wsshut` — 2 of 8 covered (25%), gate shut.
 *  - `wsnone` — the ledger knows nothing: the pre-feature ranking, which the
 *    shut wiki must reproduce row for row.
 *  - `wslow` — 2 of 8 covered (25%), but its own `.wiki-reader.json` declares
 *    `workedGate: 20`, so it opens: alpha's 12h-old update demotes to its
 *    8-day-old worked date, charlie promotes to its 1.5-day one.
 *
 * `wswork` is the only wiki whose ledger also answers the SESSIONS form (plan
 * `muninn-wiki-work-threads` PR 4), so the work term ranks its Activity: four
 * pages with session events (`crowded`, `focused`, `touched`, `worst`), one
 * without (`quiet`), and twelve attachments each under `crowded` and `worst`.
 * `worst` carries the fullest meta line a row can have — pill, ⚑, ✋ 12, NEW,
 * the work bar and the group chip — and the fit case measures it at 260px.
 *
 * No model calls and no writes.
 *
 * ENV PREREQUISITE: a working `.env` (`DATABASE_URL` at minimum) at the repo
 * root — the spawned `src/index.ts` boots the full process.
 *
 * SPAWN ENV: `e2eEnv()` blanks `CLAUDE_USAGE_URL` among the instance flags, so
 * it is set AFTER it.
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
import { foldsKey } from "../src/dashboard/views/components/wiki-recents.ts";

const PORT = e2ePort("wiki-activity-worked");
const LEDGER_PORT = e2ePort("wiki-activity-worked/ledger");
const BASE = `http://127.0.0.1:${PORT}`;
const LEDGER_BASE = `http://127.0.0.1:${LEDGER_PORT}`;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const OPEN_WIKI = "wsopen";
/** A fifth wiki whose ledger ALSO answers the sessions form with events (plan
 *  `muninn-wiki-work-threads` PR 4): the work term ranks Activity there, and
 *  every row with events carries a work bar. */
const WORK_WIKI = "wswork";
const SHUT_WIKI = "wsshut";
const NONE_WIKI = "wsnone";
const LOW_WIKI = "wslow";

const DAY = 86_400_000;
const NOW = Date.now();

/**
 * The eight pages: where they live, how many days ago their mtime is (the
 * update signal), and how many days ago a session last wrote them per wiki
 * (`undefined` = the ledger has no qualifying write).
 */
const PAGES = [
  { rel: "notes/alpha.md", updated: 0.5 },
  { rel: "notes/bravo.md", updated: 1 },
  { rel: "notes/charlie.md", updated: 6 },
  { rel: "notes/delta.md", updated: 2 },
  { rel: "notes/echo.md", updated: 3 },
  { rel: "facet/foxtrot.md", updated: 7 },
  { rel: "facet/golf.md", updated: 2.5 },
  { rel: "facet/hotel.md", updated: 3.5 },
] as const;

const WORKED: Record<string, Record<string, number>> = {
  // alpha and delta OLDER than their mtime (demote), charlie, echo and foxtrot
  // NEWER (promote); bravo, golf, hotel uncovered. 5/8.
  [OPEN_WIKI]: {
    "notes/alpha.md": 8,
    "notes/charlie.md": 0.25,
    "notes/delta.md": 4.5,
    "notes/echo.md": 1.5,
    "facet/foxtrot.md": 0.75,
  },
  // The same two stamps that promote charlie and foxtrot hardest on `wsopen` —
  // a leaking gate would lift them to the top here. 2/8.
  [SHUT_WIKI]: { "notes/charlie.md": 0.25, "facet/foxtrot.md": 0.75 },
  [NONE_WIKI]: {},
  [LOW_WIKI]: { "notes/alpha.md": 8, "notes/charlie.md": 1.5 },
};

/** mtime order: the ranking with nothing substituted. */
const CLOSED_ORDER = [
  "notes/alpha.md",
  "notes/bravo.md",
  "notes/delta.md",
  "facet/golf.md",
  "notes/echo.md",
  "facet/hotel.md",
  "notes/charlie.md",
  "facet/foxtrot.md",
];
/** Each covered page placed by its worked day, uncovered ones by mtime. */
const OPEN_ORDER = [
  "notes/charlie.md", // worked 0.25 (mtime 6)
  "facet/foxtrot.md", // worked 0.75 (mtime 7)
  "notes/bravo.md", // mtime 1, uncovered
  "notes/echo.md", // worked 1.5 (mtime 3)
  "facet/golf.md", // mtime 2.5, uncovered
  "facet/hotel.md", // mtime 3.5, uncovered
  "notes/delta.md", // worked 4.5 (mtime 2)
  "notes/alpha.md", // worked 8 (mtime 0.5)
];

const day = (ago: number) => {
  const d = new Date(NOW - ago * DAY);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** Far enough back that no row is placed by its creation. */
const CREATED = day(40);

/** `wslow`: alpha demoted to its worked 8 days, charlie promoted to its
 *  worked 1.5 days, everything else on its mtime. */
const LOW_ORDER = [
  "notes/bravo.md",
  "notes/charlie.md",
  "notes/delta.md",
  "facet/golf.md",
  "notes/echo.md",
  "facet/hotel.md",
  "facet/foxtrot.md",
  "notes/alpha.md",
];

/**
 * The three penalties off so every score is 0.7 × recency, and the orders
 * above read straight off the day offsets. `rows: 8` so truncation never does
 * the cutting. Only `wslow` declares a `workedGate`; the others run the
 * shipped default.
 */
const readerConfig = (wiki: string): string =>
  JSON.stringify({
    activity: {
      agePenalty: 0,
      hubPenalty: 0,
      planBoost: 0,
      rows: 8,
      ...(wiki === LOW_WIKI ? { workedGate: 20 } : {}),
    },
  });

const roots: Record<string, string> = {};
let server: ChildProcess | undefined;
let ledger: Server | undefined;

const HOUR = 3_600_000;
/**
 * `wswork`: `crowded` (an in-flight plan with a ⚑ and twelve attachments — the
 * crowded meta line the work bar has to fit) and `focused` each had a session
 * focus on them; `touched` got one passing edit, committed 40 minutes later;
 * `quiet` has no session at all. `touched`'s last write before the window was
 * 20 days back, so it is state T. `worst` is the fullest meta line a row can
 * carry: pill, ⚑, ✋ 12, NEW (created today, so its creation outscores its one
 * passing edit) and a work bar, then twelve attachments' chip. Its rank depends
 * on the hour the suite runs, so the order assertions leave it out.
 */
const WORK = {
  crowded: { rel: "plans/crowded.mdx", at: 1, edits: 20, named: true, mtimeH: 1 },
  focused: { rel: "notes/focused.md", at: 3, edits: 12, named: true, mtimeH: 3 },
  touched: { rel: "notes/touched.md", at: 3, edits: 1, named: false, mtimeH: 3 - 40 / 60 },
  worst: { rel: "plans/worst.mdx", at: 2, edits: 1, named: false, mtimeH: 0.5 },
} as const;
const QUIET = "notes/quiet.md";
const ATTACHED = 12;
/** Penalties off: crowded's work 1.05, focused's 0.94, quiet's change 0.22,
 *  touched's work 0.06 — the late commit is inside the day, so not a change. */
const WORK_ORDER = [WORK.crowded.rel, WORK.focused.rel, QUIET, WORK.touched.rel];
/** Every Activity row on `wswork`: the ordered four plus `worst`. */
const WORK_ROWS = WORK_ORDER.length + 1;

function ledgerAnswer(root: string, url?: URL): string {
  const wiki = Object.keys(roots).find((k) => roots[k] === root);
  // The work-sessions memo's two requests. Every wiki but `wswork` gets an
  // empty window, so its pages carry no `work` and rank exactly as before.
  if (url?.searchParams.get("sessions") === "1") {
    const sessions =
      wiki === WORK_WIKI
        ? Object.entries(WORK).map(([id, w]) => {
            const at = NOW - w.at * HOUR;
            return {
              id,
              provider: "claude",
              title: `session ${id}`,
              first: at - 60_000,
              last: at,
              bulk: false,
              text: { from: "prompt", paths: w.named ? [w.rel] : [], links: [], files: [] },
              files: [{ p: w.rel, edits: w.edits, firstMs: at - 60_000, lastMs: at }],
            };
          })
        : [];
    return JSON.stringify({ form: "sessions", root, sessions, truncated: false });
  }
  const until = url?.searchParams.get("until");
  if (until) {
    const pre = wiki === WORK_WIKI ? [{ p: WORK.touched.rel, w: NOW - 20 * DAY, s: 1 }] : [];
    return JSON.stringify({ root, pages: pre, pageCount: pre.length, bulk: 10, limit: 5000, truncated: false, until: Number(until) });
  }
  const plan =
    wiki === WORK_WIKI
      ? Object.fromEntries(Object.values(WORK).map((w) => [w.rel, w.at / 24]))
      : wiki
        ? WORKED[wiki]!
        : {};
  const pages = Object.entries(plan).map(([p, ago]) => ({ p, w: NOW - ago * DAY, s: 1 }));
  return JSON.stringify({ root, pages, pageCount: pages.length, bulk: 10, limit: 5000, truncated: false });
}

function startLedger(): Promise<Server> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/api/files") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected path", path: url.pathname }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(ledgerAnswer(url.searchParams.get("root") ?? "", url));
  });
  return new Promise((resolve) => srv.listen(LEDGER_PORT, "127.0.0.1", () => resolve(srv)));
}

async function makeRoot(name: string): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-actworked-${name}-`));
  roots[name] = root;
  await writeFile(path.join(root, ".wiki-reader.json"), readerConfig(name), "utf8");
  for (const { rel, updated } of PAGES) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    const title = path.basename(rel, ".md");
    await writeFile(
      abs,
      ["---", `title: ${title[0]!.toUpperCase() + title.slice(1)}`, `created: ${CREATED}`, "---", "", "Body.", ""].join("\n"),
      "utf8",
    );
    const stamp = new Date(NOW - updated * DAY);
    await utimes(abs, stamp, stamp);
  }
}

/** `wswork`'s root: the three session pages, the quiet one, crowded's
 *  attachments (settled, so they rank nowhere), and the same reader config. */
async function makeWorkRoot(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-actworked-work-"));
  roots[WORK_WIKI] = root;
  await writeFile(path.join(root, ".wiki-reader.json"), readerConfig(WORK_WIKI), "utf8");
  const write = async (rel: string, body: string, mtimeAgoMs: number) => {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body, "utf8");
    const stamp = new Date(NOW - mtimeAgoMs);
    await utimes(abs, stamp, stamp);
  };
  const md = (title: string, extra: string[] = []) =>
    ["---", `title: ${title}`, `created: ${CREATED}`, ...extra, "---", "", "Body.", ""].join("\n");
  await write(WORK.crowded.rel, md("Crowded", ["plan_status: in-flight", "followups: open"]), WORK.crowded.mtimeH * HOUR);
  await write(WORK.focused.rel, md("Focused"), WORK.focused.mtimeH * HOUR);
  await write(WORK.touched.rel, md("Touched"), WORK.touched.mtimeH * HOUR);
  await write(
    WORK.worst.rel,
    [
      "---",
      "title: Worst",
      `created: ${day(0)}`,
      "plan_status: in-flight",
      "followups: open",
      "---",
      "",
      "<NextMoves>",
      "",
      '<Lane kind="you" who="Du">',
      "",
      ...Array.from({ length: 12 }, (_, i) => `${i + 1}. **Step ${i + 1}.**`),
      "",
      "</Lane>",
      "",
      "</NextMoves>",
      "",
    ].join("\n"),
    WORK.worst.mtimeH * HOUR,
  );
  await write(QUIET, md("Quiet"), 5 * DAY);
  for (const stem of ["crowded", "worst"]) {
    for (let i = 1; i <= ATTACHED; i++) {
      await write(
        `plans/${stem}-prototype-${i}.html`,
        `<!doctype html><html><head><title>${stem} mock ${i}</title></head><body><p>x</p></body></html>`,
        40 * DAY,
      );
    }
  }
}

const activityRows = (page: Page) => page.locator('.wiki-list-item[data-section="activity"]');

/** What a reader sees of each Activity row, in order: which page, the hover
 *  derivation, its kind (the NEW tag, or none) and the date cell. */
const activitySnapshot = (page: Page) =>
  activityRows(page).evaluateAll((els) =>
    els.map((e) => ({
      rel: e.getAttribute("data-relpath") ?? "",
      why: e.getAttribute("title") ?? "",
      // A NEW row carries the NEW tag; a changed row carries no mark.
      kind: e.querySelector(".wiki-new-tag") ? "new" : "changed",
      meta: e.querySelector(".wiki-list-meta")?.textContent ?? "",
    })),
  );

/** The index is TTL-cached and never waits on the ledger, so rebuild it once
 *  the memo is warm (see `e2e/wiki-worked-recency.spec.ts`). */
async function openReader(page: Page, wiki: string, rows: number = PAGES.length): Promise<void> {
  // `wswork`'s sessions form work threads (PR 5), and the first card defaults
  // OPEN and lifts its pages out of Activity (D13). These cases pin the Activity
  // ranking itself, so that card is stored closed — a closed card lifts nothing.
  if (wiki === WORK_WIKI) {
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key as string, value as string),
      [foldsKey(WORK_WIKI), JSON.stringify([`closed:thread:${WORK.crowded.rel}`])] as const,
    );
  }
  await fetch(`${BASE}/api/wiki/pages?wiki=${wiki}&refresh=1`);
  const listing = page.waitForResponse(
    (r) => r.url().includes("/api/wiki/pages") && r.url().includes(`wiki=${wiki}`) && r.ok(),
  );
  await page.goto(`${BASE}/wiki?wiki=${wiki}`);
  await listing;
  await expect(activityRows(page)).toHaveCount(rows);
}

test.beforeAll(async () => {
  for (const w of [OPEN_WIKI, SHUT_WIKI, NONE_WIKI, LOW_WIKI]) await makeRoot(w);
  await makeWorkRoot();
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
      if ((await fetch(`${BASE}/api/wiki/pages?wiki=${OPEN_WIKI}`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }

  // Up and warm are two instants: the memo refreshes in the background. The
  // open and shut wikis must both carry their `workedMs` before any assertion.
  const warm = Date.now() + 20_000;
  for (;;) {
    const matched = await Promise.all(
      [OPEN_WIKI, SHUT_WIKI, LOW_WIKI].map(async (w) => {
        const body = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${w}&refresh=1`)).json()) as {
          workedCoverage?: { matched: number };
        };
        return body.workedCoverage?.matched ?? 0;
      }),
    );
    if (matched[0] === 5 && matched[1] === 2 && matched[2] === 2) break;
    if (Date.now() > warm) throw new Error("the worked ledger memo never warmed: " + matched.join("/"));
    await new Promise((r) => setTimeout(r, 300));
  }
  // `wswork` also waits for its SECOND memo, the work facts.
  const workWarm = Date.now() + 20_000;
  for (;;) {
    const body = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${WORK_WIKI}&refresh=1`)).json()) as {
      workedCoverage?: { matched: number };
      pages: Array<{ relPath: string; work?: unknown }>;
    };
    if ((body.workedCoverage?.matched ?? 0) === 4 && body.pages.filter((p) => p.work).length === 4) break;
    if (Date.now() > workWarm) throw new Error("the work-sessions memo never warmed for " + WORK_WIKI);
    await new Promise((r) => setTimeout(r, 300));
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise<void>((resolve) => (ledger ? ledger.close(() => resolve()) : resolve()));
  for (const root of Object.values(roots)) await rm(root, { recursive: true, force: true });
});

test.describe("Wiki rail: worked-on substitution in Activity", () => {
  test("acceptance 6a — above the gate, covered pages rank by the day a session wrote them", async ({
    page,
  }) => {
    await openReader(page, OPEN_WIKI);
    const rows = await activitySnapshot(page);
    expect(rows.map((r) => r.rel)).toEqual(OPEN_ORDER);

    // No third kind: every row is still a change.
    expect(rows.map((r) => r.kind)).toEqual(OPEN_ORDER.map(() => "changed"));
    const byRel = Object.fromEntries(rows.map((r) => [r.rel, r]));
    for (const rel of Object.keys(WORKED[OPEN_WIKI]!)) {
      expect(byRel[rel]!.why, rel).toMatch(/^worked on /);
    }
    for (const rel of ["notes/bravo.md", "facet/golf.md", "facet/hotel.md"]) {
      expect(byRel[rel]!.why, rel).toMatch(/^changed /);
    }

    // DEMOTE: alpha's mtime is 12h old, its last session 8 days back, and the
    // hover names the update it set aside.
    expect(byRel["notes/alpha.md"]!.why).toMatch(/^worked on 8d ago, .*; update 12h ago: no session write on record, or a bulk pass$/);
    expect(byRel["notes/alpha.md"]!.meta).toBe("8d");
    // PROMOTE: charlie's mtime is 6 days old, its last session 6 hours back —
    // the date cell and its hover name the worked day, not the mtime.
    expect(byRel["notes/charlie.md"]!.meta).toBe("6h");
    await expect(
      page.locator('.wiki-list-item[data-section="activity"][data-relpath="notes/charlie.md"] .wiki-list-meta'),
    ).toHaveAttribute("title", `${day(0.25)} (worked)`);
  });

  test("acceptance 6b — below the gate, the ranking is the pre-feature one row for row", async ({ page }) => {
    await openReader(page, NONE_WIKI);
    const baseline = await activitySnapshot(page);
    expect(baseline.map((r) => r.rel)).toEqual(CLOSED_ORDER);

    await openReader(page, SHUT_WIKI);
    const payload = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${SHUT_WIKI}`)).json()) as {
      pages: Array<{ relPath: string; workedMs?: number }>;
    };
    // The two covered pages really are on the listing — the gate, not a cold
    // memo, is what keeps them from moving.
    expect(
      payload.pages.filter((p) => typeof p.workedMs === "number").map((p) => p.relPath).sort(),
    ).toEqual(["facet/foxtrot.md", "notes/charlie.md"]);
    expect(await activitySnapshot(page)).toEqual(baseline);
  });

  test("the gate is measured once per payload, not per facet", async ({ page }) => {
    // The `facet` folder alone is 1 covered of 3 (33%), under the gate on its
    // own; the wiki is at 62.5%. Narrowing to it keeps foxtrot substituted.
    await openReader(page, OPEN_WIKI);
    await page.locator("#wikiFilters").evaluate((el) => ((el as HTMLDetailsElement).open = true));
    await page.selectOption("#wikiFolder", "facet");
    await expect(activityRows(page)).toHaveCount(3);
    const rows = await activitySnapshot(page);
    expect(rows.map((r) => r.rel)).toEqual(["facet/foxtrot.md", "facet/golf.md", "facet/hotel.md"]);
    expect(rows[0]!.why).toMatch(/^worked on /);
  });

  test("a wiki's own workedGate opens it", async ({ page }) => {
    await openReader(page, LOW_WIKI);
    const rows = await activitySnapshot(page);
    expect(rows.map((r) => r.rel)).toEqual(LOW_ORDER);
    const byRel = Object.fromEntries(rows.map((r) => [r.rel, r]));
    // Open at 25% only because the wiki asked for 20.
    expect(byRel["notes/charlie.md"]!.why).toMatch(/^worked on 2d ago, /);
    expect(byRel["notes/alpha.md"]!.why).toMatch(/^worked on 8d ago, /);
  });

  test("PR 4 — session work ranks Activity: a passing edit stays below the work; bars on rows with events", async ({ page }) => {
    await openReader(page, WORK_WIKI, WORK_ROWS);
    const rows = await activitySnapshot(page);
    expect(rows.map((r) => r.rel).filter((rel) => rel !== WORK.worst.rel)).toEqual(WORK_ORDER);
    // NEW wins on a page with work, and the row still carries its bar.
    expect(rows.find((r) => r.rel === WORK.worst.rel)!.kind).toBe("new");
    const byRel = Object.fromEntries(rows.map((r) => [r.rel, r]));
    expect(byRel[WORK.focused.rel]!.why).toMatch(/^focused in 1 session \(≈12 edits\), newest focus 3h ago: raw [\d.]+ → work [\d.]+/);
    expect(byRel[WORK.touched.rel]!.why).toMatch(/^touched in 1 session \(≈1 edit\)/);
    // The no-events row keeps today's derivation.
    expect(byRel[QUIET]!.why).toMatch(/^changed 5d ago, /);

    const bar = (rel: string) => page.locator(`.wiki-list-item[data-section="activity"][data-relpath="${rel}"] .wiki-work-bar`);
    expect(await bar(WORK.crowded.rel).getAttribute("data-work-level")).toBe("3");
    expect(await bar(WORK.focused.rel).getAttribute("data-work-level")).toBe("3");
    expect(await bar(WORK.touched.rel).getAttribute("data-work-level")).toBe("1");
    await expect(bar(QUIET)).toHaveCount(0);
    // The touched row's date is its real one, marked.
    await expect(
      page.locator(`.wiki-list-item[data-section="activity"][data-relpath="${WORK.touched.rel}"] .wiki-list-meta`),
    ).toHaveClass(/\btouched\b/);
  });

  test("PR 4 — no sessions in the window: no work bar anywhere (D11)", async ({ page }) => {
    await openReader(page, OPEN_WIKI);
    await expect(page.locator(".wiki-work-bar")).toHaveCount(0);
  });

  test("PR 4 — the work bar and the chips fit the meta line at the 260px rail, nothing clipped", async ({ page }) => {
    for (const width of [260, 300]) {
      await page.addInitScript(([key, w]) => localStorage.setItem(key as string, String(w)), [RAIL_WIDTH_KEY, width] as const);
      await page.setViewportSize({ width: 1400, height: 900 });
      await openReader(page, WORK_WIKI, WORK_ROWS);
      for (const [rel, markCount] of [[WORK.crowded.rel, 4], [WORK.worst.rel, 6]] as const) {
        const g = await page
          .locator(`.wiki-list-item[data-section="activity"][data-relpath="${rel}"]`)
          .evaluate((el) => {
            const rect = (e: Element) => e.getBoundingClientRect();
            const cs = getComputedStyle(el);
            const rowRight = rect(el).right - parseFloat(cs.paddingRight);
            const sub = el.querySelector(".wiki-list-sub") as HTMLElement;
            const bar = sub.querySelector(".wiki-work-bar") as HTMLElement;
            const label = Array.from(sub.querySelectorAll(".wiki-fold-chip-label, .wiki-fold-chip-counts")).find(
              (e) => getComputedStyle(e).display !== "none",
            ) as HTMLElement;
            const marks = Array.from(
              sub.querySelectorAll(".wiki-status, .wiki-followup-flag, .wiki-moves-flag, .wiki-new-tag, .wiki-work-bar, .wiki-fold-chip"),
            );
            const steps = Array.from(bar.querySelectorAll("i")).map((i) => rect(i).width);
            // Centres, not tops (the marks differ in height): `.wiki-list-sub`
            // wraps, so an overfull line moves a mark down a whole line (~19px)
            // while every width check below still passes.
            const mids = marks.map((m) => rect(m).top + rect(m).height / 2);
            return {
              rail: Math.round(rect(document.querySelector(".wiki-layout > .wiki-pane:first-child")!).width),
              marks: marks.length,
              spread: Math.max(...mids) - Math.min(...mids),
              widths: marks.map((m) => Math.round(rect(m).width)),
              // The bar sits in the icon gutter, clear of the mark after it.
              barOverlap: rect(bar).right - rect(bar.nextElementSibling ?? bar).left,
              // The bar stays inside the 22px icon gutter, and the mark after it
              // starts where the title does.
              barPastGutter: rect(bar).right - (rect(sub).left + 22),
              nextVsTitle: rect(bar.nextElementSibling!).left - rect(el.querySelector(".wiki-list-title")!).left,
              subWidth: Math.round(sub.clientWidth),
              pastRow: marks.filter((m) => rect(m).right > rowRight + 0.5).length,
              subOverflow: sub.scrollWidth - sub.clientWidth,
              barInSub: rect(bar).left >= rect(sub).left - 0.5 && rect(bar).right <= rect(sub).right + 0.5,
              steps,
              labelClipped: label.scrollWidth - label.clientWidth > 1,
              label: label.textContent,
            };
          });
        const at = `${rel} at ${width}: ${JSON.stringify(g)}`;
        expect(g.rail, at).toBe(width);
        expect(g.marks, at).toBe(markCount);
        expect(g.spread, `one meta line, ${at}`).toBeLessThan(6);
        expect(g.pastRow, at).toBe(0);
        expect(g.subOverflow, at).toBeLessThanOrEqual(0);
        expect(g.barInSub, at).toBe(true);
        expect(g.barOverlap, at).toBeLessThanOrEqual(0);
        expect(g.barPastGutter, at).toBeLessThanOrEqual(1);
        expect(Math.abs(g.nextVsTitle), at).toBeLessThanOrEqual(1);
        expect(g.steps.length, at).toBe(4);
        expect(g.steps.every((w) => w >= 2.5), at).toBe(true);
        expect(g.labelClipped, at).toBe(false);
        expect(g.label, at).toContain(String(ATTACHED));
      }
    }
  });
});
