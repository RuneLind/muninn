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
 * and is what a peek shows; the «Open interactive» link points at the html;
 * the picture fills the column down to its legibility floor, scrolls only
 * below it, and is a tab stop only while it scrolls.
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

// Playwright's headless Chromium passes --hide-scrollbars, which would hide the
// cue a wide drawing's region gives that it scrolls.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

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


/**
 * As wide as the real archify files (viewBox 816–1160) and with their label
 * classes and sizes: 7 px «fine» labels, 8 px edge labels on a mask, 11 px
 * names, every coloured `t-` class on its own `c-` fill and on the bare panel.
 */
const WIDE_W = 1160;
const KINDS = ["frontend", "backend", "database", "cloud", "security", "messagebus", "external"] as const;
const wideNode = (k: string, i: number) => {
  const x = 20 + i * 165;
  return (
    `<g data-node-id="${k}"><rect x="${x}" y="40" width="150" height="70" rx="6" class="c-${k}"/>` +
    `<text x="${x + 75}" y="66" text-anchor="middle" font-size="11" class="t-primary">${k}-service-name</text>` +
    `<text x="${x + 75}" y="82" text-anchor="middle" font-size="8" class="t-muted">sub ${k}</text>` +
    `<text x="${x + 75}" y="98" text-anchor="middle" font-size="7" class="t-${k}">fine ${k}</text></g>`
  );
};
const edgeLabel = (k: string, i: number) => {
  const x = 20 + i * 165;
  return `<g><rect x="${x + 20}" y="150" width="110" height="14" class="c-mask"/><text x="${x + 75}" y="160" text-anchor="middle" font-size="8" class="t-${k}">edge ${k}</text></g>`;
};
const bare = (cls: string, i: number) => `<g><text x="${20 + i * 125}" y="220" font-size="7" class="${cls}">bare ${cls}</text></g>`;
const WIDE_HTML = page(
  DEFS.replace('width="600" height="200"', `width="${WIDE_W}" height="260"`) +
    KINDS.map(wideNode).join("") +
    KINDS.map(edgeLabel).join("") +
    ["t-dim", "t-muted", ...KINDS.map((k) => `t-${k}`)].map(bare).join(""),
).replace('viewBox="0 0 600 200"', `viewBox="0 0 ${WIDE_W} 260"`);
const WIDE_JSON = { meta: { title: "Wide map" }, components: KINDS.map((k) => ({ id: k, label: k, type: k })), connections: [] };

const WIDE_REL = "flows/wide.mdx";
const WIDE_PAGE = [
  "---",
  "title: Wide",
  "---",
  "",
  "# Wide",
  "",
  '<Diagram src="./wide.architecture.json" />',
  "",
  "## No html",
  "",
  '<Diagram src="./nohtml.architecture.json" />',
  "",
].join("\n");

/**
 * A drawing whose legibility floor (`ceil(600 × 8.5 / 12)` = 425 px) sits
 * between the 760 px window's column (~344 px) and the 1280 px one's (~508
 * px): it fills the wide column and scrolls in the narrow one. Its views put
 * buttons before the picture, to Tab from.
 */
const FIT_FLOOR = 425;
const fitLabel = (id: string, x: number, size: number) =>
  `<g data-node-id="${id}"><rect x="${x}" y="60" width="160" height="60" rx="6" class="c-backend"/>` +
  `<text x="${x + 80}" y="96" text-anchor="middle" font-size="${size}" class="t-primary">${id} label</text></g>`;
const FIT_HTML = page(DEFS + fitLabel("one", 20, 14) + fitLabel("two", 220, 12) + fitLabel("three", 420, 12));
const FIT_JSON = {
  meta: { title: "Fit map", views: [{ id: "first", label: "First", focus: ["one"] }] },
  components: ["one", "two", "three"].map((id) => ({ id, label: id, type: "backend" })),
  connections: [],
};
const FIT_REL = "flows/fit.mdx";
const FIT_PAGE = ["---", "title: Fit", "---", "", "# Fit", "", '<Diagram src="./fit.architecture.json" />', "", "The line after.", ""].join("\n");

