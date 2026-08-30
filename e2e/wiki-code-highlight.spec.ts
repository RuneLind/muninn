/**
 * Syntax highlighting in a fenced code block, end-to-end, on both surfaces that
 * render one.
 *
 * Three things no unit test can reach, and the reason this file exists:
 *
 *  1. **The colors actually resolve.** `highlightCode` emits `class="tok-kw"`;
 *     whether that turns purple depends on a `--tok-kw` in `shared-styles.ts`
 *     and on the rule not being scoped to some other selector. A test that
 *     asserts on the HTML string is green either way.
 *  2. **Both themes.** The two palettes are separate token blocks, and the
 *     light one is the half nobody looks at while working in dark.
 *  3. ⚠️ **The chat sanitizer.** `/wiki` injects this HTML unsanitized (trusted
 *     disk content), but the chat re-renders every bubble through
 *     `sanitizeHtml`, which STRIPS `class` off a `<span>` unless the value is
 *     allowlisted. So highlighting can be perfect in the reader and colorless
 *     in chat, with every unit test passing — the failure this whole spec is
 *     pointed at. The last case drives the real bundled `sanitizeHtml` on the
 *     real chat page, rather than a copy of the allowlist.
 *
 * Plus the property the unit tests pin on strings, re-checked in the DOM: the
 * fence's `textContent` is byte-identical to the source. That is what a copy
 * button hands over and what the mermaid enhancer reads, so a tokenizer that
 * drops a character is a data bug, not a styling one.
 *
 * No model calls: everything here is markdown → HTML → CSS.
 *
 * ENV PREREQUISITE / SPAWN ENV: as every other spec in this directory — a
 * working `.env` at the repo root, and `e2eEnv()` to keep this muninn off
 * Telegram/Slack and off the host's instance-profile flags.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";

const PORT = e2ePort("wiki-code-highlight");
const BASE = `http://127.0.0.1:${PORT}`;
const WIKI = "e2e-code";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");

/** The expected token colors, as the browser reports them. */
const DARK_KW = "rgb(192, 132, 252)"; // --tok-kw #c084fc
const LIGHT_KW = "rgb(139, 47, 208)"; // --tok-kw #8b2fd0
const DARK_COM = "rgb(125, 135, 152)"; // --tok-com #7d8798

/**
 * The fence body. Deliberately the query from the report that started this —
 * Norwegian comments, doubled-quote escape, a `>=` that must survive escaping,
 * and enough comment lines that a wrong comment color is the thing you see.
 */
const SQL_BODY = [
  "-- Én diagnostisk spørring. Klassifiseringen gjøres på resultatet.",
  "SELECT b.saksnummer, ap.fom_dato",
  "FROM anmodningsperiode ap",
  "WHERE ap.medlperiode_id IS NULL",
  "  AND (ap.tom_dato IS NULL OR ap.tom_dato >= ap.fom_dato)",
  "  AND p.navn IN ('O''BRIEN', 'ANMODNING_OM_UNNTAK')",
  "ORDER BY ap.beh_resultat_id;",
].join("\n");

const PAGE = [
  "---",
  "title: Fence Page",
  "---",
  "",
  "# Fence Page",
  "",
  "Prose with `inline code` in it.",
  "",
  "```sql",
  SQL_BODY,
  "```",
  "",
  "```mermaid",
  "graph TD",
  "  A[select] --> B",
  "```",
  "",
  "```html",
  "<b>not highlighted</b>",
  "```",
  "",
].join("\n");

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-code-"));
  await writeFile(path.join(root, "fence-page.md"), PAGE, "utf8");

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
  if (root) await rm(root, { recursive: true, force: true });
});

/** Open the seeded page and wait for the article to render. */
async function openPage(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(`${BASE}/wiki?wiki=${WIKI}&page=fence-page`);
  await expect(page.locator("code.language-sql")).toBeVisible();
}

