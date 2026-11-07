/**
 * The fixture the three Your work card specs share (`wiki-work-card-slot`,
 * `-board` and `-strip`, split from one 187 s file so no shard waits on it):
 * the temp wikis, their seeded `.work-map.json` files, the muninn each spec
 * boots on its own port, and the helpers more than one of them reads.
 *
 * One muninn per spec file over the temp wikis. `SCHEDULER_ENABLED=false`
 * keeps the work-map loop off and every wiki not organizable. No model calls.
 */

import { test, expect, type Page } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { assertPortFree, waitForOwnServer } from "./own-server.ts";
import { WIKI_REFETCH_MIN_INTERVAL_MS } from "../src/dashboard/views/components/wiki-refresh.ts";
import type { WorkMapChecksBody } from "../src/wiki/work-map/gh-check.ts";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
/** The booting spec's base URL, set in its `beforeAll`: files run one after another in a worker. */
let base = "";

export const FRESH = "e2e-wm-fresh";
export const STALE = "e2e-wm-stale";
export const DONE = "e2e-wm-done";
export const NONE = "e2e-wm-none";
export const LONG = "e2e-wm-long";
/** Wikis a test mutates on disk: one each, so a failed test leaves no state behind for the next. */
export const FLIP = "e2e-wm-flip";
export const GROW = "e2e-wm-grow";
export const GROW_ERR = "e2e-wm-grow-err";
export const GROW_LATE = "e2e-wm-grow-late";
export const FB = "e2e-wm-fb";
/** Class-check (round 3) fixtures: one wiki per case, so no case inherits another's state. */
export const P_LOAD = "e2e-wm-p-load";
export const P_LATE = "e2e-wm-p-late";
export const P_LATE5 = "e2e-wm-p-late5";
export const P_POST = "e2e-wm-p-post";
export const P_POLL = "e2e-wm-p-poll";
export const P_FOCUS = "e2e-wm-p-focus";
export const P_DUP = "e2e-wm-p-dup";
export const P_WHY = "e2e-wm-p-why";
/** Paints every element the card has: the contrast sweep's wiki. */
export const SWEEP = "e2e-wm-sweep";
/** P6: a seven-page effort a page declared after the load must join on a listing refresh. */
export const DECL = "e2e-wm-decl";
/** The health strip: one wiki with counts, one taking no answers, one an adopt grows. */
export const STRIP = "e2e-wm-strip";
export const STRIP_OFF = "e2e-wm-strip-off";
export const STRIP_GROW = "e2e-wm-strip-grow";
export const STRIP_LONG = "e2e-wm-strip-long";
/** Each gains a wait in its test, so one each: a held focus, a held «+N more», a held expansion. */
export const STRIP_KEEP_CELL = "e2e-wm-strip-keep-cell";
export const STRIP_KEEP_MORE = "e2e-wm-strip-keep-more";
export const STRIP_KEEP_OPEN = "e2e-wm-strip-keep-open";
/** A themes map a test adopts page changes under. */
export const THEME_HOLD = "e2e-wm-theme-hold";
/** The GitHub check: the checks GET is stubbed, since a spec server never spawns `gh`. */
export const GH = "e2e-wm-gh";
/** Each loses its map mid-test and gets it back with the same run time. */
export const GH_DROP_OK = "e2e-wm-gh-drop-ok";
export const GH_DROP_FAIL = "e2e-wm-gh-drop-fail";
export const GH_DROP_DONE = "e2e-wm-gh-drop-done";
/** `forceAdopt` adds pages to it. */
export const GH_ADOPT = "e2e-wm-gh-adopt";
/** The board: one wiki read in many tests, one an adopt grows. */
export const BOARD = "e2e-wm-board";
export const BOARD_ADOPT = "e2e-wm-board-adopt";
/** An adopt adds an unrelated page to it. */
export const BOARD_QUIET = "e2e-wm-board-quiet";
/** A tall Waiting on you beside short columns, and a board with nothing waiting. */
export const BOARD_TALL = "e2e-wm-board-tall";
export const BOARD_NO_WAIT = "e2e-wm-board-no-wait";
export const KID_LONG_NAME = "a rather long sub-effort name that runs well past the width of its column";
export const GH_DROP_RUN = Date.now() - 2 * 3_600_000;
/** No break opportunity anywhere. */
export const LONG_TOKEN = "Aa".repeat(90);
export const LONG_WHY =
  "The two drafts of ⟦plans/alpha.mdx⟧ disagree on the name, the scope and the owner, and the review thread under the second draft has gone quiet for a week, so nobody has decided which of them the next slice builds on.";
