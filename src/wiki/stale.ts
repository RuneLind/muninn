/**
 * The Stale check's free half (plan muninn-wiki-drift-check, PR 1): what a
 * page change may have made untrue elsewhere, found with no model call and no
 * DB.
 *
 * - **Status-line hits** — on a living page, a status word written after a
 *   `[[link]]` to a plan that disagrees with that plan's `plan_status` today.
 *   Split in two so the index build can run the expensive half on few pages:
 *   {@link statusLineCandidates} reads one page's text (the prefilter, then
 *   check 14's masks on the matching pages only) and
 *   {@link resolveStatusLineHits} compares each candidate with its target
 *   once the whole index is resolved. Lint check 24 (`status-line`) and the
 *   index both call these two.
 * - **Linking-page buckets** — per linking page of a CHANGED page: History,
 *   Changed since, Pointers, To check, Mentions ({@link linkingBuckets}).
 *   Computed on request and cached per index, never in the build.
 * - **Moved with** — pages committed together with this one in non-sweep
 *   commits over 28 days, from the index's one git walk ({@link movedWith}).
 *
 * Rules and their measurements: `src/wiki/CLAUDE.md`, «Stale check».
 */
import path from "node:path";
import { maskLineCodeSpans } from "../format/code-spans.ts";
import { isReservedBasename } from "./frontmatter-lists.ts";
import { stateExemptLines } from "./lint-state.ts";
import { normalizeRelPath } from "./rel-path.ts";
import { WIKILINK_RE } from "./wikilinks.ts";
import type { PlanStatus, WikiIndex, WikiPageMeta } from "./store.ts";
import type { LintFinding } from "./lint.ts";

export const STALE_LINT_CHECKS = ["status-line"] as const;

const DAY_MS = 86_400_000;
/** A page whose last change is this close to «now» is a changed page. */
export const CHANGED_WINDOW_MS = 14 * DAY_MS;
/** A linking page is «older» when it last changed more than this before the changed page. */
export const OLDER_MARGIN_MS = 2 * DAY_MS;
/** *Moved with*'s window. */
export const MOVED_WITH_WINDOW_MS = 28 * DAY_MS;
/** At most this many *Moved with* rows per page. */
export const MOVED_WITH_MAX = 10;

export type StatusKind = "proposed" | "in-flight" | "shipped" | "blocked";

/** Edges that work on `æøå`: JS `\b` treats them as non-word characters. */
const L = "(?<![\\p{L}\\p{N}_])";
const R = "(?![\\p{L}\\p{N}_])";
const words = (xs: string) => new RegExp(`${L}(?:${xs})${R}`, "iu");

/**
 * The status words (D18): the measured union of English and Norwegian, read on
 * every wiki whatever its `language`. `merget`/`merged` count as shipped
 * unless `ikke`/`not` stands right before them, which is in-flight.
 */
export const STATUS_WORDS: readonly (readonly [StatusKind, RegExp])[] = [
  ["proposed", words("proposed|forslag|foreslått|utkast|draft")],
  ["in-flight", words("in[- ]flight|pågår|i gang|påbegynt|under arbeid|ikke merget|not merged|open PR|åpen PR")],
  ["shipped", new RegExp(`${L}(?:shipped|levert|landet|ferdig|done)${R}|(?<!(?:ikke|not)\\s)${L}(?:merget|merged)${R}`, "iu")],
  ["blocked", words("blocked|blokkert")],
];
/** The prefilter: a plain, edge-free alternation over every status word's
 *  stem — a superset of {@link STATUS_WORDS}, and ~8× cheaper per line than
 *  the edged `u` regexes, which measured 12 ms over mimir's 282 link lines. */
const STATUS_PROBE = /proposed|forslag|foreslått|utkast|draft|flight|pågår|i gang|påbegynt|under arbeid|merget|merged|open pr|åpen pr|shipped|levert|landet|ferdig|done|blocked|blokkert/i;

/** The status words a text names, in {@link STATUS_WORDS} order. */
export function statusWordsIn(text: string): StatusKind[] {
  return STATUS_WORDS.filter(([, re]) => re.test(text)).map(([k]) => k);
}

