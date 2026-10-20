/**
 * `<Chart kind="gap|steps|gate|funnel">` around a pipe table: the table read
 * per kind, the findings a kind raises on it, and the gate verdict. The wiki
 * reader's view (`chart-view.ts`, `views: true` only) and lint check 17
 * (`src/wiki/lint-chart.ts`) both read a chart through `chartBody`,
 * `chartTable` and `readChart`, so they cannot disagree; every other surface
 * prints the table as written.
 *
 * Pure: `web-format.ts` ships in the chat bundle, so this imports no server
 * module.
 */

import { isEmptyCell, parseCellValue, tableDecimalComma, type NumberContext } from "./cell-number.ts";
import { readChartNormalize, type ChartKind } from "./component-spec.ts";
import { headerKey } from "./delta-table.ts";
import type { Block } from "./markdown-ast.ts";
import { gateRowPr, type GatePr, type LedgerRow } from "./pr-ledger.ts";
import type { QuestionLanguage } from "./question-labels.ts";

type TableBlock = Extract<Block, { type: "table" }>;

/** A `<Chart>` body split around its first pipe table, so the blocks after
 *  the table render after the chart and source order holds. */
interface ChartBody {
  before: Block[];
  table: TableBlock | null;
  after: Block[];
}

export function chartBody(children: readonly Block[]): ChartBody {
  const k = children.findIndex((b) => b.type === "table");
  if (k < 0) return { before: [...children], table: null, after: [] };
  return { before: children.slice(0, k), table: children[k] as TableBlock, after: children.slice(k + 1) };
}

/** A table as the chart reads it: every cell's visible text with struck
 *  (`~~…~~`) text removed, and each row's first cell raw for the PR match. */
interface ChartTable {
  headers: string[];
  rows: string[][];
  rawFirst: string[];
}

/** `cellText` turns a raw cell into its visible text: the reader resolves its
 *  wikilink sentinels first, the lint reads the source; both strip markup the
 *  same way (`visibleText`). */
export function chartTable(table: TableBlock, cellText: (raw: string) => string): ChartTable {
  const read = (raw: string) => cellText(raw.replace(/~~[\s\S]*?~~/g, "")).trim();
  return {
    headers: table.headers.map(read),
    rows: table.rows.map((row) => table.headers.map((_, i) => read(row[i] ?? ""))),
    rawFirst: table.rows.map((row) => row[0] ?? ""),
  };
}

/** A value cell read: the number as written (`text`, a unit included), its
 *  decimals and unit, an optional `± n` (not plotted) and the ids in a
 *  trailing `(D7, D9)`. */
export interface ChartValue {
  n: number;
  text: string;
  decimals: number;
  unit: string;
  pm: string | null;
  ids: string[];
}

/** `(D7)` or `(D7, S2)`: one to four capitals and up to four digits each. */
const VALUE_CELL_RE = /^(.*?)(?:\s*±\s*([^\s()±]+))?(?:\s*\(\s*([A-Z]{1,4}\d{1,4}(?:\s*,\s*[A-Z]{1,4}\d{1,4})*)\s*\))?$/u;

/** A value cell's number part, without its `± n` and `(ids)`. */
function splitValueCell(cell: string): { num: string; pm: string | null; ids: string[] } {
  const m = VALUE_CELL_RE.exec(cell.trim())!;
  return { num: m[1]!.trim(), pm: m[2] ?? null, ids: m[3] ? m[3].split(",").map((s) => s.trim()) : [] };
}

/** A value cell as a number, or null when it is not one. */
export function readValueCell(cell: string, ctx: NumberContext): ChartValue | null {
  const { num, pm, ids } = splitValueCell(cell);
  const v = parseCellValue(num, ctx);
  if (!v) return null;
  if (pm !== null && !parseCellValue(pm, ctx)) return null;
  return { n: v.n, text: num, decimals: v.decimals, unit: v.unit, pm, ids };
}

