/**
 * The reader's compact DecisionLog and CaseBoard (reader lenses PR 10, D41,
 * D42, acceptance 11), the same in All and Overview since D45.
 *
 * What only a real page can answer: that Overview moves the newest decision
 * first in the DOM — so a mouse selection and Tab follow the screen, and a
 * question between decisions keeps its place — and hides all but five (not one
 * holding a fact-check mark), that the date cell sits right of the text and
 * under it at 650 px, that the tail leaves the text, that
 * a `#d1` load or an id link into a hidden older decision shows the list, that
 * a case row reads as its compact line with the board's labels and «mer»
 * opens the note, that the `ok` group shows one row and «+ N til», that both
 * folds open in Overview and a closed one opens again on reload (not stored),
 * while a fold whose block Overview hides and a click on the lens already
 * shown open none, that a #case hash opens its row, that a fold's size leaves
 * out the reader's own text, and (D45) that All renders both blocks compact
 * too — newest first, five-cap, case lines — showing the `none` rows Overview
 * hides, keeps the order across lens switches, and reveals a capped decision
 * or a folded case from an id link or a hash load. Also that a case holding a
 * fact-check mark is never folded, that Explain gets a DecisionLog selection
 * in authored order with its folded text, that no switch shows where both
 * lenses render the same page, and that the decisions pill lands on the
 * page's newest decision across logs.
 *
 * One Norwegian wiki with `idLabels`, instance default Overview, two pages.
 * Synthetic fixtures.
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
// A question between decisions keeps its place when Overview reverses them.
DECISIONS.splice(3, 0, "- **S0** — Et spørsmål mellom beslutningene? Spurt fag 03.10.");

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
  "Se MEL-1 og MEL-5 for to av sakene.",
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

// Fix round 1: a fact-check mark in an older decision (item 7), a fold whose
// log Overview hides (item 9), a board with only `none` cases (item 9), and a
// fold whose size must leave out the reader's own text (item 19).
const MARKS_REL = "plans/marks.mdx";
const MARKS_PAGE = [
  "---",
  "title: Marks page",
  "type: plan",
  "---",
  "",
  "# Marks page",
  "",
  "<DecisionLog>",
  "",
  ...[1, 2, 3, 4, 5, 6, 7].map((n) =>
    n === 1
      ? '- **D1** — Beslutning nummer 1 gjelder <Fact n="1" v="bad">alle saker i 2023</Fact>. Fag, 01.10 (runde 1).'
      : `- **D${n}** — Beslutning nummer ${n} gjelder alle saker. Fag, 0${n}.10 (runde ${n}).`,
  ),
  "",
  "</DecisionLog>",
  "",
  '<Fold title="Ytre">',
  "",
  "Tekst i den ytre folden.",
  "",
  '<Fold title="Utvikler" for="dev">',
  "",
  "<DecisionLog>",
  "",
  "- **D31** — En beslutning for utviklere gjelder her. Fag, 01.10 (runde 1).",
  "",
  "</DecisionLog>",
  "",
  "</Fold>",
  "",
  "</Fold>",
  "",
  '<Fold title="Ikke kandidater">',
  "",
  '<CaseBoard src="none.yaml" />',
  "",
  "</Fold>",
  "",
  '<Fold title="Liten">',
  "",
  "<DecisionLog>",
  "",
  "- **D21** — Kort beslutning her. Fag, 01.10 (runde 1).",
  "",
  "</DecisionLog>",
  "",
  "</Fold>",
  "",
].join("\n");
const NONE_CASES = '- id: MEL-9\n  status: none\n  note: "Ikke kandidat"\n';

// Fix round 2: a log of two lists with a paragraph between them (items 3, 7),
// and a ref link to a fold holding a log (item 4).
const MULTI_REL = "plans/multi.mdx";
const dl = (n: number) => `- **D${n}** — Beslutning nummer ${n} gjelder alle saker. Fag, 0${n}.10 (runde ${n}).`;
const MULTI_PAGE = [
  "---",
  "title: Multi page",
  "type: plan",
  "---",
  "",
  "# Multi page",
  "",
  "Se «Gamle beslutninger» for de tre første.",
  "",
  "<DecisionLog>",
  "",
  ...[1, 2, 3].map(dl),
  "",
  "Mellomtekst mellom listene.",
  "",
  ...[4, 5, 6, 7, 8].map(dl),
  "",
  "</DecisionLog>",
  "",
  '<Fold title="Gamle beslutninger">',
  "",
  "<DecisionLog>",
  "",
  "- **D31** — Første gamle beslutning gjelder. Fag, 01.10 (runde 1).",
  "- **D32** — Andre gamle beslutning gjelder. Fag, 02.10 (runde 2).",
  "- **D33** — Tredje gamle beslutning gjelder. Fag, 03.10 (runde 3).",
  "",
  "</DecisionLog>",
  "",
  "</Fold>",
  "",
].join("\n");

// PR 673 fix round 1: case notes holding a fact-check mark (item 1), and a
// page whose only lens-relevant content is a top-level DecisionLog (item 3).
const FACT_REL = "plans/fact.mdx";
const FACT_PAGE = [
  "---",
  "title: Fact page",
  "type: plan",
  "---",
  "",
  "# Fact page",
  "",
  '<CaseBoard src="fact-cases.yaml" labels="hold:holdt ute" />',
  "",
].join("\n");
const FACT_CASES = [
  "- id: MEL-11",
  "  status: hold",
  "  note: 'Person 11, 2025 · **Holdt ute.** Gjelder <Fact n=\"1\" v=\"bad\">alle saker i 2023</Fact> og flere'",
  "- id: MEL-12",
  "  status: ok",
  "  note: '2024 · **Første på lista.**'",
  "- id: MEL-13",
  "  status: ok",
  "  note: '2024 · **Andre på lista.** Gjelder <Fact n=\"2\" v=\"bad\">alle saker i 2022</Fact>'",
  "- id: MEL-14",
  "  status: ok",
  "  note: '2024 · **Tredje på lista.**'",
  "",
].join("\n");
const PLAIN_REL = "plans/plain.mdx";
const PLAIN_PAGE = [
  "---",
  "title: Plain page",
  "type: plan",
  "---",
  "",
  "# Plain page",
  "",
  "<DecisionLog>",
  "",
  ...[1, 2, 3, 4, 5, 6, 7].map(dl),
  "",
  "</DecisionLog>",
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

const open_ = async (page: Page, query = "", hash = "", rel = REL) => {
  const seen = watch(page);
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&relPath=${encodeURIComponent(rel)}${query}${hash}`);
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
  await writeFile(path.join(root, MARKS_REL), MARKS_PAGE, "utf8");
  await writeFile(path.join(root, "plans", "none.yaml"), NONE_CASES, "utf8");
  await writeFile(path.join(root, MULTI_REL), MULTI_PAGE, "utf8");
  await writeFile(path.join(root, FACT_REL), FACT_PAGE, "utf8");
  await writeFile(path.join(root, "plans", "fact-cases.yaml"), FACT_CASES, "utf8");
  await writeFile(path.join(root, PLAIN_REL), PLAIN_PAGE, "utf8");
  await writeFile(
    path.join(root, ".wiki-reader.json"),
    JSON.stringify({ language: "no", idLabels: { D: { one: "Beslutning", other: "beslutninger" } } }),
    "utf8",
  );

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
    // The ref links name the decision in the line, as in any prose (D12).
    await expect(hold.locator(".cb-line .cb-kort")).toHaveText("Holdt ute av 2025-lista (Beslutning D7).");
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
    // Item 14: neither head nor kort — no compact line, and the note shows.
    await expect(page.locator(".cb-row#case-mel-3 .cb-line")).toHaveCount(0);
    await expect(page.locator(".cb-row#case-mel-3 .cb-note")).toBeVisible();
    await expect(page.locator(".cb-row#case-mel-3 button.cb-more")).toHaveCount(0);

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

  test("D45: All renders the DecisionLog compact — newest first, five shown, dates, «mer»; folds as authored", async ({ page }) => {
    const seen = await open_(page, "&lens=all");
    expect(await lensOf(page)).toBe("all");
    // Folds stay as authored in All: Overview alone opens them.
    await expect(fold(page, "Beslutninger")).not.toHaveAttribute("open", /.*/);
    await fold(page, "Beslutninger").locator(":scope > summary").click();
    expect(await visibleDecisionOrder(page)).toEqual(["d7", "d6", "d5", "d4", "d3"]);
    const d7 = page.locator("li.dl-item#d7");
    await expect(d7.locator(".dl-when")).toHaveText("Fag, 07.10 · runde 7");
    await expect(d7.locator(".dl-tail")).toBeHidden();
    await expect(d7.locator(".dl-rest")).toBeHidden();
    await d7.locator("button.dl-more").click();
    await expect(d7.locator(".dl-rest")).toBeVisible();
    const all = page.locator(".wiki-article button.dl-all");
    await expect(all).toHaveText("Vis alle 7 beslutninger");
    await all.click();
    expect(await visibleDecisionOrder(page)).toEqual(["d7", "d6", "d5", "d4", "d3", "d2", "d1"]);
    await expect(all).toHaveText("Vis bare de 5 nyeste");
    expectClean(seen);
  });

  test("D45: All renders the CaseBoard compact and shows the none rows Overview hides", async ({ page }) => {
    const seen = await open_(page, "&lens=all");
    await fold(page, "Saker").locator(":scope > summary").click();
    const hold = page.locator(".cb-row#case-mel-1");
    await expect(hold.locator(".cb-pill")).toHaveText("holdt ute");
    await expect(hold.locator(".cb-line .cb-head")).toHaveText("Person 1, 2025");
    await expect(hold.locator(".cb-note")).toBeHidden();
    await hold.locator("button.cb-more").click();
    await expect(hold.locator(".cb-note")).toBeVisible();
    await expect(hold.locator(".cb-refs")).toBeVisible();
    await expect(page.locator(".cb-row#case-mel-4")).toBeVisible();
    await expect(page.locator(".cb-row#case-mel-5")).toBeHidden();
    await expect(page.locator(".wiki-article button.cb-okmore")).toHaveText("+ 2 til");
    // The none rows: shown in All, with no count line; hidden in Overview, with one.
    await expect(page.locator('.cb-group[data-status="none"]')).toBeVisible();
    await expect(page.locator(".cb-row#case-mel-7")).toBeVisible();
    await expect(page.locator(".cb-lens-note")).toBeHidden();
    await expect(page.locator(".wiki-article .cb-strip")).toHaveText("1 holdt ute · 1 venter · 1 feil årsavregning · 2 ikke kandidat · 3 ok");
    await page.locator(".wiki-lens-switch button[data-lens='overview']").click();
    await expect(page.locator(".cb-row#case-mel-7")).toBeHidden();
    await expect(page.locator(".cb-lens-note")).toHaveText("2 saker med status «ikke kandidat» er skjult");
    expectClean(seen);
  });

  test("D45: in All an id link and a hash load reveal a capped decision and a folded case, staying in All", async ({ page }) => {
    let seen = await open_(page, "&lens=all", "#d1");
    const d1 = page.locator("li.dl-item#d1");
    await expect(d1).toBeVisible();
    await expect(d1).toBeInViewport();
    expect(await lensOf(page)).toBe("all");
    expectClean(seen);

    seen = await open_(page, "&lens=all");
    await expect(d1).toBeHidden();
    await page.locator(".wiki-article a.wiki-ref", { hasText: "D1" }).first().click();
    await expect(d1).toBeVisible();
    await expect(d1).toBeInViewport();
    await expect(page.locator(".wiki-article button.dl-all")).toHaveText("Vis bare de 5 nyeste");
    expect(await lensOf(page)).toBe("all");
    expectClean(seen);

    seen = await open_(page, "&lens=all", "#case-mel-5");
    await expect(page.locator(".cb-row#case-mel-5")).toBeVisible();
    await expect(page.locator(".cb-row#case-mel-5 .cb-note")).toBeVisible();
    expect(await lensOf(page)).toBe("all");
    expectClean(seen);

    seen = await open_(page, "&lens=all");
    await page.locator(".wiki-article a.wiki-ref", { hasText: "MEL-1" }).first().click();
    await expect(page.locator(".cb-row#case-mel-1 .cb-note")).toBeVisible();
    await expect(page.locator(".cb-row#case-mel-1")).toBeInViewport();
    await expect(page.locator(".cb-row#case-mel-1 button.cb-more")).toHaveText("mindre");
    await page.locator(".wiki-article a.wiki-ref", { hasText: "MEL-5" }).first().click();
    await expect(page.locator(".cb-row#case-mel-5")).toBeVisible();
    await expect(page.locator(".cb-row#case-mel-5")).toBeInViewport();
    expect(await lensOf(page)).toBe("all");
    expectClean(seen);
  });

  test("switching Overview → All keeps the open folds; back to Overview reopens a closed one", async ({ page }) => {
    const seen = await open_(page);
    await expect(fold(page, "Beslutninger")).toHaveAttribute("open", "");
    await fold(page, "Saker").locator(":scope > summary").click();
    await page.locator(".wiki-lens-switch button[data-lens='all']").click();
    await expect(fold(page, "Beslutninger")).toHaveAttribute("open", "");
    // D45: All shows the same compact log, its five-cap included.
    expect(await visibleDecisionOrder(page)).toEqual(["d7", "d6", "d5", "d4", "d3"]);
    await expect(page.locator("li.dl-item#d7 .dl-when")).toBeVisible();
    await expect(fold(page, "Saker")).not.toHaveAttribute("open", /.*/);
    await page.locator(".wiki-lens-switch button[data-lens='overview']").click();
    await expect(fold(page, "Saker")).toHaveAttribute("open", "");
    expectClean(seen);
  });

  test("fix round 1, item 1: the DOM follows the screen — selection, Tab, a question kept in place", async ({ page }) => {
    const seen = await open_(page);
    // The question between D3 and D4 keeps its slot; the decisions around it reverse.
    const listOrder = await page
      .locator(".wiki-article section.decision-log > .dl-list > li")
      .evaluateAll((els) => els.map((e) => e.id));
    expect(listOrder).toEqual(["d7", "d6", "d5", "s0", "d4", "d3", "d2", "d1", "s1"]);

    // A mouse selection from D7 down to D6 reads D7 first.
    const [a, b] = await Promise.all([
      page.locator("li.dl-item#d7 .dl-first").boundingBox(),
      page.locator("li.dl-item#d6 .dl-first").boundingBox(),
    ]);
    await page.mouse.move(a!.x + 2, a!.y + a!.height / 2);
    await page.mouse.down();
    await page.mouse.move(b!.x + b!.width - 2, b!.y + b!.height / 2, { steps: 8 });
    await page.mouse.up();
    const sel = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(sel).toContain("nummer 7");
    expect(sel).toContain("nummer 6");
    expect(sel.indexOf("nummer 7")).toBeLessThan(sel.indexOf("nummer 6"));

    // Tab walks the rows in the order they are drawn.
    await page.locator("li.dl-item#d7 a.dl-id").focus();
    const rows: string[] = [];
    for (let k = 0; k < 24; k++) {
      const id = await page.evaluate(() => document.activeElement?.closest("li.dl-item")?.id ?? "");
      if (id && rows[rows.length - 1] !== id) rows.push(id);
      await page.keyboard.press("Tab");
    }
    expect(rows.slice(0, 7)).toEqual(["d7", "d6", "d5", "s0", "d4", "d3", "s1"]);

    // «Vis alle» sits after the log; D45: switching lenses back and forth keeps
    // the newest-first order, neither reversing it twice nor restoring the
    // authored one.
    expect(await page.locator("section.decision-log > :last-child").evaluate((el) => el.className)).toBe("dl-all");
    const ids = () => page.locator(".wiki-article section.decision-log > .dl-list > li").evaluateAll((els) => els.map((e) => e.id));
    for (const lens of ["all", "overview", "all"]) {
      await page.locator(`.wiki-lens-switch button[data-lens='${lens}']`).click();
      expect(await ids()).toEqual(listOrder);
    }
    // The authored positions ride along, for a peek's copy.
    expect(await page.locator(".wiki-article section.decision-log > .dl-list > li").evaluateAll((els) => els.map((e) => e.getAttribute("data-dl-order")))).toEqual([
      "7", "6", "5", "3", "4", "2", "1", "0", "8",
    ]);
    expectClean(seen);
  });

  test("fix round 1, item 3: a compact decision row keeps its «Beslutning» noun", async ({ page }) => {
    const seen = await open_(page);
    const noun = page.locator("li.dl-item#d7 > .id-noun");
    await expect(noun).toBeVisible();
    await expect(noun).toHaveText("Beslutning");
    expectClean(seen);
  });

  test("fix round 1, item 5: at 650 px the date cell drops under the text, which keeps the row", async ({ page }) => {
    await page.setViewportSize({ width: 650, height: 900 });
    const seen = await open_(page);
    const row = page.locator("li.dl-item#d7");
    const [r, t, w] = await Promise.all([row.boundingBox(), row.locator(".dl-text").boundingBox(), row.locator(".dl-when").boundingBox()]);
    expect(t!.width).toBeGreaterThanOrEqual(0.6 * r!.width);
    expect(w!.y).toBeGreaterThan(t!.y);
    expectClean(seen);
  });

  test("fix round 1, item 6: «7 beslutninger» lands on the newest decision and keeps the five-cap", async ({ page }) => {
    const seen = await open_(page);
    await page.locator(".wiki-article").evaluate((el) => el.closest("#articleWrap")!.scrollTo(0, 99999));
    await page.locator(".wiki-count-pill-decisions").click();
    await expect(page.locator("li.dl-item#d7")).toBeInViewport();
    await expect(page.locator("li.dl-item#d1")).toBeHidden();
    await expect(page.locator(".wiki-article button.dl-all")).toHaveText("Vis alle 7 beslutninger");
    expect(await lensOf(page)).toBe("overview");
    expectClean(seen);
  });

  test("fix round 1, item 7: an older decision holding a fact-check mark is not folded away", async ({ page }) => {
    const seen = await open_(page, "", "", MARKS_REL);
    expect((await visibleDecisionOrder(page)).slice(0, 6)).toEqual(["d7", "d6", "d5", "d4", "d3", "d1"]);
    await expect(page.locator("li.dl-item#d2")).toBeHidden();
    await expect(page.locator("li.dl-item#d1 .fc-mark")).toBeVisible();
    expectClean(seen);
  });

  test("fix round 1, item 8: in All the ok group's rows keep their dashed rule", async ({ page }) => {
    const seen = await open_(page, "&lens=all");
    await fold(page, "Saker").locator(":scope > summary").click();
    await page.locator(".wiki-article button.cb-okmore").click();
    await expect(page.locator(".cb-row#case-mel-5")).toBeVisible();
    expect(await page.locator(".cb-row#case-mel-5").evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("dashed");
    expectClean(seen);
  });

  test("fix round 1, item 9: Overview opens no fold for a block it hides", async ({ page }) => {
    const seen = await open_(page, "", "", MARKS_REL);
    await expect(fold(page, "Liten")).toHaveAttribute("open", "");
    await expect(fold(page, "Ytre")).not.toHaveAttribute("open", /.*/);
    await expect(fold(page, "Ikke kandidater")).not.toHaveAttribute("open", /.*/);
    expectClean(seen);
  });

  test("fix round 1, item 9: a click on Overview while in Overview opens no fold", async ({ page }) => {
    const seen = await open_(page);
    await fold(page, "Saker").locator(":scope > summary").click();
    await expect(fold(page, "Saker")).not.toHaveAttribute("open", /.*/);
    await page.locator(".wiki-lens-switch button[data-lens='overview']").click();
    await expect(fold(page, "Saker")).not.toHaveAttribute("open", /.*/);
    expectClean(seen);
  });

  test("fix round 1, item 10: a #case hash opens the row's «mer», and reveals a folded ok row", async ({ page }) => {
    let seen = await open_(page, "", "#case-mel-1");
    await expect(page.locator(".cb-row#case-mel-1 .cb-note")).toBeVisible();
    await expect(page.locator(".cb-row#case-mel-1 button.cb-more")).toHaveText("mindre");
    expect(await lensOf(page)).toBe("overview");
    expectClean(seen);

    seen = await open_(page, "", "#case-mel-5");
    await expect(page.locator(".cb-row#case-mel-5")).toBeVisible();
    await expect(page.locator(".cb-row#case-mel-5 .cb-note")).toBeVisible();
    expect(await lensOf(page)).toBe("overview");
    expectClean(seen);
  });

  test("D45 (was fix round 1, item 11): a reveal in All shows the whole log, and Overview keeps it shown", async ({ page }) => {
    const seen = await open_(page, "&lens=all", "#d1");
    await expect(page.locator("li.dl-item#d1")).toBeVisible();
    await page.locator(".wiki-lens-switch button[data-lens='overview']").click();
    await expect(page.locator("li.dl-item#d1")).toBeVisible();
    await expect(page.locator(".wiki-article button.dl-all")).toHaveText("Vis bare de 5 nyeste");
    expectClean(seen);
  });

  test("fix round 1, item 19: a fold's size leaves out the reader's own text", async ({ page }) => {
    const seen = await open_(page, "", "", MARKS_REL);
    const written = "D21Kort beslutning her. Fag, 01.10 (runde 1).".length;
    await expect(fold(page, "Liten").locator(":scope > summary .fold-size")).toHaveText(`${written} tegn · <1 min`);
    expectClean(seen);
  });
  test("fix round 2, item 3: «N beslutninger» lands on the page's newest decision and keeps the five-cap", async ({ page }) => {
    const seen = await open_(page, "", "", MULTI_REL);
    await page.locator(".wiki-article").evaluate((el) => el.closest("#articleWrap")!.scrollTo(0, 99999));
    await page.locator(".wiki-count-pill-decisions").click();
    // PR 673 fix round 1, item 4: the last list holding a decision is the
    // fold's log below the two-list one, so its newest item is the target.
    await expect(page.locator("li.dl-item#d33")).toBeInViewport();
    await expect(page.locator("li.dl-item#d3")).toBeHidden();
    await expect(page.locator("section.decision-log").first().locator(":scope > button.dl-all")).toHaveText("Vis alle 8 beslutninger");
    const shown = await page
      .locator("section.decision-log")
      .first()
      .locator("li.dl-item.dl-decision")
      .evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.id));
    expect(shown).toEqual(["d8", "d7", "d6", "d5", "d4"]);
    expect(await lensOf(page)).toBe("overview");
    expectClean(seen);
  });

  test("fix round 2, item 7: «Vis alle» sits after the log's last list", async ({ page }) => {
    const seen = await open_(page, "", "", MULTI_REL);
    const log = page.locator("section.decision-log").first();
    expect(await log.locator(":scope > :last-child").evaluate((el) => el.className)).toBe("dl-all");
    expect(await log.locator(":scope > button.dl-all").evaluate((b) => b.previousElementSibling?.querySelector("li")?.id ?? "")).toBe("d8");
    expectClean(seen);
  });

  test("fix round 2, item 4: a peek of a fold shows its DecisionLog in authored order in Overview", async ({ page }) => {
    const seen = await open_(page, "", "", MULTI_REL);
    expect(await lensOf(page)).toBe("overview");
    await page.locator(".wiki-article a.wiki-ref", { hasText: "Gamle beslutninger" }).first().hover();
    const peek = page.locator(".wiki-ref-peek");
    await expect(peek).toBeVisible();
    expect(await peek.locator(".dl-id").allTextContents()).toEqual(["D31", "D32", "D33"]);
    // A lens change while the card is open reorders the page's logs, not the card's.
    await page.evaluate(() => {
      for (const lens of ["all", "overview"]) document.querySelector<HTMLElement>(`.wiki-lens-switch button[data-lens='${lens}']`)!.click();
    });
    await expect(peek).toBeVisible();
    expect(await peek.locator(".dl-id").allTextContents()).toEqual(["D31", "D32", "D33"]);
    // The page's own log stays newest first.
    expect(await fold(page, "Gamle beslutninger").locator("li.dl-item").evaluateAll((els) => els.map((e) => e.id))).toEqual([
      "d33", "d32", "d31",
    ]);
    expectClean(seen);
  });

  test("fix round 2, item 6: between 18rem and 28rem the date cell sits under the text", async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 900 });
    const seen = await open_(page);
    const log = page.locator(".wiki-article section.decision-log").first();
    const width = (await log.boundingBox())!.width;
    expect(width).toBeGreaterThan(18 * 16);
    expect(width).toBeLessThan(28 * 16);
    const row = page.locator("li.dl-item#d7");
    const [t, w] = await Promise.all([row.locator(".dl-text").boundingBox(), row.locator(".dl-when").boundingBox()]);
    expect(w!.y).toBeGreaterThanOrEqual(t!.y + t!.height - 1);
    expectClean(seen);
  });

  test("fix round 2, item 8: a one-sentence decision with a date tail gets no «mer»", async ({ page }) => {
    const seen = await open_(page, "", "", MARKS_REL);
    const d21 = page.locator("li.dl-item#d21");
    await expect(d21).toBeVisible();
    await expect(d21.locator(".dl-when")).toBeVisible();
    await expect(d21.locator("button.dl-more")).toHaveCount(0);
    expectClean(seen);
  });

  test("PR 673 fix round 1, item 1: a case whose note holds a fact-check mark is never folded away", async ({ page }) => {
    for (const lens of ["all", "overview"]) {
      const seen = await open_(page, `&lens=${lens}`, "", FACT_REL);
      // The hold row starts open: its note, and the ❌ in it, are on screen.
      const hold = page.locator(".cb-row#case-mel-11");
      await expect(hold.locator(".cb-note .fc-mark")).toBeVisible();
      await expect(hold.locator("button.cb-more")).toHaveText("mindre");
      // The ok group shows its first row and the marked row; «+ N til» counts only the folded one.
      await expect(page.locator(".cb-row#case-mel-12")).toBeVisible();
      await expect(page.locator(".cb-row#case-mel-13 .fc-mark")).toBeVisible();
      await expect(page.locator(".cb-row#case-mel-14")).toBeHidden();
      await expect(page.locator(".wiki-article button.cb-okmore")).toHaveText("+ 1 til");
      expectClean(seen);
    }
  });

  test("PR 673 fix round 1, item 2: Explain gets a DecisionLog selection in authored order, rest and tail included", async ({ page }) => {
    const sent: string[] = [];
    await page.route("**/api/wiki/explain?**", (route) => {
      sent.push(new URL(route.request().url()).searchParams.get("sel") ?? "");
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: `event: done\ndata: ${JSON.stringify({ answer: "Svar." })}\n\n`,
      });
    });
    const anchors: string[] = [];
    const explain = async (fn: () => void) => {
      await page.evaluate(fn);
      await expect(page.locator("#wikiExplainBtn")).toBeVisible();
      // The page's own selection is left as the reader made it.
      anchors.push(await page.evaluate(() => window.getSelection()!.anchorNode?.parentElement?.closest("li")?.id ?? ""));
      await page.locator("#wikiExplainBtn").dispatchEvent("mousedown");
      await expect.poll(() => sent.length).toBeGreaterThan(0);
      return sent.splice(0)[0]!;
    };

    // One item, from inside its first sentence to its end: the folded rest and
    // the date tail come with it, the date cell and «mer» do not.
    let seen = await open_(page);
    const one = await explain(() => {
      const li = document.querySelector("li.dl-item#d7")!;
      const text = li.querySelector(".dl-first")!.firstChild!;
      const r = document.createRange();
      r.setStart(text, "Beslutning ".length);
      r.setEnd(li, li.childNodes.length);
      const w = window.getSelection()!;
      w.removeAllRanges();
      w.addRange(r);
      document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    expect(one).toBe("nummer 7 gjelder alle saker. Begrunnelse 7. Fag, 07.10 (runde 7).");
    expectClean(seen);

    // Two reordered rows, D7 above D6 on screen: D6 comes first, both whole.
    seen = await open_(page);
    const two = await explain(() => {
      const r = document.createRange();
      r.setStart(document.querySelector("li.dl-item#d7 .dl-first")!.firstChild!, 0);
      const end = document.querySelector("li.dl-item#d6 .dl-first")!.firstChild!;
      r.setEnd(end, end.textContent!.length);
      const w = window.getSelection()!;
      w.removeAllRanges();
      w.addRange(r);
      document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    expect(two.replace(/\s+/g, " ")).toBe(
      "D6Beslutning nummer 6 gjelder alle saker. Begrunnelse 6. Fag, 06.10 (runde 6). " +
        "D7Beslutning nummer 7 gjelder alle saker. Begrunnelse 7. Fag, 07.10 (runde 7).",
    );
    expect(anchors).toEqual(["d7", "d7"]);
    expectClean(seen);
  });

  test("PR 673 fix round 1, item 3: no lens switch where both lenses show the same page", async ({ page }) => {
    let seen = await open_(page, "", "", PLAIN_REL);
    await expect(page.locator("li.dl-item#d7 .dl-when")).toBeVisible();
    await expect(page.locator(".wiki-lens-switch")).toHaveCount(0);
    expectClean(seen);
    // A compact block in a fold Overview opens, or none rows, still show it.
    seen = await open_(page);
    await expect(page.locator(".wiki-lens-switch")).toHaveCount(1);
    expectClean(seen);
  });

  test("PR 673 fix round 1, items 4–5: in All «N beslutninger» lands on the page's newest decision, across logs", async ({ page }) => {
    let seen = await open_(page, "&lens=all");
    await page.locator(".wiki-article").evaluate((el) => el.closest("#articleWrap")!.scrollTo(0, 99999));
    await page.locator(".wiki-count-pill-decisions").click();
    await expect(page.locator("li.dl-item#d7")).toBeInViewport();
    await expect(page.locator("li.dl-item#d1")).toBeHidden();
    expect(await lensOf(page)).toBe("all");
    expectClean(seen);

    // Two logs: the newest decision is the last list's, inside the closed fold.
    seen = await open_(page, "&lens=all", "", MULTI_REL);
    await expect(fold(page, "Gamle beslutninger")).not.toHaveAttribute("open", /.*/);
    await page.locator(".wiki-count-pill-decisions").click();
    await expect(page.locator("li.dl-item#d33")).toBeInViewport();
    await expect(fold(page, "Gamle beslutninger")).toHaveAttribute("open", "");
    expect(await lensOf(page)).toBe("all");
    expectClean(seen);
  });
});
