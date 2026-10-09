/**
 * Lint check 9 — report-page DRIFT: a report page whose shape has fallen behind
 * the work it records. Four checks, all report-only: none proposes a fix,
 * because none is mechanical (a stale draft lane needs sending or dropping, an
 * SQL fence needs its result and question, a case table needs a YAML file).
 *
 * Scope is ONE predicate for all four, {@link isLiveReportPage}: a report page
 * ({@link isReportPage}) that is LIVE — a `plan_status` in
 * {@link LIVE_PLAN_STATUSES}, or no `plan_status` at all under `plans/`. An
 * archived page and a settled status are history, not drift (measured
 * 2026-10-01: 14 of 16 `long-page-no-fold` hits were archived or shipped).
 *
 * | check                | fires when                                                              | severity |
 * |----------------------|-------------------------------------------------------------------------|----------|
 * | `draft-lane-stale`   | a counted `<Lane kind="draft">` with an open item, `since` > 2 days ago | warning  |
 * | `loose-sql`          | ≥ 2 read-query `sql` fences outside any `<Query>`, at any depth         | warning  |
 * | `case-table`         | ≥ 5 case rows (id first cell + a status cell), and no `<CaseBoard>`     | warning  |
 * | `long-page-no-fold`  | > 600 lines (`wc -l`) and no `<Fold>`                                   | info     |
 *
 * Every structural test walks the parsed AST (`parseBlocks`, the renderer's own
 * parser), so a tag or fence quoted inside a code fence is not counted.
 *
 * **"Today" is the Europe/Oslo calendar day** (`todayOslo`, the wiki's date
 * convention), for the draft-lane age.
 *
 * A fifth check, `status-date-behind` (`status_date` older than the page's last
 * content commit), was measured and DROPPED (2026-10-01): the wikis set
 * `status_date` when the STATUS changes, not on every edit — three kode-wiki
 * commits that day set it back after a rewrite ("ingen statusendring") — so on
 * the kode-wiki 4 of its 8 hits were edits that changed no status (50%, over the
 * 20% gate). mimir's check 10 (`scripts/plan-status-stale.ts`) stays the one
 * staleness check.
 */

import type { QuestionLanguage } from "../format/question-labels.ts";
import {
  countedNextMovesLanes,
  parseAttrs,
  parseBlocks,
  type Block,
  type ListChild,
} from "../format/markdown-ast.ts";
import { fenceLineStates, frontmatterEndLine } from "../dashboard/views/components/wiki-integrate.ts";
import { todayOslo } from "../gardener/util.ts";
import { parseFrontmatter, type WikiPageMeta } from "./store.ts";
import { splitFrontmatter } from "./page-text.ts";
import type { LintFinding } from "./lint.ts";
import { DRAFT_LANE_MAX_DAYS } from "./lint-drift-limits.ts";

export { DRAFT_LANE_MAX_DAYS };

export const DRIFT_LINT_CHECKS = [
  "draft-lane-stale",
  "loose-sql",
  "case-table",
  "long-page-no-fold",
] as const;
export type DriftLintCheck = (typeof DRIFT_LINT_CHECKS)[number];

/** `sql` fences outside a `<Query>` at or above this count are reported. */
export const LOOSE_SQL_MIN = 2;
/** Case rows at or above this count, on a page with no `<CaseBoard>`, are reported. */
export const CASE_ROWS_MIN = 5;
/** A page with MORE lines than this ({@link pageLineCount}) and no `<Fold>` is reported (info). */
export const LONG_PAGE_LINES = 600;

/**
 * The LIVE statuses — the drift scope ({@link isLiveReportPage}). A settled
 * status (`shipped`, `superseded`, `abandoned`) is history: its page is not
 * expected to keep its shape current.
 */
export const LIVE_PLAN_STATUSES: readonly string[] = ["proposed", "ready", "in-flight", "blocked"];

/**
 * Is this `sql` fence a READ query, the thing a `<Query>` card holds? Its first
 * statement line (after blank lines, `--` comments and `SET …` session lines)
 * opens with `SELECT` or `WITH`. DDL and DML (`CREATE`, `ALTER`, `INSERT`,
 * `UPDATE`, `DELETE`) and a bare fragment (`AND x = 1`) are not.
 */
export function isReadQueryFence(code: string): boolean {
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("--") || /^set\s/i.test(line)) continue;
    return /^(select|with)\b/i.test(line);
  }
  return false;
}

