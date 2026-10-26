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
  "**Bold lead.** Prose with `inline code` in it.",
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

/**
 * The wikilink-in-code fixture. `[[Fence Page]]` RESOLVES in this wiki, which is
 * the half that matters: an unresolvable target only ever produced a dead span,
 * while a resolvable one became a live `<a>` inside the `<pre><code>` with the
 * brackets deleted from the fence's own text — so the reader copied source the
 * file does not contain.
 */
const LINK_FENCE_BODY = [
  "// see [[Fence Page]] for the query",
  "const pages = [[1, 2], [3, 4]];",
].join("\n");

const LINK_PAGE = [
  "---",
  "title: Link Page",
  "---",
  "",
  "# Link Page",
  "",
  "Prose linking to [[Fence Page]], which must stay a real link.",
  "",
  "Write `[[Fence Page]]` to make one.",
  "",
  "```ts",
  LINK_FENCE_BODY,
  "```",
  "",
].join("\n");

/**
 * Contexts that set their own text colour: a link, a FileRef chip, a muted
 * blockquote. Bold and inline code inside them must keep that colour; only
 * the chip's fill and edge are theirs.
 */
const MARKS_PAGE = [
  "---",
  "title: Marks Page",
  "---",
  "",
  "# Marks Page",
  "",
  "Link with [**lbold**](https://example.com/a) and [`lcode`](https://example.com/b).",
  "",
  '<FileRef path="src/a.ts">`a.ts`</FileRef>',
  "",
  "> Quote with **qbold** and `qcode` in it.",
  "",
  "See the source (`src/a.ts:12`).",
  "",
  "<FileTree>",
  "",
  "The tree under `ftsrc/`:",
  "",
  "```",
  "ftsrc/",
  "└── a.ts",
  "```",
  "",
  "</FileTree>",
  "",
  "> [!warning] A **ctbold** title",
  "> Callout body.",
  "",
  '<Historic since="muninn#1" note="old">',
  "",
  "Historic **hbold** text.",
  "",
  "</Historic>",
  "",
  "<Checklist>",
  "",
  "- [ ] **cbold** open step",
  "",
  "</Checklist>",
  "",
].join("\n");

let server: ChildProcess | undefined;
let root = "";

test.beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "muninn-e2e-code-"));
  await writeFile(path.join(root, "fence-page.md"), PAGE, "utf8");
  await writeFile(path.join(root, "link-page.md"), LINK_PAGE, "utf8");
  await writeFile(path.join(root, "marks-page.mdx"), MARKS_PAGE, "utf8");

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

