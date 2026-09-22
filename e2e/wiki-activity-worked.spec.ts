/**
 * /wiki rail — the WORKED term inside the **Activity** ranking, and the coverage
 * gate in front of it.
 *
 * The plan's acceptance 6: *on a wiki above the coverage gate the Activity rows
 * change to pages a session wrote; on one below it, ranking is byte-identical to
 * today.* Both halves need a browser, because the gate is measured over the
 * ranked candidate set of the FULL payload and then spent inside a render — a
 * unit test can hand the ranker a gate, but only a real boot proves the chain
 * `/api/files` → the store's memo → `workedMs` on the listing → `setPagesData`'s
 * one measurement → `renderList`.
 *
 * ONE muninn, TWO temp wikis, ONE fake `node:http` claude-usage. The two wikis
 * hold the SAME six pages with the SAME frontmatter — every page carries one
 * shared `updated:`, so with the term off the section is a flat tie broken by
 * title, which is the symptom the axis exists for. The only difference between
 * them is WHICH pages the ledger answers for:
 *
 *  - `wkopen` — five of six candidates covered (83%), so the gate opens and the
 *    four whose worked day beats the shared `updated:` take over the section.
 *  - `wkshut` — two of six (33%), so the gate stays shut. Its two covered pages
 *    are `echo` and `foxtrot`, LAST in the alphabet on purpose: a leaking gate
 *    would put them first, where the flat title tie puts them last.
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
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-activity-worked");
const LEDGER_PORT = e2ePort("wiki-activity-worked/ledger");
const BASE = `http://127.0.0.1:${PORT}`;
const LEDGER_BASE = `http://127.0.0.1:${LEDGER_PORT}`;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const OPEN_WIKI = "wkopen";
const SHUT_WIKI = "wkshut";

const DAY = 86_400_000;
/** One instant for the whole fixture, so every date below is an exact offset
 *  from it rather than from six different clock reads. */
const NOW = Date.now();

/** The six pages, in title order — which is also the order a flat tie renders
 *  in, and so the `wkshut` expectation. */
const NAMES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"] as const;
const rel = (n: string) => `notes/${n}.md`;
const title = (n: string) => n[0]!.toUpperCase() + n.slice(1);

/**
 * How many days ago each page was WORKED ON, per wiki. `undefined` = the ledger
 * holds no qualifying write, which is the state the term must ABSTAIN on rather
 * than fall back to the update signal for.
 *
 * `delta`'s 20 days is the other half of that: a worked date OLDER than the
 * change keeps the row exactly as it was, since the term takes a row only on a
 * strict `>`.
 */
const WORKED_DAYS_AGO: Record<string, Record<string, number | undefined>> = {
  // 5 of 6 ⇒ 83% ⇒ open.
  [OPEN_WIKI]: { alpha: 0.5, bravo: 1.5, charlie: 3, delta: 20, echo: 4, foxtrot: undefined },
  // 2 of 6 ⇒ 33% ⇒ shut. The two covered are the LAST two alphabetically.
  [SHUT_WIKI]: {
    alpha: undefined,
    bravo: undefined,
    charlie: undefined,
    delta: undefined,
    echo: 0.5,
    foxtrot: 1.5,
  },
};

/**
 * The order `wkopen` renders once the gate opens: the four pages whose worked
 * day beats the shared `updated:`, newest first, then the two the term has
 * nothing to say about, still tied on the change term and still broken by title.
 *
 * `echo` overtaking `delta` is the assertion that matters — it is the only pair
 * whose relative order the ALPHABET and the LEDGER disagree about.
 */
const OPEN_ORDER = ["alpha", "bravo", "charlie", "echo", "delta", "foxtrot"].map(rel);
const OPEN_KINDS = ["worked", "worked", "worked", "worked", "changed", "changed"];

/** The order both wikis render with the term off: the flat title tie. */
const TIE_ORDER = NAMES.map(rel);

/**
 * The fixture's two frontmatter dates, as bare local days.
 *
 * `updated:` is the SHARED one — six pages that all read as the same age, which
 * is what a series-join sweep leaves behind and what this axis exists to
 * separate. Six days back rather than today so the change term sits well clear
 * of `ACTIVITY_MIN_SCORE` while leaving room above it for four worked days to
 * spread out.
 *
 * `created:` is far enough back that `newScore` (half-life 5 d) is four orders
 * of magnitude under the floor — the creation signal must not place any of these
 * rows, or the section would be about a different term.
 */
