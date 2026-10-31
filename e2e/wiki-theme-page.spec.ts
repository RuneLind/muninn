/**
 * The theme page (plan `muninn-wiki-theme-map`, P3): `?effort=<id>` on a wiki
 * whose `.work-map.json` is a themes map.
 *
 * The rendering rules are unit-tested (`wiki-theme-page.test.ts`); what only a
 * real page holds:
 *  1. The theme holding the newest source the map places opens with In
 *     short, Read first, Where the sources disagree, every hub (more than the
 *     card's 4), its sources newest first, the weekly strip over every stored
 *     week and Worth a look with the drift item's runner count; the Connections
 *     pane lists every connected theme (more than the card's 6) and the Domain
 *     section, and the crumb, footer and confidence tooltip speak of themes.
 *  2. The strip reads the READER's clock (`page.clock`): the run's week is
 *     framed as running while the reader is in it and as partial once it has
 *     ended, on the same map.
 *  3. A retired theme id opens its retired page.
 *  4. A theme name on the What you're following card lands on its page with
 *     no console error.
 *  5. The theme page and its retired view clear 4.5:1 in every theme; the
 *     classes only the theme page paints are swept here, not in
 *     `wiki-effort-page.spec.ts`.
 *  6. The strip's footer labels sit under its first and last bars (one label
 *     for one week), and the loading and error panes say theme.
 *
 * One muninn on its own port over one temp wiki whose `.wiki-reader.json`
 * declares `workMap: {"kind": "themes"}` and whose map is seeded, not run.
 * `SCHEDULER_ENABLED=false` keeps the loop off. Synthetic names only; no model
 * calls; no writes.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { assertPortFree, waitForOwnServer } from "./own-server.ts";
import { paintedMeasure } from "./contrast.ts";

const PORT = e2ePort("wiki-theme-page");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const WIKI = "e2e-theme-page";

/** Friday of ISO week 2026-W44 (Mon 10-26 – Sun 11-01). */
const RUN_AT = Date.parse("2026-10-30T03:00:00Z");
const IN_RUN_WEEK = new Date("2026-10-30T12:00:00Z");
const AFTER_RUN_WEEK = new Date("2026-11-04T12:00:00Z");

const OTHERS = ["t1", "t2", "t3", "t4", "t5", "t6", "t7"];
const HUBS = ["Hub Kite", "Hub Lark", "Hub Wren", "Hub Owl", "Hub Finch", "Hub Crane"].map((h) => `concepts/${h}.md`);

/** relPath → [title, created]. Sources only; hubs are added below. */
const SOURCES: Record<string, [string, string]> = {
  "sources/kite-old.mdx": ["Kite source old", "2026-10-06"],
  "sources/kite-new.mdx": ["Kite source new", "2026-10-29"],
  "sources/kite-mid.mdx": ["Kite source mid", "2026-10-20"],
  "sources/wind-one.mdx": ["Wind source one", "2026-10-22"],
  "life/sources/walk-one.mdx": ["Walk source one", "2026-10-18"],
  "sources/retired-one.mdx": ["Retired source one", "2026-10-08"],
  ...Object.fromEntries(OTHERS.map((t, i) => [`sources/${t}-one.mdx`, [`Source of ${t}`, `2026-10-${String(10 + i).padStart(2, "0")}`]])),
};

const week = (w: string, start: string, count: number, partial = false) => ({ week: w, start, count, ...(partial ? { partial } : {}) });
/** Ten weeks, W35–W44: more than the card's eight. */
const WEEKLY = [
  week("2026-W35", "2026-08-24", 2, true),
  week("2026-W36", "2026-08-31", 0),
  week("2026-W37", "2026-09-07", 1),
  week("2026-W38", "2026-09-14", 3),
  week("2026-W39", "2026-09-21", 0),
  week("2026-W40", "2026-09-28", 1),
  week("2026-W41", "2026-10-05", 1),
  week("2026-W42", "2026-10-12", 0),
  week("2026-W43", "2026-10-19", 1),
  week("2026-W44", "2026-10-26", 1),
];

