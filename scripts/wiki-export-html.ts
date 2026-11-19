#!/usr/bin/env bun
/**
 * Export one /wiki page as a single standalone HTML file that renders with no
 * muninn: the reader's own rendering of every component (Tldr, status rows,
 * charts, folds, decision log, glossary, mermaid in both themes), its CSS pruned
 * to what the page uses, light/dark that follows the OS with a toggle, and the
 * lens, chart-mode, decision-expand and diagram-expand controls wired up.
 *
 *   bun scripts/wiki-export-html.ts <wiki> <relPath> <out.html> [--base http://localhost:3010]
 *
 * Needs the dashboard running: it drives the real reader in headless Chromium
 * (Playwright's bundled build, else installed Chrome). The cleanup, CSS pruning
 * and document assembly live in `wiki-export-html-lib.ts`.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import {
  assembleCss,
  buildStandaloneHtml,
  cleanExport,
  parseCliArgs,
  selectorCandidates,
  selfCheck,
  parseCss,
  sheetSources,
  stateVariants,
} from "./wiki-export-html-lib.ts";

function usage(): never {
  console.error("usage: bun scripts/wiki-export-html.ts <wiki> <relPath> <out.html> [--base http://localhost:3010]");
  process.exit(2);
}

const parsed = parseCliArgs(process.argv.slice(2));
if (!parsed) usage();
const { wiki, relPath, out, base } = parsed;
const apiUrl = `${base}/api/wiki/page?wiki=${encodeURIComponent(wiki)}&relPath=${encodeURIComponent(relPath)}`;

// The page's metadata, fetched first: a wrong wiki or relPath stops here with a
// plain message instead of a browser timeout.
type PageJson = { meta?: { title?: string; description?: string; desc?: string }; reader?: { language?: string }; error?: string };
const pageRes = await fetch(apiUrl).catch((e: unknown) => {
  console.error(`cannot reach the dashboard at ${base}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
const pageJson = (await pageRes.json().catch(() => null)) as PageJson | null;
if (!pageRes.ok || !pageJson || pageJson.error) {
  console.error(`page not found: ${wiki}/${relPath} (${pageRes.status}${pageJson?.error ? `: ${pageJson.error}` : ""})`);
  process.exit(1);
}
const url = `${base}/wiki?wiki=${encodeURIComponent(wiki)}&relPath=${encodeURIComponent(relPath)}`;

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch {
    return await chromium.launch({ channel: "chrome" });
  }
}

/** Load the page in one colour scheme with every fold open, so lazily rendered mermaid is drawn. */
async function openPage(browser: Browser, scheme: "light" | "dark"): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector(".wiki-article-head", { timeout: 20000 });
  const mermaidBlocks = await page.evaluate(() => {
    document.querySelectorAll<HTMLDetailsElement>("#articleWrap details").forEach((d) => {
      d.setAttribute("data-export-was-open", d.open ? "1" : "0");
      d.open = true;
    });
    return document.querySelectorAll("#articleWrap code.language-mermaid, #articleWrap .diagram").length;
  });
  if (mermaidBlocks) {
    await page
      .waitForFunction((n) => document.querySelectorAll('#articleWrap svg[id^="wm-"]').length >= n, mermaidBlocks, { timeout: 15000 })
      .catch(() => console.error(`warning: not every mermaid diagram rendered within 15 s`));
  }
  await page.waitForTimeout(500);
  return page;
}

const browser = await launch();
try {
  const dark = await openPage(browser, "dark");
  const darkSvgs = await dark.evaluate(() => Array.from(document.querySelectorAll('#articleWrap svg[id^="wm-"]'), (s) => s.outerHTML));
  await dark.context().close();

  const light = await openPage(browser, "light");
  const captured = await light.evaluate(async () => {
    const wrap = document.querySelector("#articleWrap");
    const head = wrap?.querySelector(".wiki-article-head");
    const article = wrap?.querySelector(".wiki-article");
    if (!head || !article) throw new Error("reader rendered no article");
    return {
      headHtml: head.outerHTML,
      articleHtml: article.outerHTML,
      title: head.querySelector("h1")?.textContent?.trim() ?? document.title,
    };
  });
  // Each stylesheet's source text, read in the page (linked sheets fetched).
  const sources: string[] = await light.evaluate(
    `(${sheetSources.toString()})(document.styleSheets, (href) => fetch(href).then((r) => (r.ok ? r.text() : "")))`,
  );

  const cleaned = cleanExport({ headHtml: captured.headHtml, articleHtml: captured.articleHtml, darkSvgs });
  const tree = sources.flatMap(parseCss);
  const candidates = selectorCandidates(tree);
  // Test each selector against the cleaned article and its state copies, placed
  // inside #articleWrap so ancestor selectors (.wiki-article-wrap …) still match.
  const matched = await light.evaluate(
    ({ probeHtml, candidates }) => {
      const wrap = document.querySelector("#articleWrap");
      const probe = document.createElement("div");
      probe.style.display = "none";
      probe.innerHTML = probeHtml;
      wrap?.append(probe);
      const inProbe = (el: Element) => probe.contains(el) || el === document.documentElement || el === document.body;
      const hits = candidates.filter((s) => {
        try {
          return Array.from(document.querySelectorAll(s)).some(inProbe);
        } catch {
          return false;
        }
      });
      probe.remove();
      return hits;
    },
    { probeHtml: [cleaned.headHtml, cleaned.articleHtml, ...stateVariants(cleaned.articleHtml)].join("\n"), candidates },
  );
  const css = assembleCss(tree, new Set(matched));
  // Title and description from the page's frontmatter, as the reader's API reports them.
  const meta = pageJson.meta ?? {};
  const lang = pageJson.reader?.language === "no" ? "no" : "en";
  const description = meta.description ?? meta.desc ?? "";

  const html = buildStandaloneHtml({
    title: meta.title ?? captured.title,
    description,
    css,
    headHtml: cleaned.headHtml,
    articleHtml: cleaned.articleHtml,
    source: `${wiki}/${relPath}`,
    date: new Date().toISOString().slice(0, 10),
    lang,
  });
  await Bun.write(out, html);
  const total = sources.reduce((n, t) => n + t.length, 0);
  console.log(`wrote ${out}: ${html.length} bytes, css ${css.length} chars kept of about ${total}`);

  // The written file, opened from disk: what in it would not work without muninn.
  const check = await browser.newPage();
  await check.goto(pathToFileURL(resolve(out)).href);
  const problems: string[] = await check.evaluate(`(${selfCheck.toString()})(document)`);
  if (problems.length === 0) console.log("self-check: ok — no stylesheet link, no external script, no reference into the reader");
  else {
    console.log(`self-check: ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
    process.exitCode = 3;
  }
} finally {
  await browser.close();
}
