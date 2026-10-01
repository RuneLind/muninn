/**
 * Files a page reads from beside itself — the `csv=`/`sql=` of its `<Query>`
 * blocks — read BEFORE `renderWikiHtml`, which stays synchronous and gets the
 * answers as a {@link PageFiles} lookup.
 *
 * Every read goes through {@link resolveContainedFile}, the containment check
 * `GET /api/wiki/html` uses too. A file that is missing and one outside the
 * root both answer `unavailable`, so a page cannot probe the disk.
 */

import { constants as fsc } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { parseBlocks } from "../format/markdown-ast.ts";
import { resolveEmbedRelPath } from "../format/embed.ts";
import {
  PAGE_FILE_EXTENSIONS,
  PAGE_FILE_MAX_BYTES,
  PAGE_FILE_MAX_PER_PAGE,
  PAGE_FILE_PAGE_BUDGET_BYTES,
  checkPageFileRef,
  hasExcludedSegment,
  pageFileExtension,
  queryFileRefs,
  type PageFileResult,
} from "../format/query-block.ts";
import { splitFrontmatter } from "./page-text.ts";

export type ContainedFile =
  | { ok: true; real: string; rootReal: string }
  | { ok: false; reason: "outside" | "missing" | "outside-real" };

/**
 * `relPath` resolved under `root`, judged twice: lexically under
 * `path.resolve(root)`, then on the realpath of BOTH, so a symlinked file or
 * folder under the root that points outside it is refused (`outside-real`).
 * `missing` is a realpath failure. The three reasons are kept apart for
 * `/api/wiki/html`, whose status codes differ by them.
 */
export async function resolveContainedFile(root: string, relPath: string): Promise<ContainedFile> {
  const rootAbs = path.resolve(root);
  const fileAbs = path.resolve(rootAbs, relPath);
  const under = (file: string, dir: string) => file === dir || file.startsWith(dir + path.sep);
  if (!under(fileAbs, rootAbs)) return { ok: false, reason: "outside" };
  let rootReal: string;
  let fileReal: string;
  try {
    rootReal = await realpath(rootAbs);
    fileReal = await realpath(fileAbs);
  } catch {
    return { ok: false, reason: "missing" };
  }
  if (!under(fileReal, rootReal)) return { ok: false, reason: "outside-real" };
  return { ok: true, real: fileReal, rootReal };
}

const UNAVAILABLE: PageFileResult = { ok: false, reason: "unavailable" };

/**
 * One `csv=`/`sql=` value, relative to the page's folder. `budget` is the bytes
 * the page may still read; the read's size is subtracted from it.
 *
 * The realpath check names the file; the bytes come from ONE handle opened on
 * that real path with `O_NOFOLLOW` (a file swapped for a symlink after the
 * check is refused, not followed) and `O_NONBLOCK` (a FIFO does not hang the
 * open). Type, link count and size are read off the handle, and at most
 * cap + 1 bytes are read from it, so a file grown past the cap after `fstat`
 * is still refused; whatever was read up to the cap is served. Two residuals, both needing write access to the wiki tree: a
 * DIRECTORY on the path swapped for a symlink between the realpath and the
 * open (`O_NOFOLLOW` covers the last segment only), and a hard link to an
 * outside file once nlink reads 1 (see the check below).
 */
async function readPageFile(
  root: string,
  pageRelPath: string,
  ref: string,
  budget: { left: number },
): Promise<PageFileResult> {
  const lexical = checkPageFileRef(ref);
  if (lexical !== "ok") return { ok: false, reason: lexical };
  // `null` when a `..` climbs above the root at any point, even one that
  // comes back in: `../<root's name>/x.csv` would otherwise tell a page what
  // the root's folder is called.
  const rel = resolveEmbedRelPath(pageRelPath.replace(/\\/g, "/"), ref);
  if (rel === null) return UNAVAILABLE;
  const found = await resolveContainedFile(root, rel);
  if (!found.ok) return UNAVAILABLE;
  // The REAL file is judged by the same rules as the ref: `a.csv` linking to
  // a `.env` or into `.git/` inside the root serves nothing the index serves.
  const realRel = path.relative(found.rootReal, found.real).split(path.sep).join("/");
  if (!PAGE_FILE_EXTENSIONS.includes(pageFileExtension(realRel))) return { ok: false, reason: "extension" };
  if (hasExcludedSegment(realRel)) return UNAVAILABLE;
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(found.real, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
    const st = await fh.stat();
    // A hard link is invisible to realpath. Best effort only: a file with a
    // second name may be an outside file linked in, but once the outside name
    // is gone (or under a rename race) nlink reads 1 and the file is served.
    if (!st.isFile() || st.nlink > 1) return UNAVAILABLE;
    if (st.size > PAGE_FILE_MAX_BYTES) return { ok: false, reason: "too-large" };
    if (st.size > budget.left) return { ok: false, reason: "budget" };
    // One byte past the cap shows a file grown past it since `fstat`.
    const buf = Buffer.allocUnsafe(PAGE_FILE_MAX_BYTES + 1);
    let n = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
      if (n === buf.length) break;
    }
    if (n > PAGE_FILE_MAX_BYTES) return { ok: false, reason: "too-large" };
    if (n > budget.left) return { ok: false, reason: "budget" };
    budget.left -= n;
    // A NUL is the wikilink sentinel's delimiter in `renderWikiHtml`; a
    // leading BOM would reach the SQL disclosure and its Copy text.
    const text = buf.toString("utf8", 0, n).replace(/^\uFEFF/, "").replace(/\0/g, "�");
    return { ok: true, text };
  } catch {
    return UNAVAILABLE;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * Read every file the page's `<Query>` blocks name. The refs come from the
 * parsed AST (`queryFileRefs`), so a tag inside a code fence reads nothing.
 * Read one at a time in source order, so the per-page byte budget
 * (`PAGE_FILE_PAGE_BUDGET_BYTES`) cuts the same refs on every open. Past
 * `PAGE_FILE_MAX_PER_PAGE` distinct refs, the rest answer `limit` unread. A
 * page with no `<Query` substring parses nothing.
 */
export async function loadPageFiles(
  root: string,
  pageRelPath: string,
  markdown: string,
): Promise<ReadonlyMap<string, PageFileResult>> {
  const out = new Map<string, PageFileResult>();
  if (!markdown.includes("<Query")) return out;
  const refs = queryFileRefs(parseBlocks(splitFrontmatter(markdown).body));
  const budget = { left: PAGE_FILE_PAGE_BUDGET_BYTES };
  for (const [k, ref] of refs.entries()) {
    out.set(ref, k < PAGE_FILE_MAX_PER_PAGE ? await readPageFile(root, pageRelPath, ref, budget) : { ok: false, reason: "limit" });
  }
  return out;
}
