/**
 * Line-ref chips for the /wiki reader: an inline `<code>` whose WHOLE text is a
 * line reference renders as a muted chip (`code-ref`), and links to GitHub when
 * the page pins a commit with `code_at: <owner>/<repo>@<sha>`.
 *
 * Server-side, in the wiki render path only (`renderWikiHtml`): chat and the
 * other formatters never call it, so a `:123` in a chat answer stays plain code.
 * The reader's "line refs" toggle hides the chips with a class on the article.
 *
 * Shapes, each the ENTIRE span text:
 *   `:1234`  `:1234-1240`  `:12, :34-36`  `path/to/file.ext:123`  `file.ext:12-14`
 * Only a ref whose path contains `/` links: a bare `file.ts:12` names no place in
 * the repo.
 */

import { splitFrontmatter } from "./page-text.ts";

const RANGE = String.raw`\d{1,6}(?:-\d{1,6})?`;
const BARE_LIST_RE = new RegExp(String.raw`^:${RANGE}(?:\s*,\s*:${RANGE})*$`);
const PATH_REF_RE = new RegExp(String.raw`^([A-Za-z0-9_.\-/]*[A-Za-z0-9_\-]\.[A-Za-z][A-Za-z0-9]{0,9}):(\d{1,6})(?:-(\d{1,6}))?$`);

/** A parsed `code_at` pin. */
export interface CodeAt {
  owner: string;
  repo: string;
  sha: string;
}

const CODE_AT_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})@([0-9a-f]{7,40})$/;

/** Parse a `code_at` value strictly; anything else (or `.`/`..` as the repo) is null. */
export function parseCodeAt(value: string | null | undefined): CodeAt | null {
  const raw = (value ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
  const m = CODE_AT_RE.exec(raw);
  if (!m) return null;
  if (m[2] === "." || m[2] === "..") return null;
  return { owner: m[1]!, repo: m[2]!, sha: m[3]! };
}

/** The page's `code_at` frontmatter line, parsed, or null. */
export function codeAtFromPage(markdown: string): CodeAt | null {
  const { frontmatter } = splitFrontmatter(markdown);
  if (frontmatter === null) return null;
  const m = /^code_at:[ \t]*(.*)$/m.exec(frontmatter);
  return m ? parseCodeAt(m[1]) : null;
}

/** Whether an inline code span's text is a line ref. Exported for tests. */
export function isLineRef(text: string): boolean {
  const t = text.trim();
  return BARE_LIST_RE.test(t) || PATH_REF_RE.test(t);
}

/** The GitHub blob URL for a path ref under `codeAt`, or null when it cannot link. */
export function lineRefUrl(text: string, codeAt: CodeAt | null): string | null {
  if (!codeAt) return null;
  const m = PATH_REF_RE.exec(text.trim());
  if (!m) return null;
  const path = m[1]!.replace(/^\.\//, "");
  if (!path.includes("/") || path.startsWith("/")) return null;
  if (path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  const a = m[2]!;
  const b = m[3];
  const anchor = b ? `#L${a}-L${b}` : `#L${a}`;
  return `https://github.com/${codeAt.owner}/${codeAt.repo}/blob/${codeAt.sha}/${path}${anchor}`;
}

// A bare inline `<code>` (renderInline's shape: no attributes) not opened by a
// fence's `<pre>`. Its text is already escaped, and no line-ref character is
// one the escape rewrites, so the match reads the source text.
const INLINE_CODE_RE = /(?<!<pre>)<code>([^<]*)<\/code>/g;

/** Turn every line-ref inline code span in rendered wiki HTML into a chip. */
export function chipLineRefs(html: string, codeAt: CodeAt | null): string {
  if (html.indexOf("<code>") === -1) return html;
  return html.replace(INLINE_CODE_RE, (whole, text: string) => {
    if (!isLineRef(text)) return whole;
    const chip = `<code class="code-ref">${text}</code>`;
    const url = lineRefUrl(text, codeAt);
    return url
      ? `<a class="code-ref-link" href="${url}" target="_blank" rel="noopener noreferrer">${chip}</a>`
      : chip;
  });
}
