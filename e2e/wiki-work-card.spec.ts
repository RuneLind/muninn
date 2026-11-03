/**
 * The Your work card (plan `muninn-wiki-work-map`, P2) as wired into the /wiki
 * start view.
 *
 * The rendering rules are unit-tested (`wiki-work-card.test.ts`); what only a
 * real page can hold:
 *
 *  1. **The slot choice.** A wiki whose listing carries `workMap` shows the
 *     card and makes NO `/api/wiki/digest` request (What's new's model call
 *     stops there); a wiki without a map still shows What's new.
 *  2. **The card against a seeded `.work-map.json`**: its age, coverage, a
 *     marker to a gone page as plain text, the stale mark past 26 h, ↻ hidden
 *     when the GET says not organizable.
 *  3. **✓ dismiss persists across a reload and clears when `runAt` changes** —
 *     the localStorage half and the listing's mtime-cached `runAt`.
 *  4. **↻'s refusal copy**, against a stubbed GET (`organizable: true`) and a
 *     stubbed 429: no run is started, so no model call.
 *  5. **A background adopt leaves the start cards alone**: a no-map wiki's
 *     digest is asked for no more often than before and its in-flight ↻ stays
 *     disabled; a lane the reader opened stays open across a repaint.
 *  6. **A ↻ poll whose GET keeps failing settles** and re-enables ↻; a first
 *     GET answered 4xx, or failing on the network twice, yields What's new.
 *     ✓ lasts the page's life when localStorage throws.
 *  7. **Legible in every theme** — each explicit pick (Light, Dark, Reading,
 *     Light reading) and System under both OS schemes: every element that
 *     paints text, in every state (map, refusal, running, all done, error),
 *     clears 4.5:1 against what is painted behind it.
 *  8. **A page declared after the run (P6)** joins its effort on a listing
 *     refresh though the run did not move: its step on the board, and first on
 *     the effort page.
 *  9. **The health strip (your-work board P1)**: its cells count the live
 *     listing, a cell opens its list and «+N more» expands it, a wiki taking no
 *     answers reads «owner not set», an adopt repaints the count, a themes map
 *     has no strip and keeps its markup when only the strip's inputs change.
 *     Focus on a cell or on «+N more», and an expanded list, survive that repaint.
 *     A long title wraps in the list; focus on an open cell shows in every theme,
 *     hover answers on an enabled cell, and forced colors keep open and focus apart.
 * 10. **The GitHub check (your-work board P2)**, with its GET stubbed: the fifth
 *     cell in one row with the others, its list, the struck, warning and neutral
 *     marks, «checking…», «refreshing» and its three more fetches, the «not
 *     checked» remedies, a repaint that keeps a fold and focus, a new map's
 *     refetch and no mark from the previous answer while it is pending or after
 *     it fails, and a themes map that never asks. Its list's three groups and
 *     their keyboard rule, focus and selection across a repaint, and the strip's
 *     layout, measured: equal cell widths and no word broken at six widths. Its
 *     lifecycle: a late answer dropped, and no fetch or timer added by a render.
 * 11. **The board (your-work board P3)**: the columns' tracks at each window, the
 *     folds that stop folding when all five fit, live under F with no repaint, no
 *     horizontal overflow, an effort moving between columns when the check or a ✓
 *     or an adopt says so, focus following it, the sparkline under forced colors,
 *     and from that width heads that take no focus or key, with each column named.
 *     Beside a tall Waiting on you the other columns land right under each other,
 *     and a compact row is two lines, all measured.
 *
 * One muninn on its own port over four temp wikis. `SCHEDULER_ENABLED=false`
 * keeps the work-map loop off and every wiki not organizable. No model calls.
 */

import { test, expect, type Locator, type Page, type Route } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { assertPortFree, waitForOwnServer } from "./own-server.ts";
import { contrastOf, paintedMeasure, token } from "./contrast.ts";
import { WIKI_REFETCH_MIN_INTERVAL_MS } from "../src/dashboard/views/components/wiki-refresh.ts";
import type { WorkMapChecksBody } from "../src/wiki/work-map/gh-check.ts";

const PORT = e2ePort("wiki-work-card");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const FRESH = "e2e-wm-fresh";
const STALE = "e2e-wm-stale";
const DONE = "e2e-wm-done";
const NONE = "e2e-wm-none";
const LONG = "e2e-wm-long";
/** Wikis a test mutates on disk: one each, so a failed test leaves no state behind for the next. */
const FLIP = "e2e-wm-flip";
const GROW = "e2e-wm-grow";
const GROW_ERR = "e2e-wm-grow-err";
const GROW_LATE = "e2e-wm-grow-late";
const FB = "e2e-wm-fb";
/** Class-check (round 3) fixtures: one wiki per case, so no case inherits another's state. */
const P_LOAD = "e2e-wm-p-load";
const P_LATE = "e2e-wm-p-late";
const P_LATE5 = "e2e-wm-p-late5";
const P_POST = "e2e-wm-p-post";
const P_POLL = "e2e-wm-p-poll";
const P_FOCUS = "e2e-wm-p-focus";
const P_DUP = "e2e-wm-p-dup";
const P_WHY = "e2e-wm-p-why";
/** Paints every element the card has: the contrast sweep's wiki. */
const SWEEP = "e2e-wm-sweep";
/** P6: a seven-page effort a page declared after the load must join on a listing refresh. */
const DECL = "e2e-wm-decl";
/** The health strip: one wiki with counts, one taking no answers, one an adopt grows. */
const STRIP = "e2e-wm-strip";
const STRIP_OFF = "e2e-wm-strip-off";
const STRIP_GROW = "e2e-wm-strip-grow";
const STRIP_LONG = "e2e-wm-strip-long";
/** Each gains a wait in its test, so one each: a held focus, a held «+N more», a held expansion. */
const STRIP_KEEP_CELL = "e2e-wm-strip-keep-cell";
const STRIP_KEEP_MORE = "e2e-wm-strip-keep-more";
const STRIP_KEEP_OPEN = "e2e-wm-strip-keep-open";
/** A themes map a test adopts page changes under. */
const THEME_HOLD = "e2e-wm-theme-hold";
/** The GitHub check: the checks GET is stubbed, since a spec server never spawns `gh`. */
const GH = "e2e-wm-gh";
/** Each loses its map mid-test and gets it back with the same run time. */
const GH_DROP_OK = "e2e-wm-gh-drop-ok";
const GH_DROP_FAIL = "e2e-wm-gh-drop-fail";
const GH_DROP_DONE = "e2e-wm-gh-drop-done";
/** `forceAdopt` adds pages to it. */
const GH_ADOPT = "e2e-wm-gh-adopt";
/** The board: one wiki read in many tests, one an adopt grows. */
const BOARD = "e2e-wm-board";
const BOARD_ADOPT = "e2e-wm-board-adopt";
/** An adopt adds an unrelated page to it. */
const BOARD_QUIET = "e2e-wm-board-quiet";
/** A tall Waiting on you beside short columns, and a board with nothing waiting. */
const BOARD_TALL = "e2e-wm-board-tall";
const BOARD_NO_WAIT = "e2e-wm-board-no-wait";
const KID_LONG_NAME = "a rather long sub-effort name that runs well past the width of its column";
const GH_DROP_RUN = Date.now() - 2 * 3_600_000;
/** No break opportunity anywhere. */
const LONG_TOKEN = "Aa".repeat(90);
const LONG_WHY =
  "The two drafts of ⟦plans/alpha.mdx⟧ disagree on the name, the scope and the owner, and the review thread under the second draft has gone quiet for a week, so nobody has decided which of them the next slice builds on.";
/** Clamps to two lines in a narrow card and fits them in a wide one. */
const MID_WHY =
  "The two drafts disagree on the name and the scope, and the review thread under the second draft has gone quiet for a week now.";
const HOUR = 3_600_000;
/** Viewports where MID_WHY clamps and where it fits its two lines: below
 *  1000 px the rail folds away and the card widens (measured: 224 px of text
 *  at 1280, 454 px at 900). */
const WHY_CLAMPED_AT = 1280;
const WHY_FITS_AT = 900;

function md(title: string): string {
  return `---\ntitle: ${title}\n---\n\nBody of ${title}.\n`;
}

/** A page with one waiting lane naming `ids`, each with a `<Question>` block. */
function waitPage(title: string, ids: string[], since: string, frontmatter = "", to = ""): string {
  const items = ids.map((id) => `- ${id} needs a pick`).join("\n");
  const blocks = ids.map((id) => `<Question id="${id}"${to ? ` to="${to}"` : ""}>\n\nWhich one?\n\n</Question>`).join("\n\n");
  return `---\ntitle: ${title}\n${frontmatter}---\n\n<NextMoves>\n\n<Lane kind="waiting" since="${since}">\n\n${items}\n\n</Lane>\n\n</NextMoves>\n\n${blocks}\n`;
}

function dayBefore(now: number, days: number): string {
  return new Date(now - days * 24 * HOUR).toISOString().slice(0, 10);
}

/** Fourteen decisions on thirteen pages, the oldest about 30 days old, plus the pages that must not count. */
async function seedStripPages(root: string, now: number): Promise<void> {
  for (let i = 1; i <= 12; i++) await writeFile(path.join(root, `plans/wait-${i}.mdx`), waitPage(`Wait ${i}`, ["O1"], dayBefore(now, 30 - i)), "utf8");
  await writeFile(path.join(root, "plans/two.mdx"), waitPage("Two asks", ["O1", "O2"], dayBefore(now, 10)), "utf8");
  await writeFile(path.join(root, "plans/other.mdx"), waitPage("Other group", ["O1"], dayBefore(now, 90), "", "fag"), "utf8");
  await writeFile(path.join(root, "plans/dropped.mdx"), waitPage("Dropped", ["O1"], dayBefore(now, 90), "plan_status: abandoned\n"), "utf8");
  await writeFile(path.join(root, "plans/steps.mdx"), `---\ntitle: Steps\n---\n\n<NextMoves>\n\n<Lane kind="you">\n\n- One\n- Two\n- Three\n\n</Lane>\n\n</NextMoves>\n`, "utf8");
  await writeFile(path.join(root, "plans/loop.mdx"), `---\ntitle: Loop\nplan_status: shipped\nfollowups: open\nstatus_date: ${dayBefore(now, 5)}\n---\n\nBody.\n`, "utf8");
}

type NeedFixture = { title: string; kind: string; why: string; action: string; pages: string[]; effort?: string };

const DEFAULT_NEEDS: NeedFixture[] = [
  { title: "Pick a name for ⟦plans/alpha.mdx⟧", kind: "decision", why: "Two drafts disagree.", action: "Choose one.", pages: ["plans/alpha.mdx"] },
  { title: "Resume beta", kind: "resume", why: "", action: "", pages: ["plans/beta.mdx"] },
];

function mapJson(wiki: string, runAtMs: number, needsYou: NeedFixture[] = DEFAULT_NEEDS): string {
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
function sweepMapJson(runAtMs: number): string {
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
function boardMapJson(wiki: string, runAtMs: number): string {
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

function boardTallMapJson(wiki: string, runAtMs: number, waits: boolean): string {
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

let server: ChildProcess | undefined;
const roots: Record<string, string> = {};

/** Commits everything in `root` at `atMs`, so a page written later is the one
 *  untracked (dirty) page: a declared page joins its effort only when dirty or
 *  dated after the run, never on a clean file's mtime. Identity and both dates
 *  are passed per command. */
function commitAll(root: string, atMs: number): void {
  const date = new Date(atMs).toISOString();
  const env = { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "fixture"]]) execFileSync("git", ["-C", root, ...args], { stdio: "ignore", env });
}

async function seedWiki(name: string, runAtMs: number | null, needsYou?: NeedFixture[]): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-${name}-`));
  roots[name] = root;
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, "plans/alpha.mdx"), md("Alpha plan"), "utf8");
  await writeFile(path.join(root, "plans/beta.mdx"), md("Beta plan"), "utf8");
  await writeFile(path.join(root, "plans/gamma.mdx"), md("Gamma plan"), "utf8");
  if (runAtMs !== null) await writeFile(path.join(root, ".work-map.json"), mapJson(name, runAtMs, needsYou), "utf8");
}

test.beforeAll(async () => {
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
  await assertPortFree(PORT);
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
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
  await waitForOwnServer(server, `${BASE}/api/wiki/pages?wiki=${NONE}`);
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

/** Open a wiki's start view, recording every `/api/wiki/digest` request. */
async function openStart(page: Page, wiki: string): Promise<string[]> {
  const digests: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/wiki/digest") digests.push(r.url());
  });
  await page.goto(`${BASE}/wiki?wiki=${wiki}`);
  await expect(page.locator(".wiki-start")).toBeVisible();
  return digests;
}

/** Wait out the card's second paint on a load. The checks answer lands after the first paint and replaces every
 *  cell, whatever it says: a real answer with the check off here drops the strip from 5 cells to 4, so a cell moves
 *  out from under a hover, and a stubbed answer keeps the cell with its figure. Either way the cell's value stops
 *  reading «checking…». The first line is needed: before the first paint there is no `github` cell either. */
async function checksPainted(page: Page) {
  await expect(page.locator('#wikiWorkCard [data-wm-cell="decisions"]')).toBeAttached();
  await expect(page.locator('#wikiWorkCard [data-wm-cell="github"] b', { hasText: "checking…" })).toHaveCount(0);
}

/**
 * `openStart` for a test that reads the card outside a web-first assertion, on a wiki with a strip. Never with an
 * answer held on purpose: `checksPainted` would wait out its timeout.
 */
async function openSettled(page: Page, wiki: string): Promise<string[]> {
  const digests = await openStart(page, wiki);
  await checksPainted(page);
  return digests;
}

test("a wiki with a map shows the card and never asks for the digest", async ({ page }) => {
  const digests = await openStart(page, FRESH);
  const card = page.locator("#wikiWorkCard");
  await expect(card).toBeVisible();
  await expect(card.locator(".wiki-wn-title")).toHaveText("Your work");
  await expect(card.locator(".wiki-wm-age")).toHaveText("organized 2 h ago");
  await expect(card.locator(".wiki-wm-stale")).toHaveCount(0);
  await expect(card.locator(".wiki-wm-coverage")).toContainText("3 active pages · 2 threads · log: the newest 120 of 150 shown");
  // A live marker is a reader link; a marker to a gone page is plain text.
  await expect(card.locator('.wiki-wm-summary a[data-relpath="plans/alpha.mdx"]')).toHaveText("Alpha plan");
  await expect(card.locator('.wiki-wm-summary a[data-relpath="plans/gone.mdx"]')).toHaveCount(0);
  // An inline page link is bounded at rest, not only on hover.
  await expect(card.locator('.wiki-wm-summary a[data-relpath="plans/alpha.mdx"]')).toHaveCSS("text-decoration-line", "underline");
  await expect(card.locator(".wiki-wm-summary")).toContainText("the old gone was removed");
  // An effort name is a link and reads as one at rest, not only on hover.
  await expect(card.locator('a.wiki-wm-effort-name[data-effort-link="alpha"]')).toHaveCSS("text-decoration-line", "underline");
  // The columns: Waiting on you and Moving open, the other three folded.
  await expect(card.locator("details.wiki-wm-col")).toHaveCount(5);
  await expect(card.locator('[data-wm-lane="you"]')).toHaveAttribute("open", "");
  await expect(card.locator('[data-wm-lane="moving"]')).toHaveAttribute("open", "");
  for (const id of ["cooling", "quiet", "shipped"]) await expect(card.locator(`[data-wm-lane="${id}"]`)).not.toHaveAttribute("open", "");
  // Not organizable on this instance: no ↻.
  await expect(card.locator("#wikiWorkMapRefresh")).toHaveCount(0);
  await expect(page.locator("#wikiWhatsNew")).toBeHidden();
  // Give a late digest fetch the chance to happen before asserting it did not.
  await page.waitForTimeout(500);
  expect(digests).toEqual([]);
  // A page link opens the page in the reader.
  await card.locator('.wiki-wm-summary a[data-relpath="plans/alpha.mdx"]').click();
  await expect(page.locator(".wiki-start")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("relPath")).toBe("plans/alpha.mdx");
});

test("a long Needs-you why is clamped to two lines and opens from its keyboard control", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  await openSettled(page, LONG);
  const card = page.locator("#wikiWorkCard");
  const text = card.locator(".wiki-wm-why-text");
  const more = card.locator(".wiki-wm-why-more");
  const lines = () => text.evaluate((el) => Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)));
  await expect.poll(lines).toBe(2);
  await expect.poll(() => text.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(text).toHaveAttribute("title", LONG_WHY.replace("⟦plans/alpha.mdx⟧", "Alpha plan"));
  await expect(card.locator(".wiki-wm-action")).toBeVisible();
  await expect(more).toBeVisible();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(more).toHaveAttribute("aria-controls", (await text.getAttribute("id"))!);
  await expect(more).toHaveCSS("cursor", "pointer");
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => text.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  await expect.poll(lines).toBeGreaterThan(2);
  await expect(more).toBeFocused();
  await page.keyboard.press("Space");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect.poll(lines).toBe(2);
});

test("a why that fits its two lines offers no expand control", async ({ page }) => {
  await openStart(page, FRESH);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator(".wiki-wm-why-text")).toHaveText("Two drafts disagree.");
  await expect(card.locator(".wiki-wm-why-more")).toBeHidden();
  await expect(card.locator(".wiki-wm-why-text")).not.toHaveCSS("cursor", "pointer");
  await expect(card.locator(".wiki-wm-why")).not.toHaveCSS("cursor", "pointer");
});

test("selecting text in an opened why leaves it open", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  // Settled because a checks answer that changes the card wipes a selection on a real page too. That
  // is tracked separately, and this test does not say a selection survives it.
  await openSettled(page, LONG);
  const card = page.locator("#wikiWorkCard");
  const text = card.locator(".wiki-wm-why-text");
  await card.locator(".wiki-wm-why-more").click();
  await expect(card.locator(".wiki-wm-why")).toHaveClass(/\bopen\b/);
  const box = (await text.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 4, { steps: 8 });
  await page.mouse.up();
  expect((await page.evaluate(() => String(getSelection()))).length).toBeGreaterThan(20);
  await expect(card.locator(".wiki-wm-why")).toHaveClass(/\bopen\b/);
  await expect(card.locator(".wiki-wm-why-more")).toHaveAttribute("aria-expanded", "true");
  // A plain click on the text does not toggle it either.
  await text.click({ position: { x: 4, y: 4 } });
  await expect(card.locator(".wiki-wm-why")).toHaveClass(/\bopen\b/);
});

test("an opened why and focus on its control survive a ↻ poll repaint", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  let gets = 0;
  await page.route("**/api/wiki/work-map?*", async (route) => {
    gets++;
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: true, lastSuccessAt: Date.now() - 60 * 60_000 } });
  });
  await page.route("**/api/wiki/work-map/refresh*", (route) => route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } }));
  await page.clock.install();
  await openSettled(page, LONG);
  const card = page.locator("#wikiWorkCard");
  await card.locator("#wikiWorkMapRefresh").click();
  await expect(page.locator("#wikiWorkMapStatus")).toContainText("Organizing…");
  const more = card.locator(".wiki-wm-why-more");
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() => document.querySelector("#wikiWorkCard .wiki-wm-summary")!.setAttribute("data-before-repaint", ""));
  const n = gets;
  await expect
    .poll(async () => {
      await page.clock.runFor(1_000);
      return gets;
    })
    .toBeGreaterThan(n);
  await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(card.locator(".wiki-wm-why")).toHaveClass(/\bopen\b/);
});

test("a map older than 26 h carries the stale mark", async ({ page }) => {
  await openStart(page, STALE);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator(".wiki-wm-age")).toHaveText("organized 30 h ago");
  await expect(card.locator(".wiki-wm-stale")).toHaveText("stale");
});

test("a wiki without a map still renders What's new", async ({ page }) => {
  // The digest is stubbed at the network boundary: no model call.
  await page.route("**/api/wiki/digest*", (route) =>
    route.fulfill({
      json: { digest: { bullets: "- x", html: "<ul><li>Something changed</li></ul>", generatedAt: Date.now(), logMtimeMs: 0, entryCount: 1, fromDate: "2026-10-28", toDate: "2026-10-29" } },
    }),
  );
  const listing = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${NONE}`)).json()) as Record<string, unknown>;
  expect("workMap" in listing).toBe(false);
  const digests = await openStart(page, NONE);
  await expect(page.locator("#wikiWhatsNew")).toBeVisible();
  await expect(page.locator("#wikiWhatsNew")).toContainText("Something changed");
  await expect(page.locator("#wikiWorkCard")).toBeHidden();
  expect(digests.length).toBeGreaterThan(0);
});

