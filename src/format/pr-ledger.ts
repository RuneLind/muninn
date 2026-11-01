/**
 * The PR ledger on a plan page: the table under a `**PR ledger.**` /
 * `**PR-oversikt.**` label, read row by row into a PR and its state.
 *
 * Pure and server-free: `web-format.ts` reads it, and web-format ships in the
 * chat bundle. Lint check 14 (`src/wiki/lint-state.ts`) imports the label
 * helpers from here, so a ledger is one shape for both.
 *
 * A row's state, in order (a state word in prose never counts):
 *  1. a state word followed by a PR link or a commit sha, in the state cell,
 *     then the Landed cell;
 *  2. else a state word at the start of the state cell, emphasis or a link
 *     bracket around it allowed (`[merget](…)`);
 *  1b. else rule 1 in any other cell, so prose there never beats the state cell;
 *  3. else a merged-PR link alone in a «Landed»/«Landet» cell reads as merged:
 *     a markdown PR link, never a bare `repo #n`.
 * A row matching none is `unknown`. Struck text (`~~…~~`) is removed before
 * the state and the link are read; the slate and label read through it.
 * A PR ref is a markdown PR link (`linkNumber`) or a bare `PR #n`,
 * `owner/repo#n`, `repo #n`, `repo#n` (`bareNumber`).
 *
 * The strip draws a ledger only when its header names a state column
 * (State/Status/Tilstand, a parenthetical qualifier allowed) and at least {@link LEDGER_PARSED_MIN} of its rows
 * parse to a known state.
 */

import type { Block } from "./markdown-ast.ts";

/** A ledger label's own text, once heading marks, `**` and a trailing `:`/`.`
 *  are gone: the label alone, or with a short parenthetical. */
export const LEDGER_LABEL_RE = /^(?:PR[ -]ledger|PR-oversikt)(?:\s*\([^()]{1,40}\))?$/i;

/** Does this label line name the PR ledger and nothing else? */
export function isLedgerLabel(line: string): boolean {
  const label = line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .replace(/[:.]$/, "")
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .trim();
  return LEDGER_LABEL_RE.test(label);
}

export type PrState =
  | "merged"
  | "dropped"
  | "closed"
  | "open"
  | "measurement"
  | "not-started"
  | "blocked"
  | "optional"
  | "planned"
  | "unknown";

/** The state words, English and Norwegian, longest first per state. */
const STATE_WORDS: readonly [string, Exclude<PrState, "unknown">][] = [
  ["not started", "not-started"],
  ["ikke startet", "not-started"],
  ["measurement", "measurement"],
  ["forkastet", "dropped"],
  ["blokkert", "blocked"],
  ["planlagt", "planned"],
  ["optional", "optional"],
  ["valgfri", "optional"],
  ["blocked", "blocked"],
  ["planned", "planned"],
  ["dropped", "dropped"],
  ["merged", "merged"],
  ["merget", "merged"],
  ["landed", "merged"],
  ["landet", "merged"],
  ["closed", "closed"],
  ["lukket", "closed"],
  ["måling", "measurement"],
  ["open", "open"],
  ["åpen", "open"],
];

const STATE_ALT = STATE_WORDS.map(([w]) => w.replace(/ /g, "\\s+")).join("|");

/** Words that number something other than a PR (`step #3`): no repo slug.
 *  A state or prose word before a ref (`reverted #5`) stays a ref; rule 3
 *  reads links only, so it never reads that prose as merged. */
const NUMBERING_WORDS = new Set([
  "step", "steg", "phase", "fase", "item", "punkt", "task", "oppgave", "row", "rad", "round", "runde",
  "batch", "slice", "part", "del", "issue", "issues", "sak", "saker", "no", "nr", "number", "nummer",
  "case", "line", "linje", "version", "versjon", "comment", "kommentar", "ticket", "card", "kort",
  "finding", "funn", "check", "sjekk", "option", "page", "side", "test", "run", "question", "decision",
]);

/** A markdown link, an optional `"title"` after the URL. Every part stops at
 *  the next bracket, parenthesis or quote, so a scan is linear. */