/** The fit drawing twice: once in the open and once in a closed `<Fold>`, with
 *  a link back to this page (a re-render) and one away (a navigation). */
const FOCUS_REL = "flows/focus.mdx";
const FOCUS_PAGE = [
  "---",
  "title: Focus",
  "---",
  "",
  "# Focus",
  "",
  '<Diagram src="./fit.architecture.json" />',
  "",
  "Read [[focus]] again, or go to [[wide]].",
  "",
  '<Fold title="Folded picture">',
  "",
  '<Diagram src="./fit.architecture.json" />',
  "",
  "</Fold>",
  "",
].join("\n");

// A hostile archify file: a stray </div> and an end tag whose quoted attribute
// value holds a `>` and a glossary term, then an inert onerror probe. Before the
// fix, the end tag passed through the sanitizer byte for byte, the glossary pass
// marked the term inside the attribute value, and the inserted span's `"` closed
// the value — turning the rest into a live <img onerror>. The probe records a
// window flag rather than fetching, so the fixture is inert by construction.
const HOSTILE_REL = "flows/hostile.mdx";
const HOSTILE_PAGE = [
  "---",
  "title: Hostile",
  "---",
  "",
  "# Hostile",
  "",
  "<Glossary>",
  "",
  "- **Hold:** a book kept back",
  "",
  "</Glossary>",
  "",
  '<Diagram src="./hostile.architecture.json" />',
  "",
].join("\n");
const HOSTILE_HTML =
  `<!doctype html><html><head><title>x</title></head><body>` +
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" role="img">` +
  `<title id="archify-diagram-title">T</title>` +
  `<g data-node-id="a"><rect x="1" y="2" width="30" height="20" class="c-frontend"/><text x="5" y="15" class="t-primary">a</text></g>` +
  `</div></g data-x="z>Hold<img src=x onerror='window.__dgmPwn=1'>y">` +
  `</svg></body></html>`;