let lateN = 0;
/** Force a background listing adopt: a page lands on disk, the client throttle
 *  passes, the tab regains focus — an unchanged listing is never adopted. */
async function forceAdopt(page: Page, wiki: string): Promise<void> {
  const title = `Late page ${++lateN}`;
  await writeFile(path.join(roots[wiki]!, `late-${lateN}.md`), md(title), "utf8");
  await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#wikiList")).toContainText(title);
  await page.waitForTimeout(300);
}

test("a page declared after the load joins its effort on a listing refresh: its step on the board, the page first on the effort page (P6)", async ({ page }) => {
  await page.clock.install();
  await openStart(page, DECL);
  const alpha = page.locator('#wikiWorkCard .wiki-wm-effort[data-effort-id="alpha"]');
  await expect(alpha.locator(".wiki-wm-pills")).toHaveCount(0);
  // The run does not move: only the listing learns of the declaration.
  await writeFile(path.join(roots[DECL]!, "plans/declared-today.mdx"), `---\ntitle: Declared today\neffort: alpha\n---\n\n<NextMoves>\n\n<Lane kind="you">\n\n- One\n\n</Lane>\n\n</NextMoves>\n`, "utf8");
  await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#wikiList")).toContainText("Declared today");
  // On the board without a reload, and one click from its page.
  await expect(alpha.locator(".wiki-wm-pill")).toHaveText(["1 step"]);
  await alpha.locator("a.wiki-wm-effort-name").click();
  await expect(page.locator(".wiki-effort a[data-relpath]").first()).toHaveText("Declared today");
});

// ── The board (your-work board P3) ────────────────────────────────────
const boardCard = (page: Page) => page.locator("#wikiWorkCard");
const COLUMN_IDS = ["you", "moving", "cooling", "quiet", "shipped"];

async function trackCount(page: Page): Promise<number> {
  return boardCard(page).locator(".wiki-wm-cols").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
}

/** The column ids whose content the reader can see, by the browser's own answer. */
async function columnsShown(page: Page): Promise<string[]> {
  return boardCard(page).locator("details.wiki-wm-col").evaluateAll((cols) =>
    cols.flatMap((c) => {
      const content = c.querySelector(".wiki-wm-efforts, .wiki-wm-col-none");
      return content?.checkVisibility({ contentVisibilityAuto: true }) ? [c.getAttribute("data-wm-lane")!] : [];
    }),
  );
}

/** Nothing in the card reaches past it, and the page does not scroll sideways. */
async function expectNoOverflow(page: Page, label: string): Promise<void> {
  const r = await boardCard(page).evaluate((card) => {
    const right = card.getBoundingClientRect().right;
    const past = Array.from(card.querySelectorAll("*")).filter((el) => el.getClientRects().length > 0 && el.getBoundingClientRect().right > right + 0.5);
    return {
      scroll: card.scrollWidth - card.clientWidth,
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      past: past.map((el) => el.getAttribute("class")).slice(0, 5),
    };
  });
  expect(r, label).toEqual({ scroll: 0, doc: 0, past: [] });
}

async function boardInnerWidth(page: Page): Promise<number> {
  return boardCard(page).locator(".wiki-wm-board").evaluate((el) => el.getBoundingClientRect().width);
}

for (const [width, tracks, shown] of [
  [1280, 2, ["you", "moving"]],
  [1512, 3, ["you", "moving"]],
  [1728, 4, ["you", "moving"]],
  [1920, 5, COLUMN_IDS],
  [700, 1, ["you", "moving"]],
] as const) {
  test(`at a ${width} window the board has ${tracks} track${tracks === 1 ? "" : "s"} and shows ${shown.length} columns' content, with nothing overflowing`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSettled(page, BOARD);
    const card = boardCard(page);
    await expect(card.locator(".wiki-wm-tile").first()).toBeAttached();
    console.log(`board inner width at ${width}: ${await boardInnerWidth(page)}`);
    expect(await trackCount(page)).toBe(tracks);
    expect(await columnsShown(page)).toEqual([...shown]);
    await expectNoOverflow(page, `at ${width}`);
  });
}

test("the column heads count every effort in the column, nested included, in the table's order", async ({ page }) => {
  await openSettled(page, BOARD);
  const heads = await boardCard(page).locator("details.wiki-wm-col > summary").allInnerTexts();
  expect(heads.map((h) => h.replace(/\s+/g, " ").trim().toLowerCase())).toEqual(["waiting on you 3", "moving 3", "cooling 1", "quiet 1", "shipped 1"]);
  const moves = boardCard(page).locator('[data-wm-lane="moving"] .wiki-wm-tile[data-effort-id="moves"]');
  await expect(moves.locator('.wiki-wm-kid[data-effort-id="sub"]')).toHaveCount(1);
  // A sub-effort in another column stands on its own, naming its parent.
  await expect(boardCard(page).locator('[data-wm-lane="cooling"] .wiki-wm-tile[data-effort-id="away"] .wiki-wm-partof')).toHaveText("part of moves work");
  await expect(boardCard(page).locator('[data-wm-lane="you"] .wiki-wm-tile[data-effort-id="waiting"] .wiki-wm-pill.warn')).toHaveText("1 decision · 4 d");
});

test("pressing F at 1280 gives five tracks with every column's content shown, with no repaint, and Esc brings the folds back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSettled(page, BOARD);
  const card = boardCard(page);
  await expect(card.locator(".wiki-wm-tile").first()).toBeAttached();
  expect(await trackCount(page)).toBe(2);
  await card.locator(".wiki-wm-board").evaluate((el) => el.setAttribute("data-before-f", ""));
  await page.keyboard.press("f");
  await expect(page.locator(".wiki-layout.focus-mode")).toHaveCount(1);
  console.log(`board inner width at 1280 under F: ${await boardInnerWidth(page)}`);
  await expect.poll(() => trackCount(page)).toBe(5);
  expect(await columnsShown(page)).toEqual(COLUMN_IDS);
  await expect(card.locator("[data-before-f]")).toHaveCount(1);
  await expectNoOverflow(page, "under F");
  // A folded column's own state is untouched, and its head reads as a heading.
  await expect(card.locator('[data-wm-lane="quiet"]')).not.toHaveAttribute("open", "");
  const head = card.locator('[data-wm-lane="quiet"] > summary');
  expect(await head.evaluate((el) => getComputedStyle(el).display)).toBe("flex");
  await head.click({ force: true });
  await expect(card.locator('[data-wm-lane="quiet"]')).not.toHaveAttribute("open", "");
  await page.keyboard.press("Escape");
  await expect.poll(() => trackCount(page)).toBe(2);
  expect(await columnsShown(page)).toEqual(["you", "moving"]);
  await expect(card.locator("[data-before-f]")).toHaveCount(1);
});

test("a resize across the five-track width folds and unfolds with no repaint", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await openSettled(page, BOARD);
  const card = boardCard(page);
  await expect(card.locator(".wiki-wm-tile").first()).toBeAttached();
  expect(await columnsShown(page)).toEqual(COLUMN_IDS);
  await card.locator(".wiki-wm-board").evaluate((el) => el.setAttribute("data-before-resize", ""));
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(() => columnsShown(page)).toEqual(["you", "moving"]);
  await expect(card.locator("[data-before-resize]")).toHaveCount(1);
});

// Fix round 1 batch 3: where the columns land beside a tall Waiting on you.
const COL_GAP = 10;

/** Each column's box against the board's top-left, and where its own content ends. */
async function boardGeometry(page: Page) {
  return boardCard(page).locator(".wiki-wm-board").evaluate((board) => {
    const b = board.getBoundingClientRect();
    const cols = Array.from(board.querySelectorAll("details.wiki-wm-col")).map((c) => {
      const r = c.getBoundingClientRect();
      const kids = Array.from(c.children).filter((k) => k.tagName === "SUMMARY" || k.checkVisibility());
      return { id: c.getAttribute("data-wm-lane")!, left: r.left - b.left, top: r.top - b.top, bottom: r.bottom - b.top, slack: r.bottom - Math.max(...kids.map((k) => k.getBoundingClientRect().bottom)) };
    });
    return { height: b.height, cols: Object.fromEntries(cols.map((c) => [c.id, c])) };
  });
}

/** Waiting on you alone in the first track (tracks > 1), from 3 tracks Moving alone in
 *  the second, the rest row by row in the others, each row a gap below the tallest box
 *  above it, and nothing under the last. */
async function expectBoardLayout(page: Page, tracks: number, label: string): Promise<void> {
  const g = await boardGeometry(page);
  const at = (id: string) => g.cols[id]!;
  console.log(`${label}: ${COLUMN_IDS.map((id) => `${id} ${Math.round(at(id).top)}`).join(", ")}; board ${Math.round(g.height)}`);
  expect(at("you").left, `${label}: you left`).toBeCloseTo(0, 0);
  expect(at("you").top, `${label}: you top`).toBeCloseTo(0, 0);
  const spans = tracks >= 3 ? 2 : tracks > 1 ? 1 : 0;
  if (spans === 2) {
    expect(at("moving").top, `${label}: moving top`).toBeCloseTo(0, 0);
    expect(at("moving").left, `${label}: moving beside Waiting on you`).toBeGreaterThan(0);
  }
  const flowing = COLUMN_IDS.slice(spans);
  const inRows = tracks === 1 ? COLUMN_IDS.map((id) => [id]) : chunk(flowing, tracks - spans);
  let top = 0;
  for (const row of inRows) {
    for (const id of row) expect(Math.abs(at(id).top - top), `${label}: ${id} top ${at(id).top}, wanted ${top}`).toBeLessThanOrEqual(1);
    if (spans) for (const id of row) expect(at(id).left, `${label}: ${id} beside the spanning columns`).toBeGreaterThan(at(COLUMN_IDS[spans - 1]!).left);
    top = Math.max(...row.map((id) => at(id).bottom)) + COL_GAP;
  }
  const lowest = Math.max(...COLUMN_IDS.map((id) => at(id).bottom));
  expect(Math.abs(g.height - lowest), `${label}: board ${g.height}, lowest column ${lowest}`).toBeLessThanOrEqual(1);
  // A column ends where its content does (a tile's own bottom margin is inside it).
  for (const id of COLUMN_IDS) expect(at(id).slack, `${label}: ${id} is stretched`).toBeLessThanOrEqual(9);
}

function chunk<T>(xs: readonly T[], n: number): T[][] {
  return Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));
}

for (const [label, width, f, tracks] of [
  ["1280", 1280, false, 2],
  ["1512", 1512, false, 3],
  ["1728", 1728, false, 4],
  ["1920", 1920, false, 5],
  ["1280 under F", 1280, true, 5],
  ["800 under F", 800, true, 3],
  ["700", 700, false, 1],
] as const) {
  test(`beside a tall Waiting on you at ${label}, the other columns land right under each other`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSettled(page, BOARD_TALL);
    await expect(boardCard(page).locator(".wiki-wm-tile").first()).toBeAttached();
    if (f) {
      await page.keyboard.press("f");
      await expect.poll(() => trackCount(page)).toBe(tracks);
    }
    expect(await trackCount(page)).toBe(tracks);
    await expectBoardLayout(page, tracks, `tall ${label}`);
    await expectNoOverflow(page, label);
  });
}

for (const [width, tracks] of [[1280, 2], [1512, 3], [1728, 4], [700, 1]] as const) {
  test(`at ${width}, a Waiting on you the reader folds leaves no gap`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSettled(page, BOARD_TALL);
    const you = boardCard(page).locator('[data-wm-lane="you"]');
    await you.locator("> summary").click();
    await expect(you).not.toHaveAttribute("open", "");
    await expectBoardLayout(page, tracks, `folded ${width}`);
  });
  test(`at ${width}, an empty Waiting on you leaves no gap`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSettled(page, BOARD_NO_WAIT);
    await expect(boardCard(page).locator('[data-wm-lane="you"] .wiki-wm-col-none')).toBeVisible();
    await expectBoardLayout(page, tracks, `empty ${width}`);
  });
}

/** The tall map's Moving emptied: every effort that lands there is gone from the GET. */
async function dropMovingEfforts(page: Page): Promise<void> {
  await page.route("**/api/wiki/work-map?*", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { map: { efforts: { id: string }[] } } & Record<string, unknown>;
    const out = new Set(["kids", "kid-two", "kid-long", "kid-idle", "moving-a", "moving-b"]);
    await route.fulfill({ json: { ...body, map: { ...body.map, efforts: body.map.efforts.filter((e) => !out.has(e.id)) } } });
  });
}

// Fix round 2: at 3 and 4 tracks a tall Moving spans the rows too.
for (const [width, tracks] of [[1280, 2], [1512, 3], [1728, 4], [1920, 5]] as const) {
  // Shut by script: at 1920 no head can shut it, so a shut fold there comes from a narrower window.
  test(`at ${width}, a Moving with its fold shut leaves no gap`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSettled(page, BOARD_TALL);
    const moving = boardCard(page).locator('[data-wm-lane="moving"]');
    await moving.evaluate((el: HTMLDetailsElement) => (el.open = false));
    await expect(moving).not.toHaveAttribute("open", "");
    await expectBoardLayout(page, tracks, `moving folded ${width}`);
  });
  test(`at ${width}, an empty Moving leaves no gap`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await dropMovingEfforts(page);
    await openSettled(page, BOARD_TALL);
    await expect(boardCard(page).locator('[data-wm-lane="moving"] .wiki-wm-col-none')).toBeAttached();
    await expectBoardLayout(page, tracks, `moving empty ${width}`);
  });
}

for (const [boardWidth, tracks] of [[619, 2], [620, 3], [829, 3], [830, 4], [1039, 4], [1040, 5]] as const) {
  test(`on a ${boardWidth} px board, ${tracks} tracks with the columns landing right under each other`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 });
    await openSettled(page, BOARD_TALL);
    const board = boardCard(page).locator(".wiki-wm-board");
    await board.evaluate((el, w) => (el.style.width = `${w}px`), boardWidth);
    expect(await boardInnerWidth(page)).toBe(boardWidth);
    expect(await trackCount(page)).toBe(tracks);
    await expectBoardLayout(page, tracks, `board ${boardWidth}`);
  });
}

for (const [width, tracks] of [[1512, 3], [1728, 4]] as const) {
  test(`at ${width}, Cooling the reader opens keeps Quiet and Shipped right under the row above`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSettled(page, BOARD_TALL);
    const cooling = boardCard(page).locator('[data-wm-lane="cooling"]');
    await cooling.locator("> summary").click();
    await expect(cooling).toHaveAttribute("open", "");
    expect(await columnsShown(page)).toEqual(["you", "moving", "cooling"]);
    await expectBoardLayout(page, tracks, `cooling open ${width}`);
  });
}

