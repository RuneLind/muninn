/**
 * `<Diagram src="./x.architecture.json" />` on the /wiki reader: the
 * sanitized SVG of the archify HTML sibling (`src/wiki/diagram-svg.ts`), its
 * views (`wiki-visuals.ts`), the text form (`src/format/diagram-block.ts`) and
 * the reader-token colours (`diagram-styles.ts`).
 *
 * What only a laid-out page can answer: two diagrams on one page keep every id
 * unique and every arrowhead's `marker-end` resolves to a drawn marker; the
 * archify classes take the reader's tokens in both themes; a view dims the
 * nodes out of focus and the edges with both ends out, and never the
 * lifecycle's main rail; the text form is visually hidden beside the picture
 * and is what a peek shows; the «Open interactive» link points at the html.
 *
 * No model calls, no DB rows: one muninn over a temp wiki holding one
 * synthetic page and two hand-written archify-shaped files (no live corpus).
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-diagram");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-diagram";
const REL = "flows/system.mdx";

/** The defs every archify file carries, under the same ids in each. */
const DEFS =
  '<title id="archify-diagram-title">T</title><desc id="archify-diagram-description">D</desc>' +
  '<defs><marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" class="m-default"/></marker>' +
  '<pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M 20 0 L 0 0 0 20" class="c-grid"/></pattern></defs>' +
  // archify indents and separates blocks with blank lines; a <br> there would end the <svg>.
  "\n\n        \n" +
  '<rect width="600" height="200" fill="url(#grid)"/>\n\n';

const node = (id: string, x: number, cls: string) =>
  `<g data-node-id="${id}" role="button" tabindex="0" aria-label="${id}"><rect x="${x}" y="60" width="100" height="50" rx="6" class="${cls}"/>` +
  `<text x="${x + 50}" y="90" text-anchor="middle" class="t-primary">${id}</text></g>`;
const edge = (from: string, to: string, x1: number, x2: number) =>
  `<path d="M ${x1} 85 L ${x2} 85" class="a-default" marker-end="url(#arrowhead)" data-edge-from="${from}" data-edge-to="${to}"/>`;
const page = (svg: string) =>
  `<!doctype html><html><head><title>x</title><script>/* viewer */</script></head><body>` +
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200" role="img" lang="en" data-preset="dark" aria-labelledby="archify-diagram-title archify-diagram-description">${svg}</svg></body></html>`;

const ARCH_HTML = page(
  DEFS + node("web", 20, "c-frontend") + node("api", 240, "c-backend") + node("db", 460, "c-database") + edge("web", "api", 120, 238) + edge("api", "db", 340, 458),
);
const ARCH_JSON = {
  meta: {
    title: "System map",
    views: [
      { id: "back", label: "Back end", focus: ["api", "db"], note: "The server side." },
      { id: "front", label: "Front end", focus: ["web"] },
    ],
  },
  components: [
    { id: "web", label: "Web", type: "frontend" },
    { id: "api", label: "API", type: "backend" },
    { id: "db", label: "Store", type: "database" },
  ],
  connections: [
    { from: "web", to: "api", label: "HTTPS" },
    { from: "api", to: "db" },
  ],
};

// The lifecycle's main rail is plain paths with no data-edge-* (archify draws it so).
const LIFE_HTML = page(
  DEFS + node("new", 20, "c-frontend") + node("paid", 240, "c-backend") + node("sent", 460, "c-backend") +
    '<path d="M 120 85 L 238 85" class="a-default" marker-end="url(#arrowhead)"/><path d="M 340 85 L 458 85" class="a-default" marker-end="url(#arrowhead)"/>',
);
const LIFE_JSON = {
  meta: { title: "Order life", views: [{ id: "start", label: "Start", focus: ["new"] }] },
  lanes: [{ id: "main", label: "Main" }],
  states: [
    { id: "new", label: "New", lane: "main", col: 1 },
    { id: "paid", label: "Paid", lane: "main", col: 2 },
    { id: "sent", label: "Sent", lane: "main", col: 3 },
  ],
};

const PAGE = [
  "---",
  "title: System",
  "---",
  "",
  "# System",
  "",
  "See «Order life» for how an order moves.",
  "",
  "## System map",
  "",
  '<Diagram src="./system.architecture.json" />',
  "",
  "## Order life",
  "",
  '<Diagram src="./order.lifecycle.json" />',
  "",
  "The line after the lifecycle.",
  "",
].join("\n");

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-diagram-"));
  await mkdir(path.join(root, "flows"), { recursive: true });
  await writeFile(path.join(root, REL), PAGE, "utf8");
  await writeFile(path.join(root, "flows", "system.architecture.json"), JSON.stringify(ARCH_JSON), "utf8");
  await writeFile(path.join(root, "flows", "system.html"), ARCH_HTML, "utf8");
  await writeFile(path.join(root, "flows", "order.lifecycle.json"), JSON.stringify(LIFE_JSON), "utf8");
  await writeFile(path.join(root, "flows", "order.html"), LIFE_HTML, "utf8");
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

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
  await expect(page.locator(".wiki-article figure.dgm .dgm-svg svg")).toHaveCount(2);
}

const arch = (page: Page) => page.locator(".wiki-article figure.dgm-architecture");
const life = (page: Page) => page.locator(".wiki-article figure.dgm-lifecycle");
const dimmed = (page: Page, fig: ReturnType<typeof arch>) =>
  fig.locator(".dgm-svg .dgm-dim").evaluateAll((els) => els.map((e) => e.getAttribute("data-node-id") ?? `${e.getAttribute("data-edge-from")}>${e.getAttribute("data-edge-to")}`).sort());

