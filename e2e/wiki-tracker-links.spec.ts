/**
 * /wiki reader — tracker links, end to end (plan "Tracker links in the wiki
 * reader", PR 1: inference, rail pills and the widened Jira facet).
 *
 * Two temp wikis in ONE muninn, the pages invented and the keys synthetic
 * (project `DEMO`, host `example.invalid`) because muninn is a public repo:
 *
 *   - `e2e-trackers` declares a `trackers` block, so its pages learn their keys
 *     from title, file name, tags, links, "created" sentences and `issue:`;
 *   - `e2e-notrackers` declares none and carries one stamped `jira:` page, the
 *     control for the hard rule that a wiki without a tracker keeps today's
 *     stamped-only facet and strip, and shows no pills.
 *
 * The fixture mirrors the plan's anchor page: one page that CREATED three keys
 * (its created-marker line has the anchor's 2/70/138 shape and a dotted URL),
 * carries two tag keys and one body mention, and has `sessions:`; plus a page
 * with inferred keys and no provenance lines, a scalar `jira:` page, an `.html`
 * page, plans (one whose key is only in its file name, one whose key is only
 * under `issue:`), and a page whose title carries `ORA-01407` and a non-project
 * key. No session or PR is shared between two pages. Fix round 1 adds a
 * link-only page (demoted: no pill, no chip), a long-titled page for the pill
 * geometry, and two FOLDS that hold a keyed page — a series and a markdown page
 * with its same-stem `.html` twin — so the facet's "chip count = rows =
 * #wikiCount" is driven through a closed fold. Fix round 2 adds a key-less
 * twin as the control for a fold-chip row's line structure, a title that fits
 * two lines only without its pill, and a key on a second, long project that is
 * wider than its title cell at the 260px rail. PR 3 extends this file with
 * Connections and Link.
 *
 * No model calls and no writes. `KNOWLEDGE_API_URL` points at a port nothing
 * binds, so the strip's huginn lookup degrades instead of reaching a real
 * corpus.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { SETTLED_CREATED_LINE, settleWikiMtimes } from "./settled-wiki.ts";
import { contrastOf } from "./contrast.ts";
import { WIKI_REFETCH_MIN_INTERVAL_MS } from "../src/dashboard/views/components/wiki-refresh.ts";
import {
  RAIL_ISSUE_PILLS_COL,
  RAIL_TITLE_MIN,
  RAIL_WIDTH_KEY,
} from "../src/dashboard/views/components/wiki-rail-width.ts";

const PORT = e2ePort("wiki-tracker-links");
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI = "e2e-trackers";
const WIKI_PLAIN = "e2e-notrackers";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const READER_CONFIG = JSON.stringify({
  trackers: [
    {
      id: "jira",
      projects: ["DEMO", "DEMOPROSJEKT"],
      hosts: ["example.invalid"],
      frontmatterKeys: ["issue", "tickets"],
      planTitle: "plan(er|en)?(?!\\p{L})",
      planTitleExclude: "testplan|review av",
      createdMarkers: ["opprettet", "created"],
      statusMap: { Ferdig: "done", "Akseptanse test": "review" },
    },
  ],
});

const url = (k: string) => `https://example.invalid/browse/${k}`;

function md(fm: string[], body: string): string {
  return ["---", ...fm, SETTLED_CREATED_LINE, "---", "", body, ""].join("\n");
}

/** The anchor-shaped page: created 101–103, tags 120/121, mentions 122. */
const ANCHOR = "archive/2026-01-10-rotaarsak.mdx";
const ANCHOR_LINE =
  "Status: ferdig 2026-01-05 · grunnlag: kjørt 22.09 (**12 rader**) · Jira opprettet: " +
  `[DEMO-101](${url("DEMO-101")}) (A1 grunnfeil), ` +
  `[DEMO-102](${url("DEMO-102")}) (A2 følgefeil), ` +
  `[DEMO-103](${url("DEMO-103")}) (B) · neste steg: A2.`;

