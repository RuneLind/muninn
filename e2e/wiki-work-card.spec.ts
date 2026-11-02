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
 *     refresh though the run did not move, first in the effort and not behind
 *     «+N more».
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
 *     it fails, and a themes map that never asks.
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

type NeedFixture = { title: string; kind: string; why: string; action: string; pages: string[] };

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

/** A stale map that renders every part of the card: all six states, a nested
 *  and a part-of sub-effort, an active day, `+N more`, a next step, a
 *  coverage warning, a clamped why and a Needs-you item with page links. */
function sweepMapJson(runAtMs: number): string {
  const m = JSON.parse(mapJson(SWEEP, runAtMs, [
    { title: "Settle ⟦plans/alpha.mdx⟧", kind: "decision", why: LONG_WHY, action: "Pick one draft.", pages: ["plans/beta.mdx", "plans/gamma.mdx"] },
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
    e("shipped", "shipped", ["plans/gamma.mdx"]),
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
      WIKI_ANSWER_WIKIS: [STRIP, STRIP_GROW, STRIP_LONG, STRIP_KEEP_CELL, STRIP_KEEP_MORE, STRIP_KEEP_OPEN, SWEEP].join(","),
      WIKI_ANSWER_OWNER: "Test Owner (T000001)",
      WIKI_ANSWER_GROUPS: "utvikler=T000001",
      WIKI_EXTRA: [GH, FRESH, STALE, DONE, NONE, LONG, FLIP, GROW, GROW_ERR, GROW_LATE, FB, SWEEP, DECL, STRIP, STRIP_OFF, STRIP_GROW, STRIP_LONG, STRIP_KEEP_CELL, STRIP_KEEP_MORE, STRIP_KEEP_OPEN, THEME_HOLD, P_LOAD, P_LATE, P_LATE5, P_POST, P_POLL, P_FOCUS, P_DUP, P_WHY].map((n) => `${n}=${roots[n]}`).join(","),
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
  // Lanes: Moving open, the other two closed.
  await expect(card.locator('[data-wm-lane="moving"]')).toHaveAttribute("open", "");
  await expect(card.locator('[data-wm-lane="cooling"]')).not.toHaveAttribute("open", "");
  await expect(card.locator('[data-wm-lane="quiet"]')).not.toHaveAttribute("open", "");
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
  await openStart(page, LONG);
  const card = page.locator("#wikiWorkCard");
  const text = card.locator(".wiki-wm-why-text");
  const more = card.locator(".wiki-wm-why-more");
  const lines = () => text.evaluate((el) => Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)));
  expect(await lines()).toBe(2);
  expect(await text.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
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
  expect(await lines()).toBeGreaterThan(2);
  await expect(more).toBeFocused();
  await page.keyboard.press("Space");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  expect(await lines()).toBe(2);
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
  await openStart(page, LONG);
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
  await openStart(page, LONG);
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

test("a page declared after the load joins its seven-page effort on a listing refresh, among the first six (P6)", async ({ page }) => {
  await page.clock.install();
  await openStart(page, DECL);
  const alpha = page.locator('#wikiWorkCard .wiki-wm-effort[data-effort-id="alpha"]');
  await expect(alpha.locator(".wiki-wm-more")).toHaveText(" +1 more");
  // The run does not move: only the listing learns of the declaration.
  await writeFile(path.join(roots[DECL]!, "plans/declared-today.mdx"), `---\ntitle: Declared today\neffort: alpha\n---\n\nWritten after the run.\n`, "utf8");
  await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.locator("#wikiList")).toContainText("Declared today");
  // On the card without a reload, first in the effort, not behind «+N more».
  const links = alpha.locator(".wiki-wm-pages .wiki-wm-link");
  await expect(links.first()).toHaveText("Declared today");
  await expect(links).toHaveCount(6);
  await expect(alpha.locator(".wiki-wm-more")).toHaveText(" +2 more");
});

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
  return { at: Date.now(), checked: 5, unchecked: 0, unlinked: 0, skipped: 0, contradictions: [], prs: {}, needs: [], uncheckedRows: [], unlinkedRows: [], ...over };
}

const GH_NEEDS: WorkMapChecksBody["needs"] = [
  { kind: "followup", title: "Merge the fix", pr: 369, state: "MERGED", mergedAt: GH_MERGED_AT, asksForIt: true },
  { kind: "followup", title: "Closed one", pr: 12, state: "CLOSED", mergedAt: null, asksForIt: true },
  { kind: "followup", title: "Only mentions", pr: 3556, state: "MERGED", mergedAt: "2026-10-28T12:00:00Z", asksForIt: false },
  { kind: "followup", title: "Asks for two", pr: 1, state: "MERGED", mergedAt: GH_MERGED_AT, asksForIt: true },
  { kind: "followup", title: "Asks for two", pr: 2, state: "OPEN", mergedAt: null, asksForIt: true },
];

/** Stub the checks GET; returns the request count. */
async function stubChecks(page: Page, answer: (n: number) => WorkMapChecksBody): Promise<{ count: () => number }> {
  let n = 0;
  await page.route("**/api/wiki/work-map/checks*", (route) => route.fulfill({ json: answer(++n) }));
  return { count: () => n };
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
  // No cell's word pokes out of its box at this width.
  expect(await card.locator(".wiki-wm-cell").evaluateAll((els) => els.every((e) => e.scrollWidth <= e.clientWidth))).toBe(true);

  await cell.click();
  const rows = card.locator('[data-wm-drill="github"] .wiki-wm-drill-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Alpha plan");
  await expect(rows.nth(0)).toContainText("says open · GitHub: #369 merged 29.10");
  await expect(rows.nth(0).locator('a[href="https://github.com/acme/gears/pull/369"]')).toBeVisible();
  await expect(rows.nth(1)).toContainText("#4 not checked");
  await expect(rows.nth(2)).toContainText("row with no link: no full PR link");

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
  for (const n of [2, 3, 4]) {
    await page.clock.runFor(15_000);
    await expect.poll(() => stub.count()).toBe(n);
  }
  await expect(cell).toContainText("3 not checked");
  await expect(cell).not.toContainText("refreshing");
  await page.clock.runFor(60_000);
  await page.waitForTimeout(100);
  expect(stub.count()).toBe(4);
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
    // Its long remedy takes a row of its own; nothing overflows.
    expect(await cell.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const boxes = await card.locator(".wiki-wm-cell").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })));
    expect(new Set(boxes.slice(0, 4).map((b) => b.top)).size).toBe(1);
    expect(boxes[4]!.top).toBeGreaterThanOrEqual(boxes[0]!.bottom);
    await cell.click();
    await expect(card.locator('[data-wm-drill="github"]')).toContainText("closed without merge");
  });
}

