/**
 * Line-ref chips for the /wiki reader: an inline `<code>` whose WHOLE text is a
 * line reference renders as a muted chip (`code-ref`), and links to GitHub when
 * the page pins a commit with `code_at: <owner>/<repo>@<sha>`.
 *
 * Server-side, in the wiki render path only (`renderWikiHtml`): chat and the
 * other formatters never call it, so a `:123` in a chat answer stays plain code.
 *
 * Two shapes, each the ENTIRE span text:
 *   - path ref: `path/to/File.kt:12`, `File.kt:12-14`, `build.gradle.kts:52,66-67`,
 *     `a/B.kt:377–400`. Chips anywhere.
 *   - bare ref: `:12`, `:12-40`, `:12, :34`, `:227, 254`. Chips ONLY inside a
 *     pure ref group, because in prose `:8080` is a port far more often.
 *
 * A PURE REF GROUP is a parenthesised run holding nothing but ref spans and
 * separators (`,` `;` `og` `and` whitespace): "(`:1732-1735`)",
 * "(`e2e.routes.ts:61`, `:1886-1892`)". It is wrapped, leading space and parens
 * included, in `span.code-ref-group` — the one thing the reader's "line refs"
 * toggle hides, so hiding never leaves "()" or "API " behind.
 *
 * Only a path holding `/` links: a bare `File.kt:12` names no place in the repo.
 */

import { splitFrontmatter } from "./page-text.ts";
import { renderedCodeRegions, inRenderedCode } from "../format/rendered-code.ts";

export const CODE_REF_CLASS = "code-ref";
export const CODE_REF_LINK_CLASS = "code-ref-link";
export const CODE_REF_GROUP_CLASS = "code-ref-group";

const RANGE = String.raw`\d{1,6}(?:[-–]\d{1,6})?`;
const LIST = String.raw`${RANGE}(?:\s*,\s*:?${RANGE})*`;
const BARE_RE = new RegExp(String.raw`^:${LIST}$`);
const PATH_RE = new RegExp(String.raw`^([\p{L}\p{N}_.\-/…]+):(${LIST})$`, "u");
const FIRST_RANGE_RE = /^(\d+)(?:[-–](\d+))?/;

/** A path ref with no `/` must end in one of these: the guard against
 *  `jarvis.local:8080`, `java.lang:12` and the like. */
const SOURCE_EXTENSIONS = new Set([
  "kt", "kts", "java", "scala", "sc", "groovy", "gradle",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte",
  "py", "rb", "go", "rs", "c", "h", "cc", "cpp", "hpp", "cs", "swift", "php", "lua",
  "sql", "graphql", "proto",
  "yml", "yaml", "json", "toml", "xml", "properties", "conf", "ini", "cfg", "env", "tf",
  "md", "mdx", "txt", "csv",
  "sh", "bash", "zsh",
  "css", "scss", "html", "hbs", "tmpl", "service",
]);
const KNOWN_BASENAME_RE = /^(?:Makefile|Dockerfile(?:\.[\w.-]+)?)$/;
const BASENAME_RE = /^([\p{L}\p{N}_\-.]*?)\.(\p{L}[\p{L}\p{N}]{0,9})$/u;

function validPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (KNOWN_BASENAME_RE.test(base)) return true;
  const m = BASENAME_RE.exec(base);
  if (!m || m[1]!.endsWith(".")) return false;
  return path.includes("/") || SOURCE_EXTENSIONS.has(m[2]!.toLowerCase());
}

/** The ref shape of an inline code span's text, or null. Exported for tests. */
export function lineRefKind(text: string): "bare" | "path" | null {
  const t = text.trim();
  if (BARE_RE.test(t)) return "bare";
  const m = PATH_RE.exec(t);
  return m && validPath(m[1]!) ? "path" : null;
}

/** Whether an inline code span's text is a line ref (either shape). */
export function isLineRef(text: string): boolean {
  return lineRefKind(text) !== null;
}

/** A parsed `code_at` pin. */
export interface CodeAt {
  owner: string;
  repo: string;
  sha: string;
}

const CODE_AT_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})@([0-9a-fA-F]{7,40})$/;

/** Parse a `code_at` value strictly; anything else (or `.`/`..` as the repo) is
 *  null. The sha is lowercased: GitHub accepts either, the link is one spelling. */