/** Clamps to two lines in a narrow card and fits them in a wide one. */
export const MID_WHY =
  "The two drafts disagree on the name and the scope, and the review thread under the second draft has gone quiet for a week now.";
export const HOUR = 3_600_000;
/** Viewports where MID_WHY clamps and where it fits its two lines: below
 *  1000 px the rail folds away and the card widens (measured: 224 px of text
 *  at 1280, 454 px at 900). */
export const WHY_CLAMPED_AT = 1280;
export const WHY_FITS_AT = 900;

export function md(title: string): string {
  return `---\ntitle: ${title}\n---\n\nBody of ${title}.\n`;
}

/** A page with one waiting lane naming `ids`, each with a `<Question>` block. */
export function waitPage(title: string, ids: string[], since: string, frontmatter = "", to = ""): string {
  const items = ids.map((id) => `- ${id} needs a pick`).join("\n");
  const blocks = ids.map((id) => `<Question id="${id}"${to ? ` to="${to}"` : ""}>\n\nWhich one?\n\n</Question>`).join("\n\n");
  return `---\ntitle: ${title}\n${frontmatter}---\n\n<NextMoves>\n\n<Lane kind="waiting" since="${since}">\n\n${items}\n\n</Lane>\n\n</NextMoves>\n\n${blocks}\n`;
}

export function dayBefore(now: number, days: number): string {
  return new Date(now - days * 24 * HOUR).toISOString().slice(0, 10);
}

/** Fourteen decisions on thirteen pages, the oldest about 30 days old, plus the pages that must not count. */
export async function seedStripPages(root: string, now: number): Promise<void> {
  for (let i = 1; i <= 12; i++) await writeFile(path.join(root, `plans/wait-${i}.mdx`), waitPage(`Wait ${i}`, ["O1"], dayBefore(now, 30 - i)), "utf8");
  await writeFile(path.join(root, "plans/two.mdx"), waitPage("Two asks", ["O1", "O2"], dayBefore(now, 10)), "utf8");
  await writeFile(path.join(root, "plans/other.mdx"), waitPage("Other group", ["O1"], dayBefore(now, 90), "", "fag"), "utf8");
  await writeFile(path.join(root, "plans/dropped.mdx"), waitPage("Dropped", ["O1"], dayBefore(now, 90), "plan_status: abandoned\n"), "utf8");
  await writeFile(path.join(root, "plans/steps.mdx"), `---\ntitle: Steps\n---\n\n<NextMoves>\n\n<Lane kind="you">\n\n- One\n- Two\n- Three\n\n</Lane>\n\n</NextMoves>\n`, "utf8");
  await writeFile(path.join(root, "plans/loop.mdx"), `---\ntitle: Loop\nplan_status: shipped\nfollowups: open\nstatus_date: ${dayBefore(now, 5)}\n---\n\nBody.\n`, "utf8");
}

export type NeedFixture = { title: string; kind: string; why: string; action: string; pages: string[]; effort?: string };

export const DEFAULT_NEEDS: NeedFixture[] = [
  { title: "Pick a name for ⟦plans/alpha.mdx⟧", kind: "decision", why: "Two drafts disagree.", action: "Choose one.", pages: ["plans/alpha.mdx"] },
  { title: "Resume beta", kind: "resume", why: "", action: "", pages: ["plans/beta.mdx"] },
];