test.describe("Wiki reader: Diagram", () => {
  for (const scheme of ["dark", "light"] as const) {
    test(`${scheme}: two diagrams, unique ids, every arrowhead resolves, archify classes in reader tokens`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      const ids = await page.evaluate(() => Array.from(document.querySelectorAll(".wiki-article [id]")).map((e) => e.id));
      expect(ids.length).toBeGreaterThan(8);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain("dgm1-arrowhead");
      expect(ids).toContain("dgm2-arrowhead");
      const markers = await page.evaluate(() =>
        Array.from(document.querySelectorAll<SVGPathElement>(".wiki-article .dgm-svg path[marker-end]")).map((p) => {
          const m = /url\("?#([^")]+)"?\)/.exec(getComputedStyle(p).markerEnd);
          const target = m ? document.getElementById(m[1]!) : null;
          return { ok: target?.tagName.toLowerCase() === "marker", fig: p.closest("figure")?.className ?? "" };
        }),
      );
      expect(markers).toHaveLength(4);
      // Every drawn element is in the SVG namespace (nothing escaped the <svg>).
      expect(await page.locator(".wiki-article .dgm-svg br").count()).toBe(0);
      expect(markers.every((m) => m.ok)).toBe(true);
      // Each diagram's paths point into its own defs.
      const own = await page.evaluate(() =>
        Array.from(document.querySelectorAll<SVGPathElement>(".wiki-article .dgm-svg path[marker-end]")).every((p) => {
          const id = /url\(#([^)]+)\)/.exec(p.getAttribute("marker-end") ?? "")?.[1];
          return !!id && p.closest("svg")!.contains(document.getElementById(id));
        }),
      );
      expect(own).toBe(true);
      // SVG's camelCase attributes reach the DOM as SVG reads them.
      const camel = await page.evaluate(() => ({
        markerWidth: (document.getElementById("dgm1-arrowhead") as unknown as SVGMarkerElement).markerWidth.baseVal.value,
        viewBox: document.querySelector<SVGSVGElement>(".wiki-article .dgm-svg svg")!.viewBox.baseVal.width,
      }));
      expect(camel).toEqual({ markerWidth: 8, viewBox: 600 });
      // The archify class rules take the reader's tokens: a frontend rect is filled, not default black.
      const fill = await arch(page).locator(".dgm-svg rect.c-frontend").evaluate((e) => getComputedStyle(e).fill);
      expect(fill).not.toBe("rgb(0, 0, 0)");
      const cyan = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--status-cyan)";
        document.body.appendChild(probe);
        const v = getComputedStyle(probe).color;
        probe.remove();
        return v;
      });
      expect(await arch(page).locator(".dgm-svg rect.c-frontend").evaluate((e) => getComputedStyle(e).stroke)).toBe(cyan);
      // The text form sits beside the picture, visually hidden.
      const text = arch(page).locator(".dgm-text");
      await expect(text).toContainText("Web → API (HTTPS)");
      expect((await text.boundingBox())!.width).toBeLessThanOrEqual(1);
      await expect(arch(page).locator(".dgm-svg svg")).toBeVisible();
    });
  }

  test("views dim the nodes out of focus and the edges with both ends out", async ({ page }) => {
    await open(page);
    const fig = arch(page);
    await fig.locator('button[data-dgm-view="back"]').click();
    expect(await dimmed(page, fig)).toEqual(["web"]);
    await expect(fig.locator('.dgm-note[data-dgm-note="back"]')).toBeVisible();
    await expect(fig.locator('button[data-dgm-view="back"]')).toHaveAttribute("aria-pressed", "true");
    await fig.locator('button[data-dgm-view="front"]').click();
    expect(await dimmed(page, fig)).toEqual(["api", "api>db", "db"]);
    await expect(fig.locator('.dgm-note[data-dgm-note="back"]')).toBeHidden();
    await fig.locator('button[data-dgm-view=""]').click();
    expect(await dimmed(page, fig)).toEqual([]);
    // A dimmed node really fades.
    await fig.locator('button[data-dgm-view="back"]').click();
    const web = fig.locator('.dgm-svg [data-node-id="web"]');
    await expect.poll(async () => Number(await web.evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(0.5);
  });

  test("the lifecycle's main rail never dims", async ({ page }) => {
    await open(page);
    const fig = life(page);
    await fig.locator('button[data-dgm-view="start"]').click();
    expect(await dimmed(page, fig)).toEqual(["paid", "sent"]);
    expect(await fig.locator(".dgm-svg path[marker-end].dgm-dim").count()).toBe(0);
  });

  test("a peek shows the text form and none of the picture", async ({ page }) => {
    await open(page);
    await page.locator(".wiki-article a.wiki-ref", { hasText: "Order life" }).first().hover();
    const peek = page.locator(".wiki-ref-peek");
    await expect(peek).toBeVisible();
    await expect(peek).toContainText("New → Paid");
    expect((await peek.locator(".dgm-text").boundingBox())!.width).toBeGreaterThan(50);
    await expect(peek.locator("svg, .dgm-views, .dgm-svg, .dgm-foot, .dgm-note")).toHaveCount(0);
  });

  test("«Open interactive» points at the html sibling", async ({ page }) => {
    await open(page);
    const a = arch(page).locator("a.dgm-open");
    await expect(a).toBeVisible();
    const href = await a.getAttribute("href");
    expect(href).toContain("/api/wiki/html?");
    expect(decodeURIComponent(href!)).toContain("flows/system.html");
    const res = await page.request.get(new URL(href!, BASE).toString());
    expect(res.ok()).toBe(true);
  });
});
