/**
 * RELATED WORK in the /wiki reader — the Connections panel's top block.
 *
 * What the unit tests cannot reach, and the reason this file exists:
 *
 *  1. **The chain travels.** A row only appears if `buildWikiIndex` derives
 *     `prRefs` from the body, `computeRelated` reads the built graph, the
 *     single-page route carries `related[]` through `toListing`, the client type
 *     declares it and `renderConnections` paints it ABOVE the two link sections.
 *     Every unit test in that chain is green with the chain broken.
 *  2. **The two cuts, against a real corpus.** A hub is only a hub once 26
 *     pages really link to it, and a digest only once its body really names 16
 *     PR refs — both are facts about an index built from files on disk.
 *  3. **The listing did not grow.** `prRefs` is stripped for all three
 *     `toListing` callers; the assertion is over the rows a live
 *     `/api/wiki/pages` actually ships.
 *  4. **Contrast in both themes**, measured against whatever paints behind the
 *     why line rather than against a token named in the source.
 *
 * No model calls: nothing here leaves the process.
 *
 * ENV PREREQUISITE / SPAWN ENV: as every other spec in this directory — a
 * working `.env` at the repo root, and `e2eEnv()` to keep this muninn off
 * Telegram/Slack and off the host's instance-profile flags.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { contrastOf, paintedContrast } from "./contrast.ts";
import { WIKI_REFETCH_MIN_INTERVAL_MS } from "../src/dashboard/views/components/wiki-refresh.ts";
/**
 * The REAL constants, imported rather than re-typed. `src/wiki/related.ts`
 * itself is unloadable here — it reaches `registry.ts`, whose `import.meta.dir`
 * is `undefined` under Playwright's node loader, and the import alone made this
 * whole file report "No tests found" — but `related-constants.ts` imports
 * nothing, so it loads.
 *
 * ⚠️ Importing them keeps the fixture in STEP with them; it does not detect a
 * move. The fixture is sized from the values below, so the hub straddles
 * whatever the threshold is and the cut cases stay green either way — measured,
 * 25 → 10 and 25 → 30 both pass. The value pin further down is what reports a
 * move.
 */
import {
  RELATED_DIGEST_PRS,
  RELATED_HUB_BACKLINKS,
  STRENGTH_LINK_BOTH_WAYS,
  STRENGTH_LINK_ONE_WAY,
  STRENGTH_MAX,
  STRENGTH_PR_CAP,
  STRENGTH_PR_WEIGHT,
  STRENGTH_SESSION_CAP,
  STRENGTH_SESSION_DIGEST,
  STRENGTH_SESSION_WEIGHT,
} from "../src/wiki/related-constants.ts";

const PORT = e2ePort("wiki-related-work");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-related";

const OPEN = "plans/a.mdx";


/** Two PR refs the open page carries — one authored in `prs:`, one only in its
 *  prose, as a pull URL. Both have to reach `prRefs` for `c` to pair. */
const REF_AUTHORED = "RuneLind/muninn#549";
const REF_BODY = "RuneLind/muninn#550";
/** The session the sessions case shares. */
const SESSION_ID = "5a2ee3f0-c7ea-42f4-8082-1b2c3d4e5f60";

function md(title: string, fm: string[], body: string): string {
  return ["---", `title: ${title}`, ...fm, "---", "", body, ""].join("\n");
}

/**
 * ONE wiki holding every source and both cuts:
 *
 *  - `a` — the open page. `prs: [muninn#549]` and a pull URL for `#550` in its
 *    prose; links to `downstream`.
 *  - `b` — cites `a`.
 *  - `c` — cites `a` AND shares both refs: the two-reason row.
 *  - `downstream` — cited BY `a`.
 *  - `hub` — cites `a`, and 26 fillers cite `hub`. Dated NEWER than every real
 *    row, so it would lead the block if the cut were off.
 *  - `digest` — names 16 PR refs including both of `a`'s, and links nothing.
 *  - `unrelated` — shares exactly ONE ref and links nothing: one under the
 *    threshold, so a rule that paired on a single ref would put it in.
 *  - `a-prototype.html` — the open page's own attachment. `c` links to it and
 *    to `b`, so `c`'s second hop holds `a`, the attachment and `b`.
 *  - `dg-*` — a cluster of its own for the digest case: `dg-digest` cites
 *    `dg-open` and names 16 refs including both of its two; `dg-peer` cites it
 *    and names just those two.
 *
 * Every page carries a `status_date`, which breaks a strength tie on a temp
 * wiki with no git history. The three rows' MTIMES are set (`AGES_DAYS`), so
 * the age each row shows — and the `Newest` order — is a fixed fact.
 */
