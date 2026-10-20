/**
 * Lint check 14 — volatile state outside its home (living-facts PR 1, D10).
 * Each volatile fact (a PR's state, a prod release, a Jira status) has one
 * home, on one page: the page whose frontmatter `owns:` lists the key. On a
 * page the homes are `<StatusRows>`, a paragraph or list item that starts with a
 * `**Status**` label, a leading-pipe table directly under a `PR ledger` / `PR-oversikt` label
 * or heading, and `status_note`. Every other line names the key and leaves the
 * state to the chip.
 *
 * | check                | fires when                                                                 |
 * |----------------------|----------------------------------------------------------------------------|
 * | `state-outside-home` | a clause outside the exempt blocks holds a state phrase or a date qualifier |
 * |                      | (`per D.M`, `per D.M.YYYY`, `(D.M)`) AND an anchor in the same clause: a    |
 * |                      | Jira key, the bare number of a key the page names, a PR reference or a      |
 * |                      | task word                                                                  |
 * | `state-not-owner`    | a home clause states the state of a key some page owns, on a page whose     |
 * |                      | `owns:` does not list it                                                   |
 * | `state-owns-unread`  | the frontmatter has `owns:` and it names no Jira key (one per page)         |
 *
 * Scope: live report pages (`isLiveReportPage`) outside `archive/`, not
 * reserved or culled. Frontmatter `description` is linted; `status_note` is a
 * home. Exempt from check 1, besides the homes: `<Timeline>`, `<DecisionLog>`,
 * `<Historic>` (each exactly where `parseBlocks` makes a block of it),
 * blockquote lines (a line that opens with `>`), code fences by the reader's
 * rule (`readerFencedLines`: backticks only, an unclosed opener stays prose),
 * inline code, and the header row of each table `parseBlocks` makes. HTML and
 * JSX comments are linted: this reader renders them as visible text. Lanes and
 * plain tables are linted.
 * The frontmatter ends where the store's does (`frontmatterBodyLine`).
 *
 * Off unless `.wiki-reader.json` declares `statePhrases`
 * (`src/format/state-phrases.ts`): the phrases and task words are the wiki's
 * own, so a public repo carries no domain list.
 *
 * A clause ({@link stateClauses}) is the text between `·`, `;` or a sentence
 * end (closing `*`/`_` emphasis may follow the period); a table row is one
 * clause. A state phrase belongs to the nearest key in
 * its clause, and a home clause with no key states the page's own work, so it
 * is never a finding. Known gap: a clause that names only a PR cannot be
 * attributed to a key.
 */

import { maskLineCodeSpans } from "../format/code-spans.ts";
import { COMPONENT_OPEN_RE, INLINE_COMPONENT_NAMES, listItemLines, parseBlocks, readerFencedLines, type Block, type ListChild } from "../format/markdown-ast.ts";
import type { StatePhrasesConfig } from "../format/state-phrases.ts";
import { isLedgerLabel } from "../format/pr-ledger.ts";
import { escapeRegExp } from "../utils/escape-regexp.ts";
import { JIRA_KEY_DENYLIST } from "../jira/key-scan.ts";
import { JIRA_KEY_SOURCE } from "../jira/retrieval.ts";
import { normalizeJiraKey } from "./provenance.ts";
import { stampedKeys } from "./trackers/jira.ts";
import { isLiveReportPage } from "./lint-drift.ts";
import { ownerCensus, readOwns } from "./frontmatter-lists.ts";
import { frontmatterBodyLine } from "./page-text.ts";
import type { WikiPageMeta } from "./store.ts";
import type { LintFinding } from "./lint.ts";

export const STATE_LINT_CHECKS = ["state-outside-home", "state-not-owner", "state-owns-unread"] as const;

/** Blocks whose lines check 1 skips: history, and the one block home. */
const HISTORY_BLOCKS: readonly string[] = ["Timeline", "DecisionLog", "Historic"];
const HOME_BLOCK = "StatusRows";