/** A case id: two or more capitals, a hyphen, digits (`MEL-436385`,
 *  `MELOSYS-8306`). Matched at the START of a first cell, markdown stripped. */
export const CASE_ID_RE = /^[A-Z]{2,}-\d+(?![\p{L}\p{N}])/u;

/**
 * The status phrases a STATUS CELL leads with, matched case-folded against the
 * cell's leading clause. The `<CaseBoard>` vocabulary, plus English and
 * Norwegian words the kode-wiki's case tables write (read off its `plans/` and
 * `archive/` tables, and the status cells of `2026-09-29-melosys-8045-dryrun-
 * 2024-2025` and the pre-CaseBoard `vedtaksmetadata-fagavklaring`, 2026-10-01).
 * Yes/no answers (`ja`, `nei`) are left out: those tables use them for any
 * question, not for a case's state.
 */
export const CASE_STATUS_PHRASES: readonly string[] = [
  // CaseBoard (`CASE_STATUSES`)
  "hold", "wait", "wrong", "ok",
  // English
  "done", "blocked", "waiting", "pending", "merged", "fixed",
  // Norwegian
  "venter", "ferdig", "blokkert", "stoppet", "merget", "fikset", "datafikset",
  "avklart", "uavklart", "kandidat", "ny kandidat", "ikke kandidat", "holdt ute",
  "hoppet over", "i prod", "ikke i rapporten",
];

/**
 * Words that may open the tail after a status phrase in the same clause
 * (`Venter på møte`, `Holdt ute av lista til S4`, `Kandidat siden 03.07`). Any
 * other word there makes the clause prose (`hold the line`, `ok so far`).
 */
export const CASE_STATUS_TAIL_WORDS: readonly string[] = [
  // Norwegian
  "av", "til", "fra", "på", "i", "siden", "etter", "før", "med", "for", "mot", "ved", "inntil", "per",
  // English
  "since", "until", "till", "from", "to", "in", "on", "at", "by", "after", "before", "with",
];

/** A date tail: `03.07`, `29.09.2026`, `2026-09-01`. */
const STATUS_DATE_RE = /^(?:\d{1,2}\.\d{1,2}(?:\.\d{2,4})?|\d{4}-\d{2}-\d{2})$/;
/** Where a cell's leading clause ends: `,` `;` `:` `(` `!` `?` `→`, a ` — `/` – `/` - `
 *  dash, a `->`, a `<br>`, or a `.` before whitespace or the end. */
