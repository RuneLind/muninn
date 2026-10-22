/**
 * `<Steps src="./x.lifecycle.json">` on the /wiki reader: the same archify
 * picture a `<Diagram>` draws, stepped through by an authored list (each item's
 * trailing code span names its focus ids) or, with no list, by the file's views
 * (`src/format/steps-block.ts`, client in `wiki-visuals.ts`).
 *
 * What only a laid-out page can answer: Prev, Next, Play and Show all dim the
 * right nodes and edges per step (archify's guided-view rule: a node outside
 * the focus dims, an edge dims unless both ends are in focus, the main rail
 * never dims), by mouse and by keyboard, in both themes; the current step is
 * marked; a Steps and a Diagram over one file keep every id unique.
 *
 * No model calls, no DB rows: one muninn over a temp wiki holding one
 * synthetic page and one hand-written archify-shaped lifecycle (no live corpus).
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-steps");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-steps";
const REL = "flows/case.mdx";

const node = (id: string, x: number) =>
  `<g data-node-id="${id}"><rect x="${x}" y="60" width="100" height="50" rx="6" class="c-backend"/>` +
  `<text x="${x + 50}" y="90" text-anchor="middle" class="t-primary">${id}</text></g>`;
const edge = (from: string, to: string, x1: number, x2: number) =>
  `<path d="M ${x1} 85 L ${x2} 85" class="a-default" marker-end="url(#arrowhead)" data-edge-from="${from}" data-edge-to="${to}"/>`;
// The main rail: one bare `a-emphasis` path, as archify draws it.
const HTML =
  `<!doctype html><html><head><title>x</title></head><body>` +
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 200" role="img">` +
  `<title id="archify-diagram-title">T</title><defs><marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" class="m-default"/></marker></defs>` +
  `<path d="M 10 30 L 790 30" class="a-emphasis" marker-end="url(#arrowhead)"/>` +
  node("opened", 20) + node("basis", 220) + node("assessed", 420) + node("decided", 620) +
  edge("opened", "basis", 120, 218) + edge("basis", "assessed", 320, 418) + edge("assessed", "decided", 520, 618) +
  `</svg></body></html>`;
const JSON_FILE = {
  meta: {
    title: "Case life",
    views: [
      { id: "start", label: "Start", focus: ["opened"], note: "The case opens." },
      { id: "end", label: "End", focus: ["assessed", "decided"] },
      // A typo: no node has this id, so the view dims nothing.
      { id: "typo", label: "Typo", focus: ["nope"] },
    ],
  },
  lanes: [{ id: "main", label: "Main" }],
  states: ["opened", "basis", "assessed", "decided"].map((id, i) => ({ id, label: id, lane: "main", col: i + 1 })),
  transitions: [
    { from: "opened", to: "basis" },
    { from: "basis", to: "assessed" },
    { from: "assessed", to: "decided" },
  ],
};
/** A step long enough to wrap the caption over several lines at any width. */
const LONG_STEP =
  "The case is assessed against every rule that applies to the person's situation, which takes in the country of work, " +
  "the country of residence, the seat of the employer, the length of the posting, any agreement between the countries " +
  "involved, and whether an earlier decision still holds for the period the case covers";
const PAGE = [
  "---",
  "title: Case",
  "---",
  "",
  "# Case",
  "",
  "See «Authored» for the steps.",
  "",
  "## Authored",
  "",
  '<Steps src="./case.lifecycle.json">',
  "",
  "1. The case opens `opened`",
  "2. The basis is **fetched** `opened`, `basis`",
  "",
  "   - a nested point",
  "   - another point",
  "",
  "   ```",
  "   fetchBasis()",
  "   ```",
  "",
  `3. ${LONG_STEP} \`basis, assessed\``,
  "4. A step naming nothing drawn `missing`",
  "",
  "</Steps>",
  "",
  "## From views",
  "",
  '<Steps src="./case.lifecycle.json" />',
  "",
  "## Diagram",
  "",
  '<Diagram src="./case.lifecycle.json" />',
  "",
  "## One step",
  "",
  '<Steps src="./case.lifecycle.json">',
  "",
  "1. The only step",
  "",
  "   Its focus ends the second paragraph `decided`",
  "",
  "</Steps>",
  "",
].join("\n");

