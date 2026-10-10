/**
 * The reader lenses: the Overview / All switch, its precedence and storage,
 * the reveal rule, the counted header pills and the id nouns.
 *
 * What only a real page can answer: that Overview's CSS really takes each
 * hidden block off the screen and leaves a Query card's question and answer
 * on it, that a `?lens=` link applies once and leaves the address bar, that
 * a reveal of a hidden target (a bare id link, a card's decision chip, a
 * header pill, a `#q-n` load) shows All for that view only, and that the
 * pills count the rendered page.
 *
 * Three wikis in one process: `e2e-lens` (Norwegian, `idLabels`, file
 * `defaultLens: all`, instance `WIKI_DEFAULT_LENS=e2e-lens=overview`),
 * `e2e-lens-file` (file `defaultLens: oversikt`, no instance default) and
 * `e2e-lens-none` (no reader config). Synthetic fixtures only.
 *
 * No model calls, no DB rows. ENV / SPAWN ENV: no `.env` is required — the
 * spawn inherits `DATABASE_URL` and `e2eEnv()` blanks the platform tokens and
 * the host's instance-profile flags, `WIKI_DEFAULT_LENS` among them.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { LENS_KEY } from "../src/format/reader-lens.ts";
import { AGENT_CONTEXT_FOLD_NAMES } from "../src/format/agent-context.ts";

const PORT = e2ePort("wiki-lens");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-lens";
const WIKI_FILE = "e2e-lens-file";
const WIKI_NONE = "e2e-lens-none";

const REPORT_REL = "plans/report.mdx";
const COUNTS_REL = "plans/counts.mdx";
const NOUNS_REL = "plans/nouns.mdx";

const fold = (title: string, body: string, attrs = "") => [`<Fold title="${title}"${attrs}>`, "", body, "", "</Fold>", ""].join("\n");

const REPORT = [
  "---",
  "title: Lens report",
  "type: plan",
  "plan_status: in-flight",
  "---",
  "",
  "# Lens report",
  "",
  "Kode sjekket (`src/main/Gate.kt:120-128`, `:42`). Se D12 og S9, og [[counts]].",
  "",
  '<Historic since="x#1">',
  "",
  "Gammel historikk.",
  "",
  "</Historic>",
  "",
  "```kotlin",
  "val toppnivaa = 1",
  "```",
  "",
  ...AGENT_CONTEXT_FOLD_NAMES.map((name) => fold(`${name} — 08.10`, `Kontekst for neste økt: ${name}.`)),
  fold(
    "Samtalen med fag",
    [
      "Lang samtalelogg.",
      "",
      '<Query id="Q-9" question="Skjult spørring?" answer="Skjult svar." />',
      "",
      "<DecisionLog>",
      "",
      "- **D12** — Skjult beslutning.",
      "",
      "</DecisionLog>",
    ].join("\n"),
    ' for="dev"',
  ),
  fold(
    "Spørringer",
    [
      '<Query id="Q-1" question="Hvor mange saker?" answer="Førtito." run="2026-10-07" uses="8045" csv="data/q1.csv" sql="data/q1.sql">',
      "",
      "Lesningen av resultatet.",
      "",
      fold("Om spørringen", "Detaljer om spørringen."),
      "</Query>",
      "",
      '<Query id="Q-2" question="Hvilke typer?" answer="Tre." csv="data/q2.csv" />',
    ].join("\n"),
  ),
  '<CaseBoard src="data/cases.yaml" />',
  "",
  '<Question id="S9">',
  "",
  "Hva gjør vi nå?",
  "",
  "</Question>",
  "",
  "<DecisionLog>",
  "",
  "- **S9** — Hva gjør vi nå? Lukket 08.10 (D12).",
  "- **D13** — Sjekket (`src/main/Gate.kt:200-210`).",
  "",
  "</DecisionLog>",
  "",
  "Se D13 for koden.",
  "",
].join("\n");

/** Acceptance 4: 11 D items (D1 repeated in a second log), five open S items,
 *  one closed with the canonical phrase, one struck, no `<Question>`. */
