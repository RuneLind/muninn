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
import { escapeHtml, withoutSentinelDelimiters } from "../format/markdown-core.ts";
import { checkSlotHtml } from "../format/check-tag.ts";
import { observingComponentTags, reportComponentTag } from "../format/component-observer.ts";
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
import { renderedCodeRegions, inRenderedCode, restoreParkedSentinels } from "../format/rendered-code.ts";
import { parseFrontmatter, readStatusDate, stripFrontmatter, type WikiPageMeta, type WikiReaderConfig } from "./store.ts";
import { decisionText, liveSentinelLines, WIKILINK_WITH_LABEL_RE, wikiLinkText } from "./decision-text.ts";
import { chipLineRefs, codeAtFromPage } from "./code-refs.ts";
import { applyChipsAndMarks, chipPassCollected, keyMarkHtml, planKeyMarks, planLiveChips, type ChipInsertion, type KeyMarksInput, type LiveFactsInput } from "./live-facts.ts";
import { itemDateReference, renderDay } from "../format/item-dates.ts";
import type { PageFiles } from "../format/query-block.ts";
import { parseQuestionPage, parseQuestionsTo, type QuestionRenderOptions } from "../format/question.ts";
import { sha256 } from "../utils/date-hash.ts";
import { DEFAULT_QUESTION_LANGUAGE, type QuestionLanguage } from "../format/question-labels.ts";
import { pageDefaultLens, type IdLabels, type StoredLens, type WikiDefaultLens } from "../format/reader-lens.ts";
import { NAV_ANCHOR_ATTR } from "./core/cross-ref.ts";

// stripFrontmatter's single home is store.ts (the read-side, which store.ts must
// not import back from — that would invert layering). Re-exported here so the
// gardener consumers that import it from render.ts keep working unchanged.
export { stripFrontmatter } from "./store.ts";

export { WIKILINK_WITH_LABEL_RE } from "./decision-text.ts";

/**
 * The markdown the reader renders for a page: NULs and U+0001, fact-check sentinels and
 * frontmatter dropped, and a leading H1 that repeats the reader's own title
 * header removed. Exported so the Walk-me-through route cuts its sections out
 * of the same text the reader drew its headings from.
 */
export function readerBody(markdown: string, stripTitle?: string): string {
  return readerBodyLines(markdown, stripTitle).body;
}

/**
 * {@link readerBody}, and for each of its lines (0-based) the 1-based line of
 * `markdown` it is read from. The body is the page less its live fact-check
 * marker lines (whole lines), then a suffix of that: past the frontmatter
 * (whole lines) and the repeated H1 (its `\s*` takes leading blank lines, and
 * under CRLF the H1's `\r` stays, so the body may start mid-line). A line a
 * render reports in the body's numbers is named by this in the file's.
 */
