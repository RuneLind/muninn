/**
 * Renders one wiki page's markdown to HTML for the /wiki reader.
 *
 * Reuses the web chat's markdown pipeline (`formatWebHtml`) — wikilinks are the
 * only wiki-specific syntax, so they are swapped for `\x00`-sentinel tokens
 * before rendering (the pipeline HTML-escapes text, which would otherwise
 * mangle them) and restored as internal anchors afterwards. Resolved links
 * become `<a href="/wiki?page=…" data-wiki-page="…">`; unresolved ones become
 * muted spans so dead links are visible but not clickable.
 *
 * ⚠️ **A sentinel that lands inside a rendered `<code>` is restored as the
 * SOURCE TEXT, not as a link.** The restore was not scoped to prose, so a
 * wikilink written inside a fence or inside backticks came back as a live
 * clickable `<a>` INSIDE `<pre><code>` with the `[[` `]]` gone from the code's
 * own text. That is altered source rather than a display bug: `code.textContent`
 * is what #494's Copy button hands the reader, what `wiki-mermaid.ts` reads to
 * build a diagram, and what the fact-check evidence card clones. Measured over
 * mimir + the jarvis wiki: 1495 wikilinks inside code across 57 pages, 522 of
 * them in inline spans.
 *
 * The decision is made on the RENDERED HTML (`renderedCodeRegions`), never by
 * scanning the markdown for fences — see that module for the four measured ways
 * a markdown-side scanner diverges from what the renderer actually parses.
 */

import { formatWebHtml, type ItemDateDays } from "../web/web-format.ts";
import { escapeHtml } from "../format/markdown-core.ts";
import { chartViewHtml } from "../format/chart-view.ts";
import { diagramViewHtml } from "../format/diagram-block.ts";
import { stepsViewHtml } from "../format/steps-block.ts";
import { ruleTreeViewHtml } from "../format/rule-tree-view.ts";
import { systemMapViewHtml } from "../format/system-map-view.ts";
import { resolveSystemNode, type SystemMapViewInput } from "../format/system-map.ts";
import { caseDotsViewHtml } from "../format/case-dots-view.ts";
import { timelineLanesHtml } from "../format/timeline-lanes.ts";
import { glossaryTerms, readGlossaries, type GlossaryBlockRead } from "../format/glossary.ts";
import { markGlossaryTerms } from "../format/glossary-view.ts";
import { parseBlocks } from "../format/markdown-ast.ts";
import { renderedCodeRegions, inRenderedCode } from "../format/rendered-code.ts";
import { parseFrontmatter, readStatusDate, stripFrontmatter, type WikiPageMeta, type WikiReaderConfig } from "./store.ts";
import { decisionText, stripSentinelLines, WIKILINK_WITH_LABEL_RE, wikiLinkText } from "./decision-text.ts";
import { chipLineRefs, codeAtFromPage } from "./code-refs.ts";
import { itemDateReference, renderDay } from "../format/item-dates.ts";
import type { PageFiles } from "../format/query-block.ts";
import { parseQuestionsTo, type QuestionRenderOptions } from "../format/question.ts";
import { DEFAULT_QUESTION_LANGUAGE, type QuestionLanguage } from "../format/question-labels.ts";
import { pageDefaultLens, type IdLabels, type StoredLens, type WikiDefaultLens } from "../format/reader-lens.ts";

// stripFrontmatter's single home is store.ts (the read-side, which store.ts must
// not import back from — that would invert layering). Re-exported here so the
// gardener consumers that import it from render.ts keep working unchanged.
export { stripFrontmatter } from "./store.ts";

export { WIKILINK_WITH_LABEL_RE } from "./decision-text.ts";