/** Month words after `12.`: the day of a date, not a sentence end or a key number. */
const MONTHS =
  "januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember|" +
  "january|february|march|may|june|july|october|december|jan|feb|mar|apr|jun|jul|aug|sept?|okt|oct|nov|des|dec";

/** A Jira-shaped key. On a wiki whose trackers name projects the prefix must be
 *  one of them and the number has no leading zero (`trackers/jira.ts`'s rule);
 *  otherwise the shared {@link JIRA_KEY_SOURCE} with its denylist, so `UTF-8`
 *  and `SHA-256` are not keys. Never followed by `-` and a digit, so
 *  `DEMO-2026-09` is not `DEMO-2026`. */
function jiraKeyRe(projects: readonly string[]): RegExp {
  const key =
    projects.length > 0 ? `(?:${projects.map(escapeRegExp).join("|")})-[1-9]\\d{0,7}` : JIRA_KEY_SOURCE;
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${key}(?![\\p{L}\\p{N}_]|-\\d)`, "gu");
}

/** Exactly these keys, with the same edges: a key some page `owns:` or this
 *  page names is a key whatever its prefix. */
function exactKeysRe(keys: Iterable<string>): RegExp | null {
  const list = [...new Set(keys)].sort((a, b) => b.length - a.length).map(escapeRegExp);
  if (list.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${list.join("|")})(?![\\p{L}\\p{N}_]|-\\d)`, "gu");
}

/**
 * A PR reference: a pull URL, `PR #n`, `owner/repo#n`, `repo#n`, or a bare
 * `#nnn` (which also covers `api #3523`). Read over text whose link destinations and wikilinks are
 * blanked ({@link maskLinks}), so a `#3-steg` fragment is no reference. The
 * left edge is `store.ts`'s `PR_REF_SOURCE` class plus `#` and `&`, so
 * `foo.md#2`, `v1.2#5` and `&#123;` are not; a repo is lower-case, so
 * `Shipyard#697` is another tracker. Unlike `store.ts`'s `prRefs`, which pairs
 * pages and so takes a bare `#N` for an anchor or a count, this check reads a
 * bare `#nnn` as a PR: the kode-wiki writes its PRs that way. Three digits keep
 * `#1 prioritet` out.
 */
const PR_LEFT = "(?<![A-Za-z0-9._/@#&-])";
const PR_RIGHT = "(?![\\p{L}\\p{N}])";
const PR_REF_RE = new RegExp(
  [
    "https?://[^\\s)]+/pull/\\d+",
    `(?<![\\p{L}\\p{N}])PR[ \\t]?#\\d+${PR_RIGHT}`,
    `${PR_LEFT}[A-Za-z0-9_-]+/[a-z][a-z0-9_-]*#\\d+${PR_RIGHT}`,
    `${PR_LEFT}[a-z][a-z0-9_-]*#\\d+${PR_RIGHT}`,
    `(?<![\\p{L}\\p{N}&#/.\\]])#\\d{3,}${PR_RIGHT}`,
  ].join("|"),
  "gu",
);
/** A date qualifier: `per 11.10`, `per 11.10.2026`, `(11.10)`. */
const DATE_QUALIFIER_RE = /(?<![\p{L}\p{N}])per\s+\d{1,2}\.\d{1,2}(?:\.\d{4})?(?![\p{N}])|\(\d{1,2}\.\d{1,2}\)/giu;
/**
 * A paragraph that is a home: `**Status` with an optional date and an optional
 * `:` or `.`, then `**` — `**Status:**`, `**Status.**`, `**Status 28.09:**`,
 * `**Status 12.10.2026**` — after an optional list marker. `**Statusen**` is not.
 */
const STATUS_PARA_RE = /^(?:[-*+]\s+|\d+[.)]\s+)?\*\*Status(?:\s+\d{1,2}\.\d{1,2}(?:\.\d{2,4})?\.?)?[:.]?\*\*/;
/** A blockquote line. `- > x` is a list item: the reader shows its `>`. */
const QUOTE_RE = /^>/;
const INLINE_TAG_RE = new RegExp(`^<(?:${INLINE_COMPONENT_NAMES.join("|")})(?=[\\s>/])`);