test.describe("Wiki reader: fenced code highlighting", () => {
  test("the SQL fence is tokenized and its text is byte-identical to the source", async ({
    page,
  }) => {
    await openPage(page);
    const fence = page.locator("code.language-sql");

    // Tokenized at all…
    await expect(fence.locator(".tok-kw").first()).toHaveText("SELECT");
    await expect(fence.locator(".tok-com").first()).toContainText("Én diagnostisk");
    expect(await fence.locator("[class^='tok-']").count()).toBeGreaterThan(10);

    // …and the reader's text is still exactly the file's. This is what a copy
    // button hands over; a dropped or duplicated character here is silent.
    expect(await fence.textContent()).toBe(SQL_BODY);
  });

  test("token colors resolve in dark AND light, from the shared tokens", async ({ page }) => {
    await openPage(page);
    const kw = page.locator("code.language-sql .tok-kw").first();
    const com = page.locator("code.language-sql .tok-com").first();

    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await expect(kw).toHaveCSS("color", DARK_KW);
    await expect(com).toHaveCSS("color", DARK_COM);
    // Comments are italic — the one non-color signal, and the cheapest way to
    // tell "the rule applied" from "the color happened to match".
    await expect(com).toHaveCSS("font-style", "italic");

    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await expect(kw).toHaveCSS("color", LIGHT_KW);
  });

  test("mermaid and unsupported languages are left plain", async ({ page }) => {
    // ⚠️ The mermaid half is asserted on the SERVED payload, not on the DOM.
    // `wiki-mermaid.ts` does `pre.replaceWith(wrap)` on success, so
    // `code.language-mermaid` is GONE from a healthy page — a DOM assertion here
    // counts zero, passes, and runs only in the failure mode where mermaid never
    // loaded. That is the "skips itself green" shape this repo has been bitten by.
    const res = await fetch(`${BASE}/api/wiki/page?wiki=${WIKI}&name=fence-page`);
    expect(res.ok).toBe(true);
    const payload = (await res.json()) as { html?: string };
    const served = payload.html ?? "";
    const fenceOf = (lang: string): string => {
      const m = served.match(new RegExp(`<code class="language-${lang}">([\\s\\S]*?)</code>`));
      return m?.[1] ?? "";
    };
    // The fence is in the payload at all…
    expect(fenceOf("mermaid")).toContain("graph TD");
    // …and the tokenizer never touched it. The enhancer reads `textContent` to
    // build the diagram, so a span in there would be wrong, and a span that
    // changed the text would be load-bearing-wrong.
    expect(fenceOf("mermaid")).not.toContain("tok-");
    expect(fenceOf("html")).not.toContain("tok-");

    // The unsupported-language case survives enhancement, so it can be asserted
    // in the DOM as well — and the round-trip is what matters there.
    await openPage(page);
    const html = page.locator("code.language-html");
    await expect(html).toHaveText("<b>not highlighted</b>");
    expect(await html.locator("[class^='tok-']").count()).toBe(0);

    // Proof the diagram really was upgraded — i.e. that the DOM-based assertion
    // this replaced was indeed vacuous rather than merely redundant.
    await expect(page.locator("[data-mermaid-src]")).toHaveCount(1);
    expect(await page.locator("code.language-mermaid").count()).toBe(0);
  });
});

test.describe("Chat bubbles: the sanitizer keeps the token classes", () => {
  test("sanitizeHtml(formatWebHtml(fence)) preserves tok-* classes", async ({ page }) => {
    // Drives the REAL bundled functions on the REAL chat page. The chat renders
    // history and streaming deltas through exactly this pair, and the sanitizer's
    // default is to strip `class` — so this is the assertion that fails if the
    // allowlist and the emitter ever drift apart.
    await page.goto(`${BASE}/chat`);
    await page.waitForFunction(
      () =>
        typeof (globalThis as { formatWebHtml?: unknown }).formatWebHtml === "function" &&
        typeof (globalThis as { sanitizeHtml?: unknown }).sanitizeHtml === "function",
    );

    const result = await page.evaluate((body: string) => {
      const g = globalThis as unknown as {
        formatWebHtml: (s: string) => string;
        sanitizeHtml: (h: string, isWeb: boolean) => string;
      };
      const raw = g.formatWebHtml("```sql\n" + body + "\n```");
      const clean = g.sanitizeHtml(raw, true);
      const probe = document.createElement("div");
      probe.innerHTML = clean;
      const code = probe.querySelector("code");
      return {
        rawHasClasses: /class="tok-kw"/.test(raw),
        cleanHasClasses: /class="tok-kw"/.test(clean),
        text: code ? code.textContent : null,
        stillAPre: !!probe.querySelector("pre > code"),
      };
    }, SQL_BODY);

    expect(result.rawHasClasses).toBe(true);
    // The one that matters: survived the allowlist.
    expect(result.cleanHasClasses).toBe(true);
    // …and the sanitizer did not flatten the block or eat a character.
    expect(result.stillAPre).toBe(true);
    expect(result.text).toBe(SQL_BODY);
  });
});