const PAGES: Array<[string, string]> = [
  [
    OPEN,
    md(
      "A page",
      [`prs: [${REF_AUTHORED}]`, "plan_status: in-flight", "status_date: 2026-09-20"],
      "The open page. Links [[downstream]] and names https://github.com/RuneLind/muninn/pull/550.",
    ),
  ],
  ["plans/b.mdx", md("Citing plan", ["status_date: 2026-09-18"], "Reads [[a]].")],
  [
    "blogs/c.mdx",
    md(
      "Sharing blog",
      [`prs: [${REF_AUTHORED}]`, "status_date: 2026-09-16"],
      "Reads [[a]], [[b]], [the prototype](../plans/a-prototype.html) and https://github.com/RuneLind/muninn/pull/550.",
    ),
  ],
  ["plans/a-prototype.html", "<!doctype html><html><head><title>A prototype</title></head><body>x</body></html>"],
  ["plans/downstream.mdx", md("Downstream plan", ["status_date: 2026-09-14"], "The successor.")],
  [
    "plans/hub.mdx",
    md("Hub page", ["status_date: 2026-09-19"], "Everything points here. Also reads [[a]]."),
  ],
  [
    "plans/digest.mdx",
    md(
      "Digest page",
      ["status_date: 2026-09-17"],
      `An audit naming muninn#549, muninn#550, ${Array.from(
        { length: RELATED_DIGEST_PRS - 1 },
        (_, i) => `huginn#${i + 1}`,
      ).join(", ")}.`,
    ),
  ],
  [
    "plans/unrelated.mdx",
    // ONE of the open page's refs and no link: the only page here a rule that
    // dropped `RELATED_SHARED_PRS_MIN` to 1 would admit. With "Nothing at all."
    // in its body the assertion below could not fail under any rule.
    md("Unrelated plan", ["status_date: 2026-09-13"], `Names ${REF_AUTHORED} once.`),
  ],
  // A pair sharing one stamped session and nothing else — the open page spells
  // it `provider:id`, the other bare. Linked to nothing above, so the block
  // under test is unchanged.
  [
    "plans/sess-open.mdx",
    md("Session open", [`sessions: [claude-code:${SESSION_ID}]`, "status_date: 2026-09-12"], "Body."),
  ],
  ["plans/sess-twin.mdx", md("Session twin", [`sessions: [${SESSION_ID}]`, "status_date: 2026-09-11"], "Body.")],
  // The digest cluster: `dg-open` declares two refs; `dg-digest` cites it and
  // names RELATED_DIGEST_PRS + 1 refs including both; `dg-peer` cites it and
  // names only the two.
  ["plans/dg-open.mdx", md("Digest open", ["prs: [RuneLind/muninn#700, RuneLind/muninn#701]", "status_date: 2026-09-10"], "Body.")],
  [
    "plans/dg-digest.mdx",
    md(
      "Digest citer",
      ["status_date: 2026-09-09"],
      `Reads [[dg-open]]. Names muninn#700, muninn#701, ${Array.from(
        { length: RELATED_DIGEST_PRS - 1 },
        (_, i) => `huginn#${i + 101}`,
      ).join(", ")}.`,
    ),
  ],
  ["plans/dg-peer.mdx", md("Digest peer", ["status_date: 2026-09-08"], "Reads [[dg-open]]. Names muninn#700 and muninn#701.")],
  // The series-pill cluster: `ser-open` cites `ser-nb`, a member of `alpha`
  // (labelled by its head `ser-alpha`); `ser-beta` heads `beta`. Joining
  // `ser-nb` to `beta` from the block's own ⋯ must move its pill.
  ["plans/ser-open.mdx", md("Series open", ["status_date: 2026-09-07"], "Reads [[ser-nb]].")],
  ["plans/ser-nb.mdx", md("Series neighbour", ["series: alpha", "status_date: 2026-09-06"], "Body.")],
  ["plans/ser-alpha.mdx", md("Alpha head", ["series: alpha", "series_label: Alpha line", "status_date: 2026-09-05"], "Body.")],
  ["plans/ser-beta.mdx", md("Beta head", ["series: beta", "series_label: Beta line", "status_date: 2026-09-04"], "Body.")],
  // The remove cluster: `rm-open` cites `rm-a` and `rm-b`, and `rm-a` cites
  // `rm-b` — so `rm-b`, a `gamma` member, is a block row AND a row in `rm-a`'s
  // hop. Removing it from the series must take its pill off both.
  ["plans/rm-open.mdx", md("Remove open", ["status_date: 2026-09-03"], "Reads [[rm-a]] and [[rm-b]].")],
  ["plans/rm-a.mdx", md("Remove via", ["status_date: 2026-09-02"], "Reads [[rm-b]].")],
  ["plans/rm-b.mdx", md("Remove member", ["series: gamma", "status_date: 2026-09-01"], "Body.")],
  ["plans/rm-head.mdx", md("Gamma head", ["series: gamma", "series_label: Gamma line", "status_date: 2026-08-31"], "Body.")],
  // The generation cluster: `g-a` and `g-b` both cite `g-x`, so `g-x`'s hop is
  // `[g-b]` from `g-a` and `[g-a]` from `g-b` — the two answers differ.
  ["plans/g-a.mdx", md("Gen A", ["status_date: 2026-08-30"], "Reads [[g-x]].")],
  ["plans/g-b.mdx", md("Gen B", ["status_date: 2026-08-29"], "Reads [[g-x]].")],
  ["plans/g-x.mdx", md("Gen X", ["status_date: 2026-08-28"], "Body.")],
];

/** How many days old each row's file is: the age the row shows. */
const AGES_DAYS: Record<string, number> = {
  "plans/downstream.mdx": 2,
  "plans/b.mdx": 5,
  "blogs/c.mdx": 9,
};

/** The rows the block must hold, strongest first (a 1.0 tie falls to
 *  `status_date`, newest first), with their why lines and scores. */
const EXPECTED: Array<[string, string, string]> = [
  ["Sharing blog", `cites this page · shares ${REF_AUTHORED}, ${REF_BODY}`, "2.2"],
  ["Citing plan", "cites this page", "1.0"],
  ["Downstream plan", "cited by this page", "1.0"],
];

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-related-"));
  for (const [rel, body] of PAGES) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
  for (const [rel, days] of Object.entries(AGES_DAYS)) {
    const at = new Date(Date.now() - days * 86_400_000);
    await utimes(path.join(root, rel), at, at);
  }
  // One past the threshold: the cut fires ABOVE it, not at it.
  await mkdir(path.join(root, "fill"), { recursive: true });
  for (let i = 1; i <= RELATED_HUB_BACKLINKS + 1; i++) {
    await writeFile(
      path.join(root, `fill/f${i}.mdx`),
      md(`Filler ${i}`, ["status_date: 2026-01-01"], "Points at [[hub]]."),
      "utf8",
    );
  }

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root}`,
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
  if (root) await rm(root, { recursive: true, force: true });
});

