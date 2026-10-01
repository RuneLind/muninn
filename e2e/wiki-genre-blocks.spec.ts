/**
 * `<Tldr>`, `<Timeline>`, `<DecisionLog>` and `<RunChecklist>` in the /wiki
 * reader, over a temp wiki: the lead box, dated items on a rail with undated
 * ones unmarked, decision ids as chips with their own anchors (a second log's
 * repeat suffixed), dimmed struck and superseded items, and a run checklist's
 * step count and labelled rows with the command's copy button. Also the 390px
 * focus-mode layout and 4.5:1 on the muted and chip text in both colour
 * schemes.
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

const PORT = e2ePort("wiki-genre-blocks");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-genre-blocks";
const PAGE_REL = "plans/report.mdx";

const PAGE = [
  "---",
  "title: Genre page",
  "type: plan",
  "---",
  "",
  "# Genre page",
  "",
  '<Tldr label="Kort fortalt">',
  "",
  "Fag har svart på grunnlaget. **Tre** oppgaver gjenstår, se `antallVilleOppdatertStatusForSkattepliktigeSakerUtenAvgift`.",
  "",
  "</Tldr>",
  "",
  "<Timeline>",
  "",
  "- **2026-09-28** — Runde 1: fag svarte på D1 og D2",
  "- 30.09.2026: Runde 4",
  "- Uten dato, venter på fag",
  "",
  "</Timeline>",
  "",
  "<DecisionLog>",
  "",
  "**Avgjort av fag** (Slack):",
  "",
  "- **D1** — Ikke-yrkesaktive betaler ikke trygdeavgift.",
  "- ~~**D2** — Gammel regel.~~",
  "- **D3** — Erstattet av D4.",
  "- **D4** — Menybehandlinger teller aldri.",
  "- Et punkt uten id",
  "",
  "**Åpent:**",
  "",
  "- **S1** — Skal de fire årsavregningene henlegges?",
  "",
  "</DecisionLog>",
  "",
  // Enough prose that the second log starts below the fold.
  ...Array.from({ length: 30 }, (_, i) => `Avsnitt ${i + 1} med fylltekst.\n`),
  "<DecisionLog>",
  "",
  "- **D1** — En annen logg med samme id.",
  "",
  "</DecisionLog>",
  "",
  "<RunChecklist>",
  "",
  "- [x] Simuler",
  "  - Kommando: `POST /admin/aarsavregninger/saker/skattepliktige/run`",
  "  - Forventet: `antallVilleOppdatertStatusForSkattepliktigeSaker` er 0",
  "  - Stopp hvis: `feilVedHenting` er satt",
  "- [x] Gå gjennom de nye sakene",
  "- [ ] Skarp kjøring",
  "  - Kommando: send `run-skarp.json` én gang",
  "  - en vanlig note",
  "",
  "</RunChecklist>",
  "",
  "<RunChecklist>",
  "",
  "3. [x] Tredje steg",
  "4. [ ] Fjerde steg",
  "",
  "</RunChecklist>",
  "",
  // Every step-number cell: {flex row, parent row} × {done, todo} ×
  // {one digit, two digits}.
  "<RunChecklist>",
  "",
  "6. [x] Seks",
  "7. [ ] Sju",
  "8. [x] Åtte",
  "   - Kommando: `a`",
  "9. [ ] Ni",
  "   - Forventet: b",
  "10. [x] Ti",
  "11. [ ] Elleve",
  "12. [x] Tolv",
  "    - Kommando: `c`",
  "13. [ ] Tretten",
  "    - Stopp hvis: d",
  "",
  "</RunChecklist>",
  "",
  // A flat row of mixed inline content (the 8045 runbook's shape): one flex item.
  "<RunChecklist>",
  "",
  "- [ ] Toggle `MELOSYS_SKATTEHENDELSE_CONSUMER` i prod-Unleash — står den på, har **Kafka-stien** kanskje allerede opprettet årsavregninger for deler av populasjonen; rapport 0 skal vise dem under `antallMedEksisterendeAarsavregning`, og tallet må gi mening.",
  "",
  "</RunChecklist>",
  "",
].join("\n");

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
  base = await mkdtemp(path.join(tmpdir(), "muninn-e2e-genre-"));
  const root = path.join(base, "wiki");
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, PAGE_REL), PAGE, "utf8");

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

test.describe("Wiki reader: Tldr, Timeline, DecisionLog, RunChecklist", () => {
  test("Tldr: a lead box with its label, unlike a callout", async ({ page }) => {
    const seen = await openPage(page);
    const box = page.locator("section.tldr");
    await expect(box.locator(".tldr-label")).toHaveText("Kort fortalt");
    await expect(box.locator(".tldr-body strong")).toHaveText("Tre");
    // A full border, not a callout's left bar alone.
    const borders = await box.evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth];
    });
    expect(borders).toEqual(["3px", "1px", "1px", "1px"]);
    expectClean(seen);
  });

  test("Timeline: dated items carry the date and a rail marker; the undated one neither", async ({ page }) => {
    const seen = await openPage(page);
    const items = page.locator("section.gtl .gtl-item");
    await expect(items).toHaveCount(3);
    await expect(items.locator(".gtl-date")).toHaveText(["2026-09-28", "30.09.2026"]);
    const markers = await items.evaluateAll((lis) => lis.map((li) => getComputedStyle(li, "::before").content));
    expect(markers).toEqual(['""', '""', "none"]);
    await expect(items.nth(2)).toHaveText("Uten dato, venter på fag");
    expectClean(seen);
  });

  test("DecisionLog: an anchor and a chip per id; the second log's repeat is suffixed", async ({ page }) => {
    const seen = await openPage(page);
    const ids = await page.locator("section.decision-log .dl-item[id]").evaluateAll((lis) => lis.map((li) => li.id));
    expect(ids).toEqual(["d1", "d2", "d3", "d4", "s1", "d1-2"]);
    await expect(page.locator("section.decision-log .dl-id")).toHaveText(["D1", "D2", "D3", "D4", "S1", "D1"]);
    await expect(page.locator(".dl-item.dl-noid")).toHaveText("Et punkt uten id");
    await expect(page.locator(".dl-item.dl-noid .dl-id")).toHaveCount(0);
    // Struck and superseded dim; the others do not.
    const dim = await page.locator("section.decision-log .dl-item[id]").evaluateAll((lis) => lis.map((li) => li.classList.contains("dl-dim")));
    expect(dim).toEqual([false, true, true, false, false, false]);
    // The labels between the lists render in place.
    await expect(page.locator("section.decision-log").first()).toContainText("Avgjort av fag");
    await expect(page.locator("section.decision-log").first()).toContainText("Åpent:");
    expectClean(seen);
  });

  test("a #d1-2 link scrolls to the second log's item", async ({ page }) => {
    const seen = await openPage(page, "#d1-2");
    await expect(page.locator(".dl-item#d1-2")).toBeInViewport();
    expectClean(seen);
  });

  test("RunChecklist: the step count, labelled rows, and the command's copy button", async ({ page }) => {
    const seen = await openPage(page);
    const rc = page.locator("section.run-checklist").first();
    await expect(rc.locator(".rc-count")).toHaveText("2 av 3 steg");
    await expect(rc.locator(".rc-label")).toHaveText(["Kommando", "Forventet", "Stopp hvis", "Kommando"]);
    const command = rc.locator(".rc-row.rc-command").first();
    await expect(command.locator("pre code")).toHaveText("POST /admin/aarsavregninger/saker/skattepliktige/run");
    await expect(command.locator(".fence-copy")).toBeVisible();
    // A command that is prose around a span stays inline.
    await expect(rc.locator(".rc-row.rc-command").nth(1).locator(".fence-copy")).toHaveCount(0);
    await expect(rc.locator(".rc-row.rc-command").nth(1).locator("code")).toHaveText("run-skarp.json");
    await expect(rc.locator(".check-plain")).toHaveText("en vanlig note");
    expectClean(seen);
  });

  test("a flat row with code and bold reads as one text block, not columns", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const seen = await openPage(page);
    const row = page.locator("section.run-checklist").nth(3).locator(".check-item");
    await expect(row).toHaveCount(1);
    // Mark + one text element: nothing else may become its own flex item.
    expect(await row.evaluate((li) => Array.from(li.children).map((c) => c.className))).toEqual([
      "check-mark",
      "check-text",
    ]);
    // The text takes the row's width, so the code span sits inside one wrapped
    // paragraph instead of in a squeezed column of its own.
    const [rowBox, textBox, codeBox] = await Promise.all([
      row.boundingBox(),
      row.locator(".check-text").boundingBox(),
      row.locator("code").first().boundingBox(),
    ]);
    expect(textBox!.width).toBeGreaterThan(rowBox!.width * 0.8);
    expect(codeBox!.width).toBeGreaterThan(200);
    expectClean(seen);
  });

  test("RunChecklist: an ordered step list shows its numbers from its start", async ({ page }) => {
    const seen = await openPage(page);
    const steps = page.locator("section.run-checklist").nth(1).locator(".check-item");
    await expect(steps).toHaveCount(2);
    // The rendered text carries the number, painted before the mark.
    const shown = await steps.evaluateAll((lis) => lis.map((li) => (li as HTMLElement).innerText.replace(/\s+/g, " ").trim()));
    expect(shown).toEqual(["3. ✓ Tredje steg", "4. ✗ Fjerde steg"]);
    for (const n of await steps.locator(".rc-num").all()) {
      await expect(n).toBeVisible();
      const box = (await n.boundingBox())!;
      const mark = (await n.locator("xpath=following-sibling::*[1]").boundingBox())!;
      expect(box.width).toBeGreaterThan(4);
      expect(box.x + box.width).toBeLessThanOrEqual(mark.x + 1);
    }
    expectClean(seen);
  });

  for (const scheme of ["light", "dark"] as const) {
    for (const width of [1280, 390]) {
      test(`RunChecklist: every step's mark at one x and every number one colour, ${scheme} ${width}px`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: scheme });
        const seen = await openPage(page);
        if (width === 390) {
          // The narrow reader shows the article in focus mode, as the 390px test below.
          await page.setViewportSize({ width, height: 844 });
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await page.keyboard.press("f");
          await expect.poll(async () => (await page.locator(".wiki-article").boundingBox())!.width).toBeGreaterThan(250);
        }
        const steps = page.locator("section.run-checklist").nth(2).locator(":scope > .checklist > .check-item");
        await expect(steps).toHaveCount(8);
        // Ink, not boxes: a Range over an element's text measures the glyphs,
        // so a number overflowing a too-narrow box still counts, and a flex
        // item's line-height box does not skew the line check.
        const cells = await steps.evaluateAll((lis) =>
          lis.map((li) => {
            const ink = (el: Element) => {
              const r = document.createRange();
              r.selectNodeContents(el);
              return r.getBoundingClientRect();
            };
            const num = li.querySelector(":scope > .rc-num")!;
            const mark = li.querySelector(":scope > .check-mark")!;
            return {
              num: num.textContent,
              parent: li.classList.contains("check-parent"),
              done: li.classList.contains("check-done"),
              markX: ink(mark).left,
              numRight: ink(num).right,
              numLeft: ink(num).left,
              liLeft: li.getBoundingClientRect().left,
              dy: ink(num).top - ink(mark).top,
              numColor: getComputedStyle(num).color,
            };
          }),
        );
        // The fixture holds every cell.
        expect(cells.map((c) => `${c.num}${c.parent ? "p" : "f"}${c.done ? "d" : "t"}`)).toEqual([
          "6.fd", "7.ft", "8.pd", "9.pt", "10.fd", "11.ft", "12.pd", "13.pt",
        ]);
        const x0 = cells[0]!.markX;
        for (const c of cells) {
          expect(Math.abs(c.markX - x0), `${c.num} mark x`).toBeLessThanOrEqual(1);
          expect(Math.abs(c.numRight - cells[0]!.numRight), `${c.num} right edge`).toBeLessThanOrEqual(1);
          expect(c.markX - c.numRight, `${c.num} gap to its mark`).toBeGreaterThanOrEqual(4);
          expect(c.numLeft, `${c.num} inside its row`).toBeGreaterThanOrEqual(c.liLeft - 0.5);
          expect(Math.abs(c.dy), `${c.num} on the mark's line`).toBeLessThanOrEqual(1);
        }
        expect(new Set(cells.map((c) => c.numColor)).size).toBe(1);
        for (const n of await steps.locator(":scope > .rc-num").all()) {
          expect(await paintedContrast(n), "step number contrast").toBeGreaterThanOrEqual(4.5);
        }
        expectClean(seen);
      });
    }
  }

  test("at 390px in focus mode nothing scrolls the page sideways", async ({ page }) => {
    const seen = await openPage(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("f");
    await expect.poll(async () => (await page.locator(".wiki-article").boundingBox())!.width).toBeGreaterThan(250);
    const m = await page.evaluate(() => {
      const art = document.querySelector(".wiki-article")!.getBoundingClientRect().right;
      // Every block and every descendant, inline code included. A `pre` is a
      // scroll box, so it counts and what is inside it does not.
      const blocks = Array.from(document.querySelectorAll("section.tldr, section.gtl, section.decision-log, section.run-checklist"));
      const all = blocks.flatMap((b) => [b, ...Array.from(b.querySelectorAll("*"))]).filter((e) => !e.parentElement?.closest("pre"));
      const label = document.querySelector(".rc-label")!.getBoundingClientRect();
      const value = document.querySelector(".rc-value")!.getBoundingClientRect();
      return {
        page: document.documentElement.scrollWidth <= window.innerWidth + 1,
        checked: all.length,
        inlineCode: all.filter((e) => e.matches(":not(pre) > code")).length,
        overflow: all
          .filter((e) => e.getBoundingClientRect().right > art + 1)
          .map((e) => `${e.tagName.toLowerCase()}.${e.className} +${Math.round(e.getBoundingClientRect().right - art)}px`),
        stacked: label.bottom <= value.top + 1,
      };
    });
    expect(m.page).toBe(true);
    expect(m.checked).toBeGreaterThan(40);
    expect(m.inlineCode).toBeGreaterThanOrEqual(3);
    expect(m.overflow).toEqual([]);
    // Below 520px the label sits above its value.
    expect(m.stacked).toBe(true);
    expectClean(seen);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`muted and chip text reads at 4.5:1, muted on the soft token, ${scheme}`, async ({ page }) => {
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
        count: page.locator(".rc-count").first(),
        label: page.locator(".rc-label").first(),
        dimmed: page.locator(".dl-item.dl-dim .dl-text").first(),
        dimmedChip: page.locator(".dl-item.dl-dim .dl-id").first(),
      };
      for (const [name, loc] of Object.entries(muted)) {
        expect(await loc.evaluate((el) => getComputedStyle(el).color), name).toBe(soft);
        expect(await paintedContrast(loc, { withOpacity: true }), `${name} contrast`).toBeGreaterThanOrEqual(4.5);
      }
      const read = {
        tldrLabel: page.locator(".tldr-label"),
        tldrBody: page.locator(".tldr-body"),
        date: page.locator(".gtl-date").first(),
        undated: page.locator(".gtl-undated"),
        chip: page.locator(".dl-item:not(.dl-dim) .dl-id").first(),
        decision: page.locator(".dl-item:not(.dl-dim) .dl-text").first(),
        command: page.locator(".rc-command pre code").first(),
        stepNumber: page.locator(".rc-num").first(),
      };
      for (const [name, loc] of Object.entries(read)) {
        expect(await paintedContrast(loc), `${name} contrast`).toBeGreaterThanOrEqual(4.5);
      }
      expectClean(seen);
    });
  }
});
