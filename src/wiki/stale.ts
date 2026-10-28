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
 *   once the whole index is resolved. Lint check 24 (`status-line`) reads
 *   the index's hits.
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
import { extractMarkdownLinks, markdownLinkSpans, resolveMarkdownTargets, type PlanStatus, type WikiIndex, type WikiPageMeta } from "./store.ts";
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

import { saidSpan as sharedSaidSpan, STATUS_WORDS, type StatusKind } from "./status-words.ts";

/** {@link sharedSaidSpan} with `[0, 0]` for no match. A segment can run for
 *  thousands of characters (one HTML line), so the window anchors on one
 *  word, not all. */
const saidSpan = (seg: string, said: readonly StatusKind[]): [number, number] => sharedSaidSpan(seg, said) ?? [0, 0];

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
  /** The source line, trimmed; a long one is cut to a window around the
   *  segment ({@link hitWindow}). */
  text: string;
  /** The line is in the frontmatter, which the reader does not render, so
   *  the reader places no mark for it (D21). */
  frontmatter?: true;
}

const TEXT_CAP = 360;
const blank = (s: string) => " ".repeat(s.length);
/** Frontmatter keys this check skips by its own choice. */
const SKIPPED_FM_KEY = /^(status_note|description|title):/;

/**
 * A hit's or a long passage line's text (A1, A17): the trimmed line when it
 * fits {@link TEXT_CAP}, else a window that holds the link
 * (`linkStart`–`linkEnd`) and the status word or claim nearest it
 * (`wordStart`–`wordEnd`), positions on the untrimmed `source`, in either
 * order. `…` marks a cut end; when the two lie further apart than the cap,
 * ` … ` marks the gap between their pieces. Never a head cut, so the model
 * always sees what it judges, and every piece is verbatim from the line.
 */
export function hitWindow(source: string, linkStart: number, linkEnd: number, wordStart: number, wordEnd: number, cap = TEXT_CAP): string {
  if (wordStart < linkStart) [linkStart, linkEnd, wordStart, wordEnd] = [wordStart, wordEnd, linkStart, linkEnd];
  wordEnd = Math.max(wordEnd, linkEnd);
  const lead = source.length - source.trimStart().length;
  const t = source.trim();
  if (t.length <= cap) return t;
  const at = (i: number) => Math.min(t.length, Math.max(0, i - lead));
  const s = at(linkStart);
  const e = at(wordEnd);
  const cut = (a: number, b: number, body: string) => `${a > 0 ? "…" : ""}${body}${b < t.length ? "…" : ""}`;
  if (e - s <= cap) {
    const b = Math.min(t.length, Math.max(0, s - Math.floor((cap - (e - s)) / 2)) + cap);
    const a = Math.max(0, b - cap);
    return cut(a, b, t.slice(a, b));
  }
  const left = Math.max(at(linkEnd), s + Math.floor(cap / 2));
  const right = Math.max(left, e - Math.max(e - at(wordStart), cap - (left - s)));
  return cut(s, e, `${t.slice(s, left)} … ${t.slice(right, e)}`);
}


/** The `[[link]] … status word` segments of one line (1-based `line`). */
function lineSegments(lineText: string, line: number, sourceText: string): StatusLineCandidate[] {
  const out: StatusLineCandidate[] = [];
  const links = [...lineText.matchAll(WIKILINK_RE)];
  links.forEach((m, j) => {
    const end = j + 1 < links.length ? links[j + 1]!.index! : lineText.length;
    const segStart = m.index! + m[0].length;
    const seg = lineText.slice(segStart, end);
    if (seg.includes("](")) return;
    const said = statusWordsIn(seg);
    if (said.length === 0) return;
    const target = wikilinkTarget(m[1]!);
    if (!target) return;
    const [ws, we] = saidSpan(seg, said);
    out.push({ line, target, said, text: hitWindow(sourceText, m.index!, segStart, segStart + ws, segStart + we) });
  });
  return out;
}

/** A struck span: `~~` to the next `~~`, a single `~` and masked code inside. */
const STRUCK_RE = /~~[\s\S]*?~~/g;