type Page = import("@playwright/test").Page;

/** The reader on the open page, waited for by its own H1 — the Connections
 *  panel is rendered in the same pass. */
async function openReader(page: Page): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(OPEN)}`);
  await expect(page.locator(".wiki-article-head h1")).toHaveText("A page");
  await expect(page.locator("#connBody .wiki-conn-section").first()).toBeVisible();
}

const relatedRows = (page: Page) => page.locator(".wiki-conn-item.wiki-conn-related");

/**
 * The deliberate "re-measure on the live wiki before moving this" guard.
 *
 * Every other case here is sized FROM the constants, which is what keeps the
 * boundary honest at any value — and what makes those cases blind to the value
 * itself. Both numbers are fitted to a 547-page mimir clone (the measurements
 * are in `related-constants.ts`: two pages over 25 backlinks, five over 15 PR
 * refs against 18 in the 6–15 band), so moving one is a re-measurement rather
 * than an edit, and this is the line that says so.
 *
 * A value pin in an ACCEPTANCE spec is not the unit-test tautology class: it
 * stands beside the cases that drive the same numbers through a real index, so
 * a red here reads "the tuning moved" rather than restating the source.
 */
test("the thresholds are the measured values — moving one means re-measuring", () => {
  expect(RELATED_HUB_BACKLINKS).toBe(25);
  expect(RELATED_DIGEST_PRS).toBe(15);
});

/** The neighbour weights the bar draws and the order sorts on. Moving one moves
 *  every score and STRENGTH_MAX, i.e. every bar's width — pinned here for the
 *  same reason as the thresholds above. */
test("the strength weights are the planned values — moving one rescales every bar", () => {
  expect(STRENGTH_LINK_ONE_WAY).toBe(1.0);
  expect(STRENGTH_LINK_BOTH_WAYS).toBe(1.6);
  expect(STRENGTH_PR_WEIGHT).toBe(0.6);
  expect(STRENGTH_PR_CAP).toBe(1.8);
  expect(STRENGTH_SESSION_WEIGHT).toBe(1.2);
  expect(STRENGTH_SESSION_CAP).toBe(2.4);
  expect(STRENGTH_SESSION_DIGEST).toBe(12);
  expect(STRENGTH_MAX).toBeCloseTo(5.8, 10);
});

test("the block leads the Connections panel, strongest first, with one why line and score per row", async ({
  page,
}) => {
  await openReader(page);

  // FIRST section in the panel — before `Linked from` and `Links to`, which are
  // the raw lists it is derived from.
  const titles = page.locator("#connBody .wiki-conn-title");
  await expect(titles.first().locator(".wiki-rel-count")).toHaveText(`Related work (${EXPECTED.length})`);
  await expect(titles.nth(1)).toContainText("Linked from");

  await expect(relatedRows(page)).toHaveCount(EXPECTED.length);
  for (const [i, [title, why, score]] of EXPECTED.entries()) {
    const row = relatedRows(page).nth(i);
    await expect(row.locator("> .wiki-conn-text > span")).toHaveText(title);
    await expect(row.locator(".wiki-conn-why")).toHaveText(why);
    await expect(row.locator(".wiki-rel-score")).toHaveText(score);
  }
  // The bars: a link segment on every row, a PR segment only where two refs
  // are shared, and widths on the one fixed scale — the one-way link is the
  // same width on all three rows.
  await expect(relatedRows(page).nth(0).locator(".seg-pr")).toHaveCount(1);
  await expect(relatedRows(page).nth(1).locator(".seg-pr")).toHaveCount(0);
  const linkWidths = await relatedRows(page)
    .locator(".seg-link")
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width * 10) / 10));
  expect(new Set(linkWidths).size).toBe(1);
  const bar = await relatedRows(page).nth(0).locator(".wiki-rel-bar").evaluate((e) => e.getBoundingClientRect().width);
  expect(linkWidths[0]! / bar).toBeCloseTo(STRENGTH_LINK_ONE_WAY / STRENGTH_MAX, 1);
  // Each row's age is the NEIGHBOUR's date, off its mtime on this git-less wiki.
  await expect(relatedRows(page).locator(".wiki-rel-age")).toHaveText(["9d", "5d", "2d"]);
});

test("Strongest | Newest: the toggle re-sorts by the age shown, and the choice survives a reload", async ({
  page,
}) => {
  await openReader(page);
  const order = page.locator("#connBody .wiki-rel-order");
  await expect(order.locator('[data-rel-order="strongest"]')).toHaveAttribute("aria-pressed", "true");
  await order.locator('[data-rel-order="newest"]').click();
  await expect(order.locator('[data-rel-order="newest"]')).toHaveAttribute("aria-pressed", "true");
  await expect(relatedRows(page).locator("> .wiki-conn-text > span")).toHaveText([
    "Downstream plan",
    "Citing plan",
    "Sharing blog",
  ]);
  // The ages read in order — the column the sort is on.
  await expect(relatedRows(page).locator(".wiki-rel-age")).toHaveText(["2d", "5d", "9d"]);

  await page.reload();
  await expect(page.locator(".wiki-article-head h1")).toHaveText("A page");
  await expect(page.locator('#connBody [data-rel-order="newest"]')).toHaveAttribute("aria-pressed", "true");
  await expect(relatedRows(page).first().locator("> .wiki-conn-text > span")).toHaveText("Downstream plan");

  await page.locator('#connBody [data-rel-order="strongest"]').click();
  await expect(relatedRows(page).first().locator("> .wiki-conn-text > span")).toHaveText("Sharing blog");
});

test("▸ opens a row's own related work — never the open page or its attachments", async ({ page }) => {
  // The control: without `exclude`, `c`'s block really holds `a` and `a`'s
  // attachment, so their absence below is the cut and not the fixture.
  const all = await (await fetch(`${BASE}/api/wiki/related?wiki=${WIKI}&relPath=blogs/c.mdx`)).json();
  expect(all.related.map((r: { relPath: string }) => r.relPath).sort()).toEqual([
    "plans/a-prototype.html",
    OPEN,
    "plans/b.mdx",
  ]);

  await openReader(page);
  const hops: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/wiki/related")) hops.push(req.url());
  });
  const row = relatedRows(page).first();
  await expect(row.locator("> .wiki-conn-text > span")).toHaveText("Sharing blog");
  await row.locator("[data-rel-hop]").click();
  // The ▸ is a control, not a row click: the open page did not change.
  await expect(page.locator(".wiki-article-head h1")).toHaveText("A page");
  await expect(row.locator("[data-rel-hop]")).toHaveAttribute("aria-expanded", "true");
  const hopRows = page.locator(".wiki-rel-hop-row");
  await expect(hopRows.locator("> .wiki-conn-text > span")).toHaveText(["Citing plan"]);
  const hopBody = page.locator('.wiki-rel-hop-body[data-rel-hop-for="blogs/c.mdx"]');
  await expect(hopBody).toContainText("Related to Sharing blog");
  await expect(hopBody).not.toContainText("A page");
  await expect(hopBody).not.toContainText("A prototype");
  expect(hops).toHaveLength(1);
  expect(new URL(hops[0]!).searchParams.get("exclude")).toBe(OPEN);

  // Closed and reopened, it is answered from the cache for this page open.
  await row.locator("[data-rel-hop]").click();
  await row.locator("[data-rel-hop]").click();
  await expect(hopRows).toHaveCount(1);
  expect(hops).toHaveLength(1);

  // A hop row opens its page through the panel's own handler.
  await hopRows.first().click();
  await expect(page.locator(".wiki-article-head h1")).toHaveText("Citing plan");
});

test("a DIGEST that links to the page shows its link and no PR segment", async ({ page }) => {
  const body = await (await fetch(`${BASE}/api/wiki/page?wiki=${WIKI}&relPath=plans/dg-open.mdx`)).json();
  const by = Object.fromEntries(
    body.related.map((r: { relPath: string; signals: unknown; why: string }) => [r.relPath, r]),
  );
  // Both cite the open page and both name its two refs; only the digest has
  // more than RELATED_DIGEST_PRS, so only the peer's PRs count.
  expect(by["plans/dg-digest.mdx"].why).toBe("cites this page");
  expect(by["plans/dg-digest.mdx"].signals).toEqual({ link: "in", prs: [], sessions: [] });
  expect(by["plans/dg-peer.mdx"].signals.prs).toHaveLength(2);

  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent("plans/dg-open.mdx")}`);
  await expect(page.locator(".wiki-article-head h1")).toHaveText("Digest open");
  const digest = relatedRows(page).filter({ hasText: "Digest citer" });
  const peer = relatedRows(page).filter({ hasText: "Digest peer" });
  await expect(digest.locator(".seg-link")).toHaveCount(1);
  await expect(digest.locator(".seg-pr")).toHaveCount(0);
  await expect(digest.locator(".wiki-rel-score")).toHaveText("1.0");
  await expect(peer.locator(".seg-pr")).toHaveCount(1);
  await expect(peer.locator(".wiki-rel-score")).toHaveText("2.2");
});