/** One case-insensitive, word-edged alternation over `words`, longest first so
 *  `ikke opprettet` wins over `opprettet` at the same place. */
function wordsRe(words: readonly string[]): RegExp | null {
  if (words.length === 0) return null;
  const alt = [...words].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, "giu");
}

/**
 * Task words. A word with an upper-case letter (`PR`, `PR-er`) matches as
 * written, so `e2e-pr.yml` is no PR; an all-lower-case word (`oppgave`) matches
 * any case. Neither may touch a `.`/`/` path neighbour or a letter, but a
 * hyphen is fine on the left (`api-PR 2`). A task word anchors only next to a
 * number: one after it names a piece of work (`PR 1`, `PR 1–4`, `oppgave #3`),
 * one before it counts pieces of work (`8 PR-er`, `7 av 8 PR-er`). A bare one
 * (`når PR-en er merget`, a `| Service-PR |` column) is generic prose about no
 * piece of work. The count's number, or range (`1-3 PR`, `1–3 PR`), stands
 * alone: not the end of a version, date, time or decimal (`1.2 PR`, `06.10 PR`,
 * `6/10 PR`, `14:30 PR`, `1,5 PR`), a key (`DEMO-8 PR`) or a word (`v2 PR`).
 * A plural the wiki does not list (`3 oppgaver` for `oppgave`) is no count.
 */
function taskWordsRes(words: readonly string[]): { re: RegExp; count: boolean }[] {
  const named = (alt: string, flags: string) =>
    new RegExp(`(?<![\\p{L}\\p{N}_./])(?:${alt})(?=[ \\t\\u00a0]?#?\\d)`, flags);
  const counted = (alt: string, flags: string) =>
    new RegExp(
      `(?<=(?<![\\p{L}\\p{N}_.#:/-])(?<!\\p{N},)(?:\\p{N}+[-–])?\\p{N}+[ \\t\\u00a0])(?:${alt})(?![\\p{L}\\p{N}_/]|\\.[\\p{L}\\p{N}])`,
      flags,
    );
  const alt = (ws: string[]) => ws.sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  const cased = words.filter((w) => /\p{Lu}/u.test(w));
  const folded = words.filter((w) => !/\p{Lu}/u.test(w));
  const out: { re: RegExp; count: boolean }[] = [];
  for (const [ws, flags] of [[cased, "gu"], [folded, "giu"]] as const) {
    if (ws.length === 0) continue;
    out.push({ re: named(alt(ws), flags), count: false }, { re: counted(alt(ws), flags), count: true });
  }
  return out;
}

/** Number → the one key it is the number of, or `null` when two keys share it.
 *  Only numbers of three or more digits: `i prod i 7 dager` names no key. */
function keyNumbers(keys: Iterable<string>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const k of keys) {
    const n = /-(\d{3,})$/.exec(k)?.[1];
    if (!n) continue;
    const had = out.get(n);
    if (had === undefined) out.set(n, k);
    else if (had !== k) out.set(n, null);
  }
  return out;
}

/** A bare key number: not inside a longer number or a path, not a PR number
 *  (`PR 3538`, `#3538`), not the day of a date (`120. oktober`). */
function numbersRe(numbers: Iterable<string>): RegExp | null {
  const list = [...numbers].sort((a, b) => b.length - a.length);
  if (list.length === 0) return null;
  return new RegExp(
    `(?<![\\p{L}\\p{N}\\-#/.])(?<!PR\\s?)(?:${list.join("|")})(?![\\p{N}]|\\.\\d|\\.\\s+(?:${MONTHS})(?![\\p{L}]))`,
    "giu",
  );
}

/** A page the state checks read: its meta, its raw content, its frontmatter. */
export interface StatePage {
  page: WikiPageMeta;
  content: string;
  fm: Record<string, string | string[]>;
}

