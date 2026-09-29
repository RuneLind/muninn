/**
 * The pure half of `scripts/backfill-youtube-authors.ts` — the one-off that
 * adds oEmbed's `author` to YouTube summaries captured before the capture
 * started sending it. Everything here is a function of its arguments, so the
 * rules the backfill rests on are unit-tested rather than trusted:
 *
 *   1. skip-if-present — a file whose frontmatter already carries `author` is
 *      never rewritten (a capture since the deploy, or the pilot's own writes);
 *   2. the insert — one `author:` line, encoded like huginn's
 *      `frontmatter_scalar`, in huginn's own key position, body untouched;
 *   3. stamp ordering — increasing mtimes 1 ms apart, in original-mtime order,
 *      ending at or before the moment of writing;
 *   4. the rollback predicate — CONTENT identity: restore a file only when its
 *      current bytes are exactly what the backfill produced from its pre-write
 *      bytes, so any later capture or re-run survives, whatever its mtime;
 *   5. the journal — every run's plan is on disk before its first write, and
 *      each file's outcome is appended as it happens.
 */
import { capFrontmatterAuthor } from "../youtube/metadata.ts";
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
 * file has no frontmatter block, already names an author (skip-if-present), or
 * the name is blank or over huginn's 512-byte field cap (omitted, never cut).
 * Every byte outside the inserted line is kept, the body included.
 */