test("a row opens its page — the panel's own delegated handler, no second click path", async ({
  page,
}) => {
  await openReader(page);
  await relatedRows(page).first().locator("> .wiki-conn-text > span").click();
  await expect(page.locator(".wiki-article-head h1")).toHaveText("Sharing blog");
});

test("the HUB and the DIGEST are cut, though both are in the wiki and one cites the page", async ({
  page,
}) => {
  await openReader(page);

  // Both really exist, and the hub really links to the open page — so their
  // absence from the block is the cut rather than a missing fixture.
  const body = await (await fetch(`${BASE}/api/wiki/page?wiki=${WIKI}&relPath=plans/hub.mdx`)).json();
  expect(body.outgoing.map((p: { relPath: string }) => p.relPath)).toContain(OPEN);
  const digest = await (
    await fetch(`${BASE}/api/wiki/page?wiki=${WIKI}&relPath=plans/digest.mdx`)
  ).json();
  expect(digest.meta.title).toBe("Digest page");

  const texts = await relatedRows(page).allTextContents();
  expect(texts.join(" | ")).not.toContain("Hub page");
  expect(texts.join(" | ")).not.toContain("Digest page");
  expect(texts.join(" | ")).not.toContain("Unrelated plan");
});

test("a page sharing a stamped session appears, with the session as its reason", async ({ page }) => {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent("plans/sess-open.mdx")}`);
  await expect(page.locator(".wiki-article-head h1")).toHaveText("Session open");
  await expect(relatedRows(page)).toHaveCount(1);
  await expect(relatedRows(page).first().locator("> .wiki-conn-text > span")).toHaveText("Session twin");
  await expect(relatedRows(page).first().locator(".wiki-conn-why")).toHaveText(
    `shares session claude-code:${SESSION_ID}`,
  );
});

test("`/api/wiki/pages` rows carry no `prRefs` — the listing did not grow", async () => {
  const body = await (await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`)).json();
  // The field exists on the index (the block above is built from it), so its
  // absence here is the strip and not an empty corpus.
  expect(body.pages.length).toBeGreaterThan(PAGES.length);
  expect(body.pages.some((p: Record<string, unknown>) => "prRefs" in p)).toBe(false);
});

