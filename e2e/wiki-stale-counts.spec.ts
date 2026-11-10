/**
 * The Stale check's counts everywhere (plan muninn-wiki-drift-check, PR 2b),
 * end to end.
 *
 * What no unit test can prove, and this spec exists for:
 *
 *   1. **Every surface shows the STALE tab's two numbers (D26, D31)**: the
 *      rail badge and the home's line and Stale tab read the wiki-wide
 *      summary route, the article pill reads the page report, and all of
 *      them equal what the tab shows.
 *   2. **Marks land in the browser on the said words (D21)**: in a list item,
 *      in a paragraph line (bare text: the reader emits no `<p>`) and in a
 *      table row (the link in one cell, the word in the next). A confirmed
 *      line beats a longer line that holds all its words; a hit two identical
 *      lines share gets no mark while the tab still lists it.
 *   3. **Navigation paints no other page's counts**: a page's report that is
 *      still in flight shows no pill and no marks, and a report for a page
 *      the reader left that answers late paints nothing.
 *   4. **Not a status drops every surface with the tab.**
 *   5. **A read-only instance shows none of it (D25)** and never asks for the
 *      summary.
 *
 * **What is stubbed and why.** Nothing reaches a model: the confirm loop's
 * one output, a `status-line` verdict row, is inserted under the key D22
 * defines (sha256 over `status-line/v3`, the page, the line's text, its
 * status words, the target, its `plan_status` and its own title, NUL-joined),
 * as `wiki-stale-tab.spec.ts` does.
 *
 * Ports from `e2e/ports.ts`; `e2eEnv()` blanks the platform tokens and the
 * instance-profile flags; the bot lives under a temp `MUNINN_BOTS_DIR`.
 */

import { test, expect, type Page, type Route } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