export function renderWikiHtml(
  markdown: string,
  resolve: (target: string) => WikiPageMeta | undefined,
  opts?: {
    stripTitle?: string;
    /** Registered wiki name, for the wikilink `href`. Omit for the default wiki.
     *  Only the href reads it — the data attributes the in-page click delegate
     *  uses carry no wiki, because a wikilink can only ever resolve inside the
     *  wiki it was rendered from. */
    wiki?: string;
    /** The page's `<Query>` sibling files, read by the route beforehand
     *  (`loadPageFiles`). Absent ⇒ each card says its result is not loaded here. */
    files?: PageFiles;
    /** What a `<Question>` card needs from the page and its wiki — built by
     *  {@link questionRenderOptionsFor}. Absent ⇒ a plain bordered question. */
    question?: QuestionRenderOptions;
    /** The wiki's `idLabels`: the nouns on DecisionLog and Query id chips. */
    idLabels?: IdLabels;
    /** The wiki's `language`: the `<More>` label and the `<StatusRows>`
     *  state phrases. Absent ⇒ the `question` option's, else `en`. */
    language?: QuestionLanguage;
    /** The render day (`YYYY-MM-DD`) item dates are read against (D49).
     *  Absent ⇒ today in Europe/Oslo. For tests and sweeps. */
    today?: string;
    /** The reader's page render: the decision chain view and the PR strip.
     *  Set by `GET /api/wiki/page` alone. */
    views?: boolean;
    /** With `views`: the index's `plan_status` is `proposed`, so a page with
     *  no ledger draws its at-a-glance slate (`pageLedgers`). */
    proposedPlan?: boolean;
  },
): string {
  // The fact-check sentinels are internal write markers, never content — but
  // `formatWebHtml` HTML-escapes everything it doesn't recognize, so on every page
  // carrying a persisted fact-check block they rendered as a visible literal
  // `<!-- factcheck:start -->` line in the reader (live on all three annotated
  // pages before this).
  // A NUL is never content: the renderer's own sentinels (`\x00WIKIPAGELINK<n>\x00`,
  // the parked picture) are NUL-delimited and restored by search, so a NUL the
  // page carries could forge one. Dropped, as the browser drops one in body
  // text and the lane peek already did; with none left, none can reassemble.
  markdown = markdown.replaceAll("\0", "");
  let body = stripFrontmatter(stripSentinelLines(markdown));
  // The reader renders its own title header — drop the page's leading H1 when
  // it just repeats that title, but keep distinct ones (e.g. index.md's
  // "# Wiki Index" under the fallback title "index").
  if (opts?.stripTitle) {
    const m = body.match(/^\s*#\s+(.+)\n?/);
    if (m && m[1]!.trim().toLowerCase() === opts.stripTitle.trim().toLowerCase()) {
      body = body.slice(m.index! + m[0].length);
    }
  }

  const wikiQuery = opts?.wiki ? `wiki=${encodeURIComponent(opts.wiki)}&` : "";
  const rendered: string[] = [];
  // The source text each sentinel stands for, kept alongside its rendered form:
  // where the sentinel turns out to be inside code, THIS is what goes back.
  const literal: string[] = [];
  // The text each link shows: a lane's plain-text peek reads a link as this.
  const linkTexts: string[] = [];
  const withTokens = body.replace(WIKILINK_WITH_LABEL_RE, (whole: string, target: string, label?: string) => {
    literal.push(whole);
    const text = wikiLinkText(target, label);
    linkTexts.push(text);
    const meta = resolve(target);
    const html = meta
      ? // `data-relpath` names the page the link RESOLVED to, so the in-page click
        // delegate opens that exact page instead of re-resolving the stem
        // (first-registration-wins) client-side — and the `href` now says the same
        // thing. It is used by exactly one path, a middle-click / "open in new
        // tab", and in the `?page=` form that path lost BOTH facts: the wiki (so a
        // link on mimir opened jarvis) and the page (the stem re-resolved to
        // whichever registered first).
        `<a href="/wiki?${wikiQuery}relPath=${encodeURIComponent(meta.relPath)}" class="wiki-link" data-wiki-page="${escapeHtml(meta.name)}" data-relpath="${escapeHtml(meta.relPath)}">${escapeHtml(text)}</a>`
      : `<span class="wiki-link-missing" title="No page named ${escapeHtml(target.trim())}">${escapeHtml(text)}</span>`;
    const idx = rendered.length;
    rendered.push(html);
    return `\x00WIKIPAGELINK${idx}\x00`;
  });

  const renderedHtml = restoreSentinelsInAttributes(
    formatWebHtml(withTokens, {
      files: opts?.files,
      question: opts?.question,
      idLabels: opts?.idLabels,
      reader: true,
      wikiLinkTexts: linkTexts,
      itemDates: itemDateDaysOf(markdown, opts?.today),
      ...(opts?.language ? { language: opts.language } : {}),
      ...(opts?.views ? { views: true, proposedPlan: opts.proposedPlan === true, decisionText: decisionText(markdown), chartView: chartViewHtml, diagramView: diagramViewHtml, stepsView: stepsViewHtml, ruleTreeView: ruleTreeViewHtml, caseDotsView: caseDotsViewHtml, timelineLanes: timelineLanesHtml, systemMapView: systemMapViewHtml, systemMapNodes: systemMapNodeLinks(resolve, wikiQuery) } : {}),
    }),
    literal,
  );
  const codeRegions = renderedCodeRegions(renderedHtml);
  const html = renderedHtml.replace(
    /\x00WIKIPAGELINK(\d+)\x00/g,
    (_m, idx: string, offset: number) => {
      const i = parseInt(idx, 10);
      // Inside code the page must show the bytes on disk, escaped. TEXT-exact,
      // not render-exact: `textContent` matches an unparked render byte for byte
      // — the acceptance — but the restored run is not tokenized, so the brackets
      // are uncoloured where the code around them is highlighted. Cosmetic, and
      // stated because the first spelling of this comment claimed more.
      if (inRenderedCode(codeRegions, offset)) return escapeHtml(literal[i] ?? "");
      return rendered[i] ?? "";
    },
  );
  // Park each `<Diagram>` picture behind an opaque token so NO string-level
  // post-pass over the rendered page can insert anything between its `<svg` and
  // its matching `</svg>` (the reported break-out was markGlossaryTerms; the
  // others that run here are chipLineRefs, upgradeObsidianCallouts and
  // paragraphGaps). The parking keys on the `.dgm-svg` wrapper alone: the
  // sanitizer's content model holds no `div`, so the wrapper's own close is the
  // first `</div>` after it. Restored last, and only where it was parked.
  const parked: ParkedPicture[] = [];
  const guarded = parkDiagramPictures(html, parked);
  const finished = paragraphGaps(upgradeObsidianCallouts(chipLineRefs(guarded, codeAtFromPage(markdown))));
  const marked = opts?.views && body.includes("<Glossary") ? markGlossaryTerms(finished, glossaryTerms(pageGlossaries(body))) : finished;
  return restoreDiagramPictures(marked, parked);
}

/** A `<SystemMap>` node's page on the reader: a `repos/` page, or a declared
 *  external's `integrations/` page, linked the way a wikilink is. */
function systemMapNodeLinks(resolve: (target: string) => WikiPageMeta | undefined, wikiQuery: string): SystemMapViewInput["resolveNode"] {
  return (node) => {
    const r = resolveSystemNode(node, resolve);
    const page = r.kind === "unresolved" ? null : r.page;
    return {
      kind: r.kind,
      link: page ? { href: `/wiki?${wikiQuery}relPath=${encodeURIComponent(page.relPath)}`, relPath: page.relPath, name: page.name } : null,
    };
  };
}

/** One parked picture: its wrapper's open tag as rendered, and its svg. */
export interface ParkedPicture {
  open: string;
  svg: string;
}

const DIAGRAM_PICTURE_RE = /(<div class="dgm-svg"[^>]*>)([\s\S]*?)(<\/div>)/g;
/** The parking token for picture `i`. NUL-delimited: the page body carries no
 *  NUL (dropped at `renderWikiHtml` entry), so no page text can spell one. */
const pictureToken = (i: number) => `\x00DGMPIC${i}\x00`;
const ANY_PICTURE_TOKEN = /\x00DGMPIC(\d+)\x00/g;

/** Replace each `.dgm-svg` picture's svg with its token, pushing it onto `parked`. */
export function parkDiagramPictures(html: string, parked: ParkedPicture[]): string {
  if (!html.includes('<div class="dgm-svg"')) return html;
  return html.replace(DIAGRAM_PICTURE_RE, (_m, open: string, svg: string, close: string) => {
    const idx = parked.length;
    parked.push({ open, svg });
    return `${open}${pictureToken(idx)}${close}`;
  });
}

/**
 * Put each parked picture back where its own block parked it, and nowhere else.
 * A picture is restored only when its token occurs exactly once, directly
 * between its own wrapper's open tag and a `</div>`; otherwise the picture is
 * dropped (the block keeps its text form). The rendered-code test beside those
 * never fires on the renderer's output: code escapes `<`, so a wrapper's open
 * tag never sits inside it. It is kept as a guard. Every
 * token-shaped run is removed from the output either way, so none is ever left
 * as text or restored into an attribute, a code span or a fence.
 */
export function restoreDiagramPictures(html: string, parked: readonly ParkedPicture[]): string {
  if (!html.includes("\x00DGMPIC")) return html;
  const regions = renderedCodeRegions(html);
  const placeAt = new Map<number, number>();
  parked.forEach((p, i) => {
    const tok = pictureToken(i);
    const at = html.indexOf(tok);
    if (at < 0 || html.indexOf(tok, at + 1) >= 0) return;
    const wrapperAt = at - p.open.length;
    if (wrapperAt < 0 || !html.startsWith(p.open, wrapperAt) || !html.startsWith("</div>", at + tok.length)) return;
    if (inRenderedCode(regions, at) || inRenderedCode(regions, wrapperAt)) return;
    placeAt.set(at, i);
  });
  return html.replace(ANY_PICTURE_TOKEN, (_m, _i: string, offset: number) => {
    const i = placeAt.get(offset);
    return i === undefined ? "" : parked[i]!.svg;
  });
}

/** The page body's `<Glossary>` blocks, wikilinks read as their text — the
 *  one reading the reader's marks and lint check 19 share. */
export function pageGlossaries(body: string): GlossaryBlockRead[] {
  return readGlossaries(parseBlocks(body.replace(WIKILINK_WITH_LABEL_RE, (_w: string, target: string, label?: string) => wikiLinkText(target, label))));
}

/** D20/D49: the days an item date is read against — the page's
 *  `status_date` (read as the index reads it) else the render day, and the
 *  render day itself. Only a page holding a dated block pays for the
 *  frontmatter parse. */
function itemDateDaysOf(markdown: string, today: string | undefined): ItemDateDays | undefined {
  if (!/<(?:DecisionLog|Query|NextMoves)\b/.test(markdown)) return undefined;
  const day = today ?? renderDay();
  return { ref: itemDateReference(readStatusDate(parseFrontmatter(markdown).status_date), day), today: day };
}

const SENTINEL_RE = /\x00WIKIPAGELINK(\d+)\x00/g;

/**
 * A sentinel the renderer copied into an ATTRIBUTE value — a `<Question>`
 * card echoes `choices=`/`to=` into `data-question-*` — goes back as the
 * source text, escaped: link HTML there would end the value and break the
 * tag. Every `"` in rendered text is escaped (`&quot;`), so a `="…"` run is an
 * attribute value and nothing else.
 */
function restoreSentinelsInAttributes(html: string, literal: string[]): string {
  if (!html.includes("\x00WIKIPAGELINK")) return html;
  return html.replace(/="[^"]*"/g, (value) =>
    value.includes("\x00") ? value.replace(SENTINEL_RE, (_m, i: string) => escapeHtml(literal[parseInt(i, 10)] ?? "")) : value,
  );
}