const CLAUSE_END_RE = /[,;:(!?→]|\s[—–-]\s|->|<br\s*\/?>|\.(?=\s|$)/i;
/** Wrapping a status may carry: emoji (with VS16/ZWJ), check marks, quotes and space. */
const STATUS_WRAP_RE = /^[\p{Extended_Pictographic}\uFE0F\u200D✓✔✗✘"'«»“”\s]+|[\p{Extended_Pictographic}\uFE0F\u200D✓✔✗✘"'«»“”\s]+$/gu;

/**
 * Is this cell a STATUS CELL? Its markdown-stripped, trimmed, case-folded
 * leading clause (up to {@link CLAUSE_END_RE}, emoji and quotes around it
 * dropped) is a {@link CASE_STATUS_PHRASES} entry, alone or followed by a date or
 * by a {@link CASE_STATUS_TAIL_WORDS} word and whatever follows it.
 */
export function isStatusCell(cell: string): boolean {
  const text = plainCell(cell).toLowerCase();
  const end = CLAUSE_END_RE.exec(text);
  const clause = (end ? text.slice(0, end.index) : text).replace(STATUS_WRAP_RE, "").replace(/\s+/g, " ").trim();
  for (const phrase of CASE_STATUS_PHRASES) {
    if (clause === phrase) return true;
    if (!clause.startsWith(phrase + " ")) continue;
    const tail = clause.slice(phrase.length + 1).split(" ");
    if (tail.length === 1 && STATUS_DATE_RE.test(tail[0]!)) return true;
    if (CASE_STATUS_TAIL_WORDS.includes(tail[0]!)) return true;
  }
  return false;
}

/** A report page: `plan_status` present in the frontmatter (any value), or a
 *  page under `plans/` or `archive/`. */
export function isReportPage(relPath: string, fm: Record<string, unknown>): boolean {
  return fm.plan_status !== undefined || relPath.startsWith("plans/") || relPath.startsWith("archive/");
}

/**
 * The drift scope, one rule for all four checks: a report page that is LIVE —
 * its validated `plan_status` is in {@link LIVE_PLAN_STATUSES}, or it carries no
 * `plan_status` key at all and sits under `plans/`. `fm` is the raw frontmatter
 * (a key present with an invalid value is not "no plan_status"); `planStatus`
 * is the index's validated value.
 */
export function isLiveReportPage(relPath: string, fm: Record<string, unknown>, planStatus: string | undefined): boolean {
  if (!isReportPage(relPath, fm)) return false;
  if (planStatus !== undefined && LIVE_PLAN_STATUSES.includes(planStatus)) return true;
  return fm.plan_status === undefined && planStatus === undefined && relPath.startsWith("plans/");
}

/** Lines as `wc -l` counts them, plus a last line with no newline: a trailing
 *  newline does not add a line. */
export function pageLineCount(content: string): number {
  if (content === "") return 0;
  const n = content.split("\n").length;
  return content.endsWith("\n") ? n - 1 : n;
}

/** Whole days from ISO day `from` to ISO day `to` (positive when `to` is later). */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Visit every block at any depth: component bodies and list items' nested
 *  children. `inside` is the stack of component names enclosing the block. */
function walkBlocks(blocks: Block[], visit: (b: Block | ListChild, inside: readonly string[]) => void): void {
  const walk = (bs: (Block | ListChild)[], inside: string[]) => {
    for (const b of bs) {
      visit(b, inside);
      if (b.type === "component") walk(b.children, [...inside, b.name]);
      else if ((b.type === "ul" || b.type === "ol") && b.nested) {
        for (const kids of b.nested) if (kids) walk(kids, inside);
      }
    }
  };
  walk(blocks, []);
}

/** A cell's text with link, wikilink, code and emphasis markup removed. */
export function plainCell(cell: string): string {
  return cell
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
}

/** The case id opening a first cell, or null. A wikilink there is read by its
 *  TARGET (`[[MEL-123|the bug]]`) and, failing that, by its alias. */
export function caseIdOf(cell: string): string | null {
  const byTarget = plainCell(cell.replace(/\[\[([^\]|]+)\|[^\]]*\]\]/g, "$1"));
  return CASE_ID_RE.exec(byTarget)?.[0] ?? CASE_ID_RE.exec(plainCell(cell))?.[0] ?? null;
}

/** Is this table row a CASE row: a case id opening the first cell
 *  ({@link caseIdOf}), and a status cell ({@link isStatusCell}) after it? */
export function isCaseRow(row: string[]): boolean {
  if (caseIdOf(row[0] ?? "") === null) return false;
  return row.slice(1).some(isStatusCell);
}

export interface DriftContext {
  /** Today, `YYYY-MM-DD`, Europe/Oslo. */
  today: string;
  /** The wiki's `language`, which words a role lane's label (D15). */
  language?: QuestionLanguage;
}

/** A `<Lane …>` opener line as the parser takes one: the tag owns the line
 *  (`/>` is not allowed for `Lane`), and is either alone or closed by exactly
 *  one `</Lane>` that ends the line. Group 1 is the attribute run. */