/**
 * The background the nearest PAINTING ancestor actually has — `contrastOf`'s own
 * walk, returned rather than folded into a ratio, so a hovered assertion can
 * prove the fill really changed instead of silently re-measuring the rest state.
 */
function paintedBg(locator: import("@playwright/test").Locator): Promise<string> {
  return locator.evaluate((el) => {
    let node: HTMLElement | null = el as HTMLElement;
    while (node) {
      const c = getComputedStyle(node).backgroundColor;
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
      node = node.parentElement;
    }
    return "none";
  });
}

test("the why line is fully VISIBLE — the PR numbers are what the `shares` reason is for", async ({
  page,
}) => {
  await openReader(page);
  const why = relatedRows(page).nth(0).locator(".wiki-conn-why");
  await expect(why).toHaveText(EXPECTED[0]![1]);

  // ⚠️ `toHaveText` passes on a CLIPPED element, which is how this shipped:
  // `white-space: nowrap` + `text-overflow: ellipsis` painted 248px of a 353px
  // line and hid 30% of it — the half carrying the PR numbers. Two measurements
  // are needed: the element's OWN box (the ellipsis) and every clipping
  // ancestor's (the technique `wiki-rail-series.spec.ts`'s census case uses).
  const fit = await why.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    let clipLeft = -Infinity;
    let clipRight = Infinity;
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (getComputedStyle(n).overflowX === "visible") continue;
      const r = n.getBoundingClientRect();
      clipLeft = Math.max(clipLeft, r.left);
      clipRight = Math.min(clipRight, r.right);
    }
    return {
      natural: rect.width,
      visible: Math.max(0, Math.min(rect.right, clipRight) - Math.max(rect.left, clipLeft)),
      client: el.clientWidth,
      scroll: el.scrollWidth,
      lines: Math.round(rect.height / parseFloat(getComputedStyle(el).lineHeight)),
    };
  });
  expect(fit.natural).toBeGreaterThan(0);
  expect(fit.visible).toBeGreaterThanOrEqual(fit.natural - 0.5);
  expect(fit.client).toBeGreaterThanOrEqual(fit.scroll);
  // …and it WRAPS (more than one line). How MANY lines is a fact about the
  // machine's font metrics, not the CSS — there is no line clamp — and the
  // runner's wider Linux glyphs turned a 2-line line into 3 (the same CI trap
  // #559 hit), so no upper bound is asserted here.
  expect(fit.lines).toBeGreaterThan(1);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the why line clears 4.5:1 in the ${scheme} theme, at rest and hovered`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openReader(page);
    // The `em` carries the reasons; the container carries only the separators.
    const row = relatedRows(page).nth(0);
    const reason = row.locator(".wiki-conn-why em").first();
    await expect(reason).toBeVisible();
    expect(await contrastOf(reason)).toBeGreaterThanOrEqual(4.5);

    // …and over the fill the row paints under the POINTER, which is where a
    // reader is whenever they are reading one of these rows. Measured at
    // --text-muted: 4.42:1 in the light theme, under the floor.
    const rest = await paintedBg(reason);
    await row.hover();
    const hovered = await paintedBg(reason);
    expect(hovered).not.toBe(rest);
    expect(await contrastOf(reason)).toBeGreaterThanOrEqual(4.5);
  });
}

/** Contrast of an element's own BACKGROUND (a bar segment is a graphic, not
 *  text) against what paints behind it — WCAG 1.4.11 asks 3:1. */
const fillContrast = (locator: import("@playwright/test").Locator) => paintedContrast(locator, { fill: true });

for (const scheme of ["light", "dark"] as const) {
  test(`the bar segments clear 3:1 and the score and age 4.5:1 in the ${scheme} theme, at rest and hovered`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const measure = async (row: import("@playwright/test").Locator, segs: string[]) => {
      for (const seg of segs) {
        expect(await fillContrast(row.locator(seg)), `${scheme} ${seg}`).toBeGreaterThanOrEqual(3);
      }
      expect(await contrastOf(row.locator(".wiki-rel-score")), `${scheme} score`).toBeGreaterThanOrEqual(4.5);
      expect(await contrastOf(row.locator(".wiki-rel-age")), `${scheme} age`).toBeGreaterThanOrEqual(4.5);
    };
    await openReader(page);
    const row = relatedRows(page).nth(0);
    await measure(row, [".seg-link", ".seg-pr"]);
    await row.hover();
    await measure(row, [".seg-link", ".seg-pr"]);

    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent("plans/sess-open.mdx")}`);
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Session open");
    const sess = relatedRows(page).nth(0);
    await measure(sess, [".seg-sess"]);
    await sess.hover();
    await measure(sess, [".seg-sess"]);
  });
}

