/**
 * What a felles **Remove** deletes besides the page, and how a `--fjern` run's
 * output reads. The decision table these implement is in `src/wiki/CLAUDE.md`
 * (felles remove section); each cell has a test row.
 *
 * Target set: exactly the data files `publiser-felles-wiki.ts` uploads for the
 * page as it stands. The refs come from the reader's own rule
 * (`pageFileRefKinds`), resolved from the page's folder; then each spelling
 * gets publish's per-file checks ({@link publishDataFileCheck}: `relUnder`,
 * `lstat`, `sjekkSti`, the `O_NOFOLLOW` open, `isFile`, the 1 MiB cap) and
 * publish's in-run collision rule (small letters + NFC). Two spellings of one
 * NFC name are one object, uploaded when either passes. Not mirrored: the
 * scanner, the encoding check and collisions with other bucket objects — a
 * file they refused is targeted, and its delete answers «not in the bucket»,
 * which {@link fellesFjernVerdict} reads as success.
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync } from "node:fs";
import path from "node:path";
import { parseBlocks } from "../format/markdown-ast.ts";
import { resolveEmbedRelPath } from "../format/embed.ts";
import { checkPageFileRef, PAGE_FILE_COMPONENTS, pageFileRefKinds } from "../format/query-block.ts";
import { splitFrontmatter } from "./page-text.ts";

/** The data-file refs a page's markdown reads, resolved to wiki-relative
 *  paths in the page's own spelling, in source order, each spelling once. */
function pageDataFileSpellings(pageRelPath: string, markdown: string): string[] {
  if (!PAGE_FILE_COMPONENTS.some((c) => markdown.includes(`<${c}`))) return [];
  const out: string[] = [];
  for (const [ref, kinds] of pageFileRefKinds(parseBlocks(splitFrontmatter(markdown).body))) {
    if (checkPageFileRef(ref, kinds) !== "ok") continue;
    const rel = resolveEmbedRelPath(pageRelPath.replace(/\\/g, "/"), ref);
    if (rel !== null && !out.includes(rel)) out.push(rel);
  }
  return out;
}

/** The wiki-relative data files a page's markdown reads, NFC, in source order. */
export function pageDataFileRelPaths(pageRelPath: string, markdown: string): string[] {
  return [...new Set(pageDataFileSpellings(pageRelPath, markdown).map((r) => r.normalize("NFC")))];
}

/** The script's `MAKS_SEGMENT_BYTES`: the longest object-name segment it sends. */
export const FELLES_SEGMENT_MAX_BYTES = 211;
/** The script's `MAKS_DATA_BYTES`: publish refuses a larger data file. */
export const FELLES_DATA_MAX_BYTES = 1024 * 1024;
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

/** The filesystem calls publish's per-file decision makes, as a seam so tests
 *  can play macOS APFS (case- and normalization-insensitive) and Linux ext4. */
export interface FsProbe {
  /** `lstat`: what the path itself is, or null when it fails. */
  lstat(abs: string): "file" | "dir" | "symlink" | "other" | null;
  /** The script's `openSync(O_RDONLY | O_NOFOLLOW | O_NONBLOCK)` + `fstat`:
   *  the open's error code, or what the descriptor is. */
  open(abs: string): { error: string } | { isFile: boolean; size: number };
}

