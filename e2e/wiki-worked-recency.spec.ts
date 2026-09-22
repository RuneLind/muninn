/**
 * /wiki reader — the WORKED-ON axis, end to end.
 *
 * The rail's two date axes both collapse when a mechanical edit sweeps a wiki:
 * mtime carries no order at all after one, and a git touch date is flattened by
 * ordinary small commits. claude-usage's `session_files` ledger knows which
 * agent session wrote which page, and this axis spends it — as a sort mode, as
 * the row's date chip, and as the order of a series fold and of the Series
 * section itself.
 *
 * Five things only a real browser against a real server can answer, and three of
 * them are degrades:
 *
 *  1. **Twelve pages that all read as one age under "Recently updated" spread
 *     09-21 → 07-02 under "Worked on"** — the measured table this plan was
 *     written from, as a fixture. A thirteenth page is absent from the ledger's
 *     answer (its every write was part of a bulk pass, discounted upstream) and
 *     must sort on its FALLBACK rather than on the pass's date.
 *  2. **The row's date chip names the worked day in that mode**, and an
 *     UNCOVERED page says which signal answered instead — the axis is sparse by
 *     construction, so a bare date would claim a worked date the page never got.
 *  3. **Three ledger degrades, in ONE boot**: a 500, an over-cap body, and a 200
 *     carrying the RAW row form an un-upgraded claude-usage answers. Each wiki
 *     still renders, each still sorts on the fallback, and each logs its OWN
 *     warn naming the base URL — read out of the server's stderr, because the
 *     "nothing warned and the axis is just empty" failure is exactly what the
 *     `pages`-key strictness exists to prevent.
 *  4. **The Series section orders by each group's newest member's worked day**
 *     in the recency modes and alphabetically in `title` mode — the 15-way tie
 *     that made the live section look unsorted.
 *  5. **The "Worked on" option is HIDDEN on a wiki the ledger matched nothing
 *     for.** Offering it there is offering "Recently updated" under a second
 *     name (capra: 93% of pages have a write row, every one a bulk pass).
 *
 * No model calls and no writes: the whole feature is a read.
 *
 * ENV PREREQUISITE: a working `.env` (`DATABASE_URL` at minimum) at the repo
 * root — `src/index.ts` boots the full process and Bun auto-loads it in the
 * spawned child (cwd = repo root).
 *
 * SPAWN ENV: `e2eEnv()` keeps this muninn off Telegram/Slack and blanks the
 * instance-profile flags. `CLAUDE_USAGE_URL` is in that blank set, so it is set
 * AFTER it — a spec's own overrides go last, by contract.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { SETTLED_CREATED_LINE, settleWikiMtimes } from "./settled-wiki.ts";

const PORT = e2ePort("wiki-worked-recency");
const LEDGER_PORT = e2ePort("wiki-worked-recency/ledger");
const BASE = `http://127.0.0.1:${PORT}`;
const LEDGER_BASE = `http://127.0.0.1:${LEDGER_PORT}`;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** The six wikis, by registry name. Each gets its own root AND its own answer
 *  from the fake ledger — which is what puts every degrade in one boot. */
const MAIN = "wrmain";
const SERIES = "wrseries";
const BULK = "wrbulk";
const FAIL = "wrfail";
const BIG = "wrbig";
const RAW = "wrraw";

const roots: Record<string, string> = {};
let server: ChildProcess | undefined;
let ledger: Server | undefined;
/** Everything the spawned muninn wrote to stdout+stderr — the only place the
 *  degrade warns can be read from. */
let serverLog = "";

/**
 * The measured table this plan was written from, shrunk to the two columns that
 * matter: every page carries the SAME `updated:` (so "Recently updated" is one
 * flat tie, which is the symptom) and a worked day of its own.
 */
const WORKED_DAYS = [
  "2026-09-21",
  "2026-09-17",
  "2026-09-15",
  "2026-09-14",
  "2026-09-13",
  "2026-09-11",
  "2026-09-09",
  "2026-09-08",
  "2026-09-07",
  "2026-09-04",
  "2026-09-01",
  "2026-07-02",
] as const;