const PORT = e2ePort("wiki-stale-counts");
const RO_PORT = e2ePort("wiki-stale-counts/readonly");
const BASE = `http://127.0.0.1:${PORT}`;
const RO_BASE = `http://127.0.0.1:${RO_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2estalecounts";
const BOT = "e2estalecountsbot";
const DAY = 86_400_000;

const LI_LINE = "- [[p]] is in-flight, two PRs open";
const PARA_LINE = "The plan [[q]] pågår fortsatt i år.";
const ROW_LINE = "| [[p]] | blokkert |";
/** Two identical lines: one key, two hits, no unique mark for either. */
const TWIN_LINE = "- [[q]] is a draft still";
const UNCONFIRMED_LINE = "- [[p]] is proposed per the old note";
/** A confirmed line and, before it, an unconfirmed line holding all its words
 *  and more: both score 1, the exact line fits better, so the mark lands on
 *  NEAR_LINE and never on the decoy above it. */
const NEAR_DECOY_LINE = "- [[p]] is a draft still, per the review";
const NEAR_LINE = "- [[p]] is a draft still";
const HUB2_LINE = "- [[p]] is blocked now";

/** hub.md: 6 confirmed stale lines (the twins count twice) and 1 page to check. */
const HUB_TEXT = "⚠ 6 stale status lines · 1 linking page to check";
const HUB2_TEXT = "⚠ 1 stale status line · 0 linking pages to check";

const page = (title: string, body: string, extra = "") => `---\ntitle: ${title}\n${extra}---\n\n${body}\n`;

let root = "";
let botsRoot = "";
let server: ChildProcess | undefined;
let roServer: ChildProcess | undefined;
let sql: ReturnType<typeof postgres> | null = null;

function git(args: string[], atMs?: number): void {
  const date = atMs === undefined ? undefined : new Date(atMs).toISOString();
  execFileSync("git", ["-C", root, ...args], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "e2e",
      GIT_AUTHOR_EMAIL: "e2e@example.invalid",
      GIT_COMMITTER_NAME: "e2e",
      GIT_COMMITTER_EMAIL: "e2e@example.invalid",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  });
}

async function write(rel: string, body: string): Promise<void> {
  await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
  await writeFile(path.join(root, rel), body, "utf8");
}

/** D22's status-line key, spelled out independently of the server. */
const statusLineKey = (pageRel: string, text: string, said: string[], target: string, now: string, title: string) =>
  createHash("sha256")
    .update(["status-line/v3", pageRel, text, said.join(","), target, now, title].join("\0"))
    .digest("hex");

function boot(port: number, extra: Record<string, string>): ChildProcess {
  return spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(port),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      MUNINN_BOTS_DIR: botsRoot,
      WIKI_EXTRA: `${WIKI}=${root}=${WIKI}=${BOT}`,
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      HAIKU_BACKEND: "",
      ...extra,
    },
    stdio: "ignore",
  });
}

async function waitUp(base: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/live`)).ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`muninn did not start at ${base}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-stale-counts-"));
  botsRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-stale-counts-bots-"));
  await mkdir(path.join(botsRoot, BOT), { recursive: true });
  await writeFile(path.join(botsRoot, BOT, "CLAUDE.md"), "# e2e stale counts bot\n");
  await writeFile(path.join(botsRoot, BOT, "config.json"), JSON.stringify({ connector: "claude-cli" }));

  const now = Date.now();
  git(["init", "-q", "-b", "main"]);
  await write("plans/p.md", page("P", "The plan.", "plan_status: shipped\n"));
  await write("plans/q.md", page("Q", "The other plan.", "plan_status: shipped\n"));
  await write("notes/old.md", page("Old", "The pin in [[hub]] landed on 23.05."));
  await write("hub.md", page("Hub", "First."));
  await write("hub2.md", page("Hub two", `${HUB2_LINE}\n\nThe second hub.`));
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"], now - 30 * DAY);
  await write(
    "hub.md",
    page(
      "Hub",
      [
        LI_LINE,
        "- another item",
        "",
        PARA_LINE,
        "A second line of the same paragraph.",
        "",
        "| Plan | State |",
        "|---|---|",
        ROW_LINE,
        "",
        TWIN_LINE,
        TWIN_LINE,
        "",
        UNCONFIRMED_LINE,
        "",
        NEAR_DECOY_LINE,
        NEAR_LINE,
        "",
        "The pin moved.",
      ].join("\n"),
    ),
  );
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "hub: the pin moves"], now - DAY);

  sql = postgres(TEST_DB, { max: 2 });
  await sql`DELETE FROM wiki_stale_verdicts WHERE wiki = ${WIKI}`;
  const rows: [string, string, string, string, string][] = [
    ["hub.md", LI_LINE, "in-flight", "plans/p.md", "P"],
    ["hub.md", PARA_LINE, "in-flight", "plans/q.md", "Q"],
    ["hub.md", ROW_LINE, "blocked", "plans/p.md", "P"],
    ["hub.md", TWIN_LINE, "proposed", "plans/q.md", "Q"],
    ["hub.md", NEAR_LINE, "proposed", "plans/p.md", "P"],
    ["hub2.md", HUB2_LINE, "blocked", "plans/p.md", "P"],
  ];
  for (const [pg, text, said, target, title] of rows) {
    await sql`
      INSERT INTO wiki_stale_verdicts (wiki, kind, page, key_hash, verdict, reason, checked_by)
      VALUES (${WIKI}, 'status-line', ${pg}, ${statusLineKey(pg, text, [said], target, "shipped", title)}, 'stale', 'E2E: the plan shipped', 'model:e2e')
    `;
  }

  server = boot(PORT, {});
  roServer = boot(RO_PORT, { MUNINN_WIKI_READONLY: "1" });
  await Promise.all([waitUp(BASE), waitUp(RO_BASE)]);
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  roServer?.kill("SIGTERM");
  try {
    if (sql) await sql`DELETE FROM wiki_stale_verdicts WHERE wiki = ${WIKI}`;
  } finally {
    await sql?.end();
  }
  await rm(root, { recursive: true, force: true });
  await rm(botsRoot, { recursive: true, force: true });
});

async function open(p: Page, rel: string, text: string, base = BASE): Promise<void> {
  await p.goto(`${base}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);
  await expect(p.locator(".wiki-article")).toContainText(text);
}

const pill = (p: Page) => p.locator("#wikiStalePill [data-stale-pill]");
const marks = (p: Page) => p.locator(".wiki-article mark.wiki-stale-mark");
/** The status date line beside the pill (first-screen-claims P3). */
const dateLine = (p: Page) => p.locator("#wikiStatusDate [data-status-date]");
/** What the pill's slot and the line's slot hold, and that the line's slot comes right after the pill's. */
const slots = (p: Page) =>
  p.evaluate(() => {
    const tags = (id: string) => Array.from(document.getElementById(id)?.children ?? [], (c) => c.tagName);
    return { pill: tags("wikiStalePill"), line: tags("wikiStatusDate"), next: document.getElementById("wikiStalePill")?.nextElementSibling?.id };
  });
const LATE = { verdict: "late", statusDate: "2026-11-03", newest: { pr: "RuneLind/muninn#802", repo: "RuneLind/muninn", n: 802, mergedAt: "2026-11-04T09:12:00Z", mergedDay: "2026-11-04" } };
const LATE_TEXT = "⚠ status older than a merged PR (muninn#802, 04.11)";
const CLEAR = { ...LATE, verdict: "clear", statusDate: "2026-11-05" };
const CLEAR_TEXT = "status dated on or after its last merged PR (muninn#802, 04.11)";