test.describe("Wiki reader: code-block chrome (header bar + copy)", () => {
  test("the block reads as its own surface, not as the page behind it", async ({ page }) => {
    // The reported bug: --bg-inset (#0d0d14) sits ~2 L* from the panel (#12121a),
    // so on dark the block had no visible edge at all. Contrast RATIO is useless
    // this far down the scale — it reads 1.04 either way — so this measures the
    // perceptual lightness step, and accepts a border as the other way to have
    // an edge.
    await openPage(page);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await expect(page.locator(".fence").first()).toBeVisible();

    const gap = await page.evaluate(() => {
      const fence = document.querySelector(".wiki-article .fence") as HTMLElement | null;
      const article = document.querySelector(".wiki-article") as HTMLElement | null;
      if (!fence || !article) return null;
      const cs = getComputedStyle(fence);
      const parse = (c: string): number[] => (c.match(/-?[\d.]+/g) ?? ["0", "0", "0"]).map(Number);
      const lum = (c: number[]): number =>
        c.slice(0, 3)
          .map((v) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
          })
          .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i]!, 0);
      const lstar = (c: number[]): number => {
        const y = lum(c);
        return y <= 0.008856 ? y * 903.3 : 116 * Math.pow(y, 1 / 3) - 16;
      };
      let host: HTMLElement | null = fence.parentElement;
      let behind = "rgba(0, 0, 0, 0)";
      while (host && (behind === "rgba(0, 0, 0, 0)" || behind === "transparent")) {
        behind = getComputedStyle(host).backgroundColor;
        host = host.parentElement;
      }
      return {
        deltaL: Math.abs(lstar(parse(cs.backgroundColor)) - lstar(parse(behind))),
        borderWidth: parseFloat(cs.borderTopWidth) || 0,
        borderColor: cs.borderTopColor,
      };
    });

    expect(gap).not.toBeNull();
    // ⚠️ Asserted as two SEPARATE facts, not `deltaL >= 3 || hasBorder`. The
    // fence always carries a border, so that disjunct was unconditionally true
    // and the test passed with the fill reverted to --bg-inset — the exact
    // regression it is named after. The FILL has to separate on its own.
    expect(gap!.deltaL).toBeGreaterThanOrEqual(3);
    expect(gap!.borderWidth).toBeGreaterThan(0);
    expect(gap!.borderColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("the header bar names the language and the copy button appears on hover", async ({
    page,
  }) => {
    await openPage(page);
    const fence = page.locator(".wiki-article .fence").first();
    await expect(fence.locator(".fence-lang")).toHaveText("sql");

    const copy = fence.locator(".fence-copy");
    // At rest it is present but invisible — zero noise on a page of fences.
    await expect(copy).toHaveCSS("opacity", "0");
    await fence.hover();
    await expect(copy).toHaveCSS("opacity", "1");
  });

  test("the copy button puts the fence source on the clipboard, spans and all stripped", async ({
    page,
    context,
  }) => {
    // The whole point of highlight.ts's round-trip property, checked where it is
    // actually spent: the reader copies a query and pastes it into psql.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openPage(page);
    const fence = page.locator(".wiki-article .fence").first();
    await fence.hover();
    await fence.locator(".fence-copy").click();
    await expect(fence.locator(".fence-copy")).toHaveClass(/is-done/);

    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(SQL_BODY);
  });

  test("a mermaid fence gets no chrome", async ({ page }) => {
    await openPage(page);
    // The diagram is upgraded in place, so if the chrome had wrapped that pre
    // first, `enhanceMermaid`'s replaceWith would have left the SVG INSIDE a
    // .fence carrying a header bar reading "MERMAID".
    await expect(page.locator("[data-mermaid-src]")).toHaveCount(1);
    expect(await page.locator(".fence [data-mermaid-src]").count()).toBe(0);
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

  test("a CLONED fence is unwrapped before re-enhancing, never nested", async ({ page }) => {
    // The exact defect the first fact-check fix shipped. `buildCard` clones an
    // appendix section whose fences are ALREADY wrapped; the clone carries the
    // wrapper and a DEAD button (listeners are not cloned), so stripping the
    // idempotency marker and re-enhancing wraps it a second time inside the
    // dead one — two bars, two Copy buttons, the outer inert. Unwrap first.
    await page.goto(`${BASE}/chat`);
    await page.waitForFunction(
      () => typeof (globalThis as { unwrapCodeBlockChrome?: unknown }).unwrapCodeBlockChrome === "function",
    );

    const out = await page.evaluate((body: string) => {
      const g = globalThis as unknown as {
        formatWebHtml: (s: string) => string;
        sanitizeHtml: (h: string, isWeb: boolean) => string;
        enhanceCodeBlocks: (root: ParentNode) => void;
        unwrapCodeBlockChrome: (root: ParentNode) => void;
      };
      const host = document.createElement("div");
      host.innerHTML = g.sanitizeHtml(g.formatWebHtml("```sql\n" + body + "\n```"), true);
      document.body.appendChild(host);
      g.enhanceCodeBlocks(host);

      // …the clone a card build makes.
      const clone = host.cloneNode(true) as HTMLElement;
      document.body.appendChild(clone);

      // Enumerate the unwrap helper's DOM cases in one place, since each of
      // them was a live trap: an ALREADY-NESTED pair (what a marker-strip
      // re-enhance produces), a wrapper whose `pre` sits deeper than a direct
      // child, and a wrapper with no `pre` at all (dead chrome).
      const nestedCase = document.createElement("div");
      nestedCase.innerHTML =
        '<div class="fence"><div class="fence-bar"></div>' +
        '<div class="fence"><div class="fence-bar"></div>' +
        '<pre data-fence-enhanced="1"><code>x</code></pre></div></div>' +
        '<div class="fence"><div class="fence-bar"></div><section><pre><code>y</code></pre></section></div>' +
        '<div class="fence"><div class="fence-bar"></div></div>';
      document.body.appendChild(nestedCase);
      g.unwrapCodeBlockChrome(nestedCase);
      const edge = {
        fences: nestedCase.querySelectorAll(".fence").length,
        pres: nestedCase.querySelectorAll("pre").length,
        bars: nestedCase.querySelectorAll(".fence-bar").length,
        marked: nestedCase.querySelectorAll("[data-fence-enhanced]").length,
      };
      nestedCase.remove();

      g.unwrapCodeBlockChrome(clone);
      const afterUnwrap = {
        fences: clone.querySelectorAll(".fence").length,
        pres: clone.querySelectorAll("pre").length,
        marked: clone.querySelectorAll("[data-fence-enhanced]").length,
      };
      g.enhanceCodeBlocks(clone);
      const res = {
        edge,
        afterUnwrap,
        fences: clone.querySelectorAll(".fence").length,
        nested: clone.querySelectorAll(".fence .fence").length,
        buttons: clone.querySelectorAll(".fence-copy").length,
        text: clone.querySelector("pre > code")?.textContent ?? null,
      };
      host.remove();
      clone.remove();
      return res;
    }, SQL_BODY);

    // A nested pair collapses FULLY (both wrappers), a deeper `pre` is still
    // rescued, and a wrapper with no code is dropped rather than left as a bar
    // with a button that can never copy anything.
    expect(out.edge.fences).toBe(0);
    expect(out.edge.pres).toBe(2);
    expect(out.edge.bars).toBe(0);
    expect(out.edge.marked).toBe(0);

    // Unwrap really restored a bare pre and cleared the marker…
    expect(out.afterUnwrap.fences).toBe(0);
    expect(out.afterUnwrap.pres).toBe(1);
    expect(out.afterUnwrap.marked).toBe(0);
    // …and re-enhancing produced exactly ONE wrapper with ONE (live) button.
    expect(out.fences).toBe(1);
    expect(out.nested).toBe(0);
    expect(out.buttons).toBe(1);
    expect(out.text).toBe(SQL_BODY);
  });

  test("re-enhancing the same nodes never double-wraps", async ({ page }) => {
    // Asserted HERE and not on /wiki deliberately: `enhanceCodeBlocks` is a real
    // global only in the chat bundle, so the same evaluate() on the reader would
    // find `undefined`, do nothing, and pass whatever the enhancer did — the
    // "skips itself green" shape, which is how this test read on its first cut.
    //
    // NB the re-enhance paths are article swaps and history repaints, NOT the
    // streaming delta loop: `streaming-ui.ts` sets innerHTML per delta and calls
    // no enhancer, enhancing once in promoteStreamingBubble.
    await page.goto(`${BASE}/chat`);
    await page.waitForFunction(
      () =>
        typeof (globalThis as { formatWebHtml?: unknown }).formatWebHtml === "function" &&
        typeof (globalThis as { enhanceCodeBlocks?: unknown }).enhanceCodeBlocks === "function",
    );

    const counts = await page.evaluate((body: string) => {
      const g = globalThis as unknown as {
        formatWebHtml: (s: string) => string;
        sanitizeHtml: (h: string, isWeb: boolean) => string;
        enhanceCodeBlocks: (root: ParentNode) => void;
      };
      const host = document.createElement("div");
      host.innerHTML = g.sanitizeHtml(g.formatWebHtml("```sql\n" + body + "\n```"), true);
      document.body.appendChild(host);
      g.enhanceCodeBlocks(host);
      const afterFirst = host.querySelectorAll(".fence").length;
      g.enhanceCodeBlocks(host);
      g.enhanceCodeBlocks(host);
      const afterThird = host.querySelectorAll(".fence").length;
      const nested = host.querySelectorAll(".fence .fence").length;
      const text = host.querySelector("pre > code")?.textContent ?? null;
      host.remove();
      return { afterFirst, afterThird, nested, text };
    }, SQL_BODY);

    expect(counts.afterFirst).toBe(1);
    expect(counts.afterThird).toBe(1);
    expect(counts.nested).toBe(0);
    // …and the wrapping did not disturb the source.
    expect(counts.text).toBe(SQL_BODY);
  });
});

/**
 * A `[[wikilink]]` inside code renders as the bytes on disk.
 *
 * `renderWikiHtml` parks every wikilink as a `\x00`-sentinel BEFORE
 * `formatWebHtml` and restores it over the RENDERED HTML, and that pass used not
 * to be scoped to prose — so a link written inside a fence or inside backticks
 * was substituted like any other and the restore landed inside the `<code>`.
 *
 * Asserted HERE, in a browser, rather than only on the HTML string, because the
 * consequence is a DOM one: `code.textContent` is what the Copy button hands the
 * reader, and the clipboard read below is the only assertion that actually proves
 * what leaves the page.
 */
test.describe("Wiki reader: a wikilink inside code is code", () => {
  test("the fence's text is the file's, and Copy hands over exactly that", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&page=link-page`);
    const fence = page.locator("code.language-ts");
    await expect(fence).toBeVisible();

    // Byte-identical, brackets included…
    expect(await fence.textContent()).toBe(LINK_FENCE_BODY);
    // …and nothing in the fence became a link, resolvable target or not.
    expect(await fence.locator("a.wiki-link, span.wiki-link-missing").count()).toBe(0);

    // The clipboard is the acceptance: this is the string that reaches an editor.
    await fence.hover();
    await page.locator(".fence .fence-copy").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(LINK_FENCE_BODY);
  });

  test("an INLINE code span is protected, and prose on the same page still links", async ({
    page,
  }) => {
    // The guard is not a kill switch — measured on the real corpus, inline spans
    // are the majority of the affected cases, and the prose link beside them is
    // exactly what must not be lost to fixing them.
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&page=link-page`);
    const article = page.locator("#articleWrap");
    await expect(article.locator("a.wiki-link").first()).toBeVisible();

    // The prose link resolved…
    expect(await article.locator("a.wiki-link").count()).toBe(1);
    // …while the backticked one is literal code. `:not(pre > code)` is the INLINE
    // half: the fence's own <code> carries the same text, and `formatWebHtml`
    // does not wrap a plain text block in a <p>, so neither a bare `code` nor a
    // `p code` selector can tell the two apart.
    const inlineCode = article.locator("code:not(pre > code)");
    await expect(inlineCode.filter({ hasText: "[[Fence Page]]" })).toHaveCount(1);
    // …and it is text, not markup: no anchor was substituted into it.
    expect(await inlineCode.locator("a, span.wiki-link-missing").count()).toBe(0);
  });
});

