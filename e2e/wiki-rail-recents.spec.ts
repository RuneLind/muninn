/**
 * Recently opened · Pinned · the Jira-key jump, in the /wiki reader's page rail.
 *
 * What the unit tests cannot reach, and the reason this file exists:
 *
 *  1. **The chain that records a recent.** `pushRecent` is a pure list splice;
 *     whether the reader ever calls it depends on a page load resolving a
 *     relPath, `recordRecent` reaching localStorage, and `renderList` repainting
 *     afterwards. Every unit test in that chain is green with the chain broken,
 *     and the symptom is a section that never appears.
 *  2. **It survives a reload.** That is the whole promise of "recently opened" —
 *     a section that only lives until the tab closes is not a recall aid.
 *  3. **The key is per WIKI.** Both wikis here are temp directories registered
 *     through `WIKI_EXTRA` in ONE process; a globally-keyed store would leak the
 *     first wiki's recents into the second and every single-root assertion above
 *     would still pass.
 *  4. **The ★ must not navigate.** The pin sits inside `.wiki-list-item`, which
 *     the body-level nav delegate opens on any click. Only the ordering of the
 *     two listeners plus `stopPropagation` keeps them apart, and that ordering
 *     is invisible from either module on its own.
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
import { RECENTS_KEY_PREFIX, PINS_KEY_PREFIX } from "../src/dashboard/views/components/wiki-recents.ts";

const PORT = e2ePort("wiki-rail-recents");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-rail";
const OTHER_WIKI = "e2e-rail-other";

function md(title: string, tags: string[] = [], body = "Body."): string {
  return ["---", `title: ${title}`, tags.length ? `tags: [${tags.join(", ")}]` : "", "---", "", body, ""]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * The fixture is the melosys shape in miniature: an issue page ADDRESSED by its
 * key, an archive page whose TITLE opens with the key (a reference, not an issue
 * page — the distinction the unit enumeration forced), one that carries the key
 * only as a tag, and two pages with no connection to it at all.
 */
const PAGES: Array<[string, string]> = [
  ["sources/jira/MELOSYS-7588.md", md("Utvid Trygdeavgiftsperiode med grunnlag", ["jira"])],
  ["archive/opprydding.md", md("MELOSYS-7588 — Opprydding av avrunding", ["rounding"])],
  ["flows/datamodel.md", md("Trygdeavgift datamodel", ["melosys-7588", "datamodel"])],
  ["concepts/arsavregning.md", md("Årsavregning", ["avregning"])],
  ["concepts/kildeskatt.md", md("Kildeskatt", ["skatt"])],
];
const ISSUE = "sources/jira/MELOSYS-7588.md";
const ARCHIVE = "archive/opprydding.md";
const DATAMODEL = "flows/datamodel.md";
const ARSAVREGNING = "concepts/arsavregning.md";
const KILDESKATT = "concepts/kildeskatt.md";

const OTHER_REL = "only-here.md";

let server: ChildProcess | undefined;
let root = "";
let otherRoot = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-rail-"));
  otherRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-rail-other-"));
  for (const [rel, body] of PAGES) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
  await writeFile(path.join(otherRoot, OTHER_REL), md("Only Here"), "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root},${OTHER_WIKI}=${otherRoot}`,
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
  if (otherRoot) await rm(otherRoot, { recursive: true, force: true });
});

type Page = import("@playwright/test").Page;

/**
 * Land on a wiki. Every test gets a fresh BrowserContext, so localStorage starts
 * empty without any clearing of our own — which matters: an `addInitScript` that
 * cleared the keys on every `goto` also cleared them on the reload, and the
 * "survives a reload" case then asserted a state it could not fail to see.
 */