const LANE_OPENER_RE = /^<Lane((?:\s+[A-Za-z][\w-]*="[^"]*")*)\s*>(.*)$/;

/** The attributes that tell lanes apart, as the parser reads them. */
const LANE_KEY_ATTRS = ["kind", "who", "since"] as const;

/**
 * The 1-based source line of every `Lane` component the parser produced, in
 * source order, or null when that mapping is not provably one-to-one.
 * Candidates are the unfenced lines after the frontmatter that open a lane the
 * way the parser would ({@link LANE_OPENER_RE}, the reader's own fence rule).
 * A lane can have no such line (one opened mid-line, `<Fold><Lane …>`) and a
 * candidate can be text to the parser (an opener never closed), so the two
 * can cancel out in a count: a line is given only when the counts match AND
 * each candidate's `kind`/`who`/`since` equal those of the lane at its index.
 */
function laneLines(content: string, lanes: readonly Block[]): number[] | null {
  const lines = content.split("\n");
  const states = fenceLineStates(lines, "literal");
  const found: number[] = [];
  const attrs: Record<string, string>[] = [];
  for (let i = frontmatterEndLine(lines); i < lines.length; i++) {
    if (states[i] !== "outside") continue;
    const m = LANE_OPENER_RE.exec(lines[i]!.trim());
    if (!m) continue;
    const rest = m[2]!;
    if (rest.trim() !== "" && !(rest.endsWith("</Lane>") && rest.indexOf("</Lane>") === rest.length - 7)) continue;
    found.push(i + 1);
    attrs.push(parseAttrs(m[1]!, "Lane"));
  }
  if (found.length !== lanes.length) return null;
  const same = lanes.every((b, k) =>
    b.type === "component" && LANE_KEY_ATTRS.every((key) => b.attrs[key] === attrs[k]![key]));
  return same ? found : null;
}

/** The four drift checks over one page. Pure given its inputs. */
export function checkDrift(page: WikiPageMeta, content: string, ctx: DriftContext): LintFinding[] {
  const fm = parseFrontmatter(content);
  if (!isLiveReportPage(page.relPath, fm, page.plan_status)) return [];
  const out: LintFinding[] = [];
  const blocks = parseBlocks(splitFrontmatter(content).body);

  // ── 1. draft-lane-stale ────────────────────────────────────────────────
  // The lanes that COUNT (`countedNextMovesLanes`: directly inside a
  // `<NextMoves>` outside any settled section — not a stray `<Lane>`, not one
  // nested in a `<Fold>` under the block), with at least one open item. A lane's
  // `children` array is its block's own, which maps a counted lane back to its
  // place among ALL `Lane` blocks, and so to its source line.
  const allLanes: Block[] = [];
  walkBlocks(blocks, (b) => {
    if (b.type === "component" && b.name === "Lane") allLanes.push(b);
  });
  let lineOf: number[] | null | undefined;
  for (const lane of countedNextMovesLanes(blocks, ctx.language).lanes) {
    const age = lane.since === null ? 0 : daysBetween(lane.since, ctx.today);
    if (lane.kind !== "draft" || lane.items.length === 0 || age <= DRAFT_LANE_MAX_DAYS) continue;
    lineOf ??= laneLines(content, allLanes);
    const at = allLanes.findIndex((b) => b.type === "component" && b.children === lane.children);
    out.push({
      check: "draft-lane-stale",
      relPath: page.relPath,
      line: lineOf && at !== -1 ? lineOf[at] : undefined,
      message: `Draft lane "${lane.label}" since ${lane.since} (${age} days): send it, or move it to waiting/blocked`,
    });
  }

  // ── 2–4: one walk ──────────────────────────────────────────────────────
  let looseSql = 0;
  let caseRows = 0;
  const caseIds: string[] = [];
  let hasCaseBoard = false;
  let hasFold = false;
  walkBlocks(blocks, (b, inside) => {
    if (b.type === "code_block") {
      if (b.lang.toLowerCase() === "sql" && !inside.includes("Query") && isReadQueryFence(b.code)) looseSql++;
    } else if (b.type === "component") {
      if (b.name === "CaseBoard") hasCaseBoard = true;
      if (b.name === "Fold") hasFold = true;
    } else if (b.type === "table") {
      for (const row of b.rows) {
        if (!isCaseRow(row)) continue;
        caseRows++;
        if (caseIds.length < 3) caseIds.push(caseIdOf(row[0]!)!);
      }
    }
  });

  if (looseSql >= LOOSE_SQL_MIN) {
    out.push({
      check: "loose-sql",
      relPath: page.relPath,
      message: `${looseSql} SQL queries outside a <Query>: give each its question and result as a <Query> card`,
    });
  }
  if (caseRows >= CASE_ROWS_MIN && !hasCaseBoard) {
    out.push({
      check: "case-table",
      relPath: page.relPath,
      message: `${caseRows} case rows with a status in tables (${caseIds.join(", ")}, …) and no <CaseBoard>: move the cases to a YAML file and a <CaseBoard>`,
    });
  }
  const lineCount = pageLineCount(content);
  if (lineCount > LONG_PAGE_LINES && !hasFold) {
    out.push({
      check: "long-page-no-fold",
      relPath: page.relPath,
      severity: "info",
      message: `${lineCount} lines and no <Fold>: fold the reference sections a reader can skip`,
    });
  }
  return out;
}

/** Build the per-run context: today, Europe/Oslo. */
export function driftContext(nowMs: number, language?: QuestionLanguage): DriftContext {
  return { today: todayOslo(nowMs), ...(language ? { language } : {}) };
}
