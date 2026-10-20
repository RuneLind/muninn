/**
 * `<RuleTree>` on the /wiki reader (`ruleTreeBlockHtml` in
 * `src/web/web-format.ts`, the view in `src/format/rule-tree-view.ts`, CSS in
 * `ruleTreeCss`, the picker in `views/components/wiki-visuals.ts`), and in a
 * chat bubble.
 *
 * What only a laid-out page can answer: the tree draws in the theme's tokens
 * in both themes; a picked case marks its path and dims the rest by ink and
 * border, not opacity, at 3:1 or better; the picker works from the keyboard;
 * without the script's flag the picker is gone and the case chips stay; print
 * and forced colours; right to left; a peek shows the list only; an Explain
 * selection across the tree locates in the source; nothing runs past the page
 * or a tree at 390 px; and chat gets the list.
 *
 * No model calls, no DB rows: one muninn over a temp wiki holding one
 * synthetic plan page and its case board; the Explain route is stubbed at the
 * network boundary.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { EXPLAIN_FULL_BODY_MAX, locateExcerpt } from "../src/wiki/explain-context.ts";

const PORT = e2ePort("wiki-rule-tree");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-rule-tree";
const REL = "plans/loans.mdx";

const LOAN_TREE = [
  '<RuleTree title="Can the book be [[renewal|renewed]]?" outcomes="Renew=good;Return=muted;Ask staff=warn">',
  "",
  "- Is the book reserved by someone else?",
  "  - *Yes:* → Return (D2) — LIB-101, LIB-102",
  "  - *No:* Has it been renewed three times this year?",
  "    - *Yes:* → Ask staff — LIB-103",
  "    - *No:* → Renew — LIB-104",
  "",
  "</RuleTree>",
];

const LONG = "a label long enough that it has to wrap onto more lines at phone width";
const DEEP_TREE = [
  `<RuleTree title="A deep rule whose title is ${LONG}" outcomes="Renew=good">`,
  "",
  ...Array.from({ length: 6 }, (_, i) => `${"  ".repeat(i)}- *Step ${i + 1}:* ${LONG}`),
  `${"  ".repeat(6)}- → Renew — LIB-201`,
  "",
  "</RuleTree>",
];

const PAGE = [
  "---",
  "title: Loan rules",
  "plan_status: in-flight",
  "---",
  "",
  "# Loan rules",
  "",
  // Filler: the page is past Explain's full-body size, so only a located
  // selection brings the tree's list into the excerpt.
  ...Array.from({ length: 20 }, (_, i) => `Background paragraph ${i + 1}: a synthetic line of prose that only pads the page so Explain has to locate a selection.\n`),
  "## Cases",
  "",
  '<CaseBoard src="cases.yaml" />',
  "",
  "## Loan rule",
  "",
  ...LOAN_TREE,
  "",
  "The line after the loan tree.",
  "",
  "## Explain",
  "",
  "The line before the explain tree, written long enough that a selection's first words stay inside it.",
  "",
  '<RuleTree title="Explain tree" outcomes="Renew=good">',
  "",
  "- Is the card valid?",
  "  - *Yes:* → Renew — LIB-301",
  "",
  "</RuleTree>",
  "",
  "The line after the explain tree; see «Loan rule» for the full rule.",
  "",
  "## Deep rule",
  "",
  ...DEEP_TREE,
  "",
].join("\n");

const CASES = [
  "- id: LIB-101",
  "  status: hold",
  "  kort: Two loans open",
  "- id: LIB-103",
  "  status: wait",
  "  kort: Renewed three times",
].join("\n");

const ID_LABELS = { LIB: { one: "Loan", other: "loans" } };

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-rule-tree-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, REL), PAGE, "utf8");
  await writeFile(path.join(root, "plans/cases.yaml"), CASES, "utf8");
  // The reader names a linked LIB id with a noun before it, inside the chip.
  await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify({ idLabels: ID_LABELS }), "utf8");
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

const loanTree = (page: Page) => page.locator('.wiki-article section.rt[aria-label="Can the book be renewed?"]');
const row = (t: Locator, text: string) => t.locator("li.rt-node", { has: t.page().locator(":scope > .rt-row", { hasText: text }) });

/** The page at `width`; `focus` drops the rail and the Ask pane (the F key). */
async function open(page: Page, width: number, focus = false): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}`);
  await expect(page.locator(".wiki-article section.rt")).toHaveCount(3);
  if (focus) {
    await page.locator("body").press("f");
    await expect(page.locator("#wikiFocusExit")).toBeVisible();
  }
}

/** The colour `value` resolves to on a probe in `body` (a token or a system colour). */
const resolved = (page: Page, value: string) =>
  page.evaluate((v) => {
    const probe = document.createElement("span");
    probe.style.color = v;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, value);

const css = (l: Locator, prop: string) => l.evaluate((e, p) => getComputedStyle(e).getPropertyValue(p), prop);

/** WCAG contrast of `el`'s text colour against `bgOf`'s background. */
const contrast = async (el: Locator, bgOf: Locator) =>
  el.evaluate(
    (e, bg) => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      const rgb = (v: string) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = v;
        ctx.fillRect(0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
      };
      const lum = ([r, g, b]: number[]) => {
        const f = (x: number) => ((x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
      };
      const [a, b] = [lum(rgb(getComputedStyle(e).color)), lum(rgb(bg))].sort((x, y) => y - x);
      return (a! + 0.05) / (b! + 0.05);
    },
    await bgOf.evaluate((e) => getComputedStyle(e).backgroundColor),
  );

const shots = (name: string) => test.info().outputPath(`${name}.png`);

test.describe("Wiki reader: RuleTree", () => {
  for (const scheme of ["dark", "light"] as const) {
    test(`${scheme}: the tree draws in the theme's tokens, and a pick dims the rest at 3:1 or better`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 1280);
      const t = loanTree(page);
      await t.scrollIntoViewIfNeeded();
      expect(await css(t, "background-color")).toBe(await resolved(page, "var(--bg-panel)"));
      const renew = row(t, "Renew").last().locator(":scope > .rt-row");
      expect(await css(renew, "color")).toBe(await resolved(page, "var(--text-primary)"));
      expect(await css(renew, "border-inline-start-color")).toBe(await resolved(page, "var(--tone-good)"));
      expect(await css(row(t, "Return").locator(":scope > .rt-row"), "border-inline-start-color")).toBe(await resolved(page, "var(--text-soft)"));
      await expect(t.locator(".rt-select")).toBeVisible();
      await t.screenshot({ path: shots(`1280-${scheme}-unpicked`) });

      await t.locator(".rt-select").selectOption("LIB-103");
      await expect(t).toHaveClass(/rt-picked/);
      await expect(t.locator("li.rt-on")).toHaveCount(3);
      await expect(t.locator("li.rt-off")).toHaveCount(2);
      await expect(t.locator(".rt-case.rt-hit")).toHaveCount(1);
      await expect(t.locator(".rt-case.rt-hit")).toHaveAttribute("data-rt-case", "LIB-103");
      // LIB-103 is a board id, so the reader links it to its row: the ink that
      // shows is the link's, read against the chip's fill.
      const hit = t.locator(".rt-case.rt-hit");
      const ink = hit.locator("a.wiki-ref");
      await expect(ink).toHaveCount(1);
      expect(await contrast(ink, hit), `${await css(ink, "color")} on ${await css(hit, "background-color")}`).toBeGreaterThanOrEqual(4.5);
      await expect(t.locator('[data-rt-kort="LIB-103"]')).toBeVisible();
      await expect(t.locator('[data-rt-kort="LIB-101"]')).toBeHidden();
      const off = row(t, "Return").locator(":scope > .rt-row");
      expect(await css(off, "color")).toBe(await resolved(page, "var(--text-soft)"));
      expect(await css(off, "border-top-style")).toBe("dashed");
      expect(await css(off, "opacity")).toBe("1");
      expect(await contrast(off, t)).toBeGreaterThanOrEqual(3);
      expect(await css(row(t, "Ask staff").locator(":scope > .rt-row"), "border-top-style")).toBe("solid");
      await t.screenshot({ path: shots(`1280-${scheme}-picked`) });

      await t.locator(".rt-select").selectOption("");
      await expect(t).not.toHaveClass(/rt-picked/);
      await expect(t.locator("li.rt-on, li.rt-off, .rt-hit")).toHaveCount(0);
      await expect(t.locator(".rt-kort:visible")).toHaveCount(0);
    });

    test(`${scheme}: 700 px, unpicked and picked`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 700);
      const t = loanTree(page);
      await t.scrollIntoViewIfNeeded();
      expect(await t.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
      await t.screenshot({ path: shots(`700-${scheme}-unpicked`) });
      await t.locator(".rt-select").selectOption("LIB-101");
      await expect(t.locator('[data-rt-kort="LIB-101"]')).toHaveText("Loan LIB-101 · Two loans open");
      await t.screenshot({ path: shots(`700-${scheme}-picked`) });
    });

    test(`390 px focus, ${scheme}: nothing runs past the page or a tree, and long labels wrap`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, 390, true);
      for (const t of await page.locator(".wiki-article section.rt").all()) {
        await t.scrollIntoViewIfNeeded();
        expect(await t.evaluate((e) => e.scrollWidth - e.clientWidth), (await t.getAttribute("aria-label")) ?? "").toBeLessThanOrEqual(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      const deep = page.locator(".wiki-article section.rt").last();
      const label = deep.locator(".rt-row").last();
      expect((await label.boundingBox())!.height).toBeLessThan(40);
      const long = deep.locator(".rt-row").nth(3);
      expect((await long.boundingBox())!.height).toBeGreaterThan(30); // it wrapped onto more lines
      await deep.screenshot({ path: shots(`390-${scheme}-deep`) });
      const t = loanTree(page);
      await t.scrollIntoViewIfNeeded();
      await t.screenshot({ path: shots(`390-${scheme}-unpicked`) });
      await t.locator(".rt-select").selectOption("LIB-104");
      expect(await t.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);
      await t.screenshot({ path: shots(`390-${scheme}-picked`) });
    });
  }

  test("the picker is reached and changed from the keyboard", async ({ page }) => {
    await open(page, 1280);
    const t = loanTree(page);
    const select = t.locator(".rt-select");
    await expect(select).toHaveAccessibleName(/Case/);
    await select.focus();
    await expect(select).toBeFocused();
    expect(await css(select, "outline-style")).not.toBe("none");
    // Type-ahead picks an option on a closed native select on every platform.
    await page.keyboard.type("LIB-101");
    await expect(select).toHaveValue("LIB-101");
    await expect(t).toHaveClass(/rt-picked/);
    await expect(t.locator('[data-rt-kort="LIB-101"]')).toBeVisible();
  });

  test("a pick marks its leaves for a screen reader and says what it found", async ({ page }) => {
    await open(page, 1280);
    const t = loanTree(page);
    const select = t.locator(".rt-select");
    await expect(select).toHaveAccessibleName("Case — Can the book be renewed?");
    const live = t.locator("[data-rt-live]");
    await expect(live).toHaveAttribute("aria-live", "polite");
    await expect(live).toHaveText("");
    await expect(t.locator("[aria-current]")).toHaveCount(0);
    await select.selectOption("LIB-101");
    const current = t.locator('li.rt-leaf[aria-current="true"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute("data-rt-cases", /LIB-101/);
    await expect(live).toHaveText("LIB-101: 1 leaf — Return. Loan LIB-101 · Two loans open");
    // Read by a screen reader, never seen: one pixel, clipped.
    expect(await live.evaluate((e) => e.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
    await select.selectOption("LIB-104");
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute("data-rt-cases", /LIB-104/);
    await expect(live).toHaveText("LIB-104: 1 leaf — Renew");
    await select.selectOption("");
    await expect(t.locator("[aria-current]")).toHaveCount(0);
    await expect(live).toHaveText("");
    await select.selectOption("LIB-103");
    await page.emulateMedia({ media: "print" });
    await expect(live).toBeHidden();
    await page.emulateMedia({ media: "screen" });
  });

  test("without the script's flag the picker is gone and the case chips stay", async ({ page }) => {
    await open(page, 1280);
    await page.evaluate(() => document.documentElement.classList.remove("rt-js"));
    const t = loanTree(page);
    await expect(t.locator(".rt-pick")).toBeHidden();
    await expect(t.locator(".rt-case")).toHaveCount(4);
    for (const c of await t.locator(".rt-case").all()) await expect(c).toBeVisible();
  });

  test("a case the wiki names with an idLabels noun still lights its chip", async ({ page }) => {
    await open(page, 1280);
    const t = loanTree(page);
    // The fixture's precondition: the reader put the noun inside the chip.
    await expect(t.locator(".rt-case", { hasText: "LIB-101" }).locator(".id-noun")).toHaveText("Loan");
    await t.locator(".rt-select").selectOption("LIB-101");
    const hit = t.locator(".rt-case.rt-hit");
    await expect(hit).toHaveCount(1);
    await expect(hit).toHaveAttribute("data-rt-case", "LIB-101");
    await expect(hit).toContainText("LIB-101");
  });

  test("print shows the tree as unpicked: no picker, no kort lines, no pick", async ({ page }) => {
    await open(page, 1280);
    const t = loanTree(page);
    await t.scrollIntoViewIfNeeded();
    // Every row, edge label, chip and chip link: weight, ink, fill and all four borders.
    const look = () =>
      t.evaluate((s) =>
        Array.from(s.querySelectorAll(".rt-row, .rt-edge, .rt-case, .rt-case a")).map((e) => {
          const c = getComputedStyle(e);
          const sides = ["top", "right", "bottom", "left"].flatMap((k) =>
            ["style", "color", "width"].map((p) => c.getPropertyValue(`border-${k}-${p}`)),
          );
          return [e.tagName, c.fontWeight, c.color, c.backgroundColor, ...sides].join(" | ");
        }),
      );
    await page.emulateMedia({ media: "print" });
    const unpicked = await look();
    await t.screenshot({ path: shots("print-unpicked") });
    await page.emulateMedia({ media: "screen" });
    await t.locator(".rt-select").selectOption("LIB-103");
    await expect(t).toHaveClass(/rt-picked/);
    await page.emulateMedia({ media: "print" });
    await t.screenshot({ path: shots("print-picked") });
    await page.pdf({ path: test.info().outputPath("print-picked.pdf") });
    await expect(t.locator(".rt-pick")).toBeHidden();
    await expect(t.locator(".rt-korts")).toBeHidden();
    await expect(t.locator(".rt-list").first()).toBeVisible();
    expect(await look()).toEqual(unpicked);
    for (const e of await t.locator(".rt-edge").all()) {
      for (const side of ["top", "right", "bottom", "left"]) expect(await css(e, `border-${side}-style`)).toBe("none");
    }
  });

  test("forced colours mark the path in system colours and the rest by a dashed GrayText border", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await open(page, 1280);
    const t = loanTree(page);
    await t.locator(".rt-select").selectOption("LIB-103");
    const [gray, highlight] = [await resolved(page, "GrayText"), await resolved(page, "Highlight")];
    const off = row(t, "Return").locator(":scope > .rt-row");
    expect(await css(off, "border-top-color")).toBe(gray);
    expect(await css(off, "border-top-style")).toBe("dashed");
    expect(await css(row(t, "Ask staff").locator(":scope > .rt-row"), "border-top-color")).toBe(highlight);
    expect(await css(t.locator(".rt-case.rt-hit"), "background-color")).toBe(highlight);
    expect(await css(t.locator(".rt-case.rt-hit a"), "color")).toBe(await resolved(page, "HighlightText"));
  });

  test("right to left, the branch lines sit on the start side", async ({ page }) => {
    await open(page, 1280);
    const t = loanTree(page);
    await t.evaluate((s) => s.setAttribute("dir", "rtl"));
    const nested = t.locator(".rt-list .rt-list").first();
    expect(await css(nested, "border-right-width")).toBe("1px");
    expect(await css(nested, "border-left-width")).toBe("0px");
    const leaf = row(t, "Renew").last().locator(":scope > .rt-row");
    expect(await css(leaf, "border-right-width")).toBe("4px");
  });

  test("a peek shows the list and none of the tree's chrome or wiring", async ({ page }) => {
    await open(page, 1280);
    // Picked first: the peek clones the live tree, pick state included.
    await loanTree(page).locator(".rt-select").selectOption("LIB-101");
    await expect(loanTree(page).locator('li[aria-current="true"]')).toHaveCount(1);
    await page.locator(".wiki-article a.wiki-ref", { hasText: "Loan rule" }).first().hover();
    const peek = page.locator(".wiki-ref-peek");
    await expect(peek).toBeVisible();
    await expect(peek.locator("li").first()).toContainText("Is the book reserved by someone else?");
    // The reader's idLabels noun rides into the peek copy with the chip's link
    // (pinned as it is today; a peek dropping it is a follow-up).
    await expect(peek).toContainText("Return (D2) — Loan LIB-101, LIB-102");
    await expect(peek.locator("select, .rt-head, [class*='rt-'], [data-rt-cases], [data-rt-case], [data-rt-kort], [role='figure'], [aria-current], [aria-live], [data-rt-live], [data-rt-say]")).toHaveCount(0);
  });

  test("an Explain selection across a tree locates in the page source", async ({ page }) => {
    await open(page, 1280);
    const sent: string[] = [];
    await page.route("**/api/wiki/explain?**", (route) => {
      sent.push(new URL(route.request().url()).searchParams.get("sel") ?? "");
      return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: done\ndata: ${JSON.stringify({ answer: "Ok." })}\n\n` });
    });
    await page.evaluate(() => {
      const find = (needle: string): [Node, number] => {
        const walk = document.createTreeWalker(document.querySelector(".wiki-article")!, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const k = (n as Text).data.indexOf(needle);
          if (k !== -1) return [n, k];
        }
        throw new Error(`no ${needle}`);
      };
      const [s, so] = find("The line before the explain tree");
      const [e, eo] = find("The line after the explain tree");
      const r = document.createRange();
      r.setStart(s, so);
      r.setEnd(e, eo + "The line after".length);
      const w = window.getSelection()!;
      w.removeAllRanges();
      w.addRange(r);
      document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await expect(page.locator("#wikiExplainBtn")).toBeVisible();
    await page.locator("#wikiExplainBtn").dispatchEvent("mousedown");
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    const sel = sent[0]!;
    const at = (s: string) => sel.indexOf(s);
    expect(at("The line before")).toBe(0);
    expect(at("Is the card valid?")).toBeGreaterThan(0);
    expect(at("LIB-301")).toBeGreaterThan(at("Is the card valid?"));
    expect(at("The line after")).toBeGreaterThan(at("LIB-301"));
    for (const chrome of ["Explain tree", "All cases"]) expect(sel, chrome).not.toContain(chrome);
    expect(PAGE.length).toBeGreaterThan(EXPLAIN_FULL_BODY_MAX);
    const excerpt = locateExcerpt(PAGE, sel);
    expect(excerpt, JSON.stringify(sel)).toContain("The line before the explain tree,");
    expect(excerpt).toContain("  - *Yes:* → Renew — LIB-301");
  });
});

test.describe("Chat bubbles: a RuleTree reaches chat as its list", () => {
  test("sanitizeHtml(formatWebHtml(<RuleTree>)) keeps the list and adds no tree markup", async ({ page }) => {
    await page.goto(`${BASE}/chat`);
    await page.waitForFunction(
      () =>
        typeof (globalThis as { formatWebHtml?: unknown }).formatWebHtml === "function" &&
        typeof (globalThis as { sanitizeHtml?: unknown }).sanitizeHtml === "function",
    );
    const result = await page.evaluate((src: string) => {
      const g = globalThis as unknown as {
        formatWebHtml: (s: string, o?: { views?: boolean }) => string;
        sanitizeHtml: (h: string, isWeb: boolean) => string;
      };
      const clean = g.sanitizeHtml(g.formatWebHtml(src, { views: true }), true);
      const probe = document.createElement("div");
      probe.innerHTML = clean;
      return {
        items: Array.from(probe.querySelectorAll("li")).map((li) => li.firstChild?.textContent ?? ""),
        rt: clean.includes("rt-"),
        select: g.sanitizeHtml('<p>a</p><select><option>x</option></select>', true).includes("<select"),
      };
    }, LOAN_TREE.join("\n"));
    expect(result.items).toEqual(["Is the book reserved by someone else?", "Yes:", "No:", "Yes:", "No:"]);
    expect(result.rt).toBe(false);
    expect(result.select).toBe(false);
  });
});
