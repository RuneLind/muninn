/**
 * The MDX visual components' polish on the /wiki reader: `<Glossary>` term
 * marks (`src/format/glossary-view.ts`, `glossaryCss`), `<CaseBoard
 * view="dots">` squares (`src/format/case-dots-view.ts`, `caseDotsCss`, the
 * client in `views/components/wiki-visuals.ts`) and the derived timeline
 * lanes (`src/format/timeline-lanes.ts`, `timelineLanesCss`).
 *
 * What only a laid-out page can answer: each view draws in the theme's tokens
 * in both themes (compared to the token resolved on a body probe); a square
 * is pressed from the mouse and the keyboard and says its case in a polite
 * live line; a definition shows on hover and focus and Escape hides it;
 * print and forced colours; a peek copies none of the chrome; and nothing
 * runs past the page or a view at 390 px.
 *
 * No model calls, no DB rows: one muninn over a temp wiki holding one
 * synthetic page and its case board.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-polish");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-polish";
const REL = "plans/lending.mdx";

const PAGE = [
  "---",
  "title: Lending rules",
  "plan_status: in-flight",
  "---",
  "",
  "# Lending rules",
  "",
  "<StatusRows>",
  "",
  "- **Desk:** open · in prod",
  "",
  "</StatusRows>",
  "",
  "## Words",
  "",
  "<Glossary>",
  "",
  "**Words on the page**",
  "",
  "- **Hold:** a loan kept back until the desk has looked at it (D2).",
  "- **Renewal:** another loan period on the same book.",
  "",
  "</Glossary>",
  "",
  "## Loans",
  "",
  "A Hold stops a Renewal until the desk clears it; see D1. A second Hold is not marked.",
  "",
  "## Cases",
  "",
  '<CaseBoard src="cases.yaml" view="dots" />',
  "",
  "## Log",
  "",
  "<DecisionLog>",
  "",
  "- **D1** — A hold lasts a week. 01.09.2026",
  "- **D2** — Two renewals at most. 2026-09-15",
  "",
  "</DecisionLog>",
  "",
  '<Query id="Q-1" question="How many holds?" run="2026-09-10" />',
  "",
  "<Timeline>",
  "",
  "- **2026-09-01** — Desk opened",
  "- **2026-09-20** — Renewal rule reviewed",
  "",
  "</Timeline>",
  "",
].join("\n");

const CASES = [
  "- {id: LIB-101, status: hold, kort: Waits for a Renewal}",
  "- {id: LIB-102, status: hold}",
  "- {id: LIB-103, status: wait, kort: Asked the desk}",
  "- {id: LIB-104, status: wrong}",
  "- {id: LIB-105, status: none}",
  "- {id: LIB-106, status: ok, kort: Back on the shelf}",
  ...Array.from({ length: 24 }, (_, i) => `- {id: LIB-${200 + i}, status: ok}`),
].join("\n");

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-polish-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, REL), PAGE, "utf8");
  await writeFile(path.join(root, "plans/cases.yaml"), CASES, "utf8");
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

const dots = (page: Page) => page.locator(".wiki-article .cb-dots");
const lanes = (page: Page) => page.locator(".wiki-article section.tl-lanes");
const glossary = (page: Page) => page.locator(".wiki-article .glossary");

/** The page at `width`; `focus` drops the rail and the Ask pane (the F key). */
async function open(page: Page, width: number, focus = false): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
  await expect(dots(page)).toHaveCount(1);
  if (focus) {
    await page.locator("body").press("f");
    await expect(page.locator("#wikiFocusExit")).toBeVisible();
  }
  await expect(dots(page)).toBeVisible();
}

/** The colour `value` resolves to on a probe in `body` (a token or a system colour). */
const resolved = (page: Page, value: string, prop: "color" | "background-color" = "color") =>
  page.evaluate(
    ([v, p]) => {
      const probe = document.createElement("span");
      probe.style.setProperty(p!, v!);
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).getPropertyValue(p!);
      probe.remove();
      return c;
    },
    [value, prop],
  );