/** Answer the status date check for `rel` with `json`, once `gate` (if any) lets it through. Returns the URLs asked. */
async function answerClaimCheck(p: Page, rel: string, answer: { status?: number; json: unknown }, gate?: Promise<void>): Promise<string[]> {
  const asked: string[] = [];
  await p.route(
    (u) => u.pathname === "/api/wiki/claim-check" && u.searchParams.get("relPath") === rel,
    async (route: Route) => {
      asked.push(route.request().url());
      await gate;
      await route.fulfill({ status: answer.status ?? 200, json: answer.json }).catch(() => {});
    },
  );
  return asked;
}
const railBadge = (p: Page, rel: string) => p.locator(`.wiki-list-item[data-relpath="${rel}"] .wiki-stale-rail`);

/** Each mark's text and where it sits: its list item, table row, or neither (a paragraph line). */
async function markPlaces(p: Page): Promise<string[]> {
  return marks(p).evaluateAll((els) =>
    els.map((m) => `${m.textContent}@${m.closest("tr") ? "tr" : m.closest("li") ? "li" : "text"}`),
  );
}

/** The near pair and the twins: the draft mark sits on NEAR_LINE, not on its
 *  decoy, and neither twin (target q) holds a mark. */
async function expectDraftMarks(p: Page): Promise<void> {
  const items = await marks(p).evaluateAll((els) =>
    els.filter((m) => m.textContent === "draft").map((m) => m.closest("li")?.textContent?.trim() ?? ""),
  );
  expect(items).toHaveLength(1);
  expect(items[0]).toMatch(/is a draft still$/);
  await expect(p.locator('.wiki-article li:has(a[data-relpath="plans/q.md"]) mark.wiki-stale-mark')).toHaveCount(0);
}

/** Hold the page report for `rel` until the returned release is called. */
async function holdReport(p: Page, rel: string): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  await p.route(
    (u) => u.pathname === "/api/wiki/stale" && u.searchParams.get("page") === rel,
    async (route: Route) => {
      await gate;
      await route.continue().catch(() => {});
    },
  );
  return release;
}

test("the pill, the rail badge, the marks and the home show the STALE tab's numbers (D26, D21)", async ({ page: p }) => {
  await open(p, "hub.md", "The pin moved.");
  await expect(p.locator("#wikiStaleCount")).toHaveText("6 · 1");
  await p.locator('.wiki-conn-tab[data-conntab="stale"]').click();
  const head = p.locator("#staleBody .wiki-stale-head");
  await expect(head).toHaveText(HUB_TEXT);
  // The tab lists all six confirmed lines, the unmarked ones included.
  await expect(p.locator("#staleBody [data-stale-hit]")).toHaveCount(6);
  await expect(pill(p)).toHaveText(HUB_TEXT);
  await expect(railBadge(p, "hub.md")).toHaveText("⚠ 6 · 1");
  await expect(railBadge(p, "hub2.md")).toHaveText("⚠ 1 · 0");
  // Four marks: two list items, a paragraph line and a table row. The near
  // line beats its decoy (exact over superset); the twins tie, so neither is
  // marked; nor are unconfirmed lines.
  await expect(marks(p)).toHaveCount(4);
  expect((await markPlaces(p)).sort()).toEqual(["blokkert@tr", "draft@li", "in-flight@li", "pågår@text"]);
  await expectDraftMarks(p);
  // The pill opens the tab.
  await p.locator('.wiki-conn-tab[data-conntab="conn"]').click();
  await pill(p).click();
  await expect(p.locator('.wiki-conn-tab[data-conntab="stale"]')).toHaveClass(/\bactive\b/);

  // The home: the line's totals and the Stale tab's rows say the same.
  await p.goto(`${BASE}/wiki?wiki=${WIKI}`);
  await expect(p.locator("#wikiStaleHome [data-stale-home-totals]")).toHaveText("⚠ 7 stale status lines · 1 linking page to check on 2 pages");
  // On the home no page report exists: the rail's badges come from the summary alone.
  await expect(railBadge(p, "hub.md")).toHaveText("⚠ 6 · 1");
  await p.locator("#wikiStaleHome [data-stale-home-open]").click();
  await expect(p.locator('.wiki-tab[data-tab="stale"]')).toHaveClass(/\bactive\b/);
  await expect(p.locator('.wiki-stale-home-row[data-relpath="hub.md"] .wiki-stale-home-counts')).toHaveText(HUB_TEXT);
  await expect(p.locator('.wiki-stale-home-row[data-relpath="hub2.md"] .wiki-stale-home-counts')).toHaveText(HUB2_TEXT);
  // A row opens its page.
  await p.locator('.wiki-stale-home-row[data-relpath="hub2.md"]').click();
  await expect(p.locator(".wiki-article")).toContainText("The second hub.");
  await expect(pill(p)).toHaveText(HUB2_TEXT);
});

