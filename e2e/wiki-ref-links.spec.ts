/**
 * In-page references in the /wiki reader, over a temp wiki: bare ids the page
 * defines (DecisionLog items, Query cards) and quoted section titles become
 * links, as do server-rendered `](#slug)` links to a heading; hovering or
 * focusing one shows a peek card with the target; clicking jumps there with
 * the fold opened and the target flashed, and Back returns to the scroll
 * position the jump left. Also a fresh load on `#q2-oppskrift`, and 4.5:1 on
 * the link and the peek in both colour schemes.
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

const PORT = e2ePort("wiki-ref-links");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-ref-links";
const PAGE_REL = "plans/refs.mdx";

const filler = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} avsnitt ${i + 1} med fylltekst.\n`);

const PAGE = [
  "---",
  "title: Ref page",
  "type: plan",
  "---",
  "",
  "# Ref page",
  "",
  "<NextMoves>",
  "",
  '<Lane kind="you" who="Du">',
  "",
  "1. **Test fiksen i q2** med oppskriften i «Q2-oppskrift».",
  "",
  "</Lane>",
  "",
  "</NextMoves>",
  "",
  "Fag sa nei (D4), se Q-2. Ikke en lenke: `D4`, «vedtak fattet i Melosys», og D9.",
  "",
  "Se også [Runde 3](#runde-3--2026-08-18-kveld). Tvetydig: «Om spørringen» og D1. Ikke i artikkelen: [lista](#wikiList). Se «Med fold».",
  "",
  "| Spørsmål | Beslutning |",
  "|---|---|",
  "| Faktureres de? | D4, S1 |",
  "",
  ...filler(40, "Første"),
  '<Fold title="Beslutninger" summary="D1–D4 · S1 åpent">',
  "",
  "## Beslutninger",
  "",
  "<DecisionLog>",
  "",
  "- **D1** — Ikke-yrkesaktive betaler ikke trygdeavgift.",
  "- **D4** — Behandlingene uten vedtak skal verken faktureres eller årsavregnes (Q-2).",
  "- **S1** — Skal årsavregningene henlegges? D4 sier nei.",
  "",
  "</DecisionLog>",
  "",
  "</Fold>",
  "",
  '<Query id="Q-2" question="Hvilke saker har trygdeavgift uten vedtak?" answer="46 saker, 45 FTRL og 1 EØS." csv="refs-sql/Q-2.csv" run="29.09.2026" uses="behandling">',
  "",
  "Lesning av svaret.",
  "",
  '<Fold title="Om spørringen">',
  "",
  "Første forklaring.",
  "",
  "</Fold>",
  "",
  "</Query>",
  "",
  '<Fold title="Om spørringen">',
  "",
  "Andre forklaring.",
  "",
  "</Fold>",
  "",
  ...filler(40, "Andre"),
  '<Fold title="Q2-oppskrift" summary="fire steg for hånd">',
  "",
  "## Q2-oppskrift",
  "",
  "Gjør dette når PR-en er deployet til q2.",
  "",
  "</Fold>",
  "",
  "<DecisionLog>",
  "",
  "- **D1** — En annen logg med samme id.",
  "",
  "</DecisionLog>",
  "",
  "### Om spørringen",
  "",
  "Overskriften tar ikke tittelen to folds deler.",
  "",
  "## Med fold",
  "",
  '<Fold title="Innfelt">',
  "",
  "Skjult fold-innhold.",
  "",
  "</Fold>",
  "",
  "Prosa etter folden.",
  "",
  "## Notater",
  "",
  "Første.",
  "",
  "## Notater",
  "",
  "Andre.",
  "",
  "## Runde 3 — 2026-08-18 kveld",
  "",
  "Fag svarte på runde 3.",
  "",
  ...filler(40, "Tredje"),
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
  await expect(page.locator(".wiki-article a.wiki-ref").first()).toBeAttached();
  return seen;
};

const expectClean = (seen: { failed: string[]; errors: string[] }) => {
  expect(seen.failed).toEqual([]);
  expect(seen.errors).toEqual([]);
};

const scrollTop = (page: Page) => page.locator("#articleWrap").evaluate((el) => el.scrollTop);

test.beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "muninn-e2e-refs-"));
  const root = path.join(base, "wiki");
  await mkdir(path.join(root, "plans", "refs-sql"), { recursive: true });
  await writeFile(path.join(root, PAGE_REL), PAGE, "utf8");
  await writeFile(path.join(root, "plans", "refs-sql", "Q-2.csv"), "sak,beslutning\nMEL-1,D4\n", "utf8");

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

test.describe("Wiki reader: in-page references", () => {
  test("ids and quoted titles the page defines become links; nothing else does", async ({ page }) => {
    const seen = await openPage(page);
    const refs = await page
      .locator(".wiki-article a.wiki-ref")
      .evaluateAll((as) => as.map((a) => `${a.textContent}→${(a as HTMLElement).dataset.ref}`));
    expect(refs).toEqual([
      "«Q2-oppskrift»→q2-oppskrift",
      "D4→d4",
      "Q-2→q-2",
      "Runde 3→runde-3--2026-08-18-kveld",
      "«Med fold»→med-fold",
      "D4→d4",
      "S1→s1",
      "Q-2→q-2",
      "D4→d4",
    ]);
    // Code, a quote naming no section, an undefined id, the fold's summary and
    // the DecisionLog's own chips stay as they were.
    await expect(page.locator(".wiki-article code", { hasText: "D4" }).locator("a")).toHaveCount(0);
    await expect(page.locator(".wiki-article summary a")).toHaveCount(0);
    await expect(page.locator(".dl-item#d4 > a.dl-id")).not.toHaveClass(/wiki-ref/);
    // A title two folds share links nowhere; a Query's CSV result is data.
    await expect(page.locator(".query-result td", { hasText: "D4" })).toHaveCount(1);
    await expect(page.locator(".query-result a")).toHaveCount(0);
    // A fragment link to page chrome stays a plain link.
    await expect(page.locator('.wiki-article a[href="#wikiList"]')).not.toHaveClass(/wiki-ref/);
    // Repeated heading slugs are numbered as GitHub does.
    await expect(page.locator(".wiki-article :is(h2,h3)#notater")).toHaveText("Notater");
    await expect(page.locator(".wiki-article :is(h2,h3)#notater-1")).toHaveText("Notater");
    // Folds and headings got ids; the heading inside its fold did not take the fold's.
    await expect(page.locator("details.fold#q2-oppskrift")).toHaveCount(1);
    await expect(page.locator("h2#runde-3--2026-08-18-kveld, h3#runde-3--2026-08-18-kveld")).toHaveCount(1);
    expectClean(seen);
  });

  test("hover shows the target in a peek card; Go to jumps; Back restores the scroll", async ({ page }) => {
    const seen = await openPage(page);
    const ref = page.locator(".wiki-article a.wiki-ref", { hasText: "D4" }).first();
    await ref.hover();
    const peek = page.locator(".wiki-ref-peek");
    await expect(peek).toBeVisible();
    await expect(peek.locator(".wiki-ref-peek-label")).toHaveText("D4");
    await expect(peek.locator(".wiki-ref-peek-where")).toHaveText("Beslutninger");
    await expect(peek.locator(".wiki-ref-peek-body")).toContainText("verken faktureres eller årsavregnes");
    // The copy carries no duplicate ids.
    expect(await peek.locator("[id]").count()).toBe(0);
    const before = await scrollTop(page);

    await peek.locator(".wiki-ref-peek-go").click();
    await expect(peek).toHaveCount(0);
    await expect(page.locator("details.fold", { hasText: "Beslutninger" }).first()).toHaveAttribute("open", "");
    await expect(page.locator(".dl-item#d4")).toBeInViewport();
    await expect(page.locator(".dl-item#d4")).toHaveClass(/wiki-hash-flash/);
    expect(new URL(page.url()).hash).toBe("#d4");
    const back = page.locator(".wiki-ref-back");
    await expect(back).toBeVisible();
    expect(await scrollTop(page)).toBeGreaterThan(before + 200);

    await back.click();
    await expect(back).toBeHidden();
    await expect.poll(() => scrollTop(page)).toBe(before);
    expect(new URL(page.url()).hash).toBe("");
    expectClean(seen);
  });

  test("clicking a quoted title opens its fold; the browser's Back also returns", async ({ page }) => {
    const seen = await openPage(page);
    await page.locator("#articleWrap").evaluate((el) => (el.scrollTop = 0));
    const title = page.locator(".wiki-article a.wiki-ref", { hasText: "«Q2-oppskrift»" });
    await title.hover();
    // A fold's peek: its summary, then its opening prose (a bare text run).
    const peek = page.locator(".wiki-ref-peek .wiki-ref-peek-body");
    await expect(peek).toContainText("fire steg for hånd");
    await expect(peek).toContainText("deployet til q2");
    await title.click();
    const fold = page.locator("details.fold#q2-oppskrift");
    await expect(fold).toHaveAttribute("open", "");
    await expect(fold.locator(".fold-body")).toContainText("deployet til q2");
    await expect(fold).toBeInViewport();
    await page.goBack();
    await expect.poll(() => scrollTop(page)).toBe(0);
    await expect(page.locator(".wiki-ref-back")).toBeHidden();
    expectClean(seen);
  });

  test("a server-rendered fragment link jumps to its heading", async ({ page }) => {
    const seen = await openPage(page);
    const link = page.locator('.wiki-article a.wiki-ref[href="#runde-3--2026-08-18-kveld"]');
    await expect(link).toHaveText("Runde 3");
    await link.click();
    await expect(page.locator("#runde-3--2026-08-18-kveld")).toBeInViewport();
    expectClean(seen);
  });

  test("a fresh load on a fold's hash opens it and flashes it", async ({ page }) => {
    const seen = await openPage(page, "#q2-oppskrift");
    const fold = page.locator("details.fold#q2-oppskrift");
    await expect(fold).toHaveAttribute("open", "");
    await expect(fold).toBeInViewport();
    await expect(fold).toHaveClass(/wiki-hash-flash/);
    // A descendant's animationend bubbles up; only the fold's own ends the flash.
    await fold.locator(".fold-body").evaluate((el) =>
      el.dispatchEvent(new AnimationEvent("animationend", { bubbles: true, animationName: "x" })),
    );
    await expect(fold).toHaveClass(/wiki-hash-flash/);
    expectClean(seen);
  });

  test("keyboard: focus shows the peek, Escape hides it, Enter jumps", async ({ page }) => {
    const seen = await openPage(page);
    const ref = page.locator(".wiki-article a.wiki-ref", { hasText: "Q-2" }).first();
    await ref.focus();
    // .focus() does not set :focus-visible; a Tab into the link does.
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const peek = page.locator(".wiki-ref-peek");
    await expect(peek).toBeVisible();
    await expect(peek.locator(".wiki-ref-peek-body")).toContainText("Hvilke saker har trygdeavgift uten vedtak?");
    await expect(peek.locator(".wiki-ref-peek-body")).toContainText("46 saker");
    await page.keyboard.press("Escape");
    await expect(peek).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(page.locator("section.query#q-2")).toBeInViewport();
    expectClean(seen);
  });

  test("Back from a jump on a legacy ?page= URL restores the scroll without a refetch", async ({ page }) => {
    const seen = watch(page);
    let pageFetches = 0;
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/wiki/page") pageFetches++;
    });
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&page=refs`);
    await expect(page.locator(".wiki-article a.wiki-ref").first()).toBeAttached();
    await page.locator("#articleWrap").evaluate((el) => (el.scrollTop = 150));
    const fetchesBefore = pageFetches;
    await page.locator(".wiki-article a.wiki-ref", { hasText: "«Q2-oppskrift»" }).click();
    await expect(page.locator("details.fold#q2-oppskrift")).toBeInViewport();
    await page.goBack();
    await expect.poll(() => scrollTop(page)).toBe(150);
    expect(pageFetches).toBe(fetchesBefore);
    expectClean(seen);
  });

  test("the peek is a tooltip the link points at, not a dialog", async ({ page }) => {
    const seen = await openPage(page);
    const ref = page.locator(".wiki-article a.wiki-ref", { hasText: "D4" }).first();
    await ref.hover();
    const peek = page.locator(".wiki-ref-peek");
    await expect(peek).toHaveAttribute("role", "tooltip");
    await expect(ref).toHaveAttribute("aria-describedby", (await peek.getAttribute("id"))!);
    await page.mouse.move(0, 0);
    await expect(peek).toHaveCount(0);
    await expect(ref).not.toHaveAttribute("aria-describedby", /.+/);
    expectClean(seen);
  });

  test("Escape on a peek closes it and leaves focus mode alone", async ({ page }) => {
    const seen = await openPage(page);
    await page.locator(".wiki-article").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("f");
    await expect(page.locator(".wiki-layout")).toHaveClass(/\bfocus-mode\b/);
    const ref = page.locator(".wiki-article a.wiki-ref", { hasText: "Q-2" }).first();
    await ref.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(page.locator(".wiki-ref-peek")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".wiki-ref-peek")).toHaveCount(0);
    await expect(page.locator(".wiki-layout")).toHaveClass(/\bfocus-mode\b/);
    expectClean(seen);
  });

  test("Escape from inside the peek returns focus to the link without reopening it", async ({ page }) => {
    const seen = await openPage(page);
    // Tab from the article's last link enters the card; focus it directly here.
    const last = page.locator(".wiki-article a.wiki-ref", { hasText: "Q-2" }).first();
    await last.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(page.locator(".wiki-ref-peek")).toBeVisible();
    await page.locator(".wiki-ref-peek-go").focus();
    await expect(page.locator(".wiki-ref-peek-go")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".wiki-ref-peek")).toHaveCount(0);
    await expect(last).toBeFocused();
    // The suppression covers that one focus return only: tabbing back peeks again.
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(last).toBeFocused();
    await expect(page.locator(".wiki-ref-peek")).toBeVisible();
    expectClean(seen);
  });

  test("a heading's peek shows its prose, not a fold that opens its section", async ({ page }) => {
    const seen = await openPage(page);
    await page.locator(".wiki-article a.wiki-ref", { hasText: "«Med fold»" }).hover();
    const body = page.locator(".wiki-ref-peek .wiki-ref-peek-body");
    await expect(body).toContainText("Prosa etter folden.");
    await expect(body).not.toContainText("Skjult fold-innhold.");
    await expect(body.locator("details")).toHaveCount(0);
    expectClean(seen);
  });

  test("chat keeps a DecisionLog chip as a span with its pill", async ({ page }) => {
    await page.goto(`${BASE}/chat`);
    await page.waitForFunction(() => typeof (globalThis as any).sanitizeHtml === "function");
    const html = await page.evaluate(() => {
      const g = globalThis as any;
      return g.sanitizeHtml(g.formatWebHtml("<DecisionLog>\n\n- **D4** — Ingen fakturering.\n\n</DecisionLog>"), true);
    });
    expect(html).toContain('<span class="dl-id">D4</span>');
    expect(html).not.toContain("<a");
  });

  test("chat renders an in-page link as plain text, not a dead anchor", async ({ page }) => {
    await page.goto(`${BASE}/chat`);
    await page.waitForFunction(() => typeof (globalThis as any).sanitizeHtml === "function");
    const html = await page.evaluate(() => {
      const g = globalThis as any;
      return g.sanitizeHtml(g.formatWebHtml("se [D4](#d4) og [nav](https://nav.no)"), true);
    });
    expect(html).toBe('se D4 og <a href="https://nav.no" target="_blank" rel="noopener">nav</a>');
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`link, peek text and Back read at 4.5:1, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const seen = await openPage(page);
      const ref = page.locator(".wiki-article a.wiki-ref", { hasText: "D4" }).first();
      expect(await paintedContrast(ref), "link contrast").toBeGreaterThanOrEqual(4.5);
      await ref.hover();
      const peek = page.locator(".wiki-ref-peek");
      await expect(peek).toBeVisible();
      for (const [name, loc] of Object.entries({
        label: peek.locator(".wiki-ref-peek-label"),
        where: peek.locator(".wiki-ref-peek-where"),
        body: peek.locator(".wiki-ref-peek-body"),
        go: peek.locator(".wiki-ref-peek-go"),
      })) {
        expect(await paintedContrast(loc), `${name} contrast`).toBeGreaterThanOrEqual(4.5);
      }
      await peek.locator(".wiki-ref-peek-go").click();
      const back = page.locator(".wiki-ref-back");
      await expect(back).toBeVisible();
      expect(await paintedContrast(back), "back contrast").toBeGreaterThanOrEqual(4.5);
      expectClean(seen);
    });
  }
});
