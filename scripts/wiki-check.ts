#!/usr/bin/env bun
/**
 * The lint checks that read a page's own text, and for the component checks
 * the data files it names (`pageTextFiles`) (`checkPageText`,
 * `src/wiki/lint.ts`: index-truncation, nested-annotation, unrendered-fact-mark,
 * question-block, decision-first-sentence, status-row-long, status-tones,
 * status-tile-long, role-key,
 * case-board-labels, missing-tldr, tldr-no-more, the component checks, ledger-row-state,
 * chain-close-conflict and chart-table) over a page or a
 * directory, with no wiki index, no database and no `.env`. `roleKeys` comes
 * from the wiki root's `.wiki-reader.json`:
 *
 *   bun --no-env-file scripts/wiki-check.ts <absolute page or directory path>
 *
 * Prints one JSON line per finding (`{check, relPath, line, message, detail}`)
 * on stdout. A page must be an `.mdx` file and is checked as given. A directory
 * checks the `.mdx` pages under it that `lintWiki` checks: the store's own scan
 * of the wiki root (`.wiki-reader.json` `include`, no dot directories or
 * `node_modules`, a `blogs/src/` source dropped only when its compiled `.html`
 * sibling exists), minus a page a readable same-stem `.md` shadows. In a
 * directory, a culled page (`signal: none`) gets every check but the Tldr and
 * component checks, as in `lintWiki`. The wiki root is the nearest ancestor holding
 * `.wiki-reader.json`, else the given directory (or the page's own folder);
 * `relPath` is relative to it. With no `.wiki-reader.json`, the root is a guess,
 * so missing-tldr and tldr-no-more, which read the page's folder, are skipped
 * and one stderr line says so. A `<CaseBoard>` data file whose ref climbs
 * above the guessed root (`../data/c.yaml` from a page checked alone) reads
 * nothing, so check 15 cannot judge it; a second stderr line names each such
 * ref. Only a ref whose path climbs above the guessed root is named. A ref that
 * fails for any other reason is not named: a typo or a wrong extension, which
 * fails under the real root too, but also a ref through a symlink to a folder
 * outside the guessed root and inside the real one. The loader refuses that
 * ref on its realpath, so it reads nothing here and the real root may read it;
 * check 15 does not judge it and no line says so (a known gap).
 *
 * Exit codes: 0 when the check ran, with or without findings. 2 on a usage
 * error or a path that cannot be read or listed. 3 when a directory holds
 * `.mdx` pages to check and none of them could be read. An unreadable page in
 * a directory is one stderr line and is skipped; a directory with no page to
 * check is one stderr note.
 */

import path from "node:path";
import { existsSync, statSync } from "node:fs";
import { extRank, parseFrontmatter, readCull, readPlanStatus, readWikiReaderConfig, stemKey, wikiPageRelPaths, wikiPageStem } from "../src/wiki/store.ts";
import { checkPageText, pageTextFiles, type LintFinding } from "../src/wiki/lint.ts";
import type { LoadedPageFiles } from "../src/wiki/lint-components.ts";
import { pageFileRefKinds } from "../src/format/query-block.ts";
import { parseBlocks } from "../src/format/markdown-ast.ts";
import { resolveEmbedRelPath } from "../src/format/embed.ts";
import { splitFrontmatter } from "../src/wiki/page-text.ts";

const USAGE = "usage: bun --no-env-file scripts/wiki-check.ts <absolute .mdx page or directory path>";

/** Exit code when a directory has pages to check and none could be read. */
export const EXIT_NOTHING_READ = 3;

/** The nearest directory at or above `dir` holding `.wiki-reader.json`. */
export function wikiRootFor(dir: string): string | null {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, ".wiki-reader.json"))) return d;
    if (path.dirname(d) === d) return null;
  }
}

/**
 * The `.mdx` pages `buildWikiIndex` keeps under `dir`, relative to `root`,
 * sorted: its scan and pipeline-source drop, then its stem rule, under which a
 * `.md` anywhere in the wiki drops a same-stem `.mdx`. A `.md` the index could
 * not read is no page there, so it shadows nothing here either.
 */
export async function mdxPagesUnder(root: string, dir: string): Promise<string[]> {
  const all = await wikiPageRelPaths(root);
  const sub = path.relative(root, dir).split(path.sep).join("/");
  const prefix = sub === "" ? "" : `${sub}/`;
  const candidates = all.filter((p) => extRank(p) === 1 && p.startsWith(prefix));
  const wanted = new Set(candidates.map((p) => stemKey(wikiPageStem(p))));
  const mdStems = new Set<string>();
  for (const p of all) {
    const key = stemKey(wikiPageStem(p));
    if (extRank(p) !== 0 || mdStems.has(key) || !wanted.has(key)) continue;
    if (await Bun.file(path.join(root, p)).text().then(() => true, () => false)) mdStems.add(key);
  }
  return candidates.filter((p) => !mdStems.has(stemKey(wikiPageStem(p))));
}

/** A culled page, as the index reads it: frontmatter `signal: none`. */
const isCulled = (fm: Record<string, string | string[]>) => readCull(fm.signal, fm["signal-reason"]).culled === true;

export interface WikiCheckResult {
  findings: LintFinding[];
  /** Pages read and checked. */
  checked: number;
  /** Pages selected for the check. */
  selected: number;
  /** One line per page that could not be read. */
  unreadable: string[];
  /** The directory the root was guessed from, when no `.wiki-reader.json`
   *  names it; the folder checks were skipped. */
  guessedRoot?: string;
  /** With a guessed root: `<relPath>: <ref> (<reason>)` for each CaseBoard
   *  data file that read nothing because its ref climbs above that root. */
  unreadFiles?: string[];
}

