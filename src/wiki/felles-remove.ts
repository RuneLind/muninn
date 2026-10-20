/**
 * What a felles **Remove** deletes besides the page: the data files the page
 * reads (`<Query csv=/sql=>`, `<CaseBoard src=>`, `<DeltaTable src=>`).
 *
 * Publish uploads those files beside the page, and the script's `--fjern`
 * deletes only the objects it is given, so a remove that names the page alone
 * left every data file in the bucket and on each pod's mirror (architecture
 * review 2026-10, finding 11).
 *
 * The refs are found by the reader's own rule (`pageFileRefKinds` over the
 * parsed body, so a tag in a code fence names nothing), resolved relative to the
 * page's folder as `loadPageFiles` resolves them, and sent in NFC, the name the
 * script uploads. Three refs are left out:
 *  - one publish does not upload: {@link publishUploadsDataFile} is the
 *    script's own test, `lstat` on the page's spelling of the path, so it
 *    answers as publish does on every filesystem (case- and
 *    normalization-insensitive on macOS APFS, byte for byte on Linux);
 *  - one whose object name the script's `sjekkStiform` refuses: one such name
 *    makes `--fjern` delete nothing at all. Returned as `refused`;
 *  - one another local page also reads: removing this page must not take a
 *    file a page that stays published still shows. Returned as `shared`.
 */
import { lstatSync } from "node:fs";
import path from "node:path";
import { parseBlocks } from "../format/markdown-ast.ts";
import { resolveEmbedRelPath } from "../format/embed.ts";
import { checkPageFileRef, PAGE_FILE_COMPONENTS, pageFileRefKinds } from "../format/query-block.ts";
import { splitFrontmatter } from "./page-text.ts";

/** The data files a page's markdown reads, in source order: the page's own
 *  spelling (what publish `lstat`s) and the NFC object name (what it uploads). */
function pageDataFiles(pageRelPath: string, markdown: string): { spelling: string; object: string }[] {
  if (!PAGE_FILE_COMPONENTS.some((c) => markdown.includes(`<${c}`))) return [];
  const out: { spelling: string; object: string }[] = [];
  for (const [ref, kinds] of pageFileRefKinds(parseBlocks(splitFrontmatter(markdown).body))) {
    if (checkPageFileRef(ref, kinds) !== "ok") continue;
    const rel = resolveEmbedRelPath(pageRelPath.replace(/\\/g, "/"), ref);
    if (rel === null) continue;
    const object = rel.normalize("NFC");
    if (!out.some((d) => d.object === object)) out.push({ spelling: rel, object });
  }
  return out;
}

/** The wiki-relative data files a page's markdown reads, NFC, in source order. */
export function pageDataFileRelPaths(pageRelPath: string, markdown: string): string[] {
  return pageDataFiles(pageRelPath, markdown).map((d) => d.object);
}

/** The script's `MAKS_SEGMENT_BYTES`: the longest object-name segment it sends. */
export const FELLES_SEGMENT_MAX_BYTES = 211;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const WILDCARDS = /[[\]*?]/;

/**
 * Why `publiser-felles-wiki.ts`'s `sjekkStiform` refuses `rel` as an object
 * name, or null. A mirror of that rule (`muninn-nais`), in English.
 */
export function fellesObjectPathRefusal(rel: string): string | null {
  if (rel === "" || rel.startsWith("/") || rel.includes("\\")) return "invalid path";
  if (CONTROL_CHARS.test(rel)) return "control or direction character";
  if (WILDCARDS.test(rel)) return "wildcard character ([ ] * ?) gcloud reads as a pattern";
  if (/#\d+$/.test(rel)) return "ends in #<digits>, which gcloud reads as an object version";
  const segments = rel.normalize("NFC").split("/");
  if (segments.some((d) => d === "" || d === "." || d === "..")) return "path leaves the wiki root";
  if (segments.some((d) => Buffer.byteLength(d) > FELLES_SEGMENT_MAX_BYTES)) {
    return `a path segment is longer than ${FELLES_SEGMENT_MAX_BYTES} bytes`;
  }
  return null;
}

/** What `lstat` says about a path, or null when it fails. */
export type Lstat = (abs: string) => { isFile(): boolean; isSymbolicLink(): boolean } | null;

const realLstat: Lstat = (abs) => {
  try {
    return lstatSync(abs);
  } catch {
    return null;
  }
};

/**
 * Whether publish uploads the data file `rel` (the page's spelling): the
 * script's `relUnder` (no symlinked folder below the root) and `lstat`, plus
 * its `O_NOFOLLOW` open and `isFile` check, which refuse a symlink or a
 * non-file. The scanner and the size cap are not mirrored.
 */
export function publishUploadsDataFile(root: string, rel: string, lstat: Lstat = realLstat): boolean {
  const segments = rel.split("/");
  let dir = root;
  for (const segment of segments.slice(0, -1)) {
    dir = path.join(dir, segment);
    const st = lstat(dir);
    if (st === null) break;
    if (st.isSymbolicLink()) return false;
  }
  const st = lstat(path.join(root, ...segments));
  return st !== null && st.isFile();
}

const readText = async (abs: string): Promise<string | null> => {
  try {
    return await Bun.file(abs).text();
  } catch {
    return null;
  }
};

/**
 * The data files to delete with `pageRelPath` (NFC object names), the ones
 * kept because another page in `pageRelPaths` (the local index) also reads
 * them, and the ones kept because the script refuses their name.
 */
export async function fellesRemoveDataFiles(
  root: string,
  pageRelPath: string,
  pageRelPaths: readonly string[],
  read: (abs: string) => Promise<string | null> = readText,
  lstat: Lstat = realLstat,
): Promise<{ dataFiles: string[]; shared: string[]; refused: string[] }> {
  const markdown = await read(path.join(root, pageRelPath));
  if (markdown === null) return { dataFiles: [], shared: [], refused: [] };
  const candidates: string[] = [];
  const refused: string[] = [];
  for (const { spelling, object } of pageDataFiles(pageRelPath, markdown)) {
    if (!publishUploadsDataFile(root, spelling, lstat)) continue;
    if (fellesObjectPathRefusal(object) === null) candidates.push(object);
    else refused.push(object);
  }
  if (candidates.length === 0) return { dataFiles: [], shared: [], refused };

  const self = pageRelPath.normalize("NFC");
  const named = new Set<string>();
  for (const other of pageRelPaths) {
    if (other.normalize("NFC") === self || !/\.mdx?$/i.test(other)) continue;
    const text = await read(path.join(root, other));
    if (text === null) continue;
    for (const rel of pageDataFileRelPaths(other, text)) named.add(rel);
  }
  return {
    dataFiles: candidates.filter((rel) => !named.has(rel)),
    shared: candidates.filter((rel) => named.has(rel)),
    refused,
  };
}
