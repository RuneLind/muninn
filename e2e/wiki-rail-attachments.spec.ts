/**
 * ATTACHMENTS in the /wiki reader's page rail — the render half of the store's
 * pairing pass (`pairAttachments`, `src/wiki/store.ts`).
 *
 * What the unit tests cannot reach, and the reason this file exists:
 *
 *  1. **The chain that renders a group.** `buildRail` is a pure arrangement;
 *     whether a chip ever appears depends on the listing carrying
 *     `children`/`parent`/`pairedBy` through `/api/wiki/pages`, the painter
 *     emitting the button, and the click reaching `toggleFolded`. Every unit
 *     test in that chain is green with the chain broken.
 *  2. **The count on screen.** `#wikiCount` is derived from `rail.shown`, and a
 *     closed fold lowers it — the one number that says the rail is not hiding
 *     rows it still claims to be showing.
 *  3. **The un-dropped `.html` is a real page.** It used to be dropped from the
 *     index entirely: it has to OPEN from its row while `?name=<stem>` still
 *     answers with the markdown page.
 *  4. **The fold survives a reload.** Per wiki, in localStorage, like the pins.
 *  5. **A query flattens it.** The rows are the search's rows — a hit inside a
 *     closed group is a result the reader asked for and cannot see.
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
import { SETTLED_CREATED_LINE, settleWikiMtimes } from "./settled-wiki.ts";

const PORT = e2ePort("wiki-rail-attachments");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

const WIKI = "e2e-attach";

/** Settled, so the rail's Activity section claims none of these rows — this file
 *  is about the groups, and a fixture written a millisecond ago is all news. */
function md(title: string, extra: string[] = [], body = "Body."): string {
  return ["---", `title: ${title}`, SETTLED_CREATED_LINE, ...extra, "---", "", body, ""].join("\n");
}