for (const width of [600, 420]) {
  test(`at a ${width} window the track fits the board, however narrow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSettled(page, BOARD_TALL);
    const cols = boardCard(page).locator(".wiki-wm-cols");
    await expect(boardCard(page).locator(".wiki-wm-tile").first()).toBeAttached();
    const r = await cols.evaluate((el) => {
      const right = el.getBoundingClientRect().right;
      return {
        board: el.getBoundingClientRect().width,
        tracks: getComputedStyle(el).gridTemplateColumns.split(" ").map(parseFloat),
        past: Array.from(el.querySelectorAll("*")).filter((k) => k.getClientRects().length > 0 && k.getBoundingClientRect().right > right + 0.5).map((k) => k.getAttribute("class")),
      };
    });
    console.log(`window ${width}: board ${r.board}, tracks ${r.tracks.join(" ")}`);
    expect(r.tracks).toHaveLength(1);
    expect(r.tracks[0]!).toBeLessThanOrEqual(r.board + 0.5);
    // At 420 the page leaves the card no width at all, so there is nothing to hold it to.
    if (r.board > 0) expect(r.past).toEqual([]);
  });
}

for (const column of [200, 245, 500]) {
  test(`a compact row in a ${column} px column is two lines: name and sparkline, then pills`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSettled(page, BOARD_TALL);
    const card = boardCard(page);
    await expect(card.locator('.wiki-wm-kid[data-effort-id="kid-two"]')).toBeAttached();
    const rows = await card.locator(".wiki-wm-cols").evaluate((grid, column) => {
      (grid as HTMLElement).style.gridTemplateColumns = `${column}px`;
      return Array.from(grid.querySelectorAll<HTMLElement>(".wiki-wm-kid")).map((row, i, all) => {
        const box = (sel: string) => row.querySelector(sel)!.getBoundingClientRect();
        const name = row.querySelector<HTMLElement>(".wiki-wm-effort-name")!;
        const before = all[i - 1];
        return {
          id: row.dataset.effortId!,
          h: row.getBoundingClientRect().height,
          right: row.getBoundingClientRect().right,
          name: box(".wiki-wm-effort-name"),
          text: name.textContent,
          title: name.title,
          clipped: name.scrollWidth > name.clientWidth,
          spark: box("svg.wiki-wm-spark"),
          pills: box(".wiki-wm-pills"),
          pillCount: row.querySelectorAll(".wiki-wm-pill").length,
          rule: getComputedStyle(row).borderTopStyle + " " + getComputedStyle(row).borderTopWidth,
          ruleColor: getComputedStyle(row).borderTopColor,
          gapAbove: before ? box(".wiki-wm-effort-name").top - before.querySelector(".wiki-wm-pills")!.getBoundingClientRect().bottom : null,
        };
      });
    }, column);
    console.log(`compact row at ${column}: ${rows.map((r) => `${r.id} ${r.h.toFixed(1)} (${r.pillCount} pills)`).join(", ")}`);
    expect(rows.map((r) => r.id).sort()).toEqual(["kid-idle", "kid-long", "kid-two"]);
    expect(rows.find((r) => r.id === "kid-two")!.pillCount).toBe(2);
    for (const r of rows) {
      expect(r.h, `${r.id} height`).toBeLessThanOrEqual(46);
      expect(r.name.height, `${r.id} name is one line`).toBeLessThanOrEqual(20);
      expect(r.pills.height, `${r.id} pills are one line`).toBeLessThanOrEqual(20);
      expect(r.spark.width, `${r.id} sparkline width`).toBeCloseTo(56, 0);
      expect(r.spark.height, `${r.id} sparkline height`).toBeCloseTo(12, 0);
      expect(r.spark.left, `${r.id} sparkline clear of the name`).toBeGreaterThanOrEqual(r.name.right);
      expect(Math.abs(r.spark.right - r.right), `${r.id} sparkline ends the line`).toBeLessThanOrEqual(1);
      expect(r.spark.bottom, `${r.id} sparkline above the pills`).toBeLessThanOrEqual(r.pills.top);
      expect(r.title, `${r.id} keeps its whole name`).toBe(r.text);
    }
    if (column <= 245) expect(rows.find((r) => r.id === "kid-long")!.clipped).toBe(true);
    // Rows read apart: a rule between them, and air from the pills above to the next name.
    const ruled = await token(page, "--border-secondary");
    expect(rows[0]!.rule, "no rule above the first row").toBe("none 0px");
    for (const r of rows.slice(1)) {
      expect(r.rule, `${r.id} rule`).toBe("solid 1px");
      expect(r.ruleColor, `${r.id} rule colour`).toBe(ruled);
      expect(r.gapAbove!, `${r.id} gap`).toBeGreaterThanOrEqual(8);
    }
  });
}

// Fix round 1 batch 2: the wide board's rules and its heads.
test("the wide board's rules all sit behind @supports selector(::details-content), and without them the folds work at 1920", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await openStart(page, BOARD);
  const card = boardCard(page);
  await expect(card.locator(".wiki-wm-tile").first()).toBeAttached();
  expect(await columnsShown(page)).toEqual(COLUMN_IDS);
  // Chromium supports the selector, so no run here is a browser without it. This
  // is the stylesheet's structure, then what such a browser does: it drops the block.
  const shape = await page.evaluate(() => {
    const out = { supported: CSS.supports("selector(::details-content)"), guarded: [] as string[], bare: [] as string[] };
    const walk = (rules: CSSRuleList, guarded: boolean, wide: boolean) => {
      for (const r of Array.from(rules)) {
        if (r instanceof CSSSupportsRule) walk(r.cssRules, guarded || r.conditionText === "selector(::details-content)", wide);
        else if (r instanceof CSSContainerRule) walk(r.cssRules, guarded, wide || (r.containerName === "wmboard" && r.containerQuery === "(min-width: 1040px)"));
        else if (r instanceof CSSMediaRule) walk(r.cssRules, guarded, wide);
        else if (wide && r instanceof CSSStyleRule) (guarded ? out.guarded : out.bare).push(r.selectorText);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try { rules = sheet.cssRules; } catch { /* a cross-origin sheet */ }
      if (rules) walk(rules, false, false);
    }
    return out;
  });
  expect(shape.supported).toBe(true);
  expect(shape.bare).toEqual([]);
  expect(shape.guarded.sort()).toEqual([".wiki-wm-col > summary", ".wiki-wm-col::details-content"]);
  await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null;
      try { rules = sheet.cssRules; } catch { /* a cross-origin sheet */ }
      if (!rules) continue;
      for (let i = rules.length - 1; i >= 0; i--) {
        const r = rules[i];
        if (r instanceof CSSSupportsRule && r.conditionText === "selector(::details-content)") sheet.deleteRule(i);
      }
    }
  });
  expect(await columnsShown(page)).toEqual(["you", "moving"]);
  await card.locator('[data-wm-lane="cooling"] > summary').click();
  await expect(card.locator('[data-wm-lane="cooling"]')).toHaveAttribute("open", "");
  expect(await columnsShown(page)).toEqual(["you", "moving", "cooling"]);
});

/** What Chromium's accessibility tree says of the board's columns. */
async function columnsInAxTree(page: Page): Promise<{ groups: string[]; triangles: string[] }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Accessibility.enable");
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  await cdp.detach();
  const named = (role: string) =>
    nodes
      .filter((n) => !n.ignored && n.role?.value === role)
      .map((n) => String(n.name?.value ?? ""))
      .filter((name) => /^(waiting on you|moving|cooling|quiet|shipped) \d+$/i.test(name));
  return { groups: named("group"), triangles: named("DisclosureTriangle") };
}

const COLUMN_NAMES = ["Waiting on you 3", "Moving 3", "Cooling 1", "Quiet 1", "Shipped 1"];

test("from 1040 px Tab goes link to link and no key flips a fold; at 1280 a head focuses and Enter opens it", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await openSettled(page, BOARD);
  const card = boardCard(page);
  const links = card.locator(".wiki-wm-board a");
  const total = await links.count();
  expect(total).toBeGreaterThan(5);
  await links.first().focus();
  const stops: string[] = [];
  for (let i = 1; i < total; i++) {
    await page.keyboard.press("Tab");
    stops.push(await page.evaluate(() => document.activeElement!.tagName));
  }
  expect(stops).toEqual(Array(total - 1).fill("A"));
  // A head takes no focus even when asked, so Enter and Space have nothing to flip.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  for (const [id, key] of [["you", "Enter"], ["cooling", "Space"]] as const) {
    const head = card.locator(`[data-wm-lane="${id}"] > summary`);
    await head.focus();
    await expect(head).not.toBeFocused();
    expect(await head.getAttribute("tabindex")).toBeNull();
    await page.keyboard.press(key);
  }
  await expect(card.locator('[data-wm-lane="you"]')).toHaveAttribute("open", "");
  await expect(card.locator('[data-wm-lane="cooling"]')).not.toHaveAttribute("open", "");
  // The tree names each column and holds no collapsed triangle.
  expect(await columnsInAxTree(page)).toEqual({ groups: COLUMN_NAMES, triangles: [] });
  // At 1280 the columns fold again, and a head opens its column.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(() => columnsShown(page)).toEqual(["you", "moving"]);
  const narrow = await columnsInAxTree(page);
  expect(narrow.groups).toEqual(COLUMN_NAMES);
  expect(narrow.triangles.map((t) => t.toLowerCase())).toEqual(COLUMN_NAMES.map((n) => n.toLowerCase()));
  const head = card.locator('[data-wm-lane="cooling"] > summary');
  await head.focus();
  await expect(head).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card.locator('[data-wm-lane="cooling"]')).toHaveAttribute("open", "");
  expect(await columnsShown(page)).toEqual(["you", "moving", "cooling"]);
});

test("a column's name follows its count through a repaint", async ({ page }) => {
  const release = await holdChecks(page, () => checksBody({ needs: boardNeeds() }));
  await openStart(page, BOARD);
  const card = boardCard(page);
  await expect(card.locator('[data-wm-lane="you"]')).toHaveAttribute("aria-label", "Waiting on you 3");
  release();
  await expect(card.locator('[data-wm-lane="you"] .wiki-wm-count')).toHaveText("1");
  await expect(card.locator('[data-wm-lane="you"]')).toHaveAttribute("aria-label", "Waiting on you 1");
});

test("a head focused while the board crosses to wide lets go of focus and keeps no tabindex", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSettled(page, BOARD);
  const head = boardCard(page).locator('[data-wm-lane="cooling"] > summary');
  await head.focus();
  await page.keyboard.press("f");
  await expect(page.locator(".wiki-layout.focus-mode")).toHaveCount(1);
  await expect.poll(() => trackCount(page)).toBe(5);
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
  expect(await head.getAttribute("tabindex")).toBeNull();
});

test("a summary key saved at narrow and resolved at wide lands on the card's heading, writes no tabindex and throws nothing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSettled(page, BOARD);
  const card = boardCard(page);
  await card.locator('[data-wm-done="0"]').click();
  // One task: the head is still document.activeElement when the wide paint reads
  // its key, since the browser moves focus off an inert element only at the next frame.
  await page.evaluate(() => {
    (document.querySelector('#wikiWorkCard [data-wm-lane="cooling"] > summary') as HTMLElement).focus();
    document.querySelector(".wiki-layout")!.classList.add("focus-mode");
    (document.getElementById("wikiWorkMapRestore") as HTMLElement).click();
  });
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  const head = card.locator('[data-wm-lane="cooling"] > summary');
  await expect(head).not.toBeFocused();
  expect(await head.getAttribute("tabindex")).toBeNull();
  await expect(card.locator(".wiki-wn-title")).toBeFocused();
  await expect(card.locator(".wiki-wn-title")).not.toHaveAttribute("data-wm-parked", "");
  expect(errors).toEqual([]);
  // Back at narrow it is an ordinary head.
  await page.evaluate(() => document.querySelector(".wiki-layout")!.classList.remove("focus-mode"));
  await expect.poll(() => trackCount(page)).toBe(2);
  await head.focus();
  await expect(head).toBeFocused();
});

test("a fold the reader opens shows its content, and stays open across a repaint", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openStart(page, BOARD);
  const card = boardCard(page);
  await card.locator('[data-wm-lane="quiet"] > summary').click();
  expect(await columnsShown(page)).toEqual(["you", "moving", "quiet"]);
  await card.locator('[data-wm-done="0"]').click();
  await expect(card.locator("[data-wm-need]")).toHaveCount(1);
  await expect(card.locator('[data-wm-lane="quiet"]')).toHaveAttribute("open", "");
  expect(await columnsShown(page)).toEqual(["you", "moving", "quiet"]);
});

const boardNeeds = (): WorkMapChecksBody["needs"] => [
  { kind: "followup", title: "Merge the move", pr: 369, state: "MERGED", mergedAt: GH_MERGED_AT, asksForIt: true },
  { kind: "followup", title: "Merge the cooling", pr: 369, state: "MERGED", mergedAt: GH_MERGED_AT, asksForIt: true },
];

/** Hold the checks GET until the returned call. */
async function holdChecks(page: Page, body: () => WorkMapChecksBody): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/work-map/checks*", async (route) => {
    await held;
    await route.fulfill({ json: body() });
  });
  return release;
}

test("an effort leaves Waiting on you when the stubbed checks arrive, and goes to the column of its state", async ({ page }) => {
  const release = await holdChecks(page, () => checksBody({ needs: boardNeeds() }));
  await openStart(page, BOARD);
  const card = boardCard(page);
  const inCol = (col: string, id: string) => card.locator(`[data-wm-lane="${col}"] [data-effort-id="${id}"]`);
  await expect(inCol("you", "to-moving")).toHaveCount(1);
  await expect(inCol("you", "to-cooling")).toHaveCount(1);
  await expect(card.locator('[data-wm-lane="you"] .wiki-wm-count')).toHaveText("3");
  release();
  await expect(inCol("moving", "to-moving")).toHaveCount(1);
  await expect(inCol("cooling", "to-cooling")).toHaveCount(1);
  await expect(inCol("you", "to-moving")).toHaveCount(0);
  // The Needs you cards keep their layout and P2's marks.
  await expect(card.locator(".wiki-wm-need.gh-done")).toHaveCount(2);
  // Its wait keeps the other one there.
  await expect(card.locator('[data-wm-lane="you"] .wiki-wm-count')).toHaveText("1");
});

test("focus on an effort link follows the effort to its new open column", async ({ page }) => {
  const release = await holdChecks(page, () => checksBody({ needs: boardNeeds() }));
  await openStart(page, BOARD);
  const card = boardCard(page);
  const link = card.locator('a[data-effort-link="to-moving"]');
  await link.focus();
  await card.locator(".wiki-wm-board").evaluate((el) => el.setAttribute("data-before", ""));
  release();
  await expect(card.locator('[data-wm-lane="moving"] a[data-effort-link="to-moving"]')).toBeFocused();
  await expect(card.locator("[data-before]")).toHaveCount(0);
});

test("focus on an effort link that moves into a folded column lands on that column's head, and stays when the fold opens", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const release = await holdChecks(page, () => checksBody({ needs: boardNeeds() }));
  await openStart(page, BOARD);
  const card = boardCard(page);
  await card.locator('a[data-effort-link="to-cooling"]').focus();
  release();
  const head = card.locator('[data-wm-lane="cooling"] > summary');
  await expect(card.locator('[data-wm-lane="cooling"] [data-effort-id="to-cooling"]')).toHaveCount(1);
  await expect(head).toBeFocused();
  expect(await head.evaluate((el) => el.hasAttribute("data-wm-parked"))).toBe(false);
  await page.keyboard.press("Enter");
  await expect(card.locator('[data-wm-lane="cooling"]')).toHaveAttribute("open", "");
  // The next repaint leaves the reader on the head.
  await card.locator('[data-wm-done="0"]').click();
  await expect(card.locator('[data-wm-lane="cooling"]')).toHaveAttribute("open", "");
});

for (const native of [true, false]) {
  test(`a link that moves into a folded column stays reachable by keyboard once the fold opens, ${native ? "with no tabindex ever written to it" : "in a browser without checkVisibility"}`, async ({ page }) => {
    if (!native) await page.addInitScript(() => Reflect.deleteProperty(Element.prototype, "checkVisibility"));
    await page.setViewportSize({ width: 1280, height: 900 });
    const release = await holdChecks(page, () => checksBody({ needs: boardNeeds() }));
    await openStart(page, BOARD);
    const card = boardCard(page);
    const link = card.locator('a[data-effort-link="to-cooling"]');
    await expect(link).toBeAttached();
    expect(await page.evaluate(() => typeof Element.prototype.checkVisibility === "function")).toBe(native);
    // Every tabindex write in the card, including one taken back at once.
    await card.evaluate((el) => {
      const writes: string[] = [];
      (window as unknown as { __tabindexWrites: string[] }).__tabindexWrites = writes;
      new MutationObserver((ms) => ms.forEach((m) => writes.push((m.target as Element).getAttribute("data-effort-link") ?? (m.target as Element).tagName))).observe(el, { subtree: true, attributes: true, attributeFilter: ["tabindex"] });
    });
    await link.focus();
    release();
    const head = card.locator('[data-wm-lane="cooling"] > summary');
    await expect(card.locator('[data-wm-lane="cooling"] [data-effort-id="to-cooling"]')).toHaveCount(1);
    await expect(head).toBeFocused();
    expect(await link.getAttribute("tabindex")).toBeNull();
    if (native) expect(await page.evaluate(() => (window as unknown as { __tabindexWrites: string[] }).__tabindexWrites)).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(card.locator('[data-wm-lane="cooling"]')).toHaveAttribute("open", "");
    // Tab walks the opened fold: the column holds only what the fixture put there.
    const reached = async () => link.evaluate((el) => document.activeElement === el);
    let at = false;
    for (let i = 0; i < 4 && !at; i++) {
      await page.keyboard.press("Tab");
      at = await reached();
    }
    expect(at).toBe(true);
  });
}

test("a link that moves into a column the wide card shows keeps its focus", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  const release = await holdChecks(page, () => checksBody({ needs: boardNeeds() }));
  await openStart(page, BOARD);
  const card = boardCard(page);
  await card.locator('a[data-effort-link="to-cooling"]').focus();
  release();
  await expect(card.locator('[data-wm-lane="cooling"] [data-effort-id="to-cooling"]')).toHaveCount(1);
  await expect(card.locator('[data-wm-lane="cooling"] a[data-effort-link="to-cooling"]')).toBeFocused();
});

test("an adopt that changes nothing on the card keeps its nodes and the reader's selection", async ({ page }) => {
  await page.clock.install();
  await openSettled(page, BOARD_QUIET);
  const card = boardCard(page);
  const link = card.locator('a[data-effort-link="moves"]');
  await link.evaluate((el) => {
    (window as unknown as { __held: Element }).__held = el;
    getSelection()!.selectAllChildren(el);
  });
  const before = await card.innerHTML();
  await forceAdopt(page, BOARD_QUIET);
  // Byte-equal markup, or this test would be about a repaint that had a reason.
  expect(await card.innerHTML()).toBe(before);
  expect(await page.evaluate(() => (window as unknown as { __held: Element }).__held.isConnected)).toBe(true);
  expect(await page.evaluate(() => getSelection()!.toString())).toBe("moves work");
});

test("focus on a column's head survives the repaint that changes the column", async ({ page }) => {
  const release = await holdChecks(page, () => checksBody({ needs: boardNeeds() }));
  await openStart(page, BOARD);
  const head = boardCard(page).locator('[data-wm-lane="you"] > summary');
  await head.focus();
  release();
  await expect(boardCard(page).locator('[data-wm-lane="you"] .wiki-wm-count')).toHaveText("1");
  await expect(head).toBeFocused();
});

test("a checks answer that changes no column leaves the board alone", async ({ page }) => {
  await stubChecks(page, () => checksBody({ needs: [] }));
  await openStart(page, BOARD);
  const card = boardCard(page);
  await expect(card.locator('[data-wm-cell="github"] b')).toHaveText("0");
  await card.locator(".wiki-wm-board").evaluate((el) => el.setAttribute("data-kept", ""));
  await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  await expect(card.locator("[data-kept]")).toHaveCount(1);
});

test("✓ moves an effort out of Waiting on you, and restoring brings it back", async ({ page }) => {
  await openStart(page, BOARD);
  const card = boardCard(page);
  await card.locator('[data-wm-done="0"]').click();
  await expect(card.locator('[data-wm-lane="moving"] [data-effort-id="to-moving"]')).toHaveCount(1);
  await card.locator("#wikiWorkMapRestore").click();
  await expect(card.locator('[data-wm-lane="you"] [data-effort-id="to-moving"]')).toHaveCount(1);
});

test("an adopt that brings a page a wait moves its effort, and focus on its link follows", async ({ page }) => {
  await page.clock.install();
  await openStart(page, BOARD_ADOPT);
  const card = boardCard(page);
  await expect(card.locator('[data-wm-lane="moving"] [data-effort-id="moves"]')).toHaveCount(1);
  await card.locator('a[data-effort-link="moves"]').focus();
  await writeFile(path.join(roots[BOARD_ADOPT]!, "plans/gamma.mdx"), waitPage("Gamma plan", ["O1"], "2026-01-02"), "utf8");
  await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(card.locator('[data-wm-lane="you"] [data-effort-id="moves"]')).toHaveCount(1);
  await expect(card.locator('a[data-effort-link="moves"]')).toBeFocused();
});

for (const forced of [false, true]) {
  test(`every effort has a sparkline that fills its tile${forced ? ", under forced colors" : ""}`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 900 });
    if (forced) await page.emulateMedia({ forcedColors: "active" });
    await openSettled(page, BOARD);
    const card = boardCard(page);
    await expect(card.locator(".wiki-wm-tile").first()).toBeAttached();
    const r = await card.locator(".wiki-wm-effort").evaluateAll((efforts) =>
      efforts.map((e) => {
        const svg = e.querySelector("svg.wiki-wm-spark")!;
        const box = svg.getBoundingClientRect();
        const rects = Array.from(svg.querySelectorAll("rect"));
        const painted = rects.filter((b) => b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().height > 0).length;
        const fills = new Set(rects.map((b) => getComputedStyle(b).fill));
        const inner = e.getBoundingClientRect().width;
        return { id: e.getAttribute("data-effort-id"), role: svg.getAttribute("role"), label: svg.getAttribute("aria-label"), bars: rects.length, painted, fills: [...fills], share: box.width / inner, h: box.height };
      }),
    );
    expect(r.length).toBe(9);
    for (const s of r) {
      expect(s, `${s.id}`).toMatchObject({ role: "img", label: "Activity, last 28 days", bars: 28, painted: 28 });
      // A compact row's sparkline shares a line with the name, at a fixed width.
      if (s.id !== "sub") expect(s.share, `${s.id}`).toBeGreaterThan(0.75);
    }
    const moves = r.find((s) => s.id === "moves")!;
    const none = r.find((s) => s.id === "still")!;
    expect(none.fills).toHaveLength(1);
    expect(moves.fills).toHaveLength(2);
    if (forced) {
      const system = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.color = "CanvasText";
        document.body.append(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      });
      expect(moves.fills).toContain(system);
      // The bar must not sit on the tile in its own colour.
      const tile = await card.locator('.wiki-wm-tile[data-effort-id="moves"]').evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(moves.fills.every((f) => f !== tile)).toBe(true);
    }
  });
}

test("the health strip's cells count the live listing, and the listing says the same", async ({ page }) => {
  const listing = (await (await page.request.get(`${BASE}/api/wiki/pages?wiki=${STRIP}`)).json()) as {
    waitsCounted: boolean;
    pages: { relPath: string; movesWaiting?: number; waitingSince?: string }[];
  };
  expect(listing.waitsCounted).toBe(true);
  const at = (rel: string) => listing.pages.find((p) => p.relPath === rel)!;
  expect(at("plans/two.mdx").movesWaiting).toBe(2);
  expect(at("plans/other.mdx").movesWaiting).toBeUndefined();
  await openStart(page, STRIP);
  const cell = (name: string) => page.locator(`#wikiWorkCard [data-wm-cell="${name}"]`);
  await expect(page.locator("#wikiWorkCard .wiki-wm-cell")).toHaveCount(4);
  await expect(cell("decisions").locator("b")).toHaveText("14");
  await expect(cell("decisions")).toHaveClass(/\bwarn\b/);
  await expect(cell("oldest").locator("b")).toHaveText(/^(28|29|30) d$/);
  await expect(cell("oldest")).toHaveClass(/\bwarn\b/);
  await expect(cell("steps").locator("b")).toHaveText("3");
  await expect(cell("shipped").locator("b")).toHaveText("1");
  await expect(cell("shipped")).toHaveClass(/\bmuted\b/);
  // The layout of the prototype's Proposed view: the strip opens the card, in one row at this width.
  const boxes = await page.locator("#wikiWorkCard .wiki-wm-cell").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  expect(new Set(boxes).size).toBe(1);
});

