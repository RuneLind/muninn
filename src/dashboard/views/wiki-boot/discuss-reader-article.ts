/**
 * The article a Discuss selection is made on, built for the happy-dom tests
 * (`wiki-discuss-parity.test.ts`, `wiki-discuss-cases.test.ts`): the page
 * route's render, then every step `fetchAndRenderPage` (`wiki-browser.ts`)
 * runs on it, in its order. One list for both tests, so neither can run a
 * shorter chain than the reader.
 *
 * Needs a DOM on `globalThis` (the caller installs happy-dom's window). The
 * network is stubbed, not skipped: every `fetch` the chain makes while it runs
 * answers 404, except the answer list, which answers empty.
 */
import { questionRenderOptionsFor, renderWikiHtml } from "../../../wiki/render.ts";
import type { PageFiles } from "../../../format/query-block.ts";
import { enhanceCodeTabs } from "../components/code-tabs.ts";
import { enhanceCodeBlocks } from "../components/code-block-chrome.ts";
import { enhanceEmbeds } from "../components/wiki-embed.ts";
import { bindLaneProgress, enhanceReportBlocks } from "../components/wiki-report-blocks.ts";
import { enhanceQueryTables } from "../components/wiki-query-table.ts";
import { enhanceQueryExplorer } from "../components/wiki-query-explorer.ts";
import { enhanceFactCheck } from "../components/wiki-factcheck-reader.ts";
import { enhanceRefLinks } from "../components/wiki-ref-links.ts";
import { enhanceWalkthroughButtons } from "../components/wiki-walkthrough.ts";
import { enhanceStepDone } from "../components/wiki-step-done.ts";
import { enhanceLens } from "../components/wiki-lens.ts";
import { enhanceNewSince } from "../components/wiki-new-since.ts";
import { SECTION_BAR_ID, mountSectionBar } from "../components/wiki-section-bar.ts";
import { enhanceAnswerCards } from "../components/wiki-answer-cards.ts";

export interface ReaderArticleOptions {
  title?: string;
  /** `reader.roles`: whose lanes go first. */
  roles?: string[];
  /** A `<Query>` card's sibling files, as `loadPageFiles` reads them. */
  files?: PageFiles;
  /** The page payload's `answers` flag. */
  answerable?: boolean;
}

/** The steps `fetchAndRenderPage` runs after the article HTML lands, in its
 *  order. `run: false` names a step this helper does not run, and why. */
export const READER_CHAIN: readonly { step: string; run: boolean; why?: string }[] = [
  {
    step: "enhanceMermaid",
    run: false,
    why: "it loads the mermaid library from a CDN script, which happy-dom does not execute; the fence (`code.language-mermaid`) and the drawn SVG (`.mermaid`, `svg`) are both in DISCUSS_TEXT_SKIP",
  },
  { step: "enhanceCodeTabs", run: true },
  { step: "enhanceCodeBlocks", run: true },
  { step: "enhanceEmbeds", run: true },
  { step: "enhanceReportBlocks", run: true },
  { step: "enhanceQueryTables", run: true },
  { step: "enhanceQueryExplorer", run: true },
  { step: "enhanceFactCheck", run: true },
  { step: "enhanceRefLinks", run: true },
  { step: "enhanceWalkthroughButtons", run: true },
  { step: "enhanceStepDone", run: true },
  { step: "enhanceLens", run: true },
  { step: "enhanceNewSince", run: true },
  { step: "mountSectionBar", run: true },
  { step: "enhanceAnswerCards", run: true },
  { step: "bindLaneProgress", run: true },
  { step: "mountAnswerExport", run: false, why: "it writes into the breadcrumb bar, outside the article" },
  { step: "revealHashTarget", run: false, why: "it runs only for a `#id` in the URL, and only opens folds and scrolls" },
];

const pages = new Map([["ferry-plan", { name: "ferry-plan", relPath: "plans/ferry-plan.mdx", title: "Ferry plan" }]]);
/** The fixtures' one known page, for `[[ferry-plan]]`. */
export const fixtureResolve = ((t: string) => pages.get(t.trim().toLowerCase())) as unknown as Parameters<typeof renderWikiHtml>[1];

const RELPATH = "plans/harbour.mdx";
const WIKI = "fixture";

/** Every request the chain makes: 404, except the answer list (empty). */
async function stubFetch(input: unknown): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("/api/wiki/answers")) return Response.json({ answerable: true, answers: [] });
  return new Response("not found", { status: 404 });
}

const memoryStore = (): Pick<Storage, "getItem" | "setItem"> => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};

/** The page route's render of `md`, then the reader's chain ({@link READER_CHAIN}).
 *  Returns the `.wiki-article`; async because the chain's requests settle first. */
export async function readerArticle(md: string, opts: ReaderArticleOptions = {}): Promise<HTMLElement> {
  document.body.innerHTML = `<div id="${SECTION_BAR_ID}" hidden></div>`;
  const wrap = document.createElement("div");
  wrap.id = "articleWrap";
  const html = renderWikiHtml(md, fixtureResolve, {
    stripTitle: opts.title,
    wiki: WIKI,
    files: opts.files,
    question: questionRenderOptionsFor(md, null, opts.answerable === true, null),
    views: true,
    readerShapes: true,
  });
  wrap.innerHTML = `<div class="wiki-article-head"><div class="wiki-meta-row"></div></div><div class="wiki-article">${html}</div>`;
  document.body.appendChild(wrap);
  const article = wrap.querySelector<HTMLElement>(".wiki-article")!;

  const realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch as typeof fetch;
  try {
    const withWiki = (u: string) => u;
    enhanceCodeTabs(wrap);
    enhanceCodeBlocks(wrap);
    enhanceEmbeds(wrap, RELPATH, withWiki);
    const roles = opts.roles ?? [];
    enhanceReportBlocks(wrap, { language: "en", roles: { keys: roles, viewer: roles, preview: false } });
    enhanceQueryTables(wrap);
    enhanceQueryExplorer(wrap);
    enhanceFactCheck(wrap);
    enhanceRefLinks(wrap, RELPATH, undefined, { trackerProjects: [], withWiki, language: "en" });
    enhanceWalkthroughButtons(wrap, { relPath: RELPATH, hash: () => "h", withWiki, reload: () => {} });
    enhanceStepDone(wrap, { wiki: WIKI, relPath: RELPATH, hash: () => "h", reload: () => {}, current: () => true });
    enhanceLens(wrap, { language: "en", agentAvailable: false, inPlace: false, chipHost: null, initial: "all" });
    enhanceNewSince(wrap, { wiki: WIKI, relPath: RELPATH, language: "en", changedMs: null, storage: memoryStore(), session: memoryStore() });
    mountSectionBar(wrap);
    const cards = enhanceAnswerCards(wrap, opts.answerable ? { answerable: true } : undefined, { wiki: WIKI, relPath: RELPATH, fetchFn: stubFetch as typeof fetch });
    bindLaneProgress(article, cards);
    // The chain's requests (step checks, answers) answer on later ticks.
    for (let k = 0; k < 5; k++) await new Promise((r) => setTimeout(r, 0));
  } finally {
    globalThis.fetch = realFetch;
  }
  return article;
}