// A picture taller than the 1000 px viewport (an archify lifecycle renders
// ~850 px), one node near its top, one in the middle, one near its foot.
const TALL_REL = "flows/tall.mdx";
const TALL_HTML =
  `<!doctype html><html><head><title>x</title></head><body>` +
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 2900" role="img"><title>T</title>` +
  [["top", 100], ["mid", 1400], ["bot", 2700]]
    .map(([id, y]) => `<g data-node-id="${id}"><rect x="300" y="${y}" width="200" height="80" class="c-backend"/><text x="400" y="${Number(y) + 45}" text-anchor="middle" class="t-primary">${id}</text></g>`)
    .join("") +
  `</svg></body></html>`;
const TALL_JSON = {
  meta: { title: "Tall" },
  lanes: [{ id: "main", label: "Main" }],
  states: ["top", "mid", "bot"].map((id, i) => ({ id, label: id, lane: "main", col: i + 1 })),
  transitions: [],
};
const TALL_PAGE = [
  "---",
  "title: Tall",
  "---",
  "",
  "# Tall",
  "",
  '<Steps src="./tall.lifecycle.json">',
  "",
  "1. The top node `top`",
  "2. The middle node `mid`",
  "3. The bottom node `bot`",
  "",
  "</Steps>",
  "",
  "## In a callout",
  "",
  '<Callout tone="warn" title="Steps in a callout">',
  "",
  '<Steps src="./case.lifecycle.json">',
  "",
  "1. Opens `opened`",
  "2. Basis `basis`",
  "",
  "</Steps>",
  "",
  "</Callout>",
  "",
  "## Folded",
  "",
  '<Fold title="Folded steps" open="true">',
  "",
  '<Steps src="./case.lifecycle.json">',
  "",
  "1. Opens `opened`",
  "2. Basis `basis`",
  "3. Assessed `assessed`",
  "",
  "</Steps>",
  "",
  "</Fold>",
  "",
].join("\n");

const ALL_EDGES = ["opened>basis", "basis>assessed", "assessed>decided"];
/** The dim set each authored step must leave, in order. */
const STEP_DIMS = [
  ["assessed", "basis", "decided", ...ALL_EDGES].sort(),
  ["assessed", "decided", "basis>assessed", "assessed>decided"].sort(),
  ["decided", "opened", "opened>basis", "assessed>decided"].sort(),
  // Only an id the picture does not draw: the reader drops it, and the step dims nothing.
  [],
];

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-steps-"));
  await mkdir(path.join(root, "flows"), { recursive: true });
  await writeFile(path.join(root, REL), PAGE, "utf8");
  await writeFile(path.join(root, "flows", "case.lifecycle.json"), JSON.stringify(JSON_FILE), "utf8");
  await writeFile(path.join(root, "flows", "case.html"), HTML, "utf8");
  await writeFile(path.join(root, TALL_REL), TALL_PAGE, "utf8");
  await writeFile(path.join(root, "flows", "tall.lifecycle.json"), JSON.stringify(TALL_JSON), "utf8");
  await writeFile(path.join(root, "flows", "tall.html"), TALL_HTML, "utf8");
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
  await expect(page.locator(".wiki-article section.stp")).toHaveCount(3);
  await expect(page.locator(".wiki-article .dgm-svg svg")).toHaveCount(4);
}

const steps = (page: Page, n: number) => page.locator(".wiki-article section.stp").nth(n);
const dimmed = (sec: Locator) =>
  sec.locator(".dgm-svg .dgm-dim").evaluateAll((els) => els.map((e) => e.getAttribute("data-node-id") ?? `${e.getAttribute("data-edge-from")}>${e.getAttribute("data-edge-to")}`).sort());
