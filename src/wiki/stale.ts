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
import { newestEditAtOrBefore, type TouchRecord } from "./git-dates.ts";
import { isReservedBasename } from "./frontmatter-lists.ts";
import { stateExemptLines } from "./lint-state.ts";
import { normalizeRelPath } from "./rel-path.ts";
import { extractWikilinks, WIKILINK_RE, wikilinkTarget } from "./wikilinks.ts";
import { extractMarkdownLinks, resolveMarkdownTargets, type PlanStatus, type WikiIndex, type WikiPageMeta } from "./store.ts";
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

/** A negation (F7a): the word `ikke`/`not`, any whitespace run, at most one
 *  adverb (`yet`, `ennå`, `enda`, `still`, `fortsatt`) and whitespace again. */
const NEGATION = `${L}(?:ikke|not)(?:\\s+(?:yet|ennå|enda|still|fortsatt))?\\s+`;

/**
 * The status words (D18): the measured union of English and Norwegian, read on
 * every wiki whatever its `language`. A shipped word right after a
 * {@link NEGATION} is not shipped; a negated `merget`/`merged` is in-flight,
 * any other negated shipped word (`not yet shipped`) names no status.
 */
export const STATUS_WORDS: readonly (readonly [StatusKind, RegExp])[] = [
  ["proposed", words("proposed|forslag|foreslått|utkast|draft")],
  ["in-flight", new RegExp(`${L}(?:in[- ]flight|pågår|i gang|påbegynt|under arbeid|open PRs?|(?:åpen|åpne) PR(?:-er)?)${R}|${NEGATION}(?:merget|merged)${R}`, "iu")],
  ["shipped", new RegExp(`(?<!${NEGATION})${L}(?:shipped|levert|landet|ferdig|done|merget|merged)${R}`, "iu")],
  ["blocked", words("blocked|blokkert")],
];
/** The prefilter: a plain, edge-free alternation over every status word's
 *  stem — a superset of {@link STATUS_WORDS}, and ~8× cheaper per line than
 *  the edged `u` regexes, which measured 12 ms over mimir's 282 link lines. */
const STATUS_PROBE = /proposed|forslag|foreslått|utkast|draft|flight|pågår|i gang|påbegynt|under arbeid|merget|merged|open pr|åpen pr|åpne pr|shipped|levert|landet|ferdig|done|blocked|blokkert/i;

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
    const target = wikilinkTarget(m[1]!);
    if (target) out.push({ line, target, said, text: sourceText.trim().slice(0, TEXT_CAP) });
  });
  return out;
}

/** A struck span: `~~` to the next `~~`, a single `~` and masked code inside. */
const STRUCK_RE = /~~[\s\S]*?~~/g;

/**
 * One line with this check's in-line masks applied, in order: inline code
 * (to `\n`, which no wikilink crosses), HTML comments (blanked; `inComment`
 * carries one across lines), then strikethrough (blanked). Length-preserving.
 */
function maskLine(line: string, inComment: boolean): { text: string; inComment: boolean } {
  const t = maskLineCodeSpans(line);
  let out = "";
  let i = 0;
  let open = inComment;
  while (i < t.length) {
    if (open) {
      const e = t.indexOf("-->", i);
      const end = e < 0 ? t.length : e + 3;
      out += blank(t.slice(i, end));
      i = end;
      if (e >= 0) open = false;
    } else {
      const s = t.indexOf("<!--", i);
      if (s < 0) {
        out += t.slice(i);
        break;
      }
      out += t.slice(i, s) + blank("<!");
      // The closer is searched from `s + 2`, so `<!-->` is the empty comment.
      i = s + 2;
      open = true;
    }
  }
  return { text: out.replace(STRUCK_RE, blank), inComment: open };
}