function theme(id: string, name: string, state: string, pages: string[], extra: Record<string, unknown> = {}) {
  return {
    id, name, oneLine: `About ${name}.`, state, domain: "ai",
    pages: pages.map((p) => ({ id: p, role: "source" })),
    hubs: [HUBS[0]], readFirst: [pages[0]], takeaway: "", disagreement: "", confidence: 0.7,
    related: [], weekly: WEEKLY.slice(-3), trend: { recent: 1, earlier: 1 }, ...extra,
  };
}

const MAP = {
  version: 1, kind: "themes", wiki: WIKI, runAtMs: RUN_AT, model: "test-model",
  coverage: { activeSources: 13, hubs: 6, driftHubs: 1, placed: 12, digestChars: 1000, windowDays: 28, warnings: [] },
  summary: "Mostly kites.",
  needsYou: [
    { title: "Hub Kite is behind", kind: "drift", why: "Nine sources arrived since its update.", action: "Refresh Hub Kite.", pages: ["sources/kite-new.mdx"], effort: "kites", hubs: [HUBS[0], HUBS[1]], count: 9 },
  ],
  themes: [{ name: "AI & tech", efforts: ["kites", "winds", ...OTHERS] }, { name: "Life", efforts: ["walks"] }],
  efforts: [
    theme("kites", "Rising kites", "rising", ["sources/kite-old.mdx", "sources/kite-new.mdx", "sources/kite-mid.mdx"], {
      readFirst: ["sources/kite-mid.mdx"],
      takeaway: "Kites fly best in steady wind, see ⟦sources/kite-new.mdx⟧.",
      disagreement: "⟦sources/kite-old.mdx⟧ says tails help; ⟦sources/kite-mid.mdx⟧ says they drag.",
      hubs: HUBS,
      weekly: WEEKLY,
      related: [{ id: "winds", why: "Both need wind." }, ...OTHERS.map((t) => ({ id: t, why: `Kites and ${t}.` }))],
    }),
    theme("winds", "Steady winds", "steady", ["sources/wind-one.mdx"], { related: [{ id: "kites", why: "The other end." }], weekly: WEEKLY.slice(-5) }),
    ...OTHERS.map((t) => theme(t, `Theme ${t}`, "steady", [`sources/${t}-one.mdx`], { related: [{ id: "kites", why: `${t} and kites.` }] })),
    theme("walks", "Morning walks", "steady", ["life/sources/walk-one.mdx"], { domain: "life", weekly: WEEKLY.slice(-1) }),
  ],
  retired: [{ id: "old-tides", name: "Old tides", lastActive: Date.parse("2026-10-08T00:00:00Z"), weekly: WEEKLY.slice(0, 6), members: ["sources/retired-one.mdx"] }],
  loose: [],
};

let root = "";
let server: ChildProcess | undefined;

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), `muninn-e2e-${WIKI}-`));
  await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify({ workMap: { kind: "themes" } }), "utf8");
  const write = async (rel: string, title: string, type: string, created: string) => {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, ["---", `title: ${title}`, `type: ${type}`, `created: ${created}`, "---", "", `Body of ${title}.`, ""].join("\n"), "utf8");
  };
  for (const [rel, [title, created]] of Object.entries(SOURCES)) await write(rel, title, "source", created);
  for (const rel of HUBS) await write(rel, path.basename(rel, ".md"), "concept", "2026-01-01");
  await writeFile(path.join(root, ".work-map.json"), JSON.stringify(MAP), "utf8");
  await assertPortFree(PORT);
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WORK_MAP_WIKIS: "",
      WIKI_DIR: "",
      WIKI_EXTRA: `${WIKI}=${root}`,
    },
    stdio: "ignore",
  });
  await waitForOwnServer(server, `${BASE}/api/wiki/pages?wiki=${WIKI}`);
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  if (root) await rm(root, { recursive: true, force: true });
});

/** The theme holding the newest source the map places, computed from the fixture. */
function newestSourceTheme(): string {
  const placed = MAP.efforts.flatMap((e) => e.pages.map((p) => ({ theme: e.id, created: SOURCES[p.id]![1] })));
  placed.sort((a, b) => b.created.localeCompare(a.created));
  return placed[0]!.theme;
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function openTheme(page: Page, id: string): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&effort=${id}`);
  await expect(page.locator(`#wikiEffortPage[data-effort="${id}"]`)).toBeVisible();
}

