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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { contrastOf } from "./contrast.ts";
/**
 * The REAL constants, imported rather than re-typed. `src/wiki/related.ts`
 * itself is unloadable here — it reaches `registry.ts`, whose `import.meta.dir`
 * is `undefined` under Playwright's node loader, and the import alone made this
 * whole file report "No tests found" — but `related-constants.ts` imports
 * nothing, so it loads. Re-typed numbers only caught a threshold moving UP:
 * 25 → 10 and 15 → 5 both left this fixture passing.
 */
import { RELATED_DIGEST_PRS, RELATED_HUB_BACKLINKS } from "../src/wiki/related-constants.ts";

const PORT = e2ePort("wiki-related-work");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-related";

const OPEN = "plans/a.mdx";


/** Two PR refs the open page carries — one authored in `prs:`, one only in its
 *  prose, as a pull URL. Both have to reach `prRefs` for `c` to pair. */
const REF_AUTHORED = "RuneLind/muninn#549";
const REF_BODY = "RuneLind/muninn#550";

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
 *
 * Every page carries a `status_date`, which is what the block orders by on a
 * temp wiki with no git history.
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
      "Reads [[a]] and https://github.com/RuneLind/muninn/pull/550.",
    ),
  ],
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
];

/** The rows the block must hold, newest first, with their why lines. */
const EXPECTED: Array<[string, string]> = [
  ["Citing plan", "cites this page"],
  ["Sharing blog", `cites this page · shares ${REF_AUTHORED}, ${REF_BODY}`],
  ["Downstream plan", "cited by this page"],
];

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-related-"));
  for (const [rel, body] of PAGES) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
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

test("the block leads the Connections panel, newest first, with one why line per row", async ({
  page,
}) => {
  await openReader(page);

  // FIRST section in the panel — before `Linked from` and `Links to`, which are
  // the raw lists it is derived from.
  const titles = page.locator("#connBody .wiki-conn-title");
  await expect(titles.first()).toHaveText(`Related work (${EXPECTED.length})`);
  await expect(titles.nth(1)).toContainText("Linked from");

  await expect(relatedRows(page)).toHaveCount(EXPECTED.length);
  for (const [i, [title, why]] of EXPECTED.entries()) {
    const row = relatedRows(page).nth(i);
    await expect(row.locator("> .wiki-conn-text > span")).toHaveText(title);
    await expect(row.locator(".wiki-conn-why")).toHaveText(why);
  }
});

test("a row opens its page — the panel's own delegated handler, no second click path", async ({
  page,
}) => {
  await openReader(page);
  await relatedRows(page).first().click();
  await expect(page.locator(".wiki-article-head h1")).toHaveText("Citing plan");
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
  const why = relatedRows(page).nth(1).locator(".wiki-conn-why");
  await expect(why).toHaveText(EXPECTED[1]![1]);

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
  // …and it WRAPS rather than growing without bound: the row stays compact.
  expect(fit.lines).toBeGreaterThan(1);
  expect(fit.lines).toBeLessThanOrEqual(2);
});

for (const scheme of ["light", "dark"] as const) {
  test(`the why line clears 4.5:1 in the ${scheme} theme, at rest and hovered`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openReader(page);
    // The `em` carries the reasons; the container carries only the separators.
    const row = relatedRows(page).nth(1);
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
