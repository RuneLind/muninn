/**
 * `<Chart kind="gap|steps|gate|funnel">` around a pipe table: the table read
 * per kind, the findings a kind raises on it, and the gate verdict. Used by the
 * wiki reader's view (`chart-view.ts`, `views: true` only) and by lint check 17
 * (`src/wiki/lint-chart.ts`); every other caller prints the table as written.
 *
 * Pure and dependency-light: `web-format.ts` ships in the chat bundle, so this
 * imports no server module.
 *
 * Cells arrive as the caller's VISIBLE text (`ChartTable.text`): the reader
 * parks wikilinks as sentinels before parsing and reads them back as their
 * link text, the lint replaces them the same way, so the two match header and
 * row names on one spelling.
 */

import { isEmptyCell, parseCellValue, tableDecimalComma, type NumberContext } from "./cell-number.ts";
import type { ChartKind } from "./component-spec.ts";
import { normalizeLabel } from "./delta-table.ts";
import type { Block } from "./markdown-ast.ts";

/** A table as the chart reads it: visible cell text. */
export interface ChartTable {
  headers: string[];
  rows: string[][];
}

/** A number read off a cell: its value and its digits as written. */
export interface CellNum {
  n: number;
  text: string;
}

/** `row` is the 0-based data row, absent for a finding about the block.
 *  `fatal` findings stop the chart: the reader shows the table instead. */
export interface ChartFinding {
  message: string;
  row?: number;
  fatal: boolean;
}

export interface GapRow {
  label: string;
  value: CellNum;
  target: CellNum;
  mark: CellNum | null;
  gap: CellNum | null;
  /** The gap cell as written, for the note beside the target. */
  gapText: string;
}

export interface GateRow {
  label: string;
  /** The leading integer of the first cell, the ledger join key. */
  pr: number | null;
  bar: CellNum;
  /** The bar cell after its leading number (`(D17)`), shown beside it. */
  barRest: string;
  barAfter: CellNum | null;
  barAfterRest: string;
  pass: CellNum;
  hold: CellNum | null;
}

export interface StepsSeries {
  name: string;
  /** One per step: the cell's number, or null for an empty cell. */
  values: (CellNum | null)[];
  /** The ref row's value for this series, when the chart has one. */
  ref: CellNum | null;
}

export interface FunnelRow {
  label: string;
  value: CellNum;
  of: CellNum | null;
  depth: number;
}

export type ChartModel =
  | { kind: "gap"; valueName: string; targetName: string; markName: string | null; rows: GapRow[] }
  | { kind: "gate"; barAfterName: string | null; passName: string; holdName: string | null; rows: GateRow[] }
  | {
      kind: "steps";
      steps: string[];
      series: StepsSeries[];
      refLabel: string | null;
      normalize: boolean;
      /** Rows after the ref row: one reference line per series value. */
      extras: { label: string; values: (CellNum | null)[] }[];
    }
  | { kind: "funnel"; ofName: string; rows: FunnelRow[] };

export interface ChartRead {
  model: ChartModel | null;
  findings: ChartFinding[];
  /** The table's number context (a decimal comma anywhere). */
  ctx: NumberContext;
}

const DASH_RE = /^[-–—]$/;

/** An empty cell, a NULL spelling or a lone dash. */
function blank(cell: string): boolean {
  return isEmptyCell(cell) || DASH_RE.test(cell.trim());
}

/**
 * A cell's leading number: the whole cell when it is a number (a unit and a
 * glued `%` allowed, `cell-number.ts`), else the number before the first
 * space or `(` — `+10 (D17)` reads +10, `21 — Hard` reads 21. Null when the
 * cell does not start with one.
 */