/**
 * What bold and an inline-code chip measure against the body text and the
 * surface behind them, in the page's current theme. Bold is compared as a
 * contrast RATIO against the body's; the chip as an L* step, because a ratio
 * reads ~1.04 for any two near-blacks (see the fence test above). The chip's
 * edge is its inset box-shadow composited over its own fill: an edge or a
 * fill step both make a chip visible.
 */
async function proseMarks(page: import("@playwright/test").Page, scope: string) {
  return page.evaluate((sel: string) => {
    const root = document.querySelector(sel) as HTMLElement | null;
    const strong = root?.querySelector("strong") as HTMLElement | null;
    const code = root?.querySelector("code:not(pre > code)") as HTMLElement | null;
    const body = strong?.parentElement ?? null;
    if (!root || !strong || !code || !body) return null;
    const parse = (c: string): number[] => (c.match(/-?[\d.]+/g) ?? ["0", "0", "0"]).map(Number);
    const lum = (c: number[]): number =>
      c.slice(0, 3)
        .map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        })
        .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    const lstar = (c: number[]): number => {
      const y = lum(c);
      return y <= 0.008856 ? y * 903.3 : 116 * Math.pow(y, 1 / 3) - 16;
    };
    const ratio = (a: number[], b: number[]): number => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x! + 0.05) / (y! + 0.05);
    };
    const behindOf = (el: HTMLElement): number[] => {
      for (let n: HTMLElement | null = el.parentElement; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if ((c[3] ?? 1) > 0) return c;
      }
      return [255, 255, 255];
    };
    const page = behindOf(body);
    const chip = parse(getComputedStyle(code).backgroundColor);
    // `rgba(r, g, b, a) 0px 0px 0px 1px inset` → the edge colour over the fill.
    const shadow = getComputedStyle(code).boxShadow;
    const sc = shadow === "none" ? null : parse(shadow.slice(0, shadow.indexOf(")") + 1));
    const a = sc ? (sc[3] ?? 1) : 0;
    const edge = sc ? chip.map((v, i) => (i < 3 ? sc[i]! * a + v * (1 - a) : v)) : chip;
    return {
      boldLead:
        ratio(parse(getComputedStyle(strong).color), page) / ratio(parse(getComputedStyle(body).color), page),
      boldWeight: Number(getComputedStyle(strong).fontWeight),
      chipStep: Math.max(Math.abs(lstar(chip) - lstar(page)), Math.abs(lstar(edge) - lstar(page))),
      codeOnChip: ratio(parse(getComputedStyle(code).color), chip),
    };
  }, scope);
}

