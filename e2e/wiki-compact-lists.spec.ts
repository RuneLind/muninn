/**
 * Overview's compact DecisionLog and CaseBoard (reader lenses PR 10, D41, D42,
 * acceptance 11).
 *
 * What only a real page can answer: that Overview's CSS puts the newest
 * decision first and hides all but five while the DOM keeps authored order,
 * that the date cell sits in its own column and the tail leaves the text, that
 * a `#d1` load or an id link into a hidden older decision shows the list, that
 * a case row reads as its compact line with the board's labels and «mer»
 * opens the note, that the `ok` group shows one row and «+ N til», that both
 * folds open in Overview and a closed one opens again on reload (not stored),
 * and that All renders every item as written.
 *
 * One Norwegian wiki, instance default Overview. Synthetic fixtures.
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

const PORT = e2ePort("wiki-compact-lists");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-compact";
const REL = "plans/compact.mdx";

const DECISIONS = [1, 2, 3, 4, 5, 6, 7].map(
  (n) => `- **D${n}** — Beslutning nummer ${n} gjelder alle saker. Begrunnelse ${n}. Fag, 0${n}.10 (runde ${n}).`,
);

const PAGE = [
  "---",
  "title: Compact page",
  "type: plan",
  "plan_status: in-flight",
  "---",
  "",
  "# Compact page",
  "",
  "Se D1 for den eldste beslutningen.",
  "",
  '<Fold title="Beslutninger">',
  "",
  "<DecisionLog>",
  "",
  ...DECISIONS,
  "- **S1** — Et åpent spørsmål om noe? Spurt fag 07.10.",
  "",
  "</DecisionLog>",
  "",
  "</Fold>",
  "",
  '<Fold title="Saker">',
  "",
  '<CaseBoard src="cases.yaml" labels="hold:holdt ute,wait:venter,wrong:feil årsavregning,none:ikke kandidat" />',
  "",
  "</Fold>",
  "",
].join("\n");

const CASES = [
  "- id: MEL-1",
  "  status: hold",
  '  note: "Person 1, 2025 · Vedtak: et avslag · **Holdt ute for godt** (D7). Lang forklaring om saken"',
  '  kort: "Holdt ute av 2025-lista (D7)."',
  "  refs: [D7, Q-9]",
  "- id: MEL-2",
  "  status: wait",
  '  note: "Person 2, 2025 · **Blokkert til oppgave 3 er i prod.** Mer tekst"',
  "- id: MEL-3",
  "  status: wrong",
  '  note: "Ingen skilletegn og ingen fet tekst"',
  "- id: MEL-4",
  "  status: ok",
  '  note: "2024 · **På lista.**"',
  "- id: MEL-5",
  "  status: ok",
  '  note: "2024 · **Også på lista.**"',
  "- id: MEL-6",
  "  status: ok",
  '  note: "2025 · **Tredje på lista.**"',
  "- id: MEL-7",
  "  status: none",
  '  note: "Ikke kandidat"',
  "- id: MEL-8",
  "  status: none",
  '  note: "Ikke kandidat"',
  "",
].join("\n");

let server: ChildProcess | undefined;
let root = "";

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

const open_ = async (page: Page, query = "", hash = "") => {
  const seen = watch(page);
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(REL)}${query}${hash}`);
  await expect(page.locator(".wiki-article")).toBeVisible();
  return seen;
};

const lensOf = (page: Page) =>
  page.locator(".wiki-article").evaluate((el) => (el.classList.contains("lens-overview") ? "overview" : "all"));

const expectClean = (seen: { failed: string[]; errors: string[] }) => {
  expect(seen.failed).toEqual([]);
  expect(seen.errors).toEqual([]);
};

/** The decision ids on screen, top to bottom. */
const visibleDecisionOrder = (page: Page) =>
  page.locator(".wiki-article li.dl-item.dl-decision").evaluateAll((els) =>
    els
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .map((e) => ({ id: e.id, y: e.getBoundingClientRect().top }))
      .sort((a, b) => a.y - b.y)
      .map((e) => e.id),
  );