/** A page check 14 lints: a live report page outside `archive/`. The caller
 *  has already left out reserved and culled pages. */
export function isStateScopePage(relPath: string, fm: Record<string, unknown>, planStatus: string | undefined): boolean {
  return relPath.split("/")[0] !== "archive" && isLiveReportPage(relPath, fm, planStatus);
}

/** Text units of a page: one or more 0-based lines read as one string. A body
 *  line is a unit; a frontmatter `description`/`status_note` with its
 *  continuation lines is one; `row` marks a table row (one clause). */
interface Unit {
  lines: number[];
  row?: true;
}

/** Where each line of a page stands. `home` units are exempt from check 1 and
 *  are what check 2 reads; lines in neither are read by neither check. */
interface LineRoles {
  linted: Unit[];
  home: Unit[];
  /** The page's lines as the checks read them: CRLF folded. */
  lines: string[];
}

/** Blank a span same-length, newlines kept, so offsets and lines survive. */
const blank = (s: string) => s.replace(/[^\n]/g, " ");

/** The last line of the tracked block whose tag opens line `start`: the
 *  parser's own close rule (a line that is exactly `</Name>`, same-name
 *  nesting counted, fenced lines skipped). */
function blockEnd(lines: readonly string[], fenced: readonly boolean[], start: number, name: string): number {
  const m = COMPONENT_OPEN_RE.exec(lines[start]!.trim());
  const close = `</${name}>`;
  if (!m || m[3] === "/" || m[4]!.includes(close)) return start;
  let depth = 1;
  for (let j = start + 1; j < lines.length; j++) {
    if (fenced[j]) continue;
    const t = lines[j]!.trim();
    if (t === close) {
      if (--depth === 0) return j;
      continue;
    }
    const o = COMPONENT_OPEN_RE.exec(t);
    if (o && o[1] === name && o[3] !== "/" && !o[4]!.includes(close)) depth++;
  }
  return lines.length - 1;
}

/** The list items `parseBlocks` makes: the first line of every item, and every
 *  line of an item whose first line is a `**Status**` label. */
interface ParsedItems {
  starts: Set<number>;
  status: Set<number>;
}

/** Lines inside a tracked block, by `parseBlocks`: a tag the parser renders as
 *  text (a multi-line opener, a close mid-line, trailing prose) opens nothing.
 *  `headers` gets the header row of every table the parser makes: column
 *  labels, not state. `items` gets the parser's list items. */
function trackedLines(
  lines: readonly string[],
  fenced: readonly boolean[],
  body: number,
  headers: Set<number>,
  items: ParsedItems,
): Map<number, "home" | "history"> {
  const roles = new Map<number, "home" | "history">();
  const walkList = (children: readonly ListChild[]) => {
    for (const c of children) {
      if (c.type !== "ul" && c.type !== "ol") continue;
      for (const src of listItemLines(c) ?? []) {
        const at = src.map((l) => body + l);
        items.starts.add(at[0]!);
        if (STATUS_PARA_RE.test(lines[at[0]!]!.trim())) for (const l of at) items.status.add(l);
      }
      for (const n of c.nested ?? []) walkList(n ?? []);
    }
  };
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.type === "table" && b.line !== undefined) headers.add(body + b.line);
      if (b.type === "ul" || b.type === "ol") walkList([b]);
      if (b.type !== "component") continue;
      if (b.line !== undefined && (b.name === HOME_BLOCK || HISTORY_BLOCKS.includes(b.name))) {
        const start = body + b.line;
        const end = blockEnd(lines, fenced, start, b.name);
        for (let k = start; k <= end; k++) {
          if (b.name === HOME_BLOCK) roles.set(k, "home");
          else if (!roles.has(k)) roles.set(k, "history");
        }
      }
      walk(b.children);
    }
  };
  walk(parseBlocks(lines.slice(body).join("\n")));
  return roles;
}

