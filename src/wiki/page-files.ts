/**
 * Files a page reads from beside itself — the `csv=`/`sql=` of its `<Query>`
 * blocks — read BEFORE `renderWikiHtml`, which stays synchronous and gets the
 * answers as a {@link PageFiles} lookup.
 *
 * Every read goes through {@link resolveContainedFile}, the containment check
 * `GET /api/wiki/html` uses too. A file that is missing and one outside the
 * root both answer `unavailable`, so a page cannot probe the disk.
 */

import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseBlocks } from "../format/markdown-ast.ts";
import {
  PAGE_FILE_EXTENSIONS,
  PAGE_FILE_MAX_BYTES,
  PAGE_FILE_MAX_PER_PAGE,
  checkPageFileRef,
  queryFileRefs,
  type PageFileResult,
} from "../format/query-block.ts";
import { splitFrontmatter } from "./page-text.ts";

export type ContainedFile =
  | { ok: true; real: string }
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
  return { ok: true, real: fileReal };
}

/** One `csv=`/`sql=` value, relative to the page's folder. */
async function readPageFile(root: string, pageRelPath: string, ref: string): Promise<PageFileResult> {
  const lexical = checkPageFileRef(ref);
  if (lexical !== "ok") return { ok: false, reason: lexical };
  const rel = path.posix.join(path.posix.dirname(pageRelPath.replace(/\\/g, "/")), ref);
  const found = await resolveContainedFile(root, rel);
  if (!found.ok) return { ok: false, reason: "unavailable" };
  // The REAL file's extension too: `a.csv` linking to a `.env` inside the root
  // would otherwise serve a file no wiki route serves.
  if (!PAGE_FILE_EXTENSIONS.includes(path.extname(found.real).toLowerCase())) {
    return { ok: false, reason: "extension" };
  }
  try {
    const st = await stat(found.real);
    if (!st.isFile()) return { ok: false, reason: "unavailable" };
    if (st.size > PAGE_FILE_MAX_BYTES) return { ok: false, reason: "too-large" };
    // A NUL is the wikilink sentinel's delimiter in `renderWikiHtml`.
    const text = (await Bun.file(found.real).text()).replace(/\0/g, "�");
    return { ok: true, text };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Read every file the page's `<Query>` blocks name. The refs come from the
 * parsed AST (`queryFileRefs`), so a tag inside a code fence reads nothing.
 * Past `PAGE_FILE_MAX_PER_PAGE` distinct refs, the rest answer `limit`
 * unread. A page with no `<Query` substring parses nothing.
 */
export async function loadPageFiles(
  root: string,
  pageRelPath: string,
  markdown: string,
): Promise<ReadonlyMap<string, PageFileResult>> {
  const out = new Map<string, PageFileResult>();
  if (!markdown.includes("<Query")) return out;
  const refs = queryFileRefs(parseBlocks(splitFrontmatter(markdown).body));
  await Promise.all(
    refs.map(async (ref, k) => {
      out.set(
        ref,
        k < PAGE_FILE_MAX_PER_PAGE ? await readPageFile(root, pageRelPath, ref) : { ok: false, reason: "limit" },
      );
    }),
  );
  return out;
}