export function mapJson(wiki: string, runAtMs: number, needsYou: NeedFixture[] = DEFAULT_NEEDS): string {
  return JSON.stringify({
    version: 1,
    wiki,
    runAtMs,
    model: "test-model",
    coverage: {
      sessionsSinceMs: runAtMs - 8 * 24 * HOUR,
      sessionsAsOfMs: runAtMs,
      touchWindowDays: 28,
      activePages: 3,
      threads: 2,
      logEntries: 120,
      logEntriesInWindow: 150,
      digestChars: 4000,
      metadataFilter: { degraded: false },
      warnings: [],
    },
    summary: "Alpha moves on ⟦plans/alpha.mdx⟧; the old ⟦plans/gone.mdx⟧ was removed.",
    needsYou,
    themes: [],
    efforts: [
      { id: "alpha", name: "Alpha work", aliases: [], oneLine: "The alpha plan.", state: "active", pages: [{ id: "plans/alpha.mdx", role: "plan" }, { id: "plans/gone.mdx", role: "report" }], why: "", confidence: 1, next: "Ship it.", related: [], daily: [] },
      { id: "beta", name: "Beta work", aliases: [], oneLine: "", state: "cooling", pages: [{ id: "plans/beta.mdx", role: "plan" }], why: "", confidence: 1, next: "", related: [], daily: [] },
      { id: "gamma", name: "Gamma work", aliases: [], oneLine: "", state: "shipped", pages: [{ id: "plans/gamma.mdx", role: "plan" }], why: "", confidence: 1, next: "", related: [], daily: [] },
    ],
    loose: [],
  });
}

/** A stale map that renders every part of the card: a waiting tile with every
 *  pill, a nested and a part-of sub-effort, an empty column, an active day, a
 *  Needs-you item with `+N more`, a next step, a coverage warning and a clamped why. */
export function sweepMapJson(runAtMs: number): string {
  const m = JSON.parse(mapJson(SWEEP, runAtMs, [
    { title: "Settle ⟦plans/alpha.mdx⟧", kind: "decision", why: LONG_WHY, action: "Pick one draft.", pages: ["plans/beta.mdx", "plans/gamma.mdx", "plans/p1.mdx", "plans/p2.mdx", "plans/p3.mdx", "plans/p4.mdx", "plans/p5.mdx"], effort: "waiting" },
    { title: "Resume beta", kind: "resume", why: "Quiet a week.", action: "", pages: [] },
  ])) as Record<string, unknown> & { coverage: Record<string, unknown> };
  m.coverage.warnings = ["Active pages fell from 90 to 30."];
  const today = new Date().toISOString().slice(0, 10);
  const e = (id: string, state: string, pages: string[], extra: Record<string, unknown> = {}) => ({
    id, name: `${id} work`, aliases: [], oneLine: `The ${id} effort.`, state, pages: pages.map((p) => ({ id: p, role: "plan" })), why: "", confidence: 1, next: "", related: [], daily: [], ...extra,
  });
  m.efforts = [
    e("active", "active", ["plans/alpha.mdx", "plans/p1.mdx", "plans/p2.mdx", "plans/p3.mdx", "plans/p4.mdx", "plans/p5.mdx", "plans/p6.mdx"], { next: "Ship ⟦plans/alpha.mdx⟧.", daily: [{ day: today, commits: 2, sessions: 1 }] }),
    e("nested", "proposed", ["plans/p1.mdx"], { parent: "active" }),
    e("blocked", "blocked", ["plans/beta.mdx"]),
    e("cooling", "cooling", ["plans/beta.mdx"]),
    e("partof", "active", ["plans/gamma.mdx"], { parent: "cooling" }),
    e("quiet", "quiet", ["plans/gamma.mdx"]),
    e("waiting", "active", ["plans/two.mdx", "plans/steps.mdx"], { daily: [{ day: today, commits: 1, sessions: 0 }] }),
  ];
  return JSON.stringify(m);
}

/** Every column holds something, and two efforts wait on a PR the stubbed check can merge. */
export function boardMapJson(wiki: string, runAtMs: number): string {
  const need = (title: string, effort: string): NeedFixture => ({ title, kind: "followup", why: "", action: "Merge #369", pages: [], effort });
  const m = JSON.parse(mapJson(wiki, runAtMs, [need("Merge the move", "to-moving"), need("Merge the cooling", "to-cooling")])) as Record<string, unknown>;
  m.summary = "";
  const today = new Date().toISOString().slice(0, 10);
  const e = (id: string, state: string, page: string, extra: Record<string, unknown> = {}) => ({
    id, name: `${id} work`, aliases: [], oneLine: `The ${id} effort.`, state, pages: [{ id: page, role: "plan" }], why: "", confidence: 1, next: "", related: [], daily: [], ...extra,
  });
  m.efforts = [
    e("waiting", "quiet", "plans/waits.mdx"),
    e("to-moving", "active", "plans/alpha.mdx"),
    e("to-cooling", "cooling", "plans/beta.mdx"),
    e("moves", "active", "plans/gamma.mdx", { next: "Ship it.", daily: [{ day: today, commits: 3, sessions: 1 }] }),
    e("sub", "blocked", "plans/gamma.mdx", { parent: "moves" }),
    e("away", "cooling", "plans/beta.mdx", { parent: "moves" }),
    e("long", "active", "plans/gamma.mdx", { name: LONG_TOKEN, oneLine: LONG_TOKEN, next: LONG_TOKEN }),
    e("still", "quiet", "plans/gamma.mdx"),
    e("over", "shipped", "plans/gamma.mdx"),
  ];
  return JSON.stringify(m);
}

