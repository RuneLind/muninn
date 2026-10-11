/**
 * "New since last read" (reader lenses PR 4, D20, acceptance 8).
 *
 * What only a real page can answer: that the server's `data-item-date` stamps
 * and the client's stored last visit meet — items dated by a Query's `run=`,
 * by a lane's `since=`, by a date mid-way through a DecisionLog item, by a
 * yearless date (a few days after a lagging `status_date`, and a December date
 * on a January one) and by an item with several dates (the last one wins)
 * carry the mark exactly when that date is after the seeded visit, in
 * Overview and in All; that the head reads `✦ N nye siden <date>` and
 * «endret siden»; that a first visit marks nothing and stores the visit; and
 * that the mark leaves the compact DecisionLog (five rows, date cell) as it
 * was.
 *
 * One Norwegian wiki, instance default Overview, two pages. Synthetic
 * fixtures. The browser runs in Europe/Oslo so the seeded visits fall on the
 * days the assertions name.
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

const PORT = e2ePort("wiki-new-since");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-new-since";
const TZ = "Europe/Oslo";
const VISIT_KEY = "muninn.wiki.lastVisit.v1";

const AUTUMN_REL = "plans/autumn.mdx";
// status_date lags at 07.10; the visit is 07.10 at noon (CEST).
const AUTUMN_VISIT = Date.parse("2026-10-07T10:00:00Z");
const AUTUMN = [
  "---",
  "title: Autumn page",
  "type: plan",
  "plan_status: in-flight",
  "status_date: 2026-10-07",
  "---",
  "",
  "# Autumn page",
  "",
  "<NextMoves>",
  "",
  '<Lane kind="waiting" who="fag" since="2026-10-09">',
  "",
  "- Spørsmål en til fag",
  "- Spørsmål to til fag",
  "",
  "</Lane>",
  "",
  '<Lane kind="you" who="Du" since="2026-10-01">',
  "",
  "- En gammel oppgave",
  "",
  "</Lane>",
  "",
  "</NextMoves>",
  "",
  "<DecisionLog>",
  "",
  "- **D1** — Gammel beslutning gjelder alle saker. Fag, 01.10 (runde 1).",
  "- **D2** — Avklart 08.10 med fag, og gjelder alle saker framover.",
  "- **D3** — Vedtatt for alle saker i år. Fag, 10.10 (runde 3).",
  "- **D4** — Spurt 09.10 og lukket igjen 06.10 (runde 4).",
  "- **D5** — Lukket 06.10 og besvart på nytt 09.10.",
  "- **D6** — Bekreftet i møtet 2026-10-08 med fag.",
  "- **D7** — Tatt samme dag som besøket. Fag, 07.10 (runde 7).",
  "",
  "</DecisionLog>",
  "",
  '<Query id="Q-1" question="Hvor mange saker?" answer="Tre" run="2026-10-09" />',
  "",
  '<Query id="Q-2" question="Hvor mange gamle?" answer="To" run="2026-10-02" />',
  "",
  '<Fold title="Detaljer" for="dev">',
  "",
  "Tekst for utviklere.",
  "",
  "</Fold>",
  "",
].join("\n");

const WINTER_REL = "plans/winter.mdx";
// status_date 05.01.2027; the visit is 20.12.2026 at noon (CET).
const WINTER_VISIT = Date.parse("2026-12-20T11:00:00Z");
const WINTER = [
  "---",
  "title: Winter page",
  "type: plan",
  "status_date: 2027-01-05",
  "---",
  "",
  "# Winter page",
  "",
  "<DecisionLog>",
  "",
  "- **D1** — Desember før besøket gjelder. Fag, 18.12 (runde 1).",
  "- **D2** — Desember etter besøket gjelder. Fag, 22.12 (runde 2).",
  "- **D3** — Januar etter besøket gjelder. Fag, 03.01 (runde 3).",
  "",
  "</DecisionLog>",
  "",
].join("\n");

let server: ChildProcess | undefined;
let root = "";

test.use({ timezoneId: TZ });

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

/** Seed this viewer's last visit to `rel` (or nothing), then open it. */
const openWithVisit = async (page: Page, rel: string, visit: number | null) => {
  await page.addInitScript(
    ([key, entry, at]) => {
      // Once per test: the page stores its own visit on load, and a reload
      // must read that, not the seed again.
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.removeItem(key as string);
      if (at !== null) localStorage.setItem(key as string, JSON.stringify({ [entry as string]: at }));
    },
    [VISIT_KEY, `${WIKI}\n${rel}`, visit] as const,
  );
  const seen = watch(page);
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}`);
  await expect(page.locator(".wiki-article")).toBeVisible();
  return seen;
};

const expectClean = (seen: { failed: string[]; errors: string[] }) => {
  expect(seen.failed).toEqual([]);
  expect(seen.errors).toEqual([]);
};

const lensOf = (page: Page) =>
  page.locator(".wiki-article").evaluate((el) => (el.classList.contains("lens-overview") ? "overview" : "all"));

/** Every marked element, by what it is: decision ids, query ids, lane labels. */
const marked = (page: Page) =>
  page.locator(".wiki-article").evaluate((art) => {
    const items = Array.from(art.querySelectorAll(".item-new")).filter((el) => !el.closest(".wiki-ref-peek"));
    return {
      decisions: items.filter((el) => el.matches("li.dl-item")).map((el) => el.id),
      queries: items
        .filter((el) => el.matches(".query-head"))
        .map((el) => el.querySelector(".query-id")?.textContent ?? ""),
      laneItems: items
        .filter((el) => el.matches(".nm-body li"))
        .map((el) => `${el.closest<HTMLElement>(".nm-lane")!.dataset.who}: ${el.textContent!.trim()}`),
      lanes: Array.from(art.querySelectorAll<HTMLElement>(".nm-lane-new")).map((el) => el.dataset.who),
      total: items.length,
    };
  });

/** The `::before` tag a marked element shows ("none" when it shows none). */
const tagOf = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => getComputedStyle(el, "::before").content);

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-new-since-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, AUTUMN_REL), AUTUMN, "utf8");
  await writeFile(path.join(root, WINTER_REL), WINTER, "utf8");
  await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify({ language: "no" }), "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${root}`,
      WIKI_DEFAULT_LENS: `${WIKI}=overview`,
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