/**
 * Phase A, one page's text: every segment from a `[[link]]` to the next
 * wikilink on its line that names a status word, read on the MASKED line.
 *
 * The prefilter keeps a line only when the masked parse could find a
 * segment on it, so check 14's masks, a full `parseBlocks`, are paid only on
 * pages that pass. Masks only blank text in place, so: a raw `[[` followed by
 * a {@link STATUS_PROBE} match is necessary; then the line's own masks
 * ({@link maskLine}, outside a comment) and the segment parse must find one —
 * exact, since the full pass masks the same way unless a comment opened on an
 * earlier line, and a line holding no `-->` is then masked whole (a line
 * holding one skips this second test).
 *
 * Exempt: check 14's masks ({@link stateExemptLines}) and inline code; by this
 * check's choice, strikethrough spans, HTML comments (body lines check 14
 * does not mask), the frontmatter `status_note`, `description` and `title`
 * (with their continuation lines), and a segment that holds a markdown link.
 */
export function statusLineCandidates(content: string): StatusLineCandidate[] {
  if (!content.includes("[[")) return [];
  const raw = content.replace(/\r\n/g, "\n").split("\n");
  const probe = new Set<number>();
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i]!;
    const at = l.indexOf("[[");
    if (at < 0 || !STATUS_PROBE.test(at === 0 ? l : l.slice(at))) continue;
    if (l.includes("-->") || lineSegments(maskLine(l, false).text, i + 1, l).length) probe.add(i);
  }
  if (probe.size === 0) return [];

  const { lines, body, exempt } = stateExemptLines(content);
  for (let i = 1; i < body - 1; i++) {
    if (!SKIPPED_FM_KEY.test(lines[i]!)) continue;
    exempt.add(i);
    for (let k = i + 1; k < body - 1 && (lines[k]!.trim() === "" || /^\s/.test(lines[k]!)); k++) exempt.add(k);
  }

  const out: StatusLineCandidate[] = [];
  // A comment opens only in the body; an exempt line leaves its state alone.
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    if (exempt.has(i)) continue;
    const l = lines[i]!;
    const inBody = i >= body;
    if (!probe.has(i) && !(inBody && (inComment || l.includes("<!--")))) continue;
    const m = maskLine(l, inBody && inComment);
    if (inBody) inComment = m.inComment;
    if (probe.has(i)) out.push(...lineSegments(m.text, i + 1, l));
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
 * signals at or before it count; a newer commit falls back to
 * `steppedBackGitMs`, the newest edit commit at or before it (D29: sweeps and
 * metadata-only commits skipped — {@link lastChangeIn} resolves it).
 * Undefined when no signal qualifies.
 */
export function pageLastChangeMs(p: ChangeFacts, asOfMs?: number, steppedBackGitMs?: number): number | undefined {
  const ok = (ms: number | undefined) => (ms !== undefined && (asOfMs === undefined || ms <= asOfMs) ? ms : undefined);
  let git = ok(p.gitTouchedMs);
  if (git === undefined && p.gitTouchedMs !== undefined && asOfMs !== undefined) git = ok(steppedBackGitMs);
  const xs = [ok(p.workedMs), git, p.gitDirty ? ok(p.mtimeMs) : undefined].filter((x): x is number => x !== undefined);
  return xs.length ? Math.max(...xs) : undefined;
}

/** The instant the stale rules read as «now»: `asOfMs`, else the index's own
 *  build time, so one index answers one way (and its cache holds). */
export const staleNow = (index: Pick<WikiIndex, "scannedAt">, asOfMs?: number): number => asOfMs ?? index.scannedAt;

/** Per index and `asOf`: the stepped-back edit commit of every page whose
 *  newest edit commit is newer than `asOf` — one `cat-file` round for all. */
const asOfGitCache = new WeakMap<WikiIndex, Map<number, Promise<Map<string, number>>>>();