test("▸ stays open across Strongest | Newest, with its rows", async ({ page }) => {
  await openReader(page);
  const row = relatedRows(page).filter({ hasText: "Sharing blog" });
  await row.locator("[data-rel-hop]").click();
  const hopBody = page.locator('.wiki-rel-hop-body[data-rel-hop-for="blogs/c.mdx"]');
  await expect(hopBody.locator(".wiki-rel-hop-row")).toHaveCount(1);
  await page.locator('#connBody [data-rel-order="newest"]').click();
  await expect(page.locator('#connBody [data-rel-order="newest"]')).toHaveAttribute("aria-pressed", "true");
  await expect(row.locator("[data-rel-hop]")).toHaveAttribute("aria-expanded", "true");
  await expect(hopBody).toBeVisible();
  await expect(hopBody.locator(".wiki-rel-hop-row > .wiki-conn-text > span")).toHaveText(["Citing plan"]);
});

test("re-clicking ▸ while its fetch is in flight sends no second request", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let requests = 0;
  await page.route("**/api/wiki/related**", async (route) => {
    requests++;
    await gate;
    await route.continue();
  });
  await openReader(page);
  const btn = relatedRows(page).filter({ hasText: "Sharing blog" }).locator("[data-rel-hop]");
  await btn.click();
  await expect(btn).toHaveAttribute("aria-expanded", "true");
  await btn.click();
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  await btn.click();
  await expect(btn).toHaveAttribute("aria-expanded", "true");
  release();
  const hopBody = page.locator('.wiki-rel-hop-body[data-rel-hop-for="blogs/c.mdx"]');
  await expect(hopBody.locator(".wiki-rel-hop-row")).toHaveCount(1);
  expect(requests).toBe(1);
});

