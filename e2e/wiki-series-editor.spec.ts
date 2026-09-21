/**
 * The SERIES EDITOR — campaign 2 PR D's acceptance 11, end to end.
 *
 * What only a browser can prove, and the reason this file exists:
 *
 *  1. **The click reaches the file.** A menu whose model is perfect is still
 *     dead if the opener is not rendered, the delegate does not claim it, the
 *     CAS base is never fetched or the POST body names a key the route does not
 *     read. The assertions here are on the BYTES on disk.
 *  2. **The rail re-renders.** The write refreshes the wiki index server-side,
 *     but nothing on screen moves unless the client refetches AND applies — and
 *     `receivePages` defers an applied listing while an article is open, which
 *     is exactly the state the reader header's `edit series` acts from.
 *  3. **`#wikiCount` is unchanged.** A series claims its members before the
 *     family and month rules see the list; a page joining one must move, not
 *     appear twice or vanish.
 *  4. **The read-only refusal is ABSENT, not dimmed** — and the POST behind it
 *     really 403s, against a muninn actually booted in that mode.
 *
 * No model calls: nothing here leaves the process.
 *
 * ENV PREREQUISITE / SPAWN ENV: as every other spec in this directory — a
 * working `.env` at the repo root, and `e2eEnv()` to keep these muninns off
 * Telegram/Slack and off the host's instance-profile flags. That second half
 * matters most here: the writable instance is only writable if the host's own
 * `MUNINN_WIKI_READONLY` does not reach it, and the two servers are deliberately
 * in DIFFERENT write modes.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { contrastOf } from "./contrast.ts";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { SETTLED_CREATED_LINE, settleWikiMtimes } from "./settled-wiki.ts";

const PORT = e2ePort("wiki-series-editor");
const RO_PORT = e2ePort("wiki-series-editor/readonly");
const BASE = `http://127.0.0.1:${PORT}`;
const RO_BASE = `http://127.0.0.1:${RO_PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-series-edit";
/** A SECOND wiki on the writable server, registered read-only per root — the
 *  mini's exact shape, where the instance owns writes and this root is one it
 *  only reads. */
const RO_WIKI = "e2e-series-edit-ro";
/** A THIRD wiki, holding more series than the menu will list — the only way to
 *  drive a popover that really scrolls, and to see the cap's own note. Its own
 *  corpus so the acceptance fixture above keeps one series and one fold. */
const MANY_WIKI = "e2e-series-edit-many";
const MANY_SERIES = 16;
const MANY_FREE = "plans/free.mdx";
const LABEL = "Wiki provenance";
const KEY = "prov";
const FOLD = `series:${KEY}`;

const HEAD = "plans/prov-plan.mdx";
const SHIPPED = "plans/prov-strip.mdx";
const BLOG = "blogs/prov-explained.mdx";
/** The page acceptance 11 adds to the series. */
const JOINER = "plans/recall.mdx";
const OUTSIDER = "plans/solo.mdx";
/** A page no series can ever claim: the wiki's own bookkeeping. */
const META = "index.md";
/** …and the other half of that rule — a page that is not markdown at all. */
const ATTACHMENT = "blogs/report.html";

function md(title: string, extra: string[] = [], body = "Body."): string {
  return ["---", `title: ${title}`, SETTLED_CREATED_LINE, ...extra, "---", "", body, ""].join("\n");
}

const PAGES: Array<[string, string]> = [
  [
    HEAD,
    md("Wiki provenance plan", [
      `series: ${KEY}`,
      `series_label: ${LABEL}`,
      "plan_status: in-flight",
      "status_date: 2026-09-02",
    ]),
  ],
  [
    SHIPPED,
    md("Provenance chain strip", [`series: ${KEY}`, "plan_status: shipped", "status_date: 2026-05-01"]),
  ],
  [BLOG, md("Provenance campaign explained", [`series: ${KEY}`, "status_date: 2026-03-01"])],
  [JOINER, md("Search recall plan", ["plan_status: proposed", "status_date: 2026-09-03"])],
  // It CITES the head, which is what puts it in the head's `Related work` block
  // — the editor's second opener site, and a block with no rows has no opener
  // to click.
  [
    OUTSIDER,
    md(
      "Solo page",
      ["plan_status: shipped", "status_date: 2026-01-01"],
      "Body, which cites [[prov-plan]].",
    ),
  ],
  [META, md("Index")],
  [ATTACHMENT, "<html><body><h1>Report</h1><p>Body.</p></body></html>\n"],
];

let server: ChildProcess | undefined;
let roServer: ChildProcess | undefined;
let root = "";
let roRoot = "";
let roServerRoot = "";
let manyRoot = "";

async function writeWiki(dir: string): Promise<void> {
  for (const [rel, body] of PAGES) {
    await mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(dir, rel), body, "utf8");
  }
  await settleWikiMtimes(dir);
}