const day = (ago: number) => {
  const d = new Date(NOW - ago * DAY);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const SHARED_UPDATED = day(6);
const SHARED_CREATED = day(40);

/**
 * The weights both wikis declare.
 *
 * `agePenalty`/`hubPenalty`/`planBoost` are all switched OFF on purpose, and it
 * is not tuning: a temp fixture's BIRTHTIME is not portable — Linux keeps it
 * through `utimes` while macOS can pull it back to the mtime — so `pageAddedMs`
 * is either 40 or 50 days old depending on the runner, and the age discount
 * would therefore scale every score by a factor the runner chooses. It is the
 * same factor for all six pages, so it could never change the ORDER; it could
 * and did move the whole section across `ACTIVITY_MIN_SCORE`. Off, the fixture
 * asserts the one thing it is about.
 *
 * `rows` is 8 so the section is never the thing doing the cutting.
 */
const READER_CONFIG = JSON.stringify({
  activity: { agePenalty: 0, hubPenalty: 0, planBoost: 0, rows: 8 },
});

const roots: Record<string, string> = {};
let server: ChildProcess | undefined;
let ledger: Server | undefined;

/** The `?summary=1` answer for one wiki root, in the shape
 *  `src/wiki/worked-ledger.ts` requires (a `pages` key, or it is a degrade). */
function ledgerAnswer(root: string): string {
  const wiki = Object.keys(roots).find((k) => roots[k] === root);
  const plan = wiki ? WORKED_DAYS_AGO[wiki] : undefined;
  const pages = plan
    ? NAMES.filter((n) => plan[n] !== undefined).map((n) => ({
        p: rel(n),
        w: NOW - plan[n]! * DAY,
        s: 1,
      }))
    : [];
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
    res.end(ledgerAnswer(url.searchParams.get("root") ?? ""));
  });
  return new Promise((resolve) => srv.listen(LEDGER_PORT, "127.0.0.1", () => resolve(srv)));
}

/** One wiki root: the six pages, the declared weights, and mtimes backdated
 *  behind the shared `updated:` so the freshly-written file does not become its
 *  own update signal (these roots are not git repos, so mtime is trusted
 *  unconditionally — `settleWikiMtimes`' reason, with this fixture's dates). */
async function makeRoot(name: string): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-actworked-${name}-`));
  roots[name] = root;
  await writeFile(path.join(root, ".wiki-reader.json"), READER_CONFIG, "utf8");
  const stamp = new Date(NOW - 50 * DAY);
  await mkdir(path.join(root, "notes"), { recursive: true });
  for (const n of NAMES) {
    const abs = path.join(root, rel(n));
    await writeFile(
      abs,
      ["---", `title: ${title(n)}`, `created: ${SHARED_CREATED}`, `updated: ${SHARED_UPDATED}`, "---", "", "Body.", ""].join("\n"),
      "utf8",
    );
    await utimes(abs, stamp, stamp);
  }
}

/** Open the reader on one wiki and wait for its listing.
 *
 *  The `?refresh=1` ahead of the navigation is the axis's own design showing
 *  through: the index never waits on the ledger and is itself TTL-cached at five
 *  minutes, so the build this server did at boot — racing the memo — is what a
 *  plain fetch keeps serving. (`e2e/wiki-worked-recency.spec.ts` says the same.) */
async function openReader(page: Page, wiki: string): Promise<void> {
  await fetch(`${BASE}/api/wiki/pages?wiki=${wiki}&refresh=1`);
  const listing = page.waitForResponse(
    (r) => r.url().includes("/api/wiki/pages") && r.url().includes(`wiki=${wiki}`) && r.ok(),
  );
  await page.goto(`${BASE}/wiki?wiki=${wiki}`);
  await listing;
  await expect(page.locator('.wiki-list-item[data-section="activity"]')).toHaveCount(NAMES.length);
}

const activityRows = (page: Page) => page.locator('.wiki-list-item[data-section="activity"]');

const activityOrder = (page: Page): Promise<string[]> =>
  activityRows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-relpath") ?? ""));

/** The glyph class on each Activity row, in rendered order — the kind, read off
 *  the DOM rather than off the ranking. */
const activityKinds = (page: Page): Promise<string[]> =>
  activityRows(page).evaluateAll((els) =>
    els.map((e) => (e.querySelector(".wiki-act-glyph")?.className ?? "").replace("wiki-act-glyph ", "")),
  );

test.beforeAll(async () => {
  await makeRoot(OPEN_WIKI);
  await makeRoot(SHUT_WIKI);
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
      // AFTER `e2eEnv()`, which blanks it.
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

  // "The server is up" and "the axis is warm" are two different instants: the
  // memo is refreshed in the background and never awaited. Wait for BOTH wikis,
  // since the shut one's two rows are what would make a leak visible.
  const warm = Date.now() + 20_000;
  for (;;) {
    const matched = await Promise.all(
      [OPEN_WIKI, SHUT_WIKI].map(async (w) => {
        const body = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${w}&refresh=1`)).json()) as {
          workedCoverage?: { matched: number };
        };
        return body.workedCoverage?.matched ?? 0;
      }),
    );
    if (matched.every((m) => m > 0)) break;
    if (Date.now() > warm) throw new Error("the worked ledger memo never warmed: " + matched.join("/"));
    await new Promise((r) => setTimeout(r, 300));
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise<void>((resolve) => (ledger ? ledger.close(() => resolve()) : resolve()));
  for (const root of Object.values(roots)) await rm(root, { recursive: true, force: true });
});