test("the hop cache lives for ONE page open: leaving for the start view and coming back refetches", async ({
  page,
}) => {
  let requests = 0;
  page.on("request", (req) => {
    if (req.url().includes("/api/wiki/related")) requests++;
  });
  await openReader(page);
  const btn = () => relatedRows(page).filter({ hasText: "Sharing blog" }).locator("[data-rel-hop]");
  await btn().click();
  await expect(page.locator(".wiki-rel-hop-row")).toHaveCount(1);
  expect(requests).toBe(1);
  // A → start → A through the reader's own popstate handler: the same relPath
  // renders its connections again, which is a new page open.
  await page.evaluate((wiki) => {
    history.pushState({}, "", `/wiki?wiki=${wiki}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, WIKI);
  await expect(page.locator(".wiki-article-head h1")).toHaveText("Knowledge Wiki");
  await page.evaluate(
    ([wiki, rel]) => {
      history.pushState({ relPath: rel }, "", `/wiki?wiki=${wiki}&relPath=${encodeURIComponent(rel!)}`);
      dispatchEvent(new PopStateEvent("popstate"));
    },
    [WIKI, OPEN],
  );
  await expect(page.locator(".wiki-article-head h1")).toHaveText("A page");
  await expect(btn()).toHaveAttribute("aria-expanded", "false");
  await btn().click();
  await expect(page.locator(".wiki-rel-hop-row")).toHaveCount(1);
  expect(requests).toBe(2);
});

test("a series write from the block's own ⋯ moves that row's pill without reopening the page", async ({
  page,
}) => {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent("plans/ser-open.mdx")}`);
  await expect(page.locator(".wiki-article-head h1")).toHaveText("Series open");
  const nb = relatedRows(page).filter({ hasText: "Series neighbour" });
  await expect(nb.locator(".wiki-rel-series")).toHaveText("Alpha line");
  await nb.hover();
  await nb.locator("[data-series-menu]").click();
  await page.locator('#wikiSeriesMenu [data-series-cmd="join"][data-series-arg="beta"]').click();
  await expect(page.locator("#wikiSeriesMenu")).toHaveCount(0);
  await expect(page.locator(".wiki-article-head h1")).toHaveText("Series open");
  await expect(nb.locator(".wiki-rel-series")).toHaveText("Beta line");
});

for (const scheme of ["light", "dark"] as const) {
  test(`▸ and the order toggle clear 4.5:1 in the ${scheme} theme, at rest and hovered`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openReader(page);
    const row = relatedRows(page).nth(0);
    const hop = row.locator("[data-rel-hop]");
    const toggles = page.locator("#connBody .wiki-rel-order button");
    const check = async (label: string) => {
      expect(await paintedContrast(hop), `${scheme} ▸ ${label}`).toBeGreaterThanOrEqual(4.5);
      for (let i = 0; i < 2; i++) {
        expect(await paintedContrast(toggles.nth(i)), `${scheme} toggle ${i} ${label}`).toBeGreaterThanOrEqual(4.5);
      }
    };
    await check("at rest");
    // The pointer on the row's title: ▸ keeps its rest colour over the hover fill.
    await row.locator("> .wiki-conn-text > span").hover();
    await check("row hovered");
    await hop.hover();
    expect(await paintedContrast(hop), `${scheme} ▸ hovered`).toBeGreaterThanOrEqual(4.5);
    for (let i = 0; i < 2; i++) {
      await toggles.nth(i).hover();
      expect(await paintedContrast(toggles.nth(i)), `${scheme} toggle ${i} hovered`).toBeGreaterThanOrEqual(4.5);
    }
  });
}

/** Open a page through the reader's own popstate handler — a navigation the
 *  reader did not click, so nothing else races it. */
async function popTo(page: Page, rel: string): Promise<void> {
  await page.evaluate(
    ([wiki, r]) => {
      history.pushState({ relPath: r }, "", `/wiki?wiki=${wiki}&relPath=${encodeURIComponent(r!)}`);
      dispatchEvent(new PopStateEvent("popstate"));
    },
    [WIKI, rel],
  );
}

test("Remove from series on a block row takes its pill off — in the block AND in an open hop — without a reload", async ({
  page,
}) => {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent("plans/rm-open.mdx")}`);
  await expect(page.locator(".wiki-article-head h1")).toHaveText("Remove open");
  const member = relatedRows(page).filter({ hasText: "Remove member" });
  await expect(member.locator(".wiki-rel-series")).toHaveText("Gamma line");
  // `rm-a`'s hop holds the same page.
  await relatedRows(page).filter({ hasText: "Remove via" }).locator("[data-rel-hop]").click();
  const hopMember = page
    .locator('.wiki-rel-hop-body[data-rel-hop-for="plans/rm-a.mdx"] .wiki-rel-hop-row')
    .filter({ hasText: "Remove member" });
  await expect(hopMember.locator(".wiki-rel-series")).toHaveText("Gamma line");

  await member.hover();
  await member.locator("[data-series-menu]").click();
  await page.locator('#wikiSeriesMenu [data-series-cmd="remove"]').click();
  await expect(page.locator("#wikiSeriesMenu")).toHaveCount(0);
  await expect(page.locator(".wiki-article-head h1")).toHaveText("Remove open");
  // A field going set → ABSENT: the fresh listing row omits `series`, so a
  // merge over the page response's stale row would keep the old pill.
  await expect(member.locator(".wiki-rel-series")).toHaveCount(0);
  await expect(hopMember).toHaveCount(1);
  await expect(hopMember.locator(".wiki-rel-series")).toHaveCount(0);
});

test("a hop answer landing after the reader moved on is dropped — the new page asks for its own", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const excludes: Array<string | null> = [];
  await page.route("**/api/wiki/related**", async (route) => {
    const exclude = new URL(route.request().url()).searchParams.get("exclude");
    excludes.push(exclude);
    if (exclude === "plans/g-a.mdx") await gate;
    await route.continue();
  });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent("plans/g-a.mdx")}`);
  await expect(page.locator(".wiki-article-head h1")).toHaveText("Gen A");
  const btn = () => relatedRows(page).filter({ hasText: "Gen X" }).locator("[data-rel-hop]");
  await btn().click();
  await expect.poll(() => excludes.length).toBe(1);

  // A → B while A's answer (`g-x` minus A, i.e. `[Gen B]`) is in flight.
  await popTo(page, "plans/g-b.mdx");
  await expect(page.locator(".wiki-article-head h1")).toHaveText("Gen B");
  await expect(btn()).toHaveAttribute("aria-expanded", "false");
  const landed = page.waitForEvent("requestfinished", (r) => new URL(r.url()).searchParams.get("exclude") === "plans/g-a.mdx");
  release();
  await landed;
  // The page's own `.then` chain runs after the body arrives.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));

  await btn().click();
  const hopBody = page.locator('.wiki-rel-hop-body[data-rel-hop-for="plans/g-x.mdx"]');
  await expect(hopBody.locator(".wiki-rel-hop-row > .wiki-conn-text > span")).toHaveText(["Gen A"]);
  await expect(hopBody).not.toContainText("Gen B");
  // B asked for its own answer, with B excluded.
  expect(excludes).toEqual(["plans/g-a.mdx", "plans/g-b.mdx"]);
});