export function boardTallMapJson(wiki: string, runAtMs: number, waits: boolean): string {
  const ids = waits ? Array.from({ length: 9 }, (_, i) => `wait-${i}`) : [];
  const m = JSON.parse(mapJson(wiki, runAtMs, ids.map((id) => ({ title: `Settle ${id}`, kind: "followup", why: "", action: "Pick one", pages: [], effort: id })))) as Record<string, unknown>;
  m.summary = "";
  const today = new Date().toISOString().slice(0, 10);
  const daily = [{ day: today, commits: 2, sessions: 0 }];
  const e = (id: string, state: string, page: string, extra: Record<string, unknown> = {}) => ({
    id, name: `${id} work`, aliases: [], oneLine: `The ${id} effort.`, state, pages: [{ id: page, role: "plan" }], why: "", confidence: 1, next: "", related: [], daily: [], ...extra,
  });
  m.efforts = [
    ...ids.map((id) => e(id, "active", "plans/gamma.mdx", { oneLine: "A one line long enough to take several lines in a narrow column, as real ones do.", next: "Decide it." })),
    ...(waits
      ? [
          e("kids", "active", "plans/waits.mdx", { daily }),
          e("kid-two", "active", "plans/waits.mdx", { parent: "kids", name: "two pills", daily }),
          e("kid-long", "active", "plans/waits.mdx", { parent: "kids", name: KID_LONG_NAME, daily }),
          e("kid-idle", "active", "plans/waits.mdx", { parent: "kids", name: "idle" }),
        ]
      : []),
    e("moving-a", "active", "plans/gamma.mdx", { daily }),
    e("moving-b", "active", "plans/gamma.mdx"),
    e("cool", "cooling", "plans/beta.mdx"),
    e("still", "quiet", "plans/gamma.mdx"),
    e("over", "shipped", "plans/gamma.mdx"),
  ];
  return JSON.stringify(m);
}

export let server: ChildProcess | undefined;
export const roots: Record<string, string> = {};

/** Commits everything in `root` at `atMs`, so a page written later is the one
 *  untracked (dirty) page: a declared page joins its effort only when dirty or
 *  dated after the run, never on a clean file's mtime. Identity and both dates
 *  are passed per command. */
export function commitAll(root: string, atMs: number): void {
  const date = new Date(atMs).toISOString();
  const env = { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "fixture"]]) execFileSync("git", ["-C", root, ...args], { stdio: "ignore", env });
}

