/**
 * `<SystemMap>` on the /wiki reader (`systemMapBlockHtml` in
 * `src/web/web-format.ts`, the view in `src/format/system-map-view.ts`, CSS in
 * `systemMapCss`), in both themes.
 *
 * What only a laid-out page can answer: the map draws one box per node in its
 * group's column, left to right in the `groups=` order, above the edge table
 * it is read from; node labels reach 4.5:1 on their boxes and edges 3:1 on the
 * map in the theme's tokens; a `wrong` edge looks unlike an `ok` one; a node
 * opens its repos page through the reader's own navigation; a peek of the
 * section shows the table, not the map; and at 390 px the map scrolls inside
 * its own box while the page does not.
 *
 * The map has no client code, so there is no state to enumerate: the server
 * draws it and the page only lays it out.
 *
 * No model calls, no DB rows: one muninn over a temp wiki of synthetic repos
 * pages and one hub page.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-system-map");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-system-map";
const REL = "flows/systems.mdx";

const repo = (name: string, body: string) => `---\ntitle: ${name}\n---\n# ${name}\n\n${body}\n`;

const FILES: Record<string, string> = {
  "repos/alpha-web.md": repo("alpha-web", "## Related repos\n\n- [[repos/beta-api]]"),
  "repos/beta-api.md": repo("beta-api", "## External integrations (all mocked)\n\n- [[repos/gamma-svc]]"),
  "repos/gamma-svc.md": repo("gamma-svc", "No link sections."),
  "integrations/registry.md": "---\ntitle: Registry\n---\n# Registry\n\nAn external system.\n",
  [REL]: [
    "---",
    "title: Systems",
    "---",
    "# Systems",
    "",
    "Which system calls which; see «Map» for the drawing.",
    "",
    "## Map",
    "",
    '<SystemMap caption="Synthetic systems" external="Registry" groups="alpha-web=frontend;beta-api=core;gamma-svc=services">',
    "",
    "| Fra | Til | Protokoll | Status | Bevis |",
    "|---|---|---|---|---|",
    "| alpha-web | beta-api | REST | ok | linked both ways |",
    "| beta-api | [[repos/gamma-svc|gamma-service-under-a-label-far-too-long-for-one-column]] | Kafka | wrong | the topic was retired |",
    "| beta-api | Registry | SOAP | ok | |",
    "| gamma-svc | typo-svc | REST | ok | |",
    "",
    "</SystemMap>",
    "",
    "## Notes",
    "",
    "The rows above are synthetic.",
    "",
  ].join("\n"),
};

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-sysmap-"));
  for (const [rel, text] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, "utf8");
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
  if (root) await rm(root, { recursive: true, force: true });
});

async function open(page: Page, width = 1280): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
  await expect(page.locator(".wiki-article section.sm .sm-map svg")).toHaveCount(1);
}

/** WCAG contrast of two computed `rgb(…)` colours. */
async function contrast(page: Page, fg: string, bg: string): Promise<number> {
  return page.evaluate(
    ([a, b]) => {
      const lum = (c: string) => {
        const [r, g, bl] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
      };
      const [x, y] = [lum(a!), lum(b!)].sort((p, q) => q - p);
      return (x! + 0.05) / (y! + 0.05);
    },
    [fg, bg],
  );
}

const css = (page: Page, sel: string, prop: string) => page.locator(sel).first().evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);

