/**
 * Report blocks in the /wiki reader: `<Fold summary=>`, `<Callout resolved=>`,
 * `<Historic>` (plus the header's `↻ N historic` pill) and line-ref chips with
 * their `line refs` toggle.
 *
 * What only a real page can answer: that a teaser inside a CLOSED `<summary>` is
 * on screen, that a resolved callout's body is really collapsed, that the
 * historic body is dimmed and the pill lands beside the status chip (and opens
 * a closed fold around the first one), that the chips link from `code_at`, that
 * the toggle hides only pure ref groups (no "()" or "API " left behind) and its
 * choice survives a reload, and that every muted line — a chip inside a
 * Historic body included — reads at 4.5:1 in both themes.
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
import {
  CODE_REF_CLASS,
  CODE_REF_GROUP_CLASS,
  CODE_REF_LINK_CLASS,
  HISTORIC_PILL_CLASS,
  LINE_REFS_KEY,
  LINE_REFS_TOGGLE_CLASS,
} from "../src/dashboard/views/components/wiki-report-blocks.ts";

const PORT = e2ePort("wiki-report-blocks");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-report-blocks";

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
  "Kode sjekket (`src/main/Gate.kt:120-128`, `:42`) og (`:7, :9-11`). API `:8080` er en port.",
  "",
  "Se `web/Other.kt:3` og [`src/main/Linked.kt:5`](https://example.com/linked).",
  "",
  '<Historic since="melosys-console#270" note="§1 og §2 er erstattet">',
  "",
  "## 1. Slik teller console i dag",
  "",
  "Old counting prose (`:99`).",
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

// A Historic inside a CLOSED fold: the pill must open the fold to reach it.
const FOLDED_REL = "plans/folded.mdx";
const FOLDED = [
  "---",
  "title: Folded page",
  "---",
  "",
  "# Folded page",
  "",
  ...Array.from({ length: 40 }, (_, i) => `Filler paragraph ${i + 1}.\n`),
  '<Fold title="Old design">',
  "",
  '<Historic since="x#1">',
  "",
  "Old design body.",
  "",
  "</Historic>",
  "",
  "</Fold>",
  "",
].join("\n");

let server: ChildProcess | undefined;
let root = "";

/** Record this page's same-origin failed responses and its console errors. */
function watch(page: Page): { failed: string[]; errors: string[] } {
  const failed: string[] = [];
  const errors: string[] = [];
  page.on("response", (res) => {
    const u = new URL(res.url());
    // `/api/wiki/similar` answers 404 on a wiki with no `wikiCollections` — the
    // Similar section's own degrade, on every reader page, not this feature's.
    // Only that 404 is exempt: any other status there is still a failure.
    const similarDegrade = u.pathname === "/api/wiki/similar" && res.status() === 404;
    if (u.origin === BASE && res.status() >= 400 && !similarDegrade) {
      failed.push(`${res.status()} ${u.pathname}`);
    }
  });
  page.on("console", (m) => {
    // A failed load also logs "Failed to load resource"; `failed` accounts for it.
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return { failed, errors };
}

const open_ = async (page: Page, rel: string) => {
  const seen = watch(page);
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);
  await expect(page.locator(".wiki-article")).toBeVisible();
  return seen;
};

const expectClean = (seen: { failed: string[]; errors: string[] }) => {
  expect(seen.failed).toEqual([]);
  expect(seen.errors).toEqual([]);
};

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-report-blocks-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, REPORT_REL), REPORT, "utf8");
  await writeFile(path.join(root, PLAIN_REL), PLAIN, "utf8");
  await writeFile(path.join(root, FOLDED_REL), FOLDED, "utf8");

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
    const seen = await open_(page, REPORT_REL);
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
    expectClean(seen);
  });

  test("a resolved callout is one collapsed ✓ row; an open one is unchanged", async ({ page }) => {
    const seen = await open_(page, REPORT_REL);
    const resolved = page.locator(".wiki-article details.callout-resolved");
    await expect(resolved).toHaveCount(1);
    expect(await resolved.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    await expect(resolved.locator("summary")).toHaveText("✓ 2026-09-28 · Gate-kjøringer mangler feltene");
    await expect(resolved.locator(".callout-body")).toBeHidden();
    await resolved.locator("summary").click();
    await expect(resolved.locator(".callout-body")).toBeVisible();
    await expect(resolved.locator(".callout-body")).toContainText("Old warning body.");
    await expect(page.locator(".wiki-article div.callout.callout-warn")).toContainText("Open warning.");
    expectClean(seen);
  });

  test("historic sections are dimmed and stamped; the header pill counts them and jumps", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 500 });
    const seen = await open_(page, REPORT_REL);
    const historic = page.locator(".wiki-article section.historic");
    await expect(historic).toHaveCount(2);
    await expect(historic.nth(0).locator(".historic-stamp")).toHaveText(
      "↻ melosys-console#270 · §1 og §2 er erstattet",
    );
    await expect(historic.nth(1).locator(".historic-stamp")).toHaveText("↻ melosys-console#270");
    // Dimmed at rest by colour, not opacity (opacity fades chips under 4.5:1).
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
    const soft = await token("--text-soft");
    const body = historic.nth(0).locator(".historic-body");
    const color = () => body.evaluate((el) => getComputedStyle(el).color);
    expect(await color()).toBe(soft);
    expect(Number(await body.evaluate((el) => getComputedStyle(el).opacity))).toBe(1);
    // Full on hover.
    await body.hover();
    await expect.poll(color).not.toBe(soft);

    const pill = page.locator(`.wiki-article-head .wiki-meta-row .${HISTORIC_PILL_CLASS}`);
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
    expectClean(seen);
  });

  test("the pill opens a closed fold around the first historic section", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 500 });
    const seen = await open_(page, FOLDED_REL);
    const fold = page.locator(".wiki-article details.fold");
    const historic = page.locator(".wiki-article section.historic");
    expect(await fold.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    await expect(historic).toBeHidden();
    await page.locator(`.${HISTORIC_PILL_CLASS}`).click();
    expect(await fold.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
    await expect(historic).toBeVisible();
    await expect(historic).toBeInViewport();
    expectClean(seen);
  });

  test("a page with no historic section has no pill", async ({ page }) => {
    const seen = await open_(page, PLAIN_REL);
    await expect(page.locator(`.${HISTORIC_PILL_CLASS}`)).toHaveCount(0);
    expectClean(seen);
  });

  test("line refs are chips; path refs link from code_at; the toggle hides only pure groups, across a reload", async ({ page }) => {
    const seen = await open_(page, REPORT_REL);
    const chips = page.locator(`.wiki-article code.${CODE_REF_CLASS}`);
    await expect(chips).toHaveText([
      "src/main/Gate.kt:120-128",
      ":42",
      ":7, :9-11",
      "web/Other.kt:3",
      "src/main/Linked.kt:5",
      ":99",
    ]);
    const groups = page.locator(`.wiki-article span.${CODE_REF_GROUP_CLASS}`);
    await expect(groups).toHaveCount(3);
    // A bare port in prose is not a chip.
    await expect(page.locator(".wiki-article code:not(.code-ref)", { hasText: ":8080" })).toHaveCount(1);
    const link = page.locator(`.wiki-article a.${CODE_REF_LINK_CLASS}`);
    await expect(link).toHaveCount(2);
    await expect(link.first()).toHaveAttribute(
      "href",
      "https://github.com/navikt/melosys-console/blob/9c09999/src/main/Gate.kt#L120-L128",
    );
    await expect(link.first()).toHaveAttribute("target", "_blank");
    // The author's link wins: no `<a>` inside an `<a>`.
    await expect(page.locator(".wiki-article a a")).toHaveCount(0);
    await expect(page.locator('.wiki-article a[href="https://example.com/linked"] code.code-ref')).toHaveCount(1);

    const toggle = page.locator(`.wiki-meta-row .${LINE_REFS_TOGGLE_CLASS}`);
    const article = page.locator(".wiki-article");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(groups.first()).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    for (let i = 0; i < 3; i++) await expect(groups.nth(i)).toBeHidden();
    // Only the groups went: the chips outside them and the prose around them stay.
    await expect(chips.filter({ hasText: "web/Other.kt:3" })).toBeVisible();
    await expect(chips.filter({ hasText: "src/main/Linked.kt:5" })).toBeVisible();
    const text = await article.evaluate((el) => (el as HTMLElement).innerText);
    expect(text).toContain("Kode sjekket og. API :8080 er en port.");
    expect(text).not.toMatch(/\(\s*[,;]?\s*\)/);
    expect(await page.evaluate((k) => localStorage.getItem(k), LINE_REFS_KEY)).toBe("off");

    await page.reload();
    await expect(groups).toHaveCount(3);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(groups.first()).toBeHidden();

    await toggle.click();
    await expect(groups.first()).toBeVisible();
    expect(await page.evaluate((k) => localStorage.getItem(k), LINE_REFS_KEY)).toBe("on");
    expectClean(seen);
  });

  test("without code_at a path ref is a chip with no link; no group, so no toggle", async ({ page }) => {
    const seen = await open_(page, PLAIN_REL);
    await expect(page.locator(`.wiki-article code.${CODE_REF_CLASS}`)).toHaveCount(1);
    await expect(page.locator(`.wiki-article a.${CODE_REF_LINK_CLASS}`)).toHaveCount(0);
    await expect(page.locator(".wiki-article code:not(.code-ref)")).toHaveText("foo()");
    await expect(page.locator(`.${LINE_REFS_TOGGLE_CLASS}`)).toHaveCount(0);
    expectClean(seen);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`muted text reads at 4.5:1 and uses the soft token, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const seen = await open_(page, REPORT_REL);
      await page.mouse.move(0, 0);
      // The token, resolved on a probe OUTSIDE the elements under test.
      const token = (name: string) =>
        page.evaluate((n) => {
          const p = document.createElement("span");
          p.style.color = `var(${n})`;
          document.body.appendChild(p);
          const c = getComputedStyle(p).color;
          p.remove();
          return c;
        }, name);
      const soft = await token("--text-soft");
      const targets = {
        foldSummary: page.locator(".wiki-article .fold-summary"),
        historicStamp: page.locator(".wiki-article .historic-stamp").first(),
        chip: page.locator(`.wiki-article code.${CODE_REF_CLASS}`).nth(1),
        historicChip: page.locator(`.wiki-article .historic-body code.${CODE_REF_CLASS}`),
      };
      for (const [name, loc] of Object.entries(targets)) {
        expect(await loc.evaluate((el) => getComputedStyle(el).color), name).toBe(soft);
        // withOpacity: a dimming by opacity fades the text; this must see it.
        expect(await paintedContrast(loc, { withOpacity: true }), `${name} contrast`).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        await paintedContrast(page.locator(".wiki-article .historic-body").first(), { withOpacity: true }),
        "historic body text contrast",
      ).toBeGreaterThanOrEqual(4.5);
      // A heading inside a Historic body keeps its own, stronger token.
      const historicHeading = page.locator(".wiki-article .historic-body :is(h1, h2, h3, h4, h5, h6)").first();
      expect(await historicHeading.evaluate((el) => getComputedStyle(el).color), "historic heading").toBe(
        await token("--text-secondary"),
      );
      expect(
        await paintedContrast(historicHeading, { withOpacity: true }),
        "historic heading contrast",
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        await paintedContrast(page.locator(".wiki-article .callout-resolved-date")),
        "resolved row contrast",
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        await paintedContrast(page.locator(`.${HISTORIC_PILL_CLASS}`)),
        "historic pill contrast",
      ).toBeGreaterThanOrEqual(4.5);
      expectClean(seen);
    });
  }
});
