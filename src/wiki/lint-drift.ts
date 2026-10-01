/**
 * Lint check 9 — report-page DRIFT: a report page whose shape has fallen behind
 * the work it records. Five checks, all report-only: none proposes a fix,
 * because none is mechanical (a stale draft lane needs sending or dropping, an
 * SQL fence needs its result and question, a case table needs a YAML file).
 *
 * Scope is REPORT pages only ({@link isReportPage}): a `plan_status` key in the
 * frontmatter, or a page under `plans/` or `archive/`.
 *
 * | check                | fires when                                                              | severity |
 * |----------------------|-------------------------------------------------------------------------|----------|
 * | `draft-lane-stale`   | a counted `<Lane kind="draft">` whose `since` is > 2 days before today  | warning  |
 * | `status-date-behind` | a LIVE `plan_status` whose `status_date` is an earlier day than the     | warning  |
 * |                      | page's last content commit                                              |          |
 * | `loose-sql`          | ≥ 2 read-query `sql` fences outside any `<Query>`, at any depth, on a   | warning  |
 * |                      | LIVE report page (`plans/`, or a live `plan_status`)                    |          |
 * | `case-table`         | ≥ 5 case rows (id first cell + status word), and no `<CaseBoard>`       | warning  |
 * | `long-page-no-fold`  | > 600 lines and no `<Fold>`                                             | info     |
 *
 * Every structural test walks the parsed AST (`parseBlocks`, the renderer's own
 * parser), so a tag or fence quoted inside a code fence is not counted.
 *
 * **Days are Europe/Oslo calendar days** (`todayOslo`, the wiki's date
 * convention): "today" for the draft-lane age, and the day of the last content
 * commit for `status-date-behind`. Both wikis are written there, so a commit at
 * 00:30 on the 2nd is the 2nd, as the author's `status_date` would say.
 */

import path from "node:path";
import {
  isSettledSection,
  laneFromAttrs,
  parseBlocks,
  type Block,
  type ListChild,
} from "../format/markdown-ast.ts";
import { fencedLineMask, frontmatterEndLine } from "../dashboard/views/components/wiki-integrate.ts";
import { todayOslo } from "../gardener/util.ts";
import { parseFrontmatter, type WikiPageMeta } from "./store.ts";
import { splitFrontmatter } from "./page-text.ts";
import type { LintFinding } from "./lint.ts";

export const DRIFT_LINT_CHECKS = [
  "draft-lane-stale",
  "status-date-behind",
  "loose-sql",
  "case-table",
  "long-page-no-fold",
] as const;
export type DriftLintCheck = (typeof DRIFT_LINT_CHECKS)[number];

/** A draft lane older than this many days is reported (strictly more). */
export const DRAFT_LANE_MAX_DAYS = 2;
/** `sql` fences outside a `<Query>` at or above this count are reported. */
export const LOOSE_SQL_MIN = 2;
/** Case rows at or above this count, on a page with no `<CaseBoard>`, are reported. */
export const CASE_ROWS_MIN = 5;
/** A page with MORE lines than this and no `<Fold>` is reported (info). */
export const LONG_PAGE_LINES = 600;

/**
 * The statuses whose `status_date` can fall behind the work. A settled status
 * (`shipped`, `superseded`, `abandoned`) stays true when the page is edited
 * later (a link, a follow-up note), so it is not checked: measured 2026-10-01,
 * 62 of mimir's 67 first-cut hits were `shipped` plans edited after shipping.
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
 * The status words a case row must hold, matched as whole words,
 * case-insensitively, in any cell after the first. The `<CaseBoard>` vocabulary
 * plus status words the kode-wiki's case tables write (read off its `plans/`
 * and `archive/` tables, 2026-10-01). Yes/no answers (`ja`, `nei`) are left
 * out: those tables use them for any question, not for a case's state.
 */
export const CASE_STATUS_WORDS: readonly string[] = [
  // CaseBoard (`CASE_STATUSES`)
  "hold", "wait", "wrong", "ok",
  // English
  "done", "blocked", "waiting", "pending", "merged", "fixed",
  // Norwegian
  "venter", "ferdig", "blokkert", "stoppet", "merget", "fikset", "datafikset",
  "avklart", "uavklart", "kandidat",
];
const STATUS_WORD_SET = new Set(CASE_STATUS_WORDS);

/** The scope rule: `plan_status` present in the frontmatter (any value), or a
 *  page under `plans/` or `archive/`. */