test.describe("Wiki reader: new since last read (D20)", () => {
  test("acceptance 8: run=, since=, a mid-text date, a date after a lagging status_date and the last of several dates — in Overview and All", async ({ page }) => {
    const seen = await openWithVisit(page, AUTUMN_REL, AUTUMN_VISIT);
    expect(await lensOf(page)).toBe("overview");

    const expected = {
      // D2 by its mid-text 08.10, D3 by 10.10 (three days after the lagging
      // status_date), D5 by the last of 06.10/09.10, D6 by its ISO date. D4's
      // last date is 06.10, so its earlier 09.10 does not make it new; D7 is
      // dated the visit day itself (new means strictly after); D1 is old.
      decisions: ["d6", "d5", "d3", "d2"],
      queries: ["Q-1"],
      laneItems: ["fag: Spørsmål en til fag", "fag: Spørsmål to til fag"],
      lanes: ["fag"],
      total: 7,
    };
    // Overview shows a DecisionLog newest first, so the decisions come back
    // in that DOM order.
    expect(await marked(page)).toEqual(expected);

    const head = page.locator(".wiki-article-head .wiki-meta-row");
    await expect(head.locator(".wiki-new-since")).toHaveText(/^✦ 7 nye siden 07\.10(\.2026)?$/);
    // The page file was written after the visit.
    await expect(head.locator(".wiki-changed-since")).toHaveText(/^endret siden 07\.10(\.2026)?$/);

    // The mark is the rail's NEW tag in the wiki's language, and pseudo
    // content, never text: a copied decision reads as written.
    expect(await tagOf(page, "li.dl-item#d3")).toBe('"NY"');
    expect(await tagOf(page, "li.dl-item#d4")).toBe("none");
    await expect(page.locator("li.dl-item#d3 .dl-text")).not.toContainText("NY");
    expect(await tagOf(page, 'section.query#q-1 .query-head')).toBe('"NY"');
    expect(await tagOf(page, '.nm-lane[data-who="fag"] .nm-who')).toBe('"NY"');
    expect(await tagOf(page, '.nm-lane[data-who="Du"] .nm-who')).toBe("none");

    // The compact DecisionLog is unchanged: five rows, date cell beside them.
    const visible = await page
      .locator(".wiki-article li.dl-item.dl-decision")
      .evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.id));
    expect(visible).toEqual(["d7", "d6", "d5", "d4", "d3"]);
    await expect(page.locator("li.dl-item#d3 .dl-when")).toHaveText("Fag, 10.10 · runde 3");

    // The head line reveals the first new item, opening its lane.
    await head.locator(".wiki-new-since").click();
    await expect(page.locator('.nm-lane[data-who="fag"]')).toHaveAttribute("open", "");
    await expect(page.locator('.nm-lane[data-who="fag"] li.item-new').first()).toBeVisible();

    // All: the same marks and the same line.
    await page.locator('.wiki-lens-switch button[data-lens="all"]').click();
    expect(await lensOf(page)).toBe("all");
    expect(await marked(page)).toEqual(expected);
    await expect(head.locator(".wiki-new-since")).toHaveText(/^✦ 7 nye siden 07\.10(\.2026)?$/);
    expect(await tagOf(page, "li.dl-item#d6")).toBe('"NY"');
    expectClean(seen);
  });

  test("yearless dates take the year nearest a January status_date", async ({ page }) => {
    const seen = await openWithVisit(page, WINTER_REL, WINTER_VISIT);
    // 18.12 reads as 2026-12-18 (before the visit), not 2027-12-18; 03.01 as
    // 2027-01-03 (after it), not 2026-01-03.
    const m = await marked(page);
    expect(m.decisions).toEqual(["d3", "d2"]);
    expect(m.total).toBe(2);
    await expect(page.locator(".wiki-new-since")).toHaveText(/^✦ 2 nye siden 20\.12(\.2026)?$/);
    expectClean(seen);
  });

  test("a first visit marks nothing and stores the visit; a reload then marks nothing", async ({ page }) => {
    const before = Date.now();
    const seen = await openWithVisit(page, AUTUMN_REL, null);
    expect((await marked(page)).total).toBe(0);
    await expect(page.locator(".wiki-new-since")).toHaveCount(0);
    await expect(page.locator(".wiki-changed-since")).toHaveCount(0);
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), VISIT_KEY);
    expect(stored[`${WIKI}\n${AUTUMN_REL}`]).toBeGreaterThanOrEqual(before);

    // The stored visit is now; nothing on the page is newer, and the file is not.
    await page.reload();
    await expect(page.locator(".wiki-article")).toBeVisible();
    expect((await marked(page)).total).toBe(0);
    await expect(page.locator(".wiki-new-since")).toHaveCount(0);
    await expect(page.locator(".wiki-changed-since")).toHaveCount(0);
    expectClean(seen);
  });

  test("a visit after every date marks nothing and says nothing", async ({ page }) => {
    const seen = await openWithVisit(page, AUTUMN_REL, Date.now());
    expect((await marked(page)).total).toBe(0);
    await expect(page.locator(".wiki-new-since")).toHaveCount(0);
    await expect(page.locator(".wiki-changed-since")).toHaveCount(0);
    expectClean(seen);
  });
});