const slotMarks = (page: Page) =>
  page.locator("#wikiEffortPage .wiki-ef-weekly .wiki-wm-slot").evaluateAll((els) => els.map((e) => e.className.replace("wiki-wm-slot", "").trim()));

test("the theme holding the newest source opens with every section, all hubs and all connected themes", async ({ page }) => {
  const errors = trackErrors(page);
  await page.clock.setFixedTime(IN_RUN_WEEK);
  const id = newestSourceTheme();
  expect(id).toBe("kites");
  await openTheme(page, id);
  const ef = page.locator("#wikiEffortPage");
  await expect(ef).toHaveAttribute("data-kind", "themes");
  await expect(ef.locator("h1")).toHaveText("Rising kites");

  // The crumb names the domain group, not «Efforts».
  await expect(ef.locator(".wiki-ef-crumbs [data-effort-home]")).toHaveText("AI & tech");
  await expect(ef.locator(".wiki-ef-crumbs")).not.toContainText("Efforts");

  // In short: oneLine and takeaway.
  await expect(ef.locator(".wiki-ef-tldr .wiki-ef-oneline")).toHaveText("About Rising kites.");
  await expect(ef.locator(".wiki-ef-tldr .wiki-ef-takeaway")).toHaveText("Takeaway: Kites fly best in steady wind, see Kite source new.");

  // Read first, disagreement, hubs.
  await expect(ef.locator(".wiki-ef-readfirst a[data-relpath]")).toHaveText(["Kite source mid"]);
  await expect(ef.locator(".wiki-ef-disagree")).toContainText("Where the sources disagree");
  await expect(ef.locator(".wiki-ef-disagree")).toContainText("Kite source old says tails help; Kite source mid says they drag.");
  const hubs = await ef.locator(".wiki-ef-hubsec a[data-relpath]").evaluateAll((els) => els.map((e) => e.getAttribute("data-relpath")));
  expect(hubs).toEqual(HUBS);
  expect(hubs.length).toBeGreaterThan(4);

  // Sources, newest first.
  await expect(ef.locator(".wiki-ef-sources a[data-relpath]")).toHaveText(["Kite source new", "Kite source mid", "Kite source old"]);

  // Worth a look: the drift item's runner count and its hubs.
  const need = ef.locator(".wiki-ef-need");
  await expect(need.locator(".wiki-ef-kind")).toHaveText("drift");
  await expect(need.locator(".wiki-wm-need-count")).toHaveText("9 new since update");
  await expect(need.locator(".wiki-wm-hub a")).toHaveText(["Hub Kite", "Hub Lark"]);

  // The weekly strip: every stored week, the run's week running.
  await expect(ef.locator(".wiki-ef-weekly .wiki-wm-slot")).toHaveCount(WEEKLY.length);
  expect(await slotMarks(page)).toEqual(["partial", "", "", "", "", "", "", "", "", "current"]);
  await expect(ef.locator(".wiki-ef-weekly .wiki-wm-weeks-earlier")).toHaveCount(0);

  // Wording: footer and confidence tooltip.
  await expect(ef.locator(".wiki-ef-foot")).toContainText("From the theme map organized");
  await expect(ef.locator(".wiki-ef-meta", { hasText: "confidence" })).toHaveAttribute("title", "How sure the theme run was that these sources share one theme");

  // Connections: every connected theme, more than the card's six, and the Domain section.
  const conn = page.locator("#connBody");
  await expect(conn.locator(".wiki-ef-conn-title").first()).toHaveText(`Connected themes (${OTHERS.length + 1})`);
  const linked = await conn.locator(".wiki-conn-section").first().locator("[data-effort-link]").evaluateAll((els) => els.map((e) => e.getAttribute("data-effort-link")));
  expect(linked).toEqual(["winds", ...OTHERS]);
  expect(linked.length).toBeGreaterThan(6);
  await expect(conn.locator(".wiki-ef-conn-title").nth(1)).toHaveText("Domain");
  await expect(conn).not.toContainText("Related efforts");
  await expect(conn).not.toContainText("This effort is in no theme.");

  // A connected theme opens in the reader.
  await conn.locator('[data-effort-link="winds"]').click();
  await expect(page.locator('#wikiEffortPage[data-effort="winds"]')).toBeVisible();
  await expect(page).toHaveURL(/effort=winds/);
  expect(errors).toEqual([]);
});