const INFERRED = "notes/inferred-only.md";
const SCALAR = "notes/scalar.md";
const STAMPED = "notes/stamped.md";
const EXPLAINER = "explainers/forklaring.html";
const STEM_PLAN = "plans/2026-01-11-demo-160-plan.md";
const ISSUE_PLAN = "plans/utrulling.md";
const PLAN_A = "plans/arbeidsplan.md";
const PLAN_B = "plans/kjoreplan.md";
const ORA = "notes/ora.md";
const PLAIN = "notes/plain.md";
/** A link is the only thing tying it to DEMO-190: demoted, like a mention. */
const LINKED = "notes/linked-only.md";
/** A title long enough to clamp at every rail width, carrying two keys. */
const LONG = "notes/long.md";
const LONG_TITLE =
  "DEMO-133 og DEMO-134 — en svært lang tittel som fortsetter over mange linjer i sidelisten, " +
  "slik at den blir klemt til to linjer ved enhver bredde på skinnen";
/** A series: only its first member carries a key, and the fold starts closed. */
const SER_A = "work/serie-a.md";
const SER_B = "work/serie-b.md";
/** A markdown page and its same-stem `.html` twin (an attachment child, folded
 *  under the page), both carrying DEMO-210. */
const TWIN_MD = "notes/tvilling.md";
const TWIN_HTML = "notes/tvilling.html";
/** The control for the twin: the same fold chip and title length, no key. */
const MIRROR_MD = "notes/speil.md";
const MIRROR_HTML = "notes/speil.html";
/** A title that fits two lines at the 260px rail WITHOUT its pill, and that the
 *  inline pill run of the first cut pushed onto a clamped third line. */
/** A key wider than its row's title cell at the 260px rail (a long project
 *  name beside a fold chip): the pill wraps after the dash, inside the cell. */
const LONG_KEY = "notes/langnokkel.md";
const LONG_KEY_HTML = "notes/langnokkel.html";
const TWO_LINE = "notes/to-linjer.md";
const TWO_LINE_TITLE = "DEMO-162 notater fra kjøringen i går";

const PAGES: Record<string, string> = {
  [ANCHOR]: md(
    [
      "title: Hvorfor mangler radene metadata?",
      "tags: [demo-api, demo-120, demo-121]",
      "sessions: [claude-code:00000000-0000-4000-8000-000000000001]",
    ],
    `# Hvorfor mangler radene metadata?\n\n${ANCHOR_LINE}\n\nSe også DEMO-122 for bakgrunn.`,
  ),
  [INFERRED]: md(["title: DEMO-130 og DEMO-131 — notater"], "# Notater\n\nIngen proveniens her."),
  [SCALAR]: md(["title: Skalar", "jira: DEMO-140 (kilde), ny sak under epic DEMO-141 (oppfølging)"], "# Skalar"),
  [STAMPED]: md(["title: Stemplet", "jira: [DEMO-180]"], "# Stemplet"),
  [STEM_PLAN]: md(["title: Utrulling av ny kø", "type: plan"], "# Plan\n\nIngen nøkkel i teksten."),
  [ISSUE_PLAN]: md(["title: Utrullingsplan", "type: plan", "issue: DEMO-170"], "# Utrullingsplan"),
  // A status pill and a ⚑ beside the pills: the row whose title and pill column
  // are squeezed hardest at a narrow rail.
  [PLAN_A]: md(["title: DEMO-101 — arbeidsplan", "type: plan", "plan_status: in-flight", "followups: open"], "# Arbeidsplan"),
  [PLAN_B]: md(["title: Kjøreplan for utrulling", "type: plan", "tags: [demo-121]"], "# Kjøreplan"),
  [ORA]: md(["title: Fallgruve (ORA-01407) på SAK-4711", "tags: [demo-api]"], "# Fallgruve"),
  [PLAIN]: md(["title: Vanlig side"], "# Vanlig side\n\nIngen saker."),
  [LINKED]: md(["title: Lenket side"], `# Lenket side\n\nEpic: [DEMO-190](${url("DEMO-190")}).`),
  [LONG]: md([`title: ${LONG_TITLE}`], "# Lang"),
  [SER_A]: md(["title: Serie A", "series: demo-serie", "series_label: Demo-serien", "tags: [demo-200]"], "# A"),
  [SER_B]: md(["title: Serie B", "series: demo-serie"], "# B"),
  [TWIN_MD]: md(["title: Tvilling", "tags: [demo-210]"], "# Tvilling"),
  [TWIN_HTML]: "<!doctype html><html><head><title>DEMO-210 tvilling</title></head><body></body></html>",
  [MIRROR_MD]: md(["title: Speilside"], "# Speilside"),
  [MIRROR_HTML]: "<!doctype html><html><head><title>Speil</title></head><body></body></html>",
  [TWO_LINE]: md([`title: ${TWO_LINE_TITLE}`], "# To linjer"),
  [LONG_KEY]: md(["title: Langnøkkel", "tags: [demoprosjekt-123456]"], "# Langnøkkel"),
  [LONG_KEY_HTML]: "<!doctype html><html><head><title>Lang</title></head><body></body></html>",
  [EXPLAINER]:
    "<!doctype html><html><head><title>DEMO-150 forklart</title></head>" +
    `<body><a href="${url("DEMO-199")}">DEMO-199</a></body></html>`,
};