test("a cell opens its list, oldest first, and +N more expands it", async ({ page }) => {
  await openStart(page, STRIP);
  const card = page.locator("#wikiWorkCard");
  const rows = card.locator(".wiki-wm-drill-row");
  await expect(rows).toHaveCount(0);
  await card.locator('[data-wm-cell="decisions"]').click();
  await expect(card.locator('[data-wm-cell="decisions"]')).toHaveAttribute("aria-expanded", "true");
  await expect(rows).toHaveCount(8);
  await expect(rows.first()).toContainText("Wait 1");
  await expect(rows.first()).toContainText(/· 1 · since \d{4}-\d{2}-\d{2} · \d+ d/);
  await expect(card.locator("[data-wm-drill-more]")).toHaveText("+5 more");
  await card.locator("[data-wm-drill-more]").click();
  await expect(rows).toHaveCount(13);
  await expect(card.locator("[data-wm-drill-more]")).toHaveCount(0);
  // Focus lands on the first row the button hid, not on the document.
  expect(await page.evaluate(() => document.activeElement?.closest(".wiki-wm-drill-row")?.textContent ?? "")).toContain("Wait 9");
  await expect(rows.filter({ hasText: "Two asks" })).toContainText("· 2 ·");
  await expect(card.locator(".wiki-wm-drill")).not.toContainText("Other group");
  await expect(card.locator(".wiki-wm-drill")).not.toContainText("Dropped");
  // Another cell swaps the list and folds it again; its own cell closes it.
  await card.locator('[data-wm-cell="steps"]').click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Steps");
  await card.locator('[data-wm-cell="steps"]').click();
  await expect(rows).toHaveCount(0);
  // A row opens its page.
  await card.locator('[data-wm-cell="shipped"]').click();
  await rows.first().locator("a").click();
  await expect(page).toHaveURL(/relPath=plans%2Floop\.mdx/);
});

test("a wiki that takes no answers reads «owner not set» in both wait cells", async ({ page }) => {
  const listing = (await (await page.request.get(`${BASE}/api/wiki/pages?wiki=${STRIP_OFF}`)).json()) as { waitsCounted: boolean };
  expect(listing.waitsCounted).toBe(false);
  await openStart(page, STRIP_OFF);
  const card = page.locator("#wikiWorkCard");
  for (const name of ["decisions", "oldest"]) {
    await expect(card.locator(`[data-wm-cell="${name}"] b`)).toHaveText("owner not set");
    await expect(card.locator(`[data-wm-cell="${name}"]`)).toBeDisabled();
  }
  await expect(card.locator('[data-wm-cell="steps"] b')).toHaveText("3");
});

test("an adopt repaints the strip's count, keeping the open list", async ({ page }) => {
  await page.clock.install();
  await openStart(page, STRIP_GROW);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator('[data-wm-cell="decisions"] b')).toHaveText("1");
  await card.locator('[data-wm-cell="decisions"]').click();
  await expect(card.locator(".wiki-wm-drill-row")).toHaveCount(1);
  await writeFile(path.join(roots[STRIP_GROW]!, "plans/second.mdx"), waitPage("Second wait", ["O1"], "2026-01-02"), "utf8");
  await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#wikiList")).toContainText("Second wait");
  await expect(card.locator('[data-wm-cell="decisions"] b')).toHaveText("2");
  await expect(card.locator(".wiki-wm-drill-row")).toHaveCount(2);
});

/** A wait lands and an adopt takes it: the strip's key moves, so the card repaints. */
async function adoptNewWait(page: Page, wiki: string): Promise<void> {
  await writeFile(path.join(roots[wiki]!, "plans/new-wait.mdx"), waitPage("New wait", ["O1"], "2026-01-02"), "utf8");
  await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#wikiList")).toContainText("New wait");
}

test("focus on a cell survives an adopt that repaints the strip", async ({ page }) => {
  await page.clock.install();
  await openStart(page, STRIP_KEEP_CELL);
  const cell = page.locator('#wikiWorkCard [data-wm-cell="decisions"]');
  await expect(cell.locator("b")).toHaveText("14");
  await cell.focus();
  await adoptNewWait(page, STRIP_KEEP_CELL);
  await expect(cell.locator("b")).toHaveText("15");
  await expect(cell).toBeFocused();
});

test("focus on +N more survives an adopt that repaints the strip", async ({ page }) => {
  await page.clock.install();
  await openStart(page, STRIP_KEEP_MORE);
  const card = page.locator("#wikiWorkCard");
  await card.locator('[data-wm-cell="decisions"]').click();
  const more = card.locator("[data-wm-drill-more]");
  await expect(more).toHaveText("+5 more");
  await more.focus();
  await adoptNewWait(page, STRIP_KEEP_MORE);
  await expect(more).toHaveText("+6 more");
  await expect(more).toBeFocused();
});

test("an expanded list stays expanded across an adopt that repaints the strip", async ({ page }) => {
  await page.clock.install();
  await openStart(page, STRIP_KEEP_OPEN);
  const card = page.locator("#wikiWorkCard");
  const rows = card.locator(".wiki-wm-drill-row");
  await card.locator('[data-wm-cell="decisions"]').click();
  await card.locator("[data-wm-drill-more]").click();
  await expect(rows).toHaveCount(13);
  await adoptNewWait(page, STRIP_KEEP_OPEN);
  await expect(rows).toHaveCount(14);
  await expect(card.locator("[data-wm-drill-more]")).toHaveCount(0);
});

const GH_MERGED_AT = "2026-10-29T12:00:00Z";

function checksBody(over: Partial<WorkMapChecksBody> = {}): WorkMapChecksBody {
  return { at: Date.now(), checked: 5, compared: 0, unchecked: 0, unlinked: 0, skipped: 0, contradictions: [], prs: {}, needs: [], uncheckedRows: [], unlinkedRows: [], ...over };
}

const GH_NEEDS: WorkMapChecksBody["needs"] = [
  { kind: "followup", title: "Merge the fix", pr: 369, state: "MERGED", mergedAt: GH_MERGED_AT, asksForIt: true },
  { kind: "followup", title: "Closed one", pr: 12, state: "CLOSED", mergedAt: null, asksForIt: true },
  { kind: "followup", title: "Only mentions", pr: 3556, state: "MERGED", mergedAt: "2026-10-28T12:00:00Z", asksForIt: false },
  { kind: "followup", title: "Asks for two", pr: 1, state: "MERGED", mergedAt: GH_MERGED_AT, asksForIt: true },
  { kind: "followup", title: "Asks for two", pr: 2, state: "OPEN", mergedAt: null, asksForIt: true },
];

/** The client's `WORK_CHECKS_RETRY_MS`. */
const CHECKS_RETRY_MS = 15_000;

/**
 * Stub the checks GET; returns the request count and `retry(n)`, one step of the
 * client's retry chain under a fake clock: its n-1 timers are armed, one interval
 * fires the next, and that fetch is number n.
 *
 * `count` moves when a request is SENT and the client arms its timer only after
 * reading the answer, so a `runFor` in that gap fires nothing (CI, 2026-11-03:
 * expected 4, received 3). Hence the wait on the armed timers. Install the clock first.
 */
async function stubChecks(page: Page, answer: (n: number) => WorkMapChecksBody): Promise<{ count: () => number; retry: (n: number) => Promise<void> }> {
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

test("the spec server never reaches gh: the real checks GET answers disabled and the cell is absent", async ({ page }) => {
  const res = await page.request.get(`${BASE}/api/wiki/work-map/checks?wiki=${GH}`);
  expect(((await res.json()) as WorkMapChecksBody).notChecked).toEqual({ reason: "disabled", repos: [] });
  await openStart(page, GH);
  await expect(page.locator("#wikiWorkCard .wiki-wm-cell")).toHaveCount(4);
  await expect(page.locator('#wikiWorkCard [data-wm-cell="github"]')).toHaveCount(0);
});

test("the fifth cell sits in one row with the others, opens its list, and the Needs you items carry their marks", async ({ page }) => {
  await stubChecks(page, () =>
    checksBody({
      contradictions: [{ page: "plans/alpha.mdx", pr: 369, repo: "acme/gears", rowState: "open", ghState: "MERGED", mergedAt: GH_MERGED_AT }],
      uncheckedRows: [{ page: "plans/beta.mdx", pr: 4, repo: "acme/gears" }],
      unlinkedRows: [{ page: "plans/gamma.mdx", label: "row with no link" }],
      needs: GH_NEEDS,
    }),
  );
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(cell.locator("b")).toHaveText("1");
  await expect(cell).toHaveClass(/\bbad\b/);
  await expect(cell).toContainText("ledger rows GitHub contradicts");
  const tops = await card.locator(".wiki-wm-cell").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  expect(tops.length).toBe(5);
  expect(new Set(tops).size).toBe(1);

  await cell.click();
  const rows = card.locator('[data-wm-drill="github"] .wiki-wm-drill-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText("Alpha plan");
  await expect(rows.nth(0)).toContainText("says open · GitHub: #369 merged 29.10");
  await expect(rows.nth(0).locator('a[href="https://github.com/acme/gears/pull/369"]')).toBeVisible();
  await card.locator('[data-wm-gh-more="unchecked"]').click();
  await expect(rows.nth(1)).toContainText("#4 not checked");
  await card.locator('[data-wm-gh-more="unlinked"]').click();
  await expect(rows.nth(2)).toContainText("row with no link: no PR link in a column the check reads");

  const item = (title: string) => card.locator(".wiki-wm-need").filter({ hasText: title });
  const struck = (l: Locator) => l.evaluate((el) => getComputedStyle(el).textDecorationLine);
  await expect(item("Merge the fix").locator(".wiki-wm-ghnote.done")).toHaveText("GitHub: #369 merged 29.10, this step is done");
  expect(await struck(item("Merge the fix").locator(".wiki-wm-action"))).toBe("line-through");
  await expect(item("Closed one").locator(".wiki-wm-ghnote.warn")).toHaveText("GitHub: #12 closed without merge");
  expect(await struck(item("Closed one").locator(".wiki-wm-action"))).toBe("none");
  await expect(item("Only mentions").locator(".wiki-wm-ghnote.info")).toHaveText("GitHub: #3556 merged 28.10");
  expect(await struck(item("Only mentions").locator(".wiki-wm-action"))).toBe("none");
  await expect(item("Asks for two").locator(".wiki-wm-ghnote")).toHaveText(["GitHub: #1 merged 29.10", "GitHub: #2 open"]);
  expect(await struck(item("Asks for two").locator(".wiki-wm-action"))).toBe("none");
  await expect(item("No PR").locator(".wiki-wm-ghnote")).toHaveCount(0);
  // A struck item keeps its ✓, and ✓ still takes it off the card.
  await item("Merge the fix").locator("[data-wm-done]").click();
  await expect(item("Merge the fix")).toHaveCount(0);
});

test("the card paints before the check answers, reads «checking…», and the answer's repaint keeps a fold and focus", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/work-map/checks*", async (route) => {
    await held;
    await route.fulfill({ json: checksBody({ needs: GH_NEEDS }) });
  });
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(card.locator(".wiki-wm-need")).toHaveCount(5);
  await expect(cell.locator("b")).toHaveText("checking…");
  await expect(cell).toHaveClass(/\bmuted\b/);
  await expect(cell).toBeDisabled();
  await expect(card.locator(".wiki-wm-ghnote")).toHaveCount(0);
  // The reader opens a closed lane, which holds focus, while it waits.
  const summary = card.locator('[data-wm-lane="cooling"] > summary');
  await summary.click();
  await expect(card.locator('[data-wm-lane="cooling"]')).toHaveAttribute("open", "");
  await summary.focus();
  await page.evaluate(() => document.querySelector("#wikiWorkCard .wiki-wm-strip")!.setAttribute("data-before-repaint", ""));
  release();
  await expect(cell.locator("b")).toHaveText("0");
  await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
  await expect(card.locator(".wiki-wm-ghnote.done")).toHaveCount(1);
  await expect(card.locator('[data-wm-lane="cooling"]')).toHaveAttribute("open", "");
  await expect(summary).toBeFocused();
});

test("«refreshing» shows the count and the marks it has, and three more fetches end it with «N not checked»", async ({ page }) => {
  await page.clock.install();
  const stub = await stubChecks(page, (n) => checksBody({ refreshing: true, unchecked: 3, uncheckedRows: [{ page: "plans/beta.mdx", pr: 4, repo: "acme/gears" }], needs: GH_NEEDS, checked: n }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(cell).toContainText("refreshing");
  await expect(cell).not.toContainText("not checked");
  await expect(cell.locator("b")).toHaveText("0");
  await expect(card.locator(".wiki-wm-ghnote.done")).toHaveCount(1);
  expect(stub.count()).toBe(1);
  for (const n of [2, 3, 4]) await stub.retry(n);
  await expect(cell).toContainText("3 not checked");
  await expect(cell).not.toContainText("refreshing");
  await page.clock.runFor(60_000);
  await page.waitForTimeout(100);
  expect(stub.count()).toBe(4);
});

test("a `gh` that stays hung ends «not refreshed», muted with only merges marked, and tab clicks ask at most once a minute", async ({ page }) => {
  await page.clock.install();
  const stub = await stubChecks(page, () => checksBody({ refreshing: true, contradictions: [GH_CONTRADICTION], needs: GH_NEEDS }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(cell).toContainText("refreshing");
  await expect(card.locator(".wiki-wm-ghnote.warn")).toHaveCount(1);
  for (const n of [2, 3, 4]) await stub.retry(n);
  await expect(cell).toContainText("not refreshed");
  await expect(cell).not.toContainText("refreshing");
  await expect(cell.locator("b")).toHaveText("1");
  await expect(cell).toHaveClass(/\bmuted\b/);
  await expect(cell).not.toHaveClass(/\bbad\b/);
  await expect(card.locator(".wiki-wm-ghnote.warn")).toHaveCount(0);
  await expect(card.locator(".wiki-wm-ghnote.done")).toHaveCount(1);
  const tabs = async () => {
    await page.locator('.wiki-tab[data-tab="timeline"]').click();
    await page.locator('.wiki-tab[data-tab="hubs"]').click();
    await expect(page.locator('#wikiWorkCard [data-wm-cell="github"]')).toBeVisible();
  };
  await tabs();
  await tabs();
  await page.waitForTimeout(100);
  expect(stub.count()).toBe(4);
  await page.clock.runFor(60_000);
  await tabs();
  await expect.poll(() => stub.count()).toBe(5);
});

test("«refreshing» that settles stops the fetches at once", async ({ page }) => {
  await page.clock.install();
  const stub = await stubChecks(page, (n) => checksBody(n === 1 ? { refreshing: true } : {}));
  await openStart(page, GH);
  const cell = page.locator('#wikiWorkCard [data-wm-cell="github"]');
  await expect(cell).toContainText("refreshing");
  await page.clock.runFor(15_000);
  await expect(cell).not.toContainText("refreshing");
  await page.clock.runFor(60_000);
  await page.waitForTimeout(100);
  expect(stub.count()).toBe(2);
});

for (const [reason, text] of [
  ["no-gh", "not checked: install gh"],
  ["auth", "not checked: log in with gh auth login"],
  ["sso", "not checked: authorize the token for the organization (gh auth refresh)"],
  ["no-access", "not checked: your gh login cannot see acme/gears (gh auth status)"],
] as const) {
  test(`notChecked ${reason} reads «${text}» and the other repos' counts still show`, async ({ page }) => {
    await stubChecks(page, () =>
      checksBody({
        checked: 2,
        unchecked: 1,
        notChecked: { reason, repos: ["acme/gears"] },
        contradictions: [{ page: "plans/alpha.mdx", pr: 369, repo: "acme/other", rowState: "open", ghState: "CLOSED", mergedAt: null }],
        uncheckedRows: [{ page: "plans/beta.mdx", pr: 4, repo: "acme/gears" }],
      }),
    );
    await openStart(page, GH);
    const card = page.locator("#wikiWorkCard");
    const cell = card.locator('[data-wm-cell="github"]');
    await expect(cell).toContainText(text);
    await expect(cell.locator("b")).toHaveText("1");
    // Its long remedy takes a row of its own, with no word broken.
    expect((await stripLayout(page)).broken).toEqual([]);
    const boxes = await card.locator(".wiki-wm-cell").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })));
    expect(new Set(boxes.slice(0, 4).map((b) => b.top)).size).toBe(1);
    expect(boxes[4]!.top).toBeGreaterThanOrEqual(boxes[0]!.bottom);
    // Four across, filling the row, with the remedy under them at full width.
    const strip = (await card.locator(".wiki-wm-strip").boundingBox())!;
    const edges = await card.locator(".wiki-wm-cell").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ right: r.right, width: r.width })));
    expect(Math.abs(edges[3]!.right - (strip.x + strip.width))).toBeLessThan(1);
    expect(Math.abs(edges[4]!.width - strip.width)).toBeLessThan(1);
    await cell.click();
    await expect(card.locator('[data-wm-drill="github"]')).toContainText("closed without merge");
  });
}

/**
 * The strip as laid out. `rows` holds the cell widths per rendered row; a `.wide`
 * cell spans its row and is left out of `narrow`. `broken` names each word whose
 * box spans two lines or leaves its cell: `scrollWidth` cannot show this, since
 * a word that may break never overflows.
 */
async function stripLayout(page: Page): Promise<{ rows: number[][]; narrow: number[]; broken: string[] }> {
  return page.locator("#wikiWorkCard .wiki-wm-strip").evaluate((strip) => {
    const rows = new Map<number, number[]>();
    const narrow: number[] = [];
    const broken: string[] = [];
    for (const cell of Array.from(strip.querySelectorAll<HTMLElement>(".wiki-wm-cell"))) {
      const box = cell.getBoundingClientRect();
      const top = Math.round(box.top);
      rows.set(top, [...(rows.get(top) ?? []), box.width]);
      if (!cell.classList.contains("wide")) narrow.push(box.width);
      const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        // A hyphen is a line-break opportunity, not a word's middle.
        for (const m of n.textContent!.matchAll(/[^\s-]+/g)) {
          const range = document.createRange();
          range.setStart(n, m.index);
          range.setEnd(n, m.index + m[0].length);
          const rects = Array.from(range.getClientRects());
          if (new Set(rects.map((r) => Math.round(r.top))).size > 1 || rects.some((r) => r.right > box.right + 0.5)) broken.push(`${m[0]} in a ${Math.round(box.width)} px cell`);
        }
      }
    }
    return { rows: [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => w), narrow, broken };
  });
}

const STRIP_WIDTHS = [1280, 1265, 1200, 900, 800, 700, 480];

// A repo name has no break of its own: only the remedy's cell may break it.
for (const [width, length] of [[1280, 100], [700, 100], [700, 50], [480, 50]] as const) {
  test(`at ${width} wide a ${length}-character repo name stays in the remedy's cell`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const repo = `acme/${"a".repeat(length - 5)}`;
    await stubChecks(page, () => checksBody({ notChecked: { reason: "no-access", repos: [repo] } }));
    await openStart(page, GH);
    const cell = page.locator('#wikiWorkCard [data-wm-cell="github"]');
    await expect(cell).toContainText(repo);
    const m = await cell.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, right: el.getBoundingClientRect().right, note: el.querySelector(".wiki-wm-cell-note")!.getBoundingClientRect().right }));
    expect(m.scroll).toBeLessThanOrEqual(m.client);
    expect(m.note).toBeLessThanOrEqual(m.right);
    // Every other word in the strip stays whole, however narrow its cell gets.
    expect((await stripLayout(page)).broken.filter((w) => !w.startsWith("acme/"))).toEqual([]);
    expect(await page.locator('#wikiWorkCard [data-wm-cell="decisions"]').evaluate((el) => getComputedStyle(el).overflowWrap)).toBe("normal");
  });
}

for (const width of STRIP_WIDTHS) {
  test(`at ${width} wide the cells are equal and no word breaks`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await stubChecks(page, () => checksBody({ checked: 2, unchecked: 3, contradictions: [GH_CONTRADICTION] }));
    await openStart(page, GH);
    const cell = page.locator('#wikiWorkCard [data-wm-cell="github"]');
    await expect(cell).toContainText("3 not checked");
    const { rows, narrow, broken } = await stripLayout(page);
    expect(narrow.length).toBe(5);
    expect(broken).toEqual([]);
    expect(Math.max(...narrow) - Math.min(...narrow)).toBeLessThan(0.5);
    if (width >= 1265) expect(rows.map((r) => r.length)).toEqual([5]);
  });
}

test("«checking…» and «refreshing» fit their cells too", async ({ page }) => {
  await page.setViewportSize({ width: 1265, height: 900 });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/work-map/checks*", async (route) => {
    await held;
    await route.fulfill({ json: checksBody({ refreshing: true }) });
  });
  await openStart(page, GH);
  const cell = page.locator('#wikiWorkCard [data-wm-cell="github"]');
  await expect(cell.locator("b")).toHaveText("checking…");
  expect((await stripLayout(page)).broken).toEqual([]);
  release();
  await expect(cell).toContainText("refreshing");
  expect((await stripLayout(page)).broken).toEqual([]);
});