/** `plans/p01.md` … `plans/p12.md`, newest worked day first. */
const workedRel = (i: number) => `plans/p${String(i + 1).padStart(2, "0")}.md`;
/** The thirteenth page: written only by bulk passes, so the ledger's discount
 *  leaves it out of the answer entirely. */
const BULK_REL = "plans/swept.md";
/**
 * The one `updated:` every fixture page shares — the flat tie that IS the
 * symptom.
 *
 * Old, and that is the second half of settling this wiki: `rankActivity` scores
 * a CHANGE by its age, so a shared `updated:` of yesterday put every page in the
 * Activity section, where a row's date comes from the RANKING rather than from
 * the sort. A date two years back is under `ACTIVITY_MIN_SCORE` whenever this
 * runs, so the rail is a plain listing and the chip answers about the sort.
 */
const SHARED_UPDATED = "2024-03-01";

/** Noon UTC on a day, which is the instant the fake reports as a write. The
 *  browser's zone is pinned to UTC below, so the rendered day is that day. */
const dayMs = (day: string) => Date.parse(`${day}T12:00:00Z`);

/**
 * One fixture page. Two things beyond the title are load-bearing:
 *
 *  - the SHARED `updated:`, which is the symptom — under "Recently updated"
 *    every page in this wiki reads as the same age, exactly as twelve pages a
 *    series join had just swept did;
 *  - the SETTLED `created:` + the backdated mtimes below, without which every
 *    page is brand new and the rail's Activity section claims six of them. An
 *    Activity row takes its date from the ranking rather than from the sort, so
 *    it would answer this spec's chip assertions with the wrong signal
 *    (`e2e/settled-wiki.ts`).
 */
function fixture(title: string, extra: string[] = []): string {
  return [
    "---",
    `title: ${title}`,
    SETTLED_CREATED_LINE,
    `updated: ${SHARED_UPDATED}`,
    ...extra,
    "---",
    "",
    "Body.",
    "",
  ].join("\n");
}

/** The `?summary=1` body for one wiki, or the degrade it answers instead. */
function ledgerAnswer(root: string): { status: number; body: string } | "oversized" {
  const rows = (pairs: Array<[string, number]>) =>
    JSON.stringify({
      root,
      pages: pairs.map(([p, w]) => ({ p, w, s: 1 })),
      pageCount: pairs.length,
      bulk: 10,
      limit: 5000,
      truncated: false,
    });
  if (root === roots[MAIN]) {
    return {
      status: 200,
      // `swept.md` is deliberately ABSENT — upstream discounts a session that
      // wrote ten or more pages under the root, so a page whose every write came
      // from one has no row at all.
      body: rows(WORKED_DAYS.map((d, i) => [workedRel(i), dayMs(d)] as [string, number])),
    };
  }
  if (root === roots[SERIES]) {
    return {
      status: 200,
      body: rows([
        // Three series sharing ONE updated date and differing only in when they
        // were worked on — the tie, shrunk.
        ["plans/zulu-a.md", dayMs("2026-09-20")],
        ["plans/zulu-b.md", dayMs("2026-08-01")],
        ["plans/alpha-a.md", dayMs("2026-07-02")],
        ["plans/alpha-b.md", dayMs("2026-06-30")],
        ["plans/mike-a.md", dayMs("2026-09-21")],
        ["plans/mike-b.md", dayMs("2026-05-01")],
      ]),
    };
  }
  if (root === roots[BULK]) {
    // A well-formed answer that matches NOTHING on disk — every row is for a
    // page the corpus does not have. `matched: 0`, which is the verdict that
    // hides the option.
    return { status: 200, body: rows([["ghost/one.md", dayMs("2026-09-01")]]) };
  }
  if (root === roots[FAIL]) return { status: 500, body: JSON.stringify({ error: "ledger down" }) };
  if (root === roots[BIG]) return "oversized";
  if (root === roots[RAW]) {
    // What an UN-UPGRADED claude-usage answers: it ignores `summary=1` and
    // serves the raw row form, 200, well inside every bound. Nothing times out
    // and nothing overflows — only the missing `pages` key says anything.
    return {
      status: 200,
      body: JSON.stringify({
        root,
        sessions: [{ path: `${root}/plans/a.md`, sessionId: "s1", op: "write" }],
        total: 1,
        rows: 1,
        limit: 2000,
        offset: 0,
      }),
    };
  }
  return { status: 200, body: rows([]) };
}