/**
 * The `<Question>` render option for one page: the frontmatter
 * `questions_to:` (read here because `renderWikiHtml` strips the frontmatter
 * before rendering), the wiki's `.wiki-reader.json` `language`, whether the
 * wiki takes answers, and on such a wiki the owner a question nobody is named
 * for goes to. `/api/wiki/page` is the caller.
 */
export function questionRenderOptionsFor(
  markdown: string,
  readerConfig: WikiReaderConfig | null | undefined,
  answerable: boolean,
  /** `WIKI_ANSWER_OWNER`; used only when `answerable`. */
  owner: string | null = null,
): QuestionRenderOptions {
  return {
    questionsTo: parseQuestionsTo(parseFrontmatter(markdown).questions_to),
    language: readerConfig?.language ?? DEFAULT_QUESTION_LANGUAGE,
    answerable,
    ...(answerable && owner ? { owner } : {}),
  };
}

/** The page payload's `reader` field: what the lens switch, the ref-link
 *  nouns and the header pills read. `idLabels` holds display nouns only. */
export interface ReaderPayload {
  language: QuestionLanguage;
  idLabels: IdLabels;
  /** `WIKI_DEFAULT_LENS` for this wiki, else the file's `defaultLens`; null ⇒ All. */
  defaultLens: StoredLens | null;
  /** The Agent lens is offered on this page for this viewer (D7). */
  agentLens: boolean;
  /** Role lanes (D30, D32, D23): the wiki's `roleKeys`, the viewer's group
   *  keys (whose lanes the reader puts first and marks «deg»), and whether the
   *  viewer gets «Se som rolle» (admin). Keys only, never a group member. */
  roles: ViewerRoles;
}