const GH_UNLINKED = Array.from({ length: 197 }, (_, i) => ({ page: "plans/gamma.mdx", label: `row ${i + 1}` }));
const GH_UNCHECKED = Array.from({ length: 9 }, (_, i) => ({ page: "plans/beta.mdx", pr: 100 + i, repo: "acme/gears" }));

test("no contradictions: the list opens with a sentence and a line for the rest, and stays short", async ({ page }) => {
  await stubChecks(page, () => checksBody({ checked: 5, compared: 5, unlinked: 197, unlinkedRows: GH_UNLINKED }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(cell.locator("b")).toHaveText("0");
  const before = await card.evaluate((el) => el.getBoundingClientRect().height);
  await cell.click();
  const drill = card.locator('[data-wm-drill="github"]');
  await expect(drill.locator(".wiki-wm-drill-counts")).toContainText("5 checked");
  await expect(drill.locator(".wiki-wm-drill-counts")).toContainText("197 with no PR link read");
  await expect(drill.locator(".wiki-wm-drill-row")).toHaveCount(0);
  await expect(drill.locator('[data-wm-gh-group="contradictions"]')).toHaveCount(0);
  await expect(drill.locator('[data-wm-gh-group="unlinked"]')).toContainText("No PR link read · 197");
  await expect(drill.locator('[data-wm-gh-more="unlinked"]')).toHaveText("+197 more");
  const after = await card.evaluate((el) => el.getBoundingClientRect().height);
  expect(after - before).toBeLessThan(120);
});

test("the groups read apart, a line opens its group at the first revealed row, and +N more goes on from there", async ({ page }) => {
  await stubChecks(page, () => checksBody({ checked: 3, unchecked: 9, unlinked: 197, contradictions: [GH_CONTRADICTION, { ...GH_CONTRADICTION, pr: 370 }], uncheckedRows: GH_UNCHECKED, unlinkedRows: GH_UNLINKED }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  await card.locator('[data-wm-cell="github"]').click();
  const group = (name: string) => card.locator(`[data-wm-gh-group="${name}"]`);
  await expect(group("contradictions").locator(".wiki-wm-drill-group-head")).toHaveText("GitHub contradicts · 2");
  await expect(group("contradictions").locator(".wiki-wm-drill-row")).toHaveCount(2);
  await expect(card.locator(".wiki-wm-drill-counts")).toContainText("3 checked · ");
  await expect(group("unchecked").locator(".wiki-wm-drill-group-head")).toContainText("Not checked · 9");
  await expect(group("unchecked").locator(".wiki-wm-drill-row")).toHaveCount(0);
  await expect(group("unlinked").locator(".wiki-wm-drill-row")).toHaveCount(0);
  const heads = await card.locator(".wiki-wm-drill-group-head").evaluateAll((els) => els.map((e) => getComputedStyle(e).color));
  expect(heads[0]).not.toBe(heads[1]);

  const focusRow = () => page.evaluate(() => document.activeElement?.closest(".wiki-wm-drill-row")?.textContent ?? "");
  const more = card.locator('[data-wm-gh-more="unlinked"]');
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(group("unlinked").locator(".wiki-wm-drill-row")).toHaveCount(8);
  expect(await focusRow()).toContain("row 1:");
  // The other group stays shut.
  await expect(group("unchecked").locator(".wiki-wm-drill-row")).toHaveCount(0);
  await expect(more).toHaveText("+189 more");
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(group("unlinked").locator(".wiki-wm-drill-row")).toHaveCount(197);
  expect(await focusRow()).toContain("row 9:");
  await expect(more).toHaveCount(0);
  // Shutting the list folds the groups again.
  await card.locator('[data-wm-cell="github"]').click();
  await card.locator('[data-wm-cell="github"]').click();
  await expect(group("unlinked").locator(".wiki-wm-drill-row")).toHaveCount(0);
});

test("focus stays on a GitHub link, a group's line and its +N more across a checks repaint", async ({ page }) => {
  await page.clock.install();
  // Each answer differs, so each repaints: the marker below goes with the old DOM.
  const stub = await stubChecks(page, (n) => checksBody({ refreshing: true, checked: n, contradictions: [GH_CONTRADICTION, { ...GH_CONTRADICTION, pr: 370 }], uncheckedRows: GH_UNCHECKED, unlinkedRows: GH_UNLINKED }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  await card.locator('[data-wm-cell="github"]').click();
  const repaint = async (n: number) => {
    await page.evaluate(() => document.querySelector("#wikiWorkCard .wiki-wm-strip")!.setAttribute("data-before-repaint", ""));
    await stub.retry(n);
    await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
  };
  const link = card.locator('a[href="https://github.com/acme/gears/pull/370"]');
  await link.focus();
  await repaint(2);
  await expect(link).toBeFocused();
  const line = card.locator('[data-wm-gh-more="unchecked"]');
  await line.focus();
  await repaint(3);
  await expect(line).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card.locator('[data-wm-gh-group="unchecked"] .wiki-wm-drill-row')).toHaveCount(8);
  await expect(line).toHaveText("+1 more");
  await line.focus();
  await repaint(4);
  await expect(line).toBeFocused();
});

test("focus on the second link to one PR comes back to the second", async ({ page }) => {
  await page.clock.install();
  const stub = await stubChecks(page, (n) => checksBody({ refreshing: true, checked: n, contradictions: [GH_CONTRADICTION, { ...GH_CONTRADICTION, page: "plans/beta.mdx" }] }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  await card.locator('[data-wm-cell="github"]').click();
  const links = card.locator('a[href="https://github.com/acme/gears/pull/369"]');
  await expect(links).toHaveCount(2);
  await links.nth(1).focus();
  await stub.retry(2);
  await expect(card.locator('[data-wm-cell="github"]')).toHaveAttribute("title", /^2 checked/);
  await expect(links.nth(1)).toBeFocused();
});

test("a checks answer that changes nothing leaves the DOM and a selection alone", async ({ page }) => {
  await page.clock.install();
  const stub = await stubChecks(page, () => checksBody({ refreshing: true, contradictions: [GH_CONTRADICTION] }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(cell).toContainText("refreshing");
  await page.evaluate(() => {
    document.querySelector("#wikiWorkCard .wiki-wm-strip")!.setAttribute("data-before-repaint", "");
    const r = document.createRange();
    r.selectNodeContents(document.querySelector("#wikiWorkCard .wiki-wm-need-title")!);
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
  });
  const selected = await page.evaluate(() => getSelection()!.toString());
  expect(selected.length).toBeGreaterThan(0);
  await stub.retry(2);
  await page.waitForTimeout(100);
  await expect(card.locator("[data-before-repaint]")).toHaveCount(1);
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(selected);
  // The last fetch ends the suffix: that one is a change, and paints.
  await stub.retry(3);
  await stub.retry(4);
  await expect(cell).not.toContainText("refreshing");
  await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
});

test("a start view that comes back paints its card, though the last answer changed nothing", async ({ page }) => {
  await stubChecks(page, () => checksBody({ contradictions: [GH_CONTRADICTION] }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator('[data-wm-cell="github"] b')).toHaveText("1");
  await page.locator("#wikiList a").first().click();
  await expect(page).toHaveURL(/effort=|relPath=/);
  await page.goBack();
  await expect(card.locator('[data-wm-cell="github"] b')).toHaveText("1");
});

test("rows with no PR link read and nothing read: «—», muted, the count, and a list", async ({ page }) => {
  await stubChecks(page, () => checksBody({ checked: 0, unchecked: 0, unlinked: 197, unlinkedRows: GH_UNLINKED }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(cell.locator("b")).toHaveText("—");
  await expect(cell).toHaveClass(/\bmuted\b/);
  await expect(cell).toContainText("197 with no PR link read");
  await cell.click();
  await expect(card.locator(".wiki-wm-drill-counts")).toContainText("197 with no PR link read");
});

test("a checks GET that fails says «not checked», and a start view a minute later asks again", async ({ page }) => {
  await page.clock.install();
  let n = 0;
  await page.route("**/api/wiki/work-map/checks*", (route) => (++n === 1 ? route.fulfill({ status: 500, json: { error: "x" } }) : route.fulfill({ json: checksBody() })));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(cell).toContainText("not checked");
  await expect(cell.locator("b")).toHaveText("—");
  await card.locator('.wiki-wm-pages a[data-relpath], .wiki-wm-summary a[data-relpath]').first().click();
  await expect(page.locator(".wiki-start")).toHaveCount(0);
  await page.clock.fastForward(60_000);
  await page.goBack();
  await expect(cell.locator("b")).toHaveText("0");
  expect(n).toBe(2);
});

/** Open a page off the card, and come back. */
async function visitAndReturn(page: Page): Promise<void> {
  await page.locator("#wikiWorkCard").locator('.wiki-wm-pages a[data-relpath], .wiki-wm-summary a[data-relpath]').first().click();
  await expect(page.locator(".wiki-start")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator(".wiki-start")).toBeVisible();
}

const GH_CONTRADICTION = { page: "plans/alpha.mdx", pr: 369, repo: "acme/gears", rowState: "open", ghState: "MERGED" as const, mergedAt: GH_MERGED_AT };

test("a not refreshed answer: one line above the whole list, contradictions included, and the tooltip opens with it", async ({ page }) => {
  await page.clock.install();
  const stub = await stubChecks(page, () => checksBody({ refreshing: true, contradictions: [GH_CONTRADICTION], unlinked: 197, unlinkedRows: GH_UNLINKED }));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(cell).toContainText("refreshing");
  await expect(cell).not.toHaveAttribute("title", /^From the last answer/);
  for (const n of [2, 3, 4]) await stub.retry(n);
  await expect(cell).toContainText("not refreshed");
  await expect(cell).toHaveAttribute("title", /^From the last answer, not current · 5 checked/);
  await cell.click();
  const drill = card.locator('[data-wm-drill="github"]');
  await expect(drill.locator(":scope > *").nth(1)).toHaveText("From the last answer, not current");
  await expect(drill.locator(":scope > *").nth(2)).toHaveClass("wiki-wm-drill-counts");
  await expect(drill.locator(":scope > *").nth(3)).toHaveAttribute("data-wm-gh-group", "contradictions");
});

test("a retry that fails during «refreshing» keeps the count muted with «not checked», and the next start view asks again", async ({ page }) => {
  await page.clock.install();
  let n = 0;
  await page.route("**/api/wiki/work-map/checks*", (route) =>
    ++n === 2 ? route.fulfill({ status: 500, json: { error: "x" } }) : route.fulfill({ json: n === 1 ? checksBody({ refreshing: true, contradictions: [GH_CONTRADICTION], needs: GH_NEEDS }) : checksBody({ contradictions: [GH_CONTRADICTION], needs: GH_NEEDS }) }),
  );
  await openStart(page, GH);
  const cell = page.locator('#wikiWorkCard [data-wm-cell="github"]');
  await expect(cell).toContainText("refreshing");
  await page.clock.runFor(15_000);
  await expect(cell).toContainText("not checked");
  await expect(cell).not.toContainText("refreshing");
  await expect(cell.locator("b")).toHaveText("1");
  await expect(cell).toHaveClass(/\bmuted\b/);
  await expect(cell).not.toHaveClass(/\bbad\b/);
  // The same map's marks stay.
  await expect(page.locator("#wikiWorkCard .wiki-wm-ghnote.done")).toHaveCount(1);
  // A failure starts no loop.
  await page.clock.runFor(60_000);
  await page.waitForTimeout(100);
  expect(n).toBe(2);
  await visitAndReturn(page);
  await expect.poll(() => n).toBe(3);
  await expect(cell).not.toContainText("not checked");
  await expect(cell).toHaveClass(/\bbad\b/);
});

test("an hourly refetch that fails does not look fresh", async ({ page }) => {
  await page.clock.install();
  let n = 0;
  await page.route("**/api/wiki/work-map/checks*", (route) => (++n === 2 ? route.fulfill({ status: 500, json: { error: "x" } }) : route.fulfill({ json: checksBody({ contradictions: [GH_CONTRADICTION] }) })));
  await openStart(page, GH);
  const cell = page.locator('#wikiWorkCard [data-wm-cell="github"]');
  await expect(cell).toHaveClass(/\bbad\b/);
  await page.locator("#wikiWorkCard").locator('.wiki-wm-pages a[data-relpath], .wiki-wm-summary a[data-relpath]').first().click();
  await expect(page.locator(".wiki-start")).toHaveCount(0);
  await page.clock.fastForward(HOUR + 1_000);
  await page.goBack();
  await expect.poll(() => n).toBe(2);
  await expect(cell).toContainText("not checked");
  await expect(cell.locator("b")).toHaveText("1");
  await expect(cell).toHaveClass(/\bmuted\b/);
  await page.clock.fastForward(60_000);
  await visitAndReturn(page);
  await expect.poll(() => n).toBe(3);
  await expect(cell).toHaveClass(/\bbad\b/);
});

for (const [name, first] of [
  ["a remedy", { notChecked: { reason: "auth", repos: ["acme/gears"] } }],
  ["no access", { notChecked: { reason: "no-access", repos: ["acme/gears"] } }],
  ["rows left unchecked", { checked: 0, unchecked: 85 }],
] as [string, Partial<WorkMapChecksBody>][]) {
  test(`an answer with ${name} is asked again on the next start view, and starts no loop`, async ({ page }) => {
    await page.clock.install();
    const stub = await stubChecks(page, (n) => (n === 1 ? checksBody(first) : checksBody()));
    await openStart(page, GH);
    const cell = page.locator('#wikiWorkCard [data-wm-cell="github"]');
    await expect(cell).toContainText("not checked");
    await page.clock.runFor(60_000);
    await page.waitForTimeout(100);
    expect(stub.count()).toBe(1);
    await visitAndReturn(page);
    await expect.poll(() => stub.count()).toBe(2);
    await expect(cell).not.toContainText("not checked");
    await expect(cell.locator("b")).toHaveText("0");
    // Settled: the next visit asks nothing.
    await visitAndReturn(page);
    await page.waitForTimeout(100);
    expect(stub.count()).toBe(2);
  });
}

test("a no-access answer reads its remedy on the card", async ({ page }) => {
  await stubChecks(page, () => checksBody({ checked: 2, unchecked: 1, notChecked: { reason: "no-access", repos: ["acme/gears"] } }));
  await openStart(page, GH);
  await expect(page.locator('#wikiWorkCard [data-wm-cell="github"]')).toContainText("not checked: your gh login cannot see acme/gears (gh auth status)");
});

test("disabled is not asked again on the next start view", async ({ page }) => {
  const stub = await stubChecks(page, () => checksBody({ notChecked: { reason: "disabled", repos: [] } }));
  await openStart(page, GH);
  await expect.poll(() => stub.count()).toBe(1);
  await visitAndReturn(page);
  await page.waitForTimeout(100);
  expect(stub.count()).toBe(1);
});

test("an answer older than an hour is fetched again when the start view renders, and not before", async ({ page }) => {
  await page.clock.install();
  const stub = await stubChecks(page, () => checksBody());
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator('[data-wm-cell="github"] b')).toHaveText("0");
  const link = card.locator('.wiki-wm-pages a[data-relpath], .wiki-wm-summary a[data-relpath]').first();
  await link.click();
  await expect(page.locator(".wiki-start")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator(".wiki-start")).toBeVisible();
  await page.waitForTimeout(100);
  expect(stub.count()).toBe(1);
  await link.click();
  await expect(page.locator(".wiki-start")).toHaveCount(0);
  await page.clock.fastForward(HOUR + 1_000);
  await page.goBack();
  await expect.poll(() => stub.count()).toBe(2);
});

// ── The check's lifecycle ─────────────────────────────────────────────
const GH_REFRESHING = (): WorkMapChecksBody => checksBody({ refreshing: true, checked: 1, unchecked: 3, uncheckedRows: [{ page: "plans/beta.mdx", pr: 4, repo: "acme/gears" }] });
const CHECKS_PATH = "/api/wiki/work-map/checks";
const mapFile = (wiki: string) => path.join(roots[wiki]!, ".work-map.json");

for (const [what, wiki, late] of [
  ["An answer", GH_DROP_OK, (route: Route) => route.fulfill({ json: checksBody({ refreshing: true, contradictions: [GH_CONTRADICTION] }) })],
  ["A failure", GH_DROP_FAIL, (route: Route) => route.fulfill({ status: 500, json: { error: "x" } })],
] as const) {
  test(`${what} arriving after the card left the slot paints nothing and is dropped, and the card coming back behaves as new`, async ({ page }) => {
    await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
    let n = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/wiki/work-map/checks*", async (route) => {
      if (++n === 1) {
        await held;
        await late(route);
      } else await route.fulfill({ json: checksBody() });
    });
    await page.clock.install();
    await openStart(page, wiki);
    const card = page.locator("#wikiWorkCard");
    const wn = page.locator("#wikiWhatsNew");
    const cell = card.locator('[data-wm-cell="github"]');
    await expect(cell.locator("b")).toHaveText("checking…");
    await rm(mapFile(wiki));
    await forceAdopt(page, wiki);
    await expect(card).toBeHidden();
    await expect(wn).toContainText("Something changed");
    const landed = page.waitForResponse((r) => new URL(r.url()).pathname === CHECKS_PATH);
    release();
    await landed;
    await page.waitForTimeout(200);
    await expect(card).toBeHidden();
    await expect(wn).toBeVisible();
    // Same run time, so only the dropped answer could spare it a fetch.
    await writeFile(mapFile(wiki), mapJson(wiki, GH_DROP_RUN), "utf8");
    await forceAdopt(page, wiki);
    await expect.poll(() => n).toBe(2);
    await expect(cell.locator("b")).toHaveText("0");
    await expect(cell).not.toHaveClass(/\bmuted\b/);
    await expect(cell).not.toContainText("refreshing");
    await expect(wn).toBeHidden();
    // The late answer left no timer behind.
    await page.clock.runFor(60_000);
    await page.waitForTimeout(100);
    expect(n).toBe(2);
  });
}

test("an answer the card already has is forgotten when the card leaves the slot", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  const stub = await stubChecks(page, (n) => checksBody(n === 1 ? { contradictions: [GH_CONTRADICTION] } : {}));
  await page.clock.install();
  await openStart(page, GH_DROP_DONE);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator('[data-wm-cell="github"] b')).toHaveText("1");
  await rm(mapFile(GH_DROP_DONE));
  await forceAdopt(page, GH_DROP_DONE);
  await expect(card).toBeHidden();
  await writeFile(mapFile(GH_DROP_DONE), mapJson(GH_DROP_DONE, GH_DROP_RUN), "utf8");
  await forceAdopt(page, GH_DROP_DONE);
  await expect.poll(() => stub.count()).toBe(2);
  await expect(card.locator('[data-wm-cell="github"] b')).toHaveText("0");
});

test("an answer arriving on an article view paints nothing there, and the start view shows it with no new fetch", async ({ page }) => {
  let n = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/work-map/checks*", async (route) => {
    n++;
    await held;
    await route.fulfill({ json: checksBody({ contradictions: [GH_CONTRADICTION] }) });
  });
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator('[data-wm-cell="github"] b')).toHaveText("checking…");
  await card.locator('.wiki-wm-pages a[data-relpath], .wiki-wm-summary a[data-relpath]').first().click();
  await expect(page.locator(".wiki-start")).toHaveCount(0);
  const landed = page.waitForResponse((r) => new URL(r.url()).pathname === CHECKS_PATH);
  release();
  await landed;
  await page.waitForTimeout(100);
  await expect(card).toHaveCount(0);
  await page.goBack();
  await expect(card.locator('[data-wm-cell="github"] b')).toHaveText("1");
  expect(n).toBe(1);
});

test("start views rendered while the first fetch is in flight add no fetch", async ({ page }) => {
  let n = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/work-map/checks*", async (route) => {
    n++;
    await held;
    await route.fulfill({ json: checksBody() });
  });
  await openStart(page, GH);
  const b = page.locator('#wikiWorkCard [data-wm-cell="github"] b');
  await expect(b).toHaveText("checking…");
  await visitAndReturn(page);
  await visitAndReturn(page);
  await expect(b).toHaveText("checking…");
  release();
  await expect(b).toHaveText("0");
  await page.waitForTimeout(100);
  expect(n).toBe(1);
});

test("start views rendered during a retry chain add no fetch and no second timer", async ({ page }) => {
  await page.clock.install();
  const stub = await stubChecks(page, GH_REFRESHING);
  await openStart(page, GH);
  const cell = page.locator('#wikiWorkCard [data-wm-cell="github"]');
  // Painted after its timer is set. An unread answer re-arms on a start view, so
  // only the pending timer keeps these renders from fetching.
  await expect(cell).toContainText("refreshing");
  for (const n of [1, 2, 3]) {
    await visitAndReturn(page);
    await visitAndReturn(page);
    await expect(cell).toContainText("refreshing");
    await page.waitForTimeout(100);
    expect(stub.count()).toBe(n);
    await stub.retry(n + 1);
    await page.waitForTimeout(100);
    expect(stub.count()).toBe(n + 1);
  }
  await expect(cell).toContainText("3 not checked");
  await page.clock.runFor(60_000);
  await page.waitForTimeout(100);
  expect(stub.count()).toBe(4);
});

test("a start view rendered while a retry is in flight adds no fetch and still reads «refreshing»", async ({ page }) => {
  await page.clock.install();
  let n = 0;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/work-map/checks*", async (route) => {
    if (++n === 2) await held;
    await route.fulfill({ json: n === 1 ? GH_REFRESHING() : checksBody() });
  });
  await openStart(page, GH);
  const cell = page.locator('#wikiWorkCard [data-wm-cell="github"]');
  await expect(cell).toContainText("refreshing");
  await page.clock.runFor(15_000);
  await expect.poll(() => n).toBe(2);
  // The timer has fired, so only the fetch in flight says «refreshing» now.
  await visitAndReturn(page);
  await expect(cell).toContainText("refreshing");
  await expect(cell).not.toContainText("not checked");
  await page.waitForTimeout(100);
  expect(n).toBe(2);
  release();
  await expect(cell).not.toContainText("refreshing");
  await page.clock.runFor(60_000);
  await page.waitForTimeout(100);
  expect(n).toBe(2);
});