test("a failed hop says so, and the next open asks again — a network failure and an error answer alike", async ({
  page,
}) => {
  let n = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/related**", async (route) => {
    n++;
    if (n === 1) return route.abort("failed");
    if (n === 2) {
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
    }
    await gate;
    return route.continue();
  });
  await openReader(page);
  const btn = relatedRows(page).filter({ hasText: "Sharing blog" }).locator("[data-rel-hop]");
  const hopBody = page.locator('.wiki-rel-hop-body[data-rel-hop-for="blogs/c.mdx"]');

  await btn.click();
  await expect(hopBody).toHaveText("Related work unavailable.");
  expect(n).toBe(1);
  await btn.click();
  await expect(btn).toHaveAttribute("aria-expanded", "false");
  await btn.click();
  await expect(hopBody).toHaveText("Related work unavailable.");
  expect(n).toBe(2);

  // Closed and reopened again: a fresh request, shown as Loading — not the
  // failure left over from the last open.
  await btn.click();
  await btn.click();
  await expect.poll(() => n).toBe(3);
  await expect(hopBody).toHaveText("Loading…");
  release();
  await expect(hopBody.locator(".wiki-rel-hop-row > .wiki-conn-text > span")).toHaveText(["Citing plan"]);
  expect(n).toBe(3);
});

test("a listing adopted as a navigation starts repaints the block under its worked axis, though the navigation fails", async ({
  page,
}) => {
  await page.clock.install();
  // The boot listing as served; a FORCED refresh comes back saying the ledger
  // covers this wiki, which turns the worked axis on.
  await page.route("**/api/wiki/pages**", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (new URL(route.request().url()).searchParams.get("refresh") === "1") {
      body.workedCoverage = { matched: 1, total: body.pages.length, returned: 1, asOfMs: Date.now() };
    }
    await route.fulfill({ response: res, json: body });
  });
  await openReader(page);
  const ages = page.locator("#connBody .wiki-conn-related .wiki-rel-age");
  await expect(ages).toHaveCount(EXPECTED.length);
  await expect(page.locator("#connBody .wiki-rel-age.fallback")).toHaveCount(0);

  // A focus refetch past the throttle: under an open article the listing waits.
  const refetched = page.waitForEvent(
    "requestfinished",
    (r) => r.url().includes("/api/wiki/pages") && new URL(r.url()).searchParams.get("refresh") === "1",
  );
  await page.clock.fastForward(WIKI_REFETCH_MIN_INTERVAL_MS + 1_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await refetched;
  await page.evaluate(() => new Promise((r) => setTimeout(r, 150)));
  await expect(page.locator("#connBody .wiki-rel-age.fallback")).toHaveCount(0);

  // The navigation that adopts it fails; the block it leaves on screen is
  // repainted under the axis the adopted listing turned on.
  await page.route((url) => url.pathname === "/api/wiki/page", (route) => route.abort("failed"));
  await relatedRows(page).first().locator("> .wiki-conn-text > span").click();
  await expect(page.locator("#articleWrap .wiki-empty-state")).toContainText("Failed to load page");
  await expect(page.locator("#connBody .wiki-conn-related .wiki-rel-age.fallback")).toHaveCount(EXPECTED.length);
});
