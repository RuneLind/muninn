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
  "4. The top and the bottom `top`, `bot`",
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

// A picture wider than the column: label size 8.5 px draws it at its viewBox
// width (2400 px), so it scrolls in its box at any reader width. `a` sits at
// the left end, `b` across the box's right edge at 1280 px, `c` at the far right.
const WIDE_REL = "flows/wide.mdx";
const wideNode = (id: string, x: number, w = 200) =>
  `<g data-node-id="${id}"><rect x="${x}" y="40" width="${w}" height="60" class="c-backend"/>` +
  `<text x="${x + w / 2}" y="75" font-size="8.5" text-anchor="middle" class="t-primary">${id}</text></g>`;
const WIDE_HTML =
  `<!doctype html><html><head><title>x</title></head><body>` +
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2400 140" role="img"><title>W</title>` +
  wideNode("a", 20) + wideNode("b", 420) + wideNode("c", 2150) +
  `</svg></body></html>`;
const WIDE_JSON = {
  meta: { title: "Wide", views: [{ id: "right", label: "Right", focus: ["c"] }, { id: "left", label: "Left", focus: ["a"] }] },
  lanes: [{ id: "main", label: "Main" }],
  states: ["a", "b", "c"].map((id, i) => ({ id, label: id, lane: "main", col: i + 1 })),
  transitions: [],
};
const WIDE_PAGE = [
  "---",
  "title: Wide",
  "---",
  "",
  "# Wide",
  "",
  '<Steps src="./wide.lifecycle.json">',
  "",
  "1. Left, in view at rest `a`",
  "2. Across the right edge `b`",
  "3. Far right `c`",
  "4. Back to the left `a`",
  "5. Both ends, wider than the box `a`, `c`",
  "6. Only an id the picture does not draw `nope`",
  "",
  "</Steps>",
  "",
  "## Diagram",
  "",
  '<Diagram src="./wide.lifecycle.json" />',
  "",
].join("\n");

// State space B: one Steps per caption row, then a views-derived one.
const CAP_REL = "flows/caption.mdx";
const CAP_ROWS: [string, string][] = [
  ["The case opens `opened`", "The case opens"],
  ["`opened`", "opened"],
  ["`opened`, `basis`", "opened, basis"],
  ["Run `make` then wait `basis`", "Run make then wait"],
  ['Say "hi" & a < b `opened`', 'Say "hi" & a < b'],
  ["Quote &quot;x&quot; &amp; y `opened`", 'Quote "x" & y'],
];
const CAP_PAGE = [
  "---",
  "title: Captions",
  "---",
  "",
  "# Captions",
  "",
  '<Steps src="./case.lifecycle.json">',
  "",
  ...CAP_ROWS.map(([item], k) => `${k + 1}. ${item}`),
  `${CAP_ROWS.length + 1}. Fetch the \`basis\``,
  "",
  "   It ends here `basis`",
  "",
  "</Steps>",
  "",
  "## Views",
  "",
  '<Steps src="./case.lifecycle.json" />',
  "",
].join("\n");
const CAP_WANT = [...CAP_ROWS.map(([, want]) => want), "Fetch the basis"];