const HOSTILE_JSON = { meta: { title: "Hostile map" }, components: [{ id: "a", label: "A", type: "frontend" }] };

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
  await writeFile(path.join(root, WIDE_REL), WIDE_PAGE, "utf8");
  await writeFile(path.join(root, "flows", "wide.architecture.json"), JSON.stringify(WIDE_JSON), "utf8");
  await writeFile(path.join(root, "flows", "wide.html"), WIDE_HTML, "utf8");
  // A diagram whose html sibling does not exist.
  await writeFile(path.join(root, "flows", "nohtml.architecture.json"), JSON.stringify(WIDE_JSON), "utf8");
  await writeFile(path.join(root, FIT_REL), FIT_PAGE, "utf8");
  await writeFile(path.join(root, "flows", "fit.architecture.json"), JSON.stringify(FIT_JSON), "utf8");
  await writeFile(path.join(root, "flows", "fit.html"), FIT_HTML, "utf8");
  await writeFile(path.join(root, FOCUS_REL), FOCUS_PAGE, "utf8");
  await writeFile(path.join(root, HOSTILE_REL), HOSTILE_PAGE, "utf8");
  await writeFile(path.join(root, "flows", "hostile.architecture.json"), JSON.stringify(HOSTILE_JSON), "utf8");
  await writeFile(path.join(root, "flows", "hostile.html"), HOSTILE_HTML, "utf8");
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

  test("an html sibling that is not there gets no «Open interactive» link", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(WIDE_REL)}`);
    const fig = page.locator(".wiki-article figure.dgm").nth(1);
    await expect(fig).toContainText("Picture not shown: nohtml.html");
    // Let the client enhancer run, then look: no link, hidden or shown.
    await expect(page.locator(".wiki-article figure.dgm").first().locator("a.dgm-open")).toBeVisible();
    await expect(fig.locator("a.dgm-open")).toHaveCount(0);
  });
});

/** WCAG contrast of every label against what is drawn behind it: the last
 *  rect of its group (a node box or an edge-label mask), else the figure. */
async function labelContrast(page: Page): Promise<{ text: string; ratio: number }[]> {
  return page.locator(".wiki-article figure.dgm").first().evaluate((fig) => {
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const rgba = (css: string): number[] => {
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = "#000";
      probe.fillStyle = css;
      probe.fillRect(0, 0, 1, 1);
      const d = probe.getImageData(0, 0, 1, 1).data;
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
    };
    const over = (fg: number[], bg: number[]) => [0, 1, 2].map((i) => fg[i]! * fg[3]! + bg[i]! * (1 - fg[3]!)).concat(1);
    const lum = (c: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
    };
    const panel = over(rgba(getComputedStyle(fig).backgroundColor), [255, 255, 255, 1]);
    return Array.from(fig.querySelectorAll(".dgm-svg text")).map((t) => {
      const rect = Array.from(t.closest("g")?.querySelectorAll(":scope > rect") ?? []).pop();
      const bg = rect ? over(rgba(getComputedStyle(rect).fill), panel) : panel;
      const [hi, lo] = [lum(over(rgba(getComputedStyle(t).fill), bg)), lum(bg)].sort((a, b) => b - a);
      return { text: t.textContent ?? "", ratio: Math.round(((hi! + 0.05) / (lo! + 0.05)) * 100) / 100 };
    });
  });
}

test.describe("Wiki reader: a hostile Diagram cannot break out of the picture", () => {
  test("no injected element, no on* handler, no glossary mark, no flag set", async ({ page }) => {
    const pwn: unknown[] = [];
    await page.exposeFunction("__dgmReport", (v: unknown) => pwn.push(v));
    await page.addInitScript(() => {
      Object.defineProperty(window, "__dgmPwn", { set: (v) => (window as unknown as { __dgmReport: (v: unknown) => void }).__dgmReport(v), configurable: true });
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(HOSTILE_REL)}`);
    await expect(page.locator(".wiki-article figure.dgm")).toHaveCount(1);
    await page.waitForTimeout(300); // let any injected onerror fire
    const fig = page.locator(".wiki-article figure.dgm");
    // The sanitizer keeps the one benign node; nothing hostile reaches the DOM.
    expect(await fig.locator("img, script").count()).toBe(0);
    expect(await fig.locator(".gl-mark, .gl-term").count()).toBe(0);
    // No on* attribute anywhere in the picture.
    const onAttrs = await fig.locator(".dgm-svg").evaluate((el) =>
      Array.from(el.querySelectorAll("*")).flatMap((n) => Array.from(n.attributes).map((a) => a.name)).filter((n) => n.toLowerCase().startsWith("on")),
    );
    expect(onAttrs).toEqual([]);
    expect(pwn).toEqual([]);
  });
});