export function leadingNumber(cell: string, ctx: NumberContext = {}): (CellNum & { rest: string }) | null {
  const t = cell.trim();
  const whole = parseCellValue(t, ctx);
  if (whole) return { n: whole.n, text: t, rest: "" };
  const m = /^[+\-−]?(?:\d[\d.,   ]*\d|\d|[.,]\d+)%?(?=[\s(]|$)/u.exec(t);
  if (!m) return null;
  for (const cand of [m[0], /^\S+?(?=[\s(]|$)/.exec(m[0])?.[0] ?? ""]) {
    const v = cand ? parseCellValue(cand, ctx) : null;
    if (v) return { n: v.n, text: cand, rest: t.slice(cand.length).trim() };
  }
  return null;
}

/** The leading integer of a gate row's first cell: `PR 21`, `#21`, `21`,
 *  `21 — Hard congestion`. */
export function leadingPr(cell: string): number | null {
  const m = /^(?:PR\s*)?#?\s*(\d{1,7})(?!\d|[.,]\d)/i.exec(cell.trim());
  return m ? Number(m[1]) : null;
}

/** The column a `name=` attribute names, by its header text (`normalizeLabel`). */
export function findColumn(headers: readonly string[], name: string): number {
  const want = normalizeLabel(name);
  return want === "" ? -1 : headers.findIndex((h) => normalizeLabel(h) === want);
}

/** The gate verdict, reader-only: «numbers pass» when the pass value and the
 *  hold value (when there is one) both reach the bar; otherwise the first
 *  value that misses, against the bar, as written. */
export function gateVerdict(pass: CellNum, hold: CellNum | null, bar: CellNum): { pass: boolean; miss?: string } {
  for (const v of hold ? [pass, hold] : [pass]) {
    if (v.n < bar.n) return { pass: false, miss: `${v.text} < ${bar.text}` };
  }
  return { pass: true };
}

/** Every `<Chart>` block at any depth, in document order. */
export function chartBlocks(blocks: readonly Block[]): Extract<Block, { type: "component" }>[] {
  const out: Extract<Block, { type: "component" }>[] = [];
  const walk = (bs: readonly Block[]) => {
    for (const b of bs) {
      if (b.type !== "component") continue;
      if (b.name === "Chart") out.push(b);
      walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

/** The first pipe table directly in a `<Chart>` body, as `DeltaTable` reads its body. */
export function chartTableIndex(children: readonly Block[]): number {
  return children.findIndex((b) => b.type === "table");
}

const OF_HEADERS = new Set(["av", "of"]);
const BAR_AFTER_HEADERS = new Set(["bar after", "bar etter"]);

function quoteAttr(attr: string, value: string): string {
  return `${attr}="${value}"`;
}

/**
 * The table read for one kind. `kind` null (missing or unknown) gives no model
 * and no finding here: lint check 15 reports the attribute.
 */
export function readChart(kind: ChartKind | null, attrs: Readonly<Record<string, string>>, table: ChartTable | null): ChartRead {
  const findings: ChartFinding[] = [];
  if (!table) {
    return { model: null, findings: [{ message: "holds no pipe table", fatal: true }], ctx: {} };
  }
  const ctx = tableDecimalComma(table.rows.flat());
  if (kind === null) return { model: null, findings, ctx };
  const fatal = (message: string, row?: number) => findings.push({ message, fatal: true, ...(row !== undefined ? { row } : {}) });
  const warn = (message: string, row?: number) => findings.push({ message, fatal: false, ...(row !== undefined ? { row } : {}) });
  const label = (row: string[]) => row[0]?.trim() ?? "";
  const cell = (row: string[], i: number) => row[i] ?? "";

  /** Column index for a required (or optional) name attribute. */
  const column = (attr: string, required: boolean): number | null => {
    const raw = attrs[attr]?.trim();
    if (!raw) {
      if (required) fatal(`needs ${attr}= naming a column`);
      return null;
    }
    const i = findColumn(table.headers, raw);
    if (i < 0) fatal(`${quoteAttr(attr, raw)} names no column`);
    return i < 0 ? null : i;
  };
  /** A number cell in a value column; `optional` lets it be blank. */
  const num = (row: string[], i: number, r: number, optional: boolean): CellNum | null | undefined => {
    const c = cell(row, i);
    if (blank(c)) {
      if (!optional) fatal(`row "${label(row)}": the ${table.headers[i]} cell is empty`, r);
      return optional ? null : undefined;
    }
    const v = leadingNumber(c, ctx);
    if (!v) {
      fatal(`row "${label(row)}": "${c.trim()}" in ${table.headers[i]} is not a number`, r);
      return undefined;
    }
    return { n: v.n, text: v.text };
  };

  switch (kind) {
    case "gap": {
      const vi = column("value", true);
      const ti = column("target", true);
      const gi = column("gap", true);
      const mi = column("mark", false);
      if (vi === null || ti === null || gi === null || (attrs.mark?.trim() && mi === null)) return { model: null, findings, ctx };
      const rows: GapRow[] = [];
      table.rows.forEach((row, r) => {
        const value = num(row, vi, r, false);
        const target = num(row, ti, r, false);
        const mark = mi === null ? null : num(row, mi, r, true);
        const gap = num(row, gi, r, true);
        if (!value || !target || mark === undefined || gap === undefined) return;
        if (gap) {
          const want = Math.abs(target.n - value.n);
          const decimals = /[.,](\d+)/.exec(gap.text)?.[1]?.length ?? 0;
          if (Math.abs(Math.abs(gap.n) - want) > 0.5 * 10 ** -decimals + 1e-9) {
            warn(`row "${label(row)}": the gap cell says ${gap.text}, but ${table.headers[ti]} − ${table.headers[vi]} is ${round(target.n - value.n, Math.max(decimals, 2))}`, r);
          }
        }
        rows.push({ label: label(row), value, target, mark, gap, gapText: blank(cell(row, gi)) ? "" : cell(row, gi).trim() });
      });
      if (findings.some((f) => f.fatal)) return { model: null, findings, ctx };
      return {
        model: { kind, valueName: table.headers[vi]!, targetName: table.headers[ti]!, markName: mi === null ? null : table.headers[mi]!, rows },
        findings,
        ctx,
      };
    }
    case "gate": {
      const bi = column("bar", true);
      const pi = column("pass", true);
      const hi = column("hold", true);
      if (bi === null || pi === null || hi === null) return { model: null, findings, ctx };
      const ai = table.headers.findIndex((h) => BAR_AFTER_HEADERS.has(normalizeLabel(h)));
      const rows: GateRow[] = [];
      table.rows.forEach((row, r) => {
        const barCell = leadingNumber(cell(row, bi), ctx);
        if (!barCell) fatal(`row "${label(row)}": "${cell(row, bi).trim()}" in ${table.headers[bi]} does not start with a number`, r);
        const afterCell = ai < 0 || blank(cell(row, ai)) ? null : leadingNumber(cell(row, ai), ctx);
        if (ai >= 0 && !blank(cell(row, ai)) && !afterCell) {
          fatal(`row "${label(row)}": "${cell(row, ai).trim()}" in ${table.headers[ai]} does not start with a number`, r);
        }
        const pass = num(row, pi, r, false);
        const hold = num(row, hi, r, true);
        if (!barCell || !pass || hold === undefined) return;
        rows.push({
          label: label(row),
          pr: leadingPr(label(row)),
          bar: { n: barCell.n, text: barCell.text },
          barRest: barCell.rest,
          barAfter: afterCell ? { n: afterCell.n, text: afterCell.text } : null,
          barAfterRest: afterCell?.rest ?? "",
          pass,
          hold,
        });
      });
      if (findings.some((f) => f.fatal)) return { model: null, findings, ctx };
      return {
        model: {
          kind,
          barAfterName: ai >= 0 && rows.some((r) => r.barAfter) ? table.headers[ai]! : null,
          passName: table.headers[pi]!,
          holdName: table.headers[hi]!,
          rows,
        },
        findings,
        ctx,
      };
    }
    case "steps": {
      const xi = column("x", true);
      if (xi === null) return { model: null, findings, ctx };
      const normalize = (attrs.normalize?.trim().toLowerCase() ?? "") === "ref";
      const refName = attrs.ref?.trim() ?? "";
      if (normalize && !refName) fatal('normalize="ref" needs ref= naming a row');
      const refRow = refName ? table.rows.findIndex((row) => normalizeLabel(cell(row, xi)) === normalizeLabel(refName)) : -1;
      if (refName && refRow < 0) fatal(`${quoteAttr("ref", refName)} names no row in ${table.headers[xi]}`);
      if (findings.some((f) => f.fatal)) return { model: null, findings, ctx };
      const stepRows = refRow < 0 ? table.rows : table.rows.slice(0, refRow);
      const extraRows = refRow < 0 ? [] : table.rows.slice(refRow + 1);
      const cols = table.headers.map((_, i) => i).filter((i) => i !== xi);
      const read = (row: string[], i: number, r: number) => num(row, i, r, true) ?? null;
      const series: StepsSeries[] = cols.map((i) => ({
        name: table.headers[i]!,
        values: stepRows.map((row, r) => read(row, i, r)),
        ref: refRow < 0 ? null : read(table.rows[refRow]!, i, refRow),
      }));
      const extras = extraRows.map((row, k) => ({ label: cell(row, xi).trim(), values: cols.map((i) => read(row, i, refRow + 1 + k)) }));
      if (normalize) {
        for (const s of series) if (!s.ref || s.ref.n === 0) fatal(`${s.name} has no non-zero value in the ${refName} row to measure against`, refRow);
      }
      if (stepRows.length === 0) fatal(`has no step rows before the ${refName} row`);
      if (findings.some((f) => f.fatal)) return { model: null, findings, ctx };
      return {
        model: {
          kind,
          steps: stepRows.map((row) => cell(row, xi).trim()),
          series,
          refLabel: refRow < 0 ? null : cell(table.rows[refRow]!, xi).trim(),
          normalize,
          extras,
        },
        findings,
        ctx,
      };
    }
    case "funnel": {
      const oi = table.headers.findIndex((h) => OF_HEADERS.has(normalizeLabel(h)));
      if (oi < 0) fatal("has no «Av» or «Of» column naming each row's parent count");
      const vi = attrs.value?.trim() ? column("value", true) : table.headers.findIndex((_, i) => i > 0 && i !== oi);
      if (vi === null || vi < 0 || oi < 0) {
        if (vi !== null && vi < 0) fatal("has no count column");
        return { model: null, findings, ctx };
      }
      const rows: FunnelRow[] = [];
      table.rows.forEach((row, r) => {
        const value = num(row, vi, r, false);
        const of = num(row, oi, r, true);
        if (!value || of === undefined) return;
        if (of && value.n > of.n) fatal(`row "${label(row)}": ${value.text} is larger than its parent ${of.text}`, r);
        // Depth: one under the nearest earlier row whose count is this parent.
        let depth = 0;
        if (of) {
          let parent: FunnelRow | undefined;
          for (let k = rows.length - 1; k >= 0; k--) {
            if (rows[k]!.value.n === of.n) {
              parent = rows[k];
              break;
            }
          }
          depth = parent ? parent.depth + 1 : 1;
        }
        rows.push({ label: label(row), value, of, depth });
      });
      if (findings.some((f) => f.fatal)) return { model: null, findings, ctx };
      return { model: { kind, ofName: table.headers[oi]!, rows }, findings, ctx };
    }
  }
}

function round(n: number, decimals: number): string {
  const s = n.toFixed(decimals).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}