/** An empty cell, a NULL spelling or a lone dash: no value. */
function isBlankValue(cell: string): boolean {
  return isEmptyCell(cell) || /^[-–—]$/.test(cell.trim());
}

/** `row` is the 0-based data row. A `fatal` finding stops the chart and the
 *  reader shows the table; the others are notes beside a drawn chart. */
interface ChartFinding {
  message: string;
  row?: number;
  fatal: boolean;
}

interface GapRow {
  label: string;
  value: ChartValue;
  target: ChartValue;
  mark: ChartValue | null;
  /** The gap cell as written, shown beside the target; "" when empty. */
  gapText: string;
}

export interface GateRow {
  label: string;
  /** The slate and PR link the first cell names (`gateRowPr`), the ledger join key. */
  pr: GatePr | null;
  bar: ChartValue;
  barAfter: ChartValue | null;
  pass: ChartValue;
  hold: ChartValue | null;
}

interface StepsSeries {
  name: string;
  /** Per step: the plotted number (an empty cell carries the last one
   *  forward), null before the first value. */
  points: (number | null)[];
  /** The ref row's value, when the chart has a ref row. */
  ref: number | null;
}

interface FunnelRow {
  label: string;
  value: ChartValue;
  /** The parent row's count, null for a root row. */
  of: ChartValue | null;
  depth: number;
  /** value / parent in percent; null for a root row or a parent of 0. */
  share: number | null;
}

export type ChartModel =
  | { kind: "gap"; valueName: string; targetName: string; markName: string | null; rows: GapRow[] }
  | { kind: "gate"; passName: string; holdName: string; barAfter: boolean; rows: GateRow[] }
  | { kind: "steps"; steps: string[]; series: StepsSeries[]; refLabel: string | null; normalize: boolean; decimals: number }
  | { kind: "funnel"; rows: FunnelRow[] };

export interface ChartRead {
  model: ChartModel | null;
  findings: ChartFinding[];
  /** The table's number context: a decimal comma anywhere in it. */
  ctx: NumberContext;
}

/** The `Of` column of a funnel, by header. */
export const FUNNEL_OF_HEADERS: ReadonlySet<string> = new Set(["av", "of"]);
/** The gate's optional later-bar column, by header; `chart-view.ts` labels
 *  its toggle with the same words. */
export const GATE_BAR_AFTER_HEADERS: ReadonlySet<string> = new Set(["bar after", "krav etter"]);

/** A number for a message or a label: U+2212 for a minus, never `−0`, a
 *  decimal comma when `comma`, at most `decimals` decimals, trailing zeros cut. */
export function formatChartNumber(n: number, decimals: number, comma: boolean): string {
  let s = n.toFixed(Math.max(0, Math.min(decimals, 10)));
  if (s.includes(".")) s = s.replace(/\.?0+$/, "");
  if (/^-0(?:\.0*)?$/.test(s)) s = "0";
  if (s.startsWith("-")) s = `−${s.slice(1)}`;
  return comma ? s.replace(".", ",") : s;
}

/** A share in percent: one decimal under 10, none from 10. */
export function formatChartPercent(n: number, comma: boolean): string {
  return `${formatChartNumber(n, Math.abs(n) < 10 ? 1 : 0, comma)}%`;
}

/** The gate verdict, numeric only: both the pass and the hold value reach
 *  the bar (≥). An unmeasured hold is a miss. Used by the reader view only. */
type GateVerdict =
  | { pass: true }
  | { pass: false; reason: "below"; value: string; bar: string }
  | { pass: false; reason: "hold-not-measured" };