/** Each pipe-table row line → the first line of its table: a run of lines that
 *  start with `|`. Rows without a leading pipe render as text. */
function tableRows(lines: readonly string[], fenced: readonly boolean[], body: number): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = body; i < lines.length; i++) {
    if (fenced[i]) continue;
    const t = lines[i]!.trim();
    let j = i;
    if (t.startsWith("|")) {
      while (j < lines.length && !fenced[j] && lines[j]!.trim().startsWith("|")) out.set(j++, i);
    }
    if (j > i) i = j - 1;
  }
  return out;
}

/** A line that starts a new block, ending a paragraph: a list item the parser
 *  makes (`item`), a heading, a pipe row or a block tag. An inline component
 *  (`<Pill>`) continues the paragraph. A fence line is no case here: a fence the
 *  reader pairs is `fenced` and ends the paragraph before this is asked, and a
 *  `~~~` line or an unclosed opener is prose the reader keeps in it. */
function startsBlock(t: string, item: boolean): boolean {
  if (item || /^(?:#{1,6}\s|\|)/.test(t)) return true;
  return t.startsWith("<") && !INLINE_TAG_RE.test(t);
}

/**
 * Classify a page's lines. Frontmatter: `description` and `status_note`, each
 * with its indented continuation lines (a quoted, plain or block scalar, blank
 * lines inside a block scalar included), are a linted unit and a home unit;
 * the rest is neither. Body: fences, blockquote lines and the three history
 * blocks are exempt; `<StatusRows>`,
 * a `**Status**` paragraph or list item and a PR-ledger table are homes; every other line
 * is linted.
 */
export function stateLineRoles(content: string): LineRoles {
  // Folded once, so `lines`, the frontmatter boundary and `readerFencedLines`
  // (which folds its own input too) all count the same lines.
  const folded = content.replace(/\r\n/g, "\n");
  const lines = folded.split("\n");
  // The store's boundary: a column-0 `---` ends the frontmatter, so an indented
  // one inside a block scalar is still frontmatter.
  const body = frontmatterBodyLine(folded);
  // The reader's fence rule over the body it renders: backticks only, and an
  // opener with no closer stays prose. Frontmatter lines are never fenced.
  const fenced = [...new Array<boolean>(body).fill(false), ...readerFencedLines(lines.slice(body).join("\n"))];
  const linted: Unit[] = [];
  const home: Unit[] = [];

  if (body > 0) {
    for (let i = 1; i < body - 1; i++) {
      const m = /^(description|status_note):/.exec(lines[i]!);
      if (!m) continue;
      const unit = [i];
      for (let k = i + 1; k < body - 1 && (lines[k]!.trim() === "" || /^\s/.test(lines[k]!)); k++) unit.push(k);
      while (unit.length > 1 && lines[unit.at(-1)!]!.trim() === "") unit.pop();
      (m[1] === "description" ? linted : home).push({ lines: unit });
      i = unit.at(-1)!;
    }
  }

  const headers = new Set<number>();
  const items: ParsedItems = { starts: new Set(), status: new Set() };
  const tracked = trackedLines(lines, fenced, body, headers, items);
  const tables = tableRows(lines, fenced, body);
  let statusPara = false;
  let ledger = false;
  const reset = () => {
    statusPara = false;
    ledger = false;
  };
  for (let i = body; i < lines.length; i++) {
    if (fenced[i]) {
      reset();
      continue;
    }
    const role = tracked.get(i);
    if (role) {
      reset();
      if (role === "home") home.push({ lines: [i] });
      continue;
    }
    const t = lines[i]!.trim();
    if (t === "") {
      reset();
      continue;
    }
    // A list item opening with the label is a home to the item's own end.
    if (items.status.has(i)) {
      reset();
      home.push({ lines: [i] });
      continue;
    }
    // The reader renders the unprefixed line after a quote as its own text.
    if (QUOTE_RE.test(t)) {
      reset();
      continue;
    }

    // A `**Status**` paragraph runs to the next blank line or block start.
    if (STATUS_PARA_RE.test(t)) statusPara = true;
    else if (statusPara && startsBlock(t, items.starts.has(i))) statusPara = false;
    if (statusPara) {
      home.push({ lines: [i] });
      continue;
    }

    // A table whose nearest non-blank line above is a PR-ledger label.
    const tableStart = tables.get(i);
    if (tableStart !== undefined) {
      if (tableStart === i) {
        let j = i - 1;
        while (j >= body && lines[j]!.trim() === "") j--;
        ledger = j >= body && isLedgerLabel(lines[j]!);
      }
      if (headers.has(i)) continue;
      if (ledger) {
        home.push({ lines: [i], row: true });
        continue;
      }
      linted.push({ lines: [i], row: true });
      continue;
    }
    ledger = false;
    linted.push({ lines: [i] });
  }
  return { linted, home, lines };
}

/**
 * Where each clause ends, as `[start, end)` spans: at `·`, `;`, or a `.`/`!`/`?`
 * followed, after any closing `*`/`_` run, by whitespace or the end. A `)`, `»`
 * or `"` after the period is no end: an abbreviation closing a parenthetical or
 * a quote (`(tester osv.) er merget`) is mid-sentence. Not inside a matched `[...]` (a link text,
 * a wikilink), and not at a date's own period (`13.10. merget`, `12. oktober`).
 * A table row is one clause. Not `trackers/jira.ts`'s `clauseBoundaries`, which
 * splits a table row by cell and a date at its period, nor `lint-drift.ts`'s
 * leading-clause regex.
 */
const SENTENCE_CLOSERS = "*_";

export function stateClauses(text: string, row = false): [number, number][] {
  if (row) return [[0, text.length]];
  const matched = new Set<number>();
  const open: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "[") open.push(i);
    else if (text[i] === "]" && open.length > 0) matched.add(open.pop()!);
  }
  const out: [number, number][] = [];
  let from = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "[") {
      if (matched.has(i)) depth++;
      continue;
    }
    if (ch === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    let end = ch === "·" || ch === ";";
    if (!end && (ch === "." || ch === "!" || ch === "?")) {
      let j = i + 1;
      while (j < text.length && SENTENCE_CLOSERS.includes(text[j]!)) j++;
      if (j === text.length || /\s/.test(text[j]!)) {
        const before = text.slice(Math.max(0, i - 12), i);
        const dateDot = ch === "." && /(?<![\d.])\d{1,2}\.\d{1,2}$/.test(before);
        const dayDot = ch === "." && /(?<![\d.])\d{1,3}$/.test(before) && new RegExp(`^\\s+(?:${MONTHS})(?![\\p{L}])`, "iu").test(text.slice(j));
        end = !dateDot && !dayDot;
      }
    }
    if (end) {
      out.push([from, i]);
      from = i + 1;
    }
  }
  out.push([from, text.length]);
  return out;
}