for (const [what, answer] of [
  ["rows left unchecked", (route: Route) => route.fulfill({ json: checksBody({ checked: 1, unchecked: 3, uncheckedRows: [{ page: "plans/beta.mdx", pr: 4, repo: "acme/gears" }] }) })],
  ["a failed GET", (route: Route) => route.fulfill({ status: 500, json: { error: "x" } })],
] as const) {
  test(`an adopt over ${what} re-arms nothing: neither it nor the next repaint fetches`, async ({ page }) => {
    let n = 0;
    await page.route("**/api/wiki/work-map/checks*", (route) => {
      n++;
      return answer(route);
    });
    await page.clock.install();
    await openStart(page, GH_ADOPT);
    const card = page.locator("#wikiWorkCard");
    await expect(card.locator('[data-wm-cell="github"]')).toContainText("not checked");
    await forceAdopt(page, GH_ADOPT);
    expect(n).toBe(1);
    // ✓ repaints the card, and a repaint is what reads a re-armed answer.
    const needs = card.locator("[data-wm-done]");
    const before = await needs.count();
    await needs.first().click();
    await expect(needs).toHaveCount(before - 1);
    await page.waitForTimeout(100);
    expect(n).toBe(1);
  });
}

test("a new map after ↻ fetches the checks at once, for its marks", async ({ page }) => {
  const stub = await stubChecks(page, () => checksBody());
  const newRun = Date.now();
  let gets = 0;
  let posted = false;
  await page.route("**/api/wiki/work-map?*", async (route) => {
    gets++;
    const res = await route.fetch();
    const body = (await res.json()) as { map: { runAtMs: number } } & Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: true, lastSuccessAt: Date.now() - HOUR, map: posted ? { ...body.map, runAtMs: newRun } : body.map } });
  });
  await page.route("**/api/wiki/work-map/refresh*", (route) => {
    posted = true;
    return route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } });
  });
  await page.clock.install();
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator('[data-wm-cell="github"] b')).toHaveText("0");
  expect(stub.count()).toBe(1);
  await card.locator("#wikiWorkMapRefresh").click();
  await expect
    .poll(async () => {
      await page.clock.runFor(1_000);
      return stub.count();
    })
    .toBe(2);
  expect(gets).toBeGreaterThan(1);
});

// The new map shares a title with the old one, so an old answer would land on it.
async function refreshToNewMap(page: Page, second: (route: Route) => Promise<void>): Promise<{ card: Locator; checks: () => number }> {
  let n = 0;
  await page.route("**/api/wiki/work-map/checks*", async (route) => (++n === 1 ? route.fulfill({ json: checksBody({ needs: GH_NEEDS, contradictions: [{ page: "plans/alpha.mdx", pr: 369, repo: "acme/gears", rowState: "open", ghState: "MERGED", mergedAt: GH_MERGED_AT }] }) }) : second(route)));
  const newRun = Date.now();
  let posted = false;
  await page.route("**/api/wiki/work-map?*", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { map: { runAtMs: number } } & Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: true, lastSuccessAt: Date.now() - HOUR, map: posted ? { ...body.map, runAtMs: newRun } : body.map } });
  });
  await page.route("**/api/wiki/work-map/refresh*", (route) => {
    posted = true;
    return route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } });
  });
  await page.clock.install();
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator(".wiki-wm-ghnote.done")).toHaveCount(1);
  await card.locator("#wikiWorkMapRefresh").click();
  await expect
    .poll(async () => {
      await page.clock.runFor(1_000);
      return n;
    })
    .toBe(2);
  return { card, checks: () => n };
}

test("a new map shows no mark from the previous answer while its own GET is pending", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const { card } = await refreshToNewMap(page, async (route) => {
    await held;
    await route.fulfill({ json: checksBody({ needs: [{ kind: "followup", title: "Only mentions", pr: 3556, state: "MERGED", mergedAt: "2026-10-28T12:00:00Z", asksForIt: false }] }) });
  });
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(card.locator(".wiki-wm-ghnote")).toHaveCount(0);
  await expect(card.locator(".wiki-wm-need.gh-done")).toHaveCount(0);
  expect(await card.locator(".wiki-wm-need").filter({ hasText: "Merge the fix" }).locator(".wiki-wm-action").evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("none");
  // The old answer still counts the rows, muted.
  await expect(cell.locator("b")).toHaveText("1");
  await expect(cell).toHaveClass(/\bmuted\b/);
  await expect(cell).not.toHaveClass(/\bbad\b/);
  await expect(cell).toContainText("checking…");
  // Its own answer marks.
  release();
  await expect(card.locator(".wiki-wm-ghnote.info")).toHaveText("GitHub: #3556 merged 28.10");
  await expect(card.locator(".wiki-wm-ghnote")).toHaveCount(1);
  await expect(cell).not.toHaveClass(/\bmuted\b/);
});

test("a new map whose GET answers 500 keeps no mark from the previous answer", async ({ page }) => {
  const { card, checks } = await refreshToNewMap(page, (route) => route.fulfill({ status: 500, json: { error: "x" } }));
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(card.locator(".wiki-wm-ghnote")).toHaveCount(0);
  await expect(card.locator(".wiki-wm-need.gh-done")).toHaveCount(0);
  await expect(cell).toContainText("not checked");
  await expect(cell.locator("b")).toHaveText("1");
  await expect(cell).toHaveClass(/\bmuted\b/);
  // No retry loop on the same map.
  await page.clock.runFor(30_000);
  await page.waitForTimeout(100);
  expect(checks()).toBe(2);
  await expect(card.locator(".wiki-wm-ghnote")).toHaveCount(0);
});

test("a themes map never asks for the check", async ({ page }) => {
  await page.route("**/api/wiki/work-map?*", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: false, map: sweepThemesMap(Date.now()) } });
  });
  const stub = await stubChecks(page, () => checksBody());
  await openStart(page, SWEEP);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator(".wiki-wn-title")).toHaveText("What you’re following");
  await page.waitForTimeout(300);
  expect(stub.count()).toBe(0);
  await expect(card.locator(".wiki-wm-ghnote")).toHaveCount(0);
});

test("a themes map has no strip", async ({ page }) => {
  await page.route("**/api/wiki/work-map?*", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: false, map: sweepThemesMap(Date.now()) } });
  });
  await openStart(page, SWEEP);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator(".wiki-wn-title")).toHaveText("What you’re following");
  await expect(card.locator(".wiki-wm-strip")).toHaveCount(0);
});