test.describe("Bold and inline code stand apart from the body", () => {
  // The reported bug (2026-10-26): in dark, `strong` shared the body's #e0e0e0
  // (lead 1.00) and the inline chip sat on --bg-inset, ~2 L* from the page.
  // Light already showed both; its thresholds pin that it stays so.
  for (const [theme, minStep] of [["dark", 6], ["light", 4]] as const) {
    test(`in the wiki article, ${theme}`, async ({ page }) => {
      await openPage(page);
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      const m = await proseMarks(page, ".wiki-article");
      expect(m).not.toBeNull();
      expect(m!.boldLead).toBeGreaterThanOrEqual(1.15);
      // 700 in both themes: the browser's own bold, which the summary export
      // (body text already --text-primary) relies on for its whole lead.
      expect(m!.boldWeight).toBe(700);
      expect(m!.chipStep).toBeGreaterThanOrEqual(minStep);
      expect(m!.codeOnChip).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("in a chat research card, dark", async ({ page }) => {
    // The card body sits on --bg-card (#1a1a2e), the same colour chat's old
    // inline-code fill (--bg-surface) had, so there the old chip stepped 0 L*.
    // A probe on the bare page could not see that: --bg-surface steps ~7 L*
    // from --bg-page.
    await page.goto(`${BASE}/chat`);
    await page.waitForFunction(
      () => typeof (globalThis as { formatWebHtml?: unknown }).formatWebHtml === "function",
    );
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "dark");
      const g = globalThis as unknown as { formatWebHtml: (s: string) => string };
      const card = document.createElement("div");
      card.className = "msg msg-research-card";
      const probe = document.createElement("div");
      probe.className = "research-card-body web-content";
      probe.id = "prose-probe";
      probe.innerHTML = g.formatWebHtml("**Bold lead.** Prose with `inline code` in it.");
      card.appendChild(probe);
      document.body.appendChild(card);
    });
    const m = await proseMarks(page, "#prose-probe");
    expect(m).not.toBeNull();
    expect(m!.boldLead).toBeGreaterThanOrEqual(1.15);
    expect(m!.boldWeight).toBe(700);
    expect(m!.chipStep).toBeGreaterThanOrEqual(6);
    expect(m!.codeOnChip).toBeGreaterThanOrEqual(4.5);
  });
});

