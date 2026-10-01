/**
 * `<CaseBoard>`, `<DeltaTable>` and the Query explorer in the /wiki reader,
 * over a temp wiki: the board read from a YAML beside the page (count strip,
 * rows grouped by status, an anchor per case), a delta table from a CSV and one
 * from a pipe-table body, and the explorer's search box and `uses` chips over a
 * run of adjacent `<Query>` cards — including a `#q-n` link to a card the
 * filter hid. Also the 390px focus-mode layout and 4.5:1 on the new muted and
 * coloured text in both colour schemes.
 *
 * No model calls, no DB rows. ENV / SPAWN ENV: no `.env` is required — the
 * spawn inherits `DATABASE_URL` and `e2eEnv()` blanks the platform tokens and
 * the host's instance-profile flags.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { paintedContrast } from "./contrast.ts";

const PORT = e2ePort("wiki-caseboard");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-caseboard";

const PAGE_REL = "plans/report.mdx";
const OTHER_REL = "plans/other.mdx";

const query = (id: string, question: string, uses: string, body: string) =>
  [`<Query id="${id}" question="${question}" answer="Svar ${id}." uses="${uses}">`, "", body, "", "</Query>", ""].join("\n");

const PAGE = [
  "---",
  "title: Board page",
  "type: plan",
  "---",
  "",
  "# Board page",
  "",
  '<CaseBoard src="report-res/cases.yaml" />',
  "",
  '<DeltaTable src="report-res/runs.csv" better="lower" />',
  "",
  '<DeltaTable better="higher">',
  "",
  "| Teller | 08.09 simulering mot prod | 18.09 simulering mot prod |",
  "|---|---:|---:|",
  "| `antallVilleOpprettetProsessinstans` | 459 | 504 |",
  "| Varighet | 22,10 sek | 27,81 sek |",
  "| Kommentar | ikke i koden | 132 |",
  "",
  "</DeltaTable>",
  "",
  "## Spørringer",
  "",
  query("Q-1", "Hvor mange behandlinger uten metadata?", "8045, 8306", "Telling per måned og **sakstype**."),
  query("Q-2", "Hvilke saker har trygdeavgift?", "8306", "Saker med avgift uten vedtak."),
  query("Q-3", "Har flytvedtakene en prosessinstans?", "8174", "Prosessinstans mot endret dato."),
  // Enough prose that a card below starts below the fold, and a lone card no explorer covers.
  ...Array.from({ length: 30 }, (_, i) => `Avsnitt ${i + 1} med fylltekst.\n`),
  query("Q-9", "Alene?", "8045", "Et kort uten nabo."),
].join("\n");

const OTHER = ["---", "title: Other page", "type: plan", "---", "", "# Other page", "", "Ingenting her.", ""].join("\n");

const CASES = [
  "- id: MEL-545776",
  "  status: hold",
  "  owner: Fag",
  "  note: Holdt **ute** av 2024-lista til S4",
  "  refs: [Q-14]",
  "- id: MEL-720043",
  "  status: wait",
  "  note: Blokkert til oppgave 3 er i prod",
  "- id: MEL-368918",
  "  status: hold",
  "- id: MEL-616226",
  "  status: none",
  "- id: MEL-1",
  "  status: blocked",
  "- id: MEL-589684",
  "  status: ok",
  "  note: Uendret av oppgave 3 — en lang note som må brytes på smale skjermer uten å skyve siden sidelengs",
  "",
].join("\n");

const RUNS = "Teller,07.09,08.09,18.09\nKandidater,140,132,16\nMetadatafeil,9,9,10\nUten treff,322,322,322\n";

let server: ChildProcess | undefined;
let base = "";

function watch(page: Page): { failed: string[]; errors: string[] } {
  const failed: string[] = [];
  const errors: string[] = [];
  page.on("response", (res) => {
    const u = new URL(res.url());
    const similarDegrade = u.pathname === "/api/wiki/similar" && res.status() === 404;
    if (u.origin === BASE && res.status() >= 400 && !similarDegrade) failed.push(`${res.status()} ${u.pathname}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return { failed, errors };
}

const openPage = async (page: Page, hash = "") => {
  const seen = watch(page);
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(PAGE_REL)}${hash}`);
  await expect(page.locator(".wiki-article")).toBeVisible();
  return seen;
};

const expectClean = (seen: { failed: string[]; errors: string[] }) => {
  expect(seen.failed).toEqual([]);
  expect(seen.errors).toEqual([]);
};

test.beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "muninn-e2e-caseboard-"));
  const root = path.join(base, "wiki");
  await mkdir(path.join(root, "plans", "report-res"), { recursive: true });
  await writeFile(path.join(root, PAGE_REL), PAGE, "utf8");
  await writeFile(path.join(root, OTHER_REL), OTHER, "utf8");
  await writeFile(path.join(root, "plans", "report-res", "cases.yaml"), CASES, "utf8");
  await writeFile(path.join(root, "plans", "report-res", "runs.csv"), RUNS, "utf8");

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
  if (base) await rm(base, { recursive: true, force: true });
});

test.describe("Wiki reader: CaseBoard, DeltaTable, Query explorer", () => {
  test("the board: a count strip, then rows grouped by status with an anchor per case", async ({ page }) => {
    const seen = await openPage(page);
    const board = page.locator("section.caseboard");
    await expect(board.locator(".cb-strip")).toHaveText("2 hold · 1 wait · 1 none · 1 ok · 1 unknown");
    const ids = await board.locator(".cb-row").evaluateAll((rows) => rows.map((r) => r.id));
    expect(ids).toEqual(["case-mel-545776", "case-mel-368918", "case-mel-720043", "case-mel-616226", "case-mel-589684", "case-mel-1"]);
    const first = board.locator(".cb-row#case-mel-545776");
    await expect(first.locator(".cb-pill")).toHaveText("hold");
    await expect(first.locator(".cb-owner")).toHaveText("Fag");
    await expect(first.locator(".cb-note strong")).toHaveText("ute");
    await expect(first.locator(".cb-ref")).toHaveText("Q-14");
    await expect(board.locator(".cb-row#case-mel-1 .cb-pill")).toHaveText("unknown");
    await expect(board.locator(".cb-row#case-mel-1 .cb-pill")).toHaveAttribute("title", "status: blocked");
    expectClean(seen);
  });

  test("a #case link scrolls to the row", async ({ page }) => {
    const seen = await openPage(page, "#case-mel-589684");
    await expect(page.locator(".cb-row#case-mel-589684")).toBeInViewport();
    expectClean(seen);
  });

  test("the CSV table: the delta between the last two runs, coloured by better=lower", async ({ page }) => {
    const seen = await openPage(page);
    const t = page.locator("section.delta-table").first();
    await expect(t.locator("thead th.dt-delta .dt-delta-runs")).toHaveText("08.09 → 18.09");
    // The header names the direction, so the colours are not the only key.
    await expect(t.locator("thead th.dt-delta .dt-delta-dir")).toHaveText("lower is better");
    const row = (label: string) => t.locator("tbody tr", { has: page.locator(`th:text-is("${label}")`) }).locator("td.dt-delta");
    await expect(row("Kandidater")).toHaveText("✓ -116 (-87.9%)");
    await expect(row("Kandidater")).toHaveClass(/dt-good/);
    await expect(row("Kandidater").getByRole("img", { name: "better" })).toBeVisible();
    await expect(row("Metadatafeil")).toHaveText("✗ +1 (+11.1%)");
    await expect(row("Metadatafeil")).toHaveClass(/dt-bad/);
    await expect(row("Metadatafeil").getByRole("img", { name: "worse" })).toBeVisible();
    await expect(row("Uten treff")).toHaveText("0 (0.0%)");
    await expect(row("Uten treff")).toHaveClass(/dt-flat/);
    expectClean(seen);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`good and bad deltas paint in different colours, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const seen = await openPage(page);
      const color = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).color);
      const [good, bad, plain] = [await color("td.dt-good .dt-abs"), await color("td.dt-bad .dt-abs"), await color("td.dt-flat .dt-abs")];
      expect(good).not.toBe(bad);
      expect(good).not.toBe(plain);
      expect(bad).not.toBe(plain);
      expectClean(seen);
    });
  }

  test("the pipe-table body: inline markdown cells, units and a decimal comma, no delta for text", async ({ page }) => {
    const seen = await openPage(page);
    const t = page.locator("section.delta-table").nth(1);
    await expect(t.locator("tbody th code")).toHaveText("antallVilleOpprettetProsessinstans");
    const deltas = t.locator("tbody td.dt-delta");
    // A decimal comma in the table writes every delta in commas.
    await expect(deltas).toHaveText(["✓ +45 (+9,8%)", "✓ +5,71 sek (+25,8%)", ""]);
    await expect(deltas.first()).toHaveClass(/dt-good/);
    expectClean(seen);
  });

  test("long run labels wrap in the header, so the delta column stays inside the article", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 });
    const seen = await openPage(page);
    const m = await page.locator("section.delta-table").nth(1).evaluate((sec) => {
      const wrap = sec.querySelector(".dt-wrap")!;
      const delta = sec.querySelector("thead th.dt-delta")!;
      return { scrolls: wrap.scrollWidth > wrap.clientWidth + 1, deltaRight: delta.getBoundingClientRect().right, wrapRight: wrap.getBoundingClientRect().right };
    });
    expect(m.scrolls).toBe(false);
    expect(m.deltaRight).toBeLessThanOrEqual(m.wrapRight + 1);
    expectClean(seen);
  });

  test("the explorer: one bar over the adjacent cards; search and a chip filter them", async ({ page }) => {
    const seen = await openPage(page);
    const bars = page.locator(".qx-bar");
    await expect(bars).toHaveCount(1);
    const bar = bars.first();
    // The bar sits right above the first card of the run.
    expect(await bar.evaluate((el) => el.nextElementSibling?.id)).toBe("q-1");
    await expect(bar.locator(".qx-chip")).toHaveText(["8045", "8306", "8174"]);
    await expect(bar.getByRole("group", { name: "Filter by uses" }).locator(".qx-chip")).toHaveCount(3);
    await expect(bar.locator(".qx-count")).toHaveText("3 of 3 queries");
    const visible = () => page.locator("section.query:visible").evaluateAll((s) => s.map((e) => e.id));

    // Search matches the body too (Q-1's "sakstype"), across terms.
    await bar.locator(".qx-search").fill("SAKSTYPE måned");
    await expect(bar.locator(".qx-count")).toHaveText("1 of 3 queries");
    expect(await visible()).toEqual(["q-1", "q-9"]);

    await bar.locator(".qx-search").fill("");
    await bar.locator(".qx-chip", { hasText: "8306" }).click();
    await expect(bar.locator(".qx-chip", { hasText: "8306" })).toHaveAttribute("aria-pressed", "true");
    await expect(bar.locator(".qx-count")).toHaveText("2 of 3 queries");
    expect(await visible()).toEqual(["q-1", "q-2", "q-9"]);

    // A second chip widens: a card using either.
    await bar.locator(".qx-chip", { hasText: "8174" }).click();
    expect(await visible()).toEqual(["q-1", "q-2", "q-3", "q-9"]);
    // The lone card further down is never filtered.
    await bar.locator(".qx-search").fill("ingen treff her");
    await expect(bar.locator(".qx-count")).toHaveText("0 of 3 queries");
    expect(await visible()).toEqual(["q-9"]);
    expectClean(seen);
  });

  test("a #q-n link to a card the filter hid clears the filter and shows the card", async ({ page }) => {
    const seen = await openPage(page);
    const bar = page.locator(".qx-bar");
    await bar.locator(".qx-chip", { hasText: "8174" }).click();
    await expect(page.locator("section.query#q-2")).toBeHidden();
    await page.evaluate(() => {
      location.hash = "#q-2";
    });
    await expect(page.locator("section.query#q-2")).toBeVisible();
    await expect(page.locator("section.query#q-2")).toBeInViewport();
    await expect(bar.locator(".qx-count")).toHaveText("3 of 3 queries");
    await expect(bar.locator(".qx-chip", { hasText: "8174" })).toHaveAttribute("aria-pressed", "false");
    expectClean(seen);
  });

  test("a #q-n link to a card the SEARCH hid clears the search box too", async ({ page }) => {
    const seen = await openPage(page);
    const bar = page.locator(".qx-bar");
    await bar.locator(".qx-search").fill("sakstype");
    await expect(page.locator("section.query#q-2")).toBeHidden();
    await page.evaluate(() => {
      location.hash = "#q-2";
    });
    await expect(page.locator("section.query#q-2")).toBeVisible();
    await expect(bar.locator(".qx-search")).toHaveValue("");
    await expect(bar.locator(".qx-count")).toHaveText("3 of 3 queries");
    expectClean(seen);
  });

  test("an article swap away and back builds one fresh bar", async ({ page }) => {
    const seen = await openPage(page);
    await expect(page.locator(".qx-bar")).toHaveCount(1);
    await page.locator(`.wiki-list-item[data-relpath="${OTHER_REL}"]`).click();
    await expect(page.locator(".wiki-article")).toContainText("Ingenting her.");
    await expect(page.locator(".qx-bar")).toHaveCount(0);
    await page.goBack();
    await expect(page.locator("section.caseboard")).toBeVisible();
    await expect(page.locator(".qx-bar")).toHaveCount(1);
    await expect(page.locator(".qx-bar .qx-count")).toHaveText("3 of 3 queries");
    expectClean(seen);
  });

  test("at 390px in focus mode nothing scrolls the page sideways", async ({ page }) => {
    const seen = await openPage(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("f");
    await expect.poll(async () => (await page.locator(".wiki-article").boundingBox())!.width).toBeGreaterThan(250);
    const m = await page.evaluate(() => {
      const art = document.querySelector(".wiki-article")!.getBoundingClientRect().right;
      // The bar's own children too: a flex child with a min-width can overflow
      // a bar that itself stays inside the article.
      const sel = ["section.caseboard", "section.delta-table", ".qx-bar", ".qx-search", ".qx-chips", ".qx-chip", ".qx-count", "section.query"];
      return {
        page: document.documentElement.scrollWidth <= window.innerWidth + 1,
        overflow: sel.flatMap((s) => Array.from(document.querySelectorAll(s))).filter((e) => e.getBoundingClientRect().right > art + 1).length,
      };
    });
    expect(m.page).toBe(true);
    expect(m.overflow).toBe(0);
    expectClean(seen);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`muted and coloured text reads at 4.5:1, muted on the soft token, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const seen = await openPage(page);
      await page.mouse.move(0, 0);
      const soft = await page.evaluate(() => {
        const p = document.createElement("span");
        p.style.color = "var(--text-soft)";
        document.body.appendChild(p);
        const c = getComputedStyle(p).color;
        p.remove();
        return c;
      });
      const muted = {
        owner: page.locator(".cb-owner").first(),
        ref: page.locator(".cb-ref").first(),
        sep: page.locator(".cb-sep").first(),
        deltaRuns: page.locator(".dt-delta-runs").first(),
        deltaDir: page.locator(".dt-delta-dir").first(),
        pct: page.locator("section.delta-table").first().locator("td.dt-delta:not(.dt-good):not(.dt-bad) .dt-pct").first(),
        count: page.locator(".qx-count"),
      };
      for (const [name, loc] of Object.entries(muted)) {
        expect(await loc.evaluate((el) => getComputedStyle(el).color), name).toBe(soft);
        expect(await paintedContrast(loc, { withOpacity: true }), `${name} contrast`).toBeGreaterThanOrEqual(4.5);
      }
      const read = {
        good: page.locator("td.dt-good .dt-abs").first(),
        bad: page.locator("td.dt-bad .dt-abs").first(),
        pill: page.locator(".cb-pill.cb-hold").first(),
        unknown: page.locator(".cb-pill.cb-unknown").first(),
        id: page.locator(".cb-id").first(),
        note: page.locator(".cb-note").first(),
        chip: page.locator(".qx-chip").first(),
        search: page.locator(".qx-search"),
      };
      for (const [name, loc] of Object.entries(read)) {
        expect(await paintedContrast(loc), `${name} contrast`).toBeGreaterThanOrEqual(4.5);
      }
      expectClean(seen);
    });
  }
});