export async function seedWiki(name: string, runAtMs: number | null, needsYou?: NeedFixture[]): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-${name}-`));
  roots[name] = root;
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, "plans/alpha.mdx"), md("Alpha plan"), "utf8");
  await writeFile(path.join(root, "plans/beta.mdx"), md("Beta plan"), "utf8");
  await writeFile(path.join(root, "plans/gamma.mdx"), md("Gamma plan"), "utf8");
  if (runAtMs !== null) await writeFile(path.join(root, ".work-map.json"), mapJson(name, runAtMs, needsYou), "utf8");
}

/** Seed the wikis and boot this spec file's muninn on `port`; kill it and remove the wikis after. */
export function useWorkCardServer(port: number): void {
  test.beforeAll(async () => {
    base = `http://127.0.0.1:${port}`;
    const now = Date.now();
    await seedWiki(FRESH, now - 2 * HOUR);
    await seedWiki(STALE, now - 30 * HOUR);
    await seedWiki(DONE, now - 3 * HOUR);
    await seedWiki(NONE, null);
    await seedWiki(LONG, now - 2 * HOUR, [{ title: "Settle alpha", kind: "decision", why: LONG_WHY, action: "Pick one draft and close the other.", pages: [] }]);
    await seedWiki(FLIP, now - 2 * HOUR);
    await seedWiki(GROW, null);
    await seedWiki(GROW_ERR, null);
    await seedWiki(GROW_LATE, null);
    await seedWiki(FB, now - 2 * HOUR);
    for (const n of [P_LATE, P_LATE5, P_POST, P_POLL, P_FOCUS]) await seedWiki(n, now - 2 * HOUR);
    await seedWiki(P_LOAD, null);
    await seedWiki(P_DUP, now - 2 * HOUR, [
      { title: "Same", kind: "decision", why: "", action: "", pages: [] },
      { title: "Same", kind: "decision", why: "", action: "", pages: [] },
      { title: "Other", kind: "resume", why: "", action: "", pages: [] },
    ]);
    await seedWiki(P_WHY, now - 2 * HOUR, [{ title: "Settle alpha", kind: "decision", why: MID_WHY, action: "", pages: [] }]);
    await seedWiki(DECL, null);
    {
      const m = JSON.parse(mapJson(DECL, now - 2 * HOUR, [])) as { efforts: { id: string; pages: { id: string; role: string }[] }[] };
      const seven = ["plans/alpha.mdx", ...[1, 2, 3, 4, 5, 6].map((i) => `plans/d${i}.mdx`)];
      for (let i = 1; i <= 6; i++) await writeFile(path.join(roots[DECL]!, `plans/d${i}.mdx`), md(`Decl page ${i}`), "utf8");
      m.efforts[0]!.pages = seven.map((id) => ({ id, role: "plan" }));
      await writeFile(path.join(roots[DECL]!, ".work-map.json"), JSON.stringify(m), "utf8");
      commitAll(roots[DECL]!, now - 3 * HOUR);
    }
    await seedWiki(SWEEP, null);
    for (let i = 1; i <= 6; i++) await writeFile(path.join(roots[SWEEP]!, `plans/p${i}.mdx`), md(`Page ${i}`), "utf8");
    await writeFile(path.join(roots[SWEEP]!, ".work-map.json"), sweepMapJson(now - 30 * HOUR), "utf8");
    await seedStripPages(roots[SWEEP]!, now);
    for (const n of [STRIP, STRIP_OFF, STRIP_GROW]) await seedWiki(n, now - 2 * HOUR);
    await seedStripPages(roots[STRIP]!, now);
    await seedStripPages(roots[STRIP_OFF]!, now);
    await writeFile(path.join(roots[STRIP_GROW]!, "plans/first.mdx"), waitPage("First wait", ["O1"], dayBefore(now, 2)), "utf8");
    for (const n of [STRIP_KEEP_CELL, STRIP_KEEP_MORE, STRIP_KEEP_OPEN]) {
      await seedWiki(n, now - 2 * HOUR);
      await seedStripPages(roots[n]!, now);
    }
    await seedWiki(STRIP_LONG, now - 2 * HOUR);
    await writeFile(path.join(roots[STRIP_LONG]!, "plans/long.mdx"), waitPage(LONG_TOKEN, ["O1"], dayBefore(now, 3)), "utf8");
    // No title: `pageTitle` falls back to the stem.
    await writeFile(path.join(roots[STRIP_LONG]!, `plans/${"s".repeat(180)}.mdx`), waitPage("x", ["O1"], dayBefore(now, 2)).replace("title: x\n", ""), "utf8");
    await seedWiki(THEME_HOLD, now - 2 * HOUR);
    await seedWiki(GH, now - 2 * HOUR, [
      { title: "Merge the fix", kind: "followup", why: "", action: "Merge #369", pages: [] },
      { title: "Closed one", kind: "followup", why: "", action: "Close #12", pages: [] },
      { title: "Only mentions", kind: "followup", why: "", action: "Wait for the release of #3556", pages: [] },
      { title: "Asks for two", kind: "followup", why: "", action: "Merge #1 and #2", pages: [] },
      { title: "No PR", kind: "decision", why: "", action: "Pick one", pages: [] },
    ]);
    for (const n of [GH_DROP_OK, GH_DROP_FAIL, GH_DROP_DONE]) await seedWiki(n, GH_DROP_RUN);
    await seedWiki(GH_ADOPT, now - 2 * HOUR);
    for (const n of [BOARD, BOARD_ADOPT, BOARD_QUIET]) {
      await seedWiki(n, null);
      await writeFile(path.join(roots[n]!, "plans/waits.mdx"), waitPage("Waits", ["O1"], dayBefore(now, 4)), "utf8");
      await writeFile(path.join(roots[n]!, ".work-map.json"), boardMapJson(n, now - 2 * HOUR), "utf8");
    }
    for (const [n, waits] of [[BOARD_TALL, true], [BOARD_NO_WAIT, false]] as const) {
      await seedWiki(n, null);
      await writeFile(path.join(roots[n]!, "plans/waits.mdx"), waitPage("Waits", ["O1"], dayBefore(now, 4)), "utf8");
      await writeFile(path.join(roots[n]!, ".work-map.json"), boardTallMapJson(n, now - 2 * HOUR, waits), "utf8");
    }
    await assertPortFree(port);
    server = spawn("bun", ["run", "src/index.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...e2eEnv(),
        DASHBOARD_PORT: String(port),
        DASHBOARD_HOST: "127.0.0.1",
        SCHEDULER_ENABLED: "false",
        WORK_MAP_WIKIS: "",
        WIKI_DIR: "",
        WIKI_ANSWER_WIKIS: [STRIP, STRIP_GROW, STRIP_LONG, STRIP_KEEP_CELL, STRIP_KEEP_MORE, STRIP_KEEP_OPEN, SWEEP, BOARD, BOARD_ADOPT, BOARD_QUIET, BOARD_TALL, BOARD_NO_WAIT].join(","),
        WIKI_ANSWER_OWNER: "Test Owner (T000001)",
        WIKI_ANSWER_GROUPS: "utvikler=T000001",
        WIKI_EXTRA: [BOARD, BOARD_ADOPT, BOARD_QUIET, BOARD_TALL, BOARD_NO_WAIT, GH, GH_DROP_OK, GH_DROP_FAIL, GH_DROP_DONE, GH_ADOPT, FRESH, STALE, DONE, NONE, LONG, FLIP, GROW, GROW_ERR, GROW_LATE, FB, SWEEP, DECL, STRIP, STRIP_OFF, STRIP_GROW, STRIP_LONG, STRIP_KEEP_CELL, STRIP_KEEP_MORE, STRIP_KEEP_OPEN, THEME_HOLD, P_LOAD, P_LATE, P_LATE5, P_POST, P_POLL, P_FOCUS, P_DUP, P_WHY].map((n) => `${n}=${roots[n]}`).join(","),
      },
      stdio: "ignore",
    });
    await waitForOwnServer(server, `${base}/api/wiki/pages?wiki=${NONE}`);
  });

  test.afterAll(async () => {
    server?.kill("SIGTERM");
    for (const r of Object.values(roots)) await rm(r, { recursive: true, force: true });
  });

  // The card and the rail keep polling `/api/wiki/work-map` after a test's last
  // assertion; a handler still awaiting `route.fetch()` when the page closes
  // throws "Response has been disposed" (CI, 2026-10-30). Same as wiki-stale-tab.
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
}

