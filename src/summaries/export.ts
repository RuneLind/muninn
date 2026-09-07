/**
 * A captured summary → a standalone HTML page, with its quoted slides beside it.
 *
 * The pure half of `GET /api/summaries/export` (`dashboard/routes/summaries-export.ts`).
 * Given the stored markdown and what huginn knows about the document, this
 * module decides three things and builds the page:
 *
 *  1. **Which frames the page needs** — {@link findFrameReference} reads the
 *     capture's frame source and video id off the markdown's OWN
 *     `![Slide …](/api/frames/<source>/<id>/<sec>.jpg)` quotes (either spelling
 *     the seam serves), so no vertical has to hand over an id it may not store,
 *     and the id is gated by that source's charset before it names a directory.
 *  2. **How those quotes are spelled in the page** — {@link rewriteFrameUrls}
 *     turns every served address into `frames/<sec>.jpg`, RELATIVE, so the page
 *     opens from `file://` with the JPEGs in a sibling folder and no server.
 *  3. **The HTML** — {@link renderExportPage}. Markdown goes through marked, the
 *     SAME renderer the `/summaries` article view loads from the CDN and with
 *     the same rule (raw HTML in the source is escaped, never emitted), so the
 *     export reads exactly like the article did. The dashboard's own markdown
 *     pipeline is deliberately NOT used here: it has no image rule at all —
 *     measured, `![Slide](…)` renders as a bare `!` followed by the alt text.
 *
 * The two Vimeo transforms the article view applies in the browser
 * ({@link linkVimeoTimestamps}, {@link splitTranscript}) are ported here
 * verbatim in behaviour; `sum-article-library.ts` keeps its copies inside a
 * template literal, which nothing can import. Both copies are pinned against
 * the same fixtures in `export.test.ts`.
 */

import { Marked, type Tokens } from "marked";
import { escapeHtml } from "../format/markdown-core.ts";
import { markdownContentStyles } from "../dashboard/views/components/doc-panel.ts";
import { themeTokenStyles } from "../dashboard/views/shared-styles.ts";
import { FRAME_SOURCES, frameQuoteRegExp, isFrameId, type FrameSource } from "./frames.ts";

/** The folder the page's `<img>`s point into, beside `index.html` in the archive. */
export const EXPORT_FRAMES_DIR = "frames";

/** The page's file name inside the archive. */
export const EXPORT_PAGE_NAME = "index.html";

/** A frame reference the markdown carries: which seam source, which video. */
export interface FrameReference {
  source: FrameSource;
  id: string;
}

/**
 * The first served frame address in the markdown's PROSE — `/api/frames/
 * <source>/<id>/` or the source's legacy prefix, {@link frameQuoteRegExp} —
 * whose id passes that source's charset gate. With `source` given, only that
 * source's quotes count: the route passes the exporting vertical's own frame
 * source, so an `article` capture that pastes a Vimeo frame path cannot pull
 * another capture's slides into its archive. A quote inside fenced code is
 * source text, not a reference. `null` when nothing qualifies.
 */
export function findFrameReference(markdown: string, source?: FrameSource): FrameReference | null {
  const sources = source ? [source] : FRAME_SOURCES;
  let found: FrameReference | null = null;
  mapProseLines(markdown, (line) => {
    if (found) return line;
    for (const src of sources) {
      const re = frameQuoteRegExp(src, null);
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        if (isFrameId(src, m[1]!)) {
          found = { source: src, id: m[1]! };
          return line;
        }
      }
    }
    return line;
  });
  return found;
}

/**
 * Every served address of THIS reference's frames, outside fenced code →
 * `frames/<sec>.jpg` (a markdown title after the path is kept). Only canonical
 * seconds are rewritten (`047.jpg` is not an address the route serves, so it
 * is not one the folder holds either); returns the rewritten markdown and the
 * seconds it now points at, ascending and deduped.
 */
export function rewriteFrameUrls(
  markdown: string,
  ref: FrameReference,
): { markdown: string; seconds: number[] } {
  const seconds = new Set<number>();
  const out = mapProseLines(markdown, (line) =>
    line.replace(frameQuoteRegExp(ref.source, ref.id), (whole: string, _id: string, sec: string) => {
      if (String(Number(sec)) !== sec) return whole;
      seconds.add(Number(sec));
      return whole.replace(/^\([^\s)]+/, `(${EXPORT_FRAMES_DIR}/${sec}.jpg`);
    }),
  );
  return { markdown: out, seconds: [...seconds].sort((a, b) => a - b) };
}

/**
 * Apply `fn` to every line OUTSIDE a fenced code block. A fence is closed only
 * by its own marker character with at least the opening length — the client's
 * rule, kept because pairing ``` and ~~~ interchangeably linked inside a block
 * and de-linked everything after it.
 */