const CLOSED_STATUSES: readonly string[] = ["shipped", "superseded", "abandoned"];
/** Page types that record a moment rather than state the present (D4). */
const HISTORY_TYPES: readonly string[] = ["archive", "report", "blog", "review", "handoff", "source"];

type PageFacts = Pick<WikiPageMeta, "relPath" | "type" | "plan_status" | "culled">;

const historyPath = (relPath: string) => relPath.startsWith("archive/") || relPath.startsWith("blogs/");

/** History (D4): an archive or blog path, a history type, or a closed plan. */
export function isHistoryPage(p: PageFacts): boolean {
  return historyPath(p.relPath) || HISTORY_TYPES.includes(p.type) || (p.plan_status !== undefined && CLOSED_STATUSES.includes(p.plan_status));
}

/** A page whose status lines must stay current: not history, not a reserved
 *  page (`index`/`log`/`CLAUDE`), not culled, not an explainer. */
export function isLivingPage(p: PageFacts): boolean {
  return p.type !== "explainer" && !p.culled && !isReservedBasename(p.relPath) && !isHistoryPage(p);
}

/** One `[[link]] … status word` segment on a page, before its target is known. */
export interface StatusLineCandidate {
  /** 1-based line. */
  line: number;
  /** The wikilink target as written, anchor and escapes dropped. */
  target: string;
  said: StatusKind[];
  /** The source line, trimmed and capped. */
  text: string;
}

const TEXT_CAP = 360;
const blank = (s: string) => " ".repeat(s.length);
/** Frontmatter keys this check skips by its own choice. */
const SKIPPED_FM_KEY = /^(status_note|description|title):/;

/** The `[[link]] … status word` segments of one line (1-based `line`). */
function lineSegments(lineText: string, line: number, sourceText: string): StatusLineCandidate[] {
  const out: StatusLineCandidate[] = [];
  const links = [...lineText.matchAll(WIKILINK_RE)];
  links.forEach((m, j) => {
    const end = j + 1 < links.length ? links[j + 1]!.index! : lineText.length;
    const seg = lineText.slice(m.index! + m[0].length, end);
    if (seg.includes("](")) return;
    const said = statusWordsIn(seg);
    if (said.length === 0) return;
    let target = m[1]!.replace(/\\/g, "").trim();
    const hash = target.indexOf("#");
    if (hash === 0) return;
    if (hash > 0) target = target.slice(0, hash).trim();
    if (target) out.push({ line, target, said, text: sourceText.trim().slice(0, TEXT_CAP) });
  });
  return out;
}

/**
 * Phase A, one page's text: every segment from a `[[link]]` to the next
 * wikilink on its line that names a status word. The prefilter runs on the
 * raw lines first — a `[[` and a status word on one line, then a segment that
 * holds one — so check 14's masks, a full `parseBlocks`, are paid only on a
 * page that has such a segment (15 of mimir's 114 living pages). Masking only
 * removes text, so a line with no raw segment has none masked either.
 *
 * Exempt: check 14's masks ({@link stateExemptLines}) and inline code; by this
 * check's choice, strikethrough spans, the frontmatter `status_note`,
 * `description` and `title` (with their continuation lines), and a segment
 * that holds a markdown link.
 */
export function statusLineCandidates(content: string): StatusLineCandidate[] {
  if (!content.includes("[[")) return [];
  const raw = content.replace(/\r\n/g, "\n").split("\n");
  const probe: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i]!;
    if (l.includes("[[") && STATUS_PROBE.test(l) && lineSegments(l, i + 1, l).length) probe.push(i);
  }
  if (probe.length === 0) return [];

  const { lines, body, exempt } = stateExemptLines(content);
  for (let i = 1; i < body - 1; i++) {
    if (!SKIPPED_FM_KEY.test(lines[i]!)) continue;
    exempt.add(i);
    for (let k = i + 1; k < body - 1 && (lines[k]!.trim() === "" || /^\s/.test(lines[k]!)); k++) exempt.add(k);
  }

  const out: StatusLineCandidate[] = [];
  for (const i of probe) {
    if (exempt.has(i)) continue;
    // Code spans become `\n`, which no wikilink crosses; strikethrough blanks.
    const masked = maskLineCodeSpans(lines[i]!).replace(/~~[^~\n]*?~~/g, blank);
    out.push(...lineSegments(masked, i + 1, lines[i]!));
  }
  return out;
}