export function readerBodyLines(markdown: string, stripTitle?: string): { body: string; fileLine: (bodyLine: number) => number } {
  const clean = withoutSentinelDelimiters(markdown);
  const owned = liveSentinelLines(clean);
  const lines = clean.split("\n");
  // `stripSentinelLines`, keeping each kept line's index in `markdown`.
  const kept: number[] = [];
  for (let i = 0; i < lines.length; i++) if (!owned.has(i)) kept.push(i);
  const text = owned.size === 0 ? clean : kept.map((i) => lines[i]).join("\n");
  let body = stripFrontmatter(text);
  // The reader renders its own title header — drop the page's leading H1 when
  // it just repeats that title, but keep distinct ones (e.g. index.md's
  // "# Wiki Index" under the fallback title "index").
  if (stripTitle) {
    const m = body.match(/^\s*#\s+(.+)\n?/);
    if (m && m[1]!.trim().toLowerCase() === stripTitle.trim().toLowerCase()) {
      body = body.slice(m.index! + m[0].length);
    }
  }
  let first = 0;
  for (let i = 0, end = text.length - body.length; i < end; i++) if (text.charCodeAt(i) === 10) first++;
  return { body, fileLine: (bodyLine) => (kept[Math.min(first + bodyLine, kept.length - 1)] ?? 0) + 1 };
}

/** A step's trailing `<Check>` as the reader's slot. The inline scanner never
 *  sees that tag (`renderList` took it off), so it is reported to the lint
 *  observer here, for its values (`lint-components.ts`); its placement lint
 *  reads from the page's steps. The client bundle carries neither. */
function readerCheckSlot(rawAttrs: string): string {
  if (observingComponentTags()) reportComponentTag({ name: "Check", rawAttrs, inline: true });
  return checkSlotHtml(rawAttrs);
}

/** The reader's link to one page, showing `text` (escaped here). `wiki` is the
 *  registered wiki name for the `href`; omit it for the default wiki. `anchor`
 *  is an element on that page (`[[plans/x#alpha-r11]]`): it rides the `href`'s
 *  fragment and `data-anchor`, which the shell's click delegate carries into the
 *  pushed URL so the page opens the folds around it. */
export function wikiPageAnchor(meta: WikiPageMeta, text: string, wiki?: string, anchor?: string): string {
  const wikiQuery = wiki ? `wiki=${encodeURIComponent(wiki)}&` : "";
  const hash = anchor ? `#${encodeURIComponent(anchor)}` : "";
  const anchorAttr = anchor ? ` ${NAV_ANCHOR_ATTR}="${escapeHtml(anchor)}"` : "";
  return `<a href="/wiki?${wikiQuery}relPath=${encodeURIComponent(meta.relPath)}${hash}" class="wiki-link" data-wiki-page="${escapeHtml(meta.name)}" data-relpath="${escapeHtml(meta.relPath)}"${anchorAttr}>${escapeHtml(text)}</a>`;
}

/** A wikilink target split at its first `#`: the page part resolves, the rest
 *  is an anchor on that page, passed on as written. The reader resolves it
 *  against the ids the page has (`hashTarget`, `wiki-hash-target.ts`: as
 *  written, lower case, then each id producer's slug), since only the page can
 *  tell an exact id (`qcard-open 1`, `-next-steps`) from source text
 *  (`Kjøre Plan`). A bare `[[#x]]` has no page part and stays whole.
 *  Backslashes go first, as `wikilinkTarget` drops them: a pipe table escapes
 *  the label's pipe (`[[p#r1\|R1]]`), which left `p#r1\` as the target. */
function splitWikilinkAnchor(raw: string): { page: string; anchor?: string } {
  const target = raw.replace(/\\/g, "");
  const hash = target.indexOf("#");
  if (hash <= 0) return { page: target };
  const anchor = target.slice(hash + 1).trim();
  return { page: target.slice(0, hash), ...(anchor ? { anchor } : {}) };
}

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
    /** The render lands in the reader's article (`.wiki-article`), whose CSS
     *  styles the reader shapes: number columns, verdict cells, the label grid
     *  (`reader-shapes.ts`). Set by `GET /api/wiki/page` alone: the gardener
     *  preview and the What's-new card have no such CSS, and the walkthrough's
     *  plain text and the component lint read the source's shape. */
    readerShapes?: boolean;
    /** With `views`: the index's `plan_status` is `proposed`, so a page with
     *  no ledger draws its at-a-glance slate (`pageLedgers`). */
    proposedPlan?: boolean;
    /** The live chips' pass (`live-facts.ts`): an empty `.fact-chip` after each
     *  PR or key mention the wiki's facts file covers. Set by `GET /api/wiki/page`
     *  alone: the walkthrough, the gardener preview, the component lint and
     *  `GET /api/wiki/ref` read the page without chips. */
    liveFacts?: LiveFactsInput;
    /** Discuss v2 PR 6 (D5): underline the page's keys for the hover peek
     *  (`planKeyMarks`). Set by `GET /api/wiki/page` alone, where the mentions
     *  route answers for the viewer. */
    keyMarks?: KeyMarksInput;
  },
): string {
  // The fact-check sentinels are internal write markers, never content — but
  // `formatWebHtml` HTML-escapes everything it doesn't recognize, so on every page
  // carrying a persisted fact-check block they rendered as a visible literal
  // `<!-- factcheck:start -->` line in the reader (live on all three annotated
  // pages before this).
  // A NUL or U+0001 is never content: the renderer's own sentinels
  // (`\x00WIKIPAGELINK<n>\x00`, the parked picture, `formatWebHtml`'s
  // `\x00…\x01` placeholders) are delimited by them and restored by search, so
  // one the page carries could forge one. Dropped, as the browser drops a NUL in
  // body text; with none left, none can reassemble. The sibling files' parsers
  // drop both from every value they read (`withoutSentinelDelimiters`).
  markdown = withoutSentinelDelimiters(markdown);
  const { body, fileLine } = readerBodyLines(markdown, opts?.stripTitle);

  const wikiQuery = opts?.wiki ? `wiki=${encodeURIComponent(opts.wiki)}&` : "";
  const rendered: string[] = [];
  // The source text each sentinel stands for, kept alongside its rendered form:
  // where the sentinel turns out to be inside code, THIS is what goes back.
  const literal: string[] = [];
  // The text each link shows: a lane's plain-text peek reads a link as this.
  const linkTexts: string[] = [];
  // A chip rides the wikilink sentinel with an empty literal and an empty link
  // text, so code, an attribute value and every plain-text reader of a
  // sentinel give nothing for it. Inserted first: its offsets are `body`'s.
  // A key mark rides two such empty sentinels INSIDE its key, after the first
  // character and before the last, so every rule that reads a neighbour sees
  // the page's own characters (`MEL-12*34*` keeps its literal stars); each
  // sentinel renders a placeholder that `wrapKeyMarks` turns into the span.
  let marked = body;
  let chips: ChipInsertion[] = [];
  if (opts?.liveFacts) {
    const plan = planLiveChips(body, markdown, opts.liveFacts);
    chips = plan.insertions;
    opts.liveFacts.collect?.(plan.facts);
    chipPassCollected();
  }
  const keyMarks = opts?.keyMarks ? planKeyMarks(body, markdown, opts.keyMarks, chips) : null;
  // The middle's lines are the body's: reported in the file's (`readerBodyLines`).
  const middle = keyMarks?.middle && { ...keyMarks.middle, fromLine: fileLine(keyMarks.middle.fromLine - 1), toLine: fileLine(keyMarks.middle.toLine - 1) };
  if (keyMarks) opts?.keyMarks?.collect?.({ marks: keyMarks.marks.length, skippedLines: keyMarks.skippedLines, skippedChars: keyMarks.skippedChars, ...(middle ? { middle } : {}) });
  const markKeys: string[] = [];
  // The chips parked one character early (`chipShifts`), moved after the inline pass.
  const shifted = new Set<number>();
  if (chips.length || keyMarks?.marks.length) {
    const park = (html: string) => {
      literal.push("");
      linkTexts.push("");
      rendered.push(html);
      return `\x00WIKIPAGELINK${rendered.length - 1}\x00`;
    };
    const parkChip = (html: string, shift: boolean) => {
      const token = park(html);
      if (shift) shifted.add(rendered.length - 1);
      return token;
    };
    marked = applyChipsAndMarks(body, chips, keyMarks?.marks ?? [], parkChip, (m) => {
      const text = body.slice(m.start, m.end);
      const cps = [...text];
      if (text !== m.key || cps.length < 3) return text;
      const n = markKeys.push(m.key) - 1;
      return cps[0] + park(keyMarkOpen(n)) + cps.slice(1, -1).join("") + park(keyMarkClose(n)) + cps.at(-1)!;
    });
  }
  const withTokens = marked.replace(WIKILINK_WITH_LABEL_RE, (whole: string, target: string, label?: string) => {
    literal.push(whole);
    const text = wikiLinkText(target, label);
    linkTexts.push(text);
    const { page, anchor } = splitWikilinkAnchor(target);
    const meta = resolve(page);
    const html = meta
      ? // `data-relpath` names the page the link RESOLVED to, so the in-page click
        // delegate opens that exact page instead of re-resolving the stem
        // (first-registration-wins) client-side — and the `href` now says the same
        // thing. It is used by exactly one path, a middle-click / "open in new
        // tab", and in the `?page=` form that path lost BOTH facts: the wiki (so a
        // link on mimir opened jarvis) and the page (the stem re-resolved to
        // whichever registered first).
        wikiPageAnchor(meta, text, opts?.wiki, anchor)
      : `<span class="wiki-link-missing" title="No page named ${escapeHtml(page.trim())}">${escapeHtml(text)}</span>`;
    const idx = rendered.length;
    rendered.push(html);
    return `\x00WIKIPAGELINK${idx}\x00`;
  });

  const renderedHtml = formatWebHtml(withTokens, {
      files: opts?.files,
      question: opts?.question,
      idLabels: opts?.idLabels,
      reader: true,
      checkSlot: readerCheckSlot,
      ...(opts?.readerShapes ? { readerShapes: true } : {}),
      wikiLinkTexts: linkTexts,
      wikiLinkSources: literal,
      itemDates: itemDateDaysOf(markdown, opts?.today),
      ...(opts?.language ? { language: opts.language } : {}),
      ...(opts?.views ? { views: true, proposedPlan: opts.proposedPlan === true, decisionText: decisionText(markdown), chartView: chartViewHtml, diagramView: diagramViewHtml, stepsView: stepsViewHtml, ruleTreeView: ruleTreeViewHtml, caseDotsView: caseDotsViewHtml, timelineLanes: timelineLanesHtml, systemMapView: systemMapViewHtml, systemMapNodes: systemMapNodeLinks(resolve, wikiQuery) } : {}),
    });
  // Inside code the page must show the bytes on disk, escaped. TEXT-exact,
  // not render-exact: `textContent` matches an unparked render byte for byte
  // — the acceptance — but the restored run is not tokenized, so the brackets
  // are uncoloured where the code around them is highlighted. In an attribute
  // value (a `<Question>` card echoes `choices=`/`to=` into `data-question-*`)
  // the source text goes back too: link HTML there would end the value.
  const html = wrapKeyMarks(restoreParkedSentinels(moveShiftedChips(renderedHtml, shifted), "WIKIPAGELINK", rendered, literal), markKeys);
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
  const glossed = opts?.views && body.includes("<Glossary") ? markGlossaryTerms(finished, glossaryTerms(pageGlossaries(body))) : finished;
  // Backstop: every sentinel is restored by now, and the body and the parsed
  // file values carry no NUL; one left (a source not yet covered) is never served.
  return restoreDiagramPictures(glossed, parked).replaceAll("\0", "");
}

