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
 *  - one with no local file: publish uploaded nothing for it. The file is found
 *    by a per-segment readdir walk that also matches the other normalization
 *    form ({@link localSpelling}, the script's `lokalSti`): Linux compares names
 *    byte for byte, so a NFC ref misses a file stored NFD there;
 *  - one whose object name the script's `sjekkStiform` refuses: one such name
 *    makes `--fjern` delete nothing at all. Returned as `refused`;
 *  - one another local page also reads: removing this page must not take a
 *    file a page that stays published still shows. Returned as `shared`.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { parseBlocks } from "../format/markdown-ast.ts";
import { resolveEmbedRelPath } from "../format/embed.ts";
import { checkPageFileRef, PAGE_FILE_COMPONENTS, pageFileRefKinds } from "../format/query-block.ts";
import { resolveContainedFile } from "./page-files.ts";
import { splitFrontmatter } from "./page-text.ts";

/** The wiki-relative data files a page's markdown reads, NFC, in source order. */
export function pageDataFileRelPaths(pageRelPath: string, markdown: string): string[] {
  if (!PAGE_FILE_COMPONENTS.some((c) => markdown.includes(`<${c}`))) return [];
  const out: string[] = [];
  for (const [ref, kinds] of pageFileRefKinds(parseBlocks(splitFrontmatter(markdown).body))) {
    if (checkPageFileRef(ref, kinds) !== "ok") continue;
    const rel = resolveEmbedRelPath(pageRelPath.replace(/\\/g, "/"), ref);
    if (rel === null) continue;
    const nfc = rel.normalize("NFC");
    if (!out.includes(nfc)) out.push(nfc);
  }
  return out;
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

export type ListDir = (absDir: string) => Promise<string[] | null>;

const realListDir: ListDir = async (abs) => {
  try {
    return await readdir(abs);
  } catch {
    return null;
  }
};

/**
 * `rel`'s spelling on disk under `root`, or null when a segment is missing.
 * Each segment takes the exact name when the folder holds it, else the one that
 * is equal after NFC.
 */
export async function localSpelling(root: string, rel: string, listDir: ListDir = realListDir): Promise<string | null> {
  let dir = root;
  const found: string[] = [];
  for (const segment of rel.split("/")) {
    const entries = await listDir(dir);
    const nfc = segment.normalize("NFC");
    const hit = entries?.includes(segment) ? segment : entries?.find((e) => e.normalize("NFC") === nfc);
    if (hit === undefined) return null;
    found.push(hit);
    dir = path.join(dir, hit);
  }
  return found.join("/");
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
): Promise<{ dataFiles: string[]; shared: string[]; refused: string[] }> {
  const markdown = await read(path.join(root, pageRelPath));
  if (markdown === null) return { dataFiles: [], shared: [], refused: [] };
  const candidates: string[] = [];
  const refused: string[] = [];
  for (const rel of pageDataFileRelPaths(pageRelPath, markdown)) {
    const onDisk = await localSpelling(root, rel);
    if (onDisk === null || !(await resolveContainedFile(root, onDisk)).ok) continue;
    if (fellesObjectPathRefusal(rel) === null) candidates.push(rel);
    else refused.push(rel);
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