/** A status line that disagrees with its target's `plan_status` today. */
export interface StatusLineHit {
  line: number;
  /** The target plan's relPath. */
  target: string;
  said: StatusKind[];
  /** The target's `plan_status` as the index keeps it. */
  now: PlanStatus;
  text: string;
}

/** `plan_status` as a status word reads it: ready is proposed; superseded and
 *  abandoned have no word, so a link to them is skipped. */
function statusKindOf(s: PlanStatus): StatusKind | null {
  if (s === "ready" || s === "proposed") return "proposed";
  if (s === "superseded" || s === "abandoned") return null;
  return s;
}

/**
 * Phase B: the candidates whose target has a `plan_status` that none of the
 * segment's status words names. A segment that also names the current status
 * passes. One hit per (line, target).
 */
export function resolveStatusLineHits(
  selfRelPath: string,
  candidates: readonly StatusLineCandidate[],
  resolve: (target: string) => Pick<WikiPageMeta, "relPath" | "plan_status"> | undefined,
): StatusLineHit[] {
  const out: StatusLineHit[] = [];
  const seen = new Set<string>();
  const self = normalizeRelPath(selfRelPath);
  for (const c of candidates) {
    const t = resolve(c.target);
    if (!t?.plan_status || normalizeRelPath(t.relPath) === self) continue;
    const now = statusKindOf(t.plan_status);
    if (now === null || c.said.includes(now)) continue;
    const key = `${c.line}\0${t.relPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line: c.line, target: t.relPath, said: c.said, now: t.plan_status, text: c.text });
  }
  return out;
}

/** The hits on one page, both phases — what lint check 24 calls. */
export function pageStatusLineHits(
  page: PageFacts,
  content: string,
  resolve: (target: string) => Pick<WikiPageMeta, "relPath" | "plan_status"> | undefined,
): StatusLineHit[] {
  if (!isLivingPage(page)) return [];
  return resolveStatusLineHits(page.relPath, statusLineCandidates(content), resolve);
}

/** Lint check 24: one info finding per hit (D27 — `lintWiki` reads no
 *  verdicts, so a not-a-status hit must never reach the weekly alert). */
export function checkStatusLines(page: PageFacts, content: string, index: Pick<WikiIndex, "resolve">): LintFinding[] {
  return pageStatusLineHits(page, content, index.resolve).map((h) => ({
    check: "status-line" as const,
    relPath: page.relPath,
    line: h.line,
    severity: "info" as const,
    message: `${h.said.map((s) => `«${s}»`).join(", ")} after [[${h.target}]], whose plan_status is ${h.now} — update the line or point at the plan's status`,
  }));
}

// ── Last change (D29) ──────────────────────────────────────────────────────

type ChangeFacts = Pick<WikiPageMeta, "relPath" | "workedMs" | "gitTouchedMs" | "gitDirty" | "mtimeMs">;

/**
 * A page's last change: the newest of its worked write (`workedMs`), its
 * newest non-sweep commit (`gitTouchedMs`, metadata-only commits already set
 * aside by `git-dates.ts`) and, while it has uncommitted edits (`gitDirty`,
 * metadata-only edits already dropped), its `mtimeMs`. With `asOfMs`, only
 * signals at or before it count; a newer commit falls back to the newest
 * touch at or before it (`touchTimes`, ascending). Undefined when no signal
 * qualifies.
 */
export function pageLastChangeMs(p: ChangeFacts, asOfMs?: number, touchTimes?: readonly number[]): number | undefined {
  const ok = (ms: number | undefined) => (ms !== undefined && (asOfMs === undefined || ms <= asOfMs) ? ms : undefined);
  let git = ok(p.gitTouchedMs);
  if (git === undefined && p.gitTouchedMs !== undefined && asOfMs !== undefined && touchTimes) {
    for (const t of touchTimes) if (t <= asOfMs) git = t;
  }
  const xs = [ok(p.workedMs), git, p.gitDirty ? ok(p.mtimeMs) : undefined].filter((x): x is number => x !== undefined);
  return xs.length ? Math.max(...xs) : undefined;
}

/** The instant the stale rules read as «now»: `asOfMs`, else the index's own
 *  build time, so one index answers one way (and its cache holds). */