const css = (l: Locator, prop: string) => l.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);
const overflow = (l: Locator) => l.evaluate((e) => e.scrollWidth - e.clientWidth);
const shots = (name: string) => test.info().outputPath(`${name}.png`);

/** A tip's box and the client box of the nearest ancestor that clips it
 *  (overflow other than visible), cut to the viewport. */
function clipBoxOf(tip: Element) {
  const t = tip.getBoundingClientRect();
  let c = { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight };
  for (let el = tip.parentElement; el && el !== document.documentElement; el = el.parentElement) {
    const s = getComputedStyle(el);
    if (s.overflowX === "visible" && s.overflowY === "visible") continue;
    const r = el.getBoundingClientRect();
    const left = r.left + el.clientLeft;
    const top = r.top + el.clientTop;
    c = { left: Math.max(c.left, left), top: Math.max(c.top, top), right: Math.min(c.right, left + el.clientWidth), bottom: Math.min(c.bottom, top + el.clientHeight) };
    break;
  }
  return { t: { left: t.left, top: t.top, right: t.right, bottom: t.bottom }, c };
}

test.describe("Wiki reader: polish", () => {
  for (const scheme of ["dark", "light"] as const) {
    test(`${scheme}: squares, lanes and term marks draw in the theme's tokens`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 1280);
      const d = dots(page);
      await d.scrollIntoViewIfNeeded();
      const looks: [string, string, string][] = [
        ["hold", "--tint-warning", "--tone-warn"],
        ["wait", "--tint-info", "--tone-info"],
        ["wrong", "--tint-error", "--tone-err"],
        ["none", "--tint-neutral", "--text-soft"],
        ["ok", "--tint-success", "--tone-good"],
      ];
      for (const [status, tint, ink] of looks) {
        const dot = d.locator(`.cb-dot-${status}`).first();
        expect(await css(dot, "background-color"), status).toBe(await resolved(page, `var(${tint})`, "background-color"));
        expect(await css(dot, "color"), status).toBe(await resolved(page, `var(${ink})`));
        expect(await css(dot, "opacity")).toBe("1");
      }
      await d.screenshot({ path: shots(`1280-${scheme}-dots`) });

      const l = lanes(page);
      await l.scrollIntoViewIfNeeded();
      expect(await css(l.locator(".tll-decisions .tll-dot").first(), "background-color")).toBe(await resolved(page, "var(--accent-light)", "background-color"));
      expect(await css(l.locator(".tll-queries .tll-dot").first(), "background-color")).toBe(await resolved(page, "var(--tone-info)", "background-color"));
      expect(await css(l.locator(".tll-timeline .tll-dot").first(), "background-color")).toBe(await resolved(page, "var(--tone-warn)", "background-color"));
      expect(await css(l.locator(".tll-axis"), "color")).toBe(await resolved(page, "var(--text-soft)"));
      await l.screenshot({ path: shots(`1280-${scheme}-lanes`) });

      const term = page.locator(".wiki-article .gl-term").first();
      expect(await css(term, "text-decoration-color")).toBe(await resolved(page, "var(--text-secondary)"));
      await term.hover();
      const tip = page.locator(".wiki-article .gl-mark").first().locator(".gl-tip");
      await expect(tip).toBeVisible();
      expect(await css(tip, "background-color")).toBe(await resolved(page, "var(--bg-surface)", "background-color"));
      // The definition sits outside the mark's box: shoot the area holding both.
      const [a, b] = [(await term.boundingBox())!, (await tip.boundingBox())!];
      const x = Math.min(a.x, b.x) - 8;
      const y = Math.min(a.y, b.y) - 8;
      await page.screenshot({ path: shots(`1280-${scheme}-glossary`), clip: { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x + 8, height: Math.max(a.y + a.height, b.y + b.height) - y + 8 } });
    });

    for (const width of [700, 390] as const) {
      test(`${width} px${width === 390 ? " focus" : ""}, ${scheme}: nothing runs past the page or a view`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await open(page, width, width === 390);
        for (const [name, view] of [
          ["dots", dots(page)],
          ["lanes", lanes(page)],
          ["glossary", glossary(page)],
        ] as const) {
          await view.scrollIntoViewIfNeeded();
          expect(await overflow(view), name).toBeLessThanOrEqual(0);
          await view.screenshot({ path: shots(`${width}-${scheme}-${name}`) });
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      });
    }
  }

  test("each lane's marks sit inside its track at 390 px", async ({ page }) => {
    await open(page, 390, true);
    for (const track of await lanes(page).locator(".tll-track").all()) {
      const box = (await track.boundingBox())!;
      for (const dot of await track.locator(".tll-dot").all()) {
        const b = (await dot.boundingBox())!;
        expect(b.x).toBeGreaterThanOrEqual(box.x - b.width);
        expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + b.width);
      }
    }
  });

  test("a square is pressed from the mouse and says its case; pressing again releases it", async ({ page }) => {
    await open(page, 1280);
    const d = dots(page);
    await expect(d).toHaveAttribute("role", "group");
    const say = d.locator(".cb-dots-say");
    await expect(say).toHaveAttribute("aria-live", "polite");
    const first = d.getByRole("button", { name: "LIB-101: hold" });
    await first.click();
    await expect(first).toHaveAttribute("aria-pressed", "true");
    await expect(say).toHaveText("LIB-101 — hold: Waits for a Renewal");
    const other = d.getByRole("button", { name: "LIB-103: wait" });
    await other.click();
    await expect(first).toHaveAttribute("aria-pressed", "false");
    await expect(other).toHaveAttribute("aria-pressed", "true");
    await expect(say).toHaveText("LIB-103 — wait: Asked the desk");
    await other.click();
    await expect(d.locator('[aria-pressed="true"]')).toHaveCount(0);
    await expect(say).toHaveText("");
  });

  test("the squares are one tab stop; arrows, Home and End move; Enter presses", async ({ page }) => {
    await open(page, 1280);
    const d = dots(page);
    const all = d.locator("button.cb-dot");
    await expect(d.locator('button.cb-dot[tabindex="0"]')).toHaveCount(1);
    await all.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(all.nth(1)).toBeFocused();
    await expect(all.nth(1)).toHaveAttribute("tabindex", "0");
    await expect(all.first()).toHaveAttribute("tabindex", "-1");
    await page.keyboard.press("End");
    await expect(all.last()).toBeFocused();
    await page.keyboard.press("Home");
    await expect(all.first()).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(all.first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(all.first()).toHaveAttribute("aria-pressed", "true");
    expect(await css(all.first(), "outline-style")).not.toBe("none");
    // Tab leaves the set from the square focused last.
    await page.keyboard.press("Tab");
    await expect(all.nth(1)).not.toBeFocused();
  });

  test("a clicked square takes the tab stop, so Tab out and back lands on it", async ({ page }) => {
    await open(page, 1280);
    const all = dots(page).locator("button.cb-dot");
    const fourth = all.nth(3);
    await fourth.click();
    await expect(fourth).toHaveAttribute("tabindex", "0");
    await expect(dots(page).locator('button.cb-dot[tabindex="0"]')).toHaveCount(1);
    await page.keyboard.press("Tab");
    await expect(fourth).not.toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(fourth).toBeFocused();
  });

  test("Overview hides the none squares with the none rows; the arrows skip them", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}&lens=overview`);
    await expect(page.locator(".wiki-article.lens-overview")).toHaveCount(1);
    const d = dots(page);
    await expect(d.locator('.cb-dots-group[data-status="none"]')).toBeHidden();
    await expect(page.locator('.wiki-article .cb-group[data-status="none"]')).toBeHidden();
    await expect(d.locator('.cb-dots-group[data-status="ok"]')).toBeVisible();
    const wrong = d.getByRole("button", { name: "LIB-104: wrong" });
    await wrong.focus();
    await page.keyboard.press("ArrowRight");
    await expect(d.getByRole("button", { name: /^LIB-106: / })).toBeFocused();
    await expect(d.locator('button.cb-dot[tabindex="0"]')).toHaveCount(1);
    await page.locator(".wiki-lens-switch button[data-lens='all']").click();
    await expect(d.locator('.cb-dots-group[data-status="none"]')).toBeVisible();
    // A none square pressed in All holds the tab stop; back in Overview an arrow takes it away.
    await d.getByRole("button", { name: /^LIB-105: / }).click();
    await page.locator(".wiki-lens-switch button[data-lens='overview']").click();
    await wrong.focus();
    await page.keyboard.press("ArrowRight");
    await expect(d.locator('button.cb-dot[tabindex="0"]')).toHaveCount(1);
  });

  test("a definition shows on focus and Escape hides it", async ({ page }) => {
    await open(page, 1280);
    const mark = page.locator(".wiki-article .gl-mark").first();
    // First use per section: Hold and Renewal under Loans, hold (D1) and
    // Renewal (the Timeline) under Log; none in the board's strip or pills.
    await expect(page.locator(".wiki-article .gl-term")).toHaveText(["Hold", "Renewal", "hold", "Renewal"]);
    await expect(page.locator(".wiki-article .caseboard .gl-mark, .wiki-article .tl-lanes .gl-mark")).toHaveCount(0);
    await mark.locator(".gl-term").focus();
    await expect(mark.locator(".gl-tip")).toBeVisible();
    await expect(mark.locator(".gl-term")).toHaveAccessibleDescription(/Hold a loan kept back/);
    await page.keyboard.press("Escape");
    await expect(mark.locator(".gl-tip")).toBeHidden();
    // An id in a definition stays text: a link inside role=tooltip is a tab stop in a hidden tip.
    await expect(mark.locator(".gl-tip")).toContainText("(D2)");
    await expect(page.locator(".wiki-article .gl-tip a")).toHaveCount(0);
  });

  for (const width of [1280, 700, 390] as const) {
    test(`${width} px: every definition, a right-edge one too, stays inside the box that clips it`, async ({ page }) => {
      await open(page, width, width === 390);
      // A copy of the first term at the end of a right-aligned line: the column's right edge.
      await page.evaluate(() => {
        const mark = document.querySelector(".wiki-article .gl-mark")!;
        const line = document.createElement("div");
        line.style.textAlign = "end";
        line.append(mark.cloneNode(true));
        mark.after(line);
      });
      const marks = await page.locator(".wiki-article .gl-mark").all();
      expect(marks.length).toBe(5);
      for (const [i, mark] of marks.entries()) {
        await mark.scrollIntoViewIfNeeded();
        await mark.locator(".gl-term").focus();
        const tip = mark.locator(".gl-tip");
        await expect(tip).toBeVisible();
        const { t, c } = await tip.evaluate(clipBoxOf);
        expect(t.left, `term ${i} left`).toBeGreaterThanOrEqual(c.left - 0.5);
        expect(t.right, `term ${i} right`).toBeLessThanOrEqual(c.right + 0.5);
        expect(t.top, `term ${i} top`).toBeGreaterThanOrEqual(c.top - 0.5);
        expect(t.bottom, `term ${i} bottom`).toBeLessThanOrEqual(c.bottom + 0.5);
        await mark.locator(".gl-term").blur();
      }
      const edge = marks[1]!;
      for (const scheme of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await edge.locator(".gl-term").focus();
        await page.locator("#articleWrap").screenshot({ path: shots(`${width}-${scheme}-glossary-edge`) });
        await edge.locator(".gl-term").blur();
      }
    });
  }

  test("a term near the pane's bottom opens its definition above", async ({ page }) => {
    await open(page, 1280);
    // The last term: far enough down the page to scroll to the pane's foot.
    const mark = page.locator(".wiki-article .gl-mark").last();
    // Scroll the pane until the term sits 12 px above its bottom edge.
    await mark.evaluate((m) => {
      const wrap = document.getElementById("articleWrap")!;
      const w = wrap.getBoundingClientRect();
      const r = m.getBoundingClientRect();
      wrap.scrollTop += r.bottom - (w.top + wrap.clientTop + wrap.clientHeight - 12);
    });
    await mark.locator(".gl-term").evaluate((t) => (t as HTMLElement).focus({ preventScroll: true }));
    const tip = mark.locator(".gl-tip");
    await expect(tip).toBeVisible();
    const { t, c } = await tip.evaluate(clipBoxOf);
    const m = (await mark.locator(".gl-term").boundingBox())!;
    expect(c.bottom - (m.y + m.height), "the term sits at the pane's foot").toBeLessThan(20);
    expect(t.bottom).toBeLessThanOrEqual(m.y + 0.5);
    expect(t.top).toBeGreaterThanOrEqual(c.top - 0.5);
  });

  test("the pointer moved from a term into its definition keeps it open", async ({ page }) => {
    await open(page, 1280);
    const mark = page.locator(".wiki-article .gl-mark").first();
    await mark.scrollIntoViewIfNeeded();
    const term = (await mark.locator(".gl-term").boundingBox())!;
    const x = term.x + Math.min(6, term.width / 2);
    await page.mouse.move(x, term.y + term.height / 2);
    const tip = mark.locator(".gl-tip");
    await expect(tip).toBeVisible();
    const box = (await tip.boundingBox())!;
    expect(box.y).toBeGreaterThan(term.y);
    for (let y = Math.ceil(term.y + term.height / 2); y <= box.y + 6; y++) {
      await page.mouse.move(x, y);
      expect(await tip.evaluate((e) => getComputedStyle(e).display), `pointer at y=${y}`).not.toBe("none");
    }
    // Resting on the definition keeps it open.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(tip).toBeVisible();
  });

  test("forced colours: a pressed square is Highlight, the lanes' dots are CanvasText", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await open(page, 1280);
    const first = dots(page).locator("button.cb-dot").first();
    await first.click();
    // A system colour resolves on the probe's `color`: forced colours repaint a probe's background.
    expect(await css(first, "background-color")).toBe(await resolved(page, "Highlight"));
    expect(await css(lanes(page).locator(".tll-dot").first(), "background-color")).toBe(await resolved(page, "CanvasText"));
  });

  test("print hides the squares and the definitions; without the script the squares are gone", async ({ page }) => {
    await open(page, 1280);
    await page.emulateMedia({ media: "print" });
    await expect(dots(page)).toBeHidden();
    await expect(lanes(page)).toBeVisible();
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => document.documentElement.classList.remove("rt-js"));
    await expect(dots(page)).toBeHidden();
    await expect(page.locator(".wiki-article .cb-row")).toHaveCount(30);
  });

  test("a peek copies none of the polish chrome", async ({ page }) => {
    await open(page, 1280);
    // The lanes' hidden labels hold no link: it would be a tab stop nobody sees.
    await expect(lanes(page).locator("a")).toHaveCount(0);
    const link = page.locator(".wiki-article a.wiki-ref:visible", { hasText: "D1" }).first();
    await link.hover();
    const peek = page.locator(".wiki-ref-peek");
    await expect(peek).toBeVisible();
    await expect(peek.locator(".gl-tip, .gl-mark, .cb-dots, .tl-lanes")).toHaveCount(0);
  });
});
