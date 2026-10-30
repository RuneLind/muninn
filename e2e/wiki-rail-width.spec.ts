/**
 * The /wiki page rail: full titles and a draggable, remembered width.
 *
 * What the unit tests cannot reach:
 *  1. **A long title is no longer clipped to one line.** The rule is CSS on a
 *     bundled page; `wiki-rail-width.test.ts` knows nothing about it. The
 *     assertion is the RENDERED height of the title against its line-height —
 *     two lines is the whole feature.
 *  2. **A drag changes the grid column and a reload brings it back.** The
 *     variable is set inline by pointer events and read from localStorage at
 *     boot; every link in that chain is DOM. The width is asserted on the pane's
 *     bounding box, not on the variable — a variable the grid does not read
 *     would still "persist".
 *  3. **Double-click resets to the shipped default and forgets the stored value.**
 *  4. **The two-line row**: line one is icon · title · age, every mark is on the
 *     meta line under the title, and a row with no mark stays one line. Layout
 *     is measured on the rendered rail at 260–312px.
 *
 * No model calls. ENV / SPAWN: as every spec here — `e2eEnv()` keeps this
 * muninn off Telegram/Slack and off the host's instance-profile flags.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { SETTLED_CREATED_LINE, settleWikiMtimes } from "./settled-wiki.ts";
import {
  RAIL_WIDTH_DEFAULT,
  RAIL_WIDTH_DEFAULT_NARROW,
  RAIL_WIDTH_KEY,
  RAIL_WIDTH_KEY_STEP,
  RAIL_WIDTH_MAX,
} from "../src/dashboard/views/components/wiki-rail-width.ts";

const PORT = e2ePort("wiki-rail-width");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-rail";

/** Long enough to need a second line at every width the clamp allows, and
 *  shaped like the titles that motivated this: the distinguishing part is at the
 *  END. A one-line ellipsis loses exactly the "(B, follow-up)". */
const LONG_TITLE = "MELOSYS-7588/7969 — Nullable trygdesperiode-FK i grunnlag (B, follow-up)";
const LONG_REL = "long-title.md";
const SHORT_REL = "short.md";

/**
 * Rows whose marks stress the two-line row's meta line (status pill · ✋ · ⚑ ·
 * group chip · NEW). Settled (a fixed `created:` and old mtimes) so Activity
 * lifts none of the children out and the chips read their full counts. They
 * began as the edge cases of the old one-line row's width budgets (#557):
 *  - `sup10`: a superseded-only chip, `10 superseded`;
 *  - `big`: three-digit counts, `120 · 100`, beside a pill and a ⚑;
 *  - `three`: `3 attached` beside a pill and a ⚑;
 *  - `bare`: a pill and a ⚑ with no chip.
 */
const SUP10 = "plans/sup10.mdx";
const BIG = "plans/big.mdx";
const THREE = "plans/three.mdx";
const BARE = "plans/bare.mdx";
/** The crowded meta line: an in-flight pill, a ⚑, ✋ 12 and a two-kind chip
 *  (`99 attached · 99 superseded`, 170.6px, its class's widest) on one row — every mark that takes room
 *  beside the chip, at its widest realistic form. */
const CROWDED = "plans/crowded.mdx";
/** The same marks beside a LONG one-kind chip at its widest two-digit label,
 *  `99 superseded` (100.3px of chip). */
const CROWDED_LONG = "plans/crowded-long.mdx";
/** The widest pill (`superseded`), a ⚑ and ✋ 12 beside a SHORT chip at its
 *  widest two-digit label, `99 attached` (85.5px of chip), so a loosened short
 *  breakpoint clips it. */
const CROWDED_SHORT = "plans/crowded-short.mdx";
/** A NEW in-flight plan with a ⚑ and two attachments: its meta line carries a
 *  pill, ⚑, the NEW tag and a chip, with its green age on line one. */
const NEW_FLIGHT = "plans/new-flight.mdx";
const BIG_ATTACHED = 120;
const BIG_SUPERSEDED = 100;
const md = (title: string, extra: string[] = []) =>
  ["---", `title: ${title}`, SETTLED_CREATED_LINE, ...extra, "---", "", `# ${title}`, "", "Body.", ""].join("\n");