export const staleNow = (index: Pick<WikiIndex, "scannedAt">, asOfMs?: number): number => asOfMs ?? index.scannedAt;

function lastChangeIn(index: WikiIndex, p: WikiPageMeta, asOfMs?: number): number | undefined {
  const touches = index.gitTouches?.get(p.relPath)?.map((t) => t.ts);
  return pageLastChangeMs(p, asOfMs, touches);
}

/** Whether a page is a changed page as of `nowMs`. */
export function isChangedPage(lastChangeMs: number | undefined, nowMs: number): lastChangeMs is number {
  return lastChangeMs !== undefined && lastChangeMs <= nowMs && nowMs - lastChangeMs <= CHANGED_WINDOW_MS;
}

// ── Linking-page buckets (D5) ──────────────────────────────────────────────

export const BUCKETS = ["toCheck", "mentions", "pointers", "history", "changedSince"] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface LinkPassage {
  line: number;
  text: string;
  /** Why the passage is one to check, when it is: a status word, date, PR or count. */
  claim?: string;
}

export interface LinkingPage {
  relPath: string;
  title: string;
  type: string;
  planStatus?: PlanStatus;
  lastChangeMs?: number;
  bucket: Bucket;
  passages: LinkPassage[];
}

export interface StaleBuckets {
  relPath: string;
  changedAtMs: number;
  counts: Record<Bucket, number>;
  linking: LinkingPage[];
}

const POINTER_HEADING = /^#{1,6}\s*(?:sources|see also|related|references|kilder|se også|relatert|lenker)(?![\p{L}\p{N}])/iu;
const BARE_ITEM = /^[-*+]\s+\[\[[^\]\n]+\]\](.*)$/;
const BARE_ITEM_TAIL_MAX = 30;
const HEADING = /^#{1,6}\s/;

/** What makes a passage one to check: a status word, a date (`D.M`,
 *  `DD.MM.YYYY`, ISO), a PR number (`#NN…`, `PR N`) or an «N of M» count. */
const CLAIM_RES: readonly (readonly [string, RegExp])[] = [
  ["date", /(?<![\p{L}\p{N}.])(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])(?:\.\d{4})?(?![\p{N}]|\.\p{N})/u],
  ["date", /(?<![\p{N}])20\d\d-[01]\d-[0-3]\d(?![\p{N}])/u],
  ["PR", /(?<![\p{L}\p{N}&/#])#\d{2,}(?![\p{N}])|(?<![\p{L}\p{N}])PR[ -]?#?\d+(?![\p{N}])/u],
  ["count", /(?<![\p{L}\p{N}])\d+ (?:of|av) \d+(?![\p{N}])/u],
];

/** The claim a passage's text makes, or undefined. Links are blanked first:
 *  a `[[plan#3]]` anchor or a `](x#12)` destination is not a PR. */
export function passageClaim(line: string): string | undefined {
  const text = maskLineCodeSpans(line)
    .replace(/\[\[[^\]\n]*\]\]/g, blank)
    .replace(/\]\([^)\n]*\)/g, blank);
  const said = statusWordsIn(text);
  if (said.length) return said[0];
  for (const [kind, re] of CLAIM_RES) if (re.test(text)) return kind;
  return undefined;
}

/** Does `line` link to `targetKey` (a normalized relPath) — by wikilink or by
 *  a relative markdown link from `fromRelPath`? */
function linksTo(line: string, targetKey: string, fromRelPath: string, index: Pick<WikiIndex, "resolve">): boolean {
  for (const m of line.matchAll(WIKILINK_RE)) {
    let t = m[1]!.replace(/\\/g, "").trim();
    const hash = t.indexOf("#");
    if (hash === 0) continue;
    if (hash > 0) t = t.slice(0, hash).trim();
    const meta = t ? index.resolve(t) : undefined;
    if (meta && normalizeRelPath(meta.relPath) === targetKey) return true;
  }
  for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
    const dest = m[1]!.split("#")[0]!;
    if (!dest || /^[a-z][a-z0-9+.-]*:/i.test(dest) || dest.startsWith("/")) continue;
    let decoded = dest;
    try {
      decoded = decodeURI(dest);
    } catch {
      /* keep as written */
    }
    if (normalizeRelPath(path.posix.join(path.posix.dirname(fromRelPath), decoded)) === targetKey) return true;
  }
  return false;
}