const MD_LINK_RE = /\[([^[\]\n]*)\]\(([^()\s]*)(?:[ \t]+"[^"\n]*")?\)/g;
const PR_URL_RE = /\/(?:pulls?|merge_requests)\/(\d{1,6})(?!\d)/;
/** A bare ref: `PR #n` (any case), `owner/repo#n`, `repo #n` or `repo#n`.
 *  Groups: 1 PR, 2 owner, 3 its repo, 4 a repo alone, 5 the number. The slug
 *  rules are checked in {@link bareNumber}. */
const BARE_SRC = String.raw`(?:([Pp][Rr]) ?|([A-Za-z0-9][\w.-]*)\/([a-z0-9._-]+)|([a-z0-9._-]+) ?)#(\d{1,6})`;
/** A bare ref in running text. It starts only after a character no slug or
 *  owner holds, so a run of slug characters has one start and a scan is linear. */
const BARE_REF_RE = new RegExp(String.raw`(?<![\p{L}\p{N}_/#[\].-])${BARE_SRC}(?![\p{L}\p{N}])`, "gu");
/** A link text that is exactly one ref: `#n`, or a bare ref. */
const LINK_TEXT_RE = new RegExp(String.raw`^(?:#(\d{1,6})|${BARE_SRC})$`, "u");
/** A commit sha at a position: 7–40 hex in backticks, or bare with both a digit and a letter a–f. */
const SHA_AT_RE = /`[0-9a-f]{7,40}`|(?=[0-9a-f]{0,39}\d)(?=[0-9a-f]{0,39}[a-f])[0-9a-f]{7,40}(?![\p{L}\p{N}])/uy;

interface Ref {
  n: number;
  start: number;
  end: number;
  /** A markdown PR link (rule 3 reads these), not a bare ref. */
  link: boolean;
}

/** A repo slug starts and ends with `[a-z0-9]` (`step-#3`, `nr. #5` are none)
 *  and holds a letter (`2026-03-12 #4` is a date). */
function slugOk(slug: string): boolean {
  return /^[a-z0-9]/.test(slug) && /[a-z0-9]$/.test(slug) && /[a-z]/.test(slug);
}

/** The number of a bare-ref match ({@link BARE_SRC}'s groups from `g`), or
 *  null when its slug breaks the rules. An owner skips the stoplist. */
function bareNumber(m: RegExpExecArray | RegExpMatchArray, g: number): number | null {
  const n = Number(m[g + 4]);
  if (m[g] !== undefined) return n;
  if (m[g + 2] !== undefined) return slugOk(m[g + 2]!) ? n : null;
  const repo = m[g + 3]!;
  return slugOk(repo) && !NUMBERING_WORDS.has(repo) ? n : null;
}

/** The number of a markdown link that is a PR link: its URL is a pull or
 *  merge request, or its text is exactly one ref and its URL no issue or anchor. */
function linkNumber(text: string, url: string): number | null {
  const byUrl = PR_URL_RE.exec(url);
  if (byUrl) return Number(byUrl[1]);
  if (url.startsWith("#") || /\/issues\//.test(url)) return null;
  const m = LINK_TEXT_RE.exec(text.trim().replace(/^`|`$/g, ""));
  if (!m) return null;
  return m[1] !== undefined ? Number(m[1]) : bareNumber(m, 2);
}

/** Every PR link and bare ref in a text, in order, and whether the text holds
 *  a link that is no PR link. A bare ref inside a link's text is no ref. */
function scanRefs(text: string): { refs: Ref[]; otherLink: boolean } {
  const refs: Ref[] = [];
  let otherLink = false;
  let masked = "";
  let last = 0;
  for (const m of text.matchAll(MD_LINK_RE)) {
    const n = linkNumber(m[1]!, m[2]!);
    if (n === null) otherLink = true;
    else refs.push({ n, start: m.index, end: m.index + m[0].length, link: true });
    masked += text.slice(last, m.index) + " ".repeat(m[0].length);
    last = m.index + m[0].length;
  }
  masked += text.slice(last);
  for (const m of masked.matchAll(BARE_REF_RE)) {
    const n = bareNumber(m, 1);
    if (n !== null) refs.push({ n, start: m.index, end: m.index + m[0].length, link: false });
  }
  return { refs: refs.sort((a, b) => a.start - b.start), otherLink };
}

/** Rule 1 in one cell: a state word, then (after optional emphasis, space
 *  and `in`/`i`) a PR link, a bare ref or a commit sha. */
const STATE_WORD_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${STATE_ALT})(?![\\p{L}\\p{N}])`, "giu");
const GAP_RE = /[*_]*[ \t]+[*_]*/y;
const IN_RE = /(?:in|i)[ \t]+[*_]*/iy;
function wordThenRef(cell: string): Exclude<PrState, "unknown"> | null {
  let starts: Set<number> | null = null;
  for (const m of cell.matchAll(STATE_WORD_RE)) {
    GAP_RE.lastIndex = m.index + m[0].length;
    if (!GAP_RE.exec(cell)) continue;
    const at = [GAP_RE.lastIndex];
    IN_RE.lastIndex = GAP_RE.lastIndex;
    if (IN_RE.exec(cell)) at.push(IN_RE.lastIndex);
    starts ??= new Set(scanRefs(cell).refs.map((r) => r.start));
    for (const p of at) {
      SHA_AT_RE.lastIndex = p;
      if (starts.has(p) || SHA_AT_RE.test(cell)) return stateWord(m[1]!);
    }
  }
  return null;
}

/** Rule 2: a state word at the very start of the state cell. */
const WORD_AT_START_RE = new RegExp(`^(${STATE_ALT})(?![\\p{L}\\p{N}-])`, "iu");

/** Rule 3: a Landed cell of markdown PR links and landing metadata only —
 *  separators, dates, shas in backticks, and parentheticals with no word of
 *  letters alone (`(v34)`, `(2026-10-19)`; not `(reverted)`). A bare ref
 *  (`muninn #5`) is no link, so a word before it is never read as merged. */
const LANDED_SEPARATORS = new Set([",", "+", "&", "/", "and", "og"]);
const DATE_TOKEN_RE = /^\d{1,4}[-.]\d{1,2}(?:[-.]\d{1,4})?$/;
const SHA_TOKEN_RE = /^`[0-9a-f]{7,40}`$/;
function landedLinksOnly(cell: string): boolean {
  const { refs, otherLink } = scanRefs(cell);
  if (otherLink || !refs.length || refs.some((r) => !r.link)) return false;
  let rest = "";
  let last = 0;
  for (const r of refs) {
    rest += cell.slice(last, r.start) + " ";
    last = r.end;
  }
  rest += cell.slice(last);
  let prose = false;
  rest = rest.replace(/\(([^()]*)\)/g, (_, inner: string) => {
    for (const t of inner.split(/[\s,;]+/)) {
      if (/\p{L}/u.test(t) && !/\d/.test(t) && !SHA_TOKEN_RE.test(t)) prose = true;
    }
    return " ";
  });
  if (prose) return false;
  return rest
    .split(/\s+|(?=,)|(?<=,)/)
    .every((t) => t === "" || LANDED_SEPARATORS.has(t.toLowerCase()) || DATE_TOKEN_RE.test(t) || SHA_TOKEN_RE.test(t));
}

/** A qualifier in parentheses may follow: `Status (10-19)`, `State (as of …)`. */
const STATE_HEADER_RE = /^(?:state|status|tilstand)(?:\s*\([^()]*\))?$/i;
const LANDED_HEADER_RE = /^(?:landed|landet)$/i;
const DECISIONS_HEADER_RE = /^(?:decisions?|beslutning(?:er)?)$/i;
const PR_HEADER_RE = /^PR$/i;
/** A first column that is a phase, a date or a period, not a slate; any
 *  other first column numbers the slate. A qualifier in parentheses may follow;
 *  anchored, so `Update`, `Sprintnr` and `Phase PR` hold the slate. */
const NOT_SLATE_HEADER_RE = /^(?:fase|phase|date|dato|når|when|uke|week|sprint|runde|round|versjon|version)(?:\s*\([^()]*\))?$/i;

const DECISION_ID_GLOBAL = /(?<![\p{L}\p{N}])D(\d{1,4})(?![\p{L}\p{N}])/gu;

/** The share of a ledger's rows that must parse for the strip to draw. */
export const LEDGER_PARSED_MIN = 0.75;

export interface LedgerRow {
  /** The slate number: the leading integer of the first cell, unless the
   *  first column is a phase, date or period column (Fase, Date, Week …). */
  slate: number | null;
  /** The number of the row's PR link, read from the first cell, then the
   *  PR, State and Landed cells, then the rest in order (`linkOf`). */
  link: number | null;
  /** The number the strip shows: slate, else link. */
  pr: number | null;
  state: PrState;
  /** Which rule gave the state: 1–3, 0 for unknown. */
  rule: 0 | 1 | 2 | 3;
  /** The D ids the row cites, in cell order, deduplicated. */
  decisions: string[];
  /** The first cell's text without its number (`harness`), struck text kept. */
  label: string;
  cells: string[];
}

export interface Ledger {
  source: "ledger" | "glance";
  headers: string[];
  stateColumn: number;
  rows: LedgerRow[];
  /** Rows with a known state over rows with a PR. 0 with no rows. */
  parsedShare: number;
  /** A state column and the 75% floor (the glance fallback always draws). */
  draws: boolean;
}

/** Strip `**`, `__`, `~~` and a leading/trailing whitespace from a cell. */
function plain(cell: string): string {
  return cell.replace(/\*\*|__|~~/g, "").trim();
}

/** A cell with its struck text (`~~merged~~`) removed, for state and identity. */
function unstruck(cell: string): string {
  return cell.replace(/~~[^~]*~~/g, "");
}

function headerIndex(headers: string[], re: RegExp): number {
  return headers.findIndex((h) => re.test(plain(h)));
}

/** The number of the first PR link in a text, else null. */
function prRefOf(text: string): number | null {
  return scanRefs(text).refs[0]?.n ?? null;
}

/** The slate number of a slate column's cell (`**12** — x`, `PR 12`,
 *  `[#351](…) 1 — x`); a date or a decimal is none. The cell comes raw:
 *  `plain` strips `~~` with `**`, so struck text stays in slate and label. */
function slateOf(cell: string, slateColumn: boolean): { slate: number | null; label: string } {
  const t = plain(cell).replace(/^[-–—\s]+/, "");
  if (!slateColumn) return { slate: null, label: t };
  const m = SLATE_RE.exec(slateBody(t).body);
  if (!m) return { slate: null, label: t };
  return { slate: Number(m[1]), label: m[3]!.trim() };
}

/** A slate number, then an optional separator (group 2) and the label (3). */
const SLATE_RE = /^(\d{1,4})(?![\p{L}\p{N}])(?![-.:/]\d)\s*([-–—:.)]\s*)?(.*)$/u;