interface Hit {
  text: string;
  start: number;
  /** The key a key or bare-number hit names; `null` for an ambiguous number. */
  key?: string | null;
}

function allMatches(re: RegExp | null, text: string): Hit[] {
  if (!re) return [];
  re.lastIndex = 0;
  return [...text.matchAll(re)].map((m) => ({ text: m[0], start: m.index! }));
}

/** Wikilinks and link destinations blanked, for the PR-reference scan; a pull
 *  URL in a destination is kept, since it names a PR. */
function maskLinks(text: string): string {
  return text
    .replace(/\[\[[^\]\n]*\]\]/g, blank)
    .replace(/\]\(([^)\n]*)\)/g, (m) => "](" + m.slice(2, -1).replace(/(https?:\/\/[^\s)]+\/pull\/\d+)|[^\n]/g, (c, url) => url ?? " ") + ")");
}

/** Character gap between two hits (0 when they overlap). */
function gap(a: Hit, b: Hit): number {
  const aEnd = a.start + a.text.length;
  const bEnd = b.start + b.text.length;
  return b.start >= aEnd ? b.start - aEnd : a.start >= bEnd ? a.start - bEnd : 0;
}

const nearest = <T extends Hit>(to: Hit, hits: readonly T[]): T => hits.reduce((x, y) => (gap(to, y) < gap(to, x) ? y : x));