/**
 * Sort one linking page into its bucket. History is tested FIRST, whatever
 * the dates; then Changed since (it changed after the changed page did); then,
 * only when it is older (more than {@link OLDER_MARGIN_MS} before), Pointers,
 * To check, Mentions; a page inside the margin is a Mention. Passages on
 * check 14's exempt lines are dropped; a page with none left is a Mention.
 */
export function bucketFor(input: {
  page: PageFacts;
  lastChangeMs: number | undefined;
  changedAtMs: number;
  passages: readonly { line: number; text: string; inFrontmatter: boolean; pointerHeading: boolean; claim?: string }[];
}): Bucket {
  const { page, lastChangeMs, changedAtMs, passages } = input;
  if (isHistoryPage(page)) return "history";
  if (lastChangeMs !== undefined && lastChangeMs > changedAtMs) return "changedSince";
  const older = lastChangeMs === undefined || lastChangeMs < changedAtMs - OLDER_MARGIN_MS;
  if (!older || passages.length === 0) return "mentions";
  const pointer = passages.every((p) => {
    if (p.inFrontmatter || p.pointerHeading) return true;
    const m = BARE_ITEM.exec(p.text);
    return !!m && m[1]!.trim().length <= BARE_ITEM_TAIL_MAX;
  });
  if (pointer) return "pointers";
  if (passages.some((p) => !p.inFrontmatter && p.claim !== undefined)) return "toCheck";
  return "mentions";
}

/** Every line of a linking page that links to the target, with its context. */
function linkPassages(content: string, fromRelPath: string, targetKey: string, index: Pick<WikiIndex, "resolve">) {
  const { lines, body, exempt } = stateExemptLines(content);
  const out: { line: number; text: string; inFrontmatter: boolean; pointerHeading: boolean; claim?: string }[] = [];
  let pointerHeading = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const inFrontmatter = body > 0 && i > 0 && i < body - 1;
    if (i >= body && !exempt.has(i) && HEADING.test(l)) pointerHeading = POINTER_HEADING.test(l);
    if (exempt.has(i) || (!l.includes("](") && !l.includes("[["))) continue;
    if (body > 0 && (i === 0 || i === body - 1)) continue;
    if (!linksTo(maskLineCodeSpans(l), targetKey, fromRelPath, index)) continue;
    const text = l.trim();
    const claim = inFrontmatter ? undefined : passageClaim(text);
    out.push({ line: i + 1, text: text.slice(0, TEXT_CAP), inFrontmatter, pointerHeading: !inFrontmatter && pointerHeading, ...(claim ? { claim } : {}) });
  }
  return out;
}

export type StaleReadFile = (absPath: string) => Promise<string | null>;

const defaultReadFile: StaleReadFile = async (abs) => {
  try {
    return await Bun.file(abs).text();
  } catch {
    return null;
  }
};

/** Per index: the bucket answers, keyed `relPath\0now`. Lives as long as the
 *  index does, so a rebuild (a write, the TTL) starts it empty. */
const bucketCache = new WeakMap<WikiIndex, Map<string, Promise<StaleBuckets | null>>>();

/**
 * The linking-page buckets of one page, or null when it is not a changed
 * page as of `asOfMs` (else the index's build time). Linking pages are its
 * backlinks minus reserved pages; each is read once. Cached on the index.
 */
export function linkingBuckets(
  index: WikiIndex,
  relPath: string,
  opts: { asOfMs?: number; readFile?: StaleReadFile } = {},
): Promise<StaleBuckets | null> {
  const nowMs = staleNow(index, opts.asOfMs);
  let cache = bucketCache.get(index);
  if (!cache) bucketCache.set(index, (cache = new Map()));
  const key = `${normalizeRelPath(relPath)}\0${nowMs}`;
  const hit = opts.readFile ? undefined : cache.get(key);
  if (hit) return hit;
  const p = computeBuckets(index, relPath, nowMs, opts.asOfMs, opts.readFile ?? defaultReadFile);
  if (!opts.readFile) cache.set(key, p);
  return p;
}

