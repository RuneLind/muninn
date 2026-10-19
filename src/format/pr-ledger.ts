/**
 * The PR ledger on a plan page: the table under a `**PR ledger.**` /
 * `**PR-oversikt.**` label, read row by row into a PR and its state.
 *
 * Pure and server-free: `web-format.ts` reads it, and web-format ships in the
 * chat bundle. Lint check 14 (`src/wiki/lint-state.ts`) imports the label
 * helpers from here, so a ledger is one shape for both.
 *
 * A row's state, in order (a state word in prose never counts):
 *  1. a state word followed by a PR link or a commit sha, anywhere in the row;
 *  2. else a state word at the start of the state cell, emphasis or a link
 *     bracket around it allowed (`[merget](…)`);
 *  3. else a merged-PR link alone in a «Landed»/«Landet» cell reads as merged.
 * A row matching none is `unknown`.
 *
 * The strip draws a ledger only when its header names a state column
 * (State/Status/Tilstand) and at least {@link LEDGER_PARSED_MIN} of its rows
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
/** Rule 1: a state word, then (after optional emphasis and space) a PR link
 *  `[#n](…)`, a `repo #n`, or a 7–40 hex commit sha. */
const WORD_THEN_REF_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${STATE_ALT})(?![\\p{L}\\p{N}])[*_~]*[ \\t]+(?:in[ \\t]+|i[ \\t]+)?[*_]*(?:\\[#\\d+\\]\\(|\`?[0-9a-f]{7,40}\`?(?![\\p{L}\\p{N}]))`,
  "iu",
);
/** Rule 2: a state word at the very start of the state cell. */
const WORD_AT_START_RE = new RegExp(`^(${STATE_ALT})(?![\\p{L}\\p{N}])`, "iu");
/** Rule 3: a Landed cell that opens with a PR link. */
const LANDED_LINK_RE = /^\[#\d+\]\(/;

const STATE_HEADER_RE = /^(?:state|status|tilstand)$/i;
const LANDED_HEADER_RE = /^(?:landed|landet)$/i;
const DECISIONS_HEADER_RE = /^(?:decisions?|beslutning(?:er)?)$/i;
const PR_HEADER_RE = /^PR$/i;

/** A PR link `[#641](…)` or `repo #641` / `repo#641`. */
const PR_LINK_RE = /\[#(\d{1,6})\]\(|(?<![\p{L}\p{N}/])[a-z][a-z0-9._-]*[ ]?#(\d{1,6})(?![\p{L}\p{N}])/u;
const DECISION_ID_GLOBAL = /(?<![\p{L}\p{N}])D(\d{1,4})(?![\p{L}\p{N}])/gu;

/** The share of a ledger's rows that must parse for the strip to draw. */
export const LEDGER_PARSED_MIN = 0.75;

export interface LedgerRow {
  /** The slate number: the leading integer of the first cell. */
  slate: number | null;
  /** The number of the first PR link in the row. */
  link: number | null;
  /** The number the strip shows: slate, else link. */
  pr: number | null;
  state: PrState;
  /** Which rule gave the state: 1–3, 0 for unknown. */
  rule: 0 | 1 | 2 | 3;
  /** The D ids the row cites, in cell order, deduplicated. */
  decisions: string[];
  /** The first cell's text without its number (`harness`). */
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

function headerIndex(headers: string[], re: RegExp): number {
  return headers.findIndex((h) => re.test(plain(h)));
}

/** Leading integer of the first cell, after bold and dashes (`**12** — x`). */
function slateOf(cell: string): { slate: number | null; label: string } {
  const t = plain(cell).replace(/^[-–—\s]+/, "");
  const m = /^(\d{1,4})(?![\p{L}\p{N}])\s*(?:[-–—:.)]\s*)?(.*)$/u.exec(t);
  if (!m) return { slate: null, label: t };
  return { slate: Number(m[1]), label: m[2]!.trim() };
}

function linkOf(cells: string[]): number | null {
  for (const c of cells) {
    const m = PR_LINK_RE.exec(c);
    if (m) return Number(m[1] ?? m[2]);
  }
  return null;
}

function stateWord(word: string): Exclude<PrState, "unknown"> {
  const w = word.toLowerCase().replace(/\s+/g, " ");
  return STATE_WORDS.find(([s]) => s === w)![1];
}

function rowState(cells: string[], stateCol: number, landedCol: number): { state: PrState; rule: 0 | 1 | 2 | 3 } {
  for (const c of cells) {
    const m = WORD_THEN_REF_RE.exec(c);
    if (m) return { state: stateWord(m[1]!), rule: 1 };
  }
  if (stateCol >= 0) {
    // Emphasis or a link bracket may open the cell: `_åpen_`, `[merget](…)`.
    const m = WORD_AT_START_RE.exec(plain(cells[stateCol] ?? "").replace(/^[_*[]+/, ""));
    if (m) return { state: stateWord(m[1]!), rule: 2 };
  }
  if (landedCol >= 0 && LANDED_LINK_RE.test(plain(cells[landedCol] ?? ""))) return { state: "merged", rule: 3 };
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
  const out: LedgerRow[] = [];
  for (const cells of rows) {
    const { slate, label } = slateOf(cells[0] ?? "");
    const link = linkOf(cells);
    const pr = slate ?? link;
    if (pr === null) continue;
    const { state, rule } = source === "glance" ? { state: "planned" as const, rule: 0 as const } : rowState(cells, stateColumn, landedCol);
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

/** The label line right above block `i`: the last non-blank line of a text
 *  block, or a heading, skipping blank text blocks and a `<Meter>` (a ledger's
 *  progress bar stands between its label and its table). */
function labelAbove(blocks: Block[], i: number): string | null {
  for (let j = i - 1; j >= 0; j--) {
    const b = blocks[j]!;
    if (b.type === "component" && b.name === "Meter") continue;
    if (b.type === "heading") return b.content;
    if (b.type !== "text") return null;
    const lines = b.lines.filter((l) => l.trim() !== "");
    if (lines.length) return lines[lines.length - 1]!;
  }
  return null;
}

/** Every PR ledger on the page, in source order, inside component bodies
 *  (Lane, Fold, More …) too. */
export function findLedgers(blocks: Block[]): Ledger[] {
  const out: Ledger[] = [];
  const walk = (bs: Block[]): void => {
    bs.forEach((b, i) => {
      if (b.type === "component") walk(b.children);
      else if (b.type === "table") {
        const label = labelAbove(bs, i);
        if (label !== null && opensWithLedgerLabel(label)) out.push(parseLedgerTable(b.headers, b.rows));
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

/** PR number → state over the given ledgers; the first row naming a PR wins. */
export function prStateMap(ledgers: Ledger[]): Map<number, PrState> {
  const out = new Map<number, PrState>();
  for (const l of ledgers) for (const r of l.rows) if (r.pr !== null && !out.has(r.pr)) out.set(r.pr, r.state);
  return out;
}