/** A reader token resolved on a body probe, as the browser computes it. */
const token = (page: Page, name: string) =>
  page.evaluate((n) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${n})`;
    document.body.appendChild(probe);
    const v = getComputedStyle(probe).color;
    probe.remove();
    return v;
  }, name);

/** The first picture's box: its size, whether it scrolls and is a tab stop, and its labels' heights. */
const pictureBox = (page: Page) =>
  page.locator(".wiki-article figure.dgm .dgm-svg").first().evaluate((box: HTMLElement) => {
    const svg = box.querySelector("svg")!.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const texts = Array.from(box.querySelectorAll("text")).map((t) => {
      const r = t.getBoundingClientRect();
      return { text: t.textContent ?? "", h: r.height, cut: r.left < b.left - 0.5 || r.right > b.right + 0.5 };
    });
    return {
      svgW: svg.width,
      svgH: svg.height,
      clientW: box.clientWidth,
      scrollW: box.scrollWidth,
      minHeight: Math.min(...texts.map((t) => t.h)),
      cut: texts.filter((t) => t.cut).map((t) => t.text),
      // A classic scrollbar takes layout height; an overlay one (no cue) takes none.
      scrollbar: box.offsetHeight - box.clientHeight,
      role: box.getAttribute("role"),
      name: box.getAttribute("aria-label") ?? "",
      tabindex: box.getAttribute("tabindex"),
      tabIndex: box.tabIndex,
      pageScroll: document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth,
    };
  });

/** The focused picture's outline is the reader's own (2 px solid accent), which
 *  the browser default (`auto`, 1 px) does not match. */
async function expectFocusRing(page: Page, box: ReturnType<Page["locator"]>): Promise<void> {
  const ring = await box.evaluate((el) => {
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, offset: s.outlineOffset };
  });
  expect(ring).toEqual({ style: "solid", width: "2px", color: await token(page, "--accent-light"), offset: "2px" });
}

test.describe("Wiki reader: a Diagram as wide as archify draws", () => {
  async function openWide(page: Page, width: number): Promise<void> {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(WIDE_REL)}`);
    await expect(page.locator(".wiki-article figure.dgm .dgm-svg svg")).toHaveCount(1);
  }

  for (const scheme of ["light", "dark"] as const) {
    for (const width of [1280, 760]) {
      test(`${scheme} ${width}: past its floor the drawing scrolls in a named tab stop with a styled scrollbar, every label legible`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await openWide(page, width);
        const box = page.locator(".wiki-article figure.dgm .dgm-svg").first();
        // The floor, ceil(1160 × 8.5 / 7) = 1409 px, is past both columns.
        await expect.poll(async () => (await pictureBox(page)).tabIndex).toBe(0);
        const m = await pictureBox(page);
        expect(Math.round(m.svgW)).toBe(1409);
        expect(m.minHeight).toBeGreaterThanOrEqual(9);
        expect(m.pageScroll).toBeLessThanOrEqual(0);
        expect(m.cut.length).toBeGreaterThan(0);
        expect(m.scrollW).toBeGreaterThan(m.clientW);
        // The styled scrollbar's own height; a native one is 15 px on Linux and 0 as an overlay.
        expect(m.scrollbar).toBe(10);
        expect(m.role).toBe("region");
        expect(m.name).toContain("Wide map");
        // Scrolled to the end, the last label is in view.
        await box.evaluate((el) => (el.scrollLeft = el.scrollWidth));
        expect((await pictureBox(page)).cut).not.toContain("bare t-external");
        await box.focus();
        await expectFocusRing(page, box);
      });
    }

    test(`${scheme}: every label reads at 4.5:1 or better on what is behind it`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openWide(page, 1280);
      const low = (await labelContrast(page)).filter((l) => l.ratio < 4.5);
      expect(low).toEqual([]);
    });
  }
});