function steppedBackGit(index: WikiIndex, asOfMs: number): Promise<Map<string, number>> {
  let cache = asOfGitCache.get(index);
  if (!cache) asOfGitCache.set(index, (cache = new Map()));
  const hit = cache.get(asOfMs);
  if (hit) return hit;
  const touches = new Map<string, TouchRecord[]>();
  for (const p of index.pages) {
    if (p.gitTouchedMs === undefined || p.gitTouchedMs <= asOfMs) continue;
    const list = index.gitTouches?.get(p.relPath);
    if (list?.length) touches.set(p.relPath, list);
  }
  const out = touches.size ? newestEditAtOrBefore(index.root, touches, asOfMs) : Promise.resolve(new Map<string, number>());
  cache.set(asOfMs, out);
  return out;
}

async function lastChangeIn(index: WikiIndex, p: WikiPageMeta, asOfMs: number): Promise<number | undefined> {
  const stepped = p.gitTouchedMs !== undefined && p.gitTouchedMs > asOfMs ? (await steppedBackGit(index, asOfMs)).get(p.relPath) : undefined;
  return pageLastChangeMs(p, asOfMs, stepped);
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

/** A pointer heading's name (D5), matched as a prefix word: «Related
 *  concepts» is one. A list of its own, not `SYSTEM_MAP_LINK_HEADINGS_DEFAULT`:
 *  that names the sections a hub's system map reads, by exact name. */
const POINTER_HEADING = /^(?:sources|see also|related|relaterte|references|kilder|se også|relatert|lenker)(?![\p{L}\p{N}])/iu;
const BARE_ITEM = /^[-*+]\s+\[\[[^\]\n]+\]\](.*)$/;
const BARE_ITEM_TAIL_MAX = 30;
/** A heading, as `linkSections` (`lint-system-map.ts`) reads one: up to
 *  three spaces of indent; group 1 is its level, group 2 its text. */
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;

/**
 * A `D.M` date (F2): day 1–31 and month 1–12, with no digit, `.digit`, letter
 * or `-letter` against it; not followed by a letter, `%`, `+`, `×` or a unit
 * word (`2.5k`, `12.5 %`, `9.5–10.6 min`); and not preceded by an all-caps
 * word (`CDM 4.4`), a version word (`section 4.2`) or a capitalised word
 * mid-sentence (`Opus 4.6`). A leading-zero day (`Siden 03.10`) and a
 * sentence-initial capitalised word (`Mandag 23.10`) keep it a date.
 */