export interface ViewerRoles {
  keys: string[];
  viewer: string[];
  preview: boolean;
}

export function readerPayload(
  wiki: string | undefined,
  readerConfig: WikiReaderConfig | null | undefined,
  instanceDefault: WikiDefaultLens | undefined,
  viewer: { roles: string[]; admin: boolean } = { roles: [], admin: false },
  /** D7, computed by the caller (`agentLensFor`): `PLAN_CARD_BIN` set, the
   *  page carries `plan_status`, its root is a plan-card root, viewer admin. */
  agentLens = false,
): ReaderPayload {
  return {
    language: readerConfig?.language ?? DEFAULT_QUESTION_LANGUAGE,
    idLabels: readerConfig?.idLabels ?? {},
    defaultLens: pageDefaultLens(wiki, instanceDefault, readerConfig?.defaultLens),
    agentLens,
    roles: { keys: readerConfig?.roleKeys ?? [], viewer: viewer.roles, preview: viewer.admin },
  };
}

/**
 * Give consecutive prose paragraphs a visible gap in the reader.
 *
 * `formatWebHtml` emits NO `<p>` (see `src/web/CLAUDE.md`): two paragraphs come out as bare
 * text with a `\n\n` between them. The chat shows that blank line because `.msg-body` is
 * `white-space: pre-wrap`; `.wiki-article` is `normal`, so on every wiki page each run of
 * plain paragraphs rendered as ONE paragraph — measured 2026-09-21 on a plan brief whose seven
 * slots read as one block (11 top-level text nodes carrying a blank line, 0 `<br>`, computed
 * white-space `normal`). `<br><br>` is what the formatter already writes for a paragraph
 * break inside a blockquote.
 *
 * A `\n\n` is NOT only a paragraph boundary. The formatter's own `BLOCK_TAG` list
 * (`web-format.ts`) collapses the newline around the blocks it knows, but component wrappers
 * (`<div>`, `<details>`, `<figure>`) keep theirs: measured over 1774 mimir + jarvis pages,
 * 661 double newlines sat right after such a close tag and 1035 right before an open one, and
 * every pair of folds painted a two-line hole. So the gap is written only when NEITHER side
 * is a block tag; beside one, the block's own margin is the spacing and a single newline is
 * returned. Code regions keep their bytes: a fenced block with an empty line (a mermaid graph)
 * is shown, not reflowed.
 *
 * `BLOCK_TAGS` is this renderer's list, not the formatter's: it needs the wrappers the
 * formatter does not name and none of the table internals, which never abut a `\n\n`.
 */