test.describe("Bold and inline code keep the colour of the context they sit in", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`links, FileRef and blockquotes, ${theme}`, async ({ page }) => {
      await page.goto(`${BASE}/wiki?wiki=${WIKI}&page=marks-page`);
      await expect(page.locator(".wiki-article .fileref")).toBeVisible();
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      const got = await page.evaluate(() => {
        const q = (s: string) => document.querySelector(".wiki-article " + s) as HTMLElement;
        const cs = (s: string) => getComputedStyle(q(s));
        return {
          link: cs("a[href$='/a']").color,
          linkBold: cs("a[href$='/a'] strong").color,
          linkCode: cs("a[href$='/b'] code").color,
          linkOfCode: cs("a[href$='/b']").color,
          fileref: cs(".fileref").color,
          frefInner: cs(".fileref code").color,
          frefInnerShadow: cs(".fileref code").boxShadow,
          frefInnerPadLeft: cs(".fileref code").paddingLeft,
          quote: cs("blockquote").color,
          quoteCode: cs("blockquote code").color,
          quoteBold: cs("blockquote strong").color,
          // Every context the 2026-10-26 enumeration found that sets its own
          // text colour and holds bold: an Obsidian callout title, a Historic
          // body, an open Checklist step. Bold there keeps that colour.
          ctitle: cs(".callout-title").color,
          ctitleBold: cs(".callout-title strong").color,
          historic: cs(".historic-body").color,
          historicBold: cs(".historic-body strong").color,
          todo: cs(".check-item.check-todo .check-text").color,
          todoBold: cs(".check-item.check-todo strong").color,
          treeProseShadow: cs(".filetree code:not(pre > code)").boxShadow,
        };
      });
      expect(got.linkBold).toBe(got.link);
      expect(got.linkCode).toBe(got.linkOfCode);
      expect(got.frefInner).toBe(got.fileref);
      expect(got.frefInnerShadow).toBe("none");
      // …and no second padding inside the FileRef chip's own.
      expect(got.frefInnerPadLeft).toBe("0px");
      expect(got.quoteCode).toBe(got.quote);
      expect(got.quoteBold).toBe(got.quote);
      expect(got.ctitleBold).toBe(got.ctitle);
      expect(got.historicBold).toBe(got.historic);
      expect(got.todoBold).toBe(got.todo);
      // A FileTree body can hold prose beside its fence; inline code there
      // gets FileTree's flat look, never the chip's edge.
      expect(got.treeProseShadow).toBe("none");
    });
  }
});