test("navigating away and back paints no other page's counts or marks", async ({ page: p }) => {
  await open(p, "hub.md", "The pin moved.");
  await expect(pill(p)).toHaveText(HUB_TEXT);
  await expect(marks(p)).toHaveCount(4);

  // hub2's report is in flight: no pill, no marks, never hub's.
  const releaseHub2 = await holdReport(p, "hub2.md");
  await p.locator('.wiki-list-item[data-relpath="hub2.md"]').click();
  await expect(p.locator(".wiki-article")).toContainText("The second hub.");
  await expect(p.locator("#wikiStalePill")).toBeEmpty();
  await expect(marks(p)).toHaveCount(0);
  releaseHub2();
  await expect(pill(p)).toHaveText(HUB2_TEXT);
  await expect(marks(p)).toHaveCount(1);
  await p.unroute((u) => u.pathname === "/api/wiki/stale" && u.searchParams.get("page") === "hub2.md");

  // hub's report answers after the reader has moved on to hub2: it paints nothing.
  const releaseHub = await holdReport(p, "hub.md");
  await p.locator('.wiki-list-item[data-relpath="hub.md"]').click();
  await expect(p.locator(".wiki-article")).toContainText("The pin moved.");
  await expect(p.locator("#wikiStalePill")).toBeEmpty();
  await p.locator('.wiki-list-item[data-relpath="hub2.md"]').click();
  await expect(p.locator(".wiki-article")).toContainText("The second hub.");
  await expect(pill(p)).toHaveText(HUB2_TEXT);
  const late = p.waitForResponse((r) => r.url().includes("/api/wiki/stale?") && r.url().includes("page=hub.md"));
  releaseHub();
  await late;
  // Give the late answer a turn to (wrongly) paint.
  await p.waitForTimeout(300);
  await expect(pill(p)).toHaveText(HUB2_TEXT);
  await expect(marks(p)).toHaveCount(1);
  await expect(p.locator("#wikiStaleCount")).toHaveText("1 · 0");
  await expect(railBadge(p, "hub.md")).toHaveText("⚠ 6 · 1");
});

test("the open page's rail row follows its own report when the summary is older", async ({ page: p }) => {
  await open(p, "hub.md", "The pin moved.");
  await expect(railBadge(p, "hub2.md")).toHaveText("⚠ 1 · 0");
  // hub2's confirmation goes after the summary was read: its report says so,
  // and its rail row must agree with its pill, not with the older summary.
  const [row] = await sql!`DELETE FROM wiki_stale_verdicts WHERE wiki = ${WIKI} AND page = 'hub2.md' RETURNING *`;
  try {
    await p.locator('.wiki-list-item[data-relpath="hub2.md"]').click();
    await expect(p.locator(".wiki-article")).toContainText("The second hub.");
    await expect(pill(p)).toHaveText("0 stale status lines · 0 linking pages to check");
    await expect(railBadge(p, "hub2.md")).toHaveCount(0);
    await expect(railBadge(p, "hub.md")).toHaveText("⚠ 6 · 1");
    // Leaving hub2 repaints the rail: its row keeps what its pill showed, not
    // the boot summary's «⚠ 1 · 0» (fix round 1).
    await p.locator('.wiki-list-item[data-relpath="hub.md"]').click();
    await expect(p.locator(".wiki-article")).toContainText("The pin moved.");
    await expect(pill(p)).toHaveText(HUB_TEXT);
    await expect(railBadge(p, "hub.md")).toHaveText("⚠ 6 · 1");
    await expect(railBadge(p, "hub2.md")).toHaveCount(0);
  } finally {
    await sql!`INSERT INTO wiki_stale_verdicts ${sql!(row!)}`;
  }
});