const SENTINEL_RUN_BEFORE_CHAR_RE = /((?:\x00WIKIPAGELINK\d+\x00)+)([A-Za-z0-9])/g;

/**
 * Each shifted chip's sentinel (`chipShifts` in `live-facts.ts`: parked
 * before its site's last character) moved past that character, on the
 * rendered HTML before any sentinel is restored. Other sentinels in the same
 * run (a key mark's closing placeholder) stay before it. A shifted sentinel
 * the render did not leave right before a letter or digit stays where it is.
 */
export function moveShiftedChips(html: string, shifted: ReadonlySet<number>): string {
  if (shifted.size === 0) return html;
  return html.replace(SENTINEL_RUN_BEFORE_CHAR_RE, (whole, run: string, ch: string) => {
    const parts = run.match(/\x00WIKIPAGELINK\d+\x00/g)!;
    const moves = (p: string) => shifted.has(Number(p.slice("\x00WIKIPAGELINK".length, -1)));
    if (!parts.some(moves)) return whole;
    return parts.filter((p) => !moves(p)).join("") + ch + parts.filter(moves).join("");
  });
}

export const keyMarkOpen = (n: number) => `\x00WIKIKEYOPEN${n}\x00`;
export const keyMarkClose = (n: number) => `\x00WIKIKEYCLOSE${n}\x00`;
const KEY_MARK_RUN_RE = /(.)\x00WIKIKEYOPEN(\d+)\x00([^<>&\x00]*)\x00WIKIKEYCLOSE\2\x00(.)/gsu;
const KEY_MARK_LEFTOVER_RE = /\x00WIKIKEY(?:OPEN|CLOSE)\d+\x00/g;