function boot(port: number, extra: string, env: Record<string, string> = {}): ChildProcess {
  return spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(port),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: extra,
      ...env,
    },
    stdio: "ignore",
  });
}

async function waitUp(base: string, wiki: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/wiki/pages?wiki=${wiki}`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`muninn did not start on ${base}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

const read = (dir: string, rel: string) => readFile(path.join(dir, rel), "utf8");

/** The page's frontmatter lines — what every byte assertion here is about. */
async function fence(dir: string, rel: string): Promise<string[]> {
  const lines = (await read(dir, rel)).split("\n");
  const close = lines.indexOf("---", 1);
  return lines.slice(1, close === -1 ? 1 : close);
}

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-sered-"));
  await writeWiki(root);
  // The writable server's SECOND wiki, registered read-only by root.
  roRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-sered-roroot-"));
  await writeWiki(roRoot);
  // The read-only INSTANCE gets a corpus of its own, so a refused write there
  // can never be confused with one that landed on the writable server's copy.
  roServerRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-sered-ro-"));
  await writeWiki(roServerRoot);
  manyRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-sered-many-"));
  await mkdir(path.join(manyRoot, "plans"), { recursive: true });
  for (let i = 0; i < MANY_SERIES; i++) {
    await writeFile(
      path.join(manyRoot, `plans/m${i}.mdx`),
      md(`Series member ${i}`, [`series: s${i}`, `series_label: Series ${i}`, "plan_status: shipped", `status_date: 2026-09-${String(20 - i).padStart(2, "0")}`]),
      "utf8",
    );
  }
  await writeFile(path.join(manyRoot, MANY_FREE), md("Free page", ["plan_status: proposed"]), "utf8");
  await settleWikiMtimes(manyRoot);

  server = boot(PORT, `${WIKI}=${root},${RO_WIKI}=${roRoot},${MANY_WIKI}=${manyRoot}`, {
    WIKI_READONLY_ROOTS: roRoot,
  });
  roServer = boot(RO_PORT, `${WIKI}=${roServerRoot}`, { MUNINN_WIKI_READONLY: "1" });
  await Promise.all([waitUp(BASE, WIKI), waitUp(RO_BASE, WIKI)]);
});

/**
 * Reset the writable corpus between cases — every case here writes.
 *
 * The `?refresh=1` is load-bearing: the store's index is a 5-minute TTL cache
 * and these files are rewritten BEHIND the server, so without it the next case's
 * boot fetch (a plain one, by design) serves the previous case's frontmatter —
 * which reads as this editor leaking a write across tests.
 */
test.beforeEach(async () => {
  await writeWiki(root);
  await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}&refresh=1`);
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  roServer?.kill("SIGTERM");
  for (const dir of [root, roRoot, roServerRoot, manyRoot]) {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function openRail(page: Page, base = BASE, wiki = WIKI): Promise<void> {
  await page.goto(`${base}/wiki?wiki=${wiki}`);
  await expect(page.locator(".wiki-list-item").first()).toBeAttached();
}

async function openPage(page: Page, rel: string, title: string, base = BASE): Promise<void> {
  await page.goto(`${base}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);
  await expect(page.locator(".wiki-article-head h1")).toHaveText(title);
}

const row = (page: Page, rel: string) => page.locator(`.wiki-list-item[data-relpath="${rel}"]`);
const menu = (page: Page) => page.locator("#wikiSeriesMenu");
const countText = async (page: Page) => (await page.locator("#wikiCount").textContent()) ?? "";

/**
 * Open the rail row's ⋯ menu.
 *
 * Hover, then an ORDINARY click — never `force`. The control is revealed by its
 * own row's hover and is out of flow while hidden, so a forced click is a click
 * at coordinates whose hit test the CSS decides: it lands on the row (and opens
 * the page) exactly when the reveal is broken, which is the failure this
 * feature shipped with. The unforced click is the assertion.
 */
async function openRowMenu(page: Page, rel: string): Promise<void> {
  await row(page, rel).hover();
  await row(page, rel).locator("[data-series-menu]").click();
  await expect(menu(page)).toBeVisible();
}

/**
 * Open the Series fold.
 *
 * Load-bearing, not setup noise: a CLOSED fold renders none of its member rows
 * at all, so with it shut a member has no `⋯` to click and a page that JOINS the
 * series leaves the DOM entirely — and `#wikiCount` drops by exactly one, which
 * is the fold's own documented arithmetic rather than anything this editor did.
 * Open, the count is the claim acceptance 11 makes.
 */
async function openSeriesFold(page: Page): Promise<void> {
  const fold = page.locator(`.wiki-list-group[data-group="${FOLD}"] .wiki-group-fold`);
  if ((await fold.getAttribute("aria-expanded")) === "false") await fold.click();
  await expect(page.locator(".wiki-list-item.member").first()).toBeVisible();
}