function mapProseLines(markdown: string, fn: (line: string, i: number) => string): string {
  let fence: string | null = null;
  return markdown.split("\n").map((line, i) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (fence === null) {
        fence = m[1]!;
        return line;
      }
      if (m[1]!.charAt(0) === fence.charAt(0) && m[1]!.length >= fence.length) {
        fence = null;
        return line;
      }
    }
    return fence === null ? fn(line, i) : line;
  }).join("\n");
}

/**
 * Every `[HH:MM:SS]` / `[MM:SS]` outside fenced code and not already a link
 * label → `[\[HH:MM:SS\]](https://vimeo.com/<id>#t=<sec>s)`. No id ⇒ untouched.
 * The port of the article view's transform, byte-for-byte in its output.
 */
/**
 * The article view's own id rule (`vimeoVideoIdFromUrl` in
 * `sum-article-library.ts`), ported verbatim rather than `extractVimeoVideoId`:
 * the two disagree on a `/channels/<c>/<id>` URL and on a leading-zero id, and
 * the parity this module promises is with the page the reader compared the
 * export against.
 */
function vimeoVideoIdFromUrl(url: string | undefined): string | null {
  const m = /^https?:\/\/(?:www\.)?(?:player\.)?vimeo\.com\/(?:video\/)?(\d+)(?:[\/?#]|$)/i.exec(String(url ?? "").trim());
  return m ? m[1]! : null;
}

export function linkVimeoTimestamps(markdown: string, videoUrl: string | undefined): string {
  const id = vimeoVideoIdFromUrl(videoUrl);
  if (!id) return markdown;
  const base = `https://vimeo.com/${id}#t=`;
  return mapProseLines(markdown, (line) =>
    line.replace(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?\](?!\()/g, (whole, a: string, b: string, c?: string) => {
      const sec = c === undefined ? Number(a) * 60 + Number(b) : Number(a) * 3600 + Number(b) * 60 + Number(c);
      return `[\\[${whole.slice(1, -1)}\\]](${base}${sec}s)`;
    }),
  );
}

/**
 * Split at the first level-2 `## Transcript` heading outside fenced code: the
 * summary before it, the transcript after. No heading ⇒ transcript is `null`.
 */
export function splitTranscript(markdown: string): { body: string; transcript: string | null } {
  let at = -1;
  mapProseLines(markdown, (line, i) => {
    if (at === -1 && /^## Transcript\s*$/.test(line)) at = i;
    return line;
  });
  if (at === -1) return { body: markdown, transcript: null };
  const lines = markdown.split("\n");
  return { body: lines.slice(0, at).join("\n"), transcript: lines.slice(at + 1).join("\n") };
}

/**
 * A link target the exported page may carry: `http(s)`, `mailto`, or no scheme
 * at all (a fragment, a relative path). The page leaves this machine and opens
 * from `file://`, where a `javascript:`/`data:`/`vbscript:` href is script
 * execution on the reader's disk — measured through a real click. marked has
 * no sanitizer of its own; the source is model output over third-party
 * material.
 */
export function isSafeLinkHref(href: string): boolean {
  // Browsers strip ASCII tab/CR/LF (and ignore other C0 controls) BEFORE
  // parsing the scheme, so `java<TAB>script:` is `javascript:` to the click
  // and "no scheme" to a naive regex — measured through a real click. Any
  // control character is refused outright; a protocol-relative `//host` is
  // refused too, since from `file://` it navigates the page to `file://host`.
  if (/[\u0000-\u001f\u007f]/.test(href)) return false;
  const trimmed = href.trim();
  if (trimmed.startsWith("//")) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === "http" || scheme === "https" || scheme === "mailto";
}

/** The only image the page may load: a packaged frame. Anything else — a
 *  remote pixel, a served address the rewrite did not claim — would phone home
 *  or break, from a folder the reader believes is offline. */
const PACKAGED_FRAME_SRC_RE = new RegExp(`^${EXPORT_FRAMES_DIR}/\\d{1,6}\\.jpg$`);

/**
 * The renderer: marked, with raw HTML in the source escaped (the article view's
 * `renderer.html` override — the source is model output, not a page author),
 * unsafe link schemes reduced to their text, images limited to packaged
 * frames, and every absolute link opening in a new tab, since a `file://`
 * page navigating itself to vimeo.com has no way back.
 */
const exportMarked = new Marked({
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(token.raw);
    },
    link(token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens);
      const href = token.href;
      if (!isSafeLinkHref(href)) return text;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      const external = /^https?:\/\//i.test(href) ? ` target="_blank" rel="noopener"` : "";
      return `<a href="${escapeHtml(href)}"${title}${external}>${text}</a>`;
    },
    image(token: Tokens.Image) {
      if (!PACKAGED_FRAME_SRC_RE.test(token.href)) return escapeHtml(token.text);
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      return `<img src="${escapeHtml(token.href)}" alt="${escapeHtml(token.text)}"${title}>`;
    },
  },
});

