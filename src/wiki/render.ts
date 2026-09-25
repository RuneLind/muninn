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

import { formatWebHtml } from "../web/web-format.ts";
import { escapeHtml } from "../format/markdown-core.ts";
import { renderedCodeRegions, inRenderedCode } from "../format/rendered-code.ts";
import { stripFrontmatter, type WikiPageMeta } from "./store.ts";
import { FACTCHECK_SENTINEL_START, FACTCHECK_SENTINEL_END } from "./factcheck-context.ts";

// stripFrontmatter's single home is store.ts (the read-side, which store.ts must
// not import back from — that would invert layering). Re-exported here so the
// gardener consumers that import it from render.ts keep working unchanged.
export { stripFrontmatter } from "./store.ts";

/** A `[[wikilink]]` with an optional `|label`, target and label both NEWLINE-FREE
 *  — `WIKILINK_RE`'s exclusion (`store.ts`), and the reader is where its absence
 *  was VISIBLE: a dangling `[[` from a truncated index one-liner paired with the
 *  NEXT line's `]]`, so five index.md entries rendered as one merged
 *  `wiki-link-missing` span that ate the following entry's real link. */
const WIKILINK_WITH_LABEL_RE = /\[\[([^\]|\n]+?)(?:\|([^\]\n]*?))?\]\]/g;

/**
 * Drop the fact-check sentinel MARKERS that own a whole line, leaving the block
 * between them (real content) to render.
 *
 * Deliberately NOT the write side's `findLiveSentinelBlocks`, which answers a
 * different question (where is the live block?): an UNPAIRED marker line is
 * never content either, so it is dropped here too. The two agree on every page
 * of mimir + jarvis (sweep, 2026-09-25). A line filter rather than a regex:
 *  - the marker literals come from `factcheck-context.ts` (the one authority)
 *    instead of a third hand-copied spelling;
 *  - a line must be EXACTLY the marker (surrounding whitespace ok), so
 *    `<!-- factcheck:start --> real prose` keeps its marker — the line is not
 *    the marker's to own;
 *  - lines inside a ``` / ~~~ fence are left alone, because a page documenting
 *    this format (a live mimir plan page does) shows the markers on their own
 *    lines inside an ```mdx fence.
 */
function stripSentinelLines(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence && (trimmed === FACTCHECK_SENTINEL_START || trimmed === FACTCHECK_SENTINEL_END)) {
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
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
  },
): string {
  let body = stripFrontmatter(markdown);
  // The fact-check sentinels are internal write markers, never content — but
  // `formatWebHtml` HTML-escapes everything it doesn't recognize, so on every page
  // carrying a persisted fact-check block they rendered as a visible literal
  // `<!-- factcheck:start -->` line in the reader (live on all three annotated
  // pages before this). Dropped on their OWN lines only, so a page that quotes the
  // marker mid-sentence (or inside a code fence) while documenting this feature
  // still shows it.
  body = stripSentinelLines(body);
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
  const withTokens = body.replace(WIKILINK_WITH_LABEL_RE, (whole: string, target: string, label?: string) => {
    literal.push(whole);
    const text = (label ?? target).trim() || target.trim();
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

  const renderedHtml = formatWebHtml(withTokens);
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
  return paragraphGaps(upgradeObsidianCallouts(html));
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
