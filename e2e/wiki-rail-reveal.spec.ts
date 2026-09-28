/**
 * The rail follows the open page: every navigation scrolls `#wikiList` to the
 * open page's row, and ⌖ Show in list gives a filtered-out page its row back.
 *
 * Only a browser can answer these: "on screen" is a question about layout.
 * Not covered: the reveal waiting for a late listing, which happens only when
 * the boot listing fails and a later refetch heals it.
 *
 * One temp wiki of 80 pages (so the rail scrolls) plus a hub that links to all
 * of them, a retired page, and two pages under a declared project rule. The two
 * scroll cases read their target off the rail's bottom row rather than assuming
 * the sort order puts a given page there. No model calls, no DB rows; `e2eEnv()`
 * blanks the platform tokens and instance-profile flags, as in every spawned
 * muninn.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-rail-reveal");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-rail-reveal";
const COUNT = 80;
const pad = (n: number) => String(n).padStart(2, "0");
const HUB_REL = "hub.md";
/** The page carrying the `keep` tag, for the filter case. */
const TAGGED_REL = `notes/page-${pad(COUNT)}.md`;
/** Retired (`signal: none`), so the rail holds it back until Show retired. */
const RETIRED_REL = "notes/gone.md";
/** Project `even` by its `areas/` folder; `areas/odd/o1.md` is the other project. */
const PROJECT_REL = "areas/even/e1.md";

let server: ChildProcess | undefined;
let root = "";

const openRel = (page: Page, rel: string) => page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);

/** The relPath of the rail's last page row, and its title. */
const bottomRow = async (page: Page) => {
  const last = page.locator('#wikiList .wiki-list-item[data-section="all"]').last();
  return { rel: (await last.getAttribute("data-relpath"))!, title: (await last.locator(".wiki-list-title").innerText()).trim() };
};

/** Is some row for the open page wholly inside the rail's scroll box? */
const activeRowOnScreen = (page: Page) =>
  page.evaluate(() => {
    const list = document.getElementById("wikiList")!;
    const box = list.getBoundingClientRect();
    return Array.from(list.querySelectorAll(".wiki-list-item.active")).some((r) => {
      const b = r.getBoundingClientRect();
      return b.height > 0 && b.top >= box.top && b.bottom <= box.bottom;
    });
  });

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-rail-reveal-"));
  await mkdir(path.join(root, "notes"), { recursive: true });
  for (let i = 1; i <= COUNT; i++) {
    // Page 01 newest, page 80 oldest: one day apart, all in the past.
    const day = new Date(Date.UTC(2026, 0, 1) - i * 86_400_000).toISOString().slice(0, 10);
    const tags = i === COUNT ? "tags: [keep]\n" : "";
    await writeFile(
      path.join(root, `notes/page-${pad(i)}.md`),
      `---\ntitle: Page ${pad(i)}\ncreated: ${day}\nupdated: ${day}\n${tags}---\n\n# Page ${pad(i)}\n\nBody ${i}.\n`,
      "utf8",
    );
  }
  await writeFile(
    path.join(root, HUB_REL),
    `---\ntitle: Hub\ncreated: 2026-01-02\nupdated: 2026-01-02\n---\n\n# Hub\n\n` +
      Array.from({ length: COUNT }, (_, i) => `- [[page-${pad(i + 1)}|Page ${pad(i + 1)}]]\n`).join(""),
    "utf8",
  );

  await writeFile(
    path.join(root, RETIRED_REL),
    "---\ntitle: Gone page\nsignal: none\nsignal-reason: Superseded\n---\n\n# Gone page\n\nRetired body.\n",
    "utf8",
  );
  await writeFile(
    path.join(root, ".wiki-reader.json"),
    JSON.stringify({ project: { pathFolders: ["areas"], frontmatter: [], tagFallback: false, aliases: {} } }),
    "utf8",
  );
  for (const [rel, title] of [[PROJECT_REL, "Even one"], ["areas/odd/o1.md", "Odd one"]] as const) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), `---\ntitle: ${title}\ntags: [keep]\n---\n\n# ${title}\n\n${title} body.\n`, "utf8");
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