test.describe("adding a page to a series from the rail", () => {
  test("writes exactly one line and the rail re-renders with the page inside the fold", async ({
    page,
  }) => {
    await openRail(page);
    await openSeriesFold(page);
    const before = await countText(page);
    const bytesBefore = await read(root, JOINER);
    // The joiner starts OUTSIDE the series fold. The fixture has exactly one
    // group, so `.member` names that fold's rows and nothing else.
    await expect(page.locator(".wiki-list-item.member")).toHaveCount(3);
    await expect(row(page, JOINER)).not.toHaveClass(/member/);

    await openRowMenu(page, JOINER);
    await page.locator(`#wikiSeriesMenu [data-series-cmd="join"][data-series-arg="${KEY}"]`).click();
    await expect(menu(page)).toHaveCount(0);

    // ── the file ──
    await expect
      .poll(async () => (await read(root, JOINER)).split("\n").length)
      .toBe(bytesBefore.split("\n").length + 1);
    const added = (await read(root, JOINER))
      .split("\n")
      .filter((l) => !bytesBefore.split("\n").includes(l));
    expect(added).toEqual([`series: ${KEY}`]);

    // ── the rail ──
    await expect(row(page, JOINER)).toHaveClass(/member/);
    await expect(page.locator(".wiki-list-item.member")).toHaveCount(4);
    // The page MOVED: the rail still accounts for every page exactly once.
    expect(await countText(page)).toBe(before);
  });

  test("the page's own header then names the series", async ({ page }) => {
    await openRail(page);
    await openRowMenu(page, JOINER);
    await page.locator(`#wikiSeriesMenu [data-series-cmd="join"][data-series-arg="${KEY}"]`).click();
    await expect(menu(page)).toHaveCount(0);
    await expect.poll(async () => (await fence(root, JOINER)).join("|")).toContain("series: prov");

    await openPage(page, JOINER, "Search recall plan");
    await expect(page.locator(".wiki-series-head .wiki-series-name")).toHaveText(LABEL);
    await expect(page.locator(".wiki-series-head .wiki-series-count")).toHaveText("4 pages");
  });

  test("the series the page is already in is inert, not a second join", async ({ page }) => {
    await openRail(page);
    await openSeriesFold(page);
    await openRowMenu(page, HEAD);
    await expect(
      page.locator(`#wikiSeriesMenu [data-series-cmd="join"][data-series-arg="${KEY}"]`),
    ).toHaveCount(0);
    await expect(page.locator("#wikiSeriesMenu .wiki-series-menu-row.is-current")).toHaveCount(1);
  });

  test("a new key from the field creates a series of one", async ({ page }) => {
    await openRail(page);
    await openRowMenu(page, OUTSIDER);
    await page.locator('#wikiSeriesMenu [data-series-form="new"] [data-series-input]').fill("recall");
    await page.locator('#wikiSeriesMenu [data-series-form="new"] button[type="submit"]').click();
    await expect(menu(page)).toHaveCount(0);
    await expect.poll(async () => (await fence(root, OUTSIDER)).join("|")).toContain("series: recall");
    // One member is not a fold — the rail renders no group for it, and the page
    // is still an ordinary row.
    await expect(page.locator('.wiki-list-group[data-group="series:recall"]')).toHaveCount(1);
  });
});