const DM_RE = /(?<![\p{L}\p{N}.]|[\p{L}][-‐‑])(0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])(\.\d{4})?(?![\p{N}]|\.\p{N})/gu;
const DM_AFTER = /^(?:\s*[–—-]\s*\d+(?:[.,]\d+)?)?(?:[\p{L}%+×]|\s+(?:%|×|x|(?:ms|s|sek|sec|min|minutter|minutes|h|t|timer|hours|kB|KB|MB|GB|TB|k|oz|px|pt|em|rem)(?![\p{L}\p{N}])))/u;
const DM_VERSION_WORD = /(?<![\p{L}])(?:v|ver|version|versjon|versions|release|section|seksjon|kapittel|kap|chapter|phase|fase|step|steg|check|sjekk|del|part|§)\.?\s*$/iu;
const DM_PREV_WORD = /([\p{L}][\p{L}\p{N}'’]*)\s+$/u;
const SENTENCE_START = /(?:^[\s>*_#|+\-–—\d.)]*|[.!?:;]\s+[*_]*)$/u;

function hasDateDM(text: string): boolean {
  for (const m of text.matchAll(DM_RE)) {
    const before = text.slice(0, m.index);
    if (DM_AFTER.test(text.slice(m.index! + m[0].length))) continue;
    if (m[2]) return true; // a year
    if (DM_VERSION_WORD.test(before)) continue;
    const w = DM_PREV_WORD.exec(before);
    if (w && /^\p{Lu}/u.test(w[1]!)) {
      const allCaps = w[1]!.length > 1 && w[1] === w[1]!.toUpperCase();
      if (allCaps) continue;
      if (!m[1]!.startsWith("0") && !SENTENCE_START.test(before.slice(0, w.index))) continue;
    }
    return true;
  }
  return false;
}

/** What makes a passage one to check: a status word, a date (`D.M` per
 *  {@link hasDateDM}, `DD.MM.YYYY`, ISO), a PR number (`#NN…`, `PR N`) or an
 *  «N of M» count. */
const CLAIMS: readonly (readonly [string, (text: string) => boolean])[] = [
  ["date", hasDateDM],
  ["date", (t) => /(?<![\p{N}])20\d\d-[01]\d-[0-3]\d(?![\p{N}])/u.test(t)],
  ["PR", (t) => /(?<![\p{L}\p{N}&/#])#\d{2,}(?![\p{N}])|(?<![\p{L}\p{N}])PR[ -]?#?\d+(?![\p{N}])/u.test(t)],
  ["count", (t) => /(?<![\p{L}\p{N}])\d+ (?:of|av) \d+(?![\p{N}])/u.test(t)],
];

/** Links become `·` runs: no claim reads them, and a link still stands as a
 *  word before a capitalised one (`[[x]] Opus 4.6` is mid-sentence). */
const filler = (s: string) => "·".repeat(s.length);

/** The claim a passage's text makes, or undefined. Links are blanked first:
 *  a `[[plan#3]]` anchor or a `](x#12)` destination is not a PR. */
export function passageClaim(line: string): string | undefined {
  const text = maskLineCodeSpans(line)
    .replace(/\[\[[^\]\n]*\]\]/g, filler)
    .replace(/\]\([^)\n]*\)/g, filler);
  const said = statusWordsIn(text);
  if (said.length) return said[0];
  for (const [kind, has] of CLAIMS) if (has(text)) return kind;
  return undefined;
}

/** Does `line` link to `targetKey` (a normalized relPath)? Read as the
 *  backlink graph reads links (F8): `extractWikilinks` resolved through the
 *  index, and `extractMarkdownLinks` (titles dropped, images skipped,
 *  `decodeURIComponent`) joined from `fromRelPath` by `resolveMarkdownTargets`,
 *  which drops a link that escapes the root. */
function linksTo(line: string, targetKey: string, fromRelPath: string, index: Pick<WikiIndex, "resolve">): boolean {
  for (const t of extractWikilinks(line)) {
    const meta = index.resolve(t);
    if (meta && normalizeRelPath(meta.relPath) === targetKey) return true;
  }
  return resolveMarkdownTargets(fromRelPath, extractMarkdownLinks(line)).includes(targetKey);
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
  const decided = metadataBucket(page, lastChangeMs, changedAtMs);
  if (decided) return decided;
  if (passages.length === 0) return "mentions";
  const pointer = passages.every((p) => {
    if (p.inFrontmatter || p.pointerHeading) return true;
    const m = BARE_ITEM.exec(p.text);
    return !!m && m[1]!.trim().length <= BARE_ITEM_TAIL_MAX;
  });
  if (pointer) return "pointers";
  if (passages.some((p) => !p.inFrontmatter && p.claim !== undefined)) return "toCheck";
  return "mentions";
}

/** {@link bucketFor}'s first three rules, which read no passage: History,
 *  Changed since, and a page inside the margin (a Mention). Null when the
 *  passages decide — the only case that reads the linking page. */
function metadataBucket(page: PageFacts, lastChangeMs: number | undefined, changedAtMs: number): Bucket | null {
  if (isHistoryPage(page)) return "history";
  if (lastChangeMs !== undefined && lastChangeMs > changedAtMs) return "changedSince";
  const older = lastChangeMs === undefined || lastChangeMs < changedAtMs - OLDER_MARGIN_MS;
  return older ? null : "mentions";
}

type ParsedPage = ReturnType<typeof stateExemptLines>;

/** Every line of a linking page that links to the target, with its context. */
function linkPassages(parsed: ParsedPage, fromRelPath: string, targetKey: string, index: Pick<WikiIndex, "resolve">) {
  const { lines, body, exempt } = parsed;
  const out: { line: number; text: string; inFrontmatter: boolean; pointerHeading: boolean; claim?: string }[] = [];
  // The level of the pointer heading the line sits under, 0 for none: a
  // deeper heading keeps it, one of the same or a higher level ends it (F7c).
  let pointerLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const inFrontmatter = body > 0 && i > 0 && i < body - 1;
    const h = i >= body && !exempt.has(i) ? HEADING.exec(l) : null;
    if (h && !(pointerLevel && h[1]!.length > pointerLevel)) pointerLevel = POINTER_HEADING.test(h[2]!) ? h[1]!.length : 0;
    const pointerHeading = pointerLevel > 0;
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

/** The changed page behind a bucket request, or null when it is none. */
async function changedPageOf(index: WikiIndex, relPath: string, nowMs: number, asOfMs: number | undefined) {
  const page = index.resolveRelPath(relPath);
  // A reserved page (`index`/`log`/`CLAUDE`) is bookkeeping: it changes daily
  // and links everything, so it is never a changed page.
  if (!page || isReservedBasename(page.relPath)) return null;
  const changedAtMs = await lastChangeIn(index, page, asOfMs ?? nowMs);
  if (!isChangedPage(changedAtMs, nowMs)) return null;
  return { page, changedAtMs, targetKey: normalizeRelPath(page.relPath) };
}

/** A changed page's linking pages: its backlinks minus reserved pages and itself. */
function* linkingPagesOf(index: WikiIndex, targetKey: string): Generator<WikiPageMeta> {
  for (const fromKey of index.backlinks.get(targetKey) ?? []) {
    const from = index.resolveRelPath(fromKey);
    if (!from || isReservedBasename(from.relPath) || normalizeRelPath(from.relPath) === targetKey) continue;
    yield from;
  }
}

const emptyCounts = () => Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;

async function computeBuckets(
  index: WikiIndex,
  relPath: string,
  nowMs: number,
  asOfMs: number | undefined,
  readFile: StaleReadFile,
): Promise<StaleBuckets | null> {
  const changed = await changedPageOf(index, relPath, nowMs, asOfMs);
  if (!changed) return null;
  const { page, changedAtMs, targetKey } = changed;
  const counts = emptyCounts();
  const linking: LinkingPage[] = [];
  for (const from of linkingPagesOf(index, targetKey)) {
    const content = await readFile(path.join(index.root, from.relPath));
    if (content === null) continue;
    const passages = linkPassages(stateExemptLines(content), from.relPath, targetKey, index);
    const lastChangeMs = await lastChangeIn(index, from, asOfMs ?? nowMs);
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

/** One summary call's reads: each linking page read and masked once, however
 *  many changed pages it links to. */
export type StaleReadMemo = Map<string, Promise<ParsedPage | null>>;

/** Per index: the counts-only answers, keyed like {@link bucketCache}. */
const countsCache = new WeakMap<WikiIndex, Map<string, Promise<Record<Bucket, number> | null>>>();

/**
 * {@link linkingBuckets}' counts alone, for the summary (D31): each linking
 * page is sorted by {@link metadataBucket} first, and only the older,
 * non-history ones are read — through `memo`, so once per call. The same
 * counts as the full path, with one difference no index shows: the full path
 * drops a linking page whose file vanished since the build, and this path
 * counts a metadata-decided one without reading it. Cached on the index;
 * a full answer already cached gives its counts.
 */
export function linkingCounts(
  index: WikiIndex,
  relPath: string,
  opts: { asOfMs?: number; readFile?: StaleReadFile; memo?: StaleReadMemo } = {},
): Promise<Record<Bucket, number> | null> {
  const nowMs = staleNow(index, opts.asOfMs);
  const key = `${normalizeRelPath(relPath)}\0${nowMs}`;
  if (!opts.readFile) {
    const full = bucketCache.get(index)?.get(key);
    if (full) return full.then((b) => b?.counts ?? null);
  }
  let cache = countsCache.get(index);
  if (!cache) countsCache.set(index, (cache = new Map()));
  const hit = opts.readFile ? undefined : cache.get(key);
  if (hit) return hit;
  const p = computeCounts(index, relPath, nowMs, opts.asOfMs, opts.readFile ?? defaultReadFile, opts.memo ?? new Map());
  if (!opts.readFile) cache.set(key, p);
  return p;
}

async function computeCounts(
  index: WikiIndex,
  relPath: string,
  nowMs: number,
  asOfMs: number | undefined,
  readFile: StaleReadFile,
  memo: StaleReadMemo,
): Promise<Record<Bucket, number> | null> {
  const changed = await changedPageOf(index, relPath, nowMs, asOfMs);
  if (!changed) return null;
  const { changedAtMs, targetKey } = changed;
  const counts = emptyCounts();
  for (const from of linkingPagesOf(index, targetKey)) {
    const lastChangeMs = await lastChangeIn(index, from, asOfMs ?? nowMs);
    const decided = metadataBucket(from, lastChangeMs, changedAtMs);
    if (decided) {
      counts[decided]++;
      continue;
    }
    let parsed = memo.get(from.relPath);
    if (!parsed) {
      parsed = readFile(path.join(index.root, from.relPath)).then((c) => (c === null ? null : stateExemptLines(c)));
      memo.set(from.relPath, parsed);
    }
    const page = await parsed;
    if (page === null) continue;
    const passages = linkPassages(page, from.relPath, targetKey, index);
    counts[bucketFor({ page: from, lastChangeMs, changedAtMs, passages })]++;
  }
  return counts;
}

/** One page's free stale facts: its status-line hits, whether it is changed,
 *  and its last change. The summary route reads this for every page. */
export async function pageStaleFacts(index: WikiIndex, p: WikiPageMeta, asOfMs?: number) {
  const nowMs = staleNow(index, asOfMs);
  const lastChangeMs = await lastChangeIn(index, p, asOfMs ?? nowMs);
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

/** A `YYYY-MM-DD` that names a real calendar day (`2026-02-30` does not). */
const realDay = (ymd: string) => {
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === ymd;
};

/**
 * `asOf` as the route and the script take it: `YYYY-MM-DD` is the END of that
 * UTC day (a commit made on it counts); an ISO instant is itself and must
 * carry its zone (`Z` or `±HH:MM`), since a zone-less one would be read in the
 * server's local time; exactly 13 digits are epoch ms (2001–2286), so an
 * epoch in seconds is refused rather than read as 1970 (F9a). A day that is
 * not on the calendar is refused too. Absent ⇒ undefined; unreadable ⇒ null.
 */
export function parseStaleAsOf(raw: string | undefined): number | undefined | null {
  const v = (raw ?? "").trim();
  if (!v) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return realDay(v) ? Date.parse(`${v}T23:59:59.999Z`) : null;
  if (/^\d+$/.test(v)) return v.length === 13 ? Number(v) : null;
  const m = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.exec(v);
  if (!m || !realDay(m[1]!)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
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
 * status-line hit, with its two counts (D26). Changed pages' counts come
 * off {@link linkingCounts} (cached); nothing is written.
 */
export async function staleSummary(index: WikiIndex, opts: { asOfMs?: number; readFile?: StaleReadFile } = {}) {
  const rows: StaleSummaryRow[] = [];
  const memo: StaleReadMemo = new Map();
  for (const p of index.pages) {
    const facts = await pageStaleFacts(index, p, opts.asOfMs);
    if (!facts.changed && facts.hits.length === 0) continue;
    const counts = facts.changed ? await linkingCounts(index, p.relPath, { ...opts, memo }) : null;
    rows.push({
      relPath: p.relPath,
      title: p.displayTitle ?? p.title,
      staleLines: facts.hits.length,
      toCheck: counts?.toCheck ?? 0,
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
  const facts = await pageStaleFacts(index, p, opts.asOfMs);
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