/** The checks that read the page's folder under the wiki root (`isTldrScope`),
 *  so they need the root, not a guess. */
const FOLDER_CHECKS: ReadonlySet<string> = new Set(["missing-tldr", "tldr-no-more"]);

/** The stderr line for a run whose wiki root is a guess. */
export const noRootNote = (dir: string) =>
  `wiki-check: no .wiki-reader.json at or above ${dir}: missing-tldr and tldr-no-more need the wiki root and were skipped`;

/** The stderr line naming the CaseBoard data files above a guessed root. */
export const unreadFilesNote = (refs: readonly string[]) =>
  `wiki-check: CaseBoard data files above the guessed root were not read, so check 15 did not judge them: ${refs.join(", ")}`;

/** `<relPath>: <ref> (<reason>)` for each ref a `<CaseBoard>` names (the
 *  component whose data files check 15 judges) that read nothing because it
 *  climbs above the root (`resolveEmbedRelPath`, the loader's own rule). */
const unreadCaseFiles = (relPath: string, content: string, files: LoadedPageFiles): string[] => {
  const kinds = pageFileRefKinds(parseBlocks(splitFrontmatter(content).body));
  return [...files].flatMap(([ref, r]) =>
    r.ok || r.reason !== "unavailable" || !kinds.get(ref)?.has("yaml") || resolveEmbedRelPath(relPath, ref) !== null
      ? []
      : [`${relPath}: ${ref} (${r.reason})`],
  );
};

const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code ?? String(e);

/** The wiki's `roleKeys`, as `lintWiki` reads them; none without a reader config. */
const roleKeysAt = async (root: string) => (await readWikiReaderConfig(root))?.roleKeys ?? [];

/** The findings for an absolute `.mdx` page or directory path. Throws when the
 *  page, or the directory's listing, cannot be read. */
export async function wikiCheck(target: string): Promise<WikiCheckResult> {
  if (!statSync(target).isDirectory()) {
    const base = path.dirname(target);
    const found = wikiRootFor(base);
    const root = found ?? base;
    const rel = path.relative(root, target).split(path.sep).join("/");
    const content = await Bun.file(target).text();
    const plan_status = readPlanStatus(parseFrontmatter(content));
    const ref = { relPath: rel, plan_status };
    const files = await pageTextFiles(root, ref, content);
    const findings = checkPageText(ref, content, await roleKeysAt(root), files);
    if (found) return { findings, checked: 1, selected: 1, unreadable: [] };
    const unreadFiles = unreadCaseFiles(rel, content, files);
    return {
      findings: findings.filter((f) => !FOLDER_CHECKS.has(f.check)),
      checked: 1,
      selected: 1,
      unreadable: [],
      guessedRoot: base,
      ...(unreadFiles.length > 0 ? { unreadFiles } : {}),
    };
  }
  const found = wikiRootFor(target);
  const root = found ?? target;
  const roleKeys = await roleKeysAt(root);
  const pages = await mdxPagesUnder(root, target);
  const out: WikiCheckResult = { findings: [], checked: 0, selected: pages.length, unreadable: [], ...(found ? {} : { guessedRoot: target }) };
  for (const rel of pages) {
    const file = path.join(root, rel);
    let content: string;
    try {
      content = await Bun.file(file).text();
    } catch (e) {
      out.unreadable.push(`wiki-check: cannot read ${file}: ${errCode(e)}`);
      continue;
    }
    out.checked += 1;
    const fm = parseFrontmatter(content);
    const ref = { relPath: rel, culled: isCulled(fm), plan_status: readPlanStatus(fm) };
    const files = await pageTextFiles(root, ref, content);
    const findings = checkPageText(ref, content, roleKeys, files);
    if (found) {
      out.findings.push(...findings);
      continue;
    }
    out.findings.push(...findings.filter((f) => !FOLDER_CHECKS.has(f.check)));
    const unread = unreadCaseFiles(rel, content, files);
    if (unread.length > 0) (out.unreadFiles ??= []).push(...unread);
  }
  return out;
}

/** The exit code and the lines to print for one invocation. */
export async function runWikiCheck(args: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const target = args[0];
  if (args.length !== 1 || !target) return { code: 2, out: [], err: [USAGE] };
  if (!path.isAbsolute(target)) return { code: 2, out: [], err: [`wiki-check: the path must be absolute: ${target}`, USAGE] };
  let isDir: boolean;
  try {
    isDir = statSync(target).isDirectory();
  } catch (e) {
    return { code: 2, out: [], err: [`wiki-check: cannot read ${target}: ${errCode(e)}`] };
  }
  if (!isDir && !target.endsWith(".mdx")) return { code: 2, out: [], err: [`wiki-check: not an .mdx page: ${target}`, USAGE] };
  let result: WikiCheckResult;
  try {
    result = await wikiCheck(target);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { code: 2, out: [], err: [`wiki-check: cannot read ${err.path ?? target}: ${err.code ?? err.message}`] };
  }
  const out = result.findings.map((f) => JSON.stringify(f));
  if (result.selected === 0) return { code: 0, out, err: [`wiki-check: no .mdx pages under ${target}`] };
  const code = result.checked === 0 && result.unreadable.length === result.selected ? EXIT_NOTHING_READ : 0;
  const note = result.guessedRoot === undefined ? [] : [noRootNote(result.guessedRoot)];
  if (result.unreadFiles !== undefined) note.push(unreadFilesNote(result.unreadFiles));
  return { code, out, err: [...note, ...result.unreadable] };
}

if (import.meta.main) {
  const { code, out, err } = await runWikiCheck(process.argv.slice(2));
  for (const line of out) process.stdout.write(`${line}\n`);
  for (const line of err) process.stderr.write(`${line}\n`);
  process.exit(code);
}