/**
 * One line with this check's in-line masks applied, in order: inline code
 * (to `\n`, which no wikilink crosses), then strikethrough (blanked).
 * Length-preserving. An HTML comment is not masked: the reader draws it.
 */
function maskLine(line: string): string {
  return maskLineCodeSpans(line).replace(STRUCK_RE, blank);
}

/**
 * Phase A, one page's text: every segment from a `[[link]]` to the next
 * wikilink on its line that names a status word, read on the MASKED line.
 *
 * The prefilter keeps a line only when the masked parse could find a
 * segment on it, so check 14's masks, a full `parseBlocks`, are paid only on
 * pages that pass. Masks only blank text in place, so: a raw `[[` followed by
 * a {@link STATUS_PROBE} match is necessary; then the line's own masks
 * ({@link maskLine}) and the segment parse must find one, exactly as the full
 * pass does.
 *
 * Exempt: check 14's masks ({@link stateExemptLines}) and inline code; by this
 * check's choice, strikethrough spans, the frontmatter `status_note`,
 * `description` and `title` (with their continuation lines), and a segment
 * that holds a markdown link. An HTML comment is read: the reader shows it.
 */
export function statusLineCandidates(content: string): StatusLineCandidate[] {
  if (!content.includes("[[")) return [];
  const raw = content.replace(/\r\n/g, "\n").split("\n");
  const probe = new Set<number>();
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i]!;
    const at = l.indexOf("[[");
    if (at < 0 || !STATUS_PROBE.test(at === 0 ? l : l.slice(at))) continue;
    if (lineSegments(maskLine(l), i + 1, l).length) probe.add(i);
  }
  if (probe.size === 0) return [];

  const { lines, body, exempt } = stateExemptLines(content);
  for (let i = 1; i < body - 1; i++) {
    if (!SKIPPED_FM_KEY.test(lines[i]!)) continue;
    exempt.add(i);
    for (let k = i + 1; k < body - 1 && (lines[k]!.trim() === "" || /^\s/.test(lines[k]!)); k++) exempt.add(k);
  }

  const out: StatusLineCandidate[] = [];
  for (const i of probe) {
    if (exempt.has(i)) continue;
    const segs = lineSegments(maskLine(lines[i]!), i + 1, lines[i]!);
    out.push(...(i < body ? segs.map((c) => ({ ...c, frontmatter: true as const })) : segs));
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
  /** As on {@link StatusLineCandidate}. */
  frontmatter?: true;
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
    out.push({ line: c.line, target: t.relPath, said: c.said, now: t.plan_status, text: c.text, ...(c.frontmatter ? { frontmatter: true as const } : {}) });
  }
  return out;
}

/** Lint check 24: one info finding per hit the index keeps for the page, so
 *  lint, the summary and the script give one answer (D27 — `lintWiki` reads
 *  no verdicts, so a not-a-status hit must never reach the weekly alert). */
