/**
 * `<Embed src="…" height="…" title="…" />` — a markdown page embedding a standalone
 * `.html` explainer (an archify diagram, a compiled explainer) INSIDE its own body,
 * so the narrative page keeps the graph membership an `.html` file never gets
 * (frontmatter, wikilinks, backlinks, Ask/Fact check/Share) while the diagram
 * stays the full interactive viewer it was delivered as.
 *
 * Two halves, both here because both must agree on the same strings:
 *  - `parseEmbedAttrs` — the server render's gate. Only a RELATIVE `.html` path
 *    is accepted; a scheme, a leading slash, a query or a fragment is refused and
 *    the block renders as its visible fallback line. The server never resolves
 *    the path: `formatWebHtml` does not know which page it is rendering.
 *  - `resolveEmbedRelPath` — the client's join of that relative `src` onto the
 *    embedding page's relPath, `..` included, refusing anything that escapes the
 *    wiki root. The route re-checks containment against the real root, so this is
 *    the reader's own fail-closed copy, not the guard.
 */

export const EMBED_HEIGHT_DEFAULT = 640;
export const EMBED_HEIGHT_MIN = 200;
export const EMBED_HEIGHT_MAX = 4000;

export interface EmbedAttrs {
  src: string;
  height: number;
  title: string;
}

/** A relative path of ordinary path characters ending in `.html`. No scheme, no
 *  leading slash, no `?`/`#`, no backslash, no whitespace. */
const EMBED_SRC_RE = /^(?![A-Za-z][A-Za-z0-9+.-]*:)(?!\/)[A-Za-z0-9._~()@ -]*(?:\/[A-Za-z0-9._~()@ -]*)*\.html$/i;

export function parseEmbedAttrs(attrs: Record<string, string>): EmbedAttrs | null {
  const src = (attrs.src ?? "").trim();
  if (!src || !EMBED_SRC_RE.test(src)) return null;
  const rawHeight = (attrs.height ?? "").trim();
  let height = EMBED_HEIGHT_DEFAULT;
  if (rawHeight !== "") {
    if (!/^\d{1,5}$/.test(rawHeight)) return null;
    height = Math.min(EMBED_HEIGHT_MAX, Math.max(EMBED_HEIGHT_MIN, Number(rawHeight)));
  }
  const title = (attrs.title ?? "").trim() || src;
  return { src, height, title };
}

/**
 * Join `src` onto the directory of `pageRelPath` (posix, `/`-separated, as the
 * wiki index stores it). Returns `null` when the result would climb above the
 * root. `pageRelPath` may be `""` for a root-level page.
 */
export function resolveEmbedRelPath(pageRelPath: string, src: string): string | null {
  const dir = pageRelPath.includes("/") ? pageRelPath.slice(0, pageRelPath.lastIndexOf("/")) : "";
  const parts: string[] = dir === "" ? [] : dir.split("/");
  for (const seg of src.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}