// State space C: a Steps in every container that paints a fill and takes a body.
const BOX_REL = "flows/boxes.mdx";
const stepsIn = (open: string[], close: string[]) => [
  ...open.flatMap((o) => [o, ""]),
  '<Steps src="./case.lifecycle.json">',
  "",
  "1. Opens `opened`",
  "",
  "</Steps>",
  "",
  ...close.flatMap((c) => [c, ""]),
];
/** Each row: its label and the container wrapping it, innermost last. */
const BOX_ROWS: [string, string[], string[]][] = [
  ["article", [], []],
  ["Callout", ['<Callout tone="warn" title="c">'], ["</Callout>"]],
  ["Callout in Callout", ['<Callout tone="info" title="outer">', '<Callout tone="bad" title="inner">'], ["</Callout>", "</Callout>"]],
  ["Fold", ['<Fold title="f" open="true">'], ["</Fold>"]],
  ["Fold in Callout", ['<Callout tone="good" title="c">', '<Fold title="f" open="true">'], ["</Fold>", "</Callout>"]],
  ["Callout in Fold", ['<Fold title="f" open="true">', '<Callout tone="info" title="c">'], ["</Callout>", "</Fold>"]],
  ["Question", ['<Question id="Q1">'], ["</Question>"]],
  ["Tldr", ['<Tldr label="Short">'], ["</Tldr>"]],
  ["Callout in Tldr", ['<Tldr label="Short">', '<Callout tone="warn" title="c">'], ["</Callout>", "</Tldr>"]],
  ["Historic", ['<Historic since="2026-01-01" note="old">'], ["</Historic>"]],
  ["Figure", ['<Figure caption="fig">'], ["</Figure>"]],
  ["Tab", ['<Tab label="t">'], ["</Tab>"]],
];
const BOX_PAGE = [
  "---",
  "title: Boxes",
  "---",
  "",
  "# Boxes",
  "",
  ...BOX_ROWS.flatMap(([label, open, close]) => [`## ${label}`, "", ...stepsIn(open, close)]),
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
  await writeFile(path.join(root, WIDE_REL), WIDE_PAGE, "utf8");
  await writeFile(path.join(root, "flows", "wide.lifecycle.json"), JSON.stringify(WIDE_JSON), "utf8");
  await writeFile(path.join(root, "flows", "wide.html"), WIDE_HTML, "utf8");
  await writeFile(path.join(root, CAP_REL), CAP_PAGE, "utf8");
  await writeFile(path.join(root, BOX_REL), BOX_PAGE, "utf8");
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

/** The lit nodes of `sec`'s picture (or every node, with nothing dimmed) that
 *  are not wholly inside what the reader sees: the box's client area, cut to
 *  the window and to the article pane below a stuck Steps bar. With
 *  `touch`, a node only has to intersect it (a focus wider than the view). */
const litOutOfView = (sec: Locator, touch = false) =>
  sec.evaluate((s, touch) => {
    const box = s.querySelector<HTMLElement>(".dgm-svg")!;
    const b = box.getBoundingClientRect();
    const pane = document.querySelector("#articleWrap")!.getBoundingClientRect();
    const bar = s.querySelector(".stp-ctrl")?.getBoundingClientRect();
    const left = Math.max(b.left + box.clientLeft, 0);
    const right = Math.min(b.left + box.clientLeft + box.clientWidth, window.innerWidth);
    const top = Math.max(pane.top, 0, bar ? bar.bottom : 0);
    const bottom = Math.min(pane.bottom, window.innerHeight, b.bottom);
    return Array.from(box.querySelectorAll("[data-node-id]:not(.dgm-dim)"))
      .filter((n) => {
        const r = n.getBoundingClientRect();
        if (touch) return !(r.right > left && r.left < right && r.bottom > top && r.top < bottom);
        return !(r.left >= left - 1 && r.right <= right + 1 && r.top >= top - 1 && r.bottom <= bottom + 1);
      })
      .map((n) => n.getAttribute("data-node-id"));
  }, touch);
/** Where the picture box and the article pane are scrolled to. */
const scrolled = (sec: Locator) =>
  sec.evaluate((s) => ({ left: s.querySelector(".dgm-svg")!.scrollLeft, top: document.querySelector("#articleWrap")!.scrollTop }));
/** Record every scrollTo/scrollBy/scrollIntoView call the page makes. */
async function spyScrolls(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __scrolls: { on: string; behavior: string }[] };
    w.__scrolls = [];
    for (const name of ["scrollTo", "scrollBy", "scroll", "scrollIntoView"] as const) {
      const orig = Element.prototype[name] as (...a: unknown[]) => void;
      Element.prototype[name] = function (this: Element, ...a: unknown[]) {
        const o = a[0];
        w.__scrolls.push({ on: this.className || this.id || this.tagName, behavior: typeof o === "object" && o ? String((o as ScrollToOptions).behavior ?? "") : "" });
        return orig.apply(this, a);
      } as never;
    }
  });
}
const scrollCalls = (page: Page) => page.evaluate(() => (window as unknown as { __scrolls: { on: string; behavior: string }[] }).__scrolls.splice(0));

