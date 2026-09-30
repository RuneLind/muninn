/**
 * Report blocks in the /wiki reader: `<Fold summary=>`, `<Callout resolved=>`,
 * `<Historic>` (plus the header's `↻ N historic` pill) and line-ref chips with
 * their `line refs` toggle.
 *
 * What only a real page can answer: that a teaser inside a CLOSED `<summary>` is
 * on screen, that a resolved callout's body is really collapsed, that the
 * historic body is dimmed and the pill lands beside the status chip, that the
 * chips link from `code_at` and the toggle's choice survives a reload, and that
 * every muted line reads at 4.5:1 in both themes.
 *
 * No model calls, no DB rows. ENV / SPAWN ENV: no `.env` is required — the spawn
 * inherits `DATABASE_URL` and `e2eEnv()` blanks the platform tokens and the
 * host's instance-profile flags.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { paintedContrast } from "./contrast.ts";

const PORT = e2ePort("wiki-report-blocks");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-report-blocks";
const LINE_REFS_KEY = "muninn.wiki.lineRefs.v1";

const REPORT_REL = "plans/report.mdx";
const REPORT = [
  "---",
  "title: Report page",
  "type: plan",
  "plan_status: in-flight",
  "code_at: navikt/melosys-console@9c09999",
  "---",
  "",
  "# Report page",
  "",
  "Kode sjekket, se `src/main/Gate.kt:120-128` og `:42`, og `:7, :9-11`.",
  "",
  '<Historic since="melosys-console#270" note="§1 og §2 er erstattet">',
  "",
  "## 1. Slik teller console i dag",
  "",
  "Old counting prose.",
  "",
  "</Historic>",
  "",
  '<Historic since="melosys-console#270">',
  "",
  "## 2. Foreslått løsning",
  "",
  '<Callout tone="warn" title="Gate-kjøringer mangler feltene" resolved="2026-09-28">',
  "",
  "Old warning body.",
  "",
  "</Callout>",
  "",
  "</Historic>",
  "",
  '<Fold title="Runder" summary="4 runder · vårt svar: utkast">',
  "",
  "## Runder",
  "",
  "Round detail.",
  "",
  "</Fold>",
  "",
  '<Callout tone="warn" title="Still open">',
  "",
  "Open warning.",
  "",
  "</Callout>",
  "",
].join("\n");

const PLAIN_REL = "plans/plain.mdx";
const PLAIN = ["---", "title: Plain page", "---", "", "# Plain page", "", "Se `src/main/Gate.kt:3` og `foo()`.", ""].join("\n");

let server: ChildProcess | undefined;
let root = "";
const consoleErrors: string[] = [];
const failedResponses: string[] = [];

const open_ = async (page: Page, rel: string) => {
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(`${rel}: ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`${rel}: ${e.message}`));
  page.on("response", (res) => {
    if (res.status() >= 400) failedResponses.push(`${res.status()} ${new URL(res.url()).pathname}`);
  });
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);
  await expect(page.locator(".wiki-article")).toBeVisible();
};

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-report-blocks-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, REPORT_REL), REPORT, "utf8");
  await writeFile(path.join(root, PLAIN_REL), PLAIN, "utf8");

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
});

test.describe("Wiki reader: report blocks", () => {
  test("a fold's summary is visible while the fold is closed", async ({ page }) => {
    await open_(page, REPORT_REL);
    const fold = page.locator(".wiki-article details.fold");
    await expect(fold).toHaveCount(1);
    expect(await fold.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    await expect(fold.locator(".fold-body")).toBeHidden();
    await expect(fold.locator("summary .fold-summary")).toBeVisible();
    await expect(fold.locator("summary .fold-summary")).toHaveText("4 runder · vårt svar: utkast");
    // The duplicate heading is still hidden: the teaser did not defeat it.
    await fold.locator("summary").click();
    await expect(fold.locator("h3.fold-heading-dup")).toHaveCount(1);
    await expect(fold.locator("h3.fold-heading-dup")).toBeHidden();
  });

  test("a resolved callout is one collapsed ✓ row; an open one is unchanged", async ({ page }) => {
    await open_(page, REPORT_REL);
    const resolved = page.locator(".wiki-article details.callout-resolved");
    await expect(resolved).toHaveCount(1);
    expect(await resolved.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    await expect(resolved.locator("summary")).toHaveText("✓ 2026-09-28 · Gate-kjøringer mangler feltene");
    await expect(resolved.locator(".callout-body")).toBeHidden();
    await resolved.locator("summary").click();
    await expect(resolved.locator(".callout-body")).toBeVisible();
    await expect(resolved.locator(".callout-body")).toContainText("Old warning body.");
    await expect(page.locator(".wiki-article div.callout.callout-warn")).toContainText("Open warning.");
  });

  test("historic sections are dimmed and stamped; the header pill counts them and jumps", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 500 });
    await open_(page, REPORT_REL);
    const historic = page.locator(".wiki-article section.historic");
    await expect(historic).toHaveCount(2);
    await expect(historic.nth(0).locator(".historic-stamp")).toHaveText(
      "↻ melosys-console#270 · §1 og §2 er erstattet",
    );
    await expect(historic.nth(1).locator(".historic-stamp")).toHaveText("↻ melosys-console#270");
    // Dimmed at rest; the stamp itself is not inside the dimmed box.
    await page.mouse.move(0, 0);
    const opacity = async (i: number) =>
      Number(await historic.nth(i).locator(".historic-body").evaluate((el) => getComputedStyle(el).opacity));
    expect(await opacity(0)).toBeCloseTo(0.6, 2);
    expect(
      Number(await historic.nth(0).locator(".historic-stamp").evaluate((el) => getComputedStyle(el).opacity)),
    ).toBe(1);
    // Full on hover.
    await historic.nth(0).locator(".historic-body").hover();
    await expect.poll(() => opacity(0)).toBe(1);

    const pill = page.locator(".wiki-article-head .wiki-meta-row .wiki-historic-pill");
    await expect(pill).toHaveText("↻ 2 historic");
    // Beside the status chip: its immediate previous sibling is the chip.
    expect(await pill.evaluate((el) => el.previousElementSibling?.className)).toContain("wiki-status");
    await pill.click();
    await expect
      .poll(() =>
        historic.nth(0).evaluate((el) => {
          const wrap = document.getElementById("articleWrap")!.getBoundingClientRect();
          const r = el.getBoundingClientRect();
          return Math.abs(r.top - wrap.top) < 4;
        }),
      )
      .toBe(true);
  });

  test("a page with no historic section has no pill", async ({ page }) => {
    await open_(page, PLAIN_REL);
    await expect(page.locator(".wiki-historic-pill")).toHaveCount(0);
  });

  test("line refs are chips; path refs link from code_at; the toggle hides them across a reload", async ({ page }) => {
    await open_(page, REPORT_REL);
    const chips = page.locator(".wiki-article code.code-ref");
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(0)).toHaveText("src/main/Gate.kt:120-128");
    const link = page.locator(".wiki-article a.code-ref-link");
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute(
      "href",
      "https://github.com/navikt/melosys-console/blob/9c09999/src/main/Gate.kt#L120-L128",
    );
    await expect(link).toHaveAttribute("target", "_blank");

    const toggle = page.locator(".wiki-meta-row .wiki-lineref-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(chips.nth(1)).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    for (let i = 0; i < 3; i++) await expect(chips.nth(i)).toBeHidden();
    expect(await page.evaluate((k) => localStorage.getItem(k), LINE_REFS_KEY)).toBe("off");

    await page.reload();
    await expect(page.locator(".wiki-article code.code-ref")).toHaveCount(3);
    await expect(page.locator(".wiki-lineref-toggle")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".wiki-article code.code-ref").first()).toBeHidden();

    await page.locator(".wiki-lineref-toggle").click();
    await expect(page.locator(".wiki-article code.code-ref").first()).toBeVisible();
    expect(await page.evaluate((k) => localStorage.getItem(k), LINE_REFS_KEY)).toBe("on");
  });

  test("without code_at a path ref is a chip with no link; non-ref code is untouched", async ({ page }) => {
    await open_(page, PLAIN_REL);
    await expect(page.locator(".wiki-article code.code-ref")).toHaveCount(1);
    await expect(page.locator(".wiki-article a.code-ref-link")).toHaveCount(0);
    await expect(page.locator(".wiki-article code:not(.code-ref)")).toHaveText("foo()");
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`muted text reads at 4.5:1 and uses the soft token, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open_(page, REPORT_REL);
      await page.mouse.move(0, 0);
      // The token, resolved on a probe OUTSIDE the elements under test.
      const soft = await page.evaluate(() => {
        const p = document.createElement("span");
        p.style.color = "var(--text-soft)";
        document.body.appendChild(p);
        const c = getComputedStyle(p).color;
        p.remove();
        return c;
      });
      const targets = {
        foldSummary: page.locator(".wiki-article .fold-summary"),
        historicStamp: page.locator(".wiki-article .historic-stamp").first(),
        chip: page.locator(".wiki-article code.code-ref").nth(1),
      };
      for (const [name, loc] of Object.entries(targets)) {
        expect(await loc.evaluate((el) => getComputedStyle(el).color), name).toBe(soft);
        expect(await paintedContrast(loc), `${name} contrast`).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        await paintedContrast(page.locator(".wiki-article .callout-resolved-date")),
        "resolved row contrast",
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        await paintedContrast(page.locator(".wiki-historic-pill")),
        "historic pill contrast",
      ).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("no console errors on any page this spec opened", () => {
    // `/api/wiki/similar` answers 404 on a wiki with no `wikiCollections` — the
    // Similar section's own degrade, on every reader page, not this feature's.
    // Each failed load also logs a "Failed to load resource" console line, which
    // the response list above accounts for.
    expect(failedResponses.filter((r) => !r.endsWith(" /api/wiki/similar"))).toEqual([]);
    expect(consoleErrors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
  });
});
