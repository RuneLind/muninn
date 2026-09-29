/**
 * The pure half of `scripts/backfill-youtube-authors.ts` — the one-off that
 * adds oEmbed's `author` to YouTube summaries captured before the capture
 * started sending it. Everything here is a function of its arguments, so the
 * four rules the backfill rests on are unit-tested rather than trusted:
 *
 *   1. skip-if-present — a file whose frontmatter already carries `author` is
 *      never rewritten (a capture since the deploy, or the pilot's own writes);
 *   2. the insert — one `author:` line, encoded like huginn's
 *      `frontmatter_scalar`, in huginn's own key position, body untouched;
 *   3. stamp ordering — increasing mtimes 1 ms apart, in original-mtime order,
 *      ending at or before the moment of writing;
 *   4. the rollback filter — restore only files whose CURRENT mtime is a stamp
 *      this backfill wrote on that same file, so a later re-run survives.
 */
import { encodeFrontmatterScalar, parseCaptureFrontmatter } from "./transcript-split.ts";

/**
 * Keys huginn's `ingest_youtube` writes AFTER `author` (and `category`/`tags`
 * after every extra), so the inserted line lands where a fresh capture puts it:
 * `date, url, summary_kind, author, upload_date, duration_sec, category, tags`.
 */
const KEYS_AFTER_AUTHOR = new Set(["upload_date", "duration_sec", "category", "tags"]);

/** Whether the backfill may write this file at all: a frontmatter block with no `author`. */
export function needsAuthor(text: string): boolean {
  const fm = parseCaptureFrontmatter(text);
  return fm.present && !("author" in fm.byKey);
}

/**
 * `text` with one `author:` line added to its frontmatter, or `null` when the
 * file has no frontmatter block or already names an author (skip-if-present).
 * Every byte outside the inserted line is kept, the body included.
 */
export function insertFrontmatterAuthor(text: string, author: string): string | null {
  if (!needsAuthor(text)) return null;
  const clean = author.trim();
  if (!clean) return null;
  const lines = text.split("\n");
  // The closing fence — `parseCaptureFrontmatter` said there is one.
  let end = 1;
  while (end < lines.length && lines[end] !== "---") end++;
  let at = end;
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z_][\w-]*):/.exec(lines[i]!);
    if (m && KEYS_AFTER_AUTHOR.has(m[1]!)) {
      at = i;
      break;
    }
  }
  lines.splice(at, 0, `author: ${encodeFrontmatterScalar(clean)}`);
  return lines.join("\n");
}

/** One file as the write step sees it. */
export interface BackfillFile {
  /** Path relative to the tree root — huginn's doc id. */
  readonly path: string;
  /** The mtime that decides the file's place: its pre-backfill one. */
  readonly originalMtimeMs: number;
  /** The file's own name, the tie-break (`Title.md`). */
  readonly title: string;
  /** True when this run adds `author`; false for an mtime-only re-stamp. */
  readonly write: boolean;
}

export interface PlannedStamp extends BackfillFile {
  /** The integer-ms mtime this file is given. */
  readonly stampMs: number;
}

/** Ascending original mtime, ties by title, then by path so the order is total. */
export function compareByOriginalOrder(
  a: Pick<BackfillFile, "originalMtimeMs" | "title" | "path">,
  b: Pick<BackfillFile, "originalMtimeMs" | "title" | "path">,
): number {
  if (a.originalMtimeMs !== b.originalMtimeMs) return a.originalMtimeMs - b.originalMtimeMs;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Which files a run touches, in order.
 *
 * `candidates` are the files that lack `author` and have a cached answer;
 * `limit` keeps the NEWEST `limit` of them (the pilot), so the re-stamp tail
 * behind it stays short. The sequence is then every file — written or not —
 * whose original mtime is at or after the oldest written one: re-stamping
 * only the written files would lift them above every newer file left alone
 * (the pilot's 20, a capture since the deploy), and the relative order is what
 * the stamps exist to keep.
 */
export function planSequence(
  all: readonly Omit<BackfillFile, "write">[],
  candidates: ReadonlySet<string>,
  limit?: number,
): BackfillFile[] {
  const sorted = [...all].sort(compareByOriginalOrder);
  let chosen = sorted.filter((f) => candidates.has(f.path));
  if (limit !== undefined && limit >= 0) chosen = chosen.slice(Math.max(0, chosen.length - limit));
  if (chosen.length === 0) return [];
  const writeSet = new Set(chosen.map((f) => f.path));
  const first = sorted.indexOf(chosen[0]!);
  return sorted.slice(first).map((f) => ({ ...f, write: writeSet.has(f.path) }));
}

/**
 * Stamps for an ordered sequence: strictly increasing, 1 ms apart, the last one
 * exactly `nowMs` (floored), so no stamp is later than the moment of writing and
 * huginn's `/update` — which reads files newer than its last indexed mtime
 * minus a day — reads every one of them.
 */
export function assignStamps(sequence: readonly BackfillFile[], nowMs: number): PlannedStamp[] {
  const end = Math.floor(nowMs);
  const n = sequence.length;
  return sequence.map((f, i) => ({ ...f, stampMs: end - (n - 1 - i) }));
}

/**
 * A file's mtime in ms at MICROSECOND precision, from `statSync(p, { bigint: true }).mtimeNs`.
 * Bun's plain `mtimeMs` truncates to whole ms, and a stamp set through
 * `utimesSync` lands a fraction of a µs UNDER the integer (measured: stamp
 * …540 read back as …540999889 ns, `mtimeMs` 540 — the wrong stamp), and it
 * collapses files written <1 ms apart into ties the title then reorders.
 */
export function mtimeMsFromNs(mtimeNs: bigint): number {
  return Number(mtimeNs / 1000n) / 1000;
}

/** A read-back mtime equals an integer stamp — the filesystem stores ns, so compare rounded. */
export function mtimeIsStamp(mtimeMs: number, stamps: ReadonlySet<number> | undefined): boolean {
  return stamps !== undefined && stamps.has(Math.round(mtimeMs));
}

/**
 * The rollback filter: of the files the tarball holds, the ones whose current
 * mtime is a stamp the backfill wrote on THAT file. A file changed since (a
 * re-run, a fresh capture) has an mtime no backfill stamp can equal — the
 * stamps all precede the backfill's end, and any later write is later — so it
 * survives. A file deleted since is not resurrected.
 */
export function rollbackTargets(input: {
  tarballMembers: readonly string[];
  currentMtimeMs: ReadonlyMap<string, number>;
  stampsByPath: ReadonlyMap<string, ReadonlySet<number>>;
}): string[] {
  const out: string[] = [];
  for (const path of input.tarballMembers) {
    const mtime = input.currentMtimeMs.get(path);
    if (mtime === undefined) continue;
    if (mtimeIsStamp(mtime, input.stampsByPath.get(path))) out.push(path);
  }
  return out.sort();
}

/**
 * The dry run's abort rule: 5 consecutive failures that say nothing about the
 * video. A 401/404 is an ANSWER (private or deleted), so it resets the streak
 * the way an author does — the service is up.
 */
export const OEMBED_ABORT_STREAK = 5;

export function nextFailureStreak(
  streak: number,
  result: { kind: "ok" } | { kind: "unavailable" } | { kind: "error" },
): number {
  if (result.kind === "error") return streak + 1;
  return 0;
}