const html = (title: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${title}</p></body></html>`;
const PILL_AND_FLAG = ["plan_status: shipped", "followups: open"];
const EDGE_PAGES: Array<[string, string]> = [
  [SUP10, md("Sup ten parent plan")],
  ...Array.from({ length: 10 }, (_, i): [string, string] => [
    `plans/sup10-old-${i + 1}.md`,
    md(`Sup ten retired ${i + 1}`, ["superseded_by: [[sup10]]"]),
  ]),
  [BIG, md("Big parent plan with a long enough title", PILL_AND_FLAG)],
  ...Array.from({ length: BIG_ATTACHED }, (_, i): [string, string] => [
    `plans/big-prototype-${i + 1}.html`,
    html(`Big mock ${i + 1}`),
  ]),
  ...Array.from({ length: BIG_SUPERSEDED }, (_, i): [string, string] => [
    `plans/big-old-${i + 1}.md`,
    md(`Big retired ${i + 1}`, ["superseded_by: [[big]]"]),
  ]),
  [THREE, md("Three attached plan title", PILL_AND_FLAG)],
  ...Array.from({ length: 3 }, (_, i): [string, string] => [
    `plans/three-prototype-${i + 1}.html`,
    html(`Three mock ${i + 1}`),
  ]),
  [BARE, md("Bare plan with a pill and a flag", PILL_AND_FLAG)],
  [
    CROWDED,
    [
      "---",
      "title: Crowded plan",
      SETTLED_CREATED_LINE,
      "plan_status: in-flight",
      "followups: open",
      "---",
      "",
      "# Crowded plan",
      "",
      "<NextMoves>",
      "",
      '<Lane kind="you" who="Du">',
      "",
      ...Array.from({ length: 12 }, (_, i) => `${i + 1}. **Step ${i + 1}.**`),
      "",
      "</Lane>",
      "",
      "</NextMoves>",
      "",
    ].join("\n"),
  ],
  ...Array.from({ length: 99 }, (_, i): [string, string] => [`plans/crowded-prototype-${i + 1}.html`, html(`Crowded mock ${i + 1}`)]),
  [
    CROWDED_LONG,
    [
      "---",
      "title: Crowded long plan",
      SETTLED_CREATED_LINE,
      "plan_status: in-flight",
      "followups: open",
      "---",
      "",
      "# Crowded long plan",
      "",
      "<NextMoves>",
      "",
      '<Lane kind="you" who="Du">',
      "",
      ...Array.from({ length: 12 }, (_, i) => `${i + 1}. **Step ${i + 1}.**`),
      "",
      "</Lane>",
      "",
      "</NextMoves>",
      "",
    ].join("\n"),
  ],
  ...Array.from({ length: 99 }, (_, i): [string, string] => [
    `plans/crowded-long-old-${i + 1}.md`,
    md(`Crowded long retired ${i + 1}`, ["superseded_by: [[crowded-long]]"]),
  ]),
  [
    CROWDED_SHORT,
    [
      "---",
      "title: Crowded short plan",
      SETTLED_CREATED_LINE,
      "plan_status: superseded",
      "followups: open",
      "---",
      "",
      "# Crowded short plan",
      "",
      "<NextMoves>",
      "",
      '<Lane kind="you" who="Du">',
      "",
      ...Array.from({ length: 12 }, (_, i) => `${i + 1}. **Step ${i + 1}.**`),
      "",
      "</Lane>",
      "",
      "</NextMoves>",
      "",
    ].join("\n"),
  ],
  ...Array.from({ length: 99 }, (_, i): [string, string] => [`plans/crowded-short-prototype-${i + 1}.html`, html(`Crowded short mock ${i + 1}`)]),
  // A name-stem family of twelve superseded plans: with `group families` on, a
  // HEADER row whose one-kind roll-up reads `12 superseded`.
  ...Array.from({ length: 12 }, (_, i): [string, string] => [
    `plans/gone-slate-${i + 1}.md`,
    md(`Gone plan ${i + 1}`, ["plan_status: superseded"]),
  ]),
  // Attachments of the NEW plan, so its meta line carries NEW and a chip.
  ...Array.from({ length: 2 }, (_, i): [string, string] => [`plans/new-flight-prototype-${i + 1}.html`, html(`New flight mock ${i + 1}`)]),
  ...Array.from({ length: 99 }, (_, i): [string, string] => [
    `plans/crowded-old-${i + 1}.md`,
    md(`Crowded retired ${i + 1}`, ["superseded_by: [[crowded]]"]),
  ]),
  // No `created:` line and re-written after the settle (below): NEW in Activity.
  [
    NEW_FLIGHT,
    [
      "---",
      "title: New in-flight plan with a flag",
      "plan_status: in-flight",
      "followups: open",
      "---",
      "",
      "# New",
      "",
    ].join("\n"),
  ],
];
/** Rows on screen with every group closed and families off: the two title pages
 *  + seven parents + the new plan + the twelve `gone-slate-*` plans. */
const CLOSED_ROWS = 2 + 7 + 1 + 12;

let server: ChildProcess | undefined;
let root = "";

/** A second wiki, with a work map (P4): one effort fold row at its widest — a
 *  name far past any rail, the longest state word, ✋ 12 (twelve Needs-you
 *  items) and a four-status roll-up — and a short-named one beside it. Its
 *  pages are new, so Activity holds them. D14: the long fold's body carries a
 *  one-line summary far past the rail with a page link in it, the longest
 *  role words, and «+1 more» (five pages). */
const EF_WIKI = "e2e-rail-efforts-width";
let efRoot = "";
const EF_LONG_NAME = "An effort whose name runs far past the widest rail the reader allows — the plan, its follow-up, the report and the explainer";
const EF_PAGES: Array<[string, string, string]> = [
  ["plans/ef-a.md", "Effort page A", "in-flight"],
  ["plans/ef-b.md", "Effort page B", "shipped"],
  ["plans/ef-c.md", "Effort page C", "proposed"],
  ["plans/ef-d.md", "Effort page D", "superseded"],
  ["plans/ef-short.md", "Short effort page", "in-flight"],
  ["plans/ef-e.md", "Effort page E with a title long enough to wrap inside the fold", "in-flight"],
];
const EF_ONELINE =
  "Carry ⟦plans/ef-a.md⟧ through review, then fold the follow-up, the report and the explainer into one long-running piece of work that keeps going";
const EF_ROLES = ["prototype", "explainer", "spin-off", "followup", "reference"];
const efMap = (runAtMs: number) =>
  JSON.stringify({
    version: 1, wiki: EF_WIKI, runAtMs, model: "test-model",
    coverage: { sessionsSinceMs: runAtMs, sessionsAsOfMs: runAtMs, touchWindowDays: 28, activePages: 5, threads: 0, logEntries: 0, digestChars: 1, warnings: [] },
    summary: "", themes: [], loose: [],
    needsYou: Array.from({ length: 12 }, (_, i) => ({ title: `Step ${i + 1}`, kind: "decision", why: "", action: "", pages: [], effort: "long" })),
    efforts: [
      {
        id: "long", name: EF_LONG_NAME, aliases: [], oneLine: EF_ONELINE, state: "proposed",
        pages: [...EF_PAGES.slice(0, 4), EF_PAGES[5]!].map(([id], i) => ({ id, role: EF_ROLES[i]! })),
        why: "", confidence: 1, next: "", related: [], daily: [],
      },
      { id: "short", name: "Short", aliases: [], oneLine: "", state: "active", pages: [{ id: "plans/ef-short.md", role: "plan" }], why: "", confidence: 1, next: "", related: [], daily: [] },
    ],
  });

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-rail-"));
  await writeFile(
    path.join(root, LONG_REL),
    ["---", `title: ${LONG_TITLE}`, SETTLED_CREATED_LINE, "---", "", `# ${LONG_TITLE}`, "", "Body.", ""].join("\n"),
    "utf8",
  );
  // `created:` pinned like the fixture's other pages (all but the `.html`
  // attachments and the deliberately new plan): on Linux `utimes` leaves the
  // birthtime at now, so without it these two read as NEW (CI run 38313899886).
  await writeFile(path.join(root, SHORT_REL), ["---", "title: Short", SETTLED_CREATED_LINE, "---", "", "# Short", "", "Body.", ""].join("\n"), "utf8");
  for (const [rel, body] of EDGE_PAGES) {
    await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, "utf8");
  }
  await settleWikiMtimes(root);
  // Re-created AFTER the settle: on macOS `utimes` moves the birthtime back with
  // the mtime, and the oldest creation signal wins.
  const fresh = EDGE_PAGES.find(([rel]) => rel === NEW_FLIGHT)![1];
  await rm(path.join(root, NEW_FLIGHT));
  await writeFile(path.join(root, NEW_FLIGHT), fresh, "utf8");

  efRoot = await mkdtemp(path.join(tmpdir(), "muninn-e2e-rail-ef-"));
  await mkdir(path.join(efRoot, "plans"), { recursive: true });
  for (const [rel, title, status] of EF_PAGES) {
    const moves = rel === "plans/ef-a.md"
      ? ["<NextMoves>", "", '<Lane kind="you" who="Du">', "", ...Array.from({ length: 12 }, (_, i) => `${i + 1}. **Step ${i + 1}.**`), "", "</Lane>", "", "</NextMoves>", ""]
      : [];
    await writeFile(path.join(efRoot, rel), ["---", `title: ${title}`, `plan_status: ${status}`, "---", "", `# ${title}`, "", ...moves].join("\n"), "utf8");
  }
  await writeFile(path.join(efRoot, ".work-map.json"), efMap(Date.now()), "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root},${EF_WIKI}=${efRoot}`,
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
  if (efRoot) await rm(efRoot, { recursive: true, force: true });
});

