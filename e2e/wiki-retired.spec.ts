/**
 * RETIRED (culled) pages in the /wiki reader — the rail's `Show retired (N)`
 * toggle, the page banner, and the per-wiki `cullLabels`.
 *
 * What only a browser can show: the rail's rows and counts after the listing,
 * the toggle and the folds store meet; the toggle surviving a reload; the
 * banner's successor link navigating in place; and the banner's colours in
 * both themes. The listing's `culled` bit and the pairing rules it rides are
 * M1's and are unit-tested there (`src/wiki/culled.test.ts`, which also holds
 * the `.html` meta-sniff cases).
 *
 * No model calls: nothing here leaves the process.
 *
 * SPAWN ENV: `e2eEnv()`, as every spec here, so this muninn stays off
 * Telegram/Slack and off the host's instance-profile flags.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { SETTLED_CREATED_LINE, settleWikiMtimes } from "./settled-wiki.ts";
import { contrastOf } from "./contrast.ts";

const PORT = e2ePort("wiki-retired");
const HUGINN_PORT = e2ePort("wiki-retired/huginn");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-retired";
const WIKI_NO = "e2e-retired-no";

/** Settled, so Activity lifts none of these rows. */
function md(title: string, extra: string[] = [], body = "Body."): string {
  return ["---", `title: ${title}`, SETTLED_CREATED_LINE, ...extra, "---", "", body, ""].join("\n");
}
function html(title: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p></body></html>`;
}
const retired = (reason: string, extra: string[] = []) => ["signal: none", `signal-reason: ${reason}`, ...extra];

const SUCCESSOR = "concepts/successor.md";
const OLD = "archive/old.md";
const TWIN = "plans/twin.md";
const TWIN_HTML = "plans/twin.html";
const NEWER = "plans/newer.md";
const OLDER = "plans/older.md";
const PARENT = "plans/live-parent.md";
const PARENT_PROTO = "plans/live-parent-prototype.html";
const DEAD_CHILD = "plans/dead-child.md";
const S_HEAD = "series/s-head.md";
const S_A = "series/s-a.md";
const S_B = "series/s-b.md";

const SERIES_LABEL = "Retire series";
const OLD_REASON = "Folded into the concept page";

/**
 * One wiki, every case at once:
 *  - `archive/old` retired, its successor in ANOTHER folder (`concepts/`), and
 *    linked from that successor, so it shows up in Connections;
 *  - `plans/twin` retired with a same-stem `.html` twin, which hides with it;
 *  - `plans/newer` retired, superseding `plans/older` — which therefore lists
 *    at top level rather than under a hidden row;
 *  - `plans/dead-child` retired UNDER a live parent (`superseded_by` it), next
 *    to a live `-prototype` sibling, so the parent's chip loses one count;
 *  - a three-member series whose newest, labelled head is retired.
 */
const PAGES: Array<[string, string]> = [
  [SUCCESSOR, md("Successor concept", [], "Replaces [[archive/old]].")],
  [OLD, md("Old archive page", retired(OLD_REASON, ["superseded_by: [[concepts/successor]]"]))],
  [TWIN, md("Twin page", retired("Scaffold"))],
  [TWIN_HTML, html("Twin diagram")],
  [NEWER, md("Newer plan", retired("Abandoned"))],
  [OLDER, md("Older plan", ["superseded_by: [[newer]]"])],
  [PARENT, md("Live parent")],
  [PARENT_PROTO, html("Live parent mock")],
  [DEAD_CHILD, md("Dead child", retired("Superseded", ["superseded_by: [[live-parent]]"]))],
  [S_HEAD, md("Series head", retired("Done", ["series: retire", `series_label: ${SERIES_LABEL}`, "plan_status: shipped", "status_date: 2026-09-01"]))],
  [S_A, md("Series A", ["series: retire", "plan_status: shipped", "status_date: 2026-05-01"])],
  [S_B, md("Series B", ["series: retire", "plan_status: shipped", "status_date: 2026-04-01"])],
];
const ALL = PAGES.length;
const CULLED = [OLD, TWIN, TWIN_HTML, NEWER, DEAD_CHILD, S_HEAD];
const LIVE = ALL - CULLED.length;

/** The Norwegian wiki: one retired page linked from one live page. */
const NO_LIVE = "concepts/ny.md";
const NO_OLD = "archive/gammel.md";
const NO_LABELS = { toggle: "Vis utfasede ({n})", banner: "Utfaset", marker: "Utfaset", successor: "Erstattet av" };

/**
 * Fix round 1's wikis.
 *  - ALPHA: a series whose NEWEST in-flight plan is retired — the `▸` and the
 *    strip's `continue at:` must point at the newest LIVE plan instead.
 *  - HUBS: untyped pages whose only backlinked page is retired, so Hubs has
 *    nothing to show while the toggle is off.
 *  - ATLAS: typed pages (a source linking two concepts, one retired), so the
 *    Atlas has a Concepts column the toggle can shrink.
 */
const WIKI_ALPHA = "e2e-retired-alpha";
const A1 = "plans/alpha-1.md";
const A2 = "plans/alpha-2.md";
const A3 = "plans/alpha-3.md";
const WIKI_HUBS = "e2e-retired-hubs";
const H_LIVE = "notes/live.md";
const H_OLD = "notes/old.md";
const WIKI_ATLAS = "e2e-retired-atlas";
const AT_SRC = "sources/src.md";
const AT_LIVE = "concepts/live-concept.md";
const AT_OLD = "concepts/old-concept.md";
/**
 * Fix round 2's wikis.
 *  - CAP: 60 live and 11 retired entities, one type column over the server's
 *    full-column cap (70), so the cap hides the 11 retired ones with 10 live
 *    ones; plus the topics: a retired concept alone (`gone`), and a retired
 *    concept whose name a live concept carries (`twin-topic`).
 *  - SEM: five sources in one semantic cluster, one retired, served by the
 *    huginn stub. s5 (retired) joins s3 and s4, which are also joined, so the
 *    live four are a cluster of their own.
 */
const WIKI_CAP = "e2e-retired-cap";
const CAP_LIVE = 60;
const CAP_DEAD = 11;
const capLive = (i: number) => `entities/e${String(i).padStart(2, "0")}.md`;
const capDead = (i: number) => `entities/x${String(i).padStart(2, "0")}.md`;
const WIKI_SEM = "e2e-retired-sem";
const SEM_COLL = "e2e-retired-sem";
const SEM = ["sources/s1.md", "sources/s2.md", "sources/s3.md", "sources/s4.md", "sources/s5.md"];
const SEM_DEAD = SEM[4]!;
const H_OLD2 = "notes/old2.md";

let server: ChildProcess | undefined;
let huginn: Server | undefined;
const roots: string[] = [];

async function writeWiki(files: Array<[string, string]>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-retired-"));
  roots.push(root);
  for (const [rel, body] of files) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
  await settleWikiMtimes(root);
  return root;
}

test.beforeAll(async () => {
  const root = await writeWiki(PAGES);
  const rootNo = await writeWiki([
    [".wiki-reader.json", JSON.stringify({ cullLabels: NO_LABELS })],
    [NO_LIVE, md("Ny side", [], "Erstatter [[archive/gammel]].")],
    [NO_OLD, md("Gammel side", retired("Erstattet av ny side", ["superseded_by: [[concepts/ny]]"]))],
  ]);
  const rootAlpha = await writeWiki([
    [A1, md("Alpha one", ["series: alpha", "plan_status: shipped", "status_date: 2026-01-01"])],
    [A2, md("Alpha two", ["series: alpha", "plan_status: in-flight", "status_date: 2026-02-01"])],
    [A3, md("Alpha three", retired("Dropped", ["series: alpha", "plan_status: in-flight", "status_date: 2026-03-01"]))],
  ]);
  const rootHubs = await writeWiki([
    [H_LIVE, md("Live note", [], "See [[old]] and [[old2]].")],
    [H_OLD, md("Old note", retired("Gone"))],
    [H_OLD2, md("Old note two", retired("Gone too"))],
  ]);
  const hubLinks = Array.from({ length: CAP_LIVE }, (_, i) => `[[${capLive(i + 1).replace(/\.md$/, "")}]]`);
  const rootCap = await writeWiki([
    ["sources/hub.md", md("Hub", ["type: source"], `${hubLinks.join(" ")} [[concepts/gone]] [[concepts/twin-topic]] [[archive/twin-topic]]`)],
    ...Array.from({ length: CAP_LIVE }, (_, i): [string, string] => [capLive(i + 1), md(`Entity ${i + 1}`, ["type: entity"])]),
    ...Array.from({ length: CAP_DEAD }, (_, i): [string, string] => [
      capDead(i + 1),
      md(`Dead entity ${i + 1}`, ["type: entity", ...retired("Merged")]),
    ]),
    ["concepts/gone.md", md("gone", ["type: concept", ...retired("Merged")])],
    ["concepts/twin-topic.md", md("twin-topic", ["type: concept"])],
    ["archive/twin-topic.md", md("twin-topic", ["type: concept", ...retired("Moved")])],
  ]);
  const rootSem = await writeWiki(
    SEM.map((rel, i): [string, string] => [
      rel,
      md(`Sem ${i + 1}`, ["type: source", ...(rel === SEM_DEAD ? retired("Merged") : [])]),
    ]),
  );
  // huginn's similarity graph for the SEM wiki's one collection.
  const graph = {
    nodes: SEM.map((id) => ({ id, community: 0 })),
    edges: [
      [SEM[0], SEM[1]],
      [SEM[1], SEM[2]],
      [SEM[2], SEM[4]],
      [SEM[3], SEM[4]],
      [SEM[2], SEM[3]],
    ].map(([source, target]) => ({ source, target, similarity: 0.99 })),
    communities: [{ id: 0, size: 5, name: "sem", top_tags: [], representative_docs: [SEM[0]] }],
  };
  huginn = createServer((req, res) => {
    if (req.url?.startsWith(`/api/collection/${SEM_COLL}/similarity-graph`)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(graph));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => huginn!.listen(HUGINN_PORT, "127.0.0.1", resolve));
  const rootAtlas = await writeWiki([
    [AT_SRC, md("The source", ["type: source"], "Cites [[live-concept]] and [[old-concept]].")],
    [AT_LIVE, md("Live concept", ["type: concept"])],
    [AT_OLD, md("Old concept", ["type: concept", ...retired("Merged")])],
  ]);
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      KNOWLEDGE_API_URL: `http://127.0.0.1:${HUGINN_PORT}`,
      WIKI_EXTRA: [
        `${WIKI}=${root}`,
        `${WIKI_NO}=${rootNo}`,
        `${WIKI_ALPHA}=${rootAlpha}`,
        `${WIKI_HUBS}=${rootHubs}`,
        `${WIKI_ATLAS}=${rootAtlas}`,
        `${WIKI_CAP}=${rootCap}`,
        `${WIKI_SEM}=${rootSem}=${SEM_COLL}`,
      ].join(","),
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise<void>((resolve) => (huginn ? huginn.close(() => resolve()) : resolve()));
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function openRail(page: Page, wiki = WIKI): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${wiki}`);
  // A row, or a group row (the ALPHA wiki's rail is one closed series fold).
  await expect(page.locator(".wiki-list-item, .wiki-list-group").first()).toBeAttached();
}

const row = (page: Page, rel: string) => page.locator(`.wiki-list-item[data-relpath="${rel}"]`);
const toggle = (page: Page) => page.locator("#wikiShowRetired");
const seriesRow = (page: Page) => page.locator('.wiki-list-group[data-group="series:retire"]');

async function selectFolder(page: Page, folder: string): Promise<void> {
  await page.locator("#wikiFilters").evaluate((el) => ((el as HTMLDetailsElement).open = true));
  await page.selectOption("#wikiFolder", folder);
}

async function railRels(page: Page): Promise<string[]> {
  return page.locator(".wiki-list-item").evaluateAll((els) => els.map((el) => el.getAttribute("data-relpath") || ""));
}

/** Open every fold, so every row a pool holds is on screen. */
async function openAllFolds(page: Page): Promise<void> {
  for (;;) {
    const closed = page.locator('.wiki-fold-chip[aria-expanded="false"], .wiki-group-fold[aria-expanded="false"]');
    if (!(await closed.count())) return;
    await closed.first().click();
  }
}

test.describe("Wiki: retired pages", () => {
  test("the listing marks exactly the retired pages, twin included", async () => {
    const data = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`)).json()) as {
      pages: Array<{ relPath: string; culled?: boolean; parent?: string }>;
      cullLabels: Record<string, string>;
    };
    expect(data.pages.filter((p) => p.culled).map((p) => p.relPath).sort()).toEqual([...CULLED].sort());
    expect(data.cullLabels.toggle).toBe("Show retired ({n})");
    const by = new Map(data.pages.map((p) => [p.relPath, p]));
    // Rule 1 inherits; rule 4 under a retired parent unpairs; under a live one it pairs.
    expect(by.get(TWIN_HTML)!.parent).toBe(TWIN);
    expect(by.get(OLDER)!.parent).toBeUndefined();
    expect(by.get(DEAD_CHILD)!.parent).toBe(PARENT);
  });

  test("hidden by default: the toggle counts them and #wikiCount leaves them out", async ({ page }) => {
    await openRail(page);
    await expect(page.locator("#wikiRetiredToggle")).toBeVisible();
    await expect(page.locator("#wikiRetiredLabel")).toHaveText(`Show retired (${CULLED.length})`);
    await expect(toggle(page)).not.toBeChecked();
    await expect(page.locator("#wikiCount")).toHaveText(new RegExp(` / ${LIVE}$`));
    await openAllFolds(page);
    const rels = await railRels(page);
    for (const rel of CULLED) expect(rels).not.toContain(rel);
    // A retired parent's rule-4 child lists at top level, not under a hidden row.
    await expect(row(page, OLDER)).toBeVisible();
    await expect(row(page, OLDER)).not.toHaveClass(/\bchild\b/);
    // The live parent's chip counts its live attachment only.
    await expect(row(page, PARENT).locator(".wiki-fold-chip-label")).toHaveText("1 attached");
    expect(rels.sort()).toEqual([SUCCESSOR, OLDER, PARENT, PARENT_PROTO, S_A, S_B].sort());
    await expect(page.locator("#wikiCount")).toHaveText(`${LIVE} / ${LIVE}`);
    // The folder facet counts the same pool: `archive/` holds only a retired
    // page, so it stays listed at 0 — the folder view still reaches it.
    await expect(page.locator('#wikiFolder option[value="archive"]')).toHaveText("archive 0");
    await expect(page.locator('#wikiFolder option[value="plans"]')).toHaveText("plans 3");
  });

  test("a retired series head still names the fold, and the census counts it", async ({ page }) => {
    await openRail(page);
    await expect(seriesRow(page).locator(".wiki-group-name")).toHaveText(SERIES_LABEL);
    await expect(seriesRow(page).locator(".wiki-group-sub")).toHaveText("2 of 3 shown");
    await toggle(page).check();
    await expect(seriesRow(page).locator(".wiki-group-name")).toHaveText(SERIES_LABEL);
    await expect(seriesRow(page).locator(".wiki-group-sub")).toHaveCount(0);
  });

  test("the toggle shows them, marked, and persists across a reload", async ({ page }) => {
    await openRail(page);
    await toggle(page).check();
    await expect(page.locator("#wikiCount")).toHaveText(new RegExp(` / ${ALL}$`));
    await openAllFolds(page);
    expect((await railRels(page)).sort()).toEqual(PAGES.map(([rel]) => rel).sort());
    await expect(row(page, TWIN)).toHaveClass(/\bculled\b/);
    await expect(row(page, TWIN)).toHaveAttribute("title", /Retired/);
    await expect(page.locator('#wikiFolder option[value="archive"]')).toHaveText("archive 1");
    await expect(page.locator('#wikiFolder option[value="plans"]')).toHaveText("plans 7");
    // The twin folds under its retired parent; the dead child is back in its
    // live parent's chip.
    await expect(row(page, TWIN_HTML)).toHaveClass(/\bchild\b/);
    await expect(row(page, PARENT).locator(".wiki-fold-chip-label")).toHaveText("1 attached · 1 superseded");

    await page.reload();
    await expect(page.locator(".wiki-list-item").first()).toBeAttached();
    await expect(toggle(page)).toBeChecked();
    await expect(page.locator("#wikiCount")).toHaveText(new RegExp(` / ${ALL}$`));
    await toggle(page).uncheck();
    await page.reload();
    await expect(page.locator(".wiki-list-item").first()).toBeAttached();
    await expect(toggle(page)).not.toBeChecked();
    await expect(page.locator("#wikiCount")).toHaveText(new RegExp(` / ${LIVE}$`));
  });

  test("search still reaches a retired page", async ({ page }) => {
    await openRail(page);
    await page.fill("#wikiSearch", "Twin");
    await expect(row(page, TWIN)).toBeVisible();
    await expect(row(page, TWIN)).toHaveClass(/\bculled\b/);
    await expect(row(page, TWIN_HTML)).toBeVisible();
  });

  test("a direct link opens it, and the banner links the successor in another folder", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(OLD)}`);
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Old archive page");
    const banner = page.locator(".wiki-cull-banner");
    await expect(banner.locator(".wiki-cull-banner-label")).toHaveText("Retired");
    await expect(banner.locator(".wiki-cull-reason")).toHaveText(`: ${OLD_REASON}`);
    await expect(banner.locator(".wiki-cull-next")).toHaveText("Superseded by Successor concept");
    await banner.locator(".wiki-cull-successor").click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Successor concept");
    expect(new URL(page.url()).searchParams.get("relPath")).toBe(SUCCESSOR);
    await expect(page.locator(".wiki-cull-banner")).toHaveCount(0);
    // Connections marks the retired page (it links both ways, so twice).
    const marks = page.locator(`.wiki-conn-item[data-relpath="${OLD}"] .wiki-cull-mark`);
    await expect(marks).toHaveCount(2);
    await expect(marks.first()).toHaveText("Retired");
  });

  test("an .html page retired through its parent gets the banner too", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(TWIN_HTML)}`);
    await expect(page.locator(".wiki-cull-banner .wiki-cull-reason")).toHaveText(": Scaffold");
  });

  test("cullLabels: the wiki's own words in the toggle, the banner and Connections", async ({ page }) => {
    await openRail(page, WIKI_NO);
    await expect(page.locator("#wikiRetiredLabel")).toHaveText("Vis utfasede (1)");
    await page.goto(`${BASE}/wiki?wiki=${WIKI_NO}&relPath=${encodeURIComponent(NO_OLD)}`);
    const banner = page.locator(".wiki-cull-banner");
    await expect(banner.locator(".wiki-cull-banner-label")).toHaveText("Utfaset");
    await expect(banner.locator(".wiki-cull-next")).toHaveText("Erstattet av Ny side");
    await banner.locator(".wiki-cull-successor").click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Ny side");
    const marks = page.locator(`.wiki-conn-item[data-relpath="${NO_OLD}"] .wiki-cull-mark`);
    await expect(marks).toHaveCount(2);
    await expect(marks.first()).toHaveText("Utfaset");
  });

  // The banner's colours are the tokens, resolved on a probe OUTSIDE the banner
  // (a token that stopped resolving would make banner and an inner probe fall
  // back to the same inherited colour), and legible at 4.5:1 in both themes.
  test("the banner is legible in both themes", async ({ page }) => {
    const probed: Record<string, { color: string; bg: string }> = {};
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(OLD)}`);
      const banner = page.locator(".wiki-cull-banner");
      await expect(banner).toBeVisible();
      const probe = await page.evaluate(() => {
        const el = document.createElement("div");
        el.style.color = "var(--text-primary)";
        el.style.background = "var(--tint-warning)";
        document.body.appendChild(el);
        const cs = getComputedStyle(el);
        const out = { color: cs.color, bg: cs.backgroundColor };
        el.remove();
        return out;
      });
      const got = await banner.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { color: cs.color, bg: cs.backgroundColor };
      });
      expect(got, scheme).toEqual(probe);
      probed[scheme] = probe;
      for (const sel of [".wiki-cull-banner-label", ".wiki-cull-reason", ".wiki-cull-next", ".wiki-cull-successor"]) {
        expect(await contrastOf(banner.locator(sel)), `${scheme} ${sel}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Not vacuous: the two themes really resolve different colours.
    expect(probed.light).not.toEqual(probed.dark);
  });
  // ── Fix round 1 ─────────────────────────────────────────────────────────

  test("fix 1: the latest dot and `continue at:` skip a retired plan; the strip marks it", async ({ page }) => {
    await openRail(page, WIKI_ALPHA);
    await openAllFolds(page);
    await expect(row(page, A2)).toHaveClass(/\blatest\b/);
    // A3 is newer and retired: the dot is the newest plan that is NOT retired,
    // and its hover says so.
    await expect(row(page, A2)).toHaveAttribute("title", /newest plan in this series that is not retired/);
    await toggle(page).check();
    await openAllFolds(page);
    await expect(row(page, A3)).toBeVisible();
    await expect(row(page, A3)).not.toHaveClass(/\blatest\b/);
    await expect(row(page, A2)).toHaveClass(/\blatest\b/);

    await page.goto(`${BASE}/wiki?wiki=${WIKI_ALPHA}&relPath=${encodeURIComponent(A1)}`);
    await expect(page.locator(".wiki-series-go")).toHaveText("Alpha two");
    await expect(page.locator(".wiki-series-go")).toHaveAttribute("data-series-go", A2);
    const steps = page.locator(".wiki-series-step-title");
    await expect(steps).toHaveCount(3);
    await expect(steps.filter({ hasText: "Alpha three" }).locator(".wiki-cull-mark")).toHaveText("Retired");
    await expect(steps.filter({ hasText: "Alpha two" }).locator(".wiki-cull-mark")).toHaveCount(0);
  });

  test("fix 2: an all-retired folder stays in the picker, and the empty rail offers them", async ({ page }) => {
    await openRail(page);
    await expect(page.locator('#wikiFolder option[value="archive"]')).toHaveText("archive 0");
    await selectFolder(page, "archive");
    await expect(page.locator(".wiki-list-item")).toHaveCount(0);
    const reveal = page.locator("#wikiList .wiki-retired-reveal");
    await expect(reveal).toHaveText("Show retired (1)");
    await reveal.click();
    await expect(toggle(page)).toBeChecked();
    await expect(row(page, OLD)).toBeVisible();
    await expect(page.locator("#wikiList .wiki-retired-reveal")).toHaveCount(0);
    // A search already reaches retired pages, so an empty result offers none.
    await toggle(page).uncheck();
    await page.fill("#wikiSearch", "zzzz-no-such-page");
    await expect(page.locator("#wikiList")).toContainText("No pages match.");
    await expect(page.locator("#wikiList .wiki-retired-reveal")).toHaveCount(0);
    // The wiki's own words.
    await openRail(page, WIKI_NO);
    await expect(page.locator('#wikiFolder option[value="archive"]')).toHaveText("archive 0");
    await selectFolder(page, "archive");
    await expect(page.locator("#wikiList .wiki-retired-reveal")).toHaveText("Vis utfasede (1)");
  });

  test("fix 3: #wikiCount's hover is the toggle's own text with the facet-aware N", async ({ page }) => {
    await openRail(page);
    await expect(page.locator("#wikiCount")).toHaveAttribute("title", `Show retired (${CULLED.length})`);
    await selectFolder(page, "plans");
    await expect(page.locator("#wikiRetiredLabel")).toHaveText("Show retired (4)");
    await expect(page.locator("#wikiCount")).toHaveAttribute("title", "Show retired (4)");
    await openRail(page, WIKI_NO);
    await expect(page.locator("#wikiCount")).toHaveAttribute("title", "Vis utfasede (1)");
  });

  test("fix 4: the toggle carries no hover of its own", async ({ page }) => {
    await openRail(page);
    await expect(page.locator("#wikiRetiredToggle")).toBeVisible();
    await expect(page.locator("#wikiRetiredToggle")).not.toHaveAttribute("title", /.*/);
  });

  test("fix 5: the toggle hides at (0) under a facet, unless it is checked", async ({ page }) => {
    await openRail(page);
    await selectFolder(page, "concepts");
    await expect(page.locator("#wikiRetiredToggle")).toBeHidden();
    await expect(page.locator("#wikiCount")).not.toHaveAttribute("title", /.*/);
    await selectFolder(page, "");
    await toggle(page).check();
    await selectFolder(page, "concepts");
    await expect(page.locator("#wikiRetiredToggle")).toBeVisible();
    await expect(page.locator("#wikiRetiredLabel")).toHaveText("Show retired (0)");
  });

  test("fix 6: the Atlas shows the rail's pool, and marks retired nodes when they are shown", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI_ATLAS}&view=atlas`);
    const node = (rel: string) => page.locator(`.wiki-atlas-canvas[data-view="types"] .wiki-atlas-node[data-key="${rel}"]`);
    await expect(node(AT_LIVE)).toBeAttached();
    await expect(node(AT_OLD)).toHaveCount(0);
    const conceptCol = page.locator('.wiki-atlas-canvas[data-view="types"] .wiki-atlas-col', {
      has: page.locator(`[data-key="${AT_LIVE}"]`),
    });
    await expect(conceptCol.locator(".wiki-atlas-count")).toHaveText("· 1");
    // With the toggle on (set from Hubs, where the rail is on screen) the node
    // returns, marked.
    await page.goto(`${BASE}/wiki?wiki=${WIKI_ATLAS}&view=hubs`);
    await toggle(page).check();
    await page.locator('.wiki-tab[data-tab="atlas"]').click();
    await expect(node(AT_OLD)).toHaveClass(/\bculled\b/);
    await expect(node(AT_OLD)).toHaveAttribute("title", /Retired/);
    await expect(node(AT_LIVE)).not.toHaveClass(/\bculled\b/);
  });

  test("fix 7: the start Timeline follows a search that reaches only retired pages", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&view=timeline`);
    await expect(page.locator(".wiki-tl-item").first()).toBeAttached();
    await page.fill("#wikiSearch", "Twin");
    await expect(row(page, TWIN)).toBeVisible();
    await expect(page.locator(`.wiki-tl-item[data-relpath="${TWIN}"]`)).toBeAttached();
  });

  test("fix 8: Hubs offers held-back retired hubs instead of claiming no links, and marks them", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI_HUBS}&view=hubs`);
    const body = page.locator("#startBody");
    await expect(body.locator(".wiki-retired-reveal")).toHaveText("Show retired (2)");
    await expect(body).not.toContainText("no resolvable internal links");
    await body.locator(".wiki-retired-reveal").click();
    await expect(toggle(page)).toBeChecked();
    const card = body.locator(`.wiki-hub-card[data-relpath="${H_OLD}"]`);
    await expect(card).toHaveClass(/\bculled\b/);
    await expect(card.locator(".wiki-cull-mark")).toHaveText("Retired");
  });

  test("fix 2.6: a keyboard reveal leaves focus on the toggle, not on <body>", async ({ page }) => {
    await openRail(page);
    await selectFolder(page, "archive");
    const reveal = page.locator("#wikiList .wiki-retired-reveal");
    await reveal.focus();
    await page.keyboard.press("Enter");
    await expect(toggle(page)).toBeChecked();
    await expect(toggle(page)).toBeFocused();
  });

  test("fix 2.2: switching to the Atlas after a toggle flip shows the pool of the moment", async ({ page }) => {
    const node = (rel: string) => page.locator(`.wiki-atlas-canvas[data-view="types"] .wiki-atlas-node[data-key="${rel}"]`);
    await page.goto(`${BASE}/wiki?wiki=${WIKI_ATLAS}&view=hubs`);
    await toggle(page).check();
    await page.locator('.wiki-tab[data-tab="atlas"]').click();
    await expect(node(AT_OLD)).toBeAttached();
    // Back to Hubs, the toggle off, and the Atlas again: built from the cached
    // payload, it drops the retired node once more.
    await page.locator('.wiki-tab[data-tab="hubs"]').click();
    await toggle(page).uncheck();
    await page.locator('.wiki-tab[data-tab="atlas"]').click();
    await expect(node(AT_LIVE)).toBeAttached();
    await expect(node(AT_OLD)).toHaveCount(0);
  });

  test("fix 2.3: a capped column's `+ N more` and the topics follow the pool", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI_CAP}&view=atlas`);
    const col = page.locator('.wiki-atlas-canvas[data-view="types"] .wiki-atlas-col', {
      has: page.locator(`[data-key="${capLive(1)}"]`),
    });
    // 71 entities, 50 drawn: of the 21 the cap hid, 11 are retired.
    await expect(col.locator(".wiki-atlas-count")).toHaveText("· 50");
    await expect(col.locator(".wiki-atlas-more")).toHaveText("+ 10 more not shown");
    const topics = page.locator(".wiki-atlas-topic b");
    await expect(topics.filter({ hasText: /^twin-topic$/ }).first()).toBeAttached();
    expect(await topics.allTextContents()).not.toContain("gone");
  });

  test("fix 2.1: the semantic clusters follow the pool, and Draft synthesis never sends a retired page", async ({ page }) => {
    const posted: string[][] = [];
    await page.route("**/api/wiki/atlas/draft-synthesis*", async (route) => {
      posted.push((route.request().postDataJSON() as { members: string[] }).members);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ state: "started" }) });
    });
    const semOn = async () => {
      const t = page.locator(".wiki-atlas-semtoggle");
      await expect(t).toBeVisible();
      if (!(await t.evaluate((el) => el.classList.contains("on")))) await t.click();
    };
    const cluster = page.locator(".wiki-atlas-cluster").first();
    const member = (rel: string) => page.locator(`.wiki-atlas-cmember[data-key="${rel}"]`);

    await page.goto(`${BASE}/wiki?wiki=${WIKI_SEM}&view=atlas`);
    await semOn();
    await expect(page.locator(".wiki-atlas-cluster")).toHaveCount(1);
    await expect(cluster.locator(".wiki-atlas-cluster-head em")).toHaveText("4");
    await expect(member(SEM[0]!)).toBeAttached();
    await expect(member(SEM_DEAD)).toHaveCount(0);
    await cluster.locator(".wiki-atlas-cdraft").click();
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]!.slice().sort()).toEqual(SEM.slice(0, 4));

    // Shown: the retired page is a member again, marked, and still not sent.
    await page.goto(`${BASE}/wiki?wiki=${WIKI_SEM}&view=hubs`);
    await toggle(page).check();
    await page.locator('.wiki-tab[data-tab="atlas"]').click();
    await semOn();
    await expect(cluster.locator(".wiki-atlas-cluster-head em")).toHaveText("5");
    await expect(member(SEM_DEAD)).toHaveClass(/\bculled\b/);
    await expect(member(SEM_DEAD)).toHaveAttribute("title", /Retired/);
    await expect(member(SEM[0]!)).not.toHaveClass(/\bculled\b/);
    await expect(cluster.locator(".wiki-atlas-cdraft")).toHaveAttribute("title", /these 4 pages/);
    await cluster.locator(".wiki-atlas-cdraft").click();
    await expect.poll(() => posted.length).toBe(2);
    expect(posted[1]!.slice().sort()).toEqual(SEM.slice(0, 4));
  });
});