/** The fake claude-usage. It answers `/api/files` and 404s everything else, so a
 *  leg this spec did not mean to drive fails loudly. */
function startLedger(): Promise<Server> {
  // Comfortably over muninn's 8 MiB `BOUNDED_FETCH_MAX_BYTES`, built once.
  const oversized = JSON.stringify({ pages: [], filler: "x".repeat(9 * 1024 * 1024) });
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/api/files") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected path", path: url.pathname }));
      return;
    }
    const answer = ledgerAnswer(url.searchParams.get("root") ?? "");
    if (answer === "oversized") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(oversized);
      return;
    }
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(answer.body);
  });
  return new Promise((resolve) => srv.listen(LEDGER_PORT, "127.0.0.1", () => resolve(srv)));
}

/** A fresh temp wiki root, registered under `name`. */
async function makeRoot(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-worked-${name}-`));
  await mkdir(path.join(root, "plans"), { recursive: true });
  roots[name] = root;
  return root;
}

/**
 * Open the reader on one wiki and wait for its listing to land.
 *
 * The `?refresh=1` ahead of the navigation is load-bearing and is the axis's own
 * design showing through: the index NEVER waits on the ledger, and it is itself
 * TTL-cached at five minutes — so the build this server did at boot, racing the
 * memo, is the one a plain fetch keeps serving for the whole spec. Forcing one
 * rebuild per open is what puts the warm memo into the listing the browser then
 * reads.
 */
async function openReader(page: Page, wiki: string): Promise<void> {
  await fetch(`${BASE}/api/wiki/pages?wiki=${wiki}&refresh=1`);
  const listing = page.waitForResponse(
    (r) => r.url().includes("/api/wiki/pages") && r.url().includes(`wiki=${wiki}`) && r.ok(),
  );
  await page.goto(`${BASE}/wiki?wiki=${wiki}`);
  await listing;
}

/** The rail's row relPaths, IN RENDERED ORDER (never sorted — the order is the
 *  assertion). */
const railOrder = (page: Page) =>
  page
    .locator(".wiki-list-item")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-relpath")));

/** Switch the sort select and wait for the repaint. */
async function sortBy(page: Page, mode: string): Promise<void> {
  await page.selectOption("#wikiSort", mode);
  await expect(page.locator("#wikiSort")).toHaveValue(mode);
}

test.beforeAll(async () => {
  // Roots first: the fake reads `roots` to decide what to answer.
  const main = await makeRoot(MAIN);
  for (let i = 0; i < WORKED_DAYS.length; i++) {
    // The title is zero-padded because the rail's recency tie-break is
    // `displayTitleOf`, not the relPath: a bare `P10` sorts between `P1` and
    // `P2` and the flat-tie assertion below would be about nothing.
    await writeFile(
      path.join(main, workedRel(i)),
      fixture(`P${String(i + 1).padStart(2, "0")}`),
      "utf8",
    );
  }
  await writeFile(path.join(main, BULK_REL), fixture("Swept"), "utf8");

  const series = await makeRoot(SERIES);
  for (const [rel, key, label] of [
    ["plans/zulu-a.md", "zulu", "Zulu"],
    ["plans/zulu-b.md", "zulu", undefined],
    ["plans/alpha-a.md", "alpha", "Alpha"],
    ["plans/alpha-b.md", "alpha", undefined],
    ["plans/mike-a.md", "mike", "Mike"],
    ["plans/mike-b.md", "mike", undefined],
  ] as Array<[string, string, string | undefined]>) {
    await writeFile(
      path.join(series, rel),
      fixture(rel, [`series: ${key}`, ...(label ? [`series_label: ${label}`] : [])]),
      "utf8",
    );
  }

  for (const name of [BULK, FAIL, BIG, RAW]) {
    const root = await makeRoot(name);
    await writeFile(path.join(root, "plans/a.md"), fixture("A"), "utf8");
    await writeFile(path.join(root, "plans/b.md"), fixture("B"), "utf8");
  }

  for (const root of Object.values(roots)) await settleWikiMtimes(root);

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
      // AFTER `e2eEnv()`, which blanks it: this is the whole point of the spec.
      CLAUDE_USAGE_URL: LEDGER_BASE,
    },
    // PIPED, unlike the other wiki specs: acceptance 4 is about what the server
    // SAYS when the ledger degrades, and there is no other channel for it.
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (b: Buffer) => (serverLog += b.toString()));
  server.stderr?.on("data", (b: Buffer) => (serverLog += b.toString()));

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/wiki/pages?wiki=${MAIN}`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }

  // …and then wait for the boot kick's answer to reach a REBUILT index. The
  // memo is refreshed in the background and never awaited, so "the server is
  // up" and "the axis is warm" are two different instants.
  const warm = Date.now() + 20_000;
  for (;;) {
    const body = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${MAIN}&refresh=1`)).json()) as {
      workedCoverage?: { matched: number };
    };
    if ((body.workedCoverage?.matched ?? 0) > 0) break;
    if (Date.now() > warm) throw new Error("the worked ledger memo never warmed");
    await new Promise((r) => setTimeout(r, 300));
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise<void>((resolve) => (ledger ? ledger.close(() => resolve()) : resolve()));
  for (const root of Object.values(roots)) await rm(root, { recursive: true, force: true });
});

// Every rendered day below is otherwise a fact about the machine: the chip
// renders the LOCAL day of a wall-clock instant.
test.use({ timezoneId: "UTC" });

test.describe("Wiki reader: worked-on recency", () => {
  test("acceptance 2 — twelve pages spread 09-21 → 07-02, and a swept page falls back", async ({
    page,
  }) => {
    await openReader(page, MAIN);
    await expect(page.locator(".wiki-list-item")).toHaveCount(WORKED_DAYS.length + 1);

    // The SYMPTOM first: under "Recently updated" all thirteen pages carry the
    // same authored date, so the list is ONE flat tie broken by title — which is
    // what twelve rows of `3h` looked like on the wiki this was measured on.
    const updatedOrder = await railOrder(page);
    expect(updatedOrder).toEqual([...updatedOrder].sort());

    await sortBy(page, "worked");
    // 09-21 … 07-02 in the ledger's own order, then the SWEPT page on its
    // fallback (the shared `updated:`) — not on the bulk pass's date, and not
    // sorted as undated.
    expect(await railOrder(page)).toEqual([
      ...WORKED_DAYS.map((_, i) => workedRel(i)),
      BULK_REL,
    ]);
  });

  test("acceptance 3 — the chip names the worked day, and says so", async ({ page }) => {
    await openReader(page, MAIN);
    await sortBy(page, "worked");
    const metaOf = (rel: string) =>
      page.locator(`.wiki-list-item[data-relpath="${rel}"] .wiki-list-meta`);

    // A covered page: the hover names the worked DAY and the signal that
    // answered. The CELL is `formatRailAge`'s compact age, which is pinned
    // elsewhere and is a fact about the day this runs; the hover is the claim.
    const oldest = workedRel(WORKED_DAYS.length - 1);
    await expect(metaOf(oldest)).toHaveAttribute("title", "2026-07-02 (worked)");

    // The UNCOVERED page says which signal answered instead — a bare day here
    // would be a worked date this page never earned.
    await expect(metaOf(BULK_REL)).toHaveAttribute("title", `${SHARED_UPDATED} (updated)`);
    await expect(metaOf(BULK_REL)).not.toHaveAttribute("title", /\(worked\)$/);

    // …and no other mode grows the suffix.
    await sortBy(page, "updated");
    await expect(metaOf(oldest)).toHaveAttribute("title", SHARED_UPDATED);
  });

  test("acceptance 5 — the option is offered where the axis has anything to say", async ({
    page,
  }) => {
    await openReader(page, MAIN);
    await expect(page.locator('#wikiSort option[value="worked"]')).not.toHaveAttribute("hidden", "");
    await expect(page.locator('#wikiSort option[value="worked"]')).toHaveText("Worked on");
  });

  test("acceptance 5 — …and HIDDEN on a wiki the ledger matched nothing for", async ({ page }) => {
    await openReader(page, BULK);
    // A well-formed answer that matched no page on disk: every row would fall
    // back, so the mode is "Recently updated" relabelled.
    const payload = await (await fetch(`${BASE}/api/wiki/pages?wiki=${BULK}`)).json();
    expect(payload.workedCoverage).toMatchObject({ matched: 0 });
    await expect(page.locator('#wikiSort option[value="worked"]')).toHaveAttribute("hidden", "");
    // The listing itself is untouched.
    await expect(page.locator(".wiki-list-item")).toHaveCount(2);
  });

  test("acceptance 8 — the Series section orders by each group's worked day", async ({ page }) => {
    await openReader(page, SERIES);
    const labels = () =>
      page
        .locator(".wiki-list-group")
        .evaluateAll((els) =>
          els.map((e) => e.querySelector(".wiki-group-name")?.textContent?.trim() ?? ""),
        );

    await sortBy(page, "worked");
    // Mike was worked on 09-21, Zulu 09-20, Alpha 07-02 — while all six pages
    // share one `updated:`, which is the tie this replaces.
    expect(await labels()).toEqual(["Mike", "Zulu", "Alpha"]);

    await sortBy(page, "title");
    expect(await labels()).toEqual(["Alpha", "Mike", "Zulu"]);
  });

  test("the reader strip prints the WORKED day, oldest first", async ({ page }) => {
    // The one surface no other case here opens. The strip is the fold's order
    // REVERSED and prints the same signal the fold's own rows show, so its date
    // column must ASCEND — de-reversing it, or printing a second chain, left 370
    // unit tests green and is only visible in a rendered page.
    await openReader(page, SERIES);
    await page.goto(`${BASE}/wiki?wiki=${SERIES}&relPath=plans%2Fmike-a.md`);
    const dates = page.locator(".wiki-series-head .wiki-series-tl .wiki-series-step-date");
    await expect(dates).toHaveCount(2);
    // mike-b was worked on 2026-05-01 and mike-a on 09-21 — oldest first, and
    // neither is the shared `updated:` every fixture page carries.
    expect(await dates.allTextContents()).toEqual(["2026-05-01", "2026-09-21"]);
  });

  test("acceptance 4 — three ledger degrades: the listing renders and each warns", async ({
    page,
  }) => {
    // The warns are emitted by the boot kick, one per wiki, and they land in any
    // order. Poll until ALL THREE are present rather than until one of them is:
    // the over-cap warn fires on `content-length` before a body byte is read, so
    // it is usually FIRST, and waiting on it alone let the other two race the
    // assertions below.
    const wanted = [/worked ledger degraded:.*HTTP 500/, /byte cap/, /summary form/];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !wanted.every((re) => re.test(serverLog))) {
      await new Promise((r) => setTimeout(r, 300));
    }

    // Each case names the BASE URL: the operator's first question about a dead
    // axis is which service this instance was pointed at.
    expect(serverLog).toContain(LEDGER_BASE);
    // 1. a non-200.
    expect(serverLog).toMatch(/worked ledger degraded:.*HTTP 500/);
    // 2. an over-cap body — the bound is bytes, not time, so nothing hangs.
    expect(serverLog).toMatch(/worked ledger degraded:.*byte cap/);
    // 3. the un-upgraded upstream: a 200 with no `pages` key. THE case the
    //    strictness exists for — it is inside every bound, so without it the
    //    answer reads as a wiki nobody has ever written.
    expect(serverLog).toMatch(/worked ledger degraded:.*summary form/);

    for (const wiki of [FAIL, BIG, RAW]) {
      const payload = await (await fetch(`${BASE}/api/wiki/pages?wiki=${wiki}`)).json();
      // No memo landed, so there is NO coverage field at all — which is a
      // different answer from `matched: 0` and leaves the option hidden.
      expect(payload.workedCoverage).toBeUndefined();
      expect(payload.pages).toHaveLength(2);
      expect(payload.pages.every((p: { workedMs?: number }) => p.workedMs === undefined)).toBe(true);

      await openReader(page, wiki);
      await expect(page.locator(".wiki-list-item")).toHaveCount(2);
      await expect(page.locator('#wikiSort option[value="worked"]')).toHaveAttribute("hidden", "");
      // The mode itself still sorts, on the per-page fallback — driven through
      // the hidden option, since that is the state a stored sort would leave.
      await sortBy(page, "worked");
      const order = await railOrder(page);
      expect(order).toEqual(["plans/a.md", "plans/b.md"]);
    }
  });
});