test.describe("Wiki rail: follow the open page", () => {
  test("a deep link scrolls the rail to the page's row", async ({ page }) => {
    await openRel(page, HUB_REL);
    await expect(page.locator(".wiki-list-item.active")).not.toHaveCount(0);
    const { rel } = await bottomRow(page);
    await openRel(page, rel);
    await expect(page.locator(`.wiki-list-item.active[data-relpath="${rel}"]`)).not.toHaveCount(0);
    await expect.poll(() => activeRowOnScreen(page)).toBe(true);
    // The row sits at the bottom of the listing, so getting there took a scroll.
    expect(await page.locator("#wikiList").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });

  test("a wikilink in the article scrolls the rail to the new page", async ({ page }) => {
    await openRel(page, HUB_REL);
    await expect(page.locator(".wiki-list-item.active")).not.toHaveCount(0);
    const { rel, title } = await bottomRow(page);
    await page.locator("#wikiList").evaluate((el) => (el.scrollTop = 0));
    // Precondition: the target's row starts below the fold, so reaching it
    // takes a scroll.
    const box = await page.locator("#wikiList").boundingBox();
    const target = await page.locator(`#wikiList .wiki-list-item[data-relpath="${rel}"]`).last().boundingBox();
    expect(target!.y).toBeGreaterThan(box!.y + box!.height);
    await page.locator(".wiki-article a", { hasText: new RegExp(`^${title}$`) }).click();
    await expect(page.locator(`.wiki-list-item.active[data-relpath="${rel}"]`)).not.toHaveCount(0);
    await expect.poll(() => activeRowOnScreen(page)).toBe(true);
  });

  test("clicking a visible row does not move the rail", async ({ page }) => {
    await openRel(page, HUB_REL);
    await expect(page.locator(".wiki-list-item.active")).not.toHaveCount(0);
    const list = page.locator("#wikiList");
    await list.evaluate((el) => (el.scrollTop = 200));
    const before = await list.evaluate((el) => el.scrollTop);
    // The first row wholly inside the box after the scroll.
    const rel = await page.evaluate(() => {
      const l = document.getElementById("wikiList")!;
      const box = l.getBoundingClientRect();
      const r = Array.from(l.querySelectorAll<HTMLElement>(".wiki-list-item")).find((x) => {
        const b = x.getBoundingClientRect();
        return b.top >= box.top + 20 && b.bottom <= box.bottom;
      });
      return r?.getAttribute("data-relpath") ?? "";
    });
    expect(rel).not.toBe("");
    await page.locator(`.wiki-list-item[data-relpath="${rel}"] .wiki-list-title`).click();
    await expect(page.locator(`.wiki-list-item.active[data-relpath="${rel}"]`).first()).toBeVisible();
    expect(await list.evaluate((el) => el.scrollTop)).toBe(before);
  });

  test("⌖ Show in list clears only the filters that hide the page", async ({ page }) => {
    await openRel(page, TAGGED_REL);
    await expect(page.locator(".wiki-article")).toContainText("Body 80.");
    // A tag the page carries (kept) and a query it does not match (cleared).
    await page.locator("#wikiFilters summary").click();
    await page.locator('#tagChips .wiki-chip[data-tag="keep"]').click();
    await page.locator("#wikiSearch").fill("hub");
    await expect(page.locator(".wiki-list-item.active")).toHaveCount(0);

    await page.locator("#wikiLocateBtn").click();
    await expect(page.locator("#wikiSearch")).toHaveValue("");
    await expect(page.locator('#tagChips .wiki-chip[data-tag="keep"]')).toHaveClass(/\bactive\b/);
    await expect(page.locator(".wiki-list-item.active.reveal-flash")).toHaveCount(1);
    await expect.poll(() => activeRowOnScreen(page)).toBe(true);
  });

  test("⌖ on a retired page turns Show retired on", async ({ page }) => {
    await openRel(page, RETIRED_REL);
    await expect(page.locator(".wiki-article")).toContainText("Retired body.");
    await expect(page.locator(".wiki-list-item.active")).toHaveCount(0);
    await page.locator("#wikiLocateBtn").click();
    await expect(page.locator("#wikiShowRetired")).toBeChecked();
    await expect(page.locator(".wiki-list-item.active")).not.toHaveCount(0);
    await expect.poll(() => activeRowOnScreen(page)).toBe(true);
  });

  test("⌖ leaves focus mode, which hides the rail", async ({ page }) => {
    await openRel(page, TAGGED_REL);
    await expect(page.locator(".wiki-article")).toContainText("Body 80.");
    await page.locator(".wiki-article").click();
    await page.keyboard.press("f");
    await expect(page.locator(".wiki-layout")).toHaveClass(/\bfocus-mode\b/);
    await page.locator("#wikiLocateBtn").click();
    await expect(page.locator(".wiki-layout")).not.toHaveClass(/\bfocus-mode\b/);
    await expect.poll(() => activeRowOnScreen(page)).toBe(true);
  });

  test("⌖ drops a ?project= that hides the page and keeps the tag it matches", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(PROJECT_REL)}&project=odd`);
    await expect(page.locator(".wiki-article")).toContainText("Even one body.");
    // An active project filter auto-opens the disclosure, so a summary click would close it.
    await page.locator("#wikiFilters").evaluate((d) => ((d as HTMLDetailsElement).open = true));
    await page.locator('#tagChips .wiki-chip[data-tag="keep"]').click();
    await expect(page.locator("#wikiFilterCount")).toHaveText("2");
    await expect(page.locator(".wiki-list-item.active")).toHaveCount(0);

    await page.locator("#wikiLocateBtn").click();
    await expect.poll(() => new URL(page.url()).searchParams.has("project")).toBe(false);
    await expect(page.locator('#projectChips .wiki-chip[data-project=""]')).toHaveClass(/\bactive\b/);
    await expect(page.locator('#tagChips .wiki-chip[data-tag="keep"]')).toHaveClass(/\bactive\b/);
    await expect(page.locator("#wikiFilterCount")).toHaveText("1");
    await expect.poll(() => activeRowOnScreen(page)).toBe(true);
  });
});