const RAIL = ".wiki-layout > .wiki-pane:first-child";
const HANDLE = "#wikiRailResizer";

async function open(page: import("@playwright/test").Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
  await expect(page.locator(".wiki-list-item")).toHaveCount(CLOSED_ROWS);
}

async function railWidth(page: import("@playwright/test").Page): Promise<number> {
  const box = await page.locator(RAIL).boundingBox();
  if (!box) throw new Error("rail not laid out");
  return Math.round(box.width);
}

test.describe("Wiki rail: full titles + remembered width", () => {
  test("a long title wraps to a second line instead of clipping", async ({ page }) => {
    await open(page);
    const title = page.locator(`.wiki-list-item[data-relpath="${LONG_REL}"] .wiki-list-title`);
    await expect(title).toHaveText(LONG_TITLE);
    const { height, lineHeight, whiteSpace } = await title.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { height: el.getBoundingClientRect().height, lineHeight: parseFloat(cs.lineHeight), whiteSpace: cs.whiteSpace };
    });
    expect(whiteSpace).not.toBe("nowrap");
    // Two lines: taller than one line-height by a clear margin. The one-line
    // ellipsis this replaces measures exactly ONE line-height here.
    expect(height).toBeGreaterThan(lineHeight * 1.8);
  });

  test("dragging the handle widens the rail, and a reload keeps it", async ({ page }) => {
    await open(page);
    const before = await railWidth(page);
    expect(before).toBe(RAIL_WIDTH_DEFAULT);

    const hb = await page.locator(HANDLE).boundingBox();
    if (!hb) throw new Error("handle not laid out");
    const x0 = hb.x + hb.width / 2;
    const y0 = hb.y + hb.height / 2;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + 60, y0, { steps: 6 });
    await page.mouse.move(x0 + 120, y0, { steps: 6 });
    await page.mouse.up();

    const after = await railWidth(page);
    expect(after).toBeGreaterThanOrEqual(before + 110);
    expect(after).toBeLessThanOrEqual(before + 130);

    // The stored value is what a reload reads — assert it, then assert the reload.
    const stored = await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY);
    expect(Number(stored)).toBe(after);

    await page.reload();
    await expect(page.locator(".wiki-list-item")).toHaveCount(CLOSED_ROWS);
    expect(await railWidth(page)).toBe(after);
  });

  test("a width stored on a wide monitor is bounded by a narrow window", async ({ page }) => {
    await open(page);
    await page.evaluate((k) => localStorage.setItem(k, "560"), RAIL_WIDTH_KEY);
    await page.setViewportSize({ width: 700, height: 900 });
    await page.reload();
    await expect(page.locator(".wiki-list-item")).toHaveCount(CLOSED_ROWS);
    // 45% of 700 = 315: the stored value is bounded at APPLY time, never
    // rewritten — widening the window again gets the stored width back.
    expect(await railWidth(page)).toBe(315);
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect.poll(() => railWidth(page)).toBe(560);
    expect(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY)).toBe("560");
  });

  test("losing pointer capture mid-drag ends the drag instead of leaving the page in drag state", async ({
    page,
  }) => {
    await open(page);
    const hb = await page.locator(HANDLE).boundingBox();
    if (!hb) throw new Error("handle not laid out");
    const x0 = hb.x + hb.width / 2;
    const y0 = hb.y + hb.height / 2;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + 80, y0, { steps: 4 });
    await expect(page.locator("body")).toHaveClass(/wiki-rail-dragging/);
    // A right-click's context-menu gesture (measured in review) drops the capture
    // and the handle never sees the pointerup; Playwright's mouse cannot reproduce
    // that gesture, so the browser-fired event is dispatched directly. Before the
    // fix the body kept `user-select: none` + col-resize until a reload, and any
    // later hover over the handle resized the rail with no button held.
    await page.locator(HANDLE).evaluate((el) => {
      el.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 1, bubbles: true }));
    });
    await expect(page.locator("body")).not.toHaveClass(/wiki-rail-dragging/);
    const settled = await railWidth(page);
    expect(settled).toBeGreaterThan(RAIL_WIDTH_DEFAULT);
    // Still physically captured by Playwright's mouse, so these moves reach the
    // handle — with no drag in progress they must not resize.
    await page.mouse.move(x0 + 140, y0, { steps: 3 });
    expect(await railWidth(page)).toBe(settled);
    await page.mouse.up();
    // The width the drag reached before losing capture is what gets remembered.
    expect(Number(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY))).toBe(settled);
  });

  test("in a bounded window, arrows step the DISPLAYED width and a drag stores what was shown", async ({
    page,
  }) => {
    await open(page);
    await page.evaluate((k) => localStorage.setItem(k, "560"), RAIL_WIDTH_KEY);
    await page.setViewportSize({ width: 700, height: 900 });
    await page.reload();
    await expect(page.locator(".wiki-list-item")).toHaveCount(CLOSED_ROWS);
    expect(await railWidth(page)).toBe(315);
    // Stepping from the STORED 560 moved nothing press after press while
    // rewriting the stored value (measured in review); the base is what is shown.
    // A GROW the bound makes inert must not lower the stored desktop width.
    await page.locator(HANDLE).focus();
    await page.keyboard.press("ArrowRight");
    expect(await railWidth(page)).toBe(315);
    expect(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY)).toBe("560");
    // The same inert grow by a SHORT drag (to 320, under the stored 560).
    const hb0 = await page.locator(HANDLE).boundingBox();
    if (!hb0) throw new Error("handle not laid out");
    await page.mouse.move(hb0.x + hb0.width / 2, hb0.y + 40);
    await page.mouse.down();
    await page.mouse.move(hb0.x + hb0.width / 2 + 5, hb0.y + 40, { steps: 2 });
    await page.mouse.up();
    expect(await railWidth(page)).toBe(315);
    expect(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY)).toBe("560");
    await page.keyboard.press("ArrowLeft");
    expect(await railWidth(page)).toBe(315 - RAIL_WIDTH_KEY_STEP);
    expect(Number(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY))).toBe(
      315 - RAIL_WIDTH_KEY_STEP,
    );
    // A drag all the way right is a GROW: it stores what was asked for (the
    // pointer's clamped width, 560) while the bound keeps showing 315 — the same
    // rule as the arrow keys, so the desktop width is what the reader dragged to.
    const hb = await page.locator(HANDLE).boundingBox();
    if (!hb) throw new Error("handle not laid out");
    await page.mouse.move(hb.x + hb.width / 2, hb.y + 40);
    await page.mouse.down();
    await page.mouse.move(650, hb.y + 40, { steps: 4 });
    await page.mouse.up();
    expect(await railWidth(page)).toBe(315);
    expect(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY)).toBe(String(RAIL_WIDTH_MAX));
    // And a drag back to a width UNDER the bound is a shrink: stored = shown.
    const hb2 = await page.locator(HANDLE).boundingBox();
    if (!hb2) throw new Error("handle not laid out");
    await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + 40);
    await page.mouse.down();
    await page.mouse.move(hb2.x - 40, hb2.y + 40, { steps: 4 });
    await page.mouse.up();
    const shown = await railWidth(page);
    expect(shown).toBeLessThan(315);
    expect(Number(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY))).toBe(shown);
  });

  test("a drag that overshoots the bound and comes back stores the RELEASE width, not the maximum", async ({
    page,
  }) => {
    await open(page);
    await page.setViewportSize({ width: 700, height: 900 });
    await page.reload();
    await expect(page.locator(".wiki-list-item")).toHaveCount(CLOSED_ROWS);
    const rb = await page.locator(RAIL).boundingBox();
    if (!rb) throw new Error("rail not laid out");
    const hb = await page.locator(HANDLE).boundingBox();
    if (!hb) throw new Error("handle not laid out");
    const y = hb.y + 40;
    await page.mouse.move(hb.x + hb.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(rb.x + 500, y, { steps: 4 }); // out past the bound (shown pins at 315)
    await page.mouse.move(rb.x + 330, y, { steps: 4 }); // back, still over the bound
    await page.mouse.up();
    expect(await railWidth(page)).toBe(315);
    // The rule is judged against the state at the START of the gesture; fed its
    // own running result it stored the maximum the pointer ever reached (500).
    expect(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY)).toBe("330");
  });

  test("the hit zone starts at the pane's border: the list's last pixel never starts a drag", async ({
    page,
  }) => {
    await open(page);
    const rb = await page.locator(RAIL).boundingBox();
    if (!rb) throw new Error("rail not laid out");
    const railRight = Math.round(rb.x + rb.width); // first pixel OUTSIDE the pane
    const y = rb.y + rb.height / 2;
    // railRight-2 is the last pixel of the list's content box (the pane's 1px
    // border is railRight-1). On Windows/Linux that pixel is the outer edge of a
    // classic scrollbar; the accent pseudo-element used to be hit-testable there.
    await page.mouse.move(railRight - 2, y);
    await page.mouse.down();
    await page.mouse.move(railRight + 60, y, { steps: 3 });
    await expect(page.locator("body")).not.toHaveClass(/wiki-rail-dragging/);
    await page.mouse.up();
    expect(await railWidth(page)).toBe(RAIL_WIDTH_DEFAULT);
    // One pixel further out is the handle.
    await page.mouse.move(railRight - 1, y);
    await page.mouse.down();
    await page.mouse.move(railRight + 60, y, { steps: 3 });
    await page.mouse.up();
    expect(await railWidth(page)).toBeGreaterThan(RAIL_WIDTH_DEFAULT);
  });

  test("below the breakpoint the reset lands on the narrow default and arrows step from it", async ({
    page,
  }) => {
    await open(page);
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.reload();
    await expect(page.locator(".wiki-list-item")).toHaveCount(CLOSED_ROWS);
    expect(await railWidth(page)).toBe(RAIL_WIDTH_DEFAULT_NARROW);
    await page.locator(HANDLE).focus();
    await page.keyboard.press("ArrowRight");
    expect(await railWidth(page)).toBe(RAIL_WIDTH_DEFAULT_NARROW + RAIL_WIDTH_KEY_STEP);
    await page.keyboard.press("Home");
    expect(await railWidth(page)).toBe(RAIL_WIDTH_DEFAULT_NARROW);
  });

  test("a click on the handle focuses it, so the keyboard path is reachable by pointer", async ({ page }) => {
    await open(page);
    const hb = await page.locator(HANDLE).boundingBox();
    if (!hb) throw new Error("handle not laid out");
    await page.mouse.click(hb.x + hb.width / 2, hb.y + 40);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("wikiRailResizer");
  });

  test("a move with no button held mid-drag, and a dead pointer's down, are ignored", async ({ page }) => {
    // Both pin guards the drag path carries for other pointers: a second,
    // uncaptured pointer hovering the handle while a pen drags (buttons = 0), and a
    // pointerdown for a pointer the browser no longer knows (setPointerCapture
    // throws). Neither is reachable with Playwright's one mouse, so both are
    // dispatched. Written as pins after review found both guards unpinned.
    await open(page);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const hb = await page.locator(HANDLE).boundingBox();
    if (!hb) throw new Error("handle not laid out");
    const x0 = hb.x + hb.width / 2;
    const y0 = hb.y + 40;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + 60, y0, { steps: 3 });
    const during = await railWidth(page);
    await page.locator(HANDLE).evaluate((el, x) => {
      el.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: x, buttons: 0, bubbles: true }));
    }, x0 + 200);
    expect(await railWidth(page)).toBe(during);
    await page.mouse.up();

    await page.locator(HANDLE).evaluate((el) => {
      el.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 999, button: 0, buttons: 1, bubbles: true }));
    });
    await expect(page.locator("body")).not.toHaveClass(/wiki-rail-dragging/);
    expect(errors).toEqual([]);
  });

  test("the handle is keyboard-operable: arrows resize, Home resets", async ({ page }) => {
    await open(page);
    await page.locator(HANDLE).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    expect(await railWidth(page)).toBe(RAIL_WIDTH_DEFAULT + 3 * RAIL_WIDTH_KEY_STEP);
    expect(Number(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY))).toBe(
      RAIL_WIDTH_DEFAULT + 3 * RAIL_WIDTH_KEY_STEP,
    );
    await page.keyboard.press("Home");
    expect(await railWidth(page)).toBe(RAIL_WIDTH_DEFAULT);
    expect(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY)).toBeNull();
  });

  test("double-click resets to the default and clears the stored width", async ({ page }) => {
    await open(page);
    await page.evaluate((k) => localStorage.setItem(k, "480"), RAIL_WIDTH_KEY);
    await page.reload();
    await expect(page.locator(".wiki-list-item")).toHaveCount(CLOSED_ROWS);
    expect(await railWidth(page)).toBe(480);

    await page.locator(HANDLE).dblclick();
    expect(await railWidth(page)).toBe(RAIL_WIDTH_DEFAULT);
    expect(await page.evaluate((k) => localStorage.getItem(k), RAIL_WIDTH_KEY)).toBeNull();
  });
});