/** `"a", "b"` quoted the reader's way. */
const quoted = (xs: readonly string[]) => xs.map((x) => `«${x}»`).join(", ");

/** A unit's text — its lines joined by one space — and the line of an offset. */
function unitText(lines: readonly string[], unit: Unit): { text: string; lineAt: (pos: number) => number } {
  const parts = unit.lines.map((i) => maskLineCodeSpans(lines[i]!));
  const starts: number[] = [];
  let off = 0;
  for (const p of parts) {
    starts.push(off);
    off += p.length + 1;
  }
  return {
    text: parts.join(" "),
    lineAt: (pos) => {
      let k = 0;
      while (k + 1 < starts.length && starts[k + 1]! <= pos) k++;
      return unit.lines[k]!;
    },
  };
}

const inClause = (hits: readonly Hit[], [s, e]: [number, number]) => hits.filter((h) => h.start >= s && h.start < e);

/**
 * Run the state checks over the live report pages in `pages`. `owners` maps
 * every key some page in the wiki owns to the pages that own it. `trackerProjects`
 * is the union of the wiki's tracker projects; empty ⇒ any Jira-shaped key.
 */
export function checkState(
  pages: readonly StatePage[],
  owners: ReadonlyMap<string, readonly string[]>,
  cfg: StatePhrasesConfig,
  trackerProjects: readonly string[] = [],
): LintFinding[] {
  const JIRA_KEY_RE = jiraKeyRe(trackerProjects);
  const phraseRe = wordsRe(cfg.phrases);
  const taskRes = taskWordsRes(cfg.taskWords);
  const findings: LintFinding[] = [];

  for (const { page, content, fm } of pages) {
    const roles = stateLineRoles(content);
    const lines = roles.lines;
    const own = readOwns(content).keys;
    const named = [...new Set([...own, ...stampedKeys(fm.jira)])];
    const exactRe = exactKeysRe([...owners.keys(), ...named]);
    const isDenied = (k: string) => trackerProjects.length === 0 && JIRA_KEY_DENYLIST.has(k.slice(0, k.indexOf("-")));
    const keyHits = (text: string): Hit[] => {
      const seen = new Set<number>();
      const out: Hit[] = [];
      for (const h of allMatches(exactRe, text)) {
        seen.add(h.start);
        out.push({ ...h, key: normalizeJiraKey(h.text) });
      }
      for (const h of allMatches(JIRA_KEY_RE, text)) {
        if (seen.has(h.start) || isDenied(h.text)) continue;
        out.push({ ...h, key: normalizeJiraKey(h.text) });
      }
      return out;
    };
    const namedNumbers = keyNumbers(named);
    const namedRe = numbersRe(namedNumbers.keys());

    // ── Check 1: state outside its home ────────────────────────────────────
    for (const unit of roles.linted) {
      const { text, lineAt } = unitText(lines, unit);
      const phrases = allMatches(phraseRe, text);
      const states = [...phrases, ...allMatches(DATE_QUALIFIER_RE, text)];
      if (states.length === 0) continue;
      const counts = taskRes.filter((t) => t.count).flatMap((t) => allMatches(t.re, text));
      const anchors = [
        ...keyHits(text),
        ...allMatches(namedRe, text),
        ...allMatches(PR_REF_RE, maskLinks(text)),
        ...taskRes.filter((t) => !t.count).flatMap((t) => allMatches(t.re, text)),
      ];
      if (anchors.length === 0 && counts.length === 0) continue;
      const byLine = new Map<number, { states: string[]; anchor: string }>();
      for (const clause of stateClauses(text, unit.row)) {
        const cs = inClause(states, clause).sort((a, b) => a.start - b.start);
        // A count (`3 PR-er`) anchors a state phrase only: beside a date alone
        // it is a dated record (`| abc123 (11.09) | 3 PR-er | $140 |`).
        const ca = [...inClause(anchors, clause), ...(inClause(phrases, clause).length > 0 ? inClause(counts, clause) : [])];
        if (cs.length === 0 || ca.length === 0) continue;
        for (const s of cs) {
          const line = lineAt(s.start);
          const entry = byLine.get(line) ?? { states: [], anchor: nearest(s, ca).text };
          if (!entry.states.includes(s.text)) entry.states.push(s.text);
          byLine.set(line, entry);
        }
      }
      for (const [line, { states: ss, anchor }] of [...byLine].sort((a, b) => a[0] - b[0])) {
        findings.push({
          check: "state-outside-home",
          relPath: page.relPath,
          line: line + 1,
          message: `State outside its home: ${quoted(ss)} beside ${quoted([anchor])} — write state only in <StatusRows>, a **Status:** paragraph, the PR ledger or status_note, and name the key or PR elsewhere (D10)`,
        });
      }
    }

    // ── Check 2: a home states a key this page does not own ────────────────
    if (owners.size === 0) continue;
    const ownSet = new Set(own);
    const allNumbers = keyNumbers([...owners.keys(), ...named]);
    const numRe = numbersRe(allNumbers.keys());
    const reported = new Set<string>();
    for (const unit of roles.home) {
      const { text, lineAt } = unitText(lines, unit);
      const phrases = allMatches(phraseRe, text);
      if (phrases.length === 0) continue;
      const keys = [...keyHits(text), ...allMatches(numRe, text).map((h) => ({ ...h, key: allNumbers.get(h.text) ?? null }))];
      for (const clause of stateClauses(text, unit.row)) {
        const ck = inClause(keys, clause);
        if (ck.length === 0) continue; // the page's own work
        for (const p of inClause(phrases, clause)) {
          const key = nearest(p, ck).key;
          if (!key) continue; // a number two keys share names neither
          const ownedBy = owners.get(key);
          const line = lineAt(p.start);
          if (!ownedBy || ownSet.has(key) || reported.has(`${line}:${key}`)) continue;
          reported.add(`${line}:${key}`);
          findings.push({
            check: "state-not-owner",
            relPath: page.relPath,
            line: line + 1,
            message: `${quoted([p.text])} states ${key}, which ${ownedBy.join(", ")} owns (owns:) — name the key here and keep its state on the owning page (D10)`,
          });
        }
      }
    }
  }
  return findings;
}