/** Open a wiki's start view, recording every `/api/wiki/digest` request. */
export async function openStart(page: Page, wiki: string): Promise<string[]> {
  const digests: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/wiki/digest") digests.push(r.url());
  });
  await page.goto(`${base}/wiki?wiki=${wiki}`);
  await expect(page.locator(".wiki-start")).toBeVisible();
  return digests;
}

/** Wait out the card's second paint on a load. The checks answer lands after the first paint and replaces every
 *  cell, whatever it says: a real answer with the check off here drops the strip from 5 cells to 4, so a cell moves
 *  out from under a hover, and a stubbed answer keeps the cell with its figure. Either way the cell's value stops
 *  reading «checking…». The first line is needed: before the first paint there is no `github` cell either. */
export async function checksPainted(page: Page) {
  await expect(page.locator('#wikiWorkCard [data-wm-cell="decisions"]')).toBeAttached();
  await expect(page.locator('#wikiWorkCard [data-wm-cell="github"] b', { hasText: "checking…" })).toHaveCount(0);
}

/**
 * `openStart` for a test that reads the card outside a web-first assertion, on a wiki with a strip. Never with an
 * answer held on purpose: `checksPainted` would wait out its timeout.
 */
export async function openSettled(page: Page, wiki: string): Promise<string[]> {
  const digests = await openStart(page, wiki);
  await checksPainted(page);
  return digests;
}