export function renderExportMarkdown(markdown: string): string {
  return exportMarked.parse(markdown, { async: false }) as string;
}

export interface ExportPageInput {
  title: string;
  /** The capture's original address, when the document carries one. */
  url?: string;
  /** The source's link label (`Watch on Vimeo ↗`). */
  linkLabel: string;
  /** What huginn stored beside the text; only the keys below are read. */
  metadata?: Record<string, unknown>;
  /** The markdown AFTER the strips and the frame rewrite. */
  markdown: string;
  /** Vimeo captures get their timestamps linked; others do not. */
  sourceId: string;
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The archive's base name: the title with the characters no filesystem takes
 *  removed, whitespace collapsed, capped at a word boundary, and never empty. */
export function exportBaseName(title: string): string {
  const cleaned = title
    .replace(/[\\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= 80) return cleaned || "summary";
  const cut = cleaned.slice(0, 80);
  const at = cut.lastIndexOf(" ");
  return (at > 0 ? cut.slice(0, at) : cut).trim() || "summary";
}

/** One self-contained HTML document: theme tokens, the article styles, the
 *  summary, and the transcript (when there is one) in a closed `<details>`. */
export function renderExportPage(input: ExportPageInput): string {
  const md = input.sourceId === "vimeo" ? linkVimeoTimestamps(input.markdown, input.url) : input.markdown;
  const parts = splitTranscript(md);
  const meta = input.metadata;
  const facts: string[] = [];
  const speaker = metaString(meta, "speaker");
  const author = metaString(meta, "author");
  if (speaker) facts.push(escapeHtml(speaker));
  if (author && author !== speaker) facts.push(escapeHtml(author));
  const when = metaString(meta, "upload_date") ?? metaString(meta, "date");
  if (when) facts.push(escapeHtml(when.slice(0, 10)));
  const kind = metaString(meta, "summary_kind");
  if (kind) facts.push(`${escapeHtml(kind)} summary`);
  if (input.url && /^https?:\/\//i.test(input.url)) {
    facts.push(
      `<a href="${escapeHtml(input.url)}" target="_blank" rel="noopener">${escapeHtml(input.linkLabel)}</a>`,
    );
  }
  const exportedOn = new Date().toISOString().slice(0, 10);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
${themeTokenStyles()}
  html { color-scheme: dark light; }
  body {
    margin: 0;
    background: var(--bg-page);
    color: var(--text-primary, #e6e6e6);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 16px;
    line-height: 1.6;
  }
  .page { max-width: 860px; margin: 0 auto; padding: 32px 24px 64px; }
  header h1 { font-size: 30px; margin: 0 0 8px; line-height: 1.25; }
  .facts { color: var(--text-muted); font-size: 14px; margin: 0 0 28px; }
  .facts span + span::before { content: " · "; }
  .facts a { color: var(--accent-light); text-decoration: none; }
  .facts a:hover { text-decoration: underline; }
  footer { margin-top: 48px; color: var(--text-dim); font-size: 12px; }
${markdownContentStyles(".article")}
  .article img { display: block; margin: 16px auto; box-shadow: 0 2px 12px rgba(0,0,0,0.25); }
  .transcript { margin-top: 24px; border-top: 1px solid var(--border-primary); padding-top: 12px; }
  .transcript > summary { cursor: pointer; color: var(--text-muted); font-weight: 600; list-style: none; }
  .transcript > summary::-webkit-details-marker { display: none; }
  .transcript > summary::before { content: '▸'; display: inline-block; width: 1.1em; }
  .transcript[open] > summary::before { content: '▾'; }
  .transcript > summary:hover { color: var(--text-primary); }
</style>
</head>
<body>
<div class="page">
<header>
<h1>${escapeHtml(input.title)}</h1>
${facts.length ? `<p class="facts">${facts.map((f) => `<span>${f}</span>`).join("")}</p>` : ""}
</header>
<main class="article">
${renderExportMarkdown(parts.body)}
${
  parts.transcript === null
    ? ""
    : `<details class="transcript"><summary>Transcript</summary><div class="article">${renderExportMarkdown(parts.transcript)}</div></details>`
}
</main>
<footer>Exported from muninn on ${exportedOn}.</footer>
</div>
</body>
</html>
`;
}