async function openRail(page: Page, wiki = WIKI): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${wiki}`);
  await expect(page.locator(".wiki-list-item").first()).toBeVisible();
}

/** A second visit, in the same context — the store is whatever the first left. */
const reloadKeepingStore = openRail;

/** The section headers' LABELS — `.wiki-sec-label`, not the header element, so
 *  the `clear` button's own text does not ride along. */
const sectionLabels = (page: Page) => page.locator(".wiki-sec-label").allTextContents();

/** The rows under one section header, by relPath, in render order. */
function rowsIn(page: Page, section: string) {
  return page.locator(`.wiki-list-item[data-sec="${section}"]`);
}

async function relPathsIn(page: Page, section: string): Promise<string[]> {
  return rowsIn(page, section).evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-relpath") || ""),
  );
}

test.describe("Wiki rail: recents, pins, key jump", () => {
  test("a fresh browser gets the rail it has always had — no headers", async ({ page }) => {
    await openRail(page);
    expect(await sectionLabels(page)).toEqual([]);
    expect(await page.locator(".wiki-list-item").count()).toBe(PAGES.length);
    // The ★ is on every row, and invisible until the row is hovered.
    expect(await page.locator(".wiki-pin").count()).toBe(PAGES.length);
    await expect(page.locator(".wiki-pin").first()).toHaveCSS("opacity", "0");
  });

  test("opening a page records it, and the record survives a reload", async ({ page }) => {
    await openRail(page);
    await page.locator(`.wiki-list-item[data-relpath="${ARSAVREGNING}"]`).click();
    await expect(page.locator(".wiki-article")).toContainText("Body.");

    expect(await sectionLabels(page)).toEqual(["Recently opened", "All pages"]);
    expect(await relPathsIn(page, "recent")).toEqual([ARSAVREGNING]);

    // The listing below is still COMPLETE — the section is a shortcut, not a filter.
    expect(await relPathsIn(page, "all")).toHaveLength(PAGES.length);
    await expect(page.locator("#wikiCount")).toHaveText(`${PAGES.length} / ${PAGES.length}`);

    // …and it is there on the next visit, which is the whole promise.
    await reloadKeepingStore(page);
    expect(await relPathsIn(page, "recent")).toEqual([ARSAVREGNING]);
  });

  test("the most recently opened page comes first, without duplicating", async ({ page }) => {
    await openRail(page);
    for (const rel of [ARSAVREGNING, KILDESKATT, ARSAVREGNING]) {
      await page.locator(`.wiki-list-item[data-relpath="${rel}"][data-sec="all"]`).click();
      await expect(page.locator(".wiki-article")).toBeVisible();
    }
    expect(await relPathsIn(page, "recent")).toEqual([ARSAVREGNING, KILDESKATT]);
  });

  test("clear empties the section and the store", async ({ page }) => {
    await openRail(page);
    await page.locator(`.wiki-list-item[data-relpath="${ARSAVREGNING}"]`).click();
    await expect(rowsIn(page, "recent")).toHaveCount(1);

    await page.locator(".wiki-sec-clear").click();
    expect(await sectionLabels(page)).toEqual([]);
    // Cleared in storage, not just on screen.
    await reloadKeepingStore(page);
    expect(await sectionLabels(page)).toEqual([]);
  });

  test("★ pins a page WITHOUT opening it", async ({ page }) => {
    await openRail(page);
    // Nothing is open: the start view is showing, and it must still be showing
    // after the click. This is the half the two listeners' ordering decides.
    await expect(page.locator(".wiki-start")).toBeVisible();

    const row = page.locator(`.wiki-list-item[data-relpath="${KILDESKATT}"]`);
    await row.hover();
    await row.locator(".wiki-pin").click();

    await expect(page.locator(".wiki-start")).toBeVisible();
    expect(await sectionLabels(page)).toEqual(["Pinned", "All pages"]);
    expect(await relPathsIn(page, "pinned")).toEqual([KILDESKATT]);
    // A pinned row's ★ is visible with no hover, and says what it will do.
    const pinned = page.locator(`.wiki-list-item[data-sec="pinned"] .wiki-pin`);
    await expect(pinned).toHaveCSS("opacity", "1");
    await expect(pinned).toHaveAttribute("aria-pressed", "true");

    await reloadKeepingStore(page);
    expect(await relPathsIn(page, "pinned")).toEqual([KILDESKATT]);
  });

  test("★ again un-pins", async ({ page }) => {
    await openRail(page);
    const row = page.locator(`.wiki-list-item[data-relpath="${KILDESKATT}"]`);
    await row.hover();
    await row.locator(".wiki-pin").click();
    await expect(rowsIn(page, "pinned")).toHaveCount(1);

    await page.locator(`.wiki-list-item[data-sec="pinned"] .wiki-pin`).click();
    expect(await sectionLabels(page)).toEqual([]);
  });

  test("a pinned page is not repeated under Recently opened", async ({ page }) => {
    await openRail(page);
    await page.locator(`.wiki-list-item[data-relpath="${ARSAVREGNING}"]`).click();
    await expect(rowsIn(page, "recent")).toHaveCount(1);

    const row = page.locator(`.wiki-list-item[data-relpath="${ARSAVREGNING}"][data-sec="recent"]`);
    await row.hover();
    await row.locator(".wiki-pin").click();

    expect(await sectionLabels(page)).toEqual(["Pinned", "All pages"]);
    expect(await relPathsIn(page, "pinned")).toEqual([ARSAVREGNING]);
    expect(await rowsIn(page, "recent").count()).toBe(0);

    // …and un-pinning gives it back to the recents section.
    await page.locator(`.wiki-list-item[data-sec="pinned"] .wiki-pin`).click();
    expect(await relPathsIn(page, "recent")).toEqual([ARSAVREGNING]);
  });

  test("the sections vanish while a search or a filter is active", async ({ page }) => {
    await openRail(page);
    await page.locator(`.wiki-list-item[data-relpath="${ARSAVREGNING}"]`).click();
    await expect(rowsIn(page, "recent")).toHaveCount(1);

    await page.fill("#wikiSearch", "kilde");
    expect(await sectionLabels(page)).toEqual([]);

    await page.fill("#wikiSearch", "");
    await expect(rowsIn(page, "recent")).toHaveCount(1);

    // A facet hides them too — the rail is no longer showing the whole wiki.
    await page.locator('#domainChips .wiki-chip[data-domain="ai"]').click();
    expect(await sectionLabels(page)).toEqual([]);
  });

  test("the store is per wiki — one wiki's recents never show on another", async ({ page }) => {
    await openRail(page);
    await page.locator(`.wiki-list-item[data-relpath="${ARSAVREGNING}"]`).click();
    await expect(rowsIn(page, "recent")).toHaveCount(1);

    await reloadKeepingStore(page, OTHER_WIKI);
    expect(await sectionLabels(page)).toEqual([]);

    // Both keys really are present, under two different names.
    const keys = await page.evaluate(
      ([r, p]: [string, string]) =>
        Object.keys(localStorage).filter((k) => k.startsWith(r) || k.startsWith(p)).sort(),
      [RECENTS_KEY_PREFIX, PINS_KEY_PREFIX] as [string, string],
    );
    expect(keys).toEqual([`${RECENTS_KEY_PREFIX}${WIKI}`]);

    // …and the first wiki still has it.
    await reloadKeepingStore(page, WIKI);
    expect(await relPathsIn(page, "recent")).toEqual([ARSAVREGNING]);
  });

  test("a bare Jira number jumps to the issue page, then what references it", async ({ page }) => {
    await openRail(page);
    await page.fill("#wikiSearch", "7588");

    expect(await sectionLabels(page)).toEqual(["7588 · issue page + 2 referencing pages"]);
    // The ISSUE page leads; the references follow in the rail's current sort,
    // which is by mtime here — so their order is asserted as a SET, not a list.
    const jumped = await relPathsIn(page, "jump");
    expect(jumped[0]).toBe(ISSUE);
    expect(jumped.slice(1).sort()).toEqual([ARCHIVE, DATAMODEL].sort());
    // The jump found a page the substring search could not: `flows/datamodel.md`
    // carries the key only as a tag `melosys-7588`, which "7588" does not match.
    expect(await relPathsIn(page, "all")).toEqual([]);
    await expect(page.locator("#wikiCount")).toHaveText(`3 / ${PAGES.length}`);
  });

  test("the prefixed key finds the same pages", async ({ page }) => {
    await openRail(page);
    await page.fill("#wikiSearch", "MELOSYS-7588");
    const jumped = await relPathsIn(page, "jump");
    expect(jumped[0]).toBe(ISSUE);
    expect(jumped.slice(1).sort()).toEqual([ARCHIVE, DATAMODEL].sort());
    expect(await sectionLabels(page)).toEqual(["MELOSYS-7588 · issue page + 2 referencing pages"]);
  });

  test("a jump row opens the page it names", async ({ page }) => {
    await openRail(page);
    await page.fill("#wikiSearch", "7588");
    await page.locator(`.wiki-list-item[data-sec="jump"][data-relpath="${DATAMODEL}"]`).click();
    await expect(page.locator(".wiki-bc-cur")).toContainText("Trygdeavgift datamodel");
  });

  test("a number that names no issue costs nothing — no header, ordinary results", async ({
    page,
  }) => {
    await openRail(page);
    // 2026 parses as a bare key by design; it resolves to no page, so the jump
    // renders nothing rather than an empty block.
    await page.fill("#wikiSearch", "2026");
    expect(await sectionLabels(page)).toEqual([]);
    expect(await page.locator(".wiki-list-item").count()).toBe(0);
    await expect(page.locator("#wikiList .wiki-conn-empty")).toHaveText("No pages match.");
  });

  test("an ordinary search is untouched by the jump", async ({ page }) => {
    await openRail(page);
    await page.fill("#wikiSearch", "kildeskatt");
    expect(await sectionLabels(page)).toEqual([]);
    expect(await relPathsIn(page, "all")).toEqual([KILDESKATT]);
  });
});