async function computeBuckets(
  index: WikiIndex,
  relPath: string,
  nowMs: number,
  asOfMs: number | undefined,
  readFile: StaleReadFile,
): Promise<StaleBuckets | null> {
  const page = index.resolveRelPath(relPath);
  // A reserved page (`index`/`log`/`CLAUDE`) is bookkeeping: it changes daily
  // and links everything, so it is never a changed page.
  if (!page || isReservedBasename(page.relPath)) return null;
  const changedAtMs = lastChangeIn(index, page, asOfMs ?? nowMs);
  if (!isChangedPage(changedAtMs, nowMs)) return null;
  const targetKey = normalizeRelPath(page.relPath);
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
  const linking: LinkingPage[] = [];
  for (const fromKey of index.backlinks.get(targetKey) ?? []) {
    const from = index.resolveRelPath(fromKey);
    if (!from || isReservedBasename(from.relPath) || normalizeRelPath(from.relPath) === targetKey) continue;
    const content = await readFile(path.join(index.root, from.relPath));
    if (content === null) continue;
    const passages = linkPassages(content, from.relPath, targetKey, index);
    const lastChangeMs = lastChangeIn(index, from, asOfMs ?? nowMs);
    const bucket = bucketFor({ page: from, lastChangeMs, changedAtMs, passages });
    counts[bucket]++;
    linking.push({
      relPath: from.relPath,
      title: from.displayTitle ?? from.title,
      type: from.type,
      ...(from.plan_status ? { planStatus: from.plan_status } : {}),
      ...(lastChangeMs !== undefined ? { lastChangeMs } : {}),
      bucket,
      passages: passages.map(({ line, text, claim }) => ({ line, text, ...(claim ? { claim } : {}) })),
    });
  }
  return { relPath: page.relPath, changedAtMs, counts, linking };
}

/** One page's free stale facts: its status-line hits, whether it is changed,
 *  and its last change. The summary route reads this for every page. */
export function pageStaleFacts(index: WikiIndex, p: WikiPageMeta, asOfMs?: number) {
  const nowMs = staleNow(index, asOfMs);
  const lastChangeMs = lastChangeIn(index, p, asOfMs ?? nowMs);
  return {
    hits: index.statusLineHits?.get(p.relPath) ?? [],
    changed: !isReservedBasename(p.relPath) && isChangedPage(lastChangeMs, nowMs),
    lastChangeMs,
  };
}

// ── Moved with (D10) ───────────────────────────────────────────────────────

export interface MovedWithRow {
  relPath: string;
  title: string;
  type: string;
  /** Non-sweep commits in the window that touched both pages. */
  n: number;
  /** The newest of them. */
  lastMs: number;
}

/** Per index: commit → the pages it touched (non-sweep commits only). */
const commitCache = new WeakMap<WikiIndex, Map<string, string[]>>();

function commitsOf(index: WikiIndex): Map<string, string[]> {
  let m = commitCache.get(index);
  if (m) return m;
  m = new Map();
  for (const [rel, list] of index.gitTouches ?? []) {
    for (const { commit } of list) {
      const arr = m.get(commit);
      if (arr) arr.push(rel);
      else m.set(commit, [rel]);
    }
  }
  commitCache.set(index, m);
  return m;
}

/**
 * The pages that moved with `relPath`: for each non-sweep commit touching it
 * in the {@link MOVED_WITH_WINDOW_MS} before `nowMs`, the other live pages that
 * commit touched (reserved pages left out). Most shared commits first, then
 * newest; at most {@link MOVED_WITH_MAX}. Empty without git.
 */
export function movedWith(index: WikiIndex, relPath: string, nowMs: number = Date.now()): MovedWithRow[] {
  const own = index.gitTouches?.get(relPath);
  if (!own?.length) return [];
  const commits = commitsOf(index);
  const tally = new Map<string, { n: number; lastMs: number }>();
  const seen = new Set<string>();
  for (const { commit, ts } of own) {
    if (ts > nowMs || nowMs - ts > MOVED_WITH_WINDOW_MS || seen.has(commit)) continue;
    seen.add(commit);
    for (const other of commits.get(commit) ?? []) {
      if (other === relPath || isReservedBasename(other)) continue;
      const t = tally.get(other) ?? { n: 0, lastMs: 0 };
      t.n++;
      t.lastMs = Math.max(t.lastMs, ts);
      tally.set(other, t);
    }
  }
  const rows: MovedWithRow[] = [];
  for (const [rel, t] of tally) {
    const meta = index.resolveRelPath(rel);
    if (!meta) continue;
    rows.push({ relPath: meta.relPath, title: meta.displayTitle ?? meta.title, type: meta.type, n: t.n, lastMs: t.lastMs });
  }
  rows.sort((a, b) => b.n - a.n || b.lastMs - a.lastMs || a.relPath.localeCompare(b.relPath));
  return rows.slice(0, MOVED_WITH_MAX);
}