test("the run's week reads as partial once the reader's clock has left it", async ({ page }) => {
  await page.clock.setFixedTime(AFTER_RUN_WEEK);
  await openTheme(page, "kites");
  expect(await slotMarks(page)).toEqual(["partial", "", "", "", "", "", "", "", "", "partial"]);
  await expect(page.locator("#wikiEffortPage .wiki-ef-weekly .wiki-wm-weeks")).not.toHaveAttribute("aria-label", /this week so far/);
});

test("a retired theme id opens its retired page", async ({ page }) => {
  await page.clock.setFixedTime(IN_RUN_WEEK);
  await openTheme(page, "old-tides");
  const ef = page.locator("#wikiEffortPage");
  await expect(ef).toHaveClass(/wiki-effort-retired/);
  await expect(ef.locator("h1")).toHaveText("Old tides");
  await expect(ef.locator("[data-effort-last-active]")).toHaveText("last active 2026-10-08");
  await expect(ef.locator(".wiki-ef-sources a[data-relpath]")).toHaveText(["Retired source one"]);
  await expect(ef.locator(".wiki-ef-weekly .wiki-wm-slot")).toHaveCount(6);
});

/** The strip's last bar and its footer labels, in page coordinates. */
async function stripFoot(page: Page) {
  return page.locator("#wikiEffortPage .wiki-ef-weekly").evaluate((sec) => {
    const bars = Array.from(sec.querySelectorAll(".wiki-wm-slot")).map((b) => b.getBoundingClientRect());
    const labels = Array.from(sec.querySelectorAll(".wiki-ef-strip-foot > span")).map((l) => {
      const r = l.getBoundingClientRect();
      return { text: l.textContent, left: r.left, right: r.right, top: r.top };
    });
    return { firstLeft: bars[0]!.left, lastRight: bars.at(-1)!.right, labels };
  });
}

test("the strip's footer labels sit under its first and last bars, one label for one week", async ({ page }) => {
  await page.clock.setFixedTime(IN_RUN_WEEK);
  // Ten weeks (one line of labels), five (the real jarvis map) and three (too narrow for one line), and one week.
  for (const [id, first, last] of [["kites", "2026-W35", "2026-W44"], ["winds", "2026-W40", "2026-W44"], ["t1", "2026-W42", "2026-W44"]] as const) {
    await openTheme(page, id);
    const f = await stripFoot(page);
    expect(f.labels.map((l) => l.text), id).toEqual([first, last]);
    expect(Math.abs(f.labels[1]!.right - f.lastRight), `${id} newest label`).toBeLessThanOrEqual(2);
    expect(Math.abs(f.labels[0]!.left - f.firstLeft), `${id} first label`).toBeLessThanOrEqual(2);
    // The labels never overlap.
    expect(f.labels[1]!.left >= f.labels[0]!.right || f.labels[1]!.top > f.labels[0]!.top, `${id} overlap`).toBe(true);
  }
  await openTheme(page, "walks");
  const one = await stripFoot(page);
  expect(one.labels.map((l) => l.text)).toEqual(["2026-W44"]);
  expect(Math.abs(one.labels[0]!.left - one.firstLeft)).toBeLessThanOrEqual(2);
});