export function isReportPage(relPath: string, fm: Record<string, unknown>): boolean {
  return fm.plan_status !== undefined || relPath.startsWith("plans/") || relPath.startsWith("archive/");
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

/** Is this table row a CASE row: a case id opening the first cell, and a
 *  status word in a later one? */
export function isCaseRow(row: string[]): boolean {
  if (!CASE_ID_RE.test(plainCell(row[0] ?? ""))) return false;
  for (const cell of row.slice(1)) {
    for (const w of plainCell(cell).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      if (STATUS_WORD_SET.has(w)) return true;
    }
  }
  return false;
}

export interface DriftContext {
  /** Today, `YYYY-MM-DD`, Europe/Oslo. */
  today: string;
  /** True when the wiki carries mimir's own check 10 (`scripts/plan-status-stale.ts`):
   *  `status-date-behind` then leaves that check's population to it. */
  hasPlanStaleCheck: boolean;
}

/** Check 10's population in mimir: a top-level `plans/` page whose status is
 *  `in-flight` or `ready` (`STALE_STATUSES` in `scripts/plan-status-stale.ts`). */
function inPlanStaleScope(relPath: string, planStatus: unknown): boolean {
  return /^plans\/[^/]+\.mdx?$/.test(relPath) && (planStatus === "in-flight" || planStatus === "ready");
}

/** The 1-based line of the `n`-th unfenced `<Lane` opener after the
 *  frontmatter, or undefined. Locates a finding the AST already made; it
 *  decides nothing. */
function laneOpenerLine(content: string, n: number): number | undefined {
  const lines = content.split("\n");
  const fenced = fencedLineMask(lines);
  let seen = 0;
  for (let i = frontmatterEndLine(lines); i < lines.length; i++) {
    if (fenced[i] || !/^\s*<Lane\b/.test(lines[i]!)) continue;
    if (seen++ === n) return i + 1;
  }
  return undefined;
}

/** The five drift checks over one page. Pure given its inputs. */
export function checkDrift(page: WikiPageMeta, content: string, ctx: DriftContext): LintFinding[] {
  const fm = parseFrontmatter(content);
  if (!isReportPage(page.relPath, fm)) return [];
  const out: LintFinding[] = [];
  const blocks = parseBlocks(splitFrontmatter(content).body);

  // ── 1. draft-lane-stale ────────────────────────────────────────────────
  // Lanes of a `<NextMoves>` that COUNTS: one inside a `<Historic>` or a
  // resolved `<Callout>` is history. `laneIndex` counts every `<Lane>` in source
  // order (counted or not) so the line lookup lines up with the source.
  let laneIndex = 0;
  const walkLanes = (bs: Block[], settled: boolean) => {
    for (const b of bs) {
      if (b.type !== "component") continue;
      if (b.name === "Lane") {
        const at = laneIndex++;
        const lane = laneFromAttrs(b.attrs, b.children);
        const age = lane.since === null ? 0 : daysBetween(lane.since, ctx.today);
        if (!settled && lane.kind === "draft" && age > DRAFT_LANE_MAX_DAYS) {
          out.push({
            check: "draft-lane-stale",
            relPath: page.relPath,
            line: laneOpenerLine(content, at),
            message: `Draft lane "${lane.label}" since ${lane.since} (${age} days): send it, or move it to waiting/blocked`,
          });
        }
      }
      walkLanes(b.children, settled || isSettledSection(b));
    }
  };
  walkLanes(blocks, false);

  // ── 2. status-date-behind ──────────────────────────────────────────────
  // `gitTouchedMs` is the newest commit that changed CONTENT: sweeps (≥ 10 files)
  // and metadata-only commits (`METADATA_ONLY_FRONTMATTER_KEYS`) are already set
  // aside by `git-dates.ts`. Absent on a non-git wiki ⇒ no finding.
  if (
    page.status_date &&
    page.plan_status !== undefined &&
    LIVE_PLAN_STATUSES.includes(page.plan_status) &&
    page.gitTouchedMs !== undefined &&
    !(ctx.hasPlanStaleCheck && inPlanStaleScope(page.relPath, page.plan_status))
  ) {
    const touched = todayOslo(page.gitTouchedMs);
    if (touched > page.status_date) {
      const lines = content.split("\n");
      const end = frontmatterEndLine(lines);
      const idx = lines.slice(0, end).findIndex((l) => l.startsWith("status_date:"));
      out.push({
        check: "status-date-behind",
        relPath: page.relPath,
        line: idx === -1 ? undefined : idx + 1,
        message: `status_date ${page.status_date} is older than the last content commit (${touched}): update the status or the date`,
      });
    }
  }

  // ── 3–5: one walk ──────────────────────────────────────────────────────
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
        if (caseIds.length < 3) caseIds.push(CASE_ID_RE.exec(plainCell(row[0]!))![0]);
      }
    }
  });

  // A LIVE report page only: an archived page's SQL is most often a recipe or
  // test code rather than a question with an answer (measured 2026-10-01: 3 of
  // 10 archive hits were, against 0 of 4 under `plans/`).
  const live =
    page.relPath.startsWith("plans/") ||
    (page.plan_status !== undefined && LIVE_PLAN_STATUSES.includes(page.plan_status));
  if (live && looseSql >= LOOSE_SQL_MIN) {
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
  const lineCount = content.split("\n").length;
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

/** Build the per-run context: today, and whether the wiki carries its own
 *  plan-staleness check. */
export async function driftContext(root: string, nowMs: number): Promise<DriftContext> {
  let hasPlanStaleCheck = false;
  try {
    hasPlanStaleCheck = await Bun.file(path.join(root, "scripts", "plan-status-stale.ts")).exists();
  } catch {
    hasPlanStaleCheck = false;
  }
  return { today: todayOslo(nowMs), hasPlanStaleCheck };
}