test.describe("edit series, from the reader header", () => {
  test("renaming the label changes the HEAD's bytes and no other member's", async ({ page }) => {
    const shippedBefore = await read(root, SHIPPED);
    const blogBefore = await read(root, BLOG);
    await openPage(page, SHIPPED, "Provenance chain strip");
    await page.locator("[data-series-edit]").click();
    await expect(menu(page)).toBeVisible();
    await page.locator('#wikiSeriesMenu [data-series-form="label"] [data-series-input]').fill("Renamed series");
    await page.locator('#wikiSeriesMenu [data-series-form="label"] button[type="submit"]').click();
    await expect(menu(page)).toHaveCount(0);

    await expect
      .poll(async () => (await fence(root, HEAD)).find((l) => l.startsWith("series_label:")))
      .toBe("series_label: Renamed series");
    // The label lives on ONE page; the other two members are byte-identical.
    expect(await read(root, SHIPPED)).toBe(shippedBefore);
    expect(await read(root, BLOG)).toBe(blogBefore);
    // And the header the reader is looking at repaints without a navigation.
    await expect(page.locator(".wiki-series-head .wiki-series-name")).toHaveText("Renamed series");
  });

  test("moving the head changes TWO files, in the order that leaves a reportable state", async ({
    page,
  }) => {
    const blogBefore = await read(root, BLOG);
    await openPage(page, SHIPPED, "Provenance chain strip");
    await page.locator("[data-series-edit]").click();
    await expect(menu(page)).toBeVisible();
    await page.locator(`#wikiSeriesMenu [data-series-cmd="head"][data-series-arg="${SHIPPED}"]`).click();
    await expect(menu(page)).toHaveCount(0);

    await expect
      .poll(async () => (await fence(root, SHIPPED)).find((l) => l.startsWith("series_label:")))
      .toBe(`series_label: ${LABEL}`);
    // The old head lost it, and kept everything else.
    const headFence = await fence(root, HEAD);
    expect(headFence.some((l) => l.startsWith("series_label:"))).toBe(false);
    expect(headFence).toContain(`series: ${KEY}`);
    expect(headFence).toContain("plan_status: in-flight");
    // The third member is untouched — a head move is two files, not three.
    expect(await read(root, BLOG)).toBe(blogBefore);
  });

  test("removing the page drops the line and the page leaves the fold", async ({ page }) => {
    await openPage(page, BLOG, "Provenance campaign explained");
    await expect(page.locator(".wiki-series-head")).toHaveCount(1);
    await page.locator("[data-series-edit]").click();
    await page.locator('#wikiSeriesMenu [data-series-cmd="remove"]').click();
    await expect(menu(page)).toHaveCount(0);

    await expect
      .poll(async () => (await fence(root, BLOG)).some((l) => l.startsWith("series:")))
      .toBe(false);
    // The header goes with the membership, in place.
    await expect(page.locator(".wiki-series-head")).toHaveCount(0);
    // And the rail's fold lost its blog: the roll-up counts the two plans left,
    // and the removed page is an ordinary row again rather than a member.
    await expect(
      page.locator(`.wiki-list-group[data-group="${FOLD}"] .wiki-fold-chip-label`),
    ).toHaveText("1 in-flight · 1 shipped");
    await expect(row(page, BLOG)).not.toHaveClass(/member/);
  });
});

test.describe("read-only", () => {
  test("a read-only INSTANCE renders neither opener and 403s the POST", async ({ page }) => {
    await openRail(page, RO_BASE);
    await expect(page.locator("[data-series-menu]")).toHaveCount(0);
    await page.goto(`${RO_BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(HEAD)}`);
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Wiki provenance plan");
    await expect(page.locator(".wiki-series-head")).toHaveCount(1);
    await expect(page.locator("[data-series-edit]")).toHaveCount(0);

    const before = await read(roServerRoot, JOINER);
    const res = await fetch(`${RO_BASE}/api/wiki/series`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wiki: WIKI, relPath: JOINER, baseHash: "x", series: KEY }),
    });
    expect(res.status).toBe(403);
    expect(await read(roServerRoot, JOINER)).toBe(before);
  });

  test("a read-only ROOT on the writable instance behaves the same", async ({ page }) => {
    await openRail(page, BASE, RO_WIKI);
    await expect(page.locator("[data-series-menu]")).toHaveCount(0);
    await page.goto(`${BASE}/wiki?wiki=${RO_WIKI}&relPath=${encodeURIComponent(HEAD)}`);
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Wiki provenance plan");
    await expect(page.locator("[data-series-edit]")).toHaveCount(0);

    const before = await read(roRoot, JOINER);
    const res = await fetch(`${BASE}/api/wiki/series`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wiki: RO_WIKI, relPath: JOINER, baseHash: "x", series: KEY }),
    });
    expect(res.status).toBe(403);
    expect(await read(roRoot, JOINER)).toBe(before);
    // The SAME instance still edits its writable wiki — the refusal is per root.
    await openRail(page, BASE, WIKI);
    await expect(page.locator("[data-series-menu]").first()).toBeAttached();
  });
});

/**
 * The CAS the popover really holds — fix round 1, finding A.
 *
 * The base was read one fetch before each POST, so the window it compared
 * against was the network round trip rather than the seconds a human spends in
 * the menu: an edit landing while the popover stood open was overwritten
 * without a word. The bases are captured at OPEN now, and the only way to see
 * that from the outside is to move the file while the menu is on screen.
 */