/** The fold by its own title (its summary starts with it; the body is not read). */
const fold = (page: Page, title: string) =>
  page.locator(".wiki-article details.fold").filter({ has: page.locator(":scope > summary", { hasText: new RegExp(`^${title}`) }) });

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-compact-"));
  await mkdir(path.join(root, "plans"), { recursive: true });
  await writeFile(path.join(root, REL), PAGE, "utf8");
  await writeFile(path.join(root, "plans", "cases.yaml"), CASES, "utf8");
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

test.describe("Wiki reader: Overview's compact DecisionLog and CaseBoard", () => {
  test("acceptance 11: five decisions newest first with their dates, «Vis alle» for the rest; both folds open", async ({ page }) => {
    const seen = await open_(page);
    expect(await lensOf(page)).toBe("overview");
    await expect(fold(page, "Beslutninger")).toHaveAttribute("open", "");
    await expect(fold(page, "Saker")).toHaveAttribute("open", "");

    expect(await visibleDecisionOrder(page)).toEqual(["d7", "d6", "d5", "d4", "d3"]);
    const d7 = page.locator("li.dl-item#d7");
    await expect(d7.locator(".dl-when")).toHaveText("Fag, 07.10 · runde 7");
    await expect(d7.locator(".dl-first")).toHaveText("Beslutning nummer 7 gjelder alle saker.");
    // The tail left the text; the cell is right of the text, in its own column.
    await expect(d7.locator(".dl-tail")).toBeHidden();
    const [text, when] = await Promise.all([d7.locator(".dl-text").boundingBox(), d7.locator(".dl-when").boundingBox()]);
    expect(when!.x).toBeGreaterThan(text!.x + text!.width - 1);
    // «mer» opens the rest, which no longer carries the tail.
    await d7.locator("button.dl-more").click();
    await expect(d7.locator(".dl-rest")).toBeVisible();
    await expect(d7.locator(".dl-tail")).toBeHidden();

    // The question keeps today's rendering: no date cell, after the decisions.
    const s1 = page.locator("li.dl-item#s1");
    await expect(s1).toBeVisible();
    await expect(s1.locator(".dl-when")).toHaveCount(0);

    const all = page.locator(".wiki-article button.dl-all");
    await expect(all).toHaveText("Vis alle 7 beslutninger");
    // On a line of its own, not run into the prose after the list.
    expect(await all.evaluate((b) => getComputedStyle(b).display)).toBe("block");
    await all.click();
    expect(await visibleDecisionOrder(page)).toEqual(["d7", "d6", "d5", "d4", "d3", "d2", "d1"]);
    await expect(all).toHaveText("Vis bare de 5 nyeste");
    await all.click();
    await expect(page.locator("li.dl-item#d1")).toBeHidden();
    expectClean(seen);
  });

  test("a #d1 load and an id link into a hidden older decision show the list and stay in Overview", async ({ page }) => {
    let seen = await open_(page, "", "#d1");
    const d1 = page.locator("li.dl-item#d1");
    await expect(d1).toBeVisible();
    await expect(d1).toBeInViewport();
    expect(await lensOf(page)).toBe("overview");
    expectClean(seen);

    seen = await open_(page);
    await expect(d1).toBeHidden();
    await page.locator(".wiki-article a.wiki-ref", { hasText: "D1" }).first().click();
    await expect(d1).toBeVisible();
    await expect(d1).toBeInViewport();
    expect(await lensOf(page)).toBe("overview");
    expectClean(seen);
  });

  test("a case row is its compact line with the board's labels; «mer» opens the note and the refs", async ({ page }) => {
    const seen = await open_(page);
    const strip = page.locator(".wiki-article .cb-strip");
    await expect(strip).toHaveText("1 holdt ute · 1 venter · 1 feil årsavregning · 2 ikke kandidat · 3 ok");

    const hold = page.locator(".cb-row#case-mel-1");
    await expect(hold.locator(".cb-pill")).toHaveText("holdt ute");
    await expect(hold.locator(".cb-line .cb-head")).toHaveText("Person 1, 2025");
    await expect(hold.locator(".cb-line .cb-kort")).toHaveText("Holdt ute av 2025-lista (D7).");
    await expect(hold.locator(".cb-note")).toBeHidden();
    await expect(hold.locator(".cb-refs")).toBeHidden();
    const more = hold.locator("button.cb-more");
    await expect(more).toHaveText("mer");
    await more.click();
    await expect(hold.locator(".cb-note")).toBeVisible();
    await expect(hold.locator(".cb-refs")).toBeVisible();
    await expect(more).toHaveText("mindre");

    // kort falls back to the note's first bold span, and then to nothing.
    await expect(page.locator(".cb-row#case-mel-2 .cb-pill")).toHaveText("venter");
    await expect(page.locator(".cb-row#case-mel-2 .cb-kort")).toHaveText("Blokkert til oppgave 3 er i prod.");
    await expect(page.locator(".cb-row#case-mel-3 .cb-pill")).toHaveText("feil årsavregning");
    await expect(page.locator(".cb-row#case-mel-3 .cb-line")).toHaveText("mer");

    // `none` stays hidden with its count line, in the board's own word.
    await expect(page.locator('.cb-group[data-status="none"]')).toBeHidden();
    await expect(page.locator(".cb-lens-note")).toHaveText("2 saker med status «ikke kandidat» er skjult");

    // `ok`: the first row, then «+ 2 til».
    await expect(page.locator(".cb-row#case-mel-4")).toBeVisible();
    await expect(page.locator(".cb-row#case-mel-5")).toBeHidden();
    const ok = page.locator(".wiki-article button.cb-okmore");
    await expect(ok).toHaveText("+ 2 til");
    await ok.click();
    await expect(page.locator(".cb-row#case-mel-5")).toBeVisible();
    await expect(page.locator(".cb-row#case-mel-6")).toBeVisible();
    await expect(ok).toHaveText("vis færre");
    expectClean(seen);
  });

  test("closing a fold Overview opened is not stored: a reload opens it again", async ({ page }) => {
    const seen = await open_(page);
    await fold(page, "Saker").locator(":scope > summary").click();
    await expect(fold(page, "Saker")).not.toHaveAttribute("open", /.*/);
    await page.reload();
    await expect(page.locator(".wiki-article")).toBeVisible();
    await expect(fold(page, "Saker")).toHaveAttribute("open", "");
    expectClean(seen);
  });

  test("All renders both blocks as written: authored order, the tail in the text, every row, folds closed", async ({ page }) => {
    const seen = await open_(page, "&lens=all");
    expect(await lensOf(page)).toBe("all");
    await expect(fold(page, "Beslutninger")).not.toHaveAttribute("open", /.*/);
    await fold(page, "Beslutninger").locator(":scope > summary").click();
    await fold(page, "Saker").locator(":scope > summary").click();
    expect(await visibleDecisionOrder(page)).toEqual(["d1", "d2", "d3", "d4", "d5", "d6", "d7"]);
    await expect(page.locator("li.dl-item#d1 .dl-tail")).toHaveText("Fag, 01.10 (runde 1).");
    await expect(page.locator("li.dl-item#d1 .dl-when")).toBeHidden();
    await expect(page.locator(".wiki-article button.dl-all")).toBeHidden();
    await expect(page.locator(".cb-row#case-mel-1 .cb-note")).toBeVisible();
    await expect(page.locator(".cb-row#case-mel-1 .cb-line")).toBeHidden();
    await expect(page.locator(".cb-row#case-mel-6")).toBeVisible();
    await expect(page.locator('.cb-group[data-status="none"]')).toBeVisible();
    // The labels apply in every lens.
    await expect(page.locator(".cb-row#case-mel-1 .cb-pill")).toHaveText("holdt ute");
    expectClean(seen);
  });

  test("switching Overview → All keeps the open folds; back to Overview reopens a closed one", async ({ page }) => {
    const seen = await open_(page);
    await expect(fold(page, "Beslutninger")).toHaveAttribute("open", "");
    await fold(page, "Saker").locator(":scope > summary").click();
    await page.locator(".wiki-lens-switch button[data-lens='all']").click();
    await expect(fold(page, "Beslutninger")).toHaveAttribute("open", "");
    await expect(page.locator("li.dl-item#d1 .dl-tail")).toBeVisible();
    await expect(fold(page, "Saker")).not.toHaveAttribute("open", /.*/);
    await page.locator(".wiki-lens-switch button[data-lens='overview']").click();
    await expect(fold(page, "Saker")).toHaveAttribute("open", "");
    expectClean(seen);
  });
});
