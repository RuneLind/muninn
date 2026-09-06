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

/** What the client reads off one `<figure class="embed">` before deciding. */
export interface EmbedFigure {
  hasFrame: boolean;
  src: string;
  height: string;
  title: string;
}

export interface EmbedPlan {
  index: number;
  relPath: string;
  height: number;
  title: string;
}

/**
 * The enhancer's whole decision, DOM-free so the two skips can be pinned: a
 * figure already carrying a frame is left alone (a repaint that re-runs the
 * enhancers must not stack two), and an UNKNOWN page relPath plans nothing —
 * resolving against the root would load a different file than the author meant.
 */
export function planEmbeds(figures: readonly EmbedFigure[], pageRelPath: string): EmbedPlan[] {
  if (!pageRelPath) return [];
  const out: EmbedPlan[] = [];
  figures.forEach((f, index) => {
    if (f.hasFrame) return;
    const relPath = resolveEmbedRelPath(pageRelPath, f.src);
    if (relPath === null) return;
    const h = Number(f.height);
    const height = Number.isFinite(h) && h > 0 ? h : EMBED_HEIGHT_DEFAULT;
    out.push({ index, relPath, height, title: f.title || f.src });
  });
  return out;
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