export function paragraphGaps(html: string): string {
  const regions = renderedCodeRegions(html);
  return html.replace(/\n\n/g, (m, offset: number) => {
    if (inRenderedCode(regions, offset)) return m;
    // Both windows hold the longest tag (`</blockquote>`, 13 chars) with room for whitespace.
    // The `after` window was 14 by an off-by-two (`offset + 16` after skipping the two
    // newlines) and held `</blockquote>` with ONE leading space; the test pins 16 as the
    // floor. The only rule the width changes is `BLOCK_CLOSE_AFTER_RE`, whose `\s*` tolerates
    // as much leading whitespace as the window leaves; the other two anchor on the tag.
    const before = html.slice(Math.max(0, offset - WINDOW), offset);
    const after = html.slice(offset + 2, offset + 2 + WINDOW);
    if (BLOCK_CLOSE_RE.test(before) || BLOCK_OPEN_RE.test(after) || BLOCK_CLOSE_AFTER_RE.test(after)) return "\n";
    return "<br><br>";
  });
}

const WINDOW = 20;
/** One list for all three sides. `hr` is void and only ever matches on the open side; `p` is
 *  absent because the formatter emits it only glued inside a `<figure>`, never beside a `\n\n`. */
const BLOCK_TAGS = "details|div|ul|ol|pre|table|blockquote|h[1-6]|figure|hr|section|summary";
/** A block just closed before the blank line. */
const BLOCK_CLOSE_RE = new RegExp(`</(?:${BLOCK_TAGS})>$`);
/** A block opens right after it. */
const BLOCK_OPEN_RE = new RegExp(`^<(?:${BLOCK_TAGS})(?:[\\s>/]|$)`);
/** A block CLOSES right after it — a component body whose source ended in a blank line. */
const BLOCK_CLOSE_AFTER_RE = new RegExp(`^\\s*</(?:${BLOCK_TAGS})>`);