test.describe("the base the menu holds", () => {
  test("an edit made while the menu is open is refused, not overwritten", async ({ page }) => {
    await openRail(page);
    await openRowMenu(page, JOINER);
    // Behind the server AND behind the reader: the menu is already painted.
    const edited = (await read(root, JOINER)).replace("Body.", "Body, rewritten elsewhere.");
    await writeFile(path.join(root, JOINER), edited, "utf8");

    await page.locator(`#wikiSeriesMenu [data-series-cmd="join"][data-series-arg="${KEY}"]`).click();
    const msg = page.locator("#wikiSeriesMenu .wiki-series-menu-msg.bad");
    await expect(msg).toBeVisible();
    await expect(msg).toContainText(JOINER);
    // The file is EXACTLY what the other writer left: no `series:` line, and the
    // out-of-band edit intact.
    expect(await read(root, JOINER)).toBe(edited);
    expect((await fence(root, JOINER)).some((l) => l.startsWith("series:"))).toBe(false);
  });

  test("the SECOND write of a head move is refused the same way, and the rail says so", async ({
    page,
  }) => {
    // The head move is clear-then-set. The target is the page the reader has
    // open, so its base is the one the page payload carried — and moving the
    // file under it is what proves the editor is holding that base rather than
    // re-reading it a millisecond before the POST.
    await openPage(page, SHIPPED, "Provenance chain strip");
    await page.locator("[data-series-edit]").click();
    await expect(menu(page)).toBeVisible();
    const edited = (await read(root, SHIPPED)).replace("Body.", "Body, rewritten elsewhere.");
    await writeFile(path.join(root, SHIPPED), edited, "utf8");

    await page.locator(`#wikiSeriesMenu [data-series-cmd="head"][data-series-arg="${SHIPPED}"]`).click();
    const msg = page.locator("#wikiSeriesMenu .wiki-series-menu-msg.bad");
    await expect(msg).toBeVisible();
    await expect(msg).toContainText(SHIPPED);
    // Write 1 landed: the old head's label is gone from disk.
    await expect
      .poll(async () => (await fence(root, HEAD)).some((l) => l.startsWith("series_label:")))
      .toBe(false);
    // Write 2 did not: the target is byte-identical to the out-of-band edit.
    expect(await read(root, SHIPPED)).toBe(edited);
    // And the reader is NOT left looking at a label that is gone from every
    // file: the failure path refreshes too, so the header falls back to the
    // bare key.
    await expect(page.locator(".wiki-series-head .wiki-series-name")).toHaveText(KEY);
  });
});

/**
 * A label belongs to a SERIES — fix round 2, the defect.
 *
 * The join and new-key verbs post `{relPath, series}` and no `seriesLabel`, so a
 * page that was the HEAD of the series it is leaving used to carry that name
 * into the series it joins: two labelled members there, and the series it left
 * with no name at all. The route clears it now, and the popover stays open to
 * say which series that was.
 */
test.describe("moving the head of a series", () => {
  test("drops the label and names the series left behind", async ({ page }) => {
    // The new-key field, because this fixture holds ONE series: typing a key is
    // the same client path as a join (`{relPath, series}`, no label) and the
    // only one that needs no second series seeded into every other case's
    // arithmetic.
    await openPage(page, HEAD, "Wiki provenance plan");
    await expect(page.locator(".wiki-series-head .wiki-series-name")).toHaveText(LABEL);
    await page.locator("[data-series-edit]").click();
    await expect(menu(page)).toBeVisible();
    await page.locator('#wikiSeriesMenu [data-series-form="new"] [data-series-input]').fill("recall");
    await page.locator('#wikiSeriesMenu [data-series-form="new"] button[type="submit"]').click();

    // ── the file ──
    await expect
      .poll(async () => (await fence(root, HEAD)).find((l) => l.startsWith("series:")))
      .toBe("series: recall");
    expect((await fence(root, HEAD)).some((l) => l.startsWith("series_label:"))).toBe(false);
    // ── the reader ──
    // The menu stays open, because the line below is the only place this is
    // said — and it names the series that has just lost its name.
    const msg = page.locator("#wikiSeriesMenu .wiki-series-menu-msg");
    await expect(msg).toBeVisible();
    await expect(msg).toContainText(`"${KEY}"`);
    await expect(msg).not.toHaveClass(/bad/);
    // The two members left really do render under the bare key now, rather than
    // a second series called "Wiki provenance" beside the first.
    await openPage(page, SHIPPED, "Provenance chain strip");
    await expect(page.locator(".wiki-series-head .wiki-series-name")).toHaveText(KEY);
  });
});

/**
 * What the popover holds between clicks — fix round 2, the lines a mutation
 * survived in round 1.
 */