export let lateN = 0;
/** Force a background listing adopt: a page lands on disk, the client throttle
 *  passes, the tab regains focus — an unchanged listing is never adopted. */
export async function forceAdopt(page: Page, wiki: string): Promise<void> {
  const title = `Late page ${++lateN}`;
  await writeFile(path.join(roots[wiki]!, `late-${lateN}.md`), md(title), "utf8");
  await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#wikiList")).toContainText(title);
  await page.waitForTimeout(300);
}

export const boardCard = (page: Page) => page.locator("#wikiWorkCard");

export const boardNeeds = (): WorkMapChecksBody["needs"] => [
  { kind: "followup", title: "Merge the move", pr: 369, state: "MERGED", mergedAt: GH_MERGED_AT, asksForIt: true },
  { kind: "followup", title: "Merge the cooling", pr: 369, state: "MERGED", mergedAt: GH_MERGED_AT, asksForIt: true },
];

/** Hold the checks GET until the returned call. */
export async function holdChecks(page: Page, body: () => WorkMapChecksBody): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/work-map/checks*", async (route) => {
    await held;
    await route.fulfill({ json: body() });
  });
  return release;
}

export const GH_MERGED_AT = "2026-10-29T12:00:00Z";

export function checksBody(over: Partial<WorkMapChecksBody> = {}): WorkMapChecksBody {
  return { at: Date.now(), checked: 5, compared: 0, unchecked: 0, unlinked: 0, skipped: 0, contradictions: [], prs: {}, needs: [], uncheckedRows: [], unlinkedRows: [], ...over };
}

export const GH_NEEDS: WorkMapChecksBody["needs"] = [
  { kind: "followup", title: "Merge the fix", pr: 369, state: "MERGED", mergedAt: GH_MERGED_AT, asksForIt: true },
  { kind: "followup", title: "Closed one", pr: 12, state: "CLOSED", mergedAt: null, asksForIt: true },
  { kind: "followup", title: "Only mentions", pr: 3556, state: "MERGED", mergedAt: "2026-10-28T12:00:00Z", asksForIt: false },
  { kind: "followup", title: "Asks for two", pr: 1, state: "MERGED", mergedAt: GH_MERGED_AT, asksForIt: true },
  { kind: "followup", title: "Asks for two", pr: 2, state: "OPEN", mergedAt: null, asksForIt: true },
];

/** The client's `WORK_CHECKS_RETRY_MS`. */
export const CHECKS_RETRY_MS = 15_000;

/**
 * Stub the checks GET; returns the request count and `retry(n)`, one step of the
 * client's retry chain under a fake clock: its n-1 timers are armed, one interval
 * fires the next, and that fetch is number n.
 *
 * `count` moves when a request is SENT and the client arms its timer only after
 * reading the answer, so a `runFor` in that gap fires nothing (CI, 2026-11-03:
 * expected 4, received 3). Hence the wait on the armed timers. Install the clock first.
 */
export async function stubChecks(page: Page, answer: (n: number) => WorkMapChecksBody): Promise<{ count: () => number; retry: (n: number) => Promise<void> }> {
  let n = 0;
  await page.addInitScript((retryMs) => {
    const w = window as unknown as { __checksRetriesArmed: number; setTimeout: (fn: () => void, ms: number) => number };
    w.__checksRetriesArmed = 0;
    const real = w.setTimeout;
    w.setTimeout = (fn, ms) => {
      if (ms === retryMs) w.__checksRetriesArmed += 1;
      return real(fn, ms);
    };
  }, CHECKS_RETRY_MS);
  await page.route("**/api/wiki/work-map/checks*", (route) => route.fulfill({ json: answer(++n) }));
  const armed = () => page.evaluate(() => (window as unknown as { __checksRetriesArmed: number }).__checksRetriesArmed);
  return {
    count: () => n,
    retry: async (expected) => {
      await expect.poll(armed).toBe(expected - 1);
      await page.clock.runFor(CHECKS_RETRY_MS);
      await expect.poll(() => n).toBe(expected);
    },
  };
}

export const GH_UNLINKED = Array.from({ length: 197 }, (_, i) => ({ page: "plans/gamma.mdx", label: `row ${i + 1}` }));
export const GH_UNCHECKED = Array.from({ length: 9 }, (_, i) => ({ page: "plans/beta.mdx", pr: 100 + i, repo: "acme/gears" }));