const current = (sec: Locator) => sec.locator('li.stp-step[aria-current="step"]').getAttribute("data-stp-i");
/** The block's one live region (the position line and the caption). */
const live = (sec: Locator) => sec.locator(".stp-ctrl [aria-live]");
/** Whether `loc` lies wholly inside the reader's scrolled pane and the window. */
const inView = (loc: Locator) =>
  loc.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const w = document.querySelector("#articleWrap")!.getBoundingClientRect();
    const top = Math.max(0, w.top);
    const bottom = Math.min(window.innerHeight, w.bottom);
    return r.height > 0 && r.top >= top - 1 && r.bottom <= bottom + 1;
  });

test.describe("Wiki reader: Steps", () => {
  for (const scheme of ["dark", "light"] as const) {
    test(`${scheme}: Next/Prev/Show all by mouse dim each step's set; the rail never dims; ids stay unique`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      const sec = steps(page, 0);
      expect(await dimmed(sec)).toEqual([]);
      await expect(sec.locator(".stp-pos")).toHaveText("4 steps");
      // A named group of separate tab stops, not an ARIA toolbar (which promises arrow-key focus moves).
      await expect(sec.locator(".stp-ctrl")).toHaveAttribute("role", "group");
      await expect(sec.locator(".stp-ctrl")).toHaveAttribute("aria-label", "Steps: Case life");
      const prev = sec.locator('button[data-stp-act="prev"]');
      const next = sec.locator('button[data-stp-act="next"]');
      const cap = sec.locator(".stp-ctrl .stp-cap");
      // At rest both go somewhere (first/last step): neither is disabled.
      for (const b of [prev, next]) await expect(b).not.toHaveAttribute("aria-disabled", "true");
      await expect(cap).toHaveText("All steps shown.");
      // The step's own first paragraph as a reader sees it: no nested list, no
      // fence (nor its Copy label), no trailing focus ids.
      const capText = ["The case opens", "The basis is fetched", LONG_STEP, "A step naming nothing drawn"];
      for (let k = 0; k < STEP_DIMS.length; k++) {
        await next.click();
        expect(await dimmed(sec)).toEqual(STEP_DIMS[k]);
        expect(await current(sec)).toBe(String(k));
        await expect(sec.locator(".stp-pos")).toHaveText(`Step ${k + 1} of 4`);
        await expect.soft(cap).toHaveText(capText[k]!);
        await expect.soft(cap).toHaveAttribute("title", capText[k]!);
        await expect(prev).toHaveAttribute("aria-disabled", String(k === 0));
        await expect(next).toHaveAttribute("aria-disabled", String(k === 3));
        expect(await sec.locator(".dgm-svg path.a-emphasis.dgm-dim").count()).toBe(0);
      }
      // Next stops at the last step: disabled there, a press does nothing.
      await next.click({ force: true });
      expect(await current(sec)).toBe("3");
      await sec.locator('button[data-stp-act="prev"]').click();
      expect(await dimmed(sec)).toEqual(STEP_DIMS[2]);
      await sec.locator('button[data-stp-act="all"]').click();
      expect(await dimmed(sec)).toEqual([]);
      // Show all is a plain button: the caption says the state, no aria-pressed promises a toggle.
      await expect(sec.locator('button[data-stp-act="all"]')).not.toHaveAttribute("aria-pressed", /.*/);
      await expect(cap).toHaveText("All steps shown.");
      for (const b of [prev, next]) await expect(b).not.toHaveAttribute("aria-disabled", "true");
      expect(await sec.locator('li.stp-step[aria-current]').count()).toBe(0);
      // The current step is visibly marked, and a dimmed node really fades.
      await sec.locator('button[data-stp-act="next"]').click();
      const cur = sec.locator("li.stp-step.stp-cur");
      await expect(cur).toHaveCount(1);
      expect(await cur.evaluate((e) => getComputedStyle(e).boxShadow)).not.toBe("none");
      const basis = sec.locator('.dgm-svg [data-node-id="basis"]');
      await expect.poll(async () => Number(await basis.evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(0.5);
      // Two Steps and a Diagram over one file: every id unique.
      const ids = await page.evaluate(() => Array.from(document.querySelectorAll(".wiki-article [id]")).map((e) => e.id));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(expect.arrayContaining(["dgm1-arrowhead", "dgm2-arrowhead", "dgm3-arrowhead"]));
    });

    test(`${scheme}: the controls work by keyboard: Enter, Space and the arrow keys`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      const sec = steps(page, 0);
      await sec.locator('button[data-stp-act="next"]').focus();
      await page.keyboard.press("Enter");
      expect(await dimmed(sec)).toEqual(STEP_DIMS[0]);
      await page.keyboard.press(" ");
      expect(await dimmed(sec)).toEqual(STEP_DIMS[1]);
      await page.keyboard.press("ArrowRight");
      expect(await dimmed(sec)).toEqual(STEP_DIMS[2]);
      await page.keyboard.press("ArrowLeft");
      expect(await dimmed(sec)).toEqual(STEP_DIMS[1]);
      await page.keyboard.press("Tab"); // → Play
      await page.keyboard.press("Tab"); // → Show all
      await expect(sec.locator('button[data-stp-act="all"]')).toBeFocused();
      await page.keyboard.press("Enter");
      expect(await dimmed(sec)).toEqual([]);
    });
  }

  test("Play walks the steps and stops at the end; pressing it again stops", async ({ page }) => {
    await open(page);
    const sec = steps(page, 0);
    const play = sec.locator('button[data-stp-act="play"]');
    await expect(live(sec)).toHaveCount(1);
    await expect(live(sec)).toHaveAttribute("aria-live", "polite");
    await play.click();
    await expect(play).toHaveAttribute("aria-pressed", "true");
    // Play's ticks are not announced; only a step the reader picks is.
    await expect(live(sec)).toHaveAttribute("aria-live", "off");
    expect(await current(sec)).toBe("0");
    // Prev is disabled on the first step: pressing it does nothing, so Play runs on.
    const prev = sec.locator('button[data-stp-act="prev"]');
    await expect(prev).toHaveAttribute("aria-disabled", "true");
    await prev.click({ force: true });
    await expect(play).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => current(sec), { timeout: 5_000 }).toBe("1");
    expect(await dimmed(sec)).toEqual(STEP_DIMS[1]);
    await play.click();
    await expect(play).toHaveAttribute("aria-pressed", "false");
    await expect(live(sec)).toHaveAttribute("aria-live", "polite");
    await page.waitForTimeout(2_500);
    expect(await current(sec)).toBe("1");
  });

  test("Play releases on the tick that shows the last step and stays there; Play from the last step starts over", async ({ page }) => {
    await open(page);
    const sec = steps(page, 0);
    const play = sec.locator('button[data-stp-act="play"]');
    await play.click();
    await expect.poll(() => current(sec), { timeout: 8_000, intervals: [50] }).toBe("3");
    // Released with the last step, not one interval (2 s) later.
    await expect(play).toHaveAttribute("aria-pressed", "false", { timeout: 500 });
    await page.waitForTimeout(2_500);
    expect(await current(sec)).toBe("3");
    await expect(sec.locator(".stp-pos")).toHaveText("Step 4 of 4");
    await play.click();
    expect(await current(sec)).toBe("0");
    await expect(play).toHaveAttribute("aria-pressed", "true");
    await sec.locator('button[data-stp-act="all"]').click();
    await expect(play).toHaveAttribute("aria-pressed", "false");
  });

  test("a peek of a stepped block shows it at rest: no current step, nothing dimmed", async ({ page }) => {
    await open(page);
    const sec = steps(page, 0);
    await sec.locator('button[data-stp-act="next"]').click();
    await sec.locator('button[data-stp-act="next"]').click();
    await expect(sec.locator("li.stp-step.stp-cur")).toHaveCount(1);
    await page.locator(".wiki-article a.wiki-ref", { hasText: "Authored" }).first().hover();
    const peek = page.locator(".wiki-ref-peek");
    await expect(peek).toBeVisible();
    await expect(peek.locator("li.stp-step")).toHaveCount(4);
    await expect(peek.locator(".stp-cur, [aria-current], .dgm-dim, .stp-ctrl")).toHaveCount(0);
    expect(await peek.locator("li.stp-step").evaluateAll((els) => els.map((e) => getComputedStyle(e).boxShadow))).toEqual(["none", "none", "none", "none"]);
  });

  test("a Diagram view naming only an id the picture does not draw dims nothing", async ({ page }) => {
    await open(page);
    const fig = page.locator(".wiki-article figure.dgm").filter({ has: page.locator("button[data-dgm-view]") });
    await expect(fig).toHaveCount(1);
    await fig.locator('button[data-dgm-view="start"]').click();
    expect(await dimmed(fig)).toEqual(STEP_DIMS[0]);
    await fig.locator('button[data-dgm-view="typo"]').click();
    expect(await dimmed(fig)).toEqual([]);
  });

  test("one step: «1 step» at rest, and the focus from the item's second paragraph", async ({ page }) => {
    await open(page);
    const sec = steps(page, 2);
    await expect(sec.locator(".stp-pos")).toHaveText("1 step");
    await sec.locator('button[data-stp-act="next"]').click();
    await expect(sec.locator(".stp-pos")).toHaveText("Step 1 of 1");
    expect(await dimmed(sec)).toEqual(["assessed", "basis", "opened", ...ALL_EDGES].sort());
    await sec.locator('button[data-stp-act="all"]').click();
    await expect(sec.locator(".stp-pos")).toHaveText("1 step");
  });

  test("Play on a one-step block shows the step and leaves the live line on", async ({ page }) => {
    await open(page);
    const sec = steps(page, 2);
    await sec.locator('button[data-stp-act="play"]').click();
    await expect(sec.locator(".stp-pos")).toHaveText("Step 1 of 1");
    await expect(sec.locator('button[data-stp-act="play"]')).toHaveAttribute("aria-pressed", "false");
    await expect(live(sec)).toHaveAttribute("aria-live", "polite");
  });

  for (const width of [1280, 360]) {
    test(`${width} px: a long step's caption takes at most one line more than the rest caption`, async ({ page }) => {
      await open(page);
      await page.setViewportSize({ width, height: 900 });
      const sec = steps(page, 0);
      const ctrl = sec.locator(".stp-ctrl");
      const h = (loc: Locator) => loc.evaluate((e) => e.getBoundingClientRect().height);
      const restBar = await h(ctrl);
      const restLine = await h(sec.locator(".stp-now"));
      for (let k = 0; k < 3; k++) await sec.locator('button[data-stp-act="next"]').click();
      await expect(sec.locator(".stp-pos")).toHaveText("Step 3 of 4");
      expect(await h(ctrl)).toBeLessThanOrEqual(restBar + restLine + 2);
      // Two lines at most, whatever the width.
      const now = sec.locator(".stp-now");
      const line = await now.evaluate((e) => parseFloat(getComputedStyle(e).lineHeight));
      expect(await h(now)).toBeLessThanOrEqual(2 * line + 1);
      await expect(sec.locator(".stp-ctrl .stp-cap")).toHaveText(LONG_STEP);
    });
  }

  for (const scheme of ["dark", "light"] as const) {
    test(`${scheme}: the stuck bar takes its container's surface: the article, a Fold, a Callout`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(TALL_REL)}`);
      await expect(page.locator(".wiki-article section.stp")).toHaveCount(3);
      /** The bar's paint, and the first opaque ancestor fill above the block. */
      const paint = (sec: Locator) =>
        sec.locator(".stp-ctrl").evaluate((bar) => {
          const cs = getComputedStyle(bar);
          let e = bar.parentElement!.parentElement;
          while (e && /rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(e).backgroundColor)) e = e.parentElement;
          return { color: cs.backgroundColor, image: cs.backgroundImage, ground: e ? getComputedStyle(e).backgroundColor : "" };
        });
      const article = await paint(page.locator(".wiki-article section.stp").first());
      expect(article.color).toBe(article.ground);
      expect(article.image).toBe("none");
      const folded = await paint(page.locator(".wiki-article details.fold section.stp"));
      const foldFill = await page.locator(".wiki-article details.fold").evaluate((e) => getComputedStyle(e).backgroundColor);
      expect(folded.color).toBe(foldFill);
      expect(folded.color).not.toBe(article.color);
      // A callout's fill is a tint over what it sits on: the bar paints the tint
      // over that ground, so it is opaque and the callout's own colour.
      const callout = page.locator(".wiki-article .callout");
      const inCallout = await paint(callout.locator("section.stp"));
      const tint = await callout.evaluate((e) => getComputedStyle(e).backgroundColor);
      // The callout keeps its tone's fill (warn here), the bar's tint with it.
      const warnFill = await callout.evaluate((e) => {
        const probe = e.appendChild(document.createElement("i"));
        probe.style.background = "color-mix(in srgb, var(--status-warning) 14%, transparent)";
        const c = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return c;
      });
      expect(tint).toBe(warnFill);
      expect(inCallout.color).toBe(article.color);
      expect(inCallout.image).toContain(tint);
    });
  }

  for (const scheme of ["dark", "light"] as const) {
    test(`${scheme}: with no list, the steps are the file's views`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      const sec = steps(page, 1);
      await expect(sec.locator("li.stp-step")).toHaveCount(3);
      await expect(sec.locator("li.stp-step").first()).toContainText("Start — The case opens.");
      await sec.locator('button[data-stp-act="next"]').click();
      expect(await dimmed(sec)).toEqual(STEP_DIMS[0]);
      await sec.locator('button[data-stp-act="next"]').click();
      expect(await dimmed(sec)).toEqual(["basis", "opened", "opened>basis", "basis>assessed"].sort());
      await sec.locator('button[data-stp-act="next"]').click();
      expect(await dimmed(sec)).toEqual([]);
      // The authored block above is untouched by this one.
      expect(await dimmed(steps(page, 0))).toEqual([]);
    });
  }
  test("a picture taller than the window: after Next the toolbar, the caption and the newly lit node are all in view", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(TALL_REL)}`);
    const sec = page.locator(".wiki-article section.stp").first();
    await expect(sec.locator(".dgm-svg svg")).toHaveCount(1);
    expect((await sec.locator(".dgm-svg svg").boundingBox())!.height).toBeGreaterThan(1500);
    await sec.locator('button[data-stp-act="next"]').click();
    const mid = sec.locator('.dgm-svg [data-node-id="mid"]');
    await expect(mid).toHaveClass(/dgm-dim/);
    // The reader scrolls down to the middle of the picture: the toolbar stays with it.
    await mid.evaluate((e) => e.scrollIntoView({ block: "center" }));
    expect(await inView(sec.locator(".stp-ctrl"))).toBe(true);
    await sec.locator('button[data-stp-act="next"]').click();
    await expect(mid).not.toHaveClass(/dgm-dim/);
    expect(await inView(sec.locator(".stp-ctrl"))).toBe(true);
    expect(await inView(mid)).toBe(true);
    const cap = sec.locator(".stp-ctrl .stp-cap");
    await expect(cap).toHaveText("The middle node");
    expect(await inView(cap)).toBe(true);
  });

  test("Play stops when its Fold closes, and when the block leaves the view", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(TALL_REL)}`);
    const fold = page.locator(".wiki-article details.fold");
    const sec = fold.locator("section.stp");
    const play = sec.locator('button[data-stp-act="play"]');
    await play.click();
    await expect(play).toHaveAttribute("aria-pressed", "true");
    expect(await current(sec)).toBe("0");
    await fold.locator(":scope > summary").click();
    await expect(fold).not.toHaveAttribute("open", /.*/);
    await expect(play).toHaveAttribute("aria-pressed", "false", { timeout: 1_000 });
    await expect(live(sec)).toHaveAttribute("aria-live", "polite");
    await page.waitForTimeout(2_500);
    expect(await current(sec)).toBe("0");
    // Open again and play, then scroll the block out of the pane.
    await fold.locator(":scope > summary").click();
    await play.click();
    await expect(play).toHaveAttribute("aria-pressed", "true");
    await page.locator("#articleWrap").evaluate((e) => (e.scrollTop = 0));
    expect(await inView(sec)).toBe(false);
    await expect(play).toHaveAttribute("aria-pressed", "false", { timeout: 1_000 });
    await page.waitForTimeout(2_500);
    expect(await current(sec)).toBe("0");
  });
});