/** Every non-mention key and the pages carrying it — the facet's ground truth. */
const KEY_PAGES: Record<string, string[]> = {
  "DEMO-101": [ANCHOR, PLAN_A],
  "DEMO-102": [ANCHOR],
  "DEMO-103": [ANCHOR],
  "DEMO-120": [ANCHOR],
  "DEMO-121": [ANCHOR, PLAN_B],
  "DEMO-130": [INFERRED],
  "DEMO-131": [INFERRED],
  "DEMO-133": [LONG],
  "DEMO-134": [LONG],
  "DEMO-140": [SCALAR],
  "DEMO-141": [SCALAR],
  "DEMO-150": [EXPLAINER],
  "DEMO-160": [STEM_PLAN],
  "DEMO-162": [TWO_LINE],
  "DEMOPROSJEKT-123456": [LONG_KEY],
  "DEMO-170": [ISSUE_PLAN],
  "DEMO-180": [STAMPED],
  "DEMO-200": [SER_A],
  "DEMO-210": [TWIN_MD, TWIN_HTML],
};
const KEY_COUNT = Object.keys(KEY_PAGES).length;

/** The control wiki: one stamped page, and an inferred-shaped page that must
 *  stay key-less there. */
const PLAIN_PAGES: Record<string, string> = {
  [STAMPED]: PAGES[STAMPED]!,
  [INFERRED]: PAGES[INFERRED]!,
};

let server: ChildProcess | undefined;
const roots: string[] = [];

async function writeWiki(pages: Record<string, string>, config?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-trackers-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(pages)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
  if (config) await writeFile(path.join(root, ".wiki-reader.json"), config, "utf8");
  await settleWikiMtimes(root);
  return root;
}