test("the status date line sits beside the pill and says what was compared", async ({ page: p }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const asked = await answerClaimCheck(p, "hub.md", { json: LATE }, gate);
  await open(p, "hub.md", "The pin moved.");
  // The answer arrives after the Stale check's report has painted the pill: it paints itself.
  await expect(pill(p)).toHaveText(HUB_TEXT);
  await expect(dateLine(p)).toHaveCount(0);
  release();
  await expect(dateLine(p)).toHaveText(LATE_TEXT);
  await expect(dateLine(p)).toHaveAttribute("data-status-date", "late");
  await expect(dateLine(p)).toHaveAttribute(
    "title",
    "status_date 2026-11-03 is older than a merge among the page's prs: RuneLind/muninn#802, merged 2026-11-04. The check compares these two dates and reads no status line.",
  );
  // The Stale check's pill keeps its own text and is still the one button in the slot.
  await expect(pill(p)).toHaveText(HUB_TEXT);
  expect(await slots(p)).toEqual({ pill: ["BUTTON"], line: ["SPAN"], next: "wikiStatusDate" });
  // Asked once, by the wiki's name and the page's path.
  expect(asked).toHaveLength(1);
  const url = new URL(asked[0]!);
  expect([url.searchParams.get("wiki"), url.searchParams.get("relPath")]).toEqual([WIKI, "hub.md"]);
  // The late line is drawn as a warning, in the pill's tint resolved on a body probe; the clear line has no fill.
  // `toHaveCSS` reads the span in the slot at that moment: a repaint replaces it.
  const tint = await p.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.background = "color-mix(in srgb, var(--status-warning) 14%, transparent)";
    const fill = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return fill;
  });
  expect(tint).not.toBe("rgba(0, 0, 0, 0)");
  await expect(dateLine(p)).toHaveCSS("background-color", tint);
  await p.unrouteAll({ behavior: "wait" });
  await answerClaimCheck(p, "hub.md", { json: CLEAR });
  await open(p, "hub.md", "The pin moved.");
  await expect(dateLine(p)).toHaveText(CLEAR_TEXT);
  await expect(dateLine(p)).toHaveAttribute("data-status-date", "clear");
  await expect(dateLine(p)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

/** Hold the Stale check's report for `rel` until `gate`; with `fail`, answer it with a page that is no JSON. */
async function holdStaleReport(p: Page, rel: string, gate: Promise<void>, fail = false): Promise<void> {
  await p.route(
    (u) => u.pathname === "/api/wiki/stale" && u.searchParams.get("page") === rel,
    async (route: Route) => {
      await gate;
      await (fail ? route.fulfill({ status: 502, contentType: "text/html", body: "<html>bad gateway</html>" }) : route.continue()).catch(() => {});
    },
  );
}
const twoFrames = (p: Page) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

test("the line waits for the Stale check's report: it is not painted before the pill", async ({ page: p }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  await holdStaleReport(p, "hub.md", gate);
  await answerClaimCheck(p, "hub.md", { json: LATE });
  const answered = p.waitForResponse((r) => new URL(r.url()).pathname === "/api/wiki/claim-check");
  await p.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=hub.md`);
  await expect(p.locator(".wiki-article")).toContainText("The pin moved.");
  await answered;
  await twoFrames(p);
  // The check has answered and the report has not: both slots are still empty.
  await expect(p.locator("#wikiStalePill")).toBeEmpty();
  await expect(p.locator("#wikiStatusDate")).toBeEmpty();
  release();
  await expect(pill(p)).toHaveText(HUB_TEXT);
  await expect(dateLine(p)).toHaveText(LATE_TEXT);
  expect(await slots(p)).toEqual({ pill: ["BUTTON"], line: ["SPAN"], next: "wikiStatusDate" });
});

test("a Stale report that failed leaves the line, with no pill", async ({ page: p }) => {
  await holdStaleReport(p, "hub.md", Promise.resolve(), true);
  await answerClaimCheck(p, "hub.md", { json: LATE });
  await p.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=hub.md`);
  await expect(p.locator(".wiki-article")).toContainText("The pin moved.");
  await expect(dateLine(p)).toHaveText(LATE_TEXT);
  await expect(pill(p)).toHaveCount(0);
});

test("the line arriving leaves the pill's button in place: its focus, and where the article is scrolled", async ({ page: p }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  await answerClaimCheck(p, "hub.md", { json: LATE }, gate);
  await open(p, "hub.md", "The pin moved.");
  await expect(pill(p)).toHaveText(HUB_TEXT);
  await pill(p).evaluate((el) => {
    (el as HTMLElement & { kept?: boolean }).kept = true;
    (el as HTMLElement).focus();
  });
  // The reader scrolls down with focus still on the pill.
  const scrolled = await p.evaluate(() => {
    const wrap = document.getElementById("articleWrap")!;
    const spacer = wrap.querySelector(".wiki-article")!.appendChild(document.createElement("div"));
    spacer.style.height = "4000px";
    wrap.scrollTop = 1500;
    return wrap.scrollTop;
  });
  expect(scrolled).toBe(1500);
  release();
  await expect(dateLine(p)).toHaveText(LATE_TEXT);
  await twoFrames(p);
  // The same button, still focused, and no jump back to the top to show it.
  expect.soft(await pill(p).evaluate((el) => (el as HTMLElement & { kept?: boolean }).kept === true), "the same button").toBe(true);
  expect.soft(await p.evaluate(() => document.getElementById("articleWrap")!.scrollTop), "the article's scroll").toBeGreaterThan(1400);
  await expect(pill(p)).toBeFocused();
});

test("a press on the pill that the line arrives under still opens the STALE tab", async ({ page: p }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  await answerClaimCheck(p, "hub.md", { json: LATE }, gate);
  await open(p, "hub.md", "The pin moved.");
  await expect(pill(p)).toHaveText(HUB_TEXT);
  await p.locator('.wiki-conn-tab[data-conntab="conn"]').click();
  await expect(p.locator('.wiki-conn-tab[data-conntab="stale"]')).not.toHaveClass(/\bactive\b/);
  await pill(p).hover();
  await p.mouse.down();
  release();
  await expect(dateLine(p)).toHaveText(LATE_TEXT);
  await p.mouse.up();
  await expect(p.locator('.wiki-conn-tab[data-conntab="stale"]')).toHaveClass(/\bactive\b/);
});

