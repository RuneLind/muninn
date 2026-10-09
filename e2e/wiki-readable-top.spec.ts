/**
 * The top of a report page (reader lenses PR 2): `<More>` under Kort fortalt,
 * `<StatusRows>` and a `<DecisionLog>` item's first sentence in Overview.
 *
 * What only a real page can answer: that the «Mer om saken» part is closed
 * and opens on a click, that the three state phrases are painted in three
 * different colours, that Overview takes an item's rest and nested lines off
 * the screen and «mer» brings them back, that a `#d2` load into a collapsed
 * item shows the whole item and keeps Overview (D3), and that the peek card
 * copies the whole decision without the toggle.
 *
 * Two wikis in one process: `e2e-top` (Norwegian, instance default Overview)
 * and `e2e-top-en` (no reader config, so English labels). Synthetic fixtures.
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

const PORT = e2ePort("wiki-readable-top");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI = "e2e-top";
const WIKI_EN = "e2e-top-en";
const REL = "plans/top.mdx";

const PAGE = [
  "---",
  "title: Top page",
  "type: plan",
  "plan_status: in-flight",
  "---",
  "",
  "# Top page",
  "",
  '<Tldr label="Kort fortalt">',
  "",
  "Fag avklarte saken.",
  "",
  "<More>",
  "",
  "**Bakgrunnen.** Når et vedtak fattes i vedtaksflyten.",
  "",
  "</More>",
  "",
  "</Tldr>",
  "",
  "## Oppsummering",
  "",
  "<StatusRows>",
  "",
  "- **Status:** Pågår · fag svarte sist 07.10 (runde 6)",
  "- **Avklart:** 3 beslutninger · 1 åpent",
  "- **Jira:** oppgave 1 i prod · oppgave 3 merget, ikke i prod · oppgave 4 ikke i prod",
  "",
  "</StatusRows>",
  "",
  "Se D2 for regelen, og [listen](#beslutningsliste).",
  "",
  '<Fold title="Beslutninger">',
  "",
  "## Beslutningsliste",
  "",
  "<DecisionLog>",
  "",
  "- **D1** — Vi bruker f.eks. regel A. Begrunnelsen står i runde 6.",
  "- **D2** — Regelen gjelder alle saker. Unntaket er sokkel.",
  "  - Detalj under punktet.",
  "- **D3** — Bare én setning.",
  "- **D4** — Regelen gjelder fra januar i år. Tallet er <Fact n=\"1\" v=\"bad\">41 saker</Fact> totalt.",
  "- **S1** — Skal vi bytte kø for alle saker? Lukket 07.10 (D1).",
  "- ~~**D5**~~ — Den gamle regelen for alle saker. Erstattet av D2.",
  "",
  "</DecisionLog>",
  "",
  "</Fold>",
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

const open_ = async (page: Page, wiki: string, hash = "") => {
  const seen = watch(page);
  await page.goto(`${BASE}/wiki?wiki=${wiki}&relPath=${encodeURIComponent(REL)}${hash}`);
  await expect(page.locator(".wiki-article")).toBeVisible();
  return seen;
};

const lensOf = (page: Page) =>
  page.locator(".wiki-article").evaluate((el) => (el.classList.contains("lens-overview") ? "overview" : "all"));

const expectClean = (seen: { failed: string[]; errors: string[] }) => {
  expect(seen.failed).toEqual([]);
  expect(seen.errors).toEqual([]);
};

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-top-"));
  const no = path.join(root, "no");
  const en = path.join(root, "en");
  for (const d of [path.join(no, "plans"), path.join(en, "plans")]) await mkdir(d, { recursive: true });
  await writeFile(path.join(no, REL), PAGE, "utf8");
  await writeFile(path.join(no, ".wiki-reader.json"), JSON.stringify({ language: "no" }), "utf8");
  await writeFile(path.join(en, REL), PAGE, "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI}=${no},${WIKI_EN}=${en}`,
      WIKI_DEFAULT_LENS: `${WIKI}=overview,${WIKI_EN}=overview`,
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

test.describe("Wiki reader: the top of a report page", () => {
  test("<More> renders closed under Kort fortalt with the wiki's label, and opens", async ({ page }) => {
    const seen = await open_(page, WIKI);
    const more = page.locator("section.tldr details.tldr-more");
    await expect(more).toHaveCount(1);
    await expect(more).not.toHaveAttribute("open", /.*/);
    await expect(more.locator("summary")).toHaveText("Mer om saken");
    await expect(more.locator(".tldr-more-body")).toBeHidden();
    await more.locator("summary").click();
    await expect(more.locator(".tldr-more-body")).toContainText("Når et vedtak fattes");
    expectClean(seen);

    await open_(page, WIKI_EN);
    await expect(page.locator("details.tldr-more > summary")).toHaveText("More about this");
  });

  test("<StatusRows> renders one row per item and paints «i prod», «merget, ikke i prod» and «ikke i prod» apart", async ({ page }) => {
    const seen = await open_(page, WIKI);
    const rows = page.locator("section.status-rows .sr-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.locator(".sr-label")).toHaveText(["Status", "Avklart", "Jira"]);
    const jira = rows.nth(2);
    const states = jira.locator(".sr-state");
    await expect(states).toHaveText(["i prod", "merget, ikke i prod", "ikke i prod"]);
    const bg = await states.evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
    expect(new Set(bg).size).toBe(3);
    // A label column and a value column: the labels share one left edge, left of the values.
    const boxes = await rows.evaluateAll((els) =>
      els.map((r) => {
        const l = r.querySelector(".sr-label")!.getBoundingClientRect();
        const v = r.querySelector(".sr-value")!.getBoundingClientRect();
        return { lx: Math.round(l.left), vx: Math.round(v.left), lr: l.right };
      }),
    );
    expect(new Set(boxes.map((b) => b.lx)).size).toBe(1);
    expect(new Set(boxes.map((b) => b.vx)).size).toBe(1);
    for (const b of boxes) expect(b.vx).toBeGreaterThan(b.lr);
    expectClean(seen);
  });

  test("Overview shows a decision's first sentence with «mer»; All shows it whole", async ({ page }) => {
    const seen = await open_(page, WIKI);
    expect(await lensOf(page)).toBe("overview");
    await page.locator("details.fold > summary", { hasText: "Beslutninger" }).click();
    const d2 = page.locator("li.dl-item#d2");
    await expect(d2.locator(".dl-first")).toHaveText("Regelen gjelder alle saker.");
    await expect(d2.locator(".dl-rest")).toBeHidden();
    await expect(d2.getByText("Detalj under punktet.")).toBeHidden();
    const more = d2.locator("button.dl-more");
    await expect(more).toBeVisible();
    await expect(more).toHaveText("mer");
    await more.click();
    await expect(d2.locator(".dl-rest")).toBeVisible();
    await expect(d2.getByText("Detalj under punktet.")).toBeVisible();
    await expect(more).toHaveText("mindre");
    await expect(more).toHaveAttribute("aria-expanded", "true");
    // A one-sentence item has nothing to open; `f.eks.` does not end the sentence.
    await expect(page.locator("li.dl-item#d3 button.dl-more")).toHaveCount(0);
    await expect(page.locator("li.dl-item#d1 .dl-first")).toHaveText("Vi bruker f.eks. regel A.");

    await page.locator(".wiki-lens-switch button[data-lens='all']").click();
    await expect(page.locator("li.dl-item#d1 .dl-rest")).toBeVisible();
    await expect(page.locator("button.dl-more").first()).toBeHidden();
    expectClean(seen);
  });

  test("a #d2 load into a collapsed item shows the whole item and stays in Overview (D3)", async ({ page }) => {
    const seen = await open_(page, WIKI, "#d2");
    const d2 = page.locator("li.dl-item#d2");
    await expect(d2).toBeInViewport();
    await expect(d2.locator(".dl-rest")).toBeVisible();
    await expect(d2.getByText("Detalj under punktet.")).toBeVisible();
    expect(await lensOf(page)).toBe("overview");
    // Its neighbour stays collapsed.
    await expect(page.locator("li.dl-item#d1 .dl-rest")).toBeHidden();
    expectClean(seen);
  });

  test("the peek card copies the whole decision, without the «mer» toggle", async ({ page }) => {
    const seen = await open_(page, WIKI);
    const link = page.locator(".wiki-article a.wiki-ref", { hasText: "D2" }).first();
    await link.hover();
    const peek = page.locator(".wiki-ref-peek");
    await expect(peek).toBeVisible();
    await expect(peek).toContainText("Regelen gjelder alle saker. Unntaket er sokkel.");
    await expect(peek.locator("button.dl-more")).toHaveCount(0);
    expectClean(seen);
  });

  test("a heading peek in Overview shows the decisions whole, with no «mer» toggle (E)", async ({ page }) => {
    const seen = await open_(page, WIKI);
    expect(await lensOf(page)).toBe("overview");
    await page.locator(".wiki-article a.wiki-ref", { hasText: "listen" }).first().hover();
    const peek = page.locator(".wiki-ref-peek");
    await expect(peek).toBeVisible();
    await expect(peek.getByText("Unntaket er sokkel.")).toBeVisible();
    await expect(peek.getByText("Detalj under punktet.")).toBeVisible();
    await expect(peek.locator("button.dl-more")).toHaveCount(0);
    expectClean(seen);
  });

  test("Overview badges a closed question «lukket» after its first sentence; All does not (J)", async ({ page }) => {
    const seen = await open_(page, WIKI);
    await page.locator("details.fold > summary", { hasText: "Beslutninger" }).click();
    const s1 = page.locator("li.dl-item#s1");
    await expect(s1.locator(".dl-first")).toHaveText("Skal vi bytte kø for alle saker?");
    await expect(s1.locator(".dl-rest")).toBeHidden();
    const badge = s1.locator(".dl-qstate");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("lukket");
    await expect(badge).toHaveAttribute("data-reader-only", "");
    // Right after the first sentence, and «mer» right after the badge.
    await expect(s1.locator(":scope > .dl-text > .dl-first + .dl-qstate")).toHaveCount(1);
    await expect(s1.locator(":scope > .dl-text > .dl-qstate + button.dl-more")).toHaveCount(1);
    // A decision is no question: no badge, not even a struck (closed) one.
    await expect(page.locator("li.dl-item#d5")).toHaveAttribute("data-q-state", "closed");
    await expect(page.locator("li.dl-item .dl-qstate")).toHaveCount(1);
    await page.locator(".wiki-lens-switch button[data-lens='all']").click();
    await expect(badge).toBeHidden();
    expectClean(seen);

    await open_(page, WIKI_EN);
    await page.locator("details.fold > summary", { hasText: "Beslutninger" }).click();
    await expect(page.locator("li.dl-item#s1 .dl-qstate")).toHaveText("closed");
  });

  test("an item whose rest holds a fact-check mark opens by default in Overview (K)", async ({ page }) => {
    const seen = await open_(page, WIKI);
    await page.locator("details.fold > summary", { hasText: "Beslutninger" }).click();
    const d4 = page.locator("li.dl-item#d4");
    await expect(d4.locator(".dl-rest")).toBeVisible();
    await expect(d4.locator(".fc-chip")).toBeVisible();
    await expect(d4.locator("button.dl-more")).toHaveText("mindre");
    // Its neighbours stay collapsed.
    await expect(page.locator("li.dl-item#d2 .dl-rest")).toBeHidden();
    expectClean(seen);
  });

  test("«mer» names its item, points at its rest and stays out of a copy", async ({ page }) => {
    const seen = await open_(page, WIKI);
    await page.locator("details.fold > summary", { hasText: "Beslutninger" }).click();
    const more = page.locator("li.dl-item#d2 button.dl-more");
    await expect(more).toHaveAttribute("aria-label", "mer om D2");
    // It names the rest of the text and the nested list, and nothing else.
    await expect(more).toHaveAttribute("aria-controls", "d2-rest d2-rest-2");
    await expect(page.locator("li.dl-item#d2 > .dl-text > .dl-rest#d2-rest")).toHaveText(" Unntaket er sokkel.");
    await expect(page.locator("li.dl-item#d2 > #d2-rest-2")).toContainText("Detalj under punktet.");
    expect(await more.evaluate((b) => getComputedStyle(b).userSelect)).toBe("none");
    expectClean(seen);
  });

  test("at 390 px the rows stack and nothing passes the article's right edge", async ({ page }) => {
    const seen = await open_(page, WIKI);
    // The narrow reader shows the article in focus mode, as wiki-genre-blocks does.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("f");
    await expect.poll(async () => (await page.locator(".wiki-article").boundingBox())!.width).toBeGreaterThan(250);
    // One column: each label sits above its value.
    const r = await page.locator("section.status-rows .sr-row").first().evaluate((row) => ({
      l: row.querySelector(".sr-label")!.getBoundingClientRect().bottom,
      v: row.querySelector(".sr-value")!.getBoundingClientRect().top,
    }));
    expect(r.v).toBeGreaterThanOrEqual(r.l - 1);
    const over = await page.locator(".wiki-article").evaluate((art) => {
      const right = art.getBoundingClientRect().right + 0.5;
      return Array.from(art.querySelectorAll("section.status-rows *, section.tldr *")).filter((e) => e.getBoundingClientRect().right > right).length;
    });
    expect(over).toBe(0);
    expectClean(seen);
  });
});