export function insertFrontmatterAuthor(text: string, author: string): string | null {
  if (!needsAuthor(text)) return null;
  const clean = capFrontmatterAuthor(author);
  if (clean === undefined) return null;
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

/**
 * The one spelling every path is compared in. macOS tools disagree about
 * Unicode normalization — bsdtar hands back NFD names, huginn writes NFC — and
 * APFS opens either, so a map keyed on the raw name misses silently.
 */
export function nfcPath(path: string): string {
  return path.normalize("NFC").replace(/^\.\//, "");
}

/** One file as the write step sees it. */
export interface BackfillFile {
  /** Path relative to the tree root, NFC — huginn's doc id. */
  readonly path: string;
  /** The mtime that decides the file's place: its pre-backfill one. */
  readonly originalMtimeMs: number;
  /** The file's own name, the tie-break (`Title.md`). */
  readonly title: string;
  /** True when this run changes the file's bytes; false for an mtime-only re-stamp. */
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
 * Which files a run touches, in order. Shared by the write and the rollback.
 *
 * `candidates` are the files whose bytes this run changes; `limit` keeps the
 * NEWEST `limit` of them (the pilot), so the re-stamp tail behind it stays
 * short. The sequence is then every file — changed or not — whose original
 * mtime is at or after the oldest changed one: re-stamping only the changed
 * files would lift them above every newer file left alone (the pilot's 20, a
 * capture since the deploy), and the relative order is what the stamps keep.
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

// ---------------------------------------------------------------------------
// The journal — `journal.jsonl` in the state dir
// ---------------------------------------------------------------------------

/**
 * One line of the journal. A run appends its `run` line and EVERY `plan` line
 * in one write before it touches a file, then one `done` line per file as it
 * goes, then `end`. A run killed at any point (Bun skips `finally` on SIGTERM,
 * measured) therefore leaves its whole plan on disk; a `plan` with no `done`
 * is pending, and the rollback decides it by content, not by status.
 */
export type JournalEvent =
  | { t: "run"; run: number; kind: "write" | "rollback"; at: string; root: string; tarball?: string }
  | {
      t: "plan";
      run: number;
      path: string;
      originalMtimeMs: number;
      stampMs: number;
      write: boolean;
      /** The name a write run inserts; absent on a re-stamp and on rollback lines. */
      author?: string;
    }
  | { t: "done"; run: number; path: string; status: "written" | "restamped" | "restored" | "skipped"; reason?: string }
  | { t: "end"; run: number };

export type PlanEvent = Extract<JournalEvent, { t: "plan" }>;
export type DoneEvent = Extract<JournalEvent, { t: "done" }>;

export interface JournalRun {
  run: number;
  kind: "write" | "rollback";
  at: string;
  root: string;
  tarball?: string;
  plans: Map<string, PlanEvent>;
  done: Map<string, DoneEvent>;
  ended: boolean;
}

/** The journal's runs, in order. Unparseable lines (a torn last append) are counted, not fatal. */
export function parseJournal(text: string): { runs: JournalRun[]; badLines: number } {
  const byId = new Map<number, JournalRun>();
  let badLines = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev: JournalEvent;
    try {
      ev = JSON.parse(line) as JournalEvent;
    } catch {
      badLines++;
      continue;
    }
    if (ev.t === "run") {
      byId.set(ev.run, { ...ev, plans: new Map(), done: new Map(), ended: false });
      continue;
    }
    const run = byId.get(ev.run);
    if (!run) {
      badLines++;
      continue;
    }
    if (ev.t === "plan") run.plans.set(ev.path, ev);
    else if (ev.t === "done") run.done.set(ev.path, ev);
    else if (ev.t === "end") run.ended = true;
  }
  return { runs: [...byId.values()].sort((a, b) => a.run - b.run), badLines };
}

/**
 * Per path, every stamp ANY run planned for it (write or rollback), mapped to
 * the file's pre-backfill mtime. A file still carrying one of those stamps
 * keeps the place it had before the backfill touched it; a pending plan whose
 * stamp never landed matches nothing, so the file's own mtime stands.
 */
export function originalMtimeIndex(runs: readonly JournalRun[]): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (const run of runs) {
    for (const p of run.plans.values()) {
      if (!out.has(p.path)) out.set(p.path, new Map());
      out.get(p.path)!.set(p.stampMs, p.originalMtimeMs);
    }
  }
  return out;
}

/** The order key for a file now at `mtimeMs`: its pre-backfill mtime when the mtime is one of our stamps. */
export function originalMtimeFor(
  index: ReadonlyMap<string, ReadonlyMap<number, number>>,
  path: string,
  mtimeMs: number,
): number {
  return index.get(path)?.get(Math.round(mtimeMs)) ?? mtimeMs;
}

export interface LastWrite {
  run: number;
  /** The tarball taken just before that run wrote anything: this file's pre-write bytes. */
  tarball: string;
  author: string;
  originalMtimeMs: number;
}

/**
 * Per path, the LAST write run that planned to insert `author` — pending,
 * skipped or done alike. A later write run plans a path only when it lacked
 * `author` at that moment, so any earlier write is no longer on disk and the
 * last plan is the one whose output the file may still hold.
 */
export function lastWrites(runs: readonly JournalRun[]): Map<string, LastWrite> {
  const out = new Map<string, LastWrite>();
  for (const run of runs) {
    if (run.kind !== "write" || run.tarball === undefined) continue;
    for (const p of run.plans.values()) {
      if (!p.write || p.author === undefined) continue;
      out.set(p.path, { run: run.run, tarball: run.tarball, author: p.author, originalMtimeMs: p.originalMtimeMs });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The rollback predicate
// ---------------------------------------------------------------------------

export type NotRestoredReason = "missing" | "not in snapshot" | "unchanged from snapshot" | "changed since" | "snapshot not writable";

export type RollbackDisposition = { restore: true } | { restore: false; reason: NotRestoredReason };

/**
 * Whether a file the backfill planned to write is restored, decided by
 * CONTENT: its current bytes must equal exactly what the write produced from
 * its pre-write bytes (the snapshot plus the one inserted `author:` line). An
 * mtime says nothing reliable here — a later run re-stamps files without
 * changing them — while a capture or re-run since changes the bytes, so it
 * survives. A file deleted since is not resurrected.
 */
export function rollbackDisposition(input: {
  current: Uint8Array | null;
  preWrite: Uint8Array | null;
  author: string;
}): RollbackDisposition {
  if (input.preWrite === null) return { restore: false, reason: "not in snapshot" };
  if (input.current === null) return { restore: false, reason: "missing" };
  const current = Buffer.from(input.current);
  if (current.equals(Buffer.from(input.preWrite))) return { restore: false, reason: "unchanged from snapshot" };
  const produced = insertFrontmatterAuthor(new TextDecoder().decode(input.preWrite), input.author);
  if (produced === null) return { restore: false, reason: "snapshot not writable" };
  return current.equals(Buffer.from(produced, "utf8")) ? { restore: true } : { restore: false, reason: "changed since" };
}

// ---------------------------------------------------------------------------
// The oEmbed abort rule
// ---------------------------------------------------------------------------

/**
 * The dry run's abort rule: 5 consecutive failures that say nothing about the
 * video. An `unavailable` answer (400/401/403/404) is an ANSWER, so it resets
 * the streak the way an author does — the service is up.
 */
export const OEMBED_ABORT_STREAK = 5;

export function nextFailureStreak(
  streak: number,
  result: { kind: "ok" } | { kind: "unavailable" } | { kind: "error" },
): number {
  if (result.kind === "error") return streak + 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Title review — legacy documents whose `url` names another video
// ---------------------------------------------------------------------------

const TITLE_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "you", "your",
  "how", "what", "why", "this", "that", "it", "its", "at", "by", "from", "be", "i", "my", "we", "do",
]);

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 1 && !TITLE_STOPWORDS.has(t)),
  );
}