/**
 * Each key mark's two placeholders, with the key's first and last characters
 * around them, as the mark's span — only where the render left exactly the
 * key's own text there in one run of text. Anywhere else (code and attribute
 * values already got the empty source text back) a placeholder is dropped, so
 * the page reads as it would unmarked.
 */
export function wrapKeyMarks(html: string, keys: readonly string[]): string {
  if (keys.length === 0) return html;
  return html
    .replace(KEY_MARK_RUN_RE, (whole, first: string, n: string, inner: string, last: string) => {
      const key = keys[Number(n)];
      return key !== undefined && first + inner + last === key ? keyMarkHtml(key) : whole;
    })
    .replace(KEY_MARK_LEFTOVER_RE, "");
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
  // The answer route's own reading (`questionTargetsOf`): the same parse, the
  // first block per id, the same hash — so the card's hash is the one it checks.
  const questionHashes = new Map<string, string>();
  if (answerable && markdown.includes("<Question")) {
    for (const q of parseQuestionPage(parseBlocks(stripFrontmatter(markdown))).questions) {
      if (q.id !== null && !questionHashes.has(q.id)) questionHashes.set(q.id, sha256(q.hashInput));
    }
  }
  return {
    questionsTo: parseQuestionsTo(parseFrontmatter(markdown).questions_to),
    language: readerConfig?.language ?? DEFAULT_QUESTION_LANGUAGE,
    answerable,
    ...(answerable && owner ? { owner } : {}),
    ...(questionHashes.size ? { questionHashes } : {}),
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
  /** The configured tracker projects (`trackers[].projects`): a key such as
   *  `MELOSYS-8308` before a wikilink is never a cross-page id. Absent on a
   *  wiki with no trackers. */
  trackerProjects?: string[];
  /** Discuss's «Ask Claude Code» (P1): its route is registered (the tool
   *  half), the wiki sets `discuss.handoff` and the viewer is admin, since the
   *  route answers an absolute path. */
  discussHandoff: boolean;
  /** Discuss's tab (P3): the wiki has a wiki agent the route accepts (a
   *  `.wiki-agent.md` at its root that `readWikiAgentRules` reads as `ok`),
   *  the discuss route is registered (the tool half) and the viewer is admin.
   *  The route's rules refusals (404 `no-agent`, 422, 503) stay, for a file
   *  changed after the page loaded. */
  discussAgent: boolean;
  /** Discuss v2 PR 5: the selection menu's «Where else» and «History» (no
   *  model): `GET /api/wiki/mentions` is registered here (the tool half, and
   *  `MUNINN_AUTH` off, where the route answers), and the viewer is admin. */
  mentions: boolean;
  /** The wiki's validated `keys` kinds (name and pattern), which the menu's
   *  key chips classify with `classifyKey`, as the mentions route does.
   *  Absent on a wiki with none. */
  keyKinds?: { name: string; pattern: string }[];
  /** Discuss v3 P1: who answers a Discuss turn here (the bot, where it comes
   *  from, its connector and planned model), for the selection bar's «Runs
   *  as» line and the who box. Present only with `discussAgent`; null when no
   *  bot answers (a wiki pinned to a bot that is missing). Computed by the
   *  page route, which may read bot config (this module may not). */
  discussWho?: ReaderDiscussWho | null;
}

/** The page route's `discussWhoFor` answer, as the payload carries it. */
export interface ReaderDiscussWho {
  bot: string;
  origin: "pinned" | "owner" | "fallback";
  connector: string;
  model: string | null;
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
  /** Whether the handoff route is registered here (the tool half: not under
   *  the read slice, which drops the `wiki` group). */
  handoffRoute = false,
  /** Whether the wiki root holds a `.wiki-agent.md` the discuss route
   *  accepts (`readWikiAgentRules` state `ok`), computed by the caller. */
  agentRules = false,
  /** Whether the mentions route answers here (Discuss v2 PR 5): registered
   *  with the tool half and `MUNINN_AUTH` off, computed by the caller. */
  mentionsRoute = false,
  /** Discuss v3 P1: who answers here, computed by the caller (undefined: not
   *  computed, the field stays out). Sent only where `discussAgent` holds. */
  discussWho?: ReaderDiscussWho | null,
): ReaderPayload {
  const trackerProjects = [...new Set((readerConfig?.trackers ?? []).flatMap((t) => t.projects))];
  const keyKinds = (readerConfig?.keys ?? []).map((k) => ({ name: k.name, pattern: k.pattern }));
  const discussAgent = handoffRoute && agentRules && viewer.admin;
  return {
    ...(trackerProjects.length ? { trackerProjects } : {}),
    ...(keyKinds.length ? { keyKinds } : {}),
    language: readerConfig?.language ?? DEFAULT_QUESTION_LANGUAGE,
    idLabels: readerConfig?.idLabels ?? {},
    defaultLens: pageDefaultLens(wiki, instanceDefault, readerConfig?.defaultLens),
    agentLens,
    roles: { keys: readerConfig?.roleKeys ?? [], viewer: viewer.roles, preview: viewer.admin },
    discussHandoff: handoffRoute && readerConfig?.discuss?.handoff === true && viewer.admin,
    // The discuss route sits in the same tool half as the handoff's.
    discussAgent,
    mentions: mentionsRoute && viewer.admin,
    ...(discussAgent && discussWho !== undefined ? { discussWho } : {}),
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
      // A fallback title is the reader's, not the file's: its own class keeps
      // it out of Discuss's context (`DISCUSS_TEXT_SKIP`).
      const fallback = !title;
      if (fallback) title = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
      const titleHtml = `<strong class="callout-title${fallback ? " callout-title-default" : ""}">${title}</strong>`;
      const bodyHtml = body ? `<div class="callout-body">${body}</div>` : "";
      return `<div class="callout callout-${tone}">${titleHtml}${bodyHtml}</div>`;
    },
  );
}