export function chartGateVerdict(pass: ChartValue, hold: ChartValue | null, bar: ChartValue): GateVerdict {
  if (pass.n < bar.n) return { pass: false, reason: "below", value: pass.text, bar: bar.text };
  if (!hold) return { pass: false, reason: "hold-not-measured" };
  if (hold.n < bar.n) return { pass: false, reason: "below", value: hold.text, bar: bar.text };
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

/** The table read for one kind. `kind` null (missing or unknown) gives no
 *  model and no finding here: lint check 15 reports the attribute. */
export function readChart(kind: ChartKind | null, attrs: Readonly<Record<string, string>>, table: ChartTable | null): ChartRead {
  if (!table) return { model: null, findings: [{ message: "holds no pipe table", fatal: true }], ctx: {} };
  const ctx = tableDecimalComma(table.rows.flat().map((c) => splitValueCell(c).num));
  if (kind === null) return { model: null, findings: [], ctx };
  const r = new Reader(table, attrs, ctx);
  const model = r.read(kind);
  return { model: r.findings.some((f) => f.fatal) ? null : model, findings: r.findings, ctx };
}

class Reader {
  readonly findings: ChartFinding[] = [];
  private readonly keys: string[];

  constructor(
    private readonly t: ChartTable,
    private readonly attrs: Readonly<Record<string, string>>,
    private readonly ctx: NumberContext,
  ) {
    this.keys = t.headers.map(headerKey);
  }

  private fatal(message: string, row?: number): void {
    this.findings.push({ message, fatal: true, ...(row === undefined ? {} : { row }) });
  }

  private note(message: string, row: number): void {
    this.findings.push({ message, fatal: false, row });
  }

  private cell(r: number, i: number): string {
    return this.t.rows[r]![i] ?? "";
  }

  /** The column an attribute names; null (and a finding when `required`)
   *  when it is absent, names nothing, or names a header written twice. */
  private column(attr: string, required: boolean): number | null {
    const raw = this.attrs[attr]?.trim() ?? "";
    if (!raw) {
      if (required) this.fatal(`needs ${attr}= naming a column`);
      return null;
    }
    const want = headerKey(raw);
    const hits = this.keys.flatMap((k, i) => (k === want ? [i] : []));
    if (hits.length === 1) return hits[0]!;
    this.fatal(hits.length ? `${attr}="${raw}" names a header written ${hits.length} times` : `${attr}="${raw}" names no column`);
    return null;
  }

  /** The first column whose header is one of `names`; a finding when two are. */
  private namedColumn(names: ReadonlySet<string>): number {
    const hits = this.keys.flatMap((k, i) => (names.has(k) ? [i] : []));
    if (hits.length > 1) this.fatal(`has ${hits.length} «${this.t.headers[hits[0]!]}» columns`);
    return hits[0] ?? -1;
  }

  /** A value cell; `optional` lets it be blank (null). Undefined after a finding. */
  private value(r: number, i: number, label: string, optional: boolean): ChartValue | null | undefined {
    const c = this.cell(r, i);
    if (isBlankValue(c)) {
      if (optional) return null;
      this.fatal(`row "${label}": the ${this.t.headers[i]} cell is empty`, r);
      return undefined;
    }
    const v = readValueCell(c, this.ctx);
    if (!v) this.fatal(`row "${label}": "${c}" in ${this.t.headers[i]} is not a number`, r);
    return v ?? undefined;
  }

  read(kind: ChartKind): ChartModel | null {
    if (this.t.rows.length === 0) {
      this.fatal(kind === "steps" ? "has no step rows" : "has no data rows");
      return null;
    }
    switch (kind) {
      case "gap":
        return this.gap();
      case "gate":
        return this.gate();
      case "steps":
        return this.steps();
      case "funnel":
        return this.funnel();
    }
  }

  private gap(): ChartModel | null {
    const vi = this.column("value", true);
    const ti = this.column("target", true);
    const gi = this.column("gap", true);
    const mi = this.column("mark", false);
    if (vi === null || ti === null || gi === null || (this.attrs.mark?.trim() && mi === null)) return null;
    const rows: GapRow[] = [];
    this.t.rows.forEach((row, r) => {
      const label = row[0] ?? "";
      const value = this.value(r, vi, label, false);
      const target = this.value(r, ti, label, false);
      const mark = mi === null ? null : this.value(r, mi, label, true);
      const gap = this.value(r, gi, label, true);
      if (!value || !target || mark === undefined || gap === undefined) return;
      if (gap) {
        // A signed gap cell is compared signed, an unsigned one by size; the
        // tolerance is half a unit of the gap cell's last decimal.
        const signed = /^[+\-−]/.test(gap.text);
        const want = target.n - value.n;
        const diff = signed ? gap.n - want : Math.abs(gap.n) - Math.abs(want);
        if (Math.abs(diff) > 0.5 * 10 ** -gap.decimals + 1e-9) {
          const decimals = Math.max(gap.decimals, value.decimals, target.decimals);
          const shown = formatChartNumber(signed ? want : Math.abs(want), decimals, !!this.ctx.decimalComma);
          this.note(`row "${label}": the gap cell says ${gap.text}, but ${this.t.headers[ti]} − ${this.t.headers[vi]} is ${shown}`, r);
        }
      }
      rows.push({ label, value, target, mark, gapText: gap ? this.cell(r, gi) : "" });
    });
    const h = this.t.headers;
    return { kind: "gap", valueName: h[vi]!, targetName: h[ti]!, markName: mi === null ? null : h[mi]!, rows };
  }

  private gate(): ChartModel | null {
    const bi = this.column("bar", true);
    const pi = this.column("pass", true);
    const hi = this.column("hold", true);
    const ai = this.namedColumn(GATE_BAR_AFTER_HEADERS);
    if (bi === null || pi === null || hi === null) return null;
    const rows: GateRow[] = [];
    this.t.rows.forEach((row, r) => {
      const label = row[0] ?? "";
      const bar = this.value(r, bi, label, false);
      const barAfter = ai < 0 ? null : this.value(r, ai, label, true);
      const pass = this.value(r, pi, label, false);
      const hold = this.value(r, hi, label, true);
      if (!bar || !pass || barAfter === undefined || hold === undefined) return;
      const units = [bar, barAfter, pass, hold].filter((v): v is ChartValue => v !== null);
      if (units.some((v) => v.unit !== bar.unit)) {
        const odd = units.find((v) => v.unit !== bar.unit)!;
        this.fatal(`row "${label}": ${bar.text} and ${odd.text} are not in the same unit`, r);
        return;
      }
      rows.push({ label, pr: gateRowPr(this.t.rawFirst[r] ?? ""), bar, barAfter, pass, hold });
    });
    return { kind: "gate", passName: this.t.headers[pi]!, holdName: this.t.headers[hi]!, barAfter: rows.some((r) => r.barAfter), rows };
  }

  private steps(): ChartModel | null {
    const xi = this.column("x", true);
    const normalize = readChartNormalize(this.attrs.normalize).value === "ref";
    const refName = this.attrs.ref?.trim() ?? "";
    if (normalize && !refName) this.fatal('normalize="ref" needs ref= naming a row');
    if (xi === null) return null;
    const cols = this.t.headers.map((_, i) => i).filter((i) => i !== xi);
    if (!cols.length) {
      this.fatal("has no series columns");
      return null;
    }
    const labels = this.t.rows.map((row) => row[xi] ?? "");
    let refRow = -1;
    if (refName) {
      const hits = labels.flatMap((l, r) => (headerKey(l) === headerKey(refName) ? [r] : []));
      if (hits.length !== 1) {
        this.fatal(hits.length ? `ref="${refName}" names ${hits.length} rows` : `ref="${refName}" names no row in ${this.t.headers[xi]}`);
        return null;
      }
      refRow = hits[0]!;
    }
    // A ref row that opens the table is the first step (the baseline); any
    // other ref row is the reference only. Each cell is read once.
    const stepRows = this.t.rows.map((_, r) => r).filter((r) => r !== refRow || refRow === 0);
    const read = new Map<string, ChartValue | null | undefined>();
    const at = (r: number, i: number) => {
      const key = `${r}:${i}`;
      if (!read.has(key)) read.set(key, this.value(r, i, labels[r]!, true));
      return read.get(key);
    };
    let decimals = 0;
    const series: StepsSeries[] = cols.map((i) => {
      let last: number | null = null;
      const points = stepRows.map((r) => {
        const v = at(r, i);
        if (v) {
          last = v.n;
          decimals = Math.max(decimals, v.decimals);
        }
        return last;
      });
      const ref = refRow < 0 ? null : (at(refRow, i)?.n ?? null);
      return { name: this.t.headers[i]!, points, ref };
    });
    if (this.findings.some((f) => f.fatal)) return null;
    for (const s of series) {
      if (s.points.every((p) => p === null)) this.fatal(`${s.name} has no values`);
      else if (normalize && !s.ref) this.fatal(`${s.name} has no non-zero value in the ${labels[refRow]} row to measure against`, refRow);
    }
    if (normalize) {
      for (const s of series) s.points = s.points.map((p) => (p === null || !s.ref ? p : (p / s.ref) * 100));
    }
    return {
      kind: "steps",
      steps: stepRows.map((r) => labels[r]!),
      series,
      refLabel: refRow < 0 ? null : labels[refRow]!,
      normalize,
      decimals,
    };
  }

  private funnel(): ChartModel | null {
    const oi = this.namedColumn(FUNNEL_OF_HEADERS);
    if (oi < 0) {
      this.fatal("has no «Av» or «Of» column naming each row's parent count");
      return null;
    }
    // With no value=, the count is the first column after the label that is
    // not the Of column.
    const vi = this.attrs.value?.trim() ? this.column("value", true) : this.t.headers.findIndex((_, i) => i > 0 && i !== oi);
    if (vi === null) return null;
    if (vi < 0) {
      this.fatal("has no count column");
      return null;
    }
    const rows: FunnelRow[] = [];
    this.t.rows.forEach((row, r) => {
      const label = row[0] ?? "";
      const value = this.value(r, vi, label, false);
      const of = this.value(r, oi, label, true);
      if (!value || of === undefined) return;
      if (value.n < 0 || (of && of.n < 0)) {
        this.fatal(`row "${label}": a count is negative`, r);
        return;
      }
      let parent: FunnelRow | undefined;
      if (of) {
        for (let k = rows.length - 1; k >= 0 && !parent; k--) if (rows[k]!.value.n === of.n) parent = rows[k];
        if (!parent) {
          this.fatal(`row "${label}": ${this.t.headers[oi]} ${of.text} matches no earlier row's count`, r);
          return;
        }
        if (value.n > of.n) this.fatal(`row "${label}": ${value.text} is larger than its parent ${of.text}`, r);
      }
      const share = of && of.n > 0 ? (value.n / of.n) * 100 : null;
      rows.push({ label, value, of, depth: parent ? parent.depth + 1 : 0, share });
    });
    return { kind: "funnel", rows };
  }
}

/** What the reader's view draws from. `formatWebHtml` builds it and calls the
 *  renderer `renderWikiHtml` passes as `chartView`, so the view's module stays
 *  out of the chat bundle. */
export interface ChartViewInput {
  /** No model: the table failed its kind, and the view shows it with the findings. */
  read: ChartRead;
  caption: string;
  /** The caption's visible text (wikilinks as their link text), the section's
   *  accessible name; the same text lint names. */
  captionText: string;
  /** The table, the blocks before it and the blocks after it, rendered. */
  tableHtml: string;
  beforeHtml: string;
  afterHtml: string;
  language: QuestionLanguage;
  /** The page's ledger rows (`firstRowPerPr`), for a gate row's pill; null without a ledger. */
  ledgerRows: readonly LedgerRow[] | null;
  /** The ids the page's DecisionLog has items for: a value cell links only these. */
  logIds: ReadonlySet<string>;
}

export type ChartViewRenderer = (input: ChartViewInput) => string;