for (const width of [1280, 700]) {
  test(`a long unbroken title wraps inside the open list at ${width} wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openSettled(page, STRIP_LONG);
    const card = page.locator("#wikiWorkCard");
    await card.locator('[data-wm-cell="decisions"]').click();
    const drill = card.locator(".wiki-wm-drill");
    await expect(drill.locator(".wiki-wm-drill-row")).toHaveCount(2);
    await expect(drill).toContainText(LONG_TOKEN);
    await expect(drill).toContainText("s".repeat(180));
    const m = await drill.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, rowH: el.querySelector("li")!.getBoundingClientRect().height, twoEm: parseFloat(getComputedStyle(el).fontSize) * 2 }));
    expect(m.scroll).toBeLessThanOrEqual(m.client);
    expect(m.rowH).toBeGreaterThan(m.twoEm);
    expect(await card.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  });
}

test("a themes map keeps its markup when only the strip's inputs change, and repaints on a declaration", async ({ page }) => {
  await page.route("**/api/wiki/work-map?*", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: false, map: sweepThemesMap(Date.now()) } });
  });
  await page.clock.install();
  await openStart(page, THEME_HOLD);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator(".wiki-wn-title")).toHaveText("What you’re following");
  const selected = await page.evaluate(() => {
    const el = document.querySelector("#wikiWorkCard .wiki-wm-summary")!;
    el.setAttribute("data-before-adopt", "");
    getSelection()!.selectAllChildren(el);
    return String(getSelection());
  });
  expect(selected.length).toBeGreaterThan(0);
  const adopt = async (title: string) => {
    await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("#wikiList")).toContainText(title);
    await page.waitForTimeout(300);
  };
  await writeFile(path.join(roots[THEME_HOLD]!, "plans/hold-steps.mdx"), `---\ntitle: Hold steps\n---\n\n<NextMoves>\n\n<Lane kind="you">\n\n- One\n\n</Lane>\n\n</NextMoves>\n`, "utf8");
  await adopt("Hold steps");
  await expect(card.locator("[data-before-adopt]")).toHaveCount(1);
  expect(await page.evaluate(() => String(getSelection()))).toBe(selected);
  // A declaration still re-joins a themes map: this is the repaint the guard must not take away.
  await writeFile(path.join(roots[THEME_HOLD]!, "plans/hold-declared.mdx"), `---\ntitle: Hold declared\neffort: t0\n---\n\nBody.\n`, "utf8");
  await adopt("Hold declared");
  await expect(card.locator("[data-before-adopt]")).toHaveCount(0);
});

test("a no-map wiki asks for the digest no more often across adopts after a digest error", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: { digest: null, error: "connector busy" } }));
  await page.clock.install();
  const digests = await openStart(page, NONE);
  const wn = page.locator("#wikiWhatsNew");
  await expect(wn).toContainText("connector busy");
  expect(digests).toHaveLength(1);
  await forceAdopt(page, NONE);
  await forceAdopt(page, NONE);
  expect(digests).toHaveLength(1);
  await expect(wn).toContainText("connector busy");
  await expect(wn.locator("#wikiWhatsNewRetry")).toBeVisible();
});

test("What's new's in-flight ↻ stays disabled across an adopt", async ({ page }) => {
  const digest = { bullets: "- x", html: "<ul><li>Something changed</li></ul>", generatedAt: Date.now(), logMtimeMs: 0, entryCount: 1, fromDate: "2026-10-28", toDate: "2026-10-29" };
  let release: (() => Promise<void>) | null = null;
  await page.route("**/api/wiki/digest*", (route) => {
    if (!route.request().url().includes("refresh=1")) return route.fulfill({ json: { digest } });
    release = () => route.fulfill({ json: { digest } });
  });
  await page.clock.install();
  await openStart(page, NONE);
  const spin = page.locator("#wikiWhatsNewRefresh");
  await expect(spin).toBeEnabled();
  await spin.click();
  await expect(spin).toBeDisabled();
  await expect.poll(() => release !== null).toBe(true);
  await forceAdopt(page, NONE);
  await expect(spin).toBeDisabled();
  await expect(spin).toHaveClass(/spinning/);
  await release!();
  await expect(spin).toBeEnabled();
});

test("a lane the reader opened stays open across a repaint", async ({ page }) => {
  await openStart(page, FRESH);
  const card = page.locator("#wikiWorkCard");
  const cooling = card.locator('[data-wm-lane="cooling"]');
  await cooling.locator("summary").click();
  await expect(cooling).toHaveAttribute("open", "");
  // ✓ repaints the card.
  await card.locator('[data-wm-done="0"]').click();
  await expect(card.locator("[data-wm-need]")).toHaveCount(1);
  await expect(cooling).toHaveAttribute("open", "");
  // A start-tab switch rebuilds the card's slot.
  await page.locator('.wiki-tab[data-tab="timeline"]').click();
  await page.locator('.wiki-tab[data-tab="hubs"]').click();
  await expect(cooling).toHaveAttribute("open", "");
  await expect(card.locator('[data-wm-lane="quiet"]')).not.toHaveAttribute("open", "");
  // The reader can close the lane that starts open, and it stays closed.
  await card.locator('[data-wm-lane="moving"] summary').click();
  await card.locator("#wikiWorkMapRestore").click();
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await expect(card.locator('[data-wm-lane="moving"]')).not.toHaveAttribute("open", "");
});

test("a ↻ poll whose GET keeps failing settles and re-enables ↻", async ({ page }) => {
  let failing = false;
  let fails = 0;
  await page.route("**/api/wiki/work-map?*", async (route) => {
    if (failing) {
      fails++;
      return route.fulfill({ status: 500, json: { error: "boom" } });
    }
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: true, lastSuccessAt: Date.now() - 60 * 60_000 } });
  });
  await page.route("**/api/wiki/work-map/refresh*", (route) => route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } }));
  await page.clock.install();
  await openStart(page, FRESH);
  const btn = page.locator("#wikiWorkMapRefresh");
  await btn.click();
  await expect(page.locator("#wikiWorkMapStatus")).toContainText("Organizing…");
  failing = true;
  // Advance in small steps: a poll is scheduled only once the POST's body is read.
  await expect
    .poll(async () => {
      await page.clock.runFor(2_500);
      return fails;
    }, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(3);
  await expect(page.locator("#wikiWorkMapStatus")).toHaveText("Couldn’t check on the re-organize — reload to see the new map.");
  await expect(btn).toBeEnabled();
});

test("a ↻ poll GET that succeeds resets the failure count", async ({ page }) => {
  let polling = false;
  let polls = 0;
  // fail, fail, ok (still pending), fail, fail, then pending for good.
  const plan = ["fail", "fail", "ok", "fail", "fail"];
  await page.route("**/api/wiki/work-map?*", async (route) => {
    const step = polling ? (plan[polls++] ?? "ok") : "ok";
    if (step === "fail") return route.fulfill({ status: 500, json: { error: "boom" } });
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: true, running: false, lastSuccessAt: Date.now() - 60 * 60_000 } });
  });
  await page.route("**/api/wiki/work-map/refresh*", (route) => route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } }));
  await page.clock.install();
  await openStart(page, FRESH);
  const btn = page.locator("#wikiWorkMapRefresh");
  await btn.click();
  await expect(page.locator("#wikiWorkMapStatus")).toContainText("Organizing…");
  polling = true;
  await expect
    .poll(async () => {
      await page.clock.runFor(2_500);
      return polls;
    }, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(plan.length);
  // Let the fifth answer settle; on the fixed code the next poll starts.
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(100);
    await page.clock.runFor(2_500);
  }
  await expect(page.locator("#wikiWorkMapStatus")).toContainText("Organizing…");
  await expect(btn).toBeDisabled();
  expect(polls).toBeGreaterThan(plan.length);
});

test("✓ dismiss survives a reload and clears when the run time changes", async ({ page }) => {
  await openStart(page, DONE);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await card.locator('[data-wm-done="0"]').click();
  await expect(card.locator("[data-wm-need]")).toHaveCount(1);
  await expect(card.locator("#wikiWorkMapRestore")).toHaveText("1 done · show");
  await page.reload();
  await expect(card.locator(".wiki-wm-need-title")).toHaveText(["Resume beta"]);
  // A new run: same items, new runAt — the next run starts clean.
  await writeFile(path.join(roots[DONE]!, ".work-map.json"), mapJson(DONE, Date.now() - HOUR), "utf8");
  await page.reload();
  await expect(card.locator(".wiki-wm-age")).toHaveText("organized 1 h ago");
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
});

test("↻ shows when organizable and states a 429 refusal", async ({ page }) => {
  await page.route("**/api/wiki/work-map?*", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: true, lastSuccessAt: Date.now() - 5 * 60_000 } });
  });
  let posted: { contentType: string | null; url: string } | null = null;
  await page.route("**/api/wiki/work-map/refresh*", (route) => {
    posted = { contentType: route.request().headers()["content-type"] ?? null, url: route.request().url() };
    return route.fulfill({ status: 429, json: { error: "ran recently", lastSuccessAt: Date.now() - 5 * 60_000, retryAfterMs: 5 * 60_000 } });
  });
  await openStart(page, FRESH);
  const btn = page.locator("#wikiWorkMapRefresh");
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute("title", "Re-organize — last run 5 min ago");
  await btn.click();
  await expect(page.locator("#wikiWorkMapStatus")).toHaveText("Ran 5 min ago — try again in 5 min.");
  // The repaint keeps focus on ↻.
  await expect(btn).toBeFocused();
  expect(posted).not.toBeNull();
  expect(posted!.contentType).toContain("application/json");
  expect(posted!.url).not.toContain("force");
});

const DIGEST_OK = { digest: { bullets: "- x", html: "<ul><li>Something changed</li></ul>", generatedAt: Date.now(), logMtimeMs: 0, entryCount: 1, fromDate: "2026-10-28", toDate: "2026-10-29" } };

test("a work-map GET the instance refuses (4xx) falls back to What's new", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  let gets = 0;
  await page.route("**/api/wiki/work-map?*", (route) => {
    gets++;
    return route.fulfill({ status: 400, json: { error: "wiki is required" } });
  });
  await openStart(page, FRESH);
  await expect(page.locator("#wikiWhatsNew")).toContainText("Something changed");
  await expect(page.locator("#wikiWorkCard")).toBeHidden();
  // Longer than the network retry's delay: a refusal is not retried.
  await page.waitForTimeout(2_500);
  expect(gets).toBe(1);
});

test("a work-map GET answered 5xx keeps the card's Retry", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  let gets = 0;
  await page.route("**/api/wiki/work-map?*", (route) => {
    gets++;
    return route.fulfill({ status: 503, json: { error: "down" } });
  });
  await openStart(page, FRESH);
  await expect(page.locator("#wikiWorkCard #wikiWorkMapRetry")).toBeVisible();
  await expect(page.locator("#wikiWhatsNew")).toBeHidden();
  await page.waitForTimeout(2_500);
  expect(gets).toBe(1);
});

test("a work-map GET answered 2xx with a non-JSON body falls back once, without a retry", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  let gets = 0;
  await page.route("**/api/wiki/work-map?*", (route) => {
    gets++;
    return route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>Sign in</body></html>" });
  });
  await openStart(page, FRESH);
  await expect(page.locator("#wikiWhatsNew")).toContainText("Something changed");
  await expect(page.locator("#wikiWorkCard")).toBeHidden();
  await page.waitForTimeout(2_500);
  expect(gets).toBe(1);
});

test("a work-map GET that fails on the network twice falls back to What's new", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  const at: number[] = [];
  await page.route("**/api/wiki/work-map?*", (route) => {
    at.push(Date.now());
    return route.abort();
  });
  await openStart(page, FRESH);
  await expect(page.locator("#wikiWhatsNew")).toContainText("Something changed");
  await expect(page.locator("#wikiWorkCard")).toBeHidden();
  expect(at).toHaveLength(2);
  // The retry waits out a restart blip instead of firing in the same instant.
  expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(1_000);
});

test("after a twice-failed work-map GET, an adopt with a new run time brings the card", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  let gets = 0;
  await page.route("**/api/wiki/work-map?*", (route) => {
    gets++;
    return gets <= 2 ? route.abort() : route.continue();
  });
  await page.clock.install();
  await openStart(page, FB);
  const wn = page.locator("#wikiWhatsNew");
  const card = page.locator("#wikiWorkCard");
  await expect
    .poll(async () => {
      await page.clock.runFor(500);
      return gets;
    })
    .toBe(2);
  await expect(wn).toContainText("Something changed");
  await expect(card).toBeHidden();
  // The same run time: the fallback holds, no new GET.
  await forceAdopt(page, FB);
  expect(gets).toBe(2);
  await expect(wn).toBeVisible();
  // A new run: the card takes the slot back.
  await writeFile(path.join(roots[FB]!, ".work-map.json"), mapJson(FB, Date.now() - HOUR), "utf8");
  await forceAdopt(page, FB);
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await expect(wn).toBeHidden();
  expect(gets).toBe(3);
});

test("✓ dismiss lasts the page's life when storage throws", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
  });
  await openStart(page, FRESH);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await card.locator('[data-wm-done="0"]').click();
  await expect(card.locator("[data-wm-need]")).toHaveCount(1);
  // A start-tab switch repaints the card from the done store.
  await page.locator('.wiki-tab[data-tab="timeline"]').click();
  await page.locator('.wiki-tab[data-tab="hubs"]').click();
  await expect(card.locator("[data-wm-need]")).toHaveCount(1);
  await card.locator("#wikiWorkMapRestore").click();
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
});

test("an adopt that drops the map brings What's new back, and one that restores it brings the card", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  await page.clock.install();
  const digests = await openStart(page, FLIP);
  const card = page.locator("#wikiWorkCard");
  const wn = page.locator("#wikiWhatsNew");
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  expect(digests).toHaveLength(0);
  await rm(path.join(roots[FLIP]!, ".work-map.json"));
  await forceAdopt(page, FLIP);
  await expect(card).toBeHidden();
  await expect(wn).toContainText("Something changed");
  await forceAdopt(page, FLIP);
  expect(digests).toHaveLength(1);
  await writeFile(path.join(roots[FLIP]!, ".work-map.json"), mapJson(FLIP, Date.now() - HOUR), "utf8");
  await forceAdopt(page, FLIP);
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await expect(wn).toBeHidden();
  expect(digests).toHaveLength(1);
});

test("a map that comes and goes on adopts keeps What's new's in-flight ↻", async ({ page }) => {
  let release: (() => Promise<void>) | null = null;
  await page.route("**/api/wiki/digest*", (route) => {
    if (!route.request().url().includes("refresh=1")) return route.fulfill({ json: DIGEST_OK });
    release = () => route.fulfill({ json: DIGEST_OK });
  });
  await page.clock.install();
  const digests = await openStart(page, GROW);
  const card = page.locator("#wikiWorkCard");
  const wn = page.locator("#wikiWhatsNew");
  const spin = page.locator("#wikiWhatsNewRefresh");
  await spin.click();
  await expect(spin).toBeDisabled();
  await expect.poll(() => release !== null).toBe(true);
  await writeFile(path.join(roots[GROW]!, ".work-map.json"), mapJson(GROW, Date.now() - HOUR), "utf8");
  await forceAdopt(page, GROW);
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await expect(wn).toBeHidden();
  await rm(path.join(roots[GROW]!, ".work-map.json"));
  await forceAdopt(page, GROW);
  await expect(card).toBeHidden();
  await expect(wn).toBeVisible();
  await expect(spin).toBeDisabled();
  await release!();
  await expect(spin).toBeEnabled();
  await expect(card).toBeHidden();
  expect(digests).toHaveLength(2);
});

test("a What's new ↻ that lands while the card holds the slot stays hidden until the map goes", async ({ page }) => {
  let release: (() => Promise<void>) | null = null;
  const fresh = { digest: { ...DIGEST_OK.digest, html: "<ul><li>Fresher news</li></ul>" } };
  await page.route("**/api/wiki/digest*", (route) => {
    if (!route.request().url().includes("refresh=1")) return route.fulfill({ json: DIGEST_OK });
    release = () => route.fulfill({ json: fresh });
  });
  await page.clock.install();
  await openStart(page, GROW_LATE);
  const card = page.locator("#wikiWorkCard");
  const wn = page.locator("#wikiWhatsNew");
  await page.locator("#wikiWhatsNewRefresh").click();
  await expect.poll(() => release !== null).toBe(true);
  await writeFile(path.join(roots[GROW_LATE]!, ".work-map.json"), mapJson(GROW_LATE, Date.now() - HOUR), "utf8");
  await forceAdopt(page, GROW_LATE);
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await release!();
  await expect(wn).toContainText("Fresher news");
  await expect(wn).toBeHidden();
  await expect(card).toBeVisible();
  await rm(path.join(roots[GROW_LATE]!, ".work-map.json"));
  await forceAdopt(page, GROW_LATE);
  await expect(wn).toBeVisible();
  await expect(wn).toContainText("Fresher news");
  await expect(page.locator("#wikiWhatsNewRefresh")).toBeEnabled();
});

test("a map that comes and goes on adopts keeps What's new's error and asks for the digest once", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: { digest: null, error: "connector busy" } }));
  await page.clock.install();
  const digests = await openStart(page, GROW_ERR);
  const card = page.locator("#wikiWorkCard");
  const wn = page.locator("#wikiWhatsNew");
  await expect(wn).toContainText("connector busy");
  await writeFile(path.join(roots[GROW_ERR]!, ".work-map.json"), mapJson(GROW_ERR, Date.now() - HOUR), "utf8");
  await forceAdopt(page, GROW_ERR);
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await expect(wn).toBeHidden();
  await rm(path.join(roots[GROW_ERR]!, ".work-map.json"));
  await forceAdopt(page, GROW_ERR);
  await expect(card).toBeHidden();
  await expect(wn).toContainText("connector busy");
  await expect(wn.locator("#wikiWhatsNewRetry")).toBeVisible();
  expect(digests).toHaveLength(1);
});

test("focus on a ✓ or a page link survives a ↻ poll repaint", async ({ page }) => {
  let gets = 0;
  await page.route("**/api/wiki/work-map?*", async (route) => {
    gets++;
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ json: { ...body, organizable: true, lastSuccessAt: Date.now() - 60 * 60_000 } });
  });
  await page.route("**/api/wiki/work-map/refresh*", (route) => route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } }));
  await page.clock.install();
  await openSettled(page, FRESH);
  const card = page.locator("#wikiWorkCard");
  await card.locator("#wikiWorkMapRefresh").click();
  await expect(page.locator("#wikiWorkMapStatus")).toContainText("Organizing…");
  const repaint = async () => {
    await page.evaluate(() => document.querySelector("#wikiWorkCard .wiki-wm-summary")!.setAttribute("data-before-repaint", ""));
    const n = gets;
    await expect
      .poll(async () => {
        await page.clock.runFor(1_000);
        return gets;
      })
      .toBeGreaterThan(n);
    await expect(card.locator("[data-before-repaint]")).toHaveCount(0);
  };
  const done = card.locator('[data-wm-done="1"]');
  await done.focus();
  await repaint();
  await expect(done).toBeFocused();
  const link = card.locator('.wiki-wm-link[data-relpath="plans/alpha.mdx"]').nth(1);
  await link.focus();
  await repaint();
  await expect(link).toBeFocused();
});

test("a ✓ pressed from the keyboard moves focus to the next ✓, then to the restore control", async ({ page }) => {
  await openStart(page, FRESH);
  const card = page.locator("#wikiWorkCard");
  await card.locator('[data-wm-done="0"]').focus();
  await page.keyboard.press("Enter");
  await expect(card.locator("[data-wm-need]")).toHaveCount(1);
  await expect(card.locator('[data-wm-done="1"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card.locator("[data-wm-need]")).toHaveCount(0);
  await expect(card.locator("#wikiWorkMapRestore")).toBeFocused();
});

// ── Class check (round 3): one slot state, one focus resolver, card CSS keeps
// its interactive states. The slot transitions are unit-tested in
// `wiki-start-slot.test.ts`; these pin the wiring.

/** Hold the first `/api/wiki/work-map` GET until `release` is called. */
async function holdFirstGet(page: Page, opts: { status?: number } = {}) {
  const st = { gets: 0, release: null as null | (() => Promise<void>) };
  await page.route("**/api/wiki/work-map?*", async (route) => {
    st.gets++;
    if (st.gets !== 1) return route.continue();
    if (opts.status) {
      st.release = () => route.fulfill({ status: opts.status!, json: { error: "x" } });
      return;
    }
    const body = await (await route.fetch()).json();
    st.release = () => route.fulfill({ json: body });
  });
  return st;
}

/** Answer every work-map GET as organizable, so the card offers ↻. */
async function organizable(page: Page, hold?: (n: number, fulfill: () => Promise<void>) => boolean) {
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

const activeDesc = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return !a || a === document.body ? "body" : `${a.tagName.toLowerCase()}${a.id ? "#" + a.id : ""}.${a.className}`;
  });

test("an adopt that brings a map hides What's new while the card's GET is held, and sends no digest", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  const st = await holdFirstGet(page);
  await page.clock.install();
  const digests = await openStart(page, P_LOAD);
  const wn = page.locator("#wikiWhatsNew");
  const card = page.locator("#wikiWorkCard");
  await expect(wn).toContainText("Something changed");
  expect(digests).toHaveLength(1);
  await writeFile(path.join(roots[P_LOAD]!, ".work-map.json"), mapJson(P_LOAD, Date.now() - HOUR), "utf8");
  await forceAdopt(page, P_LOAD);
  await expect.poll(() => st.release !== null).toBe(true);
  await expect(wn).toBeHidden();
  await expect(card).toBeHidden();
  // What's new's ↻ is still in the DOM: a click on it sends nothing.
  await page.evaluate(() => document.getElementById("wikiWhatsNewRefresh")!.click());
  // A tab switch while the GET is held keeps both hidden.
  await page.locator('.wiki-tab[data-tab="timeline"]').click();
  await page.locator('.wiki-tab[data-tab="hubs"]').click();
  await expect(wn).toBeHidden();
  await expect(card).toBeHidden();
  await page.waitForTimeout(300);
  expect(digests).toHaveLength(1);
  await st.release!();
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await expect(wn).toBeHidden();
  expect(digests).toHaveLength(1);
});

test("a map GET answered after the map dropped does not repaint the card", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  const st = await holdFirstGet(page);
  await page.clock.install();
  await openStart(page, P_LATE);
  const card = page.locator("#wikiWorkCard");
  const wn = page.locator("#wikiWhatsNew");
  await expect.poll(() => st.release !== null).toBe(true);
  await rm(path.join(roots[P_LATE]!, ".work-map.json"));
  await forceAdopt(page, P_LATE);
  await expect(wn).toContainText("Something changed");
  await st.release!();
  await page.waitForTimeout(500);
  await expect(card).toBeHidden();
  await expect(wn).toBeVisible();
  // The map comes back with a new run time: one fresh GET paints the card.
  await writeFile(path.join(roots[P_LATE]!, ".work-map.json"), mapJson(P_LATE, Date.now() - HOUR), "utf8");
  await forceAdopt(page, P_LATE);
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await expect(wn).toBeHidden();
  expect(st.gets).toBe(2);
});

test("a 5xx GET answered after the map dropped does not show the card's Retry", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  const st = await holdFirstGet(page, { status: 503 });
  await page.clock.install();
  await openStart(page, P_LATE5);
  const card = page.locator("#wikiWorkCard");
  const wn = page.locator("#wikiWhatsNew");
  await expect.poll(() => st.release !== null).toBe(true);
  await rm(path.join(roots[P_LATE5]!, ".work-map.json"));
  await forceAdopt(page, P_LATE5);
  await expect(wn).toContainText("Something changed");
  await st.release!();
  await page.waitForTimeout(500);
  await expect(card).toBeHidden();
  await expect(wn).toBeVisible();
});

test("a ↻ POST answered after the map dropped starts no poll", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  const st = await organizable(page);
  let releasePost: null | (() => Promise<void>) = null;
  await page.route("**/api/wiki/work-map/refresh*", (route) => {
    releasePost = () => route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } });
  });
  await page.clock.install();
  await openStart(page, P_POST);
  const card = page.locator("#wikiWorkCard");
  const wn = page.locator("#wikiWhatsNew");
  await card.locator("#wikiWorkMapRefresh").click();
  await expect.poll(() => releasePost !== null).toBe(true);
  await rm(path.join(roots[P_POST]!, ".work-map.json"));
  await forceAdopt(page, P_POST);
  await expect(card).toBeHidden();
  await expect(wn).toContainText("Something changed");
  const n = st.gets;
  await releasePost!();
  for (let i = 0; i < 6; i++) await page.clock.runFor(5_000);
  await page.waitForTimeout(300);
  expect(st.gets).toBe(n);
  await expect(card).toBeHidden();
});

test("a ↻ poll in flight when the map drops stops and paints nothing", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  let hold: null | (() => Promise<void>) = null;
  const st = await organizable(page, (n, f) => {
    if (n !== 2) return false;
    hold = f;
    return true;
  });
  await page.route("**/api/wiki/work-map/refresh*", (route) => route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } }));
  await page.clock.install();
  await openStart(page, P_POLL);
  const card = page.locator("#wikiWorkCard");
  const wn = page.locator("#wikiWhatsNew");
  await card.locator("#wikiWorkMapRefresh").click();
  await expect(page.locator("#wikiWorkMapStatus")).toContainText("Organizing…");
  await expect
    .poll(async () => {
      await page.clock.runFor(1_000);
      return hold !== null;
    })
    .toBe(true);
  await rm(path.join(roots[P_POLL]!, ".work-map.json"));
  await forceAdopt(page, P_POLL);
  await expect(card).toBeHidden();
  const n = st.gets;
  await hold!();
  for (let i = 0; i < 6; i++) await page.clock.runFor(5_000);
  await page.waitForTimeout(300);
  expect(st.gets).toBe(n);
  await expect(card).toBeHidden();
  await expect(wn).toBeVisible();
});

test("a ✓ whose next sibling shares its key moves focus past it, to the next remaining ✓", async ({ page }) => {
  await openStart(page, P_DUP);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator("[data-wm-need]")).toHaveCount(3);
  await card.locator('[data-wm-done="0"]').focus();
  await page.keyboard.press("Enter");
  // Both "Same" items share one key, so one ✓ dismisses both.
  await expect(card.locator("[data-wm-need]")).toHaveCount(1);
  await expect(card.locator('[data-wm-done="2"]')).toBeFocused();
});

test("focus inside the card moves to What's new's heading when an adopt drops the map", async ({ page }) => {
  await page.route("**/api/wiki/digest*", (route) => route.fulfill({ json: DIGEST_OK }));
  await page.clock.install();
  await openStart(page, P_FOCUS);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator("[data-wm-need]")).toHaveCount(2);
  await card.locator('[data-wm-done="0"]').focus();
  await rm(path.join(roots[P_FOCUS]!, ".work-map.json"));
  await forceAdopt(page, P_FOCUS);
  await expect(card).toBeHidden();
  await expect(page.locator("#wikiWhatsNew")).toContainText("Something changed");
  await expect.poll(() => activeDesc(page)).toBe("span.wiki-wn-title");
  await expect(page.locator("#wikiWhatsNew .wiki-wn-title")).toBeFocused();
});

test("'less' on a why that no longer clamps keeps focus in the card", async ({ page }) => {
  await page.setViewportSize({ width: WHY_CLAMPED_AT, height: 844 });
  await openStart(page, P_WHY);
  const card = page.locator("#wikiWorkCard");
  const text = card.locator(".wiki-wm-why-text");
  const more = card.locator(".wiki-wm-why-more");
  await expect(more).toBeVisible();
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await page.setViewportSize({ width: WHY_FITS_AT, height: 844 });
  // The card is wide enough now that the closed text fits its two lines.
  await expect.poll(() => text.evaluate((el) => el.scrollHeight <= Math.ceil(2 * parseFloat(getComputedStyle(el).lineHeight)) + 1)).toBe(true);
  await expect(more).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card.locator(".wiki-wm-why")).not.toHaveClass(/\bopen\b/);
  await expect(more).toBeHidden();
  expect(await activeDesc(page)).not.toBe("body");
  await expect(text).toBeFocused();
});

for (const theme of [
  { label: "Light", stored: "light", scheme: "dark" as const },
  { label: "Dark", stored: "dark", scheme: "light" as const },
]) {
  test(`↻ and Retry inside the card change colour on hover in the ${theme.label} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme.scheme });
    await page.addInitScript((v) => localStorage.setItem("muninn-theme", v), theme.stored);
    await organizable(page);
    await openSettled(page, FRESH);
    const color = (sel: string) => page.locator(sel).evaluate((el) => getComputedStyle(el).color);
    const accent = await token(page, "--accent-light");
    const btn = page.locator("#wikiWorkMapRefresh");
    const rest = await color("#wikiWorkMapRefresh");
    expect(rest).not.toBe(accent);
    await btn.hover();
    await expect.poll(() => color("#wikiWorkMapRefresh")).toBe(accent);
    await page.unroute("**/api/wiki/work-map?*");
    await page.route("**/api/wiki/work-map?*", (route) => route.fulfill({ status: 503, json: { error: "down" } }));
    await page.reload();
    const retry = page.locator("#wikiWorkMapRetry");
    await expect(retry).toBeVisible();
    await page.mouse.move(0, 0);
    const retryRest = await color("#wikiWorkMapRetry");
    expect(retryRest).not.toBe(accent);
    await retry.hover();
    await expect.poll(() => color("#wikiWorkMapRetry")).toBe(accent);
  });
}

/** Every theme a reader can end up in: an explicit pick stored under
 *  `muninn-theme` (a base or a palette), or nothing stored and the OS scheme. */
const THEMES: { label: string; stored: string | null; scheme: "light" | "dark" }[] = [
  { label: "Light", stored: "light", scheme: "dark" },
  { label: "Dark", stored: "dark", scheme: "light" },
  { label: "Reading mode", stored: "reading", scheme: "light" },
  { label: "Light reading mode", stored: "paper-light", scheme: "dark" },
  { label: "System light", stored: null, scheme: "light" },
  { label: "System dark", stored: null, scheme: "dark" },
];