export function parseCodeAt(value: string | null | undefined): CodeAt | null {
  const raw = (value ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
  const m = CODE_AT_RE.exec(raw);
  if (!m) return null;
  if (m[2] === "." || m[2] === "..") return null;
  return { owner: m[1]!, repo: m[2]!, sha: m[3]!.toLowerCase() };
}

/** The page's `code_at` frontmatter line, parsed, or null. */
export function codeAtFromPage(markdown: string): CodeAt | null {
  const { frontmatter } = splitFrontmatter(markdown);
  if (frontmatter === null) return null;
  const m = /^code_at:[ \t]*(.*)$/m.exec(frontmatter);
  return m ? parseCodeAt(m[1]) : null;
}

/**
 * The GitHub blob URL for a path ref under `codeAt`, or null when it cannot
 * link: no pin, no `/`, an absolute path, an elided or relative segment
 * (`domain/.../X.kt`), or line 0. A list links to its first line or range; a
 * reversed range is put in order. A first segment naming the pinned repo
 * (`melosys-console/backend/…`) is dropped.
 */
export function lineRefUrl(text: string, codeAt: CodeAt | null): string | null {
  if (!codeAt) return null;
  const m = PATH_RE.exec(text.trim());
  if (!m || !validPath(m[1]!)) return null;
  const path = m[1]!.replace(/^\.\//, "");
  if (!path.includes("/") || path.startsWith("/")) return null;
  let segs = path.split("/");
  if (segs.some((seg) => seg === "" || /^\.+$/.test(seg) || seg.includes("…"))) return null;
  if (segs.length > 1 && segs[0] === codeAt.repo) segs = segs.slice(1);
  const r = FIRST_RANGE_RE.exec(m[2]!)!;
  let a = Number(r[1]);
  let b = r[2] === undefined ? a : Number(r[2]);
  if (a === 0 || b === 0) return null;
  if (a > b) [a, b] = [b, a];
  const anchor = a === b ? `#L${a}` : `#L${a}-L${b}`;
  const encoded = segs.map(encodeURIComponent).join("/");
  return `https://github.com/${codeAt.owner}/${codeAt.repo}/blob/${codeAt.sha}/${encoded}${anchor}`;
}

// renderInline's inline-code shape: no attributes, already-escaped text (no
// line-ref character is one the escape rewrites, so the match reads the source).
const CODE = String.raw`<code>[^<]*<\/code>`;
const SEP = String.raw`(?:\s*[,;]\s*|\s+)(?:(?:og|and)\s+)?`;
const GROUP_OR_CODE_RE = new RegExp(
  String.raw`([ \t]?)\(\s*(${CODE}(?:${SEP}${CODE})*)\s*\)|<code>([^<]*)<\/code>`,
  "g",
);
const INNER_CODE_RE = /<code>([^<]*)<\/code>/g;
const ANCHOR_TAG_RE = /<a\b[^>]*>|<\/a>/g;

/** `[start, end)` spans of rendered HTML inside an `<a>`. Anchors do not nest. */
function anchorRegions(html: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let open = -1;
  for (const m of html.matchAll(ANCHOR_TAG_RE)) {
    if (m[0] === "</a>") {
      if (open >= 0) out.push({ start: open, end: m.index });
      open = -1;
    } else if (open < 0) open = m.index + m[0].length;
  }
  if (open >= 0) out.push({ start: open, end: html.length });
  return out;
}

/** Turn line-ref inline code spans in rendered wiki HTML into chips, and wrap
 *  each pure ref group. */
export function chipLineRefs(html: string, codeAt: CodeAt | null): string {
  if (html.indexOf("<code>") === -1) return html;
  // The nesting half of the code seam: a span inside `<code class="fileref">` (or
  // any code) is not prose. A fence's own `<code>` is top-level there, so the
  // `<pre>` check covers it.
  const regions = renderedCodeRegions(html);
  const anchors = anchorRegions(html);
  const inAnchor = (i: number) => anchors.some((r) => i >= r.start && i < r.end);
  const eligible = (i: number) => html.slice(Math.max(0, i - 5), i) !== "<pre>" && !inRenderedCode(regions, i);

  const chip = (text: string, at: number, inGroup: boolean): string | null => {
    if (!eligible(at)) return null;
    const kind = lineRefKind(text);
    if (kind === null || (kind === "bare" && !inGroup)) return null;
    const code = `<code class="${CODE_REF_CLASS}">${text}</code>`;
    // The author's own link wins: never an `<a>` inside an `<a>`.
    const url = inAnchor(at) ? null : lineRefUrl(text, codeAt);
    return url
      ? `<a class="${CODE_REF_LINK_CLASS}" href="${url}" target="_blank" rel="noopener noreferrer">${code}</a>`
      : code;
  };
  const chipEach = (fragment: string, base: number, inGroup: boolean) =>
    fragment.replace(INNER_CODE_RE, (whole, text: string, off: number) => chip(text, base + off, inGroup) ?? whole);

  return html.replace(GROUP_OR_CODE_RE, (whole, _lead, _inner, single: string | undefined, at: number) => {
    if (single !== undefined) return chip(single, at, false) ?? whole;
    const spans = [...whole.matchAll(INNER_CODE_RE)];
    const pure = spans.every((s) => eligible(at + s.index) && lineRefKind(s[1]!) !== null);
    if (!pure) return chipEach(whole, at, false);
    return `<span class="${CODE_REF_GROUP_CLASS}">${chipEach(whole, at, true)}</span>`;
  });
}