const COUNTS = [
  "---",
  "title: Counts page",
  "type: plan",
  "---",
  "",
  "# Counts page",
  "",
  "<DecisionLog>",
  "",
  ...Array.from({ length: 11 }, (_, i) => `- **D${i + 1}** — Beslutning nummer ${i + 1}.`),
  "- **S1** — Åpent.",
  "- **S2** — Åpent.",
  "- ~~**S3** — Strøket.~~",
  "- **S5** — Lukket 07.10 (D10).",
  "- **S6** — Åpent.",
  "- **S7** — Åpent.",
  "- **S8** — Åpent.",
  "- **R1** — Et funn, ikke et spørsmål.",
  "",
  "</DecisionLog>",
  "",
  "<DecisionLog>",
  "",
  "- **D1** — Gjentatt.",
  "",
  "</DecisionLog>",
  "",
  "Se D2–D11 og S1, S2 og S6.",
  "",
  "**Beslutning** D7 gjelder fortsatt.",
  "",
].join("\n");

/** Fix round 2, R1: a bare id after a heading, a list and a bold word that
 *  ends the previous paragraph gets the noun; the noun the author wrote
 *  before the id, in bold or before a bold id, is not doubled. */
const NOUNS = [
  "---",
  "title: Nouns page",
  "type: plan",
  "---",
  "",
  "# Nouns page",
  "",
  "<DecisionLog>",
  "",
  "- **D7** — Sju.",
  "",
  "</DecisionLog>",
  "",
  "### Beslutninger",
  "",
  "D7 gjelder etter overskriften.",
  "",
  "- Et punkt om beslutning",
  "",
  "D7 gjelder etter lista.",
  "",
  "Noe om **beslutning**",
  "",
  "D7 gjelder etter fet skrift.",
  "",
  "**Beslutning** D7 gjelder fortsatt.",
  "",
  "Beslutning **D7** gjelder også.",
  "",
].join("\n");

const CASES = [
  "- id: MEL-1",
  "  status: hold",
  "- id: MEL-2",
  "  status: wait",
  "- id: MEL-3",
  "  status: none",
  "- id: MEL-4",
  "  status: none",
  "- id: MEL-5",
  "  status: ok",
  "",
].join("\n");

const PLAIN = (title: string) => ["---", `title: ${title}`, "---", "", `# ${title}`, "", "Lesbar tekst.", "", "<Historic>", "", "Gammelt.", "", "</Historic>", ""].join("\n");

const ID_LABELS = {
  S: { one: "Spørsmål", other: "spørsmål" },
  D: { one: "Beslutning", other: "beslutninger" },
  Q: { one: "Query", other: "queries" },
};

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

const url = (wiki: string, rel: string, extra = "") =>
  `${BASE}/wiki?wiki=${wiki}&relPath=${encodeURIComponent(rel)}${extra}`;

const open_ = async (page: Page, wiki: string, rel: string, extra = "") => {
  const seen = watch(page);
  await page.goto(url(wiki, rel, extra));
  await expect(page.locator(".wiki-article")).toBeVisible();
  return seen;
};

const lensOf = (page: Page) =>
  page.locator(".wiki-article").evaluate((el) =>
    el.classList.contains("lens-overview") ? "overview" : el.classList.contains("lens-agent") ? "agent" : "all",
  );
const stored = (page: Page) => page.evaluate((k) => localStorage.getItem(k), LENS_KEY);
const setStored = async (page: Page, v: string | null) => {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}`);
  await page.evaluate(
    ([k, val]) => (val === null ? localStorage.removeItem(k!) : localStorage.setItem(k!, val)),
    [LENS_KEY, v] as const,
  );
};

const expectClean = (seen: { failed: string[]; errors: string[] }) => {
  expect(seen.failed).toEqual([]);
  expect(seen.errors).toEqual([]);
};

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-lens-"));
  const main = path.join(root, "main");
  const file = path.join(root, "file");
  const none = path.join(root, "none");
  for (const d of [path.join(main, "plans", "data"), path.join(file, "plans"), path.join(none, "plans")]) {
    await mkdir(d, { recursive: true });
  }
  await writeFile(path.join(main, REPORT_REL), REPORT, "utf8");
  await writeFile(path.join(main, COUNTS_REL), COUNTS, "utf8");
  await writeFile(path.join(main, NOUNS_REL), NOUNS, "utf8");
  await writeFile(path.join(main, "plans", "data", "q1.csv"), "type,antall\nA,40\nB,2\n", "utf8");
  await writeFile(path.join(main, "plans", "data", "q1.sql"), "SELECT type, COUNT(*) FROM sak GROUP BY type;\n", "utf8");
  await writeFile(path.join(main, "plans", "data", "q2.csv"), "type\nA\nB\nC\n", "utf8");
  await writeFile(path.join(main, "plans", "data", "cases.yaml"), CASES, "utf8");
  await writeFile(
    path.join(main, ".wiki-reader.json"),
    JSON.stringify({ language: "no", idLabels: ID_LABELS, defaultLens: "all" }),
    "utf8",
  );
  await writeFile(path.join(file, "plans", "page.mdx"), PLAIN("File page"), "utf8");
  await writeFile(path.join(file, ".wiki-reader.json"), JSON.stringify({ defaultLens: "oversikt" }), "utf8");
  await writeFile(path.join(none, "plans", "page.mdx"), PLAIN("None page"), "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${main},${WIKI_FILE}=${file},${WIKI_NONE}=${none}`,
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