test("the line arriving takes no focus the reader did not have on the pill", async ({ page: p }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  await answerClaimCheck(p, "hub.md", { json: LATE }, gate);
  await open(p, "hub.md", "The pin moved.");
  await expect(pill(p)).toHaveText(HUB_TEXT);
  release();
  await expect(dateLine(p)).toHaveText(LATE_TEXT);
  await expect(pill(p)).not.toBeFocused();
});

test("a long line wraps as one box at phone width, and the page does not scroll sideways", async ({ page: p }) => {
  const long = { ...LATE, newest: { ...LATE.newest, pr: "navikt/faktureringskomponenten#355", repo: "navikt/faktureringskomponenten", n: 355 } };
  await answerClaimCheck(p, "hub.md", { json: long });
  await p.setViewportSize({ width: 390, height: 800 });
  await p.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=hub.md`);
  await expect(dateLine(p)).toHaveText(LATE_TEXT.replace("muninn#802", "faktureringskomponenten#355"));
  const box = await dateLine(p).evaluate((el) => {
    const row = el.parentElement!.parentElement!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const pillBox = document.querySelector("#wikiStalePill [data-stale-pill]")!.getBoundingClientRect();
    return {
      rects: el.getClientRects().length,
      inside: r.left >= row.left - 0.5 && r.right <= row.right + 0.5,
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      // On a row of its own under the pill: at the row's left edge, with the row's gap between them.
      under: r.top >= pillBox.bottom,
      indent: Math.round(r.left - row.left),
      gap: Math.round(r.top - pillBox.bottom),
    };
  });
  expect(box).toEqual({ rects: 1, inside: true, sideways: false, under: true, indent: 0, gap: 6 });
});

test("the real route's answer for a page that is no live plan gives no line", async ({ page: p }) => {
  const answered = p.waitForResponse((r) => new URL(r.url()).pathname === "/api/wiki/claim-check");
  await open(p, "hub.md", "The pin moved.");
  const res = await answered;
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { verdict: string; reason: string; wiki: string; relPath: string };
  expect([body.verdict, body.wiki, body.relPath]).toEqual(["notChecked", WIKI, "hub.md"]);
  expect(["not-live", "no-prs"]).toContain(body.reason);
  await expect(pill(p)).toHaveText(HUB_TEXT);
  await expect(dateLine(p)).toHaveCount(0);
  // An empty slot takes no place in the row.
  await expect(p.locator("#wikiStatusDate")).toHaveCSS("display", "none");
});

test("a not-checked answer says why, and a failed or unknown one says nothing", async ({ page: p }) => {
  await answerClaimCheck(p, "hub.md", { json: { verdict: "notChecked", reason: "not-asked" } });
  await answerClaimCheck(p, "hub2.md", { status: 500, json: { error: "the status date check failed" } });
  await open(p, "hub.md", "The pin moved.");
  await expect(dateLine(p)).toHaveText("status date not checked: no PR state on hand");
  await expect(dateLine(p)).toHaveAttribute("data-status-date", "unchecked");
  await p.locator('.wiki-list-item[data-relpath="hub2.md"]').click();
  await expect(p.locator(".wiki-article")).toContainText("The second hub.");
  await expect(pill(p)).toBeVisible();
  await expect(dateLine(p)).toHaveCount(0);
});

test("the line follows the page: no other page's answer is painted, early or late", async ({ page: p }) => {
  let releaseHub2: () => void = () => {};
  const hub2Gate = new Promise<void>((r) => (releaseHub2 = r));
  await answerClaimCheck(p, "hub.md", { json: LATE });
  await answerClaimCheck(p, "hub2.md", { json: CLEAR }, hub2Gate);
  await open(p, "hub.md", "The pin moved.");
  await expect(dateLine(p)).toHaveText(LATE_TEXT);
  // hub2's answer is held: hub's line goes with hub's page.
  await p.locator('.wiki-list-item[data-relpath="hub2.md"]').click();
  await expect(p.locator(".wiki-article")).toContainText("The second hub.");
  await expect(pill(p)).toBeVisible();
  await expect(dateLine(p)).toHaveCount(0);
  // Back on hub before hub2's answer arrives: that answer, landing late, paints nothing.
  await p.locator('.wiki-list-item[data-relpath="hub.md"]').click();
  await expect(p.locator(".wiki-article")).toContainText("The pin moved.");
  await expect(dateLine(p)).toHaveText(LATE_TEXT);
  const hub2Answered = p.waitForResponse((r) => r.url().includes("/api/wiki/claim-check") && r.url().includes("hub2.md"));
  releaseHub2();
  await hub2Answered;
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(dateLine(p)).toHaveText(LATE_TEXT);
  await expect(dateLine(p)).toHaveCount(1);
});

test("a read-only instance shows no pill, badge, mark or home line (D25)", async ({ page: p }) => {
  const staleGets: string[] = [];
  p.on("request", (r) => {
    if (r.url().includes("/api/wiki/stale") || r.url().includes("/api/wiki/claim-check")) staleGets.push(r.url());
  });
  await open(p, "hub.md", "The pin moved.", RO_BASE);
  await expect(p.locator(".wiki-list-item[data-relpath='hub.md']")).toBeVisible();
  await expect(p.locator("#wikiStalePill")).toHaveCount(0);
  await expect(p.locator(".wiki-stale-rail")).toHaveCount(0);
  await expect(marks(p)).toHaveCount(0);
  await p.goto(`${RO_BASE}/wiki?wiki=${WIKI}&view=stale`);
  await expect(p.locator('.wiki-tab[data-tab="hubs"]')).toHaveClass(/\bactive\b/);
  await expect(p.locator("#wikiStaleHome")).toHaveCount(0);
  await expect(p.locator('.wiki-tab[data-tab="stale"]')).toHaveCount(0);
  expect(staleGets).toEqual([]);
});

test("the pill reveals the right pane when it is collapsed or in focus mode", async ({ page: p }) => {
  await open(p, "hub.md", "The pin moved.");
  await expect(pill(p)).toHaveText(HUB_TEXT);
  const layout = p.locator(".wiki-layout");
  const staleTab = p.locator('.wiki-conn-tab[data-conntab="stale"]');
  // Collapsed: the pane is a strip, so the tab and its body are hidden until revealed.
  await p.keyboard.press("]");
  await expect(layout).toHaveClass(/\bright-collapsed\b/);
  await expect(staleTab).toBeHidden();
  await pill(p).click();
  await expect(layout).not.toHaveClass(/\bright-collapsed\b/);
  await expect(staleTab).toHaveClass(/\bactive\b/);
  await expect(staleTab).toBeVisible();
  await expect(p.locator("#staleBody .wiki-stale-head")).toBeVisible();
  // Focus mode hides the pane; the pill leaves it.
  await p.locator('.wiki-conn-tab[data-conntab="conn"]').click();
  await p.keyboard.press("f");
  await expect(layout).toHaveClass(/\bfocus-mode\b/);
  await expect(staleTab).toBeHidden();
  await pill(p).click();
  await expect(layout).not.toHaveClass(/\bfocus-mode\b/);
  await expect(staleTab).toHaveClass(/\bactive\b/);
  await expect(p.locator("#staleBody .wiki-stale-head")).toBeVisible();
});

test("a reloaded report whose target status moved re-titles the marks", async ({ page: p }) => {
  // The reload after a verdict answers with the same lines, each target now `done`:
  // the verdict POST is stubbed, so no row is written.
  let moved = false;
  await p.route((u) => u.pathname === "/api/wiki/stale" && u.searchParams.get("page") === "hub.md", async (route: Route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { hits?: { now?: string }[] };
    if (moved) for (const h of body.hits ?? []) h.now = "done";
    await route.fulfill({ response: res, json: body });
  });
  await p.route("**/api/wiki/stale/verdict", (route: Route) => route.fulfill({ status: 200, json: { ok: true } }));
  await open(p, "hub.md", "The pin moved.");
  await expect(marks(p).first()).toHaveAttribute("title", /is shipped$/);
  const placed = await marks(p).count();
  moved = true;
  await p.locator('.wiki-conn-tab[data-conntab="stale"]').click();
  const reloaded = p.waitForResponse((r) => r.url().includes("/api/wiki/stale?") && r.url().includes("page=hub.md"));
  await p.locator('[data-stale-hit="5"] [data-stale-verdict="not-status"]').click();
  await reloaded;
  // Same lines, so the same marks: only their status moved.
  await expect(marks(p).first()).toHaveAttribute("title", /is done$/);
  await expect(marks(p)).toHaveCount(placed);
  for (const t of await marks(p).evaluateAll((els) => els.map((m) => m.getAttribute("title")))) expect(t).toMatch(/is done$/);
});

/** Every wiki-wide summary request the page makes (no `page=`). */
function countSummaries(p: Page): string[] {
  const seen: string[] = [];
  p.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === "/api/wiki/stale" && !u.searchParams.has("page")) seen.push(r.url());
  });
  return seen;
}

test("the home asks for the summary once per visit, not per start-tab switch", async ({ page: p }) => {
  const seen = countSummaries(p);
  await p.goto(`${BASE}/wiki?wiki=${WIKI}`);
  await expect(p.locator("#wikiStaleHome [data-stale-home-totals]")).toBeVisible();
  await p.waitForTimeout(400);
  expect(seen).toHaveLength(1);
  // Start-tab switches and the line's Show are not visits.
  await p.locator('.wiki-tab[data-tab="timeline"]').click();
  await p.locator('.wiki-tab[data-tab="hubs"]').click();
  await p.locator("#wikiStaleHome [data-stale-home-open]").click();
  await expect(p.locator('.wiki-tab[data-tab="stale"]')).toHaveClass(/\bactive\b/);
  await p.waitForTimeout(400);
  expect(seen).toHaveLength(1);
  // Opening a page and coming back home is a visit.
  await p.locator('.wiki-list-item[data-relpath="hub2.md"]').click();
  await expect(p.locator(".wiki-article")).toContainText("The second hub.");
  await p.goBack();
  await expect(p.locator("#wikiStaleHome [data-stale-home-totals]")).toBeVisible();
  await expect.poll(() => seen.length).toBe(2);
  // So is the breadcrumb's way home.
  await p.locator('.wiki-list-item[data-relpath="hub2.md"]').click();
  await expect(p.locator(".wiki-article")).toContainText("The second hub.");
  await p.locator(".wiki-bc-wiki").click();
  await expect(p.locator("#wikiStaleHome [data-stale-home-totals]")).toBeVisible();
  await expect.poll(() => seen.length).toBe(3);
});

test("an older summary answering after a newer one does not repaint", async ({ page: p }) => {
  // The boot summary is read at once (hub2 still stale) but held; the next
  // visit's summary, read after hub2's row is gone, lands first.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let first = true;
  await p.route((u) => u.pathname === "/api/wiki/stale" && !u.searchParams.has("page"), async (route: Route) => {
    if (!first) return route.continue();
    first = false;
    const res = await route.fetch();
    await gate;
    await route.fulfill({ response: res }).catch(() => {});
  });
  await p.goto(`${BASE}/wiki?wiki=${WIKI}`);
  await expect(p.locator(".wiki-list-item[data-relpath='hub2.md']")).toBeVisible();
  const [row] = await sql!`DELETE FROM wiki_stale_verdicts WHERE wiki = ${WIKI} AND page = 'hub2.md' RETURNING *`;
  try {
    await p.locator('.wiki-list-item[data-relpath="hub2.md"]').click();
    await expect(p.locator(".wiki-article")).toContainText("The second hub.");
    const newer = p.waitForResponse((r) => r.url().includes("/api/wiki/stale?") && !r.url().includes("page="));
    await p.goBack();
    await newer;
    const totals = p.locator("#wikiStaleHome [data-stale-home-totals]");
    await expect(totals).toHaveText("⚠ 6 stale status lines · 1 linking page to check on 1 page");
    await expect(railBadge(p, "hub2.md")).toHaveCount(0);
    const late = p.waitForResponse((r) => r.url().includes("/api/wiki/stale?") && !r.url().includes("page="));
    release();
    await late;
    await p.waitForTimeout(300);
    await expect(totals).toHaveText("⚠ 6 stale status lines · 1 linking page to check on 1 page");
    await expect(railBadge(p, "hub2.md")).toHaveCount(0);
  } finally {
    await sql!`INSERT INTO wiki_stale_verdicts ${sql!(row!)}`;
  }
});

// Last: it writes a reader row the tests above must not see.
test("Not a status drops the tab, the pill, the rail badge, the mark and the home together", async ({ page: p }) => {
  await open(p, "hub.md", "The pin moved.");
  await p.locator('.wiki-conn-tab[data-conntab="stale"]').click();
  await expect(pill(p)).toHaveText(HUB_TEXT);
  await expect(marks(p)).toHaveCount(4);
  await p.locator('[data-stale-hit="5"] [data-stale-verdict="not-status"]').click();
  const dropped = "⚠ 5 stale status lines · 1 linking page to check";
  await expect(p.locator("#staleBody .wiki-stale-head")).toHaveText(dropped);
  await expect(p.locator("#wikiStaleCount")).toHaveText("5 · 1");
  await expect(pill(p)).toHaveText(dropped);
  await expect(railBadge(p, "hub.md")).toHaveText("⚠ 5 · 1");
  // Line 5 is LI_LINE: its mark goes, the other three stay.
  await expect(marks(p)).toHaveCount(3);
  expect((await markPlaces(p)).sort()).toEqual(["blokkert@tr", "draft@li", "pågår@text"]);
  await expectDraftMarks(p);
  // Off the page, its row reads the summary again: refreshed, not the old count.
  await p.locator('.wiki-list-item[data-relpath="hub2.md"]').click();
  await expect(pill(p)).toHaveText(HUB2_TEXT);
  await expect(railBadge(p, "hub.md")).toHaveText("⚠ 5 · 1");
  await p.goto(`${BASE}/wiki?wiki=${WIKI}`);
  await expect(p.locator("#wikiStaleHome [data-stale-home-totals]")).toHaveText("⚠ 6 stale status lines · 1 linking page to check on 2 pages");
});