for (const theme of THEMES) {
  test(`keyboard focus on an open cell looks different from open without focus in the ${theme.label} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: theme.scheme });
    await page.addInitScript((v) => {
      if (v === null) localStorage.removeItem("muninn-theme");
      else localStorage.setItem("muninn-theme", v);
    }, theme.stored);
    await openSettled(page, STRIP);
    const card = page.locator("#wikiWorkCard");
    const open = card.locator('[data-wm-cell="decisions"]');
    const next = card.locator('[data-wm-cell="oldest"]');
    const shut = card.locator('[data-wm-cell="steps"]');
    const accent = await token(page, "--accent");
    await open.focus();
    await page.keyboard.press("Enter");
    await expect(open).toHaveAttribute("aria-expanded", "true");
    await expect(open).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(next).toBeFocused();
    const closedFocused = await cellPaint(next);
    const openAtRest = await cellPaint(open);
    const closedAtRest = await cellPaint(shut);
    await page.keyboard.press("Shift+Tab");
    await expect(open).toBeFocused();
    expect(await open.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
    const openFocused = await cellPaint(open);
    expect(openFocused).not.toEqual(openAtRest);
    // Focus is the outline, on an open cell and a closed one alike.
    expect(openAtRest.outline).toBe("none 0px");
    expect(openFocused.outline).toBe("solid 2px");
    expect(openFocused.outlineColor).toBe(accent);
    expect(closedFocused.outline).toBe("solid 2px");
    // Open still reads at rest, without any outline.
    expect(openAtRest.shadow).toContain(accent);
    expect(openAtRest.shadow).toContain("inset");
    expect(openAtRest.border).toBe(accent);
    expect(closedAtRest.shadow).toBe("none");
    expect(closedAtRest.border).not.toBe(accent);
    // The ring is seen against the card behind it (WCAG 1.4.11: 3:1).
    await card.evaluate((el) => {
      const probe = document.createElement("span");
      probe.id = "ringProbe";
      probe.style.color = "var(--accent)";
      el.appendChild(probe);
    });
    expect(await contrastOf(page.locator("#ringProbe"))).toBeGreaterThanOrEqual(3);
  });
}

/** How often `cellPaint` reads, 50 ms apart, before it calls the card repainting for good. */
const CELL_PAINT_READS = 40;

/** All a cell's border, ring and shadow paint: what a state change has to move.
 *  `Locator.evaluate` finds the element, then reads it: a repaint between the two
 *  reads a detached element, whose computed style is empty, so this paint's fields
 *  would be "" and the outline " " (CI, #787). */
async function cellPaint(cell: Locator) {
  await checksPainted(cell.page());
  for (let read = 0; read < CELL_PAINT_READS; read++) {
    const paint = await cell.evaluate(
      (el) => {
        if (!el.isConnected) return null;
        const c = getComputedStyle(el);
        return { outline: `${c.outlineStyle} ${c.outlineWidth}`, outlineColor: c.outlineColor, shadow: c.boxShadow, border: c.borderTopColor, borderWidth: c.borderTopWidth };
      },
      undefined,
      { timeout: 5_000 },
    );
    if (paint) return paint;
    await cell.page().waitForTimeout(50);
  }
  throw new Error(`cellPaint: ${cell} was detached on all ${CELL_PAINT_READS} reads, so the card keeps repainting`);
}

for (const theme of THEMES) {
  test.describe(`cell hover in the ${theme.label} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({ colorScheme: theme.scheme });
      await page.addInitScript((v) => {
        if (v === null) localStorage.removeItem("muninn-theme");
        else localStorage.setItem("muninn-theme", v);
      }, theme.stored);
    });

    test("hovering an open cell paints differently from the open cell at rest", async ({ page }) => {
      await openSettled(page, STRIP);
      const open = page.locator('#wikiWorkCard [data-wm-cell="decisions"]');
      await open.click();
      await expect(open).toHaveAttribute("aria-expanded", "true");
      await page.mouse.move(0, 0);
      const rest = await cellPaint(open);
      await open.hover();
      await expect.poll(() => cellPaint(open)).not.toEqual(rest);
    });

    test("hovering a closed cell paints the accent border, and a disabled cell does not react", async ({ page }) => {
      await openSettled(page, STRIP);
      const shut = page.locator('#wikiWorkCard [data-wm-cell="steps"]');
      const rest = await cellPaint(shut);
      expect(rest.border).not.toBe(await token(page, "--accent"));
      await shut.hover();
      await expect.poll(async () => (await cellPaint(shut)).border).toBe(await token(page, "--accent"));
      await page.mouse.move(0, 0);
      await openSettled(page, STRIP_OFF);
      const off = page.locator('#wikiWorkCard [data-wm-cell="decisions"]');
      await expect(off).toBeDisabled();
      const offRest = await cellPaint(off);
      await off.hover();
      expect(await off.evaluate((el) => el.matches(":hover"))).toBe(true);
      expect(await cellPaint(off)).toEqual(offRest);
    });
  });
}

test("a mouse click opens a cell and draws no focus ring", async ({ page }) => {
  await openSettled(page, STRIP);
  const cell = page.locator('#wikiWorkCard [data-wm-cell="decisions"]');
  await cell.click();
  await expect(cell).toHaveAttribute("aria-expanded", "true");
  await expect(cell).toBeFocused();
  expect((await cellPaint(cell)).outline).toBe("none 0px");
});

for (const scheme of ["light", "dark"] as const) {
  test(`forced colors over a ${scheme} scheme: open differs from closed, and focus from open at rest`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: scheme, forcedColors: "active" });
    await openSettled(page, STRIP);
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    const card = page.locator("#wikiWorkCard");
    const open = card.locator('[data-wm-cell="decisions"]');
    const next = card.locator('[data-wm-cell="oldest"]');
    const shut = card.locator('[data-wm-cell="steps"]');
    const box = async () => {
      const b = (await open.locator("b").boundingBox())!;
      return { x: b.x, y: b.y, cell: (await open.boundingBox())!.height };
    };
    const boxShut = await box();
    await open.focus();
    await page.keyboard.press("Enter");
    await expect(open).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Tab");
    await expect(next).toBeFocused();
    const closedFocused = await cellPaint(next);
    const openAtRest = await cellPaint(open);
    const closedAtRest = await cellPaint(shut);
    // Open is a colour and a width, so it does not hang on one system colour pair.
    expect(openAtRest.border).not.toBe(closedAtRest.border);
    expect(openAtRest.borderWidth).toBe("2px");
    expect(closedAtRest.borderWidth).toBe("1px");
    // The wider border takes its width from the padding: nothing moves when a cell opens.
    expect(await box()).toEqual(boxShut);
    await page.keyboard.press("Shift+Tab");
    await expect(open).toBeFocused();
    const openFocused = await cellPaint(open);
    // Focus is still the outline alone, on top of the open mark.
    expect(openAtRest.outline).toBe("none 0px");
    expect(openFocused.outline).toBe("solid 2px");
    expect(closedFocused.outline).toBe("solid 2px");
    expect(openFocused.borderWidth).toBe("2px");
    expect(closedFocused.borderWidth).toBe("1px");
  });
}

/** Every element in the card that paints its own text, measured where it sits
 *  (no `.first()`: one class can sit on two boxes). Returns the ratios and the
 *  classes of every visible element, for the coverage check. */
async function sweepCard(page: Page, label: string): Promise<{ low: string[]; min: number; classes: string[] }> {
  const card = page.locator("#wikiWorkCard");
  const measure = await paintedMeasure(page);
  const { what, ratios, classes } = await card.evaluate((root, measure) => {
    const what: string[] = [];
    const ratios: number[] = [];
    const classes: string[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      if (!el.checkVisibility({ visibilityProperty: true })) continue;
      classes.push(...Array.from(el.classList));
      if (!Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())) continue;
      what.push(`${el.tagName.toLowerCase()}.${Array.from(el.classList).join(".")} "${el.textContent!.trim().slice(0, 30)}"`);
      ratios.push(measure(el, false, false));
    }
    return { what, ratios, classes };
  }, measure);
  expect(what.length, `${label}: nothing to measure`).toBeGreaterThan(0);
  const low = ratios.flatMap((r, i) => (r < 4.5 ? [`${label}: ${what[i]} ${r.toFixed(2)}`] : []));
  const min = Math.min(...ratios);
  return { low, min, classes };
}

/** A themes map over the sweep wiki's pages that paints every part of the
 *  themes card: each state, a Life theme, a connection, a drift count, hub
 *  chips, a partial week, the running week and «+N earlier». */
function sweepThemesMap(runAtMs: number): unknown {
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

/** The `.wiki-wm-*` / `.wm-state-*` classes the stylesheet styles, and the
 *  shared `.wiki-wn-*` ones it restyles inside the card: each must be painted
 *  in some swept state, or the sweep never measured it. */
async function styledCardClasses(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        const sel = (rule as CSSStyleRule).selectorText;
        if (!sel) continue;
        for (const m of sel.matchAll(/\.((?:wiki-wm|wm-state)-[\w-]+)/g)) out.add(m[1]!);
        for (const part of sel.split(",")) if (part.includes(".wiki-workcard")) for (const m of part.matchAll(/\.(wiki-wn-[\w-]+)/g)) out.add(m[1]!);
      }
    }
    return [...out].sort();
  });
}

for (const theme of THEMES) {
  test(`legible in the ${theme.label} theme, in every state the card paints`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: theme.scheme });
    await page.addInitScript((v) => {
      if (v === null) localStorage.removeItem("muninn-theme");
      else localStorage.setItem("muninn-theme", v);
    }, theme.stored);
    await page.route("**/api/wiki/work-map?*", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      await route.fulfill({ json: { ...body, organizable: true, lastSuccessAt: Date.now() - 31 * HOUR, lastAttempt: { at: Date.now() - 10 * 60_000, outcome: "failed", error: "model timed out" } } });
    });
    let posts = 0;
    await page.route("**/api/wiki/work-map/refresh*", (route) =>
      ++posts === 1
        ? route.fulfill({ status: 429, json: { error: "ran recently", lastSuccessAt: Date.now() - 5 * 60_000, retryAfterMs: 5 * 60_000 } })
        : route.fulfill({ status: 202, json: { state: "started", startedAt: Date.now() } }),
    );
    // Every mark and note the GitHub check paints: bad tone, remedy, three note tones.
    let answerNotCurrent = false;
    let answerAllClear = false;
    await stubChecks(page, () =>
      answerAllClear ? checksBody({ checked: 5, unlinked: 197, unlinkedRows: GH_UNLINKED, refreshing: answerNotCurrent }) : checksBody({
        notChecked: { reason: "auth", repos: ["acme/gears"] },
        contradictions: [{ page: "plans/alpha.mdx", pr: 1, repo: "acme/other", rowState: "open", ghState: "MERGED", mergedAt: GH_MERGED_AT }],
        uncheckedRows: GH_UNCHECKED,
        unlinkedRows: GH_UNLINKED,
        needs: [
          { kind: "decision", title: "Settle ⟦plans/alpha.mdx⟧", pr: 1, state: "MERGED", mergedAt: GH_MERGED_AT, asksForIt: true },
          { kind: "decision", title: "Settle ⟦plans/alpha.mdx⟧", pr: 2, state: "CLOSED", mergedAt: null, asksForIt: true },
          { kind: "resume", title: "Resume beta", pr: 3, state: "MERGED", mergedAt: GH_MERGED_AT, asksForIt: true },
        ],
      }),
    );
    await page.clock.install();
    await openStart(page, SWEEP);
    const card = page.locator("#wikiWorkCard");
    await expect(card.locator(".wiki-wm-stale")).toBeVisible();
    await expect(card.locator(".wiki-wm-ghnote")).toHaveCount(3);
    expect(await card.locator("a.wiki-wm-effort-name").first().evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--accent-light"));
    expect(await card.locator(".wiki-wm-summary a").first().evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--accent-light"));
    const low: string[] = [];
    const seen = new Set<string>();
    const mins: number[] = [];
    const labels: string[] = [];
    const sweep = async (label: string) => {
      const r = await sweepCard(page, label);
      low.push(...r.low);
      mins.push(r.min);
      labels.push(label);
      r.classes.forEach((c) => seen.add(c));
    };
    // The map: every lane open, the long why opened, the last attempt's warning.
    await card.evaluate((root) => root.querySelectorAll("details").forEach((d) => (d.open = true)));
    await card.locator(".wiki-wm-why-more:visible").click();
    await expect(card.locator(".wiki-wm-why.open")).toHaveCount(1);
    await expect(card.locator("#wikiWorkMapStatus.warn")).toBeVisible();
    await card.locator('[data-wm-cell="decisions"]').click();
    await expect(card.locator("[data-wm-drill-more]")).toBeVisible();
    await sweep("map");
    // The GitHub list: a group's line shut, then both groups open with their +N more.
    await card.locator('[data-wm-cell="github"]').click();
    await expect(card.locator('[data-wm-drill="github"] .wiki-wm-drill-row')).toHaveCount(1);
    await sweep("GitHub list shut");
    await card.locator('[data-wm-gh-more="unchecked"]').click();
    await card.locator('[data-wm-gh-more="unlinked"]').click();
    await expect(card.locator('[data-wm-drill="github"] .wiki-wm-drill-row')).toHaveCount(17);
    await expect(card.locator('[data-wm-gh-group="contradictions"] .wiki-wm-drill-group-head')).toBeVisible();
    await sweep("GitHub list open");
    // ↻ hovered, then focused from the keyboard.
    await card.locator("#wikiWorkMapRefresh").hover();
    await expect.poll(async () => card.locator("#wikiWorkMapRefresh").evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--accent-light"));
    await sweep("↻ hover");
    await page.mouse.move(0, 0);
    await page.keyboard.press("Shift");
    await card.locator("#wikiWorkMapRefresh").focus();
    expect(await card.locator("#wikiWorkMapRefresh").evaluate((el) => el.matches(":focus-visible"))).toBe(true);
    await sweep("↻ focus-visible");
    // ↻ refused (warn), then running (plain), ↻ disabled.
    await card.locator("#wikiWorkMapRefresh").click();
    await expect(card.locator("#wikiWorkMapStatus")).toHaveText("Ran 5 min ago — try again in 5 min.");
    await sweep("refusal");
    const posted = page.waitForResponse("**/api/wiki/work-map/refresh*");
    await card.locator("#wikiWorkMapRefresh").click();
    await posted;
    await expect(card.locator("#wikiWorkMapStatus")).toContainText("Organizing…");
    await page.waitForTimeout(200);
    await sweep("running");
    // Every item done: the restore control and the empty line.
    while ((await card.locator("[data-wm-done]").count()) > 0) await card.locator("[data-wm-done]").first().click();
    await expect(card.locator(".wiki-wm-empty")).toBeVisible();
    await expect(card.locator("#wikiWorkMapRestore")).toBeVisible();
    await sweep("empty");
    // The same GET answering a themes map (theme map P2): What you're
    // following paints its own classes, every lane open.
    await page.unroute("**/api/wiki/work-map?*");
    await page.route("**/api/wiki/work-map?*", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      // Run now: the seeded map is 30 h old, which until Tuesday morning falls in last week, so no slot is current.
      await route.fulfill({ json: { ...body, organizable: false, map: sweepThemesMap(Date.now()) } });
    });
    await page.reload();
    await expect(card.locator(".wiki-wn-title")).toHaveText("What you’re following");
    await card.evaluate((root) => root.querySelectorAll("details").forEach((d) => (d.open = true)));
    await expect(card.locator(".wiki-wm-conn")).toHaveCount(1);
    // The running week is framed dashed, and the hidden weeks read «+N earlier».
    const cur = card.locator(".wiki-wm-theme").first().locator(".wiki-wm-slot.current");
    expect(await cur.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("dashed");
    await expect(card.locator(".wiki-wm-theme").first().locator(".wiki-wm-weeks-earlier")).toHaveText("+4 earlier");
    await sweep("themes");
    // The GET answered 5xx: the card's error and Retry.
    await page.unroute("**/api/wiki/work-map?*");
    await page.route("**/api/wiki/work-map?*", (route) => route.fulfill({ status: 503, json: { error: "down" } }));
    await page.reload();
    await expect(card.locator("#wikiWorkMapRetry")).toBeVisible();
    await sweep("error");
    await card.locator("#wikiWorkMapRetry").hover();
    await expect.poll(async () => card.locator("#wikiWorkMapRetry").evaluate((el) => getComputedStyle(el).color)).toBe(await token(page, "--accent-light"));
    await sweep("Retry hover");
    // A wiki taking no answers: the two cells' «owner not set».
    await page.unroute("**/api/wiki/work-map?*");
    await openStart(page, STRIP_OFF);
    await expect(card.locator('[data-wm-cell="decisions"] b')).toHaveText("owner not set");
    await sweep("owner not set");
    // The GitHub list with no contradiction: its counts line.
    answerAllClear = true;
    await openStart(page, SWEEP);
    await card.locator('[data-wm-cell="github"]').click();
    await expect(card.locator(".wiki-wm-drill-counts")).toBeVisible();
    await sweep("GitHub all clear");
    // The same list on an answer that is no longer current: its line.
    answerNotCurrent = true;
    await openStart(page, SWEEP);
    const github = card.locator('[data-wm-cell="github"]');
    await expect
      .poll(async () => {
        await page.clock.runFor(15_000);
        return github.innerText();
      })
      .toContain("not refreshed");
    await github.click();
    await expect(card.locator(".wiki-wm-drill-stale")).toBeVisible();
    await sweep("GitHub not current");
    // A work effort's state chip paints on the effort page alone: that page's spec sweeps and pins all three.
    expect((await styledCardClasses(page)).filter((c) => !seen.has(c) && !["wm-state-active", "wm-state-blocked", "wm-state-shipped"].includes(c))).toEqual([]);
    console.log(`contrast min ${theme.label}: ${Math.min(...mins).toFixed(2)} (${labels.map((l, i) => `${l} ${mins[i]!.toFixed(2)}`).join(", ")})`);
    expect(low).toEqual([]);
  });
}

// Non-text marks need 3:1 (WCAG 1.4.11), a zero bar included: it is the row's baseline.
// A computed fill says nothing about a bar thinner than its pixels, so this reads paint.
function contrastOfRgb(a: number[], b: number[]): number {
  const lum = (c: number[]) => {
    const [r, g, bl] = c.map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** A locator's device pixels as painted, decoded on a blank page. */
async function paintedPixels(l: Locator): Promise<{ w: number; h: number; px: number[] }> {
  const png = (await l.screenshot()).toString("base64");
  const blank = await l.page().context().newPage();
  try {
    return await blank.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      return { w: c.width, h: c.height, px: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) };
    }, png);
  } finally {
    await blank.close();
  }
}

/** The pixel row holding the most runs clearing 3:1 against the commonest colour, the
 *  background. A day's bar is a run, so 28 runs is 28 bars each read as its own day. */
async function sparkRuns(l: Locator): Promise<{ runs: number; peak: number; lowest: number; inked: number }> {
  const { w, h, px } = await paintedPixels(l);
  const at = (x: number, y: number) => px.slice((y * w + x) * 4, (y * w + x) * 4 + 3);
  const tally = new Map<string, number>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tally.set(at(x, y).join(), (tally.get(at(x, y).join()) ?? 0) + 1);
  const bg = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]![0].split(",").map(Number);
  let best = { runs: 0, peak: 0, lowest: 0, inked: 0 };
  for (let y = 0; y < h; y++) {
    const ratios = Array.from({ length: w }, (_, x) => contrastOfRgb(at(x, y), bg));
    const inRun = ratios.flatMap((r, x) => (r >= 3 ? [x] : []));
    const runs = inRun.filter((x, i) => i === 0 || inRun[i - 1] !== x - 1).length;
    const peak = Math.max(...ratios);
    if (runs > best.runs || (runs === best.runs && peak > best.peak)) best = { runs, peak, lowest: inRun.length ? Math.min(...inRun.map((x) => ratios[x]!)) : 0, inked: ratios.filter((r) => r >= 1.2).length / w };
  }
  return best;
}

for (const scale of [1, 2]) {
  test.describe(`at device scale ${scale}`, () => {
    test.use({ deviceScaleFactor: scale });
    for (const theme of THEMES.slice(0, 4)) {
      test(`each of a sparkline's 28 bars paints as its own day at 3:1, on a tile and a compact row, in the ${theme.label} theme`, async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.emulateMedia({ colorScheme: theme.scheme });
        await page.addInitScript((v) => localStorage.setItem("muninn-theme", v!), theme.stored);
        await openSettled(page, BOARD_TALL);
        const card = boardCard(page);
        const row = (id: string) => card.locator(`.wiki-wm-kid[data-effort-id="${id}"] > svg.wiki-wm-spark`);
        const tile = (id: string) => card.locator(`.wiki-wm-tile[data-effort-id="${id}"] > svg.wiki-wm-spark`);
        const read = async (targets: [string, Locator][]) => {
          for (const [what, l] of targets) {
            const r = await sparkRuns(l);
            console.log(`spark ${theme.label} x${scale} ${what}: ${r.runs} bars, peak ${r.peak.toFixed(2)}, lowest ${r.lowest.toFixed(2)}`);
            expect(r.runs, `${what} at x${scale}: peak ${r.peak.toFixed(2)}`).toBe(28);
          }
        };
        await read([["row, all zero", row("kid-idle")], ["row, one bar", row("kid-two")], ["tile, all zero", tile("moving-b")], ["tile, one bar", tile("moving-a")]]);
        // The narrowest tile a track gives.
        await card.locator(".wiki-wm-cols").evaluate((el) => ((el as HTMLElement).style.gridTemplateColumns = "200px"));
        await read([["200 px tile, all zero", tile("moving-b")], ["200 px tile, one bar", tile("moving-a")]]);
      });
    }
  });
}

// A crisp 1 px bar scaled below a pixel can miss every pixel centre, so below 1x the row
// keeps its soft bars: fainter than 3:1, but each still paints. Emulated deviceScaleFactor
// misreads fractional scales, so this pins the ink and not its ratio.
test.describe("at device scale 0.9", () => {
  test.use({ deviceScaleFactor: 0.9 });
  test("a compact row's baseline keeps its ink", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSettled(page, BOARD_TALL);
    const r = await sparkRuns(boardCard(page).locator('.wiki-wm-kid[data-effort-id="kid-idle"] > svg.wiki-wm-spark'));
    console.log(`spark x0.9 row: inked ${r.inked.toFixed(2)}, peak ${r.peak.toFixed(2)}`);
    expect(r.inked).toBeGreaterThan(0.8);
  });
});