export function checkStatusLines(relPath: string, index: Pick<WikiIndex, "statusLineHits">): LintFinding[] {
  return (index.statusLineHits?.get(relPath) ?? []).map((h) => ({
    check: "status-line" as const,
    relPath,
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
 * A `D.M` date (F2; the class-check rule, stated in `src/wiki/CLAUDE.md`). D and
 * M are a whole number token's two parts (no digit or `.` before, no digit
 * after: `1.2.3` and `D.2.1` hold none), 1–31 and 1–12. `D.M.YYYY` is a date whatever precedes it. Otherwise
 * it is no date when followed by `.digit`, `%`, `+`, `×`, a letter, a unit word
 * after a space or a range to one (`9.5–10.6 min`), or, when D or M has one
 * digit, `-letter` (`4.4-versjon`; `08.09-sakene` is a date); when glued to a
 * letter or a letter-hyphen before it (`v1.2`, `GPT‑5.6`); when one space after
 * a whole version word (`section 4.2`, `art. 13.1`); or, both single digits,
 * one space after a capitalised word (`Opus 4.6`, `CDM 4.4`, `S4 2.1`).
 * Accepted: `bun 1.3`, `Node 22.12`, `sedVer 4.4` read as dates; `Mandag 4.6`
 * as a version. A missed date is a missed stale passage, a false one costs
 * one on-demand check.
 */
const DM_RE = /(?<![\p{N}.])(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])(\.\d{4})?(?![\p{N}]|\.\p{N})/gu;
/** The units a space may separate from the number: kept from fix round 2. */
const DM_UNITS = "%|×|x|ms|s|sek|sec|min|minutter|minutes|h|t|timer|hours|kB|KB|MB|GB|TB|k|oz|px|pt|em|rem";
const DM_AFTER = new RegExp(`^(?:\\s*[–—-]\\s*\\d+(?:[.,]\\d+)?)?(?:[\\p{L}%+×]|\\s+(?:${DM_UNITS})(?![\\p{L}\\p{N}]))`, "u");
/** `-letter` after the match, past the same optional range: excludes only a single-digit day or month. */
const DM_AFTER_HYPHEN_WORD = /^(?:\s*[–—-]\s*\d+(?:[.,]\d+)?)?[-‐‑]\p{L}/u;
/** Glued on the left: a letter, or a letter and a hyphen (`GPT‑5.6`). */
const DM_GLUED = /(?:\p{L}|\p{L}[-‐‑])$/u;
/** A version word one space before, as a whole word only (`over 3.10` is a date). */
const DM_VERSION_WORD = /(?<![\p{L}\p{N}])(?:version|versjon|ver|v|section|seksjon|kapittel|kap\.|art\.|artikkel) $/iu;
/** A word one space before that starts with a capital or is caps and
 *  digits: `Opus`, `CDM`, `S4`, `5G`. */
const DM_CAPITAL_WORD = /(?<![\p{L}\p{N}])(?:\p{Lu}[\p{L}\p{N}]*|[\p{Lu}\p{N}]*\p{Lu}[\p{Lu}\p{N}]*) $/u;

export function hasDateDM(text: string): boolean {
  return dateDMSpan(text) !== null;
}

/** The first `D.M` date in `text` per {@link hasDateDM}, as `[start, end]`. */
function dateDMSpan(text: string): [number, number] | null {
  for (const m of text.matchAll(DM_RE)) {
    const span: [number, number] = [m.index!, m.index! + m[0].length];
    if (m[3]) return span; // a year, whatever precedes it
    const after = text.slice(m.index! + m[0].length);
    if (DM_AFTER.test(after)) continue;
    if ((m[1]!.length === 1 || m[2]!.length === 1) && DM_AFTER_HYPHEN_WORD.test(after)) continue;
    const before = text.slice(0, m.index);
    if (DM_GLUED.test(before) || DM_VERSION_WORD.test(before)) continue;
    if (m[1]!.length === 1 && m[2]!.length === 1 && DM_CAPITAL_WORD.test(before)) continue;
    return span;
  }
  return null;
}

const spanOf = (re: RegExp) => (t: string): [number, number] | null => {
  const m = re.exec(t);
  return m ? [m.index, m.index + m[0].length] : null;
};

/** What makes a passage one to check: a status word, a date (`D.M` per
 *  {@link hasDateDM}, `DD.MM.YYYY`, ISO), a PR number (`#NN…`, `PR N`) or an
 *  «N of M» count. */
const CLAIMS: readonly (readonly [string, (text: string) => [number, number] | null])[] = [
  ["date", dateDMSpan],
  ["date", spanOf(/(?<![\p{N}])20\d\d-[01]\d-[0-3]\d(?![\p{N}])/u)],
  ["PR", spanOf(/(?<![\p{L}\p{N}&/#])#\d{2,}(?![\p{N}])|(?<![\p{L}\p{N}])PR[ -]?#?\d+(?![\p{N}])/u)],
  ["count", spanOf(/(?<![\p{L}\p{N}])\d+ (?:of|av) \d+(?![\p{N}])/u)],
];

/** Links become `·` runs: no claim reads them, and a link still stands as a
 *  word before a capitalised one (`[[x]] Opus 4.6` is mid-sentence). */
const filler = (s: string) => "·".repeat(s.length);

/** The claim a passage's text makes, or undefined. Links are blanked first:
 *  a `[[plan#3]]` anchor or a `](x#12)` destination is not a PR. */
export function passageClaim(line: string): string | undefined {
  return passageClaimSpan(line)?.kind;
}

/** {@link passageClaim} with where its token sits on `line`: the masks keep
 *  every position, so the span is the line's own. */
function passageClaimSpan(line: string): { kind: string; span: [number, number] } | undefined {
  const text = maskLineCodeSpans(line)
    .replace(/\[\[[^\]\n]*\]\]/g, filler)
    .replace(/\]\([^)\n]*\)/g, filler);
  const said = statusWordsIn(text);
  if (said.length) return { kind: said[0]!, span: saidSpan(text, [said[0]!]) };
  for (const [kind, at] of CLAIMS) {
    const span = at(text);
    if (span) return { kind, span };
  }
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

/** One link on a code-masked line, `start`–`end` on the line itself. */
export interface LineLink {
  start: number;
  end: number;
  /** A wikilink's raw target capture; absent on a markdown link. */
  wiki?: string;
  /** An embed `![[x]]` (its `!` inside the span) or an image `![x](y)`. */
  bang: boolean;
}

/**
 * Every link on one line, read with the backlink graph's own grammar:
 * `WIKILINK_RE` (an embed's `!` joins its span) and `store.ts`'s markdown
 * link match (`markdownLinkSpans`, images included). Mask the line with
 * `maskLineCodeSpans` first: a code span is no link, and a masked span in a
 * link's text (`[the \`x\` table](t.md)`) leaves the link one.
 */
export function lineLinks(masked: string): LineLink[] {
  const out: LineLink[] = [];
  for (const m of masked.matchAll(WIKILINK_RE)) {
    const bang = m.index! > 0 && masked[m.index! - 1] === "!";
    out.push({ start: m.index! - (bang ? 1 : 0), end: m.index! + m[0].length, wiki: m[1]!, bang });
  }
  for (const s of markdownLinkSpans(masked)) out.push({ start: s.start, end: s.end, bang: s.image });
  return out.sort((a, b) => a.start - b.start);
}

/** Where the first link to `targetKey` sits on `line` (masked, so positions
 *  are the line's), each link read as {@link linksTo} reads it, so every
 *  line `linksTo` accepts has one; `[0, 0]` only on a line it refuses. */
function linkSpanTo(line: string, targetKey: string, fromRelPath: string, index: Pick<WikiIndex, "resolve">): [number, number] {
  const hit = lineLinks(line).find((l) => {
    if (l.wiki !== undefined) {
      const meta = index.resolve(wikilinkTarget(l.wiki) ?? "");
      return !!meta && normalizeRelPath(meta.relPath) === targetKey;
    }
    return !l.bang && resolveMarkdownTargets(fromRelPath, extractMarkdownLinks(line.slice(l.start, l.end))).includes(targetKey);
  });
  return hit ? [hit.start, hit.end] : [0, 0];
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
    const masked = maskLineCodeSpans(l);
    if (!linksTo(masked, targetKey, fromRelPath, index)) continue;
    // A17: a long line is a window holding the link to the changed page and
    // the claim, or centred on that link when the line makes none; never a
    // head cut.
    const c = inFrontmatter ? undefined : passageClaimSpan(l);
    const [ls, le] = linkSpanTo(masked, targetKey, fromRelPath, index);
    const [cs, ce] = c?.span ?? [ls, le];
    out.push({ line: i + 1, text: hitWindow(l, ls, le, cs, ce), inFrontmatter, pointerHeading: !inFrontmatter && pointerHeading, ...(c ? { claim: c.kind } : {}) });
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
 * carry its zone (`Z`, `±HH:MM` or `±HHMM`), since a zone-less one would be
 * read in the server's local time; 13 digits with a leading 1–9 are epoch ms
 * (2001-09-09 to 2286-11-20), so an epoch in seconds, zero-padded or not, is
 * refused rather than read as 1970 (F9a). A day that is
 * not on the calendar is refused too. Absent ⇒ undefined; unreadable ⇒ null.
 */
export function parseStaleAsOf(raw: string | undefined): number | undefined | null {
  const v = (raw ?? "").trim();
  if (!v) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return realDay(v) ? Date.parse(`${v}T23:59:59.999Z`) : null;
  if (/^\d+$/.test(v)) return /^[1-9]\d{12}$/.test(v) ? Number(v) : null;
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