test.describe("The other prose surfaces", () => {
  test("a line-ref chip keeps its own look, not the inline-code chip", async ({ page }) => {
    await page.goto(`${BASE}/wiki?wiki=${WIKI}&page=marks-page`);
    await expect(page.locator(".wiki-article code.code-ref")).toBeVisible();
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    const got = await page.evaluate(() => {
      const chip = document.querySelector(".wiki-article code.code-ref") as HTMLElement;
      const probe = document.createElement("div");
      probe.style.background = "var(--bg-inset)";
      document.body.appendChild(probe);
      return {
        shadow: getComputedStyle(chip).boxShadow,
        bg: getComputedStyle(chip).backgroundColor,
        inset: getComputedStyle(probe).backgroundColor,
      };
    });
    expect(got.shadow).toBe("none");
    expect(got.bg).toBe(got.inset);
  });

  test("markdownContentStyles (summary job card): the chip shows on --bg-panel, dark", async ({ page }) => {
    // The job card is --bg-panel (#12121a); the old fill (--bg-surface,
    // #1a1a2e) stepped ~4.5 L* from it. The research answer below sits on the
    // bare page, where that old fill already stepped ~7, so it cannot pin this.
    await page.goto(`${BASE}/summaries`);
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "dark");
      const card = document.createElement("div");
      card.className = "job-card";
      const probe = document.createElement("div");
      probe.className = "summary-area";
      probe.id = "prose-probe";
      probe.innerHTML = "<p><strong>Bold lead.</strong> Prose with <code>inline code</code> in it.</p>";
      card.appendChild(probe);
      document.body.appendChild(card);
    });
    const m = await proseMarks(page, "#prose-probe");
    expect(m).not.toBeNull();
    expect(m!.chipStep).toBeGreaterThanOrEqual(6);
    expect(m!.codeOnChip).toBeGreaterThanOrEqual(4.5);
  });

  test("markdownContentStyles (research answer): bold weight and links, dark", async ({ page }) => {
    // One of the six pages that share markdownContentStyles (doc panel,
    // summaries, search document, Jira preview, export); /research serves it
    // as `.answer-body`.
    await page.goto(`${BASE}/research`);
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "dark");
      // Inside the page's own #turnsWrap, as a real turn card.
      const card = document.createElement("div");
      card.className = "turn-card";
      const probe = document.createElement("div");
      probe.className = "answer-body";
      probe.id = "prose-probe";
      card.appendChild(probe);
      probe.innerHTML =
        "<p><strong>Bold lead.</strong> Prose with <code>inline code</code> in it.</p>" +
        '<p><a href="https://example.com/a"><strong>lbold</strong></a> and <a href="https://example.com/b"><code>lcode</code></a></p>' +
        "<blockquote><p>Quote with <strong>qbold</strong>.</p></blockquote>" +
        "<h3>Heading with <strong>hbold</strong></h3>";
      document.getElementById("turnsWrap")!.appendChild(card);
    });
    const m = await proseMarks(page, "#prose-probe");
    expect(m).not.toBeNull();
    expect(m!.boldWeight).toBe(700);
    // The token, not the browser's `bolder`: under a 600 heading `bolder`
    // computes to 900, and the paragraph probe above cannot tell the two apart.
    const headingBold = await page.evaluate(
      () => getComputedStyle(document.querySelector("#prose-probe h3 strong") as HTMLElement).fontWeight,
    );
    expect(headingBold).toBe("700");
    const links = await page.evaluate(() => {
      const c = (s: string) => getComputedStyle(document.querySelector("#prose-probe " + s) as HTMLElement).color;
      return {
        a: c("a[href$='/a']"), bold: c("a[href$='/a'] strong"), b: c("a[href$='/b']"), code: c("a[href$='/b'] code"),
        quote: c("blockquote"), quoteBold: c("blockquote strong"),
        strongInk: (() => {
          const p = document.createElement("span");
          p.style.color = "var(--text-strong)";
          document.body.appendChild(p);
          return getComputedStyle(p).color;
        })(),
      };
    });
    expect(links.bold).toBe(links.a);
    expect(links.code).toBe(links.b);
    // Unlike the wiki article, these surfaces always set bold in a quote to
    // the strong ink (as on main): the summary fact-check callout is a
    // blockquote whose bold runs ARE its claim headings.
    expect(links.quoteBold).toBe(links.strongInk);
    expect(links.quoteBold).not.toBe(links.quote);
  });

  test("chat answer: bold and code inside a link keep the link colour, dark", async ({ page }) => {
    await page.goto(`${BASE}/chat`);
    await page.waitForFunction(
      () => typeof (globalThis as { formatWebHtml?: unknown }).formatWebHtml === "function",
    );
    const links = await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "dark");
      const g = globalThis as unknown as { formatWebHtml: (s: string) => string };
      const probe = document.createElement("div");
      probe.className = "web-content";
      probe.id = "link-probe";
      probe.innerHTML = g.formatWebHtml(
        "[**lbold**](https://example.com/a) and [`lcode`](https://example.com/b)\n\n> Quote with **qbold**.",
      );
      document.body.appendChild(probe);
      const c = (s: string) => getComputedStyle(probe.querySelector(s) as HTMLElement).color;
      return {
        a: c("a[href$='/a']"), bold: c("a[href$='/a'] strong"), b: c("a[href$='/b']"), code: c("a[href$='/b'] code"),
        quote: c("blockquote"), quoteBold: c("blockquote strong"),
        strongInk: (() => {
          const p = document.createElement("span");
          p.style.color = "var(--text-strong)";
          document.body.appendChild(p);
          return getComputedStyle(p).color;
        })(),
      };
    });
    expect(links.bold).toBe(links.a);
    expect(links.code).toBe(links.b);
    // Unlike the wiki article, these surfaces always set bold in a quote to
    // the strong ink (as on main): the summary fact-check callout is a
    // blockquote whose bold runs ARE its claim headings.
    expect(links.quoteBold).toBe(links.strongInk);
    expect(links.quoteBold).not.toBe(links.quote);
  });
});