test.describe("Wiki reader: SystemMap", () => {
  for (const scheme of ["dark", "light"] as const) {
    test(`${scheme}: the map draws the table's nodes and edges in their columns, legibly`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      const sec = page.locator(".wiki-article section.sm");
      await expect(sec).toHaveAttribute("aria-label", "System map: Synthetic systems");
      // One box per node, one path per row; the table stays below the map.
      await expect(sec.locator(".sm-node")).toHaveCount(5);
      await expect(sec.locator("path.sm-edge")).toHaveCount(4);
      await expect(sec.locator("table")).toBeVisible();
      const order = await sec.evaluate((s) => [s.querySelector(".sm-map"), s.querySelector("table")].map((e) => Array.from(s.querySelectorAll("*")).indexOf(e!)));
      expect(order[0]).toBeLessThan(order[1]!);

      // The map fills the article column and its smallest text (11px column
      // heads) never draws under 9px.
      const scale = await sec.locator(".sm-svg").evaluate((svg) => svg.getBoundingClientRect().width / (svg as SVGSVGElement).viewBox.baseVal.width);
      expect(11 * scale).toBeGreaterThanOrEqual(9 - 0.01);
      expect(scale).toBeLessThanOrEqual(1);
      // No label runs past its box, and no edge passes under a box it does not
      // end at (beta-api → Registry crosses two columns).
      const layout = await sec.locator(".sm-svg").evaluate((svg) => {
        const boxes = Array.from(svg.querySelectorAll(".sm-node")).map((g) => {
          const r = g.querySelector("rect") as SVGRectElement;
          return { key: g.getAttribute("data-sm-node")!, x: r.x.baseVal.value, y: r.y.baseVal.value, w: r.width.baseVal.value, h: r.height.baseVal.value, text: (g.querySelector("text") as SVGTextElement).getComputedTextLength() };
        });
        const under: string[] = [];
        for (const p of Array.from(svg.querySelectorAll("path.sm-edge")) as SVGPathElement[]) {
          const ends = [p.getAttribute("data-sm-from"), p.getAttribute("data-sm-to")];
          for (let s = 0; s <= p.getTotalLength(); s += 1) {
            const pt = p.getPointAtLength(s);
            const hit = boxes.find((b) => !ends.includes(b.key) && pt.x > b.x + 1 && pt.x < b.x + b.w - 1 && pt.y > b.y + 1 && pt.y < b.y + b.h - 1);
            if (hit) {
              under.push(`${ends.join("→")} under ${hit.key}`);
              break;
            }
          }
        }
        return { overflow: boxes.filter((b) => b.text > b.w - 8).map((b) => b.key), under };
      });
      expect(layout).toEqual({ overflow: [], under: [] });
      // Columns left to right in groups= order, then repos (typo-svc), then external.
      const x = async (key: string) => (await sec.locator(`[data-sm-node="${key}"] rect`).boundingBox())!.x;
      const xs = await Promise.all(["alpha-web", "beta-api", "gamma-svc", "typo-svc", "registry"].map(x));
      for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);

      // Kinds: a repo node links, an external links its integrations page, an unresolved one does not.
      await expect(sec.locator('a.sm-node.sm-repo[data-relpath="repos/beta-api.md"]')).toHaveCount(1);
      await expect(sec.locator('a.sm-node.sm-external[data-relpath="integrations/registry.md"]')).toHaveCount(1);
      await expect(sec.locator('g.sm-node.sm-unresolved[data-sm-node="typo-svc"]')).toHaveCount(1);

      // Contrast in the theme's tokens: label on box 4.5:1, edges on the map 3:1.
      const mapBg = await css(page, ".wiki-article .sm-map", "background-color");
      const boxFill = await css(page, ".wiki-article .sm-repo rect", "fill");
      const label = await css(page, ".wiki-article .sm-repo text", "fill");
      expect(await contrast(page, label, boxFill)).toBeGreaterThanOrEqual(4.5);
      const ok = await css(page, ".wiki-article path.sm-ok", "stroke");
      const wrong = await css(page, ".wiki-article path.sm-wrong", "stroke");
      expect(await contrast(page, ok, mapBg)).toBeGreaterThanOrEqual(3);
      expect(await contrast(page, wrong, mapBg)).toBeGreaterThanOrEqual(3);
      // A wrong edge is told apart by more than colour: it is dashed, an ok one is not.
      expect(wrong).not.toBe(ok);
      expect(await css(page, ".wiki-article path.sm-wrong", "stroke-dasharray")).not.toBe("none");
      expect(await css(page, ".wiki-article path.sm-ok", "stroke-dasharray")).toBe("none");
      // The column heads read on the map too.
      expect(await contrast(page, await css(page, ".wiki-article .sm-col", "fill"), mapBg)).toBeGreaterThanOrEqual(4.5);
      // Every id on the page is unique (the arrow markers carry the block prefix).
      const ids = await page.evaluate(() => Array.from(document.querySelectorAll(".wiki-article [id]")).map((e) => e.id));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(expect.arrayContaining(["sm1-arr-ok", "sm1-arr-wrong"]));
    });
  }

  test("a node opens its repos page through the reader's navigation", async ({ page }) => {
    await open(page);
    await page.locator('.wiki-article a.sm-node[data-relpath="repos/beta-api.md"]').click();
    await expect(page).toHaveURL(/relPath=repos%2Fbeta-api\.md/);
    await expect(page.locator(".wiki-article")).toContainText("External integrations");
  });

  test("a peek of the section shows the edge table, not the map", async ({ page }) => {
    await open(page);
    await page.locator(".wiki-article a.wiki-ref", { hasText: "Map" }).first().hover();
    const peek = page.locator(".wiki-ref-peek");
    await expect(peek).toBeVisible();
    await expect(peek.locator("table")).toHaveCount(1);
    await expect(peek.locator("svg, .sm-map, .sm-notes, [role=figure]")).toHaveCount(0);
  });

  test("at 390 px the map scrolls in its own box; the page does not scroll sideways", async ({ page }) => {
    await open(page, 390);
    await page.keyboard.press("f").catch(() => undefined);
    const box = page.locator(".wiki-article .sm-map");
    const sizes = await box.evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }));
    expect(sizes.scroll).toBeGreaterThan(sizes.client);
    const doc = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(doc.scroll).toBeLessThanOrEqual(doc.client);
    // The scrolling box is a keyboard stop with a name.
    await expect(box).toHaveAttribute("tabindex", "0");
    await expect(box).toHaveAttribute("aria-label", "System map: Synthetic systems");
  });
});