/**
 * The row's width budgets, driven at the widths where the round-3 verify pass
 * of #557 measured them failing. Every case asserts a PROPERTY (nothing clipped,
 * nothing overflowing its box, the title at its floor) and never a form or a
 * pixel count, so a font-metric drift on another machine degrades the chip to
 * its compact form rather than failing the case. The rail width is set the way
 * a reader sets it: the stored value.
 */
test.describe("Wiki rail: row layout at the width budgets", () => {
  type Page = import("@playwright/test").Page;
  async function openAt(page: Page, width: number): Promise<void> {
    await page.addInitScript(
      ([key, w]) => localStorage.setItem(key as string, String(w)),
      [RAIL_WIDTH_KEY, width] as const,
    );
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
    await expect(page.locator(".wiki-list-item")).toHaveCount(CLOSED_ROWS);
    expect(await railWidth(page)).toBe(width);
  }
  const rowOf = (page: Page, rel: string) => page.locator(`.wiki-list-item[data-relpath="${rel}"]`);
  /** The geometry every case reads, for the two-line row: line one is icon ·
   *  title · ★+age, and the meta line under the title holds every mark. */
  function geometry(page: Page, rel: string) {
    return rowOf(page, rel).evaluate((el) => {
      const q = (s: string) => el.querySelector(s) as HTMLElement | null;
      const rect = (e: Element) => e.getBoundingClientRect();
      const full = q(".wiki-fold-chip-label");
      const counts = q(".wiki-fold-chip-counts");
      const shown = full && getComputedStyle(full).display !== "none" ? full : counts;
      const title = q(".wiki-list-title")!;
      const end = q(".wiki-list-end")!;
      const icon = q(".wiki-type-icon")!;
      const sub = q(".wiki-list-sub");
      const cs = getComputedStyle(el);
      const content = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const marks = Array.from(el.querySelectorAll(".wiki-status, .wiki-followup-flag, .wiki-fold-chip, .wiki-new-tag, .wiki-moves-flag"));
      return {
        label: shown?.textContent ?? "",
        // scrollWidth and clientWidth are rounded apart on a fractional span, so a
        // whole 98.4px label can read 99 > 98; a real clip here is 5px or more.
        labelClipped: shown ? shown.scrollWidth - shown.clientWidth > 1 : false,
        // Line one: the age on the title's first line, flush right, and the
        // title holding all the room the icon and the age leave (8px gaps).
        endOnTitleLine: Math.abs(rect(end).top - rect(title).top) < 4,
        endGap: rect(el).right - parseFloat(cs.paddingRight) - rect(end).right,
        titleShort: content - rect(icon).width - rect(end).width - 16 - rect(title).width,
        titleLeft: rect(title).left,
        titleIntoAge: rect(title).right - rect(end).left,
        // The meta line: every mark in it, under the title, inside the row.
        marks: marks.length,
        marksOutsideSub: marks.filter((m) => !m.closest(".wiki-list-sub")).length,
        subBelowTitle: sub ? rect(sub).top >= rect(title).top + 12 : null,
        subMarkLeft: sub && sub.firstElementChild ? rect(sub.firstElementChild).left : null,
        subOverflow: sub ? sub.scrollWidth - sub.clientWidth : 0,
        marksPastRow: marks.filter((m) => rect(m).right > rect(el).right - parseFloat(cs.paddingRight) + 0.5).length,
      };
    });
  }
  const MARKED = [SUP10, BIG, THREE, BARE, NEW_FLIGHT, CROWDED, CROWDED_LONG, CROWDED_SHORT];

  test("line one is icon · title · age, flush right, and the title takes the rest of it", async ({ page }) => {
    for (const width of [260, 300, 312]) {
      await openAt(page, width);
      for (const rel of [...MARKED, LONG_REL, SHORT_REL]) {
        const g = await geometry(page, rel);
        expect(g.endOnTitleLine, `${rel} age on the title's line at ${width}`).toBe(true);
        expect(g.endGap, `${rel} age flush right at ${width}`).toBeLessThanOrEqual(1);
        expect(g.titleShort, `${rel} title fills line one at ${width}`).toBeLessThanOrEqual(1);
        expect(g.titleIntoAge, `${rel} title clear of the age at ${width}`).toBeLessThanOrEqual(0.5);
      }
    }
  });

  test("every mark is on the meta line under the title, whole, and inside the row", async ({ page }) => {
    for (const width of [260, 270, 300, 312]) {
      await openAt(page, width);
      for (const rel of MARKED) {
        const g = await geometry(page, rel);
        const at = `${rel} at ${width}: ${JSON.stringify(g)}`;
        expect(g.marks, at).toBeGreaterThan(0);
        expect(g.marksOutsideSub, at).toBe(0);
        expect(g.subBelowTitle, at).toBe(true);
        expect(g.subOverflow, at).toBeLessThanOrEqual(0);
        expect(g.marksPastRow, at).toBe(0);
        expect(g.labelClipped, at).toBe(false);
      }
      // The chips' counts are intact in whichever form is painted.
      expect((await geometry(page, BIG)).label.replace(/\s+/g, " ")).toContain(String(BIG_ATTACHED));
      expect((await geometry(page, SUP10)).label.replace(/\s+/g, " ")).toContain("10");
    }
  });

  test("every title starts at the same x, and the meta line starts under it", async ({ page }) => {
    await openAt(page, 300);
    const all = await Promise.all([...MARKED, LONG_REL, SHORT_REL].map((rel) => geometry(page, rel)));
    const left = all[0]!.titleLeft;
    for (const g of all) expect(Math.abs(g.titleLeft - left)).toBeLessThan(0.5);
    for (const g of all.slice(0, MARKED.length)) expect(Math.abs(g.subMarkLeft! - left)).toBeLessThan(0.5);
  });

  test("a crowded meta line stays one line from 260 to 400px: each chip breakpoint counts the marks beside it", async ({ page }) => {
    const forms: Record<string, string[]> = { [CROWDED]: [], [CROWDED_LONG]: [], [CROWDED_SHORT]: [] };
    for (let width = 260; width <= 400; width += 20) {
      await openAt(page, width);
      for (const rel of [CROWDED, CROWDED_LONG, CROWDED_SHORT]) {
        const m = await rowOf(page, rel).evaluate((el) => {
          const sub = el.querySelector(".wiki-list-sub") as HTMLElement;
          const marks = Array.from(sub.querySelectorAll(".wiki-status, .wiki-followup-flag, .wiki-moves-flag, .wiki-fold-chip"));
          const label = Array.from(sub.querySelectorAll(".wiki-fold-chip-label, .wiki-fold-chip-counts")).find(
            (e) => getComputedStyle(e).display !== "none",
          ) as HTMLElement;
          // Centres, not tops: the marks differ in height. A wrapped mark moves a
          // whole meta line (~19px); alignment is the next test's business.
          const mids = marks.map((e) => {
            const r = e.getBoundingClientRect();
            return r.top + r.height / 2;
          });
          return {
            marks: marks.length,
            spread: Math.max(...mids) - Math.min(...mids),
            clipped: label.scrollWidth - label.clientWidth > 1,
            label: label.textContent,
          };
        });
        expect(m.marks, `${rel} ${width}`).toBe(4);
        expect(m.spread, `${rel} one meta line at ${width}: ${JSON.stringify(m)}`).toBeLessThan(6);
        expect(m.clipped, `${rel} ${width}: ${m.label}`).toBe(false);
        forms[rel]!.push(/[a-z]/.test(m.label ?? "") ? "full" : "compact");
      }
    }
    // Both breakpoints actually switch inside the range: counts where the marks
    // leave too little room, words once they leave enough.
    for (const rel of [CROWDED, CROWDED_LONG, CROWDED_SHORT]) {
      expect(forms[rel]![0], `${rel} at 260: ${forms[rel]}`).toBe("compact");
      expect(forms[rel]!.at(-1), `${rel} at 400: ${forms[rel]}`).toBe("full");
    }
  });

  test("the meta line's marks share one centre line", async ({ page }) => {
    await openAt(page, 340);
    const m = await rowOf(page, CROWDED).evaluate((el) => {
      const kids = Array.from((el.querySelector(".wiki-list-sub") as HTMLElement).children) as HTMLElement[];
      const centre = (e: HTMLElement) => {
        const r = (e.matches(".wiki-fold-chip-wrap") ? (e.firstElementChild as HTMLElement) : e).getBoundingClientRect();
        return r.top + r.height / 2;
      };
      const centres = kids.map(centre);
      return {
        order: kids.map((k) => (k.className.match(/wiki-(status|followup-flag|moves-flag|new-tag|fold-chip)/) ?? [""])[0]),
        spread: Math.max(...centres) - Math.min(...centres),
      };
    });
    // Measured before the fix: the pill's 1px and the ⚑'s 2px top margin (from
    // the one-line row) put the centres 1.0px apart.
    expect(m.spread, JSON.stringify(m)).toBeLessThanOrEqual(0.5);
  });

  test("the meta line's marks are in the article header's order", async ({ page }) => {
    await openAt(page, 340);
    const order = await rowOf(page, CROWDED).evaluate((el) =>
      Array.from((el.querySelector(".wiki-list-sub") as HTMLElement).querySelectorAll(".wiki-status, .wiki-followup-flag, .wiki-moves-flag, .wiki-new-tag, .wiki-fold-chip")).map(
        (k) => (k.className.match(/wiki-(status|followup-flag|moves-flag|new-tag|fold-chip)/) ?? [""])[0],
      ),
    );
    // Pill THEN ⚑, as the article header's badges; ✋ after them, as the header's
    // lane pills; the chip last, where it can take the rest of the line.
    expect(order).toEqual(["wiki-status", "wiki-followup-flag", "wiki-moves-flag", "wiki-fold-chip"]);
    // NEW sits before the chip too.
    const withNew = await rowOf(page, NEW_FLIGHT).evaluate((el) =>
      Array.from((el.querySelector(".wiki-list-sub") as HTMLElement).querySelectorAll(".wiki-status, .wiki-followup-flag, .wiki-moves-flag, .wiki-new-tag, .wiki-fold-chip")).map(
        (k) => (k.className.match(/wiki-(status|followup-flag|moves-flag|new-tag|fold-chip)/) ?? [""])[0],
      ),
    );
    expect(withNew).toEqual(["wiki-status", "wiki-followup-flag", "wiki-new-tag", "wiki-fold-chip"]);
  });

  test("a meta line too full even for the compact chip wraps its slot rather than overflowing", async ({ page }) => {
    await openAt(page, 260);
    // Squeeze each row's meta line until the marks before the chip still fit
    // but leave its slot only `room` px: under the compact chip's floor for the
    // row's counts class (CROWDED `99 · 99`, default class, floor 62; BIG
    // `120 · 100`, counts-wide, floor 76, and 66 is above the default floor, so
    // only the wide floor wraps it). Measured from the row, so a platform's
    // wider pill moves the squeeze, not the case.
    for (const [rel, room] of [
      [CROWDED, 20],
      [BIG, 66],
    ] as const) {
      const pad = await rowOf(page, rel).evaluate((el, slot) => {
        const sub = el.querySelector(".wiki-list-sub") as HTMLElement;
        const cs = getComputedStyle(sub);
        const gap = parseFloat(cs.columnGap);
        const before = Array.from(sub.children).filter((k) => !k.matches(".wiki-fold-chip-wrap")) as HTMLElement[];
        const marks = before.reduce((w, k) => w + k.getBoundingClientRect().width + gap, 0);
        return sub.getBoundingClientRect().width - parseFloat(cs.paddingRight) - (marks + slot);
      }, room);
      await page.addStyleTag({ content: `.wiki-list-item[data-relpath="${rel}"] .wiki-list-sub { padding-left: ${pad}px; }` });
      const m = await rowOf(page, rel).evaluate((el) => {
        const r = (q: string) => (el.querySelector(q) as HTMLElement).getBoundingClientRect();
        const cs = getComputedStyle(el);
        const counts = el.querySelector(".wiki-fold-chip-counts") as HTMLElement;
        return {
          compact: getComputedStyle(counts).display !== "none",
          chipPastRow: r(".wiki-fold-chip").right - (el.getBoundingClientRect().right - parseFloat(cs.paddingRight)),
          // The marks before the chip stayed on one line…
          marksSpread: Math.abs(r(".wiki-status").top - r(".wiki-followup-flag").top),
          // …and the slot went under them.
          slotBelowPill: r(".wiki-fold-chip-wrap").top - r(".wiki-status").top,
          clipped: counts.scrollWidth - counts.clientWidth > 1,
        };
      });
      const at = `${rel} (pad ${pad}): ${JSON.stringify(m)}`;
      expect(m.compact, at).toBe(true);
      expect(m.marksSpread, at).toBeLessThan(6);
      expect(m.chipPastRow, at).toBeLessThanOrEqual(0.5);
      expect(m.slotBelowPill, at).toBeGreaterThan(8);
      expect(m.clipped, at).toBe(false);
    }
  });

  // A sweep over the fixture's chips, not the whole state space: every chip
  // label the rail paints for these rows is whole. Page rows across rails
  // 260–400 in 2px steps; header rows (families on) in windows down to 400px,
  // where the 45% viewport bound takes the rail under its 260px minimum.
  // Not covered (a follow-up): three- and four-digit one-kind labels, wide
  // header roll-ups other than `12 superseded`, windows under 400px, a clip of
  // 1px or less (the tolerance below), and a band narrower than the 2px step.
  async function clippedChips(page: Page): Promise<string[]> {
    return page.locator("#wikiList").evaluate((list) =>
      Array.from(list.querySelectorAll(".wiki-fold-chip-label, .wiki-fold-chip-counts"))
        .filter((e) => getComputedStyle(e).display !== "none")
        .filter((e) => (e as HTMLElement).scrollWidth - (e as HTMLElement).clientWidth > 1)
        .map((e) => `${e.closest("[data-relpath], [data-group]")?.getAttribute("data-relpath") ?? e.closest("[data-group]")?.getAttribute("data-group")}: ${e.textContent}`),
    );
  }

  test("no page-row chip label is clipped at any rail width from 260 to 400px", async ({ page }) => {
    const clipped: string[] = [];
    for (let width = 260; width <= 400; width += 2) {
      await openAt(page, width);
      for (const c of await clippedChips(page)) clipped.push(`${width}px ${c}`);
    }
    expect(clipped).toEqual([]);
  });

  test("no header-row chip label is clipped, in windows down to 400px", async ({ page }) => {
    const clipped: string[] = [];
    await page.addInitScript(
      ([key, foldsKey]) => {
        localStorage.setItem(key as string, "300");
        localStorage.setItem(foldsKey as string, JSON.stringify(["toggle:families"]));
      },
      [RAIL_WIDTH_KEY, `muninn.wiki.folds.v1:${WIKI}`] as const,
    );
    for (let vw = 700; vw >= 400; vw -= 20) {
      await page.setViewportSize({ width: vw, height: 900 });
      await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
      const header = page.locator('.wiki-list-group[data-group="family:plans/gone-slate"]');
      await expect(header).toHaveCount(1);
      await expect(header.locator(".wiki-fold-chip-label")).toHaveText("12 superseded");
      for (const c of await clippedChips(page)) clipped.push(`${vw}px window ${c}`);
    }
    expect(clipped).toEqual([]);
  });

  test("a row with no marks has no meta line and stays one line", async ({ page }) => {
    await openAt(page, 300);
    const short = rowOf(page, SHORT_REL);
    await expect(short.locator(".wiki-list-sub")).toHaveCount(0);
    const h = await short.evaluate((el) => {
      const title = el.querySelector(".wiki-list-title") as HTMLElement;
      return { row: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(title).lineHeight) };
    });
    // Padding 7 + one 16.25px line + 7: well under a second line.
    expect(h.row).toBeLessThan(14 + 2 * h.line);
  });

  test("a NEW plan's tag is on the meta line and its age stays green on line one", async ({ page }) => {
    await openAt(page, 300);
    const row = rowOf(page, NEW_FLIGHT);
    await expect(row.locator(".wiki-list-sub .wiki-new-tag")).toHaveText("NEW");
    await expect(row.locator(".wiki-list-end .wiki-new-tag")).toHaveCount(0);
    await expect(row.locator(".wiki-list-end .wiki-list-meta")).toHaveClass(/\bnew\b/);
  });
});