test.describe("the menu between clicks", () => {
  test("two renames in a row both land", async ({ page }) => {
    // The second write's CAS base is the hash the FIRST write answered with:
    // `/api/wiki/page` is read once, at page load, so without the re-stamp the
    // reader's second edit is refused as somebody else's change.
    await openPage(page, HEAD, "Wiki provenance plan");
    for (const name of ["First rename", "Second rename"]) {
      await page.locator("[data-series-edit]").click();
      await expect(menu(page)).toBeVisible();
      await page.locator('#wikiSeriesMenu [data-series-form="label"] [data-series-input]').fill(name);
      await page.locator('#wikiSeriesMenu [data-series-form="label"] button[type="submit"]').click();
      await expect(menu(page)).toHaveCount(0);
      await expect
        .poll(async () => (await fence(root, HEAD)).find((l) => l.startsWith("series_label:")))
        .toBe(`series_label: ${name}`);
    }
    await expect(page.locator(".wiki-series-head .wiki-series-name")).toHaveText("Second rename");
  });

  test("a click that beats the base fetch waits for it instead of writing blind", async ({
    page,
  }) => {
    await openRail(page);
    // The base read, slowed to something a human click beats every time. Matched
    // by PATHNAME: `/api/wiki/pages` is a different route and this menu's own
    // refresh needs it.
    await page.route(
      (url) => url.pathname === "/api/wiki/page",
      async (route) => {
        await new Promise((r) => setTimeout(r, 1200));
        await route.continue();
      },
    );
    await openRowMenu(page, JOINER);
    await page.locator(`#wikiSeriesMenu [data-series-cmd="join"][data-series-arg="${KEY}"]`).click();
    // The write goes out under the base that arrives late, rather than being
    // refused as a page the menu could not read.
    await expect
      .poll(async () => (await fence(root, JOINER)).some((l) => l.startsWith("series:")))
      .toBe(true);
    await expect(page.locator("#wikiSeriesMenu .wiki-series-menu-msg.bad")).toHaveCount(0);
  });

  test("after a 409 the next click sends nothing and says to reopen", async ({ page }) => {
    let posts = 0;
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/api/wiki/series")) posts++;
    });
    await openRail(page);
    await openRowMenu(page, JOINER);
    const edited = (await read(root, JOINER)).replace("Body.", "Body, rewritten elsewhere.");
    await writeFile(path.join(root, JOINER), edited, "utf8");
    await page.locator(`#wikiSeriesMenu [data-series-cmd="join"][data-series-arg="${KEY}"]`).click();
    await expect(page.locator("#wikiSeriesMenu .wiki-series-menu-msg.bad")).toContainText(JOINER);
    expect(posts).toBe(1);

    // A second verb from the same popover: the bases it holds are the ones the
    // 409 just disproved, so the click is refused HERE and the reader is told
    // what to do, rather than spending a round trip on a second 409 that reads
    // as somebody else's edit.
    await page.locator('#wikiSeriesMenu [data-series-form="new"] [data-series-input]').fill("recall");
    await page.locator('#wikiSeriesMenu [data-series-form="new"] button[type="submit"]').click();
    await expect(page.locator("#wikiSeriesMenu .wiki-series-menu-msg.bad")).toHaveText(
      "Close and reopen this menu — the page has changed",
    );
    expect(posts).toBe(1);
    expect(await read(root, JOINER)).toBe(edited);
  });

  test("a write's outcome lands in ITS menu, not in whichever is open when it answers", async ({
    page,
  }) => {
    // A write is a sequence of awaits, and the reader can close the popover and
    // open another on a different page while one is in flight. Driven as a
    // failure, because a refusal painted into the wrong menu reports a page it
    // is not about.
    await page.route("**/api/wiki/series", async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "refused, for the page this menu is not about" }),
      });
    });
    await openRail(page);
    await openRowMenu(page, JOINER);
    await page.locator(`#wikiSeriesMenu [data-series-cmd="join"][data-series-arg="${KEY}"]`).click();
    // Close it and open another BEFORE the refusal comes back.
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    await openRowMenu(page, OUTSIDER);
    // The failed write's own tail refetches the listing, and it does that AFTER
    // it has painted its note — so this response is the moment to look.
    await page.waitForResponse((r) => r.url().includes("/api/wiki/pages") && r.url().includes("refresh=1"));
    await expect(menu(page)).toBeVisible();
    await expect(page.locator("#wikiSeriesMenu .wiki-series-menu-msg")).toHaveCount(0);
  });

  test("a write that LANDS closes its own menu, not the one open when it answers", async ({
    page,
  }) => {
    // The success twin of the case above. The refusal path keys its note to
    // the menu that sent the write; the success path closes "the menu", and
    // with another popover open by then that is the wrong one — and the menu
    // the reader is looking at vanishes under their pointer.
    await page.route("**/api/wiki/series", async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.continue();
    });
    await openRail(page);
    await openSeriesFold(page);
    await openRowMenu(page, JOINER);
    await page.locator(`#wikiSeriesMenu [data-series-cmd="join"][data-series-arg="${KEY}"]`).click();
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    await openRowMenu(page, OUTSIDER);
    // The write lands and its tail repaints the rail — the joiner's row moves
    // into the fold. The close, if it happens, happens in that same tail, so
    // a menu still standing AFTER the repaint is one the tail left alone.
    await expect
      .poll(async () => (await fence(root, JOINER)).join("|"))
      .toContain(`series: ${KEY}`);
    await expect(row(page, JOINER)).toHaveClass(/member/);
    await expect(menu(page)).toBeVisible();
    await expect(page.locator("#wikiSeriesMenu .wiki-series-menu-msg")).toHaveCount(0);
    // And it is the OUTSIDER's menu, live: a verb from it writes THAT page.
    await page.locator(`#wikiSeriesMenu [data-series-cmd="join"][data-series-arg="${KEY}"]`).click();
    await expect(menu(page)).toHaveCount(0);
    await expect
      .poll(async () => (await fence(root, OUTSIDER)).join("|"))
      .toContain(`series: ${KEY}`);
  });

  test("a write the route reports as a noop leaves the menu usable", async ({ page }) => {
    // The key typed into the field is the one the page already carries. The
    // route answers 200 with `written: false` and the same hash; the listing
    // cannot have moved. Nothing to report, and nothing the held bases no
    // longer describe — so the next verb must go out, not be refused as a
    // write over bases this menu's own (non-)write moved on from.
    await openRail(page);
    await openSeriesFold(page);
    const before = await read(root, HEAD);
    await openRowMenu(page, HEAD);
    await page.locator('#wikiSeriesMenu [data-series-form="new"] [data-series-input]').fill(KEY);
    await page.locator('#wikiSeriesMenu [data-series-form="new"] button[type="submit"]').click();
    await expect(menu(page)).toHaveCount(0);
    expect(await read(root, HEAD)).toBe(before);

    // Usable: the same menu, reopened, moves the page with no reopen-note.
    await openRowMenu(page, HEAD);
    await page.locator('#wikiSeriesMenu [data-series-form="new"] [data-series-input]').fill("recall");
    await page.locator('#wikiSeriesMenu [data-series-form="new"] button[type="submit"]').click();
    await expect(page.locator("#wikiSeriesMenu .wiki-series-menu-msg.bad")).toHaveCount(0);
    await expect.poll(async () => (await fence(root, HEAD)).join("|")).toContain("series: recall");
  });
});