// ── The route's two answers (`GET /api/wiki/stale`) ────────────────────────

/**
 * `asOf` as the route and the script take it: `YYYY-MM-DD` is the END of that
 * UTC day (a commit made on it counts), an ISO instant is itself, digits are
 * epoch ms. Absent ⇒ undefined; unreadable ⇒ null.
 */
export function parseStaleAsOf(raw: string | undefined): number | undefined | null {
  const v = (raw ?? "").trim();
  if (!v) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const ms = Date.parse(`${v}T23:59:59.999Z`);
    return Number.isFinite(ms) ? ms : null;
  }
  if (/^\d{10,}$/.test(v)) return Number(v);
  const ms = Date.parse(v);
  return Number.isFinite(ms) && /^\d{4}-\d{2}-\d{2}T/.test(v) ? ms : null;
}

export interface StaleSummaryRow {
  relPath: string;
  title: string;
  /** Status-line hits on the page. */
  staleLines: number;
  /** Its linking pages to check — 0 on a page that is not changed. */
  toCheck: number;
  changed: boolean;
  /** Uncommitted edits (the index's `gitDirty`). */
  dirty: boolean;
  lastChangeMs?: number;
}

/**
 * The wiki-wide summary (D31): every changed page and every page with a
 * status-line hit, with its two counts (D26). Changed pages' buckets are
 * computed (and cached) here; nothing is written.
 */
export async function staleSummary(index: WikiIndex, opts: { asOfMs?: number; readFile?: StaleReadFile } = {}) {
  const rows: StaleSummaryRow[] = [];
  for (const p of index.pages) {
    const facts = pageStaleFacts(index, p, opts.asOfMs);
    if (!facts.changed && facts.hits.length === 0) continue;
    const buckets = facts.changed ? await linkingBuckets(index, p.relPath, opts) : null;
    rows.push({
      relPath: p.relPath,
      title: p.displayTitle ?? p.title,
      staleLines: facts.hits.length,
      toCheck: buckets?.counts.toCheck ?? 0,
      changed: facts.changed,
      dirty: p.gitDirty === true,
      ...(facts.lastChangeMs !== undefined ? { lastChangeMs: facts.lastChangeMs } : {}),
    });
  }
  rows.sort((a, b) => b.staleLines + b.toCheck - (a.staleLines + a.toCheck) || (b.lastChangeMs ?? 0) - (a.lastChangeMs ?? 0) || a.relPath.localeCompare(b.relPath));
  return {
    asOfMs: staleNow(index, opts.asOfMs),
    totals: {
      staleLines: rows.reduce((n, r) => n + r.staleLines, 0),
      toCheck: rows.reduce((n, r) => n + r.toCheck, 0),
      changedPages: rows.filter((r) => r.changed).length,
    },
    pages: rows,
  };
}

/** One page's answer: its hits, whether it changed, its buckets and *Moved with*. */
export async function stalePageReport(index: WikiIndex, p: WikiPageMeta, opts: { asOfMs?: number; readFile?: StaleReadFile } = {}) {
  const facts = pageStaleFacts(index, p, opts.asOfMs);
  const nowMs = staleNow(index, opts.asOfMs);
  return {
    asOfMs: nowMs,
    page: { relPath: p.relPath, title: p.displayTitle ?? p.title, type: p.type, ...(p.plan_status ? { planStatus: p.plan_status } : {}) },
    changed: facts.changed,
    dirty: p.gitDirty === true,
    ...(facts.lastChangeMs !== undefined ? { lastChangeMs: facts.lastChangeMs } : {}),
    hits: facts.hits,
    buckets: facts.changed ? await linkingBuckets(index, p.relPath, opts) : null,
    movedWith: movedWith(index, p.relPath, nowMs),
  };
}