export const realFsProbe: FsProbe = {
  lstat(abs) {
    try {
      const st = lstatSync(abs);
      return st.isSymbolicLink() ? "symlink" : st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
    } catch {
      return null;
    }
  },
  open(abs) {
    let fd: number;
    try {
      fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (e) {
      return { error: (e as NodeJS.ErrnoException).code ?? "unknown" };
    }
    try {
      const st = fstatSync(fd);
      return { isFile: st.isFile(), size: st.size };
    } catch (e) {
      return { error: (e as NodeJS.ErrnoException).code ?? "unknown" };
    } finally {
      closeSync(fd);
    }
  },
};

/**
 * Publish's decision for one data-file spelling, before its collision rule:
 * - `missing`: `lstat` fails, so publish skips it without a verdict and it
 *   takes no part in the collision rule;
 * - `refused`: publish names it and refuses it (a symlinked folder, a path
 *   `sjekkSti` refuses, an open that fails, a non-file, over the cap) — it
 *   still takes part in the collision rule;
 * - `uploads`: publish uploads it unless the scanner or a collision refuses it.
 */
export function publishDataFileCheck(root: string, rel: string, probe: FsProbe = realFsProbe): "missing" | "refused" | "uploads" {
  const segments = rel.split("/");
  let dir = root;
  for (const segment of segments.slice(0, -1)) {
    dir = path.join(dir, segment);
    const kind = probe.lstat(dir);
    if (kind === null) break;
    if (kind === "symlink") return "refused";
  }
  const abs = path.join(root, ...segments);
  if (probe.lstat(abs) === null) return "missing";
  const nfc = rel.normalize("NFC");
  if (fellesObjectPathRefusal(rel) !== null || nfc.split("/").some((d) => d.startsWith("."))) return "refused";
  const opened = probe.open(abs);
  if ("error" in opened || !opened.isFile || opened.size > FELLES_DATA_MAX_BYTES) return "refused";
  return "uploads";
}

/** The script's `kollisjonsnøkkel`: the name the mirror compares on. */
const collisionKey = (name: string) => name.normalize("NFC").toLowerCase();

const readText = async (abs: string): Promise<string | null> => {
  try {
    return await Bun.file(abs).text();
  } catch {
    return null;
  }
};

/**
 * The data files to delete with `pageRelPath` (NFC object names): the ones
 * publish uploads for the page as it stands, minus the ones another page in
 * `pageRelPaths` (the local index) also reads (`shared`). `refused` lists the
 * names the script's `sjekkStiform` refuses — never uploaded, and one such
 * name in a `--fjern` argv makes it delete nothing.
 */
export async function fellesRemoveDataFiles(
  root: string,
  pageRelPath: string,
  pageRelPaths: readonly string[],
  read: (abs: string) => Promise<string | null> = readText,
  probe: FsProbe = realFsProbe,
): Promise<{ dataFiles: string[]; shared: string[]; refused: string[] }> {
  const markdown = await read(path.join(root, pageRelPath));
  if (markdown === null) return { dataFiles: [], shared: [], refused: [] };
  const page = pageRelPath.normalize("NFC");
  const named: { object: string; verdict: "refused" | "uploads" }[] = [];
  const refused: string[] = [];
  for (const spelling of pageDataFileSpellings(pageRelPath, markdown)) {
    const verdict = publishDataFileCheck(root, spelling, probe);
    if (verdict === "missing") continue;
    const object = spelling.normalize("NFC");
    named.push({ object, verdict });
    if (fellesObjectPathRefusal(object) !== null && !refused.includes(object)) refused.push(object);
  }
  // Publish's in-run collision rule: two DIFFERENT names with one key refuse
  // each other; two spellings of one NFC name are one object, not a collision.
  const namesPerKey = new Map<string, Set<string>>();
  for (const object of [page, ...named.map((n) => n.object)]) {
    const key = collisionKey(object);
    namesPerKey.set(key, (namesPerKey.get(key) ?? new Set()).add(object));
  }
  const candidates: string[] = [];
  for (const { object, verdict } of named) {
    if (verdict !== "uploads" || namesPerKey.get(collisionKey(object))!.size > 1) continue;
    if (!candidates.includes(object)) candidates.push(object);
  }
  if (candidates.length === 0) return { dataFiles: [], shared: [], refused };

  const others = new Set<string>();
  for (const other of pageRelPaths) {
    if (other.normalize("NFC") === page || !/\.mdx?$/i.test(other)) continue;
    const text = await read(path.join(root, other));
    if (text === null) continue;
    for (const rel of pageDataFileRelPaths(other, text)) others.add(rel);
  }
  return {
    dataFiles: candidates.filter((rel) => !others.has(rel)),
    shared: candidates.filter((rel) => others.has(rel)),
    refused,
  };
}

/**
 * What one `--fjern --ja` run did, read from its exit code and its lines:
 * - `deleted`: exit 0, every object deleted;
 * - `missing`: exit 3, and every failed object failed as «not in the bucket»
 *   — the rest were deleted, so nothing named is left;
 * - `failed`: exit 3 with any other failure, or lines that do not add up;
 * - `error`: any other exit code (1 a path refused or a crash, 2 usage or no gcloud);
 * - `timeout`: the run threw or did not return.
 *
 * «Not in the bucket» is gcloud's `The following URLs matched no objects or
 * files:` with the URL on the next line (gcloud 589 `name_expansion.py`). The
 * script prints only the last stderr line, masked the same way as its own
 * name, so the line reads `Feil: sletting av gs://B/X feilet (exit N): gs://B/X`
 * — the detail IS the URL. Any other detail, a masked one included, is `failed`.
 */
export type FellesFjernVerdict = "deleted" | "missing" | "failed" | "error" | "timeout";

export function fellesFjernVerdict(
  run: { exitCode: number; stdout: string; stderr: string } | null,
  targets: number,
): FellesFjernVerdict {
  if (run === null) return "timeout";
  if (run.exitCode === 0) return "deleted";
  if (run.exitCode !== 3) return "error";
  const summary = /^Oppsummering: (\d+) slettet, (\d+) feilet\./m.exec(run.stdout);
  if (!summary) return "failed";
  const deleted = Number(summary[1]);
  const failed = Number(summary[2]);
  const failures = run.stderr.split("\n").filter((l) => l.startsWith(FAILURE_PREFIX));
  if (failed === 0 || deleted + failed !== targets || failures.length !== failed) return "failed";
  return failures.every(isNotInBucketLine) ? "missing" : "failed";
}

const FAILURE_PREFIX = "Feil: sletting av ";
const FAILURE_MID = " feilet (exit ";

/** `Feil: sletting av <url> feilet (exit N): <url>`, the same `<url>` twice. */
function isNotInBucketLine(line: string): boolean {
  const rest = line.slice(FAILURE_PREFIX.length);
  for (let i = rest.indexOf(FAILURE_MID); i > 0; i = rest.indexOf(FAILURE_MID, i + 1)) {
    const url = rest.slice(0, i);
    const tail = /^\d+\): (.*)$/.exec(rest.slice(i + FAILURE_MID.length));
    if (url.startsWith("gs://") && tail && tail[1] === url) return true;
  }
  return false;
}
