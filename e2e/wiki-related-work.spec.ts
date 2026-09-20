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

const PORT = e2ePort("wiki-related-work");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-related";

const OPEN = "plans/a.mdx";

/**
 * `RELATED_HUB_BACKLINKS` and `RELATED_DIGEST_PRS` (`src/wiki/related.ts`),
 * re-typed rather than imported: that module reaches `store.ts` →
 * `registry.ts`, whose `import.meta.dir` is `undefined` under Playwright's node
 * loader, and the import alone made this whole file unloadable (measured — "No
 * tests found"). `related.test.ts` drives both by their real exported names; here
 * they are fixture SIZES, and a drift shows up as this spec's own red.
 */
const HUB_BACKLINKS = 25;
const DIGEST_PRS = 15;

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
 *  - `unrelated` — in none of it.
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
        { length: DIGEST_PRS - 1 },
        (_, i) => `huginn#${i + 1}`,
      ).join(", ")}.`,
    ),
  ],
  ["plans/unrelated.mdx", md("Unrelated plan", ["status_date: 2026-09-13"], "Nothing at all.")],
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
  for (let i = 1; i <= HUB_BACKLINKS + 1; i++) {
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

for (const scheme of ["light", "dark"] as const) {
  test(`the why line clears 4.5:1 in the ${scheme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openReader(page);
    // The `em` carries the reasons; the container carries only the separators.
    const reason = relatedRows(page).nth(1).locator(".wiki-conn-why em").first();
    await expect(reason).toBeVisible();
    expect(await contrastOf(reason)).toBeGreaterThanOrEqual(4.5);
  });
}