test.describe("Wiki rail: the worked term in Activity", () => {
  test("acceptance 6a — above the gate, the rows become the pages a session wrote", async ({
    page,
  }) => {
    await openReader(page, OPEN_WIKI);

    // The SYMPTOM, first and from the payload: every page carries one `updated:`,
    // so the change term scores all six identically and the section is a flat
    // tie broken by title. That is the state the ledger is being spent on.
    const payload = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${OPEN_WIKI}`)).json()) as {
      pages: Array<{ relPath: string; updated?: string; workedMs?: number }>;
    };
    expect(new Set(payload.pages.map((p) => p.updated))).toEqual(new Set([SHARED_UPDATED]));
    expect(payload.pages.filter((p) => typeof p.workedMs === "number")).toHaveLength(5);

    // …and the rendered section is NOT that tie.
    expect(await activityOrder(page)).toEqual(OPEN_ORDER);
    expect(await activityOrder(page)).not.toEqual(TIE_ORDER);
    expect(await activityKinds(page)).toEqual(OPEN_KINDS);

    // `echo` over `delta` is the pair the alphabet and the ledger disagree
    // about, and `delta` staying `changed` is the strict-`>` rule: its worked
    // day is 20 days back, OLDER than the change it would have replaced.
    expect(OPEN_ORDER.indexOf(rel("echo"))).toBeLessThan(OPEN_ORDER.indexOf(rel("delta")));
    // `foxtrot` is the page the ledger holds nothing for. It keeps its change
    // row rather than scoring a second copy of it — the fallback trap.
    const foxtrot = page.locator(`.wiki-list-item[data-relpath="${rel("foxtrot")}"]`);
    await expect(foxtrot).toHaveAttribute("title", /^changed /);
  });

  test("acceptance 6b — below the gate, the ranking is what it was", async ({ page }) => {
    await openReader(page, SHUT_WIKI);

    // Two of six covered, and the two are the LAST alphabetically — so a gate
    // that leaked would be loud here, not invisible.
    const payload = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${SHUT_WIKI}`)).json()) as {
      pages: Array<{ relPath: string; workedMs?: number }>;
    };
    expect(
      payload.pages.filter((p) => typeof p.workedMs === "number").map((p) => p.relPath).sort(),
    ).toEqual([rel("echo"), rel("foxtrot")]);

    expect(await activityOrder(page)).toEqual(TIE_ORDER);
    // Not one row relabels, and no row carries the worked glyph.
    expect(await activityKinds(page)).toEqual(NAMES.map(() => "changed"));
    await expect(page.locator(".wiki-act-glyph.worked")).toHaveCount(0);
    for (const row of await activityRows(page).all()) {
      await expect(row).toHaveAttribute("title", /^changed /);
    }
  });

  test("the worked row says so — glyph, derivation and date, in both themes", async ({ page }) => {
    await openReader(page, OPEN_WIKI);
    const alpha = page.locator(`.wiki-list-item[data-relpath="${rel("alpha")}"]`);

    await expect(alpha.locator(".wiki-act-glyph.worked")).toHaveText("✎");
    // Distinct from the two marks already in this column — a third glyph that
    // read like `+` or `~` would be a relabel nobody can see.
    expect(await alpha.locator(".wiki-act-glyph").textContent()).not.toBe("+");
    expect(await alpha.locator(".wiki-act-glyph").textContent()).not.toBe("~");

    // The derivation multiplies out beside the score, exactly as the change
    // branch's does, and the date cell is the WORKED stamp's age (12h), not the
    // shared `updated:`'s six days.
    await expect(alpha).toHaveAttribute("title", /^worked 12h ago, created .*: weight ×0\.70, recency /);
    await expect(alpha.locator(".wiki-list-meta")).toHaveText("12h");

    // The colour is the token it is declared with, read off a probe in this
    // document — a literal would pass against any theme — and it is measured in
    // BOTH, because `--tok-num` is the third mark on a column whose other two
    // each needed a contrast swap to clear AA at 11px.
    const token = (name: string) =>
      page.evaluate((n) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${n})`;
        document.body.appendChild(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      }, name);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(alpha.locator(".wiki-act-glyph.worked")).toHaveCSS("color", await token("--tok-num"));
      // …and it is not one of the other two marks' colours, in either theme.
      expect(await token("--tok-num")).not.toBe(await token("--tok-str"));
      expect(await token("--tok-num")).not.toBe(await token("--accent-light"));
    }
    await page.emulateMedia({ colorScheme: "light" });
  });

  test("the gate is measured once per payload, not per facet", async ({ page }) => {
    // Filter-independence: the gate is a fact about the WIKI, so narrowing the
    // listing must not switch the term off (or on). Driven through the search
    // box, which is the one filter that also hides the rail's sections — so the
    // check is that the SAME order comes back, term and all, once it is cleared.
    await openReader(page, OPEN_WIKI);
    expect(await activityOrder(page)).toEqual(OPEN_ORDER);

    await page.fill("#wikiSearch", "alpha");
    await expect(activityRows(page)).toHaveCount(0);
    await page.fill("#wikiSearch", "");
    await expect(activityRows(page)).toHaveCount(NAMES.length);
    expect(await activityOrder(page)).toEqual(OPEN_ORDER);
    expect(await activityKinds(page)).toEqual(OPEN_KINDS);
  });
});