test("a checks GET that fails says «not checked», and the next start view asks again", async ({ page }) => {
  let n = 0;
  await page.route("**/api/wiki/work-map/checks*", (route) => (++n === 1 ? route.fulfill({ status: 500, json: { error: "x" } }) : route.fulfill({ json: checksBody() })));
  await openStart(page, GH);
  const card = page.locator("#wikiWorkCard");
  const cell = card.locator('[data-wm-cell="github"]');
  await expect(cell).toContainText("not checked");
  await expect(cell.locator("b")).toHaveText("—");
  await card.locator('.wiki-wm-pages a[data-relpath], .wiki-wm-summary a[data-relpath]').first().click();
  await expect(page.locator(".wiki-start")).toHaveCount(0);
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
    await openStart(page, STRIP_LONG);
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
  await openStart(page, FRESH);
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
  const link = card.locator('.wiki-wm-link[data-relpath="plans/alpha.mdx"]').nth(2);
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
    await openStart(page, FRESH);
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
    await openStart(page, STRIP);
    const card = page.locator("#wikiWorkCard");
    const open = card.locator('[data-wm-cell="decisions"]');
    const next = card.locator('[data-wm-cell="oldest"]');
    const shut = card.locator('[data-wm-cell="steps"]');
    const accent = await token(page, "--accent");
    const paint = (l: typeof open) =>
      l.evaluate((el) => {
        const c = getComputedStyle(el);
        return { outline: `${c.outlineStyle} ${c.outlineWidth}`, outlineColor: c.outlineColor, shadow: c.boxShadow, border: c.borderTopColor };
      });
    await open.focus();
    await page.keyboard.press("Enter");
    await expect(open).toHaveAttribute("aria-expanded", "true");
    await expect(open).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(next).toBeFocused();
    const closedFocused = await paint(next);
    const openAtRest = await paint(open);
    const closedAtRest = await paint(shut);
    await page.keyboard.press("Shift+Tab");
    await expect(open).toBeFocused();
    expect(await open.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
    const openFocused = await paint(open);
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

/** All a cell's border, ring and shadow paint: what a state change has to move. */
function cellPaint(cell: Locator) {
  return cell.evaluate((el) => {
    const c = getComputedStyle(el);
    return { outline: `${c.outlineStyle} ${c.outlineWidth}`, outlineColor: c.outlineColor, shadow: c.boxShadow, border: c.borderTopColor, borderWidth: c.borderTopWidth };
  });
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
      await openStart(page, STRIP);
      const open = page.locator('#wikiWorkCard [data-wm-cell="decisions"]');
      await open.click();
      await expect(open).toHaveAttribute("aria-expanded", "true");
      await page.mouse.move(0, 0);
      const rest = await cellPaint(open);
      await open.hover();
      await expect.poll(() => cellPaint(open)).not.toEqual(rest);
    });

    test("hovering a closed cell paints the accent border, and a disabled cell does not react", async ({ page }) => {
      await openStart(page, STRIP);
      const shut = page.locator('#wikiWorkCard [data-wm-cell="steps"]');
      const rest = await cellPaint(shut);
      expect(rest.border).not.toBe(await token(page, "--accent"));
      await shut.hover();
      await expect.poll(async () => (await cellPaint(shut)).border).toBe(await token(page, "--accent"));
      await page.mouse.move(0, 0);
      await openStart(page, STRIP_OFF);
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
  await openStart(page, STRIP);
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
    await openStart(page, STRIP);
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
    await stubChecks(page, () =>
      checksBody({
        notChecked: { reason: "auth", repos: ["acme/gears"] },
        contradictions: [{ page: "plans/alpha.mdx", pr: 1, repo: "acme/other", rowState: "open", ghState: "MERGED", mergedAt: GH_MERGED_AT }],
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
    expect((await styledCardClasses(page)).filter((c) => !seen.has(c))).toEqual([]);
    console.log(`contrast min ${theme.label}: ${Math.min(...mins).toFixed(2)} (${labels.map((l, i) => `${l} ${mins[i]!.toFixed(2)}`).join(", ")})`);
    expect(low).toEqual([]);
  });
}