/** Obsidian callout type → the reader's callout tone palette. */
function calloutTone(type: string): "info" | "warn" | "good" | "bad" {
  switch (type.toLowerCase()) {
    case "warning":
    case "caution":
    case "attention":
    case "important":
      return "warn";
    case "tip":
    case "hint":
    case "success":
    case "check":
    case "done":
      return "good";
    case "danger":
    case "error":
    case "failure":
    case "fail":
    case "missing":
    case "bug":
      return "bad";
    case "factcheck":
      // Fact-check blocks (PR B "➕ Add to article") are neutral verification —
      // no fifth style; map to the existing `info` tone explicitly.
      return "info";
    default:
      return "info";
  }
}

/**
 * Upgrades Obsidian-style callout blockquotes (`> [!warning] Title` + body
 * lines) in already-rendered HTML to the same `.callout` markup the mdx
 * `<Callout>` component produces, so `.md` wiki pages get the styled box
 * instead of a plain blockquote with a literal `[!warning]` tag showing.
 *
 * Runs on rendered output because the markdown pipeline is shared with web
 * chat — the blockquote renderer joins lines with `<br>`, so the first segment
 * is the callout's title line. An empty title falls back to the capitalized
 * type name (Obsidian's own behavior).
 */
function upgradeObsidianCallouts(html: string): string {
  return html.replace(
    /<blockquote>\[!([a-zA-Z]+)\]\s*([\s\S]*?)<\/blockquote>/g,
    (_m, type: string, rest: string) => {
      const tone = calloutTone(type);
      const brIdx = rest.indexOf("<br>");
      let title = (brIdx === -1 ? rest : rest.slice(0, brIdx)).trim();
      let body = brIdx === -1 ? "" : rest.slice(brIdx + 4).replace(/^(?:\s*<br>)+/, "").trim();
      if (!title) title = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
      const titleHtml = `<strong class="callout-title">${title}</strong>`;
      const bodyHtml = body ? `<div class="callout-body">${body}</div>` : "";
      return `<div class="callout callout-${tone}">${titleHtml}${bodyHtml}</div>`;
    },
  );
}