test("while the map loads and when its GET fails, the panes say theme", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/wiki/work-map?*", async (route) => {
    await held;
    await route.fulfill({ status: 500, json: { error: "down" } });
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&effort=kites`);
  const ef = page.locator("#wikiEffortPage");
  await expect(ef).toHaveAttribute("data-effort-status", "loading");
  await expect(ef.locator(".wiki-ef-status")).toHaveText("Loading the theme map…");
  await expect(ef.locator(".wiki-ef-crumbs [data-effort-home]")).toHaveText("Themes");
  release();
  await expect(ef).toHaveAttribute("data-effort-status", "error");
  await expect(ef.locator(".wiki-ef-status")).toHaveText("Couldn’t load the theme map: HTTP 500");
  await expect(ef.locator(".wiki-ef-crumbs [data-effort-home]")).toHaveText("Themes");
  await expect(page.locator("#connBody")).toHaveText("No theme map.");
});

const THEMES: { label: string; stored: string | null; scheme: "light" | "dark" }[] = [
  { label: "Light", stored: "light", scheme: "dark" },
  { label: "Dark", stored: "dark", scheme: "light" },
  { label: "Reading mode", stored: "reading", scheme: "light" },
  { label: "Light reading mode", stored: "paper-light", scheme: "dark" },
  { label: "System light", stored: null, scheme: "light" },
  { label: "System dark", stored: null, scheme: "dark" },
];

/** Every text-painting element under `selector`, with its contrast; and every class painted. */
async function sweep(page: Page, selector: string, label: string): Promise<{ low: string[]; classes: string[] }> {
  const measure = await paintedMeasure(page);
  const { what, ratios, classes } = await page.locator(selector).evaluate((root, measure) => {
    const what: string[] = [];
    const ratios: number[] = [];
    const classes: string[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
      if (!el.checkVisibility({ visibilityProperty: true })) continue;
      classes.push(...Array.from(el.classList));
      if (!Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())) continue;
      what.push(`${el.tagName.toLowerCase()}.${Array.from(el.classList).join(".")} "${el.textContent!.trim().slice(0, 30)}"`);
      ratios.push(measure(el, false, false));
    }
    return { what, ratios, classes };
  }, measure);
  expect(what.length, `${label}: nothing to measure`).toBeGreaterThan(0);
  return { low: ratios.flatMap((r, i) => (r < 4.5 ? [`${label}: ${what[i]} ${r.toFixed(2)}`] : [])), classes };
}

for (const theme of THEMES) {
  test(`the theme page is legible in the ${theme.label} theme`, async ({ page }) => {
    await page.clock.setFixedTime(IN_RUN_WEEK);
    await page.emulateMedia({ colorScheme: theme.scheme });
    await page.addInitScript((v) => {
      if (v === null) localStorage.removeItem("muninn-theme");
      else localStorage.setItem("muninn-theme", v);
    }, theme.stored);
    const low: string[] = [];
    const seen = new Set<string>();
    for (const id of ["kites", "old-tides"]) {
      await openTheme(page, id);
      for (const sel of ["#articleWrap", "#connBody"]) {
        const r = await sweep(page, sel, `${id} ${sel}`);
        low.push(...r.low);
        r.classes.forEach((c) => seen.add(c));
      }
    }
    // The theme page's own styled classes are painted here.
    for (const c of ["wiki-ef-hubs", "wiki-ef-weekly", "wiki-ef-weekbox", "wiki-ef-week-foot", "wiki-ef-week-first", "wiki-ef-week-last"]) expect(seen.has(c), c).toBe(true);
    expect(low).toEqual([]);
  });
}

test("a theme name on the What you're following card lands on its page with no console error", async ({ page }) => {
  const errors = trackErrors(page);
  await page.clock.setFixedTime(IN_RUN_WEEK);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
  const card = page.locator("#wikiWorkCard");
  await expect(card.locator(".wiki-wn-title")).toHaveText("What you’re following");
  await card.locator('.wiki-wm-theme[data-effort-id="kites"] [data-effort-link="kites"]').click();
  await expect(page.locator('#wikiEffortPage[data-effort="kites"]')).toBeVisible();
  await expect(page).toHaveURL(/[?&]effort=kites(&|$)/);
  await expect(page.locator("#wikiEffortPage .wiki-ef-tldr")).toBeVisible();
  // Back returns to the card.
  await page.goBack();
  await expect(page.locator("#wikiWorkCard .wiki-wn-title")).toHaveText("What you’re following");
  expect(errors).toEqual([]);
});