test.describe("Steps class check A: each step brings its lit nodes into view", () => {
  async function openWide(page: Page): Promise<Locator> {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(WIDE_REL)}`);
    const sec = page.locator(".wiki-article section.stp").first();
    await expect(sec.locator(".dgm-svg svg")).toHaveCount(1);
    const m = await sec.locator(".dgm-svg").evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth }));
    expect(m.sw).toBeGreaterThan(2 * m.cw);
    return sec;
  }

  test("the fixture: `b` straddles the box's right edge at rest, `c` is wholly right of it", async ({ page }) => {
    const sec = await openWide(page);
    const edges = await sec.evaluate((s) => {
      const box = s.querySelector(".dgm-svg")!.getBoundingClientRect();
      const at = (id: string) => s.querySelector(`[data-node-id="${id}"]`)!.getBoundingClientRect();
      return { right: box.right, b: [at("b").left, at("b").right], c: at("c").left };
    });
    expect(edges.b[0]).toBeLessThan(edges.right);
    expect(edges.b[1]).toBeGreaterThan(edges.right);
    expect(edges.c).toBeGreaterThan(edges.right);
  });

  const ROWS: { row: string; want: string[]; touch?: true }[] = [
    { row: "focus fits and is in view: no scroll", want: [] },
    { row: "focus partly right: wholly in view", want: [] },
    { row: "focus fully right: wholly in view", want: [] },
    { row: "focus fully left, after scrolling right: wholly in view", want: [] },
    { row: "focus wider than the box: its left edge in view", want: ["c"], touch: true },
  ];
  test("Next through every row: the lit nodes intersect the visible box (table)", async ({ page }) => {
    const sec = await openWide(page);
    const next = sec.locator('button[data-stp-act="next"]');
    for (let k = 0; k < ROWS.length; k++) {
      await next.click();
      await expect.poll(() => litOutOfView(sec, ROWS[k]!.touch), { message: ROWS[k]!.row }).toEqual(ROWS[k]!.want);
      if (k === 0) {
        await page.waitForTimeout(400);
        expect((await scrolled(sec)).left, ROWS[0]!.row).toBe(0);
      }
    }
    // Row: no focus the picture draws (the unknown-only step), then Show all:
    // nothing moves. The box is parked mid-way first, so a reset to 0 shows.
    await page.waitForTimeout(400);
    await sec.locator(".dgm-svg").evaluate((e) => (e.scrollLeft = 700));
    const at = await scrolled(sec);
    expect(at.left).toBe(700);
    await next.click();
    await expect(sec.locator(".stp-pos")).toHaveText("Step 6 of 6");
    await page.waitForTimeout(400);
    expect(await scrolled(sec), "unknown-only focus").toEqual(at);
    await sec.locator('button[data-stp-act="all"]').click();
    await page.waitForTimeout(400);
    expect(await scrolled(sec), "Show all").toEqual(at);
  });

  test("Prev, the arrow keys and a Play tick bring the step into view too", async ({ page }) => {
    const sec = await openWide(page);
    // Prev from Show all is the last step (no focus drawn); once more is step 5, then 4 (`a`), then 3 (`c`).
    const prev = sec.locator('button[data-stp-act="prev"]');
    await prev.click();
    await prev.click();
    await prev.click();
    await expect.poll(() => litOutOfView(sec), { message: "Prev to `a`" }).toEqual([]);
    await prev.click();
    await expect.poll(() => litOutOfView(sec), { message: "Prev to `c`" }).toEqual([]);
    await page.keyboard.press("ArrowLeft");
    await expect(sec.locator(".stp-pos")).toHaveText("Step 2 of 6");
    await expect.poll(() => litOutOfView(sec), { message: "ArrowLeft to `b`" }).toEqual([]);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => litOutOfView(sec), { message: "ArrowLeft to `a`" }).toEqual([]);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(sec.locator(".stp-pos")).toHaveText("Step 3 of 6");
    await expect.poll(() => litOutOfView(sec), { message: "ArrowRight to `c`" }).toEqual([]);
    // Play from the start: its tick to step 3 brings `c` in from the left end.
    await sec.locator('button[data-stp-act="all"]').click();
    await sec.locator('button[data-stp-act="play"]').click();
    await expect.poll(() => litOutOfView(sec), { message: "Play step 1" }).toEqual([]);
    await expect.poll(() => sec.locator(".stp-pos").textContent(), { timeout: 6_000 }).toBe("Step 3 of 6");
    await expect.poll(() => litOutOfView(sec), { message: "Play tick to `c`" }).toEqual([]);
    await sec.locator('button[data-stp-act="all"]').click();
  });

  test("a Diagram view button follows the same rule", async ({ page }) => {
    await openWide(page);
    const fig = page.locator(".wiki-article figure.dgm").filter({ has: page.locator("button[data-dgm-view]") });
    await fig.scrollIntoViewIfNeeded();
    await fig.locator('button[data-dgm-view="right"]').click();
    await expect.poll(() => litOutOfView(fig)).toEqual([]);
    await fig.locator('button[data-dgm-view="left"]').click();
    await expect.poll(() => litOutOfView(fig)).toEqual([]);
    const at = await scrolled(fig);
    await fig.locator('button[data-dgm-view=""]').click();
    await page.waitForTimeout(400);
    expect(await scrolled(fig), "All: no scroll").toEqual(at);
  });

  test("motion: smooth by default, instant under reduced motion", async ({ page }) => {
    await spyScrolls(page);
    const sec = await openWide(page);
    await scrollCalls(page);
    await sec.locator('button[data-stp-act="next"]').click();
    await sec.locator('button[data-stp-act="next"]').click();
    const calls = await scrollCalls(page);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.behavior === "smooth")).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await sec.locator('button[data-stp-act="next"]').click();
    // Instant: in view the moment the click returns, no poll.
    expect(await litOutOfView(sec)).toEqual([]);
    const reduced = await scrollCalls(page);
    expect(reduced.length).toBeGreaterThan(0);
    expect(reduced.every((c) => c.behavior !== "smooth")).toBe(true);
  });

  test("a picture with no overflow never scrolls its box", async ({ page }) => {
    await spyScrolls(page);
    await open(page);
    const sec = steps(page, 0);
    await scrollCalls(page);
    for (let k = 0; k < 3; k++) await sec.locator('button[data-stp-act="next"]').click();
    expect((await scrollCalls(page)).filter((c) => c.on.includes("dgm-svg"))).toEqual([]);
    expect((await scrolled(sec)).left).toBe(0);
  });

  test("a picture taller than the window: each Next brings its node into the window under the bar", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(TALL_REL)}`);
    const sec = page.locator(".wiki-article section.stp").first();
    await expect(sec.locator(".dgm-svg svg")).toHaveCount(1);
    const next = sec.locator('button[data-stp-act="next"]');
    for (const id of ["top", "mid", "bot"]) {
      await next.click();
      await expect.poll(() => litOutOfView(sec), { message: id }).toEqual([]);
      expect(await inView(sec.locator(".stp-ctrl")), `${id}: the bar`).toBe(true);
    }
    // Taller than the window: its top edge (`top`) comes into view, under the bar.
    await next.click();
    await expect.poll(() => litOutOfView(sec), { message: "top, bot" }).toEqual(["bot"]);
    expect(await litOutOfView(sec, true), "only the top edge is in view").toEqual(["bot"]);
    expect(await inView(sec.locator(".stp-ctrl"))).toBe(true);
  });
});