/**
 * The openers — fix round 1, finding B.
 *
 * Every assertion here is one a `force: true` click or a unit test cannot make:
 * whether the control is REACHABLE by a real pointer, and whether it is painted
 * on rows where it is not.
 */
test.describe("the ⋯ openers", () => {
  test("a Related-work row's ⋯ opens the menu instead of navigating", async ({ page }) => {
    // Measured before the cascade fix: the reveal restored `pointer-events`
    // only under `.wiki-list-item:hover`, which a `.wiki-conn-related` row is
    // not — so the click fell through to the row and opened the page.
    await openPage(page, HEAD, "Wiki provenance plan");
    const related = page.locator(".wiki-conn-related").first();
    await expect(related).toBeAttached();
    const url = page.url();
    // Hover the ROW, then an ordinary click on its opener: with the reveal keyed
    // on a selector this row does not match, the button stays
    // `pointer-events: none` however long the pointer sits on it, and the click
    // lands on the row — which navigates.
    await related.hover();
    await related.locator("[data-series-menu]").click();
    await expect(menu(page)).toBeVisible();
    expect(page.url()).toBe(url);
  });

  test("a rail row's ⋯ is invisible until its OWN row is hovered, and then clickable", async ({
    page,
  }) => {
    await openRail(page);
    const opener = row(page, JOINER).locator("[data-series-menu]");
    const other = row(page, OUTSIDER).locator("[data-series-menu]");
    const opacity = (l: typeof opener) =>
      l.evaluate((el) => getComputedStyle(el as HTMLElement).opacity);
    // Unhovered it is exactly as invisible as the ★ beside it.
    expect(await opacity(opener)).toBe("0");
    await row(page, JOINER).hover();
    // Polled: the reveal is a 0.12s transition, so the frame the hover landed
    // in is not the state being asserted.
    await expect.poll(() => opacity(opener)).toBe("1");
    // …and hovering ONE row reveals ONE row's opener.
    expect(await opacity(other)).toBe("0");
    // No `force`: this is the hit test the cascade broke.
    await opener.click();
    await expect(menu(page)).toBeVisible();
  });

  test("the ⋯ costs the row no width at all", async ({ page }) => {
    // The rail's rows are budgeted item by item (`wiki-rail-width.ts`), and an
    // in-flow seventh item took `.wiki-list-end` to 90px and wrapped a plan
    // row's title under its floor on CI's fonts. Measured by DELETING the
    // button: a slot whose width does not move is a slot the button was never
    // taking space in — which a before/after HOVER cannot tell, since an
    // always-painted opener measures the same in both.
    await openRail(page);
    const slot = row(page, JOINER).locator(".wiki-list-end");
    const { before, after } = await slot.evaluate((el) => {
      const width = () => el.getBoundingClientRect().width;
      const b = width();
      el.querySelector(".wiki-series-menu-btn")!.remove();
      return { before: b, after: width() };
    });
    expect(before).toBeGreaterThan(0);
    expect(after).toBe(before);
  });

  test("no opener on a page no series can claim", async ({ page }) => {
    await openRail(page);
    // A standalone `.html` explainer is an ordinary row; the wiki's own
    // bookkeeping pages sit under the collapsed `Bookkeeping` header, so the
    // absence below is asserted on a row that is really on screen rather than
    // on one the fold is hiding.
    await expect(row(page, ATTACHMENT)).toBeAttached();
    await expect(row(page, ATTACHMENT).locator("[data-series-menu]")).toHaveCount(0);
    await page.locator('.wiki-sec-fold[data-fold-key="section:meta"]').click();
    await expect(row(page, META)).toBeAttached();
    await expect(row(page, META).locator("[data-series-menu]")).toHaveCount(0);
    // The ordinary rows still have theirs.
    await expect(row(page, JOINER).locator("[data-series-menu]")).toHaveCount(1);
  });
});