/**
 * How much the document's title and oEmbed's title share: the overlap
 * coefficient of their content-word sets, |A∩B| / min(|A|,|B|), 0–1. `null`
 * when either side has no content word. The min keeps a truncated file name,
 * or a title with a channel suffix, from reading as a mismatch.
 */
export function titleSimilarity(docTitle: string, oembedTitle: string): number | null {
  const a = titleTokens(docTitle);
  const b = titleTokens(oembedTitle);
  if (a.size === 0 || b.size === 0) return null;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / Math.min(a.size, b.size);
}

/** Below this the dry run lists a document for review. The spread it was picked from is in PR #614. */
export const TITLE_REVIEW_THRESHOLD = 0.25;

/** `--exclude <file>`: one relative path per line; blank lines and `#` comments ignored. */
export function parseExcludeList(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    out.add(nfcPath(line));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export interface BackfillArgs {
  mode: "dry-run" | "write" | "rollback";
  root?: string;
  stateDir?: string;
  huginn?: string;
  collection?: string;
  limit?: number;
  exclude?: string;
  noUpdate: boolean;
}

const VALUE_FLAGS = new Set(["--root", "--state-dir", "--huginn", "--collection", "--limit", "--exclude"]);
const BOOLEAN_FLAGS = new Set(["--dry-run", "--rollback", "--no-update"]);

/**
 * Strict: an unknown flag, a stray word, a repeated flag or a value flag with
 * no value is an error — each of them used to fall through to the FULL write
 * (`--rollback` with no path, `--limit` with no number, `--dryrun`).
 */
export function parseBackfillArgs(
  argv: readonly string[],
): { ok: true; args: BackfillArgs } | { ok: false; error: string } {
  const seen = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (seen.has(a)) return { ok: false, error: `${a} given twice` };
    if (BOOLEAN_FLAGS.has(a)) {
      seen.add(a);
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--") || v.trim() === "") return { ok: false, error: `${a} needs a value` };
      seen.add(a);
      values.set(a, v);
      i++;
      continue;
    }
    return { ok: false, error: a.startsWith("-") ? `unknown flag ${a}` : `unexpected argument ${a}` };
  }
  if (seen.has("--rollback") && seen.has("--dry-run")) return { ok: false, error: "--rollback and --dry-run are exclusive" };
  if (seen.has("--rollback") && (seen.has("--limit") || seen.has("--exclude"))) {
    return { ok: false, error: "--rollback takes no --limit or --exclude: it restores every file the backfill wrote" };
  }
  if (seen.has("--dry-run") && seen.has("--limit")) return { ok: false, error: "--limit applies to a write, not --dry-run" };
  let limit: number | undefined;
  if (values.has("--limit")) {
    const raw = values.get("--limit")!;
    limit = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(limit) || limit < 1) return { ok: false, error: `--limit must be a positive integer, got ${raw}` };
  }
  return {
    ok: true,
    args: {
      mode: seen.has("--rollback") ? "rollback" : seen.has("--dry-run") ? "dry-run" : "write",
      root: values.get("--root"),
      stateDir: values.get("--state-dir"),
      huginn: values.get("--huginn"),
      collection: values.get("--collection"),
      limit,
      exclude: values.get("--exclude"),
      noUpdate: seen.has("--no-update"),
    },
  };
}