test.describe("Steps class check B: the caption", () => {
  test("every caption row shows its text (table), escaped and whole", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(CAP_REL)}`);
    const sec = page.locator(".wiki-article section.stp").first();
    await expect(sec.locator("li.stp-step")).toHaveCount(CAP_WANT.length);
    const cap = sec.locator(".stp-ctrl .stp-cap");
    for (let k = 0; k < CAP_WANT.length; k++) {
      await sec.locator('button[data-stp-act="next"]').click();
      await expect.soft(cap, `row ${k + 1}`).toHaveText(CAP_WANT[k]!);
      await expect.soft(cap, `row ${k + 1} title`).toHaveAttribute("title", CAP_WANT[k]!);
      await expect.soft(sec.locator(".stp-ctrl .stp-now"), `row ${k + 1} live line`).toHaveText(`Step ${k + 1} of ${CAP_WANT.length} · ${CAP_WANT[k]}`);
    }
    // No attribute broke out of data-stp-cap: each step has exactly the attributes the server writes.
    const attrs = await sec.locator("li.stp-step").evaluateAll((els) => els.map((e) => e.getAttributeNames().filter((n) => !["class", "data-stp-i", "data-stp-focus", "data-stp-cap", "aria-current"].includes(n))));
    expect(attrs.flat()).toEqual([]);
    const views = page.locator(".wiki-article section.stp").nth(1);
    const want = ["Start — The case opens.", "End", "Typo"];
    for (const w of want) {
      await views.locator('button[data-stp-act="next"]').click();
      await expect.soft(views.locator(".stp-ctrl .stp-cap")).toHaveText(w);
    }
  });
});

test.describe("Steps class check C: the stuck bar's fill is its container's visible fill", () => {
  /** One screen pixel's RGB. */
  async function pixel(page: Page, x: number, y: number): Promise<number[]> {
    const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
    return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      return Array.from(g.getImageData(0, 0, 1, 1).data.slice(0, 3));
    }, png.toString("base64"));
  }
  /** The bar's own pixel, and the pixel under it with the bar hidden. */
  async function barAndUnder(page: Page, bar: Locator): Promise<{ bar: number[]; under: number[]; alpha: string }> {
    await bar.scrollIntoViewIfNeeded();
    const r = (await bar.boundingBox())!;
    const x = Math.round(r.x + r.width - 4);
    const y = Math.round(r.y + r.height / 2);
    const own = await pixel(page, x, y);
    await bar.evaluate((e) => (e.style.visibility = "hidden"));
    const under = await pixel(page, x, y);
    await bar.evaluate((e) => (e.style.visibility = ""));
    const alpha = await bar.evaluate((e) => getComputedStyle(e).backgroundColor);
    return { bar: own, under, alpha };
  }
  const close = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 2);

  for (const scheme of ["dark", "light"] as const) {
    test(`${scheme}: every container row (table)`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(BOX_REL)}`);
      const bars = page.locator(".wiki-article section.stp > .stp-ctrl");
      await expect(bars).toHaveCount(BOX_ROWS.length);
      const wrong: string[] = [];
      for (let k = 0; k < BOX_ROWS.length; k++) {
        const m = await barAndUnder(page, bars.nth(k));
        if (!close(m.bar, m.under)) wrong.push(`${BOX_ROWS[k]![0]}: bar ${m.bar} under ${m.under}`);
        // Opaque, so the picture never shows through when it scrolls under.
        if (!/^rgb\(/.test(m.alpha)) wrong.push(`${BOX_ROWS[k]![0]}: not opaque (${m.alpha})`);
      }
      expect(wrong).toEqual([]);
    });
  }

  test("a theme switch after the render repaints the bar", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(BOX_REL)}`);
    const bars = page.locator(".wiki-article section.stp > .stp-ctrl");
    await expect(bars).toHaveCount(BOX_ROWS.length);
    await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
    for (const k of [1, 3]) {
      await expect.poll(async () => {
        const m = await barAndUnder(page, bars.nth(k));
        return close(m.bar, m.under);
      }, { message: BOX_ROWS[k]![0] }).toBe(true);
    }
  });
});