function html(title: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p></body></html>`;
}

/**
 * The fixture is one folder holding every pairing rule at once:
 *
 *  - `x.mdx` with two `-prototype` siblings (rule 2) and a superseded page
 *    pointing at it (rule 4) — three children, two kinds, so the chip has to say
 *    both;
 *  - `y.md` with a same-stem `y.html` (rule 1) — the case that used to be
 *    dropped from the index outright;
 *  - `lone.md`, attached to nothing, so "every row is in a group" cannot pass.
 */
const PAGES: Array<[string, string]> = [
  ["plans/x.mdx", md("X plan")],
  ["plans/x-prototype.html", html("X prototype")],
  ["plans/x-prototype-2.html", html("X prototype two")],
  ["plans/z.mdx", md("Z retired plan", ["superseded_by: [[x]]"])],
  ["plans/y.md", md("Y page")],
  ["plans/y.html", html("Y diagram")],
  ["plans/lone.md", md("Lone page")],
];

const X = "plans/x.mdx";
const Y = "plans/y.md";
const Y_HTML = "plans/y.html";
const PROTO = "plans/x-prototype.html";
const PROTO2 = "plans/x-prototype-2.html";
const Z = "plans/z.mdx";
const LONE = "plans/lone.md";

/** Every page the index holds — the `.html` twins included, which is the change. */
const ALL_PAGES = PAGES.length;

/**
 * Row order on screen. Every fixture page carries the same settled date, so the
 * default "Recently updated" sort falls through to its title tie-break — which
 * is why these are written out rather than assumed to follow the file list.
 */
const CLOSED_ORDER = [LONE, X, Y];
/** …and with `x`'s group open: its children follow it, in the same sort. */
const OPEN_ORDER = [LONE, X, PROTO, PROTO2, Z, Y];
/** Rows on screen with both groups CLOSED: the two parents plus the loner. */
const CLOSED_ROWS = CLOSED_ORDER.length;

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-attach-"));
  for (const [rel, body] of PAGES) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
  await settleWikiMtimes(root);

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

async function openRail(page: Page): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
  await expect(page.locator(".wiki-list-item").first()).toBeAttached();
}

const row = (page: Page, rel: string) => page.locator(`.wiki-list-item[data-relpath="${rel}"]`);

async function relPaths(page: Page): Promise<string[]> {
  return page
    .locator(".wiki-list-item")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-relpath") || ""));
}

/** The count the rail reports — `<shown> / <total>`. */
async function countText(page: Page): Promise<string> {
  return (await page.locator("#wikiCount").textContent()) ?? "";
}

test.describe("Wiki rail: attachments", () => {
  test("the listing carries the pairing, and the un-dropped .html is a page", async () => {
    const res = await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`);
    const data = (await res.json()) as {
      pages: Array<{ relPath: string; parent?: string; pairedBy?: string; children?: string[] }>;
    };
    const by = new Map(data.pages.map((p) => [p.relPath, p]));
    expect(by.size).toBe(ALL_PAGES);
    expect(by.get(X)!.children).toEqual([PROTO2, PROTO, Z]);
    expect(by.get(PROTO)!).toMatchObject({ parent: X, pairedBy: "suffix" });
    expect(by.get(Z)!).toMatchObject({ parent: X, pairedBy: "superseded" });
    expect(by.get(Y_HTML)!).toMatchObject({ parent: Y, pairedBy: "stem" });
    // The attachment is a page in its own right…
    const child = await fetch(`${BASE}/api/wiki/page?wiki=${WIKI}&relPath=${encodeURIComponent(Y_HTML)}`);
    expect(child.status).toBe(200);
    // …and the STEM still answers with the markdown page.
    const byName = await fetch(`${BASE}/api/wiki/page?wiki=${WIKI}&name=y`);
    expect(((await byName.json()) as { meta: { relPath: string } }).meta.relPath).toBe(Y);
  });

  test("groups start CLOSED: chips say what is inside, and the count agrees with the rows", async ({
    page,
  }) => {
    await openRail(page);
    expect(await relPaths(page)).toEqual(CLOSED_ORDER);
    expect(await countText(page)).toBe(`${CLOSED_ROWS} / ${ALL_PAGES}`);
    await expect(row(page, X).locator(".wiki-fold-chip")).toContainText("2 attached · 1 superseded");
    await expect(row(page, Y).locator(".wiki-fold-chip")).toContainText("1 attached");
    await expect(row(page, LONE).locator(".wiki-fold-chip")).toHaveCount(0);
    await expect(row(page, X).locator(".wiki-fold-chip")).toHaveAttribute("aria-expanded", "false");
  });

  test("the chip OPENS the group; the row still opens the page", async ({ page }) => {
    await openRail(page);
    await row(page, X).locator(".wiki-fold-chip").click();
    expect(await relPaths(page)).toEqual(OPEN_ORDER);
    expect(await countText(page)).toBe(`6 / ${ALL_PAGES}`);
    await expect(row(page, X).locator(".wiki-fold-chip")).toHaveAttribute("aria-expanded", "true");
    // The children are child rows, and they say why they fold.
    await expect(row(page, PROTO)).toHaveClass(/child/);
    await expect(row(page, Z)).toHaveAttribute("title", /Superseded by "X plan"/);
    // The chip did NOT navigate — the start view is still up.
    await expect(page.locator(".wiki-start")).toBeVisible();
    // …and a click on the ROW does open the page.
    await row(page, PROTO).click();
    await expect(page.locator("#articleWrap")).toContainText("X prototype");
  });

  test("the stored fold survives a reload, and closes again on a second click", async ({ page }) => {
    await openRail(page);
    await row(page, X).locator(".wiki-fold-chip").click();
    await openRail(page); // same context ⇒ same localStorage
    expect(await relPaths(page)).toContain(PROTO);
    await row(page, X).locator(".wiki-fold-chip").click();
    expect(await relPaths(page)).toEqual(CLOSED_ORDER);
    await openRail(page);
    expect(await relPaths(page)).toEqual(CLOSED_ORDER);
  });

  test("the OPEN page's group is expanded, whatever the store holds", async ({ page }) => {
    await openRail(page);
    // Nothing is open yet, so the group is closed and the child is not a row.
    expect(await relPaths(page)).not.toContain(Y_HTML);
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(Y_HTML)}`);
    await expect(page.locator(".wiki-list-item").first()).toBeAttached();
    // The reader is ON the attachment — the rail must not be hiding it.
    await expect(row(page, Y_HTML)).toHaveClass(/active/);
    expect(await relPaths(page)).toContain(Y_HTML);
  });

  test("a query FLATTENS the rail — every match is a row, none folded away", async ({ page }) => {
    await openRail(page);
    await page.fill("#wikiSearch", "prototype");
    expect(await relPaths(page)).toEqual([PROTO, PROTO2]);
    await expect(page.locator(".wiki-fold-chip")).toHaveCount(0);
    await page.fill("#wikiSearch", "");
    expect(await relPaths(page)).toEqual(CLOSED_ORDER);
  });

  test("Bookkeeping starts collapsed and its header carries the count", async ({ page }) => {
    // Written HERE rather than in the fixture above, so the other cases keep a
    // rail with no bookkeeping tail at all. The index is TTL-cached, so the
    // server is told to rescan before the page is opened — the reader's own boot
    // load deliberately does not send `refresh=1`.
    await writeFile(path.join(root, "plans/index.md"), md("Plans index"), "utf8");
    await settleWikiMtimes(root);
    try {
      await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}&refresh=1`);
      await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
      await expect(page.locator(".wiki-list-item").first()).toBeAttached();
      const fold = page.locator(".wiki-sec-fold");
      await expect(fold).toContainText("Bookkeeping");
      await expect(fold.locator(".wiki-sec-count")).toHaveText("1");
      await expect(fold).toHaveAttribute("aria-expanded", "false");
      expect(await relPaths(page)).not.toContain("plans/index.md");
      await fold.click();
      expect(await relPaths(page)).toContain("plans/index.md");
    } finally {
      await rm(path.join(root, "plans/index.md"), { force: true });
    }
  });

  // Both themes, and the contrast measured rather than eyeballed: the chip
  // carries a COUNT the reader has to read, so it sits at --text-muted like the
  // provenance strip's own lines and not at the dimmer tokens beside it
  // (--text-dim is 3.24:1 dark / 3.74:1 light, under the 4.5:1 floor). The
  // expected colour is resolved on a body probe rather than written as a
  // literal — a literal passes against the wrong rule.
  for (const scheme of ["light", "dark"] as const) {
    test(`the chip and the child rail are legible in the ${scheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openRail(page);
      const chip = row(page, X).locator(".wiki-fold-chip");
      const muted = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--text-muted)";
        document.body.appendChild(probe);
        const c = getComputedStyle(probe).color;
        probe.remove();
        return c;
      });
      await expect(chip).toHaveCSS("color", muted);

      // …and that colour really clears the floor against what is BEHIND it.
      const ratio = await chip.evaluate((el) => {
        const lum = (c: string): number => {
          const [r, g, b] = c.match(/[\d.]+/g)!.slice(0, 3).map(Number) as [number, number, number];
          const ch = (v: number) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
        };
        // The nearest ancestor that actually paints — the chip's own background
        // is a token over the pane's.
        let node: HTMLElement | null = el as HTMLElement;
        let bg = "rgba(0, 0, 0, 0)";
        while (node) {
          const c = getComputedStyle(node).backgroundColor;
          if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) {
            bg = c;
            break;
          }
          node = node.parentElement;
        }
        const a = lum(getComputedStyle(el).color);
        const b = lum(bg);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      expect(ratio).toBeGreaterThanOrEqual(4.5);

      // The child rail: a CHILD row carries the left rule that makes the group
      // read as one block. Open the fold first — closed, there is no child row.
      await row(page, X).locator(".wiki-fold-chip").click();
      const railColor = await row(page, PROTO).evaluate(
        (el) => getComputedStyle(el, "::before").backgroundColor,
      );
      expect(railColor).not.toBe("rgba(0, 0, 0, 0)");
    });
  }
});