test.describe("Wiki reader: a Diagram fills the column down to its legibility floor", () => {
  async function openFit(page: Page, width: number): Promise<void> {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(FIT_REL)}`);
    await expect(page.locator(".wiki-article figure.dgm .dgm-svg svg")).toHaveCount(1);
  }
  const fitBox = (page: Page) => page.locator(".wiki-article figure.dgm .dgm-svg").first();
  /** Tab once from the view button before the picture; what has focus then. */
  const tabFromViews = async (page: Page) => {
    await page.locator(".wiki-article figure.dgm .dgm-view").last().focus();
    await page.keyboard.press("Tab");
    return page.evaluate(() => document.activeElement?.classList.contains("dgm-svg") ?? false);
  };

  test("1280: a drawing whose floor fits fills the column, does not scroll, and is no tab stop", async ({ page }) => {
    await openFit(page, 1280);
    const m = await pictureBox(page);
    expect(m.clientW).toBeGreaterThan(FIT_FLOOR);
    expect(Math.abs(m.svgW - m.clientW)).toBeLessThanOrEqual(1);
    // The viewBox keeps the aspect ratio.
    expect(Math.abs(m.svgH - (m.svgW * 200) / 600)).toBeLessThanOrEqual(1);
    expect(m.scrollW).toBeLessThanOrEqual(m.clientW);
    expect(m.scrollbar).toBe(0);
    expect(m.minHeight).toBeGreaterThanOrEqual(9);
    expect([m.role, m.tabindex, m.tabIndex]).toEqual([null, null, -1]);
    expect(await tabFromViews(page)).toBe(false);
  });

  test("760: past the column it draws at its floor and scrolls in a focusable named region", async ({ page }) => {
    await openFit(page, 760);
    await expect.poll(async () => (await pictureBox(page)).tabIndex).toBe(0);
    const m = await pictureBox(page);
    expect(m.clientW).toBeLessThan(FIT_FLOOR);
    expect(Math.round(m.svgW)).toBe(FIT_FLOOR);
    expect(m.scrollW).toBeGreaterThan(m.clientW);
    expect(m.scrollbar).toBe(10);
    // Drawn at its floor, the 12 px labels are 8.5 px: at least 9 px tall.
    expect(m.minHeight).toBeGreaterThanOrEqual(9);
    expect(m.role).toBe("region");
    expect(m.name).toBe("Fit map (drawing)");
    expect(m.pageScroll).toBeLessThanOrEqual(0);
    expect(await tabFromViews(page)).toBe(true);
    await expectFocusRing(page, fitBox(page));
  });

  test("resizing the window across the floor makes the picture a tab stop and takes it back", async ({ page }) => {
    await openFit(page, 1280);
    const stop = async () => {
      const m = await pictureBox(page);
      return { scrolls: m.scrollW > m.clientW, tabIndex: m.tabIndex, role: m.role };
    };
    await expect.poll(stop).toEqual({ scrolls: false, tabIndex: -1, role: null });
    await page.setViewportSize({ width: 760, height: 900 });
    await expect.poll(stop).toEqual({ scrolls: true, tabIndex: 0, role: "region" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(stop).toEqual({ scrolls: false, tabIndex: -1, role: null });
  });

  test("at the floor's boundary: one px narrower scrolls, the floor and one px wider do not", async ({ page }) => {
    await openFit(page, 1280);
    const at = async (w: number) => {
      await fitBox(page).evaluate((el, px) => (el.style.width = `${px}px`), w);
      await expect
        .poll(async () => {
          const m = await pictureBox(page);
          return m.clientW === w ? { scrolls: m.scrollW > m.clientW, tabIndex: m.tabIndex } : "resizing";
        })
        .toEqual(w < FIT_FLOOR ? { scrolls: true, tabIndex: 0 } : { scrolls: false, tabIndex: -1 });
    };
    await at(FIT_FLOOR - 1);
    await at(FIT_FLOOR);
    await at(FIT_FLOOR + 1);
    await at(FIT_FLOOR - 1);
  });
});

/**
 * The picture box's keyboard stop across its state space (the table on
 * `syncDiagramStop`, wiki-visuals.ts): one test per row Chromium can reach.
 * The fit drawing's floor (425 px) sits between the 760 px window's column and
 * the 1280 px one's; 700 and 1200 are a second width on each side.
 */
test.describe("Wiki reader: a Diagram picture's keyboard stop across its states", () => {
  const SCROLLS = 760;
  const SCROLLS_TOO = 700;
  const FITS = 1280;
  const FITS_TOO = 1200;
  const NAME = "Fit map (drawing)";
  const STOP = { role: "region", label: NAME, tabindex: "0" };
  const NONE = { role: null, label: null, tabindex: null };

  async function openFocus(page: Page, width: number): Promise<void> {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(FOCUS_REL)}`);
    await expect(page.locator(".wiki-article figure.dgm .dgm-svg svg")).toHaveCount(2);
  }
  const topBox = (page: Page) => page.locator(".wiki-article figure.dgm .dgm-svg").first();
  const foldBox = (page: Page) => page.locator(".wiki-article details.fold .dgm-svg");
  const fold = (page: Page) => page.locator(".wiki-article details.fold");
  /** The box's stop attributes, whether it scrolls, and where focus is. */
  const stateOf = (box: ReturnType<Page["locator"]>) =>
    box.evaluate((el: HTMLElement) => ({
      scrolls: el.scrollWidth > el.clientWidth,
      role: el.getAttribute("role"),
      label: el.getAttribute("aria-label"),
      tabindex: el.getAttribute("tabindex"),
      focused: document.activeElement === el,
    }));
  /** Two frames: a ResizeObserver delivers before the next paint, so by then it ran. */
  const settle = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  const resize = async (page: Page, width: number) => {
    await page.setViewportSize({ width, height: 900 });
    await settle(page);
  };
  /** Tab from the top figure's last view button into its picture. */
  const tabIn = async (page: Page) => {
    await page.locator(".wiki-article figure.dgm .dgm-view").first().locator("xpath=..").locator("button").last().focus();
    await page.keyboard.press("Tab");
    await expect.poll(() => stateOf(topBox(page))).toMatchObject({ focused: true });
  };
  /** Where focus is: its tag, and its class when it has one. */
  const active = (page: Page) =>
    page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return "BODY";
      return [a.tagName, a.getAttribute("class")].filter(Boolean).join(".");
    });
  const heading = (page: Page) => page.locator("#articleWrap .wiki-article-head h1");

  // Rows 1–4: focus elsewhere. The stop follows the scroll state.
  test("row 1, fits → fits, focus elsewhere: no stop before or after", async ({ page }) => {
    await openFocus(page, FITS);
    await expect.poll(() => stateOf(topBox(page))).toEqual({ scrolls: false, ...NONE, focused: false });
    await resize(page, FITS_TOO);
    expect(await stateOf(topBox(page))).toEqual({ scrolls: false, ...NONE, focused: false });
  });

  test("row 2, fits → scrolls, focus elsewhere: it becomes the stop", async ({ page }) => {
    await openFocus(page, FITS);
    await expect.poll(() => stateOf(topBox(page))).toEqual({ scrolls: false, ...NONE, focused: false });
    await resize(page, SCROLLS);
    await expect.poll(() => stateOf(topBox(page))).toEqual({ scrolls: true, ...STOP, focused: false });
  });

  test("row 3, scrolls → scrolls, focus elsewhere: the stop stays", async ({ page }) => {
    await openFocus(page, SCROLLS);
    await expect.poll(() => stateOf(topBox(page))).toEqual({ scrolls: true, ...STOP, focused: false });
    await resize(page, SCROLLS_TOO);
    expect(await stateOf(topBox(page))).toEqual({ scrolls: true, ...STOP, focused: false });
  });

  test("row 4, scrolls → fits, focus elsewhere: the stop goes", async ({ page }) => {
    await openFocus(page, SCROLLS);
    await expect.poll(() => stateOf(topBox(page))).toEqual({ scrolls: true, ...STOP, focused: false });
    await resize(page, FITS);
    await expect.poll(() => stateOf(topBox(page))).toEqual({ scrolls: false, ...NONE, focused: false });
  });

  // Rows 5–8: focus on the box. It keeps the stop until focus leaves.
  test("row 5, scrolls → fits, focus on the box: focus stays and so does the stop, until blur", async ({ page }) => {
    await openFocus(page, SCROLLS);
    await tabIn(page);
    await resize(page, FITS);
    await expect.poll(() => stateOf(topBox(page))).toMatchObject({ scrolls: false });
    expect(await active(page)).toBe("DIV.dgm-svg");
    expect(await stateOf(topBox(page))).toEqual({ scrolls: false, ...STOP, focused: true });
    // Focus leaves: the fit state applies, and Shift+Tab no longer lands on it.
    await page.keyboard.press("Tab");
    await expect.poll(() => stateOf(topBox(page))).toEqual({ scrolls: false, ...NONE, focused: false });
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => document.activeElement?.classList.contains("dgm-view") ?? false)).toBe(true);
  });

  test("row 6, fits → fits with the stop kept, focus on the box: still kept until blur", async ({ page }) => {
    await openFocus(page, SCROLLS);
    await tabIn(page);
    await resize(page, FITS);
    await expect.poll(() => stateOf(topBox(page))).toEqual({ scrolls: false, ...STOP, focused: true });
    await resize(page, FITS_TOO);
    expect(await stateOf(topBox(page))).toEqual({ scrolls: false, ...STOP, focused: true });
    await heading(page).click();
    await expect.poll(() => stateOf(topBox(page))).toEqual({ scrolls: false, ...NONE, focused: false });
  });

  test("row 7, fits with the stop kept → scrolls, focus on the box: the stop stays after blur", async ({ page }) => {
    await openFocus(page, SCROLLS);
    await tabIn(page);
    await resize(page, FITS);
    await expect.poll(() => stateOf(topBox(page))).toEqual({ scrolls: false, ...STOP, focused: true });
    await resize(page, SCROLLS);
    await expect.poll(() => stateOf(topBox(page))).toEqual({ scrolls: true, ...STOP, focused: true });
    await page.keyboard.press("Tab");
    await expect.poll(() => stateOf(topBox(page))).toEqual({ scrolls: true, ...STOP, focused: false });
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => stateOf(topBox(page))).toEqual({ scrolls: true, ...STOP, focused: true });
  });

  test("row 8, scrolls → scrolls, focus on the box: focus and the stop stay", async ({ page }) => {
    await openFocus(page, SCROLLS);
    await tabIn(page);
    await resize(page, SCROLLS_TOO);
    expect(await stateOf(topBox(page))).toEqual({ scrolls: true, ...STOP, focused: true });
  });

  // Rows 9–10: unreachable focus. The test proves why.
  test("row 9, a fitting box that never scrolled takes no focus, by script or by click", async ({ page }) => {
    await openFocus(page, FITS);
    await expect.poll(() => stateOf(topBox(page))).toEqual({ scrolls: false, ...NONE, focused: false });
    await topBox(page).evaluate((el: HTMLElement) => el.focus());
    await topBox(page).click();
    expect((await stateOf(topBox(page))).focused).toBe(false);
  });

  test("row 10, nothing inside the box takes focus: the sanitizer keeps no link, tabindex or embedded content", async ({ page }) => {
    for (const width of [SCROLLS, FITS]) {
      await openFocus(page, width);
      if (width === SCROLLS) await tabIn(page);
      const took = await topBox(page).evaluate((box: HTMLElement) => {
        const before = document.activeElement;
        const els = Array.from(box.querySelectorAll<HTMLElement | SVGElement>("*"));
        const hits = els.filter((el) => {
          el.focus();
          return document.activeElement === el;
        });
        return { count: els.length, hits: hits.map((h) => h.tagName), same: document.activeElement === before };
      });
      expect(took.count).toBeGreaterThan(5);
      expect(took.hits).toEqual([]);
      expect(took.same).toBe(true);
    }
  });

  // Rows 11–13: a <Fold> hides and shows the box.
  test("row 11, fold opened and closed, focus elsewhere: closed it takes no focus; opened, the stop follows the scroll state", async ({ page }) => {
    /** Whether the box takes focus from a script (a closed fold's content does not). */
    const takes = () => foldBox(page).evaluate((el: HTMLElement) => (el.focus(), document.activeElement === el));
    await openFocus(page, SCROLLS);
    expect(await takes()).toBe(false);
    await fold(page).locator("summary").click();
    await expect.poll(() => stateOf(foldBox(page))).toEqual({ scrolls: true, ...STOP, focused: false });
    await fold(page).locator("summary").click();
    await settle(page);
    expect(await takes()).toBe(false);
    await resize(page, FITS);
    await fold(page).locator("summary").click();
    await expect.poll(() => stateOf(foldBox(page))).toMatchObject({ scrolls: false });
    await settle(page);
    expect(await stateOf(foldBox(page))).toEqual({ scrolls: false, ...NONE, focused: false });
  });

  test("row 12, fold closed while the box has focus: the browser moves focus, as for a button in the fold; reopened, the stop is right", async ({ page }) => {
    await openFocus(page, SCROLLS);
    await fold(page).locator("summary").click();
    await expect.poll(() => stateOf(foldBox(page))).toMatchObject({ scrolls: true, tabindex: "0" });
    // Only a script closes a fold without moving focus first: the summary takes focus on a click or a key.
    await foldBox(page).focus();
    await fold(page).evaluate((d: HTMLDetailsElement) => (d.open = false));
    await settle(page);
    const lostTo = await active(page);
    // The same close with a view button of the folded figure focused.
    await fold(page).evaluate((d: HTMLDetailsElement) => (d.open = true));
    await fold(page).locator(".dgm-view").last().focus();
    await fold(page).evaluate((d: HTMLDetailsElement) => (d.open = false));
    await settle(page);
    expect(lostTo).toBe(await active(page));
    await fold(page).evaluate((d: HTMLDetailsElement) => (d.open = true));
    await expect.poll(() => stateOf(foldBox(page))).toEqual({ scrolls: true, ...STOP, focused: false });
  });

  test("row 13, fold resized while closed: reopened, the stop matches the new width", async ({ page }) => {
    await openFocus(page, SCROLLS);
    await resize(page, FITS);
    await fold(page).locator("summary").click();
    await expect.poll(() => stateOf(foldBox(page))).toMatchObject({ scrolls: false });
    await settle(page);
    expect(await stateOf(foldBox(page))).toEqual({ scrolls: false, ...NONE, focused: false });
    await fold(page).locator("summary").click();
    await resize(page, SCROLLS);
    await fold(page).locator("summary").click();
    await expect.poll(() => stateOf(foldBox(page))).toEqual({ scrolls: true, ...STOP, focused: false });
  });

  // Rows 14–16: the article is replaced.
  /** Click a wikilink by script, so focus stays where it was until the render. */
  const follow = async (page: Page, text: string, heading: string) => {
    await page.locator(".wiki-article").evaluate((a) => ((a as HTMLElement & { __old?: boolean }).__old = true));
    await page.locator(".wiki-article a", { hasText: text }).first().evaluate((a: HTMLAnchorElement) => a.click());
    await expect.poll(() => page.locator(".wiki-article").evaluate((a) => !(a as HTMLElement & { __old?: boolean }).__old)).toBe(true);
    await expect(page.locator("#articleWrap .wiki-article-head h1")).toHaveText(heading);
  };

  test("row 14, the article re-renders while the box has focus: focus goes where it goes for any focused control in the article", async ({ page }) => {
    await openFocus(page, SCROLLS);
    await tabIn(page);
    await follow(page, "focus", "Focus");
    const fromBox = await active(page);
    await page.locator(".wiki-article figure.dgm .dgm-view").last().focus();
    await follow(page, "focus", "Focus");
    expect(fromBox).toBe(await active(page));
    expect(fromBox).toBe("BODY");
    await expect.poll(() => stateOf(topBox(page))).toEqual({ scrolls: true, ...STOP, focused: false });
  });

  test("row 15, navigating away while the box has focus: the same as any focused control", async ({ page }) => {
    await openFocus(page, SCROLLS);
    await tabIn(page);
    await follow(page, "wide", "Wide");
    const fromBox = await active(page);
    await openFocus(page, SCROLLS);
    await page.locator(".wiki-article figure.dgm .dgm-view").last().focus();
    await follow(page, "wide", "Wide");
    expect(fromBox).toBe(await active(page));
    expect(fromBox).toBe("BODY");
  });

  test("row 16, an article replaced without a new render (the Ask answer) leaves no detached box observed", async ({ page }) => {
    // Count what every ResizeObserver on the page watches.
    await page.addInitScript(() => {
      const Native = window.ResizeObserver;
      const watched: Set<Element>[] = [];
      (window as unknown as { __watched: () => Element[] }).__watched = () => watched.flatMap((s) => [...s]);
      window.ResizeObserver = class extends Native {
        private seen = new Set<Element>();
        constructor(cb: ResizeObserverCallback) {
          super(cb);
          watched.push(this.seen);
        }
        override observe(t: Element, o?: ResizeObserverOptions) {
          this.seen.add(t);
          super.observe(t, o);
        }
        override unobserve(t: Element) {
          this.seen.delete(t);
          super.unobserve(t);
        }
        override disconnect() {
          this.seen.clear();
          super.disconnect();
        }
      };
    });
    await openFocus(page, SCROLLS);
    const boxes = () =>
      page.evaluate(() =>
        (window as unknown as { __watched: () => Element[] }).__watched().filter((e) => e.classList.contains("dgm-svg")).map((e) => e.isConnected),
      );
    await expect.poll(boxes).toEqual([true, true]);
    await page.evaluate(() => (document.getElementById("articleWrap")!.innerHTML = "<p>An answer.</p>"));
    await expect.poll(boxes).toEqual([]);
  });
});