/** A page that may own keys: its relPath and its raw content. */
export interface OwnerPage {
  relPath: string;
  content: string;
}

/** The wiki-wide owner map: key → the pages whose `owns:` lists it
 *  (`ownerCensus`, which also leaves out reserved pages; the caller leaves out
 *  culled ones). */
export function stateOwners(pages: Iterable<OwnerPage>): Map<string, string[]> {
  return ownerCensus([...pages].map(({ relPath, content }) => ({ relPath, owns: readOwns(content).keys })));
}

/** `state-owns-unread`: an `owns:` that names no key would leave the page owning
 *  nothing in silence — `owns:`, `owns: []`, `owns: ~`, `owns: TBD`, a value that
 *  does not parse. One finding per page, on the `owns:` line. An `owns:` that
 *  names a key drops its other entries quietly; a page with no `owns:` owns
 *  nothing and is not reported. */
export function checkOwnsEntries(pages: Iterable<OwnerPage>): LintFinding[] {
  const out: LintFinding[] = [];
  for (const { relPath, content } of pages) {
    const owns = readOwns(content);
    if (!owns.present || owns.keys.length > 0) continue;
    out.push({
      check: "state-owns-unread",
      relPath,
      line: owns.line + 1,
      message: `owns: ${owns.raw ? quoted([owns.raw]) : "(empty)"} names no Jira key, so this page owns nothing — write the key (owns: [PROJ-123]) or remove owns:`,
    });
  }
  return out;
}
