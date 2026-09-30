/**
 * `<NextMoves>` end to end: the lane grid in the /wiki reader, the header pills
 * that count it and jump to it, the lane ages computed in the browser, and the
 * two surfaces that derive "waiting on you" from the same block — the /plans
 * board's toggle and the /wiki ✋ chip and row flag.
 *
 * What only a real page can answer: that the grid is one column at phone width
 * and several on a desktop, that a pill opens a closed fold and scrolls to the
 * lane, that "not sent · N d" is computed from the viewer's clock (pinned here,
 * with the timezone), that the toggle brings a SHIPPED plan onto a board whose
 * default scope hides that column, and that every muted line reads at 4.5:1 in
 * both themes.
 *
 * No model calls, no DB rows. The temp wiki is registered as `mimir` because
 * that is the name the /plans board reads; `CLAUDE_USAGE_URL` points at a
 * reserved dead port so the board renders no money.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { paintedContrast } from "./contrast.ts";
import { SETTLED_CREATED_LINE, settleWikiMtimes } from "./settled-wiki.ts";
import { MOVES_AGE_CLASS, MOVES_PILL_CLASS } from "../src/dashboard/views/components/wiki-report-blocks.ts";

const PORT = e2ePort("wiki-next-moves");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "mimir";
// 2026-10-01 10:00 in Oslo: the waiting lane (since 09-30) is 1 day old, the
// draft lane (since 09-29) 2 days.
const NOW = new Date("2026-10-01T10:00:00+02:00");
const TZ = "Europe/Oslo";

const LANES = [
  "<NextMoves>",
  "",
  '<Lane kind="you" who="Du">',
  "",
  "1. **Send Slack-utkastet fra runde 4.** Blokkerer Å3 og Å4.",
  "   - a nested note, not a step",
  "2. **Opprett oppgave 3 i Jira.**",
  "",
  "</Lane>",
  "",
  '<Lane kind="waiting" who="Venter på fag" since="2026-09-30">',
  "",
  "- Å1 — henlegge de fire årsavregningene? (sendt 30.09)",
  "",
  "</Lane>",
  "",
  '<Lane kind="draft" who="Utkast, ikke sendt" since="2026-09-29">',
  "",
  "- Å3 — MEL-368918 skal ikke årsavregnes?",
  "- Å4 — 826477",
  "",
  "</Lane>",
  "",
  '<Lane kind="blocked" who="Blokkert">',
  "",
  "- Person 1404 — venter på: oppgave 3 i prod.",
  "",
  "</Lane>",
  "",
  "</NextMoves>",
];

const plan = (title: string, status: string, body: string[]) =>
  ["---", `title: ${title}`, `plan_status: ${status}`, SETTLED_CREATED_LINE, "---", "", `# ${title}`, "", ...body, ""].join(
    "\n",
  );

const FILLER = Array.from({ length: 40 }, (_, i) => `Filler paragraph ${i + 1}.\n`);

const FILES: Record<string, string> = {
  // In flight, lanes at the top of the page.
  "plans/report.mdx": plan("Report page", "in-flight", ["Konklusjon først.", "", ...LANES, "", ...FILLER]),
  // Shipped, and still waiting on the reader: the board's default scope hides it.
  "plans/shipped-waits.mdx": plan("Shipped but waiting", "shipped", [
    "<NextMoves>",
    "",
    '<Lane kind="you">',
    "",
    "- **Run the backfill on a quiet day.** Then check /summaries.",
    "",
    "</Lane>",
    "",
    "</NextMoves>",
  ]),
  // Lanes inside a CLOSED fold, below filler: the pill must open it and scroll.
  "plans/folded.mdx": plan("Folded page", "in-flight", [...FILLER, '<Fold title="Status">', "", ...LANES, "", "</Fold>"]),
  // Nobody waiting.
  "plans/idle.mdx": plan("Idle plan", "in-flight", ["Nothing to do."]),
  // A lane quoted in a code fence is documentation, not a block.
  "plans/quoted.mdx": plan("Quoted grammar", "proposed", ["```mdx", ...LANES, "```"]),
};

let server: ChildProcess | undefined;
let root = "";

async function open(page: Page, rel: string): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);
  await expect(page.locator(".wiki-article")).toBeVisible();
}

test.use({ timezoneId: TZ });

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-next-moves-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  for (const [rel, text] of Object.entries(FILES)) await writeFile(path.join(root, rel), text, "utf8");
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
      CLAUDE_USAGE_URL: `http://127.0.0.1:${e2ePort("wiki-next-moves/dead-ledger")}`,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      const [a, b] = await Promise.all([fetch(`${BASE}/api/wiki/pages?wiki=${WIKI}`), fetch(`${BASE}/api/plans/board`)]);
      if (a.ok && b.ok) break;
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

test.describe("NextMoves in the reader", () => {
  test("four lanes render as a grid: several columns on a desktop, one at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await open(page, "plans/report.mdx");
    const lanes = page.locator(".wiki-article .next-moves .nm-lane");
    await expect(lanes).toHaveCount(4);
    await expect(lanes.nth(0)).toHaveAttribute("data-kind", "you");
    await expect(lanes.nth(0).locator(".nm-who")).toHaveText("Du");
    await expect(lanes.nth(0).locator(".nm-count")).toHaveText("2");
    // A nested item renders inside its step and is not counted.
    await expect(lanes.nth(0).locator(".nm-body > ol > li")).toHaveCount(2);
    await expect(lanes.nth(0).locator(".nm-body > ol > li ul li")).toHaveText("a nested note, not a step");
    const top = async (i: number) => (await lanes.nth(i).boundingBox())!;
    expect(Math.abs((await top(0)).y - (await top(1)).y)).toBeLessThan(2);

    await page.setViewportSize({ width: 390, height: 844 });
    // At 390 px the reader's rail and pane leave the article no width at all
    // (pre-existing; see wiki-tracker-graph.spec.ts). Focus mode is how a phone
    // reads a page, so the grid is measured there.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("f");
    await expect.poll(async () => (await page.locator(".wiki-article").boundingBox())!.width).toBeGreaterThan(250);
    await expect.poll(async () => Math.abs((await top(0)).x - (await top(1)).x)).toBeLessThan(2);
    expect((await top(1)).y).toBeGreaterThan((await top(0)).y + 10);
    // The grid never overflows the article column (the reader's own 390 px
    // layout is a separate matter: its three panes do not fit a phone).
    const fits = await page.locator(".wiki-article .next-moves").evaluate((el) => {
      const art = el.closest(".wiki-article")!.getBoundingClientRect();
      const lanes = Array.from(el.querySelectorAll(".nm-lane")).map((l) => l.getBoundingClientRect());
      return el.scrollWidth <= el.clientWidth + 1 && lanes.every((r) => r.right <= art.right + 1);
    });
    expect(fits).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });

  test("pills count the lanes, ages come from the viewer's clock", async ({ page }) => {
    await open(page, "plans/report.mdx");
    const pills = page.locator(`.wiki-article-head .wiki-meta-row .${MOVES_PILL_CLASS}`);
    await expect(pills).toHaveText(["✋ 2 for you", "⏳ waiting · 1", "✉ 2 not sent · 2 d"]);
    // Beside the status chip.
    expect(await pills.first().evaluate((el) => el.previousElementSibling?.className)).toContain("wiki-status");
    const waiting = page.locator('.nm-lane[data-kind="waiting"] .nm-since');
    await expect(waiting).toHaveText("since 1 d");
    await expect(waiting).toHaveAttribute("title", "2026-09-30");
    const chips = page.locator(`.nm-lane[data-kind="draft"] .${MOVES_AGE_CLASS}`);
    await expect(chips).toHaveText(["not sent · 2 d", "not sent · 2 d"]);
    // The chip sits after the item's own text.
    await expect(page.locator('.nm-lane[data-kind="draft"] li').first()).toHaveText(/^Å3 — MEL-368918 skal ikke årsavregnes\?\s*not sent · 2 d$/);
  });

  test("a pill opens a closed fold and scrolls to its lane", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 600 });
    await open(page, "plans/folded.mdx");
    const fold = page.locator(".wiki-article details.fold");
    expect(await fold.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    await page.locator(`.${MOVES_PILL_CLASS}-draft`).click();
    expect(await fold.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
    await expect(page.locator('.nm-lane[data-kind="draft"]')).toBeInViewport();
  });

  test("a page with no block, and a block inside a code fence, have no pills", async ({ page }) => {
    await open(page, "plans/idle.mdx");
    await expect(page.locator(`.${MOVES_PILL_CLASS}`)).toHaveCount(0);
    await open(page, "plans/quoted.mdx");
    await expect(page.locator(`.${MOVES_PILL_CLASS}`)).toHaveCount(0);
    await expect(page.locator(".wiki-article .next-moves")).toHaveCount(0);
  });

  test("/wiki: a ✋ chip beside ⚑ filters to the pages waiting on you; rows carry ✋", async ({ page }) => {
    await open(page, "plans/idle.mdx");
    await expect(page.locator('.wiki-list-item[data-relpath="plans/report.mdx"] .wiki-moves-flag')).toHaveCount(1);
    await expect(page.locator('.wiki-list-item[data-relpath="plans/idle.mdx"] .wiki-moves-flag')).toHaveCount(0);
    await page.locator("#wikiFilters summary").click();
    const chip = page.locator("#statusChips [data-waiting]");
    await expect(chip).toHaveText("✋ waiting on you 3");
    await chip.click();
    await expect(chip).toHaveClass(/active/);
    const rows = page.locator(".wiki-list-item[data-relpath]");
    await expect.poll(async () => (await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-relpath")))).sort()).toEqual([
      "plans/folded.mdx",
      "plans/report.mdx",
      "plans/shipped-waits.mdx",
    ]);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`lane text and pills read at 4.5:1, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page, "plans/report.mdx");
      await page.mouse.move(0, 0);
      const token = (name: string) =>
        page.evaluate((n) => {
          const p = document.createElement("span");
          p.style.color = `var(${n})`;
          document.body.appendChild(p);
          const c = getComputedStyle(p).color;
          p.remove();
          return c;
        }, name);
      const you = page.locator('.nm-lane[data-kind="you"]');
      expect(await you.locator(".nm-who").evaluate((el) => getComputedStyle(el).color), "you label token").toBe(
        await token("--accent-light"),
      );
      expect(
        await page.locator(`.${MOVES_AGE_CLASS}`).first().evaluate((el) => getComputedStyle(el).color),
        "age chip token",
      ).toBe(await token("--text-soft"));
      const targets = {
        youLabel: you.locator(".nm-who"),
        youCount: you.locator(".nm-count"),
        youItem: you.locator(".nm-body > ol > li").first(),
        waitingSince: page.locator('.nm-lane[data-kind="waiting"] .nm-since'),
        waitingItem: page.locator('.nm-lane[data-kind="waiting"] li').first(),
        draftAge: page.locator(`.${MOVES_AGE_CLASS}`).first(),
        blockedLabel: page.locator('.nm-lane[data-kind="blocked"] .nm-who'),
        youPill: page.locator(`.${MOVES_PILL_CLASS}-you`),
        waitingPill: page.locator(`.${MOVES_PILL_CLASS}-waiting`),
        draftPill: page.locator(`.${MOVES_PILL_CLASS}-draft`),
      };
      for (const [name, loc] of Object.entries(targets)) {
        expect(await paintedContrast(loc), `${name} contrast`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

test.describe("NextMoves on the /plans board", () => {
  test("Waiting on you counts both waiting plans and filters across columns, shipped included", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`${BASE}/plans`);
    // The default scope hides the shipped column.
    await expect(page.locator('.pb-cardwrap[data-slug="report"]')).toHaveCount(1);
    await expect(page.locator('.pb-cardwrap[data-slug="shipped-waits"]')).toHaveCount(0);
    const toggle = page.locator(".pb-waiting-toggle");
    await expect(toggle).toHaveText("✋ Waiting on you3");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(page.locator(".pb-waiting-toggle")).toHaveAttribute("aria-pressed", "true");
    const cards = page.locator(".pb-cardwrap[data-slug]");
    await expect
      .poll(async () => (await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-slug")))).sort())
      .toEqual(["folded", "report", "shipped-waits"]);
    expect(page.url()).toContain("waiting=1");
    // The card carries its steps, lead sentence only.
    const report = page.locator('.pb-cardwrap[data-slug="report"]');
    await expect(report.locator(".pb-hand")).toHaveText("✋ 2");
    await expect(report.locator(".pb-steps li")).toHaveText(["Send Slack-utkastet fra runde 4.", "Opprett oppgave 3 i Jira."]);
    await expect(page.locator('.pb-cardwrap[data-slug="shipped-waits"] .pb-steps li')).toHaveText([
      "Run the backfill on a quiet day.",
    ]);
    // The URL state survives a reload.
    await page.reload();
    await expect(page.locator(".pb-waiting-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('.pb-cardwrap[data-slug="idle"]')).toHaveCount(0);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`card steps and badge read at 4.5:1, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${BASE}/plans?waiting=1`);
      const report = page.locator('.pb-cardwrap[data-slug="report"]');
      await expect(report.locator(".pb-steps li").first()).toBeVisible();
      expect(await paintedContrast(report.locator(".pb-steps li").first()), "step").toBeGreaterThanOrEqual(4.5);
      expect(await paintedContrast(report.locator(".pb-hand")), "badge").toBeGreaterThanOrEqual(4.5);
    });
  }
});