test.beforeAll(async () => {
  const root = await writeWiki(PAGES, READER_CONFIG);
  const rootPlain = await writeWiki(PLAIN_PAGES);
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      KNOWLEDGE_API_URL: "http://127.0.0.1:9",
      WIKI_EXTRA: `${WIKI}=${root},${WIKI_PLAIN}=${rootPlain}`,
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
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

async function openReader(page: Page, query: string): Promise<void> {
  const listing = page.waitForResponse((r) => r.url().includes("/api/wiki/pages"), { timeout: 15_000 });
  await page.goto(`${BASE}/wiki?${query}`);
  await listing;
  await expect(page.locator(".wiki-list-item").first()).toBeVisible();
}

const row = (page: Page, rel: string) => page.locator(`.wiki-list-item[data-relpath="${rel}"]`);
const pills = (page: Page, rel: string) => row(page, rel).locator(".wiki-issue-pill[data-issue-key]");

async function listedRelPaths(page: Page): Promise<string[]> {
  return (await page.locator(".wiki-list-item").evaluateAll((els) => els.map((e) => e.getAttribute("data-relpath") ?? ""))).sort();
}

/** `#wikiCount` reads `shown / total`; the shown half. */
async function shownCount(page: Page): Promise<number> {
  return Number((await page.locator("#wikiCount").textContent())!.split("/")[0]!.trim());
}

/**
 * For every row carrying pills, the pills whose box is NOT wholly inside the row
 * and inside every clipping ancestor — `toBeVisible()` passes on an element a
 * line clamp has hidden, so the geometry is the only honest test.
 */
async function clippedPillRows(page: Page): Promise<string[]> {
  return page.locator(".wiki-list-item").evaluateAll((rows, [maxCol, minText]) => {
    const bad: string[] = [];
    for (const row of rows) {
      const pills = Array.from(row.querySelectorAll(".wiki-issue-pill")) as HTMLElement[];
      for (const pill of pills) {
        const r = pill.getBoundingClientRect();
        let ok = r.width > 0 && r.height > 0;
        for (let a = pill.parentElement; a && ok; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (a !== row && cs.overflow === "visible" && cs.overflowY === "visible") continue;
          const b = a.getBoundingClientRect();
          if (r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5 || r.left < b.left - 0.5 || r.right > b.right + 0.5) ok = false;
          if (a === row) break;
        }
        // Beside the title text or under it, never over it.
        const text = row.querySelector(".wiki-list-title-text");
        if (ok && text) {
          const t = text.getBoundingClientRect();
          if (r.left < t.right - 0.5 && r.top < t.bottom - 0.5) ok = false;
        }
        if (!ok) bad.push(`${row.getAttribute("data-relpath")} ${pill.textContent}`);
      }
      // The column: at most its max-width, inside the title cell, and never
      // narrower than a pill in it; a pill never narrower than its text.
      const col = row.querySelector(".wiki-issue-pills");
      if (col) {
        const c = col.getBoundingClientRect();
        const cell = row.querySelector(".wiki-list-title")!.getBoundingClientRect();
        if (c.left < cell.left - 0.5 || c.right > cell.right + 0.5) bad.push(`${row.getAttribute("data-relpath")} column outside the title cell`);
        for (const pill of pills) {
          if (pill.scrollWidth > pill.clientWidth + 1) bad.push(`${row.getAttribute("data-relpath")} ${pill.textContent} squeezed`);
        }
        if (c.width > maxCol + 0.5) bad.push(`${row.getAttribute("data-relpath")} column ${c.width}px`);
        for (const pill of pills) {
          const r = pill.getBoundingClientRect();
          if (r.left < c.left - 0.5 || r.right > c.right + 0.5) bad.push(`${row.getAttribute("data-relpath")} ${pill.textContent} outside its column`);
        }
        // Beside the pills, the text keeps its floor.
        const text = row.querySelector(".wiki-list-title-text");
        if (text) {
          const t = text.getBoundingClientRect();
          if (c.top < t.bottom - 0.5 && t.width < minText - 0.5) bad.push(`${row.getAttribute("data-relpath")} text ${t.width}px beside the pills`);
        }
      }
      // The title + pill column fit the box the row gave them — an overflow
      // lands on the status pill beside it, which no clip test can see.
      const mid = row.querySelector(".wiki-list-mid") as HTMLElement | null;
      if (pills.length && mid && mid.scrollWidth > mid.clientWidth + 1) {
        bad.push(`${row.getAttribute("data-relpath")} overflows its title box by ${mid.scrollWidth - mid.clientWidth}px`);
      }
    }
    return bad;
  }, [RAIL_ISSUE_PILLS_COL, RAIL_TITLE_MIN] as const);
}

/**
 * Whether a row's dot, title cell and ★+date share one line box — the row's
 * line STRUCTURE, which a pill must not change.
 */
async function oneLine(page: Page, rel: string): Promise<boolean> {
  return row(page, rel).evaluate((el) => {
    const box = (sel: string) => el.querySelector(sel)!.getBoundingClientRect();
    const dot = box(".wiki-type-dot");
    const title = box(".wiki-list-title");
    const end = box(".wiki-list-end");
    return dot.top < title.top + 16 && Math.abs(end.top - title.top) < 6;
  });
}

/** Which form the fold chip shows: its words or its counts. */
async function chipForm(page: Page, rel: string): Promise<string> {
  return row(page, rel)
    .locator(".wiki-fold-chip")
    .evaluate((el) => (getComputedStyle(el.querySelector(".wiki-fold-chip-label")!).display === "none" ? "counts" : "words"));
}

/**
 * The contrast of an element's text against what is really painted behind it:
 * every translucent fill between it and the first opaque one composited, as the
 * browser does — the active row's fill is a 14% tint, which a walk that stops
 * at the first non-transparent colour would read as solid.
 */
async function paintedContrast(locator: import("@playwright/test").Locator): Promise<number> {
  return locator.evaluate((el) => {
    const rgba = (c: string) => {
      const n = c.match(/[\d.]+/g)!.map(Number);
      return { r: n[0]!, g: n[1]!, b: n[2]!, a: n.length > 3 ? n[3]! : 1 };
    };
    const layers: ReturnType<typeof rgba>[] = [];
    for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c.a === 0) continue;
      layers.push(c);
      if (c.a >= 1) break;
    }
    let bg = { r: 255, g: 255, b: 255 };
    for (const l of layers.reverse()) {
      bg = { r: l.r * l.a + bg.r * (1 - l.a), g: l.g * l.a + bg.g * (1 - l.a), b: l.b * l.a + bg.b * (1 - l.a) };
    }
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const ch = (v: number) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const a = lum(rgba(getComputedStyle(el).color));
    const b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

test.describe("Wiki reader: tracker links", () => {
  test("the index carries every relation; the listing drops mentions (API)", async () => {
    const res = await fetch(`${BASE}/api/wiki/page?wiki=${WIKI}&relPath=${encodeURIComponent(ANCHOR)}`);
    const body = (await res.json()) as { meta: { issues: { key: string; relations: string[] }[] } };
    const byKey = Object.fromEntries(body.meta.issues.map((r) => [r.key, r.relations]));
    for (const k of ["DEMO-101", "DEMO-102", "DEMO-103"]) expect(byKey[k]![0]).toBe("created");
    expect(byKey["DEMO-120"]).toEqual(["tag"]);
    expect(byKey["DEMO-121"]).toEqual(["tag"]);
    expect(byKey["DEMO-122"]).toEqual(["mention"]);

    const listing = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`)).json()) as {
      pages: { relPath: string; issues?: { key: string; relations: string[] }[] }[];
      jira: Record<string, number>;
    };
    const anchor = listing.pages.find((p) => p.relPath === ANCHOR)!;
    expect(anchor.issues!.map((r) => r.key)).not.toContain("DEMO-122");
    expect(anchor.issues!.every((r) => !r.relations.includes("mention"))).toBe(true);
    // The facet map is exactly the ground truth — no mention, no link-only key, no ORA.
    expect(listing.jira).toEqual(Object.fromEntries(Object.entries(KEY_PAGES).map(([k, v]) => [k, v.length])));
    for (const p of [ORA, PLAIN, LINKED]) expect(listing.pages.find((x) => x.relPath === p)!.issues).toBeUndefined();

    // A link-only key is demoted: in the page's full issues, nowhere else.
    const linked = (await (
      await fetch(`${BASE}/api/wiki/page?wiki=${WIKI}&relPath=${encodeURIComponent(LINKED)}`)
    ).json()) as { meta: { issues: { key: string; relations: string[] }[] } };
    expect(linked.meta.issues).toEqual([{ tracker: "jira", key: "DEMO-190", relations: ["link", "mention"] }]);
  });

  test("1: pills on every keyed row, dashed when inferred, none on a key-less row, child count unchanged", async ({ page }) => {
    await openReader(page, `wiki=${WIKI}`);
    // Folded rows (the series and the twin) are checked by the facet case,
    // which opens them.
    const folded = new Set([SER_A, TWIN_HTML]);
    for (const rel of new Set(Object.values(KEY_PAGES).flat())) {
      if (folded.has(rel)) continue;
      await expect(row(page, rel).locator(".wiki-issue-pill").first()).toBeVisible();
    }
    for (const rel of [ORA, PLAIN, LINKED]) await expect(row(page, rel).locator(".wiki-issue-pill")).toHaveCount(0);

    // Stamped is solid; everything else dashed.
    await expect(pills(page, STAMPED)).toHaveClass("wiki-issue-pill");
    await expect(pills(page, SCALAR)).toHaveCount(2);
    for (const p of await pills(page, SCALAR).all()) await expect(p).not.toHaveClass(/inferred/);
    const dashed = await pills(page, INFERRED).first().evaluate((el) => getComputedStyle(el).borderTopStyle);
    expect(dashed).toBe("dashed");
    expect(await pills(page, STAMPED).evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("solid");

    // The anchor carries five non-mention keys: two pills and a +3, strongest first.
    await expect(pills(page, ANCHOR)).toHaveCount(2);
    await expect(pills(page, ANCHOR).first()).toHaveAttribute("data-issue-rel", "created");
    await expect(row(page, ANCHOR).locator(".wiki-issue-pill.more")).toHaveText("+3");

    // The pills live INSIDE the title element: the row grows no child.
    const counts = await page.evaluate(
      ([a, b]) =>
        [a, b].map((rel) => document.querySelector(`.wiki-list-item[data-relpath="${rel}"]`)!.children.length),
      [ANCHOR, PLAIN],
    );
    expect(counts[0]).toBe(counts[1]);
    await expect(row(page, ANCHOR).locator(".wiki-list-title .wiki-issue-pills")).toHaveCount(1);
  });

  test("2: chip count = rows = #wikiCount for every key, folds included; top 8 plus +N", async ({ page }) => {
    await openReader(page, `wiki=${WIKI}`);
    // Unfiltered, the series and the three twins are folded away: five pages hidden.
    const baseline = await shownCount(page);
    expect(baseline).toBe(Object.keys(PAGES).length - 5);
    for (const rel of [SER_A, TWIN_HTML]) await expect(row(page, rel)).toHaveCount(0);

    await page.locator("#wikiFilters summary").click();
    const chips = page.locator("#jiraChips");
    await expect(chips).toBeVisible();
    await expect(chips.locator(".wiki-chip-row-label")).toHaveText("Jira");
    // "All issues", eight chips and the expander.
    await expect(chips.locator("[data-jira]:not([data-jira=''])")).toHaveCount(8);
    const more = chips.locator("[data-jira-more]");
    await expect(more).toHaveText(`+${KEY_COUNT - 8} issues`);
    await expect(more).toHaveAttribute("type", "button");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    // The keyboard keeps its place across the re-render.
    await more.focus();
    await page.keyboard.press("Enter");
    await expect(chips.locator("[data-jira-more]")).toHaveAttribute("aria-expanded", "true");
    await expect(chips.locator("[data-jira-more]")).toBeFocused();
    await expect(chips.locator("[data-jira]:not([data-jira=''])")).toHaveCount(KEY_COUNT);

    for (const [key, rels] of Object.entries(KEY_PAGES)) {
      const chip = chips.locator(`[data-jira="${key}"]`);
      await expect(chip).toHaveText(`${key} ${rels.length}`);
      await chip.click();
      await expect(page.locator(".wiki-list-item")).toHaveCount(rels.length);
      expect(await listedRelPaths(page)).toEqual([...rels].sort());
      expect({ key, shown: await shownCount(page) }).toEqual({ key, shown: rels.length });
      await chips.locator(`[data-jira="${key}"]`).click(); // re-click clears
      await expect(page.locator(".wiki-list-item")).toHaveCount(baseline);
    }
  });

  test("2: under a Jira filter a fold holding a match is open and says why it cannot close", async ({ page }) => {
    await openReader(page, `wiki=${WIKI}&jira=DEMO-200`);
    expect(await listedRelPaths(page)).toEqual([SER_A]);
    const fold = page.locator(`.wiki-list-group[data-group="series:demo-serie"] .wiki-group-fold`);
    await expect(fold).toBeDisabled();
    await expect(fold).toHaveAttribute("title", /Jira filter/);
  });

  test("2: a key selected from the URL outside the top 8 is shown", async ({ page }) => {
    await openReader(page, `wiki=${WIKI}&jira=DEMO-180`);
    const chips = page.locator("#jiraChips");
    await expect(chips.locator('[data-jira="DEMO-180"]')).toHaveClass(/active/);
    await expect(chips.locator("[data-jira]:not([data-jira=''])")).toHaveCount(9);
    await expect(chips.locator("[data-jira-more]")).toHaveText(`+${KEY_COUNT - 9} issues`);
    expect(await listedRelPaths(page)).toEqual([STAMPED]);
  });

  test("11: the stem-only and issue:-only plans show stem and declared; ORA and the non-project key appear nowhere", async ({ page }) => {
    await openReader(page, `wiki=${WIKI}`);
    await expect(pills(page, STEM_PLAN)).toHaveAttribute("data-issue-key", "DEMO-160");
    await expect(pills(page, STEM_PLAN)).toHaveAttribute("data-issue-rel", "stem");
    await expect(pills(page, ISSUE_PLAN)).toHaveAttribute("data-issue-key", "DEMO-170");
    await expect(pills(page, ISSUE_PLAN)).toHaveAttribute("data-issue-rel", "declared");
    await page.locator("#wikiFilters summary").click();
    await page.locator("#jiraChips [data-jira-more]").click();
    for (const bad of ["ORA-01407", "SAK-4711", "DEMO-122", "DEMO-190", "DEMO-199"]) {
      await expect(page.locator(`[data-issue-key="${bad}"]`)).toHaveCount(0);
      await expect(page.locator(`#jiraChips [data-jira="${bad}"]`)).toHaveCount(0);
    }
  });

  test("8: a wiki with no trackers block keeps today's facet and strip, and shows no pills", async ({ page }) => {
    const listing = (await (await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI_PLAIN}`)).json()) as {
      pages: { issues?: unknown }[];
      jira: Record<string, number>;
    };
    expect(listing.jira).toEqual({ "DEMO-180": 1 });
    expect(listing.pages.every((p) => p.issues === undefined)).toBe(true);

    await openReader(page, `wiki=${WIKI_PLAIN}`);
    await expect(page.locator(".wiki-issue-pill")).toHaveCount(0);
    await page.locator("#wikiFilters summary").click();
    const chips = page.locator("#jiraChips");
    await expect(chips.locator("[data-jira]:not([data-jira=''])")).toHaveCount(1);
    await expect(chips.locator('[data-jira="DEMO-180"]')).toHaveText("DEMO-180 1");
    await expect(chips.locator("[data-jira-more]")).toHaveCount(0);
    await expect(chips.locator(".wiki-chip-row-label")).toHaveCount(0);

    // The strip's stamped key still renders as the facet control.
    await row(page, STAMPED).click();
    await expect(page.locator('[data-prov-jira="DEMO-180"]')).toBeVisible();
  });

  test("pills: never clipped by the title clamp, at 260, 286 and 420 px, in both themes", async ({ page }) => {
    for (const scheme of ["light", "dark"] as const) {
      for (const width of [260, 286, 420]) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.addInitScript(
          ([key, w]) => localStorage.setItem(key as string, String(w)),
          [RAIL_WIDTH_KEY, width] as const,
        );
        await page.setViewportSize({ width: 1280, height: 1400 });
        await openReader(page, `wiki=${WIKI}`);
        const where = `${scheme} ${width}px`;
        expect(Math.round((await page.locator("#wikiList").boundingBox())!.width), where).toBeLessThanOrEqual(width);
        // The long title really clamps — the case is only about a title that does.
        const longText = row(page, LONG).locator(".wiki-list-title-text");
        expect(await longText.evaluate((el) => el.scrollHeight > el.clientHeight), where).toBe(true);
        expect(await clippedPillRows(page), where).toEqual([]);
        if (width === 260) {
          // The long key really wraps after its dash there — the case is only about a key that does.
          const lines = await pills(page, LONG_KEY).evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
          expect(lines, where).toBe(2);
        }
        // The pill is text a reader has to read.
        expect(await contrastOf(pills(page, STAMPED)), where).toBeGreaterThanOrEqual(4.5);
        // No sideways scroll bought by the pill column.
        const o = await page.locator("#wikiList").evaluate((el) => el.scrollWidth - el.clientWidth);
        expect(o, where).toBeLessThanOrEqual(0);
      }
    }
  });

  test("pills: a row with a fold chip keeps the line structure and chip form of the same row without pills, 260–560px", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1400 });
    for (let width = 260; width <= 560; width += 20) {
      await page.addInitScript(([key, w]) => localStorage.setItem(key as string, String(w)), [RAIL_WIDTH_KEY, width] as const);
      await openReader(page, `wiki=${WIKI}`);
      const where = `${width}px`;
      await expect(pills(page, TWIN_MD).first(), where).toBeVisible();
      await expect(row(page, MIRROR_MD).locator(".wiki-issue-pill"), where).toHaveCount(0);
      if (width === 260) expect(await oneLine(page, MIRROR_MD), where).toBe(true);
      expect(await oneLine(page, TWIN_MD), where).toBe(await oneLine(page, MIRROR_MD));
      expect(await chipForm(page, TWIN_MD), where).toBe(await chipForm(page, MIRROR_MD));
      expect(await clippedPillRows(page), where).toEqual([]);
    }
  });

  test("pills: a title that fits two lines without its pill shows no ellipsis at the 260px rail", async ({ page }) => {
    await page.addInitScript(([key, w]) => localStorage.setItem(key as string, String(w)), [RAIL_WIDTH_KEY, 260] as const);
    await page.setViewportSize({ width: 1280, height: 1400 });
    await openReader(page, `wiki=${WIKI}`);
    const text = row(page, TWO_LINE).locator(".wiki-list-title-text");
    const fit = await text.evaluate((el) => ({
      lines: Math.round(el.scrollHeight / parseFloat(getComputedStyle(el).lineHeight)),
      clamped: el.scrollHeight > el.clientHeight + 1,
    }));
    expect(fit).toEqual({ lines: 2, clamped: false });
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`pills: 4.5:1 at rest, on the hovered row and on the active row, ${scheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openReader(page, `wiki=${WIKI}`);
      const pill = pills(page, STAMPED);
      await page.mouse.move(0, 0);
      expect(await paintedContrast(pill), "rest").toBeGreaterThanOrEqual(4.5);
      await row(page, STAMPED).hover();
      expect(await paintedContrast(pill), "hovered").toBeGreaterThanOrEqual(4.5);
      await row(page, STAMPED).click();
      await expect(row(page, STAMPED)).toHaveClass(/active/);
      await page.mouse.move(0, 0);
      expect(await paintedContrast(pill), "active").toBeGreaterThanOrEqual(4.5);
      await row(page, STAMPED).hover();
      expect(await paintedContrast(pill), "active, hovered").toBeGreaterThanOrEqual(4.5);
    });
  }

  test("pills: a listing refresh that drops the tracker drops its label and its cap", async ({ page }) => {
    await page.clock.install();
    await openReader(page, `wiki=${WIKI}`);
    await page.locator("#wikiFilters summary").click();
    await expect(page.locator("#jiraChips .wiki-chip-row-label")).toHaveText("Jira");
    // The same reader, handed a listing with no `trackers` (its config lost the
    // block): the label and the cap are the last wiki's no longer.
    const plain = await (await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI_PLAIN}`)).text();
    await page.route("**/api/wiki/pages**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: plain }));
    await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator(".wiki-issue-pill")).toHaveCount(0);
    await expect(page.locator('#jiraChips [data-jira="DEMO-180"]')).toBeVisible();
    await expect(page.locator("#jiraChips .wiki-chip-row-label")).toHaveCount(0);
    await expect(page.locator("#jiraChips [data-jira-more]")).toHaveCount(0);
  });

  test("pills: named with the tracker, +N carries its keys in the accessible name, a click opens the row", async ({ page }) => {
    await openReader(page, `wiki=${WIKI}`);
    await expect(pills(page, INFERRED).first()).toHaveAttribute("title", "Jira DEMO-130 — inferred (title)");
    await expect(pills(page, STAMPED)).toHaveAttribute("title", "Jira DEMO-180 — stamped");
    const plus = row(page, ANCHOR).locator(".wiki-issue-pill.more");
    await expect(plus).toHaveAttribute("aria-label", /^3 more: Jira DEMO-/);
    await pills(page, STAMPED).click();
    await expect(page.locator(".wiki-bc-cur")).toContainText("Stemplet");
  });
});
