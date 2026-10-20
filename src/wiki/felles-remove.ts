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
 * script uploads. Two refs are left out:
 *  - one with no local file: publish uploaded nothing for it, and a delete of a
 *    missing object fails the whole run with exit 3;
 *  - one another local page also reads: removing this page must not take a
 *    file a page that stays published still shows. Returned as `shared`.
 */
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

const readText = async (abs: string): Promise<string | null> => {
  try {
    return await Bun.file(abs).text();
  } catch {
    return null;
  }
};

/**
 * The data files to delete with `pageRelPath`, and the ones kept because
 * another page in `pageRelPaths` (the local index) also reads them.
 */
export async function fellesRemoveDataFiles(
  root: string,
  pageRelPath: string,
  pageRelPaths: readonly string[],
  read: (abs: string) => Promise<string | null> = readText,
): Promise<{ dataFiles: string[]; shared: string[] }> {
  const markdown = await read(path.join(root, pageRelPath));
  if (markdown === null) return { dataFiles: [], shared: [] };
  const candidates: string[] = [];
  for (const rel of pageDataFileRelPaths(pageRelPath, markdown)) {
    if ((await resolveContainedFile(root, rel)).ok) candidates.push(rel);
  }
  if (candidates.length === 0) return { dataFiles: [], shared: [] };

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
  };
}
