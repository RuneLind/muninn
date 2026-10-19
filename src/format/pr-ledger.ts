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
 *  3. else a merged-PR link alone in a «Landed»/«Landet» cell reads as merged.
 * A row matching none is `unknown`. Struck text (`~~…~~`) is removed first.
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

/** Words that number something other than a PR: `step #3` is no PR link. */
const NOT_A_REPO = [
  "step", "steg", "phase", "fase", "item", "punkt", "task", "oppgave", "row", "rad", "round", "runde",
  "batch", "slice", "part", "del", "issue", "issues", "sak", "saker", "no", "nr", "number", "nummer",
  "case", "line", "linje", "version", "versjon", "comment", "kommentar", "ticket", "card", "kort",
  "finding", "funn", "check", "sjekk", "option", "page", "side", "test", "run", "question", "decision",
].join("|");
/** A PR link: `[#641](…)`, `[muninn#641](…)`, `[PR #641](…)`, the text in backticks allowed. */
const LINK_REF = "\\[`?" + String.raw`(?:[A-Za-z][\w./-]*[ ]?)?#(\d{1,6})` + "`?" + String.raw`\]\([^)\s]*\)`;
/** A bare `repo #641` / `owner/repo#641` / `PR #641` (PR in any case). */
const BARE_REF = String.raw`(?<![\p{L}\p{N}/#\[\].-])(?!(?:${NOT_A_REPO})[ ]?#)[A-Za-z](?:[\w.-]*[A-Za-z0-9])?(?:/[\w.-]*[A-Za-z0-9])?[ ]?#(\d{1,6})(?![\p{L}\p{N}])`;
/** A commit sha: 7–40 hex in backticks, or bare with both a digit and a letter a–f. */
const SHA = "`[0-9a-f]{7,40}`|" + String.raw`(?<![\p{L}\p{N}])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\p{L}\p{N}])`;

/** Rule 1: a state word, then (after optional emphasis and space) a PR link,
 *  a bare `repo #n` or a commit sha. */
const WORD_THEN_REF_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${STATE_ALT})(?![\\p{L}\\p{N}])[*_]*[ \\t]+(?:(?:in|i)[ \\t]+)?[*_]*(?:${LINK_REF}|${BARE_REF}|${SHA})`,
  "iu",
);
/** Rule 2: a state word at the very start of the state cell. */
const WORD_AT_START_RE = new RegExp(`^(${STATE_ALT})(?![\\p{L}\\p{N}-])`, "iu");
/** Rule 3: a Landed cell holding PR links and no prose: a date, a sha in
 *  backticks or a parenthetical may follow (`[#5](…), 2026-09-13`). */
const LANDED_META = String.raw`\d{1,4}[-.]\d{1,2}(?:[-.]\d{1,4})?|` + "`[0-9a-f]{7,40}`" + String.raw`|\([^()]*\)`;
const LANDED_LINKS_RE = new RegExp(
  `^(?:${LINK_REF}|${BARE_REF})(?:\\s*[,+&/]?\\s*(?:${LINK_REF}|${BARE_REF}))*(?:\\s*,?\\s*(?:${LANDED_META}))*$`,
  "iu",
);
/** The first PR link in a text: group 1 a link, group 2 a bare ref. */
const PR_REF_RE = new RegExp(`${LINK_REF}|${BARE_REF}`, "iu");

/** A qualifier in parentheses may follow: `Status (10-19)`, `State (as of …)`. */
const STATE_HEADER_RE = /^(?:state|status|tilstand)(?:\s*\([^()]*\))?$/i;
const LANDED_HEADER_RE = /^(?:landed|landet)$/i;
const DECISIONS_HEADER_RE = /^(?:decisions?|beslutning(?:er)?)$/i;
const PR_HEADER_RE = /^PR$/i;
/** A first column that numbers the slate (not Fase/Phase/Date/When). */
const SLATE_HEADER_RE = /^(?:(?:planned|planlagt)\s+)?(?:PR|#|nr\.?|oppgave|task|steg|step|slice|part|del)$/i;

const DECISION_ID_GLOBAL = /(?<![\p{L}\p{N}])D(\d{1,4})(?![\p{L}\p{N}])/gu;

/** The share of a ledger's rows that must parse for the strip to draw. */
export const LEDGER_PARSED_MIN = 0.75;

export interface LedgerRow {
  /** The slate number: the leading integer of the first cell, when the first
   *  column is a slate column (PR, #, Task …, not Fase or Date). */
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

/** A cell with its struck text (`~~merged~~`) removed, for state matching. */
function unstruck(cell: string): string {
  return cell.replace(/~~[^~]*~~/g, "");
}

function headerIndex(headers: string[], re: RegExp): number {
  return headers.findIndex((h) => re.test(plain(h)));
}

/** The number of the first PR link in a text, else null. */
function prRefOf(text: string): number | null {
  const m = PR_REF_RE.exec(text);
  return m ? Number(m[1] ?? m[2]) : null;
}

/** The slate number of a slate column's cell (`**12** — x`, `PR 12`,
 *  `[#351](…) 1 — x`); a date or a decimal is none. */
function slateOf(cell: string, slateColumn: boolean): { slate: number | null; label: string } {
  const t = plain(cell).replace(/^[-–—\s]+/, "");
  if (!slateColumn) return { slate: null, label: t };
  const body = t.replace(new RegExp(`^(?:(?:${LINK_REF})\\s*)+`, "iu"), "").replace(/^PR\s*#?\s*/i, "");
  const m = /^(\d{1,4})(?![\p{L}\p{N}])(?![-.:/]\d)\s*(?:[-–—:.)]\s*)?(.*)$/u.exec(body);
  if (!m) return { slate: null, label: t };
  return { slate: Number(m[1]), label: m[2]!.trim() };
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

function rowState(raw: string[], stateCol: number, landedCol: number): { state: PrState; rule: 0 | 1 | 2 | 3 } {
  const cells = raw.map(unstruck);
  const rule1 = (i: number): { state: PrState; rule: 1 } | null => {
    const m = WORD_THEN_REF_RE.exec(cells[i] ?? "");
    return m ? { state: stateWord(m[1]!), rule: 1 } : null;
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
  if (landedCol >= 0 && LANDED_LINKS_RE.test(plain(cells[landedCol] ?? ""))) return { state: "merged", rule: 3 };
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
  const slateColumn = SLATE_HEADER_RE.test(plain(headers[0] ?? ""));
  const out: LedgerRow[] = [];
  for (const cells of rows) {
    const { slate, label } = slateOf(cells[0] ?? "", slateColumn);
    const link = linkOf(cells, [prCol, stateColumn, landedCol]);
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
