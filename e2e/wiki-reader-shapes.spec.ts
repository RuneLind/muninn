/**
 * The reader shapes (number columns, verdict cells, the label grid,
 * `src/format/reader-shapes.ts`) in a real browser, over a temp wiki: what a
 * reader SELECTS in a verdict cell or a grid item reads as the source does
 * (`✅ text`, `Label — text`), which is the text Explain and fact-check send
 * to `locateExcerpt`; and the ref links still read the bold label as the noun
 * before an id in a grid item, so no second noun is inserted. A unit test
 * cannot see either: whitespace around a hidden span is a layout outcome of
 * `Selection.toString()`, and the noun read-back walks the live DOM.
 *
 * One muninn on its own port (the wiki's `.wiki-reader.json` declares the
 * `D` id noun, and the shared 3011 server's wikis are the developer's). No
 * model calls, no DB writes. ENV / SPAWN ENV: the spawn inherits
 * `DATABASE_URL` and `e2eEnv()` blanks the platform tokens and the host's
 * instance-profile flags.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-reader-shapes");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-reader-shapes";
const PAGE_REL = "plans/shapes.mdx";

const PAGE = [
  "---",
  "title: Shapes page",
  "type: plan",
  "---",
  "",
  "# Shapes page",
  "",
  "| Sjekk | Antall | Resultat |",
  "|---|---|---|",
  "| A | 1,200 | ✅ Targeted update prevents overwriting |",
  "| B | 30 | ❌ Fails on retry |",
  "",
  "Prosjektene:",
  "",
  "- **Muninn** — personal assistant platform",
  "- **Huginn** — knowledge index",
  "- **Mimir** — the code wiki",
  "",
  "Status:",
  "",
  "- **Beslutning:** D7 holder.",
  "- **Eier:** fag",
  "- **Frist:** fredag",
  "",
  "<DecisionLog>",
  "",
  "- **D7** — Vi gjør det slik.",
  "",
  "</DecisionLog>",
  "",
].join("\n");

let server: ChildProcess | undefined;
let base = "";

test.beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "muninn-e2e-shapes-"));
  const root = path.join(base, "wiki");
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, PAGE_REL), PAGE, "utf8");
  await writeFile(
    path.join(root, ".wiki-reader.json"),
    JSON.stringify({ language: "no", idLabels: { D: { one: "Beslutning", other: "beslutninger" } } }),
    "utf8",
  );
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
  if (base) await rm(base, { recursive: true, force: true });
});

async function openPage(page: Page): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(PAGE_REL)}`);
  await expect(page.locator(".wiki-article ul.label-grid")).toHaveCount(2);
  // The ref links have run once D7 in the grid is a link.
  await expect(page.locator(".wiki-article ul.label-grid a.wiki-ref")).toHaveCount(1);
}

/** The selection text of one element's contents, and its `innerText`, each
 *  with white space runs collapsed to one space (`locateExcerpt` collapses so). */
async function selected(page: Page, selector: string, n = 0): Promise<{ selection: string; inner: string }> {
  return page.locator(selector).nth(n).evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
    const norm = (t: string) => t.replace(/\s+/g, " ").trim();
    return { selection: norm(s.toString()), inner: norm((el as HTMLElement).innerText) };
  });
}

test.describe("Wiki reader shapes: selection text and ref nouns", () => {
  test("a verdict cell selects as glyph, space, text", async ({ page }) => {
    await openPage(page);
    expect(await selected(page, ".wiki-article td.v-good")).toEqual({
      selection: "✅ Targeted update prevents overwriting",
      inner: "✅ Targeted update prevents overwriting",
    });
    expect((await selected(page, ".wiki-article td.v-bad")).selection).toBe("❌ Fails on retry");
    // The glyph is in the text, not on screen: the round icon stands for it.
    expect(await page.locator(".wiki-article td.v-good .v-glyph").evaluate((e) => e.getBoundingClientRect().width)).toBe(0);
  });

  test("a grid item selects as label, separator, text", async ({ page }) => {
    await openPage(page);
    expect(await selected(page, ".wiki-article ul.label-grid > li", 0)).toEqual({
      selection: "Muninn — personal assistant platform",
      inner: "Muninn — personal assistant platform",
    });
    expect((await selected(page, ".wiki-article ul.label-grid > li", 3)).selection).toBe("Beslutning: D7 holder.");
    expect(await page.locator(".wiki-article ul.label-grid .lg-c").first().evaluate((e) => e.getBoundingClientRect().width)).toBe(0);
  });

  test("the bold label is the noun before an id in a grid item: no second noun", async ({ page }) => {
    await openPage(page);
    await expect(page.locator(".wiki-article ul.label-grid .id-noun")).toHaveCount(0);
    expect(await page.locator(".wiki-article ul.label-grid > li").nth(3).evaluate((e) => e.textContent)).toBe("Beslutning: D7 holder.");
  });
});