/** A point on plain text in the card, in view: a press off-screen lands on the document, not the card. */
export async function pressPoint(card: ReturnType<Page["locator"]>) {
  const text = card.locator(".wiki-wm-coverage");
  await text.scrollIntoViewIfNeeded();
  const box = (await text.boundingBox())!;
  return { x: box.x + 2, y: box.y + 6, width: box.width };
}

export const DIGEST_OK = { digest: { bullets: "- x", html: "<ul><li>Something changed</li></ul>", generatedAt: Date.now(), logMtimeMs: 0, entryCount: 1, fromDate: "2026-10-28", toDate: "2026-10-29" } };

/** Answer every work-map GET as organizable, so the card offers ↻. */
export async function organizable(page: Page, hold?: (n: number, fulfill: () => Promise<void>) => boolean) {
  const st = { gets: 0 };
  await page.route("**/api/wiki/work-map?*", async (route) => {
    const n = ++st.gets;
    const body = (await (await route.fetch()).json()) as Record<string, unknown>;
    const f = () => route.fulfill({ json: { ...body, organizable: true, lastSuccessAt: Date.now() - 60 * 60_000 } });
    if (hold?.(n, f)) return;
    await f();
  });
  return st;
}

/** Every theme a reader can end up in: an explicit pick stored under
 *  `muninn-theme` (a base or a palette), or nothing stored and the OS scheme. */
export const THEMES: { label: string; stored: string | null; scheme: "light" | "dark" }[] = [
  { label: "Light", stored: "light", scheme: "dark" },
  { label: "Dark", stored: "dark", scheme: "light" },
  { label: "Reading mode", stored: "reading", scheme: "light" },
  { label: "Light reading mode", stored: "paper-light", scheme: "dark" },
  { label: "System light", stored: null, scheme: "light" },
  { label: "System dark", stored: null, scheme: "dark" },
];

/** A themes map over the sweep wiki's pages that paints every part of the
 *  themes card: each state, a Life theme, a connection, a drift count, hub
 *  chips, a partial week, the running week and «+N earlier». */
export function sweepThemesMap(runAtMs: number): unknown {
  const states = ["new", "rising", "steady", "fading", "steady"];
  // Ten weeks ending with the one holding the run (Oslo): two before the strip's 8.
  const runDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo" }).format(new Date(runAtMs));
  const monday = Date.parse(`${runDay}T00:00:00Z`) - ((new Date(`${runDay}T00:00:00Z`).getUTCDay() + 6) % 7) * 86_400_000;
  const weekly = Array.from({ length: 10 }, (_, i) => {
    const start = new Date(monday - (9 - i) * 7 * 86_400_000).toISOString().slice(0, 10);
    return { week: `W${i}`, start, count: i < 2 ? 2 : i % 3, ...(i === 2 ? { partial: true } : {}) };
  });
  const efforts = states.map((state, i) => ({
    id: `t${i}`, name: `Theme ${i}`, oneLine: `About theme ${i}.`, state, domain: i === 4 ? "life" : "ai",
    pages: [{ id: `plans/p${i + 1}.mdx`, role: "source" }], hubs: ["plans/alpha.mdx", "plans/beta.mdx"], readFirst: [],
    takeaway: "", disagreement: "", confidence: 1, related: i === 0 ? [{ id: "t1", why: "Both read ⟦plans/alpha.mdx⟧." }] : [],
    weekly, trend: { recent: 3, earlier: 1 },
  }));
  return {
    version: 1, kind: "themes", wiki: SWEEP, runAtMs, model: "test-model",
    coverage: { activeSources: 5, hubs: 2, driftHubs: 1, placed: 5, digestChars: 100, windowDays: 28, warnings: ["Ten sources were cut from the digest."] },
    summary: "Mostly ⟦plans/p1.mdx⟧.",
    needsYou: [{ title: "Alpha is behind", kind: "drift", why: "Three sources since.", action: "Refresh it.", pages: [], effort: "t0", hubs: ["plans/alpha.mdx"], count: 3 }],
    themes: [{ name: "AI & tech", efforts: ["t0", "t1", "t2", "t3"] }, { name: "Life", efforts: ["t4"] }],
    efforts, retired: [], loose: [],
  };
}