test.describe("Wiki rail: effort fold rows at the width budgets (work map P4)", () => {
  type Page = import("@playwright/test").Page;
  async function openEf(page: Page, width: number): Promise<void> {
    await page.addInitScript(([key, w]) => localStorage.setItem(key as string, String(w)), [RAIL_WIDTH_KEY, width] as const);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`${BASE}/wiki?wiki=${EF_WIKI}`);
    await expect(page.locator('#wikiList .wiki-list-group.effort[data-effort="long"]')).toHaveCount(1);
    expect(await railWidth(page)).toBe(width);
  }

  test("from 260 to 400px: a long name ellipsizes inside the row, the age stays on line one, and no meta part clips or leaves the row", async ({ page }) => {
    const bad: string[] = [];
    for (let width = 260; width <= 400; width += 10) {
      await openEf(page, width);
      for (const id of ["long", "short"]) {
        const g = await page.locator(`#wikiList .wiki-list-group.effort[data-effort="${id}"]`).evaluate((el) => {
          const r = (e: Element) => e.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const right = r(el).right - parseFloat(cs.paddingRight) + 0.5;
          const name = el.querySelector(".wiki-effort-name") as HTMLElement;
          const age = el.querySelector(".wiki-effort-age") as HTMLElement;
          const caret = el.querySelector(".wiki-effort-fold") as HTMLElement;
          const parts = Array.from(el.querySelectorAll(".wiki-effort-meta .wiki-rollup-part")) as HTMLElement[];
          const list = document.getElementById("wikiList")!;
          return {
            rowOverflow: el.scrollWidth - el.clientWidth,
            listOverflow: list.scrollWidth - list.clientWidth,
            nameClipped: name.scrollWidth > name.clientWidth + 1,
            nameIntoAge: r(name).right - r(age).left,
            ageOnNameLine: Math.abs(r(age).top - r(name).top) < 6,
            agePastRow: r(age).right > right,
            caretVisible: r(caret).width >= 16 && r(caret).left >= r(el).left,
            parts: parts.map((p) => p.textContent),
            partsClipped: parts.filter((p) => p.scrollWidth > p.clientWidth + 1 || r(p).right > right).map((p) => p.textContent),
            partsTwoLines: parts.filter((p) => r(p).height > 20).map((p) => p.textContent),
          };
        });
        const at = `${id} at ${width}: ${JSON.stringify(g)}`;
        if (g.rowOverflow > 0 || g.listOverflow > 0) bad.push(`overflow ${at}`);
        if (id === "long" && !g.nameClipped) bad.push(`long name not ellipsized ${at}`);
        if (id === "short" && g.nameClipped) bad.push(`short name clipped ${at}`);
        if (g.nameIntoAge > 0.5 || !g.ageOnNameLine || g.agePastRow) bad.push(`age ${at}`);
        if (!g.caretVisible) bad.push(`caret ${at}`);
        if (g.partsClipped.length || g.partsTwoLines.length) bad.push(`meta ${at}`);
        if (id === "long" && g.parts.join("|") !== "proposed ·|✋ 12 ·|1 proposed ·|2 in-flight ·|1 shipped ·|1 superseded") bad.push(`meta text ${at}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("D14: from 260 to 400px the open fold's body — a long summary, role chips, «+1 more» — stays inside the rail", async ({ page }) => {
    const bad: string[] = [];
    for (let width = 260; width <= 400; width += 10) {
      await openEf(page, width);
      const g = await page.evaluate(() => {
        const list = document.getElementById("wikiList")!;
        const lr = list.getBoundingClientRect();
        const intro = list.querySelector('.wiki-effort-intro[data-effort="long"]') as HTMLElement | null;
        const open = intro?.querySelector(".wiki-effort-open") as HTMLElement | null;
        const more = list.querySelector('.wiki-effort-more[data-fold-key="effort-all:long"]') as HTMLElement | null;
        const chips = Array.from(list.querySelectorAll(".wiki-effort-role")) as HTMLElement[];
        const inside = (e: HTMLElement) => {
          const r = e.getBoundingClientRect();
          return r.left >= lr.left - 0.5 && r.right <= lr.right + 0.5;
        };
        return {
          listOverflow: list.scrollWidth - list.clientWidth,
          intro: !!intro,
          introOverflow: intro ? intro.scrollWidth - intro.clientWidth : -1,
          introText: intro?.textContent ?? "",
          openInside: open ? inside(open) : false,
          moreText: more?.textContent ?? "",
          moreInside: more ? inside(more) : false,
          chips: chips.map((c) => c.textContent),
          chipsBad: chips.filter((c) => c.scrollWidth > c.clientWidth + 1 || !inside(c) || c.getBoundingClientRect().height > 20).map((c) => c.textContent),
        };
      });
      const at = `at ${width}: ${JSON.stringify(g)}`;
      if (g.listOverflow > 0) bad.push(`overflow ${at}`);
      if (!g.intro || g.introOverflow > 0 || g.introText.includes("⟦") || !g.openInside) bad.push(`intro ${at}`);
      if (g.moreText !== "+1 more" || !g.moreInside) bad.push(`more ${at}`);
      if (g.chips.length !== 5 || g.chipsBad.length) bad.push(`chips ${at}`);
    }
    expect(bad).toEqual([]);
  });
});
