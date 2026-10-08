/**
 * The `<Question>` block in the /wiki reader (answer cards PR 1): a read-only
 * card whose state follows the page's `<DecisionLog>` — Open, Decided → D99,
 * Closed and a reopened item — with the DecisionLog below the questions inside
 * a closed fold, so the state can only come from the renderer's pre-pass. A
 * second wiki whose `.wiki-reader.json` says `language: "no"` gets the
 * Norwegian labels. The cards carry no `id`, so the log item keeps its `o3`
 * anchor rather than becoming `o3-2`.
 *
 * What a unit test cannot show: the route reads the wiki's reader config and
 * the page's `questions_to:` and threads both through `renderWikiHtml` into
 * the HTML the reader injects; the client's enhancers leave the card alone.
 *
 * No model calls, no DB rows. ENV / SPAWN ENV: no `.env` is required — the
 * spawn inherits `DATABASE_URL` and `e2eEnv()` blanks the platform tokens and
 * the host's instance-profile flags. One muninn over two temp wikis.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { paintedContrast } from "./contrast.ts";

const PORT = e2ePort("wiki-question-card");
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const WIKI_EN = "e2e-question-en";
const WIKI_NO = "e2e-question-no";
const PAGE_REL = "plans/questions.mdx";
const DUP_REL = "plans/duplicate.mdx";

// Synthetic throughout: invented ids, names and wording.
const question = (id: string, text: string) => [`<Question id="${id}" choices="A|B">`, "", `**${text}**`, "", "</Question>", ""];

const PAGE_EN = [
  "---",
  "title: Question page",
  "type: plan",
  'questions_to: ["Synne Testdal (X111111)"]',
  "---",
  "",
  "# Question page",
  "",
  ...question("O1", "Is the first one still open?"),
  ...question("O2", "Which export language?"),
  ...question("O3", "Keep the old flag?"),
  ...question("O4", "Was the reopened one settled?"),
  '<Fold title="Decision log">',
  "",
  "<DecisionLog>",
  "",
  "- **D99** — The page's language.",
  "- **O1** — Spurt 30.09, aldri besvart direkte.",
  "- **O2** — Which export language? Closed 2026-10-08 (D99).",
  "- ~~**O3**~~ — Keep the old flag?",
  "- **O4** — Settled? Lukket 08.10 (D99). Gjenåpnet 09.10.",
  "",
  "</DecisionLog>",
  "",
  "</Fold>",
  "",
].join("\n");

const PAGE_NO = [
  "---",
  "title: Spørsmålsside",
  "type: plan",
  'questions_to: ["Ola Nordmann (Y222222)"]',
  "---",
  "",
  "# Spørsmålsside",
  "",
  ...question("O3", "Skal eksportblokken være på norsk?"),
  "<DecisionLog>",
  "",
  "- **D99** — Sidens språk.",
  "- **O3** — Eksportblokken? Lukket 08.10 (D99).",
  "",
  "</DecisionLog>",
  "",
].join("\n");

// Two cards on one id, so the duplicate note renders (its contrast is measured),
// and one id with no DecisionLog item, whose chip is a plain span.q-id.
const PAGE_DUP = [
  "---",
  "title: Duplicate page",
  "type: plan",
  "---",
  "",
  ...question("O5", "Asked twice?"),
  ...question("O5", "Asked twice, again?"),
  ...question("O9", "Never logged?"),
  "<DecisionLog>",
  "",
  "- **O5** — Asked twice?",
  "",
  "</DecisionLog>",
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

const openPage = async (page: Page, wiki: string, relPath = PAGE_REL) => {
  const seen = watch(page);
  await page.goto(`${BASE}/wiki?wiki=${wiki}&relPath=${encodeURIComponent(relPath)}`);
  await expect(page.locator(".wiki-article section.question").first()).toBeVisible();
  return seen;
};

const expectClean = (seen: { failed: string[]; errors: string[] }) => {
  expect(seen.failed).toEqual([]);
  expect(seen.errors).toEqual([]);
};

test.beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "muninn-e2e-question-"));
  const en = path.join(base, "en");
  const no = path.join(base, "no");
  await mkdir(path.join(en, "plans"), { recursive: true });
  await mkdir(path.join(no, "plans"), { recursive: true });
  await writeFile(path.join(en, PAGE_REL), PAGE_EN, "utf8");
  await writeFile(path.join(en, DUP_REL), PAGE_DUP, "utf8");
  await writeFile(path.join(no, PAGE_REL), PAGE_NO, "utf8");
  await writeFile(path.join(no, ".wiki-reader.json"), JSON.stringify({ language: "no" }), "utf8");

  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      WIKI_EXTRA: `${WIKI_EN}=${en},${WIKI_NO}=${no}`,
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/wiki/pages?wiki=${WIKI_EN}`);
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

test.describe("Wiki reader: <Question> answer card", () => {
  test("each card's state follows the DecisionLog below it, inside a closed fold", async ({ page }) => {
    const seen = await openPage(page, WIKI_EN);
    const cards = page.locator(".wiki-article section.question");
    await expect(cards).toHaveCount(4);
    await expect(cards.locator(".q-id")).toHaveText(["O1", "O2", "O3", "O4"]);
    await expect(cards.locator(".q-state")).toHaveText(["Open", "Decided → D99", "Closed", "Open"]);
    expect(await cards.evaluateAll((els) => els.map((el) => el.getAttribute("data-question-state")))).toEqual([
      "open",
      "decided",
      "closed",
      "open",
    ]);
    // The decision chip links the D99 item, the id chip its own log item.
    await expect(cards.nth(1).locator("a.q-decision")).toHaveAttribute("href", "#d99");
    await expect(cards.nth(1).locator("a.q-id")).toHaveAttribute("href", "#o2");
    // Who it is for, from questions_to:; read-only, since this wiki is not in WIKI_ANSWER_WIKIS.
    await expect(cards.first().locator(".q-for")).toHaveText("For Synne Testdal");
    await expect(cards.first()).toHaveAttribute("data-wiki-answerable", "false");
    await expect(cards.first()).toHaveAttribute("data-question-choices", "A|B");
    await expect(cards.first().locator(".q-body strong")).toHaveText("Is the first one still open?");
    expectClean(seen);
  });

  test("the cards carry no id, so the DecisionLog item keeps its o3 anchor", async ({ page }) => {
    const seen = await openPage(page, WIKI_EN);
    const cardIds = await page.locator(".wiki-article section.question").evaluateAll((els) => els.map((el) => el.id));
    expect(cardIds).toEqual(["", "", "", ""]);
    const logIds = await page.locator("section.decision-log .dl-item[id]").evaluateAll((lis) => lis.map((li) => li.id));
    expect(logIds).toEqual(["d99", "o1", "o2", "o3", "o4"]);
    expect(await page.locator("#o3-2").count()).toBe(0);
    expectClean(seen);
  });

  test('language "no" in .wiki-reader.json gives the Norwegian labels', async ({ page }) => {
    const seen = await openPage(page, WIKI_NO);
    const card = page.locator(".wiki-article section.question");
    await expect(card.locator(".q-label")).toHaveText("Spørsmål");
    await expect(card.locator(".q-state")).toHaveText("Avgjort → D99");
    await expect(card.locator(".q-for")).toHaveText("Stilt til Ola Nordmann");
    await expect(card).toHaveAttribute("data-question-lang", "no");
    expectClean(seen);
  });

  // Token + 4.5:1 in both themes, the genre-blocks pattern: the muted lines
  // on --text-soft, the labels on --accent-light, and the state pill's text
  // over each of its three tints.
  for (const scheme of ["light", "dark"] as const) {
    test(`card text reads at 4.5:1 on its tokens, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const seen = await openPage(page, WIKI_EN);
      await page.mouse.move(0, 0);
      const token = (name: string) =>
        page.evaluate((v) => {
          const p = document.createElement("span");
          p.style.color = `var(${v})`;
          document.body.appendChild(p);
          const c = getComputedStyle(p).color;
          p.remove();
          return c;
        }, name);
      const soft = await token("--text-soft");
      const accentLight = await token("--accent-light");
      const cards = page.locator(".wiki-article section.question");
      const pinned: [string, ReturnType<Page["locator"]>, string][] = [
        ["for line", cards.first().locator(".q-for"), soft],
        ["label", cards.first().locator(".q-label"), accentLight],
        ["id chip", cards.first().locator(".q-id"), accentLight],
      ];
      for (const [name, loc, color] of pinned) {
        expect(await loc.evaluate((el) => getComputedStyle(el).color), `${name} token`).toBe(color);
        expect(await paintedContrast(loc), `${name} contrast`).toBeGreaterThanOrEqual(4.5);
      }
      const pills = {
        open: cards.nth(0).locator(".q-state"),
        decided: cards.nth(1).locator(".q-state"),
        closed: cards.nth(2).locator(".q-state"),
        decision: cards.nth(1).locator(".q-decision"),
        body: cards.first().locator(".q-body strong"),
      };
      for (const [name, loc] of Object.entries(pills)) {
        expect(await paintedContrast(loc), `${name} contrast`).toBeGreaterThanOrEqual(4.5);
      }
      expectClean(seen);

      const dupSeen = await openPage(page, WIKI_EN, DUP_REL);
      const note = page.locator(".wiki-article .q-note").first();
      await expect(note).toBeVisible();
      expect(await note.evaluate((el) => getComputedStyle(el).color), "note token").toBe(soft);
      expect(await paintedContrast(note), "note contrast").toBeGreaterThanOrEqual(4.5);
      // The ref-link enhancer adopts a.q-id, so the chip above measures
      // a.wiki-ref's colour; the no-item span.q-id is the card's own rule.
      const plainId = page.locator(".wiki-article section.question span.q-id");
      await expect(plainId).toHaveText("O9");
      expect(await plainId.evaluate((el) => getComputedStyle(el).color), "plain id token").toBe(accentLight);
      expect(await paintedContrast(plainId), "plain id contrast").toBeGreaterThanOrEqual(4.5);
      expectClean(dupSeen);
    });
  }
});