/**
 * The popover's own behaviour — fix round 1, finding C.
 */
test.describe("the popover", () => {
  test("scrolling INSIDE it does not dismiss it, and the cap says what it left out", async ({
    page,
  }) => {
    // The dismiss-on-scroll listener is capture-phase, so the menu's own
    // `overflow-y: auto` list dismissed it on the first wheel tick and the
    // `max-height: 70vh` was unreachable. A short viewport is what makes 70vh a
    // real cap for a menu this size.
    await page.setViewportSize({ width: 1200, height: 400 });
    await openRail(page, BASE, MANY_WIKI);
    await openRowMenu(page, MANY_FREE);
    const el = menu(page);
    // The cap is 12 of the 16 this wiki holds, and the field is how the other
    // four are reached — so the menu says so.
    await expect(el.locator('[data-series-cmd="join"]')).toHaveCount(12);
    await expect(el.locator(".wiki-series-menu-note.is-more")).toHaveText(
      "… 4 more — type the key",
    );
    expect(await el.evaluate((n) => n.scrollHeight > n.clientHeight)).toBe(true);

    await el.hover();
    await page.mouse.wheel(0, 200);
    // The wheel lands asynchronously — polled, so the assertion is about where
    // the menu ENDED UP rather than about the frame it was read in.
    await expect.poll(async () => el.evaluate((n) => n.scrollTop)).toBeGreaterThan(0);
    await expect(el).toBeVisible();
  });

  test("a refetch that does not move the listing is reported, not called success", async ({
    page,
  }) => {
    // `receivePages` has five outcomes and only one of them is "the screen now
    // shows the write": a superseded response, a degraded empty set and a
    // byte-identical payload all leave the rail showing the listing from before
    // the click. Driven here as the byte-identical case — the server's own
    // pre-write answer, replayed.
    await openRail(page);
    const stale = await (await page.request.get(`${BASE}/api/wiki/pages?wiki=${WIKI}`)).text();
    await page.route("**/api/wiki/pages*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: stale }),
    );
    await openRowMenu(page, JOINER);
    await page.locator(`#wikiSeriesMenu [data-series-cmd="join"][data-series-arg="${KEY}"]`).click();
    // The write landed…
    await expect
      .poll(async () => (await fence(root, JOINER)).some((l) => l.startsWith("series:")))
      .toBe(true);
    // …and the reader is told the list did not, instead of the menu closing on a
    // rail that still shows the row outside the fold.
    const msg = page.locator("#wikiSeriesMenu .wiki-series-menu-msg");
    await expect(msg).toHaveText("Saved — reload to see the updated list");
  });

  test("closing returns focus to the control that opened it", async ({ page }) => {
    await openRail(page);
    await openRowMenu(page, JOINER);
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute("data-series-menu")),
    ).toBe(JOINER);
  });
});

/** Both themes, measured against whatever actually paints behind the text —
 *  the three sibling rail specs' rule, and the popover is the one surface in
 *  this feature a reader has to READ. */
for (const scheme of ["light", "dark"] as const) {
  test(`the popover is legible in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openRail(page);
    // Opened on a MEMBER, so the inert "in this series" row is painted too —
    // and a member's row is inside the fold, which starts closed.
    await openSeriesFold(page);
    await openRowMenu(page, HEAD);
    expect(await contrastOf(menu(page).locator(".wiki-series-menu-sec").first())).toBeGreaterThanOrEqual(4.5);
    expect(await contrastOf(menu(page).locator(".wiki-series-menu-note").first())).toBeGreaterThanOrEqual(4.5);
    expect(
      await contrastOf(menu(page).locator(".wiki-series-menu-row.is-current")),
    ).toBeGreaterThanOrEqual(4.5);

    // The refusal is the one line the reader MUST be able to read, so it is
    // measured in the state it really appears in — after a write the CAS
    // refused.
    await page.keyboard.press("Escape");
    await openRowMenu(page, JOINER);
    await writeFile(
      path.join(root, JOINER),
      (await read(root, JOINER)).replace("Body.", "Moved on."),
      "utf8",
    );
    await page.locator(`#wikiSeriesMenu [data-series-cmd="join"][data-series-arg="${KEY}"]`).click();
    const bad = menu(page).locator(".wiki-series-menu-msg.bad");
    await expect(bad).toBeVisible();
    expect(await contrastOf(bad)).toBeGreaterThanOrEqual(4.5);
  });
}