test.describe("Wiki reader: lenses", () => {
  test("acceptance 1: Overview hides the working detail and keeps each Query's question and answer", async ({ page }) => {
    await setStored(page, null);
    const seen = await open_(page, WIKI, REPORT_REL);
    // The instance default (overview) beats the file's (all) with nothing stored.
    expect(await lensOf(page)).toBe("overview");
    const sw = page.locator(".wiki-article-head .wiki-lens-switch");
    await expect(sw.locator("button")).toHaveText(["Oversikt", "Alt"]);
    await expect(sw.locator('button[aria-pressed="true"]')).toHaveText("Oversikt");
    // No Agent lens on any instance yet.
    await expect(sw.locator('button[data-lens="agent"]')).toHaveCount(0);

    const art = page.locator(".wiki-article");
    await expect(art.locator(".code-ref-group")).toHaveCount(2);
    await expect(art.locator(".code-ref-group").first()).toBeHidden();
    await expect(art.locator("section.historic")).toBeHidden();
    await expect(art.locator(":scope > .fence, :scope > pre")).toHaveCount(1);
    await expect(art.locator(":scope > .fence, :scope > pre")).toBeHidden();
    for (const name of AGENT_CONTEXT_FOLD_NAMES) {
      await expect(art.locator("details.fold", { hasText: `${name} — 08.10` }).first()).toBeHidden();
    }
    await expect(art.locator("details.fold.fold-agent-context")).toHaveCount(AGENT_CONTEXT_FOLD_NAMES.length);
    await expect(art.locator("details.fold.fold-for-dev")).toBeHidden();

    // The fold of Query cards stays; each card is its question and answer.
    const qFold = art.locator("details.fold", { hasText: "Spørringer" }).first();
    await expect(qFold).toBeVisible();
    await qFold.locator(":scope > summary").click();
    const q1 = art.locator("section.query#q-1");
    await expect(q1.locator(".query-question")).toBeVisible();
    await expect(q1.locator(".query-answer")).toHaveText("Førtito.");
    for (const part of [".query-body", ".query-result", ".query-sql", ".query-meta"]) {
      await expect(q1.locator(part)).toBeHidden();
    }
    await expect(art.locator("section.query#q-2 .query-result")).toBeHidden();

    // CaseBoard: the `none` rows go, the board says how many.
    await expect(art.locator(".cb-row")).toHaveCount(5);
    await expect(art.locator('.cb-group[data-status="none"]')).toBeHidden();
    await expect(art.locator('.cb-group[data-status="hold"] .cb-row')).toBeVisible();
    await expect(art.locator(".cb-lens-note")).toHaveText("2 saker med status «none» er skjult");

    // One click shows everything again.
    await sw.locator('button[data-lens="all"]').click();
    expect(await lensOf(page)).toBe("all");
    await expect(art.locator("section.historic")).toBeVisible();
    await expect(art.locator("details.fold.fold-for-dev")).toBeVisible();
    await expect(q1.locator(".query-result")).toBeVisible();
    await expect(art.locator('.cb-group[data-status="none"]')).toBeVisible();
    await expect(art.locator(".cb-lens-note")).toBeHidden();
    expectClean(seen);
  });

  test("acceptance 2: the choice survives a reload and a page change; ?lens= applies once", async ({ page }) => {
    await setStored(page, null);
    let seen = await open_(page, WIKI, REPORT_REL);
    expect(await lensOf(page)).toBe("overview");
    await page.locator('.wiki-lens-switch button[data-lens="all"]').click();
    expect(await stored(page)).toBe("all");
    await page.reload();
    await expect(page.locator(".wiki-article")).toBeVisible();
    expect(await lensOf(page)).toBe("all");
    // A page change keeps it: the counts page opens in All.
    await page.locator(".wiki-article a.wiki-link", { hasText: "counts" }).click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Counts page");
    expect(await lensOf(page)).toBe("all");
    expectClean(seen);

    // `?lens=oversikt` (the alias) wins once, leaves the URL, stores nothing.
    seen = await open_(page, WIKI, REPORT_REL, "&lens=oversikt");
    expect(await lensOf(page)).toBe("overview");
    await expect.poll(() => new URL(page.url()).searchParams.has("lens")).toBe(false);
    expect(new URL(page.url()).searchParams.get("relPath")).toBe(REPORT_REL);
    expect(await stored(page)).toBe("all");
    await page.reload();
    await expect(page.locator(".wiki-article")).toBeVisible();
    expect(await lensOf(page)).toBe("all");

    // `?lens=agent` where the Agent lens is unavailable is All, stores nothing.
    await page.evaluate((k) => localStorage.setItem(k, "overview"), LENS_KEY);
    await page.goto(url(WIKI, REPORT_REL, "&lens=agent"));
    await expect(page.locator(".wiki-article")).toBeVisible();
    expect(await lensOf(page)).toBe("all");
    await expect(page.locator('.wiki-lens-switch button[data-lens="agent"]')).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.has("lens")).toBe(false);
    expect(await stored(page)).toBe("overview");
    expectClean(seen);
  });

  test("acceptance 2: the wiki's own default applies only when nothing is stored", async ({ page }) => {
    await setStored(page, null);
    await open_(page, WIKI_FILE, "plans/page.mdx");
    expect(await lensOf(page)).toBe("overview");
    await open_(page, WIKI_NONE, "plans/page.mdx");
    expect(await lensOf(page)).toBe("all");
    // A stored choice beats both defaults.
    await page.evaluate((k) => localStorage.setItem(k, "all"), LENS_KEY);
    await open_(page, WIKI_FILE, "plans/page.mdx");
    expect(await lensOf(page)).toBe("all");
    await page.evaluate((k) => localStorage.setItem(k, "all"), LENS_KEY);
    await open_(page, WIKI, REPORT_REL);
    expect(await lensOf(page)).toBe("all");
  });

  test("acceptance 3: a bare id link to a hidden block shows All for this view; the next page is Overview", async ({ page }) => {
    await setStored(page, "overview");
    const seen = await open_(page, WIKI, REPORT_REL);
    expect(await lensOf(page)).toBe("overview");
    const target = page.locator(".wiki-article li.dl-item#d12");
    await expect(target).toBeHidden();
    await page.locator(".wiki-article a.wiki-ref", { hasText: "D12" }).first().click();
    expect(await lensOf(page)).toBe("all");
    await expect(target).toBeVisible();
    expect(await stored(page)).toBe("overview");
    // The next page opens in the stored lens.
    await page.locator(".wiki-article a.wiki-link", { hasText: "counts" }).click();
    await expect(page.locator(".wiki-article-head h1")).toHaveText("Counts page");
    expect(await lensOf(page)).toBe("overview");
    expectClean(seen);
  });

  test("acceptance 3: a card's decision chip and a header pill reveal through the lens", async ({ page }) => {
    await setStored(page, "overview");
    let seen = await open_(page, WIKI, REPORT_REL);
    const chip = page.locator(".wiki-article section.question a.q-decision");
    await expect(chip).toHaveText("D12");
    await chip.click();
    expect(await lensOf(page)).toBe("all");
    await expect(page.locator(".wiki-article li.dl-item#d12")).toBeVisible();
    expectClean(seen);

    seen = await open_(page, WIKI, REPORT_REL);
    expect(await lensOf(page)).toBe("overview");
    await expect(page.locator(".wiki-article section.historic")).toBeHidden();
    await page.locator(".wiki-article-head .wiki-historic-pill").click();
    expect(await lensOf(page)).toBe("all");
    await expect(page.locator(".wiki-article section.historic")).toBeVisible();
    expect(await stored(page)).toBe("overview");
    expectClean(seen);
  });

  test("acceptance 3: a #q-n hash load to a hidden card opens it in All", async ({ page }) => {
    await setStored(page, "overview");
    const seen = await open_(page, WIKI, REPORT_REL, "#q-9");
    await expect.poll(() => lensOf(page)).toBe("all");
    const card = page.locator(".wiki-article section.query#q-9");
    await expect(card).toBeVisible();
    await expect(card.locator(".query-answer")).toHaveText("Skjult svar.");
    expect(await stored(page)).toBe("overview");
    expectClean(seen);
  });

  test("acceptance 3: with idLabels the chip reads its full name and its link still resolves", async ({ page }) => {
    await setStored(page, "all");
    const seen = await open_(page, WIKI, REPORT_REL);
    const item = page.locator(".wiki-article li.dl-item#s9");
    await expect(item.locator(":scope > .id-noun")).toHaveText("Spørsmål");
    await expect(item.locator(":scope > .dl-id")).toHaveText("S9");
    expect((await item.innerText()).replace(/\s+/g, " ")).toMatch(/^Spørsmål S9/);
    await expect(page.locator(".wiki-article section.query#q-1 .id-noun")).toHaveText("Query");
    // The prose ref gets the noun too, and still resolves to the item.
    const ref = page.locator(".wiki-article a.wiki-ref", { hasText: "S9" }).first();
    expect(await ref.evaluate((a) => (a.previousElementSibling as HTMLElement | null)?.textContent)).toBe("Spørsmål");
    await ref.click();
    await expect.poll(() => new URL(page.url()).hash).toBe("#s9");
    // The card's id chip links the same item.
    await expect(page.locator(".wiki-article section.question a.q-id")).toHaveAttribute("href", "#s9");
    expectClean(seen);
  });

  test("acceptance 4: the pills count the rendered page; anchors stay unique", async ({ page }) => {
    await setStored(page, "overview");
    let seen = await open_(page, WIKI, COUNTS_REL);
    const row = page.locator(".wiki-article-head .wiki-meta-row");
    await expect(row.locator(".wiki-count-pill-decisions")).toHaveText("11 beslutninger");
    await expect(row.locator(".wiki-count-pill-open")).toHaveText("5 åpne");
    await expect(row.locator(".wiki-count-pill-queries")).toHaveCount(0);
    const ids = await page.locator(".wiki-article [id]").evaluateAll((els) => els.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("d1-2");
    // A range gets the noun once, plural; a list of one prefix too.
    const nouns = await page.locator(".wiki-article > .id-noun, .wiki-article p .id-noun").allTextContents();
    expect(nouns).toEqual(["beslutninger", "spørsmål"]);
    // The open pill jumps to the first open item.
    await row.locator(".wiki-count-pill-open").click();
    await expect(page.locator(".wiki-article li.dl-item#s1")).toHaveClass(/wiki-hash-flash/);
    expectClean(seen);

    seen = await open_(page, WIKI, REPORT_REL);
    await expect(row.locator(".wiki-count-pill-decisions")).toHaveText("2 beslutninger");
    await expect(row.locator(".wiki-count-pill-open")).toHaveCount(0);
    await expect(row.locator(".wiki-count-pill-queries")).toHaveText("3 queries");
    await expect(row.locator(".wiki-count-pill-cases")).toHaveText("3 saker");
    // The historic pill stays beside the status chip.
    expect(await row.locator(".wiki-historic-pill").evaluate((el) => el.previousElementSibling?.className)).toContain(
      "wiki-status",
    );
    expectClean(seen);
  });

  test("each fold summary shows its size and reading time", async ({ page }) => {
    await setStored(page, "all");
    const seen = await open_(page, WIKI, REPORT_REL);
    const sizes = page.locator(".wiki-article details.fold > summary .fold-size");
    expect(await sizes.count()).toBe(await page.locator(".wiki-article details.fold").count());
    for (const t of await sizes.allTextContents()) expect(t).toMatch(/^\d+(,\d)?k? tegn · (<1|\d+) min$/);
    // The ref links still read the fold's own title, not the size.
    await expect(page.locator(".wiki-article details.fold#spørringer")).toHaveCount(1);
    expectClean(seen);
  });

  test("fix round 1 D-6: in Overview a peek card shows the target whole, line refs included", async ({ page }) => {
    await setStored(page, "overview");
    const seen = await open_(page, WIKI, REPORT_REL);
    expect(await lensOf(page)).toBe("overview");
    await page.locator(".wiki-article > a.wiki-ref", { hasText: "D13" }).hover();
    const peek = page.locator(".wiki-ref-peek");
    await expect(peek).toBeVisible();
    await expect(peek.locator(".code-ref-group")).toHaveCount(1);
    await expect(peek.locator(".code-ref-group")).toBeVisible();
    // The article's own copy stays hidden.
    await expect(page.locator(".wiki-article li.dl-item#d13 .code-ref-group")).toBeHidden();
    expectClean(seen);
  });

  test("fix round 1 D-9: the line refs toggle is shown only where line refs are", async ({ page }) => {
    await setStored(page, "overview");
    const seen = await open_(page, WIKI, REPORT_REL);
    const toggle = page.locator(".wiki-article-head .wiki-lineref-toggle");
    await expect(toggle).toHaveCount(1);
    await expect(toggle).toBeHidden();
    await page.locator('.wiki-lens-switch button[data-lens="all"]').click();
    await expect(toggle).toBeVisible();
    await page.locator('.wiki-lens-switch button[data-lens="overview"]').click();
    await expect(toggle).toBeHidden();
    expectClean(seen);
  });

  test("fix round 1 D-3: Explain and fact-check send the selection without the reader's own text", async ({ page }) => {
    await setStored(page, "all");
    const sent: { path: string; sel: string | null }[] = [];
    const sse = `event: done\ndata: ${JSON.stringify({ answer: "Svar." })}\n\n`;
    for (const p of ["**/api/wiki/explain?**", "**/api/wiki/factcheck?**"]) {
      await page.route(p, (route) => {
        const u = new URL(route.request().url());
        sent.push({ path: u.pathname, sel: u.searchParams.get("sel") });
        return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse });
      });
    }
    const select = (selector: string) =>
      page.evaluate((sel) => {
        const r = document.createRange();
        r.selectNodeContents(document.querySelector(sel)!);
        const w = window.getSelection()!;
        w.removeAllRanges();
        w.addRange(r);
        document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      }, selector);

    await open_(page, WIKI, COUNTS_REL);
    // The prose after the logs, from «Se» to «S6.», with the client's two nouns in it.
    const nounsInProse = await page.evaluate(() => {
      const art = document.querySelector(".wiki-article")!;
      const first = Array.from(art.childNodes).find((n) => n.nodeType === 3 && n.textContent!.trimStart().startsWith("Se "))!;
      const s6 = art.querySelector(':scope > a.wiki-ref[data-ref="s6"]')!;
      const r = document.createRange();
      r.setStart(first, first.textContent!.indexOf("Se "));
      r.setEnd(s6.nextSibling!, 1);
      const w = window.getSelection()!;
      w.removeAllRanges();
      w.addRange(r);
      document.getElementById("articleWrap")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return r.cloneContents().querySelectorAll(".id-noun").length;
    });
    expect(nounsInProse).toBe(2);
    await expect(page.locator("#wikiExplainBtn")).toBeVisible();
    await page.locator("#wikiExplainBtn").dispatchEvent("mousedown");
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]!.sel).toBe("Se D2–D11 og S1, S2 og S6.");

    // A DecisionLog item with the server's noun, through the fact-check button.
    // (The answer replaced the article; open the page again.)
    await open_(page, WIKI, COUNTS_REL);
    await select(".wiki-article li.dl-item#s1");
    await expect(page.locator("#wikiFactcheckBtn")).toBeVisible();
    await page.locator("#wikiFactcheckBtn").dispatchEvent("mousedown");
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]!.path).toBe("/api/wiki/factcheck");
    // The chip and the item text, without «Spørsmål» before them.
    expect(sent[1]!.sel).toBe("S1Åpent.");

    // A fold summary carries its size line on screen, never in the selection.
    await open_(page, WIKI, REPORT_REL);
    await expect(page.locator(".wiki-article details.fold#spørringer > summary .fold-size")).toHaveCount(1);
    await select(".wiki-article details.fold#spørringer > summary");
    await expect(page.locator("#wikiExplainBtn")).toBeVisible();
    await page.locator("#wikiExplainBtn").dispatchEvent("mousedown");
    await expect.poll(() => sent.length).toBe(3);
    expect(sent[2]!.sel).toBe("Spørringer");
  });

  test("fix round 1 D-5: a fact-check append reloads the page in the lens the view showed", async ({ page }) => {
    await setStored(page, "overview");
    const appends: unknown[] = [];
    await page.route("**/api/wiki/factcheck?**", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: `event: done\ndata: ${JSON.stringify({ answer: "Alt stemmer.", baseHash: "h1" })}\n\n`,
      }),
    );
    await page.route("**/api/wiki/factcheck/append", (route) => {
      appends.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ written: true }) });
    });
    const seen = await open_(page, WIKI, REPORT_REL);
    expect(await lensOf(page)).toBe("overview");
    // A reveal shows All for this view only.
    await page.locator(".wiki-article a.wiki-ref", { hasText: "D12" }).first().click();
    expect(await lensOf(page)).toBe("all");
    await page.locator("#wikiFactcheckArticleBtn").dispatchEvent("mousedown");
    const add = page.locator("#wikiFactcheckAppendBtn");
    await expect(add).toBeEnabled();
    await add.click();
    await expect.poll(() => appends.length).toBe(1);
    // The page comes back in place, in All, and nothing was stored.
    await expect(page.locator(".wiki-article li.dl-item#d12")).toHaveCount(1);
    await expect.poll(() => lensOf(page)).toBe("all");
    expect(await stored(page)).toBe("overview");
    expectClean(seen);
  });
  test("fix round 2 R1: the noun reads back only to the previous block", async ({ page }) => {
    await setStored(page, "all");
    const seen = await open_(page, WIKI, NOUNS_REL);
    const before = await page
      .locator('.wiki-article a.wiki-ref[data-ref="d7"]')
      .evaluateAll((as) =>
        as.map((a) => {
          // The noun span, then one space, then the link.
          const gap = a.previousSibling;
          const prev = gap?.previousSibling as HTMLElement | null | undefined;
          return gap?.textContent === " " && prev?.classList?.contains("id-noun") ? prev.textContent : "-";
        }),
      );
    // After the heading, after the list, after the bold word; then the author's
    // own noun before a link, and before a bold id.
    expect(before).toEqual(["Beslutning", "Beslutning", "Beslutning", "-", "-"]);
    expectClean(seen);
  });

  test("fix round 2 R2: a failed in-place reload does not leave its lens for the next open", async ({ page }) => {
    await setStored(page, "overview");
    await page.route("**/api/wiki/factcheck?**", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: `event: done\ndata: ${JSON.stringify({ answer: "Alt stemmer.", baseHash: "h1" })}\n\n`,
      }),
    );
    await page.route("**/api/wiki/factcheck/append", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ written: true }) }),
    );
    await open_(page, WIKI, REPORT_REL);
    expect(await lensOf(page)).toBe("overview");
    await page.locator(".wiki-article a.wiki-ref", { hasText: "D12" }).first().click();
    expect(await lensOf(page)).toBe("all");
    // The reload after the append fails.
    let failed = 0;
    await page.route("**/api/wiki/page?**", (route) => {
      failed++;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
    });
    await page.locator("#wikiFactcheckArticleBtn").dispatchEvent("mousedown");
    await page.locator("#wikiFactcheckAppendBtn").click();
    await expect(page.locator("#articleWrap .wiki-empty-state")).toHaveText("boom");
    expect(failed).toBe(1);
    await page.unroute("**/api/wiki/page?**");
    // Opening the same page from the rail shows the stored lens.
    await page.locator(`.wiki-list-item[data-relpath="${REPORT_REL}"]`).first().click();
    await expect(page.locator(".wiki-article li.dl-item#d12")).toHaveCount(1);
    expect(await lensOf(page)).toBe("overview");
  });
});