/** A cell past its leading PR links (`[#351](…) 1 — y`) and a `PR #` prefix;
 *  `link` is the first of those links, `prefixed` whether the prefix was there. */
function slateBody(t: string): { body: string; link: number | null; prefixed: boolean } {
  let cut = 0;
  let link: number | null = null;
  for (const r of scanRefs(t).refs) {
    if (r.start !== cut || t[cut] !== "[") break;
    link ??= r.n;
    cut = r.end;
    while (/\s/.test(t[cut] ?? "")) cut++;
  }
  const rest = t.slice(cut);
  const body = rest.replace(/^PR\s*#?\s*/i, "");
  return { body, link, prefixed: body.length !== rest.length };
}

/** A gate row's PR identity: a slate and the first cell's PR link. */
export interface GatePr {
  slate: number | null;
  link: number | null;
}

/** The PR a non-ledger table row names in its first cell: the slate (`7`,
 *  `PR 7`, `**7** — x`) and the cell's first PR link, struck text not read
 *  for either. Unlike a ledger row's, the slate is read under any header and
 *  skips struck text (`~~8~~ 12` is gate slate 12, ledger slate 8). It is
 *  also stricter: a number followed by more text counts only after a
 *  separator or a `PR` prefix, and only when that text does not open with a
 *  digit, so `3 runs`, `12–40`, `21a` and a date name no PR. Null when the
 *  cell names neither. */
export function gateRowPr(cell: string): GatePr | null {
  const t = plain(unstruck(cell)).replace(/^[-–—\s]+/, "");
  const { body, prefixed } = slateBody(t);
  const m = SLATE_RE.exec(body);
  const label = m?.[3]!.trim();
  const slate = m && (label === "" || ((m[2] !== undefined || prefixed) && !/^\d/.test(label!))) ? Number(m[1]) : null;
  const link = prRefOf(unstruck(cell));
  return slate === null && link === null ? null : { slate, link };
}

/** The ledger state of a gate row's PR, first match wins: (1) the row whose
 *  slate is the gate's slate; (2) the row whose link is the gate's own link;
 *  (3) a slate-less row whose link is the gate's slate (its PR is its link);
 *  (4) none. */
export function gateRowState(pr: GatePr, rows: readonly LedgerRow[]): PrState | undefined {
  const row =
    (pr.slate !== null ? rows.find((r) => r.slate === pr.slate) : undefined) ??
    (pr.link !== null ? rows.find((r) => r.link === pr.link) : undefined) ??
    (pr.slate !== null ? rows.find((r) => r.slate === null && r.link === pr.slate) : undefined);
  return row?.state;
}

/** The row's PR link: the first cell, the PR, state and Landed cells first,
 *  then the rest in order. */
function linkOf(cells: string[], preferred: number[]): number | null {
  const order = [...new Set([0, ...preferred.filter((i) => i >= 0), ...cells.keys()])];
  for (const i of order) {
    const n = prRefOf(cells[i] ?? "");
    if (n !== null) return n;
  }
  return null;
}

function stateWord(word: string): Exclude<PrState, "unknown"> {
  const w = word.toLowerCase().replace(/\s+/g, " ");
  return STATE_WORDS.find(([s]) => s === w)![1];
}

/** The row's state over its unstruck cells. */
function rowState(cells: string[], stateCol: number, landedCol: number): { state: PrState; rule: 0 | 1 | 2 | 3 } {
  const rule1 = (i: number): { state: PrState; rule: 1 } | null => {
    const s = wordThenRef(cells[i] ?? "");
    return s ? { state: s, rule: 1 } : null;
  };
  // The state and Landed cells first: prose in another cell never beats them.
  for (const i of [stateCol, landedCol]) {
    const r = i >= 0 ? rule1(i) : null;
    if (r) return r;
  }
  if (stateCol >= 0) {
    // Emphasis or a link bracket may open the cell: `_åpen_`, `[merget](…)`.
    const m = WORD_AT_START_RE.exec(plain(cells[stateCol] ?? "").replace(/^[_*[]+/, ""));
    if (m) return { state: stateWord(m[1]!), rule: 2 };
  }
  for (let i = 0; i < cells.length; i++) {
    if (i === stateCol || i === landedCol) continue;
    const r = rule1(i);
    if (r) return r;
  }
  if (landedCol >= 0 && landedLinksOnly(plain(cells[landedCol] ?? ""))) return { state: "merged", rule: 3 };
  return { state: "unknown", rule: 0 };
}

function decisionsOf(cells: string[], decisionsCol: number): string[] {
  const source = decisionsCol >= 0 ? [cells[decisionsCol] ?? ""] : cells;
  const out: string[] = [];
  for (const c of source) {
    for (const m of c.matchAll(DECISION_ID_GLOBAL)) {
      const id = `D${Number(m[1])}`;
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** Read one ledger table. */
export function parseLedgerTable(headers: string[], rows: string[][], source: Ledger["source"] = "ledger"): Ledger {
  const stateColumn = headerIndex(headers, STATE_HEADER_RE);
  const landedCol = headerIndex(headers, LANDED_HEADER_RE);
  const decisionsCol = headerIndex(headers, DECISIONS_HEADER_RE);
  const prCol = headerIndex(headers, PR_HEADER_RE);
  const slateColumn = !NOT_SLATE_HEADER_RE.test(plain(headers[0] ?? ""));
  const out: LedgerRow[] = [];
  for (const cells of rows) {
    // `~~` is formatting for the slate and label (`~~**3**~~` stays slate 3,
    // a dropped row stays on the strip); a struck link or state word counts not.
    const live = cells.map(unstruck);
    const { slate, label } = slateOf(cells[0] ?? "", slateColumn);
    const link = linkOf(live, [prCol, stateColumn, landedCol]);
    const pr = slate ?? link;
    if (pr === null) continue;
    const { state, rule } = source === "glance" ? { state: "planned" as const, rule: 0 as const } : rowState(live, stateColumn, landedCol);
    out.push({ slate, link, pr, state, rule, decisions: decisionsOf(cells, decisionsCol), label, cells });
  }
  const known = out.filter((r) => r.state !== "unknown").length;
  const parsedShare = out.length ? known / out.length : 0;
  const draws = source === "glance" ? out.length > 0 : stateColumn >= 0 && out.length > 0 && parsedShare >= LEDGER_PARSED_MIN;
  return { source, headers, stateColumn, rows: out, parsedShare, draws };
}

/** A line that opens with the bold ledger label, prose after it allowed
 *  (`**PR ledger.** Merged rows first.`). The strip reads a table under it;
 *  check 14's home rule keeps the stricter {@link isLedgerLabel}. */
export function opensWithLedgerLabel(line: string): boolean {
  if (isLedgerLabel(line)) return true;
  const m = /^\s*\*\*([^*\n]+)\*\*/.exec(line);
  return m !== null && isLedgerLabel(`**${m[1]}**`);
}

/** The label candidates right above block `i`: every line of the paragraph
 *  that ends a text block (`**PR ledger.**` then prose on the next line), or a
 *  heading, skipping blank text blocks and a `<Meter>` (a ledger's progress bar
 *  stands between its label and its table). */
function linesAbove(blocks: Block[], i: number): string[] {
  for (let j = i - 1; j >= 0; j--) {
    const b = blocks[j]!;
    if (b.type === "component" && b.name === "Meter") continue;
    if (b.type === "heading") return [b.content];
    if (b.type !== "text") return [];
    const lines = [...b.lines];
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
    if (!lines.length) continue;
    const blank = lines.findLastIndex((l) => l.trim() === "");
    return lines.slice(blank + 1);
  }
  return [];
}

/** Every PR ledger on the page, in source order, inside component bodies
 *  (Lane, Fold, More …) too. */
export function findLedgers(blocks: Block[]): Ledger[] {
  const out: Ledger[] = [];
  const walk = (bs: Block[]): void => {
    bs.forEach((b, i) => {
      if (b.type === "component") walk(b.children);
      else if (b.type === "table") {
        if (linesAbove(bs, i).some(opensWithLedgerLabel)) out.push(parseLedgerTable(b.headers, b.rows));
      }
    });
  };
  walk(blocks);
  return out;
}

/** The `### At a glance` table whose first column is `PR`: the planned slate
 *  of a page that has no ledger yet. */
export function findGlanceLedger(blocks: Block[]): Ledger | null {
  let found: Ledger | null = null;
  const walk = (bs: Block[]): void => {
    let inGlance = false;
    for (const b of bs) {
      if (found) return;
      if (b.type === "heading") inGlance = /^at a glance$/i.test(plain(b.content));
      else if (b.type === "component") walk(b.children);
      else if (b.type === "table" && inGlance && PR_HEADER_RE.test(plain(b.headers[0] ?? ""))) {
        found = parseLedgerTable(b.headers, b.rows, "glance");
      }
    }
  };
  walk(blocks);
  return found;
}

/** The ledgers the page's views read: every ledger, else — on a `proposed`
 *  plan only — the glance table. A shipped plan with no ledger is not a slate
 *  of planned PRs, so it gets nothing. */
export function pageLedgers(blocks: Block[], proposed = false): Ledger[] {
  const ledgers = findLedgers(blocks);
  if (ledgers.length || !proposed) return ledgers;
  const glance = findGlanceLedger(blocks);
  return glance ? [glance] : [];
}

/** One row per PR over the given ledgers, in source order: when two ledgers
 *  repeat a PR, the first row wins. */
export function firstRowPerPr(ledgers: Ledger[]): LedgerRow[] {
  const seen = new Set<number>();
  const out: LedgerRow[] = [];
  for (const l of ledgers) {
    for (const r of l.rows) {
      if (r.pr === null || seen.has(r.pr)) continue;
      seen.add(r.pr);
      out.push(r);
    }
  }
  return out;
}

/** PR number → state over the given ledgers; the first row naming a PR wins. */
export function prStateMap(ledgers: Ledger[]): Map<number, PrState> {
  return new Map(firstRowPerPr(ledgers).map((r) => [r.pr!, r.state]));
}
