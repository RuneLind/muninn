/**
 * `<Query>` cards in the /wiki reader: a result table read from a CSV beside
 * the page, header-click sorting, the SQL in a closed disclosure, and the
 * containment refusals — a `../` path and a symlink inside the root, both
 * pointing at a file that EXISTS outside it, render the unavailable state and
 * the file's content never reaches the `/api/wiki/page` response. Also the
 * muted card text at 4.5:1 in both colour schemes.
 *
 * No model calls, no DB rows. ENV / SPAWN ENV: no `.env` is required — the
 * spawn inherits `DATABASE_URL` and `e2eEnv()` blanks the platform tokens and
 * the host's instance-profile flags.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { paintedContrast } from "./contrast.ts";

const PORT = e2ePort("wiki-query");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-query";
const SECRET = "OUTSIDE_SECRET_7f3a";

const PAGE_REL = "plans/report.mdx";
const PAGE = [
  "---",
  "title: Query page",
  "type: plan",
  "---",
  "",
  "# Query page",
  "",
  '<Query id="Q-1" question="Hvor mange saker per type?" answer="Tre typer." csv="report-res/Q-1.csv" run="2026-09-30" uses="8045, 8306">',
  "",
  "Fag sa at **tallene** stemmer.",
  "",
  "```sql",
  "SELECT type, COUNT(*) FROM sak GROUP BY type;",
  "```",
  "",
  "</Query>",
  "",
  '<Query id="Q-2" question="Utenfor roten?" csv="../../outside.csv">',
  "",
  "Skal ikke leses.",
  "",
  "</Query>",
  "",
  '<Query id="Q-3" question="Lenke ut?" csv="report-res/link.csv">',
  "",
  "Skal heller ikke leses.",
  "",
  "</Query>",
  "",
].join("\n");

let server: ChildProcess | undefined;
let base = "";

function watch(page: Page): { failed: string[]; errors: string[] } {
  const failed: string[] = [];
  const errors: string[] = [];
  page.on("response", (res) => {
    const u = new URL(res.url());
    // `/api/wiki/similar` answers 404 on a wiki with no `wikiCollections`.
    const similarDegrade = u.pathname === "/api/wiki/similar" && res.status() === 404;
    if (u.origin === BASE && res.status() >= 400 && !similarDegrade) failed.push(`${res.status()} ${u.pathname}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return { failed, errors };
}

const openPage = async (page: Page) => {
  const seen = watch(page);
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(PAGE_REL)}`);
  await expect(page.locator(".wiki-article")).toBeVisible();
  return seen;
};

const expectClean = (seen: { failed: string[]; errors: string[] }) => {
  expect(seen.failed).toEqual([]);
  expect(seen.errors).toEqual([]);
};

test.beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "muninn-e2e-query-"));
  const root = path.join(base, "wiki");
  await mkdir(path.join(root, "plans", "report-res"), { recursive: true });
  await writeFile(path.join(root, PAGE_REL), PAGE, "utf8");
  await writeFile(
    path.join(root, "plans", "report-res", "Q-1.csv"),
    'N,TYPE,NOTE\r\n10,beta,"a, b"\r\n9,alfa,x\r\n100,gamma,y\r\n',
    "utf8",
  );
  await writeFile(path.join(base, "outside.csv"), `SECRET\n${SECRET}\n`, "utf8");
  await symlink(path.join(base, "outside.csv"), path.join(root, "plans", "report-res", "link.csv"));

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

test.describe("Wiki reader: Query cards", () => {
  test("a card renders from the CSV beside the page, with the SQL in a closed disclosure", async ({ page }) => {
    const seen = await openPage(page);
    const card = page.locator("section.query#q-1");
    await expect(card).toBeVisible();
    await expect(card.locator(".query-id")).toHaveText("Q-1");
    await expect(card.locator(".query-question")).toHaveText("Hvor mange saker per type?");
    await expect(card.locator(".query-answer")).toHaveText("Tre typer.");
    await expect(card.locator(".query-use")).toHaveText(["8045", "8306"]);
    await expect(card.locator(".query-body")).toContainText("tallene");
    await expect(card.locator(".query-rows")).toHaveText("3 rows");
    await expect(card.locator("tbody tr")).toHaveCount(3);
    await expect(card.locator("tbody tr").first().locator("td")).toHaveText(["10", "beta", "a, b"]);
    // The SQL moved out of the body into a closed disclosure.
    await expect(card.locator(".query-body pre")).toHaveCount(0);
    const sql = card.locator("details.query-sql");
    expect(await sql.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    await expect(sql.locator("pre")).toBeHidden();
    await sql.locator("summary").click();
    await expect(sql.locator("pre")).toContainText("SELECT type, COUNT(*) FROM sak GROUP BY type;");
    expectClean(seen);
  });

  test("a header click sorts ascending, a second descending; numeric columns compare as numbers", async ({ page }) => {
    const seen = await openPage(page);
    const card = page.locator("section.query#q-1");
    const firstCell = (col: number) => card.locator("tbody tr").first().locator("td").nth(col);
    const th = (col: number) => card.locator("thead th").nth(col);

    await th(0).locator("button").click();
    await expect(firstCell(0)).toHaveText("9");
    await expect(th(0)).toHaveAttribute("aria-sort", "ascending");
    await th(0).locator("button").click();
    await expect(firstCell(0)).toHaveText("100");
    await expect(th(0)).toHaveAttribute("aria-sort", "descending");

    await th(1).locator("button").click();
    await expect(firstCell(1)).toHaveText("alfa");
    await expect(th(1)).toHaveAttribute("aria-sort", "ascending");
    await expect(th(0)).not.toHaveAttribute("aria-sort", /.*/);
    await th(1).locator("button").click();
    await expect(firstCell(1)).toHaveText("gamma");
    expectClean(seen);
  });

  test("a file outside the root, by ../ or by a symlink, renders unavailable and never ships", async ({ page, request }) => {
    const res = await request.get(`${BASE}/api/wiki/page?wiki=${WIKI}&relPath=${encodeURIComponent(PAGE_REL)}`);
    expect(res.ok()).toBe(true);
    const body = await res.text();
    expect(body).not.toContain(SECRET);

    const seen = await openPage(page);
    await expect(page.locator("section.query#q-2 .query-unavailable")).toHaveText("File not available: outside.csv");
    await expect(page.locator("section.query#q-3 .query-unavailable")).toHaveText("File not available: link.csv");
    await expect(page.locator("section.query#q-2 table, section.query#q-3 table")).toHaveCount(0);
    await expect(page.locator(".wiki-article")).not.toContainText(SECRET);
    expectClean(seen);
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`muted card text reads at 4.5:1 and uses the soft token, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const seen = await openPage(page);
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
      await page.locator("section.query#q-1 thead th").first().locator("button").click();
      const targets = {
        meta: page.locator("section.query#q-1 .query-meta"),
        rows: page.locator("section.query#q-1 .query-rows"),
        sortMark: page.locator("section.query#q-1 .query-sort-mark").first(),
        unavailable: page.locator("section.query#q-2 .query-unavailable"),
      };
      for (const [name, loc] of Object.entries(targets)) {
        expect(await loc.evaluate((el) => getComputedStyle(el).color), name).toBe(soft);
        expect(await paintedContrast(loc, { withOpacity: true }), `${name} contrast`).toBeGreaterThanOrEqual(4.5);
      }
      for (const sel of [".query-question", ".query-answer", "tbody td"]) {
        const loc = page.locator(`section.query#q-1 ${sel}`).first();
        expect(await paintedContrast(loc), `${sel} contrast`).toBeGreaterThanOrEqual(4.5);
      }
      expectClean(seen);
    });
  }
});
